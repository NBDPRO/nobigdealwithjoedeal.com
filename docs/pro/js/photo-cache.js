/**
 * photo-cache.js — window.NBDPhotoCache: lead photos loaded ON DEMAND.
 *
 * WHY (2026-10-04, startup audit)
 * ───────────────────────────────
 * loadLeads() used to finish every dashboard boot by reading EVERY photos doc
 * the user can see (own + company scope, no limit) into window._photoCache —
 * on a real book that is thousands of reads and megabytes of metadata before
 * the rep has opened a single customer. The kanban cards do not even draw a
 * thumbnail strip (crm-pipeline.js builds one and never inserts it), so those
 * reads fed nothing on screen; every real consumer is per-lead: the job-detail
 * hero and Photos tab, the doc preflight's "needs photos" check, the
 * inspection report's photo step, the command palette's thumb.
 *
 * Now the boot reads none, and a lead's photos are fetched the first time a
 * surface for that lead asks:
 *   NBDPhotoCache.ensure([leadId, …]) → Promise (always resolves)
 *   NBDPhotoCache.isLoaded(leadId)    → boolean
 * Requests within a tick are batched into `leadId in [≤30]` queries, run in
 * the SAME two scopes the boot read used (own userId; plus companyId for
 * company_admin / manager / viewer), merged into window._photoCache WITHOUT
 * dropping photos a surface pushed in meanwhile (an upload in flight), and
 * announced with a `nbd:photos-loaded` event ({ detail: { leadIds } }) so the
 * open surface repaints. Account switch → the cache and loaded set reset.
 *
 * Index: `leadId in` + `userId ==` / `companyId ==` is equality-only (index
 * merging; photos also has a (leadId, userId) composite) — tests/firestore-
 * index-coverage-2026-10-04.test.js scans this file.
 *
 * Pure helpers are exported for tests/photo-cache-lazy-2026-10-04.test.js.
 */
(function (root) {
  'use strict';

  var IN_LIMIT = 30;          // Firestore `in` accepts at most 30 values
  var TEAM_ROLES = ['company_admin', 'manager', 'viewer'];

  /** PURE. Split ids into chunks of `n`. */
  function chunk(ids, n) {
    var out = [];
    for (var i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n));
    return out;
  }

  /** PURE. The scopes (as [field, value] pairs) a user's photo reads run in. */
  function scopesFor(uid, claims) {
    if (!uid) return [];
    var c = claims || {};
    var s = [['userId', uid]];
    if (TEAM_ROLES.indexOf(c.role || '') !== -1 && c.companyId) s.push(['companyId', c.companyId]);
    return s;
  }

  /**
   * PURE. Merge fetched photo docs into the cache for the requested lead ids.
   * Every requested id ends with an array (possibly empty); photos already in
   * the bag (e.g. an upload that landed before the read) are kept; a fetched
   * doc replaces a same-id entry. Returns the cache.
   */
  function mergeInto(cache, requestedIds, docs) {
    var byLead = {};
    for (var i = 0; i < requestedIds.length; i++) byLead[requestedIds[i]] = [];
    var seen = {};
    for (var j = 0; j < docs.length; j++) {
      var p = docs[j];
      if (!p || !p.id || seen[p.id] || !Object.prototype.hasOwnProperty.call(byLead, p.leadId)) continue;
      seen[p.id] = true;
      byLead[p.leadId].push(p);
    }
    Object.keys(byLead).forEach(function (leadId) {
      var fetched = byLead[leadId];
      var cur = Array.isArray(cache[leadId]) ? cache[leadId] : [];
      var fetchedIds = {};
      fetched.forEach(function (p) { fetchedIds[p.id] = true; });
      var kept = cur.filter(function (p) { return !p || !p.id || !fetchedIds[p.id]; });
      cache[leadId] = fetched.concat(kept);
    });
    return cache;
  }

  // ── state ────────────────────────────────────────────────────────────
  var loaded = Object.create(null);    // leadId → true once a read finished
  var inflight = Object.create(null);  // leadId → Promise
  var queue = [];
  var waiters = [];
  var timer = null;
  var cacheUid = null;
  var stats = { queries: 0, docs: 0, leads: 0 };

  function resetIfAccountChanged() {
    var uid = (root._user && root._user.uid) || null;
    if (uid === cacheUid) return;
    // First sighting just records the account (keeps anything a surface
    // already pushed); a CHANGE of account drops the previous account's bags.
    if (cacheUid !== null) {
      loaded = Object.create(null);
      inflight = Object.create(null);
      root._photoCache = {};
    }
    cacheUid = uid;
  }

  async function runBatch(ids) {
    var w = root;
    var uid = w._user && w._user.uid;
    var scopes = scopesFor(uid, w._userClaims);
    if (!scopes.length || !w.db || !w.getDocs || !w.query || !w.where || !w.collection) return { ok: false, docs: [] };
    var docs = [];
    for (var c of chunk(ids, IN_LIMIT)) {
      for (var s of scopes) {
        var snap = await w.getDocs(w.query(w.collection(w.db, 'photos'), w.where('leadId', 'in', c), w.where(s[0], '==', s[1])));
        stats.queries++;
        snap.forEach(function (d) { docs.push(Object.assign({ id: d.id }, d.data())); });
      }
    }
    stats.docs += docs.length;
    return { ok: true, docs: docs };
  }

  async function flush() {
    timer = null;
    var ids = queue.splice(0);
    var mine = waiters.splice(0);
    if (!ids.length) { mine.forEach(function (r) { r(); }); return; }
    var uidAtStart = root._user && root._user.uid;
    var res = { ok: false, docs: [] };
    try { res = await runBatch(ids); }
    catch (e) { try { console.warn('[NBDPhotoCache] photo read failed:', e && (e.code || e.message)); } catch (_) {} }
    // The account changed while the read was in flight: drop the result.
    if ((root._user && root._user.uid) === uidAtStart) {
      if (res.ok) {
        if (!root._photoCache) root._photoCache = {};
        mergeInto(root._photoCache, ids, res.docs);
        ids.forEach(function (id) { loaded[id] = true; });
        stats.leads += ids.length;
        try { root.dispatchEvent(new CustomEvent('nbd:photos-loaded', { detail: { leadIds: ids.slice() } })); } catch (_) {}
      }
    }
    ids.forEach(function (id) { delete inflight[id]; });
    mine.forEach(function (r) { r(); });
  }

  /** Load photos for these leads (once each). Resolves when they are in the cache — never rejects. */
  function ensure(leadIds) {
    resetIfAccountChanged();
    var want = [];
    var pending = [];
    (leadIds || []).forEach(function (raw) {
      var id = raw == null ? '' : String(raw);
      if (!id || loaded[id]) return;
      if (inflight[id]) { pending.push(inflight[id]); return; }
      if (want.indexOf(id) === -1) want.push(id);
    });
    if (want.length) {
      var p = new Promise(function (resolve) { waiters.push(resolve); });
      want.forEach(function (id) { inflight[id] = p; queue.push(id); });
      if (!timer) timer = setTimeout(flush, 0);
      pending.push(p);
    }
    return Promise.all(pending).then(function () {});
  }

  function isLoaded(leadId) {
    resetIfAccountChanged();
    return !!loaded[String(leadId)];
  }

  var api = {
    ensure: ensure,
    isLoaded: isLoaded,
    stats: function () { return Object.assign({}, stats); },
    _pure: { chunk: chunk, scopesFor: scopesFor, mergeInto: mergeInto, IN_LIMIT: IN_LIMIT },
  };
  root.NBDPhotoCache = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
