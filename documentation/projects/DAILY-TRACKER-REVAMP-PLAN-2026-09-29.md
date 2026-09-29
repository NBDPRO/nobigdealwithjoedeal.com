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
