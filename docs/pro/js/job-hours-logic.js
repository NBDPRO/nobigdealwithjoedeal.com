/**
 * job-hours-logic.js — a job's man-hours from the company's own BOOK TIME per job
 * type (flag `laborHoursBook`, 2026-11-20). The mechanic's-book half of the lane:
 * "a roof replacement takes X man-hours per square", "a repair takes Y per job".
 * No DOM, no Firestore, no clock, so it is unit tested.
 *
 *   jobTypeOf(estimate)          -> { type, reason }       'replacement' | 'repair' | null
 *   forEstimate({ estimate, book, rules, crewSize })
 *                                -> { ok:true, jobType, label, unit, quantity, key, result, noBookTime }
 *                                 | { ok:false, reason }
 *
 * The roof estimates the company writes (the per-square builder and the wizard) carry
 * NO labor lines: they price per SQ and keep measurements plus `workKind`. So the
 * quantity comes from the estimate (`sq` for a replacement, one job for a repair) and
 * the hours per unit from the book under a reserved key, then labor-hours-logic does the
 * factors and the crew-day math (the same rules, one definition).
 *
 * Rules of this file:
 *  - NOTHING is invented. No book time for the job type = `noBookTime`, zero hours, and a
 *    result that says it is incomplete. A real 0 book time counts as set. An estimate that
 *    does not say repair or replacement, or has no squares, gets a reason, not a guess.
 *  - Factors come only from the company's own `rules`; none set = none applied.
 *  - Internal only: nothing here builds customer-facing text. Crews are independent
 *    subcontractors.
 *
 * Exposed as window.NBDJobHoursLogic and module.exports.
 */
(function (root) {
  'use strict';

  // The book keys live beside the labor actions in catalogCosts/{id}.laborOps under a reserved prefix.
  var TYPES = {
    replacement: { key: 'BOOK:replacement', label: 'Roof replacement', unit: 'SQ' },
    repair: { key: 'BOOK:repair', label: 'Repair', unit: 'job' }
  };

  function LH() { return (root && root.NBDLaborHoursLogic) || (typeof require === 'function' ? require('./labor-hours-logic.js') : null); }
  function num(v) { if (v === '' || v == null || typeof v === 'boolean') return NaN; var n = Number(v); return isFinite(n) ? n : NaN; }

  function jobTypeOf(estimate) {
    if (!estimate || typeof estimate !== 'object') return { type: null, reason: 'This job has no estimate yet.' };
    var k = estimate.workKind;
    if (k === 'replacement' || k === 'repair') return { type: k, reason: '' };
    return { type: null, reason: 'The estimate does not say whether this is a repair or a replacement.' };
  }

  function measurementsOf(e) {
    return {
      pitch: e.pl != null ? e.pl : e.pitch,
      tearOffLayers: e.tearOffLayers,
      stories: e.stories,
      cutUpRoof: e.cutUpRoof != null ? e.cutUpRoof : e.cutUp,
      accessLevel: e.accessLevel
    };
  }

  function forEstimate(opts) {
    var o = opts || {};
    var t = jobTypeOf(o.estimate);
    if (!t.type) return { ok: false, reason: t.reason };
    var def = TYPES[t.type], e = o.estimate, quantity = 1;
    if (t.type === 'replacement') {
      quantity = num(e.sq);
      if (!(quantity > 0)) return { ok: false, reason: 'The estimate has no squares, so there is nothing to multiply the book time by.' };
    }
    var result = LH().estimate({
      lines: [{ laborId: def.key, quantity: quantity }],
      book: o.book, measurements: measurementsOf(e), rules: o.rules, crewSize: o.crewSize
    });
    return {
      ok: true, jobType: t.type, label: def.label, unit: def.unit, quantity: quantity, key: def.key,
      result: result, noBookTime: result.missing.length > 0
    };
  }

  var API = { TYPES: TYPES, jobTypeOf: jobTypeOf, forEstimate: forEstimate };
  if (root && typeof root === 'object') root.NBDJobHoursLogic = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
