/**
 * tests/crm-strip-one-row-2026-10-25.test.js — the Pipeline board strip stays
 * ONE 44px row on a phone.
 *
 *   phone-crm-header-compact-2026-10-13.spec.js test 3 measured the strip at
 *   56px with real fonts and 100px (two rows) with a wider fallback font. The
 *   phone tap-target floor #2727 added to dashboard-app.css
 *   (`.view :is(button, …) { min-height: 44px }`, specificity (0,5,1)) beat the
 *   strip's own 32px chips (`.kr-stat`, (0,1,0)), so the 6px+32px+6px row grew
 *   to 56px and the wider chips wrapped the cycle button onto a second line.
 *   The chips already reach 44px with their ::after hit area (pipeline-rich-
 *   cards.css, 640px block), so the floor leaves them alone.
 *
 * Run: node tests/crm-strip-one-row-2026-10-25.test.js
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
const app = read('docs/pro/css/dashboard-app.css');
const rich = read('docs/pro/css/pipeline-rich-cards.css');
console.log('\n1. the phone tap-target floor leaves the strip chips at 32px');
const floor = /\.view :is\(button, \.btn, a\.btn, \[role="button"\], select\)((?::not\([^)]*\))+)\{ min-height:44px; \}/.exec(app);
ok('the floor rule is still there', !!floor);
ok('it excludes .kr-stat', !!floor && floor[1].indexOf(':not(.kr-stat)') !== -1, floor && floor[1]);
ok('it excludes .kr-cycle', !!floor && floor[1].indexOf(':not(.kr-cycle)') !== -1, floor && floor[1]);
console.log('\n2. the strip still gives those chips a 44px hit area');
ok('.kr-stat::after and .kr-cycle::after extend 7px above and below', /\.kr-stat::after, \.kr-cycle::after \{ content: ""; position: absolute; left: -1px; right: -1px; top: -7px; bottom: -7px; \}/.test(rich));
ok('the phone chips stay 32px tall', /@media \(max-width: 640px\)[\s\S]*\.kr-switch \.kr-cycle\.ui-seg \{[^}]*min-height: 32px/.test(rich));
console.log('\n3. versions');
ok('dashboard.html loads dashboard-app.css?v=27 or later', (() => { const m = /dashboard-app\.css\?v=(\d+)/.exec(read('docs/pro/dashboard.html')); return m && +m[1] >= 27; })());
ok('ci-manifest lists this file', read('tests/ci-manifest.json').indexOf('crm-strip-one-row-2026-10-25.test.js') !== -1);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('  failed: ' + fails.join('; ')); process.exit(1); }
