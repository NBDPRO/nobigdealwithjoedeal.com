# Secure Document Link (document tracker), 2026-11-04

Flags: `SECURE_DOC_LINK_ENABLED` (master) and `DOC_LINK_FOLLOWUP_ENABLED` (24h reminder), both OFF by default, plus the client flag `secureDocLink` (`feature_flags/_default`) that shows the buttons. Design: Jo's vault note "Design - Document Tracker 2026-11-03" (off-repo). Ships dark; with the master flag off `/report/<token>` is byte-identical to before (golden test).

## What it is

The existing tracked "Send for review" PDF link (`report_share_tokens`, kind `lead_document`) with a new `purpose: 'secure_doc'`. Phase 1 is PDFs only (estimate PDFs and contract copies). Contracts that need a signature stay on e-sign. The CRM estimate page and the portal token path are untouched.

| Piece | Where |
|---|---|
| Pure rules (scrypt, lockout, cookie proof, device class, clamps, reminder decision, notice copy, page HTML) | `functions/doc-link-logic.js` |
| Mint (`createEstimateReviewLink { secure, expiryDays, password }`) and `revokeDocumentLink` | `functions/estimate-send.js` |
| Serve (password page, `/unlock`, viewer shell, `/file`) | `functions/doc-link-serve.js`, called from `getSharedReport` |
| Beacon `/api/doc-link-ping` | `functions/doc-link-ping.js` |
| Hourly 24h reminder | `functions/doc-link-followup.js` |
| Viewer script and CSS | `docs/pro/js/doc-link-view.js`, `docs/pro/css/doc-link-view.css` |
| Rep UI (Send securely, chip, Revoke) and wording | `docs/pro/js/customer-documents.js`, `docs/pro/js/doc-link-copy.js` |
| Rules / TTL | `firestore.rules` (`leads/{id}/docViews`), `firestore.indexes.json` (TTL on `expireAt`) |

## Decisions (Jo, 2026-11-03/04)

PDFs only. "Time with the page open", never "time reading". No pdf.js. Password optional per link; app can make an 8-character code (shown once, never stored, never logged, never in the URL); scrypt N=32768 with a per-link salt, constant-time compare, 5 wrong tries per 15 minutes per link then a 15 minute lock (plus the per-IP limit). Alerts are in-app only: bell and push on the first real open, "viewing right now" (2h cooldown per lead, `fresh-view-logic.js`), and one Agent-inbox reminder 24h after the first open that never contacts the customer. Expiry choices 1/7/14/30 days, default 14, server max 90. View rows kept 180 days (Firestore TTL). The tracking notice wording is approved verbatim and appears in the share message, the viewer banner and the mail body.

## Counting

Stage 1, link FETCHED: the shell was served; logged on `leads/{id}/docViews/{viewId}`, never alerts. Stage 2, OPENED: the page's own script sent `open` after 3 visible seconds (and at least 2.5 s after the fetch). Only that bumps `openCount`, stamps `lead.lastViewedAt` and alerts. Preview bots and scanners never alert. A scanner that runs a full headless browser could still fake an open; nothing can prove a human.

## Verified while building

- Hosting forwards only a cookie named `__session` to a rewritten function (Firebase "manage cache" docs). The unlock proof is that cookie, HMAC-signed with a per-link random key stored on the token doc (no new secret).
- A "customer replied" signal exists: `lead.lastInboundAt` (`functions/inbound-stamp.js`, texts and portal messages). A phone call is not recorded there, so the reminder is worded as a nudge ("I don't see a reply in the CRM").
- The deal room comment in `deal-acceptance.js` shows the site-wide Hosting CSP does reach function-served pages; that is evidence, not a test of this page.

## NOT verified (needs a deployed preview and a real phone)

- Whether Hosting applies the `firebase.json` header rule for `/report/*/file` (X-Frame-Options SAMEORIGIN, `frame-ancestors 'self'`) to a function-served PDF, and which duplicate header wins. If not, the framed PDF is blocked and the customer uses the always-visible "Open full document" button (then time with the page open is not measured).
- Whether the PDF viewer renders inside the iframe on iPhone Safari and Android Chrome (often page 1 only). The button is the fallback.
- That the `/file` response (no `sandbox`, `frame-ancestors 'self'`) renders in Chrome's PDF viewer.
- A link-scanner mailbox (Outlook SafeLinks, Proofpoint, Apple Mail privacy): that fetching the link never alerts Jo.
- That a server write of `lead.docTrack` is not clobbered by a full-document client save of the lead.

## Not done

Privacy policy sentence (needs Jo and counsel; the page would claim a feature that is not live). Phase 2 (CRM estimate page). A "customer replied" check beyond `lastInboundAt`. An emulator rules test for `docViews` is in `tests/firestore-rules.test.js`.

## Turning it on

Order: set `secureDocLink` for one test uid in `feature_flags/{uid}`, set `SECURE_DOC_LINK_ENABLED=true` in the env file, deploy, test on Jo's own lead with his own phone and email (including a scanner mailbox), then consider `DOC_LINK_FOLLOWUP_ENABLED`. Tests: `tests/doc-link-2026-11-04.test.js`.
