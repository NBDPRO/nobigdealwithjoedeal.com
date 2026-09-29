/**
 * tests/notify-new-lead-email-escape-2026-09-29.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * notifyNewLead (functions/verify-functions.js) is a public callable. The
 * estimate funnel sends it a name, phone, email and address, and it emails
 * Joe an HTML card built from them. They went into that HTML raw, so a
 * submitter could put links or markup in Joe's inbox. The tel: links also
 * used `phone.replace(/\\D/g, '')` INSIDE the template expression, where the
 * doubled backslash makes the regex match a literal backslash + D. It
 * stripped nothing, so the raw phone text landed inside href="tel:…".
 *
 * Drives the real handler with firebase / twilio / resend / rate-limit
 * stubbed, and asserts on the HTML handed to Resend.
 * Run: node tests/notify-new-lead-email-escape-2026-09-29.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const sent = [];
const STUBS = {
  'firebase-functions/v2/https': {
    onCall: (opts, fn) => fn || opts,
    HttpsError: class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } },
  },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'stub-' + n }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  'firebase-admin/firestore': {
    getFirestore: () => ({ doc: () => ({ get: async () => ({ exists: false }) }), collection: () => ({ doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }) }) }),
    FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n },
  },
  twilio: () => ({ messages: { create: async () => ({}) } }),
  resend: { Resend: function () { this.emails = { send: async (p) => { sent.push(p); return { data: { id: 'x' }, error: null }; } }; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  if (/[\\/]rate-limit$/.test(request) || request === './rate-limit') return { enforceRateLimit: async () => {}, clientIp: () => '203.0.113.9' };
  if (request === './integrations/_shared') return { secretOr: (s, fb) => fb || 'joe@example.com' };
  if (request === './resend-guard') return { resendRejected: () => false, resendErrorMessage: () => '' };
  return realLoad.apply(this, arguments);
};

(async () => {
  const VF = require(path.join(__dirname, '..', 'functions', 'verify-functions.js'));
  const handler = VF.notifyNewLead;
  ok('harness: notifyNewLead is the raw handler', typeof handler === 'function');

  await handler({
    rawRequest: {},
    data: {
      name: 'Pat <a href="https://evil.example">refund</a>',
      phone: '(513) 555-0100"><img src=x>',
      email: 'x@example.com"><b>',
      address: '1 Main <script>St</script>',
      service: '<i>custom</i>',
      timeline: 'asap',
    },
  });
  const html = (sent[0] && sent[0].html) || '';
  ok('the email to Joe was built and sent', !!html, String(sent.length));
  ok('no live link from the name', !/<a href="https:\/\/evil\.example"/.test(html));
  ok('the name shows escaped', /Pat &lt;a href=&quot;https:\/\/evil\.example&quot;&gt;refund&lt;\/a&gt;/.test(html));
  ok('no raw <script> from the address', !/<script>St<\/script>/.test(html) && /&lt;script&gt;/.test(html));
  ok('no raw <img> from the phone', !/<img src=x>/.test(html));
  ok('tel: links carry digits only', /href="tel:5135550100"/.test(html) && !/href="tel:[^"]*[^0-9"]/.test(html), (html.match(/href="tel:[^"]*"/g) || []).join(' '));
  ok('an unknown service label is escaped', !/<i>custom<\/i>/.test(html));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
