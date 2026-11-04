/**
 * tests/portal-pay-panel-2026-11-04.test.js
 *
 * Customer portal Phase 3 (documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md),
 * as Jo chose on 2026-11-04: a pay panel in the portal, payment itself on
 * Stripe's own secure page (NBD's Stripe Invoice / a Connect tenant's
 * single-use link). No new charge path.
 *
 *   1. functions/portal-pay.js (pure): a bank payment in flight (achPending)
 *      withholds the link so nobody pays twice; the invoice number rides
 *      along; nothing in it talks to Stripe.
 *   2. Server wiring: the view's balance AND the tracker's pay step both read
 *      the same _payCard.
 *   3. Client: _diffView (run for real) repaints when a payment posts, when a
 *      bank payment starts, and when the link changes — and not otherwise.
 *   4. Client render: the processing card replaces the Pay card; Pay Now
 *      carries the pay metric and the "secure page, come back here" note;
 *      a Pay tap speeds up the poll for a while.
 *
 * Run: node tests/portal-pay-panel-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
function liftBetween(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return '';
  const b = src.indexOf(end, a + start.length);
  return b < 0 ? '' : src.slice(a, b + end.length);
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n1. portal-pay.js');
const PP = require(path.join(ROOT, 'functions/portal-pay.js'));
const card = { amountCents: 650000, kind: 'balance', totalOwedCents: 650000, stripePaymentLink: 'https://invoice.stripe.com/i/x', linkPending: false, payByBank: true, zelle: null };
const plain = PP.withPayExtras(card, { invoiceNumber: 'INV-1042' });
ok('no bank payment in flight → link kept, invoice number added', plain.stripePaymentLink === card.stripePaymentLink && plain.invoiceNumber === 'INV-1042' && plain.processingCents === 0);
const proc = PP.withPayExtras(card, { invoiceNumber: 'INV-1042', achPending: { paymentIntentId: 'pi_1', amountCents: 650000, since: new Date() } });
ok('bank payment in flight → processingCents set', proc.processingCents === 650000);
ok('…and the Pay link, "on its way" and the ACH line are withheld (no paying twice)', proc.stripePaymentLink === null && proc.linkPending === false && proc.payByBank === false);
ok('the card passed in is not mutated', card.stripePaymentLink === 'https://invoice.stripe.com/i/x');
ok('no balance card → passes through', PP.withPayExtras(null, {}) === null);
ok('a junk achPending amount is ignored', PP.payExtras({ achPending: { amountCents: 'lots' } }).processingCents === 0 && PP.payExtras({ achPending: { amountCents: -5 } }).processingCents === 0);
ok('invoice number falls back to the paper invoice id, capped', PP.payExtras({ paper: { invoice: { instanceId: 'P-77' } } }).invoiceNumber === 'P-77' && PP.payExtras({ invoiceNumber: 'x'.repeat(90) }).invoiceNumber.length === 40);
const ppSrc = stripComments(read('functions/portal-pay.js'));
ok('portal-pay.js never talks to Stripe', !/require\([^)]*stripe|paymentLinks|checkout|getStripe/i.test(ppSrc));

console.log('\n2. server wiring');
const fn = stripComments(read('functions/portal.js'));
ok('one _payCard from the existing _balance', /const _payCard = PortalPay\.withPayExtras\(_balance, _unpaidInvoice\);/.test(fn));
ok('the view sends _payCard as balance', /balance: _payCard,/.test(fn) && !/balance: _balance,/.test(fn));
ok('the tracker pay step reads the same _payCard', /hp\.pending && _payCard && _payCard\.stripePaymentLink\) \{\s*progress\.payLink = _payCard\.stripePaymentLink;/.test(fn));
const viewFn = fn.slice(fn.indexOf('exports.getHomeownerPortalView'), fn.indexOf('exports.', fn.indexOf('exports.getHomeownerPortalView') + 10));
ok('still no Stripe call in the view', !/paymentLinks\.create|checkout\.sessions|getStripe\(/.test(viewFn));

console.log('\n3. _diffView (run for real)');
const PJS = read('docs/pro/js/portal.js');
const diffSrc = liftBetween(PJS, '  function _diffView(prev, next) {', '\n  }\n');
const paidSrc = liftBetween(PJS, '  function paidSoFarCents(paid) {', '\n  }\n');
ok('lifted _diffView and paidSoFarCents', !!diffSrc && !!paidSrc);
const ctx = {}; vm.createContext(ctx);
vm.runInContext(paidSrc + diffSrc + '\nthis.diff = _diffView;', ctx);
const base = { progress: { currentLabel: 'Final payment' }, photos: [], paid: { totalPaidCents: 100000, payments: [] }, balance: { stripePaymentLink: 'https://invoice.stripe.com/i/x', processingCents: 0 } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const kinds = (ev) => (ev || []).map((e) => e.kind).join(',');
ok('nothing changed → no repaint', ctx.diff(base, clone(base)) === null);
const paidMore = clone(base); paidMore.paid.totalPaidCents = 750000; paidMore.balance = null;
ok('a payment posted (same step) → repaint "Payment received"', kinds(ctx.diff(base, paidMore)) === 'paid' && /Payment received/.test(ctx.diff(base, paidMore)[0].msg));
const ach = clone(base); ach.balance = { stripePaymentLink: null, processingCents: 650000 };
ok('a bank payment started → repaint "processing"', kinds(ctx.diff(base, ach)) === 'paid' && /processing/.test(ctx.diff(base, ach)[0].msg));
const relink = clone(base); relink.balance.stripePaymentLink = 'https://invoice.stripe.com/i/y';
ok('a new link (balance changed) → repaint', kinds(ctx.diff(base, relink)) === 'paid');
ok('first paint announces nothing', ctx.diff(null, base) === null);

console.log('\n4. client render');
const code = stripComments(PJS);
ok('processing card renders instead of the Pay card', /const _processingCents = view\.balance && !_nothingDue \? Number\(view\.balance\.processingCents\) \|\| 0 : 0;/.test(code)
  && /if \(_processingCents > 0\) \{[\s\S]{0,200}data-portal-pay-processing/.test(code)
  && /if \(view\.balance && !_nothingDue && !_processingCents\) \{/.test(code));
ok('processing copy: no claim words, says nothing more to do', /3 to 5 business days to clear\. There is nothing more to do\./.test(code) && !/claim|adjuster|carrier/i.test(liftBetween(code, 'if (_processingCents > 0) {', '\n    }\n')));
const pay = liftBetween(PJS, '  function balancePayActionHtml(b) {', '\n  }\n');
ok('Pay Now carries the pay metric and opens a new tab', /data-metric="pay"/.test(pay) && /target="_blank" rel="noopener"/.test(pay));
ok('the "secure page, come back here" note sits with the button only', /data-pay-secure>Opens Stripe’s secure payment page/.test(pay) && pay.indexOf('data-pay-secure') > pay.indexOf('if (url)') && pay.indexOf('data-pay-secure') < pay.indexOf('linkPending'));
ok('invoice number shows on the Pay card', /data-pay-invoice>' \+ esc\('Invoice ' \+ view\.balance\.invoiceNumber\)/.test(code));
ok('a Pay tap speeds polling (10s for 10 min), polls stay budget-exempt', /const PAY_POLL_INTERVAL_MS = 10_000;/.test(code) && /const PAY_WATCH_MS = 10 \* 60 \* 1000;/.test(code)
  && /Date\.now\(\) < _payWatchUntil \? PAY_POLL_INTERVAL_MS : POLL_INTERVAL_MS/.test(code) && /_fetchView\(token, true\)/.test(code));
ok('both pay buttons (card + tracker step) arm the watch', /closest\('\.portal-pay-btn, \.progress-action\[data-metric="pay"\]'\)/.test(code));
const html = read('docs/pro/portal.html');
ok('portal.js cache-buster bumped (v>=21)', Number((html.match(/js\/portal\.js\?v=(\d+)/) || [])[1]) >= 21);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
