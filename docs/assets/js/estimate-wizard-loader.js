/* Lazy loader for the estimate wizard (assets/js/inline/4053149b2f.js, ~52KB).
 *
 * Lighthouse flagged ~39KB of the wizard as unused at initial load — it all
 * boots up-front for a form the visitor hasn't touched yet. This defers the
 * fetch+parse off the critical path: the wizard loads on the FIRST user
 * intent anywhere on the page (pointerdown/focusin/keydown/touchstart), or
 * on idle within ~2.5s as a safety net — so by the time a homeowner has
 * read the hero and clicks into the address field, it's already there.
 *
 * The wizard script wires its own listeners at execute time against a
 * DOM that is fully parsed by then (this loader runs deferred, and the
 * injected script executes async afterwards), so no init contract changes.
 */
(function () {
  var loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    ['pointerdown', 'focusin', 'keydown', 'touchstart'].forEach(function (t) {
      document.removeEventListener(t, load, true);
    });
    var s = document.createElement('script');
    s.src = '/assets/js/inline/4053149b2f.js?v=2';
    document.body.appendChild(s);
  }
  ['pointerdown', 'focusin', 'keydown', 'touchstart'].forEach(function (t) {
    document.addEventListener(t, load, true);
  });
  if ('requestIdleCallback' in window) {
    requestIdleCallback(load, { timeout: 2500 });
  } else {
    setTimeout(load, 2500);
  }
})();
