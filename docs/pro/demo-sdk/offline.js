// offline.js — what the sample account answers instead of calling other
// sites (Pro demo phase 2, wave 3, 2026-10-06).
//
// The door-knocking map and Storm Center call the National Weather Service,
// the Storm Prediction Center, OpenStreetMap's Nominatim geocoder and the
// /api/storm-report function. In the sample account none of those requests
// is ever made: docs/pro/js/demo-mode.js recognises them in its fetch wrapper
// and hands them here BEFORE they could reach the network, and this module
// answers from the seed's "offline" section (scripts/build-demo-seed.js) and
// the sample map (basemap.js). Every answer says it is sample data.
//
// Also here:
//   - the sample location navigator.geolocation reports (the story customer's
//     street), so the maps never ask for the visitor's real position;
//   - the Storm Center zone and the one-shot "focus the storm" hint, written
//     into this tab's (namespaced, sample-only) localStorage on first load;
//   - Ask Joe: window.callClaude answers Ask Joe's turns from
//     ask-joe-canned.js; any other AI caller is told AI is not in the sample
//     account. No model is ever called.
//
// Loaded by demo-mode.js as a module, only under /pro/explore/.
import { ready, seedMeta, reviveSeed, rawList, demoNotice } from './_store.js';
import { answerJoe } from './ask-joe-canned.js';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-NBD-Demo': 'sample-offline' };
const json = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS });
const off = () => (seedMeta() && seedMeta().offline) || {};
const map = () => (typeof window !== 'undefined' && window.NBD_DEMO_BASEMAP) || null;
const STATES = { KY: 'Kentucky', OH: 'Ohio', IN: 'Indiana' };

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The sample customers (leads) carry city / state / zip: the nearest one
// names the town for a point that is not on the sample streets.
function nearestLead(lat, lng) {
  let best = null, bd = Infinity;
  for (const [, l] of rawList('leads')) {
    if (!l || typeof l.lat !== 'number' || typeof l.lng !== 'number') continue;
    const d = haversineMi(lat, lng, l.lat, l.lng);
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}
function cityParts() {
  const m = /^(.*), ([A-Z]{2}) (\d{5})$/.exec(off().city || 'Fort Thomas, KY 41075');
  return m ? { city: m[1], st: m[2], zip: m[3] } : { city: 'Fort Thomas', st: 'KY', zip: '41075' };
}

// Nominatim-shaped place for a sample house (the CRM reads address.house_number,
// road, city, state, postcode, lat/lon, display_name, type/addresstype).
function placeForHouse(h) {
  const c = cityParts();
  return {
    place_id: 'sample-' + h.number + '-' + h.street.replace(/\W+/g, '-').toLowerCase(),
    lat: String(h.lat), lon: String(h.lng), type: 'house', addresstype: 'building', class: 'building',
    display_name: h.number + ', ' + h.street + ', ' + c.city + ', ' + STATES[c.st] + ', ' + c.zip + ', United States (sample address)',
    address: { house_number: String(h.number), road: h.street, city: c.city, county: 'Sample County', state: STATES[c.st], postcode: c.zip, country: 'United States', country_code: 'us' },
    sample: true
  };
}

function reverse(u) {
  const lat = Number(u.searchParams.get('lat')), lng = Number(u.searchParams.get('lon'));
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: 'Unable to geocode' });
  const B = map();
  const h = B && B.nearestHouse(lat, lng, 45);
  if (h) return json(placeForHouse(h));
  const road = B && B.nearestRoad(lat, lng, 120);
  const c = cityParts();
  if (road) {
    return json({ lat: String(lat), lon: String(lng), type: 'residential', addresstype: 'road', display_name: road + ', ' + c.city + ', ' + STATES[c.st] + ' (sample street)',
      address: { road, city: c.city, state: STATES[c.st], postcode: c.zip, country_code: 'us' }, sample: true });
  }
  const l = nearestLead(lat, lng);
  if (!l) return json({ error: 'Unable to geocode' });
  return json({ lat: String(lat), lon: String(lng), type: 'city', addresstype: 'city', display_name: l.city + ', ' + (STATES[l.state] || l.state) + ' (sample area)',
    address: { city: l.city, state: STATES[l.state] || l.state, postcode: l.zip, country_code: 'us' }, sample: true });
}

function search(u) {
  const q = String(u.searchParams.get('q') || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (q.length < 3) return json([]);
  const B = map();
  const out = [];
  const num = (/^(\d+)/.exec(q) || [])[1];
  if (B) {
    for (const h of B.houses()) {
      const a = h.address.toLowerCase();
      if (q.indexOf(a) === 0 || (num && String(h.number) === num && q.indexOf(h.street.toLowerCase().split(' ')[0]) !== -1) || (!num && a.indexOf(q) !== -1)) out.push(placeForHouse(h));
      if (out.length >= 5) break;
    }
  }
  if (!out.length) {
    // The sample customers' own addresses (all invented).
    for (const [, l] of rawList('leads')) {
      if (!l || !l.address || typeof l.lat !== 'number') continue;
      if (String(l.address).toLowerCase().indexOf(q) === -1 && q.indexOf(String(l.address).toLowerCase().split(',')[0]) !== 0) continue;
      const m = /^(\d+)\s+([^,]+)/.exec(l.address) || [];
      out.push({ lat: String(l.lat), lon: String(l.lng), type: 'house', addresstype: 'building', display_name: l.address + ' (sample address)',
        address: { house_number: m[1] || '', road: m[2] || '', city: l.city, state: STATES[l.state] || l.state, postcode: l.zip, country_code: 'us' }, sample: true });
      if (out.length >= 5) break;
    }
  }
  return json(out);
}

function nwsPoints() {
  return json({ sample: true, properties: { county: 'https://api.weather.gov/zones/county/KYC037', forecastZone: 'https://api.weather.gov/zones/forecast/KYZ094',
    relativeLocation: { properties: { city: cityParts().city, state: cityParts().st } } } });
}
function nwsAlerts() {
  return json({ type: 'FeatureCollection', title: 'Sample alerts (not issued by the National Weather Service)', sample: true, features: reviveSeed(off().nwsAlerts || []) });
}
function stormReports(u) {
  const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
  const all = reviveSeed(off().reports || []);
  const near = (isFinite(lat) && isFinite(lon)) ? all.filter((e) => haversineMi(lat, lon, e.lat, e.lon) <= 30) : all;
  return json({ events: near, sample: true, source: 'Sample storm reports (not real NWS data)' });
}

const ROUTES = [
  [/^https:\/\/nominatim\.openstreetmap\.org\/reverse\b/, reverse],
  [/^https:\/\/nominatim\.openstreetmap\.org\/search\b/, search],
  [/^https:\/\/api\.weather\.gov\/points\//, nwsPoints],
  [/^https:\/\/api\.weather\.gov\/alerts\b/, nwsAlerts],
  // No sample outlook: an empty Storm Prediction Center layer, not a made-up one.
  [/^https:\/\/www\.spc\.noaa\.gov\/products\/outlook\//, () => json({ type: 'FeatureCollection', features: [], sample: true })],
  [/^\/api\/storm-report\b/, stormReports]
];

/** Answer one recognised request from sample data. demo-mode.js decides which URLs come here. */
export async function answer(url) {
  await ready();
  const raw = String(url);
  const u = new URL(raw, location.href);
  const key = u.origin === location.origin ? u.pathname + u.search : u.href;
  for (const [re, fn] of ROUTES) {
    if (re.test(key)) {
      const st = window.__NBD_DEMO__;
      if (st) { st.offlineAnswers = st.offlineAnswers || []; st.offlineAnswers.push({ url: key.slice(0, 200), at: Date.now() }); }
      return fn(u);
    }
  }
  return json({ error: 'not in the sample account', sample: true }, 404);
}

/** The sample "current position": the story customer's street. */
export function position() {
  const h = off().home || { lat: 39.0759, lng: -84.4468, accuracy: 12 };
  return { coords: { latitude: h.lat, longitude: h.lng, accuracy: h.accuracy || 12, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now(), sample: true };
}

/** window.callClaude in the sample account. */
export async function callClaude(req) {
  await ready();
  const isJoe = req && (req.toolset === 'joe-actions-v1' || req.feature === 'joe' || /Ask Joe|You are Joe/i.test(String(req.system || '')));
  if (isJoe) {
    const st = window.__NBD_DEMO__;
    if (st) { st.joeAnswers = (st.joeAnswers || 0) + 1; }
    return answerJoe(req);
  }
  const msg = 'AI features run on NBD Pro servers, so they are not in the sample account. Ask Joe has sample answers.';
  demoNotice(msg, { kind: 'ai' });
  throw new Error(msg);
}

// First load (and after Reset): Storm Center's zone and the "show me the
// storm" focus for the door-knocking map, in this tab's sample storage.
async function seedLocal() {
  await ready();
  const o = off();
  try {
    if (localStorage.getItem('nbd_storm_zones') === null && Array.isArray(o.stormZones)) {
      localStorage.setItem('nbd_storm_zones', JSON.stringify(reviveSeed(o.stormZones)));
    }
    if (o.swathBounds && localStorage.getItem('nbd_d2d_focus_bounds') === null) {
      localStorage.setItem('nbd_d2d_focus_bounds', JSON.stringify(o.swathBounds));
    }
  } catch (_) { /* storage blocked: Storm Center starts empty */ }
}

// The door-knocking map opens on Cincinnati (its built-in default) unless the
// one-shot hint above fits it to a storm. The sample account always opens on
// the story's storm: when a new D2D map appears and is still sitting on that
// default view (nobody has moved it), fit it to the swath. Belt and braces
// behind the hint, which a map rebuilt in the same visit has already used.
function watchD2dMap() {
  if (typeof window === 'undefined' || typeof setInterval !== 'function') return;
  let seen = null;
  setInterval(() => {
    const st = window._D2DState;
    const m = st && st.d2dMap;
    if (!m || m === seen) return;
    seen = m;
    setTimeout(() => {
      try {
        const b = off().swathBounds, c = m.getCenter();
        if (!b || st.d2dMap !== m) return;
        if (m.getZoom() === 13 && Math.abs(c.lat - 39.10) < 1e-6 && Math.abs(c.lng + 84.51) < 1e-6) {
          m.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [40, 40], maxZoom: 15 });
        }
      } catch (_) { /* map gone */ }
    }, 1500);
  }, 500);
}
watchD2dMap();

const api = { answer, position, callClaude, ready: seedLocal() };
if (typeof window !== 'undefined' && window.__NBD_DEMO__ && typeof window.__NBD_DEMO__.offlineLoaded === 'function') {
  window.__NBD_DEMO__.offlineLoaded(api);
}
export default api;
