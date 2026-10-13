/**
 * tests/today-row-and-handled-flow-2026-10-13.test.js - PR-A of the Today UX
 * walk (documentation/qa/today-ux-walk-2026-10-13/FINDINGS.md), items 3 + 4:
 *
 *   H1/M3  an urgent / missed call must never be buried in a "promised" row, and
 *          Done / Tomorrow must close only the calls whose own promise it is
 *   H3     Handled: one tap, busy state, an error on step 1 of the sheet, a
 *          double tap never closes the sheet mid-save, Undo after success,
 *          "I promised something" as the secondary button
 *   H4     a Call Center Handled repaints Home / Today at once
 *
 * The real browser files run in a vm sandbox (no regex-shape checks): every
 * assertion drives the shipped function and reads what it painted or called.
 * Run: node tests/today-row-and-handled-flow-2026-10-13.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const PL = require(path.join(ROOT, 'docs/pro/js/promise-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const NOW = Date.now();
const DAY = 86400000;
const TODAY = PL.ymdLocal(NOW);
const YESTERDAY = PL.ymdLocal(NOW - DAY);

function fakeEl(id) {
  const stubs = {};
  const el = {
    id: id || '', hidden: false, className: '', innerHTML: '', textContent: '', _l: {},
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
    appendChild() {}, focus() {}, setAttribute(k, v) { el['_a_' + k] = v; }, getAttribute(k) { return el['_a_' + k] || null; },
    querySelector(sel) { return stubs[sel] || (stubs[sel] = fakeEl('')); },
    querySelectorAll() { return []; }, closest() { return null; },
    classList: { toggle() {}, add() {}, remove() {} },
  };
  return el;
}
function sandbox(extra) {
  const els = {};
  const doc = {
    readyState: 'complete', activeElement: null,
    getElementById: (id) => els[id] || null,
    createElement: () => fakeEl(''),
    body: { appendChild(e) { if (e.id) els[e.id] = e; } },
    _l: {}, addEventListener(t, f) { (doc._l[t] = doc._l[t] || []).push(f); }, querySelector: () => null, querySelectorAll: () => [], contains: () => true,
  };
  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }
  const win = {
    document: doc, els, CustomEvent, console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout: () => 0, clearTimeout() {},
    Promise, Date, Object, String, Number, Array, JSON, RegExp, Math, Set, Map,
    location: { hash: '', search: '', pathname: '/pro/dashboard.html' },
    addEventListener() {}, dispatchEvent() { return true; },
  };
  win.window = win;
  Object.assign(win, extra || {});
  return { win, ctx: vm.createContext(win), els, doc };
}
const load = (env, rel) => vm.runInContext(read(rel), env.ctx, { filename: rel });

const lead = { id: 'L1', firstName: 'Dana', lastName: 'Promise', phone: '5135550111' };
const promCall = { id: 'cube_PROM01', userId: 'u1', leadId: 'L1', startedAtMs: NOW - 2 * DAY, status: 'noted', direction: 'inbound', bucket: 'customer', phoneDigits: '5135550111', summary: 'asked for a number', promises: [{ who: 'jo', text: 'call back Friday' }] };
const urgCall = { id: 'cube_URG001', userId: 'u1', leadId: 'L1', startedAtMs: NOW - 25 * 60e3, status: 'short', direction: 'inbound', bucket: 'customer', phoneDigits: '5135550111', urgent: true, summary: 'water coming in', promises: [] };
const task = { id: 't1', title: 'Order shingles', text: 'Order shingles', dueDate: YESTERDAY };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── the Today page in a sandbox ─────────────────────────────────────────
function todayEnv(opts) {
  opts = opts || {};
  const rows = (opts.rows || []).map(clone);
  const calls = [];            // { name, data }
  const toasts = [];
  const rendered = [];
  const failIds = new Set(opts.failIds || []);
  let gate = null;
  const tasksDone = [];
  const ha = {
    lastRows: rows, lastLabels: null, lastCounts: {}, callerKey: HA.callerKey,
    groupNeeds: (r, n, l) => HA.groupNeeds(r, n, l),
    hiddenPeople: () => 0,
    render(f) { rendered.push(f); },
  };
  const env = sandbox({
    _user: { uid: 'u1' }, _userClaims: { role: 'company_admin' }, _leads: (opts.leads || [lead]).map(clone), _leadsLoaded: true,
    _taskCache: opts.tasks ? clone(opts.tasks) : {},
    NBDTasks: {
      loaded: () => true,
      setDone: async (l, id) => { tasksDone.push(id); return true; },
      setDue: async () => true,
    },
    NBDTodayPlan: TP, NBDHomeAttention: ha,
    showToast(m, t) { toasts.push(typeof m === 'string' ? { message: m, type: t } : m); },
    _functions: {},
    _httpsCallable: (_f, name) => async (data) => {
      calls.push({ name, data });
      if (gate) await gate;
      if (failIds.has(data && data.id)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
      return { data: { ok: true } };
    },
  });
  if (opts.promise) env.win.NBDPromise = opts.promise;
  env.els.todayPlan = fakeEl('todayPlan');
  load(env, 'docs/pro/js/today-home.js');
  return {
    env, win: env.win, rows, calls, toasts, rendered, tasksDone, failIds,
    html: () => env.els.todayPlan.innerHTML,
    paint: () => env.win.NBDToday.render(),
    hold: () => { let rel; gate = new Promise((r) => { rel = r; }); return () => { gate = null; rel(); }; },
    click: async (act, key, id) => {
      const attrs = { 'data-tp-act': act, 'data-tp-key': key, 'data-tp-id': id || '' };
      for (const fn of env.doc._l.click || []) await fn({ target: { closest: (sel) => (/data-tp-act/.test(sel) ? { getAttribute: (k) => (k in attrs ? attrs[k] : null) } : null) } });
      await flush();
    },
  };
}

(async () => {
  // ═══ H1 / M3: an urgent missed call is not buried in a promised row ═════
  console.log('\nH1. the promised row never swallows an urgent or missed call');
  {
    const plan = TP.buildTodayPlan({
      now: NOW, leads: [lead], tasksByLead: { L1: [clone(task)] }, appointments: [], jobs: [],
      callGroups: [{ key: 'lead:L1', calls: [clone(urgCall), clone(promCall)], latestMs: urgCall.startedAtMs }],
    });
    const row = plan.promised[0];
    ok('control: the promised row exists for the customer', !!row && row.leadId === 'L1', JSON.stringify(plan.promised).slice(0, 200));
    ok('control: the call carrying Jo\'s own promise stays on the row (Done still closes it)', !!row && row.callIds.indexOf('cube_PROM01') !== -1, JSON.stringify(row && row.callIds));
    ok('the urgent missed call is NOT in the ids Done / Tomorrow act on', !!row && row.callIds.indexOf('cube_URG001') === -1, JSON.stringify(row && row.callIds));
    const rider = row && (row.phoneCalls || []).filter((u) => (u.callIds || []).indexOf('cube_URG001') !== -1)[0];
    ok('...it rides in the row as its own call with urgent + missed + its own ids', !!rider && rider.urgent === true && rider.missed === true && rider.callIds.length === 1, JSON.stringify(rider));
    ok('one person is still one row (the call is not a second Calls-owed row)', plan.calls.length === 0 && plan.promised.length === 1 && plan.total === 1, 'calls=' + plan.calls.length + ' total=' + plan.total);

    // a call that a task of its own covers stays owned
    const owned = TP.buildTodayPlan({
      now: NOW, leads: [lead], tasksByLead: { L1: [{ id: 'cube-cube_URG001', title: 'Call back', dueDate: YESTERDAY }] }, appointments: [], jobs: [],
      callGroups: [{ key: 'lead:L1', calls: [clone(urgCall)], latestMs: urgCall.startedAtMs }],
    });
    const orow = owned.promised[0];
    ok('control: a call whose own follow-up task is due is that row\'s (ticking the task keeps it)', !!orow && orow.callIds.indexOf('cube_URG001') !== -1 && !(orow.phoneCalls || []).length, JSON.stringify(orow && { c: orow.callIds, p: orow.phoneCalls }));
  }
  {
    const t = todayEnv({ rows: [urgCall, promCall], tasks: { L1: [task] } });
    await flush(); t.paint();
    const h = t.html();
    ok('the Today row says urgent', /tp-hot">urgent</.test(h), h.slice(0, 600));
    ok('the Today row says missed call', /missed call/.test(h));
    ok('the stray call has its own Handled button (data-tp-key lead:L1)', /data-tp-act="handled" data-tp-key="lead:L1"/.test(h), h.slice(0, 900));
    await t.click('done', 'prom:L1');
    const handledIds = t.calls.filter((c) => c.data.action === 'handled').map((c) => c.data.id);
    ok('Done handles the promise-carrying call', handledIds.indexOf('cube_PROM01') !== -1, JSON.stringify(t.calls));
    ok('Done does NOT handle the urgent missed call', handledIds.indexOf('cube_URG001') === -1, JSON.stringify(handledIds));
    ok('...and Done ticked the task', t.tasksDone.indexOf('t1') !== -1);
    ok('...and the urgent call is still on Today after Done', /cube_URG001|urgent/.test(t.html()) && /missed call/.test(t.html()), t.html().slice(0, 500));
  }
  {
    const t = todayEnv({ rows: [urgCall, promCall], tasks: { L1: [task] } });
    await flush(); t.paint();
    await t.click('tomorrow', 'prom:L1');
    const snoozed = t.calls.filter((c) => c.data.action === 'snooze').map((c) => c.data.id);
    ok('Tomorrow snoozes only the call whose promise it is', snoozed.indexOf('cube_PROM01') !== -1 && snoozed.indexOf('cube_URG001') === -1, JSON.stringify(snoozed));
  }
  {
    const t = todayEnv({ rows: [urgCall, promCall], tasks: { L1: [task] } });
    await flush(); t.paint();
    await t.click('handled', 'lead:L1');
    const hid = t.calls.filter((c) => c.data.action === 'handled').map((c) => c.data.id);
    ok('positive control: the stray call\'s own Handled closes exactly that call', hid.length === 1 && hid[0] === 'cube_URG001', JSON.stringify(hid));
  }
  {
    // M3: the button says what it closes
    const t = todayEnv({ rows: [urgCall, promCall], tasks: { L1: [task] } });
    await flush(); t.paint();
    ok('M3: with another call riding in the row, Done is not a bare "Done" (it says it is this one)', !/data-tp-act="done"[^>]*>✓ Done</.test(t.html()) && /data-tp-act="done"/.test(t.html()), t.html().slice(0, 700));
    const solo = todayEnv({ rows: [promCall], tasks: { L1: [task] } });
    await flush(); solo.paint();
    ok('control: with no other call, Done keeps its plain label', /data-tp-act="done"[^>]*>✓ Done</.test(solo.html()), solo.html().slice(0, 500));
  }

  // ═══ H3: one-tap Handled, Undo, error, secondary promise button ═════════
  console.log('\nH3. Handled is one tap with an Undo, and a failure is told');
  const cA = { id: 'cube_AAAA01', userId: 'u1', leadId: null, startedAtMs: NOW - 3600e3, status: 'noted', direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550222', contactName: 'Pat Caller', summary: 'wants a quote', promises: [] };
  const cB = { id: 'cube_BBBB02', userId: 'u1', leadId: null, startedAtMs: NOW - 7200e3, status: 'noted', direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550222', contactName: 'Pat Caller', summary: 'second call', promises: [] };
  {
    let sheets = 0;
    const t = todayEnv({ rows: [cA, cB], leads: [], promise: { openSheet() { sheets++; }, waitingDays: () => 3 } });
    await flush(); t.paint();
    ok('control: the person is on Calls owed with a Handled button', /Pat Caller/.test(t.html()) && /data-tp-act="handled"/.test(t.html()), t.html().slice(0, 500));
    const key = (t.html().match(/data-tp-act="handled" data-tp-key="([^"]+)"/) || [])[1];
    await t.click('handled', key);
    const ids = t.calls.filter((c) => c.data.action === 'handled').map((c) => c.data.id).sort();
    ok('one tap handles every call of that person (no sheet in between)', ids.join() === 'cube_AAAA01,cube_BBBB02' && sheets === 0, JSON.stringify(ids) + ' sheets=' + sheets);
    ok('the row is gone from Today', !/Pat Caller/.test(t.html()), t.html().slice(0, 400));
    const ut = t.toasts.filter((x) => typeof x.undoAction === 'function')[0];
    ok('an Undo toast is offered', !!ut, JSON.stringify(t.toasts.map((x) => x.message)));
    ok('...it lasts about 6 s', !!ut && ut.duration >= 5000 && ut.duration <= 7000, String(ut && ut.duration));
    t.calls.length = 0;
    if (ut) await ut.undoAction();
    await flush();
    const un = t.calls.filter((c) => c.data.action === 'unhandled').map((c) => c.data.id).sort();
    ok('Undo sends unhandled for every call', un.join() === 'cube_AAAA01,cube_BBBB02', JSON.stringify(t.calls));
    ok('...and the row is back', /Pat Caller/.test(t.html()), t.html().slice(0, 300));
    ok('...and Home / the strip re-reads', t.rendered.filter(Boolean).length >= 2, JSON.stringify(t.rendered));
  }
  {
    const t = todayEnv({ rows: [cA, cB], leads: [], failIds: ['cube_BBBB02'], promise: { openSheet() {}, waitingDays: () => 3 } });
    await flush(); t.paint();
    const key = (t.html().match(/data-tp-act="handled" data-tp-key="([^"]+)"/) || [])[1];
    await t.click('handled', key);
    ok('a failed save is told (error toast), not silent', t.toasts.some((x) => x.type === 'error'), JSON.stringify(t.toasts));
    ok('...and the person is still listed (nothing silently lost)', /Pat Caller/.test(t.html()), t.html().slice(0, 300));
    const saved = t.rows.filter((r) => r.handledAtMs).map((r) => r.id);
    const open = t.rows.filter((r) => !r.handledAtMs).map((r) => r.id);
    ok('...the call that did save is not asked again, the failed one is still open', saved.join() === 'cube_AAAA01' && open.join() === 'cube_BBBB02', 'saved=' + saved + ' open=' + open);
    ok('...the error names the count (1 of 2)', t.toasts.some((x) => x.type === 'error' && /1 of 2|1 call/.test(x.message)), JSON.stringify(t.toasts));
  }
  {
    const opened = [];
    const t = todayEnv({ rows: [cA, cB], leads: [], promise: { openSheet(o) { opened.push(o); }, waitingDays: () => 3 } });
    await flush(); t.paint();
    ok('the secondary "I promised something" button exists beside Handled', /data-tp-act="promised"[^>]*>I promised something</.test(t.html()), t.html().slice(0, 600));
    const key = (t.html().match(/data-tp-act="promised" data-tp-key="([^"]+)"/) || [])[1];
    await t.click('promised', key);
    ok('it opens the promise sheet in handle mode with the person\'s call ids', opened.length === 1 && opened[0].mode === 'handle' && opened[0].callIds.slice().sort().join() === 'cube_AAAA01,cube_BBBB02', JSON.stringify(opened[0] && opened[0].callIds));
    ok('...and it did not handle anything by itself', t.calls.filter((c) => c.data.action === 'handled').length === 0);
  }

  // ═══ the sheet itself (promise-ui.js) ═══════════════════════════════════
  console.log('\nH3. the sheet: busy, error on step 1, double tap');
  async function sheetEnv(failIds) {
    const calls = [];
    const failSet = new Set(failIds || []);
    let release = null, gate = null;
    const env = sandbox({
      _taskCache: {}, _leads: [], _userClaims: {}, _user: { uid: 'u1' },
      showToast() {}, NBDHomeAttention: { lastRows: [], render() {} },
      _functions: {},
      _httpsCallable: (_f, name) => async (data) => {
        calls.push({ name, data });
        if (gate) await gate;
        if (failSet.has(data.id)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
        return { data: { ok: true } };
      },
    });
    load(env, 'docs/pro/js/promise-logic.js');
    load(env, 'docs/pro/js/promise-ui.js');
    const NP = env.win.NBDPromise;
    NP.openSheet({ mode: 'handle', name: 'Pat Caller', callIds: ['cube_AAAA01', 'cube_BBBB02', 'cube_CCCC03'] });
    const sheet = env.els.prSheet;
    const body = () => sheet.querySelector('#prBody').innerHTML;
    const tap = async (attrs) => { sheet._l.click.forEach((f) => f({ target: { closest: () => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) }) } })); await flush(); };
    return { env, NP, calls, sheet, body, tap, failSet, hold: () => { gate = new Promise((r) => { release = r; }); }, release: () => { gate = null; release && release(); } };
  }
  {
    const s = await sheetEnv(['cube_BBBB02']);
    await s.tap({ 'data-pr-act': 'kind', 'data-pr-val': 'none' });
    ok('a failed Nothing owed puts the error on step 1 (the sheet that is showing)', /id="prErr"[^>]*>[^<]*2 of 3 saved/.test(s.body()), s.body().slice(0, 600));
    ok('...and the sheet stays open', s.sheet.hidden === false);
    const okIds = s.calls.filter((c) => c.data.action === 'handled').map((c) => c.data.id).sort();
    ok('every call was tried (no stop at the first failure)', okIds.join() === 'cube_AAAA01,cube_BBBB02,cube_CCCC03', JSON.stringify(okIds));
    ok('...and the error says how many saved', /2 of 3/.test(s.body()), s.body().slice(0, 600));
    s.calls.length = 0; s.failSet.clear();
    await s.tap({ 'data-pr-act': 'kind', 'data-pr-val': 'none' });
    const again = s.calls.filter((c) => c.data.action === 'handled').map((c) => c.data.id);
    ok('a retry asks only for the one that did not save', again.length === 1 && again[0] === 'cube_BBBB02', JSON.stringify(again));
    ok('...and a full success closes the sheet', s.sheet.hidden === true);
  }
  {
    const s = await sheetEnv([]);
    s.hold();
    await s.tap({ 'data-pr-act': 'kind', 'data-pr-val': 'none' });
    ok('while saving, the sheet shows a busy state', /Saving/.test(s.body()) && /disabled/.test(s.body()), s.body().slice(0, 500));
    const before = s.calls.length;
    await s.tap({ 'data-pr-act': 'kind', 'data-pr-val': 'none' });
    ok('a second tap while saving does not close the sheet', s.sheet.hidden === false);
    ok('...and does not send the writes twice', s.calls.length === before, 'before=' + before + ' after=' + s.calls.length);
    s.release(); await flush();
    ok('control: once the saves land the sheet closes', s.sheet.hidden === true);
  }

  // ═══ H4: Call Center Handled repaints Home / Today ══════════════════════
  console.log('\nH4. a Call Center Handled updates Home at once');
  {
    const calls = [], toasts = [], rendered = [];
    const env = sandbox({
      _user: { uid: 'u1' }, _userClaims: {}, db: {}, _leads: [], CSS: { escape: (s) => String(s) },
      showToast(m, t) { toasts.push(typeof m === 'string' ? { message: m, type: t } : m); },
      NBDHomeAttention: { lastRows: [], render(f) { rendered.push(f); } },
      _functions: {}, _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: name === 'callPromisesList' ? { items: [], counts: {} } : { ok: true } }; },
    });
    const target = fakeEl('scroll');
    env.doc.querySelector = (sel) => (sel === '#view-calls .view-scroll' ? target : null);
    load(env, 'docs/pro/js/call-center-view.js');
    const CC = env.win.NBDCallCenter;
    CC._state.calls.push(clone(cA), clone(cB));
    const click = async (attrs) => { for (const fn of env.doc._l.click || []) await fn({ target: { closest: (sel) => (/data-cc/.test(sel) ? { getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: (x) => (x === '#view-calls' ? {} : null) } : null) } }); await flush(); };
    await click({ 'data-cc': 'handled', 'data-id': 'cube_AAAA01' });
    ok('Handled in the Call Center asks Home to re-read (render(true))', rendered.indexOf(true) !== -1, JSON.stringify(rendered));
    const ut = toasts.filter((x) => typeof x.undoAction === 'function')[0];
    ok('...with an Undo toast', !!ut, JSON.stringify(toasts));
    calls.length = 0; rendered.length = 0;
    if (ut) await ut.undoAction();
    await flush();
    ok('Undo there is the server\'s unhandled, and Home re-reads again', calls.some((c) => c.data.action === 'unhandled' && c.data.id === 'cube_AAAA01') && rendered.indexOf(true) !== -1, JSON.stringify({ calls, rendered }));
    rendered.length = 0; calls.length = 0;
    await click({ 'data-cc': 'handledgroup', 'data-ids': 'cube_AAAA01,cube_BBBB02', 'data-id': 'cube_AAAA01' });
    ok('Handled (all N) repaints Home too', rendered.indexOf(true) !== -1 && calls.filter((c) => c.data.action === 'handled').length === 2, JSON.stringify({ rendered, n: calls.length }));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
