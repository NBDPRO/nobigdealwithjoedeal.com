/**
 * functions/estimate-send.js — "Send for review", record the share, Fresh link
 * (2026-10-03).
 *
 * Jo builds estimates OUTSIDE the CRM and attaches the PDF to the customer
 * (77 estimate/quote/proposal PDFs in leads/*\/documents, imported from Drive).
 * Nothing tracked them: no lead had lastSharedAt, 17 leads sat in estimate
 * stages for a median 46 days, and the server's Twilio trial delivered 0 of 23
 * texts. So the CRM now MINTS the link and Jo SENDS it — from his own phone,
 * through the iPhone share sheet (docs/pro/js/phone-share.js). Nothing here
 * texts or emails anyone.
 *
 * Exports (all onCall, App Check enforced, viewer refused):
 *   createEstimateReviewLink { leadId, documentId }
 *       → { shareUrl, token, expiresAt, reused, a2pApproved }
 *     Mints (or reuses) the EXISTING tracked document link — a
 *     report_share_tokens doc kind 'lead_document', served at /report/<token>
 *     by report-sharing.js getSharedReport, which streams the PDF through the
 *     function. The row's Storage download-token URL is read only for its
 *     path and never returned. Nothing on the lead is stamped yet — Jo may
 *     still cancel the share sheet.
 *   recordEstimateShared { leadId, documentId, token }
 *       → { ok, spine }
 *     Called by the client ONLY after Jo actually shared (share sheet
 *     resolved, or he confirmed the Messages / Mail hand-off went out).
 *     Stamps lastSharedAt / lastSharedVia / sharedDocId / sharedDocName /
 *     sharedLinkUrl / sharedLinkExpiresAt on the lead and fires the job
 *     spine's estimate_shared event (functions/job-spine.js, PR #2123 —
 *     required defensively: a no-op until the spine is on main).
 *   freshEstimateLink { leadId, dealId? }
 *       → { kind: 'deal'|'review', url, expiresAt }
 *     Stuck leads outlive their links (deal links 14 days, review links 30;
 *     stuck median 46). Re-mints the newest open deal room's accept link
 *     (TTL = the company setting companyProfile.salesLinks.dealLinkDays,
 *     default 14) or the shared PDF's review link, and REVOKES the old
 *     link(s) with the same flip revokePortalToken uses (expiry into the past
 *     + revokedAt/revokedBy) — so the homeowner can't be holding two live
 *     links and the old one says "expired — ask your rep for a fresh one".
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { callableRateLimit, assertNotViewer } = require('./shared');
const L = require('./estimate-send-logic');
const DLL = require('./doc-link-logic');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];
const REPORT_URL_BASE = 'https://nobigdealwithjoedeal.com/report/';
const DEAL_URL_BASE = 'https://nobigdealwithjoedeal.com/deal/';
const OPTS = { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' };

// Same alphabet + length as report-sharing.js / deal-acceptance.js / portal.js.
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mintToken() {
  const bytes = require('crypto').randomBytes(24);
  let s = '';
  for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return s;
}

// The job spine (PR #2123) may not be on main yet. Load it defensively: a
// missing module is a no-op, never a failed share.
function _spine() {
  try { return require('./job-spine'); } catch (_) { return null; }
}

async function _smsA2pApproved(db) {
  try {
    const s = await db.doc('integrations/sms').get();
    return L.smsA2pApproved(s.exists ? s.data() : null)
      && await require('./messaging-controls').a2pServerTextsAllowed(db, s.exists ? s.data() : null);
  } catch (_) { return false; }
}

async function _loadLeadForShare(db, request, leadId) {
  const snap = await db.doc(`leads/${leadId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Lead not found');
  const lead = snap.data() || {};
  if (lead.deleted === true || lead.isDeleted === true) throw new HttpsError('not-found', 'Lead not found');
  if (!L.canShareLeadDoc(request.auth.token || {}, request.auth.uid, lead)) {
    throw new HttpsError('permission-denied', 'Not your lead');
  }
  return lead;
}

function _ids(d, needDoc) {
  const leadId = typeof d.leadId === 'string' ? d.leadId : '';
  const documentId = typeof d.documentId === 'string' ? d.documentId : '';
  if (!L.ID_RE.test(leadId) || (needDoc && !L.ID_RE.test(documentId))) {
    throw new HttpsError('invalid-argument', 'A valid leadId and documentId are required');
  }
  return { leadId, documentId };
}

/**
 * Resolve + vet the PDF behind a documents row. Throws HttpsError on refusal.
 * Exported for the unit test via module.exports._internals (NOT a deployable
 * export — index.js copies only the onCall exports below by name).
 */
async function resolveReviewPdf(db, { uid, isAdmin, lead, leadId, documentId }, deps) {
  const storage = (deps && deps.storage) || getStorage();
  const rowSnap = await db.doc(`leads/${leadId}/documents/${documentId}`).get();
  if (!rowSnap.exists) throw new HttpsError('not-found', 'Document not found');
  const row = rowSnap.data() || {};
  if (row.deleted === true) throw new HttpsError('not-found', 'Document not found');
  const storagePath = L.storagePathFromRow(row);
  const cls = L.classifyLeadPdfPath(storagePath, leadId, lead);
  if (!cls.ok) {
    throw new HttpsError('failed-precondition',
      cls.reason === 'not_pdf' ? 'Only a PDF can be sent for review.' : 'This file cannot be sent as a link.');
  }
  let meta;
  try {
    [meta] = await storage.bucket().file(storagePath).getMetadata();
  } catch (e) {
    throw new HttpsError('not-found', 'The file for this document is no longer stored.');
  }
  if (!L.isPdfContentType(meta && meta.contentType)) {
    throw new HttpsError('failed-precondition', 'Only a PDF can be sent for review.');
  }
  // render-pdf output: the object's own renderedBy stamp (admin-written, not
  // client-writable) must name the caller or the lead's owner — the
  // report-sharing.js provenance rule.
  if (cls.kind === 'render') {
    const by = String((meta.metadata && meta.metadata.renderedBy) || '');
    if (!by || (!isAdmin && by !== uid && by !== lead.userId)) {
      throw new HttpsError('permission-denied', 'Not your document');
    }
  }
  const name = String(row.name || row.filename || 'Estimate.pdf').slice(0, 200);
  return { row, storagePath, contentType: String(meta.contentType), size: Number(meta.size || 0) || 0, name };
}

// `opts` (Secure Document Link, 2026-11-04): { ttlDays, extra } — absent for the
// legacy "Send for review" mint, which writes exactly what it always did.
async function mintReviewToken(db, { uid, lead, leadId, documentId, pdf }, nowMs, opts) {
  const o = opts || {};
  const expiresAt = Timestamp.fromMillis(nowMs + (o.ttlDays || L.REVIEW_LINK_TTL_DAYS) * L.DAY_MS);
  const token = mintToken();
  await db.doc(`report_share_tokens/${token}`).set(Object.assign({
    kind: 'lead_document',
    purpose: 'estimate_review',
    reportId: null,
    ownerUid: lead.userId || uid,
    companyId: lead.companyId || lead.userId || uid,
    leadId,
    customerName: String(lead.address || pdf.name || '').slice(0, 160),
    status: 'active',
    mintedBy: uid,
    mintedAt: FieldValue.serverTimestamp(),
    expiresAt,
    documentId,
    storagePath: pdf.storagePath,
    contentType: pdf.contentType,
    size: pdf.size,
    filename: pdf.name,
    reportNumber: '',
    docLabel: pdf.name.slice(0, 160),
  }, o.extra || {}));
  await db.doc(`leads/${leadId}/documents/${documentId}`).set({
    shareToken: token,
    shareUrl: REPORT_URL_BASE + token,
    sharedAt: FieldValue.serverTimestamp(),
    shareExpiresAt: expiresAt,
  }, { merge: true }).catch((e) => logger.warn('[estimateSend] row write-back failed', { leadId, documentId, err: e.message }));
  return { token, expiresAt };
}

/**
 * Secure link mint. The password (generated or typed) is hashed with scrypt and
 * a per-link salt; the PLAIN value goes back to Jo once, only when WE generated
 * it, and is never stored, logged, or put in a URL. Always a fresh token:
 * a reused one could not show its password again.
 */
async function _secureLink(db, request, { uid, lead, leadId, documentId, pdf, now }) {
  const d = request.data || {};
  const days = DLL.expiryDays(d.expiryDays);
  const extra = {
    purpose: 'secure_doc',
    trackingNoticeShown: true,
    passwordRequired: false,
    unlockKey: require('crypto').randomBytes(32).toString('base64'),
    openCount: 0, fetchCount: 0, readSeconds: 0, followUpDueAtMs: null,
  };
  let generated = '';
  let plain = '';
  if (d.password === 'generate') { generated = DLL.generatePassword(); plain = generated; }
  else if (typeof d.password === 'string' && d.password.trim()) {
    if (!DLL.passwordOk(d.password)) throw new HttpsError('invalid-argument', `The password must be ${DLL.PW_MIN} to ${DLL.PW_MAX} characters.`);
    plain = d.password;
  }
  if (plain) {
    Object.assign(extra, await DLL.hashPassword(plain), { passwordRequired: true, passwordSetAt: FieldValue.serverTimestamp() });
  }
  // Another tenant's customers see THEIR name in the tracking notice; NBD keeps the approved wording.
  try {
    const key = lead.companyId || lead.userId || uid;
    const cp = await db.doc(`companyProfile/${key}`).get();
    const ln = cp.exists ? String(((cp.data() || {}).brand || {}).legalName || '').trim().slice(0, 60) : '';
    if (ln && ln !== 'No Big Deal Home Solutions') {
      extra.noticeBrand = ln;
      extra.noticeRep = String((request.auth.token || {}).name || '').trim().split(/\s+/)[0].slice(0, 40) || 'your contractor';
    }
  } catch (_) { /* default wording */ }
  const { token, expiresAt } = await mintReviewToken(db, { uid, lead, leadId, documentId, pdf }, now, { ttlDays: days, extra });
  // Summary for the Files row chip (lead.docTrack = the newest secure link). Best-effort.
  await db.doc(`leads/${leadId}`).update({
    docTrack: {
      tokenRef: token.slice(0, 10), docId: documentId, docName: pdf.name.slice(0, 160),
      openCount: 0, readSeconds: 0, expiresAt, passwordSet: !!plain,
    },
  }).catch((e) => logger.warn('[createEstimateReviewLink] docTrack write failed', { leadId, err: e.message }));
  const a2pApproved = await _smsA2pApproved(db);
  logger.info('[createEstimateReviewLink] secure ready', { leadId, documentId, days, passwordSet: !!plain });
  return {
    token,
    shareUrl: REPORT_URL_BASE + token,
    expiresAt: expiresAt.toMillis(),
    reused: false,
    docName: pdf.name,
    a2pApproved,
    secure: true,
    expiryDays: days,
    passwordRequired: !!plain,
    password: generated || null,
    noticeBrand: extra.noticeBrand || null,
    noticeRep: extra.noticeRep || null,
  };
}

exports.createEstimateReviewLink = onCall(OPTS, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  assertNotViewer(request.auth.token);
  await callableRateLimit(request, 'createEstimateReviewLink', 30, 60_000);
  const { leadId, documentId } = _ids(request.data || {}, true);
  const db = getFirestore();
  const isAdmin = (request.auth.token || {}).role === 'admin';
  const lead = await _loadLeadForShare(db, request, leadId);
  const pdf = await resolveReviewPdf(db, { uid, isAdmin, lead, leadId, documentId });
  const now = Date.now();

  // Secure Document Link (2026-11-04): password, own expiry, tracked viewer.
  if ((request.data || {}).secure === true) {
    if (!DLL.secureLinkEnabled()) throw new HttpsError('failed-precondition', 'Secure links are not turned on.');
    return _secureLink(db, request, { uid, lead, leadId, documentId, pdf, now });
  }

  // Reuse the row's live token for the SAME file: tapping Send twice hands
  // out one URL, so revoking the one Jo sent revokes the right thing.
  let token = '';
  let expiresAt = null;
  const prior = typeof pdf.row.shareToken === 'string' ? pdf.row.shareToken : '';
  if (prior && /^[A-Z0-9]{10,64}$/.test(prior)) {
    try {
      const t = await db.doc(`report_share_tokens/${prior}`).get();
      if (t.exists && L.reusableReviewToken(t.data(), pdf.storagePath, now) && t.data().purpose !== 'secure_doc') {
        token = prior; expiresAt = t.data().expiresAt || null;
      }
    } catch (e) { logger.warn('[estimateSend] prior token read failed', { leadId, err: e.message }); }
  }
  const reused = !!token;
  if (!token) ({ token, expiresAt } = await mintReviewToken(db, { uid, lead, leadId, documentId, pdf }, now));

  const a2pApproved = await _smsA2pApproved(db);
  logger.info('[createEstimateReviewLink] ready', { leadId, documentId, reused });
  return {
    token,
    shareUrl: REPORT_URL_BASE + token,
    expiresAt: expiresAt && typeof expiresAt.toMillis === 'function' ? expiresAt.toMillis() : null,
    reused,
    docName: pdf.name,
    a2pApproved,
  };
});

exports.recordEstimateShared = onCall(OPTS, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  assertNotViewer(request.auth.token);
  await callableRateLimit(request, 'recordEstimateShared', 30, 60_000);
  const d = request.data || {};
  const { leadId, documentId } = _ids(d, true);
  const token = typeof d.token === 'string' ? d.token : '';
  if (!/^[A-Z0-9]{10,64}$/.test(token)) throw new HttpsError('invalid-argument', 'token required');
  const db = getFirestore();
  const lead = await _loadLeadForShare(db, request, leadId);

  // The token must be THIS lead's link to THIS document — the client cannot
  // record a share of something it was never handed.
  const ts = await db.doc(`report_share_tokens/${token}`).get();
  const tok = ts.exists ? (ts.data() || {}) : null;
  if (!tok || tok.leadId !== leadId || tok.documentId !== documentId) {
    throw new HttpsError('failed-precondition', 'That link does not belong to this document');
  }
  const via = d.via === 'sms' || d.via === 'email' ? d.via : 'phone_share';
  await db.doc(`leads/${leadId}`).update({
    lastSharedAt: FieldValue.serverTimestamp(),
    lastSharedVia: via,
    sharedDocId: documentId,
    sharedDocName: String(tok.filename || '').slice(0, 200),
    sharedLinkUrl: REPORT_URL_BASE + token,
    sharedLinkExpiresAt: tok.expiresAt || null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  let spine = null;
  const S = _spine();
  if (S && typeof S.recordJobEvent === 'function') {
    // Never throws (job-spine.js contract); forward-only, so a re-send of an
    // estimate on a lead already past Estimate Sent moves nothing.
    spine = await S.recordJobEvent(db, {
      leadId, companyId: lead.companyId || null, event: 'estimate_shared',
      sourceId: 'review_' + token, actor: 'send for review',
      meta: { documentId, detail: 'estimate shared from Jo\'s phone' },
    }).catch(() => null);
  }
  return { ok: true, spine: spine ? { moved: !!spine.moved, to: spine.to || null } : null };
});

async function _freshDealLink(db, uid, lead, leadId, dealId, nowMs) {
  let room = null;
  if (dealId) {
    if (!L.ID_RE.test(dealId)) throw new HttpsError('invalid-argument', 'A valid dealId is required');
    const s = await db.doc(`deal_rooms/${dealId}`).get();
    if (s.exists) room = Object.assign({ id: s.id }, s.data());
    if (!room || room.leadId !== leadId) throw new HttpsError('not-found', 'Deal not found');
    if (L.DEAL_DONE.includes(room.status)) throw new HttpsError('failed-precondition', 'This deal is already accepted — no new link needed.');
  } else {
    const q = await db.collection('deal_rooms').where('leadId', '==', leadId).get();
    room = L.pickOpenDeal(q.docs.map((x) => Object.assign({ id: x.id }, x.data())), lead.userId);
  }
  if (!room) return null;

  const profKey = room.companyId || lead.companyId || room.userId;
  let profile = null;
  try { const p = await db.doc(`companyProfile/${profKey}`).get(); profile = p.exists ? p.data() : null; } catch (_) { /* default */ }
  const days = L.dealLinkDays(profile);

  // Revoke every still-pending link for this deal (same flip as portal links).
  const old = await db.collection('deal_accept_tokens').where('dealId', '==', room.id).get();
  const batch = db.batch();
  let revoked = 0;
  old.forEach((t) => {
    const v = t.data() || {};
    if (v.status !== 'pending' || v.revokedAt) return;
    batch.update(t.ref, L.revokedTokenPatch(uid, nowMs, Timestamp, FieldValue));
    revoked++;
  });

  const token = mintToken();
  const expiresAt = Timestamp.fromMillis(nowMs + days * L.DAY_MS);
  const tiers = room.tiers || {};
  const tierPrices = {};
  ['economy', 'good', 'better', 'best', 'beyond'].forEach((t) => { tierPrices[t] = Number(tiers[t] && tiers[t].price) || 0; });
  batch.set(db.doc(`deal_accept_tokens/${token}`), {
    dealId: room.id,
    ownerUid: room.userId,
    companyId: room.companyId || room.userId,
    leadId: room.leadId || null,
    customerName: String(room.customerName || '').slice(0, 120),
    htmlPath: `deal_rooms/${room.userId}/${room.id}.html`,
    tierPrices,
    status: 'pending',
    mintedBy: uid,
    mintedAt: FieldValue.serverTimestamp(),
    expiresAt,
    freshLink: true,
  });
  // The Close Board lapses a deal to "expired" off its own expiresAt; carry
  // the new date so a refreshed deal is live there too.
  batch.update(db.doc(`deal_rooms/${room.id}`), {
    expiresAt: new Date(expiresAt.toMillis()).toISOString(),
    acceptUrl: DEAL_URL_BASE + token,
    linkRefreshedAt: FieldValue.serverTimestamp(),
    ...(room.status === 'expired' ? { status: 'sent' } : {}),
  });
  await batch.commit();
  logger.info('[freshEstimateLink] deal', { leadId, dealId: room.id, revoked, days });
  return { kind: 'deal', url: DEAL_URL_BASE + token, expiresAt: expiresAt.toMillis(), revoked, dealId: room.id };
}

async function _freshReviewLink(db, uid, isAdmin, lead, leadId, nowMs) {
  const documentId = typeof lead.sharedDocId === 'string' ? lead.sharedDocId : '';
  if (!L.ID_RE.test(documentId)) return null;
  const pdf = await resolveReviewPdf(db, { uid, isAdmin, lead, leadId, documentId });
  const old = await db.collection('report_share_tokens').where('leadId', '==', leadId).get();
  const batch = db.batch();
  let revoked = 0;
  old.forEach((t) => {
    const v = t.data() || {};
    if (v.documentId !== documentId || (v.status && v.status !== 'active') || v.revokedAt) return;
    batch.update(t.ref, Object.assign(L.revokedTokenPatch(uid, nowMs, Timestamp, FieldValue), { status: 'revoked' }));
    revoked++;
  });
  if (revoked) await batch.commit();
  const { token, expiresAt } = await mintReviewToken(db, { uid, lead, leadId, documentId, pdf }, nowMs);
  await db.doc(`leads/${leadId}`).update({
    sharedLinkUrl: REPORT_URL_BASE + token,
    sharedLinkExpiresAt: expiresAt,
  }).catch(() => {});
  logger.info('[freshEstimateLink] review', { leadId, documentId, revoked });
  return { kind: 'review', url: REPORT_URL_BASE + token, token, documentId, expiresAt: expiresAt.toMillis(), revoked };
}

exports.freshEstimateLink = onCall(OPTS, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  assertNotViewer(request.auth.token);
  await callableRateLimit(request, 'freshEstimateLink', 20, 60_000);
  const d = request.data || {};
  const { leadId } = _ids(d, false);
  const dealId = typeof d.dealId === 'string' && d.dealId ? d.dealId : '';
  // kind 'review' (the customer page's PDF row) skips the deal room; a
  // documentId there names the PDF (else the lead's sharedDocId).
  const kind = d.kind === 'review' ? 'review' : (dealId || d.kind === 'deal' ? 'deal' : 'auto');
  const documentId = typeof d.documentId === 'string' && L.ID_RE.test(d.documentId) ? d.documentId : '';
  const db = getFirestore();
  const isAdmin = (request.auth.token || {}).role === 'admin';
  const lead = await _loadLeadForShare(db, request, leadId);
  const now = Date.now();
  let out = null;
  if (kind !== 'review') out = await _freshDealLink(db, uid, lead, leadId, dealId, now);
  if (!out && kind !== 'deal') {
    out = await _freshReviewLink(db, uid, isAdmin, documentId ? Object.assign({}, lead, { sharedDocId: documentId }) : lead, leadId, now);
  }
  if (!out) {
    throw new HttpsError('failed-precondition', 'Nothing has been sent yet — use "Send for review" on the estimate PDF first.');
  }
  out.a2pApproved = await _smsA2pApproved(db);
  return out;
});

// Just revoke (2026-11-04). Fresh link revokes only as a side effect of minting
// a new one; this is the plain "stop this link" for a secure document link.
exports.revokeDocumentLink = onCall(OPTS, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  assertNotViewer(request.auth.token);
  await callableRateLimit(request, 'revokeDocumentLink', 20, 60_000);
  const d = request.data || {};
  const { leadId } = _ids(d, false);
  const token = typeof d.token === 'string' ? d.token : '';
  if (!/^[A-Z0-9]{10,64}$/.test(token)) throw new HttpsError('invalid-argument', 'token required');
  const db = getFirestore();
  await _loadLeadForShare(db, request, leadId);
  const ref = db.doc(`report_share_tokens/${token}`);
  const snap = await ref.get();
  const tok = snap.exists ? (snap.data() || {}) : null;
  if (!tok || tok.leadId !== leadId || tok.purpose !== 'secure_doc') {
    throw new HttpsError('failed-precondition', 'That link does not belong to this customer');
  }
  await ref.update(Object.assign(L.revokedTokenPatch(uid, Date.now(), Timestamp, FieldValue), { status: 'revoked', followUpDueAtMs: null }));
  logger.info('[revokeDocumentLink] revoked', { leadId });
  return { ok: true };
});

// For tests only — index.js copies the callables above BY NAME.
Object.defineProperty(exports, '_internals', {
  enumerable: false,
  value: { resolveReviewPdf, mintReviewToken, _freshDealLink, _freshReviewLink, mintToken, _secureLink },
});
