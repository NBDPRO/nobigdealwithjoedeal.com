/**
 * tests/preflight-save-to-estimate-r6-2026-10-07.test.js
 *
 * Review round 6, R6-2-1 (+ the Save half of R6-2-7), 2026-10-07.
 *
 * THE BUG. Doc pre-flight's "Save to estimate" wrote est.lineItems and, since
 * #2198, re-totalled subtotal / tax / grandTotal. Every builder (V2, the V3
 * wizard that saves through V2, Classic, Job Templates) keeps its lines on
 * est.rows, and every surface that prints or bills the job reads rows:
 *   - the e-sign contract + estimate link   buildDisplayRows (functions/ and
 *                                           the docs/pro/js mirror)
 *   - the CRM invoice + deposit / final     invoiceTotalsFromEstimate →
 *     drafts                                buildRowItems (both copies)
 *   - Stripe's pay link                     lines + tax must equal the total
 *   - the V2 reopen                         rebuilds rows from its own inputs
 * Worked example (the R6 one): a V2 estimate of $8,000 + $2,000 lines and 7%
 * tax = $10,700. The rep adds a $1,000 ridge-vent line on the contract and
 * taps Save. The estimate became $11,775 while the contract and invoice
 * printed $10,775 of lines, Stripe refused the link, and the next V2 save put
 * it back to $10,700.
 *
 * THE FIX. A builder estimate (it has rows) is changed in its builder: Save
 * to estimate writes nothing and says so, and the button is replaced by that
 * reason. Writing rows from the pre-flight was not safe (each builder rebuilds
 * rows from its own inputs on reopen, and the cost split, O&P, upgrades and
 * deposit plan beside them would go stale). Save stays for estimates whose
 * lines really are lineItems (a logged amount-only estimate, legacy docs), and
 * for those:
 *   - the invoice reads lineItems' own field names (quantity / unitPrice /
 *     amount) instead of pricing every line at $0;
 *   - a re-totalled PRIMARY estimate moves lead.jobValue (R6-2-7);
 *   - a signed estimate is not re-priced from here (Jo, 2026-10-07: the
 *     signed price is what the homeowner is billed).
 * And buildDocLineItems prefers rows over lineItems, so a doc damaged by the
 * old Save shows the pre-flight the same lines the contract prints.
 *
 * Drives the real modules: doc-preflight.js + the doc generator vm-loaded
 * with a recording updateDoc, customer-estimate-rows.js (both copies),
 * invoice-from-estimate.js + invoice-pipeline.js, deposit-draft-logic.js, and
 * the footing block lifted out of functions/stripe.js. Money in cents.
 * Run: node tests/preflight-save-to-estimate-r6-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DG_DIR = path.join(ROOT, 'docs/pro/js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const c = (n) => Math.round(Number(n) * 100);
const sumC = (rows) => rows.reduce((s, r) => s + c(r.total != null ? r.total : r.amount), 0);

// ── The real modules ────────────────────────────────────────────────────
const CER_FN = require(path.join(ROOT, 'functions/customer-estimate-rows.js'));
const IFE = require(path.join(ROOT, 'functions/invoice-from-estimate.js'));
const DDL = require(path.join(ROOT, 'functions/deposit-draft-logic.js'));
global.window = {};
const IP = require(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'));
// The browser copy of customer-estimate-rows.js, loaded the way the page does.
const CER_WEB = (() => {
  const sb = { window: {}, console };
  vm.runInNewContext(read('docs/pro/js/customer-estimate-rows.js'), sb, { filename: 'customer-estimate-rows.js' });
  return sb.window.NBDCustomerEstimateRows;
})();

// The real doc pre-flight + doc generator, with a recording updateDoc and a
// captured toast (the harness tests/doc-preflight-invoice-tax-2026-10-05 uses).
function preflightEnv(est, lead) {
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
    vm.runInNewContext(fs.readFileSync(path.join(DG_DIR, f), 'utf8'), sandbox, { filename: f });
  }
  const writes = [];
  const toasts = [];
  win.db = {};
  win.doc = (db, col, id) => ({ col, id });
  win.updateDoc = async (ref, upd) => { writes.push({ ref, upd: JSON.parse(JSON.stringify(upd)) }); };
  win.showToast = (msg, type) => { toasts.push({ msg, type }); };
  win._customerEstimates = [est];
  win._leadDoc = lead || { primaryEstimateId: est.id, jobValue: est.grandTotal };
  return { pf: win.DocPreflight, writes, toasts, win };
}
// The line-items editor's HTML ('' when the renderer is not exposed).
const renderOf = (env, field, items) => (typeof env.pf._renderLineItems === 'function' ? env.pf._renderLineItems(field, items) : '');
const contractCtx = (est) => ({ lead: {}, estimate: est, photos: [], overrides: {}, depositDropped: [] });
const preflightLines = (env, est) => env.pf._resolveFieldValue({ key: 'lineItems', source: 'estimate.lineItems' }, contractCtx(est));

// The Stripe footing block of createStripePaymentLink, lifted from
// functions/stripe.js (it is not exported) — same lift as
// tests/invoice-rounding-minjob-line-2026-10-05.test.js.
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
      InvoiceCharge: require(path.join(ROOT, 'functions', 'invoice-charge.js')) };
    vm.createContext(ctx);
    await vm.runInContext('(async () => {\n' + body + '\n__out = { chargeLineItems, linkTotalCents, expectedTotalCents };\n})()', ctx);
    if (refused) return { ok: false, error: refused.error };
    return Object.assign({ ok: true }, ctx.__out);
  };
}
const footing = liftFooting();

// Every surface's figure for one saved estimate, in cents.
async function surfaces(est) {
  const out = {};
  out.contractFn = sumC(CER_FN.buildDisplayRows(est).length ? CER_FN.buildDisplayRows(est) : CER_FN.buildDocLineItems(est));
  out.contractWeb = sumC(CER_WEB.buildDisplayRows(est).length ? CER_WEB.buildDisplayRows(est) : CER_WEB.buildDocLineItems(est));
  out.docLines = sumC(CER_FN.buildDocLineItems(est));
  const invS = IFE.invoiceTotalsFromEstimate(est, { estimateValue: CER_FN.estimateValue });
  const invB = IP.invoiceTotalsFromEstimate(est, { estimateValue: CER_FN.estimateValue });
  out.invoiceServerLinesPlusTax = sumC(invS.items) + c(invS.tax);
  out.invoiceServerTotal = c(invS.total);
  out.invoiceBrowserLinesPlusTax = sumC(invB.items) + c(invB.tax);
  out.invoiceBrowserTotal = c(invB.total);
  const pay = footing ? await footing({ items: invS.items, tax: invS.tax, total: invS.total, amountPaid: 0 }) : { ok: false, error: 'footing not liftable' };
  out.stripe = pay.ok ? pay.linkTotalCents : ('refused: ' + pay.error);
  const lead = { userId: 'u', primaryEstimateId: est.id, address: est.addr, state: 'OH', activeJobId: 'J1' };
  const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed', lead, est, estimateId: est.id, existingInvoices: [] });
  out.depositDraftTotal = dd && dd.invoice ? c(dd.invoice.total) : ('no draft: ' + (dd && (dd.reason || dd.action)));
  out.price = c(CER_FN.estimateValue(est));
  return out;
}
const allEqual = (s, cents) => Object.keys(s).every((k) => s[k] === cents);

const OH = '1 Main St, Cincinnati, OH 45202';
// The R6 example: a V2 line-item estimate, rows at the retail price, 7% tax.
// $8,000 + $2,000 = $10,000 + $700 tax = $10,700.
function v2Estimate(extra) {
  return Object.assign({
    id: 'EV2', userId: 'u', leadId: 'L', builder: 'v2', estimateVersion: 'v2', priceMode: 'line-item', prices: null,
    tier: 'better', selectedTier: 'better', materialMarkupPct: 0.25, overhead: 0, profit: 0,
    rows: [
      { code: 'RFG', desc: 'Shingles', qty: '30.00SQ', retailTotal: 8000, total: 8000 },
      { code: 'LAB', desc: 'Labor', qty: '30.00SQ', retailTotal: 2000, total: 2000 },
    ],
    subtotal: 10000, tax: 700, taxRate: 0.07, grandTotal: 10700, minJobApplied: false,
    mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
  }, extra || {});
}
// A V3-wizard estimate. The V3 wizard saves through V2's save path (header of
// estimate-v3-wizard.js), so its doc is V2-shaped; this one carries the full
// ladder: cost split + 25% markup, 10% + 10% O&P, 7% tax, nearest-$25
// rounding. $150 + $250 + $80 O&P = $480 + $33.60 tax + $11.40 = $525.
function v3Estimate(extra) {
  return Object.assign({
    id: 'EV3', userId: 'u', leadId: 'L', builder: 'v2', estimateVersion: 'v2', priceMode: 'line-item', prices: null,
    materialMarkupPct: 0.25, taxRate: 0.07,
    rows: [
      { code: 'SHG', desc: 'Shingles', qty: '1.00EA', materialTotal: 120, laborTotal: 0 },
      { code: 'LBR', desc: 'Install labor', qty: '1.00EA', materialTotal: 0, laborTotal: 250 },
    ],
    overhead: 40, profit: 40, overheadPct: 0.10, profitPct: 0.10,
    subtotal: 480, tax: 33.60, grandTotal: 525, minJobApplied: false,
    mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
  }, extra || {});
}
// A logged (amount-only) estimate: no rows, the shape Save is still for.
function loggedEstimate(extra) {
  return Object.assign({
    id: 'ELOG', userId: 'u', leadId: 'L', type: 'roof', title: 'Roof replacement', amount: 10700, grandTotal: 10700,
    taxRate: 0.07, mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
  }, extra || {});
}

(async () => {
  ok('setup: the Stripe footing block lifts out of functions/stripe.js', !!footing);
  ok('setup: both customer-estimate-rows copies load', !!CER_WEB && typeof CER_WEB.buildDisplayRows === 'function');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n1. V2 estimate: the R6 worked example ($10,700 + a $1,000 line)');
  {
    const est = v2Estimate();
    const env = preflightEnv(est);
    const lines = preflightLines(env, est);
    ok('the contract pre-flight shows the rows: Shingles $8,000, Labor $2,000, Sales tax $700 = $10,700',
      lines.length === 3 && c(lines[0].total) === 800000 && lines[2].code === 'TAX' && sumC(lines) === 1070000,
      JSON.stringify(lines.map((l) => [l.description, l.total])));
    const edited = JSON.parse(JSON.stringify(lines));
    edited.splice(2, 0, { description: 'Ridge vent upgrade', qty: 1, unit: 'ea', rate: 1000, total: 1000 });
    env.pf._state.values = { lineItems: edited };
    env.pf._state.estimate = est;
    await env.pf._saveLineItemsToEstimate('lineItems');
    ok('Save to estimate writes NOTHING for a builder estimate (was: lineItems + grandTotal $11,775, rows untouched)',
      env.writes.length === 0, JSON.stringify(env.writes));
    ok('…and tells the rep to change the lines in the estimate builder',
      env.toasts.length === 1 && env.toasts[0].type === 'error' && /estimate builder/.test(env.toasts[0].msg) && /Override/.test(env.toasts[0].msg),
      JSON.stringify(env.toasts));
    ok('the cached estimate is untouched ($10,700, no lineItems)', c(est.grandTotal) === 1070000 && est.lineItems === undefined);
    const s = await surfaces(est);
    ok('every surface says $10,700: contract (functions + browser copies), document lines, invoice lines + tax (server + browser), '
      + 'invoice total, Stripe link, deposit draft, price', allEqual(s, 1070000), JSON.stringify(s));
    // The button itself.
    env.pf._state.lineItemsMode = { lineItems: 'override' };
    const html = renderOf(env, { key: 'lineItems' }, edited);
    ok('Override mode on a builder estimate shows the reason, not a "Save to estimate" button',
      !/data-li-save-est=/.test(html) && /data-li-save-blocked="lineItems"/.test(html) && /estimate builder/.test(html) && /Override<\/button>|Revert to estimate/.test(html));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n2. V3-wizard estimate with O&P, tax and the Rounding / Minimum job rows');
  for (const [label, est, cents, adjLabel] of [
    ['nearest-$25 rounding', v3Estimate(), 52500, 'Rounding'],
    ['$1,500 job minimum', v3Estimate({ grandTotal: 1500, minJobApplied: true, minJobCharge: 1500 }), 150000, 'Minimum job charge adjustment'],
  ]) {
    const env = preflightEnv(est);
    const lines = preflightLines(env, est);
    ok('V3 ' + label + ': the pre-flight lines are the rows + O&P + Sales tax + "' + adjLabel + '" and foot to $' + (cents / 100).toFixed(2),
      sumC(lines) === cents && lines.some((l) => l.code === 'O&P') && lines.some((l) => l.code === 'TAX') && lines.some((l) => l.code === 'ADJ' && l.description === adjLabel),
      JSON.stringify(lines.map((l) => [l.code, l.description, l.total])));
    // Save with NO edits, and Save with a raised labor line: both refused.
    for (const [what, mutate] of [['no edits', (x) => x], ['labor $250 → $400', (x) => { x[1].rate = 400; x[1].total = 400; return x; }]]) {
      const e2 = preflightEnv(est);
      e2.pf._state.values = { lineItems: mutate(JSON.parse(JSON.stringify(lines))) };
      e2.pf._state.estimate = est;
      await e2.pf._saveLineItemsToEstimate('lineItems');
      ok('V3 ' + label + ', ' + what + ': Save writes nothing (no O&P or tax row saved back as a line, no re-total)', e2.writes.length === 0, JSON.stringify(e2.writes));
    }
    const s = await surfaces(est);
    // A cash job under $2,000 makes no deposit draft (deposit rule), so that
    // surface is checked for its own answer and left out of the comparison.
    ok('V3 ' + label + ': no deposit draft on a cash job under $2,000', s.depositDraftTotal === 'no draft: cash_under_threshold', String(s.depositDraftTotal));
    delete s.depositDraftTotal;
    ok('V3 ' + label + ': every other surface says $' + (cents / 100).toFixed(2), allEqual(s, cents), JSON.stringify(s));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n3. Classic-builder and Job Template estimates also keep their lines on rows');
  {
    const classic = { id: 'ECL', leadId: 'L', rows: [{ code: 'TO', desc: 'Tear-off', qty: '20 SQ', rate: '$100/SQ', total: 2000 }, { code: 'SH', desc: 'Shingles', qty: '20 SQ', rate: '$300/SQ', total: 6000 }],
      subtotal: 8000, taxAmount: 0, taxRate: 0, grandTotal: 8000, mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1 };
    const tpl = Object.assign(v2Estimate({ id: 'ETPL', builder: 'template', sourceTemplates: ['jt_gi_k5_seamless_full'], tierApplies: false }));
    for (const [label, est, cents] of [['Classic', classic, 800000], ['Job Template', tpl, 1070000]]) {
      const env = preflightEnv(est);
      const lines = preflightLines(env, est);
      lines.push({ description: 'Extra', qty: 1, unit: 'ea', rate: 500, total: 500 });
      env.pf._state.values = { lineItems: lines };
      env.pf._state.estimate = est;
      await env.pf._saveLineItemsToEstimate('lineItems');
      ok(label + ': Save writes nothing', env.writes.length === 0);
      const s = await surfaces(est);
      ok(label + ': every surface says $' + (cents / 100).toFixed(2), allEqual(s, cents), JSON.stringify(s));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n4. A doc the old Save already wrote lineItems onto: the pre-flight shows the rows the contract prints');
  {
    const est = v2Estimate({
      lineItems: [
        { description: 'Shingles', quantity: 1, unit: 'ea', unitPrice: 8000, amount: 8000 },
        { description: 'Labor', quantity: 1, unit: 'ea', unitPrice: 2000, amount: 2000 },
        { description: 'Ridge vent upgrade', quantity: 1, unit: 'ea', unitPrice: 1000, amount: 1000 },
      ],
    });
    const env = preflightEnv(est);
    const lines = preflightLines(env, est);
    const contract = CER_FN.buildDisplayRows(est);
    ok('the pre-flight lines are the contract\'s lines (rows win over stale lineItems), in both copies',
      JSON.stringify(lines.map((l) => [l.description, c(l.total)])) === JSON.stringify(contract.map((r) => [r.desc, c(r.total)]))
      && JSON.stringify(CER_WEB.buildDocLineItems(est).map((l) => c(l.total))) === JSON.stringify(lines.map((l) => c(l.total)))
      && !lines.some((l) => /upgrade/i.test(l.description)),
      JSON.stringify({ preflight: lines.map((l) => [l.description, l.total]), contract: contract.map((r) => [r.desc, r.total]) }));
    const s = await surfaces(est);
    ok('…and every surface still says $10,700', allEqual(s, 1070000), JSON.stringify(s));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n5. A logged estimate (no rows) still saves, and every surface follows: $10,700 → $11,775');
  {
    const est = loggedEstimate();
    const lead = { primaryEstimateId: 'ELOG', jobValue: 10700 };
    const env = preflightEnv(est, lead);
    env.pf._state.lineItemsMode = { lineItems: 'override' };
    env.pf._state.estimate = est;
    ok('Override mode on a logged estimate offers "Save to estimate"', /data-li-save-est="lineItems"/.test(renderOf(env, { key: 'lineItems' }, [])));
    // The rep types the scope: $10,000 roof + the $1,000 ridge-vent upgrade.
    env.pf._state.values = { lineItems: [
      { description: 'Tear-off and shingles', qty: 1, unit: 'ea', rate: 10000, total: 10000 },
      { description: 'Ridge vent upgrade', qty: 1, unit: 'ea', rate: 1000, total: 1000 },
    ] };
    await env.pf._saveLineItemsToEstimate('lineItems');
    const estW = env.writes.find((w) => w.ref.col === 'estimates');
    const leadW = env.writes.find((w) => w.ref.col === 'leads');
    const u = (estW && estW.upd) || {};
    ok('the estimate re-totals by the quote rule: $11,000 + $770 tax = $11,770 → $11,775',
      !!estW && c(u.subtotal) === 1100000 && c(u.tax) === 77000 && c(u.grandTotal) === 1177500 && Array.isArray(u.lineItems) && u.lineItems.length === 2,
      JSON.stringify(u));
    ok('R6-2-7: the primary estimate\'s new total reaches lead.jobValue ($10,700 → $11,775) on leads/L',
      !!leadW && leadW.ref.id === 'L' && c(leadW.upd.jobValue) === 1177500 && c(lead.jobValue) === 1177500,
      JSON.stringify(env.writes.map((w) => [w.ref.col, w.ref.id, w.upd.jobValue])));
    const saved = Object.assign({}, est, u);
    const s = await surfaces(saved);
    ok('every surface says $11,775: contract (lineItems fallback, both copies), document lines, invoice lines + tax (server + browser; '
      + 'was $5.00 + $770 tax — every line priced $0), invoice total, Stripe link (was refused), deposit draft, price',
      allEqual(s, 1177500), JSON.stringify(s));
    const inv = IFE.invoiceTotalsFromEstimate(saved, { estimateValue: CER_FN.estimateValue });
    ok('the invoice lines are $10,000 + $1,000 + Rounding $5 (no Sales tax line — tax is the invoice\'s own)',
      JSON.stringify(inv.items.map((i) => c(i.total))) === JSON.stringify([1000000, 100000, 500]) && !inv.items.some((i) => /sales tax/i.test(i.description)),
      JSON.stringify(inv.items));
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed', lead: { userId: 'u', primaryEstimateId: 'ELOG', address: OH, state: 'OH', activeJobId: 'J1' }, est: saved, estimateId: 'ELOG', existingInvoices: [] });
    ok('the deposit draft asks 50% of $11,775, to the nearest $25 = $5,900', dd && dd.invoice && c(dd.invoice.depositAmount) === 590000, JSON.stringify(dd && dd.invoice && { total: dd.invoice.total, dep: dd.invoice.depositAmount }));
  }
  {
    // Not the primary estimate: the lead is left alone.
    const est = loggedEstimate();
    const lead = { primaryEstimateId: 'OTHER', jobValue: 9000 };
    const env = preflightEnv(est, lead);
    env.pf._state.values = { lineItems: [{ description: 'Roof', qty: 1, unit: 'ea', rate: 11000, total: 11000 }] };
    await env.pf._saveLineItemsToEstimate('lineItems');
    ok('a non-primary estimate re-totals but never writes the lead', env.writes.length === 1 && env.writes[0].ref.col === 'estimates' && lead.jobValue === 9000);
  }
  {
    // Saved again with the same lines: no re-total, no lead write.
    const est = loggedEstimate({ lineItems: [{ description: 'Roof', quantity: 1, unit: 'ea', unitPrice: 11000, amount: 11000 }], subtotal: 11000, tax: 770, grandTotal: 11775 });
    const lead = { primaryEstimateId: 'ELOG', jobValue: 11775 };
    const env = preflightEnv(est, lead);
    env.pf._state.values = { lineItems: preflightLines(env, est) };
    await env.pf._saveLineItemsToEstimate('lineItems');
    ok('Save with unchanged lines keeps $11,775 and writes no lead', env.writes.length === 1 && env.writes[0].upd.grandTotal === undefined && c(est.grandTotal) === 1177500);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n6. A signed estimate is not re-priced from the pre-flight (Jo: the signed price is what is billed)');
  {
    const est = loggedEstimate({ signatureStatus: 'signed', lineItems: [{ description: 'Roof', quantity: 1, unit: 'ea', unitPrice: 10000, amount: 10000 }], subtotal: 10000, tax: 700, grandTotal: 10700 });
    const env = preflightEnv(est, { primaryEstimateId: 'ELOG', jobValue: 10700 });
    env.pf._state.values = { lineItems: [{ description: 'Roof', qty: 1, unit: 'ea', rate: 12000, total: 12000 }] };
    env.pf._state.estimate = est;
    await env.pf._saveLineItemsToEstimate('lineItems');
    ok('Save on a signed estimate writes nothing and says the signed price stands',
      env.writes.length === 0 && env.toasts.length === 1 && /signed/.test(env.toasts[0].msg), JSON.stringify({ w: env.writes, t: env.toasts }));
    env.pf._state.lineItemsMode = { lineItems: 'override' };
    ok('…and its Override mode shows that reason instead of the button', !/data-li-save-est=/.test(renderOf(env, { key: 'lineItems' }, [])));
    const s = await surfaces(est);
    ok('every surface still bills the signed $10,700', allEqual(s, 1070000), JSON.stringify(s));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n7. Mirrors and unchanged shapes');
  {
    ok('customer-estimate-rows.js is byte-identical in functions/ and docs/pro/js/ (EOL-normalised)',
      lf(read('functions/customer-estimate-rows.js')) === lf(read('docs/pro/js/customer-estimate-rows.js')));
    const blk = (s) => { s = lf(s); const a = s.indexOf('// nbd:invoice-from-estimate:start'); const b = s.indexOf('// nbd:invoice-from-estimate:end'); return a < 0 || b < 0 ? null : s.slice(a, b); };
    ok('nbd:invoice-from-estimate is byte-identical in both invoice copies',
      !!blk(read('functions/invoice-from-estimate.js')) && blk(read('functions/invoice-from-estimate.js')) === blk(read('docs/pro/js/invoice-pipeline.js')));
    // A classic lineItems doc with an EMPTY rows array still invoices its lineItems.
    const est = { lineItems: [{ description: 'Roof', quantity: 2, unitPrice: 500, amount: 1000 }], rows: [], grandTotal: 1000, subtotal: 1000, tax: 0, taxRate: 0 };
    for (const [who, M] of [['server', IFE], ['browser', IP]]) {
      const t = M.invoiceTotalsFromEstimate(est, {});
      ok(who + ': an empty rows array falls through to lineItems (qty 2 × $500 = $1,000)',
        t.items.length === 1 && c(t.items[0].total) === 100000 && t.items[0].quantity === 2 && c(t.items[0].unitPrice) === 50000, JSON.stringify(t.items));
    }
    // A V2 row with a display qty and a rate string keeps reading exactly as before.
    const v2 = IFE.buildRowItems({ rows: [{ desc: 'Shingles', qty: '30.00SQ', rate: '$266.67', total: 8000, unitPrice: 999 }] });
    ok('a classic-shaped row still reads qty / rate / total (unitPrice beside them is ignored)',
      v2.length === 1 && v2[0].quantity === 30 && c(v2[0].unitPrice) === 26667 && c(v2[0].total) === 800000, JSON.stringify(v2));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
