# Daily Success + Call Center roadmap (2026-10-21)

Planned ahead with Jo after the 10-21 tracker revamp (audit, ten themes, accordion day page, coach Previous / rest alert /
history / PRs, Call Center filters). Everything here is a **plan, not a promise**: before building an item, recon
`origin/main` first (plan docs go stale; the gap is usually smaller than written). Decisions Jo already made are in
[NEXT_SESSION-2026-10-21](NEXT_SESSION-2026-10-21.md) and the overnight log
([OVERNIGHT-LOG-2026-10-20](OVERNIGHT-LOG-2026-10-20.md)); the visual audit is
[daily-success-visual-audit-2026-10-21](../qa/daily-success-visual-audit-2026-10-21.md).

## Horizon 1 - finish and prove what shipped (next sessions)

| # | Item | Done when | Needs Jo? |
|---|------|-----------|-----------|
| 1 | Light-theme end-to-end sweep | Day page, Food, Fitness, coach, Progress on every light and high-contrast skin at 360 / 390 / 412 px: no overflow, taps >= 44 px, no unreadable text; fixes shipped | no |
| 2 | Test-pin cleanup, round 2 | `rem` / `em` font-size pins, inline handlers built by concatenation, the Call Center tab-click path driven by a test, `?v=` pins that die on every bump replaced by "script is versioned and loaded" | no |
| 3 | Real-iPhone pass | Jo (or a recorded run) uses the installed app in daylight: readability, hit targets, rest alert sound, Wake Lock | **yes** - only a real phone proves it |
| 4 | Shard2 / shard3 E2E | Cause of the CI-only failures found (non-required today, but they hide real E2E regressions); either fixed or split / capped deliberately | no |
| 5 | Handoff + docs | One Current handoff, the audit doc and INDEX accurate | no |

## Horizon 2 - the tracker as a daily tool (weeks)

Ordered by what Jo uses most (the gym and food floors), not by novelty.

1. **Workout templates / routines.** Save a day as a template ("Push A"), start it with last weights prefilled. Builds on
   Previous-per-set and prefill. Strong's core loop.
2. **Set types and finish summary.** Warm-up / drop / failure tags (warm-ups already excluded from PRs and Previous), a
   one-screen finish summary with volume, PRs and time. High-rep days stay first-class (never capped or dropped).
3. **Exercise library depth.** Custom exercises, notes per exercise, swap-in suggestions that respect the avoid list.
4. **Body measurements + progress photos** on the Progress tab. Photos stay on-device or in the signed-in user's own
   Storage; never a public path.
5. **Weekly review (the Sunday review).** One page: floors hit, workouts, calories vs target, PRs, one thing to change.
   Uses data already stored; no new collection.
6. **Apple Health / Active Era import.** Apple Health setup walk-through (Jo); Active Era needs sample export rows
   before any parser is written.
7. **Offline-first and install polish.** Add-to-Home-Screen icon and splash, a clear offline banner, queued cloud sync with
   a visible "not synced yet" state (a failed save already keeps the workout open).
8. **Themes round 2.** A custom accent picker on top of the ten skins; keep the contrast gate (every pair is
   WCAG-checked in `daily-success-themes`).

## Horizon 3 - Call Center (weeks)

The date / range / Today / Last 24 hours / direction / order system is live. Next, in order:

1. **Status and missed-call filters** (Jo to confirm which statuses matter).
2. **Saved views** ("Missed today", "Unhandled this week") on top of the one saved-filter record already persisted.
3. **Follow-up reminders from a call** that write a note / reminder into the Agent inbox path (never auto-texting;
   outbound texting is off until A2P approval).
4. **Counts that match the screen everywhere** (people, not rows, on Needs attention - already the rule).

## Cross-cutting (every horizon)

- **Quality gate for new tests.** Every behaviour change ships with positive + negative controls and a mutation run;
  source-regex pins strip comments first (done for the 2026-10-21 tests in #2628) and prefer driving the real screen
  through the DOM harness (`tests/helpers/coach-ui-harness.js`).
- **Phone-fit.** Real-browser checks at 360 / 390 / 412 plus desktop; the phone-fit gate stays in CI.
- **Accessibility.** A VoiceOver pass on the day page, coach and Call Center (labels on icon buttons, focus order, live
  regions for the rest timer). Not yet done with a real screen reader.
- **Safety rails that do not move.** No prod writes, no flag flips, no credentials, nothing sent to customers, no
  pricing / contract / insurance wording, no rules or auth changes without a security review. Revenue shown is collected only.

## What would change the order

- Jo reports something broken on his phone -> that goes first.
- A required CI check starts failing on main -> fix before any new work.
- Jo picks a different top feature in Horizon 2 -> reorder; items 1 and 2 are the most Strong-like and the best bet.
