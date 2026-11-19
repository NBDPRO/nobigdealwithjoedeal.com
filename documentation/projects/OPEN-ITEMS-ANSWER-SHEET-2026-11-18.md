# Open items answer sheet: proposed answers for Jo to ACCEPT or CHANGE (2026-11-18)

> **Not legal advice.** Sections 1 and 3 are business proposals for Jo. Section 2 is a list of **PROPOSED POSITIONS for the attorney to confirm**. They are not answers to legal questions, and nothing here is reviewed by a lawyer. Ticking ACCEPT on a legal item means "send this as our position to the attorney", never "this is settled". Companion to the [ATTORNEY-REVIEW-PACKET-2026-11-18](ATTORNEY-REVIEW-PACKET-2026-11-18.md) (clauses and the 42 questions AQ1 to AQ42), the [TEMPLATE-DEEP-SWEEP-2026-11-17](TEMPLATE-DEEP-SWEEP-2026-11-17.md) decisions log (Q1 to Q73), the law memo [KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13](../audit/KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13.md), [CLAUSE-SET-V1-2026-11-18](CLAUSE-SET-V1-2026-11-18.md), [CLAUSE-EVIDENCE-FOUNDATION-2026-11-18](CLAUSE-EVIDENCE-FOUNDATION-2026-11-18.md) and the [lane handoff](NEXT_SESSION-2026-11-18-template-liability.md).

**Public-repo rule for this file.** No internal cost figures, supplier prices or contractor prices appear here, only proposed retail dollars (the repo is public and `tests/catalog-cost-privacy.test.js` guards `docs/`). Where a proposed retail number rests on a judgment, it says so.

**Tags used.** Law: PRIMARY-VERBATIM, PRIMARY-SUMMARIZED, SECONDARY, UNCERTAIN, NOT FOUND, NOT researched (the memo's own tags). Web facts read for this sheet on 2026-11-18: **OFFICIAL-READ** (the official page was fetched and read), **OFFICIAL-SEARCH-ONLY** (an official page showed in search results but could not be fetched or read), **SECONDARY** (third-party). Suppliers' policies change by branch and account.

**Where the code stands (checked 2026-11-18).** Merged on `main`: evidence foundation (flag `docEvidenceFoundation`), clause set v1 (flag `docClauseSetV1`, PR 3182) and the invoice and Payment Agreement pointer to the contract's late terms (PR 3183). The attic form (flag `docAtticAckV1`) is built on the unmerged branch `feat/attic-ack-v2`. All flags default OFF.

---

## 1. Jo-only facts

| # | Item | What it blocks | PROPOSED value or step | How Jo confirms in under 5 minutes |
| --- | --- | --- | --- | --- |
| 1a | **Retail price, soffit baffle** | The soffit-intake recommendation line on the attic form stays hidden while unpriced; the form's line is one flat price, not per baffle (see note A) | **$25 per baffle** (range $20 to $35), priced like the existing soffit vent line plus labor. Judgment, no repo rule gives a baffle price | Open Estimate settings, read the number against what you would quote a homeowner for one baffle installed, tick ACCEPT or write yours |
| 1a | **Retail price, bath-fan duct re-route** | The bath-fan line on the attic form stays hidden while unpriced | **$450 flat** per re-route (range $400 to $550). Grounded in the retail job minimum already published on the "Bath Fan Roof Termination" job template (roof cap cut-in plus up to 8 LF of duct, fan unit excluded) | Same: compare to what you charge for the template today |
| 1a | Decking per sheet | **Every contract send is refused** while `deckingPerSheetCents` is blank (by design) | Starting value **$100 per 4x8 sheet**, flat, up to 10 sheets (Q37, Q55). Your own estimate, unconfirmed | Check against what you charge a homeowner for a replaced sheet, then enter it |
| 1b | **Supplier restocking percentage and return terms** | MAT-1 prints "lesser of 15% or the supplier's actual charge"; the 15 is already set. What is missing is what your supplier really charges | See 1b detail below. Proposed default: **typical range reported 15% to 20% on special orders; many suppliers waive or reduce it for resalable stock inside 30 days. Confirm with your supplier** | Ask your rep the four questions in 1b; write the answers on the checklist |
| 1c | **Kentucky assumed name (d/b/a)** | PARTY-1 prints a d/b/a that is not yet registered (AQ35) | Steps in 1c below | File it yourself (Q38); paste the receipt into the packet's attach list |
| 1d | **Ohio foreign-LLC and trade-name question** | AQ36; most of the work is in Ohio | Ask the attorney the two questions in 1d below. Do not file in Ohio before the answer | One line on the checklist |
| 1e | Payment-term numbers already defaulted | Nothing (they are set); each prints in the contract | Table 1e below | Tick ACCEPT on the whole table |
| 1f | Mailing address, assumed-name receipt, signer title | See 1f below | See 1f below | Three yes or no answers |

**Note A (unit mismatch to settle).** The packet says "soffit baffle". The attic form's recommendation line is `soffit_intake`, a flat line, and the bath-fan line is `bath_fan_duct`, also flat. Two more lines, `ridge_vent` (per foot) and `box_vents` (flat), are also unpriced and therefore hidden. Decide: price the soffit line as one flat intake-and-baffle package, or add a quantity. Proposed: **flat package, $25 per baffle as the unit you quote, entered as a flat figure for a typical count agreed with the rep**, because a quantity field is a build change. Also decide whether to price ridge vent and box vents or leave them hidden (proposed: leave hidden for first contracts).

### 1b. Supplier return and restocking policies (all SECONDARY for planning; confirm in writing)

| Supplier | What was found | Source quality |
| --- | --- | --- |
| **ABC Supply** | Resalable product returned within 30 days with receipt gets a full refund; returns after 30 days may carry a restocking charge or be refused; returns to a different branch need manager approval; special orders follow the manufacturer's policy with the customer paying return costs; a flat service fee applies to jobsite pickup of returns. No percentage is published on the page | OFFICIAL-READ (abcsupply.com return policy page) |
| **Beacon (now under the QXO name)** | Search results report 30 days, resalable condition, **20% restocking fee**, special orders not returnable. The page moved to qxo.com and could not be read | OFFICIAL-SEARCH-ONLY |
| **SRS Distribution** | A low-slope commercial policy dated 2022 reports 30 days with an RMA, buyer pays freight and handling, no returns of non-stock or special-order material. It covers low-slope commercial product, not shingles. A roofing-software blog claims restocking fees are waived for unopened original packaging; no primary source | OFFICIAL-SEARCH-ONLY, plus SECONDARY blog (do not rely) |
| **Home Depot (Pro Desk)** | Search results show the official page saying special-order returns or cancellations may carry a **15% restocking fee**, same-store return. No Pro-specific policy found. Page could not be read (blocked) | OFFICIAL-SEARCH-ONLY |
| **Lowe's (Pro)** | Only third-party pages (figures vary, one says 20% on some special orders; depends on the original supplier). No official page found | SECONDARY |

**What this means for MAT-1.** Because MAT-1 is the **lesser of 15% or the supplier's actual charge**, a supplier that returns resalable stock free inside 30 days means you recover only reverse delivery on standard stock. The clause protects you mainly on special orders and late returns. Say so to Jo plainly: do not expect 15% on every cancelled job.

**Ask your own rep (proposed script):** (1) restocking percentage on standard shingles and accessories, and does it change after 30 days; (2) is it waived for unopened full pallets; (3) which items count as special order (colors, ridge, metal) and what is the charge to cancel them; (4) what do they charge to pick up or take back a delivery to the jobsite. Ask for the answer by email so the supplier invoice can be shown on request (the clause promises that).

### 1c. Kentucky assumed name (d/b/a "No Big Deal Home Solutions")

| Step | What the source says | Source |
| --- | --- | --- |
| Who files | An LLC, corporation or partnership using a name other than its exact legal name files a **Certificate of Assumed Name with the Secretary of State**. Sole proprietors file only with the county clerk | OFFICIAL-READ ([Kentucky Business One Stop, structure page](https://onestop.ky.gov/start/Pages/structure.aspx); [Secretary of State business filings](https://www.sos.ky.gov/bus/business-filings/Pages/default.aspx)) |
| How | One exact or conformed copy of the form (a photocopy works); a file-stamped copy comes back as proof | OFFICIAL-READ (same One Stop page). The page links a paper form; it does not say whether the assumed-name filing can be done online |
| County clerk step | After the state files it, **file one file-stamped copy with the county clerk of the county where the LLC's registered office is located** | OFFICIAL-READ (One Stop page) |
| Fee | **$20** payable to the Kentucky State Treasurer, as shown on the Secretary of State's renewal form. The One Stop and business filings pages **do not state a fee** | OFFICIAL-SEARCH-ONLY (renewal form PDF; text unreadable by the fetch tool), repeated by SECONDARY filing sites. Not read directly |
| Duration | **Five years**, renewed within six months before expiry; no renewal reminder is sent | OFFICIAL-SEARCH-ONLY, SECONDARY |
| County clerk fee | Sources disagree ($33 or $46 reported). **Unverified**; ask the clerk | SECONDARY |
| Statute | KRS 365.015 and a penalty in KRS 365.990 | SECONDARY only, **NOT researched** (not in the law memo) |

**Unverified:** the exact original-filing fee, whether online filing is offered for this form, the county clerk fee, and the penalty for doing business before filing. Proposed step order: confirm the registered-office county, file with the Secretary of State, file the stamped copy with that county clerk, keep both receipts, then tell the attorney (AQ35). Do not send the first real contract using the d/b/a until the receipt is in hand.

### 1d. Ohio foreign-LLC and trade-name registration (not legal advice, NOT researched in the law memo)

| What to ask the attorney | Official pages that describe it | Read? |
| --- | --- | --- |
| (1) Does a Kentucky LLC doing roofing work in Ohio have to register as a foreign LLC before it does business there? | Ohio Secretary of State form 617 (code 106-LFA), registration of a foreign LLC, [ohiosos.gov/assets/617.pdf](https://www.ohiosos.gov/assets/617.pdf); statute ORC 1706.511 (foreign LLC may not transact business until registered, as reported) | Page blocked on fetch. Search results show the form asks for the home-state name, an Ohio statutory agent, and states a **$99** fee (form revised 10/2024; an older copy showed $125). **Fee unverified; check the current form** |
| (2) Must the d/b/a "No Big Deal Home Solutions" also be registered as a trade name or fictitious name in Ohio? | ORC Chapter 1329 (trade names); Ohio SOS trade-name form 534A and glossary at ohiosos.gov | Not read. Search summary only (SECONDARY) |

Also ask: does a roofer working in Ohio from Kentucky need local registrations (AQ34)? Proposed answer for the interim: none filed in Ohio by Jo until the attorney answers; this is a question, not a recommendation to skip registration.

### 1e. The payment-term numbers already defaulted

Set in Company Profile `paymentTerms` (defaults for NBD only; another tenant gets blanks). Tick ACCEPT once for the table.

| Number | Field | Decision it came from |
| --- | --- | --- |
| 8% a year, simple | `lateInterestPct` | Q10, kept in Q46; packet LATE-1 (AQ1, AQ2) |
| 15 days before interest | `lateGraceDays` | Q10; LATE-1 |
| 10 days to dispute in writing | `disputeDays` | Oct plan, carried in packet PAY-5 (follows the invoice date); Q15 adoption; AQ10 |
| 7 days final payment after final invoice | `finalPaymentDays` | Packet PAY-4 drafting default adopted under Q15; AQ10 |
| 3 days punch list after walkthrough | `punchListDays` | Packet PAY-4 drafting default adopted under Q15; AQ10 |
| 5 days after written notice before pausing | `pauseNoticeDays` | Q10 (right to pause); packet LATE-6; AQ11 |
| 15% restocking (lesser of that or supplier's actual charge) | `restockPct` | Q36, replaced by the "lesser of" form in Q45; MAT-1; AQ15 |
| 0 (card fee OFF) | `cardFeePct` | Fee decided at 3% (Q7, Q8, Q46) but held at 0 until phase 4 builds the mechanism; AQ12 to AQ14 |
| 10 sheets before a change order | `deckingSheetsBeforeChangeOrder` | Q37, Q55; CO-2; AQ16 |
| 3 days before start for the free attic check | `atticFreeCheckDays` | Q17; must be at least 1 |
| 30 days to give notice of a warranty claim | `claimNoticeDays` | Oct plan D12 warranty defaults adopted under Q15; WAR-3; AQ28 |

### 1f. Status of the three admin items

| Item | Status | Proposed step |
| --- | --- | --- |
| **Mailing address** | Blank on purpose in the NBD default. With the flag on, NBD contracts are refused until it is set | Jo enters it in Company Profile; check by generating a test contract |
| **Assumed-name receipt** | Not filed as of the 11-18 handoff (Q38: Jo files it himself) | Section 1c |
| **Entity signer title** | Decided: "Manager" (Q6, Q24); the code reads it from the brand setting `signerTitle`. Not confirmed here that the saved setting reads "Manager" | Open a test contract, read the signature block: "No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions, By: Joe Deal, Manager" |

---

## 2. The 42 attorney questions: proposed positions

**Read this first.** Every row is a **PROPOSED POSITION for the attorney to confirm. It is not legal advice and not an answer to a legal question.** Basis tags come from the law memo; anything the memo did not cover is marked NOT researched. "Before first contract" means: the clause prints on a real contract once `docClauseSetV1` is on, so the attorney should answer first, or Jo should avoid that job type.

**Practical risk-ranked default for the first real contracts (a business suggestion).** To make the fewest questions matter, send the first contracts for **Ohio, cash or check, under $25,000, owner-occupied, no financing, no insurance claim, no tarp in the cancellation window, and no card fee**. That removes AQ7, AQ9, AQ17, AQ19, AQ30 and the Ohio $25,000 items from the critical path. Questions marked **yes** below still need the attorney before any real contract; those marked **no** can wait.

### Tier 1. Money and statutory exposure

| AQ | Question | Recommended position (what the paper does, and why) | Rests on | If the attorney disagrees | Attorney needs to see | Before first contract? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Ohio late interest: is 8% simple after 15 days lawful; "interest" not "finance charge"; contract placement enough? | Keep LATE-1 plus LATE-4; late terms live only in the contract signed before work; the invoice just points back | ORC 1343.01(A), 1343.03(A) PRIMARY-SUMMARIZED (reach to a service contract UNCERTAIN); Minster Farmers and Sal's Heating PRIMARY-VERBATIM via the opinion | Change one number or phrase in the wording file or `lateInterestPct`; no rebuild | LATE-1, LATE-4, an invoice sample with the pointer line | yes |
| 2 | Kentucky: operative benchmark under KRS 360.010(1)(a); partial-payment order | Keep 8% (the same figure the memo reads as Kentucky's legal rate); apply payments to interest first | KRS 360.010, 360.020 PRIMARY-VERBATIM; the "90-day commercial paper" benchmark UNCERTAIN | Lower the rate for Kentucky jobs (needs a state-specific number, a small build) | LATE-1 | yes |
| 3 | Flat late fee stays off? | Off. No flat fee, no per-diem | Samson Sales, Pacetti's, Mattingly Bridge: SECONDARY | Low; a per-diem would need new wording | LATE-2 text | no |
| 4 | Mutual prevailing-party fees; collection-agency percentage fees | Keep mutual; collection costs only as "actually incurred"; no percentage-of-debt fees | KRS 411.195, 367.220(3) PRIMARY-VERBATIM; Paul Davis via Sal's PRIMARY-VERBATIM as quoted; Wilborn SECONDARY; percentage fees NOT researched | Strike or narrow LATE-3 | LATE-3 | yes |
| 5 | Truth in Lending: milestones of four or fewer, late interest | Keep milestones at four or fewer; never write "finance charge"; NBD offers no payment plan of its own | 12 CFR 1026.2(a)(17), 1026.4(c)(2) PRIMARY-SUMMARIZED | If creditor status attaches, drop PAY-3 and tell reps not to offer plans | PAY-3, PAY-6, LATE-1 | yes |
| 6 | Ohio 10% deposit cap: does it reach jobs under $25,000; which price counts | Until answered, **do not take 50% on any Ohio job near $25,000**; keep the shipped deposit rule's cap for jobs at or above $25,000 | ORC 4722.01 to .04 PRIMARY-SUMMARIZED (the "more than" vs "$25,000 or more" inconsistency is the memo's) | Change the cash deposit default for Ohio (rule in `deposit-rule.js`, small build) | PAY-2 variants | yes |
| 7 | Kentucky insurance jobs: what may be collected, how | Take **nothing at signing**; deductible and balance due after the insurer's written coverage decision plus the 5-business-day window; no discount or deductible-absorbing words | KRS 367.626(2)(a), 367.628(2)(b) to (d) PRIMARY-VERBATIM; clock if no denial UNCERTAIN | Move the due date; text change | PAY-2, PAY-4, LATE-5, INS clauses | yes (KY insurance only) |
| 8 | Cancellation notices: both states, insurance, fixed-location exemption, citation | Print the cancellation packet on **every** contract in both states (assume NBD has no fixed location); no work inside the window; the packet is by reference | ORC 1345.21 to .23 PRIMARY-SUMMARIZED; KRS 367.410 to .460 PRIMARY-VERBATIM (memo reads KRS 367.410 to .460; the old 367.390 cite is already dropped when the flag is on) | Reword the packet module (one file) | Attachment A (generated packet, one OH, one KY, one KY insurance) | yes |
| 9 | Emergency tarp inside the window | **No work in the window** unless a separate handwritten, dated, signed emergency request exists; that form is not built yet | ORC 1345.21 PRIMARY-SUMMARIZED; KRS 367.420 PRIMARY-VERBATIM | If not allowed, never tarp in the window | CANC-1, SCH-1 | no (avoid the situation) |
| 10 | Ohio $25,000 or more contents; PAY-4 (7 days, 3-day punch list) and PAY-5 (10-day dispute) | Attach the policy details; PAY-4 and PAY-5 stay as drafted but are the drafter's own (LOW) | ORC 4722.02 PRIMARY-SUMMARIZED; no statute found for PAY-4 or PAY-5 (NOT FOUND) | Change the day counts in settings | PAY-1, PAY-4, PAY-5 | yes |
| 11 | Right to pause, weather-tight first | Keep as drafted; on Kentucky insurance jobs only for amounts already due | No statute located either way (NOT FOUND) | Delete LATE-6; no other effect | LATE-6 | yes |
| 12 | Credit-card fee lawful in OH and KY; cash-discount alternative; doubtful "ORC 113.40" cite | **Keep `cardFeePct` at 0 (fee OFF)** until answered; the fee text is already omitted when it is 0 | State card-surcharge law NOT researched; vendor guide SECONDARY | None while off | PAY-7, processor surcharge terms | no (fee is off) |
| 13 | Fee excluded on Kentucky insurance jobs; Ohio insurance | Keep the Kentucky insurance exclusion (never prints there) | KRS 367.628(2)(c) PRIMARY-VERBATIM; Ohio NOT FOUND | Widen or narrow the exclusion | PAY-7, LATE-5 | no |
| 14 | Returned-payment fee limits | Keep "actual bank fee, not more than the law allows"; if the attorney cannot answer quickly, delete the sentence (small loss) | State limits NOT researched | Delete or cap | PAY-7 returned-payments paragraph | yes (prints) |
| 15 | Restocking and special orders: lesser-of structure, base, conflict with cancellation law | Keep "lesser of 15% or the supplier's actual charge, plus actual reverse delivery"; nothing owed inside the window; base wording is the drafter's | KRS 367.450(3) PRIMARY-VERBATIM (no pay for services before cancellation; materials not addressed, NOT researched); CSPA NOT researched; supplier terms: section 1b | Change the percentage or drop it; one setting or one paragraph | MAT-1, your supplier's written terms | yes |
| 16 | Hidden decking, change orders, OAC 109:4-3-05, text or email approval | Keep one flat per-sheet price up to 10 sheets, then a written change order; weather-tight minimum work allowed; the unilateral price-adjustment sentence stays deleted | OAC 109:4-3-05 PRIMARY-SUMMARIZED (applicability to roofing UNCERTAIN, treated as applying) | Change sheet cap or approval method | CO-1, CO-2, ATTIC-3 | yes |
| 17 | Financed jobs: PAY-4 variant, Reg Z rescission | **Take no financed jobs on this paper until answered** (financed reads the cash text today) | 12 CFR 1026 PRIMARY-SUMMARIZED; rescission interplay NOT researched | A financed variant would need drafting | PAY-4, PAY-6, CANC-1 | no (avoid financed) |

### Tier 2. Liens

| AQ | Question | Recommended position | Rests on | If the attorney disagrees | Attorney needs to see | Before first contract? |
| --- | --- | --- | --- | --- | --- | --- |
| 18 | Lien checklists, day counting | Keep deadlines out of the contract text; run them as an internal calendar from the memo's checklists | ORC 1311.06, .07, .13, .11, 1311.011(B)(3) PRIMARY-SUMMARIZED; KRS 376.080, .090, 382.365 PRIMARY-VERBATIM | Fix the internal calendar only | Memo Part C2 and C3 | no (before the first lien filing) |
| 19 | Kentucky insurance lien and the deductible | Ship LIEN-3 as is; **no lien for any amount on a Kentucky insurance job**, deductible included, until answered | KRS 367.628(2)(g) PRIMARY-VERBATIM; reading for the deductible itself is the open question | A lien for the deductible would need new wording | LIEN-3, INS-2 | yes (KY insurance only) |
| 20 | Lien reservation and waiver forms | Keep LIEN-1, 2, 5 with no waiver-flavored words; leave the four waiver forms on legacy wording until reviewed | ORC 1311.21(A) PRIMARY-SUMMARIZED; advance waivers SECONDARY / UNCERTAIN | Reword the clauses | LIEN-1, 2, 5; the four waiver forms | yes |
| 21 | Lien notice inside the contract; LIEN-4 | Print only the reservation and the owner statement; the memo found no required notice | ORC 1311.04 (amended 2025-09-30) PRIMARY-SUMMARIZED; NOT FOUND for a required notice | Add a notice | LIEN-1, LIEN-4 | yes |
| 22 | Subcontractor agreement | No agreement text exists; until drafted, collect a W-9, an insurance certificate and a signed release at each sub payment | NOT researched | Attorney drafts it later | Current sub paperwork | no |

### Tier 3. Dispute stack, warranty, scope, attic

| AQ | Question | Recommended position | Rests on | If the attorney disagrees | Attorney needs to see | Before first contract? |
| --- | --- | --- | --- | --- | --- | --- |
| 23 | Dispute stack | Mediation first, then courts; no arbitration, jury waiver or class waiver | ORC 2711.01 PRIMARY-SUMMARIZED; KRS 417.050 PRIMARY-VERBATIM; class and jury waivers NOT researched | Add or strike terms | DISP-3, 5, 8 | yes |
| 24 | Notice and cure | Not printed | No statute found (NOT FOUND) | Add a cure clause | DISP-2 text | no |
| 25 | Governing law and venue | Property-state law, property-county venue | NOT researched; consumer-statute override UNCERTAIN | Change one clause | DISP-1, DISP-4 | yes |
| 26 | Shortening the claim period | Not used | Ohio SECONDARY; Kentucky none found | None | DISP-7 | no |
| 27 | Limits on liability for specific items | Keep the specific-item limit only, with the savings sentence; no general cap | ORC 2305.31, KRS 371.180 PRIMARY; Jones v. Centex SECONDARY / UNCERTAIN | Strike DISP-6 or SCH-2's last sentence | DISP-6, SCH-2 | yes |
| 28 | Warranty exclusions, 30-day notice, paid-in-full condition, Pledge | Keep WAR-1 to WAR-7; "Backed personally by Joe Deal" stays removed | Jones v. Centex SECONDARY / UNCERTAIN; no statute for repair warranties NOT researched | Reword exclusions; `claimNoticeDays` is a setting | WAR-1 to WAR-7 | yes |
| 29 | Schedule, access, permits, selections | Keep SCH-1 to 3, SUB-1, MAT-2 as drafted | Drafting choices; not researched as statute | Reword | Those clauses | yes |
| 30 | Insurance supplements | Documentation only; homeowner approval before a supplement is folded in | KRS 367.628(1) PRIMARY-VERBATIM | Reword CO-3, INS-1 | CO-3, INS-1 | yes (KY insurance only) |
| 31 | Attic acknowledgment structure; GAF/TAMKO wording; mold; ticks vs initials | Keep acknowledge-and-decline, never "waiver", the fixed savings sentence, no mold advice beyond "not tested". The built form uses **ticks plus signature, not initials**; ask the attorney to bless that | Not in the law memo (NOT researched); the "may affect the manufacturer's warranty" line is unchecked against GAF and TAMKO terms | Reword one wording file (`attic-ack-text.js`) | ATTIC-1 to 4, WAR-2 | yes (for any re-roof) |
| 32 | "Not inspected" design; free check up to 3 days before start | Keep; an NBD miss is recorded as NBD's, never the homeowner's choice | NOT researched | Remove the free-check offer | ATTIC-5 | yes (re-roofs) |
| 33 | Homeowner won't sign | **Decline such jobs for the first contracts**; the override path (owner approval, 30 days, logged as notice, never as signed) exists but is not needed | NOT researched | Stricter or looser rule | ATTIC-6 | yes (re-roofs) |

### Tier 4. Identity, paper, records

| AQ | Question | Recommended position | Rests on | If the attorney disagrees | Attorney needs to see | Before first contract? |
| --- | --- | --- | --- | --- | --- | --- |
| 34 | "Licensed", "registered", "insured"; local registrations | Say only "fully insured", GAF Certified, TAMKO Pro Gold; never "licensed". Jo checks whether NBD is registered with the City of Cincinnati before claiming it | Cincinnati chapter 1106 PRIMARY-SUMMARIZED (city page); other Ohio and Kentucky jurisdictions NOT FOUND | Reword the badge row | PARTY-1, SCH-3, website badge copy | yes |
| 35 | Unregistered d/b/a | File first (section 1c); do not use the d/b/a on a real contract before the receipt exists | KRS 365.015, 365.990 SECONDARY, NOT researched | A fix-first list | PARTY-1, filing receipt | yes |
| 36 | Ohio foreign-LLC and trade name | Ask; Jo does not file in Ohio before the answer (section 1d) | NOT researched | Registration steps | PARTY-1, the SOS records | yes |
| 37 | Signature block and capacity; terms.html "sole proprietorship" | Keep "No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions, By: Joe Deal, Manager"; correct `docs/pro/terms.html` as the attorney says | Drafting; LOW | Reword the party block | PARTY-1, terms.html | yes |
| 38 | E-signature disclosures; in-person path has no consent step | Prefer the **remote link** path for real contracts (the homeowner's own device signs and consents); use in-person only where needed | ORC 1306.06 PRIMARY-SUMMARIZED; KRS 369.107 PRIMARY-VERBATIM; consumer-disclosure content NOT researched | Add disclosure text | ESIGN-1, DISP-8, evidence note | yes |
| 39 | Click-through acknowledgments beside expandable sections | Statutory notices stay on the page, never behind a link; "scroll to enable" is not worth building yet | NOT researched | Rework the layout | ESIGN-1, ATTIC-3, CANC-1, INS-4 | no |
| 40 | Retention period | Keep signed contracts, photos and communications at least 10 years (Ohio repose) | ORC 2305.131 PRIMARY-SUMMARIZED; KRS 413.135 (7 years) PRIMARY-VERBATIM | A different period | ESIGN-1 | no |
| 41 | Photo and media consent | Keep the optional self-attested box | NOT researched | Reword | MEDIA-1 | no |
| 42 | Job communications consent | Keep texting-law consent at contracting | The compliance reference agent covers TCPA; NOT in the memo | Add consent text | ESIGN-2 | no |

**Count of "yes" rows:** 29 of 42 (AQ1, 2, 4, 5, 6, 7, 8, 10, 11, 14, 15, 16, 19, 20, 21, 23, 25, 27, 28, 29, 30, 31 to 38). AQ7, 19 and 30 apply only to Kentucky insurance jobs and AQ31 to 33 only to re-roofs. Using the first-contract default above, 26 remain, and AQ31 to 33 drop out too if the first contract is not a full re-roof.

---

## 3. Engineering and rollout decisions still open

| Decision | Recommended answer | Needs |
| --- | --- | --- |
| **When to turn the attic flag on for Jo's account** | Last, after everything below: do not turn on `docAtticAckV1` until (1) `feat/attic-ack-v2` is merged (it was unmerged on 11-18); (2) `atticFreeCheckDays` is set (default 3, must be at least 1); (3) the generate()-based manifest fix is merged (named in the brief; **no note describing it was found, so its state is unverified**); (4) a dry run on a test lead passes (send, sign on the remote link, not-inspected page, gate refusal); (5) `deckingPerSheetCents` and the priced lines are set (section 1a); (6) mailing address set; (7) attorney has seen AQ31 to AQ33. Turn on `docEvidenceFoundation` and `docClauseSetV1` first, together | Items 1 to 7 |
| **Whether reps get the flags** | **No**, per Q57: off for reps and other tenants until the settings screen and the Ohio and Kentucky questions are settled. Caution: the attic gate is on when **either** the acting user's flag **or the tenant owner's** flag is on, so turning it on for Jo's own account also gates his reps' re-roofs. Until reps are trained, Jo sends re-roof contracts himself | Decision only |
| **Turning on the card fee (phase 4)** | **Not yet.** Keep `cardFeePct` 0. Phase 4 needs: the Stripe notice to the processor before the first surcharge; a card-funding check (credit only, never debit or prepaid); the fee line before the pay button and on the receipt; proportional refund; the Kentucky insurance no-fee rule; and AQ12 to AQ14 answered | Attorney AQ12 to 14, processor terms |
| **Payment-terms settings screen** | **Build it before the flag goes on** (Q54, Q68): owner or admin edits, reps read-only, a "ready / not ready" line, same bounds as the server. Otherwise the only way to set `deckingPerSheetCents` is by hand in Firestore, which is risky and, for a prod write, needs Jo's explicit approval (standing rule f) | A short build |
| **Signing-ease lane order** | Proposed: (1) QR / link panel with new-link button (Q48, Q59, Q60); (2) automatic signed-PDF email to homeowner and rep on every path (Q50, Q64) and 14-day links with email reminders (Q61); (3) paper-signed certification (Q49, Q63); (4) second-owner signer (Q52); (5) server-only "signed" status (Q65); (6) the signing packet (Q66, Q73). Q67 says this lane runs before the attic phase, but the attic branch already exists: merge it dark and keep it off | Decision only |
| **The CI budget** | Merge `chore/ci-manifest-budget` (raises the unit-suite budget to 11 minutes and the job timeout to 14) **before** merging the attic branch, because the attic branch adds five test files and its own note leaves the 8-minute budget unchanged | One small merge |
| **What "done" means** | See the table below | n/a |
| **Old templates still on legacy wording** | See the list below | n/a |

**What done means, per phase**

| Phase | Done when |
| --- | --- |
| 1 Evidence and clause foundation | Merged, flag off, a signed record on each path carries version, digest and consent, a blank-field contract cannot send. Done (PR 3173). Not "on" until review |
| 2 Clause set v1 | Merged, flag off, byte-identical when off (golden hashes). Done (PR 3182, 3183). Prints only after attorney review |
| 3 Attic form and gate | Branch merged; re-roof contract cannot send without the signed form or the not-inspected page or a recorded override; tests green; dry run on a test lead; the in-person path's limits written down (it is **not** enforced at the moment of signing) |
| 4 Payment | Terms-of-Payment section on invoice and Payment Agreement pointing to the contract; card fee works only on credit, never on Kentucky insurance; the stray "A convenience fee may apply." line gone; deposit and estimate suites green |
| 5 Remaining templates | Each renders from the module, signs on every path, has its own golden-text test |
| 6 Attorney pass and flag on | Attorney sign-off recorded in the sweep note; flags on for Jo's account only, after a dry run (Q57) |

**Templates still on legacy wording (from the clause-set note, phase 4 and 5 lists, and the lane handoff):** the invoice and the Payment Agreement beyond the new late-terms pointer (the 1.5% "finance charge" line and the stray convenience-fee text remain with the flag off); proposal; scope; change order; warranty certificate; Certificate of Completion; material delivery; the four lien-waiver forms; plus four left-alone deletions (the warranty signature caption, the "Final walkthrough passed." default, the "Insurance Claim Assistance" intro default, the care-plan "cancel anytime" line); `docs/pro/terms.html` ("sole proprietorship"); and everything on any contract signed with the flag off. Not yet built at all: property condition, decking authorization, emergency tarp request, final walkthrough and punch list, Ohio insurance acknowledgment.

---

## 4. One-page "accept all" checklist

Tick one box per line. On legal lines, ACCEPT means "send this as our position to the attorney".

| Done | Item | ACCEPT | CHANGE |
| --- | --- | --- | --- |
| | **1a** soffit baffle $25 (flat package, see note A) | [ ] | [ ] |
| | **1a** bath-fan duct re-route $450 flat | [ ] | [ ] |
| | **1a** decking $100 per sheet, confirmed | [ ] | [ ] |
| | **1a** ridge vent and box vents stay hidden for now | [ ] | [ ] |
| | **1b** ask the rep the four questions; keep 15%, lesser-of | [ ] | [ ] |
| | **1c** file the Kentucky assumed name, then the county clerk copy | [ ] | [ ] |
| | **1d** ask the attorney the two Ohio questions; file nothing in Ohio yet | [ ] | [ ] |
| | **1e** the eleven payment numbers as defaulted | [ ] | [ ] |
| | **1f** enter mailing address; read signer title on a test contract | [ ] | [ ] |
| | **Sec 2** first contracts: Ohio, cash or check, under $25,000, no financing, no insurance | [ ] | [ ] |
| | AQ1 Ohio late interest as drafted | [ ] | [ ] |
| | AQ2 Kentucky late interest 8% | [ ] | [ ] |
| | AQ3 no flat late fee | [ ] | [ ] |
| | AQ4 mutual fees, no percentage collection fees | [ ] | [ ] |
| | AQ5 four or fewer milestones, no "finance charge" | [ ] | [ ] |
| | AQ6 no 50% deposit near $25,000 in Ohio | [ ] | [ ] |
| | AQ7 Kentucky insurance: nothing at signing | [ ] | [ ] |
| | AQ8 cancellation packet on every contract | [ ] | [ ] |
| | AQ9 no tarp inside the window | [ ] | [ ] |
| | AQ10 Ohio $25,000 contents; PAY-4, PAY-5 as drafted | [ ] | [ ] |
| | AQ11 right to pause, weather-tight first | [ ] | [ ] |
| | AQ12 card fee stays OFF | [ ] | [ ] |
| | AQ13 no card fee on Kentucky insurance | [ ] | [ ] |
| | AQ14 returned-payment sentence (or delete it) | [ ] | [ ] |
| | AQ15 restocking lesser-of | [ ] | [ ] |
| | AQ16 decking flat price up to 10 sheets | [ ] | [ ] |
| | AQ17 no financed jobs yet | [ ] | [ ] |
| | AQ18 liens run on an internal calendar | [ ] | [ ] |
| | AQ19 no Kentucky insurance lien, deductible included | [ ] | [ ] |
| | AQ20 lien clauses with no waiver wording | [ ] | [ ] |
| | AQ21 reservation only, no notice | [ ] | [ ] |
| | AQ22 sub paperwork by hand for now | [ ] | [ ] |
| | AQ23 mediation first, no arbitration | [ ] | [ ] |
| | AQ24 no cure clause | [ ] | [ ] |
| | AQ25 property-state law and county venue | [ ] | [ ] |
| | AQ26 no shortened claim period | [ ] | [ ] |
| | AQ27 specific-item limits only | [ ] | [ ] |
| | AQ28 warranty as drafted | [ ] | [ ] |
| | AQ29 schedule, access, permits, selections as drafted | [ ] | [ ] |
| | AQ30 supplements: documentation only | [ ] | [ ] |
| | AQ31 attic acknowledgment, ticks plus signature | [ ] | [ ] |
| | AQ32 not-inspected page, free check 3 days before | [ ] | [ ] |
| | AQ33 decline jobs where the homeowner will not sign | [ ] | [ ] |
| | AQ34 "fully insured" only, never "licensed" | [ ] | [ ] |
| | AQ35 file the d/b/a before using it | [ ] | [ ] |
| | AQ36 ask about Ohio foreign-LLC registration | [ ] | [ ] |
| | AQ37 signature block as drafted; fix terms.html | [ ] | [ ] |
| | AQ38 use the remote link path for real contracts | [ ] | [ ] |
| | AQ39 notices stay on the page | [ ] | [ ] |
| | AQ40 keep records 10 years | [ ] | [ ] |
| | AQ41 optional photo box | [ ] | [ ] |
| | AQ42 texting consent at contracting | [ ] | [ ] |
| | **Sec 3** attic flag last, after the seven items | [ ] | [ ] |
| | **Sec 3** flags for Jo only, not reps | [ ] | [ ] |
| | **Sec 3** card fee not yet | [ ] | [ ] |
| | **Sec 3** build the settings screen before the flag | [ ] | [ ] |
| | **Sec 3** signing-ease order as listed | [ ] | [ ] |
| | **Sec 3** merge the CI budget branch first | [ ] | [ ] |

**Not verified in this sheet:** every web fact marked OFFICIAL-SEARCH-ONLY or SECONDARY; the original Kentucky assumed-name fee and whether it can be filed online; the Ohio fees; the generate()-based manifest fix; whether the saved signer title reads "Manager"; the baffle and duct prices (judgment, retail only). Nothing in the law rows was re-researched; they restate the law memo's tags.
