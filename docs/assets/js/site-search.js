/* site-search.js — /search?q=... opens with that query (2026-10-16).
 * Pagefind's Component UI (pagefind-component-ui.js) has no URL parameter of
 * its own, so this fills its input once the element has rendered and lets the
 * component's own input listener run the search. Nothing else. */
(function () {
  'use strict';
  var q = '';
  try { q = new URLSearchParams(window.location.search).get('q') || ''; } catch (_) { q = ''; }
  q = q.trim().slice(0, 120);
  if (!q) return;
  var tries = 0;
  (function fill() {
    var input = document.querySelector('pagefind-input input');
    if (!input) { if (++tries < 50) setTimeout(fill, 100); return; }
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })();
})();
