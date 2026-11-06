# Overnight 2026-11-06: axe `region` landmark fix

Axe (390 and 1440) reported a `region` violation on every public page: the sticky mobile Call/Text strip
(`aria-label` on a role-less `<div>`, which assistive tech ignores) and, on desktop, the four rotating spans of the
announcement bar sitting outside any landmark. `scripts/fix-region-landmarks.js` (dry run / `--apply` / `--check`)
adds `role="region"` to the strip (partial `site-src/partials/mobile-cta.html`, the case-page template in
`scripts/build-projects.mjs`, and every stamped page) and `role="region" aria-label="Announcements"` to
`#annBar` on 236 pages.

Result on `/services/roof-repair`: axe violations 1 (390 px) and 4 (1440 px) -> 0. No visual change. Lighthouse
accessibility was already 100. Method and baseline: the overnight site-visual note (`OVERNIGHT-SITE-VISUAL-2026-11-05`)
that ships in the companion PR.

Back to [INDEX](../INDEX.md).
