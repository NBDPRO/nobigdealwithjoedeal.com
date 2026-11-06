# Overnight 2026-11-06: the checkmark strip is a tidy list on phones

Found by reading a full-page phone screenshot of a town page: the four ticks under the hero
("You deal with me, start to finish", "Free written estimates", "Clean job site guarantee",
"Fully insured") sat in an inline `justify-content:space-around` row that wrapped one or two per
line, so the checkmarks staggered down the page. The strip is injected by
`scripts/add-transparency-strip-services.js` (marker `data-nbd-transparency="v1"`, 124 pages), so the fix is one rule in
`docs/assets/css/nbd-mobile.css` instead of 124 edits: up to 600 px the items stack as a left-aligned list
(block still centred). 768 px and wider are unchanged. Checked at 320, 390 and 768 px; no sideways overflow.

Noticed, not changed: the hero intro paragraph on town pages repeats the first paragraph of the body
card (copy, generator-owned), and the TAMKO badge card sits slightly narrower than the GAF one.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
