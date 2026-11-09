/**
 * os/privacy.js — NBD OS P3, the privacy lock (design §6 #11, 2026-11-09:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md). Three quick ways to
 * call the system layer's lock() (os/system.js) when a homeowner leans in; the
 * lock screen shows counts only (system-logic lockLines).
 *
 *   Laptop   a hot corner: rest the mouse in the chosen corner for 250 ms.
 *            OFF by default; the member picks top right, bottom right or bottom
 *            left in the Control Center's "Privacy lock" tile. Top left is the
 *            action runner's search corner (command-runner.js), so it is never
 *            offered here: the two can not collide. Never over a window or a
 *            control, never a touch pointer, and after a lock the pointer has
 *            to leave the corner before it can lock again.
 *   Keys     Ctrl+Alt+L (Control+Option+L on a Mac), on both surfaces: the OS
 *            desk's Ctrl+Alt family (Ctrl+Alt+O, 1-4, arrows). Not while AltGr
 *            makes a letter (Ctrl+Alt is AltGr on Windows: Polish AltGr+L
 *            types "ł"), never a bare letter (WCAG 2.1.4).
 *   Phone    double-tap an empty spot of the home screen (its pages, the Visits
 *            row beside its icons): not a widget, an icon or any control, not in edit mode, not during a drag, a
 *            swipe or a long-press. OFF by default (a pocket or a glove taps
 *            twice by accident, and nobody expects a home screen to lock on
 *            a double tap); one switch in the same tile turns it on.
 *
 * A lock never loses input: it only lays a cover over the page (windows,
 * fields and open sheets stay as they are). The lock screen says why it
 * locked, through a polite status line inside it.
 *
 * Loaded by layouts/os.js as the runtime `osprivacy` bundle with its stylesheet
 * (never a <script> tag), and only when it is wanted: at mount while a corner
 * or double tap is switched on (this device's keys), on the first Ctrl+Alt+L,
 * or when the Control Center's "Privacy lock" tile (os.js) is opened. Settings are this device's own (nbd_ localStorage). Writes no CRM
 * data, reads nothing from Firestore, no network. Every string is escaped; no
 * inline handlers or style attributes (css/os/privacy.css).
 *
 * window.NBDOSPrivacy: { attach({ surface, el, state }) -> detach, corner, dtap,
 *   lockNow(how), openSettings(), closeSettings(), hint(), _pure }
 */
(function (root) {
  'use strict';
  var prior = root && root.NBDOSPrivacy;
  if (prior && prior.__sentinel === 'nbd-os-privacy-v1' && typeof module === 'undefined') return;
  var doc = root && root.document;

  var CORNER_KEY = 'nbd_os_lock_corner_v1';
  var DTAP_KEY = 'nbd_os_lock_dtap_v1';
  var DWELL_MS = 250;
  var CORNER_PX = 2;
  var TAP_MS = 350;          // a press longer than this is not a tap (os.js long-press is 550)
  var TAP_MOVE = 10;         // px a tap may wander (os.js uses the same for its long-press)
  var DOUBLE_MS = 300;       // between the two taps
  var DOUBLE_PX = 30;        // the second tap lands near the first
  var CORNERS = ['tr', 'br', 'bl'];   // never 'tl': the action runner's corner
  var CORNER_NAMES = { tr: 'Top right', br: 'Bottom right', bl: 'Bottom left' };
  var MSG = {
    corner: 'Locked by the hot corner. Only counts are showing. Unlock to come back.',
    key: 'Locked from the keyboard. Only counts are showing. Unlock to come back.',
    dtap: 'Locked by a double tap. Only counts are showing. Unlock to come back.',
  };

  // ── PURE ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** A stored corner: one of tr / br / bl, else '' (off). Top left is the runner's: refused. */
  function normCorner(v) { return CORNERS.indexOf(String(v == null ? '' : v)) >= 0 ? String(v) : ''; }
  /** Within CORNER_PX of the chosen corner of a w x h viewport. */
  function inCorner(c, x, y, w, h) {
    x = Number(x); y = Number(y); w = Number(w); h = Number(h);
    if (!normCorner(c) || !(w > 0) || !(h > 0) || !(x >= 0) || !(y >= 0) || x > w || y > h) return false;
    var right = x >= w - 1 - CORNER_PX, bottom = y >= h - 1 - CORNER_PX;
    if (c === 'tr') return right && y <= CORNER_PX;
    if (c === 'br') return right && bottom;
    return x <= CORNER_PX && bottom;
  }
  /**
   * Ctrl+Alt+L (Control+Option+L): the physical L key (ev.code), no Shift or Meta, and not
   * AltGr writing a character into a field.
   */
  function isLockKey(ev, typing) {
    if (!ev || !ev.ctrlKey || !ev.altKey || ev.metaKey || ev.shiftKey || ev.repeat) return false;
    var code = ev.code || '', k = typeof ev.key === 'string' ? ev.key : '';
    if (code ? code !== 'KeyL' : k.toLowerCase() !== 'l') return false;
    var altGr = false;
    try { altGr = typeof ev.getModifierState === 'function' && ev.getModifierState('AltGraph') === true; } catch (e) {}
    if (altGr) return false;
    if (typing && k.length === 1 && k.toLowerCase() !== 'l') return false;   // a composed letter going into a field
    return true;
  }
  /** A press and release short and still enough to be a tap. */
  function isTap(down, up) {
    if (!down || !up) return false;
    var dt = up.t - down.t;
    return dt >= 0 && dt <= TAP_MS && Math.abs(up.x - down.x) + Math.abs(up.y - down.y) <= TAP_MOVE;
  }
  /** The second of two taps, soon after and near the first. */
  function isDouble(prev, tap) {
    if (!prev || !tap) return false;
    var dt = tap.t - prev.t;
    return dt > 0 && dt <= DOUBLE_MS && Math.abs(tap.x - prev.x) + Math.abs(tap.y - prev.y) <= DOUBLE_PX;
  }
  // a widget, an icon, a control, the edit bar, a sheet: none of them is empty space
  var TAP_BLOCK = '.os-hw, .os-widget, .os-hw-add, .os-p-icon, .os-p-dots, .os-p-edit, .os-hw-team, .os-act-row, ' +
    '[data-osp], [data-osvisit], button, a, input, textarea, select, label, summary, [contenteditable], [role="dialog"], dialog';
  /**
   * A press on the home screen's own background inside this phone home (os.js): the pages
   * (`.os-p-pages`), the Visits row beside its icons (`.os-p-visits`), or the home itself.
   */
  function isEmptyHome(t, home) {
    if (!t || !home || !home.contains || !home.contains(t) || !t.closest) return false;
    if (t !== home && !t.closest('.os-p-pages, .os-p-visits')) return false;
    return !t.closest(TAP_BLOCK);
  }
  // the runner's rule: resting on a window or a control in the corner (a maximized window's buttons) is not a lock
  var CORNER_BLOCK = '.os-win, button, a, input, textarea, select, [contenteditable], dialog';

  // ── settings (this device; read once, then cached: the corner is checked on mouse moves) ──
  function ls(k, v) {
    try {
      var s = root && root.localStorage;
      if (!s) return null;
      if (v === undefined) return s.getItem(k);
      if (v === null) s.removeItem(k); else s.setItem(k, v);
    } catch (e) {}
    return null;
  }
  var watch = [];
  function changed() { watch.slice().forEach(function (f) { try { f(); } catch (e) {} }); }
  var cornerVal = null, dtapVal = null;
  var corner = {
    get: function () { if (cornerVal === null) cornerVal = normCorner(ls(CORNER_KEY)); return cornerVal; },
    set: function (c) { cornerVal = normCorner(c); ls(CORNER_KEY, cornerVal || null); changed(); },
  };
  var dtap = {
    on: function () { if (dtapVal === null) dtapVal = ls(DTAP_KEY) === '1'; return dtapVal; },
    set: function (on) { dtapVal = !!on; ls(DTAP_KEY, on ? '1' : null); changed(); },
  };
  if (root && typeof root.addEventListener === 'function') {
    try {
      root.addEventListener('storage', function (e) {
        if (e && e.key === CORNER_KEY) { cornerVal = null; changed(); }
        else if (e && e.key === DTAP_KEY) { dtapVal = null; changed(); }
      });
    } catch (e) {}
  }

  // ── the lock ─────────────────────────────────────────────────────────
  var setT = function (f, ms) { return (root.setTimeout || setTimeout)(f, ms); };
  var clrT = function (t) { return (root.clearTimeout || clearTimeout)(t); };
  function sys() { var O = root && root.NBDOS; return O && typeof O.lock === 'function' ? O : null; }
  function locked() { var O = sys(); try { return !!(O && typeof O.isLocked === 'function' && O.isLocked()); } catch (e) { return false; } }
  /**
   * Lock through the system layer and say why, from inside the lock screen (everything
   * else leaves the accessibility tree while locked). The line is added empty and filled
   * a moment later, so a screen reader hears it as a change.
   */
  function lockNow(how) {
    var O = sys();
    if (!O || locked()) return false;
    try { O.lock(); } catch (e) { return false; }
    var lk = doc && doc.getElementById('osLock');
    var msg = MSG[how];
    if (lk && msg) {
      var p = doc.createElement('p');
      p.className = 'os-pv-sr';
      p.setAttribute('role', 'status');
      p.setAttribute('aria-live', 'polite');
      lk.appendChild(p);
      setT(function () { p.textContent = msg; }, 150);
    }
    return true;
  }

  // ── the settings sheet (the Control Center's "Privacy lock" tile) ───
  var surfaceNow = 'desk';
  var isMac = !!(root && root.navigator && /Mac/i.test(String(root.navigator.platform || root.navigator.userAgent || '')));
  function keyName() { return isMac ? 'Control+Option+L' : 'Ctrl+Alt+L'; }
  function sheetHtml() {
    var c = corner.get();
    var h = '<form method="dialog" class="os-pv-form">' +
      '<div class="os-pv-hd"><h2 class="os-pv-title">Privacy lock</h2></div>' +
      '<p class="os-pv-note">Locking hides names and money until you unlock. Nothing you were typing is lost.</p>';
    if (surfaceNow === 'phone') {
      h += '<label class="os-pv-opt"><input type="checkbox" class="os-pv-box" data-pv="dtap"' + (dtap.on() ? ' checked' : '') + '>' +
        '<span class="os-pv-txt"><span class="os-pv-name">Double-tap to lock</span>' +
        '<span class="os-pv-sub">Double-tap an empty spot on the home screen. Off by default.</span></span></label>';
    } else {
      h += '<fieldset class="os-pv-set"><legend class="os-pv-legend">Hot corner: rest the pointer there to lock</legend>' +
        [''].concat(CORNERS).map(function (k) {
          return '<label class="os-pv-opt"><input type="radio" class="os-pv-radio" name="os-pv-corner" data-pv="corner" value="' + esc(k) + '"' + (c === k ? ' checked' : '') + '>' +
            '<span class="os-pv-name">' + esc(k ? CORNER_NAMES[k] : 'Off') + '</span></label>';
        }).join('') +
        '</fieldset><p class="os-pv-note os-pv-muted">Top left is the search corner, so it is not offered here.</p>';
    }
    if (surfaceNow !== 'phone') h += '<p class="os-pv-note os-pv-muted">' + esc(keyName()) + ' locks any time.</p>';
    h += '<p class="os-pv-msg" role="status"></p>' +
      '<div class="os-pv-ft"><button type="submit" class="btn btn-orange os-pv-done" value="done">Done</button></div></form>';
    return h;
  }
  var sheet = null;
  function closeSettings() {
    var d = sheet;
    sheet = null;
    if (!d) return;
    try { if (d.open && typeof d.close === 'function') d.close(); } catch (e) {}
    if (d.parentNode) d.parentNode.removeChild(d);
  }
  function onSheetChange(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var what = t.getAttribute('data-pv'), say = '';
    if (what === 'corner') { corner.set(t.value); say = corner.get() ? 'Hot corner: ' + CORNER_NAMES[corner.get()].toLowerCase() + '.' : 'Hot corner is off.'; }
    else if (what === 'dtap') { dtap.set(!!t.checked); say = dtap.on() ? 'Double-tap to lock is on.' : 'Double-tap to lock is off.'; }
    else return;
    var m = sheet && sheet.querySelector('.os-pv-msg');
    if (m) m.textContent = say;
  }
  function openSettings() {
    if (!doc || sheet) return;
    var d = doc.createElement('dialog');
    d.className = 'os-pv';
    d.setAttribute('aria-label', 'Privacy lock');
    d.innerHTML = sheetHtml();
    d.addEventListener('change', onSheetChange);
    d.addEventListener('close', function () { if (sheet === d) closeSettings(); else if (d.parentNode) d.parentNode.removeChild(d); });
    doc.body.appendChild(d);
    sheet = d;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var first = d.querySelector('input:checked') || d.querySelector('input');
    if (first && typeof first.focus === 'function') first.focus();
  }
  function hint() {
    if (surfaceNow === 'phone') return dtap.on() ? 'Double-tap: on' : keyName();
    var c = corner.get();
    return c ? 'Corner: ' + CORNER_NAMES[c].toLowerCase() : keyName();
  }

  // ── attach to the NBD OS desk or phone home ─────────────────────────
  function typingIn(t) {
    var tag = (t && t.tagName) || '';
    return /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || !!(t && t.isContentEditable);
  }
  /**
   * opts: surface ('phone' | 'desktop'), el (#osDesk / #osPhone), state (() => the layout's S,
   * for its edit mode, open app, switcher and drags). Returns the detach function.
   */
  function attach(opts) {
    var o = opts || {};
    var el = o.el;
    if (!doc || !el) return function () {};
    var phone = o.surface === 'phone';
    surfaceNow = phone ? 'phone' : 'desk';
    var S = typeof o.state === 'function' ? o.state : function () { return null; };
    var st = { t: 0, out: true, down: null, last: null, moveOn: false, tapOn: false, off: false };

    function onKey(ev) {
      if (!isLockKey(ev, typingIn(ev.target)) || !sys() || locked()) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      lockNow('key');
    }

    // laptop: the hot corner
    function clear() { if (st.t) { clrT(st.t); st.t = 0; } }
    function onMove(ev) {
      var c = corner.get();
      if (!c || locked() || (ev.pointerType && ev.pointerType !== 'mouse') || ev.buttons) return clear();
      if (!inCorner(c, ev.clientX, ev.clientY, root.innerWidth, root.innerHeight)) { st.out = true; return clear(); }
      if (!st.out) return;   // locked from here: leave the corner first
      var t = ev.target;
      if (t && t.closest && t.closest(CORNER_BLOCK)) return clear();
      if (st.t) return;
      st.t = setT(function () {
        st.t = 0;
        if (st.off || !el.isConnected || corner.get() !== c) return;
        if (lockNow('corner')) st.out = false;
      }, DWELL_MS);
    }

    // phone: double-tap an empty spot of the home screen
    function busy() {
      var s = S();
      if (!s) return true;
      var homeEditing = false;
      try { homeEditing = !!(s.home && typeof s.home.editing === 'function' && s.home.editing()); } catch (e) {}
      return !!(s.editing || homeEditing || s.phoneOpen || s.switcherEl || s.iconDrag || s.drag || (s.press && s.press.fired));
    }
    function pt(ev) { return { x: Number(ev.clientX) || 0, y: Number(ev.clientY) || 0, t: Number(ev.timeStamp) || Date.now() }; }
    function onDown(ev) {
      if (ev.isPrimary === false) { st.down = null; st.last = null; return; }   // a second finger: a pinch, not a tap
      st.down = (ev.button == null || ev.button === 0) && isEmptyHome(ev.target, el) && !busy() ? pt(ev) : null;
      if (!st.down) st.last = null;
    }
    function onUp(ev) {
      var d = st.down;
      st.down = null;
      if (!d || ev.isPrimary === false) return;
      var tap = pt(ev);
      if (!isTap(d, tap) || !isEmptyHome(ev.target, el) || busy()) { st.last = null; return; }
      if (isDouble(st.last, tap)) {
        st.last = null;
        if (dtap.on() && lockNow('dtap')) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          swallowClick();
        }
        return;
      }
      st.last = tap;
    }
    function onCancel() { st.down = null; st.last = null; }
    // the second tap's click lands on the lock screen that just opened under the finger:
    // it must not press Unlock (centred on a phone) and undo the lock at once
    function swallowClick() {
      var until = Date.now() + 600;
      function eat(e) {
        doc.removeEventListener('click', eat, true);
        if (Date.now() > until) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
      }
      doc.addEventListener('click', eat, true);
      setT(function () { doc.removeEventListener('click', eat, true); }, 700);
    }

    function sync() {
      if (st.off) return;
      if (!phone) {
        var want = !!corner.get();
        st.out = true;   // a new corner (or none): nothing to leave first
        if (want && !st.moveOn) { st.moveOn = true; doc.addEventListener('pointermove', onMove, { passive: true }); }
        else if (!want && st.moveOn) { st.moveOn = false; doc.removeEventListener('pointermove', onMove, { passive: true }); clear(); }
      } else {
        var on = dtap.on();
        if (on && !st.tapOn) {
          st.tapOn = true;
          el.addEventListener('pointerdown', onDown);
          el.addEventListener('pointerup', onUp);
          el.addEventListener('pointercancel', onCancel);
        } else if (!on && st.tapOn) {
          st.tapOn = false;
          el.removeEventListener('pointerdown', onDown);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onCancel);
          onCancel();
        }
        // no double-tap zoom on the pages while it is on (css: touch-action manipulation)
        if (doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.toggle('os-dtap', on);
      }
      var O = root.NBDOS;
      if (O && typeof O.refresh === 'function') { try { O.refresh(); } catch (e) {} }   // the Control Center tile's hint
    }

    doc.addEventListener('keydown', onKey, true);
    watch.push(sync);
    sync();

    return function detach() {
      if (st.off) return;
      watch = watch.filter(function (f) { return f !== sync; });
      if (st.moveOn) doc.removeEventListener('pointermove', onMove, { passive: true });
      if (st.tapOn) {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onCancel);
      }
      st.off = true;
      clear();
      doc.removeEventListener('keydown', onKey, true);
      if (doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.remove('os-dtap');
      closeSettings();
    };
  }

  var api = {
    __sentinel: 'nbd-os-privacy-v1',
    attach: attach, corner: corner, dtap: dtap, lockNow: lockNow, openSettings: openSettings, closeSettings: closeSettings, hint: hint,
    _pure: {
      esc: esc, normCorner: normCorner, inCorner: inCorner, isLockKey: isLockKey, isTap: isTap, isDouble: isDouble, isEmptyHome: isEmptyHome,
      CORNER_KEY: CORNER_KEY, DTAP_KEY: DTAP_KEY, DWELL_MS: DWELL_MS, CORNERS: CORNERS, MSG: MSG,
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSPrivacy = api;
})(typeof window !== 'undefined' ? window : null);
