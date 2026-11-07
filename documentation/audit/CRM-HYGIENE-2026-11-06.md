# CSV formula injection, denied saves that still applied, and the setup wizard's email swap — 2026-11-06

From the 2026-11-06 full CRM audit (VW-F150, ST-F02, ST-F60; scorecard on the `crm/2026-11-06-tooling` branch).

## VW-F150 — pipeline "Export CSV" (`tools.js exportLeadsCSV`)
Lead names and notes arrive from the PUBLIC intake form; the export wrote them raw, so a submission named
`=HYPERLINK(...)` (or starting `+`, `-`, `@`) ran as a formula when the owner opened his own export. The newer
exporter (`data-export.js`) already neutralised this; the header button still used the old one. Same rule now: a
leading `'` unless the cell is a plain signed number (a -1500 credit still sums). The file was also named
`NBD-Leads-…` for every tenant; NBD keeps it, others get `Leads-…`.

## ST-F02 — denied Company Profile saves (`company-profile.js _saveCompanyProfile`)
The edit was merged into `window._companyProfile` and the tenant's localStorage cache BEFORE `setDoc`, with no
rollback. A sales rep / manager / viewer pressing Save on Company Profile, Estimates "Save All" or Business Rules is
refused by the rules — but the refused deposit, rates or legal text stayed in effect for that session's estimates
and documents. A rejected write now restores the previous profile, raw brand override and cache (unless a later
save already replaced the profile), and still rejects to the caller so its error message shows.

## ST-F60 — setup wizard re-run (`pages/onboarding.js`)
`prefill()` put the LOGIN email in the business-email box before reading the profile, and `setIfEmpty` then
ignored the profile's own email; Save always set `contact.alertEmail = email`. Re-running the wizard silently
replaced a tenant's business email and its separate lead-alert inbox, so public leads alerted the wrong inbox. The
login email is now the last-resort default, and a stored alert inbox that differs from the business email is kept.

## Proof
`tests/hygiene-guards-2026-11-06.test.js` runs the real `exportLeadsCSV`, `_saveCompanyProfile` (Firestore
stubbed to deny) and `prefill()`: 16/16; against main 8 fail and the positive controls pass.
