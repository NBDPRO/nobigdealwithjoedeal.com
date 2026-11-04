# NEXT_SESSION - 2026-11-04: Daily Success lane (Jo's picks), ideas from another app, dependency check

**Session of 2026-11-04 (Jo's "check in on the layouts", then "what can we use from this screenshot").** This is the brief for the
Daily Success tracker lane only. The repo-wide live brief is still [NEXT_SESSION-2026-10-26](NEXT_SESSION-2026-10-26.md); its lanes
(site program, Grabber, Life of a Roofer) were not touched here.

## Where things stand

- **Layouts:** all eight are live on main with `ready: true` (status in
  [DAILY-SUCCESS-INTERFACES-2026-10-22](DAILY-SUCCESS-INTERFACES-2026-10-22.md)). Nothing is left to build for the lineup.
- **Phase 4 (measurements and photos):** already shipped (#2662, #2719, #2724). The roadmap said otherwise until
  [#2809](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2809) corrected it.
- **The Sunday review sheet already existed** (2026-10-02, `review-logic.js` / `review-ui.js`); only its training section was missing.
- **Update, end of session: Jo approved everything ("get everything moving in queue").** All eight PRs below were marked ready and
  have auto-merge on; they land through the merge queue as their checks pass. To keep them from dequeuing each other on
  `MERGE_CONFLICT`, each PR's `ci-manifest.json` line was moved to its own spot in the array and the `index.html` script/link
  tags were moved to lines no other PR touches; a throwaway merge of all eight onto main was clean and their tests plus the older
  daily-success suites passed. #2814 was retargeted to `main` (it contains #2808's commits, which merge identically). The real-iPhone
  look still has not happened, so it now happens on main: if something reads wrong, fix it as one small PR.
- **The PRs (originally drafts, each waiting on Jo's real-iPhone look; Auto-fix on):**

| PR | What | Pure logic + test |
|---|---|---|
| #2802 | Training block in the weekly review (workouts, PRs, sets per muscle vs last week) in the sheet, the copied scorecard and the bot snapshot | `week-training-logic.js`, `ds-week-training-2026-11-04.test.js` |
| #2803 | 12-month activity heatmap under the Progress card (scrolls inside its box, labels 11px) | `heatmap-logic.js`, `ds-heatmap-2026-11-04.test.js` |
| #2804 | Volume map range chips Week / 30d / 90d / All (weekly averages vs the 10-20 band) in the coach card | `volume-range-logic.js`, `ds-volume-range-2026-11-04.test.js` |
| #2806 | Stats tile row (workouts, this month, week streak, 30-day weight) | `stats-logic.js`, `ds-stats-tiles-2026-11-04.test.js` |
| #2808 | A workout dot under each day of the week-at-a-glance strip (strip maths moved into `weekStrip()`) | `day-layout-logic.js`, `ds-week-strip-2026-11-04.test.js` |
| #2814 | The same strip at the top of the dashboard (**stacked on #2808**: base branch is #2808's; retarget to `main` when #2808 merges) | `weekstrip-ui.js`, `ds-dash-week-strip-2026-11-04.test.js` |
| #2813 | CRM: read-only "Includes $X in supplements" chip on the customer page's invoice rows (reads the stored `supplementTotal`; never compares with the estimate, because a deposit + final job would make that misleading) | `invoice-supplement-chip-logic.js`, `invoice-supplement-chip-2026-11-04.test.js` |
| #2812 | `functions/`: log-only. One `owner_fallback_used` warning (uid, never the email) when the deprecated email fallback in `isOwnerCaller()` is the only reason an owner passes. No behaviour change. **Production auth code: Jo's go.** | `owner-fallback-log-2026-11-04.test.js` |

  Every test was mutation-checked (a deliberate break of the code fails it). `ds-layouts-phone-fit` needs Playwright, which the
  local checkout lacks; CI runs it.

## Needs Jo

1. **A real-iPhone pass** over the drafts (Weekly review, Progress, the Workout Coach card, a day page, the dashboard, a customer
   with an approved supplement) and the eight layouts. Report what looks wrong; one small PR each. Mark the good drafts ready.
2. **Demo images/animations for lifts: ON HOLD (Jo, 2026-11-04: "skip for now").** openGym's media is licensed to openGym only
   (gymvisual.com). The free exercise dataset (Unlicense) traces back to `wrkout/exercises.json`, which names no image source, and its
   README sells a separate set as the commercial one: not used. A second research pass found nothing free, animated, commercial-safe
   and customizable: wger images are CC-BY-SA per image (attribution); RepDB's free tier is static (animations are paid, hosting
   terms unverified); `hasaneyldrm/exercises-dataset` is non-commercial; Posecode's renderer is AGPL-3.0. Revisit only if Jo shoots
   his own or buys a licence; the empty image slot in the coach was deliberately not built.
3. **Owner claims (for #2812):** are both owner accounts carrying the `owner: true` claim? Jo was not sure. After #2812 ships, search
   the function logs for `owner_fallback_used`; zero entries for a week means the fallback can be retired in its own PR.
4. **Dependabot PRs:** see the next section. Merging anything under `functions/` is Jo's go.
5. The lemo-opuscar plugin (film styles made in code) is installed at user scope; it downloads to `~/lemo-opuscar` and runs
   commands on first use. Use it only with a named topic. Uninstall: `claude plugin uninstall lemo-opuscar@lemolab`, then delete
   `~/lemo-opuscar`.

## Dependency PRs, checked 2026-11-04

- **Update (end of session):** Jo said go. `@dependabot rebase` was posted on #2781 and #2783 (their checks then ran green); #2786
  (`@sentry/node` 11.10, `google-auth-library` 11.3.2, `resend` 6.37, `stripe` 23.1: minor and patch only) has auto-merge on and
  lands through the queue when its checks are green. #2773 and #2780 were not touched. The roadmap and three stale plan docs below
  were corrected in #2809 and #2811.
- Original check: the red checks on #2781 and #2783 are from old runs on stale bases: a `follow-redirects` 1.16.0-1.16.1 HIGH advisory in the
  dependency audit and `google-calendar-sync-2026-09-29.test.js`. Main already has `follow-redirects` 1.16.2 and main CI is green,
  so a rebase should clear them. #2773 (gcp-metadata patch bump, lockfile only) is clean; #2786 is a 16-package non-major group
  in `functions/` and needs a read of the version jumps before it merges. The branches are 15 to 25 commits behind main.
- Posting `@dependabot rebase` on a PR is a comment on Jo's repo; ask first.

## Stale plan docs, scanned 2026-11-04 (read-only; leads, not yet re-verified by hand)

A read-only scan checked 12 plan-style docs in `documentation/projects/` against `origin/main`. Nothing was edited. Three most need
a correction, in this order:

1. **PRO-DEMO-PHASE2-FULL-ACCOUNT-PLAN-2026-10-06:** its two "Next" lines are done. Waves 1-4 merged together in #2294, the
   `/pro/sandbox` Explore button is live (`docs/pro/sandbox.html` links `/pro/explore`), and tool pages join the sample account
   (#2725, #2726). Only "save as my real account" and the open questions remain.
2. **BUILD-PLAN-2026-10-18** ("locked order, nothing built yet"): shipped are the own-document expiry watcher (#2526), the
   supplement-letter claim-wording filter (#2525), the tracker Sunday review (#2710), review-response drafts (REPUTATION-LOOP) and
   food search (#2590). Still open: the estimate-vs-invoice diff and the canvass priority list; 30/60/90 cash buckets unclear.
3. **DAILY-TRACKER-REVAMP-PLAN-2026-09-29** ("Status: plan only"): phases 2-4, food search, export and the coach upgrades are
   built; the weight import from Active Era is the only item open (it needs a sample export).

Also: NBD-PRO-PRODUCT-STATUS-2026-10-22 should say the sample account is linked from the demo story and slug freeze shipped (#2700);
its `OWNER_EMAILS` fallback (`functions/handlers/_shared.js`) and hardcoded `success_url` (`functions/stripe.js`) are still open.
BUSINESS-QUEUE-RECON, WAVE3-UPGRADES-RECON and CALL-CENTER-HORIZON3 each have built items (#2676/#2694, #2701, #2678,
#2664/#2620/#2698) next to genuinely open ones. CALENDAR-HUB phase 4, FOLLOW-UP-BOARD, JOB-COMPLETION-LOOP and GAMES-PAUSE items
could not be matched to a commit (unclear, not stale). CHARACTER-STYLE-PLAN is cancelled and fine. Re-check each claim against
`origin/main` before editing a doc.

## Lessons from this session

- **Recon `origin/main` before building from any plan or screenshot.** Two of the day's asks (phase 4, the Sunday review) and two of
  the openGym ideas ("why this target", the week strip) already existed. Check with a grep before a worktree.
- **Older tests pin legacy inline code.** Refactoring the week strip broke four pins (the ink expression, `day-layout-logic.js?v=2`,
  `progress-charts-ui.js?v=1`, the days-array anchor); bump versions with a regex `\d+` in new tests, and run every
  `daily-success-*`, `ds-*`, `tracker-*` and `coach-*` test file, not just the new one.
- The Rings test forbids unscoped rules in `layouts.css`: put new styles in a new stylesheet. The phone-readability test needs
  11px or larger text, and an SVG scaled down to fit shrinks its text below that: keep real size in a scroll box (`direction: rtl`
  opens it on the newest weeks).
- A hook blocks `git stash` and `sed -i`; edit with the Edit tool or a Node script that keeps each file's line endings. In a
  heredoc, escape backslashes carefully: a `\d` regex lost its backslashes once.
- Ideas stay out of the public repo. Jo's private vault note "Ideas Parking Lot" has the 2026-11-04 rows.

## Local clean-up (after the PRs merge)

Scratch worktrees under `C:\Users\jonat\` that belong to this lane (every other `nbd-wt-*` folder belongs to another session):
`nbd-wt-sunday-review`, `nbd-wt-heatmap`, `nbd-wt-range`, `nbd-wt-stats`, `nbd-wt-dots`, `nbd-wt-dashstrip`, `nbd-wt-supchip`,
`nbd-wt-ownerlog`, `nbd-wt-staledocs`, `nbd-wt-handoff`. Remove each with `git worktree remove` once its PR merges (the roadmap
one, `nbd-wt-roadmap`, is already gone: #2809 merged). `nbd-wt-ownerlog` holds an untracked `functions/node_modules` from a local
`npm ci`; removing the worktree with `--force` clears it.
