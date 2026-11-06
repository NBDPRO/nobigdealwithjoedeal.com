# Overnight session 2026-11-05 to 06: summary and index

Unattended visual / UX / speed session. The public site was already at A11y 100 / SEO 100 / CLS 0, so the work was measured
sweeps of all 298 public pages (geometry, computed style, axe, images, forms, focus, clipping) and fixing the outliers.
Full report: `overnight/MORNING_REPORT.md` (PR table, metrics, NEEDS_JOE, backlog). Per-fix notes:
[site-visual baseline](OVERNIGHT-SITE-VISUAL-2026-11-05.md), `OVERNIGHT-A11Y-LANDMARKS-2026-11-06`,
[trust bar](OVERNIGHT-TRUST-BAR-2026-11-06.md), [login desktop](OVERNIGHT-LOGIN-DESKTOP-2026-11-06.md),
`OVERNIGHT-PROJECT-NAV-2026-11-06`, `OVERNIGHT-AREA-HERO-ALT-2026-11-06`,
[phone logo](OVERNIGHT-PHONE-LOGO-2026-11-06.md), `OVERNIGHT-BTN-44-2026-11-06`,
`OVERNIGHT-AXE-ALL-PAGES-2026-11-06`, `OVERNIGHT-DETAIL-THUMBS-2026-11-06`,
`OVERNIGHT-INSPECT-INVALID-2026-11-06`. (Names in backticks are notes that ship with PRs not merged when this was written.)
Method that worked: Playwright over every page at 390/768/1024 px, group by a computed value, read the small group. Gotchas: ports 8080 and 8765 are taken
on Jo's machine (use 18431); the repo's `INDEX.md` conflicts on every merge (keep both lines); queued PR branches reject pushes.
Back to [INDEX](../INDEX.md).
