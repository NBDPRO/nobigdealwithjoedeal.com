#!/usr/bin/env node
/**
 * tests/route-drive-2026-10-16.test.js — real drive times (OSRM), with the
 * routing service MOCKED throughout. Nothing here reaches the network.
 *
 *   A. functions/route-drive-logic.js: stop validation, the clip box, the
 *      cache key (a hash, never a coordinate), shaping the proxy's reply
 *   B. functions/route-drive.js routeFor(): memory + Firestore cache (legs
 *      only, no geometry, no coordinates), the service down -> { ok: false },
 *      not configured, and nothing it logs mentions a stop
 *   C. docs/pro/js/route-drive.js: decoding the polyline, the answer, the
 *      12 s timeout -> { ok: false, reason: 'timeout' }, the 10-minute memo,
 *      the sample account never calls the server
 *   D. the Next stop card: "Calculating drive time…", then real minutes with
 *      no "(est.)", or the estimate WITH "(est.)" when routing fails
 *   E. routing/osrm/proxy.py against a fake OSRM: POST in, GET to OSRM, the
 *      clip box, bad input, and not one byte written to its logs (skipped
 *      when no python3 is on PATH, which CI always has)
 *   F. wiring: the callable is exported, App Check + rate limit, the bundle
 *      and Mission load route-drive.js, Mission draws the road geometry,
 *      the OSM attribution, the BBOX agrees in all three places
 *
 * Run: node tests/route-drive-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); failed++; fails.push(label); }
}

// Polyline6 encoder (test side only) to round-trip the client decoder.
function enc6(points) {
  let out = '', pl = 0, pg = 0;
  const one = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lng] of points) { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); out += one(a - pl) + one(b - pg); pl = a; pg = b; }
  return out;
}

const CINCY = { lat: 39.1031, lng: -84.512 }, FLORENCE = { lat: 38.9989, lng: -84.6266 }, LEX = { lat: 38.0406, lng: -84.5037 };

(async () => {
  console.log('\nA. route-drive-logic');
  const L = require(path.join(ROOT, 'functions/route-drive-logic.js'));
  {
    ok('two stops in the box are clean', L.cleanStops([CINCY, FLORENCE]).ok === true);
    ok('one stop is invalid', L.cleanStops([CINCY]).reason === 'invalid');
    ok('26 stops are invalid', L.cleanStops(Array(26).fill(CINCY)).reason === 'invalid');
    ok('a string coordinate is invalid', L.cleanStops([{ lat: '39.1', lng: -84.5 }, FLORENCE]).reason === 'invalid');
    ok('Columbus is outside the routed area', L.cleanStops([CINCY, { lat: 39.96, lng: -82.99 }]).reason === 'outside');
    ok('Lexington is inside it', L.cleanStops([CINCY, LEX]).ok === true);
    const k1 = L.cacheKey([CINCY, FLORENCE], false), k2 = L.cacheKey([{ lat: 39.10312, lng: -84.51204 }, FLORENCE], false);
    ok('the cache key is a sha256 hex, the same within ~11 m', /^[0-9a-f]{64}$/.test(k1) && k1 === k2);
    ok('…and differs with geometry, and holds no coordinate', k1 !== L.cacheKey([CINCY, FLORENCE], true) && !/39|84/.test(k1.replace(/[0-9a-f]{64}/, '')));
    ok('the proxy body is [lng, lat] pairs', JSON.stringify(L.proxyBody([CINCY, FLORENCE], true)) === JSON.stringify({ coords: [[-84.512, 39.1031], [-84.6266, 38.9989]], geometry: true }));
    const s = L.shapeResult({ ok: true, legs: [{ sec: 1290, m: 21500 }], sec: 1290, m: 21500, geometry: 'abc' }, 1);
    ok('shapeResult: minutes, miles, totals, geometry', s.ok && s.legs[0].min === 22 && s.legs[0].mi === 13.4 && s.min === 22 && s.mi === 13.4 && s.geometry === 'abc', JSON.stringify(s));
    ok('shapeResult: a leg count mismatch is not ok', L.shapeResult({ ok: true, legs: [] }, 1).ok === false);
    ok('shapeResult: the proxy reason passes through only when it is a plain code', L.shapeResult({ ok: false, reason: 'outside' }, 1).reason === 'outside' && L.shapeResult({ ok: false, reason: '<b>x</b>' }, 1).reason === 'no_route');
  }

  console.log('\nB. routeFor (functions/route-drive.js)');
  {
    const RD = require(path.join(ROOT, 'functions/route-drive.js'))._internal;
    const store = {};
    const db = { collection: () => ({ doc: (id) => ({ get: async () => ({ exists: id in store, data: () => store[id] }), set: async (v) => { store[id] = v; } }) }) };
    let calls = 0, lastReq = null;
    const client = async () => ({ request: async (o) => { calls++; lastReq = o; return { data: { ok: true, legs: [{ sec: 600, m: 9000 }], sec: 600, m: 9000, geometry: o.data.geometry ? enc6([[39.1, -84.5], [39.0, -84.6]]) : null } }; } });
    RD.memClear();
    const r1 = await RD.routeFor({ stops: [CINCY, FLORENCE] }, { db, now: 1e12, url: 'https://osrm.test', client });
    ok('first ask goes to the service: POST /v1/route with [lng,lat] pairs', r1.ok && calls === 1 && lastReq.method === 'POST' && lastReq.url === 'https://osrm.test/v1/route' && lastReq.data.coords[0][0] === -84.512, JSON.stringify(lastReq));
    ok('…10 minutes, 5.6 mi', r1.legs[0].min === 10 && r1.legs[0].mi === 5.6);
    await new Promise((r) => setImmediate(r));
    const docs = Object.keys(store);
    ok('Firestore keeps legs and totals only, under a hash id: no stop, no geometry', docs.length === 1 && /^[0-9a-f]{64}$/.test(docs[0]) &&
      JSON.stringify(Object.keys(store[docs[0]]).sort()) === JSON.stringify(['atMs', 'expireAtMs', 'legs', 'mi', 'min']), JSON.stringify(store));
    const r2 = await RD.routeFor({ stops: [CINCY, FLORENCE] }, { db, now: 1e12 + 1000, url: 'https://osrm.test', client });
    ok('second ask comes from memory (no service call)', r2.ok && r2.cached === true && calls === 1);
    RD.memClear();
    const r3 = await RD.routeFor({ stops: [CINCY, FLORENCE] }, { db, now: 1e12 + 2000, url: 'https://osrm.test', client });
    ok('a cold instance answers from Firestore', r3.ok && r3.cached === true && calls === 1);
    const r4 = await RD.routeFor({ stops: [CINCY, FLORENCE], geometry: true }, { db, now: 1e12 + 3000, url: 'https://osrm.test', client });
    ok('a geometry ask never reads Firestore (no geometry there): it asks the service', r4.ok && typeof r4.geometry === 'string' && calls === 2);
    const down = async () => ({ request: async () => { const e = new Error('503'); e.response = { status: 503 }; throw e; } });
    RD.memClear();
    const r5 = await RD.routeFor({ stops: [CINCY, LEX] }, { db: null, now: 1, url: 'https://osrm.test', client: down });
    ok('service down -> { ok: false, reason: "unavailable" } (the browser keeps its estimate)', r5.ok === false && r5.reason === 'unavailable', JSON.stringify(r5));
    const r6 = await RD.routeFor({ stops: [CINCY, LEX] }, { db: null, now: 1, url: '', client });
    ok('no OSRM_URL -> not_configured, no call', r6.ok === false && r6.reason === 'not_configured');
    const r7 = await RD.routeFor({ stops: [CINCY, { lat: 41.5, lng: -81.7 }] }, { db: null, now: 1, url: 'https://osrm.test', client });
    ok('outside the area -> outside, no call', r7.ok === false && r7.reason === 'outside' && calls === 2);
    let threw = null;
    try { await RD.routeFor({ stops: 'x' }, { db: null, now: 1, url: 'https://osrm.test', client }); } catch (e) { threw = e; }
    ok('garbage input is invalid-argument', threw && threw.code === 'invalid-argument');
    const src = read('functions/route-drive.js');
    const logs = src.match(/logger\.\w+\([^;]*\)/g) || [];
    ok('every log line carries a status only, never data / stops / coords', logs.length >= 1 && logs.every((l) => !/stops|data\b|coords|lat|lng|clean/.test(l)), logs.join(' | '));
  }

  console.log('\nC. the browser client (docs/pro/js/route-drive.js)');
  {
    const RD = require(path.join(ROOT, 'docs/pro/js/route-drive.js'));
    const pts = [[39.1031, -84.512], [39.05, -84.55], [38.9989, -84.6266]];
    const dec = RD.decodePolyline6(enc6(pts));
    ok('polyline6 decodes back to the points', dec.length === 3 && dec.every((p, i) => Math.abs(p[0] - pts[i][0]) < 1e-6 && Math.abs(p[1] - pts[i][1]) < 1e-6), JSON.stringify(dec));
    let n = 0;
    RD._setCaller(async (d) => { n++; return { data: { ok: true, legs: [{ min: 22, mi: 13.4 }], min: 22, mi: 13.4, geometry: enc6(pts) } }; });
    const a = await RD.get([CINCY, FLORENCE], { geometry: true });
    ok('an answer: legs, totals and the road path', a.ok && a.legs[0].min === 22 && a.path.length === 3, JSON.stringify(a).slice(0, 200));
    const b = await RD.get([CINCY, FLORENCE], { geometry: true });
    ok('asked again within 10 minutes: no second call', b.ok && n === 1);
    RD._setCaller(() => new Promise(() => {}));
    RD._setTimeoutMs(50);
    const c = await RD.get([CINCY, LEX]);
    ok('no answer in time -> { ok: false, reason: "timeout" }', c.ok === false && c.reason === 'timeout');
    RD._setCaller(async () => { throw new Error('offline'); });
    const d = await RD.get([CINCY, LEX, FLORENCE]);
    ok('a failed call -> { ok: false } (never rejects)', d.ok === false);
    RD._setCaller(async () => ({ data: { ok: true, legs: [{ min: 'x', mi: 1 }] } }));
    ok('a malformed answer -> { ok: false }', (await RD.get([LEX, FLORENCE])).ok === false);
    ok('fewer than two stops: no call', (await RD.get([CINCY])).reason === 'invalid');
    const src = read('docs/pro/js/route-drive.js');
    ok('the sample account never calls the server', /__NBD_DEMO__[\s\S]{0,80}reason: 'sample'/.test(src));
    ok('the timeout is 12 seconds', /var TIMEOUT_MS = 12000;/.test(src));
    RD._setTimeoutMs(12000);
  }

  console.log('\nD. the Next stop card');
  {
    const RP = require(path.join(ROOT, 'docs/pro/js/layouts/routeplan.js'));
    function card(routeDrive) {
      const home = { id: 'homeNextStop', hidden: true, firstChild: null, getAttribute: () => null };
      Object.defineProperty(home, 'innerHTML', { set(v) { this._h = v; this.firstChild = v ? {} : null; }, get() { return this._h || ''; } });
      const listeners = {};
      const NOW = Date.now();
      const win = {
        _leadsLoaded: true, _leads: [{ id: 'L1', lat: 39.0, lng: -84.6 }], _companyProfile: {},
        NBDToday: { compute: () => ({ appointments: [{ key: 'a1', sortMs: NOW + 25 * 60000, allDay: false, timeLabel: '2:00 pm', name: 'Dana Smith', address: '12 Elm St, Burlington, KY', phone: '8595550100', leadId: 'L1' }] }), appointmentRows: () => [], appointmentsFailed: () => false },
        NBDTodayPlan: { collectTodayItems: () => [] }, NBDRoutePlan: RP, NBDRouteDrive: routeDrive,
        addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); },
      };
      const doc = { hidden: false, getElementById: (id) => (id === 'homeNextStop' ? home : null), querySelectorAll: () => [], addEventListener: (k, f) => { (listeners['doc:' + k] = listeners['doc:' + k] || []).push(f); }, body: {} };
      win.document = doc;
      const ctx = {
        window: win, document: doc, console, Date, JSON, Math, String, Number, Array, Object, Promise, isFinite, encodeURIComponent,
        navigator: { userAgent: 'iPhone', permissions: { query: () => Promise.resolve({ state: 'granted' }) }, geolocation: { getCurrentPosition: (f) => f({ coords: { latitude: 39.1, longitude: -84.51 } }) } },
        setTimeout: (f) => { f(); return 1; }, setInterval: () => 1, clearTimeout() {},
      };
      win.navigator = ctx.navigator;
      vm.createContext(ctx);
      vm.runInContext(read('docs/pro/js/next-stop.js'), ctx);
      return { win, home };
    }
    let resolveIt;
    const pending = { get: () => new Promise((r) => { resolveIt = r; }) };
    const c1 = card(pending);
    c1.win.NBDNextStop.render();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok('while routing is asked: "Calculating drive time…"', /Calculating drive time…/.test(c1.home.innerHTML), c1.home.innerHTML.slice(0, 500));
    resolveIt({ ok: true, legs: [{ min: 23, mi: 14.2 }], min: 23, mi: 14.2 });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok('then the real road time, without "(est.)"', /About 23 min drive · 14\.2 mi<\/span>/.test(c1.home.innerHTML) && !/\(est\.\)/.test(c1.home.innerHTML), c1.home.innerHTML.slice(0, 500));
    const c2 = card({ get: () => Promise.resolve({ ok: false, reason: 'timeout' }) });
    c2.win.NBDNextStop.render();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok('routing failed or timed out: the straight-line estimate, labelled "(est.)"', /About \d+ min drive · [\d.]+ mi \(est\.\)/.test(c2.home.innerHTML), c2.home.innerHTML.slice(0, 500));
  }

  console.log('\nE. the proxy (routing/osrm/proxy.py) against a fake OSRM');
  {
    const py = ['python3', 'python'].find((p) => { try { return spawnSync(p, ['--version']).status === 0; } catch (_) { return false; } });
    if (!py) {
      if (process.env.CI) ok('python3 is available in CI', false);
      else console.log('  ! no python on PATH: proxy checks skipped');
    } else {
      const seen = [];
      const fake = http.createServer((req, res) => {
        seen.push(req.method + ' ' + req.url);
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/nearest')) return res.end('{"code":"Ok"}');
        res.end(JSON.stringify({ code: 'Ok', routes: [{ duration: 1290.4, distance: 21500.2, geometry: req.url.includes('overview=full') ? 'xyz' : undefined, legs: [{ duration: 1290.4, distance: 21500.2 }] }] }));
      }).listen(0, '127.0.0.1');
      await new Promise((r) => fake.once('listening', r));
      const port = 18000 + Math.floor(Math.random() * 2000);
      const p = spawn(py, [path.join(ROOT, 'routing/osrm/proxy.py')], { env: Object.assign({}, process.env, { HOST: '127.0.0.1', PORT: String(port), OSRM_URL: 'http://127.0.0.1:' + fake.address().port }) });
      let logged = '';
      p.stdout.on('data', (d) => { logged += d; }); p.stderr.on('data', (d) => { logged += d; });
      const post = (body) => new Promise((resolve) => {
        const b = typeof body === 'string' ? body : JSON.stringify(body);
        const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/route', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) } }, (res) => {
          let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch (_) { return null; } })() }));
        });
        rq.on('error', () => resolve({ status: 0 }));
        rq.end(b);
      });
      let r = { status: 0 };
      for (let i = 0; i < 40 && r.status === 0; i++) { await new Promise((x) => setTimeout(x, 150)); r = await post({ coords: [[-84.512, 39.1031], [-84.6266, 38.9989]], geometry: true }); }
      ok('POST /v1/route answers legs, totals and geometry', r.status === 200 && r.json && r.json.ok && r.json.legs[0].sec === 1290 && r.json.m === 21500 && r.json.geometry === 'xyz', JSON.stringify(r));
      ok('…by asking OSRM on loopback with GET (coordinates stay inside the container)', seen.some((s) => /^GET \/route\/v1\/driving\/-84\.512000,39\.103100;-84\.626600,38\.998900\?overview=full/.test(s)), seen.join(' | '));
      const out = await post({ coords: [[-82.99, 39.96], [-84.5, 39.1]] });
      ok('a stop outside the clip box -> { ok: false, reason: "outside" }, OSRM not asked', out.status === 200 && out.json.reason === 'outside' && seen.length === 1);
      ok('bad JSON -> 400', (await post('{nope')).status === 400);
      ok('one stop -> 400', (await post({ coords: [[-84.5, 39.1]] })).status === 400);
      ok('a boolean as a coordinate -> 400', (await post({ coords: [[true, 39.1], [-84.5, 39.1]] })).status === 400);
      await new Promise((x) => setTimeout(x, 200));
      ok('the proxy wrote nothing to its logs (no request line, no coordinate)', logged.trim() === '', JSON.stringify(logged.slice(0, 300)));
      p.kill();
      fake.close();
    }
  }

  console.log('\nF. wiring');
  {
    const idx = read('functions/index.js');
    ok('routeDrive is exported', /exports\.routeDrive = require\('\.\/route-drive'\)\.routeDrive;/.test(idx));
    const src = read('functions/route-drive.js');
    ok('App Check enforced, sign-in required, 60/min per user', /enforceAppCheck: true/.test(src) && /'unauthenticated'/.test(src) && /callableRateLimit\(request, 'routeDrive', 60, 60_000\)/.test(src));
    ok('OSRM is called with the function\'s own identity (an ID token for the service)', /getIdTokenClient\(url\)/.test(src));
    ok('OSRM_URL is set for the deploy', /^OSRM_URL=https:\/\/osrm-cincy-[\w.-]+\.run\.app$/m.test(read('functions/.env.nobigdeal-pro')));
    const sl = read('docs/pro/js/script-loader.js');
    ok('the nextstop bundle loads route-drive.js before the card', /'js\/route-drive\.js\?v=\d+',\s*'js\/next-stop\.js\?v=\d+'/.test(sl));
    ok('Mission Control loads route-drive.js', /'js\/layouts\/routeplan\.js', 'js\/route-drive\.js'\]/.test(read('docs/pro/js/layout-system.js')));
    const m = read('docs/pro/js/layouts/mission.js');
    ok('Mission draws the road geometry when it has it', /points: m\.path && m\.path\.length > 1 \? m\.path :/.test(m));
    ok('Mission labels estimates only when they are estimates, and credits OpenStreetMap', /\(m\.real \? '' : ' \(est\.\)'\)/.test(m) && /© OpenStreetMap contributors/.test(m));
    const box = (s) => (s.match(/-85\.40,\s*37\.55,\s*-83\.65,\s*39\.75|w: -85\.40, s: 37\.55, e: -83\.65, n: 39\.75/) || [])[0];
    ok('the clip box agrees: Dockerfile, proxy.py, route-drive-logic.js', !!box(read('routing/osrm/Dockerfile')) && !!box(read('routing/osrm/proxy.py')) && !!box(read('functions/route-drive-logic.js')));
    ok('the service image pins OSRM v26.10.0 by digest', /osrm-backend:v26\.10\.0-debian@sha256:[0-9a-f]{64}/.test(read('routing/osrm/Dockerfile')));
    const rules = read('firestore.rules');
    ok('route_cache is server-only (no client rule opens it)', !/match \/route_cache/.test(rules));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})();
