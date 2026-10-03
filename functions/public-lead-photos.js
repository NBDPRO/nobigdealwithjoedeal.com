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

/** Pure: parse + bound a data URL. → { mime, b64 } | { error } */
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_B64 + 64) return { error: 'too-large' };
  const m = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return { error: 'bad-format' };
  if (m[2].length > MAX_B64) return { error: 'too-large' };
  return { mime: m[1], b64: m[2] };
}

/** Pure: is this grant usable now? → { ok } | { ok:false, status, error } */
function checkGrant(g, nowMs) {
  if (!g) return { ok: false, status: 404, error: 'This upload link is not valid.' };
  if (!(g.exp > nowMs)) return { ok: false, status: 410, error: 'This upload window has closed. Text your photos to (859) 420-7382 instead.' };
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
    try {
      const pre = await ref.get();
      const c = checkGrant(pre.exists ? pre.data() : null, Date.now());
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
        const c = checkGrant(g, Date.now());
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
      if (!target) { res.status(409).json({ error: 'We could not attach this photo. Text it to (859) 420-7382.' }); return; }
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
      res.status(500).json({ error: 'The photo did not save. Try again, or text it to (859) 420-7382.' });
    }
  }
);

exports._internal = { mintPhotoGrant, parseDataUrl, checkGrant, reencode, hashToken, PHOTO_COLLECTIONS, MAX_PHOTOS, GRANTS };
