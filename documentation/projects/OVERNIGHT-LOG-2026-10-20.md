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
