/**
 * deal-packet.js — "Full packet" or "Paperwork only" when Jo sends a deal to
 * the homeowner (2026-10-04).
 *
 *   full       (default) — the estimate / tiers, 3–6 inspection photos from
 *              the lead (Jo can deselect), the scope summary, the warranty
 *              per tier, reviews / trust.
 *   paperwork  — the estimate / tiers, terms and signature. No photos.
 *
 * The choice is stored on the deal (deal_rooms/{id}.packet) and remembered
 * per user on userSettings/{uid}.dealPacket — NOT an nbd_ localStorage key:
 * those are purged on every sign-out (nbd-auth.js purgeAccountStorage), so
 * the choice would silently reset. A small per-uid localStorage copy only
 * answers before the server read lands.
 *
 * Photos are named by /photos doc ID only; the homeowner sees them through
 * the deal link's own /deal/<token>/photo/<n> path (functions/
 * deal-packet-logic.js), never a Storage URL.
 *
 * Loaded by the estimates and closeboard bundles (script-loader.js) — both
 * may run it; the second load is a no-op. Node-requirable for tests.
 */
(function (root) {
  'use strict';
  if (root && root.NBDDealPacket) {
    if (typeof module !== 'undefined' && module.exports) module.exports = root.NBDDealPacket;
    return;
  }

  const PACKETS = ['full', 'paperwork'];
  const DEFAULT_PACKET = 'full';
  const MAX_PHOTOS = 6;
  const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
  const LS_PREFIX = 'dealPacketChoice:';

  function normalize(v) { return v === 'paperwork' ? 'paperwork' : DEFAULT_PACKET; }

  function _ms(p) {
    const t = p && p.createdAt;
    if (!t) return Number(p && p._ms) || 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const n = Date.parse(t);
    return Number.isFinite(n) ? n : 0;
  }
  // An inspection shot: tagged damage / before / a damage type / "inspection".
  function isInspection(p) {
    if (!p) return false;
    if (/damage/i.test(String(p.category || ''))) return true;
    if (/^before$/i.test(String(p.phase || ''))) return true;
    if (p.damageType) return true;
    return Array.isArray(p.tags) && p.tags.some((t) => /inspect|damage/i.test(String(t)));
  }

  /**
   * The photos a full packet offers, best first, up to `max` (6):
   * the ones Jo already put on the estimate, then inspection shots, then the
   * newest. Only the signed-in rep's own photos (the server serves nothing
   * else on the link). → [photo, …] (the input objects).
   */
  function candidates(list, opts) {
    const o = opts || {};
    const max = Math.max(1, Math.min(MAX_PHOTOS, Number(o.max) || MAX_PHOTOS));
    const picked = new Set((o.estimatePhotoIds || []).filter(Boolean));
    const usable = (Array.isArray(list) ? list : []).filter((p) => p && typeof p.id === 'string' && ID_RE.test(p.id)
      && p.deleted !== true && (!o.uid || !p.userId || p.userId === o.uid));
    const rank = (p) => (picked.has(p.id) ? 0 : (isInspection(p) ? 1 : 2));
    return usable.slice().sort((a, b) => (rank(a) - rank(b)) || (_ms(b) - _ms(a))).slice(0, max);
  }

  /** IDs that go on the deal: the candidates minus the ones Jo deselected. */
  function selectedIds(list, opts) {
    const o = opts || {};
    const off = new Set(o.excluded || []);
    return candidates(list, o).map((p) => p.id).filter((id) => !off.has(id));
  }

  /** The deal fields for a packet choice. */
  function dealFields(packet, photoIds) {
    const pk = normalize(packet);
    const ids = pk === 'full'
      ? (Array.isArray(photoIds) ? photoIds : []).filter((id) => typeof id === 'string' && ID_RE.test(id)).slice(0, MAX_PHOTOS)
      : [];
    return { packet: pk, packetPhotoIds: ids };
  }

  // ── Remembered choice (per user) ───────────────────────────────────────
  let _mem = null; // { uid, packet }
  function _uid() { return (root && root._user && root._user.uid) || null; }
  function _lsGet(uid) {
    try { return uid && root.localStorage ? root.localStorage.getItem(LS_PREFIX + uid) : null; } catch (_) { return null; }
  }
  function _lsSet(uid, v) {
    try { if (uid && root.localStorage) root.localStorage.setItem(LS_PREFIX + uid, v); } catch (_) { /* private mode */ }
  }
  /** The signed-in rep's last choice, synchronously (default full). */
  function current() {
    const uid = _uid();
    if (_mem && _mem.uid === uid) return _mem.packet;
    const ls = _lsGet(uid);
    return ls ? normalize(ls) : DEFAULT_PACKET;
  }
  /** Read userSettings/{uid}.dealPacket (the durable copy). Resolves the choice. */
  async function load() {
    const uid = _uid();
    if (!uid || !root.getDoc || !root.doc || !root.db) return current();
    try {
      const snap = await root.getDoc(root.doc(root.db, 'userSettings', uid));
      const v = snap && snap.exists && snap.exists() ? (snap.data() || {}).dealPacket : null;
      if (v && _uid() === uid) {
        _mem = { uid, packet: normalize(v) };
        _lsSet(uid, _mem.packet);
      }
    } catch (_) { /* keep the local answer */ }
    return current();
  }
  /** Remember a choice for this rep. Resolves true when the server copy landed. */
  async function remember(v) {
    const uid = _uid();
    const packet = normalize(v);
    if (!uid) return false;
    _mem = { uid, packet };
    _lsSet(uid, packet);
    if (!root.setDoc || !root.doc || !root.db) return false;
    try {
      await root.setDoc(root.doc(root.db, 'userSettings', uid), { dealPacket: packet }, { merge: true });
      return true;
    } catch (_) { return false; }
  }

  const API = {
    PACKETS, DEFAULT_PACKET, MAX_PHOTOS,
    normalize, isInspection, candidates, selectedIds, dealFields,
    current, load, remember,
    _reset: () => { _mem = null; },
  };
  if (root) root.NBDDealPacket = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
