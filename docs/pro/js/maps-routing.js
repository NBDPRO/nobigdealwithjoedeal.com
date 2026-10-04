/**
 * maps-routing.js — drawing-tool surface for the maps module:
 * drawing tool v2 (line / perimeter / E-R / gutter modes),
 * draggable dots, snap, structures / facets / segments,
 * save+load to Firestore, accessories, solar overlay,
 * Xactimate export, comparison mode, shadow / voice /
 * presentation / auto-detect "WOW features".
 *
 * Extracted from maps.js (Step 4d — 2026-05-16) as the
 * drawing-tool sibling of maps-core.js and maps-overlays.js.
 * Load order in dashboard.html is:
 *
 *   core → overlays → routing → maps (shim)
 *
 * Depends on the sibling-scope globals declared in maps-core.js
 * (mainMap, hav, mid, …) and helpers reachable as classic-script
 * globals (showToast, geocode, openLeadModal, goTo, …) — reads of
 * those resolve fine from inside the module IIFE.
 *
 * Globals Tranche 2c-2 (2026-07-06): the file body is wrapped in ONE
 * top-level IIFE, so its ~150 top-level declarations left the global
 * scope. `drawMap` alone stays a top-level `let` (bare-read at runtime
 * by dashboard-actions.js / dashboard-ui.js / dashboard-sw-bootstrap.js).
 * The deliberate window surface is the export block at the BOTTOM of
 * this file (names other dispatchers or files resolve via window);
 * the 21 markup-dispatched drawing handlers are registered in
 * __NBD_CALL_REGISTRY there instead of living on window.
 */

// ══════════════════════════════════════════════
// DRAW MAP
// ══════════════════════════════════════════════
// drawMap stays a top-level global `let` (NOT inside the module IIFE):
// dashboard-actions.js (ensureMapSize after view init), dashboard-ui.js
// (spyglass result jump) and dashboard-sw-bootstrap.js (diagnostics)
// all read it as a bare sibling-scope name at runtime. Everything else
// in this file lives in module scope below (Globals Tranche 2c-2).
let drawMap;

(function () {
// ══════════════════════════════════════════════
// DRAWING TOOL v2 — multi-facet, save/restore, drag, snap, shortcuts
// ══════════════════════════════════════════════
let _NBD_MR_DELEGATE_BOUND, _presentSteps, _perimClosing; // module-local (globals Tranche 1 — was window.*)
let drawOn=false, drawStart=null, drawLT=0, drawnLines=[], tempLine=null, tempLbl=null;
let drawMode = 'line'; // 'line' | 'perim' | 'er' | 'gutter'

const LT = [
  {n:'Ridge',      color:'#22C55E', dash:null},
  {n:'Ridge Vent', color:'#86EFAC', dash:'8,4'},
  {n:'Hip',        color:'#06B6D4', dash:null},
  {n:'Valley',     color:'#3B82F6', dash:null},
  {n:'Rake',       color:'#EC4899', dash:'8,5'},
  {n:'Eave',       color:'#BE185D', dash:null},
  {n:'Flashing',   color:'#F97316', dash:'4,3'},
  {n:'Step Flash', color:'#EAB308', dash:'4,3'},
  {n:'Drip Edge',  color:'#1D4ED8', dash:null},
  {n:'Parapet',    color:'#92400E', dash:null},
  {n:'Gutters',    color:'#06B6D4', dash:'10,4'}
];

// Multi-facet state
const FACET_COLORS = ['#22C55E','#3B82F6','#F97316','#A855F7','#EC4899','#EAB308','#06B6D4','#EF4444'];
let facets = []; // [{points, dots, segments, closed, polygon, baseArea, closeRing, pitch, label}]
let activeFacetIdx = -1; // -1 = no active facet

// Current perimeter state (points into active facet)
let perimPoints   = [];
let perimDots     = [];
let perimSegments = [];
let perimClosed   = false;
let perimPendingP1 = null;
let perimPendingP2 = null;
let perimPolygon   = null;
let perimBaseArea  = 0;
let perimCloseRing = null;

// Gutter state (separate from perim). gutterPoints / gutterDots are the OPEN
// run only; gutterRunId is its id (null = no run open). 2026-09-25 (draw lane
// L2, audit B5): there used to be no run at all — every gutter tap chained
// onto the last point ever placed, so a second run started with a fake
// segment bridging from the first (81.8 real ft read 121.4 ft, 3 downspouts
// became 4). A run now ends on Finish run, Enter, a tap on its last point,
// Stop, or a mode / structure switch, and every segment carries its runId.
let gutterPoints = [];
let gutterDots   = [];
let gutterRunId  = null;

// Line select
let selectedLineId = null;

// Map layers
let drawMapLayers = {};
let currentLayerType = 'satellite';

// Snap — a desktop click (and, while the crosshair is off, a finger tap)
// joins the corner within 12 px. Unchanged by L3.
const SNAP_PX = 12;

// ── Draw lane L3 (2026-09-25) — the crosshair-ready engine seam ──
// Phones are moving to "move the map, not your finger": a fixed crosshair
// at the map's centre, and an Add button (docs/pro/js/draw-reticle.js, lane
// L4) that places the point under it. This file owns the engine side:
// drawMap.nbdDraw (the seam, see _seam at the bottom of initDrawMap), the
// shared-corner mover, the crosshair map mode, the live preview and the
// guards. Nothing new goes on window (globals-surface-snapshot).
// Crosshair-placed points snap to a corner within 16 px, capped at 3 ft of
// ground (so 7.9 px at z20, 15.8 px at z21 over Cincinnati), and not at all
// when that radius is under 4 px — below ~z19 the ring the UI draws would
// be invisible, and an invisible snap is how a point lands on the wrong
// corner (the plan rejected the 24 px blind snap for that reason).
const RETICLE_SNAP_PX = 16, RETICLE_SNAP_FT = 3, RETICLE_SNAP_MIN_PX = 4;
// Add is refused within 6 px of the last point: no 0 ft segments, and no
// accidental "finish" from a double press.
const SAME_SPOT_PX = 6;
// A desktop mouse grabs the nearest corner within 8 px — our own hit test,
// so a dot grabbed dead-centre drags even where a line or label sits on it.
const VERTEX_GRAB_PX = 8;
// pointer:coarse at init (a phone or tablet). Crosshair mode exists only
// there; desktop keeps click-to-place (Jo, decision 4).
let _coarse = false;
// Crosshair mode is OFF until the crosshair screen (L4) switches it on with
// nbdDraw.setCrosshair(true): without that screen a phone would have no Add
// button, and Jo test-drives it on his iPhone before it goes to everyone
// (decision 8). Off = today's tap-to-place, exactly.
let _crosshair = false;
let _crosshairSaved = null; // map options to put back when it goes off
// The edge type a crosshair-placed perimeter edge commits as (sticky until
// changed; the desktop still asks with #reChooser after every edge).
let _stickyEdge = 'eave';
// movestart → moveend (a pan, a glide, an aim, a fly-to).
let _moveActive = false;
// A tap-to-aim pan in flight: {latlng, ts, inFlight}.
let _aim = null;
// Last finger contact on the map, so the compatibility mousemove a tap
// produces never paints a desktop preview (it used to arrive AFTER the
// point with the rAF preview below and leave a "0.0 ft" chip on it).
let _lastTouchTs = 0;
// on('change' | 'preview') subscribers.
const _seamListeners = { change: [], preview: [] };
let _changeQueued = false;
// The one live preview (dashed segment + length chip), reused frame to frame.
let _pvRaf = 0, _pvArg = null;

// Multi-structure support. 2026-09-25 (L2, Jo's decision 3): real
// per-structure drawings. Every line, facet and accessory carries the
// structureId it was drawn on and stays on the map; switching only changes
// where NEW geometry goes. (It used to wipe the drawing — "simplified: just
// clear" — with no way back, audit B6.) There is always at least one.
let structures = [{ id: 1, name: 'Structure 1' }];
let activeStructureId = 1;

// ── Draw lane L2 (2026-09-25) — ids, pending taps, undo ──
// Line ids are integers from this sequence. They were Date.now()+Math.random()
// decimals, and the list / popup handlers parseInt()'d them, so Delete,
// retype and row select silently matched nothing (audit B3).
let _nextLineId = 1, _nextRunId = 1, _nextFacetId = 1, _nextStructId = 2;
// Line mode's first tap is pending until the second; perimeter corners are
// pending until Eave/Rake is chosen. Their dots, and whether this tap made
// the dot (a snapped tap reuses a corner's existing dot, which must survive
// a cancel).
let drawStartDot = null, drawStartDotNew = false;
let perimPendingDot = null, perimPendingDotNew = false;
// Every draggable dot on the map, so a tap on an existing corner reuses its
// dot and a drag moves every line that meets there.
let _allDots = [];
// Undo / Redo: whole-drawing snapshots (the autosave payload) taken before
// each action — a point, an edge, a close, a finished run, a move, a retype,
// a flip, a delete, a clear, an accessory. The old undoLine() removed the
// last LINE of any type plus the current mode's last dot, so it deleted
// finished work while a pending point survived (audit H6).
const _undoStack = [], _redoStack = [];
const UNDO_MAX = 60;
// Jo's decision 7: rake / hip / valley go to the estimate slope-corrected,
// shown beside the flat feet, behind one switch — default ON.
let slopeLfOn = true;
const SLOPE_PREF_KEY = 'nbd_draw_slope_lf';

// Shadow pitch estimation
let shadowMode = false;
let shadowLine = null; // The shadow line drawn by user
let shadowEdgeLine = null; // The corresponding roof edge

// Voice control
let voiceRecognition = null;
let voiceActive = false;

// Historical imagery
let historyLayerOld = null;
let historySliderActive = false;

// Presentation mode
let presentationActive = false;
let presentationStep = 0;

// Edge auto-detect
let autoDetectActive = false;

// Comparison mode
let comparisonData = null; // Parsed external report data

function initDrawMap() {
  // Guard: if already initialized, just refresh the size
  if (drawMap) { drawMap.invalidateSize(); return; }

  // Ensure the container is visible before Leaflet measures it.
  // In Safari standalone, there can be a paint delay between
  // classList.add('active') and the element actually being visible.
  const container = document.getElementById('drawMap');
  if (!container) { console.error('drawMap container not found'); return; }

  // maxZoom set on the map itself enforces a HARD STOP — Leaflet refuses
  // to zoom past this regardless of user input. Previously the user could
  // zoom to 22 even though no provider had tiles at 20+, which surfaced
  // Esri's "This map is not yet available at this zoom level" placeholder
  // tile.
  // 2026-09-25 (draw lane L3): 22, one step past Google's native 21, so a
  // corner can be aimed at 0.095 ft/px. Every layer below declares its
  // maxNativeZoom, so z22 shows the z21 (or z19) tiles upscaled — softer,
  // never a placeholder. Capped at 22: past that the upscale is mush.
  try { _coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { _coarse = false; }
  const mapOpts = { preferCanvas: true, maxZoom: 22 };
  // A finger is not a mouse: on coarse pointers the canvas hit-tests lines
  // and dots with 10 px of slack (Leaflet's `tolerance`), so a tap on a thin
  // edge (Eave/Rake flip, the line popup) lands.
  if (_coarse) mapOpts.renderer = L.canvas({ tolerance: 10 });
  drawMap = L.map('drawMap', mapOpts).setView([39.07,-84.17],20);

  // Google satellite primary — Brave Shields blocks `server.arcgisonline.com`
  // at the network layer (instant onerror → SW returns synthetic 503 → black
  // tiles). Google's `mt{s}.google.com` is on every tracker-blocker
  // allowlist AND supports higher native zoom (21 universal vs Esri's 19),
  // so the drawing tool gets crisp imagery at the deepest zoom rather than
  // an upscaled blur. Esri stays as a per-tile fallback for the rare case
  // Google rate-limits a tile, but only at z<=19 where Esri actually has
  // imagery — beyond that the failed tile just stays blank rather than
  // showing Esri's "not available" placeholder.
  const GOOGLE_SAT_TILE = 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
  const ESRI_TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const ESRI_FALLBACK = (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  const GOOGLE_ATTR = 'Imagery © Google';

  function attachFallback(layer) {
    layer.on('tileerror', function (ev) {
      if (!ev.tile || !ev.coords) return;
      if (ev.tile.dataset.nbdFallbackTried === '1') return; // give up after one retry
      ev.tile.dataset.nbdFallbackTried = '1';
      // Esri caps at z=19; beyond that the fallback would just surface the
      // "not available" placeholder, so we leave the failed tile blank.
      if (ev.coords.z > 19) return;
      ev.tile.src = ESRI_FALLBACK(ev.coords.z, ev.coords.x, ev.coords.y);
    });
    return layer;
  }

  drawMapLayers.satellite = attachFallback(L.tileLayer(GOOGLE_SAT_TILE, {
    subdomains: '0123', attribution: GOOGLE_ATTR, maxNativeZoom: 21, maxZoom: 22
  }));
  drawMapLayers.street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxNativeZoom:19,maxZoom:22});
  drawMapLayers.hybrid = L.layerGroup([
    attachFallback(L.tileLayer(GOOGLE_SAT_TILE, { subdomains: '0123', maxNativeZoom: 21, maxZoom: 22 })),
    // Place labels overlay still uses Esri Reference; tops out at z=19 and is
    // semi-transparent (opacity:0.75) so missing tiles at z>19 are unnoticeable.
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 19, maxZoom: 22, opacity: 0.75 }
    )
  ]);
  drawMapLayers.satellite.addTo(drawMap);
  currentLayerType = 'satellite';

  // Force Leaflet to recalculate container size multiple times.
  // In Safari standalone/web app mode, the container reports
  // zero dimensions during the first few paint frames even though
  // the CSS has been applied. Without these retries, tiles load
  // but appear as grey squares or don't appear at all.
  setTimeout(function() { if(drawMap) drawMap.invalidateSize(); }, 100);
  setTimeout(function() { if(drawMap) drawMap.invalidateSize(); }, 500);
  setTimeout(function() { if(drawMap) drawMap.invalidateSize(); }, 1500);

  // 2026-09-25 (draw lane L3): the orange "✏️ DRAW MODE / 🗺️ NAVIGATE"
  // button that sat here on every touch device is gone. It never did what
  // it said: toggleDraw() checked `typeof drawNavMode`, a name local to this
  // function, so Draw mode never actually stopped the map panning — and a
  // phone's taps placed points and its pans panned in BOTH states (audit
  // H1/H2). One-finger panning is simply always on now; the crosshair
  // screen (L4) replaces the idea with "move the map, not your finger".

  drawMap.on('click', e => {
    // A tap's rAF preview must never land after the point it previewed.
    _cancelPreviewFrame();
    // Crosshair mode (L3): a real tap only AIMS — it slides the tapped spot
    // under the crosshair and never places a point. Points come from the
    // crosshair screen's Add, which fires this same event tagged
    // nbdReticle (placeAtReticle below), so every mode's handler — line,
    // perimeter, gutter, accessory, Shadow Pitch, Auto-Detect — is reached
    // exactly as a desktop click reaches it.
    if(_crosshair && !e.nbdReticle) { _aimAt(e.latlng); return; }
    if(shadowMode) { handleShadowClick(e.latlng); return; }
    // Accessory placement mode takes priority
    if(accessoryMode) { placeAccessory(e.latlng); return; }
    if(!drawOn) return;
    // A crosshair point arrives already snapped by the crosshair's own rule
    // (the one its preview used), so the committed length IS the previewed
    // length; a click still takes the 12 px desktop snap.
    const snapped = e.nbdReticle ? e.latlng : snapToVertex(e.latlng);
    if(drawMode === 'line') handleLineClick(snapped);
    else if(drawMode === 'perim') handlePerimClick(snapped, e.nbdReticle ? e.nbdEdge : null);
    else if(drawMode === 'gutter') handleGutterClick(snapped, !!e.nbdReticle);
  });

  // Desktop preview: the dashed segment follows the mouse. rAF-throttled and
  // drawn into ONE reused polyline + chip (L3) — it used to remove and
  // re-create both layers on every mousemove.
  drawMap.on('mousemove', e => {
    if(!drawOn || _crosshair) return;
    if(Date.now() - _lastTouchTs < 800) return; // a tap's compatibility mousemove
    _queuePreview(e.latlng);
  });
  // Motion bookkeeping for the guards (placeAtReticle, state().moving).
  drawMap.on('movestart', () => { _moveActive = true; if (_crosshair) _emitChange(); });
  drawMap.on('moveend', () => {
    _moveActive = false;
    if (_aim) _aim.inFlight = false;
    if (_crosshair) _emitChange();
  });
  (function () {
    const c = drawMap.getContainer();
    const touched = () => { _lastTouchTs = Date.now(); };
    c.addEventListener('touchstart', touched, { passive: true });
    c.addEventListener('touchend', touched, { passive: true });
  })();
  _bindVertexDrag();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='textarea'||tag==='select') return;
    const active = document.getElementById('view-draw');
    if(!active || active.style.display==='none' || !active.offsetParent) return;
    if(e.key==='d'||e.key==='D') { e.preventDefault(); toggleDraw(); }
    // Shift+Z = Redo, Z = Undo (2026-09-25, L2 — Redo is new).
    else if((e.key==='z'||e.key==='Z') && e.shiftKey) { e.preventDefault(); redoLine(); }
    else if(e.key==='z'||e.key==='Z') { e.preventDefault(); undoLine(); }
    else if(e.key==='Enter' && drawMode==='gutter' && gutterRunId !== null) { e.preventDefault(); finishGutterRun(); }
    else if(e.key==='c'&&!e.ctrlKey&&!e.metaKey) { e.preventDefault(); clearDraw(); }
    else if(e.key==='Escape') { e.preventDefault(); if(drawOn) toggleDraw(); }
    else if(e.key>='1'&&e.key<='9') { const i=parseInt(e.key)-1; if(i<LT.length){ const btn=document.querySelectorAll('.lt-btn')[i]; if(btn) selLT(i,btn); }}
    else if(e.key==='f'||e.key==='F') { e.preventDefault(); zoomToFit(); }
  });

  // Show shortcut hint briefly (keyboards only — see showShortcutHint)
  showShortcutHint();
  // "Tap" on a phone, "Click" with a mouse (L3).
  _applyPointerCopy();

  // Jo's slope switch: a per-viewer preference, default ON.
  try { slopeLfOn = localStorage.getItem(SLOPE_PREF_KEY) !== '0'; } catch (e) { slopeLfOn = true; }
  const slopeBox = document.getElementById('slopeLfToggle');
  if (slopeBox) slopeBox.checked = slopeLfOn;

  // Try restore previous drawing
  tryRestoreDrawing();

  renderStructureList();
  recalc();

  // The engine seam (draw lane L3). It lives ON the map object — never on
  // window — and is announced once, when the map is ready, so the crosshair
  // screen (L4, loaded after this file in the drawtool bundle) can start
  // whichever comes first: this event, or finding drawMap.nbdDraw already
  // set. Last in init on purpose: its presence means init finished.
  drawMap.nbdDraw = _seam;
  try {
    document.dispatchEvent(new CustomEvent('nbd:drawmap-ready', { detail: { map: drawMap, api: _seam } }));
  } catch (e) { console.warn('[maps-routing] nbd:drawmap-ready listener threw:', e && e.message); }
}

function showShortcutHint() {
  // A phone has no keyboard: the hint (D / Z / C / F / 1-9) is for mice (L3).
  if (_coarse) return;
  try { if(localStorage.getItem('nbd_draw_hint_shown')) return; } catch (e) { return; }
  const hint = document.createElement('div');
  hint.className = 'draw-shortcut-hint';
  hint.innerHTML = '<b>Shortcuts:</b> D=Draw Z=Undo Shift+Z=Redo C=Clear F=Fit 1-9=Type Esc=Cancel';
  const area = document.querySelector('#view-draw .map-area');
  if(area) { area.appendChild(hint); setTimeout(()=>{ hint.style.opacity='0'; setTimeout(()=>hint.remove(),500); },6000); }
  try { localStorage.setItem('nbd_draw_hint_shown','1'); } catch (e) { /* storage blocked */ }
}

// ── POINTER-TYPE COPY (2026-09-25, draw lane L3) ──
// The Draw view's help text said "click" on every phone. _tap('Click the
// roof') returns "Tap the roof" on a coarse pointer; the drawer's static
// hints are rewritten once at init the same way.
function _tap(s) {
  return _coarse ? String(s).replace(/\bClick\b/g, 'Tap').replace(/\bclick\b/g, 'tap') : String(s);
}
function _perimIdleHint() {
  return _tap('⬡ Perimeter mode — click map to trace. Click first dot to close.');
}
function _applyPointerCopy() {
  if (!_coarse) return;
  const pb = document.getElementById('perimBar');
  if (pb && !facets.length) pb.textContent = _perimIdleHint();
  const er = document.getElementById('erBar');
  if (er && er.firstChild && er.firstChild.nodeType === 3) er.firstChild.textContent = _tap(er.firstChild.textContent);
}

// ── SNAP TO VERTEX ──────────────────────────────
function snapToVertex(latlng) {
  if(!drawMap) return latlng;
  const screenPt = drawMap.latLngToContainerPoint(latlng);
  let best = null, bestDist = SNAP_PX+1;
  // Check all existing dots/points
  const allPts = [];
  drawnLines.forEach(l => {
    if(l.p1) allPts.push(l.p1);
    if(l.p2) allPts.push(l.p2);
  });
  facets.forEach(f => f.points.forEach(p => allPts.push(p)));
  gutterPoints.forEach(p => allPts.push(p));
  perimPoints.forEach(p => allPts.push(p));

  allPts.forEach(p => {
    const sp = drawMap.latLngToContainerPoint(p);
    const dx = sp.x - screenPt.x, dy = sp.y - screenPt.y;
    const d = Math.sqrt(dx*dx + dy*dy);
    if(d < bestDist) { bestDist = d; best = p; }
  });
  return best || latlng;
}

// ═══════════════════════════════════════════════════════════════════
// DRAW LANE L3 (2026-09-25) — THE CROSSHAIR-READY ENGINE
// ═══════════════════════════════════════════════════════════════════
// Everything the crosshair screen (L4) drives, and the corner mover the
// desktop mouse now shares with it. The public face is `_seam` (published
// as drawMap.nbdDraw at the end of initDrawMap); the rest is module-private.

// ── Corners (the shared-vertex registry) ──
// A corner is a POSITION. Every line end, facet corner, open-outline point
// and gutter-run point at the same spot (within 1e-7 deg, ~1 cm — the
// tolerance restore already merges on) is one vertex, and moving it moves
// all of them. A snapped point lands EXACTLY on the corner it snapped to, so
// snapping is what makes a corner shared; the dots are only its handle.
function _vertexList() {
  const out = [];
  const add = p => { if (p && !out.some(q => _sameLL(q, p))) out.push(p); };
  drawnLines.forEach(l => { add(l.p1); add(l.p2); });
  facets.forEach(f => f.points.forEach(add));
  perimPoints.forEach(add);
  gutterPoints.forEach(add);
  if (drawStart) add(drawStart);
  return out;
}
// Nearest corner to a container point within r px (exclude: a position to
// skip, e.g. the corner being moved).
function _nearestVertex(cp, r, exclude) {
  let best = null;
  _vertexList().forEach(p => {
    if (exclude && _sameLL(p, exclude)) return;
    const d = drawMap.latLngToContainerPoint(p).distanceTo(cp);
    if (d <= r && (!best || d < best.px)) best = { latlng: p, px: d };
  });
  return best;
}
function _llOf(x) {
  if (!x) return null;
  if (Array.isArray(x)) return Number.isFinite(x[0]) && Number.isFinite(x[1]) ? L.latLng(x[0], x[1]) : null;
  const lat = Number(x.lat), lng = Number(x.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? L.latLng(lat, lng) : null;
}
function _plainLL(p) { return p ? { lat: p.lat, lng: p.lng } : null; }

// Crosshair snap radius in px at the current zoom (see RETICLE_SNAP_*): 0
// when snapping is off at this zoom.
function _reticleSnapPx() {
  if (!drawMap) return 0;
  const c = drawMap.getCenter();
  const ftpx = window.NBDDrawGeom.ftPerPx(c.lat, drawMap.getZoom());
  const r = Math.min(RETICLE_SNAP_PX, RETICLE_SNAP_FT / ftpx);
  return r >= RETICLE_SNAP_MIN_PX ? r : 0;
}
// Where a crosshair point at `latlng` would land: on the nearest corner
// within `radius` px, or exactly where it is.
function _snapInfo(latlng, radius, exclude) {
  const ll = L.latLng(latlng);
  const r = Number.isFinite(radius) ? radius : _reticleSnapPx();
  const hit = r > 0 ? _nearestVertex(drawMap.latLngToContainerPoint(ll), r, exclude) : null;
  return hit ? { latlng: hit.latlng, snapped: true, px: hit.px, radius: r } : { latlng: ll, snapped: false, px: 0, radius: r };
}
// The crosshair: the map centre. getCenter() is exact after a setView (the
// crosshair screen centres the map on a fine-tuned point, then places), and
// equals containerPointToLatLng(size/2) while a finger pans.
function _reticleLatLng() { return drawMap.getCenter(); }

// ── Live preview ──
// What the next point would add: the segment from the anchor (the Line
// start, the outline's last corner, the gutter run's last point) to the
// target, and the run so far. `rule` picks the snap: 'reticle' (the
// crosshair's own rule, used by the seam and placeAtReticle so the
// committed length IS the previewed length), 'click' (the 12 px desktop
// snap, for the mouse preview) or 'none'.
function _anchorInfo() {
  if (drawMode === 'line' && drawStart) return { anchor: drawStart, runFt: 0, color: LT[drawLT].color };
  if (drawMode === 'perim' && perimPoints.length && !perimPendingP2) {
    return { anchor: perimPoints[perimPoints.length - 1], runFt: perimSegments.reduce((s, l) => s + l.dist, 0), color: '#BE185D', canClose: perimPoints.length >= 3 };
  }
  if (drawMode === 'gutter' && gutterPoints.length) {
    const run = gutterRunId === null ? 0 : drawnLines.filter(l => l.type === 10 && l.runId === gutterRunId).reduce((s, l) => s + l.dist, 0);
    return { anchor: gutterPoints[gutterPoints.length - 1], runFt: run, color: '#06B6D4' };
  }
  return null;
}
function _previewCalc(latlng, rule) {
  const raw = latlng ? L.latLng(latlng) : _reticleLatLng();
  const a = drawOn && !accessoryMode && !shadowMode ? _anchorInfo() : null;
  let target = raw, snapped = false;
  if (rule === 'click') { target = snapToVertex(raw); snapped = target !== raw; }
  // The crosshair never snaps back onto the point the segment starts from:
  // that is a 0 ft segment, and it would make every point within 16 px of
  // the last one impossible (a 2 ft gutter return at z21). 6 px is the
  // same-spot guard's job.
  else if (rule !== 'none') { const s = _snapInfo(raw, undefined, a ? a.anchor : null); target = s.latlng; snapped = s.snapped; }
  if (!a) return { anchor: null, target, snapped, segmentFt: 0, runFt: 0, px: Infinity, closes: false, color: null };
  const segmentFt = hav(a.anchor, target);
  const closes = !!a.canClose && _sameLL(target, perimPoints[0]);
  const px = drawMap.latLngToContainerPoint(a.anchor).distanceTo(drawMap.latLngToContainerPoint(target));
  return { anchor: a.anchor, target, snapped, segmentFt, runFt: a.runFt + segmentFt, px, closes, color: a.color };
}
function _publicPreview(p) {
  return {
    anchor: _plainLL(p.anchor), target: _plainLL(p.target), snapped: !!p.snapped,
    segmentFt: p.segmentFt, runFt: p.runFt, closes: !!p.closes,
    sameSpot: !!p.anchor && !p.closes && p.px < SAME_SPOT_PX
  };
}
// The desktop mouse preview: one paint per animation frame, whatever the
// mousemove rate. (The crosshair screen paints its own preview through
// nbdDraw.preview, once per frame of its own — the engine does not also
// follow the map, or the two would fight over the one band.)
function _queuePreview(latlng) {
  _pvArg = latlng;
  if (_pvRaf) return;
  _pvRaf = requestAnimationFrame(() => { _pvRaf = 0; if (_pvArg) _renderPreview(_pvArg, 'click'); });
}
function _cancelPreviewFrame() {
  if (_pvRaf) { cancelAnimationFrame(_pvRaf); _pvRaf = 0; }
}
function _hidePreview() {
  if (tempLine) { drawMap.removeLayer(tempLine); tempLine = null; }
  if (tempLbl)  { drawMap.removeLayer(tempLbl);  tempLbl  = null; }
}
// Paint the band anchor → target into the ONE reused polyline + chip
// (setLatLngs; the chip's icon is rebuilt only when its text changes), and
// return what was painted. Canvas redraws batch per frame in Leaflet.
function _renderPreview(latlng, rule) {
  if (!drawMap) return null;
  const p = _previewCalc(latlng, rule);
  if (!p.anchor || p.px < SAME_SPOT_PX) {
    _hidePreview();
  } else {
    const pts = [p.anchor, p.target];
    const html = `<div class="meas-label">${p.segmentFt.toFixed(1)} ft</div>`;
    if (tempLine) { tempLine.setLatLngs(pts); if (tempLine.options.color !== p.color) tempLine.setStyle({ color: p.color }); }
    else tempLine = L.polyline(pts, { color: p.color, weight: 3, dashArray: '6,4', opacity: .7, interactive: false }).addTo(drawMap);
    if (tempLbl) {
      tempLbl.setLatLng(mid(p.anchor, p.target));
      if (tempLbl._nbdHtml !== html) { tempLbl.setIcon(L.divIcon({ html, className: '', iconAnchor: [0, 10], iconSize: null })); tempLbl._nbdHtml = html; }
    } else {
      tempLbl = L.marker(mid(p.anchor, p.target), { interactive: false, keyboard: false, icon: L.divIcon({ html, className: '', iconAnchor: [0, 10], iconSize: null }) }).addTo(drawMap);
      tempLbl._nbdHtml = html;
    }
  }
  const pub = _publicPreview(p);
  _emit('preview', pub);
  return pub;
}

// ── Motion guards ──
// A finger still dragging, a pinch, or a zoom animation: a point placed now
// would land wherever the map happens to be mid-gesture.
function _gestureActive() {
  if (!drawMap) return false;
  const d = drawMap.dragging && drawMap.dragging._draggable;
  return !!((d && d._moving) || (drawMap.touchZoom && drawMap.touchZoom._zooming) || drawMap._animatingZoom);
}

// ── Tap-to-aim (crosshair mode) ──
// A tap slides the tapped spot under the crosshair (a 0.2 s glide; Leaflet
// truncates the pan to whole pixels, so it lands within 1 px). The second
// tap of a double-tap finishes the first glide at once, so Leaflet's
// double-tap zoom ('center' in this mode) zooms around the spot aimed at.
function _aimAt(latlng) {
  const now = Date.now();
  if (_aim && now - _aim.ts < 350) {
    if (_aim.inFlight) { drawMap.setView(_aim.latlng, drawMap.getZoom(), { animate: false }); _aim.inFlight = false; }
    _aim.ts = 0;
    return;
  }
  _aim = { latlng: L.latLng(latlng), ts: now, inFlight: true };
  drawMap.panTo(_aim.latlng, { animate: true, duration: 0.2 });
}

// ── Crosshair mode on/off ──
// On (coarse pointers only): one-finger panning always on, pinch and
// double-tap zoom around the CENTRE (so the corner under the crosshair stays
// under it — the default pinch moved the target 270 px on the rig), no
// inertia (a 200 px flick coasted 120 px, ~23 ft), a tap aims, and lines,
// labels, dots and accessory markers stop taking taps. Perimeter edges
// commit at once as the sticky edge type; the desktop keeps #reChooser.
function _setCrosshair(on) {
  const want = !!on && _coarse && !!drawMap;
  if (want === _crosshair) return _crosshair;
  const m = drawMap;
  if (want) {
    _crosshairSaved = { inertia: m.options.inertia, touchZoom: m.options.touchZoom, doubleClickZoom: m.options.doubleClickZoom };
    // A corner waiting on the chooser cannot outlive the switch: the
    // crosshair commits edges directly.
    resetPendingState();
    _crosshair = true;
    m.options.inertia = false;
    m.options.touchZoom = 'center';
    m.options.doubleClickZoom = 'center';
    m.dragging.enable(); m.touchZoom.enable(); m.doubleClickZoom.enable();
    m.getContainer().classList.add('nbd-crosshair');
    _cancelPreviewFrame();
    clearTemp();
  } else {
    _crosshair = false;
    const s = _crosshairSaved || {};
    m.options.inertia = s.inertia !== undefined ? s.inertia : true;
    m.options.touchZoom = s.touchZoom !== undefined ? s.touchZoom : true;
    m.options.doubleClickZoom = s.doubleClickZoom !== undefined ? s.doubleClickZoom : true;
    if (drawOn && m.doubleClickZoom) m.doubleClickZoom.disable();
    m.getContainer().classList.remove('nbd-crosshair');
    _cancelPreviewFrame();
    clearTemp();
  }
  _applyInteractivity();
  _emitChange();
  return _crosshair;
}
// Leaflet reads a canvas path's options.interactive on every hit test, so
// flipping it takes effect at once; DOM icons (length chips, accessories)
// take pointer-events.
function _applyInteractivity() {
  drawnLines.forEach(l => { if (l.line) l.line.options.interactive = !_crosshair; _labelPassThrough(l.lbl, drawOn); });
  _allDots.forEach(d => { d.options.interactive = !_crosshair; });
  placedAccessories.forEach(a => _accessoryPassThrough(a.marker));
}
function _accessoryPassThrough(marker) {
  if (!marker) return;
  const el = marker.getElement && marker.getElement();
  if (el) el.style.pointerEvents = _crosshair ? 'none' : '';
  if (marker.dragging) { if (_crosshair) marker.dragging.disable(); else marker.dragging.enable(); }
}

// ── Placing a point at the crosshair ──
function _refused(reason, extra) { return Object.assign({ ok: false, reason }, extra || {}); }
function placeAtReticle(opts) {
  const o = opts || {};
  if (!drawMap) return _refused('no-map');
  // A finger still on the map (pan / pinch) or a zoom animating: refuse.
  if (_gestureActive()) return _refused('moving');
  // A glide already running is ended first: an aim glide jumps to where it
  // was going, anything else (inertia, a fly-to) stops where it is — the
  // point lands at the centre the rep sees come to rest.
  if (_aim && _aim.inFlight) { drawMap.setView(_aim.latlng, drawMap.getZoom(), { animate: false }); _aim.inFlight = false; }
  else if (_moveActive) drawMap.stop();
  if (o.edgeType === 'eave' || o.edgeType === 'rake') _stickyEdge = o.edgeType;
  if (Number.isInteger(o.lineType) && LT[o.lineType]) _setLineType(o.lineType);
  const drawing = drawOn && !accessoryMode && !shadowMode;
  if (!drawOn && !accessoryMode && !shadowMode && !autoDetectActive) return _refused('not-armed');
  if (drawing && drawMode === 'er') return _refused('flip-mode');
  if (drawing && drawMode === 'perim' && perimPendingP2) return _refused('choose-edge');
  const at = o.at ? _llOf(o.at) : null;
  const p = _previewCalc(at, o.snap === false ? 'none' : 'reticle');
  if (drawing && p.anchor && !p.closes && p.px < SAME_SPOT_PX) return _refused('same-spot', { preview: _publicPreview(p) });
  const before = { lines: drawnLines.length, facets: facets.length, acc: placedAccessories.length };
  const cp = drawMap.latLngToContainerPoint(p.target);
  drawMap.fire('click', {
    latlng: p.target, containerPoint: cp, layerPoint: drawMap.containerPointToLayerPoint(cp),
    originalEvent: { type: 'click', nbdReticle: true, preventDefault() {}, stopPropagation() {} },
    nbdReticle: true,
    // The crosshair commits a perimeter edge as the sticky type right away;
    // without the crosshair (a desktop caller) the chooser still asks,
    // unless the caller named the type.
    nbdEdge: (_crosshair || o.edgeType) ? _stickyEdge : null
  });
  _emitChange();
  return {
    ok: true, at: _plainLL(p.target), latlng: _plainLL(p.target), snapped: !!p.snapped, closed: facets.length > before.facets,
    segmentFt: p.anchor ? p.segmentFt : 0, linesAdded: drawnLines.length - before.lines,
    accessoryAdded: placedAccessories.length > before.acc
  };
}
// The seam's line-type change. Not selLT(): that also RETYPES whichever line
// is selected in the drawer's list, which a Lines-mode chip must not do.
function _setLineType(i) {
  document.querySelectorAll('.lt-btn').forEach((b, k) => {
    b.classList.toggle('active', k === i);
    b.style.borderColor = k === i ? LT[i].color : '';
  });
  drawLT = i;
  if (drawStart && tempLine) tempLine.setStyle({ color: LT[i].color });
  _emitChange();
}

// ── Moving a corner ──
// One mover for the desktop mouse drag, nbdDraw.moveVertex (the crosshair's
// Move → Drop) and Set length. It moves EVERY line end, facet corner,
// open-outline point, gutter point and dot at that position together — the
// old dot drag moved lines by dot identity only, and editLineLength moved
// one line's end and its dot while the neighbouring edge stayed behind
// (a torn corner). The undo snapshot is taken before any live change.
function _beginVertexMove(fromLL) {
  const from = L.latLng(fromLL);
  const snap = _snapshot();
  const lineRefs = [], facetRefs = [], perimRefs = [], gutterRefs = [];
  drawnLines.forEach(l => {
    if (_sameLL(l.p1, from)) lineRefs.push({ l, end: 1 });
    if (_sameLL(l.p2, from)) lineRefs.push({ l, end: 2 });
  });
  facets.forEach(f => f.points.forEach((p, i) => { if (_sameLL(p, from)) facetRefs.push({ f, i }); }));
  perimPoints.forEach((p, i) => { if (_sameLL(p, from)) perimRefs.push(i); });
  gutterPoints.forEach((p, i) => { if (_sameLL(p, from)) gutterRefs.push(i); });
  const startRef = !!(drawStart && _sameLL(drawStart, from));
  _allDots = _allDots.filter(d => drawMap.hasLayer(d));
  const dots = _allDots.filter(d => _sameLL(d.getLatLng(), from));
  const touchedFacets = Array.from(new Set(facetRefs.map(r => r.f)));
  let cur = from;
  function place(to) {
    lineRefs.forEach(r => { if (r.end === 1) r.l.p1 = to; else r.l.p2 = to; });
    facetRefs.forEach(r => { r.f.points[r.i] = to; });
    perimRefs.forEach(i => { perimPoints[i] = to; });
    gutterRefs.forEach(i => { gutterPoints[i] = to; });
    if (startRef) drawStart = to;
    dots.forEach(d => d.setLatLng(to));
    const seen = new Set();
    lineRefs.forEach(r => {
      const l = r.l;
      if (seen.has(l)) return;
      seen.add(l);
      l.line.setLatLngs([l.p1, l.p2]);
      l.dist = hav(l.p1, l.p2);
      l.lbl.setLatLng(mid(l.p1, l.p2));
      l.lbl.setIcon(_measIcon(l.dist, l.color)); _labelPassThrough(l.lbl, drawOn);
    });
    touchedFacets.forEach(f => { if (f.polygon) f.polygon.setLatLngs(f.points); });
    if (perimRefs.indexOf(0) >= 0 && perimCloseRing) perimCloseRing.setLatLng(to);
    cur = to;
  }
  // Would `to` fold an edge to nothing (a corner dropped onto its own
  // neighbour)?
  function collapses(to) {
    if (lineRefs.some(r => { const o = r.end === 1 ? r.l.p2 : r.l.p1; return !_sameLL(o, from) && _sameLL(o, to); })) return true;
    if (facetRefs.some(r => { const n = r.f.points.length; return _sameLL(r.f.points[(r.i + 1) % n], to) || _sameLL(r.f.points[(r.i + n - 1) % n], to); })) return true;
    const nb = (arr, i) => (i > 0 && _sameLL(arr[i - 1], to)) || (i < arr.length - 1 && _sameLL(arr[i + 1], to));
    return perimRefs.some(i => nb(perimPoints, i)) || gutterRefs.some(i => nb(gutterPoints, i));
  }
  return {
    size: lineRefs.length + facetRefs.length + perimRefs.length + gutterRefs.length + (startRef ? 1 : 0),
    update(to) { place(L.latLng(to)); },
    collapses(to) { return collapses(L.latLng(to)); },
    cancel() { if (!_sameLL(cur, from)) place(from); },
    commit(toLL) {
      const to = L.latLng(toLL);
      if (_sameLL(to, from) || collapses(to)) { this.cancel(); return false; }
      place(to);
      _pushUndo(snap);
      // Dropped onto another corner: the two become one (one dot, and from
      // now on one vertex). Undo splits them again.
      _unifyDotsAt(to);
      touchedFacets.forEach(f => { const fi = facets.indexOf(f); if (fi >= 0) rebuildFacetPolygon(fi); });
      _redrawOpenOutline();
      renderLineList(); recalc(); recalcGutters(); autoSaveDrawing();
      return true;
    }
  };
}
// Every dot sitting on `ll` becomes the first one, and every reference
// follows it (lines, facets, the open outline / run, pending points).
function _unifyDotsAt(ll) {
  const here = _allDots.filter(d => drawMap.hasLayer(d) && _sameLL(d.getLatLng(), ll));
  if (here.length < 2) return;
  const keep = here[0], drop = new Set(here.slice(1));
  const re = d => (drop.has(d) ? keep : d);
  drawnLines.forEach(l => { l.dot1 = re(l.dot1); l.dot2 = re(l.dot2); });
  facets.forEach(f => { f.dots = f.dots.map(re); });
  perimDots = perimDots.map(re); gutterDots = gutterDots.map(re);
  drawStartDot = re(drawStartDot); perimPendingDot = re(perimPendingDot);
  drop.forEach(d => drawMap.removeLayer(d));
  _allDots = _allDots.filter(d => !drop.has(d));
  keep.bringToFront();
}
// The open outline has no polygon yet, only its close ring at point A.
function _redrawOpenOutline() {
  if (perimCloseRing && perimPoints.length) perimCloseRing.setLatLng(perimPoints[0]);
}
function _vertexAt(ll) {
  const exact = _vertexList().find(p => _sameLL(p, ll));
  if (exact) return exact;
  const near = _nearestVertex(drawMap.latLngToContainerPoint(ll), 1.5);
  return near ? near.latlng : null;
}
function moveVertex(from, to, opts) {
  const o = opts || {};
  if (!drawMap) return _refused('no-map');
  const f = _llOf(from), t = _llOf(to);
  if (!f || !t) return _refused('bad-args');
  const v = _vertexAt(f);
  if (!v) return _refused('no-vertex');
  // The drop lands exactly where it was put (the crosshair screen shows no
  // snap ring for a move). {snap:true} snaps it onto a corner within the
  // crosshair radius, joining the two.
  let target = t, snapped = false;
  if (o.snap === true) {
    const s = _snapInfo(t, _reticleSnapPx(), v);
    if (s.snapped) { target = s.latlng; snapped = true; }
  }
  const joins = _vertexList().some(p => _sameLL(p, target) && !_sameLL(p, v));
  const mover = _beginVertexMove(v);
  if (mover.collapses(target)) return _refused('collapse');
  const moved = mover.size;
  if (!mover.commit(target)) return _refused('no-move');
  _emitChange();
  return { ok: true, moved, at: _plainLL(target), latlng: _plainLL(target), snapped, merged: joins };
}

// ── Desktop mouse: drag a corner ──
// Replaces each dot's own mousedown (L3): the nearest corner within 8 px of
// the pointer is grabbed, whatever is drawn on top of it, and a shared
// corner moves every line on it. Mouse only — a finger pans, and on a phone
// corners move through the crosshair screen's Move / Drop.
function _bindVertexDrag() {
  const c = drawMap.getContainer();
  let drag = null, eatClickUntil = 0;
  c.addEventListener('pointerdown', ev => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
    if (drawOn || _crosshair || shadowMode || accessoryMode) return;
    const t = ev.target;
    if (t && t.closest && t.closest('.leaflet-control, .leaflet-popup, .leaflet-marker-draggable')) return;
    const cp = drawMap.mouseEventToContainerPoint(ev);
    const v = _nearestVertex(cp, VERTEX_GRAB_PX);
    if (!v) return;
    // preventDefault on pointerdown also withholds the compatibility
    // mousedown, so neither Leaflet's pan nor a layer's mousedown starts.
    ev.preventDefault(); ev.stopPropagation();
    drag = { mover: _beginVertexMove(v.latlng), start: cp, moved: false, last: null, panOn: drawMap.dragging.enabled() };
    if (drag.panOn) drawMap.dragging.disable();
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  }, true);
  function onMove(ev) {
    if (!drag) return;
    const cp = drawMap.mouseEventToContainerPoint(ev);
    if (!drag.moved && cp.distanceTo(drag.start) < 3) return;
    drag.moved = true;
    drag.last = drawMap.containerPointToLatLng(cp);
    drag.mover.update(drag.last);
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.panOn) drawMap.dragging.enable();
    if (d.moved && d.last) {
      // The click that follows the release would land on a line and open
      // its popup (or place an accessory): swallow that one click.
      eatClickUntil = Date.now() + 500;
      if (!d.mover.commit(d.last)) showToast('That would fold an edge to nothing — corner put back', 'info');
      _emitChange();
    } else {
      d.mover.cancel();
    }
  }
  c.addEventListener('click', ev => {
    if (eatClickUntil && Date.now() < eatClickUntil) { eatClickUntil = 0; ev.stopPropagation(); ev.preventDefault(); }
  }, true);
}

// ── Picking what is under the crosshair (Edit mode) ──
// The nearest corner within px (default 16), else the nearest edge, else a
// placed accessory. Plain data; pass it back to moveVertex / retype / flip /
// remove / setLength.
function _vertexInfo(p, px) {
  const lines = drawnLines.filter(l => _sameLL(l.p1, p) || _sameLL(l.p2, p));
  const fs = facets.filter(f => f.points.some(q => _sameLL(q, p)));
  return {
    kind: 'vertex', latlng: _plainLL(p), lat: p.lat, lng: p.lng, px,
    count: lines.length, lines: lines.map(l => l.id), facets: fs.map(f => f.id),
    // More than one shape meets here (two sections, or loose lines).
    shared: fs.length > 1 || lines.length > 2 || (!fs.length && lines.length > 1)
  };
}
function pick(latlng, px) {
  if (!drawMap) return null;
  const ll = latlng ? _llOf(latlng) : _reticleLatLng();
  if (!ll) return null;
  const r = Number.isFinite(px) && px > 0 ? px : RETICLE_SNAP_PX;
  const cp = drawMap.latLngToContainerPoint(ll);
  const v = _nearestVertex(cp, r);
  if (v) return _vertexInfo(v.latlng, v.px);
  let best = null;
  drawnLines.forEach(l => {
    const d = L.LineUtil.pointToSegmentDistance(cp, drawMap.latLngToContainerPoint(l.p1), drawMap.latLngToContainerPoint(l.p2));
    if (d <= r && (!best || d < best.px)) best = { l, px: d };
  });
  if (best) {
    const l = best.l;
    return {
      kind: 'edge', id: l.id, type: l.type, name: l.name, subtype: l.subtype || null, dist: l.dist, px: best.px,
      p1: _plainLL(l.p1), p2: _plainLL(l.p2), facetId: l.facetId || null, runId: l.runId || null,
      structureId: l.structureId, isPerim: !!l.isPerim, flippable: l.type === 4 || l.type === 5
    };
  }
  let acc = null;
  placedAccessories.forEach(a => {
    const d = drawMap.latLngToContainerPoint(a.latlng).distanceTo(cp);
    if (d <= r && (!acc || d < acc.px)) acc = { a, px: d };
  });
  if (acc) return { kind: 'accessory', id: acc.a.id, type: acc.a.type, lat: acc.a.latlng.lat, lng: acc.a.latlng.lng, px: acc.px };
  return null;
}
// A line id from a number or an edge pick.
function _lineIdOf(t) {
  if (t && typeof t === 'object') return t.kind === 'edge' || t.kind === undefined ? Number(t.id) : NaN;
  return Number(t);
}

// ── Change events ──
// on('change', fn) fires once per action (coalesced to a microtask, after
// the action returns) with state(); on('preview', fn) once per painted
// preview frame with {anchor, target, segmentFt, runFt, snapped, closes,
// sameSpot}.
function _emit(evt, payload) {
  const list = _seamListeners[evt];
  if (!list || !list.length) return;
  list.slice().forEach(fn => { try { fn(payload); } catch (e) { console.warn('[maps-routing] nbdDraw ' + evt + ' listener threw:', e && e.message); } });
}
function _emitChange() {
  if (_changeQueued) return;
  _changeQueued = true;
  Promise.resolve().then(() => {
    _changeQueued = false;
    if (!_seamListeners.change.length || !drawMap) return;
    let st = null;
    try { st = _state(); } catch (e) { console.warn('[maps-routing] nbdDraw state failed:', e && e.message); return; }
    _emit('change', st);
  });
}

// ── state() ──
function _state() {
  const m = drawMap;
  const c = _reticleLatLng();
  const zoom = m.getZoom();
  const pv = _previewCalc(null, 'reticle');
  const radius = _reticleSnapPx();
  const moving = _gestureActive() || _moveActive;
  const placing = drawOn || !!accessoryMode || !!shadowMode || !!autoDetectActive;
  const drawing = drawOn && !accessoryMode && !shadowMode;
  const sameSpot = drawing && !!pv.anchor && !pv.closes && pv.px < SAME_SPOT_PX;
  const openCount = drawMode === 'perim' ? perimPoints.length : drawMode === 'gutter' ? gutterPoints.length : (drawStart ? 1 : 0);
  return {
    version: SEAM_VERSION,
    coarse: _coarse, crosshair: _crosshair,
    // mode: the engine's draw mode ('line' | 'perim' | 'er' | 'gutter');
    // armed: drawing is on (the drawer's Draw/Stop).
    mode: drawMode, armed: drawOn, drawing: drawOn,
    accessory: accessoryMode || null, shadow: shadowMode || null, autoDetect: !!autoDetectActive,
    lineType: drawLT, lineTypes: LT.map(t => ({ name: t.n, color: t.color })), edgeType: _stickyEdge,
    zoom, maxZoom: m.getMaxZoom(), ftPerPx: window.NBDDrawGeom.ftPerPx(c.lat, zoom),
    moving,
    reticle: _plainLL(c),
    snapRadiusPx: radius,
    snap: pv.snapped ? _plainLL(pv.target) : null,
    // anchor: where the next segment starts; first: the open outline's
    // first corner (an Add snapped onto it closes the shape).
    anchor: _plainLL(pv.anchor), first: drawMode === 'perim' && perimPoints.length ? _plainLL(perimPoints[0]) : null,
    segmentFt: pv.segmentFt, runFt: pv.runFt, closes: !!pv.closes, sameSpot,
    openCount,
    pendingEdge: !!perimPendingP2,
    canAdd: placing && !moving && !sameSpot && !(drawing && drawMode === 'er') && !(drawing && drawMode === 'perim' && !!perimPendingP2),
    canClose: drawMode === 'perim' && perimPoints.length >= 3 && !perimPendingP2,
    canFinishRun: drawMode === 'gutter' && gutterRunId !== null && gutterPoints.length >= 2,
    canUndo: _undoStack.length > 0 || !!drawStart || !!perimPendingP2,
    canRedo: _redoStack.length > 0,
    counts: {
      lines: drawnLines.length, facets: facets.length, vertices: _vertexList().length,
      accessories: placedAccessories.length, gutterRuns: window.NBDDrawGeom.gutterRuns(drawnLines).length
    },
    structureId: activeStructureId, structures: structures.map(s => ({ id: s.id, name: s.name }))
  };
}
// setMode(mode, {lineType}) — arm Outline ('perim'), Lines ('line') or
// Gutters ('gutter') the way the drawer's mode button + ▶ Draw do; null
// disarms (Edit). The same mode again only changes the line type, so a
// Line start point survives a type change.
function _setMode(mode, opts) {
  const o = opts || {};
  if (mode !== null && mode !== undefined && ['line', 'perim', 'gutter', 'er'].indexOf(mode) < 0) return _refused('bad-mode');
  if (Number.isInteger(o.lineType) && LT[o.lineType]) _setLineType(o.lineType);
  if (!mode) { if (drawOn) toggleDraw(); _emitChange(); return { ok: true, mode: drawMode, armed: drawOn }; }
  if (mode !== drawMode) {
    const ids = { line: 'modeLineBtn', perim: 'modePerimBtn', er: 'modeERBtn', gutter: 'modeGutterBtn' };
    setDrawMode(mode, document.getElementById(ids[mode]));
  }
  if (!drawOn && mode !== 'er') toggleDraw();
  _emitChange();
  return { ok: true, mode: drawMode, armed: drawOn };
}

// ── THE SEAM: drawMap.nbdDraw ──
// Frozen in the L3 PR description (draw lane L3, 2026-09-25); the crosshair
// screen (L4) builds against exactly this. Coordinates in and out are plain
// {lat, lng}; a refused action returns {ok:false, reason} — nothing throws.
const SEAM_VERSION = 1;
const _seam = Object.freeze({
  version: SEAM_VERSION,
  state() { return drawMap ? _state() : null; },
  setMode(mode, opts) { return _setMode(mode, opts); },
  // setEdgeType('eave' | 'rake') — the sticky type crosshair outline edges
  // commit as (placeAtReticle / closeShape's edgeType sets it too).
  setEdgeType(t) {
    if (t !== 'eave' && t !== 'rake') return false;
    _stickyEdge = t;
    _emitChange();
    return true;
  },
  // snap(latlng?, px?) → {latlng, snapped, kind, px, radius}: where a
  // crosshair point at latlng (default: the crosshair) would land. px can
  // only NARROW the engine's radius (16 px, 3 ft cap, off when under 4 px),
  // so a ring drawn from this is exactly what placeAtReticle will do. Never
  // the anchor (the point the next segment starts from).
  snap(latlng, px) {
    if (!drawMap) return null;
    const ll = latlng ? _llOf(latlng) : _reticleLatLng();
    if (!ll) return null;
    const engine = _reticleSnapPx();
    const r = Number.isFinite(px) && px > 0 ? Math.min(px, engine) : engine;
    const a = drawOn && !accessoryMode && !shadowMode ? _anchorInfo() : null;
    const s = _snapInfo(ll, r, a ? a.anchor : null);
    return { latlng: _plainLL(s.latlng), lat: s.latlng.lat, lng: s.latlng.lng, snapped: s.snapped, kind: s.snapped ? 'vertex' : null, px: s.px, radius: r };
  },
  // preview(latlng) paints the dashed band from the anchor to latlng (after
  // the crosshair snap) and returns {anchor, target, segmentFt, runFt,
  // snapped, closes, sameSpot}. preview() with no argument = at the
  // crosshair; preview(null) clears the band.
  preview(latlng) {
    if (!drawMap) return null;
    if (latlng === null) {
      _hidePreview();
      const a = _anchorInfo();
      return { anchor: null, target: null, snapped: false, segmentFt: 0, runFt: a ? a.runFt : 0, closes: false, sameSpot: false };
    }
    const ll = latlng === undefined ? _reticleLatLng() : _llOf(latlng);
    if (!ll) return null;
    _cancelPreviewFrame();
    return _renderPreview(ll, 'reticle');
  },
  placeAtReticle,
  finishRun() {
    if (gutterRunId === null) return { ok: false, reason: 'no-run' };
    finishGutterRun();
    _emitChange();
    return { ok: true };
  },
  // closeShape({edgeType?}) → close the open outline with its last edge.
  closeShape(opts) {
    const o = opts || {};
    if (drawMode !== 'perim') return _refused('not-outline');
    if (perimPendingP2) return _refused('choose-edge');
    if (perimPoints.length < 3) return _refused('open-outline-needs-3');
    if (o.edgeType === 'eave' || o.edgeType === 'rake') _stickyEdge = o.edgeType;
    const n = facets.length;
    closePerimeter();
    if (_crosshair || o.edgeType) perimChooseType(_stickyEdge);
    _emitChange();
    return { ok: true, closed: facets.length > n, pendingEdge: !!perimPendingP2 };
  },
  undo() { undoLine(); _emitChange(); return true; },
  redo() { redoLine(); _emitChange(); return true; },
  pick,
  moveVertex,
  // retype(line, type) — type is an LT index (0-10).
  retype(line, type) {
    const id = _lineIdOf(line), t = Number(type);
    const l = drawnLines.find(x => x.id === id);
    if (!l || !Number.isInteger(t) || !LT[t]) return false;
    if (l.type === t) return true;
    retypeLine(id, t);
    _emitChange();
    return l.type === t;
  },
  // flip(line) — Eave <-> Rake.
  flip(line) {
    const l = drawnLines.find(x => x.id === _lineIdOf(line));
    if (!l || (l.type !== 4 && l.type !== 5)) return false;
    erToggleSegment(l.id);
    _emitChange();
    return true;
  },
  // remove(target) — a line id / edge pick, or an accessory pick. The
  // caller confirms first; this does not ask.
  remove(target) {
    if (target && typeof target === 'object' && target.kind === 'accessory') return _removeAccessory(Number(target.id));
    if (target && typeof target === 'object' && target.kind === 'vertex') return false;
    const id = _lineIdOf(target);
    if (!drawnLines.some(l => l.id === id)) return false;
    deleteLine(id);
    _emitChange();
    return true;
  },
  // setLength(line, ft) — moves the line's second end along the line; a
  // shared corner moves every edge on it (no prompt(), for an inline box).
  setLength(line, ft) { const ok = _setLineLength(_lineIdOf(line), Number(ft)); if (ok) _emitChange(); return ok; },
  totals() {
    if (!drawMap) return null;
    const t = _totals();
    return JSON.parse(JSON.stringify({ combined: t.combined, per: t.per, gutterRuns: window.NBDDrawGeom.gutterRuns(drawnLines) }));
  },
  // on('change' | 'preview', fn) → unsubscribe function.
  on(evt, fn) {
    const list = _seamListeners[evt];
    if (!list || typeof fn !== 'function') return () => {};
    list.push(fn);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  },
  off(evt, fn) { const list = _seamListeners[evt]; const i = list ? list.indexOf(fn) : -1; if (i >= 0) list.splice(i, 1); },
  // setCrosshair(bool) → the resulting mode. Coarse pointers only (a mouse
  // keeps click-to-place): returns false on a desktop.
  setCrosshair(on) { return _setCrosshair(on); }
});

// ── MAP LAYER TOGGLE ────────────────────────────
function toggleMapLayer() {
  const order = ['satellite','street','hybrid'];
  const labels = {satellite:'🛰️ Satellite',street:'🗺️ Street',hybrid:'🔀 Hybrid'};
  const idx = order.indexOf(currentLayerType);
  const next = order[(idx+1)%order.length];
  // Remove current
  if(drawMapLayers[currentLayerType]) drawMap.removeLayer(drawMapLayers[currentLayerType]);
  // Add next
  drawMapLayers[next].addTo(drawMap);
  currentLayerType = next;
  const btn = document.getElementById('layerToggleBtn');
  if(btn) btn.textContent = labels[next]||next;
}

// ── MY LOCATION ─────────────────────────────
function goToMyLocation() {
  const btn = document.getElementById('myLocBtn');
  if (!btn) return;
  if (!navigator.geolocation) {
    if (window.showToast) showToast('Geolocation not supported by this browser', 'error');
    return;
  }
  btn.textContent = '⏳ Locating...';
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      if (drawMap) {
        drawMap.setView([lat, lng], 20);
        // Add a pulsing marker at current location
        const locMarker = L.circleMarker([lat, lng], {
          radius: 8, color: '#4A9EFF', fillColor: '#4A9EFF',
          fillOpacity: 0.4, weight: 3
        }).addTo(drawMap);
        // Remove after 5 seconds
        setTimeout(() => { if (drawMap.hasLayer(locMarker)) drawMap.removeLayer(locMarker); }, 5000);
      }
      btn.innerHTML = '📍 My Location';
      btn.disabled = false;
      if (window.showToast) showToast('Moved to your location', 'success');
    },
    (err) => {
      btn.innerHTML = '📍 My Location';
      btn.disabled = false;
      const msgs = {1: 'Location permission denied', 2: 'Location unavailable', 3: 'Location request timed out'};
      if (window.showToast) showToast(msgs[err.code] || 'Could not get location', 'error');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ── DRAW MODE SWITCHER ───────────────────────
function setDrawMode(mode, btn) {
  if(drawOn) toggleDraw();
  // A mode switch ends the gutter run (B5) and drops any pending tap (B9).
  finishGutterRun({ quiet: true });
  resetPendingState();
  hideReChooser();

  drawMode = mode;
  document.querySelectorAll('.draw-mode-btn').forEach(b => b.classList.remove('active'));
  if(btn) btn.classList.add('active');

  const ltGrid = document.getElementById('ltGrid');
  const ltLabel = document.getElementById('ltGridLabel');
  const perimBar = document.getElementById('perimBar');
  const erBar = document.getElementById('erBar');
  const gutterResult = document.getElementById('gutterResult');

  perimBar.classList.remove('visible');
  erBar.classList.remove('visible');
  gutterResult.classList.remove('visible');

  if(mode === 'line') {
    ltGrid.style.display = '';
    ltLabel.style.display = '';
  } else if(mode === 'perim') {
    ltGrid.style.display = 'none';
    ltLabel.style.display = 'none';
    perimBar.classList.add('visible');
  } else if(mode === 'er') {
    ltGrid.style.display = 'none';
    ltLabel.style.display = 'none';
    erBar.classList.add('visible');
  } else if(mode === 'gutter') {
    ltGrid.style.display = 'none';
    ltLabel.style.display = 'none';
    gutterResult.classList.add('visible');
    recalcGutters();
  }
  _emitChange();
}

// ── LINE MODE ────────────────────────────────
function handleLineClick(latlng) {
  if(!drawStart) {
    // The first tap is PENDING (Undo cancels it); the line is the action.
    drawStart = latlng;
    const hit = _findDot(latlng);
    drawStartDot = hit || makeDraggableDot(latlng, LT[drawLT].color);
    drawStartDotNew = !hit;
    _emitChange();
  } else {
    _pushUndo();
    const endDot = _dotAt(latlng, LT[drawLT].color);
    finalizeLine(drawStart, latlng, drawStartDot, endDot);
    drawStart = null; drawStartDot = null; drawStartDotNew = false;
  }
}

// ── LABEL ICONS ──────────────────────────────
// iconSize:null (2026-09-25, L2, audit H10): a divIcon defaults to 12x12, so
// the dark .meas-label chip was 12px wide under ~28px of white text that
// spilled onto the imagery. null lets the chip size to its text.
function _measIcon(dist, color) {
  return L.divIcon({html:`<div class="meas-label" style="border-color:${color}">${dist.toFixed(1)} ft</div>`, className:'', iconAnchor:[0,10], iconSize:null});
}
// While drawing, length chips let a tap through to the map (audit H4: "taps
// on the measurement labels are swallowed"). Their own click only edits a
// length, which editLineLength() refuses while drawing anyway. Needed more
// now that a chip is as wide as its text (iconSize:null above).
// In crosshair mode (L3) chips never take a tap at all: a tap only aims,
// and lengths are set from the crosshair screen (nbdDraw.setLength).
function _labelPassThrough(lbl, on) {
  const el = lbl && lbl.getElement && lbl.getElement();
  if (!el) return;
  const pass = on || _crosshair;
  el.style.pointerEvents = pass ? 'none' : '';
  const chip = el.firstElementChild;
  if (chip) chip.style.pointerEvents = pass ? 'none' : '';
}
function _syncLabelPassThrough() {
  drawnLines.forEach(l => _labelPassThrough(l.lbl, drawOn));
}

// ── CORNER DOT FACTORY ───────────────────────
// 2026-09-25 (L2): the touch path is gone — it bound to dot._path, which
// never exists under the canvas renderer (preferCanvas:true), so every dot
// re-polled setTimeout(30) forever (198 timers/s with 6 dots, 330/s after
// two Clears) and a finger drag panned the map anyway (audit B2).
// 2026-09-25 (L3): the dot's own mousedown drag is gone too. A mouse now
// grabs the nearest CORNER within 8 px through one container-level hit test
// (_bindVertexDrag), and the move goes through the shared-corner mover, so
// every line, facet corner and run point on that corner moves as one. A dot
// is only the corner's handle; it takes no taps in crosshair mode.
function makeDraggableDot(latlng, color, opts) {
  const dot = L.circleMarker(latlng, {
    radius:6, color:'#fff', fillColor:color, fillOpacity:1, weight:2,
    interactive: !_crosshair, ...(opts||{})
  }).addTo(drawMap);
  _allDots.push(dot);
  return dot;
}

function _sameLL(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
}
// The live dot already sitting on this corner, if any.
function _findDot(latlng) {
  _allDots = _allDots.filter(d => drawMap && drawMap.hasLayer(d));
  return _allDots.find(d => _sameLL(d.getLatLng(), latlng)) || null;
}
// Reuse the corner's dot, or make one — so lines that meet share a dot and a
// drag moves all of them (they used to get stacked dots and tear apart).
function _dotAt(latlng, color) {
  return _findDot(latlng) || makeDraggableDot(latlng, color);
}
function _removeDotIfOrphan(dot) {
  if (!dot || !drawMap.hasLayer(dot)) return;
  const used = drawnLines.some(l => l.dot1 === dot || l.dot2 === dot)
    || facets.some(f => f.dots.indexOf(dot) >= 0)
    || perimDots.indexOf(dot) >= 0 || gutterDots.indexOf(dot) >= 0
    || dot === drawStartDot || dot === perimPendingDot;
  if (!used) drawMap.removeLayer(dot);
}

// (updateLinesForDot is gone with the dot drag, L3: corners move through
// _beginVertexMove, by POSITION, so a line whose end sits on the corner
// under a different dot object can no longer be left behind.)

function selLT(i, el) {
  document.querySelectorAll('.lt-btn').forEach(b => { b.classList.remove('active'); b.style.borderColor = ''; });
  if (el) { el.classList.add('active'); el.style.borderColor = LT[i].color; }
  drawLT = i;
  if(selectedLineId !== null) retypeLine(selectedLineId, i);
  if (drawStart && tempLine) tempLine.setStyle({ color: LT[i].color });
  _emitChange();
}

function toggleDraw() {
  drawOn = !drawOn;
  const btn = document.getElementById('drawToggle');
  if(drawOn) {
    btn.textContent = '⏹ Stop'; btn.className = 'draw-btn stop';
    drawMap.getContainer().style.cursor = 'crosshair';
    // A double-click/double-tap while drawing is two points, not a zoom
    // (2026-09-25, L2, audit H4) — except in crosshair mode (L3), where a
    // tap never places anything and a double-tap zooms around the centre.
    if (drawMap.doubleClickZoom && !_crosshair) drawMap.doubleClickZoom.disable();
    _syncLabelPassThrough();
    // (L3: the `typeof drawNavMode` check that stood here was dead — the
    // name was local to initDrawMap — so dragging was never disabled; the
    // DRAW/NAVIGATE toggle it served is removed. Panning stays on.)
  } else {
    btn.textContent = '▶ Draw'; btn.className = 'draw-btn go';
    drawMap.getContainer().style.cursor = '';
    // Stop ends the gutter run (B5) and drops a pending line start point.
    finishGutterRun({ quiet: true });
    _cancelLineStart();
    clearTemp();
    if (drawMap.doubleClickZoom) drawMap.doubleClickZoom.enable();
    _syncLabelPassThrough();
    // Re-enable dragging when drawing stops
    drawMap.dragging.enable();
  }
  _emitChange();
}

// Drops the live preview (and any preview frame still queued).
function clearTemp() {
  _cancelPreviewFrame();
  if(tempLine) { drawMap.removeLayer(tempLine); tempLine = null; }
  if(tempLbl)  { drawMap.removeLayer(tempLbl);  tempLbl  = null; }
}

// ── ONE LINE FACTORY (2026-09-25, draw lane L2) ──
// Every drawn line — Line mode, perimeter edges, gutter segments, voice,
// autosave restore, Undo/Redo, Load from Customer — is built here, so they
// all get the same id sequence, the same popup, the same label and the same
// single click handler. rec: {type, p1, p2, dot1, dot2, dist?, id?, subtype,
// isPerim?, runId?, facetId?, structureId?, color?}.
function _addLine(rec) {
  const lt = LT[rec.type] || LT[0];
  const color = rec.color || lt.color;
  const d = Number.isFinite(rec.dist) ? rec.dist : hav(rec.p1, rec.p2);
  const line = L.polyline([rec.p1, rec.p2], {color, weight:4, opacity:.95, dashArray:lt.dash||null, interactive:!_crosshair}).addTo(drawMap);
  const lbl  = L.marker(mid(rec.p1, rec.p2), {icon:_measIcon(d, color)}).addTo(drawMap);
  const id = (Number.isSafeInteger(rec.id) && rec.id > 0) ? rec.id : _nextLineId++;
  if (id >= _nextLineId) _nextLineId = id + 1;
  const l = {
    id, type:rec.type, name:lt.n, color, dist:d, line, lbl, p1:rec.p1, p2:rec.p2,
    dot1:rec.dot1||null, dot2:rec.dot2||null, subtype:rec.subtype||null,
    isPerim:!!rec.isPerim, runId:rec.runId||null, facetId:rec.facetId||null,
    structureId:rec.structureId||activeStructureId
  };
  drawnLines.push(l);
  // Dots above their line: the canvas renderer hit-tests the TOPMOST layer,
  // and a line drawn after its end dot covered the dot's centre, so a desktop
  // drag grabbed dead-centre caught the line instead (audit B2, desktop).
  if (l.dot1) l.dot1.bringToFront();
  if (l.dot2) l.dot2.bringToFront();
  lbl.on('click', () => editLineLength(l.id));
  if (drawOn || _crosshair) _labelPassThrough(lbl, true);
  // ONE click handler per line, created once, dispatching on the mode. The
  // Eave/Rake toggle used to add a handler on every mode entry (3 on a fresh
  // facet: one tap fired "Rake / Eave / Rake", audit B8); and the popup
  // handler called stopPropagation even while drawing, so a tap within 2px
  // of a line never reached the map (audit H4).
  line.on('click', function(e) {
    if (drawMode === 'er' && (l.type === 4 || l.type === 5)) {
      L.DomEvent.stopPropagation(e);
      erToggleSegment(l.id);
      return;
    }
    if (drawOn) return; // drawing: the tap is a point on the map
    L.DomEvent.stopPropagation(e);
    openLineTypePicker(l.id, e.latlng);
  });
  return l;
}

// The runId for a Gutters segment drawn outside Gutter mode (Line mode, voice,
// a retype): the run it continues when it starts or ends on that run's end,
// else a new run (2026-09-25, L2 review — each such line used to be its own
// run with its own downspout). `exceptId` leaves a retyped line itself out.
function _gutterRunFor(p1, p2, exceptId) {
  const others = drawnLines.filter(x => x.id !== exceptId);
  const id = window.NBDDrawGeom.gutterRunAt(others, p1, p2);
  return id !== null ? id : _nextRunId++;
}

function finalizeLine(p1, p2, dot1, dot2) {
  // A Gutters line drawn in Line mode continues the run whose end it touches,
  // else it is a one-segment run of its own.
  const l = _addLine({type:drawLT, p1, p2, dot1, dot2, subtype:'line', runId: drawLT === 10 ? _gutterRunFor(p1, p2) : null});
  clearTemp(); renderLineList(); recalc(); recalcGutters(); autoSaveDrawing();
  return l.id;
}

// ── LINE TYPE PICKER POPUP ──
// Shows a popup with common 6 types + "More" expand when user
// clicks a drawn line on the map. Replaces the old workflow of
// selecting a line in the sidebar then changing the type dropdown.
function openLineTypePicker(lineId, latlng) {
  const COMMON = [5, 4, 0, 2, 3, 10]; // Eave, Rake, Ridge, Hip, Valley, Gutters
  const EXTRA = [1, 6, 7, 8, 9];       // Ridge Vent, Flashing, Step Flash, Drip Edge, Parapet

  // No onmouseenter/onmouseleave (2026-09-25, L2): prod CSP
  // (script-src-attr 'none') blocked those inline hover handlers anyway.
  const makeBtn = (idx) => {
    const lt = LT[idx];
    return '<button style="background:' + lt.color + '20;border:2px solid ' + lt.color + ';color:' + lt.color + ';'
      + 'padding:6px 10px;border-radius:5px;cursor:pointer;font-family:\'Barlow Condensed\',sans-serif;'
      + 'font-size:11px;font-weight:700;letter-spacing:.03em;white-space:nowrap;'
      + 'transition:all .12s;min-height:32px;" '
      + 'data-mr-action="retypeLine" data-mr-id="' + lineId + '" data-mr-arg2="' + idx + '"'
      + '>' + lt.n + '</button>';
  };

  const commonBtns = COMMON.map(makeBtn).join('');
  const extraBtns = EXTRA.map(makeBtn).join('');

  const html = '<div class="mrx-minw200px">'
    + '<div class="mrx-fs10px-w700-ls1em">Change Line Type</div>'
    + '<div class="mrx-dflex-flewrap-gap4px">' + commonBtns + '</div>'
    + '<details class="mrx-mt4px"><summary class="mrx-fs10px-c888-curpointer">More types \u25bc</summary>'
    + '<div class="mrx-dflex-flewrap-gap4px-2">' + extraBtns + '</div></details>'
    + '<div class="mrx-mt8px-dflex-gap4px">'
    + '<button data-mr-action="deleteLine" data-mr-id="' + lineId + '" class="mrx-fx1-bge0525220-bd1pxsolid">Delete</button>'
    + '<button data-mr-action="editLineLength" data-mr-id="' + lineId + '" class="mrx-fx1-bgtranspar-bd1pxsolid">Edit Length</button>'
    + '</div></div>';

  L.popup({ closeButton: true, className: 'nbd-line-picker-popup' })
    .setLatLng(latlng)
    .setContent(html)
    .openOn(drawMap);
}

// ── LINE LENGTH EDITING ──────────────────────
function editLineLength(lineId) {
  if(drawOn) return;
  const l = drawnLines.find(x => x.id === lineId);
  if(!l) return;
  const val = prompt(`Edit ${l.name} length (current: ${l.dist.toFixed(1)} ft):`, l.dist.toFixed(1));
  if(!val || isNaN(parseFloat(val))) return;
  const newDist = parseFloat(val);
  if(newDist <= 0) return;
  if (_setLineLength(lineId, newDist)) showToast(`Updated to ${newDist.toFixed(1)} ft`);
}
// Scale a line from p1 toward p2 to `newDist` ft. 2026-09-25 (L3): the far
// end moves as a CORNER — every edge sharing it follows (it used to move
// this line's end and its dot alone, tearing the facet's next edge off the
// corner). Shared by the desktop prompt and nbdDraw.setLength.
function _setLineLength(lineId, newDist) {
  const l = drawnLines.find(x => x.id === lineId);
  if (!l || !Number.isFinite(newDist) || newDist <= 0 || !(l.dist > 0)) return false;
  const ratio = newDist / l.dist;
  const newP2 = L.latLng(l.p1.lat + (l.p2.lat - l.p1.lat) * ratio, l.p1.lng + (l.p2.lng - l.p1.lng) * ratio);
  return _beginVertexMove(l.p2).commit(newP2);
}

// ── PERIMETER MODE (multi-facet) ─────────────
// `edge` ('eave' | 'rake'): a crosshair Add (L3) — the edge commits at once
// as that type, no chooser; and the outline closes only on an Add SNAPPED
// exactly onto its first corner (never on a 20 px near-miss). null: a
// click or tap, which keeps the chooser and the 20 px close.
function handlePerimClick(latlng, edge) {
  // 2026-09-25 (L2, audit B4): this used to begin with
  //   if(perimClosed) { saveFacet(); resetPerimState(); }
  // but perimChooseType() had ALREADY saved the closed facet, so the first
  // tap of the next section saved it a second time: 1,075 sf read 2,150 sf
  // (15.12 sq -> 30.24) and went to the estimate doubled. A facet is now
  // saved exactly once, when it closes, and the outline state resets there.
  //
  // A corner waiting for Eave/Rake blocks every other tap — checked FIRST,
  // so a tap near the first dot cannot overwrite the pending corner.
  if(perimPendingP2) return;
  // Check if clicking near first point to close
  if(perimPoints.length >= 3) {
    const first = perimPoints[0];
    const screenDist = drawMap.latLngToContainerPoint(first).distanceTo(drawMap.latLngToContainerPoint(latlng));
    if(edge ? _sameLL(first, latlng) : screenDist < 20) { // 20px on screen — much more precise than 30ft
      closePerimeter();
      if (edge) perimChooseType(edge);
      return;
    }
  }

  const facetColor = FACET_COLORS[facets.length % FACET_COLORS.length];

  if(perimPoints.length === 0) {
    // The outline's first corner is an action of its own (Undo removes it).
    _pushUndo();
    perimCloseRing = L.circleMarker(latlng, {radius:14, color:facetColor, fillColor:'transparent', weight:2, dashArray:'4,3', opacity:.6, interactive:false}).addTo(drawMap);
    perimPoints.push(latlng);
    perimDots.push(_dotAt(latlng, facetColor));
    autoSaveDrawing();
    return;
  }

  // Every later corner waits for Eave/Rake; nothing is committed until then.
  perimPendingP1 = perimPoints[perimPoints.length - 1];
  perimPendingP2 = latlng;
  const hit = _findDot(latlng);
  perimPendingDot = hit || makeDraggableDot(latlng, facetColor);
  perimPendingDotNew = !hit;
  clearTemp();
  if (edge) { perimChooseType(edge); return; } // the crosshair: committed, no question
  showReChooser();
  _emitChange();
}

function showReChooser() {
  const rc = document.getElementById('reChooser');
  const pb = document.getElementById('perimBar');
  if (rc) rc.classList.add('visible');
  if (pb) pb.classList.remove('visible');
}
function hideReChooser() {
  const rc = document.getElementById('reChooser');
  const pb = document.getElementById('perimBar');
  if (rc) rc.classList.remove('visible');
  if (drawMode==='perim' && pb) pb.classList.add('visible');
  perimPendingP1 = null;
  perimPendingP2 = null;
}

// ── PENDING STATE (2026-09-25, L2, audit B9) ──
// One reset for every "tapped but not committed" thing: a Line-mode start
// point, a perimeter corner waiting for Eave/Rake, and a close waiting for
// its last edge. _perimClosing used to survive Clear / Undo / a mode switch,
// so the NEXT outline's first edge "closed" a 1-point facet: "Facet 1 closed
// — 0 sf", then a bogus 103 sf. Returns true when it dropped something.
function _cancelLineStart() {
  if (!drawStart) return false;
  const dot = drawStartDot, wasNew = drawStartDotNew;
  drawStart = null; drawStartDot = null; drawStartDotNew = false;
  if (dot && wasNew) _removeDotIfOrphan(dot);
  clearTemp();
  return true;
}
function resetPendingState() {
  let dropped = _cancelLineStart();
  if (perimPendingP2 || _perimClosing) {
    const dot = perimPendingDot, wasNew = perimPendingDotNew;
    perimPendingDot = null; perimPendingDotNew = false;
    perimPendingP1 = null; perimPendingP2 = null;
    _perimClosing = false;
    if (dot && wasNew) _removeDotIfOrphan(dot);
    hideReChooser();
    dropped = true;
  }
  _perimClosing = false;
  if (dropped) _emitChange();
  return dropped;
}

function perimChooseType(subtype) {
  if(!perimPendingP1 || !perimPendingP2) return;
  _pushUndo();
  const p1 = perimPendingP1;
  const p2 = perimPendingP2;
  const closing = _perimClosing;
  const facetColor = FACET_COLORS[facets.length % FACET_COLORS.length];
  const pendDot = perimPendingDot;
  perimPendingDot = null; perimPendingDotNew = false;
  _perimClosing = false;
  addPerimSegment(p1, p2, subtype, pendDot);
  if(!closing) {
    perimPoints.push(p2);
    perimDots.push(pendDot || _dotAt(p2, facetColor));
  } else {
    // Close: the facet is saved HERE, once (see handlePerimClick, B4).
    const f = _addFacet({
      points:[...perimPoints], dots:[...perimDots], segments:[...perimSegments],
      pitch: parseFloat(document.getElementById('pitchSel')?.value || 1.202)
    });
    showToast(f.label+' closed — '+f.baseArea.toFixed(0)+' sf');
    const bar = document.getElementById('perimBar');
    if (bar) bar.textContent = '⬡ '+f.label+' — '+f.baseArea.toFixed(0)+' sf · '+_tap('click to start new facet');
    _resetPerimTrace();
  }
  hideReChooser();
  renderLineList(); recalc(); autoSaveDrawing();
}

function addPerimSegment(p1, p2, subtype, dot2Hint) {
  const facetColor = FACET_COLORS[facets.length % FACET_COLORS.length];
  const seg = _addLine({
    type: subtype==='eave' ? 5 : 4, p1, p2,
    dot1: _dotAt(p1, facetColor), dot2: dot2Hint || _dotAt(p2, facetColor),
    subtype, isPerim:true
  });
  perimSegments.push(seg);
  return seg.id;
}

function closePerimeter() {
  if(perimPoints.length < 3 || perimPendingP2) return;
  const last  = perimPoints[perimPoints.length - 1];
  const first = perimPoints[0];
  perimPendingP1 = last;
  perimPendingP2 = first;
  perimPendingDot = perimDots[0] || null;
  perimPendingDotNew = false;
  _perimClosing = true;
  showReChooser();
}

// ── FACET MANAGEMENT ─────────────────────────
// Builds a CLOSED facet (id, label, colour, polygon, area label) from its
// corners. Used by the close above, auto-detect and the restore path.
// The polygon is interactive:false — it sat over its own edges and ate
// every tap aimed at them, so the Eave/Rake toggle only answered 1px
// OUTSIDE the edge (audit B8).
function _addFacet(o) {
  const idx = facets.length;
  const id = (Number.isSafeInteger(o.id) && o.id > 0) ? o.id : _nextFacetId++;
  if (id >= _nextFacetId) _nextFacetId = id + 1;
  const color = o.color || FACET_COLORS[idx % FACET_COLORS.length];
  const f = {
    id, label: o.label || ('Facet '+(idx+1)), color,
    points: o.points, dots: o.dots || o.points.map(p => _dotAt(p, color)),
    segments: o.segments || [],
    closed: true, polygon: null, baseArea: shoelaceArea(o.points),
    pitch: Number.isFinite(o.pitch) && o.pitch >= 1 ? o.pitch : 1.202,
    structureId: o.structureId || activeStructureId, areaLabel: null, closeRing: null
  };
  f.segments.forEach(s => { s.facetId = id; });
  f.polygon = L.polygon(f.points, {color, weight:1, fillColor:color, fillOpacity:.12, interactive:false}).addTo(drawMap);
  facets.push(f);
  activeFacetIdx = facets.length - 1;
  // After the push, so the label is stored on the facet (it used to run
  // first and the label was orphaned: Clear left "F1: 1075 sf" behind).
  addAreaLabel(f.points, f.baseArea, idx);
  renderFacetList();
  return f;
}

// Legacy entry point (auto-detect): save the current, closed outline.
function saveFacet() {
  if(perimPoints.length < 3) return null;
  const f = _addFacet({
    points:[...perimPoints], dots:[...perimDots], segments:[...perimSegments],
    pitch: parseFloat(document.getElementById('pitchSel')?.value || 1.202)
  });
  _resetPerimTrace();
  return f;
}

// Forget the outline being traced (its committed edges stay as lines).
function _resetPerimTrace() {
  if(perimPolygon) { drawMap.removeLayer(perimPolygon); }
  if(perimCloseRing) { drawMap.removeLayer(perimCloseRing); }
  perimPoints = []; perimDots = []; perimSegments = [];
  perimClosed = false; perimPendingP1 = null; perimPendingP2 = null;
  perimPolygon = null; perimBaseArea = 0; perimCloseRing = null;
  perimPendingDot = null; perimPendingDotNew = false;
  _perimClosing = false;
}

function resetPerimState() {
  _resetPerimTrace();
  const bar = document.getElementById('perimBar');
  if(bar) bar.textContent = _tap('⬡ Perimeter mode — click to trace Facet '+(facets.length+1)+'. Click first dot to close.');
}

function rebuildFacetPolygon(fi) {
  const f = facets[fi];
  if(!f || !f.closed) return;
  f.polygon.setLatLngs(f.points);
  f.baseArea = shoelaceArea(f.points);
  // Update area label
  if(f.areaLabel) drawMap.removeLayer(f.areaLabel);
  addAreaLabel(f.points, f.baseArea, fi);
  renderFacetList();
  recalc();
}

function addAreaLabel(points, area, facetIdx) {
  if(!points.length) return;
  // Center point
  const cLat = points.reduce((s,p)=>s+p.lat,0)/points.length;
  const cLng = points.reduce((s,p)=>s+p.lng,0)/points.length;
  const f = facets[facetIdx];
  const color = (f && f.color) || FACET_COLORS[facetIdx % FACET_COLORS.length];
  const lbl = L.marker([cLat,cLng], {interactive:false, icon:L.divIcon({
    html:`<div class="facet-area-label" style="border-color:${color};color:${color}">F${facetIdx+1}: ${area.toFixed(0)} sf</div>`,
    className:'', iconAnchor:[40,12], iconSize:null
  })}).addTo(drawMap);
  if(f) f.areaLabel = lbl;
}

function renderFacetList() {
  const el = document.getElementById('facetList');
  if(!el) return;
  if(!facets.length) { el.innerHTML = '<p class="mrx-fs10px-cm-tacenter">No facets yet.</p>'; return; }
  const multi = structures.length > 1;
  el.innerHTML = facets.map((f,i) => {
    const color = f.color || FACET_COLORS[i % FACET_COLORS.length];
    const pitched = f.baseArea * f.pitch;
    const s = multi ? structures.find(x => x.id === f.structureId) : null;
    return `<div class="facet-row" style="border-left:3px solid ${color};">
      <span class="facet-name">${_esc(f.label)}${s ? ' <span class="mrx-cm-w400">· '+_esc(s.name)+'</span>' : ''}</span>
      <span class="facet-area">${f.baseArea.toFixed(0)} sf</span>
      <select class="facet-pitch-sel" data-mr-pitch="${i}" title="Facet pitch">
        <option value="1.0" ${f.pitch===1?'selected':''}>Flat</option>
        <option value="1.054" ${f.pitch===1.054?'selected':''}>4/12</option>
        <option value="1.083" ${f.pitch===1.083?'selected':''}>5/12</option>
        <option value="1.118" ${f.pitch===1.118?'selected':''}>6/12</option>
        <option value="1.158" ${f.pitch===1.158?'selected':''}>7/12</option>
        <option value="1.202" ${f.pitch===1.202?'selected':''}>8/12</option>
        <option value="1.25" ${f.pitch===1.25?'selected':''}>9/12</option>
        <option value="1.302" ${f.pitch===1.302?'selected':''}>10/12</option>
        <option value="1.357" ${f.pitch===1.357?'selected':''}>11/12</option>
        <option value="1.414" ${f.pitch===1.414?'selected':''}>12/12</option>
      </select>
    </div>`;
  }).join('');
  // CSP-safe: inline onchange= is blocked (script-src-attr 'none'); wire the pitch
  // selects after render so changing a facet's roof pitch recalculates.
  el.querySelectorAll('.facet-pitch-sel').forEach(function (sel) {
    sel.addEventListener('change', function () { updateFacetPitch(Number(this.dataset.mrPitch), this.value); });
  });
}

function updateFacetPitch(fi, val) {
  if(!facets[fi]) return;
  facets[fi].pitch = parseFloat(val);
  // The facet's rakes re-slope with it (the sloped chips read facet pitch).
  renderLineList(); recalc(); autoSaveDrawing();
}

// ── AREA LABEL ON MAP ────────────────────────
// (handled by addAreaLabel above)

// Shoelace formula: area in sq feet from latlng array
function shoelaceArea(pts) {
  if(pts.length < 3) return 0;
  const origin = pts[0];
  const toFt = pts.map(p => {
    const dx = hav({lat:origin.lat, lng:p.lng}, {lat:origin.lat, lng:origin.lng});
    const dy = hav({lat:p.lat, lng:origin.lng}, {lat:origin.lat, lng:origin.lng});
    return {x: p.lng > origin.lng ? dx : -dx, y: p.lat > origin.lat ? dy : -dy};
  });
  let area = 0;
  const n = toFt.length;
  for(let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += toFt[i].x * toFt[j].y;
    area -= toFt[j].x * toFt[i].y;
  }
  return Math.abs(area / 2);
}

// ── EAVE/RAKE TOGGLE MODE ─────────────────────
// (setERListeners is gone — each line's single click handler in _addLine
// dispatches on drawMode, so nothing stacks.) Any Eave or Rake line
// toggles, as the #erBar copy has always promised.
function erToggleSegment(id) {
  const seg = drawnLines.find(l => l.id === id);
  if(!seg || (seg.type !== 4 && seg.type !== 5)) return;
  _pushUndo();
  const newType  = seg.type === 5 ? 4 : 5;
  const lt = LT[newType];
  if (seg.isPerim) seg.subtype = newType === 5 ? 'eave' : 'rake';
  seg.type = newType; seg.name = lt.n; seg.color = lt.color;
  seg.line.setStyle({color:lt.color, dashArray:lt.dash||null});
  seg.lbl.setIcon(_measIcon(seg.dist, lt.color)); _labelPassThrough(seg.lbl, drawOn);
  renderLineList(); recalc(); autoSaveDrawing();
  showToast(`Toggled to ${lt.n}`);
}

// ── GUTTER MODE (separate from perimeter) ────
// fromReticle (L3): a crosshair Add. Only Finish run ends a run then — Add
// within 6 px of the last point was already refused by the same-spot guard,
// and 6-12 px away it is a real (short) segment, not a finish.
function handleGutterClick(latlng, fromReticle) {
  if(gutterPoints.length > 0 && !fromReticle) {
    // A tap on the run's last point finishes the run (2026-09-25, L2).
    const last = gutterPoints[gutterPoints.length-1];
    const px = drawMap.latLngToContainerPoint(last).distanceTo(drawMap.latLngToContainerPoint(latlng));
    if (px <= SNAP_PX) { finishGutterRun(); return; }
  }
  _pushUndo();
  if (gutterRunId === null) gutterRunId = _nextRunId++;
  const dot = _dotAt(latlng, '#06B6D4');
  if(gutterPoints.length > 0) {
    const prev = gutterPoints[gutterPoints.length-1];
    const prevDot = gutterDots[gutterDots.length-1]||null;
    _addLine({type:10, p1:prev, p2:latlng, dot1:prevDot, dot2:dot, subtype:'gutter', runId:gutterRunId});
  }
  // Push BEFORE the autosave (L1 note): the save used to run first and the
  // stored run always lacked its last point.
  gutterPoints.push(latlng);
  gutterDots.push(dot);
  clearTemp(); renderLineList(); recalcGutters(); autoSaveDrawing();
}

// Close the open gutter run. The next gutter tap starts a new run instead of
// chaining a fake segment onto this one (audit B5). A lone first point (no
// segment yet) is not a run: its dot goes.
function finishGutterRun(opts) {
  const quiet = !!(opts && opts.quiet);
  if (gutterRunId === null && !gutterPoints.length) return;
  const runId = gutterRunId;
  const segs = drawnLines.filter(l => l.type === 10 && l.runId === runId);
  if (!quiet && segs.length) _pushUndo();
  const lone = segs.length ? [] : gutterDots.slice();
  gutterPoints = []; gutterDots = []; gutterRunId = null;
  lone.forEach(_removeDotIfOrphan);
  clearTemp();
  recalcGutters(); autoSaveDrawing();
  if (!quiet && segs.length) {
    const lf = segs.reduce((s, l) => s + l.dist, 0);
    showToast('Gutter run finished — ' + lf.toFixed(1) + ' ft', 'ok');
  }
}

// #gr-total / #gr-ds keep their text contracts ("<n.n> ft", an integer).
// Downspouts: at least one per run (Jo, decision 7) — draw-geom counts.
function recalcGutters() {
  const gutterLines = drawnLines.filter(l => l.type === 10);
  const tot = _totals().combined;
  const totalEl = document.getElementById('gr-total');
  const dsEl    = document.getElementById('gr-ds');
  if (totalEl) totalEl.textContent = tot.text.gutter;
  if (dsEl)    dsEl.textContent = tot.text.ds;
  // Per-run breakdown in a SIBLING element, never inside #gr-*.
  const runsEl = document.getElementById('gr-runs');
  if (runsEl) {
    const runs = window.NBDDrawGeom.gutterRuns(drawnLines);
    runsEl.textContent = runs.length > 1
      ? runs.map((r, i) => 'Run ' + (i + 1) + ': ' + r.lf.toFixed(1) + ' ft').join(' · ')
      : '';
  }
  const fin = document.getElementById('gutterFinishBtn');
  if (fin) fin.disabled = gutterRunId === null;
  const el = document.getElementById('gutterResult');
  if(el) el.classList.toggle('visible', gutterLines.length > 0 || drawMode === 'gutter');
}

// ── LINE SELECTION ─────────────────────────────
function selectLine(id) {
  selectedLineId = id;
  renderLineList();
  drawnLines.forEach(l => {
    if(l.line) l.line.setStyle({weight: l.id===id ? 6 : 4, opacity: l.id===id ? 1 : .95});
  });
}

function deselectLine() {
  selectedLineId = null;
  drawnLines.forEach(l => { if(l.line) l.line.setStyle({weight:4, opacity:.95}); });
  renderLineList();
}

function retypeLine(id, ltIndex) {
  const l = drawnLines.find(x => x.id === id);
  const lt = LT[ltIndex];
  if(!l || !lt || l.type === ltIndex) return;
  _pushUndo();
  l.type = ltIndex; l.name = lt.n; l.color = lt.color;
  // A line retyped TO Gutters joins the run whose end it touches, else it is
  // its own run; retyped away, it leaves one.
  l.runId = ltIndex === 10 ? (l.runId || _gutterRunFor(l.p1, l.p2, l.id)) : null;
  l.line.setStyle({color:lt.color, dashArray:lt.dash||null});
  l.lbl.setIcon(_measIcon(l.dist, lt.color)); _labelPassThrough(l.lbl, drawOn);
  renderLineList(); recalc(); recalcGutters(); autoSaveDrawing();
}

// ── UNDO / DELETE / CLEAR ─────────────────────
function deleteLine(id) {
  const i = drawnLines.findIndex(l => l.id === id); if(i < 0) return;
  _pushUndo();
  _removeLine(i);
  renderLineList(); recalc(); recalcGutters(); autoSaveDrawing();
}
function _removeLine(i) {
  const l = drawnLines[i];
  const id = l.id;
  drawMap.removeLayer(l.line);
  drawMap.removeLayer(l.lbl);
  const pi = perimSegments.indexOf(l);
  if(pi >= 0) perimSegments.splice(pi, 1);
  facets.forEach(f => { const k = f.segments.indexOf(l); if (k >= 0) f.segments.splice(k, 1); });
  drawnLines.splice(i, 1);
  _removeDotIfOrphan(l.dot1);
  _removeDotIfOrphan(l.dot2);
  if(selectedLineId === id) deselectLine();
}

function isSharedDot(dot, excludeLineId) {
  return drawnLines.some(l => l.id !== excludeLineId && (l.dot1 === dot || l.dot2 === dot));
}

// ── UNDO / REDO (2026-09-25, draw lane L2, audit H6) ──
// Undo first drops a PENDING tap (a Line-mode start point, a corner or a
// close waiting for Eave/Rake); otherwise it restores the snapshot taken
// before the last action. Snapshots are the autosave payload, so Undo
// rebuilds through the same restore path as a reload.
function _snapshot() { return JSON.stringify(_serializeDrawing()); }
function _pushUndo(snap) {
  _undoStack.push(snap || _snapshot());
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  _redoStack.length = 0;
  _syncUndoButtons();
}
function _syncUndoButtons() {
  const r = document.getElementById('drawRedoBtn');
  if (r) r.disabled = !_redoStack.length;
}
function undoLine() {
  if (resetPendingState()) { recalc(); return; }
  if (!_undoStack.length) { showToast('Nothing to undo', 'info'); return; }
  _redoStack.push(_snapshot());
  _applyPayload(JSON.parse(_undoStack.pop()), { keepView: true });
  autoSaveDrawing();
  _syncUndoButtons();
}
function redoLine() {
  resetPendingState();
  if (!_redoStack.length) { showToast('Nothing to redo', 'info'); return; }
  _undoStack.push(_snapshot());
  _applyPayload(JSON.parse(_redoStack.pop()), { keepView: true });
  autoSaveDrawing();
  _syncUndoButtons();
}

async function clearDraw() {
  // Batch 2 (iOS PWA): native confirm() always returns true in PWA
  // standalone mode (see standalone-compat.js) — destructive guards
  // get bypassed. nbdConfirm returns a real Promise<boolean> via a
  // modal in PWA mode, falls back to native confirm on desktop.
  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _ask('Clear all lines and facets?'))) return;
  // Clear is undoable (2026-09-25, L2): the snapshot keeps the drawing.
  resetPendingState();
  if (drawnLines.length || facets.length || perimPoints.length || gutterPoints.length || placedAccessories.length) _pushUndo();
  _teardownDrawing();
  const pb = document.getElementById('perimBar');
  if (pb) pb.textContent = _perimIdleHint();
  renderLineList(); renderFacetList(); renderStructureList(); renderAccessoryPanel(); recalc(); recalcGutters();
  clearSavedDrawing();
}

// Remove every drawn layer and reset the drawing state (no prompt). Shared by
// Clear, Undo/Redo, restore and Load. Structures survive (their geometry
// does not); area and angle labels go too — they used to be left behind as
// ghosts ("F1: 1075 sf" over a 0 sf calculator).
function _teardownDrawing() {
  drawnLines.forEach(l => { drawMap.removeLayer(l.line); drawMap.removeLayer(l.lbl); });
  facets.forEach(f => {
    if(f.polygon) drawMap.removeLayer(f.polygon);
    if(f.areaLabel) drawMap.removeLayer(f.areaLabel);
  });
  _allDots.forEach(d => { if (drawMap.hasLayer(d)) drawMap.removeLayer(d); });
  _allDots = [];
  placedAccessories.forEach(a => { if (a.marker && drawMap.hasLayer(a.marker)) drawMap.removeLayer(a.marker); });
  placedAccessories = [];
  if(perimPolygon) { drawMap.removeLayer(perimPolygon); }
  if(perimCloseRing) { drawMap.removeLayer(perimCloseRing); }
  clearTemp();
  _clearAngleLabels();
  facets = []; activeFacetIdx = -1;
  drawnLines = []; perimSegments = []; perimPoints = []; perimDots = [];
  gutterPoints = []; gutterDots = []; gutterRunId = null;
  perimClosed = false; perimPendingP1 = null; perimPendingP2 = null;
  perimPendingDot = null; perimPendingDotNew = false; _perimClosing = false;
  drawStart = null; drawStartDot = null; drawStartDotNew = false;
  perimPolygon = null; perimCloseRing = null;
  perimBaseArea = 0; selectedLineId = null;
  if (drawMap) drawMap.closePopup();
  hideReChooser();
}

// ── ANGLE DISPLAY ────────────────────────────
function calcAngle(pA, pB, pC) {
  // Angle at B between segments BA and BC, in degrees
  const ax = pA.lng - pB.lng, ay = pA.lat - pB.lat;
  const cx = pC.lng - pB.lng, cy = pC.lat - pB.lat;
  const dot = ax*cx + ay*cy;
  const cross = ax*cy - ay*cx;
  let angle = Math.atan2(Math.abs(cross), dot) * 180 / Math.PI;
  return angle;
}

function showAngles() {
  // Show angles at each vertex where 2+ lines meet
  const vertices = new Map(); // key: "lat,lng" -> [{p1,p2,lineId}]
  drawnLines.forEach(l => {
    if(!l.p1 || !l.p2) return;
    const k1 = l.p1.lat.toFixed(7)+','+l.p1.lng.toFixed(7);
    const k2 = l.p2.lat.toFixed(7)+','+l.p2.lng.toFixed(7);
    if(!vertices.has(k1)) vertices.set(k1,[]);
    if(!vertices.has(k2)) vertices.set(k2,[]);
    vertices.get(k1).push({other:l.p2, id:l.id});
    vertices.get(k2).push({other:l.p1, id:l.id});
  });
  // Remove old angle labels
  _clearAngleLabels();
  vertices.forEach((edges, key) => {
    if(edges.length < 2) return;
    const [lat,lng] = key.split(',').map(Number);
    const center = L.latLng(lat,lng);
    for(let i=0; i<edges.length; i++) {
      for(let j=i+1; j<edges.length; j++) {
        const angle = calcAngle(edges[i].other, center, edges[j].other);
        if(angle > 1 && angle < 179) {
          _angleMarkers.push(L.marker(center, {interactive:false, icon:L.divIcon({
            html:`<div class="angle-label">${angle.toFixed(0)}°</div>`,
            className:'angle-label-marker', iconAnchor:[12,-8], iconSize:null
          })}).addTo(drawMap));
        }
      }
    }
  });
}
// Angle markers are tracked and removed from the MAP (2026-09-25, L2). They
// used to be removed from the DOM only, leaving the markers registered on the
// map; and with no lines left, renderLineList returned before this ran, so
// Clear left every angle on the imagery.
let _angleMarkers = [];
function _clearAngleLabels() {
  _angleMarkers.forEach(m => { if (drawMap && drawMap.hasLayer(m)) drawMap.removeLayer(m); });
  _angleMarkers = [];
  document.querySelectorAll('.angle-label-marker').forEach(e=>e.remove());
}

function renderLineList() {
  const el = document.getElementById('lineList');
  if(!el) return;
  if(!drawnLines.length) {
    el.innerHTML = '<p class="mrx-fs10px-cm-tacenter-2">No lines yet.</p>';
    el.onclick = null;
    el.onchange = null;
    _clearAngleLabels(); // with no lines there are no angles (was: ghosts)
    return;
  }
  // Per-type aggregates (count + total feet), preserving LT order
  const totals = LT.map(() => ({count:0, len:0, sloped:0}));
  drawnLines.forEach(l => {
    if (totals[l.type]) { totals[l.type].count++; totals[l.type].len += l.dist; totals[l.type].sloped += l.dist * _slopeFactorFor(l); }
  });
  const chips = totals.map((t, idx) => {
    if (!t.count) return '';
    const lt = LT[idx];
    // Rake / hip / valley: the slope-corrected feet ride BESIDE the flat
    // feet (Jo, decision 7) — a sibling span, the flat number unchanged.
    const sl = slopeLfOn && (idx === 2 || idx === 3 || idx === 4) && t.sloped - t.len >= 0.05
      ? `<span class="line-total-chip-meta" title="Slope-corrected (sent to the estimate)">→ ${t.sloped.toFixed(1)} sloped</span>` : '';
    return `<span class="line-total-chip" title="${lt.n}: ${t.count} line${t.count===1?'':'s'}, ${t.len.toFixed(1)} ft total">
      <span class="lt-dot" style="background:${lt.color};${idx===4?'border:1px dashed #fff;':''}"></span>
      <span class="line-total-chip-name">${lt.n}</span>
      <span class="line-total-chip-meta">×${t.count}</span>
      <span class="line-total-chip-len">${t.len.toFixed(1)} ft</span>${sl}
    </span>`;
  }).join('');
  // Per-type ordinal (#N) numbering as we iterate drawnLines in original order
  const ridx = {};
  const ltOpts = LT.map((lt, i) => `<option value="${i}">${lt.n}</option>`).join('');
  const rows = drawnLines.map(l => {
    ridx[l.type] = (ridx[l.type] || 0) + 1;
    const isSel = l.id === selectedLineId;
    return `<div class="line-item ${isSel ? 'selected' : ''}" data-action="selectLine" data-line-id="${l.id}">
      <div class="lt-dot" style="background:${l.color};${l.type===4?'border:1px dashed #fff;':''}"></div>
      <span class="line-lbl">${l.name}<span class="line-num"> #${ridx[l.type]}</span></span>
      <span class="line-len">${l.dist.toFixed(1)} ft</span>
      ${isSel
        ? `<select class="line-type-sel" data-action="retypeLine" data-line-id="${l.id}">${ltOpts}</select>`
        : `<button class="line-del" data-action="deleteLine" data-line-id="${l.id}" aria-label="Delete line">✕</button>`}
    </div>`;
  }).join('');
  el.innerHTML = (chips ? `<div class="line-totals">${chips}</div>` : '') + rows;
  if(selectedLineId !== null) {
    const sel = el.querySelector('.line-type-sel');
    if(sel) { const l = drawnLines.find(x => x.id === selectedLineId); if(l) sel.value = l.type; }
  }
  // CSP-safe delegated handlers via DOM-property assignment (NOT inline onclick=
  // attribute, which is blocked by the prod CSP `script-src-attr 'none'`).
  // Ids are integers now; Number() (never parseInt) so a legacy decimal id
  // could still resolve (audit B3: parseInt('1790343678400.5168') missed).
  el.onclick = function(ev) {
    const target = ev.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = Number(target.dataset.lineId);
    if (action === 'deleteLine')      { ev.stopPropagation(); deleteLine(id); }
    else if (action === 'selectLine') { selectLine(id); }
    else if (action === 'retypeLine') { ev.stopPropagation(); /* change-handler does the work */ }
  };
  el.onchange = function(ev) {
    const target = ev.target.closest('[data-action="retypeLine"]');
    if (!target) return;
    retypeLine(Number(target.dataset.lineId), Number(target.value));
  };
  // Show angles when lines exist
  showAngles();
}

// ── TOTALS (2026-09-25, draw lane L2) ──
// recalc() is draw-geom's structureTotals(): each structure's own
// computeTotals() (the L1 copy of the old recalc, plus the open-outline
// guard), summed for the job. #cr-* read the JOB total — every consumer
// (estimate, Save, reports) parseFloats them — and each structure's own
// numbers show in the Structures list.
function _linesForTotals() {
  const open = new Set(perimSegments.map(s => s.id));
  return drawnLines.map(l => open.has(l.id) ? Object.assign({}, l, {openPerim:true}) : l);
}
function _totals() {
  const G = window.NBDDrawGeom;
  return G.structureTotals(_linesForTotals(), facets, structures,
    document.getElementById('pitchSel')?.value || 1.202,
    document.getElementById('wasteSel')?.value || 1.17);
}
function recalc() {
  const t = _totals();
  const c = t.combined;
  // Draw-tool readout — only present when #view-draw is in DOM. Guard
  // each one so a partial-view render doesn't blow up the calc loop.
  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setTxt('cr-base',    c.text.base);
  setTxt('cr-pitched', c.text.pitched);
  setTxt('cr-waste',   c.text.waste);
  setTxt('cr-sq',      c.text.sq);
  // "est." when an area is guessed from lines, not a closed section — a
  // sibling of #cr-base, never inside it (8+ consumers parseFloat #cr-*).
  const badge = document.getElementById('cr-est-badge');
  if (badge) badge.hidden = !(c.estimated && c.base > 0);
  const scope = document.getElementById('cr-scope');
  if (scope) scope.textContent = structures.length > 1 ? '(all ' + structures.length + ' structures)' : '';
  _renderStructureTotals(t);
  // #pitchSel changed (its data-on-change is recalc): the sloped chips of
  // lines that take the global pitch are stale — repaint the list once.
  const gp = document.getElementById('pitchSel')?.value;
  if (gp !== _lastGlobalPitch) { _lastGlobalPitch = gp; if (drawnLines.length) renderLineList(); }
  // Totals moved (an edit, Clear, or the pitch / waste selects, whose
  // data-on-change is this function): nbdDraw 'change' (L3, coalesced).
  _emitChange();
}
let _lastGlobalPitch = null;

// Slope correction for one line (Jo's switch, decision 7). A perimeter edge
// uses its facet's pitch; everything else the #pitchSel pitch. Rake climbs
// the full pitch, hip/valley half as steeply (draw-geom slopeFactors).
function _riseFor(l) {
  const f = l.facetId ? facets.find(x => x.id === l.facetId) : null;
  const factor = f ? f.pitch : parseFloat(document.getElementById('pitchSel')?.value || 1.202);
  return window.NBDDrawGeom.riseFromFactor(factor);
}
function _slopeFactorFor(l) {
  if (l.type !== 2 && l.type !== 3 && l.type !== 4) return 1;
  const sf = window.NBDDrawGeom.slopeFactors(_riseFor(l));
  return l.type === 4 ? sf.rake : sf.hipValley;
}
function setSlopeLf(on) {
  slopeLfOn = on !== false;
  try { localStorage.setItem(SLOPE_PREF_KEY, slopeLfOn ? '1' : '0'); } catch (e) { /* storage blocked */ }
  const box = document.getElementById('slopeLfToggle');
  if (box) box.checked = slopeLfOn;
  renderLineList();
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── ZOOM TO FIT ──────────────────────────────
function zoomToFit() {
  if(!drawMap) return;
  const allPts = [];
  drawnLines.forEach(l => { if(l.p1) allPts.push(l.p1); if(l.p2) allPts.push(l.p2); });
  facets.forEach(f => f.points.forEach(p => allPts.push(p)));
  gutterPoints.forEach(p => allPts.push(p));
  perimPoints.forEach(p => allPts.push(p));
  if(!allPts.length) { showToast('No lines to fit','info'); return; }
  const bounds = L.latLngBounds(allPts);
  drawMap.fitBounds(bounds.pad(0.15));
}

// ── SCREENSHOT EXPORT ────────────────────────
function screenshotMap() {
  showToast('Capturing map...','info');
  // Use leaflet-image or canvas approach
  try {
    const mapEl = document.getElementById('drawMap');
    // Try html2canvas if available, else use leaflet's built-in
    if(typeof html2canvas !== 'undefined') {
      html2canvas(mapEl).then(canvas => {
        canvas.toBlob(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'nbd-drawing-'+(document.getElementById('drawSearch')?.value||'map').replace(/\s+/g,'-')+'.png';
          a.click(); URL.revokeObjectURL(url);
          showToast('Screenshot saved!','ok');
        });
      });
    } else {
      // Fallback: grab the tile canvas
      const canvases = mapEl.querySelectorAll('canvas');
      if(canvases.length) {
        canvases[0].toBlob(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'nbd-drawing.png';
          a.click(); URL.revokeObjectURL(url);
          showToast('Screenshot saved!','ok');
        });
      } else {
        showToast('Canvas not available — try in a different browser','error');
      }
    }
  } catch(e) { showToast('Screenshot failed: '+e.message,'error'); }
}

// ── GENERATE ESTIMATE (2026-09-25, draw lane L2 — audit B7) ──
// What it used to do wrong, all money:
//   - it mapped LT indices from a stale comment ("1=valley, 3=rake,
//     4=wall"): a drawn Valley priced as rake/drip edge, a Ridge Vent as
//     valley, every Rake as wall/step flashing;
//   - drawn gutter feet and placed accessories never reached the estimate;
//   - a Flat drawing went as pitch 8 ('|| 8'), the steep band;
//   - "Classic" (native confirm's Cancel) threw ReferenceError on
//     updateEstCalc after opening the V2 template chooser instead.
// Now draw-geom's estimateImport() builds both payloads (see its header for
// the rules: Jo's decisions 2, 6 and 7), and an in-page chooser names both
// builders, shows the numbers (flat beside sloped) and the per-structure
// breakdown, and makes the rep acknowledge a missing or guessed roof area.
// IMPORTANT (kept): `rawSqft` is the PITCHED area — the builders apply only
// waste (estimate-logic-engine.js: 'rawSqft', // Actual roof area (pitch
// applied)); sending the footprint under-counted every estimate by 12-41%.
function _estimatePlan() {
  const t = _totals();
  const lines = drawnLines.map(l => ({type:l.type, dist:l.dist, rise:_riseFor(l), p1:l.p1, p2:l.p2, runId:l.runId}));
  const imp = window.NBDDrawGeom.estimateImport({
    lines, accessories: placedAccessories.map(a => ({type:a.type})),
    pitchFactor: document.getElementById('pitchSel')?.value || 1.202,
    slope: slopeLfOn,
    totals: {base:t.combined.base, pitched:t.combined.pitched, estimated:t.combined.estimated},
    downspouts: t.combined.downspouts,
    previousCounts: _lastImportCounts()
  });
  return { t, imp };
}

// The pipe / chimney / skylight counts the LAST drawing import put into the
// V2 builder (2026-09-25, L2 review). V2 keeps its state across a close with
// no lead, and restores a draft for 10 minutes, so without this a drawing with
// no markers left the previous roof's counts priced (A's skylight stayed on
// B). estimateImport() sends 0 for exactly those. localStorage because the
// V2 draft outlives a reload; nbd_-prefixed so logout's purge takes it too.
const _IMPORT_COUNTS_KEY = 'nbd_draw_import_counts_v1';
function _lastImportCounts() {
  try { return JSON.parse(localStorage.getItem(_IMPORT_COUNTS_KEY) || 'null') || {}; }
  catch (e) { return {}; }
}
function _rememberImportCounts(counts) {
  try { localStorage.setItem(_IMPORT_COUNTS_KEY, JSON.stringify(counts || {})); } catch (e) { /* storage blocked */ }
}

function importToEstimate() {
  const plan = _estimatePlan();
  if (plan.imp.warning === 'empty') { showToast('Nothing to estimate yet — draw the roof first', 'info'); return; }
  _openEstimateChooser(plan);
}

function _sendToV2(imp) {
  // Measurements ride through open(opts), never a setTimeout DOM poke: the
  // builder may still be lazy-loading (openEstimateV2Builder can be the
  // load-then-run stub, which forwards arguments) and open() restores any
  // nbd_v2_draft_v1 draft asynchronously; it applies these AFTER the draft
  // restore and owns the toast (NEW-D39, d8 sweep).
  window.openEstimateV2Builder({ importMeasurements: Object.assign({}, imp.v2) });
  _rememberImportCounts(imp.sentCounts);
}

async function _sendToClassic(imp) {
  // Classic builder: `updateEstCalc` does raw × pitch × waste. The drawing
  // already baked pitch (and per-facet pitch) into cr-pitched, so we pass
  // pitched area AND pin the classic pitch selector to Flat (1.000×) so it
  // isn't multiplied a second time. startNewEstimate() now opens the V2
  // template chooser, so the classic form is opened with the classic entry
  // point, AFTER the lazy 'estimates' bundle has loaded.
  const addr = document.getElementById('drawSearch')?.value || '';
  goTo('est');
  try { if (window.ScriptLoader && window.ScriptLoader.loadBundle) await window.ScriptLoader.loadBundle('estimates'); }
  catch (e) { showToast('Estimate builder did not load — try again', 'error'); return; }
  if (typeof window.startNewEstimateOriginal !== 'function' || typeof window.updateEstCalc !== 'function') {
    showToast('Classic builder unavailable — opening the Estimate Builder instead', 'warning');
    _sendToV2(imp);
    return;
  }
  window.startNewEstimateOriginal();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  const c = imp.classic;
  set('estAddr', addr);
  set('estRawSqft', c.rawSqft);
  set('estPitch', '1.0|Flat');
  set('estRidge', c.ridge);
  set('estEave', c.eave);
  set('estHip', c.hip);
  // Drawn gutter feet price the classic gutter add-on (its only gutter line).
  // Always set (2026-09-25, L2 review): startNewEstimateOriginal() does not
  // clear estGutterLF, so a drawing with no gutters kept the previous
  // drawing's feet — a $960.50 add-on at $8.50/LF on a job with none.
  set('estGutterLF', c.gutterLF > 0 ? c.gutterLF : '');
  const noteEl = document.getElementById('drawImportNote');
  if (noteEl) {
    noteEl.style.display = 'block';
    noteEl.textContent = 'Pitched area imported from drawing tool. Pitch set to Flat so your '
      + imp.drawnRise + '/12 drawing pitch is not applied twice.';
  }
  window.updateEstCalc();
}

// The in-page chooser (was a native confirm() whose OK/Cancel meant
// V2/Classic, and which the installed app answers YES on its own).
function _openEstimateChooser(plan) {
  const imp = plan.imp, t = plan.t;
  // Toasts stack ABOVE modals (--z-toast): on an iPhone "Gutter run
  // finished — 66.6 ft" sat over this chooser's buttons (WebKit check,
  // 2026-09-25). The rep's attention is here now; clear them.
  document.querySelectorAll('#toastContainer .toast').forEach(el => {
    if (typeof window._closeToast === 'function') window._closeToast(el.id); else el.remove();
  });
  let bg = document.getElementById('drawEstChooser');
  if (bg) bg.remove();
  bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.id = 'drawEstChooser';
  const card = document.createElement('div');
  card.className = 'modal';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Generate estimate');
  card.style.cssText = 'max-width:440px;max-height:86vh;overflow-y:auto;';
  const el = (tag, css, text) => { const n = document.createElement(tag); if (css) n.style.cssText = css; if (text !== undefined) n.textContent = text; return n; };
  card.appendChild(el('h3', "font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;", 'Generate Estimate'));

  const v = imp.v2;
  const rows = [
    ['Roof area (pitched)', v.rawSqft + ' sf' + (t.combined.base > 0 ? '  ·  footprint ' + Math.round(t.combined.base) + ' sf' : '')],
    ['Pitch', (imp.drawnRise === 0 ? 'Flat' : imp.drawnRise + '/12') + (imp.drawnRise !== imp.pitchRise ? '  →  sent as ' + imp.pitchRise + '/12 (the builder’s lowest)' : '')],
    ['Eave', v.eaveLf + ' LF'], ['Ridge', v.ridgeLf + ' LF']
  ];
  [['Rake', 'rakeLf'], ['Hip', 'hipLf'], ['Valley', 'valleyLf']].forEach(([n, k]) => {
    rows.push([n, imp.slope && imp.sloped[k] !== imp.flat[k]
      ? imp.flat[k] + ' LF flat  →  ' + imp.sloped[k] + ' LF sloped (sent)'
      : v[k] + ' LF']);
  });
  rows.push(['Wall / step flashing', v.wallLf + ' LF']);
  // Gutters always go (0 = none drawn), so say which footage prices them.
  rows.push(['Gutters', imp.guttersLf > 0
    ? imp.guttersLf + ' LF  ·  ' + imp.downspouts + ' downspout' + (imp.downspouts === 1 ? '' : 's')
    : 'none drawn — 0 sent; line items use eave']);
  ['pipes', 'chimneys', 'skylights'].forEach(k => {
    const n = k[0].toUpperCase() + k.slice(1);
    if (v[k] > 0) rows.push([n, String(v[k])]);
    else if (v[k] === 0) rows.push([n, '0 — clears the last drawing’s count']);
  });
  if (imp.notPriced.ridgeVentLf > 0) {
    rows.push(['Ridge vent (not sent)', imp.notPriced.ridgeVentLf + ' LF — the builder sizes ridge cap and vent from Ridge'
      + (v.ridgeLf > 0 ? '' : '; no Ridge lines are drawn, so neither is priced')]);
  }
  if (imp.notPriced.dripEdgeLf > 0) rows.push(['Drip edge (not sent)', imp.notPriced.dripEdgeLf + ' LF — the builder sizes it from eave + rake']);
  const tbl = el('div', 'font-size:12px;line-height:1.5;margin-bottom:10px;');
  tbl.dataset.role = 'est-rows';
  rows.forEach(([k, val]) => {
    const r = el('div', 'display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--br,#2a2f35);padding:3px 0;');
    r.appendChild(el('span', 'color:var(--m);', k));
    r.appendChild(el('span', 'font-weight:700;text-align:right;', val));
    tbl.appendChild(r);
  });
  card.appendChild(tbl);

  // Per-structure breakdown (Jo, decision 3) — the estimate gets the total.
  if (t.per.length > 1) {
    const sb = el('div', 'font-size:11px;color:var(--m);margin-bottom:10px;');
    sb.dataset.role = 'est-structures';
    sb.appendChild(el('div', 'font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;', 'By structure'));
    t.per.forEach(p => sb.appendChild(el('div', '', p.name + ': ' + p.text.pitched + ' pitched · ' + p.text.sq + (p.gutterLf > 0 ? ' · ' + p.text.gutter + ' gutter' : ''))));
    card.appendChild(sb);
  }

  // Missing / guessed roof area must be acknowledged (Jo, decision 7).
  let ack = null;
  if (imp.warning === 'no-roof' || imp.warning === 'estimated-area') {
    const warn = el('div', 'background:rgba(234,179,8,.10);border:1px solid rgba(234,179,8,.45);border-radius:6px;padding:8px 10px;font-size:12px;margin-bottom:10px;');
    warn.dataset.role = 'est-warning';
    warn.appendChild(el('div', 'font-weight:700;margin-bottom:4px;', imp.warning === 'no-roof' ? 'No roof area drawn' : 'Roof area is estimated, not measured'));
    // Name only the guessed structure(s) and their own footprint (L2
    // review): a job whose house is measured but whose garage has lines and
    // no closed section used to read "No roof section is closed, so the
    // <whole job> sf footprint is guessed".
    const guessed = t.per.filter(p => p.source === 'eave-rake' || p.source === 'lines');
    const guessedSf = Math.round(guessed.reduce((s, p) => s + p.base, 0));
    warn.appendChild(el('div', '', imp.warning === 'no-roof'
      ? 'Nothing is outlined, so the estimate gets 0 sf of roof — only the lengths above.'
      : (t.per.length > 1
        ? guessed.map(p => p.name).join(', ') + (guessed.length === 1 ? ' has' : ' have') + ' no closed section, so '
          + (guessed.length === 1 ? 'its ' : 'their ') + guessedSf + ' sf footprint is guessed from lines'
          + (t.combined.measured ? ' (the rest is measured)' : '') + '. Close a perimeter for a measured area.'
        : 'No roof section is closed, so the ' + guessedSf + ' sf footprint is guessed from your lines. Close a perimeter for a measured area.')));
    const lab = el('label', 'display:flex;gap:8px;align-items:center;margin-top:6px;font-weight:700;cursor:pointer;');
    ack = document.createElement('input');
    ack.type = 'checkbox';
    ack.id = 'drawEstAck';
    lab.appendChild(ack);
    lab.appendChild(el('span', '', 'I understand — continue'));
    warn.appendChild(lab);
    card.appendChild(warn);
  }

  const row = el('div', 'display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;');
  const btn = (label, cls, role) => { const b = el('button', 'min-height:44px;', label); b.type = 'button'; b.className = 'btn ' + cls; b.dataset.role = role; return b; };
  const cancel = btn('Cancel', 'btn-ghost', 'est-cancel');
  const classic = btn('Classic builder', 'btn-ghost', 'est-classic');
  const v2 = btn('Estimate Builder (V2)', 'btn-orange', 'est-v2');
  v2.setAttribute('autofocus', '');
  if (!window.openEstimateV2Builder) v2.disabled = true;
  row.appendChild(cancel); row.appendChild(classic); row.appendChild(v2);
  card.appendChild(row);
  bg.appendChild(card);
  document.body.appendChild(bg);

  const gate = () => { const ok = !ack || ack.checked; v2.disabled = !ok || !window.openEstimateV2Builder; classic.disabled = !ok; };
  if (ack) ack.addEventListener('change', gate);
  gate();
  const close = () => { if (window.nbdModal) window.nbdModal.close(bg); bg.classList.remove('open'); setTimeout(() => bg.remove(), 300); };
  cancel.addEventListener('click', close);
  v2.addEventListener('click', () => { if (v2.disabled) return; close(); _sendToV2(imp); });
  classic.addEventListener('click', () => { if (classic.disabled) return; close(); _sendToClassic(imp); });
  if (window.nbdModal) window.nbdModal.open(bg); else bg.classList.add('open');
}

async function searchDraw() {
  const q=document.getElementById('drawSearch').value.trim(); if(!q)return;
  const d=await geocode(q); if(!d)return;
  drawMap.setView([d.lat,d.lon],19);
}

// ═══════════════════════════════════════════════════════════
// SAVE DRAWING TO CUSTOMER (Firestore)
// Saves the full drawing state as GeoJSON + metadata to
// leads/{leadId}/drawings/{drawingId}. Includes version history.
// ═══════════════════════════════════════════════════════════
async function saveDrawingToCustomer() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const addr = (document.getElementById('drawSearch')?.value || '').trim();
  if (!addr) {
    showToast('Enter an address first so we can match to a customer', 'error');
    return;
  }
  if (!window._user?.uid || !window._db) {
    showToast('Not signed in — cannot save', 'error');
    return;
  }
  if (!drawnLines.length && !facets.length) {
    showToast('Nothing to save — draw some lines first', 'error');
    return;
  }

  // Find matching lead by address
  const leads = window._leads || [];
  const addrNorm = addr.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matched = leads.find(l => {
    const lNorm = String(l.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return lNorm && addrNorm && (lNorm.includes(addrNorm.substring(0, 12)) || addrNorm.includes(lNorm.substring(0, 12)));
  });

  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  let leadId = matched?.id;
  if (!leadId) {
    // No match — ask if they want to create a new lead
    // Batch 2 (iOS PWA): nbdConfirm gates the unlinked-save fallback.
    if (!(await _ask('No customer found for "' + addr + '". Save as an unlinked drawing?\n\n(You can link it to a customer later.)'))) return;
    leadId = '_unlinked_' + window._user.uid;
  } else {
    // 2026-09-25 (L2): Save used to throw for every drawing with a facet
    // (facets[].name was undefined — Firestore rejects undefined). Now that
    // it works, the fuzzy match above (the first 12 normalized address
    // characters, either way round) CAN pick the wrong customer ("123 Main
    // St" matches "123 Main Street Apt 4"), so the rep confirms the named
    // lead before anything is written.
    const who = [matched.firstName, matched.lastName].filter(Boolean).join(' ') || matched.name || 'this customer';
    if (!(await _ask('Save this drawing to ' + who + (matched.address ? ' — ' + matched.address : '') + '?'))) return;
  }

  // No closed roof section = no measured area: say so before saving it.
  const tot = _totals();
  if (!tot.combined.measured) {
    const what = tot.combined.base > 0 ? 'Its ' + Math.round(tot.combined.base) + ' sf area is guessed from your lines.' : 'It has no roof area.';
    if (!(await _ask('No roof section is closed on this drawing. ' + what + ' Save it anyway?'))) return;
  }

  // Build the drawing data. Every v1 key is kept (loadDrawingFromCustomer on
  // older builds, the data export and erasure paths read them); v2 adds
  // schemaVersion, gutter feet, downspouts, accessories, structures and the
  // per-line / per-facet fields the one restore path needs. stripUndefined()
  // makes the doc Firestore-safe whatever a field holds.
  const agg = window.NBDDrawGeom.aggregateForEstimate(drawnLines, []);
  const drawingData = window.NBDDrawGeom.stripUndefined({
    address: addr,
    measurements: {
      totalAreaSF: parseFloat(document.getElementById('cr-base')?.textContent) || 0,
      pitchedAreaSF: parseFloat(document.getElementById('cr-pitched')?.textContent) || 0,
      withWasteSF: parseFloat(document.getElementById('cr-waste')?.textContent) || 0,
      squares: parseFloat(document.getElementById('cr-sq')?.textContent) || 0,
      ridgeLF: agg.exact.ridgeLf,
      eaveLF: agg.exact.eaveLf,
      rakeLF: agg.exact.rakeLf,
      hipLF: agg.exact.hipLf,
      valleyLF: agg.exact.valleyLf
    },
    lines: drawnLines.map(l => ({
      id: l.id, type: l.type, name: l.name, dist: l.dist, subtype: l.subtype || null,
      isPerim: !!l.isPerim, runId: l.runId || null, facetId: l.facetId || null, structureId: l.structureId,
      p1: { lat: l.p1.lat, lng: l.p1.lng },
      p2: { lat: l.p2.lat, lng: l.p2.lng }
    })),
    facets: facets.map(f => ({
      id: f.id, name: f.label, label: f.label, color: f.color || null,
      pitch: f.pitch, closed: f.closed, baseArea: f.baseArea, structureId: f.structureId,
      points: f.points.map(p => ({ lat: p.lat, lng: p.lng }))
    })),
    pitch: document.getElementById('pitchSel')?.value || '1.202',
    waste: document.getElementById('wasteSel')?.value || '1.17',
    userId: window._user.uid,
    leadId: leadId,
    version: 1,
    schemaVersion: 2,
    gutterLF: tot.combined.gutterLf,
    downspouts: tot.combined.downspouts,
    accessories: placedAccessories.map(a => ({ type: a.type, lat: a.latlng.lat, lng: a.latlng.lng, structureId: a.structureId })),
    structures: structures.map(s => ({ id: s.id, name: s.name })),
    createdAt: window.serverTimestamp(),
    updatedAt: window.serverTimestamp()
  });

  try {
    // Check for existing drawings to increment version
    if (leadId && !leadId.startsWith('_unlinked_')) {
      const existing = await window.getDocs(window.collection(window._db, 'leads', leadId, 'drawings'));
      drawingData.version = existing.size + 1;
    }

    const collPath = leadId.startsWith('_unlinked_')
      ? window.collection(window._db, 'drawings')
      : window.collection(window._db, 'leads', leadId, 'drawings');

    await window.addDoc(collPath, drawingData);
    showToast('Drawing saved' + (matched ? ' to ' + (matched.firstName || matched.address || 'customer') : ' (unlinked)') + ' — v' + drawingData.version, 'success');
  } catch (e) {
    console.error('Save drawing failed:', e);
    showToast('Save failed: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// LOAD DRAWING FROM CUSTOMER
// Inverse of saveDrawingToCustomer. Matches by address → pulls
// the most recent drawing from leads/{leadId}/drawings (or the
// unlinked collection) and rehydrates facets/lines onto the map.
// Safe to call without a current drawing — will replace whatever
// is on screen after confirmation if the canvas is non-empty.
// ═══════════════════════════════════════════════════════════
async function loadDrawingFromCustomer() {
  const addr = (document.getElementById('drawSearch')?.value || '').trim();
  if (!addr) {
    showToast('Enter an address first so we can find the customer', 'error');
    return;
  }
  if (!window._user?.uid || !window._db) {
    showToast('Not signed in — cannot load', 'error');
    return;
  }

  // Find matching lead (same logic as save)
  const leads = window._leads || [];
  const addrNorm = addr.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matched = leads.find(l => {
    const lNorm = String(l.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return lNorm && addrNorm && (lNorm.includes(addrNorm.substring(0, 12)) || addrNorm.includes(lNorm.substring(0, 12)));
  });

  const leadId = matched?.id || ('_unlinked_' + window._user.uid);
  const isUnlinked = leadId.startsWith('_unlinked_');

  try {
    // Query the appropriate collection, ordered by version desc, limit 1
    const collPath = isUnlinked
      ? window.collection(window._db, 'drawings')
      : window.collection(window._db, 'leads', leadId, 'drawings');

    // For unlinked, we filter to this user; linked is scoped to the lead.
    const q = isUnlinked
      ? window.query(collPath, window.where('userId', '==', window._user.uid), window.orderBy('version', 'desc'), window.limit(1))
      : window.query(collPath, window.orderBy('version', 'desc'), window.limit(1));

    const snap = await window.getDocs(q);
    if (snap.empty) {
      showToast('No saved drawings found for this address', 'info');
      return;
    }

    const data = snap.docs[0].data() || {};

    // Confirm replacement if canvas has work
    // Batch 2 (iOS PWA): nbdConfirm gates the destructive overwrite.
    if ((drawnLines && drawnLines.length) || (facets && facets.length)) {
      const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      if (!(await _ask('Replace the current drawing with v' + (data.version || '?') + ' from ' + (matched?.firstName || matched?.address || 'customer') + '?'))) return;
    }

    // Replace the current drawing — through the ONE restore path (2026-09-25,
    // draw lane L2): _applyPayload() tears down every layer without a second
    // prompt (not clearDraw(), which asks "Clear all lines and facets?" after
    // we already asked "Replace the current drawing…?"), then normalizes the
    // doc — v1 (lines + facets only) or v2 (runs, structures, accessories) —
    // and PAINTS it: every line with its dots, label and popup, every facet
    // with its polygon and "F#" label, then renderLineList(); renderFacetList();
    // recalc(). (History: the old loop pushed plain objects and waited for a
    // redrawAll() that never existed, so a load showed an empty canvas; the
    // fix after that painted lines and polygons but no dots, popups, labels
    // or gutter readout.) Undoable: the snapshot keeps what was replaced.
    _pushUndo();
    _applyPayload(data, { selects: true });
    autoSaveDrawing();

    // Center map on drawing bounds if possible
    try {
      const allPts = [];
      drawnLines.forEach(l => { allPts.push(l.p1, l.p2); });
      facets.forEach(f => { (f.points || []).forEach(p => allPts.push(p)); });
      if (allPts.length && drawMap) {
        const bounds = L.latLngBounds(allPts);
        drawMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 21 });
      }
    } catch (err) { /* bounds best-effort */ }

    showToast('Loaded v' + (data.version || '?') + (matched ? ' from ' + (matched.firstName || matched.address || 'customer') : ' (unlinked)'), 'success');
  } catch (e) {
    console.error('Load drawing failed:', e);
    showToast('Load failed: ' + e.message, 'error');
  }
}

// (The old direct window export of loadDrawingFromCustomer is gone —
// Tranche 2c-2. The Load button's data-fn dispatch resolves it through
// __NBD_CALL_REGISTRY; see the registration block at the bottom.)

// ═══════════════════════════════════════════════════════════
// ROOF ACCESSORIES (pipes, skylights, chimneys, vents, etc.)
// Click-to-place icons on the map + count form in sidebar.
// Counts auto-populate in estimates.
// ═══════════════════════════════════════════════════════════
const ACCESSORIES = [
  { id: 'pipe',      icon: '🔵', label: 'Pipe Boot',       color: '#4A9EFF' },
  { id: 'skylight',  icon: '🟦', label: 'Skylight',        color: '#38BDF8' },
  { id: 'chimney',   icon: '🟫', label: 'Chimney',         color: '#92400E' },
  { id: 'vent',      icon: '⬜', label: 'Roof Vent',       color: '#6B7280' },
  { id: 'satellite',  icon: '📡', label: 'Satellite Dish',  color: '#9B6DFF' },
  { id: 'turbine',   icon: '🌀', label: 'Turbine Vent',    color: '#14B8A6' }
];
let placedAccessories = []; // { id, type, latlng, marker }
let accessoryMode = null; // null = not placing, or accessory type id

function toggleAccessoryMode(typeId) {
  if (accessoryMode === typeId) {
    // Turn off
    accessoryMode = null;
    drawMap.getContainer().style.cursor = '';
    showToast('Accessory placement off', 'info');
  } else {
    accessoryMode = typeId;
    const acc = ACCESSORIES.find(a => a.id === typeId);
    drawMap.getContainer().style.cursor = 'crosshair';
    showToast(_crosshair ? 'Put the crosshair on it, then Add: ' + (acc?.label || typeId) : _tap('Click the roof to place: ') + (acc?.label || typeId), 'info');
  }
  renderAccessoryPanel();
  _emitChange();
}

function placeAccessory(latlng) {
  if (!accessoryMode) return false;
  const acc = ACCESSORIES.find(a => a.id === accessoryMode);
  if (!acc) return false;
  _pushUndo();
  _addAccessoryMarker({ type: accessoryMode, lat: latlng.lat, lng: latlng.lng, structureId: activeStructureId });
  renderAccessoryPanel();
  autoSaveDrawing();
  return true;
}

// One marker factory for placing and restoring (2026-09-25, L2): the marker
// was draggable but its new position was never stored, and accessories were
// not in the autosave at all — a reload lost every one of them.
let _nextAccId = 1;
function _addAccessoryMarker(a) {
  const acc = ACCESSORIES.find(x => x.id === a.type);
  if (!acc) return null;
  const icon = L.divIcon({
    html: '<div style="background:' + acc.color + '20;border:2px solid ' + acc.color + ';width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.3);">' + acc.icon + '</div>',
    iconSize: [28, 28],
    className: ''
  });
  const latlng = L.latLng(a.lat, a.lng);
  const marker = L.marker(latlng, { icon, draggable: true }).addTo(drawMap);
  const rec = { id: _nextAccId++, type: a.type, latlng, marker, structureId: a.structureId || activeStructureId };
  placedAccessories.push(rec);
  // Crosshair mode (L3): a tap on a marker aims like any tap; removal goes
  // through the crosshair screen (nbdDraw.pick → remove).
  _accessoryPassThrough(marker);
  let before = null;
  marker.on('dragstart', () => { before = _snapshot(); });
  marker.on('dragend', () => {
    if (before) _pushUndo(before);
    before = null;
    rec.latlng = marker.getLatLng();
    autoSaveDrawing();
  });
  // Click to remove
  // Batch 2 (iOS PWA): nbdConfirm gates the destructive remove via a
  // real modal in standalone mode. Native confirm falls through on desktop.
  marker.on('click', async function() {
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (await _ask('Remove this ' + acc.label + '?')) _removeAccessory(rec.id);
  });
  return rec;
}
// Remove one placed accessory (undoable). No question asked here: the
// marker's click confirms first, and so does the crosshair screen.
function _removeAccessory(id) {
  const rec = placedAccessories.find(x => x.id === id);
  if (!rec) return false;
  _pushUndo();
  if (rec.marker && drawMap.hasLayer(rec.marker)) drawMap.removeLayer(rec.marker);
  placedAccessories = placedAccessories.filter(x => x !== rec);
  renderAccessoryPanel();
  autoSaveDrawing();
  return true;
}

function getAccessoryCounts() {
  const counts = {};
  ACCESSORIES.forEach(a => { counts[a.id] = 0; });
  placedAccessories.forEach(a => { counts[a.type] = (counts[a.type] || 0) + 1; });
  return counts;
}

function renderAccessoryPanel() {
  const panel = document.getElementById('accessoryPanel');
  if (!panel) return;
  const counts = getAccessoryCounts();
  panel.innerHTML = ACCESSORIES.map(a => {
    const isActive = accessoryMode === a.id;
    const count = counts[a.id] || 0;
    return '<div class="mrx-dflex-aicenter-gap8px">'
      + '<button data-mr-action="toggleAccessoryMode" data-mr-id="' + a.id + '" style="background:' + (isActive ? a.color + '20' : 'transparent') + ';border:1px solid ' + (isActive ? a.color : 'var(--br,#2a2f35)') + ';color:' + (isActive ? a.color : 'var(--m,#888)') + ';padding:5px 10px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;flex:1;text-align:left;font-family:\'Barlow Condensed\',sans-serif;letter-spacing:.03em;transition:all .15s;">'
      + a.icon + ' ' + a.label + '</button>'
      + '<span style="font-family:\'Barlow Condensed\',sans-serif;font-size:16px;font-weight:800;color:' + (count > 0 ? 'var(--t,#fff)' : 'var(--m,#888)') + ';min-width:24px;text-align:center;">' + count + '</span>'
      + '</div>';
  }).join('');
}

// Hook into map click — place accessory if in accessory mode
// (called from the main drawMap.on('click') handler)

// ── Generate Scope of Work from Drawing ──
// Customer-facing document showing what work will be performed,
// derived from the drawing measurements. Different from the
// measurement report (which is technical/internal).
// ═══════════════════════════════════════════════════════════
// SUN EXPOSURE (Google Solar data, fetched SERVER-SIDE)
// Shows a sun-exposure overlay on the drawing. The data comes from
// the requestMeasurement callable (purpose 'sun-exposure'), which
// holds the Solar key, caches each roof for 180 days per company
// and enforces the per-company daily cap
// (functions/integrations/solar-measure.js runSunAnalysis). If the
// server can't answer, a static latitude-based estimate is shown.
// No key is ever read, stored or prompted for on the device.
// ═══════════════════════════════════════════════════════════

// Until 2026-10-04 this tool read a Google key from localStorage. Clear any
// copy a device still holds — a key must never live on a phone.
try { localStorage.removeItem('nbd_google_solar_key'); } catch (_) {}

async function _sunExposureCallable() {
  if (!window._functions || !window._httpsCallable) {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    window._functions = window._functions || mod.getFunctions();
    window._httpsCallable = window._httpsCallable || mod.httpsCallable;
  }
  return window._httpsCallable(window._functions, 'requestMeasurement');
}

async function runSolarAnalysis() {
  const center = drawMap ? drawMap.getCenter() : null;
  if (!center) { showToast('Open the drawing tool first', 'error'); return; }

  const addr = document.getElementById('drawSearch')?.value || '';
  showToast('Running solar analysis...', 'info');

  try {
    const fn = await _sunExposureCallable();
    const res = await fn({ purpose: 'sun-exposure', lat: center.lat, lng: center.lng, address: addr });
    const d = (res && res.data) || {};
    if (!d.sun) throw new Error('No sun data returned');
    renderSolarOverlay(d.sun);
    const max = Number(d.sun.maxSunshineHoursPerYear);
    showToast('Solar analysis complete — ' + (isFinite(max) && max > 0 ? max.toFixed(0) : '—') + ' hours/year max sun'
      + (d.cached ? ' (saved result, no new charge)' : ''), 'success');
  } catch (e) {
    console.warn('Sun analysis failed:', e && (e.code || e.message));
    renderSolarEstimate(center.lat);
    showToast('Satellite sun data unavailable' + (e && e.message ? ' (' + e.message + ')' : '') + ' — showing an estimate.', 'warning');
  }
}

// sun: { maxSunshineHoursPerYear, segments: [{ lat, lng, areaMeters2, sunshineHoursMedian }] }
function renderSolarOverlay(sun) {
  // Remove previous overlay
  if (window._solarOverlay) { drawMap.removeLayer(window._solarOverlay); }

  const segs = sun && Array.isArray(sun.segments) ? sun.segments : null;
  if (!segs) return;
  const maxRaw = Number(sun.maxSunshineHoursPerYear);
  const maxHours = isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 1500;

  const group = L.layerGroup();

  // Draw roof segments colored by sun exposure
  segs.forEach((seg, i) => {
    const lat = Number(seg && seg.lat), lng = Number(seg && seg.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const hours = Number(seg.sunshineHoursMedian) || 0; // median sunshine
    const area = Number(seg.areaMeters2) || 0;
    const ratio = Math.min(1, hours / maxHours);
    // Red = most sun, blue = least sun
    const r = Math.round(255 * ratio);
    const b = Math.round(255 * (1 - ratio));
    const color = `rgb(${r},${Math.round(100 * ratio)},${b})`;

    L.circle([lat, lng], {
      radius: Math.sqrt(area || 50) * 2,
      color: color,
      fillColor: color,
      fillOpacity: 0.4,
      weight: 1
    }).bindPopup(`<b>Segment ${i + 1}</b><br>${hours.toFixed(0)} hrs/yr sunshine<br>${(area * 10.764).toFixed(0)} SF`).addTo(group);
  });

  // Summary label
  const center = drawMap.getCenter();
  L.marker(center, {
    icon: L.divIcon({
      html: `<div class="mrx-bgrgba2341-c000-p6px12px">☀️ ${isFinite(maxRaw) && maxRaw > 0 ? maxRaw.toFixed(0) : '—'} hrs/yr max · ${segs.length} segments</div>`,
      className: '', iconAnchor: [0, 0]
    })
  }).addTo(group);

  group.addTo(drawMap);
  window._solarOverlay = group;
}

function renderSolarEstimate(lat) {
  // Simple estimate based on latitude — no API call
  // US average: 1000-2500 kWh/kW/yr depending on location
  if (window._solarOverlay) { drawMap.removeLayer(window._solarOverlay); }

  const absLat = Math.abs(lat);
  const sunHours = Math.round(2500 - (absLat - 25) * 30); // rough estimate
  const center = drawMap.getCenter();

  const group = L.layerGroup();

  // Orange-to-red gradient circle showing general sun exposure
  L.circle(center, {
    radius: 80,
    color: '#EAB308',
    fillColor: '#EAB308',
    fillOpacity: 0.15,
    weight: 2,
    dashArray: '6,4'
  }).addTo(group);

  // Sun path arc (simplified)
  const arcPoints = [];
  for (let angle = -80; angle <= 80; angle += 10) {
    const rad = angle * Math.PI / 180;
    arcPoints.push([
      center.lat + Math.cos(rad) * 0.0008,
      center.lng + Math.sin(rad) * 0.001
    ]);
  }
  L.polyline(arcPoints, { color: '#EAB308', weight: 2, dashArray: '4,4', opacity: 0.6 }).addTo(group);

  L.marker(center, {
    icon: L.divIcon({
      html: `<div class="mrx-bgrgba2341-c000-p6px12px">☀️ Est. ${sunHours} hrs/yr · Lat ${lat.toFixed(1)}° · <span class="mrx-fs10px-w400">Latitude estimate</span></div>`,
      className: '', iconAnchor: [0, 0]
    })
  }).addTo(group);

  group.addTo(drawMap);
  window._solarOverlay = group;
}

// async since 2026-09-06: the filename carries a tenant-resolved prefix and
// company-profile hydration must be awaited (company-profile.js _tenantFilePrefix).
// Every caller discards the return value (data-action buttons, the voice-command
// dispatch, and the maps API export), so awaiting here is safe.
async function generateScopeFromDrawing() {
  const addr = document.getElementById('drawSearch')?.value || 'Property Address';
  const area = document.getElementById('cr-base')?.textContent || '0 sf';
  const pitched = document.getElementById('cr-pitched')?.textContent || '0 sf';
  const sq = document.getElementById('cr-sq')?.textContent || '0 sq';
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const ridgeLF = drawnLines.filter(l => l.type === 0).reduce((s, l) => s + l.dist, 0).toFixed(1);
  const eaveLF = drawnLines.filter(l => l.type === 5).reduce((s, l) => s + l.dist, 0).toFixed(1);
  const rakeLF = drawnLines.filter(l => l.type === 4).reduce((s, l) => s + l.dist, 0).toFixed(1);
  const hipLF = drawnLines.filter(l => l.type === 2).reduce((s, l) => s + l.dist, 0).toFixed(1);
  const valleyLF = drawnLines.filter(l => l.type === 3).reduce((s, l) => s + l.dist, 0).toFixed(1);
  // Ridge vent is its own line (Jo, decision 6): drawn Ridge Vent sizes the
  // ventilation; with none drawn it follows the ridge, as it always has.
  const ventDrawn = drawnLines.filter(l => l.type === 1).reduce((s, l) => s + l.dist, 0);
  const ventLF = (ventDrawn > 0 ? ventDrawn : parseFloat(ridgeLF)).toFixed(1);
  const counts = typeof getAccessoryCounts === 'function' ? getAccessoryCounts() : {};

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Scope of Work — ${addr}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Barlow',sans-serif;padding:36px;max-width:860px;margin:0 auto;}
.hdr{display:flex;justify-content:space-between;padding-bottom:18px;border-bottom:3px solid #BD5728;margin-bottom:24px;}
.brand{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;text-transform:uppercase;}.brand span{color:var(--orange,#BD5728);}
.badge{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--orange,#BD5728);border:1px solid #BD5728;padding:2px 9px;border-radius:2px;display:inline-block;margin-top:5px;}
h2{font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--orange,#BD5728);margin:22px 0 10px;border-bottom:1px solid #eee;padding-bottom:4px;}
.scope-item{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;}
.scope-check{color:#22c55e;font-weight:800;font-size:16px;flex-shrink:0;margin-top:1px;}
.scope-text{flex:1;line-height:1.5;}
.scope-qty{font-family:'Barlow Condensed',sans-serif;font-weight:700;color:#1A3057;min-width:80px;text-align:right;}
.meas-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
.meas-card{background:#f8f8f8;border:1px solid #eee;border-radius:6px;padding:12px;text-align:center;}
.meas-val{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:700;color:var(--orange,#BD5728);}
.meas-lbl{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-top:3px;}
.sig{margin-top:40px;display:grid;grid-template-columns:1fr 1fr;gap:40px;}.sig-line{border-top:1px solid #333;padding-top:6px;font-size:11px;color:#666;margin-top:50px;}
.foot{margin-top:30px;font-size:10px;color:#999;display:flex;justify-content:space-between;}
@media print{body{padding:20px;}@page{margin:1.5cm;size:letter;}}</style></head><body>
<div class="hdr"><div><div class="brand">No Big Deal <span>Home Solutions</span></div><div class="badge">Scope of Work</div></div>
<div style="text-align:right;"><div style="font-size:14px;font-weight:600;">${addr}</div><div style="font-size:11px;color:#666;">${date}</div></div></div>

<h2>Project Measurements</h2>
<div class="meas-grid">
  <div class="meas-card"><div class="meas-val">${area}</div><div class="meas-lbl">Roof Area</div></div>
  <div class="meas-card"><div class="meas-val">${pitched}</div><div class="meas-lbl">Pitched Area</div></div>
  <div class="meas-card"><div class="meas-val">${sq}</div><div class="meas-lbl">Squares</div></div>
</div>

<h2>Scope of Work</h2>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Remove existing roof covering (tear-off 1 layer)</span><span class="scope-qty">${sq}</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install synthetic underlayment over entire deck</span><span class="scope-qty">${sq}</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install ice & water shield at eaves and valleys</span><span class="scope-qty">${eaveLF} LF + ${valleyLF} LF</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install architectural shingles (GAF Timberline series)</span><span class="scope-qty">${sq}</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install starter strip at eaves</span><span class="scope-qty">${eaveLF} LF</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install drip edge at eaves and rakes</span><span class="scope-qty">${(parseFloat(eaveLF) + parseFloat(rakeLF)).toFixed(0)} LF</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install ridge cap shingles</span><span class="scope-qty">${ridgeLF} LF</span></div>
${parseFloat(hipLF) > 0 ? '<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install hip cap shingles</span><span class="scope-qty">' + hipLF + ' LF</span></div>' : ''}
${parseFloat(valleyLF) > 0 ? '<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install valley flashing / weave</span><span class="scope-qty">' + valleyLF + ' LF</span></div>' : ''}
${(counts.pipe || 0) > 0 ? '<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Replace pipe boot flashings</span><span class="scope-qty">' + counts.pipe + ' EA</span></div>' : ''}
${(counts.skylight || 0) > 0 ? '<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Re-flash skylights</span><span class="scope-qty">' + counts.skylight + ' EA</span></div>' : ''}
${(counts.chimney || 0) > 0 ? '<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Re-flash chimney</span><span class="scope-qty">' + counts.chimney + ' EA</span></div>' : ''}
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Install ridge ventilation</span><span class="scope-qty">${ventLF} LF</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Complete cleanup and debris removal</span><span class="scope-qty">1 JOB</span></div>
<div class="scope-item"><span class="scope-check">✓</span><span class="scope-text">Final inspection and walkthrough with homeowner</span><span class="scope-qty">1 JOB</span></div>

<h2>Terms</h2>
<p style="font-size:12px;line-height:1.6;color:#333;">All work performed by No Big Deal Home Solutions includes industry-standard materials and labor. Work area will be protected during installation. Final cleanup includes magnet sweep of yard and driveway. Manufacturer warranties apply per selected material tier.</p>

<div class="sig"><div><div class="sig-line">Homeowner Signature</div></div><div><div class="sig-line">Contractor Signature</div></div></div>
<div class="foot"><span>No Big Deal Home Solutions · (859) 420-7382 · nobigdealwithjoedeal.com</span><span>Generated by NBD Pro</span></div>
</body></html>`;

  if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
    // Tenant-resolved prefix — the Scope of Work goes to the ADJUSTER.
    const _scopeBase = 'Scope-' + date.replace(/\s/g, '') + '.pdf';
    const _scopeName = window._tenantFileName ? await window._tenantFileName(_scopeBase) : _scopeBase;
    window.NBDDocViewer.open({ html, title: 'Scope of Work — ' + addr, filename: _scopeName });
  } else {
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }
}

// async since 2026-09-06: the filename carries a tenant-resolved prefix and
// company-profile hydration must be awaited (company-profile.js _tenantFilePrefix).
// Every caller discards the return value (data-action buttons, the voice-command
// dispatch, and the maps API export), so awaiting here is safe.
async function exportDrawReport() {
  const addr=document.getElementById('drawSearch').value||'No Address';
  const lines=drawnLines;
  const total=lines.reduce((s,l)=>s+l.dist,0);
  const grouped={};
  lines.forEach(l=>{if(!grouped[l.name])grouped[l.name]={color:l.color,total:0,count:0};grouped[l.name].total+=l.dist;grouped[l.name].count++;});
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NBD Drawing Report</title>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Barlow',sans-serif;padding:32px;max-width:850px;margin:0 auto;}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:3px solid #BD5728;margin-bottom:22px;}
  .brand{font-family:'Barlow Condensed',sans-serif;font-size:26px;font-weight:800;text-transform:uppercase;}
  .brand span{color:var(--orange,#BD5728);}.badge{font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--orange,#BD5728);border:1px solid #BD5728;padding:2px 9px;border-radius:2px;display:inline-block;margin-top:4px;}
  .addr{font-size:15px;font-weight:600;text-align:right;}.date{font-size:11px;color:#666;text-align:right;}
  h2{font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--orange,#BD5728);margin:20px 0 10px;padding-bottom:4px;border-bottom:1px solid #eee;}
  table{width:100%;border-collapse:collapse;}th{background:#0A0C0F;color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:7px 10px;text-align:left;}
  td{padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;}tr:nth-child(even) td{background:#fafafa;}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;}
  .card{background:#f8f8f8;border:1px solid #eee;border-radius:7px;padding:12px;text-align:center;}
  .card .v{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:700;color:var(--orange,#BD5728);}
  .card .k{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-top:3px;}
  .foot{margin-top:28px;padding-top:14px;border-top:1px solid #eee;display:flex;justify-content:space-between;font-size:10px;color:#999;}
  .total-row td{font-weight:700;border-top:2px solid #eee;}</style></head><body>
  <div class="hdr"><div><div class="brand">No Big Deal <span>Home Solutions</span></div><div class="badge">Drawing Measurement Report</div></div>
  <div><div class="addr">${addr}</div><div class="date">${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div></div></div>
  <div class="cards">
    <div class="card"><div class="v">${document.getElementById('cr-base').textContent}</div><div class="k">Base Area</div></div>
    <div class="card"><div class="v">${document.getElementById('cr-pitched').textContent}</div><div class="k">Pitched Area</div></div>
    <div class="card"><div class="v">${document.getElementById('cr-waste').textContent}</div><div class="k">With Waste</div></div>
    <div class="card" style="background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);"><div class="v" style="color:#fff;">${document.getElementById('cr-sq').textContent}</div><div class="k" style="color:rgba(255,255,255,.8);">Squares</div></div>
  </div>
  <h2>Line Summary</h2>
  <table><thead><tr><th>Type</th><th>Count</th><th>Total LF</th></tr></thead><tbody>
  ${Object.entries(grouped).map(([n,v])=>`<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${v.color};margin-right:6px;vertical-align:middle;"></span>${n}</td><td>${v.count}</td><td>${v.total.toFixed(1)} ft</td></tr>`).join('')}
  <tr class="total-row"><td><b>TOTAL</b></td><td><b>${lines.length}</b></td><td><b>${total.toFixed(1)} ft</b></td></tr>
  </tbody></table>
  <h2>Individual Lines</h2>
  <table><thead><tr><th>Type</th><th>Length</th></tr></thead><tbody>
  ${lines.map(l=>`<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${l.color};margin-right:6px;vertical-align:middle;"></span>${l.name}</td><td>${l.dist.toFixed(1)} ft</td></tr>`).join('')}
  </tbody></table>
  <div class="foot"><div>No Big Deal Home Solutions — nobigdealwithjoedeal.com</div><div>Measurements are estimates. Always verify on-site.</div></div>
  </body></html>`;
  if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
    // Tenant-resolved prefix — '' when the brand is not hydrated, never 'NBD'.
    const _measBase = 'Measurements-' + new Date().toISOString().split('T')[0] + '.pdf';
    const _measName = window._tenantFileName ? await window._tenantFileName(_measBase) : _measBase;
    window.NBDDocViewer.open({
      html: html,
      title: 'Roof Measurement Report',
      filename: _measName
    });
    return;
  }
  const w=window.open('','_blank'); if(w){ w.document.write(html); w.document.close(); }
}

// ── SAVE / RESTORE DRAWING STATE (localStorage) ──────────
function _drawStorageKey() {
  const addr = (document.getElementById('drawSearch')?.value || '').trim();
  return 'nbd_draw_' + (addr ? addr.replace(/\s+/g,'_').substring(0,60) : 'default');
}

// The whole drawing as plain data — the autosave payload, the Undo/Redo
// snapshot, and (reshaped) the Firestore doc. v2 (2026-09-25, L2) adds
// structures, gutter runs, the open outline's edges, accessories and the id
// sequences; every v1 key is still written (older builds and the test
// harness read lines / facets / perimPoints / perimClosed / gutterPoints).
function _serializeDrawing() {
  const ll = p => ({lat:p.lat, lng:p.lng});
  return {
    v: 2,
    address: document.getElementById('drawSearch')?.value || '',
    lines: drawnLines.map(l => ({
      id:l.id, type:l.type, name:l.name, color:l.color, dist:l.dist,
      p1:ll(l.p1), p2:ll(l.p2), subtype:l.subtype||null,
      isPerim:!!l.isPerim, runId:l.runId||null, facetId:l.facetId||null, structureId:l.structureId
    })),
    facets: facets.map(f => ({
      id:f.id, name:f.label, label:f.label, color:f.color, pitch:f.pitch, closed:f.closed, baseArea:f.baseArea,
      structureId:f.structureId, points: f.points.map(ll)
    })),
    perimPoints: perimPoints.map(ll),
    perimSegIds: perimSegments.map(s => s.id),
    perimClosed: false,
    gutterPoints: gutterPoints.map(ll),
    gutterRun: gutterRunId !== null ? {runId:gutterRunId, points:gutterPoints.map(ll)} : null,
    accessories: placedAccessories.map(a => ({type:a.type, lat:a.latlng.lat, lng:a.latlng.lng, structureId:a.structureId})),
    structures: structures.map(s => ({id:s.id, name:s.name})),
    activeStructureId,
    seq: {line:_nextLineId, run:_nextRunId, facet:_nextFacetId, struct:_nextStructId},
    pitch: document.getElementById('pitchSel')?.value || '1.202',
    waste: document.getElementById('wasteSel')?.value || '1.17',
    ts: Date.now()
  };
}

function autoSaveDrawing() {
  try {
    localStorage.setItem(_drawStorageKey(), JSON.stringify(_serializeDrawing()));
  } catch(e) { /* quota or private browsing — silently fail */ }
  // Every committed change autosaves, so this is where nbdDraw's 'change'
  // event is raised for them (L3; coalesced, one per action).
  _emitChange();
}

// THE restore path (2026-09-25, draw lane L2). draw-geom's
// normalizeDrawing() repairs the data (integer ids, one copy of a
// B4-duplicated facet, facet labels, run ids, a default structure — see its
// header); this paints it with the same factories live drawing uses. It
// replaced four divergent copies: the old autosave restore labelled facets
// "undefined" / "FNaN: 1205 sf", stacked two dots on every shared corner (29
// dots for 9 lines), dropped the line popup, and re-opened the last gutter
// chain so the next tap bridged onto it.
// opts.selects: also restore #pitchSel / #wasteSel (reload and Load — not Undo).
function _applyPayload(raw, opts) {
  const o = opts || {};
  const G = window.NBDDrawGeom;
  const d = G.normalizeDrawing(raw);
  _teardownDrawing();
  structures = d.structures.map(s => ({id:s.id, name:s.name}));
  activeStructureId = d.activeStructureId;
  _nextLineId = d.seq.line; _nextRunId = d.seq.run; _nextFacetId = d.seq.facet;
  _nextStructId = Math.max(_nextStructId, d.seq.struct);
  const LL = p => L.latLng(p.lat, p.lng);
  const segsByFacet = new Map();
  d.lines.forEach(l => {
    const color = LT[l.type].color;
    const p1 = LL(l.p1), p2 = LL(l.p2);
    const rec = _addLine({
      id:l.id, type:l.type, p1, p2, dist:l.dist, dot1:_dotAt(p1, color), dot2:_dotAt(p2, color),
      subtype:l.subtype, isPerim:l.isPerim, runId:l.runId, facetId:l.facetId, structureId:l.structureId
    });
    if (l.facetId) { if (!segsByFacet.has(l.facetId)) segsByFacet.set(l.facetId, []); segsByFacet.get(l.facetId).push(rec); }
  });
  d.facets.forEach(f => {
    const pts = f.points.map(LL);
    const color = f.color || FACET_COLORS[facets.length % FACET_COLORS.length];
    _addFacet({ id:f.id, label:f.label, color, points:pts, dots:pts.map(p => _dotAt(p, color)),
      segments: segsByFacet.get(f.id) || [], pitch:f.pitch, structureId:f.structureId });
  });
  if (d.perimPoints.length) {
    const color = FACET_COLORS[facets.length % FACET_COLORS.length];
    perimPoints = d.perimPoints.map(LL);
    perimDots = perimPoints.map(p => _dotAt(p, color));
    perimSegments = drawnLines.filter(l => d.perimSegIds.indexOf(l.id) >= 0);
    perimCloseRing = L.circleMarker(perimPoints[0], {radius:14, color, fillColor:'transparent', weight:2, dashArray:'4,3', opacity:.6, interactive:false}).addTo(drawMap);
  }
  if (d.gutterRun) {
    gutterRunId = d.gutterRun.runId;
    gutterPoints = d.gutterRun.points.map(LL);
    gutterDots = gutterPoints.map(p => _dotAt(p, '#06B6D4'));
  }
  d.accessories.forEach(a => _addAccessoryMarker(a));
  if (o.selects) {
    if(d.pitch) { const el = document.getElementById('pitchSel'); if(el) el.value = d.pitch; }
    if(d.waste) { const el = document.getElementById('wasteSel'); if(el) el.value = d.waste; }
  }
  renderLineList(); renderFacetList(); renderStructureList(); renderAccessoryPanel(); recalc(); recalcGutters();
  return d;
}

function tryRestoreDrawing() {
  try {
    const key = _drawStorageKey();
    const raw = localStorage.getItem(key);
    if(!raw) return;
    const data = JSON.parse(raw);
    // Only restore if less than 30 days old (extended from 7 days)
    if(Date.now() - (data.ts||0) > 30*24*60*60*1000) { localStorage.removeItem(key); return; }
    const hasWork = (data.lines && data.lines.length) || (data.facets && data.facets.length)
      || (data.accessories && data.accessories.length) || (data.perimPoints && data.perimPoints.length);
    if(!hasWork) return;
    _applyPayload(data, { selects: true });
    showToast('Previous drawing restored','ok');
  } catch(e) { console.warn('[maps-routing] drawing restore failed:', e && e.message); }
}

function clearSavedDrawing() {
  try { localStorage.removeItem(_drawStorageKey()); } catch(e) {}
}

// ╔═══════════════════════════════════════════════════════════════════╗
// ║  WOW FEATURES — INDUSTRY-FIRST CAPABILITIES                     ║
// ╚═══════════════════════════════════════════════════════════════════╝

// ── FEATURE 1: SMART WASTE CALCULATOR ────────────────────────────
// Calculates waste % based on actual roof complexity instead of flat %
function calcSmartWaste() {
  const valleys = drawnLines.filter(l => l.type === 3);
  const hips    = drawnLines.filter(l => l.type === 2);
  // Ridge lines only — Ridge Vent is drawn along a ridge, not as more of it
  // (Jo, decision 6, 2026-09-25).
  const ridges  = drawnLines.filter(l => l.type === 0);
  const flashings = drawnLines.filter(l => l.type === 6 || l.type === 7);
  const nFacets = Math.max(facets.length, 1);

  // Base waste: 10% for simple, scales with complexity
  let waste = 0.10;
  // Valleys add 2.5% each (lots of cuts)
  waste += valleys.length * 0.025;
  // Hips add 1.5% each
  waste += hips.length * 0.015;
  // Extra facets beyond 2 add 1% each
  if(nFacets > 2) waste += (nFacets - 2) * 0.01;
  // Flashings add 0.5% each (detail work = more cuts)
  waste += flashings.length * 0.005;
  // Short ridge relative to perimeter = steep/complex
  const totalRidge = ridges.reduce((s,l) => s+l.dist, 0);
  const totalPerim = drawnLines.filter(l => l.type === 4 || l.type === 5).reduce((s,l) => s+l.dist, 0);
  if(totalPerim > 0 && totalRidge > 0 && totalRidge / totalPerim < 0.15) waste += 0.03;

  // Compute average angle at vertices — tight angles = more waste
  const vertices = new Map();
  drawnLines.forEach(l => {
    if(!l.p1 || !l.p2 || l.type === 10) return;
    const k1 = l.p1.lat.toFixed(7)+','+l.p1.lng.toFixed(7);
    const k2 = l.p2.lat.toFixed(7)+','+l.p2.lng.toFixed(7);
    if(!vertices.has(k1)) vertices.set(k1,[]);
    if(!vertices.has(k2)) vertices.set(k2,[]);
    vertices.get(k1).push(l.p2);
    vertices.get(k2).push(l.p1);
  });
  let angles=[], angleCnt=0;
  vertices.forEach((others, key) => {
    if(others.length < 2) return;
    const [lat,lng] = key.split(',').map(Number);
    const center = {lat,lng};
    for(let i=0;i<others.length;i++) {
      for(let j=i+1;j<others.length;j++) {
        const a = calcAngle(others[i], center, others[j]);
        if(a > 1 && a < 179) { angles.push(a); angleCnt++; }
      }
    }
  });
  if(angleCnt > 0) {
    const avgAngle = angles.reduce((s,a)=>s+a,0) / angleCnt;
    if(avgAngle < 75) waste += 0.04;
    else if(avgAngle < 90) waste += 0.02;
  }

  // Cap between 8% and 35%
  waste = Math.max(0.08, Math.min(0.35, waste));

  // Build explanation
  const reasons = [];
  if(valleys.length) reasons.push(`${valleys.length} valley${valleys.length>1?'s':''}`);
  if(hips.length) reasons.push(`${hips.length} hip${hips.length>1?'s':''}`);
  if(nFacets > 2) reasons.push(`${nFacets} facets`);
  if(flashings.length) reasons.push(`${flashings.length} flashing detail${flashings.length>1?'s':''}`);
  if(angleCnt > 0 && angles.reduce((s,a)=>s+a,0)/angleCnt < 90) reasons.push('tight angles');

  return {
    pct: waste,
    multiplier: 1 + waste,
    label: (waste * 100).toFixed(0) + '%',
    reasons: reasons.length ? reasons.join(', ') : 'simple geometry',
    complexity: waste <= 0.12 ? 'Simple' : waste <= 0.18 ? 'Moderate' : waste <= 0.25 ? 'Complex' : 'Very Complex'
  };
}

function applySmartWaste() {
  const sw = calcSmartWaste();
  // Find closest waste option or use custom
  const wasteSel = document.getElementById('wasteSel');
  if(!wasteSel) return;
  // Add smart option if not present
  let smartOpt = wasteSel.querySelector('option[value="smart"]');
  if(!smartOpt) {
    smartOpt = document.createElement('option');
    smartOpt.value = 'smart';
    wasteSel.insertBefore(smartOpt, wasteSel.firstChild);
  }
  smartOpt.textContent = `Smart: ${sw.label} (${sw.complexity})`;
  smartOpt.value = sw.multiplier.toFixed(4);
  wasteSel.value = sw.multiplier.toFixed(4);
  recalc();
  // Update smart waste display
  const swEl = document.getElementById('smartWasteInfo');
  if(swEl) {
    swEl.innerHTML = `<span class="mrx-corange-w700">${sw.label}</span> waste — ${sw.complexity} roof (${sw.reasons})`;
    swEl.style.display = 'block';
  }
  showToast(`Smart Waste: ${sw.label} — ${sw.reasons}`, 'ok');
  autoSaveDrawing();
}


// ── FEATURE 2: ONE-CLICK MATERIAL TAKEOFF ────────────────────────
const MATERIAL_SPECS = {
  shingleBundlesPerSq: 3,       // Architectural shingles
  underlaymentSqPerRoll: 4,     // Synthetic underlayment
  dripEdgeFtPerPiece: 10,       // Standard drip edge length
  starterStripFtPerBundle: 120, // Starter strip coverage
  ridgeCapBundleLF: 31.7,       // Hip & ridge cap per bundle
  iceWaterFtPerRoll: 75,        // Ice & water shield per roll
  iceWaterWidthFt: 3,           // 36" wide = eave coverage
  stepFlashPerPiece: 1,         // Each piece ~1 LF coverage
  pipeBootCount: 2,             // Default estimate
  ventCount: 1,                 // Ridge vent per 40ft ridge
};

function generateMaterialTakeoff() {
  const sw = calcSmartWaste();
  const base = parseFloat(document.getElementById('cr-base')?.textContent) || 0;
  const pitched = parseFloat(document.getElementById('cr-pitched')?.textContent) || 0;
  const wasteArea = pitched * sw.multiplier;
  const squares = wasteArea / 100;

  // Line totals by type. 2026-09-25 (draw lane L2):
  //   - ridge cap comes from Ridge lines only; drawn Ridge Vent sizes the
  //     vent pieces, and with none drawn the vent follows the ridge as
  //     before (Jo, decision 6). Ridge Vent used to count as ridge cap too;
  //   - rake / hip / valley use the slope-corrected feet while Jo's switch
  //     is on (decision 7) — the same numbers Generate Estimate sends;
  //   - downspouts are per gutter run, at least one each (decision 7).
  const sumBy = (t, slope) => drawnLines.filter(l => l.type === t).reduce((s,l) => s + l.dist * (slope && slopeLfOn ? _slopeFactorFor(l) : 1), 0);
  const ridgeLF  = sumBy(0);
  const ventDrawnLF = sumBy(1);
  const ventLF   = ventDrawnLF > 0 ? ventDrawnLF : ridgeLF;
  const hipLF    = sumBy(2, true);
  const valleyLF = sumBy(3, true);
  const rakeLF   = sumBy(4, true);
  const eaveLF   = sumBy(5);
  const flashLF  = sumBy(6);
  const stepLF   = sumBy(7);
  const dripLF   = sumBy(8);
  const gutterLF = sumBy(10);
  const gutterDs = _totals().combined.downspouts;

  const M = MATERIAL_SPECS;
  const materials = [
    { name: 'Shingle Bundles', qty: Math.ceil(squares * M.shingleBundlesPerSq), unit: 'bdl', note: `${squares.toFixed(1)} sq × ${M.shingleBundlesPerSq}/sq` },
    { name: 'Underlayment Rolls', qty: Math.ceil(squares / M.underlaymentSqPerRoll), unit: 'roll', note: `${M.underlaymentSqPerRoll} sq/roll` },
    { name: 'Drip Edge', qty: Math.ceil((eaveLF + rakeLF + dripLF) / M.dripEdgeFtPerPiece), unit: 'pc', note: `${(eaveLF+rakeLF+dripLF).toFixed(0)} LF total` },
    { name: 'Starter Strip', qty: Math.ceil((eaveLF + rakeLF) / M.starterStripFtPerBundle), unit: 'bdl', note: `${(eaveLF+rakeLF).toFixed(0)} LF perimeter` },
    { name: 'Hip & Ridge Cap', qty: Math.ceil((ridgeLF + hipLF) / M.ridgeCapBundleLF), unit: 'bdl', note: `${(ridgeLF+hipLF).toFixed(0)} LF ridge+hip` },
  ];

  // Conditional materials
  if(eaveLF > 0) {
    materials.push({ name: 'Ice & Water Shield', qty: Math.ceil(eaveLF / M.iceWaterFtPerRoll), unit: 'roll', note: `${eaveLF.toFixed(0)} LF eave` });
  }
  if(valleyLF > 0) {
    materials.push({ name: 'Valley Metal / Ice Shield', qty: Math.ceil(valleyLF / 10), unit: 'pc', note: `${valleyLF.toFixed(0)} LF valley` });
  }
  if(stepLF > 0) {
    materials.push({ name: 'Step Flashing', qty: Math.ceil(stepLF), unit: 'pc', note: `${stepLF.toFixed(0)} LF step` });
  }
  if(flashLF > 0) {
    materials.push({ name: 'Flashing (misc)', qty: Math.ceil(flashLF / 10), unit: 'pc', note: `${flashLF.toFixed(0)} LF` });
  }
  if(ventLF > 0) {
    materials.push({ name: 'Ridge Vent', qty: Math.ceil(ventLF / 4), unit: 'pc (4ft)', note: `${ventLF.toFixed(0)} LF ${ventDrawnLF > 0 ? 'ridge vent' : 'ridge'}` });
  }
  if(gutterLF > 0) {
    materials.push({ name: 'Gutter Sections (10ft)', qty: Math.ceil(gutterLF / 10), unit: 'pc', note: `${gutterLF.toFixed(0)} LF gutter` });
    materials.push({ name: 'Downspouts', qty: gutterDs, unit: 'pc', note: '1 per 40 LF, at least 1 per run' });
  }
  // Always add nails + pipe boots
  materials.push({ name: 'Roofing Nails (coil)', qty: Math.ceil(squares / 4), unit: 'box', note: '~4 sq per box' });
  materials.push({ name: 'Pipe Boots', qty: M.pipeBootCount, unit: 'pc', note: 'Verify on-site' });

  return { materials, squares, wasteInfo: sw };
}

// async since 2026-09-06: the filename carries a tenant-resolved prefix and
// company-profile hydration must be awaited (company-profile.js _tenantFilePrefix).
// Every caller discards the return value (data-action buttons, the voice-command
// dispatch, and the maps API export), so awaiting here is safe.
async function showMaterialTakeoff() {
  const t = generateMaterialTakeoff();
  if(!t.materials.length || t.squares < 0.1) { showToast('Draw some lines first','info'); return; }

  const addr = document.getElementById('drawSearch')?.value || 'Property';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Material Takeoff — ${addr}</title>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Barlow',sans-serif;padding:32px;max-width:850px;margin:0 auto;}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:3px solid #BD5728;margin-bottom:22px;}
  .brand{font-family:'Barlow Condensed',sans-serif;font-size:26px;font-weight:800;text-transform:uppercase;}
  .brand span{color:var(--orange,#BD5728);}.badge{font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--orange,#BD5728);border:1px solid #BD5728;padding:2px 9px;border-radius:2px;display:inline-block;margin-top:4px;}
  .addr{font-size:15px;font-weight:600;text-align:right;}.date{font-size:11px;color:#666;text-align:right;}
  h2{font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--orange,#BD5728);margin:20px 0 10px;padding-bottom:4px;border-bottom:1px solid #eee;}
  table{width:100%;border-collapse:collapse;}th{background:#0A0C0F;color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:7px 10px;text-align:left;}
  td{padding:8px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;}tr:nth-child(even) td{background:#fafafa;}
  .qty{font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:700;color:var(--orange,#BD5728);}
  .note{font-size:10px;color:#888;}
  .summary{background:#f8f8f8;border:1px solid #eee;border-radius:8px;padding:16px;margin-bottom:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;text-align:center;}
  .summary .v{font-family:'Barlow Condensed',sans-serif;font-size:24px;font-weight:700;color:var(--orange,#BD5728);}
  .summary .k{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.05em;}
  .warn{background:#FEF3C7;border:1px solid #FCD34D;border-radius:6px;padding:10px 14px;font-size:11px;color:#92400E;margin-top:16px;}
  .foot{margin-top:28px;padding-top:14px;border-top:1px solid #eee;display:flex;justify-content:space-between;font-size:10px;color:#999;}
  </style></head><body>
  <div class="hdr"><div><div class="brand">No Big Deal <span>Home Solutions</span></div><div class="badge">Material Takeoff</div></div>
  <div><div class="addr">${addr}</div><div class="date">${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div></div></div>
  <div class="summary">
    <div><div class="v">${t.squares.toFixed(1)} sq</div><div class="k">Total Squares</div></div>
    <div><div class="v">${t.wasteInfo.label}</div><div class="k">Smart Waste (${t.wasteInfo.complexity})</div></div>
    <div><div class="v">${t.materials.length}</div><div class="k">Material Items</div></div>
  </div>
  <h2>Material List</h2>
  <table><thead><tr><th>Material</th><th>Qty</th><th>Unit</th><th>Based On</th></tr></thead><tbody>
  ${t.materials.map(m => `<tr><td><b>${m.name}</b></td><td class="qty">${m.qty}</td><td>${m.unit}</td><td class="note">${m.note}</td></tr>`).join('')}
  </tbody></table>
  <div class="warn">⚠️ Quantities are estimates based on satellite measurements. Always verify on-site before ordering. Pipe boot count and specialty items should be confirmed during inspection.</div>
  <div class="foot"><div>No Big Deal Home Solutions — nobigdealwithjoedeal.com</div><div>Generated from NBD Pro Drawing Tool</div></div>
  </body></html>`;
  if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
    const slug = (addr || 'takeoff').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
    // Tenant-resolved prefix — '' when the brand is not hydrated, never 'NBD'.
    const _takeBase = 'Takeoff-' + slug + '-' + new Date().toISOString().split('T')[0] + '.pdf';
    const _takeName = window._tenantFileName ? await window._tenantFileName(_takeBase) : _takeBase;
    window.NBDDocViewer.open({
      html: html,
      title: 'Material Takeoff — ' + (addr || 'Drawing'),
      filename: _takeName
    });
    return;
  }
  const w = window.open('','_blank'); if(w){ w.document.write(html); w.document.close(); }
}


// ── FEATURE 3: SHADOW-BASED PITCH ESTIMATION ─────────────────────
// Solar position calculator
function getSunPosition(lat, lng, date) {
  const d = date || new Date();
  const rad = Math.PI / 180;
  // Day of year
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  const dayOfYear = Math.floor(diff / 86400000);
  // Solar declination (simplified)
  const declination = 23.45 * Math.sin(rad * (360/365) * (dayOfYear - 81));
  // Hour angle
  const solarNoon = 12; // approximate
  const hours = d.getHours() + d.getMinutes()/60;
  const hourAngle = (hours - solarNoon) * 15;
  // Elevation angle
  const sinElev = Math.sin(lat*rad)*Math.sin(declination*rad) +
                  Math.cos(lat*rad)*Math.cos(declination*rad)*Math.cos(hourAngle*rad);
  const elevation = Math.asin(sinElev) / rad;
  // Azimuth
  const cosAz = (Math.sin(declination*rad) - Math.sin(elevation*rad)*Math.sin(lat*rad)) /
                (Math.cos(elevation*rad)*Math.cos(lat*rad));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
  if(hourAngle > 0) azimuth = 360 - azimuth;

  return { elevation, azimuth };
}

function startShadowPitch() {
  shadowMode = 'shadow'; // First: draw shadow line
  showToast('Step 1: Draw a line along the shadow edge on the satellite image', 'info');
  const bar = document.getElementById('shadowBar');
  if(bar) { bar.style.display = 'block'; bar.textContent = _tap('☀️ Step 1: Click two points along the roof shadow on the ground.'); }
}

function handleShadowClick(latlng) {
  if(shadowMode === 'shadow') {
    if(!shadowLine) {
      shadowLine = { p1: latlng };
      makeDraggableDot(latlng, '#EAB308');
      showToast(_tap('Now click the end of the shadow'), 'info');
    } else {
      shadowLine.p2 = latlng;
      makeDraggableDot(latlng, '#EAB308');
      const sl = L.polyline([shadowLine.p1, shadowLine.p2], {color:'#EAB308', weight:3, dashArray:'6,3', opacity:.8}).addTo(drawMap);
      shadowLine.leafletLine = sl;
      shadowLine.dist = hav(shadowLine.p1, shadowLine.p2);
      shadowMode = 'edge'; // Next: draw roof edge
      const bar = document.getElementById('shadowBar');
      if(bar) bar.textContent = `☀️ Shadow: ${shadowLine.dist.toFixed(1)} ft — Step 2: Now draw the corresponding roof edge (eave to ridge).`;
      showToast('Step 2: Draw the corresponding roof edge line (eave to peak)', 'info');
    }
  } else if(shadowMode === 'edge') {
    if(!shadowEdgeLine) {
      shadowEdgeLine = { p1: latlng };
      makeDraggableDot(latlng, '#F97316');
    } else {
      shadowEdgeLine.p2 = latlng;
      makeDraggableDot(latlng, '#F97316');
      const el = L.polyline([shadowEdgeLine.p1, shadowEdgeLine.p2], {color:'#F97316', weight:3, dashArray:'6,3', opacity:.8}).addTo(drawMap);
      shadowEdgeLine.leafletLine = el;
      shadowEdgeLine.dist = hav(shadowEdgeLine.p1, shadowEdgeLine.p2);
      // Calculate pitch
      estimatePitchFromShadow();
    }
  }
}

function estimatePitchFromShadow() {
  if(!shadowLine || !shadowEdgeLine) return;
  const center = drawMap.getCenter();
  const sun = getSunPosition(center.lat, center.lng);

  // Shadow length on ground = building height / tan(sun elevation)
  // So building height = shadow length * tan(sun elevation)
  // Pitch = atan(height / run) where run = horizontal roof extent
  const shadowLen = shadowLine.dist;
  const roofEdgeLen = shadowEdgeLine.dist;
  const sunElevRad = sun.elevation * Math.PI / 180;

  if(sun.elevation < 10) {
    showToast('Sun too low for reliable pitch estimation — try when sun is higher', 'error');
    resetShadowMode();
    return;
  }

  // Estimated vertical rise from shadow
  const estHeight = shadowLen * Math.tan(sunElevRad);
  // Pitch ratio: rise per 12 inches of run
  const pitchRatio = (estHeight / roofEdgeLen) * 12;
  const pitchRounded = Math.round(pitchRatio);
  const clampedPitch = Math.max(1, Math.min(12, pitchRounded));

  // Map to pitch multiplier
  const pitchMultipliers = {1:1.003,2:1.014,3:1.031,4:1.054,5:1.083,6:1.118,7:1.158,8:1.202,9:1.25,10:1.302,11:1.357,12:1.414};
  const mult = pitchMultipliers[clampedPitch] || 1.202;

  // Apply to pitch selector
  const pitchSel = document.getElementById('pitchSel');
  if(pitchSel) {
    // Find closest option
    let best = null, bestDiff = 999;
    for(const opt of pitchSel.options) {
      const diff = Math.abs(parseFloat(opt.value) - mult);
      if(diff < bestDiff) { bestDiff = diff; best = opt; }
    }
    if(best) pitchSel.value = best.value;
  }

  recalc();
  const bar = document.getElementById('shadowBar');
  if(bar) {
    bar.innerHTML = `☀️ <b>Estimated Pitch: ${clampedPitch}/12</b> (multiplier: ${mult}×) — Sun elevation: ${sun.elevation.toFixed(1)}° | Shadow: ${shadowLine.dist.toFixed(1)}ft | Edge: ${shadowEdgeLine.dist.toFixed(1)}ft`;
  }
  showToast(`Pitch estimated: ${clampedPitch}/12 (${mult}× multiplier)`, 'ok');
  resetShadowMode();
  autoSaveDrawing();
}

function resetShadowMode() {
  shadowMode = false;
  shadowLine = null;
  shadowEdgeLine = null;
}


// ── FEATURE 4: HISTORICAL IMAGERY SLIDER ─────────────────────────
// Esri World Imagery Wayback. Each release is addressed by the NUMERIC id
// from Esri's waybackconfig.json — the previous `WB_2024_R06`-style strings
// were never valid ids and every tile request 404'd, so the slider had shown
// nothing since it shipped (measured 2026-09-04: numeric → 200 image/jpeg,
// string → 404). Ids are not chronological (2026-08-05 is 26334, 2014-06-25
// is 11033), so the date is carried alongside. Oldest → newest, one release
// per year around June (leaf-on, storm season) plus the two most recent, so
// "before the storm / after the storm" is one slider step. Refresh from
// https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
// when a newer release lands; tests/imagery-sources.test.js pins this table.
const ESRI_WAYBACK_VERSIONS = [
  {date:'2014-06-25', release:11033},
  {date:'2015-06-24', release:11952},
  {date:'2016-06-13', release:11509},
  {date:'2017-06-27', release:4073},
  {date:'2018-06-27', release:11334},
  {date:'2019-06-26', release:645},
  {date:'2020-06-10', release:11135},
  {date:'2021-06-30', release:13534},
  {date:'2022-06-29', release:4905},
  {date:'2023-06-29', release:47963},
  {date:'2024-06-27', release:39767},
  {date:'2025-06-26', release:48925},
  {date:'2026-04-30', release:49059},
  {date:'2026-08-05', release:26334},
];
const ESRI_WAYBACK_TILE = (release) =>
  `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${release}/{z}/{y}/{x}`;

function toggleHistoricalImagery() {
  if(historySliderActive) {
    closeHistoricalImagery();
    return;
  }
  historySliderActive = true;
  // Show the slider UI
  const panel = document.getElementById('historyPanel');
  if(panel) panel.style.display = 'block';
  // Default: the newest release (slider fully right); drag left to go back.
  setHistoricalLayer(ESRI_WAYBACK_VERSIONS.length - 1);
  showToast('Historical imagery loaded — drag the slider back in time', 'ok');
}

function setHistoricalLayer(idx) {
  const v = ESRI_WAYBACK_VERSIONS[idx];
  if(!v) return;
  if(historyLayerOld) drawMap.removeLayer(historyLayerOld);
  historyLayerOld = L.tileLayer(
    ESRI_WAYBACK_TILE(v.release),
    // Wayback serves to z=19 natively; let Leaflet upscale to the drawMap's
    // ceiling instead of leaving the layer blank when zoomed on a roof (z=22
    // since draw lane L3, 2026-09-25 — at 21 the history layer vanished at z22).
    { maxNativeZoom: 19, maxZoom: 22, opacity: 1, attribution: 'Imagery © Esri (Wayback)' }
  ).addTo(drawMap);
  // Put behind current drawings
  historyLayerOld.setZIndex(-1);

  const label = document.getElementById('historyDateLabel');
  if(label) label.textContent = v.date;
}

function updateHistoryOpacity(val) {
  if(historyLayerOld) historyLayerOld.setOpacity(parseFloat(val));
  const pctLabel = document.getElementById('historyOpacityLabel');
  if(pctLabel) pctLabel.textContent = Math.round(val * 100) + '%';
}

function closeHistoricalImagery() {
  historySliderActive = false;
  if(historyLayerOld) { drawMap.removeLayer(historyLayerOld); historyLayerOld = null; }
  const panel = document.getElementById('historyPanel');
  if(panel) panel.style.display = 'none';
}


// ── FEATURE 5: ROOF EDGE AUTO-DETECT ─────────────────────────────
function startAutoDetect() {
  autoDetectActive = true;
  showToast(_crosshair ? 'Put the crosshair on a roof corner, then Add — AI will try to trace the edges'
    : _tap('Click a corner of the roof — AI will try to trace the edges'), 'info');
  // In crosshair mode (L3) a real tap only aims, so this waits for the
  // crosshair's Add (the click tagged nbdReticle) instead of the first tap.
  const onPick = async (e) => {
    if (_crosshair && !e.nbdReticle) return;
    drawMap.off('click', onPick);
    autoDetectActive = false;
    await detectRoofEdges(e.latlng);
  };
  drawMap.on('click', onPick);
}

async function detectRoofEdges(startLatLng) {
  showToast('Analyzing satellite imagery...', 'info');
  try {
    const mapEl = document.getElementById('drawMap');
    const canvases = mapEl.querySelectorAll('canvas');
    if(!canvases.length) { showToast('No canvas found — switch to satellite layer', 'error'); return; }

    const canvas = canvases[0];
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const w = canvas.width, h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // Convert click to pixel position
    const startPx = drawMap.latLngToContainerPoint(startLatLng);
    const sx = Math.round(startPx.x * (w / mapEl.clientWidth));
    const sy = Math.round(startPx.y * (h / mapEl.clientHeight));

    // Sobel edge detection on grayscale
    const gray = new Float32Array(w * h);
    for(let i = 0; i < w*h; i++) {
      gray[i] = data[i*4]*0.299 + data[i*4+1]*0.587 + data[i*4+2]*0.114;
    }

    const edges = new Float32Array(w * h);
    for(let y = 1; y < h-1; y++) {
      for(let x = 1; x < w-1; x++) {
        const gx = -gray[(y-1)*w+x-1] + gray[(y-1)*w+x+1]
                   -2*gray[y*w+x-1] + 2*gray[y*w+x+1]
                   -gray[(y+1)*w+x-1] + gray[(y+1)*w+x+1];
        const gy = -gray[(y-1)*w+x-1] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+x+1]
                   +gray[(y+1)*w+x-1] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+x+1];
        edges[y*w+x] = Math.sqrt(gx*gx + gy*gy);
      }
    }

    // Find edge threshold (adaptive: use top 15% of edge magnitudes)
    const sorted = Array.from(edges).sort((a,b) => b-a);
    const threshold = sorted[Math.floor(sorted.length * 0.15)] || 50;

    // Trace edge from starting point using greedy walk
    const traced = [];
    const visited = new Set();
    let cx = sx, cy = sy;
    const maxSteps = 2000;
    const searchRadius = 6;

    // Find nearest strong edge from click point
    let bestDist = Infinity;
    for(let dy = -searchRadius; dy <= searchRadius; dy++) {
      for(let dx = -searchRadius; dx <= searchRadius; dx++) {
        const nx = cx+dx, ny = cy+dy;
        if(nx<0||ny<0||nx>=w||ny>=h) continue;
        if(edges[ny*w+nx] >= threshold) {
          const d = dx*dx+dy*dy;
          if(d < bestDist) { bestDist = d; cx = nx; cy = ny; }
        }
      }
    }

    // Walk along edge
    for(let step = 0; step < maxSteps; step++) {
      const key = cx+','+cy;
      if(visited.has(key)) {
        // Closed loop detected
        if(traced.length > 10) break;
        else { visited.clear(); } // reset if too early
      }
      visited.add(key);

      // Only add every Nth pixel as a vertex (reduces noise)
      if(step % 8 === 0) {
        const pt = drawMap.containerPointToLatLng(
          L.point(cx * (mapEl.clientWidth / w), cy * (mapEl.clientHeight / h))
        );
        traced.push(pt);
      }

      // Find strongest neighboring edge pixel (8-connected)
      let bestVal = -1, bx = cx, by = cy;
      for(let dy = -2; dy <= 2; dy++) {
        for(let dx = -2; dx <= 2; dx++) {
          if(dx===0 && dy===0) continue;
          const nx = cx+dx, ny = cy+dy;
          if(nx<0||ny<0||nx>=w||ny>=h) continue;
          const nk = nx+','+ny;
          if(visited.has(nk)) continue;
          if(edges[ny*w+nx] > bestVal) { bestVal = edges[ny*w+nx]; bx = nx; by = ny; }
        }
      }

      if(bestVal < threshold * 0.3) break; // Lost the edge
      cx = bx; cy = by;
    }

    if(traced.length < 4) {
      showToast('Could not detect clear edges — try a different corner or zoom level', 'error');
      return;
    }

    // Simplify the traced points (Douglas-Peucker)
    const simplified = douglasPeucker(traced, 0.00003);

    // Draw the detected outline as a preview
    const preview = L.polyline(simplified, {color:'#EAB308', weight:3, dashArray:'8,4', opacity:.8}).addTo(drawMap);
    simplified.forEach(p => makeDraggableDot(p, '#EAB308'));

    showToast(`Detected ${simplified.length} edge points — adjust dots to refine, or accept`, 'ok');

    // Store for acceptance
    window._autoDetectPreview = { line: preview, points: simplified };
    const bar = document.getElementById('autoDetectBar');
    if(bar) bar.style.display = 'flex';

  } catch(e) {
    showToast('Edge detection failed: ' + e.message, 'error');
  }
}

// Douglas-Peucker simplification for lat/lng
function douglasPeucker(points, epsilon) {
  if(points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length-1];
  for(let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if(d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if(maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx+1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function perpDist(p, a, b) {
  const dx = b.lng - a.lng, dy = b.lat - a.lat;
  const len2 = dx*dx + dy*dy;
  if(len2 === 0) return Math.sqrt((p.lng-a.lng)**2 + (p.lat-a.lat)**2);
  const t = Math.max(0, Math.min(1, ((p.lng-a.lng)*dx + (p.lat-a.lat)*dy) / len2));
  const projLng = a.lng + t*dx, projLat = a.lat + t*dy;
  return Math.sqrt((p.lng-projLng)**2 + (p.lat-projLat)**2);
}

function acceptAutoDetect() {
  const ad = window._autoDetectPreview;
  if(!ad) return;
  // Auto-close if enough points. 2026-09-25 (L2): builds the facet through
  // the same path a traced close uses (it used to hand-roll a second
  // polygon + label beside the saved facet's).
  const accepted = [];
  if(ad.points.length >= 3) {
    _pushUndo();
    resetPendingState();
    _resetPerimTrace();
    ad.points.forEach(p => { perimPoints.push(p); perimDots.push(_dotAt(p, '#4A9EFF')); accepted.push(p); });
    // Create segments between consecutive points
    for(let i = 0; i < ad.points.length; i++) {
      const p1 = ad.points[i];
      const p2 = ad.points[(i+1) % ad.points.length];
      addPerimSegment(p1, p2, 'eave'); // Default all to eave — user can toggle with E/R mode
    }
    const f = saveFacet();
    renderLineList(); renderFacetList(); recalc(); autoSaveDrawing();
    showToast(`Auto-detected facet: ${(f ? f.baseArea : 0).toFixed(0)} sf — switch to Eave/Rake mode to classify edges`, 'ok');
  }
  // ── ML FEEDBACK DATA PIPELINE (April 2026) ──
  // Save the auto-detected outline (before) and the user's
  // corrected version (after) as a training pair in Firestore.
  // When we eventually train an ML model for roof edge detection,
  // this labeled data is gold — real satellite images with
  // human-corrected polygon boundaries.
  if (window._db && window._user?.uid) {
    try {
      const trainingPair = {
        userId: window._user.uid,
        address: document.getElementById('drawSearch')?.value || '',
        timestamp: window.serverTimestamp(),
        autoDetected: ad.points.map(p => ({ lat: p.lat, lng: p.lng })),
        userCorrected: accepted.map(p => ({ lat: p.lat, lng: p.lng })),
        accepted: true, // user accepted (with possible corrections)
        mapCenter: drawMap.getCenter ? { lat: drawMap.getCenter().lat, lng: drawMap.getCenter().lng } : null,
        zoom: drawMap.getZoom ? drawMap.getZoom() : null
      };
      window.addDoc(window.collection(window._db, 'ml_training_data'), trainingPair);
    } catch (e) { console.warn('ML training pair save failed:', e.message); }
  }

  // Clean up preview
  if(ad.line) drawMap.removeLayer(ad.line);
  window._autoDetectPreview = null;
  const bar = document.getElementById('autoDetectBar');
  if(bar) bar.style.display = 'none';
}

function cancelAutoDetect() {
  const ad = window._autoDetectPreview;
  if(ad) {
    if(ad.line) drawMap.removeLayer(ad.line);
    window._autoDetectPreview = null;
  }
  const bar = document.getElementById('autoDetectBar');
  if(bar) bar.style.display = 'none';
  showToast('Auto-detect cancelled', 'info');
}


// ── FEATURE 6: VOICE-CONTROLLED MEASUREMENT ──────────────────────
function initVoiceControl() {
  if(!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    showToast('Voice control not supported in this browser', 'error');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  voiceRecognition = new SR();
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = false;
  voiceRecognition.lang = 'en-US';

  voiceRecognition.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    if(!last.isFinal) return;
    const cmd = last[0].transcript.trim().toLowerCase();
    processVoiceCommand(cmd);
  };

  voiceRecognition.onerror = (e) => {
    if(e.error !== 'no-speech') showToast('Voice error: ' + e.error, 'error');
  };

  voiceRecognition.onend = () => {
    // Auto-restart if voice is still active
    if(voiceActive) {
      try { voiceRecognition.start(); } catch(e) {}
    }
  };
}

function toggleVoiceControl() {
  if(!voiceRecognition) initVoiceControl();
  if(!voiceRecognition) return;

  voiceActive = !voiceActive;
  const btn = document.getElementById('voiceBtn');

  if(voiceActive) {
    voiceRecognition.start();
    if(btn) { btn.classList.add('voice-active'); btn.textContent = '🎙️ Listening...'; }
    showToast('Voice control ON — say commands like "ridge 48 feet" or "undo"', 'ok');
  } else {
    voiceRecognition.stop();
    if(btn) { btn.classList.remove('voice-active'); btn.textContent = '🎤 Voice'; }
    showToast('Voice control OFF', 'info');
  }
}

function processVoiceCommand(cmd) {
  const voiceLog = document.getElementById('voiceLog');
  if(voiceLog) voiceLog.textContent = `"${cmd}"`;

  // Normalize
  const c = cmd.replace(/[^\w\s]/g, '').trim();

  // Action commands
  if(c.includes('undo')) { undoLine(); showToast('↩ Undo (voice)', 'info'); return; }
  if(c.includes('clear')) { clearDraw(); return; }
  if(c.includes('draw') || c.includes('start')) { if(!drawOn) toggleDraw(); return; }
  if(c.includes('stop') || c.includes('done')) { if(drawOn) toggleDraw(); return; }
  if(c.includes('fit') || c.includes('zoom')) { zoomToFit(); return; }
  if(c.includes('close') && c.includes('perim')) { if(perimPoints.length >= 3) closePerimeter(); return; }
  if(c.includes('new facet') || c.includes('next facet')) { resetPerimState(); showToast('New facet started', 'ok'); return; }
  if(c.includes('screenshot') || c.includes('capture')) { screenshotMap(); return; }
  if(c.includes('materials') || c.includes('takeoff')) { showMaterialTakeoff(); return; }
  if(c.includes('report') || c.includes('export')) { exportDrawReport(); return; }
  if(c.includes('estimate')) { importToEstimate(); return; }
  if(c.includes('perimeter mode') || c.includes('perimeter')) { setDrawMode('perim', document.getElementById('modePerimBtn')); return; }
  if(c.includes('line mode') || c.includes('lines')) { setDrawMode('line', document.getElementById('modeLineBtn')); return; }
  if(c.includes('gutter mode') || c.includes('gutters')) { setDrawMode('gutter', document.getElementById('modeGutterBtn')); return; }

  // Measurement commands: "[type] [number] feet"
  const typeMap = {
    'ridge':0, 'ridge vent':1, 'hip':2, 'valley':3, 'rake':4,
    'eave':5, 'flashing':6, 'step flash':7, 'drip edge':8, 'parapet':9, 'gutter':10
  };

  // Try to match "[type] [number] feet/foot/ft"
  const numMatch = c.match(/(\d+\.?\d*)\s*(feet|foot|ft)/);
  if(numMatch) {
    const dist = parseFloat(numMatch[1]);
    let matchedType = null;
    for(const [name, typeIdx] of Object.entries(typeMap)) {
      if(c.includes(name)) { matchedType = typeIdx; break; }
    }
    if(matchedType !== null && dist > 0) {
      // Add a measurement line at the given length
      voiceAddMeasurement(matchedType, dist);
      return;
    }
  }

  // Line type selection
  for(const [name, typeIdx] of Object.entries(typeMap)) {
    if(c === name || c === name + 's') {
      drawLT = typeIdx;
      showToast(`Line type: ${LT[typeIdx].n} (voice)`, 'info');
      return;
    }
  }

  showToast(`Voice: "${cmd}" — not recognized`, 'info');
}

function voiceAddMeasurement(typeIdx, dist) {
  // If we have a starting point, extend from it at current bearing
  // Otherwise create a horizontal line from map center
  const lt = LT[typeIdx];
  let p1, p2;

  if(drawStart) {
    p1 = drawStart;
  } else if(drawnLines.length > 0) {
    p1 = drawnLines[drawnLines.length-1].p2;
  } else {
    p1 = drawMap.getCenter();
  }

  // Convert distance to lat offset (approximate: 1 ft ≈ 0.0000027° lat)
  const ftToLat = 1 / 364000;
  const ftToLng = ftToLat / Math.cos(p1.lat * Math.PI / 180);
  // Default: extend east
  p2 = L.latLng(p1.lat, p1.lng + dist * ftToLng);

  _pushUndo();
  _addLine({type:typeIdx, p1, p2, dist, dot1:_dotAt(p1, lt.color), dot2:_dotAt(p2, lt.color), subtype:null, runId: typeIdx === 10 ? _gutterRunFor(p1, p2) : null});
  // Chain from end (voice keeps its chaining; the next voice line starts here)
  drawStart = p2; drawStartDot = _findDot(p2); drawStartDotNew = false;
  renderLineList(); recalc(); recalcGutters(); autoSaveDrawing();
  showToast(`Added ${lt.n}: ${dist} ft (voice)`, 'ok');
}


// ── FEATURE 7: HOMEOWNER PRESENTATION MODE ───────────────────────
function startPresentation() {
  if(!drawnLines.length) { showToast('Draw some lines first', 'info'); return; }
  presentationActive = true;
  presentationStep = 0;

  // Hide sidebar, go fullscreen
  const sidebar = document.getElementById('map-sidebar-draw');
  if(sidebar) sidebar.style.display = 'none';
  const mapArea = document.querySelector('#view-draw .map-area');
  if(mapArea) mapArea.style.flex = '1';

  // Create presentation overlay
  const overlay = document.createElement('div');
  overlay.id = 'presentOverlay';
  overlay.innerHTML = `
    <div class="present-bar">
      <div class="present-title" id="presentTitle">Your Roof Measurement</div>
      <div class="present-controls">
        <button class="present-btn" data-mr-action="presentPrev">← Back</button>
        <span class="present-step" id="presentStepLabel">1 / 5</span>
        <button class="present-btn present-btn-next" data-mr-action="presentNext">Next →</button>
        <button class="present-btn present-btn-close" data-mr-action="endPresentation">✕</button>
      </div>
    </div>
    <div class="present-info" id="presentInfo"></div>
  `;
  document.getElementById('view-draw').appendChild(overlay);

  // Build presentation steps
  _presentSteps = buildPresentationSteps();
  showPresentationStep(0);
}

function buildPresentationSteps() {
  const addr = document.getElementById('drawSearch')?.value || 'Your Property';
  const steps = [];

  // Step 1: Overview
  steps.push({
    title: addr,
    info: 'Satellite aerial measurement of your property',
    action: () => { zoomToFit(); hideAllDrawnLayers(); }
  });

  // Step 2: Show perimeter/facets
  steps.push({
    title: 'Roof Outline',
    info: `${facets.length || 1} roof section${facets.length !== 1 ? 's' : ''} identified — ${(parseFloat(document.getElementById('cr-base')?.textContent)||0)} base square feet`,
    action: () => {
      zoomToFit();
      showOnlyLayers('perim');
    }
  });

  // Step 3: Show all measurements
  steps.push({
    title: 'Detailed Measurements',
    info: `${drawnLines.length} measurements taken — Ridge, Hip, Valley, Eave, Rake mapped`,
    action: () => {
      zoomToFit();
      showAllDrawnLayers();
    }
  });

  // Step 4: Calculations
  const t = generateMaterialTakeoff();
  steps.push({
    title: 'Roof Calculation',
    info: `${t.squares.toFixed(1)} squares | Smart waste: ${t.wasteInfo.label} (${t.wasteInfo.complexity}) | ${t.materials.length} material items needed`,
    action: () => { zoomToFit(); showAllDrawnLayers(); }
  });

  // Step 5: Call to action
  steps.push({
    title: 'Ready to Protect Your Home',
    info: 'All measurements verified by satellite. Tap below to review your estimate.',
    action: () => { zoomToFit(); showAllDrawnLayers(); }
  });

  return steps;
}

function showPresentationStep(idx) {
  const steps = _presentSteps;
  if(!steps || idx < 0 || idx >= steps.length) return;
  presentationStep = idx;
  const step = steps[idx];
  step.action();
  document.getElementById('presentTitle').textContent = step.title;
  document.getElementById('presentInfo').textContent = step.info;
  document.getElementById('presentStepLabel').textContent = `${idx+1} / ${steps.length}`;
}

function presentNext() {
  if(presentationStep < (_presentSteps?.length||1) - 1) {
    showPresentationStep(presentationStep + 1);
  } else {
    endPresentation();
    importToEstimate();
  }
}

function presentPrev() {
  if(presentationStep > 0) showPresentationStep(presentationStep - 1);
}

function endPresentation() {
  presentationActive = false;
  const overlay = document.getElementById('presentOverlay');
  if(overlay) overlay.remove();
  const sidebar = document.getElementById('map-sidebar-draw');
  if(sidebar) sidebar.style.display = '';
  showAllDrawnLayers();
}

function hideAllDrawnLayers() {
  drawnLines.forEach(l => {
    if(l.line) l.line.setStyle({opacity:0});
    if(l.lbl) l.lbl.setOpacity(0);
  });
}

function showAllDrawnLayers() {
  drawnLines.forEach(l => {
    if(l.line) l.line.setStyle({opacity:.95});
    if(l.lbl) l.lbl.setOpacity(1);
  });
}

function showOnlyLayers(type) {
  drawnLines.forEach(l => {
    const isPerim = l.type === 4 || l.type === 5;
    const show = (type === 'perim' && isPerim) || type === 'all';
    if(l.line) l.line.setStyle({opacity: show ? .95 : 0});
    if(l.lbl) l.lbl.setOpacity(show ? 1 : 0);
  });
}


// ── FEATURE 8: MULTI-STRUCTURE SUPPORT ───────────────────────────
// 2026-09-25 (draw lane L2, Jo's decision 3): real per-structure totals.
// Each line / facet / accessory carries its structureId and STAYS on the
// map; switching only chooses where new geometry goes, so it can never
// erase anything (it used to wipe the drawing unrecoverably, audit B6). The
// job total (the #cr-* readouts, the estimate) is the sum; each structure's
// own numbers show on its row. Rows are addressed by structure id.
function addStructure(name) {
  if (!_canSwitchStructure()) return;
  const id = _nextStructId++;
  const structName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : `Structure ${structures.length + 1}`;
  structures.push({ id, name: structName });
  _enterStructure(id);
  showToast(`Added: ${structName} — new drawing goes here`, 'ok');
}

// An outline half-traced on one structure cannot move to another.
function _canSwitchStructure() {
  if (perimPoints.length) {
    showToast(_crosshair ? 'Finish the outline first — Close it, or Undo'
      : _coarse ? 'Finish the outline first — tap its first corner to close it, or Undo'
      : 'Finish the outline first — click its first corner to close it, or Undo', 'info');
    return false;
  }
  return true;
}
function _enterStructure(id) {
  finishGutterRun({ quiet: true });
  resetPendingState();
  activeStructureId = id;
  renderStructureList(); renderFacetList(); recalc(); recalcGutters(); autoSaveDrawing();
}

function switchStructure(id) {
  const s = structures.find(x => x.id === id);
  if (!s || id === activeStructureId) return;
  if (!_canSwitchStructure()) return;
  _enterStructure(id);
  showToast(`Drawing on: ${s.name}`, 'info');
}

function renameStructure(id) {
  const s = structures.find(x => x.id === id);
  if(!s) return;
  const name = prompt('Rename structure:', s.name);
  if(name && name.trim()) {
    s.name = name.trim().slice(0, 60);
    renderStructureList(); renderFacetList(); recalc(); autoSaveDrawing();
  }
}

async function removeStructure(id) {
  const s = structures.find(x => x.id === id);
  if (!s || structures.length < 2) return;
  const nL = drawnLines.filter(l => l.structureId === id).length;
  const nF = facets.filter(f => f.structureId === id).length;
  const what = (nL || nF) ? ` and its ${nL} line${nL===1?'':'s'}${nF ? ', ' + nF + ' section' + (nF===1?'':'s') : ''}` : '';
  // Batch 2 (iOS PWA): see clearDraw above — real async modal in PWA.
  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _ask(`Remove "${s.name}"${what}?`))) return;
  resetPendingState();
  finishGutterRun({ quiet: true });
  _pushUndo(); // undoable, like Clear
  const snap = _serializeDrawing();
  snap.lines = snap.lines.filter(l => l.structureId !== id);
  snap.facets = snap.facets.filter(f => f.structureId !== id);
  snap.accessories = snap.accessories.filter(a => a.structureId !== id);
  snap.structures = snap.structures.filter(x => x.id !== id);
  if (snap.activeStructureId === id) snap.activeStructureId = snap.structures[0].id;
  if (perimPoints.length && activeStructureId === id) { snap.perimPoints = []; snap.perimSegIds = []; }
  _applyPayload(snap);
  autoSaveDrawing();
}

function renderStructureList() {
  const el = document.getElementById('structureList');
  if(!el) return;
  // 2026-09-25 (L2 review): in WebKit a finger tap on a row did not switch
  // structures. The rows are <div>s handled only by the document-level
  // [data-mr-action] delegate, and WebKit fires a tap's click only on a node
  // that it counts as clickable: one with a click listener on it or on an
  // ancestor ELEMENT. The document listener does not count, and neither did
  // the row's cursor:pointer. Measured in Playwright WebKit (iPhone 14 Pro,
  // installed-app rules): touchstart/pointerup/touchend and no click, until
  // a listener sat on this list. The delegate still does the work.
  if (el.dataset.tapListener !== '1') {
    el.dataset.tapListener = '1';
    el.addEventListener('click', function () { /* makes the rows tappable in WebKit; see above */ });
  }
  if(structures.length < 2) {
    el.innerHTML = '<p class="mrx-fs10px-cm-tacenter-3">Single structure. Add more for garage, shed, etc.</p>';
    return;
  }
  el.innerHTML = structures.map((s, i) => `
    <div class="structure-row ${s.id===activeStructureId?'structure-active':''}" data-mr-action="switchStructure" data-mr-id="${s.id}" data-structure-id="${s.id}">
      <span class="structure-icon">${i===0?'🏠':i===1?'🏗️':'🏚️'}</span>
      <span class="structure-name">${_esc(s.name)}<span class="structure-totals mrx-dblock-w400-ttnone"></span></span>
      <button class="structure-rename" data-mr-action="renameStructure" data-mr-id="${s.id}" data-mr-stop="1" title="Rename">✏️</button>
      ${i>0?`<button class="structure-del" data-mr-action="removeStructure" data-mr-id="${s.id}" data-mr-stop="1" title="Remove">✕</button>`:''}
    </div>
  `).join('');
  _renderStructureTotals(_totals());
}

// Each structure's own numbers on its row (textContent only).
function _renderStructureTotals(t) {
  const el = document.getElementById('structureList');
  if (!el || structures.length < 2) return;
  t.per.forEach(p => {
    const row = el.querySelector('[data-structure-id="' + p.id + '"] .structure-totals');
    if (!row) return;
    const bits = [p.text.base + ' · ' + p.text.sq];
    if (p.gutterLf > 0) bits.push(p.text.gutter + ' gutter');
    if (p.source === 'eave-rake' || p.source === 'lines') bits.push('area est.');
    row.textContent = bits.join(' · ');
  });
}

function recalcAllStructures() {
  const c = _totals().combined;
  return { totalBase: c.base, totalPitched: c.pitched };
}


// ── FEATURE 9: XACTIMATE ESX EXPORT ─────────────────────────────
// Xactimate line item mapping
const XACTIMATE_CODES = {
  0: {code:'RFG RDGV', desc:'Ridge vent - standard', unit:'LF', cat:'Roofing'},
  1: {code:'RFG RDGV', desc:'Ridge vent', unit:'LF', cat:'Roofing'},
  2: {code:'RFG HPRD', desc:'Hip & ridge cap', unit:'LF', cat:'Roofing'},
  3: {code:'RFG VALY', desc:'Valley flashing', unit:'LF', cat:'Roofing'},
  4: {code:'RFG RAKE', desc:'Rake edge detail', unit:'LF', cat:'Roofing'},
  5: {code:'RFG EAVE', desc:'Eave/starter strip', unit:'LF', cat:'Roofing'},
  6: {code:'RFG FLAS', desc:'Flashing - general', unit:'LF', cat:'Roofing'},
  7: {code:'RFG STPF', desc:'Step flashing', unit:'LF', cat:'Roofing'},
  8: {code:'RFG DRPE', desc:'Drip edge', unit:'LF', cat:'Roofing'},
  9: {code:'RFG PRPT', desc:'Parapet cap', unit:'LF', cat:'Roofing'},
  10:{code:'GTR ALUM', desc:'Gutter - aluminum', unit:'LF', cat:'Gutters'},
};

function exportXactimateESX() {
  if(!drawnLines.length) { showToast('No measurements to export', 'info'); return; }

  const addr = document.getElementById('drawSearch')?.value || 'Property';
  const date = new Date().toISOString().split('T')[0];
  const baseSF = parseFloat(document.getElementById('cr-base')?.textContent) || 0;
  const pitchedSF = parseFloat(document.getElementById('cr-pitched')?.textContent) || 0;

  // Group lines by type
  const grouped = {};
  drawnLines.forEach(l => {
    if(!grouped[l.type]) grouped[l.type] = {total:0, count:0, lines:[]};
    grouped[l.type].total += l.dist;
    grouped[l.type].count++;
    grouped[l.type].lines.push(l);
  });

  // Build ESX-compatible XML
  let items = '';
  let itemIdx = 1;

  // Add roof area as main line item
  items += `    <Item seq="${itemIdx++}">
      <Code>RFG LAMI</Code>
      <Description>Remove &amp; Replace - Roofing - Laminated - comp/asphalt shingle</Description>
      <Category>Roofing</Category>
      <Quantity>${(pitchedSF/100).toFixed(2)}</Quantity>
      <Unit>SQ</Unit>
      <Note>Base area: ${baseSF.toFixed(0)} SF, pitched area: ${pitchedSF.toFixed(0)} SF</Note>
    </Item>\n`;

  // Add felt/underlayment
  items += `    <Item seq="${itemIdx++}">
      <Code>RFG FELT</Code>
      <Description>Felt paper - 15 lb.</Description>
      <Category>Roofing</Category>
      <Quantity>${(pitchedSF/100).toFixed(2)}</Quantity>
      <Unit>SQ</Unit>
      <Note>Full roof coverage</Note>
    </Item>\n`;

  // Add each line type
  Object.entries(grouped).forEach(([typeStr, data]) => {
    const typeIdx = parseInt(typeStr);
    const xact = XACTIMATE_CODES[typeIdx];
    if(!xact) return;
    items += `    <Item seq="${itemIdx++}">
      <Code>${xact.code}</Code>
      <Description>${xact.desc}</Description>
      <Category>${xact.cat}</Category>
      <Quantity>${data.total.toFixed(1)}</Quantity>
      <Unit>${xact.unit}</Unit>
      <Note>${data.count} segment(s), total ${data.total.toFixed(1)} LF</Note>
    </Item>\n`;
  });

  // Ice & water shield for eaves
  const eaveLF = grouped[5]?.total || 0;
  if(eaveLF > 0) {
    items += `    <Item seq="${itemIdx++}">
      <Code>RFG ICSHL</Code>
      <Description>Ice &amp; water shield membrane</Description>
      <Category>Roofing</Category>
      <Quantity>${eaveLF.toFixed(1)}</Quantity>
      <Unit>LF</Unit>
      <Note>Along eave line, 3ft width</Note>
    </Item>\n`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<XactimateClaim>
  <ClaimInfo>
    <Address>${addr.replace(/&/g,'&amp;')}</Address>
    <DateOfLoss>${date}</DateOfLoss>
    <CreatedBy>NBD Pro Drawing Tool</CreatedBy>
    <CreatedDate>${date}</CreatedDate>
  </ClaimInfo>
  <Structure name="Main">
    <Room name="Roof">
      <Dimensions>
        <Area unit="SF">${pitchedSF.toFixed(0)}</Area>
        <Perimeter unit="LF">${(eaveLF + (grouped[4]?.total||0)).toFixed(0)}</Perimeter>
      </Dimensions>
      <Items>
${items}      </Items>
    </Room>
  </Structure>
</XactimateClaim>`;

  // Download as file
  const blob = new Blob([xml], {type:'application/xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `NBD-Xactimate-${addr.replace(/[^a-zA-Z0-9]/g,'-').substring(0,40)}-${date}.esx`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Xactimate ESX file downloaded — import into Xactimate', 'ok');
}


// ── FEATURE 10: MEASUREMENT COMPARISON MODE ──────────────────────
function openComparisonMode() {
  const modal = document.getElementById('comparisonModal');
  if(modal) modal.style.display = 'flex';
}

function closeComparisonMode() {
  const modal = document.getElementById('comparisonModal');
  if(modal) modal.style.display = 'none';
}

function handleComparisonFile(file) {
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      parseComparisonReport(e.target.result, file.name);
    } catch(err) {
      showToast('Could not parse report: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

async function parseComparisonReport(text, filename) {
  // Try to extract common measurement values from report text
  const data = { source: filename, measurements: {} };

  // Common patterns in roofing reports
  const patterns = [
    {key:'totalArea', regex:/total\s*(?:roof\s*)?area[:\s]*([0-9,.]+)\s*(?:sq\.?\s*ft|sf)/i},
    {key:'ridgeLF',  regex:/ridge[:\s]*([0-9,.]+)\s*(?:lf|ft|lin)/i},
    {key:'hipLF',    regex:/hip[:\s]*([0-9,.]+)\s*(?:lf|ft|lin)/i},
    {key:'valleyLF', regex:/valley[:\s]*([0-9,.]+)\s*(?:lf|ft|lin)/i},
    {key:'eaveLF',   regex:/eave[:\s]*([0-9,.]+)\s*(?:lf|ft|lin)/i},
    {key:'rakeLF',   regex:/rake[:\s]*([0-9,.]+)\s*(?:lf|ft|lin)/i},
    {key:'perimLF',  regex:/perimeter[:\s]*([0-9,.]+)\s*(?:lf|ft|lin)/i},
    {key:'pitch',    regex:/(?:predominant\s*)?pitch[:\s]*(\d+)\s*\/\s*12/i},
    {key:'squares',  regex:/(\d+\.?\d*)\s*squares/i},
    {key:'facets',   regex:/(\d+)\s*(?:facets|sections|planes)/i},
  ];

  patterns.forEach(p => {
    const m = text.match(p.regex);
    if(m) data.measurements[p.key] = parseFloat(m[1].replace(',',''));
  });

  if(Object.keys(data.measurements).length === 0) {
    showToast('No measurements found in report — try a different file format', 'error');
    return;
  }

  comparisonData = data;

  // If regex found <3 fields, try Claude AI extraction
  if (Object.keys(data.measurements).length < 3 && typeof window.callClaude === 'function') {
    showToast('Regex found limited data — trying AI extraction...', 'info');
    try {
      const result = await window.callClaude({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: 'Extract roofing measurements from this report text. Return ONLY a JSON object with these fields (numbers only, no units): totalArea, ridgeLF, hipLF, valleyLF, eaveLF, rakeLF, perimLF, pitch, squares, facets. If a field is not found, omit it.',
        messages: [{ role: 'user', content: text.substring(0, 4000) }]
      });
      const aiText = result?.content?.[0]?.text || '';
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const aiData = JSON.parse(jsonMatch[0]);
        // Merge AI results with regex results (AI fills gaps)
        Object.keys(aiData).forEach(k => {
          if (typeof aiData[k] === 'number' && !data.measurements[k]) {
            data.measurements[k] = aiData[k];
          }
        });
        showToast('AI extracted additional measurements', 'success');
      }
    } catch (e) {
      console.warn('AI extraction failed:', e.message);
    }
  }

  comparisonData = data;
  renderComparison();
}

function renderComparison() {
  if(!comparisonData) return;
  const ext = comparisonData.measurements;
  const el = document.getElementById('comparisonResults');
  if(!el) return;

  // Our measurements. 2026-09-25 (L2): "Total Area" is the PITCHED roof
  // area — a report's total roof area is surface area; comparing it with
  // our flat footprint (cr-base) under-stated ours by the pitch factor.
  // Ridge is Ridge lines only (Jo, decision 6: ridge vent is separate).
  const ourArea = parseFloat(document.getElementById('cr-pitched')?.textContent) || 0;
  const ourRidge = drawnLines.filter(l=>l.type===0).reduce((s,l)=>s+l.dist,0);
  const ourHip = drawnLines.filter(l=>l.type===2).reduce((s,l)=>s+l.dist,0);
  const ourValley = drawnLines.filter(l=>l.type===3).reduce((s,l)=>s+l.dist,0);
  const ourEave = drawnLines.filter(l=>l.type===5).reduce((s,l)=>s+l.dist,0);
  const ourRake = drawnLines.filter(l=>l.type===4).reduce((s,l)=>s+l.dist,0);
  const ourPerim = ourEave + ourRake;
  const ourSq = parseFloat(document.getElementById('cr-sq')?.textContent) || 0;

  const comparisons = [
    {label:'Total Area (sf)', ours:ourArea, theirs:ext.totalArea},
    {label:'Ridge (LF)', ours:ourRidge, theirs:ext.ridgeLF},
    {label:'Hip (LF)', ours:ourHip, theirs:ext.hipLF},
    {label:'Valley (LF)', ours:ourValley, theirs:ext.valleyLF},
    {label:'Eave (LF)', ours:ourEave, theirs:ext.eaveLF},
    {label:'Rake (LF)', ours:ourRake, theirs:ext.rakeLF},
    {label:'Perimeter (LF)', ours:ourPerim, theirs:ext.perimLF},
    {label:'Squares', ours:ourSq, theirs:ext.squares},
  ];

  el.innerHTML = `<div class="mrx-fs9px-w700-ls15em">Comparison: ${comparisonData.source}</div>` +
    comparisons.filter(c => c.theirs !== undefined).map(c => {
      const diff = c.ours > 0 && c.theirs > 0 ? ((c.ours - c.theirs) / c.theirs * 100) : null;
      const diffClass = diff !== null ? (Math.abs(diff) <= 5 ? 'comp-match' : Math.abs(diff) <= 15 ? 'comp-warn' : 'comp-off') : 'comp-na';
      const diffLabel = diff !== null ? (diff > 0 ? `+${diff.toFixed(1)}%` : `${diff.toFixed(1)}%`) : '—';
      return `<div class="comp-row ${diffClass}">
        <span class="comp-label">${c.label}</span>
        <span class="comp-ours">${typeof c.ours === 'number' ? c.ours.toFixed(1) : '—'}</span>
        <span class="comp-theirs">${typeof c.theirs === 'number' ? c.theirs.toFixed(1) : '—'}</span>
        <span class="comp-diff">${diffLabel}</span>
      </div>`;
    }).join('');

  // Match score
  const scored = comparisons.filter(c => c.theirs !== undefined && c.ours > 0);
  const matchPcts = scored.map(c => 100 - Math.min(100, Math.abs((c.ours - c.theirs) / c.theirs * 100)));
  const avgMatch = matchPcts.length > 0 ? Math.round(matchPcts.reduce((a, b) => a + b, 0) / matchPcts.length) : 0;

  el.innerHTML += `<div class="mrx-mt12px-p12px-bgs2">
    <div class="mrx-fs10px-cm-ttuppercas">Match Score</div>
    <div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;font-weight:800;color:${avgMatch >= 90 ? 'var(--green)' : avgMatch >= 70 ? 'var(--gold)' : 'var(--red)'};">${avgMatch}%</div>
  </div>`;

  // Supplement letter button (only show if differences > 5%)
  const bigDiffs = comparisons.filter(c => c.theirs !== undefined && c.ours > 0 && Math.abs((c.ours - c.theirs) / c.theirs * 100) > 5);
  if (bigDiffs.length > 0) {
    el.innerHTML += `<button class="btn btn-orange mrx-wd100-mt10px-jccenter" data-mr-action="generateSupplementFromComparison">📝 Generate Supplement Letter</button>`;
  }

  // Manual entry link
  el.innerHTML += `<button class="btn btn-ghost mrx-wd100-mt6px-jccenter" data-mr-action="openManualComparisonEntry">✏️ Enter Report Values Manually</button>`;

  el.style.display = 'block';
  closeComparisonMode();
  showToast('Comparison loaded — match score: ' + avgMatch + '%', avgMatch >= 80 ? 'success' : 'warning');
}

// ── Manual comparison entry ──
function openManualComparisonEntry() {
  const fields = ['totalArea','ridgeLF','hipLF','valleyLF','eaveLF','rakeLF','squares'];
  const labels = ['Total Area (SF)','Ridge (LF)','Hip (LF)','Valley (LF)','Eave (LF)','Rake (LF)','Squares'];
  const current = comparisonData?.measurements || {};
  const html = fields.map((f, i) =>
    '<div class="mrx-dflex-gap8px-aicenter">'
    + '<label class="mrx-fs11px-cm-wd120px">' + labels[i] + '</label>'
    + '<input type="number" id="mc_' + f + '" value="' + (current[f] || '') + '" placeholder="0" class="mrx-fx1-bgs2-bd1pxsolid">'
    + '</div>'
  ).join('');
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = '<div class="mrx-bgs-bd1pxsolid-r12px">'
    + '<div class="mrx-ffbarlowco-fs18px-w800">Enter Report Measurements</div>'
    + html
    + '<div class="mrx-dflex-gap8px-mt14px">'
    + '<button class="btn btn-ghost mrx-fx1-jccenter" data-mr-action="closeManualOverlay">Cancel</button>'
    + '<button class="btn btn-orange mrx-fx1-jccenter" data-mr-action="applyManualComparisonAndClose">Compare</button>'
    + '</div></div>';
  document.body.appendChild(modal);
}

function applyManualComparison() {
  const fields = ['totalArea','ridgeLF','hipLF','valleyLF','eaveLF','rakeLF','squares'];
  const data = { source: 'Manual Entry', measurements: {} };
  fields.forEach(f => {
    const val = parseFloat(document.getElementById('mc_' + f)?.value);
    if (val > 0) data.measurements[f] = val;
  });
  if (Object.keys(data.measurements).length === 0) {
    showToast('Enter at least one measurement', 'error');
    return;
  }
  comparisonData = data;
  renderComparison();
}

// ── Auto-generate supplement letter from comparison differences ──
// async since 2026-09-06: the filename carries a tenant-resolved prefix and
// company-profile hydration must be awaited (company-profile.js _tenantFilePrefix).
// Every caller discards the return value (data-action buttons, the voice-command
// dispatch, and the maps API export), so awaiting here is safe.
async function generateSupplementFromComparison() {
  if (!comparisonData) { showToast('Run a comparison first', 'error'); return; }
  const ext = comparisonData.measurements;
  const addr = document.getElementById('drawSearch')?.value || 'Property Address';
  // Pitched area, and ridge lines only — same reasons as renderComparison().
  const ourArea = parseFloat(document.getElementById('cr-pitched')?.textContent) || 0;
  const ourRidge = drawnLines.filter(l => l.type === 0).reduce((s, l) => s + l.dist, 0);
  const ourHip = drawnLines.filter(l => l.type === 2).reduce((s, l) => s + l.dist, 0);
  const ourValley = drawnLines.filter(l => l.type === 3).reduce((s, l) => s + l.dist, 0);
  const ourEave = drawnLines.filter(l => l.type === 5).reduce((s, l) => s + l.dist, 0);
  const ourRake = drawnLines.filter(l => l.type === 4).reduce((s, l) => s + l.dist, 0);

  const diffs = [
    { label: 'Total Roof Area', ours: ourArea, theirs: ext.totalArea, unit: 'SF' },
    { label: 'Ridge Length', ours: ourRidge, theirs: ext.ridgeLF, unit: 'LF' },
    { label: 'Hip Length', ours: ourHip, theirs: ext.hipLF, unit: 'LF' },
    { label: 'Valley Length', ours: ourValley, theirs: ext.valleyLF, unit: 'LF' },
    { label: 'Eave Length', ours: ourEave, theirs: ext.eaveLF, unit: 'LF' },
    { label: 'Rake Length', ours: ourRake, theirs: ext.rakeLF, unit: 'LF' }
  ].filter(d => d.theirs && d.ours > 0 && Math.abs(d.ours - d.theirs) > 1);

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const diffRows = diffs.map(d => {
    const diff = d.ours - d.theirs;
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${d.label}</td>`
      + `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${d.theirs.toFixed(1)} ${d.unit}</td>`
      + `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${d.ours.toFixed(1)} ${d.unit}</td>`
      + `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${diff > 0 ? '#c53030' : '#22c55e'};font-weight:700;">${diff > 0 ? '+' : ''}${diff.toFixed(1)} ${d.unit}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Supplement Request — ${addr}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Barlow',sans-serif;padding:36px;max-width:860px;margin:0 auto;}
.hdr{display:flex;justify-content:space-between;padding-bottom:18px;border-bottom:3px solid #BD5728;margin-bottom:24px;}
.brand{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;text-transform:uppercase;}.brand span{color:var(--orange,#BD5728);}
.badge{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--orange,#BD5728);border:1px solid #BD5728;padding:2px 9px;border-radius:2px;display:inline-block;margin-top:5px;}
h2{font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--orange,#BD5728);margin:20px 0 10px;border-bottom:1px solid #eee;padding-bottom:4px;}
table{width:100%;border-collapse:collapse;}th{background:#0a0c0f;color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:8px 10px;text-align:left;}
td{font-size:12px;}.note{background:#fff8f0;border-left:4px solid #BD5728;padding:14px;margin:16px 0;font-size:13px;line-height:1.6;}
.sig{margin-top:40px;border-top:1px solid #eee;padding-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:40px;}
.sig-line{border-top:1px solid #333;padding-top:6px;font-size:11px;color:#666;margin-top:50px;}
.foot{margin-top:30px;font-size:10px;color:#999;display:flex;justify-content:space-between;}
@media print{body{padding:20px;}@page{margin:1.5cm;size:letter;}}</style></head><body>
<div class="hdr"><div><div class="brand">No Big Deal <span>Home Solutions</span></div><div class="badge">Supplement Request</div></div>
<div style="text-align:right;"><div style="font-size:14px;font-weight:600;">${addr}</div><div style="font-size:11px;color:#666;">${date}</div></div></div>
<p style="font-size:13px;line-height:1.6;margin-bottom:16px;">To Whom It May Concern,</p>
<p style="font-size:13px;line-height:1.6;margin-bottom:16px;">After conducting our own detailed field measurements at the above property, we have identified discrepancies between our measurements and the carrier's approved scope. We respectfully request a supplemental review based on the following documented differences:</p>
<h2>Measurement Comparison</h2>
<table><thead><tr><th>Measurement</th><th style="text-align:right;">Report Value</th><th style="text-align:right;">Our Measurement</th><th style="text-align:right;">Difference</th></tr></thead><tbody>${diffRows}</tbody></table>
<div class="note"><strong>Note:</strong> Our measurements were taken using satellite imagery analysis with the NBD Pro Drawing Tool and verified against on-site inspection. All measurements are in linear feet (LF) or square feet (SF) as indicated.</div>
<p style="font-size:13px;line-height:1.6;margin-top:16px;">We kindly request that the scope be adjusted to reflect the accurate measurements documented above. We are available to meet with the adjuster on-site to verify these measurements if needed.</p>
<div class="sig"><div><div class="sig-line">Contractor Signature</div></div><div><div class="sig-line">Date</div></div></div>
<div class="foot"><span>No Big Deal Home Solutions · (859) 420-7382 · nobigdealwithjoedeal.com</span><span>Generated by NBD Pro</span></div>
</body></html>`;

  if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
    // Tenant-resolved prefix — the Supplement Request goes to the ADJUSTER.
    const _suppBase = 'Supplement-' + date.replace(/\s/g, '') + '.pdf';
    const _suppName = window._tenantFileName ? await window._tenantFileName(_suppBase) : _suppBase;
    window.NBDDocViewer.open({ html, title: 'Supplement Request — ' + addr, filename: _suppName });
  } else {
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  }
}


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  END WOW FEATURES                                                ║
// ╚═══════════════════════════════════════════════════════════════════╝

// ── CSP-SAFE EVENT DELEGATION (data-mr-action) ──────────────────
// Prod CSP `script-src-attr 'none'` kills inline onclicks injected via
// innerHTML (line-popup buttons, accessory toggles, structure rows,
// present-mode nav, supplement-comparison overlay). The line-list got
// its own delegate in PR #453; this catches everything else.
(function () {
  if (_NBD_MR_DELEGATE_BOUND) return;
  _NBD_MR_DELEGATE_BOUND = true;

  function closeDrawMapPopup() {
    if (typeof drawMap !== 'undefined' && drawMap && typeof drawMap.closePopup === 'function') {
      drawMap.closePopup();
    }
  }

  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-mr-action]');
    if (!t) return;
    if (t.dataset.mrStop === '1') ev.stopPropagation();
    const action = t.dataset.mrAction;
    const id = t.dataset.mrId;
    const arg2 = t.dataset.mrArg2;
    try {
      switch (action) {
        // Number(), never parseInt (audit B3): line ids were decimals, and
        // parseInt cut them to a whole number that matched no line.
        case 'retypeLine':       if (typeof retypeLine === 'function') retypeLine(Number(id), Number(arg2)); closeDrawMapPopup(); break;
        case 'deleteLine':       if (typeof deleteLine === 'function') deleteLine(Number(id)); closeDrawMapPopup(); break;
        case 'editLineLength':   if (typeof editLineLength === 'function') editLineLength(Number(id)); closeDrawMapPopup(); break;
        case 'toggleAccessoryMode': if (typeof toggleAccessoryMode === 'function') toggleAccessoryMode(id); break;
        case 'presentPrev':      if (typeof presentPrev === 'function') presentPrev(); break;
        case 'presentNext':      if (typeof presentNext === 'function') presentNext(); break;
        case 'endPresentation':  if (typeof endPresentation === 'function') endPresentation(); break;
        case 'switchStructure':  if (typeof switchStructure === 'function') switchStructure(parseInt(id, 10)); break;
        case 'renameStructure':  if (typeof renameStructure === 'function') renameStructure(parseInt(id, 10)); break;
        case 'removeStructure':  if (typeof removeStructure === 'function') removeStructure(parseInt(id, 10)); break;
        case 'generateSupplementFromComparison': if (typeof generateSupplementFromComparison === 'function') generateSupplementFromComparison(); break;
        case 'openManualComparisonEntry': if (typeof openManualComparisonEntry === 'function') openManualComparisonEntry(); break;
        case 'closeManualOverlay': {
          const overlay = t.closest('div[style*=fixed]');
          if (overlay) overlay.remove();
          break;
        }
        case 'applyManualComparisonAndClose': {
          if (typeof applyManualComparison === 'function') applyManualComparison();
          const overlay = t.closest('div[style*=fixed]');
          if (overlay) overlay.remove();
          break;
        }
        default:
          console.warn('[maps-routing] no dispatch for', action);
      }
    } catch (e) {
      console.error('[maps-routing] dispatch ' + action + ' failed:', e);
    }
  });
})();

// ── Deliberate window surface (Globals Tranche 2c-2) ──
// The module IIFE took this file's top-level declarations off the global
// scope. The names below must STAY reachable on window — each has a live
// cross-file consumer that resolves it there (or as a bare global):
//   • initDrawMap — dashboard-actions.js waitForMapFn polls
//     window['initDrawMap'] then calls it when the draw view opens;
//     dashboard-sw-bootstrap.js reports typeof in its diagnostics
//   • selLT — dashboard-ui.js's selLineType action branch calls the bare
//     name (typeof-guarded)
//   • renderAccessoryPanel — dashboard-accessory-panel-init.js calls the
//     bare name on a timer
//   • setDrawMode — allowlisted data-fn dispatch + a bare typeof-guarded
//     call in dashboard-actions.js (draw-view init selects line mode)
//   • clearDraw / undoLine / exportDrawReport / importToEstimate /
//     perimChooseType / searchDraw — allowlisted data-fn dispatch via
//     window[fn]; their allowlist entries belong to the
//     dashboard-actions.js cluster (searchDraw is also window-guard
//     called from widgets.js and wired to data-enter-action)
//   • toggleDraw / toggleMapLayer / toggleHistoricalImagery /
//     toggleVoiceControl / closeComparisonMode / closeHistoricalImagery —
//     CONVERTED (Tranche 3 dispatch-map slice, 2026-09-02): registered in
//     this file's __NBD_CALL_REGISTRY block, window exports deleted. Both
//     maps resolve the registry first (dashboard-ui.js _nbdResolveMapped,
//     since T3-M) and an adversarially-verified reach proof confirmed the
//     map is each name's only consumer. The smoke graduate pins lock
//     registration + off-window + the surviving map entries — the 2026-09-01
//     note here claiming the six were "no longer pinned" was ahead of the
//     tree (the export pins lived until this slice; trust the test).
//   • goToMyLocation — FAILED the tranche's three-way proof: the maps.js
//     shim re-states it on window (real cross-file code reference), so
//     it also keeps its _NBD_CALL_ALLOWLIST entry. Tranche 3 candidate.
window.initDrawMap = initDrawMap;
window.selLT = selLT;
window.renderAccessoryPanel = renderAccessoryPanel;
window.setDrawMode = setDrawMode;
window.clearDraw = clearDraw;
window.undoLine = undoLine;
window.exportDrawReport = exportDrawReport;
window.importToEstimate = importToEstimate;
window.perimChooseType = perimChooseType;
window.searchDraw = searchDraw;
window.goToMyLocation = goToMyLocation;

// ── Delegate registration (Globals Tranche 2c-2) ──
// These 21 handlers are dispatched ONLY from markup — data-fn /
// data-on-change / data-on-input in dashboard.html — through the
// dashboard-ui.js dispatchers, which resolve __NBD_CALL_REGISTRY FIRST
// (_nbdResolveCall). Registration here replaces each name's
// _NBD_CALL_ALLOWLIST entry as the security opt-in; the functions
// themselves stay module-scoped. tests/smoke/dashboard.test.js pins
// registration, allowlist removal and off-window status per name.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  acceptAutoDetect: acceptAutoDetect,
  addStructure: addStructure,
  applySmartWaste: applySmartWaste,
  cancelAutoDetect: cancelAutoDetect,
  exportXactimateESX: exportXactimateESX,
  generateScopeFromDrawing: generateScopeFromDrawing,
  handleComparisonFile: handleComparisonFile,
  loadDrawingFromCustomer: loadDrawingFromCustomer,
  openComparisonMode: openComparisonMode,
  recalc: recalc,
  runSolarAnalysis: runSolarAnalysis,
  saveDrawingToCustomer: saveDrawingToCustomer,
  screenshotMap: screenshotMap,
  setHistoricalLayer: setHistoricalLayer,
  showAngles: showAngles,
  showMaterialTakeoff: showMaterialTakeoff,
  startAutoDetect: startAutoDetect,
  startPresentation: startPresentation,
  startShadowPitch: startShadowPitch,
  updateHistoryOpacity: updateHistoryOpacity,
  zoomToFit: zoomToFit,
  // Tranche 3 dispatch-map slice (2026-09-02): the six names whose ONLY
  // reach is _NBD_TOGGLE_FNS / _NBD_MODAL_CLOSE_FNS (registry-first since
  // T3-M) — the conversion the comment above the export block queued.
  // Same IIFE as the definitions, so the bare identifiers bind lexically;
  // their map entries in dashboard-state.js are now the only dispatch
  // path, locked by the graduate pins in tests/smoke/dashboard.test.js.
  toggleDraw: toggleDraw,
  toggleMapLayer: toggleMapLayer,
  toggleHistoricalImagery: toggleHistoricalImagery,
  toggleVoiceControl: toggleVoiceControl,
  closeComparisonMode: closeComparisonMode,
  closeHistoricalImagery: closeHistoricalImagery,
  // Draw lane L2 (2026-09-25): the Finish-run and Redo buttons and the
  // slope switch in tpl-view-draw. Registered, never put on window.
  finishGutterRun: finishGutterRun,
  redoLine: redoLine,
  setSlopeLf: setSlopeLf
});
})();
