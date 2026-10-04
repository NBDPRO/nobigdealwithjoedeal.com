/**
 * d2d-tracker-core-2026b.js — D2D core (state + data layer)
 *
 * Step 4f (2026-05-16): the 3539-line d2d-tracker-2026b.js IIFE got
 * split into a CORE module (this file) and a UI module
 * (d2d-tracker-ui-2026b.js), with the original filename retained as
 * a thin shim that publishes window.D2D. Behavior unchanged.
 *
 * Core owns:
 *   - All shared state (knocks, currentRep, currentLocation, maps,
 *     offline queue, voice/photo state, …) on window._D2DState
 *   - Constants (DISPOSITIONS, DISPO_ORDER, CARRIERS, SMS_TEMPLATES,
 *     DAILY_CHALLENGES, STREAK_MILESTONES, MAX_ATTEMPTS, …)
 *   - iOS-safe modal helpers (uiConfirm/uiPrompt)
 *   - Date / address / escape utilities
 *   - Offline sync queue
 *   - Reverse geocoding + Nominatim autocomplete wiring
 *   - Weather, neighborhood scoring, street sequencing
 *   - Walking-route nearest-neighbor + 2-opt optimizer
 *   - Firestore CRUD: loadRepProfile, loadKnocks, submitKnock,
 *     updateKnock, deleteKnock, convertToLead, convertToLeadWithEdit,
 *     loadTeamKnocks, loadTerritories, saveTerritory, deleteTerritory
 *   - Map init + layer panel + customers/weather/territory overlays
 *   - Photo + voice upload helpers (Firebase Storage)
 *   - Metrics, gamification, filters
 *   - initD2D entry point
 *
 * UI module (d2d-tracker-ui-2026b.js) is loaded NEXT and reads
 * everything via window._D2DState.
 */
(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS & DISPOSITIONS
  // ============================================================================
  // Each disposition is explicitly categorized so metrics are accurate and reps
  // aren't guessing what a button means:
  //   contact  — was an actual conversation with a person had? (drives the
  //              conversation %; a "no answer / revisit" note is NOT a convo)
  //   category — bucket for grouping + reporting
  //   desc     — one-line meaning shown as a tooltip in the picker
  const DISPOSITIONS = {
    appointment:    { label: 'Appointment Set',          color: '#2ECC8A', icon: '📅', short: 'APT',  autoFollowUp: null, contact: true,  category: 'hot',      desc: 'Booked a specific time to meet.' },
    ins_has_claim:  { label: 'Insurance - Has Claim',    color: '#9B6DFF', icon: '📋', short: 'CLM',  autoFollowUp: 2,    contact: true,  category: 'hot',      desc: 'Already has an active insurance claim.' },
    ins_needs_file: { label: 'Insurance - Needs Filing', color: '#D946EF', icon: '📝', short: 'FIL',  autoFollowUp: 1,    contact: true,  category: 'hot',      desc: 'Damage found — needs to file a claim.' },
    storm_damage:   { label: 'Storm Damage Noted',       color: '#BD5728', icon: '⛈️', short: 'DMG', autoFollowUp: 1,    contact: true,  category: 'hot',      desc: 'Talked and noted visible storm damage.' },
    interested:     { label: 'Interested',               color: '#EAB308', icon: '👍', short: 'INT',  autoFollowUp: 3,    contact: true,  category: 'warm',     desc: 'Talked — showed genuine interest.' },
    come_back:      { label: 'Come Back — They Asked',   color: '#4A9EFF', icon: '🔁', short: 'CBA',  autoFollowUp: 2,    contact: true,  category: 'warm',     desc: 'Prospect asked you to return in person.' },
    callback:       { label: 'Callback Requested',       color: '#14B8A6', icon: '📞', short: 'CBR',  autoFollowUp: 1,    contact: true,  category: 'warm',     desc: 'Prospect asked for a phone call back.' },
    revisit:        { label: 'Revisit — No Answer',      color: '#38BDF8', icon: '🔄', short: 'REV',  autoFollowUp: 1,    contact: false, category: 'followup', desc: 'Good door, nobody home — try again. Not a conversation.' },
    not_home:       { label: 'Not Home',                 color: '#6B7280', icon: '🏠', short: 'NH',   autoFollowUp: 1,    contact: false, category: 'followup', desc: 'Nobody answered.' },
    left_material:  { label: 'Left Material',            color: '#0EA5E9', icon: '📬', short: 'MAT',  autoFollowUp: 3,    contact: false, category: 'followup', desc: 'Left a door hanger / flyer — no answer.' },
    tenant:         { label: 'Tenant (Not Owner)',       color: '#94A3B8', icon: '🔑', short: 'TNT',  autoFollowUp: null, contact: true,  category: 'no_owner', desc: 'Talked — but they rent, not the owner.' },
    not_interested: { label: 'Not Interested',           color: '#E05252', icon: '✋', short: 'NI',   autoFollowUp: null, contact: true,  category: 'lost',     desc: 'Talked — they said no.' },
    ins_denied:     { label: 'Insurance - Denied',       color: '#78350F', icon: '❌', short: 'DEN',  autoFollowUp: 3,    contact: true,  category: 'lost',     desc: 'Talked — their claim was denied.' },
    vacant:         { label: 'Vacant Property',          color: '#475569', icon: '🏚️', short: 'VAC', autoFollowUp: 7,    contact: false, category: 'skip',     desc: 'Property looks vacant.' },
    do_not_knock:   { label: 'Do Not Knock',             color: '#1F2937', icon: '🚫', short: 'DNK',  autoFollowUp: null, contact: false, category: 'skip',     desc: 'Do not return to this address.' },
    cold_dead:      { label: 'Cold / Dead Lead',         color: '#374151', icon: '💀', short: 'DEAD', autoFollowUp: null, contact: false, category: 'dead',     desc: 'No potential — dead.' }
  };

  // Display order (also the report order). Grouped hot → warm → follow-up → cold.
  const DISPO_ORDER = [
    'appointment','ins_has_claim','ins_needs_file','storm_damage',
    'interested','come_back','callback',
    'revisit','not_home','left_material',
    'tenant','not_interested','ins_denied','vacant','do_not_knock','cold_dead'
  ];

  // A knock is a "conversation" only when a real person was engaged.
  function isConversation(dispo) { return !!(DISPOSITIONS[dispo] && DISPOSITIONS[dispo].contact); }

  const INS_DISPOSITIONS = ['ins_has_claim','ins_needs_file','ins_denied'];

  const CARRIERS = [
    'State Farm','Allstate','Progressive','USAA','Liberty Mutual','Nationwide',
    'Farmers','Travelers','American Family','Erie Insurance','Cincinnati Insurance',
    'Auto-Owners','Safeco','Westfield','Grange','Other'
  ];

  const MAX_ATTEMPTS = 5;
  const CINCINNATI = [39.10, -84.51];

  // ============================================================================
  // iOS-SAFE MODAL CONFIRM / PROMPT
  // ----------------------------------------------------------------------------
  // Native `confirm()` / `prompt()` are unreliable on iOS Safari/PWA installs —
  // they're blocked inside WKWebView standalone contexts and can no-op silently,
  // especially after a gesture boundary (e.g. touchend → async handler). These
  // helpers render a real DOM modal that works everywhere and returns a Promise.
  // ============================================================================
  function uiConfirm(message, { okLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'd2d-modal-overlay open';
      // Must beat an open d2d-modal-overlay (nested confirm) — overlay-top tier.
      overlay.style.zIndex = 'var(--z-overlay-top)';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = `
        <div class="d2d-modal" style="padding:20px;max-width:360px;width:92%;">
          <div style="font-size:15px;line-height:1.45;margin-bottom:18px;color:var(--t);white-space:pre-wrap;">${escapeHtml(message)}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button type="button" class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn ${danger ? 'btn-red' : 'btn-green'}" data-act="ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>`;
      function close(result) {
        overlay.removeEventListener('click', onOverlay);
        overlay.remove();
        resolve(result);
      }
      function onOverlay(ev) {
        if (ev.target === overlay) return close(false);
        const btn = ev.target.closest('button[data-act]');
        if (!btn) return;
        close(btn.dataset.act === 'ok');
      }
      overlay.addEventListener('click', onOverlay);
      document.body.appendChild(overlay);
    });
  }

  function uiPrompt(message, defaultValue = '', { okLabel = 'Save', cancelLabel = 'Cancel', maxLength = 200 } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'd2d-modal-overlay open';
      overlay.style.zIndex = 'var(--z-overlay-top)';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = `
        <div class="d2d-modal" style="padding:20px;max-width:380px;width:92%;">
          <div style="font-size:15px;line-height:1.45;margin-bottom:12px;color:var(--t);">${escapeHtml(message)}</div>
          <input type="text" data-role="input" maxlength="${Number(maxLength)}" style="width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--br);background:var(--s2);color:var(--t);font-size:15px;margin-bottom:16px;box-sizing:border-box;" />
          <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button type="button" class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn btn-green" data-act="ok">${escapeHtml(okLabel)}</button>
          </div>
        </div>`;
      const input = overlay.querySelector('input[data-role="input"]');
      input.value = defaultValue || '';
      function close(result) {
        overlay.removeEventListener('click', onOverlay);
        overlay.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      }
      function onOverlay(ev) {
        if (ev.target === overlay) return close(null);
        const btn = ev.target.closest('button[data-act]');
        if (!btn) return;
        close(btn.dataset.act === 'ok' ? (input.value || '') : null);
      }
      function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); close(input.value || ''); }
        else if (ev.key === 'Escape') { ev.preventDefault(); close(null); }
      }
      overlay.addEventListener('click', onOverlay);
      overlay.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      setTimeout(() => input.focus(), 20);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Google satellite primary (mt{s}.google.com — already on the CSP
  // script-src/img-src allow-list). Esri/ArcGIS as a per-tile fallback
  // via tileerror in initD2DMap. Esri was the previous primary, but
  // Brave Shields (and several other tracker-blocker extensions) block
  // server.arcgisonline.com at the network layer — the request fails
  // before it ever hits the server, the SW falls through to a synthetic
  // 503, and Leaflet renders a black void. Google's tile endpoint is on
  // every blocker's allowlist, so it ships universally. We keep Esri
  // around for the rare case Google rate-limits a specific tile.
  const SAT_TILES_PRIMARY = 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
  const SAT_TILES_FALLBACK = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  // Base-map choices — all on the CSP-allowed Google tile host. Google `lyrs`:
  // s=satellite, y=hybrid (imagery+labels), m=roadmap, p=terrain. Satellite +
  // hybrid keep the Esri imagery fallback; streets/terrain have no imagery
  // fallback (they'd look wrong), so they render Google-only.
  const BASEMAPS = {
    satellite: { label: 'Satellite', icon: '🛰️', url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', fallback: true },
    hybrid:    { label: 'Hybrid',    icon: '🗺️', url: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', fallback: true },
    streets:   { label: 'Streets',   icon: '🛣️', url: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', fallback: false },
    terrain:   { label: 'Terrain',   icon: '⛰️', url: 'https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}', fallback: false },
    // KyFromAbove Phase 3 — 3-inch leaf-off orthoimagery of the whole
    // Commonwealth (public domain, keyless, no quota; LODs 0–21; measured
    // 2026-09-04: z16/z19 Lexington → 200 image/png). Roughly 4× the detail of
    // the 12-inch Google/Esri tiles on the Northern-Kentucky and Lexington
    // lanes — shingle courses and vent boots are readable from the map.
    // Outside Kentucky the server returns a blank transparent PNG (190 bytes),
    // so this is an OVERLAY on the Google satellite basemap: Kentucky gets
    // 3-inch imagery, everything else stays Google. Host is in img-src.
    ky3in:     { label: 'KY 3-in',   icon: '🐎', url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', fallback: true,
                 overlay: 'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_Imagery_Phase3_3IN_WGS84WM/MapServer/tile/{z}/{y}/{x}',
                 overlayMaxNativeZoom: 21, overlayAttribution: 'Imagery © Commonwealth of Kentucky (KyFromAbove)' }
  };
  const BASEMAP_ORDER = ['satellite', 'hybrid', 'ky3in', 'streets', 'terrain'];
  const BASEMAP_PREF = 'nbd_d2d_basemap';
  // Map mark LOOK preference (Phase 1 of the map unification). Pure display
  // style — 'dots' = the detailed disposition-coded circles, 'pins' = simple
  // color teardrops 📍. Colour still encodes status in BOTH styles; this only
  // changes the shape. Persisted per device like BASEMAP_PREF.
  const MARK_STYLE_PREF = 'nbd_d2d_mark_style';
  const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&limit=5&q=';
  const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1';
  const WEATHER_KEY_STORE = 'nbd_weather_key';
  const SYNC_QUEUE_KEY = 'nbd_d2d_sync_queue';
  const PAGE_SIZE = 200;

  // Resolves the company name that goes into a message a HOMEOWNER receives.
  // The templates below used to hardcode "NBD Home Solutions" / "NBD", and
  // sendFollowUpSMS substituted only {name}/{rep}/{address}/{follow_up_date} —
  // so a tenant's prospect was told the rep works for the platform owner. (The
  // server has a brand-swapping twin, sendD2DSMS, but nothing in docs/ calls
  // it.) Same isNbd gate as email_system.js: NBD keeps its exact wording, a
  // tenant gets their own name, and a tenant with none set degrades to a
  // neutral phrase rather than to the owner's.
  function _d2dCompany() {
    let b = null;
    try { if (typeof window._brand === 'function') b = window._brand() || null; } catch (e) { b = null; }
    const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    if (isNbd) return 'NBD Home Solutions';
    return b.legalName || b.displayName || 'our team';
  }
  // Substitutes the shared tokens. Used by the send paths AND by the template
  // picker preview, so the rep reads the message his customer will actually get
  // rather than a raw {company} token.
  function _fillTemplate(body, vars) {
    return String(body || '')
      .replace(/\{company\}/g, (vars && vars.company) || _d2dCompany())
      .replace(/\{name\}/g, (vars && vars.name) || 'there')
      .replace(/\{rep\}/g, (vars && vars.rep) || '')
      .replace(/\{address\}/g, (vars && vars.address) || '')
      .replace(/\{follow_up_date\}/g, (vars && vars.follow_up_date) || 'soon');
  }

  // SMS templates — {company} resolves per tenant at send/preview time.
  const SMS_TEMPLATES = {
    interested: { label: 'Thanks for Chatting', body: 'Hey {name}! This is {rep} from {company}. Great chatting today — I\'d love to take a closer look at your roof. Let me know a good time!' },
    appointment: { label: 'Appointment Confirmation', body: 'Hi {name}! {rep} from {company} confirming our upcoming roof inspection. Looking forward to it!' },
    storm_damage: { label: 'Storm Damage Alert', body: 'Hi {name}, {rep} from {company}. I noticed some storm damage on your roof today. I offer free inspections — would you like me to come take a closer look?' },
    ins_has_claim: { label: 'Insurance Help', body: 'Hi {name}, {rep} from {company}. I can document the storm damage and give you a repair estimate to share with your insurer. Want to set up a time to chat?' },
    follow_up: { label: 'General Follow-up', body: 'Hi {name}! {rep} from {company} checking in. We chatted recently about your roof — any updates on your end? Happy to answer any questions.' },
    not_home: { label: 'Missed You', body: 'Hi {name}, {rep} from {company}. I stopped by {address} today but missed you. I noticed a few things on your roof I\'d love to discuss. When works best for a quick chat?' }
  };

  // Gamification challenges
  const DAILY_CHALLENGES = [
    { id: 'knock_30', label: 'Knock 30 Doors', target: 30, metric: 'today', icon: '🚪' },
    { id: 'appt_3', label: 'Set 3 Appointments', target: 3, metric: 'appointments_today', icon: '📅' },
    { id: 'ins_5', label: 'Log 5 Insurance Leads', target: 5, metric: 'insurance_today', icon: '📋' },
    { id: 'conv_3', label: 'Get 3 Conversations', target: 3, metric: 'conversations_today', icon: '💬' },
    { id: 'photo_5', label: 'Take 5 Roof Photos', target: 5, metric: 'photos_today', icon: '📷' }
  ];

  const STREAK_MILESTONES = [
    { days: 3, label: 'Getting Started', badge: '🔥' },
    { days: 7, label: 'One Week Warrior', badge: '⚡' },
    { days: 14, label: 'Two Week Titan', badge: '💪' },
    { days: 30, label: 'Monthly Master', badge: '🏆' },
    { days: 60, label: 'Relentless', badge: '👑' },
    { days: 100, label: 'Century Club', badge: '💎' }
  ];

  // Dispositions that should auto-offer lead conversion
  const HOT_DISPOSITIONS = ['appointment', 'interested', 'storm_damage', 'ins_has_claim', 'ins_needs_file', 'callback'];

  // ============================================================================
  // SHARED STATE (mirrored on window._D2DState so UI module can read/write)
  // ----------------------------------------------------------------------------
  // Step 4f rationale: the UI module (renderD2D, modals, voice/photo UI) needs
  // to read and occasionally mutate the same state that the core module owns.
  // Rather than pass arguments through every render/modal-open call, we publish
  // a single state object that both modules close over via window._D2DState.
  // Mirrors the dashboard-state.js pattern from Step 4a.
  // ============================================================================
  const state = window._D2DState = window._D2DState || {};
  state.knocks = [];
  state.lastKnockLoadError = null; // set by loadKnocks on failure; read by runMapDiagnostics
  state.d2dMarkStyle = 'dots';     // 'dots' | 'pins' — restored from localStorage in initD2DMap
  state.d2dMap = null;
  state.d2dCluster = null;
  state.d2dHeat = null;
  state.d2dInited = false;
  state.d2dInitializing = false; // guard against concurrent initD2D() calls
  state.locationMarker = null;
  state.accuracyCircle = null;
  state.watchId = null;
  state.currentLocation = null;
  state.gpsFixAt = null;         // ms timestamp of the last GPS fix (nav-health readout)
  state.d2dFollowMode = false;   // map tracks the rep as they move (restored from localStorage)
  state.d2dFollowPaused = false; // a manual drag pauses follow until Recenter
  state.d2dHeading = null;       // degrees from north (compass or GPS course), or null
  state.d2dRotateEnabled = false; // OPT-IN (beta): spin the map so heading points up
  state.currentKnockEntry = null;
  state.filterDispo = null;
  state.filterDateRange = 'today';
  state.showHeat = false;
  state.currentRep = null;
  state.teamMode = false;
  state.teamKnocks = [];
  state.territories = [];
  state.walkingRoute = null;
  state.walkingRouteLine = null;
  state.streetSequences = {};
  state.weatherData = null;
  state.neighborhoodScores = {};
  state.offlineQueue = [];
  state.isOnline = navigator.onLine;
  state.autocompleteTimeout = null;
  state.voiceRecorder = null;
  state.voiceChunks = [];
  state.voiceBlob = null;
  state.currentTab = 'feed'; // 'feed' | 'routes' | 'gamify' | 'analytics'

  // Constants the UI module also needs to read
  state.DISPOSITIONS = DISPOSITIONS;
  state.DISPO_ORDER = DISPO_ORDER;
  state.INS_DISPOSITIONS = INS_DISPOSITIONS;
  state.CARRIERS = CARRIERS;
  state.MAX_ATTEMPTS = MAX_ATTEMPTS;
  state.SMS_TEMPLATES = SMS_TEMPLATES;
  // Exposed so the template PICKER renders the same resolved text the customer
  // will receive. Without it the preview shows a raw "{company}" token.
  state.fillTemplate = _fillTemplate;
  state.brandCompany = _d2dCompany;
  state.DAILY_CHALLENGES = DAILY_CHALLENGES;
  state.STREAK_MILESTONES = STREAK_MILESTONES;
  state.HOT_DISPOSITIONS = HOT_DISPOSITIONS;
  state.PAGE_SIZE = PAGE_SIZE;

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================
  // Quotes too: this is used inside value="…" and data-d2d-args='…'
  // attributes (security audit 2026-09-29) — textContent→innerHTML left them raw.
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Audit finding #10: Safari's date-string parser is much stricter
  // than Chrome/Firefox. `new Date('2026-04-15 14:30')` (no T
  // separator) returns Invalid Date in Safari but a valid Date in
  // Chrome. Code downstream then does `.toDateString()` which
  // returns the literal string "Invalid Date" — the isToday
  // comparison silently never matches, follow-up reminders never
  // fire, and the user has no idea their pipeline is broken.
  //
  // Hardened toDate(): try toDate() (Firestore Timestamp), then
  // direct Date construction, then a normalized retry with the
  // common Safari-incompatible patterns fixed (space → T,
  // /-separated → -separated). Returns null on any unparseable
  // input so callers can guard with a nullcheck instead of
  // silently working with NaN-valued Dates.
  function toDate(d) {
    if (!d) return null;
    if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
    if (typeof d.toDate === 'function') {
      try { const t = d.toDate(); return (t && !isNaN(t.getTime())) ? t : null; }
      catch (_) { return null; }
    }
    if (typeof d === 'number') {
      const t = new Date(d);
      return isNaN(t.getTime()) ? null : t;
    }
    if (typeof d === 'string') {
      let t = new Date(d);
      if (!isNaN(t.getTime())) return t;
      // Safari rescue: replace space-separator with T.
      t = new Date(d.replace(' ', 'T'));
      if (!isNaN(t.getTime())) return t;
      // Safari rescue: yyyy/mm/dd → yyyy-mm-dd
      t = new Date(d.replace(/\//g, '-'));
      if (!isNaN(t.getTime())) return t;
      return null;
    }
    return null;
  }

  function timeAgo(d) {
    const date = toDate(d);
    if (!date) return '';
    const now = new Date();
    const sec = Math.floor((now - date) / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + 'd ago';
    return formatDate(date);
  }

  function formatTime(d) {
    const date = toDate(d);
    if (!date) return '';
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatDate(d) {
    const date = toDate(d);
    if (!date) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function isToday(d) {
    const date = toDate(d);
    if (!date) return false;
    return date.toDateString() === new Date().toDateString();
  }

  function isThisWeek(d) {
    const date = toDate(d);
    if (!date) return false;
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return date >= weekAgo && date <= now;
  }

  function isThisMonth(d) {
    const date = toDate(d);
    if (!date) return false;
    const now = new Date();
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  }

  function normalizeAddress(addr) {
    return (addr || '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  // A stable "door" identity for a knock. The address when we have one; else the
  // GPS coords (map-logged knocks carry lat/lng but no address string); else the
  // knock's own id. Without this, every address-less knock normalized to '' and
  // collapsed into a SINGLE door — shrinking the per-door denominator and
  // inflating "Value Per Door". Coords are rounded to ~1m so re-knocks of the
  // same spot still dedupe to one door.
  function doorKey(k) {
    const a = normalizeAddress(k && k.address);
    if (a) return a;
    if (k && k.lat != null && k.lng != null && isFinite(k.lat) && isFinite(k.lng)) {
      return 'geo:' + Number(k.lat).toFixed(5) + ',' + Number(k.lng).toFixed(5);
    }
    return 'k:' + ((k && k.id) || '');
  }

  function getAttemptCount(address) {
    const norm = normalizeAddress(address);
    return state.knocks.filter(k => normalizeAddress(k.address) === norm).length;
  }

  function getAddressHistory(address) {
    const norm = normalizeAddress(address);
    return state.knocks
      .filter(k => normalizeAddress(k.address) === norm)
      .sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0));
  }

  function parseHouseNumber(address) {
    const m = (address || '').match(/^(\d+)\s/);
    return m ? parseInt(m[1]) : 0;
  }

  function parseStreetName(address) {
    return (address || '').replace(/^\d+\s+/, '').split(',')[0].trim().toLowerCase();
  }

  // ============================================================================
  // OFFLINE SYNC QUEUE
  // ============================================================================
  // Audit findings #5, #14 (D2D-local copy of the protections that
  // landed in offline-manager.js). D2D's queue lives in localStorage
  // — Safari purges it after 7 days of PWA inactivity AND quotas it
  // around 5MB.
  const D2D_QUEUE_MAX = 500;
  const D2D_QUEUE_LAST_KNOWN_KEY = 'nbd_d2d_queue_last_known_size';

  function loadOfflineQueue() {
    try {
      state.offlineQueue = JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY) || '[]');
      if (!Array.isArray(state.offlineQueue)) state.offlineQueue = [];
    } catch(e) {
      // JSON corruption — log loudly rather than silently wiping
      // the queue. Stash the corrupt value in case we want to
      // recover by hand. Only THEN reset.
      console.error('D2D: offline queue JSON corrupt, stashing for recovery', e);
      try { localStorage.setItem(SYNC_QUEUE_KEY + '_corrupt_' + Date.now(), localStorage.getItem(SYNC_QUEUE_KEY) || ''); } catch (_) {}
      state.offlineQueue = [];
    }

    // Audit finding #5: detect Safari 7-day purge. localStorage
    // _can_ survive the IDB purge (different rules across iOS
    // versions), but it can also vanish. Bumped to lastKnown on
    // every save; if the queue is empty here AND lastKnown > 0,
    // we lost the queue between sessions.
    try {
      const lastKnown = Number(localStorage.getItem(D2D_QUEUE_LAST_KNOWN_KEY) || '0');
      if (lastKnown > 0 && state.offlineQueue.length === 0) {
        console.warn('D2D: offline queue loss detected', lastKnown, '→ 0');
        // Defer the toast slightly so it lands after the page is
        // visible (showToast called pre-render is a no-op).
        setTimeout(() => {
          window.showToast?.(
            'Heads up — ' + lastKnown + ' offline knock'
            + (lastKnown === 1 ? '' : 's') + ' from your last session were lost (browser cleared offline storage).',
            'warning'
          );
        }, 1500);
        try { localStorage.setItem(D2D_QUEUE_LAST_KNOWN_KEY, '0'); } catch (_) {}
      }
    } catch (_) { /* localStorage may be inaccessible in private mode */ }
  }

  function saveOfflineQueue() {
    try {
      localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(state.offlineQueue));
      try { localStorage.setItem(D2D_QUEUE_LAST_KNOWN_KEY, String(state.offlineQueue.length)); } catch (_) {}
    } catch (e) {
      // QuotaExceededError lands here — surface it instead of
      // letting the user think their knock saved.
      console.error('D2D: localStorage write failed', e && e.name);
      window.showToast?.(
        e && e.name === 'QuotaExceededError'
          ? 'Browser storage is full. Reconnect to sync, or clear some space.'
          : 'Could not save offline — please retry',
        'error'
      );
    }
  }

  function enqueueOffline(action, data) {
    if (state.offlineQueue.length >= D2D_QUEUE_MAX) {
      window.showToast?.(
        'Offline queue is full (' + D2D_QUEUE_MAX + ' knocks). Reconnect to sync.',
        'error'
      );
      return false;
    }
    state.offlineQueue.push({ action, data, timestamp: Date.now() });
    saveOfflineQueue();
    window.showToast?.('Saved offline — will sync when connected', 'warning');
    return true;
  }

  async function flushOfflineQueue() {
    if (state.offlineQueue.length === 0) return;
    // Snapshot the queue, clear it, persist the empty queue. Items
    // that fail re-enter via the catch below + saveOfflineQueue at
    // the end — so the persisted state always reflects the in-memory
    // state at flush exit, not at flush entry.
    const queue = [...state.offlineQueue];
    state.offlineQueue = [];
    saveOfflineQueue();

    let synced = 0;
    let failed = 0;
    let authFailures = 0;
    for (const item of queue) {
      try {
        if (item.action === 'submitKnock') {
          await submitKnock(item.data, true);
          synced++;
        } else if (item.action === 'updateKnock') {
          await updateKnock(item.data.id, item.data.fields);
          synced++;
        } else if (item.action === 'deleteKnock') {
          await deleteKnock(item.data.id);
          synced++;
        }
      } catch(e) {
        state.offlineQueue.push(item);
        failed++;
        // Firestore SDK error codes for auth failures.
        const code = e && (e.code || '');
        if (/permission-denied|unauthenticated/i.test(code)) authFailures++;
      }
    }
    saveOfflineQueue();
    if (synced > 0) window.showToast?.(`Synced ${synced} offline knock${synced !== 1 ? 's' : ''}`, 'success');
    // Surface persistent failures — auth-related ones are the worst
    // because the items will keep failing every flush until the user
    // re-authenticates.
    if (authFailures > 0) {
      window.showToast?.(
        authFailures + ' knock' + (authFailures === 1 ? '' : 's')
        + " couldn't sync — please sign in again",
        'warning'
      );
    } else if (failed > 0) {
      console.warn('D2D flush: ' + failed + ' items failed (non-auth), will retry next online window');
    }
  }

  window.addEventListener('online', () => {
    state.isOnline = true;
    if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
    flushOfflineQueue();
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
  });

  // Register background sync for offline knocks (if SW supports it)
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    navigator.serviceWorker.ready.then(reg => {
      window.addEventListener('online', () => {
        reg.sync.register('nbd-d2d-sync').catch(() => {});
      });
    });
  }

  // Listen for SW flush message
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'FLUSH_OFFLINE_QUEUE') {
        flushOfflineQueue();
      }
    });
  }

  // ============================================================================
  // REVERSE GEOCODING & ADDRESS AUTOCOMPLETE
  // ============================================================================
  async function reverseGeocode(lat, lng) {
    try {
      const resp = await fetch(`${NOMINATIM_REVERSE}&lat=${lat}&lon=${lng}`);
      // Nominatim returns a 200 with an HTML error page on rate-limit and
      // 429/5xx on outages. Calling .json() on a non-OK body either throws
      // or returns useless data, but the exception was being swallowed.
      if (!resp.ok) { console.warn('Reverse geocode HTTP', resp.status); return ''; }
      const data = await resp.json();
      // Wave 156: route through window.formatMailingAddress (W141) so
      // D2D knock addresses match the USPS-formatted strings the rest
      // of the system uses. Same fix applied to d2d-tracker.js. See
      // sister comment there for full rationale.
      if (typeof window.formatMailingAddress === 'function') {
        const formatted = window.formatMailingAddress(data);
        if (formatted) return formatted;
      }
      if (data.address) {
        const a = data.address;
        const num = a.house_number || '';
        const road = a.road || a.street || '';
        const city = a.city || a.town || a.village || a.hamlet || '';
        const st = a.state || '';
        return `${num} ${road}${city ? ', ' + city : ''}${st ? ', ' + st : ''}`.trim();
      }
    } catch (e) { console.warn('Geocode failed:', e); }
    return '';
  }

  async function searchAddresses(query) {
    if (!query || query.length < 3) return [];
    try {
      const resp = await fetch(NOMINATIM_SEARCH + encodeURIComponent(query));
      if (!resp.ok) { console.warn('Address search HTTP', resp.status); return []; }
      return await resp.json();
    } catch(e) { return []; }
  }

  function setupAddressAutocomplete(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;

    let dropdown = document.getElementById(inputId + '-ac');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = inputId + '-ac';
      dropdown.className = 'd2d-ac-dropdown';
      dropdown.style.cssText = 'position:absolute;left:0;right:0;top:100%;z-index:10;background:var(--s);border:1px solid var(--br);border-radius:0 0 6px 6px;max-height:200px;overflow-y:auto;display:none;box-shadow:0 4px 12px rgba(0,0,0,.15);';
      input.parentElement.style.position = 'relative';
      input.parentElement.appendChild(dropdown);
    }

    input.addEventListener('input', () => {
      clearTimeout(state.autocompleteTimeout);
      state.autocompleteTimeout = setTimeout(async () => {
        const val = input.value.trim();
        if (val.length < 3) { dropdown.style.display = 'none'; return; }

        // Search local knocks first
        const localMatches = state.knocks
          .filter(k => k.address && normalizeAddress(k.address).includes(normalizeAddress(val)))
          .slice(0, 3)
          .map(k => ({ display_name: k.address, lat: k.lat, lon: k.lng, local: true }));

        // Then Nominatim
        const remoteMatches = await searchAddresses(val);
        const allMatches = [...localMatches, ...remoteMatches.slice(0, 5 - localMatches.length)];

        if (allMatches.length === 0) { dropdown.style.display = 'none'; return; }

        // No inline on*= handlers — prod CSP `script-src-attr 'none'` silently
        // kills them even in JS-generated markup. Hover is bound below with
        // addEventListener alongside the click handler.
        dropdown.innerHTML = allMatches.map((r, i) => {
          const label = r.local ? '📍 ' + esc(r.display_name) : esc(r.display_name);
          return `<div class="d2d-ac-item" data-idx="${i}" style="padding:8px 12px;cursor:pointer;font-size:12px;color:var(--t);border-bottom:1px solid var(--br);transition:background var(--t-fast);">${label}</div>`;
        }).join('');
        dropdown.style.display = 'block';

        dropdown.querySelectorAll('.d2d-ac-item').forEach((el, i) => {
          el.addEventListener('mouseenter', () => { el.style.background = 'var(--s2)'; });
          el.addEventListener('mouseleave', () => { el.style.background = 'var(--s)'; });
          el.onclick = () => {
            const match = allMatches[i];
            input.value = match.display_name?.split(',').slice(0, 3).join(',').trim() || match.display_name;
            if (state.currentKnockEntry) {
              state.currentKnockEntry.lat = parseFloat(match.lat) || null;
              state.currentKnockEntry.lng = parseFloat(match.lon) || null;
            }
            dropdown.style.display = 'none';
            // Picking a suggestion sets .value programmatically (no 'input'
            // event fires), so kick off verification against Google + county
            // parcel so the rep starts from a cross-checked door number instead
            // of a raw Nominatim guess.
            if (inputId === 'd2d-qk-address' && window.D2D && typeof window.D2D.verifyKnockAddress === 'function') {
              window.D2D.verifyKnockAddress();
            }
          };
        });
      }, 350);
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { dropdown.style.display = 'none'; }, 200);
    });
  }

  // ============================================================================
  // ADDRESS ACCURACY — multi-source door-number verification
  // ============================================================================
  // A wrong door number means knocking the wrong house or filing a lead against
  // the wrong address, so we cross-check every resolved address against as many
  // independent sources as we can reach and score confidence by agreement:
  //   1. Nominatim reverse (client, free, building zoom)         — always on
  //   2. Nominatim forward round-trip (does it snap back here?)  — always on
  //   3. resolveAddress callable → Google ROOFTOP + Regrid parcel — when logged in
  // Only when ≥2 independent sources agree on the house number (and the pin is
  // near the matched address) do we call it VERIFIED. Everything else is handed
  // to the rep to confirm; a missing house number blocks the save outright.

  function haversineMeters(lat1, lng1, lat2, lng2) {
    if ([lat1, lng1, lat2, lng2].some(v => v == null || !isFinite(v))) return null;
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  // Leading house number, e.g. "2841" from "2841 Erie Ave" or "12B Main".
  function extractHouseNumber(str) {
    const m = String(str || '').trim().match(/^\s*(\d+[a-zA-Z]?)\b/);
    return m ? m[1] : '';
  }
  function sameHouseNumber(a, b) {
    if (!a || !b) return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  async function nominatimReverseDetailed(lat, lng) {
    try {
      // zoom=18 = building level (the default is coarser and snaps to streets).
      const url = `${NOMINATIM_REVERSE}&zoom=18&lat=${lat}&lon=${lng}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!resp.ok) return null;
      const data = await resp.json();
      const a = data.address || {};
      const formatted = (typeof window.formatMailingAddress === 'function' && window.formatMailingAddress(data)) || '';
      return {
        source: 'nominatim',
        formatted: formatted || data.display_name || '',
        houseNumber: a.house_number || extractHouseNumber(formatted) || '',
        road: a.road || a.street || '',
        city: a.city || a.town || a.village || a.hamlet || '',
        state: a.state || '',
        zip: a.postcode || '',
        county: a.county || '',
        lat: data.lat != null ? Number(data.lat) : null,
        lng: data.lon != null ? Number(data.lon) : null,
        // 'house'/'building' = rooftop; 'road'/'residential' = street snap.
        matchType: data.addresstype || data.type || '',
        isRooftop: !!a.house_number || data.addresstype === 'building' || data.type === 'house'
      };
    } catch (e) { return null; }
  }

  async function nominatimForwardDetailed(query) {
    try {
      // Dedicated URL WITH addressdetails=1 — the shared NOMINATIM_SEARCH
      // constant omits it, so its results carry no structured house_number
      // (which is exactly the field we cross-check on).
      const url = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&addressdetails=1&limit=5&q=' + encodeURIComponent(query);
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!resp.ok) return null;
      const arr = await resp.json();
      if (!Array.isArray(arr) || !arr.length) return null;
      // Prefer an exact house match over a street/place centroid.
      const best = arr.find(r => r.type === 'house' || r.addresstype === 'building') || arr[0];
      const a = best.address || {};
      return {
        source: 'nominatim-fwd',
        formatted: (typeof window.formatMailingAddress === 'function' && window.formatMailingAddress(best)) || best.display_name || '',
        houseNumber: a.house_number || '',
        lat: best.lat != null ? Number(best.lat) : null,
        lng: best.lon != null ? Number(best.lon) : null,
        matchType: best.type || best.addresstype || '',
        isHouse: best.type === 'house' || best.addresstype === 'building'
      };
    } catch (e) { return null; }
  }

  // Bridge to the resolveAddress callable (Google ROOFTOP + Regrid parcel).
  // Degrades to null on any failure / when not signed in / not deployed yet,
  // so the client keeps working on the Nominatim-only path.
  let _resolveAddrCallable = null;
  async function callResolveAddress(payload) {
    try {
      if (!window._functions || !window._httpsCallable) {
        const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      if (!_resolveAddrCallable) _resolveAddrCallable = window._httpsCallable(window._functions, 'resolveAddress');
      const res = await _resolveAddrCallable(payload);
      return (res && res.data) || null;
    } catch (e) {
      console.warn('[D2D] resolveAddress callable unavailable:', e && e.message || e);
      return null;
    }
  }

  // Small localStorage cache of resolutions so a door resolved once still
  // resolves OFFLINE (and repeat taps skip the network + callable billing).
  const ADDR_CACHE_KEY = 'nbd_d2d_addr_cache_v1';
  const ADDR_CACHE_TTL = 14 * 24 * 3600 * 1000; // 14 days
  const ADDR_CACHE_MAX = 500;
  function _addrCacheRead() { try { return JSON.parse(localStorage.getItem(ADDR_CACHE_KEY) || '{}'); } catch (_) { return {}; } }
  function _addrCacheGet(key) {
    const hit = _addrCacheRead()[key];
    return (hit && (Date.now() - hit.t) < ADDR_CACHE_TTL) ? hit.v : null;
  }
  function _addrCacheSet(key, val) {
    try {
      const c = _addrCacheRead();
      c[key] = { t: Date.now(), v: val };
      const keys = Object.keys(c);
      if (keys.length > ADDR_CACHE_MAX) {
        keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - ADDR_CACHE_MAX).forEach(k => delete c[k]);
      }
      localStorage.setItem(ADDR_CACHE_KEY, JSON.stringify(c));
    } catch (_) {}
  }
  // Store only the small bits — never the (potentially large) parcel polygon.
  function _trimForCache(res) {
    return { confidence: res.confidence, address: res.address, houseNumber: res.houseNumber,
             sources: res.sources, lat: res.lat, lng: res.lng, roundTripMeters: res.roundTripMeters };
  }

  // Merge every source into one verdict. Only ≥2 independent sources that AGREE
  // on the house number (with the pin near the match) earns 'verified'.
  function scoreDoorResolution(ctx) {
    const { tapLat, tapLng, nomRev, nomFwd, google, regrid, gpsWarn } = ctx;
    const cand = [];
    const push = (label, hn, formatted, lat, lng, strong) => {
      if (hn) cand.push({ label, houseNumber: String(hn), formatted: formatted || '', lat, lng, strong: !!strong });
    };
    if (google) push('Google' + (google.precision === 'ROOFTOP' ? ' (rooftop)' : ''), google.houseNumber, google.formatted, google.lat, google.lng, google.precision === 'ROOFTOP');
    if (regrid) push('County parcel', regrid.houseNumber, regrid.address, regrid.lat, regrid.lng, true);
    if (nomRev) push('OpenStreetMap', nomRev.houseNumber, nomRev.formatted, nomRev.lat, nomRev.lng, nomRev.isRooftop);

    const nums = cand.map(c => c.houseNumber.toLowerCase());
    const distinct = [...new Set(nums)];
    const reasons = [];

    // Round-trip: does the resolved address forward-geocode back near the pin?
    let rtDist = null;
    if (nomFwd && tapLat != null && nomFwd.lat != null) rtDist = haversineMeters(tapLat, tapLng, nomFwd.lat, nomFwd.lng);

    let confidence, houseNumber = '', address = '';
    // Pick the best address string: authoritative source first.
    const primary = cand.find(c => c.label.startsWith('Google')) || cand.find(c => c.label === 'County parcel') || cand[0] || null;
    if (primary) { houseNumber = primary.houseNumber; address = primary.formatted; }

    if (cand.length === 0) {
      confidence = 'unverified';
      reasons.push('No house number could be resolved — type the door number.');
    } else if (distinct.length > 1) {
      confidence = 'conflict';
      reasons.push('Sources disagree on the door number — pick the right one.');
    } else if (cand.length >= 2) {
      // ≥2 independent sources agree.
      if (rtDist != null && rtDist > 150) {
        confidence = 'likely';
        reasons.push(`${cand.length} sources agree on #${distinct[0]}, but the pin is ~${rtDist}m away — confirm.`);
      } else {
        confidence = 'verified';
        reasons.push(`${cand.length} sources agree: #${distinct[0]}.`);
        if (google && google.precision === 'ROOFTOP') reasons.push('Google rooftop match.');
        if (regrid) reasons.push('Matches the county parcel record.');
      }
    } else {
      // Single source only.
      confidence = 'likely';
      reasons.push(`${cand[0].label} match — confirm the door number.`);
      if (rtDist != null && rtDist > 150) reasons.push(`Pin is ~${rtDist}m from the address.`);
    }

    // GPS-quality guard: a weak device fix under this pin means the door itself
    // is uncertain — never auto-verify, and flag it for the rep.
    if (gpsWarn) {
      if (confidence === 'verified') confidence = 'likely';
      reasons.push(`Weak GPS (~${gpsWarn}m) here — eyeball the house.`);
    }

    return {
      confidence,                 // 'verified' | 'likely' | 'conflict' | 'unverified'
      address: address || '',
      houseNumber,
      reasons,
      sources: cand,              // [{label, houseNumber, formatted, lat, lng, strong}]
      roundTripMeters: rtDist,
      lat: (primary && primary.lat) || (nomRev && nomRev.lat) || tapLat || null,
      lng: (primary && primary.lng) || (nomRev && nomRev.lng) || tapLng || null
    };
  }

  // Resolve the door under a map tap (reverse). Nominatim first (instant), then
  // fold in Google/Regrid via the callable, then a forward round-trip check.
  async function resolveDoorAt(lat, lng) {
    const nomRev = await nominatimReverseDetailed(lat, lng);
    const candidateStr = nomRev && nomRev.formatted;
    const [callable, nomFwd] = await Promise.all([
      callResolveAddress({ mode: 'reverse', lat, lng }),
      candidateStr ? nominatimForwardDetailed(candidateStr) : Promise.resolve(null)
    ]);
    // GPS-quality guard: only fires when this pin sits within the device's own
    // (poor) accuracy radius — i.e. the rep trusted a fuzzy blue-dot position.
    // A deliberate satellite-map tap far from the dot is unaffected.
    let gpsWarn = null;
    if (typeof state.gpsAccuracy === 'number' && state.gpsAccuracy > 30 && state.currentLocation) {
      const dToMe = haversineMeters(lat, lng, state.currentLocation[0], state.currentLocation[1]);
      if (dToMe != null && dToMe <= Math.max(state.gpsAccuracy, 40)) gpsWarn = Math.round(state.gpsAccuracy);
    }
    const res = scoreDoorResolution({
      tapLat: lat, tapLng: lng, nomRev, nomFwd, gpsWarn,
      google: callable && callable.google, regrid: callable && callable.regrid
    });
    // Snap-to-parcel: if we got a county parcel polygon, draw it on the map so
    // the rep can see the pin sits on the right house, and hand the geometry
    // back for callers that want it.
    const parcelGeom = callable && callable.regrid && callable.regrid.geometry;
    if (parcelGeom) { res.parcel = { geometry: parcelGeom, lat: callable.regrid.lat, lng: callable.regrid.lng }; drawTapParcel(parcelGeom); }
    else clearTapParcel();

    const key = 'rev:' + Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
    if (res.confidence !== 'unverified') { _addrCacheSet(key, _trimForCache(res)); return res; }
    // Live resolution produced nothing (offline, or every provider momentarily
    // failed) — fall back to a saved verdict for this spot if we have one.
    const cached = _addrCacheGet(key);
    if (cached) { cached.reasons = ['Using your saved verification for this spot.']; cached.fromCache = true; return cached; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      res.reasons = ['Offline — the door number will be re-checked when you reconnect.'];
    }
    res.needsReverify = true;
    return res;
  }

  // Draw / clear the tapped parcel outline (non-interactive so it never eats a
  // follow-up map tap). Tracked on state.d2dParcelLayer, rebuilt each tap.
  function drawTapParcel(geometry) {
    if (!state.d2dMap || !window.L || !geometry) return;
    try {
      clearTapParcel();
      const layer = L.geoJSON({ type: 'Feature', geometry: geometry, properties: {} }, {
        style: { color: '#2ECC8A', weight: 2, fillColor: '#2ECC8A', fillOpacity: 0.12, dashArray: '4 3' },
        interactive: false
      });
      layer.addTo(state.d2dMap);
      state.d2dParcelLayer = layer;
    } catch (e) { console.warn('[D2D] parcel draw failed:', e && e.message || e); }
  }
  function clearTapParcel() {
    if (state.d2dParcelLayer && state.d2dMap) {
      try { state.d2dMap.removeLayer(state.d2dParcelLayer); } catch (_) {}
    }
    state.d2dParcelLayer = null;
  }

  // Verify a typed / autocompleted address string (forward). tapLat/tapLng are
  // the pin the rep placed (if any) so we can distance-check the match.
  async function verifyAddressString(str, tapLat, tapLng) {
    const q = String(str || '').trim();
    if (q.length < 5) return { confidence: 'unverified', address: q, houseNumber: extractHouseNumber(q), reasons: ['Enter a full address.'], sources: [] };
    const [callable, nomFwd] = await Promise.all([
      callResolveAddress({ mode: 'forward', address: q }),
      nominatimForwardDetailed(q)
    ]);
    // Treat the forward matches as the "sources"; build a synthetic nomRev from
    // the forward result so scoreDoorResolution can reuse its agreement logic.
    const nomRev = nomFwd ? { source: 'nominatim', houseNumber: nomFwd.houseNumber, formatted: nomFwd.formatted, lat: nomFwd.lat, lng: nomFwd.lng, isRooftop: nomFwd.isHouse } : null;
    const anchorLat = tapLat != null ? tapLat : (callable && callable.google && callable.google.lat) || (nomFwd && nomFwd.lat);
    const anchorLng = tapLng != null ? tapLng : (callable && callable.google && callable.google.lng) || (nomFwd && nomFwd.lng);
    const res = scoreDoorResolution({
      tapLat: anchorLat, tapLng: anchorLng, nomRev, nomFwd,
      google: callable && callable.google, regrid: callable && callable.regrid
    });
    // If the typed string already had a house number and nothing resolved,
    // keep the typed number rather than dropping it.
    if (!res.houseNumber) res.houseNumber = extractHouseNumber(q);
    if (!res.address) res.address = q;

    const key = 'fwd:' + q.toLowerCase().replace(/\s+/g, ' ');
    if (res.confidence !== 'unverified') { _addrCacheSet(key, _trimForCache(res)); return res; }
    const cached = _addrCacheGet(key);
    if (cached) { cached.reasons = ['Using your saved verification for this address.']; cached.fromCache = true; return cached; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      res.reasons = ['Offline — this address will be verified when you reconnect.'];
    }
    res.needsReverify = true;
    return res;
  }

  // ── Address data-quality + bulk re-verify (the review queue) ─────────
  const _CONF_RANK = { conflict: 0, unverified: 1, likely: 2, verified: 3 };
  function getAddressQuality() {
    // Scope to the rep's OWN knocks only. In manager Team mode state.knocks
    // holds the whole company's knocks, but the knocks update rule is
    // isOwner||isAdmin — a manager can't re-verify a teammate's doc (it would
    // permission-deny). So the queue only surfaces what THIS rep can fix.
    const myUid = window._user && window._user.uid;
    // Dedupe to the most-recent knock per address — that's the door we'd fix.
    const latest = new Map();
    state.knocks.forEach(k => {
      if (!k.address) return;
      if (myUid && k.userId && k.userId !== myUid) return;
      const norm = normalizeAddress(k.address);
      const kMs = (toDate(k.createdAt) || new Date(0)).getTime();
      const prev = latest.get(norm);
      if (!prev || kMs > (toDate(prev.createdAt) || new Date(0)).getTime()) latest.set(norm, k);
    });
    const doors = [...latest.values()];
    // 'verified' is the only clean state; undefined (legacy) / likely / conflict
    // / unverified all need review.
    const needsReview = doors.filter(k => k.addrConfidence !== 'verified');
    return {
      totalDoors: doors.length,
      verified: doors.length - needsReview.length,
      needsReview: needsReview.length,
      reviewList: needsReview
        .sort((a, b) => (_CONF_RANK[a.addrConfidence] ?? 1) - (_CONF_RANK[b.addrConfidence] ?? 1))
        .slice(0, 50)
    };
  }

  async function reverifyKnock(id, opts) {
    const k = state.knocks.find(x => x.id === id);
    if (!k || !k.address) return null;
    const res = await verifyAddressString(k.address, k.lat, k.lng);
    const update = {
      addrConfidence: res.confidence,
      addrHouseNumber: res.houseNumber || extractHouseNumber(k.address) || '',
      addrSources: (res.sources || []).map(s => ({ src: s.label, hn: s.houseNumber })),
      addrRoundTripMeters: (typeof res.roundTripMeters === 'number') ? res.roundTripMeters : null,
      addrNeedsReverify: res.confidence !== 'verified',
      addrVerifiedAt: window.serverTimestamp()
    };
    if (opts && opts.deferReload) {
      await window.updateDoc(window.doc(window._db, 'knocks', id), { ...update, updatedAt: window.serverTimestamp() });
    } else {
      // Single-row path (the 🔁 button): reload, re-render the panel so the
      // badge/percentage update, and toast the outcome — otherwise the button
      // looks dead and reps re-click (re-billing the callable).
      await updateKnock(id, update);
      if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
      const label = res.confidence === 'verified' ? '🟢 Verified'
        : res.confidence === 'conflict' ? '🟠 Mismatch'
        : res.confidence === 'likely' ? '🟡 Needs confirm' : '🔴 Unverified';
      window.showToast?.(`Re-checked ${String(k.address).split(',')[0]} — ${label}`, res.confidence === 'verified' ? 'success' : 'info');
    }
    return res.confidence;
  }

  // Batch re-verify the pending queue, paced for Nominatim fair-use. One reload
  // at the end instead of per-item.
  async function reverifyPending(max) {
    if (!state.isOnline) { window.showToast?.('Re-verify needs a connection', 'info'); return { done: 0, verified: 0 }; }
    const batch = getAddressQuality().reviewList.slice(0, max || 20);
    if (!batch.length) { window.showToast?.('No addresses need review', 'info'); return { done: 0, verified: 0 }; }
    window.showToast?.(`Re-verifying ${batch.length} address${batch.length !== 1 ? 'es' : ''}…`, 'info');
    let done = 0, verified = 0;
    for (const k of batch) {
      try {
        const conf = await reverifyKnock(k.id, { deferReload: true });
        done++; if (conf === 'verified') verified++;
      } catch (e) { /* skip a failed one, keep going */ }
      await new Promise(r => setTimeout(r, 1200)); // Nominatim ≥1 req/s
    }
    await loadKnocks();
    if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
    window.showToast?.(`Re-verified ${done} — ${verified} now verified`, 'success');
    return { done, verified };
  }

  // Owner/admin: re-verify the WHOLE company's back catalog server-side (the
  // reverifyCompanyKnocks callable runs with admin privileges so it can write
  // teammates' knocks, which the client owner-scoped path can't).
  async function reverifyTeam(max) {
    if (!state.isOnline) { window.showToast?.('Re-verify needs a connection', 'info'); return null; }
    window.showToast?.('Re-verifying the whole team… this can take a minute', 'info');
    try {
      if (!window._functions || !window._httpsCallable) {
        const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      const fn = window._httpsCallable(window._functions, 'reverifyCompanyKnocks');
      const res = await fn({ max: max || 300 });
      const s = (res && res.data) || {};
      await loadKnocks();
      if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
      window.showToast?.(`Team re-verify: ${s.processed || 0} checked · ${s.verified || 0} verified · ${s.conflict || 0} conflict`, 'success');
      return s;
    } catch (e) {
      const code = (e && e.code) || '';
      const msg = /permission-denied/.test(code) ? 'Owner or admin access required'
        : /resource-exhausted/.test(code) ? 'Please wait before re-running the team re-verify'
        : 'Team re-verify failed';
      window.showToast?.(msg, 'error');
      return null;
    }
  }

  // ── AI rep coach — a daily game plan from the rep's own D2D data ─────
  // Button-triggered only (each call bills Claude); Haiku tier; 30-min cache.
  let _coachCache = null;
  async function runCoach(btnEl) {
    const target = document.getElementById('d2d-coach-out');
    if (!target) return;
    if (typeof window.callClaude !== 'function') { target.innerHTML = '<div class="d2d-coach-err">AI coach isn\'t available right now.</div>'; return; }
    if (_coachCache && (Date.now() - _coachCache.at) < 30 * 60000) { target.innerHTML = _coachCache.html; return; }
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '🧠 Thinking…'; }
    target.innerHTML = '<div class="d2d-coach-err">Building your plan…</div>';
    try {
      const tod = getTimeOfDayStats(), m = getMetrics(), rev = getRevenueMetrics(), bd = getDispositionBreakdown();
      const fmtHr = (h) => (h % 12 || 12) + (h < 12 ? 'am' : 'pm');
      const hoods = Object.values(state.neighborhoodScores || {}).sort((a, b) => b.score - a.score).slice(0, 4)
        .map(n => `score ${n.score}/100 (${n.knocks.length} knocks, ${n.appointments} appts)`);
      let objections = [];
      try {
        const o = window.SalesTraining && window.SalesTraining.getObjections && window.SalesTraining.getObjections();
        if (Array.isArray(o)) objections = o.slice(0, 6).map(x => ({ q: x.objection, a: ((x.options || []).find(op => op.correct) || {}).text })).filter(x => x.a);
      } catch (_) {}
      const context = {
        golden_window: tod.bestWindow.conversions > 0 ? `${fmtHr(tod.bestWindow.start)}–${fmtHr(tod.bestWindow.end)}` : 'not enough data yet',
        day_streak: m.streak, knocks_this_week: m.week, conversion_rate_pct: m.conversionRate,
        conversations: m.conversations, appointments: m.appointments,
        expected_value_per_door: rev.expectedPerDoor, pipeline_value: rev.pipelineValue,
        top_neighborhoods: hoods, disposition_counts: bd
      };
      const system = 'You are an elite door-to-door roofing sales coach. From the rep\'s stats, give a SHORT, punchy, encouraging daily game plan. Use exactly these four one-line sections with emoji: "⏰ Best window:", "📍 Where to knock:", "🎯 Improve one thing:", "💬 Objection to practice:". Be specific to their numbers. Max ~140 words, plain text.';
      const user = 'My D2D stats: ' + JSON.stringify(context) + (objections.length ? '\n\nProven objection scripts I can practice:\n' + objections.map(o => `- "${o.q}" -> ${o.a}`).join('\n') : '');
      const resp = await window.callClaude({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, temperature: 0.6, feature: 'rep-coach', system, messages: [{ role: 'user', content: user }] });
      const text = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
      if (text) {
        const html = '<div class="d2d-coach-card">' + esc(text).replace(/\n/g, '<br>') + '</div>';
        _coachCache = { at: Date.now(), html }; // cache only a real plan, never an error
        target.innerHTML = html;
      } else {
        target.innerHTML = '<div class="d2d-coach-err">No plan came back — try again.</div>';
      }
    } catch (e) {
      const msg = String((e && e.message) || e || '');
      const rl = /429|resource-exhausted|rate|budget|capacity/i.test(msg);
      const sub = /403|subscription|verified|permission/i.test(msg);
      target.innerHTML = '<div class="d2d-coach-err">' + (rl ? 'AI limit reached — try again shortly.' : sub ? 'AI coach needs an active plan.' : 'Coach is unavailable right now.') + '</div>';
    } finally {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🧠 Get today\'s game plan'; }
    }
  }

  // ── Property intel on the knock card (owner + roof age + roof score) ─
  // Lazy: fires only on the rep's tap in the knock-detail modal because each
  // uncached address bills Regrid (~$0.01; server caches 90 days). Calls the
  // lookupParcel callable DIRECTLY — NBDIntegrations.lookupParcel is admin-gated
  // client-side and dead for reps, but the callable itself is any-authed-uid.
  const _piCache = new Map(); // address → intel, per session
  function _roofScore(roofAge, yearBuilt) {
    let score = 100;
    const age = roofAge != null ? roofAge : (yearBuilt ? new Date().getFullYear() - yearBuilt : 0);
    if (age >= 30) score -= 50; else if (age >= 25) score -= 40; else if (age >= 20) score -= 30;
    else if (age >= 15) score -= 15; else if (age >= 10) score -= 5;
    return Math.max(0, Math.min(100, score));
  }
  // Instant doorstep ballpark from county building sqft — the same $/living-sqft
  // basis the estimate/property-intel views use. Rough on purpose; the precise
  // number comes from an ordered aerial measurement.
  function _ballpark(sqft) {
    const a = Number(sqft) || 0;
    if (a < 200) return null;
    const round500 = (n) => Math.max(2500, Math.round(n / 500) * 500);
    return { min: round500(a * 6.5), max: round500(a * 7.8) };
  }
  function renderPropertyIntel(target, intel, knockId) {
    if (!target) return;
    if (!intel) { target.innerHTML = '<div class="d2d-pi-empty">No county record found for this address.</div>'; return; }
    const s = intel.roofScore;
    const col = s == null ? '#6B7280' : (s <= 40 ? '#E05252' : s <= 70 ? '#EAB308' : '#2ECC8A');
    const rows = [];
    if (intel.owner) rows.push(['Owner', esc(intel.owner)]);
    if (intel.yearBuilt) rows.push(['Built', intel.yearBuilt + (intel.roofAge != null ? ' · ~' + intel.roofAge + 'yr roof' : '')]);
    if (intel.assessedValue) rows.push(['Assessed', '$' + Number(intel.assessedValue).toLocaleString()]);
    if (intel.sqft) rows.push(['Size', Number(intel.sqft).toLocaleString() + ' sqft']);
    const bp = _ballpark(intel.sqft);
    if (bp) rows.push(['Ballpark', '$' + bp.min.toLocaleString() + '–$' + bp.max.toLocaleString()]);
    if (!rows.length) { target.innerHTML = '<div class="d2d-pi-empty">County record found, but no owner/build detail.</div>'; return; }
    target.innerHTML =
      '<div class="d2d-pi-card">' +
        (s != null ? '<div class="d2d-pi-score" style="background:' + col + ';">' + s + '<span>ROOF</span></div>' : '') +
        '<div class="d2d-pi-rows">' + rows.map(r => '<div class="d2d-pi-row"><span class="d2d-pi-k">' + r[0] + '</span><span class="d2d-pi-v">' + r[1] + '</span></div>').join('') + '</div>' +
      '</div>' +
      (knockId ? '<button class="d2d-pi-order" data-d2d-action="orderRoofReport" data-d2d-id="' + esc(knockId) + '">📐 Order precise roof report</button>' : '') +
      '<div class="d2d-pi-measurebox" id="d2d-rr-' + esc(knockId || '') + '"></div>';
  }

  // Precise roof measurement (paid aerial report) — confirm + per-address guard
  // because each order bills a vendor $30–50 and there's no server-side dedup.
  function _measureKey(addr) { return 'nbd_d2d_measure_' + normalizeAddress(addr); }
  function renderMeasurement(box, meas) {
    if (!box) return;
    const rawSqft = Number(meas && meas.rawSqft) || 0;
    const sq = rawSqft > 0 ? (rawSqft * 1.17 / 100) : 0; // 1.17 waste factor → squares
    // Better tier's $/SQ from estimate-config.js (was a literal 595 that
    // outlived the 2026-10-02 repricing).
    const _betterRate = (window.NBD_ESTIMATE_CONFIG && window.NBD_ESTIMATE_CONFIG.TIER_RATES && window.NBD_ESTIMATE_CONFIG.TIER_RATES.better) || 660;
    const est = sq > 0 ? Math.max(2500, Math.round((sq * _betterRate) / 25) * 25) : null;
    const rows = [];
    if (sq > 0) rows.push(['Roof', sq.toFixed(1) + ' squares']);
    if (meas && meas.pitch) rows.push(['Pitch', esc(String(meas.pitch))]);
    if (est) rows.push(['Est. job', '$' + est.toLocaleString()]);
    // Vendor-supplied URL: http(s) only (blocks javascript:) + escapeHtml (esc
    // does NOT escape the quote that closes the href attribute).
    if (meas && meas.reportUrl && /^https?:\/\//i.test(String(meas.reportUrl))) {
      rows.push(['Report', '<a href="' + escapeHtml(String(meas.reportUrl)) + '" target="_blank" rel="noopener" class="d2d-detail-link">Open PDF ↗</a>']);
    }
    box.innerHTML = '<div class="d2d-pi-measure-hd">📐 Precise measurement</div>' +
      rows.map(r => '<div class="d2d-pi-row"><span class="d2d-pi-k">' + r[0] + '</span><span class="d2d-pi-v">' + r[1] + '</span></div>').join('');
  }
  function pollMeasurement(jobId, knockId, statusEl) {
    const box = statusEl || document.getElementById('d2d-rr-' + knockId);
    if (!box || !window.getDoc || !window.doc || !window._db) return;
    let tries = 0;
    const tick = async () => {
      tries++;
      try {
        const snap = await window.getDoc(window.doc(window._db, 'measurements', jobId));
        const d = (snap && snap.exists && snap.exists()) ? snap.data() : null;
        if (d && d.status === 'ready' && d.measurements) { renderMeasurement(box, d.measurements); return; }
      } catch (_) {}
      if (tries < 120) setTimeout(tick, 5000); // ~10 min
    };
    tick();
  }
  async function orderRoofReport(knockId, btnEl) {
    const knock = state.knocks.find(k => k.id === knockId);
    if (!knock || !knock.address) return;
    const box = document.getElementById('d2d-rr-' + knockId);
    const key = _measureKey(knock.address);
    const prior = (() => { try { return localStorage.getItem(key); } catch (_) { return null; } })();
    if (prior && prior.indexOf('pending:') === 0) {
      // An order for this address is mid-flight (claimed before the paid call).
      // A recent claim blocks a duplicate; a stale one (>2 min, e.g. a crash mid-
      // order) is allowed to retry.
      if (Date.now() - (Number(prior.slice(8)) || 0) < 120000) { window.showToast?.('An order for this address is already in progress', 'info'); return; }
    } else if (prior) {
      window.showToast?.('Already ordered for this address — checking status', 'info');
      if (box) box.innerHTML = '<div class="d2d-pi-measure-hd">📐 Measurement ordered — checking…</div>';
      pollMeasurement(prior, knockId); return;
    }
    // Claim the address BEFORE the confirm + paid call so a second click / re-
    // render can't start a parallel order (each vendor order bills $30–50 with
    // no server-side dedup). Released on cancel or failure.
    try { localStorage.setItem(key, 'pending:' + Date.now()); } catch (_) {}
    const ok = await uiConfirm('Order a precise aerial roof measurement for this address? This buys a paid report from our measurement provider (used to build an exact estimate).', { okLabel: 'Order report' });
    if (!ok) { try { localStorage.removeItem(key); } catch (_) {} return; }
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Ordering…'; }
    try {
      if (!window._functions || !window._httpsCallable) {
        const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      const fn = window._httpsCallable(window._functions, 'requestMeasurement');
      // The knock pin IS the roof point — send it so the server never has to
      // geocode the address (Instant Roofer measures from coordinates).
      const hasPin = typeof knock.lat === 'number' && typeof knock.lng === 'number' && isFinite(knock.lat) && isFinite(knock.lng);
      const res = await fn(hasPin ? { address: knock.address, lat: knock.lat, lng: knock.lng } : { address: knock.address });
      const d = (res && res.data) || {};
      if (!d.jobId) throw new Error('no-job');
      try { localStorage.setItem(key, d.jobId); } catch (_) {}
      const eta = Number(d.estimatedMinutes) || 30;
      if (btnEl) btnEl.style.display = 'none';
      if (box) box.innerHTML = '<div class="d2d-pi-measure-hd">📐 ' + (d.status === 'ready' ? 'Measurement ready' : 'Ordered — ready in ~' + eta + ' min') + '</div>';
      window.showToast?.(d.status === 'ready' ? 'Measurement ready!' : 'Report ordered — arrives in ~' + eta + ' min', 'success');
      pollMeasurement(d.jobId, knockId);
    } catch (e) {
      try { localStorage.removeItem(key); } catch (_) {} // release the claim so a retry works
      const code = String((e && (e.code || e.message)) || '');
      const rl = /resource-exhausted|429/i.test(code);
      const cfg = /failed-precondition|not.?set|configured/i.test(code);
      window.showToast?.(rl ? 'Too many orders — try again in an hour' : cfg ? 'Measurement provider not set up' : 'Could not order the report', 'error');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '📐 Order precise roof report'; }
    }
  }
  async function loadPropertyIntel(knockId, btnEl) {
    const knock = state.knocks.find(k => k.id === knockId);
    const target = document.getElementById('d2d-pi-' + knockId);
    if (!knock || !knock.address || !target) return;
    const key = normalizeAddress(knock.address);
    if (_piCache.has(key)) { renderPropertyIntel(target, _piCache.get(key), knockId); return; }
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Loading…'; }
    try {
      if (!window._functions || !window._httpsCallable) {
        const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      const fn = window._httpsCallable(window._functions, 'lookupParcel');
      const res = await fn({ address: knock.address });
      const p = (res && res.data && res.data.parcel) || null;
      if (!p) { _piCache.set(key, null); renderPropertyIntel(target, null, knockId); return; }
      const yr = Number(p.yearBuilt) || null;
      const roofAge = yr ? Math.max(0, new Date().getFullYear() - yr) : null;
      const intel = {
        owner: p.owner || null, yearBuilt: yr, roofAge,
        roofScore: (yr ? _roofScore(roofAge, yr) : null),
        assessedValue: p.assessedValue || null, sqft: p.sqft || null,
        county: p.county || null
      };
      _piCache.set(key, intel);
      renderPropertyIntel(target, intel, knockId);
    } catch (e) {
      const rl = e && (e.code === 'resource-exhausted' || e.code === 'functions/resource-exhausted');
      window.showToast?.(rl ? 'Too many lookups — try again in an hour' : 'Property lookup unavailable', rl ? 'warning' : 'error');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🏠 Load owner & roof intel'; }
    }
  }

  // ============================================================================
  // WEATHER INTEGRATION
  // ============================================================================
  async function loadWeather() {
    const key = localStorage.getItem(WEATHER_KEY_STORE);
    if (!key) return;
    const loc = state.currentLocation || CINCINNATI;
    try {
      const resp = await fetch(`https://api.openweathermap.org/data/2.5/onecall?lat=${loc[0]}&lon=${loc[1]}&exclude=minutely,hourly&appid=${key}&units=imperial`);
      if (resp.ok) {
        state.weatherData = await resp.json();
      }
    } catch(e) { console.warn('Weather load failed:', e); }
  }

  function getWeatherAlerts() {
    if (!state.weatherData) return [];
    const alerts = [];
    if (state.weatherData.alerts) {
      state.weatherData.alerts.forEach(a => {
        if (/hail|wind|storm|tornado|thunder/i.test(a.event)) {
          alerts.push({ event: a.event, description: a.description?.substring(0, 200), start: new Date(a.start * 1000), end: new Date(a.end * 1000) });
        }
      });
    }
    // Check recent weather for storm indicators
    const recent = state.weatherData.daily?.slice(0, 3) || [];
    recent.forEach(day => {
      if (day.wind_speed > 30 || day.weather?.some(w => /storm|hail|thunder/i.test(w.main))) {
        alerts.push({ event: 'Recent Storm Activity', description: `Wind: ${Math.round(day.wind_speed)}mph — ${day.weather?.[0]?.description || ''}`, start: new Date(day.dt * 1000) });
      }
    });
    return alerts;
  }

  // ============================================================================
  // NEIGHBORHOOD SCORING
  // ============================================================================
  function calculateNeighborhoodScores() {
    // Group knocks by approximate neighborhood (0.005 degree grid ~500m)
    const grid = {};
    state.knocks.forEach(k => {
      if (!k.lat || !k.lng) return;
      const key = `${(Math.round(k.lat / 0.005) * 0.005).toFixed(3)},${(Math.round(k.lng / 0.005) * 0.005).toFixed(3)}`;
      if (!grid[key]) grid[key] = { lat: k.lat, lng: k.lng, knocks: [], appointments: 0, stormDmg: 0, conversations: 0 };
      grid[key].knocks.push(k);
      if (k.disposition === 'appointment') grid[key].appointments++;
      if (k.disposition === 'storm_damage') grid[key].stormDmg++;
      if (isConversation(k.disposition)) grid[key].conversations++;
    });

    const scores = {};
    Object.keys(grid).forEach(key => {
      const g = grid[key];
      const totalKnocks = g.knocks.length;
      const convRate = totalKnocks > 0 ? g.conversations / totalKnocks : 0;
      const apptRate = totalKnocks > 0 ? g.appointments / totalKnocks : 0;
      const stormFactor = g.stormDmg > 0 ? 20 : 0;
      const densityFactor = Math.min(totalKnocks / 20, 1) * 15;
      const convFactor = convRate * 40;
      const apptFactor = apptRate * 25;
      const score = Math.min(Math.round(densityFactor + convFactor + apptFactor + stormFactor), 100);
      scores[key] = { ...g, score };
    });
    state.neighborhoodScores = scores;
    return scores;
  }

  // ============================================================================
  // STREET SEQUENCING
  // ============================================================================
  function buildStreetSequences() {
    const streets = {};
    state.knocks.forEach(k => {
      if (!k.address) return;
      const street = parseStreetName(k.address);
      if (!street || street.length < 3) return;
      if (!streets[street]) streets[street] = [];
      const num = parseHouseNumber(k.address);
      const existing = streets[street].find(d => d.address === k.address);
      if (!existing) {
        streets[street].push({ address: k.address, houseNum: num, lat: k.lat, lng: k.lng, knocked: true, disposition: k.disposition, knockId: k.id });
      }
    });

    // Sort each street by house number
    Object.keys(streets).forEach(st => {
      streets[st].sort((a, b) => a.houseNum - b.houseNum);
      // Fill in gaps (even numbers on one side, odd on the other)
      const nums = streets[st].map(d => d.houseNum).filter(n => n > 0);
      if (nums.length >= 2) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        // Audit #17: both ternary branches returned 2 — so mixed-parity streets
        // (e.g. odd-west + even-east side of the same street) produced duplicate
        // ghost addresses. If all house numbers share parity we step 2 (skip
        // the opposite side), otherwise 1 (canvas both sides sequentially).
        const allEven = nums.every(n => n % 2 === 0);
        const allOdd = nums.every(n => n % 2 === 1);
        const step = (allEven || allOdd) ? 2 : 1;
        for (let n = min; n <= max; n += step) {
          if (!streets[st].find(d => d.houseNum === n)) {
            streets[st].push({ address: `${n} ${st}`, houseNum: n, lat: null, lng: null, knocked: false, disposition: null, knockId: null });
          }
        }
        streets[st].sort((a, b) => a.houseNum - b.houseNum);
      }
    });

    state.streetSequences = streets;
    return streets;
  }

  // ============================================================================
  // WALKING ROUTE OPTIMIZATION
  // ----------------------------------------------------------------------------
  // Strategy: nearest-neighbor for an initial path, then a 2-opt swap pass to
  // remove crossings. Real haversine distance (window.hav from maps.js, feet)
  // is used instead of planar Euclidean so the route is accurate even when
  // the route spans a few miles in WGS-84 coordinates. Falls back to Euclidean
  // if maps.js hasn't loaded yet — same behavior as before for that branch.
  //
  // Step 5: route is decorated with `_stats` so the renderer + toast can show
  // total distance and walking time (3 mph) without recomputing.
  // ============================================================================

  // Pace constants. 3 mph is a moderate D2D walking pace including pauses at
  // each door — conservative enough that reps don't underestimate timing.
  const WALK_SPEED_MPH = 3;
  const FEET_PER_MILE = 5280;

  function _segmentFeet(a, b) {
    if (typeof window.hav === 'function') {
      // hav() returns feet; signature expects { lat, lng } pairs.
      return window.hav({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    }
    // Fallback: degrees-squared. Wildly imprecise but keeps the sort order
    // self-consistent so the route is still nearest-neighbor-ish.
    return Math.sqrt(
      Math.pow(b.lat - a.lat, 2) + Math.pow(b.lng - a.lng, 2)
    ) * 364000; // rough degrees → feet at mid-latitudes (~1 deg ≈ 69 miles)
  }

  function _routeLengthFeet(points) {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      total += _segmentFeet(points[i], points[i + 1]);
    }
    return total;
  }

  // 2-opt swap pass — for each pair of non-adjacent edges (i,i+1) and (j,j+1),
  // try reversing the slice between them. If the resulting route is shorter,
  // keep the swap. Repeat until no improvement is found OR we hit MAX_PASSES,
  // which guards against pathological inputs. O(n²) per pass; cheap up to ~50
  // stops, which is well above what a rep walks in a day.
  function _twoOpt(points) {
    if (points.length < 4) return points;
    const MAX_PASSES = 50;
    let best = points.slice();
    let bestLen = _routeLengthFeet(best);
    let improved = true;
    let passes = 0;

    while (improved && passes < MAX_PASSES) {
      improved = false;
      passes++;
      for (let i = 1; i < best.length - 2; i++) {
        for (let j = i + 1; j < best.length - 1; j++) {
          // Reverse the slice [i..j] and measure. Cheap to do as a copy here
          // since path lengths are small; profiler can switch to delta-cost
          // if this ever becomes hot.
          const candidate = best.slice(0, i)
            .concat(best.slice(i, j + 1).reverse())
            .concat(best.slice(j + 1));
          const len = _routeLengthFeet(candidate);
          if (len + 0.5 < bestLen) { // 0.5ft tolerance avoids float noise
            best = candidate;
            bestLen = len;
            improved = true;
          }
        }
      }
    }
    return best;
  }

  function calculateWalkingRoute() {
    const unvisited = [];

    // Get latest knock per address for pins
    // Audit #18: raw `k.createdAt > other.createdAt` compared Firestore
    // Timestamp objects, which coerce to `NaN > NaN === false` — meaning the
    // "latest" rule never actually replaced the first-seen knock. Normalize
    // both sides through toDate() so the comparison is numeric.
    const addrMap = new Map();
    state.knocks.forEach(k => {
      if (!k.lat || !k.lng) return;
      const norm = normalizeAddress(k.address);
      const existing = addrMap.get(norm);
      const kMs = (toDate(k.createdAt) || new Date(0)).getTime();
      const eMs = existing ? (toDate(existing.createdAt) || new Date(0)).getTime() : -Infinity;
      if (!existing || kMs > eMs) {
        addrMap.set(norm, k);
      }
    });

    // Never route to a door that was EVER flagged Do-Not-Knock or Cold/Dead —
    // even if a later 'not_home' knock exists for the same address.
    const blocked = new Set();
    state.knocks.forEach(k => {
      if (['do_not_knock', 'cold_dead'].includes(k.disposition)) blocked.add(normalizeAddress(k.address));
    });

    // Filter to "not home" / "come back" that haven't been fully resolved
    addrMap.forEach(k => {
      if (blocked.has(normalizeAddress(k.address))) return;
      // Re-visit candidates: no-answer doors worth another try. 'revisit' is the
      // new primary no-answer flag; 'come_back' now means the prospect asked you
      // to return in person — both are doors to route back to.
      if (['not_home', 'revisit', 'come_back'].includes(k.disposition) && getAttemptCount(k.address) < MAX_ATTEMPTS) {
        unvisited.push({ lat: k.lat, lng: k.lng, address: k.address, disposition: k.disposition });
      }
    });

    if (unvisited.length < 2) {
      state.walkingRoute = unvisited;
      if (state.walkingRoute) state.walkingRoute._stats = { stopCount: unvisited.length, totalFeet: 0, totalMiles: 0, walkMinutes: 0 };
      return unvisited;
    }

    // ─── Pass 1: nearest-neighbor from current location or first point ───
    const start = state.currentLocation ? { lat: state.currentLocation[0], lng: state.currentLocation[1] } : unvisited[0];
    let route = [];
    const remaining = [...unvisited];
    let current = start;

    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = _segmentFeet(current, remaining[i]);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }
      const next = remaining.splice(nearestIdx, 1)[0];
      route.push(next);
      current = next;
    }

    // ─── Pass 2: 2-opt swap pass to remove crossings ───
    // We prepend `start` to the path during optimization so the 2-opt knows
    // the rep's anchor point. Strip it back off afterward so the public
    // route array still represents "stops" (not including the rep's
    // starting position, which the renderer adds as an implicit origin).
    const withAnchor = [start, ...route];
    const optimized = _twoOpt(withAnchor);
    // Drop the anchor from index 0 — but only if 2-opt didn't move it.
    // If it did, the path is still valid; we just keep the new order.
    route = optimized[0] === start ? optimized.slice(1) : optimized;

    // ─── Stats: total distance + walking time at 3 mph ───
    const totalFeet = _routeLengthFeet([start, ...route]);
    const totalMiles = totalFeet / FEET_PER_MILE;
    const walkMinutes = (totalMiles / WALK_SPEED_MPH) * 60;
    route._stats = {
      stopCount: route.length,
      totalFeet,
      totalMiles,
      walkMinutes
    };

    state.walkingRoute = route;
    return route;
  }

  function drawWalkingRoute() {
    if (state.walkingRouteLine && state.d2dMap) state.d2dMap.removeLayer(state.walkingRouteLine);
    if (!state.walkingRoute || state.walkingRoute.length < 2 || !state.d2dMap) return;

    const coords = state.walkingRoute.map(p => [p.lat, p.lng]);
    if (state.currentLocation) coords.unshift(state.currentLocation);

    state.walkingRouteLine = L.polyline(coords, {
      color: '#4A9EFF',
      weight: 3,
      opacity: 0.7,
      dashArray: '10, 8',
      className: 'd2d-route-line'
    }).addTo(state.d2dMap);

    // Number markers
    state.walkingRoute.forEach((p, i) => {
      const numIcon = L.divIcon({
        html: `<div style="background:var(--blue,#4A9EFF);color:white;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid white;">${i + 1}</div>`,
        iconSize: [20, 20],
        className: ''
      });
      L.marker([p.lat, p.lng], { icon: numIcon }).addTo(state.d2dMap).bindPopup(`<b>Stop ${i + 1}</b><br>${esc(p.address)}`);
    });
  }

  function clearWalkingRoute() {
    if (state.walkingRouteLine && state.d2dMap) state.d2dMap.removeLayer(state.walkingRouteLine);
    state.walkingRouteLine = null;
    state.walkingRoute = null;
  }

  // Hand the optimized route to the phone's native map app for turn-by-turn.
  // Google Maps dir URL: origin + up to ~9 waypoints + destination, walking.
  function openRouteInMaps() {
    const route = state.walkingRoute || [];
    const pts = route.filter(p => p.lat != null && p.lng != null);
    if (!pts.length) { window.showToast?.('Calculate a route first', 'info'); return; }
    const origin = state.currentLocation ? `${state.currentLocation[0]},${state.currentLocation[1]}` : '';
    const dest = `${pts[pts.length - 1].lat},${pts[pts.length - 1].lng}`;
    const mids = pts.slice(0, -1).slice(0, 9).map(p => `${p.lat},${p.lng}`).join('|');
    let url = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' + encodeURIComponent(dest);
    if (origin) url += '&origin=' + encodeURIComponent(origin);
    if (mids) url += '&waypoints=' + encodeURIComponent(mids);
    window.open(url, '_blank');
    if (pts.length > 10) window.showToast?.('Opened first 10 stops — maps apps cap waypoints', 'info');
  }

  // ============================================================================
  // FIRESTORE CRUD
  // ============================================================================
  async function loadRepProfile() {
    // Signed-out / auth-not-restored guard: every branch below (including
    // the old catch) dereferenced window._user.uid, so a missing user threw
    // straight through initD2D's Promise.race. Degrade to no profile — the
    // shell still renders and the next tab entry retries.
    if (!window._user || !window._user.uid) { state.currentRep = null; return; }
    try {
      const docSnap = await window.getDoc(window.doc(window._db, 'reps', window._user.uid));
      if (docSnap.exists()) {
        state.currentRep = docSnap.data();
        // role is no longer persisted on /reps (reserved field — see create
        // branch); derive it from custom claims when the stored doc omits it.
        if (state.currentRep && !state.currentRep.role) state.currentRep.role = window._userClaims?.role || 'rep';
      } else {
        const initials = (window._user.displayName || 'R').split(' ').map(n => n[0]).join('').toUpperCase();
        const {setDoc} = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
        // The /reps create rule FORBIDS a `role` (or `isAdmin`) key on the doc
        // — role is reserved for admin-SDK / custom-claim assignment to prevent
        // client-side privilege escalation. Writing role:'rep' here made every
        // new rep's profile create permission-denied (silently swallowed by the
        // catch below), so it never persisted. Persist only rule-allowed fields
        // and derive the role in-memory from custom claims.
        await setDoc(window.doc(window._db, 'reps', window._user.uid), {
          userId: window._user.uid,
          name: window._user.displayName || 'Rep',
          initials: initials,
          companyId: window._userClaims?.companyId || window._user.uid,
          createdAt: window.serverTimestamp()
        });
        state.currentRep = { userId: window._user.uid, name: window._user.displayName || 'Rep', initials, role: window._userClaims?.role || 'rep', companyId: window._userClaims?.companyId || window._user.uid };
      }
    } catch (e) {
      console.error('loadRepProfile failed:', e);
      state.currentRep = { userId: window._user?.uid, name: window._user?.displayName || 'Rep', role: window._userClaims?.role || 'rep', companyId: window._userClaims?.companyId || window._user?.uid };
    }
  }

  // Max knocks loaded per call. A rep doing 40/day for a full year is ~14k
  // docs — loading all of them at once blows mobile RAM and stalls the UI
  // for ~8–10s on cold start. 500 is ~12 active days for a heavy knocker,
  // which covers every practical feed filter (`today` / `week` / `month`).
  // `Load older knocks` button extends via a cursor query when needed.
  const KNOCK_PAGE_SIZE = 500;

  async function loadKnocks() {
    // Same signed-out guard as loadRepProfile — the rep-scoped query below
    // reads window._user.uid.
    if (!window._user || !window._user.uid) { state.knocks = state.knocks || []; return; }
    try {
      let q;
      // orderBy + limit require the composite index at
      // firestore.indexes.json:62 (userId + createdAt desc) which already
      // exists. Team-mode needs companyId + createdAt; if that index is
      // missing the query throws and the catch falls back gracefully.
      if (state.teamMode && state.currentRep?.role === 'manager') {
        q = window.query(
          window.collection(window._db, 'knocks'),
          window.where('companyId', '==', state.currentRep.companyId),
          window.orderBy('createdAt', 'desc'),
          window.limit(KNOCK_PAGE_SIZE)
        );
      } else {
        q = window.query(
          window.collection(window._db, 'knocks'),
          window.where('userId', '==', window._user.uid),
          window.orderBy('createdAt', 'desc'),
          window.limit(KNOCK_PAGE_SIZE)
        );
      }
      const snap = await window.getDocs(q);
      state.knocks = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          createdAt: toDate(data.createdAt) || new Date(0),
          updatedAt: toDate(data.updatedAt) || new Date(0),
          followUpDate: toDate(data.followUpDate) || null
        };
      }).sort((a, b) => b.createdAt - a.createdAt);

      // Rebuild derived data
      buildStreetSequences();
      calculateNeighborhoodScores();
      updateNavBadge();
      state.lastKnockLoadError = null; // clean load — clear any stale error
    } catch (e) {
      console.error('loadKnocks failed:', e);
      // Record the failure so runMapDiagnostics() can distinguish a silent
      // load failure (#3) from a genuinely-empty account (#2) — on screen they
      // look identical.
      state.lastKnockLoadError = { message: String((e && e.message) || e), at: Date.now() };
      // Common failure: composite index missing. Fall back to unbounded
      // query (old behavior) so the rep isn't stranded, but warn.
      if (String(e.message || '').toLowerCase().includes('index')) {
        console.warn('Knocks index missing — falling back to unbounded query. Deploy firestore.indexes.json.');
        try {
          const fallback = state.teamMode && state.currentRep?.role === 'manager'
            ? window.query(window.collection(window._db, 'knocks'), window.where('companyId', '==', state.currentRep.companyId))
            : window.query(window.collection(window._db, 'knocks'), window.where('userId', '==', window._user.uid));
          const snap2 = await window.getDocs(fallback);
          state.knocks = snap2.docs.map(d => {
            const data = d.data();
            return {
              id: d.id,
              ...data,
              createdAt: toDate(data.createdAt) || new Date(0),
              updatedAt: toDate(data.updatedAt) || new Date(0),
              followUpDate: toDate(data.followUpDate) || null
            };
          }).sort((a, b) => b.createdAt - a.createdAt);
          buildStreetSequences();
          calculateNeighborhoodScores();
          updateNavBadge();
          state.lastKnockLoadError = null; // fallback succeeded — not a failure
          return;
        } catch (e2) { console.error('fallback loadKnocks also failed:', e2); }
      }
      window.showToast?.('Failed to load knocks', 'error');
    }
  }

  // Max knocks pulled by a single "Search this area" viewport query. The
  // default first paint (loadKnocks, 500 most-recent) is unchanged — this is
  // the OPT-IN spatial pull for whatever the map is currently showing, so a
  // rep can pan to territory OLDER than their 500 most-recent knocks and still
  // see it. Bounded so a dense downtown viewport can't blow mobile RAM.
  const VIEWPORT_KNOCK_LIMIT = 1000;

  // Load the knocks that fall inside the map's CURRENT viewport, regardless of
  // recency — the fix for the "pan to old territory → zero pins" gap left by
  // loadKnocks's `orderBy(createdAt desc) + limit(500)` (which is not spatially
  // scoped at all).
  //
  // Firestore has no native geo-query and permits a range filter on only ONE
  // field, so we range-filter `lat` server-side (needs a [userId|companyId,
  // lat] composite index — see firestore.indexes.json) and filter `lng`
  // client-side. Tenancy is preserved: the query is ALWAYS scoped to the rep's
  // userId, or the company in manager team-mode — identical scoping to
  // loadKnocks — so this NEVER widens the read surface. Results are MERGED into
  // state.knocks (dedup by id) so the default recent set stays visible too.
  async function loadKnocksInViewport() {
    if (!window._user || !window._user.uid || !state.d2dMap) return { matched: 0, added: 0 };
    const bnds = state.d2dMap.getBounds();
    const south = bnds.getSouth(), north = bnds.getNorth();
    const west = bnds.getWest(), east = bnds.getEast();
    try {
      // Same tenancy branch as loadKnocks — team managers read the company,
      // everyone else reads their own uid.
      const scope = (state.teamMode && state.currentRep?.role === 'manager')
        ? window.where('companyId', '==', state.currentRep.companyId)
        : window.where('userId', '==', window._user.uid);
      const q = window.query(
        window.collection(window._db, 'knocks'),
        scope,
        window.where('lat', '>=', south),
        window.where('lat', '<=', north),
        window.orderBy('lat'),
        window.limit(VIEWPORT_KNOCK_LIMIT)
      );
      const snap = await window.getDocs(q);
      const byId = new Map(state.knocks.map(k => [k.id, k]));
      const before = byId.size;
      let matched = 0;
      snap.docs.forEach(d => {
        const data = d.data();
        // Server range only bounded latitude — filter longitude client-side.
        const lng = (typeof data.lng === 'number') ? data.lng : parseFloat(data.lng);
        if (!(lng >= west && lng <= east)) return;
        matched++;
        byId.set(d.id, {
          id: d.id,
          ...data,
          createdAt: toDate(data.createdAt) || new Date(0),
          updatedAt: toDate(data.updatedAt) || new Date(0),
          followUpDate: toDate(data.followUpDate) || null
        });
      });
      state.knocks = Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
      // Rebuild derived data (same trio as loadKnocks) now that the set grew.
      buildStreetSequences();
      calculateNeighborhoodScores();
      updateNavBadge();
      return { matched, added: byId.size - before, capped: snap.size >= VIEWPORT_KNOCK_LIMIT };
    } catch (e) {
      console.error('loadKnocksInViewport failed:', e);
      // A missing composite index is the one expected first-run failure — the
      // [userId, lat] / [companyId, lat] indexes ship in this change and BUILD
      // asynchronously on deploy. Surface it honestly rather than falling back
      // to an unbounded read; the whole point of viewport search is to NOT pull
      // the world.
      const indexBuilding = String(e.message || '').toLowerCase().includes('index');
      return { matched: 0, added: 0, error: true, indexBuilding };
    }
  }

  // Plain refresh — re-pull the default 500 most-recent knocks and repaint the
  // map + feed, without a full page reload. There was previously no way to
  // re-pull knocks short of reloading the whole app.
  async function refreshKnocks() {
    await loadKnocks();
    refreshMapMarkers();
    if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
  }

  // ── MAP DATA DIAGNOSTIC ───────────────────────────────────────────────
  // Answers "why is my map empty?" definitively, without a console. It cross-
  // checks three numbers and names the exact cause from the issue's ranked
  // hypotheses:
  //   • loaded     — knocks currently in state.knocks
  //   • withCoords — how many of those actually have lat/lng (can be placed)
  //   • total      — the TRUE server-side count for this identity, via a
  //                  getCountFromServer aggregation (cheap: no doc reads, and
  //                  an equality-only filter needs no composite index)
  // plus state.lastKnockLoadError (a silent load failure).
  //   total === 0                      → #2 genuinely zero for this account
  //   lastKnockLoadError set           → #3 silent load failure
  //   total > loaded AND loaded==cap   → #1 the 500 recency cap
  //   loaded > 0 AND withCoords === 0  → #4 knocks lack lat/lng
  //   withCoords > 0                   → #5 zoom/clustering (data is fine)
  // Tenancy is preserved: the count query is scoped to userId / companyId
  // exactly like loadKnocks — it never widens the read surface.
  async function runMapDiagnostics() {
    const knocks = Array.isArray(state.knocks) ? state.knocks : [];
    const loaded = knocks.length;
    const withCoords = knocks.filter(k =>
      typeof k.lat === 'number' && !isNaN(k.lat) &&
      typeof k.lng === 'number' && !isNaN(k.lng)).length;
    const capped = loaded >= KNOCK_PAGE_SIZE;
    const loadError = state.lastKnockLoadError || null;

    let total = null, countError = null;
    try {
      if (window._user && window._user.uid && window._db) {
        const { getCountFromServer } = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
        const scope = (state.teamMode && state.currentRep?.role === 'manager')
          ? window.where('companyId', '==', state.currentRep.companyId)
          : window.where('userId', '==', window._user.uid);
        const snap = await getCountFromServer(window.query(window.collection(window._db, 'knocks'), scope));
        total = snap.data().count;
      }
    } catch (e) {
      countError = String((e && e.message) || e);
    }

    let verdict;
    if (loadError) {
      verdict = `⚠️ Knocks FAILED to load (#3): "${loadError.message}". Your data may be fine — tap ↻ to retry.`;
    } else if (total === 0) {
      verdict = `✅ Your account genuinely has 0 knocks (#2). The empty map is correct. If you expected history here, it was likely logged under a different login or company.`;
    } else if (total != null && total > loaded && capped) {
      verdict = `📦 Recency cap (#1): ${total} knocks total, but only your ${loaded} most-recent are loaded. Pan to the area you want and tap “Search this area”.`;
    } else if (loaded > 0 && withCoords === 0) {
      verdict = `📍 No coordinates (#4): ${loaded} knocks loaded but none have lat/lng, so none can be placed — they were saved without a GPS fix.`;
    } else if (withCoords > 0) {
      verdict = `👍 ${withCoords} of ${loaded} loaded knocks have coordinates and should be on the map. Seeing none is a zoom/clustering view issue (#5) — zoom to your territory.`;
    } else {
      verdict = `Loaded ${loaded}${total != null ? ' of ' + total : ''} knocks.`;
    }

    // ── Navigation health ──────────────────────────────────────────
    // Turns the phone eyeball into a definitive readout: is GPS fixing, is the
    // compass actually feeding heading (vs GPS-course fallback), is rotation
    // live — and it surfaces heading° + bearing° together so the map-spin sign
    // is inspectable (if bearing ≈ -heading the plugin's applied setBearing(-deg)).
    const bearing = (state.d2dMap && typeof state.d2dMap.getBearing === 'function')
      ? Math.round(state.d2dMap.getBearing()) : null;
    const gpsFixAgeSec = state.gpsFixAt ? Math.round((Date.now() - state.gpsFixAt) / 1000) : null;
    const nav = {
      gpsFix: !!state.currentLocation,
      gpsAccuracyM: (typeof state.gpsAccuracy === 'number') ? Math.round(state.gpsAccuracy) : null,
      gpsFixAgeSec: gpsFixAgeSec,
      compassSupported: (typeof DeviceOrientationEvent !== 'undefined'),
      compassNeedsPermission: (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'),
      compassActive: _compassActive,
      heading: (state.d2dHeading != null) ? Math.round(state.d2dHeading) : null,
      headingSource: _compassActive ? 'compass' : (state.d2dHeading != null ? 'gps-course' : 'none'),
      follow: state.d2dFollowMode ? (state.d2dFollowPaused ? 'paused' : 'on') : 'off',
      rotation: state.d2dRotateEnabled ? (_rotateReady ? 'on' : 'starting') : 'off',
      rotationPluginLoaded: _rotatePluginPresent(),
      bearing: bearing
    };

    const fmtGps = nav.gpsFix
      ? `fix ${gpsFixAgeSec != null ? gpsFixAgeSec + 's ago' : 'active'}${nav.gpsAccuracyM != null ? ', ±' + nav.gpsAccuracyM + 'm' : ''}`
      : 'no fix yet';
    const fmtCompass = !nav.compassSupported ? 'not supported on this device'
      : nav.compassActive ? 'active'
      : (nav.compassNeedsPermission ? 'off (tap 🧭 Follow to grant)' : 'off (uses GPS course when moving)');
    const fmtHeading = (nav.heading != null) ? `${nav.heading}° (${nav.headingSource})` : '—';
    const fmtRotation = nav.rotation === 'off' ? 'off'
      : `${nav.rotation}${nav.bearing != null ? ', bearing ' + nav.bearing + '°' : ''}${nav.rotationPluginLoaded ? '' : ' (plugin not loaded)'}`;

    const detail = {
      loadedOnMap: loaded,
      withCoordinates: withCoords,
      totalInAccount: total,
      atRecencyCap: capped,
      lastLoadError: loadError ? loadError.message : null,
      countError,
      navigation: nav,
      verdict
    };
    console.log('[D2D map diagnostics]', detail);

    const msg = [
      'DATA',
      `  Loaded on map: ${loaded}${capped ? ` (at the ${KNOCK_PAGE_SIZE} cap)` : ''}`,
      `  With coordinates: ${withCoords}`,
      total != null ? `  Total in account: ${total}`
        : (countError ? `  Total: couldn't reach server` : `  Total: unknown`),
      loadError ? `  Last load: FAILED (${loadError.message})` : `  Last load: OK`,
      '',
      'NAVIGATION',
      `  GPS: ${fmtGps}`,
      `  Compass: ${fmtCompass}`,
      `  Heading: ${fmtHeading}`,
      `  Follow: ${nav.follow}`,
      `  Rotation: ${fmtRotation}`,
      '',
      verdict
    ].join('\n');

    // Prefer the iOS-safe DOM modal; fall back to a long toast, then console.
    try {
      if (typeof uiConfirm === 'function') { await uiConfirm(msg, { okLabel: 'Got it' }); }
      else { window.showToast?.(verdict, loadError ? 'error' : 'info', 9000); }
    } catch (_) { window.showToast?.(verdict, loadError ? 'error' : 'info', 9000); }

    return detail;
  }

  // Wrap a Firestore promise in a timeout so iOS Safari bfcache zombies
  // (where the SDK has a dead WebSocket but never rejects) surface as
  // an error the caller can handle instead of hanging the UI forever.
  function _withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms))
    ]);
  }

  async function submitKnock(data, fromSync) {
    if (!state.isOnline && !fromSync) {
      enqueueOffline('submitKnock', data);
      return null;
    }

    try {
      const attemptNumber = getAttemptCount(data.address) + 1;
      let disposition = data.disposition;

      if (attemptNumber > MAX_ATTEMPTS && disposition === 'not_home') {
        disposition = 'cold_dead';
        window.showToast?.('5 attempts reached — marked as Cold/Dead', 'warning');
      }

      let followUpDate = null;
      const fupInput = data.followUpDate;
      if (fupInput) {
        // A date-only string from <input type="date"> ('2026-09-04') is parsed
        // by JS as UTC midnight, which in Eastern is 8pm the PREVIOUS day. The
        // onFollowUpDue reminder buckets by ET calendar day, so a manually
        // picked date used to fire the reminder a day early. Append a time so
        // it parses as local midnight instead, matching the auto-computed
        // branch below (which is `new Date()` + N days, i.e. already local).
        followUpDate = /^\d{4}-\d{2}-\d{2}$/.test(String(fupInput))
          ? new Date(fupInput + 'T00:00:00')
          : new Date(fupInput);
      } else {
        const autoDays = DISPOSITIONS[disposition]?.autoFollowUp;
        if (autoDays) {
          followUpDate = new Date();
          followUpDate.setDate(followUpDate.getDate() + autoDays);
        }
      }

      let stage = 'knock';
      if (disposition === 'appointment') stage = 'appointment';
      else if (INS_DISPOSITIONS.includes(disposition)) stage = 'insurance';

      const knockDoc = {
        userId: window._user.uid,
        repId: window._user.uid,
        // Denormalized rep display name so the live team view can label
        // knocks without a second lookup (same-company visibility only).
        repName: state.currentRep?.name || window._user?.displayName || '',
        companyId: state.currentRep?.companyId || window._userClaims?.companyId || window._user.uid,
        address: data.address,
        lat: data.lat || null,
        lng: data.lng || null,
        homeowner: data.homeowner || '',
        phone: data.phone || '',
        email: data.email || '',
        disposition: disposition,
        notes: data.notes || '',
        stage: stage,
        attemptNumber: attemptNumber,
        createdAt: window.serverTimestamp(),
        updatedAt: window.serverTimestamp(),
        convertedToLead: false,
        estimateValue: data.estimateValue || 0,
        closedDealValue: data.closedDealValue || 0,
        insCarrier: data.insCarrier || '',
        claimNumber: data.claimNumber || '',
        photoUrls: data.photoUrls || [],
        // Storage paths index-aligned with photoUrls — the image
        // pipeline finds this knock by array-contains on photoPaths and
        // stamps photoVariants[idx] = {thumb,med,full} (admin-side; the
        // client never writes photoVariants). Renderers null-check both:
        // pre-feature knocks have neither field.
        photoPaths: Array.isArray(data.photoPaths) ? data.photoPaths : [],
        voiceUrl: data.voiceUrl || '',
        followUpTime: data.followUpTime || '',
        // "Appointment Set" — when the rep booked it (datetime-local, the
        // rep's local time). convertToLead books it on the new lead through
        // lead-events.js (2026-10-03, stage-flow lane).
        appointmentAt: (disposition === 'appointment' && data.appointmentAt) ? String(data.appointmentAt).slice(0, 25) : '',
        // ── Door-number accuracy provenance ──
        // How we know this address is right: the verdict, whether a human
        // confirmed it, the house number we cross-checked, which sources
        // agreed, the reverse↔forward snap distance, and the device GPS
        // accuracy at capture. Powers the data-quality KPI + re-verify queue.
        addrConfidence: data.addrConfidence || 'unverified',
        addrConfirmed: !!data.addrConfirmed,
        addrHouseNumber: data.addrHouseNumber || extractHouseNumber(data.address) || '',
        addrSources: Array.isArray(data.addrSources) ? data.addrSources.slice(0, 6) : [],
        addrRoundTripMeters: (typeof data.addrRoundTripMeters === 'number') ? data.addrRoundTripMeters : null,
        gpsAccuracy: (typeof data.gpsAccuracy === 'number') ? data.gpsAccuracy : null,
        // Saved while offline / unresolved → flagged so the re-verify queue
        // re-checks it once back online. Also true whenever confidence < verified.
        addrNeedsReverify: !!data.addrNeedsReverify || (data.addrConfidence && data.addrConfidence !== 'verified') || false,
        addrVerifiedAt: window.serverTimestamp()
      };

      if (followUpDate) {
        knockDoc.followUpDate = followUpDate;
        // Rep-picked vs disposition default — convertToLead keeps only a
        // picked date for a lead with no phone.
        knockDoc.followUpSource = fupInput ? 'manual' : 'auto';
      }

      // 12s timeout — addDoc on a stale iOS bfcache connection never
      // resolves or rejects. Without this the Save button is stuck on
      // "Saving..." forever (handleSubmitKnock can't reach its finally).
      const ref = await _withTimeout(
        window.addDoc(window.collection(window._db, 'knocks'), knockDoc),
        12000,
        'addDoc(knocks)'
      );
      await loadKnocks();
      if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
      refreshMapMarkers();
      window.showToast?.(`${DISPOSITIONS[disposition].icon} ${DISPOSITIONS[disposition].label} — ${data.address}`, 'success');

      // ── Auto-convert hot dispositions into CRM leads ──
      // Appointment/Interested/Storm Damage/Insurance dispositions auto-create
      // a CRM lead with pre-filled data + auto-assigned follow-up.
      // This fixes the D2D→CRM gap: D2D is the primary lead source but knocks
      // did not flow into the pipeline automatically.
      if (HOT_DISPOSITIONS.includes(disposition)) {
        // Non-blocking — don't fail the knock if lead creation has issues
        convertToLead(ref.id).catch(err => {
          console.warn('Auto-convert to lead failed:', err);
        });
      }

      // Storm Center write-back: if this knock lands inside a storm-zone-backed
      // territory, bump that zone's knock (and lead, for hot dispositions) count.
      try { attributeKnockToStormZone(data.lat, data.lng, HOT_DISPOSITIONS.includes(disposition)); }
      catch (_) {}

      return ref.id;
    } catch (e) {
      console.error('submitKnock failed:', e);
      window.showToast?.('Failed to save knock', 'error');
      return null;
    }
  }

  async function updateKnock(id, data) {
    try {
      await window.updateDoc(window.doc(window._db, 'knocks', id), {
        ...data,
        updatedAt: window.serverTimestamp()
      });
      await loadKnocks();
    } catch (e) {
      console.error('updateKnock failed:', e);
      window.showToast?.('Failed to update knock', 'error');
    }
  }

  async function deleteKnock(id) {
    if (!(await uiConfirm('Delete this knock?', { okLabel: 'Delete', danger: true }))) return;
    if (!state.isOnline) { enqueueOffline('deleteKnock', { id }); return; }
    try {
      await window.deleteDoc(window.doc(window._db, 'knocks', id));
      if (window.D2D && typeof window.D2D.closeKnockDetail === 'function') window.D2D.closeKnockDetail();
      await loadKnocks();
      if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
      refreshMapMarkers();
      window.showToast?.('Knock deleted', 'info');
    } catch (e) {
      console.error('deleteKnock failed:', e);
      window.showToast?.('Failed to delete knock', 'error');
    }
  }

  async function convertToLead(knockId) {
    // The transaction below LOCKS the knock (convertedToLead:true) before the
    // lead is written. Every exit that writes no lead must release it: a
    // declined dedup prompt / plan cap (_saveLead → null) or a failed save
    // left the knock marked converted with no lead behind it, and both guards
    // then refused every retry — the prospect was lost (CRM sweep R13,
    // 2026-09-28). _saveLead's own catch comment expects exactly this.
    let _locked = false;
    let knock = null;
    let _newLeadId = null;
    const _release = async () => {
      if (!_locked) return;
      _locked = false;
      if (knock) knock.convertedToLead = false;
      try {
        await window.updateDoc(window.doc(window._db, 'knocks', knockId), {
          convertedToLead: false,
          conversionStartedAt: null,
        });
      } catch (relErr) { console.warn('convertToLead: could not release the knock lock', relErr); }
    };
    try {
      knock = state.knocks.find(k => k.id === knockId);
      if (!knock || knock.convertedToLead) return;

      // ─── Cross-call double-convert guard ───
      // Hot dispositions auto-fire convertToLead from submitKnock(), and
      // 400 ms later showConversionPrompt opens with another button that
      // also calls convertToLead. The local `knocks` cache hasn't been
      // refreshed yet so both calls pass the `knock.convertedToLead`
      // check above. Result: two pipeline leads, two map pins, two
      // customer-ID counter increments per hot knock.
      //
      // Use a Firestore transaction on knocks/{id} to flip
      // convertedToLead atomically — only the FIRST call past the
      // transaction wins; the second sees convertedToLead:true and
      // bails before _saveLead runs again.
      if (typeof window.runTransaction === 'function' && window._db) {
        try {
          await window.runTransaction(window._db, async (tx) => {
            const knockRef = window.doc(window._db, 'knocks', knockId);
            const snap = await tx.get(knockRef);
            if (!snap.exists()) throw new Error('Knock not found');
            const cur = snap.data() || {};
            if (cur.convertedToLead) {
              // Another call already won — abort with a sentinel that
              // the outer catch translates into a quiet no-op.
              throw new Error('KNOCK_ALREADY_CONVERTED');
            }
            tx.update(knockRef, {
              convertedToLead: true,
              conversionStartedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
            });
          });
        } catch (txErr) {
          if (txErr && txErr.message === 'KNOCK_ALREADY_CONVERTED') {
            // The other call beat us. Refresh and quietly bail.
            try { await loadKnocks(); } catch (_) {}
            return;
          }
          // Any other transaction error — re-throw to outer catch.
          throw txErr;
        }
        // Reflect the lock in our local cache so subsequent renders
        // know this knock is converting and don't re-offer the prompt.
        knock.convertedToLead = true;
        _locked = true;
      }

      const firstName = (knock.homeowner || '').split(' ')[0] || 'D2D';
      const lastName = (knock.homeowner || '').split(' ').slice(1).join(' ') || 'Lead';

      // Map D2D disposition → CRM stage key (d2d-knock-lead-logic.js).
      // 2026-10-03: "Appointment Set" landed as Inspected (nobody had been on
      // the roof) and "Needs to file" as Claim Filed (nobody had filed
      // anything — on a KY insurance job that record is a legal problem).
      // Both are Contacted now.
      const _KL = window.NBDKnockLeadLogic;
      const stage = _KL ? _KL.stageForDisposition(knock.disposition)
        : ((knock.disposition === 'ins_has_claim' || knock.disposition === 'ins_denied') ? 'claim_filed'
          : (knock.disposition && DISPOSITIONS[knock.disposition] && HOT_DISPOSITIONS.concat(['left_material']).includes(knock.disposition)) ? 'contacted' : 'new');

      // Map D2D disposition → CRM job type
      let jobType = '';
      if (INS_DISPOSITIONS.includes(knock.disposition)) jobType = 'insurance';

      // Map D2D disposition → claim status
      let claimStatus = 'No Claim';
      if (knock.disposition === 'ins_has_claim') claimStatus = 'Has Claim';
      else if (knock.disposition === 'ins_needs_file') claimStatus = 'Needs Filing';
      else if (knock.disposition === 'ins_denied') claimStatus = 'Denied';

      // Auto-assign follow-up date — use the knock's follow-up if set, otherwise
      // smart defaults per disposition (Interested: 2d, Appointment: 1d, Storm: 3d)
      //
      // No phone → no AUTOMATIC CRM follow-up (2026-10-03 data audit: 65
      // phone-less knock leads under one placeholder name carried auto dates
      // and buried the real follow-ups). Re-knocking that door stays on D2D's
      // own list; a date the rep PICKED on the knock form is still kept.
      const _knockHasPhone = String(knock.phone || '').replace(/\D/g, '').length >= 10;
      let followUpStr = '';
      if (!_knockHasPhone && knock.followUpSource !== 'manual') {
        followUpStr = '';
      } else if (knock.followUpDate) {
        followUpStr = (typeof knock.followUpDate === 'object' && knock.followUpDate.toISOString
          ? knock.followUpDate.toISOString().split('T')[0]
          : String(knock.followUpDate));
      } else {
        const defaultDays = (
          knock.disposition === 'appointment' ? 1 :
          knock.disposition === 'interested' ? 2 :
          knock.disposition === 'storm_damage' ? 3 :
          INS_DISPOSITIONS.includes(knock.disposition) ? 2 : 0
        );
        if (defaultDays > 0) {
          const d = new Date();
          d.setDate(d.getDate() + defaultDays);
          // LOCAL day — toISOString() is the UTC day, a day late after ~8pm ET.
          followUpStr = _KL ? _KL.localYmd(d) : d.toISOString().split('T')[0];
        }
      }
      // Same UTC slip for the knock's own follow-up (a local-midnight Date):
      // re-derive the local calendar day from the stored value.
      if (followUpStr && _KL && knock.followUpDate && typeof knock.followUpDate === 'object') {
        followUpStr = _KL.followUpYmd(knock.followUpDate) || followUpStr;
      }

      // ─── Prospect segregation (April 2026) ───
      // Appointment dispositions become full customers immediately
      // (isProspect: false) because a set meeting is already a
      // qualified customer worth tracking in the kanban.
      // All other hot dispositions (interested, storm_damage, ins_*)
      // become PROSPECTS — they auto-create a lead record for data
      // integrity, but the lead is hidden from the kanban by default
      // until the user explicitly promotes it via the CRM lead detail
      // modal (Promote to Customer button).
      const isAppointment = knock.disposition === 'appointment';
      const leadData = {
        firstName,
        lastName,
        address: knock.address || '',
        phone: knock.phone || '',
        // Normalized inbound-SMS match key — see functions/phone-utils.js.
        // Carried on leadData so it lands whether convert goes through
        // _saveLead (which re-stamps it) or the direct-write fallback below.
        phoneDigits: String(knock.phone || '').replace(/\D/g, '').replace(/^1/, '').slice(-10),
        email: knock.email || '',
        stage,
        jobType,
        // 'Door Knock' is the canonical source string (Joe, 2026-09-06). This
        // line used to write 'Door-to-Door' while maps-overlays.js wrote
        // 'Door Knock' for the same act, so every panel that tested for one
        // string under-counted by the size of the other — 71 leads against 16.
        source: 'Door Knock',
        damageType: knock.disposition === 'storm_damage' ? 'Storm Damage' : '',
        // Persist the structured disposition KEY on the lead so the Prospects
        // view buckets off this directly (dispositionKey fast-path) instead of
        // reverse-engineering it from the notes prose. '' for an unknown key.
        disposition: knock.disposition || '',
        insCarrier: knock.insCarrier || '',
        claimNumber: knock.claimNumber || '',
        claimStatus,
        notes: `D2D Knock #${knock.attemptNumber || 1}: ${DISPOSITIONS[knock.disposition]?.label || ''}${knock.notes ? '\n' + knock.notes : ''}`,
        d2dKnockId: knockId,
        lat: knock.lat || null,
        lng: knock.lng || null,
        // Carry photos from the knock onto the freshly-minted lead so
        // the rep doesn't lose the property/damage shots when the lead
        // is auto-created (prospect cards + doc generators read
        // lead.photoUrls). photoPaths/photoVariants ride along so the
        // variant thumbs survive conversion — without the copy,
        // converted leads regress to full-size originals.
        photoUrls: Array.isArray(knock.photoUrls) ? knock.photoUrls.slice() : [],
        photoPaths: Array.isArray(knock.photoPaths) ? knock.photoPaths.slice() : [],
        photoVariants: Array.isArray(knock.photoVariants) ? knock.photoVariants.slice() : [],
        followUp: followUpStr,
        // Prospect flag: appointments land in the kanban immediately,
        // everything else waits for manual promotion.
        isProspect: !isAppointment
      };

      // Use _saveLead which also creates map pin and geocodes
      if (typeof window._saveLead === 'function') {
        const leadId = await window._saveLead(leadData);
        // _saveLead returns a falsy value when it short-circuits (over the
        // plan's lead cap, dedup declined) and has already shown its own
        // toast -- bail here instead of stamping the knock converted and
        // telling the rep it worked (mirrors tools.js's quick-add guard).
        if (!leadId) { await _release(); return; }
        _newLeadId = leadId;
      } else {
        // Fallback: direct Firestore write. stageStartedAt anchors the
        // days-in-stage badge to actual lead-create time.
        const _fbRef = await window.addDoc(window.collection(window._db, 'leads'), {
          ...leadData,
          userId: window._user.uid,
          companyId: window._userClaims?.companyId || window._user.uid,
          createdAt: window.serverTimestamp(),
          stageStartedAt: window.serverTimestamp()
        });
        _newLeadId = (_fbRef && _fbRef.id) || null;
        _locked = false;
        if (typeof window._loadLeads === 'function') await window._loadLeads();
      }
      _locked = false; // a lead exists now — the knock stays converted whatever follows

      // "Appointment Set" with a time → book it on the lead (lead-events.js,
      // the customer page's Add Event writer). Best-effort: the lead exists.
      let _apptBooked = false;
      if (isAppointment && _newLeadId && knock.appointmentAt && window.NBDLeadEvents && typeof window.NBDLeadEvents.add === 'function') {
        const _when = _KL ? _KL.appointmentWhen(knock.appointmentAt) : new Date(knock.appointmentAt);
        if (_when && !isNaN(_when.getTime())) {
          try {
            await window.NBDLeadEvents.add(_newLeadId, {
              title: 'Inspection appointment' + (knock.homeowner ? ' — ' + knock.homeowner : ''),
              when: _when,
              notes: 'Booked at the door (D2D knock).' + (knock.address ? ' ' + knock.address : ''),
              source: 'd2d',
            });
            _apptBooked = true;
          } catch (apptErr) {
            console.warn('convertToLead: appointment not booked', apptErr && apptErr.message);
            window.showToast?.('Lead saved — but the appointment did not save. Add it from the customer page.', 'warning');
          }
        }
      }

      await updateKnock(knockId, { convertedToLead: true });
      if (window.D2D && typeof window.D2D.closeKnockDetail === 'function') window.D2D.closeKnockDetail();
      if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
      // Only appointments land on the kanban; everything else is a prospect
      // (isProspect above), which the pipeline hides. The toast used to say
      // "visible in your pipeline" either way.
      window.showToast?.(isAppointment
        ? (_apptBooked ? '✅ Converted to CRM Lead — appointment booked' : '✅ Converted to CRM Lead — visible in your pipeline')
        : '✅ Saved to Prospects — promote it when it’s qualified', 'success');
    } catch (e) {
      console.error('convertToLead failed:', e);
      await _release();
      window.showToast?.('Failed to convert to lead', 'error');
    }
  }

  // Quick-convert: open lead modal pre-filled from a knock (for manual editing before save)
  function convertToLeadWithEdit(knockId) {
    const knock = state.knocks.find(k => k.id === knockId);
    if (!knock) return;

    if (window.D2D && typeof window.D2D.closeKnockDetail === 'function') window.D2D.closeKnockDetail();

    // Open the CRM lead modal
    if (typeof openLeadModal === 'function') openLeadModal();
    else if (typeof window.openLeadModal === 'function') window.openLeadModal();
    else { document.getElementById('leadModal')?.classList.add('open'); }

    // Pre-fill fields from knock data
    setTimeout(() => {
      const firstName = (knock.homeowner || '').split(' ')[0] || '';
      const lastName = (knock.homeowner || '').split(' ').slice(1).join(' ') || '';

      const fill = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      fill('lFname', firstName);
      fill('lLname', lastName);
      fill('lAddr', knock.address);
      fill('lPhone', knock.phone);
      fill('lEmail', knock.email);
      fill('lInsCarrier', knock.insCarrier);
      fill('lClaimNumber', knock.claimNumber);
      fill('lNotes', `D2D Knock: ${DISPOSITIONS[knock.disposition]?.label || ''}${knock.notes ? '\n' + knock.notes : ''}`);

      // Set source to the canonical door-knock value. Prefer whatever the
      // select actually offers (a tenant may have relabelled it) and fall back
      // to the canonical string rather than the old 'Door-to-Door' — a value
      // absent from the option list renders the select BLANK, and saving the
      // form then writes the blank over the real source. That is exactly how
      // nine Thumbtack leads got downgraded to 'Online' on 2026-09-06.
      const sourceEl = document.getElementById('lSource');
      if (sourceEl) {
        const opt = Array.from(sourceEl.options).find(o => o.value.toLowerCase().includes('door'));
        if (opt) sourceEl.value = opt.value;
        else sourceEl.value = 'Door Knock';
      }

      // Set stage based on disposition. Values must match the lStage
      // <select> options in dashboard.html (snake_case stage keys —
      // see crm-stages.js). Previously assigned 'Inspection' /
      // 'Contacted' / 'New' which don't match any option, so the
      // select silently stayed on the placeholder.
      const stageEl = document.getElementById('lStage');
      if (stageEl) {
        // Same map as convertToLead (d2d-knock-lead-logic.js, 2026-10-03).
        const _KLe = window.NBDKnockLeadLogic;
        if (_KLe) stageEl.value = _KLe.stageForDisposition(knock.disposition);
        else if (knock.disposition === 'appointment' || knock.disposition === 'interested') stageEl.value = 'contacted';
        else stageEl.value = 'new';
      }

      // Set job type for insurance dispositions
      if (INS_DISPOSITIONS.includes(knock.disposition)) {
        const jtEl = document.getElementById('lJobType');
        if (jtEl) jtEl.value = 'insurance';
      }

      // Mark knock as converted after modal is open (will be finalized on save)
      window._pendingD2DConvertId = knockId;
    }, 150);
  }

  async function loadTeamKnocks() {
    if (!state.teamMode || !state.currentRep) return;
    try {
      const q = window.query(window.collection(window._db, 'knocks'), window.where('companyId', '==', state.currentRep.companyId));
      const snap = await window.getDocs(q);
      state.teamKnocks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.error('loadTeamKnocks failed:', e); }
  }

  // ── Live team activity ("who's knocking where right now") ───────────
  // A single onSnapshot on the company's knocks streams teammates' knocks in
  // real time. The recency/today slicing is still done client-side
  // (getTeamActivity), but the listener is BOUNDED to the newest
  // TEAM_LIVE_KNOCK_LIMIT knocks (orderBy createdAt desc) — unbounded, every
  // snapshot re-shipped the company's entire knock history. The panel only
  // shows today's counts + the 6 most-recent reps, so the newest knocks are
  // all it needs. 1000 = 6x the whole prod knocks collection (167, all with a
  // Timestamp createdAt — 2026-10-03 count). Index: companyId ASC + createdAt
  // DESC (firestore.indexes.json, same one loadKnocks' manager query uses).
  const TEAM_LIVE_KNOCK_LIMIT = 1000;
  let _teamUnsub = null;
  function subscribeTeamActivity() {
    if (!state.currentRep || !state.currentRep.companyId) return;
    unsubscribeTeamActivity();
    if (typeof window.onSnapshot !== 'function') { loadTeamKnocks().then(_renderIfActive); return; }
    try {
      const q = window.query(
        window.collection(window._db, 'knocks'),
        window.where('companyId', '==', state.currentRep.companyId),
        window.orderBy('createdAt', 'desc'),
        window.limit(TEAM_LIVE_KNOCK_LIMIT)
      );
      _teamUnsub = window.onSnapshot(q,
        (snap) => { state.teamKnocks = snap.docs.map(d => ({ id: d.id, ...d.data() })); _renderIfActive(); },
        (err) => { console.warn('[D2D] team listener error — one-shot fallback:', err && err.message || err); loadTeamKnocks().then(_renderIfActive); }
      );
    } catch (e) {
      console.warn('[D2D] subscribeTeamActivity failed:', e && e.message || e);
      loadTeamKnocks().then(_renderIfActive);
    }
  }
  function unsubscribeTeamActivity() {
    if (typeof _teamUnsub === 'function') { try { _teamUnsub(); } catch (_) {} _teamUnsub = null; }
  }
  function _renderIfActive() {
    if (state.teamMode && window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
  }

  function getTeamActivity() {
    const now = Date.now(), HOUR = 3600e3;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const dayMs = startOfDay.getTime();
    const knocks = state.teamKnocks || [];
    const byRep = new Map();
    const recent = [];
    knocks.forEach(k => {
      const ms = (toDate(k.createdAt) || new Date(0)).getTime();
      const rep = k.repId || k.userId || 'unknown';
      if (!byRep.has(rep)) byRep.set(rep, { repId: rep, name: k.repName || '', knocksToday: 0, appts: 0, lastMs: 0, lastAddress: '' });
      const r = byRep.get(rep);
      if (ms >= dayMs) r.knocksToday++;
      if (k.disposition === 'appointment' && ms >= dayMs) r.appts++;
      if (ms > r.lastMs) { r.lastMs = ms; r.lastAddress = k.address || ''; if (k.repName) r.name = k.repName; }
      recent.push({ id: k.id, address: k.address, disposition: k.disposition, repName: k.repName || '', repId: rep, _ms: ms });
    });
    const reps = [...byRep.values()].sort((a, b) => b.lastMs - a.lastMs);
    return {
      reps,
      activeNow: reps.filter(r => now - r.lastMs < HOUR).length,
      totalToday: reps.reduce((s, r) => s + r.knocksToday, 0),
      recent: recent.sort((a, b) => b._ms - a._ms).slice(0, 12)
    };
  }

  async function loadTerritories() {
    try {
      const q = window.query(window.collection(window._db, 'territories'), window.where('companyId', '==', state.currentRep?.companyId || 'default'));
      const snap = await window.getDocs(q);
      state.territories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) { console.error('loadTerritories failed:', e); }
  }

  async function saveTerritory(data) {
    try {
      const territoryData = { ...data, companyId: state.currentRep?.companyId || window._userClaims?.companyId || window._user.uid, userId: window._user.uid, updatedAt: window.serverTimestamp() };
      let id = data.id;
      if (id) {
        await window.updateDoc(window.doc(window._db, 'territories', id), territoryData);
      } else {
        const ref = await window.addDoc(window.collection(window._db, 'territories'), { ...territoryData, createdAt: window.serverTimestamp() });
        id = ref && ref.id;
      }
      await loadTerritories();
      return id || null;
    } catch (e) { console.error('saveTerritory failed:', e); return null; }
  }

  // ── Storm → canvassing territory ────────────────────────────────────
  // Turn recent significant hail into a canvassing zone: NOAA (the default
  // provider) returns hail POINTS not a swath, so we hull the qualifying points
  // into a polygon (HailTrace's swath is used directly when present), save it as
  // a real territory, and focus the map on it.
  function _convexHull(pts) {
    if (pts.length < 3) return null;
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    lower.pop(); upper.pop();
    const hull = lower.concat(upper);
    if (hull.length < 3) return null;
    // Small outward buffer from the centroid so a tight cluster still has area.
    let cx = 0, cy = 0; hull.forEach(h => { cx += h[0]; cy += h[1]; }); cx /= hull.length; cy /= hull.length;
    const buffered = hull.map(h => { const dx = h[0] - cx, dy = h[1] - cy, len = Math.hypot(dx, dy) || 1; return [h[0] + dx / len * 0.0015, h[1] + dy / len * 0.0015]; });
    buffered.push(buffered[0]); // close the ring
    return buffered;
  }

  // Normalize a provider swath's coordinates into a valid, closed [lng,lat]
  // outer ring. Handles Polygon (coords[0] = ring) and MultiPolygon (coords[0]
  // = a polygon), drops non-finite points, requires ≥3 points, closes the ring.
  // Returns null if unusable so callers can fall back to the point hull.
  function _outerRing(coords) {
    if (!Array.isArray(coords) || !Array.isArray(coords[0])) return null;
    const c0 = coords[0];
    let ring;
    if (Array.isArray(c0[0]) && typeof c0[0][0] === 'number') ring = c0;              // Polygon → outer ring
    else if (Array.isArray(c0[0]) && Array.isArray(c0[0][0])) ring = c0[0];           // MultiPolygon → first polygon's outer ring
    else return null;
    const clean = (ring || []).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])).map(p => [Number(p[0]), Number(p[1])]);
    if (clean.length < 3) return null;
    const f = clean[0], l = clean[clean.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) clean.push([f[0], f[1]]);
    return clean;
  }

  // Shoelace area of a closed [lng,lat] ring — a degenerate/collinear ring
  // (e.g. a provider swath that is really a line or a single repeated point)
  // comes out ~0, so callers can reject it and fall back to the point hull.
  function _ringArea(ring) {
    if (!Array.isArray(ring) || ring.length < 4) return 0;
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(a) / 2;
  }

  // A coordinate is usable only if it's a genuinely finite number. Rejects
  // null, '', whitespace and non-numeric strings — note Number('')===0 would
  // otherwise pass a bare isFinite() check and silently drag geometry to [0,0].
  function _finiteCoord(v) {
    if (v == null || (typeof v === 'string' && v.trim() === '')) return NaN;
    const n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  let _stormZoneBusy = false;

  async function createStormTerritory(opts) {
    opts = opts || {};
    // In-flight lock: a double-tap on 🌩️ Zone (common on mobile) would otherwise
    // fire two lookups and persist two near-identical territories.
    if (_stormZoneBusy) { window.showToast?.('Storm zone already generating…', 'info'); return null; }
    if (!state.d2dMap) { window.showToast?.('Open the D2D map first', 'info'); return null; }
    if (!window.NBDIntegrations || typeof window.NBDIntegrations.getHailHistory !== 'function') { window.showToast?.('Hail data unavailable', 'error'); return null; }
    _stormZoneBusy = true;
    try {
      const minSize = Number(opts.minSizeInches) || 1.0;
      const center = state.d2dMap.getCenter();
      window.showToast?.('Finding recent hail…', 'info');
      let res;
      try { res = await window.NBDIntegrations.getHailHistory(center.lat, center.lng, { radiusMi: Number(opts.radiusMi) || 15, daysBack: Number(opts.daysBack) || 365 }); }
      catch (e) { window.showToast?.('Hail lookup failed', 'error'); return null; }
      if (!res || !res.ok || !Array.isArray(res.hits)) { window.showToast?.('Hail lookup failed', 'error'); return null; }
      // Only hits with genuinely finite coordinates survive — a present-but-non-
      // numeric lat/lng ('N/A', '') would otherwise pass a bare null check and
      // poison the hull or the box fallback with NaN / [0,0] geometry.
      const sig = res.hits.filter(h => isFinite(_finiteCoord(h.lat)) && isFinite(_finiteCoord(h.lng)) && (Number(h.sizeInches) || 0) >= minSize);
      if (!sig.length) { window.showToast?.('No hail ≥ ' + minSize + '" nearby in the last year', 'info'); return null; }

      // Prefer a provider swath polygon (HailTrace) — but only if it validates to
      // a real closed ring WITH ACTUAL AREA; otherwise fall back to hulling ALL
      // the points (so a malformed/degenerate/MultiPolygon/empty swath never
      // discards the hits or saves broken geometry).
      let ring = null;
      const polyHits = sig.filter(h => h.polygon && Array.isArray(h.polygon.coordinates));
      // A SINGLE provider swath is the authoritative footprint — use it directly,
      // unless it's degenerate (zero-area / collinear), then fall through to hull.
      if (polyHits.length === 1) {
        const r = _outerRing(polyHits[0].polygon.coordinates);
        if (r && _ringArea(r) > 1e-10) ring = r;
      }
      if (!ring) {
        // Otherwise hull EVERY available point — all swath vertices (so several
        // storms in range are all covered, not just the first) plus every hit
        // centroid (NOAA has no swaths). Falls back to a box for 1–2 points.
        const pts = [];
        polyHits.forEach(h => { const r = _outerRing(h.polygon.coordinates); if (r) r.forEach(p => pts.push(p)); });
        sig.forEach(h => { const x = _finiteCoord(h.lng), y = _finiteCoord(h.lat); if (isFinite(x) && isFinite(y)) pts.push([x, y]); });
        ring = _convexHull(pts);
        if (!ring) { // 1–2 points → box around the cluster (sig[0] is finite by the filter above)
          const c = [_finiteCoord(sig[0].lng), _finiteCoord(sig[0].lat)], d = 0.004;
          ring = [[c[0] - d, c[1] - d], [c[0] + d, c[1] - d], [c[0] + d, c[1] + d], [c[0] - d, c[1] + d], [c[0] - d, c[1] - d]];
        }
      }
      const maxSize = Math.max.apply(null, sig.map(h => Number(h.sizeInches) || 0));
      const lats = ring.map(pp => pp[1]), lngs = ring.map(pp => pp[0]);
      const bounds = { north: Math.max.apply(null, lats), south: Math.min.apply(null, lats), east: Math.max.apply(null, lngs), west: Math.min.apply(null, lngs) };
      const geoJSON = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
      // Register a matching Storm Center zone so knocks logged inside this
      // territory attribute to Storm Center's per-zone analytics via
      // attributeKnockToStormZone → recordKnock. Without a stormZoneId + backing
      // zone that path skips this territory. Degrades gracefully (stormZoneId
      // stays null, exactly today's behavior) when the Storm module isn't loaded.
      let stormZoneId = null;
      try {
        if (window.StormCenter && typeof window.StormCenter.registerHailZone === 'function') {
          stormZoneId = window.StormCenter.registerHailZone({ ring, bounds, maxSizeInches: maxSize, hits: sig.length }) || null;
        }
      } catch (_) {}
      const id = await saveTerritory({
        name: '🌩️ Storm ' + maxSize.toFixed(2) + '"', assignedRep: null, type: 'polygon',
        geoJSON, bounds, priority: maxSize >= 1.5 ? 'CRITICAL' : 'HIGH',
        stormZoneId,
        stormHail: { maxSizeInches: maxSize, hits: sig.length }
      });
      if (!id) { window.showToast?.('Could not save the storm territory', 'error'); return null; }
      // Immediate highlight + focus (the saved territory also shows via the Zone layer).
      try {
        if (window._d2dStormPreview) { state.d2dMap.removeLayer(window._d2dStormPreview); }
        window._d2dStormPreview = L.geoJSON(geoJSON, { style: { color: '#BD5728', weight: 2, fillColor: '#BD5728', fillOpacity: 0.14, dashArray: '5 5' }, interactive: false }).addTo(state.d2dMap);
        state.d2dMap.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [40, 40], maxZoom: 15 });
      } catch (e) {}
      window.showToast?.('Storm zone created — ' + sig.length + ' hail hit' + (sig.length !== 1 ? 's' : '') + ' up to ' + maxSize.toFixed(2) + '"', 'success');
      return id;
    } finally {
      _stormZoneBusy = false;
    }
  }

  async function deleteTerritory(id) {
    if (!id) return false;
    try {
      await window.deleteDoc(window.doc(window._db, 'territories', id));
      state.territories = state.territories.filter(t => t.id !== id);
      return true;
    } catch (e) { console.error('deleteTerritory failed:', e); return false; }
  }

  // ============================================================================
  // NAV BADGE (follow-ups due)
  // ============================================================================
  // Only the newest knock at a door owns its follow-up (Jo, 2026-09-30:
  // "only the latest knock"). A re-knock writes a NEW knock and leaves the
  // old one's followUpDate behind, so the badge and the Follow-ups Due list
  // kept counting doors already re-knocked ("not interested" included) —
  // forever, since a past-due date never stops being due. Same rule as the
  // calendar and the 8am push (functions/google-calendar-logic.js).
  function newestKnockIds(knocks) {
    const best = new Map();
    for (const k of knocks || []) {
      if (!k) continue;
      const door = doorKey(k);
      const d = toDate(k.createdAt);
      const t = d ? d.getTime() : 0;
      const cur = best.get(door);
      if (!cur || t > cur.t || (t === cur.t && String(k.id) > String(cur.id))) best.set(door, { id: k.id, t });
    }
    return new Set([...best.values()].map((v) => String(v.id)));
  }
  function followUpsDueOf(knocks, now) {
    const newest = newestKnockIds(knocks);
    const at = now || new Date();
    return (knocks || []).filter((k) => {
      const fup = toDate(k.followUpDate);
      return fup && fup <= at && !k.convertedToLead && newest.has(String(k.id));
    });
  }

  function updateNavBadge() {
    const followUpsDue = followUpsDueOf(state.knocks);
    const navEl = document.getElementById('nav-d2d');
    if (!navEl) return;
    let badge = navEl.querySelector('.d2d-badge');
    if (followUpsDue.length > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'd2d-badge';
        badge.style.cssText = 'position:absolute;top:4px;right:4px;background:var(--red, #E05252);color:white;font-size:9px;font-weight:700;padding:1px 5px;border-radius:10px;min-width:16px;text-align:center;';
        navEl.style.position = 'relative';
        navEl.appendChild(badge);
      }
      badge.textContent = followUpsDue.length;
    } else if (badge) {
      badge.remove();
    }
  }

  // ============================================================================
  // FILTERING
  // ============================================================================
  function applyFilters() {
    let filtered = state.knocks;
    if (state.filterDateRange === 'today') filtered = filtered.filter(k => isToday(k.createdAt));
    else if (state.filterDateRange === 'week') filtered = filtered.filter(k => isThisWeek(k.createdAt));
    else if (state.filterDateRange === 'month') filtered = filtered.filter(k => isThisMonth(k.createdAt));
    if (state.filterDispo) filtered = filtered.filter(k => k.disposition === state.filterDispo);
    return filtered;
  }

  // ============================================================================
  // METRICS
  // ============================================================================
  function getMetrics() {
    const today = state.knocks.filter(k => isToday(k.createdAt));
    const week = state.knocks.filter(k => isThisWeek(k.createdAt));
    const month = state.knocks.filter(k => isThisMonth(k.createdAt));
    const uniqueAddrs = new Set(state.knocks.map(k => normalizeAddress(k.address)));
    const appointments = state.knocks.filter(k => k.disposition === 'appointment');
    const appointmentsWeek = week.filter(k => k.disposition === 'appointment');
    const appointmentsToday = today.filter(k => k.disposition === 'appointment');
    const insuranceToday = today.filter(k => INS_DISPOSITIONS.includes(k.disposition));
    const conversations = state.knocks.filter(k => isConversation(k.disposition));
    const conversationsToday = today.filter(k => isConversation(k.disposition));

    let streak = 0;
    const checkDate = new Date();
    checkDate.setHours(0, 0, 0, 0);
    let found = true;
    while (found) {
      const dayStr = checkDate.toDateString();
      found = state.knocks.some(k => {
        const kd = toDate(k.createdAt) || new Date(0);
        return kd.toDateString() === dayStr;
      });
      if (found) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
    }

    const followUpsDue = followUpsDueOf(state.knocks);

    return {
      today: today.length,
      week: week.length,
      month: month.length,
      all: state.knocks.length,
      uniqueAddrs: uniqueAddrs.size,
      appointments: appointments.length,
      appointments_today: appointmentsToday.length,
      insurance_today: insuranceToday.length,
      conversations_today: conversationsToday.length,
      photos_today: today.filter(k => k.photoUrls?.length > 0).length,
      interested: state.knocks.filter(k => k.disposition === 'interested').length,
      stormDmg: state.knocks.filter(k => k.disposition === 'storm_damage').length,
      conversations: conversations.length,
      // Audit #16: prior formula divided all-time appointments by this-week
      // knocks, which could produce >100% conversion rates. Both sides of the
      // ratio are now week-bounded so the metric is interpretable.
      conversionRate: week.length > 0 ? Math.round(appointmentsWeek.length / week.length * 100) : 0,
      knocksPerAppt: appointmentsWeek.length > 0 ? Math.round(week.length / appointmentsWeek.length) : '—',
      followUpsDue,
      streak
    };
  }

  // Expected pipeline contribution per disposition — the rough probability a
  // door in that state eventually becomes a signed job. Lets "Value Per Door"
  // move the moment a rep logs an appointment / claim / storm hit, instead of
  // sitting frozen until a deal literally closes (closes happen in the CRM
  // pipeline, not here, so closedDealValue was almost always 0 → the number
  // looked permanently stuck).
  const DISPO_PIPELINE_WEIGHT = {
    appointment:    0.22,
    ins_has_claim:  0.28,
    ins_needs_file: 0.18,
    storm_damage:   0.12,
    interested:     0.07,
    callback:       0.06,
    come_back:      0.03,
    left_material:  0.02,
    ins_denied:     0.02
    // everything else (not_home, not_interested, do_not_knock, cold_dead,
    // tenant, vacant) contributes 0.
  };
  // Fallback job value when the rep has no closed deals yet to average from.
  // ~$12.5k is a conservative retail roof; tune per market if needed.
  const DEFAULT_JOB_VALUE = 12500;

  // Date-scoped knocks for the revenue card: respects the DATE-range filter so
  // "Expected Value / Door" reflects the selected period (today/week/month) and
  // matches the rest of the filtered D2D view — but deliberately NOT the
  // disposition filter. Value-per-door is Σ P(close|disposition) × dealValue ÷
  // doors; its whole meaning is the disposition MIX across doors, so filtering to
  // one disposition would degenerate it to a constant weight × deal size.
  function revenueScopedKnocks() {
    let f = state.knocks;
    if (state.filterDateRange === 'today') f = f.filter(k => isToday(k.createdAt));
    else if (state.filterDateRange === 'week') f = f.filter(k => isThisWeek(k.createdAt));
    else if (state.filterDateRange === 'month') f = f.filter(k => isThisMonth(k.createdAt));
    return f;
  }

  // ── Calibration (metrics audit F9) ────────────────────────────────
  // The static DISPO_PIPELINE_WEIGHT numbers are industry priors. Every
  // D2D-converted lead carries its knock disposition (convertToLead stamps
  // `disposition` + `d2dKnockId`), so once this tenant's own door-knock
  // leads start DECIDING (won/job vs lost), we can observe the real
  // P(close | disposition) and blend it in. Beta-shrinkage keeps small
  // samples honest: with PRIOR_STRENGTH=12 pseudo-observations behind each
  // prior, 2 lucky closes barely move the weight, 30 decided outcomes
  // dominate it. Undecided leads contribute nothing (no signal yet).
  const CALIBRATION_PRIOR_STRENGTH = 12;
  function calibratedDispoWeights() {
    const out = Object.assign({}, DISPO_PIPELINE_WEIGHT);
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const byDispo = {};
    leads.forEach(l => {
      if (!l || l.deleted || !l.disposition || !(l.disposition in out)) return;
      const role = l._stageRole
        || (typeof window.stageRole === 'function' ? window.stageRole(l._stageKey || l.stage) : '');
      if (role !== 'won' && role !== 'job' && role !== 'lost') return; // undecided
      const d = byDispo[l.disposition] || (byDispo[l.disposition] = { won: 0, decided: 0 });
      d.decided++;
      if (role === 'won' || role === 'job') d.won++;
    });
    let calibratedCount = 0;
    Object.keys(byDispo).forEach(k => {
      const s = byDispo[k];
      out[k] = (s.won + out[k] * CALIBRATION_PRIOR_STRENGTH)
             / (s.decided + CALIBRATION_PRIOR_STRENGTH);
      calibratedCount++;
    });
    return { weights: out, calibratedCount };
  }

  function getRevenueMetrics() {
    const knocks = revenueScopedKnocks();
    const doorsKnocked = new Set(knocks.map(k => doorKey(k))).size;
    const conversations = knocks.filter(k => isConversation(k.disposition)).length;
    const appointments = knocks.filter(k => k.disposition === 'appointment').length;
    const estimates = knocks.filter(k => k.estimateValue > 0).length;
    const closed = knocks.filter(k => k.closedDealValue > 0).length;
    const revenue = knocks.reduce((sum, k) => sum + (k.closedDealValue || 0), 0);

    // Deal size to value the pipeline at. F9: average over ALL closes, not
    // just the filtered date range — deal size is a stock, not a flow, and
    // the old range-scoped average meant "Today" with zero closes priced the
    // pipeline off the $12.5k default even for a rep with a real history.
    // Fallback chain: own D2D closes → this tenant's CRM won-deal average →
    // the industry default.
    const allClosedKnocks = state.knocks.filter(k => k.closedDealValue > 0);
    const lifetimeRevenue = allClosedKnocks.reduce((sum, k) => sum + (k.closedDealValue || 0), 0);
    const avgDealSize = allClosedKnocks.length > 0 ? Math.round(lifetimeRevenue / allClosedKnocks.length) : 0;
    let crmAvgDeal = 0;
    if (!avgDealSize && Array.isArray(window._leads)) {
      const wonVals = window._leads.filter(l => {
        if (!l || l.deleted || !(Number(l.jobValue) > 0)) return false;
        const role = l._stageRole
          || (typeof window.stageRole === 'function' ? window.stageRole(l._stageKey || l.stage) : '');
        return role === 'won' || role === 'job';
      }).map(l => Number(l.jobValue));
      if (wonVals.length) crmAvgDeal = Math.round(wonVals.reduce((a, b) => a + b, 0) / wonVals.length);
    }
    const dealValue = avgDealSize || crmAvgDeal || DEFAULT_JOB_VALUE;

    // Live expected pipeline value = Σ P(close | disposition) × dealValue,
    // deduped to the most-recent disposition per address so re-knocks don't
    // double-count a single door. F9: the weights are the static priors
    // blended with this tenant's own observed close rates where outcomes
    // exist (see calibratedDispoWeights).
    const calibrated = calibratedDispoWeights();
    const dispoWeights = calibrated.weights;
    const latestByAddr = new Map();
    knocks.forEach(k => {
      const norm = doorKey(k);
      const kMs = (toDate(k.createdAt) || new Date(0)).getTime();
      const prev = latestByAddr.get(norm);
      if (!prev || kMs > prev._ms) latestByAddr.set(norm, { disposition: k.disposition, _ms: kMs });
    });
    let pipelineValue = 0;
    latestByAddr.forEach(k => { pipelineValue += (dispoWeights[k.disposition] || 0) * dealValue; });
    pipelineValue = Math.round(pipelineValue);

    const realizedPerDoor = doorsKnocked > 0 ? Math.round(revenue / doorsKnocked) : 0;
    const expectedPerDoor = doorsKnocked > 0 ? Math.round(pipelineValue / doorsKnocked) : 0;

    return {
      totalDoorsKnocked: doorsKnocked,
      totalConversations: conversations,
      totalAppointments: appointments,
      totalEstimates: estimates,
      totalClosed: closed,
      totalRevenue: revenue,
      // Realized $/door from closed deals only (kept for back-compat + the
      // "closed" readout). Expected/pipeline $/door is the live headline.
      revenuePerDoor: realizedPerDoor,
      expectedPerDoor,
      pipelineValue,
      avgDealSize,
      dealValueUsed: dealValue,
      // F9 calibration provenance — where the deal size came from and how
      // many disposition weights are running on observed outcomes vs priors.
      dealValueSource: avgDealSize ? 'd2d-closes' : (crmAvgDeal ? 'crm-won-avg' : 'default'),
      calibratedDispos: calibrated.calibratedCount,
      conversionFunnel: { doors: doorsKnocked, conversations, appointments, estimates, closed }
    };
  }

  function getDispositionBreakdown() {
    const filtered = applyFilters();
    const breakdown = {};
    DISPO_ORDER.forEach(key => { breakdown[key] = 0; });
    filtered.forEach(k => { if (breakdown.hasOwnProperty(k.disposition)) breakdown[k.disposition]++; });
    return breakdown;
  }

  function getTimeOfDayStats() {
    const hourCounts = new Array(24).fill(0);
    const hourConversions = new Array(24).fill(0);
    const dayHour = {};
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    state.knocks.forEach(k => {
      const kdate = toDate(k.createdAt) || new Date(0);
      const hr = kdate.getHours();
      const day = kdate.getDay();
      hourCounts[hr]++;
      const key = `${day}-${hr}`;
      if (!dayHour[key]) dayHour[key] = { total: 0, conversions: 0 };
      dayHour[key].total++;
      if (['appointment', 'interested', 'storm_damage'].includes(k.disposition)) {
        hourConversions[hr]++;
        dayHour[key].conversions++;
      }
    });

    let bestStart = 0, bestCount = 0;
    for (let i = 8; i <= 19; i++) {
      const windowCount = (hourConversions[i] || 0) + (hourConversions[i + 1] || 0) + (hourConversions[i + 2] || 0);
      if (windowCount > bestCount) { bestCount = windowCount; bestStart = i; }
    }
    return { hourCounts, hourConversions, dayHour, days, bestWindow: { start: bestStart, end: bestStart + 3, conversions: bestCount } };
  }

  function getInsuranceMetrics() {
    const insKnocks = state.knocks.filter(k => INS_DISPOSITIONS.includes(k.disposition));
    const carrierMap = {};
    insKnocks.forEach(k => {
      const carrier = k.insCarrier || 'Unknown';
      if (!carrierMap[carrier]) carrierMap[carrier] = { total: 0, hasClaim: 0, needsFiling: 0, denied: 0 };
      carrierMap[carrier].total++;
      if (k.disposition === 'ins_has_claim') carrierMap[carrier].hasClaim++;
      if (k.disposition === 'ins_needs_file') carrierMap[carrier].needsFiling++;
      if (k.disposition === 'ins_denied') carrierMap[carrier].denied++;
    });
    return { total: insKnocks.length, carriers: carrierMap };
  }

  // ============================================================================
  // GAMIFICATION
  // ============================================================================
  function getGamificationData() {
    const metrics = getMetrics();
    const revenue = getRevenueMetrics();

    // Daily challenges
    const challenges = DAILY_CHALLENGES.map(ch => {
      let current = 0;
      if (ch.metric === 'today') current = metrics.today;
      else if (ch.metric === 'appointments_today') current = metrics.appointments_today;
      else if (ch.metric === 'insurance_today') current = metrics.insurance_today;
      else if (ch.metric === 'conversations_today') current = metrics.conversations_today;
      else if (ch.metric === 'photos_today') current = metrics.photos_today;
      return { ...ch, current, pct: Math.min(Math.round(current / ch.target * 100), 100), complete: current >= ch.target };
    });

    // Streak milestone
    const currentMilestone = STREAK_MILESTONES.filter(m => metrics.streak >= m.days).pop();
    const nextMilestone = STREAK_MILESTONES.find(m => metrics.streak < m.days);

    // Commission projection (based on avg deal size and conversion rate)
    const daysLeft = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate();
    const avgKnocksPerDay = metrics.month > 0 ? metrics.month / new Date().getDate() : metrics.today || 0;
    const projectedKnocks = metrics.month + (avgKnocksPerDay * daysLeft);
    const projectedAppts = metrics.conversionRate > 0 ? Math.round(projectedKnocks * metrics.conversionRate / 100) : 0;
    const projectedRevenue = projectedAppts * (revenue.avgDealSize || 8500);

    return {
      challenges,
      streak: metrics.streak,
      currentMilestone,
      nextMilestone,
      projectedKnocks: Math.round(projectedKnocks),
      projectedAppts,
      projectedRevenue,
      completedChallenges: challenges.filter(c => c.complete).length,
      totalChallenges: challenges.length
    };
  }

  // ============================================================================
  // MAP INITIALIZATION
  // ============================================================================
  function initD2DMap() {
    const mapEl = document.getElementById('d2dMap');
    if (!mapEl) return;

    if (state.d2dMap) { state.d2dMap.invalidateSize(); return; }

    // Leaflet loads asynchronously from CDN. If it hasn't arrived yet,
    // show a soft placeholder and retry once — covers the case where the
    // CDN is slow but not down. If L is genuinely unavailable (blocked,
    // offline, etc.) the D2D feed/stats still work; only the map is
    // affected.
    if (typeof L === 'undefined') {
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--m,#9ca3af);font-size:13px;gap:8px;">⏳ Loading map…</div>';
      setTimeout(() => { if (typeof L !== 'undefined') { mapEl.innerHTML = ''; initD2DMap(); } else { mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--m,#9ca3af);font-size:13px;">🗺️ Map unavailable — check connection</div>'; } }, 3000);
      return;
    }

    // Leaflet 1.9+ fixed the iOS standalone ghost-click bug, so we
    // no longer need to disable the tap handler. Re-enabled for full
    // touch interactivity in both browser and PWA modes.
    const isStandalone = window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;

    // rotate:true is added ONLY once the (lazy, opt-in) leaflet-rotate plugin
    // is loaded — see the rotation section. Default users get a plain map.
    const _mapOpts = { tap: true, bounceAtZoomLimits: false };
    if (_rotateReady) { _mapOpts.rotate = true; _mapOpts.rotateControl = false; _mapOpts.touchRotate = true; _mapOpts.bearing = 0; }
    state.d2dMap = L.map('d2dMap', _mapOpts).setView(CINCINNATI, 13);

    // Base map — restore the rep's last choice (default satellite).
    let initialBasemap = 'satellite';
    try { const saved = localStorage.getItem(BASEMAP_PREF); if (saved && BASEMAPS[saved]) initialBasemap = saved; } catch (_) {}
    setBasemap(initialBasemap);

    // Restore the rep's last mark look (dots vs pins) before the first paint.
    try { const savedStyle = localStorage.getItem(MARK_STYLE_PREF); if (savedStyle === 'pins' || savedStyle === 'dots') state.d2dMarkStyle = savedStyle; } catch (_) {}
    // Restore the opt-in map-rotation preference (activated at the end of init).
    try { state.d2dRotateEnabled = (localStorage.getItem(ROTATE_PREF) === '1'); } catch (_) {}
    // If a rotation rebuild preserved a viewport, restore it over the default.
    if (_pendingRebuildView) { try { state.d2dMap.setView(_pendingRebuildView.center, _pendingRebuildView.zoom); } catch (_) {} _pendingRebuildView = null; }

    // Force map to recalculate size after standalone viewport settles
    if (isStandalone) {
      setTimeout(() => { if (state.d2dMap) state.d2dMap.invalidateSize(); }, 500);
      setTimeout(() => { if (state.d2dMap) state.d2dMap.invalidateSize(); }, 1500);
    }

    state.d2dCluster = L.markerClusterGroup({ maxClusterRadius: 40, disableClusteringAtZoom: 17 });
    state.d2dMap.addLayer(state.d2dCluster);

    state.d2dMap.on('click', function(e) {
      if (window.D2D && typeof window.D2D.openQuickKnock === 'function') {
        window.D2D.openQuickKnock({ lat: e.latlng.lat, lng: e.latlng.lng });
      }
    });

    // Restore the rep's follow preference (heading watch still needs a user
    // gesture to start on iOS, so it engages when they next tap Follow).
    try { state.d2dFollowMode = (localStorage.getItem(FOLLOW_PREF) === '1'); } catch (_) {}
    state.d2dFollowPaused = false;

    watchLocationAndCenter();
    refreshMapMarkers();
    createLayerPanel(); // includes the "view type" (basemap) switcher — one panel
    createSearchAreaControl();
    _createRecenterControl();
    _createD2DSearchControl(); // on-map address search (ported from Maps & Pins)
    // A manual drag pauses follow (see _onUserDragStart).
    state.d2dMap.on('dragstart', _onUserDragStart);
    // Load saved territories into state on entry so knocks can be attributed to a
    // storm zone (point-in-polygon) even before the territory layer is toggled.
    loadTerritories().catch(() => {});
    maybeFocusStormTerritory();

    // Opted-in-to-rotation reps: activate it now (lazy-loads the plugin and,
    // if this map wasn't built rotate-capable, rebuilds once). Guarded so the
    // rebuild's own re-init doesn't loop.
    if (state.d2dRotateEnabled && !_rotateReady && !_rotateRebuilding) { _enableRotation(); }
  }

  // Ray-casting point-in-polygon. ring = [[lng,lat],...] (GeoJSON order).
  function pointInRing(lng, lat, ring) {
    if (!Array.isArray(ring)) return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const hit = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }

  // Attribute a knock to the first storm-zone-backed territory that contains it,
  // then write the count back to Storm Center (whose zones are localStorage-only).
  function attributeKnockToStormZone(lat, lng, isLead) {
    if (lat == null || lng == null) return;
    if (!window.StormCenter || typeof window.StormCenter.recordKnock !== 'function') return;
    const terrs = state.territories || [];
    for (let i = 0; i < terrs.length; i++) {
      const t = terrs[i];
      const ring = t && t.stormZoneId && t.geoJSON && t.geoJSON.geometry &&
        t.geoJSON.geometry.coordinates && t.geoJSON.geometry.coordinates[0];
      if (ring && pointInRing(lng, lat, ring)) {
        window.StormCenter.recordKnock(t.stormZoneId, !!isLead);
        return;
      }
    }
  }

  // When a rep arrives here from a Storm Center "Start Knocking" push, surface
  // the just-pushed territory (rendered directly into the territory feature
  // group — independent of the Leaflet.Draw control) and zoom to it. Guarded by
  // a ONE-SHOT localStorage hint that's cleared immediately, so normal D2D entry
  // is completely unaffected.
  function maybeFocusStormTerritory() {
    let bounds = null;
    try {
      const raw = localStorage.getItem('nbd_d2d_focus_bounds');
      if (raw) { bounds = JSON.parse(raw); localStorage.removeItem('nbd_d2d_focus_bounds'); }
    } catch (_) {}
    if (!bounds || !state.d2dMap) return;
    if (!d2dTerritoryGroup) { d2dTerritoryGroup = new L.FeatureGroup(); state.d2dMap.addLayer(d2dTerritoryGroup); }
    d2dLayerState.territory = true;
    try { updateLayerPanel(); } catch (_) {}
    Promise.resolve(renderSavedTerritories()).catch(() => {}).then(() => {
      try {
        state.d2dMap.fitBounds([[bounds.south, bounds.west], [bounds.north, bounds.east]], { padding: [40, 40], maxZoom: 15 });
      } catch (_) {}
    });
  }

  // Tracks whether we've surfaced a GPS-denial/error toast this session —
  // suppresses a stream of identical toasts when watchPosition emits repeatedly.
  let _gpsErrorNotified = false;

  function watchLocationAndCenter() {
    if (!navigator.geolocation) {
      // Audit #15: was a silent return. Now give the rep a clear explanation
      // so they know why the blue-dot location marker isn't appearing.
      window.showToast?.('GPS not available on this device. D2D map will still work, but your location won\'t auto-track.', 'warning', 6000);
      return;
    }
    // Require HTTPS for geolocation — iOS Safari silently denies on http://
    if (typeof window !== 'undefined' && window.location && window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      window.showToast?.('GPS requires HTTPS. Open this site via https:// to enable location tracking.', 'warning', 6000);
      return;
    }
    // Defensive: clear any prior watch before opening a new one. Without
    // this, a route that re-enters D2D (e.g. tab switch + return) leaks
    // multiple GPS subscribers, each draining battery.
    stopLocationWatch();
    state.watchId = navigator.geolocation.watchPosition(
      function(pos) {
        _gpsErrorNotified = false; // clear on first successful fix
        state.currentLocation = [pos.coords.latitude, pos.coords.longitude];
        state.gpsFixAt = Date.now(); // for the nav-health "fix N s ago" readout
        // Fix accuracy in metres — used to warn before trusting a door number
        // resolved at/near the device position when the GPS fix is weak.
        state.gpsAccuracy = (typeof pos.coords.accuracy === 'number') ? pos.coords.accuracy : null;
        // GPS course = direction of MOVEMENT. Use it for the heading arrow only
        // when the compass isn't the source (compass = facing, more responsive).
        if (!_compassActive && typeof pos.coords.heading === 'number' && !isNaN(pos.coords.heading)) {
          _onHeading(pos.coords.heading);
        }
        // Redraw the location marker (heading arrow + accuracy ring).
        _updateLocationMarker();
        // Follow mode: keep the map centered on the rep (unless they've paused
        // it by dragging). Flagged so this move doesn't pop the search pill.
        if (state.d2dFollowMode && !state.d2dFollowPaused) _recenterFollow();
      },
      function(err) {
        console.warn('Geolocation error:', err);
        if (_gpsErrorNotified) return; // only surface once per session
        _gpsErrorNotified = true;
        // err.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
        let msg;
        if (err && err.code === 1) {
          // Platform-specific path: this used to name Safari on every
          // device, which is wrong on Android (2026-09-24 phone pass).
          const ua = navigator.userAgent || '';
          const where = /iP(ad|hone|od)/.test(ua)
            ? 'Settings → Safari → Location'
            : /Android/.test(ua)
              ? 'your browser\'s site settings (tap the lock icon by the address bar → Permissions → Location)'
              : 'your browser\'s site settings for this page';
          msg = 'Location permission denied. Enable it in ' + where + ' to track knocks on the map.';
        } else if (err && err.code === 2) {
          msg = 'Can\'t determine your location right now. Try moving to an area with a clearer sky view.';
        } else if (err && err.code === 3) {
          msg = 'GPS is slow to respond. You can still tap the map to log knocks manually.';
        } else {
          msg = 'GPS is unavailable. Tap on the map to log knocks manually.';
        }
        window.showToast?.(msg, 'warning', 7000);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  // Audit findings #3 + #12: the GPS watch was never released. Safari
  // throttles aggressively in background but does NOT auto-cancel a
  // watchPosition() handle on tab hide — battery drain on iPhone D2D
  // sessions was severe (60-min session ≈ 30% battery). Three exit
  // paths now stop the watch:
  //   (a) explicit stopLocationWatch() called from D2D teardown
  //   (b) page visibility change → hidden  → stop; visible → restart
  //   (c) beforeunload / pagehide → stop unconditionally
  // Resume on visibility-restore is conditional on the map still being
  // mounted; D2D module unload paths leave d2dMap === null which short-
  // circuits the resume.
  function stopLocationWatch() {
    if (state.watchId !== null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (_) {}
      state.watchId = null;
    }
    _stopHeadingWatch(); // release the compass listener + any pending rAF too
    if (state.locationMarker && state.d2dMap) { try { state.d2dMap.removeLayer(state.locationMarker); } catch (_) {} state.locationMarker = null; }
    if (state.accuracyCircle && state.d2dMap) { try { state.d2dMap.removeLayer(state.accuracyCircle); } catch (_) {} state.accuracyCircle = null; }
  }
  if (typeof document !== 'undefined' && !document._nbdD2DGeoLifecycle) {
    document._nbdD2DGeoLifecycle = true;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        stopLocationWatch();
      } else if (document.visibilityState === 'visible' && state.d2dMap && state.d2dInited) {
        watchLocationAndCenter();
      }
    });
    // pagehide is the only event that fires reliably across Safari
    // back/forward cache + iOS PWA tab close. beforeunload doesn't
    // fire in iOS Safari standalone.
    window.addEventListener('pagehide', stopLocationWatch);
    window.addEventListener('pagehide', unsubscribeTeamActivity);
  }

  function centerOnMe() {
    if (state.currentLocation && state.d2dMap) {
      state.d2dMap.setView(state.currentLocation, 16);
      window.showToast?.('Centered on your location', 'info');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // FOLLOW MODE + HEADING ARROW (field navigation, phase A)
  // Follow recenters the map on the rep as they move; a manual drag pauses it
  // (a Recenter button resumes). The location marker becomes a heading arrow
  // when a heading is available — from the phone compass (facing; needs the
  // iOS permission gesture) or GPS course (movement; no extra permission).
  // The map stays NORTH-UP here; the opt-in "rotate map to heading" mode is a
  // separate setting (phase B).
  //
  // Perf/verification note (the compass handler runs many times/second): it
  // does NOT recreate the marker per event. It rAF-coalesces and writes ONE
  // element's CSS rotate transform, and only when the heading moved past a 3°
  // threshold. That write re-fires no event and touches no map state, so there
  // is no oscillation loop. Follow's own setView is flagged so it can't make
  // the "Search this area" pill appear on every step.
  const FOLLOW_PREF = 'nbd_d2d_follow';
  let _followProgrammaticMove = false; // set before a follow/recenter setView; cleared in the moveend guard
  let _compassActive = false;
  let _headingListener = null;
  let _pendingHeading = null, _headingRafId = 0, _lastAppliedHeading = null;
  // Circular low-pass filter for the (jittery) compass heading — smooths the
  // arrow/map so it glides instead of twitching. Averaged as a unit vector so
  // it behaves correctly across the 0°/360° wrap (359°→1° eases through 0, not
  // back through 180). Alpha ≈ responsiveness vs smoothness.
  let _headingSmX = null, _headingSmY = null;
  const HEADING_SMOOTH_ALPHA = 0.25;
  function _smoothHeading(deg) {
    const rad = deg * Math.PI / 180, x = Math.cos(rad), y = Math.sin(rad);
    if (_headingSmX == null) { _headingSmX = x; _headingSmY = y; }
    else {
      _headingSmX += HEADING_SMOOTH_ALPHA * (x - _headingSmX);
      _headingSmY += HEADING_SMOOTH_ALPHA * (y - _headingSmY);
    }
    return (Math.atan2(_headingSmY, _headingSmX) * 180 / Math.PI + 360) % 360;
  }

  function _locationIcon(heading) {
    const hasH = (typeof heading === 'number' && !isNaN(heading));
    const arrow = '<div class="d2d-loc-arrow" style="position:absolute;left:50%;top:50%;'
      + 'transform:translate(-50%,-50%) rotate(' + (hasH ? heading : 0) + 'deg);transform-origin:center;'
      + 'display:' + (hasH ? 'block' : 'none') + ';">'
      + '<svg width="42" height="42" viewBox="0 0 42 42"><path d="M21 3 L29 21 L21 16 L13 21 Z" fill="#4A9EFF" stroke="#fff" stroke-width="1"/></svg>'
      + '</div>';
    // .d2d-location-pulse (theme-bridge.css) gives the radiating "you are here"
    // pulse + the blue dot styling; we only add positioning inline.
    const dot = '<div class="d2d-location-pulse" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);"></div>';
    return L.divIcon({ html: '<div style="position:relative;width:42px;height:42px;">' + arrow + dot + '</div>',
      iconSize: [42, 42], iconAnchor: [21, 21], className: '' });
  }

  function _updateLocationMarker() {
    if (!state.d2dMap || !state.currentLocation) return;
    if (state.locationMarker) { try { state.d2dMap.removeLayer(state.locationMarker); } catch (_) {} }
    if (state.accuracyCircle) { try { state.d2dMap.removeLayer(state.accuracyCircle); } catch (_) {} }
    if (typeof state.gpsAccuracy === 'number' && state.gpsAccuracy > 0) {
      state.accuracyCircle = L.circle(state.currentLocation, { radius: state.gpsAccuracy, color: '#4A9EFF', fillColor: '#4A9EFF', fillOpacity: 0.1, weight: 1 }).addTo(state.d2dMap);
    }
    state.locationMarker = L.marker(state.currentLocation, { icon: _locationIcon(state.d2dHeading), interactive: false, keyboard: false }).addTo(state.d2dMap);
  }

  // Cheap heading apply (rAF-coalesced): rotate the existing arrow element;
  // recreate the marker only if it was placed before any heading (no arrow).
  function _applyHeadingToMarker() {
    _headingRafId = 0;
    if (_pendingHeading == null) return;
    const deg = _pendingHeading;
    state.d2dHeading = deg;
    // When the map itself spins to the heading (beta), the arrow points
    // straight up (screen-up = where you're heading) and the MAP rotates;
    // otherwise (north-up default) the arrow rotates to the heading.
    const rotating = state.d2dRotateEnabled && _rotateReady;
    if (rotating) _applyBearingFromHeading(deg);
    const arrowDeg = rotating ? 0 : deg;
    const el = state.locationMarker && state.locationMarker.getElement && state.locationMarker.getElement();
    const arrow = el && el.querySelector('.d2d-loc-arrow');
    if (arrow) {
      arrow.style.display = 'block';
      arrow.style.transform = 'translate(-50%,-50%) rotate(' + arrowDeg + 'deg)';
    } else if (state.locationMarker) {
      _updateLocationMarker();
    }
  }

  function _onHeading(deg) {
    if (deg == null || isNaN(deg)) return;
    deg = ((deg % 360) + 360) % 360;
    deg = _smoothHeading(deg); // low-pass the compass jitter before we act on it
    if (_lastAppliedHeading != null) {
      const d = Math.abs(deg - _lastAppliedHeading);
      if (Math.min(d, 360 - d) < 3) return; // ignore sub-3° jitter — don't churn the DOM
    }
    _lastAppliedHeading = deg;
    _pendingHeading = deg;
    if (!_headingRafId && typeof requestAnimationFrame === 'function') _headingRafId = requestAnimationFrame(_applyHeadingToMarker);
    else if (!_headingRafId) _applyHeadingToMarker();
  }

  function _deviceOrientationHandler(ev) {
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading;      // iOS: 0..360 from N, CW
    else if (ev.absolute && typeof ev.alpha === 'number') h = (360 - ev.alpha) % 360;   // best-effort elsewhere
    if (h != null) { _compassActive = true; _onHeading(h); }
  }

  function _startHeadingWatch() {
    if (_headingListener || typeof window === 'undefined') return;
    const attach = () => {
      _headingListener = _deviceOrientationHandler;
      window.addEventListener('deviceorientationabsolute', _headingListener, true);
      window.addEventListener('deviceorientation', _headingListener, true);
    };
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+: requestPermission MUST be called from a user gesture — our
        // toggle click is that gesture.
        DeviceOrientationEvent.requestPermission().then(function (res) {
          if (res === 'granted') attach();
          else window.showToast?.('Compass denied — heading will use GPS while you move', 'info', 4000);
        }).catch(function () {});
      } else {
        attach();
      }
    } catch (_) {}
  }

  function _stopHeadingWatch() {
    if (_headingListener) {
      try { window.removeEventListener('deviceorientationabsolute', _headingListener, true); } catch (_) {}
      try { window.removeEventListener('deviceorientation', _headingListener, true); } catch (_) {}
      _headingListener = null;
    }
    _compassActive = false;
    if (_headingRafId && typeof cancelAnimationFrame === 'function') { try { cancelAnimationFrame(_headingRafId); } catch (_) {} }
    _headingRafId = 0;
    _pendingHeading = null;
    _headingSmX = null; _headingSmY = null; _lastAppliedHeading = null; // reset the smoothing filter
  }

  function _recenterFollow() {
    if (!state.d2dMap || !state.currentLocation) return;
    _followProgrammaticMove = true; // suppress the "Search this area" pill for this move
    state.d2dMap.setView(state.currentLocation, state.d2dMap.getZoom());
  }

  function toggleFollow() {
    state.d2dFollowMode = !state.d2dFollowMode;
    state.d2dFollowPaused = false;
    try { localStorage.setItem(FOLLOW_PREF, state.d2dFollowMode ? '1' : '0'); } catch (_) {}
    _updateFollowControls();
    if (state.d2dFollowMode) {
      _startHeadingWatch(); // called synchronously inside the click gesture → iOS permission prompt allowed
      _recenterFollow();
      window.showToast?.('Follow mode on — the map tracks you', 'info', 2000);
    } else {
      window.showToast?.('Follow mode off', 'info', 1500);
    }
  }

  function _updateFollowControls() {
    const btn = document.getElementById('d2d-follow');
    if (btn) {
      const on = state.d2dFollowMode;
      btn.style.background = on ? 'color-mix(in srgb, var(--orange) 20%, transparent)' : 'transparent';
      btn.style.borderColor = on ? 'var(--orange)' : 'var(--br)';
      btn.style.color = on ? 'var(--t)' : 'var(--m)';
      btn.innerHTML = (on && state.d2dFollowPaused) ? '🧭 Paused' : '🧭 Follow';
    }
    const rc = document.getElementById('d2d-recenter');
    if (rc) rc.style.display = (state.d2dFollowMode && state.d2dFollowPaused) ? 'flex' : 'none';
  }

  // A manual drag pauses follow so the rep can look around; the Recenter
  // button resumes. Programmatic follow moves don't fire dragstart, so this
  // only triggers on real user drags — no feedback loop with _recenterFollow.
  function _onUserDragStart() {
    if (state.d2dFollowMode && !state.d2dFollowPaused) {
      state.d2dFollowPaused = true;
      _updateFollowControls();
    }
  }

  function _createRecenterControl() {
    if (!state.d2dMap || document.getElementById('d2d-recenter')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'd2d-recenter';
    btn.title = 'Recenter on me and resume following';
    btn.textContent = '◎ Recenter';
    btn.style.cssText = 'position:absolute;left:50%;bottom:88px;transform:translateX(-50%);z-index:1000;display:none;'
      + 'align-items:center;gap:6px;background:var(--orange,#BD5728);color:#0A0C0F;border:none;'
      + 'padding:8px 14px;border-radius:20px;cursor:pointer;'
      + "font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:800;letter-spacing:.03em;"
      + 'box-shadow:0 3px 14px rgba(0,0,0,.5);-webkit-tap-highlight-color:transparent;min-height:38px;';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      state.d2dFollowPaused = false;
      _recenterFollow();
      _updateFollowControls();
    });
    const mapEl = document.getElementById('d2dMap');
    if (mapEl) { mapEl.style.position = 'relative'; mapEl.appendChild(btn); }
  }

  // ══════════════════════════════════════════════════════════════════
  // MAP ROTATION — "spin to my heading" (OPT-IN / BETA, phase B)
  // Leaflet has no native rotation, so this lazy-loads the leaflet-rotate
  // plugin and recreates the map with rotate:true — but ONLY when the rep
  // opts in. Default users never load the plugin and never touch this code,
  // so a broken rotation can't affect anyone who hasn't switched it on. Every
  // step degrades gracefully (plugin blocked/absent, no setBearing, CSP): it
  // reverts the toggle with an honest toast rather than breaking the map.
  //
  // NOT device-verified — rotation rendering + the exact bearing sign need a
  // real phone. Hence the "beta" label and the default-off gate.
  const ROTATE_PREF = 'nbd_d2d_rotate';
  // Vendored SAME-ORIGIN (see docs/assets/vendor/leaflet-rotate/) so it loads
  // under the strict /pro CSP (script-src 'self') with no CSP change — matching
  // how leaflet/draw/heat/markercluster are already served. Loaded lazily and
  // only for reps who opt into rotation.
  const LEAFLET_ROTATE_URL = '/assets/vendor/leaflet-rotate/leaflet-rotate.js';
  let _rotateReady = false;         // plugin loaded AND the live map was built with rotate:true
  let _rotatePluginPromise = null;
  let _rotateRebuilding = false;    // re-entrancy guard around the map rebuild
  let _pendingRebuildView = null;   // {center:[lat,lng], zoom} preserved across a rebuild

  function _rotatePluginPresent() {
    return !!(typeof L !== 'undefined' && L.Map && L.Map.prototype && typeof L.Map.prototype.setBearing === 'function');
  }

  function _loadRotatePlugin() {
    if (_rotatePluginPresent()) return Promise.resolve(true);
    if (_rotatePluginPromise) return _rotatePluginPromise;
    _rotatePluginPromise = new Promise(function (resolve) {
      try {
        const s = document.createElement('script');
        s.src = LEAFLET_ROTATE_URL;
        s.async = true;
        s.onload = function () { resolve(_rotatePluginPresent()); };
        s.onerror = function () { _rotatePluginPromise = null; resolve(false); };
        document.head.appendChild(s);
      } catch (_) { _rotatePluginPromise = null; resolve(false); }
    });
    return _rotatePluginPromise;
  }

  // Recreate the map with rotate:true, preserving view/zoom. Only reached for
  // opted-in reps. Guarded + wrapped so a failure reverts cleanly.
  function _rebuildD2DMap() {
    if (_rotateRebuilding || !state.d2dMap) return;
    _rotateRebuilding = true;
    try {
      let center = null, zoom = null;
      try { const c = state.d2dMap.getCenter(); center = [c.lat, c.lng]; zoom = state.d2dMap.getZoom(); } catch (_) {}
      _pendingRebuildView = (center && zoom != null) ? { center: center, zoom: zoom } : null;
      try { stopLocationWatch(); } catch (_) {}
      try { state.d2dMap.off(); state.d2dMap.remove(); } catch (_) {}
      state.d2dMap = null; state.d2dCluster = null;
      state.locationMarker = null; state.accuracyCircle = null;
      const el = document.getElementById('d2dMap');
      if (el) el.innerHTML = ''; // drop stale control divs so create*Control() rebuild them
      initD2DMap(); // rebuilds with rotate:true because _rotateReady is now set
    } catch (e) {
      console.error('map rotation rebuild failed:', e);
      window.showToast?.('Couldn\'t start map rotation — reload the map', 'error', 4000);
    } finally {
      _rotateRebuilding = false;
    }
  }

  async function _enableRotation() {
    const ok = await _loadRotatePlugin();
    if (!ok) {
      state.d2dRotateEnabled = false;
      try { localStorage.setItem(ROTATE_PREF, '0'); } catch (_) {}
      _updateRotateControls();
      window.showToast?.('Map rotation unavailable on this device/network', 'error', 4000);
      return false;
    }
    _rotateReady = true;
    if (!(state.d2dMap && typeof state.d2dMap.setBearing === 'function')) {
      _rebuildD2DMap(); // current map wasn't built with rotate — recreate it
    }
    window.showToast?.('Map rotation on (beta) — north is no longer up', 'info', 3000);
    // Apply the current heading immediately if we have one.
    if (state.d2dHeading != null) _applyBearingFromHeading(state.d2dHeading);
    return true;
  }

  // Rotate the map so the rep's heading points to the top of the screen. Sign
  // is best-effort (unverified) — flagged for device tuning.
  function _applyBearingFromHeading(deg) {
    if (!state.d2dRotateEnabled || !_rotateReady) return;
    if (!(state.d2dMap && typeof state.d2dMap.setBearing === 'function')) return;
    try { state.d2dMap.setBearing(-deg); } catch (_) {}
  }

  function toggleMapRotate() {
    state.d2dRotateEnabled = !state.d2dRotateEnabled;
    try { localStorage.setItem(ROTATE_PREF, state.d2dRotateEnabled ? '1' : '0'); } catch (_) {}
    _updateRotateControls();
    if (state.d2dRotateEnabled) {
      _startHeadingWatch();      // rotation needs a heading; this click is the iOS gesture
      _enableRotation();         // lazy-loads plugin + rebuilds if needed (async, self-reverts on failure)
    } else {
      // North-up again — no rebuild needed, just clear the bearing.
      if (_rotateReady && state.d2dMap && typeof state.d2dMap.setBearing === 'function') {
        try { state.d2dMap.setBearing(0); } catch (_) {}
      }
      // Restore the heading ARROW (north-up mode rotates the arrow, not the map).
      if (state.d2dHeading != null) { _pendingHeading = state.d2dHeading; _applyHeadingToMarker(); }
      window.showToast?.('Map rotation off — north is up', 'info', 1500);
    }
  }

  function _updateRotateControls() {
    const btn = document.getElementById('d2d-rotate');
    if (!btn) return;
    const on = state.d2dRotateEnabled;
    btn.style.background = on ? 'color-mix(in srgb, var(--orange) 20%, transparent)' : 'transparent';
    btn.style.borderColor = on ? 'var(--orange)' : 'var(--br)';
    btn.style.color = on ? 'var(--t)' : 'var(--m)';
  }

  // ── ON-MAP ADDRESS SEARCH (map unification, phase C) ──────────────
  // The one thing the retired Maps & Pins map had that D2D lacked: search an
  // address ON the map. (County-records property intel is unchanged — it still
  // lives on the lead modal's "🏠 Pull Property Intel".) Geocode → fly there →
  // drop a temp pin whose popup can spin up a lead (from which the rep pulls
  // intel via the existing flow). Self-contained Nominatim call, same fair-use
  // endpoint the layers use.
  let _d2dSearchMarker = null;
  async function d2dSearchAddress(q) {
    q = (q || '').trim();
    if (!q || !state.d2dMap) return;
    window.showToast?.('Searching…', 'info', 1200);
    try {
      const res = await fetch(NOMINATIM_SEARCH + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      if (!data || !data[0]) { window.showToast?.('Address not found', 'error'); return; }
      const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
      const label = String(data[0].display_name || q).split(',').slice(0, 3).join(',').trim();
      _followProgrammaticMove = true; // intentional jump — don't pop the "Search this area" pill
      state.d2dMap.setView([lat, lng], 18);
      if (_d2dSearchMarker) { try { state.d2dMap.removeLayer(_d2dSearchMarker); } catch (_) {} }
      const icon = L.divIcon({ html: '<div style="font-size:26px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55));">📍</div>', iconSize: [26, 26], iconAnchor: [13, 26], className: '' });
      const popup = document.createElement('div');
      popup.style.cssText = 'font-family:sans-serif;min-width:180px;font-size:12px;';
      popup.innerHTML = '<strong>' + esc(label) + '</strong>';
      const mk = document.createElement('button');
      mk.textContent = '＋ Create lead here';
      mk.style.cssText = 'display:block;margin-top:8px;padding:5px 9px;background:var(--orange,#BD5728);color:#0A0C0F;border:none;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;';
      // Reuse the existing lead flow (from which "🏠 Pull Property Intel" works).
      mk.addEventListener('click', function () {
        try { window.openLeadModal && window.openLeadModal(); } catch (_) {}
        setTimeout(function () {
          const el = document.getElementById('lAddr'); if (el) el.value = label;
          const s = document.getElementById('lSource'); if (s) s.value = 'Door Knock';
          try { document.getElementById('lFname') && document.getElementById('lFname').focus(); } catch (_) {}
        }, 120);
      });
      popup.appendChild(mk);
      _d2dSearchMarker = L.marker([lat, lng], { icon: icon }).addTo(state.d2dMap).bindPopup(popup).openPopup();
    } catch (e) {
      console.error('d2d address search failed:', e);
      window.showToast?.('Search failed — try again', 'error');
    }
  }

  function _createD2DSearchControl() {
    if (!state.d2dMap || document.getElementById('d2d-addr-search')) return;
    const wrap = document.createElement('div');
    wrap.id = 'd2d-addr-search';
    // Top bar: inset left to clear Leaflet's top-left zoom buttons, span to the
    // right edge. The layer panel drops to row 2 so they never share a row.
    wrap.style.cssText = 'position:absolute;top:8px;left:52px;right:8px;z-index:1000;display:flex;gap:4px;';
    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'd2d-addr-input';
    input.placeholder = 'Search address…';
    input.style.cssText = 'flex:1;min-width:120px;background:color-mix(in srgb, var(--s) 92%, transparent);color:var(--t);'
      + 'border:1px solid var(--br);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;'
      + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 3px 14px rgba(0,0,0,.4);';
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); d2dSearchAddress(input.value); } });
    const go = document.createElement('button');
    go.type = 'button';
    go.title = 'Search this address';
    go.textContent = '🔎';
    go.style.cssText = 'background:var(--orange,#BD5728);color:#0A0C0F;border:none;border-radius:8px;width:38px;'
      + 'cursor:pointer;font-size:15px;box-shadow:0 3px 14px rgba(0,0,0,.4);-webkit-tap-highlight-color:transparent;';
    go.addEventListener('click', function (e) { e.stopPropagation(); d2dSearchAddress(input.value); });
    wrap.appendChild(input);
    wrap.appendChild(go);
    // Don't let typing / scrolling in the box drive the map (pan, quick-knock).
    if (L.DomEvent) { L.DomEvent.disableClickPropagation(wrap); L.DomEvent.disableScrollPropagation(wrap); }
    const mapEl = document.getElementById('d2dMap');
    if (mapEl) { mapEl.style.position = 'relative'; mapEl.appendChild(wrap); }
  }

  // Build a knock marker's icon in the current look style. Colour encodes
  // status (the disposition colour) in BOTH styles — only the shape differs:
  //   'dots' — detailed disposition-coded circle (the analytical D2D look)
  //   'pins' — simple colour teardrop 📍 (the cleaner CRM-map look)
  // The disposition colour is a whitelisted hex from DISPOSITIONS, but it is
  // escaped before entering the SVG anyway (defence-in-depth, matches the
  // maps-overlays pin path).
  function _d2dMarkerIcon(dispo) {
    const color = (dispo && dispo.color) || '#666';
    if (state.d2dMarkStyle === 'pins') {
      const safe = esc(color);
      const svg = '<svg viewBox="0 0 24 32" width="22" height="30" xmlns="http://www.w3.org/2000/svg">'
        + '<path d="M12 0C7.6 0 4 3.6 4 8c0 6 8 16 8 16s8-10 8-16c0-4.4-3.6-8-8-8z" fill="' + safe + '" stroke="white" stroke-width="1.5"/>'
        + '<circle cx="12" cy="8" r="3" fill="white"/></svg>';
      return L.divIcon({
        html: '<div style="filter:drop-shadow(0 2px 4px rgba(0,0,0,.5));">' + svg + '</div>',
        iconSize: [22, 30], iconAnchor: [11, 30], popupAnchor: [0, -30], className: ''
      });
    }
    // Default: detailed dot — disposition short-code in a colour-filled circle.
    const label = document.createElement('div');
    label.style.cssText = `background:${color};width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:bold;border:2px solid white;`;
    label.textContent = (dispo && dispo.short) || '?';
    return L.divIcon({ html: label.outerHTML, iconSize: [30, 30], className: '' });
  }

  function _markStyleBtnLabel() { return state.d2dMarkStyle === 'pins' ? '📍 Pins' : '⚫ Dots'; }

  // Flip the whole map between detailed dots and colour pins, persist the
  // choice, and repaint. refreshMapMarkers() fully rebuilds the cluster, so
  // this is a clean redraw — no per-marker mutation, no oscillation vector.
  function toggleMarkStyle() {
    state.d2dMarkStyle = (state.d2dMarkStyle === 'pins') ? 'dots' : 'pins';
    try { localStorage.setItem(MARK_STYLE_PREF, state.d2dMarkStyle); } catch (_) {}
    const btn = document.getElementById('d2d-mark-style');
    if (btn) btn.innerHTML = _markStyleBtnLabel();
    refreshMapMarkers();
    // Leads honor the same look — restyle them too if the layer is showing.
    if (d2dLayerState.customers) buildD2DCustomersLayer();
    window.showToast?.(state.d2dMarkStyle === 'pins' ? 'Color pins' : 'Detailed dots', 'info', 1500);
  }

  function refreshMapMarkers() {
    if (!state.d2dMap || !state.d2dCluster) return;
    state.d2dCluster.clearLayers();
    if (state.d2dHeat) state.d2dMap.removeLayer(state.d2dHeat);
    // The neighborhood-score overlay is a tracked layer group so it is
    // rebuilt-from-scratch every refresh instead of piling circles onto the
    // map forever (the old bug: circles were added straight to the map and
    // never removed, so they multiplied and never disappeared).
    if (state.d2dScoreLayer) { try { state.d2dMap.removeLayer(state.d2dScoreLayer); } catch (_) {} state.d2dScoreLayer = null; }

    // Audit #18 (same class of bug): Timestamp > Timestamp is NaN > NaN.
    // Normalize both sides through toDate() so the map pins reflect the most
    // recent disposition per address instead of the first-seen one.
    const addrMap = new Map();
    state.knocks.forEach(k => {
      const norm = normalizeAddress(k.address);
      const existing = addrMap.get(norm);
      const kMs = (toDate(k.createdAt) || new Date(0)).getTime();
      const eMs = existing ? (toDate(existing.createdAt) || new Date(0)).getTime() : -Infinity;
      if (!existing || kMs > eMs) {
        addrMap.set(norm, k);
      }
    });

    // One mark per house (map-unification phase 3): when the Customers layer
    // is showing, a house that is ALSO a lead/customer is drawn by that layer
    // (coloured by pipeline stage — the house's furthest-along status), so we
    // suppress the duplicate knock mark here. Guarded on the lead having
    // coordinates so a house never vanishes (an address-only lead that can't
    // be placed leaves its knock visible). No effect when the layer is off.
    const suppressAddrs = d2dLayerState.customers ? _leadAddrSetWithCoords() : null;

    const heatData = [];
    addrMap.forEach((knock, norm) => {
      if (suppressAddrs && suppressAddrs.has(norm)) return; // shown as its customer mark
      if (!knock.lat || !knock.lng) return;
      const dispo = DISPOSITIONS[knock.disposition];
      const attempts = getAttemptCount(knock.address);
      const icon = _d2dMarkerIcon(dispo);

      // Build popup with data-attributes + touchend listeners instead of inline onclick
      // (iOS Safari standalone swallows inline onclick in Leaflet popups)
      const popupDiv = document.createElement('div');
      popupDiv.style.cssText = 'font-size:12px;';
      popupDiv.innerHTML = `<strong>${esc(knock.address)}</strong><br/>${dispo?.icon} ${dispo?.label}<br/>Knock #${attempts}/${MAX_ATTEMPTS}<br/><small>${timeAgo(knock.createdAt)}</small><br/>`;

      const detailBtn = document.createElement('button');
      detailBtn.textContent = 'Details';
      detailBtn.style.cssText = 'margin-top:8px;padding:4px 8px;background:var(--blue, #4A9EFF);color:white;border:none;border-radius:3px;cursor:pointer;font-size:11px;';
      detailBtn.addEventListener('click', function(ev) { ev.stopPropagation(); if (window.D2D) window.D2D.openKnockDetail(knock.id); });
      detailBtn.addEventListener('touchend', function(ev) { ev.stopPropagation(); ev.preventDefault(); if (window.D2D) window.D2D.openKnockDetail(knock.id); });

      const reknockBtn = document.createElement('button');
      reknockBtn.textContent = 'Re-Knock';
      reknockBtn.style.cssText = 'margin-top:8px;margin-left:4px;padding:4px 8px;background:var(--orange, #BD5728);color:white;border:none;border-radius:3px;cursor:pointer;font-size:11px;';
      reknockBtn.addEventListener('click', function(ev) { ev.stopPropagation(); if (window.D2D) window.D2D.openQuickKnock({address:knock.address, lat:knock.lat, lng:knock.lng}); });
      reknockBtn.addEventListener('touchend', function(ev) { ev.stopPropagation(); ev.preventDefault(); if (window.D2D) window.D2D.openQuickKnock({address:knock.address, lat:knock.lat, lng:knock.lng}); });

      popupDiv.appendChild(detailBtn);
      popupDiv.appendChild(reknockBtn);

      const marker = L.marker([knock.lat, knock.lng], { icon }).bindPopup(popupDiv);
      state.d2dCluster.addLayer(marker);
      heatData.push([knock.lat, knock.lng, 0.5]);
    });

    if (state.showHeat && heatData.length > 0) {
      state.d2dHeat = L.heatLayer(heatData, { radius: 30, blur: 20, maxZoom: 17 }).addTo(state.d2dMap);
    }

    // Neighborhood-score overlay — opt-in layer (toggled from the map's layer
    // panel, OFF by default). Every shape is `interactive:false` so it NEVER
    // swallows a map tap: reps must be able to tap a house *inside* a hot zone
    // to log a knock. The score reads out on a small non-interactive badge at
    // the zone centroid (the old bound-popup ate the tap).
    if (d2dLayerState.score && Object.keys(state.neighborhoodScores).length > 0) {
      const scoreLayer = L.layerGroup();
      Object.values(state.neighborhoodScores).forEach(n => {
        if (n.score > 30 && n.knocks.length >= 3) {
          const scoreColor = n.score >= 70 ? '#2ECC8A' : n.score >= 40 ? '#EAB308' : '#E05252';
          L.circle([n.lat, n.lng], {
            radius: 250, color: scoreColor, fillColor: scoreColor,
            fillOpacity: 0.10, weight: 1.5, dashArray: '5 5', interactive: false
          }).addTo(scoreLayer);
          const badge = L.divIcon({
            className: 'd2d-score-badge-wrap',
            html: `<div class="d2d-score-badge" style="background:${scoreColor};">${n.score}</div>`,
            iconSize: [34, 34], iconAnchor: [17, 17]
          });
          L.marker([n.lat, n.lng], { icon: badge, interactive: false, keyboard: false }).addTo(scoreLayer);
        }
      });
      scoreLayer.addTo(state.d2dMap);
      state.d2dScoreLayer = scoreLayer;
    }
  }

  function toggleHeatMap() {
    state.showHeat = !state.showHeat;
    refreshMapMarkers();
    window.showToast?.(state.showHeat ? 'Heat map enabled' : 'Heat map disabled', 'info');
    updateLayerPanel();
  }

  // ════════════════════════════════════════════════════════════
  // FLOATING LAYER TOGGLE PANEL (April 2026)
  //
  // A small panel that floats over the D2D map. Each toggle
  // controls a visual layer: Knocks, Jobs, Weather, Heatmap.
  // This replaces the separate Maps & Pins view — all map
  // features are now consolidated into D2D. The base-map "view
  // type" switcher (Satellite/Hybrid/Streets/Terrain + Street
  // View) lives at the TOP of this same panel, so there's one
  // collapsible panel rather than a separate bottom-left control.
  //
  // Layers:
  //   Knocks  — the default knock markers (disposition circles)
  //   Jobs    — active CRM leads with $ value labels (green/blue)
  //   Weather — NOAA NEXRAD radar overlay
  //   Heat    — knock density heatmap
  // ════════════════════════════════════════════════════════════
  let d2dLayerState = { knocks: true, customers: false, weather: false, heat: false, territory: false, score: false, storms: false };
  let _layerPanelOpen = false; // panel collapsed by default behind the "Layers" toggle (frees the map)
  let d2dCustomerMarkers = [];
  let d2dStormLayer = null;
  let d2dWeatherLayer = null;
  let d2dDrawControl = null;
  let d2dTerritoryGroup = null;  // L.featureGroup holding drawn polygons

  // ── Base-map switcher (satellite / hybrid / streets / terrain) ──────
  function _makeBasemapLayer(key) {
    const b = BASEMAPS[key] || BASEMAPS.satellite;
    const layer = L.tileLayer(b.url, { subdomains: '0123', attribution: 'Imagery © Google', maxNativeZoom: 22, maxZoom: 23 });
    if (b.fallback) {
      // Per-tile Esri fallback (imagery basemaps only) — same one-retry guard.
      layer.on('tileerror', function (ev) {
        if (!ev.tile || !ev.coords || ev.tile.dataset.nbdFallbackTried === '1') return;
        ev.tile.dataset.nbdFallbackTried = '1';
        const c = ev.coords;
        ev.tile.src = SAT_TILES_FALLBACK.replace('{z}', c.z).replace('{x}', c.x).replace('{y}', c.y);
      });
    }
    if (b.overlay) {
      // Base + overlay travel as one group so setBasemap()'s remove/add and
      // the saved preference treat them as a single choice. Both are tile
      // layers in Leaflet's tilePane, so markers/drawn territories stay above
      // them without bringToBack (which a layerGroup does not have).
      const over = L.tileLayer(b.overlay, {
        maxNativeZoom: b.overlayMaxNativeZoom || 19, maxZoom: 23,
        attribution: b.overlayAttribution || ''
      });
      return L.layerGroup([layer, over]);
    }
    return layer;
  }

  function setBasemap(key) {
    if (!state.d2dMap || !BASEMAPS[key]) return;
    if (state.d2dBaseLayer) { try { state.d2dMap.removeLayer(state.d2dBaseLayer); } catch (_) {} }
    const layer = _makeBasemapLayer(key);
    layer.addTo(state.d2dMap);
    if (layer.bringToBack) layer.bringToBack(); // stay under markers/overlays
    state.d2dBaseLayer = layer;
    state.d2dBasemap = key;
    try { localStorage.setItem(BASEMAP_PREF, key); } catch (_) {}
    updateBasemapControl();
  }

  function openStreetView() {
    const c = state.d2dMap && state.d2dMap.getCenter();
    if (!c) { window.showToast?.('Map not ready', 'info'); return; }
    // Google Maps Street View pano at the current map center.
    window.open('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + c.lat + ',' + c.lng, '_blank');
  }

  // Build the base-map "view type" buttons (Satellite / Hybrid / Streets /
  // Terrain + Street View) into a given container. Folded into the collapsible
  // layer panel (see createLayerPanel) instead of a separate always-on
  // bottom-left control — one panel, more free map space. The buttons keep
  // their d2d-basemap-<key> ids + .active class so updateBasemapControl() still
  // reflects the current choice. CSP-safe (addEventListener, no inline on*=).
  function _buildBasemapButtons(container) {
    if (!container) return;
    BASEMAP_ORDER.forEach(key => {
      const b = BASEMAPS[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'd2d-basemap-' + key;
      btn.className = 'd2d-basemap-btn' + (state.d2dBasemap === key ? ' active' : '');
      btn.title = b.label;
      btn.innerHTML = b.icon + '<span>' + b.label + '</span>';
      btn.addEventListener('click', (e) => { e.stopPropagation(); setBasemap(key); });
      container.appendChild(btn);
    });
    const sv = document.createElement('button');
    sv.type = 'button';
    sv.className = 'd2d-basemap-btn d2d-basemap-sv';
    sv.title = 'Open Street View at the map center';
    sv.innerHTML = '👁️<span>Street</span>';
    sv.addEventListener('click', (e) => { e.stopPropagation(); openStreetView(); });
    container.appendChild(sv);
  }
  function updateBasemapControl() {
    BASEMAP_ORDER.forEach(key => {
      const btn = document.getElementById('d2d-basemap-' + key);
      if (btn) btn.classList.toggle('active', state.d2dBasemap === key);
    });
  }

  // ── "SEARCH THIS AREA" VIEWPORT CONTROL (Zillow/Redfin-style) ─────────
  // A compact reload button parked in the bottom-right corner (just above the
  // Leaflet/Google attribution). Tapping it pulls the knocks for the CURRENT
  // viewport (loadKnocksInViewport) instead of the global 500-most-recent
  // default. It sits there permanently and "arms" (an orange pulse) after the
  // rep pans/zooms, hinting there may be knocks to load in the new view.
  //
  // Verification note (this handler runs on every map move): the `moveend`
  // handler ONLY toggles this button's armed class — it performs NO map mutation
  // (no setView / fitBounds / invalidateSize), so it can never re-trigger its
  // own moveend and cannot oscillate. The class write is idempotent
  // (skipped when already in the target state) so a burst of moveend events
  // can't thrash layout. `_searchAreaArmed` gates the first ~2s so the init
  // setView / invalidateSize settle doesn't flash the hint.
  let _searchAreaArmed = false;
  let _searchAreaBusy = false;

  function createSearchAreaControl() {
    if (!state.d2dMap || document.getElementById('d2d-search-area-wrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'd2d-search-area-wrap';
    // Bottom-right, floated just ABOVE the Leaflet/Google attribution strip so
    // the required map attribution stays visible (ToS) rather than being covered.
    // Always shown (a permanent corner reload button); it arms after a pan/zoom.
    wrap.style.cssText = 'position:absolute;bottom:26px;right:8px;'
      + 'z-index:1000;display:flex;align-items:center;gap:6px;';

    const search = document.createElement('button');
    search.type = 'button';
    search.id = 'd2d-search-area';
    search.title = 'Search this area — load knocks in the current view';
    search.setAttribute('aria-label', 'Search this area');
    search.textContent = '🔄';
    search.style.cssText = 'background:color-mix(in srgb, var(--s) 92%, transparent);'
      + 'color:var(--t);border:1px solid var(--br);width:40px;height:40px;border-radius:20px;'
      + 'cursor:pointer;font-size:18px;font-weight:700;box-shadow:0 3px 14px rgba(0,0,0,.5);'
      + 'display:flex;align-items:center;justify-content:center;line-height:1;'
      + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);-webkit-tap-highlight-color:transparent;';
    // addEventListener (not inline on*=) — CSP-safe, like the layer/basemap controls.
    search.addEventListener('click', (e) => { e.stopPropagation(); runSearchThisArea(); });
    wrap.appendChild(search);

    const mapEl = document.getElementById('d2dMap');
    if (mapEl) { mapEl.style.position = 'relative'; mapEl.appendChild(wrap); }
    // Belt-and-suspenders with the handler's stopPropagation: keep taps on the
    // corner button from falling through to the map's click→quick-knock handler.
    if (window.L && L.DomEvent) { try { L.DomEvent.disableClickPropagation(wrap); } catch (_) {} }

    // Arm the button only after a genuine pan/zoom. See the verification note
    // above: this callback mutates no map state, so there is no feedback loop.
    state.d2dMap.on('moveend', _onMapMoveForSearch);
    setTimeout(() => { _searchAreaArmed = true; }, 2000);
  }

  function _onMapMoveForSearch() {
    // A follow/recenter move is programmatic — don't treat it as the rep
    // panning to new territory, or the pill would flash on every GPS step.
    if (_followProgrammaticMove) { _followProgrammaticMove = false; return; }
    if (!_searchAreaArmed || _searchAreaBusy) return;
    _setSearchAreaVisible(true);
  }

  // Idempotent arm/disarm toggle — the corner reload button is always visible;
  // this only adds/removes the orange "you moved, tap to load here" pulse class,
  // and only when the state actually changes, so a burst of moveend events can't
  // thrash layout. (Name kept for the callers/oscillation-guard slice.)
  function _setSearchAreaVisible(show) {
    const btn = document.getElementById('d2d-search-area');
    if (!btn) return;
    const armed = btn.classList.contains('d2d-search-armed');
    if (show && !armed) btn.classList.add('d2d-search-armed');
    else if (!show && armed) btn.classList.remove('d2d-search-armed');
  }

  async function runSearchThisArea() {
    if (_searchAreaBusy) return;
    const btn = document.getElementById('d2d-search-area');
    _searchAreaBusy = true;
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    let res;
    try {
      res = await loadKnocksInViewport();
    } finally {
      _searchAreaBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = '🔄'; }
    }
    if (res && res.error) {
      window.showToast?.(
        res.indexBuilding
          ? 'Area search is finishing setup — try again in a minute'
          : "Couldn't search this area — try again",
        'error');
      return; // leave the pill up so the rep can retry
    }
    refreshMapMarkers();
    _setSearchAreaVisible(false); // this viewport is now loaded
    if (res && res.matched > 0) {
      const n = res.capped ? (VIEWPORT_KNOCK_LIMIT + '+') : res.matched;
      window.showToast?.(`📍 ${n} knock${res.matched === 1 ? '' : 's'} in this area`, 'success');
    } else {
      // Honest empty state — "searched, none here", distinct from "not loaded yet".
      window.showToast?.('No knocks logged in this area yet', 'info');
    }
  }

  function createLayerPanel() {
    if (!state.d2dMap) return;
    // Don't re-create if it already exists
    if (document.getElementById('d2d-layer-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'd2d-layer-panel';
    // Drops from under the "Layers" toggle (top:100) when opened; hidden by
    // default so it doesn't eat the map. Capped width = tidy right-corner block.
    panel.style.cssText = 'position:absolute;top:100px;right:10px;z-index:1000;'
      + 'background:color-mix(in srgb, var(--s) 92%, transparent);border:1px solid color-mix(in srgb, var(--orange) 30%, transparent);'
      + 'border-radius:10px;padding:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;max-width:min(72vw, 300px);'
      + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);'
      + 'box-shadow:0 4px 20px rgba(0,0,0,.5);';

    // ── "View type" (basemap) — folded in at the top of the panel so there's
    // ONE collapsible panel instead of a separate always-on bottom-left control
    // (frees the bottom-left corner). A full-width labelled row, divided from
    // the layer/tool chips below it.
    const viewGroup = document.createElement('div');
    viewGroup.id = 'd2d-viewtype-group';
    viewGroup.className = 'd2d-viewtype-group';
    const viewLabel = document.createElement('span');
    viewLabel.className = 'd2d-viewtype-label';
    viewLabel.textContent = 'VIEW';
    viewGroup.appendChild(viewLabel);
    _buildBasemapButtons(viewGroup);
    panel.appendChild(viewGroup);

    const layers = [
      { key: 'knocks',    icon: '📍', label: 'Knocks' },
      { key: 'customers', icon: '👥', label: 'Customers' },
      { key: 'weather',   icon: '⛈️', label: 'Radar' },
      { key: 'heat',      icon: '🔥', label: 'Heat' },
      { key: 'score',     icon: '🎯', label: 'Score' },
      { key: 'territory', icon: '🗺️', label: 'Zone' },
      // Storm Watch (2026-10-02): NWS hail / wind / tornado reports, d2d-storm-layer.js.
      { key: 'storms',    icon: '🌩️', label: 'Storms' }
    ];

    layers.forEach(ly => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'd2d-layer-' + ly.key;
      btn.title = ly.label;
      btn.style.cssText = 'background:' + (d2dLayerState[ly.key] ? 'color-mix(in srgb, var(--orange) 20%, transparent)' : 'transparent') + ';'
        + 'border:1px solid ' + (d2dLayerState[ly.key] ? 'var(--orange)' : 'var(--br)') + ';'
        + 'color:' + (d2dLayerState[ly.key] ? 'var(--t)' : 'var(--m)') + ';'
        + 'padding:6px 10px;border-radius:6px;cursor:pointer;'
        + "font-family:'Barlow Condensed',sans-serif;font-size:11px;"
        + 'font-weight:700;letter-spacing:.04em;display:flex;align-items:center;'
        + 'gap:4px;transition:background var(--t-fast),border-color var(--t-fast),color var(--t-fast);-webkit-tap-highlight-color:transparent;'
        + 'min-height:36px;';
      btn.innerHTML = ly.icon + ' ' + ly.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLayer(ly.key);
      });
      panel.appendChild(btn);
    });

    // Diagnostics action (not a layer toggle) — "why is my map empty?". Lives
    // inside the layer panel so it inherits the panel's flex-wrap/overflow (no
    // new floating control to collide). Styled neutral; updateLayerPanel skips
    // it because its id isn't d2d-layer-<key>. CSP-safe (addEventListener).
    const diag = document.createElement('button');
    diag.type = 'button';
    diag.id = 'd2d-map-diag';
    diag.title = 'Check map data — why are pins missing?';
    diag.style.cssText = 'background:transparent;border:1px solid var(--br);color:var(--m);'
      + 'padding:6px 10px;border-radius:6px;cursor:pointer;'
      + "font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:.04em;"
      + 'display:flex;align-items:center;gap:4px;-webkit-tap-highlight-color:transparent;min-height:36px;';
    diag.innerHTML = '🔍 Check';
    diag.addEventListener('click', (e) => { e.stopPropagation(); runMapDiagnostics(); });
    panel.appendChild(diag);

    // Mark-look toggle (detailed dots ⇄ colour pins). A display switch, not a
    // layer — colour still encodes status either way. Same neutral chip style
    // as the diagnostics button; CSP-safe (addEventListener).
    const styleBtn = document.createElement('button');
    styleBtn.type = 'button';
    styleBtn.id = 'd2d-mark-style';
    styleBtn.title = 'Switch marker look: detailed dots ⇄ color pins';
    styleBtn.style.cssText = diag.style.cssText;
    styleBtn.innerHTML = _markStyleBtnLabel();
    styleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMarkStyle(); });
    panel.appendChild(styleBtn);

    // Follow mode toggle — keep the map centered on the rep as they move. Same
    // neutral chip style; CSP-safe (addEventListener). _updateFollowControls()
    // below reflects any restored 'on' state.
    const followBtn = document.createElement('button');
    followBtn.type = 'button';
    followBtn.id = 'd2d-follow';
    followBtn.title = 'Follow mode — keep the map centered on you as you move';
    followBtn.style.cssText = diag.style.cssText;
    followBtn.innerHTML = '🧭 Follow';
    followBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFollow(); });
    panel.appendChild(followBtn);

    // Map-rotation toggle (OPT-IN / BETA) — spins the map to your heading.
    // Lazy-loads the rotation plugin on first use; harmless if you never tap it.
    const rotateBtn = document.createElement('button');
    rotateBtn.type = 'button';
    rotateBtn.id = 'd2d-rotate';
    rotateBtn.title = 'Spin the map to your heading (beta — experimental)';
    rotateBtn.style.cssText = diag.style.cssText;
    rotateBtn.innerHTML = '🔄 Spin';
    rotateBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMapRotate(); });
    panel.appendChild(rotateBtn);

    // Append to the map container (not the map tiles) so it floats above
    const mapEl = document.getElementById('d2dMap');
    if (mapEl) {
      mapEl.style.position = 'relative';
      mapEl.appendChild(panel);

      // Compact toggle — the panel is collapsed by default so 10 chips don't
      // eat the map; tap to open/close. CSP-safe (addEventListener).
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.id = 'd2d-layer-toggle';
      toggle.title = 'Show / hide map view type, layers & tools';
      toggle.style.cssText = 'position:absolute;top:56px;right:10px;z-index:1001;'
        + 'background:color-mix(in srgb, var(--s) 92%, transparent);border:1px solid color-mix(in srgb, var(--orange) 30%, transparent);'
        + 'color:var(--t);padding:7px 12px;border-radius:10px;cursor:pointer;'
        + "font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:800;letter-spacing:.04em;"
        + 'display:flex;align-items:center;gap:6px;min-height:36px;'
        + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 4px 16px rgba(0,0,0,.5);-webkit-tap-highlight-color:transparent;';
      toggle.addEventListener('click', (e) => { e.stopPropagation(); _setLayerPanelOpen(!_layerPanelOpen); });
      mapEl.appendChild(toggle);
    }
    _setLayerPanelOpen(_layerPanelOpen); // apply initial (collapsed) state + toggle label
    _updateFollowControls(); // reflect a restored 'follow on' state on the button
    _updateRotateControls(); // and a restored 'rotate on' state
  }

  // Open/close the layer+tools panel (collapsed by default). Only toggles
  // visibility + the button label — no map mutation.
  function _setLayerPanelOpen(open) {
    _layerPanelOpen = !!open;
    const panel = document.getElementById('d2d-layer-panel');
    const toggle = document.getElementById('d2d-layer-toggle');
    if (panel) panel.style.display = _layerPanelOpen ? 'flex' : 'none';
    if (toggle) {
      toggle.innerHTML = _layerPanelOpen ? '🗂️ Layers ▾' : '🗂️ Layers ▸';
      toggle.style.borderColor = _layerPanelOpen ? 'var(--orange)' : 'color-mix(in srgb, var(--orange) 30%, transparent)';
    }
  }

  function updateLayerPanel() {
    Object.keys(d2dLayerState).forEach(key => {
      const btn = document.getElementById('d2d-layer-' + key);
      if (!btn) return;
      const on = d2dLayerState[key];
      btn.style.background = on ? 'color-mix(in srgb, var(--orange) 20%, transparent)' : 'transparent';
      btn.style.borderColor = on ? 'var(--orange)' : 'var(--br)';
      btn.style.color = on ? 'var(--t)' : 'var(--m)';
    });
  }

  function toggleLayer(key) {
    d2dLayerState[key] = !d2dLayerState[key];
    switch (key) {
      case 'storms':
        if (window.NBDD2DStorms) {
          if (d2dLayerState.storms) window.NBDD2DStorms.show(state.d2dMap);
          else window.NBDD2DStorms.hide(state.d2dMap);
        }
        break;
      case 'knocks':
        if (d2dLayerState.knocks) {
          state.d2dMap.addLayer(state.d2dCluster);
        } else {
          state.d2dMap.removeLayer(state.d2dCluster);
        }
        break;
      case 'customers':
        if (d2dLayerState.customers) {
          buildD2DCustomersLayer();
        } else {
          d2dCustomerMarkers.forEach(m => state.d2dMap.removeLayer(m));
          d2dCustomerMarkers = [];
        }
        // Re-render knocks so the one-mark-per-house suppression turns on/off
        // in step with the Customers layer.
        refreshMapMarkers();
        break;
      case 'weather':
        if (d2dLayerState.weather) {
          showD2DWeatherLayer();
        } else {
          if (d2dStormLayer) state.d2dMap.removeLayer(d2dStormLayer);
          if (d2dWeatherLayer) state.d2dMap.removeLayer(d2dWeatherLayer);
        }
        break;
      case 'heat':
        state.showHeat = d2dLayerState.heat;
        refreshMapMarkers();
        break;
      case 'score':
        // refreshMapMarkers reads d2dLayerState.score and (re)builds or drops
        // the tracked score layer accordingly.
        refreshMapMarkers();
        break;
      case 'territory':
        if (d2dLayerState.territory) {
          showTerritoryDrawing();
        } else {
          hideTerritoryDrawing();
        }
        break;
    }
    updateLayerPanel();
    window.showToast?.((d2dLayerState[key] ? 'Showing ' : 'Hiding ') + key, 'info');
  }

  // ── Customers layer (map-unification phase 2) ──
  // Brings the whole CRM pipeline onto the D2D map as one mark per lead,
  // coloured by pipeline STAGE (via the live engine — window.STAGE_META /
  // stageRole / normalizeStage, same source the kanban + old map used) and
  // drawn in the CURRENT look (detailed dots ⇄ colour pins) so knocks and
  // customers share one visual language. Broadened from the old jobs-only
  // ($-label) layer: every non-deleted lead with a location now shows.
  //
  // Uses lead lat/lng if present, else Nominatim geocoding (cache-first,
  // rate-limited ≥1 req/s, capped per build) — same fair-use discipline as
  // the old jobs layer.
  const D2D_GEOCODE_CACHE = new Map(); // addr → { lat, lng } | null
  const D2D_GEOCODE_PER_BUILD_CAP = 15;

  // Normalized addresses of leads that CAN be placed (have coords) — the set
  // used by refreshMapMarkers to suppress a duplicate knock mark for a house
  // that's already shown as a customer. Coords-required so a house never
  // disappears when its lead is address-only.
  function _leadAddrSetWithCoords() {
    const set = new Set();
    (window._leads || []).forEach(l => {
      if (!l || l.deleted) return;
      if (!(Number(l.lat) && Number(l.lng))) return;
      const norm = normalizeAddress(l.address || '');
      if (norm) set.add(norm);
    });
    return set;
  }

  // Pipeline-stage colour for a lead, from the live stage engine (falls back
  // to the role palette, then a neutral blue) — mirrors maps-overlays' pin
  // colouring so customers look identical wherever they render.
  function _leadStageColor(lead) {
    const stage = (lead && (lead._stageKey || lead.stage)) || '';
    const key = (typeof window.normalizeStage === 'function') ? window.normalizeStage(stage) : stage;
    const meta = (window.STAGE_META && window.STAGE_META[key]) || null;
    if (meta && meta.color) return meta.color;
    if (typeof window.stageRole === 'function') {
      const roleColors = { new: '#9CA3AF', active: '#4A9EFF', job: '#0D9488', won: '#22C55E', lost: '#E05252' };
      return roleColors[window.stageRole(key)] || '#4A9EFF';
    }
    return '#4A9EFF';
  }

  // 2-char code for the detailed-dot look — initials of the customer's name,
  // else a short stage code, so a lead dot is legible next to a knock dot.
  function _leadShortCode(lead) {
    const nm = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
    if (nm) return nm.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const st = String((lead._stageKey || lead.stage) || '').replace(/[^a-z]/gi, '');
    return (st.slice(0, 2) || '★').toUpperCase();
  }

  async function buildD2DCustomersLayer() {
    if (!state.d2dMap) return;
    d2dCustomerMarkers.forEach(m => state.d2dMap.removeLayer(m));
    d2dCustomerMarkers = [];

    // Whole pipeline, minus soft-deleted leads. (Dedupe against knocks so a
    // knocked-and-converted house shows ONE mark is phase 3.)
    const leads = (window._leads || []).filter(l => l && !l.deleted);

    let liveRequests = 0;
    let skippedDueToCap = 0;
    for (const lead of leads) {
      let lat = Number(lead.lat);
      let lng = Number(lead.lng);
      if (!lat || !lng) {
        const addr = (lead.address || '').trim();
        if (!addr) continue;
        const cacheKey = addr.toLowerCase();
        if (D2D_GEOCODE_CACHE.has(cacheKey)) {
          const hit = D2D_GEOCODE_CACHE.get(cacheKey);
          if (!hit) continue;
          lat = hit.lat; lng = hit.lng;
        } else {
          if (liveRequests >= D2D_GEOCODE_PER_BUILD_CAP) { skippedDueToCap++; continue; }
          try {
            const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(addr) + '&limit=1',
              { headers: { 'Accept': 'application/json' } });
            const data = await res.json();
            if (data && data[0]) {
              lat = parseFloat(data[0].lat); lng = parseFloat(data[0].lon);
              D2D_GEOCODE_CACHE.set(cacheKey, { lat, lng });
              // Persist so this lead is geocoded ONCE EVER (rolling backfill,
              // same as the old Customers map). Passive: _saveLeadCoords writes
              // lat/lng without bumping updatedAt, and updates window._leads in
              // memory so later renders this session skip the lookup too.
              if (typeof window._saveLeadCoords === 'function' && lead.id && !String(lead.id).startsWith('d-')) {
                try { window._saveLeadCoords(lead.id, lat, lng); } catch (_) {}
              }
            } else {
              D2D_GEOCODE_CACHE.set(cacheKey, null);
            }
            liveRequests++;
            await new Promise(r => setTimeout(r, 1100)); // Nominatim fair-use ≥ 1 req/s
          } catch (e) { continue; }
        }
      }
      if (!lat || !lng) continue;

      const color = _leadStageColor(lead);
      // Same look as knocks: colour = status (stage), shape = the toggle.
      const icon = _d2dMarkerIcon({ color: color, short: _leadShortCode(lead) });
      const val = parseFloat(lead.jobValue || lead.contractValue || lead.value || 0);
      const name = esc([lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.address || 'Lead');
      const safeColor = esc(color);

      const popup = document.createElement('div');
      popup.style.cssText = 'font-family:sans-serif;min-width:170px;';
      popup.innerHTML = '<b style="font-size:13px;color:' + safeColor + ';">' + name + '</b>'
        + '<p style="font-size:11px;color:var(--m,#888);margin:4px 0;">' + esc(lead.address || '') + '</p>'
        + '<p style="font-size:11px;margin:2px 0;"><b>Stage:</b> ' + esc(lead.stage || '—') + '</p>'
        + (val > 0 ? '<p style="font-size:12px;font-weight:700;color:' + safeColor + ';">$' + val.toLocaleString() + '</p>' : '');
      // CSP-safe "View lead" — navigate to CRM + open the card, both guarded.
      if (lead.id) {
        const view = document.createElement('button');
        view.textContent = 'View lead →';
        view.style.cssText = 'margin-top:6px;padding:4px 8px;background:var(--blue,#4A9EFF);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
        view.addEventListener('click', function (ev) {
          ev.stopPropagation();
          try { window.goTo?.('crm'); } catch (_) {}
          setTimeout(() => { try { window.openCardDetailModal?.(lead.id); } catch (_) {} }, 300);
        });
        popup.appendChild(view);
      }

      const marker = L.marker([lat, lng], { icon }).bindPopup(popup);
      d2dCustomerMarkers.push(marker);
      marker.addTo(state.d2dMap);
    }

    if (d2dCustomerMarkers.length === 0) {
      window.showToast?.('No customers with a map location yet', 'info');
    } else if (skippedDueToCap > 0) {
      window.showToast?.(`${skippedDueToCap} customer${skippedDueToCap > 1 ? 's' : ''} skipped — address lookup limit reached. Toggle the layer again to load more.`, 'info', 5000);
    }
  }

  // ── Weather layer (ported from maps.js) ──
  // NOAA NEXRAD radar composite + RainViewer precipitation
  function showD2DWeatherLayer() {
    if (!state.d2dMap) return;
    if (!d2dStormLayer) {
      d2dStormLayer = L.tileLayer(
        'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
        { opacity: 0.6, attribution: 'NOAA/IEM', maxZoom: 20, tms: false }
      );
    }
    d2dStormLayer.addTo(state.d2dMap);
    // RainViewer layer
    if (!d2dWeatherLayer) {
      const now = Math.floor(Date.now() / 600000) * 600;
      d2dWeatherLayer = L.tileLayer(
        'https://tilecache.rainviewer.com/v2/radar/' + now + '/256/{z}/{x}/{y}/2/1_1.png',
        { opacity: 0.45, attribution: 'RainViewer', maxZoom: 20 }
      );
    }
    d2dWeatherLayer.addTo(state.d2dMap);
    window.showToast?.('Storm radar + precipitation loaded', 'info');
  }

  // ── Territory drawing (Leaflet.Draw) ──
  // Lets the user draw polygons on the map to define "zones" (territories).
  // Saved polygons persist to the Firestore 'territories' collection via
  // the existing saveTerritory() function that was already in the codebase.
  // Drawn polygons are orange-outlined so they're visually distinct from
  // knock markers and job overlays.
  function showTerritoryDrawing() {
    if (!state.d2dMap) return;
    if (typeof L.Draw === 'undefined') {
      window.showToast?.('Drawing library not loaded — refresh and try again', 'error');
      return;
    }

    // Create the feature group that holds drawn shapes
    if (!d2dTerritoryGroup) {
      d2dTerritoryGroup = new L.FeatureGroup();
      state.d2dMap.addLayer(d2dTerritoryGroup);
    }

    // Load existing territories from Firestore and render them
    renderSavedTerritories();

    // Add the Leaflet.Draw control if not already present
    if (!d2dDrawControl) {
      d2dDrawControl = new L.Control.Draw({
        position: 'topright',
        draw: {
          polygon: {
            allowIntersection: false,
            shapeOptions: {
              color: '#BD5728',
              weight: 3,
              fillColor: '#BD5728',
              fillOpacity: 0.08
            }
          },
          rectangle: {
            shapeOptions: {
              color: '#BD5728',
              weight: 3,
              fillColor: '#BD5728',
              fillOpacity: 0.08
            }
          },
          // Disable non-polygon shapes — territories are areas
          polyline: false,
          circle: false,
          circlemarker: false,
          marker: false
        },
        edit: {
          featureGroup: d2dTerritoryGroup,
          remove: true
        }
      });
      state.d2dMap.addControl(d2dDrawControl);

      // Listen for new shapes drawn
      state.d2dMap.on(L.Draw.Event.CREATED, async function (e) {
        const layer = e.layer;
        d2dTerritoryGroup.addLayer(layer);

        // Prompt for a name (iOS-safe modal — native prompt() is blocked in iOS PWA)
        const name = await uiPrompt('Name this territory zone:', 'Zone ' + (state.territories.length + 1), { okLabel: 'Next' });
        if (!name) {
          d2dTerritoryGroup.removeLayer(layer);
          return;
        }
        // Optional rep assignment (blank = unassigned). Cancel keeps it unassigned.
        const assignedRep = await uiPrompt('Assign to a rep (optional):', '', { okLabel: 'Save Zone', cancelLabel: 'Skip' });
        const assignedRepName = (assignedRep || '').trim().substring(0, 60) || null;

        // Extract GeoJSON coordinates for Firestore storage
        const geoJSON = layer.toGeoJSON();
        const newId = await saveTerritory({
          name: name.trim().substring(0, 80),
          assignedRep: assignedRepName,
          type: e.layerType,
          geoJSON: geoJSON,
          bounds: layer.getBounds ? {
            north: layer.getBounds().getNorth(),
            south: layer.getBounds().getSouth(),
            east: layer.getBounds().getEast(),
            west: layer.getBounds().getWest()
          } : null
        });
        // Audit #19: tag the layer with its Firestore doc id so the DELETED
        // handler can actually remove it from the backend — previously the
        // save returned no id and deletions only cleared the map client-side.
        if (newId) layer._nbdTerritoryId = newId;
        window.showToast?.('✓ Territory "' + name + '" saved' + (assignedRepName ? ' → ' + assignedRepName : ''), 'success');

        // Add label to the polygon
        addTerritoryLabel(layer, name, assignedRepName);
      });

      // Listen for deleted shapes
      state.d2dMap.on(L.Draw.Event.DELETED, async function (e) {
        // Audit #19: actually delete from Firestore now that each layer has a
        // _nbdTerritoryId tag (assigned on create and on render of saved docs).
        const ids = [];
        try {
          e.layers.eachLayer(function (l) { if (l && l._nbdTerritoryId) ids.push(l._nbdTerritoryId); });
        } catch (_) {}
        if (ids.length === 0) {
          window.showToast?.('Territory removed from map (no saved copy to delete)', 'info');
          return;
        }
        const results = await Promise.all(ids.map(id => deleteTerritory(id)));
        const ok = results.filter(Boolean).length;
        if (ok === ids.length) window.showToast?.(`✓ ${ok} territory zone${ok > 1 ? 's' : ''} deleted`, 'success');
        else window.showToast?.(`Deleted ${ok}/${ids.length} — some zones may still exist on the server`, 'warning');
      });
    }

    window.showToast?.('Draw a polygon to define your territory zone', 'info');
  }

  function hideTerritoryDrawing() {
    if (d2dDrawControl && state.d2dMap) {
      state.d2dMap.removeControl(d2dDrawControl);
      d2dDrawControl = null;
    }
    if (d2dTerritoryGroup && state.d2dMap) {
      state.d2dMap.removeLayer(d2dTerritoryGroup);
      d2dTerritoryGroup = null;
    }
  }

  // Render previously saved territories from Firestore
  async function renderSavedTerritories() {
    if (!state.d2dMap || !d2dTerritoryGroup) return;
    // Load if not already loaded
    if (state.territories.length === 0) await loadTerritories();

    state.territories.forEach(t => {
      if (!t.geoJSON) return;
      try {
        const layer = L.geoJSON(t.geoJSON, {
          style: {
            color: '#BD5728',
            weight: 2,
            fillColor: '#BD5728',
            fillOpacity: 0.06,
            dashArray: '6,4'
          }
        });
        layer.addTo(d2dTerritoryGroup);
        // Audit #19: tag every sub-layer with the Firestore doc id so delete
        // events know which docs to remove server-side.
        layer.eachLayer(function (l) { l._nbdTerritoryId = t.id; });
        // Add a label tooltip with the territory name
        layer.eachLayer(function (l) {
          if (l.getBounds) {
            addTerritoryLabel(l, t.name || 'Zone', t.assignedRep || null);
          }
        });
      } catch (e) {
        console.warn('Failed to render territory:', t.name, e.message);
      }
    });
  }

  // Add a text label at the center of a territory polygon
  function addTerritoryLabel(layer, name, assignedRep) {
    if (!layer.getBounds) return;
    const center = layer.getBounds().getCenter();
    const assignHtml = assignedRep
      ? '<span style="display:block;font-size:9px;font-weight:600;opacity:.9;text-transform:none;letter-spacing:0;margin-top:1px;">👤 ' + esc(assignedRep) + '</span>'
      : '';
    const label = L.divIcon({
      html: '<div style="background:color-mix(in srgb, var(--orange) 85%, transparent);color:#fff;font-family:\'Barlow Condensed\',sans-serif;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;letter-spacing:.04em;text-transform:uppercase;text-align:center;">' + esc(name) + assignHtml + '</div>',
      className: '',
      iconAnchor: [0, 0]
    });
    L.marker(center, { icon: label, interactive: false }).addTo(d2dTerritoryGroup);
  }

  // ============================================================================
  // PHOTO + VOICE UPLOAD HELPERS (Firebase Storage)
  // ----------------------------------------------------------------------------
  // These are pure-upload helpers (no DOM). The capture/record UI lives in the
  // UI module and calls back into these helpers from handleSubmitKnock.
  // ============================================================================

  // Derive a Firebase-Storage-rule-acceptable contentType from a File.
  // Safari iPhone leaves File.type as the empty string for HEIC/HEIF
  // pulled from the photo library in some configurations — uploadBytes
  // with no contentType then either lets Storage guess (which it does
  // poorly) or sends `application/octet-stream`, both of which the
  // storage.rules:29 isImage() regex rejects with an opaque 403.
  // Map by lowercase extension to one of the rule's accepted MIMEs.
  // Returns null when the extension isn't an allowed image type, so
  // the caller can surface a clear "unsupported format" error rather
  // than letting the upload fail silently with 403.
  function inferImageContentType(file) {
    const declared = (file && file.type || '').toLowerCase().trim();
    // image/* declared types are accepted as-is provided they're in
    // the rules' allowlist. Lowercase normalize handles browsers that
    // ship "Image/JPEG" or similar.
    if (/^image\/(jpeg|jpg|png|webp|heic|heif|avif|gif)$/.test(declared)) {
      // Storage rules allowlist uses 'jpeg' canonical; 'jpg' is the
      // same byte stream so coerce the alias.
      return declared === 'image/jpg' ? 'image/jpeg' : declared;
    }
    const name = String(file && file.name || '').toLowerCase();
    const ext = name.split('.').pop() || '';
    const map = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
      avif: 'image/avif', gif: 'image/gif'
    };
    return map[ext] || null;
  }

  async function uploadPhotos(files, knockId) {
    // RETURN SHAPE: an ARRAY of download URLs carrying a non-index `paths`
    // property (index-aligned storage paths). NOT a {urls, paths} object —
    // the service worker can pair a stale cached UI bundle with this fresh
    // core, and the pre-2026-08-17 UI assigns the return value straight to
    // knock.photoUrls. An array keeps that pairing harmless (Firestore
    // serializes arrays by their indexed elements, so the extra property is
    // silently dropped and the knock just misses variants); an object would
    // have persisted a map into a field six consumers read as an array.
    const urls = [];
    if (!files || !files.length) { urls.paths = []; return urls; }
    // Storage object paths, index-aligned with `urls`. Persisted on the
    // knock doc as `photoPaths` so the image pipeline
    // (functions/image-pipeline.js) can find the knock by
    // array-contains lookup and stamp `photoVariants[idx]` — knock
    // photos have no /photos doc, so the path is the only join key.
    // (The {knockId} path segment is the client tempId, NOT the
    // Firestore doc id, so the pipeline cannot derive the doc from the
    // path alone.)
    const paths = [];
    // Storage rules only permit photos under `photos/{uid}/...`.
    // Route door-knock photos through `photos/{uid}/d2d/{knockId}/...`
    // so they inherit the existing photos rule instead of hitting
    // the default-deny that d2d_photos/{uid}/... falls under.
    const { ref, getDownloadURL } = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js');
    const uid = window._user && window._user.uid;
    if (!uid) {
      console.error('d2d photo upload: not signed in');
      urls.paths = [];
      return urls;
    }
    let rejected = 0;
    for (const file of files) {
      try {
        const contentType = inferImageContentType(file);
        if (!contentType) {
          // Unsupported format — surface to the user rather than
          // letting Storage reject with an opaque 403.
          console.warn('d2d photo upload: unsupported file', file && file.name, file && file.type);
          rejected++;
          continue;
        }
        const safeName = String(file.name || 'knock').replace(/[^A-Za-z0-9._-]+/g, '_').substring(0, 120);
        const storagePath = `photos/${uid}/d2d/${knockId}/${Date.now()}_${safeName}`;
        const storageRef = ref(window._storage, storagePath);
        // Pass contentType explicitly so Storage doesn't infer
        // application/octet-stream for HEIC files where Safari left
        // file.type empty.
        // 20s upload timeout — Storage uploads on a stale iOS bfcache
        // connection hang the same way Firestore writes do. Per-photo
        // timeout so one bad photo doesn't block the rest of the batch.
        await _withTimeout(window.uploadBytes(storageRef, file, { contentType }), 20000, 'uploadBytes(photo)');
        const url = await _withTimeout(getDownloadURL(storageRef), 10000, 'getDownloadURL(photo)');
        urls.push(url);
        paths.push(storagePath);
      } catch(e) {
        console.error('Photo upload failed:', e && e.code, e && e.message, file && file.name, file && file.type);
        rejected++;
      }
    }
    if (rejected > 0 && window.showToast) {
      const ok = files.length - rejected;
      if (ok === 0) {
        window.showToast('Photo upload failed — unsupported format or network error', 'error');
      } else {
        window.showToast(`${rejected} of ${files.length} photo${files.length > 1 ? 's' : ''} failed to upload`, 'warning');
      }
    }
    urls.paths = paths;
    return urls;
  }

  async function uploadVoiceMemo(blob, knockId) {
    if (!blob) return '';
    try {
      const { ref, getDownloadURL } = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js');
      // Path must live under `audio/{uid}/...` — storage.rules:146 is the
      // only allowlisted path for audio uploads, everything else hits the
      // default-deny at storage.rules:155. Keep the `d2d/` prefix for
      // lineage and so onAudioUploaded can tell D2D memos apart from
      // Voice Intelligence recordings.
      const storageRef = ref(window._storage, `audio/${window._user.uid}/d2d/${knockId}_${Date.now()}.webm`);
      // Same iOS bfcache timeout treatment as photo uploads — voice
      // memos are typically larger so allow a longer ceiling (30s).
      await _withTimeout(window.uploadBytes(storageRef, blob), 30000, 'uploadBytes(voice)');
      return await _withTimeout(getDownloadURL(storageRef), 10000, 'getDownloadURL(voice)');
    } catch(e) {
      console.error('Voice upload failed:', e);
      window.showToast?.('Voice memo upload failed — will retry when you reopen this knock', 'error');
      return '';
    }
  }

  // ============================================================================
  // SMS / EMAIL TEMPLATES (data layer — chooser UI lives in ui module)
  // ============================================================================
  function sendFollowUpSMS(knock, templateKey) {
    const phone = knock.phone;
    if (!phone) { window.showToast?.('No phone number for this contact', 'error'); return; }
    const repName = state.currentRep?.name || window._user?.displayName || 'your local roofer';
    const tmpl = SMS_TEMPLATES[templateKey] || SMS_TEMPLATES[knock.disposition] || SMS_TEMPLATES.follow_up;
    const body = _fillTemplate(tmpl.body, {
      name: knock.homeowner || 'there',
      rep: repName,
      address: knock.address || '',
      follow_up_date: knock.followUpDate ? formatDate(knock.followUpDate) : 'soon',
    });

    // Try NBDComms first. NBDComms owns the WHOLE outcome on this path:
    //   success:true  + mode:'platform' → Twilio sent it.
    //   success:true  + mode:'sms'      → NBDComms already opened Messages
    //                                     itself (paid-gate / A2P / 429).
    //   success:true  + mode:'queued'   → offline: stored in the SMS outbox,
    //                                     NOT sent; NBDComms already said so.
    //   success:false                   → NBDComms REFUSED (403 opt-out/forbidden,
    //                                     401) and already toasted why.
    // Never open sms: here. This used to reopen Messages with the body
    // prefilled on every success:false, i.e. only on the refusals, so a
    // homeowner who replied STOP was one tap from getting the text anyway
    // (the exact handoff nbd-comms.js declines: "would still text").
    if (window.NBDComms && typeof window.NBDComms.sendSMS === 'function') {
      // No sourceRef: nothing stamps a knock when a queued follow-up goes
      // out, and a sourceRef would leave an outbox receipt nobody applies.
      window.NBDComms.sendSMS(phone, body, knock.id, { source: 'd2d-followup-sms' }).then(result => {
        if (result && result.success && result.mode === 'platform') {
          const nameDisplay = knock.homeowner || 'contact';
          window.showToast?.(`Text sent to ${nameDisplay}`, 'ok');
        }
      }).catch(e => {
        // Fail closed: opt-out status is unknown, so no Messages handoff.
        console.warn('[D2D] sendFollowUpSMS failed', e);
        window.showToast?.('Could not send text', 'error');
      });
    } else {
      // Fallback: sms: link
      const cleanPhone = phone.replace(/[^0-9+]/g, '');
      window.open(`sms:${cleanPhone}?body=${encodeURIComponent(body)}`, '_blank');
      window.showToast?.('Opening SMS...', 'info');
    }
  }

  function sendFollowUpEmail(knock, templateKey) {
    if (!knock.email) { window.showToast?.('No email for this contact', 'error'); return; }
    // repName fell back to 'NBD Home Solutions' — so a tenant rep with no
    // display name introduced himself as the platform owner's company.
    const _co = _d2dCompany();
    const repName = state.currentRep?.name || window._user?.displayName || _co;
    const tmpl = SMS_TEMPLATES[templateKey] || SMS_TEMPLATES[knock.disposition] || SMS_TEMPLATES.follow_up;
    const body = _fillTemplate(tmpl.body, {
      company: _co,
      name: knock.homeowner || 'there',
      rep: repName,
      address: knock.address || '',
    });
    // Subject was hardcoded "NBD Home Solutions — <label>" unconditionally.
    window.open(`mailto:${knock.email}?subject=${encodeURIComponent(_co + ' — ' + tmpl.label)}&body=${encodeURIComponent(body)}`, '_blank');
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  async function initD2D() {
    if (state.d2dInited) {
      if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
      if (state.d2dMap) setTimeout(() => state.d2dMap.invalidateSize(), 100);
      return;
    }
    // Prevent concurrent inits (e.g. rapid D2D tab clicks)
    if (state.d2dInitializing) return;
    state.d2dInitializing = true;

    // No standalone auth gate here. NBDAuth gates dashboard access on
    // load (dashboard.html runs NBDAuth.init with requiredPlan); if a
    // user is on this page and tapping the D2D nav button, they've
    // already passed that gate. The previous double-gate did its own
    // window._user / _auth.currentUser / authStateReady check and
    // redirected to /pro/login?from=d2d on failure — which on iOS
    // Safari was firing for SIGNED-IN users because ITP delays the
    // IndexedDB session restore past whatever timeout we used. Net
    // effect: a working app on Brave / desktop, but a permanent
    // login bounce on iPhone Safari for the same account.
    //
    // The Firestore reads inside this init still require window._user.uid
    // and are wrapped in try/catch + a 6s Promise.race below, so an
    // edge case where the user really isn't signed in degrades to an
    // empty D2D shell rather than data exposure. Best-effort hydrate
    // window._user from _auth.currentUser if missing so loadKnocks /
    // loadRepProfile have what they need.
    if (!window._user && window._auth && window._auth.currentUser) {
      window._user = window._auth.currentUser;
    }
    // Auth restore can lag the first D2D tap (cold PWA start, iOS ITP
    // IndexedDB delay) — loadRepProfile/loadKnocks dereference
    // window._user.uid and crashed with a TypeError when the tap won the
    // race, leaving an error toast + empty tracker. Wait up to 5s for the
    // bootstrap to publish the user before reading Firestore.
    if (!window._user) {
      for (let i = 0; i < 50 && !window._user; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (!window._user && window._auth && window._auth.currentUser) {
          window._user = window._auth.currentUser;
        }
      }
    }

    try {
      loadOfflineQueue();
      // Wrap Firestore reads in a combined 6-second timeout so that
      // renderD2D() is always reached — even on iOS Safari with poor
      // or no connectivity where getDoc/getDocs can hang indefinitely.
      // On timeout we proceed with whatever partial data loaded (empty
      // knocks array is fine; the UI shell renders and the user can
      // refresh manually).
      await Promise.race([
        (async () => { await loadRepProfile(); await loadKnocks(); })(),
        new Promise(resolve => setTimeout(resolve, 6000))
      ]);
      if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D();
      setTimeout(() => initD2DMap(), 200);
      state.d2dInited = true;
      state.d2dInitializing = false;

      // Async background tasks
      if (state.isOnline) {
        flushOfflineQueue();
        loadWeather();
      }
    } catch (e) {
      state.d2dInitializing = false;
      console.error('initD2D failed:', e);
      window.showToast?.('Failed to initialize D2D', 'error');
      // Always render the shell so the spinner clears — a hung
      // spinner on a thrown init is the worst UX failure mode.
      try { if (window.D2D && typeof window.D2D.renderD2D === 'function') window.D2D.renderD2D(); } catch (_) {}
    }
  }

  // ============================================================================
  // EXPORT TO STATE OBJECT (so UI module + shim can call into core)
  // ============================================================================
  state.uiConfirm = uiConfirm;
  state.uiPrompt = uiPrompt;
  state.escapeHtml = escapeHtml;
  state.esc = esc;
  state.toDate = toDate;
  state.timeAgo = timeAgo;
  state.formatTime = formatTime;
  state.formatDate = formatDate;
  state.normalizeAddress = normalizeAddress;
  state.getAttemptCount = getAttemptCount;
  state.getAddressHistory = getAddressHistory;
  state.parseStreetName = parseStreetName;
  state.parseHouseNumber = parseHouseNumber;
  state.loadOfflineQueue = loadOfflineQueue;
  state.flushOfflineQueue = flushOfflineQueue;
  state.reverseGeocode = reverseGeocode;
  state.searchAddresses = searchAddresses;
  state.setupAddressAutocomplete = setupAddressAutocomplete;
  // Address-accuracy resolver
  state.resolveDoorAt = resolveDoorAt;
  state.verifyAddressString = verifyAddressString;
  state.extractHouseNumber = extractHouseNumber;
  state.haversineMeters = haversineMeters;
  state.clearTapParcel = clearTapParcel;
  state.getAddressQuality = getAddressQuality;
  state.reverifyKnock = reverifyKnock;
  state.reverifyPending = reverifyPending;
  state.reverifyTeam = reverifyTeam;
  state.runCoach = runCoach;
  state.loadPropertyIntel = loadPropertyIntel;
  state.orderRoofReport = orderRoofReport;
  state.loadWeather = loadWeather;
  state.getWeatherAlerts = getWeatherAlerts;
  state.calculateWalkingRoute = calculateWalkingRoute;
  state.openRouteInMaps = openRouteInMaps;
  state.setBasemap = setBasemap;
  state.openStreetView = openStreetView;
  state.drawWalkingRoute = drawWalkingRoute;
  state.clearWalkingRoute = clearWalkingRoute;
  state.loadRepProfile = loadRepProfile;
  state.loadKnocks = loadKnocks;
  state.loadKnocksInViewport = loadKnocksInViewport;
  state.refreshKnocks = refreshKnocks;
  state.runSearchThisArea = runSearchThisArea;
  state.runMapDiagnostics = runMapDiagnostics;
  state.toggleMarkStyle = toggleMarkStyle;
  state.toggleFollow = toggleFollow;
  state.toggleMapRotate = toggleMapRotate;
  state.toggleLayerPanel = () => _setLayerPanelOpen(!_layerPanelOpen);
  state.d2dSearchAddress = d2dSearchAddress;
  state.submitKnock = submitKnock;
  state.updateKnock = updateKnock;
  state.deleteKnock = deleteKnock;
  state.convertToLead = convertToLead;
  state.convertToLeadWithEdit = convertToLeadWithEdit;
  state.loadTeamKnocks = loadTeamKnocks;
  state.subscribeTeamActivity = subscribeTeamActivity;
  state.unsubscribeTeamActivity = unsubscribeTeamActivity;
  state.getTeamActivity = getTeamActivity;
  state.loadTerritories = loadTerritories;
  state.saveTerritory = saveTerritory;
  state.createStormTerritory = createStormTerritory;
  state.deleteTerritory = deleteTerritory;
  state.updateNavBadge = updateNavBadge;
  state.applyFilters = applyFilters;
  state.getMetrics = getMetrics;
  state.getRevenueMetrics = getRevenueMetrics;
  state.getDispositionBreakdown = getDispositionBreakdown;
  state.getTimeOfDayStats = getTimeOfDayStats;
  state.getInsuranceMetrics = getInsuranceMetrics;
  state.getGamificationData = getGamificationData;
  state.initD2DMap = initD2DMap;
  state.centerOnMe = centerOnMe;
  state.refreshMapMarkers = refreshMapMarkers;
  state.toggleHeatMap = toggleHeatMap;
  state.uploadPhotos = uploadPhotos;
  state.uploadVoiceMemo = uploadVoiceMemo;
  state.sendFollowUpSMS = sendFollowUpSMS;
  state.sendFollowUpEmail = sendFollowUpEmail;
  state.initD2D = initD2D;
  // Storm Watch deep link (d2d-storm-layer.js) turns the Storms layer on.
  state.toggleLayer = (k) => { toggleLayer(k); updateLayerPanel(); };
  state.isLayerOn = (k) => !!d2dLayerState[k];

})();
