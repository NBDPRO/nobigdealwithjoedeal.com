/**
 * invoice-supplement-chip-logic.js — a small read-only chip on the customer page's invoice rows: "Includes $X in supplements".
 *
 * invoice-pipeline.js folds approved insurance supplements into an invoice when it is built from an estimate and stores how much of
 * the total that was in `supplementTotal`. This only reads that stored number back, so it answers "why is this invoice higher than
 * the estimate?" for the supplement part without comparing against the estimate (a job billed as a deposit plus a final invoice
 * would make such a comparison misleading). It never computes or changes a money value.
 *
 * Pure: no DOM, no storage. Money is read in cents. Fails closed: nothing is shown for a missing, zero, negative or non-numeric
 * amount, for an amount larger than the invoice total, or for a cancelled / void / deleted invoice.
 *
 * Exposed as window.NBDInvoiceSupplement and module.exports (tests).
 */
(function (root) {
  'use strict';

  const toCents = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const DEAD = { cancelled: 1, canceled: 1, void: 1, voided: 1, deleted: 1 };

  /** -> the supplement cents to show, or 0 for "show nothing". */
  function supplementCents(inv) {
    if (!inv || typeof inv !== 'object') return 0;
    if (inv.deleted === true || DEAD[String(inv.status || '').toLowerCase()]) return 0;
    const sup = toCents(inv.supplementTotal);
    const total = toCents(inv.total);
    // sup > total also covers a zero, negative or missing total (a missing one reads as 0 here, and sup is above zero by then).
    if (sup == null || sup <= 0 || sup > total) return 0;
    return sup;
  }

  const money = (cents) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** The chip's text, or ''. */
  function chipText(inv) {
    const c = supplementCents(inv);
    return c > 0 ? 'Includes $' + money(c) + ' in supplements' : '';
  }

  /** The chip's markup (esc = the page's HTML escaper), or ''. */
  function chipHtml(inv, esc) {
    const t = chipText(inv);
    if (!t) return '';
    const e = typeof esc === 'function' ? esc : (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return '<span class="ipx-sup-chip" data-supplement-chip>' + e(t) + '</span>';
  }

  const api = { supplementCents, chipText, chipHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDInvoiceSupplement = api;
})(typeof window !== 'undefined' ? window : null);
