/**
 * xp-logic.js — the pure XP, level and streak rules behind the Quest and Arcade layouts (roadmap: DAILY-SUCCESS-INTERFACES).
 *
 * No DOM, no storage. Everything is derived from history the tracker already keeps (finished workout sessions and the per-day floors
 * met), so there is no new collection and nothing to sync. Jo's rule (2026-10-22): the streak CAN break; XP is separate and never
 * drops. XP is computed from history, so the only way the total goes down is deleting a log; highWater() lets the screen keep the
 * best total it ever showed so even that cannot lower the level.
 *
 * XP (simple, shown to the user as-is):
 *   finished workout  100, +5 per working set (at most 40 sets count), +50 per personal record in it
 *   a day's floors    +10 per floor met, +25 more when every floor is met
 * Level n starts at 50 * n * (n - 1) XP (level 1 = 0, 2 = 100, 3 = 300, 4 = 600 ...).
 *
 * Streak: an "active" day is a finished workout, or at least half the floors met. A gap of up to REST_DAYS (default 1) inactive
 * days in a row is bridged (a rest day neither counts nor breaks); a longer gap breaks it. Today being empty so far never breaks
 * anything: the day is not over.
 */
(function (root) {
  'use strict';

  const WORKOUT_XP = 100, SET_XP = 5, SET_CAP = 40, PR_XP = 50, FLOOR_XP = 10, ALL_FLOORS_XP = 25;
  const REST_DAYS = 1;
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };

  /** Level n starts at this much XP. */
  const xpForLevel = (n) => (n <= 1 ? 0 : 50 * n * (n - 1));

  /** -> { level, xp, into (XP since this level started), need (XP this level spans), pct (0-1), next (XP where the next level starts) } */
  function levelFor(xp) {
    const x = Math.max(0, Math.floor(num(xp)));
    let n = 1;
    while (xpForLevel(n + 1) <= x) n++;
    const start = xpForLevel(n), next = xpForLevel(n + 1);
    return { level: n, xp: x, into: x - start, need: next - start, pct: (x - start) / (next - start), next };
  }

  /** The best total ever shown: never lets a lower recomputed total lower the number (e.g. after a log is deleted). */
  const highWater = (prev, now) => Math.max(Math.max(0, Math.floor(num(prev))), Math.max(0, Math.floor(num(now))));

  const byOrder = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : num(a.finishedAt) - num(b.finishedAt));
  const done = (sessions) => (Array.isArray(sessions) ? sessions : []).filter((s) => s && !s.deleted && s.finishedAt && /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || '')));
  const workingSets = (s) => {
    let n = 0;
    for (const ex of s.exercises || []) for (const st of (ex && ex.sets) || []) if (st && !st.warm && st.done !== false && num(st.reps) > 0) n++;
    return n;
  };

  /**
   * XP from finished sessions and per-day floors.
   * o.coach = the NBDCoach logic (for personal records; leave it out and PRs simply earn nothing extra).
   * o.days = [{ date, met, total }] (floors met of total, one entry per day).
   * -> { total, workouts, floors, prs, byDate: { 'YYYY-MM-DD': xp } }
   */
  function xpTotals(sessions, o) {
    const opt = o || {};
    const list = done(sessions).sort(byOrder);
    const byDate = {};
    const add = (d, v) => { byDate[d] = (byDate[d] || 0) + v; };
    let workouts = 0, floors = 0, prs = 0;
    list.forEach((s, i) => {
      let xp = WORKOUT_XP + SET_XP * Math.min(SET_CAP, workingSets(s));
      let hit = 0;
      if (opt.coach && typeof opt.coach.detectPRs === 'function') {
        try { hit = opt.coach.detectPRs(s, list.slice(0, i)).length; } catch (_) { hit = 0; }
      }
      xp += PR_XP * hit; prs += hit;
      add(s.date, xp); workouts += xp;
    });
    for (const d of Array.isArray(opt.days) ? opt.days : []) {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) continue;
      const total = Math.max(0, Math.floor(num(d.total))), met = Math.min(total, Math.max(0, Math.floor(num(d.met))));
      if (!met) continue;
      const xp = FLOOR_XP * met + (total > 0 && met === total ? ALL_FLOORS_XP : 0);
      add(d.date, xp); floors += xp;
    }
    return { total: workouts + floors, workouts, floors, prs, byDate };
  }

  const dayNum = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
  const ymdOf = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

  /** The set of active days: a finished workout, or at least half of a day's floors met. */
  function activeDays(sessions, days) {
    const set = new Set();
    for (const s of done(sessions)) set.add(s.date);
    for (const d of Array.isArray(days) ? days : []) {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) continue;
      const total = Math.floor(num(d.total)), met = Math.floor(num(d.met));
      if (total > 0 && met > 0 && met * 2 >= total) set.add(d.date);
    }
    return set;
  }

  /**
   * Current and best streak. active = a Set from activeDays(); today = 'YYYY-MM-DD'; rest = inactive days in a row that are bridged.
   * -> { current, best, activeToday, atRisk (today empty AND yesterday empty: one more empty day breaks it), lastActive }
   */
  function streak(active, todayYmd, rest) {
    const rn = parseFloat(rest);
    const r = isFinite(rn) ? Math.max(0, Math.floor(rn)) : REST_DAYS; // junk or missing = the default
    const set = active instanceof Set ? active : new Set(active || []);
    const today = dayNum(todayYmd);
    const has = (n) => set.has(ymdOf(n));
    const activeToday = has(today);

    // walk back from today; today being empty so far is not a miss
    let current = 0, gap = 0, n = today;
    if (!activeToday) n = today - 1; // today is still open, so it is never a missed day; yesterday and earlier decide
    for (let guard = 0; guard < 4000; guard++, n--) {
      if (has(n)) { current++; gap = 0; }
      else { gap++; if (gap > r) break; }
    }

    // best streak over all history
    const days = Array.from(set).map(dayNum).sort((a, b) => a - b);
    let best = 0, run = 0, prev = null;
    for (const d of days) {
      if (prev === null || d - prev - 1 <= r) run++; else run = 1;
      best = Math.max(best, run); prev = d;
    }
    best = Math.max(best, current);
    const lastActive = days.length ? ymdOf(days[days.length - 1]) : null;
    const atRisk = current > 0 && !activeToday && !has(today - 1);
    return { current, best, activeToday, atRisk, lastActive };
  }

  const api = { WORKOUT_XP, SET_XP, SET_CAP, PR_XP, FLOOR_XP, ALL_FLOORS_XP, REST_DAYS, xpForLevel, levelFor, highWater, xpTotals, activeDays, streak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDXp = api;
})(typeof window !== 'undefined' ? window : null);
