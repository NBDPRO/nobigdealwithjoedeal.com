/**
 * tests/otp-hardening-2026-10-19.test.js
 *
 * Verification codes (Twilio Verify) go to a phone number a visitor TYPED, so
 * they are the one customer-facing text with a third-party recipient. Driven
 * through the REAL sendVerificationCode in the fake world; nothing reaches Twilio.
 *
 *   - the owner's kill switch (messaging_controls/global otpEnabled, fail closed)
 *   - a canary does not preview a code (it would go to the owner while the
 *     visitor types it against their own number): OTP is paused under canary
 *   - the shared STOP register / Do Not Text list is read BEFORE Verify
 *   - caps: global/day (a real 0 means none), per-IP/day (new), per-IP/10min and
 *     per-phone limits are still enforced
 *   - quiet hours: NOT applied, on purpose: the code is requested by the person
 *     at the keyboard right now; a night-time block would only break the form.
 *     (documentation/audit/MESSAGING-HARDENING-2026-10-19.md, section OTP)
 *
 * Run: node tests/otp-hardening-2026-10-19.test.js
 */
'use strict';
const W = require('./lib/sms-compliance-world');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const KEY = '8595550134';
const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';

async function otp(opts, env) {
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; }
  const w = W.makeWorld(opts || {});
  const verifyCalls = [];
  const limits = [];
  w.stubs['./rate-limit'] = {
    clientIp: () => '203.0.113.9',
    enforceRateLimit: async (ns, key, limit, windowMs) => {
      limits.push({ ns, key, limit, windowMs });
      if (opts && opts.limited && opts.limited.indexOf(ns) !== -1) { const e = new Error('rate_limited'); e.rateLimited = true; throw e; }
      return { count: 1 };
    },
  };
  w.stubs.twilio = Object.assign(() => ({
    verify: { v2: { services: () => ({ verifications: { create: async (a) => { verifyCalls.push(a); return { status: 'pending' }; } } }) } },
    messages: { create: async () => ({ sid: 'x' }) },
  }), { validateRequest: () => true });
  const mod = W.load(w, 'verify-functions.js');
  let out, err;
  try { out = await mod.sendVerificationCode.__handler({ data: { phone: '(859) 555-0134' }, rawRequest: { headers: {} } }); } catch (e) { err = e; }
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  const requests = [...w.store.keys()].filter((k) => k.indexOf('otp_requests/') === 0).length;
  return { w, out, err, verifyCalls, limits, requests };
}

(async () => {
  let r = await otp({});
  ok('control: everything open -> one Verify call, success', r.out && r.out.success === true && r.verifyCalls.length === 1 && r.verifyCalls[0].to === '+18595550134', JSON.stringify(r.out));

  r = await otp({ noControls: true });
  ok('no messaging_controls doc -> NO Verify call, a plain "paused" answer', r.out && r.out.success === false && r.verifyCalls.length === 0 && /paused/i.test(r.out.error), JSON.stringify(r.out));
  ok('...and a paused send burns no rate limit and writes no otp_requests row', r.requests === 0 && !r.limits.some((l) => l.ns === 'sendVerificationCode:phoneDay'), JSON.stringify(r.limits));

  const G = require('./lib/messaging-controls-open').OPEN_CONTROLS['messaging_controls/global'];
  r = await otp({ noControls: true, docs: { 'messaging_controls/global': Object.assign({}, G, { otpEnabled: false }) } });
  ok('otpEnabled:false -> blocked', r.out && r.out.success === false && r.verifyCalls.length === 0);
  r = await otp({ noControls: true, docs: { 'messaging_controls/global': Object.assign({}, G, { customerSendsEnabled: false }) } });
  ok('master customerSendsEnabled:false -> blocked', r.out && r.out.success === false && r.verifyCalls.length === 0);
  r = await otp({ noControls: true, docs: { 'messaging_controls/global': Object.assign({}, G, { canary: true }), 'messaging_controls/internal': { ownerPhone: '+18595550100' } } });
  ok('canary on -> OTP is paused (a code cannot be previewed)', r.out && r.out.success === false && r.verifyCalls.length === 0 && /paused/i.test(r.out.error), JSON.stringify(r.out));
  r = await otp({ readThrows: (p) => p === 'messaging_controls/global' });
  ok('unreadable controls -> blocked (fail closed)', r.out && r.out.success === false && r.verifyCalls.length === 0);

  r = await otp({ docs: { ['sms_opt_outs/' + KEY]: { phone: '+1' + KEY, keyword: 'STOP' } } });
  ok('a number on the STOP register gets NO code', r.out && r.out.success === false && r.verifyCalls.length === 0 && /cannot send a text code/i.test(r.out.error) && !/opt|stop/i.test(r.out.error), JSON.stringify(r.out));
  r = await otp({ docs: { ['sms_dnc/' + NBD + '__' + KEY]: { companyId: NBD, key: KEY, phone: '(859) 555-0134', source: 'manual' } } });
  ok("NBD's own Do Not Text list is honoured too", r.out && r.out.success === false && r.verifyCalls.length === 0);
  r = await otp({ readThrows: (p) => p.indexOf('sms_opt_outs/') === 0 });
  ok('an unreadable STOP register -> no code (the generic failure)', r.out && r.out.success === false && r.verifyCalls.length === 0);

  r = await otp({}, { OTP_GLOBAL_DAILY_CAP: '0' });
  ok('OTP_GLOBAL_DAILY_CAP=0 -> no codes at all (zero is zero; was 200)', r.out && r.out.success === false && r.verifyCalls.length === 0, JSON.stringify(r.out));
  r = await otp({}, { OTP_GLOBAL_DAILY_CAP: '3' });
  ok('control: OTP_GLOBAL_DAILY_CAP=3 still sends', r.out && r.out.success === true && r.limits.some((l) => l.ns === 'sendVerificationCode:globalDay' && l.limit === 3));
  r = await otp({}, { OTP_IP_DAILY_CAP: '0' });
  ok('OTP_IP_DAILY_CAP=0 -> no codes', r.out && r.out.success === false && r.verifyCalls.length === 0);
  r = await otp({}, { OTP_IP_DAILY_CAP: null });
  ok('a per-IP DAILY bucket exists (default 15/day) next to the 10-minute one (5)', r.limits.some((l) => l.ns === 'sendVerificationCode:ipDay' && l.limit === 15 && l.windowMs === 86400000)
    && r.limits.some((l) => l.ns === 'sendVerificationCode:ip' && l.limit === 5), JSON.stringify(r.limits));
  r = await otp({ limited: ['sendVerificationCode:ipDay'] });
  ok('over the per-IP daily cap -> resource-exhausted, no Verify call', r.err && r.err.code === 'resource-exhausted' && r.verifyCalls.length === 0, r.err && r.err.code);
  r = await otp({ limited: ['sendVerificationCode:ip'] });
  ok('the 10-minute per-IP cap is unchanged', r.err && r.err.code === 'resource-exhausted' && r.verifyCalls.length === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
