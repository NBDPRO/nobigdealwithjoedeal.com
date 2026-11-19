# Paper certification and signing ease, 2026-11-18

The signing-ease lane Jo approved in [TEMPLATE-DEEP-SWEEP-2026-11-17](TEMPLATE-DEEP-SWEEP-2026-11-17.md) (decisions Q49, Q51, Q52, Q62, Q63), built on [CLAUSE-EVIDENCE-FOUNDATION-2026-11-18](CLAUSE-EVIDENCE-FOUNDATION-2026-11-18.md) and [CLAUSE-SET-V1-2026-11-18](CLAUSE-SET-V1-2026-11-18.md). Everything here is behind the existing per-person flag **`docClauseSetV1`** (default OFF). With it off every document and every flow is byte-identical: the phase 2 golden hashes pass untouched, and `tests/fixtures/paper-cert-signers-golden.json` pins the five Q51 documents the same way (recorded from origin/main before any template changed). Tests: `tests/paper-cert-signers-2026-11-18.test.js` (node bucket) and `tests/firestore-rules.paper-cert-2026-11-18.test.js` (emulator, own CI step).

## What shipped

### 1. Paper certification (Q49, Q63)

The old paper path wrote a documents row with only the file, name, uploader and time, status `signed`, so it could not file the contract or move the job. Now, flag on:

- **Upload form.** Picking a scan or file asks what the paper is (contract, proposal, work authorization, change order, certificate of completion, other), which generated document it is the signed copy of (a list of this customer's documents of that type), the date the homeowner signed, and an optional witness. The form is `docs/pro/js/paper-cert.js`, loaded on demand with `ScriptLoader.load` (by the upload writer and by the generator): nothing is added to any page's boot path, and it is deliberately not in the eager `script-loader.js` list, the doc viewer or `role-gate.js` (the dashboard's shipped byte ceiling has no headroom: those files are unchanged). If the form cannot load, nothing is uploaded (it never falls back to "signed").
- **Status `wet_signed_uploaded`.** The row waits. The documents list reads **"Uploaded, not certified"** (it is not counted as signed) and offers **Certify signed copy**.
- **`attestWetSigned` (new callable, `functions/paper-cert.js` + `paper-cert-logic.js`).** Only the lead's owner or same-company staff (not a viewer) can call it, and only with the flag on for them (strict read). The SERVER writes `wetSignedAttestation {byUid, name, at, text}`, `wetSignedEvidence` (type, signing date, witness, the original's id and SHA-256, short digest, request IP and user agent), the signing date as `signedAt`, and moves the row to `signed`. Repeating the call changes nothing.
- **Filing.** A certified contract is filed through the same job-spine path the other signing paths use: `job-spine.js spineAfterWetSign` stamps `contractFiledAt` (`FILED_FIELD_BY_DOC_TYPE`) and records `contract_signed` through `recordJobEvent`, with the **original's** document id as the source id, so a contract signed on paper and also signed digitally counts once. A certified completion certificate stamps `cocFiledAt`; "other" files nothing. No second filing mechanism was written.
- **Rules.** `wetSignedAttestation` and `wetSignedEvidence` are server-owned like phase 1 evidence (no client create, change or remove), and a client cannot move a `wet_signed_uploaded` row out of that status. A certified row is a signed row and locks like one. Emulator tests cover each deny with a paired allow.
- **Printed copies.** A contract-class document (contract, proposal, work authorization) shows **"Document ID <id> - Digest <12 hex>"** at the foot of the copy the viewer shows and prints. The digest is the SHA-256 of the stored document, the same digest the signing paths record; the footer is added to the viewer copy only, so the stored original and every digest are unchanged. The document id is minted before the row is saved (the row is created under that id). Reopening an unsigned stored document from the list adds the same line.

### 2. Signable documents (Q51)

`NBDDocGen.defaultSignersFor(type)` seeds the pre-flight; flag off it answers exactly `DOCUMENT_TYPES[type].defaultSigners`.

| Document | Flag on |
| --- | --- |
| Supplement request | signers homeowner (**"Homeowner authorization"**) + rep, real signature blocks, an authorization paragraph above them |
| Insurance inspection report | homeowner signer **"Homeowner release"** under a release paragraph; the assessor line stays |
| Warranty certificate | defaultSigners homeowner + rep (its template already took the signers) |
| Before and after report | the empty "Homeowner Acknowledgment" line becomes **"Received on <date>"** with the homeowner signature (static line when no signers are seeded) |
| Lien waiver | stays rep-signed; "Send for signature" is not offered for a document only the company signs, and `createSignRequest` refuses it (strict flag read, only for such a document), so it is never emailed to the homeowner |

All of them go through the real generator and the signing widget (`data-nbd-sig` blocks).

### 3. Co-owners (Q52)

- The distinct role **`homeowner2`**, label **"Homeowner (co-owner)"**, required. It has its own saved-signature lookup (`leads/{id}/signatures/homeowner2`) and its own block in the signed record. Before, a second "homeowner" shared the first one's role and so the first one's saved signature.
- The pre-flight "Add signer" creates `homeowner2` when a homeowner is already present (and offers it directly). The lead had no co-owner field, so the **contract pre-flight has an optional "Second owner" name** (flag on), saved to the lead as `secondOwnerName`. Entering one adds the co-owner signer automatically; switching that signer off keeps the form open with the reason.
- **Send gate.** `doc-send-checks.js` (browser and functions twins) refuses a contract-class document when the lead lists a second owner and the signers have no `homeowner2` (`coOwner` gap). It runs in the browser gate, in `createSignRequest` and in `recordInPersonSignature` (the in-person path already requires every required signer to have signed).
- **Evidence.** When a signed copy carries a co-owner block, `signatureEvidence.signers` lists every finalized signature block the server reads in the stored copy (role, label, time), on the remote-link and in-person paths.

### 4. In-person consent (Q62)

- A bar the generator mounts over the doc viewer (`paper-cert.js mountConsent`; the viewer file itself is unchanged, and the bar leaves when the viewer closes) shows, above a contract-class document that has a homeowner signer, the registry's **ESIGN-1 sentence verbatim** (`NBDClauseSet.esignConsentText`, twin in `functions/`; another tenant reads "Contractor" for NBD) and a required **"I agree to sign electronically"** tick.
- The signing widget ignores strokes and "Use saved", and refuses to finalize, until it is ticked (the remote signing page never sends the lock message, so it is unaffected). The generator will not save a signing as signed without the tick.
- `recordInPersonSignature` records `consent {agreed: true, text: <the server's copy of ESIGN-1>, at}` and `consentSource: 'in_person_tick'` instead of "not asked". Without a tick the record stays "not asked".

## Drafter wording (every line is for the attorney to confirm; none is in use with customers)

Marked `// DRAFTER WORDING: attorney to confirm` in the source.

1. **Attestation sentence** (`paper-cert-logic.js ATTEST_TEXT`, mirrored in `paper-cert.js`): "I confirm that the uploaded paper document carries the homeowner's handwritten signature, and that it was signed on the date shown."
2. **Supplement request, "Homeowner authorization":** "I have read this supplement request. I authorize <company> to give a copy of it, with the photographs and documents listed above, to my insurance company." No claim-handling language, nothing about what the insurer will do.
3. **Insurance inspection report, "Homeowner release":** "I authorize <company> to send a copy of this inspection report to my insurance company." No coverage, outcome or payment words.
4. **Before and after, "Received":** "Received on <date>" (a receipt, no acknowledgment of quality).
5. The signer labels "Homeowner authorization", "Homeowner release" and "Homeowner (co-owner)".
6. The tick label "I agree to sign electronically" (the sentence under it is the packet's ESIGN-1, already in the attorney packet).

## What this does and does not prove

- Paper: the attestation proves that a signed-in rep or staff member of the company said, at that server time and from that address, that the uploaded paper carries the homeowner's signature on that date. It does not prove the homeowner signed. The original's digest is the server's own read of the stored original; the link to it is the rep's choice, checked only for the same lead and the same document type.
- In-person tick: the tick is made on the rep's device, so the server records it as `consentSource: 'in_person_tick'` and, like every field on that path, it proves only that the rep's device made the call (`attests: 'rep_device_and_time_only'`).

## NOT done

- **The signed PDF emailed to the homeowner on every signing path (Q50).**
- Reminders for unsigned documents.
- The estimate / deal link panel.
- **A server-only `signed` status.** A rep can still create or set a document row to `signed` from the browser (the old gap in the phase 1 note). Only the paper path's `wet_signed_uploaded` to `signed` move is server-owned, and a rep can still upload straight to `signed` with the old writer when the flag is off.
- The contract does not print the second owner's name (only the co-owner signature block); the homeowner name line is unchanged.
- Co-owner on the server e-sign PDF path and the deal page (they have their own signer lists).
- Browser-only behaviour is tested against stubs, not a real browser or phone: the consent bar layout, the locked canvas on a phone, the paper-signed form and the footer line on a printed page. Check them on an iPhone and a desktop before turning the flag on.
- Attorney review of all wording above is pending.

## To turn it on

Same switch as the clause set: set `docClauseSetV1: true` on `feature_flags/<uid>` (per person; the callable reads the caller's own flag). Reps who do not have it see no change.
