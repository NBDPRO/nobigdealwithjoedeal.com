# Sub job board, rate cards, labor-hours estimator and schedule suggester (2026-11-19)

Joe's ask: get all the subs in the CRM, schedule jobs with the calendar and pick the sub, track pay / cost / use, track which jobs have and have not been assigned labor rates and subs, and a mechanic-style "flat-rate labor hours" estimator that also suggests dates. This note records the decisions (a grilling round, every recommendation accepted) and the build order, so the next session does not re-ask.

What already existed before this lane (do not rebuild): the sub roster (`companies/{id}/subs`, [production-logic.js](../../docs/pro/js/production-logic.js)), the paperwork / 1099 tracker ([SUB-PAYMENTS-SORTER-2026-10-19.md](SUB-PAYMENTS-SORTER-2026-10-19.md) covers the sorter), the Job cost auditor, cash payouts, the Crew Calendar lane ([CREW-CALENDAR-LANE-2026-10-12.md](CREW-CALENDAR-LANE-2026-10-12.md)), and the job strip's `subId` with double-booking warnings.

## Decisions (Joe, 2026-11-19)

Pay and board:
- Agreed pay is ONE record per job in its own collection `companies/{companyId}/subJobs/{leadId}` (basis sq / job / hour / day, rate, qty, agreed total, all cents; a "no sub needed" toggle; a note). It is cost data, so it never sits on the customer-facing lead (the lead update rule is at the 1000-expression limit anyway) and never reaches the portal, customer documents, the public site or the sub's job sheet (which keeps no prices).
- Read and write: solo owner, company_admin, manager. Never a viewer, sales_rep, another tenant or anonymous.
- One sub per job for now (splits are a later, bigger change to scheduling and the calendar lanes).
- The board watches committed jobs through finished jobs; "no sub needed" removes a job from every bucket. Four warn-only buckets: no sub, sub but no agreed pay, finished with no payment logged, paid over agreed. Nothing blocks scheduling or closing.
- "Paid" = the sum of live logged sub payments on that job (credits subtract). Cash paid and never logged is not in it, and the screen says so.
- Metrics per sub: jobs done, total paid (and by year), average paid per SQ (only SQ-basis jobs with a quantity), days late against the last scheduled day plus one day of grace (jobs with no schedule are not measured, never counted late; rain is not held against the sub because the number is "days late", not pass / fail), paid vs agreed. Rework / callbacks wait for a new field.
- Old free-text crew names are listed as "crew name not on the roster" and never auto-linked or auto-created.

Estimator and scheduler (not built yet):
- Hours come from Joe's own labor-hours book, never industry averages or the web. The book lives in the private tenant book (`catalogCosts/{companyId}.laborOps`), NOT in a `docs/` file: per hours-per-unit next to a rate in a published file, the privacy guard trips (productivity data was removed from `estimate-labor-catalog.js` on 2026-08-19 for exactly this; see PHASE2-PUBLISHED-COST-BASIS-BRIEF-2026-08-18.md).
- The book starts empty. Joe enters man-hours per unit. "Learn from my finished jobs" can propose crew-DAYS per job type only (real hours are not recorded anywhere), one approval at a time.
- Five multipliers (pitch, layers, stories, complexity, access); outputs man-hours and crew-days, internal only. Crew-days = man-hours / (usual crew size x 8). Usual crew size is per sub, default 3.
- The scheduler only SUGGESTS the best three windows with a one-line reason each (crew-days, the sub's bookings, rain, deliveries, Google busy). It never books or sends. Confirmations are drafts (homeowner text / email, sub job sheet with no prices) that Joe sends from his phone. No routing or learning yet.

## Build order (each its own branch and PR, dark behind a flag Joe flips in the console)

0. Roster paste-a-list add and per-sub rate card (`parseSubList`, `parseRates`; `sub.rates`, max 20, client-checked only). PR #3218, merged.
1a. `subJobs` rule + 56 emulator checks, with three mutated rule copies each failing the right checks. PR #3219, merged.
1b. Board: logic ([sub-job-board-logic.js](../../docs/pro/js/sub-job-board-logic.js), 30 checks, 8 mutations caught) and panel ([sub-job-board.js](../../docs/pro/js/sub-job-board.js), 29 checks, 11 mutations caught). Flag `subJobBoard`. The panel sits under Plan Jobs on the Schedule view and is fetched by `schedule-planner.js` ONLY when the flag is on. The agreed-pay editor is on the board rows (Set pay), not on the job strip.
2. Labor-hours book screen, crew size per sub, the pure estimator (flag `laborHoursBook`).
3. Schedule suggester (flag `scheduleSuggest`), a "Suggest dates" button in Plan Jobs.
4. Confirmation drafts on a confirmed suggestion.

## Step 2a status (2026-11-19, later the same day)

Steps 0, 1a and 1b are merged; the board is on main, dark behind `subJobBoard`. Step 2 is split because the pieces are independent:

- **2a (built): the pure estimator**, [labor-hours-logic.js](../../docs/pro/js/labor-hours-logic.js) with 30 checks and 14 mutations caught. It sums an estimate's resolved lines (`laborId`, `quantity`, which the estimate engine already produces) against the company's own hours per unit, applies additive factors, and converts to crew-days. Nothing is invented: a labor action with no hours is listed as missing, a factor with no percent does not apply, a real 0 counts as set. Factors ADD (they do not compound). It touches no pricing code, so the pricing suites are not involved.
- **The book already exists as a shape.** `catalogCosts/{companyId}.laborOps[laborId]` already holds `{ rate, hoursPerUnit, crewSize }` with an owner / company_admin write and a tenant read (`NBDCatalogCosts.laborOp / recordLaborOp`). No editor writes `hoursPerUnit` yet. Reps can READ catalogCosts, so hours are internal-to-the-company, not owner-only; they must still never reach a customer, the portal or a sub sheet.
- **2b (next): the editor** (hours per unit by labor action, the factor percents, and `crewSize` on each sub doc, which the sub rule already accepts) behind `laborHoursBook`. Where the factor percents are stored is an open detail: `catalogCosts.defaults` is the likely home, and its readers must be checked first.
- **2c: show it** on a job (which estimate lines feed it, and the "N lines have no hours yet" prompt).
- The privacy guard (`catalog-cost-privacy`) only forbids productivity keys in the published labor catalog; the new logic file carries no numbers beside those keys and the guard still passes. Fixture numbers in the test are synthetic.
## Step 2b status (2026-11-19, later still)

- **2b (built, dark behind `laborHoursBook`): the editor.** [labor-book-logic.js](../../docs/pro/js/labor-book-logic.js) (29 checks, 14 mutations caught) and [labor-book.js](../../docs/pro/js/labor-book.js) (36 checks, 15 mutations caught). A panel under the Sub job board on the Schedule view, owner and company_admin only (the `catalogCosts` write rule), fetched by `schedule-planner.js` only when the flag is on. It has two parts: man-hours per unit for each of the 66 labor actions, saved as `{ hoursPerUnit }` only through `NBDCatalogCosts.recordLaborOp`; and a usual crew size per sub, saved as `{ crewSize, updatedAt }` on the sub's own doc (the sub rule already accepts it).
- **The book starts empty and nothing is guessed.** A box is empty until Joe types a number; a real 0 is a valid number; a blank box leaves the stored value alone (clearing a number is not supported yet and the screen says so). Invalid input saves nothing and names the action. While the book is still loading the panel shows no boxes, because an empty box over a held number would lie.
- **A data-loss bug had to be fixed first (PR #3225).** `NBD_LABOR.updateRate` wrote only `{ rate }` with a dotted-path `updateDoc`, which REPLACES the whole `laborOps.<id>` value, so editing a rate erased that action's hours and crew size. `recordLaborOp` now merges. #3225 is merged, so the editor is safe on its own.
- **Not built:** the factor percents (steep pitch, extra layers / stories, cut-up roof, access). Their storage is still open: `catalogCosts` has a fixed list of maps (`BOOK_MAPS`) that the cost-basis registry and ops scripts also enumerate, so a new map needs those readers checked first. Until then the estimator applies no factors, which is the honest default (no percent means no factor).
- **Next, 2c:** show the estimate on a job, and the "N lines have no hours yet" prompt.

## Step 2c decision and plan (Joe, 2026-11-19)

**Finding that changed the plan.** The roof estimates Joe writes (the per-square builder and the wizard) store NO labor lines: they price per SQ and keep measurements (`sq`, `pl` pitch, `stories`, `tearOffLayers`, `cutUpRoof`, `accessLevel`) plus `workKind` (`repair` / `replacement` / none) and `mode`. Only the older line-item engine (`resolveEstimate`) and job templates carry `laborId` + `quantity` per line. So the line-summing estimator in [labor-hours-logic.js](../../docs/pro/js/labor-hours-logic.js) (2a) has nothing to sum for a normal roof estimate.

**Decision: BOTH, in this order.**

1. **One book time per job type first**, the way a mechanic's book works: hours per SQ for a replacement, hours per job for a repair, hours per unit for a template (per LF for gutters), entered by Joe. The same factors apply (pitch, layers, stories, cut-up, access). Quantity comes from the estimate (`sq` for per-SQ jobs). "Learn from my finished jobs" can propose crew-DAYS per SQ from Joe's own scheduled and finished dates (real hours are not recorded anywhere), one approval at a time.
2. **Recipes later** for jobs Joe wants itemized: a job type maps to a list of the 66 labor actions with quantity formulas from the measurements, and the 2b hours-per-action editor feeds it. The line-summing estimator (2a) is the engine for that.

**Open details for the next session (state the choice and ask only if Joe could object):**

- **Storage.** Lowest-risk is reserved-prefix keys inside the existing `laborOps` map (for example `BOOK:replacement`), because a new top-level map must be added to `BOOK_MAPS` in catalog-costs.js and to the cost-basis registry and the ops scripts that enumerate maps (`functions/cost-basis-registry.js`, `scripts/import-cost-rotation.js`). Check that nothing iterates `laborOps` expecting only real labor ids before relying on it (the registry and importer validate IMPORTED rows, not live ones). The factor percents have the same question and the same likely answer.
- **Where it shows.** On the Sub job board rows and the job card: "about N man-hours, about D crew-days", with "no book time for this job type yet" when the book has none. Never on an estimate, the portal, a customer document or a sub's job sheet.
- **Order of dependencies.** #3225 (recordLaborOp merge, now merged) before 2b #3226 before any 2c work that writes the book.

## Gotchas found on the way

- The dashboard shipped-bytes ceiling (`dashboard-boot-budget-2026-10-03`) counts only scripts a page tag or bundle names. A file fetched by `ScriptLoader.load` from another file's code is not counted, which is why the board adds no shipped bytes. #3218 raised the ceiling twice (2613 to 2619 KB) with Joe's OK in chat.
- JS under `docs/` is served `max-age=0, must-revalidate`, so a `?v=` bump is not needed for freshness. Two tests pin `schedule-planner.js?v=8`, so it was left alone.
- The rules tests need `tests/node_modules` (a junction to the main checkout works) and a free emulator port; 8080 is often held by another session. A scratch `--config` with another port avoided killing it.
- `functions/` dependencies are not installed in fresh worktrees, so `production-flow-2026-10-04` and `schedule-already-completed-2026-10-13` exit 1 there on main too. Run the new sections standalone, or install first.

## What is not verified

The board has not been opened in a real browser with the flag on, and the iPhone check is Joe's. The behavior tests run the real panel against a fake DOM and a fake Firestore.
