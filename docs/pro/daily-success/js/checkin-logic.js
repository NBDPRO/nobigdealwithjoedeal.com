/**
 * checkin-logic.js — the 10-second morning readiness check-in on the day page
 * (Daily Success, 2026-10-23). The scoring already lives in the Workout Coach
 * (workout-coach-logic.js readiness / applyReadiness); this only decides when
 * the check-in shows and records the three taps in the SAME store the coach
 * reads (nbd_ds_coach_ready: { 'YYYY-MM-DD': { sleep, sore, energy } }, this
 * device only), so starting a workout later carries it over and applies it.
 * Pure. window.NBDCheckin + module.exports.
 */
(function () {
  'use strict';
  const ASK_UNTIL = 17; // from 5 pm the day-wrap-up takes the slot; an unanswered check-in just goes quiet
  const KEEP = 30;      // same cap the coach uses
  const ROWS = [
    { k: 'sleep', label: 'Sleep', opts: ['Rough', 'OK', 'Good'] },
    { k: 'sore', label: 'Soreness', opts: ['Very sore', 'Some', 'Fresh'] },
    { k: 'energy', label: 'Energy', opts: ['Low', 'OK', 'High'] },
  ];
  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const score = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 3 ? n : 0; };
  const isComplete = (rec) => !!(rec && !rec.skipped && score(rec.sleep) && score(rec.sore) && score(rec.energy));

  function prune(map) {
    const keys = Object.keys(map).sort();
    keys.slice(0, Math.max(0, keys.length - KEEP)).forEach((k) => { delete map[k]; });
    return map;
  }

  /**
   * What the day page shows for a date.
   *   ask     — today, before 5 pm, nothing answered or skipped: the three rows
   *   partial — some taps made, not all: the rows stay up with those taps shown
   *   done    — all three answered
   *   skipped — dismissed for the day: nothing shown
   *   hidden  — any other day, or too late to matter
   */
  function state(map, dk, todayDk, hour) {
    if (dk !== todayDk) return 'hidden';
    const rec = map && map[dk];
    if (isComplete(rec)) return 'done';
    if (rec && rec.skipped) return 'skipped';
    if (Number(hour) >= ASK_UNTIL) return 'hidden';
    return rec && (score(rec.sleep) || score(rec.sore) || score(rec.energy)) ? 'partial' : 'ask';
  }

  /** New map with one tap recorded; a bad key or value changes nothing. */
  function tap(map, dk, key, value) {
    const next = Object.assign({}, map);
    if (!isDk(dk) || !ROWS.some((r) => r.k === key) || !score(value)) return next;
    const cur = next[dk] && !next[dk].skipped ? next[dk] : {};
    const rec = {};
    ROWS.forEach((r) => { if (score(cur[r.k])) rec[r.k] = score(cur[r.k]); });
    rec[key] = score(value);
    next[dk] = rec;
    return prune(next);
  }

  /** "Not today": remembered for the date. Never overwrites a finished check-in. */
  function skip(map, dk) {
    const next = Object.assign({}, map);
    if (!isDk(dk) || isComplete(next[dk])) return next;
    next[dk] = { skipped: true };
    return prune(next);
  }

  /** Forget the day's check-in so it can be done again. */
  function reset(map, dk) { const next = Object.assign({}, map); delete next[dk]; return next; }

  /** One plain sentence for a finished check-in; q is NBDCoach.readiness(rec). */
  function message(q) {
    if (!q || !q.complete) return '';
    if (q.level === 'low') return 'Readiness ' + q.total + '/9 - rough day. When you start your workout the coach drops a set on lifts with 3+ sets and holds the weight. You can undo it there.';
    return 'Readiness ' + q.total + '/9 - ' + (q.level === 'good' ? 'good to go' : 'steady day') + '. Your plan stays as it is.';
  }

  const api = { ASK_UNTIL, KEEP, ROWS, isComplete, state, tap, skip, reset, message };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NBDCheckin = api;
})();
