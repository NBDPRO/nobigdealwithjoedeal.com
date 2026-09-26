/**
 * functions/esign-envelope.js — PDF-native envelope signing.
 *
 * The rep uploads ANY PDF — a supplier form, an insurance scope, a
 * manufacturer warranty, a contract we generated — places typed fields on
 * it, and sends one link. The homeowner opens it on a phone, pans and zooms
 * a real PDF, fills the fields, and a FLATTENED signed PDF comes back.
 *
 * This exists alongside remote-signing.js rather than replacing it. That
 * path signs generated HTML and is the one wired into the doc generator
 * today; this one accepts arbitrary PDFs, which it never could. Retiring it
 * is a later, separate decision.
 *
 * ─── WHAT THIS FIXES THAT THE HTML PATH GOT WRONG ──────────────────────
 * Each of these was a confirmed defect in the older flow, not a nicety:
 *
 *  - Signature was the ONLY field type, and its position was hardcoded in a
 *    template. Here the rep places signature / initials / date / text /
 *    checkbox anywhere, and the layout is data.
 *  - The rep could never see whether a link was delivered, opened, expired
 *    or revoked. Every envelope carries status + an append-only audit trail,
 *    and can be resent or voided.
 *  - A document with no signature field "signed" successfully. Here a send
 *    with zero fields is refused, and a submit that leaves a required field
 *    empty is refused by the stamping engine before anything is burned.
 *  - The audit trail lived in a record the rep could rewrite. esign_envelopes
 *    is `allow write: if false` — every mutation goes through this file.
 *  - Nothing recorded consent, IP, or user agent, so the executed record had
 *    no ESIGN Act evidence attached. All three are captured here, and the
 *    signer is shown the consent language before they can sign.
 *
 * SECURITY MODEL — mirrors the audited portal.js / remote-signing.js shape:
 *   - esign_tokens/{token} is admin-SDK only (firestore.rules)
 *   - 24 chars over a 32-char no-confusable alphabet (~120 bits)
 *   - server-checked expiry, SINGLE-USE (burned atomically on submit)
 *   - the two homeowner endpoints are deliberately unauthenticated (that is
 *     what a no-login signing link IS); compensating controls are the
 *     unguessable token, expiry, single-use burn, per-IP rate limits, CORS
 *     lockdown and payload caps.
 *   - the signer NEVER gets a Storage URL. Bytes are streamed through the
 *     function. The photo pipeline's permanent download tokens made every
 *     object URL-public and bypassed storage.rules entirely; this path does
 *     not repeat that.
 *   - every Storage path is confined to the owning rep's own prefix before
 *     it is read (the HTML path omitted this check; document-view.js has it).
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');

const { httpRateLimit, clientIp } = require('./integrations/upstash-ratelimit');
const { callableRateLimit, assertNotViewer } = require('./shared');
const { stampPdf, readPdfGeometry, validateFields, FIELD_TYPES } = require('./esign-stamp');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];
const SIGN_URL_BASE = 'https://nobigdealwithjoedeal.com/pro/esign.html?t=';

const TTL_DAYS = 14;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

// 32-char no-confusable alphabet (no 0/O, 1/I/L) — same as portal.js.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mintToken() {
  const bytes = crypto.randomBytes(24);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * Confine a Storage path to this rep's own envelope prefix.
 * sourcePath arrives from the client, so without this a rep could name any
 * object in the bucket and have us read it back out through a public,
 * unauthenticated signing endpoint.
 */
function isOwnEnvelopePath(p, uid, leadId, envelopeId) {
  if (typeof p !== 'string' || p.length > 400) return false;
  if (p.includes('..')) return false;
  return p === `esign/${uid}/${leadId}/${envelopeId}/source.pdf`;
}

/**
 * How to answer a submit whose token is no longer 'pending'. Mirrors
 * getEsignEnvelope's distinct signed/revoked/inactive handling (see that
 * function's own comment) — 'revoked' is NOT 'signed', and telling a signer
 * whose link was just superseded by a resend that "this document has
 * already been signed" is both false and gives them nothing to act on.
 */
function nonPendingTokenResponse(status) {
  if (status === 'signed') {
    return { status: 409, body: { error: 'This document has already been signed.', reason: 'signed' } };
  }
  if (status === 'revoked') {
    return {
      status: 409,
      body: { error: 'This link was cancelled — your rep sent a new one. Please use the latest link.', reason: 'revoked' },
    };
  }
  return { status: 409, body: { error: 'This link is no longer active.', reason: 'inactive' } };
}

/** The signer-facing view of an envelope. Never leaks lead internals. */
function publicEnvelope(env) {
  return {
    title: env.title || 'Document',
    fields: (env.fields || []).map((f) => ({
      id: f.id, type: f.type, page: f.page,
      x: f.x, y: f.y, w: f.w, h: f.h,
      required: f.required !== false,
      label: f.label || '',
      role: f.role || 'signer',
    })),
    pages: env.pages || [],
    signerName: env.signerName || '',
    companyName: env.companyName || '',
  };
}

async function loadOwnedEnvelope(db, envelopeId, uid) {
  if (typeof envelopeId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(envelopeId)) {
    throw new HttpsError('invalid-argument', 'Bad envelope id');
  }
  const snap = await db.doc(`esign_envelopes/${envelopeId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Envelope not found');
  const env = snap.data();
  if (env.ownerUid !== uid) throw new HttpsError('permission-denied', 'Not your envelope');
  return { ref: snap.ref, env };
}

// ═══════════════════════════════════════════════════════════════
// createEsignEnvelope — rep registers an uploaded PDF as an envelope.
// The client has already uploaded to esign/{uid}/{leadId}/{envelopeId}/
// source.pdf under storage.rules; this reads it back to establish the page
// geometry and the source digest SERVER-SIDE, so neither is client-asserted.
// ═══════════════════════════════════════════════════════════════
exports.createEsignEnvelope = onCall(
  {
    region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true,
    timeoutSeconds: 60, memory: '512MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B): a viewer is read-only. The four envelope
    // writers (create / save fields / send / void) check lead or envelope
    // OWNERSHIP only, which a viewer can hold — refused first.
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'createEsignEnvelope', 30, 60_000);

    const { leadId, envelopeId, sourcePath, title } = request.data || {};
    if (typeof leadId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(leadId)) {
      throw new HttpsError('invalid-argument', 'Bad lead id');
    }
    if (typeof envelopeId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(envelopeId)) {
      throw new HttpsError('invalid-argument', 'Bad envelope id');
    }
    if (!isOwnEnvelopePath(sourcePath, uid, leadId, envelopeId)) {
      logger.error('[createEsignEnvelope] path outside caller prefix', { uid, leadId, envelopeId, sourcePath });
      throw new HttpsError('permission-denied', 'Document path is not readable');
    }

    const db = getFirestore();
    const leadSnap = await db.doc(`leads/${leadId}`).get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
    const lead = leadSnap.data();
    if (lead.userId !== uid) throw new HttpsError('permission-denied', 'Not your lead');

    // Refuse to overwrite an envelope that already exists — an envelope id
    // is minted client-side, and re-registering a SENT one would silently
    // reset its audit trail.
    const existing = await db.doc(`esign_envelopes/${envelopeId}`).get();
    if (existing.exists) throw new HttpsError('already-exists', 'Envelope already exists');

    let buf;
    try {
      const [meta] = await getStorage().bucket().file(sourcePath).getMetadata();
      if (Number(meta.size) > MAX_PDF_BYTES) {
        throw new HttpsError('invalid-argument', 'PDF is larger than 25 MB');
      }
      [buf] = await getStorage().bucket().file(sourcePath).download();
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('[createEsignEnvelope] source unreadable', { sourcePath, err: e.message });
      throw new HttpsError('failed-precondition', 'Could not read the uploaded PDF');
    }
    if (buf.slice(0, 5).toString() !== '%PDF-') {
      throw new HttpsError('invalid-argument', 'That file is not a PDF');
    }

    let pages;
    try {
      pages = await readPdfGeometry(buf);
    } catch (e) {
      // Encrypted and malformed PDFs both land here. Say which, because
      // "try again" is useless advice for a password-protected file.
      logger.warn('[createEsignEnvelope] geometry read failed', { envelopeId, err: e.message });
      throw new HttpsError('invalid-argument',
        /encrypt/i.test(e.message || '')
          ? 'That PDF is password-protected. Remove the password and re-upload.'
          : 'That PDF could not be read. It may be corrupt.');
    }
    if (!pages.length) throw new HttpsError('invalid-argument', 'That PDF has no pages');
    if (pages.length > 100) throw new HttpsError('invalid-argument', 'That PDF has more than 100 pages');

    let companyName = '';
    const tenantKey = lead.companyId || lead.userId;
    if (tenantKey) {
      try {
        const cp = await db.doc(`companyProfile/${tenantKey}`).get();
        if (cp.exists) {
          const ln = ((cp.data() || {}).brand || {}).legalName || '';
          companyName = (ln && ln !== 'No Big Deal Home Solutions') ? ln : '';
        }
      } catch (e) { logger.warn('[createEsignEnvelope] tenant resolve failed', { err: e.message }); }
    }

    await db.doc(`esign_envelopes/${envelopeId}`).set({
      ownerUid: uid,
      companyId: lead.companyId || null,
      companyName,
      leadId,
      title: (typeof title === 'string' ? title : '').slice(0, 200) || 'Document',
      sourcePath,
      sourceSha256: sha256(buf),
      sourceBytes: buf.length,
      pages,
      pageCount: pages.length,
      fields: [],
      status: 'draft',
      createdAt: FieldValue.serverTimestamp(),
      audit: [{ event: 'created', at: Date.now(), by: uid }],
    });

    logger.info('[createEsignEnvelope] created', { envelopeId, leadId, pages: pages.length });
    return { envelopeId, pages, pageCount: pages.length };
  }
);

// ═══════════════════════════════════════════════════════════════
// saveEsignFields — rep persists the field layout (PDF points).
// ═══════════════════════════════════════════════════════════════
exports.saveEsignFields = onCall(
  {
    region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true,
    timeoutSeconds: 30, memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    assertNotViewer(request.auth.token); // decision B — see createEsignEnvelope
    await callableRateLimit(request, 'saveEsignFields', 120, 60_000);

    const { envelopeId, fields, signerName, signerEmail, title } = request.data || {};
    const db = getFirestore();
    const { ref, env } = await loadOwnedEnvelope(db, envelopeId, uid);

    // A sent envelope's layout is part of what the signer was shown. Editing
    // it underneath a live link would change the document mid-signing.
    if (env.status !== 'draft') {
      throw new HttpsError('failed-precondition',
        'This envelope has already been sent. Void it and start a new one to change the fields.');
    }

    try {
      validateFields(fields, env.pageCount || (env.pages || []).length);
    } catch (e) {
      throw new HttpsError('invalid-argument', e.message);
    }

    const patch = {
      fields: fields.map((f) => ({
        id: f.id, type: f.type, page: f.page,
        x: f.x, y: f.y, w: f.w, h: f.h,
        required: f.required !== false,
        label: typeof f.label === 'string' ? f.label.slice(0, 200) : '',
        role: typeof f.role === 'string' ? f.role.slice(0, 64) : 'signer',
      })),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (typeof signerName === 'string') patch.signerName = signerName.slice(0, 200);
    if (typeof signerEmail === 'string') patch.signerEmail = signerEmail.slice(0, 320);
    if (typeof title === 'string' && title.trim()) patch.title = title.slice(0, 200);

    await ref.set(patch, { merge: true });
    return { ok: true, fieldCount: patch.fields.length };
  }
);

// ═══════════════════════════════════════════════════════════════
// getEsignEnvelopeForOwner — the rep re-opens a draft to keep placing fields.
//
// A callable rather than a direct Storage read on purpose. Reading the object
// from the browser needs either bucket CORS configured for the app origin, or
// getDownloadURL — and getDownloadURL MINTS A PERMANENT DOWNLOAD TOKEN that
// bypasses storage.rules for the life of the object. That is the exact defect
// that left every photo in the bucket publicly fetchable. Streaming the bytes
// through an authenticated callable has neither problem.
// ═══════════════════════════════════════════════════════════════
exports.getEsignEnvelopeForOwner = onCall(
  {
    region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true,
    timeoutSeconds: 60, memory: '512MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    await callableRateLimit(request, 'getEsignEnvelopeForOwner', 60, 60_000);

    const db = getFirestore();
    const { env } = await loadOwnedEnvelope(db, request.data && request.data.envelopeId, uid);
    if (!isOwnEnvelopePath(env.sourcePath, env.ownerUid, env.leadId, request.data.envelopeId)) {
      throw new HttpsError('failed-precondition', 'Document path is not readable');
    }
    let buf;
    try {
      [buf] = await getStorage().bucket().file(env.sourcePath).download();
    } catch (e) {
      logger.error('[getEsignEnvelopeForOwner] download failed', { err: e.message });
      throw new HttpsError('failed-precondition', 'Could not read the stored PDF');
    }
    return {
      envelopeId: request.data.envelopeId,
      title: env.title || 'Document',
      leadId: env.leadId,
      status: env.status || 'draft',
      pages: env.pages || [],
      fields: env.fields || [],
      signerName: env.signerName || '',
      signerEmail: env.signerEmail || '',
      pdf: buf.toString('base64'),
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// sendEsignEnvelope — mint a single-use link and email it.
// Also the RESEND path: calling it again on a sent envelope rotates the
// token (revoking the old link) rather than minting a second live one.
// ═══════════════════════════════════════════════════════════════
exports.sendEsignEnvelope = onCall(
  {
    region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true,
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    timeoutSeconds: 30, memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    assertNotViewer(request.auth.token); // decision B — see createEsignEnvelope
    await callableRateLimit(request, 'sendEsignEnvelope', 20, 60_000);

    const { envelopeId, signerName, signerEmail, sendEmail } = request.data || {};
    const db = getFirestore();
    const { ref, env } = await loadOwnedEnvelope(db, envelopeId, uid);

    if (env.status === 'completed') {
      throw new HttpsError('failed-precondition', 'This envelope is already signed.');
    }
    if (!Array.isArray(env.fields) || env.fields.length === 0) {
      // The exact hole the HTML path had: a document with nothing to sign
      // that still reported a successful signature.
      throw new HttpsError('failed-precondition',
        'Place at least one field before sending — a document with no fields cannot be signed.');
    }
    if (!env.fields.some((f) => f && f.required !== false)) {
      // Same hole, different door: every field toggled to optional (one
      // click each, no confirmation) leaves requiredFields() empty on the
      // signer's page, so Finish enables with nothing filled in and the
      // document "signs" with values = {}. Refuse to send a layout that
      // cannot actually require anything.
      throw new HttpsError('failed-precondition',
        'At least one field must be required before sending — a document where every field is optional can be "signed" with nothing filled in.');
    }

    const name = (typeof signerName === 'string' && signerName.trim()) || env.signerName || '';
    const email = (typeof signerEmail === 'string' && signerEmail.trim()) || env.signerEmail || '';
    if (sendEmail !== false && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpsError('invalid-argument', 'A valid signer email is required to send the link');
    }

    // Rotate: revoke any live token for this envelope before minting.
    const live = await db.collection('esign_tokens')
      .where('envelopeId', '==', envelopeId).where('status', '==', 'pending').get();
    const batch = db.batch();
    live.forEach((d) => batch.update(d.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp() }));
    await batch.commit();

    const token = mintToken();
    const expiresAt = Timestamp.fromMillis(Date.now() + TTL_DAYS * 86_400_000);
    await db.doc(`esign_tokens/${token}`).set({
      envelopeId, ownerUid: uid, leadId: env.leadId,
      status: 'pending', mintedAt: FieldValue.serverTimestamp(), expiresAt,
    });

    const link = SIGN_URL_BASE + token;
    let emailed = false;
    if (sendEmail !== false) {
      try {
        const { Resend } = require('resend');
        const resend = new Resend(RESEND_API_KEY.value());
        const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
        const brand = escHtml(env.companyName || 'No Big Deal Home Solutions');
        // Email category: TRANSACTIONAL — a contract / document envelope to sign. Not gated by the unsubscribe register (email-suppression.js SEND_PATHS).
        const response = await resend.emails.send({
          from, to: email,
          subject: `Please sign: ${env.title || 'your document'}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#12223d;">
            <p>Hi ${escHtml(name || 'there')},</p>
            <p>${brand} has <strong>${escHtml(env.title || 'a document')}</strong> ready for your signature.
               You can review and sign it right on your phone — it takes about a minute.</p>
            <p style="text-align:center;margin:28px 0;">
              <a href="${escHtml(link)}" style="background:#bd5728;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;display:inline-block;">Review &amp; Sign</a>
            </p>
            <p style="font-size:12px;color:#666;">This secure link expires in ${TTL_DAYS} days and can only be used once.
               If you weren't expecting this, you can ignore this email.</p>
          </div>`,
        });
        // Resend resolves { data: null, error } on an API-level rejection
        // instead of throwing — treat that the same as a thrown error so
        // `emailed` (persisted below and returned to the rep) isn't a lie.
        if (resendRejected(response)) {
          throw new Error(resendErrorMessage(response));
        }
        emailed = true;
      } catch (e) {
        // Do NOT swallow this into a cheerful response. The old path told the
        // rep "still sending" on a hard failure and never showed the link, so
        // a bounced signing email looked like a slow one forever.
        logger.error('[sendEsignEnvelope] email send failed', { envelopeId, err: e.message });
      }
    }

    await ref.set({
      status: 'sent',
      signerName: name || null,
      signerEmail: email || null,
      sentAt: FieldValue.serverTimestamp(),
      lastLinkEmailed: emailed,
      audit: FieldValue.arrayUnion({
        event: env.status === 'draft' ? 'sent' : 'resent',
        at: Date.now(), by: uid, emailed,
      }),
    }, { merge: true });

    // The link is ALWAYS returned, emailed or not, so the rep can text it or
    // hand the phone over when email fails or is not wanted.
    return { ok: true, link, token, emailed, expiresAt: expiresAt.toMillis() };
  }
);

// ═══════════════════════════════════════════════════════════════
// voidEsignEnvelope — revoke the live link.
// ═══════════════════════════════════════════════════════════════
exports.voidEsignEnvelope = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20 },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    assertNotViewer(request.auth.token); // decision B — see createEsignEnvelope
    await callableRateLimit(request, 'voidEsignEnvelope', 30, 60_000);

    const db = getFirestore();
    const { ref, env } = await loadOwnedEnvelope(db, request.data && request.data.envelopeId, uid);
    if (env.status === 'completed') {
      throw new HttpsError('failed-precondition', 'A signed envelope cannot be voided.');
    }
    const live = await db.collection('esign_tokens')
      .where('envelopeId', '==', ref.id).where('status', '==', 'pending').get();
    const batch = db.batch();
    live.forEach((d) => batch.update(d.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp() }));
    await batch.commit();

    await ref.set({
      status: 'voided',
      voidedAt: FieldValue.serverTimestamp(),
      audit: FieldValue.arrayUnion({ event: 'voided', at: Date.now(), by: uid }),
    }, { merge: true });
    return { ok: true, revoked: live.size };
  }
);

// ═══════════════════════════════════════════════════════════════
// getEsignEnvelope — homeowner POSTs token → the PDF + the field layout.
// ═══════════════════════════════════════════════════════════════
exports.getEsignEnvelope = onRequest(
  {
    region: 'us-central1', cors: CORS_ORIGINS,
    maxInstances: 40, concurrency: 20, timeoutSeconds: 30, memory: '512MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'esign-get:ip', 30, 60_000))) return;

    const token = (req.body && req.body.token) || '';
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid link' }); return;
    }

    const db = getFirestore();
    const tokSnap = await db.doc(`esign_tokens/${token}`).get();
    if (!tokSnap.exists) { res.status(404).json({ error: 'This signing link is not valid.' }); return; }
    const tok = tokSnap.data();

    // Expired, revoked and already-signed are reported DISTINCTLY. The old
    // path told a homeowner with an expired link "already signed", which is
    // both false and un-actionable.
    if (tok.status === 'signed') {
      res.status(410).json({ error: 'This document has already been signed.', reason: 'signed' }); return;
    }
    if (tok.status === 'revoked') {
      res.status(410).json({ error: 'This link was cancelled by your rep. Please ask them for a new one.', reason: 'revoked' }); return;
    }
    if (tok.status !== 'pending') {
      res.status(410).json({ error: 'This link is no longer active.', reason: 'inactive' }); return;
    }
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'This signing link has expired. Please ask your rep for a new one.', reason: 'expired' }); return;
    }

    const envSnap = await db.doc(`esign_envelopes/${tok.envelopeId}`).get();
    if (!envSnap.exists) { res.status(404).json({ error: 'This document is no longer available.' }); return; }
    const env = envSnap.data();
    if (env.status === 'voided') {
      res.status(410).json({ error: 'This document was cancelled by your rep.', reason: 'revoked' }); return;
    }
    if (!isOwnEnvelopePath(env.sourcePath, env.ownerUid, env.leadId, tok.envelopeId)) {
      logger.error('[getEsignEnvelope] sourcePath outside owner prefix', { envelopeId: tok.envelopeId });
      res.status(500).json({ error: 'This document could not be loaded.' }); return;
    }

    let buf;
    try {
      [buf] = await getStorage().bucket().file(env.sourcePath).download();
    } catch (e) {
      logger.error('[getEsignEnvelope] source download failed', { envelopeId: tok.envelopeId, err: e.message });
      res.status(500).json({ error: 'Could not load the document. Please try again shortly.' }); return;
    }

    // First view wins: the old path's fire-and-forget stamp recorded the LAST
    // view, losing the one fact that matters for a dispute.
    const patch = { audit: FieldValue.arrayUnion({ event: 'viewed', at: Date.now(), ip: clientIp(req) || null }) };
    if (!env.viewedAt) patch.viewedAt = FieldValue.serverTimestamp();
    if (env.status === 'sent') patch.status = 'viewed';
    db.doc(`esign_envelopes/${tok.envelopeId}`).set(patch, { merge: true }).catch(() => {});

    res.status(200).json(Object.assign(publicEnvelope(env), {
      pdf: buf.toString('base64'),
      consentText:
        'By signing electronically I agree that my electronic signature is the legal ' +
        'equivalent of my handwritten signature, and I consent to do business electronically.',
    }));
  }
);

// ═══════════════════════════════════════════════════════════════
// submitEsignEnvelope — homeowner POSTs field values → flattened signed PDF.
// ═══════════════════════════════════════════════════════════════
exports.submitEsignEnvelope = onRequest(
  {
    region: 'us-central1', cors: CORS_ORIGINS,
    maxInstances: 20, concurrency: 10, timeoutSeconds: 120, memory: '1GiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'esign-submit:ip', 20, 60_000))) return;

    const { token, values, consent, signerName } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid link' }); return;
    }
    // Consent is a gate, not a checkbox we log. Without an affirmative record
    // of consent to transact electronically, the executed document is far
    // weaker evidence than it looks.
    if (consent !== true) {
      res.status(400).json({ error: 'Please agree to sign electronically before submitting.' }); return;
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      res.status(400).json({ error: 'No field values were submitted.' }); return;
    }
    if (Object.keys(values).length === 0) {
      // Belt to sendEsignEnvelope's "at least one required field" brace: an
      // envelope sent before that guard existed (or otherwise reached with
      // every field optional) must still not "sign" with nothing entered.
      res.status(400).json({ error: 'Please complete at least one field before submitting.' }); return;
    }
    if (Object.keys(values).length > 200) {
      res.status(413).json({ error: 'Too many values submitted.' }); return;
    }
    // Signature PNGs dominate the payload; cap before we do any work.
    const approxBytes = JSON.stringify(values).length;
    if (approxBytes > 12 * 1024 * 1024) {
      res.status(413).json({ error: 'The signed document is too large.' }); return;
    }

    const db = getFirestore();
    const tokRef = db.doc(`esign_tokens/${token}`);
    const pre = await tokRef.get();
    if (!pre.exists) { res.status(404).json({ error: 'This signing link is not valid.' }); return; }
    const tok = pre.data();
    if (tok.status !== 'pending') {
      // 'revoked' is not 'signed' — the exact false, un-actionable message
      // getEsignEnvelope was rebuilt to stop giving (see its own comment
      // above). Reachable in the ordinary course of business: the rep hits
      // "resend" (which revokes the live token) while the original signer
      // still has the old link open and submits from it.
      const nonPending = nonPendingTokenResponse(tok.status);
      res.status(nonPending.status).json(nonPending.body); return;
    }
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'This signing link has expired.', reason: 'expired' }); return;
    }

    const envRef = db.doc(`esign_envelopes/${tok.envelopeId}`);
    const envSnap = await envRef.get();
    if (!envSnap.exists) { res.status(404).json({ error: 'This document is no longer available.' }); return; }
    const env = envSnap.data();
    if (env.status === 'voided') { res.status(410).json({ error: 'This document was cancelled.' }); return; }
    if (!isOwnEnvelopePath(env.sourcePath, env.ownerUid, env.leadId, tok.envelopeId)) {
      logger.error('[submitEsignEnvelope] sourcePath outside owner prefix', { envelopeId: tok.envelopeId });
      res.status(500).json({ error: 'This document could not be processed.' }); return;
    }

    // ── Stamp BEFORE the burn ────────────────────────────────────────────
    // A submission that cannot produce a valid document must not consume the
    // homeowner's one-shot token — otherwise one bad payload griefs a real
    // signing, and a signer who misses a required field can never retry.
    let source;
    try {
      [source] = await getStorage().bucket().file(env.sourcePath).download();
    } catch (e) {
      logger.error('[submitEsignEnvelope] source unreadable — refusing', { envelopeId: tok.envelopeId, err: e.message });
      res.status(503).json({ error: 'Could not verify the document right now. Please try again shortly.' }); return;
    }
    // The source must be the exact document the fields were placed on. If it
    // changed under us, nothing downstream is trustworthy.
    if (env.sourceSha256 && sha256(source) !== env.sourceSha256) {
      logger.error('[submitEsignEnvelope] SOURCE PDF CHANGED SINCE PLACEMENT — refusing', { envelopeId: tok.envelopeId });
      res.status(409).json({ error: 'This document changed since it was sent. Please ask your rep for a new link.' }); return;
    }

    const when = new Date();
    const ip = clientIp(req) || null;
    const ua = String(req.get('user-agent') || '').slice(0, 300);

    let stamped;
    try {
      stamped = await stampPdf(source, env.fields || [], values, {
        certificateLine:
          `Signed electronically ${when.toISOString()} · envelope ${tok.envelopeId} · ` +
          `${(signerName || env.signerName || 'signer')}`.slice(0, 160),
      });
    } catch (e) {
      logger.error('[submitEsignEnvelope] stamping failed', { envelopeId: tok.envelopeId, err: e.message });
      res.status(422).json({ error: 'Could not apply your signature to the document. Please reload and try again.' });
      return;
    }
    if (stamped.missingRequired.length) {
      res.status(422).json({
        error: 'Please complete every required field before submitting.',
        missing: stamped.missingRequired,
      });
      return;
    }

    // ── Atomic single-use burn ───────────────────────────────────────────
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) { const e = new Error('nf'); e._http = 404; e._msg = 'This signing link is not valid.'; throw e; }
        const t = snap.data();
        if (t.status !== 'pending') {
          // Same distinction as the pre-check above — a resend can revoke
          // the token in the window between that read and this transaction.
          const r = nonPendingTokenResponse(t.status);
          const e = new Error(t.status); e._http = r.status; e._msg = r.body.error; e._reason = r.body.reason;
          throw e;
        }
        if (t.expiresAt && t.expiresAt.toMillis && t.expiresAt.toMillis() < Date.now()) {
          const e = new Error('exp'); e._http = 410; e._msg = 'This signing link has expired.'; e._reason = 'expired'; throw e;
        }
        tx.update(tokRef, { status: 'signed', signedAt: FieldValue.serverTimestamp() });
      });
    } catch (err) {
      if (err && err._http) {
        res.status(err._http).json(err._reason ? { error: err._msg, reason: err._reason } : { error: err._msg });
        return;
      }
      logger.error('[submitEsignEnvelope] burn txn failed', { msg: err.message });
      res.status(500).json({ error: 'Could not record your signature. Please try again.' }); return;
    }

    // Token burned. Persist the executed record.
    // The SOURCE IS NEVER OVERWRITTEN — the signed copy is a new object. The
    // HTML path wrote the counterparty's bytes over the served original and
    // had to archive it aside first to have anything left to compare against.
    const signedPath = `esign/${env.ownerUid}/${env.leadId}/${tok.envelopeId}/signed.pdf`;
    const signedBuf = Buffer.from(stamped.bytes);
    let stored = false;
    try {
      await getStorage().bucket().file(signedPath).save(signedBuf, {
        contentType: 'application/pdf', resumable: false,
      });
      stored = true;
    } catch (e) {
      logger.error('[submitEsignEnvelope] signed pdf upload FAILED', { envelopeId: tok.envelopeId, err: e.message });
    }

    try {
      await envRef.set({
        status: 'completed',
        signedAt: FieldValue.serverTimestamp(),
        signedPath: stored ? signedPath : null,
        signedSha256: sha256(signedBuf),
        signedBytes: signedBuf.length,
        remoteSignerName: (typeof signerName === 'string' ? signerName.slice(0, 200) : '') || env.signerName || null,
        consent: { agreed: true, at: Date.now(), ip, ua },
        audit: FieldValue.arrayUnion({ event: 'signed', at: Date.now(), ip, ua, stored }),
      }, { merge: true });
    } catch (e) { logger.error('[submitEsignEnvelope] envelope stamp failed', { err: e.message }); }

    try {
      await db.collection('notifications').add({
        userId: env.ownerUid,
        type: 'esign_completed',
        leadId: env.leadId,
        title: 'Document signed',
        message: `${(signerName || env.signerName || 'A homeowner')} signed ${env.title || 'a document'}.`,
        priority: 'high', read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { logger.warn('[submitEsignEnvelope] notify failed', { err: e.message }); }

    res.status(200).json({ ok: true });
  }
);

// NOTHING else is exported from this file. index.js does
// `Object.assign(exports, require('./esign-envelope'))`, and the Firebase CLI
// reads a plain object export as a function GROUP — an `exports._internal`
// convenience for tests would deploy phantom functions like
// `_internal-isOwnEnvelopePath`. tests/esign-envelope.test.js extracts the
// helpers it needs from the source with vm, the same way
// signature-document-integrity.test.js does.
