# Overnight 2026-11-06: a lone "recent job" card becomes a feature card on desktop

Reading a 1440 px full-page screenshot of `/services/gutter-cleaning` showed the "Recent gutter
cleaning jobs" section as one 350 px card with about 900 px of empty space to its right. A sweep of
194 service and area pages found 31 with exactly one card (and 9 with two, 20 with three), so the
gap was a pattern, not one page. `docs/assets/css/project-cards.css` now lays an only-child card
out as a wide feature card (image left, text right, max 880 px) from 900 px up. Phones and
tablets under 900 px are untouched, and pages with two or more cards are unchanged.
Checked at 1440, 899 and 390 px: no overflow.

Not done: the stylesheet link carries `?v=3`; repeat visitors may see the old layout for up to 24 hours
(the cache window on `/assets/css`). Bumping it would touch several hundred pages and their tests.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
