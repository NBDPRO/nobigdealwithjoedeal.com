# Template deep sweep: audit, gaps and new drafts (2026-11-17)

> **DRAFT for attorney review. Not legal advice.** Nothing here ships until the LegalShield attorney has reviewed it
> and Jo has signed off. This note builds on
> [CONTRACT-STRENGTHENING-PLAN-2026-10-13](CONTRACT-STRENGTHENING-PLAN-2026-10-13.md), which drafted the main contract
> clauses (lien, payment, late fees, change orders, warranty, disputes, e-sign). Most of that plan has **not shipped**:
> the live defaults in `docs/pro/js/company-profile.js` still carry the wrong statute cite and "under Kentucky law" on
> every job (re-checked 2026-11-17 on `origin/main` @ `b3876a701`). This note does not redo that plan. It adds what the
> plan left out (attic, ventilation, moisture, mold, pre-existing property conditions, and the missing forms) and audits
> every template against both.

**Jo's ask (2026-11-17):** a deep sweep of every template, as detailed and complete as possible; be extremely careful
with wording and liability; take Lomanco's ventilation guidance; add a checkbox sign-off the homeowner completes for an
attic inspection and ventilation check before any re-roof, covering unseen mold, ventilation problems and more; say
which templates are missing.

**Honesty rules that still apply to every draft below:** "fully insured", never "licensed"; GAF Certified and TAMKO Pro
Gold only (no Master Elite, no IKO); no claim-outcome or deductible promises; no "we handle your claim"; Kentucky
insurance-job limits (KRS 367.62x); crews are independent subcontractors, never "in-house"; no invented proof. The
banned-phrase tests (`tests/outbound-template-banned-phrases-*.test.js`, `tests/job-template-honest-paperwork.test.js`)
must stay green on any text that ships.

---

## Decisions log (Jo, 2026-11-17, grilling rounds 1 to 3)

Accepted as written in this note (still subject to attorney review, nothing ships before it):

| # | Decision |
| --- | --- |
| Q1 | Attic form is an acknowledgment, never called a "waiver". Fixed sentence that NBD stays responsible for its own work. |
| Q2 | Hard-block re-roof contract until the attic form is signed or the not-inspected page is signed; warn only on repairs. |
| Q3 | Required on full re-roofs and re-decks; offered on partial repairs and vent-only work; not on siding, gutters, windows. |
| Q4 | Form has a "may be mold or mildew, not tested" box; NBD never offers to test, identify or remove mold. |
| Q5 | Ventilation and decking prices pulled from estimate config; a "no" prints a warranty exclusion line. |
| Q6 | **CLOSED (Jo, 2026-11-17): the company is No Big Deal Solutions LLC; "No Big Deal Home Solutions" is its d/b/a.** Every contract names "No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions". `docs/pro/terms.html:327` ("a sole proprietorship owned and operated by Joe Deal") is wrong and must be corrected by the attorney. |
| Q7 | 3% credit-card fee only; debit and prepaid free; charged only when Stripe reports the card as credit. |
| Q8 | No card fee on Kentucky insurance jobs; Ohio insurance and cash jobs normal. |
| Q9 | Cash accepted, with a receipt. |
| Q10 | Late interest 8% simple after 15 days, mutual attorney fees, right to pause; no flat fee, no 1.5% a month. |
| Q11 | Restocking = supplier's actual documented cost, never a flat percentage; nothing owed inside the 3-day window. |
| Q12 | NBD keeps leftover materials, except special-order items paid for in full. |
| Q13 | Remove "Backed personally by Joe Deal"; keep the Pledge defined as on the public page. |
| Q14 | Build behind a feature flag, new contracts only; attorney reviews before the flag turns on. |
| Q15 | October plan decisions D1 to D12 adopted as drafting defaults except where overridden above. |
| Q16 | Not-inspected path records whose schedule it was; an NBD miss requires a make-up offer. |
| Q17 | Free attic check offered up to 3 days before the start date, even after declining. |
| Q18 | If the homeowner won't sign the not-inspected page, Jo approves proceeding; form sent by text or email with the date. |
| Q19 | A sent but unsigned form is logged as notice, never described as signed. |
| Q20 | Same per-sheet decking price either way; full workmanship warranty with the moisture/ventilation exclusion printed. |
| Q21 | Add per-sheet decking, soffit baffle and bath-fan duct lines to the catalog (prices from Jo). |
| Q22 | Add an estimate scope field (re-roof, repair, siding, gutters, other), defaulted from tear-off. |
| Q23 | Build order after the attic form and payment terms: property condition, decking authorization, emergency tarp request, final walkthrough and punch list, Ohio insurance acknowledgment. |
| Q24 | Closed with Q6. Jo (2026-11-17): the LLC is formed in **Kentucky**; the d/b/a **is not registered**; Jo signs as **Manager** (sole manager). |
| Q25 | Ohio contracts of $25,000 or more print insurer, policy number and expiry as an attachment; TIN only where the attorney says it must be on the contract. |
| Q26 | Card fee applies to new contracts only; the stray "A convenience fee may apply." text is removed. |
| Q27 | Wire instructions printed only on request, with a call-to-verify line; never sent by text. |
| Q28 | Recommendation lines with no catalog price are hidden until priced (per-sheet decking, soffit baffle, bath-fan duct). |
| Q29 | Doc committed locally on `docs/template-deep-sweep` with an INDEX link; no push until Jo says. |
| Q30 | Removal-only honesty fixes (personal-backing line, dead legacy insurance text, invented testimonial fallback, "cancel by calling") on a separate branch, each with a test; no legal rewording. |


---

## Part 1. The most important point about "waivers"

A homeowner checkbox **cannot** release NBD from its own negligence or bad workmanship, and trying to will hurt more
than help:

- Ohio voids construction hold-harmless terms for the contractor's own negligence (ORC 2305.31) and Kentucky does the
  same (KRS 371.180) (law memo, 2026-10-13). Those statutes cover indemnity, but courts look at broad "release
  everything" consumer terms the same way.
- A one-sided "homeowner releases NBD from all mold claims" sentence in a consumer form is the kind of term an Ohio
  CSPA (ORC 1345.03) or Kentucky KCPA (KRS 367.170) unconscionability argument targets. If a court strikes it, NBD has
  **less** protection than a narrow, honest form would have given.

What **does** hold up, and what the drafts below are built on:

1. **Disclosure.** NBD looked (or was not able to look), and told the homeowner in writing, with photos, what it saw.
2. **Informed choice.** NBD recommended specific work, priced it, and the homeowner accepted or declined each item,
   with initials beside each choice.
3. **Scope.** Conditions NBD did not cause and was not hired to fix are outside the contract and outside NBD's
   workmanship warranty, stated plainly.
4. **No expertise NBD does not have.** NBD is not a mold assessor, HVAC contractor, or home inspector, and says so.
   It does not test for or identify mold.
5. **A savings sentence.** "Nothing in this form limits NBD's responsibility for its own work." This sentence is what
   makes the rest of the form believable to a judge.

So the form is an **acknowledgment and declination**, not a "waiver". The name on the paper matters too: call it
"Attic, Ventilation & Moisture Acknowledgment", not "Liability Waiver".

---

## Part 2. NEW: Attic, Ventilation & Moisture Acknowledgment (pre-roof)

**When:** required before any full re-roof (and recommended before any re-deck or ventilation change). Signed at or
before contract signing, so the decision is part of the bargain, not something sprung on the homeowner at tear-off.
**Who signs:** homeowner (initials on each choice, signature at the end) and the NBD rep (signature, confirming what was
inspected).
**Gate (build):** the contract cannot be sent for signature on a re-roof job until this form is attached as signed,
or the rep records why it was not (see 2.7).
**Photos:** every "condition noted" box requires at least one photo in the job file; the form prints thumbnails.

### 2.1 Ventilation background (prints on the form, plain words)

Sources: Lomanco's ventilation FAQs and articles (read 2026-11-17); the 2021 IRC R806 ratios. Lomanco sells
ventilation products, so its figures are the maker's guidance. Local code and the shingle maker's own requirements
decide.

> **Why we check your attic before a new roof.** Your attic needs air moving through it all year. Air comes in low (at
> the soffits or eaves, called **intake**) and goes out high (at the ridge or roof vents, called **exhaust**). When
> that air flow is short, heat builds up in summer and moisture from the house condenses on the underside of the roof
> in winter. Over time that can lead to damp insulation, rotted roof decking, mold or mildew, ice dams, and shingles
> that wear out early. Moisture from inside the house (showers, cooking, laundry, breathing) rises into the attic, so
> bathroom, kitchen and dryer fans should vent outside the house, not into the attic.
>
> Common guidance is about 1 square foot of vent opening for every 300 square feet of attic floor, split about half
> intake and half exhaust, with exhaust at least 3 feet higher than intake. Some codes and attics call for 1 per 150.
> Intake should be at least as much as exhaust; too little intake is the most common reason a vent system fails, and
> it can cause exhaust vents to pull in rain or snow.
>
> A new roof does not fix moisture that comes from inside the house. If there is a moisture source (an unvented fan, a
> plumbing leak, air leaks from the living space, a humidifier), the problem can return under a new roof.

Do **not** print Lomanco's "9 out of 10 homes" figure or any other vendor statistic.

### 2.2 What NBD looked at (rep completes; one box)

> [ ] **We inspected the attic** on {{date}} from {{access point: hatch / pull-down stair / other}}. This was a
> visual check from the access point and walkable areas only. We did not move insulation or stored items, open walls or
> ceilings, or test anything.
>
> [ ] **We did not inspect the attic** because: [ ] no access opening [ ] access blocked by stored items
> [ ] you asked us not to [ ] unsafe to enter (no floor, heat, wiring, pests) [ ] finished or cathedral ceiling with no
> attic space [ ] other: {{text}}.
> Because we could not see the attic, we cannot tell you its condition. Conditions there are unknown to both of us.

### 2.3 What we saw (rep completes; each box needs a photo)

> [ ] No visible concerns from the access point.
> [ ] Dark staining or growth on the roof decking or framing **that may be mold or mildew**. We did not test it and
> cannot tell you what it is.
> [ ] Water staining on decking, framing or insulation (active or old: [ ] can't tell).
> [ ] Frost, condensation or damp insulation.
> [ ] Soft, delaminated, sagging or rotted decking or framing (visible areas only).
> [ ] Daylight through the roof deck.
> [ ] Bathroom, kitchen or dryer fan venting into the attic, or a disconnected duct.
> [ ] Soffit or eave intake blocked by insulation, paint, or solid soffit; no baffles.
> [ ] Little or no intake ventilation.
> [ ] Mixed exhaust types on the same attic (for example ridge vent plus box vents, turbines or a power fan).
> [ ] Signs of animals, insects or nests.
> [ ] Damaged or exposed wiring, HVAC equipment or ductwork in the attic (we note it; we do not inspect it).
> [ ] Other: {{text}}.
> Notes: {{text}}

### 2.4 Ventilation numbers (rep completes)

> Attic floor area (approx.): {{sq ft}} · Rule used: [ ] 1/300 [ ] 1/150 [ ] code official's requirement
> Vent area needed: {{sq in net free area}} (intake {{ }} / exhaust {{ }})
> Vent area now (estimated): intake {{ }} / exhaust {{ }}
> Shingle manufacturer: {{GAF / TAMKO / other}}. Its warranty conditions on ventilation apply to your roof.

The figures are estimates from what was visible; say so in the print ("approx." / "estimated").

### 2.5 Our recommendations and your choices (homeowner initials each line)

Each recommended item prints with its price from the estimate, and two initial boxes: **Yes, add it** / **No, leave it
out**. Nothing on this list is added to the price without a "Yes" initial.

> | Recommendation | Price | Yes, add it | No, leave it out |
> | --- | --- | --- | --- |
> | {{e.g. Add {{N}} ft of ridge vent}} | {{$}} | ___ | ___ |
> | {{e.g. Add soffit intake vents / cut in intake / install baffles}} | {{$}} | ___ | ___ |
> | {{e.g. Remove and cover existing box vents (no mixed exhaust)}} | {{$}} | ___ | ___ |
> | {{e.g. Re-route bath fan duct to a roof or wall cap}} | {{$}} | ___ | ___ |
> | {{e.g. Replace decking in visible damaged area, approx. {{N}} sheets}} | {{$}} | ___ | ___ |
> | Have a qualified mold or indoor-air professional look at the attic before work starts (you arrange and pay them) | - | ___ | ___ |
> | Have an HVAC or insulation contractor check moisture sources and air sealing (you arrange and pay them) | - | ___ | ___ |

### 2.6 Your acknowledgments (homeowner initials each)

> ___ **What we saw and recommended.** NBD showed me or sent me what it saw (with photos) and what it recommends, and I
> had the chance to ask questions.
>
> ___ **Items I declined.** I chose not to add the items marked "No". I understand that leaving them out may allow
> heat or moisture problems to continue or come back, may shorten the life of the new roof, and **may affect the
> shingle manufacturer's warranty**, which has its own ventilation conditions. NBD's workmanship warranty does not
> cover damage caused by a condition I chose not to correct.
>
> ___ **Existing conditions.** Mold, mildew, moisture damage, rot, and ventilation or moisture problems that existed
> before NBD started work, including in areas no one could see, are not part of this contract and are not caused by
> NBD's work. Correcting them is not included in the price unless it is listed in my contract or a signed change order.
>
> ___ **Not a mold, HVAC or home inspection.** NBD's check was a visual look by a roofing contractor. NBD does not test
> for, identify, or remove mold, and it does not inspect HVAC, electrical, plumbing or insulation systems. If I want
> those checked, I will hire a qualified professional.
>
> ___ **Moisture from inside the house.** A new roof and vents do not fix moisture coming from inside the house. Keeping
> fans vented outside, and fixing leaks and indoor humidity, is my responsibility.
>
> ___ **If more is found at tear-off.** If NBD finds rotted decking, framing damage, staining that may be mold, or other
> hidden conditions after removing the old roof, NBD will photograph them and tell me before doing extra work, as my
> contract's hidden-conditions section describes. The only exception is the minimum needed to make the home
> weather-tight that day.

### 2.7 Savings sentence and signatures (always prints, cannot be edited per job)

> **What this form does not do.** Nothing in this form limits NBD's responsibility for the work NBD does, or any right
> I have that the law does not allow to be given up. If NBD's own work causes a leak or damage, NBD remains responsible
> under my contract and warranty.
>
> Homeowner: ____________ Date: ______ · NBD representative: ____________ Date: ______

### 2.8 Wiring notes (for the build, not printed)

- Lives in `document-generator-library.js` beside `material_selection`; `defaultSigners: [HOMEOWNER, REP]`. The e-sign
  pages already support `checkbox`, `initials`, `signature`, `date` and `text` fields (`esign-sign.js:14`).
- Fields come from a rep-side "Attic check" panel on the job (so the photo count can be enforced). The recommendation
  table pulls lines and prices from the estimate's ventilation and decking add-ons, never hand-typed prices.
- A "No" on any ventilation recommendation sets `job.ventilationDeclined = true`, which the warranty certificate reads
  to print WAR-2's matching exclusion line with the date of this form.
- Version-stamp the form text (e.g. `ATTIC_ACK_V1`) and store the version on the signed record.
- Contract gate: re-roof contract cannot be sent until this form is signed **or** the rep records "not inspected" with a
  reason (2.2) and the homeowner initials that box.

---

### 2A. The situational path: attic NOT inspected (Jo, 2026-11-17)

Some jobs can't get an attic check: the homeowner won't allow it, schedules clash, the hatch is blocked, or it isn't
safe. The form has a second page for that case, so "we never looked" is a **signed, recorded choice** instead of a
silent skip. The path replaces 2.2's second checkbox; the rest of the form (2.5 recommendations still apply where they
can be made from outside the attic; 2.6 acknowledgments; 2.7 savings sentence) still prints.

**Rules the build must enforce**

1. The rep **cannot** skip the form. "Not inspected" needs one reason code, a note, and the homeowner's initials on
   the matching statement below. No homeowner initials means no contract send (except an emergency leak repair).
2. The reason says **who** could not: homeowner, NBD, or conditions. A missed NBD visit is never written as the
   homeowner's choice.
3. "Blocked" and "unsafe" need a photo (or a rep note if a photo is impossible).
4. The form does not say mold, rot or poor ventilation exist. It says **the condition is unknown to both of us**.

**Reason codes (rep picks one; text prints exactly as below)**

> [ ] **You chose not to have the attic checked.** NBD offered to look at the attic before your roof is replaced. You
> declined.
> [ ] **We could not schedule it.** The attic check did not fit the schedule before the work date. ({{who:
> [ ] your schedule [ ] NBD's schedule}})
> [ ] **No access.** There is no attic opening, or it is blocked or sealed (stored items, finished space, locked).
> [ ] **Not safe to enter.** (for example no flooring, extreme heat, exposed wiring, pests)
> [ ] **No attic space.** (cathedral or finished ceiling)
> [ ] Other: {{text}}

**Statement the homeowner initials (prints on every "not inspected" form)**

> ___ **The attic was not checked.** NBD did not inspect my attic before this work, for the reason marked above. The
> condition of my attic, including its ventilation, insulation, moisture, mold or mildew, and the roof decking from
> below, is **unknown to NBD and to me**.
>
> ___ **Offered and optional.** I understand a check was available (or would have been scheduled if I had asked) and
> that I can still ask for one before the work starts, at no charge, by telling NBD {{N}} days before the start date.
> {{Jo: confirm this offer.}}
>
> ___ **Unseen conditions.** I understand that problems that were not checked may exist, including mold or mildew,
> moisture damage, rotted decking, or poor ventilation, and that NBD is not responsible for conditions that were already
> there. If NBD sees any of these when the old roof is removed, NBD will photograph it and tell me before extra work, as
> my contract's hidden-conditions section explains. The manufacturer's warranty has its own ventilation conditions that
> I am responsible for knowing.
>
> ___ **What this does not change.** NBD remains responsible for its own work and warranty. This form does not give up
> any right the law does not allow to be given up.

**If the homeowner will not sign this page**

NBD can still do the job, but the contract does not go out as a standard re-roof contract. The rep records "declined to
sign attic form", sends the form by text or email with the date, and the job needs Jo's approval. Do not treat an
unsigned form as a signed one. The honest message to the homeowner is: "We can't tell you what's in the attic, and
we'd like you to know that in writing before we start."

**Build notes**

- Reason code and "who" saved on the job (`atticStatus`: inspected / not-inspected + `atticReason` + `atticWho`).
- The warranty certificate and the invoice follow-up read `atticStatus`: "not inspected" prints WAR-2's moisture and
  ventilation exclusion with the form date.
- A report lists re-roofs with "not inspected" so Jo sees how often it happens and why.

---

## Part 3. NEW: Terms of Payment, late fees, restocking and card surcharge (contract section + invoice reference)

Jo's ask (2026-11-17): put payment terms, late fees and restocking/inventory fees in, and charge 3% on all cards and
mobile payments, with Zelle, check, ACH and wire free of it. The earlier plan's legal frame still holds: **a fee that
appears only on an invoice is unenforceable in Ohio** (Minster Farmers; Sal's Heating, 2023-Ohio-3632). Every term
below lives in the contract the homeowner signs **before work starts**; invoices only point back to it.

### 3.1 Three things that change how the 3% can be done (read first)

1. **Debit and prepaid cards cannot be surcharged** under card-network rules, and mobile wallets (Apple Pay, Google
   Pay) are just a card underneath: credit-funded is surchargeable, debit-funded is not, and the merchant often cannot
   tell until the processor returns the card type. So "3% on all cards and mobile payments" is not allowed as written.
   The compliant version is **"3% on credit cards"**, applied only where the processor identifies the card as credit,
   with debit and prepaid charged nothing extra. (Source: PaymentCloud's state guide, read 2026-11-17; a secondary
   source, so confirm with the processor's own surcharge program terms.)
2. **Visa's cap is 3%; Mastercard's is 4% or the actual cost of acceptance, whichever is lower.** 3% sits at Visa's
   ceiling with no headroom. Stripe-type processing often costs under 3% for a given card, and Mastercard's rule
   caps the surcharge at actual cost, so a flat 3% can exceed Mastercard's limit on a cheap card. Set the rate in
   config so it can drop to 2.9% or lower if the processor says so.
3. **Process steps before the first surcharge:** card networks expect advance notice to the processor/acquirer
   (the source says 30 days to the networks; the processor handles this, ask them), a visible notice at the point
   of payment, and the surcharge shown as its own line on the receipt. A surprise surcharge on a payment link is
   what draws chargebacks and AG complaints.

**Kentucky and Ohio:** the source lists both as allowing surcharges up to the card-brand limits with disclosure. It
cites "Ohio Revised Code section 113.40" for Ohio, which looks wrong to me (not a consumer-payment section I recognize), and
its data was last updated August 2025. Treat state law as **unverified**: attorney question Q31 below.

**The alternative worth knowing about:** a *cash discount* (price list at the lower number, card payers pay the
list price) is often easier to defend than a surcharge, but it **cannot be used on Kentucky insurance jobs** (KRS
367.628(2)(c): no allowance or discount because a job is insurance-paid). A card surcharge on a Kentucky insurance
job may raise the same objection by looking like a price difference tied to the insurance payment. Safest draft:
**no surcharge on insurance-paid jobs in Kentucky until counsel clears it** (Q31). Also: the surcharge is part of
the price for CSPA purposes, so show the card total **before** the homeowner pays, and never bury it.

### 3.2 Contract section: Terms of Payment (draft)

> **Terms of Payment**
>
> **a. Price and what it covers.** The contract price is the price on the signed estimate for the work listed on it.
> Anything not listed is not included.
>
> **b. When payments are due.** {{deposit and balance terms, rendered from the shop's deposit rule, never typed
> by hand}}. The final payment is due within {{7}} days after NBD sends the final invoice.
>
> **c. Ways to pay with no added fee.** Zelle, check, ACH bank transfer, and wire transfer. **{{Cash: yes/no, Jo's
> call}}**.
>
> **d. Credit card fee.** If you pay by **credit card** (including a credit card used through Apple Pay, Google Pay or
> another mobile wallet), NBD adds a credit card fee of {{3}}% of the amount you pay by card. The fee is shown as its
> own line before you pay and on your receipt. **Debit and prepaid cards are not charged this fee.** The fee is not
> charged on a payment made by a method listed in (c). {{Kentucky insurance-paid jobs: no card fee.}}
>
> **e. Refunds of card fees.** If a payment you made by card is refunded, the card fee on the refunded part is
> refunded too.
>
> **f. Payments you dispute.** If you dispute part of an invoice, tell NBD in writing within {{10}} days of the invoice
> date and say what you dispute and why. The part you do not dispute is still due on time.
>
> **g. Late payments.** If an amount is not paid within {{15}} days after its due date, simple interest at {{8}}% per year
> (not compounded) applies to the unpaid amount until it is paid, or at the highest rate the law allows if that is
> lower. Interest does not apply to an amount you dispute in good faith in writing under (f) until the dispute is
> resolved, or to an amount your insurer or lender is not yet required to pay.
>
> **h. Returned payments.** If a check, ACH or card payment is returned or reversed, NBD may charge the actual fee its
> bank charged, up to {{$}}, as the law allows. {{Ohio and Kentucky returned-check limits: attorney to set (Q32).}}
>
> **i. Costs of collecting.** If either side must go to court to enforce this contract, the side that prevails
> recovers its reasonable attorney fees and court costs. If NBD sends an overdue amount to an attorney or collection
> agency, you also owe the reasonable fees and costs NBD actually paid to collect it. {{Kentucky: fees limited to
> amounts actually paid to an attorney who is not an NBD employee.}}
>
> **j. Right to pause work.** If a payment that is due is not made within {{5}} days after NBD's written notice, NBD may
> pause work until it is made. NBD will first make the roof weather-tight. Pausing is not a breach, and the schedule
> moves by the length of the pause.
>
> **k. Invoices do not change this contract.** Invoices, reminders and payment links are for convenience. The payment,
> late-payment and cost terms that apply to your job are the ones in this contract.

**Why 15 days and 8% simple instead of the 1.5% a month NBD has now:** the Oct 13 plan (D1) explains it. 1.5%
a month (18% a year) risks an Ohio usury argument and a Kentucky forfeit-all-interest penalty. Jo said "late fees";
interest plus fee-shifting plus the right to pause is the version that holds up. A **flat late fee** stays off by
default (D2). If Jo still wants one, it needs counsel's structure first (Q3).

### 3.3 Contract section: Materials, restocking and special orders (draft)

> **Materials, special orders and restocking**
>
> **a. Standard materials.** NBD orders materials for your job after the cancellation period has passed {{and, on
> Kentucky insurance jobs, after the insurer's coverage decision}}.
>
> **b. Special-order and custom items.** Items made or ordered to your selections (custom-color metal, specialty
> shingles, skylights, windows, doors, custom flashing) are listed on your estimate. Once ordered, they cannot be
> returned to the supplier.
>
> **c. [SUPERSEDED by Jo's 15% decision, Q36: for returnable standard stock use "a restocking fee of 15% of the price of the materials returned plus the actual delivery and pickup cost NBD pays"; special-order items stay at full actual cost.]** If you cancel **after** the cancellation
> period and NBD has already ordered or received materials for your job, you owe NBD: (1) the actual cost of special-
> order items that cannot be returned; (2) for standard stock that is returned, the supplier's restocking fee
> and the actual delivery and pickup costs NBD paid; and (3) the cost of work already done, at the contract rate.
> NBD will give you the supplier invoices on request and will credit you for anything it can return or reuse without
> a fee. NBD does not charge a restocking fee beyond what its supplier actually charges.
>
> **d. Cancellation inside the cancellation period.** If you cancel within the cancellation period shown in your
> Notice of Right to Cancel, none of (c) applies and your deposit is refunded as the notice says.
>
> **e. Leftover materials.** Leftover materials from your job belong to NBD {{or: are yours on request}}. {{Jo's
> call.}}
>
> **f. Delivery and storage.** If materials are delivered and the job is delayed more than {{14}} days because you
> are not ready (access, HOA approval, payment due), NBD may bill the actual storage or re-delivery cost.

**Honesty point on "restocking / inventory fees":** the draft charges **actual, documented cost**, not a flat
percentage. A flat "20% restocking fee" with no supplier invoice behind it reads as a penalty, and inside the 3-day
cancellation window it is illegal to keep anything beyond what the notice allows. Ohio jobs of $25,000 or more also
have a deposit structure (up to 75% of non-returnable special-order materials) that this section must match
(ORC 4722.04, per the Oct 13 plan, D4). Ask Jo for the real supplier return terms (ABC Supply / Beacon / other) so
section (c) states them correctly.

### 3.4 What the build needs

- `paymentMethodsNoCash` default currently reads "check, ACH, credit card, Zelle, or cash" and
  `latePaymentChargeText` reads "1.5% monthly finance charge": both contradict this draft and must be replaced (Oct 13
  plan, A2 PAY-7 and D10).
- Wire transfers need NBD's wire instructions on the invoice, delivered by a channel the homeowner can verify by
  phone (wire-fraud warning line: "Call us at {{phone}} before sending a wire; we never change bank details by email
  or text").
- Surcharge mechanics: compute only when the Stripe-returned card funding is `credit`; show the line on the payment
  page before the pay button, on the receipt, and on the invoice PDF; store `surchargePct`, `surchargeCents` and the
  card funding type on the payment record; refunds refund the proportional surcharge.
- The invoice and the payment link both print: "Pay free by Zelle, check, ACH or wire. Credit cards carry a {{3}}%
  fee."

### Additional attorney questions raised by this note

| # | Question |
| --- | --- |
| Q31 | Is a credit-card surcharge lawful for a roofing contractor in Ohio and Kentucky as drafted (credit only, disclosed in the contract and before payment)? Is it allowed on a Kentucky insurance-paid job given KRS 367.628(2)(b)-(d)? Does a surcharge count as part of the price for the Ohio 4722 $25,000 and CSPA rules? Cash-discount alternative? |
| Q32 | Returned-payment fee limits in each state; is "actual bank fee" the right structure? |
| Q33 | Restocking and special-order cost recovery after the cancellation period: does actual-cost recovery in 3.3(c) conflict with the Ohio and Kentucky cancellation statutes or CSPA? |
| Q34 | Attic acknowledgment (Part 2): does the declination structure hold up, is "may affect the shingle manufacturer's warranty" accurate for GAF and TAMKO, and should the form say anything about mold beyond "we do not test for it"? |
| Q35 | Entity facts: No Big Deal Solutions LLC (Kentucky), d/b/a No Big Deal Home Solutions, **not registered**. Kentucky requires an assumed name certificate (KRS 365.015) before an LLC does business under another name; the possible penalty (KRS 365.990, $25 to $100 fine, from a secondary source) is unverified. Ohio trade-name and foreign-LLC registration (NBD works in Cincinnati) is not researched. Signature block: "No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions, by Joe Deal, Manager". Every contract, invoice and warranty must name the LLC and its d/b/a; remove "sole proprietorship" from `docs/pro/terms.html:327`; reconsider "Backed personally by Joe Deal" (already being removed, Q13). |
| Q36 | Jo (2026-11-17): restocking is **15% of the returned standard materials plus actual reverse delivery**, replacing the actual-cost-only draft in 3.3(c). Guards: only after the cancellation window; only returnable standard stock; special-order items still owed at full actual cost; shown in the signed contract; never more than 15%; attorney to confirm a flat percentage is not a penalty (Q36 for counsel). |
| Q37 | Jo: hidden decking about **$100 per sheet** (his estimate). Proposed structure: one flat retail price per 4x8 sheet, like-for-like, up to 10 sheets; beyond 10 sheets, a written change order. Jo to confirm the number against his actual material and labor cost. |
| Q38 | Jo: register the "No Big Deal Home Solutions" assumed name ASAP (Kentucky Secretary of State, then the county clerk step). Jo files it himself. |

---

## Part 4. Template inventory and what is missing

### 4.1 What exists today (36 document templates, from the registries)

Core (`document-generator.js`): Proposal/Estimate, Roofing Contract, Inspection Report (Homeowner), Inspection Report
(Insurance), Invoice, Customer Report, Warranty Certificate, Certificate of Completion, Permit Application, Supplement
Request, Scope of Work, Change Order, Work Authorization, Payment Agreement, Material Delivery Receipt, Thank You
Letter, Company Introduction, Financing Options, Storm Damage Checklist, Insurance Claim Guide, Referral Card,
Before & After Report, Door Hanger, Neighborhood Mailer, Testimonial Sheet.
Library (`document-generator-library.js`): Lien Waiver, Notice of Right to Cancel, Material & Color Selection,
Good-Better-Best Options, Insurance Job: Scope & Next Steps.
Extra (`document-generator-templates.js`): Receipt, Roof Assessment Report, Storm History Report (5-Yr).

### 4.2 Missing templates (recommended build list, highest risk first)

| # | Template | Why it matters | Signer(s) |
| --- | --- | --- | --- |
| 1 | **Attic, Ventilation & Moisture Acknowledgment** (Part 2) | No attic, ventilation, mold or moisture language exists anywhere in the generator (searched `docs/pro/js`). Every re-roof is currently an open door for "you caused my mold" claims. | Homeowner, rep |
| 2 | **Terms of Payment + Materials/Restocking section** (Part 3) | Late fee, card fee and restocking exist nowhere in a signed document; the 1.5% line prints on an unsigned invoice only. | In the contract |
| 3 | **Property Condition & Access Acknowledgment** (driveway, landscaping, gutters, satellite dishes, solar, skylights, items in attic or on walls, interior ceiling cracks and nail pops from tear-off vibration, pets, utilities, parking) | The Oct 13 plan's SCH-2 covers this in one sentence; a signed pre-job walk-through sheet with photos is far stronger evidence. | Homeowner, rep |
| 4 | **Hidden Conditions / Decking Authorization** (per-sheet price, photos, approve-by-text option) | CO-2 covers the clause; there is no form that records the homeowner's approval of rotted decking found at tear-off. Change Order exists but is not decking-shaped. | Homeowner |
| 5 | **Emergency Services Request** (tarp / dry-in inside the cancellation window) | The statute needs a separate, handwritten, dated, signed request (Oct 13 plan, CANC-1, Q9); no template exists. | Homeowner |
| 6 | **Pre-Job Walkthrough / Notice to Proceed** (start date, crew, parking, what to remove from walls and attic, noise, pets) | Sets expectations and records that the homeowner was told. | Homeowner |
| 7 | **Final Walkthrough & Punch List sign-off** (ties to PAY-4: 3 days to list items, only listed items held back) | Certificate of Completion exists but has no punch-list mechanism, so "complete" is arguable. | Homeowner, rep |
| 8 | **Insurance job: Homeowner Acknowledgment** (deductible is yours; NBD does not represent you or negotiate your claim; supplements need your approval; denial/underpayment handling) | Pieces exist in the Kentucky module; Ohio insurance jobs have no equivalent acknowledgment. | Homeowner |
| 9 | **Shingle Warranty Registration & Conditions notice** (who registers, by when, ventilation and installation conditions of the maker's warranty) | Manufacturer warranties carry ventilation conditions; nothing tells the homeowner. | Homeowner |
| 10 | **Photo / Media & Communications Consent** | Publishing consent is self-attested only; job-communication consent is not re-obtained at contracting (inventory section 6). | Homeowner |
| 11 | **Roof Care Plan Terms** | The plan is sold with no accepted scope or limits (inventory section 5). | Homeowner |
| 12 | **Subcontractor Agreement + COI request** (independent contractor, insurance, lien waivers, pay-when-paid, indemnity) | Needed to back the "independent subcontractors" statements and incoming lien waivers. Counsel-drafted. | Sub, NBD |
| 13 | **Referral Program Terms** | $100 per closed job; Kentucky cap for insured homeowners on insurance jobs; FTC incentive rules. | Referrer |
| 14 | **Warranty Claim Request form** (written notice, date, photos, tarp taken) | WAR-3 needs a way to record the 30-day notice. | Homeowner |
| 15 | **Final Lien Waiver (conditional/unconditional x progress/final)** wired to payment events | The Lien Waiver template exists as a manual DRAFT; Oct 13 plan C5. | NBD, sub |
| 16 | **Notice of Past-Due / Demand letter** (cites the signed contract's late terms; no threats beyond what the contract allows) | Collections letters are where contractors create FDCPA/CSPA problems; one reviewed template prevents ad-libbing. | NBD |
| 17 | **Cancellation / Termination of Contract** (mutual, with materials-cost accounting from 3.3) | Gives a clean exit with the restocking terms applied. | Both |

### 4.3 Honesty problems already shipping in current templates (from the Oct 13 inventory, still open on main)

- Dead legacy template text "negotiate with my insurance company on my behalf" (`dashboard-ui.js:1524`).
- Testimonial Sheet falls back to invented "Satisfied Homeowner" quotes.
- Claim guide: "We handle the hard parts" and a no-rate-increase promise.
- Warranty certificate: "Backed personally by Joe Deal" (a personal-liability statement), client copy has no exclusions.
- Cancellation clause cites Kentucky statute 367.390 on every job, Ohio included; says 10 days where the form says 10
  business days; Work Authorization lets a customer cancel "by calling" though notice must be in writing.
- Contract "under Kentucky law" on Ohio jobs; "No cash payments accepted" while the CRM records cash and Zelle.
- Limitation of liability only on proposals; dispute/change-order/entire-agreement missing on the e-signed estimate PDF
  and deal page.

These are all fixed in the Oct 13 plan's drafts; none has shipped.

---

## Part 5. Per-template liability audit

Three focused audits ran in parallel (5A, 5B, 5C). The earlier broad extraction agent was superseded by them. Findings are from reading the source; no renderer was run, so each should be reconfirmed in the app before a fix ships.

### 5A. Contract and proposal group (source read only; no renderer was run; findings the two earlier plans already record are not repeated)

**Cross-cutting, every template.** No template names "No Big Deal Solutions LLC". The contracting party prints as the d/b/a only (`document-generator.js:23`), the signer label is "Contractor - NBD Home Solutions" (:351) or "Authorized NBD Representative", and "NBD" is never defined. Fix: print "No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions" as the party and add "By: Joe Deal, Manager". Define "NBD" once as "the Contractor".

**Proposal / Estimate (`document-generator.js:2523`)**
- Gaps: default scope promises gutters and ridge vents unpriced; no "not included" block, hidden-conditions, weather, access, interior, attic or permit/HOA text; the 30-day validity is buried inside the liability sentence; "see warranty section below" points at a section that prints above; price can print blank or $0.00; the Pledge is unlimited in time next to a 1-year labor tier; "cancel within 3 days (KY Residential Finance Law)" is wrong for Ohio and is not the statute.
- Fix: blank the default scope; add a printed "Not included" block, CO-2, SCH-1/2/3, DISP-8; print validity as its own line; block send on blank price; print the Pledge only with its WAR-6 definition.

**Roofing Contract (`:2727`)**
- Gaps: no hidden-conditions, weather, access, interior, attic, permit/HOA, subcontractor, warranty-exclusion, limitation-of-liability or lien-rights clause outside the KY insurance block; no contract date or owner recital; two conflicting cancel texts ("10 days" vs "TEN BUSINESS DAYS"); "mediation or binding arbitration" is an either/or with no way to choose; "NBD reserves the right to adjust pricing" contradicts the both-sign change-order rule; fixed "5-7 business days" and "Upon contract execution" with no weather carve-out; blank address or phone prints as empty on a signed document.
- Fix: add CO-1, CO-2, SCH-1/2/3, SUB-1, WAR-2, DISP-1/3/4/8, LIEN-1/2 (state-aware); delete the "reserves the right" sentence; one cancel statement from CANC-1; print contract date and owner recital; hard-block send on blank price, address, start or completion.

**Scope of Work (`document-generator-templates.js:807`) - the worst document in this group**
- Gaps: seven hardcoded sections print on every job, even a repair. It promises "Verify structural integrity of all rafters and trusses" and "Verify balanced intake/exhaust ventilation per code", which NBD is not hired to do and which contradicts its own exclusion "structural framing repairs"; "Replace any damaged or rotted decking" is unpriced and unlimited; "Ensure soffit vents are unobstructed" promises something about the house; ridge vent promised even where the estimate has none; "[Homeowner Name]" and "[Property Address]" brackets can print on a signed doc.
- Fix: generate sections from the estimate lines only; replace the three promises with "visible decking will be photographed; replacement beyond the estimate is priced per sheet (CO-2)"; delete "verify structural integrity" and "per code"; expand the exclusions (hidden conditions, mold, interior, existing ventilation, electrical); add an order-of-precedence line; block send on a bracket token.

**Work Authorization (`:896`)**
- Gaps: "To cancel, provide written notice ... or by calling" (not a valid written cancellation); blank scope falls back to a full re-roof; refers to "the associated contract" with no number, date or price; no cancel form attached; start date and witness optional.
- Fix: delete "or by calling"; require contract number, date and price; add "work will not begin before the cancellation period ends, unless you sign a separate emergency request (CANC-1)"; attach the cancel packet; require a start date.

**Change Order (`:1040`)**
- Gaps: can ship with no contract number, date or original total; default text "No change to estimated completion date" can print on a change that adds work; no price basis or photos for hidden conditions; no rule on approval by text; "payment follows the original contract" is ambiguous on due date.
- Fix: require original contract number, date and price; remove the default schedule text and make days mandatory; add CO-1 and CO-2 with the per-sheet price, photos attached, and a due-on-signing or due-with-balance field.

**Good-Better-Best Options (`document-generator-library.js:411`)**
- Gaps: says every option covers "the same scope" while tiers use different materials; "Option chosen / Initials" blanks on a template with no signer or date; "fully transferable ... all subsequent owners" and the Pledge outlive NBD; no validity date.
- Fix: say "same roof area and tear-off; materials and warranty differ as listed"; make it a signed, dated selection tied to the proposal number; state that choosing an option is not a contract until the contract is signed.

**Material & Color Selection (`:353`)**
- Gaps: no color-variance clause (the most common complaint on selection sheets); blank rows still print "I approve"; no special-order-not-returnable sentence; "what you sign here is what goes on your home" is unqualified.
- Fix: add "Colors seen on samples, screens or other homes can look different on your roof, and shingles vary slightly between batches. NBD is not responsible for a color you approved here"; block signing while a required row is blank; add the special-order sentence (3.3(b)); print the date.

**Notice of Right to Cancel (`:285`) and packet (`ky-insurance-law.js:835, 889`)**
- Gaps: a blank mailing address falls back to "the address on the form" and the form prints a blank, so the notice is defective; seller is the d/b/a, not the LLC; with no state it cites "your state's home solicitation sales law" and does not print Ohio's required notice text; the packet date regenerates, so the receipt date proves delivery only if signed on the signing day.
- Fix: hard-block send until the mailing address and legal name are set; print the Ohio notice for Ohio properties (CANC-1); refuse a signed copy dated differently from the packet; use the LLC name.

**Signature block (`renderSignatureBlock`, 2317)**
- Gaps: the non-interactive branch has no printed-name line; no contractor signer states authority; no co-owner language on paper; no "I am the owner" sentence anywhere.
- Fix: add "By: Joe Deal, Manager" and a printed-name line; auto-stamp the date; add "I am the owner (or authorized to sign for all owners) of the property listed" (ESIGN-1).

**`_statutoryBlocks` and `ky-insurance-law.js`**
- Gaps: no lien-rights notice or owner acknowledgment on cash jobs in either state; "Contractor" in the KY lien clause is never defined; `partiesExtra` prints "(not set — add it in Company Profile)" on a signed Kentucky contract when the address is missing; unknown state fails to Kentucky text with no state label on an Ohio homeowner's paper.
- Fix: block the send when the address is empty; add LIEN-1 and LIEN-2 on cash jobs; name the party in the payment and lien clauses.

**Server e-sign PDF (`functions/estimate-esign-pdf.js`) - the document most remote customers actually sign**
- Gaps: carries no change-order, hidden-conditions, warranty, exclusions, dispute, entire-agreement, lien, subcontractor or weather clause, only the payment clause and cancellation notices; scope is "as described in your estimate", which is neither attached nor numbered; the fallback payment sentence is non-specific; the total can print $0.00 (the envelope refuses it, the PDF function does not); the contractor never signs; "authorize" grammar slip; Ohio insurance jobs get no deductible or no-claim-representation text.
- Fix: port the Oct 13 clauses (CO-1/2, SCH, WAR, DISP-1/3/4/8, LIEN-1/2/4, SUB-1, ESIGN-1); attach the estimate with its ID; fail the build when the address or price is blank; add "NBD accepts by performing, signed for the LLC by Joe Deal, Manager".

**Priority within this group:** (1) e-sign PDF has no operative terms; (2) the contract lacks hidden-conditions, weather, access and attic clauses and has two conflicting cancel texts; (3) Scope of Work's "verify structural / per code" promises; (4) legal party name and signer on everything; (5) blank address or price printing on signed documents; (6) Work Authorization "or by calling"; (7) selection-sheet color variance.

### 5B. Warranty, completion and billing group (source read only; no renderer was run)

**Credential line, all templates:** none prints "licensed". Badges come only from `affiliateRow()`: GAF Certified #1162011, TAMKO Pro Gold #181382, Locally Owned & Operated. The referral card, material delivery and lien waiver print no badge row. **Party name, all templates:** the printed name is "No Big Deal Home Solutions"; the LLC is never printed (Q35).

**Warranty Certificate** (`document-generator-templates.js:543-717`; CRM wizard `warranty-cert.js:483-487`; server PDF `functions/print/templates/warranty.hbs`; Pledge text `estimate-config.js:246`)
- Gaps: "Backed personally by Joe Deal" still ships in the server `.hbs`, `warranty-cert.js` and the signature caption (Q13 decided, not shipped). The Pledge, "for as long as you own the home, we'll come back and make it right", has no definition or limit and contradicts the 1/5/10/20-year labor terms. The client template has no exclusions at all; the server copy's list is short. No claim procedure, no paid-in-full condition, no "no other warranty" line, no manufacturer-registration language. "Workmanship" is defined two ways ("leak or failure" vs "labor-related defect"). Expiration counts from the issue date in one copy and the install date in another. The attic / ventilation exclusion is planned but not shipped. `[Homeowner Name]` / `[Property Address]` can print literally; tier silently defaults to "better"; install date silently falls back to the issue date; transfer wording has no process or conditions.
- Fix: delete the personal-backing line from all three places; print WAR-2 exclusions, WAR-3 claim steps, the one-definition WAR-6 Pledge and the WAR-7 savings sentence on every copy; print the LLC d/b/a. Signable: the client cert has two bare signature lines and no `defaultSigners`, so it cannot be e-signed.

**Certificate of Completion** (`:958-1032`)
- Gaps: seven hard-coded `checked:true` items print on every certificate and the rep cannot edit them: "Ventilation system installed and verified", "Homeowner walkthrough and approval obtained", "Magnetic nail sweep of entire property completed". "Ventilation ... verified" is false when the homeowner declined vent work (Part 2). "Homeowner walkthrough ... obtained" is asserted before the homeowner signs. One signature "completed to my satisfaction" acts as a full release with no punch list and no 3-day window (PAY-4). "Your warranty coverage is now active" carries no paid-in-full condition. The completion date defaults to today. `inspectorName` is collected and never printed.
- Fix: make each checklist item a rep-set box; add a punch-list block with a "no open items" check; add "items must be listed within 3 days or none are held back"; soften to "work listed above is complete except the items listed." Signable: yes.

**Invoice** (`:1151-1310`)
- Gaps: "Accounts past 30 days may be subject to a 1.5% monthly finance charge" is 18% a year, uses "finance charge" (Reg Z vocabulary), and appears only on the invoice, which Ohio cases say is unenforceable (Minster Farmers, Sal's Heating). It contradicts the decided 15-day / 8% terms. Payment tiles list Check, Zelle, "Credit Card - ask for secure link" and Financing; no cash, no wire, and no disclosure of the 3% credit-card fee, so the invoice and checkout page could disagree. No "contract controls" sentence, no dispute-notice language, no signed-price reference. Insurance invoices carry a claim number but not "the deductible is yours", and nothing handles the Kentucky no-card-fee rule. "Check payable to No Big Deal Home Solutions" is a d/b/a, not the LLC; a bank may refuse a check to a name the account does not carry.
- Fix: replace the late line with "Late-payment terms are in your signed contract"; print the card-fee note; list methods from config; remove "finance charge".

**Receipt** (`:1313-1432`)
- Gaps: `paidInFull === true` prints the PAID IN FULL stamp with no contract total, so a partly paid job can be stamped paid. No surcharge line for the card fee. A cash receipt has no "received by" name or signature. `paymentMethod` is free text with no tie to the contract's allowed methods. "Date Paid" defaults to today. No statement of what the payment applies to.
- Fix: require `contractTotal` before the stamp; add a surcharge line and a "received by" line for cash.

**Payment Agreement** (`:2680-2790`)
- Gaps: this is the only signed document carrying the 1.5% term, which contradicts the decided 8% simple. "A convenience fee may apply" is unquantified and applies to all cards; it is slated for removal (Q26). Method tiles omit cash, ACH and wire and list "Financing" as a payment method. "Work will not commence until the deposit payment has been received" is wrong on Kentucky insurance jobs, where nothing is due at signing (KRS 367.626(2)(a)). No right to pause, no attorney-fee term, no returned-payment term. "Supplemental to the primary project contract" has no precedence rule. Default dollar fields are '0.00', so a blank schedule can be signed. The dispute window runs from the due date (here) versus the invoice date (Part 3.2(f)).
- Fix: replace its terms with the Part 3.2 Terms of Payment; hard-block send while totals do not reconcile.

**Financing Options** (`:1748-1885`)
- Gaps: four unconditional benefit claims - "No money down options available", "Fixed monthly payments - no surprises", "No prepayment penalties", "Quick and easy application process" - depend on the lender and applicant (CSPA / FTC deception risk). If a tenant sets `apr > 0` the template prints "X% APR | N payments", which can trigger Reg Z advertising rules (12 CFR 1026.24) without the full disclosure; NBD's default APR 0 ("set by your lender") is safe. `totalPrice` defaults to $10,000 and prints "Project Total $10,000", an invented figure. No statement that financing does not change the price, cancellation rights or lien terms, and no statement of any dealer fee. "We've partnered with" is an endorsement claim. Footer typo: "Xcel".
- Fix: remove the four tiles or prefix "Depending on the lender and your approval:"; hide the Project Total box when no real total is passed; keep `apr` at 0 unless counsel supplies the full disclosure block.

**Material Delivery Notice / Receipt** (`:1970-2040`; titled "Receipt" in the registry, "Notice" on the page)
- Gaps: an invented default materials list prints when the rep passes none ("GAF Timberline HDZ ... 30 bundles - Color: Charcoal", ridge vent, ice and water shield), wrong for a TAMKO job. "[Delivery Date]" and "[Project Start Date]" print as literals. No allocation of risk for theft, weather or truck damage to the lawn or driveway. Titled a receipt but has no signature, "received by", or condition line. No special-order / non-returnable line, which is where Part 3.3(b) would be recorded. Reads as a firm schedule when start dates are estimates (SCH-1).
- Fix: delete the default materials rows and show "materials list required"; add the storage-at-your-direction line (counsel to word); add a receipt signature box if the title stays "Receipt".

**Lien Waiver** (`document-generator-library.js:186-262`; signer: NBD rep only)
- Gaps: direction is correct (the contractor releases the owner). "...its independent subcontractors and material suppliers have been paid ... or will be paid from this payment" is an affirmative representation; if untrue it invites fraud-style claims and weakens "unconditional". "or will be paid" should not appear on an unconditional final waiver, which rests on payment already received. Amount and "work through" date print as blank lines when missing, so a signed blank waiver is a release with no limit. `[Owner Name]` and `[Property Address]` can print. No DRAFT marking on the printed document though the library tile is marked attorney-review. Signs as the d/b/a.
- Fix: delete "or will be paid from this payment" on the unconditional versions; hard-block when the amount or through-date is empty; add a visible attorney-review watermark until cleared; use the LLC signature block.

**Thank You Letter** (`:2621-2677`)
- Gaps: "we stand behind every project we touch" and a free post-storm look "at no charge" are open-ended promises outside the contract and read as an extension of the Pledge. "Your workmanship warranty is now active" has no exclusions or claim step. Signs "Owner"; Jo signs as Manager. The review request is not gated and offers no reward (good); keep the referral line separate from the review line.
- Fix: "your written warranty applies as shown on your certificate"; drop "no charge" or tie it to Roof Care Plan terms; change the title to Manager.

**Referral Card** (`:1890-1965`; preflight default `literal:100`)
- Gaps: three triggers for when $100 is owed: "completed" (card), "paid in full" (preflight), "closed" (CRM program). No Kentucky carve-out: the plan caps the reward at $100 for an insured homeowner on an insurance job, but `bonusAmount` is an editable field. "Earn rewards for every referral" can print beside "One bonus per referred job". No eligibility, limits, payment method, tax note or void-where-prohibited text. The referred homeowner is not told the referrer is paid. The `$250` literal flagged in the Oct 13 inventory was not found in current code.
- Fix: one trigger ("paid in full"); cap at 100 on Kentucky insurance jobs; print program terms (Part 4 #13) and "cannot be combined with or used to reduce an insurance claim".

**Testimonial Sheet** (`:2538-2618`)
- Gaps: the invented fallback quotes are gone on this branch (the Oct 13 inventory lists them open on `main`; re-verify). The "Average Rating" and "Would Recommend N%" stats come from rep-typed entries, and `clampRating` defaults a missing rating to 5, so a 5.0 and 100% can be built from 1-3 hand-picked quotes (selective sample; FTC 16 CFR 255 and 465). "Real Reviews From Real Homeowners" is asserted with no source, date or consent check. Name, location and project are optional, so quotes cannot be verified. No filter against a quote saying "they handled my insurance claim". No material-connection disclosure.
- Fix: remove the computed average and "Would Recommend"; require name, date, source URL and a consent checkbox per entry; print "Quotes shared with permission. Results vary."

**Top five in this group:** (1) remove "Backed personally by Joe Deal" (`.hbs` + `warranty-cert.js`); (2) replace the 1.5% finance-charge text on the invoice and Payment Agreement with the 15-day / 8% terms; (3) remove the unconditional checklist on the Certificate of Completion; (4) remove the Material Delivery default materials list; (5) remove the Financing benefit tiles and the default $10,000 total.

### 5C. Inspection, insurance and marketing group (source read only; no renderer was run)

**Correction to section 4.3 above:** the Insurance Claim Guide no longer says "We handle the hard parts" or promises no rate increase; `document-generator-templates.js:2293-2365` now says "Your insurance company decides your claim" and "we cannot predict" rates. That item is stale. Attic, ventilation and moisture language is not entirely absent: the Storm Damage Checklist lists "Musty odor indicating moisture or mold" and "Damp insulation in the attic" as homeowner self-check items (:2092-2094), and the Before & After default work description prints "ventilation" (:1670, 1676). No attic or ventilation acknowledgment exists. Nothing in this group prints "licensed" or promises a free roof or deductible waiver; the only stretch credential is "Certified NBD Inspector / Damage Assessor".

**Inspection Report (Homeowner)** (`document-generator.js:2952`)
- Gaps: hard-coded "we recommend immediate attention to the roof and gutters to prevent further water damage" (:3070) prints on every report, even a clean roof. "Certified NBD Inspector" is an uncertified credential (only GAF Certified and TAMKO Pro Gold are allowed). `doc-preflight.js:924` pre-fills the required overall assessment with "shows signs of wear consistent with age. Several areas require attention", so it prints even if never reviewed. No scope-and-limits statement. Roof age, type and square footage print as fact; "Est. Cost" has no estimate caveat; inspector name defaults to "NBD Inspector"; no attic or moisture caveat, so the report implies the whole roof system was assessed.
- Fix: delete the hard-coded sentence or tie it to a rep-checked "urgent" flag; relabel "Inspector"; add a fixed footer ("visual inspection only, not a warranty, structural opinion or coverage opinion"); remove the prefill; require a real inspector name.

**Inspection Report (Insurance)** (`:3108`)
- Gaps: heading "Damage Assessment & Cause"; prefilled required damage notes assert wind or impact damage the rep may never have seen (`doc-preflight.js:975`); the rep certifies "damages, measurements, and repair estimates ... are accurate" to an adjuster; "All repairs performed in accordance with ${codeCycle} ... Work complies with manufacturer specifications and NRCA guidelines" states future compliance as fact; the code default "2021 International Building Code / Kentucky Building Code" (`company-profile.js:170-171`) is wrong for Ohio jobs and arguably for Kentucky residential (KRC). No statement that NBD is not a public adjuster and does not determine coverage; no homeowner authorization to release the report; photos go to a third party with no privacy check; signer "Certified NBD Damage Assessor".
- Fix: remove the prefill and the word "Cause" ("Observed Damage"); replace the certification with "These are my observations on this date; coverage and causation are decided by the insurer"; take the code reference from the property state and say "estimate is based on"; add a not-an-adjuster line and a homeowner "release to my insurer" signature; drop "Certified".

**Roof Assessment Report** (`:1437`)
- Gaps: "Why it matters" and "Address Now" invite cause and urgency opinions with no limits language; no scope line or disclaimer; inspector name optional so it can print unattributed; the report number `ASM-` plus a time remainder is not unique; `[Homeowner Name]` / `[Property Address]` can print; photos not screened.
- Fix: fixed scope-and-limits footer; relabel the badge "Recommend soon"; require inspector name and date; block render on a bracket placeholder; use the CRM sequence for the number.

**Storm History Report** (`:2167`)
- Gaps: "5-Year Verified Storm History" overstates NWS spotter reports within a 30-mile radius; "Max Hail Size" is a 30-mile maximum and reads as property-specific; it can mislead if offered to an adjuster without tying it to the claimed date of loss. The "not an inspection ... does not determine whether damage occurred" caveat is present and good.
- Fix: "Reported" for "Verified"; relabel "Largest reported hail within 30 miles"; add "Reports are not measurements at your address and do not establish a date of loss."

**Before & After Report** (`:1662`)
- Gaps: the default description (a specific GAF product, "ventilation, and gutters") prints when the rep leaves it blank and implies work or a ventilation scope that was not documented; "Add captions describing damage..." instruction text prints on customer paper; the homeowner signs an "Acknowledgment" of nothing; photos may show people, plates or interiors; `[Start Date]` can print; no "visible conditions on this date, not a warranty" line.
- Fix: remove the default description; delete the instruction text; replace the signature with "I received these photos on [date]" or remove it; add the visible-conditions line.

**Customer Report** (`:3358`)
- Gaps: prints internal rep notes (with `createdBy`) and the activity timeline, including "Contact" entries, to the customer; "Damage type" and "Claim status" read as NBD conclusions; the stage name "Deductible Collected" and "Job value" printed beside a deductible expose pricing structure; the footer carries the proposal cancellation text, which may not match the contract path; the customer's email and phone print on a forwardable PDF.
- Fix: drop Notes and Contact entries unless flagged "share with customer"; hide deductible and stage names on this view; remove the cancellation footer or tie it to the signed contract.

**Supplement Request** (`document-generator-templates.js:721`)
- Gaps: default justification asserts "additional damage was discovered ... restore the roof system to its pre-loss condition" even if none was found; documentation checkboxes ("Photographs of additional damage", "Revised scope of work", "Code compliance documentation") are pre-ticked whether or not the documents exist, a false representation to an insurer; submitting on the homeowner's behalf looks like claim representation under KRS 367.62x with no homeowner authorization and no "insurer decides" sentence; "NEW PROJECT TOTAL" prints the supplement alone when `originalApproved` is left at '0.00'; `[Claim #]`, `[Policy #]`, `[Date of Loss]` can print on a document sent to an adjuster.
- Fix: rep-written justification only, no default; unticked rep-controlled checkboxes; "Provided at the homeowner's request; the homeowner decides what to submit" with a homeowner signature; block render on a blank original amount or placeholder.

**Insurance Next Steps** (`document-generator-library.js:498-563`) - the best template in the group
- Strengths: "NBD is a roofing contractor, not a public adjuster", "Pay your deductible. It is yours to pay, and we will never offer to pay, waive or rebate it", and the Kentucky block with the $100 limit.
- Gaps: the Kentucky block shows only when jurisdiction resolves to Kentucky, so a mis-resolved job prints the wrong block; Ohio jobs get no equivalent (the missing Ohio acknowledgment); "What we found and recommend" is free text with no cause-neutral guard; no "we cannot promise your insurer will cover any part of this", date, author or signature.
- Fix: add the no-coverage-promise line, the Ohio acknowledgment text, a sent-date and the rep's name; make the $100 wording match the contract.

**Storm Damage Checklist** (`:2055`)
- Gaps: mold and structural items appear as homeowner symptoms with no statement that NBD does not test for, identify or remove mold (Q4); `stormType` and `stormDate` print ("Hail Storm - date") with no source, reading as NBD asserting a storm event; "Found Damage? We Can Help." plus a post-event mailer or hanger is solicitation after an event; "always free, always no obligation" is a promise; the disclaimer is small grey 10px text at the bottom.
- Fix: add to the mold row "Call a qualified specialist; NBD does not test for or remove mold"; drop storm type and date unless sourced; move and enlarge the disclaimer.

**Insurance Claim Guide** (`:2280`)
- Gaps: default notes "We will meet the adjuster on-site" are unconditional and contradict Step 4 ("after you have filed") and the Next Steps letter ("if you ask us to"); "Adjuster will contact you within 48-72 hours" and "30-60 days" are carrier promises with no source; Step 3 "document all damage ... comprehensive report" overstates; Step 6 "we handle scheduling, permits and coordination" reads close to claim handling; no not-a-public-adjuster statement here; no Kentucky five-day notice; "Prepared for your claim with {carrier}" implies a carrier relationship; the preflight (`doc-preflight.js:1631`) pre-fills the same default.
- Fix: default to "If you ask us to, we can meet your adjuster after you file"; delete the hour and day counts or label them "typical, not guaranteed"; reuse the Next Steps not-a-public-adjuster paragraph.

**Permit Application** (`document-generator.js:439`)
- Gaps: registered but no renderer exists; it falls back to `renderGenericDoc`, a raw key-and-value dump with "Homeowner Signature" and "Contractor Signature" lines. It has no jurisdiction, permit number, contractor registration, valuation or owner-authorization wording, so the homeowner signs a blank page that looks official.
- Fix: unregister it from the picker until a real form exists, or render only an "Owner authorization to pull permit" with the jurisdiction and registration number from the CRM. Do not state a license.

**Company Introduction** (`:1545`)
- Gaps: the hard-coded fallback service (:1561) "Storm Damage - Full insurance claim management from inspection to completion" contradicts the Kentucky rule and the softened profile wording, and prints when the profile services list is empty; "We handle everything from the first inspection to the final nail" reads as claim representation; "quick approval" promises a lender outcome; "5-Star" and "Exceptional" are unsourced; "Interior - Water damage repair" may not be offered and implies remediation; "We've Got You Covered" is an insurance double meaning on insured jobs; the empty Project Photos grid could show another customer's home without consent; neither the legal name nor the d/b/a note appears.
- Fix: replace the fallback with the profile wording; delete "quick approval"; "We take care of the roofing work"; drop Interior unless offered; require photo consent before photos print.

**`renderGenericDoc`** (`:3253`)
- Gaps: it prints any string field in the document data (claim number, carrier, notes, rep names, lead sources), only skipping keys that are `_`-prefixed, `Id`-suffixed or named internal; every fallback type prints "Homeowner Signature" and "Contractor Signature" lines with no terms, so the document looks agreed to; the total prints without tax, deposit or disclaimer; raw camelCase keys become labels.
- Fix: replace the dump with an explicit per-type allowlist and a "Template not available" page when no renderer exists; remove the signature block from the fallback.

**Door Hanger** (`:2383`)
- Gaps: "Our crew is working on a project nearby" prints every time, false when no job is active; "Insurance Claims - handled start to finish" is claim-handling language; "Storm damage repair - Insurance claims" in a canvass piece is storm-chaser solicitation, and Kentucky limits post-loss solicitation and inducements (KRS 367.62x; attorney to confirm the windows); "Warranty-Backed" has no scope; "at no cost to you" can be read as free repairs; no legal entity and no solicitor-permit compliance line (Ohio and Northern Kentucky municipalities often require one).
- Fix: make the "working nearby" line conditional on a real nearby job address; remove the claims bullet and "Warranty-Backed" or define it; add "Inspection is free. Repairs are quoted separately."; print the legal name with the d/b/a and a canvasser permit checklist.

**Neighborhood Mailer** (`:2459`)
- Gaps: prints a past customer's street address on mass mail with no consent ("Your neighbor at ${projectAddress} trusted ... and so can you"), a privacy and endorsement risk; "5★ Customer Rating", "100% Satisfaction" and "0 Cost for Inspection" are fixed unsourced stats; the footer says "Lexington, KY & Surrounding Areas" though the service area is Greater Cincinnati and Northern Kentucky; "Earn rewards for every referral" is vague and ignores the $100 Kentucky insurance cap; the storm date is collected but not shown, so a "free storm damage inspection" CTA prints with no stated event; if the PDF is emailed, CAN-SPAM needs a postal address and an unsubscribe link, and `address` defaults to empty.
- Fix: remove the neighbor address (or get written consent) and the unsourced stats; fix the footer to the profile service area; replace the referral line with the actual $100 program text and a Kentucky insurance carve-out; print the legal name, d/b/a and a mailing address.

**Top fixes in this group:** (1) Insurance Inspection prefilled cause text and certification; (2) Supplement Request default text and pre-ticked boxes; (3) the Permit and Generic fallback; (4) the mailer's neighbor address and Lexington footer; (5) Company Intro fallback "Full insurance claim management".


