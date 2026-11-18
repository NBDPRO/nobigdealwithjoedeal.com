/**
 * functions/remote-signing.js — Signatures PR4/5: canvas remote signing
 *
 * Lets a rep email a homeowner a link to sign a generated document
 * remotely (no login). Mirrors the audited portal.js token model:
 *   - doc_sign_tokens/{token} is admin-SDK only (firestore.rules)
 *   - token = 24 chars over a 32-char no-confusable alphabet (~120 bits),
 *     infeasible to brute-force against the per-IP rate limit
 *   - 7-day server-checked expiry; SINGLE-USE (burned atomically on submit)
 *
 * Exports:
 *   createSignRequest (onCall)    — rep mints a token for a persisted doc
 *                                   + emails the homeowner the sign link (PR5)
 *   getSignDocument   (onRequest) — homeowner POSTs token → doc HTML to sign
 *   submitSignature   (onRequest) — homeowner POSTs token + signed HTML →
 *                                   burns the token, stores the signed doc,
 *                                   notifies the rep
 *
 * The doc HTML is the one the generator already uploaded to Storage at
 * leads/{leadId}/documents/{docId}.htmlPath (interactive, with the
 * data-nbd-sig widget blocks). getSignDocument serves it; the public
 * /pro/sign.html renders it in a sandboxed iframe + runs signature-widget.js.
 *
 * Security exception: the two homeowner endpoints are NOT App-Check or
 * Firebase-auth gated — that's the whole point of a no-login signing link.
 * Compensating controls: unguessable token + 7-day expiry + single-use burn
 * + per-IP rate limit + CORS lockdown + signed-HTML size cap.
 */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { FieldValue } = require('firebase-admin/firestore');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');
const DE = require('./doc-evidence');
const { callableRateLimit, assertNotViewer } = require('./shared');
const EVA = require('./estimate-view-alert');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const MessagingControls = require('./messaging-controls');
const { spineAfterRemoteSign } = require('./job-spine');
const KyLaw = require('./ky-insurance-law');
const CW = require('./cancel-window');
const { uidInLeadTenant } = require('./lead-artifact-paths');
const ESL = require('./esign-logic');
const { awaitBriefly } = require('./await-briefly');
const SP = require('./signed-price');
const AA = require('./attic-ack');
const AG = require('./attic-gate');

/** Cents → "$14,500.00" for the rep's bell. */
const usd = (cents) => '$' + (Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];
const SIGN_URL_BASE = 'https://nobigdealwithjoedeal.com/pro/sign.html?token=';

// 32-char no-confusable alphabet (no 0/O, 1/I/L) — same as portal.js.
const SIGN_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mintSignToken() {
  const bytes = require('crypto').randomBytes(24);
  let s = '';
  for (const b of bytes) s += SIGN_TOKEN_ALPHABET[b % SIGN_TOKEN_ALPHABET.length];
  return s;
}

// ═══════════════════════════════════════════════════════════════
// SIGNED-DOCUMENT INTEGRITY (audit 2026-08-02)
//
// submitSignature receives a whole HTML document from the browser and used to
// write it straight over the original in Storage. Two separate problems:
// the counterparty controlled every byte of the document that becomes the
// executed record, and the unsigned original was destroyed by the same write,
// so nothing was left to compare against.
//
// The signing page legitimately needs to return HTML — the widget converts
// each <canvas> to an <img> and reserialises documentElement — so we cannot
// simply refuse it. What we CAN do is prove the submitted document says the
// same thing as the one we served.
//
// Comparing HTML byte-for-byte does not work: a browser round-trip
// legitimately reorders attributes, changes quoting, normalises void tags and
// re-encodes entities. Comparing the VISIBLE TEXT does work — none of those
// transformations alter it, while every meaningful tamper (a price, a scope
// line, a name) does.
// ═══════════════════════════════════════════════════════════════

/** End index (exclusive) of the tag whose opening `<div` starts at `open`. */
function endOfDivAt(src, open) {
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = open;
  let depth = 0, m;
  while ((m = re.exec(src))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * Remove every <div data-nbd-sig="..."> block. Those are the ONLY regions the
 * signer is allowed to change: the widget swaps the canvas for an <img>,
 * replaces the controls with a "Signed <date>" stamp, and stamps
 * data-nbd-sig-finalized. Everything outside them must survive untouched.
 */
function stripSignatureBlocks(html) {
  let out = html;
  for (;;) {
    const m = /<div\b[^>]*\bdata-nbd-sig\s*=/i.exec(out);
    if (!m) break;
    const end = endOfDivAt(out, m.index);
    if (end < 0) break;               // unbalanced — leave it, comparison will catch it
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
}

/**
 * The human-readable content of a document, normalised so that a browser
 * round-trip is a no-op but any edit to what the document SAYS is not.
 */
function visibleText(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    // Entity normalisation — a round-trip may write &amp; where the source had
    // & (or the reverse), which must not read as tampering.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `signed` says the same thing as `original`.
 * Returns { ok, reason } so the caller can log WHY without leaking document
 * content into logs.
 */
function signedDocMatchesOriginal(originalHtml, signedHtml) {
  // The Notice of Right to Cancel packet is re-dated by getSignDocument (the
  // day the page is opened) and re-rendered from the ORIGINAL on submit
  // (cancel-window.js finalizeSignedPacket), so whatever the signer sends
  // back inside it never reaches the record — it is left out of the compare.
  const a = visibleText(stripSignatureBlocks(KyLaw.stripCancelPacket(originalHtml)));
  const b = visibleText(stripSignatureBlocks(KyLaw.stripCancelPacket(signedHtml)));
  if (a === b) return { ok: true };
  // Report only sizes and the first divergence offset — never the text.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { ok: false, reason: `content differs at offset ${i} (original ${a.length} chars, submitted ${b.length})` };
}

/**
 * Does the executed record actually CONTAIN a signature?
 *
 * The gate above proves the submitted document SAYS the same thing as the
 * one we served. It says nothing about whether anybody signed it, and that
 * turned out to be the larger hole: the widget's finalize() reported
 * success over an empty pad list, so a document carrying no signature
 * field at all submitted cleanly, burned the token, stamped the document
 * signedRemotely:true and notified the rep "Document signed". Only one of
 * the 27 generated document types emits a signature canvas, so every other
 * type sent for signature produced an executed-contract record with zero
 * signatures in it.
 *
 * Fixed in the browser too, but the browser is the COUNTERPARTY'S — the
 * authoritative check has to be here.
 *
 * Two distinct failures, deliberately reported apart:
 *   noFields  — we served a document with no signature block. Our bug; the
 *               signer can do nothing about it and must not be told to retry.
 *   unsigned  — we served a signable document and got back an unsigned one.
 */
function signedDocHasSignature(originalHtml, signedHtml) {
  const sigBlocks = (String(originalHtml).match(/<div\b[^>]*\bdata-nbd-sig\s*=/gi) || []).length;
  if (sigBlocks === 0) return { ok: false, reason: 'noFields' };
  const finalized = (String(signedHtml).match(/data-nbd-sig-finalized\s*=\s*["']1["']/gi) || []).length;
  if (finalized === 0) return { ok: false, reason: 'unsigned', sigBlocks };
  return { ok: true, sigBlocks, finalized };
}

// ═══════════════════════════════════════════════════════════════
// SIGNABLE PATH CONFINEMENT (security review 2026-10-05)
//
// leads/{leadId}/documents/{docId}.htmlPath is CLIENT-WRITTEN. createSignRequest
// used to copy it into the token unchecked, getSignDocument downloaded it for
// a no-login stranger and submitSignature overwrote it — any object in the
// bucket, any tenant's. Same confinement as getDocumentHtml (document-view.js):
// documents/<uid>/<leadId>/<file>.html, the leadId segment is THIS lead, and
// the uid segment is in the lead's tenant (the generator writes the WRITER's
// uid, so a teammate's document carries the teammate's uid, not the owner's).
// Checked at mint AND on every use, so a token minted before this fix cannot
// still reach a foreign object.
// ═══════════════════════════════════════════════════════════════
const SIGNABLE_HTML_PATH_RE = /^documents\/([A-Za-z0-9_-]{1,128})\/([^/]{1,256})\/[A-Za-z0-9._-]{1,200}\.html$/;

/** Pure shape check. Returns the uid segment, or null. */
function signablePathUid(htmlPath, leadId) {
  if (typeof htmlPath !== 'string' || typeof leadId !== 'string' || !leadId) return null;
  if (htmlPath.indexOf('..') !== -1 || htmlPath.indexOf('\\') !== -1) return null;
  const m = SIGNABLE_HTML_PATH_RE.exec(htmlPath);
  if (!m || m[2] !== leadId) return null;
  return m[1];
}

/** Shape + tenant check. One users/{uid} read only for a teammate's path. */
/**
 * Mark this lead's other pending CONTRACT sign links superseded (review H1,
 * 2026-11-14). A token minted before docType was stamped is judged by its
 * document's type. Only the lead owner's tokens. Best-effort, never throws:
 * the price guard in signed-price.js (older_than_current) still holds if
 * this misses one.
 */
const SUPERSEDED_MSG = 'This signing link was replaced by a newer one. Use the latest link from your rep.';
async function supersedeContractTokens(db, leadId, ownerUid, keepToken, why) {
  try {
    const snap = await db.collection('doc_sign_tokens').where('leadId', '==', leadId).where('status', '==', 'pending').get();
    for (const d of snap.docs) {
      if (d.id === keepToken) continue;
      const t = d.data() || {};
      if (t.ownerUid !== ownerUid) continue;
      let type = t.docType || null;
      if (!type && typeof t.docId === 'string' && t.docId) {
        try { const ds = await db.doc(`leads/${leadId}/documents/${t.docId}`).get(); type = ds.exists ? (ds.data() || {}).type : null; } catch (_) { type = null; }
      }
      if (!CW.isContractDocType(type)) continue;
      await db.doc(`doc_sign_tokens/${d.id}`).update({ status: 'superseded', supersededBy: keepToken || null, supersededWhy: why, supersededAt: FieldValue.serverTimestamp() });
    }
  } catch (e) {
    logger.warn('[remoteSigning] supersede older contract links failed', { leadId, err: e && e.message });
  }
}

async function signableHtmlPathOk(db, htmlPath, leadId, lead) {
  const uid = signablePathUid(htmlPath, leadId);
  if (!uid || !lead) return false;
  if (uidInLeadTenant(uid, lead, null)) return true;
  if (!lead.companyId) return false;
  try {
    const u = await db.doc(`users/${uid}`).get();
    return uidInLeadTenant(uid, lead, u.exists ? (u.data() || {}) : null);
  } catch (e) {
    logger.warn('[remote-signing] tenant check failed', { leadId, err: e.message });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// EXECUTED RECORD = THE ORIGINAL + THE SIGNATURES (security review 2026-10-05)
//
// The visible-text gate above cannot see markup: a signer could add a
// <script>, an on*= handler, a style= / <style> (CSS content: paints a new
// price), an <img>/<link>/<iframe>/<object>/<form>, and the submitted bytes
// became the record reps open (nbd-doc-viewer.js renders it with scripts on).
// So the record is no longer the submission. It is rebuilt from the document
// WE served; the only thing taken from the submission is, per signature
// block, one PNG data URL that decodes to a real PNG. Every other byte —
// inside the blocks too (the "Signed <date>" stamp, the finalized markers) —
// is written here.
// ═══════════════════════════════════════════════════════════════
const MAX_SIG_PNG_CHARS = 2 * 1024 * 1024;

/** Top-level <div data-nbd-sig="role"> blocks: [{ start, end, open, role, body }]. */
function signatureBlocks(html) {
  const src = String(html);
  const out = [];
  const re = /<div\b[^>]*\bdata-nbd-sig\s*=\s*(["'])([^"']*)\1[^>]*>/gi;
  let m;
  while ((m = re.exec(src))) {
    const end = endOfDivAt(src, m.index);
    if (end < 0) return null;                   // unbalanced — cannot trust either side
    out.push({ start: m.index, end, open: m[0], role: m[2], body: src.slice(m.index + m[0].length, end - '</div>'.length) });
    re.lastIndex = end;
  }
  return out;
}

/** The block's PNG data URL when it is a real PNG, else null. */
function signaturePngIn(blockBody) {
  const m = /<img\b[^>]*?\bsrc\s*=\s*(["'])(data:image\/png;base64,([A-Za-z0-9+/]+={0,2}))\1/i.exec(String(blockBody));
  if (!m || m[2].length > MAX_SIG_PNG_CHARS) return null;
  const bytes = Buffer.from(m[3], 'base64');
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 16 || MAGIC.some((b, i) => bytes[i] !== b)) return null;
  return m[2];
}

/** The original block, finalized by the server with `png`. */
function finalizeBlock(block, png, when) {
  const attr = (name) => { const a = new RegExp('\\b' + name + '\\s*=\\s*(["\'])([^"\']*)\\1', 'i').exec(block.open); return a ? a[2] : ''; };
  const role = block.role.replace(/[^A-Za-z0-9_-]/g, '');
  const alt = escHtml(attr('data-label') || (role + ' signature'));
  const img = `<img src="${png}" alt="${alt}" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">`;
  const day = when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const stamp = `<div class="nbd-sig-date">Signed ${escHtml(day)}</div>`;
  let body = block.body;
  const canvas = /<canvas\b[^>]*>(\s*<\/canvas>)?/i.exec(body);
  body = canvas ? body.slice(0, canvas.index) + img + body.slice(canvas.index + canvas[0].length) : img + body;
  const ctrl = /<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\bnbd-sig-controls\b[^"']*\1[^>]*>/i.exec(body);
  const ctrlEnd = ctrl ? endOfDivAt(body, ctrl.index) : -1;
  body = ctrlEnd > 0 ? body.slice(0, ctrl.index) + stamp + body.slice(ctrlEnd) : body + stamp;
  const open = block.open.replace(/>$/, ` data-nbd-sig-finalized="1" data-nbd-sig-signed-at="${when.toISOString()}">`);
  return open + body + '</div>';
}

/**
 * Build the executed record from the ORIGINAL.
 * Returns { ok:true, html, signed } or { ok:false, reason } (reason carries
 * no document content). Blocks must line up one-for-one by role; a block the
 * submission finalized must carry a real PNG; a block it left alone (an
 * optional signer, or one already signed in person) stays as served.
 */
function rebuildSignedRecord(originalHtml, signedHtml, when) {
  const orig = String(originalHtml);
  const ob = signatureBlocks(orig);
  const sb = signatureBlocks(signedHtml);
  if (!ob || !sb) return { ok: false, reason: 'unbalanced' };
  if (ob.length === 0) return { ok: false, reason: 'noFields' };
  if (ob.length !== sb.length || ob.some((b, i) => b.role !== sb[i].role)) {
    return { ok: false, reason: `blocks differ (original ${ob.length}, submitted ${sb.length})` };
  }
  const isFinal = (open) => /\bdata-nbd-sig-finalized\s*=\s*["']1["']/i.test(open);
  let out = '', at = 0, signed = 0;
  for (let i = 0; i < ob.length; i++) {
    const o = ob[i], s = sb[i];
    out += orig.slice(at, o.start);
    if (!isFinal(o.open) && isFinal(s.open)) {
      const png = signaturePngIn(s.body);
      if (!png) return { ok: false, reason: `block ${i} has no valid PNG signature` };
      out += finalizeBlock(o, png, when);
      signed++;
    } else {
      out += orig.slice(o.start, o.end);
    }
    at = o.end;
  }
  out += orig.slice(at);
  if (!signed) return { ok: false, reason: 'unsigned' };
  return { ok: true, html: out, signed };
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════════════════════════════
// createSignRequest — rep mints a token + emails the sign link.
// ═══════════════════════════════════════════════════════════════
exports.createSignRequest = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    timeoutSeconds: 20,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B): a viewer is read-only — no sign link minted
    // and no email to the signer, even on a lead the viewer owns (the owner
    // check below).
    assertNotViewer(request.auth.token);
    // A compromised rep session could otherwise mint tokens / send mail
    // in a loop. 20/min/uid is far above any real workflow.
    await callableRateLimit(request, 'createSignRequest', 20, 60_000);
    // R3-11: and a daily cap, shared with the e-sign envelope sends — this
    // mails from the platform domain and sign-up is open.
    await callableRateLimit(request, 'signLinkEmailDaily', ESL.SIGN_EMAIL_DAILY_CAP, 86_400_000);

    const d = request.data || {};
    const leadId = typeof d.leadId === 'string' ? d.leadId : null;
    const docId = typeof d.docId === 'string' ? d.docId : null;
    const signerEmail = typeof d.signerEmail === 'string' ? d.signerEmail.trim() : '';
    const signerName = typeof d.signerName === 'string' ? d.signerName.trim().slice(0, 120) : '';
    if (!leadId || !docId) throw new HttpsError('invalid-argument', 'leadId and docId required');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(signerEmail)) {
      throw new HttpsError('invalid-argument', 'A valid signer email is required');
    }

    const db = getFirestore();
    // Owner-scope: the rep must own the lead (or be platform admin).
    const leadSnap = await db.doc(`leads/${leadId}`).get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
    const lead = leadSnap.data();
    const isAdmin = request.auth.token.role === 'admin';
    if (lead.userId !== uid && !isAdmin) throw new HttpsError('permission-denied', 'Not your lead');
    // R3-11: the link goes only to an email on this lead's record (its email,
    // or a saved alternate) — never to any address the caller types.
    if (!ESL.recipientOnRecord(lead, signerEmail)) {
      throw new HttpsError('failed-precondition', ESL.SIGN_EMAIL_NOT_ON_RECORD);
    }

    // The document must already be persisted (the generator uploaded its
    // interactive HTML to Storage). We sign THAT doc, not arbitrary HTML.
    const docSnap = await db.doc(`leads/${leadId}/documents/${docId}`).get();
    if (!docSnap.exists) throw new HttpsError('not-found', 'Document not found');
    const docMeta = docSnap.data();
    // Joe 2026-11-14: a document that is already signed never gets a new
    // link (a second signing would overwrite the signed record). The one
    // exception is a signature whose signed copy could not be saved
    // (signedSaveFailed): re-sending it is the recovery path.
    if ((docMeta.signedAt || docMeta.status === 'signed') && docMeta.signedSaveFailed !== true) {
      throw new HttpsError('failed-precondition', 'This document is already signed. Open the signed copy from the Documents tab; to change it, generate a new document and send that one.');
    }
    const htmlPath = docMeta.htmlPath || null;
    if (!htmlPath) throw new HttpsError('failed-precondition', 'This document has no signable HTML on file');
    // htmlPath is client-written: confine it to THIS lead's own documents/
    // object before anything reads it or a token carries it.
    if (!(await signableHtmlPathOk(db, htmlPath, leadId, lead))) {
      logger.error('[createSignRequest] htmlPath outside lead prefix — refusing', { leadId, docId });
      throw new HttpsError('failed-precondition', 'This document cannot be sent for signature. Generate it again, then send that one.');
    }
    // 2026-10-04: a contract goes out for signature only with the Notice of
    // Right to Cancel + both completed FTC forms attached. A contract
    // generated before they were added has none — it is refused with the fix.
    // Review 2026-11-18 (findings 2 and 7): the pre-send gap check runs HERE, on the server, from the
    // stored document, the lead, the company profile and the locked price; the browser check is UX only.
    // The flag is read strictly: a read that FAILS refuses the send (retryable) instead of reading "off".
    const gateClass = DE.isContractClass(docMeta.type);
    // flagOnAtMint is ALSO what the sign page will do about consent: it is stamped on the token (consentAsked)
    // so getSignDocument and submitSignature follow the decision made here and never re-read the flag (finding 7).
    const flagOnAtMint = await DE.flagForGate(db, uid, HttpsError);
    // Review 2026-11-18, item 6: the unresolved-number / placeholder gate also runs under docClauseSetV1 (strict read,
    // a read error refuses). The consent checkbox above stays docEvidenceFoundation's alone.
    const clauseFlagOnAtMint = await DE.clauseFlagForGate(db, uid, HttpsError);
    const gateOn = (flagOnAtMint || clauseFlagOnAtMint) && (CW.isContractDocType(docMeta.type) || gateClass);
    let gateHtml = null;
    if (CW.isContractDocType(docMeta.type)) {
      let contractHtml = '';
      try {
        const [buf] = await getStorage().bucket().file(htmlPath).download();
        contractHtml = buf.toString('utf8');
      } catch (e) {
        logger.error('[createSignRequest] contract html unreadable', { leadId, docId, err: e.message });
        throw new HttpsError('unavailable', 'Could not read the contract. Try again shortly.');
      }
      if (!KyLaw.hasCancelPacket(contractHtml)) {
        throw new HttpsError('failed-precondition',
          'This contract was made before the 3-day cancellation forms were added. Generate the contract again, then send that one.');
      }
      gateHtml = contractHtml;
    }
    if (gateOn && gateHtml == null) {
      try {
        const [gbuf] = await getStorage().bucket().file(htmlPath).download();
        gateHtml = gbuf.toString('utf8');
      } catch (e) {
        logger.error('[createSignRequest] document html unreadable for the send check', { leadId, docId, err: e.message });
        throw new HttpsError('unavailable', 'Could not read the document. Try again shortly.');
      }
    }

    // The price this contract is sent at (money review 2026-11-14, finding 8):
    // a snapshot of the estimate the signature will bill (the lead's primary,
    // signed-price.js), kept on the admin-only token. At signing the stamp
    // bills THIS, even if the estimate is re-priced while the link is out —
    // the way an e-sign envelope keeps its pricedSnapshot. Best-effort: with
    // no snapshot the signing bills the estimate as it then stands (the old
    // behaviour).
    // A contract that goes out WITHOUT a locked price is never silent (review,
    // 2026-11-14): the caller gets priceLocked:false + why, the token carries
    // priceSnapshotMissing, and the rep's bell says so at signing.
    // Note: the snapshot is the primary estimate as it stands at SEND, not a
    // reading of the contract page (it may have been generated earlier).
    const isContract = CW.isContractDocType(docMeta.type);
    let priceSnapshot = null;
    let priceLockReason = null;
    if (isContract) {
      const pid = typeof lead.primaryEstimateId === 'string' ? lead.primaryEstimateId : '';
      try {
        const es = pid && /^[A-Za-z0-9_-]{1,128}$/.test(pid) ? await db.doc(`estimates/${pid}`).get() : null;
        const r = SP.signRequestSnapshot(leadId, lead, es && es.exists ? es.data() : null, pid, Date.now());
        priceSnapshot = r.snapshot;
        priceLockReason = r.reason;
      } catch (e) {
        priceLockReason = 'read_failed';
        logger.warn('[createSignRequest] price snapshot failed', { leadId, docId, err: e.message });
      }
      if (!priceSnapshot) logger.warn('[createSignRequest] contract link sent WITHOUT a locked price', { leadId, docId, reason: priceLockReason });
    }

    const now = Date.now();
    const ttlDays = 7;
    const expiresAt = Timestamp.fromMillis(now + ttlDays * 86_400_000);
    const token = mintSignToken();

    // Multi-tenant branding: resolve the tenant's legal name so the signing
    // email AND the sign-page chrome announce THEIR company, not NBD. Keyed
    // by the lead's companyId (falls back to the lead owner's uid for solo
    // tenants). Resolved BEFORE the mint (2026-07-19 white-label) so it can
    // be stamped on the token for getSignDocument. NBD (profile brand
    // legalName is NBD's, or absent) leaves tenantName '' → the exact
    // lead.repName || NBD fallback below stands → byte-identical.
    let tenantName = '';
    let tenantProfile = {};
    const tenantKey = lead.companyId || lead.userId;
    if (tenantKey) {
      try {
        const cpSnap = await db.doc(`companyProfile/${tenantKey}`).get();
        if (cpSnap.exists) tenantProfile = cpSnap.data() || {};
        if (cpSnap.exists) { const _ln = ((cpSnap.data() || {}).brand || {}).legalName || ''; tenantName = (_ln && _ln !== 'No Big Deal Home Solutions') ? _ln : ''; }  // NBD-name guard (byte-identical; mirrors render-pdf.js/sms-functions.js)
      } catch (e) {
        logger.warn('[createSignRequest] tenant resolve failed', { leadId, err: e.message });
      }
    }

    // Fail closed (flag docEvidenceFoundation, default OFF): price, property address, homeowner name,
    // company mailing address, legal entity name and any [Placeholder] / {{token}} left in the stored
    // document. A profile that could not be read counts as blank, never as fine.
    if (gateOn) {
      let gatePrice = priceSnapshot && priceSnapshot.totalCents > 0 ? priceSnapshot.totalCents : null;
      if (gatePrice == null) {
        try {
          const gpid = typeof lead.primaryEstimateId === 'string' ? lead.primaryEstimateId : '';
          const ges = gpid && /^[A-Za-z0-9_-]{1,128}$/.test(gpid) ? await db.doc(`estimates/${gpid}`).get() : null;
          if (ges && ges.exists) gatePrice = DE.estimateCents(ges.data());
        } catch (_) { gatePrice = null; }
      }
      const gaps = DE.serverContractGaps({
        type: docMeta.type, html: gateHtml, lead, profile: tenantProfile, tenantKey, KyLaw,
        priceCents: gatePrice, homeownerName: signerName || undefined,
      });
      if (gaps.length) throw new HttpsError('failed-precondition', DE.describeGaps(gaps));
    }

    // Phase 3 (flag docAtticAckV1, read strictly: a read error refuses): a re-roof contract does not go out for
    // signature until the signed attic form (or the signed not-inspected page, or a recorded owner override) exists.
    if (AG.gated(docMeta.type) && await DE.atticGateOn(db, uid, lead, HttpsError)) {
      let dec;
      try { dec = await AG.decide(db, leadId, lead, { estimateId: docMeta.estimateId }); }
      catch (e) {
        logger.warn('[createSignRequest] attic gate unreadable', { leadId, err: e.message });
        throw new HttpsError('unavailable', 'Could not check the attic acknowledgment just now. Nothing was sent. Try again in a moment.');
      }
      if (!dec.satisfied) throw new HttpsError('failed-precondition', dec.message);
    }

    await db.doc(`doc_sign_tokens/${token}`).set({
      leadId,
      docId,
      ownerUid: lead.userId,
      mintedBy: uid,
      htmlPath,
      docTypeName: docMeta.typeName || docMeta.type || 'Document',
      signerName: signerName || (lead.firstName ? `${lead.firstName} ${lead.lastName || ''}`.trim() : ''),
      signerEmail,
      // '' for NBD → sign.html keeps its NBD literals byte-identical.
      companyName: tenantName || '',
      docType: typeof docMeta.type === 'string' ? docMeta.type.slice(0, 60) : null,
      consentAsked: flagOnAtMint === true,
      priceSnapshot,
      ...(isContract && !priceSnapshot ? { priceSnapshotMissing: true, priceLockReason } : {}),
      // Evidence parity (2026-11-18): the clause set this document was sent under.
      ...DE.stampFor(KyLaw, lead, {}, { html: gateHtml, v1: clauseFlagOnAtMint === true }),
      status: 'pending',
      mintedAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

    // One live contract link per customer (review H1, 2026-11-14): a new
    // contract link retires the older pending ones, so a homeowner can't sign
    // yesterday's price after today's (the e-sign envelope does the same).
    if (isContract) await supersedeContractTokens(db, leadId, lead.userId, token, 'new_link');

    // Document lifecycle: draft -> sent. Best-effort and separate from the
    // token above (doc_sign_tokens.status is the token's own pending/signed/
    // expired state) — a failure here must not stop the mint+email below,
    // it only means the CRM's "awaiting signature" label doesn't light up.
    try {
      await db.doc(`leads/${leadId}/documents/${docId}`).set({ status: 'sent' }, { merge: true });
    } catch (e) {
      logger.warn('[createSignRequest] status stamp failed', { leadId, docId, err: e.message });
    }

    // PR5: email the homeowner the signing link via Resend (same provider
    // as email-functions.js). Best-effort — the token is already minted,
    // so a transient mail failure surfaces to the rep without losing it.
    let emailed = false;
    try {
      const { Resend } = require('resend');
      const resend = new Resend(RESEND_API_KEY.value());
      const fromEmail = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
      const link = SIGN_URL_BASE + token;
      const docName = escHtml(docMeta.typeName || docMeta.type || 'document');
      const repName = escHtml(tenantName || lead.repName || 'No Big Deal Home Solutions');
      // Email category: TRANSACTIONAL — a document signing link. Not gated by the unsubscribe register (email-suppression.js SEND_PATHS).
      const response = await MessagingControls.guardResend(getFirestore(), resend).emails.send({
        from: fromEmail,
        to: signerEmail,
        // Subject is plain text: the tenant-written type name is cleaned, NOT
        // HTML-escaped (docName above is the escaped body copy).
        subject: `Please sign your ${ESL.cleanLabel(docMeta.typeName || docMeta.type || 'document', 60) || 'document'}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#12223d;">
          <p>Hi ${escHtml(signerName || lead.firstName || 'there')},</p>
          <p>${repName} has a <strong>${docName}</strong> ready for your signature. It only takes a minute — just tap the button, sign on your phone, and you're done.</p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${escHtml(link)}" style="background:#bd5728;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;display:inline-block;">Review &amp; Sign</a>
          </p>
          <p style="font-size:12px;color:#666;">This secure link expires in 7 days and can only be used once. If you didn't expect this, you can ignore the email.</p>
        </div>`,
      });
      // Resend resolves { data: null, error } on an API-level rejection
      // instead of throwing — without this check `emailed` (returned to
      // the caller below) would be true for a homeowner who never got the
      // signing link, exactly the "transient mail failure surfaces to the
      // rep" promise the comment above makes.
      if (resendRejected(response)) {
        throw new Error(resendErrorMessage(response));
      }
      emailed = true;
    } catch (e) {
      logger.warn('[createSignRequest] email send failed', { leadId, docId, err: e.message });
    }

    logger.info('[createSignRequest] minted', { leadId, docId, emailed });
    return {
      token, expiresAt: expiresAt.toMillis(), emailed, signLink: SIGN_URL_BASE + token,
      // null = not a contract (nothing to lock); false = sent without a
      // locked price, with why (the viewer warns the rep).
      priceLocked: isContract ? !!priceSnapshot : null,
      priceLockReason: isContract && !priceSnapshot ? priceLockReason : null,
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// getSignDocument — homeowner POSTs token → the doc HTML to sign.
// ═══════════════════════════════════════════════════════════════
exports.getSignDocument = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 40,
    concurrency: 40,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    // Per-IP rate limit — stops token brute-forcing.
    if (!(await httpRateLimit(req, res, 'docsign-get:ip', 30, 60_000))) return;

    const token = (req.body && req.body.token) || '';
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid link' }); return;
    }

    const db = getFirestore();
    const tokSnap = await db.doc(`doc_sign_tokens/${token}`).get();
    if (!tokSnap.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
    const tok = tokSnap.data();
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'This signing link has expired. Contact your rep for a new one.' }); return;
    }
    if (tok.status !== 'pending') {
      // A superseded link says so (#3055); a signature whose signed copy could not be stored (#3053) says so on a
      // reload too, not "nothing more to do".
      res.status(410).json({ error: tok.status === 'superseded' ? SUPERSEDED_MSG
        : tok.signedSaveFailed === true
          ? 'We received your signature, but the signed copy could not be saved. Your contractor will contact you to confirm.'
          : 'This document has already been signed.' }); return;
    }

    // Re-check the path on every use: a token minted before the 2026-10-05
    // fix may name an object outside its lead.
    {
      let lead = null;
      try { const ls = await db.doc(`leads/${tok.leadId}`).get(); lead = ls.exists ? ls.data() : null; } catch (_) { lead = null; }
      if (!(await signableHtmlPathOk(db, tok.htmlPath, tok.leadId, lead))) {
        logger.error('[getSignDocument] htmlPath outside lead prefix — refusing', { token: token.slice(0, 6), leadId: tok.leadId || null });
        res.status(410).json({ error: 'This signing link is no longer valid. Contact your rep for a new one.' }); return;
      }
    }

    // Serve the interactive doc HTML the generator uploaded to Storage.
    let html = '';
    try {
      const file = getStorage().bucket().file(tok.htmlPath);
      const [buf] = await file.download();
      html = buf.toString('utf8');
    } catch (e) {
      logger.error('[getSignDocument] html fetch failed', { token: token.slice(0, 6), err: e.message });
      res.status(500).json({ error: 'Could not load the document. Try again shortly.' }); return;
    }
    // The cancellation notice the homeowner reads is dated today (the day
    // they sign), not the day the rep generated the contract.
    try { html = KyLaw.restampCancelPacket(html, new Date()); } catch (_) { /* serve as stored */ }

    // Viewed stamp. R4-10 (2026-10-06): awaited briefly before the response
    // (awaitBriefly) so Cloud Run's post-response CPU throttle can't drop it.
    const pendingWrites = [];
    pendingWrites.push(db.doc(`doc_sign_tokens/${token}`).update({
      viewedAt: FieldValue.serverTimestamp(),
    }).catch(() => {}));
    // 2026-10-03: this open used to be silent. Stamp lead.lastViewedAt and
    // send Jo the ONE estimate_viewed alert (throttled per lead per 6h across
    // portal / review link / deal room / here). Fire-and-forget; never throws.
    if (tok.leadId) {
      pendingWrites.push(EVA.recordEstimateView(db, {
        leadId: String(tok.leadId), ownerUid: tok.ownerUid || null, source: 'remote_sign',
        customerName: tok.signerName || '', what: tok.docTypeName || 'the document',
      }).catch(() => {}));
    }
    await awaitBriefly(pendingWrites);

    // Flag docEvidenceFoundation (default OFF): ask for the consent the e-sign envelope already
    // asks for, in the e-sign envelope's own words (never text from the wire). The page shows a
    // checkbox only when this is present.
    // The decision was made when the link was minted (tok.consentAsked); only a link minted before that
    // field existed reads the flag as it stands.
    // Review 2 (item 8): for such a legacy link a flag read that FAILS is not "off": the page is not served
    // without knowing whether consent is required (retryable 503). A flag that is simply off still serves.
    let consentOn;
    if (typeof tok.consentAsked === 'boolean') consentOn = tok.consentAsked;
    else {
      try { consentOn = await DE.flagForUid(db, tok.mintedBy || tok.ownerUid, { strict: true }); }
      catch (e) {
        logger.warn('[getSignDocument] consent flag unreadable for a link minted before the snapshot — not served', { msg: e && e.message });
        res.status(503).json({ error: 'Could not load the document right now. Please try again shortly.' }); return;
      }
    }
    const consent = consentOn ? { required: true, text: ESL.CONSENT_TEXT } : null;

    // Only the minimum the sign page needs — no lead internals.
    res.status(200).json({
      html,
      ...(consent ? { consent } : {}),
      docTypeName: tok.docTypeName || 'Document',
      signerName: tok.signerName || '',
      // '' for NBD (page keeps its NBD chrome); tenant name for white-label.
      companyName: tok.companyName || '',
    });
  }
);

// ═══════════════════════════════════════════════════════════════
// submitSignature — homeowner POSTs token + signed HTML → burn + store.
// ═══════════════════════════════════════════════════════════════
exports.submitSignature = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 40,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '512MiB', // signed HTML can carry embedded PNG dataURLs
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'docsign-submit:ip', 20, 60_000))) return;

    const { token, signedHtml, consent } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid link' }); return;
    }
    if (typeof signedHtml !== 'string' || signedHtml.length < 50) {
      res.status(400).json({ error: 'Signed document missing' }); return;
    }
    // Hard cap — a signed doc with a few embedded signature PNGs is well
    // under this; anything larger is abuse.
    if (signedHtml.length > 6 * 1024 * 1024) {
      res.status(413).json({ error: 'Signed document too large' }); return;
    }

    const db = getFirestore();
    const tokRef = db.doc(`doc_sign_tokens/${token}`);

    // ── INTEGRITY GATE — runs BEFORE the burn on purpose ──────────────
    // A tampered submission must not consume the homeowner's one-shot token:
    // if we burned first and rejected after, an attacker could grief a real
    // signing by firing one bad payload, and a legitimate signer hitting a
    // false positive could never retry. Reading the token here is cheap and
    // the transaction below re-reads it authoritatively, so this adds no
    // TOCTOU risk — the worst case is wasted work on a doomed request.
    let originalHtml = null;
    let record = null;        // the executed record, rebuilt from the original
    let verifiedPath = null;  // the htmlPath the checks below ran against
    let consentAsked = false; // flag docEvidenceFoundation: the page showed the consent checkbox
    let atticResult = null;   // a document with tick controls (the attic acknowledgment): what the homeowner ticked, read back server-side
    let signedDocType = null;
    {
      const pre = await tokRef.get();
      if (!pre.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
      const p = pre.data();
      if (p.status === 'pending') {
        // Before the burn, like every gate below: a missing consent tick must not consume the
        // homeowner's one-shot link.
        if (typeof p.consentAsked === 'boolean') consentAsked = p.consentAsked;
        else {
          // A legacy link (no snapshot): an unreadable flag must not read "off" and skip the consent tick.
          try { consentAsked = await DE.flagForUid(db, p.mintedBy || p.ownerUid, { strict: true }); }
          catch (e) {
            logger.warn('[submitSignature] consent flag unreadable for a link minted before the snapshot — refusing before the burn', { msg: e && e.message });
            res.status(503).json({ error: 'Could not record your signature right now. Nothing was used up; please try again shortly.' }); return;
          }
        }
        if (consentAsked && consent !== true) {
          res.status(422).json({ error: 'Please tick the box to agree to sign electronically, then submit again.', needsConsent: true });
          return;
        }
        // Fail CLOSED on a path outside the lead (or none at all): that token
        // used to skip every gate below, burn, and write the counterparty's
        // bytes to whatever it named.
        let lead = null;
        try { const ls = await db.doc(`leads/${p.leadId}`).get(); lead = ls.exists ? ls.data() : null; } catch (_) { lead = null; }
        if (!(await signableHtmlPathOk(db, p.htmlPath, p.leadId, lead))) {
          logger.error('[submitSignature] htmlPath outside lead prefix — refusing', { token: token.slice(0, 6), leadId: p.leadId || null });
          res.status(410).json({ error: 'This signing link is no longer valid. Contact your rep for a new one.' });
          return;
        }
        verifiedPath = p.htmlPath;
        try {
          const [buf] = await getStorage().bucket().file(p.htmlPath).download();
          originalHtml = buf.toString('utf8');
        } catch (e) {
          // Cannot verify what we cannot read. Fail CLOSED: this endpoint
          // mints the executed record of a contract, so "store it unchecked"
          // is not an acceptable degradation.
          logger.error('[submitSignature] original unreadable — refusing', {
            token: token.slice(0, 6), htmlPath: p.htmlPath, err: e.message,
          });
          res.status(503).json({ error: 'Could not verify the document right now. Please try again shortly.' });
          return;
        }
        const verdict = signedDocMatchesOriginal(originalHtml, signedHtml);
        if (!verdict.ok) {
          logger.error('[submitSignature] SUBMITTED DOCUMENT DOES NOT MATCH THE ORIGINAL — refusing', {
            token: token.slice(0, 6),
            leadId: p.leadId || null,
            docId: p.docId || null,
            reason: verdict.reason,
          });
          res.status(422).json({ error: 'This document could not be verified. Please reload the page and sign again.' });
          return;
        }

        // Refuse to mint an executed record that contains no signature.
        // Runs BEFORE the burn, like the integrity gate above, so a
        // document we should never have sent does not consume the token.
        const sig = signedDocHasSignature(originalHtml, signedHtml);
        if (!sig.ok) {
          logger.error('[submitSignature] REFUSING — no signature in the executed record', {
            token: token.slice(0, 6),
            leadId: p.leadId || null,
            docId: p.docId || null,
            reason: sig.reason,
          });
          if (sig.reason === 'noFields') {
            // Our fault, not the signer's. 422 with a message that does not
            // send them round the loop again.
            res.status(422).json({
              error: 'This document was sent without a signature field and cannot be signed. Please contact your rep for a corrected copy.',
              noFields: true,
            });
          } else {
            res.status(422).json({ error: 'No signature was captured. Please draw your signature and submit again.' });
          }
          return;
        }

        // The record is the ORIGINAL plus validated signature images —
        // never the submitted bytes. Before the burn, like the gates above.
        const rebuilt = rebuildSignedRecord(originalHtml, signedHtml, new Date());
        if (!rebuilt.ok) {
          logger.error('[submitSignature] REFUSING — signature blocks could not be verified', {
            token: token.slice(0, 6), leadId: p.leadId || null, docId: p.docId || null, reason: rebuilt.reason,
          });
          res.status(422).json({ error: 'Your signature could not be verified. Please reload the page and sign again.' });
          return;
        }
        record = rebuilt.html;
        // Phase 3 (attic acknowledgment): a document with tick controls is recorded with the ticks the signer made,
        // taken from the submission for the controls the ORIGINAL has and nothing else. Every required tick and a
        // Yes or No on every line is enforced here, not only in the page. Before the burn.
        if (AG.isAtticDoc(p.docType) || AA.parseAcks(originalHtml).length) {
          // Review 2026-11-18 (finding 2): the ORIGINAL is rep-authored. It must be the server's own attic form for this document
          // type (same controls, required flags, marker and wording) or the submission is refused, before the burn.
          const mf = AG.verifyManifest(typeof p.docType === 'string' ? p.docType : '', originalHtml);
          if (!mf.ok) {
            logger.error('[submitSignature] attic form does not match the server manifest - refusing', { token: token.slice(0, 6), leadId: p.leadId || null, docId: p.docId || null, reasons: mf.reasons });
            res.status(422).json({ error: mf.reasons.indexOf('too_large') !== -1 ? AG.TOO_LARGE_MSG : 'This acknowledgment could not be verified. Please contact your rep for a corrected copy.' });
            return;
          }
          const applied = AG.applyAcks(rebuilt.html, signedHtml, typeof p.docType === 'string' ? p.docType : '');
          if (!applied.complete) {
            res.status(422).json({ error: 'Please tick every box and choose Yes or No on every line, then sign again.', missingAcks: true });
            return;
          }
          record = applied.html;
          signedDocType = typeof p.docType === 'string' ? p.docType : null;
          atticResult = AG.resultFor(signedDocType, applied.html, null);
          // Review 2 (item 4): the form is bound to the estimate it covers (id and stamp), read before the burn; a read that fails refuses.
          try { const dm = await db.doc(`leads/${p.leadId}/documents/${p.docId}`).get(); const b = await AG.formBasis(db, p.leadId, lead || {}, { estimateId: dm && dm.exists ? (dm.data() || {}).estimateId : undefined }); atticResult.estimateId = b.id; atticResult.estimateStamp = b.stamp; }
          catch (_) { res.status(503).json({ error: 'Could not record your signature right now. Nothing was used up; please try again shortly.' }); return; }
        }
      }
    }

    // ATOMIC single-use burn: flip pending → signed inside a transaction
    // so two concurrent submits can't both sign (TOCTOU). Mirrors the
    // portal.js write-once pattern.
    // Review 2 (2026-11-18), item 2: the homeowner's evidence is written onto the admin-only sign token
    // INSIDE the burn transaction, so if the document-row stamp below fails for good the facts still exist
    // somewhere durable and the row can be re-stamped from them. (doc_sign_tokens is write:false for clients.)
    const signedAtNow = new Date();
    const evidenceFacts = {
      path: 'remote_link',
      ...DE.requestFacts(req),
      documentSha256: originalHtml ? DE.sha256Hex(originalHtml) : null,
      consent: consentAsked ? { agreed: true, text: ESL.CONSENT_TEXT, at: signedAtNow.getTime() } : { agreed: null },
      signedAtMs: signedAtNow.getTime(),
    };
    let info;
    try {
      info = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) { const e = new Error('nf'); e._http = 404; e._msg = 'Invalid link'; throw e; }
        const t = snap.data();
        if (t.expiresAt && t.expiresAt.toMillis && t.expiresAt.toMillis() < Date.now()) {
          const e = new Error('exp'); e._http = 410; e._msg = 'This signing link has expired.'; throw e;
        }
        if (t.status === 'superseded') { const e = new Error('superseded'); e._http = 410; e._msg = SUPERSEDED_MSG; throw e; }
        if (t.status !== 'pending') {
          const e = new Error('done'); e._http = 409; e._msg = 'This document has already been signed.'; throw e;
        }
        if (!verifiedPath || t.htmlPath !== verifiedPath || record == null) {
          const e = new Error('unverified'); e._http = 409; e._msg = 'This document changed while you were signing. Please reload the page.'; throw e;
        }
        tx.update(tokRef, { status: 'signed', signedAt: FieldValue.serverTimestamp(),
          evidenceFacts: Object.assign({}, evidenceFacts, {
            clauseSetVersion: t.clauseSetVersion || null, clauseIds: Array.isArray(t.clauseIds) ? t.clauseIds : [],
            clauseRefsMismatch: t.clauseRefsMismatch === true,
          }),
        });
        return { leadId: t.leadId, docId: t.docId, ownerUid: t.ownerUid, htmlPath: t.htmlPath, signerName: t.signerName || '',
          docType: t.docType || null,
          clauseSetVersion: t.clauseSetVersion || null, clauseIds: Array.isArray(t.clauseIds) ? t.clauseIds : [],
          clauseRefsMismatch: t.clauseRefsMismatch === true,
          priceSnapshot: (t.priceSnapshot && typeof t.priceSnapshot === 'object') ? t.priceSnapshot : null,
          priceSnapshotMissing: t.priceSnapshotMissing === true, priceLockReason: t.priceLockReason || null };
      });
    } catch (err) {
      if (err && err._http) { res.status(err._http).json({ error: err._msg }); return; }
      logger.error('[submitSignature] burn txn failed', { msg: err.message });
      res.status(500).json({ error: 'Could not record your signature. Try again.' }); return;
    }

    // Token is now burned. Persist the signed HTML + notify the rep.
    // A failure here can't double-sign (status already flipped); we log
    // and still return success so the homeowner isn't asked to re-sign.
    // ARCHIVE THE ORIGINAL FIRST, then overwrite. The old code overwrote
    // htmlPath directly, which destroyed the only artifact a later dispute
    // could be settled against — and did so with bytes supplied by the
    // counterparty.
    //
    // htmlPath is deliberately still the object that ends up holding the
    // signed copy: the document record's htmlUrl is a download URL for THAT
    // object, and it is what the rep opens from the documents tab. Writing
    // the signed copy somewhere else instead would have left every rep
    // looking at an unsigned contract — a security fix that silently breaks
    // the feature. So the original is copied aside, and the overwrite now
    // carries content the integrity gate above has already proven matches it.
    // The record carries the Notice of Right to Cancel re-rendered from the
    // copy we served and dated today, the signing day (2026-10-04).
    // 2026-10-08 (review R4 D9): tried twice; cancelBy is ALWAYS counted from
    // the signing, never read back from a packet that kept an older date, and
    // a record whose packet could not be re-dated (or stored) is flagged
    // (cancelPacketStale) on the document and the lead for the rep.
    let recordHtml = record;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        recordHtml = CW.finalizeSignedPacket(originalHtml, record, signedAtNow);
        if (!KyLaw.signingCancelBy(recordHtml, signedAtNow).stale) break;
        throw new Error('the re-dated notice does not carry the signing date');
      } catch (e) {
        logger.warn('[submitSignature] cancel packet re-date failed (attempt ' + attempt + ' of 2)', { msg: e.message });
      }
    }
    const hasPacket = KyLaw.hasCancelPacket(originalHtml) || KyLaw.hasCancelPacket(recordHtml);
    const cxl = hasPacket ? KyLaw.signingCancelBy(recordHtml, signedAtNow) : null;
    // The served contract carried the packet but the record lost it → stale too.
    if (cxl && !KyLaw.hasCancelPacket(recordHtml)) cxl.stale = true;
    const cancelBy = cxl ? cxl.cancelBy : '';
    let archivePath = null;
    try {
      if (originalHtml != null) {
        archivePath = info.htmlPath.replace(/(\.html?)?$/i, '') + `.original-${Date.now()}.html`;
        await getStorage().bucket().file(archivePath).save(
          Buffer.from(originalHtml, 'utf8'),
          { contentType: 'text/html', resumable: false }
        );
      }
    } catch (e) {
      archivePath = null;
      logger.warn('[submitSignature] original archive failed', { msg: e.message });
    }
    let recordSaved = false;
    for (let attempt = 1; attempt <= 2 && !recordSaved; attempt++) {
      try {
        const file = getStorage().bucket().file(info.htmlPath);
        await file.save(Buffer.from(recordHtml, 'utf8'), { contentType: 'text/html', resumable: false });
        recordSaved = true;
      } catch (e) {
        logger.warn('[submitSignature] signed html upload failed (attempt ' + attempt + ' of 2)', { msg: e.message });
      }
    }
    // The stored copy still holds the contract as generated (its old date).
    if (cxl && !recordSaved) cxl.stale = true;
    if (recordSaved && cxl && cxl.stale) logger.error('[submitSignature] cancel packet NOT re-dated — flagged for a new Notice of Cancellation', { docId: info.docId });
    // Both tries to store the signed copy failed (2026-11-14): htmlPath still
    // holds the UNSIGNED original and the token is burned. Flag the document,
    // tell the rep plainly (not "Document signed"), and tell the page so the
    // homeowner is not promised a recorded signature.
    const sha = (s) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex');
    const ids = { docId: info.docId, leadId: info.leadId, ownerUid: info.ownerUid };
    if (!recordSaved) logger.error('[submitSignature] signed copy NOT saved — document flagged signedSaveFailed', ids);
    const docRef = db.doc(`leads/${info.leadId}/documents/${info.docId}`);
    // Joe 2026-11-14: an unsaved signature does NOT mark the document signed.
    // No status / signedAt / signedRemotely (customer-documents.js infers
    // "signed" from any of them), so it keeps reading "sent" with the
    // warning; unsavedSignatureAt records when the signature came in.
    const docPatch = {
      ...(recordSaved
        ? { status: 'signed', signedAt: FieldValue.serverTimestamp(), signedRemotely: true }
        : { unsavedSignatureAt: FieldValue.serverTimestamp() }),
      remoteSignerName: info.signerName || null,
      // htmlPath now holds the signed copy (unchanged behaviour for the
      // documents tab); this is the untouched original we served.
      originalHtmlPath: archivePath,
      // Digest of the document we SERVED, so a later dispute can prove what
      // was put in front of the signer without trusting either party's copy.
      originalSha256: originalHtml ? sha(originalHtml) : null,
      // Only a STORED signed copy gets signedSha256. An unsaved one is
      // recorded as unsavedRecordSha256 so nobody mistakes it for the hash of
      // what htmlPath holds; a successful save clears any stale flag (the
      // signed-row lock means no client can).
      ...(recordSaved
        ? { signedSha256: sha(recordHtml), signedSaveFailed: FieldValue.delete() }
        : { signedSha256: null, unsavedRecordSha256: sha(recordHtml), signedSaveFailed: true }),
      ...(cancelBy && recordSaved ? Object.assign({ cancelBy }, CW.staleRecordPatch(cxl)) : {}),
      // Evidence parity (2026-11-18). IP and user agent come from THIS request, never the body.
      // Consent is recorded only when the page asked for it (flag docEvidenceFoundation), with
      // the server's own copy of the text.
      signatureEvidence: DE.buildEvidence({
        path: 'remote_link',
        clauseSetVersion: info.clauseSetVersion, clauseIds: info.clauseIds, clauseRefsMismatch: info.clauseRefsMismatch === true,
        documentSha256: originalHtml ? sha(originalHtml) : null,
        signedSha256: recordSaved ? sha(recordHtml) : null,
        consent: consentAsked ? { agreed: true, text: ESL.CONSENT_TEXT, at: signedAtNow.getTime() } : { agreed: null },
        signedAtMs: signedAtNow.getTime(),
        ...DE.requestFacts(req),
      }),
    };
    // The tick states travel with the evidence (acknowledgments: [{ id, checked }]); atticAckResult is what the
    // warranty and the contract gate read, server-written (server-owned in firestore.rules).
    if (atticResult) {
      docPatch.signatureEvidence.acknowledgments = atticResult.acknowledgments;
      docPatch.atticAckResult = Object.assign({}, atticResult, { formDateMs: signedAtNow.getTime() });
    }
    // Review 2 (2026-11-18), item 7: the row write REPLACES signatureEvidence as a whole (mergeFields lists the
    // top-level keys), so the new record can never deep-merge into an older one and read as a hybrid. And a row
    // that already carries evidence from ANOTHER path (an in-person record) keeps it untouched: the homeowner's
    // record then lives whole on the admin-only token (signatureEvidence there), and the skip is logged.
    let evidenceSkipped = false;
    try {
      const curRow = await docRef.get();
      const ce = curRow && curRow.exists ? (curRow.data() || {}).signatureEvidence : null;
      if (ce && typeof ce === 'object' && ce.path !== 'remote_link') evidenceSkipped = true;
    } catch (_) { evidenceSkipped = false; }
    const rowPatch = Object.assign({}, docPatch);
    if (evidenceSkipped) {
      delete rowPatch.signatureEvidence;
      logger.warn('[submitSignature] the row already has signatureEvidence from another path — kept as is; the remote signatureEvidence is on the sign token', ids);
      try { await tokRef.update({ signatureEvidence: docPatch.signatureEvidence, signatureEvidenceNotStamped: 'row_has_other_path' }); }
      catch (e) { logger.error('[submitSignature] could not keep the remote signatureEvidence on the token either', Object.assign({ msg: e.message }, ids)); }
    }
    const rowWrite = { mergeFields: Object.keys(rowPatch) };
    const who = info.signerName ? info.signerName + ' ' : 'A homeowner ';
    const note = {
      userId: info.ownerUid,
      type: 'remote_signature',
      leadId: info.leadId,
      title: recordSaved ? 'Document signed' : 'Signed copy NOT saved — action needed',
      message: who + (recordSaved
        ? 'signed a document remotely.'
        : 'signed a document remotely, but the signed copy was not saved. The stored document is still the unsigned original. Contact them and send a new signing link.'),
      priority: 'high',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    };
    let notified = false;
    if (recordSaved) {
      // The signed copy is stored and the link is burned; this row write is what makes the document read
      // "signed" and carries its evidence. A single failure used to only warn (review 2026-11-18, finding 8):
      // retried with backoff, and if it still fails it is flagged for the rep, never silent.
      let stamped = false;
      const backoffMs = [0, 250, 1000];
      for (let attempt = 1; attempt <= backoffMs.length && !stamped; attempt++) {
        if (backoffMs[attempt - 1]) await new Promise((r) => setTimeout(r, backoffMs[attempt - 1]));
        try { await docRef.set(rowPatch, rowWrite); stamped = true; }
        catch (e) { logger.warn('[submitSignature] doc meta stamp failed (attempt ' + attempt + ' of ' + backoffMs.length + ')', { msg: e.message }); }
      }
      if (!stamped) {
        logger.error('[submitSignature] signed copy saved but the document row could NOT be stamped — flagged signedStampFailed', ids);
        note.title = 'Signed, but the document record is incomplete — action needed';
        note.message = who + 'signed a document remotely and the signed copy is saved, but the document still reads "sent" and its signing record was not written. Open the document, check the signed copy, and mark it signed.';
        for (let attempt = 1; attempt <= 2 && !notified; attempt++) {
          try {
            const b = db.batch();
            b.set(docRef, { signedStampFailed: true, signedStampFailedAt: FieldValue.serverTimestamp() }, { merge: true });
            b.set(db.collection('notifications').doc(), note);
            b.update(tokRef, { docStampFailed: true, signatureEvidence: docPatch.signatureEvidence });
            await b.commit();
            notified = true;
          } catch (e) {
            logger.error('[submitSignature] stamp-failure flag + rep alert write failed (attempt ' + attempt + ' of 2)', Object.assign({ msg: e.message }, ids));
          }
        }
        if (!notified) {
          try { await tokRef.update({ docStampFailed: true, signatureEvidence: docPatch.signatureEvidence }); } catch (_) { /* the activity row below is the other channel */ }
          try {
            await db.collection(`leads/${info.leadId}/activity`).add({
              userId: info.ownerUid, type: 'remote_signature_unstamped', label: 'Signed, document record incomplete',
              message: note.message, docId: info.docId, createdAt: FieldValue.serverTimestamp(),
            });
          } catch (e) {
            logger.error('[submitSignature] activity fallback failed too — the rep has NO signal of the unstamped document', Object.assign({ msg: e.message }, ids));
          }
        }
      }
    } else {
      // The flag and the bell are the rep's only signals: one batch (with the
      // token, so a reload of the link says the same thing), tried twice, then
      // a row on the lead's activity timeline as the second channel.
      for (let attempt = 1; attempt <= 2 && !notified; attempt++) {
        try {
          const b = db.batch();
          b.set(docRef, rowPatch, rowWrite);
          b.set(db.collection('notifications').doc(), note);
          b.update(tokRef, { signedSaveFailed: true });
          await b.commit();
          notified = true;
        } catch (e) {
          logger.error('[submitSignature] save-failure flag + rep alert write failed (attempt ' + attempt + ' of 2)', Object.assign({ msg: e.message }, ids));
        }
      }
      if (!notified) {
        // Second channel: the flag alone, and a row on the lead's activity
        // timeline. The bell is tried once more on its own below.
        try { await docRef.set(rowPatch, rowWrite); } catch (e) {
          logger.error('[submitSignature] save-failure flag write failed', Object.assign({ msg: e.message }, ids));
        }
        try {
          await db.collection(`leads/${info.leadId}/activity`).add({
            userId: info.ownerUid,
            type: 'remote_signature_unsaved',
            label: 'Signed copy NOT saved',
            message: note.message,
            docId: info.docId,
            createdAt: FieldValue.serverTimestamp(),
          });
        } catch (e) {
          logger.error('[submitSignature] activity fallback failed too — the rep has NO signal of the unsaved signature', Object.assign({ msg: e.message }, ids));
        }
      }
    }
    // Joe 2026-11-14: with no stored signed copy the job does not advance and
    // no cancel-by date is stamped; the rep re-sends (createSignRequest allows
    // it for a signedSaveFailed document) and the good signing does both.
    if (cancelBy && recordSaved) await CW.stampLeadCancelBy(db, info.leadId, cancelBy, logger, { ownerUid: info.ownerUid }, CW.staleLeadPatch(cxl, 'remote_sign'));
    // Job spine (2026-10-03): a remotely signed CONTRACT moves the job, the
    // way an in-person signing already stamps it. Best-effort — the signature
    // is recorded; a failure here only leaves the card where it was.
    // Only a STORED signed copy moves the job (Joe 2026-11-14, #3053) and retires the customer's other pending
    // contract links (#3055 review H1); an unsaved one leaves both as they were, so the re-sent link can finish it.
    if (recordSaved) {
      const spineOut = await spineAfterRemoteSign(db, info);
      if (CW.isContractDocType(info.docType) || (spineOut && spineOut.spine)) {
        await supersedeContractTokens(db, info.leadId, info.ownerUid, token, 'contract_signed');
      }
      // The estimate was re-priced while the link was out: the bills use the price the homeowner signed. Say so on
      // the rep's bell (finding 8); signed-price.js also writes it to the lead's activity feed.
      const sp = spineOut && spineOut.spine && spineOut.spine.signedPrice;
      let moved = sp && sp.movedSinceSent
        ? ' Signed at ' + usd(sp.totalCents) + '; the estimate now says ' + usd(sp.currentTotalCents)
          + '. Bills use the signed ' + usd(sp.totalCents) + ' until the homeowner re-signs.'
        : '';
      // The link went out without a locked price: never silent at signing.
      if (info.priceSnapshotMissing) {
        moved += ' The price was not locked when this link was sent (' + String(info.priceLockReason || 'unknown').replace(/_/g, ' ')
          + '), so bills follow the estimate as it stood at signing — check it.';
      }
      note.message += moved;
    }
    if (!notified) {
      try { await db.collection('notifications').add(note); } catch (e) {
        if (recordSaved) logger.warn('[submitSignature] notify failed', { msg: e.message });
        else logger.error('[submitSignature] save-failure rep alert failed', Object.assign({ msg: e.message }, ids));
      }
    }

    res.status(200).json(recordSaved ? { ok: true } : { ok: true, saved: false });
  }
);
