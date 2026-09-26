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
const { callableRateLimit, assertNotViewer } = require('./shared');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');

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
  const a = visibleText(stripSignatureBlocks(originalHtml));
  const b = visibleText(stripSignatureBlocks(signedHtml));
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

    // The document must already be persisted (the generator uploaded its
    // interactive HTML to Storage). We sign THAT doc, not arbitrary HTML.
    const docSnap = await db.doc(`leads/${leadId}/documents/${docId}`).get();
    if (!docSnap.exists) throw new HttpsError('not-found', 'Document not found');
    const docMeta = docSnap.data();
    const htmlPath = docMeta.htmlPath || null;
    if (!htmlPath) throw new HttpsError('failed-precondition', 'This document has no signable HTML on file');

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
    const tenantKey = lead.companyId || lead.userId;
    if (tenantKey) {
      try {
        const cpSnap = await db.doc(`companyProfile/${tenantKey}`).get();
        if (cpSnap.exists) { const _ln = ((cpSnap.data() || {}).brand || {}).legalName || ''; tenantName = (_ln && _ln !== 'No Big Deal Home Solutions') ? _ln : ''; }  // NBD-name guard (byte-identical; mirrors render-pdf.js/sms-functions.js)
      } catch (e) {
        logger.warn('[createSignRequest] tenant resolve failed', { leadId, err: e.message });
      }
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
      status: 'pending',
      mintedAt: FieldValue.serverTimestamp(),
      expiresAt,
    });

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
      const response = await resend.emails.send({
        from: fromEmail,
        to: signerEmail,
        subject: `Please sign your ${docName}`,
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
    return { token, expiresAt: expiresAt.toMillis(), emailed, signLink: SIGN_URL_BASE + token };
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
      res.status(410).json({ error: 'This document has already been signed.' }); return;
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

    // Fire-and-forget viewed stamp (does not gate the response).
    db.doc(`doc_sign_tokens/${token}`).update({
      viewedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});

    // Only the minimum the sign page needs — no lead internals.
    res.status(200).json({
      html,
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

    const { token, signedHtml } = req.body || {};
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
    {
      const pre = await tokRef.get();
      if (!pre.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
      const p = pre.data();
      if (p.status === 'pending' && p.htmlPath) {
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
      }
    }

    // ATOMIC single-use burn: flip pending → signed inside a transaction
    // so two concurrent submits can't both sign (TOCTOU). Mirrors the
    // portal.js write-once pattern.
    let info;
    try {
      info = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) { const e = new Error('nf'); e._http = 404; e._msg = 'Invalid link'; throw e; }
        const t = snap.data();
        if (t.expiresAt && t.expiresAt.toMillis && t.expiresAt.toMillis() < Date.now()) {
          const e = new Error('exp'); e._http = 410; e._msg = 'This signing link has expired.'; throw e;
        }
        if (t.status !== 'pending') {
          const e = new Error('done'); e._http = 409; e._msg = 'This document has already been signed.'; throw e;
        }
        tx.update(tokRef, { status: 'signed', signedAt: FieldValue.serverTimestamp() });
        return { leadId: t.leadId, docId: t.docId, ownerUid: t.ownerUid, htmlPath: t.htmlPath, signerName: t.signerName || '' };
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
    try {
      const file = getStorage().bucket().file(info.htmlPath);
      await file.save(Buffer.from(signedHtml, 'utf8'), { contentType: 'text/html', resumable: false });
    } catch (e) {
      logger.warn('[submitSignature] signed html upload failed', { msg: e.message });
    }
    try {
      await db.doc(`leads/${info.leadId}/documents/${info.docId}`).set({
        status: 'signed',
        signedAt: FieldValue.serverTimestamp(),
        signedRemotely: true,
        remoteSignerName: info.signerName || null,
        // htmlPath now holds the signed copy (unchanged behaviour for the
        // documents tab); this is the untouched original we served.
        originalHtmlPath: archivePath,
        // Digest of the document we SERVED, so a later dispute can prove what
        // was put in front of the signer without trusting either party's copy.
        originalSha256: originalHtml
          ? require('crypto').createHash('sha256').update(originalHtml, 'utf8').digest('hex')
          : null,
        signedSha256: require('crypto').createHash('sha256').update(signedHtml, 'utf8').digest('hex'),
      }, { merge: true });
    } catch (e) { logger.warn('[submitSignature] doc meta stamp failed', { msg: e.message }); }
    try {
      await db.collection('notifications').add({
        userId: info.ownerUid,
        type: 'remote_signature',
        leadId: info.leadId,
        title: 'Document signed',
        message: (info.signerName ? info.signerName + ' ' : 'A homeowner ') + 'signed a document remotely.',
        priority: 'high',
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { logger.warn('[submitSignature] notify failed', { msg: e.message }); }

    res.status(200).json({ ok: true });
  }
);
