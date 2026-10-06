/**
 * NBD Pro Service Worker v1.0
 * Production-grade offline PWA with intelligent caching and background sync
 *
 * Caching Strategies:
 * - App Shell (cache-first): HTML, CSS, JS, fonts
 * - CDN Libraries (cache-first, long TTL): Leaflet, MarkerCluster, leaflet-heat
 * - Map Tiles (cache-first with limit): ESRI tiles, max 500 tiles
 * - Firebase/API (network-first): Firestore REST API, Cloud Functions
 * - Images (stale-while-revalidate): User photos from Firebase Storage
 */

const CACHE_VERSIONS = {
  shell: 'nbd-shell-v32', // v32 (2026-10-04, offline safety): assets revalidate with 304s instead of re-downloading every launch, a 4 s timeout falls back to the cached copy, and an OFFLINE navigation is answered from the app-shell cache below. The byte change is what makes browsers install this worker; the name bump makes activate() post SW_UPDATE_AVAILABLE so open pages reload onto it.
  cdn: 'nbd-cdn-v31',     // deliberately NOT bumped: this cache holds the ~4 MB of app JS/CSS. Renaming it would make every phone download all of it again — the cost this version exists to remove. Its entries are revalidated on every load anyway.
  tiles: 'nbd-tiles-v1',
  api: 'nbd-api-v1',
  images: 'nbd-images-v2',
  // Static HTML shells of the two installed-app pages, stored ONLY at the
  // request of a signed-in page (CACHE_APP_SHELL) and served ONLY to an
  // offline navigation. The shell holds no account data: every customer
  // record comes from Firestore after nbd-auth.js's client-side auth check,
  // which sends a signed-out visitor to login. Kept under synthetic keys
  // (APP_SHELL_KEYS) so the auth-gated-HTML purge in activate() and the
  // online no-cache rule below never apply to — or are weakened by — it.
  appShell: 'nbd-appshell-v1'
};

// Offline navigation → which stored shell answers it. Canonical (cleanUrls)
// paths are fetched, because a redirected Response cannot answer a navigation.
const APP_SHELLS = [
  { key: '/pro/__app-shell__/dashboard', src: '/pro/dashboard', paths: ['/pro/dashboard', '/pro/dashboard.html'] },
  { key: '/pro/__app-shell__/customer', src: '/pro/customer', paths: ['/pro/customer', '/pro/customer.html'] },
];
const APP_SHELL_KEYS = new Set(APP_SHELLS.map((s) => s.key));

// How long a same-origin JS/CSS fetch may take before the cached copy answers.
// One bar of LTE on a roof can hold a request open for a minute; the page's
// boot should not wait on it when a good copy is already on the phone.
const ASSET_NETWORK_TIMEOUT_MS = 4000;

// Auth-gated pages — never cached. A stale shell can render after logout or
// after a policy change, which both leaks state and lets an ex-user see the
// old UI. Every path here falls through to network-first with no cache
// storage on success, and a short offline message on failure.
const NO_CACHE_HTML = new Set([
  '/pro/',
  '/pro/dashboard.html',
  '/pro/customer.html',
  '/pro/vault.html',
  '/pro/login.html',
  '/pro/register.html',
  '/pro/analytics.html',
  '/pro/leaderboard.html',
  '/pro/ask-joe.html',
  '/pro/project-codex.html',
  '/pro/ai-tree.html',
  '/pro/ai-tool-finder.html',
  '/pro/understand.html',
  '/pro/stripe-success.html',
  // GDPR erasure confirmation: hosting rewrite → cloud function. Its
  // response is token-specific and destructive; a cached "already
  // processed" response could leak across users or get replayed.
  '/pro/account-erasure',
  // Homeowner portal: public-by-token HTML shell. The HTML itself
  // isn't sensitive, but we don't want a cached shell outliving a
  // security patch, so treat it the same as other pro pages.
  '/pro/portal.html',
  // Wave 146: customer-facing estimate preview. Same risk profile
  // as portal.html — public-by-token HTML shell that we don't
  // want a cached pre-fix copy of outliving a security patch.
  '/pro/estimate-view.html',
]);

function isAuthGatedHTML(url) {
  if (url.origin !== self.location.origin) return false;
  // Firebase Hosting has cleanUrls:true — incoming /foo.html is rewritten
  // to /foo before serving. So the canonical URL the SW intercepts is the
  // no-.html form. Check BOTH forms so the SW recognizes auth-gated HTML
  // whether the URL was requested as /pro/dashboard or /pro/dashboard.html.
  // Without this, /pro/dashboard fell through to handleAssetRequest, which
  // is network-first but caches successful responses — INCLUDING their CSP
  // headers. After a CSP update the SW kept serving the stale-CSP response
  // from cache on every normal reload; only hard-reset (bypasses SW) saw
  // the new CSP. Root cause of "hard reset is the magic key" + the
  // returning "CSP violations" the user kept seeing after PR #409.
  if (NO_CACHE_HTML.has(url.pathname)) return true;
  if (NO_CACHE_HTML.has(url.pathname + '.html')) return true;
  if (url.pathname.startsWith('/admin/')) return true;
  return false;
}

const OFFLINE_QUEUE_DB_NAME = 'nbd-offline-db';
const OFFLINE_QUEUE_STORE = 'pending-writes';
const SYNC_TAG = 'nbd-sync-queue';

// ─────────────────────────────────────────────────────────
// INSTALL: Precache app shell
// ─────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  // Precache ONLY assets that are never auth-gated: the manifest and the
  // offline fallback page. HTML shells for authenticated pages must never
  // be served from cache — see NO_CACHE_HTML + fetch() handler below.
  event.waitUntil(
    caches.open(CACHE_VERSIONS.shell).then(cache => {
      return cache.addAll([
        '/pro/manifest.json',
        '/offline.html'
      ]).catch(err => {
        console.warn('App shell cache error (non-fatal):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ─────────────────────────────────────────────────────────
// ACTIVATE: Clean up old cache versions + purge any cached
// auth-gated HTML that leaked into the caches from prior
// versions of this SW. Old SW versions used to precache
// `/pro/dashboard.html`, `/pro/customer.html`, `/pro/login.html`
// and the `handleAssetRequest` offline fallback could have
// cached other pro pages. We explicitly delete those entries
// now so a logged-out user can never see a stale shell after
// the upgrade.
// ─────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 1. Delete every cache not in the current version set.
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => {
      const isCurrentVersion = Object.values(CACHE_VERSIONS).includes(name);
      if (!isCurrentVersion) return caches.delete(name);
    }));

    // 2. In every surviving cache, delete any auth-gated HTML that leaked
    //    in before v5 started refusing to store them.
    for (const cacheName of Object.values(CACHE_VERSIONS)) {
      try {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        await Promise.all(requests.map(req => {
          try {
            const u = new URL(req.url);
            if (cacheName === CACHE_VERSIONS.appShell && APP_SHELL_KEYS.has(u.pathname)) return;
            if (isAuthGatedHTML(u)) return cache.delete(req);
          } catch (_) { /* ignore */ }
        }));
      } catch (_) { /* ignore */ }
    }

    // 3. Claim the currently-controlled clients so this SW version takes
    //    over immediately, then tell every client to soft-reload. The
    //    dashboard / customer / vault pages ignore the message unless the
    //    URL is in the auth-gated set, so the marketing pages don't flap.
    await self.clients.claim();
    const clientList = await self.clients.matchAll({ includeUncontrolled: true });
    clientList.forEach(client => {
      client.postMessage({
        type: 'SW_UPDATE_AVAILABLE',
        version: CACHE_VERSIONS.shell,
      });
    });
  })());
});

// ─────────────────────────────────────────────────────────
// FETCH: Route requests to appropriate cache/network handler
// ─────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests (handled by background sync)
  if (request.method !== 'GET') {
    return;
  }

  // ─────────────────────────────────────────────────────────
  // INFRA-1 (estimate-remediation-2026-06-09): NEVER intercept top-level
  // navigations. Piping this SW's streamed Brotli fetch() Response into the
  // navigation consumer intermittently STALLS after ~5.7KB (the <head> only,
  // no <body>) — a hard dashboard boot-wedge reproduced live on prod with the
  // v29 SW as the active controller (readyState stuck 'loading', document.body
  // null, renderer unpaintable; unregistering the SW recovered it). The
  // IDENTICAL handler returns the full ~721KB document in ~250ms when consumed
  // via fetch().text(), so the stall is specific to the navigation pipe, not
  // the network or the server. This is the root cause of the long-running
  // "Ctrl+R won't fix it, only Shift+Ctrl+R does" reports.
  //
  // Auth-gated HTML is ALREADY `no-store` at the HTTP layer (firebase.json:
  // /pro/dashboard, /pro/vault, /pro/customer, /pro/login, …), so letting the
  // browser fetch navigations natively caches nothing new and changes no
  // security property — the no-cache guarantee is unchanged. Sub-resources
  // (JS/CSS network-first, images, tiles, API, offline-write queue) still route
  // through this SW below, so PWA/offline behaviour for assets is preserved.
  //
  // Trade-off: an OFFLINE top-level navigation now shows the browser's default
  // offline page instead of /offline.html. Acceptable for an auth-gated CRM
  // that cannot function offline anyway, and far better than a wedged boot.
  // ─────────────────────────────────────────────────────────
  //
  // OFFLINE exception (2026-10-04). When the device itself reports no network,
  // the native navigation can only fail — Jo reopening the installed app on a
  // roof got the browser's error page instead of his CRM, and every edit he
  // had waiting in Firestore's on-phone queue was out of reach. So an offline
  // /pro/ navigation is answered from the stored app shell (a complete cached
  // Response, not the streamed network pipe INFRA-1 is about); online
  // navigations are still never touched. Lie-fi (onLine true, nothing
  // answers) still gets the native path — the price of never re-arming
  // INFRA-1's wedge on a working connection.
  if (request.mode === 'navigate') {
    if (isDeviceOffline() && url.origin === self.location.origin && url.pathname.startsWith('/pro/')) {
      event.respondWith(handleOfflineNavigation(url));
    }
    return;
  }

  // Skip chrome extensions, external domains out of scope
  if (url.protocol === 'chrome-extension:' || url.origin !== self.location.origin) {
    // Allow cross-origin for CDNs and APIs
    if (isExternalCDN(url)) {
      return event.respondWith(handleCDNRequest(request));
    }
    return;
  }

  // Auth-gated HTML pages: never serve from cache, never store in cache.
  // This prevents logged-out users from seeing stale dashboard/vault shells
  // and kills XSS pivots that rely on cached old code still running after
  // a deploy that patches a sink.
  if (isAuthGatedHTML(url)) {
    event.respondWith(handleAuthGatedHTML(request));
    return;
  }

  // Route based on path/resource type
  if (isMapTile(url)) {
    event.respondWith(handleMapTileRequest(request));
  } else if (isAPIRequest(url)) {
    event.respondWith(handleAPIRequest(request));
  } else if (isImageRequest(url)) {
    event.respondWith(handleImageRequest(request));
  } else if (isJSorCSS(url)) {
    event.respondWith(handleAssetRequest(request, CACHE_VERSIONS.cdn));
  } else {
    event.respondWith(handleAssetRequest(request, CACHE_VERSIONS.shell));
  }
});

// Network-only handler for auth-gated HTML. If the network is unreachable,
// fall back to the /offline.html page (a static, non-authenticated notice).
// The goal is to make it IMPOSSIBLE for a logged-out user to see a cached
// authenticated shell.
async function handleAuthGatedHTML(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    // Defensive: if the server responds with a redirect to /pro/login.html,
    // honour it; otherwise return the network response unchanged.
    return response;
  } catch (e) {
    const cache = await caches.open(CACHE_VERSIONS.shell);
    const offline = await cache.match('/offline.html');
    return offline || new Response('You are offline. Please reconnect to continue.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ─────────────────────────────────────────────────────────
// BACKGROUND SYNC: Replay queued writes on reconnect
// ─────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(flushOfflineQueue());
  }
});

// ─────────────────────────────────────────────────────────
// MESSAGE: Handle client messages (skip-waiting, etc)
// ─────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // A signed-in installed-app page asks for the shells to be (re)stored so a
  // later offline launch has something to open. Only a client of this origin
  // can post here; the shells are the same static files hosting serves to
  // anyone, so no account data is involved.
  if (event.data && event.data.type === 'CACHE_APP_SHELL') {
    event.waitUntil(cacheAppShells());
  }
});

function isDeviceOffline() {
  try { return !!(self.navigator && self.navigator.onLine === false); } catch (_) { return false; }
}

function shellFor(pathname) {
  return APP_SHELLS.find((s) => s.paths.indexOf(pathname) !== -1) || null;
}

async function cacheAppShells() {
  const cache = await caches.open(CACHE_VERSIONS.appShell);
  await Promise.all(APP_SHELLS.map(async (s) => {
    try {
      const res = await fetch(s.src, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok || res.redirected) return;
      // Re-wrap: a Response that went through a redirect, or that still
      // carries its network body stream, must not answer a later navigation.
      const body = await res.blob();
      await cache.put(s.key, new Response(body, { status: 200, statusText: 'OK', headers: res.headers }));
    } catch (_) { /* offline or quota — keep the previous copy */ }
  }));
}

async function handleOfflineNavigation(url) {
  const s = shellFor(url.pathname);
  if (s) {
    try {
      const cache = await caches.open(CACHE_VERSIONS.appShell);
      const hit = await cache.match(s.key);
      if (hit) return hit;
    } catch (_) { /* fall through */ }
  }
  const shell = await caches.open(CACHE_VERSIONS.shell);
  const offline = await shell.match('/offline.html');
  return offline || new Response('You are offline. Please reconnect to continue.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// ═════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════

function isExternalCDN(url) {
  // INFRA-2 (2026-06-10): googleapis.com / gstatic.com are deliberately NOT
  // matched here any more. fonts.googleapis.com serves render-blocking CSS —
  // observed live: that stylesheet request entered handleCDNRequest and never
  // settled (the same URL returned 200 in 291ms outside the browser), and a
  // pending render-blocking stylesheet blocks ALL subsequent script execution,
  // so every /pro page on the profile hung at its loading screen with its JS
  // fully fetched. Fonts gain ~nothing from SW caching (the browser HTTP cache
  // handles them), and firestore.googleapis.com channel GETs must never be
  // answered cache-first. Cross-origin requests not matched here get no
  // respondWith() at all — the browser fetches them natively, so a wedged SW
  // can no longer sit between the page and its fonts or Firestore.
  // unpkg/cdnjs/jsdelivr are no longer matched: the third-party libs they used
  // to serve (Leaflet, Font Awesome, jsPDF, ApexCharts, Chart.js) are now
  // vendored same-origin under /assets/vendor/ and handled by the normal
  // same-origin JS/CSS strategy. Only the map-tile CDNs remain here.
  return url.hostname === 'server.arcgisonline.com' ||
         url.hostname === 'tile.openstreetmap.org';
}

function isMapTile(url) {
  // ESRI satellite tiles, OpenStreetMap, etc.
  return url.hostname === 'server.arcgisonline.com' ||
         url.hostname === 'tile.openstreetmap.org' ||
         url.pathname.includes('/tile');
}

function isAPIRequest(url) {
  // Firestore REST API, Cloud Functions
  return url.hostname.includes('firestore.googleapis.com') ||
         url.hostname.includes('cloudfunctions.net') ||
         url.hostname.includes('firebaseio.com') ||
         url.pathname.includes('/api/');
}

function isImageRequest(url) {
  const path = url.pathname.toLowerCase();
  return /\.(png|jpg|jpeg|gif|webp|svg)$/.test(path);
}

function isJSorCSS(url) {
  const path = url.pathname.toLowerCase();
  return path.endsWith('.js') || path.endsWith('.css');
}

// ─────────────────────────────────────────────────────────
// Wave 124 P0: NETWORK-FIRST for same-origin JS/CSS, with cache
// fallback only when offline.
//
// The previous strategy was stale-while-revalidate — serve cached
// immediately, refresh in background for NEXT load. That's a fine
// performance pattern for static assets on a stable codebase, but
// it CAUSED the user-reported "Ctrl+R doesn't fix it, only
// Shift+Ctrl+R does" bug:
//
//   1. Deploy ships new dashboard.html that calls a new function
//      from crm.js
//   2. User reloads with Ctrl+R
//   3. SW serves NEW dashboard.html (auth-gated, network-first)
//   4. SW serves OLD crm.js from cache (stale-while-revalidate)
//   5. New dashboard.html tries to call function that doesn't
//      exist in old crm.js → silent failure → kanban / map / etc.
//      stuck on loading
//   6. Background refresh updates crm.js for NEXT load — but the
//      current load is already broken
//   7. User does Shift+Ctrl+R, browser bypasses SW entirely,
//      everything fetched fresh, page works again
//
// New behaviour:
//   - Same-origin JS/CSS (our app code): network-first, cache only
//     used when network fails. Guarantees fresh code on every load.
//   - CDN JS/CSS (Leaflet, etc.): unchanged stale-while-revalidate
//     via handleCDNRequest, since CDN libs are version-pinned in
//     the URL itself and never change at the same path.
//
// Trade-off: each Ctrl+R now pays a fetch round-trip per JS file.
// In practice this is ~100-300ms total because HTTP/2 multiplexes
// + most files are tiny + browser-level Cache-Control still applies
// on top of the SW cache. The reliability win is enormous.
//
// Cache fallback is preserved for genuine offline cases — if the
// fetch outright fails (network down, server down), we return the
// cached response so the page can still partially boot.
async function handleAssetRequest(request, cacheName) {
  const cache = await caches.open(cacheName);

  // 2026-10-04: `cache: 'no-cache'`, not 'reload'. 'reload' (Wave 127) told
  // the browser to skip its HTTP cache outright, so every launch of the
  // installed app downloaded every script and stylesheet in full — ~4 MB on
  // a phone, on every open, on one bar of signal. 'no-cache' still always
  // asks the server (fresh code on every load, the Wave 124/127 guarantee),
  // but it sends the ETag (If-None-Match) and an unchanged file comes back as
  // a body-less 304 that the browser fills from its own cache.
  //
  // Bounded: when a cached copy exists and the network has not answered in
  // ASSET_NETWORK_TIMEOUT_MS, the cached copy answers and the fetch carries
  // on in the background to refresh the cache for next time. With no cached
  // copy there is nothing better to give, so we keep waiting.
  const network = fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response.ok) {
      // Update SW cache for offline fallback. Clone before consuming.
      try { cache.put(request, response.clone()); } catch (_) { /* quota */ }
    }
    return response;
  });
  network.catch(() => {});          // handled below; never an unhandled rejection
  let cached;
  try { cached = await cache.match(request); } catch (_) { cached = undefined; }
  if (!cached) {
    try {
      return await network;
    } catch (err) {
      return new Response('Offline — please check connection', { status: 503 });
    }
  }
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ASSET_NETWORK_TIMEOUT_MS); });
  try {
    const winner = await Promise.race([network, timeout]);
    if (winner) return winner;
    return cached;                  // the fetch finishes refreshing the cache on its own
  } catch (err) {
    // Network failed — serve the SW cache so the page degrades instead of
    // hard-crashing offline.
    return cached;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────
// Cache-first for external CDN libraries (Leaflet, etc)
// ─────────────────────────────────────────────────────────
async function handleCDNRequest(request) {
  const cache = await caches.open(CACHE_VERSIONS.cdn);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  // INFRA-2 (2026-06-10): the network path is timeout-bounded. unpkg/cdnjs
  // serve render-blocking CSS (Leaflet et al.), and a respondWith() promise
  // that never settles blocks all subsequent script execution on the page —
  // the same wedge class as the fonts.googleapis.com hang. A bounded failure
  // degrades to the stale cache or a 503, which a <link rel="stylesheet">
  // treats as a load error and unblocks the parser.
  let timer;
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cdn-fetch-timeout')), 10000);
      })
    ]);
    if (response.ok) {
      // cache.put with the clone — the previous cache.add(request) issued a
      // SECOND network fetch for a response we already had in hand.
      try { cache.put(request, response.clone()); } catch (_) { /* quota */ }
    }
    return response;
  } catch (err) {
    // CDN offline or timed out: try stale cache or fail gracefully
    const staleCache = await caches.match(request);
    return staleCache || new Response('CDN unavailable', { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────
// Cache-first (with limit) for map tiles
// Max 500 tiles, evict oldest when full
// ─────────────────────────────────────────────────────────
async function handleMapTileRequest(request) {
  const cache = await caches.open(CACHE_VERSIONS.tiles);
  const cached = await cache.match(request);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Store with metadata for LRU eviction
      const responseClone = response.clone();
      const tile = {
        url: request.url,
        timestamp: Date.now(),
        response: responseClone
      };

      // Check cache size and evict if needed
      const requests = await cache.keys();
      if (requests.length >= 500) {
        // Get oldest tile (simplistic: just delete first one)
        // In production, could track timestamps in IndexedDB
        const oldest = requests[0];
        await cache.delete(oldest);
      }

      cache.put(request, response.clone());
      return response;
    }
    return response;
  } catch (err) {
    // Tile load failed: return cached or placeholder
    const cached = await cache.match(request);
    return cached || new Response('Tile unavailable', { status: 503 });
  }
}

// ─────────────────────────────────────────────────────────
// Network-first for API calls (Firestore, Cloud Functions)
// ─────────────────────────────────────────────────────────
async function handleAPIRequest(request) {
  const cache = await caches.open(CACHE_VERSIONS.api);

  try {
    const response = await fetch(request);

    // Only cache successful reads (not writes)
    if (response.ok && request.method === 'GET') {
      const responseClone = response.clone();
      cache.put(request, responseClone);
    }

    return response;
  } catch (err) {
    // Network failed: try cache, then queue for sync if it's a write
    const cached = await cache.match(request);

    if (cached) {
      return cached;
    }

    // If this is a write (POST/PUT/DELETE), queue it for background sync
    if (request.method !== 'GET') {
      const body = await request.clone().text();
      await queueOfflineWrite(request.url, request.method, body);
    }

    return new Response(JSON.stringify({
      error: 'Offline',
      message: 'Request queued for sync',
      queued: true
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─────────────────────────────────────────────────────────
// Stale-while-revalidate for images
// ─────────────────────────────────────────────────────────
async function handleImageRequest(request) {
  const cache = await caches.open(CACHE_VERSIONS.images);
  const cached = await cache.match(request);

  // Return cached immediately, update in background
  if (cached) {
    // Fire-and-forget update
    fetch(request).then(response => {
      if (response.ok) {
        cache.put(request, response);
      }
    }).catch(() => {});

    return cached;
  }

  // No cache: try network
  try {
    const response = await fetch(request);
    if (response.ok) {
      const responseClone = response.clone();
      cache.put(request, responseClone);
      return response;
    }
    return response;
  } catch (err) {
    // Image offline: return placeholder
    return new Response(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="#ccc"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
}

// ─────────────────────────────────────────────────────────
// IndexedDB: Queue offline writes
// ─────────────────────────────────────────────────────────
function getOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_QUEUE_DB_NAME, 1);

    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) {
        db.createObjectStore(OFFLINE_QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function queueOfflineWrite(url, method, body) {
  try {
    const db = await getOfflineDB();
    const tx = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE);

    store.add({
      url,
      method,
      body,
      timestamp: Date.now()
    });
  } catch (err) {
    console.warn('Failed to queue offline write:', err);
  }
}

async function flushOfflineQueue() {
  try {
    const db = await getOfflineDB();
    const tx = db.transaction(OFFLINE_QUEUE_STORE, 'readonly');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE);
    const items = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });

    let synced = 0;
    let failed = 0;

    for (const item of items) {
      try {
        const opts = {
          method: item.method,
          headers: { 'Content-Type': 'application/json' },
          body: item.body
        };

        const response = await fetch(item.url, opts);

        if (response.ok) {
          // Delete from queue
          const delTx = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite');
          delTx.objectStore(OFFLINE_QUEUE_STORE).delete(item.id);
          synced++;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
      }
    }

    // Notify clients of sync completion
    if (synced > 0) {
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'OFFLINE_SYNC_COMPLETE',
          synced,
          failed
        });
      });
    }
  } catch (err) {
    console.warn('Error flushing offline queue:', err);
  }
}
