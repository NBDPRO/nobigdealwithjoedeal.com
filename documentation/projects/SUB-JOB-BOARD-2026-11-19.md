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

## Gotchas found on the way

- The dashboard shipped-bytes ceiling (`dashboard-boot-budget-2026-10-03`) counts only scripts a page tag or bundle names. A file fetched by `ScriptLoader.load` from another file's code is not counted, which is why the board adds no shipped bytes. #3218 raised the ceiling twice (2613 to 2619 KB) with Joe's OK in chat.
- JS under `docs/` is served `max-age=0, must-revalidate`, so a `?v=` bump is not needed for freshness. Two tests pin `schedule-planner.js?v=8`, so it was left alone.
- The rules tests need `tests/node_modules` (a junction to the main checkout works) and a free emulator port; 8080 is often held by another session. A scratch `--config` with another port avoided killing it.
- `functions/` dependencies are not installed in fresh worktrees, so `production-flow-2026-10-04` and `schedule-already-completed-2026-10-13` exit 1 there on main too. Run the new sections standalone, or install first.

## What is not verified

The board has not been opened in a real browser with the flag on, and the iPhone check is Joe's. The behavior tests run the real panel against a fake DOM and a fake Firestore.
