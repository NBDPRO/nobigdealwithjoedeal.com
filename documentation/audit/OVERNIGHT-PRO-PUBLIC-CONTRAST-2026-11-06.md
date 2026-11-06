# Overnight 2026-11-06: public NBD Pro pages, contrast and landmarks

My earlier axe sweeps skipped `/pro`. Lighthouse on the other public Pro pages scored accessibility 83 (`/pro/how-to`), 85
(`/pro/register`), 95 (`/pro/pricing`) and 96 (`/pro/terms`); axe named the causes: brand orange (#BD5728) text on the navy theme at
2.82:1 to 4.22:1, muted greys #8892A4 (4.15:1) and #4A5568 (1.73 to 2.58:1), in-text links that differ from their sentence by colour alone
(1.04:1 to 2.16:1), a sidebar of `<h3>` labels ahead of the page's `<h1>`, and no `<main>` on the terms page.

`docs/pro/css/pro-public-contrast.css` (linked last on those four pages by `scripts/fix-pro-public-contrast.js`, dry run / `--apply` /
`--check`) uses only sanctioned tints: the light-on-dark orange (`--orange-light`, #DD875F) and white at 72% opacity, plus an underline on the
in-text links; selectors name exactly the flagged elements (no blanket `a` rule, so buttons and the light terms page are untouched).
Structure: how-to's three sidebar group labels are `<p class="toc-h">` (same CSS), and the terms content wrapper is `<main>`.
Measured with axe at 390 and 1280 px: `/pro/register` and `/pro/terms` clean; `/pro/how-to` 81-98 contrast nodes -> 0 (only the
`region` best-practice note on 5 nodes remains); `/pro/pricing` 3 -> 0 (one `region` note remains). Layout is unchanged (screenshots checked).
The register and pricing visual-regression baselines render the old colours, so they need a CI re-bless (CI actual, not a local render).
Left alone: `/pro/` has one `aria-allowed-role` finding (role=tabpanel on `#step-estimate`) in a script-driven demo. Back to [INDEX](../INDEX.md).
