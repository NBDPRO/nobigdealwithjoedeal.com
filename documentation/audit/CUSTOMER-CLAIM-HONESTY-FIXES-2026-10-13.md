# Customer-facing claim honesty fixes — 2026-10-13

Source list: the honesty/contradiction section of
`CONTRACT-LANGUAGE-INVENTORY-2026-10-13` (PR #2429, `documentation/projects/`)
(§0 item 6, §2D/§2E, §3.5, §4). Rule applied: remove or correct to match
Jo's standing rules (Fully insured, never Licensed; 7+ years, no founding
year; crews are independent subs; no claim-outcome promises; on Kentucky
insurance jobs no "we handle/negotiate the claim", no AOB, no advance pay,
at most $100 to the insured, no deductible waiver). **No new legal clauses and
no new promises were added.** Guard: `tests/customer-claim-honesty-2026-10-13.test.js`
(every absence assertion has a positive control; each fix was break-tested by
reverting its file and confirming which assertions redden).

## Fixed

| # | Statement | Where (after this change) | What it is now |
|---|---|---|---|
| 1 | "negotiate with my insurance company on my behalf and … receive payment directly from the insurance carrier" (legacy Work Authorization) | `docs/pro/js/dashboard-ui.js` `DOC_TEMPLATES` — the `authorization` entry is deleted. `openDocTemplate` has no caller in `docs/`, so the template was unreachable; the function and the other blank forms stay (smoke pins the export) | Gone. The comment above `_nbdDocCompany` no longer quotes the sentence |
| 2 | Testimonial Sheet fallback of four invented "Satisfied Homeowner" quotes | `docs/pro/js/document-generator-templates.js:2538-2600` (`renderTestimonialSheet`) | Only rep-entered quotes render. Nothing entered prints "No customer reviews have been added to this sheet yet. Add a real quote from a customer who agreed to share it before printing." and no stars or "Would Recommend" stat |
| 3a | Claim guide "We handle the hard parts" | `document-generator-templates.js:2324` | "Your insurance company decides your claim; we are here to inspect, document and estimate the repair." |
| 3b | "classified as Acts of God … do not result in rate increases" | `document-generator-templates.js:2353` | "Your insurance company and your policy decide that, and we cannot predict it. Your insurer or agent can tell you …" |
| 3c | "Most claims are approved within 2-4 weeks" (a carrier-outcome promise in the same guide) | `document-generator-templates.js:2361` | "How long a claim takes is up to your insurance company." |
| 3d | Public page: "insurance companies cannot raise your rates for a single weather-related claim" (visible FAQ and FAQPage JSON-LD) | `docs/services/hail-damage-insurance-claim.html:356, 874` | Hedged: rates are set by the insurer and policy; "I can't promise a claim won't affect yours". The other storm pages already hedge ("typically", "less likely") and were left |
| 4 | Referral card bonus literal `250` (code pays $100) | `docs/pro/js/doc-preflight.js:1547` | `literal:100`. The test reads `REFERRAL_BONUS_USD` from `functions/referral-rewards.js` and requires the two to match, so a future change to the constant reddens the card. No shared client config exists, so the literal remains a literal. The card's terms also said "upon completion"; the code credits at the Closed stage, so they now say "when the referred job closes" (matches the $100-per-closed-job email) |
| 5 | Default contract payment-methods sentence "No cash payments accepted" | `docs/pro/js/company-profile.js:127-128` (`paymentMethodsNoCash`) | "Payment may be made by check, ACH transfer, credit card, Zelle, or cash. Material delays may extend timeline." Evidence: the CRM records Cash and Zelle receipts (`customer-tasks-ui.js:636`, `doc-preflight.js:1182`), the Stripe invoice footer offers Zelle or check (`functions/stripe-crm-invoice.js:58-62`), and [NEXT_SESSION-2026-09-26](../projects/NEXT_SESSION-2026-09-26.md) records the NBD profile's field already set to accept cash on Jo's OK. The field name still says "NoCash" (renaming touches tenant data; left) |

Cache-busters bumped: `dashboard-ui.js` 13 to 14, `company-profile.js` 9 to 10
(`dashboard.html`, `customer.html`), `document-generator-templates.js` 18 to 19
and `doc-preflight.js` 12 to 13 (`script-loader.js`).

## Left, and why

**6. "Backed personally by Joe Deal"** — `functions/print/templates/warranty.hbs:138`
and `docs/pro/js/warranty-cert.js:343` (NBD only). It conflicts with the
default limitation-of-liability sentence ("NBD's total liability shall not
exceed the contract price", `company-profile.js:~133`) and with a company that
may be an LLC, but whether to keep, soften or cut a personal-backing statement
is a legal judgment about who stands behind the warranty. **Left for the
attorney.** Nothing elsewhere in the warranty terms (tiers, manufacturer
warranties) makes a personal promise either way.

**7. Contracting-entity variants (not changed; needs Jo and the attorney):**

| Form on paper | Where |
|---|---|
| "No Big Deal Solutions LLC" (DBA No Big Deal Home Solutions) | `docs/terms.html:432, 443, 506` |
| "No Big Deal Home Solutions, LLC" (invoice payee line) | `functions/stripe-crm-invoice.js:61` |
| "No Big Deal Home Solutions, a sole proprietorship owned and operated by Joe Deal" | `docs/pro/terms.html:326` |
| "No Big Deal Home Solutions" (brand `legalName`; printed on contracts, footers, certificates) | `docs/pro/js/company-profile.js:184` |
| "No Big Deal Roofing" (SMS sign-off, "Joe from No Big Deal Roofing") | `docs/pro/js/company-profile.js:191` |

## Left for the attorney / Jo (not touched)

- The personal-backing certificate line (item 6) and the entity name (item 7).
- Rep-editable prefills in `docs/pro/js/doc-preflight.js:1604-1606` that still
  predict carrier timing ("30-60 days from claim filing", "Adjuster will
  contact you within 48-72 hours"). They are editable defaults, not fixed copy;
  worth a decision on whether they belong.
- Internal rep-training scripts in `docs/pro/js/sales-training-engine.js`
  (lines ~175, 182, 557, 571, 1394) teach "it won't raise your rates / insurers
  can't raise rates for weather claims". Not customer paper, but reps may say
  it aloud; same fix as 3b if Jo wants it.
- The blank "License # ________" on the legacy Supplement Request form
  (`dashboard-ui.js:1482`) and the licence-number settings fields
  (`dashboard.html:3125, 4140-4141`): fillable by the tenant, not a claim NBD
  makes; unchanged.
- "Work will not commence until the deposit payment has been received"
  (`templates.js:2773`), the 10-day vs ten-business-day refund wording, the
  Kentucky statute cited for Ohio jobs, "7+ Years Insurance restoration" on
  `partners.html:823` beside KY's specialist-holding-out ban, and the rest of
  inventory §4/§5 are legal-drafting questions outside this lane.
