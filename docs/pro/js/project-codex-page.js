/* ══════════════════════════════════════════════════
   PROJECT CODEX — Logic
   ══════════════════════════════════════════════════ */

let currentProject = null;
let projectList = [];
let aiHistory = [];

/* ── Init ── */
function initCodex() {
  loadProjects();
}

/* ── Tabs ── */
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('on'));
    t.classList.add('on');
    const panel = document.getElementById('panel-' + t.dataset.tab);
    if (panel) panel.classList.add('on');
  });
});

/* ── AI chip clicks ── */
document.querySelectorAll('.ai-chip').forEach(c => {
  c.addEventListener('click', () => {
    document.getElementById('aiInput').value = c.dataset.q;
    sendAiMessage();
  });
});

/* ── AI input auto-resize + Enter to send ── */
const aiInput = document.getElementById('aiInput');
aiInput.addEventListener('input', () => {
  aiInput.style.height = 'auto';
  aiInput.style.height = Math.min(aiInput.scrollHeight, 120) + 'px';
});
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAiMessage();
  }
});

/* ── CSP-safe data-pc-action delegate (replaces inline handlers) ── */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-pc-action]');
  if (!t) return;
  const action = t.getAttribute('data-pc-action');
  switch (action) {
    case 'loadProjects':  loadProjects(); break;
    case 'sendAiMessage': sendAiMessage(); break;
    case 'copyModal':     copyModal(); break;
    case 'closeModal':    closeModal(); break;
    case 'runAction':     runAction(t.getAttribute('data-arg')); break;
    case 'bgClose':       if (e.target === t) closeModal(); break;
  }
});

/* ── Load Projects from Firestore ── */
async function loadProjects() {
  const sel = document.getElementById('projSelect');
  sel.innerHTML = '<option value="">-- Loading... --</option>';

  try {
    if (window._db && window._authUser) {
      const { collection, getDocs, query, where } = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
      const uid = window._authUser.uid;
      // Leads live in the FLAT top-level `/leads` collection keyed by a
      // `userId` field (same model CRM + the deleted-bin read). The old
      // `collection(db,'leads',uid,'leads')` pointed at a nested subcollection
      // that doesn't exist → the security rule never matched → permission
      // denied ("Error loading projects"). Query flat + filter by owner; sort
      // newest-first client-side to avoid a composite-index requirement.
      const q = query(collection(window._db, 'leads'), where('userId', '==', uid));
      const snap = await getDocs(q);
      projectList = [];
      snap.forEach(d => {
        const data = d.data();
        projectList.push({ id: d.id, ...data });
      });
      const _ts = v => (v && typeof v.seconds === 'number') ? v.seconds
        : (typeof v === 'number' ? v / 1000 : (v ? (Date.parse(v) / 1000 || 0) : 0));
      projectList.sort((a, b) => _ts(b.createdAt) - _ts(a.createdAt));

      sel.innerHTML = '<option value="">-- Select a project (' + projectList.length + ' found) --</option>';
      projectList.forEach(p => {
        const name = (p.firstName || '') + ' ' + (p.lastName || '') + (p.address ? ' - ' + p.address : '');
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = name.trim() || p.id;
        sel.appendChild(opt);
      });
    } else {
      sel.innerHTML = '<option value="">-- No database connection --</option>';
      addManualEntry(sel);
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
    sel.innerHTML = '<option value="">-- Error loading projects --</option>';
    addManualEntry(sel);
    toast('Failed to load projects: ' + err.message, 'err');
  }

  sel.onchange = () => selectProject(sel.value);
}

function addManualEntry(sel) {
  const opt = document.createElement('option');
  opt.value = '__manual__';
  opt.textContent = '+ Enter project manually';
  sel.appendChild(opt);
}

/* ── Select Project ── */
async function selectProject(id) {
  if (!id) {
    currentProject = null;
    document.getElementById('statsRow').style.display = 'none';
    document.getElementById('tabsBar').style.display = 'none';
    document.getElementById('tlEmpty').style.display = 'block';
    document.getElementById('tlContainer').innerHTML = '';
    return;
  }

  if (id === '__manual__') {
    const name = prompt('Enter homeowner name or project address:');
    if (!name) return;
    currentProject = { id: 'manual', firstName: name, stage: 'new', createdAt: { toDate: () => new Date() } };
  } else {
    currentProject = projectList.find(p => p.id === id) || null;
  }

  if (!currentProject) return;

  // Show UI
  document.getElementById('statsRow').style.display = '';
  document.getElementById('tabsBar').style.display = '';
  document.getElementById('tlEmpty').style.display = 'none';

  // Update stats
  updateStats();
  buildTimeline();
  resetAiChat();
}

/* ── Update Stats ── */
function updateStats() {
  if (!currentProject) return;
  const p = currentProject;

  const stage = (p.stage || 'new').replace(/_/g, ' ');
  document.getElementById('statStage').textContent = stage.charAt(0).toUpperCase() + stage.slice(1);

  const created = p.createdAt?.toDate ? p.createdAt.toDate() : (p.createdAt?.seconds ? new Date(p.createdAt.seconds * 1000) : new Date());
  const days = Math.max(1, Math.ceil((Date.now() - created.getTime()) / 86400000));
  document.getElementById('statDays').textContent = days;

  const photoCount = (p.photos || []).length || 0;
  document.getElementById('statPhotos').textContent = photoCount;

  const val = p.estimateTotal || p.totalRCV || p.cashPrice || 0;
  document.getElementById('statValue').textContent = val ? '$' + Number(val).toLocaleString() : '--';
}

/* ── Build Timeline ── */
function buildTimeline() {
  const container = document.getElementById('tlContainer');
  container.innerHTML = '';
  if (!currentProject) return;

  const events = [];
  const p = currentProject;

  // Created
  const createdDate = p.createdAt?.toDate ? p.createdAt.toDate() : (p.createdAt?.seconds ? new Date(p.createdAt.seconds * 1000) : new Date());
  events.push({ type: 'note', title: 'Project Created', detail: 'Lead entered into system. Source: ' + (p.source || 'manual'), date: createdDate });

  // Stage transitions from history
  if (p.stageHistory && Array.isArray(p.stageHistory)) {
    p.stageHistory.forEach(h => {
      const d = h.at?.toDate ? h.at.toDate() : (h.at?.seconds ? new Date(h.at.seconds * 1000) : null);
      if (d) events.push({ type: 'note', title: 'Stage: ' + (h.to || '').replace(/_/g, ' '), detail: h.note || '', date: d });
    });
  }

  // Estimate
  if (p.estimateTotal || p.totalRCV) {
    const d = p.estimateDate?.toDate ? p.estimateDate.toDate() : (p.estimateDate?.seconds ? new Date(p.estimateDate.seconds * 1000) : createdDate);
    events.push({ type: 'est', title: 'Estimate: $' + Number(p.estimateTotal || p.totalRCV || 0).toLocaleString(), detail: p.estimateNotes || 'Estimate generated for project.', date: d });
  }

  // Photos
  if (p.photos && p.photos.length) {
    events.push({ type: 'photo', title: p.photos.length + ' Photos Captured', detail: 'Inspection photos on file.', date: p.inspectionDate?.toDate ? p.inspectionDate.toDate() : createdDate });
  }

  // Tasks
  if (p.tasks && Array.isArray(p.tasks)) {
    p.tasks.forEach(t => {
      const d = t.createdAt?.toDate ? t.createdAt.toDate() : createdDate;
      events.push({ type: 'task', title: (t.done ? '\u2705 ' : '\u23F3 ') + (t.text || 'Task'), detail: t.notes || '', date: d });
    });
  }

  // Documents
  if (p.documents && Array.isArray(p.documents)) {
    p.documents.forEach(doc => {
      const d = doc.createdAt?.toDate ? doc.createdAt.toDate() : createdDate;
      events.push({ type: 'doc', title: doc.name || 'Document', detail: doc.type || '', date: d });
    });
  }

  // Notes
  if (p.notes) {
    events.push({ type: 'note', title: 'Notes', detail: p.notes, date: createdDate });
  }

  // Sort newest first
  events.sort((a, b) => b.date - a.date);

  if (events.length === 0) {
    container.innerHTML = '<div class="tl-empty">No timeline events yet for this project.</div>';
    return;
  }

  events.forEach((ev, i) => {
    const isLatest = i === 0;
    const item = document.createElement('div');
    item.className = 'tl-item';
    item.innerHTML = `
      <div class="tl-rail">
        <div class="tl-dot ${isLatest ? 'latest' : ev.type}"></div>
        ${i < events.length - 1 ? '<div class="tl-track"></div>' : ''}
      </div>
      <div class="tl-body">
        <div class="tl-card">
          <span class="tl-type ${ev.type}">${ev.type.toUpperCase()}</span>
          <div class="tl-title">${escHTML(ev.title)}</div>
          <div class="tl-date">${formatDate(ev.date)}</div>
          ${ev.detail ? '<div class="tl-detail">' + escHTML(ev.detail) + '</div>' : ''}
        </div>
      </div>`;
    container.appendChild(item);
  });
}

/* ── AI Chat ── */
function resetAiChat() {
  aiHistory = [];
  const msgs = document.getElementById('aiMsgs');
  msgs.innerHTML = '<div class="ai-empty">Ask anything about this project. I have the full context.</div>';
  document.getElementById('aiChips').style.display = '';
}

async function sendAiMessage() {
  const input = document.getElementById('aiInput');
  const q = input.value.trim();
  if (!q || !currentProject) return;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('aiChips').style.display = 'none';

  const msgs = document.getElementById('aiMsgs');
  // Remove empty state
  const empty = msgs.querySelector('.ai-empty');
  if (empty) empty.remove();

  // Add user message
  appendMsg('user', q);
  aiHistory.push({ role: 'user', content: q });

  // Show typing
  const typing = document.createElement('div');
  typing.className = 'ai-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  const sendBtn = document.getElementById('aiSend');
  sendBtn.disabled = true;

  try {
    if (!window.callClaude) throw new Error('AI proxy not loaded. Refresh and try again.');

    const projectCtx = buildProjectContext();
    const systemPrompt = `You are the NBD Pro Project Codex AI assistant. You help roofing contractors manage their projects.

You have full context about this specific project:
${projectCtx}

Answer questions about this project concisely and professionally. When drafting emails or documents, use a friendly but professional tone appropriate for a roofing contractor communicating with homeowners.

Format responses with clear structure. Use bullet points for lists. Keep responses focused and actionable.`;

    const result = await window.callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: systemPrompt,
      messages: aiHistory.slice(-10) // keep last 10 messages for context
    });

    typing.remove();

    const reply = result?.content?.[0]?.text || result?.content || 'No response received.';
    aiHistory.push({ role: 'assistant', content: reply });
    appendMsg('ai', reply);

  } catch (err) {
    typing.remove();
    appendMsg('ai', 'Error: ' + err.message);
    toast('AI request failed: ' + err.message, 'err');
  }

  sendBtn.disabled = false;
}

function appendMsg(role, text) {
  const msgs = document.getElementById('aiMsgs');
  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  if (role === 'ai') {
    div.innerHTML = formatAiText(text);
  } else {
    div.textContent = text;
  }
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function formatAiText(text) {
  // Basic markdown-lite formatting
  let html = escHTML(text);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Bullet lists
  html = html.replace(/^[-\u2022]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
  // Fix nested ul
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  // Numbered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p>\s*<\/p>/g, '');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

/* ── Build Project Context for AI ── */
function buildProjectContext() {
  const p = currentProject;
  if (!p) return 'No project selected.';

  const lines = [];
  lines.push('PROJECT: ' + (p.firstName || '') + ' ' + (p.lastName || ''));
  lines.push('ADDRESS: ' + (p.address || 'Not set'));
  lines.push('PHONE: ' + (p.phone || 'Not set'));
  lines.push('EMAIL: ' + (p.email || 'Not set'));
  lines.push('STAGE: ' + (p.stage || 'new'));
  lines.push('SOURCE: ' + (p.source || 'manual'));
  lines.push('DAMAGE TYPE: ' + (p.damageType || 'Not specified'));

  const created = p.createdAt?.toDate ? p.createdAt.toDate() : (p.createdAt?.seconds ? new Date(p.createdAt.seconds * 1000) : null);
  if (created) lines.push('CREATED: ' + created.toLocaleDateString());

  if (p.estimateTotal || p.totalRCV) lines.push('ESTIMATE VALUE: $' + Number(p.estimateTotal || p.totalRCV).toLocaleString());
  if (p.cashPrice) lines.push('CASH PRICE: $' + Number(p.cashPrice).toLocaleString());
  if (p.deductible) lines.push('DEDUCTIBLE: $' + Number(p.deductible).toLocaleString());
  if (p.insuranceCarrier) lines.push('INSURANCE: ' + p.insuranceCarrier);
  if (p.claimNumber) lines.push('CLAIM #: ' + p.claimNumber);
  if (p.notes) lines.push('NOTES: ' + p.notes);

  if (p.photos && p.photos.length) lines.push('PHOTOS: ' + p.photos.length + ' on file');

  if (p.stageHistory && Array.isArray(p.stageHistory)) {
    lines.push('STAGE HISTORY:');
    p.stageHistory.forEach(h => {
      const d = h.at?.toDate ? h.at.toDate() : null;
      lines.push('  - ' + (h.to || '').replace(/_/g, ' ') + (d ? ' (' + d.toLocaleDateString() + ')' : '') + (h.note ? ': ' + h.note : ''));
    });
  }

  if (p.tasks && Array.isArray(p.tasks)) {
    lines.push('TASKS:');
    p.tasks.forEach(t => {
      lines.push('  - [' + (t.done ? 'DONE' : 'OPEN') + '] ' + (t.text || 'Task'));
    });
  }

  return lines.join('\n');
}

/* ── Quick Actions ── */
async function runAction(type) {
  if (!currentProject) {
    toast('Select a project first.', 'err');
    return;
  }

  const card = event.currentTarget;
  card.classList.add('loading');

  const ctx = buildProjectContext();
  const prompts = {
    scope: `Based on this roofing project data, generate a professional Scope of Work document. Include sections for: Project Overview, Work Description, Materials, Timeline, and Terms.\n\nProject data:\n${ctx}`,
    followup: `Draft a professional follow-up email from a roofing contractor to the homeowner for this project. Be warm but professional. Include project status and next steps.\n\nProject data:\n${ctx}`,
    checklist: `Generate a pre-build checklist for this roofing project. Include materials ordering, permits, crew scheduling, homeowner communication, and safety items.\n\nProject data:\n${ctx}`,
    supplement: `Analyze this roofing project and suggest potential insurance supplement line items. Consider common items adjusters miss: drip edge, ice & water shield, pipe jacks, step flashing, ridge vent, starter strip, and code upgrades.\n\nProject data:\n${ctx}`,
    closeout: `Generate a complete job close-out summary for this roofing project. Include: project overview, work completed, timeline recap, financial summary, and recommendations for the homeowner.\n\nProject data:\n${ctx}`,
    review: `Generate a personalized review request message for this roofing project homeowner. Make it friendly, reference the specific work done, and suggest Google and Facebook as review platforms.\n\nProject data:\n${ctx}`
  };

  const titles = {
    scope: 'Scope of Work',
    followup: 'Follow-Up Email',
    checklist: 'Pre-Build Checklist',
    supplement: 'Supplement Strategy',
    closeout: 'Close-Out Summary',
    review: 'Review Request'
  };

  try {
    if (!window.callClaude) throw new Error('AI proxy not loaded.');

    const result = await window.callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: 'You are an expert roofing contractor assistant for NBD Pro. Generate professional, actionable documents. Use clear formatting with headers and bullet points.',
      messages: [{ role: 'user', content: prompts[type] }]
    });

    const text = result?.content?.[0]?.text || result?.content || 'No response.';
    showModal(titles[type], text);

  } catch (err) {
    toast('Action failed: ' + err.message, 'err');
  }

  card.classList.remove('loading');
}

/* ── Modal ── */
function showModal(title, content) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = formatAiText(content);
  document.getElementById('modalBg').classList.add('open');
}

function closeModal() {
  document.getElementById('modalBg').classList.remove('open');
}

function copyModal() {
  const text = document.getElementById('modalBody').innerText;
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard!', 'ok')).catch(() => toast('Copy failed', 'err'));
}

/* ── Toast ── */
function toast(msg, type) {
  const wrap = document.getElementById('toastWrap');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; setTimeout(() => t.remove(), 300); }, 3500);
}

/* ── Helpers ── */
function escHTML(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function formatDate(d) {
  if (!d) return '';
  try {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

/* ── Keyboard shortcut: Escape closes modal ── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ── Try init if auth already ready ── */
if (window._firebaseReady) initCodex();

// ── CSP-safe data-pc-action delegate ──
// The strict CSP at firebase.json:44 blocks `script-src-attr 'none'`, so
// inline `onclick="..."` attributes silently no-op. The page markup uses
// `data-pc-action="..."` + optional `data-arg="..."`; this delegate maps
// them to the existing globals.
(function () {
  if (window._NBD_PC_DELEGATE_BOUND) return;
  window._NBD_PC_DELEGATE_BOUND = true;
  document.addEventListener('click', function (ev) {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-pc-action]');
    if (!t) return;
    const action = t.dataset.pcAction;
    if (action === 'bgClose') {
      // Backdrop click — only close if user clicked the backdrop itself,
      // not a child inside it (mirrors the old `if(event.target===this)`).
      if (ev.target !== t) return;
      if (typeof closeModal === 'function') closeModal();
      return;
    }
    if (action === 'runAction') {
      const arg = t.dataset.arg;
      if (typeof runAction === 'function') runAction(arg);
      return;
    }
    const fn = window[action];
    if (typeof fn === 'function') fn();
    else console.warn('[project-codex] no dispatch for', action);
  });
})();
