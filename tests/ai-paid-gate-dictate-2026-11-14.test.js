/**
 * tests/ai-paid-gate-dictate-2026-11-14.test.js
 *
 * Round-2 AI audit (2026-11-14), F2 + the shared gate.
 * Joe's rule: free accounts get NO AI. Every AI feature needs a paid plan
 * AND a confirmed email; the platform admin and NBD's own company are
 * exempt. functions/ai-gate.js holds that rule once.
 *
 *   1. ai-gate.js: the rule, for a token and for a uid (Auth record), and a
 *      failed plan / user read fails closed.
 *   2. dictate (functions/dictate.js) runs for real against stubs: a free or
 *      unconfirmed account, or a viewer, is refused BEFORE the rate limit and
 *      before any Groq / Anthropic call; a paid, confirmed account and NBD
 *      itself get through the gate.
 *
 * Run: node tests/ai-paid-gate-dictate-2026-11-14.test.js
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
function makeDb(subs, opts) {
  const reads = [];
  return {
    reads,
    doc(p) {
      return {
        get: async () => {
          reads.push(p);
          if (opts && opts.throwOn && opts.throwOn.test(p)) throw new Error('firestore down');
          const id = p.split('/')[1];
          return { exists: Object.prototype.hasOwnProperty.call(subs, id), data: () => subs[id] };
        },
      };
    },
  };
}
const SUBS = {
  paidCo: { plan: 'pro', status: 'active' },
  trialCo: { plan: 'pro', status: 'trialing' },
  freeCo: { plan: 'free', status: 'none' },
  lapsedCo: { plan: 'pro', status: 'canceled' },
  soloPaid: { plan: 'starter', status: 'active' },
  codeExpired: { plan: 'growth', status: 'active', source: 'access_code', trialEndsAt: { toMillis: () => Date.now() - 86_400_000 } },
  codeLive: { plan: 'growth', status: 'active', source: 'access_code', trialEndsAt: { toMillis: () => Date.now() + 86_400_000 } },
  codeComp: { plan: 'growth', status: 'active', source: 'access_code' },
};

(async () => {
  console.log('\n1. ai-gate.js');
  let G = null;
  try { G = require(path.join(ROOT, 'functions', 'ai-gate.js')); } catch (e) { ok('functions/ai-gate.js exists', false, e.message); }
  if (G) {
    const db = makeDb(SUBS);
    const cases = [
      ['platform admin, unverified, no plan', { role: 'admin' }, 'u1', true],
      ['NBD itself (uid), no subscription doc', { email_verified: false }, NBD, true],
      ['an NBD rep (companyId = NBD), no subscription doc', { companyId: NBD, email_verified: true }, 'rep1', true],
      ['paid company, confirmed email', { companyId: 'paidCo', email_verified: true }, 'u2', true],
      ['trialing company, confirmed email', { companyId: 'trialCo', email_verified: true }, 'u3', true],
      ['solo owner (no companyId) on a paid plan', { email_verified: true }, 'soloPaid', true],
      ['paid company, UNconfirmed email', { companyId: 'paidCo', email_verified: false }, 'u4', false, 'unverified'],
      ['free company, confirmed email', { companyId: 'freeCo', email_verified: true }, 'u5', false, 'plan'],
      ['lapsed (canceled) plan', { companyId: 'lapsedCo', email_verified: true }, 'u6', false, 'plan'],
      ['no subscription doc at all', { companyId: 'ghostCo', email_verified: true }, 'u7', false, 'plan'],
      ['company_admin role is NOT an exemption', { role: 'company_admin', companyId: 'freeCo', email_verified: true }, 'u8', false, 'plan'],
      ['the plan is the COMPANY\'s, not the user\'s own uid', { companyId: 'freeCo', email_verified: true }, 'soloPaid', false, 'plan'],
      ['an access-code trial past its end date is free', { companyId: 'codeExpired', email_verified: true }, 'u10', false, 'plan'],
      ['an access-code trial still running is allowed', { companyId: 'codeLive', email_verified: true }, 'u11', true],
      ['an access-code comp with no end date is allowed', { companyId: 'codeComp', email_verified: true }, 'u12', true],
    ];
    for (const [label, claims, uid, want, reason] of cases) {
      const r = await G.aiEntitlement(db, claims, uid);
      ok(label + ' → ' + (want ? 'allowed' : 'refused (' + reason + ')'), r.ok === want && (want || r.reason === reason), r);
    }
    const down = makeDb(SUBS, { throwOn: /subscriptions/ });
    const r1 = await G.aiEntitlement(down, { companyId: 'paidCo', email_verified: true }, 'u9');
    ok('a failed plan read fails closed', r1.ok === false && r1.reason === 'plan_check_failed', r1);

    const users = {
      paidRep: { emailVerified: true, customClaims: { companyId: 'paidCo', role: 'sales_rep' } },
      freeOwner: { emailVerified: true, customClaims: { companyId: 'freeCo', role: 'company_admin' } },
      unconfirmed: { emailVerified: false, customClaims: { companyId: 'paidCo' } },
      disabledRep: { emailVerified: true, disabled: true, customClaims: { companyId: 'paidCo', role: 'sales_rep' } },
      [NBD]: { emailVerified: true, customClaims: {} },
    };
    const getUser = async (u) => { if (!users[u]) throw new Error('auth/user-not-found'); return users[u]; };
    const byUid = async (u) => G.aiEntitlementForUid(db, u, { getUser });
    ok('by uid: a paid company\'s rep → allowed', (await byUid('paidRep')).ok === true);
    ok('by uid: a free owner → refused', (await byUid('freeOwner')).ok === false);
    ok('by uid: unconfirmed email → refused', (await byUid('unconfirmed')).reason === 'unverified');
    ok('by uid: NBD → allowed', (await byUid(NBD)).ok === true);
    ok('by uid: a disabled (deactivated) rep of a paid company → refused', (await byUid('disabledRep')).ok === false);
    ok('by uid: a failed Auth lookup fails closed', (await byUid('nobody')).reason === 'plan_check_failed');
  }

  console.log('\n2. dictate');
  class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const seen = { rate: 0, groq: 0, fetch: 0 };
  let db = makeDb(SUBS);
  const STUBS = {
    'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k' }) },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => ({}), increment: (n) => n } },
    './integrations/_shared': { SECRETS: { GROQ_API_KEY: { name: 'GROQ_API_KEY' } }, hasSecret: () => true, secretValue: () => 'k' },
    './integrations/voice-intelligence': { transcribeGroqBuffer: async () => { seen.groq++; return { text: 'hello' }; } },
    './integrations/killswitch': { isAiDisabled: async () => false },
    './integrations/upstash-ratelimit': { enforceRateLimit: async () => { seen.rate++; } },
    './ai-spend': { recordAiSpend: async () => {}, rowFromAnthropic: () => ({}) },
  };
  const realLoad = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return realLoad.apply(this, arguments);
  };
  global.fetch = async () => { seen.fetch++; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'x' }], usage: {} }) }; };
  const dictate = require(path.join(ROOT, 'functions', 'dictate.js')).dictate.__handler;

  async function call(uid, token) {
    seen.rate = 0; seen.groq = 0; seen.fetch = 0;
    try { await dictate({ auth: { uid, token: Object.assign({ uid }, token) }, data: { audioBase64: '', mimeType: 'audio/webm' } }); return { code: 'ok' }; }
    catch (e) { return { code: e.code, msg: e.message }; }
  }
  for (const [label, uid, token, wantCode] of [
    ['free account, confirmed email', 'u5', { companyId: 'freeCo', email_verified: true, role: 'company_admin' }, 'permission-denied'],
    ['paid company, unconfirmed email', 'u4', { companyId: 'paidCo', email_verified: false, role: 'sales_rep' }, 'permission-denied'],
    ['viewer on a free company', 'v1', { companyId: 'freeCo', email_verified: true, role: 'viewer' }, 'permission-denied'],
  ]) {
    const r = await call(uid, token);
    ok('dictate: ' + label + ' → ' + wantCode, r.code === wantCode, r);
    ok('dictate: ' + label + ' → refused before the rate limit and any model call', seen.rate === 0 && seen.groq === 0 && seen.fetch === 0, seen);
  }
  const free = await call('u5', { companyId: 'freeCo', email_verified: true, role: 'company_admin' });
  ok('dictate: the free-plan refusal says it is a paid feature', /paid plan/i.test(free.msg || ''), free.msg);
  db = makeDb(SUBS, { throwOn: /subscriptions/ });
  const outage = await call('u2', { companyId: 'paidCo', email_verified: true, role: 'sales_rep' });
  ok('dictate: a failed plan read refuses (unavailable), no model call', outage.code === 'unavailable' && seen.groq === 0 && seen.fetch === 0, outage);
  db = makeDb(SUBS);
  for (const [label, uid, token] of [
    ['paid company, confirmed email', 'u2', { companyId: 'paidCo', email_verified: true, role: 'sales_rep' }],
    ['NBD itself, no subscription doc', NBD, { companyId: NBD, email_verified: true, role: 'company_admin' }],
    ['a viewer on a paid company (dictation writes nothing)', 'v2', { companyId: 'paidCo', email_verified: true, role: 'viewer' }],
  ]) {
    const r = await call(uid, token);
    ok('dictate: ' + label + ' → past the gate (rate limit counted; then the empty audio is refused)', seen.rate === 1 && r.code !== 'permission-denied' && r.code !== 'unavailable', Object.assign({ seen }, r));
  }

  console.log('\n3. transcribeVoiceMemo (nbd-whisper\'s fallback path) carries the same gate');
  STUBS['./killswitch'] = STUBS['./integrations/killswitch'];
  STUBS['./upstash-ratelimit'] = STUBS['./integrations/upstash-ratelimit'];
  STUBS['./_shared'] = STUBS['./integrations/_shared'];
  STUBS['./voice-intelligence'] = STUBS['./integrations/voice-intelligence'];
  const memo = require(path.join(ROOT, 'functions', 'integrations', 'voice-memo.js')).transcribeVoiceMemo.__handler;
  async function callMemo(uid, token) {
    seen.rate = 0; seen.fetch = 0;
    try { await memo({ auth: { uid, token: Object.assign({ uid }, token) }, data: { audioBase64: '', mimeType: 'audio/webm' } }); return { code: 'ok' }; }
    catch (e) { return { code: e.code, msg: e.message }; }
  }
  let m = await callMemo('u5', { companyId: 'freeCo', email_verified: true, role: 'company_admin' });
  ok('transcribeVoiceMemo: free account → permission-denied before the rate limit', m.code === 'permission-denied' && seen.rate === 0, Object.assign({ seen }, m));
  m = await callMemo('u4', { companyId: 'paidCo', email_verified: false });
  ok('transcribeVoiceMemo: unconfirmed email → permission-denied', m.code === 'permission-denied' && seen.rate === 0, m);
  m = await callMemo('u2', { companyId: 'paidCo', email_verified: true, role: 'sales_rep' });
  ok('transcribeVoiceMemo: paid + confirmed → past the gate', seen.rate === 1 && m.code === 'invalid-argument', Object.assign({ seen }, m));

  console.log('\n4. nbd-whisper does not fall back to transcription when dictate refuses on plan');
  {
    const vm = require('vm');
    const src = require('fs').readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'nbd-whisper.js'), 'utf8');
    const at = src.indexOf('async function _dictate(');
    let depth = 0, i = src.indexOf('{', at);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    const runWith = async (err) => {
      let fellBack = 0;
      const ctx = {
        console: { warn() {} }, Date,
        window: { _functions: {}, _httpsCallable: () => async () => { throw err; } },
        _ensureCallable: async () => {}, _blobToBase64: async () => 'AAAA',
        _dictateFallback: async () => { fellBack++; return { cleaned: 'fallback' }; },
      };
      vm.createContext(ctx);
      vm.runInContext(src.slice(at, i + 1), ctx);
      let thrown = null;
      try { await ctx._dictate({ type: 'audio/webm' }, {}); } catch (e) { thrown = e; }
      return { fellBack, thrown };
    };
    const denied = Object.assign(new Error('AI features are part of the paid plans. Upgrade to use them.'), { code: 'functions/permission-denied' });
    let r = await runWith(denied);
    ok('a permission-denied from dictate is shown, not retried through the fallback', at !== -1 && r.fellBack === 0 && r.thrown === denied, { fellBack: r.fellBack });
    r = await runWith(Object.assign(new Error('Could not check your plan.'), { code: 'functions/unavailable' }));
    ok('…same for unavailable (plan check down)', r.fellBack === 0 && !!r.thrown);
    r = await runWith(Object.assign(new Error('not found'), { code: 'functions/not-found' }));
    ok('a missing deploy (not-found) still falls back as before', r.fellBack === 1 && !r.thrown);
  }

  console.log('\n5. the other mics show the plan message, not "transcription failed"');
  {
    const fs = require('fs');
    const ui = fs.readFileSync(path.join(ROOT, 'docs/pro/js/ui.js'), 'utf8');
    ok('docs/pro/js/ui.js: permission-denied / unavailable show the server\'s message',
      ui.includes("if ((code === 'permission-denied' || code === 'unavailable') && e.message) { _cmdResetMic(e.message); return; }"));
    const vmail = fs.readFileSync(path.join(ROOT, 'docs/pro/js/voicemail.js'), 'utf8');
    ok('docs/pro/js/voicemail.js: permission-denied / unavailable show the server\'s message',
      vmail.includes("const planRefusal = (code === 'permission-denied' || code === 'unavailable') && e.message;")
      && vmail.includes('showError(planRefusal ? e.message : '));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
