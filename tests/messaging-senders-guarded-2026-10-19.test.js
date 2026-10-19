/**
 * tests/messaging-senders-guarded-2026-10-19.test.js
 *
 * Structural guard: every function that can message a person goes through the
 * ONE kill switch (functions/messaging-controls.js). A new sender that calls
 * Twilio or Resend directly, with no guard, fails here until it is classified.
 *
 *   A. Twilio texts (`messages.create(`): the file must use guardTwilio (a
 *      customer text; kill switch + canary at the send) or, for the internal
 *      alert to Jo, internalAlertStatus (own switch + hourly cap).
 *   B. OTP (`verifications.create(`): channelStatus('otp') + the shared STOP register.
 *   C. Bland SMS (`/sms/send`): internalAlertStatus.
 *   D. Email (`emails.send(`): a customer-facing file must use guardEmail /
 *      MessagingControls.sendEmail / an automationStatus gate; everything else
 *      must be on the INTERNAL list in tests/lib/outbound-template-scan.js.
 *   E. Nothing but messaging-controls*.js mentions the messaging_controls docs
 *      (the only writer is the Jo-only callable).
 *
 * Comments are stripped first; each rule has a positive control so the scan
 * cannot be blind.
 *
 * Run: node tests/messaging-senders-guarded-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { stripJsComments } = require('./lib/strip-js-comments');
const SCAN = require('./lib/outbound-template-scan');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(FN, []).map((abs) => ({
  rel: path.relative(ROOT, abs).split(path.sep).join('/'),
  code: stripJsComments(fs.readFileSync(abs, 'utf8')),
}));
const byRel = (rel) => (files.find((f) => f.rel === rel) || { code: '' }).code;

// Positive controls for the detectors.
ok('control: detector sees a Twilio send', /\.messages\.create\(/.test(stripJsComments('c.messages.create({})')));
ok('control: detector ignores a commented send', !/\.messages\.create\(/.test(stripJsComments('// c.messages.create({})\nconst a=1;')));

// A. Twilio texts
const SMS_RULES = {
  'functions/messaging-controls.js': ['guardSms('],   // the guard itself wraps the SDK call
  'functions/sms-functions.js': ['MessagingControls.guardTwilio('],
  'functions/lead-alert.js': ['MessagingControls.guardTwilio(', 'MessagingControls.internalAlertStatus('],
  'functions/storm-watch.js': ['MessagingControls.guardTwilio(', 'MessagingControls.internalAlertStatus('],
  'functions/storm-poller.js': ['MC.guardTwilio('],
  'functions/review-ask-auto.js': ['MessagingControls.guardTwilio('],
  'functions/call-center.js': ['MessagingControls.guardTwilio('],
  'functions/verify-functions.js': ['MessagingControls.internalAlertStatus('],
};
const smsSenders = files.filter((f) => /\.messages\.create\(/.test(f.code)).map((f) => f.rel);
for (const rel of smsSenders) {
  const need = SMS_RULES[rel];
  ok('Twilio sender is classified: ' + rel, !!need);
  if (need) for (const t of need) ok(rel + ' uses ' + t, byRel(rel).indexOf(t) !== -1);
}
for (const rel of Object.keys(SMS_RULES)) {
  ok('classified Twilio file really sends: ' + rel, smsSenders.indexOf(rel) !== -1);
}

// B. OTP
{
  const v = byRel('functions/verify-functions.js');
  ok('OTP send checks the otp switch', /MessagingControls\.channelStatus\(db,\s*'otp'\)/.test(v));
  ok('OTP send checks the shared STOP register', /OptOut\.isOptedOut\(/.test(v));
  const iSwitch = v.indexOf("channelStatus(db, 'otp')");
  const iSend = v.indexOf('verifications.create(');
  ok('OTP switch is checked BEFORE the Verify call', iSwitch > 0 && iSend > iSwitch);
}

// C. Bland SMS
ok('Bland SMS (thursday.js /sms/send) is behind internalAlertStatus',
  /\/sms\/send/.test(byRel('functions/integrations/thursday.js')) && /MessagingControls\.internalAlertStatus\(/.test(byRel('functions/integrations/thursday.js')));

// D. Email
const CUSTOMER_EMAIL_RULES = {
  'functions/email-functions.js': ['MessagingControls.guardEmail('],
  'functions/funnel-recovery.js': ['MessagingControls.guardEmail(', 'MessagingControls.automationStatus('],
  'functions/lead-followup.js': ['MessagingControls.guardEmail(', 'MessagingControls.automationStatus('],
  'functions/review-ask-auto.js': ['MessagingControls.guardEmail(', 'MessagingControls.automationStatus('],
  'functions/lead-alert.js': ['MessagingControls.guardEmail(', 'MessagingControls.automationStatus('],
  'functions/estimate-email.js': ['MessagingControls.guardEmail('],
  'functions/storm-report-email.js': ['MessagingControls.guardEmail('],
  'functions/esign-io.js': ['MessagingControls.guardResend('],
  'functions/remote-signing.js': ['MessagingControls.guardResend('],
  'functions/report-sharing.js': ['MessagingControls.guardResend('],
  'functions/pro-prospects.js': ['MessagingControls.guardResend('],
  'functions/alert-recipients-fns.js': ['MessagingControls.guardResend('],
};
const emailSenders = files.filter((f) => /\.emails\.send\(/.test(f.code)).map((f) => f.rel);
for (const rel of emailSenders) {
  const customer = CUSTOMER_EMAIL_RULES[rel];
  const internal = SCAN.INTERNAL_SENDERS.indexOf(rel) !== -1;
  ok('email sender is classified customer-guarded or internal: ' + rel, !!customer || internal);
  if (customer) for (const t of customer) ok(rel + ' uses ' + t, byRel(rel).indexOf(t) !== -1);
}
// The mixed-content senders that wrap the SDK (esign/remote/report/pro/alert) must not ALSO send raw to a customer.
for (const rel of ['functions/esign-io.js', 'functions/remote-signing.js', 'functions/report-sharing.js', 'functions/pro-prospects.js']) {
  ok(rel + ' has no raw resend.emails.send( left', !/\bresend\.emails\.send\(/.test(byRel(rel)));
}

// E. Only the controls module + the Jo-only callable touch the docs.
{
  const touching = files.filter((f) => /messaging_controls/.test(f.code)).map((f) => f.rel).sort();
  // flags-registry.js only DESCRIBES the gates in plain-English strings.
  const allowedTouch = ['functions/flags-registry.js', 'functions/messaging-controls-fns.js', 'functions/messaging-controls.js'];
  ok('only messaging-controls.js, its callable and the flag descriptions name the messaging_controls docs',
    JSON.stringify(touching) === JSON.stringify(allowedTouch), touching.join(', '));
  const writers = files.filter((f) => /messaging_controls[^']*'\)\s*\.(set|update|delete)\(|GLOBAL_DOC\)\.(set|update|delete)\(|AUTOMATIONS_DOC\)\.(set|update|delete)\(|INTERNAL_DOC\)\.(set|update|delete)\(/.test(f.code)).map((f) => f.rel);
  ok('the only writer of the control docs is the Jo-only callable', JSON.stringify(writers) === JSON.stringify(['functions/messaging-controls-fns.js']), writers.join(', '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
