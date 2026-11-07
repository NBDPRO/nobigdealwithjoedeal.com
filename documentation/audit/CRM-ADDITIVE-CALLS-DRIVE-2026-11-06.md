# Customer card: calls matched by number, and a Drive folder link — 2026-11-06

The two approved additive features from the 2026-11-06 full CRM audit brief (CU-F06, CU-F07). Additive only —
no rename, retype, backfill or change to existing data.

## Calls matched by number (CU-F06)
`functions/call-center.js` files every recorded call into `phone_calls` with a 10-digit `phoneDigits`, but most
carry `leadId: null` — and the customer card's Calls list (`docs/pro/js/customer-calls.js`) only queried by
`leadId`, so a customer's own calls never showed on their card. `fetchCalls` now also reads `phone_calls` where
`phoneDigits` equals the lead's number, inside the same scopes the rules already allow (own `userId`; plus
`companyId` for company_admin / manager / viewer), 50 per scope, and never claims a call attached to a DIFFERENT
customer (a shared household number). Those rows carry a "Matched by number" chip. Read-only.

Harness (synthetic tenant): Test Homeowner 01 — 1 call on main → 2; Test Homeowner 02 — 0 → 1.

## Drive folder link (CU-F07)
New optional lead field `driveFolderUrl`: a labelled URL box above Notes in Add/Edit Lead (`dashboard.html
#lDriveUrl`), saved by `crm-leads.js` (http(s) only, else ''; omitted when the box isn't on the page so a stale
cached page can't blank a stored link), loaded by Edit Lead (`crm-portal-bridge.js`), and shown on the customer
card next to Source as "Open Drive folder" (`customer.html #infoDriveFolder`, built with createElement +
textContent, new tab, `rel=noopener noreferrer`).

## Proof
`tests/customer-calls-by-number-2026-11-06.test.js` (real fetchCalls, stubbed Firestore, 11/11) and
`tests/lead-drive-link-2026-11-06.test.js` (real saveLead, 10/10); both fail on main.

## Update — PR steward review (2026-11-06 evening)

Three review items, fixed on the same branch (new commit, no force-push):

1. **No move on a by-number row.** A call matched only by number has no `leadId`, and `callCenterAction` `move` refuses such a call ("not filed on a customer — attach it instead"). `renderPhoneCall` no longer offers "Wrong customer → move to…" on those rows. ✓ Handled stays, since the server allows it on an unfiled call.
2. **Cold load waits for the lead doc.** `_customerId` lands before `_leadDoc`, so `leadDigits()` was empty and the by-number query was skipped. The list now loads at once (filed calls show straight away), then loads again when `_leadDoc` lands (watched for about 12 s), so the by-number calls appear.
3. **Drive link input.** A pasted link without `https://` gets it added. Any other non-link is left out of the save (an edit keeps the stored link) and the rep sees a toast. A blank box still clears the link. `lead-drive-link-2026-11-06.test.js` changes its expected value from "saved as an empty string" to "never stored".

Test: `tests/customer-calls-review-2026-11-06.test.js` (9 checks; 3 fail on the PR head before this commit).
