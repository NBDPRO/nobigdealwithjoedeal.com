/**
 * tests/dashboards-agree-r6-2026-10-07.test.js
 *
 * Review round 6 — "every dashboard counts sales and jobs the same way"
 * (R6-2-10, R6-2-11, R6-2-12, R6-2-13, R6-2-14) and the last estimate editor
 * that re-priced without moving jobValue (R6-2-7, logged-estimate half; the
 * pre-flight half is #2295).
 *
 * THE SHARED DEFINITIONS (already in the code — this change makes every
 * surface use them):
 *   - A SALE = numbers-logic.js isSale (server: stage-roles.js isSale): won,
 *     in production, or Contract Signed (Jo 2026-09-15 / #2252). Not "won
 *     role only", not a signed-and-won pair.
 *   - A JOB RECORD = jobs-store.js records()/recordsFor (server:
 *     jobs-logic.js jobRecords, #2247): one record per JOB — the card is its
 *     active job, every other job is the customer with that job's fields laid
 *     over. Customer COUNTS stay on the leads.
 *   - A sale's DATE = numbers-logic.js saleDateMs (closedAt, else the first
 *     move into a sale stage), never updatedAt.
 *
 * THE WORKED EXAMPLE (the R6 review fixture): nine sales on the cards adding
 * up to $89,500, and customer G — whose card moved on to a signed $8,000
 * second job after a finished, paid $10,000 first job. Every surface must
 * count ten sales / $99,500, a signed-not-won contract counts as booked, and
 * an edited old win never counts again.
 *
 * Drives the real modules: numbers-logic.js, widgets.js, analytics-kpi.js,
 * money-dashboard.js, lead-source-roi.js, jobs-store.js and crm-stages.js
 * (vm / import), functions/agent-mcp-logic.js (require), the Leaderboard
 * page's own module with its Firebase imports stubbed, and the logged-
 * estimate editor out of dashboard-widgets.js against a fake DOM.
 * Run: node tests/dashboards-agree-r6-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const CER = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));
const JS = require(path.join(ROOT, 'docs', 'pro', 'js', 'jobs-store.js'));
const N = require(path.join(ROOT, 'docs', 'pro', 'js', 'numbers-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
async function sec(name, fn) {
  try { await fn(); } catch (e) { ok(name + ' ran without throwing', false, e && e.stack); }
}
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const NOW = Date.now();
const DAY = 86400000;
const d = (n) => NOW - n * DAY;
const today = new Date(NOW).toISOString().slice(0, 10);

// The R6 review fixture (scratchpad/dash/fixtures.js), D1/D2 at their stored values.
const LEADS = () => [
  { id: 'A', userId: 'u1', firstName: 'A', source: 'Door Knock', stage: 'closed', jobValue: 1800, closedAt: d(2), createdAt: d(20), updatedAt: d(2), stageStartedAt: d(2) },
  { id: 'B', userId: 'u1', firstName: 'B', source: 'Referral', stage: 'final_payment', jobValue: 12000, closedAt: d(40), createdAt: d(60), updatedAt: d(3), stageStartedAt: d(3) },
  { id: 'C', userId: 'u1', firstName: 'C', source: 'Google', stage: 'install_complete', jobType: 'insurance', jobValue: 14000, closedAt: d(30), createdAt: d(50), updatedAt: d(4), stageStartedAt: d(4) },
  { id: 'D1', userId: 'u1', firstName: 'D1', source: 'Thumbtack', stage: 'contract_signed', jobValue: 10500, acceptedPrice: 10500, closedAt: d(1), createdAt: d(10), updatedAt: d(1), stageStartedAt: d(1) },
  { id: 'D2', userId: 'u1', firstName: 'D2', source: 'Thumbtack', stage: 'contract_signed', jobValue: 12000, acceptedPrice: 10500, closedAt: d(1), createdAt: d(10), updatedAt: d(1), stageStartedAt: d(1) },
  { id: 'E', userId: 'u1', firstName: 'E', source: 'Google', stage: 'contract_signed', jobValue: 10000, closedAt: d(1), createdAt: d(9), updatedAt: d(1), stageStartedAt: d(1) },
  { id: 'F', userId: 'u1', firstName: 'F', source: 'Referral', stage: 'contract_signed', jobValue: 16200, closedAt: d(20), createdAt: d(30), updatedAt: d(1), stageStartedAt: d(20) },
  { id: 'G', userId: 'u1', firstName: 'G', source: 'Referral', stage: 'contract_signed', jobValue: 8000, closedAt: d(2), createdAt: d(90), updatedAt: d(2), stageStartedAt: d(2), activeJobId: 'j2' },
  { id: 'H', userId: 'u1', firstName: 'H', source: 'Door Knock', stage: 'closed', jobValue: 5000, closedAt: d(3), createdAt: d(15), updatedAt: d(1), stageStartedAt: d(3) },
  { id: 'O', userId: 'u1', firstName: 'O', source: 'Google', stage: 'estimate_submitted', jobValue: 9000, createdAt: d(5), updatedAt: d(5), stageStartedAt: d(5) },
];
const JOBS = {
  G: [{ id: 'j1', stage: 'closed', stageRole: 'won', jobValue: 10000, closedAt: d(50), createdAt: d(90) },
      { id: 'j2', stage: 'contract_signed', jobValue: 8000, closedAt: d(2), createdAt: d(10) }],
};
const pay = (amount, at) => ({ amount, at: new Date(at) });
const INVOICES = () => [
  { id: 'iA', leadId: 'A', createdBy: 'u1', status: 'paid', total: 1800, balanceDue: 0, amountPaid: 1800, payments: [pay(1800, d(2))] },
  { id: 'iG1', leadId: 'G', jobId: 'j1', createdBy: 'u1', status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000, payments: [pay(10000, d(45))] },
];
// Dated today so the Money dashboard's this-year filter keeps them in any month.
const EXPENSES = () => [
  { id: 'x1', leadId: 'G', costType: 'direct', amountCents: 600000, taxCents: 0, date: today },
  { id: 'x2', leadId: 'A', costType: 'direct', amountCents: 90000, taxCents: 0, date: today },
];
const WANT_SALES = 10, WANT_BOOKED = 99500;

(async () => {
  const stages = await import(pathToFileURL(path.join(ROOT, 'docs', 'pro', 'js', 'crm-stages.js')).href);
  const recordsFor = (leads) => JS.records(leads, (id) => JOBS[id] || [], stages.normalizeStage, stages.stageRole);
  const fakeJobs = () => ({ recordsFor, records: JS.records });
  const recs = recordsFor(LEADS());

  console.log('\nThe shared definitions (numbers-logic.js)');
  await sec('shared definitions', async () => {
  ok('context: the cards alone add up to $89,500 of sales; the job records to $99,500 (G\'s finished first job)',
    N.salesBetween(LEADS(), null, null).reduce((s, l) => s + N.bookedCents(l), 0) === 8950000
      && N.salesBetween(recs, null, null).reduce((s, l) => s + N.bookedCents(l), 0) === WANT_BOOKED * 100);
  {
    const signedOnly = { id: 'S', stage: 'contract_signed', jobValue: 5000, closedAt: d(1) };
    const editedOldWin = { id: 'W', stage: 'closed', jobValue: 7000, closedAt: d(40), updatedAt: d(0) };
    const weekStart = d(7);
    const wk = N.salesBetween([signedOnly, editedOldWin], weekStart, NOW);
    ok('salesBetween: a signed-not-won contract is a sale this week; an old win edited today is NOT (dated by closedAt, not updatedAt)',
      wk.length === 1 && wk[0].id === 'S', JSON.stringify(wk.map((l) => l.id)));
    ok('salesBetween: all time (no window) counts both, an undated sale included',
      N.salesBetween([signedOnly, editedOldWin, { id: 'U', stage: 'closed', jobValue: 1 }], null, null).length === 3);
  }
  });

  // ── R6-2-11 — Home "Team Leaderboard" widget, "Booked (all time)" ───────
  console.log('\nR6-2-11 — the Booked (all time) widget');
  await sec('widget', async () => {
    function makeEl() {
      return { _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = String(v); }, style: {}, dataset: {},
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, remove() {} };
    }
    const store = new Map();
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    const document = { getElementById: () => makeEl(), createElement: makeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: makeEl(), head: makeEl() };
    const win = { _user: { uid: 'u1', displayName: 'Jo' }, addEventListener() {}, matchMedia: () => ({ matches: false }), showToast() {},
      NBDCustomerEstimateRows: CER, NBDJobs: fakeJobs(), stageRole: stages.stageRole, normalizeStage: stages.normalizeStage };
    win.window = win;
    const sandbox = Object.assign({ window: win, document, localStorage, console: { log() {}, warn() {}, error() {}, info() {} },
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Promise, Array, Object, String, Number, Set, Map, isNaN, parseFloat, parseInt,
      fetch: () => Promise.reject(new Error('no network')), navigator: { userAgent: 'node' }, location: { hash: '', pathname: '/pro/dashboard' } }, win);
    vm.createContext(sandbox);
    vm.runInContext(rd('docs/pro/js/numbers-logic.js'), sandbox, { filename: 'numbers-logic.js' });
    vm.runInContext(rd('docs/pro/js/widgets.js'), sandbox, { filename: 'widgets.js' });
    const lb = win.NBDWidgets && win.NBDWidgets.WIDGETS.find((w) => w.id === 'team-leaderboard');
    ok('anchor: the team-leaderboard widget is registered', !!lb);
    win._leads = LEADS();
    const el = makeEl();
    lb.render(el);
    const m = /\$([\d.]+)k<\/div><div class="wg-tiny">(\d+) deals/.exec(el.innerHTML);
    ok('FIXED (was KNOWN BUG R6-2-11): "Booked (all time)" counts every sale incl. signed contracts and G\'s two jobs — 10 deals, $99.5k (was 5 deals, $42.8k)',
      !!m && m[1] === '99.5' && Number(m[2]) === WANT_SALES, el.innerHTML.replace(/\s+/g, ' ').slice(0, 400));
  });

  // ── R6-2-12 — Analytics vs Money gross margin ──────────────────────────
  console.log('\nR6-2-12 — one gross margin on Analytics and Money');
  let akMargin = null, mdMargin = null;
  await sec('analytics', async () => {
    const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
    const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' } };
    win.window = win;
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, body: noop(), readyState: 'complete' }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Object };
    vm.createContext(sb);
    ['numbers-logic.js', 'analytics-kpi.js'].forEach((f) => vm.runInContext(rd('docs/pro/js/' + f), sb, { filename: f }));
    win.stageRole = stages.stageRole; win.normalizeStage = stages.normalizeStage;
    win.NBDCustomerEstimateRows = CER; win.NBDJobs = fakeJobs();
    const fa = win.AnalyticsKPI._test.computeFullAnalytics({ leads: LEADS(), estimates: [], invoices: INVOICES(), knocks: [], photos: [], expenses: EXPENSES() });
    akMargin = fa.expGrossMargin;
    ok('FIXED (was KNOWN BUG R6-2-12): Analytics pools won JOBS — A ($1,800 / $900) + G\'s finished $10,000 job against G\'s $6,000 → 42% over 2 costed jobs (was 50%, G dropped)',
      fa.expGrossMargin === 42 && fa.expCostedJobs === 2, JSON.stringify({ g: fa.expGrossMargin, costed: fa.expCostedJobs, won: fa.expWonJobs }));
    const taxed = win.AnalyticsKPI._test.computeFullAnalytics({ leads: [LEADS()[0]], estimates: [], invoices: [], knocks: [], photos: [], expenses: [{ leadId: 'A', costType: 'direct', amountCents: 80000, taxCents: 10000, date: today }] });
    ok('Analytics job cost is tax-included like Money ($800 + $100 tax on $1,800 → 50%)', taxed.expGrossMargin === 50, String(taxed.expGrossMargin));
  });
  await sec('money', async () => {
    const win = { addEventListener() {}, location: { pathname: '/pro/dashboard' } };
    win.window = win;
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
    vm.createContext(sb);
    vm.runInContext(rd('docs/pro/js/money-dashboard.js'), sb, { filename: 'money-dashboard.js' });
    win.stageRole = stages.stageRole; win.NBDCustomerEstimateRows = CER;
    const leads = LEADS().map((l) => Object.assign({}, l, { _stageKey: stages.normalizeStage(l.stage), _stageRole: stages.stageRole(l.stage) }));
    const p = win.MoneyDashboard.computePnL({ leads, jobRecs: recordsFor(leads), invoices: INVOICES(), expenses: EXPENSES(), suppliers: [], year: new Date(NOW).getFullYear(), now: new Date(NOW) });
    mdMargin = p.grossMargin;
    ok('Money pools the same won jobs → 42% over 2 costed jobs', p.grossMargin === 42 && p.costedJobs === 2, JSON.stringify({ g: p.grossMargin, costed: p.costedJobs }));
  });
  ok('Analytics and Money print the SAME gross margin for the same jobs and costs', akMargin != null && akMargin === mdMargin, akMargin + ' vs ' + mdMargin);

  // ── R6-2-10 — agent job_profit ─────────────────────────────────────────
  console.log('\nR6-2-10 — the agent\'s job_profit walks job records');
  await sec('job_profit', async () => {
    const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
    const jp = L.jobProfit(LEADS(), INVOICES(), EXPENSES(), NOW, { days: 365 }, undefined, JOBS);
    const g = jp.jobs.filter((j) => j.lead_id === 'G');
    ok('FIXED (was KNOWN BUG R6-2-10): G\'s finished first job (j1) is listed with its $10,000 collected and $6,000 cost, though the card sits on the signed second job',
      g.length === 1 && g[0].job_id === 'j1' && g[0].collected === 10000 && g[0].direct_costs === 6000 && g[0].margin_pct === 40, JSON.stringify(jp.jobs));
    ok('the signed second job is not a finished job; totals = A + G\'s first job ($11,800 collected, $6,900 cost) — nothing counted twice',
      !jp.jobs.some((j) => j.job_id === 'j2') && jp.totals.collected === 11800 && jp.totals.direct_costs === 6900, JSON.stringify(jp.totals));
    const two = L.jobProfit([{ id: 'K', stage: 'closed', jobValue: 9000, activeJobId: 'j2', stageStartedAt: d(3) }],
      [{ id: 'k1', leadId: 'K', jobId: 'j1', payments: [pay(5000, d(40))], total: 5000, balanceDue: 0 }, { id: 'k2', leadId: 'K', payments: [pay(9000, d(3))], total: 9000, balanceDue: 0 }],
      [{ leadId: 'K', costType: 'direct', amountCents: 100000 }], NOW, { days: 365 }, undefined,
      // The card's job first, so "the last finished job" would be the wrong home.
      { K: [{ id: 'j2', stage: 'closed', jobValue: 9000 }, { id: 'j1', stage: 'closed', jobValue: 5000, closedAt: d(40) }] });
    const k1 = two.jobs.find((j) => j.job_id === 'j1'), k2 = two.jobs.find((j) => j.job_id === 'j2');
    ok('two finished jobs: a job-tagged invoice lands on its job; untagged money and costs land once, on the card\'s job',
      !!k1 && !!k2 && k1.collected === 5000 && k1.direct_costs === 0 && k2.collected === 9000 && k2.direct_costs === 1000 && two.totals.collected === 14000,
      JSON.stringify(two.jobs));
    const noJobs = L.jobProfit(LEADS(), INVOICES(), EXPENSES(), NOW, { days: 365 });
    ok('without the jobs read the tool still answers (each customer once, as before)', Array.isArray(noJobs.jobs) && noJobs.jobs.some((j) => j.lead_id === 'A'));
    const src = rd('functions/agent-mcp.js');
    const at = src.indexOf("if (name === 'job_profit') {");
    const blk = at === -1 ? '' : braceBlock(src, at);
    ok('the job_profit tool reads the company\'s jobs and passes them on', /companyJobsByLead\(company\)/.test(blk) && /L\.jobProfit\(leads, invoices, expenses, Date\.now\(\), args, tz, jobsByLead\)/.test(blk));
    const ls = L.leadSources(LEADS(), [], NOW, 365);
    const lsWon = ls.sources.reduce((s, r) => s + r.won, 0);
    ok('the agent\'s lead_sources counts a signed contract as won (the shared sale test): 9 won customers, not 4', lsWon === 9, JSON.stringify(ls.sources));
  });

  // ── R6-2-13 — lead-source table + week review source table ─────────────
  console.log('\nR6-2-13 — the lead-source tables count every job');
  await sec('sourceTable', async () => {
    const st = N.sourceTable(LEADS(), { jobRecords: recs });
    ok('FIXED (was KNOWN BUG R6-2-13): sourceTable over job records books $99,500 / 10 won (the cards alone: $89,500 / 9); 10 customers',
      st.totals.bookedCents === WANT_BOOKED * 100 && st.totals.won === WANT_SALES && st.totals.leads === 10, JSON.stringify(st.totals));
    const ref = st.rows.find((r) => r.source === 'Referral');
    ok('G\'s first job (no source of its own) books under G\'s source, Referral: B $12,000 + F $16,200 + G $8,000 + $10,000',
      !!ref && ref.bookedCents === 4620000 && ref.won === 4 && ref.leads === 3, JSON.stringify(ref));
    const old = N.sourceTable(LEADS(), {});
    ok('without job records the table is unchanged (per customer)', old.totals.bookedCents === 8950000 && old.totals.won === 9);

    // lead-source-roi.js hands the job records to sourceTable.
    const win = { NBDNumbers: N, NBDJobs: fakeJobs(), _leads: LEADS() };
    win.window = win;
    vm.runInNewContext(rd('docs/pro/js/lead-source-roi.js'), { window: win, document: { addEventListener() {}, getElementById() { return null; } }, console });
    const m = win.LeadSourceROI.compute(null);
    const bookedRev = m.rows.reduce((s, r) => s + r.bookedRev, 0);
    ok('the Lead Sources report (LeadSourceROI.compute) books $99,500 across its rows', bookedRev === WANT_BOOKED, String(bookedRev));

    // Week review: a repeat customer's second job signed THIS week.
    const K = { id: 'K', source: 'Google', stage: 'estimate_submitted', jobValue: 4000, createdAt: d(200), activeJobId: 'j3' };
    const kRecs = JS.records([K], () => [{ id: 'j2', stage: 'contract_signed', jobValue: 15000, closedAt: d(2) }, { id: 'j3', stage: 'estimate_submitted', jobValue: 4000 }], stages.normalizeStage, stages.stageRole);
    const wr = N.weeklyReview({ nowMs: NOW, leads: [K], jobRecords: kRecs });
    ok('the Sunday review books the second job signed this week ($15,000) while the card shows the next, open job',
      wr.bookedWins.count === 1 && wr.bookedWins.bookedCents === 1500000, JSON.stringify({ n: wr.bookedWins.count, c: wr.bookedWins.bookedCents }));
    const wrSrc = rd('docs/pro/js/week-review.js');
    ok('week-review.js hands weeklyReview the job records (NBDJobs.recordsFor)',
      /const jobRecords = J && typeof J\.recordsFor === 'function' \? J\.recordsFor\(leads\) : null;/.test(wrSrc) && /weeklyReview\(\{[\s\S]{0,120}\n\s*jobRecords,\n/.test(wrSrc));
  });

  // ── R6-2-14 — Leaderboard page "Deals" ─────────────────────────────────
  console.log('\nR6-2-14 — the Leaderboard page counts deals by the sale test and the sale date');
  await sec('leaderboard page', async () => {
    let src = rd('docs/pro/js/pages/leaderboard.js').replace(/\r\n/g, '\n');
    src = src.replace(/^import .*$/mg, '').replace(/^await connectEmulatorsIfLocal.*$/m, '');
    const win = {};
    win.window = win;
    const docStub = { getElementById: () => ({ style: {}, textContent: '', innerHTML: '' }), querySelectorAll: () => [], documentElement: { style: {} } };
    // The page's clock is frozen at today's local noon, so "an hour ago" and
    // "a minute ago" stay inside today whatever time the suite runs (before
    // 01:00 they used to land on yesterday and the 'day' check failed).
    const NOON = new Date(NOW).setHours(12, 0, 0, 0);
    class NoonDate extends Date {
      constructor(...a) { super(...(a.length ? a : [NOON])); }
      static now() { return NOON; }
    }
    const sb = { window: win, document: docStub, console, Date: NoonDate, Math, JSON, Object, Promise,
      initializeApp: () => ({}), getAuth: () => ({}), onAuthStateChanged: () => {}, getFirestore: () => ({}),
      collection() {}, collectionGroup() {}, getDocs: async () => ({ docs: [] }), query() {}, where() {}, __out: null };
    vm.createContext(sb);
    vm.runInContext(rd('docs/pro/js/numbers-logic.js'), sb, { filename: 'numbers-logic.js' });
    vm.runInContext(rd('docs/pro/js/jobs-store.js'), sb, { filename: 'jobs-store.js' });
    vm.runInContext('(async () => {\n' + src + '\n__out = { computeMetrics, setRaw: (v) => { rawData = v; }, setPeriod: (p) => { currentPeriod = p; } };\n})()', sb, { filename: 'leaderboard.js' });
    await new Promise((r) => setTimeout(r, 0));
    const LB = sb.__out;
    ok('anchor: the Leaderboard page module runs with its Firebase imports stubbed', !!LB && typeof LB.computeMetrics === 'function');
    if (!LB) return;
    LB.setRaw({ leads: LEADS(), knocks: [], invoices: [], jobsByLead: JOBS });
    LB.setPeriod('all');
    const all = LB.computeMetrics();
    ok('FIXED (was KNOWN BUG R6-2-14): all time = 10 deals — signed contracts and both of G\'s jobs (was 5: won roles only, G once)',
      all.totalDeals === WANT_SALES, String(all.totalDeals));
    // This month: only sales dated this month. B (closed 40 days ago, edited 3 days ago)
    // and H (closed 3 days ago, edited yesterday) must be judged by their close dates.
    const editedOldWin = { id: 'W', userId: 'u1', stage: 'closed', jobValue: 7000, closedAt: NOON - 60 * DAY, updatedAt: NOON - 60000, createdAt: NOON - 90 * DAY };
    const signedThisWeek = { id: 'S', userId: 'u1', stage: 'contract_signed', jobValue: 5000, closedAt: NOON - 3600000, updatedAt: NOON - 3600000, createdAt: NOON - 5 * DAY };
    LB.setRaw({ leads: [editedOldWin, signedThisWeek], knocks: [], invoices: [], jobsByLead: {} });
    LB.setPeriod('day');
    const day = LB.computeMetrics();
    ok('today: the contract signed an hour ago is a deal; the 60-day-old win edited a minute ago is NOT re-counted',
      day.totalDeals === 1 && day.wonLeads[0].id === 'S', JSON.stringify(day.wonLeads.map((l) => l.id)));
    const html = rd('docs/pro/leaderboard.html');
    const iN = html.indexOf('js/numbers-logic.js'), iJ = html.indexOf('js/jobs-store.js'), iM = html.indexOf('js/pages/leaderboard.js');
    ok('leaderboard.html loads numbers-logic.js and jobs-store.js (defer) before its module',
      iN > 0 && iJ > 0 && iN < iM && iJ < iM && /<script defer src="js\/numbers-logic\.js\?v=\d+"><\/script>/.test(html) && /<script defer src="js\/jobs-store\.js\?v=\d+"><\/script>/.test(html));
    ok('the page says "Deals Booked", not "Deals Closed" (a signed contract is booked, not closed)', !/Deals Closed/.test(html) && /Deals Booked/.test(html));
  });

  // ── R6-2-7 — the logged-estimate editor moves jobValue ─────────────────
  console.log('\nR6-2-7 — editing a logged estimate re-stamps the primary estimate\'s jobValue');
  await sec('logged-estimate editor', async () => {
    const src = rd('docs/pro/js/dashboard-widgets.js');
    const fns = ['function _loggedJobValueAfterEdit(', 'async function _restampLoggedJobValue(', 'function _openLoggedEstimateEditor('].map((h) => {
      const at = src.indexOf(h);
      if (at === -1) return '';
      return src.slice(at, at + h.length) + src.slice(at + h.length, src.indexOf('{', at)) + braceBlock(src, at);
    });
    ok('anchor: the logged-estimate editor and its jobValue helpers are found', fns.every(Boolean));
    async function run({ lead, est, amount, failLead }) {
      const writes = [];
      const store = { L: lead ? Object.assign({}, lead) : null };
      const els = [];
      const mk = (tag) => {
        const e = { tag, style: {}, value: '', id: '', children: [], h: {}, setAttribute() {}, appendChild(c) { this.children.push(c); return c; },
          addEventListener(t, f) { this.h[t] = f; }, remove() {}, focus() {} };
        els.push(e); return e;
      };
      const win = {
        db: {}, NBDCustomerEstimateRows: CER, matchMedia: () => ({ matches: false }), _leads: [],
        doc: (_db, col, id) => ({ col, id }),
        getDoc: async (ref) => ({ exists: () => !!store[ref.id], data: () => store[ref.id] }),
        updateDoc: async (ref, patch) => {
          if (failLead && ref.col === 'leads') throw new Error('denied');
          writes.push({ col: ref.col, id: ref.id, patch });
          if (ref.col === 'leads' && store[ref.id]) Object.assign(store[ref.id], patch);
        },
        serverTimestamp: () => 'TS',
      };
      const toasts = [];
      const sb = { window: win, document: { createElement: mk, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: mk('body') },
        showToast: (m, t) => toasts.push([m, t]), console: { warn() {}, error() {}, log() {} }, Object, Number, String, Math, JSON, Promise, Date };
      vm.createContext(sb);
      vm.runInContext(fns.join('\n') + '\nthis.__open = _openLoggedEstimateEditor;', sb);
      sb.__open(est);
      const amountIn = els.find((e) => e.id === 'logged-est-amount');
      const save = els.find((e) => e.id === 'logged-est-save');
      amountIn.value = amount;
      await save.h.click();
      return { writes, lead: store.L, toasts };
    }
    const est = { id: 'ELOG', leadId: 'L', amount: 10700, grandTotal: 10700, type: 'Good', title: 'Good Estimate' };
    const a = await run({ lead: { primaryEstimateId: 'ELOG', jobValue: 10700 }, est, amount: '11,775' });
    ok('FIXED (was KNOWN BUG R6-2-7, logged-estimate half): re-pricing the primary logged estimate $10,700 → $11,775 moves lead.jobValue to $11,775',
      a.writes.some((w) => w.col === 'estimates' && w.patch.grandTotal === 11775) && a.writes.some((w) => w.col === 'leads' && w.id === 'L' && w.patch.jobValue === 11775) && a.lead.jobValue === 11775,
      JSON.stringify(a.writes));
    const b = await run({ lead: { primaryEstimateId: 'OTHER', jobValue: 9000 }, est, amount: '11775' });
    ok('a NON-primary logged estimate leaves the lead alone', !b.writes.some((w) => w.col === 'leads') && b.lead.jobValue === 9000);
    const signed = Object.assign({}, est, { signedPrice: { fields: { amount: 10700, grandTotal: 10700 }, totalCents: 1070000 } });
    const c = await run({ lead: { primaryEstimateId: 'ELOG', jobValue: 9999 }, est: signed, amount: '12500' });
    ok('signed price wins: a signed logged estimate re-priced to $12,500 books the SIGNED $10,700 on the lead, not the unsigned edit',
      c.writes.some((w) => w.col === 'leads' && w.patch.jobValue === 10700), JSON.stringify(c.writes));
    const e = await run({ lead: { primaryEstimateId: 'ELOG', jobValue: 10700 }, est, amount: '10700' });
    ok('an unchanged amount writes nothing to the lead', !e.writes.some((w) => w.col === 'leads'));
    const f = await run({ lead: { primaryEstimateId: 'ELOG', jobValue: 10700 }, est, amount: '11775', failLead: true });
    ok('a lead-write failure does not fail the estimate save (best-effort)', f.writes.some((w) => w.col === 'estimates') && f.toasts.some((t) => t[1] === 'success'), JSON.stringify(f.toasts));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
