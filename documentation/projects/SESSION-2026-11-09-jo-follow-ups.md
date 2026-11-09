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

## Final review round (2026-11-09)

Two reviewers read the integrated branch. Fixed here, each test-first, one commit each:

- **contact-suggest** checks the role before its `thursday_calls` read, so a viewer sends no denied request even if `canWrite` were widened.
- **smart-followup** `_loadConversation` sends no timeline read for a viewer. The draft uses only call / text / Thursday rows, none readable to a viewer, and the unfiltered list is refused whole; a filtered `activityQuery` would fetch rows the draft never uses. The draft still runs on the lead and its estimates, as before.
- **Call Center, viewer:** with nothing loaded, the "hidden for your role" note shows without the search box, the 13 category tabs and the filter chips (all at 0), so at 375px it is no longer at the bottom of the first screen. The panel drops its `tabpanel` role, which named a tab no longer drawn. Owners and managers with no calls keep the toolbar.
- **Customer Calls, viewer:** the "summary, transcript and recording" subtitle (now `id="callsSub"`) is hidden.
- **Inbox, viewer:** the rail has no Texts or Calls folder.
- **Designer re-pins:** each of the 132 re-pinned `system-plus-standard-and-up` BASELINE lines now carries its own dated "(Jo OK)" comment. No value and no `KNOWN BUG` line changed.

Not changed, on purpose:

- **Designer item order.** STPF-AL and NAIL-C sit after PIPE-STD. The siblings run PIPE, STPF-AL, RIDG-VNT, NAIL-C, but the Designer template already had RIDG-VNT earlier (before VLY-W), so the new lines keep the siblings' relative order. Moving RIDG-VNT would reorder a line this lane did not add. Display only, not price.
- **Lead brief cache for a viewer.** See item 5 below.

Re-verified after this round: `check-js-syntax` (2383 files), `run-test-manifest --check` (node 1002, smoke 74, 1138 suites; no suite added, FLOORS unchanged), `dashboard-boot-budget-2026-10-03` 36/36, `check-site-integrity`, `apply-partials --check`, `check-inline-html-scripts`, `check-vault-index` clean. Node bucket 1002/1002 (the first run caught `a11y-audit-2026-10-23` pinning the literal tabpanel markup; fixed in its own commit). Smoke 4434/0. Emulator, one at a time: `call-content-viewers` 100/100, `call-briefs` 20/20, `cross-tenant` 482/482, `company-docs` 47/47. Browser: `pro-demo-zero-network` 122/122, `crm-layouts-render` 49/49, `layouts-visual-audit` 95/95. `call-to-close-viewers-2026-11-09` is now 94/94 (16 new checks, each with a positive control).

## What Jo must run or decide

**Q11 (viewers) is not fully closed.** The PR body must carry this list so nobody reads Q11 as done.

1. **Old tasks backfill (viewers).** Tasks filed before this branch still carry `Call: <summary>` (Call Center) or Thursday's `Summary:` / `Urgent:` lines, and a viewer can read them: the tasks read rule is unchanged. `scrubTaskSummary` runs only when a Call Center task is moved, never on a Thursday task. The backfill is described in the P0 note, not written or run. Needs Jo's OK before any `--apply`. *(Update 2026-11-09: the script now exists and has not been run; see "Q11 task-summary backfill" below.)*
2. **Viewer-readable call-derived text still open.** Each is listed with options in the P0 note's review round. **Jo decides each one:**
   - Thursday task titles, `Call back X - <issue>` built from `shortIssue(ex, call)` (`functions/integrations/thursday-logic.js` `buildTask`).
   - Call Brief promise tasks `leads/{id}/tasks/promise-<callId>-<n>`, and the "You said you would" lines on `cube-` tasks.
   - `lead.notes` on leads that Thursday creates.
   - Voicemail activity rows: `docs/pro/js/voicemail.js` `writeActivityEntry` stores the transcript, and a row written with `source: 'rep'` passes the viewer allowlist.
3. **Viewers lose two more timeline row kinds.** The activity rule is an allowlist (`rep`, `visit-capture`), so a viewer also no longer sees `voice_memo` or `away_handback` rows on the customer timeline. The rules comment documents this as intended; it is a visible change for viewers.
4. **Leaderboard indexes, before this deploys.** Confirm the four ASC composite indexes and the jobs collectionGroup `userId`/`updatedAt` index show **Enabled** in the Firebase console. They are in `firestore.indexes.json` (#3019); their prod build status was not checked. A missing index makes that company's knocks / leads query throw. `LEADERBOARD_AGGREGATE_ENABLED=true` is platform-wide: `maxCompanies` is Infinity when live, so every tenant company is aggregated every 30 minutes, not only NBD. Per-run cost is bounded (50 members a company, 2000 docs a query, a 4-minute budget with a resume cursor in `system/leaderboardAggregate`, one instance). The env comment and §6 of [SESSION-2026-11-09-nbd-os-p2](SESSION-2026-11-09-nbd-os-p2.md) say the same.
5. **Lead brief cost for viewers.** A viewer's "Brief me" never reads or writes the `lead_briefs` cache (it was built from call content), so each one is a fresh AI generation. `takeQuota` counts each, so cost has a ceiling, but a viewer who opens many customers spends the daily per-uid quota faster than an owner. A role-split cache key (a viewer-only brief cached separately) is a possible follow-up.
6. **Live Call Brief eval.** Follow [CALL-BRIEF-LIVE-EVAL](../runbooks/CALL-BRIEF-LIVE-EVAL.md): `--init` outside the repo, label about 20 real calls, then the Haiku and Sonnet `--live` runs.

## Gaps

- **Demo path.** `customer-calls.js` renders only on `/pro/customer(.html)`, so in the demo (`/pro/explore/customer`) the Calls card says "Loading calls…" for every role. Older than these lanes; the screenshots patch the path check in the shot script only.

## Q11 task-summary backfill (2026-11-09)

The backfill for item 1 of "What Jo must run or decide" now exists: `scripts/backfill-q11-task-summaries.js`. **It has not been run against production. `--apply` needs Jo's OK.**

- **What it does.** It reads every `leads/{leadId}/tasks` doc whose id starts with `cube-`, `sms-` or `thursday-`, and puts its notes through `scrubTaskSummary` (`functions/call-center-logic.js`; `'thursday'` mode for `thursday-` tasks). It writes only when that changes the notes, and then only `notes` plus `updatedAt` (server time, as every server-side task write in `functions/call-center.js` does), with `update()`. It never deletes a task, never touches other prefixes, top-level `/tasks`, or already-clean notes. A second run finds 0 to change.
- **Output is counts only** (scanned, skipped, clean, to scrub per prefix, written, failures). It never prints notes or a write's error text.
- **Dry run (the default, read-only):**
  - `node scripts/backfill-q11-task-summaries.js` (every company)
  - `node scripts/backfill-q11-task-summaries.js --company <companyId>` (one company: `lead.companyId`, or `lead.userId` for a lead with no `companyId`)
  - Credentials: ADC, or token mode with `NBD_ACCESS_TOKEN=$(gcloud auth print-access-token)`. Token mode uses `scripts/_firestore-rest.js`, which now has a collection-group query (`collectionGroup(id).orderBy('__name__').limit(n).startAfter(doc).get()` over `documents:runQuery`).
- **Write:** the same command with `--apply`, only after Jo's OK.
- Test: `tests/q11-task-summary-backfill-2026-11-09.test.js` (node bucket), against a fake Firestore and a fake REST server.
