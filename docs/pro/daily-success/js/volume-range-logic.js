/**
 * volume-range-logic.js — the volume map over a longer window: hard sets per muscle as a WEEKLY AVERAGE over the last week, 30 days, 90 days
 * or everything logged, against the same 10-20 sets a week band, with the window just before it as the comparison tick.
 *
 * Pure: no DOM, no storage. It combines what workout-coach-logic.js already computes (balance counts working sets; warm-ups never count),
 * passed in so tests drive the real one. 'week' reproduces the coach's own volumeMap row for row.
 */
(function (root) {
  'use strict';

  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const parse = (dk) => { const [y, m, d] = dk.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (dk, n) => { const d = parse(dk); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const dayDiff = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const RANGES = [{ id: 'week', label: 'Week', days: 7 }, { id: '30d', label: '30d', days: 30 }, { id: '90d', label: '90d', days: 90 }, { id: 'all', label: 'All', days: null }];
  const round1 = (n) => Math.round(n * 10) / 10;

  /**
   * -> { range, days, weeks, band, rows: [{ muscle, label, now, prev|null, total, delta|null, status }], total, sessions, enough, hasPrev }
   * now/prev are sets per week (one decimal); total is the raw count in the window. o = { coach, equip, avoid }
   */
  function volumeRange(sessions, todayYmd, range, o) {
    const opt = o || {};
    const C = opt.coach;
    const def = RANGES.find((r) => r.id === range);
    const empty = { range: def ? def.id : null, days: 0, weeks: 0, band: null, rows: [], total: 0, sessions: 0, enough: false, hasPrev: false };
    if (!C || !def || !isDk(todayYmd)) return empty;
    let days = def.days;
    if (!days) {
      const dates = (sessions || []).filter((s) => s && !s.deleted && s.finishedAt && isDk(s.date) && s.date <= todayYmd).map((s) => s.date).sort();
      days = dates.length ? dayDiff(dates[0], todayYmd) + 1 : 7;
    }
    const weeks = Math.max(1, days / 7);
    const hasPrev = def.days != null;
    const now = C.balance(sessions, todayYmd, { days, equip: opt.equip, avoid: opt.avoid });
    const prev = hasPrev ? C.balance(sessions, addDays(todayYmd, -days), { days, equip: opt.equip, avoid: opt.avoid }) : null;
    const trainable = new Set(C.volumeMap(sessions, todayYmd, { equip: opt.equip, avoid: opt.avoid }).rows.map((r) => r.muscle));
    const band = C.VOLUME_BAND;
    const rows = C.MUSCLES.filter((m) => trainable.has(m)).map((m) => {
      const per = now.byMuscle[m] / weeks;
      const pPer = prev ? prev.byMuscle[m] / weeks : null;
      const status = now.byMuscle[m] === 0 ? 'none' : per < band.min ? 'under' : per > band.max ? 'over' : 'in';
      return { muscle: m, label: C.MUSCLE_LABELS[m], now: round1(per), prev: pPer == null ? null : round1(pPer), total: now.byMuscle[m],
        delta: pPer == null ? null : round1(per - pPer), status };
    });
    return { range: def.id, days, weeks: round1(weeks), band, rows, total: now.total, sessions: now.sessions, enough: now.sessions > 0 && now.total >= 6, hasPrev };
  }

  const api = { volumeRange, RANGES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDVolumeRange = api;
})(typeof window !== 'undefined' ? window : null);
