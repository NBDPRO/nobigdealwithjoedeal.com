/**
 * tests/st-f44-2026-11-08.test.js — CRM audit 2026-11-06, ST-F44.
 *
 * admin-manager.js wrote two error messages into innerHTML raw: the roster's
 * "Failed to load team: <e.message>" (loadMembers) and the analytics grid's
 * "Analytics unavailable: <e.message>" (loadAnalytics). An error message that
 * carries markup (a callable echoing input, a proxy error page) became live
 * HTML in Team Manager. Every sibling error path in the file already runs
 * escapeHTML(e.message); these two now do too.
 *
 * Lifts the REAL loadMembers, loadAnalytics and escapeHTML out of
 * admin-manager.js into a vm whose callable rejects with markup in the
 * message. Zero deps. Run: node tests/st-f44-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'admin-manager.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
function lift(sig) {
  const s = SRC.indexOf('  ' + sig);
  return s >= 0 ? SRC.slice(s, SRC.indexOf('\n  }\n', s) + 4) : '';
}
const FNS = ['async function loadMembers(', 'async function loadAnalytics(', 'function escapeHTML('].map(lift);

const EVIL = '<img src=x onerror=alert(1)>';
async function run(message) {
  const els = { adminRosterContainer: { innerHTML: '' }, adminAnalyticsGrid: { innerHTML: '' } };
  const toasts = [];
  const sb = {
    document: { getElementById: (id) => els[id] || null },
    console: { log() {}, warn() {}, error() {} },
    state: { loading: false, loaded: false, members: [] },
    callable: async () => async () => { throw new Error(message); },
    toast: (m, k) => toasts.push([m, k]),
    render() {},
  };
  vm.createContext(sb);
  vm.runInContext(FNS.join('\n') + '\nthis.loadMembers = loadMembers; this.loadAnalytics = loadAnalytics;', sb);
  await sb.loadMembers();
  await sb.loadAnalytics();
  return { els, toasts };
}

(async function main() {
  console.log('TEAM MANAGER ERROR TEXT IS ESCAPED (ST-F44)');
  ok('control: loadMembers, loadAnalytics and escapeHTML lifted from admin-manager.js', FNS.every(Boolean) && /adminRosterContainer/.test(FNS[0]) && /adminAnalyticsGrid/.test(FNS[1]));
  const r = await run(EVIL);
  const roster = r.els.adminRosterContainer.innerHTML;
  const grid = r.els.adminAnalyticsGrid.innerHTML;
  ok('the roster error still says what failed', /Failed to load team: /.test(roster), roster);
  ok('…and shows the message as text, not markup', roster.includes('&lt;img src=x onerror=alert(1)&gt;') && !roster.includes('<img'), roster);
  ok('the analytics error still says what failed', /Analytics unavailable: /.test(grid), grid);
  ok('…and shows the message as text, not markup', grid.includes('&lt;img src=x onerror=alert(1)&gt;') && !grid.includes('<img'), grid);
  ok('control: the roster failure still toasts', r.toasts.some((t) => /Could not load team roster/.test(t[0])));
  const blank = await run('');
  ok('an empty message keeps its fallback words', /Failed to load team: unknown error/.test(blank.els.adminRosterContainer.innerHTML) && /Analytics unavailable: error/.test(blank.els.adminAnalyticsGrid.innerHTML),
    blank.els.adminRosterContainer.innerHTML + ' | ' + blank.els.adminAnalyticsGrid.innerHTML);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
