/**
 * tests/doc-preflight-invoice-tax-2026-10-05.test.js
 *
 * Two money bugs in the document pre-flight invoice (Jo, 2026-10-05):
 *
 *   1. The field labelled "Tax Rate (%)" was read by both invoice renderers
 *      (document-generator-templates.js renderInvoice, document-generator.js
 *      _buildServerPayload) as a DECIMAL and defaulted to 0. A $525 job
 *      ($480 lines, 7% tax, $11.40 rounding) invoiced $480; typing 7 billed
 *      $3,360 of tax. Now the field is a percent prefilled from the estimate's
 *      decimal taxRate, and while the invoice is the estimate's own it carries
 *      the quote's rounding row, so it totals $525.
 *   2. "Save to estimate" set grandTotal to the bare line sum (pre-tax), so a
 *      Save with no edits turned $525 into $480. Now unchanged lines keep the
 *      saved totals; changed lines re-total by the quote's rule.
 *
 * Drives the real path: the invoice schema's fields resolved by the real
 * resolver from a saved estimate, the real hydrateDerivedFields, the real
 * renderers. Run: node tests/doc-preflight-invoice-tax-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const DG_DIR = path.join(__dirname, '..', 'docs/pro/js');
const read = (f) => fs.readFileSync(path.join(DG_DIR, f), 'utf8');

function loadEnv() {
  const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
  const win = { _brand: () => brand };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  for (const f of ['estimate-config.js', 'customer-estimate-rows.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
    vm.runInNewContext(read(f), sandbox, { filename: f });
  }
  return { win, dg: win.NBDDocGen, pf: win.DocPreflight };
}

// The $525 job: $480 of customer lines, 7% tax $33.60, $11.40 rounding to the
// nearest $25. (Cost basis $120 material / $250 labor; the lines are retail.)
function est525(over) {
  return Object.assign({
    id: 'E525', priceMode: 'line-item',
    lineItems: [
      { description: 'Materials', quantity: 1, unit: 'ea', unitPrice: 180, amount: 180 },
      { description: 'Labor', quantity: 1, unit: 'ea', unitPrice: 300, amount: 300 },
    ],
    materialCost: 120, laborCost: 250,
    subtotal: 480, tax: 33.6, taxRate: 0.07, grandTotal: 525, minJobApplied: false,
  }, over || {});
}

const invoiceFields = (env) => [].concat(...env.pf.DOC_SCHEMAS.invoice.sections.map((s) => s.fields));
const taxField = (env) => invoiceFields(env).find((f) => /tax rate/i.test(f.label || ''));

// What the modal shows on open() for this estimate, then what submit() hands
// hydrate (every field's value under its key).
function openInvoice(env, est, edit) {
  const ctx = { lead: { firstName: 'Jane', lastName: 'Smith', address: '123 Main St' }, estimate: est, photos: [], overrides: {}, depositDropped: [] };
  const values = {};
  invoiceFields(env).forEach((f) => { values[f.key] = env.pf._resolveFieldValue(f, ctx); });
  env.pf._state.estimate = est;
  env.pf._state.type = 'invoice';
  if (edit) edit(values);
  return values;
}

function render(env, values) {
  const data = Object.assign({ homeownerName: 'Jane Smith', address: '123 Main St', leadId: 'L1' }, JSON.parse(JSON.stringify(values)));
  env.pf._hydrateDerivedFields(data);
  const html = env.dg.renderInvoice(JSON.parse(JSON.stringify(data)));
  const server = env.dg._buildServerPayload('invoice', JSON.parse(JSON.stringify(data)));
  return { data, html, server };
}
const cents = (n) => Math.round(Number(n) * 100);
const balanceOf = (html) => { const m = /inv-balance-amount">\$([\d,]+\.\d\d)</.exec(html); return m ? m[1] : null; };

const env = loadEnv();
ok('env: NBDDocGen + DocPreflight loaded', !!env.dg && !!env.pf && typeof env.pf._hydrateDerivedFields === 'function');

console.log('BUG 1 — invoice Tax Rate (%) is a percent, prefilled from the estimate');
{
  const est = est525();
  const values = openInvoice(env, est);
  const f = taxField(env);
  ok('the invoice has a "Tax Rate (%)" field', !!f);
  ok('it prefills 7 (the estimate\'s 0.07 as a percent), not 0', f && Number(values[f.key]) === 7);

  const { html, server } = render(env, values);
  ok('client invoice prints Tax $33.60', /Tax \(7\.0%\)<\/span><span>\$33\.60</.test(html));
  ok('client invoice prints the $11.40 Rounding row', /<span>Rounding<\/span><span>\$11\.40</.test(html));
  ok('client invoice Balance Due $525.00 (was $480.00)', balanceOf(html) === '525.00');
  ok('server invoice payload: subtotal $480, tax $33.60, total $525', cents(server.subtotal) === 48000 && cents(server.tax) === 3360 && cents(server.total) === 52500);
  ok('server invoice payload: rounding row $11.40 labelled Rounding', cents(server.rounding) === 1140 && server.roundingLabel === 'Rounding' && server.roundingSign === '' && cents(server.roundingAbs) === 1140);
  ok('server invoice balanceDue $525', cents(server.balanceDue) === 52500);
}
{
  // A rep typing 7 into "Tax Rate (%)" gets 7%, never 700%.
  const values = openInvoice(env, est525({ taxRate: 0 }), (v) => { v[taxField(env).key] = 7; });
  const { html, server } = render(env, values);
  ok('typing 7 bills $33.60 of tax, not $3,360', cents(server.tax) === 3360 && !/3,360/.test(html));
}
{
  // Edited lines are no longer the estimate's own: no rounding row; the
  // invoice states exactly lines + tax.
  const values = openInvoice(env, est525(), (v) => { v.lineItems[1] = Object.assign({}, v.lineItems[1], { rate: 400, unitPrice: 400, total: 400, amount: 400 }); });
  const { html, server } = render(env, values);
  ok('edited lines: $580 + $40.60 tax = $620.60, no rounding row', cents(server.total) === 62060 && !server.rounding && !/Rounding/.test(html) && balanceOf(html) === '620.60');
}
{
  // Rewording a line is not a price change.
  const values = openInvoice(env, est525(), (v) => { v.lineItems[0] = Object.assign({}, v.lineItems[0], { description: 'Shingles + underlayment' }); });
  ok('reworded line keeps the $525 total', cents(render(env, values).server.total) === 52500);
}
{
  // A floored small repair: $200 + $14 tax, billed at the $500 job minimum.
  const est = est525({ lineItems: [{ description: 'Repair', quantity: 1, unitPrice: 200, amount: 200 }], subtotal: 200, tax: 14, grandTotal: 500, minJobApplied: true });
  const { html, server } = render(env, openInvoice(env, est));
  ok('floored job: "Minimum job charge adjustment" $286, total $500', cents(server.rounding) === 28600 && server.roundingLabel === 'Minimum job charge adjustment' && cents(server.total) === 50000 && /Minimum job charge adjustment<\/span><span>\$286\.00</.test(html));
}
{
  // Per-SQ: the one line IS the tier price with tax inside it — no tax on top.
  const est = { id: 'EPSQ', priceMode: 'per-sq', prices: { better: 12000 }, selectedTier: 'better', taxRate: 0.07, subtotal: 11200, tax: 784, grandTotal: 12000 };
  const values = openInvoice(env, est);
  const { server } = render(env, values);
  ok('per-SQ: Tax Rate (%) prefills 0 and the invoice totals the tier price $12,000', Number(values[taxField(env).key]) === 0 && cents(server.total) === 1200000 && !server.rounding);
}
{
  // A gap wider than a rounding step is not rounding and is never labelled so.
  const est = est525({ grandTotal: 900 });
  const { server } = render(env, openInvoice(env, est));
  ok('a $386 gap is not printed as "Rounding"', !server.rounding && cents(server.total) === 51360);
}
{
  // Every other invoice caller still passes a DECIMAL taxRate and no tax.
  const html = env.dg.renderInvoice({ homeownerName: 'A', address: 'B', lineItems: [{ description: 'Job', qty: 1, unit: 'JOB', unitPrice: 1000 }], taxRate: 0.06 });
  ok('legacy fill-form invoice (decimal 0.06) unchanged: $60 tax, $1,060 balance, no rounding row', /\$60\.00/.test(html) && balanceOf(html) === '1,060.00' && !/Rounding/.test(html));
}

console.log('BUG 2 — Save to estimate keeps the customer total');
function saveEnv(est) {
  const e = loadEnv();
  const writes = [];
  e.win.db = {};
  e.win.doc = (db, col, id) => ({ col, id });
  e.win.updateDoc = async (ref, upd) => { writes.push({ ref, upd: JSON.parse(JSON.stringify(upd)) }); };
  e.win._customerEstimates = [est];
  e.win._leadDoc = {};
  return { e, writes };
}
(async () => {
  {
    const est = est525();
    const { e, writes } = saveEnv(est);
    const values = openInvoice(e, est);
    e.pf._state.values = values;
    ok('save: helper exposed', typeof e.pf._saveLineItemsToEstimate === 'function');
    if (typeof e.pf._saveLineItemsToEstimate === 'function') await e.pf._saveLineItemsToEstimate('lineItems');
    const u = writes[0] && writes[0].upd;
    ok('save with no edits: one write to estimates/E525', writes.length === 1 && writes[0].ref.id === 'E525');
    ok('save with no edits: grandTotal stays 52500 cents (was 48000)', !!u && cents(u.grandTotal != null ? u.grandTotal : est.grandTotal) === 52500 && cents(est.grandTotal) === 52500);
    ok('save with no edits: subtotal / tax untouched', !!u && u.subtotal === undefined && u.tax === undefined && est.subtotal === 480 && est.tax === 33.6);
  }
  {
    // Labor $300 → $400: $580 + $40.60 = $620.60 → nearest $25 = $625.
    const est = est525();
    const { e, writes } = saveEnv(est);
    const values = openInvoice(e, est, (v) => { v.lineItems[1] = Object.assign({}, v.lineItems[1], { rate: 400, total: 400 }); });
    e.pf._state.values = values;
    if (typeof e.pf._saveLineItemsToEstimate === 'function') await e.pf._saveLineItemsToEstimate('lineItems');
    const u = (writes[0] && writes[0].upd) || {};
    ok('save with edited lines: grandTotal $625 = $580 + $40.60 tax + $4.40 rounding', cents(u.grandTotal) === 62500 && cents(u.subtotal) === 58000 && cents(u.tax) === 4060 && u.minJobApplied === false);
    ok('save with edited lines: cached estimate follows', cents(est.grandTotal) === 62500);
  }
  {
    // Floored $500 job, line raised $200 → $250: $267.50 → $275 → floor $500.
    const est = est525({ lineItems: [{ description: 'Repair', quantity: 1, unitPrice: 200, amount: 200 }], subtotal: 200, tax: 14, grandTotal: 500, minJobApplied: true });
    const { e, writes } = saveEnv(est);
    const values = openInvoice(e, est, (v) => { v.lineItems[0] = Object.assign({}, v.lineItems[0], { rate: 250, total: 250 }); });
    e.pf._state.values = values;
    if (typeof e.pf._saveLineItemsToEstimate === 'function') await e.pf._saveLineItemsToEstimate('lineItems');
    const u = (writes[0] && writes[0].upd) || {};
    ok('save on a floored job keeps the $500 minimum', cents(u.grandTotal) === 50000 && u.minJobApplied === true && cents(u.minJobCharge) === 50000);
  }
  {
    // Merge with R2-2-2 (#2247, 2026-10-07): estimate.lineItems (contract,
    // proposal...) now ends with derived "Sales tax" / "Rounding" footing rows.
    // The invoice prefills WITHOUT them (its tax comes from Tax Rate (%)), and
    // Save from a document that shows them never writes them back as lines.
    const est = est525();
    const ctx = { lead: {}, estimate: est, photos: [], overrides: {}, depositDropped: [] };
    const contractLines = env.pf._resolveFieldValue({ key: 'lineItems', source: 'estimate.lineItems' }, ctx);
    const invoiceLines = openInvoice(env, est).lineItems;
    ok('merge: contract lines carry the TAX + ADJ footing rows (R2-2-2)', contractLines.some((r) => r.code === 'TAX') && contractLines.some((r) => r.code === 'ADJ'));
    ok('merge: invoice lines do not (tax is not counted twice)', invoiceLines.length === 2 && !invoiceLines.some((r) => r.code === 'TAX' || r.code === 'ADJ'));
    const { e, writes } = saveEnv(est);
    e.pf._state.values = { lineItems: JSON.parse(JSON.stringify(contractLines)) };
    await e.pf._saveLineItemsToEstimate('lineItems');
    const u = (writes[0] && writes[0].upd) || {};
    ok('merge: Save from a footed document writes only the priced lines and keeps $525',
      Array.isArray(u.lineItems) && u.lineItems.length === 2 && !u.lineItems.some((r) => /sales tax|rounding/i.test(r.description || ''))
      && u.grandTotal === undefined && cents(est.grandTotal) === 52500);
  }
  {
    const est = { id: 'EPSQ', priceMode: 'per-sq', prices: { better: 12000 }, selectedTier: 'better', taxRate: 0.07, grandTotal: 12000 };
    const { e, writes } = saveEnv(est);
    const values = openInvoice(e, est, (v) => { v.lineItems[0] = Object.assign({}, v.lineItems[0], { rate: 9000, total: 9000 }); });
    e.pf._state.values = values;
    if (typeof e.pf._saveLineItemsToEstimate === 'function') await e.pf._saveLineItemsToEstimate('lineItems');
    const u = (writes[0] && writes[0].upd) || {};
    ok('per-SQ save never touches grandTotal', writes.length === 1 && u.grandTotal === undefined && est.grandTotal === 12000);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
