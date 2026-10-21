/**
 * Daily Success day-page layout helpers (pure, no DOM): which sections start collapsed, and the numbers for the
 * sticky "Today" bar. Loaded before app.js; tests/daily-success-day-layout-2026-10-21.test.js pins it.
 *
 * Jo (2026-10-21): the day page on a phone is a stack of collapsible sections with a sticky summary on top; Food and
 * Fitness are open by default (the Floors score is its own card, always visible), the rest start collapsed.
 */
(function (root) {
  'use strict';

  /** Sections (data-sec on the .pc cards) that start OPEN on a phone. */
  const OPEN_BY_DEFAULT = ['diet', 'fitness'];

  /**
   * Should this section start collapsed? A choice Jo already made (saved true/false) always wins, including
   * "I opened Habits" and "I closed Food". With no saved choice: collapsed on a phone unless it is in OPEN_BY_DEFAULT;
   * on a larger screen everything starts open as before.
   */
  function sectionCollapsed(saved, sec, phone) {
    if (saved && typeof saved === 'object' && Object.prototype.hasOwnProperty.call(saved, sec)) return !!saved[sec];
    return !!phone && OPEN_BY_DEFAULT.indexOf(sec) < 0;
  }

  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : null; };
  const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));

  /** Did Jo finish a Workout Coach session on this day? (sessions = nbd_ds_workouts) */
  function workoutDone(sessions, dk) {
    return (Array.isArray(sessions) ? sessions : []).some((s) => s && !s.deleted && s.finishedAt && s.date === dk);
  }

  /**
   * The sticky bar's numbers. hit/total = floors met; cal/protein come straight from the day's macro summary
   * (strings like "1,240" or an em dash); workout is a boolean. -> { floors, floorsPct, cal, protein, workout, allMet }
   */
  function todaySummary(o) {
    o = o || {};
    const total = Math.max(0, Math.round(num(o.total) || 0));
    const hit = Math.min(total, Math.max(0, Math.round(num(o.hit) || 0)));
    return {
      floors: hit + '/' + total,
      floorsPct: total ? Math.round(hit / total * 100) : 0,
      allMet: total > 0 && hit === total,
      cal: fmt(num(o.cal)),
      protein: fmt(num(o.protein)),
      workout: !!o.workout,
    };
  }

  /**
   * Door-knocking / sales stats (Activity Totals, Revenue Pace, Doors / Revenue / Closes charts, monthly sales goals) are
   * hidden for someone who has never used them. pref is Jo's explicit switch ('1' on, '0' off) and always wins; with no
   * switch they appear on their own as soon as there is anything to show: a logged door, contact, appointment, close or
   * revenue, or a monthly goal. totals = { doors, contacts, appts, closes, revenue, goals:{d,r,c} }.
   */
  function salesVisible(pref, totals) {
    if (pref === '1' || pref === 1 || pref === true) return true;
    if (pref === '0' || pref === 0 || pref === false) return false;
    const t = totals || {}, g = t.goals || {};
    return [t.doors, t.contacts, t.appts, t.closes, t.revenue, g.d, g.r, g.c].some((v) => (num(v) || 0) > 0);
  }

  const api = { OPEN_BY_DEFAULT, sectionCollapsed, workoutDone, todaySummary, salesVisible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDDayLayout = api;
})(typeof window !== 'undefined' ? window : null);
