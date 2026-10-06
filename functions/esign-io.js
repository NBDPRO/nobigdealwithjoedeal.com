/**
 * functions/esign-io.js — the side-effecting helpers the envelope functions
 * share: mint a signer's link, send an email, mirror status onto the estimate.
 *
 * Its own module (not esign-envelope.js) because index.js does
 * Object.assign(exports, require('./esign-envelope')) and the Firebase CLI
 * deploys every export of that file as a function. Helpers live here so
 * esign-envelope.js and esign-reminders.js can both use them without either
 * exporting anything but functions.
 *
 * EMULATOR: sendMail never sends from the Functions emulator. A local run with
 * real secrets loaded has texted and emailed Jo twice (2026-09-30, 2026-10-04);
 * e-sign links go to homeowners, so the emulator logs the message instead.
 */
'use strict';

const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const ESL = require('./esign-logic');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const SIGN_URL_BASE = 'https://nobigdealwithjoedeal.com/pro/esign.html?t=';
const TTL_DAYS = 14;

// 32-char no-confusable alphabet (no 0/O, 1/I/L) — same as portal.js.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mintToken() {
  const bytes = crypto.randomBytes(24);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function inEmulator() {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

/**
 * Send one transactional email through Resend. Returns { emailed, stubbed }.
 * Throws on a send failure so the caller decides whether that is fatal (it
 * never is for a signing link — the link is always returned to the rep).
 */
async function sendMail(msg) {
  if (inEmulator()) {
    logger.info('[esign] email NOT sent (emulator stub)', { to: msg && msg.to, subject: msg && msg.subject });
    return { emailed: false, stubbed: true };
  }
  const { Resend } = require('resend');
  const resend = new Resend(RESEND_API_KEY.value());
  const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
  // Email category: TRANSACTIONAL — a document the recipient was sent to sign,
  // or their signed copy. Not gated by the unsubscribe register
  // (email-suppression.js SEND_PATHS).
  const response = await resend.emails.send(Object.assign({ from }, msg));
  if (resendRejected(response)) throw new Error(resendErrorMessage(response));
  return { emailed: true, stubbed: false };
}

/** Revoke every live (pending) token on an envelope. Returns how many. */
async function revokeLiveTokens(db, envelopeId) {
  const live = await db.collection('esign_tokens')
    .where('envelopeId', '==', envelopeId).where('status', '==', 'pending').get();
  if (!live.size) return 0;
  const batch = db.batch();
  live.forEach((d) => batch.update(d.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp() }));
  await batch.commit();
  return live.size;
}

/**
 * Mint a single-use link for ONE signer, revoking any other live link on the
 * envelope first (one live link per envelope, always — the signer whose turn
 * it is). Returns { token, link, expiresAtMs }.
 */
async function mintSignerLink(db, envelopeId, env, signer) {
  await revokeLiveTokens(db, envelopeId);
  const token = mintToken();
  const expiresAtMs = Date.now() + TTL_DAYS * 86_400_000;
  await db.doc(`esign_tokens/${token}`).set({
    envelopeId, ownerUid: env.ownerUid, leadId: env.leadId,
    signerId: signer.id,
    status: 'pending', mintedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(expiresAtMs),
  });
  return { token, link: SIGN_URL_BASE + token, expiresAtMs };
}

/** Email a signer their link. Returns { emailed, stubbed, error }. Never throws. */
async function emailLink(env, signer, link, opts) {
  if (!signer || !signer.email || !ESL.EMAIL_RE.test(signer.email)) return { emailed: false, stubbed: false, error: 'no email' };
  try {
    const m = ESL.linkEmail({
      brand: env.companyName, tenantKey: env.companyId || env.ownerUid, name: signer.name, title: env.title, link,
      ttlDays: TTL_DAYS, reminder: !!(opts && opts.reminder),
    });
    const r = await sendMail({ to: signer.email, subject: m.subject, html: m.html });
    return Object.assign({ error: null }, r);
  } catch (e) {
    logger.error('[esign] link email failed', { err: e && e.message });
    return { emailed: false, stubbed: false, error: String((e && e.message) || e) };
  }
}

/**
 * Mirror an envelope event onto estimates/{estimateId} — the fields the
 * BoldSign webhook used to write (signatureStatus et al.), so every CRM
 * surface that reads them keeps working. A 'sent' always writes (it is the
 * send that points the estimate at this envelope); any later event writes
 * only while the estimate still points at THIS envelope, so a superseded
 * envelope can never move a newer one's status. Never throws.
 */
async function syncEstimate(db, envelopeId, env, event, extra) {
  if (!env || !env.estimateId) return false;
  const status = ESL.estimateStatusFor(event);
  if (!status) return false;
  try {
    const ref = db.doc(`estimates/${env.estimateId}`);
    if (event !== 'sent' && event !== 'resent') {
      const snap = await ref.get();
      if (!snap.exists) return false;
      const cur = snap.data() || {};
      if (cur.signatureEnvelopeId && cur.signatureEnvelopeId !== envelopeId) return false;
    }
    const patch = Object.assign({
      signatureStatus: status,
      signatureProvider: 'nbd-esign',
      signatureEnvelopeId: envelopeId,
      signatureUpdatedAt: FieldValue.serverTimestamp(),
    }, extra || {});
    if (event === 'completed') patch.signedAt = FieldValue.serverTimestamp();
    await ref.update(patch);
    return true;
  } catch (e) {
    logger.warn('[esign] estimate status sync failed', { envelopeId, event, err: e && e.message });
    return false;
  }
}

/** Bell notification for the rep. Never throws. */
async function notifyRep(db, env, n) {
  try {
    await db.collection('notifications').add(Object.assign({
      userId: env.ownerUid, leadId: env.leadId || null, priority: 'high', read: false,
      createdAt: FieldValue.serverTimestamp(),
    }, n));
  } catch (e) { logger.warn('[esign] notify failed', { err: e && e.message }); }
}

module.exports = {
  RESEND_API_KEY, EMAIL_FROM, SIGN_URL_BASE, TTL_DAYS,
  mintToken, sha256, inEmulator, sendMail, revokeLiveTokens, mintSignerLink, emailLink, syncEstimate, notifyRep,
};
