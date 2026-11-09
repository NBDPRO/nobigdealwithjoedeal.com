# SESSION 2026-11-09: NBD OS P2 (Activities, the action runner, Peek and Recap, drive-off, Coach AI line, Team)

**Lane:** CRM / NBD OS. **Branch:** `os-p2` (worktree `.claude/worktrees/os-p2`, on top of `os-p1`), not pushed at the time of writing.
**Design:** [NBD-OS-HOME-DESIGN-2026-11-09](NBD-OS-HOME-DESIGN-2026-11-09.md) §6 and §8 "P2" (its "What shipped in P2" section, at the top, points back here).
**Prior phase:** [SESSION-2026-11-09-nbd-os-p1](SESSION-2026-11-09-nbd-os-p1.md). **Handoff:** [NEXT_SESSION-2026-11-09-nbd-os-p2](NEXT_SESSION-2026-11-09-nbd-os-p2.md).
Everything here is dark behind `osLayout` (and `osSystemLayer` for the tray and Control Center), for every tenant. The two server pieces have their own gates (below).

## 1. What shipped (six lanes, a P1 follow-up lane, one integration pass, one final fix round)

- **Activities and Focus modes** (`docs/pro/js/os/acts.js`, `acts-logic.js`; the `acts`/`on` fields of the `os-home` key). Job-phase desks (Leads, Inspect/Claim, Build, Collect), Storm day, and "In a home" (privacy). A storm alert offers Storm day with a one-tap toast; nothing switches a mode by itself.
- **The action runner** (`docs/pro/js/command-runner.js`, the lazy `cmdrunner` bundle). Verbs on palette rows (Open, Call, Text, Navigate), providers, Quick Keys, type-anywhere and a hot corner on the laptop desk, with a Control Center switch.
- **Drive-off and photos.** "Safe to drive off?" in the Control Center, photos in the tray.
- **Pre-flight Peek and the Welcome Recap** (`os/peek.js`, `peek-logic.js`).
- **Coach AI focus line** (`functions/coach-line.js`, `coach-line-logic.js`, `os/coach-ai.js`). One sentence a day from the rules Coach's counted evidence, opt-in per company (`companyProfile.coachAiEnabled`), a digit / number-word post-check, 3 a day per user and 60 a day per company. Kill switches `aiDisabled` and `coachLineDisabled`. Rules suite `tests/firestore-rules.os-coach-ai.test.js`.
- **Team** (`functions/leaderboard-aggregate.js`, `-logic.js`, `os/team.js`, `pages/leaderboard.js`, `company-timezone-settings.js`). `leaderboard/{uid}` rows every 30 minutes: today's and this week's doors, appointments set, estimates sent and deals, in the company time zone (`companyProfile.timeZone`). An owner-only Team widget (S/M/L), the Leaderboard page reading the rows, demo rows (seed v11). Gate `LEADERBOARD_AGGREGATE_ENABLED` (dry run otherwise). Rules suite `tests/firestore-rules.os-team.test.js`.
- **P1 follow-ups.** Bento builds its board math from `layouts/board-logic.js` (one copy, not two); a daily goals editor in the large Daily Success widget; the urgency ring's missed calls are the member's own; four ASC composite indexes and an index scanner that reads an inequality's implicit sort as ascending; a new Smart Stack holds Shutdown.

## 2. Decisions and readings (for the PR body)

- **Smart Stack default: Shutdown replaces Coach.** The lane said to add Shutdown "when a stack has room (<4 cards)". The P1 default already held four (`upnext`, `storm`, `daily`, `coach`), so there was never room: `STACK_DEFAULT` is now `['upnext', 'storm', 'daily', 'shutdown']`, Shutdown in Coach's place (Coach was only the evening rule's fallback). It reaches a new stack and any saved stack whose items list has no valid card (`stackItems` falls back to the default); P1's add always saved items, so few rows should be affected. Saved cards are kept.
- **"In a home" scope.** It filters the home widgets, the Notification Center, toasts (Do Not Disturb), Peek, the Recap and the Coach AI line. A phone app opened from the home (Pipeline, Money) still shows money and names. The design's wording ("hides pipeline $") reads as the home widgets, so this is the reading taken.
- **coachLine is `read-paid` for viewers** (`tests/viewer-callables.test.js`): a viewer sees the same Coach, so may ask for its line. That means a viewer can use up the company's 60-a-day cap, 3 at a time. Deliberate.
- **leaderboardAggregate's dry run counts one company.** While the gate is off, each run counts only the first company by id (`DRY_RUN_COMPANIES = 1`) and logs it, instead of billing every company's member, knock, lead and jobs reads 48 times a day.

## 3. Final fix round (2026-11-09)

One commit each, test first:

1. `leaderboardAggregate` keeps its resume cursor when a run runs out of time before its first company (`next` was null, so the scheduler wrote `cursor: null`).
2. `leaderboardAggregate` skips a member row in a company the user left: every member's `users/{uid}.companyId` is checked, not only an owner with no member row, so two companies no longer rewrite and flip the same `leaderboard/{uid}`. Costs one `users` get per member.
3. The dry run counts one company per run (§2).
4. The `STACK_DEFAULT` comment says what the swap reaches (§2).

## 4. Open items and known gaps

- **Turn-ons wait on Jo:** ~~`LEADERBOARD_AGGREGATE_ENABLED=true` (and deploy the four new indexes first)~~ done 2026-11-09 (§6), and per company `coachAiEnabled` (still a per-company setting in Firestore, not code).
- **The stale row race.** When a member has left a company, the old company deletes the row it wrote and the new one writes its own. With four companies running at once, the delete can land after the new company's write on that first run; the next run writes it back. Once only.
- **Real-iPhone pass** for the phone pieces is still open, as in P1.
- **pro-demo-zero-network** needs Playwright `chromium_headless_shell-1254`; this sandbox has `-1243`, so the browser suites ran through a launch shim pointing at the 1243 binary. CI installs its own browser.

## 5. Verification

Gates and suites run on the branch head: `check-js-syntax`, `run-test-manifest --check`, the dashboard boot budget, the full node bucket, `tests/smoke.test.js`, the new rules emulator suites (`os-team`, `os-coach-ai`), and the three browser suites (through the shim above). Screenshots stay in the scratchpad, not committed.

## 6. Update 2026-11-09: the Team leaderboard aggregate is on

Jo approved turning it on. `functions/.env.nobigdeal-pro` now has `LEADERBOARD_AGGREGATE_ENABLED=true` under a dated comment (Jo, 2026-11-09; the four ASC composite indexes from #3019, and the jobs collectionGroup `userId`/`updatedAt` ASC index the aggregate's jobs query uses, were added to `firestore.indexes.json` in #3019, and `firebase-deploy.yml` deploys that file; their prod build status was not checked from this session, so confirm each shows Enabled in the Firebase console: a missing jobs index falls back to no job-lead map (its query has a try/catch), a missing knocks or leads index makes that company's query throw). `functions/flags-registry.js` no longer marks it dark and the `cron-gates.js` comment says it is on. Pinned in `tests/flags-registry-drift.test.js` and `tests/nbd-os-team-aggregate-2026-11-09.test.js` §8. `coachAiEnabled` is untouched (a per-company prod setting). No other gate changed.

**What changes when it deploys.** Every 30 minutes the run counts EVERY company (the dry run's one-company cap, `DRY_RUN_COMPANIES`, only applies while the gate is off), writes each active member's `leaderboard/{uid}` row, deletes the row of anyone no longer an active member, and keeps its resume cursor in `system/leaderboardAggregate`. The Team widget and the Leaderboard page then show real rows instead of their fallback.

**Is a run's read cost bounded?** Yes, by four things in `functions/leaderboard-aggregate.js`:

- **One run at a time:** `maxInstances: 1`, scheduled every 30 minutes (48 runs a day).
- **Deadline + cursor:** `timeoutSeconds: 300`; no new company group starts after `BUDGET_MS = 240000` (4 minutes); where it stopped goes to `system/leaderboardAggregate.cursor` and the next run resumes after it and wraps round. A large tenant set is spread over runs, not re-read from the top.
- **Member cap:** at most `MAX_MEMBERS = 50` members counted a company (`users/{uid}` gets capped at 51).
- **Per-query cap:** each member's three queries (knocks since Monday, leads updated since Monday, jobs written since Monday) are `limit(CAP)` with `CAP = 2000`; the extra lead gets for jobs whose lead was not updated are at most the jobs returned.

**Reads per run, per company** (from the code; Firestore bills at least one read for a query that returns nothing). With `M` members counted, `R` member rows on file, and for member `i` this week's `K` knocks, `L` leads updated, `J` jobs written and `X` leads read only through a job:

```
1 (company doc, from the paged companies query) + 1 (companyProfile) + max(1, R) (members)
+ min(M + 1, 51) (users docs)
+ sum over members of [ max(1, K) + max(1, L) + max(1, J) + X ]
+ max(1, existing leaderboard rows)
```

plus, per run, one `system/leaderboardAggregate` read. Writes per run: `M` row sets (every row is restamped so `asOfMs` shows the last run), plus a delete per departed member, plus one cursor write when a cursor is in play.

**NBD-sized estimate** (code limits and a stated assumption, not prod data). NBD is one company, owner-run (`M` = 1 to a few):

- **Floor, a quiet week (nothing counted yet, Monday morning):** a solo owner with a member row is 1 + 1 + 1 + 1 + 3 + 1 = **8 reads a run**, **384 a day** (48 runs), and 48 writes a day. Each extra member adds about 5 reads a run (member row, users doc, three empty queries), about 240 a day.
- **Every doc counted adds one read per run** until the week resets on Monday: a knock, lead or job touched this week costs 48 reads a day for the rest of the week. Illustration (assumed volume, not measured): 150 knocks + leads + jobs touched by Sunday, accruing evenly, averages about 75 a run over the week, so about 8 + 75 = 83 reads a run, **about 4,000 reads a day**, and about 7,600 a day on Sunday at the peak.
- **Code ceiling for one company:** 50 members x (2000 + 2000 + 2000 + 2000) + 51 + 50 + 3 + R, about **400,000 reads a run**. Not reachable at NBD's size; the 4-minute budget cuts a run short well before it and the cursor carries the rest.
- **Other tenants:** each other company costs its own floor (8 reads a run for a solo owner, so 384 a day each) plus its own counted docs; `C` companies add `C` company-doc reads a run to the paging query.

To pause it: set `LEADERBOARD_AGGREGATE_ENABLED=false` in `functions/.env.nobigdeal-pro` and redeploy (the run falls back to the one-company dry run).

**Not bounded by a limit (noted, not changed):** the members subcollection read and the company's existing-`leaderboard` rows read have no `limit()`. Each is one read per document on file, so it tracks the company's own member count; only the 50-member cap on what is counted and written applies after the read.
