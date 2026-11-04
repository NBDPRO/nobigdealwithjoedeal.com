#!/usr/bin/env node
/**
 * scripts/minify-shipped.js — shrink the CRM's first-party JS and CSS at
 * DEPLOY time (repos-for-crm-and-site report 2026-10-16, item 1).
 *
 * docs/ stays the readable source of truth: every test, grep gate and review
 * reads it as committed. Only the deploy job's runner checkout is rewritten,
 * right before `firebase deploy --only hosting`, and the job restores
 * docs/pro straight after (the function smoke gate later in that job greps
 * the readable source). ci.yml's pro-demo-zero-network job runs the same
 * command and then walks the demo again, so what ships is what gets tested.
 *
 * What it does to a file (esbuild, version pinned below):
 *   - minifyWhitespace + minifySyntax. minifyIdentifiers is OFF: no global,
 *     top-level function, property or window.* name is shortened, so classic
 *     <script>s still see each other's declarations.
 *   - keepNames is ON, and it is load-bearing. Even without identifier
 *     minification esbuild drops the name of a function expression
 *     (`debounce(function save(){})` -> `debounce(function(){})`, so fn.name
 *     becomes '' and crm-leads.js's debounce() would key every such timer as
 *     'default') and renames a few to dodge collisions (`b` -> `b2`).
 *     keepNames restores every function/class .name with a tiny __name()
 *     helper (`var __defProp`/`var __name` at the top of each file: plain
 *     vars, so classic scripts redeclaring them is harmless).
 *   - JS target 'safari15'. The source already needs Safari 15 (top-level
 *     await) and nothing in docs/pro is lowered at that target (checked:
 *     output identical to esnext apart from the class form below). The pin
 *     matters for keepNames: at esnext it would name classes with
 *     `static {}` blocks, a syntax error before Safari 16.4 that would kill
 *     a whole file on an older homeowner iPhone; at safari15 it writes
 *     `const _X = class _X {}; __name(_X, "X"); let X = _X;` instead.
 *     CSS keeps target 'esnext' so no -webkit- prefixes are added (that would
 *     change how iOS renders, which this step must never do).
 *   - No bundling, no format change (ES modules stay modules, classic
 *     scripts stay classic), no tree shaking.
 *   - charset utf8 (no \u escapes inflating emoji/labels), legal comments
 *     (/*! … *\/, @license) kept inline.
 *   - If minifying would not make a file smaller, the file is left alone.
 *
 * Scope: docs/pro/**\/*.{js,mjs,css}, and docs/assets/{css,js}/**\/*.{js,css} (the public site), except
 *   - anything under a vendor/ or node_modules/ directory, and *.min.js/css
 *     (third-party, already minified);
 *   - the three service workers (docs/pro/sw.js, firebase-messaging-sw.js,
 *     explore/demo-sw.js): browsers update a worker when its bytes change and
 *     their cache-version constants are read by tests; they are small;
 *   - docs/assets/js/inline/*.js, named by a hash of their source.
 * Nothing else is touched: pages, images, fonts, docs/assets/vendor and data
 * stay as committed. The public CSS/JS keep their 24 h cache rule
 * (firebase.json); a changed file revalidates by ETag like any other deploy.
 *
 * Cache-busting: pages keep their ?v= query strings. JS/CSS are served
 * `max-age=0, must-revalidate` with ETags (firebase.json), and the CRM's
 * service worker revalidates them (304s), so the first load after the first
 * minified deploy downloads the smaller files once. No precache list names a
 * hash (docs/pro/sw.js precaches only manifest.json + offline.html), and no
 * page carries SRI integrity= hashes, so nothing needs regenerating.
 *
 * Source maps: never written next to the files, never served, and no
 * `//# sourceMappingURL` comment is added. With --maps-dir the deploy writes
 * them to the runner's temp dir and uploads them as a workflow artifact, so a
 * Sentry stack frame (line 1, column N; function names are intact) can be
 * mapped back by hand.
 *
 * Usage:
 *   node scripts/minify-shipped.js --install           # fetch the pinned esbuild
 *   node scripts/minify-shipped.js --write [--maps-dir DIR] [--json FILE]
 *   node scripts/minify-shipped.js                      # dry run: sizes only
 *   node scripts/minify-shipped.js --print-esbuild-version
 *
 * esbuild is found, in order: $NBD_ESBUILD_DIR (a dir holding
 * node_modules/esbuild), the --install dir (<os tmp>/nbd-esbuild-<version>),
 * then tests/node_modules. The version must equal ESBUILD_VERSION exactly.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ESBUILD_VERSION = '0.28.2';
const REPO = path.join(__dirname, '..');
const DOCS = path.join(REPO, 'docs');
// The CRM, and (2026-10-27, PageSpeed mobile 86: "Minify CSS 52 KiB / JS 9 KiB") the public site's own CSS and JS.
const SCOPES = [path.join(DOCS, 'pro'), path.join(DOCS, 'assets', 'css'), path.join(DOCS, 'assets', 'js')];
const SERVICE_WORKERS = new Set(['pro/sw.js', 'pro/firebase-messaging-sw.js', 'pro/explore/demo-sw.js']);

function defaultInstallDir() { return path.join(os.tmpdir(), 'nbd-esbuild-' + ESBUILD_VERSION); }

function loadEsbuild() {
  const dirs = [process.env.NBD_ESBUILD_DIR, defaultInstallDir(), path.join(REPO, 'tests')].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, 'node_modules', 'esbuild');
    if (!fs.existsSync(path.join(p, 'package.json'))) continue;
    const eb = require(p);
    if (eb.version !== ESBUILD_VERSION) {
      throw new Error('esbuild at ' + p + ' is ' + eb.version + ', pinned ' + ESBUILD_VERSION + ' (run: node scripts/minify-shipped.js --install)');
    }
    return eb;
  }
  return null;
}

function install(dir) {
  const { execSync } = require('child_process');
  fs.mkdirSync(dir, { recursive: true });
  execSync('npm install --no-save --no-package-lock --no-audit --no-fund --silent --prefix "' + dir + '" esbuild@' + ESBUILD_VERSION,
    { stdio: 'inherit', shell: true });
  const eb = require(path.join(dir, 'node_modules', 'esbuild'));
  if (eb.version !== ESBUILD_VERSION) throw new Error('installed esbuild ' + eb.version + ' != ' + ESBUILD_VERSION);
  console.log('esbuild ' + eb.version + ' installed in ' + dir);
}

// rel is relative to docs/, forward slashes ("pro/js/crm.js").
function shouldMinify(rel) {
  rel = rel.replace(/\\/g, '/');
  if (!/^(pro\/|assets\/(css|js)\/)/.test(rel)) return false;
  // assets/js/inline/<hash>.js are the externalised inline scripts, named by a hash of their source.
  if (rel.startsWith('assets/js/inline/')) return false;
  if (!/\.(m?js|css)$/.test(rel)) return false;
  if (/\.min\.(js|css)$/.test(rel)) return false;
  if (/(^|\/)(vendor|node_modules)\//.test(rel)) return false;
  if (SERVICE_WORKERS.has(rel)) return false;
  return true;
}

const OPTIONS = Object.freeze({
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  keepNames: true,
  treeShaking: false,
  charset: 'utf8',
  legalComments: 'inline',
});

// Returns { code, map } — code is the original source when minifying would not shrink it.
function minifySource(esbuild, src, rel, withMap) {
  const loader = rel.endsWith('.css') ? 'css' : 'js';
  const r = esbuild.transformSync(src, Object.assign({}, OPTIONS, {
    loader, sourcefile: rel.replace(/\\/g, '/'), sourcemap: withMap ? 'external' : false,
    target: loader === 'css' ? 'esnext' : 'safari15',
  }));
  if (Buffer.byteLength(r.code) >= Buffer.byteLength(src)) return { code: src, map: null, skipped: true };
  return { code: r.code, map: withMap ? r.map : null, skipped: false };
}

function listFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

function sizes(buf) {
  return {
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--print-esbuild-version')) { process.stdout.write(ESBUILD_VERSION + '\n'); return 0; }
  if (argv.includes('--install')) { install(arg('--install') && !arg('--install').startsWith('--') ? arg('--install') : defaultInstallDir()); return 0; }
  const write = argv.includes('--write');
  const mapsDir = arg('--maps-dir');
  const jsonOut = arg('--json');
  const esbuild = loadEsbuild();
  if (!esbuild) { console.error('esbuild ' + ESBUILD_VERSION + ' not found. Run: node scripts/minify-shipped.js --install'); return 2; }

  const files = SCOPES.reduce((all, dir) => listFiles(dir, all), []).filter((f) => shouldMinify(path.relative(DOCS, f)));
  const tot = { files: 0, skipped: 0, before: { raw: 0, gzip: 0, brotli: 0 }, after: { raw: 0, gzip: 0, brotli: 0 } };
  const failures = [];
  const pending = [];
  for (const f of files) {
    const rel = path.relative(DOCS, f).replace(/\\/g, '/');
    const src = fs.readFileSync(f, 'utf8');
    let res;
    try { res = minifySource(esbuild, src, rel, !!mapsDir); } catch (e) { failures.push(rel + ': ' + String(e.message).split('\n').slice(0, 3).join(' ')); continue; }
    const b = sizes(Buffer.from(src.replace(/\r/g, ''))), a = sizes(Buffer.from(res.code));
    for (const k of ['raw', 'gzip', 'brotli']) { tot.before[k] += b[k]; tot.after[k] += a[k]; }
    tot.files++;
    if (res.skipped) { tot.skipped++; continue; }
    pending.push({ f, rel, res });
  }
  // All or nothing: a single failure leaves every file readable, so a half-minified tree never ships.
  if (failures.length) { console.error('FAILED to minify ' + failures.length + ' file(s); nothing was written:\n  ' + failures.join('\n  ')); return 1; }
  if (write) {
    for (const { f, rel, res } of pending) {
      fs.writeFileSync(f, res.code);
      if (mapsDir && res.map) {
        const mp = path.join(mapsDir, rel + '.map');
        fs.mkdirSync(path.dirname(mp), { recursive: true });
        fs.writeFileSync(mp, res.map);
      }
    }
  }
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  console.log((write ? 'Minified ' : 'Would minify ') + tot.files + ' files under docs/pro and docs/assets/{css,js} (' + tot.skipped + ' left as-is) with esbuild ' + esbuild.version);
  for (const k of ['raw', 'gzip', 'brotli']) {
    console.log('  ' + k.padEnd(6) + ' ' + kb(tot.before[k]).padStart(9) + ' -> ' + kb(tot.after[k]).padStart(9) +
      '  (-' + Math.round(100 - (100 * tot.after[k]) / tot.before[k]) + '%)');
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(tot, null, 2));
  return 0;
}

module.exports = { ESBUILD_VERSION, OPTIONS, loadEsbuild, shouldMinify, minifySource, defaultInstallDir };
if (require.main === module) process.exit(main(process.argv.slice(2)));
