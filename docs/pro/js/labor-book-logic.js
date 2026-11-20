/**
 * labor-book-logic.js — the pure rules behind the Labor hours book editor
 * (flag `laborHoursBook`, 2026-11-19). No DOM, no Firestore, no clock, so it is
 * unit tested.
 *
 *   parseHours(text)   one hours-per-unit field -> { ok, blank } | { ok, value } | { ok:false, message }
 *   parseCrew(text)    one crew-size field      -> same shape, a whole number
 *   rowsFor(list, op, query)   the labor actions to show, sorted, filtered
 *   plan(list, op, inputs)     which typed values are real changes: { writes[], errors[], blanksOverSet[] }
 *
 * Rules of this file:
 *  - NOTHING is invented. An action with no hours in the book shows an empty box and
 *    stays empty until the company types a number. This file has no default hours.
 *  - A real 0 is a number the company typed: it is a valid value, and it is a CHANGE
 *    when the book held something else or nothing.
 *  - A blank box means "leave it as it is". It never writes, and over a value the book
 *    already holds it is reported in blanksOverSet (clearing is not supported yet; the
 *    screen says so rather than silently keeping the number).
 *  - Hours are 0 to 1000 with up to 3 decimals; a crew is a whole number 1 to 20.
 *  - Internal only: nothing here builds customer-facing text.
 *
 * Exposed as window.NBDLaborBookLogic and module.exports.
 */
(function (root) {
  'use strict';

  var MAX_HOURS = 1000;
  var MAX_CREW = 20;
  var DEFAULT_CREW = 3;     // a sub with no crew size is planned as this (the estimator uses the same number)
  var HOURS_RE = /^(\d{1,4}(\.\d{1,3})?|\.\d{1,3})$/;
  var CREW_RE = /^\d{1,2}$/;

  function str(v) { return String(v == null ? '' : v).trim(); }

  function parseHours(text) {
    var s = str(text);
    if (s === '') return { ok: true, blank: true };
    if (!HOURS_RE.test(s)) return { ok: false, message: 'Enter hours as a number like 0.4 or 12 (up to 3 decimals).' };
    var n = Number(s);
    if (!(n >= 0 && n <= MAX_HOURS)) return { ok: false, message: 'Hours per unit must be between 0 and ' + MAX_HOURS + '.' };
    return { ok: true, value: n };
  }

  function parseCrew(text) {
    var s = str(text);
    if (s === '') return { ok: true, blank: true };
    if (!CREW_RE.test(s)) return { ok: false, message: 'A crew is a whole number from 1 to ' + MAX_CREW + '.' };
    var n = Number(s);
    if (n < 1 || n > MAX_CREW) return { ok: false, message: 'A crew is a whole number from 1 to ' + MAX_CREW + '.' };
    return { ok: true, value: n };
  }

  // The hours the book holds for an action: a finite number >= 0, else null (not set).
  function heldHours(op, id) {
    var e = typeof op === 'function' ? op(id) : null;
    var n = e && e.hoursPerUnit != null && e.hoursPerUnit !== '' ? Number(e.hoursPerUnit) : NaN;
    return isFinite(n) && n >= 0 ? n : null;
  }

  /**
   * list: [{ id, name, unit, category }]  op(id) -> { hoursPerUnit } | null
   * -> [{ id, name, unit, category, hours (number | null) }] sorted by category then name,
   * filtered by `query` over name, id, category and unit (case-insensitive, every word must match).
   */
  function rowsFor(list, op, query) {
    var words = str(query).toLowerCase().split(/\s+/).filter(Boolean);
    return (list || []).filter(function (a) { return a && a.id; }).map(function (a) {
      return { id: String(a.id), name: str(a.name) || String(a.id), unit: str(a.unit), category: str(a.category), hours: heldHours(op, a.id) };
    }).filter(function (r) {
      var hay = (r.name + ' ' + r.id + ' ' + r.category + ' ' + r.unit).toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    }).sort(function (a, b) { return (a.category.localeCompare(b.category)) || a.name.localeCompare(b.name); });
  }

  /**
   * inputs: { [id]: typed text }. Only ids present in `list` are read.
   * writes: [{ id, value }] for typed values that differ from what the book holds.
   * errors: [{ id, name, message }] for text that is not a valid number (nothing is written for those).
   * blanksOverSet: [id] for a blank box over a value the book already holds (left unchanged).
   */
  function plan(list, op, inputs) {
    var out = { writes: [], errors: [], blanksOverSet: [] };
    var typed = inputs || {};
    (list || []).forEach(function (a) {
      if (!a || !a.id || !Object.prototype.hasOwnProperty.call(typed, a.id)) return;
      var p = parseHours(typed[a.id]);
      var held = heldHours(op, a.id);
      if (!p.ok) { out.errors.push({ id: a.id, name: str(a.name) || String(a.id), message: p.message }); return; }
      if (p.blank) { if (held !== null) out.blanksOverSet.push(a.id); return; }
      if (held === null || p.value !== held) out.writes.push({ id: a.id, value: p.value });
    });
    return out;
  }

  var API = { MAX_HOURS: MAX_HOURS, MAX_CREW: MAX_CREW, DEFAULT_CREW: DEFAULT_CREW, parseHours: parseHours, parseCrew: parseCrew, rowsFor: rowsFor, plan: plan };
  if (root && typeof root === 'object') root.NBDLaborBookLogic = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
