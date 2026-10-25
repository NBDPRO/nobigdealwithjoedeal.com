# Daily Success - the interface lineup (design brief)

Written 2026-10-22 from Jo's ask: "make out versions of both" (a Strong-style log and a Rings-style dashboard) "as well as a few more", and
get creative. Part of [DAILY-SUCCESS-ROADMAP-2026-10-21](DAILY-SUCCESS-ROADMAP-2026-10-21.md); order against phase 3 is below.

## The idea

Two independent choices, so every look works with every color:

- **Layout** (new): how the screens are arranged and what the home screen shows. Stored as `data-ui` on the root, in the same per-device
  settings as the theme.
- **Theme** (already shipped): the ten brand-safe color skins. Unchanged; each layout must look right in all ten.

All layouts share one data model, one set of logic files and one sync path. A layout is CSS plus, where it changes the markup, a small
render module. Nothing about storage, sync, the service worker or auth changes for a layout.

## Constraints that apply to every layout

- Strict CSP: no inline script or handler, no inline `style=` for dynamic values (use SVG attributes or classes); new JS is an external file with `defer`.
- Gym use: in-workout controls are at least 44 px, sit in the lower thumb zone, and are spaced for one-handed, sweaty taps.
- No trademarks or brand names in anything the user sees ("Strong", "Apple", "Hevy" stay in this doc only). Names below are generic.
- Works offline (the tracker shell is cached) and at 320 px wide; a phone-fit test per layout, the same gate the themes use.
- Default stays the current layout until Jo picks another; switching is instant and reversible, and never touches workout data.

## The lineup

| # | Layout | Feel | Home screen | Notes |
|---|---|---|---|---|
| 1 | **Log Book** | Plain, fast, list-first (the "log it and leave" look) | Today's workout list, last-time numbers beside every set | Closest to what lifters say they want: low friction |
| 2 | **Rings** | Calm dashboard, big circles | Daily rings (floors, workout, calories, steps) with one tap into each | Drawn as SVG; ring closing is the reward |
| 3 | **Quest** | RPG: XP, levels, daily quests | Quest board for today, XP bar, streak | Each lift is a node on a skill tree; rest days count toward the streak |
| 4 | **Arcade** | Retro pixel, chunky numbers | Score, combo, "high scores" = PRs | Same data as Quest, louder styling, sound/haptic off by default |
| 5 | **Cockpit** | Dense HUD for people who love numbers | One screen: week volume map, trends, readiness, next target | Uses the volume map and RPE trend already built |
| 6 | **One Thing** | One big card at a time | "Do this next" and nothing else | For days when everything feels like too much |
| 7 | **Journal** | Paper, calm, written | Today as a page: intention, workout, note | Pairs with the existing paper theme |

### Ideas worth stealing (from research, treat as leads)

- A skill tree instead of a bare progress bar: unlocking a named lift feels like identity, not a number. (Quest.)
- Loss aversion is a stronger pull than reward, but an avatar that decays when you skip is punishing. If built, make it opt-in and off by default.
- Completion feedback (a short spark or confetti, an achievement haptic different from a daily-bonus one), always switchable off.
- Card-per-day plans that scan in about two seconds.
- Hevy-style extras lifters praise: RPE on every set, supersets, drop sets, body measurements (we have the first three; measurements is phase 4).
- Planned-versus-adaptive: some lifters ignore recommendations and only log, so the log must be fully usable without the coach.

Sources: [gamified skill-tree and quest concepts](https://contra.com/community/bAeVXh2Y-revolutionize-fitness-with-a-gamified-retro-style), [fitness UI portfolio concepts](https://contra.com/p/ZYXeeZqo-gym-fitness-app-workout-and-fitness-mobile-app-uiux-design), [what lifters say about Strong and Hevy](https://gummysearch.com/tools/best-products/workout-app). These are portfolio pieces and review roundups, not hard data; test with Jo's own use.

## Build order

1. **Layout switch plumbing** (one PR): `data-ui` attribute, a picker next to the theme picker, per-device storage, a test that every layout x every theme renders without overflow at 320 px. Default layout unchanged.
2. **Log Book** (the plainest; proves the plumbing) and **Rings** (Jo's two named looks).
3. **Cockpit** (reuses the volume map, almost free).
4. **Quest**, then **Arcade** (shares Quest's data: XP and levels derived from stored sessions, no new collection).
5. **One Thing** and **Journal**.

Each is its own PR, tested and checked at phone width before it is queued. The Sunday review page (phase 3) stays on the roadmap; it can ship before or between layouts, and the Cockpit and Rings homes will show it.

## Status (2026-10-25)

- Shipped: **the whole lineup**. Log Book and Rings (10-22); Cockpit, Quest, One Thing, Journal and Arcade (10-25).
  - Cockpit: `cockpit-ui.js` + the Today-bar branch in `app.js`; eight tiles from `day-layout-logic.js` and `cockpit-logic.js`, a "behind this week" line; `tests/ds-layout-cockpit-2026-10-25.test.js`.
  - Quest: `quest-logic.js` (the board on `xp-logic.js`: each floor +10, all floors +25, a workout +100; streaks can break, XP never drops via a high-water mark in `nbd_ds_xp_high`) + `quest-ui.js` (level badge, XP bar, streak, floors as tappable quests that reuse app.js's `toggle-floor` action, the workout quest opens the coach); `tests/ds-layout-quest-2026-10-25.test.js`. The skill tree from the brief is not built yet.
  - One Thing: `onething-logic.js` (the next thing in order: check-in while it asks, the first unmet floor, the workout, the evening wrap-up, then rest; "Not now" moves a thing to the back for this visit) + `onething-ui.js` (one big card and button; the floor button reuses `toggle-floor`, check-in and wrap-up scroll to their cards, the workout opens the coach); `tests/ds-layout-onething-2026-10-25.test.js`.
  - Journal: `journal-ui.js`: a warm paper page in every theme (the date written out, an intention line, a status line with a coach link, a ruled note). The intention and note are page fields (`data-k` `journal-intention` / `journal-note`), so they save and sync with the page; `updateTodayBar()` reads the live values back before every re-render so a floor toggle never wipes typing; `tests/ds-layout-journal-2026-10-25.test.js`.
  - Arcade: `arcade-logic.js` (Quest's data as a scoreboard; hi-scores are the best estimated one-rep max per lift, Epley with reps capped at 12, from finished sessions) + `arcade-ui.js` (SCORE / 1UP / COMBO / TODAY in zero-padded mono digits, a stepped level bar, missions that reuse `toggle-floor`, hi-scores; scanlines in CSS; sound and haptics stay off); `tests/ds-layout-arcade-2026-10-25.test.js`.
- The gate from the constraints list is in CI: `tests/ds-layouts-phone-fit-2026-10-25.test.js` loads the day page in every layout x every theme at 320 px (plus 390 px) in real Chromium and fails on sideways scroll, an empty Today bar, a control under 44 px or a page error (88 renders; the zero-network Chromium job).
- Next: nothing in the lineup. Ideas still open: Quest's skill tree, Journal's week view.

## Decisions (Jo, 2026-10-22)

- First two: **Log Book** and **Rings**.
- Streaks **can break**; **XP is separate** and never drops (a broken streak costs no XP). Rest days and optional freezes keep a streak alive.
- The layout picker lives in the tracker settings **and** on the first-run welcome: more available, not less.

## Grok prompt (non-sensitive, for Jo to paste if he wants Grok's take)

> I'm designing a personal gym / habit / coach tracker web app for one person's phone (offline-capable, dark and light themes). I want 7 distinct interface layouts users can switch between, from plain lifting log to gamified RPG. Be creative and out of the box: what unusual, delightful gym-tracking mechanics or visuals would a serious lifter love? Think skill trees, boss fights for PRs, weekly "seasons", body maps, sound, streak rules that do not punish rest days. Give 10 ideas with a one-line reason each, and flag any that annoy people in practice.

Grok's answer arrived via Jo on 2026-10-22 and is folded in below as leads, not requirements.

## Grok's ten ideas, sorted against what already exists

Already built (Daily Success coach): **ghost of last session** (the Previous column per set), **rest timer** with an alert, **warm-up plates**, a muscle **volume map** (#2653). So 7 and 8 are polish, not new work.

| Idea | Fit | Layout |
|---|---|---|
| Last / best / today row above big steppers, one-tap plate math (10) | Mostly there; add the "best" cell and a plate tap | Log Book (default for training) |
| Full-screen rest timer, breathing circle (8) | Timer exists; a full-screen mode is new | One Thing / Log Book |
| Body heatmap, front/back, tap to jump to lifts (4) | Volume map is the data; the body drawing is new (SVG) | Cockpit |
| Boss fight for a chosen PR target (2) | New; ignorable, one-tap log damages the bar | Quest / Arcade |
| Weekly seasons with soft ranks (3) | New; must never punish deload weeks, so goals flex | Quest |
| Skill tree with prerequisites (1) | New; keep it shallow, no forced programming | Quest |
| Streak that breaks, XP that never does (6) | Decided above; freezes optional | Quest / Arcade, hidden elsewhere |
| Sound design (5) | New; everything off by default, one mute, offline | All, opt-in |
| Forge: sets add bricks to a growing structure (9) | New; cheap derived art | Journal / Arcade |

Rule from Grok, which matches the research: anything done mid-set is one or two taps with last performance visible; navigation, typing and decisions happen between sets or after. Grok's claim that hard-reset streaks are the most common gamification complaint is unverified here; the design (XP never breaks, streak secondary) holds either way.

