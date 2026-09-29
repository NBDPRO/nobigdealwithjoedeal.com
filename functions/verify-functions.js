/**
 * NBD — Estimate Funnel Verification & Lead Notification Functions
 * ═══════════════════════════════════════════════════════════════════
 *
 * Functions for the multi-step estimate funnel:
 *   - sendVerificationCode (callable) — Twilio Verify OTP send
 *   - verifyCode (callable) — Twilio Verify OTP check
 *   - notifyNewLead (callable) — Email + SMS notification to Joe
 *
 * SETUP:
 *   1. Create a Twilio Verify Service in Twilio Console:
 *      Console → Verify → Services → Create new service
 *      Name: "NBD Estimate Verification"
 *   2. Set the secret:
 *      firebase functions:secrets:set TWILIO_VERIFY_SID
 *      (paste the Verify Service SID, starts with VA...)
 *   3. Deploy:
 *      firebase deploy --only functions
 *
 * IMPORTANT - Twilio A2P 10DLC Registration:
 *   For SMS to work reliably in the US, you need to register your
 *   Twilio phone number for A2P 10DLC messaging:
 *   1. Go to Twilio Console → Messaging → Compliance
 *   2. Register your business (Brand Registration)
 *   3. Create a Campaign (use "Mixed" or "Marketing" use case)
 *   4. Link your phone number to the Campaign
 *   This process takes 1-5 business days for approval.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
// Lazy require (2026-08-07) — see lead-alert.js: ~21 MB SDK off the
// cold-start path; call sites use _twilio()(...).
let _twilioSdk = null;
const _twilio = () => (_twilioSdk = _twilioSdk || require('twilio'));
const { enforceRateLimit, clientIp } = require('./rate-limit');

// Secrets (some already defined in sms-functions.js — Firebase deduplicates)
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');
const TWILIO_VERIFY_SID = defineSecret('TWILIO_VERIFY_SID');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');

// Joe's contact info for notifications. Stored as secrets rather than
// hardcoded so they can be rotated without a code change if Joe is being
// spammed.
const JOE_PHONE_SECRET = defineSecret('JOE_NOTIFY_PHONE');
const JOE_EMAIL_SECRET = defineSecret('JOE_NOTIFY_EMAIL');
const JOE_PHONE_FALLBACK = '+18594207382';
const JOE_EMAIL_FALLBACK = 'jonathandeal459@gmail.com';

/**
 * Format phone to E.164 — US/Canada only.
 * International numbers are explicitly rejected to block SMS-pumping fraud.
 */
function formatPhone(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.length === 10) return '+1' + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  return null;
}
/**
 * Rate limit check — prevents abuse of OTP sends
 * Max 3 OTP requests per phone per 10 minutes
 */
async function checkOTPRateLimit(db, phone) {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const snap = await db.collection('otp_requests')
    .where('phone', '==', phone)
    .where('requestedAt', '>', tenMinAgo)
    .get();

  return snap.size < 3;
}

// ═══════════════════════════════════════════════════════════════════
// sendVerificationCode — Send OTP via Twilio Verify
// ═══════════════════════════════════════════════════════════════════

exports.sendVerificationCode = onCall(
  {
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID],
    enforceAppCheck: true, // now required — blocks curl/script abuse
    maxInstances: 10,
    concurrency: 20,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (request) => {
    const ip = clientIp(request.rawRequest || {});

    // Per-IP cap — 5 OTP sends per 10 minutes from one IP.
    try {
      await enforceRateLimit('sendVerificationCode:ip', ip, 5, 10 * 60_000);
    } catch (e) {
      if (e.rateLimited) {
        throw new HttpsError('resource-exhausted', 'Too many verification requests. Try again shortly.');
      }
      throw e;
    }

    const { phone } = request.data || {};
    if (!phone) {
      return { success: false, error: 'Phone number required' };
    }

    const formatted = formatPhone(phone);
    if (!formatted) {
      // Reject international numbers — SMS pumping prevention.
      return { success: false, error: 'Only US/Canada phone numbers are supported' };
    }

    try {
      const db = getFirestore();

      // Per-phone cap — 3 OTP sends per 10 minutes.
      const allowed = await checkOTPRateLimit(db, formatted);
      if (!allowed) {
        return { success: false, error: 'Too many verification attempts. Please wait 10 minutes.' };
      }

      // Log the OTP request
      await db.collection('otp_requests').add({
        phone: formatted,
        requestedAt: FieldValue.serverTimestamp(),
        ip,
      });

      // Send verification via Twilio Verify
      const client = _twilio()(
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value()
      );
      const verification = await client.verify.v2
        .services(TWILIO_VERIFY_SID.value())
        .verifications.create({
          to: formatted,
          channel: 'sms'
        });

      logger.info('otp_sent', { status: verification.status });

      return {
        success: true,
        status: verification.status
      };

    } catch (e) {
      logger.error('sendVerificationCode error', { err: e.message });
      return {
        success: false,
        error: 'Failed to send verification code. Please try again.'
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// verifyCode — Check OTP via Twilio Verify
// ═══════════════════════════════════════════════════════════════════

exports.verifyCode = onCall(
  {
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID],
    enforceAppCheck: true,
    maxInstances: 10,
    concurrency: 20,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (request) => {
    const ip = clientIp(request.rawRequest || {});
    try {
      await enforceRateLimit('verifyCode:ip', ip, 20, 10 * 60_000);
    } catch (e) {
      if (e.rateLimited) {
        throw new HttpsError('resource-exhausted', 'Too many attempts. Try again shortly.');
      }
      throw e;
    }
    const { phone, code } = request.data || {};

    if (!phone || !code) {
      return { success: false, error: 'Phone and code required' };
    }

    const formatted = formatPhone(phone);
    if (!formatted) {
      return { success: false, error: 'Invalid phone number' };
    }

    if (!/^\d{4,8}$/.test(code)) {
      return { success: false, error: 'Invalid code format' };
    }

    try {
      const client = _twilio()(
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value()
      );
      const check = await client.verify.v2
        .services(TWILIO_VERIFY_SID.value())
        .verificationChecks.create({
          to: formatted,
          code: code
        });

      logger.info('otp_check', { status: check.status });

      if (check.status === 'approved') {
        // Log successful verification
        const db = getFirestore();
        await db.collection('verified_phones').doc(formatted).set({
          verifiedAt: FieldValue.serverTimestamp(),
          phone: formatted
        }, { merge: true });

        return { success: true, status: 'approved' };
      } else {
        return { success: false, error: 'Invalid code. Please try again.' };
      }

    } catch (e) {
      logger.error('verifyCode error', { err: e.message });

      // Twilio returns 404 if verification expired
      if (e.status === 404) {
        return { success: false, error: 'Code expired. Please request a new one.' };
      }
      return {
        success: false,
        error: 'Verification failed. Please try again.'
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// notifyNewLead — Email + SMS to Joe when a new lead comes in
// ═══════════════════════════════════════════════════════════════════

exports.notifyNewLead = onCall(
  {
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, RESEND_API_KEY, EMAIL_FROM, JOE_PHONE_SECRET, JOE_EMAIL_SECRET],
    enforceAppCheck: true,
    maxInstances: 10,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    const ip = clientIp(request.rawRequest || {});

    // Per-IP: 10 lead notifications per hour. Anything more is abuse.
    try {
      await enforceRateLimit('notifyNewLead:ip', ip, 10, 3_600_000);
    } catch (e) {
      if (e.rateLimited) {
        throw new HttpsError('resource-exhausted', 'Too many notifications. Try again later.');
      }
      throw e;
    }

    const { name, phone, email, address, service, timeline, verified, requestType } = request.data || {};

    if (!name || !phone) {
      return { success: false, error: 'Name and phone required' };
    }

    // Reject international phone numbers up front.
    const formattedLeadPhone = formatPhone(phone);
    if (!formattedLeadPhone) {
      return { success: false, error: 'Only US/Canada phone numbers are supported' };
    }

    // Confirm OTP-verified status server-side rather than trusting `verified`
    // in the payload — the old code just echoed whatever the client sent.
    let trulyVerified = false;
    try {
      const vSnap = await getFirestore().doc(`verified_phones/${formattedLeadPhone}`).get();
      trulyVerified = vSnap.exists;
    } catch (_) {}

    const serviceLabels = {
      'roof-replacement': 'Roof Replacement',
      'roof-repair': 'Roof Repair',      'siding': 'Siding',
      'gutters': 'Gutters',
      'storm-damage': 'Storm Damage Inspection'
    };

    const timelineLabels = {
      'asap': '🔥 ASAP',
      '1-3months': '1-3 Months',
      'exploring': 'Just Exploring'
    };

    const serviceName = serviceLabels[service] || service || 'Unknown';
    const timelineName = timelineLabels[timeline] || timeline || 'Unknown';
    const verifiedBadge = trulyVerified ? '✅ VERIFIED' : '⚠️ Unverified';
    const urgencyFlag = timeline === 'asap' ? '🚨 URGENT — ' : '';
    const requestLabels = {
      'inspection': 'Wants Inspection',
      'call': 'Wants to Talk',
      'email-estimate': 'Email Estimate Only'
    };
    const requestLabel = requestLabels[requestType] || '';

    // Hash the homeowner name for logs so Cloud Logging retention can't leak
    // plaintext PII — first 16 hex chars allow correlation, not reversal.
    // (SEC-PII, backend security audit 2026-06-24; mirrors admin.js M-5.)
    const nameHash = require('crypto').createHash('sha256').update(String(name || '')).digest('hex').slice(0, 16);

    try {
      // ── SMS to Joe (only when the lead phone is OTP-verified) ──
      // Unverified leads still email Joe, but skip SMS so the lead form cannot
      // be used as a cost-DoS vector against Joe's phone.
      const joePhone = secretOr(JOE_PHONE_SECRET, JOE_PHONE_FALLBACK); // stub → fallback, never the string '__unset__'
      if (trulyVerified) {
        let smsBody = `${urgencyFlag}NEW LEAD 🏠\n` +
          `${name} — ${serviceName}\n` +
          `📞 ${formattedLeadPhone} ${verifiedBadge}\n` +
          `📍 ${address || 'No address'}\n` +
          `⏱ ${timelineName}\n` +
          `📧 ${email || 'No email'}`;
          if (requestLabel) smsBody += `\n${requestLabel}`;

        const client = _twilio()(
          TWILIO_ACCOUNT_SID.value(),
          TWILIO_AUTH_TOKEN.value()
        );
        await client.messages.create({
          body: smsBody.substring(0, 1600),
          from: TWILIO_PHONE_NUMBER.value(),
          to: joePhone,
        });
        logger.info('lead_sms_sent_to_joe', { nameHash });
      } else {
        logger.info('lead_sms_skipped_unverified', { nameHash });
      }

      // ── Email to Joe ──
      const { Resend } = require('resend');
      const resend = new Resend(RESEND_API_KEY.value());
      const fromEmail = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');

      // Every value below is public input (the estimate funnel) — escaped so a
      // submitter cannot inject links or markup into Joe's inbox (security
      // audit 2026-09-29).
      const h = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const telDigits = String(phone).replace(/\D/g, '');
      const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
  .card { max-width: 500px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
  .header { background: linear-gradient(135deg, #1a3057, #0c1e3a); color: white; padding: 24px; text-align: center; }
  .header h1 { margin: 0; font-size: 22px; }
  .content { padding: 24px; }
  .field { margin-bottom: 14px; }
  .field .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 3px; }
  .field .value { font-size: 16px; font-weight: 600; color: #1a3057; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 700; }  .badge.verified { background: #dcfce7; color: #16a34a; }
  .badge.unverified { background: #fef3c7; color: #d97706; }
  .badge.urgent { background: #fee2e2; color: #dc2626; }
  .cta { display: block; text-align: center; padding: 14px; background: #bd5728; color: white; text-decoration: none; font-weight: 700; border-radius: 8px; margin: 20px 24px 24px; font-size: 16px; }
  .footer { text-align: center; padding: 16px; font-size: 12px; color: #999; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <h1>🏠 New Estimate Lead</h1>
  </div>
  <div class="content">
    ${timeline === 'asap' ? '<div style="margin-bottom:14px;"><span class="badge urgent">🚨 URGENT — ASAP Timeline</span></div>' : ''}
    <div class="field">
      <div class="label">Name</div>
      <div class="value">${h(name)}</div>
    </div>
    <div class="field">
      <div class="label">Phone ${verified ? '<span class="badge verified">✅ Verified</span>' : '<span class="badge unverified">⚠️ Unverified</span>'}</div>
      <div class="value"><a href="tel:${telDigits}" style="color:#bd5728;text-decoration:none;">${h(phone)}</a></div>
    </div>
    <div class="field">
      <div class="label">Email</div>
      <div class="value"><a href="mailto:${h(email || '')}" style="color:#bd5728;text-decoration:none;">${h(email || 'Not provided')}</a></div>
    </div>
    <div class="field">
      <div class="label">Address</div>
      <div class="value">${h(address || 'Not provided')}</div>
    </div>    <div class="field">
      <div class="label">Service</div>
      <div class="value">${h(serviceName)}</div>
    </div>
    <div class="field">
      <div class="label">Timeline</div>
      <div class="value">${h(timelineName)}</div>
    </div>
    ${requestLabel ? `<div class="field">
      <div class="label">Request Type</div>
      <div class="value">${h(requestLabel)}</div>
    </div>` : ''}
  </div>
  <a href="tel:${telDigits}" class="cta">📞 Call ${h(String(name).split(' ')[0])} Now</a>
  <div class="footer">Lead from nobigdealwithjoedeal.com/estimate</div>
</div>
</body>
</html>`;

      const joeEmail = secretOr(JOE_EMAIL_SECRET, JOE_EMAIL_FALLBACK);
      const response = await resend.emails.send({
        from: fromEmail,
        to: joeEmail,
        subject: `${urgencyFlag}New Lead: ${name} — ${serviceName}`,
        html: emailHtml
      });
      // Resend resolves { data: null, error } on an API-level rejection
      // instead of throwing — without this check a rejected send still
      // returns { success: true } for Joe's own new-lead alert.
      if (resendRejected(response)) {
        throw new Error(resendErrorMessage(response));
      }

      logger.info('lead_notification_email_sent');

      return { success: true };

    } catch (e) {
      logger.error('notifyNewLead error', { err: e.message });
      // Don't fail the estimate — notification is non-critical
      return { success: false, error: 'Notification delivery issue' };
    }
  }
);

logger.info('verify_functions_loaded');