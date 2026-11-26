# Guide "Email me a copy" (2026-11-26)

Second half of the 2026-11-25 guides capture work (the first half was the
on-page quick lead form). Joe chose this design on 2026-11-26:

- **What's emailed:** the guide's typeset PDF, attached. The PDFs were already
  published at `/guides/pdf/<slug>.pdf` (#2509, rebuilt in #3185); the "Printable
  PDF coming soon" text only shows until `guide-pdf-slot.js` confirms the file,
  so visitors already had the download link.
- **CRM:** every request becomes a cold lead, source `Website — Guide copy`,
  email only. No alert to Joe.
- **Storm tips box:** records consent only (`emailConsent`,
  `emailConsentAt`, `emailConsentVersion: guide-storm-tips-2026-11-26`). No
  storm-tips email program exists yet, so nothing reads it.

## How it works

| Piece | File |
|---|---|
| Box on 6 guide pages (hidden until the script runs) | `scripts/add-guide-email-copy.js` (inject, idempotent), `docs/assets/js/guide-email-copy.js` |
| Gateway kind `guide_copy` → `guide_copy_requests` (email shape + slug checked) | `functions/handlers/integrations.js` |
| Guide table, email HTML, CRM note lines | `functions/guide-copy-logic.js` |
| The one email, PDF attached by URL (Resend fetches it) | `functions/guide-copy-email.js` (`guideCopyEmail`) |
| Cold CRM lead | `functions/lead-bridge.js` (`leadBridgeGuideCopy`), `lead-bridge-logic.js` |
| Never alert-eligible | `functions/public-lead-guard.js` |
| Client writes denied | `firestore.rules` `guide_copy_requests` |

The email is **transactional** (the homeowner asked for this document), so it
is not gated by the unsubscribe register, but it passes the messaging kill
switch and canary, is claimed once (`guideEmailedAt`), and is capped at 3 per
inbox per 24 h. Nothing the visitor typed is echoed into it.

`/guides/how-a-roof-works` has no PDF, so it has no box. Adding a guide means a
row in `GUIDES` (guide-copy-logic.js), a slug in the inject script, and its PDF;
`tests/guide-email-copy-2026-11-26.test.js` fails until all three agree.

## After deploy

- Send one real request to Joe's own inbox (with his OK) and confirm the PDF
  arrives attached and the CRM card appears.
- If the checkbox wording ever changes, bump `STORM_TIPS_CONSENT_VERSION`.
