/**
 * functions/attic-gate.js - the server side of the Attic, Ventilation & Moisture Acknowledgment (phase 3, flag
 * docAtticAckV1, default OFF). See documentation/projects/ATTIC-ACK-V1-2026-11-18.md.
 *
 *   applyAcks      the remote-signing record: the ORIGINAL document with each tick control's state taken from the
 *                  submission (only the controls the original has; nothing else from the submission is kept)
 *   resultFor      what a signed attic form says: { version, notInspected, declined, acknowledgments, formDate }
 *   decide         the send/sign gate for a contract-class document: the lead's scope, whether a signed form with a
 *                  server-written result exists, whether an owner/admin override was recorded
 *   recordOverride the owner/admin "proceed anyway" event (Q18), server-written only
 *
 * db is injected (no npm packages) so the unit tests run against a fake. Pure logic is attic-ack.js.
 */
'use strict';

const AA = require('./attic-ack');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OVERRIDES = 'attic_overrides';
const CONTRACT_CLASS = ['contract', 'proposal', 'work_authorization', 'estimate_esign'];

/** Is this a document type the gate applies to? */
function gated(type) { return CONTRACT_CLASS.indexOf(String(type || '')) !== -1; }
function isAtticDoc(type) { return AA.DOC_TYPES.indexOf(String(type || '')) !== -1; }

/**
 * The executed record for a document that carries tick controls: the original's markup, with `checked` and
 * `disabled` written onto each control from the submission's state. Returns { html, acks, complete }.
 * A control the submission added (an id the original does not have) is ignored.
 */
function applyAcks(originalHtml, signedHtml) {
  const orig = String(originalHtml == null ? '' : originalHtml);
  const sub = {};
  AA.parseAcks(signedHtml).forEach((a) => { sub[a.id] = a.checked === true; });
  const html = orig.replace(/<input\b[^>]*>/gi, (tag) => {
    const m = /\bdata-nbd-ack\s*=\s*"([^"]{1,80})"/i.exec(tag);
    if (!m) return tag;
    const bare = tag.replace(/\s(checked|disabled)(\s*=\s*"[^"]*")?(?=[\s\/>])/gi, '');
    return bare.replace(/\s*(\/?)>$/, (_m, slash) => (sub[m[1]] === true ? ' checked=""' : '') + ' disabled=""' + (slash ? ' />' : '>'));
  });
  const acks = AA.parseAcks(html);
  return { html, acks, complete: acks.length > 0 && AA.acksComplete(acks).ok };
}

/** What a signed attic form records, from the stored signed copy. */
function resultFor(docType, signedHtml, formDateMs) {
  const acks = AA.parseAcks(signedHtml);
  return {
    version: AA.VERSION,
    notInspected: String(docType) === 'attic_not_inspected',
    declined: AA.declinedAny(acks),
    complete: acks.length > 0 && AA.acksComplete(acks).ok,
    acknowledgments: AA.evidenceAcks(acks),
    formDateMs: Number.isFinite(Number(formDateMs)) ? Number(formDateMs) : null,
  };
}

async function _estimateFor(db, lead) {
  const pid = lead && typeof lead.primaryEstimateId === 'string' && ID_RE.test(lead.primaryEstimateId) ? lead.primaryEstimateId : '';
  if (!pid) return null;
  const s = await db.doc('estimates/' + pid).get();
  return s && s.exists ? (s.data() || {}) : null;
}

/**
 * The gate for a contract-class document on this lead. A read that fails THROWS (the caller fails closed; a
 * missing attic form is never assumed). -> { scope, required, satisfied, how, message, warn }
 */
async function decide(db, leadId, lead) {
  const est = await _estimateFor(db, lead);
  const scope = AA.effectiveScope(lead, est);
  const g0 = AA.gate({ scope, signedForm: false, override: false });
  if (!g0.required) return Object.assign({ scope }, g0);
  const found = [];
  for (const t of AA.DOC_TYPES) {
    const snap = await db.collection('leads/' + leadId + '/documents').where('type', '==', t).get();
    snap.docs.forEach((d) => found.push(d));
  }
  const docs = { docs: found };
  // A form counts only with the server-written result (atticAckResult, server-owned in firestore.rules): the row's
  // own status and signedAt are written by the rep's browser on the in-person path.
  const signedForm = docs.docs.some((d) => {
    const r = d.data() || {};
    return AA.isSignedForm(r) && r.atticAckResult && r.atticAckResult.version === AA.VERSION && r.atticAckResult.complete === true;
  });
  let override = false;
  if (!signedForm) {
    const ov = await db.collection(OVERRIDES).where('leadId', '==', leadId).limit(1).get();
    override = !ov.empty;
  }
  return Object.assign({ scope }, AA.gate({ scope, signedForm, override }));
}

/**
 * Q18: only an owner or admin may record "proceed anyway", with a required reason, as a server-written event
 * (name, uid, time, reason). auth = { uid, token }. Throws { code, message } objects via the thrower (so this
 * module needs no firebase-functions import).
 */
async function recordOverride(db, auth, data, fail) {
  const uid = auth && auth.uid;
  if (!uid) throw fail('unauthenticated', 'Sign in required');
  const token = (auth && auth.token) || {};
  const leadId = data && typeof data.leadId === 'string' ? data.leadId.trim() : '';
  const reason = data && typeof data.reason === 'string' ? data.reason.trim() : '';
  if (!ID_RE.test(leadId)) throw fail('invalid-argument', 'leadId required');
  if (reason.length < 10 || reason.length > 500) throw fail('invalid-argument', 'Give the reason the job proceeds without a signed attic page (at least 10 characters).');
  const ls = await db.doc('leads/' + leadId).get();
  if (!ls.exists) throw fail('not-found', 'Lead not found');
  const lead = ls.data() || {};
  if (lead.deleted === true) throw fail('not-found', 'Lead not found');
  const companyId = String(lead.companyId || lead.userId || '');
  // Owner or admin only: the platform admin, the company_admin of THIS tenant, or the tenant's own owner (solo uid).
  const role = String(token.role || '');
  const tokenCo = typeof token.companyId === 'string' ? token.companyId : '';
  const isOwner = uid === companyId || (uid === lead.userId && !tokenCo);
  const isCompanyAdmin = role === 'company_admin' && tokenCo && tokenCo === companyId;
  if (!(role === 'admin' || isCompanyAdmin || isOwner)) throw fail('permission-denied', 'Only the company owner or an admin can approve a job to proceed without a signed attic page.');
  const gate = await decide(db, leadId, lead);
  if (!gate.required) throw fail('failed-precondition', 'This job does not need an attic acknowledgment.');
  const name = String((token.name || token.email || '')).slice(0, 120);
  const ref = db.collection(OVERRIDES).doc();
  await ref.set({ leadId, companyId, byUid: uid, byName: name || null, reason, scope: gate.scope, at: Date.now(), version: AA.VERSION });
  return { ok: true, id: ref.id };
}

module.exports = { OVERRIDES, gated, isAtticDoc, applyAcks, resultFor, decide, recordOverride };
