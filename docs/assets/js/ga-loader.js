/**
 * ga-loader.js — loads Google Analytics (gtag.js) after the page, not with it.
 *
 * WHY (speed audit 2026-11-04, documentation/audit/PERF-AUDIT-2026-11-04.md;
 * Jo's yes): the `<script async src=".../gtag/js?id=G-...">` tag on every
 * public page fetched 177 KB and spent 250-500 ms of a phone's main thread
 * during load — the largest Total Blocking Time cost on the homepage, town
 * pages and Our Work.
 *
 * WHAT: each page's own init script (inline/2a90205f1b.js, 57b8cb69f9.js or
 * storm-check-ga.js) still defines gtag() and queues config/events in
 * window.dataLayer straight away; this file only delays fetching gtag.js until
 * the visitor's first scroll, tap or key press, or 3.5 s after the load event,
 * whichever comes first. gtag.js replays the queued dataLayer when it arrives,
 * so no event is dropped. Trade-off Jo accepted: a visit that ends in the first
 * seconds without any interaction is not counted.
 *
 * The URL comes from the tag's own data-gtag attribute, so the page still names
 * its GA4 property (tests/ga4-landing-coverage.test.js counts it); only a
 * googletagmanager.com gtag URL is ever loaded.
 */
(function () {
  'use strict';
  var me = document.currentScript;
  var src = me && me.getAttribute('data-gtag');
  if (!src || src.indexOf('https://www.googletagmanager.com/gtag/js?id=G-') !== 0) return;

  var done = false;
  var EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
  var OPTS = { passive: true };

  function load() {
    if (done) return;
    done = true;
    EVENTS.forEach(function (e) { removeEventListener(e, load, OPTS); });
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  EVENTS.forEach(function (e) { addEventListener(e, load, OPTS); });
  function later() { setTimeout(load, 3500); }
  if (document.readyState === 'complete') later();
  else addEventListener('load', later, { once: true });
})();
