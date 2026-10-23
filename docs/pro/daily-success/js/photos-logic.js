/**
 * photos-logic.js — the pure rules behind the progress photos (Daily Success
 * roadmap, Horizon 2 item 4). The browser side (photos-ui in
 * measurements-ui.js) does the canvas and IndexedDB work; this file holds what
 * can be tested without a browser:
 *
 *   stripJpegMetadata   drops every EXIF / XMP / GPS / comment segment from a
 *                       JPEG (APP1-APP15 and COM), keeping the picture. The
 *                       UI re-encodes through a canvas first, which already
 *                       discards metadata; this is the second, checkable lock
 *                       (a camera shot can carry GPS coordinates of the gym
 *                       or home), run on the bytes that are actually stored.
 *   hasMetadata         true when any such segment is present
 *   fitSize             scale-down dimensions (long edge <= max)
 *   makeRecord          the row stored in IndexedDB (no URL, no token, no
 *                       path: the photo bytes are the only payload)
 *   firstAndLatest      the oldest and newest photo of a pose, for the
 *                       side-by-side compare
 *   prune               the newest MAX_PHOTOS only
 *
 * Photos never leave the device: no Storage path, no download URL.
 *
 * Exposed as window.NBDPhotos and module.exports (tests).
 */
(function (root) {
  'use strict';

  const POSES = [
    { id: 'front', label: 'Front' },
    { id: 'side', label: 'Side' },
    { id: 'back', label: 'Back' },
  ];
  const MAX_EDGE = 1280;
  const MAX_PHOTOS = 60;
  const MAX_BYTES = 1500000;   // per photo after re-encode; the UI lowers quality until it fits

  const validYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const validPose = (p) => POSES.some((x) => x.id === p);

  /**
   * Walks the JPEG segments. Returns { out, removed } where `out` is a new
   * Uint8Array without metadata segments, or null when the bytes are not a
   * well-formed JPEG (the caller then refuses to store them).
   */
  function stripJpegMetadata(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    const parts = [bytes.subarray(0, 2)];
    let removed = 0;
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xFF) return null;
      while (bytes[i + 1] === 0xFF) i++;               // fill bytes
      const m = bytes[i + 1];
      if (m === undefined) return null;
      if (m === 0xD9) { parts.push(bytes.subarray(i, i + 2)); i += 2; break; }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { parts.push(bytes.subarray(i, i + 2)); i += 2; continue; }
      if (i + 3 >= bytes.length) return null;
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2 || i + 2 + len > bytes.length) return null;
      const end = i + 2 + len;
      if (m === 0xDA) { parts.push(bytes.subarray(i)); i = bytes.length; break; }   // scan data to EOF, untouched
      const meta = (m >= 0xE1 && m <= 0xEF) || m === 0xFE;
      if (meta) removed++; else parts.push(bytes.subarray(i, end));
      i = end;
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return { out, removed };
  }

  function hasMetadata(bytes) {
    const r = stripJpegMetadata(bytes);
    return r ? r.removed > 0 : false;
  }

  function fitSize(w, h, max) {
    const m = max || MAX_EDGE;
    if (!(w > 0) || !(h > 0)) return null;
    const k = Math.min(1, m / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  function makeRecord(o) {
    if (!o || !validYmd(o.date) || !validPose(o.pose) || !o.blob) return null;
    const id = 'ph_' + o.date.replace(/-/g, '') + '_' + (o.nonce || Math.random().toString(36).slice(2, 8));
    return { id, date: o.date, pose: o.pose, w: o.w | 0, h: o.h | 0, bytes: o.bytes | 0, blob: o.blob };
  }

  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);

  function firstAndLatest(list, pose) {
    const s = (list || []).filter((p) => p && p.pose === pose && validYmd(p.date)).sort(byDate);
    if (s.length < 2) return null;
    return { first: s[0], latest: s[s.length - 1] };
  }

  /** The ids to delete so no more than MAX_PHOTOS remain (oldest go first). */
  function prune(list, max) {
    const cap = max || MAX_PHOTOS;
    const s = (list || []).filter(Boolean).sort(byDate);
    return s.length > cap ? s.slice(0, s.length - cap).map((p) => p.id) : [];
  }

  const api = { POSES, MAX_EDGE, MAX_PHOTOS, MAX_BYTES, validPose, stripJpegMetadata, hasMetadata, fitSize, makeRecord, firstAndLatest, prune };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDPhotos = api;
})(typeof window !== 'undefined' ? window : null);
