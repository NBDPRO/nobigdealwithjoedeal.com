# Overnight 2026-11-06: /about sections line up with the hero on wide screens

At 1440 px the /about hero sits in a centred 1200 px container (left edge 120 px) while every
section below it started at 72 px (`padding: 72px 5%`) and its cards ran out to 1368 px, so the
page had two different left edges. `.about-section` now pads to `max(5%, (100% - 1200px) / 2,
safe-area)`, the same container as the hero: 1440 px gives 120 px, 1920 px gives 360 px, and
widths under about 1250 px keep the old 5%. A global `section{padding-inline:... !important}`
safe-area rule forces the side padding, so the page rule needs `!important` too (found with the
matched-rules view; a plain override computed to the old 72 px).

Checked at 1920, 1440, 1100 and 390 px: left edges match the hero, no sideways overflow.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
