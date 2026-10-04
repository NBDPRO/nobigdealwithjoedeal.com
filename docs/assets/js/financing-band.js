/* financing-band.js — the ONE financing APR band every payment figure uses.
 *
 * COMPLIANCE (Reg Z / Truth in Lending): a monthly payment shown to a
 * homeowner is an ILLUSTRATION, never an offer of credit. NBD is not a
 * lender. The band below is the Acorn Finance marketplace's published range
 * (11.49%–19.99% APR, 2–15 year terms); a homeowner's real rate, term and
 * payment are set by a third-party lender on approved credit.
 *
 * Readers (keep them on this file — never a second copy of the numbers):
 *   - docs/assets/js/financing-estimator.js  (public /services/financing)
 *   - docs/pro/js/close-board.js             (the homeowner deal page)
 *   - docs/pro/deal-room.js                  (reads the band close-board
 *                                             bakes into the page's data)
 * The Close Board used to hard-code 0% / 5.99% / 7.99% / 9.99% / 11.99%
 * plans and show "~$X/mo" at 7.99% for 60 months — under the low end of the
 * band, so every deal page understated the payment (2026-10-03).
 *
 * Plain script, no inline handlers (CSP-safe). Also loadable from Node
 * (module.exports) so tests check the public page and the deal page agree.
 */
(function (root) {
  'use strict';
  var APR_LO = 0.1149;
  var APR_HI = 0.1999;

  // Fixed fully-amortizing payment: P·r / (1 − (1+r)^−n); r = monthly rate.
  function payment(principal, apr, months) {
    var P = Number(principal) || 0;
    var n = Number(months) || 0;
    if (P <= 0 || n <= 0) return 0;
    var r = apr / 12;
    return r === 0 ? P / n : P * r / (1 - Math.pow(1 + r, -n));
  }

  // { lo, hi } monthly payment at the band's two ends for this amount + term.
  function range(principal, months) {
    return { lo: payment(principal, APR_LO, months), hi: payment(principal, APR_HI, months) };
  }

  // Whole dollars, the way the public estimator prints them ("$218").
  function fmtWhole(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

  var band = Object.freeze({
    aprLo: APR_LO,
    aprHi: APR_HI,
    // "11.49%–19.99% APR" — the label the public estimator prints.
    aprLabel: '11.49%–19.99% APR',
    termYears: Object.freeze([2, 3, 5, 7, 10, 12, 15]),
    // The estimator's pre-selected term (the "5 yr" tile).
    defaultTermYears: 5,
    lender: 'Acorn Finance',
    // The site's existing Acorn pre-qualification link (soft credit pull).
    preQualUrl: 'https://www.acornfinance.com/pre-qualify/?d=QU6WZ',
    disclaimer: 'Estimate only. Subject to credit approval. Rates and terms vary.',
    payment: payment,
    range: range,
    fmtWhole: fmtWhole
  });

  if (typeof module === 'object' && module.exports) module.exports = band;
  if (root) root.NBD_FINANCING_BAND = band;
})(typeof window !== 'undefined' ? window : null);
