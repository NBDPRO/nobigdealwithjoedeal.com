/**
 * tests/r2-money-parse-multijob-2026-10-06.test.js
 *
 * Review round 2 minor fixes (nbd-content/review-r2-2026-10-06.md, Jo approved
 * 2026-10-06):
 *
 *   C1  ONE money reader for a stored jobValue (customer-estimate-rows.js
 *       moneyValue): legacy text "$45,000" / "45,000" read $45,000, $45 or $0
 *       depending on the screen. Kanban cards / column totals / header, Home
 *       KPI tiles, the customer page's job value, agent crm_summary, the
 *       weekly digest and the Team Leaderboard widget now all read 45000.
 *       Plus scripts/normalize-legacy-jobvalue.js (dry-run by default).
 *   C2  (R2-2-7) a customer's second job: the kanban header, agent
 *       crm_summary, the weekly digest and the money dashboard count every
 *       job, the way the Home KPI tiles do (jobs-store.js recordsFor).
 *   C3  labels: the Stripe ledger panel says "Stripe gross (card)", not
 *       "Collected"; the Team Leaderboard widget says "Booked (all time)".
 *
 * The real code runs (require / vm / extracted block) on one fixture, and an
 * agreement check asserts every surface reads the same open pipeline.
 * Pure Node: node tests/r2-money-parse-multijob-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
async function sec(name, fn) {
  try { await fn(); } catch (e) { ok(name + ' — threw: ' + (e && e.message), false); }
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

const CER = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));
const JS = require(path.join(ROOT, 'docs', 'pro', 'js', 'jobs-store.js'));

// ── The fixture every surface reads ────────────────────────────────────
// A: open estimate, legacy TEXT jobValue "$45,000", a SECOND open job $8,000.
// B: closed / won ($12,000) — closed money, not pipeline. C: lost ($5,000).
// Open pipeline everywhere = 45,000 + 8,000 = 53,000.
const LEADS = () => [
  { id: 'A', userId: 'u1', stage: 'estimate_submitted', jobValue: '$45,000', activeJobId: 'j1' },
  { id: 'B', userId: 'u1', stage: 'closed', stageRole: 'won', jobValue: 12000, activeJobId: 'j1' },
  { id: 'C', userId: 'u1', stage: 'lost', jobValue: 5000 },
];
const JOBS = {
  A: [{ id: 'j1', stage: 'estimate_submitted', jobValue: 45000, createdAt: 1 }, { id: 'j2', stage: 'new', jobValue: 8000, createdAt: 2 }],
  B: [{ id: 'j1', stage: 'closed', stageRole: 'won', jobValue: 12000, createdAt: 1 }],
};
const WANT_PIPE = 53000;
const fakeNBDJobs = () => ({ recordsFor: (leads) => JS.records(leads, (id) => JOBS[id] || []) });
const pipeBySurface = {};

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nC1 — one money reader');
  // ════════════════════════════════════════════════════════════════════
  await sec('C1 moneyValue', async () => {
    const M = CER.moneyValue;
    ok('moneyValue is exported', typeof M === 'function');
    ok('"$45,000" → 45000 (parseFloat said NaN → $0)', M('$45,000') === 45000);
    ok('"45,000" → 45000 (parseFloat said 45)', M('45,000') === 45000);
    ok('"45000.50" → 45000.5, 12000 → 12000', M('45000.50') === 45000.5 && M(12000) === 12000);
    ok('"", null, undefined, "TBD" → 0, never NaN', [M(''), M(null), M(undefined), M('TBD')].every((v) => v === 0));
    ok('functions/ and docs/pro/js/ customer-estimate-rows.js stay byte-identical',
      rd('functions/customer-estimate-rows.js') === rd('docs/pro/js/customer-estimate-rows.js'));
  });

  await sec('C1 normalization script', async () => {
    const S = require(path.join(ROOT, 'scripts', 'normalize-legacy-jobvalue.js'));
    const P = S.planJobValue;
    ok('a number or a missing field is skipped', P(45000).action === 'skip' && P(undefined).action === 'skip' && P(null).action === 'skip');
    ok('"$45,000" and "45,000" convert to 45000', P('$45,000').action === 'convert' && P('$45,000').value === 45000 && P('45,000').value === 45000);
    ok('"12000.555" converts to cents precision 12000.56', P('12000.555').value === 12000.56);
    ok('"" / "TBD" / an object are unparseable and left as is (nothing guessed, nothing erased)',
      P('').action === 'unparseable' && P('TBD').action === 'unparseable' && P({ a: 1 }).action === 'unparseable');
    const src = rd('scripts/normalize-legacy-jobvalue.js');
    ok('dry-run by default; --apply refuses without --yes; writes only jobValue with merge',
      /const APPLY = args\.includes\('--apply'\)/.test(src) && /if \(APPLY && !YES\)/.test(src)
        && /batch\.set\(doc\.ref, \{ jobValue: plan\.value \}, \{ merge: true \}\)/.test(src) && /if \(APPLY\) \{ batch\.set/.test(src));
    ok('it parses with the SAME reader the screens use', /require\('\.\.\/functions\/customer-estimate-rows'\)/.test(src) && /moneyValue\(v\)/.test(src));
    ok('requiring it (for this test) touches no database', /if \(require\.main === module\) main\(\)/.test(src));
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC1 + C2 — every surface on one fixture');
  // ════════════════════════════════════════════════════════════════════

  // Home KPI tiles (the reference: already counted every job).
  await sec('Home KPI', async () => {
    const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
    const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' } };
    win.window = win;
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop(), readyState: 'complete' }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Object };
    vm.createContext(sb);
    ['numbers-logic.js', 'analytics-kpi.js'].forEach((f) => vm.runInContext(rd('docs/pro/js/' + f), sb, { filename: f }));
    win.NBDCustomerEstimateRows = CER;
    win.NBDJobs = fakeNBDJobs();
    win._leads = LEADS(); win._estimates = [];
    const k = win.computeKPIs();
    pipeBySurface.homeKpi = k.pipelineValue;
    ok('Home KPI pipeline counts the second job AND reads "$45,000" as 45000 → $53,000', k.pipelineValue === WANT_PIPE, 'got ' + k.pipelineValue);
    win.NBDCustomerEstimateRows = undefined;
    win._leads = [{ id: 'X', stage: 'new', jobValue: '45,000' }]; win.NBDJobs = undefined;
    ok('without customer-estimate-rows.js on the page the fallback still reads "45,000" as 45000 (not 45)', win.computeKPIs().pipelineValue === 45000);
  });

  // Kanban header (renderLeads stat block) + card / column readers.
  await sec('Kanban', async () => {
    const src = rd('docs/pro/js/crm-pipeline.js');
    const a = src.indexOf('  // Revenue calcs');
    const b = src.indexOf('  // Count prospects', a);
    ok('anchor: the kanban header stat block is found', a !== -1 && b !== -1);
    const mAt = src.indexOf('function _crmMoney(v)');
    const money = mAt === -1 ? null : new Function('window', 'return function (v) ' + braceBlock(src, mAt) + ';');
    ok('anchor: _crmMoney is found', !!money);
    const win = {
      NBDCustomerEstimateRows: CER, NBDJobs: fakeNBDJobs(),
      isJobStage: (sk) => ['contract_signed', 'install_in_progress', 'closed'].includes(sk),
      stageRole: (sk) => (sk === 'lost' ? 'lost' : 'active'),
    };
    const run = new Function('all', 'window', '_crmMoney',
      src.slice(a, b) + '\nreturn { pipeVal, closedRev, approvedCount };');
    const r = run(LEADS(), win, money ? money(win) : null);
    pipeBySurface.kanbanHeader = r.pipeVal;
    ok('FIXED (was KNOWN BUG R2-2-7): the kanban header Pipeline counts the second job → $53,000', r.pipeVal === WANT_PIPE, JSON.stringify(r));
    ok('the kanban header Closed total stays $12,000 (the lost $5,000 is in neither)', r.closedRev === 12000);
    const r0 = run(LEADS(), Object.assign({}, win, { NBDJobs: undefined }), money ? money(win) : null);
    ok('before jobs load (no NBDJobs) the header still reads "$45,000" as 45000', r0.pipeVal === 45000, JSON.stringify(r0));
    const m = money ? money({}) : null;
    ok('_crmMoney without customer-estimate-rows.js: "$45,000" → 45000, "" → 0', !!m && m('$45,000') === 45000 && m('') === 0);
    const noRaw = src.slice(src.indexOf('function buildCard')).slice(0, 4000);
    ok('the card value, column totals and hidden-stage total read through _crmMoney',
      /const val\s+= _crmMoney\(l\.jobValue\)/.test(src)
        && (src.match(/reduce\(\(s, l\) => s \+ _crmMoney\(l && l\.jobValue\), 0\)/g) || []).length === 2
        && !/parseFloat\(l\.jobValue/.test(src) && !/Number\(l && l\.jobValue\)/.test(src) && noRaw.length > 0);
  });

  // Agent crm_summary (pure) + its caller loads the jobs.
  await sec('crm_summary', async () => {
    const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
    const s = L.summary(LEADS(), '2026-10-06', JOBS);
    pipeBySurface.crmSummary = s.open_pipeline_value_projected;
    ok('FIXED (was KNOWN BUG R2-2-7): crm_summary open pipeline counts the second job and the text value → $53,000',
      s.open_pipeline_value_projected === WANT_PIPE, JSON.stringify(s));
    ok('crm_summary customers stay a count of CUSTOMERS (3), not jobs', s.customers === 3);
    ok('no jobs map → each customer once (the old number, but "$45,000" now reads 45000)', L.summary(LEADS(), '2026-10-06').open_pipeline_value_projected === 45000);
    ok('list_leads / lead rows report job_value 45000 for "$45,000"',
      (L.listLeads(LEADS(), {}, Date.now()).find((x) => x.lead_id === 'A') || {}).job_value === 45000);
    const mcp = rd('functions/agent-mcp.js');
    const at = mcp.indexOf("if (name === 'crm_summary')");
    const blk = at === -1 ? '' : braceBlock(mcp, at);
    ok('the crm_summary tool loads the company\'s jobs and passes them to summary()',
      /companyJobsByLead\(company\)/.test(blk || '') && /L\.summary\(leads, today, jobsByLead\)/.test(blk || ''));
    const fn = mcp.indexOf('async function companyJobsByLead(companyId)');
    const body = fn === -1 ? '' : braceBlock(mcp, fn);
    ok('companyJobsByLead reads collectionGroup(\'jobs\') by companyId and userId and fails soft (null)',
      /collectionGroup\('jobs'\)\.where\(f, '==', companyId\)/.test(body) && /\['companyId', 'userId'\]/.test(body) && /catch \(e\) \{\s*return null;/.test(body));
  });

  // Weekly digest — the real aggregateUserMetrics on a fake db.
  await sec('weekly digest', async () => {
    const stubs = {
      './integrations/heartbeat': { onSchedule: (o, f) => f },
      'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
      'firebase-admin/firestore': { FieldPath: { documentId: () => '__name__' }, getFirestore: () => ({}), Timestamp: { fromMillis: (m) => ({ m }) }, FieldValue: {} },
      resend: { Resend: function () {} },
    };
    const orig = Module._load;
    Module._load = function (req, parent, isMain) {
      if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
      return orig.apply(this, arguments);
    };
    let WD;
    try {
      delete require.cache[require.resolve(path.join(ROOT, 'functions', 'weekly-digest.js'))];
      WD = require(path.join(ROOT, 'functions', 'weekly-digest.js'));
    } finally { Module._load = orig; }
    ok('anchor: aggregateUserMetrics is exported for tests', typeof WD._aggregateUserMetrics === 'function');
    const snapOf = (docs) => ({ docs, size: docs.length, empty: !docs.length });
    const leadDocs = LEADS().map((l) => ({ id: l.id, data: () => Object.assign({}, l) }));
    const jobDocs = [];
    Object.keys(JOBS).forEach((lid) => JOBS[lid].forEach((j) => jobDocs.push({ id: j.id, ref: { parent: { parent: { id: lid } } }, data: () => Object.assign({}, j) })));
    const q = (docs) => { const o = { where: () => o, orderBy: () => o, limit: () => o, select: () => o, startAfter: () => o, get: async () => snapOf(docs) }; return o; };
    const db = { collection: (n) => q(n === 'leads' ? leadDocs : []), collectionGroup: (n) => q(n === 'jobs' ? jobDocs : []) };
    const m = await WD._aggregateUserMetrics(db, 'u1');
    pipeBySurface.weeklyDigest = m.activePipelineValue;
    ok('FIXED (was KNOWN BUG R2-2-7): the weekly digest active pipeline counts the second job and the text value → $53,000',
      m.activePipelineValue === WANT_PIPE, 'got ' + m.activePipelineValue);
    const dbNoJobs = { collection: db.collection, collectionGroup: () => ({ where() { throw new Error('index'); } }) };
    const m2 = await WD._aggregateUserMetrics(dbNoJobs, 'u1');
    ok('a failed jobs read falls back to each customer once (no crash, no digest lost)', m2.activePipelineValue === 45000, 'got ' + m2.activePipelineValue);
  });

  // Money dashboard — won-job contract value counts every won job.
  await sec('money dashboard', async () => {
    const win = { addEventListener() {}, location: { pathname: '/pro/dashboard' } };
    win.window = win;
    const sandbox = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
    vm.runInNewContext(rd('docs/pro/js/money-dashboard.js'), sandbox, { filename: 'money-dashboard.js' });
    const MD = win.MoneyDashboard;
    const year = new Date().getFullYear();
    const leads = [{ id: 'W', stage: 'closed', _stageRole: 'won', jobValue: '$10,000', activeJobId: 'j1' }];
    const recs = JS.records(leads, () => [{ id: 'j1', stage: 'closed' }, { id: 'j2', stage: 'closed', stageRole: 'won', jobValue: 8000 }]);
    recs.forEach((r) => { if (r._jobId) r._stageRole = 'won'; });
    const expenses = [{ leadId: 'W', costType: 'direct', amountCents: 900000, date: new Date(year, 5, 1) }];
    const m = MD.computePnL({ leads, jobRecs: recs, expenses, year });
    ok('FIXED (was KNOWN BUG R2-2-7): won contract value = both won jobs ($10,000 text + $8,000) against the customer\'s costs',
      m.wonContractCents === 1800000 && m.wonDirectCents === 900000 && m.costedJobs === 2 && m.grossMargin === 50, JSON.stringify({ c: m.wonContractCents, d: m.wonDirectCents, n: m.costedJobs, g: m.grossMargin }));
    const m0 = MD.computePnL({ leads, expenses, year });
    ok('no jobRecs → the lead alone, "$10,000" read as 10000 (was $0 — parseFloat("$10,000") is NaN)', m0.wonContractCents === 1000000, String(m0.wonContractCents));
    const src = rd('docs/pro/js/money-dashboard.js');
    ok('the loader hands computePnL the job records (NBDJobs.recordsFor)', /jobRecs: \(window\.NBDJobs && typeof window\.NBDJobs\.recordsFor === 'function'\) \? window\.NBDJobs\.recordsFor\(_leadsNow\) : null/.test(src));
  });

  // Team Leaderboard widget — money reader + label.
  await sec('leaderboard widget', async () => {
    function makeEl() {
      return { _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = String(v); }, style: {}, dataset: {},
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, remove() {} };
    }
    const store = new Map();
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    const document = { getElementById: () => makeEl(), createElement: makeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: makeEl(), head: makeEl() };
    const win = { _user: { uid: 'u1', displayName: 'Jo' }, addEventListener() {}, matchMedia: () => ({ matches: false }), showToast() {},
      NBDCustomerEstimateRows: CER, NBDJobs: fakeNBDJobs(),
      stageRole: (sk) => (sk === 'contract_signed' ? 'won' : sk === 'lost' ? 'lost' : 'active') };
    win.window = win;
    const sandbox = Object.assign({ window: win, document, localStorage, console: { log() {}, warn() {}, error() {}, info() {} },
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Promise, Array, Object, String, Number, Set, Map, isNaN, parseFloat, parseInt,
      fetch: () => Promise.reject(new Error('no network')), navigator: { userAgent: 'node' }, location: { hash: '', pathname: '/pro/dashboard' } }, win);
    vm.createContext(sandbox);
    vm.runInContext(rd('docs/pro/js/widgets.js'), sandbox, { filename: 'widgets.js' });
    const W = win.NBDWidgets && win.NBDWidgets.WIDGETS;
    const lb = W && W.find((w) => w.id === 'team-leaderboard');
    ok('anchor: the team-leaderboard widget is registered', !!lb);
    win._leads = [{ id: 'S', userId: 'u1', stage: 'contract_signed', jobValue: '$45,000' }];
    win.NBDJobs = { recordsFor: (l) => l };
    const el = makeEl();
    lb.render(el);
    ok('the widget reads "$45,000" as $45.0k (was $0.0k)', /\$45\.0k/.test(el.innerHTML), el.innerHTML.slice(0, 300));
    ok('the widget is labelled "Booked (all time)"', /Booked \(all time\)/.test(el.innerHTML));
    const src = rd('docs/pro/js/widgets.js');
    const at = src.indexOf("{id:'team-leaderboard'");
    const blk = at === -1 ? '' : src.slice(at, src.indexOf("{id:'quick-add-lead'", at));
    ok('its comment no longer claims it is the Leaderboard page\'s aggregation (that page ranks money COLLECTED)',
      !/Same aggregation the real Leaderboard view uses/.test(blk) && /NOT the\s*\n?\s*\/\/\s*Leaderboard page's ranking|NOT the[\s\S]{0,40}Leaderboard page's ranking/.test(blk));
  });

  // Customer page job value.
  await sec('customer page', async () => {
    const src = rd('docs/pro/js/customer-bootstrap.module.js');
    ok('the customer page job value reads through moneyValue',
      /const _jvNum = window\.NBDCustomerEstimateRows\?\.moneyValue\s*\n?\s*\? window\.NBDCustomerEstimateRows\.moneyValue\(lead\.jobValue\)/.test(src)
        && /getElementById\('infoJobValue'\)\.textContent = _jvNum \?/.test(src));
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\nAgreement — one open pipeline on every surface');
  // ════════════════════════════════════════════════════════════════════
  const vals = Object.values(pipeBySurface);
  ok('Home KPI, kanban header, crm_summary and the weekly digest all read $53,000 for the same book',
    vals.length === 4 && vals.every((v) => v === WANT_PIPE), JSON.stringify(pipeBySurface));

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC3 — labels');
  // ════════════════════════════════════════════════════════════════════
  await sec('labels', async () => {
    const p = rd('docs/pro/js/stripe-ledger-panel.js');
    ok('Stripe ledger panel: "Stripe gross (card) — this month", no "Collected through Stripe"',
      p.includes('Stripe gross (card) — this month') && !p.includes('Collected through Stripe'));
    ok('Stripe sync preview tile: "Stripe gross (card)", no bare "Collected" label',
      p.includes('<div class="sl-lbl">Stripe gross (card)</div>') && !p.includes('<div class="sl-lbl">Collected</div>'));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
