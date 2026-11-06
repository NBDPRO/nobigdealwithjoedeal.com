# PLAN (verified against code 2026-11-05)

Seeds already DONE in main: hero/LCP preload + WebP, `<picture>` WebP/AVIF project cards with -640 variants, logo srcset (150/300/450w WebP),
font preloads + self-hosted woff2 + nbd-fonts.css, all scripts `defer`, GA/Clarity deferred loaders, explicit width/height (inventory --check).

| # | Item | Theme | Imp | Conf | Risk | Effort | Status |
|---|---|---|---|---|---|---|---|
| 1 | Retire #e8720c fallbacks in docs/pro (33 uses) | pro-ux | 2 | 5 | L | S | DONE |
| 2 | Local audit tooling (serve/lh/shots/inventory) | tooling | 3 | 5 | L | S | DONE |
| 3 | Mobile TBT (first layout) | site-perf | 3 | 2 | M | M | DEFERRED: noise > signal locally; needs quieter machine |
| 4 | Homepage hero video 2 MB on cellular | site-perf | 3 | 3 | M | M | NEEDS_JOE (already flagged in PERF-AUDIT) |
| 5 | CRM request count (475 scripts) | pro-perf | 5 | 3 | H | L | OUT: other worktrees (concat/bundles) own it |
