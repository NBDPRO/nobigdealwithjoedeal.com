/**
 * tests/public-invoker-2026-10-02.test.js
 *
 * Browser-facing HTTP functions must DECLARE invoker: 'public'.
 *
 * Gen2 functions run on Cloud Run, which checks IAM before any code runs. A
 * service without the allUsers run.invoker binding answers 403 to every
 * browser request, because a Firebase ID token is not an IAM credential. The
 * handler's own auth check never gets the chance to run.
 *
 * A read-only sweep (2026-10-02) of all 137 https/callable services found
 * four without the binding:
 *   - cspReport: 261 of 261 reports in a week were 403'd;
 *   - sendEmail and sendSMS (sendQueuedSMS, with the same options, still
 *     had it);
 *   - extractReceiptData.
 * Declaring invoker: 'public' on an onRequest function makes every deploy
 * re-apply the binding (the 2026-07-16 Stripe fix, functions/stripe.js).
 *
 * NOT covered here: onCall ignores `invoker` (firebase-functions only reads
 * it for onRequest), and the CLI makes a callable public only when it is
 * created. A callable that loses the binding (extractReceiptData) needs a
 * one-off IAM grant, not code. See documentation/audit/PUBLIC-INVOKER-SWEEP-2026-10-02.md.
 *
 * Run: node tests/public-invoker-2026-10-02.test.js
 */
'use strict';

const path = require('path');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'nobigdeal-pro', storageBucket: 'nobigdeal-pro.appspot.com' });

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const quiet = console.log;
console.log = () => {};
let fns;
try { fns = require(path.join(__dirname, '..', 'functions', 'index.js')); } finally { console.log = quiet; }

console.log('\nPUBLIC INVOKER — browser-facing onRequest functions declare it');
// Called from the browser (or by browsers on their own, for CSP reports).
// Each one enforces its own auth in the handler: an ID token plus role for
// email/SMS, and a rate limit plus size cap for cspReport.
const MUST_BE_PUBLIC = ['cspReport', 'sendEmail', 'sendSMS', 'sendQueuedSMS'];
for (const name of MUST_BE_PUBLIC) {
  const ep = fns[name] && fns[name].__endpoint;
  const inv = ep && ep.httpsTrigger && ep.httpsTrigger.invoker;
  ok(name + ' is an onRequest function that declares invoker: public',
    !!ep && !!ep.httpsTrigger && Array.isArray(inv) && inv.includes('public'), JSON.stringify(ep && ep.httpsTrigger));
}

// The code-level guard these rely on: auth still happens in the handler.
const fs = require('fs');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'functions', p), 'utf8');
ok('sendEmail still verifies the caller (401 without a valid ID token)', /res\.status\(401\)/.test(read('email-functions.js')) && /verifyIdToken/.test(read('email-functions.js')));
ok('sendSMS still verifies the caller (401 without a valid ID token)', /res\.status\(401\)/.test(read('sms-functions.js')) && /verifyIdToken/.test(read('sms-functions.js')));
ok('cspReport keeps its per-IP rate limit', /httpRateLimit\(req, res, 'cspReport:ip'/.test(read('handlers/monitoring.js')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
process.exit(0);
