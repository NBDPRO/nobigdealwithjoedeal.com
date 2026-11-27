# Clause set v1 (phase 2), 2026-11-18

Phase 2 of the template/liability overhaul. Phase 1 ([CLAUSE-EVIDENCE-FOUNDATION-2026-11-18](CLAUSE-EVIDENCE-FOUNDATION-2026-11-18.md)) built the registry, the evidence and the send checks. Phase 2 **prints the clause set** on the contract-class signing paths. The wording is the attorney packet's section 3, verbatim (draft text, **attorney review pending**; nothing is in use with customers). New contracts only; nothing already signed changes. Plan: [TEMPLATE-DEEP-SWEEP-2026-11-17](TEMPLATE-DEEP-SWEEP-2026-11-17.md) Parts 5A and 7.

## The flag

`docClauseSetV1`, a per-person Firestore flag (`feature_flags/_default` or `feature_flags/{uid}`, only boolean `true` is on), **default OFF**, registered in `functions/flags-registry.js` `FIRESTORE_FLAGS`. **With it off every document renders byte-identical to before.** That is proven, not claimed: `tests/fixtures/clause-set-v1-golden.json` holds SHA-256 hashes of six contract variants, two proposals, two work authorizations and three e-sign PDFs, recorded from origin/main before any renderer changed (`tests/helpers/clause-v1-harness.js --print` regenerates them); the test compares today's render to them. The deal page adds nothing without the token field the flag writes.

**How to turn it on (for Jo):** (1) Company Profile has a Mailing Address; (2) set `docEvidenceFoundation: true` and `docClauseSetV1: true` on `feature_flags/<uid>`: turn on both, because the server send checks for remote-link and in-person signing are the first flag's; (3) set the decking price (below); (4) only after the attorney has reviewed the packet.

## Where it prints

| Path | How |
| --- | --- |
| Client contract (`renderContract`, `document-generator.js`); the in-person and remote HTML signing reuse this HTML | `_clauseV1On()` then `_clauseSetV1()`; slots in the template print the original markup when off |
| Server e-sign estimate PDF (`estimate-esign-pdf.js`) | `sendEstimateEnvelope` builds the set (`doc-evidence.js buildClauseSet`) and passes `clauseSet`; plain text, every paragraph tagged with its clause id |
| Deal page | `createDealAcceptToken` (flag on for the minting rep) builds the set, runs the gap check, and snapshots `clauseSetV1` {version, refs, html} on the token; `getDealRoom` injects the block before the Sign & Schedule section; `submitDealAcceptance` records the refs |

With the flag on the contradictory legacy clauses are **replaced, not stacked**: the "No cash payments" methods paragraph (PAY-7), the old change-order clause with "NBD reserves the right to adjust pricing" (CO-1), the cancellation clause citing KRS 367.390 (the cancellation notice packet already carries the state's text: CANC-1 by reference), the "mediation or binding arbitration under Kentucky law" clause (DISP-1, 3, 4), the entire-agreement clause (DISP-8). The invoice-only 1.5% "finance charge" line is on invoices and the Payment Agreement, which are **not** touched (phase 4). The shipped statutory blocks (KRS 367.624 notices, the cancellation forms and packet, the Payment clause, the KY lien sentence, the FTC statement) print exactly as before (tested byte for byte on a Kentucky insurance contract).

## Registry

- `clause-set-text.js` (browser copy + byte-identical `functions/` twin): the wording of 40 clauses, copied from the packet by script, each with an id, version 1, which job types it prints on and its variant parts. Numbers are `{{cfg:field}}` tokens. This file is on the outbound-template banned-phrase scan.
- `clause-set.js` (twin): `renderV1`, `variantOf`, `partyFor`, `paymentTermsFor`, `describeV1`. `CLAUSE_SET_VERSION` is now `CS-2026-11-18.2`.
- Variants: {OH, KY} x {cash, insurance, financed}. Unknown state or payment source = the strict Kentucky-insurance set. A state outside OH/KY reads as Ohio text. The packet has **no financed variant** for PAY-4 (AQ17); financed reads the cash text there, and the only financed-specific text is the PAY-6 lender sentence.
- By reference (never retyped): PAY-2 (the deposit rule's text in the payment schedule), WAR-4 (the package warranty section, tier settings), INS-1 (the shipped Payment clause), INS-3 and INS-4 (the KY notices and forms), LIEN-3 (the KY lien sentence), CANC-1 (the cancellation packet).
- Each paragraph prints with its clause id in small type, because the packet's text cross-refers by id ("under PAY-5", "except as CO-2 allows").
- **Not printed** (decision recorded): LATE-2 flat fee, DISP-2, DISP-5, DISP-7 (the packet's "prints nowhere"); INS-3 Ohio sentence and INS-5 on Ohio insurance (optional, not decided: left out); MAT-2 (not in the packet's contract matrix); PAY-3 (needs milestone facts the contract form does not collect: prints only when a caller passes milestones); the WAR-2 added attic line and the WAR-5 second sentence `{{who registers it and by when}}` (no source for either; they would print a raw token and refuse the send); DISP-6's "alternative" paragraph; PARTY-1's signature block is built from the brand, not typed.

## Config (Company Profile `paymentTerms`)

`lateGraceDays` 15, `lateInterestPct` 8, `disputeDays` 10, `finalPaymentDays` 7, `punchListDays` 3, `pauseNoticeDays` 5, `restockPct` 15, `cardFeePct` 0, `deckingPerSheetCents` null, `deckingSheetsBeforeChangeOrder` 10, `atticFreeCheckDays` 3 (phase 3), `claimNoticeDays` 30. Defaults live in `company-profile.js` and `clause-set.js NBD_PAYMENT_TERMS_DEFAULTS` (a test pins them equal). Clauses read these; no number is typed into a clause. A tenant other than NBD gets them **blank** (`_legal()` keeps only the fields the tenant itself wrote, whatever the value; the server uses NBD's numbers only for the NBD tenant), so another company's paper never prints NBD's numbers.

A clause that needs a number that is unset: the text keeps a visible `{{field}}` token (never an invented number) and the send gate refuses with **"Set <field> in Company Profile."** (client `_docSendGate`, `sendEstimateEnvelope` and the PDF builder, deal-page mint). **`deckingPerSheetCents` is null by design (the $100 is Jo's unconfirmed estimate), so every contract is refused until it is set.** `cardFeePct` 0 is a valid "off": the card-fee paragraph and the card-fee refund paragraph of PAY-7 are omitted, so no document promises a fee the system does not charge; they never print on Kentucky insurance jobs.

## Party block

"No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions", "By: Joe Deal, Manager" (from `brand.entityName`, `dbaName`, `signerTitle`; Joe Deal is NBD's signer only). NBD is defined once, as the Contractor. For another tenant: its own entity, a blank "By: ______, <its title>" line, and the defined term "NBD" is replaced by "Contractor" in every clause: **no NBD name prints**. That tenant PARTY-1 sentence and the substitution are mechanical adaptations, not the packet's words.

## Evidence

Every printed clause id is recorded. The contract HTML carries a comment `<!-- nbd:clause-set VERSION ref,ref,... -->`; the server treats it as a hint only (`doc-evidence.js stampFor(..., { html, v1 })`, used by remote-link mint and in-person recording): it recomputes the refs and records the marker's only when they agree (see Review fixes, item 4). The e-sign envelope records the refs the PDF builder returns; the deal page records the refs snapshotted on the token. The existing 60-id cap holds (the longest set is about 50).

## Packet versus code

- The shipped `PAYMENT_CLAUSE` has a curly apostrophe ("Homeowner’s"); the packet has a straight one. The shipped constant controls (as the packet says).
- The packet's PAY-7 "ways to pay" paragraph and the card-fee text assume the fee exists; until phase 4, `cardFeePct` stays 0.
- The packet cites internal ids in text (CANC-1, CO-2...); they print as the small labels above, so the references resolve.
- MAT-1(f) "14 days" and the CO-2 "up to 10 sheets" are printed as the packet has them; the 14 is not in the config list (a drafting default).

## NOT done

- The attic form and its gate (phase 3); `atticFreeCheckDays` is config only.
- The card-fee mechanism, invoices, receipts, the Payment Agreement and the 1.5% line there (phase 4). Other templates: proposal, scope, change order, warranty certificate, Certificate of Completion, material delivery, lien waiver (phase 5).
- No Company Profile screen for the `paymentTerms` fields yet (set them on `companyProfile/{companyId}.paymentTerms`); another tenant cannot clear the gate from the app, so keep the flag off for other tenants until it exists.
- Remote-link and in-person server checks scan the stored page for leftover tokens when `docEvidenceFoundation` or `docClauseSetV1` is on.
- **Attorney review of every clause is pending.**

Tests: `tests/clause-set-v1-2026-11-18.test.js` (golden flag-off hashes, registry equals the packet fixture `tests/fixtures/attorney-packet-2026-11-18.md`, variants, config, banned phrases, contract, PDF, deal page).

## Review fixes (independent security review, 2026-11-18)

Ten findings fixed on this branch; tests in `tests/clause-set-v1-review-2026-11-18.test.js` (node bucket) and `tests/firestore-rules.clause-set-v1-review-2026-11-18.test.js` (emulator, own CI step).

1. **Cancellation wording and by-reference clauses.** Audited per variant. The legacy "Cancellation & Rescission Rights" section is replaced, never stacked, and **no variant lacks right-to-cancel wording**: every v1 client contract (OH and KY, cash, insurance, financed, unknown) carries the Notice of Right to Cancel packet (`cancelPacketHtml`: "you can cancel it within three business days without any penalty or obligation", the how-to-cancel steps with the 10-business-day refund sentence, the FTC statement, the two FTC cancellation forms); Kentucky adds the KRS 367.430 text; Kentucky or unknown-state insurance adds the KRS 367.624 notices and the second cancellation form. The server e-sign PDF prints the FTC statement, the KRS 367.430 text on a Kentucky property and the two NOTICE OF CANCELLATION forms (Kentucky insurance is refused on that path). The deal page prints whatever the stored page carries (the packet is part of the page the rep generated); v1 adds the clause block and removes nothing. What was wrong was the evidence: by-reference refs were recorded by rule, not by what printed. Now `renderV1` takes `printed`: the client passes its own blocks, the PDF passes `pdfByRef` (payment clause, cancel forms, the deposit plan when there is one), the deal page passes `printedByRef` of the stored page text. A v1 contract is not built when the cancel packet is missing, and `NBDJurisdiction.cancelPacketHtml` is part of `_clauseV1On()`.
2. **Payment terms are blank by tenant identity, not by value.** `company-profile.js` keeps the tenant's raw `paymentTerms`; `_legal()` keeps what the tenant wrote (a tenant that chose 8% or 15 days keeps it) and blanks the rest. Client and server read the same tenant the same way.
3. **Bounds and types.** `numOk` (both twins) takes a real number only, with per-field sanity bounds (percent 0-100, card fee 0-10, days integer 0-365, decking cents integer 0-100000, sheets integer 1-200). These are sanity bounds, **not the legal ceilings; counsel decides interest caps.** `firestore.rules` `companyProfile/{id}` enforces the same on create and update (no strings, booleans, arrays, NaN or unknown keys). Nothing but the client writes `paymentTerms`.
4. **Forgeable marker.** The `<!-- nbd:clause-set ... -->` comment in rep-stored HTML is a hint. `stampFor` recomputes the refs on the server from the lead (state, payment source), the registry's current wording versions and the document text. The marker must agree, carry the current `CLAUSE_SET_VERSION`, and the clause flag must have been on; otherwise only the legacy statutory refs are recorded and the evidence gets `clauseRefsMismatch: true`. PAY-2 and WAR-4 (the template's own sections) may be absent from a marker without being a mismatch.
5. **Wording file missing.** `renderV1` throws on an empty clause table; `_clauseV1On()` requires the wording, the registry and the cancel packet module. With the flag on and any of them missing the send gate refuses ("The clause wording did not load") and the contract renders in full legacy form, never with sections dropped. `clause-set-text.js` and `clause-set.js` load in the same `docgen` loader group, wording first; only `customer.html` and `dashboard.html` render contracts and both use that group.
6. **Server gate.** `createSignRequest` and `recordInPersonSignature` run the unresolved-number and placeholder gate when `docEvidenceFoundation` **or** `docClauseSetV1` is on (strict reads; a read error refuses). The consent checkbox stays `docEvidenceFoundation`'s.
7. **`{{...}}` in user data.** Server `_fill` and client `mergeFields` are single-pass; `NBD -> Contractor` runs on the template before names go in; a `{{` in a name, address, phone or line item gets a zero-width space between the braces so it neither expands nor trips the placeholder scan. A `[Capitalised]` word typed into a name still reads as a placeholder (not changed).
8. **Deal page digest.** The minted block carries `clauseSetV1.sha256`; `getDealRoom` re-checks it and refuses a mismatch; `acceptedEvidence.clauseSetSha256` records it. The block is capped (300 KB, far under the 1 MiB document limit). `deal_accept_tokens` is `allow read, write: if false` (rules test: a rep update is denied).
9. **Key-less leads.** A lead with neither `companyId` nor `userId` fails the v1 build (`buildClauseSet` throws; callers get a failed-precondition) instead of reading as NBD.
10. **Tests** that NBD with every default but `deckingPerSheetCents` set is ready (`missing` is empty, the contract renders, the gate passes) and with it null is refused with "Set deckingPerSheetCents in Company Profile."

Known, unchanged: the e-sign PDF path prints none of the KRS 367.624 notices because Kentucky insurance is refused there (`KY_REFUSAL`); the client-side build does not check a lead key (it uses the signed-in brand).

## Before the flag goes on (checklist)

1. **Set `deckingPerSheetCents`** (Jo's number) and confirm every other `paymentTerms` field in `companyProfile/{companyId}.paymentTerms`. NBD's other eleven numbers default; a missing one refuses the send with its name.
2. **There is no Company Profile screen for `paymentTerms` yet.** The numbers can only be written on the Firestore document by hand (the rules above bound them). **Next task: build that screen** (the same fields, the same bounds). Until it exists another tenant cannot clear the gate from the app, so keep the flag off for other tenants.
3. **Turn on `docEvidenceFoundation` and `docClauseSetV1` together** (`feature_flags/<uid>`): the first carries the consent checkbox and the evidence, the second the wording. The server gate runs on either, but the consent step is the first flag's.
4. **Counsel reviews the clause text** (the attorney packet, section 3, is draft text; nothing is in use with customers) **and the interest values** (`lateInterestPct` 8 is a default, the bounds are sanity checks, not legal ceilings).
5. **Keep it off for every other tenant** until item 2 is built.

## Preview findings (Jo's review of the v1 Roofing Contract, 2026-11-18)

Flag ON only; flag off stays byte-identical (the golden hashes are untouched). Tests: `tests/contract-v1-preview-findings-2026-11-18.test.js`.

1. **Pledge.** WAR-6 is the one definition. With the flag on the Warranty Coverage box no longer prints "we'll come back and make it right" (and its heading reads "Preferred: 10-Year Workmanship", not "NBD Pledge + ..."); the tier, labor and manufacturer lines stay.
2. **Signature block.** Each label sits above its own line ("Homeowner", "Contractor"; a second Homeowner reads "Homeowner (co-owner)"); the legal-party caption ("<entity> d/b/a <name> - By: Joe Deal, Manager") sits directly under the contractor line. `data-nbd-sig` roles, `data-label` and `data-required` are unchanged, so the signing widget and `rebuildSignedRecord` work as before.
3. **Cancel notice seller.** With the flag on the notice and forms name the contract's legal party (`partyFor().nameLine`: NBD's entity and d/b/a; a tenant's own entityName/dbaName, else its legalName). Statutory wording is unchanged. The server e-sign PDF still takes its seller name from `esign-envelope.js` (`ESL.senderName`); not changed here.
4. **Clause ids** no longer print (HTML or the e-sign PDF). `data-clause` and the `<!-- nbd:clause-set -->` marker stay. The attic-gate manifest allowlist is not on main, so no hiding CSS was used: the text is not emitted. **Open for counsel:** four clauses still cite other clauses by id in their wording (LATE-1 "under PAY-5", CO-1 "except as CO-2 allows", SCH-1 "(CANC-1)", DISP-6 "the notice in SCH-2"), which a customer can no longer look up.
5. **KY cash showed the KY insurance box: cause.** Not the real generate path (a Kentucky cash lead already printed KRS 367.4xx text and no insurance notices). "Preview blank template" (`_blankifyDocData`) replaced empty claim number / carrier / address with bracket placeholders, and `NBDJurisdiction.classify` reads any claim number or carrier as an insurance signal, so every blank preview was an insurance job of unknown state. `_jurisdiction` now blanks those bracket placeholders for a blank preview, so the lead's own state, address, job type and claim decide; a lead with no facts at all keeps the strict clause-set variant.
