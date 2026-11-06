# Overnight 2026-11-06: last `region` notes on the public Pro pages

After the contrast and tab-panel fixes, axe's only remaining public-Pro findings were `region` ("content not contained by landmarks"):
five nodes on `/pro/how-to` (the intro block sat in a `<section class="hero">` outside `<main>`) and one on `/pro/pricing` (the `<div class="footer">`
after `<main>`). Two attribute-only edits: `aria-label="How-to overview"` on the how-to intro section (a named section is a region landmark) and
`role="contentinfo"` on the pricing footer div. No tag, class or layout change. axe at 390 and 1280 px on both pages: no `region` finding left. Back to [INDEX](../INDEX.md).
