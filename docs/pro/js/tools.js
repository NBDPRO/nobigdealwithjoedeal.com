// ══════════════════════════════════════════════════════════════
// NBD Pro — tools.js
// QM Import, Quick Add, CSV Export, Onboarding
// ══════════════════════════════════════════════════════════════

// ── GAF Quick Measure Import ──

// ══ GAF QUICK MEASURE IMPORT ══════════════════════════════════════════════
// GAF Quick Measure uses Anthropic API (key from Settings → Ask Joe AI)
// Use var to avoid redeclaration collision with dashboard.html inline script
var _qmData = _qmData || null;

// The #qmImportModal markup shipped in dashboard.html on 2026-07-27 (the
// QA wiring audit found this whole feature had a parser but no UI, so the
// button threw a null-lookup on every click). Every id lookup stays
// guarded so a page without the modal degrades to a toast instead of
// crashing — kept as a guard for pages without the modal (none since the legacy twin retired 2026-09-02).
function openQMImportModal() {
  _qmData = null;
  const modal = document.getElementById('qmImportModal');
  if (!modal) {
    if (typeof showToast === 'function') {
      showToast('Quick Measure import isn\'t available on this page — enter measurements manually.', 'info');
    }
    return;
  }
  if (window.nbdModal) window.nbdModal.open('qmImportModal');
  else modal.classList.add('open');
  const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
  hide('qmStatus'); hide('qmPreview'); hide('qmApplyBtn');
  const fileEl = document.getElementById('qmFileInput'); if (fileEl) fileEl.value = '';
  const dropEl = document.getElementById('qmDropZone'); if (dropEl) dropEl.style.borderColor = '';
  _qmWireDropZone();
}

function closeQMImportModal() {
  const modal = document.getElementById('qmImportModal');
  if (!modal) return;
  if (window.nbdModal) window.nbdModal.close('qmImportModal');
  else modal.classList.remove('open');
}

// Drop zone + file input, bound once on first open. Imperative because
// dashboard.html has no change/dragover delegate (that's a customer.html
// convention) and inline handlers are CSP-blocked.
function _qmWireDropZone() {
  const zone = document.getElementById('qmDropZone');
  if (zone && zone.dataset.qmWired !== '1') {
    zone.dataset.qmWired = '1';
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--orange)';
    });
    zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
    zone.addEventListener('drop', (e) => { zone.style.borderColor = ''; handleQMDrop(e); });
  }
  const input = document.getElementById('qmFileInput');
  if (input && input.dataset.qmWired !== '1') {
    input.dataset.qmWired = '1';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) handleQMFile(file);
    });
  }
}

function handleQMDrop(e) {
  e.preventDefault();
  document.getElementById('qmDropZone').style.borderColor = '';
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') handleQMFile(file);
  else showToast('Please drop a PDF file', 'error');
}

async function handleQMFile(file) {
  if (!file) return;
  const statusEl = document.getElementById('qmStatus');
  const statusText = document.getElementById('qmStatusText');
  statusEl.style.display = 'block';
  statusText.textContent = '⏳ Reading PDF...';
  document.getElementById('qmPreview').style.display = 'none';
  document.getElementById('qmApplyBtn').style.display = 'none';

  // Track what stage we're at so error messages can be specific
  let stage = 'init';
  let rawResponse = '';

  try {
    // ── Stage 1: pre-flight checks ──
    stage = 'preflight';
    if (!file.type || !file.type.includes('pdf')) {
      throw new Error(`Not a PDF file (got ${file.type || 'unknown type'})`);
    }
    // Cloud Function request body limit is 10 MB. Base64 adds ~33% overhead,
    // so the raw PDF needs to be under ~7.5 MB to fit.
    const mb = (file.size / 1024 / 1024);
    if (mb > 7.5) {
      throw new Error(`PDF too large (${mb.toFixed(1)} MB). Max 7.5 MB — export a lower-res version from Quick Measure and try again.`);
    }
    if (!window.callClaude) {
      throw new Error('Claude proxy not loaded. Refresh the page and try again.');
    }
    if (!window._user?.uid) {
      throw new Error('Not signed in. Please log in and try again.');
    }

    // ── Stage 2: file → base64 ──
    stage = 'reading file';
    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          res(reader.result.split(',')[1]);
        } catch (e) {
          rej(new Error('File read returned invalid data URL'));
        }
      };
      reader.onerror = () => rej(new Error('FileReader failed: ' + (reader.error?.message || 'unknown error')));
      reader.readAsDataURL(file);
    });
    if (!base64 || base64.length < 100) {
      throw new Error('PDF base64 encoding produced empty or truncated data');
    }

    statusText.textContent = '🤖 AI extracting measurements…';

    // ── Stage 3: Claude API call ──
    stage = 'Claude API';
    const prompt = `You are parsing a GAF Quick Measure roofing report PDF. Extract ONLY these exact fields and return ONLY valid JSON with no markdown, no explanation, no backticks:
{
  "address": "full property address",
  "roofArea": number (sq ft, total),
  "roofFacets": number,
  "pitch": "X/12 format predominant pitch e.g. 6/12",
  "ridges": number (ft),
  "hips": number (ft),
  "valleys": number (ft),
  "rakes": number (ft),
  "eaves": number (ft),
  "bends": number (ft),
  "flash": number (ft),
  "step": number (ft),
  "dripEdge": number (ft),
  "leakBarrier": number (ft),
  "ridgeCap": number (ft),
  "starter": number (ft),
  "penetrations": number,
  "suggestedWastePct": number (suggested waste % as integer e.g. 14),
  "squaresAtSuggestedWaste": number
}
Return ONLY the JSON object. No other text.`;

    // Sonnet has stronger PDF document extraction than Haiku 4.5 — the
    // accuracy gain on QM reports is worth the token cost. 2026-10-04: this
    // asked for claude-sonnet-4-5-20250929, which claudeProxy's allowlist
    // never held, so every import silently ran on Haiku. Sonnet 5.5 is on the
    // allowlist (functions/handlers/_shared.js ALLOWED_CLAUDE_MODELS).
    const result = await window.callClaude({
      model: 'claude-sonnet-5-5',
      feature: 'qm-import',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: prompt }
        ]
      }]
    });

    // ── Stage 4: parse response ──
    stage = 'parsing response';
    if (!result) {
      throw new Error('Claude returned empty response');
    }
    if (result.error) {
      throw new Error('Claude API error: ' + (result.error.message || JSON.stringify(result.error)));
    }
    // The first TEXT block — never assume content[0] is text.
    rawResponse = (Array.isArray(result?.content) ? result.content : []).filter((c) => c && c.type === 'text').map((c) => c.text || '').join('') || '';
    if (!rawResponse) {
      throw new Error('Claude response missing content.[0].text — structure: ' + JSON.stringify(result).substring(0, 200));
    }
    // Strip any code fences Claude might add
    const clean = rawResponse.replace(/```json|```/g, '').trim();
    try {
      _qmData = JSON.parse(clean);
    } catch (parseErr) {
      throw new Error('Claude returned non-JSON response. First 200 chars: ' + clean.substring(0, 200));
    }
    if (!_qmData || typeof _qmData !== 'object') {
      throw new Error('Parsed response is not an object: ' + typeof _qmData);
    }

    statusText.textContent = '✅ Measurements extracted successfully';
    if (typeof showToast === 'function') {
      showToast('✓ Quick Measure imported', 'success');
    }
    renderQMPreview(_qmData);

  } catch(err) {
    // Structured log for diagnosis
    console.error('[QM Import] failed at stage:', stage, {
      message: err?.message,
      fileName: file?.name,
      fileSize: file ? (file.size / 1024 / 1024).toFixed(2) + ' MB' : 'n/a',
      fileType: file?.type,
      rawResponsePreview: rawResponse.substring(0, 200)
    });

    // Surface the actual error to the user. Using DOM builders instead
    // of innerHTML so err.message (which can come from Claude API /
    // network / JSON parser) can never smuggle markup into the page.
    // Matches the security posture of the innerHTML sweep in fe24f7e.
    const msg = (err?.message || 'unknown error').substring(0, 300);
    statusText.textContent = '';
    const xmark = document.createTextNode('❌ ');
    const strong = document.createElement('strong');
    strong.textContent = 'Import failed at: ' + stage;
    const br = document.createElement('br');
    const span = document.createElement('span');
    span.style.cssText = 'font-size:11px;color:var(--m);';
    span.textContent = msg;
    statusText.appendChild(xmark);
    statusText.appendChild(strong);
    statusText.appendChild(br);
    statusText.appendChild(span);

    if (typeof showToast === 'function') {
      showToast('QM import failed: ' + msg.substring(0, 80), 'error');
    }
  }
}

function renderQMPreview(d) {
  const grid = document.getElementById('qmPreviewGrid');
  const rows = [
    ['Address', d.address],
    ['Roof Area', d.roofArea + ' sq ft'],
    ['Facets', d.roofFacets],
    ['Pitch', d.pitch],
    ['Ridges', d.ridges + ' ft'],
    ['Hips', d.hips + ' ft'],
    ['Valleys', d.valleys + ' ft'],
    ['Rakes', d.rakes + ' ft'],
    ['Eaves', d.eaves + ' ft'],
    ['Drip Edge', d.dripEdge + ' ft'],
    ['Leak Barrier', d.leakBarrier + ' ft'],
    ['Ridge Cap', d.ridgeCap + ' ft'],
    ['Suggested Waste', d.suggestedWastePct + '%'],
    ['Squares (w/waste)', d.squaresAtSuggestedWaste],
  ];
  // Build the preview grid with DOM builders so Claude-extracted field
  // values (address, pitch, etc.) cannot smuggle markup into the page.
  // Matches the security posture from the innerHTML sweep in fe24f7e.
  grid.textContent = '';
  rows.forEach(([k, v]) => {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--s2);border-radius:5px;padding:6px 8px;';
    const label = document.createElement('div');
    label.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m);';
    label.textContent = k;
    const value = document.createElement('div');
    value.style.cssText = 'font-size:12px;font-weight:700;color:var(--t);';
    value.textContent = v == null ? '' : String(v);
    card.appendChild(label);
    card.appendChild(value);
    grid.appendChild(card);
  });
  document.getElementById('qmPreview').style.display = 'block';
  document.getElementById('qmApplyBtn').style.display = 'flex';
}

// Map QM's extracted fields onto the V2 builder's measurement state.
// V2 is the live builder (classic is deprecated for new estimates), so an
// import lands there first; the classic-field population below still runs
// for anyone editing an existing classic estimate.
function _qmToV2Measurements(d) {
  const num = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v);
  const pitchRise = (() => {
    const m = String(d.pitch || '').match(/(\d+(?:\.\d+)?)\s*\/\s*12/);
    return m ? Number(m[1]) : null;
  })();
  const out = {
    rawSqft: num(d.roofArea),
    ridgeLf: num(d.ridges),
    hipLf: num(d.hips),
    valleyLf: num(d.valleys),
    rakeLf: num(d.rakes),
    eaveLf: num(d.eaves),
    pipes: num(d.penetrations),
  };
  if (pitchRise != null) out.pitch = pitchRise;
  Object.keys(out).forEach(k => { if (out[k] == null) delete out[k]; });
  return out;
}

function applyQMData() {
  if (!_qmData) return;
  const d = _qmData;

  // V2 builder path (the live one). If it's already open, push straight
  // into its state; otherwise open it with the measurements pre-applied.
  const v2Open = (() => {
    const m = document.getElementById('estV2Modal');
    return !!(m && m.classList.contains('open'));
  })();
  const v2Meas = _qmToV2Measurements(d);
  if (v2Open && window.EstimateV2UI && typeof window.EstimateV2UI.applyImportedMeasurements === 'function') {
    window.EstimateV2UI.applyImportedMeasurements(v2Meas);
    closeQMImportModal();
    showToast('✅ Quick Measure applied to your estimate', 'success');
    return;
  }
  // Not in the classic builder either → open V2 with the import staged.
  const classicOpen = !!document.getElementById('estRawSqft');
  if (!classicOpen && typeof window.openEstimateV2Builder === 'function') {
    closeQMImportModal();
    window.openEstimateV2Builder({ importMeasurements: v2Meas });
    return;
  }

  // Populate Step 1 fields
  const addr = document.getElementById('estAddr'); if (addr) addr.value = d.address || '';
  const sqft = document.getElementById('estRawSqft'); if (sqft) { sqft.value = d.roofArea || ''; }
  const ridge = document.getElementById('estRidge'); if (ridge) ridge.value = d.ridges || '';
  const eave = document.getElementById('estEave'); if (eave) eave.value = d.eaves || '';
  const hip = document.getElementById('estHip'); if (hip) hip.value = d.hips || '';

  // Store full QM data on estData for export appendix
  estData._qm = d;

  // Show QM import note
  const qmNote = document.getElementById('qmImportNote');
  if (qmNote) qmNote.style.display = 'block';
  const drawNote = document.getElementById('drawImportNote');
  if (drawNote) drawNote.style.display = 'none';

  // Auto-select pitch in Step 2
  const pitchMap = {
    '4/12': '1.054|4/12', '5/12': '1.083|5/12', '6/12': '1.118|6/12',
    '7/12': '1.158|7/12', '8/12': '1.202|8/12', '9/12': '1.25|9/12',
    '10/12': '1.302|10/12', '11/12': '1.357|11/12', '12/12': '1.414|12/12'
  };
  const pitchKey = (d.pitch || '').replace(/\s/g,'');
  const pitchSel = document.getElementById('estPitch');
  if (pitchSel && pitchMap[pitchKey]) pitchSel.value = pitchMap[pitchKey];

  // Auto-select waste factor closest to suggested
  const wastePct = d.suggestedWastePct || 14;
  const wasteSel = document.getElementById('estWaste');
  if (wasteSel) {
    const wasteMap = [[10,'1.10'],[15,'1.15'],[17,'1.17'],[20,'1.20'],[25,'1.25']];
    const closest = wasteMap.reduce((a,b) => Math.abs(b[0]-wastePct) < Math.abs(a[0]-wastePct) ? b : a);
    wasteSel.value = closest[1];
  }

  updateEstCalc();
  closeQMImportModal();
  showToast('✅ Quick Measure data applied', 'success');
}

// ══ QUICK ADD LEAD (mobile field tool) ════════════════════════════════

// Bumped on every open and close. qaUseMyLocation's geolocation callback can
// land up to 12s after the sheet is gone (that is its timeout), and it writes
// the latch unconditionally — so a late fix could silently re-arm coordinates
// the dismiss just cleared. Capture the generation before awaiting GPS and
// drop the result if it no longer matches.
let _qaGpsGen = 0;
function _qaClearGpsLatch() {
  _qaGpsGen++;
  window._pendingPinLatLng = null;
}

function openQuickAddLead() {
  // nbdModal owns Esc/backdrop/focus on dashboard.html; classList fallback on
  // pages without nbd-modal.js (none since the legacy twin retired 2026-09-02).
  //
  // The GPS latch MUST be cleared through onClose, not only in
  // closeQuickAddLead(). nbd-modal's backdrop and Esc handlers call its
  // internal close() directly, and close() only runs a cleanup callback when
  // one was registered at open() — so a dismissal by tap-outside or Esc never
  // reaches closeQuickAddLead at all. Only the two ✕ buttons do. Without this,
  // the "cleared on dismiss" half of the latch fix covers one path in three.
  if (window.nbdModal) {
    window.nbdModal.open('quickAddModal', { onClose: _qaClearGpsLatch });
  }
  else { document.getElementById('quickAddModal').classList.add('open'); }
  document.getElementById('qaAddr').value = '';
  document.getElementById('qaPhone').value = '';
  document.getElementById('qaErr').style.display = 'none';
  // The two selects were missing from this reset, so the previous lead's damage
  // type and source rode along into the next one — a rep working a hail street
  // then taking a referral call filed it as "Door Knock / Roof - Hail". Back to
  // the first option, which is what the markup ships as the default.
  const qaDamage = document.getElementById('qaDamage'); if (qaDamage) qaDamage.selectedIndex = 0;
  const qaSource = document.getElementById('qaSource'); if (qaSource) qaSource.selectedIndex = 0;
  // Start from no coordinates: an abandoned "Use my location" from an earlier
  // Quick-Add would otherwise still be armed and stamp this lead with the old
  // house's location if the address doesn't geocode.
  _qaClearGpsLatch();
  _qaResetGpsBtn();
  setTimeout(() => document.getElementById('qaAddr').focus(), 120);
}
function closeQuickAddLead() {
  // Field resets live in openQuickAddLead, not here — deliberately. This modal
  // is reset on OPEN, so dismissing it loses nothing that a reopen wouldn't
  // clear anyway; don't "fix" it by moving them down here.
  // The GPS latch is the exception: it lives on window, outlives the modal, and
  // _saveLead will happily apply it to whatever lead is created next.
  _qaClearGpsLatch();
  if (window.nbdModal) { window.nbdModal.close('quickAddModal'); }
  else { document.getElementById('quickAddModal').classList.remove('open'); }
}

// "Use my location" — fetch device GPS and reverse-geocode to populate
// the address field. Lets a D2D rep create a lead at the door they're
// standing in front of in two taps (Quick Add → Use my location → Save).
// We still require a final tap so the rep can eyeball the resolved
// address (Nominatim can be off by one house number in dense suburbs).
async function qaUseMyLocation() {
  const btn = document.getElementById('qaGpsBtn');
  const lbl = document.getElementById('qaGpsBtnLabel');
  const errEl = document.getElementById('qaErr');
  const addrInput = document.getElementById('qaAddr');
  if (!('geolocation' in navigator)) {
    if (errEl) { errEl.textContent = 'GPS not available on this device.'; errEl.style.display = 'block'; }
    return;
  }
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  if (lbl) lbl.textContent = 'Locating…';

  // The GPS fix can land up to 12s from here (that is the timeout below), and
  // the sheet can be dismissed or reopened in that window. Without this the
  // late callback re-arms the latch the dismiss just cleared, and writes an
  // address into a form the rep has already moved on from — so the
  // "cleared on dismiss" guarantee would hold only until the radio answered.
  const _gen = _qaGpsGen;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 30000
      });
    });
    if (_gen !== _qaGpsGen) return; // sheet closed or reopened — drop the fix
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    // Stash for _saveLead so the new lead gets accurate lat/lng even
    // when reverse-geocode produces a slightly-off house number — the
    // _pendingPinLatLng pattern is the same one the map-pin flow uses.
    window._pendingPinLatLng = { lat, lng };

    if (lbl) lbl.textContent = 'Resolving address…';
    const addr = await _qaReverseGeocode(lat, lng);
    if (_gen !== _qaGpsGen) return; // second await, same staleness risk
    if (addr && addrInput) {
      addrInput.value = addr;
      if (lbl) lbl.textContent = '✓ Address set';
    } else {
      // Fall back to lat,lng string so the lead still gets created with
      // useful coordinates even if the geocoder is rate-limited.
      if (addrInput) addrInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      if (lbl) lbl.textContent = '✓ Location set (no address)';
    }
    // Reset button after a beat so user knows the action completed and
    // they can retry if needed.
    setTimeout(_qaResetGpsBtn, 1800);
  } catch (e) {
    console.warn('[QuickAdd] GPS lookup failed:', e);
    const msg = (e && e.code === 1) ? 'Location permission denied.'
              : (e && e.code === 3) ? 'Location request timed out.'
              : 'Could not get your location.';
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    _qaResetGpsBtn();
  }
}

function _qaResetGpsBtn() {
  const btn = document.getElementById('qaGpsBtn');
  const lbl = document.getElementById('qaGpsBtnLabel');
  if (btn) btn.disabled = false;
  if (lbl) lbl.textContent = 'Use my location';
}

// Lightweight Nominatim reverse-geocode — same provider d2d-tracker
// uses. Inlined here to avoid coupling Quick Add to the d2d module's
// IIFE-scoped helper. Returns a USPS-style string when window.formatMailingAddress
// is loaded, otherwise a basic "num road, city, state" composition.
async function _qaReverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return '';
    const data = await resp.json();
    if (typeof window.formatMailingAddress === 'function') {
      const formatted = window.formatMailingAddress(data);
      if (formatted) return formatted;
    }
    const a = data && data.address;
    if (a) {
      const num = a.house_number || '';
      const road = a.road || a.street || a.pedestrian || '';
      const city = a.city || a.town || a.village || a.hamlet || '';
      const st = a.state_code || a.state || '';
      return `${num} ${road}${city ? ', ' + city : ''}${st ? ', ' + st : ''}`.trim();
    }
  } catch (_) { /* network/CORS — caller handles fallback */ }
  return '';
}

async function saveQuickLead() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const addr = document.getElementById('qaAddr').value.trim();
  const phone = document.getElementById('qaPhone').value.trim();
  const damage = document.getElementById('qaDamage').value;
  const source = document.getElementById('qaSource').value;
  const errEl = document.getElementById('qaErr');

  if (!addr) {
    errEl.textContent = 'Address is required.';
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';

  // The save button moved to data-action="call" data-fn long ago; the old
  // [onclick=...] selector matched nothing and btn.textContent THREW here,
  // killing every quick-add save before the write. Null-guarded so a future
  // markup change degrades to a missing spinner, never a dead save.
  const btn = document.querySelector('#quickAddModal button[data-fn="saveQuickLead"]');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

  try {
    const leadId = await window._saveLead({
      address: addr,
      phone: phone || '',
      damageType: damage,
      source: source,
      stage: 'new',
      firstName: '',
      lastName: '',
      email: '',
      notes: '',
      followUp: '',
      insCarrier: '',
      jobValue: '',
      claimStatus: 'No Claim',
      // Tag the source path so usage analytics can see Quick-Add uptake
      // separately from the full-form / D2D-convert flows.
      _createdVia: 'quick-add'
    });

    // Bail quietly if _saveLead short-circuited (over plan limit, dedup
    // declined). It surfaced its own toast already.
    if (!leadId) {
      if (btn) { btn.textContent = orig; btn.disabled = false; }
      return;
    }

    // "Create Everything" — fan-out side-effects so the rep doesn't have
    // to come back later to fill the lead in with structure. Each write
    // is fire-and-forget on failure: the lead doc is the source of truth,
    // and a missing activity row / task isn't worth blocking the save.
    await _qaCreateEverything(leadId, { source, damage });

    showToast('✓ Lead added — initial task scheduled', 'success');
    closeQuickAddLead();
    loadLeads();
  } catch(e) {
    errEl.textContent = 'Save failed. Check connection.';
    errEl.style.display = 'block';
    if (btn) { btn.textContent = orig; btn.disabled = false; }
  }
}

// Fan-out helper: writes the initial activity entry + a 24h follow-up
// task alongside the freshly-created lead. Kept tolerant of any single
// write failing — partial success is better than dropping the lead.
async function _qaCreateEverything(leadId, meta) {
  if (!leadId || !window._db) return;
  const db = window._db;
  const uid = window._user?.uid || null;
  const companyId = window._userClaims?.companyId || uid || null;

  // Initial activity entry — gives the rep a timeline anchor in the
  // lead detail view, and lets analytics distinguish quick-add leads
  // from full-form / D2D-converted ones.
  try {
    if (window.addDoc && window.collection && window.serverTimestamp) {
      await window.addDoc(
        window.collection(db, 'leads', leadId, 'activity'),
        {
          // F-05: client activity must be type-in-allowlist + source:'rep'.
          // Keep the original lead-source string in a non-reserved field.
          type: 'lead_created',
          source: 'rep',
          channel: 'quick-add',
          leadSource: meta?.source || '',
          damageType: meta?.damage || '',
          message: 'Lead created via Quick Add — needs enrichment',
          userId: uid,
          companyId,
          createdAt: window.serverTimestamp()
        }
      );
    }
  } catch (e) { console.warn('[QuickAdd] activity write skipped:', e?.message || e); }

  // 24h follow-up task — the single most-effective behavior in roofing
  // sales is contact within 24h. Auto-creating the task means it shows
  // up on the rep's Today list without them having to remember.
  try {
    if (window.addDoc && window.collection && window.serverTimestamp) {
      // LOCAL calendar date: toISOString() is UTC, so an evening Quick Add
      // landed its "tomorrow" task on the day after.
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const dueDate = tomorrow.getFullYear() + '-'
        + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-'
        + String(tomorrow.getDate()).padStart(2, '0');
      // Task-reader shape {text, title, done, dueDate}: tasks.js / notif-bell
      // render t.text and filter on t.done. This row used to carry only
      // title/body/status, so it sat in Today's Tasks as a blank line and
      // its overdue alert read "undefined" (2026-09-26).
      const label = 'Reach out within 24h';
      await window.addDoc(
        window.collection(db, 'leads', leadId, 'tasks'),
        {
          text: label,
          title: label,
          notes: 'Auto-created on Quick Add — call, text, or knock back.',
          done: false,
          dueDate,
          priority: 'high',
          source: 'quick-add',
          leadId,
          userId: uid,
          companyId,
          createdAt: window.serverTimestamp()
        }
      );
    }
  } catch (e) { console.warn('[QuickAdd] follow-up task skipped:', e?.message || e); }
}

window.openQuickAddLead = openQuickAddLead;
window.closeQuickAddLead = closeQuickAddLead;
window.saveQuickLead = saveQuickLead;
window.qaUseMyLocation = qaUseMyLocation;
// ══ END QUICK ADD ══════════════════════════════════════════════════════

// (warranty certificate functions removed — canonical source is warranty-cert.js)

// ══ LEAD EXPORT CSV ═══════════════════════════════════════════════════════
function exportLeadsCSV() {
  const leads = window._leads || [];
  if (!leads.length) { showToast('No leads to export', 'error'); return; }

  const headers = [
    'First Name','Last Name','Address','Phone','Email','Stage','Source',
    'Damage Type','Claim Status','Insurance Carrier','Job Value','Follow Up',
    'Notes','Created'
  ];

  const rows = leads.map(l => [
    l.firstName||'', l.lastName||'', l.address||'', l.phone||'', l.email||'',
    l.stage||'', l.source||'', l.damageType||'', l.claimStatus||'',
    l.insCarrier||'', l.jobValue||'', l.followUp||'',
    (l.notes||'').replace(/,/g,';').replace(/\n/g,' '),
    l.createdAt?.toDate ? l.createdAt.toDate().toLocaleDateString() : ''
  ].map(v => `"${String(v).replace(/"/g,'""')}"`));

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `NBD-Leads-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`✓ Exported ${leads.length} leads to CSV`, 'success');
}
window.exportLeadsCSV = exportLeadsCSV;
// ══ END LEAD EXPORT ════════════════════════════════════════════════════════

window.openQMImportModal = openQMImportModal;
window.closeQMImportModal = closeQMImportModal;
window.applyQMData = applyQMData;
// The modal's ✕ / Apply buttons dispatch through the data-action="call"
// delegate, which resolves ONLY registry entries or allowlisted window
// names. openQMImportModal is allowlisted (dashboard-state.js); register
// the rest here so the whole modal works without widening the allowlist.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  closeQMImportModal: closeQMImportModal,
  applyQMData: applyQMData
});
// ══ END QUICK MEASURE IMPORT ═══════════════════════════════════════════════

// (duplicate openQuickAddLead/closeQuickAddLead/saveQuickLead removed — canonical definition is above)

// (duplicate exportLeadsCSV removed — canonical definition is above)

// (duplicate onboarding flow removed — canonical definition is in dashboard.html)

// Window scope exposures for tools
if (typeof applyQMData === 'function') window.applyQMData = applyQMData;
if (typeof openQMImportModal === 'function') window.openQMImportModal = openQMImportModal;
if (typeof closeQMImportModal === 'function') window.closeQMImportModal = closeQMImportModal;
if (typeof saveQuickLead === 'function') window.saveQuickLead = saveQuickLead;
if (typeof exportLeadsCSV === 'function') window.exportLeadsCSV = exportLeadsCSV;
