/**
 * route-drive.js — real road drive times for the CRM (2026-10-16).
 *
 * NBDRouteDrive.get(stops, { geometry }) asks the routeDrive callable
 * (functions/route-drive.js -> the private OSRM service on Cloud Run) for the
 * road minutes and miles of each hop between `stops` ([{lat,lng}], in order).
 *
 *   -> { ok: true, legs: [{ min, mi }], min, mi, path?: [[lat,lng], ...] }
 *   -> { ok: false, reason }  timeout (TIMEOUT_MS, a cold service can take a
 *      few seconds), outside the routed area, offline, signed out, the sample
 *      account ... The caller then keeps routeplan.js's straight-line
 *      estimate and labels it "est.".
 *
 * Answers are remembered for 10 minutes per stop list (rounded to ~11 m), so
 * the Next stop card's minute repaint does not call the server again.
 * No coordinate is logged here or on the server.
 */
(function (root) {
  'use strict';
  var TIMEOUT_MS = 12000;
  var MEMO_MS = 10 * 60000;
  var memo = {};          // key -> { at, value } | { at, pending: Promise }
  var caller = null;      // test seam: function (data) -> Promise<{ data }>

  function okNum(v) { return typeof v === 'number' && isFinite(v); }
  function keyOf(stops, geometry) {
    return stops.map(function (p) { return p.lat.toFixed(4) + ',' + p.lng.toFixed(4); }).join(';') + (geometry ? '|g' : '|n');
  }

  /** Google polyline decoding at precision 6 (OSRM geometries=polyline6). -> [[lat, lng], ...] */
  function decodePolyline6(str) {
    var out = [], i = 0, lat = 0, lng = 0, f = 1e6;
    str = String(str || '');
    while (i < str.length) {
      var shift = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
      lat += (res & 1) ? ~(res >> 1) : (res >> 1);
      shift = 0; res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
      lng += (res & 1) ? ~(res >> 1) : (res >> 1);
      out.push([lat / f, lng / f]);
    }
    return out;
  }

  function call(data) {
    if (caller) return caller(data);
    var w = root;
    if (w.__NBD_DEMO__ && w.__NBD_DEMO__.active) return Promise.resolve({ data: { ok: false, reason: 'sample' } });
    function go() { return w._httpsCallable(w._functions, 'routeDrive')(data); }
    if (w._functions && w._httpsCallable) return go();
    return import('/assets/vendor/firebase/10.12.2/firebase-functions.js').then(function (mod) {
      w._functions = w._functions || mod.getFunctions();
      w._httpsCallable = w._httpsCallable || mod.httpsCallable;
      return go();
    });
  }

  function shape(r, n) {
    var d = r && r.data;
    if (!d || d.ok !== true || !Array.isArray(d.legs) || d.legs.length !== n - 1) {
      return { ok: false, reason: (d && typeof d.reason === 'string' && d.reason) || 'no_route' };
    }
    for (var i = 0; i < d.legs.length; i++) if (!okNum(d.legs[i].min) || !okNum(d.legs[i].mi)) return { ok: false, reason: 'no_route' };
    var out = { ok: true, legs: d.legs.map(function (l) { return { min: l.min, mi: l.mi }; }), min: d.min, mi: d.mi };
    if (typeof d.geometry === 'string' && d.geometry) out.path = decodePolyline6(d.geometry);
    return out;
  }

  function get(stops, opts) {
    var geometry = !!(opts && opts.geometry);
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > 25 ||
      !stops.every(function (p) { return p && okNum(p.lat) && okNum(p.lng); })) {
      return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    var key = keyOf(stops, geometry), now = Date.now(), m = memo[key];
    if (m && now - m.at < MEMO_MS) return m.pending || Promise.resolve(m.value);
    var timer;
    var timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve({ ok: false, reason: 'timeout' }); }, TIMEOUT_MS); });
    var p = Promise.race([
      Promise.resolve().then(function () {
        return call({ stops: stops.map(function (s) { return { lat: s.lat, lng: s.lng }; }), geometry: geometry });
      }).then(function (r) { return shape(r, stops.length); }, function () { return { ok: false, reason: 'unavailable' }; }),
      timeout,
    ]).then(function (v) {
      clearTimeout(timer);
      // Remember answers; let a failure retry on the next ask after a minute.
      memo[key] = v.ok ? { at: Date.now(), value: v } : { at: Date.now() - MEMO_MS + 60000, value: v };
      return v;
    });
    memo[key] = { at: now, pending: p };
    return p;
  }

  var api = {
    get: get, decodePolyline6: decodePolyline6, TIMEOUT_MS: TIMEOUT_MS,
    _setCaller: function (fn) { caller = fn; memo = {}; }, _reset: function () { memo = {}; },
    _setTimeoutMs: function (ms) { TIMEOUT_MS = ms; },
  };
  root.NBDRouteDrive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
