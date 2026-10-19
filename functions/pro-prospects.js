/**
 * functions/pro-prospects.js — NBD Pro prospects from the free playbook form
 * (2026-10-16). Pure rules: pro-prospects-logic.js.
 *
 *   onGuideLeadCreated     Firestore  guide_leads/{id} created →
 *                                     1. an alert email to Jo (email_queue,
 *                                        deterministic id so a retried trigger
 *                                        never sends twice). Internal mail.
 *                                     2. ONE welcome email to the contractor
 *                                        with the playbook link (and the PDF
 *                                        once it is published). Commercial:
 *                                        gated by email-suppression.js
 *                                        (unsubscribe register, postal
 *                                        address, one-click headers).
 *   adminListProProspects  onCall     Platform admin only (role 'admin' claim
 *                                     or the NBD owner uid): the newest guide
 *                                     requests for /admin/tenants.html.
 *
 * Before 2026-10-16, guide_leads had no reader at all: no alert, no admin
 * list, no email (site-docs audit, P0-1). Prospects stay OUT of the homeowner
 * pipeline (lead-bridge never bridges guide_leads).
 *
 * Abuse limits on the welcome email (it goes to an address a visitor TYPED):
 * one per destination inbox per 24h (alert-recipients.capRecipients), a fixed
 * body with only a one-word greeting name echoed (safeGreetingName), and the
 * per-IP limit already on submitPublicLead.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const MessagingControls = require('./messaging-controls');
const { CORS_ORIGINS } = require('./handlers/_shared');
const { callableRateLimit } = require('./shared');
const P = require('./pro-prospects-logic');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const PLATFORM_ALERT_EMAIL = process.env.PLATFORM_ALERT_EMAIL || 'jd@nobigdealwithjoedeal.com';
const REPLY_TO = 'jd@nobigdealwithjoedeal.com';
const DAY_MS = 24 * 60 * 60 * 1000;
const WELCOME_RECIPIENT_DAILY_CAP = 1;

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
    }, mail, {
      // After `mail` so nothing in it can ever redirect the alert (email-queue-recipients test pins this).
      to: PLATFORM_ALERT_EMAIL,
      source: 'pro_prospect_alert',
    }));
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) return { alerted: false, reason: 'duplicate' };
    throw e;
  }
  await db.doc('guide_leads/' + leadId).set({ prospectAlertedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { alerted: true };
}

// Is the printable PDF published yet? A HEAD on the public URL, 3s max. Any
// doubt = no PDF line (the playbook link is always there).
async function pdfPublished(fetchImpl) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return false;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), 3000) : null;
  try {
    const r = await f(P.PLAYBOOK_PDF_URL, { method: 'HEAD', redirect: 'manual', signal: ctrl ? ctrl.signal : undefined });
    const type = String((r && r.headers && r.headers.get && r.headers.get('content-type')) || '').toLowerCase();
    return !!(r && r.status === 200 && type.indexOf('application/pdf') !== -1);
  } catch (_) {
    return false;
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * Send the one welcome email. Every outcome is stamped on the guide lead
 * (welcomeEmailedAt / welcomeSkipped) so Jo can see it on the admin list.
 * deps: { resend, from, gate, capRecipients, pdfReady, serverTimestamp }
 */
async function sendWelcome(db, leadId, lead, deps) {
  const d = deps || {};
  const plan = P.welcomePlan(lead);
  if (!plan.send) return { sent: false, reason: plan.reason };
  const ref = db.doc('guide_leads/' + leadId);
  const ts = d.serverTimestamp || (() => FieldValue.serverTimestamp());
  const skip = async (reason) => { await ref.set({ welcomeSkipped: reason }, { merge: true }); return { sent: false, reason }; };

  // The owner's pause is checked BEFORE the claim, and stamped (welcomeSkipped) so the admin list shows
  // this one needs a manual send.
  {
    const sw = await MessagingControls.channelStatus(db, 'email');
    if (!sw.allowed) return skip('held_messaging_paused');
    // Canary: do not consume the one-shot claim on a redirect (nothing is claimed, stamped or sent).
    if (sw.canary) return { sent: false, reason: 'canary_not_claimed' };
  }

  // Claim first: triggers are at-least-once, so a redelivery is a no-op.
  let claimed = false;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return false;
      const cur = fresh.data() || {};
      if (cur.welcomeClaimedAt || cur.welcomeEmailedAt) return false;
      tx.update(ref, { welcomeClaimedAt: ts() });
      return true;
    });
  } catch (e) {
    logger.error('proWelcome: claim failed', { leadId, err: e && e.message });
    return { sent: false, reason: 'claim_failed' };
  }
  if (!claimed) return { sent: false, reason: 'claimed' };

  const email = String(lead.email).trim();
  const Suppression = require('./email-suppression');
  const gateArgs = [db, { companyId: NBD_OWNER_UID, email, leadId, source: 'pro-playbook-welcome' },
    { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: ts }];
  let gate;
  try {
    gate = d.gate ? await d.gate(...gateArgs) : await Suppression.gateCommercialEmail(...gateArgs);
  } catch (e) {
    logger.warn('proWelcome: suppression unverified — not sent', { leadId, err: e && e.message });
    return skip('suppression_unverified');
  }
  if (gate.suppressed) return skip('unsubscribed');
  if (gate.blocked) {
    logger.warn('proWelcome: no mailing address on the NBD Company Profile — not sent', { leadId });
    return skip('no_postal_address');
  }

  const firstName = require('./public-lead-guard').safeGreetingName(lead.name);
  const pdfReady = typeof d.pdfReady === 'function' ? await d.pdfReady() : await pdfPublished();
  const c = P.welcomeEmail({ firstName, pdfReady });
  const body = Suppression.applyFooter(gate, c.html, c.text);
  if (!d.resend) return skip('no_sender');
  try {
    // Email category: COMMERCIAL — delivers the requested playbook and mentions NBD Pro; gated above (email-suppression.js SEND_PATHS).
    const gated = await MessagingControls.guardEmail(db, {
      from: d.from, to: email, reply_to: REPLY_TO, subject: c.subject, html: body.html, text: body.text,
      headers: Object.assign({ 'X-NBD-Campaign': 'pro-playbook-welcome-v1' }, gate.headers), tags: gate.tags,
    });
    if (!gated.send) {
      // The pause landed AFTER the pre-check: nothing was sent, so release the claim and mark it held (a manual send).
      await ref.set({ welcomeClaimedAt: FieldValue.delete(), welcomeSkipped: 'held_messaging_paused' }, { merge: true });
      return { sent: false, reason: 'held_messaging_paused' };
    }
    if (gated.canary) {
      // Canary flipped on after the pre-check: nothing goes to the visitor. Release the claim; do not stamp emailed.
      await ref.set({ welcomeClaimedAt: FieldValue.delete(), welcomeSkipped: 'canary_redirect' }, { merge: true });
      return { sent: false, reason: 'canary_redirect' };
    }
    // The per-recipient welcome allowance is spent only now that the guard says this send is real, so a pause or
    // canary release never burns it (a later retry must not hit recipient_cap).
    const cap = d.capRecipients || require('./alert-recipients').capRecipients;
    const capR = await cap('proWelcome', [email], { limit: WELCOME_RECIPIENT_DAILY_CAP });
    if (!capR || !capR.allowed || !capR.allowed.length) return skip('recipient_cap');
    // Sent through the guarded client too (belt and braces: the guard is the one choke point for a customer send).
    const r = await MessagingControls.guardResend(db, d.resend).emails.send(gated.msg);
    const { resendRejected, resendErrorMessage } = require('./resend-guard');
    if (resendRejected(r)) throw new Error(resendErrorMessage(r));
    const id = (r && r.data && r.data.id) || (r && r.id) || null;
    await ref.set({ welcomeEmailedAt: ts(), welcomeEmailId: id, welcomePdf: pdfReady }, { merge: true });
    return { sent: true, id };
  } catch (e) {
    logger.error('proWelcome: send failed', { leadId, err: e && e.message });
    await ref.set({ welcomeSkipped: 'send_failed', welcomeError: String((e && e.message) || e).slice(0, 200) }, { merge: true });
    return { sent: false, reason: 'send_failed' };
  }
}

exports.onGuideLeadCreated = onDocumentCreated({ document: 'guide_leads/{leadId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, secrets: [RESEND_API_KEY, EMAIL_FROM] }, async (event) => {
  const lead = event.data && event.data.data();
  if (!lead) return;
  const db = getFirestore();
  const leadId = event.params.leadId;
  try {
    await handleGuideLead(db, leadId, lead);
  } catch (e) {
    logger.error('onGuideLeadCreated: alert failed', { leadId, err: e && e.message });
  }
  try {
    const { Resend } = require('resend');
    const { secretOr } = require('./integrations/_shared');
    await sendWelcome(db, leadId, lead, {
      resend: new Resend(RESEND_API_KEY.value()),
      from: secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com'),
    });
  } catch (e) {
    logger.error('onGuideLeadCreated: welcome failed', { leadId, err: e && e.message });
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

exports._test = { handleGuideLead, sendWelcome, pdfPublished, WELCOME_RECIPIENT_DAILY_CAP };
