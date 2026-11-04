/**
 * tests/expenses-logic.test.js — Phase 1 expense subsystem pure logic.
 *
 * Exercises the money/aggregation/margin math in a vm sandbox over the browser
 * IIFEs, loading expense-config.js + profit-tracker.js + expenses.js into ONE
 * shared `window` (so expenses.js sees window.ExpenseConfig / window.ProfitTracker
 * exactly as it does in the dashboard). Zero deps.
 *
 * Run: node tests/expenses-logic.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

function makeWin() {
  const win = { addEventListener() {}, removeEventListener() {}, confirm() { return true; }, open() {}, location: { pathname: '/pro/dashboard' } };
  win.window = win;
  return win;
}
function loadInto(win, file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', file), 'utf8');
  const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {}, focus() {} });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return noop(); }, body: noop(), readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(src, sandbox, { filename: file });
  return win;
}

const win = makeWin();
loadInto(win, 'expense-config.js');
loadInto(win, 'profit-tracker.js');
loadInto(win, 'expenses.js');

const EC = win.ExpenseConfig;
const EX = win.Expenses;
const PT = win.ProfitTracker;

// ── ExpenseConfig ────────────────────────────────────────────
console.log('EXPENSE CONFIG — categories + money helpers');
ok('ExpenseConfig exported', !!EC);
eq('materials is direct', EC.costTypeFor('materials'), 'direct');
eq('subcontractor is direct', EC.costTypeFor('subcontractor'), 'direct');
eq('insurance is overhead', EC.costTypeFor('insurance'), 'overhead');
eq('unknown category -> overhead (never silent job cost)', EC.costTypeFor('bogus'), 'overhead');
ok('isDirect(materials)', EC.isDirect('materials') === true);
ok('isDirect(marketing) false', EC.isDirect('marketing') === false);
eq('labelFor materials', EC.labelFor('materials'), 'Materials');
eq('dollarsToCents 12.34', EC.dollarsToCents('12.34'), 1234);
eq('dollarsToCents rounds 0.005', EC.dollarsToCents('0.005'), 1);
eq('dollarsToCents empty -> 0', EC.dollarsToCents(''), 0);
eq('dollarsToCents junk -> 0', EC.dollarsToCents('abc'), 0);
eq('dollarsToCents number 10 -> 1000', EC.dollarsToCents(10), 1000);
eq('centsToDollars 1234', EC.centsToDollars(1234), 12.34);
eq('formatCents 123456', EC.formatCents(123456), '$1,234.56');
eq('getJobRevenue from jobValue string', EC.getJobRevenue({ jobValue: '5000' }), 5000);
eq('getJobRevenue missing -> 0', EC.getJobRevenue({}), 0);
eq('REVENUE_FIELD is jobValue', EC.REVENUE_FIELD, 'jobValue');

// ── Expenses.aggregate ───────────────────────────────────────
console.log('EXPENSES — aggregate (supplier / category / job / cost-type)');
ok('Expenses exported', !!EX);
const list = [
  { amountCents: 10000, category: 'materials', costType: 'direct', supplier: 'ABC Supply', leadId: 'L1' },
  { amountCents: 5000, category: 'materials', costType: 'direct', supplier: 'ABC Supply', leadId: 'L1' },
  { amountCents: 3000, category: 'subcontractor', costType: 'direct', supplier: 'Crew Co', leadId: 'L1' },
  { amountCents: 2000, category: 'marketing', costType: 'overhead', supplier: 'Google', leadId: null },
  { amountCents: 1000, category: 'insurance', supplier: 'StateFarm' } // no costType -> fallback overhead
];
const agg = EX.aggregate(list);
eq('total cents', agg.totalCents, 21000);
eq('direct cents (10000+5000+3000)', agg.directCents, 18000);
eq('overhead cents (2000+1000 via fallback)', agg.overheadCents, 3000);
eq('supplier count', agg.supplierCount, 4);
eq('top supplier is ABC Supply', agg.suppliers[0].supplier, 'ABC Supply');
eq('top supplier total', agg.suppliers[0].cents, 15000);
ok('top supplier pct ~71.4%', Math.abs(agg.suppliers[0].pct - (15000 / 21000 * 100)) < 0.01);
eq('top category is materials', agg.categories[0].category, 'materials');
eq('job L1 total', agg.byJob['L1'].cents, 18000);
eq('job L1 direct', agg.byJob['L1'].directCents, 18000);
eq('job L1 count', agg.byJob['L1'].count, 3);
eq('unassigned bucket total', agg.byJob['__unassigned__'].cents, 3000);
const aggEmpty = EX.aggregate([]);
eq('empty total', aggEmpty.totalCents, 0);
eq('empty supplier count', aggEmpty.supplierCount, 0);

// tax-included totals + supplier normVendor collapse (product decision 2026-07-08)
console.log('EXPENSES — aggregate tax-included + supplier normVendor');
const aggTax = EX.aggregate([
  { amountCents: 10000, taxCents: 800, category: 'materials', costType: 'direct', supplier: 'ABC Supply', leadId: 'L1' },
  { amountCents: 5000, taxCents: 400, category: 'materials', costType: 'direct', supplier: 'abc supply ', leadId: 'L1' }, // spelling variant
]);
eq('total = amount + tax (16,200)', aggTax.totalCents, 16200);
eq('direct = amount + tax (16,200)', aggTax.directCents, 16200);
eq('two spellings collapse to ONE supplier', aggTax.supplierCount, 1);
eq('supplier label = first-seen raw name', aggTax.suppliers[0].supplier, 'ABC Supply');
eq('supplier total includes tax', aggTax.suppliers[0].cents, 16200);
eq('job L1 total includes tax', aggTax.byJob['L1'].cents, 16200);

// ── Lead Spend rollup (2026-09-20) ────────────────────────────
console.log('EXPENSES — leadSpendSummary (per-lead cost + marketing ledger)');
win._leads = [
  { id: 'L1', source: 'Thumbtack', leadCost: '51.96', deleted: false },
  { id: 'L2', source: 'Thumbtack', leadCost: 20.78, deleted: false },
  { id: 'L3', source: 'Yelp', leadCost: 15, deleted: false },
  { id: 'L4', source: 'Referral', leadCost: 0, deleted: false },     // 0 excluded — not a real spend
  { id: 'L5', source: 'Thumbtack', deleted: false },                 // no leadCost at all
  { id: 'L6', source: 'Thumbtack', leadCost: 99, deleted: true },    // soft-deleted — excluded
  { id: 'L7', source: 'Door Knock', leadCost: 40, isProspect: true },// prospect — excluded
];
EX._setData([
  { category: 'marketing', amountCents: 20000, taxCents: 0 },
  { category: 'marketing', amountCents: 5000, taxCents: 400 },
  { category: 'materials', amountCents: 999999 }, // not marketing — must not leak in
]);
const lsAgg = EX.leadSpendSummary();
eq('leadCents sums only real per-lead costs (51.96+20.78+15 = 87.74)', lsAgg.leadCents, 8774);
eq('leadCount excludes 0 / missing / deleted / prospect', lsAgg.leadCount, 3);
eq('marketingCents = expenses category=marketing incl. tax (200+50+4=254)', lsAgg.marketingCents, 25400);
eq('sourceRows top is Thumbtack (5196+2078=7274)', lsAgg.sourceRows[0].source, 'Thumbtack');
eq('sourceRows Thumbtack total', lsAgg.sourceRows[0].cents, 7274);
eq('sourceRows Yelp total', lsAgg.sourceRows.find(r => r.source === 'Yelp').cents, 1500);
win._leads = [];
EX._setData([]);
const lsEmpty = EX.leadSpendSummary();
eq('empty: leadCents 0', lsEmpty.leadCents, 0);
eq('empty: marketingCents 0', lsEmpty.marketingCents, 0);
eq('empty: sourceRows []', lsEmpty.sourceRows.length, 0);

// ── ProfitTracker.computeJobPLWithExpenses ───────────────────
console.log('PROFIT TRACKER — computeJobPLWithExpenses (feed margin from ledger)');
ok('computeJobPLWithExpenses exported', typeof PT.computeJobPLWithExpenses === 'function');
const lead = { jobValue: '20000', overheadPct: 10 };
const exp = [
  { amountCents: 1000000, category: 'materials', costType: 'direct' },    // $10,000
  { amountCents: 300000, category: 'direct_labor', costType: 'direct' },  // $3,000
  { amountCents: 200000, category: 'subcontractor', costType: 'direct' }, // $2,000 -> misc
  { amountCents: 50000, category: 'marketing', costType: 'overhead' }     // ignored (not COGS)
];
const pl = PT.computeJobPLWithExpenses(lead, exp);
eq('materialCost from ledger', pl.materialCost, 10000);
eq('laborCost from ledger', pl.laborCost, 3000);
eq('miscCosts = other direct (subcontractor)', pl.miscCosts, 2000);
eq('revenue', pl.revenue, 20000);
eq('grossProfit = 20000-10000-3000-2000', pl.grossProfit, 5000);
eq('grossMargin 25%', pl.grossMargin, 25);
eq('overhead excluded from grossProfit (overhead=2000)', pl.overhead, 2000);
eq('netProfit = 20000-17000', pl.netProfit, 3000);
ok('overhead-type expense did NOT inflate COGS', pl.materialCost + pl.laborCost + pl.miscCosts === 15000);
// COGS = tax-included total (product decision 2026-07-08)
const plTax = PT.computeJobPLWithExpenses({ jobValue: '20000' }, [
  { amountCents: 1000000, taxCents: 80000, category: 'materials', costType: 'direct' },
]);
eq('materialCost includes tax ($10,800)', plTax.materialCost, 10800);
eq('grossProfit reflects tax-included COGS (20000-10800)', plTax.grossProfit, 9200);

// ── Expenses.jobMargin guards ────────────────────────────────
console.log('EXPENSES — jobMargin guards');
const jm = EX.jobMargin({ jobValue: 20000 }, exp);
eq('jobMargin grossMargin matches', jm.grossMargin, 25);
ok('jobMargin null when revenue 0', EX.jobMargin({ jobValue: 0 }, exp) === null);
ok('jobMargin null when no lead', EX.jobMargin(null, exp) === null);

// ── Follow-up: estVsActual (estimated-vs-actual variance) ────
console.log('EXPENSES — estVsActual (variance)');
EX._setEstCosts({ L1: 1000000 }); // $10,000 budgeted direct cost (V2 estimate)
const vaOver = EX.estVsActual('L1', 1200000); // actual $12,000
eq('estVsActual est cents', vaOver.estCents, 1000000);
eq('estVsActual actual cents', vaOver.actualCents, 1200000);
eq('estVsActual variance = actual-est (over)', vaOver.varianceCents, 200000);
const vaUnder = EX.estVsActual('L1', 800000); // actual $8,000
eq('estVsActual variance under is negative', vaUnder.varianceCents, -200000);
ok('estVsActual null when no estimate cost basis', EX.estVsActual('L2', 5000) === null);
EX._setEstCosts({});
ok('estVsActual null after clearing', EX.estVsActual('L1', 5000) === null);

// ── Follow-up: findDuplicate ─────────────────────────────────
console.log('EXPENSES — findDuplicate');
EX._setData([{ id: 'e1', supplier: 'ABC Supply', amountCents: 5000, date: new Date('2026-06-27T00:00:00') }]);
ok('finds exact dup (vendor+amount+day)', !!EX.findDuplicate('ABC Supply', 5000, '2026-06-27'));
ok('case-insensitive vendor match', !!EX.findDuplicate('abc supply', 5000, '2026-06-27'));
ok('no dup when amount differs', EX.findDuplicate('ABC Supply', 5001, '2026-06-27') === null);
ok('no dup when day differs', EX.findDuplicate('ABC Supply', 5000, '2026-06-28') === null);
ok('no dup when vendor differs', EX.findDuplicate('Beacon', 5000, '2026-06-27') === null);
EX._setData([]);

// ── Follow-up: csvCell (CSV escaping) ────────────────────────
console.log('EXPENSES — csvCell');
eq('plain value unquoted', EX.csvCell('plain'), 'plain');
eq('comma gets quoted', EX.csvCell('a,b'), '"a,b"');
eq('quotes are doubled + wrapped', EX.csvCell('he said "hi"'), '"he said ""hi"""');
eq('newline gets quoted', EX.csvCell('line1\nline2'), '"line1\nline2"');
eq('null -> empty', EX.csvCell(null), '');

// ── Follow-up #1: analytics-kpi expense metrics (vm sandbox) ─────
console.log('ANALYTICS-KPI — expense metrics (COGS / margin / supplier)');
const awin = makeWin();
loadInto(awin, 'analytics-kpi.js');
const AK = awin.AnalyticsKPI && awin.AnalyticsKPI._test;
ok('AnalyticsKPI._test.computeFullAnalytics exported', !!(AK && AK.computeFullAnalytics));
if (AK && AK.computeFullAnalytics) {
  const data = {
    leads: [
      { id: 'L1', _stageKey: 'closed', jobValue: 20000 },   // won, costed
      { id: 'L2', _stageKey: 'closed', jobValue: 10000 },   // won, NOT costed
    ],
    invoices: [], knocks: [], photos: [], estimates: [],
    expenses: [
      { amountCents: 500000, costType: 'direct', supplier: 'ABC Supply', leadId: 'L1', date: new Date() },
      { amountCents: 100000, costType: 'overhead', supplier: 'Google', leadId: null, date: new Date() },
    ],
  };
  const M = AK.computeFullAnalytics(data);
  eq('total COGS (direct only) dollars', M.expDirectDollars, 5000);
  eq('overhead dollars', M.expOverheadDollars, 1000);
  eq('total spend dollars', M.expTotalDollars, 6000);
  // gross margin: only L1 is costed → (20000-5000)/20000 = 75%
  eq('won-job gross margin uses jobValue basis, costed jobs only', M.expGrossMargin, 75);
  eq('costed-jobs count', M.expCostedJobs, 1);
  eq('won-jobs count', M.expWonJobs, 2);
  eq('top supplier in leaderboard', M.expSupplierLeaderboard[0].supplier, 'ABC Supply');
  eq('this-month spend includes both (dated now)', M.expMonthDollars, 6000);
}

// ── A1: mileage helpers ──────────────────────────────────────
console.log('EXPENSE CONFIG — mileage');
eq('mileage category is overhead', EC.costTypeFor('mileage'), 'overhead');
eq('2026 IRS rate', EC.mileageRateCents(2026), 72.5);
eq('2025 IRS rate', EC.mileageRateCents(2025), 70.0);
eq('pre-table year clamps to earliest (not latest)', EC.mileageRateCents(1999), 65.5);
eq('rate from a Date', EC.mileageRateCents(new Date('2025-03-01T00:00:00')), 70.0);
eq('10 mi x 72.5c = 725c ($7.25)', EC.mileageAmountCents(10, 72.5), 725);
eq('100 mi x 70c = 7000c', EC.mileageAmountCents(100, 70), 7000);
eq('half-cent rounds (33.3 x 72.5)', EC.mileageAmountCents(33.3, 72.5), Math.round(33.3 * 72.5));
eq('0 miles -> 0', EC.mileageAmountCents(0, 72.5), 0);
eq('negative miles -> 0', EC.mileageAmountCents(-5, 72.5), 0);
eq('bad rate falls back to latest-year rate', EC.mileageAmountCents(10, 'x'), 725);

// ── A2: HEIC magic-byte detection (receipt-vision) ───────────
console.log('RECEIPT-VISION — isHeicBytes');
const rv = require(path.join(__dirname, '..', 'functions', 'receipt-vision.js'))._test;
ok('isHeicBytes exported', typeof rv.isHeicBytes === 'function');
function ftyp(brand) { const b = Buffer.alloc(16); b.write('ftyp', 4); b.write(brand, 8); return b; }
ok('detects heic brand', rv.isHeicBytes(ftyp('heic')) === true);
ok('detects mif1 brand', rv.isHeicBytes(ftyp('mif1')) === true);
ok('rejects a jpeg-ish buffer', rv.isHeicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === false);
ok('rejects short buffer', rv.isHeicBytes(Buffer.alloc(4)) === false);
ok('rejects null', rv.isHeicBytes(null) === false);

// ── A1b: advanceDate (recurring cadence) ─────────────────────
console.log('EXPENSES — advanceDate');
function ymd(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
const baseD = new Date(2026, 0, 15); // Jan 15 2026 (local)
eq('monthly +1mo', ymd(EX.advanceDate(baseD, 'monthly')), '2026-2-15');
eq('weekly +7d', ymd(EX.advanceDate(baseD, 'weekly')), '2026-1-22');
eq('biweekly +14d', ymd(EX.advanceDate(baseD, 'biweekly')), '2026-1-29');
eq('quarterly +3mo', ymd(EX.advanceDate(baseD, 'quarterly')), '2026-4-15');
eq('annual +1yr', ymd(EX.advanceDate(baseD, 'annual')), '2027-1-15');

// ── A5: supplier YTD + 1099 eligibility ──────────────────────
console.log('EXPENSES — supplier 1099 logic');
const supExp = [
  { supplier: 'Crew Co', category: 'subcontractor', amountCents: 150000, date: new Date(2026, 1, 1) },
  { supplier: 'Crew Co', category: 'subcontractor', amountCents: 100000, date: new Date(2026, 5, 1) },
  { supplier: 'Crew Co', category: 'materials', amountCents: 999999, date: new Date(2026, 5, 1) }, // materials don't count toward 1099
  { supplier: 'crew co', category: 'direct_labor', amountCents: 50000, date: new Date(2025, 5, 1) }, // wrong year
];
eq('YTD 2026 services (subcontractor sum)', EX.supplierYtdCents('Crew Co', 2026, supExp), 250000);
eq('YTD case-insensitive, excludes materials + other years', EX.supplierYtdCents('CREW CO', 2026, supExp), 250000);
eq('YTD unknown supplier -> 0', EX.supplierYtdCents('Nobody', 2026, supExp), 0);
ok('individual is 1099-eligible', EX.is1099EligibleFromClass('individual') === true);
ok('c_corp NOT eligible', EX.is1099EligibleFromClass('c_corp') === false);
ok('attorney eligible (corp exception)', EX.is1099EligibleFromClass('attorney') === true);
ok('materials_only NOT eligible', EX.is1099EligibleFromClass('materials_only') === false);
ok('needs1099 TRUE (eligible + W-9 + YTD>=$2000 2026 threshold)',
  EX.needs1099({ displayName: 'Crew Co', taxClassification: 'individual', w9Status: 'received' }, 2026, supExp) === true);
ok('needs1099 FALSE below 2026 $2000 threshold',
  EX.needs1099({ displayName: 'X', taxClassification: 'individual', w9Status: 'verified' }, 2026,
    [{ supplier: 'X', category: 'subcontractor', amountCents: 100000, date: new Date(2026, 1, 1) }]) === false);
ok('needs1099 FALSE for a corporation', EX.needs1099({ displayName: 'Crew Co', taxClassification: 'c_corp', w9Status: 'verified' }, 2026, supExp) === false);
ok('needs1099 FALSE without a W-9 on file', EX.needs1099({ displayName: 'Crew Co', taxClassification: 'individual', w9Status: 'requested' }, 2026, supExp) === false);

// ── A4: budget status thresholds ─────────────────────────────
console.log('EXPENSE CONFIG — budgetStatus');
eq('breach when margin < 30% floor', EC.budgetStatus(10000, 8000), 'breach');
eq('warn when direct cost 65-99% (margin still ok)', EC.budgetStatus(10000, 6800), 'warn');
ok('null when healthy (cost 50%)', EC.budgetStatus(10000, 5000) === null);
ok('null when no revenue', EC.budgetStatus(0, 5000) === null);
// tenant overrides via companyProfile.budgetDefaults (optional 3rd arg)
eq('tenant warn threshold lowers the amber trigger (50% warn)',
  EC.budgetStatus(10000, 5500, { directCostPctWarn: 50, marginFloorPct: 30 }), 'warn');
eq('tenant margin floor raises the red trigger (45% floor -> breach at 40% margin)',
  EC.budgetStatus(10000, 6000, { directCostPctWarn: 65, marginFloorPct: 45 }), 'breach');
ok('tenant thresholds can relax the default (cost 68% healthy at warn=80)',
  EC.budgetStatus(10000, 6800, { directCostPctWarn: 80, marginFloorPct: 15 }) === null);
eq('invalid override values fall back per-field (warn="abc", floor=0)',
  EC.budgetStatus(10000, 6800, { directCostPctWarn: 'abc', marginFloorPct: 0 }), 'warn');
eq('out-of-range overrides fall back (warn=150 -> default 65 still warns)',
  EC.budgetStatus(10000, 6800, { directCostPctWarn: 150, marginFloorPct: -5 }), 'warn');
eq('null thresholds arg behaves as defaults', EC.budgetStatus(10000, 8000, null), 'breach');
eq('cost >= 100% is always a breach regardless of overrides',
  EC.budgetStatus(10000, 11000, { directCostPctWarn: 99, marginFloorPct: 1 }), 'breach');

// ── QA fixes: vendor normalization, mileage clamp, month-end dates ──
console.log('QA FIXES — normVendor / mileage clamp / advanceDate clamp');
eq('normVendor strips suffix+punct (ABC Supply, LLC)', EC.normVendor('ABC Supply, LLC'), 'abc supply');
eq('normVendor matches the variant (abc  supply co.)', EC.normVendor('abc  supply co.'), 'abc supply');
eq('normVendor leaves Costco intact (co not a word)', EC.normVendor('Costco'), 'costco');
eq('mileage clamps a pre-table year to earliest (not latest)', EC.mileageRateCents(2019), 65.5);
eq('mileage clamps a future year to latest', EC.mileageRateCents(2099), 72.5);
eq('mileage in-table year unaffected', EC.mileageRateCents(2025), 70.0);
// month-end clamp: Jan 31 + 1 month -> Feb 28 (2026 non-leap), not a skip to Mar
eq('advanceDate Jan31 +monthly -> Feb 28 (clamped)', ymd(EX.advanceDate(new Date(2026, 0, 31), 'monthly')), '2026-2-28');
eq('advanceDate Jan31 +quarterly -> Apr 30 (clamped)', ymd(EX.advanceDate(new Date(2026, 0, 31), 'quarterly')), '2026-4-30');
eq('advanceDate Feb29 (2028 leap) +annual -> Feb 28 2029', ymd(EX.advanceDate(new Date(2028, 1, 29), 'annual')), '2029-2-28');

// ── cost panel: "costs not set" is not a 100% margin (2026-09-29) ──
console.log('\nPROFIT PANEL — no invented margin, reconcilable labels, escaped notes');
{
  const panel = { innerHTML: '' };
  const pwin = makeWin();
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', 'profit-tracker.js'), 'utf8');
  vm.runInNewContext(src, {
    window: pwin,
    document: { addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'pp' ? panel : null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return { style: {} }; }, body: {}, readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON,
  }, { filename: 'profit-tracker.js' });
  const render = (lead, exps) => { pwin._leads = [lead]; pwin.ProfitTracker.renderCostPanel('pp', lead.id, exps); return panel.innerHTML; };
  const blank = render({ id: 'L1', jobValue: 9800, costNotes: '<img src=x onerror=alert(1)>' });
  ok('no costs entered: no "% margin" badge', !/\d+% margin/.test(blank));
  ok('no costs entered: no GROSS PROFIT figure', !/GROSS PROFIT/.test(blank));
  ok('no costs entered: says costs are not set', /Costs not set/.test(blank));
  ok('cost notes are escaped (no raw <img>)', !/<img/.test(blank) && /&lt;img/.test(blank));
  const costed = render({ id: 'L2', jobValue: 10000, materialCost: 3000, laborCost: 2000, overheadPct: 10 });
  ok('with costs: margin badge shows 50%', /50% margin/.test(costed));
  ok('with costs: gross profit is labelled "before overhead"', /GROSS PROFIT <span[^>]*>\(before overhead\)/.test(costed));
  ok('with costs: total cost is labelled with its overhead %', /TOTAL COST <span[^>]*>\(incl\. 10% overhead\)/.test(costed));
  const fed = render({ id: 'L3', jobValue: 10000 }, [{ amountCents: 400000, taxCents: 0, category: 'materials', costType: 'direct' }]);
  ok('logged expenses count as costs set (60% margin)', /60% margin/.test(fed));
}

// ── attach a receipt to an existing expense (2026-09-29) ────────
console.log('\nATTACH RECEIPT — photo or PDF onto an expense that has none');
(async () => {
  const uploads = [], updates = [];
  win._user = { uid: 'u1' };
  win.storage = {}; win.db = {};
  win.ref = (s, p) => ({ p });
  win.uploadBytes = async (r, body, meta) => { uploads.push({ path: r.p, type: meta.contentType }); };
  win.doc = (db, col, id) => ({ col, id });
  win.updateDoc = async (ref, data) => { updates.push({ ref, data }); };
  win.serverTimestamp = () => 'ts';
  win.showToast = () => {};
  EX._setData([{ id: 'e1', supplier: 'Home Depot', amountCents: 100, taxCents: 0, category: 'materials' }]);
  const pdf = { name: 'hd receipt.pdf', type: 'application/pdf', size: 1000 };
  const ok1 = await EX.saveAttachedReceipt('e1', pdf);
  ok('a PDF uploads under receipts/{uid}/ and is linked on the expense',
    ok1 === true && uploads.length === 1 && /^receipts\/u1\/\d+_hd_receipt\.pdf$/.test(uploads[0].path)
    && updates.length === 1 && updates[0].ref.id === 'e1' && updates[0].data.receiptStoragePath === uploads[0].path);
  const bad = await EX.saveAttachedReceipt('e1', { name: 'x.exe', type: 'application/x-msdownload', size: 10 });
  ok('a non-image/non-PDF is refused (no upload, no update)', bad === false && uploads.length === 1 && updates.length === 1);
  const big = await EX.saveAttachedReceipt('e1', { name: 'huge.pdf', type: 'application/pdf', size: 26 * 1024 * 1024 });
  ok('a file over 25MB is refused', big === false && uploads.length === 1);
  win.updateDoc = async () => { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; };
  const denied = await EX.saveAttachedReceipt('e1', pdf);
  ok('someone else\'s expense: refused cleanly (false, no throw)', denied === false);

  // ══ flag costsPaidFrom (2026-11-03): paidFrom, receiptUrl, null margin, CSV import ══
  const FLAG = 'costsPaidFrom';
  const setFlag = (on) => { win.NBDFlags = { enabled: (n) => !!on && n === FLAG }; };
  const writes = [];
  win.collection = (db, name) => ({ name });
  win.addDoc = async (colRef, data) => { writes.push({ col: colRef.name, data }); return { id: 'new' + writes.length }; };
  win._userClaims = { companyId: 'co1' };

  console.log('\nPAID FROM — expense-config helpers');
  eq('paidFromKey accepts the key', EC.paidFromKey('business_credit_card'), 'business_credit_card');
  eq('paidFromKey accepts the label', EC.paidFromKey('Business debit card'), 'business_debit_card');
  eq('paidFromKey accepts ATM in any case', EC.paidFromKey(' atm '), 'atm');
  eq('paidFromKey rejects venmo', EC.paidFromKey('venmo'), '');
  eq('paidFromKey rejects empty', EC.paidFromKey(''), '');
  eq('seven paidFrom options', EC.PAID_FROM.length, 7);
  ok('receiptUrlOk: https drive link', EC.receiptUrlOk('https://drive.google.com/file/d/sample/view') === true);
  ok('receiptUrlOk: empty is fine (optional)', EC.receiptUrlOk('') === true);
  ok('receiptUrlOk: http refused', EC.receiptUrlOk('http://drive.google.com/x') === false);
  ok('receiptUrlOk: javascript: refused', EC.receiptUrlOk('javascript:alert(1)') === false);
  ok('receiptUrlOk: 501 chars refused', EC.receiptUrlOk('https://e.test/' + 'a'.repeat(486)) === false);
  ok('receiptUrlOk: spaces refused', EC.receiptUrlOk('https://e.test/a b') === false);

  console.log('\nPAID FROM — createExpense, flag OFF (ship dark)');
  setFlag(false);
  writes.length = 0;
  const offOk = await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', leadId: 'L1' });
  ok('flag off: a cost with no paidFrom still saves', offOk === true && writes.length === 1);
  ok('flag off: no paidFrom / receiptUrl keys are written', !('paidFrom' in writes[0].data) && !('receiptUrl' in writes[0].data));
  writes.length = 0;
  await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', paidFrom: 'cash', receiptUrl: 'https://e.test/r' });
  ok('flag off: a paidFrom passed in is ignored (old behaviour)', !('paidFrom' in writes[0].data));

  console.log('\nPAID FROM — createExpense, flag ON');
  setFlag(true);
  writes.length = 0;
  const noPaid = await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials' });
  ok('flag on: paidFrom is REQUIRED (no write without it)', noPaid === false && writes.length === 0);
  const badPaid = await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', paidFrom: 'venmo' });
  ok('flag on: unknown paidFrom refused', badPaid === false && writes.length === 0);
  const badUrl = await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', paidFrom: 'cash', receiptUrl: 'http://x.test/r' });
  ok('flag on: non-https receiptUrl refused', badUrl === false && writes.length === 0);
  const good = await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', paidFrom: 'Personal card', receiptUrl: ' https://drive.google.com/file/d/sample/view ' });
  ok('flag on: valid cost saves with the paidFrom KEY and trimmed receiptUrl',
    good === true && writes.length === 1 && writes[0].data.paidFrom === 'personal_card' && writes[0].data.receiptUrl === 'https://drive.google.com/file/d/sample/view');
  writes.length = 0;
  await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', paidFrom: 'cash' });
  ok('flag on: no receiptUrl key when none given', writes[0].data.paidFrom === 'cash' && !('receiptUrl' in writes[0].data));
  writes.length = 0;
  await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', paidFrom: 'cash', source: 'import' });
  ok("source 'import' is kept (not collapsed to manual)", writes[0].data.source === 'import');
  writes.length = 0;
  await EX.createExpense({ amount: '10.00', date: '2026-11-01', supplier: 'Sample Supply', category: 'materials', paidFrom: 'cash', source: 'something_else' });
  ok('an unknown source still falls back to manual', writes[0].data.source === 'manual');

  console.log('\nMARGIN — a job with no direct costs is "no costs entered", not ~100%');
  const jobLead = { id: 'L9', jobValue: 10000, overheadPct: 10 };
  setFlag(true);
  const none = PT.computeJobPLWithExpenses(jobLead, []);
  ok('flag on: zero expenses -> grossMargin null', none.grossMargin === null);
  ok('flag on: zero expenses -> netMargin / profits null', none.netMargin === null && none.grossProfit === null && none.netProfit === null);
  ok('flag on: zero expenses -> noCosts + label', none.noCosts === true && none.marginLabel === 'no costs entered');
  const overheadOnly = PT.computeJobPLWithExpenses(jobLead, [{ amountCents: 5000, taxCents: 0, category: 'marketing', costType: 'overhead' }]);
  ok('flag on: only overhead-type expenses still means no direct costs', overheadOnly.noCosts === true && overheadOnly.grossMargin === null);
  const voided = PT.computeJobPLWithExpenses(jobLead, [{ amountCents: 400000, category: 'materials', costType: 'direct', deleted: true }]);
  ok('flag on: only a voided cost -> no costs entered', voided.noCosts === true);
  const costedPl = PT.computeJobPLWithExpenses(jobLead, [{ amountCents: 400000, taxCents: 0, category: 'materials', costType: 'direct' }]);
  ok('flag on: a costed job keeps its real margin (60%)', costedPl.grossMargin === 60 && !costedPl.noCosts);
  const noRev = PT.computeJobPLWithExpenses({ id: 'L0', jobValue: 0 }, []);
  ok('flag on: a job with no revenue is unchanged (0%, not "no costs")', noRev.grossMargin === 0 && !noRev.noCosts);
  const manualNone = PT.computeJobPL({ jobValue: 10000 });
  ok('flag on: computeJobPL on manual fields with no costs -> null margin', manualNone.grossMargin === null && manualNone.noCosts === true);
  setFlag(false);
  const offNone = PT.computeJobPLWithExpenses(jobLead, []);
  ok('flag OFF: zero costs keeps the old 100% gross margin (ship dark)', offNone.grossMargin === 100 && !('noCosts' in offNone));
  ok('flag OFF: 90% net margin as before', offNone.netMargin === 90);
  const offJob = EX.jobMargin(jobLead, []);
  ok('flag OFF: Expenses.jobMargin unchanged', offJob.grossMargin === 100);
  setFlag(true);
  ok('flag on: Expenses.jobMargin surfaces noCosts', EX.jobMargin(jobLead, []).noCosts === true);

  console.log('\nCSV IMPORT — parse + preview (fake sample data only)');
  const leads = [
    { id: 'lead-001', name: 'Sample Homeowner' },
    { id: 'lead-002', firstName: 'Pat', lastName: 'Example' },
    { id: 'lead-003', name: 'Twin Name' },
    { id: 'lead-004', name: 'Twin Name' },
    { id: 'lead-005', name: 'Removed Person', deleted: true }
  ];
  const p1 = EX.parseCsv('job,vendor,note\r\n"Smith, Jr",ABC "Supply",x\r\n\r\nb,c,"multi\nline"\r\n');
  ok('parseCsv: quotes, doubled quotes, commas in cells, blank lines', p1.length === 3 && p1[1][0] === 'Smith, Jr' && p1[1][1] === 'ABC "Supply"');
  ok('parseCsv: newline inside quotes stays in the cell', p1[2][2] === 'multi\nline');
  ok('parseCsv: BOM stripped', EX.parseCsv('﻿a,b\n1,2')[0][0] === 'a');

  const HEAD = 'job,vendor,date,amount,category,paidFrom,receiptUrl,note\n';
  const csv = HEAD + [
    'lead-001,Sample Supply,2026-10-30,"$1,234.50",Materials,business_credit_card,https://drive.google.com/file/d/sample/view,shingles',
    'Pat Example,Sample Dumpsters,10/31/2026,300,equipment_dumpster,Cash,,',
    'Nobody Real,Sample Supply,2026-10-30,10,materials,cash,,',
    'lead-001,Sample Supply,2026-10-30,10,widgets,cash,,',
    'lead-001,Sample Supply,2026-10-30,10,materials,bitcoin,,',
    'Twin Name,Sample Supply,2026-10-30,10,materials,cash,,',
    'lead-005,Sample Supply,2026-10-30,10,materials,cash,,',
    'lead-001,Sample Supply,2026-02-31,10,materials,cash,,',
    'lead-001,Sample Supply,2026-10-30,-5,materials,cash,,',
    'lead-001,Sample Supply,2026-10-30,10,materials,cash,http://insecure.test/r,',
    'lead-001,Sample Supply,2026-10-30,10,mileage,cash,,',
    'lead-001,Sample Supply,2026-10-30,1234.50,materials,business_credit_card,,again'
  ].join('\n');
  EX._setData([{ id: 'old1', supplier: 'Sample Supply', amountCents: 5000, taxCents: 0, category: 'materials', date: new Date(2026, 9, 29) }]);
  const pv = EX.buildImportPreview(csv, leads, EX.findDuplicate);
  ok('preview has no top-level error', !pv.error && pv.rows.length === 12);
  const st = (i) => pv.rows[i].status;
  const why = (i) => pv.rows[i].reasons.join(' | ');
  ok('row 1 (lead id, label category, $1,234.50) is ok', st(0) === 'ok' && pv.rows[0].cents === 123450 && pv.rows[0].draft.category === 'materials' && pv.rows[0].draft.leadId === 'lead-001');
  ok('row 2 (customer name, M/D/YYYY, label paidFrom) is ok', st(1) === 'ok' && pv.rows[1].draft.leadId === 'lead-002' && pv.rows[1].draft.date === '2026-10-31' && pv.rows[1].draft.paidFrom === 'cash');
  ok('unknown job is rejected with a clear message', st(2) === 'rejected' && /Unknown job "Nobody Real"/.test(why(2)));
  ok('unknown category is rejected with a clear message', st(3) === 'rejected' && /Unknown category "widgets"/.test(why(3)));
  ok('bad paidFrom is rejected and lists the allowed values', st(4) === 'rejected' && /Bad paidFrom "bitcoin"/.test(why(4)) && /business_credit_card/.test(why(4)));
  ok('a name shared by two customers is rejected (use the lead id)', st(5) === 'rejected' && /matches 2 customers/.test(why(5)));
  ok('a deleted job is not matched', st(6) === 'rejected' && /Unknown job/.test(why(6)));
  ok('an impossible date (Feb 31) is rejected', st(7) === 'rejected' && /Bad date/.test(why(7)));
  ok('a negative amount is rejected', st(8) === 'rejected' && /Bad amount/.test(why(8)));
  ok('a non-https receipt link is rejected', st(9) === 'rejected' && /https/.test(why(9)));
  ok('mileage rows are rejected (amount is computed from miles)', st(10) === 'rejected' && /Mileage/.test(why(10)));
  ok('same vendor/amount/day as an earlier row in the file is flagged duplicate', st(11) === 'duplicate' && /row 2 in this file/.test(why(11)));
  ok('a rejected row has no draft (cannot be written)', pv.rows[2].draft === null && pv.rows[3].draft === null);
  ok('every row carries its 1-based file line (header is line 1)', pv.rows[0].line === 2 && pv.rows[11].line === 13);

  const dupCsv = HEAD + 'lead-001,Sample Supply,2026-10-29,50.00,materials,cash,,\n';
  const dpv = EX.buildImportPreview(dupCsv, leads, EX.findDuplicate);
  ok('findDuplicate is run per row: matches the logged cost -> duplicate', dpv.rows[0].status === 'duplicate' && /already logged/.test(dpv.rows[0].reasons.join(' ')));
  ok('a duplicate keeps its draft so Jo can still approve it on purpose', !!dpv.rows[0].draft);

  const missing = EX.buildImportPreview('job,vendor,amount\nlead-001,x,5\n', leads, EX.findDuplicate);
  ok('missing required columns -> clear top-level error, no rows', /Missing column\(s\): date, category, paidFrom/.test(missing.error) && !missing.rows);
  const aliased = EX.buildImportPreview('Customer,Supplier,Date,Total,Category,Paid From,Receipt Link,Notes\nlead-001,Sample Supply,2026-10-30,5,materials,check,,n\n', leads, EX.findDuplicate);
  ok('header aliases (Customer, Supplier, Paid From, Receipt Link) are understood', aliased.rows && aliased.rows[0].status === 'ok' && aliased.rows[0].draft.paidFrom === 'check');
  ok('empty file -> error', !!EX.buildImportPreview('', leads, EX.findDuplicate).error);
  const many = HEAD + new Array(502).join('lead-001,V,2026-10-30,5,materials,cash,,\n');
  ok('over 500 rows -> refused with a message', /Too many rows/.test(EX.buildImportPreview(many, leads, EX.findDuplicate).error || ''));
  ok('formula-style cell is kept as plain text on import (csvCell guards the export)', EX.csvCell('=1+1') === "'=1+1");

  console.log('\nCSV IMPORT — approved rows go through createExpense, nothing else is written');
  setFlag(true);
  writes.length = 0;
  const okRows = pv.rows.filter((r) => r.status === 'ok');
  const results = [];
  for (const r of okRows) results.push(await EX.createExpense(Object.assign({}, r.draft, { source: 'import', quiet: true })));
  ok('approved rows write one /expenses doc each with source import', results.every(Boolean) && writes.length === 2 && writes.every((w) => w.col === 'expenses' && w.data.source === 'import'));
  ok('imported docs carry paidFrom key, job link and trimmed receipt link',
    writes[0].data.paidFrom === 'business_credit_card' && writes[0].data.leadId === 'lead-001' && writes[0].data.amountCents === 123450 && /^https:\/\//.test(writes[0].data.receiptUrl));
  ok('the preview itself never writes (only the 2 approved rows above did)', writes.length === 2);
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'docs/pro/js/expenses.js'), 'utf8');
  ok('no approve-all control exists in the import UI', !/imp-approve-all|approveAll/i.test(src));
  ok('import write loop only reads rows decided as approved', /_imp\.decision\[k\] === 'approved'/.test(src));
  ok('a rejected-by-checks row can never be approved (decideImport guard)', /r\.status === 'rejected'\) return/.test(src));
  ok('import entry points are gated by the flag', /function openImport\(\) \{\s*if \(!costsFlagOn\(\)\) return;/.test(src) && /async function writeImport\(\) \{\s*if \([^\n]*!costsFlagOn\(\)/.test(src));

  console.log('\nCSV EXPORT — Paid From + Receipt Link columns behind the flag');
  ok('export source adds the two columns only when the flag is on', /if \(paidCols\) cols\.push\('Paid From', 'Receipt Link'\)/.test(src) && /paidCols \? \[paidFromLabel\(e\.paidFrom\), e\.receiptUrl \|\| ''\] : \[\]/.test(src));
  finish();
})();
function finish() {
// ── summary ──────────────────────────────────────────────────
console.log('\n' + (failed === 0 ? '✓' : '✗') + ' expenses logic: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) { console.error('FAILED: ' + fails.join(', ')); process.exit(1); }
}
