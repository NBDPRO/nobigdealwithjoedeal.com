'use strict';

/**
 * Review momentum — "N new reviews this month", derived ONLY from Google's
 * own review count over time.
 *
 * WHY (Jo, 2026-09-27): "I like it when they see brand new reviews and think
 * wow this guy's busy actively getting work — over oh he got some months ago,
 * he may not be busy now." Places API (New) returns just 5 reviews, chosen by
 * relevance, so the newest ones often aren't among them (29 → 32 between
 * 09-20 and 09-27 and none of the three showed). The Business Profile full-set
 * sync would fix that but is dormant pending Google approval. Places DOES
 * return `userRatingCount` (our payload's `total`), so the honest recency
 * signal is how much that count has grown.
 *
 * How it works:
 *   - Every successful Places refresh (and every fresh GBP serve) records one
 *     point per America/New_York calendar day, { date, total }, into the
 *     `totalsHistory` array on the existing cache doc. Latest wins within a
 *     day; points older than HISTORY_KEEP_DAYS are dropped.
 *   - computeRecent() compares the current total with the latest point at or
 *     before (today − 30 days). With no point that old yet, it falls back to
 *     the OLDEST point, reporting the real span, but only when that span is
 *     at least MIN_SPAN_DAYS — a two-day-old baseline says nothing about a
 *     month.
 *   - No baseline, or no growth (zero / negative, e.g. Google removed a
 *     review), → null, and the payload carries no `recent` at all. The widget
 *     shows nothing rather than "0 new".
 *
 * `days` is always the ACTUAL span between the baseline and today — never a
 * rounded-up claim. With a daily history it is exactly 30; after a quiet
 * stretch with no refresh it can be 31–33, and the widget words it that way.
 */

const TIME_ZONE = 'America/New_York';
const WINDOW_DAYS = 30;
const MIN_SPAN_DAYS = 7;
const HISTORY_KEEP_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Verified historical totals, compiled in so the signal works before the
 * stored history has 30 days of its own. Each one is sourced; add a point
 * here only with a source you have checked. Stored points override these
 * on the same date.
 *   2026-08-31 → 28  documentation/marketing/POSTING-LOG.md, "2026-08-31 …
 *                    every review replied": "The profile had 28 reviews".
 *   2026-09-20 → 29  documentation/projects/NEXT_SESSION-2026-09-21.md §6:
 *                    "live on 09-20: /api/google-reviews returns rating
 *                    5.0 / 29 reviews".
 *   2026-09-27 → 32  live /api/google-reviews read, 2026-09-27 (the same
 *                    payload tests/google-reviews-display.test.js pins).
 */
const SEED_TOTALS = Object.freeze([
  Object.freeze({ date: '2026-08-31', total: 28 }),
  Object.freeze({ date: '2026-09-20', total: 29 }),
  Object.freeze({ date: '2026-09-27', total: 32 }),
]);

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' for the America/New_York calendar day containing `ms`. */
function etDate(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whole-day index of a 'YYYY-MM-DD' string (calendar arithmetic, no TZ). */
function dayIndex(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function isCount(n) {
  return Number.isInteger(n) && n > 0;
}

/**
 * Clean, one-point-per-day, date-ascending copy. Later entries win a date
 * collision, so `sanitize([...seed, ...stored])` lets stored override seed.
 */
function sanitize(history) {
  const byDate = new Map();
  for (const p of Array.isArray(history) ? history : []) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.date !== 'string' || !DATE_RX.test(p.date)) continue;
    if (!isCount(p.total)) continue;
    byDate.set(p.date, { date: p.date, total: p.total });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The history to store after observing `total` at `nowMs`: today's point
 * upserted (latest wins), anything older than HISTORY_KEEP_DAYS dropped.
 * Seeds are NOT persisted — they live in code so a correction takes effect.
 * An unusable total leaves the history as it was (sanitised).
 */
function recordTotal(stored, total, nowMs) {
  if (!Number.isFinite(nowMs)) return sanitize(stored);
  const today = etDate(nowMs);
  const points = sanitize(stored);
  const next = isCount(total) ? sanitize([...points, { date: today, total }]) : points;
  const floor = dayIndex(today) - HISTORY_KEEP_DAYS;
  return next.filter((p) => dayIndex(p.date) > floor);
}

/** True when `stored` has no point for today, or today's point differs. */
function needsRecord(stored, total, nowMs) {
  if (!isCount(total) || !Number.isFinite(nowMs)) return false;
  const today = etDate(nowMs);
  const hit = sanitize(stored).find((p) => p.date === today);
  return !hit || hit.total !== total;
}

/**
 * { newReviews, days, since } or null. Pure: `nowMs` and `seed` are
 * injectable so the suite can pin any calendar position.
 */
function computeRecent(stored, currentTotal, nowMs, seed = SEED_TOTALS) {
  if (!isCount(currentTotal) || !Number.isFinite(nowMs)) return null;
  const today = dayIndex(etDate(nowMs));
  const past = sanitize([...(seed || []), ...(Array.isArray(stored) ? stored : [])])
    .filter((p) => dayIndex(p.date) < today);
  if (!past.length) return null;

  const cutoff = today - WINDOW_DAYS;
  const old = past.filter((p) => dayIndex(p.date) <= cutoff);
  const baseline = old.length ? old[old.length - 1] : past[0];
  const days = today - dayIndex(baseline.date);
  if (!old.length && days < MIN_SPAN_DAYS) return null;

  const newReviews = currentTotal - baseline.total;
  if (newReviews <= 0) return null;
  return { newReviews, days, since: baseline.date };
}

module.exports = {
  computeRecent,
  recordTotal,
  needsRecord,
  etDate,
  SEED_TOTALS,
  WINDOW_DAYS,
  MIN_SPAN_DAYS,
  HISTORY_KEEP_DAYS,
};
