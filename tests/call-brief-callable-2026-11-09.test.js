/**
 * tests/call-brief-callable-2026-11-09.test.js — Call to Close P0 step 2:
 * functions/call-brief.js, the callBrief and callBriefDecide callables.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.2, §4, §9.
 *
 * Every model call is a fake; nothing reaches Anthropic or Firestore (an
 * in-memory db, loader stubs for firebase-functions / firebase-admin).
 *
 *   1. who: viewer, a sales rep who does not own the call, another tenant,
 *      signed out → refused; owner / company_admin / manager / admin → yes
 *   2. which calls: auto-matched, with alternates, not noted, wrong-tenant
 *      lead → refused, no model call
 *   3. kill switches: aiDisabled and callBriefDisabled stop it before any read
 *      of the transcript reaches a model
 *   4. plan: unverified email / free plan → refused (no fallback brief)
 *   5. quotas: 20 fresh briefs per user per day, 60 per company per day
 *   6. cache: a re-tap makes zero model calls and spends no quota; a forced
 *      refresh inside 10 minutes is served from the cache; a new transcript
 *      regenerates
 *   7. the write: server-only path leads/{leadId}/call_briefs/{callId}, the
 *      sanitised brief, spend recorded under call-brief
 *   8. callBriefDecide: fill-empty only, one field per call, the insurance
 *      acknowledgement for carrier / claim #, append-only decisions, the
 *      summary note written once, unknown items refused
 *   9. wiring: App Check, the secret, index.js exports, FUNCTIONS_INDEX.md
 *
 * Run: node tests/call-brief-callable-2026-11-09.test.js
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
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

// ── Fake Firestore (merge, increment, transactions, delete) ──────────────
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
let flags = {};
let currentDb = makeDb();
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const STUBS = {
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
  'firebase-functions/v2': { logger: silent },
  'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  'firebase-admin/firestore': { getFirestore: () => currentDb, FieldValue: FV, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
  './integrations/killswitch': { isAiDisabled: async () => flags.aiDisabled === true, isCallBriefDisabled: async () => flags.callBriefDisabled === true, getFlags: async () => flags },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
const CB = require(path.join(FN, 'call-brief.js'));
const L = require(path.join(FN, 'call-brief-logic.js'));
const { briefCallable, decideCallable } = CB._test;

const NOW = Date.parse('2026-11-05T18:00:00Z');
const CALL_ID = 'cube_ABCDE12345';
const TRANSCRIPT = 'Hi, this is Pat over on Example Street. We had that hail storm last Tuesday and the roof is leaking in the kitchen. My insurance is State Farm and the claim number is H as in Henry 4 4 7 2 9. Okay, I will send you the estimate by Friday. Thanks.';
const CANNED = {
  brief_v: 1, transcript_ok: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Hail leak; State Farm claim.', quote: ['the roof is leaking in the kitchen'] },
  fields: {
    insCarrier: { value: 'State Farm', quote: 'My insurance is State Farm', conf: 'said' },
    claimNumber: { value: 'H44729', quote: 'the claim number is H as in Henry 4 4 7 2 9', conf: 'said' },
    dateOfLoss: { spoken: 'last Tuesday', ymd: '2026-11-03', quote: 'hail storm last Tuesday', conf: 'said' },
    adjusterName: { value: '', quote: '', conf: 'implied' },
    adjusterMeetingYmd: { spoken: '', ymd: '', quote: '', conf: 'implied' },
    damageType: { value: 'hail', quote: 'hail storm', conf: 'said' },
    jobType: { value: 'insurance', quote: 'My insurance is State Farm', conf: 'implied' },
    workKind: { value: '', quote: '', conf: 'implied' },
  },
  scope: { service: { value: '', quote: '', conf: 'implied' }, tierInterest: '', tierQuote: '', stories: '', storiesQuote: '', layers: '', layersQuote: '', mentions: { gutters: false, chimney: false, skylight: false, decking: false }, saidQuantities: [] },
  promises: [{ who: 'jo', text: 'Send the estimate', dueSpoken: 'by Friday', dueYmd: '2026-11-06', kind: 'estimate', quote: 'I will send you the estimate by Friday' }],
  followUp: { spoken: '', ymd: '', quote: '', conf: 'implied' },
  objections: [], competitor: { named: false, quote: '' }, people: [],
  stage: { targetKey: 'claim_filed', reason: 'Claim open.', quote: 'the claim number is H as in Henry 4 4 7 2 9' },
  drafts: { estimate: true, proposal: true, followUp: 'none' },
};
function seed(over) {
  return Object.assign({
    ['phone_calls/' + CALL_ID]: { userId: 'jo', companyId: 'co1', status: 'noted', callType: 'customer', leadId: 'L1', attachedBy: 'jo', alternateLeadIds: [], transcript: TRANSCRIPT, startedAtMs: Date.parse('2026-11-05T15:00:00Z'), direction: 'inbound', summary: 'NOTES PASS SUMMARY', promises: [{ who: 'jo', text: 'NOTES PASS PROMISE' }] },
    'leads/L1': { userId: 'jo', companyId: 'co1', firstName: 'Pat', insCarrier: '', claimNumber: '', jobType: '' },
    'leads/X1': { userId: 'other', companyId: 'co2', firstName: 'Not yours' },
    'subscriptions/co1': { plan: 'growth', status: 'active' },
    'subscriptions/jo': { plan: 'growth', status: 'active' },
    'companyProfile/co1': { companyName: 'Example Roofing Co', city: 'Dayton', state: 'OH', pipelines: { stages: { inspected: { label: 'Roof Looked At' } } } },
  }, over || {});
}
const OWNER = { uid: 'jo', token: { email_verified: true, companyId: 'co1' } };
let modelCalls = [];
const model = async (req) => { modelCalls.push(req); return { model: req.model, usage: { input_tokens: 2500, output_tokens: 800 }, content: [{ type: 'text', text: JSON.stringify(CANNED) }] }; };
async function brief(db, auth, data, nowMs) {
  currentDb = db;
  try { return { r: await briefCallable({ db, auth, data: Object.assign({ callId: CALL_ID }, data || {}), nowMs: nowMs || NOW, callModel: model, log: silent }) }; }
  catch (e) { return { e }; }
}
async function decide(db, auth, data) {
  currentDb = db;
  try { return { r: await decideCallable({ db, auth, data: Object.assign({ callId: CALL_ID }, data || {}), nowMs: NOW, log: silent }) }; }
  catch (e) { return { e }; }
}

(async () => {
  console.log('\n1. Who may draft a brief');
  {
    modelCalls = [];
    const cases = [
      ['signed out', null, 'unauthenticated'],
      ['a viewer (same company)', { uid: 'v', token: { role: 'viewer', companyId: 'co1', email_verified: true } }, 'permission-denied'],
      ['a viewer who owns the call', { uid: 'jo', token: { role: 'viewer', companyId: 'co1', email_verified: true } }, 'permission-denied'],
      ['a sales rep (not the call owner) who works the lead', { uid: 'rep', token: { role: 'sales_rep', companyId: 'co1', email_verified: true } }, 'permission-denied'],
      ['another tenant\'s company_admin', { uid: 'c2', token: { role: 'company_admin', companyId: 'co2', email_verified: true } }, 'permission-denied'],
    ];
    for (const [name, auth, code] of cases) {
      const r = await brief(makeDb(seed()), auth);
      ok(name + ' → ' + code, r.e && r.e.code === code, r.e ? r.e.code : r.r);
    }
    ok('…and none of them reached the model', modelCalls.length === 0);
    for (const [name, auth] of [['the call owner', OWNER], ['a same-company company_admin', { uid: 'ca', token: { role: 'company_admin', companyId: 'co1', email_verified: true } }],
      ['a same-company manager', { uid: 'mg', token: { role: 'manager', companyId: 'co1', email_verified: true } }], ['a platform admin', { uid: 'adm', token: { role: 'admin' } }]]) {
      const r = await brief(makeDb(seed()), auth);
      ok(name + ' → a brief', r.r && r.r.brief && r.r.cached === false, r.e && r.e.message);
    }
    const bad = await brief(makeDb(seed()), OWNER, { callId: '../leads/L1' });
    ok('a bad call id → invalid-argument', bad.e && bad.e.code === 'invalid-argument');
    const missing = await brief(makeDb(seed()), OWNER, { callId: 'cube_NOPE000000' });
    ok('a missing call → not-found', missing.e && missing.e.code === 'not-found');
  }

  console.log('\n2. Which calls');
  {
    modelCalls = [];
    const call = (over) => ({ ['phone_calls/' + CALL_ID]: Object.assign({}, seed()['phone_calls/' + CALL_ID], over) });
    const r1 = await brief(makeDb(seed(call({ attachedBy: null }))), OWNER);
    ok('auto-matched by number (no attachedBy / movedBy) → refused: confirm the customer first', r1.e && r1.e.code === 'failed-precondition' && /Confirm the customer first/.test(r1.e.message), r1.e && r1.e.message);
    const r2 = await brief(makeDb(seed(call({ alternateLeadIds: ['L9'] }))), OWNER);
    ok('a call with alternate customers → refused', r2.e && r2.e.code === 'failed-precondition' && /Confirm the customer first/.test(r2.e.message));
    const r3 = await brief(makeDb(seed(call({ status: 'stored' }))), OWNER);
    ok('not noted yet → refused, with the 30-60 minute line', r3.e && /30-60 minutes/.test(r3.e.message));
    const r4 = await brief(makeDb(seed(call({ leadId: 'X1' }))), OWNER);
    ok('the call names a lead in another tenant → refused', r4.e && r4.e.code === 'permission-denied', r4.e && r4.e.code);
    const r5 = await brief(makeDb(seed(call({ status: 'personal', callType: 'personal' }))), OWNER);
    ok('a personal call → refused', r5.e && r5.e.code === 'failed-precondition');
    const r6 = await brief(makeDb(seed(call({ attachedBy: null, movedBy: 'jo' }))), OWNER);
    ok('a moved call (movedBy) is human-filed → a brief', r6.r && r6.r.brief);
    ok('no refused call reached the model', modelCalls.length === 1);
  }

  console.log('\n3. Kill switches');
  {
    modelCalls = [];
    flags = { aiDisabled: true };
    const r1 = await brief(makeDb(seed()), OWNER);
    ok('aiDisabled → refused', r1.e && r1.e.code === 'failed-precondition' && /switched off/.test(r1.e.message));
    flags = { callBriefDisabled: true };
    const r2 = await brief(makeDb(seed()), OWNER);
    ok('callBriefDisabled → refused', r2.e && r2.e.code === 'failed-precondition');
    ok('…no model call either way', modelCalls.length === 0);
    flags = {};
    const ks = read('functions/integrations/killswitch.js');
    ok('killswitch.js exports isCallBriefDisabled reading feature_flags/global callBriefDisabled', /async function isCallBriefDisabled\(\)/.test(ks) && /f\.callBriefDisabled === true/.test(ks) && /isCallBriefDisabled,/.test(ks));
  }

  console.log('\n4. Plan');
  {
    modelCalls = [];
    const r1 = await brief(makeDb(seed()), { uid: 'jo', token: { companyId: 'co1', email_verified: false } });
    ok('unverified email → refused', r1.e && r1.e.code === 'permission-denied' && /verified email/.test(r1.e.message));
    const s = seed(); delete s['subscriptions/co1'];
    const r2 = await brief(makeDb(s), OWNER);
    ok('no paid plan → refused', r2.e && r2.e.code === 'permission-denied');
    ok('no model call', modelCalls.length === 0);
  }

  console.log('\n5. Quotas');
  {
    modelCalls = [];
    const ymd = '2026-11-05';
    const s = seed({ ['call_brief_quota/' + ymd + '__u__jo']: { n: 20 } });
    const r1 = await brief(makeDb(s), OWNER);
    ok('the user\'s 21st fresh brief of the day → resource-exhausted', r1.e && r1.e.code === 'resource-exhausted' && /20/.test(r1.e.message), r1.e && r1.e.message);
    const s2 = seed({ ['call_brief_quota/' + ymd + '__u__jo']: { n: 19 } });
    const db2 = makeDb(s2);
    const r2 = await brief(db2, OWNER);
    ok('the 20th → allowed, and counted', r2.r && db2.store.get('call_brief_quota/' + ymd + '__u__jo').n === 20 && db2.store.get('call_brief_quota/' + ymd + '__c__co1').n === 1);
    const s3 = seed({ ['call_brief_quota/' + ymd + '__c__co1']: { n: 60 } });
    const r3 = await brief(makeDb(s3), { uid: 'mg', token: { role: 'manager', companyId: 'co1', email_verified: true } });
    ok('the company\'s 61st → resource-exhausted, whoever asks', r3.e && r3.e.code === 'resource-exhausted' && /60/.test(r3.e.message));
    ok('over-cap taps never reached the model', modelCalls.length === 1);
    ok('the caps are 20 and 60', L.USER_DAY_CAP === 20 && L.COMPANY_DAY_CAP === 60);
  }

  console.log('\n6. Cache');
  {
    modelCalls = [];
    const db = makeDb(seed());
    const r1 = await brief(db, OWNER);
    ok('first tap: one model call', modelCalls.length === 1 && r1.r.cached === false);
    const r2 = await brief(db, OWNER, {}, NOW + 3600e3);
    ok('a re-tap an hour later: zero model calls, the stored brief', modelCalls.length === 1 && r2.r.cached === true && JSON.stringify(r2.r.brief) === JSON.stringify(r1.r.brief));
    ok('…and no quota spent', db.store.get('call_brief_quota/2026-11-05__u__jo').n === 1);
    const r3 = await brief(db, OWNER, { refresh: true }, NOW + 5 * 60e3);
    ok('a forced refresh inside 10 minutes → the stored brief, no model call, says so', modelCalls.length === 1 && r3.r.cached === true && r3.r.refreshRefused === true);
    await brief(db, OWNER, { refresh: true }, NOW + 11 * 60e3);
    ok('a forced refresh after 10 minutes → regenerates', modelCalls.length === 2);
    db.store.set('phone_calls/' + CALL_ID, Object.assign({}, db.store.get('phone_calls/' + CALL_ID), { transcript: TRANSCRIPT + ' One more thing.' }));
    await brief(db, OWNER, {}, NOW + 20 * 60e3);
    ok('a changed transcript (new hash) regenerates', modelCalls.length === 3);
    const failing = async () => { throw new Error('anthropic 529'); };
    const db2 = makeDb(seed());
    currentDb = db2;
    let e2 = null;
    try { await briefCallable({ db: db2, auth: OWNER, data: { callId: CALL_ID }, nowMs: NOW, callModel: failing, log: silent }); } catch (e) { e2 = e; }
    ok('a model failure → an error, nothing cached', e2 && e2.code === 'unavailable' && !db2.store.has('leads/L1/call_briefs/' + CALL_ID), e2 && e2.code);
  }

  console.log('\n7. The write');
  {
    modelCalls = [];
    const db = makeDb(seed());
    const r = await brief(db, OWNER);
    const stored = db.store.get('leads/L1/call_briefs/' + CALL_ID);
    ok('stored under the lead: leads/L1/call_briefs/<callId>', !!stored && stored.callId === CALL_ID && stored.leadId === 'L1' && stored.companyId === 'co1' && stored.userId === 'jo');
    ok('keyed by version + transcript hash', stored.v === L.BRIEF_VERSION && stored.transcriptHash === L.transcriptHash(TRANSCRIPT));
    ok('the sanitised brief: claim # grounded, server-resolved date of loss', r.r.brief.fields.claimNumber.value === 'H44729' && r.r.brief.fields.dateOfLoss.value === '2026-11-03');
    ok('the prompt used the transcript only (no notes-pass summary / promises)', !/NOTES PASS/.test(JSON.stringify(modelCalls[0])) && /State Farm/.test(modelCalls[0].messages[0].content));
    ok('the tenant\'s name, region and relabelled stage reached the prompt', /Example Roofing Co/.test(modelCalls[0].system) && /Dayton, OH/.test(modelCalls[0].system) && /inspected = Roof Looked At/.test(modelCalls[0].messages[0].content));
    ok('spend recorded under call-brief', db.store.has('ai_spend_daily/2026-11-05') && JSON.stringify(db.store.get('ai_spend_daily/2026-11-05')).includes('call-brief'));
    ok('the brief carries no price', !/price|total|"rate"|deductible/i.test(JSON.stringify(r.r.brief.fields)));
    ok('decisions start empty', Array.isArray(stored.decisions) && stored.decisions.length === 0);
    ok('the answer carries the decisions too (for a re-open)', Array.isArray(r.r.decisions));
  }

  console.log('\n8. callBriefDecide');
  {
    const db = makeDb(seed());
    await brief(db, OWNER);
    const d0 = await decide(makeDb(seed()), OWNER, { item: 'field:insCarrier', decision: 'accept', confirmedInsurance: true });
    ok('no brief yet → failed-precondition', d0.e && d0.e.code === 'failed-precondition');
    const v = await decide(db, { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { item: 'field:damageType', decision: 'accept' });
    ok('a viewer cannot decide', v.e && v.e.code === 'permission-denied');
    const rep = await decide(db, { uid: 'rep', token: { role: 'sales_rep', companyId: 'co1' } }, { item: 'field:damageType', decision: 'accept' });
    ok('a sales rep who is not the call owner cannot decide', rep.e && rep.e.code === 'permission-denied');
    const noAck = await decide(db, OWNER, { item: 'field:insCarrier', decision: 'accept' });
    ok('carrier without the insurance acknowledgement → refused, lead untouched', noAck.e && noAck.e.code === 'failed-precondition' && /insurance job/.test(noAck.e.message) && db.store.get('leads/L1').insCarrier === '');
    const a1 = await decide(db, OWNER, { item: 'field:insCarrier', decision: 'accept', confirmedInsurance: true });
    ok('carrier with the acknowledgement → written to the empty lead field', a1.r && a1.r.written === true && db.store.get('leads/L1').insCarrier === 'State Farm');
    const a2 = await decide(db, OWNER, { item: 'field:insCarrier', decision: 'accept', confirmedInsurance: true });
    ok('a second accept on a now-filled field → refused (fill-empty only, never overwrite)', a2.e && a2.e.code === 'failed-precondition' && /already/i.test(a2.e.message));
    db.store.set('leads/L1', Object.assign({}, db.store.get('leads/L1'), { damageType: 'wind' }));
    const a3 = await decide(db, OWNER, { item: 'field:damageType', decision: 'accept' });
    ok('a field the lead already has → refused, the old value kept', a3.e && db.store.get('leads/L1').damageType === 'wind');
    const ed = await decide(db, OWNER, { item: 'field:claimNumber', decision: 'accept', value: 'H44729-A', confirmedInsurance: true });
    ok('Edit: the person\'s own value is written (final differs from the AI value)', ed.r && db.store.get('leads/L1').claimNumber === 'H44729-A');
    const dl = await decide(db, OWNER, { item: 'field:dateOfLoss', decision: 'accept', value: 'last week' });
    ok('a date field must be YYYY-MM-DD', dl.e && dl.e.code === 'invalid-argument');
    const dl2 = await decide(db, OWNER, { item: 'field:dateOfLoss', decision: 'accept' });
    ok('…the server-resolved date is written as-is', dl2.r && db.store.get('leads/L1').dateOfLoss === '2026-11-03');
    const nf = await decide(db, OWNER, { item: 'field:adjusterName', decision: 'accept', value: 'Someone' });
    ok('a field the brief did not propose → refused', nf.e && nf.e.code === 'failed-precondition');
    const bulk = await decide(db, OWNER, { item: ['field:jobType', 'field:damageType'], decision: 'accept' });
    ok('no bulk: an array of items is refused', bulk.e && bulk.e.code === 'invalid-argument');
    const bad = await decide(db, OWNER, { item: 'field:price', decision: 'accept' });
    ok('an unknown field (e.g. a price) is refused', bad.e && bad.e.code === 'invalid-argument');
    const sk = await decide(db, OWNER, { item: 'field:jobType', decision: 'skip' });
    ok('Skip writes nothing to the lead', sk.r && sk.r.written === false && db.store.get('leads/L1').jobType === '');
    const jt = await decide(db, OWNER, { item: 'field:jobType', decision: 'accept' });
    ok('jobType insurance also needs the acknowledgement', jt.e && /insurance job/.test(jt.e.message));
    const sm = await decide(db, OWNER, { item: 'summary', decision: 'accept', value: 'Hail leak; State Farm claim; estimate by Friday.' });
    const act = db.store.get('leads/L1/activity/callbrief-' + CALL_ID);
    ok('summary accept → one activity note on the lead, from the call', sm.r && act && act.type === 'note' && act.source === 'call-brief' && act.phoneCallId === CALL_ID && /estimate by Friday/.test(act.text));
    const sm2 = await decide(db, OWNER, { item: 'summary', decision: 'accept', value: 'again' });
    ok('…a second summary accept does not add another (append-only, once)', sm2.e && sm2.e.code === 'failed-precondition' && /again/.test(db.store.get('leads/L1/activity/callbrief-' + CALL_ID).text) === false);
    const pr = await decide(db, OWNER, { item: 'promise:0', decision: 'accept', value: 'estimate 2026-11-06' });
    ok('a promise decision is logged only (the promise itself goes through callCenterAction)', pr.r && pr.r.written === false);
    const pr1 = await decide(db, OWNER, { item: 'promise:0', decision: 'accept', value: 'estimate 2026-11-06', slot: 2 });
    const lastD = (db.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || []).slice(-1)[0];
    ok('a promise decision records the slot it went to (1-5)', pr1.r && lastD.slot === 2, lastD);
    ok('every decision names the brief it was made on (gen = generatedAtMs; a regenerate re-indexes)', typeof lastD.gen === 'number' && lastD.gen === db.store.get('leads/L1/call_briefs/' + CALL_ID).generatedAtMs, lastD);
    const pr5 = await decide(db, OWNER, { item: 'promise:5', decision: 'accept' });
    ok('promise:5 is not an item (a brief carries five promises, 0-4)', pr5.e && pr5.e.code === 'invalid-argument');
    const stored = db.store.get('leads/L1/call_briefs/' + CALL_ID);
    const ds = stored.decisions || [];
    ok('decisions are appended: item, AI value, final value, decidedBy, time', ds.length >= 7 && ds.every((d) => d.item && d.decision && d.decidedBy === 'jo' && typeof d.atMs === 'number')
      && ds.some((d) => d.item === 'field:claimNumber' && d.aiValue === 'H44729' && d.finalValue === 'H44729-A'), ds);
    ok('refused decisions are not logged as made', !ds.some((d) => d.item === 'field:adjusterName'));
    const before = ds.length;
    await decide(db, OWNER, { item: 'stage', decision: 'skip' });
    ok('append-only: earlier decisions stay, one more is added', (db.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || []).length === before + 1
      && JSON.stringify((db.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || []).slice(0, before)) === JSON.stringify(ds));
    flags = { callBriefDisabled: true };
    const off = await decide(db, OWNER, { item: 'stage', decision: 'skip' });
    ok('callBriefDisabled stops decisions too', off.e && off.e.code === 'failed-precondition');
    flags = {};
    const moved = makeDb(seed());
    await brief(moved, OWNER);
    moved.store.set('phone_calls/' + CALL_ID, Object.assign({}, moved.store.get('phone_calls/' + CALL_ID), { leadId: 'L2' }));
    moved.store.set('leads/L2', { userId: 'jo', companyId: 'co1' });
    const mv = await decide(moved, OWNER, { item: 'field:damageType', decision: 'accept' });
    ok('after a move the old lead\'s brief is not decidable from the new lead (no brief there)', mv.e && mv.e.code === 'failed-precondition' && moved.store.get('leads/L2').damageType === undefined);
  }

  console.log('\n9. Wiring');
  {
    ok('callBrief: App Check enforced, Anthropic secret, own timeouts', CB.callBrief.__opts.enforceAppCheck === true && CB.callBrief.__opts.secrets.some((s) => s.name === 'ANTHROPIC_API_KEY'));
    ok('callBriefDecide: App Check enforced, no secret', CB.callBriefDecide.__opts.enforceAppCheck === true && !CB.callBriefDecide.__opts.secrets);
    const src = read('functions/call-brief.js');
    ok('both handlers call assertNotGhost first', (src.match(/assertNotGhost\(request\)/g) || []).length === 2);
    ok('spend is recorded under the feature call-brief', /rowFromAnthropic\('call-brief'/.test(src));
    const idx = read('functions/index.js');
    ok('index.js exports callBrief and callBriefDecide', /exports\.callBrief = require\('\.\/call-brief'\)\.callBrief/.test(idx) && /exports\.callBriefDecide = require\('\.\/call-brief'\)\.callBriefDecide/.test(idx));
    const fi = read('functions/FUNCTIONS_INDEX.md');
    ok('FUNCTIONS_INDEX.md has rows for both', /\| `callBrief` \|/.test(fi) && /\| `callBriefDecide` \|/.test(fi));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
