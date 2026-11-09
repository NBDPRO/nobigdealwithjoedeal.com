# Session 2026-11-09: the project-page consent tick and "Draft project page" (built)

Branch `project-consent-draft` (a worktree), from `main` at `218f1228d`. Builds section 2 steps 1 and 2 of [CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md) (Jo's answer: he confirms consent per job). Runbook: [PUBLISH-PROJECT](../runbooks/PUBLISH-PROJECT.md).

## The shared contract

`leads/{id}.projectConsent = { on: true|false, by: <uid>, at: <server Timestamp> }`. `on === true` is the only thing that lets a job become a project page; it maps to `projects.json` `consentOnFile: true`.

## What was built

1. **Rules** (`firestore.rules`, `projectConsentWriteOk()` on the `/leads` update rule). Only the owner side may set, clear or delete the field: a platform admin, the lead's company_admin, or a solo operator who owns the lead. This is the same writer set as `confirmedSource` (`confirmedSourceRoleOk()`, reused). Managers, reps and viewers cannot, though managers and reps can otherwise edit the lead. When the field changes it must be exactly `{on: bool, by: the caller, at: request.time}`, or removed. Ordinary lead saves that leave it alone are unaffected. `projectConsent` joins `leadCreateHasNoServerFields()`, so a lead is never created with it.
2. **The tick on the customer page.** A "🏠 Project Page" button in the customer actions row, after Referral Code. It costs no boot JS: the page had 10 bytes of shipped-JS headroom (`tests/dashboard-boot-budget-2026-10-03.test.js`). The button dispatches `ScriptLoader.load('js/project-consent.js?v=1')` through the existing `data-action` delegate. When the file runs, it re-points the button at `NBDProjectConsent.open` and opens `#projectConsentPanel`.
   - The owner side gets a live checkbox. Everyone else sees the state, disabled, with "Only the owner can change this."
   - A consented job shows the dry-run command, `node scripts/draft-project-page.mjs --lead <id>`, with a Copy button.
   - It does not open a PR from the CRM: there are no GitHub credentials on the server.
3. **`scripts/draft-project-page.mjs`.** Reads one lead: `--lead <id>` in token mode (`NBD_ACCESS_TOKEN`, `scripts/_firestore-rest.js`, read only), or `--from <export.json>`.
   - It refuses a job without `projectConsent.on === true`.
   - It refuses a joint or subcontracted job: `subId`, legacy `crew`, `jointJob` or `subcontracted`. That is runbook hard rule 3, so such a job goes to Jo.
   - The entry it builds:
     - **Location and price:** the town only, from `city`/`state` or the address's "Town, ST zip" part (never the street). A retail range from `jobValue`, about ±10% rounded outward ($1,000 / $500 / $100 steps). No cost field is read.
     - **Services and year:** services derived from the job's text, or `--services`. The year comes from `installCompletedAt`, then stageHistory, then `completedAt`, or `--year`.
     - **Case-study fields:** `problem`, `scope`, `materials` and `timeline` come from the job only when the text is clean. A house number, street word, phone, email, link, dollar figure, cost word or the customer's name drops the field with a warning.
     - **Photos:** templated alt text, never CRM captions. Repo-local photo paths, `consentOnFile: true`.
   - The default is a dry run. `--write` appends to the local `docs/assets/data/projects.json` only. It refuses a slug already on file, then prints the `prepare-project-images.mjs` / `build-projects.mjs` steps.

## Tests (each seen red first)

| Suite | Bucket | Checks | Red first |
|---|---|---|---|
| `tests/firestore-rules.project-consent.test.js` | wired-individually, own `ci.yml` emulator step | 27 | 14/27 before the rule |
| `tests/project-consent-ui-2026-11-09.test.js` | node | 36 (role mirror, write shape, lazy hand-off, escaping, wiring) | file missing |
| `tests/draft-project-page-2026-11-09.test.js` | node | 58 (refusals, town, range, services, no street, name, phone, sold price or cost in the entry, caption-free alt, dirty scope dropped, dry run vs `--write`, token-less `--lead`) | script missing |

Manifest floors raised to node 1046, disk 1188. The existing rules suites still pass: confirmed-source, install-completed-at, portal-note, messaging-controls and the main `firestore-rules.test.js`.

## Assumptions (for the PR body)

- **"Subcontracted" = a sub on the job.** Read as `subId` or a legacy `crew` on the lead. NBD's crews are independent subcontractors (`production.js` header), so most installed jobs may be refused until Jo says how sub-installed jobs are presented. The safer reading was picked, per rule 3. **Question for Jo:** should a job installed by NBD's own sub crew count as "subcontracted" here? Answering it changes one function, `refusalFor`.
- **The tick is visible to every role.** The button shows for everyone, with the panel read-only for anyone who is not the owner. Hiding it per role would need boot JS the page cannot afford.
- **Drafts are not final copy.** Alt text and description are templated drafts, and the script says so; the runbook's "write it fresh" still applies.
- **The range is published as drafted.** ±10% rounded outward, with no switch to drop it. Skipping the price stays allowed: delete the two keys.

## Open

- Jo's answer on sub-installed jobs (above).
- The photo matcher (§1) and the Social Studio feed (§2 step 3) are later lanes.
