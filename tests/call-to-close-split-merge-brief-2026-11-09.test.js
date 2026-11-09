/**
 * tests/call-to-close-split-merge-brief-2026-11-09.test.js — Call to Close
 * P2, merging split calls: what the Call Brief reads (design §9 P2;
 * functions/call-brief.js briefInput, functions/call-merge-logic.js).
 *
 *   1. a merged primary's brief reads both transcripts, first call first,
 *      with the separator between them; the model sees the joined text only
 *      (still fenced, never the notes pass)
 *   2. the merge invalidates the stored brief: the transcript hash changes,
 *      so the next tap redrafts (one model call); a re-tap is then cached
 *   3. the redial itself (mergedInto) is refused a brief, and Accept / Skip
 *      on it, with no model call
 *   4. Undo (marks cleared): the brief reads the first call alone again
 *   5. the redial counts only when both marks agree, it is the same tenant,
 *      not filed on another customer and not personal; a redial with no
 *      transcript yet adds nothing (the stored brief stays good)
 *   6. the auto-brief reads the same joined text
 *
 * Every model call is a fake; nothing reaches Anthropic or Firestore.
 * Run: node tests/call-to-close-split-merge-brief-2026-11-09.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const INC = Symbol('inc');
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const writes = [];
  function mergeInto(base, patch) {
    const out = Object.assign({}, base || {});
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && v[INC] !== undefined) out[k] = (Number(out[k]) || 0) + v[INC];
      else if (v && typeof v === 'object' && !Array.isArray(v) && !v.__ts && Object.getPrototypeOf(v) === Object.prototype) out[k] = mergeInto(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function doc(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => ({ id: p.split('/').pop(), exists: store.has(p), data: () => (store.has(p) ? clone(store.get(p)) : undefined) }),
      set: async (data, opts) => { writes.push({ op: 'set', path: p, data }); store.set(p, opts && opts.merge ? mergeInto(store.get(p), data) : mergeInto({}, data)); },
      create: async (data) => { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push({ op: 'create', path: p, data }); store.set(p, mergeInto({}, data)); },
      delete: async () => { writes.push({ op: 'delete', path: p }); store.delete(p); },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function coll(name) { return { doc: (id) => doc(name + '/' + id) }; }
  return {
    store, writes, doc, collection: coll,
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), create: (r, d) => r.create(d) }),
  };
}
const FV = { increment: (n) => ({ [INC]: n }), serverTimestamp: () => ({ __ts: true }), delete: () => null };
const silent = { info() {}, warn() {}, error() {}, debug() {} };
let currentDb = makeDb();
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const STUBS = {
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
  'firebase-functions/v2': { logger: silent },
  'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  'firebase-functions/v2/firestore': { onDocumentUpdated: (o, h) => ({ __opts: o, __handler: h }), onDocumentWritten: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-admin/firestore': { getFirestore: () => currentDb, FieldValue: FV, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
  'firebase-admin/auth': { getAuth: () => ({ getUser: async () => { throw new Error('tests inject getUser'); } }) },
  './integrations/killswitch': { isAiDisabled: async () => false, isCallBriefDisabled: async () => false, getFlags: async () => ({}) },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
const CB = require(path.join(FN, 'call-brief.js'));
const L = require(path.join(FN, 'call-brief-logic.js'));
let MG = null;
try { MG = require(path.join(FN, 'call-merge-logic.js')); } catch (_) { /* reported below */ }
const SEP = MG ? MG.SEPARATOR : '\n\n[missing]\n\n';
const { briefCallable, decideCallable, autoBriefHandler } = CB._test;

const NOW = Date.parse('2026-11-05T18:00:00Z');
const P_ID = 'cube_SPLITB0001';
const S_ID = 'cube_SPLITB0002';
const A = 'Hi, this is Pat over on Example Street. We had that hail storm last Tuesday and the roof is leaking in the kitchen. My insurance is State Farm and the';
const B = 'Sorry, it cut out. The claim number is H as in Henry 4 4 7 2 9. Okay, I will send you the estimate by Friday. Thanks.';
const CANNED = {
  brief_v: 1, transcript_ok: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Hail leak; State Farm claim.', quote: ['the roof is leaking in the kitchen'] },
  fields: {
    insCarrier: { value: 'State Farm', quote: 'My insurance is State Farm', conf: 'said' },
    claimNumber: { value: 'H44729', quote: 'The claim number is H as in Henry 4 4 7 2 9', conf: 'said' },
    dateOfLoss: { spoken: '', ymd: '', quote: '', conf: 'implied' },
    adjusterName: { value: '', quote: '', conf: 'implied' },
    adjusterMeetingYmd: { spoken: '', ymd: '', quote: '', conf: 'implied' },
    damageType: { value: 'hail', quote: 'hail storm', conf: 'said' },
    jobType: { value: '', quote: '', conf: 'implied' }, workKind: { value: '', quote: '', conf: 'implied' },
  },
  scope: { service: { value: '', quote: '', conf: 'implied' }, tierInterest: '', tierQuote: '', stories: '', storiesQuote: '', layers: '', layersQuote: '', mentions: { gutters: false, chimney: false, skylight: false, decking: false }, saidQuantities: [] },
  promises: [{ who: 'jo', text: 'Send the estimate', dueSpoken: 'by Friday', dueYmd: '2026-11-06', kind: 'estimate', quote: 'I will send you the estimate by Friday' }],
  followUp: { spoken: '', ymd: '', quote: '', conf: 'implied' },
  objections: [], competitor: { named: false, quote: '' }, people: [], stage: null,
  drafts: { estimate: true, proposal: false, followUp: 'none' },
};
const PRIMARY = { userId: 'jo', companyId: 'co1', status: 'noted', callType: 'customer', leadId: 'L1', attachedBy: 'jo', attachedAtMs: NOW - 3600e3, alternateLeadIds: [], transcript: A, phoneDigits: '5135550100', startedAtMs: Date.parse('2026-11-05T15:00:00Z'), durationSec: 120, direction: 'inbound', summary: 'NOTES PASS SUMMARY' };
const REDIAL = Object.assign({}, PRIMARY, { leadId: null, attachedBy: null, transcript: B, startedAtMs: PRIMARY.startedAtMs + 5 * 60e3, durationSec: 60, summary: 'NOTES PASS REDIAL' });
function seed(pOver, sOver, extra) {
  return Object.assign({
    ['phone_calls/' + P_ID]: Object.assign({}, PRIMARY, { mergedFrom: S_ID }, pOver || {}),
    ['phone_calls/' + S_ID]: Object.assign({}, REDIAL, { mergedInto: P_ID }, sOver || {}),
    'leads/L1': { userId: 'jo', companyId: 'co1', firstName: 'Pat', insCarrier: '', claimNumber: '' },
    'subscriptions/co1': { plan: 'growth', status: 'active' },
    'companyProfile/co1': { companyName: 'Example Roofing Co', city: 'Dayton', state: 'OH' },
  }, extra || {});
}
const OWNER = { uid: 'jo', token: { email_verified: true, companyId: 'co1' } };
let modelCalls = [];
const model = async (req) => { modelCalls.push(req); return { model: req.model, usage: { input_tokens: 2500, output_tokens: 800 }, content: [{ type: 'text', text: JSON.stringify(CANNED) }] }; };
async function brief(db, id, data) {
  currentDb = db;
  try { return { r: await briefCallable({ db, auth: OWNER, data: Object.assign({ callId: id || P_ID }, data || {}), nowMs: NOW, callModel: model, log: silent }) }; }
  catch (e) { return { e }; }
}
const userText = (req) => String((((req || {}).messages || [])[0] || {}).content || '');
const fenced = (req) => { const t = userText(req); const a = t.indexOf('<transcript>\n'); const b = t.lastIndexOf('\n</transcript>'); return a < 0 || b < 0 ? '' : t.slice(a + 13, b); };
const briefDoc = (db) => db.store.get('leads/L1/call_briefs/' + P_ID);

(async () => {
  ok('functions/call-merge-logic.js loads', !!MG);
  ok('call-brief.js exposes briefInput', typeof CB._test.briefInput === 'function');

  console.log('\n1. A merged primary reads both calls');
  {
    modelCalls = [];
    const db = makeDb(seed());
    const r = await brief(db);
    ok('a brief comes back', r.r && r.r.brief && r.r.cached === false, r.e && r.e.message);
    const sent = modelCalls[0] ? fenced(modelCalls[0]) : '';
    ok('the model gets exactly: first call, separator, redial', sent === L.fenceSafe(A + SEP + B), JSON.stringify(sent.slice(0, 200)));
    ok('in call order (the first call before the redial)', sent.indexOf('Example Street') >= 0 && sent.indexOf('Example Street') < sent.indexOf('Sorry, it cut out'));
    ok('the notes pass is never sent, from either call', !/NOTES PASS/.test(userText(modelCalls[0] || {})));
    const d = briefDoc(db);
    ok('the stored hash is the joined text\'s', d && d.transcriptHash === L.transcriptHash(A + SEP + B));
    ok('the stored brief names the call it merged in', d && d.mergedFrom === S_ID);
    const b = r.r && r.r.brief;
    ok('a fact said on the redial grounds (claim # from the second call)', b && b.fields && b.fields.claimNumber && /44729/.test(b.fields.claimNumber.value), b && b.fields && b.fields.claimNumber);
    ok('a fact said on the first call grounds too (carrier)', b && b.fields && b.fields.insCarrier && b.fields.insCarrier.value === 'State Farm');
    ok('nothing is written to either call doc', !db.writes.some((w) => /^phone_calls\//.test(w.path)));
  }

  console.log('\n2. The merge invalidates the stored brief');
  {
    modelCalls = [];
    // A brief drafted from the first call alone, before the merge.
    const pre = { callId: P_ID, leadId: 'L1', v: L.BRIEF_VERSION, transcriptHash: L.transcriptHash(A), generatedAtMs: NOW - 3600e3, brief: { summary: { text: 'old' } }, decisions: [{ item: 'summary', decision: 'skip' }] };
    const db = makeDb(seed(null, null, { ['leads/L1/call_briefs/' + P_ID]: pre }));
    const r = await brief(db);
    ok('the next tap redrafts (one model call), not the stale single-call brief', modelCalls.length === 1 && r.r && r.r.cached === false && r.r.brief.summary.text !== 'old');
    ok('decisions already made are kept (append-only log)', Array.isArray(briefDoc(db).decisions) && briefDoc(db).decisions.length === 1);
    const again = await brief(db);
    ok('a re-tap is then cached (no second model call)', modelCalls.length === 1 && again.r && again.r.cached === true);
    const ctl = makeDb(seed({ mergedFrom: null }, { mergedInto: null }, { ['leads/L1/call_briefs/' + P_ID]: pre }));
    modelCalls = [];
    const c = await brief(ctl);
    ok('control: unmerged, the same stored brief is used as it was', modelCalls.length === 0 && c.r && c.r.cached === true && c.r.brief.summary.text === 'old');
  }

  console.log('\n3. The redial itself');
  {
    modelCalls = [];
    const db = makeDb(seed(null, { leadId: 'L1', attachedBy: 'jo' }));
    const r = await brief(db, S_ID);
    ok('a brief on the merged redial is refused (draft from the first call)', r.e && r.e.code === 'failed-precondition' && /merged/i.test(r.e.message), r.e ? r.e.message : r.r);
    currentDb = db;
    let d;
    try { d = { r: await decideCallable({ db, auth: OWNER, data: { callId: S_ID, item: 'summary', decision: 'skip' }, nowMs: NOW, log: silent }) }; } catch (e) { d = { e }; }
    ok('...and so is Accept / Skip on it', d.e && d.e.code === 'failed-precondition');
    ok('no model call', modelCalls.length === 0);
  }

  console.log('\n4. Undo: the first call alone again');
  {
    modelCalls = [];
    const db = makeDb(seed());
    await brief(db);
    db.store.set('phone_calls/' + P_ID, Object.assign({}, db.store.get('phone_calls/' + P_ID), { mergedFrom: null }));
    db.store.set('phone_calls/' + S_ID, Object.assign({}, db.store.get('phone_calls/' + S_ID), { mergedInto: null }));
    const r = await brief(db);
    ok('after Undo the hash is the first call\'s again, so it redrafts', modelCalls.length === 2 && r.r && r.r.cached === false && briefDoc(db).transcriptHash === L.transcriptHash(A));
    ok('...from the first call alone', fenced(modelCalls[1]) === L.fenceSafe(A) && !briefDoc(db).mergedFrom);
  }

  console.log('\n5. When the redial does not count');
  {
    const cases = [
      ['marks disagree (the redial points elsewhere)', null, { mergedInto: 'cube_SOMEONE01' }],
      ['the redial is gone', null, null, true],
      ['another tenant\'s call', null, { userId: 'other', companyId: 'co2' }],
      ['filed on another customer', null, { leadId: 'L2' }],
      ['the redial was marked personal', null, { status: 'personal', callType: 'personal' }],
      ['a bad id in mergedFrom', { mergedFrom: '../leads/L1' }, null],
    ];
    for (const [name, pOver, sOver, gone] of cases) {
      modelCalls = [];
      const s = seed(pOver, sOver);
      if (gone) delete s['phone_calls/' + S_ID];
      const db = makeDb(s);
      const r = await brief(db);
      ok(name + ': the brief reads the first call alone', r.r && modelCalls.length === 1 && fenced(modelCalls[0]) === L.fenceSafe(A), r.e ? r.e.message : fenced(modelCalls[0] || {}).slice(-60));
    }
    modelCalls = [];
    const pre = { callId: P_ID, leadId: 'L1', v: L.BRIEF_VERSION, transcriptHash: L.transcriptHash(A), generatedAtMs: NOW - 3600e3, brief: { summary: { text: 'old' } }, decisions: [] };
    const db = makeDb(seed(null, { transcript: null, status: 'stored' }, { ['leads/L1/call_briefs/' + P_ID]: pre }));
    const r = await brief(db);
    ok('a redial not transcribed yet adds nothing: the stored brief stays good', modelCalls.length === 0 && r.r && r.r.cached === true);
    ok('...until its text arrives (then the hash changes)', L.transcriptHash(MG ? MG.joinTranscripts(A, B) : A) !== pre.transcriptHash);
  }

  console.log('\n6. The auto-brief reads the same text');
  {
    modelCalls = [];
    const before = Object.assign({}, PRIMARY, { attachedBy: null, attachedAtMs: null, mergedFrom: S_ID });
    const after = Object.assign({}, PRIMARY, { mergedFrom: S_ID });
    const db = makeDb(seed(null, null, { 'companies/co1/settings/callBrief': { autoBrief: true } }));
    currentDb = db;
    const res = await autoBriefHandler({ db, callId: P_ID, before, after, nowMs: NOW, callModel: model, getUser: async () => ({ uid: 'jo', emailVerified: true, customClaims: { companyId: 'co1' } }), log: silent });
    ok('auto-brief drafted', res.state === 'briefed', res);
    ok('...from first call + separator + redial', modelCalls[0] && fenced(modelCalls[0]) === L.fenceSafe(A + SEP + B));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
