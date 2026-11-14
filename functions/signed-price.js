/**
 * functions/signed-price.js — the signed price wins on every bill, and a stale
 * deal-room price can't be accepted (review R6-2-2 / R6-2-5; Jo's rules,
 * 2026-10-07).
 *
 * R6-2-2. A signed estimate stays editable, but what the homeowner signed is
 * what they are billed until they re-sign. Before this, a rep who reopened a
 * $14,500 signed estimate and saved it at $16,200 moved the portal card to
 * "✓ Signed $16,200" and the install-day final draft billed the extra $1,700.
 * Now, when a signature lands, the job spine (job-spine.js recordJobEvent,
 * contract_signed / deal_accepted) stamps estimates/{id}.signedPrice — the
 * priced fields as signed (customer-estimate-rows.js signedPriceSnapshot) —
 * and every bill reads the estimate through signedView():
 *   - the deposit + final drafts (deposit-draft-logic.js),
 *   - the CRM invoice and "Paid in full?" (docs/pro/js/invoice-pipeline.js),
 *     and so the Stripe pay link, which charges the invoice,
 *   - the doc generator's invoice / receipt pre-fill (doc-preflight.js),
 *   - the portal's estimate card (portal.js).
 * The field is server-only (firestore.rules /estimates): a client can neither
 * write it on create nor change it on update. A later signature (a re-sent
 * contract, a new deal room) stamps over it — that is the re-sign.
 *
 * Which price was signed:
 *   - an e-sign envelope made from the estimate → the snapshot the envelope
 *     took when it was SENT (esign-envelope.js pricedSnapshot): what the PDF
 *     printed, even if the estimate moved while the link was out;
 *   - a deal-room acceptance → the estimate after the accepted tier was
 *     applied (deal-accepted-tier.js runs first). A line-item estimate whose
 *     acceptance was only RECORDED at another tier's price (review R6-2-3,
 *     not this lane) is not stamped: its bills keep following the estimate
 *     until the rep resolves the "use it?" chip;
 *   - a remote HTML contract (remote-signing.js) → the snapshot of the
 *     lead's primary estimate the sign request took when the link was SENT
 *     (money review 2026-11-14, finding 8); if the estimate moved since, the
 *     snapshot wins and the stamp carries movedSinceSent + currentTotalCents
 *     for the rep. A link sent before this shipped has no snapshot → below;
 *   - any other contract (in-person HTML contract, an uploaded PDF titled as
 *     a contract) → the lead's primary estimate as it stands.
 *
 * R6-2-5. A deal-room link carries the version of the estimate it was issued
 * at (deal-acceptance.js createDealAcceptToken stores estimateFingerprint).
 * checkDealPrice refuses an acceptance when the estimate was re-priced since
 * (or the price on the page no longer matches the estimate's price for that
 * package), answers with the CURRENT price, and accepts only when the
 * homeowner confirms that current price (deal-room.js re-asks). Server-side:
 * the page's own numbers are never trusted.
 *
 * Existing signed estimates (signed before this shipped) carry no signedPrice
 * and bill exactly as before — no migration; the next signature stamps one.
 *
 * Money: the estimate's own dollar fields are copied verbatim; comparisons are
 * in cents.
 */
'use strict';

const CER = require('./customer-estimate-rows');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SIGN_EVENTS = ['contract_signed', 'deal_accepted'];
const TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
const cents = (n) => Math.round(Number(n) * 100);

function _isDeleted(o) { return !!o && (o.deleted === true || !!o.deletedAt); }

function _sameTenant(est, lead, leadId) {
  if (!est || !lead) return false;
  if (est.leadId && leadId && est.leadId !== leadId) return false;
  const owners = [lead.userId, lead.companyId].filter(Boolean).map(String);
  const estOwners = [est.userId, est.companyId, est.createdBy].filter(Boolean).map(String);
  if (!estOwners.length) return true; // legacy doc with no owner stamp — its leadId tied it above
  return estOwners.some((o) => owners.indexOf(o) !== -1);
}

/**
 * Which estimate a signature signed: the envelope's estimate, else the
 * remote sign request's (its price snapshot), else the deal room's, else the
 * lead's primary. → id or null
 */
function signedEstimateIdFor(lead, deal, envelope, signRequest) {
  const ok = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
  return ok(envelope && envelope.kind === 'estimate' && envelope.estimateId)
    || ok(signRequest && signRequest.estimateId)
    || ok(deal && deal.estimateId)
    || ok(lead && lead.primaryEstimateId)
    || null;
}

/** A deal-room acceptance recorded beside the rep's tier (not applied) at a different price. */
function _acceptanceNotApplied(est) {
  if (!est || !est.acceptedTier || !(Number(est.acceptedPrice) > 0)) return false;
  if (est.acceptedTierApplied === true || est.acceptedTierDismissed === true) return false;
  return cents(est.acceptedPrice) !== cents(CER.estimateValue(est));
}

/**
 * Decide the stamp. Pure.
 *   ctx = { leadId, lead, est, estimateId, event, sourceId, envelope?,
 *           duplicate?, nowMs }
 * → { action: 'stamp', estimateId, signedPrice } | { action: 'skip', reason }
 */
function planSignedStamp(ctx) {
  ctx = ctx || {};
  const event = String(ctx.event || '');
  if (SIGN_EVENTS.indexOf(event) === -1) return { action: 'skip', reason: 'not_a_signing_event' };
  const lead = ctx.lead || null;
  if (!lead) return { action: 'skip', reason: 'no_lead' };
  const est = ctx.est || null;
  if (!est || _isDeleted(est) || !ctx.estimateId) return { action: 'skip', reason: 'no_estimate' };
  if (!_sameTenant(est, lead, ctx.leadId)) return { action: 'skip', reason: 'estimate_other_tenant' };
  const sourceId = String(ctx.sourceId || '').slice(0, 140);
  const prev = est.signedPrice && typeof est.signedPrice === 'object' ? est.signedPrice : null;
  if (prev && sourceId && prev.sourceId === sourceId) return { action: 'skip', reason: 'already_stamped' };
  // A replayed event (the spine's marker already existed) never overwrites a
  // price another signature stamped since.
  if (prev && ctx.duplicate) return { action: 'skip', reason: 'duplicate' };
  if (event === 'deal_accepted' && _acceptanceNotApplied(est)) return { action: 'skip', reason: 'acceptance_not_applied' };

  const env = ctx.envelope;
  const fromEnvelope = !!(env && env.kind === 'estimate' && env.estimateId === ctx.estimateId
    && env.pricedSnapshot && typeof env.pricedSnapshot === 'object');
  // A remote (HTML) contract: the price snapshot createSignRequest took of
  // this estimate when the link was sent (money review 2026-11-14, finding 8)
  // — what the homeowner was shown, even if the estimate moved since.
  const sr = ctx.signRequest;
  const fromSignRequest = !fromEnvelope && !!(sr && sr.estimateId === ctx.estimateId
    && sr.fields && typeof sr.fields === 'object');
  // Newest offer wins (review H1, 2026-11-14): a link minted before the
  // current signed price was offered (its own mint, or its signing) never
  // overwrites it — an older $10,000 link signed after a $12,000 one would
  // otherwise lower the price under a $12,000 deposit draft. A snapshot with
  // no mint time can't prove it is newer, so it does not overwrite either.
  if (fromSignRequest && prev) {
    const prevOffer = Number(prev.mintedAtMs) || Number(prev.at) || 0;
    const mine = Number(sr.mintedAtMs) || 0;
    if (prevOffer && (!mine || mine < prevOffer)) return { action: 'skip', reason: 'older_than_current' };
  }
  const fields = fromEnvelope ? env.pricedSnapshot : fromSignRequest ? sr.fields : CER.signedPriceSnapshot(est);
  const totalCents = cents(CER.estimateValue(fields));
  if (!(totalCents > 0)) return { action: 'skip', reason: 'no_total' };
  const fingerprint = CER.pricedFingerprint(fields);
  const signedPrice = {
    fields,
    fingerprint,
    totalCents,
    source: event,
    sourceId: sourceId || null,
    from: fromEnvelope ? 'envelope' : fromSignRequest ? 'sign_request' : 'estimate',
    at: Number(ctx.nowMs) || Date.now(),
  };
  if (fromSignRequest && Number(sr.mintedAtMs) > 0) signedPrice.mintedAtMs = Number(sr.mintedAtMs);
  // The estimate was re-priced while the link was out: the snapshot (what
  // was signed) wins; record the estimate's price now so the rep is told.
  if (fromSignRequest && CER.pricedFingerprint(est) !== fingerprint) {
    signedPrice.movedSinceSent = true;
    signedPrice.currentTotalCents = cents(CER.estimateValue(est));
  }
  return { action: 'stamp', estimateId: ctx.estimateId, signedPrice };
}

/**
 * The price snapshot a remote sign request carries (createSignRequest in
 * remote-signing.js): the priced fields of the estimate the contract bills
 * (the lead's primary), as it stands when the link is minted. Pure.
 * → { snapshot: { estimateId, fields, fingerprint, totalCents, mintedAtMs }, reason: null }
 *   | { snapshot: null, reason } — the link goes out with no locked price.
 */
function signRequestSnapshot(leadId, lead, est, estimateId, nowMs) {
  const no = (reason) => ({ snapshot: null, reason });
  if (!lead) return no('no_lead');
  if (typeof estimateId !== 'string' || !ID_RE.test(estimateId)) return no('no_primary_estimate');
  if (!est || _isDeleted(est)) return no('no_estimate');
  if (!_sameTenant(est, lead, leadId)) return no('estimate_other_tenant');
  const fields = CER.signedPriceSnapshot(est);
  const totalCents = cents(CER.estimateValue(fields));
  if (!(totalCents > 0)) return no('no_total');
  return { snapshot: { estimateId, fields, fingerprint: CER.pricedFingerprint(fields), totalCents, mintedAtMs: Number(nowMs) || Date.now() }, reason: null };
}

// Why a price was not locked, in the rep's words.
const NOT_LOCKED_WHY = {
  no_primary_estimate: 'the customer has no primary estimate',
  no_estimate: 'the contract\'s estimate could not be found on this customer',
  estimate_other_tenant: 'the contract\'s estimate could not be found on this customer',
  no_total: 'the estimate has no total',
  acceptance_not_applied: 'the accepted package has not been applied to the estimate yet',
  older_than_current: 'an older contract link was signed after a newer one, so the newer signed price was kept',
  read_failed: 'the estimate could not be read',
  error: 'a server error',
};
// Skips that are not a problem: a replay, or nothing to do.
const QUIET_SKIPS = ['already_stamped', 'duplicate', 'not_a_signing_event', 'bad_lead_id', 'no_lead'];
const usd = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Tell the rep (review, silent failures 2026-11-14): a bell, a line on the
 * lead's activity feed and, for a lock that failed, a flag on the estimate.
 * Two independent writes so one failing is not the only record. Never throws.
 *   kind 'not_locked' { reason } | 'moved' { totalCents, currentTotalCents }
 */
async function _tellRep(db, a, deps) {
  const logger = deps.logger;
  const FV = deps.FieldValue || require('firebase-admin/firestore').FieldValue;
  try {
    let lead = a.lead;
    if (!lead) { const ls = await db.collection('leads').doc(a.leadId).get(); lead = ls.exists ? (ls.data() || {}) : null; }
    if (!lead || !lead.userId) return;
    const estimateId = a.estimateId || (typeof lead.primaryEstimateId === 'string' && ID_RE.test(lead.primaryEstimateId) ? lead.primaryEstimateId : null);
    let title, label, type;
    if (a.kind === 'moved') {
      type = 'signed_price_moved';
      title = 'Signed price differs from the estimate';
      label = 'Signed at ' + usd(a.totalCents) + '; the estimate now says ' + usd(a.currentTotalCents)
        + '. Bills use the signed ' + usd(a.totalCents) + ' until the homeowner re-signs.';
    } else if (a.reason === 'older_than_current') {
      type = 'price_not_locked';
      title = 'An older contract was signed — price kept';
      label = 'The homeowner signed ' + NOT_LOCKED_WHY.older_than_current + '. Check which contract they meant to sign.';
    } else {
      type = 'price_not_locked';
      title = 'Signed, but the price was not locked';
      label = 'The contract is signed, but its price was not locked (' + (NOT_LOCKED_WHY[a.reason] || a.reason)
        + '). Bills follow the estimate as saved — check it before you invoice.';
    }
    const writes = [
      db.collection('leads').doc(a.leadId).collection('activity').add({
        userId: lead.userId, type, label, estimateId: estimateId || null, reason: a.reason || null,
        sourceId: a.sourceId || null, createdAt: FV.serverTimestamp(),
      }),
    ];
    if (a.kind !== 'moved') {
      writes.push(db.collection('notifications').add({
        userId: lead.userId, type, leadId: a.leadId, title, message: label, priority: 'high', read: false, createdAt: FV.serverTimestamp(),
      }));
      // The flag goes only on THIS tenant's estimate (never on the other
      // tenant's doc an estimate_other_tenant skip points at).
      if (estimateId && a.reason !== 'older_than_current' && a.reason !== 'estimate_other_tenant') {
        writes.push((async () => {
          const ref = db.collection('estimates').doc(estimateId);
          const es = await ref.get();
          const est = es.exists ? (es.data() || {}) : null;
          if (!est || _isDeleted(est) || !_sameTenant(est, lead, a.leadId)) return;
          await ref.update({ priceLockIssue: { reason: a.reason, event: a.event || null, sourceId: a.sourceId || null, at: Number(a.nowMs) || Date.now() } });
        })());
      }
    }
    const res = await Promise.allSettled(writes);
    res.forEach((r) => { if (r.status === 'rejected') logger.warn('[signedPrice] rep alert write failed', { leadId: a.leadId, type, err: r.reason && r.reason.message }); });
  } catch (e) {
    logger.warn('[signedPrice] rep alert failed', { leadId: a.leadId, err: e && e.message });
  }
}

/**
 * Stamp the signed price after a signature. One transaction; never throws
 * (the caller is the job spine, whose event already counted).
 * @param db Firestore (admin)
 * @param args { leadId, event, sourceId, meta, duplicate }
 * @returns {Promise<{ stamped: boolean, estimateId?: string, reason?: string, totalCents?: number }>}
 */
async function stampSignedPrice(db, args, deps) {
  deps = deps || {};
  let logger = deps.logger;
  if (!logger) { try { logger = require('firebase-functions/v2').logger; } catch (_) { logger = console; } }
  const now = deps.now || (() => Date.now());
  args = args || {};
  const leadId = typeof args.leadId === 'string' ? args.leadId.trim() : '';
  const event = String(args.event || '');
  const sourceId = args.sourceId != null ? String(args.sourceId) : '';
  const meta = (args.meta && typeof args.meta === 'object') ? args.meta : {};
  if (SIGN_EVENTS.indexOf(event) === -1) return { stamped: false, reason: 'not_a_signing_event' };
  if (!db || !ID_RE.test(leadId)) return { stamped: false, reason: 'bad_lead_id' };
  const dealId = event === 'deal_accepted'
    ? String(meta.dealId || (sourceId.startsWith('deal_') ? sourceId.slice(5) : '') || '') : '';
  const envelopeId = String(meta.envelopeId || (sourceId.startsWith('env_') ? sourceId.slice(4) : '') || '');
  // A remote contract's price snapshot, handed over by the job spine from the
  // admin-only sign token (never from a client): { estimateId, fields, ... }.
  const sr = meta.signRequestPrice;
  const signRequest = (sr && typeof sr === 'object' && sr.fields && typeof sr.fields === 'object'
    && typeof sr.estimateId === 'string' && ID_RE.test(sr.estimateId)) ? sr : null;
  try {
    const out = await db.runTransaction(async (tx) => {
      const ls = await tx.get(db.collection('leads').doc(leadId));
      const lead = ls.exists ? (ls.data() || {}) : null;
      if (!lead) return { stamped: false, reason: 'no_lead' };
      let deal = null;
      if (dealId && ID_RE.test(dealId)) {
        const ds = await tx.get(db.collection('deal_rooms').doc(dealId));
        deal = ds.exists ? (ds.data() || {}) : null;
        if (deal && deal.leadId && deal.leadId !== leadId) deal = null;
      }
      let envelope = null;
      if (envelopeId && /^[A-Za-z0-9_-]{1,64}$/.test(envelopeId)) {
        const es = await tx.get(db.collection('esign_envelopes').doc(envelopeId));
        envelope = es.exists ? (es.data() || {}) : null;
        if (envelope && envelope.leadId && envelope.leadId !== leadId) envelope = null;
      }
      const estimateId = signedEstimateIdFor(lead, deal, envelope, signRequest);
      if (!estimateId) return { stamped: false, reason: 'no_estimate' };
      const estRef = db.collection('estimates').doc(estimateId);
      const es = await tx.get(estRef);
      const est = es.exists ? (es.data() || {}) : null;
      const plan = planSignedStamp({ leadId, lead, est, estimateId, event, sourceId, envelope, signRequest, duplicate: !!args.duplicate, nowMs: now() });
      if (plan.action !== 'stamp') return { stamped: false, reason: plan.reason, estimateId, lead };
      // A lock that lands clears an earlier "not locked" flag.
      tx.update(estRef, Object.assign({ signedPrice: plan.signedPrice },
        est && est.priceLockIssue ? { priceLockIssue: (deps.FieldValue || require('firebase-admin/firestore').FieldValue).delete() } : {}));
      const res = { stamped: true, estimateId, totalCents: plan.signedPrice.totalCents, from: plan.signedPrice.from, lead };
      if (plan.signedPrice.movedSinceSent) Object.assign(res, { movedSinceSent: true, currentTotalCents: plan.signedPrice.currentTotalCents });
      return res;
    });
    const lead = out.lead; delete out.lead;
    logger.info('[signedPrice] ' + (out.stamped ? 'stamped' : 'not stamped'), { leadId, event, sourceId, estimateId: out.estimateId || null, reason: out.reason || null, totalCents: out.totalCents || null });
    if (out.movedSinceSent) {
      logger.warn('[signedPrice] estimate re-priced while the sign link was out — billing the signed snapshot', { leadId, estimateId: out.estimateId, signedCents: out.totalCents, currentCents: out.currentTotalCents });
      await _tellRep(db, { kind: 'moved', leadId, lead, estimateId: out.estimateId, sourceId, event, totalCents: out.totalCents, currentTotalCents: out.currentTotalCents, nowMs: now() }, Object.assign({}, deps, { logger }));
    } else if (!out.stamped && QUIET_SKIPS.indexOf(out.reason) === -1) {
      await _tellRep(db, { kind: 'not_locked', leadId, lead, estimateId: out.estimateId, sourceId, event, reason: out.reason, nowMs: now() }, Object.assign({}, deps, { logger }));
    }
    return out;
  } catch (e) {
    logger.warn('[signedPrice] stamp failed', { leadId, event, sourceId, err: e && e.message });
    await _tellRep(db, { kind: 'not_locked', leadId, sourceId, event, reason: 'error', nowMs: now() }, Object.assign({}, deps, { logger }));
    return { stamped: false, reason: 'error', error: String((e && e.message) || e) };
  }
}

/**
 * The portal's estimate card money (portal.js getHomeownerPortalView): the
 * SIGNED price once there is one, so "✓ Signed" never sits beside a
 * re-priced total. While a revision is out for a new signature (sent /
 * viewed) the card shows the revision — that is what they are asked to sign.
 */
function portalPriced(est) {
  if (!est) return est;
  if (est.signatureStatus === 'sent' || est.signatureStatus === 'viewed') return est;
  return CER.signedView(est);
}

// ── R6-2-5: a stale deal-room price ─────────────────────────────────────

/**
 * The prices the SERVER can vouch for on this estimate, per package (dollars):
 * every tier of a tier-priced estimate (per-SQ / prices{}), and the
 * estimate's own tier at its total. A line-item estimate's other tiers were
 * priced in the builder at send time and can't be re-derived here.
 */
function knownTierPrices(est) {
  const out = {};
  if (!est) return out;
  const prices = (est.prices && typeof est.prices === 'object') ? est.prices : null;
  if (prices) {
    TIERS.forEach((t) => {
      const v = prices[t];
      const n = (v && typeof v === 'object') ? Number(v.grandTotal != null ? v.grandTotal : v.total) : Number(v);
      if (Number.isFinite(n) && n > 0) out[t] = Math.round(n * 100) / 100;
    });
  }
  const chosen = String(est.selectedTier || est.tier || '').toLowerCase();
  const total = CER.estimateValue(est);
  if (TIERS.indexOf(chosen) !== -1 && total > 0 && CER.tierApplies(est) !== false) out[chosen] = Math.round(total * 100) / 100;
  // A line-item estimate's stored per-tier builds (review R6-2-3,
  // deal-accepted-tier.js): the builder priced those tiers at this version,
  // so a page offering a different price for one is stale too.
  const offer = require('./deal-accepted-tier').offerableTierPrices(est);
  if (offer) Object.keys(offer).forEach((t) => { if (out[t] == null) out[t] = offer[t]; });
  return out;
}

/**
 * May the homeowner accept `tier` at the price the page offered? Pure.
 *   o = { est, tier, offeredPrice, issuedFingerprint?, confirmPrice? }
 * → { ok: true, price, changedFrom? }
 *   | { ok: false, code: 'price_changed', tierPrice: number|null, currentPrices }
 * Stale = the estimate's price version moved since the link was issued, or
 * the server knows this package's price and it is not the page's. A stale
 * acceptance goes through only at the current price, confirmed.
 */
function checkDealPrice(o) {
  o = o || {};
  const est = o.est;
  if (!est || _isDeleted(est)) return { ok: true, price: Number(o.offeredPrice) };
  const current = knownTierPrices(est);
  const offered = Number(o.offeredPrice);
  const versionMoved = !!o.issuedFingerprint && o.issuedFingerprint !== CER.pricedFingerprint(est);
  const known = current[o.tier] != null ? current[o.tier] : null;
  const priceMoved = known != null && cents(known) !== cents(offered);
  if (!versionMoved && !priceMoved) return { ok: true, price: offered };
  const confirm = o.confirmPrice == null || o.confirmPrice === '' ? null : Number(o.confirmPrice);
  if (known != null && confirm != null && Number.isFinite(confirm) && cents(confirm) === cents(known)) {
    return { ok: true, price: known, changedFrom: offered };
  }
  return { ok: false, code: 'price_changed', tierPrice: known, currentPrices: current };
}

module.exports = {
  SIGN_EVENTS, signedEstimateIdFor, planSignedStamp, stampSignedPrice, signRequestSnapshot,
  portalPriced, knownTierPrices, checkDealPrice,
};
