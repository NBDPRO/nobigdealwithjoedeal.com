/**
 * tests/margin-floor-display-2026-11-17.test.js
 *
 * Where a rep or an owner SEES margin on an estimate, after 2026-11-17
 * (plan: documentation/projects/ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md):
 *   - the V2 builder's rollup line (estimate-v2-ui.js _marginLineHtml)
 *   - the Internal View document (estimate-finalization.js formatInternalView)
 *   - the classic estimator's Internal View panel (estimates.js buildReview)
 *
 * Each now shows margin BEFORE sales tax on the price the customer pays, says
 * "unknown" for a job with an uncosted line (the rollup used to throw on a null
 * marginPct, and a missing cost read as a perfect margin), and carries the
 * company's band only when the company has set a floor.
 *
 * Every figure here is made up.
 * Pure-Node. Run: node tests/margin-floor-display-2026-11-17.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

function loadV2(withFloorFile, profile) {
  const win = {}; win.window = win;
  win.EstimateLogic = { resolveEstimate: () => ({}), buildContext: (x) => x, MEASUREMENT_VARS: [] };
  win.EstimateBuilderV2 = { loadSettings: () => ({ countyTax: {} }), calculateAllTiers: () => ({}), calculatePerSq: () => ({}) };
  if (profile) win._companyProfile = profile;
  const sandbox = {
    window: win, console: { log() {}, warn() {}, error() {} },
    document: { createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), addEventListener() {}, getElementById: () => null, querySelector: () => null },
    Date, Math, JSON, Set, setTimeout, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
  };
  vm.createContext(sandbox);
  if (withFloorFile) vm.runInContext(read('margin-floor.js'), sandbox, { filename: 'margin-floor.js' });
  vm.runInContext(read('estimate-v2-ui.js'), sandbox, { filename: 'estimate-v2-ui.js' });
  return { line: win.EstimateV2UI._test.marginLineHtml, win };
}

const NBD = { pricing: { marginFloor: { floorPct: 30, targetPct: 35 } } };
// $10,000 before tax, $780 tax, $7,000 hard cost: 30.0% before tax; the old tax-inclusive figure read 35.1%.
const EST = { mode: 'cash', total: 10780, tax: 780, subtotal: 10000, hardCost: 7000, materialCost: 4000, laborCost: 3000, internal: { hardCost: 7000, margin: 3780, marginPct: 35.06 } };

console.log('\nThe V2 rollup line');
{
  const on = loadV2(true, NBD).line;
  const h = on(EST);
  ok('margin is shown before sales tax', /Margin before tax: <strong>30\.0%<\/strong> \(\$3,000\)/.test(h) && h.indexOf('35.1') === -1, h);
  ok('at the floor and under the target it carries the amber band', h.indexOf('<span class="ui-badge is-warn">Above your floor, under your target</span>') !== -1, h);
  ok('under the floor it carries the red band', on(Object.assign({}, EST, { hardCost: 8000 })).indexOf('<span class="ui-badge is-danger">Under your floor</span>') !== -1);
  ok('at the target it carries the green band', on(Object.assign({}, EST, { hardCost: 6000 })).indexOf('<span class="ui-badge is-success">At or above your target</span>') !== -1);
  const unk = on(Object.assign({}, EST, { costUnsetCount: 1 }));
  ok('a job with an uncosted line says unknown and shows no percentage', /Margin: <strong>unknown<\/strong>/.test(unk) && !/%/.test(unk), unk);
  ok('a null marginPct no longer throws: it is unknown', (() => { try { return /unknown/.test(on({ mode: 'cash', total: 10000, tax: 0, internal: { margin: null, marginPct: null } })); } catch (e) { return false; } })());
  ok('an insurance job shows its margin with no band', (() => { const s = on(Object.assign({}, EST, { mode: 'insurance', total: 10000, tax: 0, hardCost: 9000 })); return /10\.0%/.test(s) && s.indexOf('ui-badge') === -1; })());
  ok('the line carries no inline style', h.indexOf('style=') === -1 && unk.indexOf('style=') === -1);

  const off = loadV2(true, null).line(EST);
  ok('a company with no floor set sees the tax-free margin and no band', /30\.0%/.test(off) && off.indexOf('ui-badge') === -1, off);
  const bare = loadV2(false, NBD).line;
  ok('without margin-floor.js the builder still renders its own figure, and a null one does not throw', /35\.1%/.test(bare(EST)) && /—/.test(bare({ internal: { marginPct: null } })) && /—/.test(bare({})));
}

console.log('\nThe Internal View document');
{
  const win = {}; win.window = win; win._companyProfile = NBD;
  const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {} }) }, Date, Math, JSON, Set, setTimeout, navigator: {}, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(sandbox);
  vm.runInContext(read('margin-floor.js'), sandbox);
  let fin = null, err = null;
  try { vm.runInContext(read('estimate-finalization.js'), sandbox, { filename: 'estimate-finalization.js' }); fin = win.EstimateFinalization; } catch (e) { err = e; }
  const run = (est) => { try { return fin.formatEstimate(est, 'internal-view', { customer: { name: 'ZZ Test' }, date: '2026-11-17' }).html; } catch (e) { return 'THREW ' + e.message; } };
  const full = Object.assign({ lines: [], overhead: 0, profit: 0, materialRetail: 0, taxRate: 0.078, minJobApplied: false, tier: 'better' }, EST);
  const html = fin ? run(full) : String(err && err.message);
  ok('the document loads and renders', !!fin && html.indexOf('THREW') !== 0 && /Margin Analysis/.test(html), html.slice(0, 200));
  ok('its margin is the tax-free figure, labelled, with the band in words', /<div class="margin-big">30\.0%<\/div>/.test(html) && /Before sales tax · Above your floor, under your target/.test(html), (html.match(/margin-big">[^<]*/) || [''])[0]);
  const unk = fin ? run(Object.assign({}, full, { costUnsetCount: 2 })) : '';
  ok('an uncosted job says a line has no cost, not a percentage', /<div class="margin-big">— a line has no cost<\/div>/.test(unk), (unk.match(/margin-big">[^<]*/) || [''])[0]);
  const none = fin ? run(Object.assign({}, full, { hardCost: 0, materialCost: 0, laborCost: 0, internal: { hardCost: 0, margin: null, marginPct: null } })) : '';
  ok('no cost basis still reads "set cost basis in Settings"', /— set cost basis in Settings/.test(none), (none.match(/margin-big">[^<]*/) || [''])[0]);
}

console.log('\nThe classic estimator and the loader');
{
  const classic = read('estimates.js');
  ok('the classic panel no longer uses the undefined 35 / 20 band classes', !/margin-strong|margin-ok|margin-weak/.test(classic));
  ok('the classic panel reads the shared view with the tax taken out', /NBDMarginFloor\.view\(\{ mode: d\.mode, grandTotal, taxAmount: estData\.taxAmount \|\| 0, costBasis \}\)/.test(classic));
  const loader = read('script-loader.js');
  const at = (f) => loader.indexOf("'js/" + f);
  ok('margin-floor.js loads before the three files that read it', at('margin-floor.js') !== -1 && at('margin-floor.js') < at('estimates.js') && at('margin-floor.js') < at('estimate-finalization.js') && at('margin-floor.js') < at('estimate-v2-ui.js'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
