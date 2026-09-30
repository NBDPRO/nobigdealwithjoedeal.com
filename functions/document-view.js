/**
 * functions/document-view.js — read a generated document's HTML back, authed.
 *
 * WHY THIS REPLACES getDownloadURL
 * ────────────────────────────────
 * document-generator.js used to finish each upload with
 * `getDownloadURL(sRef)` and persist the result as `documents/{id}.htmlUrl`.
 * That call stamps a `firebaseStorageDownloadTokens` value on the object and
 * hands back a URL which:
 *
 *   - bypasses Storage Security Rules entirely,
 *   - never expires,
 *   - has no revocation path short of rewriting the object's metadata,
 *   - and was persisted into Firestore, so it leaked into every export,
 *     backup and support screenshot of that lead.
 *
 * The document is a signed contract rendered with the homeowner's name,
 * address and price. A permanent no-auth URL for that is exactly what Jo's
 * standing rule forbids, and it is the same defect #698/#702 retired for the
 * legacy customer portal.
 *
 * A short-lived signed URL is NOT the fix either. handlers/photo.js's
 * signImageUrl deliberately excludes every HTML prefix (see its H-01 note):
 * HTML fetched from storage.googleapis.com executes IN that origin, so a
 * signed URL would trade a permanent leak for a same-origin-as-Google script
 * execution surface. That is why signImageUrl's allowlist is
 * (photos|galleries|reports|docs) and not `documents`.
 *
 * So the document HTML is read back the way the other HTML surfaces already
 * work (/share, /report, /deal): the bytes come through a function, over the
 * admin SDK, after an explicit authorization check. The difference is that
 * those three serve no-login homeowners and therefore need a token; this one
 * serves the authenticated rep on customer.html, so the caller's own Firebase
 * auth IS the check and no token needs to exist at all. The client renders the
 * returned HTML in NBDDocViewer's sandboxed iframe, first-party.
 *
 * Exports:
 *   getDocumentHtml (onCall) — { leadId, docId } → { html, typeName, signedAt }
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { callableRateLimit } = require('./shared');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// Storage rules cap a documents/ upload at 5MB; anything larger did not come
// from the generator. The callable response ceiling is 10MB, so this also
// keeps a malformed object from failing the call with an opaque error.
const MAX_HTML_BYTES = 5 * 1024 * 1024;

/**
 * Same ACL matrix as signImageUrl and the Firestore lead rules: the owning
 * rep, a manager/company_admin in the owner's company, or a platform admin.
 */
async function isAuthorized(db, token, uid, lead) {
  if (lead.userId === uid) return true;
  if (token.role === 'admin') return true;

  const callerCompanyId = token.companyId || null;
  if (!callerCompanyId) return false;
  if (!['manager', 'company_admin'].includes(token.role || '')) return false;

  // Prefer the lead's own companyId — it is denormalized onto the lead and
  // saves two reads. Fall back to resolving the owner's company for leads
  // written before the companyId backfill.
  if (lead.companyId) return lead.companyId === callerCompanyId;
  if (!lead.userId) return false;
  try {
    const [userDoc, repDoc] = await Promise.all([
      db.doc(`users/${lead.userId}`).get(),
      db.doc(`reps/${lead.userId}`).get(),
    ]);
    const ownerCompanyId = (userDoc.exists && userDoc.data().companyId)
      || (repDoc.exists && repDoc.data().companyId)
      || null;
    return !!ownerCompanyId && ownerCompanyId === callerCompanyId;
  } catch (e) {
    logger.warn('[getDocumentHtml] company resolve failed', { err: e.message });
    return false;
  }
}

exports.getDocumentHtml = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Not authenticated');
    await callableRateLimit(request, 'getDocumentHtml', 60, 60_000);

    const d = request.data || {};
    const leadId = typeof d.leadId === 'string' ? d.leadId : null;
    const docId = typeof d.docId === 'string' ? d.docId : null;
    if (!leadId || !docId) throw new HttpsError('invalid-argument', 'leadId and docId required');

    const db = getFirestore();
    const leadSnap = await db.doc(`leads/${leadId}`).get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
    const lead = leadSnap.data() || {};

    if (!(await isAuthorized(db, request.auth.token || {}, uid, lead))) {
      throw new HttpsError('permission-denied', 'Not your lead');
    }

    const docSnap = await db.doc(`leads/${leadId}/documents/${docId}`).get();
    if (!docSnap.exists) throw new HttpsError('not-found', 'Document not found');
    const meta = docSnap.data() || {};
    const htmlPath = meta.htmlPath || null;
    if (!htmlPath) throw new HttpsError('failed-precondition', 'This document has no HTML on file');

    // Confine the read to this lead's own prefix. htmlPath is written by the
    // client, so without this a rep could hand us any object path in the
    // bucket and read it back through their own authorized call.
    if (!/^documents\/[^/]+\/[^/]+\//.test(htmlPath) || htmlPath.split('/')[2] !== leadId) {
      logger.error('[getDocumentHtml] htmlPath outside lead prefix', { leadId, docId, htmlPath });
      throw new HttpsError('failed-precondition', 'Document path is not readable');
    }

    try {
      const file = getStorage().bucket().file(htmlPath);
      const [objectMeta] = await file.getMetadata();
      if (Number(objectMeta.size) > MAX_HTML_BYTES) {
        throw new HttpsError('resource-exhausted', 'Document is too large to open here');
      }
      const [buf] = await file.download();
      return {
        html: buf.toString('utf8'),
        typeName: meta.typeName || meta.type || 'Document',
        filename: meta.filename || null,
        signedAt: meta.signedAt ? meta.signedAt.toMillis() : null,
      };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      // A 404 here means the object was reaped (lead deleted, GDPR erasure)
      // while its metadata doc survived — report it as missing, not as a bug.
      if (e.code === 404) throw new HttpsError('not-found', 'Document file is no longer stored');
      logger.error('[getDocumentHtml] download failed', { leadId, docId, err: e.message });
      throw new HttpsError('internal', 'Could not read the document');
    }
  }
);

// ─── Filed PDFs (2026-09-30) ─────────────────────────────────────
// money-paper.js files NBD-500 invoices and NBD-510 receipts as PDFs under
// documents/{ownerUid}/{leadId}/ with a Documents-tab row carrying `pdfPath`.
// This hands the Documents tab a SHORT-LIVED signed link to that PDF, after
// the same lead check getDocumentHtml makes. Unlike HTML, a PDF opened from
// storage.googleapis.com does not run as a page on that origin, so a signed
// URL is the right tool here; it lives 10 minutes and is minted per click, so
// the row never stores a link that can leak or go stale.
exports.getDocumentPdfUrl = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Not authenticated');
    await callableRateLimit(request, 'getDocumentPdfUrl', 60, 60_000);

    const d = request.data || {};
    const leadId = typeof d.leadId === 'string' ? d.leadId : null;
    const docId = typeof d.docId === 'string' ? d.docId : null;
    if (!leadId || !docId) throw new HttpsError('invalid-argument', 'leadId and docId required');

    const db = getFirestore();
    const leadSnap = await db.doc(`leads/${leadId}`).get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
    if (!(await isAuthorized(db, request.auth.token || {}, uid, leadSnap.data() || {}))) {
      throw new HttpsError('permission-denied', 'Not your lead');
    }
    const docSnap = await db.doc(`leads/${leadId}/documents/${docId}`).get();
    if (!docSnap.exists) throw new HttpsError('not-found', 'Document not found');
    const pdfPath = (docSnap.data() || {}).pdfPath || null;
    if (!pdfPath) throw new HttpsError('failed-precondition', 'This document has no PDF on file');
    // Same confinement as getDocumentHtml: a client can write a documents row,
    // so pdfPath must sit under THIS lead's own documents/ prefix and be a PDF.
    if (!/^documents\/[^/]+\/[^/]+\/[^/]+\.pdf$/.test(pdfPath) || pdfPath.split('/')[2] !== leadId) {
      logger.error('[getDocumentPdfUrl] pdfPath outside lead prefix', { leadId, docId, pdfPath });
      throw new HttpsError('failed-precondition', 'Document path is not readable');
    }
    try {
      const file = getStorage().bucket().file(pdfPath);
      const [exists] = await file.exists();
      if (!exists) throw new HttpsError('not-found', 'Document file is no longer stored');
      const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 10 * 60 * 1000 });
      return { url };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('[getDocumentPdfUrl] sign failed', { leadId, docId, err: e.message });
      throw new HttpsError('internal', 'Could not open the document');
    }
  }
);
