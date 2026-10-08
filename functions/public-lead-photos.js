/**
 * public-lead-photos.js — homeowners attach photos to a website request.
 *
 * Jo (2026-09-30): "they also need to have the ability to add or upload photos
 * with their requests, someone tried recently." Before this, the inspection
 * form sent only a photo COUNT and file names; nothing reached the CRM.
 *
 * Flow (no open upload bucket — the browser never writes to Storage):
 *   1. submitPublicLead (handlers/integrations.js) creates the public lead
 *      and, when the form says it has photos, answers with a one-time
 *      `photoToken` from mintPhotoGrant(): a random 24-byte secret whose
 *      SHA-256 keys public_lead_photo_grants/{hash} = { collection,
 *      publicId, companyId, exp (60 min), max 10, used }. The raw token is
 *      never stored.
 *   2. The page POSTs each photo to uploadPublicLeadPhoto { token, dataUrl,
 *      caption }. The grant is checked and a slot reserved in ONE
 *      transaction (the portal's W134 TOCTOU lesson), then the bytes are
 *      DECODED and RE-ENCODED with sharp: anything that isn't a real image
 *      fails, EXIF (incl. GPS) is dropped, the photo is auto-rotated and
 *      capped at 2560px.
 *   3. It lands exactly where portal homeowner uploads land —
 *      homeowner-uploads/{ownerUid}/{crmLeadId}/web-*.jpg (owner-only
 *      storage read; signImageUrl already re-signs this prefix) — with a
 *      /photos doc on the CRM lead the bridge creates for this submission
 *      (id bridgeDocId(collection, publicId)), so the rep's gallery shows
 *      it with no CRM change, even if the photo beats the lead by a second.
 *
 * Owner = the same target the lead bridge uses (resolveBridgeTarget):
 * NBD's forms → Joe; a tenant microsite → that tenant's owner.
 */
'use strict';

const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { CORS_ORIGINS } = require('./handlers/_shared');
const { enforceRateLimit, clientIp } = require('./integrations/upstash-ratelimit');
const { rateLimitIpKey } = require('./rate-limit');
const L = require('./lead-bridge-logic');
const { reencodePhoto } = require('./photo-reencode');

const GRANTS = 'public_lead_photo_grants';
const MAX_PHOTOS = 10;
const GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_B64 = 11 * 1024 * 1024;          // ~8 MB decoded — a full phone photo
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
// Only these public-lead collections may carry photos (service requests).
const PHOTO_COLLECTIONS = ['contact_leads', 'inspect_leads', 'estimate_leads', 'free_roof_entries'];

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ── Who the homeowner should contact when something fails (2026-10-05) ──
// NBD's grant (no companyId, or the NBD owner uid) keeps the exact "text Joe
// at (859) 420-7382" wording. Another company's grant names that company's
// own phone / name from companyProfile, or says nothing about who — never Joe.
// contact: null = NBD; { name, phone } = another company (either may be '').
async function grantContact(db, companyId) {
  if (!companyId || String(companyId) === NBD_OWNER_UID) return null;
  try {
    const s = await db.collection('companyProfile').doc(String(companyId)).get();
    const b = (s && s.exists ? (s.data() || {}).brand : null) || {};
    const name = String(b.legalName || '').trim();
    const phone = String((b.contact && b.contact.phone) || '').trim();
    return { name: name === 'No Big Deal Home Solutions' ? '' : name, phone };
  } catch (_) { return { name: '', phone: '' }; }
}
/** Pure: the help sentence for one failure, per tenant (see grantContact). */
function helpLine(kind, contact) {
  const c = contact || null;
  const phone = c ? c.phone : '';
  const who = c ? (c.name || 'the company you contacted') : '';
  switch (kind) {
    case 'uploadClosed':
      if (!c) return 'This upload window has closed. Text your photos to (859) 420-7382 instead.';
      return phone ? 'This upload window has closed. Text your photos to ' + phone + ' instead.'
        : 'This upload window has closed. Send your photos to ' + who + ' directly instead.';
    case 'attachFailed':
      if (!c) return 'We could not attach this photo. Text it to (859) 420-7382.';
      return phone ? 'We could not attach this photo. Text it to ' + phone + '.'
        : 'We could not attach this photo. Send it to ' + who + ' directly.';
    case 'saveFailed':
      if (!c) return 'The photo did not save. Try again, or text it to (859) 420-7382.';
      return phone ? 'The photo did not save. Try again, or text it to ' + phone + '.' : 'The photo did not save. Try again.';
    case 'intakeClosed':
      if (!c) return 'This window has closed. Call or text Joe at (859) 420-7382 with anything else.';
      return phone ? 'This window has closed. Call or text ' + (c.name ? c.name + ' at ' : '') + phone + ' with anything else.'
        : 'This window has closed. Contact ' + who + ' directly with anything else.';
    case 'intakeFailed':
      if (!c) return 'Could not save that. Call or text Joe at (859) 420-7382.';
      return phone ? 'Could not save that. Call or text ' + (c.name ? c.name + ' at ' : '') + phone + '.' : 'Could not save that. Try again later.';
    default: return '';
  }
}

/** Pure: parse + bound a data URL. → { mime, b64 } | { error } */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_B64 + 64) return { error: 'too-large' };
  const m = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { error: 'bad-format' };
  if (m[2].length > MAX_B64) return { error: 'too-large' };
  return { mime: m[1], b64: m[2] };
}

/** Pure: is this grant usable now? → { ok } | { ok:false, status, error } */
function checkGrant(g, nowMs, contact) {
  if (!g) return { ok: false, status: 404, error: 'This upload link is not valid.' };
  if (!(g.exp > nowMs)) return { ok: false, status: 410, error: helpLine('uploadClosed', contact) };
  if ((g.used || 0) >= (g.max || MAX_PHOTOS)) return { ok: false, status: 429, error: 'That is the most photos one request can hold (10).' };
  if (!PHOTO_COLLECTIONS.includes(g.collection) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(g.publicId || ''))) {
    return { ok: false, status: 400, error: 'This upload link is not valid.' };
  }
  return { ok: true };
}

/** Called by submitPublicLead after the public lead is written. → raw token */
async function mintPhotoGrant(db, { collection, publicId, companyId }) {
  if (!PHOTO_COLLECTIONS.includes(collection)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  await db.collection(GRANTS).doc(hashToken(token)).set({
    collection, publicId: String(publicId), companyId: companyId || null,
    exp: Date.now() + GRANT_TTL_MS, max: MAX_PHOTOS, used: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
  return token;
}

/** Re-encode: proves it's an image, drops EXIF/GPS, auto-rotates, caps size. */
// Shared with the homeowner portal upload (functions/photo-reencode.js).
async function reencode(buffer) {
  return reencodePhoto(buffer, 'jpeg');
}

exports.uploadPublicLeadPhoto = onRequest(
  { cors: CORS_ORIGINS, maxInstances: 10, concurrency: 20, timeoutSeconds: 60, memory: '1GiB' },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    try {
      await enforceRateLimit('publicLeadPhoto:ip', rateLimitIpKey(clientIp(req)), 30, 10 * 60_000);
    } catch (e) {
      if (e && e.rateLimited) { res.set('Retry-After', '120'); res.status(429).json({ error: 'Too many uploads — wait a minute.' }); return; }
      // Limiter backend down: the grant itself still caps one request at 10.
    }
    const body = req.body || {};
    const token = typeof body.token === 'string' ? body.token : '';
    if (!/^[a-f0-9]{48}$/.test(token)) { res.status(400).json({ error: 'This upload link is not valid.' }); return; }
    const parsed = parseDataUrl(body.dataUrl);
    if (parsed.error) {
      res.status(parsed.error === 'too-large' ? 413 : 400).json({ error: parsed.error === 'too-large' ? 'That photo is too large (8 MB max).' : 'Photos must be JPEG, PNG, WebP or HEIC.' });
      return;
    }
    const caption = typeof body.caption === 'string' ? body.caption.replace(/[<>]/g, '').slice(0, 280) : '';

    const db = getFirestore();
    const ref = db.collection(GRANTS).doc(hashToken(token));

    // Cheap check first (no decode work for a bad or used-up link), then
    // decode BEFORE reserving a slot, so a file that isn't a photo never
    // uses up one of the ten. The transaction below re-checks the grant.
    let contact = null;
    try {
      const pre = await ref.get();
      const g0 = pre.exists ? pre.data() : null;
      contact = await grantContact(db, g0 && g0.companyId);
      const c = checkGrant(g0, Date.now(), contact);
      if (!c.ok) { res.status(c.status).json({ error: c.error }); return; }
    } catch (e) {
      logger.error('uploadPublicLeadPhoto: grant read failed', { err: e.message });
      res.status(500).json({ error: 'Could not start the upload. Try again.' });
      return;
    }
    let jpeg;
    try {
      jpeg = await reencode(Buffer.from(parsed.b64, 'base64'));
    } catch (e) {
      logger.warn('uploadPublicLeadPhoto: not a decodable image', { err: e.message });
      res.status(400).json({ error: 'That file could not be read as a photo.' });
      return;
    }

    let grant;
    try {
      grant = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const g = snap.exists ? snap.data() : null;
        const c = checkGrant(g, Date.now(), contact);
        if (!c.ok) { const e = new Error('grant'); e._http = c.status; e._msg = c.error; throw e; }
        tx.update(ref, { used: FieldValue.increment(1), lastUploadAt: FieldValue.serverTimestamp() });
        return Object.assign({ n: (g.used || 0) + 1 }, g);
      });
    } catch (e) {
      if (e && e._http) { res.status(e._http).json({ error: e._msg }); return; }
      logger.error('uploadPublicLeadPhoto: reservation failed', { err: e.message });
      res.status(500).json({ error: 'Could not start the upload. Try again.' });
      return;
    }

    try {
      let companyDoc = null;
      if (grant.companyId) {
        const s = await db.collection('companies').doc(String(grant.companyId)).get().catch(() => null);
        companyDoc = s && s.exists ? s.data() : null;
      }
      const target = L.resolveBridgeTarget(grant.companyId, companyDoc, { nbdOwnerUid: NBD_OWNER_UID });
      if (!target) { res.status(409).json({ error: helpLine('attachFailed', contact) }); return; }
      const leadId = L.bridgeDocId(grant.collection, grant.publicId);
      const path = `homeowner-uploads/${target.ownerUid}/${leadId}/web-${Date.now()}-${grant.n}.jpg`;
      const file = getStorage().bucket().file(path);
      await file.save(jpeg, { contentType: 'image/jpeg', resumable: false });
      // Best-effort baked URL, like the portal's. The photo is already stored,
      // so a signing failure must not fail the upload: the CRM re-signs
      // homeowner-uploads/ on demand (signImageUrl) from `path`.
      let url = null, urlExpiresAt = null;
      try {
        urlExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
        [url] = await file.getSignedUrl({ action: 'read', expires: urlExpiresAt });
      } catch (e) {
        urlExpiresAt = null;
        logger.warn('uploadPublicLeadPhoto: signing failed — stored without a baked url', { err: e.message });
      }
      await db.collection('photos').add({
        leadId, userId: target.ownerUid, companyId: target.companyId,
        source: 'web_form', url, urlExpiresAt, path, mimeType: 'image/jpeg', caption,
        phase: 'Before',
        createdAt: FieldValue.serverTimestamp(), uploadedAt: FieldValue.serverTimestamp(),
        sharedWithHomeowner: false,
      });
      await db.collection(grant.collection).doc(grant.publicId)
        .set({ photoCount: FieldValue.increment(1), lastPhotoAt: FieldValue.serverTimestamp() }, { merge: true })
        .catch(() => {});
      logger.info('uploadPublicLeadPhoto', { collection: grant.collection, n: grant.n, bytes: jpeg.length });
      res.status(200).json({ success: true, n: grant.n });
    } catch (e) {
      logger.error('uploadPublicLeadPhoto: store failed', { err: e.message });
      res.status(500).json({ error: helpLine('saveFailed', contact) });
    }
  }
);

// ═════════════════════════════════════════════════════════════
// updatePublicLeadIntake (2026-10-03) — the /estimate thank-you screen's
// optional "help Joe prepare" answers (scheduling choice, best time,
// insurance, how they heard), saved onto the SAME lead after it exists.
//
// Why: the funnel's contact step used to ask all of these up front (the
// scheduling choice was required), on top of a text-code check — and the
// funnel produced 3 leads, ever. The contact step now asks first name, phone
// and consent only; the lead (and Joe's alert) lands on that. These questions
// moved after it.
//
// Authorisation is the grant submitPublicLead already mints for this exact
// submission (wantsFollowUp → the same 60-minute photoToken): the browser can
// only ever touch the one public lead + its bridged CRM card, never choose a
// document. Answers go through sanitizeIntake — the SAME allowlist, caps and
// enums submitPublicLead applies — and at most INTAKE_MAX_UPDATES saves per
// grant. Nothing here alerts anyone; the lead already did.
// ═════════════════════════════════════════════════════════════
const { sanitizeIntake, sanitizeFollowUpExtras, FOLLOWUP_EXTRA_COLLECTIONS } = require('./public-lead-intake-spec');
const INTAKE_MAX_UPDATES = 3;
const CRM_LEAD_TRIES = 3;
const CRM_LEAD_WAIT_MS = 2500;

/** Pure: may this grant save follow-up answers now? */
function checkIntakeGrant(g, nowMs, contact) {
  if (!g) return { ok: false, status: 404, error: 'This link is not valid.' };
  if (!(g.exp > nowMs)) return { ok: false, status: 410, error: helpLine('intakeClosed', contact) };
  if ((g.intakeUpdates || 0) >= INTAKE_MAX_UPDATES) return { ok: false, status: 429, error: 'Those answers are already saved.' };
  if (!PHOTO_COLLECTIONS.includes(g.collection) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(g.publicId || ''))) {
    return { ok: false, status: 400, error: 'This link is not valid.' };
  }
  return { ok: true };
}

/**
 * The whole save, against an injected Firestore (tests pass a fake).
 * → { status, json }
 */
async function saveIntakeUpdate(db, body, opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const wait = typeof o.wait === 'function' ? o.wait : (ms) => new Promise((r) => setTimeout(r, ms));
  const b = body || {};
  const token = typeof b.token === 'string' ? b.token : '';
  if (!/^[a-f0-9]{48}$/.test(token)) return { status: 400, json: { error: 'This link is not valid.' } };
  const fields = sanitizeIntake(b);
  // /inspect's thank-you screen (2026-10-06): "What happened?", email and a
  // referral code, for an inspect_leads grant only (checked in the transaction).
  const extras = sanitizeFollowUpExtras(b);
  if (!Object.keys(fields).length && !Object.keys(extras).length) return { status: 400, json: { error: 'Nothing to save.' } };

  const ref = db.collection(GRANTS).doc(hashToken(token));
  // Whose grant: the help wording names that company (grantContact).
  let contact = null;
  try {
    const pre = await ref.get();
    contact = await grantContact(db, pre && pre.exists ? (pre.data() || {}).companyId : null);
  } catch (_) { contact = null; }
  let grant;
  try {
    grant = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const g = snap.exists ? snap.data() : null;
      const c = checkIntakeGrant(g, now(), contact);
      if (!c.ok) { const e = new Error('grant'); e._http = c.status; e._msg = c.error; throw e; }
      // Extras count only for the collection that asks them: a grant from any
      // other form with nothing else to save is refused before it is spent.
      if (!Object.keys(fields).length && !FOLLOWUP_EXTRA_COLLECTIONS.includes(g.collection)) {
        const e = new Error('grant'); e._http = 400; e._msg = 'Nothing to save.'; throw e;
      }
      tx.update(ref, { intakeUpdates: FieldValue.increment(1), lastIntakeAt: FieldValue.serverTimestamp() });
      return g;
    });
  } catch (e) {
    if (e && e._http) return { status: e._http, json: { error: e._msg } };
    e._contact = contact;
    throw e;
  }
  try {
    return await _applyIntake(db, grant, fields, extras, wait);
  } catch (e) {
    e._contact = contact;
    throw e;
  }
}

async function _applyIntake(db, grant, fields, extras, wait) {
  const extra = FOLLOWUP_EXTRA_COLLECTIONS.includes(grant.collection) ? extras : {};

  // The public lead (what lead-alert / the funnel-recovery job read). The
  // extras land under the same keys the inspect kind stores at submit.
  await db.collection(grant.collection).doc(grant.publicId)
    .set(Object.assign({}, fields, extra, { intakeUpdatedAt: FieldValue.serverTimestamp() }), { merge: true });

  // The CRM card the bridge made for this submission. The bridge runs on the
  // lead's create, normally seconds before anyone reaches the thank-you
  // screen; if it has not landed yet, wait briefly — never create the card
  // here (that would make the bridge's create() fail and lose the lead).
  const leadRef = db.collection('leads').doc(L.bridgeDocId(grant.collection, grant.publicId));
  const lines = L.intakeNoteLines(fields);
  if (extra.story) lines.push('What happened: ' + extra.story);
  if (extra.email) lines.push('Email: ' + extra.email);
  if (extra.referralCode) lines.push('Referral code: ' + extra.referralCode);
  let crm = false;
  for (let i = 0; i < CRM_LEAD_TRIES && !crm; i++) {
    if (i) await wait(CRM_LEAD_WAIT_MS);
    const snap = await leadRef.get();
    if (!snap.exists) continue;
    const cur = snap.data() || {};
    const prior = typeof cur.notes === 'string' ? cur.notes : '';
    const patch = {
      notes: (prior ? prior + '\n' : '') + 'Added on the thank-you screen:\n' + lines.join('\n'),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (fields.scheduling) patch.schedulingPreference = fields.scheduling;
    // Fill-only: never overwrite an email or referral code already on the card
    // (a rep's edit, or one typed at submit).
    if (extra.email && !cur.email) patch.email = extra.email;
    if (extra.referralCode && !cur.redeemReferralCode) patch.redeemReferralCode = extra.referralCode;
    await leadRef.update(patch);
    crm = true;
  }
  return { status: 200, json: { success: true, crm } };
}

exports.updatePublicLeadIntake = onRequest(
  { cors: CORS_ORIGINS, maxInstances: 10, concurrency: 40, timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    try {
      await enforceRateLimit('publicLeadIntake:ip', rateLimitIpKey(clientIp(req)), 20, 10 * 60_000);
    } catch (e) {
      if (e && e.rateLimited) { res.set('Retry-After', '120'); res.status(429).json({ error: 'Too many requests — wait a minute.' }); return; }
      // Limiter backend down: the grant itself caps a submission at 3 saves.
    }
    try {
      const out = await saveIntakeUpdate(getFirestore(), req.body || {});
      if (out.status === 200) logger.info('updatePublicLeadIntake', { crm: out.json.crm });
      res.status(out.status).json(out.json);
    } catch (e) {
      logger.error('updatePublicLeadIntake failed', { err: e.message });
      res.status(500).json({ error: helpLine('intakeFailed', e && e._contact) });
    }
  }
);

exports._internal = {
  mintPhotoGrant, parseDataUrl, checkGrant, reencode, hashToken, PHOTO_COLLECTIONS, MAX_PHOTOS, GRANTS,
  checkIntakeGrant, saveIntakeUpdate, INTAKE_MAX_UPDATES, helpLine, grantContact,
};
