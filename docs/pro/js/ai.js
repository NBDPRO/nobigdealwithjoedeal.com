// ============================================================
// NBD Pro — ai.js  
// Ask Joe AI chat system, key management, context builder,
// chat persistence, message rendering, Joe persona
// ============================================================

// ══════════════════════════════════════════════════════════════════════
// ASK JOE AI
// ══════════════════════════════════════════════════════════════════════
const JOE_KEY_STORE  = 'nbd_joe_key';
const JOE_CHAT_STORE = 'nbd_joe_chat';
let _joeMessages = []; // {role, content}
let _joeTyping   = false;

// ── Key management ──────────────────────────────────────────────────
// Anthropic key is held in sessionStorage so it dies with the tab —
// reduces XSS exfil window vs localStorage. We migrate any pre-existing
// localStorage value on first read, then purge it.
function _migrateJoeKey() {
  try {
    const legacy = localStorage.getItem(JOE_KEY_STORE);
    if (legacy && !sessionStorage.getItem(JOE_KEY_STORE)) {
      sessionStorage.setItem(JOE_KEY_STORE, legacy);
    }
    if (legacy) localStorage.removeItem(JOE_KEY_STORE);
  } catch(e){}
}
function getJoeKey()  { _migrateJoeKey(); try { return sessionStorage.getItem(JOE_KEY_STORE)||''; } catch { return ''; } }
// saveJoeKey / saveJoeKeyFromSettings removed 2026-08-10: the key-input UI
// solicited an sk-ant secret into storage that no reachable path could use —
// the server proxy (claudeProxy CF) is the only working transport, the direct
// browser path is opt-in-disabled AND CSP-blocked. getJoeKey/clearJoeKey stay
// so previously saved keys keep working with dev overrides and can be wiped.
function clearJoeKey() {
  try {
    sessionStorage.removeItem(JOE_KEY_STORE);
    localStorage.removeItem(JOE_KEY_STORE);
    localStorage.removeItem(JOE_CHAT_STORE);
  } catch(e){}
  // Without this the settings status line kept showing "✓ Key saved —
  // Joe AI is active" after the key was gone (NEW-D45b).
  const status = document.getElementById('joeKeyStatus');
  if (status) { status.textContent = 'Key cleared — Joe AI is off until you save a new key'; status.style.color = 'var(--m)'; }
  _joeMessages = [];
  initJoeChat();
}

// ── Build rich context from live Firestore data ─────────────────────
function buildJoeContext() {
  const leads    = window._leads || [];
  const ests     = window._estimates || [];
  const user     = window._user;
  const settings = window._userSettings || {};

  const today = new Date(); today.setHours(0,0,0,0);
  // Post-crm-stages migration the canonical exit keys are 'closed' / 'lost'.
  // Match BOTH canonical and legacy ('Complete' / 'Lost') so old Firestore
  // docs aren't double-counted as active. v159.4 missed this filter.
  const _terminal = new Set(['closed', 'lost', 'Complete', 'Lost']);
  const active = leads.filter(l => !_terminal.has(l.stage || ''));
  const closed = leads.filter(l => l.stage === 'closed' || l.stage === 'Complete');
  const overdue = leads.filter(l => {
    if (!l.followUp || _terminal.has(l.stage || '')) return false;
    // Local day ('YYYY-MM-DD' parses as UTC — a day early in the US).
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(l.followUp));
    return (m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(l.followUp)) <= today;
  });
  // Money counts every JOB (a customer's second job's value is its own —
  // jobs-store.js recordsFor); customer counts and follow-ups stay on leads.
  const recs = (window.NBDJobs && typeof window.NBDJobs.recordsFor === 'function') ? window.NBDJobs.recordsFor(leads) : leads;
  const activeJobs = recs.filter(l => !_terminal.has(l.stage || ''));
  const closedJobs = recs.filter(l => l.stage === 'closed' || l.stage === 'Complete');
  const pipeVal = activeJobs.reduce((s,l)=>s+parseFloat(l.jobValue||0),0);
  const closedRev = closedJobs.reduce((s,l)=>s+parseFloat(l.jobValue||0),0);

  // Stage breakdown
  const byStage = {};
  leads.forEach(l=>{ byStage[l.stage||'New']=(byStage[l.stage||'New']||0)+1; });
  const stageStr = Object.entries(byStage).map(([k,v])=>`${k}:${v}`).join(', ');

  // Top leads to call out
  const topLeads = activeJobs.slice()
    .sort((a,b)=>parseFloat(b.jobValue||0)-parseFloat(a.jobValue||0))
    .slice(0,5)
    .map(l=>`${l.firstName||''} ${l.lastName||''}${l._jobTitle ? ' — ' + l._jobTitle : ''} (${l.stage},${l.damageType||'unknown damage'}, $${parseFloat(l.jobValue||0).toLocaleString()}, ${l.claimStatus||'no claim'})`)
    .join('; ');

  // Overdue follow-ups
  const overdueStr = overdue.slice(0,5)
    .map(l=>`${l.firstName||''} ${l.lastName||''} - due ${l.followUp}`)
    .join('; ');

  // Tasks due today
  const tasksDue = [];
  const taskCache = window._taskCache || {};
  (window._leads||[]).forEach(lead=>{
    if(!lead || !lead.id) return;
    (taskCache[lead.id]||[]).forEach(t=>{
      if(!t || t.done) return;
      const due = t.dueDate ? new Date(t.dueDate+'T23:59:59') : null;
      if(due && due <= new Date()) {
        tasksDue.push(`"${t.text}" for ${(lead.firstName||'')} ${(lead.lastName||'')||lead.address}`);
      }
    });
  });

  return {
    name: settings.displayName || user?.displayName || 'the rep',
    // NEW-D16: clean first name for the greeting. ctx.name keeps the
    // 'the rep' fallback for the system prompt, but the greeting must not
    // render "Hey the —" (which happens because 'the rep'.split(' ')[0] is
    // the truthy 'the'). Derive a real first name or fall back to 'there'.
    firstName: ((settings.displayName || user?.displayName || '').trim().split(' ')[0]) || 'there',
    company: settings.company || 'their company',
    totalLeads: leads.length,
    activeLeads: active.length,
    pipelineValue: pipeVal,
    closedRevenue: closedRev,
    // Revenue = COLLECTED (Jo, 2026-09-28); null until invoices have loaded.
    collectedRevenue: (function () { var R = window.NBDRevenue, inv = R && R.cached(); return inv ? R.collectedBetween(inv, null, null).total : null; })(),
    overdueCount: overdue.length,
    stageBreakdown: stageStr,
    topLeads: topLeads || 'none yet',
    overdueFollowUps: overdueStr || 'none',
    totalEstimates: ests.length,
    tasksDueToday: tasksDue.length ? tasksDue.join('; ') : 'none',
  };
}

function buildJoeSystemPrompt(ctx) {
  return `You are Joe Deal — owner of No Big Deal Home Solutions in the Greater Cincinnati area. You're a battle-tested insurance restoration contractor with years in roofing, siding, storm damage, fire, water, and smoke claims. You founded No Big Deal Solutions and you know this industry cold: Xactimate, supplement writing, adjuster negotiations, canvassing, D2D sales, the whole game.

You're talking to one of your members on the NBD Pro platform — a contractor you're coaching. Your job is to give them real, actionable advice the way you would standing in their driveway or on the phone. Plain language. No fluff. Honest. If something is a bad idea, say so. If they're leaving money on the table, tell them.

CURRENT MEMBER CONTEXT (live from their pipeline):
- Member name: ${ctx.name}
- Company: ${ctx.company}
- Total leads: ${ctx.totalLeads} | Active: ${ctx.activeLeads}
- Pipeline value: $${ctx.pipelineValue.toLocaleString()}
- Closed jobs, booked value (NOT collected money): $${ctx.closedRevenue.toLocaleString()}
- Revenue collected (actual payments received, all time): ${ctx.collectedRevenue == null ? 'not loaded' : '$' + ctx.collectedRevenue.toLocaleString()}
  (When the member asks about revenue, use COLLECTED money; booked value is projected.)
- Overdue follow-ups: ${ctx.overdueCount}
- Stage breakdown: ${ctx.stageBreakdown}
- Top leads by value: ${ctx.topLeads}
- Overdue follow-up names: ${ctx.overdueFollowUps}
- Tasks due today: ${ctx.tasksDueToday}
- Total estimates on file: ${ctx.totalEstimates}

USE THIS DATA. When they ask about their pipeline, leads, priorities, or follow-ups — reference the actual numbers above. Don't be generic.

RESPONSE STYLE:
- Talk like a contractor, not a consultant. Short sentences. Direct.
- Use bullet points when listing multiple things.
- Keep responses focused — 100-250 words unless they need something longer like a document.
- If they ask you to write something (supplement request, scope, letter to adjuster) — write the actual thing, not a template.
- Sign off with action items when appropriate.`;
}

function updateJoeContextBar(ctx) {
  const bar = document.getElementById('joeContextBar');
  if(!bar) return;
  if(ctx.totalLeads === 0 && ctx.totalEstimates === 0) { bar.style.display='none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    ⚡ LIVE CONTEXT: ${ctx.activeLeads} active leads · $${ctx.pipelineValue.toLocaleString()} pipeline
    ${ctx.overdueCount ? `· <span style="color:var(--red);">⚠ ${ctx.overdueCount} overdue</span>` : ''}
    ${ctx.tasksDueToday !== 'none' ? '· Tasks due today' : ''}
  `;
}

// ── Chat persistence ────────────────────────────────────────────────
function loadJoeChat() {
  try {
    const saved = sessionStorage.getItem(JOE_CHAT_STORE);
    if(saved) _joeMessages = JSON.parse(saved);
  } catch { _joeMessages = []; }
}
function saveJoeChat() {
  try {
    // Keep last 40 messages to avoid sessionStorage bloat
    const trimmed = _joeMessages.slice(-40);
    sessionStorage.setItem(JOE_CHAT_STORE, JSON.stringify(trimmed));
  } catch(e){}
}

// ── Init ────────────────────────────────────────────────────────────
function initJoeChat() {
  const noKey  = document.getElementById('joeNoKey');
  const msgs   = document.getElementById('joeMessages');
  const input  = document.getElementById('joeInputArea');
  if(!noKey || !msgs || !input) return;

  // Check for Cloud Function proxy OR stored key — show gate only if NEITHER available
  const _k = getJoeKey();
  const hasProxy = typeof window.callClaude === 'function';
  if (!_k && !hasProxy) {
    noKey.style.display='block'; msgs.style.display='none'; input.style.display='none';
    document.getElementById('joeContextBar').style.display='none';
    return;
  }
  noKey.style.display='none'; msgs.style.display='flex'; input.style.display='block';

  loadJoeChat();

  // NEW-D16: always reset the rendered transcript first so "New Chat"
  // (clearJoeChat) and key changes don't append a fresh greeting under the
  // old bubbles — initJoeChat fully repopulates the container below.
  msgs.innerHTML = '';

  if(_joeMessages.length === 0) {
    // Welcome message
    const ctx = buildJoeContext();
    const greeting = ctx.totalLeads > 0
      ? `Hey ${ctx.firstName} — I've got eyes on your pipeline. You've got ${ctx.activeLeads} active leads worth $${ctx.pipelineValue.toLocaleString()}${ctx.overdueCount ? `, and ${ctx.overdueCount} follow-up${ctx.overdueCount!==1?'s':''} that need attention today` : ''}. What do you want to work on?`
      : `Hey ${ctx.firstName} — Joe here. Looks like you're just getting started. Add your first lead in CRM and I can start giving you real advice based on your actual pipeline. In the meantime, ask me anything about running claims, canvassing, or closing jobs.`;
    appendJoeMessage('joe', greeting);
  } else {
    renderJoeMessages();
  }

  const ctx = buildJoeContext();
  updateJoeContextBar(ctx);
}

// ── Render ──────────────────────────────────────────────────────────
function renderJoeMessages() {
  const el = document.getElementById('joeMessages');
  if(!el) return;
  el.innerHTML = _joeMessages.map(m => buildJoeBubble(m.role, m.content)).join('');
  scrollJoeToBottom();
}

// HTML-escape helper — prevents XSS in chat messages.
// Both user input AND Claude API responses should be escaped
// before insertion into innerHTML. The markdown-style
// transformations below then re-introduce the whitelisted tags.
function _joeEscapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildJoeBubble(role, content) {
  // Escape FIRST, then apply markdown-style transformations.
  // This way any <script>, <img onerror>, or other HTML in the
  // content is rendered as plain text, but our own **bold**,
  // bullet lists, and newlines still become real tags.
  const escaped = _joeEscapeHtml(content || '');
  const formatted = escaped
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/^[•\-] (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>\s*)+/g, match => '<ul>'+match+'</ul>')
    .replace(/\n/g,'<br>');
  // Also escape the avatar — displayName comes from user settings
  // and could contain HTML.
  const avatarRaw = role==='joe' ? '🤠' : (window._userSettings?.displayName?.[0]||'J');
  const avatar = _joeEscapeHtml(avatarRaw);
  const safeRole = _joeEscapeHtml(role);
  return `<div class="joe-msg ${safeRole}">
    <div class="joe-msg-avatar">${avatar}</div>
    <div class="joe-bubble">${formatted}</div>
  </div>`;
}

function appendJoeMessage(role, content) {
  _joeMessages.push({role, content});
  const el = document.getElementById('joeMessages');
  if(el) {
    const div = document.createElement('div');
    div.innerHTML = buildJoeBubble(role, content);
    el.appendChild(div.firstChild);
    scrollJoeToBottom();
  }
  saveJoeChat();
}

function showJoeTyping() {
  const el = document.getElementById('joeMessages');
  if(!el) return;
  const div = document.createElement('div');
  div.className = 'joe-msg joe';
  div.id = 'joeTypingIndicator';
  div.innerHTML = `<div class="joe-msg-avatar">🤠</div><div class="joe-bubble"><div class="joe-typing"><span></span><span></span><span></span></div></div>`;
  el.appendChild(div);
  scrollJoeToBottom();
}

function hideJoeTyping() {
  document.getElementById('joeTypingIndicator')?.remove();
}

function scrollJoeToBottom() {
  const el = document.getElementById('joeMessages');
  if(el) setTimeout(()=>{ el.scrollTop = el.scrollHeight; }, 50);
}

// ── Send message ────────────────────────────────────────────────────
async function sendJoeMessage() {
  if(_joeTyping) return;
  const inp = document.getElementById('joeInput');
  const text = inp?.value?.trim();
  if(!text) return;

  inp.value = '';
  inp.style.height = '42px';

  appendJoeMessage('user', text);
  _joeTyping = true;
  var _jSB=document.getElementById("joeSendBtn");if(_jSB)_jSB.disabled=true;
  showJoeTyping();

  const ctx = buildJoeContext();
  const systemPrompt = buildJoeSystemPrompt(ctx);

  // Build message history for API (last 20 turns for context window)
  const apiMessages = _joeMessages.slice(-20).map(m=>({
    role: m.role === 'joe' ? 'assistant' : 'user',
    content: m.content
  }));

  try {
    // Use callClaude proxy (Cloud Function → fallback to localStorage key)
    if (!window.callClaude) {
      // Proxy not loaded yet — check for direct key as last resort
      const _joeApiKey = getJoeKey();
      if (!_joeApiKey) {
        hideJoeTyping();
        appendJoeMessage('joe', '⚙️ To activate Joe AI, add your Anthropic API key in **Settings → Ask Joe AI**. Get a free key at console.anthropic.com — it takes 2 minutes.');
        _joeTyping = false;
        var _jSB=document.getElementById("joeSendBtn");if(_jSB)_jSB.disabled=false;
        return;
      }
    }

    const data = await window.callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: apiMessages
    });

    const reply = data?.content?.[0]?.text || 'Sorry, something went wrong. Try again.';

    hideJoeTyping();
    appendJoeMessage('joe', reply);

  } catch(err) {
    hideJoeTyping();
    const errMsg = `Couldn't reach Joe right now. ${err.message || 'Check your connection and try again.'}`;
    appendJoeMessage('joe', errMsg);
  }

  _joeTyping = false;
  var _jSB=document.getElementById("joeSendBtn");if(_jSB)_jSB.disabled=false;
  updateJoeContextBar(ctx);
}

function joeQuick(msg) {
  const inp = document.getElementById('joeInput');
  if(inp) inp.value = msg;
  sendJoeMessage();
}

// Hook into goTo to init chat when tab opens. The previous version
// redefined window.goTo with a single-arg signature, which dropped
// the `params` object that admin-manager.js's wrapper passes through.
// Now we forward `arguments` verbatim so any caller's signature works.
(function(){
  function install() {
    const _prev = window.goTo;
    if (typeof _prev !== 'function') { setTimeout(install, 200); return; }
    window.goTo = function() {
      const result = _prev.apply(this, arguments);
      if (arguments[0] === 'joe') setTimeout(initJoeChat, 80);
      return result;
    };
  }
  install();
})();


// Clear chat history from current session
function clearJoeChat() {
  try { sessionStorage.removeItem(JOE_CHAT_STORE); } catch(e){}
  _joeMessages = [];
  initJoeChat();
  showToast('Chat cleared', 'success');
}

// Expose all AI functions to window scope (required for onclick handlers)
window.clearJoeKey = clearJoeKey;
window.clearJoeChat = clearJoeChat;
window.getJoeKey = getJoeKey;
window.initJoeChat = initJoeChat;
window.sendJoeMessage = sendJoeMessage;
window.joeQuick = joeQuick;
// ══ END ASK JOE AI ════════════════════════════════════════════════════
