/**
 * tests/firebase-sdk-vendored-2026-10-04.test.js
 *
 * The Firebase JS SDK is self-hosted under docs/assets/vendor/firebase/<ver>/
 * (scripts/vendor-firebase-sdk.js) instead of imported cross-origin from
 * www.gstatic.com in ~180 places. What this pins:
 *
 *   - no page or script under docs/ imports the SDK from gstatic any more
 *     (a straggler would load a SECOND copy of the SDK with its own app
 *     registry — getAuth()/getFirestore() on the other copy's app throws);
 *   - every reference names ONE version, and every referenced file exists;
 *   - inside the vendored bundles, every import is sibling-relative and
 *     resolves (the absolute gstatic import of firebase-app.js was rewritten);
 *   - every symbol the site imports by name is actually exported by the
 *     vendored module — a version bump that drops an API fails here, not on
 *     a phone;
 *   - relink() behaviour; CREDIT.txt carries the version + licence; Hosting
 *     caches the versioned path immutably.
 *
 * Run: node tests/firebase-sdk-vendored-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const vendorMod = require(path.join(ROOT, 'scripts', 'vendor-firebase-sdk.js'));
const VENDOR = vendorMod.VENDOR;

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const versions = fs.existsSync(VENDOR) ? fs.readdirSync(VENDOR).filter((d) => /^\d+\.\d+\.\d+$/.test(d)) : [];
const files = walk(DOCS).filter((f) => !f.startsWith(VENDOR + path.sep));

console.log('\nNO GSTATIC SDK LEFT');
{
  const left = files.filter((f) => /gstatic\.com\/firebasejs/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  ok('no docs/ file references www.gstatic.com/firebasejs', left.length === 0, left.join(', '));
}
{
  // E2E specs that page.evaluate(import(<sdk>)) must import the SAME copy the
  // page loaded: a gstatic import there is a second SDK whose collection() rejects
  // the page's Firestore ("Expected first argument to collection() to be a
  // CollectionReference…") — 5 specs added on main after #2155 failed @gauntlet
  // and @shard2 this way (2026-10-05). fixtures/local-sdk.js only ROUTES gstatic.
  const E2E = path.join(ROOT, 'tests', 'e2e');
  const specs = walk(E2E).filter((p) => rel(p) !== 'tests/e2e/fixtures/local-sdk.js');
  const bad = specs.filter((p) => /import\(\s*['"]https:\/\/www\.gstatic\.com\/firebasejs/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  ok('no E2E spec/fixture imports the SDK from gstatic (one SDK copy per page)', specs.length >= 50 && bad.length === 0, bad.join(', ') || String(specs.length));
}

console.log('\nONE VERSION, EVERY FILE PRESENT');
const refRe = /\/assets\/vendor\/firebase\/(\d+\.\d+\.\d+)(?:\/(firebase-[a-z-]+\.js))?/g;
const refs = [];
for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(refRe)) refs.push({ file: rel(f), ver: m[1], mod: m[2] || null });
{
  const vs = [...new Set(refs.map((r) => r.ver))];
  ok('the site references the vendored SDK (≥150 references)', refs.length >= 150, String(refs.length));
  ok('exactly one SDK version is referenced', vs.length === 1, vs.join(', '));
  ok('exactly one version is vendored, and it is the referenced one', versions.length === 1 && versions[0] === vs[0], versions.join(', '));
  const missing = [...new Set(refs.filter((r) => r.mod && !fs.existsSync(path.join(VENDOR, r.ver, r.mod))).map((r) => r.ver + '/' + r.mod))];
  ok('every referenced module file exists', missing.length === 0, missing.join(', '));
  const used = [...new Set(refs.filter((r) => r.mod).map((r) => r.mod))].sort();
  ok('the vendored file set covers every module the site uses', used.every((m) => vendorMod.FILES.includes(m)), used.join(', '));
}

const ver = versions[0];
const dir = ver ? path.join(VENDOR, ver) : null;

console.log('\nVENDORED BUNDLES ARE SELF-CONTAINED');
{
  const bad = [];
  for (const f of vendorMod.FILES) {
    const p = dir && path.join(dir, f);
    if (!p || !fs.existsSync(p)) { bad.push(f + ' missing'); continue; }
    const s = fs.readFileSync(p, 'utf8');
    if (/https?:\/\/www\.gstatic\.com\/firebasejs/.test(s)) bad.push(f + ' still imports gstatic');
    for (const m of s.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!/^\.\/firebase-[a-z-]+\.js$/.test(spec)) bad.push(f + ' imports ' + spec);
      else if (!fs.existsSync(path.join(dir, spec))) bad.push(f + ' → ' + spec + ' (missing)');
    }
  }
  ok('every import inside the vendored SDK is ./firebase-*.js and resolves', bad.length === 0, bad.join('; '));
  const credit = dir && fs.existsSync(path.join(dir, 'CREDIT.txt')) ? fs.readFileSync(path.join(dir, 'CREDIT.txt'), 'utf8') : '';
  ok('CREDIT.txt names the version and the Apache-2.0 licence', credit.includes(ver) && /Apache/.test(credit));
}

console.log('\nEVERY NAMED IMPORT IS EXPORTED BY THE VENDORED MODULE');
{
  const exportsOf = {};
  const exportedNames = (mod) => {
    if (exportsOf[mod]) return exportsOf[mod];
    const s = fs.readFileSync(path.join(dir, mod), 'utf8');
    const names = new Set();
    for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim(); if (!t) continue;
        const asM = t.match(/\bas\s+([\w$]+)$/);
        names.add(asM ? asM[1] : t);
      }
    }
    for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) names.add(m[1]);
    return (exportsOf[mod] = names);
  };
  const missing = [];
  let checked = 0;
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\/assets\/vendor\/firebase\/[\d.]+\/(firebase-[a-z-]+\.js)["']/g)) {
      const names = exportedNames(m[2]);
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim();
        if (!n) continue;
        checked++;
        if (!names.has(n)) missing.push(rel(f) + ': ' + n + ' from ' + m[2]);
      }
    }
  }
  ok('named imports checked (' + checked + ')', checked >= 100);
  ok('every one is exported by the vendored ' + ver + ' module', missing.length === 0, [...new Set(missing)].slice(0, 15).join('; '));
  // Positive control: the export parser sees a real export and rejects a fake.
  ok('control: firebase-app exports initializeApp and not definitelyNotAnApi', exportedNames('firebase-app.js').has('initializeApp') && !exportedNames('firebase-app.js').has('definitelyNotAnApi'));
}

console.log('\nRELINK + HOSTING');
{
  const out = vendorMod.relink('import{a}from"https://www.gstatic.com/firebasejs/9.9.9/firebase-app.js";x();\n//# sourceMappingURL=firebase-auth.js.map\n', '9.9.9');
  ok('relink: absolute gstatic import → ./firebase-app.js', out.includes('from"./firebase-app.js"'));
  ok('relink: source-map pointer dropped (maps are not shipped)', !/sourceMappingURL/.test(out));
  ok('relink: another version\'s URL is left alone (no silent cross-version mix)', vendorMod.relink('"https://www.gstatic.com/firebasejs/1.0.0/firebase-app.js"', '9.9.9').includes('gstatic'));
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const h = (fb.hosting.headers || []).find((x) => x.source === '/assets/vendor/firebase/**');
  ok('Hosting caches /assets/vendor/firebase/** immutably', !!h && h.headers.some((k) => k.key === 'Cache-Control' && /immutable/.test(k.value)));
  const idx = fb.hosting.headers.findIndex((x) => x.source === '/assets/vendor/firebase/**');
  const jsIdx = fb.hosting.headers.findIndex((x) => x.source === '**/*.@(js|css)');
  ok('…declared AFTER the **/*.js max-age=0 rule (later rules win)', idx > jsIdx && jsIdx >= 0);
  const sw = fs.readFileSync(path.join(DOCS, 'pro', 'firebase-messaging-sw.js'), 'utf8');
  ok('messaging service worker importScripts the vendored compat builds', /importScripts\('\/assets\/vendor\/firebase\/[\d.]+\/firebase-app-compat\.js'\)/.test(sw) && /firebase-messaging-compat\.js/.test(sw));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
