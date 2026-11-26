/**
 * guideCopyEmail — "Email me this guide" on the homeowner guides (2026-11-26).
 * ═══════════════════════════════════════════════════════════════
 *
 * Firestore onCreate trigger on `guide_copy_requests`. The homeowner asked for
 * a copy of one guide; this sends ONE email with that guide's published PDF
 * attached (Resend fetches /guides/pdf/<slug>.pdf by URL).
 *
 * Same shape as storm-report-email.js:
 *   - No new endpoint: it fires only on a doc the gated, rate-limited
 *     submitPublicLead gateway created, and emails only the address on it.
 *   - Nothing typed is echoed: title, link and file come from the slug table
 *     in guide-copy-logic.js; an unknown slug sends nothing.
 *   - Idempotent: the doc is claimed (guideEmailedAt) in a transaction before
 *     sending, so a redelivered event is a no-op.
 *   - The owner's messaging kill switch and canary apply (MessagingControls).
 *   - Per-inbox cap (AR.capRecipients) so one address can't be flooded.
 *
 * Category: TRANSACTIONAL. The homeowner asked for this exact document, so it
 * is not gated by the unsubscribe register; it still prints the postal
 * address because it carries an inspection link, like the storm report.
 */
'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { Resend } = require('resend');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const MessagingControls = require('./messaging-controls');
const AR = require('./alert-recipients');
const Suppression = require('./email-suppression');
const G = require('./guide-copy-logic');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

exports.guideCopyEmail = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'guide_copy_requests/{reqId}',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 10,
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() || {};
    const reqId = event.params && event.params.reqId;
    const ref = snap.ref;

    if (!G.isGuideSlug(d.guide)) {
      logger.info('guideCopyEmail: skip — unknown guide', { reqId });
      return;
    }
    if (!G.isValidEmail(d.email)) {
      logger.info('guideCopyEmail: skip — no/invalid email', { reqId });
      return;
    }
    if (d.alertSuppressed === 'duplicate' || d.alertSuppressed === 'volume') {
      logger.info('guideCopyEmail: skip — suppressed at intake', { reqId, reason: d.alertSuppressed });
      return;
    }

    // Pause checked BEFORE the claim; a visible marker says this copy needs a manual send.
    {
      const sw = await MessagingControls.channelStatus(getFirestore(), 'email');
      if (!sw.allowed) {
        logger.warn('guideCopyEmail: held, customer messaging paused', { reqId, reason: sw.reason });
        await ref.update({ guideEmailHeld: 'messaging_paused' }).catch(() => {});
        return;
      }
      if (sw.canary) {
        logger.info('guideCopyEmail: canary - not claimed, not sent', { reqId });
        return;
      }
    }

    let claimed = false;
    try {
      claimed = await getFirestore().runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists || fresh.get('guideEmailedAt')) return false;
        tx.update(ref, { guideEmailedAt: FieldValue.serverTimestamp() });
        return true;
      });
    } catch (e) {
      logger.error('guideCopyEmail: claim txn failed', { reqId, err: e.message });
      return;
    }
    if (!claimed) {
      logger.info('guideCopyEmail: skip — already emailed', { reqId });
      return;
    }

    const postalAddress = await Suppression.tenantPostalAddress(getFirestore(), NBD_OWNER_UID);
    if (!postalAddress) logger.warn('guideCopyEmail: no mailing address on the NBD Company Profile', { reqId });

    try {
      const resend = new Resend(RESEND_API_KEY.value());
      const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
      // Email category: TRANSACTIONAL — the homeowner asked for this guide copy on /guides/<slug>. Not gated by the unsubscribe register (email-suppression.js SEND_PATHS).
      const gated = await MessagingControls.guardEmail(getFirestore(), {
        from,
        to: d.email,
        subject: G.subjectFor(d.guide),
        html: G.emailHtml({ slug: d.guide, postalAddress }),
        reply_to: G.REPLY_TO,
        attachments: [G.attachmentFor(d.guide)],
      });
      if (!gated.send) {
        logger.warn('guideCopyEmail: held, customer messaging paused', { reqId, reason: gated.reason });
        await ref.update({ guideEmailedAt: FieldValue.delete(), guideEmailHeld: 'messaging_paused' }).catch(() => {});
        return;
      }
      if (gated.canary) {
        await ref.update({ guideEmailedAt: FieldValue.delete() }).catch(() => {});
        logger.info('guideCopyEmail: canary - claim released, not sent', { reqId });
        return;
      }
      // Spent only once the guard says the send is real, and after the claim
      // (a redelivery never reaches here). Limiter outage fails open.
      const capR = await AR.capRecipients('guideCopy', [d.email], { limit: G.GUIDE_COPY_RECIPIENT_DAILY_CAP });
      if (!capR.allowed.length) {
        logger.info('guideCopyEmail: skip — recipient at the daily cap', { reqId });
        await ref.update({ guideEmailHeld: 'recipient_cap' }).catch(() => {});
        return;
      }
      const resp = await resend.emails.send(gated.msg);
      if (resendRejected(resp)) throw new Error(resendErrorMessage(resp));
      const id = (resp && resp.data && resp.data.id) || (resp && resp.id) || null;
      await ref.update({ guideEmailId: id });
      logger.info('guideCopyEmail: sent', { reqId, id, guide: d.guide });
    } catch (e) {
      // Claimed already, so no retry storm. The CRM card (lead-bridge) still
      // shows who asked, so Joe can send it by hand.
      logger.error('guideCopyEmail: send failed', { reqId, err: e.message });
      await ref.update({ guideEmailError: String(e.message || 'send failed').slice(0, 200) }).catch(() => {});
    }
  }
);
