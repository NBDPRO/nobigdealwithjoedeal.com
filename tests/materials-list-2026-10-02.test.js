#!/usr/bin/env node
/**
 * Recommended materials list (2026-10-02, store-price-book plan phase 3).
 * Runs the REAL estimate catalog (estimate-catalog-xactimate.js) + the real
 * materials-list.js in a vm, on a saved-estimate-shaped row set.
 *
 *   A. Only material lines; labor / dumpster / permit lines out.
 *   B. Estimate quantity → purchase quantity, always rounded UP, no waste
 *      added twice (shingles 3 bundles/SQ, synthetic 10 SQ/roll, ice & water
 *      2 SQ/roll, starter ~100 ft, ridge ~25 ft, drip edge 10-ft pieces,
 *      decking 32 SF sheets).
 *   C. Grouped by suggested store; costs add up; the copied text carries NO
 *      prices; everything rendered is escaped; the hub shows the button only
 *      for an estimate with rows.
 *
 * Run: node tests/materials-list-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const win = { addEventListener() {} }; win.window = win;
const ctx = vm.createContext({ window: win, document: { addEventListener() {} }, console, Math, JSON, Number, String, Array, Object });
vm.runInContext(read('docs/pro/js/estimate-catalog-xactimate.js'), ctx);
vm.runInContext(read('docs/pro/js/materials-list.js'), ctx);
const M = win.NBDMaterials;
ok('the real catalog and the module load', !!(win.NBD_XACT_CATALOG && win.NBD_XACT_CATALOG.find && M));

const row = (code, quantity, unit, materialTotal, desc) => ({ code, quantity, unit, materialTotal, desc: desc || code });
const ROWS = [
  row('LAB TO1', 25.4, 'SQ', 0, 'Tear off'),
  row('RFG 240-GAF-HDZ', 25.4, 'SQ', 2921, 'GAF Timberline HDZ'),
  row('RFG SYN', 23.4, 'SQ', 514.8, 'Synthetic Underlayment'),
  row('RFG IWS', 3.6, 'SQ', 306, 'Ice & Water Shield'),
  row('RFG STRT', 120, 'LF', 222, 'Starter Strip'),
  row('RFG RIDG-ARC', 45, 'LF', 191.25, 'Ridge Cap'),
  row('RFG DRPE-AL', 170, 'LF', 331.5, 'Drip Edge <b>Alu</b>'),
  row('RFG OSB716', 96, 'SF', 120, 'OSB'),
  row('RFG PIPE-LD', 3, 'EA', 90, 'Pipe Boot Lead'),
  row('DSP 30YD', 1, 'EA', 0, 'Dumpster'),
  row('PRM RES-OH', 1, 'EA', 0, 'Permit'),
];
const L = M.buildList(ROWS);
const items = {}; L.groups.forEach((g) => g.items.forEach((i) => { items[i.code] = Object.assign({ store: g.store }, i); }));

console.log('A. material lines only');
ok('labor, dumpster and permit lines are out', !items['LAB TO1'] && !items['DSP 30YD'] && !items['PRM RES-OH']);
ok('every material line is in', Object.keys(items).length === 8, Object.keys(items).join());

console.log('B. purchase quantities');
ok('shingles: 25.4 SQ → 77 bundles (3/SQ, rounded up)', items['RFG 240-GAF-HDZ'].buyQty === 77 && items['RFG 240-GAF-HDZ'].buyUnit === 'bundles');
ok('synthetic: 23.4 SQ → 3 rolls (10 SQ/roll)', items['RFG SYN'].buyQty === 3 && items['RFG SYN'].buyUnit === 'rolls');
ok('ice & water: 3.6 SQ → 2 rolls (2 SQ/roll)', items['RFG IWS'].buyQty === 2);
ok('starter: 120 ft → 2 bundles', items['RFG STRT'].buyQty === 2);
ok('ridge cap: 45 ft → 2 bundles', items['RFG RIDG-ARC'].buyQty === 2);
ok('drip edge: 170 ft → 17 ten-foot pieces', items['RFG DRPE-AL'].buyQty === 17 && items['RFG DRPE-AL'].buyUnit === '10-ft pieces');
ok('decking: 96 SF → 3 sheets', items['RFG OSB716'].buyQty === 3 && items['RFG OSB716'].buyUnit === '4×8 sheets');
ok('pipe boots stay each', items['RFG PIPE-LD'].buyQty === 3 && items['RFG PIPE-LD'].buyUnit === 'EA');
ok('an exact multiple is not bumped (30 SQ synthetic → 3 rolls)', M.buildList([row('RFG SYN', 30, 'SQ', 1)]).groups[0].items[0].buyQty === 3);

console.log('C. stores, totals, text');
ok('roof system → the distributor; metal and sundries → Home Depot',
  items['RFG 240-GAF-HDZ'].store === M.DISTRIBUTOR && items['RFG SYN'].store === M.DISTRIBUTOR && items['RFG DRPE-AL'].store === M.HOME_DEPOT && items['RFG PIPE-LD'].store === M.HOME_DEPOT);
ok('distributor group comes first', L.groups[0].store === M.DISTRIBUTOR);
ok('total = sum of the lines’ assumed material cost', L.total === 4696.55, String(L.total));
const text = M.toText(L, 'Materials — Test');
ok('the copied list has quantities and stores but NO prices', /77 bundles — GAF Timberline HDZ/.test(text) && /Home Depot:/.test(text) && !/\$/.test(text));
const src = read('docs/pro/js/materials-list.js');
ok('every value painted into the modal goes through esc()', /esc\(i\.name\)/.test(src) && /esc\(i\.buyQty\)/.test(src) && /esc\(g\.store\)/.test(src) && /esc\(title\)/.test(src));
const hub = read('docs/pro/js/customer-estimate-hub.js');
ok('the hub shows 🧾 Materials only for an estimate with rows', /Array\.isArray\(est\.rows\) && est\.rows\.length && window\.NBDMaterials \? '<button type="button" class="ceh-btn" data-ceh-act="materials"/.test(hub) && /case 'materials':/.test(hub));
const dash = read('docs/pro/dashboard.html');
ok('dashboard loads materials-list.js before the hub, plus its CSS', dash.indexOf('js/materials-list.js?v=') > 0 && dash.indexOf('js/materials-list.js?v=') < dash.indexOf('js/customer-estimate-hub.js?v=') && /css\/materials-list\.css\?v=\d+/.test(dash));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
