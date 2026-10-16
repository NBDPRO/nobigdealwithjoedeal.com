/**
 * layout-usage.js — "which layouts does the team actually use?" (2026-10-16,
 * layouts idea #13). The audit could not answer it: no event recorded a pick.
 *
 * ANONYMOUS and company-scoped. One counter document per day:
 *   companies/{companyKey}/layoutUsage/{YYYY-MM-DD} = { <layoutId>: <devices that used it> }
 * Each device adds ONE to a layout the first time that layout is on screen that
 * day (remembered in localStorage nbd_layout_used, so a reload never counts
 * twice). No uid, no name, no device id is written: only a layout id and +1.
 * firestore.rules allows exactly that shape (a known layout id, +1, one key per
 * write) from a member of that company, and lets only the owner or an admin
 * read it. Nothing goes into userSettings, so its size budget is untouched.
 *
 * The owner sees the last 7 days in Settings > Appearance > Layouts ("Company
 * default and lock"), and the picker ranks Field, Classic, Focus and Mission
 * first with the rest under "More layouts".
 *
 * Pure half (plan / sumDays / lastDays) is require()-able for tests.
 * Loaded lazily (ScriptLoader bundle 'layoutusage', kicked by today-home.js boot).
 */
(function (root) {
  'use strict';

  var LS_KEY = 'nbd_layout_used';
  var IDS = ['classic', 'field', 'focus', 'mission', 'bento', 'crew', 'island', 'inbox'];
  var ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

  function ymdOf(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  // ── pure ─────────────────────────────────────────────────────────────
  /**
   * Should this device count `id` today? seen: the stored { ymd, ids:[] } (or
   * junk). -> { count: bool, next: { ymd, ids } } — next is what to store.
   */
  function plan(seen, id, nowMs) {
    var day = ymdOf(nowMs);
    var s = seen && typeof seen === 'object' && seen.ymd === day && Array.isArray(seen.ids) ? seen : { ymd: day, ids: [] };
    if (!ID_RE.test(String(id)) || IDS.indexOf(id) === -1) return { count: false, next: s };
    if (s.ids.indexOf(id) !== -1) return { count: false, next: s };
    return { count: true, next: { ymd: day, ids: s.ids.concat([id]) } };
  }
  /** The last n day ids, newest first. */
  function lastDays(nowMs, n) {
    var out = [], d = new Date(nowMs);
    for (var i = 0; i < n; i++) { out.push(ymdOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime())); }
    return out;
  }
  /** docs: [{ <id>: n }] -> [{ id, n }] most used first, known ids only. */
  function sumDays(docs) {
    var t = {};
    (docs || []).forEach(function (d) {
      if (!d || typeof d !== 'object') return;
      IDS.forEach(function (id) { var v = Number(d[id]); if (v > 0 && isFinite(v)) t[id] = (t[id] || 0) + Math.round(v); });
    });
    return Object.keys(t).map(function (id) { return { id: id, n: t[id] }; }).sort(function (a, b) { return b.n - a.n || a.id.localeCompare(b.id); });
  }

  var pure = { plan: plan, lastDays: lastDays, sumDays: sumDays, IDS: IDS, LS_KEY: LS_KEY, ymdOf: ymdOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document || root.NBDLayoutUsage) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root;
  function seen() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; } }
  function remember(v) { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); return true; } catch (_) { return false; } }
  function companyKey() {
    if (typeof w._resolveCompanyKey === 'function') return Promise.resolve(w._resolveCompanyKey()).catch(function () { return null; });
    var c = w._userClaims;
    return Promise.resolve((c && c.companyId) || (w._user && w._user.uid) || null);
  }
  function ready() { return !!(w._user && w._user.uid && w.db && w.doc && w.setDoc && w.increment); }
  function isViewer() { return ((w._userClaims || {}).role || '') === 'viewer'; }

  var inflight = false;
  function record() {
    var E = w.LayoutEngine;
    if (inflight || !E || typeof E.current !== 'function' || !ready() || isViewer()) return;
    var cur = E.current() || {};
    // a 30-second preview is not "used"
    if (!cur.id || cur.source === 'preview') return;
    var p = plan(seen(), cur.id, Date.now());
    if (!p.count) return;
    inflight = true;
    companyKey().then(function (key) {
      if (!key) return false;
      var data = {};
      data[cur.id] = w.increment(1);
      return Promise.resolve(w.setDoc(w.doc(w.db, 'companies', key, 'layoutUsage', p.next.ymd), data, { merge: true }))
        .then(function () { remember(p.next); return true; }, function () { return false; });   // not saved: try again next time
    }).then(function () { inflight = false; }, function () { inflight = false; });
  }
  /** Owner / admin view: the last `days` days summed. -> Promise<[{id, n}] | null> (null = could not read). */
  function lastWeek(days) {
    if (!w.db || !w.doc || !w.getDoc) return Promise.resolve(null);
    return companyKey().then(function (key) {
      if (!key) return null;
      return Promise.all(lastDays(Date.now(), days || 7).map(function (day) {
        return Promise.resolve(w.getDoc(w.doc(w.db, 'companies', key, 'layoutUsage', day))).then(function (s) { return s && s.exists() ? s.data() : {}; });
      })).then(sumDays);
    }).catch(function () { return null; });
  }

  document.addEventListener('layoutchange', function () { setTimeout(record, 1500); });
  var tries = 0;
  (function kick() {
    var E = w.LayoutEngine;
    if (E && E.prefs && E.prefs().hydrated && ready()) { setTimeout(record, 3000); return; }
    if (++tries < 60) setTimeout(kick, 1000);
  })();

  w.NBDLayoutUsage = { record: record, lastWeek: lastWeek };
})(typeof window !== 'undefined' ? window : null);
