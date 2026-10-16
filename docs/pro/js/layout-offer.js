/**
 * layout-offer.js — "Day and night layouts" (2026-10-15, layouts feature N4).
 *
 * OFFERS, never switches: Field App on a phone or tablet during the day,
 * Mission Control on a laptop at night. A small banner asks; one tap switches
 * for this session (LayoutEngine.apply(id, { source: 'auto' }), not saved as
 * the rep's choice, the same way Storm Mode offers Mission Control), "Not now"
 * hides it until the next day/night change, "Don't ask again" turns it off.
 *
 * Day vs night:
 *   'sun'    sunrise to sunset from auto-theme.js's own solar math
 *            (NBDAutoTheme.core.sunForDate, at the Auto theme location) when
 *            that bundle is loaded; the hours below otherwise
 *   'fixed'  the rep's own hours (default 7 am to 7 pm)
 * Auto theme's "nbd:auto-theme" event (its day-cycle hook) re-checks the offer
 * when the phase turns.
 *
 * Never offered: while the company has locked the layout or does not allow
 * that layout, when the layout cannot show on this screen, while it already is
 * the layout, during a preview, a storm switch or an open dialog.
 *
 * Settings > Appearance > "Day and night layouts" (#layoutOfferPanel): on/off
 * and which hours count as day. Per DEVICE (localStorage nbd_layout_offer,
 * kept across sign-out like the other layout preferences): day and night are
 * about this screen, not the account.
 *
 * Pure half (cfgOf / periodAt / offerFor) is require()-able for tests.
 * Loaded lazily (ScriptLoader bundle 'layoutoffer', kicked by today-home.js boot).
 */
(function (root) {
  'use strict';

  var LS_CFG = 'nbd_layout_offer';
  var LS_SEEN = 'nbd_layout_offer_seen';      // { 'YYYY-MM-DD:day': 1 } — "Not now" for this period
  var DEFAULTS = { off: false, hours: 'sun', dayStart: 7, dayEnd: 19 };
  var NAMES = { field: 'Field App', mission: 'Mission Control' };

  // ── pure ─────────────────────────────────────────────────────────────
  function hr(v, d) { var n = Math.round(Number(v)); return isFinite(n) && n >= 0 && n <= 23 ? n : d; }
  function cfgOf(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var c = { off: r.off === true, hours: r.hours === 'fixed' ? 'fixed' : 'sun', dayStart: hr(r.dayStart, DEFAULTS.dayStart), dayEnd: hr(r.dayEnd, DEFAULTS.dayEnd) };
    if (c.dayEnd <= c.dayStart) { c.dayStart = DEFAULTS.dayStart; c.dayEnd = DEFAULTS.dayEnd; }
    return c;
  }
  function ymdOf(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  /** 'day' | 'night'. sun: { sunrise, sunset } (Dates) or { polar } from auto-theme.js, or null. */
  function periodAt(nowMs, cfg, sun) {
    var c = cfgOf(cfg);
    if (c.hours === 'sun' && sun && sun.sunrise && sun.sunset) {
      return nowMs >= sun.sunrise.getTime() && nowMs < sun.sunset.getTime() ? 'day' : 'night';
    }
    if (c.hours === 'sun' && sun && sun.polar) return sun.polar === 'day' ? 'day' : 'night';
    var h = new Date(nowMs).getHours();
    return h >= c.dayStart && h < c.dayEnd ? 'day' : 'night';
  }
  /**
   * Which layout to OFFER, or null.
   *   i: { nowMs, cfg, sun, surface:'phone'|'tablet'|'desktop', current, source,
   *        company:{locked, allowed}, surfacesOf(id) -> [] | null, seen:{}, busy }
   */
  function offerFor(i) {
    var x = i || {};
    var c = cfgOf(x.cfg);
    if (c.off || x.busy) return null;
    if (x.source === 'preview' || x.source === 'storm') return null;
    var co = x.company || {};
    if (co.locked === true) return null;
    var per = periodAt(x.nowMs, c, x.sun);
    var touch = x.surface === 'phone' || x.surface === 'tablet';
    var want = per === 'day' ? (touch ? 'field' : null) : (x.surface === 'desktop' ? 'mission' : null);
    if (!want || x.current === want) return null;
    if (Array.isArray(co.allowed) && co.allowed.indexOf(want) === -1) return null;
    var surf = typeof x.surfacesOf === 'function' ? x.surfacesOf(want) : null;
    if (!Array.isArray(surf) || surf.indexOf(x.surface) === -1) return null;
    var key = ymdOf(x.nowMs) + ':' + per;
    if (x.seen && x.seen[key]) return null;
    return { id: want, period: per, key: key };
  }

  var pure = { cfgOf: cfgOf, periodAt: periodAt, offerFor: offerFor, ymdOf: ymdOf, DEFAULTS: DEFAULTS, LS_CFG: LS_CFG, LS_SEEN: LS_SEEN };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document || root.NBDLayoutOffer) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  var banner = null, shown = null;

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } }
  function cfg() { return cfgOf(lsGet(LS_CFG)); }
  function sunNow(nowMs) {
    var AT = w.NBDAutoTheme;
    try {
      if (!AT || !AT.core || typeof AT.core.sunForDate !== 'function') return null;
      var c = typeof AT.getConfig === 'function' ? AT.getConfig() : {};
      var lat = c && c.lat != null ? c.lat : AT.core.DEFAULT_LAT, lng = c && c.lng != null ? c.lng : AT.core.DEFAULT_LNG;
      return AT.core.sunForDate(new Date(nowMs), lat, lng);
    } catch (_) { return null; }
  }
  function busy() {
    return !!doc.querySelector('[aria-modal="true"]:not([hidden]), .modal-bg.open, .modal.open, .lp-bar:not([hidden])');
  }
  function decide() {
    var E = w.LayoutEngine, R = w.LayoutRegistry;
    if (!E || !R || typeof E.current !== 'function' || typeof E.surface !== 'function') return null;
    var p = typeof E.prefs === 'function' ? E.prefs() : {};
    if (!p || !p.hydrated) return null;
    var cur = E.current() || {};
    var now = Date.now();
    return offerFor({
      nowMs: now, cfg: cfg(), sun: sunNow(now), surface: E.surface(), current: cur.id, source: cur.source,
      company: p.company || {}, seen: lsGet(LS_SEEN) || {}, busy: busy(),
      surfacesOf: function (id) { var d = R.get(id); return d ? d.surfaces : null; },
    });
  }

  function hide() { if (banner) banner.hidden = true; shown = null; }
  function show(o) {
    if (!banner) {
      banner = doc.createElement('div');
      banner.className = 'lo-banner';
      banner.setAttribute('role', 'region');
      banner.setAttribute('aria-label', 'Layout suggestion');
      doc.body.appendChild(banner);
    }
    var name = NAMES[o.id] || o.id;
    var why = o.period === 'day' ? 'It\'s daytime and you\'re on your phone.' : 'It\'s evening and you\'re on a computer.';
    banner.innerHTML = '<p class="lo-msg"><strong>Switch to ' + name + '?</strong> ' + why + '</p>' +
      '<div class="lo-acts"><button type="button" class="lo-btn lo-btn-primary" data-lo="yes">Switch</button>' +
      '<button type="button" class="lo-btn" data-lo="later">Not now</button>' +
      '<button type="button" class="lo-btn lo-btn-quiet" data-lo="never">Don\'t ask again</button></div>';
    banner.hidden = false;
    shown = o;
  }
  function check() {
    var o = null;
    try { o = decide(); } catch (_) { o = null; }
    if (!o) { if (shown) hide(); return; }
    if (shown && shown.key === o.key && shown.id === o.id && banner && !banner.hidden) return;
    show(o);
  }
  function remember(key) {
    var seen = lsGet(LS_SEEN) || {};
    seen[key] = 1;
    // keep only the last few periods
    var keys = Object.keys(seen).sort();
    while (keys.length > 6) delete seen[keys.shift()];
    lsSet(LS_SEEN, seen);
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-lo]') : null;
    if (!t) return;
    var a = t.getAttribute('data-lo');
    if (a === 'yes' || a === 'later' || a === 'never') {
      ev.preventDefault();
      var o = shown;
      if (!o) { hide(); return; }
      remember(o.key);
      if (a === 'never') { var c = cfg(); c.off = true; lsSet(LS_CFG, c); paintSettings(); }
      if (a === 'yes' && w.LayoutEngine && typeof w.LayoutEngine.apply === 'function') {
        // this session only; the rep's saved layout comes back on the next visit
        w.LayoutEngine.apply(o.id, { source: 'auto' });
      }
      hide();
      return;
    }
    if (a === 'save') { ev.preventDefault(); saveSettings(); }
  });

  // ── Settings > Appearance (#layoutOfferPanel) ─────────────────────────
  function opts(sel) {
    var out = '';
    for (var h = 0; h < 24; h++) {
      var lbl = (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' am' : ' pm');
      out += '<option value="' + h + '"' + (h === sel ? ' selected' : '') + '>' + lbl + '</option>';
    }
    return out;
  }
  function paintSettings() {
    var body = doc.getElementById('layoutOfferBody');
    if (!body) return;
    var c = cfg();
    body.innerHTML =
      '<label class="lo-row"><input type="checkbox" id="loOn"' + (c.off ? '' : ' checked') + '> <span>Suggest Field App on my phone during the day, and Mission Control on a computer at night. It only asks; nothing switches by itself.</span></label>' +
      '<fieldset class="lo-hours"><legend>Daytime is</legend>' +
      '<label class="lo-row"><input type="radio" name="loHours" value="sun"' + (c.hours === 'sun' ? ' checked' : '') + '> <span>Sunrise to sunset (from Auto theme; 7 am to 7 pm until it is set up)</span></label>' +
      '<label class="lo-row"><input type="radio" name="loHours" value="fixed"' + (c.hours === 'fixed' ? ' checked' : '') + '> <span>These hours:</span></label>' +
      '<div class="lo-range"><label>From <select id="loStart" class="ui-input">' + opts(c.dayStart) + '</select></label>' +
      '<label>to <select id="loEnd" class="ui-input">' + opts(c.dayEnd) + '</select></label></div></fieldset>' +
      '<button type="button" class="btn btn-orange lo-save" data-lo="save">Save</button> <span class="lo-saved" role="status" aria-live="polite"></span>';
  }
  function saveSettings() {
    var on = doc.getElementById('loOn'), st = doc.getElementById('loStart'), en = doc.getElementById('loEnd');
    var hrs = doc.querySelector('input[name="loHours"]:checked');
    var next = cfgOf({ off: !(on && on.checked), hours: hrs ? hrs.value : 'sun', dayStart: st ? st.value : 7, dayEnd: en ? en.value : 19 });
    var said = doc.querySelector('#layoutOfferBody .lo-saved');
    var bad = st && en && Number(en.value) <= Number(st.value);
    var ok = lsSet(LS_CFG, next);
    if (said) said.textContent = !ok ? 'Could not save on this device (storage is blocked).' : bad ? 'Saved. The end hour was before the start, so 7 am to 7 pm is used.' : 'Saved on this device.';
    check();
  }

  // The automatic checks never pop the banner over a browser driven by a test
  // or a script (navigator.webdriver): an offer that depends on the clock would
  // make every automated walk and screenshot differ by time of day. A direct
  // NBDLayoutOffer.check() still runs.
  function autoCheck() {
    try { if (w.navigator && w.navigator.webdriver === true) return; } catch (_) {}
    if (!doc.hidden) check();
  }
  w.addEventListener('layoutchange', function () { setTimeout(autoCheck, 0); });
  doc.addEventListener('nbd:auto-theme', autoCheck);      // auto-theme.js's day-cycle hook
  doc.addEventListener('visibilitychange', autoCheck);
  setInterval(autoCheck, 5 * 60000);
  doc.addEventListener('click', function (ev) {
    var tab = ev.target && ev.target.closest && ev.target.closest('[data-action="settingsTab"][data-target="appearance"]');
    if (tab) setTimeout(paintSettings, 50);
  });
  var tries = 0;
  (function kick() {
    var E = w.LayoutEngine;
    paintSettings();
    if (E && E.prefs && E.prefs().hydrated) { setTimeout(autoCheck, 1500); return; }
    if (++tries < 60) setTimeout(kick, 1000);
  })();

  w.NBDLayoutOffer = { check: check, decide: decide, paintSettings: paintSettings };
})(typeof window !== 'undefined' ? window : null);
