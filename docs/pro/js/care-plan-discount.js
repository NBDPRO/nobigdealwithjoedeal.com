/**
 * care-plan-discount.js — the Roof Care Plan member discount on REPAIR
 * estimates (Jo, 2026-10-05). Pure: no DOM, no Firestore. Loaded by the
 * estimates bundle (script-loader.js) before the builders, and required by
 * the node tests.
 *
 * The rule (pinned by tests/care-plan-crm-2026-10-05.test.js):
 *   - only for a customer whose lead carries the server-written mirror
 *     leads/{id}.carePlan with member === true (active or past_due — Stripe
 *     is retrying the card, benefits stay on);
 *   - only on REPAIR work: the estimate is marked repair (V2/V3 repair
 *     presets, the V3 "Repair" kind, the rep's "Repair work" button, or a
 *     Job Template selection whose every template is a repair job type);
 *   - never on a replacement (per-SQ pricing, a replacement preset or
 *     template) unless Jo decides otherwise later, and never on an insurance
 *     claim (the carrier prices that scope);
 *   - a visible line "Roof Care Plan member — 10% off repairs", in cents:
 *     the member pays 90% of the price they'd otherwise pay, to the cent
 *     (minimum-job floor and rounding included). The line carries the
 *     pre-tax part; the tax drops by the rest. Pass-through fees (a
 *     measurement report) are added after and never discounted.
 *
 * Design note: documentation/projects/ROOF-CARE-PLAN-2026-10-05.md
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDCarePlanDiscount = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var PCT = 10;
  var LABEL = 'Roof Care Plan member — 10% off repairs';
  var CODE = 'DSC CAREPLAN';
  var SOURCE = 'care_plan_discount';
  var CATEGORY = 'Discounts';
  // Job Template job types that count as repair work (job-templates.js
  // JOB_TYPES). replacement / install / maintenance / inspection do not.
  var REPAIR_JOB_TYPES = ['repair', 'emergency'];
  var REPLACEMENT_JOB_TYPES = ['replacement', 'install'];
  var MEMBER_STATUSES = ['active', 'past_due'];

  function cents(v) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }

  /** Is this lead a Roof Care Plan member right now? */
  function isMember(lead) {
    var c = lead && lead.carePlan;
    return !!(c && typeof c === 'object' && c.member === true && MEMBER_STATUSES.indexOf(String(c.status || '')) !== -1);
  }

  function isDiscountLine(line) {
    return !!line && (line.source === SOURCE || String(line.code || '') === CODE);
  }

  /** Every selected Job Template is a repair job type (and there is one). */
  function templatesAreRepair(templates) {
    if (!Array.isArray(templates) || !templates.length) return false;
    return templates.every(function (t) {
      return !!t && REPAIR_JOB_TYPES.indexOf(String(t.jobType || '')) !== -1;
    });
  }
  /**
   * The kind of work a Job Template selection is: 'repair' when every
   * template is a repair job type; 'replacement' when any is a replacement
   * or install; null otherwise (maintenance, inspection — not a repair).
   */
  function workKindOfTemplates(templates) {
    if (templatesAreRepair(templates)) return 'repair';
    var list = Array.isArray(templates) ? templates : [];
    if (list.some(function (t) { return !!t && REPLACEMENT_JOB_TYPES.indexOf(String(t.jobType || '')) !== -1; })) return 'replacement';
    return null;
  }

  /**
   * Does the discount apply? → { applies, member, reason }
   * reason: 'applied' | 'not_member' | 'insurance' | 'replacement' | 'not_repair'
   */
  function decide(ctx) {
    var c = ctx || {};
    if (!isMember(c.lead)) return { applies: false, member: false, reason: 'not_member' };
    if (c.jobMode === 'insurance') return { applies: false, member: true, reason: 'insurance' };
    if (c.priceMode === 'per-sq' || c.workKind === 'replacement') return { applies: false, member: true, reason: 'replacement' };
    if (c.workKind !== 'repair') return { applies: false, member: true, reason: 'not_repair' };
    return { applies: true, member: true, reason: 'applied' };
  }

  /** The figures, in cents, for a price (pre-fee total) at a tax rate. */
  function figures(totalCents, taxRate) {
    var t = Math.max(0, Math.round(Number(totalCents) || 0));
    var rate = Number(taxRate) > 0 ? Number(taxRate) : 0;
    var off = Math.round(t * PCT / 100);
    var preTax = rate > 0 ? Math.round(off / (1 + rate)) : off;
    return { baseCents: t, cents: off, preTaxCents: preTax, taxCents: off - preTax };
  }

  /** Remove any discount line + figures (so a re-apply never stacks). */
  function strip(est) {
    if (!est) return est;
    var prior = est.memberDiscount;
    if (prior && Array.isArray(est.lines) && est.lines.some(isDiscountLine)) {
      est.total = (cents(est.total) + (prior.cents || 0)) / 100;
      est.subtotal = (cents(est.subtotal) + (prior.preTaxCents || 0)) / 100;
      est.tax = (cents(est.tax) + (prior.taxCents || 0)) / 100;
    }
    if (Array.isArray(est.lines)) est.lines = est.lines.filter(function (l) { return !isDiscountLine(l); });
    delete est.memberDiscount;
    return est;
  }

  /**
   * Apply the discount to a resolveEstimate-shaped object
   * ({ lines, subtotal, tax, taxRate, total, internal? }) IN PLACE and
   * return it. Idempotent. A $0 price gets no line.
   */
  function apply(est) {
    if (!est) return est;
    strip(est);
    var f = figures(cents(est.total), est.taxRate);
    if (f.cents <= 0) return est;
    var pre = -f.preTaxCents / 100;
    est.lines = Array.isArray(est.lines) ? est.lines : [];
    est.lines.push({
      code: CODE,
      name: LABEL,
      quantity: 1,
      unit: 'ea',
      unitPrice: pre,
      lineTotal: pre,
      retailPerUnit: pre,
      retailTotal: pre,
      category: CATEGORY,
      source: SOURCE,
      qtyOverridden: false,
    });
    est.total = (f.baseCents - f.cents) / 100;
    est.subtotal = (cents(est.subtotal) - f.preTaxCents) / 100;
    est.tax = (cents(est.tax) - f.taxCents) / 100;
    if (est.internal && Number.isFinite(Number(est.internal.margin))) {
      var m = (cents(est.internal.margin) - f.cents) / 100;
      est.internal = Object.assign({}, est.internal, {
        margin: m,
        marginPct: est.total > 0 ? (m / est.total) * 100 : 0,
      });
    }
    est.memberDiscount = { pct: PCT, label: LABEL, cents: f.cents, preTaxCents: f.preTaxCents, taxCents: f.taxCents, baseTotalCents: f.baseCents };
    return est;
  }

  /**
   * The same discount on a SAVED-estimate payload (classic row shape:
   * rows[] + grandTotal / subtotal / tax / taxAmount / taxRate), for the Job
   * Templates path, which applies it after upgrades exactly as V2 does.
   * Returns a NEW payload; the input is untouched. Idempotent.
   */
  function applyToSaved(payload) {
    if (!payload) return payload;
    var out = Object.assign({}, payload);
    var rows = (Array.isArray(out.rows) ? out.rows : []).filter(function (r) { return !isDiscountLine(r); });
    var prior = out.memberDiscount;
    var totalC = cents(out.grandTotal), subC = cents(out.subtotal), taxC = cents(out.tax != null ? out.tax : out.taxAmount);
    if (prior && (Array.isArray(out.rows) ? out.rows : []).some(isDiscountLine)) {
      totalC += prior.cents || 0; subC += prior.preTaxCents || 0; taxC += prior.taxCents || 0;
    }
    var f = figures(totalC, out.taxRate);
    out.rows = rows;
    out.memberDiscount = null;
    out.grandTotal = totalC / 100; out.subtotal = subC / 100; out.tax = taxC / 100;
    if ('taxAmount' in payload) out.taxAmount = taxC / 100;
    if (f.cents <= 0) return out;
    var pre = -f.preTaxCents / 100;
    out.rows = rows.concat([{
      code: CODE, desc: LABEL, qty: '1.00ea', rate: '−$' + (f.preTaxCents / 100).toFixed(2),
      total: pre, retailTotal: pre, quantity: 1, unit: 'ea', category: CATEGORY,
      materialTotal: null, laborTotal: null, materialCostPerUnit: null, laborCostPerUnit: null,
      unitPrice: pre, qtyOverride: null, source: SOURCE,
    }]);
    out.grandTotal = (totalC - f.cents) / 100;
    out.subtotal = (subC - f.preTaxCents) / 100;
    out.tax = (taxC - f.taxCents) / 100;
    if ('taxAmount' in payload) out.taxAmount = out.tax;
    out.memberDiscount = { pct: PCT, label: LABEL, cents: f.cents, preTaxCents: f.preTaxCents, taxCents: f.taxCents, baseTotalCents: f.baseCents };
    return out;
  }

  /** Short sentence for the builder's note, by decide() reason. */
  function reasonText(reason) {
    return {
      applied: 'Roof Care Plan member — 10% off repairs applied.',
      insurance: 'Roof Care Plan member. The 10% repair discount is not used on insurance claims.',
      replacement: 'Roof Care Plan member. The 10% discount is for repairs, not replacements.',
      not_repair: 'Roof Care Plan member. Mark this as repair work to apply the 10% member discount.',
    }[reason] || '';
  }

  return {
    PCT: PCT, LABEL: LABEL, CODE: CODE, SOURCE: SOURCE, CATEGORY: CATEGORY,
    REPAIR_JOB_TYPES: REPAIR_JOB_TYPES.slice(),
    isMember: isMember, isDiscountLine: isDiscountLine, templatesAreRepair: templatesAreRepair,
    workKindOfTemplates: workKindOfTemplates,
    decide: decide, figures: figures, apply: apply, strip: strip, applyToSaved: applyToSaved, reasonText: reasonText,
  };
});
