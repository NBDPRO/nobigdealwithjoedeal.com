/**
 * tests/call-to-close-retention-2026-11-09.test.js — Call to Close P2, Q7:
 * the call retention sweep (functions/call-retention.js + -logic.js).
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §7, §11 Q7
 * (briefs and transcripts 24 months, CRM audio copies 12 months, Drive
 * originals untouched). Runbook: SESSION-2026-11-09-call-to-close-p2-retention.md.
 *
 *   1. age math: calendar months in America/New_York, month-end clamping,
 *      leap years, DST, the exact cutoff instant, the later-of-two dates rule
 *   2. holds: legalHold on the call or the lead, an open insurance claim
 *   3. dry run (CALL_RETENTION_ENABLED unset) reads and counts, writes nothing
 *   4. live: audio deleted only under calls/{owner}/, transcript + notes
 *      stripped, the phone_calls doc kept and marked, briefs deleted, every
 *      deletion audited (ids and dates only), Drive never touched
 *   5. batches, the cursor (ties on the same ms), the cap, the deadline,
 *      the 30-day rescan, a failed record does not stop the run
 *   6. wiring: gate, cron-gates, flags registry, heartbeat plan, index.js,
 *      function map, FUNCTIONS_INDEX, the collection-group index, rules
 *
 * Every Firestore and Storage call is a fake; nothing reaches the network.
 * Run: node tests/call-to-close-retention-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

// ── fakes ───────────────────────────────────────────────────────────────
const DOC_ID = { __docId: true };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function deepMerge(base, patch) {
  const out = Object.assign({}, base || {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !v.__ts) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}
function makeDb(seed) {
  const store = new Map(Object.entries(clone(seed || {})));
  const writes = [];
  let auto = 0;
  const opts = { failCommitFor: null };
  function ref(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => ({ id: p.split('/').pop(), exists: store.has(p), data: () => clone(store.get(p)) }),
      set: async (data, o) => { writes.push({ op: 'set', path: p, data: clone(data) }); store.set(p, o && o.merge ? deepMerge(store.get(p), data) : clone(data)); },
      delete: async () => { writes.push({ op: 'delete', path: p }); store.delete(p); },
    };
  }
  function query(match, keyOf) {
    const q = { filters: [], orders: [], after: null, lim: Infinity };
    const api = {
      where(f, op, v) { q.filters.push([f, op, v]); return api; },
      orderBy(f) { q.orders.push(f); return api; },
      startAfter(...vals) { q.after = vals; return api; },
      limit(n) { q.lim = n; return api; },
      count() { return { get: async () => { const lim = q.lim, after = q.after; q.lim = Infinity; q.after = null; const r = await api.get(); q.lim = lim; q.after = after; return { data: () => ({ count: r.size }) }; } }; },
      async get() {
        const rows = [];
        for (const [p, data] of store) {
          if (!match(p)) continue;
          let pass = true;
          for (const [f, op, v] of q.filters) {
            const x = data[f];
            if (typeof x !== 'number') { pass = false; break; }
            if (op === '<' && !(x < v)) pass = false;
          }
          if (pass) rows.push({ p, data });
        }
        const keyVals = (r) => q.orders.map((f) => (f === DOC_ID ? keyOf(r.p) : r.data[f]));
        const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
        rows.sort((a, b) => cmp(keyVals(a), keyVals(b)));
        const after = q.after ? rows.filter((r) => cmp(keyVals(r), q.after) > 0) : rows;
        const docs = after.slice(0, q.lim).map((r) => ({ id: r.p.split('/').pop(), ref: ref(r.p), data: () => clone(r.data) }));
        return { docs, empty: !docs.length, size: docs.length };
      },
    };
    return api;
  }
  return {
    store, writes, opts,
    doc: (p) => ref(p),
    collection: (name) => Object.assign(query((p) => p.split('/').length === 2 && p.split('/')[0] === name, (p) => p.split('/')[1]), {
      doc: (id) => ref(name + '/' + (id || ('auto' + String(++auto).padStart(5, '0')))),
    }),
    collectionGroup: (name) => query((p) => { const s = p.split('/'); return s.length >= 2 && s.length % 2 === 0 && s[s.length - 2] === name; }, (p) => p),
    batch() {
      const ops = [];
      return {
        set(r, data, o) { ops.push(() => r.set(data, o)); },
        delete(r) { ops.push(() => r.delete()); },
        async commit() {
          if (opts.failCommitFor && ops.length && opts.failCommitFor(ops)) throw new Error('commit failed (fake)');
          for (const f of ops) await f();
        },
      };
    },
  };
}
function makeBucket() {
  const deleted = []; const touched = [];
  return { deleted, touched, file: (p) => { touched.push(p); return { delete: async (o) => { deleted.push({ p, o }); } }; } };
}
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const STUBS = {
  'firebase-functions/v2': { logger: silent },
  'firebase-admin/firestore': { getFirestore: () => null, FieldValue: { serverTimestamp: () => ({ __ts: true }) }, FieldPath: { documentId: () => DOC_ID } },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => null }) },
  './integrations/heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};

let R = {}, M = {}, T = {};
try { R = require(path.join(FN, 'call-retention-logic.js')); } catch (e) { console.log('  (call-retention-logic.js did not load: ' + e.message + ')'); }
try { M = require(path.join(FN, 'call-retention.js')); T = M._test || {}; } catch (e) { console.log('  (call-retention.js did not load: ' + e.message + ')'); }
const fnOr = (f) => (typeof f === 'function' ? f : () => { throw new Error('missing'); });
const tryv = (f) => { try { return f(); } catch (e) { return 'THREW ' + e.message; } };

const Z = (s) => Date.parse(s);
const NOW = Z('2026-11-09T08:20:00Z'); // 03:20 ET (EST), the scheduled time

(async () => {
  console.log('\n1. Age math: calendar months in America/New_York');
  {
    const mm = fnOr(R.minusMonths);
    ok('2026-11-09 minus 24 months = 2024-11-09', tryv(() => mm('2026-11-09', 24)) === '2024-11-09');
    ok('2026-11-09 minus 12 months = 2025-11-09', tryv(() => mm('2026-11-09', 12)) === '2025-11-09');
    ok('Aug 31 minus 6 months clamps to Feb 28 (2026)', tryv(() => mm('2026-08-31', 6)) === '2026-02-28');
    ok('Aug 31 minus 6 months clamps to Feb 29 in a leap year (2028)', tryv(() => mm('2028-08-31', 6)) === '2028-02-29');
    ok('Feb 29 2028 minus 24 months = Feb 28 2026 (no Feb 29 in 2026)', tryv(() => mm('2028-02-29', 24)) === '2026-02-28');
    ok('Jan 15 minus 1 month crosses the year', tryv(() => mm('2026-01-15', 1)) === '2025-12-15');
    ok('Mar 31 minus 1 month = Feb 28', tryv(() => mm('2026-03-31', 1)) === '2026-02-28');
    const mid = fnOr(R.etMidnightMs);
    ok('00:00 ET in July is 04:00Z (EDT)', tryv(() => mid('2026-07-01')) === Z('2026-07-01T04:00:00Z'));
    ok('00:00 ET in January is 05:00Z (EST)', tryv(() => mid('2026-01-01')) === Z('2026-01-01T05:00:00Z'));
    ok('00:00 ET on the spring-forward day is still EST (05:00Z)', tryv(() => mid('2026-03-08')) === Z('2026-03-08T05:00:00Z'));
    ok('00:00 ET on the fall-back day is still EDT (04:00Z)', tryv(() => mid('2026-11-01')) === Z('2026-11-01T04:00:00Z'));
    const ymd = fnOr(R.etYmd);
    ok('04:30Z on Nov 9 is still Nov 8 in ET', tryv(() => ymd(Z('2026-11-09T04:30:00Z'))) === '2026-11-08');
    ok('05:30Z on Nov 9 is Nov 9 in ET', tryv(() => ymd(Z('2026-11-09T05:30:00Z'))) === '2026-11-09');
    const cut = fnOr(R.cutoffMs);
    const c24 = tryv(() => cut(NOW, 24)), c12 = tryv(() => cut(NOW, 12));
    ok('24-month cutoff at 03:20 ET Nov 9 2026 = 2024-11-09 00:00 EST', c24 === Z('2024-11-09T05:00:00Z'), new Date(c24).toISOString && String(c24));
    ok('12-month cutoff = 2025-11-09 00:00 EST', c12 === Z('2025-11-09T05:00:00Z'));
    ok('a call at 23:59 ET on 2024-11-08 is past 24 months on 2026-11-09', tryv(() => R.isPast(Z('2024-11-09T04:59:00Z'), c24)) === true);
    ok('a call at 00:00 ET on 2024-11-09 is not (it goes the next day)', tryv(() => R.isPast(Z('2024-11-09T05:00:00Z'), c24)) === false);
    ok('a run at 23:30 ET Nov 8 uses Nov 8 as today (ET, not UTC)', tryv(() => cut(Z('2026-11-09T04:30:00Z'), 24)) === Z('2024-11-08T05:00:00Z'));
    ok('a summer cutoff lands on EDT midnight', tryv(() => cut(Z('2026-07-15T16:00:00Z'), 12)) === Z('2025-07-15T04:00:00Z'));
    const age = fnOr(R.callAgeMs);
    ok('a call\'s age counts from the LATER of start and filing (late import keeps longer)', tryv(() => age({ startedAtMs: 1000, createdAtMs: 5000 })) === 5000);
    ok('start only → start; filing only → filing', tryv(() => age({ startedAtMs: 7 })) === 7 && tryv(() => age({ createdAtMs: 9 })) === 9);
    ok('no usable date → null, never eligible', tryv(() => age({})) === null && tryv(() => age({ startedAtMs: 'x', createdAtMs: null })) === null && tryv(() => R.isPast(null, c24)) === false);
    ok('a brief counts from generatedAtMs', tryv(() => R.briefAgeMs({ generatedAtMs: 42 })) === 42 && tryv(() => R.briefAgeMs({})) === null);
    ok('the policy is 24 / 12 / 24 months', JSON.stringify(R.POLICY) === JSON.stringify({ transcriptMonths: 24, audioMonths: 12, briefMonths: 24 }));
  }

  console.log('\n2. Holds');
  {
    const h = fnOr(R.holdReason);
    ok('call legalHold → held', tryv(() => h({ call: { legalHold: true }, lead: {} })) === 'call_legal_hold');
    ok('lead legalHold → held', tryv(() => h({ call: {}, lead: { legalHold: true } })) === 'lead_legal_hold');
    ok('legalHold must be exactly true ("yes" is not a hold; a typo never deletes MORE, it only fails to hold)', tryv(() => h({ call: { legalHold: 'yes' }, lead: {} })) === null);
    for (const s of ['Claim Filed', 'Adjuster Scheduled', 'Approved', 'Supplementing', 'Denied', 'in_progress', 'Filed']) {
      ok('claimStatus "' + s + '" is an open claim → held', tryv(() => h({ call: {}, lead: { claimStatus: s } })) === 'open_claim');
    }
    for (const s of ['No Claim', 'Paid Out', '', 'no claim', ' Paid Out ']) {
      ok('claimStatus "' + s + '" is not open', tryv(() => h({ call: {}, lead: { claimStatus: s } })) === null);
    }
    ok('no lead, no hold flag → not held', tryv(() => h({ call: {}, lead: null })) === null);
    // A lead written by insurance-claim.js without ClaimCore has claimStage and no
    // claimStatus (ClaimCore.normalizeClaim falls back to claimStage the same way).
    for (const st of ['claim_filed', 'adjuster_scheduled', 'adjuster_visit', 'estimate_review', 'supplement_filed', 'approved', 'work_scheduled', 'denied', 'some_new_stage']) {
      ok('claimStage "' + st + '" with no claimStatus is an open claim → held', tryv(() => h({ call: {}, lead: { claimStage: st } })) === 'open_claim');
      ok('claimStage "' + st + '" with claimStatus "No Claim" (the dropdown default) → held', tryv(() => h({ call: {}, lead: { claimStage: st, claimStatus: 'No Claim' } })) === 'open_claim');
    }
    for (const st of ['initial_inspection', 'documentation', 'completed', '']) {
      ok('claimStage "' + st + '" alone is not an open claim', tryv(() => h({ call: {}, lead: { claimStage: st } })) === null);
    }
    ok('claimStatus "Paid Out" is Jo\'s explicit close: it clears a stale open claimStage', tryv(() => h({ call: {}, lead: { claimStatus: 'Paid Out', claimStage: 'approved' } })) === null);
    ok('an open claimStatus is held whatever the stage says', tryv(() => h({ call: {}, lead: { claimStatus: 'Claim Filed', claimStage: 'completed' } })) === 'open_claim');
    for (const st of ['claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done', 'scope_received', 'supplement_requested', 'supplement_approved']) {
      ok('pipeline stage "' + st + '" (the insurance track) → held', tryv(() => h({ call: {}, lead: { stage: st } })) === 'open_claim');
    }
    ok('a pipeline insurance stage with claimStatus "Paid Out" → not held', tryv(() => h({ call: {}, lead: { stage: 'scope_received', claimStatus: 'Paid Out' } })) === null);
    ok('a claim number on file (a filed claim) with no status → held', tryv(() => h({ call: {}, lead: { claimNumber: 'CLM-123' } })) === 'open_claim');
    ok('a claim number with claimStatus "Paid Out" → not held', tryv(() => h({ call: {}, lead: { claimNumber: 'CLM-123', claimStatus: 'Paid Out' } })) === null);
    ok('a carrier alone (intake records the homeowner\'s insurer before any claim) is not a hold', tryv(() => h({ call: {}, lead: { insCarrier: 'State Farm', carrier: 'State Farm', insuranceCarrier: 'State Farm' } })) === null);
    ok('pipeline stage "closed_won" is not an insurance stage', tryv(() => h({ call: {}, lead: { stage: 'closed_won' } })) === null);
    {
      // The stage → status map is claim-core.js's, copied server-side; it must not drift.
      const core = read('docs/pro/js/claim-core.js');
      const m = core.match(/var STAGE_TO_STATUS = \{([\s\S]*?)\};/);
      const browser = m ? Object.fromEntries([...m[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => [x[1], x[2]])) : null;
      ok('call-retention-logic STAGE_TO_STATUS matches claim-core.js', !!browser && JSON.stringify(R.STAGE_TO_STATUS) === JSON.stringify(browser), { server: R.STAGE_TO_STATUS, browser });
      const ky = read('functions/ky-insurance-law.js').match(/var INSURANCE_STAGES = \[([\s\S]*?)\];/);
      const kyStages = ky ? [...ky[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
      ok('call-retention-logic INSURANCE_STAGES matches ky-insurance-law.js', !!kyStages && JSON.stringify(R.INSURANCE_STAGES) === JSON.stringify(kyStages), { server: R.INSURANCE_STAGES, ky: kyStages });
    }
  }

  console.log('\n3. Paths: only the CRM copy under calls/{owner}/');
  {
    const p = fnOr(R.isCrmAudioPath);
    const call = { userId: 'jo' };
    ok('calls/jo/cube-acr/2024-06-01/cube_x.m4a → yes', tryv(() => p('calls/jo/cube-acr/2024-06-01/cube_x.m4a', call)) === true);
    for (const bad of ['', null, 'drive/abc', '1AbCdriveFileId', 'calls/other/cube-acr/x.m4a', 'calls/jo/../other/x', 'calls//x', 'gs://b/calls/jo/x', '/calls/jo/x', 'calls/jo']) {
      ok('refuses ' + JSON.stringify(bad), tryv(() => p(bad, call)) === false);
    }
    ok('refuses when the call has no owner', tryv(() => p('calls/jo/x/y.m4a', {})) === false);
  }

  // ── a seeded tenant ─────────────────────────────────────────────────
  const OLD = Z('2024-06-01T15:00:00Z'), MID = Z('2025-06-01T15:00:00Z'), NEW = Z('2026-10-01T15:00:00Z');
  const T_SECRET = 'my deductible is secret words';
  const call = (o) => Object.assign({
    userId: 'jo', companyId: 'jo', status: 'noted', source: 'cube-acr', driveFileId: 'drv-' + (o.id || 'x'),
    transcript: T_SECRET, summary: 'Summary words', promises: [{ text: 'send estimate' }], segIndex: { v: 1, rows: [[0, 5, -0.2]] },
    callerFacts: { name: 'Pat' }, actionItems: [{ t: 'x' }], phoneDigits: '5135550100', durationSec: 120,
  }, o);
  function seed() {
    const s = {
      'leads/L1': { claimStatus: 'Paid Out' },
      'leads/L2': { claimStatus: 'Claim Filed' },
      'leads/L3': { legalHold: true },
      'leads/L4': { claimStatus: 'Denied' },
      'leads/L5': {},
      'phone_calls/old1': call({ id: 'old1', leadId: 'L1', startedAtMs: OLD, createdAtMs: OLD + 3600e3, storagePath: 'calls/jo/cube-acr/2024-06-01/old1.m4a' }),
      'phone_calls/mid1': call({ id: 'mid1', leadId: 'L5', startedAtMs: MID, createdAtMs: MID, storagePath: 'calls/jo/cube-acr/2025-06-01/mid1.m4a' }),
      'phone_calls/new1': call({ id: 'new1', leadId: 'L5', startedAtMs: NEW, createdAtMs: NEW, storagePath: 'calls/jo/cube-acr/2026-10-01/new1.m4a' }),
      'phone_calls/held1': call({ id: 'held1', leadId: 'L2', startedAtMs: OLD, createdAtMs: OLD, storagePath: 'calls/jo/cube-acr/2024-06-01/held1.m4a' }),
      'phone_calls/held2': call({ id: 'held2', leadId: 'L1', legalHold: true, startedAtMs: OLD, createdAtMs: OLD, storagePath: 'calls/jo/cube-acr/2024-06-01/held2.m4a' }),
      'phone_calls/held3': call({ id: 'held3', leadId: 'L3', startedAtMs: OLD, createdAtMs: OLD, storagePath: 'calls/jo/cube-acr/2024-06-01/held3.m4a' }),
      'phone_calls/held4': call({ id: 'held4', leadId: 'L4', startedAtMs: OLD, createdAtMs: OLD, storagePath: 'calls/jo/cube-acr/2024-06-01/held4.m4a' }),
      'phone_calls/bad1': call({ id: 'bad1', leadId: null, startedAtMs: OLD, createdAtMs: OLD, storagePath: 'calls/someoneelse/cube-acr/x.m4a' }),
      'phone_calls/late1': call({ id: 'late1', leadId: null, startedAtMs: OLD, createdAtMs: NEW, storagePath: 'calls/jo/cube-acr/2024-06-01/late1.m4a' }),
      'phone_calls/pers1': call({ id: 'pers1', leadId: null, status: 'personal', transcript: null, summary: null, promises: [], segIndex: null, callerFacts: null, actionItems: [], storagePath: null, startedAtMs: OLD, createdAtMs: OLD }),
      'leads/L1/call_briefs/old1': { generatedAtMs: OLD + 7200e3, brief: { summary: { text: T_SECRET } } },
      'leads/L5/call_briefs/mid1': { generatedAtMs: MID, brief: {} },
      'leads/L5/call_briefs/gone9': { generatedAtMs: Z('2024-01-02T15:00:00Z'), brief: {} },
      'leads/L5/call_briefs/fresh9': { generatedAtMs: Z('2026-01-02T15:00:00Z'), brief: {} },
      'leads/L2/call_briefs/held1': { generatedAtMs: OLD, brief: {} },
      'users/u1/call_briefs/x1': { generatedAtMs: OLD, brief: {} },
    };
    return s;
  }
  const run = fnOr(T.runRetention);
  const base = (db, bucket, extra) => Object.assign({ db, bucket, nowMs: NOW, log: silent, clock: () => 0, deadlineMs: 1e12 }, extra || {});

  console.log('\n4. Dry run writes nothing');
  let dry;
  {
    const db = makeDb(seed()); const bucket = makeBucket();
    const before = JSON.stringify([...db.store]);
    try { dry = await run(base(db, bucket, { live: false })); } catch (e) { dry = { err: e.message }; }
    ok('the run returns its mode', dry && dry.mode === 'dry-run', dry);
    ok('no Firestore write at all (not even the cursor)', db.writes.length === 0, db.writes.map((w) => w.path));
    ok('no Storage delete', bucket.deleted.length === 0);
    ok('the store is byte-identical', JSON.stringify([...db.store]) === before);
    const P = (dry && dry.phases) || {};
    ok('it still counts: audio would go on old1, mid1 (2)', P.audio && P.audio.eligible === 2, P.audio);
    ok('transcripts would go on old1 and bad1 (2; a bad audio path does not stop the 24-month rule)', P.transcript && P.transcript.eligible === 2, P.transcript);
    ok('briefs: gone9 would go (old1\'s goes with its transcript)', P.brief && P.brief.eligible >= 1, P.brief);
    ok('holds are counted by reason', P.audio && P.audio.held && P.audio.held.open_claim === 2 && P.audio.held.call_legal_hold === 1 && P.audio.held.lead_legal_hold === 1, P.audio && P.audio.held);
    ok('the bad path is counted, not deleted', P.audio && P.audio.badPath === 1);
    ok('a dry run reports the whole backlog past each cutoff, not just the first page (audio 8, transcript 7, brief 4)',
      P.audio && P.audio.pastCutoff === 8 && P.transcript.pastCutoff === 7 && P.brief.pastCutoff === 4, P.audio && [P.audio.pastCutoff, P.transcript.pastCutoff, P.brief.pastCutoff]);
    {
      const dbc = makeDb(seed()); const coll = dbc.collection;
      dbc.collection = (n) => { const q = coll(n); q.count = () => ({ get: async () => { throw new Error('count unsupported'); } }); return q; };
      let rc; try { rc = await run(base(dbc, makeBucket(), { live: false })); } catch (e) { rc = { err: e.message }; }
      ok('a failed count leaves pastCutoff null and the dry run still counts eligible', rc.phases && rc.phases.audio.pastCutoff === null && rc.phases.audio.eligible === 2, rc.err || (rc.phases && rc.phases.audio));
    }
  }

  console.log('\n5. Live run');
  {
    const db = makeDb(seed()); const bucket = makeBucket();
    let r; try { r = await run(base(db, bucket, { live: true })); } catch (e) { r = { err: e.message }; }
    const S = db.store;
    ok('mode live', r && r.mode === 'live', r);
    ok('a live run does not spend a count query', r.phases && r.phases.audio.pastCutoff === undefined);
    const delPaths = bucket.deleted.map((d) => d.p).sort();
    ok('audio deleted for old1 and mid1 only (12 months)', JSON.stringify(delPaths) === JSON.stringify(['calls/jo/cube-acr/2024-06-01/old1.m4a', 'calls/jo/cube-acr/2025-06-01/mid1.m4a']), delPaths);
    ok('every Storage delete uses ignoreNotFound', bucket.deleted.every((d) => d.o && d.o.ignoreNotFound === true));
    ok('Storage is only ever touched under calls/jo/', bucket.touched.every((p) => p.startsWith('calls/jo/')), bucket.touched);
    ok('old1: audio gone, storagePath null, audioRemoved retention', S.get('phone_calls/old1').storagePath === null && S.get('phone_calls/old1').audioRemoved === 'retention');
    const o1 = S.get('phone_calls/old1') || {};
    ok('old1: transcript and notes stripped', o1.transcript === null && o1.summary === null && o1.segIndex === null && o1.callerFacts === null && Array.isArray(o1.promises) && !o1.promises.length && Array.isArray(o1.actionItems) && !o1.actionItems.length && o1.transcriptSaved === false);
    ok('old1: the doc itself is kept (date, number, customer, duration, Drive id)', o1.startedAtMs === OLD && o1.phoneDigits === '5135550100' && o1.leadId === 'L1' && o1.durationSec === 120 && o1.driveFileId === 'drv-old1' && o1.status === 'noted');
    ok('old1: marked retention.{transcriptStrippedAtMs, audioDeletedAtMs}', o1.retention && o1.retention.transcriptStrippedAtMs === NOW && o1.retention.audioDeletedAtMs === NOW, o1.retention);
    ok('old1: its brief under the lead is deleted', !S.has('leads/L1/call_briefs/old1'));
    const m1 = S.get('phone_calls/mid1') || {};
    ok('mid1 (17 months): audio gone, transcript KEPT', m1.storagePath === null && m1.transcript === T_SECRET && m1.summary === 'Summary words');
    ok('mid1: its brief is kept (under 24 months)', S.has('leads/L5/call_briefs/mid1'));
    const n1 = S.get('phone_calls/new1') || {};
    ok('new1: untouched', n1.storagePath === 'calls/jo/cube-acr/2026-10-01/new1.m4a' && n1.transcript === T_SECRET && !n1.retention);
    for (const id of ['held1', 'held2', 'held3', 'held4']) {
      const c = S.get('phone_calls/' + id) || {};
      ok(id + ': held, nothing touched', c.transcript === T_SECRET && c.storagePath && !c.retention);
    }
    ok('a held call\'s brief is kept (lead with an open claim)', S.has('leads/L2/call_briefs/held1'));
    const b1 = S.get('phone_calls/bad1') || {};
    ok('bad1 (not the owner\'s path): Storage untouched, storagePath kept', b1.storagePath === 'calls/someoneelse/cube-acr/x.m4a' && !bucket.touched.includes('calls/someoneelse/cube-acr/x.m4a'));
    ok('bad1: its transcript still follows the 24-month rule', b1.transcript === null);
    const l1 = S.get('phone_calls/late1') || {};
    ok('late1 (old call imported 5 weeks ago): kept, counted from the import', l1.transcript === T_SECRET && l1.storagePath);
    const p1 = S.get('phone_calls/pers1') || {};
    ok('pers1 (personal, nothing left): no write', !p1.retention && !db.writes.some((w) => w.path === 'phone_calls/pers1'));
    ok('brief gone9 (generated 34 months ago, no call doc): deleted', !S.has('leads/L5/call_briefs/gone9'));
    ok('brief fresh9: kept', S.has('leads/L5/call_briefs/fresh9'));
    ok('a call_briefs doc outside leads/ is never touched', S.has('users/u1/call_briefs/x1') && r.phases && r.phases.brief.badPath === 1);
    ok('no phone_calls doc was ever deleted', !db.writes.some((w) => w.op === 'delete' && w.path.startsWith('phone_calls/')));
    ok('every deletion is a call_brief or nothing (only briefs are deleted docs)', db.writes.filter((w) => w.op === 'delete').every((w) => /^leads\/[^/]+\/call_briefs\/[^/]+$/.test(w.path)));
    const logs = [...S].filter(([p]) => p.startsWith('call_retention_log/')).map(([, v]) => v);
    const kinds = logs.map((l) => l.kind + ':' + l.callId).sort();
    ok('one audit row per deletion', JSON.stringify(kinds) === JSON.stringify(['audio:mid1', 'audio:old1', 'brief:gone9', 'brief:old1', 'transcript:bad1', 'transcript:old1']), kinds);
    ok('audit rows carry ids, dates, cutoff, policy and the run id', logs.every((l) => l.runId === 'r' + NOW && l.atMs === NOW && Number.isFinite(l.cutoffMs) && [12, 24].includes(l.policyMonths) && l.createdAt && l.createdAt.__ts));
    ok('audit rows never carry what was said', !JSON.stringify(logs).includes('secret words') && !JSON.stringify(logs).includes('Summary words'));
    ok('the audio audit names the Storage path and keeps the Drive id for the record', logs.some((l) => l.kind === 'audio' && l.storagePath === 'calls/jo/cube-acr/2024-06-01/old1.m4a' && l.driveFileId === 'drv-old1'));
    ok('the transcript audit lists the fields stripped', logs.some((l) => l.kind === 'transcript' && l.callId === 'old1' && JSON.stringify(l.fields) === JSON.stringify(['transcript', 'segIndex', 'summary', 'promises', 'callerFacts', 'actionItems'])));
    const st = S.get('system/callRetention') || {};
    ok('the cursor state is saved server-side (system/callRetention)', st.cursors && st.cursors.audio && st.passStartedAtMs === NOW && st.lastRunAtMs === NOW, st);
    ok('dry-run counts match what the live run did', dry && dry.phases && r.phases && dry.phases.audio.eligible === r.phases.audio.done && dry.phases.transcript.eligible === r.phases.transcript.done);

    // A second live run the next day: nothing more to do, and it starts after the cursor.
    const writesBefore = db.writes.length; bucket.deleted.length = 0;
    let r2; try { r2 = await run(base(db, bucket, { live: true, nowMs: NOW + 86400e3 })); } catch (e) { r2 = { err: e.message }; }
    ok('the next run deletes nothing more', bucket.deleted.length === 0 && db.writes.slice(writesBefore).every((w) => w.path === 'system/callRetention'), db.writes.slice(writesBefore).map((w) => w.path));
    ok('the next run starts after the cursor (scans nothing already scanned)', r2 && r2.phases && r2.phases.audio.scanned === 0 && r2.phases.transcript.scanned === 0, r2 && r2.phases);
  }

  console.log('\n5b. A never-transcribed call leaves the transcribe queue with its audio');
  {
    const db = makeDb({
      'leads/L5': {},
      'phone_calls/wait1': call({ id: 'wait1', leadId: 'L5', status: 'stored', transcript: null, summary: null, promises: [], segIndex: null, callerFacts: null, actionItems: [], startedAtMs: MID, createdAtMs: MID, storagePath: 'calls/jo/cube-acr/2025-06-01/wait1.m4a' }),
      'phone_calls/short1': call({ id: 'short1', leadId: 'L5', status: 'short', transcript: null, startedAtMs: MID, createdAtMs: MID, storagePath: 'calls/jo/cube-acr/2025-06-01/short1.m4a' }),
    });
    await run(base(db, makeBucket(), { live: true }));
    const w = db.store.get('phone_calls/wait1') || {};
    ok('a "stored" call whose audio is removed becomes "listed" (no audio, so not waiting to transcribe)', w.storagePath === null && w.status === 'listed', { status: w.status, storagePath: w.storagePath });
    ok('...a call in any other status keeps it', (db.store.get('phone_calls/short1') || {}).status === 'short');
    ok('audioPatch leaves status alone for a call that is not "stored"', !('status' in (R.audioPatch(NOW, { status: 'noted' }) || {})));
  }

  console.log('\n6. Drive is never touched');
  {
    const src = read('functions/call-retention.js') + read('functions/call-retention-logic.js');
    ok('both files exist', !!read('functions/call-retention.js') && !!read('functions/call-retention-logic.js'));
    ok('neither file loads a Drive client or googleapis', !/googleapis|google-auth|drive_v3|\bdrive\s*\(|drive\.files|getDrive|integrations\/drive/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    ok('the only Storage call is bucket.file(path).delete on a checked path', (src.match(/bucket\.file\(/g) || []).length === 1 && /isCrmAudioPath\(p, call\)/.test(src));
  }

  console.log('\n7. Batches, cursor, cap, deadline, rescan, failures');
  {
    // 25 old calls filed in ONE ingest run: the same createdAtMs (ties broken by id).
    const s = { 'leads/LX': {} };
    for (let i = 0; i < 25; i++) {
      const id = 'c' + String(i).padStart(2, '0');
      s['phone_calls/' + id] = call({ id, leadId: 'LX', startedAtMs: OLD, createdAtMs: OLD, storagePath: 'calls/jo/cube-acr/2024-06-01/' + id + '.m4a', transcript: null, summary: null, promises: [], segIndex: null, callerFacts: null, actionItems: [] });
    }
    const db = makeDb(s); const bucket = makeBucket();
    let r; try { r = await run(base(db, bucket, { live: true, batchSize: 4, maxPerPhase: 10 })); } catch (e) { r = { err: e.message }; }
    ok('a phase stops at its cap (10 of 25) with pages of 4', r.phases && r.phases.audio.scanned === 10 && r.phases.audio.stoppedBy === 'cap' && bucket.deleted.length === 10, r.phases && r.phases.audio);
    let r2, r3;
    try { r2 = await run(base(db, bucket, { live: true, batchSize: 4, maxPerPhase: 10, nowMs: NOW + 86400e3 })); } catch (e) { r2 = { err: e.message }; }
    try { r3 = await run(base(db, bucket, { live: true, batchSize: 4, maxPerPhase: 10, nowMs: NOW + 2 * 86400e3 })); } catch (e) { r3 = { err: e.message }; }
    const paths = bucket.deleted.map((d) => d.p);
    ok('three runs resume from the cursor and finish all 25 (ties on the same ms included)', paths.length === 25 && new Set(paths).size === 25, paths.length);
    ok('the last run reaches the end', r3 && r3.phases && r3.phases.audio.stoppedBy === 'end');
    const auditCount = [...db.store.keys()].filter((p) => p.startsWith('call_retention_log/')).length;
    ok('no call processed twice (25 audio audit rows)', auditCount === 25, auditCount);

    // Deadline: a clock that moves 1 per read; the deadline stops mid-page and later phases.
    const db2 = makeDb(s); const b2 = makeBucket(); let t = 0;
    let rd; try { rd = await run(base(db2, b2, { live: true, batchSize: 4, maxPerPhase: 100, clock: () => t++, deadlineMs: 6 })); } catch (e) { rd = { err: e.message }; }
    ok('the deadline stops the run part-way', rd.phases && rd.phases.audio.stoppedBy === 'deadline' && rd.phases.audio.scanned > 0 && rd.phases.audio.scanned < 25, rd.phases && rd.phases.audio);
    ok('...and later phases do not start', rd.phases && rd.phases.transcript.scanned === 0 && rd.phases.transcript.stoppedBy === 'deadline' && rd.phases.brief.scanned === 0);
    const cur = (db2.store.get('system/callRetention') || {}).cursors || {};
    ok('...and the cursor marks the last record done', cur.audio && cur.audio.key === 'c' + String(rd.phases.audio.scanned - 1).padStart(2, '0'), cur.audio);

    // Rescan: a held call whose hold is lifted is picked up by the next 30-day pass.
    const db3 = makeDb(seed()); const b3 = makeBucket();
    await run(base(db3, b3, { live: true }));
    const lead2 = db3.store.get('leads/L2'); lead2.claimStatus = 'Paid Out'; db3.store.set('leads/L2', lead2);
    await run(base(db3, b3, { live: true, nowMs: NOW + 86400e3 }));
    ok('within 30 days a lifted hold waits (the cursor is past it)', (db3.store.get('phone_calls/held1') || {}).transcript === T_SECRET);
    let r4; try { r4 = await run(base(db3, b3, { live: true, nowMs: NOW + 31 * 86400e3 })); } catch (e) { r4 = { err: e.message }; }
    ok('after 30 days the pass restarts and picks it up', r4 && r4.rescan === true && (db3.store.get('phone_calls/held1') || {}).transcript === null && !db3.store.has('leads/L2/call_briefs/held1'));
    ok('shouldRescan: no state → yes; 29 days → no; 30 days → yes', R.shouldRescan && R.shouldRescan({}, NOW) === true && R.shouldRescan({ passStartedAtMs: NOW - 29 * 864e5 }, NOW) === false && R.shouldRescan({ passStartedAtMs: NOW - 30 * 864e5 }, NOW) === true);

    // One record's batch fails: counted, logged, the run carries on, nothing half-written for it.
    const db5 = makeDb(seed()); const b5 = makeBucket();
    let n = 0; db5.opts.failCommitFor = () => (++n === 1);
    let r5; try { r5 = await run(base(db5, b5, { live: true })); } catch (e) { r5 = { err: e.message }; }
    // A phase whose query fails (the collection-group index not built yet) stops alone.
    const db6 = makeDb(seed()); const b6 = makeBucket();
    const cg = db6.collectionGroup; db6.collectionGroup = (name) => { const q = cg(name); q.get = async () => { throw new Error('FAILED_PRECONDITION: requires an index'); }; return q; };
    let r6; try { r6 = await run(base(db6, b6, { live: true })); } catch (e) { r6 = { err: e.message }; }
    ok('a failed brief query stops only that phase; audio and transcript still run and the cursor is saved', r6 && r6.phases && r6.phases.brief.stoppedBy === 'error' && r6.phases.audio.done === 2 && r6.phases.transcript.done === 2 && db6.store.has('system/callRetention'), r6 && (r6.err || r6.phases));
    ok('a failed record is counted and the run carries on', r5 && r5.phases && r5.phases.audio.failed === 1 && r5.phases.audio.done === 1, r5 && r5.phases && r5.phases.audio);

    // Audio: the audit row goes in BEFORE the Storage delete, so a delete is never unlogged.
    const logsOf = (db, id) => [...db.store].filter(([p, v]) => p.startsWith('call_retention_log/') && v.kind === 'audio' && v.callId === id).map(([, v]) => v);
    {
      const db7 = makeDb(seed()); const b7 = makeBucket(); const seenAtDelete = [];
      const f7 = b7.file; b7.file = (p) => { const h = f7(p); const del = h.delete; h.delete = async (o) => { seenAtDelete.push(logsOf(db7, p.split('/').pop().replace('.m4a', '')).map((l) => l.state).join(',')); return del(o); }; return h; };
      await run(base(db7, b7, { live: true }));
      ok('each audio audit row is written (state pending) before its Storage delete', seenAtDelete.length === 2 && seenAtDelete.every((x) => x === 'pending'), seenAtDelete);
      ok('...and marked done in the same batch as the call patch', logsOf(db7, 'old1').length === 1 && logsOf(db7, 'old1')[0].state === 'done' && logsOf(db7, 'mid1')[0].state === 'done');
    }
    {
      // The patch batch fails after the delete: the row stays pending (the delete is logged),
      // the call goes on a retry list, and the next run (cursor already past it) finishes it.
      const db8 = makeDb(seed()); const b8 = makeBucket();
      db8.opts.failCommitFor = (ops) => ops.length === 2 && JSON.stringify(db8.store.get('phone_calls/old1')).includes('old1.m4a') && !db8.opts.done8 && (db8.opts.done8 = true);
      let r8; try { r8 = await run(base(db8, b8, { live: true })); } catch (e) { r8 = { err: e.message }; }
      ok('a failed patch after the delete leaves a pending audit row (the deletion is logged)', r8.phases && r8.phases.audio.failed === 1 && logsOf(db8, 'old1').length === 1 && logsOf(db8, 'old1')[0].state === 'pending', logsOf(db8, 'old1'));
      const st8 = db8.store.get('system/callRetention') || {};
      ok('...and the call is on the retry list in system/callRetention', st8.retry && Array.isArray(st8.retry.audio) && st8.retry.audio.includes('old1'), st8.retry);
      // A hold lands on the lead before the retry: the audio is already gone, so the retry still records that.
      const lead1 = db8.store.get('leads/L1'); lead1.legalHold = true; db8.store.set('leads/L1', lead1);
      let r9; try { r9 = await run(base(db8, b8, { live: true, nowMs: NOW + 86400e3 })); } catch (e) { r9 = { err: e.message }; }
      const o8 = db8.store.get('phone_calls/old1') || {};
      ok('the next run retries it first and finishes the patch (storagePath null), even under a new hold', o8.storagePath === null && o8.audioRemoved === 'retention' && r9.phases && r9.phases.audio.retried === 1, { o8: o8.storagePath, ph: r9.phases && r9.phases.audio });
      ok('...one audit row for that deletion, now done; the retry list is empty', logsOf(db8, 'old1').length === 1 && logsOf(db8, 'old1')[0].state === 'done' && Array.isArray(((db8.store.get('system/callRetention') || {}).retry || {}).audio) && !(db8.store.get('system/callRetention')).retry.audio.length);
    }
    {
      // The Storage delete itself throws: the row says failed, the path stays, the retry deletes it.
      const db10 = makeDb(seed()); const b10 = makeBucket(); let boom = true;
      const f10 = b10.file; b10.file = (p) => { const h = f10(p); const del = h.delete; h.delete = async (o) => { if (boom && p.endsWith('old1.m4a')) { boom = false; throw new Error('storage 503'); } return del(o); }; return h; };
      await run(base(db10, b10, { live: true }));
      ok('a failed Storage delete marks its audit row failed and keeps storagePath', logsOf(db10, 'old1')[0] && logsOf(db10, 'old1')[0].state === 'failed' && (db10.store.get('phone_calls/old1') || {}).storagePath === 'calls/jo/cube-acr/2024-06-01/old1.m4a');
      await run(base(db10, b10, { live: true, nowMs: NOW + 86400e3 }));
      ok('...and the retry deletes it and the row ends done', (db10.store.get('phone_calls/old1') || {}).storagePath === null && logsOf(db10, 'old1').length === 1 && logsOf(db10, 'old1')[0].state === 'done');
    }
    {
      // A transcript batch that fails is retried the next day, not left for the 30-day rescan.
      const db11 = makeDb(seed()); const b11 = makeBucket(); let first = true;
      db11.opts.failCommitFor = (ops) => { if (first && ops.length === 4) { first = false; return true; } return false; }; // old1: patch + row + brief delete + row
      await run(base(db11, b11, { live: true }));
      ok('a failed transcript batch leaves old1 whole and on the retry list', (db11.store.get('phone_calls/old1') || {}).transcript === T_SECRET && (((db11.store.get('system/callRetention') || {}).retry || {}).transcript || []).includes('old1'));
      await run(base(db11, b11, { live: true, nowMs: NOW + 86400e3 }));
      ok('...and the next run strips it', (db11.store.get('phone_calls/old1') || {}).transcript === null && !db11.store.has('leads/L1/call_briefs/old1'));
    }
  }

  console.log('\n8. Wiring');
  {
    const src = read('functions/call-retention.js');
    ok('live only when CALL_RETENTION_ENABLED is the literal "true"', /process\.env\.CALL_RETENTION_ENABLED === 'true'/.test(src));
    let gates = null; try { gates = require(path.join(FN, 'cron-gates.js')); } catch (_) {}
    ok('cron-gates.js registers the gate', !!(gates && gates.CRON_GATES.some((g) => g.name === 'CALL_RETENTION_ENABLED' && g.polarity === 'enabled' && g.file === 'call-retention.js')));
    ok('flags-registry.js registers it, dark', /CALL_RETENTION_ENABLED:\s*\{[^}]*dark: true/.test(read('functions/flags-registry.js')));
    ok('flags-registry.js files it under "Calls & texts" (a call sweep, not an alert)', /CALL_RETENTION_ENABLED:\s*\{\s*group: 'Calls & texts'/.test(read('functions/flags-registry.js')));
    ok('scheduled daily 03:20 America/New_York (off-peak)', /schedule:\s*'20 3 \* \* \*'/.test(src) && /timeZone:\s*'America\/New_York'/.test(src) && /maxInstances:\s*1/.test(src));
    ok('heartbeat-wrapped, on the daily-retention check', /require\('\.\/integrations\/heartbeat'\)/.test(src) && /callRetention:\s*\{\s*slug:\s*'daily-retention'/.test(read('functions/integrations/heartbeat-plan.js')));
    ok('index.js exports callRetention', /exports\.callRetention = require\('\.\/call-retention'\)\.callRetention/.test(read('functions/index.js')));
    ok('function-map.json maps it', (() => { try { return JSON.parse(read('functions/function-map.json')).callRetention === './call-retention'; } catch (_) { return false; } })());
    ok('FUNCTIONS_INDEX.md has its row', /\| `callRetention` \| daily 03:20 ET \|/.test(read('functions/FUNCTIONS_INDEX.md')));
    const idx = JSON.parse(read('firestore.indexes.json') || '{}');
    ok('a COLLECTION_GROUP index on call_briefs.generatedAtMs serves the brief sweep', (idx.fieldOverrides || []).some((f) => f.collectionGroup === 'call_briefs' && f.fieldPath === 'generatedAtMs'
      && f.indexes.some((i) => i.queryScope === 'COLLECTION_GROUP' && i.order === 'ASCENDING') && f.indexes.some((i) => i.queryScope === 'COLLECTION' && i.order === 'ASCENDING') && f.indexes.some((i) => i.queryScope === 'COLLECTION' && i.order === 'DESCENDING')));
    const rules = read('firestore.rules');
    ok('call_retention_log and system/ are server-only (no rule opens them; the catch-all denies)', !/call_retention_log/.test(rules) && /match \/system\/\{docId\} \{\s*allow read, write: if false;/.test(rules) && /match \/\{document=\*\*\} \{\s*allow read, write: if false;/.test(rules));
    ok('the runbook is in the session note and linked from INDEX', fs.existsSync(path.join(ROOT, 'documentation/projects/SESSION-2026-11-09-call-to-close-p2-retention.md'))
      && /SESSION-2026-11-09-call-to-close-p2-retention\.md/.test(read('documentation/INDEX.md'))
      && /CALL_RETENTION_ENABLED/.test(read('documentation/projects/SESSION-2026-11-09-call-to-close-p2-retention.md')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
