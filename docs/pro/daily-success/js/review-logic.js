/**
 * review-logic.js — Jo's operating system, Build 1 (2026-10-02): the rules
 * behind "don't miss twice" streaks and the Sunday review. Pure; the screen
 * is review-ui.js. window.NBDReview + module.exports (tests).
 *
 * Streak rule (Jo's pick): one missed day shows a warning and the streak
 * survives; two missed days IN A ROW end it. Today never counts as a miss —
 * it is still in progress (the old streak read "broken" every morning). A
 * day with no page at all is a miss: not opening the tracker is not a way
 * around a promise.
 */
(function () {
  'use strict';
  const DAY = 86400000;
  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const dkMs = (dk) => { const [y, m, d] = String(dk).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const msDk = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const addDays = (dk, n) => msDk(dkMs(dk) + n * DAY + 12 * 3600000); // noon anchor: DST-safe

  /** Which floor ids were met on each day (pages of the same day merge). */
  function metByDay(pages, floors) {
    const ids = (floors || []).map((f) => f.id);
    const out = new Map();
    for (const p of pages || []) {
      if (!p || !isDk(p.dk)) continue;
      const set = out.get(p.dk) || new Set();
      const d = p.data || {};
      ids.forEach((id) => { if (d['floormet-' + id] === '1') set.add(id); });
      out.set(p.dk, set);
    }
    return out;
  }

  /** 'met' when every floor was met that day, else 'miss' (no floors → null). */
  function dayStatus(byDay, floors, dk) {
    if (!floors || !floors.length) return null;
    const set = byDay.get(dk);
    return set && floors.every((f) => set.has(f.id)) ? 'met' : 'miss';
  }

  /**
   * { count, warned, broken, todayMet }
   *   count   — fully-met days in the live run (single misses don't add, don't end it)
   *   warned  — the last finished day (yesterday) was a miss: "don't miss twice" today
   *   broken  — the run ended on two misses in a row and nothing is met since
   */
  function floorStreak(pages, floors, todayDk) {
    const res = { count: 0, warned: false, broken: false, todayMet: false };
    if (!floors || !floors.length || !isDk(todayDk)) return res;
    const byDay = metByDay(pages, floors);
    const dks = [...byDay.keys()].sort();
    if (!dks.length) return res;
    const first = dks[0];
    if (dayStatus(byDay, floors, todayDk) === 'met') { res.count++; res.todayMet = true; }
    let run = 0;
    for (let dk = addDays(todayDk, -1); dk >= first; dk = addDays(dk, -1)) {
      if (dayStatus(byDay, floors, dk) === 'met') { res.count++; run = 0; continue; }
      if (dk === addDays(todayDk, -1)) res.warned = true;
      run++;
      if (run >= 2) { res.broken = res.count === 0; res.warned = res.warned && res.count > 0; break; }
    }
    return res;
  }

  /** The 7 finished days before today: [from, to] inclusive. */
  function weekWindow(todayDk) { return { from: addDays(todayDk, -7), to: addDays(todayDk, -1) }; }

  /**
   * The week's floors: hits per floor out of 7, misses, miss tax, full days.
   * A day with no page counts every floor as missed.
   */
  function weekFloors(pages, floors, todayDk, missTaxCents) {
    const tax = Number.isFinite(missTaxCents) ? missTaxCents : 500;
    const { from, to } = weekWindow(todayDk);
    const byDay = metByDay(pages, floors);
    const days = [];
    for (let dk = from; dk <= to; dk = addDays(dk, 1)) days.push(dk);
    const rows = (floors || []).map((f) => ({ id: f.id, label: f.label, hit: days.filter((dk) => (byDay.get(dk) || new Set()).has(f.id)).length, of: days.length }));
    const possible = rows.length * days.length;
    const hit = rows.reduce((s, r) => s + r.hit, 0);
    const misses = possible - hit;
    return {
      from, to, rows, hit, possible, misses,
      pct: possible ? Math.round(hit / possible * 100) : null,
      fullDays: days.filter((dk) => dayStatus(byDay, floors, dk) === 'met').length,
      missTaxCents: misses * tax,
    };
  }

  /**
   * Sunday weigh-in rule (Jo's plan): the 7-day average must be down at
   * least 0.5 lb on the week before; otherwise cut 200 calories. Never
   * invents a calorie target — with none set it says to set one.
   */
  function weightRule(trend, calorieTarget) {
    const t = trend || {};
    if (t.change7 == null) return { verdict: 'no-data', text: 'Not enough weigh-ins yet — weigh in most days this week and the rule kicks in next Sunday.' };
    if (t.change7 <= -0.5) return { verdict: 'on-track', change: t.change7, text: 'Down ' + Math.abs(t.change7).toFixed(1) + ' lb on the week. Keep the plan.' };
    const cal = Number(calorieTarget);
    return {
      verdict: 'adjust', change: t.change7,
      newCalories: cal > 0 ? Math.round(cal - 200) : null,
      text: (t.change7 > 0 ? 'Up ' + t.change7.toFixed(1) : 'Down only ' + Math.abs(t.change7).toFixed(1)) + ' lb on the week (target: down 0.5). ' +
        (cal > 0 ? 'Cut 200 calories: ' + Math.round(cal) + ' → ' + Math.round(cal - 200) + '.' : 'Set a daily calorie target on the Food card, then cut 200 from it.'),
    };
  }

  /** Distance to the goal weight from the 7-day average (null when unknown). */
  function goalProgress(trend, startLbs, goalLbs) {
    const now = trend && (trend.avg7 != null ? trend.avg7 : trend.latest);
    if (!(now > 0) || !(goalLbs > 0)) return null;
    const start = startLbs > now ? startLbs : now;
    const span = start - goalLbs;
    return { now, goal: goalLbs, left: Math.max(0, Math.round((now - goalLbs) * 10) / 10), pct: span > 0 ? Math.max(0, Math.min(1, (start - now) / span)) : (now <= goalLbs ? 1 : 0) };
  }

  /** The plain-text scorecard (copy now; the Coach bot reads it in Build 3). */
  function scorecardText(r) {
    const lines = ['WEEKLY SCORECARD ' + r.from + ' → ' + r.to];
    if (r.floors) {
      lines.push('Floors: ' + r.floors.hit + '/' + r.floors.possible + (r.floors.pct != null ? ' (' + r.floors.pct + '%)' : '') + ' · full days ' + r.floors.fullDays + '/7');
      r.floors.rows.forEach((x) => lines.push('  ' + x.label + ': ' + x.hit + '/' + x.of));
      lines.push('Miss tax: $' + (r.floors.missTaxCents / 100).toFixed(0) + (r.taxMoved ? ' — moved to savings' : ' — NOT moved yet'));
    }
    if (r.streak) lines.push('Streak: ' + r.streak.count + (r.streak.warned ? ' (missed yesterday)' : ''));
    if (r.weight) lines.push('Weight: ' + r.weight.text);
    if (r.goal) lines.push('Goal: ' + r.goal.now + ' → ' + r.goal.goal + ' lb (' + r.goal.left + ' to go)');
    if (r.lastScary) lines.push('Last week\'s hard thing: "' + r.lastScary.text + '" — ' + (r.lastScary.done === true ? 'DONE' : r.lastScary.done === false ? 'NOT DONE' : 'not marked'));
    if (r.kept) lines.push('Kept: ' + r.kept);
    if (r.bailed) lines.push('Bailed: ' + r.bailed);
    if (r.scary) lines.push('This week\'s hard thing: "' + r.scary + '"' + (r.scaryDue ? ' by ' + r.scaryDue : ''));
    return lines.join('\n');
  }

  /** Is today the review day (Sunday), and was this week's review saved? */
  function reviewDue(todayDk, reviews) {
    const sunday = new Date(dkMs(todayDk)).getDay() === 0;
    const done = !!(reviews && reviews[todayDk]);
    return { sunday, done, due: sunday && !done };
  }
  /** The most recent saved review before today (for "last week's hard thing"). */
  function lastReview(reviews, todayDk) {
    const keys = Object.keys(reviews || {}).filter((k) => isDk(k) && k < todayDk).sort();
    return keys.length ? Object.assign({ dk: keys[keys.length - 1] }, reviews[keys[keys.length - 1]]) : null;
  }

  const api = { addDays, metByDay, dayStatus, floorStreak, weekWindow, weekFloors, weightRule, goalProgress, scorecardText, reviewDue, lastReview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NBDReview = api;
})();
