/* ══════════════════════════════════════════════════
   UNDERSTANDING TOOL — Logic
   ══════════════════════════════════════════════════ */

const STORAGE_KEY = 'nbd_understand_insights';
let currentDomain = null;
let chatHistory = [];
let pipelineContext = null;

const DOMAINS = {
  insurance: {
    label: 'Insurance Deep Dive',
    badge: 'ins',
    topics: [
      'How does the roof insurance claim process work in Ohio?',
      'What are the best supplement line items for a shingle roof?',
      'How should I prepare for an adjuster meeting?',
      'State Farm vs Allstate: different claim strategies?',
      'How to handle a denied roof claim?',
      'What\'s the O&P (overhead and profit) rule?',
      'How to write a supplement that gets approved?',
      'What are common Xactimate line items adjusters miss?'
    ],
    system: `You are an expert insurance claims consultant specializing in roofing. You help roofing contractors navigate the insurance claim process, write supplements, prepare for adjuster meetings, and maximize claim payouts -- all within legal and ethical bounds.

Key areas of expertise:
- Ohio and Kentucky insurance law and regulations
- Xactimate estimating and supplement strategies
- Carrier-specific claim processes (State Farm, Allstate, USAA, Erie, etc.)
- Adjuster meeting tactics and documentation
- Denied claim appeals
- ACV vs RCV, depreciation, deductibles, O&P

Be specific, actionable, and practical. Use real terminology contractors would use. When discussing supplements, mention specific Xactimate line items where relevant.`
  },
  technical: {
    label: 'Technical Analysis',
    badge: 'tech',
    topics: [
      'GAF vs Owens Corning vs CertainTeed: which is best?',
      'What building codes apply to reroofing in Ohio?',
      'How to calculate proper attic ventilation (NFA)?',
      'Ice and water shield requirements by code',
      'When should I recommend a full tear-off vs overlay?',
      'Best underlayment options and when to use synthetic',
      'How to properly flash a chimney on a shingle roof',
      'Metal roofing vs asphalt shingles: cost-benefit analysis'
    ],
    system: `You are an expert roofing technical consultant. You help contractors understand building codes, material specifications, installation best practices, and technical decision-making.

Key areas of expertise:
- Ohio Residential Building Code (IRC-based)
- Manufacturer installation requirements (GAF, Owens Corning, CertainTeed, Atlas)
- Ventilation calculations (NFA, intake vs exhaust)
- Flashing details and water management
- Material comparisons and specifications
- Warranty implications of installation methods
- Energy efficiency and cool roof technology

Be technically precise. Reference specific code sections when relevant. Give practical field advice, not just textbook answers.`
  },
  business: {
    label: 'Business Strategy',
    badge: 'biz',
    topics: [
      'How should I price my roofing jobs to stay competitive?',
      'Best marketing strategies for roofing contractors',
      'How to build and manage a roofing crew',
      'Territory planning: how many leads do I need per month?',
      'Should I focus on insurance work or retail/cash jobs?',
      'How to get more Google reviews and rank higher',
      'When should I hire a project manager vs do it myself?',
      'How to scale from $500K to $2M annual revenue'
    ],
    system: `You are an expert roofing business consultant. You help contractors with pricing strategy, marketing, operations, hiring, territory planning, and growth.

Key areas of expertise:
- Roofing business financial models and pricing
- Digital marketing for contractors (Google, Facebook, SEO)
- Lead generation and conversion optimization
- Crew management and scaling operations
- Insurance restoration vs retail roofing business models
- CRM usage and pipeline management
- Territory analysis and market opportunity

Give specific, numbers-driven advice when possible. Reference typical metrics for roofing businesses. Tailor advice for small to mid-size contractors (1-15 person operations).`
  }
};

/* ── Init ── */
function initUnderstand() {
  loadPipelineContext();
  renderSavedInsights();
}

/* ── Domain Selection ── */
function selectDomain(domain) {
  currentDomain = domain;
  chatHistory = [];
  const d = DOMAINS[domain];

  document.getElementById('heroView').style.display = 'none';
  document.getElementById('chatView').classList.add('show');

  // Header
  document.getElementById('cvBadge').textContent = d.label.split(' ')[0].toUpperCase();
  document.getElementById('cvBadge').className = 'cv-domain-badge ' + d.badge;
  document.getElementById('cvTitle').textContent = d.label;

  // Topic pills
  const pillsEl = document.getElementById('topicPills');
  pillsEl.innerHTML = '';
  d.topics.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'topic-pill';
    btn.textContent = t.length > 50 ? t.substring(0, 47) + '...' : t;
    btn.title = t;
    btn.onclick = () => {
      document.getElementById('chatInput').value = t;
      sendMessage();
    };
    pillsEl.appendChild(btn);
  });

  // Context bar
  if (pipelineContext) {
    document.getElementById('ctxBar').style.display = '';
    document.getElementById('ctxLeads').textContent = pipelineContext.leads || 0;
    document.getElementById('ctxRevenue').textContent = '$' + Number(pipelineContext.revenue || 0).toLocaleString();
  }

  // Reset chat
  const msgs = document.getElementById('chatMsgs');
  msgs.innerHTML = `<div class="chat-welcome" id="chatWelcome"><strong>Ready to help with ${escHTML(d.label)}.</strong>Pick a topic above or type your question below.</div>`;
}

function backToHero() {
  currentDomain = null;
  chatHistory = [];
  document.getElementById('heroView').style.display = '';
  document.getElementById('chatView').classList.remove('show');
}

/* ── Chat Input ── */
const chatInput = document.getElementById('chatInput');
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

/* ── Send Message ── */
async function sendMessage() {
  const input = document.getElementById('chatInput');
  const q = input.value.trim();
  if (!q || !currentDomain) return;

  input.value = '';
  input.style.height = 'auto';

  // Hide welcome, hide topic pills after first message
  const welcome = document.getElementById('chatWelcome');
  if (welcome) welcome.remove();
  document.getElementById('topicPills').style.display = 'none';

  const msgs = document.getElementById('chatMsgs');

  // User message
  appendChatMsg('user', q);
  chatHistory.push({ role: 'user', content: q });

  // Typing indicator
  const typing = document.createElement('div');
  typing.className = 'chat-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  const sendBtn = document.getElementById('chatSend');
  sendBtn.disabled = true;

  try {
    if (!window.callClaude) throw new Error('AI proxy not loaded. Refresh and try again.');

    const domain = DOMAINS[currentDomain];
    let systemPrompt = domain.system;

    // Add pipeline context if available
    if (pipelineContext) {
      systemPrompt += `\n\nContractor's current pipeline data (for context):
- Total leads: ${pipelineContext.leads || 0}
- Pipeline value: $${Number(pipelineContext.revenue || 0).toLocaleString()}
- Active jobs: ${pipelineContext.active || 0}
- Closed jobs: ${pipelineContext.closed || 0}
Use this context when relevant to personalize advice.`;
    }

    const result = await window.callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: systemPrompt,
      messages: chatHistory.slice(-12)
    });

    typing.remove();

    const reply = result?.content?.[0]?.text || result?.content || 'No response received.';
    chatHistory.push({ role: 'assistant', content: reply });
    appendChatMsg('ai', reply, q);

  } catch (err) {
    typing.remove();
    appendChatMsg('ai', 'Error: ' + err.message);
    toast('AI request failed: ' + err.message, 'err');
  }

  sendBtn.disabled = false;
}

function appendChatMsg(role, text, question) {
  const msgs = document.getElementById('chatMsgs');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;

  if (role === 'ai') {
    div.innerHTML = formatAiText(text);

    // Add save button
    const saveBtn = document.createElement('button');
    saveBtn.style.cssText = 'background:none;border:1px solid var(--bdr2);color:var(--tx3);font-size:10px;padding:3px 10px;border-radius:6px;cursor:pointer;margin-top:8px;transition:all .15s';
    saveBtn.textContent = 'Save insight';
    saveBtn.onmouseover = () => { saveBtn.style.color = 'var(--or)'; saveBtn.style.borderColor = 'var(--or)'; };
    saveBtn.onmouseout = () => { saveBtn.style.color = 'var(--tx3)'; saveBtn.style.borderColor = 'var(--bdr2)'; };
    saveBtn.onclick = () => {
      saveInsight(question || '', text, currentDomain);
      saveBtn.textContent = 'Saved!';
      saveBtn.style.color = 'var(--grn)';
      saveBtn.style.borderColor = 'var(--grn)';
      saveBtn.disabled = true;
    };
    div.appendChild(saveBtn);
  } else {
    div.textContent = text;
  }

  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function formatAiText(text) {
  let html = escHTML(text);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Headers (### )
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  // Bullet lists
  html = html.replace(/^[-\u2022]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
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

/* ── Pipeline Context ── */
async function loadPipelineContext() {
  try {
    if (window._db && window._authUser) {
      const { collection, getDocs, query } = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
      const uid = window._authUser.uid;
      const snap = await getDocs(query(collection(window._db, 'leads', uid, 'leads')));
      let totalRevenue = 0;
      let active = 0;
      let closed = 0;
      snap.forEach(d => {
        const data = d.data();
        totalRevenue += Number(data.estimateTotal || data.totalRCV || data.cashPrice || 0);
        if (data.stage === 'completed' || data.stage === 'collected') closed++;
        else active++;
      });
      pipelineContext = { leads: snap.size, revenue: totalRevenue, active, closed };
    }
  } catch (err) {
    console.warn('Could not load pipeline context:', err);
  }
}

/* ── Saved Insights (localStorage) ── */
function getSavedInsights() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

function saveInsight(question, answer, domain) {
  const insights = getSavedInsights();
  insights.unshift({
    id: Date.now(),
    question,
    answer,
    domain,
    date: new Date().toISOString()
  });
  // Keep max 50
  if (insights.length > 50) insights.length = 50;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(insights));
  renderSavedInsights();
  toast('Insight saved!', 'ok');
}

function deleteInsight(id) {
  const insights = getSavedInsights().filter(i => i.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(insights));
  renderSavedInsights();
}

// async since 2026-09-03 so the confirm can be the real modal. Safe: the only
// caller is the data-action dispatch map below, wired through
// addEventListener, which discards the return value — so there is no
// `if (fn())` truthiness hazard from returning a Promise.
async function clearAllInsights() {
  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _ask('Delete all saved insights?'))) return;
  localStorage.removeItem(STORAGE_KEY);
  renderSavedInsights();
  toast('All insights cleared.', 'ok');
}

function renderSavedInsights() {
  const insights = getSavedInsights();
  const list = document.getElementById('siList');
  const countEl = document.getElementById('savedCount');
  const clearBtn = document.getElementById('siClearBtn');

  countEl.textContent = insights.length;
  clearBtn.style.display = insights.length > 0 ? '' : 'none';

  if (insights.length === 0) {
    list.innerHTML = '<div class="si-empty">No saved insights yet. Save answers from your conversations for quick reference.</div>';
    return;
  }

  list.innerHTML = '';
  insights.forEach(ins => {
    const d = DOMAINS[ins.domain];
    const card = document.createElement('div');
    card.className = 'si-card';
    card.innerHTML = `
      <div class="si-card-domain ${d?.badge || ''}">${d?.label || ins.domain}</div>
      <div class="si-card-q">${escHTML(ins.question || 'Quick insight')}</div>
      <div class="si-card-date">${new Date(ins.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div class="si-card-preview">${escHTML(ins.answer).substring(0, 200)}...</div>
      <div class="si-card-acts">
        <button class="si-del" data-id="${ins.id}">Delete</button>
      </div>`;
    card.querySelector('.si-del').onclick = (e) => { e.stopPropagation(); deleteInsight(ins.id); };
    card.onclick = () => {
      closeSavedInsights();
      if (ins.domain && DOMAINS[ins.domain]) {
        selectDomain(ins.domain);
        // Show the answer
        const welcome = document.getElementById('chatWelcome');
        if (welcome) welcome.remove();
        document.getElementById('topicPills').style.display = 'none';
        if (ins.question) appendChatMsg('user', ins.question);
        appendChatMsg('ai', ins.answer, ins.question);
        chatHistory.push({ role: 'user', content: ins.question });
        chatHistory.push({ role: 'assistant', content: ins.answer });
      }
    };
    list.appendChild(card);
  });
}

function openSavedInsights() {
  document.getElementById('siOverlay').classList.add('open');
  document.getElementById('siPanel').classList.add('open');
}

function closeSavedInsights() {
  document.getElementById('siOverlay').classList.remove('open');
  document.getElementById('siPanel').classList.remove('open');
}

/* ── Toast ── */
// 2026-07-19 consolidation: delegates to the shared /pro/js/toast.js module
// (dashboard contract, loaded by understand.html before this script).
// Legacy local types map through: ok→success, err→error.
function toast(msg, type) {
  window.showToast(msg, type === 'ok' ? 'success' : type === 'err' ? 'error' : (type || 'info'));
}

/* ── Helpers ── */
function escHTML(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

/* ── Keyboard: Escape ── */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSavedInsights();
});

/* ── Init if auth ready ── */
if (window._firebaseReady) initUnderstand();

// ─────────────────────────────────────────────────
// Event delegation for data-action attributes.
// Replaces the inline onclick="..." handlers the strict-CSP migration
// removed from the HTML.
// ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-action]').forEach(el => {
    const action = el.dataset.action;
    const handler = {
      'open-saved':    () => typeof window.openSavedInsights === 'function' && window.openSavedInsights(),
      'close-saved':   () => typeof window.closeSavedInsights === 'function' && window.closeSavedInsights(),
      'clear-insights':() => typeof window.clearAllInsights === 'function' && window.clearAllInsights(),
      'back-to-hero':  () => typeof window.backToHero === 'function' && window.backToHero(),
      'select-domain': () => typeof window.selectDomain === 'function' && window.selectDomain(el.dataset.domain),
    }[action];
    if (handler) el.addEventListener('click', handler);
  });
  const sendBtn = document.getElementById('chatSend');
  if (sendBtn) sendBtn.addEventListener('click', () => {
    if (typeof window.sendMessage === 'function') window.sendMessage();
  });
});
