# Kentucky insurance-job law vs the CRM — 2026-09-27

**Read-only recon.** Found while fixing public-site claim wording during the
[SEO-AEO-GEO-DEEP-DIVE-2026-09-27](SEO-AEO-GEO-DEEP-DIVE-2026-09-27.md) session
(public-site wording fix: PR #1798). Law verified from the enrolled act
(2026 Ky. Acts ch. 54 / SB 153, signed 2026-04-08; §§1–4 apply to contracts on
or after 2026-07-15) and KRS 304.20-105. **Not legal advice — Jo should have a
Kentucky attorney confirm the [JOE] items before relying on any of it.**

**Status:** the [SAFE] items below are being built as a DRAFT PR
(`fix/ky-insurance-contracts`); nothing merges without Jo's OK. The [JOE] items
are open decisions: business mailing/physical address on KY contracts, deposit
deferral reading, referral-bonus cap, direction-to-pay wording, Ohio AOB policy,
File-Claim / supplement workflow.

## (a) Executive summary: gaps ranked by risk

| # | Gap | Statute | Risk | Where |
|---|-----|---------|------|-------|
| 1 | **Assignment-of-benefits language is in every contract, plus a standalone AOB doc and a Work Authorization assignment.** An AOB is void in KY, and a contract containing one is "void and unenforceable". The contract's "Insurance Assignment" clause prints on **every** contract, cash jobs included. | 304.20-105(2)-(3); 367.624(3)(b) | **Critical.** It can void the whole contract. | company-profile.js:98-99, document-generator.js:2461-2467, templates.js:803-809, templates.js:1797-1873, crm-stages.js:782 |
| 2 | **Contracts say the contractor negotiates the claim.** The AOB says "Negotiate the scope of covered repairs and associated pricing". The Work Authorization says the assignment "authorizes … to negotiate directly with the insurance company". | 367.628(1)(a)1 (the provision is unenforceable, and each one is a violation) | **Critical** | templates.js:808, :1834-1840 |
| 3 | **No KRS 367.624 disclosures anywhere.** No 5-business-day insurer-notice cancellation notice, no 304.20-105 notice, no detachable NOTICE OF CANCELLATION in duplicate, and no contractor mailing/physical address (documents never print one on purpose). The existing cancel clause is 9px, not bold. | 367.624(1),(3),(4) | **High.** $5k per violation plus 2× damages and fees (367.627). | document-generator.js:2445-2451, company-profile.js:84-88, :236-247, contract.hbs:86-89 |
| 4 | **KY insurance jobs ask for money at signing.** The deposit rule's insurance branch always says "Your deductible — At signing", and the ACV payment is due "up front". That flows to the contract payment schedule, invoices (deposit plus Net 14), the portal, estimate-view, the quote PDF and the Close Board deal room. | 367.626(2)(a)1 | **High** | deposit-rule.js:180-252 and the surfaces in Q2 |
| 5 | **A $200 referral bonus is offered to every closed customer**, including insured ones: SMS, closed-stage email, and a server trigger that books $200 owed. A rep playbook tells reps to "absorb small amount of deductible if customer refers 3 neighbors (legal in OH/KY)". That is false and illegal. | 367.628(2)(b),(d) | **High** | referral-rewards.js:55; review-engine.js:351; email_system.js:644; decision-engine.js:368 |
| 6 | **Customer-facing "claims specialist" wording.** About 14 sites in 11 files, for example "Insurance Specialists — We handle the entire insurance claim process", "Insurance Restoration Specialists" on every server PDF, "I'll handle the documentation and negotiation", and "We help with the claims process". | 367.628(1)(a)1-2 | **Medium-High** | Q5 |
| 7 | **The server contract's cancel text points to an "attached Notice of Cancellation form" that is never attached.** This is an FTC Cooling-Off / OH HSSA defect on every contract in both states. | 16 CFR 429 / ORC 1345.23 | Medium | document-generator.js:995; contract.hbs:86-89 |
| 8 | **Mechanic's lien:** none found. The only lien mentions are lien *waivers* (academy text, how-to "coming soon"). | 367.628(2)(g) | Low. Add a clause. | Q4 |

**Lead state at contract time:** there is no structured `state` field on leads, only a free-text `address`, plus `zip`, `jobType` (cash/insurance/finance/…), `insuranceCarrier` and `claimNumber`. doc-preflight already *requires* a state token matching `/\b(OH|KY|IN)\b/` in the address on contract submit (doc-preflight.js:1695-1705). KY detection can reuse that regex, with ZIP prefix 400-427 as a cross-check. No OH vs KY clause logic exists today. The only jurisdiction switch is tenant-level (NBD gets KY citations; other tenants get state-neutral text; company-profile.js:790-840).

**When the cancellation period runs (KRS 367.622(1)):** "prior to midnight of the fifth business day after the person has received written notice from the insurer that all or part of the claim is not a covered loss". The clock starts only on a written denial or partial denial. It is **open-ended** until the insurer decides. If the carrier approves everything, the statute never clearly says when "the cancellation period … has expired". The conservative reading for 367.626: collect **nothing** on a KY insurance contract until the carrier's written coverage decision is in hand. If any part is denied, wait 5 business days after the homeowner received that notice. The exception is emergency or repair services at a reasonable and customary charge (367.626(3)). **This needs Joe's decision, and ideally a KY attorney's.**

## (b) Evidence by question

### Q1. Contracts and e-sign: generation, notices, state logic

**Contract-entry surfaces. All of them are uncovered.**
- **Client HTML contract**: `renderContract`, docs/pro/js/document-generator.js:2318-2505. Contracts default to signers (document-generator.js:268-272), so this is the main path, signed through remote-signing (functions/remote-signing.js; `createSignRequest` is called at document-generator.js:602).
  - The Parties block prints contractor name, phone and email only, with **no address** (:2394-2399).
  - "Cancellation & Rescission Rights" prints `cp.cancellationContractClause` at **9px, not bold** (:2445-2451).
  - "Insurance Assignment" prints `cp.insuranceAssignmentClause` **unconditionally** (:2461-2467).
- **Server PDF contract**: functions/print/templates/contract.hbs (used when no signers; routed at document-generator.js:436-458).
  - Section 6 "Right to Cancel" prints `rightToCancel` as a plain `<p>` (contract.hbs:86-89).
  - The payload default is FTC 3-day text: "…See the attached Notice of Cancellation form…" (document-generator.js:995). No form exists in any template.
  - The brand tag is "Insurance Restoration Specialists" (functions/render-pdf.js:355).
- **Proposal**: prints `cp.cancellationProposalShort` (document-generator.js:2215; also :3043).
- **Work Authorization** (templates.js:761-823).
  - Insurance branch (:803-809): "I hereby assign and transfer to [company] the insurance proceeds … authorizes [company] to negotiate directly with the insurance company".
  - Notice (:811-815): 3 business days, 13px, not bold.
- **Assignment of Benefits** (templates.js:1797-1873). Registered at document-generator.js:300 and templates.js:2703. It is a pipeline chip, "Send AOB", on INSPECTED insurance jobs (crm-stages.js:782; mapped at dashboard-bootstrap.module.js:557).
- **Close Board deal room** (docs/pro/js/close-board.js:636-784; accepted server-side by functions/deal-acceptance.js).
  - The homeowner picks a tier, signs and taps "✓ ACCEPT & SCHEDULE" (:775, :784). That is a contract entry with **no cancellation text at all**.
  - It shows the "Due at signing: $X" per tier (:644-651).
  - It says "We work directly with your insurance." (:766).
- **PDF envelope e-sign** (functions/esign-envelope.js, docs/pro/js/esign-sign.js, esign-setup.js:567). This path signs arbitrary PDFs, so it inherits whatever the PDF says.
- **BoldSign estimate signing**: functions/integrations/esign.js (`sendEstimateForSignature`, called from integrations-client.js:115).
- **Payment Agreement** (templates.js:2597+): 1.5% monthly finance charge; no lien language.

**Existing cancellation language to build on:**
- company-profile.js:83-88
  - `cancellationWindowText: 'three (3) business days'`
  - `cancellationStatute: 'Kentucky Revised Statutes § 367.390'` (the citation should be verified by counsel)
  - a contract clause and a proposal short line; the proposal line says "(KY Residential Finance Law)"
- The tenant-neutral variant: company-profile.js:812-817.
- A Settings field: dashboard.html:3867 (`cp_cancellationWindowText`), saved via dashboard-bootstrap.module.js:5564.
- Tests pin this text: tests/tenant-legal.test.js and tests/docgen-render.test.js.

**KRS 367.624 elements**
- (1) mailing address: **missing.** Documents deliberately print no company address; see the comments at company-profile.js:236-247. `businessAddress: ''` (:51) feeds only the microsite (document-generator.js:1857).
- (2) phone and email: present on the contract.
- (3)(a) and (3)(b) statutory notices: **absent.**
- (4) detachable duplicate NOTICE OF CANCELLATION: **absent.**

### Q2. Deposits: would a KY insurance job be asked to pay at signing?

Yes. Every surface asks for it.

**The rule** is docs/pro/js/deposit-rule.js. The header states the policy (:1-20). The insurance branch of `_rulePlan`:
- no deductible entered: "Your deductible — At signing" (:180-195)
- job total at or below the deductible: "full job total at signing" (:200-207)
- ACV known: deductible "At signing" plus ACV "Up front — as soon as your carrier releases it" (:209-229)
- ACV at or below the deductible: deductible at signing (:230-240)
- ACV unknown: deductible at signing (:242-252)

**Entry points:** `compute` (:265), `fromEstimate` (:377), `policyText` (:437). The rule has no state input.

**Where it lands:**
- **Contract:**
  - doc-preflight.js:247, :366, :1395, :2511, :2648-2663 (stamps `depositPlan` onto the contract data)
  - the Payment Schedule rows in document-generator.js:960-993, which feed contract.hbs:48-64
  - the client contract's `{{paymentSchedule}}`, defaulting to `cp.paymentTermsContract` = `_depositPolicyText()` (company-profile.js:107)
- **Invoice:** docs/pro/js/invoice-pipeline.js:550-617 sets `depositAmount` from the rule, `depositTerms`, and terms "Net 14. <summary>". Stripe pay links then charge against it (functions/stripe.js:1273-1310).
- **Quote PDF:** estimate-finalization.js:893-918 prints the "Due at signing" stages.
- **V2 builder stamp:** estimate-v2-ui.js:2667-2681.
- **Portal and estimate-view:** functions/portal.js:1014-1017 and :2544-2547 (via functions/deposit-plan-view.js), rendered at docs/pro/js/portal.js:756 and estimate-view.js:297.
- **Close Board:** close-board.js:644-651 and :766.
- **Proposal boilerplate:** "Insurance assignments accepted." (company-profile.js:108).

Audit note: documentation/audit/DEPOSIT-RULE-2026-09-25.md (surface table at :158-182). It does not mention KRS 367.626.

### Q3. Discounts and rewards on insurance jobs

- **$200 referral bonus, live.** This violates (2)(d) whenever the referrer is a KY insured customer.
  - functions/referral-rewards.js:55 `REFERRAL_BONUS_USD = 200`. It books "owed" and notifies the rep (:254-308).
  - The SMS says "you get a $200 bonus when their project closes" (docs/pro/js/review-engine.js:351). It is sent from customer-tasks-ui.js:2307 with no jobType or state gate.
  - The closed-stage email template says "We offer a $200 referral bonus for every job that closes." (email_system.js:644).
  - The UI and marketing copy repeat it: crm-leads.js:368, referral-rewards-ui.js:5, dashboard.html:2323, pro/index.html:1684, sandbox-demo.js:43.
  - Tests pin it: tests/referral-rewards.test.js.
- **Rep playbook (internal, but it instructs a violation):**
  - decision-engine.js:368: "For insurance claims: offer to absorb small amount of deductible if customer refers 3 neighbors (legal in OH/KY)". This is **illegal under (2)(b)** and contradicts :157-176 in the same file.
  - :172 "referral credit, military/senior discount", :446 "$100 referral credit", :499 "5% off … future discount", :588 "$100 credit": all are discounts or credits that are barred on insurance jobs under (2)(c)/(d).
  - :54 and :249 advise referring customers to a public adjuster. Mild, but it touches (2)(f).
- **Guard already in place:** upgrade-pricing.js:417-424 blocks upgrades on insurance jobs and cites KY KRS 367.628. It is the only existing reference to the statute (plus documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md:87).
- **Public site:**
  - docs/partners.html:643 declines to post referral fees. These are trade partners, not insureds, so it is fine.
  - docs/review.html has no incentive.
  - docs/pro/refer.html has no reward text.
  - The referred friend gets a "free inspection" (review-engine.js:351). Its value is arguably ≤$100 and it goes to a non-insured prospect. Low risk, but have counsel confirm.
- No gift-card, coupon or deductible-assistance *features* were found in the estimate or invoice code. The estimate has no free-form discount line; the "insurance premium discount" hits in estimate-catalog-xactimate.js:88-193 describe carrier premiums and are fine.

### Q4. Mechanic's lien

No lien filing or claim language exists in any contract, invoice, payment agreement or print template. The hits are lien *waivers* only: how-to.html:1008, academy-insurance-tree-data.js:2223-2262, decision-engine.js:204-207.

The gap: on insurance jobs the contract says "balance on completion" of the full contract price, with no cap at insurer-paid amounts. That is not a lien violation by itself. A clause disclaiming liens for excess over insurer payment would make it explicit (367.628(2)(g)).

### Q5. Customer-facing "we negotiate / claims expert" wording in docs/pro and functions

About **14 sites in 11 files**. The top paths:
1. **company-profile.js:152**, valueProps "Insurance Specialists — We handle the entire insurance claim process". The fallback copy is at templates.js:452; it prints on the company intro and proposals.
2. **company-profile.js:148**, services "Storm Damage — Full insurance claim management from inspection to completion".
3. **functions/render-pdf.js:355** brandTag "Insurance Restoration Specialists · Greater Cincinnati" appears on every server PDF. The same text is at **warranty-cert.js:199**.
4. **templates.js:808** (Work Authorization) "negotiate directly with the insurance company".
5. **templates.js:1834-1840** (AOB) "Negotiate the scope of covered repairs and associated pricing", "Pursue any and all remedies".
6. **email_system.js:557** (estimate_submitted) "I'll handle the documentation and negotiation."
   - :570 "I'll follow up with the adjuster" is lower risk.
   - :503 and functions/email-functions.js:169 say "I'll be present at the adjuster meeting". That is allowed after a claim is filed (367.628(1)(c)2).
7. **functions/storm-report-email.js:100** "I'll handle the paperwork with your insurer from start to finish."
8. **functions/sms-functions.js:100** (ins_has_claim) "We help with the claims process at no cost to you."
9. **docs/pro/js/d2d-tracker-core-2026b.js:248** SMS "I can help guide you through your insurance claim process."
10. **docs/pro/js/storm-center.js:593** door script "We work directly with your insurance company — we handle the entire claims process."
11. **close-board.js:766** "We work directly with your insurance."
12. **templates.js:2203-2204, :2270** (Claim Guide) "we file a supplement on your behalf … to get the claim adjusted".
13. templates.js:2453, a canned testimonial "walked us through the entire insurance claim process". Low risk.

Related workflow: the pipeline's "File Claim" action on insurance jobs (crm-stages.js:781). If the rep files the claim *for* the homeowner, that is representing the insured under (1)(a)1. The workflow needs a policy decision.

Internal-only and not customer-facing: ai.js:122 and pages/ask-joe-main.js:41 personas ("battle-tested insurance restoration contractor"), academy/sales-training content, and pipeline stage names "Negotiating".

### Q6. AOB and direction-to-pay (KRS 304.20-105)

KRS 304.20-105(2)-(3) bars assigning policy "rights or benefits" in whole or in part, before or after a loss, and a contract doing so is void. It applies to policies issued or renewed on or after 2024-04-02, which by now is effectively all of them. (4)(b) expressly **permits** "authorizing or directing payment to … a person for services".

**Present in the CRM:**
- The standalone AOB document (templates.js:1797-1873; chip crm-stages.js:782; filing stamp `aobFiledAt` at document-generator.js:344).
- The Work Authorization assignment (templates.js:803-809).
- The contract "Insurance Assignment" clause on every contract (company-profile.js:98-99 → document-generator.js:2461-2467).
- "Insurance assignment(s) accepted" in payment terms (company-profile.js:108-110).
- **No direction-to-pay form exists**, so there is nothing compliant to fall back on.

## (c) Proposed change list

Tags: **[JOE]** needs Joe's (and ideally counsel's) decision. **[SAFE]** can be implemented now.

1. **[SAFE] Jurisdiction and job-type detection helper.** Add `NBDJurisdiction.kyInsurance(lead|ctx)`: the state comes from the address regex (reuse doc-preflight.js:1695) with ZIP 400-427 as a cross-check, AND `jobType==='insurance' || mode==='insurance' || claimNumber || insuranceCarrier`. Stamp `jurisdiction: 'KY'` on the contract payload. Fail closed: an insurance job with unknown state is treated as KY.
2. **[SAFE for NBD KY, JOE for scope] Remove AOB for KY.**
   - Hide or disable the "Send AOB" chip and the AOB document type for KY. Consider doing this everywhere, since NBD's OH policy is a separate question.
   - Drop the Work Authorization assignment paragraph and the contract "Insurance Assignment" clause. That clause should not print on cash jobs anywhere.
   - Remove "Insurance assignment(s) accepted".
   - **[JOE]** Replace them with a *Direction to Pay / payment authorization* (304.20-105(4)(b)) that has no negotiation, remedies or "rights" language. Joe and counsel approve the wording.
3. **[SAFE] Strip "negotiate / represent" powers** from the AOB and Work Authorization text (templates.js:808, :1834-1840). Joe has no need to review this.
4. **[SAFE, text is statutory] KY notice block in every contract renderer** (client renderContract, contract.hbs, the proposal when it is signable, and the Close Board deal room): the 367.624(3)(a) and (3)(b) texts verbatim, bold, at least 10pt. Use 13px+ or 10pt in print CSS.
5. **[JOE → then SAFE] Contractor mailing and physical address on KY contracts** (367.624(1), and the form needs a "physical address"). Documents currently omit the address on purpose. Joe must pick the address; a P.O. box won't satisfy "physical address" on the form. Fax: none. Wire it to `companyProfile.businessAddress` and fail the preflight for KY insurance contracts when it is empty.
6. **[SAFE] Detachable NOTICE OF CANCELLATION in duplicate.**
   - Add two copies on their own page after the signatures, with a dashed cut line and `page-break-before`.
   - Use the statutory text verbatim. Prefill the transaction date, contractor physical address and email. Leave blank lines for date and buyer's signature.
   - For esign-envelope and remote-signing, deliver it as part of the signed PDF plus a separate printable copy in the portal. **[JOE]** Counsel should confirm that an e-delivered "detachable" form is acceptable.
7. **[SAFE] Fix the FTC/OH 3-day form gap.** The server contract promises an attached form that doesn't exist (document-generator.js:995). Attach a real 3-day Notice of Cancellation (FTC 16 CFR 429 for door-to-door sales, and ORC 1345.23 for OH) or reword it. **[JOE]** Verify the `KRS 367.390` citation.
8. **[JOE] Deposit deferral for KY insurance contracts** (367.626). Proposal:
   - Add `state` to the deposit-rule input. For KY insurance, the plan becomes "Nothing due at signing" with rows "Deductible and insurance ACV payment — due after your insurer's written coverage decision and any cancellation period has passed".
   - Invoices get `depositAmount: 0`, and Stripe pay links are withheld until the rep marks "carrier decision received + 5 business days".
   - Emergency tarp or repair stays chargeable (367.626(3)).
   - Update deposit-rule.js, invoice-pipeline.js, doc-preflight, estimate-finalization, close-board, portal/estimate-view, and tests/deposit-rule.test.js.
   - Joe decides the reading of "cancellation period … expired" (see the summary) and whether OH keeps the current rule.
9. **[SAFE for copy, JOE for the program] Referral bonus on insurance jobs.**
   - Immediately: fix decision-engine.js:368 (the deductible absorb is illegal) and drop the discount/credit suggestions for insurance jobs (:172, :446, :499, :588).
   - **[JOE]** For KY insured customers, cap the referral reward at ≤$100 or turn it off. The same goes for any credit, coupon or gift. Gate `sendReferralSMS`, the closed-stage email line and `REFERRAL_BONUS_USD` crediting by jurisdiction and the referrer's jobType. Joe's call: one $100 amount everywhere, or KY-specific.
10. **[SAFE] Copy changes for claims-specialist wording** (Q5 list). Examples:
    - "Insurance Specialists" becomes something like "Storm-Damage Roofing"
    - "We handle the entire insurance claim process" becomes "We document the damage and provide our estimate; you manage your claim"
    - "Insurance Restoration Specialists" brand tag becomes "Roofing · Siding · Gutters · Greater Cincinnati"
    - "I'll handle … negotiation" becomes "I can meet your adjuster to review the damage"
    - "We help with the claims process" gets removed.
    Keep the allowed activities: estimates, and conferring with the carrier's rep after a claim is filed. Update the tests pinning those strings.
11. **[JOE] Pipeline "File Claim" action and supplements.** Should the homeowner file? Is Joe's supplement submission his own estimate (allowed) or negotiation for the insured (barred)? This is a question for counsel. Also confirm there is no financial link to any supplement or PA firm (2)(e).
12. **[SAFE] Lien clause for KY insurance contracts:** "Contractor will not file or claim a mechanic's lien for any amount in excess of what the insurer pays or is expected to pay."
13. **[SAFE] Guard tests:** a KY-insurance contract fixture must contain both notices and two NOTICE OF CANCELLATION blocks, must not match `/assign/i` or `/negotiat/i`, and must show a $0 due at signing. A scan must find no "claims specialist/expert" in customer templates.

Sources: [2026 Ky. Acts ch. 54 (SB 153)](https://apps.legislature.ky.gov/law/acts/26RS/documents/0054.pdf) · [KRS 367.622](https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=56105) · [KRS 304.20-105](https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=54463) · [KRS ch. 367 index](https://apps.legislature.ky.gov/law/statutes/chapter.aspx?id=39092)
