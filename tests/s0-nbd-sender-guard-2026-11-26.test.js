/**
 * tests/s0-nbd-sender-guard-2026-11-26.test.js
 *
 * WHY THIS EXISTS (review-ask guardrail plan, slice S0, Jo OK 2026-11-26;
 * documentation/projects/REVIEW-ASK-MULTITENANT-GUARDRAIL-PLAN-2026-11-26.md R1 / G1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every customer text path asks sms-texting-gate.js textingStatus() for the
 * CALLER's company, then sends with NBD's Twilio account and NBD's number
 * (sms-functions.js sendSMS / sendD2DSMS, missed-call autotext, lead alert,
 * storm-confirm). Before this, `sms_settings/{co}.registered: true` on any
 * other company let that company's texts out on NBD's number and NBD's A2P
 * campaign. No per-company sender exists yet, so no other company may text
 * at all: textingStatus answers `no_own_sender` for every non-NBD company,
 * registered or not, until each has its own Twilio subaccount and number.
 *
 * Run: node tests/s0-nbd-sender-guard-2026-11-26.test.js
 */
'use strict';

const W = require('./lib/sms-compliance-world');

process.env.NBD_OWNER_UID = 'nbd-owner';
const NBD = 'nbd-owner';

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const PHONE = '(859) 555-0134';
const KEY = '8595550134';
const NOON = Date.parse('2026-10-05T16:00:00Z');   // 12:00 EDT
const NBD_TOKEN = { uid: 'joe', companyId: NBD, email_verified: true };
const CO1_TOKEN = { uid: 'rep-1', companyId: 'co-1', email_verified: true };
const REGISTERED_CO1 = { 'sms_settings/co-1': { registered: true, enabled: true }, 'companyProfile/co-1': { brand: { legalName: 'Acme Roofing' } } };

async function status(docs, key, opts) {
  const w = W.makeWorld({ docs });
  return W.load(w, 'sms-texting-gate.js').textingStatus(w.db, key, opts);
}
async function sendSMS(token, docs, body) {
  const w = W.makeWorld({ token, clockMs: NOON, docs: Object.assign({}, W.consentDocs(KEY, NBD, 'joe'), W.consentDocs(KEY, 'co-1'), docs || {}) });
  const res = await W.invoke(W.load(w, 'sms-functions.js').sendSMS.__handler, { body });
  return { w, res };
}
async function d2d(token, docs, knock) {
  const w = W.makeWorld({ token, clockMs: NOON, docs: Object.assign({ 'knocks/k1': knock }, docs || {}) });
  const res = await W.invoke(W.load(w, 'sms-functions.js').sendD2DSMS.__handler, { body: { knockId: 'k1', templateKey: 'not_home' } });
  return { w, res };
}

(async () => {
  console.log('A. textingStatus: no other company texts on NBD\'s sender');
  {
    const s = await status(REGISTERED_CO1, 'co-1');
    ok('a registered, switched-on other company → not allowed, reason no_own_sender', s.allowed === false && s.reason === 'no_own_sender', JSON.stringify(s));
    const s2 = await status(REGISTERED_CO1, 'co-1', { ignoreGlobal: true });
    ok('the settings-screen answer (ignoreGlobal) says the same', s2.allowed === false && s2.reason === 'no_own_sender', JSON.stringify(s2));
    ok('the registered flag itself is still reported (the settings screen shows it)', s.registered === true);
    const s3 = await status({}, 'co-1');
    ok('an unregistered company → not_registered, as before', s3.allowed === false && s3.reason === 'not_registered', JSON.stringify(s3));
    const s4 = await status({ 'sms_settings/co-1': { registered: true, enabled: false } }, 'co-1');
    ok('a registered company that switched itself off → switched_off (its own switch still reads first)', s4.allowed === false && s4.reason === 'switched_off', JSON.stringify(s4));
    const s5 = await status({}, NBD);
    ok('control: NBD with no settings doc → allowed', s5.allowed === true && s5.reason === null, JSON.stringify(s5));
    const s6 = await status({ ['sms_settings/' + NBD]: { enabled: false } }, NBD);
    ok('control: NBD switched off → switched_off', s6.allowed === false && s6.reason === 'switched_off');
  }

  console.log('B. sendSMS: a registered other company\'s rep text never reaches Twilio');
  {
    const r = await sendSMS(CO1_TOKEN, REGISTERED_CO1, { to: PHONE, body: 'Hi from Acme' });
    ok('co-1 rep, co-1 registered → 403 texting_disabled / no_own_sender, Twilio called 0 times',
      r.res.statusCode === 403 && r.res.body && r.res.body.reason === 'no_own_sender' && r.w.twilioCalls.length === 0,
      r.res.statusCode + ' ' + JSON.stringify(r.res.body) + ' calls=' + r.w.twilioCalls.length);
    const c = await sendSMS(NBD_TOKEN, {}, { to: PHONE, body: 'Hi from Joe' });
    ok('control: NBD rep → 200, Twilio called once', c.res.statusCode === 200 && c.w.twilioCalls.length === 1, c.res.statusCode + ' ' + JSON.stringify(c.res.body));
  }

  console.log('C. sendD2DSMS: same for a door-knock text');
  {
    const r = await d2d(CO1_TOKEN, REGISTERED_CO1, { userId: 'rep-1', companyId: 'co-1', phone: PHONE, smsConsent: true, repName: 'Al' });
    ok('co-1 knock, co-1 registered → refused, Twilio called 0 times', r.res.statusCode === 403 && r.w.twilioCalls.length === 0,
      r.res.statusCode + ' ' + JSON.stringify(r.res.body));
  }

  console.log('D. the Texting settings screen tells the truth (manageSmsCompliance)');
  {
    async function call(token, data, docs) {
      const w = W.makeWorld({ docs: docs || {} });
      const mod = W.load(w, 'sms-dnc.js');
      try { return { w, out: await mod.manageSmsCompliance.__handler({ auth: { uid: token.uid, token }, data }) }; }
      catch (e) { return { w, err: e }; }
    }
    const adm = Object.assign({ role: 'company_admin' }, CO1_TOKEN);
    const g = await call(adm, { action: 'getSettings' }, REGISTERED_CO1);
    ok('a registered other company → needsRegistration (the CRM shows "coming soon", never a live switch)',
      g.out && g.out.allowed === false && g.out.reason === 'no_own_sender' && g.out.needsRegistration === true, JSON.stringify(g.out || g.err));
    const s = await call(adm, { action: 'setEnabled', enabled: true }, { 'sms_settings/co-1': { registered: true, enabled: false } });
    ok('...and it cannot switch texting ON (failed-precondition, enabled stays false)',
      s.err && s.err.code === 'failed-precondition' && (s.w.store.get('sms_settings/co-1') || {}).enabled === false, JSON.stringify(s.out || (s.err && s.err.code)));
    const off = await call(adm, { action: 'setEnabled', enabled: false }, REGISTERED_CO1);
    ok('...switching OFF is always allowed', off.out && off.out.ok === true && (off.w.store.get('sms_settings/co-1') || {}).enabled === false, JSON.stringify(off.out || (off.err && off.err.message)));
    const n = await call(Object.assign({ role: 'company_admin' }, NBD_TOKEN), { action: 'getSettings' });
    ok('control: NBD getSettings → allowed, needsRegistration false', n.out && n.out.allowed === true && n.out.needsRegistration === false, JSON.stringify(n.out || n.err));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
