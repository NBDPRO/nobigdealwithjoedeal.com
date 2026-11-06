# Overnight 2026-11-06: blog post desktop header

A desktop (1280 px) computed-style sweep grouped the header Book Inspection button by height: 28 px on 202 pages, 31 px on the 48
project pages, and on the 33 blog posts 37, 40 or 52 px depending on the post (up to 67 px at 1025 px). Cause: the blog header (the
`nav-blog` partial) has nine items against six or seven elsewhere and nothing stopped the labels wrapping, so "ABOUT JOE", "OUR WORK",
"SERVICE AREAS", "THE PLEDGE" and "INSTANT ESTIMATE" broke onto two lines, the button grew, and the row crowded the logo.
Adding the existing `nbd-nav-responsive.css` did not help (labels still wrapped), so `docs/assets/css/blog-nav-fit.css` (desktop only,
`min-width: 1025px`; the hamburger layout below is untouched) sets `white-space: nowrap`, a 0.7 rem label and a 0.62 rem label
at 1025 to 1180 px, a clamp()ed gap and a fixed-height button. `scripts/fix-blog-nav-fit.js` (dry run / `--apply` / `--check`) links it last in
`<head>` on the 33 pages that carry the partial. Measured on three posts at 1025, 1100, 1180, 1181, 1280, 1440 and 1920 px: every label on one
line, the button 33 px on every post, no horizontal overflow, header 70 px. The 48 project pages (31 px button, 12.16 px labels) and
the standard pages (28 px, 11.2 px) keep their own sizes; unifying those three families is a larger header decision left alone.
Back to [INDEX](../INDEX.md).
