/**
 * tests/sw-offline-shell-2026-10-04.test.js — docs/pro/sw.js run for real in
 * a vm sandbox (mocked self / caches / fetch), for the installed iPhone app
 * on a roof with bad signal:
 *
 *   - same-origin JS/CSS revalidate (cache:'no-cache' → 304s), never
 *     cache:'reload' (which re-downloaded ~4 MB on every launch)
 *   - a slow network loses to the cached copy after the asset timeout, and
 *     the late response still refreshes the cache
 *   - no cached copy → wait for the network (never a premature 503)
 *   - CACHE_APP_SHELL stores the dashboard/customer shells; an OFFLINE
 *     navigation is answered from them; an ONLINE navigation is never
 *     intercepted (INFRA-1); unknown /pro/ pages offline → /offline.html
 *   - activate() keeps the shells (its auth-gated-HTML purge must not eat
 *     them) and posts SW_UPDATE_AVAILABLE with the bumped version
 *
 * Run: node tests/sw-offline-shell-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'sw.js'), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': no answer in ' + ms + 'ms')), ms))]);

const ORIGIN = 'https://www.nobigdealwithjoedeal.com';

function makeCaches() {
  const store = new Map();   // cacheName -> Map(url -> Response)
  const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      match: async (req) => { const r = m.get(keyOf(req)); return r ? r.clone() : undefined; },
      put: async (req, res) => { m.set(keyOf(req), res); },
      addAll: async (urls) => { urls.forEach((u) => m.set(keyOf(u), new Response('precached ' + u))); },
      keys: async () => [...m.keys()].map((u) => ({ url: u })),
      delete: async (req) => m.delete(keyOf(req)),
    };
  };
  return {
    store,
    api: {
      open,
      keys: async () => [...store.keys()],
      delete: async (n) => store.delete(n),
      match: async (req) => { for (const m of store.values()) { const r = m.get(keyOf(req)); if (r) return r.clone(); } return undefined; },
    },
  };
}

function boot(opts) {
  const o = opts || {};
  const handlers = {};
  const posted = [];
  const fetchLog = [];
  const caches = makeCaches();
  const nav = { onLine: o.onLine !== false };
  const self = {
    location: { origin: ORIGIN },
    navigator: nav,
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => [{ postMessage: (m) => posted.push(m) }],
    },
  };
  const fetchImpl = o.fetch || (async (req, init) => new Response('net:' + (typeof req === 'string' ? req : req.url), { status: 200, headers: { 'Content-Type': 'text/html' } }));
  const ctx = {
    self, caches: caches.api, console: { log() {}, warn() {}, error() {} },
    fetch: (req, init) => { fetchLog.push({ url: typeof req === 'string' ? req : req.url, init: init || {} }); return fetchImpl(req, init); },
    Response, Request, URL, Promise, Set, Map, Object, Array, String, Number, JSON, Date, Error,
    setTimeout, clearTimeout, indexedDB: undefined,
  };
  let src = SRC;
  if (o.assetTimeoutMs) src = src.replace(/const ASSET_NETWORK_TIMEOUT_MS = \d+;/, 'const ASSET_NETWORK_TIMEOUT_MS = ' + o.assetTimeoutMs + ';');
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'sw.js' });
  return { handlers, posted, fetchLog, caches, nav, ctx };
}

// Dispatch a fetch event; resolves to the Response, or null when the SW let
// the browser handle it natively (no respondWith).
function dispatchFetch(sw, url, mode) {
  let responded = null;
  const request = { url: new URL(url, ORIGIN).href, method: 'GET', mode: mode || 'cors' };
  sw.handlers.fetch({ request, respondWith: (p) => { responded = Promise.resolve(p); } });
  return responded;
}
async function install(sw) {
  let p = Promise.resolve();
  sw.handlers.install({ waitUntil: (x) => { p = Promise.resolve(x); } });
  await p;
}
function dispatchMessage(sw, data) {
  let p = Promise.resolve();
  sw.handlers.message({ data, waitUntil: (x) => { p = Promise.resolve(x); } });
  return p;
}

(async () => {
  console.log('\n1. Same-origin JS/CSS: revalidate, do not re-download');
  {
    const sw = boot();
    const res = await within(dispatchFetch(sw, '/pro/js/crm.js?v=9'), 2000, 'asset');
    const f = sw.fetchLog.find((x) => /crm\.js/.test(x.url));
    ok('asset fetch asks with cache:"no-cache" (ETag revalidation → 304)', f && f.init.cache === 'no-cache', JSON.stringify(f && f.init));
    ok('…never cache:"reload" (a full download every launch)', !sw.fetchLog.some((x) => x.init.cache === 'reload'));
    ok('network answer returned and stored for offline', res && (await res.text()).startsWith('net:') && sw.caches.store.get('nbd-cdn-v31').size === 1);
  }

  console.log('\n2. Slow network: the cached copy answers after the timeout');
  {
    let release;
    const slow = new Promise((r) => { release = r; });
    let first = true;
    const sw = boot({
      assetTimeoutMs: 60,
      fetch: async (req) => {
        if (first) { first = false; return new Response('v1', { status: 200 }); }
        await slow; return new Response('v2', { status: 200 });
      },
    });
    await within(dispatchFetch(sw, '/pro/js/app.js?v=1'), 2000, 'warm');
    const t0 = Date.now();
    const res = await within(dispatchFetch(sw, '/pro/js/app.js?v=1'), 1500, 'slow asset');
    const body = await res.text();
    ok('cached copy served when the network is slower than the timeout', body === 'v1' && Date.now() - t0 < 1000, body + ' after ' + (Date.now() - t0) + 'ms');
    release();
    await new Promise((r) => setTimeout(r, 30));
    const again = await sw.caches.api.open('nbd-cdn-v31').then((c) => c.match('/pro/js/app.js?v=1'));
    ok('the late network answer still refreshes the cache for next time', again && (await again.text()) === 'v2');
  }
  {
    let release;
    const slow = new Promise((r) => { release = r; });
    const sw = boot({ assetTimeoutMs: 40, fetch: async () => { await slow; return new Response('late', { status: 200 }); } });
    const p = dispatchFetch(sw, '/pro/js/never-cached.js');
    setTimeout(release, 120);
    const res = await within(p, 1500, 'uncached slow asset');
    ok('no cached copy → waits for the network instead of a 503', res.status === 200 && (await res.text()) === 'late');
  }
  {
    let n = 0;
    const sw = boot({ fetch: async () => { if (n++ === 0) return new Response('ok', { status: 200 }); throw new TypeError('Failed to fetch'); } });
    await within(dispatchFetch(sw, '/pro/css/a.css'), 2000, 'warm css');
    const res = await within(dispatchFetch(sw, '/pro/css/a.css'), 2000, 'offline css');
    ok('network error → cached copy', res.status === 200 && (await res.text()) === 'ok');
  }

  console.log('\n3. Navigations: online untouched, offline from the stored shell');
  {
    const sw = boot({ fetch: async (req) => new Response('<html>SHELL ' + req + '</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "script-src 'self'" } }) });
    await install(sw);
    ok('online navigation is NOT intercepted (INFRA-1)', dispatchFetch(sw, '/pro/dashboard', 'navigate') === null);
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL' });
    const shellFetches = sw.fetchLog.filter((x) => /\/pro\/(dashboard|customer)$/.test(x.url));
    ok('CACHE_APP_SHELL fetches both canonical shells, uncached', shellFetches.length === 2 && shellFetches.every((x) => x.init.cache === 'no-store'), JSON.stringify(shellFetches));
    sw.nav.onLine = false;
    const p = dispatchFetch(sw, '/pro/dashboard.html', 'navigate');
    ok('offline navigation to the dashboard IS answered by the SW', p !== null);
    const res = p && await within(p, 2000, 'offline nav');
    const html = res ? await res.text() : '';
    ok('…with the stored dashboard shell', /SHELL \/pro\/dashboard</.test(html), html.slice(0, 80));
    ok('…carrying its original headers (CSP intact)', res && /script-src/.test(res.headers.get('Content-Security-Policy') || ''));
    const c = await within(dispatchFetch(sw, '/pro/customer?id=abc', 'navigate'), 2000, 'customer nav');
    ok('offline /pro/customer?id=… → the customer shell', /SHELL \/pro\/customer</.test(await c.text()));
    const other = await within(dispatchFetch(sw, '/pro/vault', 'navigate'), 2000, 'other nav');
    ok('offline unknown /pro/ page → /offline.html', /precached \/offline\.html/.test(await other.text()));
    ok('offline navigation outside /pro/ is left to the browser', dispatchFetch(sw, '/roofing', 'navigate') === null);
  }
  {
    const sw = boot({ onLine: false });
    await install(sw);
    const res = await within(dispatchFetch(sw, '/pro/dashboard', 'navigate'), 2000, 'no shell');
    ok('offline with no stored shell → /offline.html, never a hang', res && /precached \/offline\.html/.test(await res.text()));
  }

  console.log('\n4. activate(): shells survive, clients told to update');
  {
    const sw = boot({ fetch: async () => new Response('<html>S</html>', { status: 200 }) });
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL' });
    let done;
    sw.handlers.activate({ waitUntil: (p) => { done = p; } });
    await done;
    const shells = sw.caches.store.get('nbd-appshell-v1');
    ok('the auth-gated-HTML purge leaves the stored shells alone', shells && shells.size === 2, shells && [...shells.keys()].join());
    ok('SW_UPDATE_AVAILABLE posted with the bumped shell version', sw.posted.some((m) => m.type === 'SW_UPDATE_AVAILABLE' && m.version === 'nbd-shell-v32'), JSON.stringify(sw.posted));
    ok('the 4 MB asset cache is NOT renamed (would re-download everything)', /cdn:\s*'nbd-cdn-v31'/.test(SRC));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
