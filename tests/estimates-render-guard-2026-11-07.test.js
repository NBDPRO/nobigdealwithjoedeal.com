/**
 * tests/estimates-render-guard-2026-11-07.test.js
 *
 * dashboard-bootstrap.module.js (a module tag near the top of dashboard.html)
 * starts the live estimates listener; renderEstimatesList comes from
 * dashboard-widgets.js, a deferred classic script ~6,200 lines further down.
 * A snapshot that lands before that script has run threw
 * "ReferenceError: renderEstimatesList is not defined" (seen in the CRM walk
 * harness, 2026-11-07, on Settings while estimates were being written).
 * Every other caller already guards with typeof; the two bootstrap calls now do
 * too. window._estimates is still set, so the Estimates view renders it when it
 * opens (dashboard-actions.js reads window._estimates).
 *
 * Runs the shipped `rebuild` lines in a vm sandbox, with and without the
 * widgets function present. Zero deps.
 * Run: node tests/estimates-render-guard-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const m = /\n( *)const rebuild = \(\) => \{\n[\s\S]*?\n\1\};\n/.exec(SRC);
ok('found the live listener rebuild()', !!m);
const body = m ? m[0] : '';

function run(withWidgets) {
  const calls = [];
  const win = {};
  if (withWidgets) win.renderEstimatesList = (list) => calls.push(list.map((e) => e.id).join(','));
  const sb = {
    window: win, comp: { c1: { id: 'c1', createdAt: null } }, own: { o1: { id: 'o1', createdAt: null }, o2: { id: 'o2', deleted: true } },
    sortDesc: () => 0, out: null, err: null,
  };
  if (withWidgets) sb.renderEstimatesList = win.renderEstimatesList; // a classic global is also a bare name
  vm.createContext(sb);
  try { vm.runInContext(body + '\nrebuild();', sb); } catch (e) { sb.err = e; }
  return { err: sb.err, calls, est: win._estimates };
}

const before = run(false);
ok('widgets not loaded yet: the snapshot does not throw', !before.err, before.err && String(before.err));
ok('widgets not loaded yet: window._estimates is still set (soft-deleted dropped)', Array.isArray(before.est) && before.est.map((e) => e.id).sort().join(',') === 'c1,o1', JSON.stringify(before.est));
const after = run(true);
ok('widgets loaded: the list is rendered once with the merged estimates', !after.err && after.calls.length === 1 && after.calls[0].split(',').sort().join(',') === 'c1,o1', JSON.stringify(after));

// No bare call left anywhere in the module (the one-shot loadEstimates() too).
const bare = (SRC.match(/^(?!\s*\/\/).*(?<![.\w])renderEstimatesList\(/gm) || []).filter((l) => !/typeof window\.renderEstimatesList === 'function'/.test(l));
ok('no unguarded renderEstimatesList( call remains in the module', bare.length === 0, bare.join(' | '));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
