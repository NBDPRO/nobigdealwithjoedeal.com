/**
 * health-shortcut-logic.js — the pure half of the Apple Health weight Shortcut
 * (research idea #9, 2026-10-20). No Firebase, no I/O: functions/health-shortcut.js
 * calls into this and tests/health-shortcut-2026-10-20.test.js drives it directly.
 *
 * The feature: an iPhone Shortcut ("Find Health Samples" -> "Get Contents of
 * URL") POSTs the day's weight to healthShortcutIngest with a per-user secret
 * key in an Authorization: Bearer header. The server writes data['bm-wt'] on
 * that day's Daily Success page (users/{uid}/ds_pages/*), the same field
 * tracker-history-logic.js weightSeries() reads.
 *
 * Rules that live here (each one is pinned in the test):
 *   - the key: 32 random bytes, `nbdh_` + base64url; stored ONLY as its
 *     SHA-256 hex, which is also the lookup doc id (no scans).
 *   - the body: strict shape, weight 60-700 lb (weightSeries' own range),
 *     sleep 0-24 h, a real YYYY-MM-DD between 400 days ago and 2 days ahead.
 *   - the page rule (decidePageWrite): an automatic reading never overwrites a
 *     weight Jo typed by hand, never resurrects a deleted day.
 */
'use strict';

const crypto = require('crypto');

const TOKEN_PREFIX = 'nbdh_';
const MAX_BODY_BYTES = 512;
const WEIGHT_MIN = 60;      // same range as docs/pro/daily-success/js/tracker-history-logic.js weightSeries
const WEIGHT_MAX = 700;
const SLEEP_MAX = 24;
const MAX_DAYS_BACK = 400;
const MAX_DAYS_AHEAD = 2;
const DAY_MS = 86400000;
const DAILY_CAP = 50;       // requests per user per UTC day, accepted or not past the key check

function mintToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

// Tokens are 256-bit random, so an unsalted SHA-256 is a sound at-rest form
// (nothing to brute-force or rainbow-table); the hash is the lookup doc id.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function isHashHex(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }

// Constant-time on equal-length hex digests; false (not a throw) otherwise.
function safeEqualHex(a, b) {
  if (!isHashHex(a) || !isHashHex(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// "Authorization: Bearer <token>" -> the token, or null if absent / malformed.
// Shape-checked so junk never reaches Firestore.
function parseBearer(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header.trim());
  if (!m || !m[1].startsWith(TOKEN_PREFIX)) return null;
  return m[1];
}

function dayKeyUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// YYYY-MM-DD that is a real calendar date (no 2026-02-30).
function isRealDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validate the request body. Returns { ok:true, date, weightLbs, weightStr,
 * sleepHours|null } or { ok:false } — the caller sends one generic 400 for
 * every failure so the endpoint teaches a prober nothing.
 * `nowMs` is injected for tests.
 */
function validateBody(body, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const allowed = ['date', 'weightLbs', 'sleepHours'];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) return { ok: false };
  if (!isRealDate(body.date)) return { ok: false };
  const t = Date.parse(body.date + 'T00:00:00Z');
  const todayUtc = Date.parse(dayKeyUTC(nowMs) + 'T00:00:00Z');
  // A Shortcut run just after midnight local time can be a day ahead of UTC or
  // behind it, so the window is days, not instants.
  if (t > todayUtc + MAX_DAYS_AHEAD * DAY_MS) return { ok: false };
  if (t < todayUtc - MAX_DAYS_BACK * DAY_MS) return { ok: false };
  // Shortcuts hands numbers over as JSON numbers; a string like "185" is
  // refused rather than guessed at (Number("") is 0, Number(" ") is 0...).
  const w = body.weightLbs;
  if (typeof w !== 'number' || !isFinite(w) || w < WEIGHT_MIN || w > WEIGHT_MAX) return { ok: false };
  let sleep = null;
  if (body.sleepHours !== undefined && body.sleepHours !== null) {
    const s = body.sleepHours;
    if (typeof s !== 'number' || !isFinite(s) || s < 0 || s > SLEEP_MAX) return { ok: false };
    sleep = s;
  }
  const rounded = Math.round(w * 10) / 10;
  return { ok: true, date: body.date, weightLbs: rounded, weightStr: String(rounded), sleepHours: sleep };
}

/**
 * Pick what to do with the day's existing pages. `pages` is every
 * users/{uid}/ds_pages doc whose dk equals the date, as { id, data } (data =
 * the doc's fields). Returns one of:
 *   { action:'create' }
 *   { action:'update', id }       -> merge-write data['bm-wt'] on that page
 *   { action:'skip', reason }     -> 'deleted' | 'hand_entered' | 'unchanged'
 *
 * The rule, in plain words:
 *   - a day Jo deleted (every page for it carries deleted:true) stays deleted;
 *     a deleted page is never resurrected by an automatic reading
 *   - a day with no page gets a new one
 *   - a page whose weight box is empty takes the reading
 *   - a page whose weight is exactly the value THIS endpoint last wrote
 *     (page.hw.wt) takes the newer reading: last one wins
 *   - anything else is a weight Jo typed (or edited): it stays. A reading
 *     never overwrites what he typed by hand.
 */
function decidePageWrite(pages, weightStr) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  if (!list.length) return { action: 'create' };
  const live = list.filter((p) => !(p.data && p.data.deleted));
  if (!live.length) return { action: 'skip', reason: 'deleted' };
  const cur = (p) => {
    const d = p.data && p.data.data;
    const v = d && typeof d === 'object' ? d['bm-wt'] : '';
    return v == null ? '' : String(v).trim();
  };
  const sufOf = (p) => (typeof p.data.suf === 'number' ? p.data.suf : 1);
  // The page weightSeries would read: one already holding a weight, else the first entry of the day.
  const withWeight = live.filter((p) => cur(p) !== '');
  const target = (withWeight.length ? withWeight : live).slice().sort((a, b) => sufOf(a) - sufOf(b))[0];
  const have = cur(target);
  if (have === weightStr) return { action: 'skip', reason: 'unchanged', id: target.id };
  const wrote = target.data.hw && typeof target.data.hw === 'object' ? String(target.data.hw.wt || '') : '';
  if (have === '' || (wrote !== '' && have === wrote)) return { action: 'update', id: target.id };
  return { action: 'skip', reason: 'hand_entered', id: target.id };
}

/** The day page the client's mkPage() makes, plus the endpoint's own marker. */
function newPageShape(uid, date, weightStr, nowMs, rand) {
  const id = nowMs + (typeof rand === 'number' ? rand : Math.random());
  return {
    id, dk: date, suf: 1, name: '', mt: nowMs,
    data: { 'bm-wt': weightStr },
    kpi: { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 },
    exercises: [], objections: [], commissions: [],
    hw: { wt: weightStr, at: nowMs },
    _uid: uid,
  };
}

module.exports = {
  TOKEN_PREFIX, MAX_BODY_BYTES, WEIGHT_MIN, WEIGHT_MAX, SLEEP_MAX, MAX_DAYS_BACK, MAX_DAYS_AHEAD, DAILY_CAP,
  mintToken, hashToken, isHashHex, safeEqualHex, parseBearer, dayKeyUTC, isRealDate,
  validateBody, decidePageWrite, newPageShape,
};
