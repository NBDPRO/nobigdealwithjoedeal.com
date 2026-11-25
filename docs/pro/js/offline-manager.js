/**
 * NBD Pro Offline Manager v2.0
 * Client-side offline queue management and UI
 *
 * v2: Online bar replaced with subtle centered pill button in header
 *
 * Handles:
 * - Service worker registration
 * - Online/offline status detection
 * - IndexedDB queue for Firestore writes
 * - UI indicators and toast notifications
 * - Background sync coordination
 */

// safe-reload.js (the deploy-reload guard) is injected, not a page tag: it
// stays off the parse-blocking path and the boot budget's tag count. Until it
// has loaded, an update reloads the old way (reloadForUpdate's fallback).
(function loadSafeReload() {
  try {
    if (window.NBDSafeReload || document.querySelector('script[data-nbd-safe-reload]')) return;
    var s = document.createElement('script');
    s.src = '/pro/js/safe-reload.js?v=3';
    s.async = true;
    s.setAttribute('data-nbd-safe-reload', '1');
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { console.warn('[sw] could not load safe-reload.js:', e && e.message); }
})();
(function() {
  'use strict';

  const DB_NAME = 'nbd-offline-db';
  const DB_STORE = 'pending-writes';
  const DB_VERSION = 1;

  // Audit finding #14: hard cap on queued writes. Without it,
  // `store.add()` eventually throws QuotaExceededError on Safari
  // (~50MB IDB cap per origin) and the toast still says "Saved
  // offline" — silent data loss. 500 items at ~2KB each ≈ 1MB,
  // well under any realistic quota; keeps the cap as a tripwire,
  // not a usage limit.
  const MAX_QUEUE_SIZE = 500;
  // localStorage key used to detect Safari's 7-day storage purge
  // for PWAs (audit finding #5). When the queue grows we bump this
  // counter; on init we compare against actual IDB count and warn
  // the user if IDB lost data while localStorage survived.
  const QUEUE_LAST_KNOWN_KEY = 'nbd_offline_queue_last_known_size';

  let db = null;
  let isOnline = navigator.onLine;
  let swRegistration = null;

  // ─────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────
  async function init() {
    await initIndexedDB();

    // Audit finding #5: Safari WebKit clears IndexedDB after 7 days
    // of PWA inactivity. If localStorage's last-known queue size is
    // > 0 but IDB is empty, we just lost the queue — surface the
    // loss to the user instead of silently resolving.
    try { await detectQueueLoss(); } catch (e) { console.warn('queue-loss check failed', e); }

    // E4 kill-switch (2026-09-14): this is the second of three registration
    // sites for /pro/sw.js — dashboard-sw-bootstrap.js already honored
    // ?nosw=1 and /pro/nosw.txt; this file (loaded by customer.html and
    // login.html) and pages/sw-register.js did not, so the site-wide remote
    // kill and the per-user URL kill (docs/pro/README-killswitch.md)
    // silently only worked on the dashboard. Same two signals, checked once,
    // gating registration only — the rest of init() (online/offline
    // handlers, the status indicator, flushQueue) still needs to run even
    // when the SW itself is killed.
    let swKilled = false;
    if ('serviceWorker' in navigator) {
      try {
        const urlKill = new URLSearchParams(location.search).has('nosw');
        let remoteKill = false;
        try {
          const r = await fetch('/pro/nosw.txt', { method: 'HEAD', cache: 'no-store' });
          remoteKill = r.ok;
        } catch (_) { /* network flake — fail safe (SW allowed) */ }
        swKilled = urlKill || remoteKill;
        if (swKilled) {
          console.warn('[OfflineManager] SW kill-switch active (' + (urlKill ? 'url' : 'remote') + ') — skipping registration');
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) { try { await r.unregister(); } catch (_) {} }
        }
      } catch (_) { /* kill-switch check itself failed — fail safe (SW allowed) */ }
    }

    if ('serviceWorker' in navigator && !swKilled) {
      try {
        // updateViaCache: 'none' forces the browser to bypass its own HTTP
        // cache when fetching sw.js itself, so a deployed SW update is seen
        // on the next page load instead of being pinned for hours by the
        // default 'imports' policy.
        //
        // 2026-09-02: this used to register '/pro/sw.js?v=13' while
        // dashboard-sw-bootstrap.js and pages/sw-register.js register
        // '/pro/sw.js'. A different scriptURL for the same scope is a NEW
        // registration, not an update, so every dashboard ↔ customer/login
        // hop installed a fresh worker → skipWaiting → clients.claim →
        // SW_UPDATE_AVAILABLE / controllerchange → the dashboard's forced
        // reload (dashboard-sw-bootstrap.js:42-57). That was the
        // "dashboard reloads itself" on arrival. The ?v= bust bought
        // nothing updateViaCache:'none' doesn't already guarantee, and
        // window.__NBD_BUILD is assigned nowhere. One URL everywhere; the
        // pin lives in tests/pwa-manifest.test.js.
        swRegistration = await navigator.serviceWorker.register('/pro/sw.js', {
          scope: '/pro/',
          updateViaCache: 'none'
        });
        // Ask the browser to check for a newer SW on every init — cheap,
        // and if there is one it fires controllerchange below which shows
        // the update toast to the user.
        try { swRegistration.update(); } catch (_) {}
        console.log('✓ Service Worker registered');

        navigator.serviceWorker.addEventListener('controllerchange', () => {
          // Bug fix 2026-05-05: previously this only showed a passive
          // toast and the actual reload was driven by a postMessage
          // from the SW's activate handler — keyed by SW shell version
          // in sessionStorage. Because the version string didn't bump
          // each deploy, the once-per-tab flag stayed set forever and
          // every subsequent deploy left users with a dead toast and
          // stale code. We now reload directly on controllerchange for
          // auth-gated pages, gated by a per-page-load in-memory flag
          // so we don't loop. Non-auth pages still get a tappable toast.
          if (isOnAuthGatedPath()) {
            forceReloadOnce('controllerchange');
          } else {
            showUpdateNotification();
          }
        });

        navigator.serviceWorker.addEventListener('message', handleSWMessage);
      } catch (err) {
        console.warn('Service Worker registration failed:', err);
      }
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    createStatusIndicator();

    if (isOnline) {
      flushQueue();
    }
  }

  // Compares the localStorage-tracked queue size to the actual
  // IndexedDB count. Mismatch → IDB was purged (almost always Safari
  // 7-day rule) while localStorage survived. Surface a clear toast.
  async function detectQueueLoss() {
    if (!db) return;
    const lastKnown = Number(localStorage.getItem(QUEUE_LAST_KNOWN_KEY) || '0');
    if (lastKnown <= 0) return;
    const actual = await getQueueCount();
    if (actual < lastKnown) {
      const lost = lastKnown - actual;
      console.warn('offline queue loss detected:', { lastKnown, actual, lost });
      // Sticky banner — a 3s toast vanishes before a contractor in the
      // field ever notices. The banner persists until dismissed.
      showStickyOfflineBanner(
        lost + ' offline ' + (lost === 1 ? 'item was' : 'items were')
        + ' lost (Safari clears offline storage after 7 days of inactivity).'
      );
      // Resync the counter to the new reality so we don't re-warn
      // every page load.
      try { localStorage.setItem(QUEUE_LAST_KNOWN_KEY, String(actual)); } catch (_) {}
    }
  }

  function getQueueCount() {
    return new Promise((resolve) => {
      if (!db) return resolve(0);
      try {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => resolve(0);
      } catch (_) { resolve(0); }
    });
  }

  // ─────────────────────────────────────────────────────────
  // IndexedDB Management
  // ─────────────────────────────────────────────────────────
  function initIndexedDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onerror = () => {
        console.warn('IndexedDB open failed:', req.error);
        reject(req.error);
      };

      req.onsuccess = () => {
        db = req.result;
        resolve();
      };

      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(DB_STORE)) {
          database.createObjectStore(DB_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });
        }
      };
    });
  }

  // ─────────────────────────────────────────────────────────
  // Public API: Queue a Firestore write for offline
  // ─────────────────────────────────────────────────────────
  async function queueWrite(collection, docId, data, method = 'set') {
    if (!db) {
      console.warn('IndexedDB not initialized');
      // Audit finding #14: surface to the user so they don't think
      // it saved. Previously the rejection went only to console.
      showOfflineToast('Cannot save offline — storage unavailable. Reconnect to save.', 'error');
      return Promise.reject(new Error('IndexedDB unavailable'));
    }

    // Size cap (audit #14). Hit the cap → surface a clear error
    // instead of silently letting Safari throw QuotaExceededError
    // somewhere down the line.
    const currentCount = await getQueueCount();
    if (currentCount >= MAX_QUEUE_SIZE) {
      console.warn('offline queue full', currentCount, '/', MAX_QUEUE_SIZE);
      showOfflineToast(
        'Offline queue is full (' + MAX_QUEUE_SIZE + ' items). Reconnect to sync.',
        'error'
      );
      return Promise.reject(new Error('queue-full'));
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);

      const item = {
        collection,
        docId,
        data,
        method,
        timestamp: Date.now(),
        url: `/pro/api/firestore/${collection}/${docId}`,
        status: 'pending'
      };

      const req = store.add(item);

      req.onerror = () => {
        // QuotaExceededError lands here too (despite the size cap
        // above — quota can be tighter than MAX_QUEUE_SIZE if other
        // origins under the same eTLD+1 are also storing data).
        console.warn('Failed to queue write:', req.error && req.error.name, req.error);
        const msg = req.error && req.error.name === 'QuotaExceededError'
          ? 'Browser storage is full. Reconnect to sync, or clear some space.'
          : 'Could not save offline — please retry';
        showOfflineToast(msg, 'error');
        reject(req.error);
      };

      req.onsuccess = () => {
        showOfflineToast('Saved offline — will sync when connected');
        // Audit finding #5: track the post-write size in localStorage
        // so detectQueueLoss() can compare on next boot.
        try {
          localStorage.setItem(QUEUE_LAST_KNOWN_KEY, String(currentCount + 1));
        } catch (_) {}
        resolve(req.result);
      };

      tx.onerror = () => reject(tx.error);
    });
  }

  // ─────────────────────────────────────────────────────────
  // Flush the offline queue
  // ─────────────────────────────────────────────────────────
  // Audit F: re-entry guard. flushQueue() is invoked from three places —
  // init() on boot, handleOnline() on every 'online' event, and the
  // public OfflineManager.flushQueue export. A user toggling
  // airplane mode rapidly (or a flaky cellular handoff) fires multiple
  // 'online' events in quick succession; without a guard each call
  // reads the same getAll() snapshot and sends every queued PATCH to
  // Firestore twice, doubling bandwidth and re-triggering any non-
  // idempotent server-side side effects (audit log entries, drip-queue
  // re-enqueues, webhook fan-out). _flushing is plain in-memory state,
  // so a page reload always re-arms it.
  let _flushing = false;

  function flushQueue() {
    if (!db) return Promise.resolve();
    if (_flushing) return Promise.resolve();
    _flushing = true;

    return new Promise((resolve) => {
      // Wrap so every termination path releases the re-entry guard.
      const done = () => { _flushing = false; resolve(); };
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req = store.getAll();

      req.onerror = () => {
        console.warn('Failed to read queue:', req.error);
        done();
      };

      req.onsuccess = async () => {
        const items = req.result;

        if (items.length === 0) {
          // Sync the localStorage counter to reality (audit #5).
          try { localStorage.setItem(QUEUE_LAST_KNOWN_KEY, '0'); } catch (_) {}
          done();
          return;
        }

        // Audit finding #6: pre-fetch the token ONCE up front. If
        // the user is signed out (or token-refresh fails), bail
        // cleanly — items stay queued for the next online window
        // when auth is healthy. Old code attempted each fetch with
        // a null/stale token, racked up failures, then surfaced
        // none of it to the user.
        const token = await getAuthToken();
        if (!token) {
          console.warn('flushQueue aborted: no auth token (sign-in lost?)');
          // Surface to the user — silent flush-failure with auth
          // loss is the failure mode that turned a 5-minute outage
          // into "where did all my knocks go?".
          showOfflineToast(
            items.length + ' offline ' + (items.length === 1 ? 'item' : 'items')
            + ' waiting to sync — please sign in again',
            'warning'
          );
          done();
          return;
        }

        let synced = 0;
        let failed = 0;
        let authFailures = 0;

        for (const item of items) {
          try {
            const response = await performFirestoreWrite(item, token);

            if (response.ok) {
              await deleteQueueItem(item.id);
              synced++;
            } else {
              failed++;
              if (response.status === 401 || response.status === 403) {
                authFailures++;
              }
            }
          } catch (err) {
            console.warn('Failed to sync item:', err);
            failed++;
          }
        }

        if (synced > 0) {
          showOfflineToast(
            `Synced ${synced} offline ${synced === 1 ? 'item' : 'items'}`,
            'success'
          );
        }

        if (failed > 0) {
          console.warn(`${failed} items failed to sync (auth-related: ${authFailures})`);
          // Audit #6: surface persistent failures. Items that 401/403
          // stay queued (we never deleteQueueItem on a non-ok response)
          // — the user needs to know they should reauthenticate so the
          // next flush can succeed.
          if (authFailures > 0) {
            showOfflineToast(
              authFailures + ' ' + (authFailures === 1 ? 'item' : 'items')
              + ' couldn\'t sync — please sign in again',
              'warning'
            );
          }
        }

        // Sync the counter to the actual remaining queue size so
        // detectQueueLoss() doesn't false-fire on next boot.
        try {
          const remaining = await getQueueCount();
          localStorage.setItem(QUEUE_LAST_KNOWN_KEY, String(remaining));
        } catch (_) {}

        done();
      };

      tx.onerror = () => {
        console.warn('Transaction error:', tx.error);
        done();
      };
    });
  }

  // ─────────────────────────────────────────────────────────
  // Perform actual Firestore write (requires auth token)
  // ─────────────────────────────────────────────────────────
  // Accepts an optional pre-fetched token from flushQueue (avoids one
  // getIdToken(true) per queue item — at 500 items that's 500 round-
  // trips to Firebase Auth). Falls back to fetching its own if called
  // outside the flushQueue path.
  async function performFirestoreWrite(item, preFetchedToken) {
    const token = preFetchedToken || await getAuthToken();

    if (!token) {
      throw new Error('No auth token available');
    }

    const method = item.method || 'set';
    const payload = {
      fields: {
        ...Object.entries(item.data).reduce((acc, [k, v]) => {
          acc[k] = encodeFirestoreValue(v);
          return acc;
        }, {})
      }
    };

    const url = `https://firestore.googleapis.com/v1/projects/${window._project}/databases/(default)/documents/${item.collection}/${item.docId}`;

    const opts = {
      method: method === 'delete' ? 'DELETE' : 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (method !== 'delete') {
      opts.body = JSON.stringify(payload);
    }

    return fetch(url, opts);
  }

  function encodeFirestoreValue(val) {
    if (val === null) return { nullValue: null };
    if (typeof val === 'boolean') return { booleanValue: val };
    if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        return { integerValue: String(val) };
      }
      return { doubleValue: val };
    }
    if (typeof val === 'string') return { stringValue: val };
    if (val instanceof Date) return { timestampValue: val.toISOString() };
    if (Array.isArray(val)) {
      return { arrayValue: { values: val.map(encodeFirestoreValue) } };
    }
    if (typeof val === 'object') {
      return {
        mapValue: {
          fields: Object.entries(val).reduce((acc, [k, v]) => {
            acc[k] = encodeFirestoreValue(v);
            return acc;
          }, {})
        }
      };
    }
    return { stringValue: String(val) };
  }

  // Audit finding #6: get a FRESH ID token every flush. The previous
  // localStorage('_firebase_token') fallback is a footgun — it served
  // a token captured at sign-in time which expires after ~1 hour.
  // Offline queues that survive past expiry would always 401, and
  // the flushQueue catch swallowed the failure into "synced=0,
  // failed=N" with no user-visible signal.
  //
  // Strategy:
  //   1. Force-refresh via getIdToken(true) so a token nearing expiry
  //      is rotated before the flush even starts.
  //   2. Return null on no-user. flushQueue() now treats null as
  //      "abort the flush, items stay queued" rather than discarding.
  async function getAuthToken() {
    if (window._user && typeof window._user.getIdToken === 'function') {
      try {
        return await window._user.getIdToken(/* forceRefresh */ true);
      } catch (e) {
        console.warn('getIdToken failed:', e && e.code, e && e.message);
        return null;
      }
    }
    return null;
  }

  function deleteQueueItem(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.delete(id);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ─────────────────────────────────────────────────────────
  // Service Worker message handler
  // ─────────────────────────────────────────────────────────
  // Auth-gated paths that MUST reload when a new SW claims the page.
  // Matches the NO_CACHE_HTML set in sw.js.
  const AUTH_GATED_PATHS = new Set([
    '/pro/', '/pro/dashboard.html', '/pro/customer.html', '/pro/vault.html',
    '/pro/login.html', '/pro/register.html', '/pro/analytics.html',
    '/pro/leaderboard.html', '/pro/ask-joe.html', '/pro/project-codex.html',
    '/pro/ai-tree.html', '/pro/ai-tool-finder.html', '/pro/understand.html',
    '/pro/stripe-success.html',
  ]);

  function isOnAuthGatedPath() {
    const p = window.location.pathname;
    if (AUTH_GATED_PATHS.has(p)) return true;
    if (p.startsWith('/admin/')) return true;
    return false;
  }

  function handleSWMessage(event) {
    const msg = event.data;

    if (msg.type === 'SW_UPDATE_AVAILABLE') {
      // If we are sitting on an auth-gated page when a new SW activates,
      // the old HTML in the DOM may be running stale JS that no longer
      // matches the deployed Firestore rules / Cloud Functions. Force
      // a hard reload so the user picks up the new shell. Non-auth pages
      // (marketing, public forms) get a soft toast instead.
      if (isOnAuthGatedPath()) {
        forceReloadOnce('sw-message');
      } else {
        showUpdateNotification();
      }
    } else if (msg.type === 'OFFLINE_SYNC_COMPLETE') {
      if (msg.synced > 0) {
        showOfflineToast(
          `Synced ${msg.synced} offline ${msg.synced === 1 ? 'item' : 'items'}`,
          'success'
        );
      }
    }
  }

  // Bug fix 2026-05-05: per-page-load reload guard, replaces the
  // old sessionStorage version-keyed flag (which got stuck because
  // CACHE_VERSIONS.shell rarely changes — once a tab reloaded once,
  // the flag stayed set and every subsequent SW activation just
  // showed a dead toast). This flag is in-memory only, so a fresh
  // page load always re-arms it.
  let _reloadedThisLoad = false;
  function forceReloadOnce(reason) {
    if (_reloadedThisLoad) return;
    _reloadedThisLoad = true;
    console.log('[offline-manager] force reload (' + reason + ')');
    // Defer so the SW's activate event finishes claiming clients
    // before we navigate. iOS Safari is finicky about reload during
    // controllerchange; a 0ms task break avoids the freeze.
    // 2026-11-14: never reload over a half-typed note or a live recording
    // (safe-reload.js shows a tap-to-reload bar instead).
    setTimeout(() => {
      if (window.NBDSafeReload) { window.NBDSafeReload.request(reason); return; }
      console.warn('[offline-manager] safe-reload.js missing; reloading without the work-in-progress check');
      window.location.reload();
    }, 0);
  }

  function showUpdateNotification() {
    // Show the toast AND make it actually clickable. The previous
    // version told the user "tap to refresh" but the toast had no
    // click handler — pure UX bug. Now tapping the toast (or even
    // anywhere on the document while it's visible) triggers the
    // reload. Belt-and-suspenders for iOS PWAs where the SW
    // postMessage path is unreliable.
    if (typeof window.showToast === 'function') {
      window.showToast('Update available — tap to refresh', 'info');
    }
    // Wait one frame so the toast element is in the DOM, then attach
    // a one-shot click handler.
    requestAnimationFrame(() => {
      const t = document.getElementById('toast');
      if (!t) return;
      t.style.cursor = 'pointer';
      const onTap = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        forceReloadOnce('toast-tap');
      };
      t.addEventListener('click', onTap, { once: true });
      t.addEventListener('touchend', onTap, { once: true, passive: false });
    });
  }

  // ─────────────────────────────────────────────────────────
  // Online/Offline handlers
  // ─────────────────────────────────────────────────────────
  function handleOnline() {
    isOnline = true;
    updateStatusIndicator();
    flushQueue();
  }

  function handleOffline() {
    isOnline = false;
    updateStatusIndicator();
  }

  // ─────────────────────────────────────────────────────────
  // Status indicator UI — SUBTLE PILL BUTTON
  // Centered in header, matches existing button aesthetic
  // Green when online, red when offline
  // ─────────────────────────────────────────────────────────
  function createStatusIndicator() {
    // Remove old full-width bar if it exists
    const oldBar = document.getElementById('nbd-offline-status');
    if (oldBar) oldBar.remove();

    // Add styles
    if (!document.getElementById('nbd-offline-styles')) {
      const style = document.createElement('style');
      style.id = 'nbd-offline-styles';
      style.textContent = `
        .nbd-conn-pill {
          display:inline-flex;
          align-items:center;
          gap:5px;
          padding:4px 10px;
          border-radius:20px;
          font-size:10px;
          font-family:'Barlow Condensed',system-ui,-apple-system,sans-serif;
          font-weight:700;
          letter-spacing:.06em;
          text-transform:uppercase;
          border:1px solid transparent;
          cursor:default;
          transition:all .25s ease;
          -webkit-tap-highlight-color:transparent;
          line-height:1;
        }

        .nbd-conn-pill.online {
          background:rgba(16,185,129,.1);
          border-color:rgba(16,185,129,.25);
          color:#10b981;
        }

        .nbd-conn-pill.offline {
          background:rgba(239,68,68,.1);
          border-color:rgba(239,68,68,.3);
          color:#ef4444;
        }

        .nbd-conn-pill.syncing {
          background:rgba(251,191,36,.1);
          border-color:rgba(251,191,36,.25);
          color:#fbbf24;
        }

        .nbd-conn-dot {
          width:6px;
          height:6px;
          border-radius:50%;
          background:currentColor;
          flex-shrink:0;
        }

        .nbd-conn-pill.online .nbd-conn-dot {
          box-shadow:0 0 6px rgba(16,185,129,.5);
        }

        .nbd-conn-pill.offline .nbd-conn-dot {
          animation:nbd-conn-pulse 1.4s ease-in-out infinite;
        }

        .nbd-conn-pill.syncing .nbd-conn-dot {
          animation:nbd-conn-pulse 1s ease-in-out infinite;
        }

        @keyframes nbd-conn-pulse {
          0%,100% { opacity:1; }
          50%     { opacity:.4; }
        }
      `;
      document.head.appendChild(style);
    }

    // Create the pill
    const pill = document.createElement('span');
    pill.id = 'nbd-offline-status';
    pill.className = 'nbd-conn-pill ' + (isOnline ? 'online' : 'offline');
    pill.innerHTML = `<span class="nbd-conn-dot"></span><span class="nbd-conn-text">${isOnline ? 'Online' : 'Offline'}</span>`;

    // Insert into header — between logo and back button / right side
    const header = document.querySelector('header');
    if (header) {
      // Check if header uses flexbox with space-between (logo left, buttons right)
      // Insert pill after the logo or first child
      const logo = header.querySelector('.logo');
      const hright = header.querySelector('.hright');

      if (hright) {
        // Dashboard-style header: logo | [pill] | hright
        header.insertBefore(pill, hright);
      } else if (logo && logo.nextSibling) {
        // Customer-style header: logo | [pill] | back-btn
        logo.parentNode.insertBefore(pill, logo.nextSibling);
      } else {
        // Fallback: append to header
        header.appendChild(pill);
      }
    }

    updateStatusIndicator();
  }

  function updateStatusIndicator() {
    const pill = document.getElementById('nbd-offline-status');
    if (!pill) return;

    const text = pill.querySelector('.nbd-conn-text');

    if (isOnline) {
      pill.className = 'nbd-conn-pill online';
      if (text) text.textContent = 'Online';
    } else {
      pill.className = 'nbd-conn-pill offline';
      if (text) text.textContent = 'Offline';
    }
  }

  // ─────────────────────────────────────────────────────────
  // Offline toast notifications
  // ─────────────────────────────────────────────────────────
  function showOfflineToast(message, type = 'warning') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
      return;
    }

    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      padding:10px 18px; background:${type === 'success' ? '#10b981' : '#ef4444'};
      color:white; border-radius:8px; font-size:12px; font-weight:600;
      z-index:9999; white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,.3);
      animation:nbd-toast-in .25s ease;
    `;

    if (!document.getElementById('nbd-toast-anim')) {
      const s = document.createElement('style');
      s.id = 'nbd-toast-anim';
      s.textContent = `
        @keyframes nbd-toast-in { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
        @keyframes nbd-toast-out { from { opacity:1; } to { opacity:0; transform:translateX(-50%) translateY(8px); } }
      `;
      document.head.appendChild(s);
    }

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'nbd-toast-out .25s ease forwards';
      setTimeout(() => toast.remove(), 250);
    }, 3000);
  }

  // Sticky banner — used for high-signal warnings that must survive
  // the field worker glancing at their phone. Persists until the user
  // taps × or the page reloads. Idempotent: one banner per session.
  function showStickyOfflineBanner(message) {
    if (document.getElementById('nbd-offline-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'nbd-offline-banner';
    banner.style.cssText = [
      'position:fixed','top:0','left:0','right:0',
      'padding:10px 44px 10px 16px',
      'background:#b45309','color:#fff',
      'font-size:13px','font-weight:600',
      'text-align:center','line-height:1.35',
      'z-index:99000','box-shadow:0 2px 10px rgba(0,0,0,.35)',
      'padding-top:calc(10px + env(safe-area-inset-top,0px))'
    ].join(';');
    const label = document.createElement('span');
    label.textContent = '⚠ ' + message;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label','Dismiss offline warning');
    close.style.cssText = 'position:absolute;top:6px;right:8px;background:transparent;border:0;color:#fff;font-size:22px;font-weight:700;cursor:pointer;padding:4px 10px;line-height:1;';
    close.onclick = () => banner.remove();
    banner.appendChild(label);
    banner.appendChild(close);
    document.body.appendChild(banner);
  }

  // ─────────────────────────────────────────────────────────
  // Expose public API
  // ─────────────────────────────────────────────────────────
  const OfflineManager = {
    init,
    queueWrite,
    flushQueue,
    isOnline: () => isOnline,
    getQueueSize: () => {
      if (!db) return 0;
      return new Promise((resolve) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const store = tx.objectStore(DB_STORE);
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
