# Overnight 2026-11-06: reviewer names stop breaking onto two lines

On the `/review` page at 1440 px, names like "Onur Altinay", "Daniel Gilbert" and "Deborah Reynolds"
wrapped onto two lines: each card header packed an avatar, the name and date block, and a five-star
row into one non-wrapping flex line about 250 px wide, leaving the name roughly 100 px. The
header row can now wrap (`flex-wrap:wrap`, `gap:8px 12px`) and the name block keeps at least 130 px
(`min-width:130px`), so when there is no room the stars drop to their own line under the name
instead of squeezing it. The same card markup is rendered by `docs/assets/js/google-reviews-widget.js`
(the reviews strip on about 299 pages) and hand-written in `docs/review.html`; both are updated. Checked at 1440,
390 and 320 px: all 8 names on one line, no sideways overflow.

Not done: the widget script link may carry a cache version; repeat visitors can see the old header for
up to 24 hours.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
