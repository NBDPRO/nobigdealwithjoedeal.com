/**
 * invoice-rounding-minjob-line-2026-10-05.test.js — the invoice carries the
 * quote's Rounding / Minimum job charge adjustment row, so its lines + tax
 * foot to the total and Stripe takes the pay link.
 *
 * The bug (HIGH, 2026-10-05): the quote prints total − subtotal − tax as its
 * own row (estimate-v2-ui.js "Rounding" / "Minimum job charge adjustment",
 * estimate-finalization.js the same). The row-based invoice builder
 * (nbd:invoice-from-estimate, docs/pro/js/invoice-pipeline.js and
 * functions/invoice-from-estimate.js) dropped it, and createStripePaymentLink
 * (functions/stripe.js) refuses a link whose lines + tax miss the total.
 *   $120 material / $250 labor at 7% → quote $480 + $33.60 + $11.40 = $525;
 *   invoice lines + tax = $513.60 → link refused. With the $1,500 job
 *   minimum the gap is $986.40.
 *
 * The fix: an untaxed adjustment line (adjustment: true) for the difference,
 * labelled by the quote's own rule; stripe.js charges a positive one as its
 * own line and nets a negative one (a round-down) like a credit.
 *
 * The Stripe footing check is not exported (it lives inside the
 * createStripePaymentLink handler), so section 3 lifts that exact block out
 * of functions/stripe.js and runs it. Synthetic data only.
 * Run: node tests/invoice-rounding-minjob-line-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function req(p) {
  try { return require(path.join(ROOT, p)); }
  catch (e) { ok('loads ' + p, false, e && e.message); return null; }
}
function block(src, name) {
  const s = lf(src);
  const a = s.indexOf('// nbd:' + name + ':start');
  const b = s.indexOf('// nbd:' + name + ':end');
  return (a < 0 || b < 0) ? null : s.slice(a, b);
}
const cents = (n) => Math.round(Number(n) * 100);
const sumC = (items) => items.reduce((s, i) => s + cents(i.total), 0);

// The repro estimate: V2 line-item, $120 material (25% markup → $150) +
// $250 labor + 10% overhead + 10% profit = $480 subtotal, 7% tax $33.60,
// rounded to the nearest $25 → $525.
function repro(o) {
  return Object.assign({
    priceMode: 'line-item', materialMarkupPct: 0.25, taxRate: 0.07,
    rows: [
      { desc: 'Shingles', qty: '1 EA', materialTotal: 120, laborTotal: 0 },
      { desc: 'Install labor', qty: '1 EA', materialTotal: 0, laborTotal: 250 },
    ],
    overhead: 40, profit: 40, overheadPct: 0.10, profitPct: 0.10,
    subtotal: 480, tax: 33.60, grandTotal: 525, total: 525, minJobApplied: false,
  }, o || {});
}
const CASES = [
  { name: '$525 (nearest-$25 rounding +$11.40)', est: repro(), total: 525, adjC: 1140, label: 'Rounding' },
  { name: '$1,500 job minimum (+$986.40)', est: repro({ grandTotal: 1500, total: 1500, minJobApplied: true, minJobCharge: 1500 }), total: 1500, adjC: 98640, label: 'Minimum job charge adjustment' },
  { name: 'a round-DOWN ($502.90 → $500, −$2.90)', est: repro({ overhead: 35, profit: 35, subtotal: 470, tax: 32.90, grandTotal: 500, total: 500 }), total: 500, adjC: -290, label: 'Rounding' },
  { name: 'a few cents ($499.69 → $500, +$0.31)', est: repro({ overhead: 33.5, profit: 33.5, subtotal: 467, tax: 32.69, grandTotal: 500, total: 500 }), total: 500, adjC: 31, label: 'Rounding' },
];

const IFE = req('functions/invoice-from-estimate.js');
global.window = {};
const IP = req('docs/pro/js/invoice-pipeline.js');

(async () => {
  console.log('\n1. the row-based invoice carries the quote\'s adjustment row (both copies)');
  ok('nbd:invoice-from-estimate is byte-identical in invoice-pipeline.js and functions/invoice-from-estimate.js',
    !!block(read('docs/pro/js/invoice-pipeline.js'), 'invoice-from-estimate')
    && block(read('docs/pro/js/invoice-pipeline.js'), 'invoice-from-estimate') === block(read('functions/invoice-from-estimate.js'), 'invoice-from-estimate'));
  const copies = [['server', IFE], ['browser', IP]].filter((c) => c[1] && typeof c[1].invoiceTotalsFromEstimate === 'function');
  ok('both copies export invoiceTotalsFromEstimate', copies.length === 2);
  for (const [who, M] of copies) {
    for (const c of CASES) {
      const t = M.invoiceTotalsFromEstimate(c.est, {});
      const adj = t.items.filter((i) => i.adjustment === true);
      ok(who + ': ' + c.name + ' → one untaxed "' + c.label + '" line of ' + (c.adjC / 100).toFixed(2) + ', lines + tax == total',
        cents(t.total) === cents(c.total) && adj.length === 1 && cents(adj[0].total) === c.adjC && adj[0].description === c.label
        && adj[0].taxable === false && sumC(t.items) + cents(t.tax) === cents(t.total),
        JSON.stringify({ total: t.total, tax: t.tax, subtotal: t.subtotal, items: t.items }));
      ok(who + ': ' + c.name + ' → subtotal and tax stay the quote\'s (the adjustment is not taxed)',
        cents(t.subtotal) === cents(c.est.subtotal) && cents(t.tax) === cents(c.est.tax));
    }
    const even = M.invoiceTotalsFromEstimate(repro({ grandTotal: 513.60, total: 513.60 }), {});
    ok(who + ': a quote that already foots (no rounding) → no adjustment line', !even.items.some((i) => i.adjustment));
    const perSq = M.invoiceTotalsFromEstimate({ priceMode: 'per-sq', prices: { better: 15000 }, selectedTier: 'better', grandTotal: 15000, taxRate: 0.07 }, {});
    ok(who + ': per-SQ (one summary line) is unchanged — no adjustment line', perSq.items.length === 1 && !perSq.items[0].adjustment);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n2. the labels follow the quote\'s rule (estimate-v2-ui.js)');
  {
    const src = lf(read('docs/pro/js/estimate-v2-ui.js'));
    ok('estimate-v2-ui.js still labels it (minJobApplied && diff > 0) ? "Minimum job charge adjustment" : "Rounding"',
      src.indexOf("roundingLabel: (estimate.minJobApplied && diff > 0) ? 'Minimum job charge adjustment' : 'Rounding',") !== -1);
    if (IFE) {
      const down = IFE.invoiceTotalsFromEstimate(repro({ overhead: 35, profit: 35, subtotal: 470, tax: 32.90, grandTotal: 500, total: 500, minJobApplied: true }), {});
      ok('minJobApplied but the difference is NEGATIVE → "Rounding" (same as the quote)', down.items.some((i) => i.adjustment && i.description === 'Rounding'));
    }
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n3. the real createStripePaymentLink footing block (lifted from functions/stripe.js) takes the link');
  const footing = liftFooting();
  ok('the line / tax / reconcile / balance block is liftable from functions/stripe.js', !!footing);
  if (footing && IFE) {
    for (const c of CASES) {
      const t = IFE.invoiceTotalsFromEstimate(c.est, {});
      const invoice = { items: t.items, tax: t.tax, total: t.total, amountPaid: 0 };
      const r = await footing(invoice);
      const charged = r.ok ? r.chargeLineItems.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0) : null;
      ok('stripe.js: ' + c.name + ' → link accepted, charges exactly ' + (cents(c.total) / 100).toFixed(2),
        r.ok === true && charged === cents(c.total), JSON.stringify(r.ok ? { charged, lines: r.chargeLineItems.map((l) => [l.price_data.product_data.name, l.price_data.unit_amount]) } : r));
    }
    const r1 = await footing({ items: IFE.invoiceTotalsFromEstimate(CASES[0].est, {}).items, tax: 33.60, total: 525, amountPaid: 0 });
    ok('stripe.js: the positive adjustment is its own named line ("Rounding" $11.40) beside the Sales Tax line',
      r1.ok && r1.chargeLineItems.some((l) => l.price_data.product_data.name === 'Rounding' && l.price_data.unit_amount === 1140)
      && r1.chargeLineItems.some((l) => l.price_data.product_data.name === 'Sales Tax' && l.price_data.unit_amount === 3360));
    const r3 = await footing({ items: IFE.invoiceTotalsFromEstimate(CASES[2].est, {}).items, tax: 32.90, total: 500, amountPaid: 0 });
    ok('stripe.js: a round-down charges ONE balance line of $500.00 described as "$2.90 rounding" (not "deposit credited")',
      r3.ok && r3.chargeLineItems.length === 1 && r3.chargeLineItems[0].price_data.unit_amount === 50000
      && /\$2\.90 rounding/.test(r3.chargeLineItems[0].price_data.product_data.description) && !/deposit credited/.test(r3.chargeLineItems[0].price_data.product_data.description),
      JSON.stringify(r3));
    const old = await footing({ items: IFE.invoiceTotalsFromEstimate(CASES[0].est, {}).items.filter((i) => !i.adjustment), tax: 33.60, total: 525, amountPaid: 0 });
    ok('stripe.js: the SAME invoice without the adjustment line is still refused (the guard is live)', old.ok === false && /does not reconcile/.test(old.error), JSON.stringify(old));
    const bad = await footing({ items: [{ description: 'Roof', total: 400 }, { description: 'Rounding', total: 0, adjustment: true }], tax: 0, total: 400, amountPaid: 0 });
    ok('stripe.js: a $0 / non-numeric adjustment line is refused', bad.ok === false && /Adjustment line/.test(bad.error));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * Lift the createStripePaymentLink block that turns invoice.items into Stripe
 * lines, adds the Sales Tax line, reconciles to invoice.total and swaps to a
 * balance line — from `const MIN_CENTS` to just before `getStripe()` — and
 * run it with a capturing res. → async (invoice) => { ok, error?, chargeLineItems? }
 */
function liftFooting() {
  const src = lf(read('functions/stripe.js'));
  const h = src.indexOf('exports.createStripePaymentLink = onRequest(');
  const a = src.indexOf('      const MIN_CENTS = 100;', h);
  const b = src.indexOf('      const stripe = getStripe();', a);
  if (h < 0 || a < 0 || b < 0) return null;
  const body = src.slice(a, b);
  return async (invoice) => {
    let refused = null;
    const res = { status: (s) => ({ json: (j) => { refused = Object.assign({ status: s }, j); } }) };
    const ctx = { invoice, invoiceId: 'INV1', res, db: { doc: () => ({ get: async () => ({ exists: false }) }) }, decoded: { uid: 'u1' },
      logger: { error() {}, warn() {}, info() {} }, Math, Number, String, Object, Array, JSON, console, __out: null,
      // stripe.js's deposit-first charge rule (review R2-2-6, 2026-10-06).
      InvoiceCharge: require(path.join(__dirname, '..', 'functions', 'invoice-charge.js')) };
    vm.createContext(ctx);
    await vm.runInContext('(async () => {\n' + body + '\n__out = { chargeLineItems, linkTotalCents, expectedTotalCents };\n})()', ctx);
    if (refused) return { ok: false, error: refused.error, status: refused.status };
    return Object.assign({ ok: true }, ctx.__out);
  };
}
