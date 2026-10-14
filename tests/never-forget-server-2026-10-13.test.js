#!/usr/bin/env node
/**
 * Never-forget QA sweep 2026-10-13 - the SERVER-side open findings, each
 * VERIFIED with a failing test before it was fixed (the note's items were
 * leads from reading, not reproductions).
 *
 *   1  H3   a promise riding on an unfiled call (callCenterAction 'promise')
 *           fell out of the rule at day 14 - invisible to the ledger, the
 *           ladder and away mode while Today still showed it
 *   2       a snoozed item was never re-told when its snooze ended
 *   3       thursday_calls read with limit(300) and NO order: once there are
 *           more than 300, the newest are the ones that vanish
 *   5       a texted promise past 45 days appeared nowhere
 *   6       away mode's cover list ignored contact labels
 *   8       a label's ackAtMs / updatedAtMs with a huge value disabled "hidden
 *           number came back" for that number for good
 *  10       a text day closed by ticking its follow-up TASK was not reopened
 *           by a later inbound text (the handled twin was fixed in #2406),
 *           and callWatch's task reconcile silently re-closed it
 *  11       a handled day's kept promise re-appeared as "you promised
 *           something" when a "thanks" text re-noted the day (promises
 *           regenerate with no kept marker)
 *
 * Fake db honours where / orderBy / limit, so the QUERY is under test.
 * Run: node tests/never-forget-server-2026-10-13.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const CL = require(path.join(ROOT, 'functions/contact-labels.js'));
const T = require(path.join(ROOT, 'functions/text-inbox-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const H = 3600000, D = 86400000;
const NOW = Date.parse('2026-10-02T00:05:00Z');           // 8:05 PM ET Oct 1 - the ledger hour
const OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const ymdET = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const joP = [{ who: 'jo', text: 'send the quote' }];
const call = (o) => Object.assign({ userId: OWNER, startedAtMs: NOW - 3 * H, status: 'noted', direction: 'inbound', bucket: 'customer', leadId: 'L9', phoneDigits: '8595550101' }, o);
const todayCall = call({ id: 'today', leadId: 'L1', phoneDigits: '8595550199' });   // keeps "no calls today" out of the way

/** Firestore-ish fake: where(==, >=, <, <=), orderBy, limit, getAll, labels, tasks. */
function mkDb(o) {
  const opt = o || {};
  const docs = Object.assign({ 'integrations/callWatch': { lastCheckAtMs: NOW - 2 * H } }, opt.docs || {});
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  const q = (all, col) => {
    const f = [], st = { lim: Infinity, desc: false };
    const self = {
      where(field, op, v) { f.push([field, op, val(v)]); return self; },
      orderBy(field, dir) { st.desc = dir === 'desc'; st.field = field; return self; },
      limit(n) { st.lim = n; return self; },
      async get() {
        if (opt.failOld && col === 'phone_calls' && f.some((x) => x[1] === '<')) throw new Error('boom: old promises read');
        if (opt.failOldText && col === 'phone_text_days' && f.some((x) => x[1] === '<')) throw new Error('boom: old text read');
        let r = all.filter((x) => f.every(([k, op, v]) => {
          const a = val(x[k]);
          if (op === '==') return a === v;
          if (a === null || a === undefined) return false;
          return op === '>=' ? Number(a) >= v : op === '<' ? Number(a) < v : op === '<=' ? Number(a) <= v : true;
        }));
        if (st.field) r = r.slice().sort((a, b) => st.desc ? (val(b[st.field]) || 0) - (val(a[st.field]) || 0) : (val(a[st.field]) || 0) - (val(b[st.field]) || 0));
        r = r.slice(0, st.lim);
        return { size: r.length, docs: r.map((x) => ({ id: x.id, data: () => x })) };
      },
    };
    return self;
  };
  const labelDocs = Object.keys(opt.labels || {}).map((d) => ({ id: d, data: () => opt.labels[d] }));
  const db = {
    docs, bells: [],
    collection(n) {
      if (n === 'companies') {
        return { doc: () => ({ collection: () => ({ get: async () => { if (opt.failLabels) throw new Error('boom: labels'); return { docs: labelDocs }; } }) }) };
      }
      if (n === 'phone_calls') return q(opt.calls || [], n);
      if (n === 'phone_text_days') return q(opt.texts || [], n);
      if (n === 'thursday_calls') return q(opt.thursday || [], n);
      if (n === 'notifications') return { add: async (v) => { db.bells.push(v); } };
      return q([], n);
    },
    doc: (p) => ({
      get: async () => ({ exists: p in docs, data: () => docs[p] }),
      set: async (v, op) => { docs[p] = op && op.merge ? Object.assign({}, docs[p] || {}, v) : v; },
    }),
    collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }), 
    getAll: async (...r) => Promise.all(r.map((ref) => ref.get())),
  };
  return db;
}

(async () => {
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch, reconcileTaskDone } = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  const { loadOpenItems } = require(path.join(ROOT, 'functions/away-mode.js'))._internal;
  const push = async () => ({ sent: 1 });
  const watch = async (o, state, now) => {
    const db = mkDb(o);
    if (state) db.docs['integrations/callWatch'] = state;
    const pushes = [];
    const r = await runWatch({ db, nowMs: now || NOW, live: true, push: async (uid, title, body) => { pushes.push({ title, body }); return { sent: 1 }; } });
    return { db, r, pushes, ledger: db.docs['integrations/dailyLedger'], state: db.docs['integrations/callWatch'], bells: db.bells };
  };

  // ───────────────────────────────────────────────────────────────────────
  console.log('1. H3: a promise riding on an unfiled call survives day 14');
  const rider = (o) => call(Object.assign({
    id: 'rider', leadId: null, bucket: 'unknown', phoneDigits: '5135550111', promises: [],
    startedAtMs: NOW - 20 * D, promiseKind: 'callback', followUpDate: ymdET(NOW - 3 * D), snoozeUntilYmd: null,
    promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW - 3 * D), text: 'Call back about the roof' },
  }, o));
  const r20 = rider();
  ok('server rule: a due rider on a 20-day-old unfiled call needs Jo', W.callNeedsYou(r20, NOW) === true);
  ok('reason names the promise, not a bare "follow-up due"', W.reasonFor(r20, NOW) === 'you promised something', W.reasonFor(r20, NOW));
  ok('Home mirror agrees (same rule, no fork)', HA.callNeedsYou(r20, NOW) === true);
  ok('control: a rider whose date has not come is parked, not open', W.callNeedsYou(rider({ followUpDate: ymdET(NOW + 2 * D), snoozeUntilYmd: ymdET(NOW + 2 * D), promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW + 2 * D), text: 'x' } }), NOW) === false);
  ok('control: Handled (the "Kept it" tap) closes it', W.callNeedsYou(rider({ handledAtMs: NOW - H }), NOW) === false);
  ok('control: a promise flagged done closes it', W.callNeedsYou(rider({ promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW - 3 * D), done: true } }), NOW) === false);
  ok('control: past 45 days it is the old-promise row, not a live person', W.callNeedsYou(rider({ startedAtMs: NOW - 60 * D }), NOW) === false && W.oldPromiseCount([rider({ startedAtMs: NOW - 60 * D })], NOW) === 1);
  ok('Home counts that old rider the same', HA.oldPromiseCount([rider({ startedAtMs: NOW - 60 * D })], NOW) === 1);
  let w = await watch({ calls: [todayCall, r20] });
  ok('the 8 pm ledger counts the 20-day-old rider as an open person', w.ledger && w.ledger.open === 1 && w.ledger.clear === false, w.ledger);
  let items = await loadOpenItems(mkDb({ calls: [r20], texts: [] }), OWNER, NOW);
  ok('away mode lists it for the backup', items.length === 1 && /promised/.test(items[0].why), items);

  // ───────────────────────────────────────────────────────────────────────
  console.log('2. a snoozed item is told again the day its snooze ends');
  const T5 = Date.parse('2026-10-05T14:05:00Z');            // 10:05 AM ET Oct 5
  const lastNight = Date.parse('2026-10-04T22:00:00Z');     // last check: 6 PM ET Oct 4
  const snoozed = call({ id: 'p1', leadId: null, bucket: 'unknown', phoneDigits: '5135550122', startedAtMs: T5 - 3 * D, promises: joP, snoozeUntilYmd: '2026-10-05', followUpDate: null });
  w = await watch({ calls: [snoozed] }, { lastCheckAtMs: lastNight, toldIds: ['call:p1'] }, T5);
  ok('the day the call-level snooze ends, one push says so', w.r.state === 'alerted' && w.pushes.length === 1 && /promised/.test(w.pushes[0].body), w.r);
  w = await watch({ calls: [snoozed] }, { lastCheckAtMs: lastNight, toldIds: ['call:p1'] }, T5 - 20 * H);   // Oct 4 14:00 ET: still snoozed
  ok('control: while it is still snoozed, nothing is pushed', w.r.state === 'quiet' && w.pushes.length === 0, w.r);
  const onTask = call({ id: 'p2', leadId: 'L2', phoneDigits: '5135550123', startedAtMs: T5 - 5 * D, promises: joP, followUpDate: '2026-10-02' });
  const taskDb = { 'leads/L2/tasks/cube-p2': { done: false, dueDate: '2026-10-05', snoozedFromDue: '2026-10-02' } };
  const dbT = mkDb({ calls: [onTask] }); dbT.docs['integrations/callWatch'] = { lastCheckAtMs: lastNight, toldIds: ['call:p2', 'call:p2#due:2026-10-02'] };
  dbT.doc = ((orig) => (p) => (p in taskDb ? { get: async () => ({ exists: true, data: () => taskDb[p] }) } : orig(p)))(dbT.doc);
  const pT = []; const rT = await runWatch({ db: dbT, nowMs: T5, live: true, push: async (u, t, b) => { pT.push(b); return { sent: 1 }; } });
  ok('a task-level snooze (due date moved) is told when the new date arrives', rT.state === 'alerted' && pT.length === 1, rT);
  const rT2 = await runWatch({ db: dbT, nowMs: T5 + 2 * H, live: true, push: async (u, t, b) => { pT.push(b); return { sent: 1 }; } });
  ok('...and only once (the wake id is remembered)', rT2.needs === 0, rT2);

  // ───────────────────────────────────────────────────────────────────────
  console.log('3. thursday_calls: more than 300 rows must not hide the newest');
  const old = []; for (let i = 0; i < 340; i++) old.push({ id: 'b_old' + i, companyId: OWNER, status: 'processed', reviewed: true, startedAt: new Date(NOW - (1 + i * 0.03) * D) });
  const newest = { id: 'z_new', companyId: OWNER, status: 'processed', reviewed: false, from: '5135550133', startedAt: new Date(NOW - 5 * H), processedAt: new Date(NOW - 4 * H), urgent: false };
  const nullStart = { id: 'z_null', companyId: OWNER, status: 'processed', reviewed: false, from: '5135550134', startedAt: null, createdAt: new Date(NOW - 6 * H), processedAt: new Date(NOW - 5 * H) };
  w = await watch({ calls: [todayCall], thursday: old.concat([newest, nullStart]) }, { lastCheckAtMs: NOW - 8 * H });
  ok('the newest unreviewed Thursday calls (dated and null-dated) are told even behind 340 old rows', w.pushes.length === 1 && w.bells.some((b) => /2 people need you/.test(b.title || '')), { r: w.r, bells: w.bells.map((b) => b.title) });
  items = await loadOpenItems(mkDb({ thursday: old.concat([newest]) }), OWNER, NOW);
  ok('away mode reads the same window', items.length === 1 && /Thursday/.test(items[0].why), items);

  // ───────────────────────────────────────────────────────────────────────
  console.log('5. a texted promise past 45 days rolls into the old-promise count');
  const txt60 = { id: 'txt_5135550144_20260801', channel: 'text', userId: OWNER, leadId: null, phoneDigits: '5135550144', status: 'noted', startedAtMs: NOW - 60 * D, promises: joP };
  ok('server: isOldPromise accepts a text day', W.isOldPromise(txt60, NOW) === true);
  ok('Home mirror: same', HA.isOldPromise(txt60, NOW) === true);
  const callSamePerson = call({ id: 'o70', leadId: null, phoneDigits: '5135550144', startedAtMs: NOW - 70 * D, promises: joP });
  ok('people, not rows: a call and a text day from one number are ONE old promise', W.oldPromiseCount([txt60, callSamePerson], NOW) === 1 && HA.oldPromiseCount([txt60, callSamePerson], NOW) === 1);
  ok('control: a handled text day is not an old promise', W.isOldPromise(Object.assign({}, txt60, { handledAtMs: NOW - 50 * D }), NOW) === false);
  w = await watch({ calls: [todayCall], texts: [txt60] });
  ok('the 8 pm ledger names the old texted promise (and is not clear)', w.ledger && w.ledger.oldPromises === 1 && w.ledger.clear === false, w.ledger);
  w = await watch({ calls: [todayCall, callSamePerson], texts: [txt60] });
  ok('call + text from one person: still ONE', w.ledger && w.ledger.oldPromises === 1, w.ledger);
  w = await watch({ calls: [todayCall], texts: [txt60], failOldText: true });
  ok('a FAILED old-text read is a warning, never an all-clear', w.ledger && w.ledger.clear === false && w.ledger.anomalies.some((a) => /could not check/i.test(a)), w.ledger);

  // ───────────────────────────────────────────────────────────────────────
  console.log('6. away mode honours contact labels (same rule as callWatch)');
  const lab = { kind: 'spam', policy: 'hide', updatedAtMs: NOW - 30 * D };
  const L = (kind, policy) => ({ kind, policy, updatedAtMs: NOW - 30 * D, createdAtMs: NOW - 30 * D });
  const u = (id, d, extra) => call(Object.assign({ id, leadId: null, bucket: 'unknown', phoneDigits: d, urgent: true }, extra));
  items = await loadOpenItems(mkDb({
    calls: [u('sp', '5135550201'), u('pe', '5135550202'), u('qu', '5135550203'), u('qp', '5135550204', { urgent: false, promises: joP }), u('plain', '5135550205')],
    labels: { 5135550201: L('spam', 'hide'), 5135550202: L('personal', 'hide'), 5135550203: L('sub', 'quiet'), 5135550204: L('sub', 'quiet') },
  }), OWNER, NOW);
  const byNum = (d) => items.find((i) => i.phone10 === d);
  ok('a hidden SPAM number\'s urgent flag does not reach the backup', !byNum('5135550201'), items.map((i) => i.phone10));
  ok('a hidden PERSONAL number\'s urgent call still breaks through', !!byNum('5135550202'));
  ok('a QUIET number needs a promise: its urgent flag alone stays quiet', !byNum('5135550203'));
  ok('...and a quiet number with a promise is on the list', !!byNum('5135550204'));
  ok('control: an unlabelled urgent number is on the list', !!byNum('5135550205'));
  const thu = (id, from) => ({ id, companyId: OWNER, status: 'processed', reviewed: false, from, startedAt: new Date(NOW - 2 * H), processedAt: new Date(NOW - H) });
  items = await loadOpenItems(mkDb({
    thursday: [thu('t_hide', '5135550211'), thu('t_quiet', '5135550212'), thu('t_plain', '5135550213')],
    labels: { 5135550211: L('spam', 'hide'), 5135550212: L('sub', 'quiet') },
  }), OWNER, NOW);
  ok('Thursday calls from a hidden or a quiet number stay out of the cover list', !items.some((i) => i.phone10 === '5135550211' || i.phone10 === '5135550212'), items.map((i) => i.phone10));
  ok('...and the unlabelled Thursday call (positive control) is on it', items.some((i) => i.phone10 === '5135550213'), items.map((i) => i.phone10));
  items = await loadOpenItems(mkDb({ calls: [u('sp', '5135550201')], labels: { 5135550201: L('spam', 'hide') }, failLabels: true }), OWNER, NOW);
  ok('a failed labels read hides nobody (fail toward telling)', items.length === 1, items);
  const txtUrgent = { id: 'txt_5135550206_20261001', channel: 'text', userId: OWNER, leadId: null, phoneDigits: '5135550206', status: 'noted', startedAtMs: NOW - H, urgent: true, bucket: 'unknown' };
  items = await loadOpenItems(mkDb({ texts: [txtUrgent], labels: { 5135550206: L('spam', 'hide') } }), OWNER, NOW);
  ok('a hidden spam number\'s urgent TEXT day is quiet too', items.length === 0, items);

  // ───────────────────────────────────────────────────────────────────────
  console.log('8. a huge ackAtMs / updatedAtMs cannot disable "hidden number came back"');
  const burst = [1, 2, 3].map((n) => call({ id: 'b' + n, leadId: null, bucket: 'unknown', phoneDigits: '5135550301', startedAtMs: NOW - n * H, direction: 'inbound' }));
  const goodLab = { 5135550301: { kind: 'sub', policy: 'hide', ackAtMs: NOW - 5 * D, updatedAtMs: NOW - 9 * D } };
  ok('control: a normal ack lets 3 calls in 24 h come back', W.resurfacedNumbers(burst, goodLab, NOW).length === 1);
  const evil = { 5135550301: { kind: 'sub', policy: 'hide', ackAtMs: 9e15, updatedAtMs: 9e15 } };
  ok('a stamp two days ahead is dropped, one inside the skew is kept (the bound is one day)',
    W.saneStampMs(NOW + 2 * D, NOW) === 0 && W.saneStampMs(NOW + 3600000, NOW) === NOW + 3600000);
  ok('a raw huge ackAtMs is ignored by the rule itself', W.resurfacedNumbers(burst, evil, NOW).length === 1, W.resurfacedNumbers(burst, evil, NOW).length);
  const loaded = await CL.loadLabels(mkDb({ labels: { 5135550301: { kind: 'sub', policy: 'hide', ackAtMs: 9e15, updatedAtMs: 9e15 } } }), OWNER);
  ok('the server label loader drops the absurd stamps', loaded['5135550301'] && loaded['5135550301'].ackAtMs === 0 && loaded['5135550301'].updatedAtMs === 0, loaded);
  ok('control: a stamp inside the allowed skew is kept', (await CL.loadLabels(mkDb({ labels: { 5135550301: { kind: 'sub', policy: 'hide', ackAtMs: Date.now() + 3600000, updatedAtMs: 5 } } }), OWNER))['5135550301'].ackAtMs > Date.now());
  w = await watch({ calls: [todayCall].concat(burst), labels: { 5135550301: { kind: 'sub', policy: 'hide', ackAtMs: 9e15, updatedAtMs: NOW - 9 * D } } }, { lastCheckAtMs: NOW - 4 * H });
  ok('callWatch tells "a hidden number is calling a lot" despite the poisoned ack', w.bells.some((b) => /hidden number/.test(b.message || '')), w.bells.map((b) => b.message));

  // ───────────────────────────────────────────────────────────────────────
  console.log('10 + 11. closing a text day (Handled or its task) and kept promises survive a re-note');
  const TI = require(path.join(ROOT, 'functions', 'text-inbox.js'));
  const { runTextNotes, setNotes, OWNER: TOWNER, DAYS, COLLECTION } = TI._test;
  const NOWT = Date.parse('2026-10-13T22:00:00Z');
  const DIGITS = '5135550123', DAY_ID = 'txt_' + DIGITS + '_20261013';
  const txt = (id, hoursAgo, dir, body, extra) => Object.assign({
    id, userId: TOWNER, companyId: TOWNER, phoneDigits: DIGITS, sentAtMs: NOWT - hoursAgo * H, direction: dir, body, contactName: 'Pat Example', leadId: 'L1', group: false,
  }, extra);
  function fakeDb(seed) {
    const dd = new Map(Object.entries(seed || {}));
    const mk = (p) => ({
      id: p.split('/').pop(),
      get: async () => ({ exists: dd.has(p), id: p.split('/').pop(), data: () => dd.get(p) }),
      set: async (v, o2) => { dd.set(p, o2 && o2.merge ? Object.assign({}, dd.get(p) || {}, v) : v); },
      create: async (v) => { if (dd.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } dd.set(p, v); },
    });
    const query = (name, filters, lim) => ({
      where: (f, op, v) => query(name, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(name, filters, lim),
      limit: (n) => query(name, filters, n),
      get: async () => {
        const rows = [...dd.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2 &&
          filters.every(([f, op, val2]) => (op === '>=' ? v[f] >= val2 : v[f] === val2)))
          .sort((a, b) => (b[1].sentAtMs || 0) - (a[1].sentAtMs || 0)).slice(0, lim || 1e9);
        return { forEach: (fn) => rows.forEach(([k, v]) => fn({ id: k.split('/')[1], data: () => v })) };
      },
    });
    return { docs: dd, doc: mk, collection: (n) => Object.assign(query(n, [], null), { doc: (id) => mk(n + '/' + id) }), collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }), getAll: async (...r) => Promise.all(r.map((x) => x.get())) };
  }
  const NOTE_PROMISE = { call_type: 'customer', summary: 'Quote promised.', promises: [{ who: 'jo', text: 'Send the quote', due: null }], follow_up_date: null, urgent: false };
  const NOTE_THANKS = Object.assign({}, NOTE_PROMISE, { summary: 'Customer said thanks.' });
  const NOTE_URGENT = { call_type: 'customer', summary: 'Water through the ceiling.', promises: [{ who: 'jo', text: 'Send the quote', due: null }], follow_up_date: null, urgent: true };
  const morning = () => [txt('m1', 12, 'inbound', 'can you quote the roof?'), txt('m2', 11.5, 'outbound', 'Yes, I will send the quote.')];
  async function seeded(closeFn) {
    const db = fakeDb(Object.assign({ 'leads/L1': { firstName: 'Pat', userId: TOWNER } }, Object.fromEntries(morning().map((m) => [COLLECTION + '/' + m.id, m]))));
    setNotes(async () => NOTE_PROMISE);
    await runTextNotes({ db, live: true, nowMs: NOWT - 8 * H });
    closeFn(db);
    return db;
  }
  const dayOf = (db) => Object.assign({ id: DAY_ID }, db.docs.get(DAYS + '/' + DAY_ID));
  const closeHandled = (db) => db.docs.set(DAYS + '/' + DAY_ID, Object.assign({}, db.docs.get(DAYS + '/' + DAY_ID), { handledAtMs: NOWT - 7 * H, handledBy: 'uid_jo' }));
  const closeTask = (db) => {
    db.docs.set('leads/L1/tasks/sms-' + DAY_ID, Object.assign({}, db.docs.get('leads/L1/tasks/sms-' + DAY_ID), { done: true, completedAt: new Date(NOWT - 7 * H) }));
    db.docs.set(DAYS + '/' + DAY_ID, Object.assign({}, db.docs.get(DAYS + '/' + DAY_ID), { taskDone: true }));
  };

  let db = await seeded(closeHandled);
  ok('control: the morning note made one open Jo promise and a task', dayOf(db).promises.length === 1 && db.docs.has('leads/L1/tasks/sms-' + DAY_ID));
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'thanks!'));
  setNotes(async () => NOTE_THANKS);
  await runTextNotes({ db, live: true, nowMs: NOWT });
  let day = dayOf(db);
  ok('11: handled day + promise + "thanks": the promise is NOT resurrected', W.callNeedsYou(day, NOWT) === false, { promises: day.promises, handledAtMs: day.handledAtMs });
  ok('11: the regenerated promise carries a kept marker', day.promises.length === 1 && Number(day.promises[0].keptAtMs) > 0, day.promises);
  ok('11: Home agrees', HA.callNeedsYou(Object.assign({}, day, { channel: 'text' }), NOWT) === false);

  db = await seeded(closeHandled);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'thanks, today is fine'));
  setNotes(async () => ({ call_type: 'customer', summary: 'Thanks', promises: [{ who: 'jo', text: 'Send the quote today', due: null }], follow_up_date: null, urgent: false }));
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('11: a REWORDED regenerated promise (same words + one) is still the kept one', day.promises.length === 1 && Number(day.promises[0].keptAtMs) > 0 && W.callNeedsYou(day, NOWT) === false, day.promises);
  db = await seeded(closeHandled);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'thanks'));
  setNotes(async () => ({ call_type: 'customer', summary: 'Thanks', promises: [{ who: 'jo', text: 'Send the invoice Friday', due: null }], follow_up_date: null, urgent: false }));
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('11 control: a promise sharing one word (send) is NOT matched to the kept one (stays open)', !day.promises[0].keptAtMs && W.callNeedsYou(day, NOWT) === true, day.promises);
  db = await seeded(closeHandled);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'also please bring the invoice'));
  setNotes(async () => ({ call_type: 'customer', summary: 'Invoice', promises: [{ who: 'jo', text: 'Send the quote', due: null }, { who: 'jo', text: 'Bring the invoice Friday', due: null }], follow_up_date: null, urgent: false }));
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('11 control: a genuinely NEW promise after the stamp is open and needs Jo', W.callNeedsYou(day, NOWT) === true && W.reasonFor(day, NOWT) === 'you promised something', day.promises);
  ok('11 control: only the new one is open', day.promises.filter((p) => !p.keptAtMs).length === 1 && /invoice/i.test(day.promises.filter((p) => !p.keptAtMs)[0].text), day.promises);

  db = await seeded((d) => { closeHandled(d); const x = d.docs.get(DAYS + '/' + DAY_ID); x.promises = [{ who: 'jo', text: 'Send the quote', due: null, keptAtMs: NOWT - 20 * H, keptBy: 'promise-cleanup' }]; d.docs.set(DAYS + '/' + DAY_ID, Object.assign({}, x, { handledAtMs: null })); });
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'outbound', 'Quote is in your email.'));
  setNotes(async () => NOTE_PROMISE);
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('11: a promise promise-cleanup stamped kept stays kept through a re-note', day.promises.length === 1 && day.promises[0].keptAtMs === NOWT - 20 * H, day.promises);

  db = await seeded(closeTask);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'water is coming through the ceiling!'));
  setNotes(async () => NOTE_URGENT);
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('10: a task-closed day is reopened by a new inbound text (taskDone cleared, audit stamp)', day.taskDone === false && day.reopenedAtMs === NOWT, { taskDone: day.taskDone, reopenedAtMs: day.reopenedAtMs });
  ok('10: it needs Jo as urgent', W.callNeedsYou(day, NOWT) === true && W.reasonFor(day, NOWT) === 'urgent');
  ok('10: the follow-up task is reopened with it (so nothing re-closes the day)', db.docs.get('leads/L1/tasks/sms-' + DAY_ID).done === false);
  const reconciled = await reconcileTaskDone({ db: Object.assign(mkDb({}), { getAll: async (...r) => Promise.all(r.map((x) => x.get())), doc: db.doc }), calls: [], texts: [Object.assign({ userId: TOWNER }, day)], nowMs: NOWT, live: false });
  ok('10: callWatch\'s task reconcile does not re-close the reopened day', reconciled === 0, reconciled);

  {
    const fresh = Object.assign({ userId: TOWNER }, day, { id: DAY_ID, urgent: true });
    const tickDb = Object.assign(mkDb({}), { getAll: async (...r) => Promise.all(r.map((x) => x.get())), doc: (p) => ({ get: async () => ({ exists: true, data: () => ({ done: true, completedAt: new Date(NOWT + H) }) }) }) });
    const again = await reconcileTaskDone({ db: tickDb, calls: [], texts: [fresh], nowMs: NOWT + 2 * H, live: false });
    ok('10: a tick made AFTER the reopen closes the day again (the skip only covers the old tick)', again === 1, again);
  }
  db = await seeded(closeTask);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'thanks!'));
  setNotes(async () => NOTE_THANKS);
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('10 + 11: a "thanks" after a task-closed day: not on the list, promise stays kept', W.callNeedsYou(day, NOWT) === false && day.promises.every((p) => p.keptAtMs), day);
  ok('10 + 11: the done task is NOT reopened for a thanks (no resurrected to-do)', db.docs.get('leads/L1/tasks/sms-' + DAY_ID).done === true);
  const reconciled2 = await reconcileTaskDone({ db: Object.assign(mkDb({}), { getAll: async (...r) => Promise.all(r.map((x) => x.get())), doc: db.doc }), calls: [], texts: [Object.assign({ userId: TOWNER }, day, { urgent: true })], nowMs: NOWT, live: false });
  ok('10: reconcile honours the reopen stamp even if the day needs Jo for another reason', reconciled2 === 0, reconciled2);

  db = await seeded(closeTask);                      // task ticked at NOWT-7h
  db.docs.set(COLLECTION + '/m3', txt('m3', 7.5, 'inbound', 'water is coming through the ceiling!'));   // arrived BEFORE the tick (he saw it)
  setNotes(async () => NOTE_URGENT);
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('10 control: an inbound text that predates the tick (he had seen it) does not reopen', day.taskDone === true && day.reopenedAtMs === undefined, { taskDone: day.taskDone });
  db = await seeded(closeTask);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'outbound', 'On my way Thursday.'));
  setNotes(async () => NOTE_URGENT);
  await runTextNotes({ db, live: true, nowMs: NOWT });
  day = dayOf(db);
  ok('10 control: Jo\'s own outbound text does not reopen a task-closed day', day.taskDone === true && day.reopenedAtMs === undefined, { taskDone: day.taskDone });
  ok('10 control: the pure helper takes the task stamp', T.reopenPatch({ taskDone: true }, { messages: [{ direction: 'inbound', sentAtMs: 5000 }] }, 9000, 1000).taskDone === false && T.reopenPatch({ taskDone: true }, { messages: [{ direction: 'inbound', sentAtMs: 500 }] }, 9000, 1000) === null);

  // ───────────────────────────────────────────────────────────────────────
  console.log('parity: the rule has one meaning on both sides (rider + texted promise shapes)');
  let n = 0, diffs = 0, oldDiffs = 0;
  const shapes = [
    {}, { promises: joP }, { promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW - D), text: 'x' } },
    { promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW + 2 * D), text: 'x' } },
    { promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW - D), text: 'x', done: true } },
    { promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW - D), text: 'x', keptAtMs: NOW } },
    { promises: [{ who: 'jo', text: 'x', keptAtMs: NOW }], promise: { kind: 'promise', promiseKind: 'callback', dueDate: ymdET(NOW - D), text: 'x' } },
  ];
  for (let age = 0; age <= 100; age += 3) {
    shapes.forEach((shape) => [false, true].forEach((text) => [false, true].forEach((handled) => [false, true].forEach((urgent) => {
      const c = call(Object.assign({ id: 'f', leadId: null, startedAtMs: NOW - age * D, urgent, handledAtMs: handled ? NOW - D : 0 }, shape, text ? { channel: 'text' } : {}));
      n++;
      if (W.callNeedsYou(c, NOW) !== HA.callNeedsYou(c, NOW)) diffs++;
      if (W.oldPromiseCount([c], NOW) !== HA.oldPromiseCount([c], NOW)) oldDiffs++;
    }))));
  }
  ok('callNeedsYou: 0 differences over ' + n + ' age x shape x text x handled x urgent rows', diffs === 0, diffs + ' differ');
  ok('oldPromiseCount: 0 differences on the same rows', oldDiffs === 0, oldDiffs + ' differ');
  ok('positive control: the fuzz really contains old, open promises that are counted', [60, 90].every((a) => W.oldPromiseCount([call({ id: 'f', leadId: null, startedAtMs: NOW - a * D, promises: joP })], NOW) === 1));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
