/**
 * tests/stripe-ledger-logic-2026-09-29.test.js
 *
 * The pure rules of the Stripe ledger (functions/stripe-ledger-logic.js):
 * matching a Stripe customer to a CRM lead, picking the CRM invoice a payment
 * pays, idempotent credits, and the ledger rows. Synthetic data only — the
 * repo is public — but shaped like the real account: Stripe invoices built by
 * hand in the dashboard, NBD numbers in custom fields, a couple on one
 * invoice, a street with a directional, a PO box.
 *
 * Run: node tests/stripe-ledger-logic-2026-09-29.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'stripe-ledger-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const leads = [
  { id: 'L1', firstName: 'Zed', lastName: 'Qalander', email: 'zq@example.com', phone: '(513) 555-0101', address: '5760 Farm Field Dr, Cincinnati, OH 45040' },
  { id: 'L2', firstName: 'Mary', lastName: 'Quorn', email: '', phone: '513-555-0202', address: '929 W Wolfram St Apt 3, Chicago IL' },
  { id: 'L3', firstName: 'Pat', lastName: 'Quorn', email: 'pq@example.com', phone: '513-555-0202', address: '12 Other Rd' },
  { id: 'L4', firstName: 'Ann', lastName: 'Zyzzle', address: '44 Main Street, Newport KY', stripeCustomerId: 'cus_KNOWN' },
  { id: 'L5', firstName: 'Old', lastName: 'Gone', email: 'gone@example.com', deleted: true },
  { id: 'L6', firstName: 'Bo', lastName: 'Vandal', email: 'bo@example.com', phone: '', address: 'PO Box 12164, Cincinnati OH' },
];
const idx = L.buildLeadIndex(leads);

console.log('\n1. normalizers');
ok('phone keeps the last 10 digits', L.normPhone('+1 (513) 555-0101') === '5135550101' && L.normPhone('555-0101') === '');
ok('address key: number + first street word, "Drive" = "Dr"', L.addressKey('5760 Farm Field Drive') === '5760 farm' && L.addressKey('5760 Farm Field Dr, Cincinnati OH 45040') === '5760 farm');
ok('address key skips a leading directional', L.addressKey('929 W Wolfram St') === '929 wolfram');
ok('a PO box has no address key', L.addressKey('PO Box 12164, Cincinnati') === '');

console.log('\n2. matching a Stripe customer to a lead');
{
  let m = L.matchLead({ email: 'ZQ@Example.com ' }, idx);
  ok('email, case/space-insensitive → high', m.leadId === 'L1' && m.confidence === 'high' && m.method === 'email');
  m = L.matchLead({ phone: '5135550101' }, idx);
  ok('phone → high', m.leadId === 'L1' && m.confidence === 'high');
  m = L.matchLead({ address: '5760 Farm Field Drive, Cincinnati OH' }, idx);
  ok('house number + street → high', m.leadId === 'L1' && m.confidence === 'high');
  m = L.matchLead({ stripeCustomerId: 'cus_KNOWN', email: 'someone-else@example.com' }, idx);
  ok('a Stripe customer already linked to a lead wins', m.leadId === 'L4' && m.method === 'stripe_customer');
  m = L.matchLead({ leadIdHint: 'L6' }, idx);
  ok('an explicit lead id (metadata / manual) wins', m.leadId === 'L6' && m.method === 'metadata');
  m = L.matchLead({ leadIdHint: 'L5' }, idx);
  ok('a deleted lead is never a match', m.leadId !== 'L5');

  m = L.matchLead({ phone: '513-555-0202', name: 'Mary Quorn' }, idx);
  ok('two leads share a phone: ambiguous → suggestion (name picks), never booked', m.confidence === 'suggest' && m.leadId === 'L2' && m.candidates.length === 2);
  m = L.matchLead({ phone: '513-555-0202', email: 'pq@example.com' }, idx);
  ok('...but a second strong key breaks the tie → high', m.leadId === 'L3' && m.confidence === 'high');
  m = L.matchLead({ phone: '513-555-0202', address: '929 W Wolfram St Apt 3' }, idx);
  ok('phone + address narrow to one → high', m.leadId === 'L2' && m.confidence === 'high');

  m = L.matchLead({ name: 'Emily & Zed Qalander' }, idx);
  ok('name only (a couple on one invoice) → suggestion, not booked', m.leadId === 'L1' && m.confidence === 'suggest' && m.method === 'name');
  m = L.matchLead({ name: 'Zed Qalandr' }, idx);
  ok('a misspelled name is not a match', m.confidence === 'none');
  m = L.matchLead({ name: 'Nobody Here' }, idx);
  ok('an unknown customer → none (review list)', m.confidence === 'none' && m.leadId === null);
  m = L.matchLead({ email: 'nomatch@example.com', phone: '5135550101' }, idx);
  ok('an unknown email does not block a phone match', m.leadId === 'L1' && m.confidence === 'high');
}

console.log('\n3. which CRM invoice a payment pays');
{
  const invs = [
    { id: 'I1', total: 1825, balanceDue: 1825, status: 'sent' },
    { id: 'I2', total: 600, balanceDue: 0, status: 'paid' },
  ];
  ok('the open invoice whose balance equals the payment', L.pickInvoice(invs, { amountCents: 182500 }).invoiceId === 'I1');
  ok('the only open invoice takes a partial', L.pickInvoice(invs, { amountCents: 50000 }).invoiceId === 'I1');
  ok('more than it owes → no guess (mirror instead)', L.pickInvoice(invs, { amountCents: 200000 }).invoiceId === null);
  const two = [{ id: 'A', total: 500, balanceDue: 500 }, { id: 'B', total: 900, balanceDue: 900 }];
  ok('two open jobs, payment fits neither exactly → no guess', L.pickInvoice(two, { amountCents: 30000 }).invoiceId === null);
  ok('two open jobs, one exact → that one', L.pickInvoice(two, { amountCents: 90000 }).invoiceId === 'B');
  ok('already linked to this Stripe invoice → that one, even if paid',
    L.pickInvoice([{ id: 'X', total: 1, balanceDue: 0, stripeInvoiceId: 'in_1' }], { stripeInvoiceId: 'in_1', amountCents: 100 }).invoiceId === 'X');
  ok('a deleted invoice is never picked', L.pickInvoice([{ id: 'D', total: 5, balanceDue: 5, deleted: true }], { amountCents: 500 }).invoiceId === null);
}

console.log('\n4. crediting is idempotent');
{
  const inv = { total: 1825, amountPaid: 0, balanceDue: 1825, depositAmount: 912.5, payments: [] };
  const c = L.planCredit(inv, { key: 'ch_A', amountCents: 100000, atMs: Date.UTC(2026, 8, 17), method: 'apple_pay', paymentIntentId: 'pi_A' });
  ok('first credit: $1,000 of $1,825 → partial, deposit met', c && c.amountPaid === 1000 && c.balanceDue === 825 && c.status === 'partial' && c.depositPaid === true);
  ok('the payment entry is dollars, dated, tagged', c.payment.amount === 1000 && c.payment.method === 'apple_pay' && c.payment.stripeRef === 'ch_A' && c.payment.at instanceof Date);
  const after = Object.assign({}, inv, { amountPaid: c.amountPaid, balanceDue: c.balanceDue, stripeCreditKeys: c.keys });
  ok('the same charge again (retry / reconcile / backfill) → nothing', L.planCredit(after, { key: 'ch_A', amountCents: 100000, atMs: 1 }) === null);
  ok('a payment the payment-link path already credited → nothing',
    L.planCredit({ total: 10, amountPaid: 10, paidIntentIds: ['pi_Z'] }, { key: 'ch_Z', amountCents: 1000, atMs: 1, paymentIntentId: 'pi_Z' }) === null);
  const done = L.planCredit(after, { key: 'ch_B', amountCents: 82500, atMs: 2 });
  ok('the rest → paid, balance 0', done.status === 'paid' && done.balanceDue === 0 && done.paid === true && done.keys.join() === 'ch_A,ch_B');
  ok('cents math: $1,234.565 style amounts round once', L.cents('1234.565') === 123457 && L.cents(0.1 + 0.2) === 30);
  ok('zero / negative never credits', L.planCredit(inv, { key: 'x', amountCents: 0, atMs: 1 }) === null);
  const over = L.planCredit({ total: 100, amountPaid: 0 }, { key: 'k', amountCents: 15000, atMs: 1 });
  ok('an overpayment is recorded and reported, balance floors at 0', over.balanceDue === 0 && over.overpaidCents === 5000);
}

console.log('\n4b. money Jo already recorded by hand is never counted twice');
{
  const sep17 = Date.UTC(2026, 8, 17);
  const handPaid = [{ id: 'H', total: 1825, balanceDue: 0, payments: [{ amount: 1825, at: new Date(sep17 + 86400000), method: 'check' }] }];
  ok('same amount, manual payment within 14 days → the duplicate', (L.findManualDuplicate(handPaid, { amountCents: 182500, atMs: sep17 }) || {}).invoiceId === 'H');
  ok('Firestore Timestamp-shaped dates work too',
    (L.findManualDuplicate([{ id: 'T', payments: [{ amount: 1825, at: { seconds: sep17 / 1000 } }] }], { amountCents: 182500, atMs: sep17 }) || {}).invoiceId === 'T');
  ok('a different amount is not a duplicate', L.findManualDuplicate(handPaid, { amountCents: 182400, atMs: sep17 }) === null);
  ok('a payment 30 days away is not a duplicate', L.findManualDuplicate(handPaid, { amountCents: 182500, atMs: sep17 + 30 * 86400000 }) === null);
  ok('a payment the ledger itself booked is not "by hand"',
    L.findManualDuplicate([{ id: 'S', payments: [{ amount: 1825, at: new Date(sep17), source: 'stripe_ledger', stripeRef: 'ch_x' }] }], { amountCents: 182500, atMs: sep17 }) === null);
  ok('a pre-ledger invoice marked paid (no payments[]) with the same total, paid that week',
    (L.findManualDuplicate([{ id: 'P', total: 600, balanceDue: 0, paidAt: new Date(sep17) }], { amountCents: 60000, atMs: sep17 + 86400000 }) || {}).invoiceId === 'P');
}

console.log('\n5. ledger rows from Stripe objects');
{
  const ch = {
    id: 'ch_1', object: 'charge', status: 'succeeded', amount: 145000, amount_captured: 145000, amount_refunded: 0, created: 1790000000,
    balance_transaction: { fee: 4235, net: 140765 }, payment_intent: { id: 'pi_1', metadata: {} }, invoice: 'in_9',
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', wallet: { type: 'apple_pay' } } },
    customer: { id: 'cus_1', name: 'Zed Qalander', email: 'zq@example.com', phone: null, address: { line1: '5760 Farm Field Dr', postal_code: '45040' } },
    billing_details: {}, receipt_url: 'https://pay.stripe.test/r',
  };
  const e = L.chargeEntry(ch, 'OWNER');
  ok('charge row: amount, fee, net, method, invoice link', e.amountCents === 145000 && e.feeCents === 4235 && e.netCents === 140765
    && e.method === 'apple_pay' && e.stripeInvoiceId === 'in_9' && e.companyId === 'OWNER' && e.atMs === 1790000000000);
  ok('charge row carries the customer for matching', e.party.stripeCustomerId === 'cus_1' && e.party.email === 'zq@example.com' && /5760 Farm Field Dr/.test(e.party.address));
  const failedCh = Object.assign({}, ch, { status: 'failed', amount_captured: 0, failure_message: 'Your card was declined.' });
  ok('a failed attempt books $0 but keeps what was tried and why', L.chargeEntry(failedCh, 'O').amountCents === 0 && L.chargeEntry(failedCh, 'O').attemptedCents === 145000 && /declined/.test(L.chargeEntry(failedCh, 'O').failure));
  ok('Link / Cash App methods come through as-is', L.methodOfCharge({ payment_method_details: { type: 'link' } }) === 'link');
  ok('a CRM payment-link charge keeps its CRM invoice id', L.chargeEntry(Object.assign({}, ch, { payment_intent: { id: 'pi_2', metadata: { invoiceId: 'CRM1' } } }), 'O').crmInvoiceIdHint === 'CRM1');
  ok('a refund is negative money', L.refundEntry({ amount: 5000, created: 1, status: 'succeeded', charge: 'ch_1' }, 'O').amountCents === -5000);
  ok('a dispute is negative money', L.disputeEntry({ amount: 5000, created: 1, status: 'needs_response', charge: 'ch_1' }, 'O').amountCents === -5000);
  ok('a payout is never matched to a customer', L.payoutEntry({ amount: 9000, arrival_date: 2, status: 'paid' }, 'O').party === null);

  const oob = { id: 'in_O', object: 'invoice', status: 'paid', amount_paid: 60000, paid_out_of_band: true, charge: null, payment_intent: null, created: 5,
    status_transitions: { paid_at: 10 }, customer: 'cus_X', customer_name: 'Zed Qalander', customer_email: 'zq@example.com', customer_address: { line1: '1 A St' } };
  ok('an invoice marked paid in Stripe with no charge is recognized', L.isPaidOutOfBand(oob) === true);
  ok('...and a card-paid invoice is not', L.isPaidOutOfBand(Object.assign({}, oob, { paid_out_of_band: false, charge: 'ch_1' })) === false);
  const oe = L.outOfBandEntry(oob, 'O');
  ok('its row books the money, dated when it was marked paid', oe.amountCents === 60000 && oe.atMs === 10000 && oe.method === 'marked_paid_in_stripe' && oe.party.email === 'zq@example.com');
}

console.log('\n6. NBD invoice numbers + mirrored CRM invoices');
{
  ok('NBD number from a custom field', L.nbdNumberOf({ custom_fields: [{ name: 'Invoice No.', value: 'NBD-2026-0917-ZQAL' }] }) === 'NBD-2026-0917-ZQAL');
  ok('NBD number from metadata under any key', L.nbdNumberOf({ metadata: { nbd_instance: 'NBD-2026-0919-ZZZ' } }) === 'NBD-2026-0919-ZZZ');
  ok('NBD number as the Stripe invoice number itself', L.nbdNumberOf({ number: 'NBD-2026-0903-ZZQA' }) === 'NBD-2026-0903-ZZQA');
  ok('no NBD number → null', L.nbdNumberOf({ number: 'ABCD-0001' }) === null);
  const sInv = { object: 'invoice', id: 'in_M', number: 'X-0001', total: 182500, subtotal: 192500, created: 1789652222, due_date: 1789703999,
    hosted_invoice_url: 'https://invoice.stripe.test/i', invoice_pdf: 'https://pay.stripe.test/pdf', custom_fields: [{ value: 'NBD-2026-0917-ZQAL' }],
    lines: { data: [{ description: 'Siding repair', amount: 180000, quantity: 1 }, { description: 'Walk & caulk', amount: 12500, quantity: 1 }, { description: 'Marketing discount', amount: -10000, quantity: 1 }] } };
  const m = L.mirrorInvoice(sInv, leads[0], 'OWNER', 1790000000000);
  ok('mirror: the lead, the lines, the total, owed until credited', m.leadId === 'L1' && m.items.length === 3 && m.total === 1825 && m.balanceDue === 1825 && m.amountPaid === 0);
  ok('mirror: a real Stripe invoice id + links + NBD number, marked source=stripe', m.stripeInvoiceId === 'in_M' && m.stripeHostedUrl && m.stripePdfUrl && m.nbdInvoiceNumber === 'NBD-2026-0917-ZQAL' && m.source === 'stripe');
  ok('mirror: tenant-stamped for the rules', m.companyId === 'OWNER' && m.createdBy === 'OWNER');
  ok('mirror: lines in the CRM shape (unitPrice + total — the detail view reads these)', m.items[0].unitPrice === 1800 && m.items[0].total === 1800 && m.items[2].total === -100 && !('rate' in m.items[0]));
  ok('mirror: dated when Stripe created it, not today', m.createdAt.getTime() === 1789652222000);
  const bare = L.mirrorInvoice({ object: 'charge', amount: 45000, amount_captured: 45000, created: 1787781726, description: null }, leads[5], 'OWNER', 1);
  ok('mirror of a bare charge (payment link, no invoice): one line for the amount', bare.items.length === 1 && bare.total === 450 && bare.stripeInvoiceId === null);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
