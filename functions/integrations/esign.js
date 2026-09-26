/**
 * integrations/esign.js — BoldSign embedded signing adapter
 *
 * Lets a rep hand the iPad to a homeowner at the door and close
 * the contract on the spot. E-sign close rates beat email-back
 * contracts by ~20% industry-wide.
 *
 * Flow:
 *   1. Rep clicks "Send for signature" on an estimate.
 *   2. sendEstimateForSignature(callable) converts the finalized
 *      HTML to a PDF (via boldsign's documentHtmlToPdf helper) and
 *      creates a BoldSign envelope with one signer (homeowner).
 *   3. Returns an embedded signing URL the app opens in an iframe
 *      (signer completes without leaving the app) or sends to
 *      the homeowner's email.
 *   4. BoldSign webhook fires on completion → esignWebhook flips
 *      the estimate doc to status:'signed' and stores the signed
 *      PDF URL.
 *
 * SETUP:
 *   firebase functions:secrets:set BOLDSIGN_API_KEY
 *   firebase functions:secrets:set BOLDSIGN_WEBHOOK_SECRET
 *   Configure webhook URL in BoldSign dashboard:
 *     https://us-central1-nobigdeal-pro.cloudfunctions.net/esignWebhook
 */

'use strict';

const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
// Modular FieldValue import: the namespaced FieldValue is
// undefined inside the Functions emulator runtime (firebase-admin v12 +
// emulator instrumentation drops the static). The modular import works in
// BOTH prod and the emulator.
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { getSecret, hasSecret, SECRETS } = require('./_shared');
const { assertNotViewer } = require('../shared');

// Platform tenant identity, for the auto-invoice gate below. MUST stay
// byte-identical to functions/stripe.js NBD_OWNER_UID — that module keeps
// isPlatformTenant() private (it takes a decoded token, which a webhook does
// not have), so this is a deliberate second read of the SAME env override, not
// a second source of truth. tests/stripe-platform-only-payments.test.js pins
// that both files resolve the same default.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app'
];

// ─── Callable: sendEstimateForSignature ─────────────────────
exports.sendEstimateForSignature = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    memory: '512MiB',
    secrets: [SECRETS.BOLDSIGN_API_KEY]
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B): a viewer is read-only — no paid BoldSign
    // envelope sent to a homeowner, even for an estimate the viewer owns.
    assertNotViewer(request.auth.token);

    // D1: BoldSign bills per envelope. 30/hour/uid is plenty for
    // a real rep workflow and kills any runaway loop cheaply.
    const { enforceRateLimit } = require('./upstash-ratelimit');
    try {
      await enforceRateLimit('callable:sendEstimateForSignature:uid', uid, 30, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) throw new HttpsError('resource-exhausted', 'E-sign rate limit — try again in an hour.');
      throw e;
    }

    if (!hasSecret('BOLDSIGN_API_KEY')) {
      throw new HttpsError('failed-precondition', 'E-signature not configured. Contact support.');
    }

    const estimateId = typeof request.data?.estimateId === 'string' ? request.data.estimateId : null;
    const signerName = typeof request.data?.signerName === 'string' ? request.data.signerName.slice(0, 120) : '';
    const signerEmail = typeof request.data?.signerEmail === 'string' ? request.data.signerEmail.trim().toLowerCase() : '';
    const html = typeof request.data?.html === 'string' ? request.data.html : '';
    const title = typeof request.data?.title === 'string' ? request.data.title.slice(0, 200) : 'NBD Estimate';

    if (!estimateId) throw new HttpsError('invalid-argument', 'estimateId required');
    if (!signerName || !signerEmail || !signerEmail.includes('@')) {
      throw new HttpsError('invalid-argument', 'signerName + valid signerEmail required');
    }
    if (!html || html.length < 100 || html.length > 1_000_000) {
      throw new HttpsError('invalid-argument', 'html body required');
    }

    // Verify caller owns the estimate (company scope check).
    const db = getFirestore();
    const estSnap = await db.doc(`estimates/${estimateId}`).get();
    if (!estSnap.exists) throw new HttpsError('not-found', 'Estimate not found');
    const est = estSnap.data();
    if (est.userId !== uid && request.auth.token.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Not your estimate');
    }

    // BoldSign accepts HTML directly via their "documentData" field.
    // Base64-encode the HTML payload.
    const base64Html = Buffer.from(html, 'utf8').toString('base64');
    const apiKey = getSecret('BOLDSIGN_API_KEY');

    try {
      const res = await fetch('https://api.boldsign.com/v1/document/sendForSign', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title,
          message: `Please review and sign: ${title}`,
          files: [{
            fileName: 'estimate.html',
            fileData: base64Html
          }],
          signers: [{
            name: signerName,
            emailAddress: signerEmail,
            signerType: 'Signer',
            signerOrder: 1,
            formFields: [{
              fieldType: 'Signature',
              pageNumber: 1,
              bounds: { x: 100, y: 700, width: 200, height: 40 },
              isRequired: true
            }, {
              fieldType: 'DateSigned',
              pageNumber: 1,
              bounds: { x: 320, y: 700, width: 150, height: 40 },
              isRequired: true
            }]
          }],
          enableSigningOrder: false,
          reminderSettings: {
            enableAutoReminder: true,
            reminderDays: 2,
            reminderCount: 3
          },
          // Metadata rides back on the webhook so we match completion
          // events to the right estimate doc.
          metadata: { estimateId, callerUid: uid }
        })
      });
      if (!res.ok) {
        const body = await res.text();
        logger.warn('BoldSign send failed', { status: res.status, body: body.slice(0, 300) });
        throw new HttpsError('internal', 'E-sign send failed: ' + res.status);
      }
      const data = await res.json();
      const documentId = data.documentId;

      // Mark estimate 'awaiting_signature' so the UI reflects status.
      await estSnap.ref.update({
        signatureStatus: 'sent',
        signatureProvider: 'boldsign',
        signatureDocumentId: documentId,
        signerName,
        signerEmail,
        signatureSentAt: FieldValue.serverTimestamp()
      });

      // Request an embedded signing URL so the rep can complete on the
      // iPad without bouncing to email.
      let embedUrl = null;
      try {
        const embedRes = await fetch(
          `https://api.boldsign.com/v1/document/getEmbeddedSignLink?documentId=${encodeURIComponent(documentId)}&signerEmail=${encodeURIComponent(signerEmail)}`,
          { headers: { 'X-API-KEY': apiKey } }
        );
        if (embedRes.ok) {
          const embedData = await embedRes.json();
          embedUrl = embedData.signLink || embedData.signUrl || null;
        }
      } catch (e) { /* embed is optional — email link still works */ }

      return { success: true, documentId, embedUrl, status: 'sent' };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('sendEstimateForSignature error:', e.message);
      throw new HttpsError('internal', 'E-sign failed');
    }
  }
);

// ─── Webhook: signer completes / declines ───────────────────
exports.esignWebhook = onRequest(
  {
    region: 'us-central1',
    maxInstances: 10,
    timeoutSeconds: 15,
    memory: '256MiB',
    // STRIPE_SECRET_KEY pulled in so C5 auto-invoice can create the
    // draft without re-deploying. If not configured, the helper
    // no-ops.
    secrets: [
      SECRETS.BOLDSIGN_API_KEY,
      SECRETS.BOLDSIGN_WEBHOOK_SECRET,
      require('firebase-functions/params').defineSecret('STRIPE_SECRET_KEY')
    ]
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    // F2: HMAC verification is now REQUIRED. Previously we treated
    // a missing BOLDSIGN_WEBHOOK_SECRET as "ok, skip verification" —
    // that's a fail-open. An attacker who knew the endpoint shape
    // could forge 'completed' events to flip estimates to signed.
    // Now we reject unsigned requests even if the secret is unset,
    // so ops sees the 5xx spike and configures the secret.
    if (!hasSecret('BOLDSIGN_WEBHOOK_SECRET')) {
      logger.error('esignWebhook: BOLDSIGN_WEBHOOK_SECRET not set — rejecting unsigned request');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }
    const sig = req.headers['x-boldsign-signature'];
    if (!sig || !req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      res.status(400).json({ error: 'Missing signature' });
      return;
    }
    const computed = crypto
      .createHmac('sha256', getSecret('BOLDSIGN_WEBHOOK_SECRET'))
      .update(req.rawBody)
      .digest('hex');
    if (!safeEqual(computed, String(sig))) {
      res.status(403).json({ error: 'Bad signature' });
      return;
    }

    const body = req.body || {};
    const eventType = body.event || body.status;
    const documentId = body.documentId || (body.data && body.data.documentId);
    const metadata = body.metadata || (body.data && body.data.metadata) || {};
    const estimateId = metadata.estimateId;

    if (!documentId) { res.status(400).json({ error: 'Missing documentId' }); return; }

    try {
      const db = getFirestore();
      let ref = null;
      if (estimateId) ref = db.doc(`estimates/${estimateId}`);
      else {
        const snap = await db.collection('estimates')
          .where('signatureDocumentId', '==', documentId)
          .limit(1).get();
        if (!snap.empty) ref = snap.docs[0].ref;
      }
      if (!ref) { res.status(200).json({ ok: true, matched: false }); return; }

      const update = { signatureUpdatedAt: FieldValue.serverTimestamp() };

      const normalized = String(eventType || '').toLowerCase();
      let justSigned = false;
      if (normalized.includes('complet')) {
        update.signatureStatus = 'signed';
        update.signedAt = FieldValue.serverTimestamp();
        justSigned = true;
        // Pull the signed PDF URL if available.
        if (body.documentUrl || (body.data && body.data.documentUrl)) {
          update.signedDocumentUrl = body.documentUrl || body.data.documentUrl;
        }
      } else if (normalized.includes('declin') || normalized.includes('decline')) {
        update.signatureStatus = 'declined';
      } else if (normalized.includes('expir')) {
        update.signatureStatus = 'expired';
      } else {
        update.signatureStatus = 'viewed';
      }
      await ref.update(update);

      // C5: on signed transitions, auto-create a Stripe invoice.
      // Swallow any error — failing to create the invoice must NOT
      // block the signature webhook (BoldSign retries on 5xx). The
      // function logs + continues; ops can reconcile in Stripe.
      if (justSigned) {
        try {
          await createStripeInvoiceForEstimate(ref);
        } catch (e) {
          logger.warn('esignWebhook: auto-invoice failed', { err: e.message });
        }
      }

      res.status(200).json({ ok: true, matched: true });
    } catch (e) {
      logger.error('esignWebhook error:', e.message);
      res.status(500).json({ error: 'write failed' });
    }
  }
);

function safeEqual(a, b) {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ═════════════════════════════════════════════════════════════
// createStripeInvoiceForEstimate — C5 auto-invoice on sign.
//
// Lifts the signed estimate's customer info, line items, and total
// into a Stripe Invoice. We intentionally do NOT finalize the
// invoice here; we leave it in draft so the rep can review and
// send from Stripe (or we can add a "finalize + email" flow later).
//
// No Stripe key? Skip silently. Same estimate re-signed? Skip if
// estimate.stripeInvoiceId is already set.
// ═════════════════════════════════════════════════════════════
async function createStripeInvoiceForEstimate(estRef) {
  const rawKey = process.env.STRIPE_SECRET_KEY
    || (require('firebase-functions/params').defineSecret('STRIPE_SECRET_KEY').value
        ? require('firebase-functions/params').defineSecret('STRIPE_SECRET_KEY').value()
        : null);
  // Trim mirrors functions/stripe.js getStripe() (#774): a trailing newline in
  // the Secret Manager value throws ERR_INVALID_CHAR inside the Stripe SDK.
  const stripeKey = String(rawKey == null ? '' : rawKey).trim();
  if (!stripeKey) {
    logger.info('auto-invoice: STRIPE_SECRET_KEY not available in this function context');
    return;
  }
  const Stripe = require('stripe');
  // Pin API version (mirrors functions/stripe.js) so an SDK bump stays
  // behavior-neutral on the billing path.
  const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });

  const db = getFirestore();
  const estSnap = await estRef.get();
  const est = estSnap.data();
  if (!est) return;
  if (est.stripeInvoiceId) {
    logger.info('auto-invoice: already created', { id: est.stripeInvoiceId });
    return;
  }

  // PLATFORM-ONLY, same rule as createStripePaymentLink (#1123) — this is the
  // OTHER homeowner→contractor money path and it was never gated.
  //
  // Nothing is charged today (the invoice is created as a draft:
  // auto_advance:false + collection_method:'send_invoice'), but for a
  // non-platform tenant this still puts THEIR homeowner's name/email on OUR
  // Stripe account as a customer, with a draft invoice for THEIR job amount
  // sitting in our dashboard — one "send" click away from collecting another
  // business's money into our balance. That is precisely what the payment-link
  // gate exists to prevent.
  //
  // No auth token here (this runs from the BoldSign webhook), so resolve the
  // tenant from the estimate itself: solo convention is companyId == owner uid,
  // so either matching the platform owner is us.
  //
  // PHASE 3 (Connect destination charges) DELIBERATELY DID NOT LIFT THIS
  // GATE. The payment-link mint now routes tenant money via Connect, but C5
  // hosted invoices remain platform-only because (a) they are a
  // reconciliation dead end — a paid hosted invoice's payment_intent carries
  // no invoiceId metadata, so invoiceWebhook never credits the CRM ledger and
  // stripeWebhook's invoice.paid ignores non-subscription_cycle reasons — and
  // (b) they would park tenant homeowner PII as platform-account Customers.
  // Phase 4 decides: create these on the connected account, or retire C5.
  const ownerUid = est.userId || null;
  const companyId = est.companyId || null;
  const isPlatform = ownerUid === NBD_OWNER_UID || companyId === NBD_OWNER_UID;
  if (!isPlatform) {
    logger.info('auto-invoice skipped: non-platform tenant (no Connect yet)', {
      estimateId: estRef.id, ownerUid, companyId,
    });
    return;
  }

  const signerEmail = est.signerEmail || (est.customer && est.customer.email);
  const signerName  = est.signerName  || (est.customer && est.customer.name);
  if (!signerEmail) {
    logger.warn('auto-invoice: no signer email on estimate');
    return;
  }

  // Find or create customer.
  let customerId = null;
  try {
    const found = await stripe.customers.search({
      query: `email:'${signerEmail.replace(/'/g, "\\'")}'`,
      limit: 1
    });
    if (found.data.length) customerId = found.data[0].id;
  } catch (e) { /* search may not be available on older keys */ }
  if (!customerId) {
    const c = await stripe.customers.create({
      email: signerEmail,
      name:  signerName || undefined,
      metadata: {
        leadId: est.leadId || '',
        estimateId: estRef.id
      }
    });
    customerId = c.id;
  }

  // Create a draft invoice + line items. Prefer est.lines; fall back
  // to a single grand-total line if line data is missing.
  const inv = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: 14,
    auto_advance: false,        // leave in draft for rep review
    metadata: {
      estimateId: estRef.id,
      leadId: est.leadId || '',
      signatureDocumentId: est.signatureDocumentId || ''
    },
    description: 'Roofing project — ' + ((est.customer && est.customer.address) || est.addr || 'see project details')
  });

  const lines = Array.isArray(est.lines) && est.lines.length ? est.lines : null;
  if (lines) {
    for (const line of lines) {
      const amountCents = Math.round((Number(line.lineTotal) || Number(line.extended) || 0) * 100);
      if (amountCents <= 0) continue;
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: inv.id,
        amount: amountCents,
        currency: 'usd',
        description: (line.name || line.description || line.code || 'Line item').toString().slice(0, 120)
      });
    }
  } else {
    const amountCents = Math.round((Number(est.grandTotal) || Number(est.total) || 0) * 100);
    if (amountCents > 0) {
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: inv.id,
        amount: amountCents,
        currency: 'usd',
        description: 'Roofing project'
      });
    }
  }

  await estRef.update({
    stripeInvoiceId:   inv.id,
    stripeCustomerId:  customerId,
    stripeInvoiceUrl:  inv.hosted_invoice_url || null,
    stripeInvoiceStatus: inv.status,
    stripeInvoiceCreatedAt: FieldValue.serverTimestamp()
  });

  // Activity log entry on the lead, if linked.
  if (est.leadId && est.userId) {
    try {
      await db.collection(`leads/${est.leadId}/activity`).add({
        userId: est.userId,
        type: 'stripe_invoice_created',
        label: 'Stripe invoice drafted',
        stripeInvoiceId: inv.id,
        stripeCustomerId: customerId,
        amountCents: lines
          ? lines.reduce((s, l) => s + Math.round((Number(l.lineTotal) || 0) * 100), 0)
          : Math.round((Number(est.grandTotal) || 0) * 100),
        createdAt: FieldValue.serverTimestamp()
      });
    } catch (e) {}
  }

  logger.info('auto-invoice: created', { estId: estRef.id, invoiceId: inv.id, customerId });
}

module.exports = exports;
