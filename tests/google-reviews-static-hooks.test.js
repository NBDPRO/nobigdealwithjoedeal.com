/**
 * Google-reviews static hook hydration — docs/assets/js/google-reviews-widget.js
 *
 * WHY THIS EXISTS
 * The homepage #reviews summary row used to be pure static markup:
 *
 *     <div class="reviews-stars">★★★★★</div>
 *     <div class="reviews-score">5.0 on Google</div>
 *
 * Nothing kept either value true. The live rating was already flowing into the
 * page — the widget fetches it for the review cards on all 17 pages that load
 * it — but the summary row above the cards read from nothing, so the moment the
 * profile moved off 5.0 the page would have gone on claiming five stars until a
 * human edited HTML. The row also never showed the review COUNT at all, which
 * is the single number that carries the most weight on a contractor's page.
 *
 * So the row is now hydrated from the same payload the cards use, and this
 * suite runs the REAL hydrateStaticHooks (lifted from the shipped file and
 * executed, not regex-matched) against a fake DOM.
 *
 * The invariant that matters most is the LAST one: an empty/failed payload must
 * leave the static fallback untouched. Zeroing the row on a fetch failure would
 * turn a transient outage into "0.0 on Google · 0 reviews" on the homepage —
 * strictly worse than the stale-but-true text it replaced.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, hint) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label + (hint ? '\n      ' + hint : ''));
  }
}
function section(title) {
  console.log('\n' + title);
}

// Brace-matched lift of a named declaration, so we execute the shipped source
// rather than asserting on a regex over it.
function lift(src, anchor) {
  const start = src.indexOf(anchor);
  if (start === -1) return null;
  let depth = 0;
  let i = src.indexOf('{', start);
  if (i === -1) return null;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return i < src.length ? src.slice(start, i + 1) : null;
}

const WIDGET_SRC = read('docs/assets/js/google-reviews-widget.js');
const INDEX_SRC = read('docs/index.html');

// ── Extraction ───────────────────────────────────────────────────────
section('extraction — the real widget code this suite runs');

const starFull = /const STAR_FULL\s*=\s*\n?\s*'([^']*)';/.exec(WIDGET_SRC);
const starEmpty = /const STAR_EMPTY\s*=\s*\n?\s*'([^']*)';/.exec(WIDGET_SRC);
const starsFn = lift(WIDGET_SRC, 'function stars(n)');
const hydrateFn = lift(WIDGET_SRC, 'function hydrateStaticHooks(data)');
// hydrateStaticHooks calls recentText() for the momentum hook (covered in
// tests/google-reviews-momentum-widget.test.js); lifted so the closure is whole.
const recentFn = lift(WIDGET_SRC, 'function recentText(data)');

ok('STAR_FULL constant found', !!starFull);
ok('recentText() lifted', !!recentFn);
ok('STAR_EMPTY constant found', !!starEmpty);
ok('stars() lifted', !!starsFn && starsFn.includes('Math.round'));
ok('hydrateStaticHooks() lifted', !!hydrateFn && hydrateFn.includes('data-nbd-gr-rating'));
ok('hydrateStaticHooks() is declared exactly once', WIDGET_SRC.split('function hydrateStaticHooks(data)').length === 2);
ok('the widget still CALLS hydrateStaticHooks on the success path (a dead helper hydrates nothing)',
  /hydrateStaticHooks\(data \|\| \{\}\);/.test(WIDGET_SRC),
  'load() must invoke it after the fetch resolves, before renderAll');

if (!starFull || !starEmpty || !starsFn || !hydrateFn || !recentFn) {
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed\nFATAL: extraction failed — nothing below can run');
  process.exit(1);
}

// ── Fake DOM ─────────────────────────────────────────────────────────
function makeEl(attrs) {
  return {
    _attrs: attrs || {},
    textContent: '',
    innerHTML: '',
  };
}

function makeDoc(elsByAttr) {
  return {
    querySelectorAll(sel) {
      const key = sel.replace(/^\[|\]$/g, '');
      return elsByAttr[key] || [];
    },
  };
}

// Compose the lifted pieces into one closure with `document` injected —
// the same shape they have inside the widget's IIFE.
function makeHydrate(doc) {
  const factory = new Function(
    'document',
    `${starFull[0]}\n${starEmpty[0]}\n${starsFn}\n${recentFn}\n${hydrateFn}\nreturn hydrateStaticHooks;`
  );
  return factory(doc);
}

function countFilledStars(html) {
  // STAR_FULL is the fbbc04-filled polygon; STAR_EMPTY is the #2d3748 one.
  return (html.match(/fill="#fbbc04"/g) || []).length;
}

// ── The homepage actually ships the hooks ────────────────────────────
section('markup — docs/index.html #reviews carries the hooks, with a TRUE static fallback');

const reviewsBlock = (() => {
  const i = INDEX_SRC.indexOf('class="reviews-rating');
  if (i === -1) return null;
  const end = INDEX_SRC.indexOf('</div>', INDEX_SRC.indexOf('reviews-score-sub', i));
  return i !== -1 && end !== -1 ? INDEX_SRC.slice(i, end) : null;
})();

ok('the #reviews summary row exists', !!reviewsBlock);
ok('star row carries data-nbd-gr-stars', !!reviewsBlock && /data-nbd-gr-stars/.test(reviewsBlock));
ok('score carries data-nbd-gr-rating', !!reviewsBlock && /data-nbd-gr-rating/.test(reviewsBlock));
ok('count carries data-nbd-gr-total', !!reviewsBlock && /data-nbd-gr-total/.test(reviewsBlock));
ok('the static fallback still names a rating and a count (a blank fallback is worse than a stale one)',
  !!reviewsBlock && /data-nbd-gr-rating[^>]*>\s*\d\.\d\s*</.test(reviewsBlock)
  && /data-nbd-gr-total[^>]*>\s*\d+\s*</.test(reviewsBlock),
  'the hooks must ship with real text inside them, not empty spans');
ok('the page still loads the widget that fills them',
  /google-reviews-widget\.js/.test(INDEX_SRC));

// ── Behaviour ────────────────────────────────────────────────────────
section('hydration — a real payload rewrites every hook');

{
  const rating = makeEl();
  const total = makeEl();
  const count = makeEl();
  const starsEl = makeEl();
  rating.textContent = '5.0';
  total.textContent = '29';
  starsEl.innerHTML = '★★★★★';

  const doc = makeDoc({
    'data-nbd-gr-rating': [rating],
    'data-nbd-gr-total': [total],
    'data-nbd-gr-count': [count],
    'data-nbd-gr-stars': [starsEl],
  });
  makeHydrate(doc)({ rating: 4.7, total: 31 });

  ok('rating hook shows the live score to one decimal', rating.textContent === '4.7');
  ok('total hook shows the live count alone (page owns the wording)', total.textContent === '31');
  ok('count hook shows the ready-made sentence', count.textContent === '31 Google reviews • tap to see them all');
  ok('star hook re-rendered as SVG, not the literal unicode it replaced',
    starsEl.innerHTML.includes('<svg') && !starsEl.innerHTML.includes('★'));
  ok('4.7 rounds to 5 filled stars', countFilledStars(starsEl.innerHTML) === 5);
}

{
  // The whole reason the star row is hydrated: it has to be able to show
  // FEWER than five. A static ★★★★★ cannot.
  const starsEl = makeEl();
  starsEl.innerHTML = '★★★★★';
  const doc = makeDoc({ 'data-nbd-gr-stars': [starsEl] });
  makeHydrate(doc)({ rating: 4.2, total: 31 });
  ok('4.2 renders FOUR filled stars (the static row could never do this)',
    countFilledStars(starsEl.innerHTML) === 4,
    'if this is 5, the star hook is not actually reading the rating');
  ok('...and the fifth star is rendered empty, not dropped',
    (starsEl.innerHTML.match(/<svg/g) || []).length === 5);
}

{
  const count = makeEl();
  const doc = makeDoc({ 'data-nbd-gr-count': [count] });
  makeHydrate(doc)({ rating: 5, total: 1 });
  ok('a single review reads "1 Google review", singular', count.textContent === '1 Google review • tap to see them all');
}

section('degradation — an empty or failed payload must NOT zero the page');

for (const [label, payload] of [
  ['empty payload (the not_configured / cold-cache body)', { rating: 0, total: 0, empty: true }],
  ['undefined fields', {}],
  ['rating present but no count', { rating: 5 }],
]) {
  const rating = makeEl();
  const total = makeEl();
  const count = makeEl();
  const starsEl = makeEl();
  rating.textContent = '5.0';
  total.textContent = '29';
  count.textContent = '29 Google reviews';
  starsEl.innerHTML = '★★★★★';

  const doc = makeDoc({
    'data-nbd-gr-rating': [rating],
    'data-nbd-gr-total': [total],
    'data-nbd-gr-count': [count],
    'data-nbd-gr-stars': [starsEl],
  });
  makeHydrate(doc)(payload);

  ok(label + ' — static rating survives untouched', rating.textContent === '5.0');
  ok(label + ' — static count survives untouched', total.textContent === '29');
  ok(label + ' — static sentence survives untouched', count.textContent === '29 Google reviews');
  ok(label + ' — static stars survive untouched', starsEl.innerHTML === '★★★★★',
    'hydrating stars on a zero rating would render five EMPTY stars — a 0-star claim on our own homepage');
}

section('safety — no payload string can reach the one innerHTML write');

{
  const starsEl = makeEl();
  const doc = makeDoc({ 'data-nbd-gr-stars': [starsEl] });
  makeHydrate(doc)({
    rating: 5,
    total: 12,
    name: '<img src=x onerror=alert(1)>',
    profileUrl: 'javascript:alert(1)',
  });
  ok('hostile payload fields never appear in the star markup',
    !/onerror|alert\(|javascript:|<img/i.test(starsEl.innerHTML));
  ok('...and the markup is still only the frozen star SVGs',
    (starsEl.innerHTML.match(/<svg/g) || []).length === 5
    && starsEl.innerHTML.includes('polygon'));
}

// ── Result ───────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(30));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
