# Contract-language inventory and current-state analysis — 2026-10-13

**What this is.** Jo's ask (2026-10-13): *"We gotta deepen / strengthen and cover
right to lien as well as charging fees for late payment after job completion
etc. I want to look at every aspect of contract languages and ensure we have
our own best interest in mind as well as our own backs in court or any
dispute."* This note is the **inventory** half: every place customer-facing or
counterparty-facing legal language lives, its exact current wording with
file:line, which flows reach it, what contradicts what, and whether the
customer actually *sees and accepts* it, with what proof.

**What this is not.** No replacement language (a sibling lane researches KY/OH
law; a later synthesis writes drafts). Not legal advice. Every quotation is
verbatim from `origin/main` @ `5f1534a8` (2026-10-13). No cost, margin or
sub-price figure appears here; the retail deposit thresholds quoted are already
public in the shipped code.

**Read this caveat first.** Everything below is the **repo default text**. The
clause fields are tenant-editable (Settings → Company Profile → Legal Text,
`docs/pro/dashboard.html:4260-4303`) and persisted per company in Firestore
(`companyProfile/{uid}`). NBD's own saved overrides were **not** inspected;
whatever Jo has typed there wins over the defaults quoted here. A first action
for the synthesis lane is to read that document.

Related notes: [TEMPLATE-LIBRARY-2026-10-04](TEMPLATE-LIBRARY-2026-10-04.md)
(the template inventory this builds on),
[OHIO-4722-DEPOSIT-CAP-2026-10-11](OHIO-4722-DEPOSIT-CAP-2026-10-11.md),
[GROK-SITE-AUDIT-OHIO-4722-2026-10-11](../audit/GROK-SITE-AUDIT-OHIO-4722-2026-10-11.md),
[KY-INSURANCE-JOB-CRM-2026-09-27](../audit/KY-INSURANCE-JOB-CRM-2026-09-27.md).

---

## 0. Headline gaps (read these, skip the rest if short on time)

1. **No lien-rights language protects NBD anywhere.** No contract, proposal,
   deal page, invoice or portal text reserves NBD's right to file a mechanic's
   lien, gives the owner any lien-related notice, or mentions a notice of
   commencement / preliminary notice. The only lien text in the product is (a) a
   *contractor-issued lien waiver* generator (releases NBD's rights; a manual
   template marked DRAFT for an attorney), (b) the Kentucky insurance-job
   undertaking *not to lien above what the insurer pays*, and (c) NBD Pro's
   marketing page listing "Lien Waiver, Ohio or Kentucky" as a feature
   (`docs/pro/index.html:280`). No lien deadline is tracked, no *incoming*
   waiver from a sub or supplier is collected, and no event (final payment,
   paid-in-full) prompts a waiver. See §3.1.
2. **Late-payment language exists in exactly one number and is nearly
   unreachable.** "1.5% monthly finance charge" (free text, per tenant) prints
   only on the *client-built* invoice HTML (which is the **fallback**, not the
   first-choice, invoice renderer) and on the Payment Agreement template. It is
   **not** in any contract the homeowner signs, **not** on the server invoice
   PDF that is actually auto-filed, **not** on the Stripe invoice / pay link, and
   **not** in the reminder text. Nothing in code ever computes or applies a
   fee. There is **no** collections-cost, attorney-fee or interest-rate clause
   (APR not stated). See §3.2.
3. **There are five different "contracts" with five different clause sets.**
   The primary e-signed estimate PDF (`functions/estimate-esign-pdf.js`) carries
   *only* scope, price, payment terms, one payment clause and the FTC notice —
   no change-order, dispute, liability, entire-agreement, warranty or lien text.
   The fullest clause set exists only in the client-built contract HTML, and the
   server PDF contract omits the dispute / change-order / entire-agreement
   clauses even though the signed HTML carries them. See §1.
4. **The dispute stack is one sentence, and it is Kentucky's on Ohio jobs.**
   "mediation **or** binding arbitration under Kentucky law" — no forum, rules,
   venue, jury waiver, fee-shifting, cure period or limitations period — printed
   only on the client contract HTML. The same defaults cite a Kentucky statute
   in the cancellation clause for every NBD job, Ohio included. Limitation of
   liability prints only on the *proposal*, not the contract. See §3.3.
5. **Proof of acceptance is uneven.** Envelope e-sign and the deal room record
   consent text, IP, user agent, time and a document digest. The two paths Jo
   uses most — **in-person signing** and the **remote HTML signing link** —
   record no consent, no IP/device (in-person) and (in-person) no digest.
   `privacy.html` promises all of it for "contracts and documents we send for
   signature". No clause-set version is stamped on any signed document. See §3.4
   and §7.
6. **Honesty/KY problems still shipping:** a dead-but-bundled legacy template
   with *"negotiate with my insurance company on my behalf and … receive payment
   directly from the insurance carrier"* in `docs/pro/js/dashboard-ui.js:1524`;
   a Testimonial Sheet whose fallback is invented "Satisfied Homeowner" quotes;
   a claim guide that says "We handle the hard parts" and promises no rate
   increases; "Backed personally by Joe Deal" on the warranty certificate. See
   §3.5 and §4.

---

## 1. Where "the contract" actually lives: the signing paths

| # | Path (how it is reached) | What the homeowner is shown (clause set) | Proof recorded | KY insurance job? |
|---|---|---|---|---|
| **A** | **Estimate "Send for signature"** → `sendEstimateEnvelope` (`functions/esign-envelope.js:591`) → PDF built by `functions/estimate-esign-pdf.js` | Header, scope lines, "Contract price", "PAYMENT TERMS" (deposit plan summary + rows), the one Payment clause (`KyLaw.PAYMENT_CLAUSE`, line 185), "ACCEPTANCE" sentence (lines 188-197), the 16 CFR 429.1(a) statement, signature/date boxes, then two completed FTC Notice of Cancellation forms. **Nothing else** — no warranty, change-order, dispute, liability, entire-agreement, lien, hidden-damage, weather, late-fee text | Strongest: per-signer consent text, IP, UA, view/sign time, typed name, values SHA-256, source PDF SHA-256, signed PDF SHA-256, append-only audit array, certificate page, signed copy emailed (§7) | **Refused** (`esign-envelope.js:566-567, 641`: "Use 'Sign on this phone' or 'Generate contract'") |
| **B** | **Deal room** `/deal/<token>`: page built client-side by `docs/pro/js/close-board.js:generateDealPageHTML`, served + accepted by `functions/deal-acceptance.js` | Tier cards (price, tier warranty sentence, deposit line), optional insurance box, financing range, FTC statement + Notice of Right to Cancel packet, KY notices + KY forms on KY insurance jobs, one authorisation sentence (`close-board.js:1160`), "estimate is valid until" footer. **No** payment-schedule balance terms, late fee, change-order, dispute, liability, lien, entire-agreement text | Consent checkbox + text, IP, UA, time, SHA-256 of the signature image, SHA-256 of the stored page (`deal-acceptance.js:511-525, 623-633`); the page itself is stored and re-dated as the signed record | **Allowed** ("Sign on this phone"); this is the KY-insurance acceptance path |
| **C** | **Generated contract / proposal, signed in person** (rep hands phone over; `NBDDocViewer`, `document-generator.js:816` `onPersistFinalized`) | Client template `renderContract` (`document-generator.js:2714`) / `renderProposal` (`:2510`): scope, price, payment schedule + methods, warranty, **change orders, cancellation, dispute resolution**, payment clause, KY lien (KY ins. only), **entire agreement**, KY notices, FTC statement + packet. Proposal adds "Limitation of Liability" and "Warranty Disclaimer" | Weakest: `signedAt` (client `serverTimestamp`), per-role `{role,label,signedAt}`; signed HTML re-uploaded to the same Storage path, object tagged `signed:'true'` (rules lock it). **No consent step, no IP/UA, no digest** | Allowed ("Generate contract") |
| **D** | **Same HTML, signed through a remote link** `/pro/sign.html?token=` (`functions/remote-signing.js`) | Same client HTML as C | `signedAt`, signer name (rep-entered), `originalSha256`, `signedSha256`, original archived, server verifies the visible text equals the original (`remote-signing.js:146-160`). **No consent text, no IP, no UA recorded** | Allowed |
| **E** | **Server PDF contract** `renderPdf` → `functions/print/templates/contract.hbs` (used when a contract is rendered with **no signers configured**: preview / print / PDF export, `document-generator.js:615-632`) | Scope, payment schedule + terms, materials, warranty (+ NBD Pledge, manufacturer line), "Right to Cancel", payment clause, KY lien/notices on KY ins., acceptance sentence, FTC + KY forms. `additionalTerms` exists in the template but **nothing ever populates it** (`document-generator.js:1297` passes `data.additionalTerms || []`). **No** change-order, dispute, entire-agreement, limitation text | None (unsigned artifact; PDF reaped after 30 days, `functions/pdf-render-retention.js`) | Allowed |

Other signable / counter-signable documents (all client templates in
`document-generator-templates.js` unless noted; all carry in-person/remote
evidence per C/D): Change Order (`:1040`; server twin `changeOrder.hbs` when
unsigned), Work Authorization (`:896`), Certificate of Completion (`:958`),
Payment Agreement (`:2690`), Scope of Work (`:807`), Warranty Certificate
(`:543`; server twin `warranty.hbs`; third copy `docs/pro/js/warranty-cert.js`),
Lien Waiver (`document-generator-library.js:177`, contractor signs only),
Material Selection, Right-to-Cancel notice.

**Consequence.** Which terms bind a customer depends on *which button the rep
pressed*. A homeowner who accepts on path A or B never sees the dispute,
change-order, liability or entire-agreement clauses that exist in the system.
`terms.html` §2 says "If a signed contract and anything on this Website
disagree, the signed contract controls" (`docs/terms.html:479`), which makes the
thinness of A and B the controlling text.

---

## 2. Clause-family matrix

Legend for "Applies to": **Cash**, **Ins-OH**, **Ins-KY**, **Fin** (financed),
**All**. "Seen / accepted" says where the customer actually meets the text and
what is recorded.

### 2A. Money: price, deposit, due dates, fees, liens

| Family | Where (file:line) | Exact current wording (verbatim, short) | Applies to | Gaps / contradictions between copies | Seen / accepted / proof |
|---|---|---|---|---|---|
| **Deposit / payment schedule** | Rule: `docs/pro/js/deposit-rule.js:863-889` (`policyText`); copy `functions/deposit-rule.js`; default `company-profile.js:123,126`; contract `document-generator.js:2832-2841`; server `contract.hbs:73-94`; envelope `estimate-esign-pdf.js:173-185`; deal `close-board.js:957-965`; portal `portal.js:1100-1125` | "Cash jobs under $2,000: no deposit — payment in full on completion. Cash jobs of $2,000 or more: 50% deposit at contract signing, balance on completion. … Insurance claims: the homeowner's deductible is due at signing and the insurance ACV payment … is due as soon as the carrier releases it … Kentucky insurance claims: nothing is due at signing … The deductible is the homeowner's responsibility and is never waived or reduced." (+ an Ohio ≥$25,000 10% sentence) | All | One rule, config-driven everywhere (good). **Contradicted by** Payment Agreement list item "Work will not commence until the deposit payment has been received and verified." (`templates.js:2773`) — false on a $0-deposit cash job and on every KY insurance job. "Balance on completion" has no due date in the contract (invoice supplies Net 7) | Shown on A, B (deposit line only), C, D, E. Accepted by signature. Rule's own plan is stored with the estimate; no digest of *which rule version* |
| **Payment methods** | `company-profile.js:127-128`; printed `document-generator.js:2838-2840` | "All payments must be made by check, ACH transfer, or credit card. No cash payments accepted. Material delays may extend timeline." | All | **Contradicts** Zelle (Stripe footer `stripe-crm-invoice.js:58-62`, invoice template, Payment Agreement list), and the product records cash payments (`money-paper-logic.js:249` `METHOD_LABEL`). "Material delays may extend timeline" is a schedule clause hiding inside a payment-method string | C only (tenant-editable text). Not on A/B/D |
| **Due date for balance / invoice** | `deposit-rule.js:893` (`INVOICE_DUE_DAYS = 7`), `:912`; Stripe `stripe-crm-invoice.js:147` (`days_until_due`); server invoice `invoice.hbs:79-83`; `doc-preflight.js:622-632` | "Net 7." (+ "Check, ACH, or credit card accepted.") | All | One number (7) everywhere after the 10-03 fix. The contract itself never states Net 7 or a due date for the final payment ("balance on completion"). `/the-pledge` promises the opposite sequencing (§4 item 9) | Invoice only. Contract acceptance does not include it |
| **Late fee / finance charge** | Default `company-profile.js:137`; settings field `dashboard.html:4298-4299`; client invoice `document-generator-templates.js:1154,1281-1287`; Payment Agreement `:2697,2768`; pre-flight literal `doc-preflight.js:1749-1751` | Invoice: "Payment is due within 7 days of the invoice date (Net 7) unless otherwise agreed in writing. Accounts past 30 days may be subject to a 1.5% monthly finance charge." Payment Agreement: "Late payments may be subject to a 1.5% monthly finance charge." Pre-flight default: "Payments are non-refundable once work has begun. Late payments subject to 1.5% monthly finance charge." | All (text only) | (1) **Not in any contract** (A–E). (2) Not on server `invoice.hbs`, which is the *first-choice* invoice renderer (`document-generator.js:615-632`: `invoice` ∈ `SERVER_TYPE_MAP`, no signers) and the auto-filed `money-paper.js` PDF; the late-fee text prints only when server render fails or on the Payment Agreement. (3) Not on Stripe invoice/pay link/reminders (`invoice-reminder.js:62-82` is "a friendly reminder"). (4) Three triggers: due at 7, fee "past 30 days", "may be subject" (discretionary). (5) The pre-flight `paymentTerms` textarea (incl. "non-refundable") is **never printed** — `renderPaymentAgreement` ignores `d.paymentTerms`, `renderInvoice` prints its own fixed block. (6) No code computes or posts a fee (grep: no `lateFee`/`financeCharge`/accrual). (7) 1.5%/month is not expressed as an APR | Seen only if the invoice came from the fallback renderer or the Payment Agreement was signed. Not accepted anywhere as a contract term. No record |
| **Collections costs / attorney fees / interest** | none | — | — | **Absent from every customer document.** Only "attorneys' fees" in the SaaS indemnity (`docs/pro/terms.html:470`, contractor-facing). Money "Collections" queue is an internal worklist (`money-dashboard.js:632-634`) with a one-tap reminder (`invoice-reminder.js`) | n/a |
| **Non-refundable / refund** | Only the dead pre-flight literal above; Roof Care Plan page "There is no refund when you cancel" (`docs/services/roof-care-plan.html:792,836`) | (see above) | — | Contract says deposit "refunded within 10 days of cancellation notice" (`company-profile.js:99`) while the FTC form it sits beside says "TEN BUSINESS DAYS" (`ky-insurance-law.js:90`). No retained-deposit / cancellation-after-materials-ordered clause | — |
| **Mechanic's lien, NBD's own right (reservation / notice)** | none | — | — | **Missing entirely** (§5). `document-generator.js:2881` prints a "Mechanic's Liens" section **only** when `stat.lien` is set, i.e. only the KY-insurance *undertaking* (next row). No notice-of-commencement, preliminary/furnishing notice, lien-deadline field, or lien affidavit support | n/a |
| **Lien undertaking (KY insurance only)** | `ky-insurance-law.js:78-81` (both copies byte-identical); printed `document-generator.js:2605,2881-2887`, `contract.hbs:145-148`, `document-generator-library.js:237-239` | "Contractor will not file or claim a mechanic's lien for any amount in excess of what your insurer pays or is expected to pay." | Ins-KY | **Not printed on the deal page (path B)** — the only KY-insurance acceptance path that is not a generated contract (`close-board.js` never references `KY_LIEN_CLAUSE`). Not on A (refused). It limits NBD; nothing states what NBD *may* lien for | C, D, E on KY ins. jobs. Accepted by signature |
| **Lien waivers (NBD issues)** | `document-generator-library.js:165-275`; pre-flight `doc-preflight.js:1276-1305`; tile `customer.html:2389-2403` | e.g. conditional final: "When {co} receives the final payment of {amt} described below, and that payment has cleared, {co} waives and releases all of its lien rights for all labor, services and materials it furnished …" + "confirms that its independent subcontractors and material suppliers have been paid for the work this waiver covers, or will be paid from this payment." | All (OH/KY statute named) | Manual template only; **no payment event, paid-in-full or stage move prompts one**. Marked "DRAFT — have your attorney review" in the picker (`document-generator-library.js:64`). The subcontractor-paid representation is a warranty NBD gives with no sub-side waiver collected to back it. Cites "Chapter 1311" / "Chapter 376" generically | Contractor signs only (`defaultSigners: [REP]`); homeowner/mortgagee never accepts anything |
| **Incoming waivers / sub & supplier payment** | `docs/pro/js/production.js:379,504`, `production-logic.js:68-96` | (sub record: name, phone, trade, `insuranceExpiry`, notes) | — | No sub/supplier waiver collection, no sub agreement, no pay-when-paid or lien-indemnity text (§5) | n/a |
| **Estimate validity** | `company-profile.js:133-135` (`proposalValidityDays: 30`; liability string says "valid for 30 days"); `estimate.hbs:154-179`; deal `close-board.js:1176`; link TTL `company-profile.js` `salesLinks.dealLinkDays: 14` | "This proposal is valid for 30 days from date of issue." / deal footer "This estimate is valid until {expiresAt}" | All | Three clocks: 30 days (profile setting and the literal "30" inside the liability sentence), the 14-day deal-link TTL (`salesLinks.dealLinkDays`), and the per-deal `expiresAt` the deal page prints. Editing the validity field leaves the hard-coded "30" in the liability sentence stale | Proposal terms (printed). Not a signed term on A/B |

### 2B. Rights, cancellation, and the dispute stack

| Family | Where | Exact current wording | Applies to | Gaps / contradictions | Seen / accepted / proof |
|---|---|---|---|---|---|
| **3-day right to cancel (FTC / OH / KY home-solicitation)** | Packet `ky-insurance-law.js:83-100, 730-870` (`cancelPacketHtml`); FTC statement `:83`; contract clause `company-profile.js:96-102`; server default `document-generator.js:1296`; Work Authorization `document-generator-templates.js:944-946`; envelope `estimate-esign-pdf.js:218-246` | Clause: "The Homeowner has the right to cancel this agreement within three (3) business days of signature without penalty, as permitted by Kentucky Revised Statutes § 367.390. Any deposit paid will be refunded within 10 days of cancellation notice." Short form: "within 3 days of signature without penalty (KY Residential Finance Law)." Packet: "You, the buyer, may cancel this transaction at any time prior to midnight of the third business day …" | All | (1) The clause cites **KRS § 367.390 for every NBD job** incl. Ohio property (the packet names Ohio's 1345.21–.28 by property state, `ky-insurance-law.js:730-733`); the short form calls it "KY Residential Finance Law". (2) "10 days" vs form's "TEN BUSINESS DAYS". (3) Work Authorization lets the homeowner cancel "by calling {phone}" — a call is not the written notice the packet requires. (4) Stage moves that start work inside the window only **warn** (`WORK_START_STAGES`, `ky-insurance-law.js:739`) | Packet on every contract-class doc, deal page, envelope. Acceptance sentence "By signing, the homeowner acknowledges receiving the attached Notice…" (`document-generator.js:226-227`). `cancelBy` stamped on doc + lead; `cancelPacketStale` flag if the re-date fails. Strong |
| **KY SB 153 notices + 5-day form** | `ky-insurance-law.js:44-76` (verbatim statute); contract `document-generator.js:2897-2901`; deal `close-board.js:980-1000`; server `contract.hbs:51-61,164,182` | KRS 367.624(3)(a),(b) notices + (4) form | Ins-KY (fail-closed: unknown state = KY) | Contractor mailing address is required and printed **only** here (Jo's rule: address prints only where law requires). Path A refuses KY ins. | Printed before signature in bold ≥10pt; accepted by signature |
| **Insurance "no payment until decision + 5 business days"** | `ky-insurance-law.js:105-116, 414-545` (`payLinkHold`, `invoiceOverdue`) | Rep-facing messages; customer text in portal `portal.js:1100-1118` | Ins-KY | Enforced in pay link, reminders, overdue sweep. Not a *contract* sentence on path B/C beyond the deposit line | Portal text; no acceptance |
| **Change orders** | Clause `company-profile.js:103-106`; contract `document-generator.js:2850-2855`; proposal `:2598`; templates `document-generator-templates.js:1040-1140`; server `changeOrder.hbs:30,84`; job spine `job-spine-logic.js:283` | "Any changes to the original scope of work must be documented in writing and signed by both parties before work proceeds. All change orders will specify: description of work, cost adjustments, and timeline impacts. NBD reserves the right to adjust pricing and completion dates based on scope changes." CO doc: "Payment for this change follows the payment terms of your original contract." | All | (1) Clause only on C/D (and the short form on proposals); **not on A, B or E**. (2) A signed CO is a free-standing document: **no code path adds it to the contract price, estimate or invoice** (grep: `change_order` appears only as a doc type and a spine action). (3) Insurance supplements the carrier approves are folded into the invoice (`invoice-pipeline.js:1061-1085`) with **no homeowner signature**. (4) "reserves the right to adjust pricing" is unilateral, in tension with "signed by both parties" | CO signable in-app (C/D evidence). No CO ledger |
| **Hidden damage / decking / rot / unforeseen conditions** | Estimate default `estimate-builder-v2.js:1269-1272` (15% decking replacement priced); Scope doc `document-generator-templates.js:826-830,812` | Scope doc: "Inspect decking for damage and replace as needed"; "Replace any damaged or rotted decking (7/16" OSB or equivalent)"; "Verify structural integrity of all rafters and trusses"; exclusions: "structural framing repairs" | All | **No contract clause** on overage decking, per-sheet pricing, notice-and-approve, concealed conditions or code-upgrade cost. The Scope doc both promises replacement of damaged decking and "verify structural integrity of all rafters and trusses" while excluding framing repairs; nothing says what a homeowner pays when decking exceeds the priced percentage | Scope doc (signable) only |
| **Governing law / arbitration** | `company-profile.js:108-109`; contract `document-generator.js:2865-2871`; neutral variant `company-profile.js:862-863` (non-NBD tenants only) | "In the event of dispute, both parties agree to attempt resolution through good faith negotiation. If negotiation fails, disputes shall be resolved through mediation or binding arbitration under Kentucky law." | All NBD jobs, incl. Ohio property | Kentucky law for Ohio work; "mediation **or** binding arbitration" (no election mechanism, administrator, rules, seat, cost split, carve-out for liens/small claims, class waiver). **No** venue, jury waiver, fee-shifting, notice-and-cure, limitations shortening, or severability clause anywhere. Only on C/D | Printed on C/D; accepted by signature |
| **Limitation of liability** | `company-profile.js:134-135`; proposal `document-generator.js:2604` | "NBD's total liability shall not exceed the contract price. This proposal is valid for 30 days from date of issue." | All | Printed on **proposals only**; not in contract C/D/E, A, or B. "Warranty Disclaimer" label wraps a sentence that disclaims nothing (`company-profile.js:130-131`: "Material warranties are provided by manufacturers and are separate from NBD workmanship warranty.") — no disclaimer of implied warranties, consequential damages, interior/water damage | Proposal terms, signable |
| **Entire agreement / modification** | `company-profile.js:111-112`; contract `document-generator.js:2889-2895`; server `contract.hbs:160` | "This contract constitutes the entire agreement between parties and supersedes all prior negotiations, representations, or agreements. Any modifications must be made in writing and signed by both parties." | All | C/D only (server `contract.hbs:160` has a shorter acceptance sentence). Not on A/B. No severability, assignment, notice-address, or counterparts clause | C/D |
| **Weather / schedule / access / permits / HOA / utilities / customer duties** | Estimated completion literal `doc-preflight.js:831`; contract default `document-generator.js:2723`; Scope doc `document-generator-templates.js:811` ("2-3 business days, weather permitting") | "Estimated Completion: 5-7 business days" (contract) vs "2-3 business days, weather permitting" (Scope of Work) | All | Two different default durations for one job. **No** clause for weather delays, start-date not guaranteed, site access/pets/vehicles, permits (who pulls, who pays), HOA approval, power/water, interior protection, landscaping/gutter-guard damage, or time-not-of-essence. (The only schedule hedge is "Material delays may extend timeline" inside the payment-methods string.) | — |
| **Indemnity / property damage / interior damage / insurance by contractor** | none in customer documents | — | — | Absent. "Fully insured" is a marketing claim (§3.5); no certificate or limits are printed on or attached to any contract | — |
| **Subcontractor use / independence disclosure** | none on contract; paper says "our crew" (`templates.js:2037`, `:2299`, `:2433`) | — | — | Crews are independent subs; no clause discloses subcontracting or allocates responsibility; "our crew" wording is not a W-2 claim but is not disclosure either. `partners.html:785,850` states sub terms publicly (COIs current "no exceptions"; "scope and price agreed in writing") with no agreement document behind it | — |
| **Photos / media release** | `documentation/runbooks/PUBLISH-PROJECT.md:66` ("Homeowner consent to publish photos is on file: yes") | — | — | Self-attested line in a prompt template; no consent capture, document or field in the CRM; contract has no photo clause | — |
| **E-sign consent** | `functions/esign-logic.js:36-38`; deal `deal-acceptance.js:144-146` | Envelope: "By signing electronically I agree that my electronic signature is the legal equivalent of my handwritten signature, and I consent to do business electronically." Deal: "I agree to sign electronically. My electronic signature is the legal equivalent of my handwritten signature." | All | One sentence; no paper-copy / withdrawal / hardware-software disclosures. **Absent entirely on paths C and D** (no checkbox in `sign.html`, `esign-sign.js` is the envelope page only). Two different wordings | A and B record it; C/D do not |

### 2C. Work promises: warranty

| Family | Where | Exact current wording | Applies to | Gaps / contradictions | Seen / accepted / proof |
|---|---|---|---|---|---|
| **Written workmanship (labor) warranty by tier** | `estimate-config.js:246-247 (PLEDGE_PROMISE, TIER_LABOR_YEARS), 268-355 (TIER_DISPLAY, tierWarrantyText)`; deal `close-board.js:84-114`; copies pinned by `tests/warranty-pledge-labor-years-2026-10-06.test.js`; dead copy `dashboard-ui.js:1470-1480` | Economy: "1-year written workmanship (labor) warranty; does not transfer on sale of property; the shingle manufacturer's standard limited warranty applies; no system warranty." Standard 5y non-transferable; Preferred 10y "transferable to one subsequent owner within 30 days of sale"; Elite/Beyond 20y fully transferable + annual courtesy inspection | Roofing | Years/transfer text is single-sourced. Non-roof jobs carry job-type warranty (`estimate-config.js:401-408`: gutter 5y, guard-only 2y, install 2y, repair 1y opt-in) | Deal page tier cards (accepted with the tier); contract/warranty certificate |
| **Warranty certificate body** | Client `document-generator-templates.js:610-720`; server `warranty.hbs:100-158`; third `docs/pro/js/warranty-cert.js:347` | Client: "Written workmanship warranty: our team guarantees the quality of installation for N years from the issue date. If any defect in workmanship causes a leak or failure within that period, we will repair it at no cost to you." Server: "This guarantee covers defects in labor and workmanship only. It does not cover damage caused by acts of nature, severe weather events, improper maintenance, or modifications made by parties other than {co}." | Roofing | **Three certificate generators, two wordings.** The client certificate has **no exclusions at all**; only server and `warranty-cert.js` carry the exclusions paragraph. None states a claim procedure, notice period, **payment-in-full condition**, inspection/maintenance duty, or sole-remedy language. Server prints "Backed personally by Joe Deal" (`warranty.hbs:138`) — a personal-liability statement | Certificate has "Homeowner Acknowledgment" signature (optional doc) |
| **NBD Pledge** | `estimate-config.js:246`; `warranty.hbs:134`; `/the-pledge` | "NBD Pledge: for as long as you own the home, we'll come back and make it right." Page: "It's not free repairs forever"; "as long as I'm in business"; "Lifetime Pledge" in title and nav strip | All NBD jobs | Code comments forbid calling it a "lifetime warranty"; the brand name is "The Lifetime Pledge". Contract-side sentence ("make it right") is broader than the page's gloss ("diagnosis … quote the fix fairly"); the certificate prints the short sentence without the gloss. Not defined in any signed document | Website + certificate line; never a signed term with limits |
| **Manufacturer warranty** | `tenant-rules.js` `warrantyLines`; `contract.hbs:119-132`; `company-profile.js:232-240` (GAF Certified #1162011, TAMKO Pro Gold #181382) | "Manufacturer warranty: …" per package; GAF System Plus "(GAF terms apply)" | Roofing | IDs consistent with public footer (`docs/terms.html` footer: GAF ID 1162011, TAMKO Pro ID 181382). No statement of who registers it, deadlines, or that NBD does not administer it except on Economy (`warranty.hbs:142`) | Printed |
| **Roof Care Plan terms** | `functions/care-plan-logic.js:30-48`; page `docs/services/roof-care-plan.html` (lines 361, 792, 836) | "$199 today, then $199 every year until you cancel — the plan renews automatically. No lock-in: cancel anytime … Your plan stays active through the time you have already paid for." / "No refund on cancel" | Care-plan buyers | Good model: disclosure text + `DISCLOSURE_VERSION` recorded on the membership (`care-plan.js:202-204`) and Stripe Checkout. But no scope/exclusions/limitation/dispute terms; "priority after storms" and "10% off repairs" are undefined promises | Disclosure shown before payment; accepted by checkout; version stored |

### 2D. Insurance and claim language

| Family | Where | Exact current wording | Applies to | Gaps / contradictions | Seen / accepted / proof |
|---|---|---|---|---|---|
| **Payment clause (replaces AOB)** | `ky-insurance-law.js:980-985`; printed C/D/E and A (`estimate-esign-pdf.js:191`) | "Homeowner will pay Contractor the contract price according to the payment schedule above. Homeowner may pay from insurance proceeds, personal funds, financing, or any combination. This contract does not transfer or give Contractor any rights or benefits under Homeowner's insurance policy, and Contractor will not represent Homeowner or act for Homeowner on any insurance claim." | All | Good for KY. Silent on: insurer denies/underpays, supplement not approved, mortgagee on the check, endorsement of insurer checks, depreciation holdback, balance due regardless of insurance outcome. **Not printed on deal page (B)** | C/D/E/A |
| **Insurance next-steps letter** | `document-generator-library.js:493-560` | "{co} is a roofing contractor, not a public adjuster. We do not represent you with your insurance company." + KY block ("Nothing is due when you sign …") | Ins | Strong and consistent with the law note. Informational (not signed) | Delivered letter |
| **Claim guide** | `document-generator-templates.js:2280-2370` | "We handle the hard parts — so it really is no big deal." / "Storm damage claims are typically classified as "Acts of God" and generally do not result in rate increases." / "Most claims are approved within 2–4 weeks." | Ins | **Contradicts** the honesty rules (claim-outcome and "we handle" wording; a rate-increase prediction). Not caught by `tests/ky-claims-wording-scan.test.js`, whose phrases are narrow ("claim specialist/expert", "handle the entire claim") | Delivered document; not signed |
| **Legacy Work Authorization (dead code)** | `docs/pro/js/dashboard-ui.js:1524`; builder `:1622-1650`; comment `:1606` | "I authorize {{COMPANY}} to negotiate with my insurance company on my behalf and to receive payment directly from the insurance carrier for covered work." | — | Defined in `DOC_TEMPLATES` and reachable only through `openDocTemplate(key)`, which **no caller invokes** (grep). Still ships in public JS. Direct conflict with Jo's 09-27 rule and KRS 367.628(1)(a) wording. Also "License # ________" line (`:1482`) | Unreachable (verify before deleting) |
| **Insurance box on deal page** | `close-board.js:1148` | "You manage your claim with your insurer; we provide our estimate and documentation." + deposit-plan terms | Ins | Consistent | Deal page |
| **Photo captions / AI** | `functions/photo-caption-safety.js` | filter bans claim words | — | Good control, not a customer clause | — |

### 2E. Consent, privacy, programs, counterparties

| Family | Where | Exact current wording | Applies to | Gaps / contradictions | Seen / accepted / proof |
|---|---|---|---|---|---|
| **Website Terms (reference; Grok rewrite pending)** | `docs/terms.html:428-506` | "…run by No Big Deal Solutions LLC, doing business as No Big Deal Home Solutions"; §2 "Estimates and Contracts … It is not a contract and not a guarantee of final price … the signed contract controls." | Site | Entity name differs from every other source (§4 item 10). Covers SMS terms + estimates + insurance disclaimer only; no governing law, no limitation, no arbitration | Site pages; no acceptance record |
| **Privacy (reference)** | `docs/privacy.html:564` (e-sign), 635-647 (retention), 618 (TCPA) | "When you sign or decline, we record your consent to sign electronically, the date and time, your IP address, your browser and device information, and a fingerprint (SHA-256 hash) of the document" | Site | **True for paths A and B only**; C and D record neither consent nor IP/UA (§7). Retention list names contact inquiries (3 yrs) and payment records (7 yrs) but not contracts/photos; the dispute-defence period is unstated | Site; no acceptance record |
| **SMS / email consent at intake** | `functions/tcpa-consent.js:200-210`, `functions/handlers/integrations.js:598-611`; `docs/inspect.html:454` | consent checkbox text; server stamps `tcpaConsentAt`, `tcpaConsentText` (version), `tcpaConsentSource`, `tcpaConsentIp` | Leads | Strong record. **Not repeated at contracting**: contract/portal carry no communications-consent clause, so a texting consent for a job rests on the lead form only | Recorded |
| **Referral program** | `doc-preflight.js:1546-1551`; card `document-generator-templates.js:1890-1962`; emails `email_system.js:642`; money `functions/referral-rewards.js:56` | Pre-flight: bonus literal `250`, "Bonus paid upon completion of referred job. One bonus per referred customer." Card fallback: "Referral reward is paid after referred project is completed. See us for full program details and terms." Email: "We offer a $100 referral bonus for every job that closes." | Referrers | **$250 (pre-flight literal) vs $100 (code, emails, KY cap)**. "Completed" vs "closes" vs "Closed" stage. No written program terms exist (the card points to terms that are not written). KY ins.: $100 cap not stated | Card only |
| **Review requests** | `docs/pro/js/portal.js:2329-2355`; `docs/pro/js/email_system.js` closed template | 4–5 stars: "A public Google review helps other homeowners find us"; 1–3 stars: "{rep} will reach out within 24 hours to make this right." | All | Public review link is shown only to 4–5-star raters (gating). No incentive text found. A "within 24 hours" promise is made without a tracked SLA | Portal only |
| **Free Roof program rules** | `docs/free-roof/index.html:555-565` | "Winner is selected at NBD's sole discretion. This is a gift, not a contest …" | Public | Marketing rules page; no entrant agreement / media release / tax statement; scope of "standard NBD warranty" undefined | Site |
| **Testimonial sheet (fallback)** | `document-generator-templates.js:2544-2547` | "They made the whole process feel like no big deal. From filing the claim to the final cleanup, everything was handled professionally and on time." — "Satisfied Homeowner" (+ location) | — | **Invented testimonials** print whenever the rep enters none. FTC endorsement risk; also contains claim-handled wording | Delivered document |
| **Fully insured / licensed / experience claims** | "Fully insured": `estimate-email.js:116,149`, `close-board.js:849,893`, `document-generator-templates.js:2441,2529`, site footers; "7+ Years Insurance restoration": `docs/partners.html:823`; licence fields `dashboard.html:4140,4255`; footer `document-generator.js:2265` | "Fully insured · GAF Certified · Owner-operated by Joe Deal" (email) | All | No licence claim in NBD documents (comments `close-board.js:845-849`, `estimate-finalization.js:549`) — good. "Fully insured" has no certificate, limits or carrier anywhere on customer paper; the company GL/WC text fields (`dashboard.html:4144-4145`) are not printed or retained against the claim. "7+ Years … Insurance restoration" on a public page sits next to KY's ban on holding out as an insurance specialist (partners page is not in the KY scan set). No founding-year claim found in customer paper | Marketing |
| **Subcontractor terms / COI** | `docs/pro/js/production.js:379,504`; `layouts/crew.js:339`; `partners.html:785,850` | "Certificates of insurance have to be current before the first job - that part isn't flexible." | Subs | Expiry tracked and warned, never blocking; no written sub agreement, W-9 storage (tracking only, no TIN: `expenses.js:233-246`), indemnity, or waiver text | Public page only |
| **NBD Pro SaaS terms (separate, contractor-facing)** | `docs/pro/terms.html:309-317 (draft banner), 326, 457-465, 488-492`; clickwrap `docs/pro/js/pages/register.js:192-201` | "…No Big Deal Home Solutions, a sole proprietorship owned and operated by Joe Deal"; liability cap "greater of … twelve (12) months … or $100"; Ohio law, Hamilton County venue; "any dispute that is not subject to arbitration" | Pro tenants | Kept apart on purpose. Notes: HTML comment says "LEGAL REVIEW PENDING"; the venue sentence refers to an arbitration clause that does not exist; entity described as a sole proprietorship (§4 item 10); acceptance recorded as `termsAcceptedAt` + `termsVersion` (client write, no IP) | Registration clickwrap |

---

## 3. The five focus questions

### 3.1 Lien rights: is there ANY lien language, notice or waiver flow?

| Piece | Present? | Detail |
|---|---|---|
| Reservation of NBD's right to lien in contract/proposal/invoice | **No** | grep of `docs/` + `functions/` for lien finds only the items below |
| Owner notice (notice of commencement, preliminary/furnishing notice, "your contractor may file a lien" disclosure) | **No** | — |
| Lien deadline tracking / affidavit / final-lien package | **No** | Job spine mentions "lien" only in a regex that classifies side documents (`job-spine-logic.js:430`) |
| Waivers NBD *issues* (conditional/unconditional × progress/final, OH/KY) | **Yes, manual** | `document-generator-library.js:165-275`; DRAFT badge for attorney; contractor-signed only; not tied to payments |
| Mortgagee/insurer waiver requests | Partial | Template has payer type insurance / mortgage; Academy/decision-engine text coaches reps on them (`decision-engine.js:204-207`) |
| KY insurance lien limit | **Yes** | one sentence, §2A |
| Waivers NBD *receives* from subs/suppliers | **No** | §5 |

### 3.2 Late payment after completion

- **Due date.** Stated on the invoice only (Net 7). The contract's "balance on
  completion" has no day count. Completion is recorded by a stage move
  (`install_complete`), which drafts a final invoice
  (`functions/install-final-invoice.js`); nothing in the contract defines
  "completion" (the Certificate of Completion is a separate, optional,
  signable document with a "to my satisfaction" confirmation,
  `document-generator-templates.js:1026`).
- **Fee.** One tenant-editable text, §2A. Not an applied charge: no fee
  computation, no ledger line, no Stripe line item.
- **Interest / collections / attorney fees.** None.
- **Does the flow reference it?** Stripe invoice footer: no
  (`stripe-crm-invoice.js:58-62`). Pay link description: "Invoice {id}"
  (`stripe.js:1384`). Portal: no. Reminder text: "a friendly reminder" with the
  link and Zelle line (`invoice-reminder.js`). Overdue sweep creates an
  *internal* task only (`functions/invoice-overdue.js`).
- **KY hold.** An invoice on a KY insurance job inside the hold window is
  never "overdue" (`ky-insurance-law.js:562-575`), so any future fee logic must
  respect it.
- **Public promise that interacts.** `/the-pledge`: "Walkthrough before the
  balance is due. We don't ask for the final payment until you've walked the
  work and approved it." (`docs/the-pledge/index.html:626`) versus a final
  invoice drafted when the stage reaches Install Done.

### 3.3 The dispute stack

| Element | Present? | Where |
|---|---|---|
| Governing law | KY only, via one sentence; cancellation clause also cites a KY statute | `company-profile.js:97-109` |
| Venue / forum / jurisdiction | **No** (SaaS terms have it; customer paper does not) | — |
| Jury waiver | **No** | — |
| Arbitration | "mediation **or** binding arbitration" (undefined) | C/D only |
| Fee shifting / prevailing-party | **No** (only SaaS indemnity) | — |
| Limitation of liability | Proposal only | `document-generator.js:2604` |
| Notice-and-cure before suit | **No** | — |
| Limitations-period shortening | **No** | — |
| Warranty claim notice procedure | **No** | §2C |
| Dispute-in-writing window | Only on Payment Agreement: "Any disputed amounts must be communicated in writing within 10 days of the payment due date." (`templates.js:2775`) | one template |
| Class waiver / severability / assignment | **No** | — |

### 3.4 Evidentiary hygiene (would it be usable in court?)

See §7 for the per-path table. Summary:

- **Signed copy retained:** yes on every path (envelope `signed.pdf` in a
  function-write-only path, storage.rules `:197-210`; deal page re-stored;
  HTML signed record locked `signed:'true'`, `storage.rules:105-111,167-171`).
- **Version hash:** A (source/signed/values), B (page + signature), D
  (original + signed) yes; **C none**.
- **Clause-set version:** none on any path; the company legal text is mutable
  and tenant-editable, so "which wording was in force" is answerable only from
  the stored signed copy.
- **Photo/time stamps:** CRM photos get `createdAt` (server) and
  `capturedAt` (client clock) plus session GPS and a phase tag
  (`photo-engine.js:1491-1493`); public photos are EXIF-stripped copies.
- **Communications log:** `email_log` and SMS logs are admin-SDK write-only
  (`tests/communication-log-contract.test.js`); call recordings/transcripts
  are kept; lead intake stores consent version/IP/time
  (`functions/tcpa-consent.js:200-210`).
- **Change-order approvals:** signed CO documents exist (C/D evidence) but are
  not linked to price or invoice (§2B).
- **Carrier decision date, cancellation window, stale-notice flag:** recorded
  on the lead (`carrierDecisionAt`, `cancelBy`, `cancelPacketStale`).
- **Retention:** server PDFs reaped at 30 days (derived); privacy page names
  no retention for signed contracts or photos; no statement tying retention to
  the dispute/limitations period.
- **Chargebacks:** Stripe disputes raise an alert only; evidence is submitted
  manually (`functions/stripe.js:2216-2321`).

### 3.5 Honesty rules (customer paper)

| Rule | Status |
|---|---|
| No "licensed" claim NBD cannot back | No licence claim in NBD customer documents; a licence number **prints in the footer if a tenant sets it** (`document-generator.js:2265`), and the settings placeholder shows "OH-HIC-12345" |
| "Fully insured" | Printed on emails, deal page, mailers; no COI/limits/carrier ever shown; see §2E |
| 7+ years / no founding year | No years claim or founding year on customer paper; "7+ Years Insurance restoration" on `partners.html:823` |
| In-house / W-2 | None found in customer paper; "our crew" used three times (`templates.js:2037,2299,2433`) |
| No claim-outcome promises / no "we handle the claim" on KY insurance jobs | **Violations** in the Claim Guide and the Testimonial fallback; dead legacy template in `dashboard-ui.js`; gate scans narrow phrases only |
| Credential accuracy | GAF Certified (not Master Elite), TAMKO Pro Gold; IKO not claimed — consistent |

---

## 4. Contradictions between copies

1. **Governing law / statute.** Cancellation clause cites KRS § 367.390 for
   every NBD job (`company-profile.js:97-99`); the packet it sits beside names
   Ohio's 1345.21–.28 for Ohio property (`ky-insurance-law.js:730-733`); the
   proposal short form calls it "KY Residential Finance Law" (`:101`); dispute
   clause is "under Kentucky law" (`:109`). Ohio-property NBD jobs get all of it.
2. **Refund window.** "refunded within 10 days" (`company-profile.js:99`) vs
   "TEN BUSINESS DAYS" (`ky-insurance-law.js:90`) in the same contract.
3. **Cash.** "No cash payments accepted" (`company-profile.js:128`) vs receipts
   with method Cash (`money-paper-logic.js:249`) and Zelle on invoices.
4. **Referral bonus.** $250 literal (`doc-preflight.js:1547`) vs $100
   (`functions/referral-rewards.js:56`, `email_system.js:642`).
5. **Work start.** "Work will not commence until the deposit payment has been
   received" (`templates.js:2773`) vs no deposit under $2,000 cash / nothing at
   signing on KY insurance (`deposit-rule.js:863-889`).
6. **Late fee reach.** Client invoice prints it; server invoice (first choice)
   and Stripe invoice do not (§2A).
7. **Warranty certificate.** Client certificate has no exclusions; server
   `warranty.hbs:142` and `warranty-cert.js:347` do; three generators.
8. **Pledge wording.** Brand "Lifetime Pledge" (`/the-pledge`, nav strip on
   every page) vs code rule "never a lifetime warranty"
   (`estimate-config.js:233-236`); page glosses it as diagnosis, certificate
   prints only the short sentence.
9. **Final payment sequencing.** `/the-pledge:626` ("walkthrough before the
   balance is due") vs contract "balance on completion" + Net 7 final invoice
   drafted at Install Done.
10. **Who NBD is.** Public Terms: "No Big Deal Solutions LLC" DBA NBD Home
    Solutions (`docs/terms.html:432,443,506`); Stripe footer: "No Big Deal Home
    Solutions, LLC" (`stripe-crm-invoice.js:61`); SaaS Terms: "No Big Deal Home
    Solutions, a sole proprietorship owned and operated by Joe Deal"
    (`docs/pro/terms.html:326`); brand `legalName` "No Big Deal Home Solutions"
    (`company-profile.js:184`); site footers: "No Big Deal Home
    Solutions". Four forms of the contracting party on paper that must name it.
11. **Validity.** 30 days (profile + hard-coded in the liability sentence) vs
    14-day deal link vs per-deal `expiresAt`.
12. **Clause set by path** (§1): the same job produces different binding text
    on A, B, C/D and E.
13. **Cancellation by phone.** Work Authorization allows cancel "by calling"
    (`templates.js:944-946`); the packet requires written notice.
14. **Legacy dead template** with "negotiate with my insurance company"
    (`dashboard-ui.js:1524`) vs Jo's 09-27 rule and the payment clause.
15. **Settings panel text still says** "Edit the boilerplate that ships on
    every contract, AOB, work-auth, and payment agreement"
    (`dashboard.html:4261`) though the AOB is retired.
16. **Privacy vs behaviour.** Privacy promises IP/UA/consent/hash for signed
    documents; paths C and D do not record them (§7).
17. **Insurance claim guide vs claim-wording rules** (§2D).

---

## 5. Missing entirely

- NBD's own **right-to-lien reservation / notice** and any lien-timing field or
  affidavit support (OH and KY).
- **Late-fee, interest, collections-cost and attorney-fee clauses** in a signed
  document; an applied-fee mechanism; an APR statement.
- **Venue, jury waiver, fee-shifting, notice-and-cure, limitations shortening,
  severability, assignment, notice-address** clauses.
- **Limitation of liability and entire-agreement text on the e-signed estimate
  (A) and deal page (B).**
- **Hidden-damage / concealed-condition / decking-overage** clause and pricing
  mechanism.
- **Weather, access, utilities, permits, HOA, interior-protection, property
  damage** clauses; subcontractor-use disclosure.
- **Insurer-denial / underpayment / mortgagee-endorsement / supplement**
  contract terms.
- **Emergency-services written request** (tarp / emergency repair inside the
  cancellation window) and any waiver record, beyond the "Emergency" invoice
  flag (`ky-insurance-law.js:485`).
- **Warranty claim procedure, conditions (payment in full, notice, maintenance),
  sole-remedy and transfer mechanics** on the certificate.
- **Subcontractor agreement, incoming lien waivers, COI enforcement,
  pay-when-paid / indemnity**.
- **Photo/media release**, **communications-consent clause at contracting**,
  **referral program terms**, **Roof Care Plan scope/limits terms**.
- **Clause-set version stamp** on every signed document, and **ESIGN consumer
  disclosures** (paper copy, withdrawal, hardware/software).
- **Contract-content check against ORC 4722.02(A)** for Ohio jobs of $25,000+.
  Per the [Grok audit note](../audit/GROK-SITE-AUDIT-OHIO-4722-2026-10-11.md)
  the statute requires supplier name, address, phone and TIN, proof of the
  liability policy, start and completion dates, total estimated cost plus costs
  not covered, and dated signatures; the contract prints a mailing address only
  on KY insurance jobs and prints no TIN or policy proof. (Statute reading is the
  earlier note's, not re-verified here — law lane.)

## 6. Present but not accepted / not recorded

| Text | Where it lives | Why it is not accepted or not recorded |
|---|---|---|
| Late-payment sentence | Client invoice, Payment Agreement | Not in any signed contract; invoice is not signed; most invoices come from the server renderer that omits it |
| "Non-refundable once work has begun" | `doc-preflight.js:1750` | Never rendered (field ignored by both renderers) |
| Limitation of liability, warranty disclaimer | Proposal terms | Only if the homeowner signs a **proposal**; not on A/B/D-contract |
| Dispute / change-order / entire-agreement clauses | Client contract HTML | Not on A, B or the server PDF |
| KY lien undertaking | Contract only | Not on the deal page, the one KY-insurance acceptance surface |
| Payment clause | A, C, D, E | Not on deal page B |
| NBD Pledge limits ("not free repairs forever") | `/the-pledge` | Website only; certificate prints the one-line promise |
| Warranty exclusions | Server cert, `warranty-cert.js` | Not on the client certificate |
| Electronic-signature consent | A, B | Not asked on C or D |
| IP / UA / device | A, B | Not captured on C or D |
| Document digest | A, B, D | Not on C (in-person) |
| Cancellation packet receipt | All contract-class docs | A sentence inside the signature statement, not a separate acknowledgement; stale-packet flag exists but only warns |
| Pay-link / portal payment terms | Portal text | Informational; no acceptance, no Stripe-side terms text |
| SMS/email consent | Lead forms | Recorded at intake only; not re-obtained at contract |
| Referral terms, review prompts | Card / portal | No accepted terms; review link gated to 4–5 stars |
| Photo publishing consent | Runbook line | Self-attested, not captured |
| Free Roof rules | Site | No entrant acknowledgement |

---

## 7. Evidence by signing path

| Evidence | A estimate envelope | B deal room | C in-person HTML | D remote HTML | E server PDF |
|---|---|---|---|---|---|
| Signer identity | typed name + email on record check | name on token, signature image | name entered by rep / drawn | rep-entered `signerName` | none |
| Timestamp | per signer `viewedAt`, `signedAt` (server) + `completedAt` | `acceptedAt` server | `signedAt` (client `serverTimestamp`) | `signedAt` server | n/a |
| IP / user agent | **yes** (`esign-logic.js:189-217`) | **yes** (`deal-acceptance.js:517-521`) | **no** | **no** | n/a |
| E-sign consent text | **yes** (text stored) | **yes** (text + box) | **no** | **no** | n/a |
| Digest of what was signed | source, values, signed SHA-256 | page SHA-256 + signature SHA-256 | **none** | original + signed SHA-256 | none |
| Original preserved | `source.pdf` | stored page | overwritten in place (locked) | archived original | derived |
| Certificate / audit trail | certificate page + append-only audit | `acceptedEvidence` map | none | none | none |
| Copy to signer | emailed signed PDF | success overlay only | on screen / print | signing link only is emailed; portal "Download Signed Contract" (`portal.js:963`) | n/a |
| Cancellation date stamped | `cancelBy` on envelope | `cancelBy` deal + lead | `cancelBy` doc + lead | `cancelBy` doc + lead | n/a |

---

## 8. What was not inspected / open items for the next lanes

- NBD's saved `companyProfile/{uid}` legal-text overrides, and any contract PDFs
  or HTML already filed on real leads (what customers actually signed).
- `functions/print/partials` and `design-system.css` were not read for hidden
  boilerplate; `estimate.hbs` / `inspection.hbs` / `photoReport.hbs` were read
  only for terms blocks.
- Public marketing pages beyond `terms`, `privacy`, `the-pledge`,
  `free-roof`, `partners`, `services/roof-care-plan` and the sampled claim
  gates were not re-audited here; the existing gates are
  `tests/claim-wording.test.js`, `tests/ky-claims-wording-scan.test.js`,
  `tests/oh-claims-wording-scan.test.js`, `tests/subcontracting-honesty.test.js`.
- Jo's 2026-09-27 decision was "no attorney review… keep it safe and dummy
  proof" for the Kentucky changes; the 2026-10-04 library later added DRAFT
  badges asking for attorney review of lien waiver, change order and
  right-to-cancel. This request (2026-10-13) is the first time Jo asks for the
  dispute/lien/late-fee layer — the synthesis lane should treat the badge list as
  the existing "needs a lawyer" set.
- Questions handed to the KY/OH law lane: lien reservation and notice
  mechanics for both states; permissible late-fee/finance-charge disclosure for
  a consumer construction contract; arbitration/venue/fee-shifting
  enforceability in a consumer home-solicitation contract; whether a
  limitations-period shortening is lawful for each state; ESIGN consumer
  disclosure requirements; ORC 4722.02(A) contents; interaction of a late fee
  with the KY pay-hold (KRS 367.626).
