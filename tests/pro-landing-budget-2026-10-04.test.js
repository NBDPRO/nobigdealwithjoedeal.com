/**
 * tests/pro-landing-budget-2026-10-04.test.js — byte budgets for the /pro
 * product page (docs/pro/index.html), rebuilt 2026-10-04.
 *
 * WHY: the old page was an 83 KB HTML file with ~1,060 lines of inline CSS and
 * hand-styled mockups. The rebuild moved the CSS to docs/pro/css/landing.css,
 * kept one deferred landing-page.js, and shows real phone captures of the CRM.
 * These budgets keep it fast on a phone on a roof (mobile LCP < 2.5 s, CLS <
 * 0.05 when measured 2026-10-04):
 *   HTML ≤ 45 KB · CSS ≤ 28 KB · JS ≤ 5 KB
 *   (CSS was 25 KB until the 2026-10-05 visual pass added the tabbed tour,
 *   browser + phone frames and the paper band: 25.7 KB raw, ~6 KB gzipped.)
 *   hero image (eager) ≤ 60 KB · every other image lazy, ≤ 45 KB each
 *   all images together ≤ 600 KB
 *   width + height on every <img>; no inline <style>, <script> or on*=.
 *
 * Pure Node. Run: node tests/pro-landing-budget-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const KB = 1024;

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// Pure: audit a landing page's HTML + the bytes of what it references.
// sizeOf(urlPath) → bytes or null (missing).
function audit(html, sizeOf) {
  const out = { problems: [] };
  const p = (m) => out.problems.push(m);
  out.htmlBytes = Buffer.byteLength(html, 'utf8');
  if (out.htmlBytes > 45 * KB) p('HTML is ' + out.htmlBytes + ' bytes (budget 45 KB)');
  if (/<style[\s>]/i.test(html)) p('inline <style> block');
  if (/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, ''))) p('inline on*= handler');
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  scripts.forEach((s) => {
    if (/type="application\/ld\+json"/.test(s)) return;
    if (!/\ssrc="/.test(s)) p('inline <script>: ' + s);
  });
  const css = (html.match(/<link[^>]+rel="stylesheet"[^>]+href="(\/pro\/css\/landing\.css)[^"]*"/) || [])[1];
  if (!css) p('landing.css is not linked');
  else { const n = sizeOf(css); if (n == null) p('landing.css missing'); else if (n > 28 * KB) p('landing.css is ' + n + ' bytes (budget 28 KB)'); }
  const js = (html.match(/<script defer src="(\/pro\/js\/landing-page\.js)[^"]*"><\/script>/) || [])[1];
  if (!js) p('landing-page.js is not loaded with defer');
  else { const n = sizeOf(js); if (n == null) p('landing-page.js missing'); else if (n > 5 * KB) p('landing-page.js is ' + n + ' bytes (budget 5 KB)'); }
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  out.imgCount = imgs.length;
  let total = 0, eager = 0;
  imgs.forEach((tag, i) => {
    const src = (tag.match(/\ssrc="([^"]+)"/) || [])[1];
    if (!/\swidth="\d+"/.test(tag) || !/\sheight="\d+"/.test(tag)) p('img without width+height: ' + src);
    const lazy = /\sloading="lazy"/.test(tag);
    const n = src ? sizeOf(src.split('?')[0]) : null;
    if (n == null) { p('img missing on disk: ' + src); return; }
    total += n;
    if (i === 0) {
      if (lazy) p('the hero image must load eagerly');
      if (n > 60 * KB) p('hero image ' + src + ' is ' + n + ' bytes (budget 60 KB)');
    } else {
      if (!lazy) { eager++; p('below-the-fold image not lazy: ' + src); }
      if (n > 45 * KB) p(src + ' is ' + n + ' bytes (budget 45 KB)');
    }
  });
  out.imgBytes = total;
  if (total > 600 * KB) p('images total ' + total + ' bytes (budget 600 KB)');
  return out;
}

const sizeOnDisk = (u) => {
  const f = path.join(DOCS, u.replace(/^\//, ''));
  return fs.existsSync(f) ? fs.statSync(f).size : null;
};

console.log('\n/pro landing budgets (live tree)');
{
  const html = fs.readFileSync(path.join(DOCS, 'pro/index.html'), 'utf8');
  const r = audit(html, sizeOnDisk);
  ok('no budget or CSP problems', r.problems.length === 0, r.problems.join('; '));
  ok('the page shows real captures (≥ 8 images)', r.imgCount >= 8, 'found ' + r.imgCount);
  console.log('    html ' + r.htmlBytes + ' B · ' + r.imgCount + ' images · ' + r.imgBytes + ' B of images');
}

console.log('\nthe auditor can go red (fixtures)');
{
  const good = '<link rel="stylesheet" href="/pro/css/landing.css?v=1"><script defer src="/pro/js/landing-page.js?v=2"></script>'
    + '<img src="/h.webp" width="1" height="1"><img src="/a.webp" width="1" height="1" loading="lazy">';
  const sizes = { '/pro/css/landing.css': 10 * KB, '/pro/js/landing-page.js': 2 * KB, '/h.webp': 50 * KB, '/a.webp': 40 * KB };
  const sz = (o) => (u) => (u in o ? o[u] : null);
  ok('a page inside every budget passes', audit(good, sz(sizes)).problems.length === 0, audit(good, sz(sizes)).problems.join('; '));
  ok('a 61 KB hero fails', audit(good, sz({ ...sizes, '/h.webp': 61 * KB })).problems.some((m) => /hero image/.test(m)));
  ok('a 46 KB lazy image fails', audit(good, sz({ ...sizes, '/a.webp': 46 * KB })).problems.some((m) => /a\.webp is/.test(m)));
  ok('29 KB of CSS fails', audit(good, sz({ ...sizes, '/pro/css/landing.css': 29 * KB })).problems.some((m) => /landing\.css is/.test(m)));
  ok('6 KB of JS fails', audit(good, sz({ ...sizes, '/pro/js/landing-page.js': 6 * KB })).problems.some((m) => /landing-page\.js is/.test(m)));
  ok('an image without height fails', audit(good.replace('height="1" loading', 'loading'), sz(sizes)).problems.some((m) => /width\+height/.test(m)));
  ok('a below-the-fold image that is not lazy fails', audit(good.replace(' loading="lazy"', ''), sz(sizes)).problems.some((m) => /not lazy/.test(m)));
  ok('an inline <style> fails', audit(good + '<style>a{}</style>', sz(sizes)).problems.some((m) => /inline <style>/.test(m)));
  ok('an inline script fails', audit(good + '<script>x()</script>', sz(sizes)).problems.some((m) => /inline <script>/.test(m)));
  ok('an onclick fails', audit(good + '<button onclick="x()">', sz(sizes)).problems.some((m) => /on\*=/.test(m)));
  ok('46 KB of HTML fails', audit(good + ' '.repeat(46 * KB), sz(sizes)).problems.some((m) => /^HTML is/.test(m)));
  const many = good + Array.from({ length: 15 }, (_, i) => '<img src="/a.webp" width="1" height="1" loading="lazy">').join('');
  ok('over 600 KB of images fails', audit(many, sz(sizes)).problems.some((m) => /images total/.test(m)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
