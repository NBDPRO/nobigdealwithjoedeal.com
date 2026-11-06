# Overnight 2026-11-06: phone Call/Text labels no longer 9.9 px

A computed-font-size sweep at 390 px over 45 sitemap pages found the smallest
visible text was the "Call" and "Text" labels in the sticky bottom contact strip
(`.mobile-cta-bookfirst .mobile-cta-icon`, `docs/assets/css/mobile-cta.css`):
`.62rem`, about 9.9 px. Raised to `.72rem` with slightly tighter tracking. Checked at 320 and
390 px: labels fit inside the 52 px icon buttons and nothing overflows sideways.

Left alone: breadcrumb, eyebrow and badge labels at about 11 px (uppercase caption
text, above the 11 px floor used elsewhere).

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
