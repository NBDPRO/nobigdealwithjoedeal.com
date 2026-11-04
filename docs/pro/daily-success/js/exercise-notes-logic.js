/**
 * exercise-notes-logic.js — per-exercise notes for the Workout Coach
 * (Daily Success, 2026-10-23). A short note on a lift ("left shoulder off at
 * RPE 8") that comes back the next time that lift is on the screen.
 * Pure; the field and the "Last time" line live in workout-coach.js.
 * Stored in nbd_ds_coach_notes ({ exId: { 'YYYY-MM-DD': 'text' } }), synced to
 * userSettings.dsCoachNotes. No voice, no network at write time.
 * window.NBDExNotes + module.exports.
 */
(function () {
  'use strict';
  const MAX = 160;          // characters per note
  const PER_LIFT = 6;       // dated notes kept per lift
  const MAX_LIFTS = 200;    // lifts kept (oldest note first to go)
  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  /** Only well-formed entries survive a load (storage can be hand-edited or half-synced). */
  function normalize(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    Object.keys(raw).forEach((id) => {
      if (!/^[\w.:-]{1,64}$/.test(id) || !isObj(raw[id])) return;
      const days = {};
      Object.keys(raw[id]).forEach((dk) => { const t = isDk(dk) ? clean(raw[id][dk]) : ''; if (t) days[dk] = t; });
      if (Object.keys(days).length) out[id] = days;
    });
    return out;
  }

  function prune(map) {
    Object.keys(map).forEach((id) => {
      const dks = Object.keys(map[id]).sort();
      dks.slice(0, Math.max(0, dks.length - PER_LIFT)).forEach((k) => { delete map[id][k]; });
    });
    const ids = Object.keys(map);
    if (ids.length > MAX_LIFTS) {
      const newest = (id) => Object.keys(map[id]).sort().pop();
      ids.sort((a, b) => (newest(a) < newest(b) ? -1 : 1)).slice(0, ids.length - MAX_LIFTS).forEach((id) => { delete map[id]; });
    }
    return map;
  }

  /** New map with today's note for the lift set; empty text removes only that day's note. */
  function set(map, exId, dk, text) {
    const base = normalize(map);
    if (!/^[\w.:-]{1,64}$/.test(String(exId)) || !isDk(dk)) return base;
    const t = clean(text);
    const days = Object.assign({}, base[exId]);
    if (t) days[dk] = t; else delete days[dk];
    if (Object.keys(days).length) base[exId] = days; else delete base[exId];
    return prune(base);
  }

  /** What the lift said on a date. */
  const on = (map, exId, dk) => { const d = normalize(map)[exId]; return d && d[dk] ? d[dk] : ''; };

  /** The most recent note from a day before dk: { dk, text } or null. */
  function lastBefore(map, exId, dk) {
    const d = normalize(map)[exId];
    if (!d || !isDk(dk)) return null;
    const keys = Object.keys(d).filter((k) => k < dk).sort();
    return keys.length ? { dk: keys[keys.length - 1], text: d[keys[keys.length - 1]] } : null;
  }

  const api = { MAX, PER_LIFT, MAX_LIFTS, clean, normalize, set, on, lastBefore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NBDExNotes = api;
})();
