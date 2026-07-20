"""
Planner Agent — builds the standard hiring pipeline TaskGraph and dispatches execution.

Currently uses a deterministic task graph (extract_jd → score_candidates → draft_outreach).
This is a deliberate choice: the pipeline steps are well-defined and don't benefit from
LLM-driven decomposition. The TaskGraph architecture supports future extension to dynamic
planning (conditional tasks, re-planning on failure) if needed.

The Planner never talks to MCP servers directly; it only knows task graphs and agent contracts.
"""
import logging
from pydantic import BaseModel, Field

from app.agents.base import BaseAgent, with_retry
from app.orchestration.task_graph import TaskGraph, Task
from app.orchestration.state_machine import PipelineStateMachine

logger = logging.getLogger(__name__)


class PlannerRequest(BaseModel):
    run_id: str
    goal_text: str
    raw_jd_text: str
    top_k: int = 5
    strictness: float = 0.8
    auto_approve: bool = False


class PlannerResponse(BaseModel):
    run_id: str
    status: str
    context: dict
    eval_results: list = Field(default_factory=list)
    graph_summary: dict = Field(default_factory=dict)


class PlannerAgent(BaseAgent):
    """
    Supervisor agent that:
    1. Decomposes a hiring goal into an ordered task graph.
    2. Dispatches the graph to the state machine for execution.
    """

    def __init__(self):
        super().__init__(name="PlannerAgent")

    def _build_task_graph(self, request: PlannerRequest) -> TaskGraph:
        """
        Build the standard hiring pipeline task graph:
          extract_jd → score_candidates → draft_outreach
        """
        graph = TaskGraph(run_id=request.run_id)

        # JD approval is a hard gate. Candidate screening and outreach are
        # resumed explicitly from the review workflow after approval.
        graph.tasks = [
            Task(
                name="extract_jd",
                agent="JDAnalyser",
                depends_on=[],
            ),
        ]

        return graph

    @with_retry(max_retries=2, base_delay=1.0)
    async def _execute(self, request: PlannerRequest) -> PlannerResponse:
        logger.info(f"{self.name} building task graph for goal: {request.goal_text[:80]}...")

        # 1. Build the task graph
        task_graph = self._build_task_graph(request)
        logger.info(f"Task graph built: {task_graph.summary()}")

        # 2. Create state machine and seed context
        sm = PipelineStateMachine(task_graph)
        # Seed the shared context with initial data
        sm.context = {
            "goal_text": request.goal_text,
            "raw_jd_text": request.raw_jd_text,
            "top_k": request.top_k,
            "strictness": request.strictness,
            "auto_approve": request.auto_approve,
        }
        # 3. Run the pipeline
        result = await sm.run()

        return PlannerResponse(
            run_id=task_graph.run_id,
            status=result.get("status", "unknown"),
            context=result.get("context", {}),
            eval_results=result.get("eval_results", []),
            graph_summary=result.get("graph_summary", {}),
        )
