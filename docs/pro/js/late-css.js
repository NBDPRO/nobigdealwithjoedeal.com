/* late-css.js — the dashboard's late stylesheets (boot CSS, 2026-11-06).
 *
 * Style recalculation is the largest CPU cost of a CRM boot, and most of the
 * dashboard's stylesheets style views and dialogs the first screen never shows
 * (measured on every role and every layout at phone and desktop width:
 * documentation/audit/BOOT-CSS-2026-11-06.md). Those sheets ship as
 *   <link rel="preload" as="style" data-late-css href="...">
 * so their bytes still download at boot but their rules stay out of every boot
 * restyle. This file turns each one back into a stylesheet, in place, so the
 * cascade order is exactly what the page always had:
 *   - on the first pointer, touch or key press (any dialog a tap opens is styled),
 *   - when goTo() opens any view but Home (dashboard-actions.js calls flip()),
 *   - once the page has loaded and gone idle (2 s at most).
 * A sheet that styles something on the first screen must NOT be marked late
 * (tests/late-css-2026-11-06.test.js pins the list).
 */
(function () {
  'use strict';
  var done = false;
  var EVENTS = ['pointerdown', 'touchstart', 'keydown'];

  function flip() {
    if (done) return;
    done = true;
    var links = document.querySelectorAll('link[data-late-css]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].rel !== 'stylesheet') links[i].rel = 'stylesheet';
    }
    for (var j = 0; j < EVENTS.length; j++) document.removeEventListener(EVENTS[j], flip, true);
  }

  for (var k = 0; k < EVENTS.length; k++) document.addEventListener(EVENTS[k], flip, { capture: true, passive: true });

  function whenIdle() {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(flip, { timeout: 2000 });
    else setTimeout(flip, 500);
  }
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });

  window.NBDLateCss = { flip: flip, isDone: function () { return done; } };
})();
