/**
 * tests/sw-sweep-lows-2026-11-17.test.js — the /pro service worker's API
 * cache, dead offline-write queue, map-tile matcher, and the hosting
 * Cache-Control of the pages it lists as never-cache (2026-11-17 sweep,
 * findings #26-#29). docs/pro/sw.js runs for real in a vm sandbox (mocked
 * self / caches / fetch), the same harness shape as
 * tests/sw-offline-shell-2026-10-04.test.js; firebase.json is evaluated with
 * tests/lib/hosting-headers.js (last matching block wins per key).
 *
 *   #26 only an allowlist of small public GET endpoints is cached (today:
 *       /api/google-reviews), never a 206 or a video/* body, a failing
 *       cache.put never surfaces, and the cache is renamed so activate()
 *       drops the old unbounded 'nbd-api-v1'. Any other same-origin /api/
 *       GET is left to the browser and stored nowhere.
 *   #27 the unreachable offline write queue + 'sync' replay are gone, and an
 *       offline API answer no longer claims "queued".
 *   #28 every page in the SW's never-cache list goes out no-store.
 *   #29 a same-origin path containing '/tile' is ordinary app code, not a
 *       cache-forever map tile.
 *
 * Run: node tests/sw-sweep-lows-2026-11-17.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { effectiveHeader } = require('./lib/hosting-headers');

const ROOT = path.join(__dirname, '..');
const SW_FILE = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'sw.js'), 'utf8');
const HOSTING = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': no answer in ' + ms + 'ms')), ms))]);
const tick = () => new Promise((r) => setTimeout(r, 20));

const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String(e && e.message || e)); });

const ORIGIN = 'https://www.nobigdealwithjoedeal.com';

// A Cache Storage fake that behaves like the browser where it matters here:
// put() of a 206 rejects (Chrome: "Partial response (status code 206) is
// unsupported"), and `failPut` makes every put reject (quota).
function makeCaches(o) {
  const store = new Map();
  const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      match: async (req) => { const r = m.get(keyOf(req)); return r ? r.clone() : undefined; },
      put: async (req, res) => {
        if (o.failPut) throw new Error('QuotaExceededError');
        if (res.status === 206) throw new TypeError('Partial response (status code 206) is unsupported');
        m.set(keyOf(req), res);
      },
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
  const fetchLog = [];
  const caches = makeCaches(o);
  const idbOpens = [];
  const self = {
    location: { origin: ORIGIN },
    navigator: { onLine: true },
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: async () => [] },
  };
  const fetchImpl = o.fetch || (async (req) => new Response('net:' + (typeof req === 'string' ? req : req.url), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const ctx = {
    self, caches: caches.api, console: { log() {}, warn() {}, error() {} },
    fetch: (req, init) => { fetchLog.push({ url: typeof req === 'string' ? req : req.url, init: init || {} }); return fetchImpl(req, init); },
    Response, Request, URL, Promise, Set, Map, Object, Array, String, Number, JSON, Date, Error, TypeError,
    setTimeout, clearTimeout,
    indexedDB: { open: (name) => { idbOpens.push(name); throw new Error('indexedDB touched'); } },
  };
  vm.createContext(ctx);
  // Expose the never-cache set (a top-level const is not a context property).
  vm.runInContext(SW_FILE + '\n;globalThis.__NO_CACHE_HTML = NO_CACHE_HTML;', ctx, { filename: 'sw.js' });
  return { handlers, fetchLog, caches, ctx, idbOpens };
}

function dispatchFetch(sw, url, method) {
  let responded = null;
  const request = { url: new URL(url, ORIGIN).href, method: method || 'GET', mode: 'cors', clone() { return { text: async () => '{}' }; } };
  sw.handlers.fetch({ request, respondWith: (p) => { responded = Promise.resolve(p); } });
  return responded;
}
function cachedAnywhere(sw, url) {
  const href = new URL(url, ORIGIN).href;
  return [...sw.caches.store.entries()].filter(([, m]) => m.has(href)).map(([n]) => n);
}

(async () => {
  console.log('\n#26 API cache: allowlist only, never 206/video, never throws, renamed');
  {
    const sw = boot();
    const res = dispatchFetch(sw, '/api/storm-report?lat=39.1&lon=-84.5');
    if (res) await within(res, 2000, 'storm-report');
    await tick();
    ok('a non-allowlisted same-origin /api/ GET is left to the browser (no respondWith)', res === null);
    ok('...and is stored in no cache', cachedAnywhere(sw, '/api/storm-report?lat=39.1&lon=-84.5').length === 0, cachedAnywhere(sw, '/api/storm-report?lat=39.1&lon=-84.5').join(','));
  }
  {
    const sw = boot();
    const res = dispatchFetch(sw, '/api/google-reviews');
    ok('the public reviews endpoint is handled by the SW', !!res);
    const body = res ? await (await within(res, 2000, 'reviews')).text() : '';
    await tick();
    ok('...returns the network answer', body.startsWith('net:'), body);
    ok('...and keeps it in the renamed API cache (not nbd-api-v1)', cachedAnywhere(sw, '/api/google-reviews').join(',') === 'nbd-api-v2', cachedAnywhere(sw, '/api/google-reviews').join(','));
  }
  {
    let online = true;
    const sw = boot({ fetch: async () => { if (!online) throw new TypeError('Failed to fetch'); return new Response('{"reviews":[1]}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
    await within(dispatchFetch(sw, '/api/google-reviews'), 2000, 'warm');
    await tick();
    online = false;
    const res = await within(dispatchFetch(sw, '/api/google-reviews'), 2000, 'offline');
    ok('offline, the stored reviews answer', res.status === 200 && (await res.text()) === '{"reviews":[1]}');
  }
  {
    const sw = boot({ fetch: async () => new Response('part', { status: 206, headers: { 'Content-Type': 'application/json', 'Content-Range': 'bytes 0-3/10' } }) });
    const res = await within(dispatchFetch(sw, '/api/google-reviews'), 2000, '206');
    await tick();
    ok('a 206 is passed through to the page', res.status === 206);
    ok('...and never stored', cachedAnywhere(sw, '/api/google-reviews').length === 0);
  }
  {
    const sw = boot({ fetch: async () => new Response('vid', { status: 200, headers: { 'Content-Type': 'video/mp4' } }) });
    const res = await within(dispatchFetch(sw, '/api/google-reviews'), 2000, 'video');
    await tick();
    ok('a video/* body is passed through and never stored', res.status === 200 && cachedAnywhere(sw, '/api/google-reviews').length === 0);
  }
  {
    const sw = boot({ failPut: true });
    const res = await within(dispatchFetch(sw, '/api/google-reviews'), 2000, 'quota');
    await tick();
    ok('a failing cache.put still returns the network answer', res.status === 200 && (await res.text()).startsWith('net:'));
  }
  {
    const sw = boot();
    const old = await sw.caches.api.open('nbd-api-v1');
    await old.put(ORIGIN + '/api/storm-report?x=1', new Response('old user data'));
    let p = Promise.resolve();
    sw.handlers.activate({ waitUntil: (x) => { p = Promise.resolve(x); } });
    await within(p, 2000, 'activate');
    ok('activate() drops the old unbounded nbd-api-v1 cache', !sw.caches.store.has('nbd-api-v1'), [...sw.caches.store.keys()].join(','));
  }

  console.log('\n#27 the dead offline write queue is gone');
  {
    const sw = boot({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    ok('no background-sync listener is registered', typeof sw.handlers.sync === 'undefined');
    ok('no queue/replay functions are defined', typeof sw.ctx.queueOfflineWrite === 'undefined' && typeof sw.ctx.flushOfflineQueue === 'undefined' && typeof sw.ctx.getOfflineDB === 'undefined');
    ok('a non-GET is still never intercepted', dispatchFetch(sw, '/api/google-reviews', 'POST') === null);
    const res = await within(dispatchFetch(sw, '/api/google-reviews'), 2000, 'offline-empty');
    const body = await res.text();
    ok('an offline API miss is a 503 that does not claim anything was queued', res.status === 503 && !/queued/i.test(body), body);
    ok('IndexedDB is never opened by the worker', sw.idbOpens.length === 0, sw.idbOpens.join(','));
  }

  console.log('\n#29 isMapTile matches tile hosts only');
  {
    const sw = boot({ fetch: async () => new Response('js', { status: 200, headers: { 'Content-Type': 'text/javascript' } }) });
    await within(dispatchFetch(sw, '/pro/js/tile-grid.js?v=1'), 2000, 'tile-grid');
    await tick();
    const where = cachedAnywhere(sw, '/pro/js/tile-grid.js?v=1');
    ok('a same-origin /pro/js/tile-grid.js goes through the revalidating asset path, not the tile cache', where.join(',') === 'nbd-cdn-v31', where.join(','));
    const f = sw.fetchLog.find((x) => /tile-grid/.test(x.url));
    ok('...fetched with cache:"no-cache" (revalidated every load)', f && f.init.cache === 'no-cache', JSON.stringify(f && f.init));
    ok('isMapTile: ESRI and OSM tile hosts still match', sw.ctx.isMapTile(new URL('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/1/2/3')) && sw.ctx.isMapTile(new URL('https://tile.openstreetmap.org/1/2/3.png')));
    ok('isMapTile: a same-origin path containing /tile does not', !sw.ctx.isMapTile(new URL(ORIGIN + '/pro/tiles/a.png')) && !sw.ctx.isMapTile(new URL(ORIGIN + '/pro/js/tile-grid.js')));
  }

  console.log('\n#28 hosting: every page the SW never caches goes out no-store');
  {
    const sw = boot();
    const pages = [...sw.ctx.__NO_CACHE_HTML]
      .filter((p) => p !== '/pro/') // the public /pro landing page, not an app page
      .map((p) => p.replace(/\.html$/, ''));
    ok('the never-cache list is read from the worker (control)', pages.length >= 18, String(pages.length));
    for (const p of ['/pro/portal', '/pro/estimate-view', '/pro/analytics', '/pro/leaderboard', '/pro/ask-joe', '/pro/ai-tree', '/pro/ai-tool-finder', '/pro/understand', '/pro/project-codex', '/pro/stripe-success', '/pro/account-erasure']) {
      ok('control: ' + p + ' is in the never-cache list', pages.includes(p));
    }
    const notNoStore = pages.filter((p) => !/\bno-store\b/.test(effectiveHeader(HOSTING, p, 'Cache-Control') || ''));
    ok('every listed page has an effective Cache-Control of no-store', notNoStore.length === 0,
      notNoStore.map((p) => p + ' -> ' + effectiveHeader(HOSTING, p, 'Cache-Control')).join(' | '));
    ok('control: an ordinary marketing page keeps the public 5-minute default', effectiveHeader(HOSTING, '/services/roof-replacement', 'Cache-Control') === 'public, max-age=300');
  }

  await tick();
  ok('no unhandled promise rejections', unhandled.length === 0, unhandled.join(' | '));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
