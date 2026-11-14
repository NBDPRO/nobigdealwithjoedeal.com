// ── Service Worker registration (offline + PWA) ──
// E4: two kill-switches in case a bad SW ships:
//   1. ?nosw=1 on the URL → skips registration + unregisters existing.
//      Drop this in a user's URL bar to unstick them in < 10s.
//   2. Remote kill — if any GET to /pro/nosw.txt returns non-404, we
//      unregister and refuse to register. Deploy that file to kill
//      SW for every user in the next reload.
let nbdDiag; // module-local (globals Tranche 1 — was window.*)
// A new version used to reload unconditionally, wiping a half-typed lead or
// cutting a voice note on a phone (wave-1 field finding #3, 2026-11-14).
// safe-reload.js defers while a modal, typed text or a recording is live.
function reloadForUpdate(reason) {
  if (window.NBDSafeReload) { window.NBDSafeReload.request(reason); return; }
  console.warn('[sw] safe-reload.js missing; reloading without the work-in-progress check');
  window.location.reload();
}
(async function swBootstrap() {
  if (!('serviceWorker' in navigator)) return;
  const params = new URLSearchParams(location.search);
  const urlKill = params.has('nosw');

  // Remote kill — cheap HEAD request; 404 (normal) = SW allowed.
  let remoteKill = false;
  try {
    const r = await fetch('/pro/nosw.txt', { method: 'HEAD', cache: 'no-store' });
    remoteKill = r.ok;
  } catch (e) { /* network flake — fail safe (SW allowed) */ }

  if (urlKill || remoteKill) {
    console.warn('SW kill-switch active (' + (urlKill ? 'url' : 'remote') + ') — unregistering');
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) { try { await r.unregister(); } catch (e) {} }
    // Also nuke caches so stale assets don't hang around.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (e) {}
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/pro/sw.js', { scope: '/pro/' })
      .then(reg => {
        console.log('✓ SW registered:', reg.scope);
        setInterval(() => reg.update(), 60000);
      })
      .catch(err => console.warn('SW registration failed:', err));
  });
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'SW_UPDATE_AVAILABLE') {
      console.log('🔄 New version available:', e.data.version);
      // 2026-11-14: never reload over work in progress (safe-reload.js).
      setTimeout(() => reloadForUpdate('sw-message'), 500);
    }
  });
  // Bug fix 2026-05-05: backup auto-reload path. iOS Safari sometimes
  // drops the SW postMessage when the page is mid-navigation. The
  // `controllerchange` event still fires when the new SW takes over —
  // we treat that as a definitive "new code is live, reload now" signal.
  // In-memory flag prevents loops; the flag resets on every fresh load.
  let _swCtrlReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swCtrlReloaded) return;
    _swCtrlReloaded = true;
    console.log('🔄 SW controller changed — reloading');
    setTimeout(() => reloadForUpdate('controllerchange'), 0);
  });
})();

// ── iOS bfcache reload guard ──
// iOS Safari aggressively caches pages in bfcache when the user swipes
// up to close. On reopen the page is restored without re-running init,
// but the Firebase SDK's WebSocket / long-poll connection is dead — it
// hangs forever instead of rejecting. Symptoms: kanban stuck on yellow
// "loading" dot, D2D save button stuck on "Saving...". Detect bfcache
// restore via pageshow.persisted and force a fresh navigation so every
// in-memory connection is renegotiated.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    console.log('[bfcache] page restored from bfcache — reloading to renegotiate Firestore');
    window.location.reload();
  }
});

// ── iOS background-tab Firestore connection refresh ──
// iOS Safari suspends JS in backgrounded tabs. The Firebase SDK's
// heartbeat timers stop, the server times out the session, and when
// the user returns the SDK keeps using the dead WebSocket without
// noticing. Symptom: "every other time" the kanban opens, getDocs
// hangs or returns nothing. Cycling disableNetwork → enableNetwork
// forces the SDK to drop and rebuild every connection.
//
// Only fires when the tab transitions hidden → visible AFTER the
// dashboard finished its initial load (window._leadsLoaded set).
// Don't fire on tab focus during normal in-page usage.
let _lastVisibilityRefresh = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!window._leadsLoaded) return; // initial load handles itself
  // Throttle to at most once every 30s — iOS fires visibilitychange
  // multiple times during the tab restore animation.
  const now = Date.now();
  if (now - _lastVisibilityRefresh < 30000) return;
  _lastVisibilityRefresh = now;
  if (!window.db || typeof window.disableNetwork !== 'function') return;
  try {
    console.log('[visibility] tab returned to foreground — cycling Firestore connection');
    await window.disableNetwork(window.db);
    await new Promise(r => setTimeout(r, 250));
    await window.enableNetwork(window.db);
    // Reload leads in the background — won't block the UI.
    if (typeof window._loadLeads === 'function') {
      window._loadLeads().catch(e => console.warn('post-visibility loadLeads failed:', e.message));
    }
  } catch (e) {
    console.warn('visibility connection cycle failed:', e.message);
  }
});

// ── Online-event auto-retry ──
// When the device transitions offline → online and leads still haven't
// loaded, fire loadLeads immediately. Pairs with the slow-loop retry
// above so a flaky connection doesn't require the rep to refresh.
// Throttled to once every 5s to avoid retry storms when the OS spams
// online events during connection setup.
let _lastOnlineRetry = 0;
window.addEventListener('online', () => {
  const now = Date.now();
  if (now - _lastOnlineRetry < 5000) return;
  _lastOnlineRetry = now;
  // Skip if already loaded and we have leads — visibilitychange handler covers reconnect refreshes
  if (window._leadsLoaded && (window._leads?.length || 0) > 0) return;
  console.log('[online] connection restored — auto-retrying loadLeads');
  // Reset the slow-loop counter so the full retry budget gets used on the new connection
  window._loadLeadsSlowAttempt = 0;
  window._loadLeadsExhausted = false;
  if (typeof window.loadLeads === 'function') {
    window.loadLeads().catch(e => console.warn('online-retry loadLeads failed:', e.message));
  }
});

// ── Runtime Diagnostic — call nbdDiag() from console ──
nbdDiag = function() {
  const r = {};
  // Auth
  r.user = window._user ? { uid: window._user.uid, email: window._user.email } : null;
  r.plan = window._userPlan || 'unknown';
  r.subscription = window._subscription ? { plan: window._subscription.plan, status: window._subscription.status } : null;
  // Firebase
  r.firebase = { db: !!window.db, auth: !!window.auth, collection: typeof window.collection };
  // Leads
  r.leads = { count: window._leads?.length ?? 0, filteredCount: window._filteredLeads?.length ?? 'null' };
  // Stage system
  r.stages = { keys: window._stageKeys, viewKey: window._currentViewKey, STAGES: window.STAGES?.length };
  // Kanban DOM
  const board = document.getElementById('kanbanBoard');
  r.kanban = { boardExists: !!board, boardChildren: board?.children?.length ?? 0, boardHTML: board?.innerHTML?.length ?? 0 };
  if (window._stageKeys) {
    r.kanban.columns = {};
    window._stageKeys.forEach(k => {
      const body = document.getElementById('kbody-' + k);
      r.kanban.columns[k] = { exists: !!body, cards: body?.querySelectorAll('.k-card')?.length ?? 0 };
    });
  }
  // CRM functions
  r.functions = {
    renderLeads: typeof renderLeads, loadLeads: typeof window._loadLeads,
    buildKanbanColumns: typeof window.buildKanbanColumns,
    initDrawMap: typeof initDrawMap, initMainMap: typeof initMainMap,
    goTo: typeof goTo
  };
  // Drawing tool
  r.drawMap = {
    container: !!document.getElementById('drawMap'),
    containerH: document.getElementById('drawMap')?.offsetHeight ?? 0,
    containerW: document.getElementById('drawMap')?.offsetWidth ?? 0,
    mapObj: typeof drawMap !== 'undefined' && !!drawMap,
    mapInited: typeof mapInited !== 'undefined' ? JSON.stringify(mapInited) : 'undefined',
    leaflet: typeof L !== 'undefined' ? L.version : 'NOT LOADED'
  };
  // View state
  const active = document.querySelector('.view.active');
  r.activeView = active ? active.id : 'none';
  // SW
  r.sw = navigator.serviceWorker?.controller ? 'active' : 'none';
  console.table(r);
  console.log('Full diagnostic:', JSON.stringify(r, null, 2));
  return r;
};

