# Overnight 2026-11-06: area hero "Rather talk?" alignment

On phones (768 px and below) the area (`.city-hero`) pages centered the heading, intro and Book button but left-aligned
the "Rather talk? Call or text Joe" line, so it hung off the left edge under a centered hero (it also wrapped the phone
link onto its own line). `service-revamp.css` forced `.city-hero .svc-alt, .combo-hero .svc-alt { text-align: left }`
for both hero types, but only the combo-hero (town-service) pages are left-aligned. The rule now targets `.combo-hero`
only; area pages take the centered `.svc-alt` rule above it. Measured at 390 px: `/areas/amelia-oh` heading and line
both `center`; `/services/gutter-replacement-batavia-oh` stays `start` / `left`. CSS only, one line. Back to [INDEX](../INDEX.md).
