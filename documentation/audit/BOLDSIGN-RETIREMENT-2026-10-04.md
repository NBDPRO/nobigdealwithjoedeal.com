# BoldSign retirement — parity audit and the gaps closed (2026-10-04)

Jo: *"retire BoldSign as long as we're fully operational with our own."*
Lane F of [VENDOR-COST-LOCKIN-2026-10-04](https://github.com/NBDPRO/nobigdealwithjoedeal.com/blob/docs/vendor-cost-map/documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md)
(branch `docs/vendor-cost-map`), and the §641 finding of
[STABILITY-AUDIT-2026-09-04](STABILITY-AUDIT-2026-09-04.md): the two in-house
signing paths "are not interchangeable", so BoldSign could not simply be
switched off. This note is the parity audit, what was built to close it, and
what is still open.

Related: [SESSION-2026-09-06-esign-rebuild](../projects/SESSION-2026-09-06-esign-rebuild.md)
(where the envelope system came from) ·
[ESIGN-CRM-RECON-2026-09-06](ESIGN-CRM-RECON-2026-09-06.md).

---

## 1. Where BoldSign was used (all of it was dark)

Both BoldSign secrets were the deploy's `__unset__` stub, so none of this ever
ran in production. Nothing was ever signed through BoldSign by us.

| Place | What it did |
|---|---|
| `functions/integrations/esign.js` `sendEstimateForSignature` | Sent the CLIENT's retail-quote HTML to BoldSign with one signer, a signature box at fixed page-1 coordinates, auto-reminders every 2 days ×3, and requested an embedded signing URL |
| `functions/integrations/esign.js` `esignWebhook` | HMAC-verified BoldSign events → `estimates/{id}.signatureStatus` (sent/viewed/signed/declined/expired), `signedDocumentUrl`, and on "signed" ran **C5** `createStripeInvoiceForEstimate` (a platform-account Stripe draft invoice) |
| `functions/portal.js` `getHomeownerPortalView` | Minted a BoldSign embedded sign link for the homeowner portal (`signEmbedUrl`, iframe) |
| `docs/pro/js/estimate-v2-ui.js` `sendForSignature` | "✍️ Send for Signature" + Present → "Sign Now": rendered the retail quote, called the above, opened the embed in the doc viewer for in-person signing |
| `docs/pro/js/integrations-client.js` | `NBDIntegrations.sendForSignature`, gated on `configured.boldsign` |
| `functions/handlers/integrations.js`, `_shared.js` | `boldsign` / `boldsignWebhook` booleans, `BOLDSIGN_API_KEY` / `BOLDSIGN_WEBHOOK_SECRET`, `PROVIDERS.esign` (zero readers) |
| `firebase.json` | `frame-src https://app.boldsign.com` in 8 CSP headers |
| `docs/privacy.html` | BoldSign named as the e-signature sub-processor |

## 2. Parity — BEFORE (main at `3877ec9b`)

| Capability | BoldSign path (never keyed) | Envelope (`esign-envelope.js`) | Remote HTML sign (`remote-signing.js`) | Deal page "Sign on this phone" (`deal-acceptance.js`) |
|---|---|---|---|---|
| Remote send by link | ✓ BoldSign email | ✓ email + link | ✓ email | ✓ link (rep's phone sends) |
| In-person signing | ✓ embed in doc viewer | ~ link returned, nothing in the estimate flow opens it | ✓ doc-viewer pad | ✓ |
| Multi-signer | ✗ integration sent ONE signer | ✗ one token, one signer | ✗ | ✗ |
| Evidence: consent | BoldSign's own trail, not stored by us | ✓ once per envelope, consent text not stored | ✗ | ✗ |
| Evidence: IP / user agent | BoldSign's | ✓ once per envelope | ✗ | ✗ |
| Evidence: timestamps | BoldSign's | ✓ | ✓ signedAt | ✓ acceptedAt |
| Evidence: document hash | BoldSign's | ✓ source + signed SHA-256 | ✓ original + signed SHA-256 | ✗ |
| Certificate in the signed document | BoldSign's | ✗ | ✗ | ✗ |
| Signed PDF stored | BoldSign-hosted URL | ✓ `signed.pdf` | ✗ (signed HTML) | ✗ (signed page HTML) |
| Signed copy delivered to the homeowner | ✓ BoldSign email | ✗ (portal shelf only) | ✗ | ✗ |
| Reminders | ✓ 2 days ×3 | ✗ | ✗ | ✗ |
| Decline | ✓ webhook → declined | ✗ | ✗ | ✗ |
| Void | ✗ | ✓ | ✗ | ~ remove deal |
| Expiry shown | ✓ webhook → expired | ✗ envelope stayed "Sent" forever | ✗ | ✗ |
| Estimate status mirror | ✓ webhook | ✗ envelope not linked to the estimate | ✗ | deal status |
| KY right-to-cancel / FTC notice | ✗ (button hidden for KY insurance; no FTC form) | ✗ ([#2149](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2149) open) | ✓ generated contract carries them | ✓ deal page carries them |

**Gaps for the replacement (the envelope):** estimate entry point,
multi-signer, per-signer evidence + consent text + certificate, delivery of
the signed copy, reminders, decline, expiry, estimate mirror, the FTC notice
on the estimate contract. **Deal page:** no IP / UA / consent / page hash.

## 3. What was built (PR `chore/retire-boldsign`)

- **`sendEstimateEnvelope`** (esign-envelope.js) — the builder's Send for
  Signature. Builds the contract PDF on the SERVER from the SAVED estimate
  (`estimate-esign-pdf.js`: customer-facing retail rows via
  `customer-estimate-rows.js`, never cost; the deposit-plan stamp; the payment
  clause; the 16 CFR 429.1(a) statement by the signatures; two FTC Notice of
  Cancellation pages whose date + deadline are system fields filled with the
  signing date), places each signer's signature + date boxes, supersedes any
  older live envelope for the estimate, mirrors status onto the estimate.
  Refuses a Kentucky insurance job server-side (same `classifyLead` test as
  the builder, fail closed), no customer, no price, already signed.
- **Multi-signer** (`esign-logic.js`): up to 4 signers in order, each with
  their own single-use link; a signer sees and fills only their own fields
  (values for another signer's field are refused); a non-final signer's values
  wait in `esign-vault/` (no storage rule — no client, not even the rep) with
  their digest in the evidence; the last signature stamps every value onto the
  untouched source in one pass. Builder: an optional co-owner name + email.
- **Evidence per signer**: consent with the exact text shown, IP, user agent,
  first-view and signed times, typed legal name, SHA-256 of the submitted
  values; plus the source and signed SHA-256; a **signature certificate page**
  appended to the executed PDF prints all of it.
- **Delivery**: the signed PDF is emailed to every signer (attachment up to
  8 MB); the portal's estimate card links it; it files on the customer's
  Documents tab as before.
- **Decline** (`declineEsignEnvelope` + a Decline button on esign.html),
  **reminders + expiry** (`esignReminderSweep`, daily 10:00 ET; kill switch
  `ESIGN_REMINDERS_DISABLED`), **void** now also mirrors to the estimate.
- **Deal page evidence**: `acceptedEvidence {ip, ua, at, consent,
  consentText, signatureSha256, pageSha256}` in the acceptance transaction,
  and a consent checkbox on the page that gates ACCEPT.
- **Emulator stub**: every e-sign email goes through `esign-io.js sendMail`,
  which logs instead of sending under the Functions emulator.

## 4. Parity — AFTER

| Capability | In-house envelope (Send for Signature now goes here) | Deal page |
|---|---|---|
| Remote send by link | ✓ from the estimate builder, emailed | ✓ |
| In-person signing | ✓ Present → Sign Now opens the signing page on the device | ✓ |
| Multi-signer | ✓ up to 4, ordered, own links (co-owner field in the builder) | — single signer |
| Consent / IP / UA / timestamps / hash | ✓ per signer + certificate page | ✓ (new) |
| Signed PDF stored + delivered | ✓ stored, emailed to every signer, portal link | page stored (no PDF) |
| Reminders | ✓ every 2 days ×3 | — |
| Decline / void / expiry | ✓ / ✓ / ✓ | — |
| Estimate status mirror | ✓ | deal status |
| KY right-to-cancel | KY insurance refused → deal page / generated contract (both carry KRS 367.624 + forms); FTC statement + 2 completed forms in every estimate contract | ✓ |

Historical BoldSign data stays readable: estimates keep `signatureProvider:
'boldsign'`, `signatureDocumentId` and `signedDocumentUrl` (portal, Documents
tab, dashboard chips and `customer-audit.js` still read `signedDocumentUrl`).
There are none in production — the integration never had a key.

## 5. Still open (deliberately not in this PR)

- **esign-setup (rep-uploaded PDFs) is single-signer in the UI.** The engine
  takes `signers` on `saveEsignFields` / `sendEsignEnvelope`; the placement
  page has no signer picker yet. BoldSign's integration was single-signer, so
  this is not a regression.
- **remote-signing.js (generated HTML contracts) still has no IP / UA /
  consent / PDF.** It is not a Send-for-signature target any more; retiring it
  in favour of envelopes is the 09-06 note's "separate decision".
- **C5 auto-invoice was not ported.** It only ever ran from the BoldSign
  webhook (never), had no idempotency key, and the invoice pipeline already
  bills a signed estimate.
- **#2149** appends the cancellation notice to envelopes titled as contracts.
  Estimate envelopes already carry the FTC forms and set
  `cancelFormsIncluded: true`; whichever of the two lands second must skip the
  append when that flag is set.

## 6. Jo's checklist after the deploy

1. Delete the two retired functions (deploys never delete — the orphan check
   will go red until this is done):
   `gcloud functions delete sendEstimateForSignature esignWebhook --region=us-central1 --project=nobigdeal-pro`
2. Then delete the secrets: `BOLDSIGN_API_KEY`, `BOLDSIGN_WEBHOOK_SECRET`
   (Secret Manager). Not before step 1 — the old revisions still mount them.
3. Create the Healthchecks.io check for `esignReminderSweep` (every scheduled
   function pings one).
4. Cancel BoldSign only after this has deployed.
