/**
 * tasks-stay-fresh-2026-11-14.test.js — tasks and alerts never go stale or vanish.
 *
 * Wave-1 daily-screens findings, each verified first:
 *   #1 tasks.js _bootTasks re-read tasks only on boot or an account change;
 *      every later lead refresh (the tab-return reload) only repainted the old
 *      cache, and the Schedule calendar's refresh button refetched Cal.com
 *      only. Tasks added on the phone, in another tab or by the server stayed
 *      missing until a full reload.
 *   #2 addTask cleared the input and ignored _saveTask's null on failure: the
 *      text vanished, nothing was added, nothing was said.
 *   #3 the bell's task alert id was task:<lead>:<task>, and dismissed ids live
 *      in localStorage: dismiss "due today", reschedule, and it never alerted
 *      again on that device.
 *
 * Runs the real notif-bell.js and schedule-calendar-panel.js, and the real
 * _bootTasks / addTask lifted out of tasks.js.
 * TASKS_SRC / BELL_SRC / CAL_SRC=<file> run against other copies.
 *
 * Run: node tests/tasks-stay-fresh-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = (env, rel) => fs.readFileSync(process.env[env] || path.join(ROOT, rel), 'utf8');
const TASKS = src('TASKS_SRC', 'docs/pro/js/tasks.js');
const BELL = src('BELL_SRC', 'docs/pro/js/notif-bell.js');
const CAL = src('CAL_SRC', 'docs/pro/js/schedule-calendar-panel.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
function slice(text, start) {
  const i = text.indexOf(start);
  if (i < 0) return '';
  const open = text.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return '';
}

(async () => {
  console.log('\ntasks-stay-fresh — tasks refresh, failed adds keep the text, alerts come back\n');

  // ── #1 _bootTasks re-reads on a later lead refresh ──
  {
    const decl = /let _tasksLoadedAt = 0;\s*\n\s*const TASK_FRESH_MS = \d+;/.exec(TASKS);
    const ctx = { window: { _leadsLoaded: true, _user: { uid: 'u1' } }, Date, loads: 0, paints: 0 };
    vm.createContext(ctx);
    vm.runInContext('let _taskBootUid = null;\n' + (decl ? decl[0] : 'let _tasksLoadedAt = 0;') + '\n'
      + 'function loadAllTasks() { loads++; _tasksLoadedAt = Date.now(); }\nfunction renderTodayTasks() { paints++; }\n'
      + slice(TASKS, 'function _bootTasks(') + '\nthis.boot = _bootTasks; this.age = (ms) => { _tasksLoadedAt = Date.now() - ms; };', ctx);
    ctx.boot();
    ok('(boot loads the tasks once)', ctx.loads === 1);
    ctx.boot();
    ok('a lead refresh seconds later only repaints (no extra read)', ctx.loads === 1 && ctx.paints === 1);
    ctx.age(5 * 60 * 1000);
    ctx.boot();
    ok('a lead refresh after the tasks are minutes old re-reads them', ctx.loads === 2, 'loads=' + ctx.loads);
  }

  // ── review round: the refresh must not race itself or flip modes on a blip ──
  {
    const decls = (TASKS.match(/^(?:const|let) _(?:tasksFromCache|taskCacheRetries|TASK_CACHE_RETRY_MS|TASK_CACHE_MAX_RETRIES|FS_SDK|taskLoadMode|tasksLoaded|tasksLoadedAt|taskEditGen|taskLoadP)\b[^\n]*$/gm) || []).join('\n');
    const once = slice(TASKS, 'async function _loadAllTasksOnce(');
    const wrapper = once ? slice(TASKS, 'function loadAllTasks(') : slice(TASKS, 'async function loadAllTasks(');
    function rig() {
      const st = { reads: 0, fail: null, gate: null, server: [{ id: 't1', text: 'old', dueDate: '', done: false, leadId: 'L1' }] };
      const win = { _leads: [{ id: 'L1' }], _taskCache: {}, _user: { uid: 'u1' }, _userClaims: {},
        NBDTodayPlan: {
          tasksQuery: () => ({ group: 'tasks', field: 'userId', value: 'u1', orderBy: 'createdAt', dir: 'asc' }),
          groupTasksByLead: (rows) => { const by = {}; rows.forEach((r) => { (by.L1 = by.L1 || []).push(Object.assign({ id: r.id }, r.data)); }); return by; },
        },
        collectionGroup: () => ({}), dispatchEvent: () => true };
      const timers = [];
      const ctx = vm.createContext({
        window: win, console: { log() {}, warn() {}, error() {} }, Date, Promise, Object, Array,
        CustomEvent: function () {}, setTimeout: (fn) => { timers.push(fn); return 1; },
        db: {}, where: () => ({}), orderBy: () => ({}), query: (c) => c, collection: () => ({}),
        getDocs: async () => {
          st.reads++;
          if (st.gate) await st.gate;
          if (st.fail) { const e = new Error('net'); e.code = st.fail; throw e; }
          return { docs: st.server.map((t) => ({ id: t.id, ref: { parent: { path: 'leads/L1/tasks' } }, data: () => Object.assign({}, t) })), metadata: { fromCache: false } };
        },
        renderTodayTasks() {}, renderLeads() {},
      });
      vm.runInContext([decls, slice(TASKS, 'async function _overlayCallText('), slice(TASKS, 'async function _loadTasks('),
        slice(TASKS, 'async function _loadAllTasksGroup('), once, wrapper,
        'this.load = loadAllTasks; this.bump = () => { if (typeof _taskEditGen !== "undefined") _taskEditGen++; }; this.mode = () => _taskLoadMode;'].join('\n'), ctx);
      return { ctx, win, st, timers };
    }
    // two asks at once → one read
    let R = rig();
    let open; R.st.gate = new Promise((r) => { open = r; });
    const a = R.ctx.load(), b = R.ctx.load();
    open(); await a; await b; await flush();
    ok('two refreshes at once make ONE task read', R.st.reads === 1, 'reads=' + R.st.reads);
    // a write lands while a read is in flight → that read does not overwrite it
    R = rig();
    R.st.gate = new Promise((r) => { open = r; });
    const p = R.ctx.load();
    await flush();
    R.win._taskCache = { L1: [{ id: 't1', text: 'old', done: true, leadId: 'L1' }] }; // the rep ticked Done
    R.ctx.bump();
    open(); await p; await flush();
    ok('a read that started before a write does not undo the write', R.win._taskCache.L1[0].done === true, JSON.stringify(R.win._taskCache));
    ok('...and a fresh read is queued', R.timers.length >= 1);
    // a network blip keeps the one-query mode
    R = rig();
    R.st.fail = 'unavailable';
    await R.ctx.load(); await flush();
    ok('a network error does not switch the session to per-lead reads', R.ctx.mode() === 'group', 'mode=' + R.ctx.mode());
    R = rig();
    R.st.fail = 'permission-denied';
    await R.ctx.load(); await flush();
    ok('(a real refusal still falls back to per-lead)', R.ctx.mode() === 'per-lead');
  }

  // ── #1 the Schedule calendar's refresh re-reads tasks too ──
  {
    const clicks = [];
    const W = {
      addEventListener() {}, NBDEventCalendarEvents: null, loadAllTasks() { W.taskLoads = (W.taskLoads || 0) + 1; return Promise.resolve(); },
      taskLoads: 0,
    };
    const ctx = {
      window: W, location: { hash: '' }, console: { log() {}, warn() {}, error() {} },
      document: { readyState: 'complete', addEventListener(t, fn) { if (t === 'click') clicks.push(fn); }, getElementById: () => null },
      setTimeout: () => 0, clearTimeout() {}, Promise, Date, Math, JSON, Object, Array, String,
    };
    W.window = W;
    vm.createContext(ctx);
    // The click delegate returns early until a calendar is mounted (_ec, made
    // by the EventCalendar library in render()). Mounting needs the library,
    // so that one guard is lifted here and the rest of the real handler runs.
    const btn = { hasAttribute: (a) => a === 'data-sc2-refresh', getAttribute: () => null };
    const ev = { target: { closest: () => btn } };
    ok('(the refresh delegate is guarded on a mounted calendar, as assumed)', /if \(!t \|\| !_ec\) return;/.test(CAL));
    vm.runInContext(CAL.replace('if (!t || !_ec) return;', 'if (!t) return;'), ctx, { filename: 'schedule-calendar-panel.js' });
    clicks.forEach((fn) => fn(ev));
    await flush();
    ok('the calendar refresh button re-reads the task cache (CRM appointments)', W.taskLoads === 1, 'loadAllTasks calls=' + W.taskLoads);
  }

  // ── #2 a failed "+ Add" keeps the text and says so ──
  {
    const toasts = [];
    const inp = { value: 'Order ridge cap', focus() {} };
    const ctx = {
      window: {}, document: { getElementById: (id) => (id === 'taskInput' ? inp : id === 'taskDue' ? { value: '' } : null) },
      showToast: (m, t) => toasts.push([t, m]), _taskModalLeadId: 'L1',
      _saveTask: async () => null, _loadTasks: async () => [], renderTaskList() { ctx.listed = true; }, listed: false,
    };
    vm.createContext(ctx);
    vm.runInContext('var _taskModalLeadId = "L1";\n' + slice(TASKS, 'async function addTask(') + '\nthis.add = addTask;', ctx);
    await ctx.add();
    ok('save failed: the typed task text is put back', inp.value === 'Order ridge cap', JSON.stringify(inp.value));
    ok('...and the rep is told it was not saved', toasts.some(([t, m]) => t === 'error' && /not saved/i.test(m)), JSON.stringify(toasts));
  }

  // ── #3 a dismissed alert returns after a reschedule ──
  {
    const els = {};
    const mk = () => ({ innerHTML: '', textContent: '', style: {}, dataset: {}, appendChild() {}, remove() {}, contains() { return false; },
      addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } });
    ['notifList', 'notifDismissedList', 'notifDismissedToggle', 'dismissedCount', 'notifBadge', 'clearAllNotifBtn', 'notifDropdown', 'notifBtn', 'dismissedToggleLabel']
      .forEach((id) => { els[id] = mk(); });
    const ls = {};
    const winH = {};
    const win = { addEventListener(t, fn) { (winH[t] = winH[t] || []).push(fn); }, removeEventListener() {}, dispatchEvent() {}, location: { href: '', pathname: '/pro/dashboard' } };
    win.window = win;
    const clicks = [];
    const sb = {
      window: win,
      document: { addEventListener(t, fn) { if (t === 'click') clicks.push(fn); }, removeEventListener() {}, getElementById: (id) => els[id] || null,
        querySelector() { return null; }, querySelectorAll() { return []; }, createElement: mk, body: mk(), readyState: 'complete' },
      localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
      console: { log() {}, warn() {}, error() {} },
      setTimeout: () => 0, clearTimeout: () => 0, setInterval: () => 0, clearInterval: () => 0,
      Date, Math, JSON, Object, Array, String, Number, Set, Map, encodeURIComponent, Promise,
    };
    vm.runInNewContext(BELL, sb, { filename: 'notif-bell.js' });
    const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const today = ymd(new Date());
    const yesterday = ymd(new Date(Date.now() - 86400000));
    win._leads = [{ id: 'L1', firstName: 'Ann', lastName: 'Lee', stage: 'contacted', updatedAt: new Date() }];
    win._taskCache = { L1: [{ id: 't1', text: 'Call the adjuster', dueDate: today, done: false }] };
    win._estimates = []; win._notifications = [];
    const show = () => { (winH['nbd:data-refreshed'] || []).forEach((fn) => fn({})); win.__NBD_CALL_REGISTRY.toggleNotificationDropdown(); return els.notifList.innerHTML; };
    let html = show();
    ok('(the due-today task alert shows)', html.includes('Call the adjuster'));
    const idMatch = /data-nb-id="(task:L1:t1[^"]*)"/.exec(html);
    ok('(its dismiss id is on the row)', !!idMatch, html.slice(0, 200));
    const node = { dataset: { nbAction: 'dismiss', nbId: idMatch ? idMatch[1].replace(/&amp;/g, '&') : '', nbStop: '1' },
      closest(sel) { return sel.indexOf('data-nb-stop-self') >= 0 ? null : (sel.indexOf('data-nb-action') >= 0 ? node : null); } };
    clicks.forEach((h) => h({ target: node, stopPropagation() {} }));
    win.__NBD_CALL_REGISTRY.toggleNotificationDropdown(); // close
    html = show();
    ok('dismissed: the alert is gone', !html.includes('Call the adjuster'));
    // Rescheduled: the task now has a different due date (overdue from yesterday).
    win._taskCache.L1[0].dueDate = yesterday;
    win.__NBD_CALL_REGISTRY.toggleNotificationDropdown(); // close
    html = show();
    ok('rescheduled: the alert comes back on this device', html.includes('Call the adjuster'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
