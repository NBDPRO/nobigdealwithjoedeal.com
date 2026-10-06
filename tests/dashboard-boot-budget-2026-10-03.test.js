/**
 * tests/dashboard-boot-budget-2026-10-03.test.js — a ratchet on what the CRM
 * dashboard loads at boot (audit 2026-10-03: ~4 MB of first-party JS over 178
 * script tags, 28 of them render-blocking, and nothing watching it grow).
 *
 * Counts every LOCAL <script src> in docs/pro/dashboard.html (lazy
 * ScriptLoader bundles aren't in the HTML, so they don't count — that's the
 * point of lazy-loading). Blocking = no defer, no async, not a module.
 *
 * The blocking-script ceiling is strict: a new feature must load deferred or
 * lazily. The byte ceilings have a little headroom so ordinary work isn't
 * blocked, but steady growth trips the gate. Raising a ceiling is fine when
 * it's deliberate: change the number below in the same PR and say why.
 *
 * Run: node tests/dashboard-boot-budget-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PRO = path.join(__dirname, '..', 'docs', 'pro');
const CEILING = {
  blockingScripts: 28,          // measured 28 (2026-10-03) — never grow
  blockingBytes: 300 * 1024,    // measured 278 KB
  localScripts: 193,            // measured 178; deliberate raises 2026-10-05: + client-error-reporter.js (#2140, must run at boot to catch boot errors) + the offline sync badge (#2145) = 193
  localBytes: 4.4 * 1024 * 1024, // measured 4.08 MB
  htmlBytes: 520 * 1024,        // measured 477 KB
};

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function measure(html, root) {
  const out = { htmlBytes: Buffer.byteLength(html), localScripts: 0, localBytes: 0, blockingScripts: 0, blockingBytes: 0, missing: [] };
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of noComments.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1];
    const src = (attrs.match(/\bsrc\s*=\s*"([^"]+)"/i) || [])[1];
    if (!src || /^(https?:)?\/\//i.test(src)) continue;
    const file = path.join(root, src.split('?')[0].replace(/^\/pro\//, ''));
    if (!fs.existsSync(file)) { out.missing.push(src); continue; }
    const n = fs.statSync(file).size;
    out.localScripts++; out.localBytes += n;
    const blocking = !/\b(defer|async)\b/i.test(attrs) && !/\btype\s*=\s*"module"/i.test(attrs);
    if (blocking) { out.blockingScripts++; out.blockingBytes += n; }
  }
  return out;
}

console.log('\nDASHBOARD BOOT BUDGET');
const m = measure(fs.readFileSync(path.join(PRO, 'dashboard.html'), 'utf8'), PRO);
const kb = (n) => Math.round(n / 1024) + ' KB';
ok('every local script tag resolves to a file', m.missing.length === 0, m.missing.join(', '));
ok('blocking scripts: ' + m.blockingScripts + ' ≤ ' + CEILING.blockingScripts + ' (new code loads deferred or lazily)', m.blockingScripts <= CEILING.blockingScripts);
ok('blocking bytes: ' + kb(m.blockingBytes) + ' ≤ ' + kb(CEILING.blockingBytes), m.blockingBytes <= CEILING.blockingBytes);
ok('local script tags: ' + m.localScripts + ' ≤ ' + CEILING.localScripts, m.localScripts <= CEILING.localScripts);
ok('local script bytes: ' + kb(m.localBytes) + ' ≤ ' + kb(CEILING.localBytes), m.localBytes <= CEILING.localBytes);
ok('dashboard.html: ' + kb(m.htmlBytes) + ' ≤ ' + kb(CEILING.htmlBytes), m.htmlBytes <= CEILING.htmlBytes);

// Positive controls: the counter must see what it claims to count.
const ctl = measure('<script src="js/a.js"></script><script defer src="js/a.js"></script><script type="module" src="js/a.js"></script><!-- <script src="js/a.js"></script> --><script src="https://x.test/b.js"></script>', path.join(__dirname));
ok('control: counts local tags, skips CDN + commented-out tags, splits blocking from deferred/module',
  ctl.blockingScripts === 0 && ctl.missing.length === 3 && ctl.localScripts === 0);
const real = measure('<script src="dashboard-boot-budget-2026-10-03.test.js"></script><script defer src="dashboard-boot-budget-2026-10-03.test.js"></script>', __dirname);
ok('control: a blocking tag and a deferred tag are told apart', real.localScripts === 2 && real.blockingScripts === 1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
