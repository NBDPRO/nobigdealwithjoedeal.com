# Production changes, 2026-11-09 (Jo approved each in chat)

Run from a Claude Code cloud session in **token mode**: a short-lived Google access token Jo made in Cloud Shell (`gcloud auth print-access-token`), saved as a network secret for `firestore.googleapis.com` and injected by the session proxy. The scripts use `NBD_ACCESS_TOKEN` with Firestore REST ([scripts/_firestore-rest.js](../../scripts/_firestore-rest.js)), because firebase-admin refuses a bare token. Every run was a dry run first.

| Time (UTC) | What | Command | Result |
|---|---|---|---|
| ~11:20 | Coach AI focus line on for NBD | `scripts/prod-switches.js --company <NBD> --coach-ai on --yes` | `companyProfile/<NBD>.coachAiEnabled`: off -> on (re-read) |
| ~11:20 | Call to Close auto-brief on for NBD | same run, `--auto-brief on` | `companies/<NBD>/settings/callBrief.autoBrief`: off -> on, `updatedBy: script:prod-switches` (re-read) |
| 11:44 | NBD's first cost book | `scripts/import-catalog-costs.js --company <NBD> --in <private fallback book> --yes` | `catalogCosts/<NBD>` did not exist; now 276 entries, `version: 1`. Validated OK before the write. |

## Notes

- **The cost book is the fallback version.** The current-cost book was refused by the importer's own check: on 36 tiers of 17 SKUs the new supplier cost is above NBD's sell. The fallback keeps the historical cost on those 36 tiers and current costs everywhere else. The 17 SKUs are being reviewed (a unit check, then new sells for Jo to approve); after that they are updated with `scripts/merge-catalog-costs.js --only <SKUs> --yes`.
- **No figures here.** Costs are private to the tenant book and never go in this repo. The proposal files stay outside the repo.
- **To undo a switch:** `scripts/prod-switches.js --company <NBD> --coach-ai off --auto-brief off --yes`, or the owner toggles (Call Center for auto-brief).
- **To undo the cost book:** delete `catalogCosts/<NBD>` in the Firebase console; the Product Library then shows "Cost not set" again. Customer prices are not affected either way.
