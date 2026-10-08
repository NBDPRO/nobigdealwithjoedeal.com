/**
 * payment-receipt.js — one payment's receipt: the numbers and the words.
 *
 * Moved out of docs/pro/js/invoice-pipeline.js (receipts, 2026-10-04) so the
 * homeowner portal prints the SAME receipt the CRM sends (homeowner money
 * audit 2026-10-07, M3 second half: "the portal never shows a receipt").
 * invoice-pipeline.js calls these; functions/payment-receipt.js is a
 * byte-identical copy that getHomeownerPortalView runs (the same pattern as
 * customer-estimate-rows.js — tests/portal-receipts-signed-copy-2026-10-08
 * fails when the two copies drift).
 *
 *   receiptDetailsOf(inv, key, opts)  everything a receipt says about ONE
 *                                     payment of an invoice (cents inside)
 *   buildReceiptEmail(details, co)    the CRM's "Send receipt" email
 *   homeownerReceiptOf(inv, key, o)   the portal's copy: receiptDetailsOf
 *                                     minus every internal field (no ids,
 *                                     no Storage path, no reference)
 *   buildReceiptSheetHtml(d, co, x)   the portal's printable receipt
 *
 * Pure, dependency-free, browser + Node. Every value printed is escaped.
 */
(function () {
  'use strict';

  function formatCurrency(amount) {
    const n = parseFloat(amount);
    // A "Less deposit paid" credit line is negative: print "-$5,000.00",
    // not "$-5,000.00".
    if (Number.isFinite(n) && n < 0) return '-' + formatCurrency(-n);
    return '$' + (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // HTML-escape every value that reaches markup (& < > " ').
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Dollars (number or "$1,234.56" string) → integer cents, rounded half-up
  // on the DECIMAL digits, not on the binary float: 1.005 * 100 is
  // 100.49999999999999 in IEEE-754, so Math.round(x * 100) loses the cent.
  // Returns NaN for anything that is not a non-negative decimal.
  function toCents(v) {
    if (typeof v === 'number' && !Number.isFinite(v)) return NaN;
    let s = String(v == null ? '' : v).trim().replace(/[$,\s]/g, '');
    if (s === '' || s === '.') return NaN;
    const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m) return NaN;
    const whole = m[1] ? parseInt(m[1], 10) : 0;
    const frac = (m[2] || '');
    const first2 = parseInt((frac + '00').slice(0, 2), 10);
    const roundUp = frac.length > 2 && parseInt(frac[2], 10) >= 5 ? 1 : 0;
    const cents = whole * 100 + first2 + roundUp;
    return Number.isSafeInteger(cents) ? cents : NaN;
  }

  function centsToDollars(c) {
    return Math.round(Number(c) || 0) / 100;
  }

  function _tsMs(v) {
    if (v == null) return NaN;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
    // A bare calendar day ('2026-10-07', a legacy payments[].date) is that
    // day: noon UTC, so no reader west of Greenwich prints the day before.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(v + 'T12:00:00Z');
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : NaN;
  }

  /** The payment's own stable id, or '' (a legacy entry with none). */
  function paymentIdOf(p) {
    p = p || {};
    return String(p.paymentId || p.paymentIntentId || p.stripeRef || '');
  }

  /** 'draft' | 'sent' | 'none' (no money: nothing to receipt). */
  function receiptStateOf(p) {
    if (!p || !(Number(p.amount) > 0)) return 'none';
    if (p.achStatus === 'failed' || p.reverted === true) return 'none';
    const r = (p.receipt && typeof p.receipt === 'object') ? p.receipt : null;
    return (r && r.status === 'sent') ? 'sent' : 'draft';
  }

  /** The key a button carries for a payment: its own id, else 'idx:N'. */
  function receiptKeyOf(p, index) {
    const pid = paymentIdOf(p);
    return pid || ('idx:' + index);
  }

  /** Index of the payment a receipt key names, or -1. */
  function findReceiptPayment(payments, key) {
    const list = Array.isArray(payments) ? payments : [];
    const k = String(key || '');
    if (!k) return -1;
    if (k.indexOf('idx:') === 0) {
      const i = parseInt(k.slice(4), 10);
      return (Number.isInteger(i) && i >= 0 && i < list.length && !paymentIdOf(list[i])) ? i : -1;
    }
    return list.findIndex(p => paymentIdOf(p) === k);
  }

  /**
   * The customer-facing invoice number: invoiceNumber, else the filed
   * NBD-500's number, else the Stripe invoice number. '' when there is none
   * — NEVER the Firestore doc id.
   */
  function nbdInvoiceNumberOf(inv) {
    inv = inv || {};
    const pp = (inv.paper && typeof inv.paper === 'object') ? inv.paper : {};
    const filed = pp.invoice && pp.invoice.instanceId;
    return String(inv.invoiceNumber || filed || inv.stripeInvoiceNumber || '').trim();
  }

  const RECEIPT_METHOD_LABELS = {
    check: 'Check', zelle: 'Zelle', cash: 'Cash', card: 'Card', ach: 'Bank transfer (ACH)', other: 'Other',
    stripe: 'Card (online)', us_bank_account: 'Bank transfer (ACH)', apple_pay: 'Apple Pay', google_pay: 'Google Pay',
    link: 'Link (online)', cashapp: 'Cash App', manual: 'Payment',
  };

  // A method no label above knows — the CRM's own wording
  // (invoice-pipeline.js paymentMethodLabel for a key outside its list).
  function _methodFallback(m) {
    if (m === 'stripe') return 'Stripe';
    if (m === 'manual' || !m) return 'Manual';
    return String(m);
  }

  function _validZone(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
  }

  /**
   * Everything a receipt says about one payment. Pure.
   * → null, or { key, index, amount, method, dateText, balanceRemaining,
   *   invoiceNumber, paidInFull, pdfPath, pdfName, reference,
   *   paidSoFar, invoiceTotal }
   * balanceRemaining is what was still owed right after THIS payment
   * (total − every payment up to and including it, in cents); paidSoFar is
   * every payment up to and including it.
   * opts (optional): { methodLabel(m) — a method the labels don't know;
   *   timeZone — the IANA zone the date is read in (default: this device) }
   */
  function receiptDetailsOf(inv, key, opts) {
    inv = inv || {};
    const o = opts || {};
    const list = Array.isArray(inv.payments) ? inv.payments : [];
    const i = findReceiptPayment(list, key);
    if (i < 0) return null;
    const p = list[i] || {};
    if (receiptStateOf(p) === 'none') return null;
    const totalC = toCents(Math.max(0, Number(inv.total) || 0)) || 0;
    let paidC = 0;
    for (let j = 0; j <= i; j++) {
      const a = list[j];
      if (a && Number(a.amount) > 0) paidC += toCents(Number(a.amount)) || 0;
    }
    const balC = Math.max(0, totalC - paidC);
    const atMs = _tsMs(p.at != null ? p.at : p.date);
    const pp = (inv.paper && typeof inv.paper === 'object') ? inv.paper : {};
    // The filed NBD-510 (money-paper.js) is the paid-in-full receipt: it
    // belongs to the payment that closed the invoice out.
    const isLast = i === list.length - 1;
    const filed = pp.receipt && pp.receipt.state === 'filed' && pp.receipt.pdfPath ? pp.receipt : null;
    const fallback = typeof o.methodLabel === 'function' ? o.methodLabel : _methodFallback;
    const dateOpts = { month: 'long', day: 'numeric', year: 'numeric' };
    if (_validZone(o.timeZone)) dateOpts.timeZone = o.timeZone;
    return {
      key: receiptKeyOf(p, i),
      index: i,
      amount: centsToDollars(toCents(Number(p.amount)) || 0),
      method: RECEIPT_METHOD_LABELS[p.method] || fallback(p.method),
      dateText: Number.isFinite(atMs)
        ? new Date(atMs).toLocaleDateString('en-US', dateOpts) : '',
      balanceRemaining: centsToDollars(balC),
      invoiceNumber: nbdInvoiceNumberOf(inv),
      paidInFull: balC === 0 && totalC > 0,
      pdfPath: (filed && isLast && balC === 0) ? String(filed.pdfPath) : '',
      pdfName: (filed && filed.instanceId) ? 'Receipt ' + filed.instanceId + '.pdf' : 'Receipt.pdf',
      reference: p.reference ? String(p.reference).slice(0, 40) : '',
      paidSoFar: centsToDollars(paidC),
      invoiceTotal: centsToDollars(totalC),
    };
  }

  /** The receipt's label/value rows (the email's table). Pure. */
  function receiptRows(details) {
    const d = details || {};
    return [
      ['Invoice', d.invoiceNumber || '—'],
      ['Amount paid', formatCurrency(d.amount)],
      ['Method', d.method + (d.reference ? ' #' + d.reference : '')],
      ['Date', d.dateText || '—'],
      ['Balance remaining', d.paidInFull ? '$0.00 — paid in full' : formatCurrency(d.balanceRemaining)],
    ];
  }

  /** Subject + HTML + plain text for one payment's receipt. Pure; escaped. */
  function buildReceiptEmail(details, company) {
    const d = details || {};
    const co = String(company || 'NBD Roofing');
    const num = d.invoiceNumber ? 'Invoice ' + d.invoiceNumber : 'your invoice';
    const rows = receiptRows(d);
    const subject = 'Payment received — ' + co + (d.invoiceNumber ? ' Invoice ' + d.invoiceNumber : '');
    // A <style> block, not inline attributes (the reskin ratchet); the
    // server's sanitizer keeps <style>.
    const html = '<style>.rc{font-family:Lato,"Segoe UI",Helvetica,Arial,sans-serif;color:#333;max-width:560px}'
      + '.rc table{border-collapse:collapse;width:100%}.rc td{padding:6px 8px;border-bottom:1px solid #eee}'
      + '.rc td.k{color:#666}.rc td.v{text-align:right;font-weight:700}.rc .co{color:#999;font-size:12px}</style>'
      + '<div class="rc">'
      + '<p>Thank you — we received your payment of <strong>' + escHtml(formatCurrency(d.amount)) + '</strong> on ' + escHtml(num) + '.</p>'
      + '<table>'
      + rows.map(r => '<tr><td class="k">' + escHtml(r[0]) + '</td><td class="v">' + escHtml(r[1]) + '</td></tr>').join('')
      + '</table>'
      + '<p>Keep this email for your records. Questions? Just reply.</p>'
      + '<p class="co">' + escHtml(co) + '</p></div>';
    const text = 'Thank you — we received your payment of ' + formatCurrency(d.amount) + ' on ' + num + '.\n'
      + rows.map(r => r[0] + ': ' + r[1]).join('\n') + '\n\n' + co;
    return { subject, html, text };
  }

  /**
   * The homeowner's copy of one payment's receipt (the portal). The same
   * numbers as receiptDetailsOf, with nothing internal: no payment id or
   * index, no Storage path, no reference (a processor id on online
   * payments). null when there is nothing to receipt.
   */
  function homeownerReceiptOf(inv, key, opts) {
    const d = receiptDetailsOf(inv, key, opts);
    if (!d) return null;
    return {
      amount: d.amount,
      method: d.method,
      dateText: d.dateText,
      invoiceNumber: d.invoiceNumber,
      paidSoFar: d.paidSoFar,
      invoiceTotal: d.invoiceTotal,
      balanceRemaining: d.balanceRemaining,
      paidInFull: d.paidInFull,
    };
  }

  /**
   * The portal's printable receipt for one payment: the email's rows, plus
   * the job, what was paid so far and the invoice total. Pure; escaped;
   * classes only (portal.html styles .rcpt-*).
   * extra (optional): { jobLabel — the property address }
   */
  function buildReceiptSheetHtml(details, company, extra) {
    const d = details || {};
    const x = extra || {};
    const co = String(company || '');
    const rows = receiptRows(d);
    const balance = rows.pop();
    if (x.jobLabel) rows.splice(1, 0, ['Job', String(x.jobLabel)]);
    if (d.paidSoFar != null) rows.push(['Paid so far', formatCurrency(d.paidSoFar)]);
    if (d.invoiceTotal != null && Number(d.invoiceTotal) > 0) rows.push(['Invoice total', formatCurrency(d.invoiceTotal)]);
    rows.push(balance);
    return '<div class="rcpt" data-receipt-sheet>'
      + (co ? '<div class="rcpt-co">' + escHtml(co) + '</div>' : '')
      + '<h2 class="rcpt-title">Payment receipt</h2>'
      + '<p class="rcpt-lead">Thank you — we received your payment of <strong>' + escHtml(formatCurrency(d.amount)) + '</strong>'
      + (d.dateText ? ' on ' + escHtml(d.dateText) : '') + '.</p>'
      + '<table class="rcpt-table">'
      + rows.map(r => '<tr><th scope="row">' + escHtml(r[0]) + '</th><td>' + escHtml(r[1]) + '</td></tr>').join('')
      + '</table>'
      + '<p class="rcpt-foot">Keep this for your records.</p>'
      + '</div>';
  }

  const _api = {
    RECEIPT_METHOD_LABELS: RECEIPT_METHOD_LABELS,
    formatCurrency: formatCurrency,
    escHtml: escHtml,
    toCents: toCents,
    centsToDollars: centsToDollars,
    paymentIdOf: paymentIdOf,
    receiptStateOf: receiptStateOf,
    receiptKeyOf: receiptKeyOf,
    findReceiptPayment: findReceiptPayment,
    nbdInvoiceNumberOf: nbdInvoiceNumberOf,
    receiptDetailsOf: receiptDetailsOf,
    receiptRows: receiptRows,
    buildReceiptEmail: buildReceiptEmail,
    homeownerReceiptOf: homeownerReceiptOf,
    buildReceiptSheetHtml: buildReceiptSheetHtml,
  };
  if (typeof window !== 'undefined') {
    window.NBDPaymentReceipt = _api;
  }
  // Node (functions/, unit tests) require() this file.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
  }
})();
