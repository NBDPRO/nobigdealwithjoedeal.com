# No signed agreement, no payment (2026-11-27)

**Why.** Two "same-day emergency tarp" jobs were paid in full by text with nothing signed. Both times the customer cancelled once the rain stopped and argued the money back. The second one (Brotherton Rd, Cincinnati) was paid by card on a Stripe invoice that read only "Same-day emergency roof tarping – $600". Jo's decisions, in chat on 2026-11-27:

- Update the website terms **and** the contract wording, not only payments.
- Customers agree to terms on the pay page through **Stripe's required "I agree" checkbox** (Stripe keeps the record with the payment).
- **Hard block, no override:** no pay link until a signed agreement is on file, Jo included.
- **Ship now, attorney after.** This sets aside the "no clause ships before LegalShield review" rule in [CONTRACT-LANGUAGE-STATUS-2026-10-22](CONTRACT-LANGUAGE-STATUS-2026-10-22.md) for this wording only. The attorney still reviews it.

## What changed

| Piece | Where | Effect |
|---|---|---|
| Signed-agreement gate | `functions/pay-agreement-gate-logic.js`, wired in `functions/stripe.js` `createStripePaymentLink` after the Kentucky gate | Platform tenant (NBD) only. A pay link is refused (409 `NO_SIGNED_AGREEMENT`) unless the lead has a `job_events` marker for `contract_signed` / `deal_accepted`, or (jobs signed before the spine existed) a signed estimate (`signatureStatus` or `signedPrice`). An invoice marked `emergencyServices` instead needs a signed **Emergency Services Request** in `leads/{id}/documents`. Fails closed. No override. Connect tenants are unchanged. |
| Terms checkbox | Same mint; `termsConsentParams()` | NBD's payment link sets `consent_collection.terms_of_service: 'required'` plus custom text linking `/terms#payment-terms`. Stripe stores `consent.terms_of_service = accepted` on the Checkout Session. |
| Link instead of Stripe Invoice | `functions/.env.nobigdeal-pro` `NBD_CRM_STRIPE_INVOICES=off` | A Stripe Invoice's hosted page cannot require a checkbox, so NBD goes back to payment links (ACH still offered). When the new link is minted, any open unpaid `in_` invoice still on the CRM invoice is voided; a partly paid one refuses the mint. |
| Emergency form terms | `p5-forms.js` (both twins), `document-generator-library.js` | The Emergency Services Request now prints seven emergency service terms with a required "I agree" tick (`ack:em_terms`). The terms cover: a non-refundable dispatch fee once the crew is sent, temporary work with no warranty, on-site pricing approved by text, access and safety, authority and HOA, interior water damage, and changes/disputes in writing with a liability cap. |
| Emergency button | `invoice-pipeline.js` | "Emergency tarp / repair invoice" now shows on any unpaid invoice with no link, not only Kentucky holds. Its confirmation says the signed request comes first. |
| Public terms | `docs/terms.html` | New §3 Payments, Deposits and Refunds (`#payment-terms`) and §4 Emergency Tarp and Repair Service (`#emergency-service`); §2 now says no payment before signing and no changes except in writing. Sections renumbered; last updated November 27, 2026. |

Tests: `tests/pay-agreement-gate-2026-11-27.test.js` (new). Updated: the money-test fake Firestore answers the gate's query, the Emergency Services Request now has three ticks, and the terms date pin changed. Asset versions bumped.

## Before this works in production (Jo)

1. **Stripe → Settings → Public details:** set Terms of service URL = `https://nobigdealwithjoedeal.com/terms` (and Privacy = `/privacy`). Without it Stripe refuses every NBD link that has the checkbox, so Pay Online fails closed until it is set.
2. **Stripe → Settings → Business details:** the product description reads "Online business education courses and software tools…". Roofing jobs are charged on this account, and a card dispute is judged against that description. Make it describe the roofing work too.
3. **Turn on the clause set for yourself:** the Emergency Services Request card sits behind `docClauseSetV1` (Firestore `feature_flags/{your uid}`). With the flag off, the form can't be sent, so emergency invoices can't get a pay link. Turning it on also prints the v1 contract clauses (access, HOA, limits, changes in writing), which is the "ship now" decision.
4. **Payments made by hand in the Stripe Dashboard skip every CRM gate.** Don't make customer invoices there.
5. **Attorney review** of the new `/terms` §3–§4 and the emergency terms (add them to [ATTORNEY-REVIEW-PACKET-2026-11-18](ATTORNEY-REVIEW-PACKET-2026-11-18.md) §6).

## Not done (follow-ups)
- The CRM does not store the Stripe `consent.terms_of_service` result on the invoice (Stripe holds it, which is the record a dispute uses).
- Connect tenants' links carry no checkbox: their terms are not on the platform account.
