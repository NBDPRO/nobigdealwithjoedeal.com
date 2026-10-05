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

module.exports = { handleInPersonSignature, notSignedReason, sameCompany, RefusalError, ID_RE };
