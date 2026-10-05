/**
 * lead-cap.js — meterLeadCreate: the SERVER meter behind the plan lead cap
 * (2026-10-04, tenant-ready). Rules and the reasoning: lead-cap-logic.js.
 *
 * Fires on every new leads/{id}. Only CLIENT-created leads carry `meter`
 * (firestore.rules require it on a client create); web-form, referral and
 * SMS leads made by the server carry none and are skipped — exactly as they
 * were never counted before. NBD's own company is never metered.
 */
'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const L = require('./lead-cap-logic');
const { _test: { PLAN_LIMITS } } = require('./billing');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

async function meterOne(db, lead, now) {
  const meter = lead && lead.meter;
  if (!L.METERS.includes(meter)) return { skipped: 'unmetered' };
  const companyId = (lead && typeof lead.companyId === 'string' && lead.companyId) || '';
  if (!companyId) return { skipped: 'no-company' };
  if (companyId === NBD_OWNER_UID) return { skipped: 'platform' };
  const ref = db.doc(`subscriptions/${companyId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const sub = snap.exists ? (snap.data() || {}) : null;
    const out = L.meterPatch(sub, meter, now, PLAN_LIMITS);
    const patch = Object.assign({}, out.patch, {
      leadCap: out.patch.leadCap ? out.patch.leadCap : FieldValue.delete(),
      lastUsageAt: FieldValue.serverTimestamp(),
    });
    if (!snap.exists) {
      // A company with no subscription doc meters as Free (createCompany
      // seeds this same shape; a legacy tenant may predate the seed).
      patch.plan = 'free';
      patch.status = 'none';
      patch.source = 'lead-meter';
    }
    tx.set(ref, patch, { merge: true });
    return out;
  });
}

exports.meterLeadCreate = onDocumentCreated({ document: 'leads/{leadId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, maxInstances: 20 }, async (event) => {
  const lead = event.data && event.data.data();
  if (!lead) return;
  try {
    const out = await meterOne(getFirestore(), lead, new Date());
    if (out && out.blocked) logger.info('lead_cap_reached', { companyId: lead.companyId, plan: out.plan });
  } catch (e) {
    logger.error('meterLeadCreate failed', { leadId: event.params && event.params.leadId, err: e && e.message });
  }
});

exports._test = { meterOne, NBD_OWNER_UID };
