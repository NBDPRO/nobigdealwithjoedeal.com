/**
 * ky-pay-link-gate-logic.js — may createStripePaymentLink mint a link for this
 * invoice, under the Kentucky insurance-job rule (KRS 367.626)?
 *
 * Pulled out of functions/stripe.js (2026-10-03) so the decision is unit
 * tested with injected reads (tests/ky-pay-link-gate-2026-10-03.test.js).
 *
 * FAIL CLOSED, as ky-insurance-law.js promises: the hold is decided from the
 * LEAD. Before this, a lead read that threw (or a leadId whose doc is gone)
 * left kyLead = null, and payLinkHold(null, invoice) only holds an invoice
 * that carries kyInsuranceHold — so a Kentucky insurance job inside its
 * window could get a payment link whenever the lead could not be read. Now
 * an invoice that names a lead we cannot read is refused (reason
 * 'lead_unreadable' / 'lead_missing'). An invoice that names NO lead is
 * classified from the invoice alone, as before.
 *
 * An invoice marked emergencyServices (KRS 367.626(3)) is never held and
 * needs no lead read.
 */
'use strict';

const KyLaw = require('./ky-insurance-law');

/**
 * kyPayLinkGate({ invoice, readLead, readProfile, now })
 *   readLead(leadId)  → Promise<lead object | null (doc does not exist)>; may throw
 *   readProfile()     → Promise<companyProfile object | null>; may throw
 * → Promise<{ held, releaseDate, reason, tz }>
 *   reason: '' | 'emergency' | 'ky_window' | 'lead_unreadable' | 'lead_missing'
 */
async function kyPayLinkGate(opts) {
  const o = opts || {};
  const invoice = o.invoice || {};
  if (invoice.emergencyServices === true) return { held: false, releaseDate: '', reason: 'emergency', tz: '' };

  let tz = KyLaw.DEFAULT_TIME_ZONE;
  try {
    const p = typeof o.readProfile === 'function' ? await o.readProfile() : null;
    if (p) tz = KyLaw.resolveTimeZone(p);
  } catch (_) { /* default zone */ }

  let lead = null;
  if (invoice.leadId) {
    try {
      lead = await o.readLead(String(invoice.leadId));
    } catch (e) {
      return { held: true, releaseDate: '', reason: 'lead_unreadable', tz, error: (e && e.message) || String(e) };
    }
    if (!lead || typeof lead !== 'object') return { held: true, releaseDate: '', reason: 'lead_missing', tz };
  }

  const hold = KyLaw.payLinkHold(lead, invoice, o.now == null ? Date.now() : o.now, tz);
  return { held: !!hold.held, releaseDate: hold.releaseDate || '', reason: hold.held ? 'ky_window' : '', tz };
}

// Shown when the lead cannot be read — the rep can retry, or fix the link.
const LEAD_UNREADABLE_MESSAGE =
  'Online payment link withheld: this invoice\'s customer record could not be read, so the Kentucky insurance-job ' +
  'payment rule (KRS 367.626) could not be checked. Try again; if the customer was deleted, re-link the invoice to the right customer.';

module.exports = { kyPayLinkGate, LEAD_UNREADABLE_MESSAGE };
