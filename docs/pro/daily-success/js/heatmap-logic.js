/**
 * heatmap-logic.js — the numbers behind the 12-month activity heatmap on the Progress card: one square per day, a week per column
 * (Monday first), shaded by the hard sets finished that day.
 *
 * Pure: no DOM, no storage. Only finished, undeleted workouts count; the coach's own volume() decides what a hard set is (warm-ups never
 * count), passed in so tests drive the real one. Dates are local YYYY-MM-DD strings, never parsed with new Date('YYYY-MM-DD').
 */
(function (root) {
  'use strict';

  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const parse = (dk) => { const [y, m, d] = dk.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (dk, n) => { const d = parse(dk); d.setDate(d.getDate() + n); return ymd(d); };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** Shade by hard sets in the day: 0 none, then 1-8, 9-15, 16-24, 25+. */
  const LEVELS = [1, 9, 16, 25];

  function levelFor(sets) {
    let lv = 0;
    for (let i = 0; i < LEVELS.length; i++) if (sets >= LEVELS[i]) lv = i + 1;
    return lv;
  }

  /**
   * -> { weeks: [[cell|null x7]], months: [{ col, label }], workouts, activeDays, sets, bestWeek }
   * cell = { date, sets, workouts, level }; days after today are null. o = { coach, weeks (default 52) }
   */
  function heatmap(sessions, todayYmd, o) {
    const opt = o || {};
    const C = opt.coach;
    const n = opt.weeks > 0 ? Math.floor(opt.weeks) : 52;
    const empty = { weeks: [], months: [], workouts: 0, activeDays: 0, sets: 0, bestWeek: 0 };
    if (!C || !isDk(todayYmd)) return empty;
    const dow = (parse(todayYmd).getDay() + 6) % 7;            // Monday = 0
    const start = addDays(todayYmd, -dow - (n - 1) * 7);
    const by = new Map();
    for (const s of sessions || []) {
      if (!s || s.deleted || !s.finishedAt || !isDk(s.date) || s.date < start) continue;
      const row = by.get(s.date) || { sets: 0, workouts: 0 };
      row.sets += C.volume(s).sets; row.workouts++;
      by.set(s.date, row);
    }
    const weeks = [], months = [];
    let workouts = 0, activeDays = 0, sets = 0, bestWeek = 0, lastMonth = -1;
    for (let c = 0; c < n; c++) {
      const col = [];
      let weekSets = 0;
      for (let r = 0; r < 7; r++) {
        const date = addDays(start, c * 7 + r);
        if (date > todayYmd) { col.push(null); continue; }
        const row = by.get(date) || { sets: 0, workouts: 0 };
        col.push({ date, sets: row.sets, workouts: row.workouts, level: row.workouts ? Math.max(1, levelFor(row.sets)) : 0 });
        workouts += row.workouts; sets += row.sets; weekSets += row.sets;
        if (row.workouts) activeDays++;
      }
      bestWeek = Math.max(bestWeek, weekSets);
      const m = parse(col[0].date).getMonth();                // the column's Monday names its month
      if (m !== lastMonth) { months.push({ col: c, label: MONTHS[m] }); lastMonth = m; }
      weeks.push(col);
    }
    return { weeks, months, workouts, activeDays, sets, bestWeek };
  }

  const api = { heatmap, levelFor, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDHeatmap = api;
})(typeof window !== 'undefined' ? window : null);
