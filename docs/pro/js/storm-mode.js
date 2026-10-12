/**
 * storm-mode.js — Storm Mode: OPT-IN storm response (CRM style roadmap C2,
 * design idea #05).
 *
 * Jo's decision (2026-10-11): it is a Settings toggle, OFF by default, and it
 * never changes the screen unless the user turned it on.
 *
 * When it is on and an NWS WARNING for hail / damaging wind (Severe
 * Thunderstorm, Tornado, High Wind, Extreme Wind) overlaps the customers'
 * addresses:
 *   1. stash the current theme and switch to Storm Season (through
 *      NBDAutoTheme when loaded, so Auto theme is held, not fighting it),
 *   2. add body.storm-alert (accent #FACC15, css/storm-mode.css),
 *   3. show a banner that links to Storm Watch, with "Keep my theme",
 *   4. when the warning has passed (all-clear), restore the theme and ask the
 *      server (callable fileStormDrafts) for ONE check-in DRAFT per customer
 *      who was inside the warned area.
 * Nothing is ever sent from here. Drafts land in the Agent inbox; the owner
 * sends from their own phone and the server's 'sent' step re-checks STOP /
 * Do Not Text / consent / the texting switch / texting hours (8am-9pm in the
 * homeowner's time). See functions/agent-mcp.js stormDrafts.
 *
 * Reuses the storm plumbing's contract (api.weather.gov alerts + points with
 * the same User-Agent, roofing event list, Storm Watch view via goTo('storm'))
 * but not StormCenter.fetchAlerts: that one paints the Storm Center view as a
 * side effect, which a background poll must not do.
 *
 * Privacy: customer coordinates stay in the browser. The only coordinates
 * sent to weather.gov are the centres of up to 4 quarter-degree grid cells
 * (about 17 miles), never an address. No customer data is logged.
 *
 * Pure logic (parse / point-in-polygon / state machine) is exported for
 * tests/storm-mode.test.js; browser glue is skipped without a document.
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // PURE CORE
  // ──────────────────────────────────────────────────────────────────
  var QUALIFYING = {
    'Severe Thunderstorm Warning': 1, 'Tornado Warning': 1,
    'High Wind Warning': 1, 'Extreme Wind Warning': 1
  };
  var CELL = 0.25;          // degrees, ~17 miles
  var MAX_ANCHORS = 4;
  var CLEAR_POLLS = 2;      // consecutive empty, SUCCESSFUL polls = all-clear
  var DRAFT_WINDOW_MS = 24 * 3600 * 1000;
  var MAX_DRAFT_LEADS = 40; // server cap per call

  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }

  // Ray casting. ring: [[lat,lng], ...]
  function pointInRing(lat, lng, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // GeoJSON geometry -> array of rings in [lat,lng] (outer rings only; holes
  // do not occur in NWS warning polygons).
  function ringsOf(geometry) {
    if (!geometry || !geometry.coordinates) return [];
    var polys = geometry.type === 'Polygon' ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    var out = [];
    polys.forEach(function (p) {
      if (!p || !p[0]) return;
      out.push(p[0].map(function (c) { return [c[1], c[0]]; }));
    });
    return out;
  }

  function hazardOf(props) {
    var p = props || {};
    var par = p.parameters || {};
    var hail = par.maxHailSize && par.maxHailSize[0] != null ? Number(par.maxHailSize[0]) : 0;
    if (hail > 0) return 'hail';
    if (/hail/i.test(String(p.description || '') + ' ' + String(p.headline || ''))) return 'hail';
    return 'wind';
  }

  // NWS alerts collection -> qualifying, still-active alerts.
  function parseAlerts(json, nowMs) {
    var feats = (json && json.features) || [];
    var out = [];
    feats.forEach(function (f) {
      var p = f && f.properties;
      if (!p || !QUALIFYING[p.event]) return;
      if (p.status && p.status !== 'Actual') return;
      if (p.messageType && p.messageType === 'Cancel') return;
      var exp = Date.parse(p.expires || p.ends || '');
      if (isFinite(exp) && exp <= nowMs) return;
      out.push({
        id: String(p.id || f.id || ''),
        event: p.event,
        hazard: hazardOf(p),
        rings: ringsOf(f.geometry),
        ugc: ((p.geocode && p.geocode.UGC) || []).map(String)
      });
    });
    return out.filter(function (a) { return a.id; });
  }

  // Which customers sit inside the warned polygon(s)?
  function customersInside(alert, leads) {
    var ids = [];
    if (!alert.rings.length) return ids;
    (leads || []).forEach(function (l) {
      if (!l || !l.id || l.deleted === true || l.e2eTestData) return;
      var la = num(l.lat), ln = num(l.lng);
      if (la === null || ln === null || (la === 0 && ln === 0)) return;
      for (var i = 0; i < alert.rings.length; i++) {
        if (pointInRing(la, ln, alert.rings[i])) { ids.push(String(l.id)); return; }
      }
    });
    return ids;
  }

  // Densest quarter-degree grid cells of the customer base (centres).
  function serviceAnchors(leads) {
    var cells = {};
    (leads || []).forEach(function (l) {
      if (!l || l.deleted === true || l.e2eTestData) return;
      var la = num(l.lat), ln = num(l.lng);
      if (la === null || ln === null || (la === 0 && ln === 0)) return;
      var gy = Math.floor(la / CELL), gx = Math.floor(ln / CELL), k = gy + ':' + gx;
      var c = cells[k] || (cells[k] = { n: 0, lat: (gy + 0.5) * CELL, lng: (gx + 0.5) * CELL });
      c.n++;
    });
    return Object.keys(cells).map(function (k) { return cells[k]; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, MAX_ANCHORS)
      .map(function (c) { return { lat: Math.round(c.lat * 1e4) / 1e4, lng: Math.round(c.lng * 1e4) / 1e4, n: c.n }; });
  }

  // Tiny stable id for an event (FNV-1a over the sorted alert ids).
  function eventKeyOf(alertIds) {
    var s = alertIds.slice().sort().join('|'), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return 'sm' + ('00000000' + h.toString(16)).slice(-8);
  }

  // obs: null (poll failed — never treated as all-clear) or
  //      { matches: [{id, hazard, leadIds}] } for qualifying alerts that
  //      overlap the service area (leadIds may be empty for zone-wide ones).
  // Returns { state, actions } — actions are descriptive; glue performs them.
  function step(state, obs, nowMs) {
    var s = JSON.parse(JSON.stringify(state || {}));
    s.active = !!s.active;
    s.alertIds = s.alertIds || [];
    s.leadIds = s.leadIds || [];
    s.clearPolls = s.clearPolls || 0;
    var actions = [];
    if (s.pending && nowMs - s.pending.at > DRAFT_WINDOW_MS) s.pending = null;
    if (obs === null || obs === undefined) return { state: s, actions: actions };

    if (obs.matches && obs.matches.length) {
      var ids = obs.matches.map(function (m) { return m.id; });
      var leadSet = {};
      s.leadIds.forEach(function (i) { leadSet[i] = 1; });
      obs.matches.forEach(function (m) { (m.leadIds || []).forEach(function (i) { leadSet[i] = 1; }); });
      s.leadIds = Object.keys(leadSet);
      s.clearPolls = 0;
      if (!s.active) {
        s.active = true;
        s.since = nowMs;
        s.alertIds = ids.slice();
        s.eventKey = eventKeyOf(ids);
        s.hazard = obs.matches.some(function (m) { return m.hazard === 'hail'; }) ? 'hail' : 'wind';
        s.dismissed = false;
        actions.push('activate');
      } else {
        ids.forEach(function (i) { if (s.alertIds.indexOf(i) < 0) s.alertIds.push(i); });
        if (obs.matches.some(function (m) { return m.hazard === 'hail'; })) s.hazard = 'hail';
        actions.push('update');
      }
      return { state: s, actions: actions };
    }

    // successful poll, nothing qualifying overlaps
    if (s.active) {
      s.clearPolls += 1;
      if (s.clearPolls >= CLEAR_POLLS) {
        s.active = false;
        actions.push('all-clear');
        if (s.leadIds.length) {
          s.pending = { eventKey: s.eventKey, hazard: s.hazard || 'hail', leadIds: s.leadIds.slice(0, 400), at: nowMs };
        }
        s.alertIds = []; s.leadIds = []; s.clearPolls = 0; s.since = 0;
      }
    }
    if (!s.active && s.pending) actions.push('file-drafts');
    return { state: s, actions: actions };
  }

  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  var core = {
    QUALIFYING: QUALIFYING, pointInRing: pointInRing, ringsOf: ringsOf, hazardOf: hazardOf,
    parseAlerts: parseAlerts, customersInside: customersInside, serviceAnchors: serviceAnchors,
    eventKeyOf: eventKeyOf, step: step, chunk: chunk,
    CLEAR_POLLS: CLEAR_POLLS, DRAFT_WINDOW_MS: DRAFT_WINDOW_MS, MAX_DRAFT_LEADS: MAX_DRAFT_LEADS
  };

  if (typeof module === 'object' && module && module.exports) module.exports = core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ──────────────────────────────────────────────────────────────────
  // BROWSER GLUE
  // ──────────────────────────────────────────────────────────────────
  var LS_FLAG = 'nbd_storm_mode';
  var LS_CFG = 'nbd_storm_mode_cfg';
  var LS_STATE = 'nbd_storm_mode_state';
  var POLL_MS = 5 * 60 * 1000;
  var STORM_THEME = 'storm-season';
  var NWS = 'https://api.weather.gov';
  var HDR = { headers: { 'User-Agent': 'NBDProCRM/1.0 (roofing-crm)', Accept: 'application/geo+json' } };

  var cfg = null;
  var state = null;
  var timer = null;
  var lastPollAt = 0;
  var polling = false;
  var themed = false;         // we switched the theme for the current event
  var overridden = false;     // the user picked a theme during the storm
  var expectedKey = null;
  var banner = null;
  var previewTimer = null;
  var previewOn = false;
  var zoneCache = null;       // { key, ugc:[], states:[] }
  var clock = function () { return Date.now(); };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function defaults() { return { v: 1, enabled: false, keepTheme: false, drafts: true }; }
  function normalizeCfg(raw) {
    var c = defaults();
    if (raw && typeof raw === 'object') {
      c.enabled = raw.enabled === true;
      c.keepTheme = raw.keepTheme === true;
      c.drafts = raw.drafts !== false;
    }
    return c;
  }
  function loadCfg() {
    if (cfg) return cfg;
    var raw = null;
    try { raw = JSON.parse(lsGet(LS_CFG) || 'null'); } catch (e) {}
    cfg = normalizeCfg(raw);
    return cfg;
  }
  function loadState() {
    if (state) return state;
    var raw = null;
    try { raw = JSON.parse(lsGet(LS_STATE) || 'null'); } catch (e) {}
    state = raw && typeof raw === 'object' ? raw : {};
    return state;
  }
  function saveState() { lsSet(LS_STATE, JSON.stringify(state || {})); }

  var saveTimer = null;
  function persistCfg() {
    lsSet(LS_CFG, JSON.stringify(cfg));
    if (cfg.enabled) lsSet(LS_FLAG, '1'); else lsDel(LS_FLAG);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        var uid = (window._user && window._user.uid) || null;
        if (uid && window.db && window.doc && window.setDoc) {
          window.setDoc(window.doc(window.db, 'userSettings', uid), { stormMode: cfg }, { merge: true })
            .catch(function (e) { console.warn('[storm-mode] sync failed:', e && e.message); });
        }
      } catch (e) {}
    }, 600);
  }

  function engine() { return window.ThemeEngine || null; }
  function leads() { return Array.isArray(window._leads) ? window._leads : []; }

  // ── NWS ──────────────────────────────────────────────────────────
  function getJson(url) {
    return fetch(url, HDR).then(function (r) { if (!r.ok) throw new Error('nws ' + r.status); return r.json(); });
  }

  // county + forecast-zone codes and states for the anchors; cached per
  // anchor set so a poll is normally ONE request per state.
  function zonesFor(anchors) {
    var key = anchors.map(function (a) { return a.lat + ',' + a.lng; }).join(';');
    if (zoneCache && zoneCache.key === key) return Promise.resolve(zoneCache);
    return Promise.all(anchors.map(function (a) {
      return getJson(NWS + '/points/' + a.lat + ',' + a.lng).then(function (j) {
        var p = (j && j.properties) || {};
        var codes = [];
        [p.county, p.forecastZone, p.fireWeatherZone].forEach(function (u) { if (u) codes.push(String(u).split('/').pop()); });
        var st = p.relativeLocation && p.relativeLocation.properties && p.relativeLocation.properties.state;
        return { codes: codes, state: st || null };
      }).catch(function () { return null; });
    })).then(function (rows) {
      var ugc = [], states = [];
      rows.forEach(function (r) {
        if (!r) return;
        r.codes.forEach(function (c) { if (ugc.indexOf(c) < 0) ugc.push(c); });
        if (r.state && states.indexOf(r.state) < 0) states.push(r.state);
      });
      if (!states.length) return null;           // could not localise: do not guess
      zoneCache = { key: key, ugc: ugc, states: states };
      return zoneCache;
    });
  }

  // -> Promise<null | {matches}>  (null = unknown, NOT all-clear)
  function observe() {
    var L = leads();
    var anchors = serviceAnchors(L);
    if (!anchors.length) return Promise.resolve({ matches: [] });   // no customer coordinates yet
    return zonesFor(anchors).then(function (z) {
      if (!z) return null;
      var now = clock();
      return Promise.all(z.states.map(function (st) {
        return getJson(NWS + '/alerts/active?status=actual&message_type=alert&area=' + encodeURIComponent(st));
      })).then(function (collections) {
        var seen = {}, matches = [];
        collections.forEach(function (json) {
          parseAlerts(json, now).forEach(function (a) {
            if (seen[a.id]) return;
            seen[a.id] = 1;
            if (a.rings.length) {
              var inside = customersInside(a, L);
              if (inside.length) matches.push({ id: a.id, hazard: a.hazard, leadIds: inside });
            } else if (a.ugc.some(function (c) { return z.ugc.indexOf(c) >= 0; })) {
              matches.push({ id: a.id, hazard: a.hazard, leadIds: [] });   // zone-wide: banner only, no drafts
            }
          });
        });
        return { matches: matches };
      });
    }).catch(function () { return null; });
  }

  // ── Effects ──────────────────────────────────────────────────────
  function ensureCss() {
    if (document.getElementById('stormModeCss')) return;
    var l = document.createElement('link');
    l.id = 'stormModeCss'; l.rel = 'stylesheet'; l.href = '/pro/css/storm-mode.css?v=1';
    document.head.appendChild(l);
  }

  function paintTheme(key) {
    var E = engine();
    if (!E) return false;
    expectedKey = key;
    var A = window.NBDAutoTheme;
    // Theme Morph (roadmap A1): the warning has no click to grow from, so the
    // circle opens from the top-centre, where the banner appears.
    var origin = { x: Math.round((window.innerWidth || 0) / 2), y: 0 };
    try {
      if (A && A.applyTheme) {
        // applyTheme refuses a locked / unknown theme and de-dupes.
        if (!A.applyTheme(key, { source: 'storm-mode', origin: origin })) { expectedKey = null; return false; }
      } else {
        E.apply(key, false, { morph: true, origin: origin });
      }
    } catch (e) { expectedKey = null; return false; }
    return true;
  }

  function engageTheme() {
    var E = engine();
    if (themed || !E || loadCfg().keepTheme) return;
    var st = loadState();
    var cur = E.getCurrent && E.getCurrent();
    if (cur === STORM_THEME && st.stash) { themed = true; }         // reload mid-storm
    else {
      st.stash = cur || null;
      if (window.NBDAutoTheme && window.NBDAutoTheme.hold) window.NBDAutoTheme.hold('storm-mode');
      themed = paintTheme(STORM_THEME);
    }
    if (themed) {
      if (window.NBDAutoTheme && window.NBDAutoTheme.hold) window.NBDAutoTheme.hold('storm-mode');
      document.body.classList.add('storm-alert');
      ensureCss();
    }
    saveState();
  }

  function releaseTheme(restore) {
    var st = loadState();
    document.body.classList.remove('storm-alert');
    var E = engine();
    if (themed && restore && !overridden && E && st.stash && E.getCurrent && E.getCurrent() === STORM_THEME) paintTheme(st.stash);
    themed = false; overridden = false; expectedKey = null;
    st.stash = null;
    if (window.NBDAutoTheme && window.NBDAutoTheme.release) window.NBDAutoTheme.release('storm-mode');
    saveState();
  }

  function onThemeChange(ev) {
    if (!themed) return;
    var key = ev && ev.detail;
    if (key && typeof key === 'object') key = key.themeKey;
    if (key === STORM_THEME) return;
    if (expectedKey && key === expectedKey) { expectedKey = null; return; }
    // The user picked something themselves mid-storm: that is "keep my theme".
    overridden = true;
    document.body.classList.remove('storm-alert');
    if (banner) { var k = banner.querySelector('[data-sm-keep]'); if (k) k.hidden = true; }
  }

  function bannerText(st) {
    var n = (st.leadIds || []).length;
    var what = st.hazard === 'wind' ? 'damaging wind' : 'hail';
    return 'Severe storm warning (' + what + ')' + (n ? ' over ' + n + ' customer address' + (n === 1 ? '' : 'es') : ' for your area') + '.';
  }

  function showBanner(st) {
    if (st.dismissed) { hideBanner(); return; }
    if (!banner) {
      ensureCss();
      banner = document.createElement('div');
      banner.id = 'stormModeBanner';
      banner.className = 'storm-mode-banner';
      banner.setAttribute('role', 'alert');
      var msg = document.createElement('span'); msg.className = 'storm-mode-msg';
      var open = document.createElement('button'); open.type = 'button';
      open.className = 'storm-mode-btn'; open.textContent = 'Open Storm Watch';
      open.setAttribute('data-action', 'goTo'); open.setAttribute('data-target', 'storm');
      var keep = document.createElement('button'); keep.type = 'button';
      keep.className = 'storm-mode-btn'; keep.textContent = 'Keep my theme';
      keep.setAttribute('data-sm-keep', '1');
      var dis = document.createElement('button'); dis.type = 'button';
      dis.className = 'storm-mode-btn'; dis.textContent = 'Dismiss';
      dis.setAttribute('data-sm-dismiss', '1');
      banner.appendChild(msg); banner.appendChild(open); banner.appendChild(keep); banner.appendChild(dis);
      document.body.appendChild(banner);
    }
    banner.querySelector('.storm-mode-msg').textContent = (previewOn ? 'PREVIEW: ' : '') + bannerText(st);
    var keepBtn = banner.querySelector('[data-sm-keep]');
    if (keepBtn) keepBtn.hidden = !themed || overridden;
    banner.hidden = false;
  }
  function hideBanner() { if (banner) banner.hidden = true; }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-sm-keep],[data-sm-dismiss],[data-sm-act]') : null;
    if (!t) return;
    var st = loadState();
    if (t.hasAttribute('data-sm-keep')) {
      releaseTheme(true);
      st.keptTheme = true;
      saveState();
      showBanner(st);
    } else if (t.hasAttribute('data-sm-dismiss')) {
      st.dismissed = true; saveState(); hideBanner();
    } else if (t.getAttribute('data-sm-act') === 'preview') {
      preview();
    }
  }

  // ── Drafts ───────────────────────────────────────────────────────
  // Same callable plumbing as agent-inbox.js (lazy Functions SDK).
  function callable(name, payload) {
    var ready = window._httpsCallable ? Promise.resolve() :
      import('/assets/vendor/firebase/10.12.2/firebase-functions.js').then(function (m) { window._httpsCallable = m.httpsCallable; });
    return ready.then(function () {
      if (!window._functions) throw new Error('Functions SDK unavailable');
      return window._httpsCallable(window._functions, name)(payload || {});
    }).then(function (res) { return res && res.data; });
  }

  function fileDrafts() {
    var st = loadState();
    var p = st.pending;
    if (!p) return Promise.resolve();
    if (!loadCfg().drafts) { st.pending = null; saveState(); return Promise.resolve(); }
    var fn = function (d) { return callable('fileStormDrafts', d); };
    var batches = chunk(p.leadIds, MAX_DRAFT_LEADS);
    var done = 0;
    return batches.reduce(function (prev, ids) {
      return prev.then(function () {
        return fn({ eventKey: p.eventKey, hazard: p.hazard, leadIds: ids }).then(function () { done++; });
      });
    }, Promise.resolve()).then(function () {
      st.pending = null; saveState();
      try { document.dispatchEvent(new CustomEvent('nbd:storm-drafts-filed', { detail: { eventKey: p.eventKey, batches: done } })); } catch (e) {}
      if (typeof window.showToast === 'function') {
        window.showToast('Storm check-in drafts are in your Agent inbox. Nothing was sent.', 'info');
      }
    }).catch(function () { /* keep pending; retried next poll (24h window) */ });
  }

  // ── Poll loop ────────────────────────────────────────────────────
  function apply(actions, st) {
    actions.forEach(function (a) {
      if (a === 'activate') {
        saveState();
        engageTheme();
        showBanner(st);
      } else if (a === 'update') {
        showBanner(st);
      } else if (a === 'all-clear') {
        releaseTheme(true);
        hideBanner();
      } else if (a === 'file-drafts') {
        fileDrafts();
      }
    });
  }

  function poll() {
    loadCfg();
    if (!cfg.enabled || polling || previewOn) return Promise.resolve();
    if (document.hidden) return Promise.resolve();
    polling = true;
    lastPollAt = clock();
    return observe().then(function (obs) {
      polling = false;
      var r = step(loadState(), obs, clock());
      state = r.state;
      saveState();
      apply(r.actions, state);
      // reload mid-storm: re-assert the theme + banner without a new "activate"
      if (state.active && r.actions.indexOf('activate') < 0) {
        if (!themed && !state.keptTheme && !overridden) engageTheme();
        showBanner(state);
      }
    }).catch(function () { polling = false; });
  }

  function start() {
    loadCfg();
    stop();
    if (!cfg.enabled) return;
    // customers may still be loading: poll shortly, then every 5 minutes
    setTimeout(poll, 4000);
    timer = setInterval(poll, POLL_MS);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function setEnabled(on) {
    loadCfg();
    cfg.enabled = !!on;
    persistCfg();
    if (cfg.enabled) start();
    else {
      stop();
      var st = loadState();
      if (st.active || themed) { releaseTheme(true); hideBanner(); st.active = false; st.alertIds = []; st.leadIds = []; saveState(); }
    }
    renderPanel();
  }

  function update(patch) {
    loadCfg();
    Object.keys(patch).forEach(function (k) { cfg[k] = patch[k]; });
    cfg = normalizeCfg(cfg);
    persistCfg();
    renderPanel();
  }

  function hydrate(remote) {
    cfg = normalizeCfg(remote);
    lsSet(LS_CFG, JSON.stringify(cfg));
    if (cfg.enabled) { lsSet(LS_FLAG, '1'); start(); } else { lsDel(LS_FLAG); stop(); }
    renderPanel();
  }

  // 30 s look at the real thing: theme + banner, no drafts, no network.
  function preview() {
    loadCfg();
    if (!cfg.enabled || previewOn || loadState().active) return;
    previewOn = true;
    var st = { active: true, leadIds: [], hazard: 'hail', dismissed: false };
    engageTheme();
    showBanner(st);
    previewTimer = setTimeout(endPreview, 30000);
  }
  function endPreview() {
    if (!previewOn) return;
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    previewOn = false;
    releaseTheme(true);
    hideBanner();
    var st = loadState(); st.stash = null; saveState();
  }

  // ── Settings > Appearance > Storm Mode panel ─────────────────────
  function renderPanel() {
    var host = document.getElementById('stormModeBody');
    if (!host) return;
    loadCfg();
    var h = '';
    h += '<p class="myskin-note">When a severe thunderstorm, tornado or high-wind <strong>warning</strong> covers your customers\' addresses, ' +
         'switch to Storm Season, show a banner with a link to Storm Watch, and, once the warning has passed, put a check-in text ' +
         'for each customer in the path into your Agent inbox <strong>as a draft</strong>. Nothing is ever sent for you: you send each one ' +
         'from your own phone, and it is checked again for STOP, Do Not Text, consent and texting hours when you do. Off unless you turn it on.</p>';
    h += '<label class="myskin-row" for="stormModeOn"><span>Turn on Storm Mode</span><input type="checkbox" id="stormModeOn"' + (cfg.enabled ? ' checked' : '') + '></label>';
    h += '<label class="myskin-row" for="stormModeKeep"><span>Banner only, never change my theme</span><input type="checkbox" id="stormModeKeep"' + (cfg.keepTheme ? ' checked' : '') + (cfg.enabled ? '' : ' disabled') + '></label>';
    h += '<label class="myskin-row" for="stormModeDrafts"><span>Prepare check-in drafts after the storm</span><input type="checkbox" id="stormModeDrafts"' + (cfg.drafts ? ' checked' : '') + (cfg.enabled ? '' : ' disabled') + '></label>';
    h += '<div class="myskin-actions"><button type="button" class="btn btn-ghost btn-sm" data-sm-act="preview"' + (cfg.enabled ? '' : ' disabled') + '>See what it looks like (30 seconds)</button></div>';
    host.innerHTML = h;
  }

  function onChange(ev) {
    var t = ev.target;
    if (!t || !t.closest || !t.closest('#stormModeBody')) return;
    if (t.id === 'stormModeOn') setEnabled(t.checked);
    else if (t.id === 'stormModeKeep') update({ keepTheme: t.checked });
    else if (t.id === 'stormModeDrafts') update({ drafts: t.checked });
  }

  var api = {
    core: core,
    start: start, stop: stop, poll: poll, preview: preview, endPreview: endPreview,
    setEnabled: setEnabled, hydrate: hydrate, update: update,
    getConfig: function () { return JSON.parse(JSON.stringify(loadCfg())); },
    getState: function () { return JSON.parse(JSON.stringify(loadState())); },
    isEnabled: function () { return loadCfg().enabled; },
    _setClock: function (fn) { clock = fn; },
    _observeWith: function (fn) { observe = fn; },
    _reset: function () { cfg = null; state = null; themed = false; overridden = false; previewOn = false; polling = false; }
  };
  window.NBDStormMode = api;

  document.addEventListener('themechange', onThemeChange);
  document.addEventListener('change', onChange);
  document.addEventListener('click', function (ev) {
    onClick(ev);
    var tabBtn = ev.target && ev.target.closest && ev.target.closest('[data-action="settingsTab"][data-target="appearance"]');
    if (tabBtn) setTimeout(renderPanel, 50);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && loadCfg().enabled && clock() - lastPollAt > POLL_MS) poll();
  });

  function boot() {
    loadCfg();
    renderPanel();
    if (cfg.enabled) start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
