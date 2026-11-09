/**
 * tests/call-to-close-p1-leftovers-2026-11-09.test.js — Call to Close P2,
 * lane "dmmap": the server-side leftovers the P1 session note listed
 * (documentation/projects/SESSION-2026-11-09-call-to-close-p1.md "Gaps").
 *
 *   1. quota TTL: call_transcribe_quota, call_brief_quota and coach_line_quota
 *      day counters carry an expireAt (a Date, a week after the write), and
 *      firestore.indexes.json declares a TTL policy on each (no index on the
 *      TTL field); the P1 session note lists the console step for Jo
 *   2. callBriefAuto: an update that changes none of the filing fields
 *      returns before anything is read (the db is never even asked for);
 *      the trigger runs at 256MiB, not 512MiB, still maxInstances 5
 *   3. callCenterAction promise (slot 1-5, the brief's Add): a due date equal
 *      to a date the brief marked hard to hear (retype) is refused unless the
 *      client says it was typed (retyped: true), the same honour rule as
 *      callBriefDecide; a different date, slot 0 and a brief with no retype
 *      promise are untouched; the sheet sends retyped / briefPromise
 *
 * Every Firestore is a fake; nothing reaches Google or Anthropic.
 * Run: node tests/call-to-close-p1-leftovers-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail.slice(0, 400) : JSON.stringify(detail)) : '')); }
}

// ── stubs (the trigger options and handler are captured, not deployed) ──
const silent = { info() {}, warn() {}, error() {}, debug() {} };
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
let dbAsked = 0;
const FV = { serverTimestamp: () => ({ __ts: true }), increment: (n) => ({ __inc: n }), delete: () => null };
const STUBS = {
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }), defineString: (n) => ({ name: n, value: () => '' }) },
  'firebase-functions/v2': { logger: silent },
  'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  'firebase-functions/v2/firestore': { onDocumentUpdated: (o, h) => ({ __trigger: 'updated', __opts: o, __handler: h }), onDocumentWritten: (o, h) => ({ __trigger: 'written', __opts: o, __handler: h }), onDocumentCreated: (o, h) => ({ __trigger: 'created', __opts: o, __handler: h }) },
  'firebase-admin/firestore': { getFirestore: () => { dbAsked++; return countingDb(); }, FieldValue: FV, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};

// A db that counts every read path it is asked for.
let reads = 0;
function countingDb() {
  const doc = (p) => ({ path: p, get: async () => { reads++; return { exists: false, data: () => undefined }; }, set: async () => {}, collection: (n) => coll(p + '/' + n) });
  const coll = (n) => ({ doc: (id) => doc(n + '/' + id) });
  return { doc, collection: coll, runTransaction: async () => { reads++; return ''; } };
}

// A transaction fake that records what each takeQuota writes.
function quotaDb() {
  const writes = [];
  const doc = (p) => ({ path: p, get: async () => ({ exists: false, data: () => ({}) }) });
  return {
    writes,
    collection: (n) => ({ doc: (id) => doc(n + '/' + id) }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d) => writes.push({ path: r.path, data: d }) }),
  };
}

const NOW = Date.parse('2026-11-05T18:00:00Z');
const WEEK = 7 * 86400000;

(async () => {
  console.log('\n1. Quota day counters expire (TTL on expireAt)');
  const quotas = [
    ['call_brief_quota', () => require(path.join(FN, 'call-brief.js'))._test.takeQuota],
    ['call_transcribe_quota', () => require(path.join(FN, 'call-transcribe-now.js'))._test.takeQuota],
    ['coach_line_quota', () => require(path.join(FN, 'coach-line.js'))._test.takeQuota],
  ];
  for (const [col, get] of quotas) {
    let take = null;
    try { take = get(); } catch (e) { ok(col + ': takeQuota loads', false, e.message); continue; }
    const db = quotaDb();
    await take(db, 'u1', 'co1', NOW);
    const mine = db.writes.filter((w) => w.path.startsWith(col + '/'));
    ok(col + ': both counters are written', mine.length === 2, db.writes.map((w) => w.path));
    ok(col + ': every counter carries expireAt, a Date a week after the write',
      mine.length === 2 && mine.every((w) => w.data.expireAt instanceof Date && w.data.expireAt.getTime() === NOW + WEEK), mine.map((w) => w.data.expireAt));
  }
  const idx = JSON.parse(read('firestore.indexes.json'));
  for (const col of ['call_brief_quota', 'call_transcribe_quota', 'coach_line_quota']) {
    const fo = (idx.fieldOverrides || []).find((f) => f.collectionGroup === col && f.fieldPath === 'expireAt');
    ok('firestore.indexes.json: a TTL policy on ' + col + '.expireAt, with no index on it', !!fo && fo.ttl === true && Array.isArray(fo.indexes) && fo.indexes.length === 0, fo);
  }
  const note = read('documentation/projects/SESSION-2026-11-09-call-to-close-p1.md');
  ok('the session note gives Jo the TTL console step for all three', /call_transcribe_quota/.test(note) && /call_brief_quota/.test(note) && /coach_line_quota/.test(note) && /gcloud firestore fields ttls update expireAt/.test(note));

  console.log('\n2. callBriefAuto: unrelated updates read nothing; 256MiB');
  const CB = require(path.join(FN, 'call-brief.js'));
  const trig = CB.callBriefAuto;
  ok('callBriefAuto runs at 256MiB', !!trig && trig.__opts && trig.__opts.memory === '256MiB', trig && trig.__opts && trig.__opts.memory);
  ok('…still maxInstances 5 and the same document', !!trig && trig.__opts.maxInstances === 5 && trig.__opts.document === 'phone_calls/{callId}');
  const L = require(path.join(FN, 'call-brief-logic.js'));
  ok('call-brief-logic exports filingChanged (the cheap pre-check)', typeof L.filingChanged === 'function');
  const TRANSCRIPT = 'Hi this is Pat. The roof is leaking in the kitchen after the hail storm. My insurance is State Farm. I will send you the estimate by Friday. Thanks a lot.';
  const FILED = { userId: 'jo', companyId: 'co1', status: 'noted', callType: 'customer', leadId: 'L1', attachedBy: 'jo', attachedAtMs: NOW - 60e3, alternateLeadIds: [], transcript: TRANSCRIPT };
  const ev = (before, after) => ({ params: { callId: 'cube_TTLTEST01' }, data: { before: { exists: !!before, data: () => before }, after: { exists: !!after, data: () => after } } });
  const unrelated = [
    ['handled', FILED, Object.assign({}, FILED, { handledAtMs: NOW, handledBy: 'jo' })],
    ['a transcribe lease', Object.assign({}, FILED, { status: 'stored', transcript: '' }), Object.assign({}, FILED, { status: 'stored', transcript: '', transcribeLease: { untilMs: NOW + 9e5 } })],
    ['rescueDismiss', FILED, Object.assign({}, FILED, { rescueDismissedAtMs: NOW })],
    ['a label', FILED, Object.assign({}, FILED, { label: 'Hot' })],
  ];
  if (typeof L.filingChanged === 'function') {
    for (const [what, b, a] of unrelated) ok('filingChanged is false for ' + what, L.filingChanged(b, a) === false);
    ok('filingChanged is true for an attach', L.filingChanged(Object.assign({}, FILED, { attachedBy: null }), FILED) === true);
    ok('…for notes arriving', L.filingChanged(Object.assign({}, FILED, { status: 'transcribed' }), FILED) === true);
    ok('…for a move', L.filingChanged(FILED, Object.assign({}, FILED, { leadId: 'L2', movedBy: 'jo', movedAtMs: NOW })) === true);
    ok('…for a transcript appearing', L.filingChanged(Object.assign({}, FILED, { transcript: '' }), FILED) === true);
    ok('…for a create (no before)', L.filingChanged(null, FILED) === true);
    // Equivalence with the full transition on every pair: the pre-check never hides a filing.
    const pairs = unrelated.concat([[0, Object.assign({}, FILED, { attachedBy: null }), FILED], [0, Object.assign({}, FILED, { status: 'transcribed' }), FILED], [0, FILED, Object.assign({}, FILED, { leadId: 'L2', movedBy: 'jo', movedAtMs: NOW })]]);
    ok('no transition is ever true where filingChanged is false', pairs.every(([, b, a]) => L.filingChanged(b, a) || !L.autoBriefTransition(b, a)));
  }
  if (trig && typeof trig.__handler === 'function') {
    for (const [what, b, a] of unrelated) {
      dbAsked = 0; reads = 0;
      await trig.__handler(ev(b, a));
      ok('an update that only sets ' + what + ': the db is never asked for, nothing read', dbAsked === 0 && reads === 0, { dbAsked, reads });
    }
  }
  const src = read('functions/call-brief.js');
  const body = (src.match(/exports\.callBriefAuto = onDocumentUpdated\([\s\S]*?\n\);/) || [''])[0];
  ok('the trigger checks filingChanged before the transition and before getFirestore()', body.indexOf('filingChanged') > 0 && body.indexOf('filingChanged') < body.indexOf('autoBriefTransition') && body.indexOf('filingChanged') < body.indexOf('getFirestore'), body.slice(0, 300));

  console.log('\n3. callCenterAction: a hard-to-hear promise date is typed, not taken');
  Module._load = realLoad;   // call-center.js runs on the real SDK modules (as the P0 slot suite does)
  const CC = require(path.join(FN, 'call-center.js'));
  const { callAction, COLLECTION } = CC._test;
  const ID = 'cube_RETYPE001';
  function fakeDb(seed) {
    const docs = new Map(Object.entries(seed));
    const mk = (p) => ({ id: p.split('/').pop(), path: p,
      get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
      set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
      create: async (v) => { docs.set(p, v); }, delete: async () => { docs.delete(p); } });
    const q = { where: () => q, orderBy: () => q, limit: () => q, get: async () => ({ docs: [], size: 0, forEach() {} }) };
    return { docs, doc: mk, collection: (n) => Object.assign({}, q, { doc: (id) => mk(n + '/' + id) }), collectionGroup: () => q, batch: () => ({ set() {}, commit: async () => {} }) };
  }
  const BRIEF = { summary: { text: 'x' }, promises: [
    { who: 'jo', text: 'Call back', kind: 'callback', dueSpoken: 'the ninth', dueYmd: '2026-11-09', quote: 'call you on the ninth', unsure: true, retype: true },
    { who: 'jo', text: 'Send estimate', kind: 'estimate', dueSpoken: 'Friday', dueYmd: '2026-11-06', quote: 'estimate by Friday' },
  ] };
  const seed = (brief) => ({
    [COLLECTION + '/' + ID]: { userId: 'jo', companyId: 'co1', status: 'noted', leadId: 'L1', attachedBy: 'jo', startedAtMs: NOW - 3e6, direction: 'inbound' },
    'leads/L1': { userId: 'jo', companyId: 'co1', firstName: 'Pat' },
    ['leads/L1/call_briefs/' + ID]: { callId: ID, leadId: 'L1', v: 1, brief },
  });
  const run = async (db, data) => { try { return { r: await callAction({ db, auth: { uid: 'jo', token: {} }, data: Object.assign({ id: ID, action: 'promise' }, data), nowMs: NOW }) }; } catch (e) { return { e }; } };
  {
    const db = fakeDb(seed(BRIEF));
    const r = await run(db, { kind: 'callback', dueYmd: '2026-11-09', why: 'Call back', slot: 1, briefPromise: 0 });
    ok('slot 1 with the heard-as date of a retype promise, no retyped → refused', r.e && r.e.code === 'failed-precondition' && /hard to hear/i.test(r.e.message), r.e ? r.e.message : r.r);
    ok('…and no task is written', !db.docs.has('leads/L1/tasks/promise-' + ID + '-1'));
    const r2 = await run(db, { kind: 'callback', dueYmd: '2026-11-09', why: 'Call back', slot: 1, briefPromise: 0, retyped: true });
    ok('…the same date with retyped: true (the person typed it) → added', r2.r && r2.r.ok === true && db.docs.has('leads/L1/tasks/promise-' + ID + '-1'), r2.e && r2.e.message);
  }
  {
    const db = fakeDb(seed(BRIEF));
    const r = await run(db, { kind: 'callback', dueYmd: '2026-11-10', why: 'Call back', slot: 1, briefPromise: 0 });
    ok('a different date than the heard-as one → added (it was typed)', r.r && r.r.ok === true, r.e && r.e.message);
  }
  {
    const db = fakeDb(seed(BRIEF));
    const r = await run(db, { kind: 'callback', dueYmd: '2026-11-09', why: 'Call back', slot: 1 });
    ok('no briefPromise index: any retype date of the brief still counts → refused', r.e && r.e.code === 'failed-precondition', r.r);
  }
  {
    const db = fakeDb(seed(BRIEF));
    const r = await run(db, { kind: 'estimate', dueYmd: '2026-11-06', why: 'Send estimate', slot: 2, briefPromise: 1 });
    ok('a clear promise (not retype) with its own date → added', r.r && r.r.ok === true, r.e && r.e.message);
  }
  {
    const db = fakeDb(seed(BRIEF));
    const r = await run(db, { kind: 'callback', dueYmd: '2026-11-09', why: 'Call back' });
    ok('slot 0 (the card\'s Promise button, no brief) is unchanged → added', r.r && r.r.ok === true, r.e && r.e.message);
  }
  {
    const db = fakeDb(seed({ summary: { text: 'x' }, promises: [] }));
    const r = await run(db, { kind: 'callback', dueYmd: '2026-11-09', why: 'Call back', slot: 1 });
    ok('a brief with no retype promise → added', r.r && r.r.ok === true, r.e && r.e.message);
    const db2 = fakeDb(Object.assign(seed(BRIEF), { ['leads/L1/call_briefs/' + ID]: undefined }));
    db2.docs.delete('leads/L1/call_briefs/' + ID);
    const r2 = await run(db2, { kind: 'callback', dueYmd: '2026-11-09', why: 'Call back', slot: 1 });
    ok('no stored brief → added (nothing to compare with)', r2.r && r2.r.ok === true, r2.e && r2.e.message);
  }
  {
    const db = fakeDb(seed(BRIEF));
    const r = await run(db, { kind: 'callback', why: 'Call back', slot: 1, briefPromise: 0 });
    ok('a retype promise added with no date (the person left it empty) → added', r.r && r.r.ok === true, r.e && r.e.message);
  }
  const ui = read('docs/pro/js/call-brief-ui.js');
  const yes = (ui.match(/if \(a === 'promise-yes'\) \{[\s\S]*?render\(\); return;\n    \}/) || [''])[0];
  ok('the sheet sends briefPromise and retyped (only for a retype promise with a typed date)', /data\.briefPromise = i/.test(yes) && /p\.retype === true && ps\.dueYmd\) data\.retyped = true/.test(yes), yes.slice(0, 400));
  const cc = read('functions/call-center.js');
  ok('call-center.js documents the honour rule beside the check', /honour/i.test(cc) && /retyped/.test(cc));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
