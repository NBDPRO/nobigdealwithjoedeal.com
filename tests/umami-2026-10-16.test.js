#!/usr/bin/env node
/**
 * tests/umami-2026-10-16.test.js — Umami is prepared, OFF by default, public
 * site only (repos report item 10).
 *
 *   A. today: the loader is inert, no page loads it, the CSP admits no Umami host
 *   B. the loader itself: loads only on production, never /pro|/admin|/dev|/sites,
 *      never with Global Privacy Control or Do Not Track
 *   C. scripts/umami.mjs on a COPY: --enable tags only public pages and adds the
 *      host to public policies only; --disable puts every byte back
 *
 * Run: node tests/umami-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 300) : '')); failed++; fails.push(label); }
}
const ID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

console.log('\nA. off by default');
{
  const loader = read('docs/assets/js/umami-loader.js');
  ok('WEBSITE_ID is empty', /var WEBSITE_ID = '';/.test(loader));
  let tagged = 0;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'pagefind') walk(p); } else if (e.name.endsWith('.html') && fs.readFileSync(p, 'utf8').includes('umami-loader.js')) tagged++; } })(path.join(ROOT, 'docs'));
  ok('no page loads the loader yet', tagged === 0, tagged);
  ok('no CSP admits an Umami host', !/umami/i.test(read('firebase.json')));
}

console.log('\nB. the loader');
{
  const src = read('docs/assets/js/umami-loader.js').replace("var WEBSITE_ID = '';", "var WEBSITE_ID = '" + ID + "';");
  function run(o) {
    const added = [];
    const doc = { createElement: () => { const a = {}; return { set defer(v) { a.defer = v; }, set src(v) { a.src = v; }, setAttribute: (k, v) => { a[k] = v; }, a }; }, head: { appendChild: (n) => added.push(n.a) } };
    const ctx = { location: { hostname: o.host || 'nobigdealwithjoedeal.com', pathname: o.path || '/' }, navigator: { globalPrivacyControl: o.gpc, doNotTrack: o.dnt }, window: {}, document: doc };
    vm.createContext(ctx); vm.runInContext(src, ctx);
    return added;
  }
  const a = run({});
  ok('on production, a public page loads Umami with the website ID, DNT honoured', a.length === 1 && a[0].src === 'https://cloud.umami.is/script.js' && a[0]['data-website-id'] === ID && a[0]['data-do-not-track'] === 'true', JSON.stringify(a));
  ok('never on /pro, /admin, /dev, /sites', ['/pro/dashboard', '/admin', '/dev/x', '/sites/oaks'].every((p) => run({ path: p }).length === 0));
  ok('never on a preview, localhost or the emulator', ['nobigdeal-pro.web.app', 'localhost', '127.0.0.1'].every((h) => run({ host: h }).length === 0));
  ok('never with Global Privacy Control or Do Not Track', run({ gpc: true }).length === 0 && run({ dnt: '1' }).length === 0);
  const off = read('docs/assets/js/umami-loader.js');
  const ctx = { location: { hostname: 'nobigdealwithjoedeal.com', pathname: '/' }, navigator: {}, window: {}, document: { createElement() { throw new Error('should not load'); }, head: {} } };
  vm.createContext(ctx);
  let threw = false; try { vm.runInContext(off, ctx); } catch (_) { threw = true; }
  ok('with no website ID it does nothing at all', !threw);
}

console.log('\nC. enable / disable on a copy');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-umami-'));
  const put = (rel, body) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  const CL = '<script defer src="/assets/js/clarity-loader.js"></script>';
  const files = {
    'docs/index.html': '<html>\r\n<head>\r\n' + CL + '\r\n</head><body></body></html>\r\n',
    'docs/services/roof-repair.html': '<html>\n<head>\n' + CL + '\n</head></html>\n',
    'docs/about.html': '<html><head></head></html>',
    'docs/pro/dashboard.html': '<html><head>' + CL + '</head></html>',
    'docs/sites/oaks/index.html': '<html><head>' + CL + '</head></html>',
    'docs/assets/js/umami-loader.js': read('docs/assets/js/umami-loader.js'),
    'firebase.json': read('firebase.json'),
  };
  for (const [k, v] of Object.entries(files)) put(k, v);
  const umami = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/umami.mjs')].concat(args), { env: Object.assign({}, process.env, { NBD_REPO_ROOT: tmp }), encoding: 'utf8' });
  const r1 = umami(['--enable', ID]);
  ok('--enable runs', r1.status === 0, r1.stderr + r1.stdout);
  const got = (rel) => fs.readFileSync(path.join(tmp, rel), 'utf8');
  const TAG = '<script defer src="/assets/js/umami-loader.js"></script>';
  ok('public pages with the Clarity tag get the Umami tag right after it, EOL kept', got('docs/index.html').includes(CL + '\r\n' + TAG + '\r\n') && got('docs/services/roof-repair.html').includes(CL + '\n' + TAG + '\n'));
  ok('/pro and /sites pages never get it; a page without the Clarity tag neither', !got('docs/pro/dashboard.html').includes(TAG) && !got('docs/sites/oaks/index.html').includes(TAG) && !got('docs/about.html').includes(TAG));
  ok('the loader has the ID', got('docs/assets/js/umami-loader.js').includes("var WEBSITE_ID = '" + ID + "';"));
  const fb = JSON.parse(got('firebase.json'));
  const pol = (src, key) => ((fb.hosting.headers.find((r) => r.source === src) || {}).headers || []).find((h) => h.key === key);
  const star = pol('**', 'Content-Security-Policy').value;
  const dir = (v, d) => (v.split(';').map((x) => x.trim()).find((x) => x.split(/\s+/)[0] === d) || '');
  ok('the public policy admits cloud.umami.is in script-src, script-src-elem and connect-src', ['script-src', 'script-src-elem', 'connect-src'].every((d) => / https:\/\/cloud\.umami\.is(\s|$)/.test(dir(star, d))));
  ok('…and nowhere else in that policy', !/umami/.test(dir(star, 'img-src')) && !/umami/.test(dir(star, 'frame-src')));
  ok('the /pro, /admin, /dev, /sites policies never get it', !/umami/.test(pol('/@(pro|admin|dev|sites)/**', 'Content-Security-Policy').value));
  const r2 = umami(['--disable']);
  ok('--disable runs', r2.status === 0, r2.stderr + r2.stdout);
  ok('--disable puts every file back byte for byte', Object.entries(files).every(([k, v]) => got(k) === v), Object.keys(files).filter((k) => got(k) !== files[k]).join(', '));
  const r3 = umami(['--enable', 'not-a-uuid']);
  ok('a bad website ID is refused and nothing changes', r3.status !== 0 && Object.entries(files).every(([k, v]) => got(k) === v));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
