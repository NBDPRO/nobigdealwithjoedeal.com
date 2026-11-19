/**
 * card-fee.js — the credit-card fee rules, pure (2026-11-18, flag docCardFeeV1, default OFF).
 * documentation/projects/CARD-FEE-V1-2026-11-18.md
 *
 * Jo's decisions (Q7, Q8, Q26, Q46; packet PAY-7): 3% on CREDIT cards only, never debit or prepaid,
 * none on Kentucky insurance-paid jobs, capped at the processor's actual cost, refunded pro rata,
 * only on contracts that contained the card-fee paragraph. Zelle/check/ACH/wire/cash carry no fee.
 *
 * ONE MODULE, TWO COPIES (like clause-set.js): docs/pro/js/card-fee.js (window.NBDCardFee) and
 * functions/card-fee.js. The test pins them byte-identical after EOL normalisation: edit one, copy it over.
 *
 * NOTHING HERE CHARGES ANYTHING and no Stripe call is made. CHARGING_LIVE is false because no
 * funding-aware charge path exists (Payment Links and hosted invoices cannot be); it gates every
 * customer-facing promise so a document never mentions a fee the system does not charge.
 *
 * Money is integer cents. FAIL CLOSED: unreadable state or payment source = Kentucky insurance
 * (same reading as clause-set.js variantOf); unknown funding = no fee.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDCardFee = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var FLAG_NAME = 'docCardFeeV1';
  var FLAG_DEFAULT = false;
  var CHARGING_LIVE = false;
  var MAX_PCT = 3.0;

  function _state(s) {
    var v = String(s == null ? '' : s).trim().toUpperCase();
    if (v === 'KENTUCKY') return 'KY';
    if (v === 'OHIO') return 'OH';
    return /^[A-Z]{2}$/.test(v) ? v : '';
  }
  function _source(s) {
    var v = String(s == null ? '' : s).trim().toLowerCase();
    if (v === 'cash' || v === 'insurance') return v;
    if (v === 'financed' || v === 'finance' || v === 'financing') return 'financed';
    return '';
  }
  /** True when the job is (or may be) a Kentucky insurance job: KY or unreadable state, insurance or unreadable source. */
  function isKyInsurance(state, paymentSource) {
    var st = _state(state), src = _source(paymentSource);
    return (st === 'KY' || st === '') && (src === 'insurance' || src === '');
  }
  function _pct(v) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return isFinite(n) && n > 0 ? Math.min(n, MAX_PCT) : 0;
  }
  function _funding(f) { return String(f == null ? '' : f).trim().toLowerCase(); }

  /**
   * -> { feeCents, reason }. reason: OK, BAD_AMOUNT, FEE_OFF, NO_CLAUSE, KY_INSURANCE, NOT_CREDIT, COST_ZERO.
   */
  function computeCardFee(o) {
    o = o || {};
    var amount = o.amountCents;
    if (typeof amount !== 'number' || !isFinite(amount) || Math.floor(amount) !== amount || amount <= 0) return { feeCents: 0, reason: 'BAD_AMOUNT' };
    var pct = _pct(o.cardFeePct);
    if (pct === 0) return { feeCents: 0, reason: 'FEE_OFF' };
    if (o.contractHasClause !== true) return { feeCents: 0, reason: 'NO_CLAUSE' };
    if (isKyInsurance(o.state, o.paymentSource)) return { feeCents: 0, reason: 'KY_INSURANCE' };
    if (_funding(o.funding) !== 'credit') return { feeCents: 0, reason: 'NOT_CREDIT' };
    var bp = Math.round(pct * 100);
    var fee = Math.floor((amount * bp + 5000) / 10000);
    var cost = o.processorCostCents;
    if (typeof cost === 'number' && isFinite(cost) && cost >= 0) {
      cost = Math.round(cost);
      if (cost < fee) fee = cost;
    }
    if (fee < 0) fee = 0;
    return { feeCents: fee, reason: fee === 0 ? 'COST_ZERO' : 'OK' };
  }

  /** Pro-rata fee to return with a refund. Full refund = the whole fee; never more than the fee. */
  function refundFeeCents(feeCents, paymentCents, refundCents) {
    var f = Math.round(Number(feeCents)), p = Math.round(Number(paymentCents)), r = Math.round(Number(refundCents));
    if (!isFinite(f) || !isFinite(p) || !isFinite(r) || f <= 0 || p <= 0 || r <= 0) return 0;
    if (r >= p) return f;
    return Math.min(f, Math.floor((f * r * 2 + p) / (p * 2)));
  }

  /** The fields a payment record stores. */
  function paymentRecordFields(o) {
    o = o || {};
    var fee = Math.round(Number(o.cardFeeCents));
    if (!isFinite(fee) || fee < 0) fee = 0;
    var f = _funding(o.funding);
    if (f !== 'credit' && f !== 'debit' && f !== 'prepaid') f = 'unknown';
    return { cardFeeCents: fee, cardFeePct: fee > 0 ? _pct(o.cardFeePct) : 0, fundingType: f };
  }

  function _pctText(p) { return String(Number(p.toFixed(2))); }

  /** The pay-page / invoice sentence, or '' unless every condition holds (never while CHARGING_LIVE is false). */
  function disclosureLine(o) {
    o = o || {};
    if (o.flagOn !== true || !CHARGING_LIVE) return '';
    var pct = _pct(o.cardFeePct);
    if (pct === 0 || o.contractHasClause !== true || isKyInsurance(o.state, o.paymentSource)) return '';
    return 'Pay free by Zelle, check, ACH or wire (and cash). Credit cards carry a ' + _pctText(pct) + '% fee; debit and prepaid cards do not.';
  }

  /** { feeCents, label } for a receipt / invoice line, or null when no fee was charged. Flag off = null. */
  function receiptFeeLine(o) {
    o = o || {};
    if (o.flagOn !== true) return null;
    var fee = Math.round(Number(o.cardFeeCents));
    if (!isFinite(fee) || fee <= 0) return null;
    var pct = _pct(o.cardFeePct);
    return { feeCents: fee, label: 'Credit card fee' + (pct > 0 ? ' (' + _pctText(pct) + '%)' : '') };
  }

  return {
    FLAG_NAME: FLAG_NAME, FLAG_DEFAULT: FLAG_DEFAULT, CHARGING_LIVE: CHARGING_LIVE, MAX_PCT: MAX_PCT,
    isKyInsurance: isKyInsurance, computeCardFee: computeCardFee, refundFeeCents: refundFeeCents,
    paymentRecordFields: paymentRecordFields, disclosureLine: disclosureLine, receiptFeeLine: receiptFeeLine
  };
});
