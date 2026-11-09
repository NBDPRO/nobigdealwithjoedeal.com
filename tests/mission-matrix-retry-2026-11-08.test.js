#!/usr/bin/env node
/**
 * tests/mission-matrix-retry-2026-11-08.test.js — Mission Control's "Shortest"
 * order asks the routing service for the drive-time matrix AGAIN after a
 * transient failure (review finding MC-MATRIX-RETRY, 2026-11-08).
 *
 * Before: roadMatrix() in layouts/mission.js kept status 'fail' on
 * S.route.matrix for the whole mount, so one timeout (or the service being
 * down for a second) left "Shortest" on straight lines for the session, even
 * though route-drive.js's own memo lets a failure retry after a minute.
 * After: a transient failure is kept for that same minute, then asked again;
 * 'not_supported' (an older routing image) still stands for the mount.
 *
 * Runs the REAL roadMatrix (lifted out of mission.js into a vm sandbox with
 * S, mounted and render stubbed), first against a fake NBDRouteDrive, then
 * against the REAL docs/pro/js/route-drive.js memo with its caller mocked.
 * Date.now is moved by hand. Nothing here reaches the network.
 *
 * Run: node tests/mission-matrix-retry-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const J = JSON.stringify;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CINCY = { lat: 39.1031, lng: -84.512 }, FLORENCE = { lat: 38.9989, lng: -84.6266 }, COVINGTON = { lat: 39.0837, lng: -84.5086 }, NEWPORT = { lat: 39.0915, lng: -84.4958 };
const STOPS = [CINCY, FLORENCE, COVINGTON];
const SEC = [[0, 900, 400], [880, 0, 500], [410, 520, 0]];

// ── lift the real roadMatrix() (and the file's numeric constants) ──────────
const SRC = read('docs/pro/js/layouts/mission.js');
function lifted() {
  const a = SRC.indexOf('  function roadMatrix(located) {');
  const b = SRC.indexOf('  /** The road route for these stops in this order', a);
  if (a < 0 || b < 0) throw new Error('roadMatrix() not found in mission.js (anchors moved?)');
  const consts = (SRC.match(/^  var [A-Z]+_[A-Z_]+ = [^\n]*;[^\n]*$/gm) || []).join('\n');
  return consts + '\n' + SRC.slice(a, b) + '\nroadMatrix;';
}
function harness(RD) {
  const ctx = { W: { NBDRouteDrive: RD }, S: { route: { matrix: null } }, mounted: true, renders: 0, Date, Number, Math, Promise, Infinity };
  ctx.render = function () { ctx.renders++; };
  vm.createContext(ctx);
  return { ctx, roadMatrix: vm.runInContext(lifted(), ctx) };
}
function fakeRD() {
  const calls = [];
  return {
    calls,
    rd: { matrix(stops) { const c = { stops }; c.p = new Promise((res, rej) => { c.resolve = res; c.reject = rej; }); calls.push(c); return c.p; } },
  };
}

// a clock we move by hand (the lifted code and route-drive.js both read Date.now)
const realNow = Date.now, BASE = realNow();
let now = 0;
Date.now = () => BASE + now;

(async () => {
  try {
    console.log('\nA. roadMatrix (lifted from mission.js) against a fake NBDRouteDrive');
    {
      const { rd, calls } = fakeRD();
      const { ctx, roadMatrix } = harness(rd);
      now = 0;
      let m = roadMatrix(STOPS);
      ok('first ask: pending, one matrix call, remembered on S.route.matrix', m && m.status === 'pending' && calls.length === 1 && ctx.S.route.matrix === m);
      calls[0].resolve({ ok: false, reason: 'timeout' });
      await flush();
      ok('a timeout: fail, repainted once', m.status === 'fail' && ctx.renders === 1, 'status ' + m.status + ', renders ' + ctx.renders);
      ok('asked again at once: the failure is kept, no second call, no repaint loop', roadMatrix(STOPS) === m && calls.length === 1 && ctx.renders === 1);
      now = 30 * 1000;
      ok('30 s later: still kept (route-drive.js would answer from its own memo anyway)', roadMatrix(STOPS) === m && calls.length === 1);
      now = 61 * 1000;
      m = roadMatrix(STOPS);
      ok('a minute later: asked again (pending, a second matrix call)', m.status === 'pending' && calls.length === 2, 'status ' + m.status + ', calls ' + calls.length);
      if (calls[1]) calls[1].resolve({ ok: true, sec: SEC });
      await flush();
      ok('…and the answer arrives: ok with the seconds matrix, repainted', m.status === 'ok' && J(m.sec) === J(SEC) && ctx.renders === 2, 'status ' + m.status + ', renders ' + ctx.renders);
      now = 20 * 60 * 1000;
      ok('an answer is kept for the mount (no re-ask twenty minutes on)', roadMatrix(STOPS) === m && calls.length === 2);
      const other = roadMatrix([CINCY, FLORENCE, NEWPORT]);
      ok('a different stop set is its own ask', other !== m && other.status === 'pending' && calls.length === 3);
    }
    {
      const { rd, calls } = fakeRD();
      const { ctx, roadMatrix } = harness(rd);
      now = 0;
      const m = roadMatrix(STOPS);
      calls[0].reject(new Error('boom'));
      await flush();
      ok('a rejected ask (defensive path): fail, repainted once', m.status === 'fail' && ctx.renders === 1);
      now = 61 * 1000;
      ok('…and asked again a minute later', roadMatrix(STOPS).status === 'pending' && calls.length === 2, 'calls ' + calls.length);
    }
    {
      const { rd, calls } = fakeRD();
      const { ctx, roadMatrix } = harness(rd);
      now = 0;
      const m = roadMatrix(STOPS);
      calls[0].resolve({ ok: false, reason: 'not_supported' });
      await flush();
      ok('not_supported (an older routing image): fail, repainted once', m.status === 'fail' && ctx.renders === 1);
      now = 15 * 60 * 1000;
      ok('…and never asked again this mount (fifteen minutes on: no second call)', roadMatrix(STOPS) === m && calls.length === 1, 'calls ' + calls.length);
    }

    console.log('\nB. with the REAL route-drive.js memo (caller mocked, 5 ms client timeout)');
    {
      const RD = require(path.join(ROOT, 'docs/pro/js/route-drive.js'));
      RD._setTimeoutMs(5);
      let served = 0, answer = () => new Promise(() => {});   // the service never answers: the client times out
      RD._setCaller((d) => { served++; return answer(d); });
      const { ctx, roadMatrix } = harness(RD);
      now = 0;
      let m = roadMatrix(STOPS);
      await sleep(40); await flush();
      ok('the service does not answer: timeout -> fail, one call to the server, repainted once', m.status === 'fail' && served === 1 && ctx.renders === 1, 'status ' + m.status + ', served ' + served);
      now = 30 * 1000;
      ok('30 s later: Mission keeps the failure and the server is not asked', roadMatrix(STOPS) === m && served === 1);
      answer = async () => ({ data: { ok: true, sec: SEC } });
      now = 61 * 1000;
      m = roadMatrix(STOPS);
      await flush();
      ok('a minute later: asked again, the server is called again (route-drive\'s memo let go too) and the matrix comes back', m.status === 'ok' && served === 2 && J(m.sec) === J(SEC), 'status ' + m.status + ', served ' + served);
      RD._reset(); RD._setTimeoutMs(12000);
    }
  } finally {
    Date.now = realNow;
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})();
