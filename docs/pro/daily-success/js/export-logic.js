/**
 * export-logic.js — "Download my data" (tracker idea #8), the pure half.
 *
 * Turns the tracker's own localStorage stores into one JSON file with
 * everything plus CSVs that open cleanly in Excel / Numbers. No DOM, no
 * network: export-ui.js reads the stores and hands the raw strings to
 * buildFiles(); the tests drive this file directly.
 *
 *   JSON  day pages, coach sessions, coach settings, food favorites + targets,
 *         user config (floors), goal targets, weekly reviews, money plan,
 *         streak, weight readings.
 *   CSV   sessions (one row per set), weight (date, lbs), food (one row per
 *         logged meal).
 *
 * Deleted pages never leave: a page with `deleted` set, or whose id is in the
 * device's tombstone list (nbd_dsp_tomb), is dropped.
 *
 * CSV rules: UTF-8 with a BOM (Excel reads accents), CRLF rows, quote any cell
 * holding a comma / quote / newline, and defuse spreadsheet formulas — a text
 * cell starting with = + - @ (or tab / CR) gets a leading single quote.
 *
 * window.NBDExport + module.exports (tests).
 */
(function (root) {
  'use strict';

  const BOM = '﻿';
  const MEAL_NAMES = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const MEALS = MEAL_NAMES.length;
  const MACROS = ['p', 'c', 'f', 'cal'];
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** Raw localStorage keys this export reads (and nothing else). */
  const KEYS = {
    pages: 'nbd_dsp_v1',
    tomb: 'nbd_dsp_tomb',
    config: 'nbd_user_config',
    goals: 'nbd_gt',
    coach: 'nbd_ds_coach',
    sessions: 'nbd_ds_workouts',
    food: 'nbd_ds_food',
    reviews: 'nbd_ds_reviews',
    money: 'nbd_ds_money',
    streak: 'nbd_streak',
  };

  const parse = (raw, fallback) => {
    if (raw == null || raw === '') return fallback;
    try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch (_) { return fallback; }
  };
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };

  // ── CSV ────────────────────────────────────────────────────────────────
  /** One cell. Numbers pass through untouched (a real -5 is not a formula). */
  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** header + rows → CSV text, BOM first, CRLF between rows. */
  function toCsv(header, rows) {
    const lines = [header].concat(rows).map((r) => r.map(csvCell).join(','));
    return BOM + lines.join('\r\n') + '\r\n';
  }

  // ── source data ────────────────────────────────────────────────────────
  /** Pages minus anything deleted or tombstoned on this device. */
  function livePages(rawPages, rawTomb) {
    const tomb = new Set(asArray(parse(rawTomb, [])).map(String));
    return asArray(parse(rawPages, [])).filter((p) => isObj(p) && !p.deleted && !tomb.has(String(p.id)));
  }
  const dayOf = (p) => (DAY_RE.test(p.dk || '') ? p.dk : '');
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  /** [{date, lbs}] every weigh-in typed on a day page (raw: no range filter). */
  function weightReadings(pages) {
    const out = [];
    for (const p of pages) {
      const lbs = num(p.data && p.data['bm-wt']);
      if (lbs == null || lbs <= 0 || !dayOf(p)) continue;
      out.push({ date: p.dk, lbs: Math.round(lbs * 10) / 10 });
    }
    return out.sort(byDate);
  }

  /** [{date, meal, name, p, c, f, cal}] one per meal row that holds anything. */
  function foodRows(pages) {
    const out = [];
    for (const pg of pages) {
      const d = pg.data || {};
      if (!dayOf(pg)) continue;
      for (let i = 0; i < MEALS; i++) {
        const name = String(d['diet-m' + i + '-name'] == null ? '' : d['diet-m' + i + '-name']).trim();
        const m = { date: pg.dk, meal: MEAL_NAMES[i], name };
        let any = !!name;
        MACROS.forEach((k) => {
          const raw = d['diet-m' + i + '-' + k];
          const t = String(raw == null ? '' : raw).trim();
          if (t) any = true;
          m[k] = t === '' ? '' : (num(t) != null && /^[0-9.\-\s]+(g|kcal|cal)?$/i.test(t) ? num(t) : t);
        });
        if (any) out.push(m);
      }
    }
    return out.sort(byDate);
  }

  /** [{date, split, exercise, set, reps, weight, rpe, done, warm, session}] */
  function setRows(sessions) {
    const out = [];
    for (const s of asArray(sessions)) {
      if (!isObj(s)) continue;
      for (const ex of asArray(s.exercises)) {
        if (!isObj(ex)) continue;
        asArray(ex.sets).forEach((st, i) => {
          if (!isObj(st)) return;
          const n = (v) => { const t = String(v == null ? '' : v).trim(); return t === '' ? '' : (num(t) != null ? num(t) : t); };
          out.push({
            date: s.date || '', split: s.split || '', exercise: ex.name || ex.exId || '', set: i + 1,
            reps: n(st.reps), weight: n(st.weight), rpe: n(st.rpe),
            done: st.done === false ? 'no' : 'yes',
            warm: st.warm || st.isWarmup || st.warmup ? 'yes' : '',
            session: s.id == null ? '' : s.id,
          });
        });
      }
    }
    return out.sort(byDate);
  }

  // ── the JSON ───────────────────────────────────────────────────────────
  /**
   * @param {object} raw  { [storage key]: raw string|null } — keys per KEYS.
   * @param {Date|number|string} now
   */
  function buildExport(raw, now) {
    raw = raw || {};
    const when = new Date(now == null ? Date.now() : now);
    const pages = livePages(raw[KEYS.pages], raw[KEYS.tomb]);
    const sessions = asArray(parse(raw[KEYS.sessions], []));
    return {
      app: 'No Big Deal Daily Success',
      format: 1,
      exportedAt: isNaN(when.getTime()) ? '' : when.toISOString(),
      counts: { pages: pages.length, sessions: sessions.length },
      pages,
      sessions,
      coachSettings: parse(raw[KEYS.coach], {}),
      food: parse(raw[KEYS.food], {}),
      userConfig: parse(raw[KEYS.config], null),
      goalTargets: parse(raw[KEYS.goals], {}),
      reviews: parse(raw[KEYS.reviews], {}),
      money: parse(raw[KEYS.money], {}),
      streak: num(raw[KEYS.streak]) || 0,
      weight: weightReadings(pages),
    };
  }

  const ymd = (now) => {
    const d = new Date(now == null ? Date.now() : now);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  /**
   * The downloadable files, each { id, name, mime, text, label, count }.
   * Empty stores still give valid files (a header-only CSV, an empty JSON).
   */
  function buildFiles(raw, now) {
    const data = buildExport(raw, now);
    const day = ymd(now);
    const sets = setRows(data.sessions);
    const food = foodRows(data.pages);
    const weight = data.weight;
    return [
      { id: 'json', name: 'daily-success-everything-' + day + '.json', mime: 'application/json', label: 'Everything (JSON)',
        count: data.pages.length + ' day pages · ' + data.sessions.length + ' workouts', text: JSON.stringify(data, null, 2) },
      { id: 'sessions', name: 'daily-success-workouts-' + day + '.csv', mime: 'text/csv;charset=utf-8', label: 'Workouts (CSV)',
        count: sets.length + ' sets',
        text: toCsv(['date', 'split', 'exercise', 'set', 'reps', 'weight', 'rpe', 'done', 'warmup', 'session_id'],
          sets.map((r) => [r.date, r.split, r.exercise, r.set, r.reps, r.weight, r.rpe, r.done, r.warm, r.session])) },
      { id: 'weight', name: 'daily-success-weight-' + day + '.csv', mime: 'text/csv;charset=utf-8', label: 'Weight (CSV)',
        count: weight.length + ' weigh-ins', text: toCsv(['date', 'lbs'], weight.map((r) => [r.date, r.lbs])) },
      { id: 'food', name: 'daily-success-food-' + day + '.csv', mime: 'text/csv;charset=utf-8', label: 'Food (CSV)',
        count: food.length + ' meals',
        text: toCsv(['date', 'meal', 'name', 'protein_g', 'carbs_g', 'fat_g', 'calories'], food.map((r) => [r.date, r.meal, r.name, r.p, r.c, r.f, r.cal])) },
    ];
  }

  const api = { KEYS, BOM, csvCell, toCsv, livePages, weightReadings, foodRows, setRows, buildExport, buildFiles, ymd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NBDExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
