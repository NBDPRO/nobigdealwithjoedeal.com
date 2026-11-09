/**
 * tests/call-to-close-split-merge-2026-11-09.test.js — Call to Close P2,
 * merging split calls (design §9 P2; documentation/projects/
 * CALL-TO-CLOSE-DESIGN-2026-11-09.md). A call that dropped and was redialed
 * lands as two phone_calls docs.
 *
 *   1. candidate logic (functions/call-merge-logic.js): same number, same
 *      owner tenant, never two different customers, the second within 10
 *      minutes of the first's end, neither merged; the earlier call is
 *      primary; candidates() pairs each call once
 *   2. the client twin (docs/pro/js/call-merge-logic.js) gives the same
 *      answer on every case
 *   3. joinTranscripts / joinSegIndex (what the brief reads)
 *   4. callCenterAction merge: the role test on BOTH calls, texts / bad ids /
 *      non-candidates refused, marks written on both docs and nothing else
 *      (no delete, no audio moved), the earlier call is primary whichever
 *      card was tapped, a repeat is a no-op
 *   5. unmerge (Undo): clears both, idempotent, refuses marks that disagree
 *   6. lists hide merged secondaries: the Call Center (counts too), the
 *      customer page, Home's needs-you rule and its server twin (callWatch),
 *      except while the redial carries an open promise of Jo's (it then stays
 *      on Needs attention / Old promises, as on the Said-you'd-do deck)
 *   7. the Call Center card: "Looks like one call" on both calls of a pair,
 *      Merge goes through callCenterAction, the merged first call carries the
 *      redial (Play, Undo); viewers and a rep who does not own the call see
 *      nothing; the logic loads lazily (no <script> tag, no boot bundle)
 *
 * In-memory Firestore; no network. Run:
 *   node tests/call-to-close-split-merge-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
function load(rel) { try { return require(path.join(ROOT, rel)); } catch (e) { return null; } }

const MG = load('functions/call-merge-logic.js');
const MGC = load('docs/pro/js/call-merge-logic.js');

const T0 = Date.parse('2026-11-05T15:00:00Z');
const MIN = 60 * 1000;
const call = (id, over) => Object.assign({ id, userId: 'jo', companyId: 'co1', phoneDigits: '5135550100', status: 'noted', startedAtMs: T0, durationSec: 120, direction: 'inbound' }, over || {});
// P: 15:00 for 2 min; S: back 3 min after P ended.
const P = call('cube_SPLIT0001', { leadId: 'L1', attachedBy: 'jo' });
const S = call('cube_SPLIT0002', { startedAtMs: T0 + 5 * MIN, durationSec: 90, leadId: null });

const CASES = [
  ['redial 3 min after the first ended', P, S, ''],
  ['order does not matter', S, P, ''],
  ['redial exactly 10 min after the end', P, call('cube_B', { startedAtMs: T0 + 12 * MIN }), ''],
  ['redial 10 min 1 s after the end', P, call('cube_B', { startedAtMs: T0 + 12 * MIN + 1000 }), 'More than 10 minutes apart.'],
  ['a few seconds before the rounded end still counts', P, call('cube_B', { startedAtMs: T0 + 2 * MIN - 5000 }), ''],
  ['two calls at once (more than a minute of overlap)', P, call('cube_B', { startedAtMs: T0 + 30 * 1000 }), 'The calls overlap.'],
  ['same start time', P, call('cube_B', { startedAtMs: T0 }), 'The calls overlap.'],
  ['different number', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, phoneDigits: '5135550199' }), 'Different numbers.'],
  ['different owner', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, userId: 'other' }), 'Different owners.'],
  ['same owner, different company', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, companyId: 'co2' }), 'Different owners.'],
  ['filed on two different customers', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, leadId: 'L2' }), 'Filed on two different customers.'],
  ['both on the same customer', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, leadId: 'L1' }), ''],
  // Review 2026-11-09: an unfiled first call never takes a filed redial. The
  // redial would hide on its customer's page (mergedInto) while the unfiled
  // primary shows there only by number, and neither could be briefed.
  ['an unfiled first call and a redial filed on a customer', call('cube_A', { leadId: null }), call('cube_B', { startedAtMs: T0 + 5 * MIN, leadId: 'L1' }), 'File the first call on the customer first.'],
  ['the same pair, tapped from the redial', call('cube_B', { startedAtMs: T0 + 5 * MIN, leadId: 'L1' }), call('cube_A', { leadId: null }), 'File the first call on the customer first.'],
  ['both unfiled', call('cube_A', { leadId: null }), call('cube_B', { startedAtMs: T0 + 5 * MIN, leadId: null }), ''],
  ['the first call has no length', call('cube_A', { durationSec: null }), call('cube_B', { startedAtMs: T0 + 5 * MIN }), 'The first call has no length.'],
  ['the first is already a merged primary', call('cube_A', { mergedFrom: 'cube_Z' }), call('cube_B', { startedAtMs: T0 + 5 * MIN }), 'Already merged.'],
  ['the second is already merged into another', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, mergedInto: 'cube_Z' }), 'Already merged.'],
  ['a personal call', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, status: 'personal' }), 'Personal or spam calls are not merged.'],
  ['spam', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, callType: 'spam' }), 'Personal or spam calls are not merged.'],
  ['a missed call with no recording', P, call('cube_B', { startedAtMs: T0 + 5 * MIN, status: 'listed' }), 'A missed call has no recording to merge.'],
  ['a day of texts', P, call('txt_5135550100_20261105', { startedAtMs: T0 + 5 * MIN, channel: 'text' }), 'Texts are not merged.'],
  ['no number', call('cube_A', { phoneDigits: '' }), call('cube_B', { startedAtMs: T0 + 5 * MIN, phoneDigits: '' }), 'No caller number.'],
  ['the same call twice', P, P, 'The same call.'],
  ['a short redial (not transcribed) still merges', P, call('cube_B', { startedAtMs: T0 + 3 * MIN, status: 'short', durationSec: 8 }), ''],
];

console.log('\n1. Candidate logic (server)');
ok('functions/call-merge-logic.js exists', !!MG);
if (MG) {
  ok('the window is 10 minutes', MG.MERGE_GAP_MS === 10 * MIN);
  for (const [name, a, b, want] of CASES) {
    const got = MG.pairProblem(a, b);
    ok(name + ' → ' + (want || 'one call'), got === want, got);
  }
  const o = MG.orderPair(S, P);
  ok('the earlier call is primary', o.primary.id === P.id && o.secondary.id === S.id);
  const far = call('cube_SPLIT0003', { startedAtMs: T0 + 60 * MIN });
  const third = call('cube_SPLIT0004', { startedAtMs: T0 + 8 * MIN, durationSec: 30 });
  const cands = MG.candidates([far, S, P, call('txt_x', { channel: 'text', startedAtMs: T0 + 4 * MIN })]);
  ok('candidates: one pair, primary first, the gap in ms', cands.length === 1 && cands[0].primaryId === P.id && cands[0].secondaryId === S.id && cands[0].gapMs === 3 * MIN, cands);
  const chain = MG.candidates([P, S, third]);
  ok('candidates: each call in one pair at most (A-B paired, C left)', chain.length === 1 && chain[0].primaryId === P.id && chain[0].secondaryId === S.id, chain);
  ok('candidates: a merged pair is not suggested again', MG.candidates([Object.assign({}, P, { mergedFrom: S.id }), Object.assign({}, S, { mergedInto: P.id })]).length === 0);
  ok('candidates: other numbers and tenants never pair', MG.candidates([P, call('cube_Q', { startedAtMs: T0 + 5 * MIN, userId: 'other', companyId: 'co2' })]).length === 0);
  ok('candidates: garbage in, nothing out', MG.candidates(null).length === 0 && MG.candidates([null, {}, 'x']).length === 0);
}

console.log('\n2. The client twin agrees');
ok('docs/pro/js/call-merge-logic.js exists', !!MGC);
if (MG && MGC) {
  ok('same window and grace', MGC.MERGE_GAP_MS === MG.MERGE_GAP_MS && MGC.OVERLAP_GRACE_MS === MG.OVERLAP_GRACE_MS);
  const diff = CASES.filter(([, a, b]) => MG.pairProblem(a, b) !== MGC.pairProblem(a, b)).map((c) => c[0]);
  ok('pairProblem: same answer on all ' + CASES.length + ' cases', diff.length === 0, diff);
  const lists = [[P, S], [S, P, call('cube_SPLIT0004', { startedAtMs: T0 + 8 * MIN })], CASES.map((c) => c[2])];
  ok('candidates: same pairs on the same lists', lists.every((l) => JSON.stringify(MG.candidates(l)) === JSON.stringify(MGC.candidates(l))));
  const src = read('docs/pro/js/call-merge-logic.js');
  ok('the client file is pure (no DOM, network or clock)', !/document\.|fetch\(|Date\.now|getDocs|httpsCallable/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log('\n3. What the brief reads');
if (MG) {
  ok('joinTranscripts: first call, separator, the redial, in that order', MG.joinTranscripts('First part.', 'Second part.') === 'First part.' + MG.SEPARATOR + 'Second part.');
  ok('the separator says the call dropped and the same caller came back', /dropped/i.test(MG.SEPARATOR) && /same caller/i.test(MG.SEPARATOR) && !/[<>]/.test(MG.SEPARATOR));
  ok('a redial with no transcript yet adds nothing', MG.joinTranscripts('First part.', '') === 'First part.' && MG.joinTranscripts('First part.', '   ') === 'First part.');
  const BL = require(path.join(ROOT, 'functions', 'call-brief-logic.js'));
  const a = 'We had hail last week and the kitchen ceiling is wet near the vent.';
  const b = 'Sorry it cut out, the claim number is four four seven two nine.';
  const pSeg = { v: 1, off: [0, 30], lp: [-0.2, -0.3], start: [0, 4], end: [4, 9], merged: 1 };
  const sSeg = { v: 1, off: [0, 18], lp: [-0.2, -1.6], start: [0, 3], end: [3, 7], merged: 1 };
  const j = MG.joinSegIndex(pSeg, sSeg, a, b);
  const shift = a.length + MG.SEPARATOR.length;
  ok('joinSegIndex: the redial\'s offsets move past the first call and the separator', JSON.stringify(j.off) === JSON.stringify([0, 30, shift, shift + 18]) && JSON.stringify(j.lp) === JSON.stringify([-0.2, -0.3, -0.2, -1.6]), j);
  const t = MG.joinTranscripts(a, b);
  const unsure = BL.unsureQuotes(t, j);
  ok('a hard-to-hear quote in the redial is still marked unsure', unsure('the claim number is four four seven two nine') === true);
  ok('control: a clear quote in the first call is not', unsure('the kitchen ceiling is wet') === false);
  const pOnly = MG.joinSegIndex({ v: 1, off: [0], lp: [-1.8] }, null, a, b);
  ok('first call indexed, redial not: the first call\'s low segment does not spill onto the redial', BL.unsureQuotes(t, pOnly)('the claim number is four four seven two nine') === false && BL.unsureQuotes(t, pOnly)('kitchen ceiling') === true);
  ok('no index on either call: none', MG.joinSegIndex(null, null, a, b) === null);
  ok('no redial text: the first call\'s own index, unchanged', MG.joinSegIndex(pSeg, sSeg, a, '') === pSeg);
}

// ── callCenterAction ─────────────────────────────────────────────────────
// Reads yield a turn (setImmediate) so two callable runs interleave like two
// people tapping at once. runTransaction is optimistic, as Firestore's is: a
// doc read in the transaction that another write changed before the commit
// makes the whole function run again on fresh reads.
function fakeDb(seed) {
  const docs = new Map(Object.entries(seed));
  const ver = new Map();
  const log = [];
  const tick = () => new Promise((r) => setImmediate(r));
  const put = (p, v, o) => { log.push(['set', p, v, o || null]); ver.set(p, (ver.get(p) || 0) + 1); docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); };
  const mk = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => { await tick(); return { exists: docs.has(p), data: () => docs.get(p) }; },
    set: async (v, o) => put(p, v, o),
    create: async (v) => { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } log.push(['create', p, v]); docs.set(p, v); },
    delete: async () => { log.push(['delete', p]); docs.delete(p); },
  });
  const stats = { retries: 0 };
  return {
    docs, log, stats, doc: mk,
    collection: (n) => ({ doc: (id) => mk(n + '/' + id) }),
    batch: () => { const ops = []; return { set: (ref, v, o) => ops.push(() => ref.set(v, o)), delete: (ref) => ops.push(() => ref.delete()), commit: async () => { for (const f of ops) await f(); } }; },
    runTransaction: async (fn) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const seen = new Map(); const ops = [];
        const tx = {
          get: async (ref) => { if (ops.length) throw new Error('reads after writes in a transaction'); await tick(); seen.set(ref.path, ver.get(ref.path) || 0); return { exists: docs.has(ref.path), data: () => docs.get(ref.path) }; },
          set: (ref, v, o) => { ops.push([ref.path, v, o]); return tx; },
        };
        const out = await fn(tx);
        if ([...seen].some(([p, n]) => (ver.get(p) || 0) !== n)) { stats.retries++; continue; }
        ops.forEach(([p, v, o]) => put(p, v, o));
        return out;
      }
      throw new Error('transaction contention');
    },
  };
}

(async () => {
  let CC = null;
  try { CC = require(path.join(ROOT, 'functions', 'call-center.js')); } catch (e) { console.log('  (call-center.js did not load: ' + e.message + ')'); }
  const { callAction, COLLECTION } = (CC && CC._test) || {};
  const NOW = Date.parse('2026-11-05T18:00:00Z');
  const STORE = (c) => Object.assign({}, c, { storagePath: 'calls/jo/cube-acr/2026-11-05/' + c.id + '.m4a', transcript: 'Transcript of ' + c.id, summary: 'Notes for ' + c.id }, { id: undefined });
  const strip = (o) => { const x = Object.assign({}, o); delete x.id; return x; };
  const seed = (over) => Object.assign({
    ['phone_calls/' + P.id]: strip(STORE(P)),
    ['phone_calls/' + S.id]: strip(STORE(S)),
    'phone_calls/cube_SPLIT0003': strip(STORE(call('cube_SPLIT0003', { startedAtMs: T0 + 60 * MIN }))),
    'phone_calls/cube_SPLIT0004': strip(STORE(call('cube_SPLIT0004', { startedAtMs: T0 + 8 * MIN, durationSec: 30 }))),
    'phone_calls/cube_OTHER0001': strip(STORE(call('cube_OTHER0001', { userId: 'other', companyId: 'co2', startedAtMs: T0 + 4 * MIN }))),
    'phone_calls/cube_REP000001': strip(STORE(call('cube_REP000001', { userId: 'rep', startedAtMs: T0 + 4 * MIN }))),
    'leads/L1': { userId: 'jo', companyId: 'co1' },
  }, over || {});
  const JO = { uid: 'jo', token: { companyId: 'co1' } };
  const run = async (db, auth, data) => { try { return { r: await callAction({ db, auth, data, nowMs: NOW }) }; } catch (e) { return { e }; } };
  const get = (db, id) => db.docs.get('phone_calls/' + id) || {};

  console.log('\n4. callCenterAction merge');
  ok('callCenterAction loads', typeof callAction === 'function' && COLLECTION === 'phone_calls');
  if (callAction) {
    {
      const db = fakeDb(seed());
      const before = JSON.stringify([...db.docs.entries()].filter(([k]) => !k.startsWith('phone_calls/' + P.id) && !k.startsWith('phone_calls/' + S.id)));
      const r = await run(db, JO, { id: S.id, action: 'merge', withId: P.id });
      ok('tapped on the redial: merged, the earlier call is primary', r.r && r.r.merged === true && r.r.primaryId === P.id && r.r.secondaryId === S.id, r.e ? r.e.message : r.r);
      ok('primary carries mergedFrom, the redial mergedInto', get(db, P.id).mergedFrom === S.id && get(db, S.id).mergedInto === P.id && !get(db, P.id).mergedInto && !get(db, S.id).mergedFrom);
      ok('who and when are recorded on both', get(db, P.id).mergedBy === 'jo' && get(db, S.id).mergedBy === 'jo' && get(db, P.id).mergedAtMs === NOW);
      ok('nothing is deleted', !db.log.some((l) => l[0] === 'delete'));
      ok('only the two call docs are written, each once, as merges', db.log.length === 2 && db.log.every((l) => l[0] === 'set' && l[3] && l[3].merge === true && (l[1] === 'phone_calls/' + P.id || l[1] === 'phone_calls/' + S.id)), db.log.map((l) => l[1]));
      ok('no audio moves: storage paths, transcripts and notes are as they were', get(db, P.id).storagePath === STORE(P).storagePath && get(db, S.id).storagePath === STORE(S).storagePath && get(db, S.id).transcript === 'Transcript of ' + S.id && get(db, S.id).summary === 'Notes for ' + S.id);
      ok('the patch writes only the merge marks', db.log.every((l) => Object.keys(l[2]).sort().join() === 'mergedAtMs,mergedBy,mergedFrom,mergedInto'));
      ok('every other doc is untouched', JSON.stringify([...db.docs.entries()].filter(([k]) => !k.startsWith('phone_calls/' + P.id) && !k.startsWith('phone_calls/' + S.id))) === before);
      const n = db.log.length;
      const again = await run(db, JO, { id: P.id, action: 'merge', withId: S.id });
      ok('a repeat (either card) is a no-op: already, no writes', again.r && again.r.already === true && again.r.merged === false && db.log.length === n, again.r);
      const third = await run(db, JO, { id: 'cube_SPLIT0004', action: 'merge', withId: S.id });
      ok('a third call cannot merge into a merged redial', third.e && third.e.code === 'failed-precondition' && /Already merged/.test(third.e.message), third.e && third.e.message);
      const third2 = await run(db, JO, { id: 'cube_SPLIT0004', action: 'merge', withId: P.id });
      ok('...nor into a merged primary', third2.e && third2.e.code === 'failed-precondition');
    }
    {
      const db = fakeDb(seed());
      const r = await run(db, JO, { id: P.id, action: 'merge', withId: S.id });
      ok('tapped on the first call: the same result', r.r && r.r.primaryId === P.id && get(db, S.id).mergedInto === P.id);
    }
    const refused = async (name, auth, data, code, over) => {
      const db = fakeDb(seed(over));
      const r = await run(db, auth, data);
      ok(name + ' → ' + code, r.e && r.e.code === code && !db.log.length, r.e ? r.e.code + ' ' + r.e.message : r.r);
    };
    await refused('not a candidate (an hour apart)', JO, { id: P.id, action: 'merge', withId: 'cube_SPLIT0003' }, 'failed-precondition');
    await refused('signed out', null, { id: P.id, action: 'merge', withId: S.id }, 'unauthenticated');
    await refused('a viewer', { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { id: P.id, action: 'merge', withId: S.id }, 'permission-denied');
    await refused('a viewer who owns the call', { uid: 'jo', token: { role: 'viewer', companyId: 'co1' } }, { id: P.id, action: 'merge', withId: S.id }, 'permission-denied');
    await refused('a sales rep who does not own the call', { uid: 'rep', token: { role: 'sales_rep', companyId: 'co1' } }, { id: P.id, action: 'merge', withId: S.id }, 'permission-denied');
    await refused('a company_admin of another company', { uid: 'c2', token: { role: 'company_admin', companyId: 'co2' } }, { id: P.id, action: 'merge', withId: S.id }, 'permission-denied');
    await refused('the other call is not yours (another tenant)', JO, { id: P.id, action: 'merge', withId: 'cube_OTHER0001' }, 'permission-denied');
    await refused('a rep who owns one call but not the other', { uid: 'rep', token: { role: 'sales_rep', companyId: 'co1' } }, { id: 'cube_REP000001', action: 'merge', withId: P.id }, 'permission-denied');
    await refused('a day of texts', JO, { id: 'txt_5135550100_20261105', action: 'merge', withId: P.id }, 'invalid-argument', { 'phone_text_days/txt_5135550100_20261105': { userId: 'jo', companyId: 'co1', phoneDigits: '5135550100', startedAtMs: T0 + 4 * MIN } });
    await refused('no withId', JO, { id: P.id, action: 'merge' }, 'invalid-argument');
    await refused('a path in withId', JO, { id: P.id, action: 'merge', withId: 'cube_SPLIT0002/../x' }, 'invalid-argument');
    await refused('itself', JO, { id: P.id, action: 'merge', withId: P.id }, 'invalid-argument');
    await refused('the other call is gone', JO, { id: P.id, action: 'merge', withId: 'cube_GONE00001' }, 'not-found');
    for (const [role, uid] of [['company_admin', 'ca'], ['manager', 'mg'], ['admin', 'adm']]) {
      const db = fakeDb(seed());
      const r = await run(db, { uid, token: { role, companyId: role === 'admin' ? 'zz' : 'co1' } }, { id: S.id, action: 'merge', withId: P.id });
      ok(role + ' may merge', r.r && r.r.merged === true, r.e && r.e.message);
    }

    {
      // Two taps at once on a three-way split (review 2026-11-09): one merges
      // the first call with the redial, the other the redial with a third call.
      const db = fakeDb(seed());
      const [a, b] = await Promise.all([
        run(db, JO, { id: P.id, action: 'merge', withId: S.id }),
        run(db, JO, { id: S.id, action: 'merge', withId: 'cube_SPLIT0004' }),
      ]);
      const won = [a, b].filter((x) => x.r && x.r.merged === true).length;
      const lost = [a, b].filter((x) => x.e && x.e.code === 'failed-precondition' && /Already merged/.test(x.e.message)).length;
      ok('two taps at once: one merge wins, the other is refused as already merged', won === 1 && lost === 1, [a, b].map((x) => (x.e ? x.e.message : x.r)));
      const ids = [P.id, S.id, 'cube_SPLIT0004'];
      const bad = ids.filter((id) => {
        const d = get(db, id);
        if (d.mergedFrom && get(db, d.mergedFrom).mergedInto !== id) return true;
        if (d.mergedInto && get(db, d.mergedInto).mergedFrom !== id) return true;
        return !!(d.mergedFrom && d.mergedInto);
      });
      ok('...and every mark left has a partner that agrees', bad.length === 0, ids.map((id) => [id, get(db, id).mergedFrom || null, get(db, id).mergedInto || null]));
    }

    console.log('\n5. unmerge (Undo)');
    {
      const db = fakeDb(seed());
      await run(db, JO, { id: S.id, action: 'merge', withId: P.id });
      const n0 = db.log.length;
      const u = await run(db, JO, { id: S.id, action: 'unmerge' });
      ok('Undo from the redial clears both', u.r && u.r.unmerged === true && !get(db, P.id).mergedFrom && !get(db, S.id).mergedInto && !get(db, P.id).mergedBy, u.e ? u.e.message : u.r);
      ok('who undid it is recorded', get(db, P.id).unmergedBy === 'jo' && get(db, S.id).unmergedAtMs === NOW);
      ok('...two writes, no delete', db.log.length === n0 + 2 && !db.log.some((l) => l[0] === 'delete'));
      const n1 = db.log.length;
      const u2 = await run(db, JO, { id: S.id, action: 'unmerge' });
      ok('a second Undo is a no-op', u2.r && u2.r.unmerged === false && db.log.length === n1);
      ok('the pair is a candidate again after Undo', MG && MG.pairProblem(Object.assign({}, get(db, P.id), { id: P.id }), Object.assign({}, get(db, S.id), { id: S.id })) === '');
      const m2 = await run(db, JO, { id: P.id, action: 'merge', withId: S.id });
      ok('and merges again', m2.r && m2.r.merged === true);
      const u3 = await run(db, JO, { id: P.id, action: 'unmerge' });
      ok('Undo from the first call works too', u3.r && u3.r.unmerged === true && !get(db, S.id).mergedInto);
    }
    {
      const db = fakeDb(seed({ ['phone_calls/' + P.id]: Object.assign(strip(STORE(P)), { mergedFrom: S.id }), ['phone_calls/' + S.id]: Object.assign(strip(STORE(S)), { mergedInto: 'cube_SPLIT0003' }) }));
      const u = await run(db, JO, { id: P.id, action: 'unmerge' });
      ok('marks that disagree: Undo clears the tapped call\'s own mark only', u.r && u.r.unmerged === true && !get(db, P.id).mergedFrom && db.log.length === 1 && db.log[0][1] === 'phone_calls/' + P.id, u.e ? u.e.message : db.log.map((l) => l[1]));
      ok('...the other call keeps its own (it points elsewhere)', get(db, S.id).mergedInto === 'cube_SPLIT0003');
    }
    {
      // The redial was deleted (retention sweep, a manual delete): the first call's mark would dangle forever.
      const sd = seed({ ['phone_calls/' + P.id]: Object.assign(strip(STORE(P)), { mergedFrom: S.id }) });
      delete sd['phone_calls/' + S.id];
      const db = fakeDb(sd);
      const u = await run(db, JO, { id: P.id, action: 'unmerge' });
      ok('the redial is gone: Undo clears the first call\'s mark', u.r && u.r.unmerged === true && !get(db, P.id).mergedFrom && get(db, P.id).unmergedBy === 'jo', u.e ? u.e.message : u.r);
      ok('...writing only that call, never re-creating the gone one', db.log.length === 1 && !db.docs.has('phone_calls/' + S.id));
      ok('...and it is a merge candidate again', MG && MG.callProblem(Object.assign({}, get(db, P.id), { id: P.id })) === '');
    }
    {
      const db = fakeDb(seed());
      await run(db, JO, { id: S.id, action: 'merge', withId: P.id });
      const n = db.log.length;
      const u = await run(db, { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { id: S.id, action: 'unmerge' });
      ok('a viewer cannot Undo', u.e && u.e.code === 'permission-denied' && db.log.length === n);
    }
  }

  console.log('\n6. Lists hide merged secondaries');
  {
    const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
    const CW = require(path.join(ROOT, 'functions/call-watch-logic.js'));
    const NOWL = T0 + 60 * MIN;
    const open = call('cube_OPEN00001', { leadId: null, bucket: 'unknown', promises: [{ who: 'jo', text: 'Call back' }] });
    ok('control: an open call needs you (Home and callWatch)', HA.callNeedsYou(open, NOWL) === true && CW.callNeedsYou(open, NOWL) === true);
    const quiet = call('cube_OPEN00002', { leadId: null, bucket: 'unknown', mergedInto: P.id });
    ok('control: the same unknown call unmerged needs you', HA.callNeedsYou(Object.assign({}, quiet, { mergedInto: null }), NOWL) === true);
    ok('a merged redial with no promise of Jo\'s never needs you on Home', HA.callNeedsYou(quiet, NOWL) === false);
    ok('...nor in callWatch (the server twin)', CW.callNeedsYou(quiet, NOWL) === false);
    // Never forget (review 2026-11-09): a promise Jo made only on the redial
    // still surfaces, as it does on the Said-you'd-do deck and the sweep email.
    const away = Object.assign({}, open, { mergedInto: P.id });
    ok('a merged redial carrying an open promise of Jo\'s still needs you (Home and callWatch)', HA.callNeedsYou(away, NOWL) === true && CW.callNeedsYou(away, NOWL) === true);
    const kept = Object.assign({}, away, { promises: [{ who: 'jo', text: 'Call back', keptAtMs: NOWL - MIN }] });
    ok('...until the promise is kept (both)', HA.callNeedsYou(kept, NOWL) === false && CW.callNeedsYou(kept, NOWL) === false);
    const old = (c) => Object.assign({}, c, { startedAtMs: NOWL - 60 * 86400000 });
    ok('an old merged redial with an open promise is an old promise (both)', HA.isOldPromise(old(away), NOWL) === true && CW.isOldPromise(old(away), NOWL) === true);
    ok('...with none, it is not (both)', HA.isOldPromise(old(quiet), NOWL) === false && CW.isOldPromise(old(quiet), NOWL) === false);
    ok('control: the merged first call still can', HA.callNeedsYou(Object.assign({}, open, { mergedFrom: S.id }), NOWL) === true);

    // The customer page's fetchCalls, run with fake reads.
    const src = read('docs/pro/js/customer-calls.js');
    const pick = (re) => (re.exec(src) || [''])[0];
    const fetchSrc = pick(/  async function fetchCalls\(leadId\) \{[\s\S]*?\n  \}\n/);
    const timeSrc = pick(/  function callTime\(c\) \{[\s\S]*?\n  \}\n/);
    ok('customer page: fetchCalls found', !!fetchSrc && !!timeSrc);
    if (fetchSrc) {
      const rows = {
        phone_calls: [
          Object.assign({}, STORE(P), { id: P.id, mergedFrom: S.id }),
          Object.assign({}, STORE(S), { id: S.id, leadId: 'L1', mergedInto: P.id }),
          Object.assign({}, STORE(call('cube_SPLIT0003', { startedAtMs: T0 + 60 * MIN, leadId: 'L1' })), { id: 'cube_SPLIT0003' }),
        ],
        thursday_calls: [],
      };
      const win = {
        db: {}, auth: { currentUser: { uid: 'jo' } }, _userClaims: {}, _leadDoc: { phoneDigits: '5135550100' },
        where: (f, op, v) => ({ f, v }), limit: () => null, collection: (d, n) => n,
        query: (n, ...w) => ({ n, w: w.filter(Boolean) }),
        getDocs: async (q) => ({ docs: (rows[q.n] || []).filter((r) => q.w.every((x) => r[x.f] === x.v)).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }),
      };
      const ctx = vm.createContext({ window: win, console: { warn() {} } });
      vm.runInContext('function claims() { return window._userClaims || {}; }\nfunction toDate() { return null; }\nfunction leadDigits() { return "5135550100"; }\n' + timeSrc + fetchSrc + '\nthis.__p = fetchCalls("L1");', ctx);
      const got = await ctx.__p;
      const ids = got.map((c) => c._id);
      ok('customer page: the merged redial is not listed (filed or matched by number)', !ids.includes(S.id), ids);
      ok('customer page: the first call and the others are', ids.includes(P.id) && ids.includes('cube_SPLIT0003'), ids);
      ok('customer page: the first call says it was merged', /if \(c\.mergedFrom\) chips \+= chip\('Merged with the redial'/.test(src));
    }
  }

  console.log('\n7. The Call Center card');
  {
    const NOWV = T0 + 30 * MIN;
    class FakeDate extends Date {
      constructor(...a) { if (a.length) super(...a); else super(NOWV); }
      static now() { return NOWV; }
    }
    // withHA: the real needs-you rule (home-attention.js) instead of the view's fallback.
    function boot(claims, uid, calls, withHA) {
      const listeners = {}; const view = { innerHTML: '' }; const badge = { textContent: '', classList: { toggle() {} } };
      const sent = [];
      const rowsDb = { phone_calls: calls, phone_text_days: [] };
      const document = { readyState: 'complete', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view : null), querySelectorAll: () => [], getElementById: (id) => (id === 'callsNavBadge' ? badge : null), activeElement: null };
      const win = { document, _userClaims: claims, _user: { uid }, auth: { currentUser: { uid } }, _leads: [{ id: 'L1', firstName: 'Pat', lastName: 'Example' }], db: {}, collection: (d, n) => n, where: () => null, orderBy: () => null, limit: () => null, query: (c) => c,
        getDocs: async (c) => ({ docs: (rowsDb[c] || []).map((r) => ({ id: r.id, data: () => strip(r) })) }), location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' }, _functions: {},
        _httpsCallable: (fns, name) => async (data) => { sent.push([name, data]); if (name === 'callCenterAction' && data.action === 'merge') { rowsDb.phone_calls = rowsDb.phone_calls.map((r) => (r.id === P.id ? Object.assign({}, r, { mergedFrom: S.id }) : r.id === S.id ? Object.assign({}, r, { mergedInto: P.id }) : r)); return { data: { ok: true, merged: true, primaryId: P.id, secondaryId: S.id } }; } return { data: { items: [] } }; },
        showToast: (o) => sent.push(['toast', o.message]),
        localStorage: { getItem: () => null, setItem() {} } };
      if (withHA) win.NBDHomeAttention = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
      const sandbox = { window: win, document, console, setTimeout, Promise, URLSearchParams, Date: FakeDate, Object, Array, String, Number, JSON, Math, RegExp, CSS: { escape: (s) => String(s) }, history: { replaceState() {} } };
      win.history = sandbox.history; vm.createContext(sandbox);
      vm.runInContext(read('docs/pro/js/call-center-filters-logic.js'), sandbox);
      if (exists('docs/pro/js/call-merge-logic.js')) vm.runInContext(read('docs/pro/js/call-merge-logic.js'), sandbox);
      vm.runInContext(read('docs/pro/js/call-center-view.js'), sandbox);
      const clickEl = (attrs) => ({ closest: (sel) => (sel === '[data-cc]' ? { getAttribute: (a) => (a in attrs ? attrs[a] : null), closest: () => true } : null) });
      return { CC: win.NBDCallCenter, view, sent, badge, click(attrs) { (listeners.click || []).forEach((f) => f({ target: clickEl(attrs) })); } };
    }
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const rowsPair = () => [Object.assign({}, STORE(P), { id: P.id }), Object.assign({}, STORE(S), { id: S.id }), Object.assign({}, STORE(call('cube_SPLIT0003', { startedAtMs: T0 + 25 * MIN })), { id: 'cube_SPLIT0003' })];
    const v = boot({ companyId: 'co1' }, 'jo', rowsPair());
    await v.CC.reload();
    v.click({ 'data-cc': 'filter', 'data-arg': 'all' });
    const card = (h, id) => { const i = h.indexOf('data-call-id="' + id + '"'); if (i < 0) return ''; const j = h.indexOf('data-call-id="', i + 20); return h.slice(i, j < 0 ? h.length : j); };
    ok('a pair: "Looks like one call" on the first call\'s card', /Looks like one call/.test(card(v.view.innerHTML, P.id)) && /data-cc="merge" data-id="cube_SPLIT0001" data-arg="cube_SPLIT0002"/.test(card(v.view.innerHTML, P.id)), card(v.view.innerHTML, P.id).slice(0, 300));
    ok('...and on the redial\'s card', /Looks like one call/.test(card(v.view.innerHTML, S.id)) && /data-cc="merge" data-id="cube_SPLIT0002" data-arg="cube_SPLIT0001"/.test(card(v.view.innerHTML, S.id)));
    ok('control: a call 20 min later gets no suggestion', !/Looks like one call/.test(card(v.view.innerHTML, 'cube_SPLIT0003')));
    ok('nothing is merged by itself (no callable call on load)', !v.sent.some((s) => s[0] === 'callCenterAction'));
    v.click({ 'data-cc': 'merge', 'data-id': S.id, 'data-arg': P.id });
    await settle(); await settle();
    const m = v.sent.filter((s) => s[0] === 'callCenterAction')[0];
    ok('Merge is one tap through callCenterAction merge', m && m[1].action === 'merge' && m[1].id === S.id && m[1].withId === P.id, m);
    ok('...with an Undo', v.sent.some((s) => s[0] === 'toast' && /Merged into one call/.test(s[1])));
    const h = v.view.innerHTML;
    if (process.env.DEBUG_MERGE) console.log(card(h, P.id));
    ok('after the merge the redial leaves the list', !/data-call-id="cube_SPLIT0002"/.test(h));
    ok('the first call\'s card says so, plays the redial and offers Undo', /Merged with the redial/.test(card(h, P.id)) && /data-cc="play" data-id="cube_SPLIT0002"/.test(card(h, P.id)) && /data-cc="unmerge" data-id="cube_SPLIT0001"/.test(card(h, P.id)), card(h, P.id).slice(0, 400));
    v.click({ 'data-cc': 'unmerge', 'data-id': P.id });
    await settle();
    const u = v.sent.filter((s) => s[0] === 'callCenterAction' && s[1].action === 'unmerge')[0];
    ok('Undo merge is callCenterAction unmerge', u && u[1].id === P.id);

    // Merged on load: every tab and count leaves the redial out.
    const merged = [Object.assign({}, STORE(P), { id: P.id, mergedFrom: S.id, promises: [{ who: 'jo', text: 'Call back' }] }), Object.assign({}, STORE(S), { id: S.id, mergedInto: P.id, leadId: null, bucket: 'unknown', promises: [{ who: 'jo', text: 'Send photos' }] })];
    const w = boot({ companyId: 'co1' }, 'jo', merged, true);
    await w.CC.reload();
    const tabs = ['all', 'customer', 'unknown'];
    const seen = [];
    for (const t of tabs) { w.click({ 'data-cc': 'filter', 'data-arg': t }); if (/data-call-id="cube_SPLIT0002"/.test(w.view.innerHTML)) seen.push(t); }
    ok('merged on load: the redial is on no list tab (' + tabs.join(', ') + ')', seen.length === 0, seen);
    ok('...and no list count includes it (Unknown 0)', /data-arg="unknown">Unknown <span class="cc-count">0<\/span>/.test(w.view.innerHTML), (/data-arg="unknown">[^<]*<span class="cc-count">\d+/.exec(w.view.innerHTML) || [''])[0]);
    // Never forget: while its own promise of Jo's is open, the redial stays on
    // Needs attention (the same rule Home, callWatch and the deck read).
    w.click({ 'data-cc': 'filter', 'data-arg': 'attention' });
    const att = w.view.innerHTML;
    ok('merged on load, the redial\'s promise open: it is on Needs attention, counted', /data-call-id="cube_SPLIT0002"/.test(att) && /Send photos/.test(att) && /data-arg="attention">Needs attention <span class="cc-count">2<\/span>/.test(att), (/data-arg="attention">[^<]*<span class="cc-count">\d+/.exec(att) || [''])[0]);
    ok('...and its card says it was merged and why it shows', /Merged into the .* call\. It shows here while your promise on it is open\./.test(card(att, S.id)), card(att, S.id).slice(0, 500));
    const keptRows = merged.map((r) => (r.id === S.id ? Object.assign({}, r, { promises: [{ who: 'jo', text: 'Send photos', keptAtMs: T0 }] }) : r));
    const wk = boot({ companyId: 'co1' }, 'jo', keptRows, true);
    await wk.CC.reload();
    wk.click({ 'data-cc': 'filter', 'data-arg': 'attention' });
    ok('control: its promise kept, the redial leaves Needs attention too', !/data-call-id="cube_SPLIT0002"/.test(wk.view.innerHTML) && /data-arg="attention">Needs attention <span class="cc-count">1<\/span>/.test(wk.view.innerHTML));

    for (const [name, cl, uid] of [['a viewer', { role: 'viewer', companyId: 'co1' }, 'v'], ['a sales rep who does not own the calls', { role: 'sales_rep', companyId: 'co1' }, 'rep']]) {
      const x = boot(cl, uid, rowsPair());
      await x.CC.reload();
      x.click({ 'data-cc': 'filter', 'data-arg': 'all' });
      ok(name + ': no Merge suggestion', !/data-cc="merge"/.test(x.view.innerHTML));
      const y = boot(cl, uid, merged);
      await y.CC.reload();
      y.click({ 'data-cc': 'filter', 'data-arg': 'all' });
      ok(name + ': no Undo merge', !/data-cc="unmerge"/.test(y.view.innerHTML));
    }
    const ca = boot({ role: 'company_admin', companyId: 'co1' }, 'ca', rowsPair());
    await ca.CC.reload();
    ca.click({ 'data-cc': 'filter', 'data-arg': 'all' });
    ok('a company_admin of the company sees the suggestion', /data-cc="merge"/.test(ca.view.innerHTML));

    // A mark the brief does not honour (review 2026-11-09): the card says so and Undo still clears it.
    const lone = boot({ companyId: 'co1' }, 'jo', [Object.assign({}, STORE(P), { id: P.id, mergedFrom: S.id })]);
    await lone.CC.reload();
    lone.click({ 'data-cc': 'filter', 'data-arg': 'all' });
    const lc = card(lone.view.innerHTML, P.id);
    ok('redial not found: the card does not claim the brief reads both', /Merged with the redial/.test(lc) && !/reads both/.test(lc) && /reads this call alone/.test(lc), lc.slice(0, 400));
    ok('...and still offers Undo merge', /data-cc="unmerge" data-id="cube_SPLIT0001"/.test(lc));
    const moved = boot({ companyId: 'co1' }, 'jo', [Object.assign({}, STORE(P), { id: P.id, leadId: 'L2', mergedFrom: S.id }), Object.assign({}, STORE(S), { id: S.id, leadId: 'L1', mergedInto: P.id })]);
    await moved.CC.reload();
    moved.click({ 'data-cc': 'filter', 'data-arg': 'all' });
    const mc = card(moved.view.innerHTML, P.id);
    ok('first call moved to another customer: the card says the brief reads it alone', /Merged with the redial/.test(mc) && !/reads both/.test(mc) && /reads this call alone/.test(mc), mc.slice(0, 400));
    ok('control: a merge the brief honours says it reads both', /reads both/.test(card(h, P.id)));

    const view = read('docs/pro/js/call-center-view.js');
    ok('the logic loads lazily from the view (ScriptLoader.load on open)', /ScriptLoader\.load\('\/pro\/js\/call-merge-logic\.js\?v=1'\)/.test(view) && /loadMerge\(\)/.test(view));
    const pages = fs.readdirSync(path.join(ROOT, 'docs/pro')).filter((f) => f.endsWith('.html')).map((f) => read('docs/pro/' + f)).join('\n');
    ok('no <script> tag names it on any page', !/call-merge-logic/.test(pages));
    // Review 2026-11-09: cached clients kept listing redials until the next bump.
    const bust = (src, re) => Number((re.exec(src) || [])[1] || 0);
    ok('call-center-view.js cache-busted past v=28 (P2 changed it)', bust(read('docs/pro/js/script-loader.js'), /js\/call-center-view\.js\?v=(\d+)/) >= 29);
    ok('home-attention.js cache-busted past v=25 (P2 changed it)', bust(read('docs/pro/dashboard.html'), /js\/home-attention\.js\?v=(\d+)/) >= 26);
    ok('no boot bundle names it', !/call-merge-logic/.test(read('docs/pro/js/script-loader.js')));
    const added = view.split('\n').filter((l) => /merge/i.test(l)).join('\n');
    ok('no inline style or handler in the new markup', !/style=|\son[a-z]+=/.test(added));
    ok('every interpolated value in the merge markup is escaped', !/\+ (away|o|c)\.(id|startedAtMs) \+/.test(added) && !/\+ note \+/.test(added));
    ok('the browser never writes phone_calls (callable only)', !/(setDoc|updateDoc|addDoc|deleteDoc)\([^;]*phone_calls/.test(view));
  }

  console.log('\n8. Wiring');
  {
    const cc = read('functions/call-center.js');
    ok('callCenterAction: merge / unmerge are actions of the existing callable (no new export)', /action === 'merge' \|\| action === 'unmerge'/.test(cc));
    const idx = read('functions/FUNCTIONS_INDEX.md');
    ok('FUNCTIONS_INDEX documents merge / unmerge', /`merge \{withId\}`/.test(idx) && /`unmerge`/.test(idx));
    const rules = read('firestore.rules');
    const pc = (/match \/phone_calls\/\{docId\} \{[\s\S]*?\n    \}/.exec(rules) || [''])[0];
    ok('phone_calls stays server-written (allow write: if false)', /allow (create, update, delete|write): if false/.test(pc), pc.slice(0, 200));
  }

  console.log('\n9. The demo');
  {
    // Review 2026-11-09: a Merge tap in the sample account said "this would file this call on a customer".
    const { pathToFileURL } = require('url');
    let FN = null;
    try { FN = await import(pathToFileURL(path.join(ROOT, 'docs/pro/demo-sdk/firebase-functions.js')).href); } catch (e) { console.log('  (demo functions did not load: ' + e.message + ')'); }
    const say = (a) => (FN ? FN.sampleCallableMessage('callCenterAction', a === undefined ? undefined : { id: P.id, action: a, withId: S.id }) : '');
    ok('Merge in the demo says it would merge the two calls', /would merge these two calls into one/.test(say('merge')) && !/file this call/.test(say('merge')), say('merge'));
    ok('Undo merge says it would split them back', /would split this call back into two/.test(say('unmerge')) && !/file this call/.test(say('unmerge')), say('unmerge'));
    ok('control: filing still says it would file the call', /would file this call on a customer/.test(say('attach')) && /would file this call on a customer/.test(say()));
    ok('the refusal the visitor sees carries the payload through', /callableError\(name, payload\)/.test(read('docs/pro/demo-sdk/firebase-functions.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
