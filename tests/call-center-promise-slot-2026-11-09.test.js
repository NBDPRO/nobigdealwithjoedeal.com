/**
 * tests/call-center-promise-slot-2026-11-09.test.js — Call to Close P0 step 3:
 * callCenterAction (functions/call-center.js) changes for the Call Brief.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.2 "When a
 * call is moved", §4.3.
 *
 *   1. promise `slot` 0 or absent: byte-identical to today (task id
 *      promise-<callId>, the same task doc, the generic cube- task retired,
 *      the same call patch). Pinned against a literal golden.
 *   2. slot n (1-5) writes promise-<callId>-<n>, never overwrites slot 0
 *      (a "waiting" promise no longer overwrites Jo's), does not retire the
 *      generic task, still marks the call handled; a bad slot is refused; a
 *      call on no customer refuses slot > 0
 *   3. a move deletes the old lead's call brief (leads/{from}/call_briefs/{id});
 *      the new lead gets none; so does attaching a filed call elsewhere
 *
 * In-memory Firestore (same shape as call-center-action-2026-10-01.test.js).
 * Run: node tests/call-center-promise-slot-2026-11-09.test.js
 */
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const { callAction, COLLECTION } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function fakeDb(seed) {
  const docs = new Map(Object.entries(seed));
  const log = [];
  const mk = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
    set: async (v, o) => { log.push(['set', p, v, o || null]); docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    create: async (v) => { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } log.push(['create', p, v]); docs.set(p, v); },
    delete: async () => { log.push(['delete', p]); docs.delete(p); },
  });
  const query = (name, filters, lim) => ({
    where: (f, op, v) => query(name, filters.concat([[f, op, v]]), lim),
    orderBy: () => query(name, filters, lim),
    limit: (n) => query(name, filters, n),
    get: async () => {
      const depth = name.split('/').length + 1;
      const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === depth
        && filters.every(([f, op, val]) => Object.prototype.hasOwnProperty.call(v, f) && (op === '==' ? v[f] === val : false))).slice(0, lim || 1e9)
        .map(([k, v]) => ({ id: k.split('/')[depth - 1], ref: mk(k), exists: true, data: () => v }));
      return { docs: rows, size: rows.length, forEach: (fn) => rows.forEach(fn) };
    },
  });
  return {
    docs, log, doc: mk,
    collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }),
    collection: (n) => Object.assign(query(n, [], null), { doc: (id) => mk(n + '/' + id) }),
    batch: () => { const ops = []; return { set: (ref, v, o) => ops.push(() => ref.set(v, o)), commit: async () => { for (const f of ops) await f(); } }; },
  };
}
const OWN = 'owner1';
const ID = 'cube_SLOT001';
const seed = () => ({
  [COLLECTION + '/' + ID]: { userId: OWN, companyId: 'co1', phoneDigits: '5135550100', status: 'noted', leadId: 'L1', attachedBy: OWN, bucket: 'customer', startedAtMs: Date.parse('2026-11-05T15:00:00Z'), summary: 'Wants an estimate.', promises: [{ who: 'jo', text: 'Send estimate', due: '2026-11-06' }], direction: 'inbound' },
  'leads/L1': { userId: OWN, companyId: 'co1', firstName: 'Pat' },
  'leads/L2': { userId: OWN, companyId: 'co1', firstName: 'Sam' },
  ['leads/L1/tasks/cube-' + ID]: { title: 'Send estimate', done: false, dueDate: '2026-11-06' },
  ['leads/L1/activity/cube-' + ID]: { type: 'call', summary: 'Wants an estimate.' },
  ['leads/L1/call_briefs/' + ID]: { callId: ID, leadId: 'L1', v: 1, brief: { summary: { text: 'x' } } },
});
const NOW = Date.parse('2026-11-05T18:00:00Z');
const owner = { uid: OWN, token: {} };
const run = async (db, data) => { try { return { r: await callAction({ db, auth: owner, data, nowMs: NOW }) }; } catch (e) { return { e }; } };
// Server timestamps are sentinels; compare everything else literally.
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && typeof x === 'object' && x.constructor && /FieldValue|Transform|Sentinel/.test(x.constructor.name) ? '<serverTimestamp>' : x)));

(async () => {
  console.log('\n1. slot 0 / absent: byte-identical to today');
  // Captured from callCenterAction BEFORE the slot change (2026-11-09, base 2c2647142).
  const GOLDEN_TASK = {
    kind: 'promise', promiseKind: 'estimate', text: 'Send estimate - Quote by Friday', why: 'Quote by Friday', done: false,
    dueDate: '2026-11-06', dueBy: null, madeYmd: '2026-11-05', madeBy: OWN, source: 'call', sourceCallId: ID, missCount: 0, rescheduleCount: 0,
    leadId: 'L1', userId: OWN, title: 'Send estimate - Quote by Friday', createdBy: 'Promise capture', phoneCallId: ID,
    updatedAt: '<serverTimestamp>', companyId: 'co1', madeAt: '<serverTimestamp>', createdAt: '<serverTimestamp>',
  };
  const writesOf = async (extra) => {
    const db = fakeDb(seed());
    const r = await run(db, Object.assign({ id: ID, action: 'promise', kind: 'estimate', dueYmd: '2026-11-06', why: 'Quote by Friday' }, extra));
    return { db, r, log: plain(db.log) };
  };
  const a = await writesOf({});
  const z = await writesOf({ slot: 0 });
  const zs = await writesOf({ slot: '0' });
  ok('no slot: the task is promise-<callId>', a.r.r && a.r.r.taskId === 'promise-' + ID, JSON.stringify(a.r));
  const task = plain(a.db.docs.get('leads/L1/tasks/promise-' + ID));
  const keysMatch = JSON.stringify(Object.keys(task).sort()) === JSON.stringify(Object.keys(GOLDEN_TASK).sort());
  ok('no slot: the task doc matches the golden, field for field', keysMatch && Object.keys(GOLDEN_TASK).every((k) => JSON.stringify(task[k]) === JSON.stringify(GOLDEN_TASK[k])),
    JSON.stringify(Object.keys(GOLDEN_TASK).filter((k) => JSON.stringify(task[k]) !== JSON.stringify(GOLDEN_TASK[k])).map((k) => [k, task[k], GOLDEN_TASK[k]])) + (keysMatch ? '' : ' keys ' + JSON.stringify(Object.keys(task))));
  ok('no slot: the generic cube- task is retired as superseded', a.db.docs.get('leads/L1/tasks/cube-' + ID).done === true && a.db.docs.get('leads/L1/tasks/cube-' + ID).supersededBy === 'promise-' + ID);
  const call = a.db.docs.get(COLLECTION + '/' + ID);
  ok('no slot: the call is marked handled with the promise task id and kind', call.handledAtMs === NOW && call.handledBy === OWN && call.promiseTaskId === 'promise-' + ID && call.promiseKind === 'estimate');
  ok('slot 0: the same writes, in the same order, as no slot', JSON.stringify(z.log) === JSON.stringify(a.log), JSON.stringify(z.log).slice(0, 300));
  ok('slot "0" (a string from a form): the same writes too', JSON.stringify(zs.log) === JSON.stringify(a.log));
  ok('slot 0: the same answer as no slot', JSON.stringify(z.r.r) === JSON.stringify(a.r.r));

  console.log('\n2. slot 1-5');
  {
    const db = fakeDb(seed());
    await run(db, { id: ID, action: 'promise', kind: 'estimate', dueYmd: '2026-11-06', why: 'Quote by Friday' });
    const slot0 = JSON.stringify(plain(db.docs.get('leads/L1/tasks/promise-' + ID)));
    const r1 = await run(db, { id: ID, action: 'promise', kind: 'waiting', waitingOn: 'customer', why: 'Adjuster report', slot: 1 });
    ok('slot 1 writes promise-<callId>-1', r1.r && r1.r.taskId === 'promise-' + ID + '-1' && !!db.docs.get('leads/L1/tasks/promise-' + ID + '-1'), JSON.stringify(r1.e && r1.e.message));
    ok('…and does NOT overwrite slot 0 (a waiting promise no longer replaces Jo\'s)', JSON.stringify(plain(db.docs.get('leads/L1/tasks/promise-' + ID))) === slot0);
    ok('…slot 1 is the waiting chase', db.docs.get('leads/L1/tasks/promise-' + ID + '-1').promiseKind === 'waiting');
    ok('…the call keeps slot 0 as its promise task', db.docs.get(COLLECTION + '/' + ID).promiseTaskId === 'promise-' + ID && db.docs.get(COLLECTION + '/' + ID).promiseKind === 'estimate');
    const db2 = fakeDb(seed());
    await run(db2, { id: ID, action: 'promise', kind: 'callback', why: 'Call with a time', slot: 2 });
    ok('a slot > 0 never retires the generic cube- task', db2.docs.get('leads/L1/tasks/cube-' + ID).done === false);
    ok('…but every promise marks the call handled', db2.docs.get(COLLECTION + '/' + ID).handledAtMs === NOW);
    ok('…and a call with no slot-0 promise yet points at the slot it has', db2.docs.get(COLLECTION + '/' + ID).promiseTaskId === 'promise-' + ID + '-2');
    await run(db2, { id: ID, action: 'promise', kind: 'callback', why: 'Call with a new time', slot: 2 });
    ok('the same slot again edits that promise (one task)', /new time/.test(db2.docs.get('leads/L1/tasks/promise-' + ID + '-2').text));
    for (const bad of [6, -1, 1.5, 'x', 99]) {
      const r = await run(fakeDb(seed()), { id: ID, action: 'promise', kind: 'callback', slot: bad });
      ok('slot ' + JSON.stringify(bad) + ' → invalid-argument', r.e && r.e.code === 'invalid-argument');
    }
    const nolead = seed();
    nolead[COLLECTION + '/' + ID] = Object.assign({}, nolead[COLLECTION + '/' + ID], { leadId: null });
    const r = await run(fakeDb(nolead), { id: ID, action: 'promise', kind: 'callback', slot: 1 });
    ok('a call on no customer refuses slot > 0 (one promise rides on the call doc)', r.e && r.e.code === 'failed-precondition');
    const r0 = await run(fakeDb(nolead), { id: ID, action: 'promise', kind: 'callback', slot: 0 });
    ok('…slot 0 on no customer behaves as today (rides on the call)', r0.r && r0.r.on === 'call');
  }

  console.log('\n3. a move deletes the old lead\'s brief');
  {
    const db = fakeDb(seed());
    const r = await run(db, { id: ID, action: 'move', leadId: 'L2' });
    ok('moved', r.r && r.r.moved === true, JSON.stringify(r.e && r.e.message));
    ok('the brief on the old lead is gone', !db.docs.has('leads/L1/call_briefs/' + ID));
    ok('the new lead gets no brief until someone taps again', !db.docs.has('leads/L2/call_briefs/' + ID));
    ok('the move still carries the timeline entry and task (unchanged)', db.docs.has('leads/L2/activity/cube-' + ID) && db.docs.has('leads/L2/tasks/cube-' + ID) && !db.docs.has('leads/L1/activity/cube-' + ID));
    const db2 = fakeDb(Object.assign(seed(), { ['leads/L1/call_briefs/' + ID]: undefined }));
    db2.docs.delete('leads/L1/call_briefs/' + ID);
    const r2 = await run(db2, { id: ID, action: 'move', leadId: 'L2' });
    ok('a move with no brief still works', r2.r && r2.r.moved === true);
    const db3 = fakeDb(seed());
    const r3 = await run(db3, { id: ID, action: 'attach', leadId: 'L2' });
    ok('attaching a filed call to another customer also deletes the old brief', r3.r && !db3.docs.has('leads/L1/call_briefs/' + ID));
    const db4 = fakeDb(seed());
    await run(db4, { id: ID, action: 'attach', leadId: 'L1' });
    ok('…confirming the same customer (attach to L1) keeps the brief', db4.docs.has('leads/L1/call_briefs/' + ID));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
