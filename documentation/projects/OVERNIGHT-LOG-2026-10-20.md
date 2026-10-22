# Overnight log - 2026-10-20 / 21

Running log of the hourly review-and-improve cycles Jo asked for on the night of 2026-10-20
("do any and all the research and review you want ... every hour or two, then small improvements,
fixes, changes and upgrades"). One dated section per full cycle: what was checked, found, changed,
and what was left for Jo and why. Hard limits for the night: no production writes, no flag flips, no
credentials, nothing sent to customers, no pricing / contract / claim wording, no security-rules or
auth changes without a morning look, no history rewrites.

Handoff for the morning: see the Current handoff pointer in [INDEX](../INDEX.md).

## Cycle 1 - 03:00-03:40 UTC (theme: CI health)

**State found.** Everything planned for the night had merged and deployed: Download my data (#2599), the
research note (#2597), the bundle (#2608: iPhone barcode scan, adaptive calories, seven coach upgrades),
the shard split (#2609) and the Apple Health weight endpoint (#2606, dark). Live checks passed: decoder
file hash matches, tracker scripts served, `world.openfoodfacts.org` allowed only on `/pro/daily-success`,
the health ingest endpoint answers 404 to anonymous POSTs while its flag is off.

**Finding - the split worked for `@shard3`, not for `@shard2`.** First full runs of the split shards on main
(run 39532002721): `@shard3` finished in 21.9 min with 174 passed, 4 failed, 6 did not run; `@shard2`
was still cancelled at the 25 min cap because failing specs burn three attempts each. Neither shard is a
required check, so nothing was blocked. The four `@shard3` failures were not new bugs: these specs had
never run to completion in CI (the old `@shard2` always timed out first), and three had drifted from the
product while one exposed a real UI bug.

| Spec | Cause | Fix |
|---|---|---|
| `phone-estimate-funnel` | asserted the old "Continue is refused without SMS consent" (SMS box became optional in #2461) and the old trust-line copy | runs both paths (ticked / unticked), asserts `tcpaConsent` equals the box, pins the current "Real Google reviews" line |
| `phone-home-nav` | looked for the "N people need you" strip chip, which the phone UX pass (Oct 13-14) deliberately hides while Today lists the same call | asserts the Today "Calls owed" row, the hidden duplicate chip, and a thumb-sized call-back button in the first screen |
| `phone-home-nav` + `phone-no-next-step` | **real product bug:** the fixed Record visit bar covered Home's last card ("More on Home"), so it could not be tapped | CSS fix (below) |
| `visit-recorder` | `.nbd-vr-unfiled` now matches two buttons ("Recent visits" reuses the class); a comment and a tap had been merged onto one line so the tap never ran | locator narrowed to the badge, line restored |

**The real bug.** `visit-recorder.css` reserves `padding-bottom: 74px` for Home "on top of the nav room",
but `dashboard-app.css` forces `.view-scroll { padding-bottom: calc(80px + safe-area) !important }` at
`max-width:768px`, which beat the plain rule. Home only cleared the nav; the last card sat under the bar.
The old unit test only checked the rule's text existed, so it passed while the bug was live. Fixed with a
phone-only `!important` rule (nav 80px + bar 74px), keyed on `html.nbd-vr-bar-on`; new test
`visit-recorder-home-clearance-2026-10-21` models the cascade and has a control that reproduces the bug on
the pre-fix stylesheet.

**Verification.** Each spec was run locally against the emulators (hosting + auth + firestore + storage, no
functions emulator so no alerts can fire): estimate funnel 2 passed, home-nav 4 passed, no-next-step 1
passed, visit-recorder 4 passed; the pre-fix runs failed at exactly the assertions above. Break checks turn
the new tests red.

**Left for Jo / next cycles.**
- `@shard2` is still not finishing: its failing specs (call-center-card, crew-calendar, inbox-layout,
  layouts, mission-control) are the next thing to reproduce the same way.
- Local E2E needs a free port 8080 for the Firestore emulator; another local process held it, so the runs
  used a temporary local-only port change that was not committed.
- Not done on purpose: anything that needs a phone in hand (barcode camera, downloads, the Apple Health Shortcut).

## Cycle 3 - 08:00-09:00 UTC (theme: CI health + a Grok conferral)

**Checked.** Open PRs: #2611 (this handoff, docs) and #2612 (below), both waiting on CI, auto-merge on, nothing failing.

**`@shard3` reproduced locally.** The full shard run locally under CI conditions (`CI=1`, same spec order, local
emulators only) finished **185 passed (18.1 min)**, including all four `visit-recorder` tests. So the CI-only
failures are environmental, not a plain product bug. What the CI log and trace artifact show on main (run
39540483464): `visit-recorder.spec.js:105` fails on its retries with 3 `.nbd-vr-item` rows where it expects 1
(unfiled visits accumulate in the shared emulator between attempts; the first attempt's own error is not printed by
the line reporter), and `:201` ends on the Estimates view, never showing the "marked do not record" sheet. Next:
download the retry traces and read attempt 0, or make the spec clean its own `visit_captures` first. `@shard3` is
not a required check. `@shard2` is still to reproduce.

**Built (#2612).** Workout Coach: read-only "Last time (Oct 16): 185x5, 185x5" under each lift's target, and a live
trophy on the single best ticked set that beats the lift's prior best estimated 1RM (warm-ups, unticked sets and
ties never count). Pure logic in `workout-coach-logic.js` (`lastTime`, `livePR`); 23 new checks with controls; the
existing coach suites pass.

**Grok conferral (Jo's go-ahead).** One chat on grok.com, no repo, no customer data. Its tracker gap list
(prefill, rest timer, Watch, last-time + PR, big targets) overlapped what we had apart from the last-time/PR
context, which is what #2612 adds; Apple Watch is not feasible in a web app. Its CRM advice (audit speed-to-lead
first, then estimate follow-up) and its benchmark numbers are **leads, unverified**. A second question on Epley for
high-rep sets and the adaptive-calories window did not send (the page froze while typing); retry later.

**Left for Jo.** Same list as the handoff; nothing new needs a decision.

## Cycle 4 - 05:00-07:30 EDT (theme: the tracker on a phone, at Jo's direction)

Jo took over the cycle with "visually inspect, scrutinize and fix the daily success program" and answered a short
questionnaire (themes, dev button, day layout, door stats, coach extras, rollout). Done in this stretch:

- **Audit and fixes (merged):** #2613 audit note, #2615 default-theme tokens, #2616 phone layer, #2617 dark card skin + ten
  themes; root causes, numbers and the one correction are in
  [daily-success-visual-audit-2026-10-21](../qa/daily-success-visual-audit-2026-10-21.md).
- **Coach (merged):** #2612 last-time line + live PR trophy, #2614 rep-range PR (volume sets earn their own trophy; Jo likes high-rep
  days).
- **Queued in the merge queue:** #2618 coach Previous per set + rest alert setting, #2619 collapsible day sections + sticky
  Today bar + door stats hidden until used, #2620 Call Center filters (date / range / Today / Last 24 hours / direction / order,
  Jo's other request). Coach workout history is built and waits behind #2618.
- **Method:** every behaviour change got a test with controls and a mutation run (each new guard proven red); layout was
  checked in a real browser at 360, 390, 412 and 1100px; a real-data run exercised the main flows. The shard3 CI-only
  failures (visit-recorder) remain unexplained: all 185 pass locally.
- **Housekeeping:** five merged scratch worktrees removed; page storage key learned (`nbd_dsp_v1`); the Grok conferral covered
  Epley above 12 reps (it agrees it drifts; we keep high-rep sets via the rep-range PR) and adaptive-calories windows (ours
  match its ranges).
- **Left for Jo:** nothing new needs a decision tonight; see the handoff.

## Cycle 5 - 07:30-10:00 EDT (theme: adversarial review of the new tracker code)

Two review passes, both on code merged in cycle 4. Findings were verified before acting.

- **Silent-failure review** (read-only agent): three real defects, fixed in #2625 - finishing a workout cleared the live
  session even when the phone refused the write (workout lost); a bodyweight lift (0 lb) never earned a live Rep PR because the
  gate was "best 1RM above zero"; the section toggle wrote storage unguarded. New test
  `coach-save-failure-2026-10-21.test.js` is red against the old sources. Call Center review fixes merged as #2624 (filter
  count wording, storage guard, footer oldest/newest).
- **Vacuous-test audit** (about 330 mutations over the seven 2026-10-21 tests): the logic tests are sound (themes contrast 100/100,
  filters 48/54). Behaviour gaps closed in #2626 (filter validation, describe labels, most-reps rep PR, no done flag, first-ever
  lift claims no PR, percent rounding), each mutant verified killed. **Left open:** source-regex pins that a commented-out
  line or reworded value still satisfies (Today-bar call sites, tap-target and `font-size` pins that miss `rem`, `on'+'click`
  concat, `.btn` rule membership), `?v=` literal pins, and the Call Center tab-click path never being driven
  (a tab click calling `clearFlt()` would pass). Worth one cleanup PR.
- **Merge-queue note:** #2625 left the queue on a manifest conflict (my two new tests added adjacent entries); resolved by
  keeping both. GitHub's PR head then stayed on the old SHA after the merge push (branch ref was right); an empty commit
  did not help, close + reopen did. Queue entry cleared the auto-merge flag again.
- **CI:** @shard2 and @shard3 fail on every recent PR (including docs-only-adjacent ones); both are non-required. Cause still
  unexplained; shard3 passes locally.
- **Left for Jo:** nothing new needs a decision.

## Cycle 6 - 10:00-12:00 EDT (theme: CI health, plus the phone sweep Jo asked for)

- **Shard failures explained (no longer "unexplained").** Read the real job logs. The failing @shard3 specs are **different on
  every run**: a PR run failed `phone-quick-wins-part2` ("a saved choice still wins") and `yard-signs-edit` (map off-pin text),
  both on 5000 ms expect timeouts, then hit the job cap ("The operation was canceled"); a main run failed `visit-recorder`
  (181 passed, 13.7 min). A rotating set of 5 s timeouts at the cap is a **slow / overloaded shard**, not one broken test and
  not our tracker changes. Both shards stay non-required. Proposed fix (not built; CI config, wants Jo's nod because it
  changes the E2E split): split @shard3 in two or raise the expect timeout for emulator specs. Logged in the roadmap, item 4.
- **Light-theme / phone sweep** (ten skins x 360 / 390 / 412 px, real browser, overflow + tap targets + text contrast): no
  horizontal overflow anywhere. Real finding: the header button strip scrolls sideways with a hidden scrollbar, so DELETE, CSV,
  PDF and SAVE are off-screen with nothing saying so; fixed in #2630 (edge fade + end spacer, pinned). Open: a few 11 px labels
  at the floor, the 15 px tab-close x, one orange chip at 4.14:1 on the dark card. The contrast probe cannot read the dark hero
  cover (image background), so those hits are noise.
- **PRs open from me:** #2628 (comment-blind test pins), #2629 (roadmap), #2630 (header strip). No new build this cycle (three
  open, queue busy).
- **Left for Jo:** the shard3 split-vs-timeout call above.

## Cycle 7 - 12:00-14:30 EDT (theme: adversarial review of the new Repeat-last feature, plus merges)

- **Shipped:** #2633 (type floor now catches rem/em and `font:` shorthand and covers every tracker sheet; a test drives the real
  Call Center tab click), #2634 (handoff refresh) and #2635 **Repeat last workout** (same lifts, per-set weights, blank reps; the
  coach card button sits beside Start; first item of the roadmap).
- **Silent-failure review of #2635** (read-only agent, then verified by reading the code): one real defect - a repeated lift had
  no target, because history never stores one, so ticking a set without typing reps stored `reps: 0` and the set vanished from
  history, PRs, volume and Previous. Fixed in the same PR: every repeated lift now carries a target (weight, reps to beat, stall
  check). Also fixed: equipment setting honoured, today's readiness carried, "Skipped N lifts" toast, button shown only when there is
  something to repeat. Low items left: a non-numeric stored weight reads as bodyweight.
- **Merge queue:** #2634 left the queue once on a required `@stranger` failure (the first provisioning step timed out at 30 s on a
  loaded runner, then the retries cascaded); it was docs-only and merged on the next queue attempt. Jo authorised me to decide merge
  order and timing ("everything up and live"), so I re-queue my own green PRs after a runner-timing failure.
- **Left for Jo:** the shard3 split-vs-timeout call (cycle 6); nothing new.

## Cycle 8 - 14:30-17:30 EDT (theme: Repeat-last follow-ons, custom lifts + routines, and the review of both)

- **Shipped:** #2635 Repeat last workout, #2637 drop / failure set tags, #2638 finish-screen recap (volume vs last time, best set
  per lift), #2640 **My exercises** (custom lifts) + **saved routines**, #2639 roadmap update with the second opinion.
- **Second opinion (Grok, asked via its chat; claims tagged by it):** routines > offline reliability > RPE auto-regulation > weekly
  review > measurements/photos; Apple Watch logging is the biggest gap but a web app cannot do it (not planned). Folded into
  [DAILY-SUCCESS-ROADMAP-2026-10-21](DAILY-SUCCESS-ROADMAP-2026-10-21.md) as phases 2A-4. Public review threads agree (simplicity,
  free tier without caps, routines, custom lifts).
- **Silent-failure reviews (read-only agent, every claim traced before acting):** #2635 had one real defect (repeated lifts had no
  target, so a bare tick stored `reps: 0`); #2640 had six (31st routine dropped but "Saved", >10 sets became 3, failed storage
  writes ignored, stale tab overwrites, slug collisions, misleading skip toast) - all fixed in #2641 with tests and mutation
  checks. **Left open:** custom lift definitions and routines are device-local (a session with a custom lift logged on another
  device is skipped by the weekly balance card), custom lifts are always non-compound (no warm-ups), routines drop the superset flag.
- **Queue notes:** #2634 left the queue once on a required `@stranger` timeout (runner load) and merged on the next attempt; a
  conflicting PR after another asset-version bump (#2638 vs #2640) was resolved by keeping both sides and the higher versions.
- **Left for Jo:** nothing new needs a decision. Next: phase 2B (RPE history and explained targets), then 2C (offline recon).

## Cycle 9 - 17:30-19:30 EDT (theme: the tracker on a phone, with the new coach screens)

- **Shipped:** #2641 (review fixes for custom lifts and routines), #2643 (RPE: target notes say the effort behind the call, top-set
  RPE trend on the lift card; the superset golden digest was re-blessed with proof that only the RPE wording moved it), #2642 (the
  cycle 8 log).
- **Phone sweep** of the coach card, a live workout and the settings (custom lifts, routines, drop-set tags, RPE history in play) at
  360 / 390 / 412 px: no page overflow, no clipped controls, no console errors. One real bug: a long saved-routine name ran 110 px
  out of the card (`.btn` is nowrap and 32 px tall); fixed in #2644, pinned, verified in a real browser. Chips and the set-number
  button are 33-43 px wide but 44 px tall (above the WCAG 2.2 AA 24 px floor; the set-number button widens its hit area).
- **Phase 2C recon (read-only):** `docs/pro/sw.js` keeps offline shells for `/pro/dashboard` and `/pro/customer` only. The tracker is
  not one of them, so opening it with no signal probably fails today. Planned fix touches cached signed-in pages: security reviewer
  first, PR opened but **not queued** until Jo has looked.
- **Left for Jo:** nothing new needs a decision tonight; the 2C offline-shell PR will wait for a morning look.

## Cycle 10 - 19:30-22:15 EDT (theme: security review of the offline-tracker design)

- **nbd-security-reviewer on the offline-tracker proposal** (read-only; every finding traced in code):
  - **F1 HIGH:** adding the tracker to the shared "refresh all shells" message would let an unrelated dashboard visit overwrite the
    tracker shell with HTML whose `?v=` scripts this phone never fetched, killing the offline open. Design fixed before building:
    the tracker shell is **request-only**, stored by the tracker's own page after its assets loaded.
  - **F3 MEDIUM (existing bug):** the tracker had no account-switch purge, so on a shared phone user A's local pages and workouts
    could merge into user B's cloud account. The tracker never wrote `nbd_last_uid`.
  - F4 low: offline, cloud pushes wait for signal (local saves are safe). F5 low: a captive-portal 200 could be stored as the shell.
- **#2646** - the tracker opens with no signal: third app shell in `docs/pro/sw.js`, request-only, key-selected messages (the
  payload never becomes a URL), HTML + title-marker check, exact offline paths only. 45 checks, 11/11 mutants killed; real
  Chromium: shell stored on visit 2, network OFF, reload opens the tracker. The existing two-shell test is unchanged.
- **#2647** - account-switch purge in the tracker's sync, before any cloud read/write; waits up to ~3 s for `nbd-auth.js`, pauses the
  sync (badge "Sync paused") rather than merge another account's data. Runs the real module in a vm: 22 checks, 7/8 mutants killed
  (the survivor is equivalent).
- **Process slip to know about:** I opened both as HOLD PRs (cached pages / tenant isolation need Jo's look) with auto-merge OFF,
  and turned auto-merge off again on #2646 when GitHub showed it enabled right after creation. About 15 seconds later the same
  GitHub account re-enabled auto-merge and queued both; they **merged at 21:27 and 21:34 EDT** (not by any command of mine in this
  session - most likely a merge-watcher routine or another session acting as that account). Both passed the required checks, the live
  site serves them (`/pro/sw.js` has the tracker shell, `offline-shell.js` 200), but they went in **without the morning look I
  promised**. Please read both PR bodies; rollback for either is a revert of that PR (the `?nosw=1` / `/pro/nosw.txt` kill switch also
  disables the worker).
- **Reviewer asks not done (rules are out of scope tonight):** a Firestore rules test that user B cannot update
  `users/A/ds_pages` / `ds_workouts`; a preview-channel `curl -I` of `/pro/daily-success` (200, no redirect).
- **Left for Jo:** a look at #2646 / #2647 now that they are live, and a decision on how HOLD PRs should be protected from merge
  watchers (a "hold" label the watcher respects, or draft PRs).

## Cycle 12 - 00:45-09:00 EDT, Oct 22 (theme: a required check failing at midnight; session close-out)

- **Incident:** "Unit suites (manifest)" (a REQUIRED check) failed on #2649 and #2650 at 00:13 ET, both unrelated to the change.
  Cause was my own `call-center-filters-2026-10-21` test: its "today" calls sat 1 / 2 / 3 hours ago, which are *yesterday* in New York
  before 3 am, so ten Today / Needs-attention checks failed. It had never run in that window (written at ~5 am). Any PR whose queue run
  landed between 00:00 and 03:00 ET would have been blocked. Fixed in #2651 (fixtures are fractions of the time since New York
  midnight); proof with a faked clock: old test 68 passed / 10 failed at 00:13 ET, new test 78 / 0 at 00:00:30, 00:13, 02:30, 12:00 and
  23:59 ET. Failed jobs on #2649 / #2650 re-run after morning; all three PRs were in the merge queue at close-out.
- **Lesson recorded:** a test that uses the wall clock needs a faked-clock run (a `Date` preload) at the edges of the day, not just the
  hour it was written.
- **Close-out:** the hourly overnight cron job (`822cd497`) is cancelled. Worktrees `nbd-wt-road` / `nbd-wt-doc` are removed after their
  PRs land (junctions removed with `cmd //c rmdir` first).
- **Still open for Jo:** how HOLD PRs should be protected from merge watchers (#2646 / #2647 merged past their hold; see cycle 10), a
  look at those two PRs, and the real-iPhone pass. Everything else shipped this session is merged and live; the roadmap is
  [DAILY-SUCCESS-ROADMAP-2026-10-21](DAILY-SUCCESS-ROADMAP-2026-10-21.md) (phase 2C offline shipped via #2646; next is the Sunday
  weekly review + muscle-volume map, then measurements and photos).
