/**
 * margin-floor.js: the pure half of the estimate margin floor (2026-11-17;
 * plan: documentation/projects/ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md).
 * Exposes window.NBDMarginFloor.
 *
 * The rule a company may switch on:
 *   margin = (pre-tax price - material - labor) / pre-tax price
 *   - on the JOB total, after a minimum charge and after a discount
 *   - on cash jobs. An insurance scope is exempt
 *   - a job with an uncosted line has no margin to judge: it is "unknown" and
 *     never warns (a missing cost read as 0 would look like a perfect margin)
 *   - under the floor is a WARNING with the price that reaches the floor. It is
 *     never a block and never changes a price by itself
 *
 * The floor and the target belong to the company. There is no built-in value:
 * with nothing set the check is off and every band is plain. No company's
 * numbers live in this file.
 *
 * Nothing here reads or writes anything. Money is integer cents; the floor is
 * compared in whole numbers (tenths of a percent), never as a float ratio.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const MAX_PCT = 95;
  const isCents = (n) => typeof n === 'number' && Number.isSafeInteger(n);

  /** A percent a company may set: above 0, under 95, one decimal. Anything else is null. */
  function pctOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n >= MAX_PCT) return null;
    return Math.round(n * 10) / 10;
  }

  /** { on, floorPct, targetPct } from whatever the company stored. Off unless a floor is set. */
  function sanitizeSettings(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const floorPct = pctOrNull(r.floorPct);
    if (floorPct === null) return { on: false, floorPct: null, targetPct: null };
    const t = pctOrNull(r.targetPct);
    return { on: true, floorPct, targetPct: (t === null || t < floorPct) ? floorPct : t };
  }

  /** { known, pct, marginCents }. pct is null when there is no price or no known cost. */
  function marginOf(j) {
    const p = j && j.preTaxCents, c = j && j.costCents;
    if (!j || j.costKnown !== true || !isCents(p) || !isCents(c) || p <= 0 || c < 0) return { known: false, pct: null, marginCents: null };
    return { known: true, pct: ((p - c) / p) * 100, marginCents: p - c };
  }

  /**
   * The smallest pre-tax price, in cents, whose margin over `costCents` reaches
   * `floorPct`. With `stepCents` (the builder's rounding step) it is rounded UP
   * to that step, so the suggested price still clears the floor after rounding.
   */
  function priceForFloorCents(costCents, floorPct, stepCents) {
    const f = pctOrNull(floorPct);
    if (f === null || !isCents(costCents) || costCents <= 0) return null;
    const tenths = Math.round(f * 10);
    let p = Math.ceil((costCents * 1000) / (1000 - tenths));
    if (isCents(stepCents) && stepCents > 1) p = Math.ceil(p / stepCents) * stepCents;
    return Number.isSafeInteger(p) ? p : null;
  }

  /**
   * Judge one job. state:
   *   off      the company has no floor set
   *   exempt   an insurance scope
   *   unknown  no price, or a line with no cost
   *   ok       at or above the floor
   *   under    below it: neededPreTaxCents is the price that reaches the floor
   * `applies` is true only for ok and under.
   */
  function check(j) {
    j = j || {};
    const s = (j.settings && j.settings.on === true) ? j.settings : sanitizeSettings(j.settings);
    const out = { state: 'off', applies: false, marginPct: null, neededPreTaxCents: null, shortCents: null, floorPct: s.floorPct, targetPct: s.targetPct };
    if (!s.on) return out;
    if (j.mode === 'insurance') { out.state = 'exempt'; return out; }
    const m = marginOf(j);
    if (!m.known) { out.state = 'unknown'; return out; }
    out.applies = true;
    out.marginPct = m.pct;
    // (p - c) / p >= f  <=>  p * (1000 - f10) >= c * 1000, in whole numbers.
    const tenths = Math.round(s.floorPct * 10);
    if (j.preTaxCents * (1000 - tenths) >= j.costCents * 1000) { out.state = 'ok'; return out; }
    out.state = 'under';
    out.neededPreTaxCents = priceForFloorCents(j.costCents, s.floorPct, j.stepCents);
    out.shortCents = out.neededPreTaxCents === null ? null : out.neededPreTaxCents - j.preTaxCents;
    return out;
  }

  /** The colour band for a margin: target, between, under, unknown, or plain when no floor is set. */
  function band(pct, settings) {
    const s = (settings && settings.on === true) ? settings : sanitizeSettings(settings);
    if (!s.on) return 'plain';
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'unknown';
    const t = Math.round(pct * 1000);
    if (t >= Math.round(s.targetPct * 1000)) return 'target';
    if (t >= Math.round(s.floorPct * 1000)) return 'between';
    return 'under';
  }
  const BAND_TEXT = {
    target: 'At or above your target',
    between: 'Above your floor, under your target',
    under: 'Under your floor',
    unknown: 'Margin unknown: a line has no cost',
    plain: '',
  };
  // The shared badge classes (docs/pro/css: ui-badge). Plain has none.
  const BAND_CLASS = { target: 'is-success', between: 'is-warn', under: 'is-danger', unknown: 'is-info', plain: '' };

  /** May this role finalize or send an estimate that is under the floor? */
  function canFinalizeUnder(role) {
    return role === 'owner' || role === 'company_admin' || role === 'admin';
  }

  /** The private note kept on an estimate when someone confirms it under the floor. Never customer-facing. */
  function confirmNote(n) {
    n = n || {};
    if (typeof n.uid !== 'string' || !n.uid) return null;
    const pct = Number(n.marginPct);
    return {
      by: n.uid, role: String(n.role || ''),
      marginPct: Number.isFinite(pct) ? Math.round(pct * 10) / 10 : null,
      floorPct: pctOrNull(n.floorPct),
      atMs: Number.isFinite(Number(n.atMs)) ? Number(n.atMs) : null,
    };
  }

  window.NBDMarginFloor = { sanitizeSettings, marginOf, priceForFloorCents, check, band, BAND_TEXT, BAND_CLASS, canFinalizeUnder, confirmNote };
})();
