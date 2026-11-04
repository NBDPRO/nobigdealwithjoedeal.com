/**
 * week-training-logic.js — the training half of the Sunday review (roadmap phase 3): workouts, PRs and hard sets per muscle for the review's
 * week, this week against the one before.
 *
 * Pure: no DOM, no storage. It only combines what workout-coach-logic.js already computes (historyList for PRs, volumeMap for the sets),
 * passed in so tests can drive the real one. The review's window is the 7 finished days [from, to] (review-logic.js weekWindow); volumeMap
 * counts the 7 days ending on the date it is given, so it is called with `to`.
 */
(function (root) {
  'use strict';

  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const sign = (n) => (n > 0 ? '+' + n : String(n));

  /**
   * -> { workouts, target|null, sets, prevSets, prs: [{ date, name, text }], muscles: [{ label, now, prev, delta, status }], enough }
   * w = { from, to } (inclusive), o = { coach: NBDCoach, target, equip, avoid }
   * muscles lists only groups trained in either week; PRs are each session's new bests against the sessions before it.
   */
  function weekTraining(sessions, w, o) {
    const opt = o || {};
    const C = opt.coach;
    const empty = { workouts: 0, target: null, sets: 0, prevSets: 0, prs: [], muscles: [], enough: false };
    if (!C || !w || !isDk(w.from) || !isDk(w.to)) return empty;
    const hist = C.historyList(sessions, 500).filter((r) => r.date >= w.from && r.date <= w.to);
    const prs = [];
    hist.slice().reverse().forEach((r) => (r.prs || []).forEach((p) => {
      prs.push({ date: r.date, name: p.name, text: p.kind === 'e1rm' ? 'est. 1RM ' + Math.round(p.e1rm) + ' (was ' + Math.round(p.prev) + ')' : p.reps + ' reps at ' + p.weight + ' (was ' + p.prev + ')' });
    }));
    const vol = C.volumeMap(sessions, w.to, { equip: opt.equip, avoid: opt.avoid });
    const muscles = vol.rows.filter((r) => r.now > 0 || r.prev > 0)
      .map((r) => ({ label: r.label, now: r.now, prev: r.prev, delta: r.delta, status: r.status }))
      .sort((a, b) => b.now - a.now);
    const target = Number(opt.target) > 0 ? Math.round(Number(opt.target)) : null;
    return { workouts: hist.length, target, sets: vol.nowTotal, prevSets: vol.prevTotal, prs, muscles, enough: hist.length > 0 };
  }

  /** Plain-text lines for the copied scorecard. */
  function scorecardLines(t) {
    if (!t || !t.enough) return ['Training: no finished workouts this week'];
    const lines = ['Training: ' + t.workouts + (t.target ? '/' + t.target : '') + ' workouts · ' + t.sets + ' hard sets (' + sign(t.sets - t.prevSets) + ' vs last week)'];
    t.prs.forEach((p) => lines.push('  PR ' + p.name + ': ' + p.text));
    t.muscles.forEach((m) => lines.push('  ' + m.label + ': ' + m.now + ' sets (' + sign(m.delta) + ')'));
    return lines;
  }

  const api = { weekTraining, scorecardLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDWeekTraining = api;
})(typeof window !== 'undefined' ? window : null);
