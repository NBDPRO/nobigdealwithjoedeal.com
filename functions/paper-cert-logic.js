/**
 * functions/paper-cert-logic.js - the check-then-record core of attestWetSigned (paper certification,
 * flag docClauseSetV1, Jo's decisions Q49 and Q63, 2026-11-18). functions/paper-cert.js is the onCall wrapper.
 *
 * A paper-signed document the rep uploads is stored with status 'wet_signed_uploaded' ("Uploaded, not
 * certified"). It counts as the signed document only after this call: the SERVER writes the attestation
 * (who, when, the sentence), the signing date, the digest of the linked original, and moves the row to
 * 'signed'. A contract is then filed through the same job-spine adapter the other signing paths use
 * (contractFiledAt + contract_signed). Firestore rules keep every field written here server-owned.
 *
 * NO npm packages here: the database and every effect are injected (the same shape as in-person-signing-logic.js).
 */
'use strict';

const crypto = require('crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WET_STATUS = 'wet_signed_uploaded';
// The kinds of paper document a rep can certify. 'other' is certified but files nothing.
const PAPER_DOC_TYPES = ['contract', 'proposal', 'work_authorization', 'change_order', 'certificate_of_completion', 'other'];
const READ_CAP_BYTES = 16 * 1024 * 1024;
// DRAFTER WORDING: attorney to confirm. Neutral, no claim-handling or legal-effect language.
const ATTEST_TEXT = 'I confirm that the uploaded paper document carries the homeowner’s handwritten signature, and that it was signed on the date shown.';

class RefusalError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Who may certify: exactly who the Firestore rules let write the document row (security review 2026-11-18, MED4): the lead's
 * owner, or a company_admin or manager of the lead's company. A sales rep on a teammate's lead, a viewer, and anyone of another
 * company are refused.
 */
function canCertify(lead, uid, token) {
  if (!lead || !uid) return false;
  if (lead.userId && lead.userId === uid) return true;
  const role = token && typeof token.role === 'string' ? token.role : '';
  const co = token && typeof token.companyId === 'string' ? token.companyId : '';
  return (role === 'company_admin' || role === 'manager') && !!co && !!lead.companyId && lead.companyId === co;
}
const sameCompany = canCertify;

// The lead's "filed" field per document type: the one table the other signing paths use.
function filedFieldFor(docType) {
  try { return require('./job-spine-logic').FILED_FIELD_BY_DOC_TYPE[docType] || null; } catch (_) { return null; }
}

/** docs/<uid>/<leadId>/<file>: the shape the paper upload writes, confined to THIS lead. */
function uploadPathOk(p, leadId) {
  if (typeof p !== 'string' || p.length > 400 || p.indexOf('..') !== -1) return false;
  const parts = p.split('/');
  return parts.length === 4 && parts[0] === 'docs' && parts[1] !== '' && parts[2] === leadId && parts[3] !== '';
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * auth = { uid, token }. data = { leadId, docId, witnessName? }.
 * deps = { flagOn(), readBytes(path, max), toTimestamp(ms), now(), facts:{ip,ipSource,ua}, fileSigned(db, info) }
 * Returns { ok, already?, filedField? }. Throws RefusalError(code, message).
 */
async function attestWetSigned(db, auth, data, deps) {
  const uid = auth && auth.uid;
  if (!uid) throw new RefusalError('unauthenticated', 'Sign in required');
  const token = (auth && auth.token) || {};
  const d = data || {};
  const leadId = typeof d.leadId === 'string' ? d.leadId.trim() : '';
  const docId = typeof d.docId === 'string' ? d.docId.trim() : '';
  if (!ID_RE.test(leadId) || !ID_RE.test(docId)) throw new RefusalError('invalid-argument', 'leadId and docId required');
  const dp = deps || {};
  const now = typeof dp.now === 'function' ? dp.now() : Date.now();

  if (!(typeof dp.flagOn === 'function' && await dp.flagOn())) {
    throw new RefusalError('failed-precondition', 'Paper certification is not turned on for you.');
  }

  const leadSnap = await db.doc('leads/' + leadId).get();
  if (!leadSnap.exists) throw new RefusalError('not-found', 'Lead not found');
  const lead = leadSnap.data() || {};
  if (lead.deleted === true) throw new RefusalError('not-found', 'Lead not found');
  if (!canCertify(lead, uid, token)) throw new RefusalError('permission-denied', 'Only the lead\'s owner, a manager or a company admin can certify a paper copy.');

  const ref = db.doc('leads/' + leadId + '/documents/' + docId);
  const snap = await ref.get();
  if (!snap.exists) throw new RefusalError('not-found', 'Document not found');
  const row = snap.data() || {};
  if (row.deleted === true) throw new RefusalError('not-found', 'Document not found');
  if (row.source !== 'signed_upload') throw new RefusalError('failed-precondition', 'This is not an uploaded paper copy.');
  if (row.status === 'signed' && row.wetSignedAttestation) {
    // Replay (LOW5): the certification is saved, but filing is best-effort and can be lost to a transient failure. If the lead's
    // "filed" field is still unset, file again (idempotent: the spine counts the same source id once).
    const at = (row.wetSignedEvidence && row.wetSignedEvidence.docType) || row.wetSignedDocType;
    const field = filedFieldFor(at);
    let filedField = null;
    if (field && !lead[field] && typeof dp.fileSigned === 'function') {
      try {
        const oid = (row.wetSignedEvidence && row.wetSignedEvidence.originalDocId) || null;
        const f = await dp.fileSigned(db, { leadId, docId, sourceDocId: oid || docId, docType: at, signerName: lead.firstName ? String(lead.firstName) + (lead.lastName ? ' ' + lead.lastName : '') : '' });
        filedField = (f && f.filedField) || null;
      } catch (_) { filedField = null; }
    }
    return { ok: true, already: true, filedField };
  }
  if (row.status !== WET_STATUS) throw new RefusalError('failed-precondition', 'This upload is not waiting for certification.');

  const docType = String(row.wetSignedDocType || '');
  if (PAPER_DOC_TYPES.indexOf(docType) === -1) throw new RefusalError('failed-precondition', 'Choose what kind of document this is before certifying it.');
  const on = String(row.wetSignedOn || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on);
  const signedMs = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0) : NaN;
  if (!m || !Number.isFinite(signedMs) || new Date(signedMs).toISOString().slice(0, 10) !== on) {
    throw new RefusalError('failed-precondition', 'Enter the date the homeowner signed.');
  }
  if (signedMs > now + 36 * 3600 * 1000) throw new RefusalError('failed-precondition', 'The signing date cannot be in the future.');

  // The uploaded file must really exist, under THIS lead (MED3). Its path, size, content type and Storage hash are recorded, so the
  // attestation says which bytes were certified. An empty row, a path under another lead, a missing or zero-byte object is refused.
  if (!uploadPathOk(row.storagePath, leadId)) throw new RefusalError('failed-precondition', 'This upload has no file on record. Upload the signed copy again, then certify it.');
  if (typeof dp.statFile !== 'function') throw new RefusalError('unavailable', 'Could not check the uploaded file just now. Try again in a moment.');
  let stat = null;
  try { stat = await dp.statFile(row.storagePath); } catch (_) { throw new RefusalError('unavailable', 'Could not check the uploaded file just now. Try again in a moment.'); }
  if (!stat || !(Number(stat.size) > 0)) throw new RefusalError('failed-precondition', 'The uploaded file is missing or empty. Upload the signed copy again, then certify it.');

  // The link to the original generated document, and its digest (the same SHA-256 of the stored document the signing paths use).
  // The original must be a live generated document of THIS lead (the same tenant by construction) of the same type.
  const originalDocId = typeof row.originalDocId === 'string' && ID_RE.test(row.originalDocId) ? row.originalDocId : null;
  let originalSha256 = null; let originalDigestStatus = 'no_original';
  if (originalDocId) {
    const os = await db.doc('leads/' + leadId + '/documents/' + originalDocId).get();
    if (!os.exists) throw new RefusalError('failed-precondition', 'The linked original document was not found.');
    const orig = os.data() || {};
    if (orig.deleted === true) throw new RefusalError('failed-precondition', 'The linked original document was deleted.');
    if (orig.source === 'signed_upload') throw new RefusalError('failed-precondition', 'The linked original is itself an upload, not a generated document.');
    if (String(orig.type || '') !== docType) throw new RefusalError('failed-precondition', 'The linked original is a different kind of document.');
    originalDigestStatus = 'unreadable';
    const p = typeof orig.htmlPath === 'string' ? orig.htmlPath : '';
    if (p && typeof dp.readBytes === 'function') {
      try { const buf = await dp.readBytes(p, READ_CAP_BYTES); if (buf) { originalSha256 = sha256Hex(buf); originalDigestStatus = 'ok'; } } catch (_) { originalSha256 = null; }
    }
  }

  const witness = str(d.witnessName, 80) || str(row.witnessName, 80) || null;
  const name = str(token.name, 120) || str(token.email, 120) || ('user ' + String(uid).slice(0, 8));
  const facts = dp.facts || {};
  const attestation = { byUid: uid, name, at: now, text: ATTEST_TEXT };
  const evidence = {
    docType, signedOn: on, witnessName: witness, originalDocId, originalSha256,
    originalShortDigest: originalSha256 ? originalSha256.slice(0, 12) : null, originalDigestStatus,
    uploadPath: row.storagePath, uploadSize: Number(stat.size), uploadContentType: typeof stat.contentType === 'string' ? stat.contentType.slice(0, 100) : null,
    uploadMd5: typeof stat.md5Hash === 'string' ? stat.md5Hash.slice(0, 64) : null,
    ip: facts.ip || null, ipSource: facts.ipSource || null, ua: facts.ua || null,
  };
  const signedAt = typeof dp.toTimestamp === 'function' ? dp.toTimestamp(signedMs) : new Date(signedMs);

  // The transition is transactional: only a row still waiting, with no attestation, is moved.
  const moved = await db.runTransaction(async (t) => {
    const cur = await t.get(ref);
    const c = cur && cur.exists ? (cur.data() || {}) : null;
    if (!c || c.status !== WET_STATUS || c.wetSignedAttestation) return false;
    t.set(ref, { status: 'signed', signedAt, wetSignedAttestation: attestation, wetSignedEvidence: evidence }, { merge: true });
    return true;
  });
  if (!moved) return { ok: true, already: true };

  // Filing: the same adapter the other signing paths use. Best-effort: the certification is already saved.
  let filed = null;
  if (typeof dp.fileSigned === 'function') {
    try {
      filed = await dp.fileSigned(db, { leadId, docId, sourceDocId: originalDocId || docId, docType, signerName: lead.firstName ? String(lead.firstName) + (lead.lastName ? ' ' + lead.lastName : '') : '' });
    } catch (_) { filed = null; }
  }
  return { ok: true, filedField: (filed && filed.filedField) || null };
}

module.exports = { attestWetSigned, canCertify, sameCompany, filedFieldFor, uploadPathOk, RefusalError, WET_STATUS, PAPER_DOC_TYPES, ATTEST_TEXT, ID_RE };
