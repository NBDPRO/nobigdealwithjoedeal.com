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
- **The range is published as drafted.** A fixed band on a grid (see the review fixes below), with no switch to drop it. Skipping the price stays allowed: delete the two keys.

## Review fixes (2026-11-09, fix round)

Test-first: the new checks were added to the two node suites and seen red before the code changed (UI: 10 failing; draft: every new check failing, and the CLI runs failing on the then-unknown `--tenant` flag). Now draft 88/88, UI 46/46.

1. **Another tenant's job can no longer reach NBD's site.** `refusalFor` / `buildEntry` now need the site's tenant and refuse any lead whose tenant (`companyId`, or `userId` on a legacy lead with none) is not it, and refuse when no site tenant is known (fails closed). The CLI takes it from `--tenant`, else the `NBD_OWNER_UID` env, else `functions/tenant-ops-logic.js` (the config the functions read), so nothing new is hard-coded. In the CRM, `project-consent.js` shows the tick and the command only for an NBD job seen by NBD (`_isNbdPlatformTenant()` and the lead's tenant is the viewer's). Every other tenant, and a platform admin on another tenant's lead, sees a one-line note and no tick; `setConsent` refuses too. The rules are unchanged: another tenant's own company_admin may still write the field on their own leads, and the script refuses it.
2. **The text filter is stricter, and it fails safe.** Every name field the lead carries is split into words and each word is checked, with possessives and plurals (`firstName`, `lastName`, `fname`, `lname`, `name`, `customerName`, `spouseName`, the carrier fields and the adjuster fields; two-letter names count). Any other capitalised word is treated as a possible name or place unless it is on a short list of roofing brands, product lines, colours and trade acronyms, the job's own town, or a common first word of a sentence. Claim and policy numbers (`CLM884512`, long bare numbers other than a year) are caught, and so are more street words: Pike, Pkwy, Hwy and Boulevard always, and Way, Circle, Place, Trail, Terrace, Loop, Crossing and Run when capitalised. A field that trips any check is dropped with a warning. The review warning now names every text field (description, scope, problem, materials, alt text).
3. **A sub named only in the text goes to Jo.** `refusalFor` also reads the job text fields (`scopeOfWork`, `damageType`, `jobType`, `subType`, the material fields). It refuses on "sub", "subs" or "subcontract…", on "joint job/project/venture/install" or "jointly", on LLC / Inc / Corp, and on "<Name> Roofing/Construction/Exteriors/Contracting/Contractors/Builders/Restoration". "Sub-fascia" and "subfloor" pass. The `jointJob` / `joint` / `subcontracted` flag checks were removed. Nothing in `docs/pro/js` or `functions/` writes those flags, so the checks never fired. The real fields are `subId` and `crew` (`production-logic.js` `subFieldsFor`).
4. **The price range no longer gives away the sold price.** It is now a fixed band on a grid (`floor(v / width) * width`, width $500 under $2k, $1k under $5k, $2k under $10k, $5k under $30k, $10k under $60k, else $20k). Every price in a band prints the same range, and every bound is a multiple of $500 (hard rule 1). A job under $500 gets no range. Examples: 18,000 → 15,000–20,000; 850 → 500–1,000.
5. **The consent panel is styled and takes a full row.** `customer.html` has `.pc-panel` / `.pc-tick` / `.pc-meta` / `.pc-cmd` rules (full width, `flex:1 1 100%`, and `[hidden]` still hides it). `.quick-actions #projectConsentPanel { grid-column: 1 / -1 }` sits at the ≤900px grid, like `#gallerySharePanel`.

Gates after the fixes: node bucket 1046/1046, smoke 4434/4434, js-syntax, inline-scripts, the manifest check (1188), site-integrity, vault-index, build-projects --check, catalog-cost-privacy 130/130, dashboard-boot-budget, concat-shipped --check. The rules suite was not re-run, because `firestore.rules` did not change in this round.

## Open

- Jo's answer on sub-installed jobs (above).
- The photo matcher (§1) and the Social Studio feed (§2 step 3) are later lanes.
