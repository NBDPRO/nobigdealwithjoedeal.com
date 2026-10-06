/* @generated — extracted from inline <script> by audit-homeowner-2026-05-22.
   Hash: 4053149b2f.

   2026-09-04 correction to that header: "Do not edit by hand" is no longer
   true and following it costs a session. This was a ONE-TIME extraction to
   satisfy the CSP no-inline-script rule — nothing regenerates it (`grep -rn
   4053149b2f scripts/ site-src/` returns zero), there is no source to edit
   instead, and the file has been hand-maintained since. Edit it here. */
/* ── Configuration ── */
const CONFIG = {
  GOOGLE_MAPS_KEY: '', // Add your Google Maps Static API key here
  PROXY_URL: 'https://us-central1-nobigdeal-pro.cloudfunctions.net/publicFunnelAI',
  // Read-only: hands back the aerial measurement the server took when this
  // lead was created. Spends nothing — see functions/integrations/public-measure.js.
  MEASURE_URL: 'https://us-central1-nobigdeal-pro.cloudfunctions.net/publicRoofMeasure',
  JOE_PHONE: '8594207382',
  // OFF since 2026-10-03. The text-code check kept Submit disabled until the
  // phone was verified (only a small "Skip verification" link got past it),
  // the funnel produced 3 leads EVER, and the Twilio account is a trial that
  // has delivered 0 texts — so the code most visitors waited for never came.
  // The spam defence is Turnstile + the honeypot + the per-IP rate limit in
  // submitPublicLead, which never required a verified phone. The code path
  // below stays intact: set this to true and _applyOtpMode() shows the Send
  // Code button + skip link again and Submit waits for verification.
  OTP_ENABLED: false
};

/* ── State ── */
// Generate a stable per-session funnelId for abandoned-funnel recovery.
// Uses crypto.randomUUID where available (all modern browsers over HTTPS)
// and falls back to a Math.random hex ID on older runtimes.
const _funnelId = (function () {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch (e) {}
  return 'f_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
})();
let _lastProgressEmail = '';

let currentStep = 1;
let funnelData = {
  address: '',
  addressFull: null,
  lat: null,
  lon: null,
  service: '',
  roofType: 'asphalt',
  homeSize: 'typical',     // small | typical | large | not_sure
  timeline: '',
  insuranceClaim: null,    // null | true | false (storm-damage only)
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  phoneVerified: false,
  // Set when the homeowner chose "Use my address as typed" after the map
  // lookup found nothing: the satellite step is skipped and no lat/lon is sent.
  addressTyped: '',
  ballpark: { min: 0, max: 0 },
  estimate: null
};

/* ── Per-step analytics (2026-10-03) ──
   The funnel emitted nothing between landing and the final lead, so a drop-off
   could not be located. GA4 only, through trackEvent's gtag guard — the same
   path as every other event on this page (GA ignores DNT here exactly as it
   already does for generate_lead; Clarity keeps its own DNT/GPC gate). No PII. */
const STEP_NAMES = { 1: 'address', 2: 'confirm_home', 3: 'project', 4: 'ballpark', 5: 'contact', 6: 'results' };
function trackStep(step) {
  trackEvent('funnel_step', { step: step, step_name: STEP_NAMES[step] || String(step) });
}

/* ── Unified pricing model — single source of truth ──
 * Per-square pricing for shingles ($/square = 100 sqft of roof).
 * Tier midpoint of "Better" (architectural) drives the ballpark range
 * shown on step 4; AI estimate + fallback use the same numbers so the
 * homeowner never sees a price drop or jump between screens.
 * Rates: Greater Cincinnati / N. Kentucky / SE Indiana market, Q2 2026.
 */
const PRICING = {
  // $/square installed (1 square = 100 sq ft of roof)
  roof: {
    // Asphalt is locked to the CRM spec (source: docs/pro/js/estimate-config.js):
    // TIER_RATES $550 / $660 / $770 per square (good/better/best — repriced
    // 2026-10-02; the CRM-only economy/beyond tiers are never shown here) with
    // the CRM's pitch-based waste factor (1.12 low-slope … 1.25 steep) baked in.
    // Each range spans rate×1.12 .. rate×1.25, to the nearest $5 (half up):
    //   good   550×1.12=616    .. 550×1.25=687.5  → [615, 690]
    //   better 660×1.12=739.2  .. 660×1.25=825    → [740, 825]
    //   best   770×1.12=862.4  .. 770×1.25=962.5  → [860, 965]
    // Do not edit without updating the locked CRM spec too.
    asphalt: { good: [615, 690],  better: [740, 825],  best: [860, 965] },
    // Metal/flat are market-rate placeholders — NOT CRM-locked.
    metal:   { good: [900, 1100], better: [1100, 1400], best: [1400, 1800] },
    flat:    { good: [400, 500],  better: [500, 650],  best: [650, 850] }
  },
  // Roof repair = scope-based, not size-based
  roofRepair: {
    asphalt: [350, 2500],
    metal:   [500, 3500],
    flat:    [300, 2000],
    other:   [350, 2500]
  },
  // Siding $/sq ft of wall
  siding: {
    vinyl:        { good: [4.5, 6.5], better: [6.5, 9],   best: [9, 12] },
    fiber_cement: { good: [8, 11],    better: [11, 14],   best: [14, 18] },
    wood:         { good: [7, 10],    better: [10, 13],   best: [13, 17] }
  },
  sidingRepair: [400, 3500],
  // Gutters $/linear ft installed
  gutters: {
    aluminum: [9, 14],
    seamless: [12, 22]
  },
  // Storm damage routed through insurance — homeowner pays deductible only
  stormDeductible: [500, 2500]
};

// Roof squares (100 sqft) by home-size tile
const SIZE_SQUARES = { small: 14, typical: 20, large: 30, not_sure: 20 };
// Approximate exterior wall sqft for siding (single-story * perimeter * ~9ft)
const SIZE_WALL_SQFT = { small: 1100, typical: 1700, large: 2700, not_sure: 1700 };
// Approximate gutter linear feet
const SIZE_GUTTER_LF = { small: 130, typical: 200, large: 300, not_sure: 200 };
// Human label
const SIZE_LABEL = { small: 'Small (~1,200 sq ft)', typical: 'Typical (~2,000 sq ft)', large: 'Large (~3,000 sq ft)', not_sure: 'Joe will measure' };
// Service display labels — shared by ballpark factors, results, and email summary
const SERVICE_LABELS = {
  'roof-replacement':   'Roof Replacement',
  'roof-repair':        'Roof Repair',
  'siding-replacement': 'Siding Replacement',
  'siding-repair':      'Siding Repair',
  'gutter-replacement': 'Gutter Replacement',
  'storm-damage':       'Storm Damage'
};
// Short word for the results headline ("<Name>'s <kind> Estimate")
const RESULT_KIND = {
  'roof-replacement':   'Roof',
  'roof-repair':        'Roof Repair',
  'siding-replacement': 'Siding',
  'siding-repair':      'Siding Repair',
  'gutter-replacement': 'Gutter',
  'storm-damage':       'Storm Damage'
};

// Round to the CRM's $25 grand-total step (ROUND_TO_DOLLARS in the locked
// spec, docs/pro/js/estimate-config.js). Reused by priceRangeForFunnel()
// and buildFallbackEstimate() so every surface shows the same numbers.
function roundTo25(n) {
  return Math.round(n / 25) * 25;
}

/* ── Monthly-payment framing on the results card ──
 * Same published Acorn marketplace APR band and amortization formula as
 * /services/financing (financing-estimator.js) so both surfaces always show
 * identical numbers. Illustration only — the on-page small print carries the
 * not-an-offer disclosure. Hidden for storm claims (the range shown there is
 * a deductible, which keeps its own framing) and for sub-$3k projects
 * (financing-page FAQ: financing generally fits $3,000+). */
const FIN_APR_LO = 0.1149, FIN_APR_HI = 0.1999, FIN_TERM_MONTHS = 120, FIN_MIN_PROJECT = 3000;
function finPay(P, apr, n) { const r = apr / 12; return P * r / (1 - Math.pow(1 + r, -n)); }
function renderMonthlyLine(min, max) {
  const wrap = document.getElementById('resultMonthly');
  if (!wrap) return;
  if (funnelData.service === 'storm-damage' || !min || min < FIN_MIN_PROJECT) {
    wrap.hidden = true;
    return;
  }
  const lo = Math.round(finPay(min, FIN_APR_LO, FIN_TERM_MONTHS));
  const hi = Math.round(finPay(max, FIN_APR_HI, FIN_TERM_MONTHS));
  document.getElementById('resultMonthlyFigs').textContent =
    '$' + lo.toLocaleString('en-US') + ' – $' + hi.toLocaleString('en-US');
  wrap.hidden = false;
}

/* ── Progress Bar ── */
function updateProgress(step) {
  const pct = ((step - 1) / 4) * 100;
  document.getElementById('progressFill').style.width = pct + '%';
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById('dot' + i);
    const lbl = document.getElementById('lbl' + i);
    dot.classList.remove('active', 'done');
    lbl.classList.remove('active', 'done');
    if (i < step) { dot.classList.add('done'); lbl.classList.add('done'); dot.innerHTML = '&#10003;'; }
    else if (i === step) { dot.classList.add('active'); lbl.classList.add('active'); dot.textContent = i; }
    else { dot.textContent = i; }
  }
}

/* ── Step Navigation ── */
function goToStep(step) {
  // Validate before advancing
  if (step > currentStep) {
    if (!validateStep(currentStep)) return;
  }
  // A typed (unmatched) address has no map to confirm: forward skips the
  // satellite step, and Back from step 3 returns to the address.
  if (step === 2 && funnelData.addressTyped) step = currentStep > 2 ? 1 : 3;

  // Hide all steps
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));

  // Special: if going to step 2, load satellite
  if (step === 2) loadSatellite();

  // Special: if going to step 4, calculate ballpark
  if (step === 4) calculateBallpark();

  // Show target step
  const target = document.getElementById('step' + step);
  if (target) {
    target.classList.add('active');
    currentStep = step;
    updateProgress(step);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    trackStep(step);
  }
}

function validateStep(step) {
  if (step === 1) {
    const inp = document.getElementById('addressInput');
    const addr = inp.value.trim();
    if (!addr || addr.length < 5) {
      inp.parentElement.classList.add('has-error');
      inp.setAttribute('aria-invalid', 'true');
      inp.focus();
      _setAddressHint("Type your street address, then tap Continue.");
      return false;
    }
    // "Use my address as typed" (no map match): continue on the words alone.
    if (funnelData.addressTyped && funnelData.addressTyped === addr) {
      funnelData.address = addr;
      funnelData.lat = null;
      funnelData.lon = null;
      return true;
    }
    // Require a geocoded selection so step 2's satellite map can resolve.
    // If user typed without picking from dropdown, attempt a single resolve
    // before allowing them to advance.
    if (!funnelData.addressFull) {
      _resolveAddressInline(addr);
      return false;
    }
    funnelData.address = addr;
    funnelData.lat = parseFloat(funnelData.addressFull.lat);
    funnelData.lon = parseFloat(funnelData.addressFull.lon);
    return true;
  }
  if (step === 3) {
    return funnelData.service && funnelData.timeline;
  }
  return true;
}

function _setAddressHint(msg) {
  let el = document.getElementById('addressHint');
  if (!el) {
    el = document.createElement('div');
    el.id = 'addressHint';
    el.style.cssText = 'margin-top:10px;font-size:.78rem;color:rgba(255,255,255,.7);text-align:center;';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const inp = document.getElementById('addressInput');
    inp.parentElement.parentElement.appendChild(el);
  }
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

/* The map lookup is a convenience, never a gate (2026-10-03): when it found
   nothing — new builds, rural routes, a typo — the homeowner could not get
   past step 1 at all. Offer "Use my address as typed", which skips the
   satellite step; Joe confirms the address when he calls. */
function _offerTypedAddress(msg, reason) {
  _setAddressHint(msg);
  var el = document.getElementById('addressHint');
  if (!el) return;
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-use-typed';
  b.id = 'btnUseTyped';
  b.setAttribute('data-action', 'useTypedAddress');
  b.textContent = 'Use my address as typed →';
  el.appendChild(document.createElement('br'));
  el.appendChild(b);
  trackEvent('funnel_address_unmatched', { reason: reason });
}

function useTypedAddress() {
  var addr = addrInput.value.trim();
  if (!addr || addr.length < 5) { validateStep(1); return; }
  funnelData.addressFull = null;
  funnelData.addressTyped = addr;
  acDrop.style.display = 'none';
  _setAddressHint('');
  trackEvent('funnel_address_typed', {});
  goToStep(3);
}

async function _resolveAddressInline(q) {
  _setAddressHint("Looking up that address…");
  try {
    const data = await _geocodeOnce(q);
    if (!data || !data.length) {
      _offerTypedAddress("We couldn't find that address on the map. Check it, or continue with it as typed.", 'no_match');
      return;
    }
    // Use the top match
    window._acResults = data;
    selectAddr(0);
    _setAddressHint("");
    setTimeout(function () { goToStep(2); }, 100);
  } catch (e) {
    _offerTypedAddress("The map lookup isn't responding. You can continue with your address as typed.", 'lookup_error');
  }
}

/* ── Address lookup (Nominatim) — on blur or Continue, never per keystroke ──
   The public Nominatim server's usage policy forbids autocomplete-as-you-type
   (max 1 request/second; no client-side autocomplete). Until 2026-10-03 this
   fired a search 350ms after every pause in typing. Now: one lookup when the
   field loses focus (debounced), or when Continue/Enter is pressed — and each
   distinct address string is looked up at most once per page (_geocodeOnce). */
let _debounceTimer = null;
const addrInput = document.getElementById('addressInput');
const acDrop = document.getElementById('acDrop');

addrInput.addEventListener('input', function() {
  this.parentElement.classList.remove('has-error');
  this.setAttribute('aria-invalid', 'false');
  clearTimeout(_debounceTimer);
  // Editing invalidates an earlier pick / "as typed" choice for another string.
  const q = this.value.trim();
  if (funnelData.addressFull && q !== funnelData.address) funnelData.addressFull = null;
  if (funnelData.addressTyped && q !== funnelData.addressTyped) funnelData.addressTyped = '';
  acDrop.style.display = 'none';
  this.setAttribute('aria-expanded', 'false');
});

addrInput.addEventListener('blur', function() {
  clearTimeout(_debounceTimer);
  const q = this.value.trim();
  if (q.length < 5 || funnelData.addressFull || funnelData.addressTyped) return;
  _debounceTimer = setTimeout(() => searchAddress(q), 400);
});

// Keyboard path for the autocomplete: the dropdown items are divs, so
// without ArrowUp/Down + Enter handling a keyboard/screen-reader user could
// only rely on the typed-top-match fallback, never an explicit pick.
let _acKbIdx = -1;
addrInput.setAttribute('role', 'combobox');
addrInput.setAttribute('aria-autocomplete', 'list');
addrInput.setAttribute('aria-expanded', 'false');
addrInput.setAttribute('aria-controls', 'acDrop');
acDrop.setAttribute('role', 'listbox');
function _acMarkActive(items) {
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('kb-active', i === _acKbIdx);
    items[i].setAttribute('aria-selected', i === _acKbIdx ? 'true' : 'false');
  }
  addrInput.setAttribute('aria-activedescendant', _acKbIdx >= 0 ? 'ac-opt-' + _acKbIdx : '');
}
addrInput.addEventListener('keydown', function(e) {
  var open = acDrop.style.display === 'block';
  var items = open ? acDrop.querySelectorAll('.ac-item') : [];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open || !items.length) return;
    e.preventDefault();
    _acKbIdx = e.key === 'ArrowDown'
      ? (_acKbIdx + 1) % items.length
      : (_acKbIdx <= 0 ? items.length - 1 : _acKbIdx - 1);
    _acMarkActive(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && items.length) { selectAddr(_acKbIdx >= 0 ? _acKbIdx : 0); }
    else { goToStep(2); } // existing typed-top-match fallback via validateStep
  } else if (e.key === 'Escape') {
    acDrop.style.display = 'none';
    addrInput.setAttribute('aria-expanded', 'false');
    _acKbIdx = -1;
  }
});

// Greater Cincinnati metro bbox (lon_min, lat_max, lon_max, lat_min — Nominatim viewbox order).
// Covers SW Ohio, Northern Kentucky, and SE Indiana — matches our service-area pages.
const _NOMI_VIEWBOX = '-85.2,39.5,-83.6,38.6';

// One request per distinct address string per page — blur, Continue and the
// dropdown all share the same answer instead of re-asking the public server.
const _geoCache = {};
function _geocodeOnce(q) {
  const key = String(q || '').trim().toLowerCase();
  if (!_geoCache[key]) {
    _geoCache[key] = _nominatimQuery(q).catch(function (e) { delete _geoCache[key]; throw e; });
  }
  return _geoCache[key];
}

async function _nominatimQuery(q) {
  // Bias toward Cincinnati metro but allow outside results (bounded=0) so a homeowner
  // who just moved still finds their address.
  const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
    '&format=json&addressdetails=1&countrycodes=us&limit=5' +
    '&viewbox=' + encodeURIComponent(_NOMI_VIEWBOX) + '&bounded=0';
  const res = await fetch(url);
  if (!res.ok) throw new Error('geocode-failed');
  return res.json();
}

let _searchSeq = 0;
async function searchAddress(q) {
  const myReq = ++_searchSeq;
  try {
    const data = await _geocodeOnce(q);
    // Drop stale responses if the user kept typing.
    if (myReq !== _searchSeq) return;
    if (!data.length) { acDrop.style.display = 'none'; return; }
    acDrop.innerHTML = data.map(function(d, i) {
      const safe = String(d.display_name || '').replace(/[<>]/g, '');
      return '<div class="ac-item" role="option" id="ac-opt-' + i + '" aria-selected="false" data-idx="' + i + '">' + safe + '</div>';
    }).join('');
    acDrop.style.display = 'block';
    addrInput.setAttribute('aria-expanded', 'true');
    _acKbIdx = -1;
    window._acResults = data;
  } catch(e) {
    if (myReq !== _searchSeq) return;
    acDrop.style.display = 'none';
  }
}

function selectAddr(idx) {
  const d = window._acResults[idx];
  if (!d) return;
  addrInput.value = d.display_name;
  funnelData.addressFull = d;
  funnelData.address = d.display_name;
  funnelData.lat = parseFloat(d.lat);
  funnelData.lon = parseFloat(d.lon);
  acDrop.style.display = 'none';
  addrInput.setAttribute('aria-expanded', 'false');
  addrInput.setAttribute('aria-activedescendant', '');
  _acKbIdx = -1;
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.input-group')) acDrop.style.display = 'none';
});

/* ── Satellite Image ── */
function loadSatellite() {
  const img = document.getElementById('satelliteImg');
  const placeholder = document.getElementById('satellitePlaceholder');
  const addrLabel = document.getElementById('satelliteAddress');

  addrLabel.textContent = funnelData.address;

  // Prefer Google Static Maps if a key is configured (best imagery quality)
  if (CONFIG.GOOGLE_MAPS_KEY && funnelData.lat && funnelData.lon) {
    const url = 'https://maps.googleapis.com/maps/api/staticmap?center=' +
      funnelData.lat + ',' + funnelData.lon +
      '&zoom=19&size=600x400&maptype=satellite' +
      '&markers=color:red%7C' + funnelData.lat + ',' + funnelData.lon +
      '&key=' + CONFIG.GOOGLE_MAPS_KEY;
    img.src = url;
    img.onload = function() {
      placeholder.style.display = 'none';
      img.style.display = 'block';
    };
    img.onerror = renderLeafletSatellite;
    return;
  }
  renderLeafletSatellite();
}

// Render an interactive satellite map (Esri World Imagery via Leaflet) with a pin
function renderLeafletSatellite() {
  const placeholder = document.getElementById('satellitePlaceholder');
  if (!funnelData.lat || !funnelData.lon) {
    placeholder.innerHTML =
      '<div class="icon">&#127968;</div>' +
      '<div style="font-size:.85rem;font-weight:600;color:var(--white);margin-bottom:4px;">Address Found</div>' +
      '<div style="font-size:.75rem;color:rgba(255,255,255,.55);">Satellite view temporarily unavailable.</div>';
    return;
  }

  placeholder.style.padding = '0';
  placeholder.innerHTML =
    '<div id="leafletMap" role="img" aria-label="Satellite view of your property"></div>' +
    '<div class="satellite-meta">' +
      '<div class="coords">Coordinates: ' + funnelData.lat.toFixed(4) + ', ' + funnelData.lon.toFixed(4) + '</div>' +
      '<div class="verified">&#10003; Address verified</div>' +
    '</div>';

  if (typeof L === 'undefined') {
    loadLeafletAssets(initLeafletMap);
  } else {
    initLeafletMap();
  }
}

function loadLeafletAssets(cb) {
  if (!document.getElementById('leaflet-css')) {
    const css = document.createElement('link');
    css.id = 'leaflet-css';
    css.rel = 'stylesheet';
    css.href = '/assets/vendor/leaflet/leaflet.css';
    css.crossOrigin = '';
    document.head.appendChild(css);
  }
  if (!document.getElementById('leaflet-js')) {
    const js = document.createElement('script');
    js.id = 'leaflet-js';
    js.src = '/assets/vendor/leaflet/leaflet.js';
    js.crossOrigin = '';
    js.onload = cb;
    js.onerror = function() {
      const ph = document.getElementById('satellitePlaceholder');
      ph.style.padding = '40px 20px';
      ph.innerHTML =
        '<div class="icon">&#128506;</div>' +
        '<div style="font-size:.9rem;font-weight:700;color:var(--white);">Property Located</div>' +
        '<div style="font-size:.78rem;color:rgba(255,255,255,.55);margin-top:4px;">Coordinates: ' + funnelData.lat.toFixed(4) + ', ' + funnelData.lon.toFixed(4) + '</div>' +
        '<div style="margin-top:12px;padding:8px 16px;border:1px solid rgba(34,160,107,.4);border-radius:8px;background:rgba(34,160,107,.1);font-size:.75rem;font-weight:600;color:var(--success);">&#10003; Address verified</div>';
    };
    document.head.appendChild(js);
  } else {
    cb();
  }
}

function initLeafletMap() {
  const lat = funnelData.lat;
  const lon = funnelData.lon;
  const map = L.map('leafletMap', {
    center: [lat, lon],
    zoom: 19,
    zoomControl: true,
    scrollWheelZoom: false,
    dragging: true,
    doubleClickZoom: true,
    touchZoom: true
  });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery &copy; Esri',
    maxZoom: 20,
    maxNativeZoom: 19
  }).addTo(map);
  // Orange pin matching brand
  const orangePin = L.divIcon({
    className: 'nbd-map-pin',
    html: '<div style="width:24px;height:24px;background:#bd5728;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.5);transform:translate(-50%,-50%);"></div>',
    iconSize: [24, 24],
    iconAnchor: [0, 0]
  });
  L.marker([lat, lon], { icon: orangePin, keyboard: false }).addTo(map);
}

// Legacy alias — original callsite name retained
function showSatelliteFallback() {
  renderLeafletSatellite();
}

/* ── Tile Selection ── */
function selectTile(el, group) {
  // Deselect others in same group
  const parent = el.closest('.tiles');
  parent.querySelectorAll('.tile').forEach(function(t) { t.classList.remove('selected'); t.setAttribute('aria-pressed', 'false'); });
  el.classList.add('selected');
  el.setAttribute('aria-pressed', 'true');

  const value = el.getAttribute('data-value');

  if (group === 'service') {
    funnelData.service = value;
    // Show roof type for roofing services
    const roofGroup = document.getElementById('roofTypeGroup');
    if (value === 'roof-replacement' || value === 'roof-repair') {
      roofGroup.style.display = 'block';
    } else {
      roofGroup.style.display = 'none';
      funnelData.roofType = 'asphalt'; // default
    }
  } else if (group === 'roofType') {
    funnelData.roofType = value;
  } else if (group === 'homeSize') {
    funnelData.homeSize = value;
  } else if (group === 'timeline') {
    funnelData.timeline = value;
  }

  // Enable/disable next button — service, size, and timeline all required
  document.getElementById('btnStep3').disabled = !(funnelData.service && funnelData.homeSize && funnelData.timeline);
}

/* ── Ballpark Calculation ──
 * Drives step-4 ballpark. Always uses the unified PRICING model so the
 * range you see on step 4 is consistent with the AI estimate and fallback
 * shown on step 5+.
 */
function calculateBallpark() {
  var size = funnelData.homeSize || 'typical';
  var range = priceRangeForFunnel(size);
  funnelData.ballpark = { min: range.min, max: range.max };

  // Update ballpark reveal DOM
  var fmt = function (n) { return '$' + n.toLocaleString('en-US'); };
  var priceEl = document.getElementById('ballparkPrice');
  if (priceEl) {
    priceEl.innerHTML = fmt(range.min) + ' <span>&#8211; ' + fmt(range.max) + '</span>';
  }

  // Reframe context line so homeowner doesn't expect the next screen to match exactly
  var contextEl = document.getElementById('ballparkContext');
  if (contextEl) {
    var serviceKey = funnelData.service;
    if (serviceKey === 'storm-damage') {
      contextEl.textContent = 'Typical out-of-pocket if going through insurance — your deductible. Insurance covers the rest.';
    } else if (serviceKey === 'roof-replacement') {
      contextEl.textContent = 'Architectural-shingle range for a ' + sizeShortLabel(size) + ' home in your area. The next step shows tier-by-tier pricing once we have your details.';
    } else {
      contextEl.textContent = 'Typical range for a ' + sizeShortLabel(size) + ' home in your area. The next step shows the detailed breakdown.';
    }
  }

  // Factor cards
  var timelineLabels = {
    'asap':        'ASAP',
    'few-weeks':   'Next Few Weeks',
    '1-3-months':  '1-3 Months',
    'exploring':   'Just Exploring'
  };
  var materialLabels = {
    asphalt:      'Asphalt Shingles',
    metal:        'Metal',
    flat:         'Flat / Low-slope',
    other:        'Mixed / Not Sure',
    vinyl:        'Vinyl Siding',
    fiber_cement: 'Fiber Cement',
    wood:         'Wood',
    aluminum:     'Aluminum Gutters',
    seamless:     'Seamless K-Style'
  };

  var bpService  = document.getElementById('bpService');
  var bpTimeline = document.getElementById('bpTimeline');
  var bpMaterial = document.getElementById('bpMaterial');
  var bpArea     = document.getElementById('bpArea');
  if (bpService)  bpService.textContent  = SERVICE_LABELS[funnelData.service]  || funnelData.service || '—';
  if (bpTimeline) bpTimeline.textContent = timelineLabels[funnelData.timeline] || funnelData.timeline || '—';
  if (bpMaterial) bpMaterial.textContent = funnelData.service === 'storm-damage'
    ? 'Insurance Claim'
    : (materialLabels[ballparkMaterialKey()] || ballparkMaterialKey() || '—');
  if (bpArea) {
    var addr = funnelData.address || '';
    var m = addr.match(/,\s*([^,]+?),\s*([A-Z]{2})\b/);
    bpArea.textContent = m ? (m[1].trim() + ', ' + m[2]) : 'Greater Cincinnati, OH';
  }
}

function sizeShortLabel(s) {
  if (s === 'small')   return 'small';
  if (s === 'large')   return 'large';
  if (s === 'not_sure') return 'typical';
  return 'typical';
}

// Material defaulted for the chosen service (used by ballpark + AI fallback)
function ballparkMaterialKey() {
  var s = funnelData.service;
  var m = funnelData.roofType;
  if (s === 'siding-replacement' || s === 'siding-repair') {
    return ['vinyl', 'fiber_cement', 'wood'].indexOf(m) >= 0 ? m : 'vinyl';
  }
  if (s === 'gutter-replacement') {
    return ['aluminum', 'seamless'].indexOf(m) >= 0 ? m : 'seamless';
  }
  if (m === 'other') return 'asphalt';
  return m || 'asphalt';
}

// Compute the headline price range for step 4 based on service + material + size.
// All other surfaces (AI prompt, fallback) read from the same PRICING table.
function priceRangeForFunnel(size) {
  var s = funnelData.service;
  var mat = ballparkMaterialKey();
  var sz = SIZE_SQUARES[size] || 20;

  if (s === 'storm-damage') {
    return { min: PRICING.stormDeductible[0], max: PRICING.stormDeductible[1] };
  }
  if (s === 'roof-repair') {
    var r = PRICING.roofRepair[mat] || PRICING.roofRepair.asphalt;
    return { min: r[0], max: r[1] };
  }
  if (s === 'roof-replacement') {
    // Use Better (architectural) tier as the headline range — most-chosen tier.
    // $25 rounding + $2,500 job minimum match the CRM engine (estimate-config.js).
    var b = (PRICING.roof[mat] || PRICING.roof.asphalt).better;
    return {
      min: Math.max(2500, roundTo25(b[0] * sz)),
      max: Math.max(2500, roundTo25(b[1] * sz))
    };
  }
  if (s === 'siding-replacement') {
    var w = SIZE_WALL_SQFT[size] || 1700;
    var sb = (PRICING.siding[mat] || PRICING.siding.vinyl).better;
    return { min: roundTo25(sb[0] * w), max: roundTo25(sb[1] * w) };
  }
  if (s === 'siding-repair') {
    return { min: PRICING.sidingRepair[0], max: PRICING.sidingRepair[1] };
  }
  if (s === 'gutter-replacement') {
    var lf = SIZE_GUTTER_LF[size] || 200;
    var g = PRICING.gutters[mat] || PRICING.gutters.seamless;
    return { min: roundTo25(g[0] * lf), max: roundTo25(g[1] * lf) };
  }
  // Default (service not picked): Jo 2026-09-27 — $14,800–$20,600, the
  // Preferred ("better") asphalt range above on a typical 20–25 square home
  // ($740 x 20 .. $825 x 25, to the nearest $100), the same headline the
  // roof cost guide publishes. Not part of the locked CRM spec.
  return { min: 14800, max: 20600 };
}

// Phone number formatting
var phoneNumberEl = document.getElementById('phoneNumber');
if (phoneNumberEl) phoneNumberEl.addEventListener('input', function() {
  let val = this.value.replace(/\D/g, '');
  if (val.length > 10) val = val.slice(0, 10);
  if (val.length >= 7) {
    this.value = '(' + val.slice(0,3) + ') ' + val.slice(3,6) + '-' + val.slice(6);
  } else if (val.length >= 4) {
    this.value = '(' + val.slice(0,3) + ') ' + val.slice(3);
  } else if (val.length > 0) {
    this.value = '(' + val;
  }
});

/* ── SMS Verification ── */
let _otpSent = false;
let _otpVerified = false;

async function sendVerificationCode() {
  const phone = document.getElementById('phoneNumber').value.replace(/\D/g, '');
  if (phone.length !== 10) {
    document.getElementById('phoneNumber').parentElement.parentElement.classList.add('has-error');
    document.getElementById('phoneNumber').setAttribute('aria-invalid', 'true');
    return;
  }
  document.getElementById('phoneNumber').parentElement.parentElement.classList.remove('has-error');
  document.getElementById('phoneNumber').setAttribute('aria-invalid', 'false');

  const btn = document.getElementById('btnSendCode');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  const otpSection = document.getElementById('otpSection');
  const otpStatus = document.getElementById('otpStatus');

  if (!CONFIG.OTP_ENABLED) {
    // Skip OTP in testing mode
    _otpVerified = true;
    btn.textContent = 'Verified &#10003;';
    btn.classList.add('verified');
    otpSection.style.display = 'none';
    checkSubmitReady();
    return;
  }

  const result = await window._sendOTP('+1' + phone);

  if (result && result.success) {
    _otpSent = true;
    otpSection.style.display = 'block';
    otpStatus.className = 'otp-status sent';
    otpStatus.textContent = 'Code sent! Check your messages.';
    btn.textContent = 'Resend';
    btn.disabled = false;
    // Bring the OTP input into view so the user knows where to type the code
    otpSection.scrollIntoView({ block: 'center', behavior: 'smooth' });
    document.querySelector('.otp-input').focus({ preventScroll: true });
  } else {
    otpStatus.className = 'otp-status error';
    otpStatus.textContent = 'Failed to send code. Try again.';
    btn.textContent = 'Retry';
    btn.disabled = false;
  }
}

/* ── OTP Input Handling ── */
// Spread a multi-digit value across the boxes from idx — what the paste
// handler always did. iOS / Android SMS autofill (autocomplete="one-time-code"
// on the first box) drops the WHOLE code into one field; without this the
// first box kept one digit and the rest of the code was lost.
function _spreadOtp(inputs, idx, raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let last = idx - 1;
  for (let i = 0; i < Math.min(digits.length, inputs.length - idx); i++) {
    inputs[idx + i].value = digits[i];
    inputs[idx + i].classList.add('filled');
    last = idx + i;
  }
  if (last >= idx && last < inputs.length - 1) inputs[last + 1].focus();
  if (digits.length >= inputs.length - idx) verifyOTPCode();
}
document.querySelectorAll('.otp-input').forEach(function(input, idx, inputs) {
  input.addEventListener('input', function() {
    if (this.value.length > 1) { _spreadOtp(inputs, idx, this.value); return; }
    if (this.value.length === 1) {
      this.classList.add('filled');
      if (idx < inputs.length - 1) inputs[idx + 1].focus();
      // Auto-verify when all filled
      if (idx === inputs.length - 1) verifyOTPCode();
    }
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Backspace' && !this.value && idx > 0) {
      inputs[idx - 1].focus();
      inputs[idx - 1].value = '';
      inputs[idx - 1].classList.remove('filled');
    }
  });
  // Handle paste
  input.addEventListener('paste', function(e) {
    e.preventDefault();
    _spreadOtp(inputs, idx, (e.clipboardData || window.clipboardData).getData('text'));
  });
});

async function verifyOTPCode() {
  const inputs = document.querySelectorAll('.otp-input');
  let code = '';
  inputs.forEach(function(i) { code += i.value; });
  if (code.length !== 6) return;

  const otpStatus = document.getElementById('otpStatus');
  otpStatus.className = 'otp-status sending';
  otpStatus.textContent = 'Verifying...';

  const phone = document.getElementById('phoneNumber').value.replace(/\D/g, '');
  const result = await window._verifyOTP('+1' + phone, code);

  if (result && result.success) {
    _otpVerified = true;
    otpStatus.className = 'otp-status sent';
    otpStatus.textContent = '&#10003; Phone verified!';
    document.getElementById('btnSendCode').textContent = 'Verified &#10003;';
    document.getElementById('btnSendCode').classList.add('verified');
    document.getElementById('btnSendCode').disabled = true;
    // Verified — the skip-verification escape hatch is now pointless.
    var skipWrap = document.getElementById('otpSkip');
    if (skipWrap) skipWrap.style.display = 'none';
    trackEvent('estimate_phone_verified', { service: funnelData.service });
    checkSubmitReady();
  } else {
    otpStatus.className = 'otp-status error';
    otpStatus.textContent = 'Invalid code. Please try again.';
    inputs.forEach(function(i) { i.value = ''; i.classList.remove('filled'); });
    inputs[0].focus();
  }
}

/* ── OTP escape hatch (additive — conversion audit 2026-07-04) ──
   "Skip verification — just have Joe call me": files the lead through the
   same submitPublicLead('estimate') path with the details already entered.
   The OTP itself is untouched — the computed price stays gated behind
   verification; this only submits a callback request. The skip is flagged
   via the allowlisted requestType field (integrations.js M-04 allowlist —
   a bespoke otpSkipped key would be silently dropped server-side).
   Double-submit is blocked by the busy/done guards + disabled button. */
var _otpSkipBusy = false;
var _otpSkipDone = false;

async function skipOtpAndRequestCall(btn) {
  if (_otpSkipBusy || _otpSkipDone || _otpVerified) return;

  var status = document.getElementById('otpSkipStatus');
  var fn = document.getElementById('firstName').value.trim();
  var ln = document.getElementById('lastName').value.trim();
  var phoneDigits = document.getElementById('phoneNumber').value.replace(/\D/g, '');
  var email = document.getElementById('emailAddress').value.trim();
  var consent = document.getElementById('tcpaConsent').checked;

  if (!(fn && phoneDigits.length === 10 && _emailOk(email) && consent)) {
    status.className = 'otp-skip-status error';
    status.textContent = 'Fill in your first name and phone above (and check the consent box) so Joe knows how to reach you.';
    return;
  }

  _otpSkipBusy = true;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  status.className = 'otp-skip-status';
  status.textContent = '';

  funnelData.firstName = fn;
  funnelData.lastName = ln;
  funnelData.phone = document.getElementById('phoneNumber').value.trim();
  funnelData.email = email;

  // Mark the funnel-recovery record completed, same as the verified path.
  if (window._saveFunnelProgress && funnelData.email) {
    window._saveFunnelProgress({
      funnelId: _funnelId,
      email: funnelData.email.toLowerCase(),
      firstName: funnelData.firstName,
      lastName: funnelData.lastName,
      phoneNumber: funnelData.phone,
      address: funnelData.address || '',
      currentStep: currentStep,
      completed: true
    });
  }

  var leadData = {
    address: funnelData.address,
    service: funnelData.service,
    roofType: funnelData.roofType,
    timeline: funnelData.timeline,
    firstName: funnelData.firstName,
    lastName: funnelData.lastName,
    phone: funnelData.phone,
    email: funnelData.email,
    phoneVerified: false,
    // Same express-written-consent record the verified path stores (see
    // submitAndGetEstimate). This path ALREADY refuses to submit without the
    // box ticked — `consent` is part of the guard above — but it omitted the
    // field from the payload, so the lead landed with no proof. Harmless while
    // nothing read the flag; the moment lead-alert's SMS ack started gating on
    // a stored consent, this path's homeowners would have been silently
    // dropped: they ticked the box, asked Joe to call, and would never have
    // received the acknowledgement. Always true here by construction, but
    // written from the variable the guard actually tested, not a literal.
    tcpaConsent: consent,
    requestType: 'otp_skipped_call_request'
  };

  // Same awaited-with-one-retry contract as submitAndGetEstimate.
  var saved = false;
  try {
    saved = !!(await window._saveLead(leadData));
    if (!saved) saved = !!(await window._saveLead(leadData));
  } catch (e) { console.error('OTP-skip lead save threw:', e); }

  // Delivered = the lead SAVED. Joe's alert is the leadAlertEstimate trigger
  // on that estimate_leads doc; the old notifyNewLead call could never count
  // (it swallowed its own error and 401'd without App Check) — see
  // submitAndGetEstimate and the H3 note there (2026-10-05).
  _otpSkipBusy = false;
  if (saved) {
    _otpSkipDone = true;
    btn.textContent = 'Request sent ✓';
    status.className = 'otp-skip-status';
    status.textContent = 'Got it — Joe will call you at ' + funnelData.phone + '. No code needed.';
    trackEvent('otp_skip_call_request', { service: funnelData.service });
  } else {
    btn.disabled = false;
    btn.textContent = 'Skip verification — just have Joe call me';
    status.className = 'otp-skip-status error';
    status.textContent = 'Couldn’t send just now — call or text Joe at (859) 420-7382.';
  }
}

function _emailOk(email) { return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

/* ── "Help Joe prepare" — the optional questions, AFTER the lead (2026-10-03) ──
   The contact step used to require a scheduling choice and show best time,
   insurance, how-heard and photos (intake-extras.js) before Submit would send
   anything. Those questions now live on the thank-you screen, every one
   optional, saved onto the SAME lead: submitPublicLead hands back a one-time
   grant (wantsFollowUp) that updatePublicLeadIntake checks, and the server
   re-validates every answer with the gateway's own allowlist. Photos use the
   same grant through uploadPublicLeadPhoto. */
function _mountFollowUp() {
  var wrap = document.getElementById('estFollowUp');
  var box = document.getElementById('estIntake');
  if (!wrap || !box) return;
  // No grant = nothing to save against (the lead itself failed) — stay hidden.
  if (!window._lastPhotoToken || !window.NBDIntake) { wrap.hidden = true; return; }
  if (!box.childElementCount) box.innerHTML = window.NBDIntake.html('estI', { optional: true });
  wrap.hidden = false;
}
function _readIntake() {
  var box = document.getElementById('estIntake');
  if (!window.NBDIntake || !box || !box.childElementCount) return { fields: {}, files: [] };
  return window.NBDIntake.read(box, 'estI', { optional: true });
}
var _followUpBusy = false;
async function saveFollowUp(btn) {
  if (_followUpBusy) return;
  var status = document.getElementById('estFollowUpStatus');
  var intake = _readIntake();
  if (intake.error) { status.className = 'followup-status error'; status.textContent = intake.error; return; }
  var answers = {};
  ['scheduling', 'bestTime', 'insuranceClaim', 'howHeard'].forEach(function (k) { if (intake.fields[k]) answers[k] = intake.fields[k]; });
  var hasAnswers = Object.keys(answers).length > 0;
  if (!hasAnswers && !intake.files.length) {
    status.className = 'followup-status error';
    status.textContent = 'Pick an answer or add a photo first — or just skip this, Joe already has your request.';
    return;
  }
  var token = window._lastPhotoToken;
  _followUpBusy = true;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  var saved = !hasAnswers; // photos only: nothing to post here, afterSubmit uploads them
  if (hasAnswers && token) {
    try {
      var base = typeof window.nbdPublicFunctionsBase === 'function' ? window.nbdPublicFunctionsBase() : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
      var res = await fetch(base + '/updatePublicLeadIntake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', mode: 'cors',
        body: JSON.stringify(Object.assign({ token: token }, answers))
      });
      saved = res.ok;
    } catch (e) { saved = false; }
  }
  _followUpBusy = false;
  if (!saved) {
    btn.disabled = false;
    btn.textContent = 'Send to Joe →';
    status.className = 'followup-status error';
    status.innerHTML = 'Couldn’t save that — call or text Joe: <a href="tel:+18594207382">(859) 420-7382</a> · <a href="sms:+18594207382">send a text</a>.';
    return;
  }
  btn.textContent = 'Sent ✓';
  status.className = 'followup-status';
  status.textContent = 'Thanks — that’s on your request now.';
  trackEvent('funnel_followup_saved', { answers: Object.keys(answers).length, photos: intake.files.length });
  if (window.NBDIntake) window.NBDIntake.afterSubmit(document.getElementById('estIntakeAfter'), _intakeInfo(intake));
}
function _intakeInfo(intake) {
  return { prefix: 'estI', fields: intake.fields, files: intake.files, photoToken: window._lastPhotoToken || null,
    firstName: funnelData.firstName, lastName: funnelData.lastName, phone: funnelData.phone, email: funnelData.email,
    address: funnelData.address, service: funnelData.service };
}

/* ── Form Validation ── */
function checkSubmitReady() {
  // Required: first name, a 10-digit phone, consent. Last name and email are
  // optional (an email, when typed, must look like one). Phone verification
  // only counts when OTP_ENABLED.
  const fn = document.getElementById('firstName').value.trim();
  const phone = document.getElementById('phoneNumber').value.replace(/\D/g, '');
  const email = document.getElementById('emailAddress').value.trim();
  const consent = document.getElementById('tcpaConsent').checked;
  const verified = _otpVerified || !CONFIG.OTP_ENABLED;

  document.getElementById('btnSubmit').disabled = !(fn && phone.length === 10 && _emailOk(email) && consent && verified);
}

// Attach validation listeners
['firstName', 'lastName', 'phoneNumber', 'emailAddress'].forEach(function(id) {
  document.getElementById(id).addEventListener('input', checkSubmitReady);
});
document.getElementById('tcpaConsent').addEventListener('change', checkSubmitReady);

// Abandoned funnel recovery — save partial state on email blur.
// Fires at most once per unique email value per session.
document.getElementById('emailAddress').addEventListener('blur', function () {
  const email = this.value.trim().toLowerCase();
  if (!email || !email.includes('@') || email === _lastProgressEmail) return;
  _lastProgressEmail = email;
  if (!window._saveFunnelProgress) return;
  window._saveFunnelProgress({
    funnelId: _funnelId,
    email: email,
    firstName: document.getElementById('firstName').value.trim(),
    lastName: document.getElementById('lastName').value.trim(),
    phoneNumber: document.getElementById('phoneNumber').value.trim(),
    address: funnelData.address || '',
    currentStep: currentStep,
    completed: false
  });
});

/* ── Submit & Get Estimate ── */
async function submitAndGetEstimate() {
  const btn = document.getElementById('btnSubmit');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Processing...';

  funnelData.firstName = document.getElementById('firstName').value.trim();
  funnelData.lastName = document.getElementById('lastName').value.trim();
  funnelData.phone = document.getElementById('phoneNumber').value.trim();
  funnelData.email = document.getElementById('emailAddress').value.trim();

  // Mark funnel-recovery record as completed so the hourly recovery job skips it.
  if (window._saveFunnelProgress && funnelData.email) {
    window._saveFunnelProgress({
      funnelId: _funnelId,
      email: funnelData.email.toLowerCase(),
      firstName: funnelData.firstName,
      lastName: funnelData.lastName,
      phoneNumber: funnelData.phone,
      address: funnelData.address || '',
      currentStep: currentStep,
      completed: true
    });
  }

  // Show loading
  document.querySelectorAll('.step').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('stepLoading').classList.add('active');
  updateProgress(5);

  // Animate loading steps
  var lsSteps = ['ls1', 'ls2', 'ls3', 'ls4'];
  for (var i = 0; i < lsSteps.length; i++) {
    (function(idx) {
      setTimeout(function() {
        document.getElementById(lsSteps[idx]).classList.add('active');
        if (idx > 0) {
          document.getElementById(lsSteps[idx - 1]).classList.remove('active');
          document.getElementById(lsSteps[idx - 1]).classList.add('done');
        }
      }, idx * 900);
    })(i);
  }

  // Save lead to Firestore
  var leadData = {
    address: funnelData.address,
    lat: funnelData.lat,
    lon: funnelData.lon,
    service: funnelData.service,
    roofType: funnelData.roofType,
    timeline: funnelData.timeline,
    firstName: funnelData.firstName,
    lastName: funnelData.lastName,
    phone: funnelData.phone,
    email: funnelData.email,
    phoneVerified: _otpVerified,
    // Submit is hard-gated on the TCPA checkbox, so this is always true on a
    // completed lead — stored explicitly so the record is audit-ready and the
    // SMS-ack trigger can rely on it.
    tcpaConsent: document.getElementById('tcpaConsent').checked,
    ballpark: funnelData.ballpark,
    // Ask for the one-time grant the thank-you screen's optional questions
    // (and photos) are saved with — see saveFollowUp.
    wantsFollowUp: true
  };

  // Awaited with one retry — this used to be fire-and-forget, so a failed
  // CRM write still showed the success screen and the lead vanished
  // silently. _saveLead resolves to the lead id, or null on failure.
  var _leadSaved = false;
  var _publicLeadId = null;
  try {
    // Keep the id — it is how we ask for this lead's roof measurement below.
    _publicLeadId = await window._saveLead(leadData);
    if (!_publicLeadId) _publicLeadId = await window._saveLead(leadData);
    _leadSaved = !!_publicLeadId;
  } catch (saveErr) {
    console.error('Lead save threw:', saveErr);
  }

  // Joe's alert (email + text) is the leadAlertEstimate Firestore trigger on
  // this estimate_leads doc, so the lead SAVING is the only delivery signal.
  // H3 (2026-10-05): this used to also await window._notifyJoe and count it
  // as a second channel — but that helper swallowed its own error and always
  // resolved, and the notifyNewLead callable it wrapped enforces App Check,
  // which /estimate never initialises (401 on every submit). So "notified"
  // was always true, this flag was never set, and a lost lead still got the
  // success screen. If the save failed, the results screen says call Joe.
  window._leadDeliveryFailed = !_leadSaved;

  // Real roof measurement. The server measures this property from aerial
  // imagery the moment the CRM lead is created; this only READS the result,
  // so a slow or failed lookup costs nothing and simply leaves the estimate
  // on its size-tile footing.
  funnelData.measurement = await fetchRoofMeasurement(_publicLeadId);

  // Service-aware results: only roof-replacement gets the AI tier-table
  // call. Every other service shows a deterministic single range built
  // from priceRangeForFunnel() — the same numbers as the step-4 ballpark —
  // and the AI proxy is only asked for a short personalized note.
  if (funnelData.service !== 'roof-replacement') {
    var svcEst = buildServiceEstimate();
    funnelData.estimate = svcEst;
    try {
      var note = await fetchJoesTakeNote();
      if (note) svcEst.joesTake = note;
    } catch (noteErr) {
      // Keep the offline fallback note already on svcEst
      console.error('Joes-take note error:', noteErr);
    }
    setTimeout(function () { showResults(svcEst); }, 800);
    return;
  }

  // Get AI estimate
  try {
    var serviceLabel = {
      'roof-replacement': 'roof replacement',
      'roof-repair': 'roof repair',
      'siding': 'siding installation',
      'gutters': 'gutter installation',
      'storm-damage': 'storm damage inspection and repair'
    }[funnelData.service] || funnelData.service;

    var materialLabel = {
      asphalt: 'asphalt shingles',
      metal: 'metal roofing',
      flat: 'flat/low-slope roofing'
    }[funnelData.roofType] || 'asphalt shingles';

    // Pull NBD's actual per-square pricing into the prompt so the AI can't drift.
    var roofMat = funnelData.roofType === 'other' ? 'asphalt' : (funnelData.roofType || 'asphalt');
    var matPricing = PRICING.roof[roofMat] || PRICING.roof.asphalt;
    var sizeCat = funnelData.homeSize || 'typical';
    var _meas = funnelData.measurement;
    var _measured = !!(_meas && Number(_meas.squares) > 0);
    // A measured roof replaces the homeowner's guess as the primary signal.
    var sizeHint = _measured
      ? 'AERIALLY MEASURED — ' + Math.round(_meas.sqft).toLocaleString() + ' sq ft (' + _meas.squares + ' squares)'
        + (_meas.pitch ? ', predominant pitch ' + _meas.pitch : '')
        + (_meas.stories ? ', ' + _meas.stories + ' storey' : '')
        + '. This is a real measurement, not the homeowner\'s estimate — use it EXACTLY and do not re-estimate the size.'
      : (SIZE_LABEL[sizeCat] || SIZE_LABEL.typical);
    var coordHint = (funnelData.lat && funnelData.lon)
      ? funnelData.lat.toFixed(4) + ', ' + funnelData.lon.toFixed(4)
      : 'unknown';

    var prompt = 'You are Joe Deal, owner of No Big Deal Home Solutions. NBD serves the Greater Cincinnati metro area — SW Ohio, Northern Kentucky, and SE Indiana. A verified homeowner wants a detailed roof estimate.\n\n' +
      'Address: ' + funnelData.address + '\n' +
      'Coordinates: ' + coordHint + '\n' +
      'Service: ' + serviceLabel + '\n' +
      'Material preference: ' + materialLabel + '\n' +
      (_measured ? 'Roof size: ' : 'Homeowner-reported size: ') + sizeHint + '\n' +
      'Timeline: ' + funnelData.timeline + '\n' +
      'Name: ' + funnelData.firstName + '\n\n' +
      (_measured
        ? 'The roof size above was measured from aerial imagery. Use it exactly — do not adjust, round or second-guess it.\n\n'
        : 'Use the homeowner-reported size as your primary signal. Refine it with your knowledge of typical homes near these coordinates if you have it (lot patterns, year built norms, suburb characteristics). Do not assume a generic 1,800 sqft default — actually reason about the address.\n\n') +
      'Apply NBD\'s actual installed pricing for this material. NBD does not install' +
      ' 3-tab shingles on new roof installs — every tier below is a real architectural' +
      ' or better shingle; never describe the Good/Standard tier as "3-tab" or "economy":\n' +
      '- Good (Standard, architectural):        $' + matPricing.good[0]   + '-$' + matPricing.good[1]   + '/square\n' +
      '- Better (Preferred, architectural):     $' + matPricing.better[0] + '-$' + matPricing.better[1] + '/square\n' +
      '- Best (Elite, lifetime designer):       $' + matPricing.best[0]   + '-$' + matPricing.best[1]   + '/square\n' +
      'These per-square ranges already include pitch-based waste — do not add more.\n\n' +
      'Return JSON with:\n' +
      '1. roofSqft: estimated roof area in sq ft\n' +
      '2. squares: roofSqft / 100\n' +
      '3. tiers: price ranges for Good / Better / Best (= squares × the per-square ranges above)\n' +
      '4. yearBuilt: estimate if you can, else null\n' +
      '5. joesTake: 2-3 sentence personalized note addressing ' + funnelData.firstName + ' by name. Reference the neighborhood/city if you can. Do not promise a specific price — say "Joe will give you the exact number after walking your roof."\n\n' +
      'RESPOND ONLY WITH THIS JSON (no markdown, no commentary):\n' +
      '{"roofSqft":number,"squares":number,"yearBuilt":number_or_null,"tiers":{"good":{"min":number,"max":number},"better":{"min":number,"max":number},"best":{"min":number,"max":number}},"joesTake":"string"}';

    var resp = await fetch(CONFIG.PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, maxTokens: 600 })
    });

    var data = await resp.json();
    var raw = (data && data.text) || '';
    var clean = raw.replace(/```json|```/g, '').trim();
    var est = JSON.parse(clean);

    // When the roof was measured, the numbers are ours, not the model's: keep
    // its `joesTake` and `yearBuilt`, but pin size and pricing to the
    // measurement so a hallucinated square count can never reach a homeowner.
    if (_measured) {
      est.roofSqft = Math.round(Number(_meas.sqft));
      est.squares = Number(_meas.squares);
      est.tiers = tiersFromSquares(est.squares);
      est._measured = true;
    }
    funnelData.estimate = est;

    setTimeout(function() { showResults(est); }, 800);

  } catch(err) {
    console.error('Estimate error:', err);
    setTimeout(function() { showResults(buildFallbackEstimate()); }, 1500);
  }
}

/* ── Aerial roof measurement ──
 * Asks the read-only endpoint for the measurement the server took when this
 * lead was created. Returns null on anything at all going wrong — no
 * measurement is a normal outcome (the address may not geocode to a building,
 * the provider may not recognise the roof), and the estimate simply falls back
 * to the homeowner-reported size tile it has always used.
 */
async function fetchRoofMeasurement(publicLeadId) {
  if (!publicLeadId || !CONFIG.MEASURE_URL) return null;
  try {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 22000) : null;
    var res = await fetch(CONFIG.MEASURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'estimate', leadId: publicLeadId }),
      signal: ctrl ? ctrl.signal : undefined
    });
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    var data = await res.json();
    var m = data && data.measurement;
    if (!m || !m.measured || !(Number(m.squares) > 0)) return null;
    return m;
  } catch (e) {
    return null;
  }
}

// Turn a measured roof into tier pricing the same way the fallback does:
// real squares x NBD's per-square ranges, $25 rounding, $2,500 job minimum.
// Money is never left to the model — the AI is asked for the note, not the
// arithmetic.
function tiersFromSquares(squares) {
  var mat = funnelData.roofType === 'other' ? 'asphalt' : (funnelData.roofType || 'asphalt');
  var p = PRICING.roof[mat] || PRICING.roof.asphalt;
  return {
    good:   { min: Math.max(2500, roundTo25(p.good[0]   * squares)), max: Math.max(2500, roundTo25(p.good[1]   * squares)) },
    better: { min: Math.max(2500, roundTo25(p.better[0] * squares)), max: Math.max(2500, roundTo25(p.better[1] * squares)) },
    best:   { min: Math.max(2500, roundTo25(p.best[0]   * squares)), max: Math.max(2500, roundTo25(p.best[1]   * squares)) }
  };
}

// Build a size-aware fallback that's consistent with the step-4 ballpark.
// Same per-square pricing the AI is asked to use, so the homeowner never
// sees a price drop or jump between screens.
function buildFallbackEstimate() {
  var size = funnelData.homeSize || 'typical';
  // A measured roof beats the tile even when the AI call fails.
  var meas = funnelData.measurement;
  var measured = !!(meas && Number(meas.squares) > 0);
  var squares = measured ? Number(meas.squares) : (SIZE_SQUARES[size] || 20);
  var sqft = measured ? Number(meas.sqft) : squares * 100;
  var mat = funnelData.roofType === 'other' ? 'asphalt' : (funnelData.roofType || 'asphalt');
  var p = PRICING.roof[mat] || PRICING.roof.asphalt;
  // $25 rounding + $2,500 job minimum match the CRM engine (estimate-config.js)
  var tiers = {
    good:   { min: Math.max(2500, roundTo25(p.good[0]   * squares)), max: Math.max(2500, roundTo25(p.good[1]   * squares)) },
    better: { min: Math.max(2500, roundTo25(p.better[0] * squares)), max: Math.max(2500, roundTo25(p.better[1] * squares)) },
    best:   { min: Math.max(2500, roundTo25(p.best[0]   * squares)), max: Math.max(2500, roundTo25(p.best[1]   * squares)) }
  };
  var fb = {
    roofSqft: sqft,
    squares: squares,
    yearBuilt: null,
    tiers: tiers,
    joesTake: measured
      ? funnelData.firstName + ', I measured your roof from aerial imagery — about ' + Math.round(squares) + ' squares. The ranges above are what I install at each tier for a roof that size. I still want to walk it in person before giving you the exact number — free, no obligation.'
      : funnelData.firstName + ", the live estimate engine couldn't reach me right now, so the numbers above are the architectural-tier range I install for a " + sizeShortLabel(size) + " home in your area. I'd rather measure your roof in person and give you the exact number — free, no obligation.",
    _measured: measured,
    _isFallback: !measured
  };
  funnelData.estimate = fb;
  return fb;
}

// Deterministic estimate object for every non-roof-replacement service —
// a single range straight from priceRangeForFunnel(), so the results
// screen always matches the step-4 ballpark. joesTake starts as the
// offline fallback note and is replaced if the AI note call succeeds.
function buildServiceEstimate() {
  var size = funnelData.homeSize || 'typical';
  var range = priceRangeForFunnel(size);
  // Roof sqft/squares only make sense for roof services
  var isRoofService = funnelData.service === 'roof-repair' || funnelData.service === 'storm-damage';
  var squares = SIZE_SQUARES[size] || 20;
  var label = SERVICE_LABELS[funnelData.service] || funnelData.service;
  var joesTake;
  if (funnelData.service === 'storm-damage') {
    joesTake = funnelData.firstName + ", with storm damage most homeowners end up paying just their deductible — insurance covers the rest when a claim is approved. I'll document everything in a free inspection and walk you through the process, no obligation.";
  } else {
    joesTake = funnelData.firstName + ', the range above is what ' + label.toLowerCase() + ' typically runs for a ' + sizeShortLabel(size) + ' home in your area. I\'d rather see it in person and give you the exact number — free, no obligation.';
  }
  return {
    range: { min: range.min, max: range.max },
    roofSqft: isRoofService ? squares * 100 : null,
    squares: isRoofService ? squares : null,
    yearBuilt: null,
    serviceLabel: label,
    joesTake: joesTake,
    _singleRange: true
  };
}

// Ask the AI proxy for the short personalized note ONLY — pricing for
// non-roof-replacement services is deterministic (priceRangeForFunnel),
// so the model is never asked for dollar amounts.
async function fetchJoesTakeNote() {
  var label = (SERVICE_LABELS[funnelData.service] || funnelData.service || 'home repair').toLowerCase();
  var stormRule = funnelData.service === 'storm-damage'
    ? 'This is an insurance-claim situation: you may say insurance often covers approved storm damage minus the deductible, but NEVER promise or imply that their claim will be approved. '
    : '';
  var prompt = 'You are Joe Deal, owner of No Big Deal Home Solutions. NBD serves the Greater Cincinnati metro area — SW Ohio, Northern Kentucky, and SE Indiana. A verified homeowner just completed the instant estimate funnel.\n\n' +
    'Name: ' + funnelData.firstName + '\n' +
    'Address: ' + funnelData.address + '\n' +
    'Service: ' + label + '\n' +
    'Timeline: ' + funnelData.timeline + '\n\n' +
    'Write a 2-3 sentence personalized note addressing ' + funnelData.firstName + ' by name about their ' + label + ' project. Reference the neighborhood/city if you can. Do NOT mention any dollar amounts, prices, or ranges. ' + stormRule +
    'Close by saying Joe will confirm everything with a free in-person look — no obligation.\n\n' +
    'Respond with the note text only — no JSON, no markdown, no surrounding quotes.';

  var resp = await fetch(CONFIG.PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt, maxTokens: 180 })
  });
  var data = await resp.json();
  var text = (data && data.text) || '';
  return text.trim();
}

/* ── Show Results ── */
function showResults(est) {
  document.querySelectorAll('.step').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('stepResults').classList.add('active');

  // Lead-delivery fallback: the estimate below is computed client-side and
  // is fine either way, but if the lead never saved (no estimate_leads doc,
  // so no leadAlertEstimate alert), Joe has no record of this homeowner —
  // say so instead of faking success.
  var failBanner = document.getElementById('leadDeliveryFail');
  if (window._leadDeliveryFailed) {
    if (!failBanner) {
      failBanner = document.createElement('div');
      failBanner.id = 'leadDeliveryFail';
      failBanner.setAttribute('role', 'alert');
      failBanner.style.cssText = 'background:#fff4ee;border:2px solid #BD5728;border-radius:10px;padding:14px 16px;margin:0 0 18px;color:#12223d;font-size:.92rem;font-weight:600;line-height:1.5;text-align:left;';
      failBanner.innerHTML = 'Heads up &#8212; our system couldn\'t send your request to Joe just now. Your estimate below still stands, but to make sure Joe gets your info, call or text Joe &#8212; <a href="tel:+18594207382" style="color:#BD5728;font-weight:800;white-space:nowrap">(859) 420-7382</a> &middot; <a href="sms:+18594207382" style="color:#BD5728;font-weight:800;white-space:nowrap">send a text</a>.';
      var resultsHost = document.getElementById('stepResults');
      if (resultsHost) resultsHost.insertBefore(failBanner, resultsHost.firstChild);
    }
    failBanner.style.display = '';
  } else if (failBanner) {
    failBanner.style.display = 'none';
  }
  // The optional "help Joe prepare" questions, saved onto this lead.
  if (!window._leadDeliveryFailed) _mountFollowUp();
  trackStep(6);

  // Personalized header
  document.getElementById('resultName').textContent = funnelData.firstName + "'s";
  document.getElementById('resultAddr').textContent = funnelData.address;
  var kindEl = document.getElementById('resultKind');
  if (kindEl) kindEl.textContent = RESULT_KIND[funnelData.service] || 'Roof';

  var single = !!(est && est._singleRange);

  // Good/Better/Best tabs only make sense for roof replacement —
  // every other service shows its single deterministic range.
  var tabsRow = document.getElementById('tierTabsRow');
  if (tabsRow) tabsRow.style.display = single ? 'none' : '';

  if (single) {
    document.getElementById('resultPrice').innerHTML = '$' + est.range.min.toLocaleString() + ' <span>&#8211; $' + est.range.max.toLocaleString() + '</span>';
    document.getElementById('detailTier').textContent = est.serviceLabel || '—';
    renderMonthlyLine(est.range.min, est.range.max);
  } else {
    // Default to "better" tier
    switchTier('better');
  }

  // Keep step-4's deductible/insurance framing for storm claims
  var noteEl = document.getElementById('resultNote');
  if (noteEl) {
    noteEl.textContent = funnelData.service === 'storm-damage'
      ? 'Typical out-of-pocket if going through insurance — your deductible. Insurance covers the rest.'
      : 'Based on your property · Cincinnati-area pricing · 2026';
  }

  // Details — roof sqft/squares only make sense for roof services
  // A measured roof is stated as a fact; an estimated one keeps its tilde.
  var _isMeasured = !!(est && est._measured);
  document.getElementById('detailSize').textContent = est.roofSqft
    ? (_isMeasured ? '' : '~') + est.roofSqft.toLocaleString() + ' sq ft' : '—';
  document.getElementById('detailYear').textContent = est.yearBuilt || 'Unknown';
  document.getElementById('detailSquares').textContent = est.squares
    ? (_isMeasured ? '' : '~') + est.squares : '—';

  var measNote = document.getElementById('measuredNote');
  if (measNote) {
    measNote.style.display = _isMeasured ? 'block' : 'none';
    var confEl = document.getElementById('measuredConfidence');
    var conf = funnelData.measurement && funnelData.measurement.confidence;
    if (confEl) {
      // Only ever surfaced as a caveat: a high-confidence result says nothing
      // extra, a weaker one tells the homeowner why Joe will re-check.
      confEl.textContent = (_isMeasured && conf && conf !== 'High')
        ? 'Tree cover or roof complexity made this one harder to read, so treat it as close rather than exact. '
        : '';
    }
  }

  // Joe's take
  document.getElementById('joesText').textContent = est.joesTake || 'Give Joe a call for the full picture.';
  // Show fallback notice if AI estimate failed
  const srcNote = document.getElementById('estimateSourceNote');
  if (srcNote) srcNote.style.display = est && est._isFallback ? 'block' : 'none';

  // Update lead with estimate data
  if (window._saveLead) {
    window._saveLead({
      address: funnelData.address,
      email: funnelData.email,
      phone: funnelData.phone,
      firstName: funnelData.firstName,
      lastName: funnelData.lastName,
      estimateData: est,
      type: 'estimate_result'
    });
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// GBB audit, 2026-09-09: was '3-Tab (Good)' — NBD never installs 3-tab
// shingles on a new roof (Jo, same session); every tier here is a real
// architectural-or-better shingle. Customer-facing names now match the
// site's own Standard/Preferred/Elite branding (the-nbd-guarantee) instead
// of the internal good/better/best jargon this tool previously leaked.
var TIER_LABELS = { good: 'Standard (Architectural)', better: 'Preferred (Architectural)', best: 'Elite (Lifetime Designer)' };

function switchTier(tier) {
  var est = funnelData.estimate;
  if (!est || !est.tiers || !est.tiers[tier]) return;

  var t = est.tiers[tier];
  document.getElementById('resultPrice').innerHTML = '$' + t.min.toLocaleString() + ' <span>&#8211; $' + t.max.toLocaleString() + '</span>';
  document.getElementById('detailTier').textContent = TIER_LABELS[tier] || tier;
  renderMonthlyLine(t.min, t.max);

  document.querySelectorAll('.tier-tab').forEach(function(btn) {
    if (btn.getAttribute('data-tier') === tier) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

/* ── CTA Actions ── */
function trackCTA(type) {
  // Update lead with chosen action (the notifyNewLead call that sat here
  // 401'd on every click — no App Check on /estimate; removed 2026-10-05).
  if (window._saveLead) {
    window._saveLead({
      address: funnelData.address,
      email: funnelData.email,
      phone: funnelData.phone,
      firstName: funnelData.firstName,
      lastName: funnelData.lastName,
      requestType: type,
      type: 'cta_click'
    });
  }
  trackEvent('cta_click', { cta_type: type, service: funnelData.service });
}

// Plain-text summary for the estimate email — tier lines for
// roof-replacement, a single range line for every other service.
function buildEstimateSummary(est) {
  var msg = 'Your estimate for ' + funnelData.address + ':\n\n';
  if (est && est._singleRange && est.range) {
    msg += (est.serviceLabel || 'Estimated range') + ': $' + est.range.min.toLocaleString() + ' - $' + est.range.max.toLocaleString() + '\n';
    if (funnelData.service === 'storm-damage') {
      msg += '(Typical out-of-pocket going through insurance — your deductible. Insurance covers the rest.)\n';
    }
  } else if (est && est.tiers) {
    ['good','better','best'].forEach(function(t) {
      if (est.tiers[t]) {
        msg += TIER_LABELS[t] + ': $' + est.tiers[t].min.toLocaleString() + ' - $' + est.tiers[t].max.toLocaleString() + '\n';
      }
    });
  }
  if (est && est.roofSqft) {
    msg += '\nRoof size: ~' + est.roofSqft.toLocaleString() + ' sq ft';
  }
  // Mirror the on-screen financing line (same hide rules) so the emailed
  // number keeps the monthly-payment framing the homeowner just saw.
  var finMin = est && est._singleRange && est.range ? est.range.min
    : est && est.tiers && est.tiers.better ? est.tiers.better.min : 0;
  if (funnelData.service !== 'storm-damage' && finMin >= FIN_MIN_PROJECT) {
    msg += '\n\nA project this size can usually be spread into a monthly payment instead of paid all at once — check real offers with a soft credit pull (no impact to your score): https://nobigdealwithjoedeal.com/services/financing';
  }
  msg += '\n\nFor your exact price, schedule a free inspection with Joe: https://cal.com/nobigdeal/roof-inspection';
  msg += '\nOr call: (859) 420-7382';
  return msg;
}

// `btn` is passed through from the delegated [data-action] handler so we
// never rely on the global `event`. Only claims "Sent!" once _saveLead
// resolves with a real document id (it returns the id or null).
async function emailEstimate(btn) {
  // Email is optional on the contact step (2026-10-03). Without one, the first
  // tap reveals an address field on this card; the next tap sends to it.
  if (!funnelData.email) {
    var to = document.getElementById('emailEstimateTo');
    if (!to) return;
    var v = to.value.trim();
    if (to.hidden || !v || !_emailOk(v)) {
      to.hidden = false;
      to.focus();
      if (btn) btn.textContent = 'Send to this email →';
      return;
    }
    funnelData.email = v;
  }
  trackCTA('email-estimate');
  var est = funnelData.estimate;
  var msg = buildEstimateSummary(est);

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    btn.style.opacity = '0.6';
  }

  var id = null;
  if (window._saveLead) {
    try {
      id = await window._saveLead({
        address: funnelData.address,
        email: funnelData.email,
        phone: funnelData.phone,
        firstName: funnelData.firstName,
        lastName: funnelData.lastName,
        estimateData: est,
        estimateSummary: msg,
        type: 'email_estimate_request'
      });
    } catch (e) {
      console.error('Email estimate save failed:', e);
      id = null;
    }
  }

  if (!btn) return;
  if (id) {
    btn.textContent = 'Sent! Check your inbox ✓';
  } else {
    btn.textContent = 'Couldn\'t send — call/text (859) 420-7382';
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

/* ── Reset ── */
function resetFunnel() {
  funnelData = {
    address: '', addressFull: null, lat: null, lon: null,
    service: '', roofType: 'asphalt', homeSize: 'typical', timeline: '',
    insuranceClaim: null,
    firstName: '', lastName: '', phone: '', email: '',
    phoneVerified: false, addressTyped: '', ballpark: { min: 0, max: 0 }, estimate: null
  };
  _otpSent = false;
  _otpVerified = false;
  currentStep = 1;
  window._lastPhotoToken = null;
  var fu = document.getElementById('estFollowUp');
  if (fu) {
    fu.hidden = true;
    var fuBox = document.getElementById('estIntake');
    if (fuBox) fuBox.innerHTML = '';
    var fuBtn = document.getElementById('btnFollowUp');
    if (fuBtn) { fuBtn.disabled = false; fuBtn.textContent = 'Send to Joe →'; }
    var fuSt = document.getElementById('estFollowUpStatus');
    if (fuSt) { fuSt.className = 'followup-status'; fuSt.textContent = ''; }
  }
  var after = document.getElementById('estIntakeAfter');
  if (after) after.innerHTML = '';
  // Reset inputs
  document.getElementById('addressInput').value = '';
  document.getElementById('firstName').value = '';
  document.getElementById('lastName').value = '';
  document.getElementById('phoneNumber').value = '';
  document.getElementById('emailAddress').value = '';
  document.getElementById('tcpaConsent').checked = false;
  document.getElementById('btnSendCode').textContent = 'Send Code';
  document.getElementById('btnSendCode').classList.remove('verified');
  document.getElementById('btnSendCode').disabled = false;
  document.getElementById('otpSection').style.display = 'none';
  document.getElementById('btnSubmit').disabled = true;
  document.getElementById('btnSubmit').textContent = 'Get My Free Detailed Estimate &#x2192;';
  document.getElementById('btnStep3').disabled = true;

  // Reset tiles — then re-select the defaults so the UI matches the
  // restored state (same as a fresh page load: asphalt + typical).
  document.querySelectorAll('.tile').forEach(function(t) { t.classList.remove('selected'); t.setAttribute('aria-pressed', 'false'); });
  var defAsphalt = document.querySelector('#roofTypeGroup .tile[data-value="asphalt"]');
  if (defAsphalt) { defAsphalt.classList.add('selected'); defAsphalt.setAttribute('aria-pressed', 'true'); }
  var defTypical = document.querySelector('#homeSizeGroup .tile[data-value="typical"]');
  if (defTypical) { defTypical.classList.add('selected'); defTypical.setAttribute('aria-pressed', 'true'); }
  document.getElementById('roofTypeGroup').style.display = 'none';

  // Reset OTP inputs
  document.querySelectorAll('.otp-input').forEach(function(i) { i.value = ''; i.classList.remove('filled'); });
  document.getElementById('otpStatus').textContent = '';

  // Reset the OTP escape hatch (a fresh funnel run is a new lead)
  _otpSkipBusy = false;
  _otpSkipDone = false;
  var skipWrap = document.getElementById('otpSkip');
  if (skipWrap) skipWrap.style.display = '';
  var skipBtn = document.getElementById('btnOtpSkip');
  if (skipBtn) { skipBtn.disabled = false; skipBtn.textContent = 'Skip verification — just have Joe call me'; }
  var skipStatus = document.getElementById('otpSkipStatus');
  if (skipStatus) { skipStatus.className = 'otp-skip-status'; skipStatus.textContent = ''; }

  // Reset loading steps
  ['ls1','ls2','ls3','ls4'].forEach(function(s) {
    document.getElementById(s).classList.remove('active', 'done');
  });

  // Show step 1
  document.querySelectorAll('.step').forEach(function(s) { s.classList.remove('active'); });  document.getElementById('step1').classList.add('active');
  updateProgress(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('addressInput').focus();
}

/* ── GA4 Tracking ── */
function trackEvent(name, params) {
  if (window.gtag) window.gtag('event', name, params);
}

/* ── Delegated click handlers (CSP disallows inline onclick=) ── */
// Keyboard activation for the role="button" choice tiles (WCAG 2.1.1): Enter
// or Space fires the same delegated click path so the estimate funnel can be
// completed without a mouse. Space is preventDefault'd so the page doesn't scroll.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  var t = e.target && e.target.closest && e.target.closest('.tile');
  if (t) { e.preventDefault(); t.click(); }
});

document.addEventListener('click', function (e) {
  var step = e.target.closest('[data-step]');
  if (step) { goToStep(parseInt(step.dataset.step, 10)); return; }

  var tile = e.target.closest('.tile');
  if (tile) {
    var grp = tile.closest('[data-group]');
    if (grp) { selectTile(tile, grp.dataset.group); return; }
  }

  var tier = e.target.closest('.tier-tab[data-tier]');
  if (tier) { switchTier(tier.dataset.tier); return; }

  var cta = e.target.closest('[data-cta]');
  if (cta) { trackCTA(cta.dataset.cta); /* don't return — let the link navigate */ }

  var ac = e.target.closest('.ac-item[data-idx]');
  if (ac) { selectAddr(parseInt(ac.dataset.idx, 10)); return; }

  var act = e.target.closest('[data-action]');
  if (act) {
    var a = act.dataset.action;
    if (a === 'sendCode') sendVerificationCode();
    else if (a === 'submitEstimate') submitAndGetEstimate();
    else if (a === 'skipOtp') skipOtpAndRequestCall(act);
    else if (a === 'useTypedAddress') useTypedAddress();
    else if (a === 'saveFollowUp') saveFollowUp(act);
    else if (a === 'emailEstimate') emailEstimate(act);
    else if (a === 'resetFunnel') resetFunnel();
  }
});

/* ── Init (2026-10-03) ── */
// OTP UI follows the flag. The markup ships with the Send Code button and the
// skip link HIDDEN (OTP off), so a visitor never sees them flash before this
// lazily-loaded script runs; turning OTP back on shows them here.
function _applyOtpMode() {
  var on = !!CONFIG.OTP_ENABLED;
  var send = document.getElementById('btnSendCode');
  var skip = document.getElementById('otpSkip');
  if (send) send.hidden = !on;
  if (skip) skip.hidden = !on;
  checkSubmitReady();
}
_applyOtpMode();
// The visitor is on step 1 when this (lazily loaded) script first runs.
if (currentStep === 1) trackStep(1);
