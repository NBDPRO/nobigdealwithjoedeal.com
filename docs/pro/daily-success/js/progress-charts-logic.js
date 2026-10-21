/**
 * progress-charts-logic.js — the pure numbers behind the Progress card
 * (Daily Success, tracker revamp Phase 1 leftovers: "charts: per-lift
 * estimated 1RM over time, and weekly volume" —
 * documentation/projects/DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md).
 *
 * Reads the Workout Coach's finished sessions (nbd_ds_workouts, the same
 * shape workout-coach-logic.js documents) and returns:
 *   liftSeries   one point per session for a lift: best estimated 1RM, the
 *                set that made it, and whether it was a new best (PR)
 *   topLifts     the lifts Jo actually does lately, most-done first, for chips
 *   liftSummary  first / latest / best / change over the window
 *   weeklyVolume lbs lifted per Monday-to-Sunday week, zero weeks included
 *   lineChart / barChart   tiny inline-SVG strings (no library)
 *
 * Estimated 1RM is Epley from the coach (NBDCoach.e1rm). Sets over 12 reps
 * are ignored for it: Epley overstates high-rep sets, and a 20-rep burnout
 * must not look like a strength PR. Dates are local YYYY-MM-DD strings, never
 * parsed with new Date('YYYY-MM-DD') (UTC midnight is the day before in
 * New York).
 *
 * Exposed as window.NBDProgress and module.exports (tests).
 */
(function (root) {
  'use strict';

  const MAX_E1RM_REPS = 12;
  const DAY = 86400000;

  const coach = () => (root && root.NBDCoach) || (typeof require === 'function' ? require('./workout-coach-logic.js') : null);
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const ymdMs = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const msYmd = (ms) => { const t = new Date(ms); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
  const validYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const live = (sessions) => (sessions || []).filter((s) => s && !s.deleted && s.finishedAt && validYmd(s.date));
  const done = (ex) => ((ex && ex.sets) || []).filter((s) => s && !s.warm && s.done !== false && num(s.reps) > 0);

  /**
   * Oldest → newest, one point per day the lift was done:
   * [{ date, e1rm, weight, reps, pr }]. A day with two sessions keeps the
   * better set. `pr` = beat every earlier point.
   */
  function liftSeries(exId, sessions, opts) {
    const C = coach();
    const byDay = new Map();
    for (const s of live(sessions)) {
      for (const ex of s.exercises || []) {
        if (ex.exId !== exId) continue;
        for (const set of done(ex)) {
          if (Math.round(num(set.reps)) > MAX_E1RM_REPS) continue;
          const e = C.e1rm(set.weight, set.reps);
          if (e <= 0) continue;
          const cur = byDay.get(s.date);
          if (!cur || e > cur.e1rm) byDay.set(s.date, { date: s.date, e1rm: e, weight: num(set.weight), reps: Math.round(num(set.reps)) });
        }
      }
    }
    let pts = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    let best = 0;
    pts = pts.map((p) => { const pr = p.e1rm > best; if (pr) best = p.e1rm; return Object.assign({}, p, { pr }); });
    const since = opts && opts.sinceYmd;
    return since ? pts.filter((p) => p.date >= since) : pts;
  }

  /** [{ exId, name, count, lastDate }] — lifts done in the last `days`, most-done first (ties: most recent). */
  function topLifts(sessions, todayYmd, n, days) {
    const C = coach();
    const from = msYmd(ymdMs(todayYmd) - (days || 180) * DAY);
    const map = new Map();
    for (const s of live(sessions)) {
      if (s.date < from || s.date > todayYmd) continue;
      const seen = new Set();
      for (const ex of s.exercises || []) {
        if (!ex.exId || seen.has(ex.exId) || !done(ex).some((st) => Math.round(num(st.reps)) <= MAX_E1RM_REPS && num(st.weight) > 0)) continue;
        seen.add(ex.exId);
        const cur = map.get(ex.exId) || { exId: ex.exId, name: '', count: 0, lastDate: '' };
        cur.count++;
        if (s.date >= cur.lastDate) { cur.lastDate = s.date; cur.name = (C.BY_ID && C.BY_ID[ex.exId] && C.BY_ID[ex.exId].name) || ex.name || ex.exId; }
        map.set(ex.exId, cur);
      }
    }
    return [...map.values()].sort((a, b) => (b.count - a.count) || (a.lastDate < b.lastDate ? 1 : -1)).slice(0, n || 6);
  }

  /** { count, first, latest, best, change, changePct } — change = latest − first. null when there is nothing. */
  function liftSummary(series) {
    const s = series || [];
    if (!s.length) return { count: 0, first: null, latest: null, best: null, change: null, changePct: null };
    const first = s[0].e1rm, latest = s[s.length - 1].e1rm;
    const best = Math.max.apply(null, s.map((p) => p.e1rm));
    const change = s.length > 1 ? Math.round((latest - first) * 10) / 10 : null;
    return { count: s.length, first, latest, best, change, changePct: change != null && first > 0 ? Math.round(change / first * 1000) / 10 : null };
  }

  /** Monday (local) on or before ymd. */
  function weekStart(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(y, m - 1, d);
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    return msYmd(t.getTime());
  }

  /** The last `weeks` weeks ending with this one, oldest → newest: [{ week, lbs, sets }]. */
  function weeklyVolume(sessions, todayYmd, weeks) {
    const C = coach();
    const n = weeks || 12;
    const last = weekStart(todayYmd);
    const keys = [];
    for (let i = n - 1; i >= 0; i--) { const t = new Date(ymdMs(last)); t.setDate(t.getDate() - i * 7); keys.push(msYmd(t.getTime())); }
    const acc = new Map(keys.map((k) => [k, { week: k, lbs: 0, sets: 0 }]));
    for (const s of live(sessions)) {
      if (s.date > todayYmd) continue;
      const w = acc.get(weekStart(s.date));
      if (!w) continue;
      const v = C.volume(s);
      w.lbs += v.lbs; w.sets += v.sets;
    }
    return keys.map((k) => acc.get(k));
  }

  const shortDate = (ymd) => { const [, m, d] = ymd.split('-').map(Number); return m + '/' + d; };

  /** Inline SVG line of est. 1RM; PR days get a dot. '' under 2 points. */
  function lineChart(points, label, w, h) {
    const W = w || 300, H = h || 120, padL = 34, padR = 8, padT = 8, padB = 18;
    const pts = points || [];
    if (pts.length < 2) return '';
    const vals = pts.map((p) => p.e1rm);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 5) { const mid = (hi + lo) / 2; lo = mid - 2.5; hi = mid + 2.5; }
    const t0 = ymdMs(pts[0].date), t1 = ymdMs(pts[pts.length - 1].date), span = t1 - t0 || 1;
    const X = (p) => padL + (ymdMs(p.date) - t0) / span * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const line = pts.map((p) => X(p).toFixed(1) + ',' + Y(p.e1rm).toFixed(1)).join(' ');
    const dots = pts.filter((p) => p.pr).map((p) => '<circle class="pg-pr" cx="' + X(p).toFixed(1) + '" cy="' + Y(p.e1rm).toFixed(1) + '" r="3.5"/>').join('');
    return '<svg class="pg-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(label || 'Estimated 1RM over time') + '">' +
      '<text class="pg-ax" x="2" y="' + (padT + 8) + '">' + Math.round(hi) + '</text><text class="pg-ax" x="2" y="' + (H - padB) + '">' + Math.round(lo) + '</text>' +
      '<text class="pg-ax" x="' + padL + '" y="' + (H - 4) + '">' + esc(shortDate(pts[0].date)) + '</text>' +
      '<text class="pg-ax" x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(shortDate(pts[pts.length - 1].date)) + '</text>' +
      '<polyline class="pg-line" fill="none" stroke-width="2" points="' + line + '"/>' + dots + '</svg>';
  }

  /** Inline SVG bars of weekly volume; the current (last) week is marked. '' when no week has volume. */
  function barChart(weeks, label, w, h) {
    const W = w || 300, H = h || 100, padB = 14, padT = 6;
    const ws = weeks || [];
    const max = Math.max.apply(null, ws.map((x) => x.lbs).concat([0]));
    if (!ws.length || max <= 0) return '';
    const slot = W / ws.length, bw = Math.max(4, slot - 4);
    const bars = ws.map((x, i) => {
      const bh = x.lbs > 0 ? Math.max(2, x.lbs / max * (H - padT - padB)) : 0;
      return '<rect class="pg-bar' + (i === ws.length - 1 ? ' now' : '') + '" x="' + (i * slot + (slot - bw) / 2).toFixed(1) + '" y="' + (H - padB - bh).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2"><title>Week of ' + esc(x.week) + ': ' + x.lbs.toLocaleString('en-US') + ' lb</title></rect>';
    }).join('');
    return '<svg class="pg-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(label || 'Weekly volume') + '">' + bars +
      '<text class="pg-ax" x="2" y="' + (H - 2) + '">' + esc(shortDate(ws[0].week)) + '</text><text class="pg-ax" x="' + (W - 2) + '" y="' + (H - 2) + '" text-anchor="end">this week</text></svg>';
  }

  const api = { MAX_E1RM_REPS, liftSeries, topLifts, liftSummary, weekStart, weeklyVolume, lineChart, barChart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDProgress = api;
})(typeof window !== 'undefined' ? window : null);
