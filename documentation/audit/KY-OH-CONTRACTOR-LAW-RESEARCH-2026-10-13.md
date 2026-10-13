# Ohio / Kentucky residential-contractor law — research memo for attorney review (2026-10-13)

> **Research memo for attorney review. Not legal advice. Retrieved 2026-10-13. Statutes change** (several
> sections below were amended in 2024-2026; check the effective date in each row before relying on it).
> Prepared by Claude for Jo Deal (No Big Deal Home Solutions) so a prepaid-legal-plan attorney can review
> the contract and invoice terms in a limited-scope session. Nothing here has been reviewed by a lawyer.

## How to read the confidence tags

| Tag | Meaning |
| --- | --- |
| **PRIMARY-VERBATIM** | Official statute text read in full from apps.legislature.ky.gov (Kentucky) or from a court's own opinion PDF. |
| **PRIMARY-SUMMARIZED** | Official page (codes.ohio.gov, ecfr/Cornell) fetched through a summarizing tool, not read word-for-word. Section number, effective date and substance are as reported; wording may be off at the edges. Counsel should read the section itself. |
| **SECONDARY** | Law-firm article, bar/legal-aid explainer, vendor guide, or search-engine summary. Use as a lead only. |
| **UNCERTAIN** | Conflicting sources, could not confirm, or an inference. |
| **NOT FOUND** | Searched; no authority located. Never read this as "the law says no". |

Section numbers below are the ones actually retrieved. Where a proposition has no cite, it is because none was found.

---

# PART A. One-page attorney brief

## What NBD does

- Residential **roofing, siding, gutters** (plus repairs) for **owner-occupied 1-2 family homes** in Greater Cincinnati
  (Hamilton, Butler, Warren, Clermont, Ohio) and Northern Kentucky (Boone, Kenton, Campbell, Kentucky).
- Jobs are **retail cash, insurance-paid (storm/hail), or financed**. A typical roof is well under $25,000; larger
  jobs (full re-roof + siding) can exceed it.
- Leads come from the website, referrals, and door-to-door; the first visit is a free inspection, then a written
  estimate and a contract signed electronically or on paper.
- Jo is on every roof; the **crews are independent subcontractors** (so unpaid-sub lien exposure for the
  homeowner is real and NBD should control it).
- NBD is based in Ohio and works in both states. It has no statewide roofing license (none exists in either
  state, per secondary sources) and does not claim one.
- **Current contract text** (CRM template, `docs/pro/js/document-generator-templates.js`): "Late payments may be
  subject to a 1.5% monthly finance charge"; invoices carry the same line by default.
- **Deposit rule in the CRM**: cash jobs of $2,000 or more take 50% at signing; insurance jobs take the
  deductible. On Kentucky insurance jobs NBD takes nothing at signing.

## The 8 questions we most need answered (full list in Part D)

1. **Late charge.** May a signed residential contract carry "1.5% per month" (18%/yr) in **Ohio** given the 8% ceiling
   in ORC 1343.01(A) for written instruments, and in **Kentucky** given KRS 360.010(1)(a)? If not, what is the highest
   rate or flat fee you would put in? Should the words "finance charge" come out?
2. **Ohio 10% deposit cap.** Does ORC 4722.04 (10% down payment) apply to Ohio jobs **at or under** $25,000, or only to
   "home construction service contracts" over $25,000 (ORC 4722.01 says "more than"; 4722.02 says "$25,000 or more")?
   Is a 50% deposit on a $24,000 Ohio roof lawful?
3. **Kentucky insurance jobs.** Confirm that, under KRS 367.626(2)(a) and 367.628, NBD may take **no advance payment**
   before the 5-business-day cancellation period "expires", and may **not** file a KRS 376.010 lien against the insured for
   any amount above what the insurer pays. What may NBD do to collect a deductible or non-covered balance?
4. **Home-solicitation exemption.** NBD has no storefront. Does the "buyer-initiated contact with a seller's fixed
   in-state business location" exemption (ORC 1345.21; KRS 367.410) fail for NBD, so the 3-day cancel notice (ORC 1345.23;
   KRS 367.430) must go on **every** signed contract?
5. **Lien rights.** Walk through our checklist (Part C) for the Ohio 60-day affidavit and the Kentucky 6-month /
   7-day-mailing / 12-month-suit sequence. Is anything missing for owner-occupied residential, and does a mortgagee's
   check, insurer check or lender draw change any step?
6. **Fees clause.** Is a mutual prevailing-party attorney-fee clause enforceable in a consumer form contract in both
   states (Ohio 2023-Ohio-3632 / Wilborn; KRS 411.195), and must it be signed **before** work starts?
7. **Defense clauses.** Which of these survive in a consumer contract: arbitration + class waiver, jury waiver,
   shortened claim period, consequential-damages disclaimer, warranty disclaimer ("workmanlike" duty), hidden-conditions
   decking allowance? Which should we drop because they invite a CSPA / KCPA claim?
8. **Advertising "licensed".** Given the Cincinnati contractor registration and any Northern Kentucky city or county
   registration, what exact wording ("registered", "insured") is safe on the website and estimates?

## Five things that are probably wrong *today* (details in Part E)

1. **50% deposit vs Ohio 10% cap** (ORC 4722.04) for Ohio jobs over $25,000 - PRIMARY-SUMMARIZED. Already live as a CRM cap per the 10-12 handoff; counsel scope question open.
2. **"1.5% monthly finance charge"** exceeds Ohio's 8% written-instrument ceiling if ORC 1343.01(A) applies, and the label invites a Truth in Lending argument - UNCERTAIN, needs counsel.
3. **Late fee only on the invoice is unenforceable in Ohio** (Minster Farmers, 2008-Ohio-1259; Sal's Heating, 2023-Ohio-3632, 8th Dist.) - PRIMARY-VERBATIM (the 8th District opinion).
4. **Kentucky insurance jobs: no lien for the uncovered excess; no discount; no advance payment** - KRS 367.628(2)(c),(g); 367.626 - PRIMARY-VERBATIM.
5. **An "early-pay discount" is itself prohibited on Kentucky insurance-paid jobs** (KRS 367.628(2)(c)) - PRIMARY-VERBATIM.

---

# PART B. Executive summary (what matters most to a roofer)

1. **Ohio residential lien clock is 60 days, not 75.** An affidavit for a one- or two-family dwelling or residential condo must be filed with the county recorder within 60 days of the claimant's last work/material (ORC 1311.06; 75 days is the non-residential default). A copy must be served on the owner within 30 days after filing (ORC 1311.07). [PRIMARY-SUMMARIZED]
2. **Ohio residential owners are heavily protected.** Under ORC 1311.011 (home construction contracts), no one has a lien if the owner paid the original contractor in full before receiving a copy of the lien affidavit, and subs' liens are capped at the unpaid contract balance less the cost to complete. The notice of commencement / notice of furnishing machinery (ORC 1311.04-.05) largely does not apply to home construction contracts. [PRIMARY-SUMMARIZED]
3. **Kentucky sequence is strict and short:** file a sworn statement within **6 months** (KRS 376.080), **mail a copy to the owner within 7 days or the lien is dissolved**, and **sue within 12 months of filing** (KRS 376.090). A contractor in privity with the owner needs no pre-lien notice; subs/suppliers on an owner-occupied 1-2 family home must give notice within 75 days (KRS 376.010(5)). [PRIMARY-VERBATIM]
4. **Kentucky bars a lien against an insured for the excess above the insurer's payment** on insurance-paid real-estate jobs (KRS 367.628(2)(g)), and bars rebating/waiving the deductible, any allowance or discount, and payments to the insured over $100 (KRS 367.628(2)(b)-(d)). Violations: AG enforcement, $5,000 per violation civil penalty, double damages plus fees for an injured person (KRS 367.627 as amended 2026 Ky. Acts ch. 54). [PRIMARY-VERBATIM]
5. **Kentucky insurance-paid contracts need statutory notices and a detachable cancel form** (KRS 367.624) and no advance payments until the cancellation window has expired (KRS 367.626(2)(a)); a contract that is cancelled, or that violates the emergency-pricing statute, is unenforceable but NBD can still collect a reasonable and customary amount for repair/emergency work done (KRS 367.626(3)). [PRIMARY-VERBATIM]
6. **Ohio's down-payment cap and written-contract rules** apply to "home construction service contracts" over $25,000 (ORC 4722.01-.04): 10% down (75% for non-returnable special orders), required contract contents, a $250,000 general-liability policy, and a $5,000 unforeseen-cost notice. Civil penalties up to $25,000 per violation and owner rescission (ORC 4722.07-.08). [PRIMARY-SUMMARIZED]
7. **Interest ceilings differ sharply.** Ohio: 8% by written instrument unless an exception fits (ORC 1343.01(A)); the contract rate controls once money is due under a *written contract* (ORC 1343.03(A)), but an invoice is not a written contract (Minster Farmers). Kentucky: 8% legal rate; written agreements up to 4 points over a Fed benchmark or 19% on principal of $15,000 or less, no cap above $15,000 (KRS 360.010); knowing excess forfeits all interest and the payer can recover double within 2 years (KRS 360.020). [PRIMARY-VERBATIM for KY; SUMMARIZED for OH]
8. **Home-solicitation cancellation:** 3 business days in both states; a compliant, dated, signed contract with the statutory caption and a detachable cancel form is required; waivers are void (ORC 1345.21-.28; KRS 367.410-.460). No work should start in the window. Missing it makes the sale a CSPA violation (ORC 1345.28) and leaves the buyer free to cancel any time (KRS 367.430(3)). [PRIMARY]
9. **Attorney-fee, interest and late-fee terms must be signed before work starts**; adding them on a post-job invoice or "customer acknowledgement" failed for lack of consideration (Sal's Heating, 8th Dist. 2023). Fee-shifting is generally enforceable if bargained-for (Paul Davis Restoration, 2005-Ohio-4017; KRS 411.195) but consumer adhesion is a recurring defence. [PRIMARY-VERBATIM for Sal's; KY text verbatim]
10. **No statewide roofing license in either state** (SECONDARY). Local registration exists at least in **Cincinnati** (Municipal Code ch. 1106, annual registration required before permits; PRIMARY-SUMMARIZED from the city page). Hamilton/Butler/Warren/Clermont municipalities and Boone/Kenton/Campbell county/city rules were **not verified**. Do not say "licensed" unless the claim matches a real registration.

---

# PART C. Late-fee decision table and lien checklists (Jo's addendum)

## C1. Late-fee decision table

Customary-practice notes are SECONDARY (contractor-software marketing pages and forums); none is authority. Reg Z and
FDCPA points apply to both states.

| Option | Ohio ceiling / risk | Kentucky ceiling / risk | Disclosure and where it must appear | Customary (SECONDARY) | Recommendation and downside |
| --- | --- | --- | --- | --- | --- |
| **A. Monthly interest %** (e.g. 1.5%/mo = 18%/yr, NBD's current text) | ORC 1343.01(A): 8%/yr cap for a "bond, bill, note, or other instrument of writing" for payment of money, with listed exceptions (principal over $100,000, certain loans). Whether a service contract is within (A) is **UNCERTAIN**. ORC 1343.03(A) lets a "written contract" set a different rate once money is due; ORC 1343.04 turns payments of excess interest into principal. | KRS 360.010(1)(a): principal $15,000 or less - lesser of 4 points over the Fed 90-day commercial-paper discount rate or 19%; (1)(b) over $15,000 - any rate. Knowing excess = forfeit **all** interest, and payer recovers 2x paid if sued within 2 years (KRS 360.020(1)). The "90-day commercial paper discount rate" benchmark may be hard to identify - **UNCERTAIN**. | In the **signed contract, before work** (Minster Farmers; Sal's). State the rate, start date (after a grace period), simple vs compound, and base. Repeat on the invoice. "Finance charge" wording should be reviewed by counsel (Reg Z). | 1%-1.5% per month is the range cited on contractor marketing pages (SECONDARY). | Stating the lawful rate plus a statutory-rate fallback is safest. Downside: a rate above Ohio's 8% (if it applies) risks usury exposure and a CSPA unconscionability argument (ORC 1345.03); in KY a 1.5% rate on a sub-$15,000 job is likely under 19% but forfeiture if wrong. |
| **B. Flat late fee** (e.g. $50 or 5%) | Liquidated-damages test: uncertain/hard-to-prove damages, not manifestly unreasonable, parties intended it to follow breach (Samson Sales; applied to late fees in Pacetti's Apothecary, 2023-Ohio-93 - SECONDARY, held a penalty). A per-diem measure fares better (Boone Coleman, 2016 - SECONDARY). | Mattingly Bridge test (SECONDARY): damages very hard to ascertain AND amount not grossly disproportionate **after** breach. Retrospective, harsher than Ohio. | Same: in the pre-work signed contract; a flat fee on a small balance can look disproportionate. | Common in invoices; "net 15 / $X" patterns (SECONDARY). | Weakest legally for a consumer. Downside: reads as a penalty; a 5% fee on a $20,000 balance is $1,000 for one day late. If used, keep it small and tied to documented admin cost. |
| **C. Statutory legal rate only** (no custom clause, or "legal rate") | ORC 1343.03(A) default rate set annually under ORC 5703.47 (SECONDARY: 7% for 2026; 8% for 2024 and 2025). Judgments accrue at that rate until paid. | KRS 360.010(4): 8% after default if the contract states no rate; judgments on written contracts bear the stated rate (KRS 360.040(3)), otherwise 6% (KRS 360.040(1)). | Nothing to disclose; say "interest at the legal rate allowed by law" so the clause exists. | Not typical marketing language; common in court-filed suits. | Lowest risk, lowest deterrent. Downside: little leverage before suit; a rate set by statute changes yearly. |
| **D. Collection-cost / attorney-fee recovery** | Enforceable when bargained-for and fair (Paul Davis Restoration v. Karaman, 8th Dist. 2005-Ohio-4017, via Sal's opinion; Wilborn, 2009-Ohio-306 - SECONDARY, residential mortgage context). Unenforceable when added after the work (Sal's). CSPA fees go to a prevailing supplier only for a groundless action in bad faith, ORC 1345.09(F) (PRIMARY-SUMMARIZED). | KRS 411.195: a writing creating a debt that requires reasonable fees on default is enforceable, only to the extent actually paid or agreed to be paid, not to a salaried creditor employee (PRIMARY-VERBATIM). KRS 367.220(3): prevailing-party fees in KCPA suits (PRIMARY-VERBATIM). | In the signed contract; make it mutual ("prevailing party") to blunt unconscionability. | Standard in contractor templates; sometimes one-way. | Make it mutual. Downside: one-way clauses invite an unconscionability/CSPA challenge and add leverage to the customer's side in a dispute. Percentage-of-debt collection-agency fees were **not researched**. |
| **E. Early-pay discount** (price is higher, discounted if paid on time) | Not found as prohibited. Must not be a deceptive "inflated list price" (CSPA ORC 1345.02 general). Reg Z treatment of cash discounts **not verified**. | **Cannot be used on insurance-paid jobs:** "allowance or discount against the fee" is prohibited (KRS 367.628(2)(c)). On cash jobs not found as prohibited. | Disclose the discount and net price on the estimate and the contract. | Common with merchants; for roofers it is mostly rebates/promotions (SECONDARY). | Not suitable for insurance jobs in Kentucky. For cash jobs, a plain "pay on completion" price is cleaner than a discounted-list structure. |

### What changes by payment source

| Payment source | Late fee / interest | Other rules that bite |
| --- | --- | --- |
| **Cash / check** | All of options A-D above apply, subject to pre-work signing. | ORC 4722.04 10% cap (Ohio >$25,000); KRS 367.626 not triggered (not an insurance contract). Ohio 109:4-3-05 estimate rules (jobs over $25). |
| **Insurance proceeds** | Charge nothing for delay the insurer causes; interest running on money the insurer will release (e.g. recoverable depreciation) is a CSPA/KCPA unconscionability risk (ORC 1345.03; KRS 367.170(2)). Kentucky: **no discount**, **no lien for excess** (367.628(2)(c),(g)). | KRS 367.622-.626 notices, cancellation, no advance payments. KRS 304.20-105 anti-assignment (an assignment-of-benefits clause is void). Ohio: no equivalent deductible/lien rule was **found** (not the same as absent). |
| **Financing (third-party lender)** | NBD is not the creditor; lender's terms govern. NBD should not stack its own late fee on a lender-paid balance. | If NBD itself carries a payment plan with a finance charge or more than four installments it may be a Reg Z "creditor" (12 CFR 1026.2(a)(17)(i)); the 25-extension "regularly extends" test limits that (1026.2(a)(17)(v)). Reg Z rescission rights replace the Ohio home-solicitation notice (ORC 1345.21 exclusion) - PRIMARY-SUMMARIZED. |

**Reg Z / FDCPA points (both states):** a late payment charge for an unexpected late payment is not a "finance charge"
(12 CFR 1026.4(c)(2), PRIMARY-SUMMARIZED), but periodic interest on a deferral may be. A creditor collecting its **own**
debt in its own name is generally outside the FDCPA's "debt collector" definition, 15 U.S.C. 1692a(6) - the exception
is a creditor that uses a name suggesting a third party is collecting (PRIMARY-SUMMARIZED). State rules for creditor
collection (Ohio CSPA ORC 1345.02-.03; KRS 367.170) were **not researched** beyond the sections cited.

## C2. Lien rights in practice - Ohio (NBD as original contractor, owner-occupied 1-2 family)

**Every deadline below: verify with counsel.** "Day 0" = the claimant's **own** last day of labor or delivery of material.

| When | Step | Cite | Deadline counted from |
| --- | --- | --- | --- |
| Before signing | Confirm who the **owner** is (the lien reaches the interest of the person who contracted). Get the parcel number and legal description. | ORC 1311.02 | n/a |
| Before signing | If contract price is **over $25,000**: written contract contents, insurance certificate (>= $250,000 GL), $5,000 unforeseen-cost election, **down payment <= 10%** (75% for non-returnable special orders). | ORC 4722.01-.04 | verify threshold wording |
| Before signing | If a home-solicitation sale: dated contract, caption + detachable **Notice of Cancellation**, no work for 3 business days; keep the returned notice/envelope. | ORC 1345.21-.24 | 3rd business day after signing |
| Before work | No notice of commencement is required for a **home construction contract** unless a lender requires one; subs need no notice of furnishing. | ORC 1311.04, 1311.05 | n/a |
| During work | Keep a dated log: **first** work/delivery and **last** work/delivery (the affidavit must state both). | ORC 1311.06 | n/a |
| During work | Collect **lien releases** from subs and suppliers as they are paid; give the owner/lender the contractor's affidavit when asked (all labor/material paid, unpaid claims named). | ORC 1311.011(B)(4),(6),(7) | on request |
| After work | Invoice at completion. Note: if the owner pays in full **before** receiving a copy of a lien affidavit, no lien exists. | ORC 1311.011(B)(1) | n/a |
| Unpaid | **File the sworn affidavit with the county recorder**: amount due after set-offs, property description, the owner, claimant name/address, first and last dates. | ORC 1311.06 | **60 days** after Day 0 (residential 1-2 family / condo) |
| After filing | **Serve a copy on the owner** (certified/registered mail, hand, overnight, sheriff; post on the property as fallback). | ORC 1311.07, 1311.19 | **30 days** after filing |
| Pending | Lien remains for **6 years** from filing; owner/mortgagee/lessee may serve a written demand to sue - suit not filed within **60 days** of service voids the lien. A bond for double the claim (1.5x if over $5,000) can replace the lien. | ORC 1311.13, 1311.11 | filing; service of demand |
| Paid | Release the lien within **30 days** of written notice of full payment or face damages, court costs, attorney fees. | ORC 1311.011(B)(3) | notice of payment |
| Suit | Enforce by petition; fees from the fund to prevailing claimants. | ORC 1311.16 | before the 6-year lapse |

**Ohio notes.** A mortgagee has priority for loan advances properly made (ORC 1311.14). Whether an insurer's check
naming a mortgagee changes any step was **not researched**. Ohio has no statute found that stops a contractor liening an
insured for the uninsured balance (unlike KRS 367.628(2)(g)) - confirm.

## C3. Lien rights in practice - Kentucky (NBD as original contractor)

| When | Step | Cite | Deadline counted from |
| --- | --- | --- | --- |
| Before signing | Contract with the **owner** (or written consent): this gives a lien without pre-lien notice. Subs/suppliers differ (see notes). | KRS 376.010(1)(a) | n/a |
| Before signing | **Insurance-paid job:** furnish mailing address, phone, the two bold notices and a detachable **NOTICE OF CANCELLATION**; no assignment of policy benefits. | KRS 367.624; 304.20-105 | before the contract |
| Before signing | Home solicitation: "BUYER'S RIGHT TO CANCEL" caption; nothing signed = buyer may cancel any time. | KRS 367.430 | n/a |
| Before work | No advance payments until the 5-business-day window (triggered by the insurer's notice of non-coverage) has expired. | KRS 367.626(2)(a) | insurer's notice - **UNCERTAIN how this works if no denial issues** |
| During | Log first/last dates. Optional: file a pre-lien "will furnish" statement with the county clerk **before a mortgage is recorded** to beat it. | KRS 376.010(2) | before the mortgage records |
| Unpaid | **File sworn statement** with the county clerk of the county where the property sits: amount due after credits/set-offs, property description, owner if known, whether contract was with owner/contractor/sub, claimant address (corporate: process agent). | KRS 376.080(1) | **6 months** after claimant ceases labor/material |
| After filing | **Mail a copy to the owner by regular mail** - lien is dissolved if not sent. | KRS 376.080(1) | **7 days** after filing |
| After filing | **Sue to enforce**, or the lien is dissolved (6 more months if the owner dies). | KRS 376.090(1) | **12 months** from filing |
| Pending | Bond for double the claim before judgment discharges the lien. Lien cannot exceed the original contract price. | KRS 376.100; 376.010(1)(d) | before judgment |
| Paid | **Release in the county clerk's office within 30 days** of satisfaction; mail a copy of the release to the owner within 7 days; after written notice, $100/day (day 15) rising to $500/day (day 45) plus fees. | KRS 382.365 | satisfaction date |
| **Insurance-paid jobs** | **Do not file a KRS 376.010 lien against the insured for any "excess" over what the insurer paid or is expected to pay.** | KRS 367.628(2)(g) | n/a |

**Kentucky notes.** For **subs/suppliers** on an owner-occupied 1-2 family dwelling, a written notice to the owner is
required within **75 days** after last item of labor/material, regardless of amount (KRS 376.010(5)); the owner has a
defence if the owner paid before receiving the notice; the contractor or sub cannot be the owner's agent. For
indirect claimants outside (5): 75 days if under $1,000, 120 days over $1,000 (KRS 376.010(4)). Kentucky courts
construe lien statutes strictly (SECONDARY; Prodigy Construction v. Brown Capital, Ky. App. 2017, cited in an ALFA
compendium). KRS 371.325: a waiver-of-defense clause in a retail installment contract cannot cut off an
owner-occupant's defence arising from a third-party materialman's lien.

---

# PART D. Research tables

## 1. Mechanic's liens

| Rule | Cite | URL | What it means for NBD | Confidence |
| --- | --- | --- | --- | --- |
| **OH** Original contractors, subs, laborers, suppliers hold liens on improvements and the owner's interest | ORC 1311.02 (eff. 2007-03-30) | https://codes.ohio.gov/ohio-revised-code/section-1311.02 | NBD as original contractor has a lien right; its subs and suppliers have their own. | PRIMARY-SUMMARIZED |
| **OH** "Home construction contract" regime for 1-2 family and condo residential work; paid-in-full bar; subs capped at unpaid contract balance less cost to complete; owner/lender may require contractor's payment affidavit; lien release within 30 days of notice of payment | ORC 1311.011 (eff. 2007-03-30) | https://codes.ohio.gov/ohio-revised-code/section-1311.011 | Homeowner is shielded: if they have paid NBD in full before seeing a sub's lien affidavit, subs have nothing. NBD must pay subs/suppliers and collect releases. The text contains no notice that must be placed in the contract. | PRIMARY-SUMMARIZED |
| **OH** Notice of commencement recorded by owner; excludes home construction contracts unless a lender requires it | ORC 1311.04 (version eff. 2025-09-30, HB 96) | https://codes.ohio.gov/ohio-revised-code/section-1311.04 | No NOC for ordinary residential jobs; if a lender requires one, the owner records it. | PRIMARY-SUMMARIZED |
| **OH** Notice of furnishing for subs/suppliers; not applicable to home construction contracts | ORC 1311.05 (eff. 2007-03-30) | https://codes.ohio.gov/ohio-revised-code/section-1311.05 | Subs on residential work are not required to serve a notice of furnishing. | PRIMARY-SUMMARIZED |
| **OH** Affidavit filing deadline: **60 days** (1-2 family dwelling / residential condo), 75 days (other), 120 days (oil/gas); contents | ORC 1311.06 (listed eff. 2014-01-30; verify current) | https://codes.ohio.gov/ohio-revised-code/section-1311.06 | The 60-day residential clock runs from the claimant's last labor/material. Missing it loses the lien. | PRIMARY-SUMMARIZED |
| **OH** Serve copy of affidavit on the owner within 30 days of filing (post on property if service fails) | ORC 1311.07 (eff. 1991-04-10); service methods ORC 1311.19 (eff. 2003-03-14) | https://codes.ohio.gov/ohio-revised-code/section-1311.07 | No consequence stated in the text for missing it; counsel should confirm case law. | PRIMARY-SUMMARIZED |
| **OH** Lien continues six years from filing the affidavit; effective-date rules | ORC 1311.13 (eff. 2007-03-30) | https://codes.ohio.gov/ohio-revised-code/section-1311.13 | Gives a long enforcement window but owner can shorten it with a demand. | PRIMARY-SUMMARIZED |
| **OH** Owner / mortgagee / lessee may demand suit; no suit within 60 days after service voids the lien; bond or approved security (double claim; 1.5x if over $5,000) replaces the lien | ORC 1311.11 (eff. 1991-04-10) | https://codes.ohio.gov/ohio-revised-code/section-1311.11 | Be ready to file suit quickly after a demand. | PRIMARY-SUMMARIZED |
| **OH** Foreclosure petition; fees from the fund to prevailing lien claimants | ORC 1311.16 (eff. 1991-04-10) | https://codes.ohio.gov/ohio-revised-code/section-1311.16 | Enforcement route. | PRIMARY-SUMMARIZED |
| **OH** Mortgage priority and disbursement rules; $100 per failure for incorrect fund-balance response | ORC 1311.14 (eff. 2007-03-30) | https://codes.ohio.gov/ohio-revised-code/section-1311.14 | A construction mortgagee can rank ahead of NBD's lien. Insurer/mortgagee-check interplay not researched. | PRIMARY-SUMMARIZED |
| **OH** Taking a note or other security does not waive the lien unless a written agreement says so | ORC 1311.21(A) (eff. 1993-04-16) | https://codes.ohio.gov/ohio-revised-code/section-1311.21 | Accepting a payment plan or note does not by itself waive the lien. Do not add language that does. | PRIMARY-SUMMARIZED |
| **OH** No statutory lien-waiver form located in ch. 1311. ORC 1311.35 is the *employee wage-lien* waiver, not a general lien waiver | ORC 1311.35 (eff. 2014-01-30) | https://codes.ohio.gov/ohio-revised-code/section-1311.35 | Use conditional-on-payment, amount-and-through-date-specific releases. A secondary source cites 1311.35 as "waiver of lien"; that is wrong for contractors. | PRIMARY-SUMMARIZED (form NOT FOUND) |
| **OH** Advance waiver of lien rights in the contract: sources lean toward enforceable in Ohio but disfavoured | none located | https://ezel.ai/surveys/mechanics-lien-waiver-rules/ohio | Do not put a no-lien clause in NBD's own residential contract; require subs' waivers progressively. | SECONDARY / UNCERTAIN |
| **KY** Lien for labor/material by contract with, or written consent of, owner, lessee, contractor, sub, architect, agent; capped at original contractor's price; relates back to start of work | KRS 376.010(1) (eff. 2023-06-29) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=54156 | NBD (in privity with owner) has a lien with no pre-lien notice. | PRIMARY-VERBATIM |
| **KY** Pre-lien statement to prime later mortgages | KRS 376.010(2) | same | Rarely used; file before the mortgage records. | PRIMARY-VERBATIM |
| **KY** Indirect claimants must give written notice within 75 days (claims under $1,000) or 120 days (over $1,000); owner-occupied 1-2 family: 75 days flat; owner who paid before notice is protected; mail suffices | KRS 376.010(4)-(5) | same | Controls NBD's own **subs/suppliers**; NBD should require their releases. The residential (5) rule says it applies to homes built under construction contracts "intended for use as the property owner's dwelling" - application to re-roofs is **UNCERTAIN**. | PRIMARY-VERBATIM |
| **KY** Sworn statement filed with county clerk within **6 months**; copy mailed to owner within **7 days** or lien dissolved; contents | KRS 376.080 (eff. 1990-07-13) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=35289 | Two failures that kill a lien: missing the 6-month filing and not mailing the copy. | PRIMARY-VERBATIM |
| **KY** Enforcement suit within **12 months** of filing (6 more if debtor dies); valid against later creditors/purchasers | KRS 376.090 (eff. 1942-10-01) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=35290 | Calendar the 12-month suit date at filing. | PRIMARY-VERBATIM |
| **KY** Bond for double the lien discharges it before judgment | KRS 376.100 (eff. 2011-06-08) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=39871 | Owner can bond off; NBD's remedy is then the bond. | PRIMARY-VERBATIM |
| **KY** Release lien within 30 days of satisfaction; $100/day then $500/day after notice; owner copy within 7 days | KRS 382.365 | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=35623 | Release promptly after payment; stamp the file. | PRIMARY-VERBATIM |
| **KY** **No lien against an insured for excess above insurer payment**; no deductible rebate; no allowance/discount; no payment to insured over $100; no ties to public adjusters/appraisers/supplement firms | KRS 367.628(2)(b)-(g) (eff. 2026-07-15; contracts on/after that date; earlier amendments eff. 2025-06-27) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=57393 | On Kentucky insurance-paid jobs NBD cannot lien the homeowner for the deductible or non-covered balance **if it is an "excess charge over the amount paid or expected to be paid by an insurer"** - how this reads for the **deductible** itself is a counsel question. | PRIMARY-VERBATIM |
| **KY** Waiver-of-defense clause in a retail installment contract cannot cut off owner's third-party materialman-lien defence | KRS 371.325 (eff. 2023-06-29) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=54157 | Matters only if NBD sells on installment paper. | PRIMARY-VERBATIM |
| **Out-of-state work** Lien law is governed by where the property sits; Ohio-based NBD working in KY follows KRS 376; KRS 367.620(5) defines covered "real estate" as parcels "located in this state" | KRS 367.620 | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=57390 | A contractor's home state does not change lien rights or the KY insurance-job rules. The general conflict-of-laws principle is SECONDARY. | PRIMARY-VERBATIM (KRS text); principle UNCERTAIN |

**Not found / not researched in section 1:** whether a mortgagee-name insurer check changes lien or payment steps;
Ohio lien-waiver case law; any statute stating a contract may not waive lien rights in advance (none found in either state).

## 2. Late fees, interest, collection costs

| Rule | Cite | URL | What it means for NBD | Confidence |
| --- | --- | --- | --- | --- |
| **OH** 8% per year for written instruments for payment of money; exceptions (principal over $100,000; certain loans) | ORC 1343.01 (eff. 1988-06-29) | https://codes.ohio.gov/ohio-revised-code/section-1343.01 | If this section reaches a contract/invoice for services, 1.5%/mo is above the ceiling. Application to deferred-payment service contracts is **UNCERTAIN**. | PRIMARY-SUMMARIZED |
| **OH** Interest on money due under a written contract at the contract rate, otherwise the 5703.47 rate | ORC 1343.03(A) (eff. 2016-09-08) | https://codes.ohio.gov/ohio-revised-code/section-1343.03 | Needs a signed written contract setting the rate. | PRIMARY-SUMMARIZED |
| **OH** Interest over the lawful rate is applied to principal | ORC 1343.04 (eff. 1962-07-01) | https://codes.ohio.gov/ohio-revised-code/section-1343.04 | Excess interest paid is credited to principal. | PRIMARY-SUMMARIZED |
| **OH** Statutory rate for 2026: 7% (8% for 2024, 8% for 2025); set each Oct 15 under 5703.47 | ORC 5703.47 | https://weltman.com/Publication-Ohio-Statutory-Interest-Rate-for-Judgments-in-2026 | The 2027 rate was due Oct 15, 2026 - **not checked**. | SECONDARY |
| **OH** Invoice notation of interest is **not** a "written contract" for ORC 1343.03(A) | Minster Farmers Coop. Exch. v. Meyer, 117 Ohio St.3d 459, 2008-Ohio-1259 (as quoted in the opinion below) | https://www.supremecourt.ohio.gov/rod/docs/pdf/8/2023/2023-Ohio-3632.pdf | A late-fee line that appears only on the invoice is unenforceable. | PRIMARY-VERBATIM (via Sal's) |
| **OH** Interest, costs and attorney fees added in a post-work "customer acknowledgement" signed after services were complete = unilateral modification, no consideration; contrast Paul Davis (fee clause signed pre-work upheld) | Sal's Heating & Cooling v. Harbour View Assocs., 8th Dist. Cuyahoga, 2023-Ohio-3632 (decided 2023-10-05) | same | The clause must be in the contract signed **before** the job. The case involved an HVAC contractor and a business customer, not a consumer. | PRIMARY-VERBATIM |
| **OH** Liquidated damages / penalty test (late fee) | Samson Sales v. Honeywell, 12 Ohio St.3d 27 (1984); Boone Coleman v. Piketon (Ohio 2016); Pacetti's Apothecary, 2023-Ohio-93 | https://kjk.com/2019/07/12/are-the-late-fee-provisions-in-your-form-contracts-enforceable-in-court/ | Flat fees are vulnerable; per-diem fares better. | SECONDARY |
| **OH** CSPA: unconscionable acts include terms heavily favoring the supplier; remedies: actual damages + up to $5,000 non-economic; treble for declared violations; fees to prevailing supplier only for a groundless action in bad faith | ORC 1345.03 (eff. 2017-04-06); 1345.09 (eff. 2012-07-03); 1345.10 (2-year limit) | https://codes.ohio.gov/ohio-revised-code/section-1345.09 | One-sided late-fee or fee clauses are a CSPA exposure. | PRIMARY-SUMMARIZED |
| **OH** Fee-shifting enforceability in consumer residential-mortgage context | Wilborn v. Bank One, 2009-Ohio-306 | https://reminger.com/report-234 | Narrow holding; not a general green light for consumer contracts. | SECONDARY |
| **KY** Legal rate 8%; written agreement up to the lesser of 4 points over the 90-day commercial-paper discount rate or 19% where principal is $15,000 or less; any rate above $15,000; contract rate applies after default | KRS 360.010 (eff. 2018-07-14) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=47989 | Most residential jobs are under $15,000 principal on the unpaid balance; 1.5%/mo (18%) sits under 19% but the 4%-over benchmark may bind lower. | PRIMARY-VERBATIM |
| **KY** Knowing excess interest forfeits all interest; payer recovers 2x; 2-year suit window; partial payments go to interest first | KRS 360.020 | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34171 | Drives the "get the rate right" rule. Note: applying payments to interest first matters for ledger design. | PRIMARY-VERBATIM |
| **KY** Judgments bear 6% (written contracts: the contract rate) | KRS 360.040 (eff. 2017-06-29) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=45719 | Contract rate carries into judgment. | PRIMARY-VERBATIM |
| **KY** Attorney-fee clauses in debt writings enforceable; only fees actually paid or agreed to be paid; not a salaried creditor employee | KRS 411.195 (eff. 1984-07-13) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=17788 | In-house staff time cannot be billed as attorney fees. | PRIMARY-VERBATIM |
| **KY** KCPA private action; prevailing-party fees and costs; 2 years | KRS 367.220 | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34922 | Fees can run **either** way. | PRIMARY-VERBATIM |
| **KY** Liquidated damages: very difficult to ascertain **and** not grossly disproportionate to **actual** damages | Mattingly Bridge Co. v. Holloway & Son (Ky.) | https://www.stites.com/?p=15391 | Retrospective test; flat late fee is risky. | SECONDARY |
| **Federal** Late-payment charges are not finance charges; "credit" is the right to defer payment; creditor needs a finance charge or more than four installments, and a regularity test | 12 CFR 1026.4(c)(2), 1026.2(a)(14),(a)(17) | https://www.law.cornell.edu/cfr/text/12/1026.4 | Calling a late charge a "finance charge" invites Reg Z arguments; an actual deferred-payment plan may make NBD a creditor. | PRIMARY-SUMMARIZED |
| **Federal** FDCPA covers third-party collectors, not a creditor collecting its own debt under its own name | 15 U.S.C. 1692a(6) | https://www.law.cornell.edu/uscode/text/15/1692a | NBD itself is generally outside the FDCPA; a collection agency it hires is inside. | PRIMARY-SUMMARIZED |
| **Requirement to state the fee** on invoice/contract | no statute located requiring the fee on the invoice | - | Enforceability depends on the signed pre-work contract (Minster; Sal's), not a statutory disclosure. | NOT FOUND |

## 3. Consumer-protection overlay

| Rule | Cite | URL | What it means for NBD | Confidence |
| --- | --- | --- | --- | --- |
| **OH** Home solicitation sale: seller personally solicits at residence; $25 floor; exclusions (buyer-initiated at a fixed in-state seller location; buyer-requested repairs but **additional** goods/services sold in the visit are covered; emergency with separate handwritten dated signed waiver; Reg Z rescission) | ORC 1345.21 (eff. 2021-09-30) | https://codes.ohio.gov/ohio-revised-code/section-1345.21 | A roofer who knocks, or who sells more than the asked-for repair, is covered. NBD has no storefront - fixed-location exemption is doubtful. | PRIMARY-SUMMARIZED |
| **OH** Buyer may cancel until midnight of 3rd business day; written agreement in the sales language; seller name/address and signing date; detachable "NOTICE OF CANCELLATION" in bold 10-point; refund within 10 business days; no waiver | ORC 1345.22 (right, timing, how notice is given) and 1345.23 (agreement content, caption, refund; eff. 2017-04-06) | https://codes.ohio.gov/ohio-revised-code/section-1345.23 | Put the notice on every Ohio contract signed away from NBD's place of business. | PRIMARY-SUMMARIZED |
| **OH** Seller must not begin services during the cancel period (security-system exception only); notice effective on send/postmark; right must appear on notes | ORC 1345.22 (eff. 2015-03-23) | https://codes.ohio.gov/ohio-revised-code/section-1345.22 | No tear-off of shingles in the 3-day window absent a valid emergency waiver. | PRIMARY-SUMMARIZED |
| **OH** Keep the cancellation notice and envelope as long as suit could be filed | ORC 1345.24 (eff. 2017-04-06) | https://codes.ohio.gov/ohio-revised-code/section-1345.24 | Evidence retention rule. | PRIMARY-SUMMARIZED |
| **OH** Non-compliance is a deceptive act under CSPA | ORC 1345.28 (eff. 1974-09-30) | https://codes.ohio.gov/ohio-revised-code/section-1345.28 | Exposure under 1345.09 remedies. | PRIMARY-SUMMARIZED |
| **OH** Home construction service suppliers: >$25,000 contract (strictly "more than" in 4722.01; "$25,000 or more" in 4722.02), $250,000 GL policy, required contract contents (9 items), $5,000 unforeseen-cost notice | ORC 4722.01 (eff. 2024-09-20, HB 50), 4722.02 (eff. 2012-08-31) | https://codes.ohio.gov/ohio-revised-code/section-4722.01 | Applies to 1-3 family dwellings; includes repair/improvement of existing structures (roofing is an inference, not listed). | PRIMARY-SUMMARIZED |
| **OH** Down payment capped at **10%** before work begins; 75% of non-returnable special-order items; cost-plus exempt; construction-loan payments allowed | ORC 4722.04 (eff. 2012-08-31) | https://codes.ohio.gov/ohio-revised-code/section-4722.04 | Conflicts with the 50% cash deposit rule on Ohio jobs over the threshold; scope for contracts at/under $25,000 is the key open question. | PRIMARY-SUMMARIZED |
| **OH** Prohibited acts; AG civil penalty up to $25,000 per violation; owner may rescind or recover economic damages plus up to $5,000 non-economic and fees | ORC 4722.03, 4722.07, 4722.08 (eff. 2012-08-31) | https://codes.ohio.gov/ohio-revised-code/chapter-4722 | Rescission means NBD refunds and the lien right is hard to assert. | PRIMARY-SUMMARIZED |
| **OH** Repairs and services over $25: estimate form at first contact; final bill may not exceed estimate by more than greater of $5 or 10% without consumer approval; itemized post-work list; disclose subcontracting where warranty is disclaimed | OAC 109:4-3-05 (eff. 2015-06-05) | https://codes.ohio.gov/ohio-administrative-code/rule-109:4-3-05 | Whether it applies to roofing "construction" vs "repairs or services" is **UNCERTAIN**; treat repairs as covered. | PRIMARY-SUMMARIZED |
| **OH** Failure-to-deliver: 8 weeks for prepaid orders without delivery then ship, refund, or offer refund | OAC 109:4-3-09 (eff. 2020-05-17) | https://codes.ohio.gov/ohio-administrative-code/rule-109:4-3-09 | Mainly goods orders; relevant to special-order materials with deposits. | PRIMARY-SUMMARIZED |
| **KY** Home solicitation sale definition (personal solicitation at residence; excludes prior negotiations, buyer-initiated phone, fixed-location business) | KRS 367.410 (eff. 2003-06-24) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34958 | Same fixed-location question for NBD. | PRIMARY-VERBATIM |
| **KY** 3 business day cancel; written notice; emergency exception (buyer asks for performance without delay and seller substantially begins) | KRS 367.420 (eff. 2008-04-24) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34959 | An emergency tarp job can proceed; permanent re-roof should wait. | PRIMARY-VERBATIM |
| **KY** Contract with "BUYER'S RIGHT TO CANCEL" caption; until complied, buyer may cancel by any means | KRS 367.430 | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34960 | If the caption is missing the cancel right never expires. | PRIMARY-VERBATIM |
| **KY** Refund within 10 days; buyer keeps goods and has a lien on them until refunded; seller gets **no compensation for services** performed before cancellation | KRS 367.440; 367.450(3) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34961 and ?id=54830 | Starting work in the window can mean working for free. Exempt: sales under $25, insurance sales. | PRIMARY-VERBATIM |
| **KY** Waiver of buyer rights is void | KRS 367.460 | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34963 | No waiver language in the contract. | PRIMARY-VERBATIM |
| **KY** KCPA: unfair/deceptive acts unlawful; "unfair" means unconscionable | KRS 367.170 | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34914 | General exposure. | PRIMARY-VERBATIM |
| **KY** Real estate goods or services contract = contract expected to be paid from insurance; "contractor" includes anyone who solicits it; covers residential and commercial | KRS 367.620 (eff. 2026-07-15) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=57390 | Triggers the insurance-job package below. | PRIMARY-VERBATIM |
| **KY** 5-business-day cancel after insurer's written notice of non-coverage | KRS 367.622 (eff. 2025-06-27) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=56105 | Any form of written or recorded expression works. | PRIMARY-VERBATIM |
| **KY** Required notices (bold 10-pt) and detachable NOTICE OF CANCELLATION in duplicate; address, phone, email; assignment-of-benefits notice | KRS 367.624 (eff. 2026-07-15) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=57391 | CRM already issues these per the 10-11 audit; counsel to confirm wording is verbatim. | PRIMARY-VERBATIM |
| **KY** No advance payments until the cancel period expires; refund within 10 days; contract unenforceable if cancelled or price violates KRS 367.374; contractor may still collect a reasonable and customary amount for repair/emergency work | KRS 367.626 (eff. 2026-07-15) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=57392 | "Deposit at signing" on an insurance job is out. How the clock runs if the insurer never denies is **UNCERTAIN**. | PRIMARY-VERBATIM |
| **KY** Contractor may not represent/negotiate for the insured, market as claims/insurance specialist or insurer-affiliated; contract clause violating (1)(a)1 is unenforceable; may give estimates and confer with the insurer after the claim is filed | KRS 367.628(1) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=57393 | Existing site wording is gated; CRM contract language still flagged in the 09-27 note. | PRIMARY-VERBATIM |
| **KY** AG enforcement; $5,000 per violation civil penalty; injured person may sue for 2x economic damages plus fees; violation of (2)(a) is a fraudulent insurance act and first-degree criminal mischief | KRS 367.627 as amended by 2026 Ky. Acts ch. 54; KRS 367.628(3) | https://apps.legislature.ky.gov/law/acts/26RS/documents/0054.pdf | Penalties are per violation, plus double damages. | PRIMARY-VERBATIM (session law text) |
| **KY** Insured may not assign policy duties/benefits; contract in violation void; direction of payment to a contractor allowed | KRS 304.20-105 (eff. 2024-04-02) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=54463 | No AOB. A direction to pay is allowed (4)(b). | PRIMARY-VERBATIM |
| **OH** Insurance-claim handling by contractors | ORC ch. 3951 (public adjusters); OAC 3901-1-24 | https://codes.ohio.gov/ohio-revised-code/chapter-3951 | Ohio reserves claim negotiation for licensed public adjusters; a **deductible-waiver** statute for contractors was **NOT FOUND**. | SECONDARY / NOT FOUND |
| **Federal** FTC Cooling-Off Rule: 3 business days for door-to-door sales; notice form; no waiver; 10 business days to refund | 16 CFR 429.1 | https://www.law.cornell.edu/cfr/text/16/429.1 | Parallels state rules; threshold and state-law interaction in 429.0/429.2 not read. | PRIMARY-SUMMARIZED |

## 4. Contract-defense clauses

| Clause / rule | Cite | URL | What it means for NBD | Confidence |
| --- | --- | --- | --- | --- |
| **OH** Written arbitration clause valid and enforceable except on grounds for revoking any contract | ORC 2711.01 (eff. 1991-10-23) | https://codes.ohio.gov/ohio-revised-code/section-2711.01 | Consumer arbitration is allowed but subject to unconscionability. Class waiver and consumer-specific limits **NOT researched**. | PRIMARY-SUMMARIZED |
| **KY** Written arbitration provision valid and enforceable; insurance contracts excluded | KRS 417.050 (eff. 2019-06-27) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=49287 | Same; NBD's insurance-job contract is a contractor/homeowner contract, not an insurance contract. KRS 367.354(2)(c)-(d) bars arbitration/class waivers only in **real-estate brokerage** service agreements (not applicable). | PRIMARY-VERBATIM |
| Governing law / venue / jury waiver | none retrieved | - | Not researched. Consumer statutes (ORC 1345, KRS 367) attach by property location and are not displaced by a choice-of-law clause as a rule of thumb (UNCERTAIN). | NOT FOUND |
| **OH** Limitations: written contract 6 years (version effective 2026-09-23, SB 219) | ORC 2305.06 | https://codes.ohio.gov/ohio-revised-code/section-2305.06 | Customer claims in 6 years; a shorter contractual period is possible if reasonable and clear (Colvin 1982; Miller 1994; Sarmiento 2005 - SECONDARY). | PRIMARY-SUMMARIZED + SECONDARY |
| **OH** Statute of repose for improvements: 10 years from substantial completion; exceptions for fraud, express longer warranty, owners/possessors | ORC 2305.131 (eff. 2005-04-07) | https://codes.ohio.gov/ohio-revised-code/section-2305.131 | Outer limit for property-damage / injury claims against the contractor. | PRIMARY-SUMMARIZED |
| **OH** Construction indemnity for the indemnitee's own negligence is void (insurance and bonds exempt) | ORC 2305.31 (eff. 1975-11-19) | https://codes.ohio.gov/ohio-revised-code/section-2305.31 | Hold-harmless in NBD's favor for NBD's own negligence is void; applies when the indemnitee hired the indemnitor. | PRIMARY-SUMMARIZED |
| **OH** Builder's duty of workmanlike construction is imposed by law and cannot be waived in a home-builder context | Jones v. Centex Homes, 2012-Ohio-1001 | https://supremecourt.ohio.gov/rod/docs/pdf/0/2012/2012-Ohio-1001.pdf | A "warranty disclaimer" may not defeat a workmanlike-duty claim; application to **remodel/repair** work is unsettled. | SECONDARY / UNCERTAIN |
| **KY** Limitations: written contract executed after 2014-07-15: 10 years | KRS 413.160 (eff. 2014-07-15); 413.090 (15 years, older contracts) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=43544 | Shortened contractual periods: no Kentucky authority found (KRS 413.265 addresses extensions only - SECONDARY). | PRIMARY-VERBATIM (413.160) |
| **KY** Statute of repose: 7 years after substantial completion (claims on construction deficiencies, contract or tort); 8-year outer limit for seventh-year injuries | KRS 413.135 (eff. 1990-07-13) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=17869 | Substantial completion = first occupancy/use. | PRIMARY-VERBATIM |
| **KY** Construction-services indemnity for the party's own negligence void (definitions are unusual: "contractor" = the person *offering* the contract) | KRS 371.180 (eff. 2005-06-20) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=35238 | Counsel should read the reversed definitions against NBD's form. | PRIMARY-VERBATIM |
| **OH** Electronic records/signatures not denied effect | ORC 1306.06 (eff. 2000-09-14) | https://codes.ohio.gov/ohio-revised-code/section-1306.06 | E-signed contracts valid; keep audit trail. Home-solicitation cancel forms still must be deliverable. | PRIMARY-SUMMARIZED |
| **KY** Same | KRS 369.107 (eff. 2000-08-01) | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=35206 | Same. | PRIMARY-VERBATIM |
| Notice-and-opportunity-to-cure (construction-defect pre-suit notice) | none found in either state | - | Contract may include one, but no statutory right was located. | NOT FOUND |
| Hidden-conditions / decking allowance, weather/delay, change orders, permits/HOA, subcontractor disclosure, insurance certificates, photo release | not researched as statute | - | These are drafting choices; relevant consumer hooks are CSPA unconscionability (ORC 1345.03), OAC 109:4-3-05 (extras authorization, subcontracting disclosure), ORC 4722.02 (insurance certificate >$25,000). | NOT FOUND |

## 5. Licensing / registration

| Rule | Cite | URL | What it means for NBD | Confidence |
| --- | --- | --- | --- | --- |
| **OH** No statewide roofing contractor license; state board licenses HVAC, plumbing, electrical, hydronics, refrigeration | none located; bills to add roofing introduced in past sessions | https://www.servicetitan.com/licensing/roofing/ohio | "Licensed" would not be accurate as a state claim. | SECONDARY |
| **OH** Cincinnati: all contractors working in city limits hold annual registration; permits issued only to registered contractors; fee $125 plus surcharges ($131.25 stated); owner-occupant exemption | Cincinnati Municipal Code ch. 1106 (Ord. 42-2011) | https://www.cincinnati-oh.gov/buildings/building-permit-forms-applications/contractor-registration/ | Required for Cincinnati jobs; the page does not name roofing or state penalties. A "registered with the City of Cincinnati" claim is accurate only if NBD is registered. | PRIMARY-SUMMARIZED (official city page) |
| **OH** Other cities / counties in Hamilton, Butler, Warren, Clermont (e.g. Columbus requires registration, per secondary source) | not verified | - | Needs a per-jurisdiction check. | NOT FOUND |
| **KY** No statewide roofing license; local rules vary; a 2026 bill to create one was reported introduced (status unconfirmed) | none located | https://contractorrequirements.com/roofer/kentucky/ | Same advertising caution. | SECONDARY / UNCERTAIN |
| **KY** Boone / Kenton / Campbell counties and cities (e.g. Covington) contractor registration or occupational license | not verified | - | Needs a per-jurisdiction call (building department and occupational-license office). | NOT FOUND |
| Advertising "licensed" or "insured" | KRS 367.170; ORC 1345.02 (general deception); KRS 367.628(1)(a)2 for claims-expert wording | https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=34914 | No statute specific to "licensed" located. The existing site gate already avoids a state license claim. | UNCERTAIN |

---

# PART E. Conflicts and traps

1. **50% deposit vs ORC 4722.04.** Above the Ohio threshold the cap is 10% (75% only for non-returnable special orders). The CRM already caps this per the 10-12 handoff; the question is contracts **at or under** $25,000. Treat "more than" vs "or equal to" as an actual drafting inconsistency in the statute.
2. **Late-fee line only on the invoice.** Unenforceable in Ohio as a matter of the two cases above; the fee/interest/fee-shifting clause must be signed before work. NBD's current contract text is a good start but "may be subject to" is soft language that a court can read against the drafter.
3. **"Finance charge" label.** It is a Truth in Lending term. Calling a late charge a finance charge is an avoidable argument; "late charge/interest" is plain.
4. **Interest above Ohio's 8%.** If ORC 1343.01(A) governs, a contract rate of 18% is a usury argument. If it does not, ORC 1343.03(A) lets the written rate stand. This needs counsel, not a guess.
5. **Early-pay discount on Kentucky insurance jobs.** Prohibited as an "allowance or discount" (KRS 367.628(2)(c)); so is any "we'll absorb your deductible" language.
6. **Liens against insureds in Kentucky.** A lien filed for the excess over insurer payment is a violation (KRS 367.628(2)(g)) with AG penalty and double damages; a good lien filing can become a liability.
7. **Kentucky advance payments.** Taking a deposit at signing on an insurance job violates KRS 367.626(2)(a) until the window "expires"; the window starts on a denial notice that may never come.
8. **Missing the 7-day mailing in Kentucky** dissolves the lien (KRS 376.080); calendar it with the 6-month filing.
9. **Ohio 60-day clock** is shorter than the 75-day clock most checklists quote.
10. **Starting work in the cancel window.** Ohio: seller may not begin (ORC 1345.22); Kentucky: seller gets no compensation for services performed before cancellation (KRS 367.450(3)).
11. **Fixed-location exemption.** Both states exempt buyer-initiated deals at a seller's fixed in-state business location; NBD has no storefront, so assume the notice is required.
12. **Waivers.** Home-solicitation waivers are void (KRS 367.460; ORC 1345.22); in Ohio a separate handwritten dated signed emergency waiver is the only exception (ORC 1345.21).
13. **Contract clause that authorizes negotiating with the insurer** is unenforceable in Kentucky (KRS 367.628(1)(b)) and is the act itself in (1)(a)1; the 09-27 note flagged CRM templates for exactly this.
14. **Assignment of benefits** is void in Kentucky (KRS 304.20-105); a "direction to pay" is permitted, but the notice language in KRS 367.624(3)(b) must be on the contract.
15. **Subcontractor lien exposure** falls on the homeowner's title (and on NBD's customer relationship). The Ohio "paid in full" shield (ORC 1311.011(B)(1)) protects the owner, not NBD; collect releases as you pay.
16. **A stale secondary source:** one lien-waiver explainer cites ORC 1311.35 as "waiver of lien"; the statute is the wage-lien waiver. Do not quote it.
17. **Statute dates in 2026.** KRS 367.620-.628 were amended effective 2026-07-15 (contracts on/after that date); ORC 2305.06 shows a 2026-09-23 version; Ohio statutory interest resets each Oct 15. Re-check on the day a contract is drafted.

---

# PART F. Questions for counsel (specific, answerable)

**Late charges and fees**
1. Is 1.5% per month on the unpaid balance of a signed Ohio residential contract lawful in light of ORC 1343.01(A) and 1343.03(A)? If not, what is the maximum and what wording should replace "finance charge"?
2. In Kentucky for principal of $15,000 or less, what is the operative "discount rate on 90-day commercial paper" benchmark under KRS 360.010(1)(a), and is 1.5% per month safely below it?
3. May NBD use a **flat** late fee instead (e.g. $50) in either state, and what per-diem or percentage structure would you accept?
4. Is a **mutual** prevailing-party attorney-fee clause in a consumer form contract enforceable in Ohio (Wilborn, Sal's, Paul Davis) and Kentucky (KRS 411.195)? Do collection-agency fees need separate disclosure?
5. Does a Reg Z disclosure obligation arise if NBD offers a plan to pay in installments with or without interest?

**Deposits and cancellation**
6. Does ORC 4722.04's 10% cap apply to Ohio contracts of $25,000 or less? Which price (before/after tax, before add-ons) counts?
7. For Kentucky insurance jobs, what, if anything, may NBD collect at signing or before the insurer's coverage decision (deductible, permit fee, materials order)? How should a **deductible** be collected at completion without violating KRS 367.628(2)(b)?
8. What must the Notice of Cancellation say on an Ohio job that is **also** insurance-paid, and may one document serve both?
9. Is a separate "emergency services" waiver (ORC 1345.21; KRS 367.420(5)) acceptable for a tarp/dry-in, and what contents make it valid?

**Liens**
10. For an owner-occupied Ohio 1-2 family house, confirm the 60-day affidavit, 30-day service and 6-year/60-day-demand sequence, and what happens if the owner is not served within 30 days.
11. For a Kentucky job where the **homeowner's mortgagee** is on the insurance check, does the check endorsement or the mortgagee's priority change the 6-month/7-day/12-month steps? Is a lien allowed at all against an insured for the **deductible** portion?
12. May NBD put a lien-waiver or "no-lien" clause in its own contract, and should subs/suppliers sign conditional releases in a prescribed form (any Ohio/Kentucky form)?

**Defence clauses and advertising**
13. Which of: arbitration with class waiver, jury waiver, shortened claim period (e.g. 1 year), consequential-damages disclaimer, warranty disclaimer, indemnity - are enforceable in consumer residential contracts in each state, and which would you strike?
14. Is there a notice-and-opportunity-to-cure clause you would recommend even though no statute requires one?
15. What exact wording of "licensed/registered/insured" may NBD use for Ohio (Cincinnati registration) and Northern Kentucky jobs, and which Boone/Kenton/Campbell/Hamilton/Butler/Warren/Clermont registrations are required?

---

# PART G. What could not be verified

- Ohio statutory text was read through a **summarizing fetch tool** (codes.ohio.gov); section numbers, effective dates and the substance reported are what the tool returned. Nothing was read word-for-word. Counsel should open each cited section.
- Kentucky statute text was read **verbatim** from apps.legislature.ky.gov PDFs; the 2026 session law (ch. 54) was read verbatim from the LRC site.
- Not researched: Ohio/KY governing-law and jury-waiver rules; class-action waivers; consequential-damages disclaimers; warranty-disclaimer cases for repair contracts; HOA/permit statutes; per-municipality contractor registration outside Cincinnati; collection-agency fee statutes; mortgagee-check/insurer-check lien interaction; Ohio deductible-waiver law (none found).
- Case law (Wilborn, Samson Sales, Boone Coleman, Colvin/Miller/Sarmiento, Jones v. Centex, Mattingly Bridge, Prodigy) is from **secondary summaries**; only Minster Farmers and Paul Davis are quoted second-hand through the primary text of Sal's Heating.
- The 2026 Ohio statutory interest rate (7%) and the status of the 2026 Kentucky roofing-license bill rest on secondary sources.
- The CRM's own contract/estimate wording is out of scope here except where cited from the repository.

*Related notes:* [GROK-SITE-AUDIT-OHIO-4722-2026-10-11](GROK-SITE-AUDIT-OHIO-4722-2026-10-11.md) (the 10% cap finding and the first counsel questions),
[KY-CLAIM-WORDING-2026-09-27](KY-CLAIM-WORDING-2026-09-27.md) (KRS 367.628 vocabulary and the flagged CRM contract language).
