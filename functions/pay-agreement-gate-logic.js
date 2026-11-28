/**
 * pay-agreement-gate-logic.js — may createStripePaymentLink take money on this
 * invoice? Only when a SIGNED agreement is on file (Jo, 2026-11-27: "We have
 * to have all agreements before payment, strictly").
 *
 * Why: two "same-day emergency tarp" jobs were paid in full by text with no
 * signed terms, then the customer cancelled and argued the money back. A pay
 * link may now be minted only when:
 *   - an ordinary invoice: the lead has a signed contract, i.e. a server-only
 *     job_events marker for contract_signed / deal_accepted (job-spine.js
 *     writes one on every signing path: deal room, e-sign envelope, remote
 *     link, in person), or, for jobs signed before the spine existed, the
 *     estimate is signed (e-sign signatureStatus or the server-only
 *     signedPrice stamp);
 *   - an invoice marked emergencyServices: the lead has a signed Emergency
 *     Services Request (leads/{id}/documents, type emergency_services_request,
 *     status signed). That form carries the emergency terms (dispatch fee,
 *     temporary work, access, HOA authority).
 * No override (Jo's choice). An invoice with no lead is refused: there is no
 * customer to hold an agreement.
 *
 * FAIL CLOSED: a read that throws refuses the link.
 *
 * Zero deps; the reads are injected (tests/pay-agreement-gate-2026-11-27.test.js).
 */
'use strict';

const SIGN_EVENTS = ['contract_signed', 'deal_accepted'];
const ESR_TYPE = 'emergency_services_request';

/** Signed by e-sign (signatureStatus) or stamped by the job spine (signedPrice). Same rule as portal-after-signing.js. */
function estimateIsSigned(est) {
  if (!est || est.deleted === true) return false;
  if (est.signatureStatus === 'signed') return true;
  const sp = est.signedPrice;
  return !!(sp && typeof sp === 'object' && Number(sp.totalCents) > 0);
}

const MSG = {
  noLead: 'No payment link: this invoice is not linked to a customer, so there is no signed agreement on file. '
    + 'Link it to the customer, get the agreement signed, then create the link. Nothing was charged.',
  noContract: 'No payment link until the customer signs the agreement. Send the contract (or the deal room) for signature; '
    + 'the pay link unlocks as soon as it is signed. Nothing was charged.',
  noEmergencyForm: 'No payment link for emergency work until the customer signs the Emergency Services Request '
    + '(Documents → Emergency Services Request). It carries the dispatch-fee, temporary-work and access terms. Nothing was charged.',
  unreadable: 'No payment link: the signed agreement could not be checked right now. Try again in a minute. Nothing was charged.',
};

/**
 * payAgreementGate({ invoice, readLead, hasSignEvent, readEstimate, hasSignedEmergencyForm })
 *   readLead(leadId)               → Promise<lead | null>
 *   hasSignEvent(leadId)           → Promise<bool>  (job_events marker for a signing event)
 *   readEstimate(estimateId)       → Promise<estimate | null>
 *   hasSignedEmergencyForm(leadId) → Promise<bool>
 * → Promise<{ ok, reason, via?, message? }>
 *   reason: 'contract' | 'estimate' | 'emergency_form' | 'no_lead' | 'no_contract' | 'no_emergency_form' | 'unreadable'
 */
async function payAgreementGate(opts) {
  const o = opts || {};
  const invoice = o.invoice || {};
  const leadId = invoice.leadId ? String(invoice.leadId) : '';
  if (!leadId) return { ok: false, reason: 'no_lead', message: MSG.noLead };

  try {
    if (invoice.emergencyServices === true) {
      if (await o.hasSignedEmergencyForm(leadId)) return { ok: true, reason: 'emergency_form' };
      return { ok: false, reason: 'no_emergency_form', message: MSG.noEmergencyForm };
    }

    if (await o.hasSignEvent(leadId)) return { ok: true, reason: 'contract' };

    // Jobs signed before the job spine (2026-10-03) carry no marker: the
    // invoice's own estimate, else the lead's primary estimate, signed.
    const lead = await o.readLead(leadId);
    const ids = [invoice.estimateId, lead && lead.primaryEstimateId]
      .filter((v, i, a) => typeof v === 'string' && v && a.indexOf(v) === i);
    for (const id of ids) {
      const est = await o.readEstimate(id);
      if (est && (!est.leadId || String(est.leadId) === leadId) && estimateIsSigned(est)) return { ok: true, reason: 'estimate' };
    }
    return { ok: false, reason: 'no_contract', message: MSG.noContract };
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: MSG.unreadable, error: (e && e.message) || String(e) };
  }
}

/** A lead documents row that is a signed Emergency Services Request. */
function isSignedEmergencyForm(row) {
  const d = row || {};
  return String(d.type || '') === ESR_TYPE && String(d.status || '') === 'signed' && !!d.signedAt && d.deleted !== true;
}

// The pay page's required "I agree" box (platform account's own links). Stripe allows Markdown links here; max 1200 chars.
const TERMS_URL = 'https://nobigdealwithjoedeal.com/terms#payment-terms';
const TERMS_ACCEPTANCE_TEXT = 'I agree to the agreement I signed with No Big Deal Home Solutions and to its '
  + '[Payment, Refund & Emergency Service Terms](' + TERMS_URL + '). I understand this payment is made under those terms, '
  + 'that any change, credit or refund counts only if it is in writing from No Big Deal, and that I will raise any concern '
  + 'with No Big Deal in writing before disputing this payment with my bank or card company.';

function termsConsentParams() {
  return {
    consent_collection: { terms_of_service: 'required' },
    custom_text: { terms_of_service_acceptance: { message: TERMS_ACCEPTANCE_TEXT } },
  };
}

module.exports = {
  payAgreementGate, isSignedEmergencyForm, estimateIsSigned, termsConsentParams,
  SIGN_EVENTS, ESR_TYPE, MSG, TERMS_URL, TERMS_ACCEPTANCE_TEXT,
};
