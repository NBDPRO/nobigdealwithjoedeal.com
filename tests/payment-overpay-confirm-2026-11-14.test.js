/**
 * payment-overpay-confirm-2026-11-14.test.js: a payment bigger than what is
 * owed asks first.
 *
 * Wave-1 money-path review (2026-11-14, finding 1): both Record Payment
 * sheets only checked amount > 0. $40,000 typed for a $4,000 check marked
 * the invoice paid and added $36,000 to Collected, with no prompt.
 *
 *   1. overpaymentNotice(amount, balanceCents): '' when the amount is within
 *      the balance; a plain question naming the amount, the extra and what
 *      is owed when it is over; a question when the balance is unknown.
 *   2. Both save handlers (the invoice's Record payment sheet and the
 *      customer page's Record payment sheet) ask BEFORE writing, and a "no"
 *      keeps the sheet open with nothing written.
 *
 * Run: node tests/payment-overpay-confirm-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

let IP = null;
try { IP = require(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js')); }
catch (e) { ok('loads invoice-pipeline.js', false, e && e.message); }

console.log('\n1. overpaymentNotice');
const fn = IP && IP.overpaymentNotice;
ok('overpaymentNotice is exported', typeof fn === 'function');
if (typeof fn === 'function') {
  ok('exactly the balance: no question', fn('4000', 400000) === '');
  ok('under the balance: no question', fn('1500.50', 400000) === '');
  const m = fn('40000', 400000);
  ok('over the balance: asks', typeof m === 'string' && m.length > 0, JSON.stringify(m));
  ok('names the amount typed', /\$40,000\.00/.test(m), m);
  ok('names how much more than owed', /\$36,000\.00/.test(m), m);
  ok('names what is owed', /\$4,000\.00/.test(m), m);
  const paid = fn('250', 0);
  ok('nothing owed (paid invoice): any amount asks', /nothing is owed/i.test(paid), paid);
  const unk = fn('500', null);
  ok('balance unknown: asks rather than waving it through', typeof unk === 'string' && /check/i.test(unk), unk);
  ok('one cent over asks', fn('4000.01', 400000) !== '');
  ok('comma-free decimal strings parse in cents (no float drift)', fn('0.30', 30) === '');
}

console.log('\n2. Both save handlers ask before they write');
function handler(startNeedle, writeNeedle) {
  const a = SRC.indexOf(startNeedle);
  if (a < 0) return null;
  const w = SRC.indexOf(writeNeedle, a);
  return w < 0 ? null : SRC.slice(a, w);
}
const mp = handler("saveBtn.onclick = async () => {\n        const amount = $('#nbd-mp-amount').value;", 'await markPaid(invoiceId, amount');
ok('invoice sheet: handler found', mp != null);
ok('invoice sheet: asks overpaymentNotice before markPaid', !!mp && /overpaymentNotice\(/.test(mp));
ok('invoice sheet: a "no" returns before writing', !!mp && /if \(!\(await _askOverpay\(/.test(mp));
const rp = handler("const amount = $('#nbd-rp-amount').value;", 'await recordPaymentCommit(');
ok('customer sheet: handler found', rp != null);
ok('customer sheet: asks overpaymentNotice before recordPaymentCommit', !!rp && /overpaymentNotice\(/.test(rp));
ok('customer sheet: a "no" returns before writing', !!rp && /if \(!\(await _askOverpay\(/.test(rp));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
