/**
 * maps-core.js — Leaflet init, overlay state, geodetic helpers,
 * shared constants for the maps surface.
 *
 * Extracted from maps.js (Step 4d — 2026-05-16) as one of three
 * sibling modules. Load order is critical and locked in
 * dashboard.html:
 *
 *   core → overlays → routing → maps (shim)
 *
 * This file is loaded FIRST so every later split module + the shim
 * can rely on:
 *   - hav() / mid() — geodetic helpers (window.hav is also a hard
 *     dep of smart-calendar.js — preserved via the shim's window
 *     exports table)
 *   - PIN_LABELS / PIN_COLORS / STAGE_COLORS — pin colour palette
 *   - the module-state vars (mainMap, curPinStatus, curPinColor,
 *     pinMarkers, pinClusterGroup, overlayState, heatLayer,
 *     jobMarkers, stormTileLayer, pendingPin)
 *   - initMainMap() / toggleOverlay() / heat + pin show/hide
 *
 * Classic-script (non-ESM): every let/const declared at top level
 * here is a sibling-scope global readable by maps-overlays.js,
 * maps-routing.js, and the maps.js shim. Same pattern as
 * dashboard-state.js / crm-leads.js.
 */

// ══════════════════════════════════════════════
// GEODETIC HELPERS
// Haversine distance (returns feet; R is Earth radius in ft)
// and midpoint between two Leaflet latLng-like objects.
// Previously lived in dashboard.html — moved here so maps.js
// is self-contained and works across pages that load it.
// Kept as function declarations (not const) so they hoist
// above all callers below and match the original signatures.
// ══════════════════════════════════════════════
function hav(a, b) {
  const R = 20902231; // Earth radius in feet
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const aa = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}
function mid(a, b) {
  return L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
}
// Expose for any remaining callers still referencing the dashboard globals.
if (typeof window !== 'undefined') { window.hav = hav; window.mid = mid; }

// ══════════════════════════════════════════════
// MAIN MAP
// ══════════════════════════════════════════════
let mainMap, curPinStatus='not-home', curPinColor='#9CA3AF', pinMarkers={}, pinClusterGroup=null;
const PIN_LABELS = {'not-home':'Not Home','interested':'Interested','not-interested':'Not Interested','signed':'⭐ Signed','callback':'Callback','do-not-knock':'Do Not Knock','left-material':'Left Material','follow-up':'Follow Up'};
const PIN_COLORS = {'not-home':'#9CA3AF','interested':'#2ECC8A','not-interested':'#E05252','signed':'#D4A017','callback':'#4A9EFF','do-not-knock':'#374151','left-material':'#9B6DFF','follow-up':'#BD5728'};

// Stage colors for customer pins (matches kanban)
const STAGE_COLORS = {
  'New': '#9CA3AF',
  'Inspection': '#4A9EFF',
  'Estimate': '#D4A017',
  'Approved': '#9B6DFF',
  'In Progress': '#22C55E',
  'Complete': '#4ade80',
  'Lost': '#E05252'
};

// ══════════════════════════════════════════════
// MAP OVERLAY SYSTEM
// ══════════════════════════════════════════════
let overlayState = { heat:false, pins:true, jobs:false, storm:false, customers:false };
let heatLayer = null, jobMarkers = [], stormTileLayer = null;
let pendingPin = null; // { lat, lng, status, color } — waiting for confirm

function initMainMap() {
  // Re-entry guard: calling L.map() on an already-initialized container
  // throws "Map container is already initialized", which left the Maps view
  // broken when a second init raced the first (rapid tab taps — the caller's
  // mapInited flag is only set after an async waitForLeaflet → rAF chain).
  // The existing instance is fine; just remeasure it.
  if (mainMap) { try { mainMap.invalidateSize(); } catch (e) {} return; }
  mainMap = L.map('mainMap').setView([39.07,-84.17],14);
  // Esri World Imagery primary. Native z=19, upscale to 22. Esri free tier
  // returns sporadic 503s in burst conditions — on tileerror the failed tile
  // gets one retry on Esri's alternate host, and the public-domain USGS
  // orthoimagery (cached to z16, upscaled) sits underneath so a tile that
  // still fails shows imagery, not a hole. (Was a fallback to raw Google
  // mt*.google.com tiles until 2026-10-04 — vendor audit Lane D.)
  L.tileLayer(
    'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'USGS/NAIP', maxNativeZoom: 16, maxZoom: 22 }
  ).addTo(mainMap);
  const sat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '© Esri, Maxar, Earthstar Geographics', maxNativeZoom: 19, maxZoom: 22 }
  );
  sat.on('tileerror', function (ev) {
    if (!ev.tile) return;
    if (ev.tile.dataset.nbdFallbackTried === '1') return;
    ev.tile.dataset.nbdFallbackTried = '1';
    const src = String(ev.tile.src || '');
    if (src.indexOf('https://server.arcgisonline.com/') === 0) {
      ev.tile.src = 'https://services.arcgisonline.com/' + src.slice('https://server.arcgisonline.com/'.length);
    }
  });
  sat.addTo(mainMap);
  // Initialize marker cluster group for performance with many pins
  if(typeof L.markerClusterGroup === 'function') {
    pinClusterGroup = L.markerClusterGroup({ maxClusterRadius:50, spiderfyOnMaxZoom:true, showCoverageOnHover:false, zoomToBoundsOnClick:true, disableClusteringAtZoom:18 });
    mainMap.addLayer(pinClusterGroup);
  }
  // Click = show confirm dialog instead of instant drop. Suppressed while
  // drawing a territory zone — otherwise every vertex click ALSO pops the
  // pin-confirm overlay and can silently save stray pins (NEW-D37).
  mainMap.on('click', e => {
    if (zoneDrawing) return;
    openPinConfirm(e.latlng.lat, e.latlng.lng);
  });
  if(window._pins) window._pins.forEach(p => addPinMarker(p));
  // Build heat + jobs layers from existing data
  setTimeout(()=>{ buildHeatLayer(); buildJobsLayer(); updatePinStats(); if(overlayState.pins && typeof renderPinDispPanel==='function') renderPinDispPanel(); if(typeof window.renderSavedZones==='function') window.renderSavedZones(); }, 400);
}

// ── OVERLAY TOGGLE ──────────────────────────────
function toggleOverlay(type, el) {
  overlayState[type] = !overlayState[type];
  el.classList.toggle('on', overlayState[type]);
  if(type==='heat')    { overlayState.heat    ? showHeatLayer()    : hideHeatLayer();    }
  if(type==='pins')    { if(overlayState.pins){ showAllPins(); if(typeof renderPinDispPanel==='function') renderPinDispPanel(); } else { hideAllPins(); if(typeof hidePinDispPanel==='function') hidePinDispPanel(); } }
  if(type==='jobs')    { overlayState.jobs    ? showJobsLayer()    : hideJobsLayer();    }
  if(type==='customers'){overlayState.customers? showCustomersLayer(): hideCustomersLayer();}
  if(type==='storm')   { overlayState.storm   ? showStormLayer()   : hideStormLayer();   }
}

// ── HEAT MAP ─────────────────────────────────────
// Per-point intensity so the heat surfaces where the MONEY / intent is, not
// just where knocks landed: a pin linked to a lead weights by that deal's $
// tier; an unlinked door-knock weights by disposition (signed hot → not-home
// cold). Falls back to a mid weight when nothing is known.
const _DISPO_HEAT = { 'signed':1.0, 'interested':0.75, 'follow-up':0.6, 'callback':0.6, 'left-material':0.5, 'not-home':0.25, 'not-interested':0.12, 'do-not-knock':0.1 };
function _pinHeatWeight(p) {
  if (p && p.leadId && Array.isArray(window._leads)) {
    const lead = window._leads.find(l => l && l.id === p.leadId);
    if (lead) {
      const v = parseFloat(lead.jobValue || lead.value || lead.contractValue || 0) || 0;
      if (v >= 50000) return 1.0;
      if (v >= 25000) return 0.85;
      if (v >= 10000) return 0.65;
      if (v > 0) return 0.5;
    }
  }
  if (p && p.status && _DISPO_HEAT[p.status] != null) return _DISPO_HEAT[p.status];
  return 0.4;
}
function buildHeatLayer() {
  if(!mainMap || !window._pins) return;
  const pts = window._pins.map(p => [p.lat, p.lng, _pinHeatWeight(p)]);
  if(heatLayer) mainMap.removeLayer(heatLayer);
  if(pts.length === 0) return;
  heatLayer = L.heatLayer(pts, {
    radius:28, blur:22, maxZoom:17,
    gradient:{0.3:'#4A9EFF', 0.5:'#EAB308', 0.75:'#FF6B35', 1.0:'#E05252'}
  });
  if(overlayState.heat) heatLayer.addTo(mainMap);
}
function showHeatLayer() { if(!heatLayer){ buildHeatLayer(); return; } heatLayer.addTo(mainMap); }
function hideHeatLayer() { if(heatLayer) mainMap.removeLayer(heatLayer); }
function refreshHeatLayer() { buildHeatLayer(); }

// ── PINS SHOW/HIDE ───────────────────────────────
// With clustering on (prod), markers live in pinClusterGroup — NOT directly on
// the map — so the old per-marker addTo/removeLayer left the cluster copies
// untouched and the "Pins" toggle silently did nothing (hide was a no-op; show
// double-added an unclustered copy). Toggle the cluster group as a whole; fall
// back to per-marker only when the cluster plugin is absent. The disposition
// filter's in/out-of-group membership is preserved either way.
function showAllPins() {
  if (pinClusterGroup) { if (mainMap && !mainMap.hasLayer(pinClusterGroup)) mainMap.addLayer(pinClusterGroup); }
  else { Object.values(pinMarkers).forEach(m=>m.addTo(mainMap)); }
}
function hideAllPins() {
  if (pinClusterGroup) { if (mainMap && mainMap.hasLayer(pinClusterGroup)) mainMap.removeLayer(pinClusterGroup); }
  else { Object.values(pinMarkers).forEach(m=>mainMap.removeLayer(m)); }
}
