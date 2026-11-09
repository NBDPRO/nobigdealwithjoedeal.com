# Session 2026-11-09: Daily Success quick wins (Tier 1, decision-free)

Source: [the UX audit](../qa/daily-success-ux-audit-2026-11-09.md), section 3, Tier 1. This session built only the items that need
no answer from Jo. Saved-page data keys are unchanged (`nbd_dsp_v1`, `fit-focus`, `floormet-*`, `nbd_collapsed`).

## Built

| # | What shipped | Where |
|---|---|---|
| Q2 | Every text field is 16 px on phones, so iOS stops zooming on focus (`!important`, because the Diet totals row carries an inline 11 px). | last `<style>` block of `docs/pro/daily-success/index.html` |
| Q3 | `markDirty()` schedules a save about 800 ms after the last edit (`flushDirty`); `visibilitychange` (hidden) and `pagehide` save at once. The 30 s timer, `beforeunload` and SAVE stay. `collectPage` now returns true when it collected, so a skipped collect is never marked SAVED. | `js/app.js` |
| Q4 | `toastErr(msg)` shows the red `error` toast. Every module-local failure message ("Could not save on this device", `SAVE_FAILED`, the workout save, export and photo failures) now goes through it. | `js/app.js` plus ten `*-ui.js` / `food-log.js` / `workout-coach.js` modules |
| Q5 | `triggerDel()` and `openRename()` on the Dashboard say "Open a day first" instead of throwing (`triggerDel` read `pages[-1].name`). | `js/app.js` |
| Q6 | `--sat` (`env(safe-area-inset-top)`) is added to the header, tab row, search bar, banner, content and sticky Today bar offsets; `.topbar` and `.main` also take the side and bottom insets. The sync pill is now `.ds-sync-badge` (a class, no `top:10px` in JS), under the header on every width. The old phone rule pointed at `#autosave-badge`, a different element. | `index.html`, `ds-firebase-sync.js` |
| Q9 | The classic Today bar items, the four Rings and the four Cockpit day tiles are `<button data-action="tb-go" data-go=...>`. Floors scroll to the floors card; calories and protein open the Diet section and focus `#fsQuery`; workout calls `NBDCoachUI.open()`. Buttons are 44 px+ (the phone-fit test checks it). | `js/app.js` (`tbGo`), `day-layout-logic.js`, `cockpit-ui.js`, `css/layouts.css` |
| Q10 | A search hit carries `data-hit-key` (not `data-k`: `collectPage` collects every `[data-k]` and would have wiped the page). The jump opens the section, centres the field and flashes it (`.srch-flash`). Scroll position is kept per view (Dashboard and each day) across tab switches and `dsRefreshView()`; it is applied again 0 and 250 ms later unless Jo has scrolled, because cards that other scripts add after a render make the page taller and the browser nudges the scroll. | `js/app.js` |
| Q13 | "Training streak" (was "Workout streak" / "Streak" / "N-day streak") and "Floor streak" everywhere in the tracker, including the Sunday review copy and the coaching lines. The one "Sunday is optional: it never breaks the streak." line is left as is: a test pins it word-for-word against the NBD OS widget, and it sits under the "Floor streak" heading. | `app.js`, `quest-ui.js`, `cockpit-ui.js`, `review-ui.js` |

Asset versions (`?v=`) were bumped for each changed script and stylesheet in `index.html`. `app.js` is loaded without a version, as before.

## Skipped (they wait on Jo's open decisions)

Q1 (open on today), Q7 (tab identity), Q8 (the duplicate quote), Q11 (wrap-up position), Q12 (carry last night forward), and everything not
listed in the brief (Q14 to Q20). Not touched: the NBD OS widget links (`os/home.js`, `coach-logic.js`) and the "Week streak" tile in
`stats-logic.js` (a third, separate streak).

## Tests (red first)

- New: `tests/ds-quick-wins-2026-11-09.test.js` (Chromium, hosting server, no network). Run before any code changed: 23 passed, 44 failed
  (the run stopped at a null click in Q9). Now 67 passed, 0 failed. Wired in `tests/ci-manifest.json` (wired-individually), `ci.yml`
  (next to the phone-fit step) and `FLOORS.disk` (1185 to 1186).
- Extended: `tests/ds-layouts-phone-fit-2026-10-25.test.js` now fails on any text field under 16 px (88 combinations plus both dashboards).
  Red with the Q2 rule removed (every layout reported 11 to 14 px fields), green with it.
- Updated to the new intent (offsets now `calc(Npx + var(--sat))`, cockpit and rings tiles are buttons, "Training streak", the
  sync pill is a class): `daily-success-day-layout`, `daily-success-phone-readability`, `daily-success-sync`,
  `daily-success-theme-sweep`, `ds-layout-cockpit`, `ds-layout-quest`.

## Notes for the next session

- `money-*` and `review-*` suites that need `functions/` dependencies fail in this sandbox before and after; they are unrelated.
- The cover/quote (Q8), the open-to view (Q1) and the wrap-up move (Q11) are the next three wins once Jo answers questions 1 and 2 of the audit.

## Review fix round

- Cockpit "Training streak" tile label was clipped on phones (nowrap + ellipsis in the 4-column grid). The `.ck-l` label now wraps (`overflow-wrap: anywhere`) instead of clipping; `layouts.css` cache version bumped to 13. Pinned in `tests/ds-quick-wins-2026-11-09.test.js` at 360 and 390 px (red at 390 before the fix).
- Left as is: the sync pill sitting over the tab row (cosmetic, about 2 s, taps pass through, no worse than the old header overlap), and the 16 px field rule applying up to 768 px (iOS zooms focused sub-16 px fields on iPad too).
