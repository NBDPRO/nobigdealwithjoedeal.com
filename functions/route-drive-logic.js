/**
 * functions/route-drive-logic.js — the pure half of routeDrive (2026-10-16,
 * real drive times). No Firebase, no network, no clock.
 *
 *   cleanStops   validate the caller's stops: 2..25 {lat,lng} numbers inside
 *                the routing graph's clip box (routing/osrm/Dockerfile BBOX)
 *   cacheKey     a SHA-256 of the stops rounded to 4 decimals (~11 m) + the
 *                geometry flag. The key is what gets stored; a coordinate
 *                never is (and none is ever logged)
 *   shapeResult  the proxy's reply -> what the browser gets
 *                ({ ok, legs: [{ min, mi }], min, mi, geometry? })
 */
'use strict';
const crypto = require('crypto');

// Must match routing/osrm/Dockerfile BBOX (west, south, east, north).
const BBOX = { w: -85.40, s: 37.55, e: -83.65, n: 39.75 };
const MAX_STOPS = 25;
const MI_PER_M = 1 / 1609.344;

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function inBox(p) { return p.lng >= BBOX.w && p.lng <= BBOX.e && p.lat >= BBOX.s && p.lat <= BBOX.n; }

/** -> { ok: true, stops: [{lat,lng}] } | { ok: false, reason: 'invalid' | 'outside' } */
function cleanStops(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_STOPS) return { ok: false, reason: 'invalid' };
  const stops = [];
  for (const s of raw) {
    const lat = num(s && s.lat), lng = num(s && s.lng);
    if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, reason: 'invalid' };
    stops.push({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 });
  }
  if (!stops.every(inBox)) return { ok: false, reason: 'outside' };
  return { ok: true, stops };
}

function cacheKey(stops, geometry) {
  const s = stops.map((p) => p.lat.toFixed(4) + ',' + p.lng.toFixed(4)).join(';') + (geometry ? '|g' : '|n');
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** The proxy's POST body: [lng, lat] pairs, like OSRM. */
function proxyBody(stops, geometry) {
  return { coords: stops.map((p) => [p.lng, p.lat]), geometry: geometry === true };
}

function minutes(sec) { return sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0; }
function miles(m) { return Math.round(m * MI_PER_M * 10) / 10; }

/** Proxy reply -> browser reply. Anything unexpected is { ok: false }. */
function shapeResult(r, nLegs) {
  if (!r || r.ok !== true || !Array.isArray(r.legs) || r.legs.length !== nLegs) {
    return { ok: false, reason: (r && typeof r.reason === 'string' && /^[a-z_]{1,20}$/.test(r.reason)) ? r.reason : 'no_route' };
  }
  const legs = r.legs.map((l) => ({ min: minutes(Number(l.sec) || 0), mi: miles(Number(l.m) || 0) }));
  const out = { ok: true, legs, min: legs.reduce((a, l) => a + l.min, 0), mi: miles(Number(r.m) || 0) };
  if (typeof r.geometry === 'string' && r.geometry.length < 200000) out.geometry = r.geometry;
  return out;
}

module.exports = { BBOX, MAX_STOPS, cleanStops, cacheKey, proxyBody, shapeResult, minutes, miles, inBox };
