# Overnight 2026-11-06: project detail pages match the site header

The 48 generated `/our-work/<slug>` pages hard-coded `nav.nav { padding: 0 40px }` and did not link
`nbd-nav-logo-mobile.css`, so on a phone the logo sat 24 px further right than on the other 241 pages
(16 px) and was 117x60 instead of 97x50. Moving from `/about` to a project page made the header jump.
`scripts/build-projects.mjs` (detail template) now uses `padding: 0 16px`, the majority value, and links the
existing phone-logo sheet. Restamped the 48 pages (2 lines each). Measured at 360 to 1920 px: padding 16 px everywhere,
logo 50 px at 768 px and below, identical to `/about`. Only difference left: at 1025 to 1440 px other pages shrink
the logo to 50 px through `nbd-nav-responsive.css`; project pages stay 60 px (that sheet is order-sensitive, so
it was not added).

Tried and rejected: linking `nbd-mobile.css` too. It matches the header but also changes the page body (margins,
hero image crop), which is not a header fix. Back to [INDEX](../INDEX.md).
