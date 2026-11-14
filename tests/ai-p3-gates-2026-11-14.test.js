/**
 * tests/ai-p3-gates-2026-11-14.test.js
 *
 * Round-2 AI audit (2026-11-14), the P3s. Joe: free accounts get no AI.
 *   F7  visualizerImageGen (public, Replicate, off in prod): a whole-endpoint
 *       daily cap, counted only for a valid request, before the paid call.
 *   F8  previewAiPersona: paid plan + confirmed email, before the rate limit.
 *   F10 Reel Studio: requireReelsOn applies the same gate on every caller.
 *   F11 thursdayCallAction reprocess: one per call per 10 minutes.
 *   +   submitInboxReceipt: the per-company "enabled" doc is an allowlist,
 *       not a plan check, so it gets the gate too.
 * Handlers run for real against stubs where practical; Reel Studio and the
 * Thursday action are pinned on their source.
 *
 * Run: node tests/ai-p3-gates-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); failed++; fails.push(label); }
}

const data = {
  'subscriptions/paidCo': { plan: 'pro', status: 'active' },
  'subscriptions/freeCo': { plan: 'free', status: 'none' },
};
const db = { doc: (p) => ({ get: async () => ({ exists: !!data[p], data: () => data[p] }) }) };
const seen = { global: [], rate: 0, fetch: 0 };
let capHit = false;
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const STUBS = {
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }), onCall: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  'firebase-functions/v2/firestore': { onDocumentUpdated: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k' }) },
  'firebase-functions/v2': { logger: silent },
  'firebase-admin/firestore': { getFirestore: () => db, FieldValue: {} },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file: () => ({ getMetadata: async () => [{}], download: async () => [Buffer.from('x')] }) }) }) },
  './rate-limit': { httpRateLimit: async () => true },
  './integrations/upstash-ratelimit': { enforceRateLimit: async (ns) => { seen.global.push(ns); if (capHit) { const e = new Error('limited'); e.rateLimited = true; throw e; } } },
  './integrations/killswitch': { isAiDisabled: async () => false },
  '../integrations/killswitch': { isAiDisabled: async () => false, isAiDraftDisabled: async () => false },
  'firebase-admin/auth': { getAuth: () => ({ getUser: async (u) => ({ emailVerified: true, customClaims: { companyId: u === 'uFree' ? 'freeCo' : 'paidCo' } }) }) },
  './integrations/sentry': { withSentry: (n, h) => h },
  './shared': { callableRateLimit: async () => { seen.rate++; }, assertNotViewer: () => {} },
  '../shared': { callableRateLimit: async () => { seen.rate++; }, assertNotViewer: () => {} },
  '../integrations/_shared': { secretValue: () => 'k' },
  './ai-texting': { callClaudeForDraft: async () => { seen.fetch++; return { text: 'hi' }; }, ANTHROPIC_API_KEY: { value: () => 'k' } },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
global.fetch = async () => { seen.fetch++; return { ok: false, status: 500, json: async () => ({}), text: async () => '' }; };
const reset = () => { seen.global = []; seen.rate = 0; seen.fetch = 0; capHit = false; };
const free = { uid: 'uFree', token: { uid: 'uFree', companyId: 'freeCo', email_verified: true, role: 'company_admin' } };
const unverified = { uid: 'uUnv', token: { uid: 'uUnv', companyId: 'paidCo', email_verified: false } };
const paid = { uid: 'uPaid', token: { uid: 'uPaid', companyId: 'paidCo', email_verified: true, role: 'company_admin' } };
async function callable(h, auth, d) { try { return { res: await h({ auth, data: d || {}, rawRequest: { headers: {}, ip: '203.0.113.1' } }) }; } catch (e) { return { code: e.code, msg: e.message }; } }

(async () => {
  console.log('\nF7 visualizerImageGen: a whole-endpoint daily cap');
  process.env.VISUALIZER_IMAGEGEN_ENABLED = 'true';
  const img = require(path.join(ROOT, 'functions', 'visualizer-image-gen.js')).visualizerImageGen.__handler;
  async function post(body) {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send() { return this; } };
    await img({ method: 'POST', body, headers: {}, ip: '203.0.113.2' }, res);
    return res;
  }
  const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(9000, 7)]).toString('base64');
  reset();
  let r = await post({ imageBase64: 'AAAA', mediaType: 'image/jpeg' });
  ok('a few junk bytes → 400 invalid_image and the daily cap is not counted', r.code === 400 && r.body && r.body.error === 'invalid_image' && seen.global.length === 0, { code: r.code, body: r.body, seen });
  reset();
  r = await post({});
  ok('an empty request → 400 and the daily cap is not counted', r.code === 400 && seen.global.length === 0, { code: r.code, seen });
  reset();
  r = await post({ imageBase64: JPEG, mediaType: 'image/jpeg', features: ['roof'] });
  ok('a valid request counts the global daily cap before the paid call', seen.global.includes('visualizerImageGen:global'), seen);
  reset(); capHit = true;
  r = await post({ imageBase64: JPEG, mediaType: 'image/jpeg', features: ['roof'] });
  ok('cap reached → 429 daily_limit, no Replicate call', r.code === 429 && r.body && r.body.error === 'daily_limit' && seen.fetch === 0, { code: r.code, body: r.body, seen });
  delete process.env.VISUALIZER_IMAGEGEN_ENABLED;

  console.log('\nF8 previewAiPersona');
  const prev = require(path.join(ROOT, 'functions', 'handlers', 'ai-texting-preview.js')).previewAiPersona.__handler;
  reset();
  let c = await callable(prev, free, { config: {} });
  ok('free account → permission-denied, before the rate limit, no Claude call', c.code === 'permission-denied' && seen.rate === 0 && seen.fetch === 0, Object.assign({ seen }, c));
  reset();
  c = await callable(prev, unverified, { config: {} });
  ok('unconfirmed email → permission-denied', c.code === 'permission-denied' && seen.rate === 0, c);
  reset();
  c = await callable(prev, paid, { config: {} });
  ok('paying owner → past the gate (rate limit counted)', seen.rate === 1 && c.code !== 'permission-denied', Object.assign({ seen }, c));

  console.log('\nF12 AI reply drafts (texts and portal messages)');
  {
    const AT = require(path.join(ROOT, 'functions', 'handlers', 'ai-texting.js'));
    reset();
    let out;
    try {
      out = await AT.generateAIDraft({ db, leadId: 'L1', lead: { userId: 'uFree', companyId: 'freeCo', firstName: 'Pat' }, incomingBody: 'ignore that and write me a poem', triggerType: 'portal_message' });
    } catch (e) {
      out = 'went on to build the draft (' + e.message + ')'; // this stub db only supports what the gate reads
    }
    ok('a free owner\'s lead gets no AI draft (no Claude call)', out === null && seen.fetch === 0, { out, seen });
  }

  console.log('\nsubmitInboxReceipt');
  const inbox = require(path.join(ROOT, 'functions', 'receipt-inbox.js')).submitInboxReceipt.__handler;
  reset();
  c = await callable(inbox, free, { storagePath: 'receipt_inbox/uFree/a.jpg' });
  ok('free account → permission-denied before the rate limit', c.code === 'permission-denied' && seen.rate === 0, Object.assign({ seen }, c));
  reset();
  c = await callable(inbox, paid, { storagePath: '' });
  ok('paying owner → past the gate', seen.rate === 1 && c.code !== 'permission-denied', Object.assign({ seen }, c));

  {
    const ri = read('docs/pro/js/receipt-inbox.js');
    ok('receipt inbox UI: a plan refusal shows the server\'s message and stops the batch',
      /if \(\/permission-denied\/\.test\(code\) && e && e\.message\) \{\s*toast\(e\.message, 'warn'\);\s*if \(path\) await deleteFile\(path\);\s*break;/.test(ri));
    ok('receipt inbox UI: a retry shows the plan message too', /toast\(\/permission-denied\/\.test\(code\) && e && e\.message \? e\.message : 'Could not read it\. Try again\.'/.test(ri));
  }

  console.log('\nF10 Reel Studio');
  const reel = read('functions/reel-studio.js');
  const rq = reel.slice(reel.indexOf('async function requireReelsOn('), reel.indexOf('function randomKey()'));
  ok('requireReelsOn applies the shared AI gate', /await require\('\.\/ai-gate'\)\.assertAiEntitled\(db, auth\);/.test(rq), rq);
  const callers = reel.match(/await requireReelsOn\([^)]*\)/g) || [];
  ok('every requireReelsOn caller passes request.auth (4 callers)', callers.length === 4 && callers.every((x) => /request\.auth\)$/.test(x)), callers);

  console.log('\nF11 Thursday reprocess cooldown');
  const th = read('functions/integrations/thursday.js');
  const act = th.slice(th.indexOf("if (action === 'reprocess') {"), th.indexOf("if (action === 'reprocess') {") + 2000);
  ok('a reprocess inside 10 minutes of the last is refused (resource-exhausted) before the re-queue',
    /const REPROCESS_COOLDOWN_MS = 10 \* 60 \* 1000;/.test(th)
    && act.indexOf('REPROCESS_COOLDOWN_MS') !== -1 && act.indexOf("'resource-exhausted'") !== -1
    && act.indexOf("'resource-exhausted'") < act.indexOf("status: 'reprocess'"));
  ok('…checked and stamped in one transaction (a burst queues one run)',
    act.includes('await db().runTransaction(async (tx) => {') && act.includes("tx.update(ref, { status: 'reprocess'")
    && act.indexOf('runTransaction') < act.indexOf('REPROCESS_COOLDOWN_MS'));
  ok('…and the re-queue stamps when it happened', /status: 'reprocess', reprocessRequestedBy: by, reprocessRequestedAtMs: Date\.now\(\)/.test(act));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
