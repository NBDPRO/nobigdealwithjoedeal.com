/**
 * tests/adminai-paid-gate-2026-11-14.test.js
 *
 * adminAI (functions/handlers/ai.js) admits company_admin and manager, and
 * createCompany makes every self-serve signup company_admin of its own
 * company. Before 2026-11-14 it had no email-verified or paid-plan gate, so
 * any free account was a 60-call/hour Anthropic proxy on the platform key.
 * It must apply claudeProxy's gates (verified email + a paid plan on the
 * caller's company, platform admin and platform tenant exempt) BEFORE the
 * vendor fetch.
 *
 * 2026-11-25 (roadmap step 12): both now call the one AI gate
 * (functions/ai-gate.js aiGate), so this suite runs the real handler over
 * stubs instead of pinning the old inline copy's source text.
 *
 * Run: node tests/adminai-paid-gate-2026-11-14.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); failed++; fails.push(label); }
}

const SUBS = {
  paidCo: { plan: 'growth', status: 'active' },
  freeCo: { plan: 'free', status: 'none' },
  lapsedCo: { plan: 'growth', status: 'canceled' },
};
let subsDown = false;
const db = {
  doc: (p) => ({
    get: async () => {
      if (subsDown && /^subscriptions\//.test(p)) throw new Error('firestore down');
      const id = p.split('/')[1];
      return { exists: /^subscriptions\//.test(p) && Object.prototype.hasOwnProperty.call(SUBS, id), data: () => SUBS[id] };
    },
  }),
};
let fetches = 0;
const STUBS = {
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError: Error },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'test-key' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n } },
  '../integrations/upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => {} },
  '../integrations/killswitch': { isAiDisabled: async () => false },
  './integrations/killswitch': { getFlags: async () => ({}) },
  '../ai-spend': { recordAiSpend: async () => {}, rowFromAnthropic: () => ({}) },
  '../rate-limit-policy': { guardHttp: (name, h) => h },
  '../shared': { requireAuth: async (req) => ({ decoded: req.__decoded }) },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
global.fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }) }; };

const handler = require(path.join(ROOT, 'functions', 'handlers', 'ai.js')).adminAI.__handler;
const NBD = require(path.join(ROOT, 'functions', 'ai-gate.js')).PLATFORM_UID;
async function post(decoded) {
  fetches = 0;
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', body: { prompt: 'summarize this' }, headers: {}, __decoded: decoded }, res);
  return { code: res.code, body: res.body, fetches };
}

(async () => {
  console.log('\nadminAI gates (real handler, stubbed Firestore and vendor)');
  const cases = [
    ['a sales_rep (role gate) → 403', { uid: 'r1', role: 'sales_rep', companyId: 'paidCo', email_verified: true }, 403],
    ['a free company_admin → 403', { uid: 'c1', role: 'company_admin', companyId: 'freeCo', email_verified: true }, 403],
    ['a lapsed (canceled) plan → 403', { uid: 'c2', role: 'company_admin', companyId: 'lapsedCo', email_verified: true }, 403],
    ['a paid company_admin with an UNconfirmed email → 403', { uid: 'c3', role: 'company_admin', companyId: 'paidCo', email_verified: false }, 403],
    ['a paid, confirmed company_admin → the model runs', { uid: 'c4', role: 'company_admin', companyId: 'paidCo', email_verified: true }, 200],
    ['a manager reads the COMPANY plan, not their own uid → the model runs', { uid: 'm1', role: 'manager', companyId: 'paidCo', email_verified: true }, 200],
    ['the platform admin (no plan) → the model runs', { uid: 'a1', role: 'admin' }, 200],
    ['the platform tenant (no subscription doc) → the model runs', { uid: 'n1', role: 'company_admin', companyId: NBD }, 200],
  ];
  for (const [label, decoded, want] of cases) {
    const r = await post(decoded);
    ok(label, r.code === want && r.fetches === (want === 200 ? 1 : 0), r);
  }
  subsDown = true;
  const down = await post({ uid: 'c5', role: 'company_admin', companyId: 'paidCo', email_verified: true });
  ok('a failed plan read fails closed (503), no model call', down.code === 503 && down.fetches === 0, down);
  subsDown = false;

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
