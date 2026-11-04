/**
 * weekly-targets-logic.js — "the Sunday review that acts" (Daily Success,
 * 2026-10-23). From the week's real numbers — workouts done, floors hit,
 * calories eaten vs the target, the weigh-in rule — it PROPOSES next week's
 * targets. Nothing is ever applied here: the review sheet shows each proposal
 * with an explicit Accept button, and only that tap writes (workouts per week
 * into the coach settings, the calorie target into the food settings).
 * House rule: never invent a number — every proposal is derived from the
 * inputs and names why; thin data produces a note, not a target.
 * Pure. window.NBDWeeklyTargets + module.exports.
 */
(function () {
  'use strict';
  const MIN_W = 1, MAX_W = 7;      // stored workouts-per-week range
  const PROPOSE_MIN = 2, PROPOSE_MAX = 6;
  const MIN_CAL_DAYS = 4;          // logged food days needed before a calorie change is trusted
  const CAL_FLOOR = 1200;          // a proposal never goes below this
  const OVER_BAND = 150;           // eating this far over the target means the target is not the problem
  const FLOORS_OK = 70, FLOORS_LOW = 60;
  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  /** A stored workouts-per-week target: a whole number 1-7, else null. */
  function normWeekly(v) {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    const n = Math.round(Number(v));
    return String(v).trim() !== '' && Number.isFinite(n) && n >= MIN_W && n <= MAX_W ? n : null;
  }

  /** Finished workouts dated in [from, to] inclusive. */
  function countWorkouts(sessions, from, to) {
    if (!isDk(from) || !isDk(to)) return 0;
    return (sessions || []).filter((s) => s && s.finishedAt && isDk(s.date) && s.date >= from && s.date <= to).length;
  }

  /** Average logged calories over [from, to]; only days with calories count. {avg, days} */
  function calorieWeek(series, from, to) {
    const rows = (series || []).filter((r) => r && r.cal > 0 && r.dk >= from && r.dk <= to);
    return { days: rows.length, avg: rows.length ? Math.round(rows.reduce((s, r) => s + r.cal, 0) / rows.length) : null };
  }

  /**
   * in: { workouts, workoutTarget, floorsPct, calDays, calAvg, calTarget, weightRule }
   * out: { items: [{ id, label, from, to, reason }], notes: [string] }
   */
  function propose(inp) {
    const x = inp || {};
    const items = [], notes = [];
    const w = Number(x.workouts) || 0;
    const T = normWeekly(x.workoutTarget);
    const floorsPct = Number.isFinite(x.floorsPct) ? x.floorsPct : null;

    // Workouts per week
    if (T == null) {
      if (w > 0) {
        const to = Math.min(PROPOSE_MAX, Math.max(PROPOSE_MIN, w));
        items.push({ id: 'workouts', label: 'Workouts per week', from: null, to, reason: 'You did ' + w + ' this week. Make it the number you aim for.' });
      }
    } else if (w >= T && T < PROPOSE_MAX && (floorsPct == null || floorsPct >= FLOORS_OK)) {
      items.push({ id: 'workouts', label: 'Workouts per week', from: T, to: T + 1, reason: 'You hit ' + w + '/' + T + (floorsPct != null ? ' and your floors were at ' + floorsPct + '%' : '') + '. One more is a fair step.' });
    } else if (w <= T - 2 && T > PROPOSE_MIN) {
      items.push({ id: 'workouts', label: 'Workouts per week', from: T, to: T - 1, reason: 'You did ' + w + '/' + T + '. A target you hit beats one you miss; step back one.' });
    } else if (w >= T) {
      notes.push('Workouts ' + w + '/' + T + ' - target stays' + (floorsPct != null && floorsPct < FLOORS_OK ? ' until the floors recover.' : '.'));
    } else {
      notes.push('Workouts ' + w + '/' + T + ' - target stays.');
    }

    // Calories (only when the weigh-in rule already says to cut)
    const wr = x.weightRule || {};
    const tgt = Number(x.calTarget) > 0 ? Math.round(Number(x.calTarget)) : null;
    if (wr.verdict === 'adjust' && wr.newCalories > 0 && tgt) {
      if (!(x.calDays >= MIN_CAL_DAYS)) notes.push('Calories: log food on ' + MIN_CAL_DAYS + '+ days before changing the target (' + (x.calDays || 0) + ' logged).');
      else if (x.calAvg > tgt + OVER_BAND) notes.push('Calories: you averaged ' + x.calAvg + ' against a ' + tgt + ' target. Hit the target first; lowering it will not help.');
      else if (wr.newCalories < CAL_FLOOR) notes.push('Calories: the rule would go below ' + CAL_FLOOR + '. Talk to a professional before cutting further.');
      else items.push({ id: 'calories', label: 'Daily calories', from: tgt, to: Math.round(wr.newCalories), reason: 'Weight did not fall 0.5 lb and you averaged ' + x.calAvg + ' against ' + tgt + '. The weigh-in rule says cut 200.' });
    }

    // Floors: informational only, the floor list is not changed from here
    if (floorsPct != null && floorsPct < FLOORS_LOW) notes.push('Floors hit ' + floorsPct + '%. Nothing changes automatically; trim the floor you miss most under Customize.');

    return { items, notes };
  }

  /** New coach-settings object with the weekly target set (nothing else touched). */
  function applyWorkouts(coachCfg, to) {
    const n = normWeekly(to);
    return n == null ? Object.assign({}, coachCfg) : Object.assign({}, coachCfg, { workoutsPerWeek: n });
  }
  /** New food-settings object with the calorie target set (favorites and protein kept). */
  function applyCalories(food, to) {
    const n = Math.round(Number(to));
    const f = Object.assign({ favorites: [] }, food);
    if (!(n >= CAL_FLOOR && n <= 8000)) return f;
    f.targets = Object.assign({}, f.targets, { calories: n });
    return f;
  }

  const api = { MIN_W, MAX_W, PROPOSE_MIN, PROPOSE_MAX, MIN_CAL_DAYS, CAL_FLOOR, OVER_BAND, normWeekly, countWorkouts, calorieWeek, propose, applyWorkouts, applyCalories };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NBDWeeklyTargets = api;
})();
