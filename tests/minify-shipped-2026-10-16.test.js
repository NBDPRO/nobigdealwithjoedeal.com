/**
 * tests/minify-shipped-2026-10-16.test.js — the deploy-time minify
 * (scripts/minify-shipped.js, repos report 2026-10-16 item 1).
 *
 * Guards: what is in scope (vendor, *.min, service workers and anything
 * outside docs/pro stay untouched), that esbuild is pinned to one exact
 * version, that the deploy runs the minify after the Sentry stamp and before
 * Hosting and restores docs/pro afterwards, that CI walks the minified build,
 * and (when the pinned esbuild is installed) that a real CRM file minifies
 * with its 'use strict', globals and function names intact.
 *
 * Run: node tests/minify-shipped-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('../scripts/minify-shipped.js');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\nSCOPE');
const yes = ['pro/js/crm-leads.js', 'pro/js/dashboard-bootstrap.module.js', 'pro/css/dashboard-app.css', 'pro/js/layouts/routeplan.js', 'pro/demo-sdk/firebase-auth.js', 'pro/deal-room.js'];
const no = ['pro/sw.js', 'pro/firebase-messaging-sw.js', 'pro/explore/demo-sw.js', 'assets/vendor/jspdf/jspdf.umd.min.js',
  'pro/js/vendor/x.js', 'pro/css/thing.min.css', 'assets/js/nav.js', 'index.html', 'pro/dashboard.html', 'pro/manifest.json'];
for (const r of yes) ok('minified: ' + r, M.shouldMinify(r));
for (const r of no) ok('left alone: ' + r, !M.shouldMinify(r));
ok('backslash paths are normalised', M.shouldMinify('pro\\js\\crm.js') && !M.shouldMinify('pro\\sw.js'));

console.log('\nPIN + OPTIONS');
ok('esbuild is pinned to one exact version', /^\d+\.\d+\.\d+$/.test(M.ESBUILD_VERSION), M.ESBUILD_VERSION);
ok('no identifier renaming, keepNames on, no tree shaking',
  M.OPTIONS.minifyIdentifiers === false && M.OPTIONS.keepNames === true && M.OPTIONS.treeShaking === false &&
  M.OPTIONS.minifyWhitespace === true && M.OPTIONS.minifySyntax === true);
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'minify-shipped.js'), 'utf8');
ok("JS target is safari15 (keepNames never writes class static {} blocks)", /target: loader === 'css' \? 'esnext' : 'safari15'/.test(src));
ok('no source map comment is ever appended (maps only with --maps-dir, external)', /sourcemap: withMap \? 'external' : false/.test(src) && !/sourceMappingURL=/.test(src.replace(/\/\/# sourceMappingURL`/g, '')));

console.log('\nWORKFLOWS');
const deploy = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8').replace(/\r/g, '');
const at = (s) => deploy.indexOf(s);
const iSentry = at('- name: Stamp Sentry release with git SHA');
const iMin = at('- name: Minify the CRM\'s JS and CSS for this deploy');
const iHost = at('- name: Deploy Hosting');
const iRestore = at('- name: Restore readable docs/pro after the Hosting deploy');
const iSmoke = at('- name: Gate — function smoke suite must pass before deploy');
ok('deploy: minify step exists', iMin > 0);
ok('deploy: minify runs after the Sentry stamp (its sed matches the readable source)', iSentry > 0 && iMin > iSentry);
ok('deploy: minify runs before Hosting', iHost > iMin);
ok('deploy: docs/pro is restored after Hosting and before the smoke gate', iRestore > iHost && iSmoke > iRestore);
const minStep = deploy.slice(iMin, deploy.indexOf('\n      - name:', iMin + 10));
ok('deploy: the minify step installs the pin, writes, keeps maps out of docs/ and parse-checks the result',
  /minify-shipped\.js --install/.test(minStep) && /--write --maps-dir "\$RUNNER_TEMP\//.test(minStep) && /check-js-syntax\.js --shipped-only/.test(minStep));
const restoreStep = deploy.slice(iRestore, deploy.indexOf('\n      - name:', iRestore + 10));
ok('deploy: the restore runs even when Hosting failed', /always\(\)/.test(restoreStep) && /git checkout -- docs\/pro/.test(restoreStep));
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r/g, '');
const demo = ci.slice(ci.indexOf('  pro-demo-zero-network:'), ci.indexOf('\n  public-e2e:'));
const iMinCi = demo.indexOf('minify-shipped.js --write');
ok('CI: the demo job minifies docs/pro the way the deploy does', iMinCi > 0);
ok('CI: and runs the zero-network walk + layouts check after it',
  demo.indexOf('node pro-demo-zero-network-2026-10-06.test.js', iMinCi) > iMinCi && demo.indexOf('node crm-layouts-render-2026-10-15.test.js', iMinCi) > iMinCi);
const unit = ci.slice(ci.indexOf('  unit-suite-manifest:'), ci.indexOf('\n  emulator-orphan-suites:'));
ok('CI: the node bucket job installs the pinned esbuild before the bucket (boot budget measures shipped bytes)',
  unit.indexOf('minify-shipped.js --install') > 0 && unit.indexOf('minify-shipped.js --install') < unit.indexOf('--bucket node'));

console.log('\nREAL FILE');
let eb = null; try { eb = M.loadEsbuild(); } catch (e) { ok('pinned esbuild loads', false, e.message); }
if (!eb) {
  if (process.env.CI) ok('pinned esbuild is installed under CI', false, 'run node scripts/minify-shipped.js --install');
  else console.log('  ! esbuild not installed: real-file checks skipped (node scripts/minify-shipped.js --install)');
} else {
  const f = path.join(ROOT, 'docs', 'pro', 'js', 'crm-leads.js');
  const s = fs.readFileSync(f, 'utf8');
  const out = M.minifySource(eb, s, 'pro/js/crm-leads.js', false).code;
  ok('crm-leads.js shrinks', Buffer.byteLength(out) < Buffer.byteLength(s) * 0.8, Buffer.byteLength(out) + ' of ' + Buffer.byteLength(s));
  ok('crm-leads.js keeps its top-level declarations by name', /function escHtml\(/.test(out) && /function debounce\(fn,ms,key\)\{return key=key\|\|fn\.name\|\|"default"/.test(out));
  ok('no static {} block anywhere in it', !/static\s*\{/.test(out));
  const css = M.minifySource(eb, '.a{height:100vh;height:100dvh;user-select:none}', 'pro/css/x.css', false).code;
  ok('CSS: fallbacks kept, no vendor prefix added', css.trim() === '.a{height:100vh;height:100dvh;user-select:none}', css);
  const mapped = M.minifySource(eb, '/* a long comment that minifying removes */\nvar total = 1;\n// another comment line\nvar again = total + 1;\n', 'pro/js/a.js', true);
  ok('a requested map is returned separately, never as a comment in the code', !!mapped.map && !/sourceMappingURL/.test(mapped.code));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
