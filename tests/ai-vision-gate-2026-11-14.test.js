/**
 * tests/ai-vision-gate-2026-11-14.test.js
 *
 * Round-2 AI audit (2026-11-14), F3 + F4. Joe: free accounts get no AI.
 *   1. analyzeRoofPhoto (Sonnet vision, onRequest, no App Check): free /
 *      unconfirmed callers refused (403) before any counter; a plan-check
 *      outage is a 503; a paying caller is also counted on a PER-COMPANY
 *      daily cap.
 *   2. analyzePhotoVision (callable) and onPhotoCreatedClassify (trigger):
 *      the same gate; the trigger reads the photo owner's entitlement.
 *   3. extractReceiptData: the same gate, before the rate limit.
 *   4. The monthly vision dollar cap is per COMPANY (companyCostMeter), shared
 *      by photos and receipts, so extra seats or signups don't add budget.
 * Every handler runs for real against stubs: no Firebase, no network.
 *
 * Run: node tests/ai-vision-gate-2026-11-14.test.js
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
let data = {};
let failSubs = false;
function merge(base, patch) {
  const out = Object.assign({}, base || {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && v[INC] !== undefined) out[k] = (Number(out[k]) || 0) + v[INC];
    else if (v && v.__del) delete out[k];
    else out[k] = v;
  }
  return out;
}
function ref(p) {
  return {
    path: p, id: p.split('/').pop(),
    get: async () => {
      if (failSubs && p.startsWith('subscriptions/')) throw new Error('firestore down');
      return { exists: !!data[p], data: () => data[p], id: p.split('/').pop() };
    },
    set: async (v, o) => { data[p] = o && o.merge ? merge(data[p], v) : merge({}, v); },
    update: async (v) => { data[p] = merge(data[p], v); },
  };
}
const db = {
  doc: ref,
  collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
  runTransaction: async (fn) => fn({
    get: (r) => r.get(),
    set: (r, v, o) => { data[r.path] = o && o.merge ? merge(data[r.path], v) : merge({}, v); },
    update: (r, v) => { data[r.path] = merge(data[r.path], v); },
  }),
};
const seen = { ip: [], keys: [], fetch: 0, callableRate: 0, storage: 0 };
const tokens = {
  free: { uid: 'uFree', companyId: 'freeCo', email_verified: true, role: 'company_admin' },
  unverified: { uid: 'uUnv', companyId: 'paidCo', email_verified: false, role: 'sales_rep' },
  paid: { uid: 'uPaid', companyId: 'paidCo', email_verified: true, role: 'sales_rep' },
  nbd: { uid: NBD, companyId: NBD, email_verified: true, role: 'company_admin' },
};
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const STUBS = {
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }), onCall: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { increment: (n) => ({ [INC]: n }), serverTimestamp: () => 'TS', delete: () => ({ __del: true }) }, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
  'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: async (t) => { if (!tokens[t]) throw new Error('bad token'); return tokens[t]; } }) },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file: () => ({ getMetadata: async () => { seen.storage++; return [{ contentType: 'image/jpeg', size: 10 }]; }, download: async () => [Buffer.from('x')] }) }) }) },
  '../integrations/upstash-ratelimit': {
    httpRateLimit: async (req, res, ns) => { seen.ip.push(ns); return true; },
    enforceRateLimit: async (ns, key) => { seen.keys.push(ns + '=' + key); },
  },
  '../integrations/killswitch': { isAiDisabled: async () => false },
  './integrations/killswitch': { isAiDisabled: async () => false },
  '../ai-spend': { recordAiSpend: async () => {}, rowFromAnthropic: () => ({}) },
  './ai-spend': { recordAiSpend: async () => {}, rowFromAnthropic: () => ({}) },
  './integrations/sentry': { withSentry: (n, h) => h, captureException() {} },
  './shared': {
    callableRateLimit: async () => { seen.callableRate++; },
    assertNotViewer: (t) => { if (t && t.role === 'viewer') throw new HttpsError('permission-denied', 'view only'); },
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
global.fetch = async () => { seen.fetch++; return { ok: false, status: 500, json: async () => ({}), text: async () => '' }; };

function world() {
  failSubs = false;
  data = {
    'subscriptions/paidCo': { plan: 'starter', status: 'active' },
    'subscriptions/freeCo': { plan: 'free', status: 'none' },
    'photos/pFree': { userId: 'uFree', companyId: 'freeCo', leadId: 'L1', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg' },
    'photos/pPaid': { userId: 'uPaid', companyId: 'paidCo', leadId: 'L2', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/b.jpg' },
    'photos/pNbd': { userId: NBD, companyId: NBD, leadId: 'L3', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/c.jpg' },
  };
  seen.ip = []; seen.keys = []; seen.fetch = 0; seen.callableRate = 0; seen.storage = 0;
}

(async () => {
  console.log('\n1. analyzeRoofPhoto');
  const roof = require(path.join(ROOT, 'functions', 'handlers', 'photo.js')).analyzeRoofPhoto.__handler;
  async function postRoof(tok, photoId) {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
    await roof({ method: 'POST', headers: { authorization: 'Bearer ' + tok }, body: { photoId }, ip: '203.0.113.5' }, res);
    return res;
  }
  world();
  let r = await postRoof('free', 'pFree');
  ok('free account → 403, says it is a paid feature', r.code === 403 && /paid plans/.test(r.body && r.body.error), r);
  ok('…before the per-uid / per-company counters and any model call', seen.keys.length === 0 && seen.fetch === 0, seen);
  world();
  r = await postRoof('unverified', 'pPaid');
  ok('unconfirmed email on a paid company → 403, confirm your email', r.code === 403 && /Confirm your email/.test(r.body && r.body.error), r);
  world(); failSubs = true;
  r = await postRoof('paid', 'pPaid');
  ok('plan check down → 503, no counters, no model call', r.code === 503 && seen.keys.length === 0 && seen.fetch === 0, r);
  world();
  r = await postRoof('paid', 'pPaid');
  ok('paying rep → past the gate, counted per uid AND per company', seen.keys.includes('analyzeRoofPhoto:uid=uPaid') && seen.keys.includes('analyzeRoofPhoto:co=paidCo'), seen.keys);
  world();
  r = await postRoof('nbd', 'pNbd');
  ok('NBD (no subscription doc) → past the gate', seen.keys.includes('analyzeRoofPhoto:co=' + NBD) && r.code !== 403, r);

  console.log('\n2. photo vision: callable and trigger');
  const PV = require(path.join(ROOT, 'functions', 'photo-vision.js'));
  const pvCall = PV.analyzePhotoVision.__handler || PV.analyzePhotoVision;
  async function callPv(tok, photoId) {
    try { return { res: await pvCall({ auth: { uid: tokens[tok].uid, token: tokens[tok] }, data: { photoId } }) }; }
    catch (e) { return { code: e.code, msg: e.message }; }
  }
  world();
  let c = await callPv('free', 'pFree');
  ok('analyzePhotoVision: free account → permission-denied before the rate limit', c.code === 'permission-denied' && seen.callableRate === 0 && seen.fetch === 0, c);
  world();
  c = await callPv('unverified', 'pPaid');
  ok('analyzePhotoVision: unconfirmed email → permission-denied', c.code === 'permission-denied' && seen.fetch === 0, c);
  world();
  c = await callPv('paid', 'pPaid');
  ok('analyzePhotoVision: paying rep → past the gate (rate limit counted)', seen.callableRate === 1 && c.code !== 'permission-denied', c);

  const T = PV._test;
  const users = { uFree: false, uPaid: true };
  const entitled = async (d, u) => (users[u] ? { ok: true } : { ok: false, reason: 'plan' });
  world();
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"phase":"Before","damageType":"hail","severity":"minor","caption":"Hail marks.","confidence":0.8}' }], usage: { input_tokens: 1000, output_tokens: 100 } }) }; };
  const killOff = { isAiDisabled: async () => false };
  let t = await T.handlePhotoCreated('pFree', data['photos/pFree'], { db, killswitch: killOff, entitled, apiKey: 'k', fetchImpl });
  ok('trigger: a free owner\'s new photo is not classified (no model call)', t.skipped && t.reason === 'not-entitled' && fetches === 0, t);
  t = await T.handlePhotoCreated('pPaid', data['photos/pPaid'], { db, killswitch: killOff, entitled, apiKey: 'k', fetchImpl });
  ok('trigger: a paying owner\'s photo is classified', !!t.suggestion && fetches === 1, t);
  let who = null;
  await T.handlePhotoCreated('pPaid', Object.assign({}, data['photos/pPaid'], { aiSuggestion: null }), { db, killswitch: killOff, entitled: async (d, u) => { who = u; return { ok: false, reason: 'plan' }; }, apiKey: 'k', fetchImpl });
  ok('trigger: the entitlement checked is the photo OWNER\'s', who === 'uPaid', who);

  console.log('\n4. the monthly vision budget is per company, shared by photos and receipts');
  const month = new Date().toISOString().slice(0, 7);
  const meterKey = 'companyCostMeter/paidCo__' + month;
  ok('the classified photo was metered on the company', data[meterKey] && data[meterKey].visionUsd > 0 && data[meterKey].visionCount === 1, data[meterKey]);
  data['photos/pRep2'] = { userId: 'uRep2', companyId: 'paidCo', leadId: 'L9', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/d.jpg' };
  data[meterKey] = { visionUsd: 25 };
  users.uRep2 = true;
  fetches = 0;
  t = await T.handlePhotoCreated('pRep2', data['photos/pRep2'], { db, killswitch: killOff, entitled, apiKey: 'k', fetchImpl });
  ok('a SECOND rep of a company at its $25 Starter cap is capped too (company-cap), no model call', t.skipped && t.reason === 'company-cap' && fetches === 0, t);

  console.log('\n3. extractReceiptData');
  const RV = require(path.join(ROOT, 'functions', 'receipt-vision.js'));
  const rvCall = RV.extractReceiptData.__handler || RV.extractReceiptData;
  async function callRv(tok) {
    const uid = tokens[tok].uid;
    try { return { res: await rvCall({ auth: { uid, token: tokens[tok] }, data: { storagePath: 'receipts/' + uid + '/r1.jpg' } }) }; }
    catch (e) { return { code: e.code, msg: e.message }; }
  }
  world();
  let rr = await callRv('free');
  ok('free account → permission-denied before the rate limit and any storage read', rr.code === 'permission-denied' && seen.callableRate === 0 && seen.storage === 0, rr);
  world();
  data[meterKey] = { visionUsd: 25 };
  rr = await callRv('paid');
  ok('paying rep of a company already at its monthly vision cap (from photos) → company-cap, no storage read', rr.res && rr.res.skipped && rr.res.reason === 'company-cap' && seen.storage === 0, rr);
  world();
  rr = await callRv('paid');
  ok('paying rep under the cap → reads the receipt (goes on to the model)', seen.callableRate === 1 && seen.storage === 1, Object.assign({ seen }, rr));

  console.log('\n5. the CRM names the new cap');
  const fs = require('fs');
  ok('expenses.js shows the monthly-limit message for company-cap', /reason === 'company-cap'/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/js/expenses.js'), 'utf8')));
  ok('photo-engine.js names company-cap in its cap toast', /capReason === 'company-cap'/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/js/photo-engine.js'), 'utf8')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
