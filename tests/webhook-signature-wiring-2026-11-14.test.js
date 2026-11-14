/**
 * tests/webhook-signature-wiring-2026-11-14.test.js
 *
 * tests/webhook-signatures.test.js exercises the Stripe and Twilio SDKs, not
 * our handlers: replacing stripeWebhook's constructEvent with
 * JSON.parse(req.rawBody) left every suite green (vacuous-test audit,
 * 2026-11-14). These pins read each Stripe webhook's comment-stripped source
 * and require: the event comes from constructEvent over the RAW body with the
 * signature header and a 300 s tolerance; a failed verification answers 400
 * and returns; and nothing reads the event before that.
 *
 * Run: node tests/webhook-signature-wiring-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; fails.push(label); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
function handler(file, name) {
  const src = strip(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const i = src.indexOf('exports.' + name + ' = onRequest(');
  if (i === -1) return '';
  const j = src.indexOf('\nexports.', i + 10);
  return src.slice(i, j === -1 ? undefined : j);
}

const CASES = [
  // [file, export, signature variable, how a failed verification is detected]
  ['functions/stripe.js', 'stripeWebhook', 'sig'],
  ['functions/stripe.js', 'invoiceWebhook', 'signature'],
  ['functions/handlers/stripe-connect.js', 'stripeConnectWebhook', 'sig'],
];

for (const [file, name, sigVar] of CASES) {
  console.log('\n' + name + ' (' + file + ')');
  const b = handler(file, name);
  ok('handler found', b.length > 300);
  const re = new RegExp('event = (?:stripe|getStripe\\(\\))\\.webhooks\\.constructEvent\\(req\\.rawBody, ' + sigVar + ', \\w+, 300\\)');
  const m = re.exec(b);
  ok('event = …webhooks.constructEvent(req.rawBody, ' + sigVar + ', <secret>, 300)', !!m);
  ok('no req.body fallback is handed to constructEvent', !/constructEvent\(\s*req\.rawBody\s*\|\|/.test(b) && !/constructEvent\(\s*req\.body/.test(b));
  ok('rawBody must be a Buffer or the request is refused', /if \(!req\.rawBody \|\| !Buffer\.isBuffer\(req\.rawBody\)\)/.test(b));
  const at = m ? m.index : -1;
  const after = at === -1 ? '' : b.slice(at, at + 600);
  ok('a failed verification answers 400 and returns', /res\.status\(400\)[\s\S]{0,120}?return;/.test(after));
  const firstUse = b.search(/event\.(type|id|data|account)\b/);
  ok('nothing reads the event before it is verified', at !== -1 && firstUse !== -1 && firstUse > at);
  ok('the event is never parsed from the body directly', !/event = JSON\.parse\(/.test(b));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
