/**
 * tests/asset-version-consistency-2026-11-14.test.js — every `?v=` cache
 * buster for one asset agrees, wherever it is written.
 *
 * A file is referenced as `js/x.js?v=N` from <script>/<link> tags in pages,
 * from ScriptLoader bundles (docs/pro/js/script-loader.js) and from other
 * loaders that inject tags at runtime. When those disagree, a browser that
 * cached one copy keeps serving it on the page that still says the old N.
 * About 100 suites pin a single version by hand ("customer-bootstrap
 * cache-buster bumped past v=24"); this one suite checks the invariant those
 * pins stand for, for every asset, so a later PR can drop the hand pins.
 *
 * Checks (docs/**: .html, .js, .mjs, .css; JS comments ignored):
 *   1. every versioned reference resolves to a file that exists
 *   2. all versioned references to one asset carry the same version
 *      (KNOWN_DRIFT below lists the disagreements already on main; it may
 *      only shrink, and an entry whose drift is gone must be removed)
 *   3. bump-on-change, where git history is available (local runs, not the
 *      shallow CI checkout): an asset whose bytes changed since the merge base
 *      with origin/main has a new version in every reference to it
 * Paths in a page resolve from the page; a path in a JS file resolves from
 * the file's folder, else from the nearest parent folder where it exists
 * (loaders write page-relative paths: 'js/x.js' in docs/pro/js/ means
 * docs/pro/js/x.js).
 *
 * Zero deps. Run: node tests/asset-version-consistency-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const K = require('./lib/src-kit');
const T = K.suite('ASSET ?v= CONSISTENCY — one asset, one version, everywhere it is loaded');
const { ok, section } = T;

const DOCS = path.join(K.ROOT, 'docs');
const slash = (p) => p.split(path.sep).join('/');

// Disagreements already on origin/main when this suite landed (2026-11-14),
// as asset → the exact set of versions seen. Fix one by bumping every
// reference to the highest version, then delete its line here. Never add one.
const KNOWN_DRIFT = {
  'pro/js/claude-proxy.js': ['4', '5'],
  'pro/css/google-calendar.css': ['6', '9'],
  'pro/js/customer-checklist.js': ['2', '4'],
  'pro/css/landing.css': ['2', '4'],
};

/** Versioned references in one file's text: [{ url, v, line }]. */
const REF = /["'`(=]\s*((?:\.{0,2}\/)?[\w@./-]+\.(?:m?js|css))\?v=([\w.-]+)/g;
function refsIn(text, isJs) {
  const s = isJs ? K.stripJsComments(K.lf(text)) : K.lf(text);
  const out = [];
  let m;
  REF.lastIndex = 0;
  while ((m = REF.exec(s))) {
    if (/^(?:https?:)?\/\//.test(m[1])) continue;
    out.push({ url: m[1], v: m[2], line: s.slice(0, m.index).split('\n').length });
  }
  return out;
}
/** The docs-relative asset a reference points at, or null if none exists. */
function resolve(fromFile, url) {
  if (url.startsWith('/')) { const p = path.join(DOCS, url); return fs.existsSync(p) ? slash(path.relative(DOCS, p)) : null; }
  let dir = path.dirname(fromFile);
  const isJs = /\.m?js$/.test(fromFile);
  for (;;) {
    const p = path.resolve(dir, url);
    if (fs.existsSync(p)) return slash(path.relative(DOCS, p));
    if (!isJs || path.resolve(dir) === path.resolve(DOCS)) return null;
    dir = path.dirname(dir);
  }
}

section('the scanner (controls)');
{
  const r = refsIn([
    '<script defer src="js/a.js?v=3"></script><link rel="stylesheet" href="../css/b.css?v=12">',
    "bundle: ['js/c.js?v=2', 'css/d.css?v=1.2'],",
    '// old: js/e.js?v=9',
    '<script src="https://www.gstatic.com/x.js?v=1"></script>',
  ].join('\n'), true);
  ok('reads tag and loader references, skips comments and other hosts', r.map((x) => x.url + '@' + x.v).join() === 'js/a.js@3,../css/b.css@12,js/c.js@2,css/d.css@1.2', JSON.stringify(r));
  ok('a loader path resolves from the page folder above it', resolve(path.join(DOCS, 'pro/js/script-loader.js'), 'js/script-loader.js') === 'pro/js/script-loader.js');
  ok('a page path resolves from the page', resolve(path.join(DOCS, 'pro/dashboard.html'), 'js/script-loader.js') === 'pro/js/script-loader.js');
  ok('a path that exists nowhere is null', resolve(path.join(DOCS, 'pro/dashboard.html'), 'js/no-such-file.js') === null);
}

// ── scan ───────────────────────────────────────────────────────────────────
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); } else if (/\.(html?|m?js|css)$/.test(f.name) && !/\.min\.js$/.test(f.name)) files.push(p);
  }
})(DOCS);
const byAsset = {};
const dangling = [];
for (const f of files) {
  for (const r of refsIn(fs.readFileSync(f, 'utf8'), /\.m?js$/.test(f))) {
    const where = slash(path.relative(K.ROOT, f)) + ':' + r.line;
    const a = resolve(f, r.url);
    if (!a) { dangling.push(where + '  ' + r.url + '?v=' + r.v); continue; }
    (byAsset[a] = byAsset[a] || []).push({ v: r.v, where });
  }
}

section('every shipped reference');
{
  const n = Object.values(byAsset).reduce((s, x) => s + x.length, 0);
  ok('found the references (the scan is not empty): ' + n + ' to ' + Object.keys(byAsset).length + ' assets',
    n > 1000 && (byAsset['pro/js/script-loader.js'] || []).length > 0);
  ok('1. every ?v= reference points at a file that exists', dangling.length === 0,
    dangling.slice(0, 20).join('\n      ') + '\n      fix: the file was renamed or deleted; update or remove the reference.');

  const drift = [], fixed = [], changed = [];
  for (const [a, refs] of Object.entries(byAsset)) {
    const vs = [...new Set(refs.map((r) => r.v))].sort();
    const known = KNOWN_DRIFT[a];
    if (vs.length > 1 && !known) drift.push(a + ': ' + refs.map((r) => 'v=' + r.v + ' ' + r.where).join(', '));
    else if (known && vs.length <= 1) fixed.push(a);
    else if (known && vs.join() !== known.slice().sort().join()) changed.push(a + ': now ' + vs.join('/') + ', listed ' + known.join('/'));
  }
  for (const a of Object.keys(KNOWN_DRIFT)) if (!byAsset[a]) fixed.push(a + ' (no longer referenced)');
  ok('2. every asset is loaded with one version everywhere', drift.length === 0,
    drift.slice(0, 15).join('\n      ') + '\n      fix: bump EVERY reference to the asset to the same, higher version (pages and script-loader.js bundles alike).');
  ok('2b. KNOWN_DRIFT only shrinks: no entry is already fixed', fixed.length === 0,
    fixed.join(', ') + '\n      fix: delete those lines from KNOWN_DRIFT in this file.');
  ok('2c. a known drift did not grow a new version', changed.length === 0,
    changed.join('\n      ') + '\n      fix: bump every reference to one version (then delete the KNOWN_DRIFT line).');
}

section('3. a changed asset carries a new version (needs git history)');
{
  let base = null;
  try { base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: K.ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { /* shallow or no remote */ }
  if (!base) console.log('    skipped: no merge base with origin/main here (shallow CI checkout); run locally before pushing');
  else {
    const diff = execFileSync('git', ['diff', '--name-only', base, '--', 'docs'], { cwd: K.ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const stale = [];
    for (const f of diff) {
      const a = slash(path.relative(DOCS, path.join(K.ROOT, f)));
      const refs = byAsset[a];
      if (!refs) continue;
      let old = '';
      try { old = execFileSync('git', ['show', base + ':' + f], { cwd: K.ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (_) { continue; } // a new file
      if (K.lf(old) === K.lf(fs.readFileSync(path.join(K.ROOT, f), 'utf8'))) continue;
      // the versions this asset had at the merge base, from the same referencing files
      const oldV = new Set();
      for (const r of refs) {
        const rf = r.where.replace(/:\d+$/, '');
        let txt = '';
        try { txt = execFileSync('git', ['show', base + ':' + rf], { cwd: K.ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (_) { continue; }
        for (const o of refsIn(txt, /\.m?js$/.test(rf))) if (resolve(path.join(K.ROOT, rf), o.url) === a) oldV.add(o.v);
      }
      const same = refs.filter((r) => oldV.has(r.v));
      if (same.length) stale.push(a + ' changed but still v=' + same[0].v + ' at ' + same.map((r) => r.where).join(', '));
    }
    ok(diff.length + ' file(s) changed under docs/ since ' + base.slice(0, 8) + ': every changed, versioned asset was re-versioned', stale.length === 0,
      stale.join('\n      ') + '\n      fix: raise ?v= in every reference to that file.');
  }
}

T.done();
