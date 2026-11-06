# Overnight 2026-11-06: footer, blog and partner link tap targets on phones

Measured at 390 px wide (touch, 2x) across 16 pages: footer legal links,
blog "Read Article" links and the partner-track CTAs had hit boxes of 18-29 px
tall. The existing phone rule in `docs/assets/css/nbd-mobile.css` (padding plus
an equal negative margin, so layout does not move) already covered breadcrumbs
and footer lists; this extends it.

- `.footer-bottom a` (not the four social icons) joins that rule, so the
  Privacy / Terms / Text Messages / contractor links grow their hit box.
- `.post-read-more` on `/blog/`: padding 6px to 12px with a -6px margin.
- `.track .track-cta` on `/partners`: 13px padding, -13px bottom margin
  (it sits at the card bottom via `margin-top:auto`, so text stays put).

Sweep after the change: `/blog/` 39 to 7 small targets, `/partners` 10 to 7.
Left alone: `/estimate`, `/storm-check`, `/roof-score` footers (30-39 px, above the
24 px WCAG 2.5.8 floor, own slim footer markup).

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
