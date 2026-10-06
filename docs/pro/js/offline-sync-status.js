/**
 * offline-sync-status.js — "N changes waiting to sync" for the installed app.
 *
 * Since 2026-10-04 Firestore runs with a persistent on-phone cache
 * (nbd-auth.js _firestoreCacheChoice): a write made with no signal is stored
 * in IndexedDB and sent when the phone is back online — even after iOS kills
 * the app in between. This module makes that state VISIBLE and keeps the app
 * from claiming more than is true:
 *
 *   - countPending(): how many write batches Firestore is still holding for
 *     this user, read from the SDK's own IndexedDB mutation queue — the one
 *     number that survives an app kill (there is no public SDK API for it).
 *     null when it cannot be known (memory cache, no IndexedDB, blocked).
 *   - a small fixed badge while that number is above zero.
 *   - settle(writePromise): for save handlers. A Firestore write promise only
 *     resolves when the SERVER acknowledges it, so offline an `await`ed save
 *     never finishes and the Save button spins forever. settle() resolves
 *     'synced' on the ack, or 'queued' as soon as the device is offline (or
 *     after a short wait) — the write itself carries on and syncs later.
 *   - toastText(msg, type): a success toast that says "saved" while writes
 *     are pending becomes "Saved on phone — will sync" (window.showToast on
 *     the dashboard and the customer page runs every message through it).
 *
 * Classic script (no SDK import): reaches Firestore through
 * window.NBDFirestoreSync, which nbd-auth.js publishes. Exposed as
 * window.NBDOfflineSync. No inline handlers; styles live in
 * css/offline-sync.css.
 */
(function () {
  'use strict';
  if (window.NBDOfflineSync) return;

  const POLL_MS = 4000;
  const SETTLE_MS = 4000;
  const COUNT_TIMEOUT_MS = 2000;
  const SAVED_ON_PHONE = 'Saved on phone — will sync';

  let _count = null;        // last count read from the mutation queue
  let _hint = 0;            // writes settle() reported as queued, not yet acked
  let _waiting = false;     // a waitForPendingWrites() is in flight
  let _shellAsked = false;

  function _online() {
    return !(typeof navigator !== 'undefined' && navigator.onLine === false);
  }

  function _uid() {
    const u = window._user || (window._auth && window._auth.currentUser) || null;
    return (u && u.uid) || null;
  }

  // The SDK's database for the default app: 'firestore/' + persistenceKey +
  // '/' + projectId + '/main' (firebase-firestore 10.12.2,
  // __PRIVATE_indexedDbStoragePrefix). Batches live in its 'mutations'
  // store, one row per write/batch, removed when the server acknowledges.
  function dbName() {
    const app = window._firebaseApp;
    const pid = app && app.options && app.options.projectId;
    return pid ? 'firestore/[DEFAULT]/' + pid + '/main' : null;
  }

  function cacheMode() {
    try {
      const s = window.NBDFirestoreSync;
      return (s && typeof s.cacheMode === 'function') ? s.cacheMode() : (window.__NBD_FS_CACHE || 'memory');
    } catch (_) { return 'memory'; }
  }

  /**
   * Pending write batches in Firestore's on-phone queue. opts.anyUser counts
   * every account's (sign-out uses it: after signOut there is no uid).
   * Resolves a number, or null when unknowable. Never rejects; never creates
   * the database (an upgrade it would trigger is aborted).
   */
  function countPending(opts) {
    const anyUser = !!(opts && opts.anyUser);
    return new Promise((resolve) => {
      let finished = false;
      const done = (v) => { if (!finished) { finished = true; resolve(v); } };
      setTimeout(() => done(null), COUNT_TIMEOUT_MS);
      if (cacheMode() === 'memory') { done(null); return; }
      const name = dbName();
      const idb = window.indexedDB;
      if (!name || !idb || typeof idb.open !== 'function') { done(null); return; }
      const uid = _uid();
      if (!anyUser && !uid) { done(null); return; }
      let created = false;
      let req;
      try { req = idb.open(name); } catch (_) { done(null); return; }
      req.onupgradeneeded = (e) => {
        // No Firestore database yet: nothing can be pending. Abort so that
        // looking never leaves an empty v1 database for the SDK to trip on.
        created = true;
        try { e.target.transaction.abort(); } catch (_) {}
      };
      req.onblocked = () => done(null);
      req.onerror = () => done(created ? 0 : null);
      req.onsuccess = () => {
        const db = req.result;
        const close = () => { try { db.close(); } catch (_) {} };
        try { db.onversionchange = close; } catch (_) {}
        if (created || !db.objectStoreNames.contains('mutations')) { close(); done(0); return; }
        let n = 0;
        try {
          const tx = db.transaction('mutations', 'readonly');
          const cur = tx.objectStore('mutations').openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            const v = c.value || {};
            if (anyUser || v.userId === uid) n++;
            c.continue();
          };
          tx.oncomplete = () => { close(); done(n); };
          tx.onerror = () => { close(); done(null); };
          tx.onabort = () => { close(); done(null); };
        } catch (_) { close(); done(null); }
      };
    });
  }

  function pending() {
    return Math.max(typeof _count === 'number' ? _count : 0, _hint);
  }

  function _badgeText(n) {
    const what = n > 0
      ? n + ' change' + (n === 1 ? '' : 's') + ' waiting to sync'
      : 'Changes waiting to sync';
    return _online() ? what : what + ' · offline';
  }

  function render() {
    if (typeof document === 'undefined' || !document.body) return;
    let el = document.getElementById('nbdSyncBadge');
    const n = pending();
    const show = n > 0;
    if (!show) { if (el) el.hidden = true; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'nbdSyncBadge';
      el.className = 'nbd-sync-badge';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = '⟳ ' + _badgeText(typeof _count === 'number' && _count > 0 ? _count : n);
    el.classList.toggle('is-offline', !_online());
    // Offline, offline-banner.js pins its notice across the top (above this
    // badge's layer): sit just under it instead of behind it. offsetHeight,
    // not the rect — the banner slides in with a transform.
    const ob = document.getElementById('nbd-offline-banner');
    if (ob && ob.offsetHeight) el.style.setProperty('--nbd-sync-top', (ob.offsetHeight + 6) + 'px');
    else el.style.removeProperty('--nbd-sync-top');
    el.hidden = false;
  }

  function _waitForServer() {
    if (_waiting || !_online()) return;
    const s = window.NBDFirestoreSync;
    if (!s || typeof s.waitForPendingWrites !== 'function') return;
    _waiting = true;
    Promise.resolve().then(() => s.waitForPendingWrites())
      .then(() => { _hint = 0; })
      .catch(() => {})
      .then(() => { _waiting = false; return refresh(); });
  }

  async function refresh() {
    const n = await countPending();
    if (typeof n === 'number') {
      _count = n;
      if (n === 0 && _online()) _hint = 0;
    }
    render();
    if (pending() > 0) _waitForServer();
    return n;
  }

  /**
   * Await a Firestore write the way a save handler should on a phone:
   * 'synced' when the server acknowledged it, 'queued' when the device is
   * offline or the ack has not come within opts.timeoutMs (the write is
   * already in the on-phone queue and will sync by itself). Rejects only if
   * the write is refused before it was reported queued; a refusal AFTER that
   * is told to the rep instead of vanishing.
   */
  function settle(writePromise, opts) {
    const ms = (opts && opts.timeoutMs) || SETTLE_MS;
    return new Promise((resolve, reject) => {
      let finished = false;
      let queued = false;
      const queue = () => {
        if (finished) return;
        finished = true; queued = true; _hint++;
        render();
        resolve('queued');
      };
      Promise.resolve(writePromise).then(() => {
        if (queued) _hint = Math.max(0, _hint - 1);
        if (!finished) { finished = true; resolve('synced'); }
        refresh();
      }, (err) => {
        if (queued) {
          _hint = Math.max(0, _hint - 1);
          try {
            if (typeof window.showToast === 'function') {
              window.showToast('A change saved on this phone was refused when it synced — ' + ((err && (err.code || err.message)) || 'error'), 'error');
            }
          } catch (_) {}
          refresh();
          return;
        }
        if (!finished) { finished = true; reject(err); }
      });
      if (!_online()) queue();
      else setTimeout(queue, ms);
    });
  }

  function toastText(message, type) {
    const msg = String(message == null ? '' : message);
    const t = String(type == null ? '' : type).toLowerCase();
    if (t && t !== 'success' && t !== 'ok') return msg;
    if (!/\bsaved\b/i.test(msg)) return msg;
    // Only a plain claim of success is rewritten — never a warning, a
    // partial, a local-only or a not-saved message.
    if (/\b(not|never|unsaved|failed|couldn|only|draft|screenshot|downloads?|pdf|restored|offline|phone)\b|n[’']t\b/i.test(msg)) return msg;
    if (!_online() || pending() > 0) return SAVED_ON_PHONE;
    return msg;
  }

  // Every page has its own window.showToast (ui.js, toast.js,
  // customer-tasks-ui.js, dashboard-ui-prefs-boot.js), several assigned
  // after this script runs. Wrap whichever is current — calls through
  // window.showToast and bare global showToast() both land here — and
  // re-check on every tick in case a later script replaced it.
  function _wrapToast() {
    const cur = window.showToast;
    if (typeof cur !== 'function' || cur.__nbdSyncWrapped) return;
    const wrapped = function (message, type) {
      try {
        if (message && typeof message === 'object') {
          if (message.message != null) {
            message = Object.assign({}, message, { message: toastText(message.message, message.type || type) });
          }
        } else {
          message = toastText(message, type);
        }
      } catch (_) { /* never block a toast */ }
      return cur.apply(this, [message].concat(Array.prototype.slice.call(arguments, 1)));
    };
    wrapped.__nbdSyncWrapped = true;
    wrapped.__nbdSyncInner = cur;
    window.showToast = wrapped;
  }

  // Store the app shell in the service worker for the next offline launch —
  // once per page, after sign-in, with signal. sw.js CACHE_APP_SHELL.
  function _askForShell() {
    if (_shellAsked || !_online() || !_uid()) return;
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || !navigator.serviceWorker.ready) return;
    _shellAsked = true;
    navigator.serviceWorker.ready.then((reg) => {
      const w = reg && (reg.active || reg.waiting || reg.installing);
      if (w && typeof w.postMessage === 'function') w.postMessage({ type: 'CACHE_APP_SHELL' });
    }).catch(() => { _shellAsked = false; });
  }

  function _tick() {
    _wrapToast();
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    refresh();
    if (!_shellAsked) _askForShell();
  }

  window.NBDOfflineSync = {
    countPending,
    pending,
    refresh,
    settle,
    toastText,
    render,
    dbName,
    SAVED_ON_PHONE,
    _wrapToast,
  };

  _wrapToast();
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('DOMContentLoaded', _wrapToast);
    window.addEventListener('load', _wrapToast);
    window.addEventListener('online', () => { render(); refresh(); });
    window.addEventListener('offline', () => { render(); setTimeout(render, 400); });
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    }
    // First look shortly after boot (the queue a killed app left behind is
    // what Jo needs to see on reopening), then a light poll.
    setTimeout(_tick, 1500);
    setInterval(_tick, POLL_MS);
  }
})();
