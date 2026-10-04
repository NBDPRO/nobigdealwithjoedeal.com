/* financing-estimator.js — illustrative monthly-payment estimator for the
 * /services/financing page (T9).
 *
 * COMPLIANCE: this is an ILLUSTRATION, not an offer of credit. NBD is not a
 * lender and makes no credit decisions. The APR band (11.49%–19.99%) and
 * term range (2–15 yr) are the Acorn Finance marketplace's published ranges;
 * a homeowner's real rate/term/payment are set by a third-party lender on
 * approved credit. All of that is disclosed in-widget (.fe-cap / .fe-disc)
 * and in the page's financing small print. No inline handlers (CSP-safe).
 */
(function () {
  'use strict';
  // The band is shared with the CRM deal page: financing-band.js
  // (window.NBD_FINANCING_BAND) — load it before this file. No band, no
  // numbers: never print a payment from a guessed rate.
  var BAND = window.NBD_FINANCING_BAND;
  var amt = document.getElementById('fe-amount');
  var group = document.getElementById('fe-term-group');
  if (!amt || !group || !BAND) return;
  var years = BAND.defaultTermYears;
  var $ = function (id) { return document.getElementById(id); };
  var fmt = BAND.fmtWhole;
  function render() {
    var P = +amt.value, r = BAND.range(P, years * 12);
    $('fe-amt').textContent = fmt(P);
    $('fe-lo').textContent = fmt(r.lo);
    $('fe-hi').textContent = fmt(r.hi);
  }
  amt.addEventListener('input', render);
  group.addEventListener('click', function (e) {
    var b = e.target.closest('.fe-term[data-yrs]'); if (!b) return;
    years = +b.getAttribute('data-yrs');
    var tiles = group.querySelectorAll('.fe-term');
    for (var i = 0; i < tiles.length; i++) tiles[i].classList.toggle('sel', tiles[i] === b);
    render();
  });
  render();
})();
