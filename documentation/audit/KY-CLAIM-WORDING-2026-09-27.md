# Insurance-claim wording Kentucky law allows — 2026-09-27

**Decision (Jo, 2026-09-27): "reword everywhere."** The public site marketed
Joe as the homeowner's claim handler ("Storm Damage? I Handle the Insurance
Claim for You" on 224 pages, plus ~150 more sentences). Branch
`fix/ky-claim-wording` rewords it to one compliant vocabulary and adds a CI
gate, [tests/claim-wording.test.js](../../tests/claim-wording.test.js).

## The law, briefly

KRS 367.628 (version effective July 15, 2026 —
[official text](https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=57393)):

- **(1)(a)1** — a contractor shall not represent, negotiate, or *advertise* to
  represent or negotiate, "as a public adjuster or otherwise", on behalf of an
  insured on an insurance claim.
- **(1)(a)2** — nor market itself as a claims specialist/expert, an insurance
  specialist/expert, or as affiliated with an insurer.
- **(1)(c)** — allowed: providing an estimate; conferring with the insurer's
  representative about damage *after* the insured has submitted the claim.
- **(2)** — on insurance-paid jobs: no paying/rebating the deductible, no
  allowance or discount against the fee, no compensation to the insured over
  $100 (bonus, credit, gift, referral fee…), no financial ties to public
  adjusters, appraisers or supplement specialists.

Ohio reserves negotiating claims for compensation to licensed public adjusters
(ORC ch. 3951), so one site-wide vocabulary covers both states.

## Vocabulary (before → after)

| Before | After |
|---|---|
| I Handle the Insurance Claim for You / I Handle the Claim (banner) | I Document It and Meet Your Adjuster / I Meet Your Adjuster |
| handle / manage / navigate the claim (start to finish) | document the damage, write the estimate, meet your adjuster on the roof |
| Insurance claims handled for you; fight for full claim approval | Insurance jobs, documented right; …you stay in charge of your claim |
| supplement negotiation(s); negotiate the shortfall | supplement documentation; submit the missing line items |
| adjuster coordination; coordinate with your carrier | adjuster meeting on site |
| advocate / advocacy for the scope | document everything needed for a complete scope |
| insurance claim help / assistance / support / expertise | claim documentation |
| insurance restoration specialist; claim experts; Storm Specialist | roofer with 7 years in insurance restoration; insurance restoration contractor; Storm Damage Roofer |
| I file the claim / file with your carrier | you file; I document it so you file with photos in hand |
| follow up with your carrier on your behalf; handle all communication | keep you posted; answer the adjuster's questions about the damage |

Facts unchanged (7 years, certifications, prices). No disclaimer banners.

## Counts (public docs/, excluding pro/admin/sites)

| Phrase family | Before | After |
|---|---|---|
| "I handle the insurance…" | 451 | 0 |
| handle(d) the/your (insurance) claim | 712 | 0 |
| supplement negotiat… | 79 | 0 |
| negotiat* (all) | 108 | 25 — all benign (public adjusters, "shouldn't feel like a negotiation", ACV) |
| advocate/advocacy | 8 (+6 advocacy) | 0 |
| insurance restoration specialist / "insurance claim expertise" / "claim experts" | ~35 | 0 |
| "…claim for you" | 493 | 0 |

The gate scans visible text, meta/og/twitter content, banner `data-long` /
`data-short`, JSON-LD and JS strings; each of its 14 rules is proven red on a
fixture and on a fixture tree.

## Flagged, NOT changed — KRS 367.628(2) territory

- **CRM referral bonus is $200** (`docs/pro/js/crm-leads.js`, "credits the
  $200 bonus on close"; `dashboard-state.js`), fed by the public `/inspect`
  referral-code field. (2) caps compensation to the insured at $100 on
  insurance-paid jobs — needs Jo's/counsel's read on who receives it and when.
- **CRM contract templates authorize the contractor to negotiate with the
  insurer on the homeowner's behalf** (`docs/pro/js/dashboard-ui.js`:
  "I authorize {{COMPANY}} to negotiate with my insurance company on my
  behalf…"; `document-generator-templates.js`: "negotiate directly with the
  insurance company regarding the scope and payment"). That is the (1)(a)1
  act itself, in a signed document. Highest-priority follow-up.
- `/free-roof` (one free roof a year) — a giveaway, not tied to insurance
  jobs; keep it that way.
- Deductible copy is all *warnings against* waiving/covering it; the financing
  blog's "deductible-plus-financing combo" is lender financing, not a rebate.
- `/partners` referral lane lists realtors, inspectors, trades, mitigation
  firms — no public adjusters/appraisers.

## CRM / functions (not edited — out of scope for this lane)

38 gate hits across 541 files in `docs/pro`, `docs/admin`, `docs/sites`,
`functions/`. Customer-facing ones: "Insurance Restoration Specialists"
brand tag in `functions/render-pdf.js`, `docs/pro/js/warranty-cert.js`,
`dashboard-ui.js`; "We handle the entire insurance claim process" in
`document-generator-templates.js` and `storm-center.js`; the negotiate
authorizations above. Top file: `docs/pro/js/sales-training-engine.js` (11,
internal training).

## Owed after merge

- The homepage banner text changed, so the CI "Visual regression (public pro
  pages)" `landing` shot will go red — re-bless from CI's `-actual.png`.
- Re-paste the changed citation-kit / GBP-services blocks on live directories.
