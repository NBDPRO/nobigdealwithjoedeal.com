/**
 * tests/home-strip-failed-reads-2026-10-13.test.js
 *
 * The Home strip and Today must never render a FAILED read as zero / "nothing"
 * (documentation/audit/NEVER-FORGET-CLIENT-FINDINGS-2026-10-13.md, "Seen but
 * not changed"):
 *
 *   A. the strip: Stripe, yard signs and review-ask reads. failed -> an
 *      explicit "NOT an all-clear" item with a retry; slow (pending) -> no
 *      warning; genuinely empty -> quiet (positive controls on every absence
 *      assertion).
 *   B. Today: failed appointment / invoice / Stripe reads are named, the empty
 *      state is not "Nothing on the list", a failed lane never blanks the
 *      schedule.
 *   C. "N things today" counts PEOPLE: a filed customer's promise + an unfiled
 *      call from the same number is ONE row, and the call is not hidden.
 *      The strip / Call Center rule (callerKey) is the server's and unchanged.
 *
 * The real browser files run in a vm sandbox with a where()-honouring
 * Firestore fake. Run: node tests/home-strip-failed-reads-2026-10-13.test.js
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

function fakeEl(id) {
  const el = {
    id: id || '', hidden: false, className: '', innerHTML: '', textContent: '', _l: {},
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
    appendChild() {}, focus() {}, setAttribute(k, v) { el['_a_' + k] = v; }, getAttribute(k) { return el['_a_' + k] || null; },
    querySelector() { return fakeEl(''); }, querySelectorAll() { return []; }, closest() { return null; },
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
function load(env, rel) { vm.runInContext(read(rel), env.ctx, { filename: rel }); }

// where()-honouring Firestore fake. data.__fail(q) -> reject; data.__cache(q) -> served fromCache;
// data.__hold(q) -> a promise the test resolves later (a slow read).
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
      if (typeof data.__hold === 'function') { const h = data.__hold(q); if (h) await h; }
      if (typeof data.__fail === 'function' && data.__fail(q)) throw Object.assign(new Error('boom'), { code: 'unavailable' });
      let rows = (data[q.col.name] || []).slice();
      q.cs.filter((c) => c.t === 'w').forEach((c) => {
        rows = rows.filter((r) => (c.op === '==' ? r[c.f] === c.v : c.op === '>=' ? r[c.f] >= c.v : c.op === '<' ? r[c.f] < c.v : c.op === '<=' ? r[c.f] <= c.v : true));
      });
      const o = q.cs.filter((c) => c.t === 'o')[0];
      if (o) rows.sort((a, b) => (o.dir === 'desc' ? b[o.f] - a[o.f] : a[o.f] - b[o.f]));
      const l = q.cs.filter((c) => c.t === 'l')[0];
      if (l) rows = rows.slice(0, l.n);
      const fromCache = typeof data.__cache === 'function' && !!data.__cache(q);
      return { docs: rows.map((r) => ({ id: r.id, data: () => r })), metadata: { fromCache } };
    },
  };
}

const call = (id, o) => Object.assign({ id, userId: 'u1', companyId: 'u1', startedAtMs: NOW - 3600e3, status: 'noted', direction: 'inbound', bucket: 'contact', promises: [], summary: 's', leadId: null }, o || {});
const joP = [{ who: 'jo', text: 'call back with the number' }];
const isName = (n) => (q) => q.col.name === n;

(async () => {
  // ═══ A. the strip ═══════════════════════════════════════════════════
  console.log('\nA. the Home strip: a failed Stripe / yard-sign / review read is never a zero');
  // UX walk 2026-10-13 H7: an EMPTY answer from the local cache is "checking" the
  // first time (cold boot: the connection is still coming up) and a failure only
  // when it is still unconfirmed UNCONFIRMED_MS later. `again` renders a second
  // time on a fake clock 3 s later; the first answer is what a cold boot paints.
  async function strip(data, extra, again) {
    const fb = fakeFirestore(data);
    const clock = { t: Date.now() };
    class FakeDate extends Date { static now() { return clock.t; } }
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: {}, db: {}, Date: FakeDate }, fb, extra || {}));
    env.els.homeAttention = fakeEl('homeAttention');
    load(env, 'docs/pro/js/home-attention.js');
    const api = env.win.NBDHomeAttention;
    await api.render(true);
    const first = { counts: Object.assign({}, api.lastCounts), html: env.els.homeAttention.innerHTML };
    if (again) { clock.t += 3000; await api.render(true); }
    return { api, fb, strip: env.els.homeAttention, env, first };
  }
  const ledger = [{ id: 's1', companyId: 'u1', needsReview: true, kind: 'charge' }, { id: 's2', companyId: 'u1', needsReview: true, kind: 'charge' }];
  const signs = [{ id: 'y1', userId: 'u1', status: 'out', dueAt: NOW - DAY }];

  const healthy = await strip({ stripeLedger: ledger, yardSigns: signs, phone_calls: [], phone_text_days: [] });
  ok('control: healthy reads show the real counts', /2 Stripe payments need a customer/.test(healthy.strip.innerHTML) && /1 yard sign to pick up/.test(healthy.strip.innerHTML), healthy.strip.innerHTML);
  ok('control: healthy reads raise no warning and no retry', !/NOT an all-clear/.test(healthy.strip.innerHTML) && !/data-ha-retry/.test(healthy.strip.innerHTML) && !healthy.api.lastCounts.stripeFailed && !healthy.api.lastCounts.signsFailed);

  const quiet = await strip({ stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [] });
  ok('control: a genuinely empty (server-confirmed) answer stays quiet - the strip is hidden', quiet.strip.hidden === true && quiet.strip.innerHTML === '', quiet.strip.innerHTML);

  const sFail = await strip({ stripeLedger: ledger, yardSigns: signs, phone_calls: [], phone_text_days: [], __fail: isName('stripeLedger') });
  ok('a failed Stripe read is flagged (stripeFailed), not 0', sFail.api.lastCounts.stripeFailed === true);
  ok('...and the strip says it is NOT an all-clear, with a retry control', /Stripe/.test(sFail.strip.innerHTML) && /NOT an all-clear/.test(sFail.strip.innerHTML) && /data-ha-retry/.test(sFail.strip.innerHTML), sFail.strip.innerHTML);
  ok('...and does not hide the yard signs that did load', /1 yard sign to pick up/.test(sFail.strip.innerHTML));

  const yFail = await strip({ stripeLedger: ledger, yardSigns: signs, phone_calls: [], phone_text_days: [], __fail: isName('yardSigns') });
  ok('a failed yard-sign read is flagged and named', yFail.api.lastCounts.signsFailed === true && /yard sign/i.test(yFail.strip.innerHTML) && /NOT an all-clear/.test(yFail.strip.innerHTML) && /data-ha-retry/.test(yFail.strip.innerHTML), yFail.strip.innerHTML);
  ok('...and does not hide the Stripe count that did load', /2 Stripe payments/.test(yFail.strip.innerHTML));

  // Served from the local cache and empty = the server never answered.
  const cacheArgs = { stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [], __cache: (q) => q.col.name === 'stripeLedger' || q.col.name === 'yardSigns' };
  const cacheFirst = await strip(cacheArgs);
  ok('H7: the FIRST empty-from-cache answer is "checking": no failure flag, no "NOT an all-clear"', cacheFirst.api.lastCounts.stripePending === true && cacheFirst.api.lastCounts.signsPending === true && !cacheFirst.api.lastCounts.stripeFailed && !cacheFirst.api.lastCounts.signsFailed && /Checking/.test(cacheFirst.strip.innerHTML) && !/NOT an all-clear/.test(cacheFirst.strip.innerHTML), cacheFirst.strip.innerHTML);
  const cacheEmpty = await strip(cacheArgs, null, true);
  ok('an EMPTY answer served from the local cache is unconfirmed, not "none"', cacheEmpty.api.lastCounts.stripeFailed === true && cacheEmpty.api.lastCounts.signsFailed === true && /NOT an all-clear/.test(cacheEmpty.strip.innerHTML), cacheEmpty.strip.innerHTML);
  const cacheFull = await strip({ stripeLedger: ledger, yardSigns: signs, phone_calls: [], phone_text_days: [], __cache: (q) => q.col.name === 'stripeLedger' || q.col.name === 'yardSigns' });
  ok('control: a NON-empty cached answer is real data, no warning', !cacheFull.api.lastCounts.stripeFailed && /2 Stripe payments/.test(cacheFull.strip.innerHTML) && !/NOT an all-clear/.test(cacheFull.strip.innerHTML));

  // Slow is not failed: while the Stripe read is in flight the strip has not
  // been repainted at all (no false alarm), then it shows the real answer.
  {
    let release; const held = new Promise((r) => { release = r; });
    const fb = fakeFirestore({ stripeLedger: ledger, yardSigns: [], phone_calls: [], phone_text_days: [], __hold: (q) => (q.col.name === 'stripeLedger' ? held : null) });
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: {}, db: {} }, fb));
    env.els.homeAttention = fakeEl('homeAttention');
    load(env, 'docs/pro/js/home-attention.js');
    const api = env.win.NBDHomeAttention;
    const p = api.render(true);
    await flush(); await flush();
    ok('slow read: the strip shows no warning while the read is pending', !/NOT an all-clear/.test(env.els.homeAttention.innerHTML) && !api.lastCounts, env.els.homeAttention.innerHTML);
    release(); await p;
    ok('slow read: once it lands, the real count shows with no warning', /2 Stripe payments/.test(env.els.homeAttention.innerHTML) && !/NOT an all-clear/.test(env.els.homeAttention.innerHTML));
  }

  // Retry: the failed item re-reads in place (no navigation), and clears.
  {
    const data = { stripeLedger: ledger, yardSigns: [], phone_calls: [], phone_text_days: [], __fail: isName('stripeLedger') };
    const r = await strip(data);
    ok('retry setup: failing first', r.api.lastCounts.stripeFailed === true && /data-ha-retry/.test(r.strip.innerHTML));
    delete data.__fail;
    const target = { closest: (sel) => (/data-ha-retry/.test(sel) ? target : null), getAttribute: () => null };
    for (const fn of r.env.doc._l.click || []) fn({ target });
    await flush(); await flush(); await flush();
    ok('tapping the warning re-reads and shows the real answer', r.api.lastCounts.stripeFailed !== true && /2 Stripe payments/.test(r.strip.innerHTML) && !/data-ha-retry/.test(r.strip.innerHTML), r.strip.innerHTML);
    const other = { closest: () => null };
    const before = r.fb.reads.length;
    for (const fn of r.env.doc._l.click || []) fn({ target: other });
    await flush();
    ok('control: an unrelated tap does not re-read', r.fb.reads.length === before);
  }

  // Review asks wait for PAID IN FULL, judged from invoices: no invoices loaded
  // is "could not check", a genuinely empty invoice list is not.
  {
    const deck = { candidates: () => [] };
    const failedInv = await strip({ stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [] }, {
      NBDReviewDeck: deck, _leads: [], NBDRevenue: { loadInvoices: async () => [], cached: () => null },
    });
    ok('invoices did not load -> review asks flagged, not "none waiting"', failedInv.api.lastCounts.reviewsFailed === true && /review ask/i.test(failedInv.strip.innerHTML) && /NOT an all-clear/.test(failedInv.strip.innerHTML) && /data-ha-retry/.test(failedInv.strip.innerHTML), failedInv.strip.innerHTML);
    const emptyInv = await strip({ stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [] }, {
      NBDReviewDeck: deck, _leads: [], NBDRevenue: { loadInvoices: async () => [], cached: () => [] },
    });
    ok('control: a genuinely empty (cached) invoice list is not a failure', !emptyInv.api.lastCounts.reviewsFailed && !/NOT an all-clear/.test(emptyInv.strip.innerHTML));
    const thrower = await strip({ stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [] }, {
      NBDReviewDeck: { candidates: () => { throw new Error('bad lead'); } }, _leads: [], NBDRevenue: { loadInvoices: async () => [], cached: () => [] },
    });
    ok('a review-ask computation that throws is flagged, not swallowed to 0', thrower.api.lastCounts.reviewsFailed === true && /NOT an all-clear/.test(thrower.strip.innerHTML));
  }

  // ═══ B. Today ═══════════════════════════════════════════════════════
  console.log('\nB. Today: failed appointment / invoice / Stripe reads are named');
  async function todayEnv(opts) {
    const fb = fakeFirestore(opts.data || {});
    const env = sandbox(Object.assign({
      _user: { uid: 'u1' }, _userClaims: {}, _leads: opts.leads || [], _leadsLoaded: true, _taskCache: {},
      NBDTasks: { loaded: () => true }, NBDTodayPlan: TP, db: {},
      NBDHomeAttention: opts.ha || { groupNeeds: () => [], lastRows: [], lastCounts: {}, callerKey: HA.callerKey },
    }, fb, opts.extra || {}));
    env.els.todayPlan = fakeEl('todayPlan');
    load(env, 'docs/pro/js/today-home.js');
    await flush(); await flush();
    return env;
  }
  const appt = { id: 'a1', repUid: 'u1', userId: 'u1', title: 'Roof inspection', attendeeName: 'Pat Sample', startTime: NOW, endTime: NOW + 3600e3 };
  {
    const okEnv = await todayEnv({ data: { appointments: [appt] } });
    await okEnv.win.NBDToday.refreshAppointments(); okEnv.win.NBDToday.render();
    ok('control: a healthy appointments read lists the appointment, no banner', /Pat Sample/.test(okEnv.els.todayPlan.innerHTML) && !/could not load/.test(okEnv.els.todayPlan.innerHTML), okEnv.els.todayPlan.innerHTML.slice(0, 300));

    const emptyEnv = await todayEnv({ data: { appointments: [] } });
    await emptyEnv.win.NBDToday.refreshAppointments(); emptyEnv.win.NBDToday.render();
    ok('control: a confirmed-empty day still says "Nothing on the list"', /Go knock some doors/.test(emptyEnv.els.todayPlan.innerHTML) && !/NOT an all-clear/.test(emptyEnv.els.todayPlan.innerHTML));

    const bad = await todayEnv({ data: { appointments: [appt], __fail: isName('appointments') } });
    await bad.win.NBDToday.refreshAppointments(); bad.win.NBDToday.render();
    const h = bad.els.todayPlan.innerHTML;
    ok("both appointment lanes failing says so and is not an all-clear", /could not load/.test(h) && /today(&#39;|')s appointments/.test(h) && /NOT an all-clear/.test(h) && /data-tp-act="retry"/.test(h), h.slice(0, 500));
    ok('...and is not "Nothing on the list"; the headline cannot confirm the day', !/Go knock some doors/.test(h) && /Can(&#39;|')t confirm your day yet/.test(h));

    // A failed refresh after a good read keeps the schedule and says it may be incomplete.
    const data = { appointments: [appt] };
    const keep = await todayEnv({ data });
    await keep.win.NBDToday.refreshAppointments();
    data.__fail = isName('appointments');
    await keep.win.NBDToday.refreshAppointments(); keep.win.NBDToday.render();
    const hk = keep.els.todayPlan.innerHTML;
    ok('a failed REFRESH does not blank the appointment already known', /Pat Sample/.test(hk) && /could not load/.test(hk) && /NOT an all-clear/.test(hk), hk.slice(0, 500));

    // Retry re-asks and clears the banner.
    delete data.__fail;
    const target = { closest: (sel) => (/data-tp-act/.test(sel) ? { getAttribute: (k) => ({ 'data-tp-act': 'retry', 'data-tp-key': 'reads' })[k] || null } : null) };
    for (const fn of keep.doc._l.click || []) await fn({ target });
    await flush(); await flush(); await flush();
    keep.win.NBDToday.render();
    ok('Try again re-reads the appointments and clears the banner', !/could not load/.test(keep.els.todayPlan.innerHTML) && /Pat Sample/.test(keep.els.todayPlan.innerHTML), keep.els.todayPlan.innerHTML.slice(0, 300));
  }
  {
    // Slow appointments read: no banner while pending.
    let release; const held = new Promise((r) => { release = r; });
    const slow = await todayEnv({ data: { appointments: [appt], __hold: () => held } });
    slow.win.NBDToday.render();
    ok('slow appointments read: no failure banner while it is pending', !/could not load/.test(slow.els.todayPlan.innerHTML));
    release();
  }
  {
    // Invoices: NBDRevenue.loadInvoices resolves [] and leaves cached() null on failure.
    let cache = null;
    const R = {
      cached: () => cache, loadInvoices: async () => [], isOwedInvoice: () => false, owedDollarsOf: () => 0,
    };
    const f = await todayEnv({ extra: { NBDRevenue: R } });
    f.win.NBDToday.render();           // starts the invoice load
    await flush(); await flush(); await flush();
    f.win.NBDToday.render();
    ok('invoices that never load: Today names "money owed" and is not an all-clear', /money owed/.test(f.els.todayPlan.innerHTML) && /NOT an all-clear/.test(f.els.todayPlan.innerHTML) && /data-tp-act="retry"/.test(f.els.todayPlan.innerHTML), f.els.todayPlan.innerHTML.slice(0, 400));

    cache = [];                         // a genuinely empty list IS cached
    const g = await todayEnv({ extra: { NBDRevenue: R } });
    g.win.NBDToday.render(); await flush(); await flush(); g.win.NBDToday.render();
    ok('control: an empty invoice list that DID load raises no banner', !/money owed/.test(g.els.todayPlan.innerHTML) && !/NOT an all-clear/.test(g.els.todayPlan.innerHTML));

    // Pending: the read has not settled yet -> not failed.
    let rel; const heldInv = new Promise((r) => { rel = r; });
    cache = null;
    const pend = await todayEnv({ extra: { NBDRevenue: Object.assign({}, R, { loadInvoices: () => heldInv }) } });
    pend.win.NBDToday.render(); await flush(); pend.win.NBDToday.render();
    ok('slow invoice read: pending is not a failure', !/money owed/.test(pend.els.todayPlan.innerHTML));
    rel([]);
  }
  {
    const sf = await todayEnv({ ha: { groupNeeds: () => [], lastRows: [], lastCounts: { stripeFailed: true }, callerKey: HA.callerKey } });
    sf.win.NBDToday.render();
    ok('a failed Stripe read is named on Today', /Stripe payments/.test(sf.els.todayPlan.innerHTML) && /NOT an all-clear/.test(sf.els.todayPlan.innerHTML) && !/Go knock some doors/.test(sf.els.todayPlan.innerHTML), sf.els.todayPlan.innerHTML.slice(0, 400));
    const sg = await todayEnv({ ha: { groupNeeds: () => [], lastRows: [], lastCounts: { stripe: 0 }, callerKey: HA.callerKey } });
    sg.win.NBDToday.render();
    ok('control: with no Stripe failure Today stays quiet', !/Stripe payments/.test(sg.els.todayPlan.innerHTML) && /Go knock some doors/.test(sg.els.todayPlan.innerHTML));
  }

  // ═══ C. one person = one row ════════════════════════════════════════
  console.log('\nC. "N things today": a filed customer + an unfiled call from the same number is ONE person');
  const lead = { id: 'L1', firstName: 'Dana', lastName: 'Test', phone: '(513) 555-0111' };
  const promTask = { id: 'promise-cube_X', kind: 'promise', promiseKind: 'callback', text: 'Call Dana back', done: false, dueDate: TODAY, missCount: 0, rescheduleCount: 0 };
  const unfiled = call('cube_U1', { phoneDigits: '5135550111', bucket: 'unknown', summary: 'asked about a quote', urgent: false });
  const build = (o) => TP.buildTodayPlan(Object.assign({ now: NOW, leads: [lead], SW, tasksByLead: {}, callGroups: [], waitingDays: 3 }, o));
  const groups = (rows) => HA.groupNeeds(rows, NOW);

  {
    const rows = [unfiled];
    const g = groups(rows);
    ok('setup: the unfiled call is its own group (callerKey is the server rule: num:<digits>)', g.length === 1 && g[0].key === 'num:5135550111');
    const base = build({ callGroups: [], tasksByLead: { L1: [promTask] } });
    ok('control: with no call, the promise is ONE row', base.promises.length === 1 && base.calls.length === 0 && base.total === 1);
    const p = build({ callGroups: g, tasksByLead: { L1: [promTask] } });
    ok('promise on the filed customer + unfiled call from the same number = ONE row', p.total === 1 && p.promises.length === 1 && p.calls.length === 0, JSON.stringify({ total: p.total, promises: p.promises.length, calls: p.calls.length }));
    const rider = (p.promises[0].phoneCalls || [])[0];
    ok('...and the call is NOT hidden: it rides in the row with its own key, call ids and summary', !!rider && rider.key === 'num:5135550111' && rider.callIds.join() === 'cube_U1' && /quote/.test(rider.summary), JSON.stringify(p.promises[0].phoneCalls));
    ok('...and it counts toward the headline as ONE thing', TP.headline(p.total) === '1 thing today');
  }
  {
    // A plain promised follow-up (non-promise task) joins too.
    const t = { id: 'plain', text: 'Send photos', dueDate: TODAY, done: false };
    const p = build({ callGroups: groups([unfiled]), tasksByLead: { L1: [t] } });
    ok('a due task on the customer + unfiled call = one Promised-follow-ups row', p.total === 1 && p.promised.length === 1 && p.calls.length === 0 && (p.promised[0].phoneCalls || []).length === 1, JSON.stringify({ total: p.total }));
  }
  {
    // Filed call group (lead:L1) AND an unfiled one from the same number: one calls row.
    const filed = call('cube_F1', { leadId: 'L1', phoneDigits: '5135550111', bucket: 'customer', urgent: true, startedAtMs: NOW - 7200e3 });
    const g = groups([filed, unfiled]);
    ok('setup: two groups (lead:L1 and num:...)', g.length === 2);
    const p = build({ callGroups: g });
    ok('filed call + unfiled call from the same number = ONE Calls-owed row', p.calls.length === 1 && p.total === 1, JSON.stringify(p.calls.map((r) => r.key)));
    ok('...the unfiled call rides inside it, not dropped', p.calls[0].callIds.join() === 'cube_F1' && p.calls[0].phoneCalls.length === 1 && p.calls[0].phoneCalls[0].callIds.join() === 'cube_U1');
    // Order of the groups must not matter.
    const rev = build({ callGroups: g.slice().reverse() });
    ok('...and the group order does not matter', rev.calls.length === 1 && rev.calls[0].callIds.join() === 'cube_F1' && rev.calls[0].phoneCalls.length === 1);
  }
  {
    // Unfiled call from a customer's number, nothing else open: one row, named for the customer.
    const p = build({ callGroups: groups([unfiled]) });
    ok('an unfiled call from a known number is one row named for the customer, and the lead is not ALSO stalled', p.calls.length === 1 && p.calls[0].name === 'Dana Test' && p.total === 1);
    const stalledLead = Object.assign({}, lead, { followUp: PL.addDaysYmd(TODAY, -3) });
    const q = build({ leads: [stalledLead], callGroups: groups([unfiled]) });
    ok('a stalled lead with an unfiled call from its number is one thing, not two', q.total === 1 && q.stalled.length === 0 && q.calls.length === 1, JSON.stringify({ total: q.total, stalled: q.stalled.length }));
    const ctl = build({ leads: [stalledLead], callGroups: [] });
    ok('control: the same stalled lead alone IS a stalled row', ctl.stalled.length === 1 && ctl.total === 1);
  }
  {
    // Not guessing: two customers share the number -> no merge; a different number -> no merge.
    const twin = { id: 'L2', firstName: 'Twin', lastName: 'Lead', phone: '513-555-0111' };
    const p = build({ leads: [lead, twin], callGroups: groups([unfiled]), tasksByLead: { L1: [promTask] } });
    ok('two customers share the number: no guess, the call stays its own row', p.calls.length === 1 && p.promises.length === 1 && p.total === 2, JSON.stringify({ calls: p.calls.length, total: p.total }));
    const other = call('cube_U2', { phoneDigits: '5135559999', bucket: 'unknown' });
    const q = build({ callGroups: groups([other]), tasksByLead: { L1: [promTask] } });
    ok('control: a call from a DIFFERENT number is a separate row', q.calls.length === 1 && q.promises.length === 1 && q.total === 2);
    ok('leading-1 / punctuation normalise to the same number', (() => {
      const l11 = { id: 'L3', firstName: 'Eleven', lastName: 'Digits', phone: '+1 (513) 555-0111' };
      const r = build({ leads: [l11], callGroups: groups([unfiled]), tasksByLead: { L3: [promTask] } });
      return r.total === 1 && r.promises.length === 1;
    })());
  }
  {
    // Handling the rider by its own key hides only that call, never the promise row.
    const g = groups([unfiled]);
    const p = build({ callGroups: g, tasksByLead: { L1: [promTask] }, handled: new Set(['num:5135550111']) });
    ok('Handled on the rider (its own key) leaves the promise row and drops the call', p.promises.length === 1 && !(p.promises[0].phoneCalls || []).length && p.total === 1);
    // A rider that carries its own promise keeps its Kept it / Move controls.
    const riding = call('cube_U3', { phoneDigits: '5135550111', bucket: 'unknown', promise: { kind: 'promise', promiseKind: 'callback', text: 'ring back', done: false, dueDate: TODAY } });
    const q = build({ callGroups: groups([riding]), tasksByLead: { L1: [promTask] } });
    ok('a rider with its own promise stays visible as a rider (ckept target)', q.total === 1 && q.promises[0].phoneCalls.length === 1 && !!q.promises[0].phoneCalls[0].promise && q.promises[0].phoneCalls[0].promise.callId === 'cube_U3', JSON.stringify(q.promises[0].phoneCalls));
  }
  {
    // Rendering: the rider is on the row with a 44px-class button, and escaped.
    const evil = call('cube_U9', { phoneDigits: '5135550111', bucket: 'unknown', summary: '<img src=x onerror=alert(1)>' });
    const g = HA.groupNeeds([evil], NOW);
    const ha = { groupNeeds: () => g, lastRows: [evil], lastCounts: {}, callerKey: HA.callerKey };
    const env = await todayEnv({ leads: [lead], ha });
    env.win._taskCache = { L1: [promTask] };
    env.win.NBDToday.render();
    const h = env.els.todayPlan.innerHTML;
    ok('Today paints ONE row for the person, with the unfiled call inside it', (h.match(/data-tp-row="/g) || []).length === 1 && /tp-ucall/.test(h) && /data-tp-act="handled" data-tp-key="num:5135550111"/.test(h) && /data-tp-total="1"/.test(h), h.slice(0, 700));
    ok('...and the call text is escaped into the page', !/<img src=x/.test(h) && /&lt;img/.test(h));
    ok('...the rider button is a .tp-btn (44px target class)', /class="tp-btn tp-go" data-tp-act="handled" data-tp-key="num:5135550111"/.test(h));
    const css = read('docs/pro/css/today-home.css');
    ok('control: .tp-btn really is min-height 44px in the stylesheet', /\.tp-btn\{[^}]*min-height:44px/.test(css.replace(/\r?\n/g, '')));
  }

  // ═══ D. review-pass follow-ups (silent-failure hunt on the first cut) ═══
  console.log('\nD. review pass: riders are never dropped; the other reads honour the same rules');
  {
    // 1. Handling the HOST row must not take an open rider with it.
    const filed = call('cube_F1', { leadId: 'L1', phoneDigits: '5135550111', bucket: 'customer', urgent: true, startedAtMs: NOW - 7200e3 });
    const g = groups([filed, unfiled]);
    const open = build({ callGroups: g });
    ok('control: host + rider is one row, rider inside', open.calls.length === 1 && open.calls[0].key === 'lead:L1' && open.calls[0].phoneCalls.length === 1);
    const hostDone = build({ callGroups: g, handled: new Set(['lead:L1']) });
    ok('Handled on the HOST row keeps the still-open unfiled call as a row of its own', hostDone.calls.length === 1 && hostDone.calls[0].key === 'num:5135550111' && hostDone.calls[0].callIds.join() === 'cube_U1' && hostDone.total === 1, JSON.stringify(hostDone.calls.map((r) => r.key)));
    const bothDone = build({ callGroups: g, handled: new Set(['lead:L1', 'num:5135550111']) });
    ok('control: both handled -> nothing left', bothDone.calls.length === 0 && bothDone.total === 0);
  }
  {
    // 2. Done / Tomorrow on a task row must not quietly handle the matched call.
    const t = { id: 'plain', text: 'Send photos', dueDate: TODAY, done: false };
    const p = build({ callGroups: groups([unfiled]), tasksByLead: { L1: [t] } });
    ok("a phone-matched call's id is NOT in the task row's callIds (Done / Tomorrow cannot touch it)", p.promised.length === 1 && p.promised[0].callIds.indexOf('cube_U1') < 0 && p.promised[0].phoneCalls[0].callIds.join() === 'cube_U1', JSON.stringify(p.promised[0].callIds));
    const filed = call('cube_F2', { leadId: 'L1', phoneDigits: '5135550111', bucket: 'customer', promises: joP });
    const q = build({ callGroups: groups([filed]), tasksByLead: { L1: [t] } });
    ok('control: a call FILED on the customer still rides in the task row callIds (unchanged behaviour)', q.promised.length === 1 && q.promised[0].callIds.indexOf('cube_F2') >= 0);
  }
  {
    // 3. A call filed on a lead that is gone is not "unfiled".
    const orphan = call('cube_O1', { leadId: 'GONE', phoneDigits: '5135550111', bucket: 'customer', urgent: true });
    const p = build({ callGroups: groups([orphan]), tasksByLead: { L1: [promTask] } });
    ok('a call filed on a deleted / unknown lead keeps its own row (not merged by number)', p.calls.length === 1 && p.promises.length === 1 && !(p.promises[0].phoneCalls || []).length && p.total === 2, JSON.stringify({ calls: p.calls.length, total: p.total }));
  }
  {
    // 10. A resurfaced hidden number keeps its explanation and Keep hidden when merged.
    const grp = [{ key: 'num:5135550111', calls: [unfiled], resurfaced: 'lead', resurfacedDigits: '5135550111', latestMs: unfiled.startedAtMs }];
    const p = build({ callGroups: grp, tasksByLead: { L1: [promTask] } });
    ok('the rider carries the resurfaced reason', p.promises.length === 1 && p.promises[0].phoneCalls[0].resurfaced === 'lead' && p.promises[0].phoneCalls[0].phone === '5135550111');
    const ha = { groupNeeds: () => grp, lastRows: [unfiled], lastCounts: {}, callerKey: HA.callerKey };
    const env = await todayEnv({ leads: [lead], ha });
    env.win._taskCache = { L1: [promTask] };
    env.win.NBDToday.render();
    const h = env.els.todayPlan.innerHTML;
    ok('...and Today shows why, with a Keep hidden button on the rider', /hidden number matches a customer/.test(h) && /data-tp-act="rehide" data-tp-key="num:5135550111"/.test(h), h.slice(0, 600));
  }
  {
    // 5. The same cached-empty rule on calls / texts / old promises and on the invoice loader.
    const empty = { phone_calls: [], phone_text_days: [] };
    const cc1 = await strip(Object.assign({ __cache: (q) => q.col.name === 'phone_calls' && q.cs.some((c) => c.op === '>=') }, empty));
    ok('H7: the first empty cached calls answer is "checking", not a failure', cc1.api.lastCounts.callsPending === true && !cc1.api.lastCounts.callsFailed && !/NOT an all-clear/.test(cc1.strip.innerHTML), JSON.stringify(cc1.api.lastCounts));
    const cc = await strip(Object.assign({ __cache: (q) => q.col.name === 'phone_calls' && q.cs.some((c) => c.op === '>=') }, empty), null, true);
    ok('an EMPTY cached recent-calls answer is a failed read, never "nobody needs you"', cc.api.lastCounts.callsFailed === true && /NOT an all-clear/.test(cc.strip.innerHTML), cc.strip.innerHTML);
    const ct = await strip(Object.assign({ __cache: (q) => q.col.name === 'phone_text_days' }, empty), null, true);
    ok('...same for texts', ct.api.lastCounts.callsFailed === true);
    const co = await strip(Object.assign({ __cache: (q) => q.col.name === 'phone_calls' && q.cs.some((c) => c.op === '<') }, empty), null, true);
    ok('...and for the old-promise read (its own warning)', co.api.lastCounts.oldFailed === true && !co.api.lastCounts.callsFailed && /old promises/i.test(co.strip.innerHTML));
    const rows = [call('c1', { urgent: true })];
    const cn = await strip({ phone_calls: rows, phone_text_days: [], __cache: (q) => q.col.name === 'phone_calls' && q.cs.some((c) => c.op === '>=') });
    ok('control: a NON-empty cached calls answer is real data (counted, no failure)', cn.api.lastCounts.calls === 1 && !cn.api.lastCounts.callsFailed, JSON.stringify(cn.api.lastCounts));
    const cs = await strip({ phone_calls: [], phone_text_days: [] });
    ok('control: server-confirmed empty calls stay quiet', !cs.api.lastCounts.callsFailed && !cs.api.lastCounts.oldFailed && cs.strip.hidden === true);

    function revenueEnv(snapshot) {
      const env = sandbox({ _user: { uid: 'u1' }, _userClaims: {}, db: {}, collection: () => ({}), query: () => ({}), where: () => ({}), getDocs: async () => snapshot });
      load(env, 'docs/pro/js/collected-revenue.js');
      return env;
    }
    const e1 = revenueEnv({ docs: [], metadata: { fromCache: true } });
    await e1.win.NBDRevenue.loadInvoices();
    ok('invoices: an empty snapshot from the local cache is NOT cached as a real empty list', e1.win.NBDRevenue.cached() === null);
    const e2 = revenueEnv({ docs: [], metadata: { fromCache: false } });
    await e2.win.NBDRevenue.loadInvoices();
    ok('control: a server-confirmed empty invoice list IS cached ([])', Array.isArray(e2.win.NBDRevenue.cached()) && e2.win.NBDRevenue.cached().length === 0);
    const e3 = revenueEnv({ docs: [{ id: 'i1', data: () => ({ total: 5 }) }], metadata: { fromCache: true } });
    await e3.win.NBDRevenue.loadInvoices();
    ok('control: a NON-empty cached invoice snapshot is real data', (e3.win.NBDRevenue.cached() || []).length === 1);
  }
  {
    // 8. count() itself throwing is a visible failure, not a stale quiet strip.
    const fb = fakeFirestore({ phone_calls: [], phone_text_days: [], stripeLedger: [], yardSigns: [] });
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: {}, db: {} }, fb, { collection: () => { throw new Error('sdk exploded'); } }));
    env.els.homeAttention = fakeEl('homeAttention');
    load(env, 'docs/pro/js/home-attention.js');
    let threw = false;
    try { await env.win.NBDHomeAttention.render(true); } catch (_) { threw = true; }
    ok('a throw inside the strip read is caught and shown as NOT an all-clear', !threw && /NOT an all-clear/.test(env.els.homeAttention.innerHTML) && env.win.NBDHomeAttention.lastCounts.callsFailed === true, env.els.homeAttention.innerHTML);
  }
  {
    // 4 + 6. invoices: rows taken at settle (a data refresh drops the shared cache);
    // an in-flight read is "Checking", not "Nothing on the list".
    const state = { c: null };
    const inv1 = { id: 'inv1', leadId: 'L1', total: 100, status: 'sent' };
    const R = {
      cached: () => state.c, loadInvoices: async () => { state.c = [inv1]; return state.c; },
      isOwedInvoice: () => true, owedDollarsOf: () => 100,
    };
    // (boot's own render starts the load; NO explicit render in between, so only
    // the settle step - not compute() - can have taken the rows)
    const env = await todayEnv({ leads: [lead], extra: { NBDRevenue: R } });
    await flush(); await flush();
    state.c = null;                      // nbd:data-refreshed -> NBDRevenue.invalidate()
    env.win.NBDToday.render();
    ok('invoices that loaded are kept when a data refresh drops the shared cache (no silent empty Money)', /Dana Test/.test(env.els.todayPlan.innerHTML) && /data-tp-sec="money"/.test(env.els.todayPlan.innerHTML) && !/money owed/.test(env.els.todayPlan.innerHTML), env.els.todayPlan.innerHTML.slice(0, 400));

    let rel; const heldInv = new Promise((r) => { rel = r; });
    const pend = await todayEnv({ extra: { NBDRevenue: { cached: () => null, loadInvoices: () => heldInv, isOwedInvoice: () => false, owedDollarsOf: () => 0 } } });
    pend.win.NBDToday.render();
    ok('while invoices are in flight the empty state is "Checking", never "Nothing on the list"', /Checking your day/.test(pend.els.todayPlan.innerHTML) && !/Go knock some doors/.test(pend.els.todayPlan.innerHTML) && !/NOT an all-clear/.test(pend.els.todayPlan.innerHTML), pend.els.todayPlan.innerHTML.slice(0, 300));
    rel([]);
  }
  {
    // 7. a rule that throws is named, not a quiet empty.
    const boom = await todayEnv({ ha: { groupNeeds: () => { throw new Error('rule bug'); }, lastRows: [call('x1', { urgent: true })], lastCounts: {}, callerKey: HA.callerKey } });
    boom.win.NBDToday.render();
    ok('a needs-you rule that throws is named on Today, not a quiet empty list', /could not load/.test(boom.els.todayPlan.innerHTML) && /your calls list/.test(boom.els.todayPlan.innerHTML) && /NOT an all-clear/.test(boom.els.todayPlan.innerHTML), boom.els.todayPlan.innerHTML.slice(0, 400));
  }


  // ═══ E. coordinator pass 2 ══════════════════════════════════════════
  console.log('\nE. promised-row riders, rider-only rows, hidden-count throw, strip paint throw');
  {
    const t = { id: 'plain', text: 'Send photos', dueDate: TODAY, done: false };
    const g = groups([unfiled]);
    const open = build({ callGroups: g, tasksByLead: { L1: [t] } });
    ok('control: task + rider is one promised row with the rider inside', open.promised.length === 1 && open.promised[0].phoneCalls.length === 1 && open.total === 1);
    const done = build({ callGroups: g, tasksByLead: { L1: [t] }, handled: new Set(['prom:L1']) });
    ok('Done on the promised row (its key handled) keeps the still-open unfiled call as a Calls-owed row', done.promised.length === 0 && done.calls.length === 1 && done.calls[0].key === 'num:5135550111' && done.calls[0].callIds.join() === 'cube_U1' && done.total === 1, JSON.stringify({ p: done.promised.length, c: done.calls.length, total: done.total }));
    const both = build({ callGroups: g, tasksByLead: { L1: [t] }, handled: new Set(['prom:L1', 'num:5135550111']) });
    ok('control: host and rider both handled -> nothing', both.total === 0 && both.calls.length === 0);
    // the same through a promise-task row
    const pDone = build({ callGroups: g, tasksByLead: { L1: [promTask] }, handled: new Set(['prom:L1']) });
    ok('same for a Promises row handled this session', pDone.promises.length === 0 && pDone.calls.length === 1 && pDone.total === 1);
  }
  {
    // rider-only: a matched call carrying a promise of Jo's, no due task, no filed call.
    const withPromise = call('cube_U4', { phoneDigits: '5135550111', bucket: 'unknown', promises: joP, summary: 'said he would ring back' });
    const p = build({ callGroups: groups([withPromise]) });
    ok('a promise-carrying matched call with no task and no filed call is a CALLS row (a live Handled), not a dead promised row', p.promised.length === 0 && p.calls.length === 1 && p.calls[0].callIds.join() === 'cube_U4' && p.total === 1, JSON.stringify({ promised: p.promised.length, calls: p.calls.length }));
    const filedWithPromise = call('cube_F5', { leadId: 'L1', phoneDigits: '5135550111', bucket: 'customer', promises: joP });
    const q = build({ callGroups: groups([filedWithPromise, withPromise]) });
    ok('control: with a FILED promise call the rider joins that promised row', q.promised.length === 1 && q.calls.length === 0 && q.promised[0].callIds.join() === 'cube_F5' && q.promised[0].phoneCalls.length === 1 && q.total === 1, JSON.stringify({ promised: q.promised.length, calls: q.calls.length }));
  }
  {
    const boom = await todayEnv({ ha: { groupNeeds: () => [], hiddenPeople: () => { throw new Error('hide bug'); }, lastRows: [], lastCounts: {}, callerKey: HA.callerKey } });
    boom.win.NBDToday.render();
    ok('a throwing hidden-people count is named on Today, not swallowed to 0', /people hidden by labels/.test(boom.els.todayPlan.innerHTML) && /NOT an all-clear/.test(boom.els.todayPlan.innerHTML), boom.els.todayPlan.innerHTML.slice(0, 300));
    const fine = await todayEnv({ ha: { groupNeeds: () => [], hiddenPeople: () => 2, lastRows: [], lastCounts: {}, callerKey: HA.callerKey } });
    fine.win.NBDToday.render();
    ok('control: a working hidden count shows and raises no banner', /2 people hidden by labels/.test(fine.els.todayPlan.innerHTML) && !/NOT an all-clear/.test(fine.els.todayPlan.innerHTML));
  }
  {
    // the strip paint throwing must not leave the previous strip up or reject render()
    const poisoned = { valueOf() { throw new Error('paint bug'); } };
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: {}, db: {}, _leads: [], NBDReviewDeck: { candidates: () => ({ length: poisoned }) } }, fakeFirestore({ phone_calls: [], phone_text_days: [], stripeLedger: [], yardSigns: [] })));
    env.els.homeAttention = fakeEl('homeAttention');
    env.els.homeAttention.innerHTML = '<button>old quiet strip</button>';
    load(env, 'docs/pro/js/home-attention.js');
    let threw = false;
    try { await env.win.NBDHomeAttention.render(true); } catch (_) { threw = true; }
    ok('a throw while PAINTING the strip is caught, shows NOT an all-clear with a retry, and replaces the old strip', !threw && /NOT an all-clear/.test(env.els.homeAttention.innerHTML) && /data-ha-retry/.test(env.els.homeAttention.innerHTML) && !/old quiet strip/.test(env.els.homeAttention.innerHTML), env.els.homeAttention.innerHTML);
  }


  // ── the server rule is untouched: strip / Call Center still count by callerKey ──
  console.log('\nMirror: Home\'s callerKey / callNeedsYou still equal the server\'s');
  {
    const filed = call('cube_F1', { leadId: 'L1', phoneDigits: '5135550111', bucket: 'customer', urgent: true });
    const set = [filed, unfiled, call('m1', { status: 'short', direction: 'inbound', phoneDigits: '5135550222', bucket: 'unknown' })];
    const ctx = W.reachIndex(set);
    ok('callerKey agrees with the server for filed and unfiled calls', set.every((c) => HA.callerKey(c) === W.callerKey(c)));
    ok('callNeedsYou agrees with the server on these rows', set.every((c) => HA.callNeedsYou(c, NOW, ctx) === W.callNeedsYou(c, NOW, ctx)));
    ok('the strip still counts them as the server does (two keys)', HA.callersNeedingYou([filed, unfiled], NOW) === new Set([filed, unfiled].filter((c) => W.callNeedsYou(c, NOW, W.reachIndex([filed, unfiled]))).map(W.callerKey)).size);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
