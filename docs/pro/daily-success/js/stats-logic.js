/**
 * stats-logic.js — the four numbers on the Stats tile row: workouts all time, workouts this month, the week streak and the 30-day weight
 * change.
 *
 * Pure: no DOM, no storage. Only finished, undeleted workouts count. The week streak is consecutive Monday-to-Sunday weeks that hit the
 * weekly workout goal (the coach's target, or 1 when none is set); the week in progress counts once it has hit the goal and never breaks
 * the streak before then. Weight comes in as tracker-history-logic's weightTrend() result, so nothing is recomputed here.
 */
(function (root) {
  'use strict';

  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const parse = (dk) => { const [y, m, d] = dk.split('-').map(Number); return new Date(y, m - 1, d); };
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const addDays = (dk, n) => { const d = parse(dk); d.setDate(d.getDate() + n); return ymd(d); };
  const weekStart = (dk) => addDays(dk, -((parse(dk).getDay() + 6) % 7));
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Consecutive weeks (Mon-Sun) with at least `goal` workouts, ending now. -> { count, thisWeek, goal } */
  function weekStreak(sessions, todayYmd, goal) {
    const g = goal > 0 ? Math.max(1, Math.round(goal)) : 1;   // 0.4 would round to 0, and an empty week would then "hit" it
    const perWeek = new Map();
    let oldest = null;
    for (const s of sessions || []) {
      if (!s || s.deleted || !s.finishedAt || !isDk(s.date) || s.date > todayYmd) continue;
      const w = weekStart(s.date);
      perWeek.set(w, (perWeek.get(w) || 0) + 1);
      if (oldest == null || w < oldest) oldest = w;
    }
    const cur = weekStart(todayYmd);
    const thisWeek = perWeek.get(cur) || 0;
    let count = thisWeek >= g ? 1 : 0;
    for (let w = addDays(cur, -7); oldest != null && w >= oldest; w = addDays(w, -7)) {
      if ((perWeek.get(w) || 0) >= g) count++; else break;
    }
    return { count, thisWeek, goal: g };
  }

  /**
   * -> { tiles: [{ id, label, value, sub }], enough }   o = { target (workouts a week), trend (weightTrend result) }
   */
  function statsTiles(sessions, todayYmd, o) {
    const opt = o || {};
    if (!isDk(todayYmd)) return { tiles: [], enough: false };
    const fin = (sessions || []).filter((s) => s && !s.deleted && s.finishedAt && isDk(s.date) && s.date <= todayYmd);
    const monthKey = todayYmd.slice(0, 7);
    const thisMonth = fin.filter((s) => s.date.slice(0, 7) === monthKey).length;
    const st = weekStreak(sessions, todayYmd, Number(opt.target));
    const raw = opt.trend && opt.trend.change30 != null ? Number(opt.trend.change30) : null;
    const ch = raw != null && Number.isFinite(raw) ? Math.round(raw * 10) / 10 : null;   // sign and text both come from the rounded value, so -0.04 reads 0.0, not "−0.0"
    const tiles = [
      { id: 'workouts', label: 'Workouts', value: String(fin.length), sub: 'all time' },
      { id: 'month', label: 'This month', value: String(thisMonth), sub: MONTHS[parse(todayYmd).getMonth()] },
      { id: 'weekstreak', label: 'Week streak', value: String(st.count), sub: st.thisWeek + '/' + st.goal + ' this week' },
      { id: 'weight30', label: 'Weight 30d', value: ch == null ? '—' : (ch > 0 ? '+' : ch < 0 ? '−' : '') + Math.abs(ch).toFixed(1) + ' lb', sub: ch == null ? 'weigh in to see it' : '7-day average' },
    ];
    return { tiles, enough: fin.length > 0 || ch != null };
  }

  const api = { statsTiles, weekStreak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDStats = api;
})(typeof window !== 'undefined' ? window : null);
