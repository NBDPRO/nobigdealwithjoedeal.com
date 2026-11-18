/**
 * functions/in-person-signing-logic.js — the check-then-record core of
 * recordInPersonSignature (functions/in-person-signing.js is the onCall
 * wrapper). See that file for the why.
 *
 * NO npm packages here, on purpose: the database, FieldValue and logger are
 * injected (job-spine.js / deposit-draft.js take them as deps too). The
 * authed E2E job loads this module in the Playwright process to answer the
 * callable against the Firestore emulator, and that job does not install
 * functions/node_modules — a require of firebase-functions here made the
 * E2E's server answer throw, so the card never moved (2026-10-04).
 * tests/review-paid-in-full-2026-10-03.test.js loads it with every package
 * require refused.
 */
'use strict';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// The most bytes of a stored document the gap check will read (review 2, item 5). The callable passes
// it to readBytes, which refuses to download an object over it.
const READ_CAP_BYTES = 16 * 1024 * 1024;

class RefusalError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Is this lead the caller's company's? Owner, or the same companyId claim. */
function sameCompany(lead, uid, token) {
  if (!lead || !uid) return false;
  if (lead.userId && lead.userId === uid) return true;
  const co = token && typeof token.companyId === 'string' ? token.companyId : '';
  if (co && lead.companyId && lead.companyId === co) return true;
  // A solo operator's leads carry companyId === their uid.
  if (!co && lead.companyId && lead.companyId === uid) return true;
  return false;
}

/**
 * Is this document really signed? Read from Firestore, never from the call.
 * → null when signed, else the reason it is not.
 */
function notSignedReason(docMeta) {
  const d = docMeta || {};
  if (String(d.status || '') !== 'signed') return 'not_signed';
  if (!d.signedAt) return 'no_signed_at';
  const signed = Array.isArray(d.signedSigners) ? d.signedSigners.filter((s) => s && s.role) : [];
  if (!signed.length) return 'no_signers';
  const have = new Set(signed.map((s) => String(s.role)));
  const required = Array.isArray(d.signers) ? d.signers.filter((s) => s && s.role && s.required) : [];
  for (const s of required) if (!have.has(String(s.role))) return 'missing_required_signer';
  return null;
}

/** The same shape firestore.rules enforces on a client write of htmlPath. */
function htmlPathOk(htmlPath, leadId) {
  const parts = String(htmlPath || '').split('/');
  return parts.length === 4 && parts[0] === 'documents' && parts[2] === leadId && /^[A-Za-z0-9._-]+.html$/.test(parts[3]);
}

/**
 * The pre-send gap check, run SERVER-side on the in-person path too (review 2026-11-18, finding 2):
 * price (the lead's primary estimate), property address, homeowner name, company mailing address,
 * legal entity name and any [Placeholder] left in the stored document. Returns the gap list, or
 * throws a RefusalError('unavailable') when the document cannot be read (fail closed, retryable).
 * Only for a contract-class document; others return [].
 */
async function contractGapsFor(db, ctx, evidence) {
  const DE = require('./doc-evidence');
  const { leadId, lead, docMeta } = ctx;
  if (!DE.isContractClass(docMeta.type)) return [];
  const htmlPath = typeof docMeta.htmlPath === 'string' ? docMeta.htmlPath : '';
  let html = '';
  if (evidence.readBytes && htmlPathOk(htmlPath, leadId)) {
    // The read is capped (review 2, item 5): the signed copy carries its signature images inline, so it can
    // be large, but never unbounded. Over the cap = the same plain "too large" gap as the 2 MB text bound.
    const tooBig = [{ code: 'tooLarge', message: 'The document is too large to check. Shorten it or remove embedded images, then try again.' }];
    let buf = null;
    try { buf = await evidence.readBytes(htmlPath, READ_CAP_BYTES); }
    catch (e) {
      if (e && e.code === 'too_large') return tooBig;
      throw new RefusalError('unavailable', 'Could not read the document to check it. Try again in a moment.');
    }
    if (buf && buf.length > READ_CAP_BYTES) return tooBig;
    html = buf ? Buffer.from(buf).toString('utf8') : '';
  } else {
    throw new RefusalError('unavailable', 'Could not read the document to check it. Try again in a moment.');
  }
  let profile = {};
  const tenantKey = lead.companyId || lead.userId;
  try {
    const cp = tenantKey ? await db.doc('companyProfile/' + tenantKey).get() : null;
    if (cp && cp.exists) profile = cp.data() || {};
  } catch (_) { profile = {}; }
  let priceCents = null;
  try {
    const pid = typeof lead.primaryEstimateId === 'string' && ID_RE.test(lead.primaryEstimateId) ? lead.primaryEstimateId : '';
    const es = pid ? await db.doc('estimates/' + pid).get() : null;
    if (es && es.exists) priceCents = DE.estimateCents(es.data());
  } catch (_) { priceCents = null; }
  return DE.serverContractGaps({ type: docMeta.type, html, lead, profile, tenantKey, KyLaw: require('./ky-insurance-law'), priceCents });
}

/**
 * Write signatureEvidence on the signed document, once. Write-once: a second call (a retry,
 * or a rep calling again) never replaces the first record, and a document the remote link
 * already signed keeps the evidence that path wrote. Best-effort: a failure here is logged
 * by the caller's catch-all and never blocks the signing, which is already saved.
 * evidence = { enabled, ip, ua, readBytes(path) -> Buffer | null }
 */
async function recordEvidence(db, ctx, evidence) {
  const { leadId, docId, lead, docMeta, uid, data } = ctx;
  // Fast path only: the transaction below is the authority. signedRemotely is NOT consulted: it is a
  // client-writable field, so a rep could set it to skip the record (review 2026-11-18, finding 4).
  if (docMeta.signatureEvidence) return null;
  const DE = require('./doc-evidence');
  const htmlPath = typeof docMeta.htmlPath === 'string' ? docMeta.htmlPath : '';
  let signedSha256 = null;
  let signedHtml = null;
  // The same shape firestore.rules enforces on a client write of htmlPath.
  if (evidence.readBytes && htmlPath.split('/').length === 4 && htmlPath.split('/')[0] === 'documents'
      && htmlPath.split('/')[2] === leadId && /^[A-Za-z0-9._-]+\.html$/.test(htmlPath.split('/')[3])) {
    try { const buf = await evidence.readBytes(htmlPath, READ_CAP_BYTES); if (buf) { signedSha256 = DE.sha256Hex(buf); signedHtml = buf.toString('utf8'); } } catch (_) { signedSha256 = null; }
  }
  const stamp = DE.stampFor(require('./ky-insurance-law'), lead, {}, { html: signedHtml });
  // Time is the SERVER's clock at this call. The row's signedAt is written by the rep's own browser,
  // so it is kept only as a client-reported value (review 2026-11-18, finding 3).
  const clientSignedAt = docMeta.signedAt && typeof docMeta.signedAt.toMillis === 'function' ? docMeta.signedAt.toMillis() : null;
  const record = DE.buildEvidence({
    path: 'in_person', clauseSetVersion: stamp.clauseSetVersion, clauseIds: stamp.clauseIds,
    // The bytes read here are the signed copy the rep's device saved over the original: they are NOT
    // "the document the homeowner was shown", so documentSha256 stays null on this path.
    documentSha256: null, signedSha256,
    // No consent step on the rep's phone today (phase 2): recorded as "not asked", never as agreed.
    consent: { agreed: null },
    signedAtMs: Date.now(), ip: evidence.ip, ipSource: evidence.ipSource, ua: evidence.ua, recordedByUid: uid,
  });
  record.signedCopySha256 = signedSha256;
  record.signedAtClientReported = clientSignedAt;
  // What this record proves: the rep's signed-in device made the call, at this server time, from this
  // address. It does not prove that a homeowner signed, or that the homeowner saw this document.
  record.attests = 'rep_device_and_time_only';
  // The pre-signing digest is the CLIENT's own report (the unsigned original is overwritten in
  // place by the signed copy); the server's digest above is the authority.
  record.presentedSha256ClientReported = /^[a-f0-9]{64}$/.test(String(data.presentedSha256 || '')) ? data.presentedSha256 : null;
  // Write-once, transactionally (finding 4): the write happens only if signatureEvidence is still
  // absent when the transaction reads the row, so two concurrent calls cannot both write.
  const ref = db.doc('leads/' + leadId + '/documents/' + docId);
  const wrote = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const cur = snap && snap.exists ? (snap.data() || {}) : null;
    if (!cur || cur.signatureEvidence) return false;
    // A refusal earlier on this row (evidenceRefused) is cleared once the evidence is actually written.
    t.set(ref, cur.evidenceRefused ? { signatureEvidence: record, evidenceRefused: null } : { signatureEvidence: record }, { merge: true });
    return true;
  });
  return wrote ? record : null;
}

/**
 * The whole check-then-record, with the database injected (testable with a
 * fake Firestore; the E2E drives it against the emulator).
 * auth = { uid, token }. Throws RefusalError(code, message) to refuse.
 */
async function handleInPersonSignature(db, auth, data, deps) {
  const uid = auth && auth.uid;
  if (!uid) throw new RefusalError('unauthenticated', 'Sign in required');
  const token = (auth && auth.token) || {};
  const d = data || {};
  const leadId = typeof d.leadId === 'string' ? d.leadId.trim() : '';
  const docId = typeof d.docId === 'string' ? d.docId.trim() : '';
  if (!ID_RE.test(leadId) || !ID_RE.test(docId)) throw new RefusalError('invalid-argument', 'leadId and docId required');

  const leadSnap = await db.doc('leads/' + leadId).get();
  if (!leadSnap.exists) throw new RefusalError('not-found', 'Lead not found');
  const lead = leadSnap.data() || {};
  if (lead.deleted === true) throw new RefusalError('not-found', 'Lead not found');
  if (!sameCompany(lead, uid, token)) throw new RefusalError('permission-denied', 'Not your company\'s lead');

  const docSnap = await db.doc('leads/' + leadId + '/documents/' + docId).get();
  if (!docSnap.exists) throw new RefusalError('not-found', 'Document not found');
  const docMeta = docSnap.data() || {};
  const why = notSignedReason(docMeta);
  if (why) throw new RefusalError('failed-precondition', 'This document is not signed (' + why + ')');
  // Evidence parity (2026-11-18, flag docEvidenceFoundation): the signing evidence is written
  // HERE, by the admin SDK, from this request — a client cannot attest its own IP or digest.
  const evidence = deps && deps.evidence;
  if (evidence && evidence.enabled === true) {
    // Flag on: the same gap check as every other send path. Unlike the evidence write below, this DOES
    // refuse: a contract with a blank price or a [Placeholder] does not advance the pipeline as signed.
    const gaps = await contractGapsFor(db, { leadId, lead, docMeta }, evidence);
    if (gaps.length) {
      // Review 2 (2026-11-18), item 4: the rep's browser already wrote this row as "signed" before this call, so a
      // bare refusal would leave a signed row with no evidence and no trace of why. The server marks it
      // (evidenceRefused is server-owned in firestore.rules), best-effort: the refusal itself always reaches the rep.
      try {
        await db.doc('leads/' + leadId + '/documents/' + docId).set({
          evidenceRefused: { reasons: gaps.map((g) => ({ code: g.code, message: g.message })), at: Date.now() },
        }, { merge: true });
      } catch (_) { /* the refusal below is the primary signal */ }
      throw new RefusalError('failed-precondition', require('./doc-evidence').describeGaps(gaps));
    }
    // The evidence write never blocks the card move below: the contract is saved either way.
    try { await recordEvidence(db, { leadId, docId, lead, docMeta, uid, data: d }, evidence); }
    catch (e) { if (typeof evidence.onError === 'function') evidence.onError(e); }
  }
  if (String(docMeta.type || '') !== 'contract') return { ok: true, skipped: 'not_a_contract' };

  const recordJobEvent = (deps && deps.recordJobEvent) || require('./job-spine').recordJobEvent;
  const r = await recordJobEvent(db, {
    leadId, companyId: lead.companyId || null,
    event: 'contract_signed', sourceId: 'doc_' + docId,
    actor: 'in-person signing',
    meta: { docId, detail: 'signed in person' },
  }, deps) || {};
  return {
    ok: true,
    moved: !!r.moved,
    duplicate: !!r.duplicate,
    reason: r.reason || null,
    to: r.to || null,
    depositDraft: r.depositDraft ? { created: !!r.depositDraft.created, reason: r.depositDraft.reason || null } : null,
  };
}

module.exports = { handleInPersonSignature, recordEvidence, notSignedReason, sameCompany, RefusalError, ID_RE };
