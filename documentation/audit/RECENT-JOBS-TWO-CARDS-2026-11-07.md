# "Jobs we've done" with two cards left half the row empty (2026-11-07)

Found on `/areas/mason-oh` at 1440 px. `.nbd-recent-jobs .gallery` used
`repeat(auto-fill, minmax(280px, 1fr))`. `auto-fill` keeps empty tracks, so a
1100 px container always has three tracks and two cards sat at about 350 px
each with an empty third track beside them, while "See all our work" floated
far right. The one-card case was already handled (2026-11-06, a wide feature
card); the two-card case was not.

Fix: `auto-fit` instead of `auto-fill` in `docs/assets/css/project-cards.css`,
which collapses the empty track so two cards share the row.

Measured on all 64 pages that carry the section, at 1440, 1024 and 390:
- 9 pages with two jobs: cards 350 px to 540 px at 1440 (294 to 451 at 1024);
- 31 one-card pages (880 px feature card), 20 three-card pages, and the 5- and
  6-card pages: identical to before;
- phones: unchanged (the section is a horizontal scroller there), no overflow
  anywhere.

The stylesheet link is `project-cards.css?v=3` on these pages; not bumped
(same as the one-card change), so a returning visitor may see the old layout
until their cache turns over.
