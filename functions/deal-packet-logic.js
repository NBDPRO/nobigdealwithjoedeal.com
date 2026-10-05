'use strict';
/**
 * deal-packet-logic.js — what a homeowner's deal link carries (Jo, 2026-10-04).
 *
 * At send time Jo picks one of two packets (stored on the deal as
 * deal_rooms/{id}.packet):
 *   'full'       (default) — the estimate / tiers, 3–6 inspection photos from
 *                the lead (Jo can deselect), the scope summary, the warranty
 *                per tier, and reviews / trust;
 *   'paperwork'  — the estimate / tiers, terms and signature. No photos.
 *
 * PHOTO PRIVACY. The rep's client builds the deal page and uploads it; it
 * never puts a photo URL in it, only PHOTO_MARKER. getDealRoom
 * (deal-acceptance.js) swaps the marker for the photos section on a full
 * packet, with every <img> pointing at /deal/<token>/photo/<n>. That path is
 * getDealPhoto: it re-checks the SAME token (live, pending, not revoked, deal
 * not accepted) on every load and streams a server re-encode
 * (photo-reencode.js: EXIF / GPS dropped). So a photo is reachable only
 * through that deal's link and dies with it — never a Firebase Storage
 * download-token URL (?alt=media&token=…), which is public forever
 * (storage rules do not apply to it).
 *
 * The deal doc names photos by ID only (packetPhotoIds). A photo is served
 * only when its /photos doc belongs to the link's owner, is on the deal's
 * lead, and its Storage object sits under photos/<owner>/ — so an edited deal
 * doc cannot point the link at anyone else's photo.
 *
 * Pure: no I/O. Tests: tests/deal-packet-2026-10-04.test.js.
 */

const PACKETS = Object.freeze(['full', 'paperwork']);
const DEFAULT_PACKET = 'full';
const MAX_PACKET_PHOTOS = 6;
const PHOTO_MARKER = '<!--nbd:deal-photos-->';
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const TOKEN_RE = /^[A-Za-z0-9]{10,64}$/;
const DONE_STATUSES = ['accepted', 'signed', 'scheduled'];

/** Anything but an explicit 'paperwork' is the default full packet. */
function normalizePacket(v) {
  return v === 'paperwork' ? 'paperwork' : DEFAULT_PACKET;
}

/** The deal's photo IDs, in order — none at all on a paperwork packet. */
function packetPhotoIds(deal) {
  const d = deal || {};
  if (normalizePacket(d.packet) !== 'full' || !Array.isArray(d.packetPhotoIds)) return [];
  const out = [];
  for (const id of d.packetPhotoIds) {
    if (typeof id === 'string' && ID_RE.test(id) && out.indexOf(id) === -1) out.push(id);
    if (out.length >= MAX_PACKET_PHOTOS) break;
  }
  return out;
}

/**
 * The Storage object behind a /photos doc: its storagePath, else (legacy docs
 * written before storagePath) the object name inside its download URL. The
 * URL is read for the path only — it is never served or returned.
 */
function storagePathFromPhoto(p) {
  if (!p) return '';
  if (typeof p.storagePath === 'string' && p.storagePath) return p.storagePath;
  const m = String(p.url || '').match(/\/v0\/b\/[^/?#]+\/o\/([^?#]+)/);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (_) { return ''; }
}

/**
 * May this photo ride THIS deal's link? → { ok: true, path } | { ok: false, reason }.
 * ctx = { ownerUid: the link's owner (token, server-written), leadId: the deal's lead }.
 */
function checkPacketPhoto(photo, ctx) {
  const c = ctx || {};
  if (!photo) return { ok: false, reason: 'missing' };
  if (photo.deleted === true) return { ok: false, reason: 'deleted' };
  if (!c.ownerUid || photo.userId !== c.ownerUid) return { ok: false, reason: 'owner' };
  if (!c.leadId || photo.leadId !== c.leadId) return { ok: false, reason: 'lead' };
  const path = storagePathFromPhoto(photo);
  if (!path || path.indexOf('photos/' + c.ownerUid + '/') !== 0 || /\.\.|\/\/|\\/.test(path)) {
    return { ok: false, reason: 'path' };
  }
  return { ok: true, path };
}

/** image-pipeline.js's 1600px WebP next to the original (may not exist). */
function variantFullPath(path) {
  const i = String(path || '').lastIndexOf('/');
  if (i < 0) return '';
  const base = path.slice(i + 1).replace(/\.[^.]+$/, '');
  return path.slice(0, i) + '/_variants/' + base + '_full.webp';
}

function _millis(t) {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  const n = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Is the deal link still good? null when live; else { status } to answer.
 * The same tests getDealRoom applies to the page, plus a revoked link
 * (freshEstimateLink's flip), so a photo never outlives its page.
 */
function linkRefusal(tok, deal, nowMs) {
  if (!tok) return { status: 404 };
  if (tok.revokedAt) return { status: 410 };
  const exp = _millis(tok.expiresAt);
  if (exp && exp < nowMs) return { status: 410 };
  if (tok.status !== 'pending') return { status: 410 };
  if (!deal) return { status: 410 };
  if (DONE_STATUSES.indexOf(deal.status) !== -1) return { status: 410 };
  return null;
}

function photoUrl(token, i) {
  return '/deal/' + token + '/photo/' + i;
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** items: [{ i: index into packetPhotoIds, caption? }]. */
function photosSectionHtml(token, items) {
  if (!TOKEN_RE.test(String(token || '')) || !Array.isArray(items) || !items.length) return '';
  const figs = items.map((it, n) => {
    const cap = it && it.caption ? '<figcaption>' + _esc(String(it.caption).slice(0, 140)) + '</figcaption>' : '';
    return '<figure class="deal-photo"><img src="' + photoUrl(token, it.i) + '" alt="Inspection photo ' + (n + 1) +
      '" loading="lazy" decoding="async">' + cap + '</figure>';
  }).join('');
  return '<section class="deal-photos-wrap" id="dealPhotos"><div class="section-title">Your Inspection Photos</div>' +
    '<div class="deal-photos">' + figs + '</div></section>';
}

/**
 * The served page: the marker becomes the photos section on a full packet
 * with servable photos, and disappears otherwise (paperwork never shows one).
 */
function injectPhotos(html, opts) {
  const o = opts || {};
  const section = normalizePacket(o.packet) === 'full' ? photosSectionHtml(o.token, o.items || []) : '';
  return String(html || '').split(PHOTO_MARKER).join(section);
}

/** A Firebase / GCS Storage URL, or any download-token query. */
const STORAGE_URL_RE = /alt=media|[?&]token=|firebasestorage\.googleapis\.com|firebasestorage\.app|storage\.googleapis\.com/i;
function containsStorageUrl(s) {
  return STORAGE_URL_RE.test(String(s || ''));
}

module.exports = {
  PACKETS, DEFAULT_PACKET, MAX_PACKET_PHOTOS, PHOTO_MARKER, ID_RE, TOKEN_RE,
  normalizePacket, packetPhotoIds, storagePathFromPhoto, checkPacketPhoto, variantFullPath,
  linkRefusal, photoUrl, photosSectionHtml, injectPhotos, containsStorageUrl, STORAGE_URL_RE,
};
