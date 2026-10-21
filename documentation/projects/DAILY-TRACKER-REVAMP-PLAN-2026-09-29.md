# Daily tracker revamp plan — 2026-09-29

**Status:** plan only. It needs Jo's sign-off on the §6 questions before building.

**Jo's ask (2026-09-29):** "really revamp the daily program / life tracker side.
especially the gym / fitness / food log / health tracker / workout trainer /
workout creator / tracker." **Scope Jo picked: all four areas.** Those are
workout creator/tracker, food/macro log, health metrics, and daily habits plus
work floors.

## 1. What exists (`docs/pro/daily-success/`, verified against the tree)

- `js/app.js`: 1,506 lines. One "page" per day holds a **flat string map**
  (`p.data['ex-3-weight'] = '185'`, `p.data['diet-m2-p'] = '40'`).
  - Workouts are free-text rows (name/sets/reps/weight/notes).
  - Food is 5–6 fixed meal rows of hand-typed macros.
  - PRs are one text box per lift. "History" is rebuilt by scanning every page.
  - Body metrics are six text boxes.
- `ds-firebase-sync.js`: pushes every page to `users/{uid}/ds_pages/*` in **one**
  `writeBatch`.

### Bugs to fix whatever else happens

1. **Settings and goal targets are wiped at every sign-out.** `nbd_user_config`
   (floors, bodyweight) and `nbd_gt` (door/revenue/close targets) live only in
   localStorage under the `nbd_` prefix, which `purgeAccountStorage` clears at
   logout. Only pages and streaks sync. This is the same class as the Home-widgets
   bug fixed in #1865.
2. **Deleted pages come back.** The sync merges cloud pages into local ones and
   never records a delete, so the next sign-in restores what was deleted.
3. **Sync breaks at about 500 pages.** One `writeBatch` holds at most 500 writes,
   so after roughly 16 months of daily pages every sync fails.
4. **Unescaped values in the HTML templates.** For example, the diet inputs write
   `value="${d[...]}"` with no escaping. Today it's only the user's own data, but
   a coach or team view (§3) would make it cross-user.
5. **No tests** cover any of it.

## 2. Direction

Keep one daily page as the home screen: it's how Jo already uses it. Replace the
flat string map with **structured records** that the daily page *reads*:

| Area | New model (Firestore, per user) | What it unlocks |
|---|---|---|
| Workout creator | `workoutTemplates/{id}`: named plan (Push A), ordered exercises with target sets×reps×weight and rest time | Start today's workout from a template in one tap |
| Workout tracker | `workoutSessions/{id}`: date, template, per-set actual reps/weight/RPE, duration | Real progression charts, auto-detected PRs (estimated 1RM), "beat last time" targets |
| Exercise library | `exercises` (built-in list + custom): muscle group, equipment | Consistent names, so PR history actually lines up |
| Food log | `foodLog/{date}`: entries `{food, servings, p, c, f, kcal}` + a `foods` favorites list | Saved meals, one-tap re-log, daily macro rings vs targets |
| Health metrics | `bodyMetrics/{date}`: weight, BF%, tape measurements, sleep, resting HR, steps | Trend lines; weekly averages instead of noisy daily weight |
| Habits & work floors | `userSettings.dailyFloors` + `dailyLog/{date}` checkmarks | Streaks; floors auto-checked from CRM data (doors, appointments, revenue collected) |

The **work-floor auto-checks** already exist in spirit (`autoCheckFloors`,
`autoCheckRevenueFloor`, `buildCRMContext`). They get re-pointed at real CRM
numbers. Revenue is **collected only**, per the standing rule.

## 3. Build phases

**Phase 0 — stop the bleeding. Small, and ships first.**
- Move `nbd_user_config` and `nbd_gt` to `userSettings/{uid}` (the #1865 pattern)
  and hydrate them on boot.
- Delete tombstones (`deletedAt`) so a delete survives the next sync.
- Chunk the page sync into batches of 400 or fewer.
- Escape every template value.
- Tests: pure merge/tombstone logic and the chunker, red-first.

**Phase 1 — workouts (the piece Jo named first).**
- Template builder: add exercises from the library, set targets, reorder.
- Live session screen: big tap targets, a rest timer, and "last time: 185×8"
  next to each set.
- Auto-PR on session save. The PR board is computed from sessions, never typed.
- Charts: per-lift estimated 1RM over time, and weekly volume.

**Phase 2 — food log.**
- Quick-add with macros, favorites, "same as yesterday", and macro rings against
  a target computed from bodyweight and goal.
- A barcode or food database (Open Food Facts, which is free) is optional and
  only added if Jo wants it.

**Phase 3 — health metrics and habits.**
- Weight trend (7-day average), measurements, and sleep.
- Habit streaks.
- Floors auto-checked from the CRM.

**Phase 4 — import the old pages.** A one-time migrator turns the old
`ex-N-*` / `diet-m*` / `pr-*` strings into sessions and log entries, with a
dry-run preview first. Old pages stay readable either way.

## 4. Phone first

It's used at the gym, on a phone, one-handed. Every new screen gets a
`phone-fit` spec at 360/412 and is tested as the **installed** iPhone app, per
the standing phone rule.

## 5. Not in scope unless Jo asks

- Apple Health / Google Fit sync. Possible later via a Shortcut that posts to a
  callable, but not part of v1.
- Coach or team views. They'd need rules work plus the escaping from Phase 0.

## 6. Questions for Jo

1. **Workout style:** mostly the same few routines (templates matter most) or
   different every day (a fast free-log matters most)?
2. **Food logging:** hand-type macros (fast, what exists now), or do you want a
   food search / barcode scan?
3. **Health metrics:** which ones do you actually track? Weight, BF%,
   measurements, sleep, steps, resting HR?
4. **Old pages:** migrate them into the new charts (Phase 4), or start fresh and
   leave the old pages read-only?

Phase 0 fixes live bugs, so it can start on a yes to this plan without waiting
on these answers.

### Jo's answers (2026-09-29) — do not relitigate

1. **Workouts:** Jo repeats the same routines and gets repetitive without a
   plan. **Variety is the feature.** Phase 1 becomes a *coach*, not just a log:
   - templates plus automatic rotation that swaps exercises within the same
     muscle group or movement pattern, so a week doesn't repeat
   - per-set reps, weight and intensity (RPE)
   - progressive overload suggestions ("last time 185×8 at RPE 7 → try 190×8")
   - a "switch it up" button that rebuilds today's session with fresh variations
2. **Food:** no answer yet. The default is hand-typed macros plus saved
   favorites; ask again before Phase 2.
3. **Health metrics:** weight only, from a **Hume** smart scale. Phase 3 shrinks
   to a weight trend. A Hume → Apple Health → Shortcut import is a possible
   follow-up; v1 is manual entry.
4. **Old pages:** Jo left it to us. **Decision: migrate** lifts, PRs and
   bodyweight into the new model with a dry-run preview first, and keep the old
   pages readable. The history is what makes the progression charts and
   "last time" targets useful from day one.

### Update 2026-09-29 — Phase 3 (weight) and Phase 4 (lifts) shipped

- **Weight card** (`js/tracker-history-ui.js`, rules in
  `js/tracker-history-logic.js`). It reads the weight box that day pages
  already have (Body Metrics → `data['bm-wt']`), so there is no new place to
  type.
  - It shows the latest reading, the 7-day average, and how that average moved
    against last week and against 30 days ago, with a sparkline.
  - Readings outside 60–700 lb are treated as typos.
  - It sits on the program dashboard and on top of each day page's Fitness
    section.
- **Old workouts → coach.** The Fitness section offers "Bring N days of old
  workouts into the coach". It shows a preview first (days, lifts, recognized,
  and the names it could not recognize), then imports on tap.
  - Recognized names map to the coach library through an alias table, then
    exact name, then word overlap. It never guesses a tie.
  - Unrecognized names are kept under their own names, so no history is lost,
    but they do not drive targets.
  - Session ids are `imp_<pageId>`, so re-running imports nothing twice.
  - Sessions go to `nbd_ds_workouts` and the `ds_workouts` cloud mirror.
- Not migrated: the old free-typed PR strings, which the coach recomputes from
  sessions, and diet rows (food logging is still unanswered).
- Test: [tracker-weight-history](../../tests/tracker-weight-history-2026-09-29.test.js)
  (34 checks). Verified on the emulator with synthetic pages: 9 days imported,
  and a re-run found 0.

### Update 2026-09-29 (evening) — Phase 2 (food) shipped on the default

Jo still hadn't picked a style and said "do all 3 that you can", so this is
the plan's default. Jo can ask for barcode lookup (Open Food Facts) later.

- **The 🍽 Food card** sits on top of the Diet section. It writes into the
  existing four meal rows (`data['diet-m{i}-*']`), so meals save and sync
  with the day page. There is no new collection and no rules change.
- **Protein bar:** the target defaults to **1 g per lb of the 7-day average
  weight**, from the weight card. Calories show only when Jo sets a target.
  With no weight and no target there is no bar; it never invents a number.
- **Favorites:** "Save as favorite" takes a meal row Jo typed. One tap adds a
  favorite into the meal for this time of day, or into a meal Jo picks:
  macros sum, and a name isn't repeated.
- **"Same as yesterday"** fills only **empty** meal rows from the previous
  dated page. It never overwrites.
- Favorites and targets are stored in `nbd_ds_food` and sync through
  `userSettings.dsFood`, the same path the coach uses, so they survive
  sign-out.
- Test: [tracker-food-log](../../tests/tracker-food-log-2026-09-29.test.js)
  (26 checks). It caught a real bug: a favorite whose name contains " + "
  used to get repeated.
- Verified on the emulator:
  - Yesterday's meals copied into empty rows.
  - The favorite reached `userSettings.dsFood` in Firestore.
  - A quick-add summed into the right meal.
  - The header read SAVED.
  - The card fits at 375px.

## Update 2026-10-20 — what is built, and the progression charts

Recon on 2026-10-20 found nearly the whole plan already on main: Phase 0
(tombstones, 400-per-batch sync, settings synced, escaped templates; #1878),
the Workout Coach (pattern slots with rotation, "Switch it up", per-set
reps / weight / RPE, double-progression targets, auto-PRs), the weight trend,
the food log, the old-workout import with a preview (#1892), the Sunday
review and the money tab.

The one Phase 1 piece still missing was charts. Added: a 📈 Progress card
under the Weight card (program dashboard and the day page's Fitness section)
with chips for the lifts done most in the last 180 days, an estimated-1RM line
for the chosen lift (new bests dotted), and 12 weeks of volume
(Monday–Sunday). It reads the coach's finished sessions, so it needs no new
data. Estimated 1RM ignores sets over 12 reps. Test:
[tracker-progress-charts](../../tests/tracker-progress-charts-2026-10-20.test.js).

### Food search + barcode (built 2026-10-20, #2590)

Jo wanted food search and barcode scan. A 🔎 Find a food card sits above the Diet
section: search by name (Open Food Facts, free, no key), or scan / type a
barcode; macros per serving with a servings box; Add goes through the food log's
own `addToMeal`, so totals, targets and sync behave like a favorite. Only the
typed words or the barcode number leave the device. The security policy allows
`world.openfoodfacts.org` on `/pro/daily-success` only (per-page blocks, same
pattern as `/pro/portal`). Test:
[tracker-food-search](../../tests/tracker-food-search-2026-10-20.test.js).

**Camera scanning (updated 2026-10-20):** Chrome / Android use the browser's own
`BarcodeDetector`. iPhone Safari does not have it, so there the card loads a
vendored ZXing build (`@zxing/library` 0.21.3, pure JS, ~336 KB, pinned by
sha256 in [VENDOR.txt](../../docs/assets/vendor/zxing/VENDOR.txt)) on demand, only
when Scan is tapped. It reads EAN-13 / EAN-8 / UPC-A and only looks up a number
whose check digit is valid. If the camera or the download fails the card asks for
the digits instead. Test:
[tracker-barcode-decoder](../../tests/tracker-barcode-decoder-2026-10-20.test.js)
decodes a barcode image rendered from the spec with the real vendored file, and
has negative controls. Not yet tried on Jo's actual iPhone in daylight.

### Weight import (open — needs a sample)

Jo's own scale is an **Active Era**, with years of history; he has been weighing
on his girlfriend's **Hume** lately. Hume's app only shows each login's own
readings, so Jo's Hume login holds only his. Plan: a one-time file import
(Active Era app export, or an Apple Health export) into a small separate weight
history that the weight card also reads, so years of readings do not create
hundreds of empty day pages. Preview first (count, date range, anything outside
60–700 lb skipped); re-runs never duplicate; a weight typed on a day page wins
over an imported one. Blocked on a few sample rows of the export. Hume → Apple
Health → Shortcut stays the follow-up for ongoing readings.

### Export everything (2026-10-20)

A **Download my data** card on the dashboard (idea #8 of
TRACKER-IDEAS-RESEARCH-2026-10-20 (PR 2597)). On the device only: one JSON
with everything (day pages, workouts, coach and food settings, floors, goal targets, reviews,
money plan, streak, weigh-ins) and three Excel-safe CSVs (workouts one row per set, weight,
food). Deleted and tombstoned pages are left out; CSV cells starting `=` `+` `-` `@` are
defused; CSVs carry a BOM. Each file is its own tap, plus Share / Save to Files where the
browser can share files. Code: `docs/pro/daily-success/js/export-logic.js`, `export-ui.js`;
test `tests/tracker-export-2026-10-20.test.js`. iPhone installed-app download behaviour
still to be tried by Jo.
