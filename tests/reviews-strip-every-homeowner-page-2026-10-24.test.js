/**
 * tests/reviews-strip-every-homeowner-page-2026-10-24.test.js
 *
 * Jo, 2026-10-24: "wire the reviews system for all homeowner pages to show the
 * most recent ones, and their dates."
 *
 * Two halves:
 *   1. Every homeowner page carries ONE Google-reviews container and loads the
 *      widget ONCE. Pages with a hand-built reviews section (the home page,
 *      /review, the 18 service hubs) keep theirs; every other page gets the
 *      shared `reviews-strip` partial (site-src/partials/reviews-strip.html),
 *      stamped by apply-partials.js. The our-work detail pages get it from
 *      build-projects.mjs's template. Legal, utility and internal pages have
 *      none, by name, so a page added to either list is a visible decision.
 *   2. Each review card names the review's DATE. google-reviews-widget.js
 *      reads `time` (unix seconds, both server paths) and renders
 *      `<time datetime="YYYY-MM-DD">Oct 12, 2026</time>` with Google's
 *      relative wording beside it; a bad or future time renders no date
 *      rather than a wrong one. The widget runs once per page even when a
 *      page carries two copies of the script tag.
 *
 * Zero-dep. Run: node tests/reviews-strip-every-homeowner-page-2026-10-24.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 1200) : '')); }
}
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');

// ── The public tree, and what is NOT a homeowner page ────────────────
const SKIP_DIRS = new Set(['pro', 'admin', 'dev', 'sites', 'assets']);
// Legal / utility / internal pages: no reviews strip, on purpose.
const NOT_HOMEOWNER = new Set([
  'docs/404.html', 'docs/offline.html', 'docs/googlee5b8f461f0f8e74b.html',
  'docs/privacy.html', 'docs/terms.html', 'docs/sms-program.html',
  'docs/search.html',              // Pagefind page (its own CSP trial)
  'docs/careers.html', 'docs/partners.html', // for crews and sponsors, not homeowners
  'docs/tools/index.html',         // the internal operations hub
]);
const PAGES = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!(d === path.join(ROOT, 'docs') && SKIP_DIRS.has(e.name))) walk(p); }
    else if (e.name.endsWith('.html')) PAGES.push(p);
  }
})(path.join(ROOT, 'docs'));

const CONTAINER = /data-nbd-google-reviews\b/g;
const SCRIPT = /<script[^>]*src="\/assets\/js\/google-reviews-widget\.js"[^>]*><\/script>/g;
const MARKER = /<!-- nbd:partial reviews-strip -->/g;
const count = (s, re) => (s.match(re) || []).length;

console.log('1. the partial');
{
  const p = read('site-src/partials/reviews-strip.html');
  ok('reviews-strip partial exists with the cards container', count(p, CONTAINER) === 1);
  ok('it loads the widget (defer, external — CSP forbids inline)', count(p, SCRIPT) === 1 && /defer/.test(p));
  ok('it has a heading the section is labelled by', /aria-labelledby="reviews-strip-title"/.test(p) && /id="reviews-strip-title"/.test(p));
  ok('it links to /review for the full list', /href="\/review"/.test(p));
  ok('it writes no rating or count of its own', !/\b\d+(\.\d+)?\s*(stars?|reviews?)\b|\baggregateRating\b/i.test(stripComments(p)));
  ok('no inline script or handler in it', !/<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=/i.test(stripComments(p)));
  const tpl = read('scripts/build-projects.mjs');
  ok('build-projects.mjs stamps the marker pair into every our-work page',
    /<!-- nbd:partial reviews-strip -->\n<!-- \/nbd:partial reviews-strip -->\n<\/main>/.test(tpl));
}

console.log('\n2. every homeowner page: one container, one widget');
{
  const missing = [], doubled = [], extra = [], unmarked = [];
  let homeowner = 0, strip = 0, own = 0;
  for (const f of PAGES) {
    const r = rel(f);
    const src = stripComments(read(f));
    const c = count(src, CONTAINER), s = count(src, SCRIPT), m = count(read(f), MARKER);
    if (NOT_HOMEOWNER.has(r)) { if (c || s || m) extra.push(r); continue; }
    homeowner++;
    if (c === 0 || s === 0) missing.push(r + ` (containers ${c}, scripts ${s})`);
    if (c > 1 || s > 1) doubled.push(r + ` (containers ${c}, scripts ${s})`);
    if (m) strip++; else own++;
    // A page with no hand-built section must carry the partial, so the words
    // stay generator-owned instead of drifting page by page.
    if (!m && c && !/\/services\/|docs\/index\.html|docs\/review\.html/.test(r)) unmarked.push(r);
  }
  ok(`every homeowner page (${homeowner}) has a reviews container and the widget`, missing.length === 0, missing.slice(0, 8).join('\n      '));
  ok('none has two containers or loads the widget twice', doubled.length === 0, doubled.slice(0, 8).join('\n      '));
  ok(`the strip partial is on ${strip} pages; ${own} keep their own section`, strip >= 220 && own >= 18, `strip ${strip}, own ${own}`);
  ok('pages outside the hubs carry the partial, not a hand copy', unmarked.length === 0, unmarked.join(', '));
  ok('legal, utility and internal pages carry none', extra.length === 0, extra.join(', '));
  ok('the area pages are covered (none had reviews before)',
    PAGES.filter((f) => /\/areas\/[a-z-]+\.html$/.test(rel(f))).every((f) => count(read(f), CONTAINER) === 1));
  ok('the blog posts and guides are covered',
    PAGES.filter((f) => /\/(blog|guides)\/[a-z0-9-]+\.html$/.test(rel(f))).every((f) => count(read(f), CONTAINER) === 1));
}

// ── The widget: dates ────────────────────────────────────────────────
console.log('\n3. the widget dates each card');
{
  const W = read('docs/assets/js/google-reviews-widget.js');
  function lift(anchor) {
    const start = W.indexOf(anchor); if (start < 0) return null;
    let depth = 0, i = W.indexOf('{', start);
    for (; i < W.length; i++) { if (W[i] === '{') depth++; else if (W[i] === '}') { depth--; if (!depth) break; } }
    return W.slice(start, i + 1);
  }
  const pieces = ['function esc(str)', 'function stars(n)', 'function reviewDate(review)', 'function truncate(text, limit)', 'function renderReviewCard(review)'].map(lift);
  ok('reviewDate(), renderReviewCard() lifted from the real widget', pieces.every(Boolean));
  const consts = [/const STAR_FULL\s*=\s*\n?\s*'[^']*';/, /const STAR_EMPTY\s*=\s*\n?\s*'[^']*';/].map((re) => (W.match(re) || [''])[0]);
  const doc = { createElement() { let t = ''; return { set textContent(v) { t = String(v); }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); } }; } };
  const api = new Function('document', consts.join('\n') + '\n' + pieces.join('\n') + '\nreturn { reviewDate, renderReviewCard };')(doc);

  const oct12 = Date.UTC(2026, 9, 12, 15, 30) / 1000; // 2026-10-12T15:30Z, unix seconds
  const d = api.reviewDate({ time: oct12 });
  ok('unix seconds → "Oct 12, 2026" and an ISO day', !!d && d.text === 'Oct 12, 2026' && d.iso === '2026-10-12', JSON.stringify(d));
  ok('a numeric string works too (Firestore round-trips)', (api.reviewDate({ time: String(oct12) }) || {}).text === 'Oct 12, 2026');
  ok('milliseconds are tolerated', (api.reviewDate({ time: oct12 * 1000 }) || {}).text === 'Oct 12, 2026');
  ok('no time → no date (not 1970)', api.reviewDate({}) === null && api.reviewDate({ time: 0 }) === null && api.reviewDate({ time: 'soon' }) === null);
  ok('a date years in the future → no date', api.reviewDate({ time: Math.floor(Date.now() / 1000) + 10 * 86400 }) === null);

  const card = api.renderReviewCard({ author: 'Pat', rating: 5, text: 'Great crew.', relativeTime: '2 weeks ago', time: oct12 });
  ok('card carries <time datetime="2026-10-12">Oct 12, 2026</time>', /<time datetime="2026-10-12">Oct 12, 2026<\/time>/.test(card), card);
  ok('…with Google\'s relative wording beside it', /Oct 12, 2026<\/time> &middot; <span style="white-space:nowrap">2 weeks ago<\/span>/.test(card));
  const noRel = api.renderReviewCard({ author: 'Pat', rating: 5, text: 'x', time: oct12 });
  ok('no relative wording → the date alone, no stray separator', /Oct 12, 2026<\/time><\/div>/.test(noRel) && !/&middot;/.test(noRel));
  const noTime = api.renderReviewCard({ author: 'Pat', rating: 5, text: 'x', relativeTime: 'a year ago' });
  ok('no time → the relative wording alone (the pre-2026-10-24 card)', />a year ago<\/div>/.test(noTime) && !/<time/.test(noTime));
  const hostile = api.renderReviewCard({ author: 'Pat', rating: 5, text: 'x', relativeTime: '<img src=x onerror=alert(1)>', time: oct12 });
  ok('relative wording is still escaped', !/<img/.test(hostile) && /&lt;img/.test(hostile));

  ok('the widget runs once per page (guard flag before any work)',
    /if \(window\.__nbdGoogleReviewsWidget\) return;\s*window\.__nbdGoogleReviewsWidget = true;/.test(W)
    && W.indexOf('__nbdGoogleReviewsWidget') < W.indexOf("const ENDPOINT"));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
