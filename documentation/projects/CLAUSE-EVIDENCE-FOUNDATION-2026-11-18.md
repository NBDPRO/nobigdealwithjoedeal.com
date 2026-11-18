# Clause and evidence foundation (phase 1), 2026-11-18

Phase 1 of the template/liability overhaul (the template deep sweep, branch `docs/template-deep-sweep`, Part 7, [CONTRACT-LANGUAGE-INVENTORY-2026-10-13](CONTRACT-LANGUAGE-INVENTORY-2026-10-13.md) sections 1, 3.4 and 7, [CONTRACT-STRENGTHENING-PLAN-2026-10-13](CONTRACT-STRENGTHENING-PLAN-2026-10-13.md) Part C). It adds **no new legal wording** and changes **no customer-facing text** except one dark checkbox (below). New contracts only; nothing already signed changes.

## What shipped

**A. Clause registry.** `docs/pro/js/clause-set.js` and its byte-identical twin `functions/clause-set.js` (`window.NBDClauseSet`). `CLAUSE_SET_VERSION` = `CS-2026-11-18.1`. Six clauses, all read from `ky-insurance-law.js`, none retyped: `PAYMENT`, `FTC_COOLING_OFF`, `KY_HOME_SOLICITATION`, `KY_INS_NOTICE_CANCEL`, `KY_INS_NOTICE_NO_ASSIGNMENT`, `KY_INS_LIEN` (refs like `PAYMENT_V1`). `describeFor({state, paymentSource})` lists the ones a document carries; an unknown state or source gets the strict Kentucky-insurance set. Nothing prints from the registry yet; the browser does not load it (phase 2 does).

**B. Evidence on every path.** Shared server helper `functions/doc-evidence.js` (`buildEvidence`, `stampFor`, `requestFacts`). IP and user agent are read from the server request, never the body.

| Path | Where the evidence is written | Fields |
| --- | --- | --- |
| Envelope e-sign (incl. server estimate PDF) | `esign_envelopes/{id}` at send, copied into each `signers[]` record at signing | `clauseSetVersion`, `clauseIds`, `documentSha256` (= `sourceSha256`), existing consent text, `signedAt`, `ip`, `ua` |
| Deal room | `deal_rooms/{id}.acceptedEvidence` | `clauseSetVersion` (in the acceptance transaction), `clauseIds`, `documentSha256` (= `pageSha256`, read from the sign token inside the acceptance transaction; see review follow-ups), `documentSha256Source`, `mintedPageSha256`, `consentSource`; consent text, `at`, `ip`, `ipSource`, `ua` already existed or were added |
| Remote HTML link | `leads/{id}/documents/{id}.signatureEvidence` (admin write in `submitSignature`) | `path`, `clauseSetVersion`, `clauseIds`, `documentSha256` (digest of the document served), `signedSha256`, `consent`, `signedAtMs`, `ip`, `ua` |
| In-person | same field, written by the existing `recordInPersonSignature` callable (flag on) | same shape, but `documentSha256` is **null** (the server never saw the document the homeowner was shown); `signedCopySha256` (= `signedSha256`) is the server's digest of the signed copy the rep's device saved; `signedAtMs` is **server time** at the call, `signedAtClientReported` is the row's own browser-set time, `presentedSha256ClientReported` is the client's own pre-signing digest, all labelled as client-reported; `attests: 'rep_device_and_time_only'` |

Rules: `leads/*/documents.signatureEvidence` is server-owned (a client cannot create a row with it or change it); `deal_rooms.acceptedEvidence` is now locked once a deal is closed. `esign_envelopes` was already admin-write only. Emulator test: `tests/firestore-rules.doc-evidence-2026-11-18.test.js`.

**C. Fail-closed send checks.** Shared module `doc-send-checks.js` (twin pair). Refuses a contract, proposal, work authorization or e-sign estimate PDF with a blank price (priced types), property address, homeowner name, company mailing address (when the document carries the cancellation packet), legal entity name, start or completion (contract only), or any `[Bracket Placeholder]` / `{{token}}`. Enforced in `NBDDocGen.generate` (fields, then rendered text) and asked first by the pre-flight modal; that browser gate is **UX only**. The server runs the gap check itself (review follow-ups below): `createSignRequest` (stored document, lead, company profile, primary estimate), `sendEstimateEnvelope` and `buildEstimateContractPdf` (`failClosed`), `createEsignEnvelope` (party facts only, the PDF is opaque) and `recordInPersonSignature`. Blank previews are exempt.

**D. Legal-entity fields.** `brand.entityName` ("No Big Deal Solutions LLC"), `brand.dbaName` ("No Big Deal Home Solutions"), `brand.signerTitle` ("Manager") in the NBD defaults, blanked for other tenants (`_IDENTITY_TOP`). Nothing prints them.

## The flag

`docEvidenceFoundation`, a per-person Firestore flag (`feature_flags/_default` or `feature_flags/{uid}`, only boolean `true` is on), **default OFF**, registered in `functions/flags-registry.js` `FIRESTORE_FLAGS`. It turns on: the send checks (client and server), the in-person evidence write, and the remote-link consent checkbox. The stamps that existing server writes make (clause set, digests) are additive and not gated. To turn on for Jo: set `docEvidenceFoundation: true` on `feature_flags/<Jo's uid>`. Before that, check Company Profile has a **Mailing Address**, since the cancellation forms need it (NBD's default is blank by design).

## Choices made

- In-person evidence is written server-side inside the existing `recordInPersonSignature` callable, not by a new function: it already trusts only ids and re-reads the saved document. Write-once, in a transaction that requires `signatureEvidence` to be absent.
- The in-person path has **no consent step** today, so it records consent as "not asked" (`agreed: null`), never as agreed. The remote link gets a checkbox using the e-sign envelope's existing consent sentence, shown only when the server sends it (flag on).
- Remote link digest is of the stored document as generated; the served copy has its cancellation notice re-dated, so the two differ only in that date.

## What this evidence does and does not prove

Read this before relying on a record in a dispute.

**It proves what the server observed, and when.** Every field below was written by the admin SDK from the request the server received and the bytes it read, never from a value the browser sent: the IP address (as the proxy chain reports it, with `ipSource` saying how it was derived), the user agent, the server clock time, the SHA-256 of the documents the server read, the clause-set version, and the consent sentence the server itself supplied. Firestore rules stop a client creating, changing or removing `signatureEvidence` and `acceptedEvidence`, and (since the review follow-ups) stop a client creating or setting any `accepted*` field on a deal room at all.

**Per path, what it does not prove:**

- **In-person.** It proves that a signed-in rep's device called `recordInPersonSignature` for this document at this server time from this address (`attests: 'rep_device_and_time_only'`). It does **not** prove that a homeowner signed, that the homeowner saw this document, or that the signature was captured when the row says: the row's own `signedAt`, `signedSigners`, the signature image and the client's `presentedSha256` all come from the rep's browser, and the evidence keeps them only labelled as client-reported. There is no homeowner-side consent step here, so consent is recorded as "not asked".
- **Deal room.** The consent tick (`consent`) is the page's own checkbox sent in the request body; the server cannot see whether it was ticked, so it is recorded with `consentSource: 'client_asserted'`. The document digest is the digest of the stored page recorded when a human last loaded the link (`documentSha256Source: 'served_at_view'`), else the page as minted (`'minted'`), else null with a reason code. It is a digest of the **stored page**, not of what the homeowner's screen rendered (the cancellation notice date is re-stamped on serve, and the rep can re-upload the page between views; `pageChangedSinceMint` flags that). A link-preview bot's fetch is not counted.
- **Remote link.** The digest is of the stored original that was served, not of what the signer's browser drew. The consent tick, when asked, is likewise sent by the browser.
- **E-sign envelope.** The digest is of the stored source PDF. The typed name and drawn signature are the signer's own input.
- **All paths.** The IP is only as reliable as the proxy-hop assumption in `functions/rate-limit.js` (`NBD_TRUSTED_PROXY_HOPS`, default 1 = the Google load balancer). Nothing in the repo sets that variable. Calls that reach a function through Firebase Hosting rewrites (for example `/deal/**`, `/api/deal-accept`) may pass through one more hop than a direct Cloud Functions call. **The production hop count has not been verified**; `ipSource` records `xff:hops=<n>:chain=<len>` or `socket` so a record shows what it assumed. Check a real request's `X-Forwarded-For` against the recorded address before relying on an IP.
- **Time.** Server time is Cloud Functions' clock at the call. For the in-person path it is the time of the recording call, not of the signing.

**Older gap, still open:** a rep can still set a document's `status` to `signed` (and `signedAt`, `signedSigners`) from the browser; Firestore rules lock a row once it reads signed, not the act of marking it. The in-person callable accepts such a row as the thing to record evidence against. Evidence on a row therefore shows what the server saw at recording time and nothing about whether the signing happened. Closing this means moving the in-person "mark signed" write behind the callable (phase 2).

## Review follow-ups (2026-11-18, security review of this branch)

Fixed here, each with a test in `tests/clause-evidence-foundation-2026-11-18.test.js` (sections R, R2 to R6, B2) or `tests/firestore-rules.doc-evidence-2026-11-18.test.js`:

- Deal rooms: no client create or update sets or changes `acceptedTier`, `acceptedPrice`, `acceptedFinancing`, `acceptedSignature`, `acceptedAt`, `acceptedVia` or `acceptedEvidence` (previously only a deal that was already closed was protected, so a rep could create or close a deal carrying a forged acceptance). Only `submitDealAcceptance` (admin SDK) writes them.
- The legacy top-level `/documents/{docId}` rule has the same `signatureEvidence` guard.
- The visible-text scan in `doc-send-checks.js` (twin pair) is linear and bounded: over 2 MB is refused with a clear message, a stray `<` cannot hide a placeholder, and the raw markup is scanned too.
- The gap check runs on the server (price from the primary estimate, address, homeowner name, mailing address, entity name, placeholders), on every send path above. Start date and estimated completion live only in the generator form, so the server does not check them (the placeholder scan still catches an unfilled token). With the flag on and `NBDDocSendChecks` missing, the browser gate now blocks with a message instead of allowing.
- A flag read that errors now fails the send gates closed (a retryable "unavailable" refusal), instead of reading as off. `flagForUid` keeps its old best-effort behaviour for code that only adds records. The remote-link consent decision is snapshotted on the sign token at mint (`consentAsked`) and used at view and submit; links minted before that field existed fall back to the flag as it stands.
- In-person evidence: `documentSha256` is no longer claimed; time is server time; `attests` says what it proves; the write is a transaction with a precondition that `signatureEvidence` is absent, and the client-writable `signedRemotely` no longer skips it.
- Deal-room digest comes from the token (page archived and digested at mint, digest of the served page recorded at view), not from a Storage read after acceptance. Tokens minted before this change record `documentSha256: null` with reason `no_archive_at_mint`. The clause refs are still added by a best-effort update after the commit (the clause-set version itself is in the transaction).
- Remote link: the document-row write after a saved signed copy is retried (3 tries with backoff); if it still fails the row gets `signedStampFailed`, the token `docStampFailed`, and the rep gets a bell and an activity row.

## NOT done

- No new clauses and nothing printed from the registry (phase 2). Legal party name and "By: Joe Deal, Manager" not printed.
- No consent step for in-person signing (needs the wording decision, Q25).
- No Company Profile form field for `entityName`, so a non-NBD tenant cannot clear that check: keep the flag off for other tenants until it exists.
- Start date and estimated completion are checked in the browser only (the server never sees the form data).
- The in-person gap check refuses to record a signed contract that has a gap; it cannot un-sign it, so the rep must fix the document and re-send. There is no in-person consent step.
- The deal-room digest still depends on the page the homeowner was served at view time, and the archive is of the page at mint; if the rep re-uploads the page after the homeowner viewed it and before they accept, the evidence says which page was served but the served bytes themselves are not archived.
- The production proxy-hop count for the IP is unverified (see above).
- Deal room is not in the fail-closed set. The signed certificate page does not print the clause-set version.
- Not deployed. Rules and callable changes are tested, not shipped.
