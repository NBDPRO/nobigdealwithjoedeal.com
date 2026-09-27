/**
 * Review momentum in the widget — docs/assets/js/google-reviews-widget.js
 *
 * WHY THIS EXISTS
 * The server attaches `recent` ({ newReviews, days, since }) only when
 * Google's own review count has grown against a real baseline
 * (functions/google-reviews-momentum.js). The widget's job is to show it
 * — " · 4 new this month" after the review count, in the cards header and
 * in the homepage summary row — and, just as important, to show NOTHING
 * when it is absent: no "0 new", no empty separator, no layout change.
 *
 * Like tests/google-reviews-static-hooks.test.js, this lifts the REAL
 * functions out of the shipped file and runs them against a fake DOM.
 *
 * Pure-Node. Run: node tests/google-reviews-momentum-widget.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, hint) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (hint ? '\n      ' + hint : '')); }
}

function lift(src, anchor) {
  const start = src.indexOf(anchor);
  if (start === -1) return null;
  let depth = 0;
  let i = src.indexOf('{', start);
  if (i === -1) return null;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return i < src.length ? src.slice(start, i + 1) : null;
}

const WIDGET_SRC = read('docs/assets/js/google-reviews-widget.js');
const INDEX_SRC = read('docs/index.html');

console.log('extraction — the real widget code this suite runs');
const starFull = /const STAR_FULL\s*=\s*\n?\s*'([^']*)';/.exec(WIDGET_SRC);
const starEmpty = /const STAR_EMPTY\s*=\s*\n?\s*'([^']*)';/.exec(WIDGET_SRC);
const googleG = /const GOOGLE_G = [\s\S]*?<\/svg>`;/.exec(WIDGET_SRC);
const pieces = {
  esc: lift(WIDGET_SRC, 'function esc(str)'),
  stars: lift(WIDGET_SRC, 'function stars(n)'),
  recentText: lift(WIDGET_SRC, 'function recentText(data)'),
  truncate: lift(WIDGET_SRC, 'function truncate(text, limit)'),
  renderReviewCard: lift(WIDGET_SRC, 'function renderReviewCard(review)'),
  renderFallback: lift(WIDGET_SRC, 'function renderFallback(container)'),
  renderAll: lift(WIDGET_SRC, 'function renderAll(container, data)'),
  hydrate: lift(WIDGET_SRC, 'function hydrateStaticHooks(data)'),
};
const PROFILE = /const PROFILE_URL = '[^']*';/.exec(WIDGET_SRC);
ok('constants found', !!starFull && !!starEmpty && !!googleG && !!PROFILE);
for (const [k, v] of Object.entries(pieces)) ok(k + '() lifted', !!v);
ok('recentText() is declared exactly once', WIDGET_SRC.split('function recentText(data)').length === 2);
ok('hydrateStaticHooks() calls recentText (the hook is actually wired)',
  !!pieces.hydrate && /recentText\(data\)/.test(pieces.hydrate));
ok('renderAll() calls recentText (the cards header is actually wired)',
  !!pieces.renderAll && /recentText\(data\)/.test(pieces.renderAll));
if (!starFull || !starEmpty || !googleG || !PROFILE || Object.values(pieces).some((v) => !v)) {
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed\nFATAL: extraction failed');
  process.exit(1);
}

// ── Fake DOM ─────────────────────────────────────────────────────────
function makeEl(initial) {
  const el = { writes: 0, _text: initial || '', innerHTML: '' };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; },
    set(v) { this.writes++; this._text = v; },
  });
  return el;
}
function makeDoc(elsByAttr) {
  return {
    querySelectorAll(sel) { return elsByAttr[sel.replace(/^\[|\]$/g, '')] || []; },
    // esc() relies on textContent → innerHTML escaping.
    createElement() {
      let t = '';
      return {
        set textContent(v) { t = String(v); },
        get innerHTML() {
          return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },
      };
    },
  };
}
function build(doc) {
  const body = [starFull[0], starEmpty[0], googleG[0], PROFILE[0], ...Object.values(pieces)].join('\n');
  return new Function('document', body + '\nreturn { recentText, renderAll, hydrateStaticHooks };')(doc);
}

// ── Markup ───────────────────────────────────────────────────────────
console.log('\nmarkup — docs/index.html summary row carries an EMPTY recent hook');
{
  const m = /<div class="reviews-score">([\s\S]*?)<\/div>/.exec(INDEX_SRC);
  ok('the reviews-score line exists', !!m);
  ok('it carries data-nbd-gr-recent right after the count',
    !!m && /data-nbd-gr-total>\d+<\/span> reviews<span data-nbd-gr-recent><\/span>/.test(m[1]), m && m[1]);
  ok('the hook ships EMPTY — no static "new this month" that could go stale',
    !/<[a-z]+[^>]*\sdata-nbd-gr-recent[^>]*>[^<]+</.test(INDEX_SRC.replace(/<!--[\s\S]*?-->/g, '')));
}

// ── Wording ──────────────────────────────────────────────────────────
console.log('\nwording');
{
  const { recentText } = build(makeDoc({}));
  ok('days 30 → "this month"', recentText({ recent: { newReviews: 4, days: 30 } }) === ' · 4 new this month');
  ok('days 28 and 31 → "this month"',
    recentText({ recent: { newReviews: 2, days: 28 } }) === ' · 2 new this month' &&
    recentText({ recent: { newReviews: 2, days: 31 } }) === ' · 2 new this month');
  ok('days 27 (seed-only launch day) → "in the last 27 days"',
    recentText({ recent: { newReviews: 4, days: 27 } }) === ' · 4 new in the last 27 days');
  ok('days 38 (sparse history) → "in the last 38 days", never rounded to a month',
    recentText({ recent: { newReviews: 7, days: 38 } }) === ' · 7 new in the last 38 days');
  ok('1 new → "1 new this month"', recentText({ recent: { newReviews: 1, days: 30 } }) === ' · 1 new this month');
  for (const [label, data] of [
    ['absent', {}],
    ['null recent', { recent: null }],
    ['zero', { recent: { newReviews: 0, days: 30 } }],
    ['negative', { recent: { newReviews: -2, days: 30 } }],
    ['fractional', { recent: { newReviews: 1.5, days: 30 } }],
    ['string payload', { recent: '<img src=x onerror=alert(1)>' }],
    ['hostile count', { recent: { newReviews: '<b>9</b>', days: 30 } }],
    ['missing days', { recent: { newReviews: 3 } }],
  ]) {
    ok(label + ' → empty string', recentText(data) === '', JSON.stringify(recentText(data)));
  }
}

// ── Static hooks ─────────────────────────────────────────────────────
console.log('\nhydrate — the homepage summary row');
{
  const recentEl = makeEl('');
  const total = makeEl('29');
  const { hydrateStaticHooks } = build(makeDoc({ 'data-nbd-gr-recent': [recentEl], 'data-nbd-gr-total': [total] }));
  hydrateStaticHooks({ rating: 5, total: 32, recent: { newReviews: 4, days: 30, since: '2026-08-28' } });
  ok('present → the hook reads " · 4 new this month"', recentEl.textContent === ' · 4 new this month', recentEl.textContent);
  ok('...and the count beside it is still hydrated', total.textContent === '32');
}
for (const [label, payload] of [
  ['recent absent', { rating: 5, total: 32 }],
  ['recent zero', { rating: 5, total: 32, recent: { newReviews: 0, days: 30 } }],
  ['empty payload', { rating: 0, total: 0, empty: true, recent: { newReviews: 4, days: 30 } }],
]) {
  const recentEl = makeEl('');
  const { hydrateStaticHooks } = build(makeDoc({ 'data-nbd-gr-recent': [recentEl] }));
  hydrateStaticHooks(payload);
  ok(label + ' → the hook is never written (row renders exactly as before)',
    recentEl.writes === 0 && recentEl.textContent === '', 'writes=' + recentEl.writes);
}

// ── Cards header ─────────────────────────────────────────────────────
console.log('\nrenderAll — the cards header');
const REVIEWS = [{ author: 'A', rating: 5, text: 'Great', time: 2 }];
{
  const container = { innerHTML: '', querySelectorAll: () => [] };
  build(makeDoc({})).renderAll(container, { rating: 5, total: 32, reviews: REVIEWS, recent: { newReviews: 4, days: 30 } });
  ok('present → "32 reviews · 4 new this month" in the header',
    container.innerHTML.includes('>32 reviews · 4 new this month</div>'));
}
{
  const container = { innerHTML: '', querySelectorAll: () => [] };
  build(makeDoc({})).renderAll(container, { rating: 5, total: 32, reviews: REVIEWS });
  ok('absent → the header is exactly "32 reviews", no separator',
    container.innerHTML.includes('>32 reviews</div>') && !container.innerHTML.includes(' · '));
}

console.log('\n' + '─'.repeat(30));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
