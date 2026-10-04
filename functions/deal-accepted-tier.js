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
 * Best-effort and never throws (like deal-install-date.js): the acceptance is
 * already committed. One transaction, so a rep edit landing at the same
 * moment is re-read rather than overwritten. No firebase import — the caller
 * passes its Firestore handle (tests drive a fake one).
 */
'use strict';

const TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
const cents = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Pure decision.
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
  // A template estimate that is not a roofing tier (tierApplies:false) has no
  // tier to fill — record only.
  if (!chosen && estimate.tierApplies !== false) {
    const estUpd = Object.assign({}, stamp, { tier, selectedTier: tier, grandTotal: p, acceptedTierApplied: true });
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
 * @param {object} db    Firestore (admin): doc() + runTransaction()
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
      const at = now();
      const plan = planAcceptedTier({ lead, estimate, estimateId, leadId: info.leadId, ownerUid: info.ownerUid, tier, price, dealId: info.dealId, now: at });
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

module.exports = { planAcceptedTier, applyAcceptedTier, TIERS };
