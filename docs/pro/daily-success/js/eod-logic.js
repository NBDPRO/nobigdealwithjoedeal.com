/**
 * eod-logic.js — the 60-second end-of-day review (Daily Success, 2026-10-22).
 * Three quick questions, stored as one short note per date:
 *   body      how the body feels (1 rough · 2 okay · 3 strong)
 *   win       one business win or next action
 *   tomorrow  tomorrow's one non-negotiable
 * Pure; the card is eod-ui.js. Stored in nbd_ds_eod ({ 'YYYY-MM-DD': rec }),
 * synced to userSettings.dsEod. Skipping is a record too ("Not tonight") so
 * the prompt never comes back for that date. window.NBDEod + module.exports.
 */
(function () {
  'use strict';
  const MAX = 140;
  const KEEP_DAYS = 120;
  const PROMPT_HOUR = 17; // the inline prompt shows from 5 pm; before that it is a quiet link
  const BODY = { 1: 'Rough', 2: 'Okay', 3: 'Strong' };
  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX);
  const dkMs = (dk) => { const [y, m, d] = dk.split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };
  const msDk = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const addDays = (dk, n) => msDk(dkMs(dk) + n * 86400000);

  /** A saved answer set, or null when nothing was answered. */
  function normalize(rec) {
    const r = rec || {};
    const b = Math.round(Number(r.body));
    const out = { body: b >= 1 && b <= 3 ? b : 0, win: clean(r.win), tomorrow: clean(r.tomorrow) };
    return out.body || out.win || out.tomorrow ? out : null;
  }
  const isAnswered = (rec) => !!(rec && !rec.skipped && (rec.body || rec.win || rec.tomorrow));

  function prune(map) {
    const keys = Object.keys(map).sort();
    keys.slice(0, Math.max(0, keys.length - KEEP_DAYS)).forEach((k) => { delete map[k]; });
    return map;
  }
  /** New map with the day's answers saved (nothing answered → the day is left as it was). */
  function save(map, dk, rec, nowMs) {
    const n = normalize(rec);
    if (!isDk(dk) || !n) return Object.assign({}, map);
    return prune(Object.assign({}, map, { [dk]: Object.assign(n, { at: nowMs || 0 }) }));
  }
  /** "Not tonight": remembered so the prompt never returns for that date. Never overwrites real answers. */
  function skip(map, dk, nowMs) {
    if (!isDk(dk) || isAnswered(map && map[dk])) return Object.assign({}, map);
    return prune(Object.assign({}, map, { [dk]: { skipped: true, at: nowMs || 0 } }));
  }

  /**
   * What the day page shows for a date.
   *   saved  — answers exist
   *   prompt — today, 5 pm or later, never answered or skipped: the inline questions
   *   skipped — dismissed: a small "add it anyway" link only
   *   link   — everything else (earlier today, or a day with no note): a quiet link
   * Past days with no note never prompt: nothing nags about yesterday.
   */
  function state(map, dk, todayDk, hour) {
    const rec = map && map[dk];
    if (isAnswered(rec)) return 'saved';
    if (rec && rec.skipped) return 'skipped';
    return dk === todayDk && Number(hour) >= PROMPT_HOUR ? 'prompt' : 'link';
  }

  /** The 7 finished days before today, same window as the weekly review. */
  function weekSummary(map, todayDk) {
    const out = { days: 0, bodyAvg: null, wins: [], tomorrows: [] };
    if (!isDk(todayDk)) return out;
    let sum = 0, n = 0;
    for (let i = 7; i >= 1; i--) {
      const dk = addDays(todayDk, -i), rec = map && map[dk];
      if (!isAnswered(rec)) continue;
      out.days++;
      if (rec.body) { sum += rec.body; n++; }
      if (rec.win) out.wins.push({ dk, text: rec.win });
      if (rec.tomorrow) out.tomorrows.push({ dk, text: rec.tomorrow });
    }
    out.bodyAvg = n ? Math.round(sum / n * 10) / 10 : null;
    return out;
  }

  /** Lines for the plain-text scorecard ([] when no wrap-ups were written). */
  function scorecardLines(sum) {
    if (!sum || !sum.days) return [];
    const lines = ['Day wrap-ups: ' + sum.days + '/7' + (sum.bodyAvg != null ? ' · body avg ' + sum.bodyAvg + '/3' : '')];
    sum.wins.forEach((w) => lines.push('  Win ' + w.dk.slice(5) + ': ' + w.text));
    return lines;
  }

  const api = { MAX, KEEP_DAYS, PROMPT_HOUR, BODY, clean, normalize, isAnswered, save, skip, state, weekSummary, scorecardLines, addDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NBDEod = api;
})();
