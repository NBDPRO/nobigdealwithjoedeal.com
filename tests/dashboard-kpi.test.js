/**
 * tests/dashboard-kpi.test.js — Phase 9 dashboard KPI aggregation.
 *
 * Exercises analytics-kpi.js computeKPIs() in a vm sandbox over a controlled
 * window._leads set — the rollups the dashboard KPI row renders: pipeline value
 * (active only, deleted excluded), monthly revenue (WON this month), close rate,
 * avg deal size, leads this month, active count, and top lead source. Widget
 * RENDERING is browser-only (needs-browser).
 *
 * Zero deps. Run: node tests/dashboard-kpi.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

function loadIIFE(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', file), 'utf8');
  const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
  const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' } };
  win.window = win;
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return noop(); }, body: noop(), readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON, Object,
  };
  vm.runInNewContext(src, sandbox, { filename: file });
  return win;
}

const win = loadIIFE('analytics-kpi.js');
const now = new Date().toISOString();

// Controlled pipeline. WON stage key = 'closed'; LOST = 'lost'.
win._leads = [
  { id: 'a', stage: 'inspected', jobValue: 10000, source: 'referral', createdAt: now },                 // active
  { id: 'b', stage: 'quoted',    jobValue: 20000, source: 'referral', createdAt: now },                 // active
  { id: 'c', stage: 'closed',    jobValue: 30000, source: 'referral', createdAt: now, updatedAt: now }, // WON this month
  { id: 'd', stage: 'closed',    jobValue: 50000, source: 'google',   createdAt: now, updatedAt: now }, // WON this month
  { id: 'e', stage: 'lost',      jobValue: 5000,  source: 'website',  createdAt: now },                 // lost
  { id: 'f', stage: 'inspected', jobValue: 99999, source: 'referral', deleted: true },                 // deleted → excluded
];
win._estimates = [];

const k = win.computeKPIs();

console.log('DASHBOARD KPIs — computeKPIs aggregation');
ok('exposes computeKPIs', typeof win.computeKPIs === 'function');
// Globals Tranche 3 T3-C (2026-09-18): the Doors Verified card is registry-only.
// Running the real file proves the registration executes inside the IIFE that
// declares the function (a registry line in the wrong scope throws at load).
ok('registers renderDoorsVerifiedCard in __NBD_CALL_REGISTRY, not on window',
  !!win.__NBD_CALL_REGISTRY && typeof win.__NBD_CALL_REGISTRY.renderDoorsVerifiedCard === 'function'
    && !Object.prototype.hasOwnProperty.call(win, 'renderDoorsVerifiedCard'));
ok('pipelineValue = active leads only (10k+20k = 30000), deleted excluded', k.pipelineValue === 30000);
ok('monthlyRevenue = WON this month (30k+50k = 80000)', k.monthlyRevenue === 80000);
ok('closeRate = closed/(closed+lost) = 2/3 = 67%', k.closeRate === 67);
ok('avgDealSize = (30k+50k)/2 = 40000', k.avgDealSize === 40000);
ok('activeLeadCount = 2 (excludes WON/LOST/deleted)', k.activeLeadCount === 2);
ok('closedThisMonthCount = 2', k.closedThisMonthCount === 2);
ok('leadsThisMonth = 5 (a–e created now; f has no date)', k.leadsThisMonth === 5);
ok('topSource = referral (3 non-deleted)', k.topSource === 'referral' && k.topSourceCount === 3);

// empty pipeline → all zeros, no NaN/crash
{
  win._leads = []; win._estimates = [];
  const z = win.computeKPIs();
  ok('empty pipeline → pipelineValue 0', z.pipelineValue === 0);
  ok('empty pipeline → closeRate 0 (no divide-by-zero)', z.closeRate === 0);
  ok('empty pipeline → avgDealSize 0', z.avgDealSize === 0);
  ok('empty pipeline → topSource N/A', z.topSource === 'N/A');
}

// ── Estimate funnel analytics (estimate-analytics.js) ──
{
  console.log('\nESTIMATE FUNNEL — NBDEstimateAnalytics.compute');
  const ew = loadIIFE('estimate-analytics.js');
  const EA = ew.NBDEstimateAnalytics;
  ok('exposes NBDEstimateAnalytics.compute', EA && typeof EA.compute === 'function');
  // estimate-analytics._toMillis accepts numeric millis or Firestore Timestamps
  // (not ISO strings — it's stricter than analytics-kpi's parser).
  const t = (days) => Date.now() - days * 86400e3;
  ew._estimates = [
    { id: 'd1', status: 'draft' },                                            // draft
    { id: 's1', sentAt: t(1) },                                               // sent
    { id: 's2', sentAt: t(3), viewedAt: t(0) },                              // sent + viewed
    { id: 'g1', signedAt: t(0), grandTotal: 12000, tier: 'best' },          // signed
    { id: 'g2', sentAt: t(5), signedAt: t(0), grandTotal: 8000, tier: 'good' }, // signed + timeToSign
    { id: 'l1', status: 'lost' },                                            // lost
    { id: 'x', deleted: true, status: 'signed', grandTotal: 99999 },         // excluded
  ];
  const a = EA.compute();
  ok('draft count = 1', a.draft === 1);
  ok('sent count = 2', a.sent === 2);
  ok('viewed count = 1', a.viewed === 1);
  ok('signed count = 2 (deleted excluded)', a.signed === 2);
  ok('lost count = 1', a.lost === 1);
  ok('signedTotal = 20000 (deleted 99999 excluded)', a.signedTotal === 20000);
  ok('avgTicket = 10000', a.avgTicket === 10000);
  ok('tierCounts best=1, good=1', a.tierCounts.best === 1 && a.tierCounts.good === 1);
  ok('timeToSignDays captured for sent→signed', a.timeToSignDays.length === 1 && Math.round(a.timeToSignDays[0]) === 5);
}

// ── Invoice cash-collected metrics (computeFullAnalytics) ──
// Regression guard for the deposit-visibility bug: "Total Revenue" and the
// "this month" figure must count cash ACTUALLY collected (total − balanceDue,
// dated by lastPaymentAt||paidAt), so a partial deposit — status stays 'sent',
// paidAt null, balanceDue reduced, lastPaymentAt stamped — is not invisible.
// Mirrors money-dashboard.js's Collected card so #/analytics and #/money agree.
{
  console.log('\nANALYTICS REVENUE — computeFullAnalytics (invoice cash basis)');
  const CFA = win.AnalyticsKPI && win.AnalyticsKPI._test && win.AnalyticsKPI._test.computeFullAnalytics;
  ok('exposes _test.computeFullAnalytics', typeof CFA === 'function');

  const N = new Date();
  const inMonth = new Date(N.getFullYear(), N.getMonth(), 15);       // this month
  const prevMonth = new Date(N.getFullYear(), N.getMonth() - 1, 15); // earlier (not this month)

  const data = {
    leads: [], knocks: [], photos: [], estimates: [], expenses: [],
    invoices: [
      { status: 'paid', paidAt: inMonth,   total: 12000, balanceDue: 0 },                           // full payoff, this month
      { status: 'paid', paidAt: prevMonth, total: 5000,  balanceDue: 0 },                           // full payoff, earlier month
      { status: 'sent', total: 10000, balanceDue: 6000, amountPaid: 4000, lastPaymentAt: inMonth }, // PARTIAL deposit this month: $4k in, $6k due
      { status: 'sent', total: 8000,  balanceDue: 8000 },                                           // never paid: $0 collected, $8k due
      { status: 'paid', paidAt: prevMonth, total: 3000 },                                           // legacy full payoff, no balanceDue field
    ],
  };
  const a = CFA(data);

  ok('totalRevenue = collected cash incl. partial deposit (12k+5k+4k+3k = 24000)', a.totalRevenue === 24000);
  ok('monthRevenue = this-month cash incl. deposit (12k+4k = 16000)', a.monthRevenue === 16000);
  ok('unpaidAmount = outstanding balances (6k+8k = 14000)', a.unpaidAmount === 14000);
  ok('paidCount = fully-paid invoices only (3)', a.paidCount === 3);
  ok('unpaidCount = not-fully-paid invoices (2)', a.unpaidCount === 2);
  // The partial-deposit invoice's $4k is invisible under the old status==='paid'
  // && paidAt gate; asserting it's INCLUDED is the core regression check.
  ok('partial deposit is counted, not dropped (totalRevenue > paid-only 20000)', a.totalRevenue === 24000 && a.totalRevenue !== 20000);
  // Reconciliation: collected + outstanding == total invoiced — no cash lost or
  // double-counted (the deposit's $4k collected + $6k due == its $10k face).
  const totalInvoiced = data.invoices.reduce((s, i) => s + i.total, 0);
  ok('collected + outstanding reconciles to total invoiced (38000)', a.totalRevenue + a.unpaidAmount === totalInvoiced);

  // Empty invoices → zeros, no NaN/crash.
  const z = CFA({ leads: [], invoices: [], knocks: [], photos: [], estimates: [], expenses: [] });
  ok('no invoices → totalRevenue 0', z.totalRevenue === 0);
  ok('no invoices → monthRevenue 0', z.monthRevenue === 0);
  ok('no invoices → unpaidAmount 0', z.unpaidAmount === 0);

  // Multi-payment ledger: deposit this month + balance next month must not
  // move the deposit out of this month when lastPaymentAt is the later date.
  const nextMonth = new Date(N.getFullYear(), N.getMonth() + 1, 15);
  const multi = CFA({
    leads: [], knocks: [], photos: [], estimates: [], expenses: [],
    invoices: [{
      status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
      lastPaymentAt: nextMonth,
      paidAt: nextMonth,
      payments: [
        { amount: 4000, at: inMonth },
        { amount: 6000, at: nextMonth },
      ],
    }],
  });
  ok('multi-pay totalRevenue = 10000 (both payments)', multi.totalRevenue === 10000);
  ok('multi-pay monthRevenue = this-month deposit only (4000)', multi.monthRevenue === 4000);

  // Transition reconciliation: a pre-ledger deposit (no payments[] entry)
  // followed by a ledger-tracked payoff must NOT vanish from totals — a
  // synthetic remainder (dated at the earliest ledger entry) keeps the sum
  // at total−balanceDue.
  const mixed = CFA({
    leads: [], knocks: [], photos: [], estimates: [], expenses: [],
    invoices: [{
      status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
      lastPaymentAt: inMonth,
      paidAt: inMonth,
      // Only the payoff is in the ledger; the $4,000 deposit predates it.
      payments: [{ amount: 6000, at: inMonth }],
    }],
  });
  ok('mixed shape totalRevenue = 10000 (ledger 6000 + synthetic 4000 remainder)',
    mixed.totalRevenue === 10000);
  ok('mixed shape monthRevenue = 10000 (remainder dated at earliest ledger entry)',
    mixed.monthRevenue === 10000);

  // Discriminator: the synthetic remainder must date at the EARLIEST ledger
  // entry, NOT lastPaymentAt. Ledger entry last month, lastPaymentAt this
  // month → this month's revenue must be 0 (a lastPaymentAt-dated regression
  // would show 4000 here).
  const priorMonth = new Date(N.getFullYear(), N.getMonth() - 1, 15);
  const disc = CFA({
    leads: [], knocks: [], photos: [], estimates: [], expenses: [],
    invoices: [{
      status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
      lastPaymentAt: inMonth, paidAt: inMonth,
      payments: [{ amount: 6000, at: priorMonth }],
    }],
  });
  ok('synthetic remainder dated at earliest ledger entry, NOT lastPaymentAt (totalRevenue 10000)',
    disc.totalRevenue === 10000);
  ok('synthetic remainder dated at earliest ledger entry, NOT lastPaymentAt (monthRevenue 0)',
    disc.monthRevenue === 0);

  // Over-collected ledger in the analytics copy: no negative synthetic.
  const overA = CFA({
    leads: [], knocks: [], photos: [], estimates: [], expenses: [],
    invoices: [{
      status: 'paid', total: 1000, balanceDue: 0, amountPaid: 1100,
      lastPaymentAt: inMonth, paidAt: inMonth,
      payments: [{ amount: 1100, at: inMonth }],
    }],
  });
  ok('analytics over-collected ledger: no negative synthetic (1100 stands)',
    overA.totalRevenue === 1100);

  // ── monthlyTrend attributes a won lead to its CLOSE month, not its edit month ──
  //
  // monthlyTrend used to bucket won-lead revenue by updatedAt with no
  // stageStartedAt fallback, so any later write to a won lead — a note, an
  // address repair, a list re-save — moved its revenue into the month of the
  // edit. closedThisMonth already had the fallback (analytics-kpi.js F3); this
  // chart was missed. Discriminator: close LAST month, edit THIS month. A
  // regression puts the revenue in the current bucket.
  console.log('\nANALYTICS monthlyTrend — close-month attribution');
  const mk = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const thisKey = mk(N), prevKey = mk(prevMonth);

  const trend = CFA({
    knocks: [], photos: [], estimates: [], expenses: [], invoices: [],
    leads: [{
      id: 'won-last-month-edited-today', stage: 'closed', jobValue: 2500,
      createdAt: prevMonth,
      stageStartedAt: prevMonth,  // actually closed LAST month
      updatedAt: inMonth,         // but touched THIS month
    }],
  }).monthlyTrend;

  // Revenue = COLLECTED (Jo, 2026-09-28): a won lead's jobValue is booked,
  // not revenue — with no invoice payments, no month shows revenue.
  ok('a won lead with no payments adds no revenue to any month',
    trend[prevKey] && trend[prevKey].revenue === 0 && trend[thisKey] && trend[thisKey].revenue === 0);
  ok('the close is counted once, in the close month',
    trend[prevKey].closed === 1 && trend[thisKey].closed === 0);

  // Fallback still holds for pre-migration rows that have no stageStartedAt.
  const legacyTrend = CFA({
    knocks: [], photos: [], estimates: [], expenses: [], invoices: [],
    leads: [{
      id: 'won-no-stageStartedAt', stage: 'closed', jobValue: 700,
      createdAt: prevMonth, updatedAt: prevMonth,
    }],
  }).monthlyTrend;
  ok('a row with no stageStartedAt still falls back to updatedAt',
    legacyTrend[prevKey] && legacyTrend[prevKey].closed === 1);

  // Trend revenue comes from invoice payments, bucketed by PAYMENT date.
  const cashTrend = CFA({
    leads: [], knocks: [], photos: [], estimates: [], expenses: [],
    invoices: [{ status: 'partial', total: 9000, amountPaid: 4000, balanceDue: 5000,
      lastPaymentAt: inMonth, payments: [{ amount: 1500, at: prevMonth }, { amount: 2500, at: inMonth }] }],
  }).monthlyTrend;
  ok('trend revenue = payments in their own months (1500 last month, 2500 this month)',
    cashTrend[prevKey] && cashTrend[prevKey].revenue === 1500 && cashTrend[thisKey] && cashTrend[thisKey].revenue === 2500);
}

// Owed rule (2026-10-03): a voided Stripe mirror ({status:'void', balanceDue:0})
// and a never-sent draft are not owed. The old `balanceDue || total` read the
// void's 0 as "missing" and showed its full total as unpaid.
{
  console.log('\nANALYTICS A/R — void / draft are not owed');
  const CFA = win.AnalyticsKPI._test.computeFullAnalytics;
  const a = CFA({ leads: [], knocks: [], photos: [], estimates: [], expenses: [], invoices: [
    { status: 'sent', total: 1000, balanceDue: 1000 },
    { status: 'void', source: 'stripe', total: 5000, balanceDue: 0 },
    { status: 'draft', total: 2500, balanceDue: 2500 },
    { status: 'sent', total: 900, balanceDue: 0 },
    { status: 'sent', total: 600 },
  ] });
  ok('unpaidAmount excludes void + draft, balanceDue 0 is 0 (1000 + 600 = 1600; got ' + a.unpaidAmount + ')', a.unpaidAmount === 1600);
  ok('unpaidCount excludes void + draft (3; got ' + a.unpaidCount + ')', a.unpaidCount === 3);
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
