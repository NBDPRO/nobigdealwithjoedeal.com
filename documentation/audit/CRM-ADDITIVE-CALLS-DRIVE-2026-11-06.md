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
