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

  // Synchronous lookup against the cache (null until load() resolved).
  function nameFor(uid) {
    if (!uid) return null;
    const me = window._user;
    if (me && me.uid === uid) return me.displayName || null;
    return (_cache && _cacheKey === _companyId() && _cache[uid]) || null;
  }

  window.NBDTeamNames = { load, nameFor };
})();
