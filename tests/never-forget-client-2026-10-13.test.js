/**
 * tests/never-forget-client-2026-10-13.test.js — the CLIENT-side open findings
 * of documentation/qa/never-forget-2026-10-13/FINDINGS.md, each proven with a
 * test that fails on main before the fix:
 *
 *   H4  a promise saved from a call's sheet is on Today at once (task cache +
 *       the call row), not "after a leads refresh"
 *   M1  Home reads by DATE (the 45-day promise window), not by a 200-row cap,
 *       and says when it is capped; old promises are read separately
 *   M2  the Call Center never renders a failed read as "nothing needs you"
 *       (and neither does Today)
 *   M3  a Waiting item ripens on its "Nudge me on" date, not on the clock
 *   M4  Today counts PEOPLE in Waiting (one row per person, items inside)
 *   M5  the Home mirror of callNeedsYou / callerKey / resurfacedNumbers /
 *       oldPromiseCount agrees with functions/call-watch-logic.js over a wide
 *       seeded fuzz (labels, missed calls, buckets, reach, texts, kept stamps)
 *
 * Harnesses: the real browser files run in a vm sandbox with a tiny DOM and a
 * where()-honouring Firestore fake. Run: node tests/never-forget-client-2026-10-13.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));
const SW = require(path.join(ROOT, 'docs/pro/js/schedule-window.js'));
const PL = require(path.join(ROOT, 'docs/pro/js/promise-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const DAY = 86400000;
const NOW = Date.now();
const TODAY = PL.ymdLocal(NOW);

// ── a tiny browser: just enough DOM for the files under test ────────────
function fakeEl(id) {
  const stubs = {};
  const el = {
    id: id || '', hidden: false, className: '', innerHTML: '', textContent: '', _l: {},
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
    appendChild() {}, focus() {}, setAttribute(k, v) { el['_a_' + k] = v; }, getAttribute(k) { return el['_a_' + k] || null; },
    querySelector(sel) { return stubs[sel] || (stubs[sel] = fakeEl('')); },
    querySelectorAll() { return []; },
    closest() { return null; },
    classList: { toggle() {}, add() {}, remove() {} },
  };
  return el;
}
function sandbox(extra) {
  const els = {};
  const events = [];
  const doc = {
    readyState: 'complete', activeElement: null,
    getElementById: (id) => els[id] || null,
    createElement: () => fakeEl(''),
    body: { appendChild(e) { if (e.id) els[e.id] = e; } },
    _l: {}, addEventListener(t, f) { (doc._l[t] = doc._l[t] || []).push(f); }, querySelector: () => null, querySelectorAll: () => [],
    contains: () => true,
  };
  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }
  const win = {
    document: doc, els, events, CustomEvent, console, setTimeout: () => 0, clearTimeout() {}, Promise, Date, Object, String, Number, Array, JSON, RegExp, Math, Set, Map,
    location: { hash: '', search: '', pathname: '/pro/dashboard.html' },
    addEventListener() {},
    dispatchEvent(ev) { events.push({ type: ev.type, detail: ev.detail, cache: JSON.stringify(win._taskCache || {}) }); return true; },
  };
  win.window = win;
  Object.assign(win, extra || {});
  return { win, ctx: vm.createContext(win), els, events, doc };
}
function load(env, rel) { vm.runInContext(read(rel), env.ctx, { filename: rel }); }

// A Firestore fake that honours where (== >= <) / orderBy / limit.
function fakeFirestore(data) {
  const reads = [];
  return {
    reads,
    collection: (_db, name) => ({ name }),
    where: (f, op, v) => ({ t: 'w', f, op, v }),
    orderBy: (f, dir) => ({ t: 'o', f, dir: dir || 'asc' }),
    limit: (n) => ({ t: 'l', n }),
    query: (col, ...cs) => ({ col, cs }),
    getDocs: async (q) => {
      reads.push({ name: q.col.name, cs: q.cs });
      let rows = (data[q.col.name] || []).slice();
      if (typeof data.__fail === 'function' && data.__fail(q)) throw Object.assign(new Error('boom'), { code: 'unavailable' });
      q.cs.filter((c) => c.t === 'w').forEach((c) => {
        rows = rows.filter((r) => (c.op === '==' ? r[c.f] === c.v : c.op === '>=' ? r[c.f] >= c.v : c.op === '<' ? r[c.f] < c.v : true));
      });
      const o = q.cs.filter((c) => c.t === 'o')[0];
      if (o) rows.sort((a, b) => (o.dir === 'desc' ? b[o.f] - a[o.f] : a[o.f] - b[o.f]));
      const l = q.cs.filter((c) => c.t === 'l')[0];
      if (l) rows = rows.slice(0, l.n);
      return { docs: rows.map((r) => ({ id: r.id, data: () => r })) };
    },
  };
}

const call = (id, o) => Object.assign({ id, userId: 'u1', companyId: 'u1', startedAtMs: NOW - 3600e3, status: 'noted', direction: 'inbound', bucket: 'contact', promises: [], summary: 's', leadId: null }, o || {});
const joP = [{ who: 'jo', text: 'call back with the number' }];

(async () => {
  // ═══ H4 ═════════════════════════════════════════════════════════════
  console.log('\nH4. a promise saved from a call\'s sheet is on Today at once');
  async function savePromise(opts) {
    const calls = [];
    const env = sandbox({
      _taskCache: opts.cache || {}, _leads: opts.leads || [], _userClaims: {}, _user: { uid: 'u1' },
      showToast() {},
      NBDHomeAttention: { lastRows: opts.rows || [], render() { env.win.__rendered = true; } },
      _functions: {},
      _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: opts.reply }; },
    });
    load(env, 'docs/pro/js/promise-logic.js');
    load(env, 'docs/pro/js/promise-ui.js');
    const NP = env.win.NBDPromise;
    NP.openSheet(Object.assign({ mode: 'handle', name: 'Dana Test', callIds: ['cube_AAAAA1'] }, opts.sheet || {}));
    const sheet = env.els.prSheet;
    const tap = (attrs) => sheet._l.click.forEach((f) => f({ target: { closest: () => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) }) } }));
    tap({ 'data-pr-act': 'kind', 'data-pr-val': opts.kind || 'callback' });
    tap({ 'data-pr-act': 'save' });
    await flush(); await flush();
    return { env, calls, NP };
  }

  const lead = { id: 'L1', firstName: 'Dana', lastName: 'Test', phone: '(513) 555-0111' };
  const task = await savePromise({
    leads: [lead], sheet: { leadId: 'L1', lead }, reply: { ok: true, on: 'task', taskId: 'promise-cube_AAAAA1', dueDate: TODAY },
  });
  const cached = ((task.env.win._taskCache || {}).L1 || []).filter((t) => t.id === 'promise-cube_AAAAA1')[0];
  ok('the server answered on:task and the sheet asked callCenterAction once', task.calls.length === 1 && task.calls[0].data.action === 'promise');
  ok('the saved promise task is in the task cache Today reads (no leads refresh needed)', !!cached && cached.kind === 'promise' && cached.promiseKind === 'callback' && cached.done === false && cached.dueDate === TODAY,
    JSON.stringify(task.env.win._taskCache));
  const plan = TP.buildTodayPlan({ now: NOW, leads: [lead], SW, tasksByLead: task.env.win._taskCache, callGroups: [], waitingDays: 3 });
  ok('Today\'s plan lists it as a Promise row for that person', plan.promises.length === 1 && plan.promises[0].leadId === 'L1' && plan.promises[0].promiseTasks[0].id === 'promise-cube_AAAAA1', JSON.stringify(plan.promises));
  const refreshed = task.env.events.filter((e) => e.type === 'nbd:data-refreshed');
  ok('Today is told to repaint AFTER the cache holds it', refreshed.length > 0 && /promise-cube_AAAAA1/.test(refreshed[refreshed.length - 1].cache));
  ok('the call strip is still re-read', task.env.win.__rendered === true);

  // Same, when the sheet knows only the call (no leadId passed): resolve it from the call row.
  const rows2 = [call('cube_AAAAA1', { leadId: 'L2', phoneDigits: '5135550123' })];
  const viaCall = await savePromise({ rows: rows2, sheet: { leadId: '' }, reply: { ok: true, on: 'task', taskId: 'promise-cube_AAAAA1', dueDate: TODAY } });
  ok('with no lead id on the sheet the call row names the customer', ((viaCall.env.win._taskCache || {}).L2 || []).some((t) => t.id === 'promise-cube_AAAAA1'), JSON.stringify(viaCall.env.win._taskCache));

  // An unfiled call: the promise rides on the call doc and the call stays open.
  const rows3 = [call('cube_AAAAA1', { phoneDigits: '5135550177', bucket: 'unknown', startedAtMs: NOW - 3600e3 })];
  const onCall = await savePromise({ rows: rows3, sheet: { leadId: '' }, reply: { ok: true, on: 'call', dueDate: TODAY } });
  const row = onCall.env.win.NBDHomeAttention.lastRows[0];
  ok('an unfiled call carries the promise on its row at once', !!row.promise && row.promise.kind === 'promise' && row.promise.promiseKind === 'callback' && row.followUpDate === TODAY && !row.handledAtMs, JSON.stringify(row));
  const calledPlan = TP.buildTodayPlan({ now: NOW, leads: [], SW, tasksByLead: {}, callGroups: HA.groupNeeds(onCall.env.win.NBDHomeAttention.lastRows, NOW), waitingDays: 3 });
  ok('...and Today shows it on the call row', calledPlan.calls.length === 1 && !!calledPlan.calls[0].promise && calledPlan.calls[0].promise.callId === 'cube_AAAAA1');

  // A re-chosen promise must not erase its miss history in the cache.
  const hist = await savePromise({
    leads: [lead], cache: { L1: [{ id: 'promise-cube_AAAAA1', kind: 'promise', promiseKind: 'estimate', missCount: 2, rescheduleCount: 1, madeYmd: '2026-10-01', done: false, dueDate: '2026-10-08' }] },
    sheet: { leadId: 'L1', lead }, reply: { ok: true, on: 'task', taskId: 'promise-cube_AAAAA1', dueDate: TODAY },
  });
  const h = hist.env.win._taskCache.L1.filter((t) => t.id === 'promise-cube_AAAAA1')[0];
  ok('choosing again keeps missCount / madeYmd (server keeps them too)', h.missCount === 2 && h.madeYmd === '2026-10-01' && h.promiseKind === 'callback' && h.dueDate === TODAY, JSON.stringify(h));

  // The whole flow on Today: tap Handled on the call, choose, save. The row key
  // the optimistic "handled" set remembers ('lead:<id>') is ALSO the promise
  // row's key - hiding it until a reload was the live form of this bug.
  {
    const leadF = { id: 'L7', firstName: 'Flow', lastName: 'Cust', phone: '(513) 555-0707' };
    const rowsF = [call('cube_FLOW01', { leadId: 'L7', phoneDigits: '5135550707', bucket: 'customer', urgent: true, summary: 'flow call' })];
    const haF = { lastRows: rowsF, lastCounts: {}, groupNeeds: HA.groupNeeds, callerKey: HA.callerKey, hiddenPeople: HA.hiddenPeople, render() {} };
    const env = sandbox({
      _user: { uid: 'u1' }, _userClaims: {}, _leads: [leadF], _leadsLoaded: true, _taskCache: {}, showToast() {},
      NBDTasks: { loaded: () => true }, NBDTodayPlan: TP, NBDHomeAttention: haF,
      _functions: {}, _httpsCallable: () => async () => ({ data: { ok: true, on: 'task', taskId: 'promise-cube_FLOW01', dueDate: TODAY } }),
      ScriptLoader: { bundles: {}, loadBundle: async () => { load(env, 'docs/pro/js/promise-logic.js'); load(env, 'docs/pro/js/promise-ui.js'); } },
    });
    env.els.todayPlan = fakeEl('todayPlan');
    load(env, 'docs/pro/js/today-home.js');
    await flush(); await flush();
    env.win.NBDToday.render();
    const before = env.els.todayPlan.innerHTML;
    const tapTp = async (attrs) => { for (const fn of env.doc._l.click || []) await fn({ target: { closest: (sel) => (/data-tp-act/.test(sel) ? { getAttribute: (k) => (k in attrs ? attrs[k] : null) } : null) } }); await flush(); await flush(); };
    await tapTp({ 'data-tp-act': 'handled', 'data-tp-key': 'lead:L7' });
    const sheet = env.els.prSheet;
    const tapPr = (attrs) => sheet._l.click.forEach((fn) => fn({ target: { closest: () => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) }) } }));
    tapPr({ 'data-pr-act': 'kind', 'data-pr-val': 'callback' });
    tapPr({ 'data-pr-act': 'save' });
    await flush(); await flush(); await flush();
    env.win.NBDToday.render();
    const after = env.els.todayPlan.innerHTML;
    ok('control: the call was on Today as a Calls-owed row before', /data-tp-sec="calls"/.test(before) && /Flow Cust/.test(before));
    ok('after Handled -> promise -> Save, the promise is a Promises row on Today (not hidden by the handled set)', /data-tp-sec="promises"/.test(after) && /tp-promise/.test(after) && /data-tp-act="pkept"/.test(after), after.slice(0, 500));
    ok('...and the call is no longer listed as owed', !/data-tp-sec="calls"/.test(after));
  }

  // ═══ M1 Home read window ════════════════════════════════════════════
  console.log('\nM1. Home reads by date (45 days), is bounded, and says when capped');
  async function homeStrip(data, claims) {
    const fb = fakeFirestore(data);
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: claims || {}, db: {} }, fb));
    env.els.homeAttention = fakeEl('homeAttention');
    load(env, 'docs/pro/js/home-attention.js');
    const api = env.win.NBDHomeAttention;
    await api.render(true);
    return { api, fb, strip: env.els.homeAttention, env };
  }
  // 250 saved-contact calls from the last 9 days (no need), one 20-day-old promise, one 60-day-old promise.
  const noise = [];
  for (let i = 0; i < 250; i++) noise.push(call('n' + i, { startedAtMs: NOW - (1 + (i % 9)) * DAY - i * 1000, bucket: 'contact', callType: 'sub', phoneDigits: '51355' + String(50000 + i).slice(0, 5) }));
  const p20 = call('p20', { startedAtMs: NOW - 20 * DAY, promises: joP, leadId: 'L9', phoneDigits: '5135550909', bucket: 'customer' });
  const p60 = call('p60', { startedAtMs: NOW - 60 * DAY, promises: joP, leadId: 'L8', phoneDigits: '5135550808', bucket: 'customer' });
  const h1 = await homeStrip({ phone_calls: noise.concat([p20, p60]), phone_text_days: [] });
  ok('a 20-day-old open promise counts even behind 250 newer calls', h1.api.lastCounts.calls === 1, 'calls=' + h1.api.lastCounts.calls);
  ok('the 60-day-old promise is counted as an old promise, from its own bounded read', h1.api.lastCounts.oldPromises === 1, 'old=' + h1.api.lastCounts.oldPromises);
  const callReads = h1.fb.reads.filter((r) => r.name === 'phone_calls');
  const win = callReads.filter((r) => r.cs.some((c) => c.t === 'w' && c.f === 'startedAtMs' && c.op === '>='));
  ok('the window read is bounded by the 45-day date, not just a row cap', win.length === 1 && Math.abs(win[0].cs.filter((c) => c.f === 'startedAtMs' && c.op === '>=')[0].v - (NOW - 45 * DAY)) < 60000);
  ok('...and keeps a row cap as a safety bound', win[0] && win[0].cs.some((c) => c.t === 'l' && c.n >= 200 && c.n <= 2000));
  ok('old promises come from a second read of rows BEFORE the window (bounded)', callReads.some((r) => r.cs.some((c) => c.t === 'w' && c.op === '<') && r.cs.some((c) => c.t === 'l')));
  ok('not capped: no "showing newest" warning', !h1.api.lastCounts.callsCapped && !/newest/.test(h1.strip.innerHTML));

  const cap = (h1.api.READ || {}).recentCalls || 0;
  const flood = [];
  for (let i = 0; i < cap + 5; i++) flood.push(call('f' + i, { startedAtMs: NOW - 2 * DAY - i * 1000, callType: 'sub', phoneDigits: '5135559' + String(i).padStart(3, '0') }));
  const h2 = await homeStrip({ phone_calls: flood, phone_text_days: [] });
  ok('a read that hits the cap says so: "showing newest N" with the number', cap >= 200 && h2.api.lastCounts.callsCapped === true && new RegExp('newest ' + cap).test(h2.strip.innerHTML), 'cap=' + cap + ' html=' + h2.strip.innerHTML.slice(0, 300));
  const h3 = await homeStrip({ phone_calls: [p20], phone_text_days: [], __fail: (q) => q.cs.some((c) => c.t === 'w' && c.op === '<') });
  ok('a failed old-promise read is a warning, never silence', h3.api.lastCounts.oldFailed === true && /old promises/i.test(h3.strip.innerHTML) && /not an all-clear|could not/i.test(h3.strip.innerHTML), h3.strip.innerHTML);
  ok('...and does not hide the people the window read did find', h3.api.lastCounts.calls === 1);

  // A forced refresh asked for while one is in flight is not dropped.
  {
    const fb = fakeFirestore({ phone_calls: [], phone_text_days: [] });
    let release = null, windowReads = 0;
    const gate = new Promise((r) => { release = r; });
    const slow = Object.assign({}, fb, {
      getDocs: async (q) => {
        if (q.col.name === 'phone_calls' && q.cs.some((c) => c.t === 'w' && c.op === '>=')) { windowReads++; if (windowReads === 1) await gate; }
        return fb.getDocs(q);
      },
    });
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: {}, db: {}, setTimeout: (fn, ms) => (ms === 0 ? setTimeout(fn, 0) : 0) }, slow));
    env.els.homeAttention = fakeEl('homeAttention');
    load(env, 'docs/pro/js/home-attention.js');
    const api = env.win.NBDHomeAttention;
    const first = api.render(true);          // in flight, parked on the gate
    await flush();
    await api.render(true);                  // asked for while busy: must be remembered
    release();
    await first; await flush(); await flush(); await flush();
    ok('a forced refresh requested mid-read runs once the first read ends (was silently dropped)', windowReads === 2, 'window reads=' + windowReads);
  }

  // ═══ M2 Call Center failed reads ════════════════════════════════════
  console.log('\nM2. failed reads are never an all-clear');
  async function callCenter(data, claims) {
    const fb = fakeFirestore(data);
    const env = sandbox(Object.assign({
      _user: { uid: 'u1' }, _userClaims: claims || {}, db: {}, _leads: [], CSS: { escape: (s) => String(s) },
      _functions: {}, _httpsCallable: (_f, name) => async () => ({ data: name === 'callPromisesList' ? { items: [], counts: {} } : { ok: true } }),
    }, fb));
    const target = fakeEl('scroll');
    env.doc.querySelector = (sel) => (sel === '#view-calls .view-scroll' ? target : null);
    load(env, 'docs/pro/js/home-attention.js');
    load(env, 'docs/pro/js/call-center-view.js');
    await env.win.NBDCallCenter.reload();
    return { CC: env.win.NBDCallCenter, html: () => target.innerHTML, env };
  }
  const handledCall = call('cube_DONE1', { handledAtMs: NOW - 1000, contactName: 'Done Person', phoneDigits: '5135550301' });
  const okCC = await callCenter({ phone_calls: [handledCall], phone_text_days: [] });
  ok('control: healthy reads say "Nothing needs you" and show no warning', /Nothing needs you/.test(okCC.html()) && !/NOT an all-clear/.test(okCC.html()), okCC.html().slice(0, 400));
  const noTexts = await callCenter({ phone_calls: [handledCall], phone_text_days: [], __fail: (q) => q.col.name === 'phone_text_days' });
  ok('texts failed to load: a visible "not an all-clear" and no "Nothing needs you"', /NOT an all-clear/.test(noTexts.html()) && /texts/i.test(noTexts.html()) && !/Nothing needs you/.test(noTexts.html()), noTexts.html().slice(0, 500));
  const noCompany = await callCenter({ phone_calls: [handledCall], phone_text_days: [], __fail: (q) => q.col.name === 'phone_calls' && q.cs.some((c) => c.f === 'companyId') },
    { role: 'company_admin', companyId: 'co1' });
  ok('the team (company) read failing is shown too', /NOT an all-clear/.test(noCompany.html()) && !/Nothing needs you/.test(noCompany.html()), noCompany.html().slice(0, 500));
  const noCalls = await callCenter({ phone_calls: [], phone_text_days: [], __fail: (q) => q.col.name === 'phone_calls' });
  ok('calls failed with nothing else: the error, not "No calls yet"', /Could not load/.test(noCalls.html()) && !/No calls yet/.test(noCalls.html()));
  const withNeeds = await callCenter({ phone_calls: [call('cube_NEED1', { urgent: true, contactName: 'Needs Jo', phoneDigits: '5135550302' })], phone_text_days: [], __fail: (q) => q.col.name === 'phone_text_days' });
  ok('people who DO need you still list, with the warning above them', /Needs Jo/.test(withNeeds.html()) && /NOT an all-clear/.test(withNeeds.html()));
  ok('the warning has a Try again control', /data-cc="reload"/.test(noTexts.html()));

  const many = [];
  for (let i = 0; i < 305; i++) many.push(call('m' + i, { startedAtMs: NOW - 2 * DAY - i * 60000, handledAtMs: NOW - DAY, phoneDigits: '5135558' + String(100 + i).slice(0, 3) }));
  const capped = await callCenter({ phone_calls: many, phone_text_days: [] });
  ok('the newest-300 read hit its cap inside the 45-day window: the list says what it is missing', /Showing only your newest 300/.test(capped.html()) && /Home counts it/.test(capped.html()), capped.html().slice(0, 300));
  ok('...and a healthy small list shows no cap note', !/Showing only your newest/.test(okCC.html()));

  // Today: the same class of bug (a failed calls read painted "Nothing on the list").
  async function todayHtml(ha) {
    const env = sandbox({
      _user: { uid: 'u1' }, _userClaims: {}, _leads: [], _leadsLoaded: true, _taskCache: {},
      NBDTasks: { loaded: () => true }, NBDTodayPlan: TP, NBDHomeAttention: ha,
    });
    env.els.todayPlan = fakeEl('todayPlan');
    load(env, 'docs/pro/js/today-home.js');
    env.win.NBDToday.render();
    return env.els.todayPlan.innerHTML;
  }
  const failedHtml = await todayHtml({ groupNeeds: () => [], lastRows: [], lastCounts: { callsFailed: true }, callerKey: HA.callerKey });
  ok('Today: a failed calls read says so and is not "Nothing on the list"', /could not check your calls/i.test(failedHtml) && /NOT an all-clear/.test(failedHtml) && !/Go knock some doors/.test(failedHtml), failedHtml.slice(0, 400));
  const healthyHtml = await todayHtml({ groupNeeds: () => [], lastRows: [], lastCounts: {}, callerKey: HA.callerKey });
  ok('Today: control - a healthy empty day still says "Nothing on the list"', /Go knock some doors/.test(healthyHtml) && !/NOT an all-clear/.test(healthyHtml));

  // ═══ M3 Waiting ripens on its date ══════════════════════════════════
  console.log('\nM3. a Waiting item ripens on its "Nudge me on" date');
  const wt = (id, since, dueDate, o) => Object.assign({ id, kind: 'promise', promiseKind: 'waiting', done: false, waitingOn: 'adjuster', waitingSince: since, dueDate, nudgeCount: 0 }, o || {});
  const T = TODAY;
  const d = (n) => PL.addDaysYmd(T, n);
  ok('picked a date a week out: NOT ripe after 3 days (the clock used to ripen it)', !PL.isRipe(wt('a', d(-4), d(7)), T, 3));
  ok('picked a date a week out: ripe when the date arrives', PL.isRipe(wt('a', d(-8), d(0)), T, 3));
  ok('picked "Today" a day after waiting began: ripe now, not at day 3', PL.isRipe(wt('a', d(-1), d(0)), T, 3));
  ok('date in the past is ripe', PL.isRipe(wt('a', d(-9), d(-2)), T, 3));
  ok('no date at all (legacy): the N-day clock still applies', !PL.isRipe(wt('a', d(-2), undefined), T, 3) && PL.isRipe(wt('a', d(-3), undefined), T, 3) && !PL.isRipe(wt('a', d(-3), undefined), T, 5));
  ok('done / dead is never ripe even past its date', !PL.isRipe(wt('a', d(-9), d(-2), { done: true }), T, 3));
  const L = [{ id: 'Gus', firstName: 'Gus', lastName: 'Test', phone: '(513) 555-0144' }];
  const bp = (tasks, extra) => TP.buildTodayPlan(Object.assign({ now: NOW, leads: L, SW, tasksByLead: { Gus: tasks }, callGroups: [], waitingDays: 3 }, extra));
  ok('the Today plan holds a future-dated item back and counts it as pending', (() => { const q = bp([wt('w1', d(-5), d(4))]); return q.waiting.length === 0 && q.waitingPending === 1; })());
  ok('...and lists it the day its date arrives', bp([wt('w1', d(-5), d(0))]).waiting.length === 1);

  // ═══ M4 Waiting counts PEOPLE ═══════════════════════════════════════
  console.log('\nM4. Waiting counts people, not tasks');
  const two = [wt('w1', d(-6), d(-1), { waitingOn: 'adjuster' }), wt('w2', d(-5), d(-1), { waitingOn: 'supplier' })];
  const one = bp(two);
  ok('two ripe items for one customer: ONE person row holding both items', Array.isArray(one.waitingPeople) && one.waitingPeople.length === 1 && one.waitingPeople[0].items.length === 2 && one.waiting.length === 2, JSON.stringify(one.waitingPeople));
  const pend = bp([wt('w1', d(-1), d(5)), wt('w2', d(-1), d(6))]);
  ok('pending counts people: two unripe items for one customer = 1', pend.waitingPending === 1, 'pending=' + pend.waitingPending);
  const two2 = TP.buildTodayPlan({ now: NOW, leads: L.concat([{ id: 'Eli', firstName: 'Eli', lastName: 'Test', phone: '(513) 555-0122' }]), SW, tasksByLead: { Gus: two, Eli: [wt('w3', d(-4), d(-1), { waitingOn: 'customer' })] }, callGroups: [], waitingDays: 3 });
  ok('two customers: two person rows, oldest wait first', (two2.waitingPeople || []).length === 2 && two2.waitingPeople[0].leadId === 'Gus');
  ok('the flat item list is unchanged for the Nudge / Still waiting handlers', two2.waiting.length === 3 && two2.waiting.every((r) => r.taskId && r.leadId));

  const html = await (async () => {
    const env = sandbox({
      _user: { uid: 'u1' }, _userClaims: {}, _leads: L, _leadsLoaded: true, _taskCache: { Gus: two },
      NBDTasks: { loaded: () => true }, NBDTodayPlan: TP, NBDPromise: { waitingDays: () => 3 },
      NBDHomeAttention: { groupNeeds: () => [], lastRows: [], lastCounts: {}, callerKey: HA.callerKey },
    });
    env.els.todayPlan = fakeEl('todayPlan');
    load(env, 'docs/pro/js/today-home.js');
    env.win.NBDToday.render();
    return env.els.todayPlan.innerHTML;
  })();
  const sec = (/data-tp-sec="waiting">([\s\S]*?)(?=<div class="tp-sec"|$)/.exec(html) || [])[1] || '';
  ok('the Waiting header count is 1 (one person), not 2', /Waiting on them <span class="tp-count">1<\/span>/.test(sec), sec.slice(0, 300));
  ok('...with a Nudge button per item inside that person\'s row', (sec.match(/data-tp-act="pnudge"/g) || []).length === 2 && (sec.match(/data-tp-row=/g) || []).length === 1);
  ok('the stepper says it sets the default for new items', /new items/i.test(sec) || /new items/i.test(html));

  // The handled set is keyed by row key; the Calls row and the promise row of one customer must not share one.
  {
    const callOnly = HA.groupNeeds([call('cube_KEY1', { leadId: 'Gus', phoneDigits: '5135550144', urgent: true })], NOW);
    const q0 = TP.buildTodayPlan({ now: NOW, leads: L, SW, tasksByLead: {}, callGroups: callOnly, waitingDays: 3 });
    const callKey = q0.calls[0] && q0.calls[0].key;
    const q1 = TP.buildTodayPlan({ now: NOW, leads: L, SW, tasksByLead: { Gus: [Object.assign({ id: 'pk', kind: 'promise', promiseKind: 'callback', text: 'Call back', done: false, dueDate: PL.ymdLocal(NOW) })] }, callGroups: [], waitingDays: 3, handled: new Set([callKey]) });
    ok('control: the Calls-owed row is keyed by the customer', /^lead:Gus$/.test(callKey || ''), String(callKey));
    ok("a promise that appears AFTER Jo handled that customer's call is not hidden by the handled set", q1.promises.length === 1 && q1.promises[0].key !== callKey, JSON.stringify(q1.promises.map((r) => r.key)));
    const q2 = TP.buildTodayPlan({ now: NOW, leads: L, SW, tasksByLead: { Gus: [{ id: 't', text: 'Plain', dueDate: PL.ymdLocal(NOW), done: false }] }, callGroups: [], waitingDays: 3, handled: new Set([callKey]) });
    ok('same for an ordinary promised follow-up', q2.promised.length === 1);
  }

  // Promise rows are people already: pin it.
  const prom = (id, o) => Object.assign({ id, kind: 'promise', promiseKind: 'estimate', text: 'Send estimate', done: false, dueDate: T, missCount: 0, rescheduleCount: 0 }, o || {});
  const pp = bp([prom('p1'), prom('p2', { promiseKind: 'callback' })]);
  ok('Promises: two promises for one customer is ONE row (a person)', pp.promises.length === 1 && pp.promises[0].promiseTasks.length === 2 && pp.total === 1);

  // ═══ M5 rule parity fuzz ════════════════════════════════════════════
  console.log('\nM5. Home mirror vs functions/call-watch-logic.js (seeded fuzz)');
  let seed = 20261013;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const nums = ['5135550101', '5135550102', '5135550103', '5135550104', '5135550105', '5135550106'];
  const kinds = ['spam', 'personal', 'insurance', 'sub', 'supplier', 'customer'], pols = ['hide', 'quiet', 'surface', 'bogus', ''];
  // Rules the server lane added (fix/never-forget-server-findings): a rider promise
  // on the call doc, and label stamps beyond a day in the future being ignored. They
  // are fuzzed as soon as functions/call-watch-logic.js exports them, so the Home mirror
  // cannot fall behind once that lands - and this file is green on both sides of the merge.
  const hasRider = typeof W.ridingPromiseOpen === 'function', hasSane = typeof W.saneStampMs === 'function';
  let rows = 0, diffRule = 0, diffKey = 0, diffRes = 0, diffOld = 0, diffReach = 0;
  for (let trial = 0; trial < 400; trial++) {
    const set = [];
    const n = 3 + Math.floor(rnd() * 14);
    for (let i = 0; i < n; i++) {
      const age = pick([0.05, 0.5, 1, 3, 10, 13.9, 14.1, 20, 44, 46, 80]);
      set.push({
        id: 'c' + trial + '_' + i, startedAtMs: NOW - age * DAY, phoneDigits: pick(nums.concat(['', '12'])), leadId: rnd() < 0.3 ? pick(['L1', 'L2']) : null,
        channel: rnd() < 0.2 ? 'text' : 'call', status: pick(['noted', 'short', 'short', 'personal', 'stored']), direction: pick(['inbound', 'inbound', 'outbound']),
        bucket: pick(['customer', 'insurance', 'unknown', 'contact', '']), callType: pick(['', '', 'spam', 'sub', 'supplier', 'insurance']),
        urgent: rnd() < 0.15, taskDone: rnd() < 0.08, handledAtMs: rnd() < 0.15 ? NOW - DAY : 0,
        followUpDate: pick(['', '', W.etYmd(NOW - 2 * DAY), W.etYmd(NOW), W.etYmd(NOW + 3 * DAY)]),
        promises: pick([[], [], joP, [{ who: 'them', text: 'x' }], [{ who: 'jo', text: 'a', keptAtMs: NOW - DAY }], [{ who: 'jo', text: 'a', keptAtMs: NOW - DAY }, { who: 'jo', text: 'b' }]]),
      });
      if (hasRider && rnd() < 0.25) {
        set[set.length - 1].promise = pick([
          { kind: 'promise', promiseKind: 'callback', dueDate: W.etYmd(NOW), done: false },
          { kind: 'promise', promiseKind: 'estimate', dueDate: W.etYmd(NOW + 3 * DAY), done: false },
          { kind: 'promise', promiseKind: 'callback', dueDate: W.etYmd(NOW - 3 * DAY), done: true },
          { kind: 'promise', promiseKind: 'callback', dueDate: W.etYmd(NOW - 2 * DAY), keptAtMs: NOW - DAY },
          { kind: 'note' },
        ]);
      }
    }
    const labels = {};
    nums.forEach((dg) => { if (rnd() < 0.4) labels[dg] = { kind: pick(kinds), policy: pick(pols), ackAtMs: rnd() < 0.3 ? NOW - 2 * DAY : (hasSane && rnd() < 0.1 ? NOW + pick([2, 400]) * DAY : 0), updatedAtMs: hasSane && rnd() < 0.05 ? NOW + 30 * DAY : NOW - pick([1, 5, 30]) * DAY }; });
    const useLabels = rnd() < 0.8;
    const cw = W.reachIndex(set), ch = HA.reachIndex(set);
    if (useLabels) { cw.labels = labels; ch.labels = labels; }
    set.forEach((c) => {
      rows++;
      if (W.callNeedsYou(c, NOW, cw) !== HA.callNeedsYou(c, NOW, ch)) diffRule++;
      if (W.callerKey(c) !== HA.callerKey(c)) diffKey++;
    });
    if (JSON.stringify(Array.from(cw.reachedAt.entries()).sort()) !== JSON.stringify(Array.from(ch.reachedAt.entries()).sort())) diffReach++;
    const strip = (r) => JSON.stringify((r || []).map((v) => [v.digits, v.reason, v.base, v.calls.map((c) => c.id)]).sort());
    if (strip(W.resurfacedNumbers(set, useLabels ? labels : null, NOW)) !== strip(HA.resurfacedNumbers(set, useLabels ? labels : null, NOW))) diffRes++;
    if (W.oldPromiseCount(set, NOW) !== HA.oldPromiseCount(set, NOW)) diffOld++;
  }
  ok('callNeedsYou: 0 differences over ' + rows + ' fuzzed rows (labels, reach, kept stamps, texts, buckets)', diffRule === 0, diffRule + ' differ');
  ok('callerKey: 0 differences', diffKey === 0, diffKey + ' differ');
  ok('reachIndex: identical reach maps on every set', diffReach === 0, diffReach + ' differ');
  ok('resurfacedNumbers: identical output on every set', diffRes === 0, diffRes + ' differ');
  ok('oldPromiseCount: 0 differences', diffOld === 0, diffOld + ' differ');
  ok('both sides export the same shared-rule surface (a new rule function must land on both)', ['callNeedsYou', 'callerKey', 'reachIndex', 'resurfacedNumbers', 'isMissedCall', 'oldPromiseCount', 'isOldPromise']
    .every((k) => typeof W[k] === 'function' && typeof HA[k] === 'function'));
  ok('the window constants agree', /const CALL_WINDOW = 14 \* DAY;/.test(read('docs/pro/js/home-attention.js')) && W.CALL_WINDOW === 14 * DAY && /const PROMISE_WINDOW = 45 \* DAY;/.test(read('docs/pro/js/home-attention.js')) && W.PROMISE_WINDOW === 45 * DAY);
  // Fuzz sensitivity control: the harness must be able to see a one-line rule change.
  const mutated = read('docs/pro/js/home-attention.js').replace("if (c.urgent === true) return true;", "if (c.urgent === true && false) return true;");
  const mh = {}; vm.runInNewContext('var module={exports:{}};' + mutated + ';result=module.exports;', mh);
  let seen = 0;
  for (let i = 0; i < 200; i++) { const c = call('m' + i, { urgent: true, startedAtMs: NOW - 3600e3 }); if (W.callNeedsYou(c, NOW) !== mh.result.callNeedsYou(c, NOW)) seen++; }
  ok('control: the parity comparison reddens when the Home rule is changed', seen > 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
