/**
 * functions/lead-bridge.js — public lead → CRM pipeline bridge (Phase C, H-1).
 * ═══════════════════════════════════════════════════════════════
 *
 * Fixes the live-QA H-1 finding: public-form submissions land in the
 * per-kind public collections (contact_leads / estimate_leads /
 * inspect_leads / free_roof_entries) but never reached the CRM `leads`
 * pipeline, so the owner had to re-enter them by hand from the alert email.
 *
 * These onCreate triggers mirror each high-intent public lead into the
 * tenant's `leads` collection so it shows up in the pipeline (stage "New",
 * source "Website — …"). Purely ADDITIVE — runs alongside lead-alert.js
 * (which still emails/texts) and does NOT touch submitPublicLead or the
 * public collections. A bridge failure never blocks intake or the alert.
 *
 * Routing is tenant-aware: the lead's validated companyId resolves to that
 * tenant's owner (companies/{companyId}.ownerId). NBD's main forms pass no
 * companyId → the lead is mirrored to the tenant-zero owner (Joe), so NBD
 * is byte-identical. Writes go through the admin SDK (bypasses rules) since
 * a public submit has no authenticated user.
 *
 * Idempotent: the mirrored doc uses a deterministic id derived from the
 * source (collection + source doc id), so a re-delivered trigger create()s
 * a no-op instead of a duplicate lead.
 */

'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
// Modular FieldValue import — FieldValue is undefined under
// the emulator runtime (see emulator-qa notes); the modular path works in
// both prod and emulator.
const { FieldValue } = require('firebase-admin/firestore');

const L = require('./lead-bridge-logic');
const { createLeadWithCustomerId } = require('./customer-id-mint');

// Tenant-zero (NBD) owner uid — Joe / jonathandeal459@gmail.com. Matches the
// uid in set-jd-claims.js (companyId == uid solo convention). Overridable via
// env for emulator/test runs. Public NBD forms pass no companyId, so an
// untagged lead mirrors to this owner — byte-identical to today's NBD.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

const BRIDGE_COLLECTIONS = Object.keys(L.BRIDGE_KINDS);

async function bridgeToCrm(collection, data, sourceId) {
  data = data || {};
  const db = getFirestore();

  // Estimator follow-up events (results/CTA/email-request) are enrichment
  // on an already-bridged lead, not new leads — without this skip a single
  // completed funnel mirrored up to 4 duplicate pipeline cards.
  if (L.isFollowUpEvent(collection, data)) {
    logger.info('leadBridge: follow-up event doc — not a new lead, skipping', { collection, sourceId, type: data.type });
    return;
  }

  // Resolve the lead's tenant owner. companyId was validated against the
  // companies registry by submitPublicLead before it was stamped.
  const companyId = data.companyId ? String(data.companyId) : '';
  let companyDoc = null;
  if (companyId) {
    try {
      const snap = await db.collection('companies').doc(companyId).get();
      companyDoc = snap.exists ? (snap.data() || {}) : null;
    } catch (e) {
      logger.error('leadBridge: company lookup failed', { companyId, err: e && e.message });
    }
  }

  const target = L.resolveBridgeTarget(companyId, companyDoc, { nbdOwnerUid: NBD_OWNER_UID });
  if (!target) {
    // Known tenant but no resolvable owner (e.g. companies/{id}.ownerId
    // unset). Never guess an owner — leave the public lead + alert as-is.
    logger.warn('leadBridge: no owner resolvable — skipping CRM mirror', { collection, sourceId, companyId });
    return;
  }

  const id = L.bridgeDocId(collection, sourceId);
  const leadDoc = L.mapPublicLeadToLead({
    collection, sourceId, data,
    ownerUid: target.ownerUid,
    companyId: target.companyId,
  });
  leadDoc.createdAt = FieldValue.serverTimestamp();
  leadDoc.stageStartedAt = FieldValue.serverTimestamp();

  try {
    // create() (not set()) so a re-delivery hits ALREADY_EXISTS instead of
    // overwriting a lead the rep may have already edited. The customerId is
    // minted in the same transaction (customer-id-mint.js) — failure-tolerant.
    const { customerId } = await createLeadWithCustomerId(db, db.collection('leads').doc(id), leadDoc, { nbdOwnerUid: NBD_OWNER_UID });
    logger.info('leadBridge: mirrored public lead into CRM', {
      collection, sourceId, leadId: id, companyId: target.companyId, ownerUid: target.ownerUid, customerId,
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) {
      logger.info('leadBridge: CRM lead already exists — idempotent skip', { collection, sourceId, leadId: id });
    } else {
      logger.error('leadBridge: CRM mirror failed', { collection, sourceId, err: e && e.message });
    }
  }
}

const TRIGGER_OPTS = {
  region: 'us-central1',
  maxInstances: 10,
  memory: '256MiB',
  timeoutSeconds: 30,
};

function onLeadCreated(collection) {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    await bridgeToCrm(collection, snap.data() || {}, event.params && event.params.leadId);
  };
}

// Storm bridge — CONDITIONAL. Most storm signups are a marketing list (the
// 'hail' default), so we only mirror the deliberate high-intent concerns
// (insurance / wind / general) into the pipeline. Mirrors onStormAlert's gate
// in lead-alert.js via the same shared HIGH_INTENT_STORM_CONCERNS set, so the
// lead that pages Joe is the same lead that lands in his pipeline.
function onStormBridge() {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() || {};
    if (!L.shouldBridgeStorm(data)) {
      logger.info('leadBridge: storm signup is list-only (no high-intent concern) — not bridging', { concern: data.concern });
      return;
    }
    await bridgeToCrm('storm_alert_subscribers', data, event.params && event.params.leadId);
  };
}

// Thumbtack bridge — CONDITIONAL on the payload not being a test delivery.
// Thumbtack's "Test this webhook" button fires a tagged test lead at every
// enabled webhook on the profile. Storing it is useful (the delivery is
// auditable in thumbtack_leads); mirroring it into the pipeline is not — a test
// card is indistinguishable from a real one once you're looking at the kanban,
// and Joe would chase a customer who doesn't exist.
function onThumbtackBridge() {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() || {};
    if (data.isTest) {
      logger.info('leadBridge: Thumbtack test delivery — stored, not bridged', {
        sourceId: event.params && event.params.leadId,
      });
      return;
    }
    await bridgeToCrm('thumbtack_leads', data, event.params && event.params.leadId);
  };
}

// IMPORTANT: each export assigns onDocumentCreated(...) DIRECTLY (not via a
// makeTrigger() wrapper). The CI auto-deploy builds its --only allowlist by
// grepping `^exports.<name> = (onRequest|onCall|onDocumentCreated|...)` in
// .github/workflows/firebase-deploy.yml. A `= makeTrigger(...)` RHS does NOT
// match, so a wrapper-exported trigger is silently dropped from the deploy
// (the same latent gap that quietly keeps lead-alert.js's makeTrigger exports
// off the CI auto-deploy — they only ship via a manual full `firebase deploy`).
// Keep the RHS a literal factory call so a push to main actually deploys these.
exports.leadBridgeContact  = onDocumentCreated({ ...TRIGGER_OPTS, document: 'contact_leads/{leadId}' },     onLeadCreated('contact_leads'));
exports.leadBridgeEstimate = onDocumentCreated({ ...TRIGGER_OPTS, document: 'estimate_leads/{leadId}' },    onLeadCreated('estimate_leads'));
exports.leadBridgeInspect  = onDocumentCreated({ ...TRIGGER_OPTS, document: 'inspect_leads/{leadId}' },      onLeadCreated('inspect_leads'));
exports.leadBridgeFreeRoof = onDocumentCreated({ ...TRIGGER_OPTS, document: 'free_roof_entries/{leadId}' }, onLeadCreated('free_roof_entries'));
exports.leadBridgeStorm    = onDocumentCreated({ ...TRIGGER_OPTS, document: 'storm_alert_subscribers/{leadId}' }, onStormBridge());
exports.leadBridgeThumbtack = onDocumentCreated({ ...TRIGGER_OPTS, document: 'thumbtack_leads/{leadId}' }, onThumbtackBridge());

// Exposed for tests / wiring sanity.
exports._bridgeCollections = BRIDGE_COLLECTIONS;
