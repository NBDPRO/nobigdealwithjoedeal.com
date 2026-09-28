/**
 * maps-overlays.js — runtime UI for the main map: jobs/storm/weather
 * tile layers, pin confirm flow, pin markers + popups + actions,
 * map search and "damage near me".
 *
 * Extracted from maps.js (Step 4d — 2026-05-16) as the runtime-UI
 * sibling of maps-core.js and maps-routing.js. Load order in
 * dashboard.html is:
 *
 *   core → overlays → routing → maps (shim)
 *
 * Depends on the sibling-scope globals declared in maps-core.js
 * (mainMap, pinMarkers, pinClusterGroup, overlayState, heatLayer,
 * jobMarkers, weatherLayer, stormTileLayer, pendingPin,
 * curPinStatus, curPinColor, PIN_LABELS, PIN_COLORS, STAGE_COLORS,
 * hav, mid). Classic-script — no import/export.
 *
 * window.* exports for searchMap / makeLeadFromSearch happen here
 * (legacy: they were inline next to the function defs in maps.js)
 * and are re-stated by the maps.js shim alongside the rest of the
 * public surface.
 */

// ── JOBS OVERLAY ──────────────────────────────────
// Process-scoped cache so toggling the overlay on/off doesn't re-geocode
// every active job; keyed by normalised address. Null entries mean
// "Nominatim returned nothing" so we don't retry on each toggle.
let _NBD_MO_DELEGATE_BOUND; // module-local (globals Tranche 1 — was window.*)
const _jobsGeocodeCache = new Map();
const _JOBS_GEOCODE_CAP = 20; // hard cap per buildJobsLayer() run
async function buildJobsLayer() {
  if(!mainMap) return;
  jobMarkers.forEach(m=>mainMap.removeLayer(m));
  jobMarkers = [];
  const leads = window._leads || [];
  // Match BOTH canonical (post-crm-stages migration) ids and legacy
  // display names — same dual-name rule as the colorizer below. The
  // legacy-only filter left the Jobs layer permanently empty for
  // migrated tenants (NEW-D35); 'Finalizing' maps to the canonical
  // finalization trio (final_photos/deductible_collected/final_payment).
  const JOB_OVERLAY_STAGES = [
    'install_in_progress','install_complete','final_photos',
    'deductible_collected','final_payment','closed',
    'In Progress','Complete','Finalizing'
  ];
  const active = leads.filter(l => JOB_OVERLAY_STAGES.includes(l.stage||''));
  const esc = (typeof _mapsEscHtml === 'function') ? _mapsEscHtml : (s => String(s||''));
  let liveRequests = 0;
  for(const lead of active) {
    const addr = lead.address || lead.addr || '';
    if(!addr) continue;
    try {
      const key = addr.trim().toLowerCase();
      let geo;
      if (_jobsGeocodeCache.has(key)) {
        geo = _jobsGeocodeCache.get(key);
      } else {
        if (liveRequests >= _JOBS_GEOCODE_CAP) continue; // respect fair-use
        geo = await geocode(addr, { quiet: true });
        _jobsGeocodeCache.set(key, geo || null);
        liveRequests++;
        // Nominatim fair-use: ≥ 1 req/s. Previous 180ms = 5.5 req/s and
        // tripped their rate-limiter on any user with > 10 active jobs.
        await new Promise(r => setTimeout(r, 1100));
      }
      if(!geo) continue;
      const val = parseFloat(lead.value||lead.jobValue||lead.contractValue||0);
      const label = val > 0 ? '$'+val.toLocaleString() : lead.stage;
      // Compare against BOTH canonical (post-crm-stages migration) and
      // legacy display names so old leads in Firestore still colour
      // correctly. v159.4 swept most callers; this map-marker colorizer
      // was missed because legacy stage names were also used as the
      // popup label, hiding the comparison drift.
      const _stg = lead.stage || '';
      const color = (_stg === 'closed' || _stg === 'Complete') ? '#34D399'
                  : (_stg === 'install_in_progress' || _stg === 'In Progress') ? '#4A9EFF'
                  : '#EAB308';
      const icon = L.divIcon({
        html:`<div style="background:${esc(color)};color:#0A0C0F;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:800;padding:3px 7px;border-radius:5px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.2);">💰 ${esc(label)}</div>`,
        iconAnchor:[0,0], className:''
      });
      const m = L.marker([parseFloat(geo.lat),parseFloat(geo.lon)],{icon});
      m.bindPopup(`<div style="font-family:sans-serif;min-width:160px;">
        <b style="font-size:13px;color:${esc(color)};">${esc(((lead.firstName||'')+' '+(lead.lastName||'')).trim()||lead.name||'Lead')}</b>
        <p style="font-size:11px;color:#666;margin:4px 0;">${esc(addr)}</p>
        <p style="font-size:11px;margin:2px 0;"><b>Stage:</b> ${esc((typeof window.stageLabel==='function'&&window.stageLabel(_stg))||_stg)}</p>
        ${val>0?`<p style="font-size:12px;font-weight:700;color:${esc(color)};">$${val.toLocaleString()}</p>`:''}
      </div>`);
      jobMarkers.push(m);
      if(overlayState.jobs) m.addTo(mainMap);
    } catch(e){ console.warn('Job overlay geocode failed for:', lead.address, e.message); }
  }
}
function showJobsLayer() {
  if(jobMarkers.length===0){ buildJobsLayer(); return; }
  jobMarkers.forEach(m=>m.addTo(mainMap));
}
function hideJobsLayer() { jobMarkers.forEach(m=>mainMap.removeLayer(m)); }

// ── STORM LAYER (NOAA via RainViewer / mesonet tile) ───────
function showStormLayer() {
  if(stormTileLayer) { stormTileLayer.addTo(mainMap); return; }
  // NOAA Ridge2 latest composite reflectivity — free, no key
  stormTileLayer = L.tileLayer(
    'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
    {opacity:0.65, attribution:'NOAA/IEM', maxZoom:20, tms:false}
  );
  stormTileLayer.addTo(mainMap);
  showToast('Storm radar loaded — NOAA NEXRAD');
}
function hideStormLayer() { if(stormTileLayer) mainMap.removeLayer(stormTileLayer); }

// ── WEATHER LAYER (OpenWeatherMap precipitation — free tier key optional) ──
function showWeatherLayer() {
  if(weatherLayer) { weatherLayer.addTo(mainMap); return; }
  // RainViewer public precipitation overlay — no API key needed
  weatherLayer = L.tileLayer(
    'https://tilecache.rainviewer.com/v2/coverage/0/256/{z}/{x}/{y}/1/1_1.png',
    {opacity:0.55, attribution:'RainViewer', maxZoom:20}
  );
  weatherLayer.addTo(mainMap);
  showToast('Live weather overlay active');
}
function hideWeatherLayer() { if(weatherLayer) mainMap.removeLayer(weatherLayer); }

// ── PIN CONFIRM FLOW ─────────────────────────────
function openPinConfirm(lat, lng) {
  pendingPin = { lat, lng, status: curPinStatus, color: curPinColor };
  const dot   = document.getElementById('pcd-dot');
  const lbl   = document.getElementById('pcd-label');
  const coord = document.getElementById('pcd-coords');
  const notes = document.getElementById('pcd-notes');
  const ov    = document.getElementById('pinConfirmOverlay');
  if (dot)   dot.style.background = curPinColor;
  if (lbl)   lbl.textContent = PIN_LABELS[curPinStatus] || curPinStatus;
  if (coord) coord.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (notes) notes.value = '';
  if (ov)    ov.classList.add('open');
}
function cancelPinConfirm() {
  pendingPin = null;
  const ov = document.getElementById('pinConfirmOverlay');
  if (ov) ov.classList.remove('open');
}
async function commitPin() {
  if(!pendingPin) return;
  const notesEl = document.getElementById('pcd-notes');
  const notes = notesEl ? notesEl.value.trim() : '';
  const ov = document.getElementById('pinConfirmOverlay');
  if (ov) ov.classList.remove('open');
  await dropPin(pendingPin.lat, pendingPin.lng, pendingPin.status, pendingPin.color, null, notes);
  refreshHeatLayer();
  pendingPin = null;
  showToast('Pin saved ✓');
  if(typeof updatePinStats === 'function') updatePinStats();
}

// ── DROP PIN BY ADDRESS ──────────────────────────
async function dropPinByAddress() {
  const addrEl = document.getElementById('pinAddrInput');
  const addr = addrEl ? addrEl.value.trim() : '';
  let lat, lng;
  if(addr) {
    showToast('Geocoding address...');
    const geo = await geocode(addr);
    if(!geo) { showToast('Address not found','error'); return; }
    lat = parseFloat(geo.lat); lng = parseFloat(geo.lon);
    mainMap.setView([lat,lng],18);
  } else {
    const c = mainMap.getCenter();
    lat = c.lat; lng = c.lng;
  }
  openPinConfirm(lat, lng);
  if (addrEl) addrEl.value = '';
}

// ── ORIGINAL PIN FUNCTIONS (updated) ────────────────
function makePinIcon(color, status) {
  // `color` is a per-pin /pins field and pins are now TEAM-VISIBLE, so a
  // teammate (or compromised rep) can persist an arbitrary string here. Escape
  // it before interpolating into the divIcon HTML — otherwise a crafted value
  // breaks out of fill="…" and becomes cross-user stored XSS. Every other sink
  // in this file already routes colour through esc; this icon path was the gap.
  const safe = (typeof _mapsEscHtml === 'function') ? _mapsEscHtml(color) : String(color || '');
  const svg = status==='signed' ? '⭐' : `<svg viewBox="0 0 24 32" width="20" height="28" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C7.6 0 4 3.6 4 8c0 6 8 16 8 16s8-10 8-16c0-4.4-3.6-8-8-8z" fill="${safe}" stroke="white" stroke-width="1.5"/><circle cx="12" cy="8" r="3" fill="white"/></svg>`;
  return L.divIcon({html:`<div style="font-size:20px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));">${svg}</div>`,iconSize:[20,28],iconAnchor:[10,28],popupAnchor:[0,-28],className:''});
}

async function dropPin(lat,lng,status,color,existingId,notes) {
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
  const id = existingId || await window.__NBD_CALL_REGISTRY._savePin({lat,lng,status,color,notes});
  addPinMarker({id,lat,lng,status,color,notes});
}

function addPinMarker(p) {
  if(!mainMap) return;

  // Determine pin color: use stage color for customer pins, status color otherwise.
  // Customer pins colour by the LIVE pipeline engine (window.STAGE_META /
  // stageRole) so they match the kanban AND honour a tenant's custom stages —
  // the old static STAGE_COLORS map only knew the legacy display names ('New',
  // 'Approved', …) and left post-migration/custom stages mis-coloured.
  let pinColor = p.color || PIN_COLORS[p.status] || '#9CA3AF';
  if (p.type === 'customer' && p.stage) {
    const key = (typeof window.normalizeStage === 'function') ? window.normalizeStage(p.stage) : p.stage;
    const meta = (window.STAGE_META && window.STAGE_META[key]) || null;
    if (meta && meta.color) {
      pinColor = meta.color;
    } else if (typeof window.stageRole === 'function') {
      const roleColors = { new:'#9CA3AF', active:'#4A9EFF', job:'#0D9488', won:'#22C55E', lost:'#E05252' };
      pinColor = roleColors[window.stageRole(key)] || pinColor;
    } else if (STAGE_COLORS[p.stage]) {
      pinColor = STAGE_COLORS[p.stage]; // legacy fallback
    }
  }

  const m = L.marker([p.lat,p.lng],{icon:makePinIcon(pinColor, p.status || p.stage)});
  m.on('click', () => openPinLeadPopup(p, m));
  // Add to cluster group if available, otherwise directly to map
  if(pinClusterGroup) { pinClusterGroup.addLayer(m); } else { m.addTo(mainMap); }
  pinMarkers[p.id] = m;
  // Respect an active disposition filter for freshly-dropped/loaded pins.
  if (_pinDispFilter && !_pinPassesDisp(p)) _setPinVisible(m, false);
}

// ── DISPOSITION FILTER (door-knock pins) ─────────────────────────
// A floating legend/filter for the D2D pins, mirroring the Customers panel but
// on the single dimension pins actually carry: knock disposition (p.status →
// PIN_LABELS/PIN_COLORS). Colour-by is implicit (pins are already status-
// coloured); this adds per-disposition show/hide. Pins without a status
// (customer / legacy pins) always pass so a filter never hides them.
let _pinDispFilter = null; // Set of statuses to show; null = all
let _pinPanelEl = null;
function _pinPassesDisp(p) { if (!_pinDispFilter) return true; if (!p || !p.status) return true; return _pinDispFilter.has(p.status); }
function _setPinVisible(m, show) {
  if (!m) return;
  if (pinClusterGroup) { pinClusterGroup.removeLayer(m); if (show) pinClusterGroup.addLayer(m); }
  else if (mainMap) { mainMap.removeLayer(m); if (show) m.addTo(mainMap); }
}
function applyPinDispFilter() {
  (window._pins || []).forEach(p => { const m = pinMarkers[p.id]; if (m) _setPinVisible(m, _pinPassesDisp(p)); });
}
function _injectPinPanelCss() {
  if (document.getElementById('pin-panel-style')) return;
  const s = document.createElement('style');
  s.id = 'pin-panel-style';
  // Self-contained (identical tokens to the Customers panel) so it works even
  // if that layer was never opened; positioned bottom-RIGHT to avoid overlap.
  //
  // The two offsets are shared tokens, not literals:
  //   --nbd-fab-rail  the horizontal width the floating FAB column owns. This
  //                   panel steps SIDEWAYS out of that rail instead of lifting
  //                   above it, because it is a TALL panel (max-height:46vh,
  //                   ~374px on a phone) — claiming vertical space would shove
  //                   the whole FAB stack into the middle of the screen. That
  //                   is also why it must never declare data-nbd-corner-claim.
  //   --map-band      .map-area's bottom overlay band (fab-bar height + pad),
  //                   so the panel rides on the band instead of guessing a
  //                   clearance that goes stale the moment the bar resizes.
  // The fallbacks are the panel's pre-token geometry, so it stays sane if the
  // tokens are ever dropped.
  //
  // These MUST be edited here at source rather than overridden from a
  // stylesheet: this <style> is appended to document.head at RUNTIME, i.e.
  // after every <link>, so an equal-specificity rule in dashboard-app.css
  // would lose the cascade on source order.
  s.textContent =
    '.nbd-pin-panel{position:absolute;right:calc(12px + var(--nbd-fab-rail, 94px));bottom:var(--map-band, 88px);z-index:600;background:rgba(10,12,15,.88);'
    + 'border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:9px 10px;font-family:sans-serif;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,.5);backdrop-filter:blur(4px);width:172px;max-height:60vh;overflow:auto;}'
    + '.nbd-pin-panel .npp-lbl{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#9aa4b2;font-weight:700;margin:0 2px 6px;}'
    + '.nbd-pin-panel .npp-chip{display:flex;align-items:center;gap:7px;width:100%;background:none;border:none;padding:3px 4px;border-radius:6px;cursor:pointer;color:#e7ebf0;font-size:12px;text-align:left;}'
    + '.nbd-pin-panel .npp-chip:hover{background:rgba(255,255,255,.07);}'
    + '.nbd-pin-panel .npp-chip.off{opacity:.38;}'
    + '.nbd-pin-panel .npp-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;border:1px solid rgba(255,255,255,.5);}'
    + '.nbd-pin-panel .npp-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '.nbd-pin-panel .npp-cnt{color:#9aa4b2;font-variant-numeric:tabular-nums;}'
    // Phone viewports: mirror the customers panel — narrow + capped, bottom-right,
    // and out of the same FAB rail (the phone stack is the crowded one: dial +
    // mic + capture + inbox all live in that corner under 768px).
    // tests/smoke/maps.test.js:392-395 matches the panel's width:46vw opener
    // within 120 chars of this media-query brace — never reorder these
    // declarations or move the breakpoint; the token swaps land after the width.
    + '@media (max-width:640px){'
    + '.nbd-pin-panel{width:46vw;max-height:46vh;padding:7px 8px;right:calc(8px + var(--nbd-fab-rail, 94px));bottom:var(--map-band, 74px);font-size:11px;}'
    + '.nbd-pin-panel .npp-chip{font-size:11px;}'
    + '.nbd-pin-panel .npp-dot{width:9px;height:9px;}}';
  document.head.appendChild(s);
}
function renderPinDispPanel() {
  if (!mainMap) return;
  const container = mainMap.getContainer && mainMap.getContainer();
  if (!container) return;
  _injectPinPanelCss();
  if (!_pinPanelEl) {
    _pinPanelEl = document.createElement('div');
    _pinPanelEl.className = 'nbd-pin-panel';
    container.appendChild(_pinPanelEl);
    if (L.DomEvent) { L.DomEvent.disableClickPropagation(_pinPanelEl); L.DomEvent.disableScrollPropagation(_pinPanelEl); }
  }
  const esc = _mapsEscHtml;
  const counts = {};
  (window._pins || []).forEach(p => { if (p && p.status) counts[p.status] = (counts[p.status] || 0) + 1; });
  let html = '<div class="npp-lbl">Door Knocks</div>';
  Object.keys(PIN_LABELS).forEach(function (st) {
    const off = (_pinDispFilter && !_pinDispFilter.has(st)) ? ' off' : '';
    html += '<button type="button" class="npp-chip' + off + '" data-pin-disp="' + esc(st) + '">'
      + '<span class="npp-dot" style="background:' + esc(PIN_COLORS[st] || '#9CA3AF') + ';"></span>'
      + '<span class="npp-name">' + esc(PIN_LABELS[st]) + '</span>'
      + '<span class="npp-cnt">' + (counts[st] || 0) + '</span></button>';
  });
  _pinPanelEl.innerHTML = html;
  if (!_pinPanelEl._wired) {
    _pinPanelEl._wired = true;
    _pinPanelEl.addEventListener('click', function (e) {
      const chip = e.target && e.target.closest && e.target.closest('[data-pin-disp]');
      if (!chip) return;
      const st = chip.getAttribute('data-pin-disp');
      const all = Object.keys(PIN_LABELS);
      if (!_pinDispFilter) _pinDispFilter = new Set(all);
      if (_pinDispFilter.has(st)) { if (_pinDispFilter.size > 1) _pinDispFilter.delete(st); } else { _pinDispFilter.add(st); }
      if (_pinDispFilter.size === all.length) _pinDispFilter = null; // all on → no filter
      applyPinDispFilter();
      renderPinDispPanel();
    });
  }
  _pinPanelEl.style.display = '';
}
function hidePinDispPanel() { if (_pinPanelEl) _pinPanelEl.style.display = 'none'; }

// Escape untrusted strings for HTML text AND double-quoted attribute contexts.
// Covers &, <, >, ", ' — the five XSS vectors that matter for innerHTML sinks.
function _mapsEscHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Escape for a single-quoted JS string sitting inside an HTML attribute
// (e.g. onclick="fn('...')"). First neutralise \ and ', then HTML-escape
// so the attribute-value parsing can't be broken either.
function _mapsEscJsInAttr(v) {
  if (v === null || v === undefined) return '';
  const js = String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return _mapsEscHtml(js);
}

function buildPinPopupHTML(p, lead) {
  const esc = _mapsEscHtml;
  const escA = _mapsEscJsInAttr;
  // PIN_COLORS values are all whitelisted hex strings, but fall through esc
  // in case a future status is added with untrusted content.
  const statusColor = PIN_COLORS[p.status] || '#9CA3AF';
  const statusLabel = PIN_LABELS[p.status] || p.status || '';
  if(lead) {
    const name  = ((lead.firstName||'')+ ' ' +(lead.lastName||'')).trim() || lead.address || 'Lead';
    const addr  = (lead.address||'').split(',').slice(0,2).join(',');
    const val   = lead.jobValue ? '$'+parseFloat(lead.jobValue).toLocaleString() : '—';
    const stage = lead.stage || 'New';
    const dmg   = lead.damageType || '—';
    const claim = lead.claimStatus || '—';
    return `<div class="pin-lead-popup">
      <div class="plp-header">
        <div class="plp-status"><span style="width:8px;height:8px;border-radius:50%;background:${esc(statusColor)};display:inline-block;"></span>${esc(statusLabel)}</div>
        <div class="plp-name">${esc(name)}</div>
        <div class="plp-addr">${esc(addr)}</div>
      </div>
      <div class="plp-body">
        <div class="plp-row"><span class="plp-key">Stage</span><span class="plp-val">${esc(stage)}</span></div>
        <div class="plp-row"><span class="plp-key">Damage</span><span class="plp-val">${esc(dmg)}</span></div>
        <div class="plp-row"><span class="plp-key">Claim</span><span class="plp-val">${esc(claim)}</span></div>
        <div class="plp-row"><span class="plp-key">Value</span><span class="plp-val" style="color:var(--green);">${esc(val)}</span></div>
        ${p.notes ? `<div class="plp-row"><span class="plp-key">Notes</span><span class="plp-val">${esc(p.notes)}</span></div>` : ''}
      </div>
      <div class="plp-btns">
        <button class="plp-btn-go" data-mo-action="goToLeadFromPin" data-mo-id="${escA(lead.id)}">→ Go to Lead</button>
        <button class="plp-btn-del" data-mo-action="deleteLeadFromPin" data-mo-id="${escA(lead.id)}" data-mo-name="${escA(name)}">🗑 Delete Lead</button>
      </div>
    </div>`;
  } else {
    return `<div class="pin-lead-popup">
      <div class="plp-header">
        <div class="plp-status"><span style="width:8px;height:8px;border-radius:50%;background:${esc(statusColor)};display:inline-block;"></span>${esc(statusLabel)}</div>
        <div class="plp-name">No lead linked</div>
        <div class="plp-addr">${esc(p.notes || 'No notes')}</div>
      </div>
      <div class="plp-btns">
        <button class="plp-btn-go" data-mo-action="makeLeadFromPin" data-mo-id="${escA(p.id)}">＋ Create Lead Here</button>
        <button class="plp-btn-del" data-mo-action="deletePinOnly" data-mo-id="${escA(p.id)}">🗑 Delete Pin</button>
      </div>
    </div>`;
  }
}

function openPinLeadPopup(p, marker) {
  const leads = window._leads || [];
  let matched = null;

  // NEW: Match by leadId if available (from auto-pinned leads)
  if (p.leadId) {
    matched = leads.find(l => l.id === p.leadId);
  }

  // FALLBACK: Match by address proximity or notes (old pins)
  if (!matched) {
    const pinLat = parseFloat(p.lat), pinLng = parseFloat(p.lng);

    // Try matching notes → address. Require a street-number prefix match
    // before checking substring so "123 Main" doesn't false-match a lead
    // at "23 Main" or "1234 Main". Extract the leading numeric token from
    // the first address segment and require both that number AND the rest
    // of the segment to appear in notes.
    if (p.notes) {
      const notesLower = p.notes.toLowerCase();
      matched = leads.find(l => {
        const addr = String(l.address || '').toLowerCase();
        if (!addr) return false;
        const firstSeg = addr.split(',')[0].trim();
        const numMatch = firstSeg.match(/^(\d+)\s+(.+)$/);
        if (numMatch) {
          const [, num, rest] = numMatch;
          // Word-boundary on the street number prevents "23" matching "123".
          const numRe = new RegExp('\\b' + num + '\\b');
          return numRe.test(notesLower) && notesLower.includes(rest);
        }
        // No leading number — fall back to literal substring.
        return notesLower.includes(firstSeg);
      });
    }

    // Try reverse: lead address geocache match by lat/lng proximity (< 50m)
    if (!matched) {
      matched = leads.find(l => {
        if (!l.lat || !l.lng) return false;
        const dlat = Math.abs(parseFloat(l.lat) - pinLat);
        const dlng = Math.abs(parseFloat(l.lng) - pinLng);
        return dlat < 0.0005 && dlng < 0.0005;
      });
    }
  }

  const popupHTML = buildPinPopupHTML(p, matched);
  const popup = marker.bindPopup(popupHTML, {
    maxWidth: 280, minWidth: 220,
    className: 'nbd-pin-popup',
    closeButton: true
  }).openPopup();

  // NEW: Add click handler to open card detail modal
  if (matched && matched.id) {
    popup.on('popupopen', () => {
      const popupEl = document.querySelector('.nbd-pin-popup');
      if (popupEl) {
        popupEl.style.cursor = 'pointer';
        popupEl.addEventListener('click', () => {
          goTo('crm');
          setTimeout(() => openCardDetailModal(matched.id), 300);
        });
      }
    });
  }
}

function goToLeadFromPin(leadId) {
  // Close any open popup
  if(mainMap) mainMap.closePopup();
  // Navigate to CRM, then highlight the lead card
  goTo('crm');
  setTimeout(()=>{
    const card = document.querySelector(`.k-card[data-id="${leadId}"]`);
    if(card) {
      card.scrollIntoView({behavior:'smooth', block:'center'});
      card.style.outline = '2px solid var(--orange)';
      card.style.outlineOffset = '2px';
      setTimeout(()=>{ card.style.outline=''; card.style.outlineOffset=''; }, 2500);
    }
  }, 350);
}

function deleteLeadFromPin(leadId, leadName, btnEl) {
  if(mainMap) mainMap.closePopup();
  showDeleteConfirm(leadId, leadName);
}

function makeLeadFromPin(pinId) {
  if(mainMap) mainMap.closePopup();
  const pin = window._pins?.find(p=>p.id===pinId);
  openLeadModal();
  setTimeout(()=>{
    const fill = (id, val) => { const el = document.getElementById(id); if(el && val) el.value = val; };
    if(pin) {
      // Carry address from pin
      fill('lAddr', pin.address || pin.name || '');
      // Carry name if available
      if(pin.name && pin.name !== pin.address) {
        const parts = pin.name.split(' ');
        fill('lFname', parts[0] || '');
        fill('lLname', parts.slice(1).join(' ') || '');
      }
      // Carry notes
      fill('lNotes', pin.notes || '');
      // Set source to map pin
      const srcEl = document.getElementById('lSource');
      if(srcEl) {
        const opt = Array.from(srcEl.options).find(o => o.value.toLowerCase().includes('door') || o.value.toLowerCase().includes('map'));
        if(opt) srcEl.value = opt.value;
      }
      // Store pin reference so _saveLead can link them
      window._pendingPinId = pinId;
      window._pendingPinLatLng = { lat: pin.lat, lng: pin.lng };
    }
    document.getElementById('lFname')?.focus();
  }, 100);
}

function deletePinOnly(pinId) {
  if(mainMap) mainMap.closePopup();
  deletePin(pinId);
}

function selectPin(status,color,el) {
  document.querySelectorAll('.pin-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  curPinStatus=status; curPinColor=color;
  document.getElementById('mapBadge').textContent='📍 '+(PIN_LABELS[status]||status).toUpperCase();
}
async function deletePin(id) {
  // Confirm the server delete BEFORE removing the marker. Pins are now
  // team-visible, so a manager/viewer can click Delete on a teammate's pin — the
  // /pins delete rule denies it, and an optimistic removal would silently
  // reappear on reload (the same bug fixed for zones). Only remove on success.
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  const ok = (_nbdReg && typeof _nbdReg._deletePin === 'function') ? await _nbdReg._deletePin(id) : false;
  if (!ok) { if (typeof showToast === 'function') showToast('Could not delete — only the pin owner or a company admin can remove it', 'error'); return; }
  if (pinMarkers[id]) { if (pinClusterGroup) pinClusterGroup.removeLayer(pinMarkers[id]); else mainMap.removeLayer(pinMarkers[id]); delete pinMarkers[id]; }
  refreshHeatLayer();
}
function clearAllPins() { if(pinClusterGroup){pinClusterGroup.clearLayers();}else{Object.values(pinMarkers).forEach(m=>mainMap.removeLayer(m));} pinMarkers={}; }

async function searchMap() {
  const searchEl = document.getElementById('mapSearch');
  const q = searchEl ? searchEl.value.trim() : '';
  if(!q)return;
  hideAcDrop('mapSearch');
  const data=await geocode(q); if(!data) return;
  mainMap.setView([data.lat,data.lon],19);
  window._lastMapSearch = data;
  const parts = data.display_name.split(',');
  const shortAddr = parts.slice(0,3).join(',').trim();
  // Show loading state immediately
  const propCard = document.getElementById('propCard');
  const propInner = document.getElementById('propCardInner');
  if (propCard) propCard.style.display='block';
  if (propInner) propInner.innerHTML=`
    <div class="pi-card">
      <div class="pi-header"><span class="pi-title">🏠 Property Intel</span><span class="pi-county"></span></div>
      <div class="pi-loading"><div class="pi-spinner"></div>Estimating property profile...</div>
    </div>
    <button class="make-lead-btn" data-mo-action="makeLeadFromSearch">＋ Make This a Lead</button>`;
  // Fire intel lookup
  fetchPropertyIntel(data, 'propCardInner');
}
window.searchMap = searchMap;

window.makeLeadFromSearch = makeLeadFromSearch;
function makeLeadFromSearch() {
  const d = window._lastMapSearch;
  if(!d) return;
  const a = d.address || {};
  // Build clean address string
  const num   = a.house_number || '';
  const road  = a.road || a.street || '';
  const city  = a.city || a.town || a.village || a.county || '';
  const state = a.state_code || a.state || '';
  const zip   = a.postcode || '';
  const addrStr = [num+' '+road, city, state+' '+zip].map(s=>s.trim()).filter(Boolean).join(', ');
  // Open lead modal and pre-fill
  openLeadModal();
  setTimeout(()=>{
    if(addrStr) document.getElementById('lAddr').value = addrStr;
    // Source default = Door Knock since they're on the map
    const srcEl = document.getElementById('lSource');
    if(srcEl) srcEl.value = 'Door Knock';
    // Pre-fill notes with full address context
    const notesEl = document.getElementById('lNotes');
    if(notesEl && !notesEl.value) {
      notesEl.value = `Map search: ${d.display_name}`;
    }
    // Focus first name so they can type right away
    document.getElementById('lFname')?.focus();
  }, 80);
}

function damagNearMe() {
  if (!navigator.geolocation) { showToast('Location not supported by this browser', 'error'); return; }
  showToast('Getting location...');
  navigator.geolocation.getCurrentPosition(
    (p) => { if (mainMap) mainMap.setView([p.coords.latitude, p.coords.longitude], 15); },
    (err) => {
      // Differentiate the three PositionError codes so the user knows what
      // to do next instead of seeing a generic "unavailable" for a denied
      // permission vs. a timeout vs. an iframe block.
      if (err && err.code === 1) showToast('Location permission denied — enable it in browser settings', 'error');
      else if (err && err.code === 3) showToast('Location timed out — try again', 'error');
      else showToast('Location unavailable', 'error');
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}
// Registry-first dispatch (dashboard-ui.js resolves __NBD_CALL_REGISTRY before
// the allowlisted window fallback). This is the ONLY damagNearMe — the three
// aliases that shadowed it (dashboard-actions.js ×2, maps.js ×1, all pointing
// "📍 My Location" at spyglassGoToLocation) were deleted 2026-08-07, restoring
// the per-PositionError messaging above.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  damagNearMe: damagNearMe
});


// CSP-safe delegation for 5 data-mo-action attrs (maps overlays — pin popups).
(function () {
  if (_NBD_MO_DELEGATE_BOUND) return;
  _NBD_MO_DELEGATE_BOUND = true;
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-mo-action]');
    if (!t) return;
    const action = t.dataset.moAction;
    const id = t.dataset.moId;
    const name = t.dataset.moName;
    try {
      switch (action) {
        case 'goToLeadFromPin': if (typeof goToLeadFromPin === 'function') goToLeadFromPin(id); break;
        case 'deleteLeadFromPin': if (typeof deleteLeadFromPin === 'function') deleteLeadFromPin(id, name, t); break;
        case 'makeLeadFromPin':  if (typeof makeLeadFromPin === 'function') makeLeadFromPin(id); break;
        case 'deletePinOnly':    if (typeof deletePinOnly === 'function') deletePinOnly(id); break;
        case 'makeLeadFromSearch': if (typeof makeLeadFromSearch === 'function') makeLeadFromSearch(); break;
        default: console.warn('[maps-overlays] no dispatch for', action);
      }
    } catch (e) { console.error('[maps-overlays] dispatch ' + action + ' failed:', e); }
  });
})();
