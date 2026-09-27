/**
 * NBD Pro — Email Cloud Functions
 * ═══════════════════════════════════════════════════════════════
 *
 * Email sending via Resend provider
 * Functions:
 *   - sendEmail (HTTP)
 *   - sendEstimateEmail (HTTP)
 *   - sendDripEmail (callable)
 */

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue } = require('firebase-admin/firestore');
const { Resend } = require('resend');
const { enforceRateLimit, httpRateLimit } = require('./rate-limit');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const Suppression = require('./email-suppression');

// Secrets
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');

// CORS origins
const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ═══════════════════════════════════════════════════════════════
// EMAIL TEMPLATES — Branded HTML emails
// ═══════════════════════════════════════════════════════════════

const TEMPLATE_STYLES = `
  body {
    font-family: 'Barlow', 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    line-height: 1.6;
    color: #333;
    background-color: #f5f5f5;
  }
  .container {
    max-width: 600px;
    margin: 0 auto;
    background-color: #ffffff;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  }
  .header {
    background: linear-gradient(135deg, #BD5728 0%, #a14a22 100%);
    color: white;
    padding: 30px 20px;
    text-align: center;
  }
  .header h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 600;
  }
  .content {
    padding: 30px 20px;
    color: #333;
  }
  .content h2 {
    color: #1a3057;
    margin-top: 0;
    margin-bottom: 15px;
    font-size: 20px;
  }
  .footer {
    background-color: #1a3057;
    color: white;
    padding: 20px;
    text-align: center;
    font-size: 12px;
  }
  .footer a {
    color: #BD5728;
    text-decoration: none;
  }
  .cta-button {
    display: inline-block;
    background-color: #BD5728;
    color: white;
    padding: 12px 30px;
    border-radius: 6px;
    text-decoration: none;
    font-weight: 600;
    margin: 20px 0;
  }
  .cta-button:hover {
    background-color: #a14a22;
  }
`;

const BRANDED_EMAIL_TEMPLATE = (subject, content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>${TEMPLATE_STYLES}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>No Big Deal Home Solutions</h1>
    </div>
    <div class="content">
      ${content}
    </div>
    <div class="footer">
      <p>No Big Deal Home Solutions | (859) 420-7382 | jd@nobigdealwithjoedeal.com</p>
      <p><a href="https://nobigdealwithjoedeal.com">Visit our website</a></p>
    </div>
  </div>
</body>
</html>
`;

const DRY_TEMPLATES = {
  welcome: {
    subject: 'Welcome to No Big Deal Pro!',
    html: BRANDED_EMAIL_TEMPLATE(
      'Welcome',
      `<h2>Welcome to NBD Pro!</h2>
       <p>Hi {firstName},</p>
       <p>You're all set to start managing your roofing pipeline. Here's what you can do:</p>
       <ul>
         <li>Track leads and appointments</li>
         <li>Generate professional estimates</li>
         <li>Log door-to-door activity</li>
         <li>Manage claims and insurance</li>
       </ul>
       <p><a href="https://nobigdealwithjoedeal.com/pro/dashboard" class="cta-button">Go to Dashboard</a></p>
       <p>If you have any questions, reply to this email or call us at (859) 420-7382.</p>`
    )
  },
  inspectionScheduled: {
    subject: 'Inspection Scheduled — {address}',
    html: BRANDED_EMAIL_TEMPLATE(
      'Inspection Scheduled',
      `<h2>Inspection Confirmed</h2>
       <p>Hi {customerName},</p>
       <p>This confirms your inspection appointment:</p>
       <p><strong>Date:</strong> {inspectionDate}<br>
          <strong>Time:</strong> {inspectionTime}<br>
          <strong>Location:</strong> {address}</p>
       <p>I'll conduct a thorough assessment and provide recommendations. The inspection typically takes 30-45 minutes.</p>
       <p>See you then!</p>
       <p>Joe Deal<br>No Big Deal Home Solutions</p>`
    )
  },
  claimFiled: {
    subject: 'Claim Filed — Next Steps',
    html: BRANDED_EMAIL_TEMPLATE(
      'Claim Filed',
      `<h2>Claim Has Been Filed</h2>
       <p>Hi {customerName},</p>
       <p>Good news — the claim has been filed with {carrier}. Your claim number is: <strong>{claimNumber}</strong></p>
       <p><strong>What happens next:</strong></p>
       <ol>
         <li>{carrier} will assign an adjuster</li>
         <li>The adjuster will schedule an inspection (usually within 7-14 days)</li>
         <li>I'll be present at the adjuster meeting to ensure nothing is missed</li>
       </ol>
       <p>I'll keep you updated as things move forward. Don't hesitate to reach out with questions.</p>`
    )
  },
  approved: {
    subject: 'Estimate Approved — Let\'s Move Forward!',
    html: BRANDED_EMAIL_TEMPLATE(
      'Estimate Approved',
      `<h2>Great News!</h2>
       <p>Hi {customerName},</p>
       <p>Your estimate has been approved by {carrier}. Total: <strong>{estimateAmount}</strong></p>
       <p>Next steps:</p>
       <ol>
         <li>Sign the contract</li>
         <li>Schedule installation</li>
         <li>Prepare your property</li>
       </ol>
       <p>Let's get your project completed and get you back to normal!</p>`
    )
  },
  installScheduled: {
    subject: 'Installation Scheduled — {address}',
    html: BRANDED_EMAIL_TEMPLATE(
      'Installation Scheduled',
      `<h2>Your Installation is Scheduled!</h2>
       <p>Hi {customerName},</p>
       <p><strong>Installation Date:</strong> {scheduledDate}<br>
          <strong>Crew Lead:</strong> {crew}<br>
          <strong>Location:</strong> {address}</p>
       <p><strong>What to expect:</strong></p>
       <ul>
         <li>Crew arrives early morning (typically 7-8 AM)</li>
         <li>Work usually takes 1-2 days depending on scope</li>
         <li>We'll keep the area clean and professional throughout</li>
       </ul>
       <p>Please make sure vehicles are moved from the driveway. If you have any concerns, let me know before installation day.</p>`
    )
  },
  followUpGeneric: {
    subject: 'Following Up on Your Project',
    html: BRANDED_EMAIL_TEMPLATE(
      'Follow-Up',
      `<h2>Checking In</h2>
       <p>Hi {customerName},</p>
       <p>I wanted to follow up on the project at {address}.</p>
       <p>Do you have any questions or need any updates? I'm happy to help!</p>
       <p>Feel free to reach out anytime at (859) 420-7382.</p>`
    )
  },
  reviewRequest: {
    subject: 'We\'d Love Your Feedback!',
    html: BRANDED_EMAIL_TEMPLATE(
      'Leave a Review',
      `<h2>Please Share Your Experience</h2>
       <p>Hi {customerName},</p>
       <p>Thank you for choosing No Big Deal Home Solutions for your project at {address}. We'd love to hear about your experience!</p>
       <p><a href="https://google.com/maps/search/No+Big+Deal+Home+Solutions" class="cta-button">Leave a Review</a></p>
       <p>Your feedback helps us serve you and others better.</p>`
    )
  },
  referralCode: {
    subject: 'Your Referral Code — Earn $100!',
    html: BRANDED_EMAIL_TEMPLATE(
      'Refer & Earn',
      `<h2>Share No Big Deal & Get Rewarded</h2>
       <p>Hi {customerName},</p>
       <p>We appreciate your business! Want to earn $100?</p>
       <p><strong>Your referral code:</strong> <code style="background:#f0f0f0;padding:8px 12px;border-radius:4px;">{referralCode}</code></p>
       <p>Share this code with friends and family. For every job that closes, you'll receive a $100 bonus!</p>
       <p>Thank you for recommending us!</p>`
    )
  }
};

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Validate email address format
 */
function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Populate template with variables.
 * Variable VALUES are HTML-escaped before substitution: they are
 * caller-supplied plain-text fields (customerName, address, amount, …),
 * and the drip templates are fixed server-owned HTML. Escaping the values
 * blocks HTML/script injection through a variable while leaving the
 * template markup itself intact.
 */
function escapeTemplateValue(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function populateTemplate(template, variables) {
  let html = template.html;
  Object.keys(variables).forEach(key => {
    const value = escapeTemplateValue(variables[key]);
    html = html.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  });
  return html;
}

/**
 * Log email to Firestore
 */
async function logEmailToFirestore(db, to, subject, uid, status = 'sent', leadId = null, companyId = null) {
  try {
    const ts = FieldValue.serverTimestamp();
    const row = {
      to,
      subject,
      uid,
      // leadId ties the row to a customer thread. The customer-page
      // Communication Log queries where('leadId','==',id) — without it, the
      // row is invisible there. `date` is the field that log orders by (and
      // the {leadId, uid, date} composite index keys on); `sentAt` is kept
      // for existing analytics readers. Both carry the same server timestamp.
      leadId: leadId || null,
      date: ts,
      sentAt: ts,
      status
    };
    // companyId enables team-wide Comm Log for managers (same-tenant read).
    if (companyId) row.companyId = companyId;
    await db.collection('email_log').add(row);
  } catch (e) {
    logger.warn('email_log_write_failed', { err: e.message });
  }
}

/**
 * Verify Firebase ID token
 */
async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!idToken) return null;

  try {
    return await getAuth().verifyIdToken(idToken);
  } catch (e) {
    logger.warn('email_auth_verify_failed', { err: e.message });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLOUD FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * sendEmail — HTTP function (POST, authenticated)
 * Sends a generic email via Resend
 */
exports.sendEmail = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 20,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Verify Firebase auth
    const decoded = await verifyAuth(req);
    if (!decoded) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Block read-only / access-code-only accounts from using this generic
    // sender as an email relay: `viewer` is the read-only team role and
    // `member` is the access-code-only login. Neither should emit HTML mail
    // from the verified company domain (phishing/spam reputation risk).
    // Real senders — sales_rep / manager / company_admin / admin / owner —
    // are unaffected. (AUTHZ-2, backend security audit 2026-06-24.)
    const _senderRole = decoded.role || '';
    if (_senderRole === 'viewer' || _senderRole === 'member') {
      res.status(403).json({ error: 'Your account role cannot send email' });
      return;
    }

    const { to, subject, body, html, replyTo, attachments, leadId } = req.body;

    // Validate input
    if (!to || !isValidEmail(to)) {
      res.status(400).json({ error: 'Invalid recipient email' });
      return;
    }

    if (!subject || subject.trim().length === 0) {
      res.status(400).json({ error: 'Subject cannot be empty' });
      return;
    }

    if (!body && !html) {
      res.status(400).json({ error: 'Body or HTML required' });
      return;
    }

    // ── Email unsubscribe (CAN-SPAM, 2026-09-22) ──────────────────────
    // The caller says what this email IS via `kind` (email-suppression.js
    // TRANSACTIONAL_KINDS: invoice, receipt, estimate, proposal, contract,
    // portal_link, document, appointment). No kind, or any other value, is
    // COMMERCIAL — fail closed for marketing. A commercial send to an address
    // this tenant has on its suppression register is REFUSED (403
    // 'unsubscribed'); the browser client surfaces that as a final refusal
    // and never hands it off to mailto:. Transactional sends skip the check.
    //
    // This runs BEFORE both limiters, on purpose (the sendSMS opt-out lesson,
    // #1667): the client answers a 429 by opening the rep's mail app with the
    // message filled in, so a 429 ahead of this check could hand an
    // unsubscribed address to a device-side send.
    //
    // Tenant key = claims.companyId || uid (the Phase-1.5 convention the CRM
    // badge, the unsubscribe token and markEmailUnsubscribed all use).
    const db = getFirestore();
    const companyId = decoded.companyId || null;
    const tenantKey = decoded.companyId || decoded.uid;
    const kind = req.body && typeof req.body.kind === 'string' ? req.body.kind : '';
    const category = Suppression.resolveCategory({ kind });
    let unsubGate = null;
    if (category === Suppression.CATEGORY.COMMERCIAL) {
      try {
        unsubGate = await Suppression.gateCommercialEmail(db, {
          companyId: tenantKey, email: to, leadId: leadId || null, source: 'sendEmail',
        }, { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FieldValue.serverTimestamp });
      } catch (e) {
        // Unknown opt-out state is "do not send", never "probably fine". A
        // distinguishable 503 (not the framework's plain 500) so the client
        // refuses instead of handing off to mailto:.
        logger.error('sendEmail suppression_unverified', { err: e && e.message, code: e && e.code });
        res.status(503).json({
          error: 'Could not confirm this person can be emailed — nothing was sent. Try again in a moment.',
          code: 'suppression_unverified',
        });
        return;
      }
      if (unsubGate.suppressed) {
        await logEmailToFirestore(db, to, subject, decoded.uid, 'suppressed', leadId || null, companyId);
        res.status(403).json({ error: 'This person unsubscribed from email', code: 'unsubscribed' });
        return;
      }
    }

    if (!(await httpRateLimit(req, res, 'sendEmail:ip', 60, 3_600_000))) return;
    try {
      await enforceRateLimit('sendEmail:uid', decoded.uid, 200, 86_400_000);
    } catch (e) {
      if (e.rateLimited) { res.status(429).json({ error: 'Daily email limit exceeded' }); return; }
      throw e;
    }

    try {
      const resend = new Resend(RESEND_API_KEY.value());
      const fromEmail = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');

      // Commercial: footer link + RFC 8058 one-click headers. Transactional:
      // the message goes exactly as the caller built it.
      const bodyHtml = Suppression.applyFooter(unsubGate, html || `<p>${body}</p>`, null).html;
      const message = {
        from: fromEmail,
        to,
        subject,
        html: bodyHtml,
        reply_to: replyTo,
        attachments: attachments || []
      };
      if (unsubGate && unsubGate.headers) message.headers = unsubGate.headers;
      // Carries the unsubscribe token so Resend's bounce/complaint webhook can
      // attribute the event to this tenant (functions/resend-webhook.js).
      if (unsubGate && unsubGate.tags) message.tags = unsubGate.tags;

      const response = await resend.emails.send(message);

      // The Resend SDK does NOT throw on an API-level rejection (bad/expired
      // key, suspended account, invalid sender domain, etc.) — it resolves
      // to { data: null, error: {...} }, so this branch never ran and every
      // one of those failures was logged and returned as a genuine success.
      // Found live-testing invoicing 2026-09-08 (see documentation/audit/
      // STRIPE-INVOICING-STATUS-2026-09-08.md); the identical shape at
      // ~18 more call sites across functions/ was fixed as a follow-up
      // (documentation/audit/RESEND-ERROR-SURFACING-SWEEP-2026-09-08.md),
      // sharing this check via resend-guard.js.
      if (resendRejected(response)) {
        const msg = resendErrorMessage(response);
        logger.error('sendEmail resend_rejected', { err: msg });
        await logEmailToFirestore(db, to, subject, decoded.uid, 'failed', leadId || null, companyId);
        res.status(502).json({ error: 'Failed to send email', detail: msg });
        return;
      }

      // Log to Firestore
      await logEmailToFirestore(db, to, subject, decoded.uid, 'sent', leadId || null, companyId);

      res.json({
        success: true,
        id: response.data?.id || response.id
      });

    } catch (e) {
      logger.error('sendEmail error', { err: e.message });

      // Log failure
      await logEmailToFirestore(db, to, subject, decoded.uid, 'failed', leadId || null, companyId);

      res.status(500).json({
        error: 'Failed to send email'
      });
    }
  }
);

/**
 * sendEstimateEmail — HTTP function (POST, authenticated)
 * Sends an estimate email with branded template
 */
// sendEstimateEmail was retired 2026-08-11 (dead-surface lane, audit
// follow-up): zero client callers anywhere under docs/ — estimate emails
// go through the working flows, not this branded relay. Approved by Jo.
// Restore from git (pre-ded736f) if a dedicated estimate-mail path ships.
// Prod instance deleted via console — see WEEKLY_CADENCE.

/**
 * sendDripEmail — Callable function (not HTTP)
 * Internal helper for drip campaign automation
 */
// sendDripEmail was retired 2026-08-11 (dead-surface lane, audit
// follow-up): zero client callers — the drip UI never shipped. Approved
// by Jo. Restore from git (pre-ded736f) when a drip-campaign UI lands.
// Prod instance deleted via console — see WEEKLY_CADENCE.

// sendTeamInviteEmail was retired 2026-08-06 (tenant-lifecycle audit CL8):
// a dead HTTP path with zero callers, using the pre-claims role vocabulary
// and writing an invites/{token} collection no claim path consumes. The
// live invite flow is the createTeamInvite callable in handlers/invites.js.

logger.info('email_functions_loaded');
