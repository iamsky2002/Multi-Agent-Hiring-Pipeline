
    
    const originalFetch = window.fetch;
    window.fetch = async function() {
        let [resource, config] = arguments;
        if(config === undefined) {
            config = {};
        }
        if(config.headers === undefined) {
            config.headers = {};
        }
        
        const hrToken = localStorage.getItem('hr_token');
        if(hrToken) {
            config.headers['Authorization'] = 'Bearer ' + hrToken;
        }
        return await originalFetch(resource, config);
    };


document.addEventListener('DOMContentLoaded', () => {

    
    
    // Theme Toggle Logic
    const themeToggle = document.getElementById('theme-toggle');
    if(themeToggle) {
        // Check saved theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        
        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }

    // Auth & Login
    const loginScreen = document.getElementById('login-screen');
    const loginForm = document.getElementById('login-form');
    const hrEmailInput = document.getElementById('hr-email-input');
    const hrPasswordInput = document.getElementById('hr-password-input');
    const registerBtn = document.getElementById('register-btn');
    const authStatus = document.getElementById('auth-status');
    const userProfile = document.getElementById('user-profile');
    const loggedInEmail = document.getElementById('logged-in-email');
    const logoutBtn = document.getElementById('logout-btn');

    function checkAuth() {
        const token = localStorage.getItem('hr_token');
        const email = localStorage.getItem('hr_email');
        if (token && email) {
            if(loginScreen) loginScreen.style.display = 'none';
            if(userProfile) userProfile.style.display = 'flex';
            if(loggedInEmail) loggedInEmail.textContent = email;
            // Trigger fetches now that we are authenticated
            if(typeof fetchCandidates === 'function') fetchCandidates();
            if(typeof fetchReviewQueue === 'function') fetchReviewQueue();
            if(typeof fetchAuditLog === 'function') fetchAuditLog();
        } else {
            if(loginScreen) loginScreen.style.display = 'flex';
            if(userProfile) userProfile.style.display = 'none';
        }
    }

    if(loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = hrEmailInput.value.trim();
            const password = hrPasswordInput.value.trim();
            if (email && password) {
                try {
                    const res = await fetch('/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, password })
                    });
                    if(res.ok) {
                        const data = await res.json();
                        localStorage.setItem('hr_token', data.token);
                        localStorage.setItem('hr_email', data.email);
                        checkAuth();
                    } else {
                        authStatus.textContent = "Invalid email or password";
                    }
                } catch(err) {
                    authStatus.textContent = "Network error";
                }
            }
        });
    }

    if(registerBtn) {
        registerBtn.addEventListener('click', async () => {
            const email = hrEmailInput.value.trim();
            const password = hrPasswordInput.value.trim();
            if (email && password) {
                try {
                    const res = await fetch('/auth/register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email, password })
                    });
                    if(res.ok) {
                        const data = await res.json();
                        localStorage.setItem('hr_token', data.token);
                        localStorage.setItem('hr_email', data.email);
                        checkAuth();
                    } else {
                        const data = await res.json();
                        authStatus.textContent = data.detail || "Registration failed";
                    }
                } catch(err) {
                    authStatus.textContent = "Network error";
                }
            } else {
                authStatus.textContent = "Please enter email and password to register.";
            }
        });
    }

    if(logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            localStorage.removeItem('hr_token');
            localStorage.removeItem('hr_email');
            checkAuth();
        });
    }

    // Check auth on load
    checkAuth();


    // ────────────────────────────────────────
    // Branding
    // ────────────────────────────────────────
    async function loadBranding() {
        try {
            const res = await fetch('/config/branding');
            const brand = await res.json();
            document.getElementById('brand-name').textContent = brand.app_name;
            document.getElementById('page-title').textContent = brand.app_name;
            document.title = brand.app_name;
        } catch {
            document.getElementById('brand-name').textContent = 'HireFlow';
        }
    }
    loadBranding();

    // ────────────────────────────────────────
    // Navigation
    // ────────────────────────────────────────
    const navPills = document.querySelectorAll('.nav-pill');
    const views = document.querySelectorAll('.view');

    navPills.forEach(pill => {
        pill.addEventListener('click', () => {
            navPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            const target = pill.dataset.target;
            views.forEach(v => {
                v.classList.remove('active');
                if (v.id === target) v.classList.add('active');
            });
            if (target === 'review') fetchReviewQueue();
            if (target === 'candidates') if(localStorage.getItem('hr_email')) fetchCandidates();
        });
    });

    // ────────────────────────────────────────
    // Pipeline Execution
    // ────────────────────────────────────────
    const form = document.getElementById('pipeline-form');
    const submitBtn = document.getElementById('submit-btn');
    const btnLabel = submitBtn.querySelector('.btn-label');
    const btnSpinner = submitBtn.querySelector('.btn-spinner');
    const timeline = document.getElementById('timeline');
    const timelineEmpty = document.getElementById('timeline-empty');
    const runStatus = document.getElementById('run-status');
    const resultsPanel = document.getElementById('results-panel');
    const resultsContent = document.getElementById('results-content');
    let eventSource = null;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const goalText = document.getElementById('goal-text').value;
        const jdText = document.getElementById('jd-text').value;
        const topK = parseInt(document.getElementById('top-k').value, 10) || 5;
        const strictness = parseFloat(document.getElementById('strictness').value) || 0.8;
        const autoApprove = document.getElementById('auto-approve').checked;

        // Reset
        submitBtn.disabled = true;
        btnLabel.textContent = 'Starting…';
        btnSpinner.classList.remove('hidden');
        clearTimeline();
        resultsPanel.classList.add('hidden');
        resultsContent.innerHTML = '';
        setStatus('running', 'Running');

        try {
            const res = await fetch('/pipeline/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    goal_text: goalText, 
                    raw_jd_text: jdText, 
                    top_k: topK,
                    strictness: strictness,
                    auto_approve: autoApprove
                })
            });
            if (!res.ok) throw new Error('Failed to start pipeline');
            const data = await res.json();
            addTimelineItem('Pipeline Started', `Run ID: ${data.run_id}`, 'running');
            connectSSE(data.run_id);
        } catch (err) {
            addTimelineItem('Error', err.message, 'error');
            resetPipelineBtn();
            setStatus('error', 'Failed');
        }
    });

    function connectSSE(runId) {
        if (eventSource) eventSource.close();
        eventSource = new EventSource(`/pipeline/${runId}/stream`);

        eventSource.addEventListener('state_change', (e) => {
            const d = JSON.parse(e.data);
            addTimelineItem('State', `${d.data.old_state} → ${d.data.new_state}`, 'completed');
        });

        eventSource.addEventListener('agent_started', (e) => {
            const d = JSON.parse(e.data);
            addTimelineItem(`${d.data.agent}`, `Started — ${d.data.task}`, 'running', `task-${d.data.task}`);
        });

        eventSource.addEventListener('agent_completed', (e) => {
            const d = JSON.parse(e.data);
            const existing = document.getElementById(`task-${d.data.task}`);
            if (existing) existing.remove();
            addTimelineItem(`${d.data.agent}`, `${d.data.summary} (${d.data.duration_s}s)`, 'completed');
        });

        eventSource.addEventListener('eval_flagged', (e) => {
            const d = JSON.parse(e.data);
            addTimelineItem('Eval Flagged', `${d.data.agent}: ${d.data.reason}`, 'flagged');
            const badge = document.getElementById('review-badge');
            badge.textContent = parseInt(badge.textContent || '0') + 1;
            badge.classList.remove('hidden');
        });

        eventSource.addEventListener('run_completed', (e) => {
            const d = JSON.parse(e.data);
            const status = d.data.status;
            addTimelineItem('Done', `Pipeline finished: ${status}`, status === 'failed' ? 'error' : 'done');
            setStatus(status === 'failed' ? 'error' : status, status.toUpperCase());
            resetPipelineBtn();
            eventSource.close();
            if (status !== 'failed') showResults();
        });

        eventSource.addEventListener('error', (e) => {
            try {
                const d = JSON.parse(e.data);
                addTimelineItem('Error', d.data.error, 'error');
            } catch {
                addTimelineItem('Error', 'Connection lost', 'error');
            }
            resetPipelineBtn();
            setStatus('error', 'Error');
            eventSource.close();
        });
    }

    function clearTimeline() {
        timeline.innerHTML = '';
        if (timelineEmpty) timelineEmpty.remove();
    }

    function addTimelineItem(title, desc, cls, id = null) {
        // Remove empty state if present
        const empty = timeline.querySelector('.empty-state');
        if (empty) empty.remove();

        const el = document.createElement('div');
        el.className = `tl-item ${cls}`;
        if (id) el.id = id;
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        el.innerHTML = `
            <div class="tl-dot"></div>
            <div class="tl-body">
                <div class="tl-title">${title}</div>
                <div class="tl-desc">${desc}</div>
                <div class="tl-time">${time}</div>
            </div>`;
        timeline.appendChild(el);
        timeline.scrollTop = timeline.scrollHeight;
    }

    function setStatus(cls, text) {
        runStatus.className = `status-chip ${cls}`;
        runStatus.textContent = text;
    }

    function resetPipelineBtn() {
        submitBtn.disabled = false;
        btnLabel.textContent = 'Run Pipeline';
        btnSpinner.classList.add('hidden');
    }

    function showResults() {
        resultsPanel.classList.remove('hidden');
        resultsContent.innerHTML = `
            <div class="result-card">
                <div class="result-header">
                    <span class="result-name">Pipeline Complete</span>
                    <span class="result-score">✓</span>
                </div>
                <div class="result-email-body">All agents executed successfully. Check the Review Queue for any flagged outputs, or switch to the Candidates tab to see your candidate pool.</div>
            </div>`;
    }

    // ────────────────────────────────────────
    // Candidate Management
    // ────────────────────────────────────────
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const uploadProgress = document.getElementById('upload-progress');

    // Drag & drop
    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files).filter(f => f.name.match(/\.(pdf|docx)$/i));
        if (files.length) uploadFiles(files);
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) uploadFiles(Array.from(fileInput.files));
    });

    async function uploadFiles(files) {
        showUploadStatus('loading', `Uploading ${files.length} file(s)…`);

        try {
            if (files.length === 1) {
                const fd = new FormData();
                fd.append('file', files[0]);
                const res = await fetch('/candidates/ingest', { method: 'POST', body: fd });
                const data = await res.json();
                if (data.errors > 0) {
                    showUploadStatus('error', `Error: ${data.results[0].message}`);
                } else {
                    showUploadStatus('success', `✓ Ingested: ${data.results[0].name} (${data.results[0].email})`);
                    if(localStorage.getItem('hr_email')) fetchCandidates();
                }
            } else {
                const fd = new FormData();
                files.forEach(f => fd.append('files', f));
                const res = await fetch('/candidates/ingest/batch', { method: 'POST', body: fd });
                const data = await res.json();
                showUploadStatus(
                    data.errors > 0 ? 'error' : 'success',
                    `${data.ingested} ingested, ${data.errors} errors out of ${data.total} files`
                );
                if(localStorage.getItem('hr_email')) fetchCandidates();
            }
        } catch (err) {
            showUploadStatus('error', `Upload failed: ${err.message}`);
        }
        fileInput.value = '';
    }

    function showUploadStatus(type, msg) {
        uploadProgress.className = `upload-progress ${type}`;
        uploadProgress.textContent = msg;
        uploadProgress.classList.remove('hidden');
    }

    // Folder import
    const folderBtn = document.getElementById('folder-ingest-btn');
    const folderStatus = document.getElementById('folder-status');

    folderBtn.addEventListener('click', async () => {
        const path = document.getElementById('folder-path').value.trim();
        if (!path) return;

        folderStatus.className = 'upload-progress loading';
        folderStatus.textContent = 'Importing…';
        folderStatus.classList.remove('hidden');

        try {
            const res = await fetch('/candidates/ingest/folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder_path: path })
            });
            const data = await res.json();
            if (res.ok) {
                folderStatus.className = `upload-progress ${data.errors > 0 ? 'error' : 'success'}`;
                folderStatus.textContent = `${data.ingested} ingested, ${data.errors} errors out of ${data.total} files`;
                if(localStorage.getItem('hr_email')) fetchCandidates();
            } else {
                folderStatus.className = 'upload-progress error';
                folderStatus.textContent = data.detail || 'Import failed';
            }
        } catch (err) {
            folderStatus.className = 'upload-progress error';
            folderStatus.textContent = `Error: ${err.message}`;
        }
    });

    // Manual form
    const manualForm = document.getElementById('manual-form');
    const manualStatus = document.getElementById('manual-status');

    manualForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        manualStatus.className = 'upload-progress loading';
        manualStatus.textContent = 'Adding candidate…';
        manualStatus.classList.remove('hidden');
        
        const candidate = {
            name: document.getElementById('m-name').value,
            email: document.getElementById('m-email').value,
            current_title: document.getElementById('m-title').value,
            skills: document.getElementById('m-skills').value,
            years_of_experience: parseInt(document.getElementById('m-exp').value, 10),
            previous_companies: "",
            projects: "",
            summary: "",
            position_applied: ""
        };

        try {
            const res = await fetch('/candidates/ingest/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(candidate)
            });
            const data = await res.json();
            if (res.ok && data.status === 'ingested') {
                manualStatus.className = 'upload-progress success';
                manualStatus.textContent = `✓ Added ${data.name}`;
                manualForm.reset();
                if(localStorage.getItem('hr_email')) fetchCandidates();
            } else {
                manualStatus.className = 'upload-progress error';
                manualStatus.textContent = data.message || 'Failed to add';
            }
        } catch (err) {
            manualStatus.className = 'upload-progress error';
            manualStatus.textContent = `Error: ${err.message}`;
        }
    });

    // Fetch & render candidates
    const candidateList = document.getElementById('candidate-list');
    const candidateCount = document.getElementById('candidate-count');

    document.getElementById('refresh-candidates-btn').addEventListener('click', fetchCandidates);

    async function fetchCandidates() {
        try {
            const res = await fetch('/candidates/?limit=100');
            if (!res.ok) throw new Error('Failed to load');
            const candidates = await res.json();
            candidateCount.textContent = `${candidates.length} candidate${candidates.length !== 1 ? 's' : ''}`;

            if (candidates.length === 0) {
                candidateList.innerHTML = '<div class="empty-state"><p>No candidates ingested yet. Upload resumes above.</p></div>';
                return;
            }

            candidateList.innerHTML = candidates.map(c => `
                <div class="cand-card">
                    <div class="cand-name">${c.name || 'Unknown'}</div>
                    <div class="cand-email">${c.email || 'No email'}</div>
                    <div class="cand-meta">
                        <span>${c.years_of_experience}y exp</span>
                        ${c.previous_companies.length ? `<span>${c.previous_companies.filter(Boolean).join(', ')}</span>` : ''}
                    </div>
                    ${c.summary ? `<div class="cand-summary">${c.summary}</div>` : ''}
                </div>
            `).join('');
        } catch (err) {
            candidateList.innerHTML = `<div class="empty-state"><p>Could not load candidates: ${err.message}</p></div>`;
        }
    }

    // ────────────────────────────────────────
    // Review Queue
    // ────────────────────────────────────────
    async function fetchReviewQueue() {
        const container = document.getElementById('review-container');
        try {
            const res = await fetch('/review/queue');
            if (!res.ok) throw new Error('Failed to fetch');
            const queue = await res.json();

            if (queue.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>No items in the review queue. All good.</p></div>';
                document.getElementById('review-badge').classList.add('hidden');
                return;
            }

            document.getElementById('review-badge').textContent = queue.length;
            document.getElementById('review-badge').classList.remove('hidden');

            container.innerHTML = queue.map(item => {
                let contextHtml = '';
            if (item.context_data && item.context_data.length > 0) {
                if (item.agent === 'JDAnalyser') {
                    const jd = item.context_data[0];
                    contextHtml = `
                        <div class="review-context">
                            <h4>Job Description Evidence</h4>
                            <p><strong>Original JD:</strong></p>
                            <pre class="review-source">${jd.raw_job_description}</pre>
                            <p><strong>Extracted requirements to approve or reject:</strong></p>
                            <pre class="review-source">${JSON.stringify(jd.extracted_job_description, null, 2)}</pre>
                        </div>`;
                } else if (item.agent === 'CandidateReview') {
                    const c = item.context_data[0];
                    contextHtml = `
                        <div class="review-context">
                            <h4>Candidate evidence — approve or reject this person</h4>
                            <p><strong>${c.name}</strong> ${c.email ? `(${c.email})` : ''}</p>
                            <p><strong>Final fit score:</strong> ${Number(c.final_score).toFixed(2)} &nbsp; <strong>Semantic:</strong> ${Number(c.semantic_similarity).toFixed(2)} &nbsp; <strong>LLM match:</strong> ${Number(c.llm_rerank_score).toFixed(2)}</p>
                            <p><strong>Matched skills:</strong> ${(c.matched_skills || []).join(', ') || 'None'}</p>
                            <p><strong>Missing skills:</strong> ${(c.missing_skills || []).join(', ') || 'None'}</p>
                            <p><strong>Scoring rationale:</strong> ${c.rationale || 'No rationale supplied.'}</p>
                            <p><strong>Stored resume/profile used for this decision:</strong></p>
                            <pre class="review-source">${c.resume_profile}</pre>
                        </div>`;
                } else if (item.agent === 'OutreachDrafter') {
                    contextHtml = '<div class="review-context"><h4>Drafted Emails</h4>' + item.context_data.map(e => `
                        <div class="email-preview">
                            <strong>To Candidate: ${e.candidate_id}</strong>
                            <p><strong>Subject:</strong> ${e.subject}</p>
                            <pre>${e.body}</pre>
                        </div>
                    `).join('') + '</div>';
                }
            }
            const reviewMetrics = item.agent === 'CandidateReview'
                ? '<div class="review-reason">Recruiter decision required. Review the resume/profile and match evidence below.</div>'
                : `<div class="review-scores">
                    <span>Relevance: ${item.relevance.toFixed(2)}</span>
                    <span>Faithfulness: ${item.faithfulness.toFixed(2)}</span>
                    <span>Completeness: ${item.completeness.toFixed(2)}</span>
                </div>
                <div class="review-reason">${item.review_reason || 'Below threshold'}</div>`;

            return `
                <div class="review-card" id="review-${item.id}">
                    <div class="review-card-header">
                        <span class="review-agent">${item.agent}</span>
                        <span class="review-flag">Needs Review</span>
                    </div>
                    ${reviewMetrics}
                    ${contextHtml}
                    <div class="review-actions">
                        <button class="btn-approve" onclick="submitReview('${item.id}', 'approved')">Approve</button>
                        <button class="btn-reject" onclick="submitReview('${item.id}', 'rejected')">Reject</button>
                    </div>
                </div>
                `;
            }).join('');
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><p style="color:var(--red)">Error: ${err.message}</p></div>`;
        }
    }

    window.submitReview = async (evalId, decision) => {
        try {
            await fetch(`/review/${evalId}/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision, reviewer: 'Recruiter' })
            });
            const card = document.getElementById(`review-${evalId}`);
            if (card) card.remove();
            const badge = document.getElementById('review-badge');
            let count = parseInt(badge.textContent) - 1;
            badge.textContent = count;
            if (count <= 0) badge.classList.add('hidden');
        } catch {
            alert('Failed to submit review');
        }
    };
});


    window.submitEmailDecision = async (emailId, decision) => {
        const bodyElem = document.getElementById(`email-body-${emailId}`);
        const editedBody = bodyElem ? bodyElem.value : null;
        
        try {
            await fetch(`/review/email/${emailId}/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    decision, 
                    edited_body: editedBody,
                    reviewer_email: localStorage.getItem('hr_email')
                })
            });
            const card = document.getElementById(`email-${emailId}`);
            if (card) card.remove();
        } catch(err) {
            alert('Failed to submit email decision');
        }
    };

    
    // Outreach Manual Form
    const outreachForm = document.getElementById('outreach-form');
    const previewCard = document.getElementById('outreach-preview-card');
    const previewSubject = document.getElementById('outreach-preview-subject');
    const previewBody = document.getElementById('outreach-preview-body');
    const sendOutreachBtn = document.getElementById('outreach-send-btn');
    
    if(outreachForm) {
        outreachForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('draft-outreach-btn');
            const status = document.getElementById('outreach-status');
            btn.querySelector('.btn-spinner').classList.remove('hidden');
            previewCard.style.display = 'none';
            
            try {
                const res = await fetch('/pipeline/emails/draft', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        candidate_email: document.getElementById('outreach-cand-email').value,
                        intent: document.getElementById('outreach-intent').value,
                        custom_instructions: document.getElementById('outreach-custom').value
                    })
                });
                const data = await res.json();
                if (data.status === 'success') {
                    status.className = 'upload-progress success';
                    status.textContent = 'Draft generated successfully! Review below.';
                    status.classList.remove('hidden');
                    
                    // Show Preview
                    previewSubject.value = data.subject;
                    previewBody.value = data.body;
                    previewCard.dataset.email = data.candidate_email;
                    previewCard.style.display = 'block';
                } else {
                    throw new Error(data.detail || 'Unknown error');
                }
            } catch(err) {
                status.className = 'upload-progress error';
                status.textContent = err.message;
                status.classList.remove('hidden');
            } finally {
                btn.querySelector('.btn-spinner').classList.add('hidden');
            }
        });
    }
    
    if(sendOutreachBtn) {
        sendOutreachBtn.addEventListener('click', async () => {
            const candEmail = previewCard.dataset.email;
            const subject = previewSubject.value;
            const body = previewBody.value;
            
            try {
                sendOutreachBtn.textContent = "Sending...";
                const res = await fetch('/pipeline/emails/send_manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        candidate_email: candEmail,
                        subject: subject,
                        body: body
                    })
                });
                
                if (res.ok) {
                    alert("Email sent successfully via MCP!");
                    previewCard.style.display = 'none';
                    outreachForm.reset();
                    document.getElementById('outreach-status').classList.add('hidden');
                } else {
                    alert("Failed to send email.");
                }
            } catch(err) {
                alert("Network error: " + err);
            } finally {
                sendOutreachBtn.textContent = "Confirm & Send";
            }
        });
    }

    // Audit Log
    async function fetchAuditLog() {
        const container = document.getElementById('audit-container');
        if(!container) return;
        
        try {
            const res = await fetch('/audit/');
            const logs = await res.json();
            if(!logs.length) {
                container.innerHTML = '<div class="empty-state"><p>No audit logs found.</p></div>';
                return;
            }
            
            container.innerHTML = logs.map(l => `
                <div class="glass-card" style="margin-bottom:1rem; padding: 1.5rem;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:1rem; border-bottom:1px solid rgba(0,0,0,0.1); padding-bottom:0.5rem;">
                        <strong>Run: ${l.run_id}</strong>
                        <span class="status-chip idle">HR: ${l.created_by || 'Unknown'}</span>
                    </div>
                    <div style="margin-bottom:1rem;">
                        <p><strong>Goal:</strong> ${l.goal_text}</p>
                        <p><strong>JD Summary:</strong> ${l.jd_summary || 'N/A'}</p>
                    </div>
                    ${l.decisions.length ? `
                    <div style="background:rgba(255,255,255,0.5); padding:1rem; border-radius:8px;">
                        <h4>Review Decisions</h4>
                        ${l.decisions.map(d => `
                            <p style="margin:0.25rem 0;">
                                <strong>${d.reviewer}:</strong> ${d.decision} (Agent: ${d.agent}) 
                            </p>
                        `).join('')}
                    </div>
                    ` : '<p style="color:#888; font-size:0.9rem;">No reviews yet.</p>'}
                </div>
            `).join('');
        } catch(err) {
            console.error(err);
        }
    }
    window.fetchAuditLog = fetchAuditLog;
    
    const refreshAuditBtn = document.getElementById('refresh-audit-btn');
    if(refreshAuditBtn) {
        refreshAuditBtn.addEventListener('click', fetchAuditLog);
    }
