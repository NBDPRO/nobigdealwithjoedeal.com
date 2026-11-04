/**
 * doc-link-copy.js — wording and chip text for the Secure Document Link
 * (2026-11-04). Pure, no DOM: customer-documents.js uses it, and
 * tests/doc-link-2026-11-04.test.js requires it.
 *
 * The tracking notice is Jo's APPROVED wording; do not edit it without him.
 * functions/doc-link-logic.js trackingNotice() builds the same sentence for the
 * viewer-page banner (the test asserts the two are identical). No pixel, no
 * third-party anything: the notice is about THIS link only.
 *
 * Copy rule: no claim-handling wording (KY SB 153).
 */
(function (root) {
  'use strict';

  function fmtDate(ms, tz) {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ms));
    } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }

  function trackingNotice(o) {
    var x = o || {};
    var brand = String(x.brand || 'No Big Deal').trim() || 'No Big Deal';
    var rep = String(x.rep || 'Joe').trim() || 'Joe';
    return 'This is a private link to your estimate from ' + brand + '. It\'s tracked: ' + rep
      + ' can see when it\'s opened, how many times and for how long, so he knows when to follow up. It expires on '
      + fmtDate(x.expiresAtMs, x.tz) + '.';
  }

  /** The pre-written share text (share sheet, or the mail body). Never contains the code itself. */
  function secureReviewMessage(o) {
    var x = o || {};
    var hi = 'Hi' + (x.firstName ? ' ' + x.firstName : '') + ',';
    var from = x.from ? ' it’s ' + x.from + '.' : '';   // same lead-in as estimate-followups.js reviewMessage
    return hi + from + ' Here’s your roof estimate to look over:\n\n' + (x.url || '')
      + (x.hasCode ? '\n\nIt needs a code. I’ll give it to you separately.' : '')
      + '\n\n' + trackingNotice(x)
      + '\n\nTake your time, and text me with any questions.';
  }

  function durationLabel(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s < 60) return s + ' sec';
    return Math.round(s / 60) + ' min';
  }

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }

  var DEVICE = { mobile: 'phone', tablet: 'tablet', desktop: 'computer' };

  /** "Opened 3x, first Tue 2:14 pm, last Wed 9:02 am, 6 min with the page open, phone". Not opened: "Not opened yet". */
  function chipText(track, nowMs) {
    var t = track || {};
    var n = Number(t.openCount) || 0;
    var parts = [];
    if (!n) {
      parts.push('Not opened yet');
    } else {
      var when = function (ms) {
        var d = new Date(ms);
        return d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
      };
      parts.push('Opened ' + n + 'x');
      if (toMs(t.firstOpenedAt)) parts.push('first ' + when(toMs(t.firstOpenedAt)));
      if (n > 1 && toMs(t.lastOpenedAt)) parts.push('last ' + when(toMs(t.lastOpenedAt)));
      if (Number(t.readSeconds) > 0) parts.push(durationLabel(t.readSeconds) + ' with the page open');
      if (DEVICE[t.device]) parts.push(DEVICE[t.device]);
    }
    var exp = toMs(t.expiresAt);
    if (exp) parts.push(exp < (nowMs || Date.now()) ? 'expired' : 'expires ' + fmtDate(exp));
    if (t.passwordSet) parts.push('code required');
    return parts.join(' · ');
  }

  var api = { trackingNotice: trackingNotice, secureReviewMessage: secureReviewMessage, chipText: chipText, durationLabel: durationLabel, fmtDate: fmtDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.NBDDocLinkCopy = api;
})(typeof window !== 'undefined' ? window : null);
