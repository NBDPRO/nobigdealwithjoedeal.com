/**
 * auto-theme.js — NBD Pro "Auto theme": day cycle + ordered rules
 * (CRM style roadmap C1, design idea #06).
 *
 * Extends the Comfort "Auto theme by time" toggle (dashboard-ui.js
 * nbdAutoThemeStart/Stop, localStorage nbd_auto_theme) instead of replacing it:
 * the toggle still turns Auto on and off, and now drives this scheduler.
 *
 * What it does
 *   - Sunrise / sunset from a ~40-line NOAA solar calculation (no API).
 *   - Four day phases: Dawn / Day / Dusk / Night, each with its own theme pick.
 *   - An ordered rule list, first match wins:
 *       Storm alert > At a customer's address (GPS) > Day cycle >
 *       Rainy forecast > Fallback theme
 *     Each rule can be switched off and the list can be re-ordered.
 *   - Hand-picking a theme pauses Auto until local midnight.
 *   - Never switches while a modal / estimate editor is open (retries on the
 *     next tick).
 *   - Settings are JSON on userSettings/{uid}.autoTheme (durable, cross
 *     device); a localStorage copy (nbd_auto_theme_cfg) only paints boot.
 *
 * Seams other lanes plug into
 *   NBDAutoTheme.setContext({ storm, onJobSite, raining })   rule inputs
 *   NBDAutoTheme.hold(token) / release(token)                 freeze the
 *       scheduler (Storm Mode holds it while a storm theme is up)
 *   NBDAutoTheme.registerRule(id, label, fn)                  extra rule, e.g.
 *       a layout context switch: fn(ctx, cfg, phase) -> themeKey | null
 *   NBDAutoTheme.applyTheme(key, {source})                    THE single seam
 *       every automatic switch goes through (swap in Theme Morph here later)
 *   document event "nbd:auto-theme" {detail:{theme, rule, phase}} after each
 *       automatic switch, for a layout engine to hook the same decision.
 *
 * Pure logic (solarTimes / phaseAt / resolve / ...) is exported for
 * tests/auto-theme-rules.test.js. Browser glue is skipped when there is no
 * document, so the file also loads under node.
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // PURE CORE
  // ──────────────────────────────────────────────────────────────────
  var RAD = Math.PI / 180;
  var DEFAULT_LAT = 39.1031;   // Cincinnati — NBD's home market
  var DEFAULT_LNG = -84.512;

  // Phase edges, minutes around sunrise / sunset.
  var DAWN_BEFORE = 30, DAWN_AFTER = 60, DUSK_BEFORE = 60, DUSK_AFTER = 30;

  var PHASES = ['dawn', 'day', 'dusk', 'night'];
  var RULE_ORDER = ['storm', 'jobsite', 'cycle', 'rain', 'fallback'];
  var RULE_LABELS = {
    storm: 'Storm alert',
    jobsite: "At a customer's address",
    cycle: 'Day cycle (dawn / day / dusk / night)',
    rain: 'Rainy forecast',
    fallback: 'Fallback theme'
  };

  function dayOfYear(y, m, d) {
    return Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
  }

  // NOAA solar calculator (fractional-year form). Accurate to ~1-2 minutes at
  // US latitudes. y/m(0-11)/d are the LOCAL calendar date; lng is degrees east
  // (negative in the Americas). Returns Dates, or polar:'day'|'night'.
  function solarTimes(y, m, d, lat, lng) {
    var doy = dayOfYear(y, m, d);
    var g = (2 * Math.PI / 365) * (doy - 1);          // noon of the day
    var eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) -
      0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
      0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var cosHa = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) -
      Math.tan(lat * RAD) * Math.tan(decl);
    if (cosHa > 1) return { sunrise: null, sunset: null, polar: 'night' };
    if (cosHa < -1) return { sunrise: null, sunset: null, polar: 'day' };
    var ha = Math.acos(cosHa) / RAD;                  // degrees
    var base = Date.UTC(y, m, d, 0, 0, 0);
    var rise = 720 - 4 * (lng + ha) - eqTime;         // UTC minutes
    var set = 720 - 4 * (lng - ha) - eqTime;
    return { sunrise: new Date(base + rise * 60000), sunset: new Date(base + set * 60000), polar: null };
  }

  function sunForDate(date, lat, lng) {
    return solarTimes(date.getFullYear(), date.getMonth(), date.getDate(), lat, lng);
  }

  // 'dawn' | 'day' | 'dusk' | 'night' for an instant given that day's sun.
  function phaseAt(nowMs, sun) {
    if (!sun) return 'day';
    if (sun.polar) return sun.polar;
    var rise = sun.sunrise.getTime(), set = sun.sunset.getTime(), min = 60000;
    if (nowMs >= rise - DAWN_BEFORE * min && nowMs < rise + DAWN_AFTER * min) return 'dawn';
    if (nowMs >= rise + DAWN_AFTER * min && nowMs < set - DUSK_BEFORE * min) return 'day';
    if (nowMs >= set - DUSK_BEFORE * min && nowMs < set + DUSK_AFTER * min) return 'dusk';
    return 'night';
  }

  function nextLocalMidnight(nowMs) {
    var d = new Date(nowMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
  }

  function defaultConfig(legacyDay, legacyNight) {
    var day = legacyDay || 'paper', night = legacyNight || 'nbd-original';
    return {
      v: 1,
      enabled: false,
      order: RULE_ORDER.slice(),
      off: [],                         // rule ids switched off
      picks: { dawn: day, day: day, dusk: night, night: night },
      stormTheme: 'storm-season',
      jobSiteTheme: '',                // '' = rule has nothing to apply
      rainTheme: '',
      fallback: '',
      gps: false,                      // user allowed the customer-address rule
      lat: null, lng: null             // user-set location; null = Cincinnati
    };
  }

  // Tolerant merge: unknown/missing fields fall back to defaults, the rule
  // order is repaired (no dupes, no unknown ids, every rule present).
  function normalizeConfig(raw, legacyDay, legacyNight) {
    var c = defaultConfig(legacyDay, legacyNight);
    if (!raw || typeof raw !== 'object') return c;
    c.enabled = raw.enabled === true;
    if (Array.isArray(raw.order)) {
      var seen = {}, out = [];
      raw.order.forEach(function (id) {
        if (RULE_ORDER.indexOf(id) >= 0 && !seen[id]) { seen[id] = 1; out.push(id); }
      });
      RULE_ORDER.forEach(function (id) { if (!seen[id]) out.push(id); });
      c.order = out;
    }
    if (Array.isArray(raw.off)) c.off = raw.off.filter(function (id) { return RULE_ORDER.indexOf(id) >= 0; });
    if (raw.picks && typeof raw.picks === 'object') {
      PHASES.forEach(function (p) {
        if (typeof raw.picks[p] === 'string') c.picks[p] = raw.picks[p];
      });
    }
    ['stormTheme', 'jobSiteTheme', 'rainTheme', 'fallback'].forEach(function (k) {
      if (typeof raw[k] === 'string') c[k] = raw[k];
    });
    c.gps = raw.gps === true;
    var lat = Number(raw.lat), lng = Number(raw.lng);
    if (raw.lat != null && raw.lng != null && isFinite(lat) && isFinite(lng) &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180) { c.lat = lat; c.lng = lng; }
    return c;
  }

  // Rule engine. First enabled rule that yields a theme wins.
  // ctx: { storm, onJobSite, raining }  extra: [{id, fn}] registered rules
  // (an extra rule is only consulted when its id is in cfg.order — they are
  // appended just before the fallback by registerRule's caller).
  function resolve(cfg, nowMs, ctx, extra) {
    ctx = ctx || {};
    var lat = cfg.lat != null ? cfg.lat : DEFAULT_LAT;
    var lng = cfg.lng != null ? cfg.lng : DEFAULT_LNG;
    var sun = sunForDate(new Date(nowMs), lat, lng);
    var phase = phaseAt(nowMs, sun);
    var order = cfg.order.slice();
    (extra || []).forEach(function (e) {
      if (order.indexOf(e.id) < 0) order.splice(Math.max(order.indexOf('fallback'), 0), 0, e.id);
    });
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      if (cfg.off.indexOf(id) >= 0) continue;
      var theme = null;
      if (id === 'storm') theme = ctx.storm ? (cfg.stormTheme || 'storm-season') : null;
      else if (id === 'jobsite') theme = ctx.onJobSite ? (cfg.jobSiteTheme || null) : null;
      else if (id === 'cycle') theme = cfg.picks[phase] || null;
      else if (id === 'rain') theme = ctx.raining ? (cfg.rainTheme || null) : null;
      else if (id === 'fallback') theme = cfg.fallback || null;
      else {
        for (var j = 0; j < (extra || []).length; j++) {
          if (extra[j].id === id) { try { theme = extra[j].fn(ctx, cfg, phase) || null; } catch (e) { theme = null; } }
        }
      }
      if (theme) return { theme: theme, rule: id, phase: phase, sun: sun };
    }
    return { theme: null, rule: null, phase: phase, sun: sun };
  }

  // weather.gov hourly period -> "is it raining enough to care".
  function isRainyPeriod(p) {
    if (!p) return false;
    var pop = p.probabilityOfPrecipitation && Number(p.probabilityOfPrecipitation.value);
    var txt = String(p.shortForecast || '');
    var wet = /rain|shower|thunder|storm|drizzle/i.test(txt) && !/slight chance|chance of (light )?(rain|showers)/i.test(txt);
    return (isFinite(pop) && pop >= 60) || wet;
  }

  var core = {
    solarTimes: solarTimes, sunForDate: sunForDate, phaseAt: phaseAt,
    nextLocalMidnight: nextLocalMidnight, defaultConfig: defaultConfig,
    normalizeConfig: normalizeConfig, resolve: resolve, isRainyPeriod: isRainyPeriod,
    PHASES: PHASES, RULE_ORDER: RULE_ORDER, RULE_LABELS: RULE_LABELS,
    DEFAULT_LAT: DEFAULT_LAT, DEFAULT_LNG: DEFAULT_LNG
  };

  if (typeof module === 'object' && module && module.exports) module.exports = core;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ──────────────────────────────────────────────────────────────────
  // BROWSER GLUE
  // ──────────────────────────────────────────────────────────────────
  var LS_FLAG = 'nbd_auto_theme';              // existing Comfort toggle key
  var LS_CFG = 'nbd_auto_theme_cfg';
  var LS_PAUSE = 'nbd_auto_theme_paused_until';
  var TICK_MS = 60000;

  var cfg = null;
  var ctx = { storm: false, onJobSite: false, raining: false };
  var extraRules = [];
  var holds = {};
  var timer = null;
  var expected = null;       // {key, until} — our own pending apply
  var pausedUntil = 0;
  var saveTimer = null;
  var rainCache = { at: 0, key: '', val: false };
  var clock = function () { return Date.now(); };   // test seam
  var BOOT_GRACE_MS = 10000;
  var bootAt = Date.now();
  var lastKey = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function loadCfg() {
    if (cfg) return cfg;
    var raw = null;
    try { raw = JSON.parse(lsGet(LS_CFG) || 'null'); } catch (e) {}
    cfg = normalizeConfig(raw, lsGet('nbd_auto_theme_day'), lsGet('nbd_auto_theme_night'));
    // The Comfort toggle is the device-level master switch.
    if (lsGet(LS_FLAG) === '1') cfg.enabled = true;
    pausedUntil = Number(lsGet(LS_PAUSE)) || 0;
    return cfg;
  }

  function persist() {
    lsSet(LS_CFG, JSON.stringify(cfg));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        var uid = (window._user && window._user.uid) || null;
        if (uid && window.db && window.doc && window.setDoc) {
          window.setDoc(window.doc(window.db, 'userSettings', uid), { autoTheme: cfg }, { merge: true })
            .catch(function (e) { console.warn('[auto-theme] sync failed:', e && e.message); });
        }
      } catch (e) {}
    }, 600);
  }

  function engine() { return window.ThemeEngine || null; }

  function themeUsable(key) {
    var E = engine();
    if (!E || !key) return false;
    if (E.get && !E.get(key)) return false;          // unknown id
    if (E.isUnlocked && !E.isUnlocked(key)) return false;
    return true;
  }

  // THE seam. Every automatic switch goes through here. Theme Morph
  // (lane "theme-polish") plugs in by replacing the body of `paint`.
  function paint(key) {
    var E = engine();
    // save=false: Auto never overwrites the theme the user actually chose.
    E.apply(key, false);
  }
  function applyTheme(key, opts) {
    var E = engine();
    if (!E || !themeUsable(key)) return false;
    if (E.getCurrent && E.getCurrent() === key) return true;
    expected = { key: key, until: clock() + 3000 };
    try { paint(key); } catch (e) { expected = null; return false; }
    return true;
  }

  function overlayOpen() {
    try {
      if (window.nbdModal && window.nbdModal.anyOpen && window.nbdModal.anyOpen()) return true;
      return !!(document.querySelector('#estV2Modal.open, #nbd-ep-overlay, .modal-bg.open, .d2d-modal-overlay.open, dialog[open]'));
    } catch (e) { return false; }
  }

  function holdActive() { for (var k in holds) { if (holds[k]) return true; } return false; }

  function rainWanted() {
    return cfg.off.indexOf('rain') < 0 && !!cfg.rainTheme;
  }

  function refreshRain(lat, lng) {
    if (!rainWanted() || typeof fetch !== 'function') return;
    var key = lat.toFixed(2) + ',' + lng.toFixed(2);
    var now = clock();
    if (rainCache.key === key && now - rainCache.at < 30 * 60000) return;
    rainCache = { at: now, key: key, val: rainCache.key === key ? rainCache.val : false };
    var hdr = { headers: { 'User-Agent': 'NBDProCRM/1.0 (roofing-crm)', Accept: 'application/geo+json' } };
    fetch('https://api.weather.gov/points/' + lat.toFixed(4) + ',' + lng.toFixed(4), hdr)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var url = j && j.properties && j.properties.forecastHourly;
        if (!url) return null;
        return fetch(url, hdr).then(function (r) { return r.ok ? r.json() : null; });
      })
      .then(function (j) {
        var periods = j && j.properties && j.properties.periods;
        if (!periods || !periods.length) return;
        var wet = isRainyPeriod(periods[0]) || isRainyPeriod(periods[1]);
        if (wet !== rainCache.val) { rainCache.val = wet; ctx.raining = wet; tick(); }
        else ctx.raining = wet;
      })
      .catch(function () { /* offline: keep last value */ });
  }

  function refreshJobSite() {
    if (!cfg.gps || cfg.off.indexOf('jobsite') >= 0) { ctx.onJobSite = false; return; }
    if (!navigator.geolocation || !navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: 'geolocation' }).then(function (st) {
      if (st.state !== 'granted') return;           // never prompt from a timer
      navigator.geolocation.getCurrentPosition(function (pos) {
        var leads = window._leads || [];
        var here = [pos.coords.latitude, pos.coords.longitude], near = false;
        for (var i = 0; i < leads.length && !near; i++) {
          var L = leads[i];
          if (!L || !L.lat || !L.lng) continue;
          if (metersBetween(here, [Number(L.lat), Number(L.lng)]) <= 150) near = true;
        }
        if (near !== ctx.onJobSite) { ctx.onJobSite = near; tick(); }
      }, function () {}, { maximumAge: 120000, timeout: 8000 });
    }).catch(function () {});
  }

  function metersBetween(a, b) {
    var R = 6371000, dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function status() {
    loadCfg();
    var now = clock();
    var r = resolve(cfg, now, ctx, extraRules);
    return {
      enabled: !!cfg.enabled,
      paused: pausedUntil > now,
      pausedUntil: pausedUntil > now ? pausedUntil : 0,
      held: holdActive(),
      phase: r.phase, rule: r.rule, theme: r.theme,
      sunrise: r.sun && r.sun.sunrise, sunset: r.sun && r.sun.sunset, polar: r.sun && r.sun.polar
    };
  }

  function tick() {
    loadCfg();
    if (!cfg.enabled || !engine()) { renderStatusOnly(); return; }
    var now = clock();
    if (pausedUntil && now >= pausedUntil) { pausedUntil = 0; lsDel(LS_PAUSE); }
    if (pausedUntil || holdActive()) { renderStatusOnly(); return; }
    if (overlayOpen()) return;                      // retry next tick
    var lat = cfg.lat != null ? cfg.lat : DEFAULT_LAT;
    var lng = cfg.lng != null ? cfg.lng : DEFAULT_LNG;
    refreshRain(lat, lng);
    refreshJobSite();
    var r = resolve(cfg, now, ctx, extraRules);
    if (r.theme && themeUsable(r.theme) && engine().getCurrent() !== r.theme) {
      if (applyTheme(r.theme, { source: 'auto' })) {
        try {
          document.dispatchEvent(new CustomEvent('nbd:auto-theme', { detail: { theme: r.theme, rule: r.rule, phase: r.phase } }));
        } catch (e) {}
      }
    }
    renderStatusOnly();
  }

  function start() {
    loadCfg();
    stop();
    tick();
    timer = setInterval(tick, TICK_MS);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function setEnabled(on) {
    loadCfg();
    cfg.enabled = !!on;
    if (on) { lsSet(LS_FLAG, '1'); pausedUntil = 0; lsDel(LS_PAUSE); start(); }
    else { lsDel(LS_FLAG); stop(); }
    persist();
    renderPanel();
  }

  // A theme change we did not cause = the user picked one by hand.
  function onThemeChange(ev) {
    if (!cfg || !cfg.enabled) return;
    var key = ev && ev.detail;
    if (key && typeof key === 'object') key = key.themeKey;
    var now = clock();
    var same = key === lastKey;
    lastKey = key;
    if (same) return;                               // re-apply of the same theme (OS scheme flip, boot hydrate)
    if (now - bootAt < BOOT_GRACE_MS) return;       // engine boot + Firestore self-heal apply the saved theme
    if (expected && now <= expected.until && key === expected.key) { expected = null; return; }
    if (holdActive()) return;                       // storm theme etc.
    pausedUntil = nextLocalMidnight(now);
    lsSet(LS_PAUSE, String(pausedUntil));
    renderPanel();
  }

  function resume() {
    pausedUntil = 0; lsDel(LS_PAUSE);
    tick();
    renderPanel();
  }

  function hydrate(remote) {
    loadCfg();
    var next = normalizeConfig(remote, lsGet('nbd_auto_theme_day'), lsGet('nbd_auto_theme_night'));
    cfg = next;
    lsSet(LS_CFG, JSON.stringify(cfg));
    if (cfg.enabled) { lsSet(LS_FLAG, '1'); start(); } else { lsDel(LS_FLAG); stop(); }
    renderPanel();
  }

  function update(mut) {
    loadCfg();
    mut(cfg);
    cfg = normalizeConfig(cfg);
    persist();
    tick();
    renderPanel();
  }

  // ── Settings > Appearance > Auto panel ───────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtTime(d) { return d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'; }

  function themeOptions(selected, allowNone, noneLabel) {
    var E = engine(), html = allowNone ? '<option value="">' + esc(noneLabel || '(none)') + '</option>' : '';
    if (!E || !E.getAll) return html;
    var all = E.getAll(), rows = [];
    Object.keys(all).forEach(function (k) {
      if (E.isUnlocked && !E.isUnlocked(k)) return;
      rows.push([k, all[k].name || k]);
    });
    rows.sort(function (a, b) { return a[1].localeCompare(b[1]); });
    rows.forEach(function (r) {
      html += '<option value="' + esc(r[0]) + '"' + (r[0] === selected ? ' selected' : '') + '>' + esc(r[1]) + '</option>';
    });
    return html;
  }

  var PHASE_LABEL = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };

  function statusLine() {
    var s = status();
    if (!s.enabled) return 'Auto theme is off.';
    var bits = [];
    if (s.polar) bits.push(s.polar === 'day' ? 'Sun up all day' : 'Sun down all day');
    else bits.push('Sunrise ' + fmtTime(s.sunrise) + ' · sunset ' + fmtTime(s.sunset));
    bits.push('now ' + PHASE_LABEL[s.phase]);
    if (s.held) bits.push('held (storm mode)');
    else if (s.paused) bits.push('paused until midnight');
    else if (s.rule) bits.push('rule: ' + RULE_LABELS[s.rule]);
    return bits.join(' · ');
  }

  function renderStatusOnly() {
    var el = document.getElementById('autoThemeStatus');
    if (el) el.textContent = statusLine();
  }

  function renderPanel() {
    var host = document.getElementById('autoThemeBody');
    if (!host) return;
    loadCfg();
    // Don't rebuild under a focused control (selects close on re-render).
    var ae = document.activeElement;
    if (ae && host.contains(ae) && ae.tagName === 'SELECT') { renderStatusOnly(); return; }
    var s = status();
    var h = '';
    h += '<label class="myskin-row" for="autoThemeOn"><span>Switch themes automatically</span>' +
         '<input type="checkbox" id="autoThemeOn"' + (cfg.enabled ? ' checked' : '') + '></label>';
    h += '<div id="autoThemeStatus" class="at-status" aria-live="polite">' + esc(statusLine()) + '</div>';
    if (s.paused) h += '<button type="button" class="btn btn-ghost btn-sm" data-at-act="resume">Resume Auto now</button>';
    h += '<div class="at-phases">';
    PHASES.forEach(function (p) {
      h += '<label class="at-cap">' + PHASE_LABEL[p] +
           '<select class="btn btn-ghost btn-sm" data-at-pick="' + p + '">' +
           themeOptions(cfg.picks[p], true, '(no change)') + '</select></label>';
    });
    h += '</div>';
    h += '<div class="at-cap at-cap-rules">Rules — top one that applies wins</div>';
    cfg.order.forEach(function (id, i) {
      var on = cfg.off.indexOf(id) < 0;
      var themeField = '';
      if (id === 'jobsite') themeField = '<select class="btn btn-ghost btn-sm" data-at-theme="jobSiteTheme">' + themeOptions(cfg.jobSiteTheme, true, '(no theme)') + '</select>';
      else if (id === 'rain') themeField = '<select class="btn btn-ghost btn-sm" data-at-theme="rainTheme">' + themeOptions(cfg.rainTheme, true, '(no theme)') + '</select>';
      else if (id === 'fallback') themeField = '<select class="btn btn-ghost btn-sm" data-at-theme="fallback">' + themeOptions(cfg.fallback, true, '(no change)') + '</select>';
      else if (id === 'storm') themeField = '<span class="at-note">uses Storm Season when Storm Mode (Settings) is on</span>';
      h += '<div class="ui-row at-rule">' +
           '<input type="checkbox" data-at-rule="' + id + '"' + (on ? ' checked' : '') + ' aria-label="Use rule ' + esc(RULE_LABELS[id]) + '">' +
           '<span class="at-rule-name">' + (i + 1) + '. ' + esc(RULE_LABELS[id]) + '</span>' + themeField +
           '<button type="button" class="btn btn-ghost btn-sm" data-at-move="up" data-at-id="' + id + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">&#9650;</button>' +
           '<button type="button" class="btn btn-ghost btn-sm" data-at-move="down" data-at-id="' + id + '"' + (i === cfg.order.length - 1 ? ' disabled' : '') + ' aria-label="Move down">&#9660;</button>' +
           '</div>';
    });
    h += '<div class="at-actions">' +
         '<button type="button" class="btn btn-ghost btn-sm" data-at-act="locate">Use my location for sunrise &amp; sunset</button>' +
         '<label class="at-gps"><input type="checkbox" id="autoThemeGps"' + (cfg.gps ? ' checked' : '') + '> Detect when I am at a customer\'s address</label>' +
         '</div>';
    h += '<div class="at-help">' +
         (cfg.lat != null ? 'Using your saved location (rounded to about a mile). ' : 'Using Cincinnati until you set a location. ') +
         'Picking a theme yourself pauses Auto until midnight. Auto never switches while a window is open, and never changes the theme you saved.</div>';
    host.innerHTML = h;
  }

  function onPanelChange(ev) {
    var t = ev.target;
    if (!t || !t.closest || !t.closest('#autoThemeBody')) return;
    if (t.id === 'autoThemeOn') {
      setEnabled(t.checked);
      if (typeof window.nbdComfortRefresh === 'function') { try { window.nbdComfortRefresh(); } catch (e) {} }
    } else if (t.id === 'autoThemeGps') {
      if (t.checked && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(function () { update(function (c) { c.gps = true; }); },
          function () { update(function (c) { c.gps = false; }); }, { timeout: 10000 });
      } else update(function (c) { c.gps = false; });
    } else if (t.getAttribute('data-at-pick')) {
      var ph = t.getAttribute('data-at-pick'), v = t.value;
      update(function (c) { c.picks[ph] = v; });
    } else if (t.getAttribute('data-at-theme')) {
      var f = t.getAttribute('data-at-theme'), val = t.value;
      update(function (c) { c[f] = val; });
    } else if (t.getAttribute('data-at-rule')) {
      var id = t.getAttribute('data-at-rule'), on = t.checked;
      update(function (c) {
        c.off = c.off.filter(function (x) { return x !== id; });
        if (!on) c.off.push(id);
      });
    }
  }

  function onPanelClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('#autoThemeBody [data-at-act], #autoThemeBody [data-at-move]') : null;
    if (!b) return;
    var act = b.getAttribute('data-at-act');
    if (act === 'resume') resume();
    else if (act === 'locate') {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(function (pos) {
        // ~1 mile precision: enough for sunrise, not a tracking record.
        var la = Math.round(pos.coords.latitude * 100) / 100, ln = Math.round(pos.coords.longitude * 100) / 100;
        update(function (c) { c.lat = la; c.lng = ln; });
      }, function () {}, { timeout: 10000 });
    } else if (b.getAttribute('data-at-move')) {
      var id = b.getAttribute('data-at-id'), dir = b.getAttribute('data-at-move') === 'up' ? -1 : 1;
      update(function (c) {
        var i = c.order.indexOf(id), j = i + dir;
        if (i < 0 || j < 0 || j >= c.order.length) return;
        var tmp = c.order[i]; c.order[i] = c.order[j]; c.order[j] = tmp;
      });
    }
  }

  var api = {
    core: core,
    start: start, stop: stop, tick: tick, status: status,
    setEnabled: setEnabled, resume: resume, hydrate: hydrate,
    getConfig: function () { return JSON.parse(JSON.stringify(loadCfg())); },
    update: update,
    setContext: function (patch) {
      var changed = false;
      Object.keys(patch || {}).forEach(function (k) {
        if (k in ctx && ctx[k] !== !!patch[k]) { ctx[k] = !!patch[k]; changed = true; }
      });
      if (changed) tick();
    },
    getContext: function () { return JSON.parse(JSON.stringify(ctx)); },
    hold: function (token) { holds[token] = true; },
    release: function (token) { delete holds[token]; tick(); },
    isHeld: holdActive,
    registerRule: function (id, label, fn) {
      extraRules = extraRules.filter(function (e) { return e.id !== id; });
      extraRules.push({ id: id, fn: fn });
      RULE_LABELS[id] = label || id;
    },
    applyTheme: applyTheme,
    _setClock: function (fn) { clock = fn; },
    _resetForTest: function () { bootAt = 0; lastKey = null; cfg = null; pausedUntil = 0; holds = {}; ctx = { storm: false, onJobSite: false, raining: false }; expected = null; }
  };
  window.NBDAutoTheme = api;

  document.addEventListener('themechange', onThemeChange);
  document.addEventListener('change', onPanelChange);
  document.addEventListener('click', function (ev) {
    onPanelClick(ev);
    var tabBtn = ev.target && ev.target.closest && ev.target.closest('[data-action="settingsTab"][data-target="appearance"]');
    if (tabBtn) setTimeout(renderPanel, 50);
  });
  // Re-sync the panel (and the Comfort checkbox state) when the tab is shown.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  function ensureCss() {
    if (!document.head || typeof document.createElement !== 'function' || document.getElementById('autoThemeCss')) return;
    var l = document.createElement('link');
    l.id = 'autoThemeCss'; l.rel = 'stylesheet'; l.href = '/pro/css/auto-theme.css?v=1';
    document.head.appendChild(l);
  }

  function boot() {
    ensureCss();
    loadCfg();
    lastKey = engine() && engine().getCurrent ? engine().getCurrent() : null;
    renderPanel();
    if (cfg.enabled) start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
