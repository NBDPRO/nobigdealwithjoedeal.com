/**
 * functions/pro-prospects.js — NBD Pro prospects from the free playbook form
 * (2026-10-16). Pure rules: pro-prospects-logic.js.
 *
 *   onGuideLeadCreated     Firestore  guide_leads/{id} created → an alert
 *                                     email to Jo (email_queue, deterministic
 *                                     id so a retried trigger never sends
 *                                     twice). Internal mail only.
 *   adminListProProspects  onCall     Platform admin only (role 'admin' claim
 *                                     or the NBD owner uid): the newest guide
 *                                     requests for /admin/tenants.html.
 *
 * Before this, guide_leads had no reader at all: no alert, no admin list, no
 * email (site-docs audit 2026-10-16, P0-1). Prospects stay OUT of the
 * homeowner pipeline (lead-bridge never bridges guide_leads).
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { CORS_ORIGINS } = require('./handlers/_shared');
const { callableRateLimit } = require('./shared');
const P = require('./pro-prospects-logic');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const PLATFORM_ALERT_EMAIL = process.env.PLATFORM_ALERT_EMAIL || 'jd@nobigdealwithjoedeal.com';
const DAY_MS = 24 * 60 * 60 * 1000;

async function alertAllowed() {
  try {
    await require('./rate-limit').enforceRateLimit('proProspect:alertDay', 'nbd', P.ALERT_DAILY_CAP, DAY_MS);
    return true;
  } catch (e) {
    if (e && e.rateLimited) return false;
    return true; // limiter outage: fail OPEN, Jo still hears about it
  }
}

async function handleGuideLead(db, leadId, lead, opts) {
  const o = opts || {};
  const allowed = typeof o.alertAllowed === 'function' ? await o.alertAllowed() : await alertAllowed();
  if (!allowed) {
    logger.warn('onGuideLeadCreated: daily alert cap reached — stored, not alerted', { leadId });
    return { alerted: false, reason: 'cap' };
  }
  const mail = P.prospectAlertEmail(lead, leadId);
  try {
    await db.doc('email_queue/pro-prospect-alert-' + leadId).create(Object.assign({
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      to: PLATFORM_ALERT_EMAIL,
      source: 'pro_prospect_alert',
    }, mail));
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) return { alerted: false, reason: 'duplicate' };
    throw e;
  }
  await db.doc('guide_leads/' + leadId).set({ prospectAlertedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { alerted: true };
}

exports.onGuideLeadCreated = onDocumentCreated({ document: 'guide_leads/{leadId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 }, async (event) => {
  const lead = event.data && event.data.data();
  if (!lead) return;
  try {
    await handleGuideLead(getFirestore(), event.params.leadId, lead);
  } catch (e) {
    logger.error('onGuideLeadCreated failed', { leadId: event.params.leadId, err: e && e.message });
  }
});

exports.adminListProProspects = onCall({ region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const t = request.auth.token || {};
  const platform = t.role === 'admin' || request.auth.uid === NBD_OWNER_UID;
  if (!platform) throw new HttpsError('permission-denied', 'Platform admin only');
  await callableRateLimit(request, 'adminListProProspects', 60, 3_600_000);
  const snap = await getFirestore().collection('guide_leads').orderBy('createdAt', 'desc').limit(200).get();
  return { prospects: snap.docs.map((d) => P.prospectRow(d.id, d.data())), generatedAt: new Date().toISOString() };
});

exports._test = { handleGuideLead };
