// ══════════════════════════════════════════════════════════
// DATA
//
// April 2026: the hardcoded S1-S12 demo sessions from the NBD Pro
// site-build process have been removed. They were shipped as static
// HTML-embedded data so every user saw the same 12 sessions — not
// a security leak (nothing was read from another user's Firestore),
// but confusing because it looked like someone else's history was
// showing up under your account.
//
// The page now starts with an empty session list. User-logged
// sessions persist via window.storage → localStorage on the user's
// own device only. Nothing in this file touches Firestore.
// ══════════════════════════════════════════════════════════
let codex = {
  version:'v13.0', totalSessions:0, lastSession:null,
  tasks:[],
  sessions:[],
  directives:[]
};

let taskFilter='all', sessionFilter='all';

// ── STORAGE ADAPTER ──
// Wire window.storage to localStorage so save/load actually persist
window.storage = {
  async set(key, value) { localStorage.setItem(key, value); },
  async get(key) { const v = localStorage.getItem(key); return v ? { value: v } : null; },
  async remove(key) { localStorage.removeItem(key); }
};

// ── STORAGE ──
async function save(){try{await window.storage.set('nbd-codex-v2',JSON.stringify({tasks:codex.tasks,totalSessions:codex.totalSessions,lastSession:codex.lastSession,version:codex.version,sessions:codex.sessions.filter(s=>s.source==='original'||s.num>=10),directives:codex.directives}))}catch(e){console.warn('[codex] save failed:',e&&e.message);toast('Couldn\'t save. Your browser storage may be full.','red')}} // CRM audit 2026-11-06 (VW-F109)
async function load(){
  try{
    const r=await window.storage.get('nbd-codex-v2');
    if(!r)return;
    const s=JSON.parse(r.value);
    // Merge done-states into base tasks
    if(s.tasks){s.tasks.forEach(st=>{const t=codex.tasks.find(t=>t.id===st.id);if(t)t.done=st.done;else if(st.source!=='base')codex.tasks.push(st)})}
    // Add any user-logged sessions (num > 11)
    if(s.sessions){s.sessions.filter(ss=>ss.num>11).forEach(ss=>{if(!codex.sessions.find(x=>x.id===ss.id))codex.sessions.unshift(ss)})}
    if(s.version&&s.totalSessions>codex.totalSessions){codex.version=s.version;codex.totalSessions=s.totalSessions;codex.lastSession=s.lastSession}
    if(s.directives)codex.directives=s.directives;
  }catch(e){console.warn('[codex] load failed:',e&&e.message);toast('Saved progress couldn\'t be read. Showing the built-in list.','red')} // CRM audit 2026-11-06 (VW-F109)
}

function uid(){return Math.random().toString(36).slice(2,9)}
function g(id){return document.getElementById(id)}
function set(id,v){const e=g(id);if(e)e.textContent=v}

// ── NAVIGATION ──
function navTo(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const pg=g('page-'+page);if(pg)pg.classList.add('active');
  document.querySelectorAll(`[data-page="${page}"]`).forEach(n=>n.classList.add('active'));
  window.scrollTo(0,0);
  g('mainContent').scrollTo(0,0);
  if(page==='tasks')renderTasks();
  if(page==='sessions')renderSessions();
  if(page==='export')buildExportPreview();
  closeMobileNav();
}

// ── CSP-SAFE DELEGATE ──
// Replaces inline event-handler attributes (blocked by `script-src-attr 'none'`).
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tf-action]');
  if (!t) return;
  const action = t.getAttribute('data-tf-action');
  const arg = t.getAttribute('data-arg');
  const noArg = {
    nbdNavToggle, toggleMobileNav, closeMobileNav, openGuide, closeGuide,
    openNewSession, toggleTaskForm, saveTask, expandAllSessions,
    collapseAllSessions, closeNewSession, saveSession, openAddDirective,
    closeAddDirective, saveDirective, exportMarkdown, exportText, copyExport,
  };
  if (action === 'navTo') {
    if (t.tagName === 'A') e.preventDefault();
    navTo(arg);
  } else if (action === 'navToThenOpenNewSession') {
    navTo('sessions');
    setTimeout(() => openNewSession(), 100);
  } else if (action === 'filterTasks') {
    filterTasks(arg, t);
  } else if (action === 'filterSessions') {
    filterSessions(arg, t);
  } else if (action === 'toggleTask') {
    toggleTask(arg);
  } else if (action === 'deleteTask') {
    deleteTask(arg);
  } else if (action === 'toggleSession') {
    toggleSession(arg);
  } else if (action === 'closeGuideOnBg') {
    if (e.target === t) closeGuide();
  } else if (noArg[action]) {
    noArg[action]();
  }
});

// ── TOAST ──
// 2026-07-19 consolidation: delegates to the shared /pro/js/toast.js module
// (dashboard contract, loaded by ai-tool-finder.html before this script).
// Legacy local types map through: green→success, red→error, blue→info.
// Also fixes the stored-XSS bug here — the old builder interpolated ${msg}
// into innerHTML; the shared module renders messages via textContent only.
function toast(msg,type=''){
  window.showToast(msg,{green:'success',red:'error',blue:'info'}[type]||'info');
}

// ── HEADER ──
function updateHeader(){
  set('versionChip',codex.version);
  set('sessionChip','S'+codex.totalSessions);
  set('lastUpdated','Last updated: S'+codex.totalSessions+' · '+codex.lastSession);
  updateDebtCounts();
}

function updateDebtCounts(){
  const crit=codex.tasks.filter(t=>t.priority==='critical'&&!t.done).length;
  const high=codex.tasks.filter(t=>t.priority==='high'&&!t.done).length;
  const med=codex.tasks.filter(t=>t.priority==='med'&&!t.done).length;
  const done=codex.tasks.filter(t=>t.done).length;
  set('sCritical',crit);set('sHigh',high);set('sMed',med);set('sDone',done);
  set('tCrit',crit);set('tHigh',high);set('tMed',med);set('tDone',done);
  // task badge in nav
  const badge=g('taskBadge');
  const openCrit=codex.tasks.filter(t=>t.priority==='critical'&&!t.done).length;
  if(badge){badge.textContent=openCrit;badge.style.display=openCrit>0?'':'none'}
  set('taskMeta',codex.tasks.length+' tasks · '+done+' closed');
}

// ── TASKS ──
function renderTasks(){
  const grid=g('taskGrid');if(!grid)return;
  let list=[...codex.tasks];
  if(taskFilter==='critical')list=list.filter(t=>t.priority==='critical'&&!t.done);
  else if(taskFilter==='high')list=list.filter(t=>t.priority==='high'&&!t.done);
  else if(taskFilter==='open')list=list.filter(t=>!t.done);
  else if(taskFilter==='done')list=list.filter(t=>t.done);
  list.sort((a,b)=>{if(a.done!==b.done)return a.done?1:-1;const o={critical:0,high:1,med:2};return(o[a.priority]||2)-(o[b.priority]||2)});
  grid.innerHTML=list.map(t=>`
    <div class="task-row${t.done?' done':''}" id="tr-${t.id}">
      <div class="task-check" data-tf-action="toggleTask" data-arg="${t.id}">${t.done?'✓':''}</div>
      <div>
        <div class="task-name">${t.task}</div>
        ${t.time?`<div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--text3);margin-top:2px">Est: ${t.time}</div>`:''}
      </div>
      <div class="task-time">${t.origin||'—'}</div>
      <div class="p-dot ${t.priority}"></div>
      <button class="btn btn-red btn-xs" data-tf-action="deleteTask" data-arg="${t.id}">✕</button>
    </div>`).join('')||'<div style="text-align:center;padding:32px;color:var(--text3);font-family:\'Syne Mono\',monospace;font-size:11px">No tasks match this filter</div>';
  updateDebtCounts();
}

function filterTasks(f,btn){
  taskFilter=f;
  document.querySelectorAll('#page-tasks .filter-btn').forEach(b=>b.classList.remove('on'));
  if(btn)btn.classList.add('on');
  renderTasks();
}

function toggleTask(id){
  const t=codex.tasks.find(t=>t.id===id);if(!t)return;
  t.done=!t.done;save();renderTasks();
  toast(t.done?'✓ Task closed':'Task reopened',t.done?'green':'');
}

function deleteTask(id){
  codex.tasks=codex.tasks.filter(t=>t.id!==id);
  save();renderTasks();toast('Task removed','');
}

function toggleTaskForm(){
  const f=g('taskForm');f.classList.toggle('open');
  if(f.classList.contains('open'))g('ntTask').focus();
}

function saveTask(){
  const task=g('ntTask').value.trim();
  if(!task){toast('Task description required','red');return}
  codex.tasks.push({id:uid(),task,priority:g('ntPriority').value,origin:g('ntOrigin').value.trim()||'S'+codex.totalSessions,time:g('ntTime').value.trim(),done:false});
  save();renderTasks();
  g('ntTask').value='';g('ntOrigin').value='';g('ntTime').value='';
  g('taskForm').classList.remove('open');
  toast('Task added','green');
}

// ── SESSIONS ──
function renderSessions(){
  const list=g('sessionList');if(!list)return;
  let sessions=[...codex.sessions];
  if(sessionFilter==='original')sessions=sessions.filter(s=>s.source==='original');
  else if(sessionFilter==='reconstructed')sessions=sessions.filter(s=>s.source==='reconstructed');
  list.innerHTML=sessions.map(s=>buildSessionCard(s)).join('');
}

function filterSessions(f,btn){
  sessionFilter=f;
  document.querySelectorAll('#page-sessions .filter-btn').forEach(b=>b.classList.remove('on'));
  if(btn)btn.classList.add('on');
  renderSessions();
}

function buildSessionCard(s){
  const outputs=s.output?s.output.split('\n').filter(Boolean):[];
  const decisions=s.keyDecisions?s.keyDecisions.split('\n').filter(Boolean):[];
  const files=s.filesProduced?s.filesProduced.split('\n').filter(Boolean):[];
  const loops=s.loops?s.loops.split('\n').filter(Boolean):[];
  return`<div class="session-card" id="sc-${s.id}">
    <button class="session-trigger" data-tf-action="toggleSession" data-arg="${s.id}">
      <div class="session-num">S${s.num}</div>
      <div class="session-info">
        <div class="session-title">"${s.title}"</div>
        <div class="session-meta">
          <span class="session-date">${s.date}</span>
          <span class="session-badge ${s.source}">${s.source==='original'?'ORIGINAL LOG':'RECONSTRUCTED'}</span>
        </div>
      </div>
      <div class="session-chev">▼</div>
    </button>
    <div class="session-body">
      ${s.summary?`<div style="font-size:16px;color:var(--text);line-height:1.7;padding:12px 16px;background:var(--lift);border-radius:var(--r);border-left:2px solid var(--orange);margin-bottom:4px">${s.summary}</div>`:''}
      ${s.input?`<div class="slabel">📥 Input Vector</div><div class="stext">${s.input}</div>`:''}
      ${outputs.length?`<div class="slabel">📤 Output Vector</div><ul class="sbullets">${outputs.map(o=>`<li>${o}</li>`).join('')}</ul>`:''}
      ${s.delta?`<div class="slabel">⚡ Delta Log</div><div class="smono">${s.delta}</div>`:''}
      ${decisions.length?`<div class="slabel">🔒 Key Decisions</div><ul class="sbullets">${decisions.map(d=>`<li>${d}</li>`).join('')}</ul>`:''}
      ${files.length?`<div class="slabel">📁 Files Produced</div><div class="sfiles">${files.map(f=>`<span class="sfile-chip">${f}</span>`).join('')}</div>`:''}
      ${loops.length?`<div class="slabel">🔁 Open Loops Carried Forward</div>${loops.map(l=>`<div class="sloop"><div class="sloop-dot"></div><span>${l}</span></div>`).join('')}`:''}
      ${s.source==='reconstructed'?`<div class="recon-note">ℹ This session was reconstructed from Codex v10.0 directives, task registry origins, architecture evolution, and non-negotiable timestamps. The session happened — the exact words are inferred from the evidence it left behind. Original session logs for S1–S9 were not included in the v10.0 export.</div>`:''}
    </div>
  </div>`;
}

function toggleSession(id){
  const el=g('sc-'+id);if(el)el.classList.toggle('open');
}

function expandAllSessions(){document.querySelectorAll('.session-card').forEach(e=>e.classList.add('open'))}
function collapseAllSessions(){document.querySelectorAll('.session-card').forEach(e=>e.classList.remove('open'))}

function openNewSession(){
  const f=g('sessionForm');f.classList.add('open');
  const now=new Date();g('nsDate').value=now.toISOString().slice(0,16);
  g('nsTitle').focus();
  f.scrollIntoView({behavior:'smooth',block:'start'});
}

function closeNewSession(){
  g('sessionForm').classList.remove('open');
}

function saveSession(){
  const title=g('nsTitle').value.trim();
  if(!title){toast('Session title required','red');return}
  const newNum=codex.totalSessions+1;
  const entry={
    id:'s'+newNum, num:newNum, title,
    date:g('nsDate').value?new Date(g('nsDate').value).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}):new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}),
    summary:g('nsSummary').value.trim(),
    input:g('nsInput').value.trim(),
    output:g('nsOutput').value.trim(),
    delta:g('nsDelta').value.trim(),
    keyDecisions:g('nsDecisions').value.trim(),
    filesProduced:g('nsFiles').value.trim(),
    loops:g('nsLoops').value.trim(),
    source:'original'
  };
  codex.sessions.unshift(entry);
  codex.totalSessions=newNum;
  codex.lastSession=new Date().toISOString().split('T')[0];
  const vp=codex.version.replace('v','').split('.');vp[0]=String(parseInt(vp[0])+1);codex.version='v'+vp.join('.');
  save();updateHeader();renderSessions();
  ['nsTitle','nsInput','nsOutput','nsDelta','nsLoops','nsSummary','nsDecisions','nsFiles'].forEach(id=>{const el=g(id);if(el)el.value=''});
  closeNewSession();
  toast('Session S'+newNum+' logged · Codex '+codex.version,'green');
}

// ── DIRECTIVES ──
function openAddDirective(){g('directiveForm').classList.add('open');g('newDirectiveText').focus()}
function closeAddDirective(){g('directiveForm').classList.remove('open')}

function saveDirective(){
  const text=g('newDirectiveText').value.trim();
  if(!text){toast('Directive text required','red');return}
  const session='S'+codex.totalSessions;
  if(!codex.directives)codex.directives=[];
  codex.directives.push({session,text,date:new Date().toISOString()});
  save();
  const div=document.createElement('div');
  div.className='directive-row';
  div.innerHTML=`<div class="d-session" style="color:var(--orange)">${session}</div><div class="d-text"><strong>${text}</strong></div>`;
  g('directiveList').appendChild(div);
  g('newDirectiveText').value='';
  closeAddDirective();
  toast('Directive added · '+session,'green');
}

// ── EXPORT ──
function buildExportContent(version){
  const v=version||codex.version;
  const now=new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const openTasks=codex.tasks.filter(t=>!t.done);
  const doneTasks=codex.tasks.filter(t=>t.done);
  return`ETERNAL-CODEX-EXPORT-${v}
AI SELECTION CODEX – NBD PRO
Version: ${v} | Last Session: ${codex.lastSession} | Total Sessions: ${codex.totalSessions}
Generated: ${now}

${'━'.repeat(60)}

0. LIVING EXECUTIVE SYNTHESIS
Sessions complete: ${codex.totalSessions} | Open critical tasks: ${codex.tasks.filter(t=>t.priority==='critical'&&!t.done).length}

Session ${codex.totalSessions+1} Mission (locked):
1. Commit ds-final-deploy + crm-final-deploy to GitHub — 4 min, do first
2. Wire Stripe — Payment Links + .plan Firestore write. Full stop.
3. Build Understanding Tool per 40-question spec
4. Deploy AI Selection Codex + AI Usability Tree to /pro

${'━'.repeat(60)}

1. PROJECT DNA (immutable)
Core Vision: "Make massive success feel like no big deal."
GitHub: https://github.com/jdealtia-sys/nobigdealwithjoedeal.com

Key Paths:
- Daily Success: pro/daily-success/index.html
- CRM/Dashboard: pro/dashboard.html
- Visualizer: visualizer.html
- Main: index.html

Four Pillars:
1. Authority Blueprint — 35-page gated blueprint + 12-section masterclass
2. Daily Momentum Engine — Daily Success tracker + streaks + leaderboards
3. CRM OS — Dual pipeline, AI nudge, storm intel
4. Homeowner Conversion Engine — AI visualizer → inbound leads → CRM

Architecture:
- nbdApplyTheme(id) — SINGLE SOURCE OF TRUTH. Never bypass.
- 100 v5 themes (body.theme-{id}) + 176 v3 themes (:root[data-theme]) — permanently bridged
- Stripe: live — billing and plan gating are enforced server-side

${'━'.repeat(60)}

2. CHRONOLOGICAL MASTER LOG (append-only)

${codex.sessions.map(s=>`Session ${s.num} — ${s.date} — "${s.title}"
Input: ${s.input||'—'}
Output:
${s.output?s.output.split('\n').filter(Boolean).map(l=>'  - '+l).join('\n'):'  —'}
Delta: ${s.delta||'—'}
Key Decisions: ${s.keyDecisions||'—'}
Files: ${s.filesProduced||'—'}
Open Loops:
${s.loops?s.loops.split('\n').filter(Boolean).map(l=>'  □ '+l).join('\n'):'  —'}
`).join('\n')}

${'━'.repeat(60)}

4. MASTER TASK REGISTRY

OPEN:
${openTasks.map((t,i)=>`${i+1}. [${t.priority.toUpperCase()}] ${t.task} | ${t.origin} | Est: ${t.time||'—'}`).join('\n')}

${doneTasks.length?'CLOSED:\n'+doneTasks.map((t,i)=>`${i+1}. ✓ ${t.task}`).join('\n'):''}

${'━'.repeat(60)}

6. META-CODEX DIRECTIVES (enforced forever)
- Append-only Section 2
- Section 0 rewritten each session — higher altitude only
- S3: Wiring Phase Doctrine standing
- S4: Architecture decisions binding until explicitly revised
- S5: "Never lose a job" — standing CRM constraint
- S6: crm-leads.js — single source of truth for lead/job Firestore ops
- S6: Visualizer is the fourth pillar
- S7: nbdApplyTheme() is the single point of theme write — never bypass
- S7: Light theme CSS audit mandatory before launch
- S7: Stripe is the standing blocker for plan-gating reality
- S8: Close before opening — 2+ session open loops must close first
- S9: GitHub repo fixed — never ask again
- S9: 176-theme v3 library canonical — do not revert
- S10: nbdApplyTheme() governs ALL theme state — no parallel paths
- S10: CRM file path is pro/dashboard.html — not pro/crm/index.html
- S10: v5 and v3 permanently bridged — maintain bridge, never remove
- S${codex.totalSessions}: Stripe ships in S${codex.totalSessions+1}. No exceptions.
${codex.directives&&codex.directives.length?codex.directives.map(d=>`- ${d.session}: ${d.text}`).join('\n'):''}

${'━'.repeat(60)}
END OF CODEX ${v}
Generated by AI Selection Codex · nobigdealwithjoedeal.com/pro`;
}

function buildExportPreview(){
  const version=g('exportVersion')?.value||codex.version;
  const preview=buildExportContent(version);
  const el=g('exportPreview');if(el)el.textContent=preview;
}

function exportMarkdown(){
  const version=g('exportVersion')?.value||codex.version;
  const blob=new Blob([buildExportContent(version)],{type:'text/markdown'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=`CODEX-EXPORT-${version}.md`;a.click();
  toast('Codex exported as '+version,'green');
}

function exportText(){
  const version=g('exportVersion')?.value||codex.version;
  const blob=new Blob([buildExportContent(version)],{type:'text/plain'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download=`CODEX-EXPORT-${version}.txt`;a.click();
  toast('Codex exported as plain text','green');
}

function copyExport(){
  const version=g('exportVersion')?.value||codex.version;
  navigator.clipboard.writeText(buildExportContent(version)).then(()=>toast('Codex copied to clipboard','green'));
}

// ── GUIDE MODAL ──
function openGuide(){g('guideModal').classList.add('open')}
function closeGuide(){g('guideModal').classList.remove('open')}
function closeGuideOnBg(e){if(e.target===g('guideModal'))closeGuide()}

// ── MOBILE NAV ──
function buildMobileNav(){
  const nav=g('mobileSidebarNav');if(!nav)return;
  nav.innerHTML=g('sidebarNav').innerHTML;
  nav.querySelectorAll('.nav-item').forEach(btn=>{
    const page=btn.getAttribute('data-page');
    if(page){btn.addEventListener('click',()=>{navTo(page);closeMobileNav()})}
  });
  const addBtn=nav.querySelector('.btn-gold');
  if(addBtn){addBtn.addEventListener('click',()=>{navTo('sessions');setTimeout(()=>openNewSession(),100);closeMobileNav()})}
}

function toggleMobileNav(){
  g('mobileSidebar').classList.toggle('open');
  g('mobileNavOverlay').classList.toggle('open');
}

function closeMobileNav(){
  g('mobileSidebar').classList.remove('open');
  g('mobileNavOverlay').classList.remove('open');
}

// ── INIT ──
async function init(){
  await load();
  updateHeader();
  renderSessions();
  buildMobileNav();
  // start on synthesis
  navTo('synthesis');
  setTimeout(()=>toast('AI Selection Codex · '+codex.version+' · '+codex.totalSessions+' sessions','blue'),800);
}
init();

// ── CSP-safe data-aif-action input delegate ──
// Replaces inline oninput attrs that the strict CSP at firebase.json:44
// silently blocks (script-src-attr 'none').
(function () {
  if (window._NBD_AIF_INPUT_DELEGATE_BOUND) return;
  window._NBD_AIF_INPUT_DELEGATE_BOUND = true;
  document.addEventListener('input', function (ev) {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-aif-action]');
    if (!t) return;
    const fn = window[t.dataset.aifAction];
    if (typeof fn === 'function') { try { fn(); } catch (e) { console.error('[aif] dispatch failed:', e); } }
  });
})();
