/**
 * functions/report-sharing.js — share a saved inspection report with the homeowner
 *
 * Lets a rep mint a no-login link to a saved inspection report so the homeowner
 * can view it. Previously there was NO share path: saveReport() persisted the
 * report HTML inline in /reports/{id}, the customer portal's "View" button read
 * a never-written `htmlUrl`, and the /reports rule is owner-only, so a homeowner
 * could never reach a report.
 *
 * Mirrors the audited deal-acceptance.js / portal.js / remote-signing.js token
 * model, simplified because a report is VIEW-ONLY (no acceptance / signature /
 * burn):
 *   - report_share_tokens/{token} is admin-SDK only (firestore.rules)
 *   - token = 24 chars over a 32-char no-confusable alphabet (~120 bits)
 *   - server-checked expiry (default 30 days); REUSABLE (homeowner may reopen)
 *   - getSharedReport reads the content via the admin SDK (bypassing the
 *     owner-only rule) and serves it same-origin — the homeowner never reads
 *     Firestore/Storage directly.
 *
 * TWO SUBJECT KINDS (2026-09-08). A token points at one of:
 *
 *   kind 'report'        — a row in the top-level /reports collection whose HTML
 *                          is stored inline. Inspection reports, roof reports,
 *                          property intel. The original path.
 *   kind 'lead_document' — a row in leads/{leadId}/documents backed by a PDF in
 *                          Storage. A filed photo report (source
 *                          'photo_report', PR #1483) is one of these, and until
 *                          now could only be downloaded and attached — there was
 *                          no reportId for it to be shared under, so the one
 *                          delivery contractors increasingly expect (a link that
 *                          opens on a phone, forwards to the adjuster, expires,
 *                          and can be tracked) was unreachable for it.
 *
 * The PDF is streamed through the function rather than redirected to, so the
 * token stays the only credential and revocation/expiry are honoured on every
 * load. See the comment at the serve site for why a redirect is not equivalent.
 *
 * Exports:
 *   createReportShareToken (onCall)    — rep mints a share link for a report or
 *                                        a lead document they may share
 *   getSharedReport        (onRequest) — /report/<token> → serves that content
 *
 * Security: getSharedReport is intentionally NOT App-Check / auth gated — that's
 * the point of a no-login view link. Compensating controls: unguessable token +
 * expiry + per-IP rate limit + the report HTML is the rep's own generated content
 * (no homeowner-writable surface here). No PII beyond the report the rep chose to
 * share is exposed.
 */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { defineSecret } = require('firebase-functions/params');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');
const { callableRateLimit, assertNotViewer } = require('./shared');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  // Was 'nbd-pro.web.app' (a typo — that host has never existed; the
  // Firebase project is nobigdeal-pro). #700 (2026-06-23) fixed this
  // typo in a dozen sibling files but missed this one. Fixed 2026-09-14.
  'https://nobigdeal-pro.web.app',
];
const REPORT_URL_BASE = 'https://nobigdealwithjoedeal.com/report/';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// 32-char no-confusable alphabet (no 0/O, 1/I/L) — same as deal-acceptance.js / portal.js.
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mintToken() {
  const bytes = require('crypto').randomBytes(24);
  let s = '';
  for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return s;
}
// Content-Disposition is a header, and the filename comes off a Firestore row a
// rep can write. Strip anything that could close the quoted-string or inject a
// second header, then fall back rather than emit an empty filename="".
function sanitizeFilename(s) {
  const clean = String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return clean.replace(/^[._]+/, '') || 'report.pdf';
}
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Firestore auto-ids and the lead ids this CRM mints. Deliberately narrower
// than the reportId pattern: these two interpolate into a document path.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// A rendered PDF lives at pdf-renders/{uid}/{ts}-{filename} (render-pdf.js:588).
// Nothing else in the bucket is shareable through this function.
const RENDER_PATH_RE = /^pdf-renders\/[A-Za-z0-9_-]{1,128}\/[^/\\]{1,240}$/;

// ── Subject resolvers ────────────────────────────────────────────
// Each returns the common descriptor the mint path writes into the token doc,
// having already proved the caller may share the thing.

async function resolveReportSubject(db, { uid, isAdmin, reportId }) {
  // Owner-scope: the rep must own the report (or be platform admin).
  const repSnap = await db.doc(`reports/${reportId}`).get();
  if (!repSnap.exists) throw new HttpsError('not-found', 'Report not found');
  const report = repSnap.data();
  if (report.userId !== uid && !isAdmin) throw new HttpsError('permission-denied', 'Not your report');
  if (!report.html || typeof report.html !== 'string') {
    throw new HttpsError('failed-precondition', 'This report has no saved content to share');
  }
  const meta = report.metadata || {};
  return {
    kind: 'report',
    logId: reportId,
    reportId,
    ownerUid: report.userId,
    companyId: report.companyId || report.userId,
    leadId: report.leadId || null,
    customerName: String(meta.propertyAddress || report.type || '').slice(0, 160),
    subjectNoun: 'inspection report',
    bodyNoun: report.type || 'inspection report',
  };
}

async function resolveLeadDocumentSubject(db, { uid, isAdmin, leadId, documentId, token }) {
  const leadSnap = await db.doc(`leads/${leadId}`).get();
  if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
  const lead = leadSnap.data() || {};
  const docSnap = await db.doc(`leads/${leadId}/documents/${documentId}`).get();
  if (!docSnap.exists) throw new HttpsError('not-found', 'Document not found');
  const row = docSnap.data() || {};
  if (row.deleted === true) throw new HttpsError('not-found', 'Document not found');

  // Mirror the WRITE clause of firestore.rules:389, not the READ clause above
  // it. Read admits `viewer` and any company reader; minting a share link
  // PUBLISHES the document to anyone holding the URL, which is an authoring
  // act. The roles that may attach a document are the roles that may hand it
  // out — lead owner, same-company staff (company_admin|manager), platform
  // admin. A viewer who can see the report still cannot broadcast it.
  const role = (token && token.role) || '';
  const myCompany = (token && token.companyId) || '';
  const isStaff = role === 'company_admin' || role === 'manager';
  const sameCompany = !!myCompany && lead.companyId === myCompany;
  if (!isAdmin && lead.userId !== uid && !(isStaff && sameCompany)) {
    throw new HttpsError('permission-denied', 'Not your lead');
  }

  // `storagePath`, never the recorded `url`. render-pdf.js:625-640 hands back a
  // 7-day signed URL where the compute SA can reach IAM signBlob and a
  // never-expiring download-token URL where it cannot, so the recorded link is
  // either already dead or permanently public — neither is a thing to build a
  // revocable share link on. The path is stable and re-readable.
  const storagePath = typeof row.storagePath === 'string' ? row.storagePath.trim() : '';
  if (!storagePath) {
    throw new HttpsError('failed-precondition',
      'This document has no stored file to share. Regenerate it and try again.');
  }
  // Two independent guards, because a `documents` row is CLIENT-writable by the
  // lead owner and by company staff. Without them a rep could point
  // `storagePath` at any object in the bucket — a teammate's render, a photo
  // under photos/ — and this function would mint an unauthenticated public URL
  // for it. That is a privilege escalation, not a share feature.
  //
  //   1. Syntactic: the path must be inside pdf-renders/{uid}/ — no traversal,
  //      no other prefix.
  //   2. Provenance: the object's own custom metadata must carry the
  //      `renderedBy` stamp render-pdf.js:596 writes, and that uid must be the
  //      caller or the lead's owner. Storage object metadata is written by the
  //      renderer with the admin SDK and is not client-writable, so it is the
  //      half of this that a forged Firestore row cannot fake.
  if (!RENDER_PATH_RE.test(storagePath)) {
    throw new HttpsError('failed-precondition', 'This document cannot be shared as a link.');
  }
  let renderedBy = '';
  let contentType = 'application/pdf';
  let size = 0;
  try {
    const [meta] = await getStorage().bucket().file(storagePath).getMetadata();
    renderedBy = String((meta.metadata && meta.metadata.renderedBy) || '');
    contentType = String(meta.contentType || 'application/pdf');
    size = Number(meta.size || 0) || 0;
  } catch (e) {
    logger.warn('[createReportShareToken] storage metadata read failed', {
      leadId, documentId, err: e && e.message,
    });
    throw new HttpsError('not-found', 'The file for this document is no longer available.');
  }
  if (!renderedBy) {
    throw new HttpsError('failed-precondition', 'This document cannot be shared as a link.');
  }
  if (!isAdmin && renderedBy !== uid && renderedBy !== lead.userId) {
    throw new HttpsError('permission-denied', 'Not your document');
  }

  // Reuse a live token if this row already carries one.
  let existingToken = '';
  let existingExpiresAt = null;
  const prior = typeof row.shareToken === 'string' ? row.shareToken : '';
  if (prior && /^[A-Z0-9]{10,64}$/.test(prior)) {
    try {
      const tokSnap = await db.doc(`report_share_tokens/${prior}`).get();
      if (tokSnap.exists) {
        const t = tokSnap.data() || {};
        const active = !t.status || t.status === 'active';
        const unexpired = !t.expiresAt || !t.expiresAt.toMillis || t.expiresAt.toMillis() > Date.now();
        if (active && unexpired && t.storagePath === storagePath) {
          existingToken = prior;
          existingExpiresAt = t.expiresAt || null;
        }
      }
    } catch (e) {
      logger.warn('[createReportShareToken] prior token read failed', { leadId, documentId, err: e.message });
    }
  }

  const isPhotoReport = row.source === 'photo_report';
  const label = String(row.reportNumber || row.name || 'document').slice(0, 160);
  return {
    kind: 'lead_document',
    logId: `${leadId}/${documentId}`,
    reportId: null,
    ownerUid: lead.userId || uid,
    companyId: lead.companyId || lead.userId || uid,
    leadId,
    customerName: String(lead.address || row.name || '').slice(0, 160),
    subjectNoun: isPhotoReport ? 'photo report' : 'document',
    bodyNoun: isPhotoReport ? (row.reportNumber ? `photo report ${row.reportNumber}` : 'photo report') : (row.name || 'document'),
    existingToken,
    existingExpiresAt,
    tokenExtras: {
      documentId,
      storagePath,
      contentType,
      size,
      filename: String(row.name || 'report.pdf').slice(0, 200),
      reportNumber: String(row.reportNumber || '').slice(0, 64),
      docLabel: label,
    },
    // Record the link on the row so the Documents tab can show that this
    // document has been shared, and so the next "Share link" reuses it rather
    // than minting a second URL for the same file. Best-effort: the token is
    // already written and the rep already has the link.
    onMinted: async (tokenId, expiresAt) => {
      try {
        await db.doc(`leads/${leadId}/documents/${documentId}`).set({
          shareToken: tokenId,
          shareUrl: REPORT_URL_BASE + tokenId,
          sharedAt: FieldValue.serverTimestamp(),
          shareExpiresAt: expiresAt,
        }, { merge: true });
      } catch (e) {
        logger.warn('[createReportShareToken] share write-back failed', { leadId, documentId, err: e.message });
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// createReportShareToken — rep mints a reusable view link for a report.
// ═══════════════════════════════════════════════════════════════
exports.createReportShareToken = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 20,
    memory: '256MiB',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B): a viewer is read-only. The subject checks
    // below already refuse a viewer on someone else's lead, but admit the
    // OWNER whatever their role — a share link publishes the document, so
    // the role is refused first.
    assertNotViewer(request.auth.token);
    // A compromised rep session could otherwise mint tokens in a loop.
    await callableRateLimit(request, 'createReportShareToken', 30, 60_000);

    const d = request.data || {};
    const reportId = typeof d.reportId === 'string' ? d.reportId : null;
    const leadId = typeof d.leadId === 'string' ? d.leadId : null;
    const documentId = typeof d.documentId === 'string' ? d.documentId : null;
    // reportId wins when both are supplied, so an existing caller is unaffected
    // by a stray field.
    const wantsLeadDoc = !reportId && !!(leadId || documentId);
    if (!wantsLeadDoc && (!reportId || !/^[A-Za-z0-9_-]{6,128}$/.test(reportId))) {
      throw new HttpsError('invalid-argument', 'A valid reportId is required');
    }
    if (wantsLeadDoc && (!ID_RE.test(leadId || '') || !ID_RE.test(documentId || ''))) {
      throw new HttpsError('invalid-argument', 'A valid leadId and documentId are required');
    }

    const db = getFirestore();
    const isAdmin = request.auth.token.role === 'admin';

    // The share subject is one of two things.
    //
    //   'report'        — a row in the top-level /reports collection whose HTML
    //                     is stored inline. The original path, unchanged.
    //   'lead_document' — a row in leads/{leadId}/documents backed by a PDF in
    //                     Storage. A filed photo report is one of these.
    //
    // Extending the token rather than teaching the photo report to write a
    // /reports row is deliberate. getSharedReport serves `report.html`, and a
    // photo report has no HTML — it is Chromium output from a Handlebars
    // template. Storing a second, HTML rendering of the same document would put
    // a viewable copy and a downloadable copy on separate renderers, free to
    // disagree; PR #1483 had just finished removing one instance of exactly
    // that (a picker promising numbered photos a template never emitted).
    const subject = wantsLeadDoc
      ? await resolveLeadDocumentSubject(db, { uid, isAdmin, leadId, documentId, token: request.auth.token })
      : await resolveReportSubject(db, { uid, isAdmin, reportId });

    const now = Date.now();
    const ttlDays = 30;

    // Reuse a live token instead of minting a second one for the same document.
    // A rep who taps "Share link" twice should hand out one URL, not two, or
    // revoking the link they actually sent revokes nothing.
    let token = subject.existingToken || '';
    let expiresAt = subject.existingExpiresAt || null;
    if (!token) {
      expiresAt = Timestamp.fromMillis(now + ttlDays * 86_400_000);
      token = mintToken();
      await db.doc(`report_share_tokens/${token}`).set(Object.assign({
        kind: subject.kind,
        reportId: subject.reportId,
        ownerUid: subject.ownerUid,
        companyId: subject.companyId,
        leadId: subject.leadId,
        customerName: subject.customerName,
        status: 'active',
        mintedBy: uid,
        mintedAt: FieldValue.serverTimestamp(),
        expiresAt,
      }, subject.tokenExtras || {}));
      if (subject.onMinted) await subject.onMinted(token, expiresAt);
    }

    const shareUrl = REPORT_URL_BASE + token;

    // Optionally email the homeowner the link. The rep may pass an explicit
    // `email`; otherwise resolve the lead's email from the report's leadId.
    // Best-effort — the token is already minted, so a mail failure surfaces to
    // the rep (emailed:false) without losing the link.
    let toEmail = (typeof d.email === 'string' && EMAIL_RE.test(d.email.trim())) ? d.email.trim() : '';
    let firstName = '';
    if (!toEmail && subject.leadId) {
      try {
        const leadSnap = await db.doc(`leads/${subject.leadId}`).get();
        if (leadSnap.exists) {
          const lead = leadSnap.data();
          firstName = String(lead.firstName || '').slice(0, 80);
          if (typeof lead.email === 'string' && EMAIL_RE.test(lead.email.trim())) toEmail = lead.email.trim();
        }
      } catch (e) { logger.warn('[createReportShareToken] lead email lookup failed', { err: e.message }); }
    }

    let emailed = false;
    if (toEmail) {
      // Multi-tenant branding: resolve the tenant's legal name so the subject
      // line names THEIR company, not NBD. Keyed by the report's companyId
      // (falls back to the report owner's uid for solo tenants). One
      // best-effort read (only on the email path); NBD (profile brand.legalName
      // is NBD's, or absent) leaves tenantName '' → the exact NBD subject
      // stands → byte-identical.
      let tenantName = '';
      const tenantKey = subject.companyId;
      if (tenantKey) {
        try {
          const cpSnap = await db.doc(`companyProfile/${tenantKey}`).get();
          if (cpSnap.exists) { const _ln = ((cpSnap.data() || {}).brand || {}).legalName || ''; tenantName = (_ln && _ln !== 'No Big Deal Home Solutions') ? _ln : ''; }  // NBD-name guard (byte-identical; mirrors render-pdf.js/sms-functions.js)
        } catch (e) {
          logger.warn('[createReportShareToken] tenant resolve failed', { subjectId: subject.logId, err: e.message });
        }
      }
      try {
        const { Resend } = require('resend');
        const resend = new Resend(RESEND_API_KEY.value());
        const fromEmail = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
        // Two nouns, deliberately. The subject line has always been a fixed
        // string while the body used the report's own type; keeping them
        // separate is what makes the /reports path byte-identical here.
        const reportName = escHtml(subject.bodyNoun);
        // Email category: TRANSACTIONAL — delivers a report / document the customer is receiving. Not gated by the unsubscribe register (email-suppression.js SEND_PATHS).
        const response = await resend.emails.send({
          from: fromEmail,
          to: toEmail,
          subject: `Your ${subject.subjectNoun} from ${tenantName || 'No Big Deal Home Solutions'}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#12223d;">
            <p>Hi ${escHtml(firstName || 'there')},</p>
            <p>Your <strong>${reportName}</strong> is ready. Tap the button below to view it — no login needed.</p>
            <p style="text-align:center;margin:28px 0;">
              <a href="${escHtml(shareUrl)}" style="background:#bd5728;color:#fff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;display:inline-block;">View Your Report</a>
            </p>
            <p style="font-size:12px;color:#666;">This secure link expires in 30 days. If you didn't expect this, you can ignore the email.</p>
          </div>`,
        });
        // Resend resolves { data: null, error } on an API-level rejection
        // instead of throwing — without this check `emailed` (returned to
        // the caller below and shown to the rep) would be true for a
        // homeowner who never received the report link.
        if (resendRejected(response)) {
          throw new Error(resendErrorMessage(response));
        }
        emailed = true;
      } catch (e) {
        logger.warn('[createReportShareToken] email send failed', { subjectId: subject.logId, err: e.message });
      }
    }

    logger.info('[createReportShareToken] minted', {
      kind: subject.kind, subjectId: subject.logId, reused: !!subject.existingToken, emailed,
    });
    // A reused token carries whatever expiry it was minted with, and a legacy
    // token doc may carry none at all — so this is not unconditionally a
    // Timestamp the way it was when every call minted one.
    const expiresMs = (expiresAt && typeof expiresAt.toMillis === 'function') ? expiresAt.toMillis() : null;
    return { token, shareUrl, expiresAt: expiresMs, emailed, sentTo: emailed ? toEmail : null, reused: !!subject.existingToken };
  }
);

// ═══════════════════════════════════════════════════════════════
// getSharedReport — /report/<token> → serve the report HTML (view-only).
// ═══════════════════════════════════════════════════════════════
exports.getSharedReport = onRequest(
  {
    region: 'us-central1',
    maxInstances: 40,
    concurrency: 40,
    // 15s was sized for an inline-HTML read. A photo report is a multi-MB PDF
    // streamed from Storage over a phone connection; the bytes are piped, never
    // buffered, so this raises the ceiling without raising the memory floor.
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (req, res) => {
    const errPage = (code, msg) => {
      res.status(code).set('Content-Type', 'text/html; charset=utf-8').set('X-Robots-Tag', 'noindex, nofollow')
        // Neutral, unbranded title — an unresolvable/expired report link must
        // not assert NBD's (or any tenant's) identity to a stranger's homeowner.
        .send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Inspection Report</title><body style="font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><div style="font-size:44px">📋</div><p style="max-width:420px;line-height:1.6;font-size:16px">${escHtml(msg)}</p></div></body>`);
    };
    // token is the last path segment: /report/<token>
    const m = (req.path || '').match(/\/report\/([A-Za-z0-9]{10,64})\/?$/);
    const token = m ? m[1] : '';
    if (!token) { errPage(400, 'This report link is invalid.'); return; }
    // Per-IP rate limit — stops token brute-forcing.
    if (!(await httpRateLimit(req, res, 'sharedreport-get:ip', 30, 60_000))) return;

    const db = getFirestore();
    const tokSnap = await db.doc(`report_share_tokens/${token}`).get();
    if (!tokSnap.exists) { errPage(404, 'This report link is invalid.'); return; }
    const tok = tokSnap.data();
    if (tok.status && tok.status !== 'active') {
      errPage(410, 'This report link has been revoked. Ask your rep for a fresh one.'); return;
    }
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      errPage(410, 'This report link has expired. Ask your rep for a fresh one.'); return;
    }

    // Fire-and-forget viewed stamp (do not gate the response).
    db.doc(`report_share_tokens/${token}`).update({
      viewedAt: FieldValue.serverTimestamp(),
      viewCount: FieldValue.increment(1),
    }).catch(() => {});

    // A lead-scoped document is a PDF in Storage, not inline HTML.
    //
    // The bytes are STREAMED through this function rather than redirecting to a
    // freshly signed Storage URL. A redirect would hand the viewer a credential
    // that outlives the token: it keeps working after the link is revoked or
    // expires, it is forwardable on its own, and where IAM signBlob is
    // unreachable (render-pdf.js:625) the only URL available to redirect to is
    // the never-expiring download-token one — which would make "expires in 30
    // days" a false statement on the email this function sends. Streaming keeps
    // the token as the only credential and every load re-checks it, which is the
    // posture the header of this file already claims ("the homeowner never reads
    // Firestore/Storage directly").
    //
    // It also means pdf-renders/ needs no public Storage rule: the admin SDK
    // bypasses storage.rules entirely. That is deliberate — gating pdf-renders/
    // is its own queued task, and this path must not pre-empt it by requiring
    // the objects to be client-readable.
    if (tok.kind === 'lead_document') {
      const path = typeof tok.storagePath === 'string' ? tok.storagePath : '';
      if (!RENDER_PATH_RE.test(path)) { errPage(404, 'This report is no longer available.'); return; }
      let file, meta;
      try {
        file = getStorage().bucket().file(path);
        [meta] = await file.getMetadata();
      } catch (e) {
        logger.error('[getSharedReport] document fetch failed', { token: token.slice(0, 6), err: e.message });
        errPage(404, 'This report is no longer available.'); return;
      }
      // Headers before the first byte; once the stream starts there is no way
      // to send an error page, so a mid-stream failure can only end the
      // response.
      res.status(200)
        .set('Content-Type', String(meta.contentType || 'application/pdf'))
        .set('Content-Length', String(meta.size || 0))
        // inline, so a phone opens it in the browser's PDF viewer instead of
        // downloading a file the homeowner then has to find.
        .set('Content-Disposition', 'inline; filename="' + sanitizeFilename(tok.filename) + '"')
        .set('X-Robots-Tag', 'noindex, nofollow')
        .set('Cache-Control', 'no-store');
      await new Promise((resolve) => {
        const stream = file.createReadStream();
        stream.on('error', (e) => {
          logger.error('[getSharedReport] stream failed', { token: token.slice(0, 6), err: e.message });
          res.destroy(); resolve();
        });
        stream.on('end', resolve);
        stream.pipe(res);
      });
      return;
    }

    // The report HTML is stored inline on the report doc (saveReport). Read it
    // via the admin SDK — the /reports rule is owner-only, so the homeowner can
    // never read it directly; only this token-gated function can.
    let html = '';
    try {
      const repSnap = await db.doc(`reports/${tok.reportId}`).get();
      if (!repSnap.exists) { errPage(404, 'This report is no longer available.'); return; }
      html = repSnap.data().html || '';
    } catch (e) {
      logger.error('[getSharedReport] report fetch failed', { token: token.slice(0, 6), err: e.message });
      errPage(500, 'We could not load this report right now. Please try again shortly.'); return;
    }
    if (!html) { errPage(404, 'This report has no content to display.'); return; }

    res.status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .set('Cache-Control', 'no-store')
      .send(html);
  }
);

module.exports = exports;
