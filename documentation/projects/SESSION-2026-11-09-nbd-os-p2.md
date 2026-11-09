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

- **Turn-ons wait on Jo:** `LEADERBOARD_AGGREGATE_ENABLED=true` (and deploy the four new indexes first), and per company `coachAiEnabled`.
- **The stale row race.** When a member has left a company, the old company deletes the row it wrote and the new one writes its own. With four companies running at once, the delete can land after the new company's write on that first run; the next run writes it back. Once only.
- **Real-iPhone pass** for the phone pieces is still open, as in P1.
- **pro-demo-zero-network** needs Playwright `chromium_headless_shell-1254`; this sandbox has `-1243`, so the browser suites ran through a launch shim pointing at the 1243 binary. CI installs its own browser.

## 5. Verification

Gates and suites run on the branch head: `check-js-syntax`, `run-test-manifest --check`, the dashboard boot budget, the full node bucket, `tests/smoke.test.js`, the new rules emulator suites (`os-team`, `os-coach-ai`), and the three browser suites (through the shim above). Screenshots stay in the scratchpad, not committed.
