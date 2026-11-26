/* contact-tap.js — GA4 `contact_tap` on every public page (2026-11-26).
 *
 * Most homeowners call or text instead of filling a form, and until now only
 * /inspect counted those taps (inspect-analytics.js). This sends the same
 * event from every page that loads GA4, so "which pages make the phone ring"
 * is one GA4 report:
 *
 *   contact_tap   method 'tel' | 'sms'
 *                 place  'sticky' | 'header' | 'footer' | 'form' | 'other'
 *                 page   location.pathname (no query string, no hash)
 *
 * Loaded by the shared GA4 init scripts (inline/2a90205f1b.js,
 * inline/57b8cb69f9.js, storm-check-ga.js), the same way web-vitals.js is, so
 * every tagged page gets it with no per-page edit. /inspect keeps its own,
 * richer places (hero/form/thanks); this file stands down there so a tap is
 * never counted twice.
 *
 * No PII: never reads the number or any input. Listens only; a page works
 * the same without it. GA4's gtag uses sendBeacon, so the event survives the
 * hand-off to the dialer.
 */
(function () {
  'use strict';
  if (window.__nbdContactTap) return;
  window.__nbdContactTap = 1;
  if (document.querySelector('script[src*="/assets/js/inspect-analytics.js"]')) return;

  function placeOf(el) {
    if (!el || !el.closest) return 'other';
    if (el.closest('.mobile-cta-strip')) return 'sticky';
    if (el.closest('header, nav, .nav, .site-header')) return 'header';
    if (el.closest('footer')) return 'footer';
    if (el.closest('form, .qlf-section, [data-nbd-quick-form]')) return 'form';
    return 'other';
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="tel:"], a[href^="sms:"]') : null;
    if (!a) return;
    try {
      if (typeof window.gtag !== 'function') return;
      var href = a.getAttribute('href') || '';
      window.gtag('event', 'contact_tap', {
        method: href.indexOf('sms:') === 0 ? 'sms' : 'tel',
        place: placeOf(a),
        page: String(location.pathname || '/').slice(0, 100)
      });
    } catch (err) { /* analytics never blocks a call */ }
  }, true);
})();
