/**
 * customer-pay-link.js — "Record payment" one tap from Home (2026-10-08,
 * phone audit 2026-10-07 #2).
 *
 * Home's "Money to collect" row links to
 *   /pro/customer.html?id=<leadId>&pay=<invoiceId>
 * and this opens the Record payment sheet for that invoice as soon as the
 * customer page has loaded — instead of landing at the top of a page whose
 * Record payment button sits ~12 phone screens down.
 *
 * - The sheet is the customer page's own (NBDCustomerInvoices.recordPayment →
 *   invoice-pipeline.js recordPaymentUI): same reads, same write, same
 *   receipt-is-a-draft rule. Nothing here writes or sends anything.
 * - &pay is removed from the address bar first, so a reload or Back never
 *   reopens the sheet.
 * - The sheet must be about THAT invoice. When the job has several open
 *   invoices it is picked in the sheet's Invoice list. When the sheet can
 *   only apply to a different invoice (the owed one belongs to another job),
 *   the sheet is closed again and the page scrolls to Invoices & Payments,
 *   where every invoice has its own Mark Paid — a payment never lands on the
 *   wrong bill.
 * - Viewers (read-only role) are never offered the sheet.
 *
 * parsePayLink() is pure (tests/phone-quick-wins-2026-10-08.test.js).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDCustomerPayLink) return;
  var w = window, doc = document;
  var ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

  // → null (no pay link) | { leadId, invoiceId|null, rest } where rest is
  // the query string without `pay` (for history.replaceState).
  function parsePayLink(search) {
    var p;
    try { p = new URLSearchParams(search || ''); } catch (_) { return null; }
    if (!p.has('pay')) return null;
    var leadId = p.get('id') || '';
    var inv = p.get('pay') || '';
    p.delete('pay');
    var rest = p.toString();
    if (!ID_RE.test(leadId)) return { leadId: null, invoiceId: null, rest: rest };
    return { leadId: leadId, invoiceId: (inv !== '1' && ID_RE.test(inv)) ? inv : null, rest: rest };
  }

  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function isViewer() { return ((w._userClaims || {}).role || '') === 'viewer'; }
  function wait(test, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() {
        var v = false;
        try { v = test(); } catch (_) { v = false; }
        if (v) return resolve(v);
        if (Date.now() - t0 > ms) return resolve(null);
        setTimeout(tick, 200);
      })();
    });
  }
  function toInvoices() {
    var el = doc.getElementById('invoiceList');
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'start' }); } catch (_) { el.scrollIntoView(); } }
  }

  async function run(link) {
    var ready = await wait(function () {
      return w._customerId === link.leadId && doc.documentElement.style.opacity === '1' &&
        w.NBDCustomerInvoices && typeof w.NBDCustomerInvoices.recordPayment === 'function' && w._userClaims;
    }, 30000);
    if (!ready || isViewer()) return;
    w.NBDCustomerInvoices.recordPayment(link.leadId);
    var sheet = await wait(function () { return doc.querySelector('#nbd-recordpay-modal .modal'); }, 20000);
    if (!sheet || !link.invoiceId) return;
    var sel = sheet.querySelector('#nbd-rp-inv');
    if (sel) {
      var has = Array.prototype.some.call(sel.options, function (o) { return o.value === link.invoiceId; });
      if (has) {
        sel.value = link.invoiceId;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    } else {
      // One open invoice (or none yet): confirm it is the one Home showed.
      var IP = w.InvoicePipeline;
      var ctx = null;
      try { ctx = IP && typeof IP.recordPaymentContext === 'function' ? await IP.recordPaymentContext(link.leadId) : null; } catch (_) { ctx = null; }
      var t = ctx && ctx.target;
      if (t && t.kind === 'existing' && t.invoices && t.invoices[0] && t.invoices[0].id === link.invoiceId) return;
      if (!t) return;   // could not check — the sheet itself shows what it applies to
    }
    var cancel = doc.getElementById('nbd-rp-cancel');
    if (cancel) cancel.click();
    toInvoices();
    toast('That invoice is on another job — use Mark Paid on its row below.', 'info');
  }

  var link = parsePayLink(w.location && w.location.search);
  if (link) {
    try {
      if (w.history && typeof w.history.replaceState === 'function') {
        w.history.replaceState(w.history.state, '', w.location.pathname + (link.rest ? '?' + link.rest : '') + (w.location.hash || ''));
      }
    } catch (_) { /* address bar left as is */ }
    if (link.leadId) run(link).catch(function (e) { console.warn('[pay-link] could not open Record payment', e); });
  }

  w.NBDCustomerPayLink = { parsePayLink: parsePayLink };
})();
