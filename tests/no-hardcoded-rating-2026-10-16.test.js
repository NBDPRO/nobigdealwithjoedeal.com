/**
 * tests/no-hardcoded-rating-2026-10-16.test.js — no hard-coded Google rating
 * or review count anywhere on the public site.
 *
 * WHY: Facts & Credentials (vault, Jo 2026-10-14): "Google rating: use the
 * live number, don't hard-code it." #2462 made the rating and count hooks
 * ship EMPTY (google-reviews-widget.js hydrateStaticHooks reveals them only
 * with a live count and a rating > 0). The 2026-10-16 sweep found the claim
 * still hard-coded in text: "5-Star Rated" on 16 blog CTAs and 10 service
 * trust rows, "5-star rated" in 14 service proof lists, and /review's title,
 * description and social share copy ("5-Star Cincinnati Roofer", "5-star
 * rated"). They now say "Real Google reviews" with no number.
 *
 * Fails on, anywhere in the PUBLIC TREE (docs/ minus pro/, admin/, sites/,
 * dev/ and vendored libraries; plus site-src/partials), comments stripped:
 *   1. a star-rating claim in words: "5-star rated", "5-Star Roofer",
 *      "five-star contractor", "5.0 stars", "4.9 on Google", "rated 5.0" …
 *   2. a hard-coded review count: "31 Google reviews", "29 five-star reviews"
 *   3. JSON-LD aggregateRating or reviewCount (no build step generates them
 *      from real data, so any copy is hand-typed; a Review's own reviewRating
 *      is allowed: it is one real review's stars)
 *   4. a live hook that ships a value: data-nbd-gr-rating / data-nbd-gr-total
 *      with text inside, or a data-nbd-gr-rating-wrap / -total-wrap without
 *      `hidden`.
 *
 * Run: node tests/no-hardcoded-rating-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const SKIP_DIRS = new Set(['pro', 'admin', 'sites', 'dev', 'vendor', 'node_modules']);
const FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    if (/\.(html|js|mjs|json|txt|xml)$/.test(e.name) && !/\.min\.(js|mjs)$/.test(e.name)) FILES.push(p);
  }
})(path.join(ROOT, 'docs'));
const PARTIALS = path.join(ROOT, 'site-src', 'partials');
if (fs.existsSync(PARTIALS)) fs.readdirSync(PARTIALS).forEach((n) => FILES.push(path.join(PARTIALS, n)));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function stripComments(src, file) {
  if (/\.(js|mjs)$/.test(file)) return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
  return src.replace(/<!--[\s\S]*?-->/g, ' ');
}
const plain = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&#9733;|&starf;/g, '★').replace(/\s+/g, ' ');

const TEXT_BANNED = [
  ['a star-rating claim in words', /\b(5|five)[- ]star (rated|roofer|roofing|contractor|company|service|reviews?)\b|\brated (5|five)[- ]stars?\b|\b5[- ]star rated\b/i],
  ['a hard-coded score', /\b[1-5]\.\d ?(★|stars?\b|star rating|on google|google rating|rating\b|average)|\brated [1-5]\.\d\b|★ ?[1-5]\.\d\b/i],
  ['a hard-coded review count', /\b\d{1,4}\+? (verified |real |five[- ]star |5[- ]star )?google reviews\b|\b\d{1,4}\+? (five|5)[- ]star reviews\b/i],
];

const hits = {};
let scanned = 0;
for (const f of FILES) {
  const raw = stripComments(fs.readFileSync(f, 'utf8'), f);
  const r = rel(f);
  scanned++;
  const text = plain(raw);
  for (const [name, re] of TEXT_BANNED) {
    const m = text.match(re);
    if (m) (hits[name] = hits[name] || []).push(r + ': "' + text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30).trim() + '"');
  }
  // JSON-LD: no aggregate rating or count typed by hand.
  if (/"aggregateRating"|"reviewCount"|"ratingCount"/.test(raw)) (hits.jsonld = hits.jsonld || []).push(r);
  if (/\.html$/.test(f)) {
    // Live hooks ship empty, wraps ship hidden.
    const valued = raw.match(/<[^>]*\bdata-nbd-gr-(rating|total)(?![-\w])[^>]*>\s*[^<\s]/);
    if (valued) (hits.hookValue = hits.hookValue || []).push(r + ': ' + valued[0].slice(0, 120));
    const shown = raw.match(/<[^>]*\bdata-nbd-gr-(rating|total)-wrap\b(?![^>]*\bhidden\b)[^>]*>/);
    if (shown) (hits.wrapShown = hits.wrapShown || []).push(r + ': ' + shown[0].slice(0, 120));
  }
}
ok('scanned the public tree (' + scanned + ' files)', scanned > 300, String(scanned));
for (const [name] of TEXT_BANNED) ok('no public page: ' + name, !hits[name], (hits[name] || []).slice(0, 8).join('\n      '));
ok('no JSON-LD aggregateRating / reviewCount / ratingCount on a public page', !hits.jsonld, (hits.jsonld || []).join(', '));
ok('every data-nbd-gr-rating / -total hook ships empty', !hits.hookValue, (hits.hookValue || []).join('\n      '));
ok('every data-nbd-gr-rating-wrap / -total-wrap ships hidden', !hits.wrapShown, (hits.wrapShown || []).join('\n      '));

// The /review page's share copy names no score.
{
  const page = fs.readFileSync(path.join(ROOT, 'docs/review.html'), 'utf8');
  const head = page.slice(0, page.indexOf('</head>'));
  const meta = (head.match(/<title>[^<]*<\/title>|<meta[^>]+(description|title)[^>]*>/g) || []).join(' ');
  ok('/review title, description and social share copy carry no star claim', !/\b5[- ]star|\b[1-5]\.\d\b|five[- ]star/i.test(meta), meta.slice(0, 300));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
