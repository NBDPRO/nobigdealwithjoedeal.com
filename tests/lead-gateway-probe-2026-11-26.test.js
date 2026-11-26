/**
 * tests/lead-gateway-probe-2026-11-26.test.js
 *
 * Daily lead-gateway probe (outage follow-up item 5, Joe 2026-11-26).
 * From 2026-10-13 to 2026-11-25 every website lead form got 403 and nothing
 * said so, because the only alarms fire on a real submit and the site gets a
 * few a month. leadGatewayProbe (functions/lead-gateway-probe.js) posts one
 * probe per lead kind to the LIVE submitPublicLead every morning; the gateway
 * runs every gate a real submit runs and answers 200 { probe: true } WITHOUT
 * storing anything.
 *
 * What this suite proves:
 *   A  probe mode: a verified probe runs the per-IP limiter, the Turnstile
 *      posture check and the field validation, then stores NOTHING, reads no
 *      tenant registry and touches no flood/duplicate bucket; every kind's
 *      probe body passes the REAL validation; a bad probe body still 400s.
 *   B  a request that only CLAIMS to be the probe (header, no valid Google ID
 *      token from this project's own service account) gets 403, nothing stored.
 *   C  a gateway WITHOUT probe support meets the probe body's honeypot
 *      sentinel and pretends success without storing (deploy-skew safety).
 *   D  turnstilePosture: the 2026-10-13 stub-secret posture fails; a real
 *      secret is checked against Cloudflare with a dummy token.
 *   E  verifyProbeCaller: only this service account's verified ID token.
 *   F  the cron: a non-probe answer, a 403, a missing CORS header each fail;
 *      the quiet-leads notice fires once per 14-day silence.
 *   G  wiring: exported, documented, owner alert at 'alert' severity.
 *
 * Synthetic data only; nothing is sent anywhere.
 * Run: node tests/lead-gateway-probe-2026-11-26.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const F = (rel) => path.join(ROOT, 'functions', rel);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const realLoad = Module._load;
let stubs = null;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) { delete require.cache[file]; return require(file); }

const noopLogger = { info() {}, warn() {}, error() {} };
const baseStubs = () => ({
  './messaging-controls': require('./lib/messaging-controls-stub'),
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }), onCall: (o, h) => ({ __opts: o, __handler: h }), HttpsError: class extends Error {} },
  'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
  'firebase-functions/v2': { logger: noopLogger },
});
function mkRes() {
  return { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
}

(async () => {
  let Probe = null, Auth = null;
  try { Auth = require(F('lead-probe-auth.js')); } catch (e) { ok('functions/lead-probe-auth.js loads', false, e.message); }
  try { Probe = require(F('lead-gateway-probe.js')); } catch (e) { ok('functions/lead-gateway-probe.js loads', false, e.message); }
  const P = Probe && Probe._internal;

  // ── gateway harness ──────────────────────────────────────────────────
  const GW = F('handlers/integrations.js');
  function gateway(opts) {
    const o = opts || {};
    const added = [], reads = [], limiterCalls = [], tsCalls = [];
    stubs = Object.assign(baseStubs(), {
      'firebase-admin/firestore': {
        getFirestore: () => ({
          collection: (name) => ({
            add: async (row) => { added.push({ name, row }); return { id: 'doc-' + added.length }; },
            doc: (id) => ({ get: async () => { reads.push(name + '/' + id); return { exists: true }; } }),
          }),
        }),
        FieldValue: { serverTimestamp: () => '__server_ts__' },
      },
      '../integrations/upstash-ratelimit': {
        enforceRateLimit: async (ns, key, limit, win) => { limiterCalls.push(ns); return {}; },
        httpRateLimit: async () => true, clientIp: () => '198.51.100.7', provider: 'stub',
      },
      '../integrations/turnstile': {
        verifyTurnstile: async () => { tsCalls.push('verify'); return { ok: true, configured: false }; },
        turnstilePosture: async () => { tsCalls.push('posture'); return o.posture || { ok: true, configured: false }; },
      },
    });
    const mod = fresh(GW);
    stubs = null;
    const submit = async (kind, body, headers) => {
      const res = mkRes();
      const before = added.length;
      await mod.submitPublicLead.__handler({ method: 'POST', headers: headers || {}, body: Object.assign({ kind }, body) }, res);
      return { res, stored: added.length > before };
    };
    return { submit, added, reads, limiterCalls, tsCalls, spec: mod._publicLeadSpec };
  }
  const PROBE_HEADERS = { 'x-nbd-lead-probe': '1', 'x-nbd-probe-token': 'tok-valid' };

  // ════════════════════════════════════════════════════════════════════
  console.log('\nA — probe mode runs every gate and stores nothing');
  try {
    Auth._overrides.verifyIdToken = async (tok, aud) => {
      if (tok !== 'tok-valid') throw new Error('bad token');
      return { email: 'runtime@nobigdeal-pro.iam.gserviceaccount.com', email_verified: true, aud };
    };
    Auth._overrides.selfEmail = async () => 'runtime@nobigdeal-pro.iam.gserviceaccount.com';
    const g = gateway();
    const kinds = Object.keys(g.spec.PUBLIC_LEAD_KINDS);
    ok('the probe covers every public lead kind (6+)', kinds.length >= 6 && P && P.probeKinds(g.spec).length === kinds.length, kinds);
    for (const kind of kinds) {
      const body = P.buildProbeBody(kind, g.spec);
      const r = await g.submit(kind, body, PROBE_HEADERS);
      ok(kind + ': probe → 200 { success, probe:true }, nothing stored', r.res.code === 200 && r.res.body && r.res.body.probe === true && r.res.body.success === true && !r.stored, r.res);
    }
    ok('no Firestore add on any probe', g.added.length === 0);
    ok('no tenant-registry read on any probe', g.reads.length === 0, g.reads);
    ok('the per-IP limiter ran for every probe (gate exercised)', g.limiterCalls.filter((n) => n === 'publicLead:ip').length === kinds.length, g.limiterCalls);
    ok('no flood / duplicate / estimate-email bucket was touched', !g.limiterCalls.some((n) => n !== 'publicLead:ip'), g.limiterCalls);
    ok('the probe checked Turnstile POSTURE, never a visitor token', g.tsCalls.length === kinds.length && g.tsCalls.every((c) => c === 'posture'), g.tsCalls);

    const bad = await g.submit('contact', Object.assign(P.buildProbeBody('contact', g.spec), { phone: '555-0142' }), PROBE_HEADERS);
    ok('a probe with a bad phone still gets the real 400 (validation ran)', bad.res.code === 400 && !bad.stored);
    const missing = P.buildProbeBody('inspect', g.spec); delete missing.address;
    const m = await g.submit('inspect', missing, PROBE_HEADERS);
    ok('a probe missing a required field gets 400', m.res.code === 400 && !m.stored);
    const tok = await g.submit('estimate', Object.assign(P.buildProbeBody('estimate', g.spec), { leadToken: 'x'.repeat(40), type: 'email_estimate_request' }), PROBE_HEADERS);
    ok('a probe never takes the started-estimate update path or the estimate-email limiter', tok.res.code === 200 && tok.res.body.probe === true && g.added.length === 0 && !g.limiterCalls.includes('estimateEmail:ip'));

    const gFail = gateway({ posture: { ok: false, configured: false, reason: 'turnstile-required' } });
    const tf = await gFail.submit('contact', P.buildProbeBody('contact', gFail.spec), PROBE_HEADERS);
    ok('Turnstile posture failing → the probe gets the same 403 a visitor would', tf.res.code === 403 && tf.res.body.reason === 'turnstile-required' && !tf.stored);

    // Positive control: the harness CAN store, so "nothing stored" above means something.
    const gReal = gateway();
    const real = await gReal.submit('contact', { firstName: 'Pat', phone: '5135550142', source: 'homepage' }, {});
    ok('control: an ordinary submit IS stored by this harness', real.res.code === 200 && real.stored && real.res.body.probe === undefined);
    ok('control: an ordinary submit verifies the visitor token, not posture', gReal.tsCalls.join() === 'verify');
  } catch (e) { ok('A harness ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nB — a forged probe header gets nothing');
  try {
    const g = gateway();
    const body = P.buildProbeBody('contact', g.spec);
    const noTok = await g.submit('contact', body, { 'x-nbd-lead-probe': '1' });
    ok('probe header, no token → 403, nothing stored', noTok.res.code === 403 && !noTok.stored, noTok.res);
    const badTok = await g.submit('contact', body, { 'x-nbd-lead-probe': '1', 'x-nbd-probe-token': 'forged' });
    ok('probe header, forged token → 403, nothing stored', badTok.res.code === 403 && !badTok.stored);
    Auth._overrides.verifyIdToken = async () => ({ email: 'someone-else@other-project.iam.gserviceaccount.com', email_verified: true });
    const other = await g.submit('contact', body, PROBE_HEADERS);
    ok('a valid Google token from ANOTHER account → 403, nothing stored', other.res.code === 403 && !other.stored);
    ok('no limiter or Turnstile call was spent on a forged probe', g.limiterCalls.length === 0 && g.tsCalls.length === 0, { l: g.limiterCalls, t: g.tsCalls });
    const sentinelOnly = await g.submit('contact', body, {});
    ok('the probe body WITHOUT the probe header trips the honeypot: 200, nothing stored', sentinelOnly.res.code === 200 && !sentinelOnly.stored && sentinelOnly.res.body.probe === undefined);
  } catch (e) { ok('B harness ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC — deploy skew: an older gateway never stores the probe');
  try {
    const body = P.buildProbeBody('inspect', gateway().spec);
    ok('every probe body carries the honeypot sentinel', body.nbd_hp === P.PROBE_SENTINEL && /probe/.test(P.PROBE_SENTINEL));
    ok('…and a fictional 555-01xx phone, example.com email', /^513555010\d$/.test(String(body.phone).replace(/\D/g, '')) && (!body.email || /@example\.com$/.test(body.email)));
  } catch (e) { ok('C ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nD — turnstilePosture');
  try {
    const TS = F('integrations/turnstile.js');
    let secret = '';
    const realFetch = global.fetch;
    const posture = async (secretVal, required, fetchImpl) => {
      secret = secretVal;
      stubs = Object.assign(baseStubs(), { './_shared': { hasSecret: () => !!secret && secret !== '__unset__', getSecret: () => secret, notConfigured: () => ({}) } });
      const mod = fresh(TS);
      stubs = null;
      if (required) process.env.TURNSTILE_REQUIRED = 'true'; else delete process.env.TURNSTILE_REQUIRED;
      global.fetch = fetchImpl || (async () => { throw new Error('no network in tests'); });
      try { return await mod.turnstilePosture(); } finally { global.fetch = realFetch; delete process.env.TURNSTILE_REQUIRED; }
    };
    const outage = await posture('__unset__', true);
    ok('stub secret + TURNSTILE_REQUIRED=true (the 10-13 outage) → fails turnstile-required', outage.ok === false && outage.reason === 'turnstile-required');
    const pass = await posture('', false);
    ok('no secret, flag off → passthrough ok (configured:false)', pass.ok === true && pass.configured === false);
    let sent = null;
    const cf = (codes) => async (url, init) => { sent = { url, body: String(init.body) }; return { json: async () => ({ success: false, 'error-codes': codes }) }; };
    const good = await posture('0x4AAAreal', true, cf(['invalid-input-response']));
    ok('real secret: Cloudflare says only the dummy token is bad → ok', good.ok === true && good.configured === true, good);
    ok('…sent to siteverify with a dummy token, never a visitor token', /siteverify/.test(sent.url) && /response=nbd-lead-probe/.test(sent.body));
    const wrong = await posture('0x4AAAwrong', true, cf(['invalid-input-secret']));
    ok('wrong / deleted secret → fails with Cloudflare\'s code', wrong.ok === false && /invalid-input-secret/.test(wrong.reason));
    const weird = await posture('0x4AAAreal', true, async () => ({ json: async () => ({ success: true }) }));
    ok('an unexpected success on a dummy token is not trusted', weird.ok === false);
    const down = await posture('0x4AAAreal', true);
    ok('Cloudflare unreachable → fails verify-error (a visitor would 403 too)', down.ok === false && down.reason === 'verify-error');
  } catch (e) { ok('D ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nE — verifyProbeCaller');
  try {
    const self = 'runtime@nobigdeal-pro.iam.gserviceaccount.com';
    Auth._overrides.selfEmail = async () => self;
    let audSeen = null;
    Auth._overrides.verifyIdToken = async (tok, aud) => { audSeen = aud; if (tok !== 'good') throw new Error('bad'); return { email: self, email_verified: true }; };
    const req = (h) => ({ headers: h });
    ok('isProbeRequest only on the probe header', Auth.isProbeRequest(req({ 'x-nbd-lead-probe': '1' })) && !Auth.isProbeRequest(req({})));
    ok('own verified token → ok', (await Auth.verifyProbeCaller(req({ 'x-nbd-probe-token': 'good' }))).ok === true);
    ok('…checked against the gateway URL as audience', audSeen === Auth.probeAudience({ GCLOUD_PROJECT: 'nobigdeal-pro' }) && /cloudfunctions\.net\/submitPublicLead$/.test(audSeen), audSeen);
    ok('missing token → refused', (await Auth.verifyProbeCaller(req({}))).ok === false);
    ok('verifier throws → refused', (await Auth.verifyProbeCaller(req({ 'x-nbd-probe-token': 'bad' }))).ok === false);
    Auth._overrides.verifyIdToken = async () => ({ email: self, email_verified: false });
    ok('unverified email → refused', (await Auth.verifyProbeCaller(req({ 'x-nbd-probe-token': 'good' }))).ok === false);
    Auth._overrides.verifyIdToken = async () => ({ email: self, email_verified: true });
    Auth._overrides.selfEmail = async () => '';
    ok('own account unknown (metadata down) → refused, never "anyone"', (await Auth.verifyProbeCaller(req({ 'x-nbd-probe-token': 'good' }))).ok === false);
  } catch (e) { ok('E ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nF — the cron\'s verdicts');
  try {
    const spec = gateway().spec;
    const origin = P.SITE_ORIGIN;
    const fakeFetch = (fn) => async (url, init) => {
      const r = fn(JSON.parse(init.body).kind, init);
      return { status: r.status, headers: { get: (h) => (String(h).toLowerCase() === 'access-control-allow-origin' ? (r.acao === undefined ? origin : r.acao) : null) }, json: async () => r.body };
    };
    let seenInit = null;
    const allOk = await P.runProbes({ spec, url: 'https://x/submitPublicLead', token: 'T', fetchImpl: fakeFetch((k, init) => { seenInit = init; return { status: 200, body: { success: true, probe: true } }; }) });
    ok('all kinds answer probe:true → no failures', allOk.length === P.probeKinds(spec).length && allOk.every((r) => r.ok), allOk);
    ok('the probe sends the site Origin, the probe header and the token', seenInit.headers.Origin === origin && seenInit.headers['x-nbd-lead-probe'] === '1' && seenInit.headers['x-nbd-probe-token'] === 'T');
    const r403 = await P.runProbes({ spec, url: 'u', token: 'T', fetchImpl: fakeFetch((k) => (k === 'inspect' ? { status: 403, body: { error: 'Verification failed', reason: 'turnstile-required' } } : { status: 200, body: { success: true, probe: true } })) });
    const bad = r403.filter((r) => !r.ok);
    ok('a 403 on one kind fails that kind with the server reason', bad.length === 1 && bad[0].kind === 'inspect' && /403/.test(bad[0].reason) && /turnstile-required/.test(bad[0].reason), bad);
    const notProbe = await P.runProbes({ spec, url: 'u', token: 'T', fetchImpl: fakeFetch(() => ({ status: 200, body: { success: true } })) });
    ok('a 200 WITHOUT probe:true (old gateway / honeypot) is a failure, not a pass', notProbe.every((r) => !r.ok && /not a probe answer/.test(r.reason)));
    const noCors = await P.runProbes({ spec, url: 'u', token: 'T', fetchImpl: fakeFetch(() => ({ status: 200, body: { success: true, probe: true }, acao: null })) });
    ok('a missing CORS allow-origin for the site is a failure (browsers would be blocked)', noCors.every((r) => !r.ok && /origin/i.test(r.reason)));
    const net = await P.runProbes({ spec, url: 'u', token: 'T', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    ok('a network error is a failure', net.every((r) => !r.ok && /ECONNRESET/.test(r.reason)));

    const DAY = 86400000, now = Date.parse('2026-11-26T14:00:00Z');
    ok('quiet window is 14 days (Joe 2026-11-26)', P.QUIET_DAYS === 14);
    ok('newest lead 3 days ago → no quiet notice', P.quietDecision({ newestMs: now - 3 * DAY, nowMs: now, state: {} }).notify === false);
    const q = P.quietDecision({ newestMs: now - 15 * DAY, nowMs: now, state: {} });
    ok('newest lead 15 days ago → quiet notice', q.notify === true && q.days === 15, q);
    ok('…only once for the same silence', P.quietDecision({ newestMs: now - 16 * DAY, nowMs: now, state: { quietNotifiedNewestMs: now - 16 * DAY } }).notify === false);
    ok('…and again after a new lead and a new 14-day silence', P.quietDecision({ newestMs: now - 20 * DAY, nowMs: now, state: { quietNotifiedNewestMs: now - 60 * DAY } }).notify === true);
    ok('no lead at all → one notice', P.quietDecision({ newestMs: 0, nowMs: now, state: {} }).notify === true && P.quietDecision({ newestMs: 0, nowMs: now, state: { quietNotifiedNewestMs: 0 } }).notify === false);
    ok('unreadable (null) newest → no notice from a failed read', P.quietDecision({ newestMs: null, nowMs: now, state: {} }).notify === false);
  } catch (e) { ok('F ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nG — wiring');
  try {
    const src = fs.readFileSync(F('lead-gateway-probe.js'), 'utf8');
    ok('probe failure → notifyOwner \'alert\' (text + bell + push); quiet notice → \'info\' (bell only)', /notifyOwner[\s\S]*severity: 'alert'[\s\S]*notifyOwner[\s\S]*severity: 'info'/.test(src));
    ok('the cron never writes a lead collection (no .add( / .set( on a lead)', !/\.add\(/.test(src));
    const map = JSON.parse(fs.readFileSync(F('function-map.json'), 'utf8'));
    ok('function-map.json maps leadGatewayProbe', map.leadGatewayProbe === './lead-gateway-probe');
    const md = fs.readFileSync(F('FUNCTIONS_INDEX.md'), 'utf8');
    ok('FUNCTIONS_INDEX.md documents leadGatewayProbe', /leadGatewayProbe/.test(md));
    const gw = fs.readFileSync(F('handlers/integrations.js'), 'utf8');
    const probeReturn = gw.indexOf('probe: true');
    ok('the gateway answers the probe BEFORE the Firestore add', probeReturn > 0 && probeReturn < gw.indexOf('.collection(spec.collection).add('));
  } catch (e) { ok('G ran', false, String(e && e.stack || e)); }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
