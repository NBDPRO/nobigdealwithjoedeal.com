/**
 * tests/sw-tracker-shell-2026-10-21.test.js - the Daily Success tracker as a third offline app shell in docs/pro/sw.js, run for
 * real in a vm sandbox (same harness as sw-offline-shell-2026-10-04). Written from the security review of the proposal:
 *   F1 the dashboard's refresh-all message must NOT touch the tracker (its shell and its ?v= assets must come from one visit)
 *   F2 the existing two-shell expectations keep holding
 *   F5 only a real HTML tracker page is stored; a captive portal's 200 never replaces a good copy
 *   the message payload only SELECTS from the worker's own list, it is never used as a URL
 * Online navigation is never intercepted; offline answers only the exact tracker paths.
 *
 * Run: node tests/sw-tracker-shell-2026-10-21.test.js
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
  const TRACKER = 'https://www.nobigdealwithjoedeal.com/pro/daily-success';
  const KEY = '/pro/__app-shell__/daily-success';
  const PAGE = '<!doctype html><html><head><title>Daily Success — NBD Pro</title></head><body>tracker</body></html>';
  const htmlRes = (body, extra) => new Response(body, Object.assign({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "script-src 'self'" } }, extra || {}));
  const trackerFetch = (body) => async (req) => {
    const u = typeof req === 'string' ? req : req.url;
    return /daily-success/.test(u) ? htmlRes(body === undefined ? PAGE : body) : htmlRes('<html><title>Other</title></html>');
  };
  const appShell = (sw) => sw.caches.store.get('nbd-appshell-v1');
  const stored = async (sw) => { const m = appShell(sw); const r = m && m.get(new URL(KEY, ORIGIN).href); return r ? r.clone().text() : null; };
  const trackerFetches = (sw) => sw.fetchLog.filter((x) => /daily-success/.test(x.url));

  console.log('\n1. the dashboard\'s refresh-all message never touches the tracker (F1: shell and assets must come from one visit)');
  {
    const sw = boot({ fetch: trackerFetch() });
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL' });
    ok('default message stores exactly the dashboard and customer shells', appShell(sw) && appShell(sw).size === 2 && !(await stored(sw)), appShell(sw) && [...appShell(sw).keys()].join());
    ok('...and makes no request for the tracker', trackerFetches(sw).length === 0);
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL', keys: null });
    ok('keys:null is the default too', trackerFetches(sw).length === 0);
  }

  console.log('\n2. the tracker asks for its own shell by key');
  {
    const sw = boot({ fetch: trackerFetch() });
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL', keys: [KEY] });
    ok('stored: the tracker page under its synthetic key', (await stored(sw)) === PAGE);
    ok('only the tracker was fetched (not dashboard / customer), uncached and same-origin', sw.fetchLog.length === 1 && /daily-success$/.test(sw.fetchLog[0].url) && sw.fetchLog[0].init.cache === 'no-store' && sw.fetchLog[0].init.credentials === 'same-origin', JSON.stringify(sw.fetchLog));
    const both = boot({ fetch: trackerFetch() });
    await dispatchMessage(both, { type: 'CACHE_APP_SHELL', keys: ['/pro/__app-shell__/dashboard', KEY] });
    ok('keys can name several shells', appShell(both).size === 2 && !!(await stored(both)));
  }

  console.log('\n3. a hostile or malformed message stores and fetches nothing (the payload only SELECTS)');
  for (const [label, data] of [
    ['an external URL as a key', { type: 'CACHE_APP_SHELL', keys: ['https://evil.test/x'] }],
    ['a path outside the shell list', { type: 'CACHE_APP_SHELL', keys: ['/pro/vault'] }],
    ['a traversal-looking key', { type: 'CACHE_APP_SHELL', keys: ['/pro/__app-shell__/../vault'] }],
    ['keys that are not an array', { type: 'CACHE_APP_SHELL', keys: KEY }],
    ['an empty list', { type: 'CACHE_APP_SHELL', keys: [] }],
    ['an unknown message type', { type: 'CACHE_EVERYTHING', keys: [KEY] }],
    ['no data at all', undefined],
  ]) {
    const sw = boot({ fetch: trackerFetch() });
    await dispatchMessage(sw, data);
    const n = appShell(sw) ? appShell(sw).size : 0;
    ok(label + ' -> nothing stored, nothing fetched (a keys-less default message is the only one that fetches)', n === 0 && sw.fetchLog.length === 0 || (label === 'keys that are not an array' && n === 2), label + ': stored ' + n + ', fetched ' + sw.fetchLog.length);
  }

  console.log('\n4. only a real tracker page is stored (F5), and a good copy survives a bad answer');
  {
    const cases = [
      ['a 500', () => new Response('boom', { status: 500, headers: { 'Content-Type': 'text/html' } })],
      ['a 403', () => new Response('no', { status: 403, headers: { 'Content-Type': 'text/html' } })],
      ['a redirected response', () => { const r = htmlRes(PAGE); Object.defineProperty(r, 'redirected', { value: true }); return r; }],
      ['JSON instead of HTML', () => new Response('{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json' } })],
      ['HTML that is not the tracker (a captive portal 200)', () => htmlRes('<html><title>Wi-Fi login</title></html>')],
      ['the right text served as text/plain (the marker alone is not enough)', () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/plain' } })],
      ['an empty body', () => htmlRes('')],
    ];
    for (const [label, mk] of cases) {
      const good = boot({ fetch: trackerFetch() });
      await dispatchMessage(good, { type: 'CACHE_APP_SHELL', keys: [KEY] });
      const sw = good;
      sw.ctx.fetch = (req) => { sw.fetchLog.push({ url: typeof req === 'string' ? req : req.url, init: {} }); return Promise.resolve(mk()); };
      await dispatchMessage(sw, { type: 'CACHE_APP_SHELL', keys: [KEY] });
      ok(label + ': the previous good copy is kept', (await stored(sw)) === PAGE);
      const fresh = boot({ fetch: async () => mk() });
      await dispatchMessage(fresh, { type: 'CACHE_APP_SHELL', keys: [KEY] });
      ok(label + ': and with nothing stored yet it stores nothing', !(await stored(fresh)));
    }
    const ok2 = boot({ fetch: trackerFetch(PAGE.replace('Daily Success — NBD Pro', 'Daily Success')) });
    await dispatchMessage(ok2, { type: 'CACHE_APP_SHELL', keys: [KEY] });
    ok('control: a real page with a slightly different title suffix is still accepted (marker is the prefix)', !!(await stored(ok2)));
    const net = boot({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await dispatchMessage(net, { type: 'CACHE_APP_SHELL', keys: [KEY] });
    ok('control: a network error stores nothing and does not throw', !(await stored(net)));
  }

  console.log('\n5. navigation: online untouched, offline answered from the stored tracker shell');
  {
    const sw = boot({ fetch: trackerFetch() });
    await install(sw);
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL', keys: [KEY] });
    ok('ONLINE navigation to the tracker is not intercepted (the page always comes from hosting)', dispatchFetch(sw, '/pro/daily-success', 'navigate') === null);
    sw.nav.onLine = false;
    for (const u of ['/pro/daily-success', '/pro/daily-success.html', '/pro/daily-success/', '/pro/daily-success?x=1#top']) {
      const p = dispatchFetch(sw, u, 'navigate');
      const r = p && await within(p, 2000, 'offline nav ' + u);
      ok('offline ' + u + ' -> the stored tracker shell, headers intact', !!r && (await r.text()) === PAGE && /script-src/.test(r.headers.get('Content-Security-Policy') || ''));
    }
    for (const u of ['/pro/daily-success/js/app.js', '/pro/daily-success/anything']) {
      const r = await within(dispatchFetch(sw, u, 'navigate'), 2000, 'nested nav');
      ok('offline navigation to ' + u + ' is NOT the shell (exact paths only)', /precached \/offline\.html/.test(await r.text()));
    }
  }
  {
    const sw = boot({ onLine: false });
    await install(sw);
    const r = await within(dispatchFetch(sw, '/pro/daily-success', 'navigate'), 2000, 'no shell');
    ok('offline with no stored tracker shell -> /offline.html, never a hang', /precached \/offline\.html/.test(await r.text()) && !(await stored(sw)));
  }

  console.log('\n6. activate() and the no-cache list');
  {
    const sw = boot({ fetch: trackerFetch() });
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL', keys: [KEY] });
    await dispatchMessage(sw, { type: 'CACHE_APP_SHELL' });
    const stray = await sw.caches.api.open('nbd-shell-v32');
    await stray.put('/pro/daily-success.html', htmlRes(PAGE));
    let done;
    sw.handlers.activate({ waitUntil: (p) => { done = p; } });
    await done;
    ok('the tracker shell survives activate() (alongside dashboard and customer)', appShell(sw).size === 3 && !!(await stored(sw)));
    ok('a stray HTML copy of the tracker in the ordinary asset cache is purged (it is stored only as the shell)', !(await (await sw.caches.api.open('nbd-shell-v32')).match('/pro/daily-success.html')));
  }
  {
    const online = boot({ fetch: trackerFetch() });
    await within(dispatchFetch(online, '/pro/daily-success.html', 'cors'), 2000, 'subresource fetch');
    const kept = [...online.caches.store.entries()].some(([name, m]) => name !== 'nbd-appshell-v1' && [...m.keys()].some((k) => /daily-success\.html/.test(k)));
    ok('a plain (non-navigation) fetch of the tracker page is not kept in the asset caches', !kept);
  }

  console.log('\n7. the pieces that must not move');
  {
    ok('the shell version name is not bumped (the byte change installs the worker; the 4 MB cache name is pinned elsewhere)', /shell:\s*'nbd-shell-v32'/.test(SRC) && /cdn:\s*'nbd-cdn-v31'/.test(SRC));
    ok('the tracker entry is request-only and has a marker', /onRequestOnly: true, marker: '<title>Daily Success'/.test(SRC));
    const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
    ok('the tracker loads the worker registration helper (kill switch honoured) and its own offline-shell script, deferred, no inline script', /<script src="\/pro\/js\/pages\/sw-register\.js" defer><\/script>/.test(html) && /<script src="\/pro\/daily-success\/js\/offline-shell\.js\?v=1" defer><\/script>/.test(html));
    const js = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'offline-shell.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok('the script posts only the tracker key, only when online and controlled', /type: 'CACHE_APP_SHELL', keys: \[KEY\]/.test(js) && /navigator\.onLine === false\) return/.test(js) && /serviceWorker\.controller/.test(js) && /var KEY = '\/pro\/__app-shell__\/daily-success'/.test(js));
    ok('it never sends a URL, account data or storage contents', !/localStorage|sessionStorage|fetch\(|XMLHttpRequest|uid|token/i.test(js));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
