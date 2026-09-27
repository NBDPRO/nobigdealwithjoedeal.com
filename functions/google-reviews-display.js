'use strict';

/**
 * What the public review widget is allowed to show, applied to EVERY payload
 * getGoogleReviews serves (Places refresh, Places cache, GBP full set, and
 * both fallbacks) so the rules can't drift between paths.
 *
 *   1. Newest first. Places API (New) returns its 5 reviews in Google's
 *      relevance order with no sort parameter; the GBP full-set sync already
 *      sorts by time, but a cached/stale payload may predate that.
 *   2. Hidden reviewers. Jo asked (2026-09-27) to keep one reviewer off the
 *      site — the display name reads as a course/institution, not a
 *      customer. The review stays on Google; we only decline to feature it.
 *      Match on the display name, case-insensitive, substring — add entries
 *      here, nowhere else.
 *
 * The aggregate `rating` / `total` are Google's own numbers and are left
 * untouched: hiding a card from the carousel must not change the stars.
 */

const { computeRecent } = require('./google-reviews-momentum');

const HIDDEN_REVIEWER_PATTERNS = [
  /fdp\s*python/i,
];

function isHiddenReviewer(author) {
  const name = String(author || '');
  return HIDDEN_REVIEWER_PATTERNS.some((rx) => rx.test(name));
}

function presentReviews(reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews
    .filter((r) => r && !isHiddenReviewer(r.author))
    .slice() // never sort the caller's array in place
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
}

/**
 * opts.totalsHistory / opts.now — when given, attach `recent` (review
 * momentum, google-reviews-momentum.js) computed from Google's own count
 * history. Omitted whenever it can't be computed honestly; a `recent` key
 * already on `data` is never passed through.
 */
function presentPayload(data, opts) {
  if (!data || typeof data !== 'object') return data;
  const { recent: _ignored, ...rest } = data;
  const out = { ...rest, reviews: presentReviews(data.reviews) };
  if (opts && typeof opts === 'object') {
    const recent = computeRecent(opts.totalsHistory, data.total, opts.now);
    if (recent) out.recent = recent;
  }
  return out;
}

module.exports = { presentPayload, presentReviews, isHiddenReviewer, HIDDEN_REVIEWER_PATTERNS };
