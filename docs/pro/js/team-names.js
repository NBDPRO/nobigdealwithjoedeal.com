/**
 * team-names.js — window.NBDTeamNames: uid → display name for the viewer's
 * company, from companies/{companyId}/members (each member doc carries
 * `uid` + `displayName` / `email`).
 *
 * Why (CRM sweep R14, 2026-09-28): the leaderboards had no way to name a
 * teammate. "Top Reps" showed "Teammate Y6HCf6" (a uid fragment) for any rep
 * whose leads carry no repName, and the D2D rep board keyed by the knock's
 * free-text repName, so one person split into "Casey ZZ_QA" and "You".
 *
 * One cached read per session (per company); a refused or failed read just
 * resolves an empty map — callers fall back to their own labels.
 *
 * Avatars (characters wave 11, 2026-10-25): loadAvatars() / avatarFor(uid) map
 * uid → the Roof Rep look from roofRepScores (readable across the company by
 * firestore.rules; a solo owner reads their own doc). A rep who has never
 * opened Roof Rep has no row and keeps whatever the caller draws instead.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  let _cache = null, _cacheKey = null, _inflight = null;

  function _companyId() {
    const c = window._userClaims || {};
    return c.companyId || null;
  }

  function load() {
    const cid = _companyId();
    if (!cid) return Promise.resolve({});
    if (_cache && _cacheKey === cid) return Promise.resolve(_cache);
    if (_inflight && _inflight.key === cid) return _inflight.p;
    const db = window.db || window._db;
    if (!db || !window.getDocs || !window.collection) return Promise.resolve({});
    const p = window.getDocs(window.collection(db, 'companies', cid, 'members')).then((snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        const m = d.data() || {};
        if (m.uid) map[m.uid] = String(m.displayName || m.name || m.email || d.id || '').trim();
      });
      _cache = map; _cacheKey = cid;
      return map;
    }).catch(() => ({})).finally(() => { if (_inflight && _inflight.p === p) _inflight = null; });
    _inflight = { key: cid, p };
    return p;
  }

  let _av = null, _avKey = null, _avInflight = null;
  function _avatarKey() { return _companyId() || ((window._user && window._user.uid) ? 'solo:' + window._user.uid : null); }
  function loadAvatars() {
    const key = _avatarKey();
    if (!key) return Promise.resolve({});
    if (_av && _avKey === key) return Promise.resolve(_av);
    if (_avInflight && _avInflight.key === key) return _avInflight.p;
    const db = window.db || window._db;
    const cid = _companyId();
    let p;
    if (cid && db && window.getDocs && window.query && window.collection && window.where) {
      p = window.getDocs(window.query(window.collection(db, 'roofRepScores'), window.where('companyId', '==', cid))).then((snap) => {
        const map = {};
        snap.docs.forEach((d) => { const r = d.data() || {}; if (r.avatar && typeof r.avatar === 'object') map[d.id] = r.avatar; });
        return map;
      });
    } else if (!cid && db && window.getDoc && window.doc && window._user && window._user.uid) {
      p = window.getDoc(window.doc(db, 'roofRepScores', window._user.uid)).then((s) => {
        const map = {}; const r = s && s.exists() ? (s.data() || {}) : {};
        if (r.avatar && typeof r.avatar === 'object') map[window._user.uid] = r.avatar;
        return map;
      });
    } else return Promise.resolve({});
    p = p.catch(() => ({})).then((map) => { _av = map; _avKey = key; return map; }).finally(() => { if (_avInflight && _avInflight.p === p) _avInflight = null; });
    _avInflight = { key, p };
    return p;
  }
  // Synchronous: the look, or null until loadAvatars() resolved / for a rep without one.
  function avatarFor(uid) {
    if (!uid) return null;
    return (_av && _avKey === _avatarKey() && _av[uid]) || null;
  }
  function avatarsReady() { return !!(_av && _avKey === _avatarKey()); }

  // Synchronous lookup against the cache (null until load() resolved).
  function nameFor(uid) {
    if (!uid) return null;
    const me = window._user;
    if (me && me.uid === uid) return me.displayName || null;
    return (_cache && _cacheKey === _companyId() && _cache[uid]) || null;
  }

  window.NBDTeamNames = { load, nameFor, loadAvatars, avatarFor, avatarsReady };
})();
