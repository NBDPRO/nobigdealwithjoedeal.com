/**
 * invoice-void.js — the owner side voids an ordinary invoice (2026-11-16).
 *
 * Before this the CRM had no Void for an ordinary invoice: only the backfill
 * tool voided, and only its own invoices, so a test or mistaken invoice stayed
 * "owed" for good. An invoice with no money on it (never paid, or every
 * payment reversed) is voided with a reason and KEPT: status 'void' plus
 * voidNote / voidedAt / voidedBy. Money fields are not touched; the owed rule
 * already treats 'void' as not owed. firestore.rules lets the owner side
 * (backfillWriterOk) make that move and refuses a rep once money was recorded.
 *
 * Not offered (voidBlockedReason): paid, already void, a backfill invoice
 * (its own Undo), an invoice with an online pay link or from Stripe (void it
 * in Stripe, so the homeowner cannot still pay it online), a bank payment in
 * flight, supplements billed, refunds, or any money still recorded.
 *
 * Loaded on first use from the customer page (customer-tasks-ui.js
 * NBDCustomerInvoices.voidInvoice), so the dashboard boot never ships it.
 * Tests: tests/invoice-card-void-2026-11-16.test.js.
 */
(function (root) {
  'use strict';
  var NOTE_MAX = 300;

  function voidBlockedReason(inv) {
    if (!inv) return 'Invoice not found';
    var st = String(inv.status || '').toLowerCase();
    if (inv.deleted === true || st === 'void' || st === 'voided' || st === 'cancelled') return 'The invoice is already voided';
    if (st === 'paid') return 'The invoice is paid: reverse its payments first';
    if (st === 'sending') return 'The invoice is being sent: try again in a minute';
    if (String(inv.source || '').toLowerCase() === 'backfill') return 'Undo a backfilled payment from the backfill screen';
    if (inv.source === 'stripe' || inv.stripePaymentLink || inv.stripeHostedUrl) return 'This invoice has an online payment link: void it in Stripe so it cannot still be paid';
    if (inv.achPending) return 'A bank payment is still processing on this invoice';
    if (Array.isArray(inv.supplementIds) && inv.supplementIds.length) return 'This invoice bills supplements: ask for help to void it';
    var net = 0;
    (Array.isArray(inv.payments) ? inv.payments : []).forEach(function (p) { if (p) net += Math.round((Number(p.amount) || 0) * 100); });   // signed: a reversal is negative
    if (net !== 0 || Math.round(Math.max(0, Number(inv.amountPaid) || 0) * 100) > 0) return 'Money is recorded on this invoice: reverse its payments first';
    if (Array.isArray(inv.refunds) && inv.refunds.length) return 'This invoice has refunds on it: ask for help to void it';
    return '';
  }
  function voidPatchFor(note, uid, now) {
    return { status: 'void', voidNote: note, voidedAt: now, voidedBy: uid || null, updatedAt: now };
  }

  function w() { return root || {}; }
  function toast(m, k) { if (typeof w().showToast === 'function') w().showToast(m, k); }
  function uid() {
    var W = w();
    return (W._auth && W._auth.currentUser && W._auth.currentUser.uid) || (W.auth && W.auth.currentUser && W.auth.currentUser.uid)
      || (W._user && W._user.uid) || '';
  }
  // The company owner: same set as invoice-pipeline.js _isCompanyOwner (owner claim, company_admin, or a solo owner).
  function isOwner() {
    var c = w()._userClaims || {};
    var u = uid();
    if (!u || c.role === 'viewer') return false;
    if (c.owner === true || c.role === 'company_admin') return true;
    return !c.role && (!c.companyId || c.companyId === u);
  }
  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function clean(v) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, NOTE_MAX); }

  /** Ask why, confirm, write status 'void' with the reason. → true when done. */
  async function voidInvoiceUI(invoiceId) {
    var W = w();
    if (!invoiceId) return false;
    if (!isOwner()) { toast('Only the company owner can void an invoice.', 'error'); return false; }
    var db = W._db || W.db;
    var ref = W.doc(db, 'invoices', invoiceId);
    var total = 0;
    try {
      var snap = await W.getDoc(ref);
      if (!snap.exists()) throw new Error('Invoice not found');
      var inv = snap.data() || {};
      var why = voidBlockedReason(inv);
      if (why) throw new Error(why);
      total = Number(inv.total) || 0;
    } catch (e) { toast((e && e.message) || 'Could not load the invoice', 'error'); return false; }
    var ask = typeof W.nbdPrompt === 'function' ? W.nbdPrompt
      : function (m) { return Promise.resolve(typeof W.prompt === 'function' ? W.prompt(m) : null); };
    var typed = await ask('Why void this ' + money(total) + ' invoice? (for example: test invoice, job cancelled, billed twice)', '');
    var note = clean(typed);
    if (!note) {
      if (typed != null) toast('A reason is required to void an invoice.', 'error');
      return false;
    }
    var yesNo = typeof W.nbdConfirm === 'function' ? W.nbdConfirm
      : function (m) { return Promise.resolve(typeof W.confirm === 'function' ? W.confirm(m) : false); };
    if (!(await yesNo('Void this ' + money(total) + ' invoice? It stays on file marked void with your reason, and nobody owes it any more.'))) return false;
    try {
      await W.updateDoc(ref, voidPatchFor(note, uid(), new Date()));
      toast('Invoice voided', 'success');
      return true;
    } catch (e) {
      toast(/permission/i.test((e && (e.code || e.message)) || '')
        ? 'Not voided: you do not have permission to void this invoice.'
        : 'Could not void the invoice: ' + ((e && e.message) || 'try again'), 'error');
      return false;
    }
  }

  var API = { voidBlockedReason: voidBlockedReason, voidPatchFor: voidPatchFor, voidInvoiceUI: voidInvoiceUI };
  if (root) root.NBDInvoiceVoid = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
