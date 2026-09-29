/**
 * tests/refunds-in-revenue-2026-09-29.test.js
 *
 * Revenue is money COLLECTED (Jo, 2026-09-28). A refund or a lost chargeback
 * is money that went back — it must come off revenue on the day it happened.
 * Before this, the four revenue readers skipped anything <= 0, so the Stripe
 * ledger recorded refunds on the invoice (invoices.refunds[]) and revenue
 * never moved.
 *
 *   1. the real NBDRevenue (collected-revenue.js) in a vm
 *   2. the other three readers carry the IDENTICAL refundsOf helper and wrap
 *      paymentsOf with it (they are copies by design; this keeps them honest)
 *   3. the Stripe ledger writes lost disputes onto refunds[] and updates a
 *      refund whose status changed
 *
 * Run: node tests/refunds-in-revenue-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const win = {};
vm.runInNewContext(read('docs/pro/js/collected-revenue.js'), { window: win, console, Date, Math, JSON, parseFloat, isNaN, Array, Object });
const R = win.NBDRevenue;

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 16));
const sep = [D(2026, 9, 1).getTime(), D(2026, 9, 30).getTime()];
const oct = [D(2026, 10, 1).getTime(), D(2026, 10, 31).getTime()];

console.log('\n1. NBDRevenue subtracts refunds on their own date');
{
  const inv = { total: 1000, balanceDue: 0, payments: [{ amount: 1000, at: D(2026, 9, 10) }],
    refunds: [{ amount: 250, at: D(2026, 10, 3), stripeRef: 're_1', status: 'succeeded', kind: 'refund' }] };
  const p = R.paymentsOf(inv);
  ok('paymentsOf lists the payment and the refund (negative, tagged)', p.length === 2 && p[1].amount === -250 && p[1].refund === true);
  const s = R.collectedBetween([inv], sep[0], sep[1]);
  ok('September keeps the full $1,000 it collected', s.total === 1000 && s.count === 1);
  const o = R.collectedBetween([inv], oct[0], oct[1]);
  ok('October shows −$250 (the month the money went back)', o.total === -250);
  ok('...and a refund is not counted as a payment', o.count === 0);
  const all = R.collectedBetween([inv], null, null);
  ok('lifetime revenue nets to $750', all.total === 750);

  const failedRefund = Object.assign({}, inv, { refunds: [{ amount: 250, at: D(2026, 10, 3), status: 'failed' }] });
  ok('a FAILED refund returned nothing — revenue stays $1,000', R.collectedBetween([failedRefund], null, null).total === 1000);
  const wonDispute = Object.assign({}, inv, { refunds: [{ amount: 1000, at: D(2026, 10, 3), status: 'won', kind: 'dispute_lost' }] });
  ok('a dispute Jo WON takes nothing off', R.collectedBetween([wonDispute], null, null).total === 1000,
    'got ' + R.collectedBetween([wonDispute], null, null).total);
  const lost = Object.assign({}, inv, { refunds: [{ amount: 1000, at: D(2026, 10, 3), status: 'lost', kind: 'dispute_lost' }] });
  ok('a LOST chargeback takes the whole payment back', R.collectedBetween([lost], null, null).total === 0);

  const legacy = { total: 600, balanceDue: 0, paidAt: D(2026, 9, 5), refunds: [{ amount: 100, at: D(2026, 9, 20), status: 'succeeded' }] };
  ok('an invoice with no payments[] (legacy lump) still nets its refund', R.collectedBetween([legacy], sep[0], sep[1]).total === 500);
  const partial = { total: 1000, balanceDue: 400, amountPaid: 600, payments: [{ amount: 300, at: D(2026, 9, 2) }], lastPaymentAt: D(2026, 9, 9),
    refunds: [{ amount: 50, at: D(2026, 9, 25), status: 'succeeded' }] };
  ok('the pre-ledger remainder math is untouched (600 collected − 50 refunded)', R.collectedBetween([partial], null, null).total === 550);
  ok('no refunds[] → unchanged behaviour', R.collectedBetween([{ total: 10, balanceDue: 0, payments: [{ amount: 10, at: D(2026, 9, 1) }] }], null, null).total === 10);
  ok('junk refund rows are ignored (no amount, no date, negative)',
    R.collectedBetween([Object.assign({}, inv, { refunds: [{}, { amount: 5 }, { amount: -5, at: D(2026, 9, 3) }, null] })], null, null).total === 1000);
}

console.log('\n2. the three copies carry the same helper');
{
  const norm = (src) => {
    const a = src.indexOf('function refundsOf(inv) {');
    if (a < 0) return null;
    let depth = 0, i = src.indexOf('{', a);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(a, i + 1).replace(/\b(var|let|const)\b/g, 'V').replace(/\s+/g, ' ');
  };
  const canon = norm(read('docs/pro/js/collected-revenue.js'));
  for (const f of ['docs/pro/js/money-dashboard.js', 'docs/pro/js/analytics-kpi.js', 'docs/pro/js/pages/leaderboard.js']) {
    const src = read(f);
    ok(f + ': identical refundsOf', norm(src) === canon);
    ok(f + ': paymentsOf = paymentsOnlyOf + refundsOf', /function paymentsOf\(inv\) \{\s*return paymentsOnlyOf\(inv\)\.concat\(refundsOf\(inv\)\);\s*\}/.test(src));
  }
  const kpi = read('docs/pro/js/analytics-kpi.js');
  ok('analytics "last payment date" ignores refunds', /function paymentDateOf\(inv\) \{[\s\S]{0,160}paymentsOnlyOf\(inv\)/.test(kpi));
}

console.log('\n3. the Stripe ledger records money going back');
(async () => {
  process.env.NBD_OWNER_UID = 'OWNER';
  const X = require(path.join(ROOT, 'functions', 'stripe-ledger.js'))._internal;
  const docs = { 'invoices/I1': { total: 1000, amountPaid: 1000, balanceDue: 0, payments: [{ amount: 1000 }] }, 'stripeLedger/ch_1': { match: { leadId: 'L1', invoiceId: 'I1', leadName: 'ZZ_QA' }, party: { name: 'ZZ_QA' } } };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const ref = (p) => ({
    async get() { return { exists: !!docs[p], data: () => clone(docs[p]) }; },
    async set(d, o) { docs[p] = o && o.merge && docs[p] ? Object.assign(clone(docs[p]), clone(d)) : clone(d); },
    async update(d) { docs[p] = Object.assign(clone(docs[p]), clone(d)); },
  });
  const db = {
    collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
    async runTransaction(fn) { const ops = []; const out = await fn({ get: (r) => r.get(), update: (r, d) => ops.push(() => r.update(d)), set: (r, d) => ops.push(() => r.set(d)) }); for (const o of ops) await o(); return out; },
  };
  const ctx = { db, leads: new Map(), idx: null, invoicesByLead: new Map(), invoicesById: new Map() };
  await X.ingestDispute(ctx, { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 100000, status: 'lost', created: 1790000000, status_transitions: { closed_at: 1790500000 } });
  let inv = docs['invoices/I1'];
  ok('a lost dispute lands on the invoice as money back, dated when it closed', inv.refunds.length === 1 && inv.refunds[0].kind === 'dispute_lost' && inv.refunds[0].amount === 1000 && inv.refundedTotal === 1000
    && new Date(inv.refunds[0].at).getTime() === 1790500000000);
  ok('...and leaves payments[] / amountPaid alone', inv.payments.length === 1 && inv.amountPaid === 1000);
  ok('a closed dispute leaves the review list; an open one would not', docs['stripeLedger/dp_1'].needsReview === false);
  await X.ingestDispute(ctx, { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 100000, status: 'won', created: 1790000000, status_transitions: { closed_at: 1790600000 } });
  inv = docs['invoices/I1'];
  ok('reversed to WON → the same entry updates, nothing counted back', inv.refunds.length === 1 && inv.refunds[0].status === 'won' && inv.refundedTotal === 0);
  await X.recordMoneyBack(ctx, 'I1', { stripeRef: 're_9', cents: 5000, atMs: 1790700000000, status: 'succeeded', kind: 'refund' });
  await X.recordMoneyBack(ctx, 'I1', { stripeRef: 're_9', cents: 5000, atMs: 1790700000000, status: 'succeeded', kind: 'refund' });
  inv = docs['invoices/I1'];
  ok('the same refund twice is recorded once', inv.refunds.filter((r) => r.stripeRef === 're_9').length === 1 && inv.refundedTotal === 50);
  await X.recordMoneyBack(ctx, 'I1', { stripeRef: 're_9', cents: 5000, atMs: 1790700000000, status: 'failed', kind: 'refund' });
  inv = docs['invoices/I1'];
  ok('a refund that later FAILED updates in place and stops counting', inv.refunds.find((r) => r.stripeRef === 're_9').status === 'failed' && inv.refundedTotal === 0);
  await X.ingestDispute(ctx, { id: 'dp_2', object: 'dispute', charge: 'ch_1', amount: 20000, status: 'needs_response', created: 1790800000 });
  ok('an OPEN dispute takes nothing off yet and asks for review', docs['invoices/I1'].refunds.length === 2 && docs['stripeLedger/dp_2'].needsReview === true);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
