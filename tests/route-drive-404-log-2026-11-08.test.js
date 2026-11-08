/**
 * tests/route-drive-404-log-2026-11-08.test.js — RD-404-LOG: routeDrive's
 * matrix path answers 'not_supported' on ANY 404 from the routing proxy (an
 * older routing image with no /v1/table, but just as well a mistyped OSRM_URL
 * path or a misrouted Cloud Run revision) and used to say nothing in the log,
 * so every tenant silently kept straight-line ordering for the browser's
 * 10-minute memo while an operator had no line to find. The answer stays
 * 'not_supported' (the browser relies on it); the path now leaves a warning
 * that carries the status and the path shape only — never a coordinate,
 * never the service host.
 *
 * Runs the REAL functions/route-drive.js (routeFor, injectable deps) with the
 * firebase-functions logger's warn captured, the way
 * tests/owner-fallback-log-2026-11-04.test.js does. The logger patched is the
 * very object route-drive.js destructures: 'firebase-functions/v2' resolved
 * from functions/, whose .logger is a copy of the logger module, not the
 * module itself.
 *
 * Run: node tests/route-drive-404-log-2026-11-08.test.js  (needs functions/ deps)
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); failed++; fails.push(label); }
}
const J = JSON.stringify;
const CINCY = { lat: 39.1031, lng: -84.512 }, FLORENCE = { lat: 38.9989, lng: -84.6266 };

const { logger } = require(require.resolve('firebase-functions/v2', { paths: [path.join(ROOT, 'functions')] }));
const realWarn = logger.warn;
async function capturingWarns(fn) {
  const calls = [];
  logger.warn = (...a) => { calls.push(a); };
  try { return { result: await fn(), calls }; } finally { logger.warn = realWarn; }
}
const failing = (status) => async () => ({ request: async () => { const e = new Error(String(status)); e.response = { status }; throw e; } });

(async () => {
  const RD = require(path.join(ROOT, 'functions/route-drive.js'))._internal;
  const deps = (client) => ({ db: null, now: 1, url: 'https://osrm.test', client });

  console.log('\nA. a 404 from the routing proxy on /v1/table');
  {
    RD.memClear();
    const { result: r, calls } = await capturingWarns(() => RD.routeFor({ stops: [CINCY, FLORENCE], matrix: true }, deps(failing(404))));
    ok('still answers not_supported (the browser relies on it)', r.ok === false && r.reason === 'not_supported', J(r));
    ok('…and now leaves exactly one warning in the log', calls.length === 1, J(calls));
    const c = calls[0] || [];
    ok('the line names routeDrive', typeof c[0] === 'string' && /\[routeDrive\]/.test(c[0]), J(c));
    ok('it carries the status and the path shape', !!c[1] && c[1].status === 404 && c[1].path === '/v1/table', J(c[1]));
    const s = J(calls);
    ok('…and nothing else: no coordinate, no stop, no service host', !/39\.1|84\.5|38\.9|84\.6|stops|coords|lat|lng|osrm\.test/.test(s), s);
  }

  console.log('\nB. the other answers are unchanged');
  {
    RD.memClear();
    const { result: r, calls } = await capturingWarns(() => RD.routeFor({ stops: [CINCY, FLORENCE], matrix: true }, deps(failing(503))));
    ok('the service down: unavailable, one warning with the status (as before)',
      r.ok === false && r.reason === 'unavailable' && calls.length === 1 && !!calls[0][1] && calls[0][1].status === 503, J({ r, calls }));
    RD.memClear();
    const { result: r2, calls: c2 } = await capturingWarns(() => RD.routeFor({ stops: [CINCY, FLORENCE] }, deps(failing(404))));
    ok('a 404 on /v1/route (a route, not the matrix) stays unavailable with its one warning',
      r2.ok === false && r2.reason === 'unavailable' && c2.length === 1 && !!c2[0][1] && c2[0][1].status === 404, J({ r2, c2 }));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
