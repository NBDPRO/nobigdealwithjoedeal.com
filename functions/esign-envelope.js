/**
 * functions/esign-envelope.js — PDF-native envelope signing.
 *
 * The rep uploads ANY PDF — a supplier form, an insurance scope, a
 * manufacturer warranty, a contract we generated — places typed fields on
 * it, and sends one link. The homeowner opens it on a phone, pans and zooms
 * a real PDF, fills the fields, and a FLATTENED signed PDF comes back.
 *
 * Since 2026-10-04 this is also where the estimate builder's "Send for
 * signature" goes (sendEstimateEnvelope, below) — BoldSign is retired. The
 * gaps closed that day, each against what BoldSign would have given us
 * (functions/esign-logic.js carries the pure rules):
 *   - MULTI-SIGNER: up to 4 signers, in order, each on their own link, each
 *     able to fill only their own fields.
 *   - EVIDENCE PER SIGNER: consent (with the text shown), IP, user agent,
 *     time, typed name and a digest of the submitted values — and a
 *     signature certificate page on the executed PDF that prints all of it.
 *   - The signed PDF is EMAILED to every signer, not just stored.
 *   - DECLINE (declineEsignEnvelope), REMINDERS and EXPIRY
 *     (esign-reminders.js), alongside the existing void and resend.
 *   - The estimate's signatureStatus mirrors the envelope.
 *
 * This exists alongside remote-signing.js rather than replacing it. That
 * path signs generated HTML and is the one wired into the doc generator.
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
 *   - the homeowner endpoints are deliberately unauthenticated (that is
 *     what a no-login signing link IS); compensating controls are the
 *     unguessable token, expiry, single-use burn, per-IP rate limits, CORS
 *     lockdown and payload caps.
 *   - the signer NEVER gets a Storage URL. Bytes are streamed through the
 *     function. The photo pipeline's permanent download tokens made every
 *     object URL-public and bypassed storage.rules entirely; this path does
 *     not repeat that.
 *   - every Storage path is confined to the owning rep's own prefix before
 *     it is read (the HTML path omitted this check; document-view.js has it).
 *   - a signer's submitted values wait for the last signer under
 *     esign-vault/{envelopeId}/ — a prefix storage.rules gives NO client, not
 *     even the rep (an interested party to the contract), and whose digest is
 *     recorded in the signer's evidence and re-checked before stamping.
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const { httpRateLimit, clientIp } = require('./integrations/upstash-ratelimit');
const { callableRateLimit, assertNotViewer } = require('./shared');
const { stampPdf, readPdfGeometry, validateFields, appendAuditCertificate } = require('./esign-stamp');
const { spineAfterEsign } = require('./job-spine');
const ESL = require('./esign-logic');
const IO = require('./esign-io');
const CW = require('./cancel-window');

const { RESEND_API_KEY, EMAIL_FROM, TTL_DAYS, sha256 } = IO;

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

const MAX_PDF_BYTES = 25 * 1024 * 1024;
// Signed copies above this go out without the attachment (the email says so);
// Resend's own ceiling is 40 MB per message.
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;

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

/** Where a signer's values wait for the last signer. No client can read or write it. */
function vaultPath(envelopeId, signerId) {
  return `esign-vault/${envelopeId}/${signerId}.json`;
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
  if (status === 'declined') {
    return { status: 409, body: { error: 'You declined to sign this document. Ask your rep if you would like a new link.', reason: 'declined' } };
  }
  return { status: 409, body: { error: 'This link is no longer active.', reason: 'inactive' } };
}

/** The signer-facing view of an envelope. Never leaks lead internals or other signers' details. */
function publicEnvelope(env, signer) {
  const signers = ESL.normalizeSigners(env);
  const idx = signers.findIndex((s) => s.id === signer.id);
  return {
    title: env.title || 'Document',
    fields: ESL.fieldsForSigner(env, signer.id).map((f) => ({
      id: f.id, type: f.type, page: f.page,
      x: f.x, y: f.y, w: f.w, h: f.h,
      required: f.required !== false,
      label: f.label || '',
      role: f.role || 'signer',
    })),
    pages: env.pages || [],
    signerName: signer.name || '',
    signerIndex: idx < 0 ? 0 : idx,
    signerCount: signers.length,
    othersSigned: signers.filter((s) => s.id !== signer.id && s.status === 'signed').length,
    canDecline: true,
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

async function resolveCompanyName(db, lead) {
  const tenantKey = lead.companyId || lead.userId;
  if (!tenantKey) return { companyName: '', profile: {} };
  try {
    const cp = await db.doc(`companyProfile/${tenantKey}`).get();
    if (cp.exists) {
      const profile = cp.data() || {};
      const ln = (profile.brand || {}).legalName || '';
      return { companyName: (ln && ln !== 'No Big Deal Home Solutions') ? ln : '', profile };
    }
  } catch (e) { logger.warn('[esign] tenant resolve failed', { err: e.message }); }
  return { companyName: '', profile: {} };
}

/**
 * Mint the link for the signer whose turn it is, email it when asked, and
 * record the send on the envelope. Shared by the rep's send / resend and the
 * estimate path. The link is ALWAYS returned, emailed or not, so the rep can
 * text it or hand the phone over when email fails or is not wanted.
 */
async function dispatchToSigner(db, ref, envelopeId, env, signers, uid, opts) {
  const o = opts || {};
  const signer = ESL.nextPendingSigner(Object.assign({}, env, { signers }));
  if (!signer) throw new HttpsError('failed-precondition', 'Everyone has already signed this document.');
  const { link, token, expiresAtMs } = await IO.mintSignerLink(db, envelopeId, env, signer);
  let mail = { emailed: false, stubbed: false, error: null };
  if (o.sendEmail !== false) {
    mail = await IO.emailLink(env, signer, link);
    if (mail.error && mail.error !== 'no email') {
      // Do NOT swallow this into a cheerful response. The old path told the
      // rep "still sending" on a hard failure and never showed the link, so
      // a bounced signing email looked like a slow one forever.
      logger.error('[esign] email send failed', { envelopeId, err: mail.error });
    }
  }
  const remindersOn = o.reminders !== false && o.sendEmail !== false && !!signer.email;
  const first = signers[0] || {};
  const now = Date.now();
  const resent = env.status !== 'draft';
  await ref.set({
    status: 'sent',
    signers,
    // Legacy single-signer readers (customer-documents.js, esign-setup.js,
    // portal.js) read these two — they name the FIRST signer.
    signerName: first.name || null,
    signerEmail: first.email || null,
    currentSignerId: signer.id,
    sentAt: FieldValue.serverTimestamp(),
    ...(env.sentAtMs ? {} : { sentAtMs: now }),
    lastLinkEmailed: mail.emailed,
    linkExpiresAt: expiresAtMs,
    sendEmails: o.sendEmail !== false,
    reminders: { enabled: remindersOn, count: 0 },
    remindNextAt: remindersOn ? now + ESL.REMINDER_EVERY_MS : FieldValue.delete(),
    audit: FieldValue.arrayUnion({
      event: resent ? 'resent' : 'sent',
      at: now, by: uid, emailed: mail.emailed, signerId: signer.id,
    }),
  }, { merge: true });
  await IO.syncEstimate(db, envelopeId, env, resent ? 'resent' : 'sent', {
    signerName: first.name || null, signerEmail: first.email || null,
  });
  return { ok: true, link, token, emailed: mail.emailed, stubbed: !!mail.stubbed, expiresAt: expiresAtMs, signerId: signer.id, signerCount: signers.length };
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
    // 2026-09-25 (decision B): a viewer is read-only. The envelope writers
    // (create / save fields / send / void / send estimate) check lead or
    // envelope OWNERSHIP only, which a viewer can hold — refused first.
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

    const { companyName } = await resolveCompanyName(db, lead);

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
// saveEsignFields — rep persists the field layout (PDF points), and
// optionally the signer list (multi-signer: field.role names the signer).
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

    const { envelopeId, fields, signerName, signerEmail, title, signers } = request.data || {};
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
    if (Array.isArray(signers) && signers.length) {
      try { patch.signers = ESL.sanitizeSignerInput(signers, { requireEmail: false }); }
      catch (e) { throw new HttpsError('invalid-argument', e.message); }
      patch.signerName = patch.signers[0].name;
      patch.signerEmail = patch.signers[0].email;
    } else {
      if (typeof signerName === 'string') patch.signerName = signerName.slice(0, 200);
      if (typeof signerEmail === 'string') patch.signerEmail = signerEmail.slice(0, 320);
    }
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
      signers: ESL.normalizeSigners(env).map((s) => ({ id: s.id, name: s.name, email: s.email, status: s.status })),
      pdf: buf.toString('base64'),
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// sendEsignEnvelope — mint a single-use link and email it.
// Also the RESEND path: calling it again on a sent envelope rotates the
// token (revoking the old link) rather than minting a second live one.
// With several signers the link always goes to the signer whose turn it is.
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

    const { envelopeId, signerName, signerEmail, sendEmail, signers: signerInput, reminders } = request.data || {};
    const db = getFirestore();
    const { ref, env } = await loadOwnedEnvelope(db, envelopeId, uid);

    // A contract envelope gets the Notice of Cancellation appended at signing
    // (submitEsignEnvelope), naming the company as the seller. Refuse to send
    // one for a company with no legal business name rather than print a
    // blank seller (NBD always resolves its own name).
    if (CW.envelopeNeedsCancelNotice(env)) {
      const po = await CW.loadPacketOpts(db, env.leadId);
      if (!po || !po.sellerName) throw new HttpsError('failed-precondition', CW.SELLER_NAME_REQUIRED_MSG);
    }

    if (env.status === 'completed') {
      throw new HttpsError('failed-precondition', 'This envelope is already signed.');
    }
    if (env.status === 'voided') {
      throw new HttpsError('failed-precondition', 'This envelope was voided. Start a new one to send it again.');
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

    // The signer list: an explicit list (multi-signer), else the stored one
    // once a signing is under way, else the single signer named here.
    let signers;
    try {
      if (Array.isArray(signerInput) && signerInput.length && !ESL.normalizeSigners(env).some((s) => s.status === 'signed')) {
        signers = ESL.sanitizeSignerInput(signerInput, { requireEmail: sendEmail !== false });
      } else if (Array.isArray(env.signers) && env.signers.length) {
        signers = ESL.normalizeSigners(env);
      } else {
        const name = (typeof signerName === 'string' && signerName.trim()) || env.signerName || 'Signer';
        const email = (typeof signerEmail === 'string' && signerEmail.trim()) || env.signerEmail || '';
        if (sendEmail !== false && !ESL.EMAIL_RE.test(email)) {
          throw new HttpsError('invalid-argument', 'A valid signer email is required to send the link');
        }
        signers = ESL.sanitizeSignerInput([{ name, email }], { requireEmail: false });
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('invalid-argument', e.message);
    }
    // A declined envelope can be sent again — the decliner gets a fresh turn.
    signers = signers.map((s) => (s.status === 'declined' ? Object.assign({}, s, { status: 'pending' }) : s));
    try { ESL.validateSignerLayout(Object.assign({}, env, { signers })); }
    catch (e) { throw new HttpsError('failed-precondition', e.message); }
    const next = ESL.nextPendingSigner(Object.assign({}, env, { signers }));
    if (next && sendEmail !== false && !ESL.EMAIL_RE.test(next.email || '')) {
      throw new HttpsError('invalid-argument', 'A valid signer email is required to send the link');
    }

    return dispatchToSigner(db, ref, envelopeId, env, signers, uid, { sendEmail, reminders });
  }
);

// ═══════════════════════════════════════════════════════════════
// sendEstimateEnvelope — the estimate builder's "Send for signature".
//
// Replaces BoldSign's sendEstimateForSignature (retired 2026-10-04). Builds
// the contract PDF on the server from the STORED estimate
// (estimate-esign-pdf.js — the customer-facing retail numbers, never cost),
// registers it as an envelope with each signer's signature + date boxes
// already placed, and sends the first signer their link. The client saves
// the estimate first, so what is signed is what the rep just built.
//
// Refused: a Kentucky insurance job (the KRS 367.624 notices live on the deal
// page and the generated contract, not here — same test the builder uses,
// ky-insurance-law.js classifyLead, fail closed); an estimate with no
// customer, no price, or one that is already signed.
// ═══════════════════════════════════════════════════════════════
const TIER_LABEL = { economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' };
const KY_REFUSAL = 'Kentucky insurance job: e-mail e-signature does not include the KRS 367.624 notices. ' +
  'Use "Sign on this phone" or "Generate contract" — both carry the notices and the cancellation form.';

// The contract's scope lines: the same customer-facing rows the homeowner's
// estimate link shows (buildDisplayRows / buildDocLineItems — the retail
// ladder, never cost). A catalog line left at quantity 0 and $0 is not part
// of the job and is not printed on what the homeowner signs.
function estimateLines(est) {
  const CER = require('./customer-estimate-rows');
  const rows = CER.buildDisplayRows(est);
  const toCents = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
  const notEmpty = (l) => !(l.lineTotalCents === 0 && /^\s*0*(\.0*)?\s*([A-Za-z]|$)/.test(String(l.quantity || '0')));
  if (rows.length) {
    return rows.map((r) => ({ name: r.desc || r.code || 'Line item', quantity: r.qty || '', lineTotalCents: toCents(r.total) })).filter(notEmpty);
  }
  if (Array.isArray(est.lineItems) && est.lineItems.length) {
    return CER.buildDocLineItems(est).map((r) => ({
      name: r.description || r.name || r.code || 'Line item',
      quantity: r.quantity != null ? String(r.quantity) + (r.unit ? ' ' + r.unit : '') : '',
      lineTotalCents: toCents(r.total),
    })).filter(notEmpty);
  }
  return [];
}

exports.sendEstimateEnvelope = onCall(
  {
    region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true,
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    timeoutSeconds: 60, memory: '512MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // Decision B (2026-09-25): a viewer is read-only — no contract sent to a
    // homeowner, even for an estimate the viewer owns.
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'sendEstimateEnvelope', 20, 60_000);

    const d = request.data || {};
    const estimateId = typeof d.estimateId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.estimateId) ? d.estimateId : null;
    if (!estimateId) throw new HttpsError('invalid-argument', 'estimateId required');
    const sendEmail = d.sendEmail !== false;

    const db = getFirestore();
    const estSnap = await db.doc(`estimates/${estimateId}`).get();
    if (!estSnap.exists) throw new HttpsError('not-found', 'Estimate not found');
    const est = estSnap.data() || {};
    if (est.userId !== uid) throw new HttpsError('permission-denied', 'Not your estimate');
    if (est.signatureStatus === 'signed') {
      throw new HttpsError('failed-precondition', 'This estimate is already signed.');
    }
    const leadId = typeof est.leadId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(est.leadId) ? est.leadId : null;
    if (!leadId) {
      throw new HttpsError('failed-precondition', 'Link this estimate to a customer first — the signed contract is filed on the customer.');
    }
    const leadSnap = await db.doc(`leads/${leadId}`).get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Customer not found');
    const lead = leadSnap.data() || {};
    if (lead.userId !== uid) throw new HttpsError('permission-denied', 'Not your customer');

    // Kentucky insurance job — refused server-side too (the builder hides the
    // button; this is the authority). Fail closed if the law module throws.
    const KyLaw = require('./ky-insurance-law');
    let j = null;
    try { j = KyLaw.classifyLead(lead, est); } catch (_) { j = null; }
    if (!j || j.kyInsurance === true) throw new HttpsError('failed-precondition', KY_REFUSAL);

    const price = Number(est.grandTotal != null ? est.grandTotal : est.total);
    if (!Number.isFinite(price) || !(price > 0)) {
      throw new HttpsError('failed-precondition', 'Price the estimate first — it has no total to sign for.');
    }

    let signers;
    try {
      const raw = Array.isArray(d.signers) && d.signers.length
        ? d.signers
        : [{ name: d.signerName, email: d.signerEmail }];
      signers = ESL.sanitizeSignerInput(raw.slice(0, ESL.MAX_SIGNERS), { requireEmail: sendEmail });
    } catch (e) { throw new HttpsError('invalid-argument', e.message); }

    const { companyName, profile } = await resolveCompanyName(db, lead);
    // The seller on the contract and its Notice of Cancellation. NBD keeps its
    // name; another company with no legal name set is refused here — a blank
    // seller on a 3-day cancellation notice is worse than not sending.
    const sellerName = ESL.senderName(companyName, lead.companyId || lead.userId);
    if (!sellerName) throw new HttpsError('failed-precondition', CW.SELLER_NAME_REQUIRED_MSG);
    const { safeDepositPlan } = require('./deposit-plan-view');
    const { tierApplies } = require('./customer-estimate-rows');
    const timeZone = KyLaw.resolveTimeZone(profile);
    const address = est.addr || est.address || lead.address || '';
    const title = ('Roofing Contract — ' + (address || signers[0].name)).slice(0, 200);

    let pdf;
    try {
      pdf = await require('./estimate-esign-pdf').buildEstimateContractPdf({
        companyName: sellerName,
        sellerAddress: KyLaw.contractorMailingAddress(profile),
        title: 'Roofing Contract',
        estimateNumber: est.number || estimateId.slice(0, 8),
        preparedDate: KyLaw.formatDay(KyLaw.todayIn(timeZone)),
        customer: { name: signers.map((s) => s.name).join(' & '), address, phone: lead.phone || '', email: signers[0].email || '' },
        lines: estimateLines(est),
        tierName: tierApplies(est) ? (est.tierName || TIER_LABEL[est.tier] || null) : null,
        totalCents: Math.round(price * 100),
        depositPlan: safeDepositPlan(est),
        signers: signers.map((s) => ({ id: s.id, name: s.name })),
      });
    } catch (e) {
      logger.error('[sendEstimateEnvelope] contract PDF build failed', { estimateId, err: e.message });
      throw new HttpsError('internal', 'Could not build the contract PDF. Try again.');
    }

    const envelopeId = ('est_' + estimateId.slice(0, 24) + '_' + Date.now().toString(36)).slice(0, 64);
    const sourcePath = `esign/${uid}/${leadId}/${envelopeId}/source.pdf`;
    const buf = Buffer.from(pdf.bytes);
    try {
      await getStorage().bucket().file(sourcePath).save(buf, { contentType: 'application/pdf', resumable: false });
    } catch (e) {
      logger.error('[sendEstimateEnvelope] source save failed', { estimateId, err: e.message });
      throw new HttpsError('unavailable', 'Could not store the contract. Try again.');
    }

    // One live contract per estimate: a re-send supersedes the old envelope
    // (its link is revoked and it is marked voided), so a homeowner can never
    // sign yesterday's numbers from an older email.
    if (est.signatureEnvelopeId && typeof est.signatureEnvelopeId === 'string') {
      try {
        const oldRef = db.doc(`esign_envelopes/${est.signatureEnvelopeId}`);
        const old = await oldRef.get();
        if (old.exists && old.data().ownerUid === uid && old.data().status !== 'completed') {
          await IO.revokeLiveTokens(db, est.signatureEnvelopeId);
          await oldRef.set({
            status: 'voided', voidedAt: FieldValue.serverTimestamp(), remindNextAt: FieldValue.delete(),
            audit: FieldValue.arrayUnion({ event: 'voided', at: Date.now(), by: uid, reason: 'superseded by ' + envelopeId }),
          }, { merge: true });
        }
      } catch (e) { logger.warn('[sendEstimateEnvelope] supersede failed', { err: e.message }); }
    }

    const ref = db.doc(`esign_envelopes/${envelopeId}`);
    const env = {
      ownerUid: uid,
      companyId: lead.companyId || null,
      companyName,
      leadId,
      estimateId,
      kind: 'estimate',
      title,
      sourcePath,
      sourceSha256: sha256(buf),
      sourceBytes: buf.length,
      pages: pdf.pages,
      pageCount: pdf.pages.length,
      fields: pdf.fields,
      // Filled by the server with the signing date when the last signer
      // signs (the FTC Notice of Cancellation's date + deadline).
      systemFields: pdf.systemFields,
      // The completed FTC forms are already in this document — a later
      // "append the cancellation notice to contract envelopes" step must not
      // add a second set.
      cancelFormsIncluded: true,
      timeZone,
      signers,
      signerName: signers[0].name,
      signerEmail: signers[0].email || null,
      status: 'draft',
      createdAt: FieldValue.serverTimestamp(),
      audit: [{ event: 'created', at: Date.now(), by: uid, from: 'estimate', estimateId }],
    };
    await ref.set(env);
    const out = await dispatchToSigner(db, ref, envelopeId, env, signers, uid, { sendEmail, reminders: d.reminders });
    logger.info('[sendEstimateEnvelope] sent', { estimateId, envelopeId, signers: signers.length, emailed: out.emailed });
    return Object.assign({ envelopeId }, out);
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
    const revoked = await IO.revokeLiveTokens(db, ref.id);

    await ref.set({
      status: 'voided',
      voidedAt: FieldValue.serverTimestamp(),
      remindNextAt: FieldValue.delete(),
      audit: FieldValue.arrayUnion({ event: 'voided', at: Date.now(), by: uid }),
    }, { merge: true });
    await IO.syncEstimate(db, ref.id, env, 'voided');
    return { ok: true, revoked };
  }
);

// ═══════════════════════════════════════════════════════════════
// getEsignEnvelope — homeowner POSTs token → the PDF + THEIR field layout.
// ═══════════════════════════════════════════════════════════════
exports.getEsignEnvelope = onRequest(
  {
    region: 'us-central1', cors: CORS_ORIGINS,
    // The homeowner's browser calls this with no Firebase credential, so the
    // Cloud Run allUsers invoker binding must be re-applied on every deploy
    // (PUBLIC-INVOKER-SWEEP-2026-10-02 — four functions had silently lost it).
    invoker: 'public',
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
    if (tok.status === 'declined') {
      res.status(410).json({ error: 'You declined to sign this document. Ask your rep if you would like a new link.', reason: 'declined' }); return;
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
    if (env.status === 'declined') {
      res.status(410).json({ error: 'This document was declined. Ask your rep if you would like a new link.', reason: 'declined' }); return;
    }
    const signer = ESL.signerForToken(env, tok);
    if (!signer) { res.status(404).json({ error: 'This signing link is not valid.' }); return; }
    if (signer.status === 'signed') {
      res.status(410).json({ error: 'You have already signed this document.', reason: 'signed' }); return;
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
    // view, losing the one fact that matters for a dispute. Per signer now —
    // a nested map key, so it merges without touching anyone's evidence.
    const now = Date.now();
    const ip = clientIp(req) || null;
    const patch = { audit: FieldValue.arrayUnion({ event: 'viewed', at: now, ip, signerId: signer.id }) };
    if (!env.viewedAt) patch.viewedAt = FieldValue.serverTimestamp();
    if (!(env.viewedBy && env.viewedBy[signer.id])) patch.viewedBy = { [signer.id]: now };
    if (env.status === 'sent') patch.status = 'viewed';
    db.doc(`esign_envelopes/${tok.envelopeId}`).set(patch, { merge: true }).catch(() => {});
    if (env.status === 'sent') IO.syncEstimate(db, tok.envelopeId, env, 'viewed').catch(() => {});

    res.status(200).json(Object.assign(publicEnvelope(env, signer), {
      pdf: buf.toString('base64'),
      consentText: ESL.CONSENT_TEXT,
    }));
  }
);

// ═══════════════════════════════════════════════════════════════
// submitEsignEnvelope — a signer POSTs their field values.
// Not the last signer: their values are vaulted, their evidence recorded, and
// the next signer gets their link. The last signer: every signer's values are
// drawn into the ORIGINAL in one pass, the signature certificate is appended,
// the executed PDF is stored and emailed to every signer.
// ═══════════════════════════════════════════════════════════════
exports.submitEsignEnvelope = onRequest(
  {
    region: 'us-central1', cors: CORS_ORIGINS,
    // The homeowner's browser calls this with no Firebase credential, so the
    // Cloud Run allUsers invoker binding must be re-applied on every deploy
    // (PUBLIC-INVOKER-SWEEP-2026-10-02 — four functions had silently lost it).
    invoker: 'public',
    maxInstances: 20, concurrency: 10, timeoutSeconds: 120, memory: '1GiB',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
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
    if (env.status === 'declined') { res.status(410).json({ error: 'This document was declined.', reason: 'declined' }); return; }
    if (!isOwnEnvelopePath(env.sourcePath, env.ownerUid, env.leadId, tok.envelopeId)) {
      logger.error('[submitEsignEnvelope] sourcePath outside owner prefix', { envelopeId: tok.envelopeId });
      res.status(500).json({ error: 'This document could not be processed.' }); return;
    }
    const signer = ESL.signerForToken(env, tok);
    if (!signer) { res.status(404).json({ error: 'This signing link is not valid.' }); return; }
    if (signer.status === 'signed') {
      res.status(409).json({ error: 'You have already signed this document.', reason: 'signed' }); return;
    }

    // A signer fills THEIR fields only. A co-owner's link writing (or
    // blanking) the homeowner's signature box is refused outright.
    const picked = ESL.pickSignerValues(env, signer.id, values);
    if (picked.foreign.length) {
      logger.warn('[submitEsignEnvelope] values for another signer refused', { envelopeId: tok.envelopeId, signerId: signer.id, foreign: picked.foreign.slice(0, 5) });
      res.status(400).json({ error: 'This link can only fill in your own fields. Please reload and try again.' }); return;
    }
    const mine = picked.values;
    const myFields = ESL.fieldsForSigner(env, signer.id);

    // ── Validate BEFORE the burn ─────────────────────────────────────────
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

    let dry;
    try {
      dry = await stampPdf(source, myFields, mine, {});
    } catch (e) {
      logger.error('[submitEsignEnvelope] stamping failed', { envelopeId: tok.envelopeId, err: e.message });
      res.status(422).json({ error: 'Could not apply your signature to the document. Please reload and try again.' });
      return;
    }
    if (dry.missingRequired.length) {
      res.status(422).json({
        error: 'Please complete every required field before submitting.',
        missing: dry.missingRequired,
      });
      return;
    }

    const when = Date.now();
    const ip = clientIp(req) || null;
    const ua = String(req.get('user-agent') || '').slice(0, 300);
    const valuesJson = JSON.stringify(mine);
    const evidence = ESL.buildSignerEvidence({
      typedName: (typeof signerName === 'string' ? signerName : '') || signer.name,
      ip, ua, consent: true, consentText: ESL.CONSENT_TEXT, at: when,
      valuesSha256: sha256(valuesJson),
      fieldIds: Object.keys(mine),
      viewedAt: env.viewedBy && env.viewedBy[signer.id],
    });

    // Vault the values BEFORE the burn: a burned token with no stored values
    // would strand the envelope. A failed burn just leaves a file the retry
    // overwrites.
    try {
      await getStorage().bucket().file(vaultPath(tok.envelopeId, signer.id)).save(Buffer.from(valuesJson, 'utf8'), {
        contentType: 'application/json', resumable: false,
      });
    } catch (e) {
      logger.error('[submitEsignEnvelope] values vault write failed — refusing', { envelopeId: tok.envelopeId, err: e.message });
      res.status(503).json({ error: 'Could not record your signature right now. Please try again shortly.' }); return;
    }

    // ── Atomic single-use burn + this signer's evidence ──────────────────
    let signersAfter;
    try {
      signersAfter = await db.runTransaction(async (tx) => {
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
        const fresh = (await tx.get(envRef)).data() || env;
        if (fresh.status === 'voided' || fresh.status === 'declined' || fresh.status === 'completed') {
          const e = new Error('inactive'); e._http = 410; e._msg = 'This document is no longer open for signing.'; throw e;
        }
        const list = ESL.normalizeSigners(fresh).map((s) => (s.id === signer.id ? Object.assign({}, s, evidence) : s));
        tx.update(tokRef, { status: 'signed', signedAt: FieldValue.serverTimestamp() });
        tx.set(envRef, {
          signers: list,
          audit: FieldValue.arrayUnion({ event: 'signer_signed', at: when, ip, ua, signerId: signer.id }),
        }, { merge: true });
        return list;
      });
    } catch (err) {
      if (err && err._http) {
        res.status(err._http).json(err._reason ? { error: err._msg, reason: err._reason } : { error: err._msg });
        return;
      }
      logger.error('[submitEsignEnvelope] burn txn failed', { msg: err.message });
      res.status(500).json({ error: 'Could not record your signature. Please try again.' }); return;
    }

    const envAfter = Object.assign({}, env, { signers: signersAfter });
    const next = ESL.nextPendingSigner(envAfter);

    // ── Not the last signer: hand the document to the next one ───────────
    if (next) {
      let mail = { emailed: false };
      try {
        const { link, expiresAtMs } = await IO.mintSignerLink(db, tok.envelopeId, envAfter, next);
        if (env.sendEmails !== false) mail = await IO.emailLink(envAfter, next, link);
        const remindersOn = !!(env.reminders && env.reminders.enabled) && !!next.email && env.sendEmails !== false;
        await envRef.set({
          status: 'sent',
          currentSignerId: next.id,
          linkExpiresAt: expiresAtMs,
          lastLinkEmailed: !!mail.emailed,
          reminders: { enabled: remindersOn, count: 0 },
          remindNextAt: remindersOn ? Date.now() + ESL.REMINDER_EVERY_MS : FieldValue.delete(),
          audit: FieldValue.arrayUnion({ event: 'next_signer_sent', at: Date.now(), signerId: next.id, emailed: !!mail.emailed }),
        }, { merge: true });
      } catch (e) {
        logger.error('[submitEsignEnvelope] next-signer handoff failed', { envelopeId: tok.envelopeId, err: e.message });
      }
      await IO.notifyRep(db, env, {
        type: 'esign_signer_signed',
        title: 'Signature received',
        message: `${evidence.typedName || signer.name || 'A signer'} signed ${env.title || 'a document'}` +
          ` — ${next.name || 'the next signer'} is next${mail.emailed ? ' (link emailed)' : ' (send them the link from the customer page)'}.`,
      });
      await IO.syncEstimate(db, tok.envelopeId, env, 'signer_completed');
      res.status(200).json({ ok: true, complete: false, nextSigner: next.name || '' });
      return;
    }

    // ── The last signer: build the executed record ───────────────────────
    const all = {};
    try {
      for (const s of signersAfter) {
        if (s.id === signer.id) { Object.assign(all, mine); continue; }
        const [buf] = await getStorage().bucket().file(vaultPath(tok.envelopeId, s.id)).download();
        const json = buf.toString('utf8');
        // The digest recorded in the signer's evidence is the authority; a
        // vault file that does not match it is never drawn into a contract.
        if (s.valuesSha256 && sha256(json) !== s.valuesSha256) throw new Error('vault digest mismatch for ' + s.id);
        Object.assign(all, JSON.parse(json));
      }
    } catch (e) {
      logger.error('[submitEsignEnvelope] COULD NOT ASSEMBLE SIGNER VALUES', { envelopeId: tok.envelopeId, err: e.message });
      await envRef.set({ audit: FieldValue.arrayUnion({ event: 'completion_failed', at: Date.now(), reason: String(e.message).slice(0, 200) }) }, { merge: true }).catch(() => {});
      await IO.notifyRep(db, env, { type: 'esign_attention', title: 'Signature needs attention', message: `The last signature on ${env.title || 'a document'} was recorded, but the signed PDF could not be assembled. Contact support.` });
      res.status(500).json({ error: 'Your signature was recorded, but the document could not be finalized. Your rep has been notified.' });
      return;
    }

    let sys = { values: {}, cancelBy: '' };
    if (Array.isArray(env.systemFields) && env.systemFields.length) {
      sys = require('./estimate-esign-pdf').systemFieldValues(env.systemFields, new Date(when), env.timeZone);
    }

    let signedBytes;
    try {
      const stamped = await stampPdf(source, (env.fields || []).concat(env.systemFields || []), Object.assign({}, all, sys.values), {
        certificateLine:
          `Signed electronically ${new Date(when).toISOString()} · envelope ${tok.envelopeId} · ` +
          `${signersAfter.map((s) => s.typedName || s.name || 'signer').join(', ')}`.slice(0, 160),
      });
      if (stamped.missingRequired.length) throw new Error('missing required after assembly: ' + stamped.missingRequired.join(','));
      const cert = await appendAuditCertificate(stamped.bytes,
        ESL.certificateLines(envAfter, { envelopeId: tok.envelopeId, completedAt: when }));
      signedBytes = cert.bytes;
    } catch (e) {
      logger.error('[submitEsignEnvelope] final stamp failed', { envelopeId: tok.envelopeId, err: e.message });
      await IO.notifyRep(db, env, { type: 'esign_attention', title: 'Signature needs attention', message: `The last signature on ${env.title || 'a document'} was recorded, but the signed PDF could not be built. Contact support.` });
      res.status(500).json({ error: 'Your signature was recorded, but the document could not be finalized. Your rep has been notified.' });
      return;
    }

    // The SOURCE IS NEVER OVERWRITTEN — the signed copy is a new object. The
    // HTML path wrote the counterparty's bytes over the served original and
    // had to archive it aside first to have anything left to compare against.
    const signedPath = `esign/${env.ownerUid}/${env.leadId}/${tok.envelopeId}/signed.pdf`;
    // The 3-day right to cancel (2026-10-04). An envelope that IS the
    // contract (envelopeIsContract — the same test that moves the job to
    // Contract Signed) gets the Notice of Right to Cancel and the two
    // completed FTC forms (+ the KRS 367.624(4) forms on a Kentucky insurance
    // job) appended to the signed PDF (after the audit certificate), dated
    // today — the homeowner's copy in the portal is this file. A failure
    // keeps the signed PDF as stamped and is logged loudly; the signature
    // itself is already recorded.
    // An estimate envelope's contract PDF already carries the FTC forms
    // (cancelFormsIncluded, #2166) — its own system fields date them — so it
    // is never given a second set (CW.envelopeNeedsCancelNotice).
    let noticeCancelBy = '';
    if (CW.envelopeNeedsCancelNotice(env)) {
      try {
        const opts = await CW.loadPacketOpts(db, env.leadId);
        const withNotice = await require('./cancel-notice-pdf').appendCancelNotice(signedBytes, Object.assign({ transactionDate: when }, opts));
        signedBytes = withNotice.bytes;
        noticeCancelBy = withNotice.cancelBy;
      } catch (e) {
        logger.error('[submitEsignEnvelope] cancellation notice NOT appended', { envelopeId: tok.envelopeId, err: e.message });
      }
    }
    // The last day to cancel: the estimate PDF's own dated forms, else the
    // appended notice's.
    const cancelBy = sys.cancelBy || noticeCancelBy;
    const signedBuf = Buffer.from(signedBytes);
    let stored = false;
    try {
      await getStorage().bucket().file(signedPath).save(signedBuf, {
        contentType: 'application/pdf', resumable: false,
      });
      stored = true;
    } catch (e) {
      logger.error('[submitEsignEnvelope] signed pdf upload FAILED', { envelopeId: tok.envelopeId, err: e.message });
    }

    // Deliver the executed copy to every signer — the homeowner leaves with
    // their own signed contract, not a promise that the rep has one.
    const attach = signedBuf.length <= MAX_ATTACH_BYTES;
    // Even an in-person signing (link not emailed) sends the copy: the signer
    // gave their email, and the copy is theirs to keep.
    const copies = [];
    for (const s of signersAfter) {
      if (!s.email || !ESL.EMAIL_RE.test(s.email)) { copies.push({ signerId: s.id, emailed: false, reason: 'no email' }); continue; }
      try {
        const m = ESL.signedCopyEmail({ brand: env.companyName, tenantKey: env.companyId || env.ownerUid, name: s.typedName || s.name, title: env.title, attached: attach });
        const r = await IO.sendMail(Object.assign({ to: s.email, subject: m.subject, html: m.html },
          attach ? { attachments: [{ filename: 'signed-' + tok.envelopeId + '.pdf', content: signedBuf.toString('base64') }] } : {}));
        copies.push({ signerId: s.id, emailed: !!r.emailed, stubbed: !!r.stubbed, at: Date.now() });
      } catch (e) {
        logger.error('[submitEsignEnvelope] signed copy email failed', { envelopeId: tok.envelopeId, err: e.message });
        copies.push({ signerId: s.id, emailed: false, reason: String(e.message).slice(0, 120) });
      }
    }

    const last = signersAfter[signersAfter.length - 1] || evidence;
    try {
      await envRef.set({
        status: 'completed',
        signedAt: FieldValue.serverTimestamp(),
        completedAtMs: when,
        signedPath: stored ? signedPath : null,
        signedSha256: sha256(signedBuf),
        signedBytes: signedBuf.length,
        remoteSignerName: (signersAfter[0] && (signersAfter[0].typedName || signersAfter[0].name)) || env.signerName || null,
        // Legacy single-signer field — the evidence of the signer who
        // completed the envelope. Every signer's own record is in signers[].
        consent: { agreed: true, at: when, ip, ua },
        copiesDelivered: copies,
        ...(cancelBy ? { cancelBy } : {}),
        remindNextAt: FieldValue.delete(),
        linkExpiresAt: FieldValue.delete(),
        currentSignerId: FieldValue.delete(),
        audit: FieldValue.arrayUnion({ event: 'signed', at: when, ip, ua, stored, signerId: (last && last.id) || signer.id }),
      }, { merge: true });
    } catch (e) { logger.error('[submitEsignEnvelope] envelope stamp failed', { err: e.message }); }
    if (cancelBy) await CW.stampLeadCancelBy(db, env.leadId, cancelBy, logger, { ownerUid: env.ownerUid, companyId: env.companyId });

    await IO.syncEstimate(db, tok.envelopeId, env, 'completed', {
      signerName: (signersAfter[0] && signersAfter[0].name) || null,
      signedEnvelopePath: stored ? signedPath : null,
    });

    // Job spine (2026-10-03): an envelope titled as the contract moves the
    // job to Contract Signed and stamps Contract Filed. Best-effort, never
    // throws — the signature is already recorded.
    await spineAfterEsign(db, env, tok.envelopeId, evidence.typedName || signerName);

    await IO.notifyRep(db, env, {
      type: 'esign_completed',
      title: 'Document signed',
      message: `${signersAfter.map((s) => s.typedName || s.name).filter(Boolean).join(' & ') || 'A homeowner'} signed ${env.title || 'a document'}.`,
    });

    res.status(200).json({ ok: true, complete: true, copyEmailed: copies.some((c) => c.emailed) });
  }
);

// ═══════════════════════════════════════════════════════════════
// declineEsignEnvelope — the signer says no, from the signing page.
// Burns the link (status 'declined'), stops reminders, records who/when/
// where and their optional reason, tells the rep, and mirrors 'declined' onto
// the estimate. The rep can send again (sendEsignEnvelope) if they talk it
// through.
// ═══════════════════════════════════════════════════════════════
exports.declineEsignEnvelope = onRequest(
  {
    region: 'us-central1', cors: CORS_ORIGINS,
    // The homeowner's browser calls this with no Firebase credential, so the
    // Cloud Run allUsers invoker binding must be re-applied on every deploy
    // (PUBLIC-INVOKER-SWEEP-2026-10-02 — four functions had silently lost it).
    invoker: 'public',
    maxInstances: 20, concurrency: 20, timeoutSeconds: 20, memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'esign-decline:ip', 10, 60_000))) return;

    const { token, reason } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid link' }); return;
    }
    const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';

    const db = getFirestore();
    const tokRef = db.doc(`esign_tokens/${token}`);
    const ip = clientIp(req) || null;
    const ua = String(req.get('user-agent') || '').slice(0, 300);
    const when = Date.now();
    let info;
    try {
      info = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) { const e = new Error('nf'); e._http = 404; e._msg = 'This signing link is not valid.'; throw e; }
        const t = snap.data();
        if (t.status !== 'pending') {
          const r = nonPendingTokenResponse(t.status);
          const e = new Error(t.status); e._http = r.status; e._msg = r.body.error; e._reason = r.body.reason; throw e;
        }
        if (t.expiresAt && t.expiresAt.toMillis && t.expiresAt.toMillis() < Date.now()) {
          const e = new Error('exp'); e._http = 410; e._msg = 'This signing link has expired.'; e._reason = 'expired'; throw e;
        }
        const envRef = db.doc(`esign_envelopes/${t.envelopeId}`);
        const envSnap = await tx.get(envRef);
        if (!envSnap.exists) { const e = new Error('gone'); e._http = 404; e._msg = 'This document is no longer available.'; throw e; }
        const env = envSnap.data();
        if (env.status === 'completed' || env.status === 'voided') {
          const e = new Error('inactive'); e._http = 410; e._msg = 'This document is no longer open for signing.'; throw e;
        }
        const signer = ESL.signerForToken(env, t);
        if (!signer) { const e = new Error('nosigner'); e._http = 404; e._msg = 'This signing link is not valid.'; throw e; }
        const list = ESL.normalizeSigners(env).map((s) => (s.id === signer.id
          ? Object.assign({}, s, { status: 'declined', declinedAt: when, declineReason: why || null, ip, ua }) : s));
        tx.update(tokRef, { status: 'declined', declinedAt: FieldValue.serverTimestamp() });
        tx.set(envRef, {
          status: 'declined',
          signers: list,
          declined: { signerId: signer.id, name: signer.name || null, reason: why || null, at: when, ip, ua },
          remindNextAt: FieldValue.delete(),
          linkExpiresAt: FieldValue.delete(),
          audit: FieldValue.arrayUnion({ event: 'declined', at: when, ip, ua, signerId: signer.id }),
        }, { merge: true });
        return { envelopeId: t.envelopeId, env, signer };
      });
    } catch (err) {
      if (err && err._http) {
        res.status(err._http).json(err._reason ? { error: err._msg, reason: err._reason } : { error: err._msg });
        return;
      }
      logger.error('[declineEsignEnvelope] txn failed', { msg: err.message });
      res.status(500).json({ error: 'Could not record that. Please try again.' }); return;
    }

    await IO.notifyRep(db, info.env, {
      type: 'esign_declined',
      title: 'Signature declined',
      message: `${info.signer.name || 'The signer'} declined to sign ${info.env.title || 'a document'}` + (why ? `: "${why.slice(0, 140)}"` : '.'),
    });
    await IO.syncEstimate(db, info.envelopeId, info.env, 'declined');
    res.status(200).json({ ok: true });
  }
);

// NOTHING else is exported from this file. index.js does
// `Object.assign(exports, require('./esign-envelope'))`, and the Firebase CLI
// reads a plain object export as a function GROUP — an `exports._internal`
// convenience for tests would deploy phantom functions like
// `_internal-isOwnEnvelopePath`. tests/esign-envelope.test.js extracts the
// helpers it needs from the source with vm, the same way
// signature-document-integrity.test.js does. Shared helpers live in
// esign-io.js (I/O) and esign-logic.js (pure).
