/**
 * maps-customers.js — "Customers" map layer: plot EVERY customer/lead
 * from the CRM book on the main map, with a control panel to COLOR BY and
 * FILTER on multiple dimensions, and zoom-gated deal-value labels.
 *
 * Sibling module of maps-core.js / maps-overlays.js / maps-routing.js
 * (Step 4d split). Load order in dashboard.html:
 *
 *   core → overlays → customers → routing → maps (shim)
 *
 * Why a dedicated layer (vs the Jobs overlay / D2D pins):
 *   - Jobs overlay only shows job-stage leads, geocoded live and capped.
 *   - D2D `_pins` are door-knock activity; most customers have no pin.
 *   - This layer is driven by `window._leads` (company-scoped for the team) so
 *     it shows the WHOLE book.
 *
 * Control panel (floating, bottom-left):
 *   - COLOR BY — Stage/Role · Damage Type · Deal Value. Recolours the dots and
 *     regenerates the legend for the chosen dimension.
 *   - LEGEND / FILTER — click a category chip to show/hide it. Filters compose
 *     ACROSS dimensions (AND): e.g. color by Stage, but filter Damage=Hail and
 *     Value=$25k+ at the same time via the "＋ Filters" section.
 *   - ZOOM-GATED LABELS — past z≥16 a lead's dot blooms into a 💰 $value pill;
 *     zoomed out it's a clean coloured dot. Clusters at low zoom.
 *
 * Coordinates: new leads persist lat/lng at save; older / edited-address leads
 * are lazily geocoded here (fair-use capped) and persisted via
 * window._saveLeadCoords — a rolling backfill.
 *
 * Depends on sibling-scope globals: mainMap, overlayState, L, geocode,
 * _mapsEscHtml / _mapsEscJsInAttr. Consumes window.*: _leads, stageRole,
 * STAGE_META, normalizeStage, _saveLeadCoords. Classic-script — no import/export.
 */

let customersLayer = null;
let _custPanelEl = null;                  // floating control panel DOM
const _custGeocodeCache = new Map();      // address(lower) → {lat,lng} | null
const _CUST_GEOCODE_CAP = 12;             // max live geocodes per build (fair-use)
const _CUST_LABEL_ZOOM = 16;              // ≥ this zoom → show $ value labels
let _custZoomWired = false;
let _custFiltersOpen = false;             // "＋ Filters" panel expanded?

// ── DIMENSIONS ──────────────────────────────────────────────────────────
// Each dimension: catOf(lead) → category key; cats = ordered [{key,label,color}].
// The role palette mirrors the kanban.
const _CUST_ROLE_COLORS = { new: '#9CA3AF', active: '#4A9EFF', job: '#0D9488', won: '#22C55E', lost: '#E05252' };
const _CUST_ROLE_LABELS = { new: 'New', active: 'Active', job: 'In Production', won: 'Won', lost: 'Lost' };
const _CUST_ROLE_ORDER  = ['new', 'active', 'job', 'won', 'lost'];

function _custRoleOf(lead) {
  const key = lead._stageKey
    || (typeof window.normalizeStage === 'function' ? window.normalizeStage(lead.stage) : (lead.stage || 'new'));
  if (typeof window.stageRole === 'function') { try { return window.stageRole(key); } catch (_) {} }
  return lead._stageRole || 'active';
}

function _custValueOf(lead) {
  return parseFloat(lead.jobValue || lead.value || lead.contractValue || 0) || 0;
}

// Damage families — normalise the free-ish damageType text to a peril bucket.
const _CUST_DAMAGE_CATS = [
  { key: 'hailwind', label: 'Hail & Wind', color: '#7c3aed' },
  { key: 'hail',     label: 'Hail',        color: '#4A9EFF' },
  { key: 'wind',     label: 'Wind',        color: '#0891b2' },
  { key: 'fire',     label: 'Fire',        color: '#ea580c' },
  { key: 'water',    label: 'Water',       color: '#0ea5e9' },
  { key: 'gutters',  label: 'Gutters',     color: '#a16207' },
  { key: 'full',     label: 'Full Exterior', color: '#16a34a' },
  { key: 'other',    label: 'Other',       color: '#9B6DFF' },
  { key: 'unset',    label: 'Unset',       color: '#6B7280' },
];
function _custDamageKey(lead) {
  const d = String(lead.damageType || '').toLowerCase().trim();
  if (!d) return 'unset';
  const hasHail = d.indexOf('hail') !== -1, hasWind = d.indexOf('wind') !== -1;
  if (hasHail && hasWind) return 'hailwind';
  if (hasHail) return 'hail';
  if (hasWind) return 'wind';
  if (d.indexOf('fire') !== -1) return 'fire';
  if (d.indexOf('water') !== -1) return 'water';
  if (d.indexOf('gutter') !== -1) return 'gutters';
  if (d.indexOf('full') !== -1) return 'full';
  return 'other';
}

// Deal-value tiers.
const _CUST_VALUE_CATS = [
  { key: 'v4', label: '$50k+',     color: '#16a34a', test: v => v >= 50000 },
  { key: 'v3', label: '$25–50k',   color: '#22C55E', test: v => v >= 25000 && v < 50000 },
  { key: 'v2', label: '$10–25k',   color: '#D4A017', test: v => v >= 10000 && v < 25000 },
  { key: 'v1', label: '< $10k',    color: '#4A9EFF', test: v => v > 0 && v < 10000 },
  { key: 'v0', label: 'No value',  color: '#6B7280', test: v => !(v > 0) },
];
function _custValueKey(lead) {
  const v = _custValueOf(lead);
  const t = _CUST_VALUE_CATS.find(c => c.test(v));
  return t ? t.key : 'v0';
}

// Rep / owner — a DYNAMIC dimension: categories are the distinct lead owners,
// palette-coloured by first-seen order, so the map divides canvassing areas by
// who owns each deal. Names are best-effort (team-member maps if present).
const _CUST_REP_PALETTE = ['#4A9EFF', '#22C55E', '#D4A017', '#9B6DFF', '#ea580c', '#0891b2', '#e05252', '#16a34a', '#a855f7', '#0d9488'];
function _custRepKey(lead) { return lead.userId || lead.assignedTo || 'unassigned'; }
function _custRepName(uid) {
  if (uid === 'unassigned') return 'Unassigned';
  if (window._user && uid === window._user.uid) return 'Me';
  const maps = [window._repNames, window._teamNames];
  for (const m of maps) { if (m && m[uid]) return m[uid]; }
  const tm = window._teamMembers;
  if (Array.isArray(tm)) { const f = tm.find(x => x && (x.uid === uid || x.id === uid)); if (f) return f.name || f.displayName || f.email || uid; }
  return String(uid).slice(0, 6);
}
function _custRepCats() {
  const seen = [];
  (window._leads || []).forEach(l => { if (l && !l.deleted) { const k = _custRepKey(l); if (seen.indexOf(k) === -1) seen.push(k); } });
  return seen.map((k, i) => ({ key: k, label: _custRepName(k), color: _CUST_REP_PALETTE[i % _CUST_REP_PALETTE.length] }));
}

const _CUST_DIMENSIONS = {
  stage:  { label: 'Stage / Role', order: _CUST_ROLE_ORDER,
            cats: _CUST_ROLE_ORDER.map(r => ({ key: r, label: _CUST_ROLE_LABELS[r], color: _CUST_ROLE_COLORS[r] })),
            catOf: _custRoleOf },
  damage: { label: 'Damage Type', cats: _CUST_DAMAGE_CATS, catOf: _custDamageKey },
  value:  { label: 'Deal Value',  cats: _CUST_VALUE_CATS.map(c => ({ key: c.key, label: c.label, color: c.color })), catOf: _custValueKey },
  rep:    { label: 'Rep / Owner', catsFn: _custRepCats, catOf: _custRepKey },
};
const _CUST_DIM_KEYS = ['stage', 'damage', 'value', 'rep'];
// Resolve a dimension's categories (static array or dynamic function).
function _dimCats(dim) { return dim.catsFn ? dim.catsFn() : (dim.cats || []); }

// Active color-by dimension + per-dimension filter sets (null = all visible).
let _custColorBy = 'stage';
const _custFilters = { stage: null, damage: null, value: null, rep: null };

// Value-RANGE filter (independent of the value-tier color dimension): a min/max
// $ slider. max === _CUST_VAL_CAP means "no upper limit".
const _CUST_VAL_CAP = 100000;
const _CUST_VAL_STEP = 2500;
let _custValMin = 0;
let _custValMax = _CUST_VAL_CAP;
function _custValRangeActive() { return _custValMin > 0 || _custValMax < _CUST_VAL_CAP; }
function _custValRangePasses(lead) {
  if (!_custValRangeActive()) return true;
  const v = _custValueOf(lead);
  if (v < _custValMin) return false;
  if (_custValMax < _CUST_VAL_CAP && v > _custValMax) return false;
  return true;
}
function _custValLabel(v) { return v >= _CUST_VAL_CAP ? '$100k+' : (v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + v); }

// ── SAVED VIEWS (color-by + all filters + value range) — TEAM-SHARED ──
// Persisted to companyProfile.mapViews (read by all same-tenant members, write
// by owner / company_admin — same gate as the pipelines builder) so the whole
// team shares presets like "Hot Hail >$25k". Everyone can apply; only an
// owner/admin can save or delete.
//
// HYDRATION GATE (2026-09-18). Save and delete are read-modify-writes of the
// WHOLE array, and a merge write replaces arrays wholesale. Until
// _loadCompanyProfile's getDoc succeeds (possibly never this session — a
// failed read leaves _companyProfileLoaded unset), _companyProfile holds the
// NBD defaults (no mapViews → []) or a stale device cache, so a save used to
// overwrite every team view with just the new one. Both handlers now await
// hydration, then REQUIRE it (_custViewsReady), re-read the list AFTER the
// await, and _saveCustViews refuses on its own as a backstop.
let _custRenderedViews = [];              // the list the View <select> was last built from
function _loadCustViews() {
  const v = window._companyProfile && window._companyProfile.mapViews;
  return Array.isArray(v) ? v : [];
}
function _custViewName(v, i) { return (v && v.name) || ('View ' + (i + 1)); }
const _CUST_VIEWS_LOADING_MSG = 'Shared views are still loading — try again in a moment';
// Await-then-require, same shape as _tenantFilePrefix (company-profile.js):
// awaiting also RETRIES a read that failed at boot.
async function _custViewsReady() {
  if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
    try { await window._loadCompanyProfile(); } catch (_) { /* flag stays unset — refused below */ }
  }
  return window._companyProfileLoaded === true;
}
function _custCanEditViews() {
  const c = window._userClaims || {};
  const role = c.role || '';
  if (role === 'admin' || role === 'company_admin') return true;
  if (!c.companyId) return true;                       // solo owner (no companyId claim)
  return window._user && c.companyId === window._user.uid; // owner keyed by uid
}
async function _saveCustViews(v) {
  // Backstop for any caller that skipped _custViewsReady: never write the
  // shared array unless it was read from a loaded profile.
  if (window._companyProfileLoaded !== true) { if (typeof showToast === 'function') showToast(_CUST_VIEWS_LOADING_MSG, 'error'); return false; }
  if (typeof window._saveCompanyProfile !== 'function') { if (typeof showToast === 'function') showToast('Cannot save right now', 'error'); return false; }
  try { await window._saveCompanyProfile({ mapViews: v }); return true; }
  catch (e) { if (typeof showToast === 'function') showToast('Save failed: ' + ((e && e.message) || 'unknown'), 'error'); return false; }
}
function _custSnapshot() {
  const f = {};
  _CUST_DIM_KEYS.forEach(function (dk) { f[dk] = _custFilters[dk] ? Array.from(_custFilters[dk]) : null; });
  return { colorBy: _custColorBy, filters: f, valMin: _custValMin, valMax: _custValMax };
}
function _custApplyView(v) {
  if (!v || typeof v !== 'object') return;
  if (_CUST_DIMENSIONS[v.colorBy]) _custColorBy = v.colorBy;
  _CUST_DIM_KEYS.forEach(function (dk) {
    const a = v.filters && v.filters[dk];
    _custFilters[dk] = Array.isArray(a) ? new Set(a) : null;
  });
  _custValMin = typeof v.valMin === 'number' ? v.valMin : 0;
  _custValMax = typeof v.valMax === 'number' ? v.valMax : _CUST_VAL_CAP;
  buildCustomersLayer();
}

function _custColorForCat(dimKey, catKey) {
  const dim = _CUST_DIMENSIONS[dimKey];
  const c = dim && _dimCats(dim).find(x => x.key === catKey);
  return (c && c.color) || '#6B7280';
}
// A lead's dot colour = its category colour in the ACTIVE color-by dimension.
function _custColorOf(lead) {
  const dim = _CUST_DIMENSIONS[_custColorBy] || _CUST_DIMENSIONS.stage;
  return _custColorForCat(_custColorBy, dim.catOf(lead));
}
// Visible if it passes EVERY dimension's filter AND the value range.
function _custPasses(lead) {
  for (const dk of _CUST_DIM_KEYS) {
    const f = _custFilters[dk];
    if (f && !f.has(_CUST_DIMENSIONS[dk].catOf(lead))) return false;
  }
  return _custValRangePasses(lead);
}

function _custStageLabel(lead) {
  const key = lead._stageKey
    || (typeof window.normalizeStage === 'function' ? window.normalizeStage(lead.stage) : (lead.stage || 'new'));
  const meta = (window.STAGE_META && window.STAGE_META[key]) || null;
  return (meta && meta.label) || lead.stage || 'New';
}
function _custName(lead) {
  const n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
  return n || lead.name || lead.address || 'Customer';
}
function _custMoney(v) {
  if (!(v > 0)) return '';
  return v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + v;
}

// Dot, or (past label zoom + has value) a 💰 $value pill.
function _custIcon(lead, color, labelMode) {
  const esc = (typeof _mapsEscHtml === 'function') ? _mapsEscHtml : (s => String(s || ''));
  const c = esc(color);
  const v = _custValueOf(lead);
  if (labelMode && v > 0) {
    const html = `<div style="background:${c};color:#0A0C0F;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:800;`
      + `padding:2px 6px;border-radius:5px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.25);">💰 ${esc(_custMoney(v))}</div>`;
    return L.divIcon({ html, iconAnchor: [0, 0], className: '' });
  }
  const inner = lead.isProspect
    ? `<div style="width:12px;height:12px;border-radius:50%;background:transparent;border:3px solid ${c};box-shadow:0 1px 4px rgba(0,0,0,.5);"></div>`
    : `<div style="width:14px;height:14px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.55);"></div>`;
  return L.divIcon({ html: inner, iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -9], className: '' });
}

function _custPopupHTML(lead) {
  const esc  = (typeof _mapsEscHtml === 'function') ? _mapsEscHtml : (s => String(s || ''));
  const escA = (typeof _mapsEscJsInAttr === 'function') ? _mapsEscJsInAttr : esc;
  const color = _custColorOf(lead);
  const addr  = String(lead.address || '').split(',').slice(0, 2).join(',');
  const val   = _custValueOf(lead);
  const stage = _custStageLabel(lead);
  const tag   = lead.isProspect ? ' · prospect' : '';
  return `<div class="pin-lead-popup">
    <div class="plp-header">
      <div class="plp-name" style="color:${esc(color)};">${esc(_custName(lead))}</div>
      <div class="plp-addr">${esc(addr)}${esc(tag)}</div>
    </div>
    <div class="plp-body">
      <div class="plp-row"><span class="plp-key">Stage</span><span class="plp-val">${esc(stage)}</span></div>
      ${lead.damageType ? `<div class="plp-row"><span class="plp-key">Damage</span><span class="plp-val">${esc(lead.damageType)}</span></div>` : ''}
      ${val > 0 ? `<div class="plp-row"><span class="plp-key">Value</span><span class="plp-val" style="color:${esc(color)};">$${esc(val.toLocaleString())}</span></div>` : ''}
    </div>
    <div class="plp-btns">
      <button class="plp-btn-go" data-mo-action="goToLeadFromPin" data-mo-id="${escA(lead.id)}">→ Go to Lead</button>
    </div>
  </div>`;
}

function _addCustomerMarker(lead, lat, lng, labelMode) {
  const m = L.marker([lat, lng], { icon: _custIcon(lead, _custColorOf(lead), labelMode) });
  m.bindPopup(_custPopupHTML(lead), { maxWidth: 260, minWidth: 200, className: 'nbd-pin-popup', closeButton: true });
  customersLayer.addLayer(m);
}

function _ensureCustomersLayer() {
  if (customersLayer) return;
  customersLayer = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({ maxClusterRadius: 50, showCoverageOnHover: false, disableClusteringAtZoom: 18 })
    : L.layerGroup();
}

// Monotonic token so a build suspended on a geocode await can detect that a
// newer build superseded it and abort — otherwise concurrent invocations
// (a filter/color/zoom fired mid-backfill) clearLayers() each other's markers
// and double-add, duplicating pins.
let _custBuildToken = 0;

// Build (or rebuild) the layer from window._leads, honouring color-by + all
// filters. `doGeocode` gates the (slow, awaited) rolling geocode-backfill: it
// runs ONLY on layer show + on a leads refresh — NOT on filter/color/zoom
// re-renders, which just re-plot already-known coords. Without that gate every
// chip click re-ran a ~13s geocode batch and re-toasted (audit round 2).
async function buildCustomersLayer(doGeocode) {
  if (!mainMap) return;
  const token = ++_custBuildToken;
  _ensureCustomersLayer();
  customersLayer.clearLayers();

  const labelMode = mainMap.getZoom && mainMap.getZoom() >= _CUST_LABEL_ZOOM;
  const leads = window._leads || [];
  // Counts for the ACTIVE color-by dimension's legend (post other-dim filters).
  const counts = {};
  let liveRequests = 0;

  for (const lead of leads) {
    if (!lead || lead.deleted) continue;
    if (!_custPasses(lead)) continue; // AND across every dimension's filter

    const catForLegend = _CUST_DIMENSIONS[_custColorBy].catOf(lead);

    // 1) Already geocoded — plot now.
    const haveLat = lead.lat != null && lead.lat !== '';
    const haveLng = lead.lng != null && lead.lng !== '';
    if (haveLat && haveLng) {
      const la = parseFloat(lead.lat), ln = parseFloat(lead.lng);
      if (!isNaN(la) && !isNaN(ln)) { _addCustomerMarker(lead, la, ln, labelMode); counts[catForLegend] = (counts[catForLegend] || 0) + 1; }
      continue;
    }

    // 2) No coords but has address — lazy geocode + persist (backfill), but only
    //    on show/refresh (doGeocode). On a re-render, leave it for the next open.
    if (!doGeocode) continue;
    const addr = lead.address || lead.addr || '';
    if (!addr) continue;
    const key = addr.trim().toLowerCase();
    let geo = _custGeocodeCache.get(key);
    if (geo === undefined) {
      if (liveRequests >= _CUST_GEOCODE_CAP) continue;
      if (typeof geocode !== 'function') continue;
      try { geo = await geocode(addr, { quiet: true }); } catch (_) { geo = null; }
      if (token !== _custBuildToken) return; // superseded mid-await — a newer build owns the layer
      geo = geo ? { lat: parseFloat(geo.lat), lng: parseFloat(geo.lon) } : null;
      _custGeocodeCache.set(key, geo);
      liveRequests++;
      await new Promise(r => setTimeout(r, 1100)); // Nominatim fair-use
      if (token !== _custBuildToken) return; // superseded during the pacing sleep
    }
    if (!geo || isNaN(geo.lat) || isNaN(geo.lng)) continue;

    lead.lat = geo.lat; lead.lng = geo.lng;
    if (typeof window._saveLeadCoords === 'function' && lead.id && !String(lead.id).startsWith('d-')) {
      try { window._saveLeadCoords(lead.id, geo.lat, geo.lng); } catch (_) {}
    }
    _addCustomerMarker(lead, geo.lat, geo.lng, labelMode);
    counts[catForLegend] = (counts[catForLegend] || 0) + 1;
  }

  _renderCustPanel(counts);

  if (doGeocode && liveRequests >= _CUST_GEOCODE_CAP && typeof showToast === 'function') {
    showToast('Placed the first batch of un-mapped customers — reopen the layer to map more', 'info');
  }
}

// ── CONTROL PANEL (color-by + legend/filter + cross-dim filters) ─────────
function _injectCustPanelCss() {
  if (document.getElementById('cust-panel-style')) return;
  const s = document.createElement('style');
  s.id = 'cust-panel-style';
  // These offsets have to be authored HERE, in the JS, and not overridden
  // from dashboard-app.css: this <style> is appended to document.head at
  // runtime, i.e. after every <link> stylesheet, so an equal-specificity
  // rule added to a linked sheet loses on source order and silently does
  // nothing.
  // `bottom` now reads --map-band, the map's floating-chrome band declared
  // on .map-area (fab bar height + its padding, both ends). Reading the
  // token instead of restating a literal means the panel keeps clearing the
  // map FAB bar when that bar is resized — the old hard-coded 22px was a
  // measurement of a bar this file has no knowledge of. The fallback keeps
  // the panel sane if the token is ever dropped or the panel is reparented
  // outside a .map-area.
  // Horizontal position is deliberately untouched: this panel is bottom-
  // LEFT, so unlike .nbd-pin-panel it never enters the bottom-right FAB
  // rail and needs no --nbd-fab-rail offset. Only the vertical band matters.
  s.textContent =
    '.nbd-cust-panel{position:absolute;left:12px;bottom:var(--map-band, 88px);z-index:600;background:color-mix(in srgb, var(--s) 90%, transparent);'
    + 'border:1px solid var(--br);border-radius:10px;padding:9px 10px;font-family:sans-serif;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,.5);backdrop-filter:blur(4px);width:186px;max-height:60vh;overflow:auto;}'
    + '.nbd-cust-panel .ncp-row{display:flex;align-items:center;gap:6px;margin-bottom:7px;}'
    + '.nbd-cust-panel .ncp-lbl{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--m);font-weight:700;}'
    + '.nbd-cust-panel select{flex:1;background:var(--s2);color:var(--t);border:1px solid var(--br);border-radius:6px;font-size:12px;padding:3px 5px;}'
    + '.nbd-cust-panel .ncp-chip{display:flex;align-items:center;gap:7px;width:100%;background:none;border:none;padding:3px 4px;border-radius:6px;cursor:pointer;color:var(--t);font-size:12px;text-align:left;}'
    + '.nbd-cust-panel .ncp-chip:hover{background:color-mix(in srgb, var(--t) 7%, transparent);}'
    + '.nbd-cust-panel .ncp-chip.off{opacity:.38;}'
    + '.nbd-cust-panel .ncp-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;border:1px solid color-mix(in srgb, var(--t) 50%, transparent);}'
    + '.nbd-cust-panel .ncp-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '.nbd-cust-panel .ncp-cnt{color:var(--m);font-variant-numeric:tabular-nums;}'
    + '.nbd-cust-panel .ncp-more{width:100%;background:none;border:none;border-top:1px solid var(--br);margin-top:6px;padding-top:6px;'
    + 'color:var(--m);font-size:11px;cursor:pointer;text-align:left;}'
    + '.nbd-cust-panel .ncp-group-lbl{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--m);margin:6px 2px 3px;font-weight:700;}'
    + '.nbd-cust-panel .ncp-vr{padding:2px 2px 4px;}'
    + '.nbd-cust-panel .ncp-vr input[type=range]{width:100%;margin:2px 0;accent-color:var(--orange);height:14px;}'
    + '.nbd-cust-panel .ncp-vr-read{font-size:11px;color:var(--t);font-variant-numeric:tabular-nums;text-align:center;margin-top:2px;}'
    + '.nbd-cust-panel .ncp-iconbtn{background:var(--s2);color:var(--t);border:1px solid var(--br);border-radius:6px;font-size:12px;line-height:1;padding:3px 6px;cursor:pointer;flex:0 0 auto;}'
    + '.nbd-cust-panel .ncp-iconbtn:hover{background:var(--s3);}'
    // Phone viewports: narrow + cap height so the panel doesn't cover the map;
    // sits bottom-left alongside the bottom-right pins panel (≈46vw each).
    // Same --map-band story as the desktop rule above; the mobile fallback
    // stays 74px because .map-area redeclares the band smaller on phones.
    // Nothing may be inserted between the @media open brace and the
    // `.nbd-cust-panel{width:46vw` that follows it — tests/smoke/maps.test.js
    // matches the two within a 120-character window of raw source.
    + '@media (max-width:640px){'
    + '.nbd-cust-panel{width:46vw;max-height:46vh;padding:7px 8px;left:8px;bottom:var(--map-band, 74px);font-size:11px;}'
    + '.nbd-cust-panel .ncp-chip,.nbd-cust-panel select{font-size:11px;}'
    + '.nbd-cust-panel .ncp-dot{width:9px;height:9px;}}';
  document.head.appendChild(s);
}

// Chip row markup for a dimension (used by the legend + the filter groups).
function _custChipsHTML(dimKey, counts) {
  const esc = (typeof _mapsEscHtml === 'function') ? _mapsEscHtml : (s => String(s || ''));
  const dim = _CUST_DIMENSIONS[dimKey];
  const filter = _custFilters[dimKey];
  let html = '';
  _dimCats(dim).forEach(function (c) {
    const off = (filter && !filter.has(c.key)) ? ' off' : '';
    const cnt = counts ? ('<span class="ncp-cnt">' + (counts[c.key] || 0) + '</span>') : '';
    html += '<button type="button" class="ncp-chip' + off + '" data-cust-dim="' + esc(dimKey) + '" data-cust-cat="' + esc(c.key) + '">'
      + '<span class="ncp-dot" style="background:' + esc(c.color) + ';"></span>'
      + '<span class="ncp-name">' + esc(c.label) + '</span>' + cnt + '</button>';
  });
  return html;
}

let _custLastCounts = {};
function _renderCustPanel(counts) {
  if (!mainMap) return;
  counts = counts || _custLastCounts; _custLastCounts = counts; // reuse last legend counts on state-only re-renders
  const container = mainMap.getContainer && mainMap.getContainer();
  if (!container) return;
  _injectCustPanelCss();
  if (!_custPanelEl) {
    _custPanelEl = document.createElement('div');
    _custPanelEl.className = 'nbd-cust-panel';
    container.appendChild(_custPanelEl);
    if (L.DomEvent) { L.DomEvent.disableClickPropagation(_custPanelEl); L.DomEvent.disableScrollPropagation(_custPanelEl); }
  }
  const esc = (typeof _mapsEscHtml === 'function') ? _mapsEscHtml : (s => String(s || ''));
  let html = '';
  // Saved views (presets, team-shared): apply for everyone; save/delete for
  // owner/admin only.
  const views = _loadCustViews();
  _custRenderedViews = views.slice(); // what the <select> indexes point at (delete re-checks against it)
  const canEditViews = _custCanEditViews();
  html += '<div class="ncp-row"><span class="ncp-lbl">View</span>'
    + '<select data-cust-view><option value="">—</option>'
    + views.map(function (v, i) { return '<option value="' + i + '">' + esc(_custViewName(v, i)) + '</option>'; }).join('')
    + '</select>'
    + (canEditViews
        ? '<button type="button" class="ncp-iconbtn" data-cust-saveview title="Save current view (shared with the team)">＋</button>'
          + '<button type="button" class="ncp-iconbtn" data-cust-delview title="Delete selected view">🗑</button>'
        : '')
    + '</div>';
  // Color-by selector.
  html += '<div class="ncp-row"><span class="ncp-lbl">Color</span>'
    + '<select data-cust-colorby>';
  _CUST_DIM_KEYS.forEach(function (dk) {
    html += '<option value="' + dk + '"' + (_custColorBy === dk ? ' selected' : '') + '>' + esc(_CUST_DIMENSIONS[dk].label) + '</option>';
  });
  html += '</select></div>';
  // Legend for the active color-by dimension (counts + click-to-filter).
  html += _custChipsHTML(_custColorBy, counts);
  // Cross-dimension filters (the OTHER dims), collapsible.
  const others = _CUST_DIM_KEYS.filter(function (d) { return d !== _custColorBy; });
  const anyOtherFilter = others.some(function (d) { return !!_custFilters[d]; });
  html += '<button type="button" class="ncp-more" data-cust-morefilters>'
    + (_custFiltersOpen ? '▾' : '▸') + ' Filters' + (anyOtherFilter ? ' •' : '') + '</button>';
  // Route the currently-filtered stops (nearest-neighbor from your GPS/centre).
  html += '<button type="button" class="ncp-more" data-cust-route>🧭 '
    + (_custRouteOn ? 'Clear route' : 'Route these stops') + '</button>';
  if (_custRouteOn) {
    html += '<button type="button" class="ncp-more" data-cust-gmaps>🗺 Open in Google Maps</button>';
  }
  if (_custFiltersOpen) {
    others.forEach(function (dk) {
      html += '<div class="ncp-group-lbl">' + esc(_CUST_DIMENSIONS[dk].label) + '</div>';
      html += _custChipsHTML(dk, null);
    });
    // Deal-value RANGE slider (min/max), independent of the value-tier chips.
    html += '<div class="ncp-group-lbl">Value Range' + (_custValRangeActive() ? ' •' : '') + '</div>';
    html += '<div class="ncp-vr">'
      + '<input type="range" data-cust-valmin min="0" max="' + _CUST_VAL_CAP + '" step="' + _CUST_VAL_STEP + '" value="' + _custValMin + '">'
      + '<input type="range" data-cust-valmax min="0" max="' + _CUST_VAL_CAP + '" step="' + _CUST_VAL_STEP + '" value="' + _custValMax + '">'
      + '<div class="ncp-vr-read">' + esc(_custValLabel(_custValMin)) + ' – ' + esc(_custValLabel(_custValMax)) + '</div>'
      + '</div>';
  }
  _custPanelEl.innerHTML = html;

  if (!_custPanelEl._wired) {
    _custPanelEl._wired = true;
    // Color-by change + value-range commit (on release).
    _custPanelEl.addEventListener('change', function (e) {
      const t = e.target;
      const sel = t && t.closest && t.closest('[data-cust-colorby]');
      if (sel) { if (_CUST_DIMENSIONS[sel.value]) { _custColorBy = sel.value; buildCustomersLayer(); } return; }
      const vsel = t && t.closest && t.closest('[data-cust-view]');
      if (vsel) { if (vsel.value !== '') { const list = _loadCustViews(); _custApplyView(list[parseInt(vsel.value, 10)]); } return; }
      if (t && t.getAttribute && (t.hasAttribute('data-cust-valmin') || t.hasAttribute('data-cust-valmax'))) {
        buildCustomersLayer(); // filter already updated live on 'input'
      }
    });
    // Live value-range readout while dragging (no rebuild → keeps slider focus).
    _custPanelEl.addEventListener('input', function (e) {
      const t = e.target;
      if (!t || !t.hasAttribute) return;
      // NaN-guard, NOT `|| fallback`: a legit 0 is falsy, so `parseInt||CAP`
      // made dragging MAX to $0 snap to "no cap" (showing everything) instead
      // of clamping to [min,0] (audit 2026-07-08).
      if (t.hasAttribute('data-cust-valmin')) { const n = parseInt(t.value, 10); _custValMin = Math.min(isNaN(n) ? 0 : n, _custValMax); }
      else if (t.hasAttribute('data-cust-valmax')) { const n = parseInt(t.value, 10); _custValMax = Math.max(isNaN(n) ? _CUST_VAL_CAP : n, _custValMin); }
      else return;
      const read = _custPanelEl.querySelector('.ncp-vr-read');
      if (read) read.textContent = _custValLabel(_custValMin) + ' – ' + _custValLabel(_custValMax);
    });
    // Chip toggle (legend + filter groups) and "＋ Filters".
    _custPanelEl.addEventListener('click', function (e) {
      const save = e.target && e.target.closest && e.target.closest('[data-cust-saveview]');
      if (save) {
        if (!_custCanEditViews()) { if (typeof showToast === 'function') showToast('Only an owner/admin can save shared views', 'info'); return; }
        const name = (typeof prompt === 'function') ? (prompt('Name this view — shared with your team (color-by + filters + value range):') || '').trim() : '';
        if (!name) return;
        const snap = _custSnapshot(); // the panel state the user is saving, taken at click time
        _custViewsReady().then(function (ready) {
          if (!ready) { if (typeof showToast === 'function') showToast(_CUST_VIEWS_LOADING_MSG, 'error'); return; }
          const list = _loadCustViews().slice(); // read AFTER hydration, never before
          list.push(Object.assign({ name: name.slice(0, 40) }, snap));
          _saveCustViews(list).then(function (okSave) { if (okSave && typeof showToast === 'function') showToast('View saved (shared)', 'ok'); _renderCustPanel(); });
        });
        return;
      }
      const del = e.target && e.target.closest && e.target.closest('[data-cust-delview]');
      if (del) {
        if (!_custCanEditViews()) { if (typeof showToast === 'function') showToast('Only an owner/admin can delete shared views', 'info'); return; }
        const vsel = _custPanelEl.querySelector('[data-cust-view]');
        const idx = vsel && vsel.value !== '' ? parseInt(vsel.value, 10) : -1;
        if (idx < 0) { if (typeof showToast === 'function') showToast('Pick a view to delete', 'info'); return; }
        // The index is into the list the <select> was BUILT from — possibly a
        // pre-hydration cache. Pin the name the user actually picked, and only
        // splice if the hydrated list still has that view at that index;
        // otherwise a reordered/grown list would delete a different view.
        const pickedName = _custRenderedViews[idx] ? _custViewName(_custRenderedViews[idx], idx) : null;
        _custViewsReady().then(function (ready) {
          if (!ready) { if (typeof showToast === 'function') showToast(_CUST_VIEWS_LOADING_MSG, 'error'); return; }
          const list = _loadCustViews().slice(); // read AFTER hydration
          if (pickedName === null || !list[idx] || _custViewName(list[idx], idx) !== pickedName) {
            if (typeof showToast === 'function') showToast('Shared views changed — re-select the view and try again', 'info');
            _renderCustPanel();
            return;
          }
          list.splice(idx, 1);
          _saveCustViews(list).then(function () { _renderCustPanel(); });
        });
        return;
      }
      const gmaps = e.target && e.target.closest && e.target.closest('[data-cust-gmaps]');
      if (gmaps) { openRouteInGmaps(); return; }
      const route = e.target && e.target.closest && e.target.closest('[data-cust-route]');
      if (route) { toggleCustomerRoute(); return; } // toggle re-renders the panel itself
      const more = e.target && e.target.closest && e.target.closest('[data-cust-morefilters]');
      if (more) { _custFiltersOpen = !_custFiltersOpen; _renderCustPanel(); return; } // no-arg → freshest _custLastCounts (the closed-over `counts` is stale)
      const chip = e.target && e.target.closest && e.target.closest('[data-cust-cat]');
      if (!chip) return;
      const dk = chip.getAttribute('data-cust-dim');
      const cat = chip.getAttribute('data-cust-cat');
      const dim = _CUST_DIMENSIONS[dk];
      if (!dim) return;
      const cats = _dimCats(dim);
      if (!_custFilters[dk]) _custFilters[dk] = new Set(cats.map(function (c) { return c.key; }));
      const f = _custFilters[dk];
      if (f.has(cat)) { if (f.size > 1) f.delete(cat); } else { f.add(cat); }
      // If a dimension's filter is back to "all", drop it (null = no filter).
      if (f.size === cats.length) _custFilters[dk] = null;
      buildCustomersLayer();
    });
  }
  _custPanelEl.style.display = '';
}
function _hideCustPanel() { if (_custPanelEl) _custPanelEl.style.display = 'none'; }

// ── ROUTE OPTIMIZER (nearest-neighbor over the filtered dots) ────────────
let _custRouteLayer = null;
let _custRouteOn = false;
let _custRouteStart = null;    // {lat,lng} the route began from (GPS or map centre)
let _custRouteOrdered = [];    // ordered stops [{lead,lat,lng}] for the Maps hand-off
let _custRouteBuilding = false; // in-flight guard while buildCustomerRoute awaits geolocation
// Google consumer directions holds origin + 23 waypoints + 1 destination = 24
// STOPS (origin is the rep's start, not a stop). Cap the route at 24 so the map
// pins and the "Open in Google Maps" hand-off always carry the SAME stops — a
// 25th stop was drawn on the map but silently dropped from the URL (audit).
const _CUST_ROUTE_CAP = 24;    // keep the day's route sane + fit the Maps hand-off
const _CUST_GMAPS_WP_CAP = 23; // Google consumer directions waypoint limit
// Resolve the route's START: prefer the rep's GPS (they route FROM where they
// are), fall back to the map centre if geolocation is unavailable/denied/slow.
function _custResolveStart() {
  return new Promise(function (resolve) {
    const c = mainMap.getCenter();
    const fallback = { lat: c.lat, lng: c.lng, gps: false };
    if (!(navigator && navigator.geolocation)) { resolve(fallback); return; }
    let done = false;
    const t = setTimeout(function () { if (!done) { done = true; resolve(fallback); } }, 6000);
    navigator.geolocation.getCurrentPosition(
      function (pos) { if (done) return; done = true; clearTimeout(t); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, gps: true }); },
      function () { if (done) return; done = true; clearTimeout(t); resolve(fallback); },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
    );
  });
}
function _custHavFt(a, b) {
  if (typeof hav === 'function') { try { return hav(a, b); } catch (_) {} }
  const R = 20902231, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
// Leads currently passing every filter AND having coords → routable stops.
function _custRoutableStops() {
  const out = [];
  (window._leads || []).forEach(l => {
    if (!l || l.deleted || !_custPasses(l)) return;
    if (l.lat == null || l.lng == null) return;
    const la = parseFloat(l.lat), ln = parseFloat(l.lng);
    if (!isNaN(la) && !isNaN(ln)) out.push({ lead: l, lat: la, lng: ln });
  });
  return out;
}
function _custNnOrder(start, pts) {
  const remaining = pts.slice(), order = [];
  let cur = start;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = _custHavFt(cur, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    const n = remaining.splice(bi, 1)[0];
    order.push(n);
    cur = { lat: n.lat, lng: n.lng };
  }
  return order;
}
function _custNumIcon(n) {
  return L.divIcon({
    html: '<div style="width:20px;height:20px;border-radius:50%;background:var(--orange,#BD5728);color:var(--accent-fg,#0A0C0F);font-family:sans-serif;font-size:11px;font-weight:800;'
      + 'display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.55);">' + n + '</div>',
    iconSize: [20, 20], iconAnchor: [10, 10], className: '',
  });
}
function _clearRoute() {
  if (_custRouteLayer && mainMap) mainMap.removeLayer(_custRouteLayer);
  _custRouteLayer = null;
  _custRouteOn = false;
  _custRouteOrdered = [];
  _custRouteStart = null;
}
async function buildCustomerRoute() {
  // In-flight guard: _custResolveStart() can block several seconds on the
  // geolocation permission prompt / cold GPS, during which _custRouteOn is
  // still false and the button still reads "Route these stops". Without this a
  // second click re-enters and builds a SECOND route layer, orphaning the first
  // on the map (Clear only removes the latest) until reload (#921).
  if (!mainMap || _custRouteBuilding) return;
  _custRouteBuilding = true;
  try {
    _clearRoute();
    let stops = _custRoutableStops();
    if (!stops.length) { if (typeof showToast === 'function') showToast('No mapped customers match the current filters', 'info'); return; }
    let capped = false;
    if (stops.length > _CUST_ROUTE_CAP) { stops = stops.slice(0, _CUST_ROUTE_CAP); capped = true; }
    const start = await _custResolveStart();
    // If the user toggled the Customers overlay OFF during that await, bail —
    // otherwise we'd draw a route layer onto mainMap (orphaned, since
    // hideCustomersLayer already ran) and reopen the control panel over a layer
    // that reads OFF.
    if (!overlayState || !overlayState.customers) return;
    const ordered = _custNnOrder(start, stops);
    _custRouteStart = start;
    _custRouteOrdered = ordered;
    // Total drive-ish distance (great-circle, feet → miles).
    let ft = _custHavFt(start, ordered[0]);
    for (let i = 1; i < ordered.length; i++) ft += _custHavFt(ordered[i - 1], ordered[i]);
    const miles = (ft / 5280).toFixed(1);

    _custRouteLayer = L.layerGroup();
    const latlngs = [[start.lat, start.lng]].concat(ordered.map(o => [o.lat, o.lng]));
    L.polyline(latlngs, { color: '#BD5728', weight: 3, opacity: 0.85, dashArray: '6,6' }).addTo(_custRouteLayer);
    ordered.forEach((o, i) => { L.marker([o.lat, o.lng], { icon: _custNumIcon(i + 1) }).addTo(_custRouteLayer); });
    _custRouteLayer.addTo(mainMap);
    _custRouteOn = true;
    try { mainMap.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] }); } catch (_) {}
    if (typeof showToast === 'function') {
      showToast('Route: ' + ordered.length + ' stops · ~' + miles + ' mi · from ' + (start.gps ? 'your location' : 'map centre')
        + (capped ? ' (first ' + _CUST_ROUTE_CAP + ')' : ''), 'ok');
    }
    _renderCustPanel(); // reflect route-on state (Clear / Open-in-Maps buttons)
  } finally {
    _custRouteBuilding = false;
  }
}
function toggleCustomerRoute() {
  if (_custRouteBuilding) return; // a build is resolving geolocation — ignore re-clicks
  if (_custRouteOn) { _clearRoute(); _renderCustPanel(); if (typeof showToast === 'function') showToast('Route cleared', 'info'); }
  else { buildCustomerRoute(); } // async; re-renders the panel when done
}
// Hand off the ordered stops to Google Maps for turn-by-turn. Origin = route
// start, destination = last stop, intermediate stops = waypoints (Google caps
// consumer waypoints at ~23).
function _custGmapsUrl() {
  if (!_custRouteOrdered || !_custRouteOrdered.length) return null;
  const stops = _custRouteOrdered;
  const dest = stops[stops.length - 1];
  const mids = stops.slice(0, -1).slice(0, _CUST_GMAPS_WP_CAP);
  let u = 'https://www.google.com/maps/dir/?api=1';
  if (_custRouteStart) u += '&origin=' + _custRouteStart.lat + ',' + _custRouteStart.lng;
  u += '&destination=' + dest.lat + ',' + dest.lng;
  if (mids.length) u += '&waypoints=' + encodeURIComponent(mids.map(s => s.lat + ',' + s.lng).join('|'));
  u += '&travelmode=driving';
  return u;
}
function openRouteInGmaps() {
  const u = _custGmapsUrl();
  if (u && typeof window.open === 'function') window.open(u, '_blank', 'noopener');
}

// Re-icon (dot ↔ $ label) when crossing the label-zoom threshold.
function _wireCustZoom() {
  if (_custZoomWired || !mainMap) return;
  _custZoomWired = true;
  let wasLabel = mainMap.getZoom() >= _CUST_LABEL_ZOOM;
  mainMap.on('zoomend', function () {
    if (!overlayState || !overlayState.customers) return;
    const nowLabel = mainMap.getZoom() >= _CUST_LABEL_ZOOM;
    if (nowLabel !== wasLabel) { wasLabel = nowLabel; buildCustomersLayer(); }
  });
}

function showCustomersLayer() {
  _ensureCustomersLayer();
  _wireCustZoom();
  if (customersLayer.getLayers().length === 0) { buildCustomersLayer(true); } // show → run the geocode-backfill
  else if (_custPanelEl) { _custPanelEl.style.display = ''; }
  customersLayer.addTo(mainMap);
}
function hideCustomersLayer() {
  // Supersede any in-flight geocode-backfill build (its post-await token guards
  // will now fire and return BEFORE _renderCustPanel), so a build started while
  // the overlay was on can't reopen the hidden control panel seconds later.
  _custBuildToken++;
  if (customersLayer && mainMap) mainMap.removeLayer(customersLayer); _hideCustPanel(); _clearRoute();
}

function refreshCustomersLayer() { if (overlayState && overlayState.customers) { buildCustomersLayer(true); } } // leads changed → re-geocode any new un-mapped ones

if (typeof window !== 'undefined') {
  window.buildCustomersLayer   = buildCustomersLayer;
  window.showCustomersLayer    = showCustomersLayer;
  window.hideCustomersLayer    = hideCustomersLayer;
  window.refreshCustomersLayer = refreshCustomersLayer;
  window.buildCustomerRoute    = buildCustomerRoute;
  window.toggleCustomerRoute   = toggleCustomerRoute;
  window.openRouteInGmaps      = openRouteInGmaps;
  // Shared rep palette (key/label/color per distinct lead owner) so other
  // surfaces — e.g. territory-zone shading — colour reps consistently.
  window.nbdRepList            = _custRepCats;
}
