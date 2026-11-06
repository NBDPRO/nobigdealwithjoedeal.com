# Overnight 2026-11-06: footer social icons get a 44 px tap area on phones

The four round social icons in the footer strip are 30 px (`nbd-social.css`); on `/estimate` at 390 px
they measured 30 x 30 with nothing growing the hit area. A phone-only rule in `docs/assets/css/nbd-mobile.css`
gives each icon an invisible `::after` ring (`inset:-7px`, so 44 px) without moving anything.
`nbd-social.css` itself cannot take the rule: `scripts/ensure-social-css.js` asserts it stays byte-identical
to its canonical body (and 25 pages keep an inline copy), so the rule lives in the phone sheet next to the
existing `footer .nbd-social a` reset. Verified with `elementFromPoint` at the circle centre on `/estimate`
(hit), and no sideways overflow at 390 px. On pages where the icons already measure larger, the ring
only adds a few pixels of overlap between neighbours.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
