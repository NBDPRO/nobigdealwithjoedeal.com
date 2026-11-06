# Overnight 2026-11-06: /areas/ hero stats are a 2x2 grid on phones

Looking at full-page phone screenshots (not metrics) showed the four hero stats
on `/areas/` wrapping 3 + 1, leaving "1 / Person handling it" alone on a second
row. At 520 px and narrower the row is now a two-column grid (2 x 2); wider
screens are unchanged. Checked at 320, 390, 500 and 768 px: two rows up to 500, one row at
768, no sideways overflow.

Considered and left: the 32-city Ohio list is one column under 440 px on purpose
(names such as "Anderson Township" would not fit two columns).

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
