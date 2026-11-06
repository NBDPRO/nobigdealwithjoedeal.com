# Overnight 2026-11-06: phone header logo on six pages

A header-geometry sweep of all 298 public pages at 390 px grouped them by logo box: 241 pages at 97x50, 48 generated
project pages at 40 px padding with a 117x60 logo (fixed in the project-nav note), two pages (`/careers`, `/partners`) at 20 px
padding (left alone, 4 px), and six hand-authored pages with the full-size 117x60 logo because they never linked
`nbd-nav-logo-mobile.css`: `/book`, `/free-tools`, `/roof-score`, `/storm-check`, `/storm-report` and
`/blog/roof-financing-cincinnati-explained`. `scripts/fix-phone-logo-link.js` (dry run / `--apply` / `--check`) adds the link
after each page's `mobile-cta.css` link. Re-measured: all six now 97x50 at 390 px. `ensure-nav-logo-mobile-css.js` stays green.
Back to [INDEX](../INDEX.md).
