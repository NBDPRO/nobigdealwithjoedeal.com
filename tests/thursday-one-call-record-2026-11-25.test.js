/**
 * tests/thursday-one-call-record-2026-11-25.test.js — roadmap step 17 part C
 * (audit 2026-11-22 §3.3): Thursday calls projected into phone_calls, linked
 * to the Cube ACR row of the same call, and covered by call retention.
 *
 *   1. a finished Thursday call is projected ONCE (phone_calls/thursday_<id>),
 *      a reprocess rewrites the same doc, nothing unfinished or held is
 *      projected, and the projection never carries the recording
 *   2. the real readers see it: Call Brief's gate (call-brief.js loadGated),
 *      the "you said you'd" sweep (call-center.js gatherSweep, with Thursday's
 *      own task id), the task mirror (mirrorCallTask) and the Calls screen's
 *      row actions (callAction, safe actions only)
 *   3. no duplicate card when the same call also arrives through Cube ACR, in
 *      either order; the matching window's edges
 *   4. callRetention covers thursday_calls: DRY by default (lists what it would
 *      delete, deletes and writes nothing of Thursday's), live only with both
 *      switches, holds respected
 *   5. the review fixes: retention stays applied (projection + reprocess),
 *      which side of a linked call is kept, capture-off labels, no sibling
 *      filing of a copy, Handled = reviewed both ways, the Calls screen's
 *      Thursday buttons, each reader counting a call once
 *
 * Every Firestore and Storage call is an in-memory fake; nothing reaches the
 * network or real data.
 * Run: node tests/thursday-one-call-record-2026-11-25.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const FN = path.join(__dirname, '..', 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
async function throwsCode(fn) { try { await fn(); return null; } catch (e) { return e && (e.code || e.message); } }

// ── fake Firestore ──────────────────────────────────────────────────────
const DOC_ID = '__name__';
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
function deepMerge(base, patch) {
  const out = Object.assign({}, base || {});
  for (const [k, v] of Object.entries(patch || {})) out[k] = plain(v) && plain(out[k]) ? deepMerge(out[k], v) : clone(v);
  return out;
}
const cmpVal = (x) => (x instanceof Date ? x.getTime() : x);
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const writes = [];
  let auto = 0;
  function ref(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => ({ id: p.split('/').pop(), exists: store.has(p), data: () => clone(store.get(p)), ref: ref(p) }),
      set: async (data, o) => { writes.push({ op: 'set', path: p, data: clone(data) }); store.set(p, o && o.merge ? deepMerge(store.get(p), data) : clone(data)); },
      update: async (data) => { writes.push({ op: 'update', path: p, data: clone(data) }); store.set(p, deepMerge(store.get(p), data)); },
      delete: async () => { writes.push({ op: 'delete', path: p }); store.delete(p); },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function query(match) {
    const q = { filters: [], orders: [], after: null, lim: Infinity };
    const api = {
      where(f, op, v) { q.filters.push([f, op, v]); return api; },
      orderBy(f, dir) { q.orders.push([f, dir === 'desc' ? -1 : 1]); return api; },
      startAfter(...vals) { q.after = vals; return api; },
      limit(n) { q.lim = n; return api; },
      select() { return api; },
      count() { return { get: async () => { const lim = q.lim, after = q.after; q.lim = Infinity; q.after = null; const r = await api.get(); q.lim = lim; q.after = after; return { data: () => ({ count: r.size }) }; } }; },
      async get() {
        const rows = [];
        for (const [p, data] of store) {
          if (!match(p)) continue;
          const pass = q.filters.every(([f, op, v]) => {
            const x = cmpVal(data[f]), w = cmpVal(v);
            if (op === '==') return (x === undefined ? null : x) === w;
            if (x === undefined || x === null) return false;
            if (op === '<') return x < w;
            if (op === '>=') return x >= w;
            return false;
          });
          if (pass) rows.push({ p, data });
        }
        const key = (r) => q.orders.map(([f]) => (f === DOC_ID ? r.p.split('/').pop() : cmpVal(r.data[f])));
        const cmp = (a, b) => { for (let i = 0; i < q.orders.length; i++) { const d = q.orders[i][1]; if (a[i] < b[i]) return -d; if (a[i] > b[i]) return d; } return 0; };
        rows.sort((a, b) => cmp(key(a), key(b)));
        const after = q.after ? rows.filter((r) => cmp(key(r), q.after.map(cmpVal)) > 0) : rows;
        const docs = after.slice(0, q.lim).map((r) => ({ id: r.p.split('/').pop(), ref: ref(r.p), data: () => clone(r.data), exists: true }));
        return { docs, empty: !docs.length, size: docs.length, forEach: (f) => docs.forEach(f) };
      },
    };
    return api;
  }
  function coll(name) {
    const depth = name.split('/').length + 1;
    return Object.assign(query((p) => p.split('/').length === depth && p.startsWith(name + '/')), {
      doc: (id) => ref(name + '/' + (id || ('auto' + String(++auto).padStart(5, '0')))),
      add: async (data) => { const r = ref(name + '/auto' + String(++auto).padStart(5, '0')); await r.set(data); return r; },
    });
  }
  return {
    store, writes,
    doc: (p) => ref(p),
    collection: coll,
    collectionGroup: (n) => query((p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === n; }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    batch() {
      const ops = [];
      return { set(r, d, o) { ops.push(() => r.set(d, o)); }, delete(r) { ops.push(() => r.delete()); }, async commit() { for (const f of ops) await f(); } };
    },
  };
}
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const TP = require(path.join(FN, 'thursday-projection-logic.js'));
const PJ = require(path.join(FN, 'thursday-projection.js'));

const OWNER = 'owner-uid-1';
const BLAND = 'a1b2c3d4-0000-4000-8000-00000000abcd';
const TDOC = 'bland_calls__' + BLAND;
const PID = 'thursday_' + BLAND;
const START = Date.parse('2026-11-20T15:00:00Z');
const NOW = Date.parse('2026-11-20T18:00:00Z');
const thursdayDoc = (over) => Object.assign({
  companyId: OWNER, userId: OWNER, callId: BLAND, from: '+15135550142', fromDigits: '5135550142',
  startedAt: new Date(START), createdAt: new Date(START + 200000), durationSec: 120,
  call: { callId: BLAND, from: '+15135550142', summary: 'Bland summary', transcript: 'user: my roof is leaking over the kitchen, please call me back\nassistant: I will pass that on to Joe', recordingUrl: 'https://api.bland.ai/rec/secret-url' },
  recordingPath: 'calls/' + OWNER + '/' + BLAND + '.mp3',
  status: 'processed', extraction: { caller_type: 'new_lead', caller_name: 'Pat Example' }, callerName: 'Pat Example',
  issue: 'Roof leak over the kitchen', callNotes: 'Thursday call: Roof leak over the kitchen', urgent: false,
  route: { action: 'attach', label: 'Known caller', leadId: 'L1' }, leadId: 'L1', taskId: 'thursday-' + BLAND,
}, over || {});

(async () => {
  console.log('\n1. One projection per Thursday call');
  {
    const db = makeDb();
    const r1 = await PJ.projectThursdayCall({ db, docId: TDOC, data: thursdayDoc() });
    const p1 = db.store.get('phone_calls/' + PID) || {};
    ok('a processed call is written to phone_calls/thursday_<blandId>', r1.state === 'written' && db.store.has('phone_calls/' + PID), r1);
    ok('...tenant-scoped like every phone_calls doc (userId + companyId)', p1.userId === OWNER && p1.companyId === OWNER);
    ok('...with the fields the readers use', p1.source === 'thursday' && p1.status === 'noted' && p1.startedAtMs === START && p1.durationSec === 120 &&
      p1.phoneDigits === '5135550142' && p1.leadId === 'L1' && p1.contactName === 'Pat Example' && p1.summary === 'Roof leak over the kitchen' &&
      p1.callType === 'lead' && /roof is leaking/.test(p1.transcript) && p1.thursdayCallId === BLAND && p1.thursdayDocId === TDOC, p1);
    const flat = JSON.stringify(p1);
    ok('...and NO recording: storagePath null, no Bland URL, no Storage path', p1.storagePath === null && !/secret-url|recordingUrl|recordingPath|\.mp3/.test(flat), flat);
    const r2 = await PJ.projectThursdayCall({ db, docId: TDOC, data: thursdayDoc() });
    ok('the same doc again changes nothing (no write)', r2.state === 'unchanged' && db.writes.filter((w) => w.path === 'phone_calls/' + PID).length === 1, r2);
    // A person handled it on the Calls screen, then the call is reprocessed.
    await db.doc('phone_calls/' + PID).set({ handledAtMs: NOW, handledBy: OWNER }, { merge: true });
    const r3 = await PJ.projectThursdayCall({ db, docId: TDOC, data: thursdayDoc({ issue: 'Roof leak and a gutter', urgent: true }) });
    const p3 = db.store.get('phone_calls/' + PID);
    const calls = [...db.store.keys()].filter((k) => k.startsWith('phone_calls/'));
    ok('a reprocess updates the SAME doc (one phone_calls doc in all)', r3.state === 'written' && calls.length === 1 && p3.summary === 'Roof leak and a gutter' && p3.urgent === true, { calls, p3 });
    ok('...and keeps what other writers put there (handled)', p3.handledAtMs === NOW);
    for (const st of ['pending', 'processing', 'reprocess', 'held', 'paused', 'skipped']) {
      const dbh = makeDb();
      const rh = await PJ.projectThursdayCall({ db: dbh, docId: TDOC, data: thursdayDoc({ status: st }) });
      ok('a "' + st + '" call is not projected', rh.state === 'not-projectable' && dbh.writes.length === 0, rh);
    }
    const dbf = makeDb();
    await PJ.projectThursdayCall({ db: dbf, docId: TDOC, data: thursdayDoc({ status: 'failed', extraction: null, issue: '', callNotes: null, leadId: null, route: { action: 'inbox' } }) });
    const pf = dbf.store.get('phone_calls/' + PID) || {};
    ok('a failed extraction is still one call on file (Bland\'s summary, no customer)', pf.status === 'noted' && pf.summary === 'Bland summary' && pf.leadId === null, pf);
    ok('an unusable call id projects nothing', TP.buildProjection(thursdayDoc({ callId: 'x/y', call: {} }), TDOC) === null);
    ok('a projection is marked done for the Cube facts re-read (no AI spent on it)', p1.factsV === require(path.join(FN, 'call-center-logic.js')).FACTS_VERSION);
  }

  console.log('\n2. The real readers see a Thursday call');
  {
    // Call Brief's gate: filed from the Thursday inbox by a person.
    const CB = require(path.join(FN, 'call-brief.js'))._test;
    const auth = { uid: OWNER, token: { role: 'company_admin', companyId: OWNER } };
    const filed = thursdayDoc({ route: { action: 'attach', label: 'Attached from inbox', leadId: 'L1' }, reviewedBy: { uid: OWNER } });
    const db = makeDb({ 'leads/L1': { companyId: OWNER, userId: OWNER, firstName: 'Pat' } });
    await PJ.projectThursdayCall({ db, docId: TDOC, data: filed });
    const g = await CB.loadGated(db, auth, { callId: PID });
    ok('Call Brief loads a Thursday call filed from the inbox, with its transcript', g && g.callId === PID && g.leadId === 'L1' && /roof is leaking/.test(g.call.transcript), g && { callId: g.callId, leadId: g.leadId });
    const db2 = makeDb({ 'leads/L1': { companyId: OWNER, userId: OWNER } });
    await PJ.projectThursdayCall({ db: db2, docId: TDOC, data: thursdayDoc() });
    const why = await throwsCode(() => CB.loadGated(db2, auth, { callId: PID }));
    ok('...and, like a Cube call, asks a person to confirm a number-matched customer first', why === 'failed-precondition', why);
    const bad = await throwsCode(() => CB.loadGated(db2, auth, { callId: 'thursday_../x' }));
    ok('...a malformed id is still refused', bad === 'invalid-argument', bad);

    // The "you said you'd" sweep: a Thursday call on a customer whose
    // follow-up task (thursday-<blandId>) is due and open.
    const CC = require(path.join(FN, 'call-center.js'))._test;
    const today = new Date(NOW).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const OWN = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
    const dbs = makeDb({ ['leads/L1/tasks/thursday-' + BLAND]: { done: false, dueDate: today } });
    await PJ.projectThursdayCall({ db: dbs, docId: TDOC, data: thursdayDoc({ userId: OWN, companyId: OWN }) });
    const sw = await CC.gatherSweep({ db: dbs, nowMs: NOW });
    const it = sw.items.find((i) => i.callId === PID);
    ok('the sweep lists the Thursday call by its own task (due today)', !!it && it.kind === 'due' && it.leadId === 'L1', sw.items);
    await dbs.doc('leads/L1/tasks/thursday-' + BLAND).set({ done: true }, { merge: true });
    const sw2 = await CC.gatherSweep({ db: dbs, nowMs: NOW });
    ok('...and drops it once that task is ticked', !sw2.items.some((i) => i.callId === PID), sw2.items);

    // The task mirror: ticking Thursday's task anywhere marks the projection.
    const dbm = makeDb({ 'leads/L1': { companyId: OWNER, userId: OWNER } });
    await PJ.projectThursdayCall({ db: dbm, docId: TDOC, data: thursdayDoc() });
    await CC.mirrorCallTask({ db: dbm, leadId: 'L1', taskId: 'thursday-' + BLAND, after: { done: true } });
    ok('a ticked thursday-<id> task sets taskDone on the projection', (dbm.store.get('phone_calls/' + PID) || {}).taskDone === true);
    await CC.mirrorCallTask({ db: dbm, leadId: 'L-other', taskId: 'thursday-' + BLAND, after: { done: false } });
    ok('...never from a task on another customer', (dbm.store.get('phone_calls/' + PID) || {}).taskDone === true);

    // The Calls screen's row actions.
    const r = await CC.callAction({ db: dbm, auth, data: { id: PID, action: 'handled' }, nowMs: NOW });
    ok('"Handled" works on a Thursday row', r && r.ok === true && (dbm.store.get('phone_calls/' + PID) || {}).handledAtMs === NOW);
    const att = await throwsCode(() => CC.callAction({ db: dbm, auth, data: { id: PID, action: 'attach', leadId: 'L1' }, nowMs: NOW }));
    ok('...but filing / moving it is refused (the Thursday inbox does that)', att === 'failed-precondition', att);
    const viewer = await throwsCode(() => CC.callAction({ db: dbm, auth: { uid: 'v1', token: { role: 'viewer', companyId: OWNER } }, data: { id: PID, action: 'handled' }, nowMs: NOW }));
    ok('...and a viewer is refused as on any call', viewer === 'permission-denied', viewer);
  }

  console.log('\n3. One card when Cube ACR has the same call');
  {
    const cube = (id, over) => Object.assign({ userId: OWNER, companyId: OWNER, source: 'cube-acr', phoneDigits: '5135550142', direction: 'inbound', startedAtMs: START - 30000, durationSec: 12, status: 'short', storagePath: 'calls/x.m4a', createdAtMs: START }, over || {});
    // Thursday first, then the Cube missed-call row lands.
    const db = makeDb();
    await PJ.projectThursdayCall({ db, docId: TDOC, data: thursdayDoc() });
    db.store.set('phone_calls/cube_MISS1', cube('cube_MISS1'));
    const l1 = await PJ.linkCubeRow({ db, cube: Object.assign({ id: 'cube_MISS1' }, db.store.get('phone_calls/cube_MISS1')), log: silent });
    const pA = db.store.get('phone_calls/' + PID), cA = db.store.get('phone_calls/cube_MISS1');
    ok('the Cube row links to the projection (each names the other)', l1 && pA.cubeCallId === 'cube_MISS1' && cA.thursdayCallId === BLAND && cA.thursdayProjectionId === PID, { pA, cA });
    ok('a Cube missed-call stub folds into Thursday\'s call (one card)', cA.mergedInto === PID && !pA.mergedInto);
    await PJ.projectThursdayCall({ db, docId: TDOC, data: thursdayDoc({ issue: 'reprocessed' }) });
    ok('a later reprocess keeps the link', db.store.get('phone_calls/' + PID).cubeCallId === 'cube_MISS1' && db.store.get('phone_calls/cube_MISS1').mergedInto === PID);
    ok('both docs stay (nothing deleted)', db.writes.every((w) => w.op !== 'delete'));

    // Cube first (Jo picked up the transfer), then Thursday is processed.
    const db2 = makeDb({ 'phone_calls/cube_TALK1': cube('cube_TALK1', { startedAtMs: START + 60000, durationSec: 300, status: 'noted' }) });
    const l2 = await PJ.projectThursdayCall({ db: db2, docId: TDOC, data: thursdayDoc() });
    const pB = db2.store.get('phone_calls/' + PID), cB = db2.store.get('phone_calls/cube_TALK1');
    ok('either order links the same two docs', l2.linked && pB.cubeCallId === 'cube_TALK1' && cB.thursdayProjectionId === PID, l2);
    ok('a Cube recording Jo talked on keeps the card; Thursday\'s half folds into it', pB.mergedInto === 'cube_TALK1' && !cB.mergedInto);
    const again = await PJ.linkCubeRow({ db: db2, cube: Object.assign({ id: 'cube_TALK1' }, cB) });
    ok('linking twice is a no-op', again === null);

    // The window's edges (Thursday 15:00:00 for 120 s).
    const P = Object.assign({ id: PID }, TP.buildProjection(thursdayDoc(), TDOC));
    const at = (ms, over) => TP.cubeMatches(cube('c', Object.assign({ startedAtMs: ms }, over || {})), P, PID);
    ok('a Cube row 90 s before Thursday picked up matches (the ring before forwarding)', at(START - TP.LINK_BEFORE_MS) === true);
    ok('...91 s before does not', at(START - TP.LINK_BEFORE_MS - 1000) === false);
    ok('a row during the call matches (a transfer to Jo)', at(START + 100000) === true);
    ok('a row 60 s after Thursday hung up matches (clock skew)', at(START + 120000 + TP.LINK_AFTER_MS) === true);
    ok('...61 s after does not (a redial is a new call)', at(START + 120000 + TP.LINK_AFTER_MS + 1000) === false);
    ok('Jo calling back (outbound) is a new call', at(START + 30000, { direction: 'outbound' }) === false);
    ok('another number never matches', at(START, { phoneDigits: '5135550199' }) === false);
    ok('another owner never matches', at(START, { userId: 'someone-else' }) === false);
    ok('a Cube row already linked to another Thursday call never matches', at(START, { thursdayProjectionId: 'thursday_other-call-0001' }) === false);
    const pick = TP.pickCube([cube('far', { id: 'far', startedAtMs: START - 80000 }), cube('near', { id: 'near', startedAtMs: START - 5000 })], P, PID);
    ok('two candidates: the nearest wins', pick && pick.id === 'near', pick && pick.id);
    const dbN = makeDb({ 'phone_calls/cube_OTHER': cube('cube_OTHER', { phoneDigits: '5135550199' }) });
    const lN = await PJ.projectThursdayCall({ db: dbN, docId: TDOC, data: thursdayDoc() });
    ok('no match: no link written, no card hidden', !lN.linked && !dbN.store.get('phone_calls/cube_OTHER').thursdayCallId && !dbN.store.get('phone_calls/' + PID).mergedInto);
  }

  console.log('\n4. callRetention covers Thursday recordings and transcripts');
  {
    const RT = require(path.join(FN, 'call-retention.js'))._test;
    const RNOW = Date.parse('2026-11-25T08:20:00Z');
    const old = Date.parse('2024-06-01T15:00:00Z'); // > 24 months
    const mid = Date.parse('2025-06-01T15:00:00Z'); // 12-24 months
    const tdoc = (id, ms, over) => [('thursday_calls/' + id), Object.assign({
      userId: OWNER, companyId: OWNER, callId: id, startedAt: new Date(ms), createdAt: new Date(ms + 1000),
      recordingPath: 'calls/' + OWNER + '/' + id + '.mp3', call: { callId: id, transcript: 'what was said', transcripts: [{ text: 'x' }], summary: 'sum' },
      issue: 'issue', callNotes: 'notes', extraction: { caller_name: 'Pat' }, leadId: null, status: 'processed',
    }, over || {})];
    const seed = () => Object.fromEntries([
      tdoc('old1', old), tdoc('mid1', mid), tdoc('new1', RNOW - 86400000),
      tdoc('held1', old, { legalHold: true }), tdoc('bad1', old, { recordingPath: 'calls/someone-else/bad1.mp3' }),
    ]);
    const bucket = () => { const deleted = []; return { deleted, file: (p) => ({ delete: async () => { deleted.push(p); } }) }; };
    const base = (db, b, extra) => Object.assign({ db, bucket: b, nowMs: RNOW, log: silent, docIdField: DOC_ID, serverTs: () => 'TS', clock: () => 0, deadlineMs: 1e15 }, extra);

    // A LIVE run (CALL_RETENTION_ENABLED on) with the Thursday switch off: dry for Thursday.
    const db = makeDb(seed()); const b = bucket();
    const r = await RT.runRetention(base(db, b, { live: true }));
    const ta = r.phases.thursdayAudio, tt = r.phases.thursdayTranscript;
    ok('dry by default: the Thursday phases list what they would delete', ta && tt && (ta.wouldDelete || []).map((x) => x.docPath).sort().join() === 'thursday_calls/mid1,thursday_calls/old1' &&
      (tt.wouldDelete || []).map((x) => x.docPath).sort().join() === 'thursday_calls/bad1,thursday_calls/old1', { ta, tt });
    ok('...with paths and field names only, never what was said', !/what was said|"Pat"|"sum"/.test(JSON.stringify([ta.wouldDelete, tt.wouldDelete])) && ta.wouldDelete.some((x) => x.storagePath === 'calls/' + OWNER + '/old1.mp3'));
    ok('...and delete nothing: no Storage call, no Thursday doc written, no audit row for them', b.deleted.length === 0 &&
      !db.writes.some((w) => w.path.startsWith('thursday_calls/')) && ![...db.store.values()].some((v) => v && /^thursday_/.test(String(v.kind || ''))), db.writes.map((w) => w.path));
    ok('...nor move their cursor', (db.store.get('system/callRetention') || {}).cursors && !db.store.get('system/callRetention').cursors.thursdayAudio);
    // bad1: its recording path is outside the owner (refused); its transcript is old enough to strip.
    ok('holds are respected (legalHold) and a path outside the owner is refused', ta.held.call_legal_hold === 1 && ta.badPath === 1 && tt.held.call_legal_hold === 1, { held: ta.held, bad: ta.badPath });
    const db0 = makeDb(seed()); const b0 = bucket();
    const r0 = await RT.runRetention(base(db0, b0, { live: false, thursdayLive: true }));
    ok('the Thursday switch alone (retention itself dry) still deletes nothing', b0.deleted.length === 0 && db0.writes.length === 0 && r0.phases.thursdayAudio.eligible === 2);

    // Both switches on.
    const db2 = makeDb(seed()); const b2 = bucket();
    const r2 = await RT.runRetention(base(db2, b2, { live: true, thursdayLive: true }));
    const o = db2.store.get('thursday_calls/old1'), m = db2.store.get('thursday_calls/mid1'), n = db2.store.get('thursday_calls/new1'), h = db2.store.get('thursday_calls/held1');
    ok('live: recordings past 12 months are deleted and unlinked', b2.deleted.sort().join() === ['calls/' + OWNER + '/mid1.mp3', 'calls/' + OWNER + '/old1.mp3'].join() && o.recordingPath === null && m.recordingPath === null && o.audioRemoved === 'retention', b2.deleted);
    ok('live: past 24 months the transcript and notes are stripped, the doc kept', o.call.transcript === null && o.call.transcripts.length === 0 && o.call.summary === null && o.issue === null && o.callNotes === null && o.extraction === null && o.callId === 'old1' && o.retention.transcriptStrippedAtMs === RNOW, o);
    ok('...a 12-24 month call keeps its transcript, a new call keeps everything', m.call.transcript === 'what was said' && n.recordingPath && n.call.transcript === 'what was said');
    ok('...a held call keeps everything', h.recordingPath && h.call.transcript === 'what was said');
    const logs = [...db2.store.entries()].filter(([k]) => k.startsWith('call_retention_log/')).map(([, v]) => v);
    ok('...every deletion has an audit row (ids only)', logs.filter((l) => l.kind === 'thursday_audio' && l.state === 'done').length === 2 && logs.filter((l) => l.kind === 'thursday_transcript').length === 2 && !/what was said/.test(JSON.stringify(logs)), logs.map((l) => l.kind));
    ok('...and the run reports it', r2.phases.thursdayAudio.done === 2 && r2.phases.thursdayTranscript.done === 2);
  }

  console.log('\n5. Review fixes (2026-11-25)');
  {
    const R = require(path.join(FN, 'call-retention-logic.js'));
    const CC = require(path.join(FN, 'call-center.js'))._test;
    const OWN = CC.OWNER;
    const auth = { uid: OWNER, token: { role: 'company_admin', companyId: OWNER } };

    // F1: the phone_calls transcript phase strips the projection for good.
    {
      const db = makeDb();
      await PJ.projectThursdayCall({ db, docId: TDOC, data: thursdayDoc() });
      const tp = R.transcriptPatch(db.store.get('phone_calls/' + PID), NOW);
      ok('F1: the phone_calls transcript phase strips a projection\'s callNotes with its transcript', !!tp && tp.fields.includes('callNotes') && tp.patch.callNotes === null && tp.fields.includes('transcript'), tp && tp.fields);
      ok('...and a Cube row\'s field list is unchanged', R.transcriptFieldsPresent({ transcript: 'x', callNotes: 'y' }).join() === 'transcript');
      await db.doc('phone_calls/' + PID).set(tp.patch, { merge: true });
      // Thursday's own text is still there (its phases are dark); an inbox action rewrites the doc.
      await PJ.projectThursdayCall({ db, docId: TDOC, data: thursdayDoc({ reviewed: true, reviewedBy: { uid: OWNER, at: new Date(NOW) } }) });
      const a = db.store.get('phone_calls/' + PID);
      ok('F1: a later thursday_calls write never brings a stripped transcript, summary or notes back', a.transcript === '' && a.summary === '' && a.callNotes === null && a.transcriptSaved === false && a.retention && a.retention.transcriptStrippedAtMs === NOW, a);
      const db2 = makeDb();
      await PJ.projectThursdayCall({ db: db2, docId: TDOC, data: thursdayDoc() });
      await PJ.projectThursdayCall({ db: db2, docId: TDOC, data: thursdayDoc({ issue: 'Roof leak, updated' }) });
      ok('...control: an unstripped projection still takes the update', db2.store.get('phone_calls/' + PID).summary === 'Roof leak, updated');
    }

    // F2: a reprocess never undoes Thursday retention.
    {
      const fresh = thursdayDoc();
      const audioGone = deepMerge(fresh, R.thursdayAudioPatch(NOW));
      const textGone = deepMerge(audioGone, R.thursdayTranscriptPatch(audioGone, NOW).patch);
      const k = (d) => JSON.stringify(R.thursdayKeep(d));
      ok('F2: a call retention never touched may hydrate, save its recording and be reprocessed', k(fresh) === JSON.stringify({ hydrate: true, saveRecording: true, reprocess: true }), k(fresh));
      ok('F2: once its recording is deleted it is never copied back into Storage', k(audioGone) === JSON.stringify({ hydrate: true, saveRecording: false, reprocess: true }), k(audioGone));
      ok('F2: once its transcript is stripped nothing is re-hydrated, saved or reprocessed', k(textGone) === JSON.stringify({ hydrate: false, saveRecording: false, reprocess: false }), k(textGone));
      ok('F2: the audio patch drops Bland\'s recording link too', audioGone.call.recordingUrl === null && audioGone.recordingPath === null);
      const THU_SRC = fs.readFileSync(path.join(FN, 'integrations', 'thursday.js'), 'utf8');
      ok('F2: processCall gates the Bland hydrate on thursdayKeep', /if \(keep\.hydrate && key/.test(THU_SRC));
      ok('F2: processCall gates the Storage copy on thursdayKeep', /if \(keep\.saveRecording && !data\.recordingPath/.test(THU_SRC));
      ok('F2: thursdayCallAction refuses a reprocess past the transcript limit', /thursdayKeep\(data\)\.reprocess\)/.test(THU_SRC));
    }

    // F3 + F10: which side is kept, and the kept side carries mergedFrom.
    {
      const P = Object.assign({ id: PID }, TP.buildProjection(thursdayDoc(), TDOC));
      const c = (over) => Object.assign({ id: 'cube_RING1', userId: OWNER, phoneDigits: '5135550142', direction: 'inbound', startedAtMs: START - 20000 }, over);
      const ring = TP.linkPatches(c({ status: 'stored', durationSec: null }), P);
      ok('F3: a stored Cube file with no duration yet (no sidecar) hides behind Thursday\'s call', ring.cubePatch.mergedInto === PID && ring.projectionPatch.mergedInto === null, ring);
      const shortKnown = TP.linkPatches(c({ status: 'stored', durationSec: 20 }), P);
      ok('F3: a known 20 s file (Thursday talked 120 s) hides behind Thursday too', shortKnown.cubePatch.mergedInto === PID);
      ok('F3: a personal row hides behind Thursday', TP.linkPatches(c({ status: 'personal', durationSec: 400 }), P).cubePatch.mergedInto === PID);
      const talk = TP.linkPatches(c({ status: 'noted', durationSec: null, transcript: 'Joe: hi, this is Joe' }), P);
      ok('F3: a Cube row with a transcript keeps the card', talk.projectionPatch.mergedInto === 'cube_RING1' && talk.cubePatch.mergedInto === null);
      ok('F3: a known longer Cube recording keeps the card', TP.linkPatches(c({ status: 'stored', durationSec: 300 }), P).projectionPatch.mergedInto === 'cube_RING1');
      ok('F10: the kept side names the hidden one (mergedFrom), as a merge does', ring.projectionPatch.mergedFrom === 'cube_RING1' && talk.cubePatch.mergedFrom === PID);

      // Call Brief on the kept Cube card reads what the caller told Thursday.
      const CB = require(path.join(FN, 'call-brief.js'))._test;
      const talkRow = c({ status: 'noted', durationSec: 300, transcript: 'Joe: I will come Tuesday', leadId: 'L1', companyId: OWNER });
      delete talkRow.id;
      const dbB = makeDb({ 'phone_calls/cube_TALK2': talkRow });
      await PJ.projectThursdayCall({ db: dbB, docId: TDOC, data: thursdayDoc() });
      const kept = Object.assign({}, dbB.store.get('phone_calls/cube_TALK2'), { id: 'cube_TALK2' });
      ok('...(linked: the Cube row is kept)', kept.mergedFrom === PID && dbB.store.get('phone_calls/' + PID).mergedInto === 'cube_TALK2', kept);
      const bi = await CB.briefInput(dbB, { call: kept, leadId: 'L1' });
      ok('F10: the kept card\'s brief reads both halves of the call', /I will come Tuesday/.test(bi.transcript) && /roof is leaking/.test(bi.transcript) && bi.mergedFrom === PID, bi);

      // Undo on the Cube card: its partner is a thursday_ id.
      const missRow = c({ status: 'short', durationSec: 8 });
      delete missRow.id;
      const dbU = makeDb({ 'phone_calls/cube_MISS9': missRow });
      await PJ.projectThursdayCall({ db: dbU, docId: TDOC, data: thursdayDoc() });
      dbU.runTransaction = async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), delete: (r) => r.delete() });
      const un = await CC.callAction({ db: dbU, auth, data: { id: 'cube_MISS9', action: 'unmerge' }, nowMs: NOW });
      ok('F10: "Undo merge" on the Cube card splits the Thursday link on both docs', un && un.unmerged === true && !un.lone && !dbU.store.get('phone_calls/' + PID).mergedFrom && !dbU.store.get('phone_calls/cube_MISS9').mergedInto, un);
      await PJ.projectThursdayCall({ db: dbU, docId: TDOC, data: thursdayDoc({ issue: 'again' }) });
      ok('...and a later projection does not link them again', !dbU.store.get('phone_calls/cube_MISS9').mergedInto);
    }

    // F4: a number whose capture is off.
    {
      const lbl = { ['companies/' + OWNER + '/contact_labels/5135550142']: { kind: 'personal', capture: 'off', policy: 'hide', updatedAtMs: START - 86400000 } };
      const dbL = makeDb(lbl);
      await PJ.projectThursdayCall({ db: dbL, docId: TDOC, data: thursdayDoc({ leadId: null, route: { action: 'inbox', label: 'Needs review' } }) });
      const pl = dbL.store.get('phone_calls/' + PID);
      ok('F4: capture off: projected like the Cube ingest\'s metadata row (personal, no transcript, summary or notes)', pl.status === 'personal' && pl.labelCapture === 'off' && pl.transcript === '' && pl.summary === '' && pl.callNotes === null && pl.transcriptSaved === false, pl);
      const dbC = makeDb(Object.assign({ 'leads/L1': { companyId: OWNER, userId: OWNER, createdAtMs: START - 3600000 } }, lbl));
      await PJ.projectThursdayCall({ db: dbC, docId: TDOC, data: thursdayDoc() });
      ok('...but a number that became a customer after the label is captured again (C-4)', dbC.store.get('phone_calls/' + PID).status === 'noted' && /roof/.test(dbC.store.get('phone_calls/' + PID).transcript));
    }

    // F5: filing a Cube call never sweeps the Thursday copy onto the lead.
    {
      const TEN = 'co-2', U2 = 'u-2';
      const dbR = makeDb({
        'leads/L9': { companyId: TEN, userId: U2, phoneDigits: '5135550142' },
        'phone_calls/cube_SIB01': { userId: U2, companyId: TEN, phoneDigits: '5135550142', status: 'short', leadId: null, startedAtMs: START - 86400000 },
      });
      await PJ.projectThursdayCall({ db: dbR, docId: TDOC, data: thursdayDoc({ userId: U2, companyId: TEN, leadId: null, route: { action: 'inbox' } }) });
      const before = JSON.stringify(dbR.store.get('phone_calls/' + PID));
      const out = await CC.refileNumber({ db: dbR, call: { id: 'cube_ATT01', userId: U2, companyId: TEN, phoneDigits: '5135550142' }, leadId: 'L9', uid: U2, nowMs: NOW });
      ok('F5: the number\'s other unfiled Cube call is filed (control)', out.calls === 1 && dbR.store.get('phone_calls/cube_SIB01').leadId === 'L9', out);
      ok('F5: the Thursday copy is untouched: no lead, no second timeline row or task', JSON.stringify(dbR.store.get('phone_calls/' + PID)) === before &&
        ![...dbR.store.keys()].some((x) => x.includes('cube-' + PID)), [...dbR.store.keys()]);
      const dbS = makeDb({ 'phone_calls/cube_UNF01': { userId: OWN, phoneDigits: '5135550111', status: 'noted', leadId: null, startedAtMs: START } });
      await PJ.projectThursdayCall({ db: dbS, docId: TDOC, data: thursdayDoc({ userId: OWN, companyId: OWN, leadId: null, route: { action: 'inbox' } }) });
      const n = await CC.backfillSuggestions({ db: dbS, nowMs: NOW, leads: [] });
      ok('F5: the suggestion backfill leaves Thursday copies alone (it still checks Cube calls)', n === 1 && dbS.store.get('phone_calls/cube_UNF01').suggestCheckedAtMs === NOW && dbS.store.get('phone_calls/' + PID).suggestCheckedAtMs === undefined, n);
    }

    // F6 + F7: Handled and reviewed are one state.
    {
      const HA = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'home-attention.js'));
      const at = START + 3600000;
      const logged = TP.buildProjection(thursdayDoc({ leadId: null, route: { action: 'log_only', label: 'Logged' }, reviewed: true, extraction: { caller_type: 'silent' }, issue: '', callNotes: null, processedAt: new Date(START + 300000) }), TDOC);
      const open = TP.buildProjection(thursdayDoc({ leadId: null, route: { action: 'inbox' } }), TDOC);
      ok('F6: Home does not count a call Thursday already closed (log-only, reviewed)', HA.callsNeedingYou([Object.assign({ id: PID }, logged)], at) === 0 && logged.handledAtMs === START + 300000, logged);
      ok('...control: an unreviewed unknown caller Thursday took does count', HA.callsNeedingYou([Object.assign({ id: PID }, open)], at) === 1);

      const dbH = makeDb({ ['thursday_calls/' + TDOC]: thursdayDoc() });
      await PJ.projectThursdayCall({ db: dbH, docId: TDOC, data: thursdayDoc() });
      await CC.callAction({ db: dbH, auth, data: { id: PID, action: 'handled' }, nowMs: NOW });
      const t1 = dbH.store.get('thursday_calls/' + TDOC);
      ok('F7: Handled on the Calls screen marks the Thursday call reviewed (callWatch, away mode read that)', t1.reviewed === true && t1.reviewedBy.uid === OWNER);
      await PJ.projectThursdayCall({ db: dbH, docId: TDOC, data: t1 });
      ok('...and the re-projection keeps it handled', dbH.store.get('phone_calls/' + PID).handledAtMs === NOW);
      await CC.callAction({ db: dbH, auth, data: { id: PID, action: 'unhandled' }, nowMs: NOW + 1000 });
      const t2 = dbH.store.get('thursday_calls/' + TDOC);
      await PJ.projectThursdayCall({ db: dbH, docId: TDOC, data: t2 });
      ok('F7: Not handled reopens it in both places', t2.reviewed === false && dbH.store.get('phone_calls/' + PID).handledAtMs === null);
      await PJ.projectThursdayCall({ db: dbH, docId: TDOC, data: thursdayDoc({ reviewed: true, reviewedBy: { uid: 'u-reviewer', at: new Date(NOW + 5000) } }) });
      const p = dbH.store.get('phone_calls/' + PID);
      ok('F7: Mark reviewed in the Thursday inbox shows as Handled on the copy', p.handledAtMs === NOW + 5000 && p.handledBy === 'u-reviewer', p);
      const dbX = makeDb({ ['thursday_calls/' + TDOC]: thursdayDoc({ companyId: 'other-co', userId: 'other-co' }) });
      await PJ.projectThursdayCall({ db: dbX, docId: TDOC, data: thursdayDoc() });
      await CC.callAction({ db: dbX, auth, data: { id: PID, action: 'handled' }, nowMs: NOW });
      ok('...never onto another tenant\'s thursday_calls doc', dbX.store.get('thursday_calls/' + TDOC).reviewed === undefined);
    }

    // F8: the Calls screen offers a Thursday row only what the server takes.
    {
      const vmod = require('vm');
      const win = { _userClaims: { role: 'company_admin', companyId: OWNER }, auth: { currentUser: { uid: OWNER } }, addEventListener() {}, _leads: [] };
      const ctx = vmod.createContext({ window: win, document: { addEventListener() {} }, console });
      vmod.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'call-center-view.js'), 'utf8'), ctx);
      const V = win.NBDCallCenter;
      const thuRow = Object.assign({ id: PID }, TP.buildProjection(thursdayDoc({ leadId: null, route: { action: 'inbox' } }), TDOC));
      const thuFiled = Object.assign({ id: PID }, TP.buildProjection(thursdayDoc(), TDOC));
      const cubeRow = { id: 'cube_CTRL1', userId: OWNER, companyId: OWNER, source: 'cube-acr', status: 'noted', phoneDigits: '5135550142', direction: 'inbound', startedAtMs: START, bucket: 'unknown', transcript: 'hi', summary: 's' };
      const acts = (html) => (html.match(/data-cc="([a-z]+)"/g) || []).map((m) => m.slice(9, -1));
      const hT = V._renderCall(thuRow, {}), hF = V._renderCall(thuFiled, {}), hC = V._renderCall(cubeRow, {});
      const refused = ['promise', 'attachopen', 'newlead', 'merge', 'tx', 'notpersonal'];
      ok('F8: a Thursday card offers no action callCenterAction refuses for it', !acts(hT).some((x) => refused.includes(x)) && !acts(hF).some((x) => refused.includes(x)) && acts(hT).includes('handled'), acts(hT).concat(['|'], acts(hF)));
      ok('...and says where those live (the Thursday inbox)', /Thursday inbox/.test(hT));
      ok('...control: a Cube card still offers Promise and Attach', acts(hC).includes('promise') && acts(hC).includes('attachopen') && !/Thursday inbox/.test(hC), acts(hC));
      const rescue = V._rescueRow(Object.assign({}, thuFiled), {});
      ok('F8: the lost-lead rescue row offers no Follow-up on a Thursday call', !acts(rescue).includes('promise') && acts(rescue).includes('rescuedismiss'), acts(rescue));
      const grp = V._renderGroup({ key: 'num:5135550142', calls: [thuRow, cubeRow] }, {});
      ok('F8: a person\'s group card files and promises through the Cube call only', /data-cc="attachopen" data-id="cube_CTRL1"/.test(grp) && /data-cc="promise" data-ids="cube_CTRL1" data-id="cube_CTRL1"/.test(grp), acts(grp));
    }

    // F9: the readers that skip copies count each call once.
    {
      const AW = require(path.join(FN, 'away-mode.js'))._internal;
      const filedUrgent = thursdayDoc({ urgent: true, reviewed: false, startedAt: new Date(NOW - 3600000), createdAt: new Date(NOW - 3500000) });
      const dbA = makeDb({ ['thursday_calls/' + TDOC]: filedUrgent });
      await PJ.projectThursdayCall({ db: dbA, docId: TDOC, data: filedUrgent });
      const items = await AW.loadOpenItems(dbA, OWNER, NOW);
      ok('F9: away mode: an urgent Thursday call and its copy are ONE open item', items.length === 1, items);

      const WATCH = require(path.join(FN, 'call-watch.js'))._internal;
      const ownDoc = thursdayDoc({ userId: OWN, companyId: OWN, urgent: true, reviewed: false, startedAt: new Date(NOW - 1800000), createdAt: new Date(NOW - 1700000) });
      const dbW = makeDb({ 'integrations/callWatch': { lastCheckAtMs: NOW - 2 * 3600000 }, ['thursday_calls/' + TDOC]: ownDoc, 'leads/L1': { companyId: OWN, userId: OWN } });
      await PJ.projectThursdayCall({ db: dbW, docId: TDOC, data: ownDoc });
      const rw = await WATCH.runWatch({ db: dbW, nowMs: NOW, live: false, push: async () => ({ sent: 1 }), email: async () => {} });
      ok('F9: callWatch: one need for the Thursday call, not a second from its copy', rw.needs === 1, rw);

      const DM = require(path.join(FN, 'pipeline-deadman.js'));
      const seedDm = { 'integrations/callCenter': { lastRunAtMs: NOW - 60000 }, 'phone_calls/cube_STALE': { userId: OWN, startedAtMs: NOW - 40 * 3600000 } };
      for (let i = 0; i < 24; i++) seedDm['phone_calls/thursday_copy' + String(i).padStart(4, '0')] = { userId: OWN, source: 'thursday', startedAtMs: NOW - i * 60000 };
      const dm = await DM.run({ db: makeDb(seedDm), nowMs: NOW, live: false, env: { NBD_OWNER_UID: OWN, CALL_CENTER_INGEST_ENABLED: 'true' } });
      ok('F9: the dead-man still sees a silent Cube ingest under 24 newer Thursday copies', dm.problems.includes('no_new_recordings'), dm);

      const CCALLS = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'customer-calls.js'), 'utf8').replace(/\r\n/g, '\n');
      const from = CCALLS.indexOf('  async function fetchCalls(leadId) {');
      const fetchSrc = CCALLS.slice(from, CCALLS.indexOf('\n  }\n', from) + 4);
      const data = {
        thursday_calls: [{ id: TDOC, leadId: 'L1', userId: OWNER }],
        phone_calls: [Object.assign({ id: PID }, TP.buildProjection(thursdayDoc(), TDOC)), { id: 'cube_C1', leadId: 'L1', userId: OWNER, startedAtMs: START - 86400000 }],
      };
      const cwin = {
        db: {}, auth: { currentUser: { uid: OWNER } },
        where: (f, op, v) => ({ f, op, v }), limit: (n) => ({ n }), collection: (d, name) => name,
        query: (name, ...cs) => ({ name, cs: cs.filter((x) => x && x.f) }),
        getDocs: async (q) => ({ docs: (data[q.name] || []).filter((r) => q.cs.every((x) => r[x.f] === x.v)).map((r) => ({ id: r.id, data: () => r })) }),
      };
      const cctx = require('vm').createContext({ window: cwin, console });
      require('vm').runInContext('function claims() { return {}; }\nfunction leadDigits() { return ""; }\nfunction callTime(x) { return x.startedAtMs || 0; }\n' + fetchSrc + '\nthis.__p = fetchCalls("L1");', cctx);
      const shown = await cctx.__p;
      ok('F9: the customer page shows a Thursday call once (thursday_calls), the Cube call too', shown.length === 2 && shown.some((x) => x._kind === 'thursday') && shown.some((x) => x._id === 'cube_C1') && !shown.some((x) => x._id === PID), shown.map((x) => x._kind + ':' + x._id));
    }

    // F10 (sweep) + F11: one row per linked call; copies are not repeat callers.
    {
      const today = new Date(NOW).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const urgentDoc = thursdayDoc({ userId: OWN, companyId: OWN, urgent: true, startedAt: new Date(NOW - 3600000) });
      const dbS = makeDb({
        'phone_calls/cube_TLK01': { userId: OWN, phoneDigits: '5135550142', direction: 'inbound', status: 'noted', leadId: 'L1', urgent: true, transcript: 'Joe: on my way', durationSec: 400, startedAtMs: NOW - 3600000 + 30000 },
        ['leads/L1/tasks/thursday-' + BLAND]: { done: false, dueDate: today },
        'leads/L1/tasks/cube-cube_TLK01': { done: false, dueDate: today },
      });
      await PJ.projectThursdayCall({ db: dbS, docId: TDOC, data: urgentDoc });
      ok('...(the Cube recording is kept, the copy hidden)', dbS.store.get('phone_calls/' + PID).mergedInto === 'cube_TLK01');
      const sw = await CC.gatherSweep({ db: dbS, nowMs: NOW });
      ok('F10: the sweep lists a linked call once (the kept Cube row)', sw.items.filter((i) => i.callId === 'cube_TLK01' || i.callId === PID).map((i) => i.callId).join() === 'cube_TLK01', sw.items.map((i) => i.callId));

      const two = (n) => thursdayDoc({ userId: OWN, companyId: OWN, callId: 'blandcall-000' + n, call: { callId: 'blandcall-000' + n, transcript: 'hello' }, from: '+15135550177', fromDigits: '5135550177', leadId: null, route: { action: 'inbox' }, startedAt: new Date(NOW - n * 3600000) });
      const dbQ = makeDb();
      await PJ.projectThursdayCall({ db: dbQ, docId: 'bland_calls__1', data: two(1) });
      await PJ.projectThursdayCall({ db: dbQ, docId: 'bland_calls__2', data: two(2) });
      const sq = await CC.gatherSweepWithPromises({ db: dbQ, nowMs: NOW });
      ok('F11: two Thursday calls are not reported as an unlabelled repeat caller', !sq.quietLines.some((l) => /0177/.test(l)), sq.quietLines);
      const dbQ2 = makeDb({
        'phone_calls/cube_Q1': { userId: OWN, phoneDigits: '5135550177', direction: 'inbound', status: 'noted', bucket: 'unknown', leadId: null, startedAtMs: NOW - 3600000 },
        'phone_calls/cube_Q2': { userId: OWN, phoneDigits: '5135550177', direction: 'inbound', status: 'noted', bucket: 'unknown', leadId: null, startedAtMs: NOW - 7200000 },
      });
      const sq2 = await CC.gatherSweepWithPromises({ db: dbQ2, nowMs: NOW });
      ok('...control: two Cube calls from it are', sq2.quietLines.some((l) => /0177/.test(l)), sq2.quietLines);
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
