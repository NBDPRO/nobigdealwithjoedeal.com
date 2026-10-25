/**
 * tests/draw-tools-drawer-2026-10-25.test.js — the phone Tools drawer on the
 * Draw screen is tall enough for the Gutters flow as it opens.
 *
 *   The first @shard2 run that ever finished (2026-10-25) failed
 *   phone-draw-crosshair.spec.js at 393x852: "✓ Finish run" was under a thumb
 *   only by half, its centre under the bottom nav's + button. Measured: the
 *   drawer shows 340px below the map and the Gutters stack (breadcrumb,
 *   address, My location, Draw Mode, gutter totals, Finish run) is 373px since
 *   #2727 gave every control a 44px tap target. The drawer opens at 380px now.
 *
 * Run: node tests/draw-tools-drawer-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const css = read('docs/pro/css/dashboard-app.css');
console.log('\n1. the phone drawer');
ok('the phone .map-sidebar.open rule gives the drawer 380px (was 340)', /\.map-sidebar\.open\{max-height:380px;overflow-y:auto;padding:12px!important;\}/.test(css));
ok('no phone rule still caps it at 340', !/\.map-sidebar\.open\{max-height:340px/.test(css));
ok('the crosshair-on sheet keeps its own height rule (draw-reticle.css)', /#view-draw\.dr-on #map-sidebar-draw\.open\{\s*max-height:min\(72%, calc\(100% - 96px\)\)!important/.test(read('docs/pro/css/draw-reticle.css')));
console.log('\n2. versions');
ok('dashboard.html loads dashboard-app.css?v=26 or later', (() => { const m = /dashboard-app\.css\?v=(\d+)/.exec(read('docs/pro/dashboard.html')); return m && +m[1] >= 26; })());
ok('ci-manifest lists this file', read('tests/ci-manifest.json').indexOf('draw-tools-drawer-2026-10-25.test.js') !== -1);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('  failed: ' + fails.join('; ')); process.exit(1); }
