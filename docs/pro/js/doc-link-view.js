/**
 * doc-link-view.js — the customer's Secure Document Link viewer (2026-11-04).
 * External file, no inline script, no third-party script, no cookies, no pixel.
 *
 * Counts ONLY seconds the page is visible. After 3 visible seconds it sends one
 * `open` beacon (that, not the page fetch, is what counts as an open). Then it
 * sends the visible seconds since the last beacon every 15 seconds, and flushes
 * when the page is hidden or closed. The server clamps every number again, so
 * this only has to be honest, not trusted. The result is "time with the page
 * open", NOT proof of reading.
 */
(function (root) {
  'use strict';

  var OPEN_AFTER = 3;
  var PING_EVERY = 15;

  /**
   * @param {{send:function(object):void, visible:function():boolean}} io
   * tick() is called once per second by the page; tests call it directly.
   */
  function createTracker(io) {
    var visibleTotal = 0;   // visible seconds since load
    var sinceFlush = 0;     // visible seconds not yet reported
    var opened = false;
    function flush() {
      if (!opened || sinceFlush <= 0) return;
      io.send({ k: 'ping', s: sinceFlush });
      sinceFlush = 0;
    }
    return {
      tick: function () {
        if (!io.visible()) return;
        visibleTotal += 1;
        if (!opened) {
          if (visibleTotal >= OPEN_AFTER) { opened = true; io.send({ k: 'open', s: visibleTotal }); }
          return;
        }
        sinceFlush += 1;
        if (sinceFlush >= PING_EVERY) flush();
      },
      flush: flush,
      file: function () {
        if (!opened) return;
        io.send({ k: 'file', s: Math.max(1, sinceFlush) });
        sinceFlush = 0;
      },
      state: function () { return { visibleTotal: visibleTotal, sinceFlush: sinceFlush, opened: opened }; }
    };
  }

  var api = { createTracker: createTracker, OPEN_AFTER: OPEN_AFTER, PING_EVERY: PING_EVERY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;

  function meta(name) {
    var m = root.document.querySelector('meta[name="' + name + '"]');
    return m ? m.getAttribute('content') : '';
  }
  var token = meta('nbd-doc-token');
  var viewId = meta('nbd-doc-view');
  var url = meta('nbd-doc-ping');
  if (!token || !viewId || !url) return;

  function send(o) {
    var body = JSON.stringify({ t: token, v: viewId, k: o.k, s: o.s });
    try {
      if (root.navigator && root.navigator.sendBeacon) { root.navigator.sendBeacon(url, body); return; }
    } catch (e) { /* fall through */ }
    try { root.fetch(url, { method: 'POST', body: body, keepalive: true, credentials: 'omit' }); } catch (e2) { /* best effort */ }
  }
  var t = createTracker({ send: send, visible: function () { return root.document.visibilityState === 'visible'; } });
  root.setInterval(t.tick, 1000);
  root.document.addEventListener('visibilitychange', function () {
    if (root.document.visibilityState === 'hidden') t.flush();
  });
  root.addEventListener('pagehide', t.flush);
  var btn = root.document.getElementById('dlOpen');
  if (btn) btn.addEventListener('click', t.file);
})(typeof window !== 'undefined' ? window : null);
