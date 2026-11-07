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
    if (wrap !== w) {
      wrap = w;
      btn = w.querySelector('.nbd-vr-fabbtn');
      menu = null;
    }
    if (isOpen()) close(true);
    else open(Number(n) || 0);
  }

  window.NBDVisitRecorderMenu = { toggle: toggle, close: close, isOpen: isOpen };
})();
