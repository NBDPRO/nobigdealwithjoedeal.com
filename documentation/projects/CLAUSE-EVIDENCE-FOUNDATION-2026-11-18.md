# Clause and evidence foundation (phase 1), 2026-11-18

Phase 1 of the template/liability overhaul (the template deep sweep, branch `docs/template-deep-sweep`, Part 7, [CONTRACT-LANGUAGE-INVENTORY-2026-10-13](CONTRACT-LANGUAGE-INVENTORY-2026-10-13.md) sections 1, 3.4 and 7, [CONTRACT-STRENGTHENING-PLAN-2026-10-13](CONTRACT-STRENGTHENING-PLAN-2026-10-13.md) Part C). It adds **no new legal wording** and changes **no customer-facing text** except one dark checkbox (below). New contracts only; nothing already signed changes.

## What shipped

**A. Clause registry.** `docs/pro/js/clause-set.js` and its byte-identical twin `functions/clause-set.js` (`window.NBDClauseSet`). `CLAUSE_SET_VERSION` = `CS-2026-11-18.1`. Six clauses, all read from `ky-insurance-law.js`, none retyped: `PAYMENT`, `FTC_COOLING_OFF`, `KY_HOME_SOLICITATION`, `KY_INS_NOTICE_CANCEL`, `KY_INS_NOTICE_NO_ASSIGNMENT`, `KY_INS_LIEN` (refs like `PAYMENT_V1`). `describeFor({state, paymentSource})` lists the ones a document carries; an unknown state or source gets the strict Kentucky-insurance set. Nothing prints from the registry yet; the browser does not load it (phase 2 does).

**B. Evidence on every path.** Shared server helper `functions/doc-evidence.js` (`buildEvidence`, `stampFor`, `requestFacts`). IP and user agent are read from the server request, never the body.

| Path | Where the evidence is written | Fields |
| --- | --- | --- |
| Envelope e-sign (incl. server estimate PDF) | `esign_envelopes/{id}` at send, copied into each `signers[]` record at signing | `clauseSetVersion`, `clauseIds`, `documentSha256` (= `sourceSha256`), existing consent text, `signedAt`, `ip`, `ua` |
| Deal room | `deal_rooms/{id}.acceptedEvidence` | `clauseSetVersion` (in the acceptance transaction), `clauseIds`, `documentSha256` (= `pageSha256`); consent text, `at`, `ip`, `ua` already existed |
| Remote HTML link | `leads/{id}/documents/{id}.signatureEvidence` (admin write in `submitSignature`) | `path`, `clauseSetVersion`, `clauseIds`, `documentSha256` (digest of the document served), `signedSha256`, `consent`, `signedAtMs`, `ip`, `ua` |
| In-person | same field, written by the existing `recordInPersonSignature` callable (flag on) | same shape; `signedSha256` is the server's digest of the stored signed copy; `presentedSha256ClientReported` is the client's own pre-signing digest, labelled as such |

Rules: `leads/*/documents.signatureEvidence` is server-owned (a client cannot create a row with it or change it); `deal_rooms.acceptedEvidence` is now locked once a deal is closed. `esign_envelopes` was already admin-write only. Emulator test: `tests/firestore-rules.doc-evidence-2026-11-18.test.js`.

**C. Fail-closed send checks.** Shared module `doc-send-checks.js` (twin pair). Refuses a contract, proposal, work authorization or e-sign estimate PDF with a blank price (priced types), property address, homeowner name, company mailing address (when the document carries the cancellation packet), legal entity name, start or completion (contract only), or any `[Bracket Placeholder]` / `{{token}}`. Enforced in `NBDDocGen.generate` (fields, then rendered text), asked first by the pre-flight modal, re-checked on the server in `sendEstimateEnvelope` and `buildEstimateContractPdf` (`failClosed`), and `createSignRequest` re-scans the stored contract for placeholders. Blank previews are exempt.

**D. Legal-entity fields.** `brand.entityName` ("No Big Deal Solutions LLC"), `brand.dbaName` ("No Big Deal Home Solutions"), `brand.signerTitle` ("Manager") in the NBD defaults, blanked for other tenants (`_IDENTITY_TOP`). Nothing prints them.

## The flag

`docEvidenceFoundation`, a per-person Firestore flag (`feature_flags/_default` or `feature_flags/{uid}`, only boolean `true` is on), **default OFF**, registered in `functions/flags-registry.js` `FIRESTORE_FLAGS`. It turns on: the send checks (client and server), the in-person evidence write, and the remote-link consent checkbox. The stamps that existing server writes make (clause set, digests) are additive and not gated. To turn on for Jo: set `docEvidenceFoundation: true` on `feature_flags/<Jo's uid>`. Before that, check Company Profile has a **Mailing Address**, since the cancellation forms need it (NBD's default is blank by design).

## Choices made

- In-person evidence is written server-side inside the existing `recordInPersonSignature` callable, not by a new function: it already trusts only ids and re-reads the saved document. Write-once.
- The in-person path has **no consent step** today, so it records consent as "not asked" (`agreed: null`), never as agreed. The remote link gets a checkbox using the e-sign envelope's existing consent sentence, shown only when the server sends it (flag on).
- Remote link digest is of the stored document as generated; the served copy has its cancellation notice re-dated, so the two differ only in that date.

## NOT done

- No new clauses and nothing printed from the registry (phase 2). Legal party name and "By: Joe Deal, Manager" not printed.
- No consent step for in-person signing (needs the wording decision, Q25).
- No Company Profile form field for `entityName`, so a non-NBD tenant cannot clear that check: keep the flag off for other tenants until it exists.
- Structured checks (price, name, dates) run on the client for the HTML paths; the server re-checks only the rendered text there.
- Deal room is not in the fail-closed set. The signed certificate page does not print the clause-set version.
- Not deployed. Rules and callable changes are tested, not shipped.
