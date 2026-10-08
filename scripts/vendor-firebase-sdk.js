#!/usr/bin/env node
/**
 * scripts/vendor-firebase-sdk.js — self-host the Firebase JS SDK.
 *
 * WHY (2026-10-04)
 * ────────────────
 * The site imported the SDK from https://www.gstatic.com/firebasejs/10.12.2/
 * in ~180 places. Cross-origin, so the CRM's service worker never cached it
 * (an installed-app cold start offline had no SDK at all), every page paid a
 * third-party connection, and the version was a string copied into 80 files.
 * The SDK now lives same-origin under docs/assets/vendor/firebase/<ver>/ and
 * every reference points there; one version, one place.
 *
 * The npm `firebase` package ships the SAME standalone ESM bundles gstatic
 * serves, at its package root (firebase-app.js, firebase-auth.js, …). Each
 * bundle imports firebase-app.js by its absolute gstatic URL; that import is
 * rewritten to a sibling-relative './firebase-app.js' — load-bearing: if
 * firebase-auth.js pulled gstatic's app while the page imported the vendored
 * one, there would be TWO app registries and getAuth(app) would throw.
 *
 *   node scripts/vendor-firebase-sdk.js <version> <path/to/extracted/npm/package>
 *        writes docs/assets/vendor/firebase/<version>/
 *   node scripts/vendor-firebase-sdk.js --rewrite <fromPrefix> <toPrefix>
 *        rewrites every reference under docs/ and tests/ (EOL-preserving)
 *
 * Gate: tests/firebase-sdk-vendored-2026-10-04.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'docs', 'assets', 'vendor', 'firebase');
// The modules the site imports, plus the compat pair the messaging service
// worker loads with importScripts().
const FILES = [
  'firebase-app.js', 'firebase-app-check.js', 'firebase-auth.js', 'firebase-firestore.js',
  'firebase-functions.js', 'firebase-storage.js', 'firebase-messaging.js',
  'firebase-app-compat.js', 'firebase-messaging-compat.js',
];

/** Rewrite one bundle's absolute gstatic imports to sibling-relative ones; drop the source-map pointer. */
function relink(src, version) {
  const abs = new RegExp('https://www\\.gstatic\\.com/firebasejs/' + version.replace(/\./g, '\\.') + '/(firebase-[a-z-]+\\.js)', 'g');
  return src.replace(abs, './$1').replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n');
}

function vendor(version, pkgDir) {
  const out = path.join(VENDOR, version);
  fs.mkdirSync(out, { recursive: true });
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(pkgDir, f), 'utf8');
    fs.writeFileSync(path.join(out, f), relink(src, version));
  }
  const lic = path.join(pkgDir, 'LICENSE');
  const credit = 'Firebase JS SDK ' + version + ' — standalone ESM bundles from the npm `firebase` package\n'
    + '(package root), vendored by scripts/vendor-firebase-sdk.js. Apache-2.0.\n'
    + 'Inner gstatic imports rewritten to sibling-relative paths; nothing else changed.\n\n'
    + (fs.existsSync(lic) ? fs.readFileSync(lic, 'utf8') : 'See https://github.com/firebase/firebase-js-sdk/blob/main/LICENSE\n');
  fs.writeFileSync(path.join(out, 'CREDIT.txt'), credit);
  console.log('vendored ' + FILES.length + ' files → ' + path.relative(ROOT, out));
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.') || ent.name === 'test-results') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (p !== VENDOR) walk(p, out); }
    else if (/\.(js|mjs|html)$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** Literal prefix rewrite across docs/ and tests/, preserving each file's EOL bytes. */
function rewrite(from, to) {
  let files = 0, hits = 0;
  for (const f of [...walk(path.join(ROOT, 'docs')), ...walk(path.join(ROOT, 'tests'))]) {
    const s = fs.readFileSync(f, 'utf8');
    if (!s.includes(from)) continue;
    const n = s.split(from).length - 1;
    fs.writeFileSync(f, s.split(from).join(to));
    files++; hits += n;
  }
  console.log('rewrote ' + hits + ' reference(s) in ' + files + ' file(s): ' + from + ' → ' + to);
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === '--rewrite' && a[1] && a[2]) rewrite(a[1], a[2]);
  else if (a[0] && a[1]) vendor(a[0], a[1]);
  else { console.error('usage: vendor-firebase-sdk.js <version> <pkgDir> | --rewrite <from> <to>'); process.exit(2); }
}

module.exports = { relink, FILES, VENDOR };
