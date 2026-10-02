/**
 * tests/estimate-profit.test.js — Phase 4 profit + supplement math.
 *
 * The core estimate pricing engine (estimate-builder-v2) is already covered by
 * estimate-pricing.test.js. This file exercises the two adjacent money engines
 * that were untested, in a vm sandbox over their browser IIFEs:
 *   - ProfitTracker.computeJobPL / computeMarginAnalytics — job P&L + margins
 *   - EstimateSupplement.calculateDelta — insurance-supplement OH&P + rounding
 *
 * Zero deps. Run: node tests/estimate-profit.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
const near = (a, b) => Math.abs(a - b) < 0.005;

// `pre` files load into the same window first — invoice-pipeline.js reads
// deposit-rule.js, which dashboard.html loads eagerly (2026-09-25).
function loadIIFE(file, pre) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', file), 'utf8');
  const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
  const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' } };
  win.window = win;
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return noop(); }, body: noop(), readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.createContext(sandbox);
  (pre || []).forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', f), 'utf8'), sandbox, { filename: f }));
  vm.runInContext(src, sandbox, { filename: file });
  return win;
}

// ── ProfitTracker ────────────────────────────────────────────
{
  console.log('PROFIT TRACKER — computeJobPL / computeMarginAnalytics');
  const win = loadIIFE('profit-tracker.js');
  const PT = win.ProfitTracker;
  ok('exposes ProfitTracker.computeJobPL', PT && typeof PT.computeJobPL === 'function');

  // revenue 20000, mat 6000, lab 4000, misc 1000, overhead 10% = 2000.
  const pl = PT.computeJobPL({ jobValue: 20000, materialCost: 6000, laborCost: 4000, miscCosts: 1000, overheadPct: 10 });
  ok('overhead = revenue * pct (2000)', near(pl.overhead, 2000));
  ok('totalCost = mat+lab+overhead+misc (13000)', near(pl.totalCost, 13000));
  ok('grossProfit excludes overhead (9000)', near(pl.grossProfit, 9000));
  ok('netProfit = revenue - totalCost (7000)', near(pl.netProfit, 7000));
  ok('grossMargin = 45%', pl.grossMargin === 45);
  ok('netMargin = 35%', pl.netMargin === 35);

  // default overhead 10% when overheadPct omitted
  const pl2 = PT.computeJobPL({ jobValue: 10000, materialCost: 0, laborCost: 0 });
  ok('default overhead pct 10% applied (overhead 1000)', near(pl2.overhead, 1000));
  ok('zero revenue → margins 0 (no NaN)', PT.computeJobPL({}).grossMargin === 0 && PT.computeJobPL({}).netMargin === 0);

  // Audit 2026-08-02 (the #1139 rule): a saved 0% overhead is a REAL answer.
  // `parseFloat(x) || DEFAULT` swallowed it on read, write and hydration —
  // a 0%-overhead shop silently computed (and re-saved) 10%.
  const pl0 = PT.computeJobPL({ jobValue: 10000, materialCost: 0, laborCost: 0, overheadPct: 0 });
  ok('explicit overheadPct 0 is trusted on read (overhead 0, not 1000)', near(pl0.overhead, 0));
  ok('overheadPct 0 → netProfit equals grossProfit', near(pl0.netProfit, pl0.grossProfit));
  ok('non-numeric overheadPct still falls to the 10% default',
    near(PT.computeJobPL({ jobValue: 10000, overheadPct: 'abc' }).overhead, 1000));

  // Write path: saveJobCosts must persist the 0, not the default. The
  // capture is synchronous — updateDoc is CALLED before its promise is
  // awaited — so no async plumbing is needed in this sync section.
  {
    let captured = null;
    win.db = {}; win._user = { uid: 'u1' }; win._leads = [];
    win.doc = () => ({});
    win.updateDoc = (_ref, data) => { captured = data; return Promise.resolve(); };
    PT.saveJobCosts('L1', { materialCost: '100', laborCost: '50', overheadPct: '0', miscCosts: '' });
    ok('saveJobCosts persists overheadPct 0 (old code wrote 10)', !!captured && captured.overheadPct === 0);
    PT.saveJobCosts('L1', { overheadPct: '' });
    ok('saveJobCosts still defaults a BLANK overhead to 10', !!captured && captured.overheadPct === 10);
  }

  // Hydration: the form input must not re-map a saved 0 back to the default.
  const ptSrc = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', 'profit-tracker.js'), 'utf8');
  ok('form hydration no longer uses `lead.overheadPct || DEFAULT`',
    !/lead\.overheadPct \|\| DEFAULT_OVERHEAD_PCT/.test(ptSrc)
    && !/parseFloat\((?:costs|lead)\.overheadPct\) \|\| DEFAULT_OVERHEAD_PCT/.test(ptSrc));

  // computeMarginAnalytics aggregates only WON jobs that have costs.
  win._leads = [
    { stage: 'closed', jobValue: 20000, materialCost: 6000, laborCost: 4000, miscCosts: 1000, overheadPct: 10 },
    { stage: 'closed', jobValue: 10000, materialCost: 2000, laborCost: 1000, overheadPct: 10 },
    { stage: 'new',    jobValue: 50000, materialCost: 9000, laborCost: 9000 }, // not WON → excluded
    { stage: 'closed', jobValue: 8000 },                                       // WON but no costs → excluded from margins
    { stage: 'closed', jobValue: 5000, materialCost: 1000, laborCost: 500, deleted: true }, // deleted → excluded
  ];
  const m = PT.computeMarginAnalytics();
  ok('marginAnalytics tracks only the 2 WON-with-costs jobs', m.jobsTracked === 2);
  ok('totalRevenue counts both tracked jobs (30000)', near(m.totalRevenue, 30000));
  ok('avgGrossMargin is a sane 0-100 number', m.avgGrossMargin > 0 && m.avgGrossMargin <= 100);
  ok('totalProfit = revenue - totalCost', near(m.totalProfit, m.totalRevenue - m.totalCost));
}

// ── EstimateSupplement.calculateDelta ────────────────────────
{
  console.log('\nESTIMATE SUPPLEMENT — calculateDelta (OH&P + $25 rounding)');
  const ES = loadIIFE('estimate-supplement.js').EstimateSupplement;
  ok('exposes EstimateSupplement.calculateDelta', ES && typeof ES.calculateDelta === 'function');

  const sup = {
    settingsSnapshot: { overheadPct: 0.10, profitPct: 0.10, materialMarkupPct: 0.25, roundTo: 25 },
    originalTotal: 10000,
    addedItems: [{ quantity: 10, materialCostPerUnit: 5, laborCostPerUnit: 3 }], // mat 50, lab 30
    modifiedItems: [],
  };
  ES.calculateDelta(sup);
  ok('supplementMaterial = qty*matCost (50)', near(sup.supplementMaterial, 50));
  ok('supplementLabor = qty*labCost (30)', near(sup.supplementLabor, 30));
  ok('material retail applies 25% markup (62.5)', near(sup.supplementMatRetail, 62.5));
  ok('retailPreOhp = matRetail + labor (92.5)', near(sup.supplementRetailPreOhp, 92.5));
  ok('OH&P = (10%+10%) of preOhp (18.5)', near(sup.supplementOhp, 18.5));
  ok('subtotal = preOhp + OH&P (111)', near(sup.supplementSubtotal, 111));
  ok('total rounded to nearest $25 (100)', sup.supplementTotal === 100);
  ok('newGrandTotal = original + supplement (10100)', sup.newGrandTotal === 10100);
  ok('supplements skip tax (0)', sup.supplementTax === 0);
  ok('deltaPct = supplement/original*100 (1%)', near(sup.deltaPct, 1));

  // line totals stamped on each added item
  ok('added item lineTotal stamped (10 * (5+3) = 80)', near(sup.addedItems[0].lineTotal, 80));

  // modification deltas roll in
  const sup2 = {
    settingsSnapshot: { overheadPct: 0.10, profitPct: 0.10, materialMarkupPct: 0.25, roundTo: 25 },
    originalTotal: 5000,
    addedItems: [],
    modifiedItems: [{ deltaMaterial: 200, deltaLabor: 100 }],
  };
  ES.calculateDelta(sup2);
  ok('modification deltas feed supplementMaterial/Labor', near(sup2.supplementMaterial, 200) && near(sup2.supplementLabor, 100));
}

// ── InvoicePipeline.createInvoiceFromEstimate ────────────────
(async () => {
  console.log('\nINVOICE PIPELINE — createInvoiceFromEstimate (totals + deposit)');
  const win = loadIIFE('invoice-pipeline.js', ['deposit-rule.js']);
  const IP = win.InvoicePipeline;
  ok('exposes InvoicePipeline.createInvoiceFromEstimate', IP && typeof IP.createInvoiceFromEstimate === 'function');

  // Stub the v9 Firestore globals: read returns an estimate, write captures the
  // built invoice so we can assert the money math.
  const EST = { leadId: 'L1', customerId: 'C1', rows: [
    { desc: 'Shingles', qty: 2, rate: 100, total: 200 },
    { desc: 'Labor', qty: 1, rate: 300, total: 300 },
  ] };
  let captured = null;
  Object.assign(win, {
    _db: {}, doc: () => ({}), collection: () => ({}),
    getDoc: async () => ({ exists: () => true, data: () => EST }),
    addDoc: async (_c, data) => { captured = data; return { id: 'inv_1' }; },
  });

  const id = await IP.createInvoiceFromEstimate('est1');
  ok('returns new invoice id', id === 'inv_1');
  ok('subtotal = sum of row totals (500)', near(captured.subtotal, 500));
  ok('tax = 7.5% of subtotal (37.5) — fallback when estimate has no rate', near(captured.tax, 37.5));
  ok('total = subtotal + tax (537.5)', near(captured.total, 537.5));
  // Deposit rule (2026-09-25): a $537.50 cash job is under $2,000 → no
  // deposit. This used to assert the 50% fallback ($268.75) the rule retired.
  ok('deposit follows the rule: $537.50 cash is under $2,000 → no deposit (0)', captured.depositAmount === 0);
  ok('invoice terms carry the rule\'s sentence, not "50% deposit due upon scheduling"',
    /^Net 14\. No deposit\. The full \$537\.50 is due on completion\.$/.test(captured.terms) && !/50%/.test(captured.terms));
  // balanceDue = FULL total at create time — deliberately not total-deposit.
  // invoice-pipeline.js:225 books nothing as collected until a real payment
  // lands (recordPayment maintains balanceDue = total - amountPaid).
  ok('balanceDue = full total until payments land (537.5)', near(captured.balanceDue, 537.5));
  ok('new invoice starts in draft, unpaid', captured.status === 'draft' && captured.depositPaid === false);
  ok('carries leadId + estimateId linkage', captured.leadId === 'L1' && captured.estimateId === 'est1');

  // F-3: invoice inherits the estimate's tax rate (e.g. Texas 8.25%) instead of
  // a hardcoded 7.5%, and honors a 0 rate (insurance scope skips tax).
  EST.taxRate = 0.0825;
  await IP.createInvoiceFromEstimate('est1');
  ok('inherits estimate taxRate 8.25% (tax 41.25, not 37.5)', near(captured.tax, 41.25) && near(captured.taxRate, 0.0825));
  EST.taxRate = 0;
  await IP.createInvoiceFromEstimate('est1');
  ok('honors 0 tax rate from insurance-scope estimate (tax 0)', captured.tax === 0 && captured.total === 500);

  // V2-pkb regression (estimate-qa-2026-06-08): the CLASSIC builder persists
  // deposit as an OBJECT {pct,amount,remainder}; the invoice must coerce it to a
  // number, not Number({...}) === NaN (which broke deposit/balanceDue on the
  // dominant classic path). The V2 builder persists deposit as a plain number.
  delete EST.taxRate; delete EST.priceMode; delete EST.prices; delete EST.grandTotal;
  EST.deposit = { pct: 50, amount: 250, remainder: 287.5 };
  await IP.createInvoiceFromEstimate('est1');
  // A saved deposit object is a pre-rule figure, not a rep choice: the rule
  // recomputes (still finite — the NaN guard this case was written for).
  ok('classic deposit OBJECT → numeric depositAmount from the rule (0 under $2,000, not NaN, not the stale 250)',
    Number.isFinite(captured.depositAmount) && captured.depositAmount === 0);
  ok('classic deposit OBJECT → balanceDue finite (= full total 537.5, deposit unpaid)', Number.isFinite(captured.balanceDue) && near(captured.balanceDue, 537.5));
  // The classic builder's Override % IS a rep choice — honored and labelled:
  // 40% of $537.50 = $215, on the rule's $25 step → $225.
  EST.depositPctOverride = 40;
  await IP.createInvoiceFromEstimate('est1');
  ok('classic rep override (40%) is honored on the invoice ($225)', near(captured.depositAmount, 225)
    && /^Net 14\. 40% deposit of \$225 due at signing; balance of \$312\.50 due on completion\.$/.test(captured.terms));
  delete EST.depositPctOverride;
  delete EST.deposit;

  // V2-pkb: PER-SQ estimates invoice the LOCKED selected-tier grandTotal as a
  // single summary line (not the internal cost-basis rows), and honor the saved
  // numeric deposit. subtotal+tax must still foot to the grandTotal.
  EST.priceMode = 'per-sq'; EST.prices = { good: 20000, better: 21500, best: 24000 };
  EST.grandTotal = 21500; EST.selectedTier = 'better'; EST.taxRate = 0.075; EST.deposit = 10750;
  await IP.createInvoiceFromEstimate('est1');
  ok('per-SQ invoice total = locked grandTotal (21500, not the $500 rows sum)', near(captured.total, 21500));
  // Five tiers (2026-10-02): the line names the CUSTOMER tier (better →
  // "Preferred"), never the raw internal key ("Better").
  ok('per-SQ invoice is a single summary line naming the tier', captured.items.length === 1 && /Preferred tier/.test(captured.items[0].description) && !/Better/.test(captured.items[0].description));
  ok('per-SQ invoice subtotal+tax foots to grandTotal (21500)', near(captured.subtotal + captured.tax, 21500));
  ok('per-SQ invoice: the rule\'s 50% of the locked $21,500 (10750)', near(captured.depositAmount, 10750));

  // 2026-07-18 post-sprint certification: V2 (estimate-v2-ui.js) persists the
  // estimate's tax under the key `tax`, never `taxAmount` — only the CLASSIC
  // builder writes `taxAmount`. Reading only est.taxAmount made every V2
  // line-item/insurance doc read NaN there and fall through to
  // `total - subtotal`. For a real (non-insurance) rate that's still correct
  // tax; for insurance (taxRate 0, true tax exactly $0) it instead measured
  // pure nearest-$25 ROUNDING NOISE — negative half the time (round-down),
  // a fabricated positive "tax" on a tax-exempt invoice the other half
  // (round-up). Fix: read est.taxAmount ?? est.tax.
  delete EST.priceMode; delete EST.prices; delete EST.selectedTier; delete EST.deposit;
  EST.taxRate = 0; EST.taxAmount = undefined;

  // Round-DOWN case: unrounded subtotal 10012.50 → grandTotal rounds to 10000.
  // Old fallback: tax = 10000 - 10012.50 = -12.50 (negative → Stripe 400s).
  EST.subtotal = 10012.5; EST.grandTotal = 10000; EST.tax = 0;
  await IP.createInvoiceFromEstimate('est1');
  ok('V2 insurance (round-DOWN): reads est.tax (0), not a negative rounding-noise fallback',
    captured.tax === 0);
  ok('V2 insurance (round-DOWN): total stays the locked/rounded grandTotal (10000)',
    near(captured.total, 10000));

  // Round-UP case: unrounded subtotal 9990 → grandTotal rounds to 10000.
  // Old fallback: tax = 10000 - 9990 = +10 (a fabricated tax line on a
  // tax-exempt insurance invoice).
  EST.subtotal = 9990; EST.grandTotal = 10000; EST.tax = 0;
  await IP.createInvoiceFromEstimate('est1');
  ok('V2 insurance (round-UP): reads est.tax (0), not a fabricated positive tax',
    captured.tax === 0);

  // Classic path unaffected: taxAmount present must still win over tax, even
  // when both are set to different values (?? short-circuits on the first
  // non-null/undefined operand — taxAmount, not tax).
  EST.taxAmount = 37.5; EST.tax = 999;
  await IP.createInvoiceFromEstimate('est1');
  ok('classic taxAmount still wins over a coexisting tax field', near(captured.tax, 37.5));

  // An explicit taxAmount of 0 must be trusted, not treated as "missing" —
  // proves ?? (nullish) semantics, not || (which would wrongly skip a falsy 0).
  EST.taxAmount = 0; EST.tax = 999;
  await IP.createInvoiceFromEstimate('est1');
  ok('explicit taxAmount 0 is trusted, not overridden by a coexisting tax field', captured.tax === 0);

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error('estimate-profit test crashed:', e && (e.stack || e.message)); process.exit(1); });
