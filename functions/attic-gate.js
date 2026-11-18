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

const crypto = require('crypto');
const AA = require('./attic-ack');
const TXT = require('./attic-ack-text');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OVERRIDES = 'attic_overrides';
const CONTRACT_CLASS = ['contract', 'proposal', 'work_authorization', 'estimate_esign'];

/** Is this a document type the gate applies to? */
function gated(type) { return CONTRACT_CLASS.indexOf(String(type || '')) !== -1; }
function isAtticDoc(type) { return AA.DOC_TYPES.indexOf(String(type || '')) !== -1; }

// ── The manifest (review 2026-11-18, finding 2) ────────────────────
// The server holds what an attic form MUST contain: which controls, which of them are required, the marker for the variant and the
// packet's own wording. A stored copy that is rep-authored (the in-person path, and the remote path's original) is compared to it
// and only a match counts. The ids below mirror the renderer (document-generator-library.js renderAtticAcknowledgment); the real
// render is pinned against this in tests/attic-ack-review-2026-11-18.test.js.
const ACK_IDS = ['saw', 'declined', 'existing', 'not_inspection', 'moisture', 'tearoff'];
const STMT_IDS = ['not_checked', 'offered', 'unseen', 'no_change'];
const MAX_CONTROLS = 60;
const MARKER_RE = /<!--\s*nbd:attic-ack\s+(\S+)\s+(inspected|not_inspected)\s*-->/g;

function manifestFor(docType) {
  const t = String(docType || '');
  if (AA.DOC_TYPES.indexOf(t) === -1) return null;
  const notInspected = t === 'attic_not_inspected';
  const required = (notInspected ? STMT_IDS.map((i) => 'ack:stmt_' + i) : []).concat(ACK_IDS.map((i) => 'ack:' + i));
  const must = (TXT.RECS_THIRD_PARTY || []).map((_, i) => 'third_party_' + (i + 1));
  const lines = AA.REC_DEFS.map((d) => d.id).concat(must);
  const paras = [].concat(TXT.WHY, TXT.ACKS, [TXT.SAVINGS], notInspected ? TXT.STATEMENTS : []);
  return { variant: notInspected ? 'not_inspected' : 'inspected', required, must, lines, paras };
}

function _plain(s) {
  return String(s == null ? '' : s).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/\*\*/g, '').replace(/\bNBD\b/g, 'Contractor').replace(/at least (\d+|\{\{atticFreeCheckDays\}\}) days/g, 'at least N days').replace(/\s+/g, ' ').trim();
}

/**
 * Is this stored HTML the attic form the server would have issued for this document type? -> { ok, reasons: [code] }
 * Same controls (ids, types, required flags), the variant marker for the type, and the packet's paragraphs. Ticks are not part of
 * it (a signed copy has them). Anything else - an extra, missing or non-required control, a stripped flag, hand-written HTML - fails.
 */
function verifyManifest(docType, html) {
  const m = manifestFor(docType);
  const bad = [];
  if (!m) return { ok: false, reasons: ['doc_type'] };
  const s = String(html == null ? '' : html);
  const markers = []; let mm; MARKER_RE.lastIndex = 0;
  while ((mm = MARKER_RE.exec(s))) markers.push(mm);
  if (markers.length !== 1 || markers[0][1] !== AA.VERSION || markers[0][2] !== m.variant) bad.push('marker');
  const parsed = AA.parseAcks(s);
  const rawCount = (s.match(/data-nbd-ack/gi) || []).length;
  if (parsed.length !== rawCount || parsed.length > MAX_CONTROLS) bad.push('control_count');
  const seen = {};
  parsed.forEach((c) => { if (seen[c.id]) bad.push('duplicate:' + c.id); seen[c.id] = c; });
  const boxes = parsed.filter((c) => c.type === 'checkbox').map((c) => c.id).sort();
  const reqs = m.required.slice().sort();
  if (boxes.join('|') !== reqs.join('|')) bad.push('checkboxes');
  parsed.filter((c) => c.type === 'checkbox').forEach((c) => { if (c.required !== true) bad.push('not_required:' + c.id); });
  const groups = {};
  parsed.filter((c) => c.type === 'radio').forEach((c) => {
    const r = /^rec:([a-z_0-9]+):(yes|no)$/.exec(c.id);
    if (!r || m.lines.indexOf(r[1]) === -1) { bad.push('radio_id:' + c.id); return; }
    if (c.required) bad.push('radio_required:' + c.id);
    (groups[r[1]] = groups[r[1]] || {})[r[2]] = true;
  });
  Object.keys(groups).forEach((g) => { if (!(groups[g].yes && groups[g].no)) bad.push('half_line:' + g); });
  m.must.forEach((g) => { if (!groups[g]) bad.push('missing_line:' + g); });
  const text = _plain(s);
  m.paras.forEach((p, i) => { if (text.indexOf(_plain(p)) === -1) bad.push('wording:' + i); });
  return { ok: bad.length === 0, reasons: bad.slice(0, 12) };
}

/** The doc type the marker names (for a caller with no type of its own). */
function typeFromMarker(html) {
  const r = /<!--\s*nbd:attic-ack\s+\S+\s+(inspected|not_inspected)\s*-->/.exec(String(html || ''));
  return r && r[1] === 'not_inspected' ? 'attic_not_inspected' : 'attic_acknowledgment';
}

/**
 * The executed record for a document that carries tick controls: the original's markup, with `checked` and
 * `disabled` written onto each control from the submission's state. Returns { html, acks, complete }.
 * A control the submission added (an id the original does not have) is ignored.
 */
function applyAcks(originalHtml, signedHtml, docType) {
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
  // The ORIGINAL is rep-authored: it must be the server's own form for this type, or nothing counts as complete.
  const manifest = verifyManifest(docType || typeFromMarker(orig), orig);
  return { html, acks, manifestOk: manifest.ok, manifestReasons: manifest.reasons, complete: manifest.ok && acks.length > 0 && AA.acksComplete(acks).ok };
}

/** What a signed attic form records, from the stored signed copy. */
function resultFor(docType, signedHtml, formDateMs) {
  const acks = AA.parseAcks(signedHtml);
  const manifest = verifyManifest(docType, signedHtml);
  return {
    version: AA.VERSION,
    notInspected: String(docType) === 'attic_not_inspected',
    declined: AA.declinedAny(acks),
    manifestOk: manifest.ok,
    complete: manifest.ok && acks.length > 0 && AA.acksComplete(acks).ok,
    acknowledgments: AA.evidenceAcks(acks),
    formDateMs: Number.isFinite(Number(formDateMs)) ? Number(formDateMs) : null,
  };
}

const okId = (v) => typeof v === 'string' && ID_RE.test(v);

/** A short digest of an estimate's priced content: an override is bound to it, so a re-priced or re-scoped estimate needs a new one. */
function estimateStamp(est) {
  const e = est || {};
  return crypto.createHash('sha256').update(JSON.stringify([e.rows || [], e.lineItems || [], e.grandTotal == null ? null : e.grandTotal])).digest('hex').slice(0, 16);
}

/**
 * Every estimate in play for this send (review 2026-11-18, finding 1): the one actually being sent (o.estimate / o.estimateId),
 * the lead's primary, and - only when neither resolves - the lead's own estimates. The first of these is the BASIS an override
 * is bound to. A read that fails throws (the caller fails closed).
 */
async function _estimateSet(db, leadId, lead, o) {
  const list = [];
  const seen = {};
  const add = (id, data) => { if (data && !seen[id]) { seen[id] = true; list.push({ id, data }); } };
  let basis = null;
  if (o.estimate && typeof o.estimate === 'object') { basis = { id: okId(o.estimateId) ? o.estimateId : '', data: o.estimate }; }
  else if (okId(o.estimateId)) {
    const s = await db.doc('estimates/' + o.estimateId).get();
    if (s && s.exists) basis = { id: o.estimateId, data: s.data() || {} };
  }
  if (basis) add(basis.id, basis.data);
  const pid = okId(lead && lead.primaryEstimateId) ? lead.primaryEstimateId : '';
  if (pid && !seen[pid]) {
    const s = await db.doc('estimates/' + pid).get();
    if (s && s.exists) { const d = s.data() || {}; add(pid, d); if (!basis) basis = { id: pid, data: d }; }
  }
  if (!list.length && okId(leadId)) {
    const q = await db.collection('estimates').where('leadId', '==', leadId).limit(20).get();
    q.docs.forEach((d) => { const x = d.data() || {}; if (x.deleted !== true) add(d.id, x); });
    if (!basis && list.length === 1) basis = list[0];
  }
  return { list, basis: basis ? { id: basis.id, stamp: estimateStamp(basis.data) } : { id: '', stamp: '' } };
}

/**
 * The gate for a contract-class document on this lead. A read that fails THROWS (the caller fails closed; a
 * missing attic form is never assumed). -> { scope, required, satisfied, how, message, warn }
 */
async function decide(db, leadId, lead, opts) {
  const o = opts || {};
  const L = lead || {};
  const set = await _estimateSet(db, leadId, L, o);
  const scope = AA.effectiveScope(L, set.list.map((x) => x.data));
  const g0 = AA.gate({ scope, signedForm: false, override: false });
  if (!g0.required) return Object.assign({ scope, basis: set.basis }, g0);
  // Remember that this was a re-roof (server-owned floor): taking the tear-off line off the estimate later does not lower it.
  if (L.atticScopeFloor !== 'reroof' && okId(leadId) && o.noWrite !== true) {
    try { await db.doc('leads/' + leadId).set({ atticScopeFloor: 'reroof' }, { merge: true }); } catch (_) { /* the gate below is the control */ }
  }
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
  return Object.assign({ scope, basis: set.basis }, AA.gate({ scope, signedForm, override }));
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

module.exports = { estimateStamp, manifestFor, verifyManifest, OVERRIDES, gated, isAtticDoc, applyAcks, resultFor, decide, recordOverride };
