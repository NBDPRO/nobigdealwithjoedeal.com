# Overnight 2026-11-06: /pro/login phone text legibility

The baseline Lighthouse run scored `/pro/login` Best Practices 93 on mobile against 96 on every other page. The failing audit was
`font-size` ("53.55% legible text"): the phone layout set the access tabs at 9 px, the footnote at 10 px, and the labels, eyebrow,
divider text, back link and logo sub-line at 9 to 11 px. `docs/pro/login.html` now raises every one of them to 12 px at 900 px and below
(the tabs and footnote through their existing 480 px rules, the rest through one new `max-width: 900px` block). Desktop (above 900 px)
is untouched. Measured with Playwright at 320, 360, 390, 768 and 899 px: no text under 12 px, no horizontal overflow, the three tabs still fit on
one line. Lighthouse (mobile, 2 runs median): Best Practices 93 -> 96, Performance 98, Accessibility 100. The login visual-regression baselines
at 375 and 768 px render the old sizes, so they may need a CI re-bless (use the CI actual, not a local render). Back to [INDEX](../INDEX.md).
