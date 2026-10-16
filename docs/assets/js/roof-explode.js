/**
 * roof-explode.js — "Pull the roof apart" on /guides/how-a-roof-works
 * (2026-10-16). The inline SVG (stamped by scripts/build-illustrations.mjs)
 * ships already pulled apart: each layer group carries a transform attribute,
 * so with no JS, or with prefers-reduced-motion, visitors see the static
 * exploded view. With motion allowed, the layers start together and pull
 * apart as the figure scrolls into view, until the visitor touches the
 * slider; from then on the slider alone drives it.
 *
 * Keyboard: the range input and the legend buttons are native controls.
 * Pointer: tapping a layer in the drawing selects it like its button.
 * CSP: external file, no inline handlers, styles only through the CSSOM.
 */
(function () {
  'use strict';
  var root = document.querySelector('[data-roof-explode]');
  if (!root) return;
  var svg = root.querySelector('svg.rx-svg');
  var range = root.querySelector('[data-rx-range]');
  if (!svg || !range) return;
  var lift = parseFloat(svg.getAttribute('data-rx-lift')) || 24;
  var layers = Array.prototype.slice.call(svg.querySelectorAll('.rx-layer'));
  var buttons = Array.prototype.slice.call(root.querySelectorAll('[data-rx-layer]'));
  var title = root.querySelector('[data-rx-info-title]');
  var text = root.querySelector('[data-rx-info-text]');
  // layer groups and their number tags (drawn on top) move together
  var moving = Array.prototype.slice.call(svg.querySelectorAll('.rx-layer, .rx-tag'));
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduce = !!(mq && mq.matches);

  function valueText(v) {
    if (v <= 3) return 'Put together';
    if (v >= 97) return 'Pulled apart';
    return Math.round(v) + ' percent pulled apart';
  }
  function set(v) {
    var f = Math.max(0, Math.min(100, v)) / 100;
    moving.forEach(function (g) {
      var i = parseFloat(g.getAttribute('data-i')) || 0;
      g.style.transform = 'translate(0px, ' + (-i * lift * f).toFixed(1) + 'px)';
    });
    range.value = String(Math.round(v));
    range.setAttribute('aria-valuetext', valueText(v));
  }

  function select(key) {
    var btn = null;
    buttons.forEach(function (b) {
      var on = b.getAttribute('data-rx-layer') === key && b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) btn = b;
    });
    moving.forEach(function (g) { g.classList.toggle('is-sel', !!btn && g.getAttribute('data-layer') === key); });
    svg.classList.toggle('has-sel', !!btn);
    if (btn) {
      title.textContent = btn.getAttribute('data-rx-name');
      text.textContent = btn.getAttribute('data-rx-text');
    } else {
      title.textContent = 'Tap a layer';
      text.textContent = 'Pick any layer to see what it does. Drag the slider to put the roof back together or pull it apart.';
    }
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () { select(b.getAttribute('data-rx-layer')); });
  });
  moving.forEach(function (g) {
    g.addEventListener('click', function () { select(g.getAttribute('data-layer')); });
  });

  var touched = false;
  range.addEventListener('input', function () { touched = true; set(parseFloat(range.value)); });

  if (reduce) { set(100); return; }          // static exploded view, no scroll link

  root.classList.add('rx-anim');
  var ticking = false;
  function fromScroll() {
    ticking = false;
    if (touched) return;
    var r = root.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    // together when the figure's top enters the bottom of the screen,
    // fully apart once it has risen ~60% of the screen height
    var p = (vh - r.top) / (vh * 0.6);
    set(Math.max(0, Math.min(1, p)) * 100);
  }
  function onScroll() { if (!ticking) { ticking = true; window.requestAnimationFrame(fromScroll); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  fromScroll();
  if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { if (e.matches) { touched = true; root.classList.remove('rx-anim'); set(100); } });
})();
