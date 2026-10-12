# Ohio ORC 4722.04 down-payment cap in the deposit rule — 2026-10-11

**Counsel should confirm.** This is Jo's approved change built from a reading of
statute text (codes.ohio.gov, fetched 2026-10-11), not legal advice. Every
number and switch below is config, so counsel's answer changes a value, not the
code.

Source finding: the Grok public-site audit (PR #2337, the audit note
`GROK-SITE-AUDIT-OHIO-4722-2026-10-11` under `documentation/audit/`) found that
`docs/pro/js/deposit-rule.js` asked a flat 50% at signing on cash jobs of
$2,000 and up, with nothing about Ohio home-construction contracts of $25,000
or more, where ORC 4722.04 limits the down payment.

## The rule as built

All of it lives in `docs/pro/js/deposit-rule.js` (byte-identical server copy
`functions/deposit-rule.js`; defaults mirrored in
`estimate-config.js` `DEPOSIT_RULE`, pinned by `tests/deposit-rule.test.js`).

| Key | Default | Meaning |
| --- | --- | --- |
| `OH_CAP_ENABLED` | 1 | switch the cap off if counsel says it does not apply |
| `OH_CAP_MIN_CENTS` | 2,500,000 | contract price at or above this is covered |
| `OH_CAP_PCT` | 10 | most that may be taken at signing, % of contract price |
| `OH_SPECIAL_ORDER_PCT` | 75 | of a special-order, non-returnable item, on top of the cap |
| `OH_MILESTONE_ENABLED` | 1 | payment 2 is due when materials are delivered / work begins |
| `OH_MILESTONE_PCT` | 40 | payment 2, % of contract price (10 / 40 / 50) |

Threshold: 4722.01(C) defines the contract as one "exceeding" $25,000 but
4722.02(A) says "equals or exceeds"; we treat **>= $25,000.00 as covered**
(safe side). Boundaries are tested at $24,999.99 / $25,000.00 / $25,000.01.

"Ohio" is the **property** address state (`ky-insurance-law.js` `classify()`,
the reader the Kentucky hold uses), never the company's home state. Missing
state: no cap (conservative), but the plan carries `stateWarning` and the
rep-facing `repNote` on any job at or above the threshold.

### The five legal routes

1. **The cap**: signing deposit = min(rule deposit, 10% of the contract),
   rounded **down** to the $25 step so it never exceeds 10%.
2. **Special-order allowance**: per-estimate input *Special-order materials ($)*
   in the V2/V3 builder (no line-level flag exists in the estimate rows, so it
   is an explicit, saved, visible number — `specialOrderAmount` on the estimate
   doc). 75% of it is collected on top of the 10%, shown as its own row.
3. **Milestone schedule**: 10 / 40 / 50 by default. Payment 2 is worded "when
   your materials are delivered or work begins" — never "at signing". On the
   invoice it is **held** (see below) until the rep releases it.
4. **Construction-loan jobs**: per-estimate *Construction-loan job* checkbox
   (`constructionLoan`); the cap is not applied and the rep is told why.
5. **Insurance jobs**: the deductible stays the signing deposit. If it is more
   than 10% it is capped, the rest of the deductible plus the ACV payment move
   to the delivery / start payment (the deductible is still collected in full,
   never waived), and the rep-facing note says why. **Kentucky is untouched**:
   the KY hold runs first, nothing at signing, a rep override cannot raise it.

Rep overrides cannot beat the cap; an override below it is honoured. Not
modelled on purpose: **cost-plus** contracts (4722.02(C) / .04 exempt them) —
not recommended without counsel.

### Surfaces (all through the one rule)

| Surface | How it picks the cap up |
| --- | --- |
| V2 builder deposit line + V3 wizard (Review step) | `_depositPlanFor` passes the customer address, linked lead, special order, loan flag; two new inputs saved with the estimate |
| On-screen Retail / Single Quote, server Retail Quote PDF | the stamped plan's rows and summary |
| Saved estimate, portal, estimate-view | `toStored` carries rows + an `ohio` block (cents only); `deposit-plan-view.js` whitelist unchanged |
| Contract (doc pre-flight → contract.hbs) | plan summary + schedule table; Payment 1 = capped signing amount, Payment 2 = milestone (+ ACV / rest of deductible on insurance) |
| Invoice (CRM + signing-day server draft) | `depositAmount` = signing deposit; stamped `ohioHold` / `milestoneAmount` / `milestoneReleased` |
| Pay link / Stripe invoice / portal card | `invoice-charge.js` `chargeDueNow`: deposit, then **scheduled ($0, no link)**, then milestone once released, then balance; `stripe.js` refuses a link while scheduled; portal says "nothing due yet — next payment …" |
| Rep control | invoice detail: *Materials delivered / work begun — release next payment* (`releaseMilestone`) |
| Close board / deal room | per-tier deposit via `fromEstimate` on a `depositBasis` that now carries `specialOrderAmount` + `constructionLoan`; a "Then $X when your materials are delivered or work begins" line |
| Options sheet (document library) | the same "then" clause |
| Company-profile policy text, ask-joe-rules fallback, `policyText()` | one Ohio sentence, equal in all three (a test pins them) |
| `/pro` landing page | the "Deposits follow one rule" bullet now names the Ohio 10% |

Public marketing pages (`docs/*.html`, blog, llms) state **no** deposit
percentage (grep'd: only a blog tip warning against big cash deposits), so
nothing there needed a change; no legal claim was added to any public page.

## Counsel questions (new ones marked *)

1. Does the cap apply to contracts under $25,000, or only above? (audit Q1) —
   built as "at or above $25,000".
2. Is per-square pricing with measured adjustments "cost-plus"? (audit Q2) —
   assumed no.
3. Construction loan interaction (audit Q3) — built as "not capped".
4. *Does materials delivery count as "performance begins"?* Payment 2 is due on
   delivery / start; if delivery is **before** performance begins, it is a
   down payment and the 10% applies to it. Switch `OH_MILESTONE_ENABLED` to 0
   (rest on completion) or move the trigger to "work begins" only.
5. *Does "total cost of any special order item" mean the price to the
   homeowner or NBD's cost?* Built on the homeowner price on the estimate (the
   statute uses "cost" for the owner's price elsewhere); NBD's own cost is
   never entered or stored.
6. *Insurance:* the ACV check is paid by the carrier to the homeowner; is it a
   "down payment" taken by the supplier? Built conservatively as yes — it moves
   to the delivery / start payment. If counsel says no, it can come back up
   front.
7. *Contract contents* (4722.02(A): TIN, liability proof >= $250,000, start and
   completion dates) are **not** added to the contract template by this change.
8. Audit Q4 / Q5 (liability certificate on Ohio contracts, ESIGN dated
   signature) are unchanged and still open.

## Evidence

- `tests/ohio-4722-deposit-cap-2026-10-11.test.js` (122 checks, in the CI
  manifest) — the pure rule, boundaries, special order, milestone config,
  loan flag, Kentucky unchanged, missing-state warning, invoice hold, deal
  draft, builder wiring.
- `tests/deposit-rule.test.js` — four Ohio cases added to the **every-surface
  table** (A rule, B V2 builder, C on-screen quote, D server PDF, E save,
  F invoice, G portal / estimate-view, H contract, I close board, J job
  templates, K engine): 159 additional assertions, plus pre-flight Payment 1/2.
- Break-tests (each reddens the assertion that names the behaviour):
  threshold `>` instead of `>=` → the $25,000.00 case; cap every state → KY and
  IN cash cases; loan flag ignored → the loan cases; special order 100% → the
  $6,000 case; unknown state treated as Ohio → no-cap + warning; milestone due
  "At signing" → summary / row due; round-to-nearest → the $27,432.18 case;
  insurance ignores cap → both Ohio insurance cases; KY hold neutered → the
  four KY assertions; override beats cap → the 60% override case; invoice hold
  removed → scheduled / released / portal card; `fromEstimate` drops special
  order → invoice + contract rows; close-board basis drops it → deal-room tier
  line; doc-preflight Payment 2 ignoring the milestone → the two pre-flight
  checks (found a gap in the first pass, closed).

## Left open / not done

- The classic (pre-V2) estimate builder has no special-order / loan inputs; it
  gets the cap from the property address and shows the warning for an unknown
  state.
- Releasing the next payment is a rep tap; nothing auto-releases from the job
  spine's `materials_delivered` stage.
- The contract template does not yet print the 4722.02(A) contents list.
