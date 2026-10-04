/**
 * estimate-send-logic.js — the PURE rules behind "Send for review",
 * "Fresh link" and the deal-link / SMS-routing settings (2026-10-03).
 *
 * functions/estimate-send.js does the Firestore / Storage I/O; this file has
 * no I/O so every rule is unit-tested (tests/estimate-send-track-2026-10-03.test.js).
 *
 * WHY THESE RULES EXIST
 * ─────────────────────
 * Jo builds estimates OUTSIDE the CRM: 77 estimate/quote/proposal PDFs sit in
 * leads/{id}/documents, imported from Drive (scripts/import-drive-docs-to-crm.js).
 * Those rows carry ONLY a `url` — a Firebase download-token URL, which bypasses
 * storage.rules, never expires and cannot be revoked. That URL must never reach
 * a homeowner. "Send for review" instead mints the existing tracked document
 * link (report_share_tokens kind 'lead_document', served at /report/<token> by
 * getSharedReport, which STREAMS the PDF through the function — the token is
 * the only credential, expiry and revocation are honoured on every load, and
 * every open is counted). This file decides which Storage objects may be
 * handed out that way.
 *
 * A documents row is CLIENT-writable (lead owner + company staff), so
 * storagePath / url are attacker-influenced input to a function that mints an
 * unauthenticated link. Every accepted shape is pinned to THIS lead:
 *
 *   pdf-renders/{uid}/{name}          render-pdf.js output — the caller also
 *                                     checks the object's renderedBy stamp
 *                                     (report-sharing.js provenance rule)
 *   docs/{ownerUid}/{leadId}_{name}   an upload (customer-dnd-upload.js /
 *                                     the Drive import) — ownerUid must be the
 *                                     lead's owner and the leadId prefix this lead
 *   documents/{uid}/{leadId}/{name}   a filed PDF (money-paper.js)
 *
 * and must end in .pdf (the caller also requires a PDF content type — HTML
 * must never be served from Storage, see functions/document-view.js).
 */
'use strict';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RENDER_PATH_RE = /^pdf-renders\/[A-Za-z0-9_-]{1,128}\/[^/\\]{1,240}$/;

const DAY_MS = 86400000;
const REVIEW_LINK_TTL_DAYS = 30;          // same as createReportShareToken
const DEAL_LINK_DEFAULT_DAYS = 14;        // deal-acceptance.js before 2026-10-03
const DEAL_LINK_MIN_DAYS = 1;
const DEAL_LINK_MAX_DAYS = 90;

function _str(v) { return typeof v === 'string' ? v : ''; }

/**
 * The Storage object path a documents row points at, or ''.
 * Prefers an explicit path field; otherwise decodes it out of a Firebase
 * download URL (…/v0/b/<bucket>/o/<encoded path>?alt=media&token=…) or a
 * storage.googleapis.com/<bucket>/<path> URL. The URL is only ever READ for
 * its path — the token in it is never used or returned.
 */
function storagePathFromRow(row) {
  const r = row || {};
  for (const k of ['storagePath', 'pdfPath']) {
    const v = _str(r[k]).trim();
    if (v) return v;
  }
  const url = _str(r.url).trim();
  if (!url) return '';
  let m = url.match(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?#]+)/i);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch (_) { return ''; }
  }
  m = url.match(/^https:\/\/storage\.googleapis\.com\/[^/]+\/([^?#]+)/i);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch (_) { return ''; }
  }
  return '';
}

function _safeSegments(path) {
  if (!path || path.length > 600) return null;
  if (/\\|\0|\/\.\.?\//.test(path) || path.startsWith('/') || /\/\.\.?$/.test(path)) return null;
  const segs = path.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return null;
  return segs;
}

/**
 * Classify a path for a lead. Returns { ok: true, kind } or { ok: false, reason }.
 * kind: 'render' (needs the renderedBy provenance check by the caller),
 * 'upload' or 'filed'.
 */
function classifyLeadPdfPath(path, leadId, lead) {
  const p = _str(path).trim();
  if (!p) return { ok: false, reason: 'no_path' };
  if (!ID_RE.test(_str(leadId))) return { ok: false, reason: 'bad_lead' };
  const segs = _safeSegments(p);
  if (!segs) return { ok: false, reason: 'bad_path' };
  if (!/\.pdf$/i.test(segs[segs.length - 1])) return { ok: false, reason: 'not_pdf' };
  const owner = _str((lead || {}).userId);

  if (segs[0] === 'pdf-renders') {
    return RENDER_PATH_RE.test(p) ? { ok: true, kind: 'render' } : { ok: false, reason: 'bad_path' };
  }
  if (segs[0] === 'docs' && segs.length === 3) {
    if (!owner || segs[1] !== owner) return { ok: false, reason: 'not_owner_prefix' };
    if (segs[2].indexOf(leadId + '_') !== 0 || segs[2].length <= leadId.length + 1) {
      return { ok: false, reason: 'not_this_lead' };
    }
    return { ok: true, kind: 'upload' };
  }
  if (segs[0] === 'documents' && segs.length === 4) {
    if (!ID_RE.test(segs[1])) return { ok: false, reason: 'bad_path' };
    if (segs[2] !== leadId) return { ok: false, reason: 'not_this_lead' };
    return { ok: true, kind: 'filed' };
  }
  return { ok: false, reason: 'prefix_not_shareable' };
}

/**
 * Serve-side re-check (getSharedReport): the token was written by the mint,
 * but a second read of an attacker-influenced field gets a second check.
 * Upload / filed paths must still name the TOKEN's lead.
 */
function isServableLeadDocPath(path, leadId) {
  const p = _str(path);
  if (RENDER_PATH_RE.test(p)) return true;
  const segs = _safeSegments(p);
  if (!segs || !ID_RE.test(_str(leadId))) return false;
  if (!/\.pdf$/i.test(segs[segs.length - 1])) return false;
  if (segs[0] === 'docs' && segs.length === 3) {
    return ID_RE.test(segs[1]) && segs[2].indexOf(leadId + '_') === 0 && segs[2].length > leadId.length + 1;
  }
  if (segs[0] === 'documents' && segs.length === 4) return ID_RE.test(segs[1]) && segs[2] === leadId;
  return false;
}

function isPdfContentType(ct) {
  return /^application\/pdf\b/i.test(_str(ct).trim());
}

/** Is this row a PDF the rep can send for review? (client mirrors this) */
function rowLooksLikePdf(row) {
  const r = row || {};
  if (r.deleted === true) return false;
  if (/^application\/pdf\b/i.test(_str(r.type))) return true;
  const name = _str(r.filename) || _str(r.name);
  if (/\.pdf$/i.test(name)) return true;
  return !!_str(r.pdfPath);
}

/**
 * Who may hand a lead's document out: the owner, same-company staff
 * (company_admin | manager) or a platform admin — the WRITE side of the lead
 * rules, the same rule report-sharing.js resolveLeadDocumentSubject uses.
 */
function canShareLeadDoc(claims, uid, lead) {
  const c = claims || {};
  if (!uid || !lead) return false;
  if (c.role === 'admin') return true;
  if (lead.userId === uid) return true;
  const staff = c.role === 'company_admin' || c.role === 'manager';
  return staff && !!c.companyId && !!lead.companyId && lead.companyId === c.companyId;
}

/** A live, active review token for exactly this file can be reused. */
function reusableReviewToken(tok, storagePath, nowMs) {
  if (!tok) return false;
  const active = !tok.status || tok.status === 'active';
  const exp = tok.expiresAt && typeof tok.expiresAt.toMillis === 'function' ? tok.expiresAt.toMillis() : null;
  // Reuse only with a week of life left — a link texted today must not die
  // in two days.
  const roomy = exp == null || exp - nowMs > 7 * DAY_MS;
  return active && roomy && !tok.revokedAt && tok.storagePath === storagePath;
}

/** Company setting companyProfile/{key}.salesLinks.dealLinkDays, clamped. */
function dealLinkDays(profile) {
  const raw = profile && profile.salesLinks && profile.salesLinks.dealLinkDays;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEAL_LINK_DEFAULT_DAYS;
  return Math.min(DEAL_LINK_MAX_DAYS, Math.max(DEAL_LINK_MIN_DAYS, n));
}

/**
 * integrations/sms.a2pApproved. Strictly `true` — anything else (missing doc,
 * a string, a typo) means the server's Twilio number cannot deliver, so the
 * text goes from Jo's own phone. Twilio trial: 0 of 23 delivered (2026-10-02).
 */
function smsA2pApproved(doc) {
  return !!doc && doc.a2pApproved === true;
}

/**
 * The flip revokePortalToken (portal.js) applies to a token: expiry moved into
 * the past + who/when. Every token check in the codebase tests expiry first,
 * so the old link answers "expired — ask your rep for a fresh one".
 */
function revokedTokenPatch(uid, nowMs, Timestamp, FieldValue) {
  return {
    expiresAt: Timestamp.fromMillis(nowMs - 1),
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: uid,
  };
}

/** Which deal room a "Fresh link" re-mints: newest open one on the lead. */
const DEAL_DONE = ['accepted', 'signed', 'scheduled'];
function pickOpenDeal(rooms, ownerUid) {
  const ms = (v) => {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    const t = Date.parse(v); return Number.isFinite(t) ? t : 0;
  };
  return (rooms || [])
    .filter((r) => r && r.id && !DEAL_DONE.includes(r.status) && r.deleted !== true
      && (!ownerUid || r.userId === ownerUid))
    .sort((a, b) => (ms(b.updatedAt) || ms(b.createdAt)) - (ms(a.updatedAt) || ms(a.createdAt)))[0] || null;
}

module.exports = {
  ID_RE, RENDER_PATH_RE, DAY_MS, REVIEW_LINK_TTL_DAYS, DEAL_LINK_DEFAULT_DAYS, DEAL_LINK_MAX_DAYS, DEAL_DONE,
  storagePathFromRow, classifyLeadPdfPath, isServableLeadDocPath, isPdfContentType, rowLooksLikePdf,
  canShareLeadDoc, reusableReviewToken, dealLinkDays, smsA2pApproved, revokedTokenPatch, pickOpenDeal,
};
