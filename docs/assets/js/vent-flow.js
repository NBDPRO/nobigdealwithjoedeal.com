/**
 * vent-flow.js — the attic airflow animation on /guides/how-a-roof-works
 * (2026-10-16). The arrows are static in the markup; this adds the moving
 * dashes only while the figure is on screen, never under
 * prefers-reduced-motion, and always with a Pause button (WCAG 2.2.2).
 * CSP: external file, no inline handlers.
 */
(function () {
  'use strict';
  var root = document.querySelector('[data-vent-flow]');
  if (!root) return;
  var btn = root.querySelector('[data-vx-toggle]');
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (!btn || (mq && mq.matches)) return;    // reduced motion: static arrows only
  var paused = false, visible = false;
  function apply() { root.classList.toggle('is-animating', visible && !paused); }
  btn.hidden = false;
  btn.addEventListener('click', function () {
    paused = !paused;
    btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
    btn.textContent = paused ? 'Play the airflow' : 'Pause the airflow';
    apply();
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      apply();
    }, { threshold: 0.2 }).observe(root);
  } else { visible = true; apply(); }
  if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { if (e.matches) { paused = true; btn.hidden = true; apply(); } });
})();
