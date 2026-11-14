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
// Added to the card when the homeowner moves the address after the step-1
// save: the roof measured for the first address may be the wrong building.
const LOCATION_CHANGED_NOTE = 'The homeowner changed the address on the website after the first save; check the roof measurement before using it.';

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
  const consent = { changed: false, reason: '' };
  const phoneChanged = d.phone !== undefined && phoneDigits10(d.phone) !== phoneDigits10(p.phone);
  if (d.tcpaConsent === true && p.tcpaConsent !== true) {
    consent.changed = true;
    consent.reason = 'ticked';
    patch.tcpaConsent = true;
    if (p.tcpaConsentAt == null) {
      Object.assign(patch, TCPA.consentRecord({ consent: true, kind: 'estimate', referer: a.referer, source: p.source || d.source, ip: a.ip, at: a.ts }));
    } else {
      // A re-tick after an untick: a fresh stamp; the original tcpaConsentAt
      // and the withdrawal stamp both stay (sms-consent-declined dates by the
      // newest of each).
      patch.tcpaConsentRenewedAt = a.ts;
    }
  } else if (d.tcpaConsent === false && p.tcpaConsent !== false) {
    consent.changed = true;
    consent.reason = 'unticked';
    patch.tcpaConsent = false;
    if (p.tcpaConsent === true) patch.tcpaConsentWithdrawnAt = a.ts;
  } else if (phoneChanged && p.tcpaConsent === true && d.tcpaConsent !== false) {
    // The box is still ticked but the number above it changed: the consent is
    // for the NEW number as of now (security review M3).
    consent.changed = true;
    consent.reason = 'phone_changed';
    patch.tcpaConsentRenewedAt = a.ts;
  }
  if (consent.changed) {
    const value = patch.tcpaConsent !== undefined ? patch.tcpaConsent : p.tcpaConsent === true;
    patch.tcpaConsentHistory = a.arrayUnion({
      value, reason: consent.reason, atMs: a.nowMs,
      phoneDigits: phoneDigits10(d.phone !== undefined ? d.phone : p.phone),
      version: TCPA.consentVersionForKind('estimate', p.source), step: a.stage === L.ESTIMATE_STAGE_COMPLETED ? 'finish' : 'step1',
    });
  }
  // The roof was measured for the step-1 address. A new address or point
  // makes it the wrong building: void the public copy so the wizard falls
  // back to the size tile (publicRoofMeasure honours publicMeasurementVoid,
  // and a measurement that lands later cannot clear it).
  if (patch.address !== undefined || patch.lat !== undefined || patch.lon !== undefined) {
    patch.publicMeasurementVoid = true;
    patch.publicMeasurement = a.del;
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
  // Consent: the card is what the CRM's send gates read, so it follows every
  // change (and, from the update trigger, any change it missed).
  if (pub.tcpaConsent !== undefined && c.tcpaConsent !== pub.tcpaConsent) patch.tcpaConsent = pub.tcpaConsent;
  for (const k of ['tcpaConsentAt', 'tcpaConsentText', 'tcpaConsentSource', 'tcpaConsentRenewedAt', 'tcpaConsentWithdrawnAt']) {
    if (pub[k] !== undefined && !sameStamp(c[k], pub[k])) patch[k] = pub[k];
  }
  let notes = typeof c.notes === 'string' ? c.notes : '';
  let notesChanged = false;
  if ((pub.address !== undefined || pub.lat !== undefined || pub.lon !== undefined)
      && notes.split(/\r?\n/).indexOf(LOCATION_CHANGED_NOTE) === -1) {
    notes = (notes ? notes + '\n' : '') + LOCATION_CHANGED_NOTE;
    notesChanged = true;
  }
  // Finishing: once (a card already marked completed is left alone, so the
  // inline write and the update trigger can both run this).
  if (a.stage === L.ESTIMATE_STAGE_COMPLETED && c.estimateStage !== L.ESTIMATE_STAGE_COMPLETED) {
    patch.estimateStage = L.ESTIMATE_STAGE_COMPLETED;
    patch.estimateCompletedAt = a.ts;
    const kept = notes.split(/\r?\n/).filter((line) => line !== L.STARTED_ESTIMATE_NOTE).join('\n');
    const lines = ['Finished the estimate on the website.'].concat(L.estimateContextLines(merged));
    notes = (kept ? kept + '\n' : '') + lines.join('\n');
    notesChanged = true;
  }
  if (notesChanged) patch.notes = notes;
  if (!Object.keys(patch).length) return null;
  patch.updatedAt = a.ts;
  return patch;
}

function phoneDigits10(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return d.length === 10 ? d : '';
}

// Two stored stamps are the same instant (Firestore Timestamps, or the
// tests' plain {atMs}); a fresh serverTimestamp sentinel never is.
function sameStamp(x, y) {
  if (x === y) return true;
  const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (v && typeof v.atMs === 'number' ? v.atMs : null));
  const a = ms(x), b = ms(y);
  return a != null && a === b;
}

/**
 * Patch the CRM card in a transaction (a rep's edit between the read and the
 * write is never lost). The bridge makes the card on the step-1 create,
 * normally long before anything changes; if it is not there yet, wait
 * briefly — never create it here (the bridge's create() would then fail and
 * lose the lead). → true when the card was found.
 */
async function patchCard(db, publicId, build, wait) {
  const leadRef = db.collection('leads').doc(L.bridgeDocId(COLLECTION, publicId));
  for (let i = 0; i < CRM_LEAD_TRIES; i++) {
    if (i) await wait(CRM_LEAD_WAIT_MS);
    const found = await db.runTransaction(async (tx) => {
      const snap = await tx.get(leadRef);
      if (!snap.exists) return false;
      const patch = build(snap.data() || {});
      if (patch) tx.update(leadRef, patch);
      return true;
    });
    if (found) return true;
  }
  return false;
}

/**
 * Apply one update. → { ok: true, id, crm } | { ok: false, reason }
 * Never throws for a refusal; a Firestore error before the commit is
 * { ok:false, reason:'error' } (the caller then creates as usual). Once the
 * public doc is committed the result is ok even if the CRM card write fails:
 * the estimate_leads update trigger (lead-bridge.js leadBridgeEstimateUpdate)
 * applies the same card patch again.
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
      if (!c.ok) return { refused: c.reason, publicId: g && g.collection === COLLECTION ? String(g.publicId || '') : '' };
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
  if (out.refused) {
    // The finish already landed and the browser is retrying (its first answer
    // was lost): answer as before rather than create a duplicate lead
    // (silent-failure review #2). Nothing is written again.
    if (out.refused === 'already_finished' && stage === L.ESTIMATE_STAGE_COMPLETED && out.publicId) {
      log.info('estimateFunnel: finish replayed — same lead', { publicId: out.publicId });
      return { ok: true, id: out.publicId, crm: false, replay: true };
    }
    return { ok: false, reason: out.refused };
  }

  let crm = false;
  try {
    const merged = Object.assign({}, out.prev, o.data || {});
    crm = await patchCard(db, out.publicId,
      (card) => buildCrmPatch(card, out.prev, merged, out.patch, Object.assign({ stage }, helpers)), wait);
    if (!crm) log.warn('estimateFunnel: CRM card not found — public lead updated; the update trigger retries', { publicId: out.publicId, stage });
  } catch (e) {
    log.error('estimateFunnel: CRM card update failed — public lead updated; the update trigger retries', { publicId: out.publicId, stage, err: e && e.message });
  }
  return { ok: true, id: out.publicId, crm };
}

/**
 * Second chance for the card (estimate_leads update trigger): rebuild the same
 * patch from the stored before/after of the public lead. buildCrmPatch is
 * idempotent, so running after a successful inline write changes nothing.
 * → 'skipped' | 'synced' | 'no_card'
 */
async function syncCardFromUpdate(db, publicId, before, after, opts) {
  const o = opts || {};
  const b = before || {};
  const af = after || {};
  // Only started estimates are ever updated this way.
  if (!L.isStartedEstimate(COLLECTION, b)) return 'skipped';
  const pub = {};
  for (const k of UPDATE_FIELDS.concat(['tcpaConsentAt', 'tcpaConsentText', 'tcpaConsentSource', 'tcpaConsentRenewedAt', 'tcpaConsentWithdrawnAt'])) {
    if (af[k] === undefined) continue;
    const same = (af[k] && typeof af[k] === 'object') ? sameStamp(af[k], b[k]) : af[k] === b[k];
    if (!same) pub[k] = af[k];
  }
  const stage = af.estimateStage === L.ESTIMATE_STAGE_COMPLETED ? L.ESTIMATE_STAGE_COMPLETED : L.ESTIMATE_STAGE_STARTED;
  if (!Object.keys(pub).length && stage !== L.ESTIMATE_STAGE_COMPLETED) return 'skipped';
  const FV = o.FieldValue;
  const helpers = { ts: FV.serverTimestamp(), del: FV.delete() };
  const wait = typeof o.wait === 'function' ? o.wait : (ms) => new Promise((r) => setTimeout(r, ms));
  const found = await patchCard(db, String(publicId), (card) => buildCrmPatch(card, b, af, pub, Object.assign({ stage }, helpers)), wait);
  return found ? 'synced' : 'no_card';
}

/**
 * The finish alert (lead-alert.js leadAlertEstimateFinished): a started
 * estimate just finished. Joe got the step-1 alert; this tells him they
 * finished (and, on the OTP-skip path, that they asked for a call). Never a
 * homeowner message (ack:false). A lead the intake guard marked duplicate or
 * over the daily cap stays quiet, like its step-1 alert.
 * → null (not a finish) | { alert:false, reason } | { alert:true, opts }
 */
const FINISHED_ESTIMATE_LABEL = 'Instant Estimate (finished)';
function finishAlertPlan(before, after) {
  if (!L.isStartedEstimate(COLLECTION, before)) return null;
  if (String((after || {}).estimateStage || '') !== L.ESTIMATE_STAGE_COMPLETED) return null;
  const sup = (after || {}).alertSuppressed;
  if (sup === 'duplicate' || sup === 'volume') return { alert: false, reason: sup };
  return { alert: true, opts: { ack: false, label: FINISHED_ESTIMATE_LABEL } };
}

module.exports = {
  applyEstimateUpdate,
  syncCardFromUpdate,
  finishAlertPlan,
  isLeadToken,
  FINISHED_ESTIMATE_LABEL,
  LOCATION_CHANGED_NOTE,
  _internal: {
    checkEstimateGrant, buildPublicPatch, buildCrmPatch, UPDATE_FIELDS, GRANTS, GRANT_TTL_MS, hashToken,
    MAX_ESTIMATE_UPDATES, FINISH_WINDOW_MS, CRM_LEAD_TRIES, sameStamp,
  },
};
