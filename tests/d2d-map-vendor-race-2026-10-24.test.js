/**
 * tests/d2d-map-vendor-race-2026-10-24.test.js
 *
 * Door-to-Door opened early stuck on "Loading…" with
 * "L.markerClusterGroup is not a function" (2026-10-23 audit, lane 2 #5).
 * goTo('d2d') preloads the 'mapvendor' and 'd2d' bundles in PARALLEL
 * (ScriptLoader.preloadForView -> Promise.all), each one in order inside.
 * waitForD2D() started the tracker as soon as window.D2D existed, which can be
 * before mapvendor's last file (leaflet.markercluster.js) has run; the
 * tracker's init then called L.markerClusterGroup() and threw. waitForD2D now
 * waits for the map vendor too.
 *
 * Runs the real waitForD2D() from dashboard-actions.js with fake timers.
 *
 * Run: node tests/d2d-map-vendor-race-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 300) : '')); }
}

const ROOT = path.join(__dirname, '..');
const actions = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dashboard-actions.js'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'docs/pro/js/script-loader.js'), 'utf8');
const fnSrc = (/\n(\s*)function waitForD2D\(cb\) \{[\s\S]*?\n\1\}\n/.exec(actions) || [''])[0];
ok('control: waitForD2D() is in dashboard-actions.js', !!fnSrc);
ok('control: the D2D view still preloads mapvendor and d2d together (the race this guards)',
  /d2d:\s*\['mapvendor', 'd2d'\]/.test(loader) && /Promise\.all\(bundleNames\.map\(loadBundle\)\)/.test(loader));
ok('control: the tracker\'s init still calls L.markerClusterGroup() unguarded',
  /state\.d2dCluster = L\.markerClusterGroup\(/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/js/d2d-tracker-core-2026b.js'), 'utf8')));

function run(setup) {
  const timers = [];
  const win = {};
  const sb = {
    window: win, console: { error() {}, log() {} },
    document: { getElementById: () => null },
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: (id) => { timers[id - 1] = null; }
  };
  sb.L = undefined;
  vm.createContext(sb);
  vm.runInContext(fnSrc + '\nthis.waitForD2D = waitForD2D;', sb);
  let called = 0;
  setup(win, sb);
  sb.waitForD2D(() => { called++; });
  const tick = (n) => { for (let i = 0; i < n; i++) timers.forEach((t) => t && t()); };
  return { win, sb, tick, calls: () => called };
}

// The race: the tracker is in, Leaflet is in, the cluster plugin is not yet.
const r = run((win, sb) => { win.D2D = {}; win.L = sb.L = {}; });
ok('window.D2D present but L.markerClusterGroup missing: the tracker is NOT started yet', r.calls() === 0);
r.tick(5);
ok('…still waiting while the plugin loads', r.calls() === 0);
r.win.L.markerClusterGroup = function () {};
r.tick(1);
ok('…and it starts once leaflet.markercluster.js has run', r.calls() === 1);
r.tick(5);
ok('…exactly once', r.calls() === 1);

const r2 = run((win, sb) => { win.D2D = {}; win.L = sb.L = { markerClusterGroup() {} }; });
ok('everything loaded: starts at once (no extra wait)', r2.calls() === 1);

const r3 = run(() => {});
r3.tick(3);
ok('nothing loaded yet: waits', r3.calls() === 0);
r3.win.L = { markerClusterGroup() {} }; r3.win.D2D = {};
r3.tick(1);
ok('…then starts when both arrive', r3.calls() === 1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
