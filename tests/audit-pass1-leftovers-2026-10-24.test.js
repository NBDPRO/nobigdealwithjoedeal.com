/**
 * tests/audit-pass1-leftovers-2026-10-24.test.js
 *
 * CSS fixes from the 2026-10-23 overnight audit (pass 1):
 *   - lane 2 #11: on a phone the "Sample account" strip sat on top of Home's
 *     Record visit bar, a fixed control nothing could scroll clear of.
 *   - lane 3: the Success Tracker's meal and exercise table inputs got the
 *     2026-10-23 focus ring, but their scrolling wrap clipped its left edge.
 *   - lane 2 #13: two desktop header controls under the 24px minimum target
 *     (WCAG 2.5.8): the connection ↻ (33x19) and Sign Out (57x12).
 * The other fixes from the same list carry their own tests: the story page's
 * first Tab (pro-demo-zero-network step 0), the D2D map-vendor race
 * (d2d-map-vendor-race-2026-10-24) and the two-line phone greeting
 * (crm-layouts-home-record-2026-10-15).
 *
 * Run: node tests/audit-pass1-leftovers-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 300) : '')); }
}
const px = (s) => Number((/calc\((\d+)px/.exec(s || '') || [])[1]);

const vr = read('docs/pro/css/visit-recorder.css');
const bar = (/\.nbd-vr-bar\{([^}]*)\}/.exec(vr) || [])[1] || '';
const barBottom = px((/bottom:([^;]*);/.exec(bar) || [])[1]);
ok('control: the Record visit bar is fixed above the bottom nav', /position:fixed/.test(bar) && barBottom > 0, bar);

const css = read('docs/pro/css/demo-mode.css');
const lifted = (/html\.nbd-demo\.nbd-vr-bar-on body:has\(#view-home\.active\) \.nbd-demo-strip \{ bottom: ([^;]*); \}/.exec(css) || [])[1];
ok('phone: while the Record bar shows on Home, the strip sits above it (bar bottom + its 56px height)', lifted && px(lifted) >= barBottom + 56, lifted);
const plain = px((/@media \(max-width: 900px\) \{\n  \.nbd-demo-strip \{ bottom: ([^;]*); \}/.exec(css) || [])[1]);
ok('control: elsewhere the strip keeps its place above the nav', plain === 84, plain);
ok('Home\'s content gets the strip\'s room on top of the bar\'s', /html\.nbd-demo\.nbd-vr-bar-on #view-home \.view-scroll \{ padding-bottom: calc\(80px \+ 74px \+ \d+px/.test(css));
ok('demo-mode.js loads the new stylesheet (v=6 or later)', /demo-mode\.css\?v=([6-9]|\d\d+)'/.test(read('docs/pro/js/demo-mode.js')));

const ds = read('docs/pro/daily-success/index.html');
ok('control: table inputs still sit in a scrolling wrap (.tbl-wrap)', /class="tbl-wrap"|tbl-wrap/.test(ds + read('docs/pro/daily-success/js/app.js')));
ok('Success Tracker: meal and exercise table inputs draw their focus ring inside (not clipped)', /\.dt td input:focus-visible,#ex-tbody td input:focus-visible\{outline-offset:-2px;\}/.test(ds));
ok('…after the page-wide focus ring rule, so it wins', ds.indexOf('input:focus-visible,textarea:focus-visible{outline:2px') !== -1 && ds.indexOf('input:focus-visible,textarea:focus-visible{outline:2px') < ds.indexOf('.dt td input:focus-visible'));

const conn = read('docs/pro/js/connection-status-btn.js');
const connBase = (/#nbd-conn-btn \{([\s\S]*?)\n\}/.exec(conn) || [])[1] || '';
ok('desktop: the connection button is at least 24x24 (not only on phones)', /min-width:24px;/.test(connBase) && /min-height:24px;/.test(connBase), connBase.slice(-200));
const dapp = read('docs/pro/css/dashboard-app.css');
ok('desktop: Sign Out is at least 24px tall', /\.so\{[^}]*min-height:24px;/.test(dapp));
const dash = read('docs/pro/dashboard.html');
ok('dashboard re-versions both files', /css\/dashboard-app\.css\?v=(1[6-9]|[2-9]\d)(?!\d)/.test(dash) && /js\/connection-status-btn\.js\?v=([5-9]|\d\d)(?!\d)/.test(dash));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
