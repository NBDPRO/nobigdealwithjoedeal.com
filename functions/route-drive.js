/**
 * functions/route-drive.js — routeDrive: real drive times for the CRM
 * (2026-10-16; repos report item 4). The browser's Next stop card and
 * Mission Control's day route call it; it answers from the private OSRM
 * service (routing/osrm, Cloud Run, no allUsers invoker), calling it with
 * this function's own Google identity (an ID token for the service URL).
 *
 *   auth        signed in (no anonymous), App Check enforced, 60 calls a
 *               minute per user (callableRateLimit)
 *   input       { stops: [{lat,lng}] 2..25, geometry: bool }
 *   output      { ok: true, legs: [{min, mi}], min, mi, geometry? (polyline6) }
 *               | { ok: false, reason } — the browser then keeps its
 *               straight-line estimate, labelled "est."
 *   cache       memory (this instance, 500 routes, 7 days, with geometry) and
 *               Firestore route_cache/{sha256} (legs and totals only, 30
 *               days, server-only collection). The key is a hash of the stops
 *               rounded to ~11 m; no coordinate is stored or ever logged.
 *   OSRM_URL    functions/.env.nobigdeal-pro (not a secret: the service is
 *               private, a URL alone grants nothing).
 */
'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const L = require('./route-drive-logic');
const { callableRateLimit } = require('./shared');
const { CORS_ORIGINS } = require('./handlers/_shared');

const MEM_MAX = 500;
const MEM_TTL_MS = 7 * 86400000;
const FS_TTL_MS = 30 * 86400000;
const CALL_TIMEOUT_MS = 12000;   // a cold OSRM instance answers in a few seconds
const COL = 'route_cache';

const mem = new Map();           // key -> { at, value }
function memGet(k, now) {
  const e = mem.get(k);
  if (!e) return null;
  if (now - e.at > MEM_TTL_MS) { mem.delete(k); return null; }
  mem.delete(k); mem.set(k, e);  // LRU bump
  return e.value;
}
function memSet(k, value, now) {
  mem.set(k, { at: now, value });
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

let _client = null;
let _testClient = null;
async function osrmClient(url) {
  if (_testClient) return _testClient;
  if (_client && _client.url === url) return _client;
  const { GoogleAuth } = require('google-auth-library');
  const c = await new GoogleAuth().getIdTokenClient(url);
  _client = { url, request: (o) => c.request(o) };
  return _client;
}

/** Core, injectable for tests: { db, now, url, client } */
async function routeFor(data, deps) {
  const geometry = !!(data && data.geometry === true);
  const clean = L.cleanStops(data && data.stops);
  if (!clean.ok) {
    if (clean.reason === 'invalid') throw new HttpsError('invalid-argument', 'Send 2 to ' + L.MAX_STOPS + ' stops.');
    return { ok: false, reason: clean.reason };
  }
  const now = deps.now;
  const key = L.cacheKey(clean.stops, geometry);
  const hit = memGet(key, now);
  if (hit) return Object.assign({ cached: true }, hit);
  const db = deps.db;
  if (!geometry && db) {
    try {
      const snap = await db.collection(COL).doc(key).get();
      const v = snap.exists ? snap.data() : null;
      if (v && v.expireAtMs > now && Array.isArray(v.legs)) {
        const value = { ok: true, legs: v.legs, min: v.min, mi: v.mi };
        memSet(key, value, now);
        return Object.assign({ cached: true }, value);
      }
    } catch (_) { /* cache is best-effort; ask OSRM */ }
  }
  if (!deps.url) return { ok: false, reason: 'not_configured' };
  let res;
  try {
    const client = await deps.client(deps.url);
    const r = await client.request({ url: deps.url + '/v1/route', method: 'POST', data: L.proxyBody(clean.stops, geometry), timeout: CALL_TIMEOUT_MS });
    res = L.shapeResult(r && r.data, clean.stops.length - 1);
  } catch (e) {
    // The status only: the request body (coordinates) is never logged.
    logger.warn('[routeDrive] routing service unavailable', { status: (e && e.response && e.response.status) || (e && e.code) || 'error' });
    return { ok: false, reason: 'unavailable' };
  }
  if (!res.ok) return res;
  memSet(key, res, now);
  if (db) {
    db.collection(COL).doc(key).set({ legs: res.legs, min: res.min, mi: res.mi, atMs: now, expireAtMs: now + FS_TTL_MS })
      .catch(() => {});
  }
  return res;
}

exports.routeDrive = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB', maxInstances: 5 },
  async (request) => {
    if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
    await callableRateLimit(request, 'routeDrive', 60, 60_000);
    const { getFirestore } = require('firebase-admin/firestore');
    return routeFor(request.data || {}, {
      db: getFirestore(), now: Date.now(), url: String(process.env.OSRM_URL || '').replace(/\/+$/, ''), client: osrmClient,
    });
  }
);

exports._internal = {
  routeFor, memClear: () => mem.clear(), setTestClient: (c) => { _testClient = c; _client = null; },
};
