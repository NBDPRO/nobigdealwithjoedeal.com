/**
 * tests/revenue-collected-only-2026-09-28.test.js
 *
 * Jo, 2026-09-28: "Revenue is always collected only. We can do projected
 * separately but that's literally projected." Before this, 30 surfaces showed a
 * revenue-type figure and only five were cash — the Home tile read $32.7k
 * (closed leads' jobValue) beside Reports' $0 (signed estimates).
 *
 * docs/pro/js/collected-revenue.js (window.NBDRevenue) is the shared definition
 * the dashboard's revenue surfaces now read. This suite:
 *   1. runs its paymentsOf next to analytics-kpi.js's (the Money/Analytics
 *      copy) on the same invoices — ledger, deposit + payoff, legacy lump,
 *      pre-ledger shortfall — and requires identical output;
 *   2. checks collectedBetween (payment-date windows, deleted skipped) and
 *      collectedByLead;
 *   3. checks loadInvoices scoping (staff → companyId, else createdBy) and the
 *      per-account cache;
 *   4. pins the surfaces: no "revenue"-labelled figure falls back to jobValue.
 *
 * Zero deps. Run: node tests/revenue-collected-only-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function loadRevenue(win) {
  const w = Object.assign({ addEventListener() {}, dispatchEvent() {} }, win || {});
  const ctx = { window: w, console: { log() {}, warn() {}, error() {} }, CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; } };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/collected-revenue.js'), ctx, { filename: 'collected-revenue.js' });
  return w;
}

// analytics-kpi's private paymentsOf, lifted out (the Money/Analytics copy).
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(start, i);
}
const AK = read('docs/pro/js/analytics-kpi.js');
const akCtx = {};
vm.createContext(akCtx);
vm.runInContext(['toJSDate', 'collectedDollarsOf', 'paymentsOf'].map((n) => extractFn(AK, n)).join('\n') + '\nglobalThis.__p = paymentsOf;', akCtx);
const akPaymentsOf = akCtx.__p;

const T = (iso) => ({ toDate: () => new Date(iso), seconds: Date.parse(iso) / 1000 });
const INVOICES = [
  { id: 'i1', leadId: 'L1', total: 10000, balanceDue: 0, payments: [{ amount: 5000, at: T('2026-08-10T12:00:00Z') }, { amount: 5000, at: T('2026-09-15T12:00:00Z') }] },
  { id: 'i2', leadId: 'L2', total: 8000, balanceDue: 4000, payments: [{ amount: 4000, at: T('2026-09-20T12:00:00Z') }] },
  { id: 'i3', leadId: 'L1', total: 3000, balanceDue: 0, paidAt: T('2026-09-02T12:00:00Z') },                       // legacy lump
  { id: 'i4', leadId: 'L3', total: 6000, balanceDue: 0, payments: [{ amount: 2000, at: T('2026-09-25T12:00:00Z') }] }, // pre-ledger shortfall 4000
  { id: 'i5', leadId: 'L4', total: 9999, balanceDue: 9999 },                                                         // nothing paid
  { id: 'i6', leadId: 'L5', total: 700, balanceDue: 0, paidAt: T('2026-09-05T12:00:00Z'), deleted: true },           // deleted
];

console.log('REVENUE — one collected-only definition');
{
  const R = loadRevenue().NBDRevenue;
  const same = INVOICES.every((inv) => JSON.stringify(R.paymentsOf(inv).map((p) => [p.amount, !!p.synthetic])) === JSON.stringify(akPaymentsOf(inv).map((p) => [p.amount, !!p.synthetic])));
  ok('paymentsOf matches the Money/Analytics copy on every shape', same);
  const sep = { start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-09-30T23:59:59Z') };
  const r = R.collectedBetween(INVOICES, sep.start, sep.end);
  // Sept: i1 payoff 5000 + i2 4000 + i3 lump 3000 + i4 2000 + synthetic 4000 (dated at its earliest ledger entry, 09-25)
  ok('September collected = 18,000 (payment dates; the August deposit excluded; deleted skipped)', r.total === 18000, 'got ' + r.total);
  ok('open-ended window = all-time 23,000', R.collectedBetween(INVOICES, null, null).total === 23000);
  const byLead = R.collectedByLead(INVOICES, null, null);
  ok('collectedByLead sums per lead (L1 = 13,000, L2 = 4,000, L4 absent)', byLead.L1 === 13000 && byLead.L2 === 4000 && !('L4' in byLead));
  ok('lead filter narrows the window', R.collectedBetween(INVOICES, sep.start, sep.end, (id) => id === 'L2').total === 4000);
}

console.log('REVENUE — invoice load scoping + per-account cache');
(async () => {
  const calls = [];
  const mk = (claims, uid) => loadRevenue({
    _user: { uid }, _userClaims: claims, db: {},
    collection: (db, c) => c,
    where: (f, op, v) => ({ f, v }),
    query: (c, w) => ({ c, w }),
    getDocs: async (q) => { calls.push(q.w.f + '=' + q.w.v); return { docs: [{ id: 'x', data: () => ({ total: 100, balanceDue: 0, paidAt: T('2026-09-01T00:00:00Z') }) }] }; },
  });
  const staffWin = mk({ role: 'company_admin', companyId: 'co1' }, 'u1');
  await staffWin.NBDRevenue.loadInvoices();
  ok('staff load is company-wide (companyId)', calls[0] === 'companyId=co1', calls[0]);
  await staffWin.NBDRevenue.loadInvoices();
  ok('second load is served from cache (no second query)', calls.length === 1);
  ok('cached() returns the loaded invoices', staffWin.NBDRevenue.cached().length === 1);
  staffWin._user = { uid: 'u2' };
  ok('cache is not served to a different signed-in account', staffWin.NBDRevenue.cached() === null);
  const repWin = mk({ role: 'sales_rep', companyId: 'co1' }, 'u9');
  await repWin.NBDRevenue.loadInvoices();
  ok('a rep loads only their own invoices (createdBy)', calls[calls.length - 1] === 'createdBy=u9', calls[calls.length - 1]);

  console.log('REVENUE — no render loop when invoices can\'t load (froze the page on the emulator)');
  {
    const bare = loadRevenue({ _user: { uid: 'u1' } }); // no db yet (boot)
    const got = await bare.NBDRevenue.loadInvoices();
    ok('no db/user yet → resolves [] and caches NOTHING (cached() stays null)', Array.isArray(got) && got.length === 0 && bare.NBDRevenue.cached() === null);
    let q = 0;
    const failing = loadRevenue({ _user: { uid: 'u1' }, _userClaims: {}, db: {}, collection: () => 'c', where: () => ({}), query: () => ({}), getDocs: async () => { q++; throw new Error('permission-denied'); } });
    await failing.NBDRevenue.loadInvoices();
    await failing.NBDRevenue.loadInvoices();
    ok('a failed query is not retried on the next render (30 s back-off)', q === 1, 'queries=' + q);
    const callers = ['docs/pro/js/widgets.js', 'docs/pro/js/analytics-kpi.js', 'docs/pro/js/lead-source-roi.js'].map(read).join('\n');
    const thens = callers.match(/loadInvoices\(\)\.then\([^;]*?\{[^}]*\}/g) || [];
    ok('every re-render-after-load callback is guarded on cached()', thens.length === 3 && thens.every((t) => /cached\(\)/.test(t)), thens.length + ' callbacks');
  }

  console.log('REVENUE — surfaces labelled revenue read collected money');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const widgets = strip(read('docs/pro/js/widgets.js'));
  const wStart = widgets.indexOf("id:'revenue-month'");
  const wSlice = widgets.slice(wStart, wStart + 4000);
  ok('Home "Revenue This Month" sums NBDRevenue.collectedBetween', /R\.collectedBetween\(/.test(wSlice));
  ok('…and no longer sums jobValue', !/jobValue/.test(wSlice));
  const kpi = strip(AK);
  ok('Analytics KPI "Revenue This Month" reads collected', /_R\.collectedBetween\(/.test(kpi));
  ok('Analytics monthly trend revenue comes from payments', /monthlyTrend\[mk\]\.revenue \+= parseFloat\(p\.amount\)/.test(kpi) && !/monthlyTrend\[mk\]\.revenue \+= parseFloat\(l\.jobValue\)/.test(kpi));
  const lb = strip(read('docs/pro/js/pages/leaderboard.js'));
  ok('Leaderboard revenue has no jobValue fallback', !/revenueFallback = totalRevenue > 0 \?/.test(lb));
  const roi = strip(read('docs/pro/js/lead-source-roi.js'));
  ok('Lead Source ROI revenue = collectedRev (no closedRev left)', /collectedRev/.test(roi) && !/closedRev/.test(roi));
  const dash = read('docs/pro/dashboard.html');
  ok('no "Closed Revenue" / "Revenue Added" labels on the dashboard', !/>Closed Revenue</.test(dash) && !/>Revenue Added</.test(dash));
  ok('collected-revenue.js loads before widgets.js', dash.indexOf('js/collected-revenue.js') > 0 && dash.indexOf('js/collected-revenue.js') < dash.indexOf('js/widgets.js'));

  console.log('REVENUE — rep reports + weekly digest email');
  {
    const rep = strip(read('docs/pro/js/rep-report-generator.js'));
    ok('rep report loads the shared invoices before computing', /_repInvoices = window\.NBDRevenue \? await window\.NBDRevenue\.loadInvoices\(\)/.test(rep));
    ok('core KPI revenue = collectedOn(leads, range); booked kept separately', /const revenue = collectedOn\(leads, rangeStart, rangeEnd\);\s*const bookedValue =/.test(rep));
    ok('no report revenue sums jobValue', !/revenue \+= Number\(l\.jobValue\)/.test(rep) && !/revenue = won\.reduce/.test(rep));
    ok('hero label says Revenue Collected', />Revenue Collected</.test(rep) && !/>Revenue Closed</.test(rep));

    const WD = read('functions/weekly-digest.js');
    const wdCtx = {};
    vm.createContext(wdCtx);
    vm.runInContext(['timestampMillis', '_paymentsOf'].map((n) => extractFn(WD, n)).join('\n') + '\nglobalThis.__p = _paymentsOf;', wdCtx);
    const R = loadRevenue().NBDRevenue;
    const sameServer = INVOICES.every((inv) => JSON.stringify(wdCtx.__p(inv).map((p) => [p.amount, !!p.synthetic])) === JSON.stringify(R.paymentsOf(inv).map((p) => [p.amount, !!p.synthetic])));
    ok('digest _paymentsOf (server) matches the client definition on every shape', sameServer);
    const wd = strip(WD);
    ok('digest headline stat is Revenue Collected (Wk); wins are labelled booked', /Revenue Collected \(Wk\)/.test(wd) && /Won This Week \(booked\)/.test(wd) && !/Won Revenue \(Wk\)/.test(wd));
    ok('digest subject quotes collected, not won value', /collectedThisWeek \|\| 0\)\} collected`/.test(wd));
    ok('a win counts only if it reached a won stage this week (stageStartedAt)', /touchedThisWeek\.filter\(_isWonLead\)\s*\.filter\(l => !l\.stageStartedAt \|\| timestampMillis\(l\.stageStartedAt\) >= cutoff\)/.test(wd));
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
