from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.agents.candidate_scorer import CandidateScorer, CandidateScorerRequest
from app.agents.outreach_drafter import OutreachDrafter, OutreachDrafterRequest
from app.dependencies import get_db
from app.infra.db import (
    EvalResultDB,
    HumanReview,
    JobDescription,
    OutreachEmailDB,
    Run,
    ScoredCandidateDB,
    async_session_maker,
)
from app.infra.vector_store import vector_store
from app.schemas.candidate import ScoredCandidate
from app.schemas.jd import ExtractedJD

router = APIRouter(prefix="/review", tags=["review"])


class EvalResultOut(BaseModel):
    id: str
    run_id: str
    agent: str
    task_id: str
    relevance: float
    faithfulness: float
    completeness: float
    needs_review: bool
    review_reason: str | None
    context_data: list | None = None


class ReviewDecision(BaseModel):
    decision: str
    notes: str | None = None
    reviewer: str = "human"


async def screen_candidates_for_run(run_id: str) -> None:
    """Run candidate scoring only after the recruiter approves the extracted JD."""
    async with async_session_maker() as db:
        run = await db.get(Run, run_id)
        jd_result = await db.execute(select(JobDescription).where(JobDescription.run_id == run_id))
        jd_record = jd_result.scalars().first()
        if not run or not jd_record:
            return

        try:
            jd = ExtractedJD(**jd_record.extracted_json)
            scoring = await CandidateScorer().run(CandidateScorerRequest(jd=jd, top_k=5))

            for candidate in scoring.scored_candidates:
                db.add(ScoredCandidateDB(
                    run_id=run_id,
                    candidate_id=candidate.candidate_id,
                    semantic_similarity=candidate.semantic_similarity,
                    llm_rerank_score=candidate.llm_rerank_score,
                    final_score=candidate.final_score,
                    matched_skills_json=candidate.matched_skills,
                    missing_skills_json=candidate.missing_skills,
                    rationale_json=candidate.rationale,
                ))
                # This is a recruiter decision item, not an aggregate RAG/G-Eval score.
                db.add(EvalResultDB(
                    run_id=run_id,
                    agent="CandidateReview",
                    task_id=candidate.candidate_id,
                    relevance=candidate.final_score,
                    faithfulness=1.0,
                    completeness=1.0,
                    needs_review=True,
                    review_reason="Recruiter decision required before outreach is drafted.",
                ))

            run.status = "needs_candidate_review" if scoring.scored_candidates else "completed"
            run.completed_at = datetime.now(timezone.utc) if not scoring.scored_candidates else None
            await db.commit()
        except Exception:
            run.status = "failed"
            run.completed_at = datetime.now(timezone.utc)
            await db.commit()
            raise


async def draft_outreach_for_approved_candidates(run_id: str) -> None:
    """Draft outreach only after every shortlisted candidate has a recruiter decision."""
    async with async_session_maker() as db:
        run = await db.get(Run, run_id)
        jd_result = await db.execute(select(JobDescription).where(JobDescription.run_id == run_id))
        jd_record = jd_result.scalars().first()
        review_result = await db.execute(select(EvalResultDB).where(
            EvalResultDB.run_id == run_id,
            EvalResultDB.agent == "CandidateReview",
        ))
        candidate_reviews = review_result.scalars().all()
        review_ids = [review.id for review in candidate_reviews]
        decisions_result = await db.execute(select(HumanReview).where(HumanReview.eval_result_id.in_(review_ids)))
        decisions = decisions_result.scalars().all()
        approved_ids = {
            review.task_id
            for review in candidate_reviews
            for decision in decisions
            if decision.eval_result_id == review.id and decision.decision == "approved"
        }

        if not run or not jd_record:
            return
        if not approved_ids:
            run.status = "completed"
            run.completed_at = datetime.now(timezone.utc)
            await db.commit()
            return

        score_result = await db.execute(select(ScoredCandidateDB).where(
            ScoredCandidateDB.run_id == run_id,
            ScoredCandidateDB.candidate_id.in_(approved_ids),
        ))
        candidates = [ScoredCandidate(
            candidate_id=row.candidate_id,
            semantic_similarity=row.semantic_similarity,
            llm_rerank_score=row.llm_rerank_score,
            final_score=row.final_score,
            matched_skills=row.matched_skills_json,
            missing_skills=row.missing_skills_json,
            rationale=row.rationale_json,
        ) for row in score_result.scalars().all()]

        drafts = await OutreachDrafter().run(OutreachDrafterRequest(
            jd=ExtractedJD(**jd_record.extracted_json),
            scored_candidates=candidates,
        ))
        for email in drafts.emails:
            db.add(OutreachEmailDB(
                run_id=run_id,
                candidate_id=email.candidate_id,
                subject=email.subject,
                body=email.body,
                status="pending_review",
            ))
        run.status = "outreach_ready"
        run.completed_at = datetime.now(timezone.utc)
        await db.commit()


def _jd_context(run_id: str, db: AsyncSession):
    return select(JobDescription).where(JobDescription.run_id == run_id)


@router.get("/queue", response_model=List[EvalResultOut])
async def get_review_queue(db: AsyncSession = Depends(get_db)):
    """Return review cards with decision-ready source evidence, not aggregate chunks."""
    result = await db.execute(select(EvalResultDB).where(EvalResultDB.needs_review == True))
    evaluations = result.scalars().all()
    out: list[EvalResultOut] = []

    for evaluation in evaluations:
        reviewed = await db.execute(select(HumanReview).where(HumanReview.eval_result_id == evaluation.id))
        if reviewed.scalars().first():
            continue

        context_data: list[dict] = []
        if evaluation.agent == "JDAnalyser":
            jd_result = await db.execute(_jd_context(evaluation.run_id, db))
            jd = jd_result.scalars().first()
            if jd:
                context_data.append({
                    "raw_job_description": jd.raw_text,
                    "extracted_job_description": jd.extracted_json,
                })
        elif evaluation.agent == "CandidateReview":
            score_result = await db.execute(select(ScoredCandidateDB).where(
                ScoredCandidateDB.run_id == evaluation.run_id,
                ScoredCandidateDB.candidate_id == evaluation.task_id,
            ))
            score = score_result.scalars().first()
            profile = vector_store.get_candidate(evaluation.task_id)
            if score:
                context_data.append({
                    "candidate_id": score.candidate_id,
                    "name": (profile or {}).get("metadata", {}).get("name", "Candidate"),
                    "email": (profile or {}).get("metadata", {}).get("email", ""),
                    "resume_profile": (profile or {}).get("document", "Resume data is unavailable."),
                    "final_score": score.final_score,
                    "semantic_similarity": score.semantic_similarity,
                    "llm_rerank_score": score.llm_rerank_score,
                    "matched_skills": score.matched_skills_json,
                    "missing_skills": score.missing_skills_json,
                    "rationale": score.rationale_json,
                })
        elif evaluation.agent == "OutreachDrafter":
            emails = await db.execute(select(OutreachEmailDB).where(OutreachEmailDB.run_id == evaluation.run_id))
            context_data = [{"candidate_id": email.candidate_id, "subject": email.subject, "body": email.body}
                            for email in emails.scalars().all()]

        out.append(EvalResultOut(
            id=evaluation.id,
            run_id=evaluation.run_id,
            agent=evaluation.agent,
            task_id=evaluation.task_id,
            relevance=evaluation.relevance,
            faithfulness=evaluation.faithfulness,
            completeness=evaluation.completeness,
            needs_review=evaluation.needs_review,
            review_reason=evaluation.review_reason,
            context_data=context_data,
        ))
    return out


@router.post("/{eval_id}/submit")
async def submit_review(
    eval_id: str,
    decision: ReviewDecision,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Persist a reviewer decision and advance only the permitted next stage."""
    if decision.decision not in {"approved", "rejected"}:
        raise HTTPException(status_code=400, detail="Decision must be approved or rejected")

    evaluation = await db.get(EvalResultDB, eval_id)
    if not evaluation:
        raise HTTPException(status_code=404, detail="Eval result not found")

    db.add(HumanReview(
        eval_result_id=eval_id,
        reviewer=decision.reviewer,
        decision=decision.decision,
        notes=decision.notes,
        reviewed_at=datetime.now(timezone.utc),
    ))
    await db.commit()

    if evaluation.agent == "JDAnalyser":
        run = await db.get(Run, evaluation.run_id)
        if decision.decision == "rejected":
            run.status = "jd_rejected"
            run.completed_at = datetime.now(timezone.utc)
            await db.commit()
        else:
            run.status = "screening_candidates"
            await db.commit()
            background_tasks.add_task(screen_candidates_for_run, evaluation.run_id)

    elif evaluation.agent == "CandidateReview":
        candidate_evals = await db.execute(select(EvalResultDB).where(
            EvalResultDB.run_id == evaluation.run_id,
            EvalResultDB.agent == "CandidateReview",
        ))
        all_candidate_evals = candidate_evals.scalars().all()
        ids = [item.id for item in all_candidate_evals]
        submitted = await db.execute(select(HumanReview).where(HumanReview.eval_result_id.in_(ids)))
        if len(submitted.scalars().all()) == len(all_candidate_evals):
            run = await db.get(Run, evaluation.run_id)
            run.status = "drafting_outreach"
            await db.commit()
            background_tasks.add_task(draft_outreach_for_approved_candidates, evaluation.run_id)

    return {"status": "success", "message": "Review submitted successfully."}
