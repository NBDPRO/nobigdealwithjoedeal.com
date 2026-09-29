/**
 * tests/analytics-stage-labels-2026-09-28.test.js
 *
 * CRM sweep R14 (emulator, 2026-09-28) — Analytics & Leaderboard → "Leads by
 * Stage" panel (docs/pro/js/analytics-kpi.js).
 *
 * THE BUG: the panel labelled bars from a hand-written map that predates the
 * stage-key migration, so current keys fell through to their raw text — the
 * emulator panel read "contract signed", "estimate sent cash" next to
 * "Install Complete" / "Closed Won", and a tenant's custom stage would show
 * as "custom abc123".
 *
 * THE FIX: the board's own label (window.STAGE_META, tenant-aware) first; the
 * old map and the de-underscored key only as fallbacks.
 *
 * Runs the REAL analytics-kpi.js in a vm and renders the dashboard HTML.
 * Break-test: against main the label cases go red.
 *
 * Zero deps. Run: node tests/analytics-stage-labels-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Load the real file, exposing its internal renderer for the test only.
let src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/analytics-kpi.js'), 'utf8');
const hook = '  window.AnalyticsKPI = {';
ok('analytics-kpi.js still defines window.AnalyticsKPI', src.includes(hook));
src = src.split(hook).join('  window.__renderDashboardHTML = renderDashboardHTML;\n' + hook);
const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' } };
win.window = win;
vm.runInNewContext(src, {
  window: win,
  document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return noop(); }, body: noop(), head: noop(), readyState: 'complete' },
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, Date, Math, JSON, Object,
}, { filename: 'analytics-kpi.js' });

// The board's labels, as dashboard-bootstrap publishes them (incl. a tenant's
// custom stage).
win.STAGE_META = {
  new: { label: 'New Lead' }, contract_signed: { label: 'Contract Signed' },
  estimate_sent_cash: { label: 'Est. Sent' }, install_complete: { label: 'Install Done' },
  custom_tearoff: { label: 'Tear-off Day' },
};
const now = new Date().toISOString();
const leads = ['contract_signed', 'estimate_sent_cash', 'install_complete', 'custom_tearoff', 'new']
  .map((stage, i) => ({ id: 'L' + i, stage, createdAt: now, source: 'referral' }));
const CFA = win.AnalyticsKPI._test.computeFullAnalytics;
const m = CFA({ leads, knocks: [], photos: [], estimates: [], expenses: [], invoices: [] });
const el = { innerHTML: '' };
win.__renderDashboardHTML(el, m);
const html = el.innerHTML;
const panel = html.slice(html.indexOf('Leads by Stage'), html.indexOf('Leads by Source'));
const labels = (panel.match(/class="ak-bar-label" title="([^"]*)"/g) || []).map((s) => s.replace(/.*title="/, '').replace(/"$/, ''));

console.log('LEADS BY STAGE — the board\'s labels');
ok('contract_signed reads "Contract Signed" (was "contract signed")', labels.includes('Contract Signed'), JSON.stringify(labels));
ok('estimate_sent_cash reads "Est. Sent" (was "estimate sent cash")', labels.includes('Est. Sent'), JSON.stringify(labels));
ok('a tenant custom stage reads its own label (was "custom tearoff")', labels.includes('Tear-off Day'), JSON.stringify(labels));
ok('no bar shows a raw key', !labels.some((l) => /_|^[a-z]+ [a-z]+/.test(l)), JSON.stringify(labels));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
