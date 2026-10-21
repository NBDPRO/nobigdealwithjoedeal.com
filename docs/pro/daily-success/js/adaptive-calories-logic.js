/**
 * adaptive-calories-logic.js — "what is my real maintenance?" (tracker idea
 * #7, documentation/projects/TRACKER-IDEAS-RESEARCH-2026-10-20.md), the pure
 * half. No DOM, no storage.
 *
 *   maintenance = average daily calories eaten
 *                 − (weight change per day × 3,500 kcal per lb)
 *
 * Eat 2,000 and lose a pound a week (−500/day) and your maintenance is about
 * 2,500. Eat 3,000 and gain a pound a week and it is about 2,500 too.
 *
 * House rule: NEVER invent a number. When the data is thin the answer is
 * { ok: false, ... } naming the missing input, never a guess.
 *
 *   Window    21 days ending YESTERDAY (today's food is usually unfinished).
 *   Intake    only days with logged calories between 800 and 8,000. A blank
 *             or zero day was not logged; under 800 is a partial day (only
 *             some meals typed) and would drag the average down; over 8,000
 *             is a typo. Those days are left out and counted, not averaged.
 *   Weight    smoothed so one salty day cannot swing it: the average of the
 *             weigh-ins in the first 7 days of the window versus the average
 *             of the weigh-ins in the last 7 days, over the real number of
 *             days between those two averages.
 *   Needs     ≥ 14 usable food days, ≥ 2 weigh-ins in each end week, and
 *             weigh-ins spanning ≥ 14 days. Otherwise: not enough data.
 *
 * Weights come in as [{dk, lbs}] (NBDTrackerHistory.weightSeries today; an
 * imported scale history plugs into the same shape). Intake comes in as
 * [{dk, cal}] (intakeSeries()). Local-date math only.
 *
 * window.NBDAdaptiveCalories + module.exports (tests).
 */
(function (root) {
  'use strict';

  const KCAL_PER_LB = 3500;
  const WINDOW_DAYS = 21;
  const END_WEEK = 7;
  const MIN_FOOD_DAYS = 14;
  const MIN_WEIGHINGS_PER_END = 2;
  const MIN_WEIGHT_SPAN = 14;
  const MIN_PLAUSIBLE_DAY = 800;
  const MAX_PLAUSIBLE_DAY = 8000;
  const MIN_PLAUSIBLE_MAINT = 1000;
  const MAX_PLAUSIBLE_MAINT = 6000;
  const MIN_WEIGHT = 60, MAX_WEIGHT = 700;

  const DK_RE = /^\d{4}-\d{2}-\d{2}$/;
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const dkToDate = (dk) => { const p = String(dk).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const dateToDk = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const addDays = (dk, n) => { const d = dkToDate(dk); d.setDate(d.getDate() + n); return dateToDk(d); };
  /** Whole days from a to b (DST-safe: rounds the millisecond gap). */
  const diffDays = (a, b) => Math.round((dkToDate(b).getTime() - dkToDate(a).getTime()) / 86400000);
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : NaN; };
  const r1 = (n) => Math.round(n * 10) / 10;

  /**
   * [{dk, cal}] one per day (the last page of a day wins), calories > 0 only.
   * `totals` is NBDFoodLog.totals (passed in so this file stays standalone).
   */
  function intakeSeries(pages, totals) {
    const byDay = new Map();
    for (const p of pages || []) {
      if (!p || !DK_RE.test(p.dk || '')) continue;
      const t = totals(p.data || {});
      const cal = t && isFinite(t.cal) ? t.cal : 0;
      if (cal > 0) byDay.set(p.dk, cal); else byDay.delete(p.dk);
    }
    return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => ({ dk: e[0], cal: e[1] }));
  }

  function notEnough(code, missing, message, extra) {
    return Object.assign({ ok: false, code, missing, message }, extra || {});
  }
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  /**
   * estimate(intake, weights, todayDk) →
   *   { ok:true, maintenance, avgIntake, foodDays, partialDays, ratePerWeek,
   *     windowStart, windowEnd, startAvg, endAvg, spanDays, recent }
   * or
   *   { ok:false, code, missing, message, foodDays, partialDays, ... }
   * recent = { days, avgIntake, lbPerWeek } for the last 7 days when ≥ 4 of
   * them were logged, else null (lbPerWeek is the pace that intake implies
   * against the estimated maintenance; + gaining, − losing).
   */
  function estimate(intake, weights, todayDk) {
    if (!DK_RE.test(todayDk || '')) return notEnough('no-date', 'date', 'Not enough data yet - no date to work from.');
    const end = addDays(todayDk, -1);
    const start = addDays(end, -(WINDOW_DAYS - 1));
    const inWin = (dk) => dk >= start && dk <= end;

    // intake: logged, full-looking days in the window
    const eaten = new Map();
    let blank = 0, partial = 0, typo = 0;
    const seen = new Set();
    for (const r of intake || []) {
      if (!r || !DK_RE.test(r.dk || '') || !inWin(r.dk)) continue;
      const cal = num(r.cal);
      if (!(cal > 0)) continue;                          // not logged
      seen.add(r.dk);
      if (cal < MIN_PLAUSIBLE_DAY) { partial++; continue; }
      if (cal > MAX_PLAUSIBLE_DAY) { typo++; continue; }
      eaten.set(r.dk, cal);
    }
    blank = WINDOW_DAYS - seen.size;
    const foodDays = eaten.size;
    const base = { foodDays, partialDays: partial, blankDays: blank, typoDays: typo, windowStart: start, windowEnd: end };

    // weight: sane scale readings in the window, one per day
    const wts = new Map();
    for (const w of weights || []) {
      if (!w || !DK_RE.test(w.dk || '') || !inWin(w.dk)) continue;
      const lbs = num(w.lbs);
      if (lbs >= MIN_WEIGHT && lbs <= MAX_WEIGHT) wts.set(w.dk, lbs);
    }
    const startEdge = addDays(start, END_WEEK - 1), endEdge = addDays(end, -(END_WEEK - 1));
    const first = [], last = [];
    for (const [dk, lbs] of wts) {
      if (dk <= startEdge) first.push({ dk, lbs });
      if (dk >= endEdge) last.push({ dk, lbs });
    }
    const dks = [...wts.keys()].sort();
    const spanDays = dks.length ? diffDays(dks[0], dks[dks.length - 1]) : 0;

    // what is missing, in plain words (food first, then weigh-ins)
    const needFood = Math.max(0, MIN_FOOD_DAYS - foodDays);
    const problems = [];
    if (needFood > 0) {
      const why = [];
      if (partial) why.push(plural(partial, 'day') + ' under ' + MIN_PLAUSIBLE_DAY + ' cal looked like only some meals');
      if (typo) why.push(plural(typo, 'day') + ' over ' + MAX_PLAUSIBLE_DAY + ' cal looked like a typo');
      problems.push({
        code: partial > foodDays && partial >= MIN_FOOD_DAYS / 2 ? 'partial-food' : 'food',
        need: needFood,
        text: 'need ' + plural(needFood, 'more day') + ' of food with calories typed (' + foodDays + ' of the last ' + WINDOW_DAYS + ' so far' + (why.length ? '; ' + why.join(', ') : '') + ')',
      });
    }
    const needFirst = Math.max(0, MIN_WEIGHINGS_PER_END - first.length);
    const needLast = Math.max(0, MIN_WEIGHINGS_PER_END - last.length);
    const needSpan = Math.max(0, MIN_WEIGHT_SPAN - spanDays);
    if (!dks.length) {
      problems.push({ code: 'weight', need: MIN_WEIGHINGS_PER_END * 2, text: 'no weigh-ins in the last ' + WINDOW_DAYS + ' days (put your weight in Body Metrics on a day page)' });
    } else {
      if (needFirst > 0) problems.push({ code: 'weight-start', need: needFirst, text: 'need ' + plural(needFirst, 'more weigh-in') + ' from ' + start + ' to ' + startEdge });
      if (needLast > 0) problems.push({ code: 'weight-end', need: needLast, text: 'need ' + plural(needLast, 'more weigh-in') + ' from ' + endEdge + ' to ' + end });
      if (!needFirst && !needLast && needSpan > 0) problems.push({ code: 'weight-span', need: needSpan, text: 'weigh-ins only span ' + plural(spanDays, 'day') + ' - need ' + MIN_WEIGHT_SPAN });
    }
    if (problems.length) {
      return notEnough(problems[0].code, problems.map((p) => p.code),
        'Not enough data yet - ' + problems.map((p) => p.text).join('; ') + '.', Object.assign({ spanDays }, base));
    }

    const avgOf = (a) => a.reduce((s, x) => s + x.lbs, 0) / a.length;
    const meanDay = (a) => a.reduce((s, x) => s + diffDays(start, x.dk), 0) / a.length;
    const startAvg = avgOf(first), endAvg = avgOf(last);
    const gap = meanDay(last) - meanDay(first);          // days between the two averages
    if (!(gap >= MIN_WEIGHT_SPAN / 2)) {
      return notEnough('weight-gap', ['weight-gap'], 'Not enough data yet - the early and late weigh-ins are too close together in time.', Object.assign({ spanDays }, base));
    }
    const perDay = (endAvg - startAvg) / gap;            // lb per day, + gaining
    const avgIntake = [...eaten.values()].reduce((s, c) => s + c, 0) / foodDays;
    const maint = avgIntake - perDay * KCAL_PER_LB;
    if (!isFinite(maint) || maint < MIN_PLAUSIBLE_MAINT || maint > MAX_PLAUSIBLE_MAINT) {
      return notEnough('implausible', ['implausible'],
        'Not enough data yet - the food and weight numbers do not line up into a believable maintenance (it would be ' +
        (isFinite(maint) ? Math.round(maint) + ' cal' : 'unknown') + '). Usually that means some meals were not typed in.', Object.assign({ spanDays }, base));
    }

    // the last 7 logged days against that maintenance
    const wkStart = addDays(end, -(END_WEEK - 1));
    const recentDays = [...eaten.entries()].filter((e) => e[0] >= wkStart);
    let recent = null;
    if (recentDays.length >= 4) {
      const rAvg = recentDays.reduce((s, e) => s + e[1], 0) / recentDays.length;
      recent = { days: recentDays.length, avgIntake: Math.round(rAvg), lbPerWeek: r1((rAvg - maint) * 7 / KCAL_PER_LB) };
    }

    return Object.assign({
      ok: true,
      maintenance: Math.round(maint / 10) * 10,
      avgIntake: Math.round(avgIntake),
      ratePerWeek: r1(perDay * 7),
      startAvg: r1(startAvg), endAvg: r1(endAvg), spanDays, recent,
    }, base);
  }

  /** "about 0.4 lb/week down" / "about even" for a signed lb-per-week number. */
  function paceWords(lbPerWeek) {
    if (lbPerWeek == null || !isFinite(lbPerWeek)) return '';
    const a = Math.abs(lbPerWeek);
    if (a < 0.1) return 'about even (no real change)';
    return 'about ' + a.toFixed(1) + ' lb/week ' + (lbPerWeek < 0 ? 'down' : 'up');
  }

  const api = {
    KCAL_PER_LB, WINDOW_DAYS, MIN_FOOD_DAYS, MIN_WEIGHINGS_PER_END, MIN_WEIGHT_SPAN, MIN_PLAUSIBLE_DAY, MAX_PLAUSIBLE_DAY,
    addDays, diffDays, intakeSeries, estimate, paceWords,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDAdaptiveCalories = api;
})(typeof window !== 'undefined' ? window : null);
