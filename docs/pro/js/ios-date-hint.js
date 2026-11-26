/**
 * ios-date-hint.js — an empty date field on an iPhone says what it is (2026-11-25).
 *
 * Android Chrome draws an empty <input type="date"> as "mm/dd/yyyy" with a
 * calendar icon. An iPhone or iPad draws a blank box, which reads as broken.
 * Joe's pick: on iOS only, a grey "mm/dd/yyyy" hint and a calendar icon while
 * the field is empty (css/mobile-polish.css §5c paints them as background
 * images, because Safari does not draw ::before on a date input).
 *
 * CSS cannot tell an empty date field from a filled one, so this file keeps a
 * class, `nbd-date-empty`, true to the field's value through every way a value
 * arrives: the rep picking or clearing a date (input / change / blur), a form
 * reset, a field added to the page later (a modal's markup), and code setting
 * `.value` / `.valueAsDate` (the edit-lead prefill), so the hint never sits on
 * top of a real date.
 *
 * Injected (not a page tag) by dashboard-sw-bootstrap.js and offline-manager.js,
 * on iOS only. Pure helpers are exported for Node tests.
 */
(function (root) {
  'use strict';

  /** iPhone / iPod / iPad, including iPadOS, which reports itself as a Mac with touch points. */
  function isIOS(ua, touchPoints) {
    ua = String(ua || '');
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(touchPoints) > 1);
  }
  function isDate(el) {
    // The attribute, not .type: an engine without a date picker reports .type 'text'.
    var t = (el && el.getAttribute && el.getAttribute('type')) || (el && el.type) || '';
    return !!el && String(el.tagName || '').toUpperCase() === 'INPUT' && String(t).toLowerCase() === 'date';
  }
  /** Bring the empty-marker in line with the field's current value. */
  function sync(el) {
    if (!isDate(el) || !el.classList) return;
    if (el.value) el.classList.remove('nbd-date-empty'); else el.classList.add('nbd-date-empty');
  }
  /** Every date field at or under a node. */
  function syncTree(node) {
    if (!node) return;
    if (isDate(node)) sync(node);
    if (node.querySelectorAll) { var l = node.querySelectorAll('input[type="date"]'); for (var i = 0; i < l.length; i++) sync(l[i]); }
  }
  /** Wrap a property setter on a prototype so a date field re-syncs after code sets it. */
  function wrapSetter(proto, prop) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || typeof d.set !== 'function' || d.set.__nbdDateHint) return false;
    var orig = d.set;
    var set = function (v) { orig.call(this, v); if (isDate(this)) sync(this); };
    set.__nbdDateHint = true;
    Object.defineProperty(proto, prop, { configurable: true, enumerable: d.enumerable, get: d.get, set: set });
    return true;
  }
  var pure = { isIOS: isIOS, isDate: isDate, sync: sync, syncTree: syncTree, wrapSetter: wrapSetter };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  var w = root, d = w.document;
  if (!d || w.NBDDateHint) return;
  w.NBDDateHint = pure;
  if (!isIOS(w.navigator && w.navigator.userAgent, w.navigator && w.navigator.maxTouchPoints)) return;

  d.documentElement.classList.add('nbd-ios');
  try {
    var P = w.HTMLInputElement && w.HTMLInputElement.prototype;
    wrapSetter(P, 'value');
    wrapSetter(P, 'valueAsDate');
    wrapSetter(P, 'valueAsNumber');
  } catch (e) { /* events and the scans below still keep it right for the rep's own edits */ }
  ['input', 'change', 'blur'].forEach(function (t) {
    d.addEventListener(t, function (e) { sync(e.target); }, true);
  });
  d.addEventListener('reset', function (e) { var f = e.target; setTimeout(function () { syncTree(f); }, 0); }, true);
  function start() {
    syncTree(d.body);
    if (w.MutationObserver) {
      new w.MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].type === 'attributes') { sync(muts[i].target); continue; } // setAttribute('value', …)
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) syncTree(added[j]);
        }
      }).observe(d.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
    }
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})(typeof window !== 'undefined' ? window : this);
