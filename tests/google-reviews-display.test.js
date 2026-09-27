/**
 * What the review widget is allowed to show — functions/google-reviews-display.js
 *
 * WHY THIS EXISTS
 * Jo (2026-09-27): "make the reviews that populate via google be the most
 * recent … one of my customers used an email with FDP python as the name —
 * remove it from main view." Places API (New) hands back 5 reviews in
 * Google's relevance order (no newest-first parameter), so ordering and
 * hiding happen on our side, in ONE function applied to every payload
 * getGoogleReviews serves. This suite runs the real module, then pins that
 * all five response paths in google-reviews.js route through it — a new path
 * that spreads raw data would quietly re-show the hidden reviewer.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { presentPayload, presentReviews, isHiddenReviewer } =
  require(path.join(ROOT, 'functions', 'google-reviews-display.js'));

let passed = 0;
let failed = 0;
function ok(label, cond, hint) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label + (hint ? ' — ' + hint : ''));
  }
}

// The live payload on 2026-09-27, in the order Google returned it.
const live = {
  name: 'No Big Deal Home Solutions',
  rating: 5,
  total: 32,
  reviews: [
    { author: 'tirrell larkin', time: 1780059373 },
    { author: 'ALISON RIERA', time: 1781992018 },
    { author: 'FDP Python For Machine Learning CSE, GEC Palakkad', time: 1781381288 },
    { author: 'UDHAYA K', time: 1781293512 },
    { author: 'Luciano Ali', time: 1781131999 },
  ],
};

console.log('HIDDEN REVIEWERS');
ok('the named reviewer is hidden (case-insensitive, substring)',
  isHiddenReviewer('FDP Python For Machine Learning CSE, GEC Palakkad') &&
  isHiddenReviewer('fdp python') && isHiddenReviewer('FDP  PYTHON course'));
ok('ordinary names are not hidden',
  !isHiddenReviewer('tirrell larkin') && !isHiddenReviewer('Python Pete') &&
  !isHiddenReviewer('') && !isHiddenReviewer(undefined));

console.log('NEWEST FIRST');
const out = presentPayload(live);
ok('the hidden reviewer is gone from the payload',
  !out.reviews.some((r) => /fdp/i.test(r.author)), JSON.stringify(out.reviews.map((r) => r.author)));
ok('the rest are sorted newest first',
  JSON.stringify(out.reviews.map((r) => r.author)) ===
  JSON.stringify(['ALISON RIERA', 'UDHAYA K', 'Luciano Ali', 'tirrell larkin']),
  JSON.stringify(out.reviews.map((r) => r.author)));
ok("Google's own rating and total are untouched", out.rating === 5 && out.total === 32);
ok("the caller's array is not mutated",
  live.reviews.length === 5 && live.reviews[0].author === 'tirrell larkin');
ok('missing/odd input degrades to an empty list, not a throw',
  presentReviews(undefined).length === 0 && presentReviews(null).length === 0 &&
  presentPayload(null) === null && presentPayload({ rating: 5 }).reviews.length === 0);
ok('a review with no time sorts last instead of throwing',
  presentReviews([{ author: 'a' }, { author: 'b', time: 5 }])[0].author === 'b');

console.log('EVERY RESPONSE PATH USES IT');
const src = fs.readFileSync(path.join(ROOT, 'functions', 'google-reviews.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const raw = src.match(/\.\.\.(cached\.data|gbp\.data|fresh)\b/g) || [];
ok('no response spreads raw review data', raw.length === 0, raw.join(', '));
const wrapped = (src.match(/\.\.\.presentPayload\(/g) || []).length;
ok('all five data-bearing response paths go through presentPayload', wrapped === 5, `found ${wrapped}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
