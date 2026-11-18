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

`lateGraceDays` 15, `lateInterestPct` 8, `disputeDays` 10, `finalPaymentDays` 7, `punchListDays` 3, `pauseNoticeDays` 5, `restockPct` 15, `cardFeePct` 0, `deckingPerSheetCents` null, `deckingSheetsBeforeChangeOrder` 10, `atticFreeCheckDays` 3 (phase 3), `claimNoticeDays` 30. Defaults live in `company-profile.js` and `clause-set.js NBD_PAYMENT_TERMS_DEFAULTS` (a test pins them equal). Clauses read these; no number is typed into a clause. A tenant other than NBD gets them **blank** (`_legal()` keeps only the fields it changed from NBD's; the server uses NBD's numbers only for the NBD tenant), so another company's paper never prints NBD's numbers.

A clause that needs a number that is unset: the text keeps a visible `{{field}}` token (never an invented number) and the send gate refuses with **"Set <field> in Company Profile."** (client `_docSendGate`, `sendEstimateEnvelope` and the PDF builder, deal-page mint). **`deckingPerSheetCents` is null by design (the $100 is Jo's unconfirmed estimate), so every contract is refused until it is set.** `cardFeePct` 0 is a valid "off": the card-fee paragraph and the card-fee refund paragraph of PAY-7 are omitted, so no document promises a fee the system does not charge; they never print on Kentucky insurance jobs.

## Party block

"No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions", "By: Joe Deal, Manager" (from `brand.entityName`, `dbaName`, `signerTitle`; Joe Deal is NBD's signer only). NBD is defined once, as the Contractor. For another tenant: its own entity, a blank "By: ______, <its title>" line, and the defined term "NBD" is replaced by "Contractor" in every clause: **no NBD name prints**. That tenant PARTY-1 sentence and the substitution are mechanical adaptations, not the packet's words.

## Evidence

Every printed clause id is recorded. The contract HTML carries a comment `<!-- nbd:clause-set VERSION ref,ref,... -->`; the server reads it back (`doc-evidence.js stampFor(..., { html })`, used by remote-link mint and in-person recording), keeps only refs the registry knows, and adds them to the shipped statutory refs. The e-sign envelope records the refs the PDF builder returns; the deal page records the refs snapshotted on the token. The existing 60-id cap holds (the longest set is about 50).

## Packet versus code

- The shipped `PAYMENT_CLAUSE` has a curly apostrophe ("Homeowner’s"); the packet has a straight one. The shipped constant controls (as the packet says).
- The packet's PAY-7 "ways to pay" paragraph and the card-fee text assume the fee exists; until phase 4, `cardFeePct` stays 0.
- The packet cites internal ids in text (CANC-1, CO-2...); they print as the small labels above, so the references resolve.
- MAT-1(f) "14 days" and the CO-2 "up to 10 sheets" are printed as the packet has them; the 14 is not in the config list (a drafting default).

## NOT done

- The attic form and its gate (phase 3); `atticFreeCheckDays` is config only.
- The card-fee mechanism, invoices, receipts, the Payment Agreement and the 1.5% line there (phase 4). Other templates: proposal, scope, change order, warranty certificate, Certificate of Completion, material delivery, lien waiver (phase 5).
- No Company Profile screen for the `paymentTerms` fields yet (set them on `companyProfile/{companyId}.paymentTerms`); another tenant cannot clear the gate from the app, so keep the flag off for other tenants until it exists.
- Remote-link and in-person server checks scan the stored page for leftover tokens only when `docEvidenceFoundation` is also on.
- **Attorney review of every clause is pending.**

Tests: `tests/clause-set-v1-2026-11-18.test.js` (golden flag-off hashes, registry equals the packet fixture `tests/fixtures/attorney-packet-2026-11-18.md`, variants, config, banned phrases, contract, PDF, deal page).
