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

  const toCents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null; };

  /**
   * One estimate, as any of the builders hands it over or saves it, to the four
   * things the check needs. Dollars in, integer cents out.
   *   price  total (or grandTotal) MINUS tax (or taxAmount). On every path the
   *          minimum charge and a discount are already inside the total, and tax
   *          is never recomputed after them, so total - tax is the pre-tax price
   *          the customer pays.
   *   cost   hardCost, else internal.hardCost, else materialCost + laborCost,
   *          else the classic estimator's single costBasis.
   *   known  only when there is a cost above 0, no line is uncosted
   *          (costUnsetCount) and the builder did not itself say "no cost basis"
   *          (internal.marginPct === null).
   */
  function jobFromEstimate(est) {
    const e = (est && typeof est === 'object') ? est : {};
    const total = toCents(e.total != null ? e.total : e.grandTotal);
    const tax = toCents(e.tax != null ? e.tax : (e.taxAmount != null ? e.taxAmount : 0));
    const internal = (e.internal && typeof e.internal === 'object') ? e.internal : null;
    let cost = null;
    if (e.hardCost != null) cost = toCents(e.hardCost);
    else if (internal && internal.hardCost != null) cost = toCents(internal.hardCost);
    else if (e.materialCost != null || e.laborCost != null) cost = toCents((Number(e.materialCost) || 0) + (Number(e.laborCost) || 0));
    else if (e.costBasis != null) cost = toCents(e.costBasis);
    const uncosted = Number(e.costUnsetCount) > 0 || (internal !== null && internal.marginPct === null);
    return {
      mode: e.mode === 'insurance' ? 'insurance' : 'cash',
      preTaxCents: (total === null || tax === null) ? null : total - tax,
      costCents: cost,
      costKnown: cost !== null && cost > 0 && !uncosted,
    };
  }

  /** The signed-in company's floor and target, or off. Read at call time: the profile can land late. */
  function settingsNow() {
    const p = window._companyProfile;
    return sanitizeSettings(p && p.pricing && p.pricing.marginFloor);
  }

  /**
   * Everything a screen needs to show one estimate's margin: the tax-free margin
   * (shown whether or not a floor is set), the check and the band.
   */
  function view(est, settings) {
    const s = settings === undefined ? settingsNow() : ((settings && settings.on === true) ? settings : sanitizeSettings(settings));
    const job = jobFromEstimate(est);
    const m = marginOf(job);
    const c = check(Object.assign({}, job, { settings: s }));
    const b = c.state === 'exempt' ? 'plain' : band(m.pct, s);
    return { known: m.known, marginPct: m.pct, marginCents: m.marginCents, preTaxCents: job.preTaxCents, mode: job.mode, state: c.state, check: c, band: b, cls: BAND_CLASS[b], text: BAND_TEXT[b] };
  }

  /** The band as a shared badge. The text is fixed (BAND_TEXT), so nothing here needs escaping. */
  function badgeHtml(v) {
    return (v && v.cls) ? '<span class="ui-badge ' + v.cls + '">' + v.text + '</span>' : '';
  }

  /**
   * owner, company_admin, admin, manager, sales_rep, … for the signed-in person.
   * A solo owner carries no role claim (the company is their uid), so a role
   * string alone would read them as nobody.
   */
  function callerRole() {
    const c = window._userClaims || {};
    const uid = (window._user && window._user.uid) || null;
    const r = String(c.role || '').toLowerCase();
    if (c.admin === true || r === 'admin') return 'admin';
    if (r) return r;
    if (c.owner === true || !c.companyId || c.companyId === uid) return 'owner';
    return '';
  }

  /**
   * May the signed-in person see an estimate's dollar cost breakdown and the
   * Internal View? The owner and a company admin (Jo, 2026-11-17). A rep or a
   * manager sees the margin percentage and its band only. SCREEN-LEVEL: their
   * browser still loads the costs it prices with.
   */
  function canSeeCosts() { return canFinalizeUnder(callerRole()); }

  /**
   * The confirm step for a job under the floor, for screens that offer no
   * price raise of their own (job templates). The V2 builder words its own
   * the same way. Resolves { ok, note }:
   *   not under, or a prior note the margin still holds -> ok, nothing asked
   *   a rep or a manager                                 -> told, not ok
   *   the owner or a company admin                       -> asked; yes gives a
   *                                                         private note with an
   *                                                         optional reason
   * opts = { say(msg), prev: an earlier note, extra: text after the facts }
   */
  async function confirmUnder(v, opts) {
    const o = opts || {};
    if (!v || v.state !== 'under') return { ok: true, note: null };
    const prev = o.prev;
    if (prev && typeof prev.marginPct === 'number' && v.marginPct >= prev.marginPct - 0.05) return { ok: true, note: prev };
    const floor = v.check.floorPct, need = v.check.neededPreTaxCents;
    const facts = 'This job is at ' + v.marginPct.toFixed(1) + '% margin before tax. Your company floor is ' + floor + '%.'
      + (need ? ' A price of $' + Math.ceil(need / 100).toLocaleString() + ' before tax reaches it.' : '')
      + (o.extra ? ' ' + o.extra : '');
    const role = callerRole();
    if (!canFinalizeUnder(role)) {
      const msg = facts + ' Raise the price, or save it as a draft for an owner or admin to send.';
      if (typeof o.say === 'function') o.say(msg, 'error');
      if (typeof window.showToast === 'function') window.showToast(msg, 'warning');
      return { ok: false, note: null };
    }
    const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (!(await ask(facts + ' Send it at this price anyway?'))) return { ok: false, note: null };
    let reason = '';
    if (typeof window.nbdPrompt === 'function') {
      try { reason = String((await window.nbdPrompt('Reason for going under your floor (optional, kept private):', '')) || '').replace(/\s+/g, ' ').trim().slice(0, 200); } catch (_) { reason = ''; }
    }
    const note = confirmNote({ uid: (window._user && window._user.uid) || '', role, marginPct: v.marginPct, floorPct: floor, atMs: Date.now() });
    if (note && reason) note.reason = reason;
    return { ok: !!note, note };
  }

  window.NBDMarginFloor = {
    sanitizeSettings, marginOf, priceForFloorCents, check, band, BAND_TEXT, BAND_CLASS, canFinalizeUnder, confirmNote,
    jobFromEstimate, settingsNow, view, badgeHtml, callerRole, canSeeCosts, confirmUnder,
  };
})();
