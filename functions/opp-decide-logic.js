'use strict';
/**
 * opp-decide-logic.js — the pure half of oppDraftDecide and oppDraftList (2026-11-04, flag
 * thumbtackOpportunities, ships dark): the day and week keys the approval caps count in, the
 * "will send 8am" label, the closed list of skip reasons, and the card the approval screen shows.
 * No Firestore, no network, no clock (the caller passes `nowMs`), nothing read from or sent to Thumbtack.
 *
 * Approval only MARKS a draft `approved`. There is no sender in this series; the reserved
 * `thumbtackOppSend` flag is not read here or anywhere else.
 *
 *   dayKey(nowMs, tz)            'YYYY-MM-DD' of that moment in the zone (Eastern by default rules)
 *   weekKey(nowMs, tz)           'YYYY-MM-DD' of the MONDAY of that moment's week in the zone
 *   capCounts(capsDoc, nowMs, tz)  { sentToday, sentThisWeek }: approvals counted today / this week;
 *                                a counter written on another day or week counts as 0; garbage = null (fails closed)
 *   bumpCaps(capsDoc, nowMs, tz) the counter fields after ONE more approval
 *   sendLabel(nowMs, rules)      { inWindow, label }: label is 'will send 8am' outside the send hours
 *   textProblem(text)            why Jo's (edited) text may not be approved, or null: the PR 3 draftProblem, unchanged
 *   cardOf(id, draft, seen, nowMs, rules)   the whitelisted card for the screen
 */
const S = require('./opp-shortlist-logic');
const D = require('./opp-draft-logic');

const ACTIONS = Object.freeze(['approve', 'edit', 'skip', 'snooze']);
/** Closed list (design 3d): the one-tap reasons Jo can give when he skips. Anything else is refused. */
const SKIP_REASONS = Object.freeze({ wrong_trade: 'Wrong trade', too_far: 'Too far', too_small: 'Too small', too_crowded: 'Too crowded' });
const SNOOZE_MS = 60 * 60000;                 // "Snooze 1h"
const TEXT_INPUT_MAX = 2000;                  // a longer body is refused before it is looked at (the draft limit is lower)
const DAY_MS = 86400000;

function partsIn(nowMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(nowMs));
  const get = (t) => { const p = parts.filter((x) => x.type === t)[0]; return p ? p.value : ''; };
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), wd: get('weekday') };
}
const pad = (n) => (n < 10 ? '0' : '') + n;
function dayKey(nowMs, tz) { const p = partsIn(nowMs, tz); return p.y + '-' + pad(p.m) + '-' + pad(p.d); }
/** Monday of the week (Monday starts the week). */
function weekKey(nowMs, tz) {
  const p = partsIn(nowMs, tz);
  const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.wd);
  const monday = new Date(Date.UTC(p.y, p.m - 1, p.d) - (idx < 0 ? 0 : idx) * DAY_MS);
  return monday.getUTCFullYear() + '-' + pad(monday.getUTCMonth() + 1) + '-' + pad(monday.getUTCDate());
}

const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** Approvals counted for today and this week. A missing doc is 0 / 0; a counter that is not a whole number is null (capStatus then fails closed). */
function capCounts(caps, nowMs, tz) {
  const c = caps || {};
  const today = dayKey(nowMs, tz), wk = weekKey(nowMs, tz);
  // A counter stamped on another day / week is stale and counts 0; a key that is not a string is a corrupt doc, which is unknown (null), not 0.
  const part = (key, now, count) => (key === now ? (isCount(count) ? count : null) : (key === undefined || typeof key === 'string' ? 0 : null));
  return { sentToday: part(c.dayKey, today, c.dayCount), sentThisWeek: part(c.weekKey, wk, c.weekCount) };
}
function bumpCaps(caps, nowMs, tz) {
  const n = capCounts(caps, nowMs, tz);
  return { dayKey: dayKey(nowMs, tz), dayCount: (n.sentToday || 0) + 1, weekKey: weekKey(nowMs, tz), weekCount: (n.sentThisWeek || 0) + 1 };
}

function hourWord(h) { const x = ((h % 24) + 24) % 24; return (x % 12 === 0 ? 12 : x % 12) + (x < 12 ? 'am' : 'pm'); }
/** Outside the send hours a draft can still be approved, but it is labelled for the next window. */
function sendLabel(nowMs, rules) {
  const inWindow = S.inSendHours(nowMs, rules);
  return { inWindow, label: inWindow ? 'in the send window (' + hourWord(rules.hours.sendStart) + ' to ' + hourWord(rules.hours.sendEnd) + ' Eastern)' : 'will send ' + hourWord(rules.hours.sendStart) };
}

/** Jo's (edited) text must pass exactly what the system's own drafts pass. Same function as PR 3, no second copy. */
function textProblem(text) {
  if (typeof text !== 'string') return 'The message is missing.';
  return D.draftProblem(text);
}

/** @returns {number|null} epoch ms of a Firestore Timestamp, Date, number or {seconds}, else null */
function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v.toMillis === 'function') { const n = v.toMillis(); return Number.isFinite(n) ? n : null; }
  if (v instanceof Date) { const n = v.getTime(); return Number.isFinite(n) ? n : null; }
  if (v && typeof v === 'object') {
    const s = typeof v.seconds === 'number' ? v.seconds : typeof v._seconds === 'number' ? v._seconds : null;
    if (s !== null) return s * 1000;
  }
  return null;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The card the approval screen shows: a whitelist, nothing copied through. The strings that came
 * from an Opportunity (the quote in the draft) still reach the screen only as text; the client escapes them.
 */
function cardOf(oppId, draft, seen, nowMs, rules) {
  const d = draft || {}, s = seen || {};
  const seenAt = toMs(s.seenAt);
  const posted = num(s.postedAgeMin);
  const ageNowMin = posted === null ? null : posted + (seenAt === null ? 0 : Math.max(0, Math.floor((nowMs - seenAt) / 60000)));
  const edited = typeof d.editedText === 'string' && d.editedText ? d.editedText : null;
  const snoozedUntilMs = toMs(d.snoozedUntil);
  return {
    oppId,
    status: str(d.status, 20),
    text: str(d.approvedText || edited || d.draftText, D.DRAFT_MAX + 50),
    originalText: edited || d.approvedText ? str(d.draftText, D.DRAFT_MAX + 50) : null,
    editedByJo: d.editedByJo === true,
    templateKey: str(d.templateKey, 40),
    category: str(s.category, 60), tradeKey: str(s.tradeKey, 30), city: str(s.city, 60), zip: /^\d{5}$/.test(String(s.zip || '')) ? String(s.zip) : '',
    milesNearestBase: num(s.milesNearestBase), baseUsed: str(s.baseUsed, 30), prosAlready: num(s.prosAlready), photos: num(s.photos),
    ageNowMin, score: num(s.score),
    reasons: Array.isArray(s.reasons) ? s.reasons.slice(0, 8).map((r) => str(r, 200)).filter(Boolean) : [],
    flags: Array.isArray(s.flags) ? s.flags.slice(0, 8).map((f) => str(f, 40)).filter(Boolean) : [],
    snoozedUntilMs: snoozedUntilMs !== null && snoozedUntilMs > nowMs ? snoozedUntilMs : null,
    approvedAtMs: toMs(d.approvedAt),
    sendLabel: d.status === 'approved' ? str(d.sendLabel, 80) : null,
    skipReason: d.status === 'skipped' ? str(d.skipReason, 30) : null,
  };
}

module.exports = {
  ACTIONS, SKIP_REASONS, SNOOZE_MS, TEXT_INPUT_MAX, dayKey, weekKey, capCounts, bumpCaps, hourWord, sendLabel, textProblem, toMs, cardOf,
};
