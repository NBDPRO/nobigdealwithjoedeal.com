/**
 * functions/alert-recipients-fns.js — confirm a custom lead-alert address
 * ═══════════════════════════════════════════════════════════════
 *
 * The cloud-function surface for functions/alert-recipients.js (the shared
 * recipient policy). A company's lead alerts go to the owner's verified Auth
 * email unless the owner confirms a different address:
 *
 *   alertRecipients (onCall)       { action: 'status' | 'send' }
 *     status — what the Settings screen shows: the verified Auth email the
 *              alerts fall back to, the configured contact email, and whether
 *              that contact is confirmed.
 *     send   — emails a one-time confirmation link to the company's CONFIGURED
 *              alert email (read server-side from companyProfile, never taken
 *              from the request). Owner / company_admin only; the caller's own
 *              email must be verified; capped per company and per destination.
 *   confirmAlertRecipient (onRequest)  /alert-confirm/<token>
 *     GET renders a button and writes nothing (mail scanners prefetch GET);
 *     POST consumes the token and records the address in alertRecipients/{companyId}
 *     (firestore.rules: no client access). Token-authed, per-IP rate limited,
 *     no script on the page. Same shape as /unsubscribe (email-unsubscribe.js).
 *
 * Nothing here is reachable by an unconfirmed address: a confirmation mail is
 * the only thing sent to it, and it carries no tenant-authored text.
 */
'use strict';

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { callableRateLimit, assertNotViewer } = require('./shared');
const { enforceRateLimit, clientIp, rateLimitIpKey } = require('./rate-limit');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const { secretOr } = require('./integrations/_shared');
const AR = require('./alert-recipients');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const CONFIRM_URL_BASE = 'https://nobigdealwithjoedeal.com/alert-confirm/';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function mintToken() { return crypto.randomBytes(32).toString('base64url'); }

async function contactEmailFor(db, companyId) {
  try {
    const snap = await db.collection('companyProfile').doc(String(companyId)).get();
    const c = (((snap.exists ? snap.data() : {}) || {}).brand || {}).contact || {};
    return { email: AR.normEmail(c.alertEmail), sms: AR.normPhone(c.alertSms) };
  } catch (e) {
    logger.warn('alertRecipients: profile read failed', { err: e && e.message });
    return { email: '', sms: '' };
  }
}

exports.alertRecipients = onCall(
  {
    region: 'us-central1',
    enforceAppCheck: true,
    timeoutSeconds: 20,
    memory: '256MiB',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'alertRecipients', 20, 60_000);

    const claims = request.auth.token || {};
    const companyId = String(claims.companyId || uid);
    const ownerUid = await AR.ownerUidFor(companyId);
    const isOwner = ownerUid === uid;
    if (!isOwner && claims.role !== 'company_admin') {
      throw new HttpsError('permission-denied', 'Only the owner or a company admin can manage alert contacts');
    }
    const action = String((request.data || {}).action || 'status');
    if (action !== 'status' && action !== 'send') throw new HttpsError('invalid-argument', 'Unknown action');

    const db = getFirestore();
    const owner = await AR.authOwner(ownerUid);
    const contact = await contactEmailFor(db, companyId);
    const confirmed = contact.email ? (await AR.confirmedKeys(companyId)).has(AR.addrKey(contact.email)) : false;
    let state = 'none';
    if (contact.email) {
      if (owner.email && contact.email === owner.email) state = 'owner';
      else state = confirmed ? 'confirmed' : 'unconfirmed';
    }
    const status = {
      state,
      ownerEmail: owner.email || null,
      contactEmail: contact.email || null,
      smsConfigured: !!contact.sms,
      smsMatchesOwnerPhone: !!(contact.sms && owner.phone && contact.sms === owner.phone),
    };
    if (action === 'status') return status;

    // ── send a confirmation link ──
    if (claims.email_verified !== true) {
      throw new HttpsError('failed-precondition', 'Verify your own email address first, then try again');
    }
    if (state !== 'unconfirmed') return Object.assign({ sent: false }, status);
    if (!owner.email) {
      throw new HttpsError('failed-precondition', 'The account owner\'s email is not verified yet');
    }
    try {
      await enforceRateLimit('alertConfirm:company', companyId, AR.CONFIRM_REQUESTS_PER_OWNER_DAY, AR.RECIPIENT_WINDOW_MS);
      await enforceRateLimit('alertConfirm:address', contact.email, AR.CONFIRM_REQUESTS_PER_ADDRESS_DAY, AR.RECIPIENT_WINDOW_MS);
    } catch (e) {
      if (e && e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many confirmation emails today. Try again tomorrow.');
      logger.warn('alertRecipients: limiter unavailable — sending', { err: e && e.message });
    }

    const token = mintToken();
    const ref = db.collection(AR.TOKEN_COLLECTION).doc(sha256(token));
    await ref.set({
      companyId, email: contact.email, requestedBy: uid,
      createdAtMs: Date.now(), expiresAtMs: Date.now() + AR.CONFIRM_TTL_MS,
    });
    const url = CONFIRM_URL_BASE + token;
    try {
      const { Resend } = require('resend');
      const resp = await new Resend(RESEND_API_KEY.value()).emails.send({
        from: secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com'),
        to: contact.email,
        subject: 'Confirm this address for new-lead alerts',
        // Email category: TRANSACTIONAL — a one-time confirmation the address's
        // own owner is asked to click. Carries no tenant-authored text.
        text: `The NBD Pro account ${owner.email} asked to send new-lead alerts to this address.\n\n`
          + `To allow it, open this link and press Confirm (valid 48 hours):\n${url}\n\n`
          + 'If you did not expect this, ignore this email. Nothing is sent to this address until it is confirmed.',
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;color:#12223d"><p>The NBD Pro account <strong>${esc(owner.email)}</strong> asked to send new-lead alerts to this address.</p>`
          + `<p><a href="${esc(url)}" style="background:#bd5728;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">Review and confirm</a></p>`
          + '<p style="font-size:12px;color:#666">The link is valid for 48 hours. If you did not expect this, ignore this email. Nothing is sent to this address until it is confirmed.</p></div>',
      });
      if (resendRejected(resp)) throw new Error(resendErrorMessage(resp));
    } catch (e) {
      await ref.delete().catch(() => {});
      logger.error('alertRecipients: confirmation email failed', { companyId, err: e && e.message });
      throw new HttpsError('unavailable', 'Could not send the confirmation email. Try again in a few minutes.');
    }
    return Object.assign({ sent: true }, status);
  }
);

// ── /alert-confirm/<token> ────────────────────────────────────────

function renderPage(heading, bodyHtml) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow"><title>Alert contact</title>'
    + '<style>body{margin:0;background:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#12223d}'
    + '.card{max-width:460px;margin:48px auto;background:#fff;border-radius:10px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.1)}'
    + 'h1{font-size:20px;margin:0 0 12px}p{margin:0 0 14px;font-size:15px}.muted{color:#6b7280;font-size:13px}'
    + 'button{display:block;width:100%;padding:13px 16px;border:0;border-radius:8px;background:#12223d;color:#fff;font-size:16px;font-weight:600;cursor:pointer}'
    + '</style></head><body><main class="card"><h1>' + esc(heading) + '</h1>' + bodyHtml + '</main></body></html>';
}

function send(res, status, html, method) {
  res.status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'private, no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .set('Referrer-Policy', 'no-referrer')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.send(method === 'HEAD' ? '' : html);
}

const INVALID = renderPage('This link isn\'t valid',
  '<p>This confirmation link is invalid, expired or already used. Ask the account owner to send a new one from Settings.</p>');

function tokenFromPath(p) {
  const m = String(p || '').match(/\/alert-confirm\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : '';
}

async function handleConfirm(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    res.set('Allow', 'GET, HEAD, POST');
    return send(res, 405, INVALID, method);
  }
  try {
    await enforceRateLimit('alertConfirm:ip', rateLimitIpKey(clientIp(req)), 30, 60_000);
  } catch (e) {
    if (e && e.rateLimited) {
      res.set('Retry-After', String(Math.ceil((e.retryAfterMs || 60_000) / 1000)));
      return send(res, 429, renderPage('Please try again in a minute', '<p>Too many requests from this network.</p>'), method);
    }
    logger.warn('confirmAlertRecipient: limiter unavailable', { err: e && e.message });
  }
  const token = tokenFromPath(req.path || req.url);
  if (!TOKEN_RE.test(token)) return send(res, 404, INVALID, method);

  const db = getFirestore();
  const ref = db.collection(AR.TOKEN_COLLECTION).doc(sha256(token));
  let tok = null;
  try {
    const snap = await ref.get();
    tok = snap && snap.exists ? (snap.data() || {}) : null;
  } catch (e) {
    logger.error('confirmAlertRecipient: token read failed', { err: e && e.message });
    return send(res, 503, renderPage('Something went wrong', '<p>Please try the link again in a few minutes.</p>'), method);
  }
  if (!tok || !tok.companyId || !tok.email || Number(tok.expiresAtMs || 0) < Date.now()) {
    return send(res, 404, INVALID, method);
  }

  if (method === 'POST') {
    try {
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (!cur.exists) throw Object.assign(new Error('used'), { code: 'used' });
        const target = db.collection(AR.CONFIRMED_COLLECTION).doc(String(tok.companyId));
        tx.set(target, {
          confirmed: {
            [AR.addrKey(tok.email)]: {
              email: tok.email, confirmedAtMs: Date.now(), requestedBy: String(tok.requestedBy || ''),
            },
          },
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.delete(ref);
      });
    } catch (e) {
      if (e && e.code === 'used') return send(res, 404, INVALID, method);
      logger.error('confirmAlertRecipient: record failed', { err: e && e.message });
      return send(res, 503, renderPage('We couldn\'t save that', '<p>Please press the button again in a minute.</p>'), method);
    }
    logger.info('confirmAlertRecipient: confirmed', { companyId: String(tok.companyId) });
    return send(res, 200, renderPage('Confirmed',
      '<p><strong>' + esc(tok.email) + '</strong> will now receive new-lead alerts for this company.</p>'
      + '<p class="muted">You can close this page.</p>'), method);
  }

  // GET / HEAD: read only.
  return send(res, 200, renderPage('Confirm lead alerts',
    '<p>Send new-lead alerts to <strong>' + esc(tok.email) + '</strong>?</p>'
    + '<form method="post"><button type="submit">Confirm</button></form>'
    + '<p class="muted" style="margin-top:14px">If you did not expect this, close this page. Nothing is sent until you confirm.</p>'), method);
}

// No enforceAppCheck on onRequest (tests/appcheck-onrequest-contract.test.js).
exports.confirmAlertRecipient = onRequest(
  { region: 'us-central1', maxInstances: 10, concurrency: 40, timeoutSeconds: 15, memory: '256MiB' },
  handleConfirm
);

Object.defineProperty(exports, '_internal', {
  enumerable: false,
  value: { handleConfirm, tokenFromPath, sha256 },
});
