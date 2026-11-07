/**
 * visit-recorder-menu.js - the record button's menu (window.NBDVisitRecorderMenu).
 *
 *   documentation/projects/RECORD-BUTTON-2026-11-07.md
 *
 * The round record button (#nbd-vr-fab, drawn at boot by
 * visit-recorder-launcher.js) opens this ARIA menu. It is fetched with the
 * recorder (the launcher's FILES list), never on the boot path: every item
 * needs the recorder anyway, and the dashboard's boot script budget is full.
 *
 * Items, top to bottom (the menu slides up and to the right of the button):
 *   - "Unfiled visits (n)": only when n > 0; opens the Unfiled sheet
 *   - "Recent visits": the [data-nbd-recent-visits] delegate in the launcher
 *   - "Record visit": the biggest pill, nearest the thumb; the
 *     [data-nbd-record-visit] delegate, source 'fab' as before
 * Recent and Record carry the same attributes as every other entry point, so
 * the launcher's one document click delegate handles them exactly as it
 * handled the old pill bar's buttons.
 *
 * Closing: a tap outside (on the light dim), Escape, the button again, or
 * picking an item. Opening focuses the first item; arrow keys, Home and End
 * move; Escape, the button and a pick return focus to the button. Tab closes
 * and lets focus move on.
 *
 * Long-press (2026-11-07): hold the button and release to start recording
 * straight away, skipping the menu (see "long-press" below).
 */
(function () {
  'use strict';
  if (window.NBDVisitRecorderMenu) return;

  var wrap = null;   // #nbd-vr-fab
  var btn = null;    // .nbd-vr-fabbtn
  var menu = null;   // .nbd-vr-menu
  var dim = null;    // .nbd-vr-dim

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function item(label, cls) {
    var b = el('button', 'nbd-vr-mi' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.setAttribute('tabindex', '-1');
    b.appendChild(el('span', '', label));
    return b;
  }
  function items() { return menu ? Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')) : []; }
  function isOpen() { return !!(menu && !menu.hidden); }

  function build(n) {
    menu.textContent = '';
    if (n > 0) {
      var u = item('Unfiled visits', 'is-unfiled');
      var cnt = el('span', 'nbd-vr-mi-cnt', String(n));
      cnt.setAttribute('aria-hidden', 'true');
      u.appendChild(cnt);
      u.setAttribute('aria-label', 'Unfiled visits (' + n + ')');
      u.addEventListener('click', function () {
        var L = window.NBDVisitRecorderLauncher;
        if (L && typeof L.openUnfiled === 'function') L.openUnfiled();
      });
      menu.appendChild(u);
    }
    var r = item('Recent visits');
    r.setAttribute('data-nbd-recent-visits', '');
    menu.appendChild(r);
    var rec = item('Record visit', 'is-big');
    rec.setAttribute('data-nbd-record-visit', '');
    rec.setAttribute('data-source', 'fab');
    var dot = el('span', 'nbd-vr-mi-dot');
    dot.setAttribute('aria-hidden', 'true');
    rec.insertBefore(dot, rec.firstChild);
    menu.appendChild(rec);
  }

  function open(n) {
    if (!menu) {
      menu = el('div', 'nbd-vr-menu');
      menu.id = 'nbd-vr-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Visits');
      menu.hidden = true;
      menu.addEventListener('click', onMenuClick);
      menu.addEventListener('keydown', onMenuKey);
      wrap.insertBefore(menu, btn);
      btn.setAttribute('aria-controls', menu.id);
    }
    if (!dim || !dim.isConnected) {
      dim = el('div', 'nbd-vr-dim');
      dim.setAttribute('aria-hidden', 'true');
      // closed on its CLICK, not on pointerdown: hiding it on pointerdown would
      // hand the same tap's click to whatever sits under it (a Today button)
      dim.addEventListener('click', function () { close(false); });
      document.body.insertBefore(dim, wrap);
    }
    build(n);
    menu.hidden = false;
    dim.hidden = false;
    wrap.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    var first = items()[0];
    if (first) first.focus();
    document.addEventListener('keydown', onDocKey, true);
    document.addEventListener('pointerdown', onOutside, true);
  }
  function close(refocus) {
    if (!isOpen()) return;
    menu.hidden = true;
    if (dim) dim.hidden = true;
    wrap.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onDocKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) { try { btn.focus(); } catch (_) {} }
  }

  // A pick closes the menu and hands focus back to the button. The item stays
  // in the document (hidden, not removed), so the launcher's document click
  // delegate still finds [data-nbd-record-visit] / [data-nbd-recent-visits]
  // on the way up and starts the recording or opens Recent visits.
  function onMenuClick(e) {
    var it = e.target && e.target.closest ? e.target.closest('[role="menuitem"]') : null;
    if (!it) return;
    close(true);
  }
  function onMenuKey(e) {
    var list = items();
    var i = list.indexOf(document.activeElement);
    var next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Tab') { close(false); return; }
    if (next < 0 || !list[next]) return;
    e.preventDefault();
    list[next].focus();
  }
  function onDocKey(e) {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  }
  // Outside = anything above the dim (the bottom nav, a header button): close
  // and let that tap go on. The button's own tap is left to toggle(), so it
  // closes once, not twice; the dim closes on its own click (above).
  function onOutside(e) {
    if ((wrap && wrap.contains(e.target)) || e.target === dim) return;
    close(false);
  }

  /** The record button's click: open the menu with the unfiled count, or close it. */
  function toggle(w, n) {
    if (!w) return;
    // the click that ends a long-press (below) must not also open the menu
    if (Date.now() < swallowUntil) { swallowUntil = 0; return; }
    if (wrap !== w) {
      wrap = w;
      btn = w.querySelector('.nbd-vr-fabbtn');
      menu = null;
      wireHold(btn);
    }
    if (isOpen()) close(true);
    else open(Number(n) || 0);
  }

  // ── long-press: hold to record (2026-11-07) ─────────────────────────────
  // Hold the round button HOLD_MS and it arms (a red ring and "Release to
  // record"; a short buzz where the phone supports it); let go and the
  // recording starts, skipping the menu. Recording starts on the RELEASE, a
  // real user gesture, so iPhone Safari grants the microphone the same as a
  // tap. Sliding more than MOVE_PX away, or the browser taking the touch
  // (scroll, call), cancels. A short tap still opens the menu, and the menu
  // keeps Record visit for keyboard and screen-reader users.
  // Wired from this lazy file (onto the button the boot launcher drew), so the
  // dashboard's boot script budget is untouched: until this file arrives a
  // long-press simply acts as a tap.
  var HOLD_MS = 500;
  var MOVE_PX = 12;
  var SWALLOW_MS = 800;
  var swallowUntil = 0;
  var press = null;
  function holdEnd() {
    if (!press) return;
    clearTimeout(press.t);
    if (press.wrap) press.wrap.classList.remove('is-armed');
    press = null;
  }
  function onHoldDown(e) {
    if (e.button !== 0 || isOpen()) return;
    holdEnd();
    var b = e.currentTarget;
    var w = b.parentNode;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, armed: false, wrap: w, t: 0 };
    var p = press;
    p.t = setTimeout(function () {
      if (press !== p) return;
      p.armed = true;
      w.classList.add('is-armed');
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (_) {}
    }, HOLD_MS);
  }
  function onHoldMove(e) {
    if (!press || e.pointerId !== press.id) return;
    if (Math.abs(e.clientX - press.x) > MOVE_PX || Math.abs(e.clientY - press.y) > MOVE_PX) holdEnd();
  }
  function onHoldUp(e) {
    if (!press || e.pointerId !== press.id) return;
    var armed = press.armed;
    holdEnd();
    if (!armed) return;   // a short tap: the click opens the menu as usual
    swallowUntil = Date.now() + SWALLOW_MS;
    e.preventDefault();
    var L = window.NBDVisitRecorderLauncher;
    if (L && typeof L.begin === 'function') L.begin({ source: 'fab' });
  }
  function wireHold(b) {
    if (!b || b.getAttribute('data-nbd-hold') === '1') return;
    b.setAttribute('data-nbd-hold', '1');
    b.addEventListener('pointerdown', onHoldDown);
    b.addEventListener('pointermove', onHoldMove);
    b.addEventListener('pointerup', onHoldUp);
    b.addEventListener('pointercancel', holdEnd);
    b.addEventListener('pointerleave', holdEnd);
    // Android's long-press context menu / iOS's callout would steal the hold
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  var fabEl = document.getElementById('nbd-vr-fab');
  wireHold(fabEl && fabEl.querySelector('.nbd-vr-fabbtn'));

  window.NBDVisitRecorderMenu = { toggle: toggle, close: close, isOpen: isOpen, wireHold: wireHold };
})();
