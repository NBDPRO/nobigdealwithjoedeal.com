/**
 * before-after.js — turns each generated before/after pair into a slider.
 *
 * Markup comes from scripts/lib/before-after.mjs (via build-projects.mjs):
 *   <figure class="bac" data-bac data-before="Before" data-after="After">
 *     <div class="bac-frame">
 *       <div class="bac-img bac-before">…before photo + label…</div>
 *       <div class="bac-img bac-after">…after photo + label…</div>
 *     </div>
 *     <figcaption>…</figcaption>
 *   </figure>
 *
 * With JS off the pair stays two labelled photos side by side, which is a
 * complete, accessible comparison on its own. Here we add a native
 * <input type="range"> over the frame (keyboard: arrows, Home/End, PageUp/
 * PageDown; screen readers announce its label and value text) and move the
 * split with a CSS custom property set through the CSSOM, which the strict
 * CSP allows. Nothing animates on its own, so prefers-reduced-motion has
 * nothing to stop. No dependencies, no network.
 */
(function () {
  'use strict';
  var figs = document.querySelectorAll('figure[data-bac]');
  if (!figs.length) return;
  document.documentElement.classList.add('bac-js');

  Array.prototype.forEach.call(figs, function (fig, i) {
    var frame = fig.querySelector('.bac-frame');
    if (!frame || fig.classList.contains('bac-on')) return;
    var before = fig.getAttribute('data-before') || 'Before';
    var after = fig.getAttribute('data-after') || 'After';
    var cap = fig.querySelector('.bac-cap strong');
    var what = cap ? cap.textContent.trim() : '';

    var input = document.createElement('input');
    input.type = 'range';
    input.className = 'bac-range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = '50';
    input.id = 'bac-range-' + i;
    input.setAttribute('aria-label', 'Compare ' + before.toLowerCase() + ' and ' + after.toLowerCase() + ' photos' + (what ? ': ' + what : ''));

    var handle = document.createElement('span');
    handle.className = 'bac-handle';
    handle.setAttribute('aria-hidden', 'true');

    function set(v) {
      var n = Math.max(0, Math.min(100, Number(v) || 0));
      frame.style.setProperty('--bac', n + '%');
      input.setAttribute('aria-valuetext', n + '% ' + before.toLowerCase() + ', ' + (100 - n) + '% ' + after.toLowerCase());
    }
    input.addEventListener('input', function () { set(input.value); });

    frame.appendChild(input);
    frame.appendChild(handle);
    set(50);
    fig.classList.add('bac-on');
  });
})();
