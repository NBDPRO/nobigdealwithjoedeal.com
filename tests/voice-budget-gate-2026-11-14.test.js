/**
 * tests/voice-budget-gate-2026-11-14.test.js
 *
 * Round-2 AI audit (2026-11-14), F1: call-recording uploads
 * (functions/integrations/voice-intelligence.js, onAudioUploaded).
 *   1. checkBudget compared a per-DAY counter with per-MONTH caps (30x too
 *      generous) and never counted the Claude calls each clip makes. Now:
 *      audio this month vs the monthly cap, and voice Claude calls today vs a
 *      per-company daily cap.
 *   2. incrementVoiceUsage feeds both counters (monthly doc + claudeCalls).
 *   3. the plan is the COMPANY's subscription, not the rep's uid.
 *   4. processRecording: a free / unconfirmed uploader gets a failed doc with
 *      the reason and NO Groq / Claude spend; NBD and a paying tenant pass.
 *   5. onAudioUploaded has an instance cap.
 * Everything runs against stubs: no Firebase, no network.
 *
 * Run: node tests/voice-budget-gate-2026-11-14.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); failed++; fails.push(label); }
}

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const INC = Symbol('inc');
let docs = {}; const writes = []; const reads = [];
function mergeInto(base, patch) {
  const out = Object.assign({}, base || {});
  for (const [k, v] of Object.entries(patch || {})) out[k] = v && v[INC] !== undefined ? (Number(out[k]) || 0) + v[INC] : v;
  return out;
}
const db = {
  doc: (p) => ({
    get: async () => { reads.push(p); return { exists: Object.prototype.hasOwnProperty.call(docs, p), data: () => docs[p] }; },
    set: async (v, o) => { writes.push({ p, v }); docs[p] = o && o.merge ? mergeInto(docs[p], v) : mergeInto({}, v); },
  }),
};
const spend = { download: 0, fetch: 0 };
const bucket = { file: () => ({
  exists: async () => { spend.download++; return [true]; },
  download: async () => { spend.download++; return [Buffer.from('audio')]; },
  getMetadata: async () => [{ size: 5 }],
}) };
const users = {
  freeOwner: { emailVerified: true, customClaims: { companyId: 'freeCo', role: 'company_admin' } },
  unconfirmedRep: { emailVerified: false, customClaims: { companyId: 'paidCo', role: 'sales_rep' } },
  paidRep: { emailVerified: true, customClaims: { companyId: 'paidCo', role: 'sales_rep' } },
  [NBD]: { emailVerified: true, customClaims: {} },
};
const noop = () => ({});
const STUBS = {
  'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError: class extends Error {} },
  'firebase-functions/v2/storage': { onObjectFinalized: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/v2/scheduler': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k' }) },
  'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { increment: (n) => ({ [INC]: n }), serverTimestamp: () => 'TS' }, Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) } },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => bucket }) },
  'firebase-admin/auth': { getAuth: () => ({ getUser: async (u) => { if (!users[u]) throw new Error('no user'); return users[u]; } }) },
  './killswitch': { isVoiceIntelDisabled: async () => false, isAiDisabled: async () => false },
  './heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
global.fetch = async () => { spend.fetch++; return { ok: false, status: 500, json: async () => ({}), text: async () => 'stub' }; };
process.env.GROQ_API_KEY = 'gsk_test_dummy';

const VI = require(path.join(ROOT, 'functions', 'integrations', 'voice-intelligence.js'));
const today = new Date().toISOString();
const DAY = today.slice(0, 10), MONTH = today.slice(0, 7);

(async () => {
  console.log('\n1. checkBudget: monthly audio, daily Claude calls');
  docs = { ['api_usage_daily/' + DAY + '__co__freeCo']: { voice_audioSec: 3700 } };
  let b = await VI._checkBudget(db, 'freeCo', 'free');
  ok('free plan, 3,700 s used TODAY but nothing this month → the daily doc no longer decides', b.audioOver === false, b);
  docs = { ['api_usage_monthly/' + MONTH + '__co__freeCo']: { voice_audioSec: 3700 } };
  b = await VI._checkBudget(db, 'freeCo', 'free');
  ok('free plan, 3,700 s this MONTH → over budget (the 1 hr/month cap)', b.overBudget === true && b.audioOver === true, b);
  docs = { ['api_usage_monthly/' + MONTH + '__co__paidCo']: { voice_audioSec: 71000 } };
  b = await VI._checkBudget(db, 'paidCo', 'starter');
  ok('starter, 71,000 s this month → under its 20 hr/month', b.overBudget === false && b.cap === 72000, b);
  docs = { ['api_usage_monthly/' + MONTH + '__co__paidCo']: { voice_audioSec: 72000 } };
  b = await VI._checkBudget(db, 'paidCo', 'starter');
  ok('starter, 72,000 s this month → over', b.audioOver === true, b);
  docs = { ['api_usage_daily/' + DAY + '__co__paidCo']: { voice_claudeCalls: 200 } };
  b = await VI._checkBudget(db, 'paidCo', 'starter');
  ok('200 voice Claude calls today → claudeOver (default daily cap 200)', b.claudeOver === true && b.overBudget === true && b.claudeCap === 200, b);
  docs = { ['api_usage_daily/' + DAY + '__co__paidCo']: { voice_claudeCalls: 199 } };
  b = await VI._checkBudget(db, 'paidCo', 'starter');
  ok('199 → still under', b.claudeOver === false && b.overBudget === false, b);
  b = await VI._checkBudget(db, 'paidCo', 'constructor');
  ok('an unknown plan name (even a prototype key) gets the default cap', b.cap === 72000, b);
  b = await VI._checkBudget(db, 'paidCo', 'enterprise');
  ok('an unlisted PAID plan (enterprise) gets the Starter allowance, not the free hour', b.cap === 72000, b);

  console.log('\n2. incrementVoiceUsage feeds both counters');
  docs = {}; writes.length = 0;
  await VI._incrementVoiceUsage(db, { uid: 'paidRep', companyId: 'paidCo', audioSec: 30, analysisTokens: 900, costCents: 1, claudeCalls: 2 });
  const mon = docs['api_usage_monthly/' + MONTH + '__co__paidCo'];
  const day = docs['api_usage_daily/' + DAY + '__co__paidCo'];
  ok('the monthly company doc gets the audio seconds and Claude calls', mon && mon.voice_audioSec === 30 && mon.voice_claudeCalls === 2, mon);
  ok('the daily company doc gets the Claude calls (what the cap reads)', day && day.voice_claudeCalls === 2 && day.voice_audioSec === 30, day);
  await VI._incrementVoiceUsage(db, { uid: 'paidRep', companyId: 'paidCo', audioSec: 10, analysisTokens: 0, costCents: 0 });
  ok('a call without claudeCalls adds 0 calls, still adds audio', docs['api_usage_monthly/' + MONTH + '__co__paidCo'].voice_claudeCalls === 2 && docs['api_usage_monthly/' + MONTH + '__co__paidCo'].voice_audioSec === 40);

  console.log('\n3. the plan is the company\'s');
  docs = { 'users/paidRep': { companyId: 'paidCo' }, 'subscriptions/paidCo': { plan: 'growth', status: 'active' }, 'subscriptions/paidRep': { plan: 'free' } };
  const ctx = await VI._getCompanyContext(db, 'paidRep');
  ok('a paying tenant\'s rep gets the company\'s plan, not the free tier', ctx.companyId === 'paidCo' && ctx.plan === 'growth', ctx);
  docs = { ['users/' + NBD]: { companyId: NBD } };
  const nbdCtx = await VI._getCompanyContext(db, NBD);
  ok('NBD\'s own company with no subscription doc gets the top voice tier, not 1 hr/month', nbdCtx.plan === 'professional', nbdCtx);
  {
    const src = require('fs').readFileSync(path.join(ROOT, 'functions', 'visit-capture.js'), 'utf8');
    ok('the walkthrough budget gives NBD the same top tier', /if \(companyId === require\('\.\/ai-gate'\)\.PLATFORM_UID && \(plan === 'lite' \|\| plan === 'free'\)\) plan = 'professional';/.test(src));
  }

  console.log('\n4. processRecording refuses free / unconfirmed uploaders before any spend');
  async function upload(uid, companyId) {
    docs = {
      ['users/' + uid]: { companyId },
      ['leads/L1']: { userId: uid, companyId },
      'subscriptions/paidCo': { plan: 'pro', status: 'active' },
      'subscriptions/freeCo': { plan: 'free', status: 'none' },
    };
    writes.length = 0; spend.download = 0; spend.fetch = 0;
    const r = await VI._processRecording({ uid, leadId: 'L1', recordingId: 'R1', path: 'audio/' + uid + '/L1/R1.webm', contentType: 'audio/webm', size: 5, forceReanalyze: false });
    return { r, rec: docs['leads/L1/recordings/R1'] };
  }
  let u = await upload('freeOwner', 'freeCo');
  ok('free owner: skipped as not_entitled', u.r && u.r.skipped === 'not_entitled', u.r);
  ok('…a failed doc that says it is a paid feature (the page stops waiting)', u.rec && u.rec.status === 'failed' && /paid plans/.test(u.rec.statusError), u.rec);
  ok('…no audio read, no Groq or Claude call', spend.download === 0 && spend.fetch === 0, spend);
  u = await upload('unconfirmedRep', 'paidCo');
  ok('unconfirmed email on a paid company: refused, says confirm your email', u.r && u.r.skipped === 'not_entitled' && /Confirm your email/.test(u.rec.statusError) && spend.fetch === 0, u.rec);
  u = await upload('paidRep', 'paidCo');
  ok('paying rep: past the gate (goes on to transcription)', u.r && u.r.skipped !== 'not_entitled' && (spend.download > 0 || spend.fetch > 0), Object.assign({ spend }, u.r));
  u = await upload(NBD, NBD);
  ok('NBD itself (no subscription doc): past the gate', u.r && u.r.skipped !== 'not_entitled', u.r);
  docs = { 'users/paidRep': { companyId: 'paidCo' }, 'leads/L1': { userId: 'paidRep', companyId: 'paidCo' }, 'subscriptions/paidCo': { plan: 'pro', status: 'active' }, ['api_usage_daily/' + DAY + '__co__paidCo']: { voice_claudeCalls: 500 } };
  spend.download = 0; spend.fetch = 0;
  const r2 = await VI._processRecording({ uid: 'paidRep', leadId: 'L1', recordingId: 'R2', path: 'audio/paidRep/L1/R2.webm', contentType: 'audio/webm', size: 5, forceReanalyze: false });
  ok('paying company over its daily voice Claude cap: skipped over_budget, no spend, says try tomorrow', r2.skipped === 'over_budget' && spend.fetch === 0 && /daily limit/.test(docs['leads/L1/recordings/R2'].statusError), docs['leads/L1/recordings/R2']);

  console.log('\n4b. a blip is not a refusal');
  {
    const realGetUser = STUBS['firebase-admin/auth'].getAuth;
    let n = 0;
    STUBS['firebase-admin/auth'].getAuth = () => ({ getUser: async (x) => { n++; if (n === 1) throw new Error('auth blip'); return users[x]; } });
    const r = await upload('paidRep', 'paidCo');
    ok('one failed Auth lookup is re-checked; the paying rep is processed', n === 2 && r.r && r.r.skipped !== 'not_entitled', Object.assign({ n }, r.r));
    STUBS['firebase-admin/auth'].getAuth = realGetUser;
  }
  {
    const realDoc = db.doc;
    docs = { 'users/paidRep': { companyId: 'paidCo' }, 'subscriptions/paidCo': { plan: 'pro', status: 'active' }, ['api_usage_monthly/' + MONTH + '__co__paidCo']: { voice_audioSec: 999999 } };
    const ctxOk = await VI._getCompanyContext(db, 'paidRep');
    db.doc = (p) => (p === 'subscriptions/paidCo' ? { get: async () => { throw new Error('read failed'); } } : realDoc(p));
    const ctxFail = await VI._getCompanyContext(db, 'paidRep');
    db.doc = realDoc;
    ok('a failed plan read is flagged (not silently the free tier)', ctxOk.planReadFailed !== true && ctxFail.planReadFailed === true, ctxFail);
  }

  console.log('\n5. the upload trigger has an instance cap');
  const opts = VI.onAudioUploaded && VI.onAudioUploaded.__opts;
  ok('onAudioUploaded maxInstances is set (≤ 10)', opts && opts.maxInstances > 0 && opts.maxInstances <= 10, opts && opts.maxInstances);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
