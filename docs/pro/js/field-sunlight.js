/**
 * field-sunlight.js — window.NBDFieldSunlight: Sunlight mode in EVERY layout
 * (Grabber idea #12, "Field Sunlight Mode"; the Field App already had its own
 * Sun toggle scoped to that one layout).
 *
 * Comfort > Sunlight: Off (default) / On / Auto.
 *   - On    adds <html class="sun-all">: pure black on white, heavy borders,
 *           css/field-sunlight.css. Colour tokens only, so taking it off
 *           brings the rep's theme straight back.
 *   - Auto  turns it on while the phone is within 150 m of a customer's
 *           address and off again once it is more than 250 m away (the gap
 *           stops it flapping at the edge). It runs its OWN geofence with the
 *           same thresholds and privacy rules as auto-theme.js's
 *           refreshJobSite (that one only runs when the Auto theme "at a
 *           customer" box is ticked, so Sunlight cannot depend on it, and it
 *           is not a registerRule theme rule): lead coordinates from
 *           window._leads, location only if the browser ALREADY granted it,
 *           never a prompt from a timer, nothing stored or logged.
 *           FAILS CLOSED: permission revoked turns it off at once; a fix that
 *           errors or times out turns it off after MISS_LIMIT polls in a row.
 *
 * The preference is a device key (nbd_sunlight: 'off' | 'on' | 'auto') kept
 * across sign-out like nbd_field_sun. 'on' is stamped before first paint by
 * shape-preboot.js. Auto starts the page off and turns on after a fix.
 * Default is Off, so shipping this changes nothing until someone opts in.
 *
 * Pure rules live in NBDFieldSunlight.core and are tested in a vm sandbox
 * (tests/field-sunlight-2026-10-19.test.js).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var W = window, doc = W.document;

  var KEY = 'nbd_sunlight';
  var MODES = ['off', 'on', 'auto'];
  var ENTER_M = 150, LEAVE_M = 250;
  var POLL_MS = 90000;
  var MISS_LIMIT = 2;        // consecutive polls without a fix before Auto lets go
  var RAD = Math.PI / 180;

  // ── pure rules ───────────────────────────────────────────────────────
  function normalizeMode(v) { return MODES.indexOf(v) >= 0 ? v : 'off'; }

  function metersBetween(a, b) {
    var dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** Nearest lead with real coordinates, in metres (Infinity when none). */
  function nearestMeters(here, leads) {
    var best = Infinity;
    for (var i = 0; i < (leads || []).length; i++) {
      var L = leads[i];
      if (!L) continue;
      var la = Number(L.lat), ln = Number(L.lng);
      if (!isFinite(la) || !isFinite(ln) || (!la && !ln)) continue;
      var d = metersBetween(here, [la, ln]);
      if (d < best) best = d;
    }
    return best;
  }

  /** Hysteresis: enter inside 150 m, only leave beyond 250 m. */
  function nextOnSite(prev, meters) {
    if (!isFinite(meters)) return false;
    return prev ? meters <= LEAVE_M : meters <= ENTER_M;
  }

  function shouldBeOn(mode, onSite) {
    mode = normalizeMode(mode);
    return mode === 'on' || (mode === 'auto' && onSite === true);
  }

  var core = {
    KEY: KEY, MODES: MODES, ENTER_M: ENTER_M, LEAVE_M: LEAVE_M,
    normalizeMode: normalizeMode, metersBetween: metersBetween,
    nearestMeters: nearestMeters, nextOnSite: nextOnSite, shouldBeOn: shouldBeOn
  };

  // ── glue ─────────────────────────────────────────────────────────────
  var mode = 'off', onSite = false, timer = null, misses = 0;

  function lsGet() { try { return W.localStorage.getItem(KEY); } catch (e) { return null; } }
  function lsSet(v) { try { W.localStorage.setItem(KEY, v); } catch (e) {} }

  function paint() {
    var on = shouldBeOn(mode, onSite);
    doc.documentElement.classList.toggle('sun-all', on);
    var sel = doc.getElementById('npm-sunlight');
    if (sel && sel.value !== mode) sel.value = mode;
    var hint = doc.getElementById('npm-sunlight-hint');
    if (hint) {
      hint.textContent = mode === 'auto'
        ? (on ? 'On now: you are at a customer\'s address.' : 'Turns on by itself at a customer\'s address. Needs location already allowed for this site.')
        : 'Black on white, heavy outlines, for the roof in direct sun. Your theme comes back when it is off.';
    }
    try { doc.dispatchEvent(new CustomEvent('nbd:sunlight', { detail: { on: on, mode: mode } })); } catch (e) {}
  }

  function poll() {
    if (mode !== 'auto' || doc.hidden) return;
    var nav = W.navigator;
    if (!nav || !nav.geolocation || !nav.permissions || !nav.permissions.query) return;
    // Fail closed: "no answer" must never leave Sunlight stuck on after the rep
    // has left the address (and the hint claiming they are still there).
    function drop() { misses = 0; if (onSite) { onSite = false; paint(); } }
    function miss() { misses++; if (misses >= MISS_LIMIT) drop(); }
    nav.permissions.query({ name: 'geolocation' }).then(function (st) {
      if (st.state !== 'granted') { drop(); return; }   // never prompt from a timer
      nav.geolocation.getCurrentPosition(function (pos) {
        misses = 0;
        var m = nearestMeters([pos.coords.latitude, pos.coords.longitude], W._leads || []);
        var next = nextOnSite(onSite, m);
        if (next !== onSite) { onSite = next; paint(); }
      }, miss, { maximumAge: 60000, timeout: 8000 });
    }).catch(miss);
  }

  function schedule() {
    if (timer) { W.clearInterval(timer); timer = null; }
    if (mode === 'auto') { timer = W.setInterval(poll, POLL_MS); poll(); }
  }

  function setMode(next) {
    mode = normalizeMode(next);
    lsSet(mode);
    if (mode !== 'auto') onSite = false;
    misses = 0;
    paint();
    schedule();
  }

  function init() {
    mode = normalizeMode(lsGet());
    paint();
    schedule();
    doc.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.id === 'npm-sunlight') setMode(t.value);
    });
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) poll(); });
  }

  W.NBDFieldSunlight = { core: core, setMode: setMode, getMode: function () { return mode; }, isOn: function () { return shouldBeOn(mode, onSite); }, _poll: poll };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
