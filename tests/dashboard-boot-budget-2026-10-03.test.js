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
  blockingScripts: 29,          // measured 28 (2026-10-03) — never grow. ONE deliberate raise 2026-10-06: demo-mode.js (Pro demo phase 2) must run before every other script so the sample account's guard + network tripwire exist first; on the real page it returns on line one (~9 KB)
  blockingBytes: 300 * 1024,    // measured 278 KB
  localScripts: 196,            // measured 178; deliberate raises 2026-10-05: + client-error-reporter.js (#2140, must run at boot to catch boot errors) + the offline sync badge (#2145) = 193 [+1 on merge: both PRs' boot tags, measured]; 2026-10-06 + storm-time.js (review R4-6-1: the one UTC→Eastern storm-date reader dol-fill + the D2D storm layer need at boot, 1.9 KB) = 195; +1 2026-10-07 demo-mode.js (Pro demo phase 2, #2294) = 196
  localBytes: 4.4 * 1024 * 1024, // measured 4.08 MB
  htmlBytes: 520 * 1024,        // measured 477 KB
};
// +1 local tag, deliberate (2026-10-05, #2155): js/photo-cache.js (window.NBDPhotoCache).
// It REPLACES the boot-time read of every photos doc, and its consumers (job-detail hero,
// Photos tab, photo hub, inspection report) read window.NBDPhotoCache
// synchronously behind a guard — lazy-loading it would turn a missing helper into silent
// "no photos" (page-scoped-helper rule). Kept as its own line so the other PRs that raise
// localScripts on the line above merge without a conflict.
CEILING.localScripts += 1;
// +1 local tag, deliberate (2026-10-08, phone quick wins): js/keyboard-viewport.js (2.9 KB).
// It keeps every open sheet above the iPhone keyboard (Record payment's Save sat under
// it); it must be listening before the first sheet opens, so it cannot be lazy.
CEILING.localScripts += 1;

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

// ── BOOT READS (2026-10-04) ────────────────────────────────────────────────
// Bytes are half the boot cost; Firestore reads are the other half. The boot
// read path is loadLeads + the post-auth tail it triggers (loadPins,
// loadZones). Every collection read there must be BOUNDED (limit(...)) — the
// one deliberate exception is that leads page through the WHOLE book (500 a
// page, the kanban must be complete), which carries limit(_PAGE) per page.
//   measured 2026-10-03 (before): 3 unbounded boot reads — photos (every doc
//     in scope, own + company), pins, zones;
//   measured 2026-10-04 (after):  0 — photos load per lead on demand
//     (js/photo-cache.js), pins capped to the newest PIN_CAP, zones to ZONE_CAP.
// The runtime twin is tests/e2e/boot-weight.spec.js "boot reads", which
// counts the queries the SDK actually starts. Ceiling: never grow.
console.log('\nDASHBOARD BOOT READS');
const UNBOUNDED_BOOT_READS_CEILING = 0;
function bootReadCalls(src) {
  const fnBody = (name, endMarker) => {
    const a = src.indexOf('async function ' + name + '(');
    if (a < 0) return '';
    const b = src.indexOf(endMarker, a);
    return src.slice(a, b < 0 ? a + 20000 : b);
  };
  const bodies = [
    fnBody('loadLeads', 'window._loadLeads = loadLeads'),
    fnBody('loadPins', 'async function _savePin'),
    fnBody('loadZones', 'window.loadZones = loadZones'),
  ].map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
  const calls = [];
  for (const body of bodies) {
    for (const m of body.matchAll(/getDocs\(\s*query\(\s*collection\(\s*db\s*,\s*'([\w-]+)'([^;]*)/g)) {
      calls.push({ coll: m[1], bounded: /\blimit\(/.test(m[2]) });
    }
  }
  return { found: bodies.every(Boolean), calls };
}
const br = bootReadCalls(fs.readFileSync(path.join(PRO, 'js', 'dashboard-bootstrap.module.js'), 'utf8'));
const unbounded = br.calls.filter((c) => !c.bounded);
ok('found loadLeads / loadPins / loadZones', br.found);
ok('boot read calls located (' + br.calls.length + ')', br.calls.length >= 3);
ok('unbounded boot reads: ' + unbounded.length + ' ≤ ' + UNBOUNDED_BOOT_READS_CEILING + ' (was 3: photos, pins, zones)',
  unbounded.length <= UNBOUNDED_BOOT_READS_CEILING, unbounded.map((c) => c.coll).join(', '));
ok('no photos read anywhere on the boot path', !br.calls.some((c) => c.coll === 'photos'));
const ctlReads = bootReadCalls("async function loadLeads() { await getDocs(query(collection(db,'photos'), s)); }\nwindow._loadLeads = loadLeads\nasync function loadPins() { getDocs(query(collection(db,'pins'), s, limit(5))); }\nasync function _savePin\nasync function loadZones() {}\nwindow.loadZones = loadZones");
ok('control: an unbounded read is counted, a limit()ed one is not', ctlReads.calls.length === 2 && ctlReads.calls.filter((c) => !c.bounded).length === 1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
