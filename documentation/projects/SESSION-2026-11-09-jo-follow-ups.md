# Session 2026-11-09: Jo follow-ups (four lanes, integrated)

Branch `fu-int` (worktree `.claude/worktrees/fu-int`), from `6728fcbb4`. Four lanes were built and reviewed in their own worktrees, then cherry-picked here in this order, every commit kept: `fu-viewers` (12), `fu-designer` (5), `fu-evalkit` (8), `fu-leaderboard` (5). Commits that needed a conflict resolved say so in an `Integration:` line. Nothing was pushed.

This note was asked for as `SESSION-2026-11-09-call-to-close-p1.md`. That name already holds the Call to Close P1 integration note, so this one has its own name and is linked next to it in [INDEX](../INDEX.md).

Lane detail lives in: the "Update 2026-11-09 (lane fu-viewers)" and "Review round" sections of [SESSION-2026-11-09-call-to-close-p0](SESSION-2026-11-09-call-to-close-p0.md) (viewers), [CALL-BRIEF-LIVE-EVAL](../runbooks/CALL-BRIEF-LIVE-EVAL.md) (eval kit), and §6 of [SESSION-2026-11-09-nbd-os-p2](SESSION-2026-11-09-nbd-os-p2.md) (leaderboard). The Designer lane wrote no note; it is summarised below.

## What shipped

| Lane | What a user sees | Server / data |
|---|---|---|
| Viewers (Q11, the rest) | A viewer sees "Calls and texts are hidden for your role." on the Call Center, the customer card's Calls section and the Inbox layout (a quiet `ib-note` line), and "Calls are hidden for your role." on the Thursday widget. The customer timeline shows a viewer only rep-entered and visit-capture rows. A viewer's "Brief me" has no CALL / TEXTS / THURSDAY / PROMISE line. | `thursday_calls`, `phone_texts`, `phone_text_days` read rules add `notViewer()`. `leads/{id}/activity` read allows a viewer only `source in ['rep','visit-capture']` (an allowlist; denylist forms leaked under the emulator). Follow-up tasks (Call Center, text days, Thursday) no longer copy the AI summary; `scrubTaskSummary` cleans a moved task. `getThursdayRecording` refuses a viewer. Lead briefs skip call lines and the shared cache for a viewer. |
| Designer lines | The Designer / Luxury Shingle template now carries "Step Flashing Aluminum" (RFG STPF-AL) and "Coil Roofing Nails Standard" (RFG NAIL-C) after the pipe boot, as its sibling templates do. Code-only lines: the engine sets qty, the catalog sets price. | `job-templates-data.js` only. Default roof Designer total $18,375 → $18,525 (nails; step flashing is $0 at wallLf 0). 132 Designer BASELINE values re-pinned in `system-plus-standard-and-up-2026-10-05` with the dated "(Jo OK)" comment. **No `KNOWN BUG` pin moved** (checked: the integrated diff touches no `KNOWN BUG` line). |
| Eval kit | Nothing in the CRM. Jo gets `node scripts/eval-call-brief.js --init <dir>` (empty label files plus a README, outside any git work tree, owner-only modes) and a step-by-step runbook. | Runs skip blank cases, check every filled label (`validateCase`) before any paid call, and name a label file that is not valid JSON. The runbook reads the API key with `read -rs`, never inline. |
| Leaderboard on | Every 30 minutes each active member gets a real `leaderboard/{uid}` row; the Team widget and Leaderboard page show it. No UI change. | `LEADERBOARD_AGGREGATE_ENABLED=true` in `functions/.env.nobigdeal-pro`; flag registry and cron-gates comments updated. Per-run reads capped (one instance, 4-minute budget with resume cursor, 50 members a company, 2000 docs a query). |

## Integration work (this branch, after the picks)

- **Conflicts.** Only `FLOORS` in `scripts/run-test-manifest.js`: the viewers, Designer and evalkit lanes each bumped it from 999/74/1134. `tests/ci-manifest.json` merged cleanly. `--check` on the integrated tree measures node 1002, disk 1138; one dated comment line covers all three lanes.
- **Functions, rules, indexes.** No lane added a callable, trigger or export, so `functions/index.js`, the function map and demo canned answers need nothing. `FUNCTIONS_INDEX.md` has the viewers lane's one row change (`getThursdayRecording` is now role-gated). `firestore.rules` changes come from the viewers lane only, with its own CI step (`firestore-rules.call-content-viewers.test.js`, project `nbd-callviewers-test`). No new composite index: the viewer timeline query is `where('source','in',[...])` on a single subcollection.
- **Call Brief sheet.** No lane touched `call-brief-ui.js`; the sheet is as the P1 integration left it.
- **Cross-lane rule: viewer hiding is consistent where call content shows.** The other three lanes add no call-content surface. The eval kit reads transcripts only from files outside the repo; the leaderboard counts doors, appointments, estimates and deals, never call content.
- **Boot.** `dashboard-boot-budget-2026-10-03` passes (36/36). No other lane touched `docs/` beyond the viewers lane and the one Designer data line.

## Verification (integrated tree)

- `check-js-syntax` (2383 files), `check-site-integrity --quiet` (0 failures), `check-inline-html-scripts`, `apply-partials --check --diff`, `check-vault-index`, `run-test-manifest --check`: all clean.
- Node bucket 1002/1002. `tests/smoke.test.js` 4434 passed, 0 failed.
- Emulator, one at a time on a private port (8080 was held by another session): `call-content-viewers` 100/100, `call-briefs` 20/20, `cross-tenant` 482/482, `company-docs` 47/47.
- Browser: `pro-demo-zero-network-2026-10-06` 122/122, `crm-layouts-render-2026-10-15` 49/49.
- Screenshots (owner and viewer, 375x812 and 1280x800): Call Center, Inbox layout, customer Calls section, and the Designer template's pre-confirm list. The viewer sees the hidden line on all three call surfaces; the owner sees the usual empty states; the Designer list shows both new lines (nails 23 SQ, $129; step flashing $0 with no walls). No page errors, no blocked network.

## What Jo must run or decide

1. **Old tasks backfill (viewers).** Tasks filed before this branch still carry `Call: <summary>` or Thursday's `Summary:` / `Urgent:` lines. The backfill is described in the P0 note, not written or run. Needs Jo's OK before any `--apply`.
2. **Viewer-readable call-derived text still open:** task titles and "You said you would" promise lines, Thursday-created `lead.notes`, and voicemail rows (`source: 'rep'`). Each is listed with options in the P0 note's review round. **Jo decides.**
3. **Leaderboard indexes.** Confirm the four ASC composite indexes and the jobs collectionGroup `userId`/`updatedAt` index show Enabled in the Firebase console. The gate is platform-wide: every tenant company is counted.
4. **Live Call Brief eval.** Follow [CALL-BRIEF-LIVE-EVAL](../runbooks/CALL-BRIEF-LIVE-EVAL.md): `--init` outside the repo, label about 20 real calls, then the Haiku and Sonnet `--live` runs.

## Gaps

- **Call Center, viewer.** The hidden line sits below the full set of filter chips (all at 0). It reads correctly but a viewer scrolls past controls that do nothing. Left as it was in P0; a follow-up could hide the chips for a viewer.
- **Customer Calls section, viewer.** The section subtitle still says "summary, transcript and recording" above the hidden line.
- **Demo path.** `customer-calls.js` renders only on `/pro/customer(.html)`, so in the demo (`/pro/explore/customer`) the Calls card says "Loading calls…" for every role. Older than these lanes; the screenshots patch the path check in the shot script only.
