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

const AA = require('./attic-ack');
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
  // The marker in the stored copy is a hint only: the refs are recomputed, and the clause flag must have been on (item 4).
  const stamp = DE.stampFor(require('./ky-insurance-law'), lead, {}, { html: signedHtml, v1: evidence.clauseFlag === true });
  // Time is the SERVER's clock at this call. The row's signedAt is written by the rep's own browser,
  // so it is kept only as a client-reported value (review 2026-11-18, finding 3).
  const clientSignedAt = docMeta.signedAt && typeof docMeta.signedAt.toMillis === 'function' ? docMeta.signedAt.toMillis() : null;
  const record = DE.buildEvidence({
    path: 'in_person', clauseSetVersion: stamp.clauseSetVersion, clauseIds: stamp.clauseIds, clauseRefsMismatch: stamp.clauseRefsMismatch === true,
    // The bytes read here are the signed copy the rep's device saved over the original: they are NOT
    // "the document the homeowner was shown", so documentSha256 stays null on this path.
    documentSha256: null, signedSha256,
    // No consent step on the rep's phone today (phase 2): recorded as "not asked", never as agreed.
    consent: { agreed: null },
    signedAtMs: Date.now(), ip: evidence.ip, ipSource: evidence.ipSource, ua: evidence.ua, recordedByUid: uid,
  });
  // Phase 3: the ticks a signed attic form carries, read from the stored signed copy (never from the call).
  if (signedHtml && AA.DOC_TYPES.indexOf(String(docMeta.type || '')) !== -1) record.acknowledgments = AA.evidenceAcks(AA.parseAcks(signedHtml));
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
  // Phase 3 (flag docAtticAckV1, deps.attic): a signed attic form is read back and its server-owned result written;
  // a contract-class document is refused when a re-roof has no signed attic form. Like the gap check above, the
  // rep's browser already wrote the row as signed, so a refusal marks it (evidenceRefused is server-owned).
  const attic = deps && deps.attic;
  // The flag is read here, after the lead is loaded (the acting user's OR the tenant owner's; a failed read throws a retryable refusal).
  // Review 3 (item 5): flagOn may answer { on, unverified }: unverified means the flag could not be read (read as not on, so flag-off signing is
  // unchanged), and for a document the gate would apply to that is recorded for audit, below, instead of passing silently.
  let atticOn = false; let atticUnverified = false;
  if (attic && attic.on === true) atticOn = true;
  else if (attic && typeof attic.flagOn === 'function') {
    const st = await attic.flagOn(lead);
    atticOn = st === true || !!(st && st.on === true);
    atticUnverified = !!(st && st.unverified === true) && !atticOn;
  }
  if (atticUnverified) {
    const AGu = require('./attic-gate');
    if (AGu.gated(docMeta.type) || AGu.isAtticDoc(docMeta.type)) {
      // Server-written (rules-guarded like evidenceRefused) so the owner can audit the signing the gate could not check; best-effort, and the
      // activity row is the second channel. The signing itself is recorded as before.
      try { await db.doc('leads/' + leadId + '/documents/' + docId).set({ atticGateUnverified: { at: Date.now(), reason: 'attic_flag_unreadable', docType: String(docMeta.type || '') } }, { merge: true }); } catch (_) { /* the activity row below is the other channel */ }
      try {
        await db.collection('leads/' + leadId + '/activity').add({
          userId: String(lead.userId || uid || ''), type: 'attic_gate_unverified', label: 'Signed in person, attic check not run',
          message: 'The attic acknowledgment setting could not be read when this document was signed in person, so the attic check did not run. Open the customer and confirm a signed attic form exists for the estimate.',
          docId, createdAt: new Date(),
        });
      } catch (_) { /* best-effort */ }
    }
  }
  // Phase 5 forms (flag docClauseSetV1; such a document exists only under it): the stored signed copy is read back and verified against
  // the server's spec for the type, and its result is written (server-owned field). An incomplete copy is refused and marked.
  // Security review 2026-11-19: with the flag on and no way to read the stored copy, the form is refused (fail closed); with the flag off nothing changes.
  const isP5 = require('./p5-forms').isP5Doc(docMeta.type);
  let p5FlagOn = false;
  if (isP5 && !(attic && typeof attic.readBytes === 'function')) {
    const DE5 = require('./doc-evidence');
    try {
      const co5 = typeof lead.companyId === 'string' ? lead.companyId : '';
      const fo = { strict: true, flag: DE5.CLAUSE_FLAG_NAME };
      p5FlagOn = (await DE5.flagForUid(db, uid, fo)) === true || (!!co5 && co5 !== String(uid || '') && (await DE5.flagForUid(db, co5, fo)) === true);
    } catch (_) { p5FlagOn = true; }   // the form is already a phase 5 form and cannot be read back: an unreadable flag fails closed
    if (p5FlagOn) {
      const msg = 'Could not read the signed form to check it. Try again in a moment.';
      try { await db.doc('leads/' + leadId + '/documents/' + docId).set({ evidenceRefused: { reasons: [{ code: 'p5Form', message: msg }], at: Date.now() } }, { merge: true }); } catch (_) { /* the refusal is the signal */ }
      throw new RefusalError('failed-precondition', msg);
    }
  }
  if (attic && typeof attic.readBytes === 'function' && isP5) {
    const AG5 = require('./attic-gate');
    const refuse5 = async (message) => {
      try { await db.doc('leads/' + leadId + '/documents/' + docId).set({ evidenceRefused: { reasons: [{ code: 'p5Form', message }], at: Date.now() } }, { merge: true }); } catch (_) { /* the refusal is the signal */ }
      throw new RefusalError('failed-precondition', message);
    };
    const htmlPath5 = typeof docMeta.htmlPath === 'string' ? docMeta.htmlPath : '';
    let buf5 = null;
    try { buf5 = htmlPathOk(htmlPath5, leadId) ? await attic.readBytes(htmlPath5, READ_CAP_BYTES) : null; } catch (_) { buf5 = null; }
    if (!buf5) throw new RefusalError('unavailable', 'Could not read the signed form. Try again in a moment.');
    const stored5 = Buffer.from(buf5).toString('utf8');
    if (stored5.length > AG5.MAX_HTML) await refuse5(AG5.TOO_LARGE_MSG);
    // The figures and the state are re-derived from the company's own terms and the lead, not taken from the stored copy.
    let prof5 = {};
    const tk5 = lead.companyId || lead.userId;
    try { const cp5 = tk5 ? await db.doc('companyProfile/' + tk5).get() : null; prof5 = cp5 && cp5.exists ? (cp5.data() || {}) : {}; }
    catch (_) { throw new RefusalError('unavailable', 'Could not check the form just now. Try again in a moment.'); }
    const chk5 = AG5.p5Check(docMeta.type, stored5, { profile: prof5, tenantKey: tk5, isNbd: require('./doc-evidence').isNbdTenant(tk5), lead, KyLaw: require('./ky-insurance-law') });
    if (!chk5.ok) await refuse5(chk5.reasons.indexOf('not_ohio') !== -1 ? 'This acknowledgment is for Ohio properties only.' : 'The figures on this form do not match the company\'s terms.');
    const res5 = AG5.resultFor(docMeta.type, stored5, Date.now(), chk5.derived);
    if (!res5.complete) await refuse5('Every box on this form must be ticked before it counts as signed.');
    res5.attests = 'rep_device_and_time_only';
    await db.doc('leads/' + leadId + '/documents/' + docId).set({ atticAckResult: res5 }, { merge: true });
  }
  if (attic && atticOn) {
    const AG = require('./attic-gate');
    const refuse = async (message) => {
      try { await db.doc('leads/' + leadId + '/documents/' + docId).set({ evidenceRefused: { reasons: [{ code: 'atticAck', message }], at: Date.now() } }, { merge: true }); } catch (_) { /* the refusal is the signal */ }
      throw new RefusalError('failed-precondition', message);
    };
    if (AG.isAtticDoc(docMeta.type)) {
      const htmlPath = typeof docMeta.htmlPath === 'string' ? docMeta.htmlPath : '';
      let buf = null;
      try { buf = htmlPathOk(htmlPath, leadId) && attic.readBytes ? await attic.readBytes(htmlPath, READ_CAP_BYTES) : null; } catch (_) { buf = null; }
      if (!buf) throw new RefusalError('unavailable', 'Could not read the signed attic form. Try again in a moment.');
      const storedHtml = Buffer.from(buf).toString('utf8');
      const result = AG.resultFor(docMeta.type, storedHtml, Date.now());
      if (storedHtml.length > AG.MAX_HTML) await refuse(AG.TOO_LARGE_MSG);
      if (!result.complete) await refuse('Every box on the attic form must be ticked and every line answered Yes or No before it counts as signed.');
      // What this proves (review 2026-11-18): the rep's signed-in device made the call, at this server time, over a copy of the form that
      // matches the server's manifest. It does not prove the homeowner ticked or signed it (the same limit as the evidence record's attests).
      result.attests = 'rep_device_and_time_only';
      // Review 2 (item 4): the form covers the estimate it was signed against (id and stamp), the same binding an override has.
      let fb;
      try { fb = await AG.formBasis(db, leadId, lead, { estimateId: docMeta.estimateId }); } catch (e) { if (e && e.code === 'estimate_not_on_lead') await refuse(AG.NOT_ON_LEAD_MSG); if (e && e.code === 'too_many_estimates') await refuse(AG.TOO_MANY_MSG); throw new RefusalError('unavailable', 'Could not check the attic acknowledgment just now. Try again in a moment.'); }
      result.estimateId = fb.id; result.estimateStamp = fb.stamp;
      await db.doc('leads/' + leadId + '/documents/' + docId).set({ atticAckResult: result }, { merge: true });
    } else if (AG.gated(docMeta.type)) {
      let dec;
      try { dec = await AG.decide(db, leadId, lead, { estimateId: docMeta.estimateId }); } catch (_) { throw new RefusalError('unavailable', 'Could not check the attic acknowledgment just now. Try again in a moment.'); }
      if (!dec.satisfied) await refuse(dec.message);
    }
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
