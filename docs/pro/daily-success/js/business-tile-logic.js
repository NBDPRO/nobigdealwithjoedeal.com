/**
 * business-tile-logic.js — "Today's business" tile on the Daily Success day
 * page (2026-10-23). The CRM's Today screen publishes three counts (calls to
 * return, follow-ups due, jobs today) to localStorage nbd_today_summary
 * (today-home.js publishToTracker; the numbers come from today-plan.js
 * summaryForTracker, so they match the CRM). The tracker reads NOTHING from
 * Firestore for this and needs no rules change.
 *
 * Pure. read() is the whole trust boundary: a summary is used only when it is
 * for the signed-in user, well-formed, from today and under 12 hours old.
 * Anything else is "open the CRM to refresh" - a stale number is never shown
 * as current. window.NBDBusinessTile + module.exports.
 */
(function () {
  'use strict';
  const KEY = 'nbd_today_summary';
  const MAX_AGE_MS = 12 * 3600000;
  const FUTURE_SLACK_MS = 5 * 60000;   // clock skew between tabs
  const MAX_COUNT = 9999;
  const isCount = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;
  const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };

  /** 'as of 7:40 am' (local time). */
  function label(asOf) {
    const d = new Date(asOf);
    const h = d.getHours(), m = d.getMinutes();
    return 'as of ' + (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'am' : 'pm');
  }

  /**
   * raw: the stored string. uid: the signed-in user's uid. now: ms.
   * -> { ok: true, calls, followUps, jobs, asOf, label }
   *  | { ok: false, reason: 'no-user' | 'missing' | 'bad' | 'other-account' | 'stale' }
   */
  function read(raw, uid, now) {
    if (typeof uid !== 'string' || !uid) return { ok: false, reason: 'no-user' };
    if (raw == null || raw === '') return { ok: false, reason: 'missing' };
    let s;
    try { s = JSON.parse(raw); } catch (_) { return { ok: false, reason: 'bad' }; }
    if (!s || typeof s !== 'object' || Array.isArray(s) || s.v !== 1) return { ok: false, reason: 'bad' };
    if (s.uid !== uid) return { ok: false, reason: 'other-account' };
    if (!isCount(s.calls) || !isCount(s.followUps) || !isCount(s.jobs)) return { ok: false, reason: 'bad' };
    if (typeof s.asOf !== 'number' || !(s.asOf > 0) || s.asOf > now + FUTURE_SLACK_MS) return { ok: false, reason: 'bad' };
    if (now - s.asOf > MAX_AGE_MS || !sameDay(s.asOf, now)) return { ok: false, reason: 'stale' };
    return { ok: true, calls: s.calls, followUps: s.followUps, jobs: s.jobs, asOf: s.asOf, label: label(s.asOf) };
  }

  /** The one plain sentence shown when there is nothing trustworthy to show. */
  function refreshText(reason) {
    return reason === 'stale' ? 'The last numbers are too old to trust. Open the CRM to refresh.'
      : reason === 'other-account' ? 'Open the CRM once on this account to load today\'s numbers.'
      : 'Open the CRM to load today\'s numbers.';
  }

  const api = { KEY, MAX_AGE_MS, MAX_COUNT, label, read, refreshText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NBDBusinessTile = api;
})();
