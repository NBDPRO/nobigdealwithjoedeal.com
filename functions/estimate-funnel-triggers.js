/**
 * functions/estimate-funnel-triggers.js — the two estimate_leads UPDATE
 * triggers for the /estimate step-1 save (2026-11-14).
 *
 * The funnel saves the lead at step 1 (a create: lead-bridge makes the CRM card,
 * lead-alert pages Joe "started, not finished") and later UPDATES that same
 * doc when step 1 changes or the homeowner finishes (estimate-funnel.js,
 * through submitPublicLead). Create triggers never see an update, so:
 *
 *   leadAlertEstimateFinished — started → completed: tell Joe they finished
 *     (and, on the OTP-skip path, that they asked for a call). Never a
 *     homeowner message (ack:false); a lead the intake guard marked duplicate
 *     or over the daily cap stays quiet. No retry: a redelivery must not page
 *     Joe twice.
 *   leadBridgeEstimateUpdate — re-apply the CRM-card patch submitPublicLead
 *     made inline (consent changes, contact fields, the finish), so a failed
 *     inline write still reaches the card the CRM's send gates read. The patch
 *     is idempotent; retry:true, and a missing card throws so the event is
 *     redelivered once the bridge has made it.
 *
 * Kept out of lead-alert.js / lead-bridge.js on purpose: those are create-only
 * modules, and many suites load them with a create-only trigger stub.
 * Each export is a literal onDocumentUpdated(...) call: the deploy allowlist
 * (.github/workflows/firebase-deploy.yml) greps for exactly that shape.
 */
'use strict';

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const EstimateFunnel = require('./estimate-funnel');

const BASE_OPTS = { region: 'us-central1', maxInstances: 10, memory: '256MiB', timeoutSeconds: 30 };

function snapData(event, side) {
  const s = event && event.data && event.data[side];
  return s && typeof s.data === 'function' ? (s.data() || {}) : {};
}

exports.leadAlertEstimateFinished = onDocumentUpdated(
  Object.assign({}, BASE_OPTS, { secrets: require('./lead-alert')._internal.SECRETS, document: 'estimate_leads/{leadId}' }),
  async (event) => {
    const before = snapData(event, 'before');
    const after = snapData(event, 'after');
    const leadId = event.params && event.params.leadId;
    const plan = EstimateFunnel.finishAlertPlan(before, after);
    if (!plan) return;
    if (!plan.alert) { logger.info('leadAlertEstimateFinished: suppressed at intake', { leadId, reason: plan.reason }); return; }
    await require('./lead-alert')._internal.alertJoe('estimate_leads', after, leadId, plan.opts);
  }
);

exports.leadBridgeEstimateUpdate = onDocumentUpdated(
  Object.assign({}, BASE_OPTS, { retry: true, document: 'estimate_leads/{leadId}' }),
  async (event) => {
    const leadId = event.params && event.params.leadId;
    const out = await EstimateFunnel.syncCardFromUpdate(getFirestore(), leadId, snapData(event, 'before'), snapData(event, 'after'), { FieldValue });
    if (out === 'no_card') {
      logger.warn('leadBridgeEstimateUpdate: no CRM card yet for a changed started estimate — will retry', { leadId });
      throw new Error('no CRM card yet for estimate_leads/' + leadId);
    }
    if (out === 'synced') logger.info('leadBridgeEstimateUpdate: card synced', { leadId });
  }
);
