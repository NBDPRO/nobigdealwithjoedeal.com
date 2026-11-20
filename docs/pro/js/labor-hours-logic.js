/**
 * labor-hours-logic.js — the pure rules behind the labor-hours estimator
 * (flag `laborHoursBook`, 2026-11-19): a mechanic-style "flat-rate book" for roof
 * jobs. No DOM, no Firestore, no clock, so it is unit tested.
 *
 *   estimate({ lines, book, measurements, rules, crewSize })
 *     lines          the estimate's resolved lines: { laborId, quantity } (extra keys ignored)
 *     book           the company's OWN hours per unit by labor action: a function
 *                    (laborId) -> hours per unit | null, or a map { laborId: n | { hoursPerUnit: n } }.
 *                    It comes from the private tenant book (catalogCosts/{id}.laborOps), never
 *                    from a published file, and it starts EMPTY.
 *     measurements   { pitch, tearOffLayers, stories, cutUpRoof, accessLevel } (the estimate's own)
 *     rules          the company's own factor percents, all optional:
 *                    pitchFrom + pitchPct, layerPct (per extra layer), storyPct (per extra story),
 *                    cutUpPct, accessModeratePct, accessDifficultPct
 *     crewSize       the sub's usual crew size (default DEFAULT_CREW)
 *   -> { manHours, baseHours, multiplier, factors[], crewSize, crewDays, daysToBook,
 *        lines[], missing[], complete }
 *
 * Rules of this file:
 *  - NOTHING is invented. A labor action with no hours in the book is listed in
 *    `missing` and adds nothing; `complete` is false so the screen can say "N lines
 *    have no hours yet". A factor with no percent in `rules` does not apply.
 *  - A legit 0 hours-per-unit is a number the company entered: it counts as set.
 *  - Factors ADD (1 + sum of percents / 100), like a book a mechanic can read; they do
 *    not compound.
 *  - crewDays = manHours / (crewSize x HOURS_PER_DAY). daysToBook rounds UP to a whole
 *    day (minimum 1, capped at the schedule's longest project, MAX_DAYS); null when
 *    there are no hours to book.
 *  - Internal only: this file never builds customer-facing text and no output of it
 *    belongs on an estimate, the portal, or a sub's job sheet. Crews are independent
 *    subcontractors; nothing here says employee or payroll.
 *
 * Exposed as window.NBDLaborHoursLogic and module.exports.
 */
(function (root) {
  'use strict';

  var HOURS_PER_DAY = 8;
  var DEFAULT_CREW = 3;
  var MAX_DAYS = 14;        // schedule-window.js MAX_PROJECT_DAYS

  function num(v) { if (v === '' || v == null || typeof v === 'boolean') return NaN; var n = Number(v); return isFinite(n) ? n : NaN; }
  function pos(v) { var n = num(v); return n > 0 ? n : 0; }
  function round1(n) { return Math.round(n * 10) / 10; }

  // One reader for both book shapes. null = the book has no hours for this action.
  function hoursFrom(book, id) {
    var raw = typeof book === 'function' ? book(id) : (book && book[id]);
    if (raw && typeof raw === 'object') raw = raw.hoursPerUnit;
    var n = num(raw);
    return n >= 0 ? n : null;
  }

  /** The factors that apply to this job: [{ key, label, pct }], only those with a percent > 0. */
  function factorsFor(m, rules) {
    var r = rules || {}, o = m || {}, out = [];
    function add(key, label, pct) { if (pct > 0) out.push({ key: key, label: label, pct: pct }); }
    if (pos(r.pitchFrom) > 0 && pos(o.pitch) >= pos(r.pitchFrom)) add('pitch', 'Steep pitch', pos(r.pitchPct));
    var layers = Math.floor(pos(o.tearOffLayers)) - 1;
    if (layers > 0) add('layers', layers + ' extra layer' + (layers === 1 ? '' : 's'), layers * pos(r.layerPct));
    var stories = Math.floor(pos(o.stories)) - 1;
    if (stories > 0) add('stories', stories + ' extra stor' + (stories === 1 ? 'y' : 'ies'), stories * pos(r.storyPct));
    if (o.cutUpRoof === true || o.cutUpRoof === 'true') add('complexity', 'Cut-up roof', pos(r.cutUpPct));
    if (o.accessLevel === 'moderate') add('access', 'Moderate access', pos(r.accessModeratePct));
    else if (o.accessLevel === 'difficult') add('access', 'Difficult access', pos(r.accessDifficultPct));
    return out;
  }

  function estimate(opts) {
    var o = opts || {};
    var perLine = [], missingMap = {}, base = 0;
    (o.lines || []).forEach(function (l) {
      var id = l && l.laborId, q = num(l && l.quantity);
      if (!id || !(q > 0)) return;
      var hpu = hoursFrom(o.book, id);
      if (hpu == null) { missingMap[id] = (missingMap[id] || 0) + q; return; }
      var h = q * hpu;
      base += h;
      perLine.push({ laborId: id, quantity: q, hoursPerUnit: hpu, hours: h });
    });
    var factors = factorsFor(o.measurements, o.rules);
    var multiplier = 1 + factors.reduce(function (s, f) { return s + f.pct; }, 0) / 100;
    var hours = base * multiplier;
    var crew = pos(o.crewSize) || DEFAULT_CREW;
    var days = hours / (crew * HOURS_PER_DAY);
    var toBook = null;
    if (hours > 0) toBook = Math.min(MAX_DAYS, Math.max(1, Math.ceil(days - 1e-9)));
    var missing = Object.keys(missingMap).map(function (k) { return { laborId: k, quantity: missingMap[k] }; });
    return {
      manHours: round1(hours), baseHours: round1(base), multiplier: multiplier, factors: factors,
      crewSize: crew, crewDays: round1(days), daysToBook: toBook,
      lines: perLine, missing: missing, complete: missing.length === 0
    };
  }

  var API = { HOURS_PER_DAY: HOURS_PER_DAY, DEFAULT_CREW: DEFAULT_CREW, MAX_DAYS: MAX_DAYS, factorsFor: factorsFor, estimate: estimate };
  if (root && typeof root === 'object') root.NBDLaborHoursLogic = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
