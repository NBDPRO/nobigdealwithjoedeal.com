'use strict';
/**
 * review-ask-photo.js — the customer's own before/after photo in the
 * automatic review ask email (2026-10-16).
 *
 * Joe: the paid-in-full review ask (review-ask-auto.js) shows the customer
 * THEIR roof, before and after, then asks exactly as before. Flag
 * REVIEW_ASK_EMAIL_PHOTO_ENABLED (functions/.env.nobigdeal-pro); anything but
 * the literal 'true' = no photo, and the email is byte-for-byte the old one.
 *
 * WHICH PHOTOS. Only photos already in the CRM for THIS lead:
 *   - photos/{id} where leadId == the lead, and the photo is the lead's
 *     tenant's (same owner, or same companyId: money-paper's plate rule), not
 *     deleted, naming an image object in a photo folder (photos/{uid}/ or this
 *     lead's homeowner-uploads/{uid}/{leadId}/) that belongs to the photo's
 *     owner or a member of its company (lead-artifact-paths
 *     photoObjectAllowed). A lead id re-created by another tenant, a photo of
 *     another lead, or a doc pointing into someone else's folder is never
 *     read.
 *   - a photo stamped with a DIFFERENT job of the lead is left out (a repeat
 *     customer's old job is not "before").
 *   - if the rep has shared ANY photo of the lead with the homeowner
 *     (sharedWithHomeowner, the portal gallery's flag), only shared photos are
 *     used: the homeowner photo report's 'auto' rule (photo-report.js D-6).
 * The phase is the CRM's own: `phase` Before / After (a phase tag the rep
 * picks, else the lead's stage at capture, photo-engine captureContext), or a
 * 'before' / 'after' / 'completed_work' tag.
 *
 * WHICH PICTURE. A before + after pair (same location label if one matches,
 * else the earliest Before and the latest After), else the latest After
 * alone, else none (the email is unchanged).
 *
 * WHAT IS SENT. The object is downloaded with the admin SDK and re-encoded
 * with sharp (photo-reencode.js): EXIF, GPS and every other metadata block
 * are dropped, orientation is baked in, the long edge is capped. The JPEG goes
 * INSIDE the email as an inline (cid:) attachment: no URL, nothing made
 * public, nothing that expires or can be forwarded as a link. An annotated
 * photo uses its pristine original when the CRM kept one. Any failure (no
 * photo, a read error, a file sharp cannot decode, a slow bucket) = no photo;
 * the ask itself is never held up.
 */

const LAP = require('./lead-artifact-paths');

const PHOTO_FLAG = 'REVIEW_ASK_EMAIL_PHOTO_ENABLED';
const PAIR_EDGE = 900;      // two side by side in a 560 px email, sharp on a 2x phone
const SINGLE_EDGE = 1200;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const CID_BEFORE = 'nbd-review-before';
const CID_AFTER = 'nbd-review-after';
const NOT_IMAGE = /\.(mp4|mov|m4v|webm|avi|pdf|heic|heif)$/i;

const photoFlagOn = (env) => !!env && env.REVIEW_ASK_EMAIL_PHOTO_ENABLED === 'true';

function ms(t) {
  if (!t) return 0;
  if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  if (t instanceof Date) return t.getTime();
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : 0;
}
const takenMs = (p) => ms(p.capturedAt) || ms(p.createdAt) || ms(p.uploadedAt) || 0;

/** The object this photo's pixels live in: the pristine original of an annotated photo, else the current one. */
function objectPathOf(p) {
  if (!p) return '';
  const orig = typeof p.originalStoragePath === 'string' ? p.originalStoragePath : '';
  if (p.isAnnotated === true && orig && LAP.photoObjectUid(orig, p)) return orig;
  return (typeof p.storagePath === 'string' && p.storagePath) || (typeof p.path === 'string' && p.path) || '';
}

/** 'before' | 'after' | null, from the CRM's own phase or tags. */
function phaseOf(p) {
  const ph = String((p && p.phase) || '').trim().toLowerCase();
  if (ph === 'before' || ph === 'after') return ph;
  if (ph) return null;                               // 'during' etc.: a phase that is neither
  const tags = Array.isArray(p && p.tags) ? p.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.includes('after') || tags.includes('completed_work')) return 'after';
  if (tags.includes('before')) return 'before';
  return null;
}

/**
 * The lead's own photos this email may use. Pure (the object-owner read is
 * photoForEmail's). `lead` carries userId / companyId; `leadId` and `jobId`
 * are the ask's.
 */
function eligiblePhotos(lead, leadId, jobId, photos) {
  const l = lead || {};
  const lid = String(leadId || '');
  if (!lid) return [];
  let list = (Array.isArray(photos) ? photos : []).filter((p) => {
    if (!p || typeof p !== 'object') return false;
    if (p.leadId !== lid) return false;
    const sameTenant = (typeof p.userId === 'string' && p.userId && p.userId === l.userId)
      || (typeof l.companyId === 'string' && l.companyId && p.companyId === l.companyId);
    if (!sameTenant) return false;
    if (p.deleted === true || p.deletedAt || p.hidden === true) return false;
    if (jobId && p.jobId && p.jobId !== jobId) return false;
    const path = objectPathOf(p);
    if (!path || NOT_IMAGE.test(path) || !LAP.photoObjectUid(path, p)) return false;
    if (/^(video|application)\//i.test(String(p.mimeType || p.contentType || ''))) return false;
    return true;
  });
  if (list.some((p) => p.sharedWithHomeowner === true)) list = list.filter((p) => p.sharedWithHomeowner === true);
  return list;
}

const normLoc = (p) => String((p && (p.location || (p.inferredLocation && p.inferredLocation.label))) || '')
  .toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ');

/**
 * → { kind: 'pair', before, after } | { kind: 'single', after } | null. Pure.
 * Pair: an After and a Before of the same location (the latest After that has
 * one, with that location's earliest Before), else the earliest Before with
 * the latest After. Single: the latest After. A lone Before is never sent
 * (a picture of the damage is not "your roof").
 */
function pickPhotos(photos) {
  const list = Array.isArray(photos) ? photos : [];
  const byTime = (a, b) => takenMs(a) - takenMs(b) || String(a.id || '').localeCompare(String(b.id || ''));
  const befores = list.filter((p) => phaseOf(p) === 'before').sort(byTime);           // earliest first
  const afters = list.filter((p) => phaseOf(p) === 'after').sort(byTime).reverse();   // latest first
  if (!afters.length) return null;
  if (!befores.length) return { kind: 'single', after: afters[0] };
  for (const a of afters) {
    const k = normLoc(a);
    if (!k) continue;
    const b = befores.find((x) => normLoc(x) === k);
    if (b) return { kind: 'pair', before: b, after: a };
  }
  return { kind: 'pair', before: befores[0], after: afters[0] };
}

/** "roof" unless the job is plainly something else (siding, gutters...). */
function subjectWord(lead, job) {
  const l = lead || {}, j = job || {};
  const s = [j.title, j.type, j.jobType, j.trade, j.service, l.jobType, l.serviceType, l.service, l.projectType]
    .filter((x) => typeof x === 'string').join(' ');
  if (/roof/i.test(s)) return 'roof';
  if (/\b(siding|gutter|window|door|deck|paint|fence|interior|remodel|soffit|fascia)/i.test(s)) return 'project';
  return 'roof';
}

/** What emailContent renders for a pick. Pure. */
function contentFor(kind, word) {
  const w = word === 'project' ? 'project' : 'roof';
  if (kind === 'pair') {
    return { kind: 'pair', word: w, images: [
      { cid: CID_BEFORE, label: 'Before', alt: 'Your ' + w + ' before the work' },
      { cid: CID_AFTER, label: 'After', alt: 'Your ' + w + ' after the work' },
    ] };
  }
  return { kind: 'single', word: w, images: [{ cid: CID_AFTER, label: '', alt: 'Your finished ' + w }] };
}

function withTimeout(p, msLimit) {
  let t;
  return Promise.race([p, new Promise((resolve) => { t = setTimeout(() => resolve(null), msLimit); })])
    .finally(() => clearTimeout(t));
}

/** The default object reader: admin SDK, size-capped. → Buffer */
function storageLoader(bucket) {
  return async (path) => {
    const b = bucket || require('firebase-admin/storage').getStorage().bucket();
    const f = b.file(path);
    const [meta] = await f.getMetadata();
    if (Number(meta && meta.size) > MAX_SOURCE_BYTES) throw new Error('too_big');
    if (meta && meta.contentType && !/^image\//i.test(meta.contentType)) throw new Error('not_image');
    const [buf] = await f.download();
    return buf;
  };
}

async function encode(load, p, edge) {
  const raw = await load(objectPathOf(p));
  const { reencodePhoto } = require('./photo-reencode');
  return reencodePhoto(raw, 'jpeg', { maxEdge: edge });
}

/**
 * The photo block for one ask, or null. Never throws.
 * opts: { loader?(path)→Buffer, bucket?, logger?, timeoutMs? }
 * → { kind, content (for emailContent), attachments (for Resend), photoIds } | null
 */
async function photoForEmail(db, entry, opts) {
  const o = opts || {};
  const log = o.logger || { info() {}, warn() {} };
  const run = async () => {
    const leadId = entry && entry.id;
    if (!leadId) return null;
    const snap = await db.collection('photos').where('leadId', '==', leadId).limit(200).get();
    const docs = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const memo = new Map();
    const cands = [];
    for (const p of eligiblePhotos(entry, leadId, entry.jobId || null, docs)) {
      if (await LAP.photoObjectAllowed(db, objectPathOf(p), p, memo)) cands.push(p);
    }
    let pick = pickPhotos(cands);
    if (!pick) return null;
    const load = o.loader || storageLoader(o.bucket);
    const word = subjectWord(entry, entry.job);
    const att = (cid, name, buf) => ({ filename: name, content: buf.toString('base64'), contentType: 'image/jpeg', contentId: cid });
    if (pick.kind === 'pair') {
      const [b, a] = await Promise.all([
        encode(load, pick.before, PAIR_EDGE).catch((e) => { log.warn('review_photo_skip', { leadId, photoId: pick.before.id, err: e && e.message }); return null; }),
        encode(load, pick.after, PAIR_EDGE).catch((e) => { log.warn('review_photo_skip', { leadId, photoId: pick.after.id, err: e && e.message }); return null; }),
      ]);
      if (b && a) {
        return { kind: 'pair', content: contentFor('pair', word), photoIds: [pick.before.id, pick.after.id],
          attachments: [att(CID_BEFORE, 'before.jpg', b), att(CID_AFTER, 'after.jpg', a)] };
      }
      if (!a) return null;           // the After is the picture that matters
      pick = { kind: 'single', after: pick.after };
    }
    const a = await encode(load, pick.after, SINGLE_EDGE).catch((e) => { log.warn('review_photo_skip', { leadId, photoId: pick.after.id, err: e && e.message }); return null; });
    if (!a) return null;
    return { kind: 'single', content: contentFor('single', word), photoIds: [pick.after.id], attachments: [att(CID_AFTER, 'after.jpg', a)] };
  };
  try {
    return await withTimeout(run(), Number(o.timeoutMs) || TIMEOUT_MS);
  } catch (e) {
    log.warn('review_photo_failed', { leadId: entry && entry.id, err: e && e.message });
    return null;
  }
}

module.exports = {
  PHOTO_FLAG, CID_BEFORE, CID_AFTER, PAIR_EDGE, SINGLE_EDGE,
  photoFlagOn, phaseOf, objectPathOf, eligiblePhotos, pickPhotos, subjectWord, contentFor, photoForEmail,
};
