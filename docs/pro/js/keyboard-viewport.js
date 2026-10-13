/**
 * keyboard-viewport.js — keeps an open sheet above the iPhone keyboard
 * (2026-10-08, phone audit 2026-10-07 #2).
 *
 * iOS does not shrink the layout viewport when the keyboard opens: a
 * position:fixed sheet stays sized to the whole screen and its bottom third
 * (Record payment's "Save payment") sits under the keyboard. Jo had to
 * dismiss the keyboard, then scroll, to reach Save.
 *
 * The visual viewport DOES shrink. While the keyboard is up this sets
 *   <html class="nbd-kb-open">   --nbd-vv-h   --nbd-vv-top
 * and mobile-polish.css fits every open .modal-bg (and its card) to that
 * visible area, so the card's own scroll — and the sticky Save in
 * invoice-pipeline.css — end at the top of the keyboard. The focused field
 * is kept in view. Nothing changes while the keyboard is down, and desktop
 * never sees the class (no keyboard → no shrink).
 *
 * compute() is pure (tests/phone-quick-wins-2026-10-08.test.js).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDKeyboardViewport) return;
  var w = window, doc = document;
  // A keyboard is ~260-340px; browser chrome collapsing is under ~90px.
  var MIN_KEYBOARD_PX = 120;

  function compute(innerHeight, vv) {
    if (!vv || !(innerHeight > 0) || !(vv.height > 0)) return { open: false, h: 0, top: 0 };
    var h = Math.round(vv.height);
    var top = Math.max(0, Math.round(Number(vv.offsetTop) || 0));
    return { open: innerHeight - h > MIN_KEYBOARD_PX, h: h, top: top };
  }

  var last = '';
  var raf = 0;
  function keepFocusedInView() {
    var a = doc.activeElement;
    if (!a || !a.closest || !a.closest('.modal-bg.open') || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    setTimeout(function () {
      try { a.scrollIntoView({ block: 'nearest' }); } catch (_) { /* old engine */ }
    }, 60);
  }
  function apply() {
    raf = 0;
    var s = compute(w.innerHeight, w.visualViewport);
    var key = s.open ? s.h + ':' + s.top : '';
    if (key === last) return;
    last = key;
    var root = doc.documentElement;
    if (s.open) {
      root.style.setProperty('--nbd-vv-h', s.h + 'px');
      root.style.setProperty('--nbd-vv-top', s.top + 'px');
      root.classList.add('nbd-kb-open');
      keepFocusedInView();
    } else {
      root.classList.remove('nbd-kb-open');
      root.style.removeProperty('--nbd-vv-h');
      root.style.removeProperty('--nbd-vv-top');
    }
  }
  function schedule() {
    if (raf) return;
    raf = (w.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(apply);
  }

  if (w.visualViewport && typeof w.visualViewport.addEventListener === 'function') {
    w.visualViewport.addEventListener('resize', schedule);
    w.visualViewport.addEventListener('scroll', schedule);
  }
  doc.addEventListener('focusin', schedule);
  doc.addEventListener('focusout', function () { setTimeout(schedule, 120); });

  w.NBDKeyboardViewport = { compute: compute, apply: apply, MIN_KEYBOARD_PX: MIN_KEYBOARD_PX };
})();
