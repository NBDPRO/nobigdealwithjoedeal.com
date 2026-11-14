/**
 * tests/catchup-undo-other-payment-2026-11-14.test.js
 *
 * "Catch up my numbers" Undo restores the invoice's PRE-payment ledger
 * (payments[], amountPaid, balanceDue, status, paidAt) captured when the
 * catch-up payment was logged, or deletes an invoice the catch-up created.
 * paymentUndoBlocked only refused when a STRIPE payment had landed since, so
 * a manual payment recorded afterwards (another device, the customer page's
 * Record Payment sheet) was silently wiped while the toast said "Undone".
 * The catch-up adds exactly one payment entry, so more than that refuses.
 *
 * Run: node tests/catchup-undo-other-payment-2026-11-14.test.js
 */
'use strict';

const path = require('path');
const CL = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'catchup-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const pay = (amount, method) => ({ amount, method: method || 'check', at: '2026-11-01' });
const before = { amountPaid: 0, balanceDue: 2000, status: 'sent', payments: [] };
const B = CL.paymentUndoBlocked;

console.log('\nUndo of a catch-up payment on an EXISTING invoice');
{
  const entry = { invoiceId: 'A', created: false, restore: before };
  ok('control: only the catch-up payment since → undo allowed', B({ payments: [pay(1000)] }, entry) === '');
  const why = B({ payments: [pay(1000), pay(500, 'check')] }, entry);
  ok('a manual $500 recorded after it → undo refused', why !== '', why);
  ok('…with a reason the owner can act on', /payment was recorded on this invoice since/i.test(why));
  const entry2 = { invoiceId: 'A', created: false, restore: { payments: [pay(300)] } };
  ok('control: an earlier payment that was already there does not block', B({ payments: [pay(300), pay(1000)] }, entry2) === '');
  ok('…but one more after the catch-up does', B({ payments: [pay(300), pay(1000), pay(50)] }, entry2) !== '');
}

console.log('\nUndo of a catch-up payment that CREATED the invoice (undo deletes it)');
{
  const entry = { invoiceId: 'C', created: true, restore: null };
  ok('control: just the catch-up payment → delete allowed', B({ payments: [pay(2000)] }, entry) === '');
  ok('a second payment since → delete refused', B({ payments: [pay(2000), pay(100)] }, entry) !== '');
}

console.log('\nThe Stripe guard still works');
{
  const entry = { invoiceId: 'A', created: false, restore: before };
  const why = B({ payments: [pay(1000), { amount: 500, stripeRef: 'ch_1', source: 'stripe_ledger' }] }, entry);
  ok('a Stripe payment since → refused with the Stripe reason', /Stripe payment/.test(why), why);
  ok('gone / missing input → not blocked (the caller handles a missing invoice)', B(null, entry) === '' && B({ payments: [] }, null) === '');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
