/**
 * tests/stripe-ledger-ui-2026-09-29.test.js
 *
 * The CRM screens for the Stripe ledger (Jo, 2026-09-29: "every transaction
 * from Stripe makes its way back to the CRM ... linked to the customers in the
 * CRM under their names"). Pins the pure rules in
 * docs/pro/js/stripe-ledger-ui-logic.js with inputs:
 *   - who may read / write, and the tenant every query is scoped to
 *   - the query descriptors (rule-safe: companyId first, index-backed order)
 *   - ledger row → display model (matched name wins, unmatched flagged,
 *     negative amounts, method labels, status chips, unsafe links dropped)
 *   - this month's Stripe collected (ET month; subscriptions, failed and
 *     pending charges excluded; refunds reported beside, not netted)
 *   - the review list + assignability + suggestions + customer search
 *   - the Sync preview buckets
 *   - escaping of every Stripe-supplied string
 * Synthetic data only.
 *
 * Run: node tests/stripe-ledger-ui-2026-09-29.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'stripe-ledger-ui-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// Noon ET on a given day (well clear of any midnight edge).
const ET = (y, m, d, h) => Date.UTC(y, m - 1, d, (h == null ? 12 : h) + 4);   // EDT = UTC-4 in late Sep/Oct
const NOW = ET(2026, 9, 29);

console.log('\n1. escaping + links');
ok('esc covers & < > " \'', L.esc(`<img src=x onerror="a('b')">&`) === '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
ok('esc of null is empty', L.esc(null) === '' && L.esc(undefined) === '');
ok('safeUrl keeps https', L.safeUrl('https://pay.stripe.com/receipts/x') === 'https://pay.stripe.com/receipts/x');
ok('safeUrl drops javascript:', L.safeUrl('javascript:alert(1)') === null);
ok('safeUrl drops data: and protocol-relative', L.safeUrl('data:text/html,hi') === null && L.safeUrl('//evil.test/x') === null);
ok('safeUrl drops a quote-breaking value', L.safeUrl('https://x.test/"onmouseover=1') === null);

console.log('\n2. money formatting');
ok('positive', L.fmtMoney(123456) === '$1,234.56');
ok('negative uses a real minus', L.fmtMoney(-2500) === '−$25.00');
ok('zero / garbage', L.fmtMoney(0) === '$0.00' && L.fmtMoney('x') === '$0.00');

console.log('\n3. roles + tenant');
ok('tenant = companyId when present', L.tenantOf({ companyId: 'co1' }, 'u1') === 'co1');
ok('tenant = uid for a solo owner', L.tenantOf({}, 'u1') === 'u1');
ok('sales rep cannot read', !L.canRead({ role: 'sales_rep', companyId: 'co1' }, 'u2'));
ok('viewer cannot read', !L.canRead({ role: 'viewer', companyId: 'co1' }, 'u3'));
ok('manager / company_admin / owner read', L.canRead({ role: 'manager', companyId: 'co1' }, 'm') && L.canRead({ role: 'company_admin', companyId: 'co1' }, 'a') && L.canRead({}, 'o'));
ok('signed out reads nothing', !L.canRead({}, null));
ok('manager reads but does not write', !L.canWrite({ role: 'manager', companyId: 'co1' }, 'm'));
ok('company_admin + platform admin write', L.canWrite({ role: 'company_admin', companyId: 'co1' }, 'a') && L.canWrite({ role: 'admin' }, 'p'));
ok('the owner of their own tenant writes', L.canWrite({ companyId: 'o' }, 'o') && L.canWrite({}, 'o'));
ok('a role-less member of someone else\'s company does not write', !L.canWrite({ companyId: 'co1' }, 'x'));

console.log('\n4. queries are scoped to the tenant');
const q1 = L.ledgerQuery('co1', 50);
ok('ledger: companyId == tenant, then atMs desc, then limit', JSON.stringify(q1) === JSON.stringify({ collection: 'stripeLedger', where: [['companyId', '==', 'co1']], orderBy: ['atMs', 'desc'], limit: 50 }));
const q2 = L.reviewQuery('co1');
ok('review: equality only (companyId + needsReview), no orderBy', q2.where.length === 2 && q2.where[0][0] === 'companyId' && q2.where[1][0] === 'needsReview' && q2.where[1][2] === true && !q2.orderBy);
const q3 = L.customerQuery('co1', 'lead9');
ok('customer: companyId + match.leadId, equality only', JSON.stringify(q3.where) === JSON.stringify([['companyId', '==', 'co1'], ['match.leadId', '==', 'lead9']]) && !q3.orderBy && !q3.limit);
// applyQuery drives the SDK functions in order.
const calls = [];
const fakeFb = {
  db: 'DB',
  collection: (db, name) => { calls.push(['collection', db, name]); return 'COL'; },
  where: (f, op, v) => { calls.push(['where', f, op, v]); return 'W:' + f; },
  orderBy: (f, d) => { calls.push(['orderBy', f, d]); return 'O'; },
  limit: (n) => { calls.push(['limit', n]); return 'L'; },
  query: (...args) => { calls.push(['query'].concat(args)); return 'Q'; },
};
const built = L.applyQuery(q1, fakeFb);
ok('applyQuery builds query(collection, where, orderBy, limit)', built === 'Q' && JSON.stringify(calls[calls.length - 1]) === JSON.stringify(['query', 'COL', 'W:companyId', 'O', 'L']));
calls.length = 0;
L.applyQuery(q3, fakeFb);
ok('applyQuery skips orderBy/limit when the descriptor has none', !calls.some((c) => c[0] === 'orderBy' || c[0] === 'limit'));

console.log('\n5. row → display model');
const leads = [
  { id: 'L1', firstName: 'Pat', lastName: 'Rivera', address: '12 Oak St, Sometown', phone: '(555) 010-2000' },
  { id: 'L2', firstName: 'Sam', lastName: 'Rivera', address: '400 Elm Ave', phone: '555-010-3000' },
  { id: 'L3', name: 'Casey Stone', address: '9 Pine Rd', phone: '5550104000' },
  { id: 'L4', firstName: 'Gone', lastName: 'Lead', deleted: true },
];
const byId = L.leadsIndex(leads);
ok('leadsIndex drops deleted leads', !byId.L4 && byId.L1 && byId.L3);
const matched = {
  id: 'ch_1', kind: 'charge', status: 'succeeded', amountCents: 500000, feeCents: 14530, netCents: 485470, atMs: ET(2026, 9, 20),
  method: 'card', last4: '4242', brand: 'visa', receiptUrl: 'https://pay.stripe.com/receipts/r1', stripeHostedUrl: 'javascript:alert(1)',
  nbdInvoiceNumber: 'NBD-2026-0001', party: { name: 'P. Rivera (Stripe)', email: 'pat@example.test' },
  match: { leadId: 'L1', confidence: 'high', invoiceId: 'inv1', leadName: 'Old Name' },
};
const d1 = L.displayRow(matched, byId);
ok('matched row shows the lead\'s CURRENT name', d1.name === 'Pat Rivera' && d1.leadId === 'L1' && d1.matched && !d1.unmatched);
ok('amount / fee text', d1.amountText === '$5,000.00' && d1.feeText === '$145.30' && !d1.negative);
ok('card method label carries last4 + brand', d1.method === 'Card ···· 4242 (Visa)', d1.method);
ok('receipt link kept, javascript: hosted link dropped', d1.receiptUrl === 'https://pay.stripe.com/receipts/r1' && d1.stripeUrl === null);
ok('status chip: paid', d1.chip.label === 'Paid' && d1.chip.tone === 'good');
ok('invoice number surfaced', d1.invoiceNumber === 'NBD-2026-0001' && d1.invoiceId === 'inv1');
const d1b = L.displayRow(matched, {});
ok('lead not loaded → the name the matcher stamped', d1b.name === 'Old Name');
const unmatched = { id: 'ch_2', kind: 'charge', status: 'succeeded', amountCents: 1000, atMs: ET(2026, 9, 21), method: 'apple_pay',
  party: { name: 'Stranger Payer', email: 's@example.test' }, match: { leadId: 'L2', confidence: 'suggest', candidates: ['L2', 'L1'] }, needsReview: true };
const d2 = L.displayRow(unmatched, byId);
ok('a SUGGESTED match is not shown as the customer', d2.name === 'Stranger Payer' && d2.leadId === null && d2.unmatched);
ok('needs-review chip', d2.chip.label.indexOf('needs review') !== -1 && d2.chip.tone === 'warn');
ok('apple pay label', d2.method === 'Apple Pay');
const refund = { id: 're_1', kind: 'refund', status: 'succeeded', amountCents: -2500, atMs: ET(2026, 9, 22), match: { leadId: 'L1', confidence: 'high' } };
const d3 = L.displayRow(refund, byId);
ok('refund is negative and red-flagged', d3.negative && d3.amountText === '−$25.00' && d3.chip.label === 'Refunded');
const payout = { id: 'po_1', kind: 'payout', status: 'paid', amountCents: 400000, atMs: ET(2026, 9, 23), party: null };
const d4 = L.displayRow(payout, byId);
ok('payout: to your bank, never "unmatched"', d4.name === 'To your bank' && !d4.unmatched && d4.chip.label === 'Payout · Paid');
const failedCh = { id: 'ch_3', kind: 'charge', status: 'failed', amountCents: 0, failure: 'Your card was declined.', method: 'us_bank_account', atMs: ET(2026, 9, 24), party: { name: 'X' }, match: {} };
const d5 = L.displayRow(failedCh, byId);
ok('failed charge chip + ACH label + failure text', d5.chip.tone === 'bad' && d5.method === 'Bank (ACH)' && d5.failure === 'Your card was declined.');
ok('dispute chip is bad', L.statusChip({ kind: 'dispute', status: 'needs_response' }).tone === 'bad');
ok('outside-Stripe label', L.methodLabel({ method: 'marked_paid_in_stripe' }) === 'Marked paid in Stripe' && L.kindLabel('invoice_paid_outside_stripe') === 'Paid outside Stripe');
ok('unknown method is title-cased, not dropped', L.methodLabel({ method: 'sepa_debit' }) === 'Sepa Debit');

console.log('\n6. this month\'s Stripe collected');
const monthRows = [
  matched,                                                                             // 5000.00, fee 145.30, net 4854.70
  { kind: 'charge', status: 'succeeded', amountCents: 20000, feeCents: 610, atMs: ET(2026, 9, 1, 0) },   // 12:00am ET Sep 1 → counts (net computed)
  { kind: 'charge', status: 'succeeded', amountCents: 99900, feeCents: 3000, netCents: 96900, atMs: ET(2026, 8, 31, 23) }, // Aug 31 11pm ET → out
  { kind: 'platform_subscription', status: 'succeeded', amountCents: 4900, feeCents: 172, atMs: ET(2026, 9, 10) },         // subscription → out
  { kind: 'charge', status: 'failed', amountCents: 0, attemptedCents: 5000, atMs: ET(2026, 9, 11) },                         // failed → out
  { kind: 'charge', status: 'pending', amountCents: 0, atMs: ET(2026, 9, 12) },                                              // pending → out
  { kind: 'invoice_paid_outside_stripe', status: 'succeeded', amountCents: 70000, atMs: ET(2026, 9, 13) },                   // not a Stripe charge → out
  refund,                                                                                                                     // refund reported beside
  { kind: 'refund', status: 'failed', amountCents: -100, atMs: ET(2026, 9, 14) },                                            // failed refund → out
];
const t = L.monthTotals(monthRows, NOW);
ok('month key is ET', t.month === '2026-09');
ok('gross = succeeded customer charges only', t.grossCents === 520000, String(t.grossCents));
ok('fees summed', t.feeCents === 15140, String(t.feeCents));
ok('net uses netCents, or amount − fee when absent', t.netCents === 485470 + 19390, String(t.netCents));
ok('count', t.count === 2, String(t.count));
ok('refunds beside the total (failed refund ignored)', t.refundCents === 2500 && t.refundCount === 1);
ok('an empty ledger is all zeros', JSON.stringify(L.monthTotals([], NOW)) === JSON.stringify({ month: '2026-09', grossCents: 0, feeCents: 0, netCents: 0, count: 0, refundCents: 0, refundCount: 0 }));
ok('late-evening ET belongs to that ET day, not the UTC day', L.monthKey(ET(2026, 9, 30, 23)) === '2026-09');

console.log('\n7. review list, assignability, suggestions, search');
const sub = { id: 'ch_s', kind: 'platform_subscription', status: 'succeeded', amountCents: 4900, needsReview: true, atMs: ET(2026, 9, 25) };
const dispute = { id: 'dp_1', kind: 'dispute', status: 'needs_response', amountCents: -1000, needsReview: true, atMs: ET(2026, 9, 26) };
const oob = { id: 'in_1', kind: 'invoice_paid_outside_stripe', status: 'succeeded', amountCents: 70000, needsReview: true, atMs: ET(2026, 9, 19), match: { confidence: 'none', candidates: [] } };
const rv = L.reviewRows([matched, unmatched, sub, dispute, oob, null]);
ok('review = needsReview rows, newest first, no subscriptions', rv.map((r) => r.id).join(',') === 'dp_1,ch_2,in_1', rv.map((r) => r.id).join(','));
ok('a completed payment can be assigned', L.canAssign(unmatched) && L.canAssign(oob));
ok('a dispute / failed / refund / zero cannot', !L.canAssign(dispute) && !L.canAssign(failedCh) && !L.canAssign(refund) && !L.canAssign({ kind: 'charge', status: 'succeeded', amountCents: 0 }));
const sg = L.suggestionsFor(unmatched, byId);
ok('suggestions: matcher pick first, then candidates, deduped, resolved to names', sg.map((s) => s.leadId + ':' + s.name).join('|') === 'L2:Sam Rivera|L1:Pat Rivera');
ok('suggestions drop leads no longer in the CRM', L.suggestionsFor({ match: { candidates: ['L4', 'nope'] } }, byId).length === 0);
ok('suggestions fall back to the stamped name when leads are not loaded', JSON.stringify(L.suggestionsFor({ match: { leadId: 'L9', leadName: 'Jo Q' } }, {})) === JSON.stringify([{ leadId: 'L9', name: 'Jo Q', address: '' }]));
ok('search by name', L.searchLeads(leads, 'rivera').map((x) => x.leadId).join(',') === 'L1,L2');
ok('search by address', L.searchLeads(leads, 'pine').map((x) => x.leadId).join(',') === 'L3');
ok('search by phone digits, any format', L.searchLeads(leads, '010-4000').map((x) => x.leadId).join(',') === 'L3' && L.searchLeads(leads, '(555) 010-2').map((x) => x.leadId).join(',') === 'L1');
ok('search skips deleted leads and needs 2+ chars', L.searchLeads(leads, 'gone').length === 0 && L.searchLeads(leads, 'r').length === 0);
ok('search honours max', L.searchLeads(leads, 'e', 1).length === 0 && L.searchLeads(leads, 'ri', 1).length === 1);

console.log('\n8. Sync from Stripe preview');
const syncRes = {
  charges: [
    { id: 'ch_a', kind: 'charge', status: 'succeeded', amount: 5000, date: '2026-09-20', customer: 'Pat Rivera', match: { leadId: 'L1', name: 'Pat Rivera', method: 'email', confidence: 'high' }, action: 'recorded on CRM invoice', invoiceId: 'inv1' },
    { id: 'ch_b', kind: 'charge', status: 'succeeded', amount: 1200, date: '2026-09-21', customer: 'Casey Stone', match: { leadId: 'L3', name: 'Casey Stone', method: 'phone', confidence: 'high' }, action: 'created CRM invoice + recorded payment', invoiceId: null },
    { id: 'ch_c', kind: 'charge', status: 'succeeded', amount: 10, date: '2026-09-22', customer: 'Stranger', match: { confidence: 'suggest', candidates: ['L1', 'L2'] }, action: 'needs review', invoiceId: null },
    { id: 'ch_d', kind: 'charge', status: 'succeeded', amount: 300, date: '2026-09-23', customer: 'Link payer', match: { leadId: 'L2', method: 'crm_payment_link', confidence: 'high' }, action: 'credited_by_payment_link_path', invoiceId: 'inv2' },
    { id: 'ch_e', kind: 'charge', status: 'failed', amount: 0, date: '2026-09-24', customer: 'Declined', match: { leadId: 'L1', confidence: 'high' }, action: 'ledger only' },
    { id: 'ch_s', kind: 'platform_subscription', status: 'succeeded', amount: 49, action: 'NBD Pro subscription — not a customer job' },
  ],
  invoices: [{ id: 'in_1', kind: 'invoice_paid_outside_stripe', status: 'succeeded', amount: 700, date: '2026-09-19', customer: 'Zelle Payer', match: { confidence: 'none', candidates: [] }, action: 'needs review' }],
  refunds: [{ id: 're_1', kind: 'refund', amount: -25, match: { leadId: 'L1', confidence: 'high' } }],
  disputes: [{ id: 'dp_1', kind: 'dispute', amount: -10, status: 'needs_response' }],
  payouts: [{ id: 'po_1', kind: 'payout', amount: 4000, status: 'paid' }],
  totals: { collected: 6510, booked: 2, needsReview: 2, dryRun: true },
};
const pm = L.previewModel(syncRes, byId);
ok('every row lands in exactly one bucket', pm.total === 10 && pm.groups.reduce((s, g) => s + g.count, 0) === 10);
ok('creates / records / review / linked counted', pm.creates === 1 && pm.records === 1 && pm.review === 3 && pm.linked === 1, JSON.stringify({ c: pm.creates, r: pm.records, v: pm.review, l: pm.linked }));
ok('dry run flag + server totals carried', pm.dryRun === true && pm.collectedCents === 651000 && pm.bookedCount === 2 && pm.needsReviewCount === 2);
const reviewGroup = pm.groups.find((g) => g.key === 'review');
ok('review group: newest first, dispute included', reviewGroup.rows.map((r) => r.id).join(',').indexOf('ch_c') === 0 && reviewGroup.rows.some((r) => r.id === 'dp_1'));
ok('where: matched name, else candidate count', pm.groups.find((g) => g.key === 'records').rows[0].where === 'Pat Rivera' && reviewGroup.rows.find((r) => r.id === 'ch_c').where === '2 possible matches');
ok('payout does not add to a group\'s money', pm.groups.find((g) => g.key === 'ledger').cents === -2500 + 0 + 4900, String(pm.groups.find((g) => g.key === 'ledger').cents));
ok('only money-booking groups show a total', pm.groups.filter((g) => g.showTotal).map((g) => g.key).join(',') === 'creates,records,review,linked');
ok('an Apply result is not a dry run', L.previewModel(Object.assign({}, syncRes, { totals: { dryRun: false } }), byId).dryRun === false);
ok('an empty / missing result is safe', L.previewModel(null).total === 0 && L.previewModel({}).groups.length === 5);

console.log('\n9. "From Stripe" chip on mirrored invoices');
ok('a CRM-authored invoice gets nothing', L.stripeInvoiceBadgeHtml({ source: 'crm', stripeHostedUrl: 'https://x.test' }) === '' && L.stripeInvoiceBadgeHtml(null) === '');
const badge = L.stripeInvoiceBadgeHtml({ source: 'stripe', nbdInvoiceNumber: '<b>NBD-1</b>', stripeHostedUrl: 'https://invoice.stripe.com/i/abc', stripePdfUrl: 'javascript:alert(1)' });
ok('chip + escaped number + hosted link', badge.indexOf('From Stripe') !== -1 && badge.indexOf('&lt;b&gt;NBD-1&lt;/b&gt;') !== -1 && badge.indexOf('href="https://invoice.stripe.com/i/abc"') !== -1);
ok('unsafe PDF link dropped, new tab + noopener on the kept one', badge.indexOf('javascript:') === -1 && badge.indexOf('PDF') === -1 && /target="_blank" rel="noopener noreferrer"/.test(badge));

console.log('\n10. hostile Stripe strings never reach markup raw');
const evil = { id: 'ch_x', kind: 'charge', status: 'succeeded', amountCents: 100, atMs: NOW, party: { name: '<script>alert(1)</script>', email: '"><img onerror=x>' }, match: {} };
const dv = L.displayRow(evil, byId);
ok('display model keeps the raw text (the renderer escapes it)', dv.name === '<script>alert(1)</script>');
ok('…and esc() neutralises it', L.esc(dv.name).indexOf('<') === -1 && L.esc(evil.party.email).indexOf('"') === -1);

console.log('\nstripe-ledger-ui: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
