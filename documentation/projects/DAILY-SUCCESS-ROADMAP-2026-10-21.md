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
   outbound texts stay owner-approved and flag-gated; A2P is Verified, 2026-10-19).
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

## Update 2026-10-21 (afternoon): second opinion and the next build phases

Shipped since the first version of this plan: Repeat last workout (#2635), drop / failure set tags (#2637), the finish-screen
recap (#2638), custom exercises ("My exercises"), plus the phone sweep fixes (#2630, #2632) and the test-hardening PRs.

**Second opinion (Grok, asked 2026-10-21; claims as it tagged them).** Ranking by real daily value for serious lifters:

1. **Saved routines / templates** - highest daily value; the core Strong / Hevy loop (VERIFIED by its sources).
2. **Offline-first reliability** - basement gyms and dead zones; logging must never depend on the network (VERIFIED).
3. **RPE / RIR auto-regulation** - strong for intermediate-plus lifters (LEAD).
4. **Weekly review page** - useful, secondary to in-session logging (LEAD).
5. **Body measurements + progress photos** - lowest daily value for strength-focused users (LEAD).

Its "most wanted and still missing": Apple Watch logging (a web app cannot do this - needs a native app, so **not planned**),
first-class RPE / RIR history, and muscle-volume maps / weekly set-balance visuals (we already show a balance card; a weekly
view is the gap). Public review threads agree on simplicity, a free tier without caps, routines and custom lifts. Treat all of
this as leads, not requirements; Jo's own gym use outranks it.

### Phase 2A - Saved routines (build next)

- Save the current or a finished workout as a named routine ("Push A"); a routine is the lifts, set counts and weights, no reps.
- The coach card lists routines under Start; tapping one opens the workout from it (same path as Repeat last, with last weights
  refreshed from history and warm-ups regenerated).
- Rename, delete, reorder; device-local like the other coach settings (cloud copy only if Jo wants it).
- Done when: save / start / rename / delete / corrupted-storage tests with mutation checks, and a real-browser run at 390 px.

### Phase 2B - RPE as a first-class number

- RPE history per lift (trend of top-set RPE next to the e1RM line) on Progress and in workout history.
- RPE-aware targets that **explain** themselves ("last top set was RPE 7 - add 5 lb") and never change a weight silently;
  hold when the last top set was RPE 9.5+. Off by default until Jo turns it on.
- Done when: pure-logic tests for every branch (no RPE logged = today's behaviour), and the screen shows the reason.

### Phase 2C - Offline confidence

- Recon first (do not guess): what `docs/pro/sw.js` already caches for `/pro/daily-success`, and whether a cold open with no
  network works. Logging already writes to the device first; the gap is opening the page offline and showing "not synced yet".
- A visible sync state ("saved on this phone" vs "synced") on the finish screen and the day page.
- The service worker touches cached signed-in pages, so any change there gets the security reviewer and Jo's morning look
  before it is queued.

### Phase 3 - Weekly review and the volume map

- Sunday review page: floors hit, workouts, calories vs target, PRs, volume by muscle (sets per week, this week vs last),
  one thing to change. Uses stored data only; no new collection.
  **Update 2026-11-04 (recon):** the weekly review sheet already existed (2026-10-02, `review-logic.js` / `review-ui.js`: floors,
  weigh-in rule, next-week targets for workouts and calories, day wrap-ups, hard thing). The missing piece was the training
  section: workouts, PRs and hard sets per muscle vs last week, now `week-training-logic.js` shown in that sheet and added to the
  copied scorecard and the bot snapshot (draft PR). Nothing else of this item is open.
- Muscle-volume map: weekly working sets per muscle group as bars with the target band, building on the balance card.
  (Shipped, #2653.)

### Phase 4 - Measurements and photos (last) - SHIPPED

- Body measurements next to weight on the Progress tab; progress photos stay on-device or in the signed-in user's own
  Storage, never a public path (see the public-repo constraint).
  **Update 2026-11-04 (recon):** already on main. Measurements and on-device progress photos shipped in #2662; photos are
  owner-stamped and hidden from other accounts, and a shared-phone sign-out purges them (#2719); measurement text survives
  re-renders (#2724). Photos stay in the phone's IndexedDB as re-encoded JPEGs with EXIF/GPS stripped; there is no Storage path or
  URL. Tests: `tracker-measurements-photos-2026-10-22`, `tracker-photos-owner-gate-2026-10-23`,
  `tracker-photos-account-purge-2026-10-23`. Nothing left to build here.

### Status 2026-11-04 (Jo's picks after the interface lineup)

Phases 1-4 are done or in review: the Sunday review's missing training section is draft PR #2802. Ideas taken from a screenshot of
another app, each its own draft PR waiting on Jo's real-iPhone look: the 12-month activity heatmap (#2803), the volume map's
Week / 30d / 90d / All range toggle (#2804), the Stats tile row (#2806) and workout dots on the week-at-a-glance strip (#2808).
Already existed, so not built: the coach's "why this target" line (the target note under every lift) and the week strip itself.
Demo images and animations for lifts are parked: the other app's media is licensed to that app only, and the free exercise dataset's
images have no stated origin, so nothing is shipped until Jo shoots his own or buys a licence. The ideas themselves live in Jo's
private vault note, not in this repo.

Order can change if Jo reports something broken on his phone or a required CI check fails on main.
