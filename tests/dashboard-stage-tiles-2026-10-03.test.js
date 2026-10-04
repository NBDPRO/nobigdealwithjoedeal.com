/**
 * tests/dashboard-stage-tiles-2026-10-03.test.js
 *
 * The dashboard's six "Lead Stages" tiles (dashboard.html #dp-*). They were
 * filled from a hand-copied map in crm-pipeline.js that counted a signed
 * contract as "Estimate Sent", every production stage as "Negotiating", and
 * never counted Inspected, Claim Filed, the adjuster stages, Scope Received,
 * Estimate Sent (insurance) or the supplements at all.
 *
 * Now crm-stages.js dashboardTileFor decides, by role first and then by the
 * Simple board column. This pins:
 *   1. a fixture of EVERY built-in stage key → exactly one tile, the right one;
 *   2. crm-pipeline.js's counter sums to the lead count (nobody dropped);
 *   3. a custom/tenant stage follows its role;
 *   4. tapping a tile (crm.js filterByStage 'tile:<key>') shows the leads
 *      that tile counted;
 *   5. no tile is labelled "revenue".
 *
 * Run: node tests/dashboard-stage-tiles-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// crm-stages.js is an ES module — strip-and-vm, as crm-required-fields.test.js.
let src = read('docs/pro/js/crm-stages.js');
src = src.replace(/export\s+function\s+/g, 'function ').replace(/export\s+const\s+/g, 'const ');
src += '\nthis.__out = { S, STAGE_META, stageRole, normalizeStage, dashboardTileFor: typeof dashboardTileFor === "function" ? dashboardTileFor : null, DASHBOARD_TILES: typeof DASHBOARD_TILES !== "undefined" ? DASHBOARD_TILES : null };';
const win = {};
const sb = { console, window: win };
vm.runInNewContext(src, sb, { filename: 'crm-stages.js' });
const { STAGE_META, stageRole, normalizeStage, dashboardTileFor, DASHBOARD_TILES } = sb.__out;

console.log('\ndashboard stage tiles\n');
ok('crm-stages.js exports dashboardTileFor + DASHBOARD_TILES', typeof dashboardTileFor === 'function' && Array.isArray(DASHBOARD_TILES));
if (typeof dashboardTileFor !== 'function') { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }

const EXPECT = {
  new: 'new',
  contacted: 'working', inspected: 'working',
  claim_filed: 'working', adjuster_meeting_scheduled: 'working', adjuster_inspection_done: 'working',
  scope_received: 'estimate', estimate_submitted: 'estimate', supplement_requested: 'estimate', supplement_approved: 'estimate',
  estimate_sent_cash: 'estimate', negotiating: 'estimate', prequal_sent: 'estimate', service_quoted: 'estimate',
  loan_approved: 'production', contract_signed: 'production', service_approved: 'production',
  job_created: 'production', permit_pulled: 'production', materials_ordered: 'production',
  materials_delivered: 'production', crew_scheduled: 'production', install_in_progress: 'production',
  warranty_scheduled: 'production', warranty_repaired: 'production',
  install_complete: 'won', final_photos: 'won', deductible_collected: 'won', final_payment: 'won',
  collections: 'won', closed: 'won', warranty_claim: 'won',
  lost: 'lost',
};
const tileKeys = DASHBOARD_TILES.map((t) => t.key);
const allKeys = Object.keys(STAGE_META);
ok('the fixture covers every built-in stage key', allKeys.every((k) => k in EXPECT) && Object.keys(EXPECT).every((k) => allKeys.includes(k)),
  'missing from fixture: ' + allKeys.filter((k) => !(k in EXPECT)).join(', '));
allKeys.forEach((k) => {
  const got = dashboardTileFor(k);
  ok(k + ' → ' + EXPECT[k], got === EXPECT[k] && tileKeys.includes(got), 'got ' + got);
});
ok('six tiles, unique keys', tileKeys.length === 6 && new Set(tileKeys).size === 6);
ok('no tile is labelled revenue', DASHBOARD_TILES.every((t) => !/revenue/i.test(t.label)));
ok('a signed contract is NOT counted as an estimate', dashboardTileFor('contract_signed') !== 'estimate');
ok('legacy display names normalize ("Complete" → won, "Estimate Sent" → estimate)',
  dashboardTileFor('Complete') === 'won' && dashboardTileFor('Estimate Sent') === 'estimate');

// Custom / tenant stages follow the role the tenant declared.
ok('a custom WON stage counts as Won', dashboardTileFor('custom_paid', () => 'won') === 'won');
ok('a custom LOST stage counts as Lost', dashboardTileFor('custom_ghosted', () => 'lost') === 'lost');
ok('a custom JOB stage counts as Signed & Building', dashboardTileFor('custom_dumpster', () => 'job') === 'production');
ok('a custom ACTIVE stage counts as Working (not New)', dashboardTileFor('custom_followup', () => 'active') === 'working');
ok('a tenant role override wins (contract_signed made won → Won)', dashboardTileFor('contract_signed', (k) => (k === 'contract_signed' ? 'won' : stageRole(k))) === 'won');
ok('crm-stages publishes the classifier on window for plain scripts', win.dashboardTileFor === dashboardTileFor);

// crm-pipeline.js counter: extract the function and run it.
const cp = read('docs/pro/js/crm-pipeline.js');
const m = cp.match(/function _dashboardTileCounts\(all\) \{[\s\S]*?\n\}\n/);
ok('crm-pipeline.js has _dashboardTileCounts', !!m);
if (m) {
  const w = { dashboardTileFor, stageRole, normalizeStage };
  const ctx = { window: w };
  vm.runInNewContext(m[0] + '\nthis.f = _dashboardTileCounts;', ctx);
  const leads = allKeys.map((k, i) => ({ id: 'L' + i, stage: k }));
  leads.push({ id: 'C1', stage: 'custom_paid', _stageKey: 'custom_paid', _stageRole: 'won' });
  const c = ctx.f(leads);
  const sum = Object.values(c).reduce((a, b) => a + b, 0);
  ok('every lead counted exactly once (sum = lead count)', sum === leads.length, JSON.stringify(c));
  const want = { new: 0, working: 0, estimate: 0, production: 0, won: 0, lost: 0 };
  allKeys.forEach((k) => { want[EXPECT[k]]++; });
  want.won++;
  ok('per-tile counts match the fixture', JSON.stringify(c) === JSON.stringify(want), JSON.stringify(c) + ' vs ' + JSON.stringify(want));
  ok('Inspected + insurance stages are counted (Working tile ≥ 5)', c.working >= 5);
  ok('crm-pipeline sets every tile from the counter', /setEl\('dp-ct', _stageCounts\.working\)/.test(cp) && /setEl\('dp-es', _stageCounts\.estimate\)/.test(cp)
    && /setEl\('dp-ng', _stageCounts\.production\)/.test(cp) && /setEl\('dp-won', _stageCounts\.won\)/.test(cp));
}

// crm.js filterByStage('tile:…') → the same leads the tile counted.
const crm = read('docs/pro/js/crm.js');
const fm = crm.match(/window\.filterByStage = function\(stageKey\) \{[\s\S]*?\n\};\n/);
ok('crm.js filterByStage present', !!fm);
if (fm) {
  let shown = null;
  const w = { dashboardTileFor, stageRole, normalizeStage, _leads: allKeys.map((k, i) => ({ id: 'L' + i, stage: k })) };
  const ctx = { window: w, document: { getElementById: () => null }, renderLeads: (_a, f) => { shown = f; } };
  vm.runInNewContext(fm[0], ctx);
  w.filterByStage('tile:working');
  const wantIds = allKeys.filter((k) => EXPECT[k] === 'working');
  ok('tapping the Working tile shows exactly its leads', Array.isArray(shown) && shown.length === wantIds.length && shown.every((l) => EXPECT[l.stage] === 'working'));
  w.filterByStage('closed');
  ok('a plain stage key still filters by that stage', Array.isArray(shown) && shown.length === 1 && shown[0].stage === 'closed');
}

const dash = read('docs/pro/dashboard.html');
const tiles = (dash.match(/data-action="filterByStage" data-stage="([^"]+)"/g) || []).map((s) => s.replace(/.*data-stage="([^"]+)"/, '$1'));
ok('dashboard tiles tap through to their tile filter', ['tile:new', 'tile:working', 'tile:estimate', 'tile:production', 'tile:won', 'tile:lost'].every((t) => tiles.includes(t)), tiles.join(','));
ok('the old mislabelled tiles are gone', !/stage-name">Negotiating</.test(dash) && !/stage-name">Est\. Sent</.test(dash));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
