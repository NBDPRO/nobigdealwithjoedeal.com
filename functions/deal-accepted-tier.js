/**
 * functions/deal-accepted-tier.js — the homeowner's accepted package → the
 * estimate and the lead.
 *
 * 2026-10-03 (stage-flow lane). A homeowner picks a tier in the Close Board
 * deal room and accepts (deal-acceptance.js submitDealAcceptance). Until now
 * that choice stopped at deal_rooms/{id}.acceptedTier: the estimate kept
 * whatever tier the rep had on it and the lead's job value never heard of the
 * accepted price, so the invoice and the pipeline quoted the wrong package.
 *
 * The rule (Jo's brief):
 *   - The estimate has NO tier chosen yet → write the accepted tier and price
 *     onto it (tier / selectedTier / grandTotal) and onto the lead's jobValue
 *     (only when that estimate is the lead's primary, or the lead has none).
 *   - (2026-10-06, R2-2-1) A tier-PRICED estimate (per-SQ / prices{}) that
 *     already names a tier takes the accepted tier and price too — see
 *     planAcceptedTier. The bullet below now applies to line-item estimates.
 *   - The estimate already HAS a tier → never overwrite the rep's choice.
 *     Record acceptedTier/acceptedPrice alongside it; the customer page shows
 *     "Homeowner picked X — use it?" (accepted-tier-chip.js) for a one-tap
 *     switch.
 *   - No estimate to match → record on the lead; fill jobValue only when the
 *     lead has none.
 * acceptedTier/acceptedPrice are always recorded on the lead, so the customer
 * page can show the choice even when the estimate can't be found.
 *
 * Which estimate: the deal room's estimateId, else the lead's primaryEstimateId.
 * It must belong to the deal's owner and to this lead.
 *
 * Money stays in dollars here because every field it touches is a dollar
 * field (deal tier prices, estimate grandTotal, lead jobValue), rounded to
 * cents.
 *
 * 2026-10-05 (bug #10, Jo's call): writing the accepted price onto a tier-less
 * estimate now RECOMPUTES ALL THREE — subtotal and tax for that tier's total,
 * and the deposit re-run through deposit-rule.js on the new total — so every
 * number on the estimate matches the tier picked (retierFields below). Before,
 * only grandTotal moved: a $10,000 → $15,000 pick kept a $5,000 deposit and a
 * $9,300 subtotal. Money already collected on the estimate is never rewritten:
 * the deposit stays and acceptedTierDepositKept flags it for the rep.
 *
 * Best-effort and never throws (like deal-install-date.js): the acceptance is
 * already committed. One transaction, so a rep edit landing at the same
 * moment is re-read rather than overwritten. No firebase import — the caller
 * passes its Firestore handle (tests drive a fake one).
 */
'use strict';

const TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
const cents = (n) => Math.round(Number(n) * 100) / 100;
const DR = require('./deposit-rule');

// ── retier block: byte-identical in functions/deal-accepted-tier.js and
//    docs/pro/js/accepted-tier-chip.js (tests/deal-accepted-tier-2026-10-03 holds them equal) ──
/**
 * The homeowner's tier price → every money number on the estimate (Jo,
 * 2026-10-05, bug #10): grandTotal, subtotal + tax, and the deposit.
 *   Tax: a saved estimate stores subtotal / tax for its SELECTED tier only
 *   (prices{} holds each tier's TOTAL), so the picked tier's tax is backed out
 *   of its total at the estimate's own taxRate (else its tax / subtotal, else
 *   0): tax = total x r / (1 + r), subtotal = total - tax. Insurance estimates
 *   carry taxRate 0, so no tax.
 *   Deposit: deposit-rule.js fromEstimate on the new total with the estimate's
 *   own inputs (mode, claim deductible / ACV, address, a stored rep override)
 *   and the lead (its deductible, claim signals, Kentucky address), so a
 *   Kentucky insurance job stays $0 at signing.
 *   Money already collected (opts.depositCollected) or no rule loaded: the
 *   deposit and its plan stay as they were and acceptedTierDepositKept flags
 *   it for the rep. A paid deposit is never silently rewritten.
 * Cents inside; dollar fields out (the estimate's own units).
 */
function retierFields(est, price, opts) {
  var e = est || {};
  var o = opts || {};
  var totalCents = Math.round(Number(price) * 100);
  var rate = Number(e.taxRate);
  if (e.taxRate == null || e.taxRate === '' || !isFinite(rate) || rate < 0) {
    var st = Number(e.subtotal);
    var tx = Number(e.tax != null ? e.tax : e.taxAmount);
    rate = (st > 0 && isFinite(tx) && tx >= 0) ? tx / st : 0;
  }
  var taxCents = Math.round(totalCents * rate / (1 + rate));
  var out = { grandTotal: totalCents / 100, subtotal: (totalCents - taxCents) / 100, tax: taxCents / 100 };
  if (e.taxAmount != null) out.taxAmount = out.tax;
  if (e.total != null) out.total = out.grandTotal;
  var R = o.depositRule;
  if (o.depositCollected || !R) {
    out.acceptedTierDepositKept = true;
  } else {
    var plan = R.fromEstimate(e, { totalCents: totalCents, lead: o.lead || null });
    out.deposit = plan.depositCents / 100;
    out.depositPlan = R.toStored(plan);
    out.acceptedTierDepositKept = false;
  }
  return out;
}

/** Has money been collected on this estimate? (the lead's invoices) */
function depositCollected(invoices, estimateId) {
  return (invoices || []).some(function (inv) {
    if (!inv || inv.deleted === true) return false;
    if (inv.estimateId && inv.estimateId !== estimateId) return false;
    var st = String(inv.status || '').toLowerCase();
    if (st === 'void' || st === 'voided' || st === 'cancelled' || st === 'canceled') return false;
    return Number(inv.amountPaid) > 0 || inv.depositPaid === true || st === 'paid' || st === 'partial';
  });
}
// ── end retier block ──

/**
 * Pure decision. o.depositCollected (money already taken on the estimate)
 * keeps the deposit; o.depositRule overrides deposit-rule.js (tests).
 * @returns {{ reason: string, lead: object|null, estimate: object|null }}
 *   the field updates for leads/{id} and estimates/{id} (null = no write)
 */
function planAcceptedTier(o) {
  const { lead, estimate, estimateId, leadId, ownerUid, tier, price, dealId, now } = o || {};
  if (!TIERS.includes(tier) || !(Number(price) > 0)) return { reason: 'bad-tier', lead: null, estimate: null };
  if (!lead) return { reason: 'no-lead', lead: null, estimate: null };
  if (lead.deleted === true) return { reason: 'lead-deleted', lead: null, estimate: null };
  if (!ownerUid || lead.userId !== ownerUid) return { reason: 'not-owner', lead: null, estimate: null };
  const p = cents(price);
  const stamp = { acceptedTier: tier, acceptedPrice: p, acceptedAt: now, acceptedDealId: dealId || null };
  const leadUpd = { acceptedTier: tier, acceptedPrice: p, acceptedTierAt: now };

  const estOk = estimate && estimate.deleted !== true && estimate.userId === ownerUid
    && (estimate.leadId === leadId || (lead.primaryEstimateId && lead.primaryEstimateId === estimateId));
  if (!estOk) {
    if (!(Number(lead.jobValue) > 0)) leadUpd.jobValue = p;
    return { reason: 'no-estimate', lead: leadUpd, estimate: null };
  }
  const chosen = String(estimate.selectedTier || estimate.tier || '').toLowerCase();
  // 2026-10-06 (review R2-2-1, Jo): a tier-PRICED estimate (per-SQ, or one
  // carrying the prices{} map the deal room's tiers came from) takes the
  // homeowner's pick even when it already names a tier. V2 always saves one
  // (state.tier defaults to 'better'), so "never overwrite the rep's choice"
  // meant the acceptance never reached the estimate: the signing-day draft
  // billed the accepted price (deposit-draft-logic _priceEstimate) while the
  // estimate, jobValue, portal and install-day final invoice kept the default
  // tier's total. Nothing on an estimate records that a rep deliberately
  // locked a tier, so the signed acceptance wins. A line-item estimate keeps
  // the old behaviour (record + the customer-page chip): its saved rows are
  // priced at the rep's tier, so its total cannot be swapped for another
  // tier's price, and the deposit draft does not reprice it either.
  const tierPriced = estimate.priceMode === 'per-sq' || (estimate.prices != null && typeof estimate.prices === 'object');
  const priceDiffers = Math.round(Number(estimate.grandTotal) * 100) !== Math.round(p * 100);
  const override = !!chosen && tierPriced && (chosen !== tier || priceDiffers);
  // A template estimate that is not a roofing tier (tierApplies:false) has no
  // tier to fill — record only.
  if ((!chosen || override) && estimate.tierApplies !== false) {
    // grandTotal + subtotal + tax + deposit for the picked tier (bug #10).
    const estUpd = Object.assign({}, stamp, { tier, selectedTier: tier, acceptedTierApplied: true },
      retierFields(estimate, p, { lead, depositRule: o.depositRule || DR, depositCollected: o.depositCollected === true }));
    if (override) {
      // The tier it replaced, for the rep's history; the prices map follows a
      // re-snapshotted price so a reopen shows the same number.
      estUpd.acceptedTierReplaced = chosen;
      if (estimate.prices && typeof estimate.prices === 'object' && Math.round(Number(estimate.prices[tier]) * 100) !== Math.round(p * 100)) {
        estUpd.prices = Object.assign({}, estimate.prices, { [tier]: p });
      }
    }
    const isPrimary = !lead.primaryEstimateId || lead.primaryEstimateId === estimateId;
    if (isPrimary) {
      leadUpd.jobValue = p;
      if (!lead.primaryEstimateId) leadUpd.primaryEstimateId = estimateId;
    }
    return { reason: isPrimary ? 'applied' : 'applied-estimate-only', lead: leadUpd, estimate: estUpd };
  }
  // The rep already chose: keep it, record the homeowner's pick beside it.
  return { reason: chosen === tier ? 'same-tier' : 'recorded-differs', lead: leadUpd, estimate: stamp };
}

/**
 * @param {object} db    Firestore (admin): doc() + collection() + runTransaction()
 * @param {object} info  { dealId, leadId, ownerUid } from the accept token
 * @param {string} tier  accepted tier key
 * @param {number} price accepted price (dollars, the server snapshot)
 * @param {object} [deps] { now: () => Date, logger }
 * @returns {Promise<string>} the plan's reason, or 'error'
 */
async function applyAcceptedTier(db, info, tier, price, deps) {
  const d = deps || {};
  const now = d.now || (() => new Date());
  const okId = (s) => typeof s === 'string' && s && s.indexOf('/') === -1;
  if (!info || !okId(info.leadId)) return 'no-lead';
  try {
    return await db.runTransaction(async (tx) => {
      const leadRef = db.doc('leads/' + info.leadId);
      const reads = [tx.get(leadRef)];
      if (okId(info.dealId)) reads.push(tx.get(db.doc('deal_rooms/' + info.dealId)));
      const [leadSnap, dealSnap] = await Promise.all(reads);
      const lead = leadSnap.exists ? leadSnap.data() : null;
      const deal = dealSnap && dealSnap.exists ? dealSnap.data() : {};
      const estimateId = (okId(deal.estimateId) && deal.estimateId) || (lead && okId(lead.primaryEstimateId) && lead.primaryEstimateId) || null;
      let estimate = null;
      const estRef = estimateId ? db.doc('estimates/' + estimateId) : null;
      if (estRef) { const s = await tx.get(estRef); estimate = s.exists ? s.data() : null; }
      // Money already taken on this estimate (a paid / part-paid invoice for
      // the lead) → the deposit is kept, never rewritten (bug #10).
      let invoices = [];
      if (estimate) {
        const q = await tx.get(db.collection('invoices').where('leadId', '==', info.leadId));
        invoices = (q && q.docs ? q.docs : []).map((x) => x.data());
      }
      const at = now();
      const plan = planAcceptedTier({ lead, estimate, estimateId, leadId: info.leadId, ownerUid: info.ownerUid, tier, price, dealId: info.dealId, now: at,
        depositCollected: depositCollected(invoices, estimateId) });
      if (plan.estimate && estRef) tx.update(estRef, Object.assign({}, plan.estimate, { updatedAt: at }));
      if (plan.lead) tx.update(leadRef, Object.assign({}, plan.lead, { updatedAt: at }));
      if (d.logger) d.logger.info('[deal-accepted-tier]', { leadId: info.leadId, estimateId, reason: plan.reason });
      return plan.reason;
    });
  } catch (e) {
    if (d.logger) d.logger.warn('[deal-accepted-tier] failed', { leadId: info.leadId, msg: e && e.message });
    return 'error';
  }
}

module.exports = { planAcceptedTier, applyAcceptedTier, retierFields, depositCollected, TIERS };
