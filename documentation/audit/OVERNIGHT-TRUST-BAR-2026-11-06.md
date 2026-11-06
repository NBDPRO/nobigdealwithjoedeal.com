# Overnight 2026-11-06: service trust bar + balanced headings

**Bug (phones, 14 service pages):** the six-item trust bar ("GAF & TAMKO Certified", "Fully Insured", ...) rendered
broken at 390 px. `service-mobile-polish.css` (a horizontal-scroll bar, linked first) leaves `white-space: nowrap`,
`flex: 0 0 auto` and `justify-content: center` on `.trust-item`; `service-revamp.css` (linked last) turns the same bar
into a two-column grid at 768 px and below. The leftovers made the cells 446 px wide in a 390 px viewport: the left
icons were clipped off-screen and "Real Google Reviews" was overlapped by "Financing Available".

**Fix (`docs/assets/css/service-revamp.css`):** `repeat(2, minmax(0, 1fr))`, `white-space: normal`,
`justify-content: flex-start`, `gap: 0`. At 390 px the bar is a clean 2x3 grid (grid width 390, no overflow, nothing
clipped). From 769 to 919 px the intended horizontal scroller is unchanged.

**Desktop polish (same file):** the icons are now top-aligned with their text and the small `<span>` line-height
drops from about 27 px to 1.45, so the bar is 129 px tall instead of 165 px (1440 px) and 162 instead of 218 (1024 px).

**Headings:** `h1, h2, h3 { text-wrap: balance }` in `nbd-mobile.css` (about 293 pages) removes one-word last lines
such as "NO / PITCH." on the home page; it changes only where a heading wraps.

Method: Playwright geometry + screenshots against `scripts/overnight-serve.mjs`, the original CSS served through a
route override for the "before" shot. Back to [INDEX](../INDEX.md).
