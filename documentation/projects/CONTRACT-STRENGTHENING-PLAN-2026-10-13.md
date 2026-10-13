# Contract strengthening plan - clause set, decisions, build map, attorney questions (2026-10-13)

> **DRAFT for attorney review. Not legal advice. Nothing in this note ships until the LegalShield attorney has
> reviewed it and Jo has signed off.** Every clause below is a *candidate* written by Claude from the research memo
> and the inventory. Where the law is uncertain the clause says so. No customer data and no private cost or
> sub-contractor figures appear here (public repo).

**Jo's ask (2026-10-13):** deepen and strengthen the contract language; cover right to lien and charging fees for
late payment after job completion; look at every aspect so NBD has its own back in court or in any dispute.
Late fees: research first, then decide. Honesty rules stand: "fully insured", never "licensed"; no claim-outcome
promises; Kentucky insurance-job limits (KRS 367.62x); no "we handle the claim"; crews are independent
subcontractors, never "in-house".

**Inputs (read both first):**

- [KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13](../audit/KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13.md) - the law memo
  (cited below as "memo", with its part letter). Ohio text was read through a summarising tool, Kentucky text
  verbatim; case law mostly secondary.
- [CONTRACT-LANGUAGE-INVENTORY-2026-10-13](CONTRACT-LANGUAGE-INVENTORY-2026-10-13.md) - what the product says
  today, by signing path (cited as "inventory", with its section number).

Related: [TEMPLATE-LIBRARY-2026-10-04](TEMPLATE-LIBRARY-2026-10-04.md),
[OHIO-4722-DEPOSIT-CAP-2026-10-11](OHIO-4722-DEPOSIT-CAP-2026-10-11.md),
[KY-INSURANCE-JOB-CRM-2026-09-27](../audit/KY-INSURANCE-JOB-CRM-2026-09-27.md).

**What this note could not do (read before relying on it):**

1. It did not read NBD's *saved* legal-text overrides (`companyProfile/{uid}`); those win over the repo defaults the
   inventory quotes. First step of any build is to read them (needs Jo or an owner-authorised read).
2. It did not read any contract Jo actually signed with a customer. The attorney should see real ones (Part D).
3. Ohio statutes are PRIMARY-SUMMARIZED in the memo, so clause "rests on" cites for Ohio are as reliable as that.
4. Reg Z / ESIGN / FTC points marked *general knowledge* are not in the memo and are leads only.

**Confidence tags used on each clause**

| Tag | Meaning |
| --- | --- |
| **HIGH** | Rests on Kentucky statute text read verbatim, or a court opinion read in full, directly on the point. |
| **MED** | Rests on Ohio text read through a summary tool, or on a widely used drafting pattern; substance likely right, wording needs a lawyer. |
| **LOW** | Uncertain law, secondary sources only, not researched, or Claude's own drafting judgment. |

Every clause also carries **ATTORNEY MUST CONFIRM: yes** unless stated. It is repeated as a column in the matrix so
nothing is mistaken for reviewed text. The `Q#` after it points at Part D.

---

# Part A. Canonical clause set

## A0. How the set is assembled (five job types)

A contract is built from **families** (rows below). Job type comes from two facts the CRM already has: the
**property state** (OH or KY - lien, cancellation and insurance law attach by where the property sits, memo Part D
section 1 last row) and the **payment source** (cash, insurance, third-party financing). Unknown state fails to the
stricter Kentucky-insurance set, as `ky-insurance-law.js` already does.

Legend: **●** include as drafted · **V** include a state/type variant (named) · **○** optional, decision in Part B ·
**-** not used on this job type.

| Clause | OH cash | OH insurance | KY cash | KY insurance | Financed (either state) |
| --- | --- | --- | --- | --- | --- |
| LIEN-1 lien rights reserved (OH wording) | ● | ● | - | - | V (OH property) |
| LIEN-2 lien rights reserved (KY wording) | - | - | ● | - | V (KY property) |
| LIEN-3 KY insurance: no lien for the excess | - | - | - | ● | - |
| LIEN-4 owner acknowledgements | ● | ● | ● | ● | ● |
| LIEN-5 release after payment | ● | ● | ● | ● | ● |
| PAY-1 price and what it covers | ● | ● | ● | ● | ● |
| PAY-2 deposit (config-driven, never hand-typed) | V | V | V | V (nothing at signing) | V |
| PAY-3 progress payments | ○ | ○ | ○ | ○ | V |
| PAY-4 final payment, completion, due date | ● | ● | ● | V | V |
| PAY-5 disputed amounts | ● | ● | ● | ● | ● |
| PAY-6 payment source and insurer shortfalls | - | V | - | V | V |
| PAY-7 methods accepted | ● | ● | ● | ● | ● |
| LATE-1 interest on past-due amounts | V | V | V | V (hold-aware) | V (own funds only) |
| LATE-2 flat fee | ○ | ○ | ○ | - | - |
| LATE-3 attorney fees and collection costs (mutual) | ● | ● | V | V | ● |
| LATE-4 contract controls over invoice | ● | ● | ● | ● | ● |
| LATE-5 no discounts / no rebates | - | ○ | - | ● | - |
| LATE-6 right to suspend for non-payment | ○ | ○ | ○ | V | - |
| CO-1 change orders | ● | ● | ● | ● | ● |
| CO-2 hidden conditions and decking | ● | ● | ● | ● | ● |
| CO-3 insurance supplements | - | ● | - | ● | - |
| SCH-1 schedule and weather | ● | ● | ● | ● | ● |
| SCH-2 access, utilities, interior | ● | ● | ● | ● | ● |
| SCH-3 permits and HOA | ● | ● | ● | ● | ● |
| INS-1 no claim representation (payment clause) | - | ● | - | ● | - |
| INS-2 deductible is the homeowner's | - | V | - | V | - |
| INS-3 insurer denial / price contingency | - | ○ | - | V (statutory) | - |
| INS-4 KY statutory notices + cancel form (module text) | - | - | - | ● | - |
| INS-5 no assignment of benefits | - | ○ | - | ● | - |
| WAR-1 to WAR-7 warranty family | ● | ● | ● | ● | ● |
| DISP-1 governing law = property state | ● | ● | ● | ● | ● |
| DISP-2 notice and chance to fix | ○ | ○ | ○ | ○ | ○ |
| DISP-3 resolution path (courts / mediation / arbitration) | V | V | V | V | V |
| DISP-4 venue | ● | ● | ● | ● | ● |
| DISP-5 jury waiver | ○ | ○ | ○ | ○ | ○ |
| DISP-6 limitation of liability | ○ | ○ | ○ | ○ | ○ |
| DISP-7 shortened claim period | ○ | ○ | ○ | ○ | ○ |
| DISP-8 boilerplate (severability, entire agreement, assignment, notices) | ● | ● | ● | ● | ● |
| SUB-1 independent subcontractors | ● | ● | ● | ● | ● |
| ESIGN-1 electronic signature + records | ● | ● | ● | ● | ● |
| ESIGN-2 job communications consent | ● | ● | ● | ● | ● |
| MEDIA-1 photos for the file / optional publishing | ● | ● | ● | ● | ● |
| CANC-1 cancellation notices (by property state) | V OH | V OH | V KY | V KY + 5-day form | V (Reg Z where home-secured) |

Drafting conventions: plain English, "you" is the homeowner, "NBD" is the contracting party (the legal name is an open
decision - D11). Numbers in `{{braces}}` come from configuration or from a Part B decision, never typed by hand. All
money in cents.

---

## A1. Family 1 - Lien rights and owner acknowledgements

**LIEN-1 Lien rights reserved (Ohio property)** - sets: OH cash, OH insurance, financed on OH property.
Confidence **MED**. ATTORNEY MUST CONFIRM: yes - Q11, Q13, Q14.

> **Mechanic's lien.** Ohio law lets a contractor, subcontractor or material supplier who has not been paid file a
> mechanic's lien against the property where the work was done. Nothing in this contract gives up NBD's right to do
> that. NBD will pay the subcontractors and suppliers it uses on your job. On your written request, NBD will give you
> (or your lender) a written statement of who has furnished labor or materials and that they have been paid or will be
> paid from your payments.

Rests on: ORC 1311.02 (original contractors hold lien rights), 1311.011(B)(4),(6),(7) (contractor's statement on
request), 1311.21(A) (taking a note does not waive the lien unless a written agreement says so - so do **not** add
waiver-flavoured language to payment-plan wording). Memo Part D section 1, Part C2.
Note: the memo found **no** statutory notice that must appear in an Ohio home construction contract (1311.011 text
has none) - that is a "found nothing", not "there is none". Hence Q14.

**LIEN-2 Lien rights reserved (Kentucky property)** - sets: KY cash, financed on KY property. Confidence **MED**.
ATTORNEY MUST CONFIRM: yes - Q11, Q13.

> **Mechanic's lien.** Kentucky law lets a contractor who has not been paid file a lien statement with the county
> clerk where the property is located, and requires NBD to mail you a copy. Nothing in this contract gives up that
> right. NBD will pay its subcontractors and suppliers for work on your job and, on your written request, will tell
> you in writing who has furnished labor or materials.

Rests on: KRS 376.010(1)(a) (contract with the owner gives a lien with no pre-lien notice), 376.080 (sworn statement,
6 months; copy by mail within 7 days or the lien dissolves), 376.090 (suit within 12 months). The text deliberately
**does not recite the deadlines** - a wrong or stale number printed in a contract is worse than none. KRS 376.010(5)
(75-day notice for subs/suppliers on owner-occupied 1-2 family homes; whether it reaches re-roofs is UNCERTAIN, memo).

**LIEN-3 Kentucky insurance job: no lien for the excess** - sets: KY insurance only (replaces LIEN-2).
Confidence **HIGH** for the existing sentence; **LOW** for anything added. ATTORNEY MUST CONFIRM: yes - Q7, Q12.

> Contractor will not file or claim a mechanic's lien for any amount in excess of what your insurer pays or is
> expected to pay.

This is the sentence already shipped (`ky-insurance-law.js`, byte-identical in `docs/pro/js/` and `functions/`). It
tracks KRS 367.628(2)(g) (memo Part D section 3). **Do not add a "NBD may lien for the deductible" sentence** until
counsel answers Q12: the statute's words are an "excess charge over the amount paid or expected to be paid by an
insurer", and how that reads for the deductible itself is the open question. Violations carry a $5,000-per-violation
civil penalty and double damages plus fees (KRS 367.627 as amended 2026 Ky. Acts ch. 54).

**LIEN-4 Owner acknowledgements** - all sets. Confidence **LOW** (drafting practice). ATTORNEY MUST CONFIRM: yes - Q14.

> **About the property.** You confirm that you are the owner of the property (or have the owner's written
> permission), that the address on this contract is correct, and that you will tell NBD if a mortgage lender requires a
> notice of commencement or any other notice before work starts. You will tell NBD in writing if the property is
> sold or refinanced before the work is paid for.

Rests on: ORC 1311.02 (the lien reaches the interest of the person who contracted), 1311.04 (owner records a notice
of commencement only when a lender requires one on a home construction contract).

**LIEN-5 Release after payment** - all sets. Confidence **HIGH** (KY) / **MED** (OH). ATTORNEY MUST CONFIRM: yes - Q13.

> After NBD has been paid in full, NBD will release any lien it filed within the time the law requires.

Rests on: ORC 1311.011(B)(3) (30 days after written notice of full payment), KRS 382.365 (30 days; $100/day rising to
$500/day after notice). Stating the statutory duty costs nothing and removes an argument.

---

## A2. Family 2 - Payment terms: due dates, deposit, progress payments

**PAY-1 Price and what it covers** - all sets. Confidence **MED**. ATTORNEY MUST CONFIRM: yes - Q10.

> **Price.** The contract price is the price stated in the signed estimate for the work described in it. It includes
> the labor, materials, permits and disposal listed there. Anything not listed is not included, and a written change
> order is needed to add it.

Money rule: the **signed price wins on every bill** until re-signed (signed-price rules, 2026-10-07). The clause
module never touches price fields. For Ohio jobs of $25,000 or more the memo's contents list (ORC 4722.02 per the
Grok audit) is a separate check, not a clause: supplier name, address, phone and TIN, proof of liability policy, start
and completion dates, total estimated cost plus costs not covered, dated signatures (inventory section 5).

**PAY-2 Deposit** - V per type. Confidence **MED**. ATTORNEY MUST CONFIRM: yes - Q6, Q7.

Never hand-typed: the clause renders the existing one-source rule (`deposit-rule.js` `policyText`, both copies) so the
contract cannot drift from the estimate, deal page and invoice. Variants it must produce:

- Cash under the cash threshold: no deposit; payment in full on completion.
- Cash at or above the threshold, **Ohio under $25,000**: 50% at signing **only if counsel confirms** the 10% cap does
  not reach it (D4); otherwise the 10% structure.
- **Ohio at or above $25,000**: 10% at signing (75% only for non-returnable special orders), balance by milestones.
- Ohio insurance: the homeowner's deductible at signing, ACV payment when the insurer releases it.
- **Kentucky insurance: nothing at signing** (KRS 367.626(2)(a): no advance payment until the cancellation period has
  expired).

Rests on: ORC 4722.01-.04 (memo Part D section 3; the "more than" vs "$25,000 or more" inconsistency is memo Part E
item 1), KRS 367.626(2)(a).

**PAY-3 Progress payments** - optional on cash; the milestone form on large Ohio jobs. Confidence **MED**.
ATTORNEY MUST CONFIRM: yes - Q5, Q6.

> Payments are due at these milestones: {{milestone 1 label and percent}}, {{milestone 2}}, {{milestone 3}}. Each
> milestone is invoiced when it is reached and is due {{N}} days after the invoice.

Guardrail from the memo (Part C1, "Financing" row; 12 CFR 1026.2(a)(17)(i), PRIMARY-SUMMARIZED): a seller becomes a
Reg Z "creditor" with a finance charge **or** more than four installments. Keep schedules at four payments or fewer
and do not describe any interest as a "finance charge".

**PAY-4 Final payment, completion, due date** - all sets (KY insurance variant below). Confidence **LOW**.
ATTORNEY MUST CONFIRM: yes - Q10, Q29.

> **Completion and final payment.** The work is complete when the work in the contract is finished and NBD has offered
> you a walkthrough. The final payment is due within {{7}} days after NBD sends you the final invoice. If you find
> items that still need attention, tell NBD in writing within {{3}} days of the walkthrough; NBD will fix them, and
> the amount for those listed items - and only those - may be held back until they are done. The rest is due.

Why: today the contract says "balance on completion" with no day count, "completion" is undefined, and `/the-pledge`
promises "walkthrough before the balance is due" (inventory section 3.2, item 9). This clause reconciles them. Kentucky
insurance variant: add "any amount the insurer has not yet released is due when the insurer releases it, and is not
overdue before then" (matches `payLinkHold` / `invoiceOverdue`). No statute is cited because none was located; this is
drafting. The holdback sentence is a business choice for Jo, not a legal one.

**PAY-5 Disputed amounts** - all sets. Confidence **LOW**. ATTORNEY MUST CONFIRM: yes - Q10.

> If you dispute part of an invoice, tell NBD in writing within {{10}} days of the invoice date and say what you
> dispute and why. The part you do not dispute is still due on time.

(The Payment Agreement template already carries a 10-day version, inventory section 3.3; this promotes it into the
contract.)

**PAY-6 Payment source and shortfalls** - OH insurance, KY insurance, financed. Confidence **MED** / **LOW** on KY
shortfall. ATTORNEY MUST CONFIRM: yes - Q7, Q12.

> You may pay from insurance proceeds, your own funds, financing, or a combination. Your insurer's payment schedule
> does not change what is due under this contract. Amounts your insurer does not pay remain your responsibility, as the
> law allows.

Do not add "regardless of insurance outcome" absolutes on Kentucky insurance jobs; the last words ("as the law allows")
are deliberate, pending Q7/Q12. Builds on the existing payment clause (INS-1). Financed variant: "Your lender's terms
control your loan. NBD is not your lender."

**PAY-7 Methods accepted** - all sets. Confidence **LOW** (a fact question). ATTORNEY MUST CONFIRM: no - Jo decides (D10).

> NBD accepts the payment methods listed on your invoice.

Fixes a live contradiction: the default says "No cash payments accepted" while invoices carry Zelle and the CRM
records cash (inventory section 4, item 3). Method *lists* belong on the invoice, not frozen in the contract.
Also remove the schedule sentence ("Material delays may extend timeline") riding inside that string; it moves to SCH-1.

---

## A3. Family 3 - Late payment, fees, collection costs

Legal frame from the memo (Part B items 7 and 9, Part C1): an Ohio late-fee or interest term that appears **only on an
invoice** is unenforceable (Minster Farmers, 2008-Ohio-1259; Sal's Heating, 2023-Ohio-3632, read in full). The term
must be in the contract the customer **signs before work starts**. So LATE-1 to LATE-4 live in the contract; the
invoice only *refers* to them.

**LATE-1 Interest on past-due amounts** - V per state. Confidence **LOW-MED** (the Ohio ceiling question is
genuinely open). ATTORNEY MUST CONFIRM: yes - Q1, Q2, Q5. Rate and grace days are decision D1.

> **Late payments.** If an amount is not paid within {{GRACE}} days after its due date, simple interest at
> {{RATE}}% per year (not compounded) applies to the unpaid amount from the end of that period until it is paid, or
> at the highest rate the law allows if that is lower. Interest does not apply to an amount you have disputed in good
> faith in writing under {{PAY-5}} until the dispute is resolved, and does not apply to any amount your insurer or
> lender has not yet been required to pay.

Design notes:

- Wording is "interest" / "late payment", **not** "finance charge" (Truth in Lending vocabulary, memo Part E item 3).
- The savings phrase ("or the highest rate the law allows if lower") is common but its enforceability as a usury cure
  is UNCERTAIN; counsel should say whether to keep it.
- State variants differ only in `{{RATE}}`: see D1 for the ceilings (Ohio 8% written-instrument ceiling if ORC
  1343.01(A) applies; Kentucky lesser of 4 points over the benchmark or 19% on $15,000 or less, knowing excess forfeits
  *all* interest and double recovery within 2 years, KRS 360.020).
- Insurance and lender carve-outs address the memo's unconscionability warning (ORC 1345.03; KRS 367.170) and the
  Kentucky pay-hold.
- Rests on: ORC 1343.03(A) (a written contract may set the rate once money is due), 1343.01(A), KRS 360.010(1)(a),
  360.020, 360.040(3).

**LATE-2 Flat late fee (OFF by default)** - optional, Ohio/KY cash only. Confidence **LOW**. ATTORNEY MUST CONFIRM:
yes - Q3. Decision D2.

> A one-time late fee of {{AMOUNT}} applies if an invoice is more than {{N}} days past due.

Not recommended (memo Part C1 option B): reads as a penalty; Ohio's liquidated-damages test (Samson Sales; Pacetti's,
2023-Ohio-93, SECONDARY) and Kentucky's retrospective test (Mattingly Bridge, SECONDARY) both bite on a flat fee.

**LATE-3 Attorney fees and collection costs (mutual)** - all sets; Kentucky variant adds the "actually paid" limit.
Confidence **MED** (Ohio, via Sal's) / **HIGH** (KRS 411.195 text). ATTORNEY MUST CONFIRM: yes - Q4. Decision D3.

> **Costs of enforcing this contract.** If either side has to go to court to enforce this contract, the side that
> prevails recovers its reasonable attorney fees and court costs from the other, as the court decides. If NBD refers
> an overdue amount to an attorney or collection agency, you will also owe the reasonable fees and costs NBD actually
> incurred in collecting it.

Kentucky variant adds: "Fees are limited to amounts actually paid or agreed to be paid to an attorney who is not an
employee of NBD." Rests on: Paul Davis Restoration v. Karaman (8th Dist. 2005-Ohio-4017, via Sal's), KRS 411.195
(verbatim), KRS 367.220(3), ORC 1345.09(F). Percentage-of-debt collection fees were **not researched** (Q4). Mutual on
purpose: one-way clauses invite an unconscionability / CSPA argument (memo Part C1 option D).

**LATE-4 Contract controls over invoice** - all sets. Confidence **MED**. ATTORNEY MUST CONFIRM: yes - Q1.

> Invoices, reminders and payment links are for convenience. They refer to this contract and do not change it. The
> late-payment and cost terms that apply to your job are the ones in this contract.

This is what lets an invoice *reference* the clause (the invoice then says "Late payments: see section X of your
signed contract") instead of being the only place the term lives.

**LATE-5 No discounts or rebates** - Kentucky insurance (required); Ohio insurance optional. Confidence **HIGH** (KY).
ATTORNEY MUST CONFIRM: yes - Q7.

> NBD does not give any discount, rebate, credit or allowance on your insurance deductible or on any other part of
> the price because the job is paid by insurance. You pay the full deductible.

Rests on: KRS 367.628(2)(b)-(d) (no deductible rebate; no allowance or discount; no payments to the insured over
$100). Consequence for the build: **no early-pay discount feature on Kentucky insurance jobs, ever** (memo Part C1
option E). Ohio has no equivalent found (NOT FOUND, not the same as absent), but the same wording is the safe default.

**LATE-6 Right to suspend for non-payment** - optional; KY insurance variant. Confidence **LOW**. ATTORNEY MUST
CONFIRM: yes - Q10.

> If a payment that is due under the payment schedule is not made within {{5}} days after NBD's written notice, NBD may
> pause work until it is made. Pausing is not a breach by NBD, and the schedule moves by the length of the pause.

No statute located either way. Kentucky insurance variant: applies only to amounts already due after the cancellation
period and not held by the insurer's decision timing. Pausing a half-open roof has a safety/weather side: add "NBD
will first make the roof weather-tight" (a business choice for Jo).

---

## A4. Family 4 - Change orders and hidden conditions

**CO-1 Change orders** - all sets. Confidence **LOW-MED**. ATTORNEY MUST CONFIRM: yes - Q29.

> Changes to the scope or price are made only by a change order that describes the work, the price change and any
> effect on the schedule, and that you approve in writing (signature, or an email or text from you that NBD keeps).
> NBD does not start changed work before approval, except as CO-2 allows to keep the home weather-tight.

Replaces the current internally contradictory pair ("signed by both parties" vs "NBD reserves the right to adjust
pricing and completion dates", inventory section 2B). Drafting note: the unilateral right is removed on purpose; a
one-way price-adjustment sentence is the kind of term a CSPA unconscionability argument targets. Rests on: OAC
109:4-3-05 (final bill not above estimate by more than the greater of $5 or 10% without consumer approval - applicability
to roofing UNCERTAIN, treat as applying; memo Part D section 3).

**CO-2 Hidden conditions and decking** - all sets. Confidence **LOW**. ATTORNEY MUST CONFIRM: yes - Q22.

> **Hidden conditions.** Some conditions cannot be seen until the old roof is removed - for example rotted or damaged
> decking or framing. The price includes replacement of up to {{ALLOWANCE}} of decking. If more is needed, NBD will
> photograph it, tell you before replacing it, and charge {{UNIT_PRICE}} per sheet (or the amount shown in the change
> order for other repairs). If the roof would otherwise be left open to weather and NBD cannot reach you, NBD may do
> only the minimum needed to make the home weather-tight and will bill that work at the same rate. Code-required
> upgrades that were not visible before tear-off are handled the same way.

Pricing numbers come from the estimate config (retail only; the repo's cost-privacy guard applies). Ohio over $25,000:
ORC 4722.02 requires an unforeseen-cost notice and election; reference the same text the estimate prints
(memo Part D section 3, $5,000 unforeseen-cost notice, PRIMARY-SUMMARIZED).

**CO-3 Insurance supplements** - insurance sets. Confidence **LOW**. ATTORNEY MUST CONFIRM: yes - Q30.

> If your insurer approves additional amounts for this job, NBD will send you the supplement and the contract price
> changes by the approved amount only after you approve it in writing.

Fixes the finding that carrier-approved supplements are folded into the invoice with no homeowner signature
(inventory section 2B). Kentucky: NBD may give estimates and confer with the insurer after the claim is filed
(KRS 367.628(1)); it may not "negotiate" or represent the insured, so supplement language must say NBD sends
*documentation*, never "NBD will get the supplement approved".

---

## A5. Family 5 - Schedule, weather, access, permits, HOA

All three: confidence **LOW** (drafting practice; no statute located, memo Part D section 4 last row). ATTORNEY MUST
CONFIRM: yes - Q22.

**SCH-1 Schedule and weather**

> Start and finish dates are estimates. Weather, material delivery and conditions found during the work can move them.
> A delay for these reasons is not a breach, and time is not of the essence. NBD will tell you about material changes
> to the schedule.

**SCH-2 Access, utilities, interior**

> You will give NBD access to the work area, including driveways, attic and utilities (power and water), and will
> remove vehicles, pets, and valuables from areas the work can reach, including items hanging on interior walls and
> stored in the attic. NBD is not responsible for loose items that were not removed.

(Interplay with DISP-6: the interior-damage carve-out must not defeat NBD's own negligence duty; counsel to shape.)

**SCH-3 Permits and HOA**

> NBD will obtain the building permit where one is required and its fee is part of the price [or: is billed at cost].
> If your property is in a homeowners' association, getting any required approval is your responsibility, and NBD is
> not responsible for fines or removal costs if work was done to an approved design.

Whether NBD or the owner pulls permits, and whether the fee is billed through, is a Jo operations decision (not a legal
one). Cincinnati requires contractor registration before permits; do not state it as "licensed" (memo Part D section 5).

---

## A6. Family 6 - Insurance-job specifics

**INS-1 No claim representation (payment clause)** - insurance sets. Confidence **HIGH** (KY) / **MED** (OH).
ATTORNEY MUST CONFIRM: yes - Q7.

Keep the shipped sentence verbatim (it is already the CRM's AOB replacement, `KyLaw.PAYMENT_CLAUSE`):

> Homeowner will pay Contractor the contract price according to the payment schedule above. Homeowner may pay from
> insurance proceeds, personal funds, financing, or any combination. This contract does not transfer or give
> Contractor any rights or benefits under Homeowner's insurance policy, and Contractor will not represent Homeowner
> or act for Homeowner on any insurance claim.

Rests on: KRS 367.628(1) (no representing/negotiating for the insured; may give estimates and confer with the insurer
after the claim is filed), KRS 304.20-105. Gap the inventory found: this clause is **not printed on the deal page**
(path B), the one Kentucky-insurance acceptance surface that is not a generated contract. Ohio: public-adjuster law
(ORC ch. 3951, SECONDARY) reserves claim negotiation to licensed adjusters; the Ohio set uses the same sentence.

**INS-2 Deductible is the homeowner's** - V OH / KY. Confidence **HIGH** (KY, via LATE-5) / **LOW** (OH).
ATTORNEY MUST CONFIRM: yes - Q7.

> The insurance deductible is your responsibility. NBD does not waive, reduce or absorb it.

Do **not** add promises such as "we'll cover your deductible" anywhere (KRS 367.628(2)(b); also an existing marketing
rule). Ohio deductible-waiver statute: NOT FOUND (memo); wording kept conservative.

**INS-3 Insurer denial / price contingency** - OH optional; KY statutory. Confidence **HIGH** (KY) / **LOW** (OH).
ATTORNEY MUST CONFIRM: yes - Q7, Q8.

> **Kentucky:** use the statute's own notices and form (INS-4); do not paraphrase them.
>
> **Ohio (optional):** If your insurer denies coverage in writing before work starts, either of us may cancel this
> contract in writing and NBD will refund any deposit within 10 business days.

Rests on: KRS 367.622 (5-business-day cancellation after the insurer's written notice of non-coverage), 367.626(1)-(3)
(unenforceable if cancelled; NBD may still collect a reasonable and customary amount for repair/emergency work done).
How the clock runs if the insurer never issues a denial is UNCERTAIN (memo Part D section 3). The Ohio sentence is
Claude's drafting; no Ohio statute was found; it is offered because it reduces CSPA exposure and mirrors the Kentucky
rule.

**INS-4 Kentucky statutory notices and cancellation form** - KY insurance only. Confidence **HIGH**. ATTORNEY MUST
CONFIRM: yes - Q8.

Not redrafted: render `KyLaw` notice text (KRS 367.624(3)(a),(b); detachable NOTICE OF CANCELLATION in duplicate) from
`ky-insurance-law.js` unchanged. The clause module only decides *where* it is shown and stamps the version. Contractor
mailing address, phone and email print here because the statute requires them.

**INS-5 No assignment of benefits** - KY required; OH optional. Confidence **HIGH** (KY). ATTORNEY MUST CONFIRM: yes - Q7.

> You are not assigning any part of your insurance policy or claim to NBD. You may ask your insurer to include NBD as a
> payee; that is a direction to pay, not an assignment.

Rests on: KRS 304.20-105 (assignment void; direction to pay allowed, subsection (4)(b)). Counsel to confirm the
second sentence is how a direction to pay should be described.

---

## A7. Family 7 - Warranty

Warranty duration, transfer rules and tier wording **stay single-sourced** from `estimate-config.js`
(`tierWarrantyText`, `TIER_LABOR_YEARS`; pinned by `tests/warranty-pledge-labor-years-2026-10-06.test.js`). The clauses
below add the parts that are missing (inventory section 2C): exclusions on every certificate, conditions, a claim
procedure, and how the manufacturer's warranty relates. Confidence overall **LOW-MED**. ATTORNEY MUST CONFIRM: yes -
Q20, Q21.

**WAR-1 Scope** - NBD's written workmanship warranty covers defects in installation labor for the period shown for your
package. It does not cover materials (the manufacturer's warranty does).

**WAR-2 Exclusions** (printed on **every** warranty certificate, not only the server copy):

> The warranty does not cover damage caused by: storms, hail, wind or other acts of nature; ice or water from causes
> outside the work NBD did; lack of normal maintenance; changes, repairs or installations by anyone other than NBD
> (including solar, satellite, antenna or HVAC work); pre-existing conditions or structure outside the contract scope;
> foot traffic or impact; materials you supplied; or non-payment of the contract price.

**WAR-3 Conditions and claim procedure**

> To make a claim, tell NBD in writing (email, text or the customer portal) within {{30}} days of finding the problem,
> protect the home from further damage (for example with a tarp), and give NBD access to inspect. NBD will inspect
> and, if the problem is covered, repair it or replace the defective work at its option. This warranty is in effect
> only when the contract price has been paid in full.

**WAR-4 Transfer** - rendered from tier config (e.g. non-transferable on the lowest tier; one transfer within a stated
window on the middle; fully transferable on the top tiers). Do not retype.

**WAR-5 Manufacturer warranty** - "Manufacturer warranties are provided by the manufacturer on its own terms and are
separate from NBD's workmanship warranty. {{who registers and by when}}." Credentials must match the public footer
only (GAF Certified, not Master Elite; TAMKO Pro Gold; no IKO claim until approved).

**WAR-6 NBD Pledge** - define it **once**, in the same words as the public page: the page's gloss is "diagnosis ...
quote the fix fairly", i.e. a service commitment, not free repairs forever and not a warranty extension. The shipped
certificate prints only the short sentence ("we'll come back and make it right"), which is broader than the page
(inventory section 2C). Jo to approve the one definition (D12).

**WAR-7 Other warranties** - confidence **LOW**.

> Except as stated in this contract, NBD gives no other written warranty. This does not take away any warranty or
> duty that the law does not allow to be disclaimed.

The savings sentence is deliberate. Memo Part D section 4: Ohio treats the builder's duty of workmanlike construction
as imposed by law and non-waivable in the home-builder context (Jones v. Centex, SECONDARY); application to
remodel/repair is unsettled. A blanket "no implied warranties" disclaimer would invite a CSPA claim for little gain.
Also: the certificate line "Backed personally by Joe Deal" is a personal-liability statement - flagged for counsel
before reuse (D11).

---

## A8. Family 8 - Dispute resolution

All the memo's research on this family is thin (Part G: governing law, jury waiver, class waiver and
consequential-damages disclaimers were **not researched**), so confidence is **LOW** across the family and the
recommendations in Part B lean on first principles marked as such.

**DISP-1 Governing law (by property location)** - all sets. Confidence **MED**. ATTORNEY MUST CONFIRM: yes - Q18.

> The law of the state where the property is located governs this contract.

Replaces the live "under Kentucky law" sentence that currently prints on **Ohio** jobs (inventory section 3.3). The
consumer statutes (ORC 1345; KRS 367) attach by property location and a choice-of-law clause is not expected to
displace them (memo Part D section 3, UNCERTAIN). Also fixes the cancellation clause that cites a Kentucky statute on
every NBD job (CANC-1).

**DISP-2 Notice and chance to fix (optional)** - all sets. Confidence **LOW** (no statute either state - memo Part D
section 4). ATTORNEY MUST CONFIRM: yes - Q17.

> Before filing a claim about the work, you will give NBD written notice of the problem and at least {{30}} days (or as
> soon as practical for an active leak) to inspect and fix it. This does not prevent either side from taking steps to
> protect a legal deadline, including a lien or a lawsuit to enforce one, or from using small claims court.

The deadline carve-out matters: a cure period must never delay NBD's own lien clock (60 days Ohio, 6 months Kentucky).

**DISP-3 Resolution path** - three alternatives, one chosen per Part B (D5):

- **A. Courts only** (no clause beyond DISP-4).
- **B. Mediation first, then courts:** "If a dispute is not resolved by negotiation, the parties will try mediation
  before filing suit, sharing the mediator's fee equally. Either side may file in court to protect a deadline, to
  record or enforce a lien, or in small claims court."
- **C. Binding arbitration** (with or without class waiver): enforceable on its face - ORC 2711.01; KRS 417.050
  (PRIMARY, memo Part D section 4) - but subject to unconscionability; class/consumer-specific limits NOT researched;
  administrator fees can exceed small balances; lien enforcement is a court proceeding in any event.

Today's text ("mediation **or** binding arbitration under Kentucky law", no election mechanism, rules, seat or cost
split) is **not** among these and should be removed in any case.

**DISP-4 Venue** - all sets. Confidence **LOW-MED**. ATTORNEY MUST CONFIRM: yes - Q18.

> Any court case will be filed in the county where the property is located (or in small claims there).

**DISP-5 Jury waiver (optional, OFF by default)** - confidence **LOW**, not researched. Q16.

**DISP-6 Limitation of liability (optional)** - confidence **LOW**. ATTORNEY MUST CONFIRM: yes - Q20.

> To the extent the law allows, NBD's total liability for claims arising out of the work is limited to the contract
> price, and neither side is liable to the other for indirect or consequential damages. This does not limit liability
> for personal injury, fraud, or anything the law does not allow to be limited.

Today this prints on **proposals only** (inventory section 2B). Ohio voids construction indemnity for the indemnitee's
own negligence (ORC 2305.31) and Kentucky does likewise with reversed definitions (KRS 371.180) - those statutes concern
indemnity, but they show the courts' posture; a cap on liability for NBD's own negligence is untested here (NOT
researched).

**DISP-7 Shortened claim period (optional, OFF by default)** - confidence **LOW**. ATTORNEY MUST CONFIRM: yes - Q19.
Ohio permits a shorter contractual period if clear and reasonable (Colvin; Miller; Sarmiento, SECONDARY); Kentucky: no
authority found. Statutes of repose are 10 years (ORC 2305.131) and 7 years (KRS 413.135) and are not contractual.

**DISP-8 Boilerplate** - confidence **MED** (standard): severability; entire agreement and written-modification
(replaces the thin current sentence and moves it onto **every** signing path); assignment (NBD may assign amounts owed
to it; you may not assign the contract without NBD's written consent); notices (email/phone/mail address for each
side); counterparts and electronic signatures. ATTORNEY MUST CONFIRM: yes - Q16.

---

## A9. Family 9 - Independent subcontractors

**SUB-1** - all sets. Confidence **MED** (OAC 109:4-3-05, summarised, requires disclosing subcontracting where a
warranty is disclaimed). ATTORNEY MUST CONFIRM: yes - Q22.

> NBD performs this work using independent subcontractors that NBD selects, schedules and pays, with NBD's owner
> supervising the work. NBD is responsible to you under this contract for the work, including work done by its
> subcontractors. Subcontractors are not NBD employees.

Honesty gates (must stay green - Part E): never "in-house", "our employees" or W-2 language; never "licensed". Add
"subcontractors carry their own insurance" **only if** certificate-of-insurance tracking is actually enforced; today
COI expiry is tracked and warned, never blocking (inventory section 2E). Until that is real, use "NBD will provide a
certificate of insurance on request." Jo to confirm he wants "owner supervising" in this wording - it must be true on
every job it prints on.

---

## A10. Family 10 - E-signature, communications, media

**ESIGN-1 Electronic signature and records** - all sets. Confidence **MED** (ORC 1306.06 and KRS 369.107 give e-signed
contracts effect; consumer-disclosure content from general knowledge of the federal ESIGN Act, not in the memo - LOW).
ATTORNEY MUST CONFIRM: yes - Q25.

> You agree to sign this contract and receive related documents electronically. Your electronic signature has the same
> effect as a handwritten one. You may ask for a paper copy at no charge, and you may withdraw this consent before
> signing by telling NBD, in which case NBD will give you paper documents. NBD will give you a signed copy.

Today there are two different one-sentence versions and **none** on the in-person and remote HTML paths (inventory
section 2B, 7). One text, one version stamp, shown and recorded on all paths.

**ESIGN-2 Job communications consent** - all sets. Confidence **LOW** (TCPA is covered by the repo's compliance
reference, not the memo). ATTORNEY MUST CONFIRM: yes - Q28.

> NBD may contact you by phone, text and email about this job (scheduling, access, invoices). Message and data rates may
> apply. Reply STOP to stop texts.

Lead-form consent is already recorded (`tcpa-consent.js`); this repeats it at contracting. Subject to the A2P
registration status noted in the current handoff - wording must match what the carrier-approved campaign says.

**MEDIA-1 Photos** - all sets. Confidence **LOW**. ATTORNEY MUST CONFIRM: yes - Q27.

> NBD takes photos and video of your property for the work record, warranty and any insurance documentation. NBD
> uses them for that purpose. [ ] You agree that NBD may publish photos of the finished work without your name or
> address (optional - check to allow).

The optional box matches the publishing rule in the PUBLISH-PROJECT runbook (consent on file; EXIF-stripped copies).
It becomes a captured field instead of a self-attested sentence.

---

## A11. Family 11 - Cancellation notices

**CANC-1** - by property state; module text, not redrafted. Confidence **HIGH** (KY) / **MED** (OH). ATTORNEY MUST
CONFIRM: yes - Q8, Q9.

- **Ohio property:** dated written contract with the "Notice of Cancellation" in bold 10-point, detachable form, by the
  third business day; seller may not begin services in the window (ORC 1345.21-.24, 1345.28; memo Part D section 3).
- **Kentucky property:** "BUYER'S RIGHT TO CANCEL" caption; if missing, the buyer may cancel at any time; no
  compensation for services performed before cancellation (KRS 367.410-.460).
- **Kentucky insurance:** add the 5-business-day notice and form (INS-4).
- **Financed on the home:** Reg Z rescission replaces the state notice (ORC 1345.21 exclusion, PRIMARY-SUMMARIZED;
  16 CFR 429 FTC rule PRIMARY-SUMMARIZED, interplay not read).
- **Emergency work in the window:** only on a separate, handwritten (Ohio), dated, signed written request; whether a
  tap-to-sign on a phone qualifies as "handwritten" is Q9.

Fixes found in the inventory (section 4 items 1, 2, 13): the clause cites KRS 367.390 on every job (the memo's cites are
367.410-.460; 367.390 does not appear in it - counsel to confirm which is right); says "refunded within 10 days"
beside a form that says ten business days; and the Work Authorization lets a customer cancel "by calling" when the notice
must be written. The module renders the correct state citation from the property state.

---

# Part B. Decisions for Jo

Each: options, legal risk (memo cite), recommendation. "Reco" is Claude's lean; it is **not** a legal opinion and moves
with the attorney's answers. Nothing here has been decided.

## D1. Late interest rate (within the ceilings)

| Option | What it is | Legal risk |
| --- | --- | --- |
| **A. Statutory rate only** | "Interest at the rate allowed by law" (Ohio: the 5703.47 rate, SECONDARY 7% for 2026; Kentucky 8% after default, KRS 360.010(4)) | Lowest risk (memo Part C1 option C). Little deterrent before suit; the number changes yearly. |
| **B. 8% simple, both states** | Matches Ohio's written-instrument ceiling in ORC 1343.01(A) if it applies, and sits far inside Kentucky's cap | Low. Modest deterrent. Safe harbor in both states pending Q1/Q2. |
| **C. 1% to 1.5% per month** | 12% to 18% a year, NBD's current 1.5% line. Common on contractor paper (SECONDARY) | **Ohio:** usury argument if 1343.01(A) reaches a service contract (UNCERTAIN); CSPA unconscionability (ORC 1345.03). **Kentucky:** likely under 19% on $15,000 or less but a knowing excess forfeits **all** interest and double recovery (KRS 360.020) and the benchmark is hard to identify. |

**Reco:** **B (8% simple) in both states** until counsel answers Q1/Q2, with a 15-day grace and a written-dispute
carve-out. If counsel clears Ohio at a higher rate, raise it by editing one config value. Reason: the interest is
leverage for a *conversation*, not revenue; the statute-backed levers that actually move a past-due homeowner are the
lien and fee-shifting, and a rate fight is a litigation distraction.

## D2. Flat late fee: yes or no

| Option | Risk |
| --- | --- |
| A. No flat fee | None added. |
| B. Small flat fee (admin cost) | Liquidated-damages / penalty test in both states (Samson Sales; Mattingly Bridge, SECONDARY); retrospective in Kentucky. |
| C. Percentage fee (e.g. 5%) | Worst: 5% of a large balance for one day late reads as a penalty (memo Part C1 option B). |

**Reco:** **A, no flat fee.** Interest plus mutual fee-shifting does the work with less to defend. Revisit only if
counsel volunteers a structure they will stand behind (Q3).

## D3. Fee-shifting mutuality

| Option | Risk |
| --- | --- |
| A. None | NBD pays its own lawyer in every collection suit. |
| B. **Mutual** prevailing-party | Enforceable if bargained-for and signed before work (Paul Davis via Sal's; KRS 411.195). Cuts both ways: NBD pays the homeowner's fees if it loses. |
| C. One-way (NBD only) | Unconscionability / CSPA challenge; invites a court to void it or read it mutual (memo Part C1 option D). |

**Reco:** **B, mutual**, plus actually-incurred collection costs. Mutual is what makes it defensible, and NBD's job
quality is its own protection against paying fees.

## D4. Deposit structure under ORC 4722.04

| Option | What it is | Risk / cost |
| --- | --- | --- |
| A. **Status quo:** 10% cap at $25,000+, 50% below (current, live) | Aligned with the shipped build | Under 4722.01 "more than $25,000" vs 4722.02 "$25,000 or more" the boundary is inconsistent; a $24,000 Ohio roof at 50% rests on the reading that the chapter does not reach it (Q6). The build already treats $25,000 exactly as covered, the cautious side. |
| B. 10% on **every** Ohio job over the cash threshold | Conservative | Safe, but heavy cash-flow cost on every Ohio roof; no statutory reason found if the chapter really starts above $25,000. |
| C. Milestone draws on all Ohio jobs (e.g. 10/40/50) | Works under any reading; at most four installments so NBD is not a Reg Z "creditor" (12 CFR 1026.2(a)(17)(i)) | Operational: invoices at milestones; the 10/40/50 invoice-hold is already built for $25,000+. |

**Reco:** **A now** (it is live and the cautious boundary is already in) **and ask Q6**; if counsel says the cap
reaches under-$25,000 contracts, move the Ohio sub-$25,000 jobs to **C**, not B. Penalties are up to $25,000 per
violation and owner rescission (ORC 4722.07-.08), which is why this is not a "just ship it" item.

## D5. Courts, mediation or arbitration

| Option | What it is | Legal risk |
| --- | --- | --- |
| A. **Courts only** | No ADR clause; venue = property county | Plainest and cheapest to maintain; slower for small balances but small claims exist. |
| B. **Mediation first, then courts** | Carve-outs for liens, small claims, protecting deadlines | Enforceable as a condition; low risk. Adds a step before NBD can sue on a past-due balance. |
| C. **Binding arbitration** (+/- class waiver) | AAA-style, fee split | Valid on its face (ORC 2711.01, KRS 417.050) but unconscionability applies to consumer form contracts; class waiver NOT researched; arbitration fees can exceed a $3,000 balance; lien foreclosure is a court case regardless. |

**Reco (first principles, not researched):** **B** - mediation first with the lien/small-claims carve-outs; no
arbitration and no class waiver at launch. NBD is mostly the plaintiff on small balances, where arbitration costs hurt
the plaintiff, and the one tool that actually secures a debt (the lien) lives in court. Q16 may change this.

## D6. Governing law and venue

| Option | Risk |
| --- | --- |
| A. Law and courts of the **property's state, county of the property** | Matches where consumer statutes attach; simplest to defend. |
| B. Ohio law and Hamilton County for all jobs (NBD's home) | Kentucky consumer statutes still apply to Kentucky jobs; a distant venue for a Kentucky homeowner is a CSPA/KCPA unconscionability risk. |
| C. Today's text: Kentucky law for every NBD job | Wrong on Ohio property; the inventory lists it as contradiction 1. |

**Reco:** **A.**

## D7. Limitation of liability

| Option | Risk |
| --- | --- |
| A. None | Open-ended exposure on an interior-damage claim. |
| B. Cap at contract price + exclude consequential damages, with the savings sentence | Untested for a contractor's own negligence in a home-repair consumer contract (NOT researched); may be read as unconscionable if broad. |
| C. Cap for **specific** items only (items left in the attic, owner-supplied materials, delays) | Narrower, more likely to hold, less coverage. |

**Reco:** **C now, B only if counsel approves** (Q20). NBD's liability insurance is the real protection for
interior damage; do not lean on a paper cap to do an insurer's job.

## D8. Shortening the claim period

| Option | Risk |
| --- | --- |
| A. No shortening | Ohio 6 years on written contract (ORC 2305.06), Kentucky 10 years (KRS 413.160); repose 10/7 years. |
| B. Shorten to a stated period (e.g. 1-2 years) | Ohio allows if reasonable and clear (SECONDARY); **Kentucky: no authority found**; consumer-statute claims have their own 2-year window (ORC 1345.10, KRS 367.220). |

**Reco:** **A, none**; instead use the warranty claim-notice rule (WAR-3) to cut off *late-discovered* warranty claims,
which gets most of the benefit without a statute-of-limitations fight.

## D9. Lien posture, including Kentucky insurance jobs

| Option | Risk |
| --- | --- |
| A. **Track and protect, file as a last resort** | Calendar every deadline; a lien is a lever not a default. Lowest customer-relations and statutory risk. |
| B. Lien automatically at the first missed deadline | Faster leverage; a defective filing (wrong amount, missed 7-day mailing in Kentucky) is a liability, and on Kentucky insurance jobs a filing above the insurer's payment is a violation (KRS 367.628(2)(g)). |
| C. Never lien; rely on suit | Gives up the strongest practical lever; deadline loss is permanent. |

**Reco:** **A**, with Kentucky insurance jobs defaulting to "no lien for any amount above insurer-paid" until Q12 is
answered. The tracker (Part C) makes A cheap.

## D10. The existing 1.5% invoice line and payment-method string

The live invoice fallback prints "may be subject to a 1.5% monthly finance charge" and the contract default says "No
cash payments accepted". For jobs whose signed contract contains **neither**, the invoice line is not enforceable in
Ohio (Minster; Sal's) and invites the Reg Z label argument.

| Option | Risk |
| --- | --- |
| A. Leave until the new set ships | Keeps an unenforceable term on live invoices. |
| B. **Remove** the late-fee sentence from invoices of jobs signed without it; print only "Net 7" | Removal-only; no new legal text. Costs nothing legally. |
| C. Replace with the LATE-4 reference line | Needs the clause live first. |

**Reco:** **B now** (needs Jo's OK because it touches shipped templates), **C after** the new set is live. Also fix the
payment-method string to PAY-7.

## D11. Contracting entity name

Four forms of the party exist on paper (inventory section 4 item 10): the public Terms "No Big Deal Solutions LLC",
Stripe footer "No Big Deal Home Solutions, LLC", SaaS terms "a sole proprietorship owned and operated by Joe Deal", brand
"No Big Deal Home Solutions". A plaintiff must sue in the right name, and "Backed personally by Joe Deal" on a
certificate is a personal-liability statement.

| Option | Risk |
| --- | --- |
| A. Pick the one true legal name now and use it everywhere | Needs Jo's facts (Secretary of State record). Lowest long-term risk. |
| B. Leave as is | Contract party ambiguity, weaker suit and weaker liability separation. |

**Reco:** **A** - first fact-check what is registered, then one name on every contract (Q24). Do not attempt this from
the repo; it is a records question for Jo.

## D12. Warranty conditions and the Pledge

| Option | Risk |
| --- | --- |
| A. Add WAR-2/WAR-3 (exclusions, 30-day notice, paid-in-full condition) | Standard; the "paid in full" condition should be shown beside the price, not buried (CSPA, ORC 1345.03). |
| B. Also define the Pledge as a service commitment, not a warranty | Closes the gap between the site page and the certificate line. |
| C. Leave warranty text as is | The client certificate currently has **no exclusions** at all (inventory section 2C). |

**Reco:** **A + B.** It is the cheapest strengthening in the whole plan and the claim procedure is where disputes start.

---

# Part C. Implementation map (code, not text)

All paths below are from the inventory (`origin/main` @ `5f1534a8`, 2026-10-13); line numbers there. Sizes: **S** under
a day, **M** 1-3 days, **L** more. Risk: **low / med / high** (high = money, consumer-law exposure, or a primary path).

## C0. Principles

1. **One clause module, two copies, one version.** New `contract-clauses.js` in `docs/pro/js/` and `functions/`,
   byte-identical after EOL normalisation, with a test - the same pattern as `ky-insurance-law.js` and
   `deposit-rule.js`. It exports `selectSet({state, paymentSource})`, `render(setId, {html|lines})`, `CLAUSE_SET_VERSION`
   and per-clause ids.
2. **Fail closed** - unknown state falls to the stricter set (Kentucky insurance), as `KyLaw` already does.
3. **Never touch price.** The module reads config and the signed price; it never writes them. Signed-price rules
   (2026-10-07) and money-in-cents are unchanged.
4. **New contracts only.** A contract carries its `clauseSetVersion`; a null version means legacy and is never
   re-rendered with new text. The signed HTML is already locked; the evidence copy is immutable.
5. **External JS, no inline scripts, no `on*=`** (strict CSP); marker regions untouched.
6. **Tenant safety.** The CRM is multi-tenant. The NBD-specific attorney-reviewed set is keyed to NBD's company
   profile; other tenants keep the neutral defaults and are not handed clauses presented as reviewed. Statutory
   families (cancellation, Kentucky notices, lien-for-excess) are **not** tenant-editable text.
7. **First action of any build:** read NBD's saved `companyProfile/{uid}` legal-text overrides (they beat the defaults
   the inventory quoted).

## C1. The signing paths: what each shows, what it must show, the change

| Path | Shows today (inventory sections 1, 2) | Must show | Engineering change | Size / risk |
| --- | --- | --- | --- | --- |
| **A. Envelope e-sign estimate PDF** (`esign-envelope.js`, `estimate-esign-pdf.js`) | Scope, price, payment terms, payment clause, acceptance sentence, FTC statement, cancel forms. **No** change-order, dispute, warranty, lien, late text. Refuses Kentucky insurance jobs. | The full set for OH cash / KY cash / financed (PAY, LATE, LIEN, CO, SCH, WAR-1..7, DISP, SUB, ESIGN, MEDIA, CANC). | Append clause pages rendered from the module to the source PDF so the **existing** source/values/signed SHA-256 chain covers them; record `clauseSetVersion` in the envelope and audit array; keep the Kentucky-insurance refusal. | M / med |
| **B. Deal-room acceptance** (`close-board.js`, `deal-acceptance.js`) | Tier cards, deposit line, insurance box, FTC + KY notices, one authorisation sentence. **No** payment clause, late fee, change order, dispute, lien (KY-ins lien undertaking not printed). The Kentucky-insurance acceptance path. | Same full set per job type, **including LIEN-3 and INS-1 on Kentucky insurance**, shown above the consent and signature. | Render the module into `generateDealPageHTML`; because the stored page is hashed (`deal-acceptance.js:511-525`), the terms are covered automatically; add `clauseSetVersion` to `acceptedEvidence`. Whether a collapsed section is "conspicuous" enough is Q26. | M-L / med |
| **C. Client-built contract HTML, signed in person** (`document-generator.js`, `renderContract`/`renderProposal`) | Fullest set but tenant-editable defaults and Kentucky-flavoured wording; proposal-only liability cap; no consent, no IP/UA, **no digest**. | The module's set (replaces tenant free-text for NBD); consent text shown and recorded. | `renderContract/renderProposal` consume the module; add a **server-side finalize callable** for in-person signing that stamps IP/UA, consent text and SHA-256 of the HTML at signing (the client cannot attest its own IP). Keep the rep's flow unchanged. | M-L / **high** (Jo's main path) |
| **D. Remote HTML signing link** (`remote-signing.js`, `sign.html`) | Same HTML as C. Records `signedAt`, signer name, original and signed SHA-256. **No** consent, IP, UA. | Same set; consent checkbox before signing. | Add the consent checkbox + text to `sign.html` (external JS), have `remote-signing.js` record IP/UA/consent text/version server-side beside the existing hashes. | S-M / med |
| **E. Server PDF contract** (`contract.hbs`, `renderPdf`) | Scope, payment schedule, warranty, cancel, payment clause, KY lien/notices; `additionalTerms` exists but is **never populated**. No change-order, dispute, entire-agreement. | Same set (this is the print/preview/export artifact). | Populate `additionalTerms` from the module (a partial in `functions/print/`); golden-PDF test. | M / low |

Related documents:

- **Warranty certificate**: three generators, two wordings, client copy has no exclusions. Collapse onto WAR-1..7 from
  the module (one text). M / med.
- **Payment Agreement**: contradicted by the deposit rule ("Work will not commence until the deposit..."). Align or
  retire. S / low.
- **Change Order**: signed CO is a free-standing document; see I7.
- **Invoices** (server `invoice.hbs`, client fallback, Stripe invoice footer, pay link, reminders): see I4.

## C2. Cross-cutting engineering items

| # | Item | What | Size | Risk |
| --- | --- | --- | --- | --- |
| **I1** | Shared clause module + selector | Part C0 items 1-2; set per `{state, paymentSource}`; test: byte-identity, every set renders, no unresolved `{{...}}`, scan against the wording gates | M-L | med |
| **I2** | **Set selector in the contract builder** | Derive property state and payment source from the lead; show the rep "Clause set: KY cash, vX" with a manual override that can only go **stricter**; block save if state is unknown | S-M | low |
| **I3** | **Version stamp on every signature** | `clauseSetId`, `clauseSetVersion`, `clauseTextSha256` recorded with the A/B/C/D evidence; shown on the signed document footer | S (each path) | low |
| **I4** | **Late-fee mechanics** | See C3 below | L | **high** |
| **I5** | **Lien-deadline tracking** | See C4 below | M | med |
| **I6** | **Waivers in and out** | See C5 below | M-L | med |
| **I7** | **Change-order ledger** | A signed CO adds to the contract total / invoice (today nothing does); insurer supplements require homeowner approval (CO-3); decking overage uses the CO-2 unit price from config | M | med |
| **I8** | **Evidence retention** | See C6 below | M | med |
| **I9** | **Evidence parity** | Consent + IP + UA + digest on in-person and remote (see C and D rows); alternative while unbuilt: soften `privacy.html` to what is true (S) | M | med |
| **I10** | **Removal-only cleanups** | Dead legacy "negotiate with my insurance company" template (`dashboard-ui.js:1524`); invented testimonial fallback; claim-guide "we handle the hard parts" and rate-increase sentence; stale `"License #"` line; wrong statute cite / "10 days"; "by calling" cancel; referral $250 literal vs $100; contradictory payment-method string | S each | low |
| **I11** | **Entity name** | One legal name on contract, Stripe footer, certificates, terms - after D11 | S | low |
| **I12** | **Flags + rollout switch** | `contractClausesV2` (client `NBDFlags`, `feature_flags/{uid}`) and a server env switch for function renders, default off | S | low |

Extend the wording gates (`claim-wording.test.js`, `ky-claims-wording-scan.test.js`, `oh-claims-wording-scan.test.js`,
`subcontracting-honesty.test.js`) to render **every** set and scan the output - today they scan source files, and the
inventory found the claim guide slipped past the narrow phrases.

## C3. Late-fee mechanics (I4)

1. **Capture, not compute, at signing.** The clause stamps a structured `lateTerms` object on the signed contract
   (`rateBps`, `graceDays`, `base`, `clauseSetVersion`, `compounding: none`). Present only when the signed clause is
   present. **No signed clause, no fee, ever** - Ohio unenforceability of invoice-only terms (memo Part B item 9).
2. **Invoice references, never originates.** Server `invoice.hbs`, the client fallback, Stripe invoice footer, pay-link
   description and the reminder text print "Late payments: see section X of your signed contract" (LATE-4) - one line,
   both renderers. Stripe footer stays text-only; no Stripe line item at first.
3. **Computed line only when `lateTerms` exists.** A pure function (cents, simple interest, day-count from the invoice
   due date + grace, on the **signed** balance) produces a *proposed* line. First release is **propose, rep approves**
   (a one-tap add on the Collections list), not automatic posting. Never posts to a Kentucky-insurance invoice inside
   the pay-hold (`payLinkHold` / `invoiceOverdue`), never on a disputed-in-writing invoice, never on the insurer's or
   lender's share.
4. **Ledger order.** Kentucky treats partial payments as going to interest first (KRS 360.020, memo Part D section 2):
   the payment-allocation order must be a documented, counsel-approved setting; do not infer it.
5. **Audit.** Every proposed/posted fee records the clause version, rate, days and who approved.
6. Test matrix: Ohio with clause / without clause / old contract; KY cash; KY insurance in/out of hold; disputed;
   partial payment; zero-rounding in cents; the 4-installment guard (memo Part C1, Financing row).

## C4. Lien-deadline tracking (I5)

- **Data per job:** `firstWorkDate`, `lastWorkDate` (defaults from the install stage move, always overridable by the
  rep - the affidavit must state both, ORC 1311.06), `lienClock` object with computed dates and a status.
- **Computed dates (display "verify with counsel"):** Ohio: affidavit within **60 days** of last work (residential
  1-2 family; 75 otherwise), serve the owner within **30 days** of filing, lien life **6 years**, demand-to-sue **60
  days**. Kentucky: sworn statement within **6 months**, mail the owner within **7 days**, suit within **12 months**
  of filing (memo Part C2/C3). Dates are held as plain calendar dates in the **property's** time zone; business-day
  rules and weekend roll-forward are Q11, not guessed.
- **Reminders** at e.g. T-21 and T-7 days, as Today-list tasks (the existing reminder plumbing), assigned to the owner.
- **Suppression:** Kentucky insurance jobs show "No lien for any amount above insurer-paid (KRS 367.628(2)(g))" and no
  filing countdown for the excess.
- **Filing packet - not auto-filing.** A pre-filled data sheet / draft affidavit (amount due after credits, property
  description and parcel, owner, claimant, first/last dates, county) for the rep or attorney to review and file;
  the product **never files** and never mails on its own. Recorded-document service dates (Ohio 30 days, Kentucky 7 days
  mailing) are tracked as fields the human completes.
- Size M, risk med: a wrong date is worse than none - hence conservative (earliest) dates and a visible disclaimer.

## C5. Lien waivers in and out (I6)

- **Incoming (from subs and suppliers):** on the existing sub and supplier records add a per-job waiver slot per
  payment (conditional on payment; amount and through-date); upload or e-sign capture; status "waivers outstanding" on
  the job. **Warn, never block** payouts or the final invoice (same philosophy as COI expiry today). This backs the
  "subcontractors and suppliers have been paid" statement NBD currently makes with nothing behind it (inventory
  section 2A).
- **Outgoing (NBD to owner/lender):** the existing templates (`document-generator-library.js:165-275`; DRAFT badge)
  generated **from a payment event**: progress -> conditional progress waiver for the amount and through-date; final ->
  conditional final, flipped to unconditional only when funds are marked cleared. Draft-only; the rep sends. Attorney
  reviews the four forms once (Q13), then the DRAFT badge comes off.
- No "no-lien" / advance-waiver clause in NBD's own contract (memo Part D section 1: disfavoured; do not add).

## C6. Evidence retention (I8)

- Hash the signed artifact on every path (I3/I9); keep source or original (C is overwritten in place today - archive the
  original like D does).
- Photos: server `createdAt` and client `capturedAt` already exist; add a "phase" requirement in the job file; keep
  originals; public copies stay EXIF-stripped.
- Change-order approvals linked to price (I7); the communications log (email/SMS/calls) is already write-protected.
- **Retention rule:** keep signed contract, change orders, photos and comms for at least the longest limitation or
  repose period that could apply (Ohio repose 10 years, ORC 2305.131; Kentucky 7, KRS 413.135) - counsel sets the number
  (Q26); state it on `privacy.html` (today silent on contracts and photos).
- **Legal hold:** a per-job flag, set when a dispute is opened, that suspends the 30-day PDF reaper and any deletion.

## C7. Rollout order (feature-flagged, new contracts only)

| Phase | Needs the attorney? | What | Why this order |
| --- | --- | --- | --- |
| **0. Removal-only hygiene** | **No new legal text** - needs Jo's explicit OK (it edits shipped templates) | I10 list, D10 option B, the contradictory strings | Removes known honesty and contradiction risk; adds nothing to defend |
| **1. Internal protections** | No customer-facing legal text | I5 lien tracker + reminders, I6 incoming waiver slots, I8 retention + legal hold, I3 version plumbing (field only) | The lien clock is running on real jobs **now**; the statutory right exists without a contract clause (memo Part C2/C3) |
| **2. Evidence parity** | Consent sentence reuse; confirm Q25 | I9 consent + IP/UA/digest on in-person and remote; or the interim privacy-page correction | Makes the existing contracts provable; independent of new clauses |
| **3. Clause module, dark** | Drafts reviewed (Part D tier 1-2 answered) | I1, I2, I12 behind the flag; golden-render tests; Jo previews all five sets | No customer sees it |
| **4. Enable per set, new contracts only** | Final attorney sign-off per set | Order: **OH cash -> KY cash -> OH insurance -> financed -> KY insurance (last, most statute-dense, existing text already compliant)** | Lowest statutory risk first; the Kentucky insurance set changes least |
| **5. Late-fee line** | Q1/Q2/Q5 answered | I4: invoice reference lines, then **propose-only** computed line, then (if Jo wants) auto-post | Only meaningful on jobs signed after phase 4; old signed contracts carry no fee |
| **6. Warranty + dispute extras** | Q16-Q21 answered | DISP optional clauses chosen in Part B; warranty certificate collapse | After the core set is live |

Old signed contracts are **never** altered. Signed-price rules are unchanged throughout. Each phase ships as its own
PR with the existing gates (`check-js-syntax`, `check-inline-html-scripts`, claim-wording scans, `smoke.test.js`).

---

# Part D. Questions for the LegalShield attorney

Ordered so a limited-scope session can stop at any tier and still have covered the money and statutory-risk items.
"Memo" column: the memo's own question number (Part F) or the inventory section the question comes from.

## Tier 1 - Money and statutory exposure (do these first)

| Q | Question | Source |
| --- | --- | --- |
| Q1 | Is 1.5% per month on the unpaid balance of a signed Ohio residential contract lawful given ORC 1343.01(A) and 1343.03(A)? What is the maximum, and what wording replaces "finance charge"? | memo 1 |
| Q2 | Kentucky, principal $15,000 or less: what is the operative "90-day commercial paper discount rate" benchmark under KRS 360.010(1)(a), and is 1% to 1.5% per month safely below it? | memo 2 |
| Q3 | May NBD use a flat late fee in either state, and what per-diem or percentage structure would you accept? | memo 3 |
| Q4 | Is a mutual prevailing-party fee clause in a consumer form contract enforceable in Ohio (Wilborn, Sal's, Paul Davis) and Kentucky (KRS 411.195)? Do percentage collection-agency fees need separate disclosure? | memo 4 |
| Q5 | Does a Reg Z disclosure obligation arise if NBD uses milestone payments, or offers a plan with or without interest? How many installments before NBD is a "creditor"? Does periodic late interest count? | memo 5 |
| Q6 | Does ORC 4722.04's 10% cap apply to Ohio contracts of **$25,000 or less**? Which price counts (before/after tax, add-ons)? Is a 50% deposit on a $24,000 Ohio roof lawful? | memo 6, brief 2 |
| Q7 | Kentucky insurance jobs: what may NBD collect at signing or before the insurer's coverage decision (deductible, permit fee, material order)? How is a deductible collected at completion without violating KRS 367.628(2)(b)? Is the "no discount / no rebate" sentence enough? | memo 7 |
| Q8 | What must the cancellation notice say on an Ohio job that is **also** insurance-paid, and may one document serve both? Is a housecall roofer with no storefront outside the fixed-location exemption (ORC 1345.21; KRS 367.410), so every contract carries the notice? Which Kentucky statute is correct for the clause - 367.390 as shipped, or 367.410-.460? | memo 8, brief 4, inventory 2B |
| Q9 | Is a separate emergency-services waiver (ORC 1345.21; KRS 367.420) acceptable for a tarp/dry-in, and does a drawn signature on a phone satisfy "handwritten"? What must it say? | memo 9 |
| Q10 | For Ohio jobs of $25,000 or more, does the contract satisfy ORC 4722.02(A) (supplier TIN, policy proof, dates, costs not covered)? Do PAY-4 (completion, 7 days, written punch list, holdback), PAY-5 (10-day written dispute) and LATE-6 (right to suspend) hold up in a consumer contract? | inventory sec. 5, 2A |

## Tier 2 - Liens

| Q | Question | Source |
| --- | --- | --- |
| Q11 | Walk the checklists: Ohio 60-day affidavit / 30-day service / 6-year life / 60-day demand; Kentucky 6-month / 7-day mailing / 12-month suit. Is anything missing for owner-occupied residential? How are weekends and business days counted? What if the owner is not served within 30 days? | memo 10, brief 5 |
| Q12 | Kentucky insurance job: is any lien allowed for the **deductible**? Does a mortgagee on the insurance check or its priority change the 6-month / 7-day / 12-month steps? Is LIEN-3 right as written? | memo 11 |
| Q13 | May NBD put a lien-reservation or lien-waiver clause in its own contract? Should subs/suppliers sign conditional releases in any prescribed Ohio/Kentucky form? Do the four NBD waiver forms (conditional/unconditional x progress/final) read correctly? | memo 12, inventory 3.1 |
| Q14 | Does Ohio or Kentucky require a written lien-rights notice or owner disclosure **inside** a residential contract (the memo found none; ORC 1311.04 was amended 2025-09-30)? Is LIEN-4's notice-of-commencement sentence right? | new |
| Q15 | Subcontractor agreement: pay-when-paid, lien-indemnity and COI clauses; W-9 handling; does an independent-subcontractor model change NBD's lien or waiver exposure? | inventory 2E |

## Tier 3 - Dispute stack

| Q | Question | Source |
| --- | --- | --- |
| Q16 | Which of these survive in a consumer residential contract in each state, and which would you strike: arbitration with class waiver, jury waiver, mediation-first, entire-agreement, severability, assignment, notice terms? | memo 13 |
| Q17 | Would you recommend a notice-and-opportunity-to-cure clause even though no statute requires one? Does the lien carve-out in DISP-2 work? | memo 14 |
| Q18 | Governing law by property location and venue in the property's county: right for an Ohio-based contractor working in Kentucky? Do consumer statutes override a choice-of-law clause? | inventory 3.3 |
| Q19 | Is shortening the claim period lawful in each state, and to what minimum? | inventory 8 |
| Q20 | Limitation of liability and consequential-damages exclusion: enforceable for a contractor's own negligence in a home repair contract? How does it interact with Jones v. Centex's workmanlike duty? | inventory 8, memo Part D 4 |
| Q21 | Warranty: are WAR-2/3/7 (exclusions, 30-day notice, paid-in-full condition, "no other warranty" with a savings sentence) acceptable? Transfer restrictions? Is "Backed personally by Joe Deal" a personal guarantee? | inventory 2C |
| Q22 | Hidden-conditions decking allowance (CO-2), weather/access/permit/HOA clauses (SCH-1..3), and the subcontractor disclosure (SUB-1): any change? Does OAC 109:4-3-05's 10%-or-$5 overage rule apply to roofing? | memo Part D 4 last row |

## Tier 4 - Paper, identity, records

| Q | Question | Source |
| --- | --- | --- |
| Q23 | Exact wording of "licensed / registered / insured" for Ohio (Cincinnati registration) and Northern Kentucky jobs; which Boone/Kenton/Campbell/Hamilton/Butler/Warren/Clermont registrations are required? | memo 15 |
| Q24 | Correct contracting entity name and signature block; effect of "sole proprietorship" vs LLC across current paper. | inventory 4 item 10 |
| Q25 | ESIGN consumer-disclosure content for contract paper: copy, withdrawal, hardware/software, delivery of cancellation notices electronically. | inventory 8 |
| Q26 | Retention period for signed contracts, photos and communications; is a collapsed terms section "conspicuous" enough on the deal page? | new |
| Q27 | Photo/media consent wording; is a self-attested publishing consent acceptable? | inventory 2B |
| Q28 | Job-communications (text/email) consent at contracting; anything beyond TCPA express written consent? | inventory 2E |
| Q29 | Change-order approval by text or email: valid? Is deleting NBD's unilateral price-adjustment sentence the right fix? | inventory 2B |
| Q30 | Insurance supplements: does homeowner approval before folding into the invoice, with documentation-only language, keep NBD clear of KRS 367.628(1)? | inventory 2B |

## What to bring

- Current contract PDFs **as actually signed**, one from each path: an envelope-signed estimate PDF, a deal-room
  acceptance page, an in-person-signed contract, a remote-link-signed contract. One Ohio and one Kentucky of each if
  available, **redacted** (names, addresses).
- Invoice samples: the server-rendered invoice PDF **and** the client-built fallback HTML; a Stripe invoice and a
  pay-link page.
- The Payment Agreement, Change Order, Warranty Certificate, Work Authorization and the four lien-waiver templates.
- The **cancellation packet** for one Ohio and one Kentucky job (including a Kentucky insurance job).
- A printout of Settings -> Company Profile -> Legal Text (the saved overrides - not in the repo).
- The two research notes linked at the top, and this note's Part B with Jo's marked-up leanings.
- Certificate of insurance and manufacturer credentials (for the "insured" and "certified" wording only).
- One redacted late-payment timeline from a real job (due date, reminders, what was said) so the attorney can see
  the fact pattern.
- Business-entity records (Secretary of State) for Q24.

---

# Part E. Non-goals and honesty guardrails

**Non-goals**

- Not legal advice; not a replacement for the attorney. No clause here ships without that review and Jo's sign-off.
- **No auto-filing, no auto-mailing** of liens or affidavits. The product tracks and prepares; a person files.
- No changes to **old signed contracts**, no retroactive late fees, no change to the signed-price rules or the deposit
  rule's numbers (the deposit clause renders the rule; it does not set it).
- No in-house installment financing or finance-charge product; no assignment-of-benefits; no claim negotiation.
- No new public-website legal pages in this lane (the Terms/Privacy rewrite is its own work).
- No other states; no commercial-contract set; no NBD Pro SaaS-terms change (contractor-facing, kept apart on purpose).
- No cost, margin, sub-contractor price or customer data in any clause, config or test fixture under `docs/`
  (`tests/catalog-cost-privacy.test.js`).

**Honesty guardrails (each is CI-enforced today; new text must pass them, and the gates must scan rendered output)**

- Never **"licensed"**; "fully insured" only, backed by a certificate on request. Registration wording only after Q23.
- No **claim-outcome promises**: no "your claim will be approved", no "no rate increase", no deductible-waiver talk.
- **Kentucky insurance jobs (KRS 367.62x):** no "we handle the claim" / "negotiate", no representation of the insured, no
  advance payment inside the cancellation window, no discount or rebate, no lien for the excess, referral bonus capped
  at $100 for an insured. Statutory notices are module text, never paraphrased.
- Crews are **independent subcontractors** - never "in-house", "our employees" or W-2 language.
- Credentials exactly as the public footer states them; nothing about Master Elite; IKO only after approval.
- Gates that must stay green and be extended to render every clause set: `tests/claim-wording.test.js`,
  `tests/ky-claims-wording-scan.test.js`, `tests/oh-claims-wording-scan.test.js`,
  `tests/subcontracting-honesty.test.js`, `tests/warranty-pledge-labor-years-2026-10-06.test.js`, the cost-privacy
  guard, plus a new byte-identity test for the clause module and a "no unresolved placeholder" test.

---

# Part F. Left unresolved

- The saved legal-text overrides and any real signed contract (see the top of the note).
- Whether the Ohio 10% cap reaches under-$25,000 contracts (Q6) - the statute is internally inconsistent.
- The Ohio interest ceiling for a service contract (Q1) and the Kentucky benchmark (Q2).
- Whether a Kentucky lien may reach the insured's deductible (Q12).
- Dispute-stack enforceability (Part G of the memo): arbitration class waivers, jury waiver, liability caps, shortened
  periods - first-principles recommendations only.
- Per-municipality contractor registration outside Cincinnati (Q23).
- The contracting entity's legal name (a records question, D11).
- The "later 2026" refresh: statutes marked 2026 (KRS 367.620-.628, ORC 2305.06) and the Ohio statutory interest rate
  reset every October 15 - re-check the day any contract text is finalised.
