/**
 * stripe-ledger-customer.js — the customer page's "Stripe Payments" section.
 *
 * Every Stripe money movement functions/stripe-ledger.js matched to THIS
 * customer (stripeLedger rows with match.leadId == the lead): date, amount
 * (refunds and disputes in red), method, Stripe fee, receipt link and which
 * invoice it paid. Jo (2026-09-29): "linked to the customers in the CRM
 * under their names."
 *
 * Query: companyId == tenant AND match.leadId == lead — equality only, so no
 * composite index; sorted here. Rule-safe for the owner, company_admin,
 * manager and platform admin (firestore.rules §stripeLedger). Sales reps
 * and viewers cannot read the ledger: the section stays hidden for them, and
 * it stays hidden when the customer has no Stripe activity.
 *
 * Self-starting: waits for the page bootstrap to publish window._customerId
 * and window.db, then loads once per lead. window.NBDStripeCustomer.load(id)
 * reloads on demand. Pure rules: stripe-ledger-ui-logic.js.
 */
(function () {
  'use strict';
  if (window.NBDStripeCustomer) return;
  var L = window.NBDStripeLedgerLogic;
  if (!L) return;
  var esc = L.esc;
  var loadedFor = null;

  function uid() { return (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || (window._user && window._user.uid) || null; }
  function panel() { return document.getElementById('stripePaymentsPanel'); }
  function list() { return document.getElementById('stripePaymentsList'); }
  function hide() { var p = panel(); if (p) p.hidden = true; }

  function rowHtml(r) {
    var d = L.displayRow(r, null);
    var inv = d.invoiceNumber ? 'Invoice ' + d.invoiceNumber : (d.invoiceId ? 'On a CRM invoice' : (r.kind === 'refund' || r.kind === 'dispute' ? '' : 'Ledger only'));
    var meta = [d.method, d.feeCents ? 'Stripe fee ' + d.feeText : '', inv].filter(Boolean);
    var links = (d.receiptUrl ? '<a href="' + esc(d.receiptUrl) + '" target="_blank" rel="noopener noreferrer" class="doc-btn">Receipt</a>' : '') +
      (d.stripeUrl ? '<a href="' + esc(d.stripeUrl) + '" target="_blank" rel="noopener noreferrer" class="doc-btn">Stripe invoice</a>' : '');
    var tone = { good: 'paid', bad: 'overdue', warn: 'draft', info: 'sent', muted: 'draft' }[d.chip.tone] || 'draft';
    return '<div class="invoice-item" style="flex-wrap:wrap;gap:6px;">' +
      '<div class="invoice-left" style="min-width:0;">' +
        '<div class="invoice-date">' + esc(d.dateText) + ' · ' + esc(d.kindLabel) + '</div>' +
        '<div class="invoice-desc" style="overflow-wrap:anywhere;">' + meta.map(esc).join(' · ') + (d.failure ? ' · ' + esc(d.failure) : '') + '</div>' +
      '</div>' +
      '<div class="invoice-right" style="flex-wrap:wrap;justify-content:flex-end;gap:6px;flex-shrink:1;min-width:0;max-width:100%;">' +
        '<div class="invoice-amount"' + (d.negative ? ' style="color:var(--red);"' : '') + '>' + esc(d.amountText) + '</div>' +
        '<div class="invoice-status ' + tone + '">' + esc(d.chip.label) + '</div>' +
        links +
      '</div></div>';
  }

  async function load(leadId) {
    var p = panel(), host = list();
    if (!p || !host || !leadId) return;
    var claims = window._userClaims || {};
    var u = uid();
    if (!L.canRead(claims, u) || !window.db || !window.getDocs) { hide(); return; }
    try {
      var f = { db: window.db, collection: window.collection, query: window.query, where: window.where, orderBy: window.orderBy, limit: window.limit };
      var snap = await window.getDocs(L.applyQuery(L.customerQuery(L.tenantOf(claims, u), leadId), f));
      var rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (r) { return r.kind !== 'platform_subscription' && r.kind !== 'payout'; })
        .sort(function (a, b) { return (Number(b.atMs) || 0) - (Number(a.atMs) || 0); });
      if (!rows.length) { hide(); return; }
      var paid = 0, fees = 0, back = 0;
      rows.forEach(function (r) {
        var a = parseInt(r.amountCents, 10) || 0;
        if ((r.kind === 'charge' || r.kind === 'invoice_paid_outside_stripe') && r.status === 'succeeded' && a > 0) { paid += a; fees += parseInt(r.feeCents, 10) || 0; }
        if ((r.kind === 'refund' && r.status !== 'failed' && r.status !== 'canceled') || (r.kind === 'dispute' && r.status === 'lost')) back += Math.abs(a);
      });
      host.innerHTML = rows.map(rowHtml).join('') +
        '<div class="payment-summary">' +
          '<div class="summary-item"><div class="summary-label">Paid via Stripe</div><div class="summary-value">' + esc(L.fmtMoney(paid)) + '</div></div>' +
          '<div class="summary-item"><div class="summary-label">Stripe fees</div><div class="summary-value">' + esc(L.fmtMoney(fees)) + '</div></div>' +
          (back ? '<div class="summary-item"><div class="summary-label">Refunded / lost</div><div class="summary-value" style="color:var(--red);">' + esc(L.fmtMoney(-back)) + '</div></div>' : '') +
        '</div>';
      p.hidden = false;
      if (typeof window.nbdTitleCount === 'function') window.nbdTitleCount('stripePaymentsTitle', 'Stripe Payments', rows.length);
    } catch (e) {
      // permission-denied (a role the rules refuse) or offline: stay hidden.
      console.warn('[stripe-customer] load', e && (e.code || e.message));
      hide();
    }
  }

  // Wait for the bootstrap (window._customerId is set as the lead resolves;
  // claims are awaited before it). Gives up quietly after ~30s.
  var tries = 0;
  (function wait() {
    var id = window._customerId;
    if (id && window.db && uid() && window._userClaims) {
      if (loadedFor !== id) { loadedFor = id; load(id); }
      return;
    }
    if (++tries < 100) setTimeout(wait, 300);
  })();

  window.NBDStripeCustomer = { load: load };
})();
