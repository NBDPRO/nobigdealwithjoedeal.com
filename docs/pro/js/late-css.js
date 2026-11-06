/* late-css.js — the dashboard's late stylesheets (boot CSS, 2026-11-06).
 *
 * Style recalculation is the largest CPU cost of a CRM boot, and most of the
 * dashboard's stylesheets style views and dialogs the first screen never shows
 * (measured on every role and every layout at phone and desktop width:
 * documentation/audit/BOOT-CSS-2026-11-06.md). Those sheets ship as
 *   <link rel="stylesheet" media="print" data-late-css href="...">
 * A print sheet still downloads (once, through the service worker like any
 * other) and is parsed, but it does not block rendering and its rules stay out
 * of every screen restyle. This file removes the media attribute, so the parsed
 * sheet applies at the next restyle with no network wait, in its own place in
 * the cascade:
 *   - on the first pointer, touch or key press (any dialog a tap opens is styled),
 *   - when goTo() opens any view but Home (dashboard-actions.js calls flip()),
 *   - at once when the URL carries a query (?agentInbox=1, ?edit=, ?tasks=, ...:
 *     those links open a dialog at boot without a goTo()),
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
      if (links[i].getAttribute('media') === 'print') links[i].removeAttribute('media');
    }
    for (var j = 0; j < EVENTS.length; j++) document.removeEventListener(EVENTS[j], flip, true);
  }

  for (var k = 0; k < EVENTS.length; k++) document.addEventListener(EVENTS[k], flip, { capture: true, passive: true });
  if (window.location && window.location.search) flip();

  function whenIdle() {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(flip, { timeout: 2000 });
    else setTimeout(flip, 500);
  }
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });

  window.NBDLateCss = { flip: flip, isDone: function () { return done; } };
})();
