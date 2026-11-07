#!/usr/bin/env node
/**
 * tests/route-road-order-2026-11-07.test.js — Mission Control orders a day's
 * stops by ROAD time (OSRM /table) instead of straight lines, with the
 * routing service MOCKED throughout. Nothing here reaches the network.
 * (OSS deep dive 2026-11-06, top-10 item 1, reshaped: /table + our own
 * NN + 2-opt keeps the open path from the first stop, which /trip cannot.)
 *
 *   A. route-drive-logic: shapeMatrix, and the table cache key (a route's key
 *      is unchanged, the table's is its own; neither holds a coordinate)
 *   B. routeFor({ matrix: true }): POST /v1/table, memory + Firestore cache
 *      (flat seconds + n, never a coordinate), an older image (404) ->
 *      'not_supported', the service down -> 'unavailable'
 *   C. the browser client NBDRouteDrive.matrix(): shape, memo, a malformed or
 *      missing answer -> { ok: false }, 'not_supported' remembered
 *   D. routeplan.optimizeMatrix: avoids a river detour straight lines walk
 *      into, keeps the first stop, never worse than appointment order or its
 *      own nearest-neighbour start (seeded random matrices), a missing road
 *      or a bad matrix -> null (the caller keeps straight lines)
 *   E. proxy.py POST /v1/table against a fake OSRM: GET /table on loopback,
 *      whole seconds, nulls kept, nothing logged (skipped without python)
 *   F. Mission wiring: "Shortest" asks for the matrix and orders by it,
 *      straight lines until it answers, road-minute savings with no miles
 *
 * Run: node tests/route-road-order-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); failed++; fails.push(label); }
}
const J = JSON.stringify;
const CINCY = { lat: 39.1031, lng: -84.512 }, FLORENCE = { lat: 38.9989, lng: -84.6266 }, COVINGTON = { lat: 39.0837, lng: -84.5086 };

(async () => {
  console.log('\nA. route-drive-logic');
  const L = require(path.join(ROOT, 'functions/route-drive-logic.js'));
  {
    const sec = [[0, 600.4, null], [580, 0, 300], [610, 290, 0]];
    const m = L.shapeMatrix({ ok: true, sec }, 3);
    ok('shapeMatrix: whole seconds, nulls kept', m.ok && J(m.sec) === J([[0, 600, null], [580, 0, 300], [610, 290, 0]]), J(m));
    ok('shapeMatrix: wrong size / negative / text -> not ok', L.shapeMatrix({ ok: true, sec: [[0]] }, 2).ok === false &&
      L.shapeMatrix({ ok: true, sec: [[0, -1], [1, 0]] }, 2).ok === false && L.shapeMatrix({ ok: true, sec: [[0, 'x'], [1, 0]] }, 2).ok === false);
    ok('shapeMatrix: the proxy reason passes through only as a plain code',
      L.shapeMatrix({ ok: false, reason: 'outside' }, 2).reason === 'outside' && L.shapeMatrix({ ok: false, reason: '<b>' }, 2).reason === 'no_route');
    const kRoute = L.cacheKey([CINCY, FLORENCE], false), kTable = L.cacheKey([CINCY, FLORENCE], false, 'table');
    const crypto = require('crypto');
    const legacy = crypto.createHash('sha256').update('39.1031,-84.5120;38.9989,-84.6266|n').digest('hex');
    ok('a route\'s cache key is unchanged (existing cache entries still hit)', kRoute === legacy);
    ok('the table has its own key, a sha256 hex with no coordinate', kTable !== kRoute && /^[0-9a-f]{64}$/.test(kTable));
  }

  console.log('\nB. routeFor({ matrix: true })');
  {
    const RD = require(path.join(ROOT, 'functions/route-drive.js'))._internal;
    const store = {};
    const db = { collection: () => ({ doc: (id) => ({ get: async () => ({ exists: id in store, data: () => store[id] }), set: async (v) => { store[id] = v; } }) }) };
    let calls = 0, lastReq = null;
    const SEC = [[0, 900, 400], [880, 0, 500], [410, 520, 0]];
    const client = async () => ({ request: async (o) => { calls++; lastReq = o; return { data: { ok: true, sec: SEC } }; } });
    RD.memClear();
    const stops = [CINCY, FLORENCE, COVINGTON];
    const r1 = await RD.routeFor({ stops, matrix: true }, { db, now: 1e12, url: 'https://osrm.test', client });
    ok('asks the service: POST /v1/table with [lng,lat] pairs, no geometry', r1.ok && calls === 1 && lastReq.url === 'https://osrm.test/v1/table' &&
      lastReq.method === 'POST' && lastReq.data.coords.length === 3 && lastReq.data.geometry === false, J(lastReq));
    ok('…and returns the seconds matrix', r1.ok && J(r1.sec) === J(SEC));
    await new Promise((r) => setImmediate(r));
    const id = Object.keys(store)[0];
    ok('Firestore keeps the flat seconds and n only, under a hash id (no stop)', !!id && /^[0-9a-f]{64}$/.test(id) &&
      J(Object.keys(store[id]).sort()) === J(['atMs', 'expireAtMs', 'n', 'secFlat']) && store[id].n === 3 && store[id].secFlat.length === 9, J(store));
    ok('…and nothing stored looks like a coordinate', !/39\.|84\.|38\./.test(J(store)));
    const r2 = await RD.routeFor({ stops, matrix: true }, { db, now: 1e12 + 1000, url: 'https://osrm.test', client });
    ok('asked again: from memory', r2.ok && r2.cached === true && calls === 1);
    RD.memClear();
    const r3 = await RD.routeFor({ stops, matrix: true }, { db, now: 1e12 + 2000, url: 'https://osrm.test', client });
    ok('a cold instance rebuilds the matrix from Firestore', r3.ok && r3.cached === true && calls === 1 && J(r3.sec) === J(SEC), J(r3));
    const old = async () => ({ request: async () => { const e = new Error('404'); e.response = { status: 404 }; throw e; } });
    RD.memClear();
    const r4 = await RD.routeFor({ stops: [CINCY, FLORENCE], matrix: true }, { db: null, now: 1, url: 'https://osrm.test', client: old });
    ok('an older routing image (no /v1/table, 404) -> not_supported', r4.ok === false && r4.reason === 'not_supported', J(r4));
    const down = async () => ({ request: async () => { const e = new Error('503'); e.response = { status: 503 }; throw e; } });
    const r5 = await RD.routeFor({ stops: [CINCY, FLORENCE], matrix: true }, { db: null, now: 1, url: 'https://osrm.test', client: down });
    ok('the service down -> unavailable', r5.ok === false && r5.reason === 'unavailable');
    const r6 = await RD.routeFor({ stops: [CINCY, { lat: 39.96, lng: -82.99 }], matrix: true }, { db: null, now: 1, url: 'https://osrm.test', client });
    ok('outside the routed area -> outside, no call', r6.ok === false && r6.reason === 'outside' && calls === 1);
    let threw = null;
    try { await RD.routeFor({ stops: 'x', matrix: true }, { db: null, now: 1, url: 'https://osrm.test', client }); } catch (e) { threw = e; }
    ok('garbage input is invalid-argument', threw && threw.code === 'invalid-argument');
    const src = read('functions/route-drive.js');
    const logs = src.match(/logger\.\w+\([^;]*\)/g) || [];
    ok('every log line carries a status only', logs.length >= 2 && logs.every((l) => !/stops|data\b|coords|lat|lng|clean|sec\b/.test(l)), logs.join(' | '));
  }

  console.log('\nC. the browser client: NBDRouteDrive.matrix()');
  {
    const RDc = require(path.join(ROOT, 'docs/pro/js/route-drive.js'));
    let n = 0, sent = null;
    RDc._setCaller(async (d) => { n++; sent = d; return { data: { ok: true, sec: [[0, 60], [70, 0]] } }; });
    const a = await RDc.matrix([CINCY, FLORENCE]);
    ok('an answer: the seconds matrix; the call says matrix: true', a.ok && J(a.sec) === J([[0, 60], [70, 0]]) && sent.matrix === true && !('geometry' in sent), J(sent));
    await RDc.matrix([CINCY, FLORENCE]);
    ok('asked again within 10 minutes: no second call', n === 1);
    RDc._setCaller(async () => ({ data: { ok: true, sec: [[0, 'x'], [1, 0]] } }));
    ok('a malformed matrix -> { ok: false }', (await RDc.matrix([CINCY, COVINGTON])).ok === false);
    let n2 = 0;
    RDc._setCaller(async () => { n2++; return { data: { ok: false, reason: 'not_supported' } }; });
    const ns = await RDc.matrix([FLORENCE, COVINGTON]);
    // two minutes later: an ordinary failure would retry after one minute; not_supported must not
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60000;
    try { await RDc.matrix([FLORENCE, COVINGTON]); } finally { Date.now = realNow; }
    ok('not_supported is remembered for the memo window (no retry a minute later)', ns.reason === 'not_supported' && n2 === 1, 'calls: ' + n2);
    RDc._setCaller(async () => { throw new Error('offline'); });
    ok('a failed call -> { ok: false } (never rejects)', (await RDc.matrix([COVINGTON, CINCY])).ok === false);
    ok('fewer than two stops: no call', (await RDc.matrix([CINCY])).reason === 'invalid');
    RDc._reset();
  }

  console.log('\nD. routeplan.optimizeMatrix');
  {
    const RP = require(path.join(ROOT, 'docs/pro/js/layouts/routeplan.js'));
    // 0 home; 1 and 2 are close as the crow flies but a river apart (3000 s); 3 is the bridge side
    const river = [[0, 300, 600, 900], [300, 0, 3000, 600], [600, 3000, 0, 300], [900, 600, 300, 0]];
    const r = RP.optimizeMatrix(river, 0);
    ok('takes the bridge instead of the river detour', r && J(r.order) === J([0, 1, 3, 2]) && r.sec === 1200 && r.identSec === 3600, J(r));
    ok('a missing road (null) or a bad matrix -> null (straight lines stay)', RP.optimizeMatrix([[0, null, 1], [1, 0, 1], [1, 1, 0]], 0) === null &&
      RP.optimizeMatrix([[0, 1]], 0) === null && RP.optimizeMatrix([], 0) === null && RP.optimizeMatrix('x', 0) === null);
    // seeded LCG: random asymmetric road matrices, 3..12 stops
    let seed = 20261107;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let bad = null;
    for (let t = 0; t < 300 && !bad; t++) {
      const n = 3 + Math.floor(rnd() * 10);
      const m = [];
      for (let i = 0; i < n; i++) { m.push([]); for (let j = 0; j < n; j++) m[i].push(i === j ? 0 : 60 + Math.floor(rnd() * 3000)); }
      const o = RP.optimizeMatrix(m, 0);
      const perm = o && o.order.slice().sort((x, y) => x - y).every((v, i) => v === i) && o.order.length === n;
      if (!o || !perm || o.order[0] !== 0 || o.sec > o.nnSec || !(o.sec >= 0)) bad = { n, o };
    }
    ok('300 random road matrices: a full order, first stop kept, never worse than its nearest-neighbour start', !bad, J(bad));
    ok('straight-line ordering is unchanged without a matrix (same answer as before)', J(RP.optimize([{ lat: 39, lng: -84 }, { lat: 39.2, lng: -84 }, { lat: 39.1, lng: -84 }], 0).order) === J([0, 2, 1]));
  }

  console.log('\nE. proxy.py POST /v1/table against a fake OSRM');
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
        if (req.url.startsWith('/table')) return res.end(J({ code: 'Ok', durations: [[0, 610.6, null], [598.2, 0, 300.4], [612, 299.5, 0]] }));
        res.end(J({ code: 'Ok', routes: [{ duration: 1, distance: 1, legs: [{ duration: 1, distance: 1 }] }] }));
      }).listen(0, '127.0.0.1');
      await new Promise((r) => fake.once('listening', r));
      const port = 20000 + Math.floor(Math.random() * 2000);
      const p = spawn(py, [path.join(ROOT, 'routing/osrm/proxy.py')], { env: Object.assign({}, process.env, { HOST: '127.0.0.1', PORT: String(port), OSRM_URL: 'http://127.0.0.1:' + fake.address().port }) });
      let logged = '';
      p.stdout.on('data', (d) => { logged += d; }); p.stderr.on('data', (d) => { logged += d; });
      const post = (pathName, body) => new Promise((resolve) => {
        const b = typeof body === 'string' ? body : J(body);
        const rq = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathName, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) } }, (res) => {
          let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch (_) { return null; } })() }));
        });
        rq.on('error', () => resolve({ status: 0 }));
        rq.end(b);
      });
      const three = { coords: [[-84.512, 39.1031], [-84.6266, 38.9989], [-84.5086, 39.0837]] };
      let r = { status: 0 };
      for (let i = 0; i < 40 && r.status === 0; i++) { await new Promise((x) => setTimeout(x, 150)); r = await post('/v1/table', three); }
      ok('POST /v1/table answers whole seconds, nulls kept', r.status === 200 && r.json && r.json.ok && J(r.json.sec) === J([[0, 611, null], [598, 0, 300], [612, 300, 0]]), J(r));
      ok('…by asking OSRM /table on loopback with GET', seen.some((s) => /^GET \/table\/v1\/driving\/-84\.512000,39\.103100;-84\.626600,38\.998900;-84\.508600,39\.083700\?annotations=duration$/.test(s)), seen.join(' | '));
      const out = await post('/v1/table', { coords: [[-82.99, 39.96], [-84.5, 39.1]] });
      ok('a stop outside the clip box -> outside, OSRM not asked', out.status === 200 && out.json.reason === 'outside' && seen.length === 1);
      ok('one stop -> 400', (await post('/v1/table', { coords: [[-84.5, 39.1]] })).status === 400);
      ok('an unknown path -> 404', (await post('/v1/trip', three)).status === 404);
      await new Promise((x) => setTimeout(x, 200));
      ok('the proxy wrote nothing to its logs', logged.trim() === '', J(logged.slice(0, 300)));
      p.kill();
      fake.close();
    }
  }

  console.log('\nF. Mission Control wiring');
  {
    const m = read('docs/pro/js/layouts/mission.js');
    ok('"Shortest" asks for the matrix and orders by it when it answers', /rm = roadMatrix\(located\);/.test(m) && /road = RP\.optimizeMatrix\(rm\.sec, 0\);\n\s+if \(road\) order = road\.order;/.test(m));
    ok('…straight-line order first (RP.optimize), so nothing waits on the service', m.indexOf('opt = RP.optimize(pts, 0);') < m.indexOf('rm = roadMatrix(located);'));
    ok('the matrix ask is memoised per stop set and repaints once', /function roadMatrix\(located\)/.test(m) && /S\.route\.matrix !== mine/.test(m) && /matrix: null \}/.test(m));
    ok('road ordering reports road minutes and no miles', /savedMin: road \? Math\.max\(0, Math\.round\(\(road\.identSec - road\.sec\) \/ 60\)\)/.test(m) && /savedMi: road \? null/.test(m) &&
      /\(m\.savedMi != null \? ' and ' \+ m\.savedMi \+ ' mi' : ''\)/.test(m) && /, by road time\./.test(m));
    ok('"Calculating road times" also covers the matrix wait', /\|\| !!\(rm && rm\.status === 'pending'\)/.test(m));
    const p = read('routing/osrm/proxy.py');
    ok('the proxy only serves /v1/route and /v1/table', /if self\.path not in \("\/v1\/route", "\/v1\/table"\):/.test(p));
    ok('OSRM allows a 25-stop table (start.sh --max-table-size >= 25)', /--max-table-size (\d+)/.test(read('routing/osrm/start.sh')) && Number(read('routing/osrm/start.sh').match(/--max-table-size (\d+)/)[1]) >= 25);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})();
