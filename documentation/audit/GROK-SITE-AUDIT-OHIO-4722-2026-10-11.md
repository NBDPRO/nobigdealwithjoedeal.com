# Grok public-site audit + Ohio ORC 4722 — 2026-10-11

Jo had Claude talk to Grok (grok.com, Expert mode, public-site only, no repo
access) and asked what could genuinely help. Per the standing rule, every Grok
claim is a **lead until verified**. This note records what was checked, what
held, what did not, and the one finding that is real and unaddressed.

## Verdict table

| Grok claim | Result | Evidence |
| --- | --- | --- |
| /privacy is "thin / navigation only" | **FALSE** | `docs/privacy.html` is 67 KB: collection, free tools, cookies, 20+ named providers, Thursday phone assistant, recorded calls |
| /terms is "essentially the independent-contractor disclaimer only" | **FALSE** | `docs/terms.html` has SMS terms, Estimates and Contracts, Scheduling, Insurance Claims, Website Content |
| KY wording lacks the 367.624 notice / cancellation form | **Partly false** | CRM already issues KRS 367.624 notices + detachable Notice of Cancellation (`docs/pro/customer.html` ~L2786) and holds payment per 367.626; public pages cite 367.628 for deductibles |
| "Licensed & Insured" may read as a state license | **Not found** | `git grep` over `docs/**/*.html` finds only generic homeowner advice ("pick a roofer who is licensed, insured"), no NBD license claim; claim wording is already CI-gated |
| ORC 4722 amended "by HB 50, effective ~Sept 2024" | **UNCONFIRMED** | codes.ohio.gov shows 4722.02 effective 2012 with HB 383 as latest legislation; the HB 50 date is not on the page |
| ORC 4722 requires a written contract at ≥ $25,000 with listed contents | **VERIFIED** | codes.ohio.gov §4722.01, §4722.02 (fetched 2026-10-11) |
| ORC 4722 caps down payments at 10% | **VERIFIED** | §4722.04, below |
| Storm Alerts lacks an accuracy caveat | **LEAD, plausible** | `docs/storm-check.html` has the disclaimer (L512); `storm-alerts.html` has none matching "not a substitute / radar" |

## The real finding: Ohio 10% down-payment cap vs the 50% deposit rule

Statute text, fetched from codes.ohio.gov:

- **§4722.01(B)** "home construction service" includes "the repair,
  improvement, remodel, or renovation of an existing structure" — a roof or
  siding replacement qualifies (not for structures with 4+ dwelling units).
- **§4722.01(D)** a "supplier" maintains general liability insurance of "not
  less than two hundred fifty thousand dollars."
- **§4722.02(A)** a written contract is required when the cost "equals or
  exceeds twenty-five thousand dollars", stating: supplier name, address,
  phone and TIN; owner name, address, phone; property location; general
  description; expected start and completion dates/periods; total estimated
  cost plus any costs not covered; proof of the $250,000 liability policy;
  dated signatures. **(C)** cost-plus contracts are exempt from (A) and (B).
  **(B)(1)** excess costs over $5,000 over the contract need notice.
- **§4722.04** "A home construction service supplier may take as a down
  payment not more than ten per cent of the contract price before the
  supplier's performance … begins, except … not more than seventy-five per
  cent of the total cost of any special order item that is otherwise not
  returnable or usable." Cost-plus contracts are exempt; construction-loan
  payments may be accepted.
- **§4722.07** civil penalties up to $5,000 per day / $25,000 per violation.

**Conflict.** `docs/pro/js/deposit-rule.js` sets `CASH_DEPOSIT_PCT: 50`
(cash jobs ≥ $2,000: 50% at signing) with no Ohio or contract-size
exception, and nothing in the repo mentions 4722 (`git grep 4722` returns
only unrelated hits). On an Ohio cash job at or above $25,000, a 50% deposit
exceeds the statutory 10% cap. The insurance-job rule (deposit = deductible)
is usually far under 10% on a $25k+ roof but is not checked against it either.

**Proposed change (not made — money logic, needs Jo's yes):** in
`deposit-rule.js`, for an Ohio property address and a contract total ≥ the
$25,000 threshold (non-cost-plus), cap the signing deposit at 10% of contract
price (config-driven, with the 75% special-order exception only if a special
order line exists), and surface the contents checklist above on the contract
template for those jobs. Thresholds and percentages live in config, not code.

**Counsel questions** (this is a reading of statute text, not legal advice):
1. Does §4722.04's cap apply to contracts under $25,000 or only above it? The
   page text states no dollar trigger for §4722.04 itself; §4722.01(C) defines
   a "home construction service contract" as one "exceeding" $25,000.
2. Is a roofing/siding job "cost-plus" if priced per square with measured
   adjustments? (We believe no.)
3. How should the 10% cap interact with a financed job (§4722.04 allows
   construction-loan payments)?
4. Does NBD's general liability limit meet the $250,000 floor, and is the
   certificate attached to Ohio contracts ≥ $25,000?
5. Is the ESIGN-signed contract with a dated signature sufficient for
   §4722.02(A)(9)?

## Where Grok actually helped

- Surfaced 4722 (a gap nobody in this repo had named).
- Free-tool pages and /our-work: its read matched the repo (disclaimers,
  price-year notes).
- It was wrong on two of five "thin page" style claims because its fetcher
  returned navigation only — **its page-level reads need a spot check**.

## Not done / next

- Jo's decision on the deposit cap change above.
- Add an accuracy caveat to `docs/storm-alerts.html` (low risk copy edit;
  respect the claim-wording gate).
- Optional: map the §4722.02 contents list onto the contract template fields
  and list the missing ones.
