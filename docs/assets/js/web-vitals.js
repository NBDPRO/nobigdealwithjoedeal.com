/**
 * web-vitals.js — real-visitor speed for the public site, sent to GA4 (2026-11-04).
 *
 * WHY: Search Console has no Core Web Vitals for the site yet ("not enough usage data"), so every speed number so
 * far came from lab runs (documentation/audit/PERF-AUDIT-2026-11-04.md). This measures each real page view with the
 * browser's own APIs (no library) and sends five GA4 events once, when the visitor leaves the page:
 *
 *   LCP   largest contentful paint (ms)   good ≤ 2500, poor > 4000
 *   INP   interaction to next paint (ms)  good ≤ 200,  poor > 500   (the slowest interaction; fine for < 50 taps)
 *   CLS   cumulative layout shift (×1000 in `value`, raw in metric_value)  good ≤ 0.1, poor > 0.25
 *   FCP   first contentful paint (ms)     good ≤ 1800, poor > 3000
 *   TTFB  time to first byte (ms)         good ≤ 800,  poor > 1800
 *
 * Each event carries metric_value, metric_rating (good / needs-improvement / poor), device (phone / desktop by
 * viewport) and non_interaction, so it never counts as engagement. A prerendered page (speculation rules) is timed
 * from when the visitor actually opened it (activationStart), not from the prerender.
 *
 * Loaded by the GA init files (inline/2a90205f1b.js, inline/57b8cb69f9.js, storm-check-ga.js), so it rides the same
 * pages as GA and needs no tag of its own. It only queues gtag() events; ga-loader.js decides when gtag.js loads.
 * Never throws: any unsupported API just means that metric is not sent.
 */
(function () {
  'use strict';
  if (window.__nbdWebVitals) return;
  window.__nbdWebVitals = true;
  if (typeof PerformanceObserver !== 'function' || typeof window.gtag !== 'function') return;

  var THRESHOLDS = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], FCP: [1800, 3000], TTFB: [800, 1800] };
  var values = {};
  var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
  var activation = (nav && nav.activationStart) || 0;
  var fromActivation = function (t) { return Math.max(0, t - activation); };

  function observe(type, cb, extra) {
    try {
      var po = new PerformanceObserver(function (list) { list.getEntries().forEach(cb); });
      var opts = { type: type, buffered: true };
      if (extra) for (var k in extra) opts[k] = extra[k];
      po.observe(opts);
      return po;
    } catch (e) { return null; }
  }

  // TTFB
  if (nav && nav.responseStart > 0) values.TTFB = fromActivation(nav.responseStart);

  // FCP
  observe('paint', function (e) { if (e.name === 'first-contentful-paint') values.FCP = fromActivation(e.startTime); });

  // LCP: the last candidate before the visitor first interacts (the browser stops reporting after that).
  var lcpPo = observe('largest-contentful-paint', function (e) { values.LCP = fromActivation(e.startTime); });
  var stopLcp = function () { if (lcpPo) { try { lcpPo.takeRecords(); lcpPo.disconnect(); } catch (e) {} lcpPo = null; } };
  ['keydown', 'pointerdown'].forEach(function (t) { addEventListener(t, stopLcp, { once: true, capture: true, passive: true }); });

  // CLS: the largest session window (shifts < 1 s apart, window ≤ 5 s), ignoring shifts right after input.
  var sessionValue = 0, sessionFirst = 0, sessionLast = 0;
  var clsPo = observe('layout-shift', function (e) {
    if (e.hadRecentInput) return;
    if (sessionValue && e.startTime - sessionLast < 1000 && e.startTime - sessionFirst < 5000) { sessionValue += e.value; sessionLast = e.startTime; }
    else { sessionValue = e.value; sessionFirst = sessionLast = e.startTime; }
    if (!(values.CLS >= sessionValue)) values.CLS = sessionValue;
  });
  // A page that never shifts has a CLS of 0, which is worth recording (only when the browser measures shifts at all).
  if (clsPo && values.CLS === undefined) values.CLS = 0;

  // INP: the slowest interaction (grouped by interactionId).
  var worst = 0;
  observe('event', function (e) {
    if (!e.interactionId) return;
    if (e.duration > worst) { worst = e.duration; values.INP = worst; }
  }, { durationThreshold: 40 });
  // The first input is always reported (even under 40 ms), so a visit whose taps were all fast still sends a small INP.
  observe('first-input', function (e) { values.INP = Math.max(values.INP || 0, e.duration || 0); });

  function rating(name, v) { var t = THRESHOLDS[name]; return v <= t[0] ? 'good' : v <= t[1] ? 'needs-improvement' : 'poor'; }
  var sent = false;
  function send() {
    if (sent) return;
    sent = true;
    stopLcp();
    var device = (window.innerWidth || 0) < 768 ? 'phone' : 'desktop';
    var id = 'v1-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    Object.keys(values).forEach(function (name) {
      var v = values[name];
      if (typeof v !== 'number' || !isFinite(v) || v < 0) return;
      try {
        window.gtag('event', name, {
          value: Math.round(name === 'CLS' ? v * 1000 : v),
          metric_value: Math.round(v * (name === 'CLS' ? 10000 : 1)) / (name === 'CLS' ? 10000 : 1),
          metric_rating: rating(name, v),
          metric_id: id,
          device: device,
          non_interaction: true,
          transport_type: 'beacon'
        });
      } catch (e) {}
    });
  }
  addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') send(); }, { capture: true });
  addEventListener('pagehide', send, { capture: true });
})();
