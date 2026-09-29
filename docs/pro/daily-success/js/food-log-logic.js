/**
 * food-log-logic.js — tracker revamp Phase 2 (food), the pure half.
 *
 * Jo never picked a food-logging style, so this is the plan's default:
 * typed macros (the day page's four meal rows, data['diet-m{i}-name|p|c|f|cal'],
 * which already sync with the page) plus saved favorites, "same as
 * yesterday", and progress against a protein / calorie target.
 *
 * Nothing here overwrites a meal Jo already typed: adding a favorite sums
 * into the meal row, and "same as yesterday" fills empty rows only.
 *
 * window.NBDFoodLog + module.exports (tests).
 */
(function (root) {
  'use strict';

  const MEALS = 4;
  const FIELDS = ['p', 'c', 'f', 'cal'];
  const MAX_FAVS = 40;
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
  const r1 = (n) => Math.round(n * 10) / 10;
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80);

  /** Which meal row a quick-add lands in by default, from the hour. */
  function mealForHour(h) {
    if (h < 10) return 0;      // Breakfast
    if (h < 15) return 1;      // Lunch
    if (h < 20) return 2;      // Dinner
    return 3;                  // Snacks
  }

  function mealOf(data, i) {
    const d = data || {};
    const m = { name: clean(d['diet-m' + i + '-name']) };
    FIELDS.forEach((f) => { m[f] = d['diet-m' + i + '-' + f]; });
    return m;
  }
  function mealIsEmpty(m) { return !m.name && FIELDS.every((f) => String(m[f] == null ? '' : m[f]).trim() === ''); }

  /**
   * A favorite added into a meal row → the new row values (strings, as the
   * inputs hold them). Names join with " + " (not repeated); numbers sum.
   */
  function addToMeal(meal, fav) {
    const m = meal || {}, f = normalizeFav(fav);
    if (!f) return null;
    // A favorite's own name may contain " + " ("Eggs + toast"), so match it as
    // a whole run of segments, not one split piece.
    const has = m.name && (' + ' + m.name + ' + ').indexOf(' + ' + f.name + ' + ') >= 0;
    const out = { name: has ? m.name : (m.name ? m.name + ' + ' + f.name : f.name).slice(0, 120) };
    FIELDS.forEach((k) => {
      const had = String(m[k] == null ? '' : m[k]).trim() !== '';
      const v = (had ? num(m[k]) : 0) + (f[k] || 0);
      out[k] = (had || f[k]) ? String(r1(v)) : '';
    });
    return out;
  }

  function totals(data) {
    const t = { p: 0, c: 0, f: 0, cal: 0, any: false };
    for (let i = 0; i < MEALS; i++) {
      const m = mealOf(data, i);
      FIELDS.forEach((k) => { if (String(m[k] == null ? '' : m[k]).trim() !== '') { t[k] += num(m[k]); t.any = true; } });
    }
    FIELDS.forEach((k) => { t[k] = r1(t[k]); });
    return t;
  }

  /** Yesterday's meals → { i: rowValues } for the rows that are EMPTY today. */
  function copyDay(prevData, curData) {
    const out = {};
    for (let i = 0; i < MEALS; i++) {
      const prev = mealOf(prevData, i), cur = mealOf(curData, i);
      if (mealIsEmpty(prev) || !mealIsEmpty(cur)) continue;
      const row = { name: prev.name };
      FIELDS.forEach((k) => { row[k] = String(prev[k] == null ? '' : prev[k]).trim(); });
      out[i] = row;
    }
    return out;
  }

  /** The page before this one by date (the latest dk strictly earlier). */
  function previousDay(pages, dk) {
    let best = null;
    for (const p of pages || []) {
      if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.dk || '') || p.dk >= dk) continue;
      if (!best || p.dk > best.dk) best = p;
    }
    return best;
  }

  function normalizeFav(f) {
    if (!f) return null;
    const name = clean(f.name);
    if (!name) return null;
    const o = { name };
    let any = false;
    FIELDS.forEach((k) => { const v = num(f[k]); o[k] = v > 0 ? r1(v) : 0; if (v > 0) any = true; });
    return any ? o : null;          // a favorite with no numbers adds nothing
  }
  /** Save (or refresh) a favorite; same name (any case) replaces; newest first. */
  function upsertFav(list, fav) {
    const f = normalizeFav(fav);
    if (!f) return (list || []).slice();
    const rest = (list || []).filter((x) => x && String(x.name).toLowerCase() !== f.name.toLowerCase());
    return [f].concat(rest).slice(0, MAX_FAVS);
  }
  function removeFav(list, name) {
    const n = String(name || '').toLowerCase();
    return (list || []).filter((x) => x && String(x.name).toLowerCase() !== n);
  }

  /**
   * Targets. Protein defaults to 1 g per lb of body weight (the 7-day average
   * when there is one) — the common strength-training rule; Jo can set a
   * number instead. Calories only when Jo sets one (no guessing a deficit).
   */
  function targetsFor(weightLbs, cfg) {
    const c = cfg || {};
    const setP = num(c.protein), setCal = num(c.calories);
    const w = num(weightLbs);
    return {
      protein: setP > 0 ? Math.round(setP) : (w >= 60 && w <= 700 ? Math.round(w) : null),
      proteinFrom: setP > 0 ? 'set' : (w >= 60 && w <= 700 ? 'weight' : null),
      calories: setCal > 0 ? Math.round(setCal) : null,
    };
  }
  /** 0–1 fraction plus the amount left (never negative). */
  function progress(have, target) {
    if (!(target > 0)) return null;
    return { pct: Math.max(0, Math.min(1, have / target)), left: Math.max(0, r1(target - have)), over: have > target };
  }

  const api = { MEALS, FIELDS, MAX_FAVS, mealForHour, mealOf, mealIsEmpty, addToMeal, totals, copyDay, previousDay, normalizeFav, upsertFav, removeFav, targetsFor, progress };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDFoodLog = api;
})(typeof window !== 'undefined' ? window : null);
