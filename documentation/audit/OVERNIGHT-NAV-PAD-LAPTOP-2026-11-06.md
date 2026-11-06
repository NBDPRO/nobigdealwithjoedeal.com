# Overnight 2026-11-06: service hubs' header padding at laptop widths

The header-geometry sweep at 1280 px found 18 service hub pages (`/services/roof-repair`, `-replacement`, `siding-*`, `gutter-*`,
`storm-damage`, `financing`, ...) with 24 px of side padding against 16 px on the 184 other standard pages, so the logo and
button moved 8 px between a service page and the rest of the site. The repo already documents why: three nav sheets set `nav { padding }`
with `!important` at equal specificity and source order decides, so these pages resolve the opposite way from the majority. Re-ordering the links is the
thing that note warns against, so `docs/assets/css/nav-pad-laptop.css` (16 px, only `min-width: 1025px and max-width: 1440px`) is linked last on those 18 pages by
`scripts/fix-nav-pad-laptop.js` (dry run / `--apply` / `--check`; explicit page list). Measured at 768, 900, 1024, 1025, 1280 and 1440 px: padding 16 px on both
`/about` and the service pages, no overflow. Left alone: at 1441 px and up the service pages use 40 and 56 px (their own responsive sheet) while the
standard pages stay at 16 px; that is a design call, not a bug. Back to [INDEX](../INDEX.md).
