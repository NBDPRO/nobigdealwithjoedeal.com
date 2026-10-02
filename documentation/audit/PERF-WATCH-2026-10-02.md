# Page-speed watch, and the /book layout-shift fix (2026-10-02)

Jo's idea triage (2026-10-01, the "frontend performance dashboard" from the
solo-founder-stack reel) asked for an ongoing page-speed trend. Before this,
every perf check had been a one-off sweep, e.g.
`documentation/qa/homeowner-sweep-2026-06-11/PHASE4-SEO-PERF.md`.

## What runs

`.github/workflows/perf-watch.yml` runs every **Monday at 12:40 UTC**, and
can also be started by hand.

1. It installs the Lighthouse 12 CLI.
2. `scripts/perf-watch.mjs` runs **mobile Lighthouse 3 times** on each money
   page of the live site: `/`, `/book`, `/estimate`, `/our-work`,
   `/storm-check`. These are read-only GETs.
3. It judges the **median** of each metric with
   `scripts/perf-watch-logic.js`, against these budgets:

| Metric | Budget |
|---|---|
| Performance score | ≥ 70 |
| Largest Contentful Paint | ≤ 4 s |
| Cumulative Layout Shift | ≤ 0.1 (Google's "good" line) |
| Total Blocking Time | ≤ 600 ms |

The budgets are lenient on purpose. The job is to catch a **regression**,
not to grade the site, so tighten them once a few weeks of trend exist.

- A measured page **over budget** turns the run red, which emails the repo
  owner.
- A page that **could not be measured** (network, Chrome) produces a notice,
  never a red. This is the same signal-vs-infra rule as `copycat-watch.yml`.
- The table goes into the run summary.

To run it locally (Windows):

```
npm install --no-save --prefix <dir> lighthouse@12
LIGHTHOUSE_CLI=<dir>/node_modules/lighthouse/cli/index.js
CHROME_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe
MSYS_NO_PATHCONV=1 node scripts/perf-watch.mjs --runs 1
```

`MSYS_NO_PATHCONV=1` is needed in Git Bash, because it rewrites `/` into a
filesystem path. `PERF_BASE=http://127.0.0.1:5000` points the run at the
hosting emulator.

## First reading (live, 2026-10-02, 1 run each)

| Page | Score | LCP | CLS | TBT |
|---|---|---|---|---|
| `/` | 91 | 2.84 s | 0.000 | 0.22 s |
| `/book` | 96 | 1.41 s | **0.116** | 0.06 s |
| `/estimate` | 100 | 1.56 s | 0.001 | 0.03 s |
| `/our-work` | 90 | 2.55 s | 0.000 | 0.29 s |
| `/storm-check` | 100 | 1.50 s | 0.028 | 0.04 s |

## The /book fix

Lighthouse's `layout-shifts` audit put the whole CLS on `section.tools`.
It was caused by a **web font loading**: Bebas Neue (0.091) and Montserrat
(0.028). `index.html` preloads both fonts and `book/index.html` didn't, so
the swap reflowed the section.

The fix adds the same two `<link rel="preload" … as="font" crossorigin>`
lines to `/book`'s head. Locally, against the hosting emulator over 3 runs,
CLS went from 0.118 to **0.000**, with a score of 99.
`tests/perf-watch-2026-10-02.test.js` pins the preloads.
`DESIGN.md`'s "before you call it done" list now carries the rule.

## A correction to the triage

The same triage marked **DESIGN.md** as USE ("the repo has no DESIGN.md").
That was out of date: it was added in #1946 and is referenced from
`CLAUDE.md`. Nothing was rebuilt. The font-preload rule was added to it
instead.

## First CI run + the homepage hero (later 2026-10-02)

**First run of the workflow** (dispatched by hand, run 36993648913): green,
all five pages within budget. The homepage was the slowest: score 87, LCP
3,956 ms. /book's CLS read 0.000 live, so the font-preload fix is working.

**What the homepage's LCP actually is.** Lighthouse names `div.hero-bg`, the
drone photo under the navy gradient, as the LCP element. It was already
preloaded with `fetchpriority="high"` and has a 800 px phone variant.
Local runs (5 per variant, median, against a gzip-serving copy of `docs/`)
tested three suspects:

| Variant | LCP | Style + layout |
|---|---|---|
| baseline | 3,239 ms | 826 ms |
| `content-visibility:auto` below the hero | 3,238 ms | 496 ms |
| no Google Analytics script | 3,238 ms | 809 ms |
| hero 640w q50 (38 KB) | 2,744 ms | 816 ms |
| **hero 800w q30 (43 KB), shipped** | **2,761 ms** | 822 ms |

In Lighthouse's simulated slow 4G, LCP is bound by the hero image's
**bytes**, not by CPU or analytics. Every LCP value sat on the same
millisecond until the image shrank.

- `content-visibility` cut layout by 40%, but it didn't move LCP. It is not
  shipped: on iPhone Safari (no scroll anchoring) it risks jumps when
  scrolling up after an in-page link. It's worth revisiting only with
  per-section measured sizes.
- Analytics stays as it is.

**Shipped:** both hero `.webp` files re-encoded.
- Phone 800w: 79,542 → 43,388 B (q30).
- Desktop 1600w: 296,478 → 217,316 B (q40). Desktop shows more of the photo
  on the right, where the gradient lightens, so it gets a quality margin.

Screenshots at iPhone 390 px (3x) and desktop 1440 px (2x) are
indistinguishable under the overlay. Both files are EXIF-free.

The `.jpg` is untouched on purpose: it is the **social share image**
(`og:image` on about 15 pages), and link previews show it with no overlay.

**Not fixed:** the remaining 2.76 s is the document, CSS and font bytes
sharing the same simulated link. The next lever is the 46 KB Dancing Script
font that the hero tagline needs. Subsetting it to the tagline's glyphs
needs `fonttools`, which isn't installed here.
