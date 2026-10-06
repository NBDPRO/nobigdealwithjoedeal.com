/**
 * tests/contract-signed-is-booked-2026-10-06.test.js
 *
 * Jo, 2026-10-06: a signed contract is BOOKED, not open pipeline. The kanban
 * header already split it that way (crm-pipeline.js: isJobStage || role won
 * / job → Closed). The Home KPI tiles, the Analytics view, agent crm_summary
 * and the weekly digest counted contract_signed (and the job stages
 * job_created…install_in_progress, in the digest) as open pipeline. They now
 * use the shared sale test — numbers-logic.js isSale (client) and
 * functions/stage-roles.js isSale (server): won, in production, or contract
 * signed, persisted stageRole first so a tenant's custom won stage counts.
 *
 * The real code runs (vm / require / the extracted kanban block with the real
 * crm-stages.js) on one fixture, and an agreement check asserts every surface
 * reads the same open pipeline and the same booked set.
 * Pure Node: node tests/contract-signed-is-booked-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
async function sec(name, fn) {
  try { await fn(); } catch (e) { ok(name + ' — threw: ' + (e && e.stack || e), false); }
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

// ── The fixture every surface reads ────────────────────────────────────
const NOW = Date.now();
const JUST_NOW = NOW - 60 * 1000;
const DAYS_AGO_40 = NOW - 40 * 86400000; // always an earlier month and week
const LEADS = () => [
  // O: the only deal still in play.
  { id: 'O', userId: 'u1', stage: 'estimate_submitted', jobValue: 40000, stageStartedAt: JUST_NOW },
  // S: signed this week — booked, and a win this week / month.
  { id: 'S', userId: 'u1', stage: 'contract_signed', jobValue: 20000, closedAt: JUST_NOW, stageStartedAt: JUST_NOW },
  // S2: signed, persisted role still 'active' (stamped before the rule) — still booked.
  { id: 'S2', userId: 'u1', stage: 'contract_signed', stageRole: 'active', _stageRole: 'active', jobValue: 3000, closedAt: DAYS_AGO_40, stageStartedAt: DAYS_AGO_40 },
  // P: signed 40 days ago, moved to Permit Pulled this week — booked, NOT a new win.
  { id: 'P', userId: 'u1', stage: 'permit_pulled', jobValue: 15000, closedAt: DAYS_AGO_40, stageStartedAt: JUST_NOW },
  // W: closed / won this week.
  { id: 'W', userId: 'u1', stage: 'closed', jobValue: 12000, closedAt: JUST_NOW, stageStartedAt: JUST_NOW },
  // C: a tenant's custom won-role stage — booked.
  { id: 'C', userId: 'u1', stage: 'roof_booked', stageRole: 'won', _stageRole: 'won', jobValue: 7000, closedAt: JUST_NOW, stageStartedAt: JUST_NOW },
  // L: lost — in neither bucket.
  { id: 'L', userId: 'u1', stage: 'lost', jobValue: 5000, stageStartedAt: JUST_NOW },
];
const WANT_PIPE = 40000;
const WANT_BOOKED = 20000 + 3000 + 15000 + 12000 + 7000; // 57,000
const pipeBySurface = {};

(async () => {
  const stages = await import(pathToFileURL(path.join(ROOT, 'docs', 'pro', 'js', 'crm-stages.js')).href);

  // ════════════════════════════════════════════════════════════════════
  console.log('\nThe shared sale test (client + server agree)');
  // ════════════════════════════════════════════════════════════════════
  await sec('sale test', async () => {
    const SR = require(path.join(ROOT, 'functions', 'stage-roles.js'));
    const N = require(path.join(ROOT, 'docs', 'pro', 'js', 'numbers-logic.js'));
    const want = { O: false, S: true, S2: true, P: true, W: true, C: true, L: false };
    LEADS().forEach((l) => {
      ok(`${l.id} (${l.stage}) booked=${want[l.id]} on server and client`,
        SR.isSale(l) === want[l.id] && N.isSale(l) === want[l.id], `server ${SR.isSale(l)} client ${N.isSale(l)}`);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\nKanban header (the reference)');
  // ════════════════════════════════════════════════════════════════════
  await sec('Kanban', async () => {
    const src = rd('docs/pro/js/crm-pipeline.js');
    const a = src.indexOf('  // Revenue calcs');
    const b = src.indexOf('  // Count prospects', a);
    ok('anchor: the kanban header stat block is found', a !== -1 && b !== -1);
    const win = { isJobStage: stages.isJobStage, stageRole: stages.stageRole };
    const run = new Function('all', 'window', '_crmMoney', src.slice(a, b) + '\nreturn { pipeVal, closedRev };');
    const r = run(LEADS(), win, (v) => Number(v) || 0);
    pipeBySurface.kanbanHeader = r.pipeVal;
    ok('kanban header: pipeline $40,000, closed $57,000', r.pipeVal === WANT_PIPE && r.closedRev === WANT_BOOKED, JSON.stringify(r));
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\nHome KPI tiles + Analytics view (analytics-kpi.js)');
  // ════════════════════════════════════════════════════════════════════
  const loadKpi = (withNumbers) => {
    const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
    const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' } };
    win.window = win;
    const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop(), readyState: 'complete' }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Object };
    vm.createContext(sb);
    (withNumbers ? ['numbers-logic.js', 'analytics-kpi.js'] : ['analytics-kpi.js'])
      .forEach((f) => vm.runInContext(rd('docs/pro/js/' + f), sb, { filename: f }));
    win.stageRole = stages.stageRole;
    win._leads = LEADS(); win._estimates = [];
    return win;
  };
  await sec('Home KPI', async () => {
    const win = loadKpi(true);
    const k = win.computeKPIs();
    pipeBySurface.homeKpi = k.pipelineValue;
    ok('Active Pipeline excludes signed contracts and jobs → $40,000', k.pipelineValue === WANT_PIPE, 'got ' + k.pipelineValue);
    ok('closed this month = the 3 closed this month (S signed, W won, C custom won); P was signed 40 days ago',
      k.closedThisMonthCount === 3 && k.monthlyRevenue === 39000, JSON.stringify({ n: k.closedThisMonthCount, rev: k.monthlyRevenue }));
    ok('avg deal size = every booked deal ($57,000 / 5)', k.avgDealSize === WANT_BOOKED / 5, 'got ' + k.avgDealSize);
    const k0 = loadKpi(false).computeKPIs();
    ok('without numbers-logic.js on the page the fallback applies the same rule', k0.pipelineValue === WANT_PIPE, 'got ' + k0.pipelineValue);
  });
  await sec('Analytics view', async () => {
    const win = loadKpi(true);
    const src = rd('docs/pro/js/analytics-kpi.js');
    ok('anchor: computeFullAnalytics exists', /function computeFullAnalytics\(data\)/.test(src));
    const fn = win.AnalyticsKPI && win.AnalyticsKPI._test && win.AnalyticsKPI._test.computeFullAnalytics;
    if (typeof fn !== 'function') { ok('computeFullAnalytics is reachable for the test', false); return; }
    const m = fn({ leads: LEADS(), estimates: [], invoices: [], knocks: [], photos: [], expenses: [] });
    ok('Analytics pipeline $40,000 and avg deal over the 5 booked deals',
      m.pipelineValue === WANT_PIPE && m.avgDealSize === WANT_BOOKED / 5, JSON.stringify({ p: m.pipelineValue, avg: m.avgDealSize, won: m.wonCount }));
    ok('Analytics wonCount (close rate) counts the same 5', m.wonCount === 5);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\nAgent crm_summary');
  // ════════════════════════════════════════════════════════════════════
  await sec('crm_summary', async () => {
    const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
    const s = L.summary(LEADS(), '2026-10-06');
    pipeBySurface.crmSummary = s.open_pipeline_value_projected;
    ok('crm_summary open pipeline excludes signed contracts, jobs and custom won → $40,000',
      s.open_pipeline_value_projected === WANT_PIPE, JSON.stringify(s));
    ok('by_stage still lists contract_signed (2) and the customer count is every lead (7)',
      s.by_stage.contract_signed === 2 && s.customers === 7);
    const fu = L.summary([{ id: 'F', stage: 'contract_signed', followUp: '2026-10-01', jobValue: 1 }], '2026-10-06');
    ok('a signed job still counts its overdue follow-up (production follow-ups are real)', fu.followups_overdue === 1);
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\nWeekly digest');
  // ════════════════════════════════════════════════════════════════════
  await sec('weekly digest', async () => {
    const stubs = {
      './integrations/heartbeat': { onSchedule: (o, f) => f },
      'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
      'firebase-admin/firestore': { FieldPath: { documentId: () => '__name__' }, getFirestore: () => ({}), Timestamp: { fromMillis: (m) => ({ m }) }, FieldValue: {} },
      resend: { Resend: function () {} },
    };
    const orig = Module._load;
    Module._load = function (req) {
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
    const q = (docs) => { const o = { where: () => o, orderBy: () => o, limit: () => o, select: () => o, startAfter: () => o, get: async () => snapOf(docs) }; return o; };
    const db = { collection: (n) => q(n === 'leads' ? leadDocs : []), collectionGroup: () => q([]) };
    const m = await WD._aggregateUserMetrics(db, 'u1');
    pipeBySurface.weeklyDigest = m.activePipelineValue;
    ok('digest active pipeline excludes signed contracts and jobs → $40,000', m.activePipelineValue === WANT_PIPE, 'got ' + m.activePipelineValue);
    ok('digest "won this week" = S, W, C (3, $39,000): a signed contract is a win, a job signed 40 days ago is not a new one',
      m.wonCount === 3 && m.wonRevenue === 39000, JSON.stringify({ won: m.wonCount, rev: m.wonRevenue }));
    ok('lost this week stays 1', m.lostCount === 1);
    const src = rd('functions/weekly-digest.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('no hand-kept WON_STAGES / TERMINAL_STAGES lists remain (the shared helper decides)',
      !/WON_STAGES|TERMINAL_STAGES/.test(src) && /stageRoles\.isSale\(l\)/.test(src));
  });

  // ════════════════════════════════════════════════════════════════════
  console.log('\nAgreement');
  // ════════════════════════════════════════════════════════════════════
  const vals = Object.values(pipeBySurface);
  ok('kanban header, Home KPI, crm_summary and the weekly digest read the same $40,000 open pipeline',
    vals.length === 4 && vals.every((v) => v === WANT_PIPE), JSON.stringify(pipeBySurface));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
