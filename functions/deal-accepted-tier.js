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
const PIF = require('./paid-in-full');

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

// ── tier-build block: byte-identical in functions/deal-accepted-tier.js and
//    docs/pro/js/accepted-tier-chip.js (tests/line-item-tiers-r6-2026-10-07 holds them equal) ──
/**
 * A LINE-ITEM estimate's other tiers (review R6-2-3 / R6-2-4, Jo 2026-10-07).
 * Its saved rows are priced at the rep's tier, so another tier's price can't
 * be dropped onto it: the rows, tax and rounding would no longer add up. The
 * V2 builder therefore stores, at save, each other tier it could offer, built
 * by the same engine (estimate-v2-ui.js _tierBuildsFor):
 *   est.tierRows = { v: 1,
 *     basis: { tier, totalCents, rowsKey },   // the estimate they were built beside
 *     tiers: { <tier>: { rows, grandTotal, subtotal, tax, taxRate, ... } } }
 * A build counts only while the estimate is still the one it was built beside
 * (same tier, same total, same rows): any later edit (the invoice pre-flight's
 * Save to estimate, a re-tier) leaves the builds stale and unusable. The deal
 * room offers only the estimate's own tier plus its usable builds, and "Use
 * it" rebuilds from a build or refuses.
 */
function isTierPriced(est) {
  return !!est && (est.priceMode === 'per-sq' || (est.prices != null && typeof est.prices === 'object'));
}

/** The rows' identity for a build's basis: code + retail cents, in order. */
function rowsKey(rows) {
  return (Array.isArray(rows) ? rows : []).map(function (r) {
    var v = r && (r.retailTotal != null ? r.retailTotal : r.total);
    return String((r && r.code) || '') + ':' + Math.round(Number(v || 0) * 100);
  }).join('|');
}

/** The stored build for `tier`, or null (not line-item, none stored, stale, or the current tier). */
function tierBuild(est, tier) {
  if (!est || isTierPriced(est)) return null;
  var tr = est.tierRows;
  if (!tr || typeof tr !== 'object' || tr.v !== 1 || !tr.basis || !tr.tiers || typeof tr.tiers !== 'object') return null;
  var chosen = String(est.selectedTier || est.tier || '').toLowerCase();
  var b = tr.basis;
  if (!chosen || String(b.tier || '').toLowerCase() !== chosen) return null;
  if (Math.round(Number(est.grandTotal) * 100) !== Number(b.totalCents)) return null;
  if (rowsKey(est.rows) !== String(b.rowsKey || '')) return null;
  var t = String(tier || '').toLowerCase();
  if (!t || t === chosen || !Object.prototype.hasOwnProperty.call(tr.tiers, t)) return null;
  var build = tr.tiers[t];
  if (!build || typeof build !== 'object' || !Array.isArray(build.rows) || !build.rows.length) return null;
  if (!(Number(build.grandTotal) > 0)) return null;
  return build;
}

/**
 * The packages a homeowner may accept on this estimate → { tier: dollars },
 * or null when this estimate doesn't restrict them (tier-priced: every tier
 * in prices{} is priced; no tier chosen: nothing to rebuild beside).
 * Line-item: the estimate's own tier at its total, plus each usable build.
 */
function offerableTierPrices(est) {
  if (!est || isTierPriced(est)) return null;
  var chosen = String(est.selectedTier || est.tier || '').toLowerCase();
  var total = Number(est.grandTotal);
  if (!chosen || !(total > 0)) return null;
  var out = {};
  var order = ['economy', 'good', 'better', 'best', 'beyond'];
  order.forEach(function (t) {
    if (t === chosen) { out[t] = Math.round(total * 100) / 100; return; }
    var b = tierBuild(est, t);
    if (b) out[t] = Math.round(Number(b.grandTotal) * 100) / 100;
  });
  return out;
}
// ── end tier-build block ──

/**
 * The accept link's tier prices (createDealAcceptToken) with every package
 * the estimate can't rebuild set to 0, so submitDealAcceptance refuses it as
 * unpriced. A tier-priced estimate, or none, leaves them as they were.
 */
function dealTierPrices(tierPrices, est) {
  const out = Object.assign({}, tierPrices || {});
  const offer = offerableTierPrices(est);
  if (!offer) return out;
  Object.keys(out).forEach((t) => { if (!Object.prototype.hasOwnProperty.call(offer, t)) out[t] = 0; });
  return out;
}

/** May the homeowner accept `tier` on this estimate? (no estimate / unrestricted → yes) */
function tierOffered(est, tier) {
  const offer = offerableTierPrices(est);
  return !offer || Object.prototype.hasOwnProperty.call(offer, String(tier || '').toLowerCase());
}

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
        // Only this lead's own tenant's invoices (paid-in-full.js
        // invoicesForLead): another company's invoice naming this lead is not
        // money taken on it (2026-10-05).
        invoices = PIF.invoicesForLead((q && q.docs ? q.docs : []).map((x) => x.data()), lead, info.leadId, null);
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

// ═══════════════════════════════════════════════════════════════
// "Use it" — the rep adopts the homeowner's pick (review R6-2-4, Jo 2026-10-07)
// ═══════════════════════════════════════════════════════════════

// The priced fields a V2 build carries (estimate-v2-ui.js _tierBuildsFor):
// what _buildSavePayload writes for the money, at that tier.
const TIER_BUILD_FIELDS = ['rows', 'grandTotal', 'subtotal', 'tax', 'taxRate', 'minJobApplied', 'materialMarkupPct',
  'retailBeforeOHP', 'overhead', 'overheadPct', 'profit', 'profitPct', 'materialCost', 'laborCost', 'internal', 'memberDiscount'];

/**
 * The writes for "Use it". Pure.
 *   o = { lead, estimate, estimateId, depositCollected?, depositRule?, now? }
 * → { reason, estimate: updates|null, lead: updates|null, price? }
 *   reason: 'applied' | 'nothing-pending' | 'needs-builder' | 'price-moved' | 'no-price' | 'no-estimate'
 * A line-item estimate is rebuilt from its stored build for the picked tier —
 * rows, subtotal, tax (with its Rounding / Minimum gap), O&P, jobValue — and
 * the deposit re-run through deposit-rule.js on the new total (a Kentucky
 * insurance job stays $0 at signing). No usable build → 'needs-builder' and
 * nothing is written: the rep re-prices it in the builder. The build must
 * still price the tier at what the homeowner accepted ('price-moved'
 * otherwise). A tier-priced estimate re-tiers its totals as before.
 */
function planUseAcceptedTier(o) {
  const { lead, estimate: est, estimateId, now } = o || {};
  const l = lead || {};
  if (!est || est.deleted === true) return { reason: 'no-estimate', estimate: null, lead: null };
  const tier = String(est.acceptedTier || '').toLowerCase();
  const chosen = String(est.selectedTier || est.tier || '').toLowerCase();
  if (!TIERS.includes(tier) || est.acceptedTierApplied === true || est.acceptedTierDismissed === true || tier === chosen) {
    return { reason: 'nothing-pending', estimate: null, lead: null };
  }
  const R = o.depositRule || DR;
  const kept = o.depositCollected === true;
  let fields;
  if (isTierPriced(est)) {
    const fromMap = est.prices && Number(est.prices[tier]);
    const price = fromMap > 0 ? fromMap : Number(est.acceptedPrice);
    if (!(price > 0)) return { reason: 'no-price', estimate: null, lead: null };
    fields = retierFields(est, price, { lead: l, depositRule: R, depositCollected: kept });
  } else {
    const build = tierBuild(est, tier);
    if (!build) return { reason: 'needs-builder', estimate: null, lead: null };
    if (Math.round(Number(build.grandTotal) * 100) !== Math.round(Number(est.acceptedPrice) * 100)) {
      return { reason: 'price-moved', estimate: null, lead: null, price: Number(build.grandTotal) };
    }
    fields = {};
    TIER_BUILD_FIELDS.forEach((k) => { fields[k] = build[k] === undefined ? null : build[k]; });
    if (est.taxAmount != null) fields.taxAmount = fields.tax;
    if (est.total != null) fields.total = fields.grandTotal;
    const totalCents = Math.round(Number(build.grandTotal) * 100);
    if (kept || !R) {
      fields.acceptedTierDepositKept = true;
    } else {
      const plan = R.fromEstimate(Object.assign({}, est, fields), { totalCents, lead: l });
      fields.deposit = plan.depositCents / 100;
      fields.depositPlan = R.toStored(plan);
      fields.acceptedTierDepositKept = false;
    }
    // The builds described the rows just replaced.
    fields.tierRows = null;
  }
  const estUpd = Object.assign({ tier, selectedTier: tier, acceptedTierApplied: true, acceptedTierReplaced: chosen || null }, fields);
  if (now != null) estUpd.acceptedTierAppliedAt = now;
  const p = Math.round(Number(estUpd.grandTotal) * 100) / 100;
  const isPrimary = !l.primaryEstimateId || l.primaryEstimateId === estimateId;
  return { reason: 'applied', estimate: estUpd, lead: (isPrimary && p > 0) ? { jobValue: p } : null, price: p };
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const COMPANY_EDITORS = ['company_admin', 'manager'];

/** May this signed-in user change this estimate? Owner, platform admin, or a company admin / manager of its company. */
function _mayApply(uid, token, est, lead) {
  const t = token || {};
  if (!uid) return false;
  if (t.role === 'viewer') return false;
  if (t.role === 'admin') return true;
  if (est.userId === uid) return true;
  const co = typeof t.companyId === 'string' && t.companyId ? t.companyId : '';
  if (!co || !(COMPANY_EDITORS.indexOf(t.role || '') !== -1 || t.owner === true)) return false;
  return String(est.companyId || '') === co || String((lead && lead.companyId) || '') === co;
}

/** The "apply it" task id the deposit draft files (deposit-draft-logic.js applyTierTask). */
function applyTaskId(estimateId) { return 'apply-accepted-tier-' + String(estimateId || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80); }

/**
 * The server side of the chip's "Use it" (deal-acceptance.js useAcceptedTier).
 * One transaction: re-read the estimate, its lead and the lead's invoices,
 * plan (planUseAcceptedTier), write the estimate + lead, close the "apply it"
 * task. Then — the acceptance now IS the estimate — the job spine runs the
 * deal acceptance again (deal_<id>): the signed price is stamped
 * (signed-price.js) and the deposit draft is made on the new price
 * (deposit-draft.js), exactly as for a per-SQ acceptance. Never throws.
 * @param db   Firestore (admin)
 * @param args { uid, token, estimateId }
 * @param deps { now, recordJobEvent, logger }
 * @returns {Promise<{ ok: boolean, reason: string, price?: number, spine?: object }>}
 */
async function applyHomeownerPick(db, args, deps) {
  const d = deps || {};
  const a = args || {};
  const estimateId = typeof a.estimateId === 'string' ? a.estimateId : '';
  if (!db || !ID_RE.test(estimateId)) return { ok: false, reason: 'bad-request' };
  const nowFn = d.now || (() => new Date());
  let out;
  try {
    out = await db.runTransaction(async (tx) => {
      const estRef = db.doc('estimates/' + estimateId);
      const es = await tx.get(estRef);
      const est = es.exists ? (es.data() || {}) : null;
      if (!est || est.deleted === true) return { ok: false, reason: 'no-estimate' };
      const leadId = ID_RE.test(String(est.leadId || '')) ? String(est.leadId) : null;
      let lead = null;
      const leadRef = leadId ? db.doc('leads/' + leadId) : null;
      if (leadRef) { const ls = await tx.get(leadRef); lead = ls.exists ? (ls.data() || {}) : null; }
      if (!_mayApply(a.uid, a.token, est, lead)) return { ok: false, reason: 'not-allowed' };
      let invoices = [];
      if (leadId) {
        const q = await tx.get(db.collection('invoices').where('leadId', '==', leadId));
        invoices = PIF.invoicesForLead((q && q.docs ? q.docs : []).map((x) => x.data()), lead, leadId, null);
      }
      const taskRef = leadRef ? db.doc('leads/' + leadId + '/tasks/' + applyTaskId(estimateId)) : null;
      const ts = taskRef ? await tx.get(taskRef) : null;
      const at = nowFn();
      const plan = planUseAcceptedTier({ lead, estimate: est, estimateId, now: at, depositCollected: depositCollected(invoices, estimateId) });
      if (plan.reason !== 'applied') return { ok: false, reason: plan.reason, price: plan.price };
      tx.update(estRef, Object.assign({}, plan.estimate, { updatedAt: at }));
      if (plan.lead && leadRef && lead) tx.update(leadRef, Object.assign({}, plan.lead, { updatedAt: at }));
      if (ts && ts.exists) tx.update(taskRef, { done: true, completedAt: at, completedBy: 'system: use accepted tier' });
      return {
        ok: true, reason: 'applied', price: plan.price, leadId,
        dealId: ID_RE.test(String(est.acceptedDealId || '')) ? String(est.acceptedDealId) : null,
        tier: plan.estimate.tier, ownerUid: (lead && lead.userId) || est.userId || null, companyId: (lead && lead.companyId) || null,
      };
    });
  } catch (e) {
    if (d.logger) d.logger.warn('[deal-accepted-tier] use-it failed', { estimateId, msg: e && e.message });
    return { ok: false, reason: 'error' };
  }
  if (!out.ok) return out;
  // The signature already happened (the deal room acceptance); re-running its
  // event stamps the signed price and drafts the deposit now that the
  // estimate carries the accepted tier. Idempotent (the spine's marker and
  // the draft's deterministic id); a failure leaves the estimate applied.
  let spine = null;
  if (out.leadId && out.dealId) {
    try {
      const rec = d.recordJobEvent || require('./job-spine').recordJobEvent;
      spine = await rec(db, {
        leadId: out.leadId, companyId: out.companyId, ownerUid: out.ownerUid, event: 'deal_accepted', sourceId: 'deal_' + out.dealId,
        actor: 'accepted tier applied',
        meta: { dealId: out.dealId, tier: out.tier, detail: String(out.tier || '').toUpperCase() + ' package applied to the estimate' },
      }, d.spineDeps);
    } catch (e) {
      spine = { error: String((e && e.message) || e) };
    }
  }
  if (d.logger) d.logger.info('[deal-accepted-tier] use-it applied', { estimateId, tier: out.tier, dealId: out.dealId });
  return { ok: true, reason: 'applied', price: out.price, spine };
}

module.exports = {
  planAcceptedTier, applyAcceptedTier, retierFields, depositCollected, TIERS,
  isTierPriced, rowsKey, tierBuild, offerableTierPrices, dealTierPrices, tierOffered,
  planUseAcceptedTier, applyHomeownerPick, applyTaskId, TIER_BUILD_FIELDS,
};
