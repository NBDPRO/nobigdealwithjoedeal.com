# CRM tab header, compact on the phone (2026-10-13)

Jo, on the installed iPhone app (390 wide): "CRM tab is getting a bit tight
again." The stacked Pipeline header put the first card at 70% of the screen.

## Numbers (390x844, installed-app cascade forced, notch inset live)

Measured by `tests/e2e/phone-crm-header-compact-2026-10-13.spec.js`
(emulator, 18 seeded leads: 10 typed, 8 untyped; tab counts forced to Jo's real
book so INS 188 / ALL 249 are three digits).

| | before | after |
|---|---:|---:|
| Y of the first card | 588 px (70%) | 413 px (49%) |
| view-tab rows | 2 (ALL wrapped) | 1 |
| no-job-type banner | 115 px (Jo's phone: ~230) | 54 px |
| stats + card style | 2 rows, 80 px | 1 row, 44 px |
| dead gap above the board | 18 px | 0 |

Screenshots: [before](before-390.png) and [after](after-390.png) (Playwright
renders, no EXIF).

## What moved where

Nothing was removed; every action is still one tap.

- **View tabs** (`docs/pro/css/dashboard-app.css`, the "One row" block under
  "No more hidden tabs"): seven tabs share one row via 5px side padding, 11px
  label, smaller count badge. A phone narrower than ~360 still wraps (all seven
  stay on screen; the 10-03 rule that nothing scrolls out of sight holds).
- **No-job-type banner** (`js/sort-customers.js`, `css/sort-customers.css`):
  one line, "N need a job type" + the same two buttons (One at a time, See the
  list). The full sentence ("...so they only show on All and Insurance.") is the
  `title` and `aria-label`.
- **Stats + card style** (`js/pipeline-rich-cards.js`, `css/pipeline-rich-cards.css`):
  Open / Weighted / Going cold on the left, ONE cycle button on the right
  (Cards > Compact > Rich > Photo > Compact, label names the state). The
  three-segment switch is unchanged above 640px. The 32px chips carry a 44px hit
  area via `::after` (row is 44px tall).
- **Header padding** 12/8 -> 8/4, row gap 8 -> 6 (phone rule only).
- **`#dailyCommandCenter:empty`** takes no space (a 2px bordered box + 16px
  margin of dead air above the board; nothing populates it today).

## Tests

- `tests/e2e/phone-crm-header-compact-2026-10-13.spec.js` (authed shard 2):
  one tab row, 44px/tappable, banner <= 60px with both actions and the full
  label, one strip row, cycle button hit area + four-tap cycle, first card
  <= 52% of the viewport, wide window keeps the three segments.
- `tests/pipeline-rich-cards-2026-10-11.test.js`: new "COMPACT PHONE HEADER"
  static section.
- Break-tested: reverting only the tab CSS reddens test 1 (and the 52% bound);
  only the banner files, test 2; only the rich-cards files, test 3; all of them,
  1-4 (588 px reproduced); test 5 (desktop) stays green throughout.

## Unverified

- A real iPhone (WebKit, real Barlow Condensed metrics, the real 188/249
  counts). Playwright ran Chrome and the tab row fit at 390; a wider font
  fallback could still wrap ALL, which degrades to the old two-row layout
  rather than hiding it.
- Jo's own text-size setting (Dynamic Type / `data-nbd-size`) - not swept.
- The pipeline "Pipeline / 184 · $102K · 65" title row is untouched (28 px);
  folding it into the toolbar row did not fit beside Board/List at 390 without
  icon-only Board/List, which was judged worse than the 28 px.
