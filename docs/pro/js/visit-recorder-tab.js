/**
 * visit-recorder-tab.js - the Record visit tab in the phone's bottom nav.
 *
 * Phone sweep 2026-11-19 (documentation/qa/phone-layout-sweep-2026-11-19): the round Record visit
 * button floated over lead cards and the Call row. Jo's call: Record visit is a primary field action,
 * so it gets a slot in the bottom nav, in the place of Ask Joe (which stays in More and the command
 * palette), and the round button goes away.
 *
 * Shipped dark behind the feature flag recordVisitTab: dark-features.js fetches this file only when the
 * flag is on, so with the flag off nothing here is downloaded and nothing changes (the dashboard's boot
 * script budget stays untouched). Flip it per account in feature_flags/{uid}, widen with
 * feature_flags/_default.
 *
 * What it does (visit-recorder-launcher.js still owns the recorder, the round button and the menu):
 *   - Draws the tab in Ask Joe's slot, but ONLY for a rep who never saved a bar of their own
 *     (localStorage nbd_mobile_tabs). A saved bar is never touched, and that rep keeps the round button.
 *     Redraws after mobile-nav-customizer.js repaints the bar (it replaces #mobile-nav's children).
 *   - Puts html.nbd-vr-tab on while the tab is there: visit-recorder.css then draws the round button
 *     invisible on a phone (its wrapper stays to anchor the menu) and Home stops reserving its room.
 *   - Tap: the same menu the round button opened (Unfiled visits, Recent visits, Record visit), rising
 *     over the tab. Hold 0.5 s and let go: records straight away. While a visit is recording, a tap
 *     brings back the live panel (launcher begin() does that).
 *   - The red unfiled-count badge, and a red pulsing dot while a visit is recording.
 */
(function () {
  'use strict';
  // belt and braces: dark-features.js only fetches this file with the flag on, but the file checks too
  var FLAG = 'recordVisitTab';
  var F = window.NBDFlags;
  if (!(F && typeof F.enabled === 'function' && F.enabled(FLAG))) return;
  var LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (LOADED['visit-recorder-tab']) return;
  LOADED['visit-recorder-tab'] = true;

  var BAR_KEY = 'nbd_mobile_tabs';      // mobile-nav-customizer.js: set only once a rep saves a bar
  var UNFILED_KEY = 'nbd_vr_unfiled';   // visit-recorder-launcher.js: the unfiled count
  var HOLD_MS = 500, MOVE_PX = 12, SWALLOW_MS = 800;
  var hold = null, swallowUntil = 0, subscribed = false;

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function hasSavedBar() { return !!lsGet(BAR_KEY); }
  function recording() {
    try { return !!window.NBDVisitRecorder.getState().active; } catch (_) { return false; }
  }
  function tabEl() { return document.getElementById('mni-record'); }

  function build() {
    var d = document.createElement('div');
    d.className = 'mn-item';
    d.id = 'mni-record';
    d.setAttribute('role', 'button');
    d.setAttribute('aria-haspopup', 'menu');
    var icon = span('mn-icon', d);
    span('mn-recdot', icon).setAttribute('aria-hidden', 'true');
    span('mn-lbl', d).textContent = 'Record';
    var b = span('mn-badge', d);
    b.id = 'mni-record-badge';
    b.style.display = 'none';
    return d;
  }
  function span(cls, parent) {
    var s = document.createElement('span');
    s.className = cls;
    return parent.appendChild(s);
  }

  function paint() {
    var tab = tabEl();
    if (!tab) return;
    var n = parseInt(lsGet(UNFILED_KEY) || '0', 10) || 0;
    var b = document.getElementById('mni-record-badge');
    if (b) { b.textContent = n; b.style.display = n > 0 ? '' : 'none'; }
    var rec = recording();
    tab.classList.toggle('is-recording', rec);
    tab.setAttribute('aria-label', rec ? 'Recording a visit' : n > 0 ? 'Record visit, ' + n + ' unfiled' : 'Record visit');
  }

  // The recorder loads lazily after sign-in (launcher bootRecorder); follow it once it is there.
  function follow() {
    var R = window.NBDVisitRecorder;
    if (subscribed || !R || typeof R.subscribe !== 'function') return;
    subscribed = true;
    R.subscribe(function (k) { if (k === 'counters' || k === 'state') paint(); });
    paint();
  }

  function apply() {
    var nav = document.getElementById('mobile-nav');
    if (!nav) return;
    var tab = tabEl();
    if (!tab && !hasSavedBar()) {
      var joe = document.getElementById('mni-joe');
      if (joe) { tab = build(); joe.parentNode.replaceChild(tab, joe); }
    }
    document.documentElement.classList.toggle('nbd-vr-tab', !!tab);
    if (!tab) { var bar = document.getElementById('nbd-vr-fab'); if (bar) bar.style.left = ''; }
    paint();
    follow();
  }

  function holdEnd() {
    if (!hold) return;
    clearTimeout(hold.t);
    hold.el.classList.remove('is-armed');
    hold = null;
  }
  function onDown(e) {
    var t = e.target && e.target.closest ? e.target.closest('#mni-record') : null;
    if (!t || e.button !== 0) return;
    holdEnd();
    var h = hold = { el: t, x: e.clientX, y: e.clientY, armed: false, t: 0 };
    h.t = setTimeout(function () {
      if (hold !== h) return;
      h.armed = true;
      t.classList.add('is-armed');
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (_) {}
    }, HOLD_MS);
  }
  function onMove(e) {
    if (hold && (Math.abs(e.clientX - hold.x) > MOVE_PX || Math.abs(e.clientY - hold.y) > MOVE_PX)) holdEnd();
  }
  function onUp(e) {
    var h = hold;
    if (!h) return;
    var armed = h.armed;
    holdEnd();
    if (!armed) return;   // a short tap: the click below opens the menu
    swallowUntil = Date.now() + SWALLOW_MS;
    e.preventDefault();
    var L = window.NBDVisitRecorderLauncher;
    if (L && typeof L.begin === 'function') L.begin({ source: 'fab' });
  }
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('#mni-record') : null;
    if (!t) return;
    e.preventDefault();
    if (Date.now() < swallowUntil) return;
    var L = window.NBDVisitRecorderLauncher;
    if (!L || typeof L.begin !== 'function') return;
    var bar = document.getElementById('nbd-vr-fab');
    var btn = bar && bar.querySelector('.nbd-vr-fabbtn');
    // recording, or the menu's anchor is not there yet: begin() starts (or brings back) the recording
    if (recording() || !btn || bar.hidden) { L.begin({ source: 'fab' }); return; }
    var r = t.getBoundingClientRect();
    bar.style.left = Math.max(8, Math.round(r.left + r.width / 2 - 28)) + 'px';
    btn.click();
  }

  document.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', holdEnd);
  window.addEventListener('storage', function (e) { if (e.key === UNFILED_KEY) paint(); });

  var nav = document.getElementById('mobile-nav');
  if (nav && typeof MutationObserver === 'function') new MutationObserver(apply).observe(nav, { childList: true });
  apply();
  // the recorder arrives after sign-in: look for it until it does (no more than a minute)
  var tries = 0;
  var iv = setInterval(function () { follow(); if (subscribed || ++tries > 60) clearInterval(iv); }, 1000);
})();
