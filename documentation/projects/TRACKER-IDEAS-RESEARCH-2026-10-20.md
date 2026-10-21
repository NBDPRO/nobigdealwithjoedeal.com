# Tracker ideas research (2026-10-20)

Jo's ask (2026-10-20): "deep research GitHub repos for anything to add to coach,
daily success, workouts, anything in the daily tool. You can even ask Grok too."
This note is **research only**. Nothing here is built; Jo picks, then each pick
becomes its own PR. It extends
[DAILY-TRACKER-REVAMP-PLAN-2026-09-29](DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md)
(read its 2026-10-20 sections for what already exists).

## Ground rules used

- **Ideas only, never code.** No repo was cloned or run. Facts below come from
  each repo's README and the GitHub API (`gh api repos/...`, 2026-10-20).
- **AGPL / GPL / unlicensed = idea only**, flagged in the table. MIT /
  Apache / BSD / Unlicense are the safest to learn from, but we still write our
  own code (vanilla JS, strict CSP).
- **Grok was a lead source only** (via Chrome, short chunks). Every repo it named
  was checked with `gh`. Misses are listed at the bottom.
- Jo's habit, from the plan: he repeats the same routines and gets repetitive
  without a plan, so **variety plus intensity tracking** is what to favor.

## What the tracker already has (so none of this is proposed twice)

Checked in `docs/pro/daily-success/js/workout-coach-logic.js` and
`workout-coach.js`: pattern-slot rotation (least-recent exercise per slot, anchor
held 1-6 sessions), "Switch it up", per-slot swap options filtered by equipment,
`nextSplit` rotation, per-set reps / weight / RPE, double-progression targets,
auto-PRs, `variety()` score, a rest timer with `restFor()` (150 s compound, 75 s
other) and vibration, est. 1RM chart and weekly volume (`progress-charts-*`),
weight trend, food log, Find a food. A grep finds **no** warm-up sets, plate math,
deload / stall logic, per-muscle counts, injury exclusions, supersets, readiness
input, adaptive calorie target, photos or export in the daily-success JS.

## Repos drawn from (all verified to exist, license from the GitHub API)

| Repo | Stars | Last push | License | Use |
|---|---|---|---|---|
| [DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym) | 14,157 | 2026-10-20 | AGPL-3.0 | **idea only** |
| [astashov/liftosaur](https://github.com/astashov/liftosaur) | 749 | 2026-10-20 | AGPL-3.0 | **idea only** |
| [TraceApps/nutritrace](https://github.com/TraceApps/nutritrace) | 343 | 2026-10-20 | AGPL-3.0 | **idea only** |
| [gymcoach-app/gymcoach](https://github.com/gymcoach-app/gymcoach) | 111 | 2026-10-20 | MIT | ok to learn from |
| [Limekana/limelog](https://github.com/Limekana/limelog) | 5 | 2026-10-19 | MIT | ok to learn from (tiny repo) |
| [Cawlumm/lyftr](https://github.com/Cawlumm/lyftr) | 360 | 2026-10-16 | MIT | ok |
| [brandonp2412/Flexify](https://github.com/brandonp2412/Flexify) | 449 | 2026-10-20 | MIT | ok |
| [InlitX/GymMane](https://github.com/InlitX/GymMane) | 1,001 | 2026-10-18 | GPL-3.0 | **idea only** |
| [simonoppowa/OpenNutriTracker](https://github.com/simonoppowa/OpenNutriTracker) | 2,727 | 2026-10-20 | GPL-3.0 | **idea only** |
| [iSoron/uhabits](https://github.com/iSoron/uhabits) | 10,339 | 2026-10-19 | GPL-3.0 | **idea only** |
| [FriesI23/mhabit](https://github.com/FriesI23/mhabit) | 1,666 | 2026-10-20 | Apache-2.0 | ok |
| [daya0576/beaverhabits](https://github.com/daya0576/beaverhabits) | 1,846 | 2026-09-17 | BSD-3-Clause | ok |
| [oliexdev/openScale](https://github.com/oliexdev/openScale) | 2,595 | 2026-10-19 | GPL-3.0 | **idea only** |
| [wger-project/wger](https://github.com/wger-project/wger) | 7,159 | 2026-10-20 | AGPL-3.0 | **idea only** (skimmed, nothing new) |
| [yuhonas/free-exercise-db](https://github.com/yuhonas/free-exercise-db) | 2,028 | 2026-09-27 | Unlicense | public domain data |
| [CodeWithCJ/SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness) | 6,426 | 2026-10-20 | none declared (API: NOASSERTION) | **idea only** |
| [emreloper/apple-health-api](https://github.com/emreloper/apple-health-api) | 44 | 2023-01-09 | none | **idea only**, stale |
| [mm/heartbridge](https://github.com/mm/heartbridge) | 34 | 2023-02-14 | MIT | ok, stale |
| [Dzarlax-AI/health_dashboard](https://github.com/Dzarlax-AI/health_dashboard) | 1 | 2026-10-17 | MIT | ok (1 star; weak source) |

openGym is only three months old (created 2026-07-18) but is clearly real and
actively shipping. It is the richest feature list found and a very close match
for what Jo said he wants.

## Ranked ideas (top 10)

Size: S = a day or less, M = a few days, L = a week or more. "Data" = new stored
fields. "Policy" = Firestore / Storage rules, CSP or a new Cloud Function.

### 1. Muscle and pattern balance, "what's untrained" nudge. Verdict: BUILD

- **What:** Count hard sets per muscle group (and push:pull ratio) over the last 7
  days, and flag groups with zero or low sets this week. openGym shows a map of
  volume, what's still recovering, and what's gone untrained; Liftosaur has a
  muscle map; GymMane a muscle timeline.
- **Extends:** `workout-coach-logic.js` (`variety()` sits beside it) and the
  Progress card (`progress-charts-*`).
- **Size:** S for a pattern-based version (the library already tags every exercise
  with a `pattern`), M if each exercise gets a real primary-muscle tag.
- **Data / policy:** none for v1 (reads finished sessions). A muscle tag is a
  static library field, not stored user data. No policy change.
- **From:** openGym (AGPL, idea only), Liftosaur (AGPL, idea only), GymMane (GPL,
  idea only).
- **Why for Jo:** this is the variety feature made visible. It answers "what did
  I skip this week" in one glance and can feed "Switch it up" a bias toward the
  neglected group.

### 2. Stall detection, then deload-or-swap suggestion. Verdict: BUILD

- **What:** If an exercise's best weight/reps has not improved across 3
  sessions, suggest a 10% deload or swapping to a sibling exercise. Optional
  planned deload every N weeks. Limelog flags 3-session plateaus and suggests a
  deload; openGym triggers a deload on stalls and never adds load after missed
  reps; Liftosaur lets you script deload logic.
- **Extends:** `targetFor()` in `workout-coach-logic.js` (it already holds weight
  on a miss or grind but never says "this is a plateau") and the anchor-rotation
  logic (`FRESHNESS`).
- **Size:** M.
- **Data / policy:** none for stall detection (derived from sessions). A planned
  deload week would need one setting. No policy change.
- **From:** Limelog (MIT), openGym (AGPL, idea only), Liftosaur (AGPL, idea only).
- **Why for Jo:** the stall is exactly when he gets bored and repeats routines; the
  coach should answer with a swap, not just "hold".

### 3. Warm-up set generator. Verdict: BUILD

- **What:** For the first heavy exercise, add warm-up rows as a percentage of the
  first working set (for example 40/60/80%) plus the bar. Liftosaur and openGym
  both do this; defaults per exercise, editable.
- **Extends:** `buildSession` / the live logger in `workout-coach.js`. Warm-up sets
  must be marked so `workingSets()`, volume, est. 1RM and PRs ignore them.
- **Size:** S-M. The risk is polluting volume and PR math, so it needs a test that
  warm-ups never count.
- **Data / policy:** one `warm` flag per set. No policy change.
- **From:** Liftosaur (AGPL, idea only), openGym (AGPL, idea only).
- **Why for Jo:** he lifts heavy compounds; typing warm-up numbers by hand is the
  friction that makes people skip warming up.

### 4. Plate calculator. Verdict: BUILD

- **What:** Show "45 / 25 / 10 per side" next to the target weight, from a plate
  inventory Jo sets once (and bar weight). openGym also does EZ and trap bars.
- **Extends:** the set row / target line in `workout-coach.js`; the setting lives
  with the coach settings (`dsCoach` synced through `userSettings`, like equipment).
- **Size:** S. Pure arithmetic (greedy, smallest remainder).
- **Data / policy:** one small settings object. No policy change.
- **From:** Liftosaur (AGPL, idea only), openGym (AGPL, idea only). The math is
  textbook; no code is needed from anyone.
- **Why for Jo:** one-thumb time saver at the rack; pairs with warm-ups.

### 5. "Avoid" list (injury / pain gating). Verdict: BUILD

- **What:** Let Jo mark a movement pattern or a single exercise as "avoid for now"
  (sore shoulder, bad knee); the coach never offers it in rotation or swap
  options. Limelog gates by pattern or exercise with an override and a warning.
- **Extends:** `candidatesFor()` / `swapOptions()` (the same place equipment is
  already filtered) plus a chip row beside "Equipment I have".
- **Size:** S.
- **Data / policy:** one array in coach settings. No policy change.
- **From:** Limelog (MIT).
- **Why for Jo:** a roofer's shoulders, knees and back; "switch it up" must never
  hand him the lift that hurts.

### 6. One-tap readiness check-in. Verdict: MAYBE

- **What:** Three taps at the start of a session (sleep, soreness, energy) that
  trim today's volume by a set or hold the load when the score is low. GymCoach
  has a readiness check-in that autoregulates load; openGym and Dzarlax show
  recovery guidance from sleep, HRV and resting HR.
- **Extends:** `buildSession()` (set count) and the day page, which already tracks
  a "Sleep 7+ hrs" floor.
- **Size:** M.
- **Data / policy:** one readiness record per day. No policy change for manual
  taps; HRV-driven versions need item 9 first.
- **From:** GymCoach (MIT), openGym (AGPL, idea only), Dzarlax (MIT, 1 star).
- **Why maybe:** plausible, but easy to ignore. Build 1-5 first; add this only if
  Jo says the coach feels too rigid on rough days.

### 7. Adaptive maintenance-calories estimate. Verdict: MAYBE (after weight import)

- **What:** Estimate maintenance calories from the smoothed weight trend and
  average logged intake over 2-3 weeks (calories in minus weight change times
  about 3,500 kcal per lb) and show it as "your real maintenance is about N". Idea
  appears in NutriTrace (regression over a window, 7,700 kcal/kg), the 3-Suns
  adaptive-TDEE spreadsheet, and OpenNutriTracker (tapering the goal near target).
- **Extends:** `food-log-logic.js` targets (today a calorie target only exists if
  Jo types one) and `tracker-history-logic.js` (the 7-day weight average).
- **Size:** M.
- **Data / policy:** none new, but it only works with several weeks of both
  weights and calorie totals. No policy change.
- **From:** NutriTrace (AGPL, idea only), OpenNutriTracker (GPL, idea only),
  3-Suns spreadsheet (no license, idea only).
- **Why maybe:** needs the Active Era import first, and Jo hand-types macros, so
  calorie data is thin. It must say "not enough data yet" rather than guess
  (house rule: never invent a number). This is general self-tracking math, not
  medical advice.

### 8. Export everything (JSON, plus CSV for sessions). Verdict: MAYBE-BUILD

- **What:** A "Download my data" button for sessions, food, weight and settings.
  openGym, OpenNutriTracker and GymCoach all stress full export with nothing
  paywalled.
- **Extends:** the Sunday review / settings area; reads the existing
  `nbd_ds_*` stores.
- **Size:** S (Blob download; no CSP change).
- **Data / policy:** none.
- **From:** openGym (AGPL, idea only), OpenNutriTracker (GPL, idea only).
- **Why:** cheap insurance for years of lifting history. Low excitement, high
  safety.

### 9. Apple Health ongoing weight (and sleep) via iOS Shortcut. Verdict: MAYBE, later

- **What:** After the one-time file import, an iPhone Shortcut POSTs the day's
  weight (and sleep) to a small endpoint so Hume readings arrive by themselves.
  Seen in emreloper/apple-health-api (Shortcut to Firebase), mm/heartbridge,
  Dzarlax (uses the Health Auto Export app).
- **Extends:** the weight import already planned in the revamp plan.
- **Size:** L.
- **Data / policy:** **yes, security-sensitive.** It needs a new Cloud Function
  with a per-user secret token, rate limits and rules review (use the
  `nbd-security-reviewer` agent). Not a quick add.
- **From:** emreloper (no license, idea only, stale), heartbridge (MIT, stale),
  Dzarlax (MIT).
- **Why later:** manual entry plus a file import covers Jo today. Do it only if
  typing the weight daily is a real annoyance. openGym's route (import an Apple
  Health weight export file) is the no-endpoint alternative and is already the
  plan.

### 10. Supersets. Verdict: MAYBE

- **What:** Pair two slots so the logger alternates sets (A1, B1, A2, B2) and
  the rest timer runs once per pair. openGym supports supersets, drop sets and
  rest-pause.
- **Extends:** the live logger and `startRest` in `workout-coach.js`; a "pair
  with next" flag on a slot.
- **Size:** M-L (logger flow changes are the risky part).
- **Data / policy:** one pairing flag per exercise. No policy change.
- **From:** openGym (AGPL, idea only).
- **Why maybe:** a roofer short on time likes supersets, but the logger rework is
  bigger than its payoff. Revisit after 1-5.

## Looked at and not recommended

- **Forgiving habit score** (uhabits, mhabit, beaverhabits). uhabits scores a habit
  by weighting recent days so a few misses after a long streak do not zero it.
  **Skip:** the tracker already runs "don't miss twice" streaks and floors
  checked from the CRM (Jo's personal OS, 2026-10-02). If anything, show a
  strength percentage in the Sunday review (S, optional).
- **Alternating rotation (A, B, C)** from openGym. **Already built** as
  `nextSplit()` and the split rotations.
- **Progress photos with before/after slider** (openGym, Liftosaur). **Skip for
  now:** body photos need new Storage paths and rules, and nobody asked. Revisit
  only if Jo wants it.
- **Scriptable programs (Liftoscript).** Skip: large, AGPL, and pattern-slot
  rotation is already the right idea for Jo.
- **Bigger exercise library with demos** (openGym lists 5,600; wger, free-exercise-db).
  Skip for now; the 68-exercise library is a feature (a short, curated list). If
  Jo wants how-to cues later, free-exercise-db is Unlicense (public domain) text
  and images, but images would need a CSP / hosting decision.
- **Meal plans and prep batches** (GymMane). Skip; favorites and "same as
  yesterday" cover Jo's repeat-meals habit.
- **AI coach / MCP** (GymCoach, openGym). Skip: the Anthropic key stays
  server-side and Jo's personal bot keys already read the tracker; a coach that
  rewrites programs adds surface for little gain over items 1-2.
- **Structural balance ratios** (Poliquin and others in openGym): fold into item 1
  as a push:pull number; do not build separately.

## Grok pass (grok.com via Chrome, three short questions)

Everything Grok said was treated as a lead and checked with `gh api`.

| Grok said | Verified? |
|---|---|
| DuarteSantos8/openGym, Limekana/limelog, astashov/liftosaur, WhyAsh5114/MyFit | Real. Features match the READMEs (openGym planned deloads and stall deloads, Limelog phases and stall detection, Liftosaur scripted deloads). |
| `Julien-Au/gymcoach` | **Wrong owner: 404.** The real repo is `gymcoach-app/gymcoach` (MIT). |
| `francescoalemanno/tdee-adaptive` | **404.** Only `francescoalemanno/TDEE-Tracker-UI` exists (0 stars, MIT). Grok's "two-state Kalman filter" claim was **not checked**; treat as unverified. |
| TraceApps/nutritrace, Rors78/golden-nutrition-ai, CodeWithCJ/SparkyFitness, 3-Suns fork | Real. NutriTrace's README confirms 7,700 kcal/kg regression. golden-nutrition-ai has 1 star. SparkyFitness has no declared license. The 3-Suns repo is an unlicensed fork. |
| Apple Health ingestion repos (heartbridge, apple-health-api, apple-health-mcp, LIA-Assistant, apple-health-export, health_dashboard) | All exist, but mostly stale or 0-7 stars; two have no license, LIA-Assistant is AGPL. Grok's "weighted HRV + RHR + sleep readiness score" for health_dashboard was **not verified** in code. |

Grok found nothing the GitHub search missed that changed the ranking. It was
useful for the Apple Health shortcut repos and the adaptive-TDEE lineage.

## Suggested order if Jo says "go"

1. Items 5 + 4 + 3 together (avoid list, plate calculator, warm-ups): all
   small, all in the coach, one PR each.
2. Item 2 (stall to swap/deload), then item 1 (balance nudge).
3. Item 8 (export) any time as filler.
4. Items 7 and 9 only after the Active Era weight import lands.

Any build must follow the usual gates: pricing tests do not apply here, but
`node tests/smoke.test.js`, the daily-success unit tests and
`node scripts/check-inline-html-scripts.js` do, and warm-up sets in particular
need a test proving they never count toward volume, e1RM or PRs.
