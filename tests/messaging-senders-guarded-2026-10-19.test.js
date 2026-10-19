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
  // messaging-center.js is the read-only owner view (reads messaging_controls/global, never writes).
  const allowedTouch = ['functions/flags-registry.js', 'functions/messaging-center.js', 'functions/messaging-controls-fns.js', 'functions/messaging-controls.js'];
  ok('only messaging-controls.js, its callable and the flag descriptions name the messaging_controls docs',
    JSON.stringify(touching) === JSON.stringify(allowedTouch), touching.join(', '));
  const writers = files.filter((f) => /messaging_controls[^']*'\)\s*\.(set|update|delete)\(|GLOBAL_DOC\)\.(set|update|delete)\(|AUTOMATIONS_DOC\)\.(set|update|delete)\(|INTERNAL_DOC\)\.(set|update|delete)\(/.test(f.code)).map((f) => f.rel);
  ok('the only writer of the control docs is the Jo-only callable', JSON.stringify(writers) === JSON.stringify(['functions/messaging-controls-fns.js']), writers.join(', '));
}

// E3. One-shot triggers check the pause BEFORE they take their claim (a pause must not burn the claim).
{
  for (const [rel, claimToken] of [['functions/estimate-email.js', 'runTransaction('], ['functions/storm-report-email.js', 'runTransaction('], ['functions/pro-prospects.js', 'runTransaction(']]) {
    const code = byRel(rel);
    const iCheck = code.indexOf('channelStatus(');
    const iClaim = code.indexOf(claimToken, iCheck > 0 ? 0 : 0);
    // the FIRST claim transaction in the handler comes after the first pause check
    const firstClaim = code.indexOf(claimToken);
    ok(rel + ': the pause check comes before the one-shot claim', iCheck > 0 && firstClaim > iCheck, 'check@' + iCheck + ' claim@' + firstClaim);
    void iClaim;
  }
}

// E2. ignoreGlobal (the company-only answer that skips the owner's pause) is for exactly two callers.
{
  const users = files.filter((f) => /ignoreGlobal\s*:\s*true/.test(f.code)).map((f) => f.rel).sort();
  ok('only phone-text-check.js (rep texting from their OWN phone) and sms-dnc.js (the settings screen) skip the global pause',
    JSON.stringify(users) === JSON.stringify(['functions/phone-text-check.js', 'functions/sms-dnc.js']), users.join(', '));
}

// F. Site-level scan: every send call site is guarded, or is a PINNED internal/account raw site.
{
  const SENDER = require('./lib/sender-scan');
  // file -> exact number of RAW (unguarded) send sites, with why each is not a customer message.
  // A NEW raw site in an already-listed file changes the count and fails here.
  const RAW_PINS = {
    'functions/alert-recipients-fns.js': [1, 'security notice to the account owner\'s own verified address'],
    'functions/anniversary-touch.js': [1, 'rep digest'],
    'functions/call-center.js': [1, 'owner reminder digest'],
    'functions/call-watch.js': [1, 'owner alert ladder'],
    'functions/dormant-leads.js': [1, 'rep digest'],
    'functions/email-functions.js': [1, 'doc-draft send: the message was already built by guardEmail in buildMessage'],
    'functions/handlers/invites.js': [1, 'team invite (account mail)'],
    'functions/integrations/email-queue-worker.js': [1, 'account mail queue (dunning, erasure, health) to contractors and the owner'],
    'functions/integrations/thursday.js': [1, 'call alert to the owner'],
    'functions/lead-alert.js': [1, 'new-lead alert email to the owner / tenant alert inbox'],
    'functions/lead-digest.js': [1, 'owner digest'],
    'functions/marketing-report.js': [1, 'owner monthly report'],
    'functions/messaging-controls.js': [1, 'the guardTwilio wrapper itself'],
    'functions/morning-brief.js': [1, 'owner brief'],
    'functions/review-request-nudge.js': [1, 'rep digest'],
    'functions/storm-watch.js': [2, 'owner storm SMS + owner storm email (internal alerts, internalAlertStatus)'],
    'functions/verify-functions.js': [3, 'the OTP call (switch + STOP register checked first), the owner new-lead SMS and email (internalAlertStatus)'],
    'functions/weekly-digest.js': [1, 'rep digest'],
  };
  // Shapes that look like a hidden send but are not (file -> kinds): Anthropic "messages", read-only Twilio status GETs.
  const BANNED_OK = {
    'functions/handlers/ai.js': ['destructured-client'],
    'functions/text-inbox.js': ['destructured-client'],
    'functions/messaging-center-logic.js': ['aliased-client'],
    'functions/call-watch.js': ['raw-http-host'],
    'functions/lead-alert-watchdog.js': ['raw-http-host'],
  };
  for (const f of files) {
    const r = SENDER.scan(fs.readFileSync(path.join(ROOT, f.rel), 'utf8'));
    const raw = r.sites.filter((s) => !s.guarded).length;
    const want = RAW_PINS[f.rel] ? RAW_PINS[f.rel][0] : 0;
    if (raw !== want) ok(f.rel + ': unguarded send sites = ' + raw + ' (pinned ' + want + ')', false, r.sites.filter((s) => !s.guarded).map((s) => 'line ' + s.line + ' ' + s.receiver).join('; '));
    const badBanned = r.banned.filter((b) => (BANNED_OK[f.rel] || []).indexOf(b.kind) === -1);
    if (badBanned.length) ok(f.rel + ': banned send shape', false, badBanned.map((b) => 'line ' + b.line + ' ' + b.kind + ' ' + b.text).join('; '));
  }
  ok('every pinned raw file really has that many raw sites (no stale pins)', Object.keys(RAW_PINS).every((rel) => {
    const r = SENDER.scan(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    return r.sites.filter((s) => !s.guarded).length === RAW_PINS[rel][0];
  }));

  // NEGATIVE FIXTURES: shapes a careless (or hostile) change could use. Each must be CAUGHT.
  const caught = (src) => { const r = SENDER.scan(src); return r.sites.some((s) => !s.guarded) || r.banned.length > 0; };
  const clean = (src) => { const r = SENDER.scan(src); return r.sites.length > 0 && r.sites.every((s) => s.guarded) && r.banned.length === 0; };
  ok('control: a guarded twilio client is clean', clean("const c = MessagingControls.guardTwilio(db, twilio(a, b));\nawait c.messages.create({ to, body });"));
  ok('control: an inline guarded resend chain is clean', clean("await MessagingControls.guardResend(db, new Resend(k)).emails.send({ to });"));
  ok('control: sending guardEmail output is clean', clean("const g = await MessagingControls.guardEmail(db, m);\nawait resend.emails.send(g.msg);"));
  ok('RAW twilio client is caught', caught("const c = twilio(a, b);\nawait c.messages.create({ to, body });"));
  ok('RAW resend is caught', caught("const r = new Resend(k);\nawait r.emails.send({ to });"));
  ok('a client re-assigned to a raw one AFTER the guarded one is caught (nearest assignment wins)',
    caught("let c = MessagingControls.guardTwilio(db, twilio(a, b));\nc = twilio(a, b);\nawait c.messages.create({ to, body });"));
  ok('destructuring the client is caught', caught("const { messages } = twilio(a, b);\nawait messages.create({ to });"));
  ok('aliasing .messages is caught', caught("const m = twilio(a, b).messages;\nawait m.create({ to });"));
  ok('bracket access is caught', caught("await twilio(a, b)['messages']['create']({ to });") || caught("await client.messages['create']({ to });"));
  ok('resend.batch.send is caught', caught("await resend.batch.send([{ to }]);"));
  ok('.bind on the send is caught', caught("const f = client.messages.create.bind(client.messages);"));
  ok('a raw fetch POST to api.resend.com is caught', caught("await fetch('https://api.resend.com/emails', { method: 'POST', body });"));
  ok('a raw fetch POST to api.twilio.com is caught', caught("await fetch('https://api.twilio.com/2010-04-01/Accounts/AC/Messages.json', { method: 'POST' });"));
  ok('a send that only appears in a comment is NOT a site', SENDER.scan("// await c.messages.create({})\nconst a = 1;").sites.length === 0);
}

// G. email_queue: the worker sends raw (RAW_PINS above) because every row is account mail to a contractor
//    or the owner. The set of files that can QUEUE a row is pinned, so a new writer (for example one that
//    queues a homeowner email) must be reviewed and added here on purpose.
{
  const QUEUE_WRITERS = ['backup-freshness.js', 'care-plan.js', 'health-digest.js', 'integrations/compliance.js',
    'messaging-controls-fns.js', 'monthly-overhead-alert.js', 'pro-prospects.js', 'stripe.js', 'tenant-ops.js'];
  const QUEUE_READERS = ['integrations/email-queue-worker.js', 'messaging-center.js'];
  const found = files.filter((f) => /email_queue['"\/`]/.test(stripJsComments(fs.readFileSync(path.join(ROOT, f.rel), 'utf8'))))
    .map((f) => f.rel.replace(/^functions\//, '')).filter((r) => QUEUE_READERS.indexOf(r) === -1).sort();
  ok('email_queue writers are exactly the reviewed account-mail set', JSON.stringify(found) === JSON.stringify(QUEUE_WRITERS.slice().sort()), found.join(', '));
}

// H. One-shot triggers (Cloud Function bodies, no test hook): a pause OR a canary redirect that lands AFTER the
//    pre-check (a flip between the pre-check and guardEmail) must release the claim, never leave it stamped emailed.
{
  for (const [rel, field] of [['estimate-email.js', 'estimateEmailedAt'], ['storm-report-email.js', 'reportEmailedAt']]) {
    const src = stripJsComments(fs.readFileSync(path.join(FN, rel), 'utf8'));
    const afterGuard = src.slice(src.indexOf('guardEmail('));
    const release = new RegExp(field + ': FieldValue\\.delete\\(\\)', 'g');
    ok(rel + ': releases the claim when the guard refuses AND when it redirects to the owner (canary)',
      (afterGuard.match(release) || []).length >= 2 && /gated\.canary/.test(afterGuard));
    // The per-recipient / global caps are spent only AFTER the guard says the send is real (a released send
    // must not burn them). estimate-email wraps them in spendCaps(); storm-report calls capRecipients inline.
    const spendAt = src.indexOf(rel === 'estimate-email.js' ? 'await spendCaps()' : 'AR.capRecipients(');
    ok(rel + ': recipient caps are spent after guardEmail, not before', spendAt > src.indexOf('guardEmail(') && src.indexOf('guardEmail(') > 0);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
