// ============================================================
// NBD Pro — tasks.js
// Task system: load, save, toggle, delete, render, modal
// Extracted from dashboard.html
// ============================================================
let _NBD_TK_DELEGATE; // module-local (globals Tranche 1 — was window.*)
// textContent→innerHTML escapes & < > but not quotes, and several callers
// drop the result into a double-quoted data-tk-id="…" attribute.
function _escTask(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML.replace(/"/g,'&quot;');}

// ══ Module State ══════════════════════════════════════════
// Use var to avoid redeclaration collision with dashboard.html inline script
var _taskModalLeadId = _taskModalLeadId || null;
const _overdueNotifiedLocal = new Set(); // local dedup guard for overdue notifications

// ══ Notification Helper ══════════════════════════════════
// Routes through window.shouldFireNotif() so the user's settings
// (Critical/Digest/Firehose mode + per-trigger toggles + per-channel
// toggles) gate every fire. If shouldFireNotif isn't loaded yet (rare
// boot race) we fire-open so the user doesn't miss a task overdue.
async function createNotification(userId, type, title, message, leadId, priority) {
  const pr = priority || 'high'; // task overdue / follow-ups default to high
  const shouldFire = typeof window.shouldFireNotif === 'function'
    ? window.shouldFireNotif
    : function () { return true; };

  // Browser-push channel (the OS-level Notification API). If the user
  // disabled the push channel — or the type's trigger — skip silently.
  const pushAllowed = shouldFire(type, 'push', pr);
  const inAppAllowed = shouldFire(type, 'inApp', pr);

  // Fallback to toast if browser Notification API not available
  if (!('Notification' in window)) {
    if (inAppAllowed) showToast(message, 'info');
    return;
  }

  // If push is disabled but in-app is allowed, just toast.
  if (!pushAllowed) {
    if (inAppAllowed) showToast(message, 'info');
    return;
  }

  // Request permission on first use if not already granted
  if (Notification.permission === 'default') {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        if (inAppAllowed) showToast(message, 'info');
        return;
      }
    } catch (e) {
      if (inAppAllowed) showToast(message, 'info');
      return;
    }
  }

  // Only show notification if permission was granted
  if (Notification.permission !== 'granted') {
    if (inAppAllowed) showToast(message, 'info');
    return;
  }

  // Show browser notification
  try {
    const notif = new Notification(title, {
      body: message,
      icon: '/icon-logo.png',
      badge: '/icon-badge.png',
      tag: `task-${leadId}`,
      requireInteraction: false
    });

    // Click notification to open lead
    if (leadId) {
      notif.addEventListener('click', () => {
        window.focus();
        window.location.href = `/pro/dashboard.html?tab=crm&lead=${leadId}`;
      });
    }
  } catch (e) {
    // Fallback to toast (still gated by inApp channel)
    if (inAppAllowed) showToast(message, 'info');
  }
}

// Leads whose last read came from the LOCAL cache, not the server. getDocs
// answers from cache without an error while the connection is being cycled
// (boot pre-flight, the visibility handler's "tab returned to foreground"
// cycle): every lead read 0 tasks fromCache=true on the emulator, the boot
// pass never ran again, and overdue tasks were missing from the bell, the
// Today list and the overdue notification until a full reload (CRM sweep R13,
// 2026-09-28). loadAllTasks re-reads these once the connection is back.
const _tasksFromCache = new Set();
async function _loadTasks(leadId) {
  if (!window._taskCache) window._taskCache = {};
  try {
    const snap = await getDocs(query(collection(db,'leads',leadId,'tasks'), orderBy('createdAt','asc')));
    const tasks = snap.docs.map(d=>({id:d.id,...d.data()}));
    window._taskCache[leadId] = tasks;
    if (snap.metadata && snap.metadata.fromCache) _tasksFromCache.add(leadId);
    else _tasksFromCache.delete(leadId);
    return tasks;
  } catch(e){ return window._taskCache[leadId]||[]; }
}
// Owner stamps (2026-10-03): the ONE task load is a collection-group query
// scoped by userId / companyId, so a task carries its lead's owner + tenant
// (the rules accept only those values; functions/tasks-stamp.js fills them
// for every other writer).
function _taskStamps(leadId) {
  const lead = (window._leads||[]).find(l=>l&&l.id===leadId);
  const out = { leadId };
  const uid = (window._user&&window._user.uid) || (typeof auth!=='undefined'&&auth&&auth.currentUser&&auth.currentUser.uid) || null;
  const owner = (lead&&lead.userId) || uid;
  if (owner) out.userId = owner;
  if (lead&&lead.companyId) out.companyId = lead.companyId;
  return out;
}
async function _saveTask(leadId, text, dueDate) {
  try {
    const ref = await addDoc(collection(db,'leads',leadId,'tasks'),Object.assign(_taskStamps(leadId),{text:text.trim(),done:false,dueDate:dueDate||'',createdAt:serverTimestamp()}));
    return ref.id;
  } catch(e){ return null; }
}
// These two report saved/failed instead of swallowing into console.error.
// Every caller flips the checkbox optimistically before awaiting, and on a
// roof there is no console to read — a write that died on one bar of signal
// looked exactly like one that landed, so the task came back tomorrow with
// no explanation. A boolean (matching _saveTask's null-on-failure idiom)
// keeps the call sites one-liners; the console.error stays for desktop.
async function _toggleTask(leadId, taskId, done) {
  try {
    await updateDoc(doc(db,'leads',leadId,'tasks',taskId), {
      done,
      completedAt: done ? serverTimestamp() : null
    });
    return true;
  } catch(e){ console.error('toggleTask error:', e); return false; }
}
async function _deleteTask(leadId, taskId) {
  try { await deleteDoc(doc(db,'leads',leadId,'tasks',taskId)); return true; }
  catch(e){ console.error('deleteTask error:', e); return false; }
}
let _taskCacheRetries = 0;
const _TASK_CACHE_RETRY_MS = 2500, _TASK_CACHE_MAX_RETRIES = 4;
// ══ The ONE task load (2026-10-03, Today home) ═══════════════
// Every task the signed-in user can see, in ONE collection-group query —
// NBDTodayPlan.tasksQuery (today-plan.js): the tenant for company staff, the
// owner otherwise, oldest first; its composite index is in
// firestore.indexes.json and tests/today-plan-2026-10-03.test.js ties the
// two. It replaced one query per lead (~234 at boot) that also RACED the
// lead load: it ran once at load+1.8 s over whatever _leads held then, so a
// cold boot could paint "All caught up" over overdue tasks. The boot load now
// waits for the leads (_leadsLoaded + the nbd:data-refreshed {source:'leads'}
// event the lead load fires). The bell, the Today list, the task panel, the
// card badges and No-next-step all read the _taskCache this one load fills.
// If the collection-group read is refused (rules / index not deployed yet)
// the per-lead read below takes over for the session.
const _FS_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
let _taskLoadMode = 'group';
let _tasksLoaded = false;
async function _loadAllTasksGroup() {
  const plan = window.NBDTodayPlan;
  const uid = (window._user&&window._user.uid) || (typeof auth!=='undefined'&&auth&&auth.currentUser&&auth.currentUser.uid) || null;
  const spec = plan && plan.tasksQuery(window._userClaims||{}, uid);
  if (!spec) return null;
  const cg = window.collectionGroup || (await import(_FS_SDK)).collectionGroup;
  const snap = await getDocs(query(cg(db, spec.group), where(spec.field, '==', spec.value), orderBy(spec.orderBy, spec.dir)));
  const by = plan.groupTasksByLead(snap.docs.map(d=>({ id: d.id, parentPath: d.ref && d.ref.parent ? d.ref.parent.path : '', data: d.data() })));
  return { by, fromCache: !!(snap.metadata && snap.metadata.fromCache) };
}
async function loadAllTasks(opts) {
  const retry = !!(opts && opts.retry);
  if (!retry) _taskCacheRetries = 0;
  let fromCache = false;
  if (_taskLoadMode === 'group') {
    try {
      const r = await _loadAllTasksGroup();
      if (r) {
        const next = {};
        (window._leads||[]).forEach(l=>{ if (l && l.id) next[l.id] = []; });
        Object.keys(r.by).forEach(k=>{ next[k] = r.by[k]; });
        window._taskCache = next;
        fromCache = r.fromCache;
      } else _taskLoadMode = 'per-lead';
    } catch (e) {
      console.warn('[tasks] one-query load refused — per-lead fallback:', e && (e.code || e.message));
      _taskLoadMode = 'per-lead';
    }
  }
  if (_taskLoadMode === 'per-lead') {
    // A retry re-reads only the leads whose last read came from cache.
    const ids = retry ? Array.from(_tasksFromCache) : (window._leads||[]).map(l=>l.id);
    // Use allSettled so a single lead's failure doesn't block the rest
    await Promise.allSettled(ids.map(id=>_loadTasks(id)));
    fromCache = _tasksFromCache.size > 0;
  }
  _tasksLoaded = true;
  renderTodayTasks();
  renderLeads(window._leads, window._filteredLeads);
  // Wave 13: tell the notification bell tasks just refreshed.
  try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'tasks' } })); } catch (_) {}
  // A read served from the local cache is re-read from the server shortly
  // (bounded: a genuinely offline rep keeps the cached tasks, which are the
  // best available, and the retries stop).
  if (fromCache && _taskCacheRetries < _TASK_CACHE_MAX_RETRIES) {
    _taskCacheRetries++;
    setTimeout(() => { loadAllTasks({ retry: true }); }, _TASK_CACHE_RETRY_MS);
  }
}
// Boot: once the lead book is in (and again if the account changes); a lead
// refresh after that only repaints from the cache.
let _taskBootUid = null;
function _bootTasks() {
  if (window._leadsLoaded !== true) return;
  const uid = (window._user&&window._user.uid) || null;
  if (_taskBootUid !== null && _taskBootUid === uid) { renderTodayTasks(); return; }
  _taskBootUid = uid;
  loadAllTasks();
}
// Today rows act on tasks through these (today-home.js).
function _cachedTask(leadId, taskId) { return ((window._taskCache||{})[leadId]||[]).find(t=>t.id===taskId) || null; }
async function _setTaskDone(leadId, taskId) {
  const t = _cachedTask(leadId, taskId); const prev = t ? t.done : undefined;
  if (t) t.done = true;
  const ok = await _toggleTask(leadId, taskId, true);
  if (!ok && t) t.done = prev;
  renderTodayTasks();
  try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'tasks' } })); } catch (_) {}
  return ok;
}
async function _setTaskDue(leadId, taskId, ymd) {
  const t = _cachedTask(leadId, taskId); const prev = t ? t.dueDate : undefined;
  if (t) t.dueDate = ymd;
  try { await updateDoc(doc(db,'leads',leadId,'tasks',taskId), { dueDate: ymd }); }
  catch (e) { if (t) t.dueDate = prev; console.error('setTaskDue error:', e); return false; }
  renderTodayTasks();
  try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'tasks' } })); } catch (_) {}
  return true;
}
window.NBDTasks = { loaded: () => _tasksLoaded, reload: loadAllTasks, setDone: _setTaskDone, setDue: _setTaskDue };
function renderTodayTasks() {
  const el = document.getElementById('todayTasksList');
  if(!el) return;
  const now = new Date();
  const eod = new Date(); eod.setHours(23,59,59,999);
  const sod = new Date(); sod.setHours(0,0,0,0);
  const items = [];
  if (!window._taskCache) window._taskCache = {};
  (window._leads||[]).forEach(lead=>{
    ((window._taskCache||{})[lead.id]||[]).forEach(t=>{
      if(t.done) return;
      const due = t.dueDate ? new Date(t.dueDate+'T23:59:59') : null;
      if(!due||due>eod) return;
      
      // Create notification for newly overdue tasks (deduplicated per session + Firestore flag)
      const notifKey = lead.id + '_' + t.id;
      if(due<sod && !t.overdueNotified && !_overdueNotifiedLocal.has(notifKey) && auth.currentUser) {
        _overdueNotifiedLocal.add(notifKey); // prevent re-fire within this session
        createNotification(
          auth.currentUser.uid,
          'task_overdue',
          'Task Overdue',
          `"${t.text}" for ${((lead.firstName||'')+' '+(lead.lastName||'')).trim()||lead.address}`,
          lead.id
        ).then(() => {
          // Mark as notified in Firestore to prevent cross-session duplicates
          updateDoc(doc(db,'leads',lead.id,'tasks',t.id), {overdueNotified: true}).catch(e=>{});
        });
      }
      
      items.push({task:t,lead,leadName:((lead.firstName||'')+' '+(lead.lastName||'')).trim()||lead.address||'Lead',isOverdue:due<sod,due});
    });
  });
  if(!items.length){el.innerHTML='<div class="empty"><div class="empty-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;vertical-align:middle;"><circle cx="10" cy="10" r="7"/><path d="M7 10l2 2 4-5"/></svg></div><div class="empty-title">All Caught Up</div><div class="empty-sub">No tasks due today. Nice work.</div></div>';return;}
  items.sort((a,b)=>(b.isOverdue-a.isOverdue)||(a.due-b.due));
  el.innerHTML=items.slice(0,8).map(({task,lead,leadName,isOverdue})=>`<div class="today-task-item"><input type="checkbox" class="today-task-cb" ${task.done?'checked':''} data-tk-action="toggleToday" data-tk-lead="${_escTask(lead.id)}" data-tk-id="${_escTask(task.id)}"><span class="today-task-text ${task.done?'done':''}">${_escTask(task.text)}</span>${isOverdue?'<span class="today-task-overdue">OVERDUE</span>':''}<span class="today-task-lead" data-tk-action="openModal" data-tk-id="${_escTask(lead.id)}">${_escTask(leadName.split(' ')[0])}</span></div>`).join('')+(items.length>8?`<div style="text-align:center;padding:8px;font-size:11px;color:var(--m);">+${items.length-8} more — <span style="color:var(--orange);cursor:pointer;" data-tk-action="goToCrm">view in CRM</span></div>`:'');
}
// The optimistic flip stays — on a slow connection the tick has to land
// instantly or the list feels broken. What was missing is the other half:
// when the write loses, put the cache back where Firestore actually is and
// say so, because renderTodayTasks() hides done tasks — the row vanishing
// was the ONLY feedback, and it lied.
async function toggleTodayTask(leadId,taskId,done){
  const t=(window._taskCache[leadId]||[]).find(t=>t.id===taskId);
  const prev=t?t.done:undefined;
  if(t)t.done=done;
  const ok=await _toggleTask(leadId,taskId,done);
  if(!ok&&t)t.done=prev;
  renderTodayTasks();
  renderLeads(window._leads,window._filteredLeads);
  if(!ok&&typeof showToast==='function')showToast("Couldn't save — check your connection and tap it again",'error');
}
async function openTaskModal(leadId,event){
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  if(event)event.stopPropagation();
  document.getElementById('taskInput').value='';
  document.getElementById('taskDue').value='';
  // nbdModal owns Esc/backdrop/focus on dashboard.html; classList fallback on
  // pages without nbd-modal.js (none since the legacy twin retired 2026-09-02). onClose runs the lead-id reset + list re-render.
  if(window.nbdModal){window.nbdModal.open('taskModal',{onClose:_taskModalReset});}else{var _tm=document.getElementById("taskModal");if(_tm)_tm.classList.add("open");}
  // No lead = the phone "+" sheet's Task row (and any other lead-less
  // caller). That path used to open this modal with a blank name and then
  // refuse every "+ Add" with "Open a lead to add a task" — the typed task
  // just sat there (phone audit 2026-09-25, pipeline#3). Ask which customer
  // first; picking one drops straight into the normal per-lead modal.
  if(!leadId){_taskShowLeadPicker();return;}
  await _taskBindLead(leadId,'lead');
}
// Point the open modal at one lead: header, mode, and that lead's task list.
// mode 'picked' = chosen from the picker, so the "Change customer" link shows.
async function _taskBindLead(leadId,mode){
  _taskModalLeadId=leadId;
  _taskSetMode(mode||'lead');
  const lead=(window._leads||[]).find(l=>l.id===leadId);
  document.getElementById('taskModalName').textContent=lead?(((lead.firstName||'')+' '+(lead.lastName||'')).trim()||lead.address):leadId;
  document.getElementById('taskModalAddr').textContent=lead?(lead.address||'').split(',').slice(0,2).join(','):'';
  renderTaskList(await _loadTasks(leadId));
}
function _taskSetMode(mode){const m=document.getElementById('taskModal');if(m)m.setAttribute('data-task-mode',mode);}
function _taskShowLeadPicker(){
  _taskModalLeadId=null;
  _taskSetMode('pick');
  document.getElementById('taskModalName').textContent='New task';
  document.getElementById('taskModalAddr').textContent='Pick the customer it belongs to';
  const s=document.getElementById('taskLeadSearch');
  if(s)s.value='';
  _taskRenderLeadResults('');
}
// Newest-first ordering for the empty-search list. Leads carry Firestore
// Timestamps, {seconds} objects, ISO strings or nothing, depending on writer.
function _taskLeadTime(l){
  const v=l&&(l.updatedAt||l.createdAt);
  if(!v)return 0;
  if(typeof v.toMillis==='function')return v.toMillis();
  if(typeof v.seconds==='number')return v.seconds*1000;
  const t=new Date(v).getTime();
  return isNaN(t)?0:t;
}
function _taskRenderLeadResults(q){
  const el=document.getElementById('taskLeadResults');if(!el)return;
  const leads=(window._leads||[]).filter(l=>l&&l.id&&!l.deleted);
  const query=String(q||'').trim();
  let hits;
  if(!query){
    hits=leads.slice().sort((a,b)=>_taskLeadTime(b)-_taskLeadTime(a));
  }else if(window.NbdGlobalSearch&&typeof window.NbdGlobalSearch.searchLeads==='function'){
    // Same scoring as the header search (name, phone digits, address, email).
    hits=window.NbdGlobalSearch.searchLeads(query).map(h=>h.lead).filter(l=>l&&l.id);
  }else{
    const ql=query.toLowerCase();
    hits=leads.filter(l=>(((l.firstName||'')+' '+(l.lastName||'')+' '+(l.address||'')).toLowerCase().indexOf(ql)!==-1));
  }
  hits=hits.slice(0,8);
  if(!hits.length){
    el.innerHTML='<div class="task-empty">'+(leads.length?'No customers match that search.':'No customers yet. Add a lead first.')+'</div>';
    return;
  }
  el.innerHTML=hits.map(l=>{
    const name=((l.firstName||'')+' '+(l.lastName||'')).trim()||l.name||l.address||'Customer';
    const sub=(l.address||'').split(',').slice(0,2).join(',');
    return `<button type="button" class="task-lead-row" data-tk-action="pickLead" data-tk-id="${_escTask(l.id)}"><span class="task-lead-row-name">${_escTask(name)}</span>${sub?`<span class="task-lead-row-sub">${_escTask(sub)}</span>`:''}</button>`;
  }).join('');
}
function _taskModalReset(){_taskModalLeadId=null;_taskSetMode('lead');renderLeads(window._leads,window._filteredLeads);renderTodayTasks();}
function closeTaskModal(){if(window.nbdModal){window.nbdModal.close('taskModal');}else{var _tm=document.getElementById("taskModal");if(_tm)_tm.classList.remove("open");_taskModalReset();}}
function _taskDueLabel(ds){const d=new Date(ds+'T12:00:00'),t=new Date(),tm=new Date(t);t.setHours(0,0,0,0);tm.setDate(tm.getDate()+1);tm.setHours(0,0,0,0);const dd=new Date(d);dd.setHours(0,0,0,0);if(dd.getTime()===t.getTime())return'Today';if(dd.getTime()===tm.getTime())return'Tomorrow';if(dd<t)return'Overdue';return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}
function renderTaskList(all){
  const el=document.getElementById('taskList');if(!el)return;
  // Add-Event entries (type:'event', customer page) live in this subcollection
  // too. They are dated appointments, not to-dos: listed read-only with their
  // date under the tasks — they used to render as undated checkboxes, where
  // ticking one marked the meeting "done" (CRM sweep R14, 2026-09-28).
  const events=(all||[]).filter(t=>t&&t.type==='event');
  const tasks=(all||[]).filter(t=>t&&t.type!=='event');
  if(!tasks.length&&!events.length){el.innerHTML='<div class="task-empty">No tasks yet. Add one above.</div>';return;}
  const now=new Date();
  const undone=tasks.filter(t=>!t.done).sort((a,b)=>(!a.dueDate&&!b.dueDate)?0:!a.dueDate?1:!b.dueDate?-1:new Date(a.dueDate)-new Date(b.dueDate));
  el.innerHTML=[...undone,...tasks.filter(t=>t.done)].map(t=>{
    const due=t.dueDate?new Date(t.dueDate+'T23:59:59'):null;
    const ov=due&&due<now&&!t.done;
    return `<div class="task-item ${t.done?'done':''} ${ov?'overdue':''}" id="titem-${_escTask(t.id)}"><input type="checkbox" class="task-cb" ${t.done?'checked':''} data-tk-action="checkTask" data-tk-id="${_escTask(t.id)}"><span class="task-text">${_escTask(t.text)}</span>${t.dueDate?`<span class="task-due ${ov?'overdue':''}">${_taskDueLabel(t.dueDate)}</span>`:''}<button class="task-del" data-tk-action="removeTask" data-tk-id="${_escTask(t.id)}" title="Delete">×</button></div>`;
  }).join('')+events.slice().sort((a,b)=>String(a.eventAt||'').localeCompare(String(b.eventAt||''))).map(t=>{
    const at=t.eventAt?new Date(t.eventAt):null;
    const when=at&&!isNaN(at)?at.toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
    return `<div class="task-item task-event" id="titem-${_escTask(t.id)}"><span class="task-text">📅 ${_escTask(t.title||t.text||'Event')}</span>${when?`<span class="task-due">${_escTask(when)}</span>`:''}<button class="task-del" data-tk-action="removeTask" data-tk-id="${_escTask(t.id)}" title="Delete">×</button></div>`;
  }).join('');
}
async function addTask(){
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const inp=document.getElementById('taskInput'),due=document.getElementById('taskDue');
  if(!inp)return;
  const text=inp.value.trim();
  // Was a silent no-op on empty input / no-lead — users hit "+ Add" and
  // nothing happened. Give explicit feedback instead.
  if(!text){ if(typeof showToast==='function')showToast('Type a task first','info'); inp.focus(); return; }
  if(!_taskModalLeadId){ if(typeof showToast==='function')showToast('Open a lead to add a task','info'); return; }
  inp.value='';
  await _saveTask(_taskModalLeadId,text,due.value||'');
  renderTaskList(await _loadTasks(_taskModalLeadId));
}
// Wave 28: Enter-key submit on the task input. Replaces the inline
// onkeydown="" handler in dashboard.html for CSP cleanliness.
(function(){
  const bind = () => {
    const inp = document.getElementById('taskInput');
    if (!inp || inp.dataset.taskEnterBound) return;
    inp.dataset.taskEnterBound = '1';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } });
    // Customer-picker search (2026-09-25): filter as the rep types; Enter
    // takes the top match, the same as tapping it.
    const s = document.getElementById('taskLeadSearch');
    if (s && !s.dataset.taskSearchBound) {
      s.dataset.taskSearchBound = '1';
      s.addEventListener('input', () => _taskRenderLeadResults(s.value));
      s.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const first = document.querySelector('#taskLeadResults [data-tk-action="pickLead"]');
        if (first) _taskBindLead(first.dataset.tkId, 'picked');
      });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
async function checkTask(taskId,done){
  if(!_taskModalLeadId)return;
  // Pin the lead now: the 400ms settle below outlives a modal close, which
  // nulls _taskModalLeadId — the delayed re-render used to refetch 'leads/null'.
  const leadId=_taskModalLeadId;
  const t=(window._taskCache[leadId]||[]).find(t=>t.id===taskId);
  const prev=t?t.done:undefined;
  if(t)t.done=done;
  const item=document.getElementById('titem-'+taskId);
  if(item)item.classList.toggle('done',done);
  if(!(await _toggleTask(leadId,taskId,done))){
    // Undo the optimistic strike-through straight away — no 400ms settle,
    // and no refetch over a connection that just failed us.
    if(t)t.done=prev;
    // Both re-renders below paint into the single shared #taskList. Pinning
    // leadId fixed the 'leads/null' refetch but removed the implicit "is this
    // still the open lead?" check — and a failing write can hang for seconds,
    // long enough to close this modal and open another lead. Repainting lead
    // A's tasks over lead B's modal is worse than the bug being fixed, so
    // check ownership before touching the DOM.
    if(_taskModalLeadId!==leadId){
      if(typeof showToast==='function')showToast("Couldn't save — check your connection and tap it again",'error');
      return;
    }
    renderTaskList(window._taskCache[leadId]||[]);
    if(typeof showToast==='function')showToast("Couldn't save — check your connection and tap it again",'error');
    return;
  }
  setTimeout(async()=>{const rows=await _loadTasks(leadId);if(_taskModalLeadId!==leadId)return;renderTaskList(rows);},400);
}
async function removeTask(taskId){if(!_taskModalLeadId)return;const _t=(window._taskCache&&window._taskCache[_taskModalLeadId]||[]).find(t=>t.id===taskId);const _label=_t&&_t.text?'"'+_t.text+'"':'this task';const _ask=window.nbdConfirm||((m)=>Promise.resolve(window.confirm(m)));if(!(await _ask('Delete '+_label+'? This cannot be undone.')))return;
  // A delete that never reached Firestore used to look identical to one that
  // did: the list re-rendered with the row still sitting there and no word why.
  // Leave the row alone (it IS the truth) and name the failure.
  if(!(await _deleteTask(_taskModalLeadId,taskId))){
    if(typeof showToast==='function')showToast("Couldn't delete — check your connection and try again",'error');
    return;
  }
  renderTaskList(await _loadTasks(_taskModalLeadId));
}
window.addEventListener('load', _bootTasks);
window.addEventListener('nbd:data-refreshed', (e) => { if (e && e.detail && e.detail.source === 'leads') _bootTasks(); });
// ══ END TASK SYSTEM ══════════════════════════════

// ══ Window Scope Exposures ══════════════════════════════════
window.loadAllTasks = loadAllTasks;
window.openTaskModal = openTaskModal;
window.closeTaskModal = closeTaskModal;
window.addTask = addTask;
// checkTask's window export dropped (globals Tranche 2b): zero external
// consumers — the only caller is this file's own data-tk-action delegate,
// which references the bare function.
window.removeTask = removeTask;
window.createNotification = createNotification;


// One delegate, bound to BOTH click and change — and a checkbox fires both,
// so every tick used to run its handler TWICE. That was invisible while the
// handlers were fire-and-forget idempotent writes (it just doubled the
// Firestore traffic). It stops being invisible the moment a handler
// snapshots state to revert on failure: invocation B reads `prev` from the
// object invocation A already flipped, so B's revert restores A's flip and
// the task stays ticked on a failed save — exactly the lie the revert was
// added to remove — with two error toasts on top.
//
// So route by event type instead of listening to both for everything.
// Checkbox-driven actions act on `change` only (it carries .checked and
// fires once per state change); everything else acts on `click`.
const _TK_CHECKBOX_ACTIONS = { toggleToday: 1, checkTask: 1 };
(function(){if(_NBD_TK_DELEGATE)return;_NBD_TK_DELEGATE=true;function dispatch(ev){var t=ev.target.closest&&ev.target.closest('[data-tk-action]');if(!t)return;var a=t.dataset.tkAction;var wantChange=!!_TK_CHECKBOX_ACTIONS[a];if(wantChange!==(ev.type==='change'))return;var id=t.dataset.tkId;var leadId=t.dataset.tkLead;try{if(a==='toggleToday'&&typeof toggleTodayTask==='function')toggleTodayTask(leadId,id,ev.target.checked);else if(a==='openModal'&&typeof openTaskModal==='function')openTaskModal(id,null);else if(a==='goToCrm'&&typeof goTo==='function')goTo('crm');else if(a==='checkTask'&&typeof checkTask==='function')checkTask(id,ev.target.checked);else if(a==='removeTask'&&typeof removeTask==='function')removeTask(id);else if(a==='pickLead')_taskBindLead(id,'picked');else if(a==='changeLead')_taskShowLeadPicker();}catch(e){console.error('[tasks]',e);}}document.addEventListener('click',dispatch);document.addEventListener('change',dispatch);})();
