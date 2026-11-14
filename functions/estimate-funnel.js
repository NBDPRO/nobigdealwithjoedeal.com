/**
 * functions/estimate-funnel.js — update a STARTED /estimate lead (2026-11-14).
 *
 * Joe (2026-11-14): the /estimate funnel saves the lead when the homeowner
 * taps Continue on step 1 (name, phone, address, the texting box), because a
 * homeowner who saw the ballpark at step 4 and left was lost. That save is an
 * ordinary submitPublicLead create marked estimateStage 'started' (Joe is
 * alerted, labelled "started, not finished"; the homeowner gets nothing). When
 * the homeowner goes back and changes step 1, or finishes at step 5, the SAME
 * lead is updated here instead of a second one being created.
 *
 * There is no second intake path. This runs INSIDE submitPublicLead, after its
 * per-IP rate limit, Turnstile check, honeypot and per-kind field validation
 * (the same M-04 allowlist, caps and phone rule as a create), and is reached
 * only when the request carries a `leadToken`. The token is the one-time grant
 * submitPublicLead minted for that step-1 save (wantsFollowUp → photoToken,
 * public-lead-photos.js mintPhotoGrant): only the browser that made the lead
 * holds it, and it names exactly one estimate_leads doc, so a request can never
 * choose which lead it touches. Refusals fall back to the normal create in the
 * caller: a lost or expired token must never lose a lead.
 *
 * Bounds on one grant: an estimate_leads grant only; the public doc must still
 * be 'started'; at most MAX_ESTIMATE_UPDATES updates; finishing is accepted
 * once and within FINISH_WINDOW_MS of the step-1 save. Finishing re-opens the
 * grant's 60-minute window so the thank-you screen's optional questions and
 * photos (updatePublicLeadIntake / uploadPublicLeadPhoto) still work.
 *
 * Nothing here alerts anyone or sends anything to the homeowner: it is an
 * update, and every alert/ack is an onCreate trigger.
 *
 * Consent (checked with the nbd-compliance-reference agent, 2026-11-14): the
 * box is on step 1 and can be changed before finishing. A changed value is
 * applied at once and appended to tcpaConsentHistory. The original
 * tcpaConsentAt is never overwritten: an untick is tcpaConsent:false plus
 * tcpaConsentWithdrawnAt, a later re-tick is tcpaConsent:true plus
 * tcpaConsentRenewedAt (sms-consent-declined.js dates both).
 */
'use strict';

const crypto = require('crypto');
const L = require('./lead-bridge-logic');
const TCPA = require('./tcpa-consent');

// Mirrors public-lead-photos.js (GRANTS, GRANT_TTL_MS, hashToken); pinned equal
// by tests/estimate-step1-save-2026-11-14.test.js. Not required from there:
// that module loads Storage and sharp, which the gateway only needs for photos.
const GRANTS = 'public_lead_photo_grants';
const GRANT_TTL_MS = 60 * 60 * 1000;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const COLLECTION = 'estimate_leads';
const TOKEN_RE = /^[a-f0-9]{48}$/;
const MAX_ESTIMATE_UPDATES = 10;
const FINISH_WINDOW_MS = 24 * 60 * 60 * 1000;
const CRM_LEAD_TRIES = 3;
const CRM_LEAD_WAIT_MS = 2500;

// What an update may change on the public lead. All of it has already been
// through submitPublicLead's validation for kind 'estimate'. Not source, type,
// estimateSummary (event fields), UTMs (kept from the step-1 save) or anything
// server-set.
const UPDATE_FIELDS = [
  'firstName', 'lastName', 'phone', 'email', 'address', 'service', 'roofType', 'timeline',
  'requestType', 'lat', 'lon', 'ballparkMin', 'ballparkMax', 'phoneVerified', 'tcpaConsent',
];

function isLeadToken(v) { return typeof v === 'string' && TOKEN_RE.test(v); }

/** Pure: may this grant update its started estimate now? → { ok } | { ok:false, reason } */
function checkEstimateGrant(g, nowMs, stage) {
  if (!g) return { ok: false, reason: 'no_grant' };
  if (g.collection !== COLLECTION || !/^[A-Za-z0-9_-]{1,128}$/.test(String(g.publicId || ''))) return { ok: false, reason: 'not_an_estimate_grant' };
  if (g.estimateCompletedAt) return { ok: false, reason: 'already_finished' };
  if ((Number(g.estimateUpdates) || 0) >= MAX_ESTIMATE_UPDATES) return { ok: false, reason: 'too_many_updates' };
  const minted = Number(g.exp) - GRANT_TTL_MS;
  if (!isFinite(minted)) return { ok: false, reason: 'no_grant_time' };
  // A step-1 change while the grant is live; finishing within a day of step 1.
  const limit = stage === L.ESTIMATE_STAGE_COMPLETED ? minted + FINISH_WINDOW_MS : Number(g.exp);
  if (!(nowMs < limit)) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/**
 * Pure: the public-doc patch and what changed. `prev` is the stored doc,
 * `data` the validated submission. Timestamps come from `ts` (a server
 * timestamp sentinel) and `nowMs` (inside arrays, where a sentinel cannot go).
 */
function buildPublicPatch(prev, data, a) {
  const p = prev || {};
  const d = data || {};
  const patch = {};
  for (const k of UPDATE_FIELDS) {
    if (k === 'tcpaConsent') continue;
    if (d[k] !== undefined && d[k] !== p[k]) patch[k] = d[k];
  }
  const consent = { changed: false, record: {} };
  if (d.tcpaConsent === true && p.tcpaConsent !== true) {
    consent.changed = true;
    patch.tcpaConsent = true;
    if (p.tcpaConsentAt == null) {
      consent.record = TCPA.consentRecord({ consent: true, kind: 'estimate', referer: a.referer, source: p.source || d.source, ip: a.ip, at: a.ts });
      Object.assign(patch, consent.record);
    } else {
      patch.tcpaConsentRenewedAt = a.ts;
      if (p.tcpaConsentWithdrawnAt != null) patch.tcpaConsentWithdrawnAt = a.del;
    }
  } else if (d.tcpaConsent === false && p.tcpaConsent !== false) {
    consent.changed = true;
    patch.tcpaConsent = false;
    if (p.tcpaConsent === true) patch.tcpaConsentWithdrawnAt = a.ts;
  }
  if (consent.changed) {
    patch.tcpaConsentHistory = a.arrayUnion({
      value: patch.tcpaConsent, atMs: a.nowMs,
      version: TCPA.consentVersionForKind('estimate', p.source), step: a.stage === L.ESTIMATE_STAGE_COMPLETED ? 'finish' : 'step1',
    });
  }
  if (a.stage === L.ESTIMATE_STAGE_COMPLETED) {
    patch.estimateStage = L.ESTIMATE_STAGE_COMPLETED;
    patch.estimateCompletedAt = a.ts;
  } else {
    patch.estimateUpdatedAt = a.ts;
  }
  return { patch, consent };
}

/** Pure: the CRM card patch, or null when nothing on the card changes. */
function buildCrmPatch(card, prev, merged, pub, a) {
  const c = card || {};
  const p = prev || {};
  const patch = {};
  // Contact fields the rep has not edited (the card still shows what the
  // public lead said) follow the homeowner's change.
  for (const k of ['firstName', 'address']) {
    if (pub[k] !== undefined && String(c[k] || '') === String(p[k] || '')) patch[k] = String(pub[k]);
  }
  if (pub.phone !== undefined && String(c.phone || '') === String(p.phone || '')) {
    patch.phone = String(pub.phone);
    patch.phoneDigits = phoneDigits10(pub.phone);
  }
  // Fill-only: never overwrite what a rep typed.
  if (pub.lastName && !c.lastName) patch.lastName = String(pub.lastName);
  if (pub.email && !c.email) patch.email = String(pub.email);
  if ((pub.lat !== undefined || pub.lon !== undefined) && c.lat === p.lat && c.lng === p.lon
      && isFinite(Number(merged.lat)) && isFinite(Number(merged.lon))) {
    patch.lat = Number(merged.lat);
    patch.lng = Number(merged.lon);
  }
  if (pub.tcpaConsent === true) {
    patch.tcpaConsent = true;
    for (const k of ['tcpaConsentAt', 'tcpaConsentText', 'tcpaConsentSource', 'tcpaConsentRenewedAt']) {
      if (pub[k] !== undefined) patch[k] = pub[k];
    }
    if (pub.tcpaConsentWithdrawnAt !== undefined) patch.tcpaConsentWithdrawnAt = a.del;
  } else if (pub.tcpaConsent === false) {
    patch.tcpaConsent = false;
    if (pub.tcpaConsentWithdrawnAt !== undefined) patch.tcpaConsentWithdrawnAt = pub.tcpaConsentWithdrawnAt;
  }
  if (a.stage === L.ESTIMATE_STAGE_COMPLETED) {
    patch.estimateStage = L.ESTIMATE_STAGE_COMPLETED;
    patch.estimateCompletedAt = a.ts;
    const prior = typeof c.notes === 'string' ? c.notes : '';
    const kept = prior.split(/\r?\n/).filter((line) => line !== L.STARTED_ESTIMATE_NOTE).join('\n');
    const lines = ['Finished the estimate on the website.'].concat(L.estimateContextLines(merged));
    patch.notes = (kept ? kept + '\n' : '') + lines.join('\n');
  }
  if (!Object.keys(patch).length) return null;
  patch.updatedAt = a.ts;
  return patch;
}

function phoneDigits10(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return d.length === 10 ? d : '';
}

/**
 * Apply one update. → { ok: true, id, crm } | { ok: false, reason }
 * Never throws for a refusal; a Firestore error before the commit is
 * { ok:false, reason:'error' } (the caller then creates as usual). Once the
 * public doc is committed the result is ok even if the CRM card write fails.
 *
 * @param {object} db         Firestore (admin)
 * @param {object} a
 * @param {string} a.token    the leadToken
 * @param {string} a.stage    'started' (a step-1 change) or 'completed'
 * @param {object} a.data     submitPublicLead's validated fields
 * @param {string} [a.ip]  @param {string} [a.referer]
 * @param {object} a.FieldValue  firebase-admin FieldValue
 * @param {Function} [a.now]  @param {Function} [a.wait]  @param {object} [a.log]
 */
async function applyEstimateUpdate(db, a) {
  const o = a || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const wait = typeof o.wait === 'function' ? o.wait : (ms) => new Promise((r) => setTimeout(r, ms));
  const log = o.log || { info() {}, warn() {}, error() {} };
  const FV = o.FieldValue;
  if (!isLeadToken(o.token)) return { ok: false, reason: 'bad_token' };
  const stage = o.stage === L.ESTIMATE_STAGE_COMPLETED ? L.ESTIMATE_STAGE_COMPLETED : L.ESTIMATE_STAGE_STARTED;
  const grantRef = db.collection(GRANTS).doc(hashToken(o.token));
  const helpers = { ts: FV.serverTimestamp(), del: FV.delete(), arrayUnion: (x) => FV.arrayUnion(x) };

  let out;
  try {
    out = await db.runTransaction(async (tx) => {
      const gs = await tx.get(grantRef);
      const g = gs.exists ? gs.data() : null;
      const nowMs = now();
      const c = checkEstimateGrant(g, nowMs, stage);
      if (!c.ok) return { refused: c.reason };
      const pubRef = db.collection(COLLECTION).doc(String(g.publicId));
      const ps = await tx.get(pubRef);
      const prev = ps.exists ? (ps.data() || {}) : null;
      if (!prev) return { refused: 'no_lead' };
      if (!L.isStartedEstimate(COLLECTION, prev)) return { refused: 'not_started' };
      const { patch } = buildPublicPatch(prev, o.data, Object.assign({ stage, nowMs, ip: o.ip, referer: o.referer }, helpers));
      tx.update(pubRef, patch);
      const gpatch = { estimateUpdates: FV.increment(1), lastEstimateUpdateAt: helpers.ts };
      if (stage === L.ESTIMATE_STAGE_COMPLETED) {
        gpatch.estimateCompletedAt = helpers.ts;
        // The thank-you screen's optional questions + photos use this grant.
        gpatch.exp = nowMs + GRANT_TTL_MS;
      }
      tx.update(grantRef, gpatch);
      return { publicId: String(g.publicId), prev, patch };
    });
  } catch (e) {
    log.error('estimateFunnel: update failed before commit', { err: e && e.message });
    return { ok: false, reason: 'error' };
  }
  if (out.refused) return { ok: false, reason: out.refused };

  // The CRM card the bridge made at step 1. Normally there long before
  // anyone finishes; if not yet, wait briefly — never create it here (that
  // would make the bridge's create() fail and lose the lead).
  let crm = false;
  try {
    const leadRef = db.collection('leads').doc(L.bridgeDocId(COLLECTION, out.publicId));
    const merged = Object.assign({}, out.prev, o.data || {});
    for (let i = 0; i < CRM_LEAD_TRIES && !crm; i++) {
      if (i) await wait(CRM_LEAD_WAIT_MS);
      const snap = await leadRef.get();
      if (!snap.exists) continue;
      const patch = buildCrmPatch(snap.data() || {}, out.prev, merged, out.patch, Object.assign({ stage }, helpers));
      if (patch) await leadRef.update(patch);
      crm = true;
    }
    if (!crm) log.warn('estimateFunnel: CRM card not found — public lead updated only', { publicId: out.publicId, stage });
  } catch (e) {
    log.error('estimateFunnel: CRM card update failed — public lead updated', { publicId: out.publicId, stage, err: e && e.message });
  }
  return { ok: true, id: out.publicId, crm };
}

module.exports = {
  applyEstimateUpdate,
  isLeadToken,
  _internal: {
    checkEstimateGrant, buildPublicPatch, buildCrmPatch, UPDATE_FIELDS, GRANTS, GRANT_TTL_MS, hashToken,
    MAX_ESTIMATE_UPDATES, FINISH_WINDOW_MS, CRM_LEAD_TRIES,
  },
};
