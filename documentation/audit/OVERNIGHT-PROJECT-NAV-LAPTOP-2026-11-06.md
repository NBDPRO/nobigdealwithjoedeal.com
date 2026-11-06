# Overnight 2026-11-06: project pages match the standard header at laptop widths

A header-geometry sweep at 1280 px grouped the pages: 184 standard pages had a 50 px logo, 11.2 px nav labels and a 28 px button; the 48
generated project pages (`/our-work/<slug>`) had a 60 px logo, 12.16 px labels and a 31 px button, so the header changed size on the way from any page to a
project page. The standard pages get that size from the `1025 to 1440 px` block in `nbd-nav-responsive.css`, which the generated pages never linked (that
sheet is order-sensitive and carries 20 px padding rules that would fight the 16 px the project pages now use). `scripts/build-projects.mjs` now carries the
same four declarations inline for `min-width: 1025px and max-width: 1440px` (gap 14 px, 0.7 rem labels, 0.05 em spacing, 8 x 14 px button, 50 px logo); 48 pages
restamped (1 line each). Measured at 1025, 1100, 1280 and 1440 px against `/about`: logo 50 px and labels 11.2 px on both, no overflow. Above 1440 px the
project pages keep the larger sizes (they differ from the standard pages by under 0.4 px of label size there). Back to [INDEX](../INDEX.md).
