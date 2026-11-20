/**
 * blankday-logic.js - the "yesterday is blank" banner and the "Days logged this week" line (Joe, 2026-11-18).
 * Pure; the screen is blankday-ui.js. window.NBDBlankDay + module.exports (tests).
 *
 *   BLANK day: none of the floors were met on it (pages of the same date merge) and no workout was finished that date.
 *   The banner is about YESTERDAY only. It stays quiet when:
 *     - yesterday was a Sunday (Sunday is not a required day, same rule as the streak and the miss tax),
 *     - the tracker has no earlier logged day (a new install is not nagged),
 *     - Joe tapped "Not now" today,
 *     - no floors are configured (every day would read blank).
 *   "Days logged": the 7 days ending today; a day counts when it is not blank.
 * A missed floor on an otherwise logged day is not blank. This is not the streak rule (review-logic.js): it only asks "did anything get logged".
 */
(function () {
  'use strict';
  const DAY = 86400000;
  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const dkMs = (dk) => { const [y, m, d] = String(dk).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const msDk = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const addDays = (dk, n) => msDk(dkMs(dk) + n * DAY + 12 * 3600000);   // noon anchor: DST-safe
  const isSunday = (dk) => new Date(dkMs(dk)).getDay() === 0;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = (dk) => { const t = new Date(dkMs(dk)); return DOW[t.getDay()] + ' ' + MON[t.getMonth()] + ' ' + t.getDate(); };
  const list = (v) => (Array.isArray(v) ? v : []);
  const trained = (fn, dk) => { try { return typeof fn === 'function' && !!fn(dk); } catch (_) { return false; } };

  /** True when no floor was met on dk and no workout was finished that date. */
  function isBlankDay(pages, floors, hasWorkout, dk) {
    const ids = list(floors).map((f) => f && f.id);
    for (const p of list(pages)) {
      if (!p || p.dk !== dk) continue;
      const d = p.data || {};
      if (ids.some((id) => d['floormet-' + id] === '1')) return false;
    }
    return !trained(hasWorkout, dk);
  }

  /**
   * { dk, label } when the banner should show, else null.
   * o: { pages, floors, hasWorkout(dk), todayDk, dismissedFor }  (dismissedFor is the date "Not now" was tapped on)
   */
  function bannerFor(o) {
    const x = o || {};
    if (!isDk(x.todayDk) || !list(x.floors).length) return null;
    if (x.dismissedFor === x.todayDk) return null;
    const dk = addDays(x.todayDk, -1);
    if (isSunday(dk) || !isBlankDay(x.pages, x.floors, x.hasWorkout, dk)) return null;
    // a tracker that has never logged a day is not nagged: it needs at least one earlier day that is not blank
    const earlier = list(x.pages).some((p) => p && isDk(p.dk) && p.dk < dk && !isBlankDay(x.pages, x.floors, x.hasWorkout, p.dk));
    return earlier ? { dk, label: label(dk) } : null;
  }

  /** { logged, of: 7, from, to } for the 7 days ending today, or null with no floors / a bad date. */
  function daysLogged(pages, floors, hasWorkout, todayDk) {
    if (!isDk(todayDk) || !list(floors).length) return null;
    const from = addDays(todayDk, -6);
    let logged = 0;
    for (let i = 0; i < 7; i++) if (!isBlankDay(pages, floors, hasWorkout, addDays(from, i))) logged++;
    return { logged, of: 7, from, to: todayDk };
  }

  const api = { isBlankDay, bannerFor, daysLogged, addDays, label };
  if (typeof window !== 'undefined') window.NBDBlankDay = Object.assign(window.NBDBlankDay || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
