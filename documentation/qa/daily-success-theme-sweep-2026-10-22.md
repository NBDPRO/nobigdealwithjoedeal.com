# Daily Success all-theme sweep (2026-10-22)

Roadmap Horizon 1, item 1: every screen of the tracker on all ten skins at 360 / 390 / 412 px. Follows the
[2026-10-21 visual audit](daily-success-visual-audit-2026-10-21.md), which fixed the default skin only.

## Method

- Playwright (Chromium 153, `isMobile`, touch), static copy of `docs/` on a local server, all non-local requests
  blocked. Seeded 14 day pages (weights, two meal rows), seven finished workouts across two lifts, and a favourite meal
  so Food, Progress and the Coach have content.
- Screens: Dash, Day (every section expanded), Food, Progress, Workout Coach, Weekly Review, Money, Download my data,
  Appearance picker. Skins: default, light, paper, contrast, midnight, forest, ocean, ember, graphite, terminal.
- Checks per element: sideways overflow (ancestor walk that discounts scrollers and **stops before `<body>`**, see the
  overflow-detector note in memory), hit box under 44 px (counting `::after` expansion), text contrast against the
  composited colour actually behind it (WCAG AA: 4.5, or 3 for large text), clipped text.
- Baseline: 270 page loads. After fixes: 240 loads (all screens except the picker) at 360 / 390 / 412.

## Result

| Check | Baseline | After this PR |
|---|---|---|
| Document overflow (any skin, width, screen) | 0 | 0 |
| Page errors | 0 | 0 |
| Contrast misses (unique element/text) | 59 | 0 |
| Tap targets under 44 px, outside the picker | 4 families | 0 |
| Clipped text | meal-name inputs only | same (an input scrolls its own text; not a defect) |

One headless crash (forest / day / 360) did not reproduce on rerun.

## Fixed in this PR

- Ghost buttons on the dashboard hero band and on the Workout Coach / Money / Review overlays: Light and Warm Paper
  gave them dark ink on a surface that is dark in every skin (1.4:1 to 1.8:1). They now use `--on-dark`.
- Tab x (Light, Paper), DASH tab label, week-glance weekday letters, "No previous day": on-dark inks.
- Row numbers (`.rn`, 1.4:1 in every skin), delete x (`#bbb`), card captions (`.wc-lbl`), weight rise / fall, streak
  and habit numbers, the day-row arrow, "≥7 hrs" floor targets, "x/5 floors met", program date rows, Today's Mindset
  label: tokens instead of fixed hex.
- Sync pill: 10 px (under the 11 px type floor) and a fixed orange; now 11 px and the skin's accent text.
- Phone hit areas: program-dashboard day rows 33 to 44 px, Notes boxes 34 to 44 px, "How is this worked out?" 18 to 44 px.

Guard: `tests/daily-success-theme-sweep-2026-10-22.test.js` (WCAG maths over each skin's tokens on the fixed-dark and
paper surfaces, plus the rules and the inline colours). Mutation-checked: reverting `.rn`, dropping `.wc-ov` from the
ghost rule, and restoring `#334455` each turn it red.

## Not in this PR (open)

- **Appearance picker** (waits for the accent-picker PR #2663, which rewrites it): "NBD Light" and "Warm Paper" labels
  are 1.2:1 (including the selected chip); tab strip and category chips 3.1 to 3.2:1; category chips, search box,
  Guide / Random / close are 24 to 32 px tall; at 360 px the panel is 5 px wider than its box.
- Meal-name inputs scroll their text sideways in the Diet table at phone width (usable, not clipped content).
- The Progress tab's measurements and photos (#2662) were not on `main` yet; re-sweep after it merges.
- WebKit pass and a daylight check on a real iPhone remain Jo's.

Screenshots were taken locally and kept out of the repo.
