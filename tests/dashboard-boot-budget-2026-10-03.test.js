/**
 * tests/dashboard-boot-budget-2026-10-03.test.js — a ratchet on what the CRM
 * dashboard loads at boot (audit 2026-10-03: ~4 MB of first-party JS over 178
 * script tags, 28 of them render-blocking, and nothing watching it grow).
 *
 * Counts every LOCAL <script src> in docs/pro/dashboard.html (lazy
 * ScriptLoader bundles aren't in the HTML, so they don't count — that's the
 * point of lazy-loading). Blocking = no defer, no async, not a module, and
 * NOT inside a <template>: view templates (tpl-view-settings, ...) are inert
 * markup until _hydrateViewTemplate swaps their <script>s into the live view
 * (an async=false dynamic insert), so they are not parser- or render-blocking.
 * CAVEAT, not "free": deep links (#/settings, ?settings=billing&connect=return,
 * ?est=, ?lead=, command-palette / agent-bots goTo('settings')) hydrate Settings
 * (~130 KB of template scripts) DURING boot and delay window load. They count
 * toward localScripts / localBytes, are bounded by their own ceiling
 * (templateScripts / templateBytes), and the "template-deferred" console line
 * below is the disclosure. The set of template scripts is pinned by name, so
 * a new one is a conscious change.
 * HTML is read with a small tokenizer (comments, raw-text bodies and quoted
 * attribute values are skipped; defer/async are attribute NAMES), not regexes
 * over the raw string.
 * Sizes are measured LF-only (CR bytes dropped) so a CRLF checkout and CI's LF
 * checkout agree to the byte.
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
  blockingScripts: 22,          // measured 20 (2026-10-12, <template> scripts excluded; was 28 on 2026-10-03) — never grow. ONE deliberate raise 2026-10-06: demo-mode.js (Pro demo phase 2) must run before every other script so the sample account's guard + network tripwire exist first; on the real page it returns on line one (~9 KB)
  // 2026-10-12 (boot-weight lane): measured 170 KB LF once the 133 KB of <template>-inert
  // Settings/Draw/Estimate tab scripts stopped being counted as blocking (they were never
  // render-blocking; see measure()). Ceiling LOWERED 300 -> 192 KB so the gate still bites: ~22 KB
  // of real headroom, not 133 KB of slack. Was 300 KB measured 278 KB on 2026-10-03.
  blockingBytes: 192 * 1024,
  localScripts: 196,            // measured 178; deliberate raises 2026-10-05: + client-error-reporter.js (#2140, must run at boot to catch boot errors) + the offline sync badge (#2145) = 193 [+1 on merge: both PRs' boot tags, measured]; 2026-10-06 + storm-time.js (review R4-6-1: the one UTC→Eastern storm-date reader dol-fill + the D2D storm layer need at boot, 1.9 KB) = 195; +1 2026-10-07 demo-mode.js (Pro demo phase 2, #2294) = 196
  localBytes: 4.62 * 1024 * 1024, // deliberate raise 2026-10-12 (+0.02 MB): promise capture's Today rows + plan lanes in today-home.js / today-plan.js (~17 KB, deferred; the promise bundle itself is lazy, registered from today-home.js so blockingBytes does not move). (union of two deliberate raises, both 2026-10-11:4.4 + 0.05 + 0.15 MB.) deliberate raise 2026-10-11 (Ohio ORC 4722.04 cap: deposit-rule.js + the builder / invoice / deal-room / pre-flight wiring ~19 KB; LF bytes 4497 -> 4516 KB against the old 4506 KB) ALSO: deliberate raise 2026-10-11: per-theme My Skin backgrounds (my-skin.js 17 -> 49 KB, my-skin-logic.js 7 -> 22 KB: two-layer painter, IndexedDB cache, per-theme panel; all deferred, so blockingBytes is unchanged)
  htmlBytes: 520 * 1024,        // measured 477 KB
  templateScripts: 9,           // 2026-10-12: scripts inside <template> (hydrate with their view); also pinned by name below
  templateBytes: 136 * 1024,    // measured 130 KB LF
};
// The <template>-contained script set, pinned by name: adding to it is a conscious change (edit here).
const KNOWN_TEMPLATE_SCRIPTS = [
  'js/dashboard-accessory-panel-init.js', 'js/dashboard-billing-tab.js', 'js/dashboard-connect-tab.js',
  'js/dashboard-custom-theme.js', 'js/dashboard-hotkey-toggles.js', 'js/dashboard-insurance-overlay-toggle.js',
  'js/dashboard-sidebar-customizer.js', 'js/dashboard-team-tab.js', 'js/pipeline-builder.js',
];
// +1 local tag, deliberate (2026-10-05, #2155): js/photo-cache.js (window.NBDPhotoCache).
// It REPLACES the boot-time read of every photos doc, and its consumers (job-detail hero,
// Photos tab, photo hub, inspection report) read window.NBDPhotoCache
// synchronously behind a guard — lazy-loading it would turn a missing helper into silent
// "no photos" (page-scoped-helper rule). Kept as its own line so the other PRs that raise
// localScripts on the line above merge without a conflict.
CEILING.localScripts += 1;
// +1 local tag, deliberate (2026-10-13, phone quick wins re-slice of #2316): js/keyboard-viewport.js
// (2.9 KB). It keeps every open sheet above the iPhone keyboard (Record payment's Save sat under
// it); it must be listening before the first sheet opens, so it cannot be lazy. Own line.
CEILING.localScripts += 1;
// +1 local tag, deliberate (2026-10-11, C5): js/pipeline-rich-cards.js (window.NBDPipelineRich).
// crm-pipeline.js buildCard reads it synchronously when the board is in the rich density, and
// renderLeads paints the board strip through it — lazy-loading would paint the first board
// without the strip. Defer, no boot-time reads. Own line so parallel PRs raising the
// ceiling above merge without a conflict.
CEILING.localScripts += 1;
CEILING.localBytes += 30 * 1024;   // pipeline-rich-cards.js = 26.5 KB (LF), + ~1 KB of hooks in crm-pipeline.js / dashboard-ui.js
// +1 local tag / +24 KB, deliberate (2026-10-11, layout system D0): js/layout-system.js — the
// layout registry + LayoutEngine in ONE deferred file (the preboot half rides inside the existing
// blocking shape-preboot.js, so blockingScripts does not move). It must be on every dashboard
// load: even a Classic rep needs the company default / lock read and the layoutchange event.
// Per-layout code and CSS (Field App, Focus, ...) load lazily only for the active layout.
CEILING.localScripts += 1;
CEILING.localBytes += 24 * 1024;
// +15 KB, deliberate (2026-10-13, Today UX walk PR-B; 10 -> 15 on the restack, main had absorbed ~5 KB of other PRs' bytes): no new script. The cold-boot "checking"
// state (collected-revenue.js, home-attention.js, today-home.js), the keyed handled set, the
// 6 s Undo on every Today action and the hold-then-collapse are ~14.7 KB of deferred code in
// files already loaded; promise-ui.js (lazy) and the CSS are not counted here. Own line.
CEILING.localBytes += 15 * 1024;
// +1 local tag, deliberate (2026-10-11, CRM style integration E1): js/pixel-mode.js (Pixel Mode loader, ~3 KB).
// Deferred; on boot it reads one settings doc and stops. The skin/Party/dialog code (pixel-mode-core.js), its CSS, the
// fonts and the logic module are fetched only when the person turned something on or the Settings card scrolls into
// view, and Pixel World (E2) is lazy-loaded from the core, so this is the only boot tag. (An earlier version shipped the
// whole 18 KB inline and pushed true LF bytes past the localBytes ceiling; the loader split is why it does not.)
CEILING.localScripts += 1;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// Size with CR bytes dropped, so CRLF-checkout numbers equal CI's LF numbers.
function lfSize(file) {
  const b = fs.readFileSync(file);
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] !== 13) n++;
  return n;
}
// Minimal HTML tag tokenizer. Skips comments (even ones opened inside text), <!doctype>,
// raw-text bodies (script/style/textarea/title) and quoted attribute values, so a stray
// "<template>" or "<!--" inside an attribute or a JS string cannot desync the scan.
// Attributes land in a null-prototype map (first occurrence wins, names lower-cased).
function tokenizeTags(html) {
  const tags = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    const c = html[lt + 1] || '';
    if (c === '!' || c === '?') { const e = html.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (!/[A-Za-z\/]/.test(c)) { i = lt + 1; continue; }
    let j = lt + 1;
    const closing = html[j] === '/';
    if (closing) j++;
    const ns = j;
    while (j < n && !/[\s\/>]/.test(html[j])) j++;
    const name = html.slice(ns, j).toLowerCase();
    const attrs = Object.create(null);
    while (j < n && html[j] !== '>') {
      if (/[\s\/]/.test(html[j])) { j++; continue; }
      const as = j;
      while (j < n && !/[\s=\/>]/.test(html[j])) j++;
      const an = html.slice(as, j).toLowerCase();
      while (j < n && /\s/.test(html[j])) j++;
      let val = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        if (html[j] === '"' || html[j] === "'") {
          const q = html[j];
          const e = html.indexOf(q, j + 1);
          val = html.slice(j + 1, e < 0 ? n : e);
          j = e < 0 ? n : e + 1;
        } else {
          const vs = j;
          while (j < n && !/[\s>]/.test(html[j])) j++;
          val = html.slice(vs, j);
        }
      }
      if (an && !(an in attrs)) attrs[an] = val;
    }
    i = j + 1;
    tags.push({ name, closing, attrs, index: lt });
    if (!closing && /^(script|style|textarea|title)$/.test(name)) {
      const re = new RegExp('</' + name + '[\\s>/]', 'ig');
      re.lastIndex = i;
      const m = re.exec(html);
      i = m ? m.index : n;
    }
  }
  return tags;
}
function measure(html, root) {
  const out = {
    htmlBytes: Buffer.byteLength(html.replace(/\r/g, '')), localScripts: 0, localBytes: 0, blockingScripts: 0, blockingBytes: 0,
    templateBlockingScripts: 0, templateBlockingBytes: 0, templateFiles: [], tplDepthAtEof: 0, strayTemplateClose: 0, missing: [],
  };
  let tplDepth = 0;
  for (const t of tokenizeTags(html)) {
    if (t.name === 'template') {
      if (!t.closing) tplDepth++;
      else if (tplDepth > 0) tplDepth--;
      else out.strayTemplateClose++;
      continue;
    }
    if (t.name !== 'script' || t.closing) continue;
    const src = t.attrs.src;
    if (!src || /^(https?:)?\/\//i.test(src)) continue;
    const rel = src.split('?')[0];
    const file = path.join(root, rel.replace(/^\/pro\//, ''));
    if (!fs.existsSync(file)) { out.missing.push(src); continue; }
    const n = lfSize(file);
    out.localScripts++; out.localBytes += n;
    const blocking = !('defer' in t.attrs) && !('async' in t.attrs) && String(t.attrs.type || '').toLowerCase() !== 'module';
    if (blocking && tplDepth > 0) { out.templateBlockingScripts++; out.templateBlockingBytes += n; out.templateFiles.push(rel); }
    else if (blocking) { out.blockingScripts++; out.blockingBytes += n; }
  }
  out.tplDepthAtEof = tplDepth;
  return out;
}
console.log('\nDASHBOARD BOOT BUDGET');
const m = measure(fs.readFileSync(path.join(PRO, 'dashboard.html'), 'utf8'), PRO);
const kb = (n) => Math.round(n / 1024) + ' KB';
ok('every local script tag resolves to a file', m.missing.length === 0, m.missing.join(', '));
ok('blocking scripts: ' + m.blockingScripts + ' ≤ ' + CEILING.blockingScripts + ' (new code loads deferred or lazily)', m.blockingScripts <= CEILING.blockingScripts);
ok('blocking bytes: ' + kb(m.blockingBytes) + ' ≤ ' + kb(CEILING.blockingBytes), m.blockingBytes <= CEILING.blockingBytes);
console.log('  · template-deferred (not parser-blocking; hydrate with their view, ON BOOT for deep links like #/settings): ' + m.templateBlockingScripts + ' scripts, ' + kb(m.templateBlockingBytes));
ok('template-deferred scripts: ' + m.templateBlockingScripts + ' ≤ ' + CEILING.templateScripts, m.templateBlockingScripts <= CEILING.templateScripts);
ok('template-deferred bytes: ' + kb(m.templateBlockingBytes) + ' ≤ ' + kb(CEILING.templateBytes), m.templateBlockingBytes <= CEILING.templateBytes);
ok('<template> tags balance to depth 0 at EOF, no stray </template> (else every later script is misfiled)', m.tplDepthAtEof === 0 && m.strayTemplateClose === 0,
  'depth ' + m.tplDepthAtEof + ', stray closes ' + m.strayTemplateClose);
ok('template-deferred set is exactly the known set (a new template script is a conscious change)',
  JSON.stringify(m.templateFiles.slice().sort()) === JSON.stringify(KNOWN_TEMPLATE_SCRIPTS.slice().sort()),
  'got: ' + m.templateFiles.slice().sort().join(', '));
ok('local script tags: ' + m.localScripts + ' ≤ ' + CEILING.localScripts, m.localScripts <= CEILING.localScripts);
ok('local script bytes: ' + kb(m.localBytes) + ' ≤ ' + kb(CEILING.localBytes), m.localBytes <= CEILING.localBytes);
ok('dashboard.html: ' + kb(m.htmlBytes) + ' ≤ ' + kb(CEILING.htmlBytes), m.htmlBytes <= CEILING.htmlBytes);

// Positive controls: the counter must see what it claims to count.
const ctl = measure('<script src="js/a.js"></script><script defer src="js/a.js"></script><script type="module" src="js/a.js"></script><!-- <script src="js/a.js"></script> --><script src="https://x.test/b.js"></script>', path.join(__dirname));
ok('control: counts local tags, skips CDN + commented-out tags, splits blocking from deferred/module',
  ctl.blockingScripts === 0 && ctl.missing.length === 3 && ctl.localScripts === 0);
const real = measure('<script src="dashboard-boot-budget-2026-10-03.test.js"></script><script defer src="dashboard-boot-budget-2026-10-03.test.js"></script>', __dirname);
ok('control: a blocking tag and a deferred tag are told apart', real.localScripts === 2 && real.blockingScripts === 1);
const tplCtl = measure('<script src="dashboard-boot-budget-2026-10-03.test.js"></script><template id="a"><div><template><script src="dashboard-boot-budget-2026-10-03.test.js"></script></template><script src="dashboard-boot-budget-2026-10-03.test.js"></script></div></template><script src="dashboard-boot-budget-2026-10-03.test.js"></script>', __dirname);
ok('control: <template>-contained blocking tags (nested too) are not boot-blocking, but still count as local scripts; tags after the template block again',
  tplCtl.localScripts === 4 && tplCtl.blockingScripts === 2 && tplCtl.templateBlockingScripts === 2 && tplCtl.blockingBytes === tplCtl.templateBlockingBytes);
ok('control: the real page really has template-deferred scripts (the exclusion is exercised)', m.templateBlockingScripts >= 5);
// Tokenizer controls: each of these desynced the previous regex scan (or hid a tag from it).
const T = 'dashboard-boot-budget-2026-10-03.test.js';
const c1 = measure('<div title="<template>"></div><script src="' + T + '"></script>', __dirname);
ok('control: a "<template>" inside an attribute value does not swallow later scripts', c1.blockingScripts === 1 && c1.tplDepthAtEof === 0);
const c2 = measure('<script>var s = "<template>";</script><script src="' + T + '"></script>', __dirname);
ok('control: "<template>" inside an inline script body is ignored', c2.blockingScripts === 1 && c2.tplDepthAtEof === 0);
const c3 = measure('<script src="' + T + '" data-async-note="1" id="async-loader"></script><script src="' + T + '?mode=defer"></script>', __dirname);
ok('control: "async"/"defer" inside another attribute or the src query do not make a script non-blocking', c3.blockingScripts === 2);
const c4 = measure("<script src='" + T + "'></script><script src=" + T + "></script><script defer src=" + T + "></script><script async src='" + T + "'></script>", __dirname);
ok('control: single-quoted and unquoted src are seen; bare defer/async attributes still make them non-blocking',
  c4.localScripts === 4 && c4.blockingScripts === 2);
const c5 = measure('<div title="<!--"></div><script src="' + T + '"></script>', __dirname);
ok('control: "<!--" inside an attribute does not swallow later tags', c5.blockingScripts === 1);
const c6 = measure('<template><script src="' + T + '"></script>', __dirname);
ok('control: an unclosed <template> is detected (depth != 0 at EOF)', c6.tplDepthAtEof === 1);

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
