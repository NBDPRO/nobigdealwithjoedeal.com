# Morning report — overnight 2026-11-05

## TL;DR
- The public site was already near its ceiling: A11y 100, SEO 100, BP 96, CLS 0 on all 10 baseline pages; desktop Perf 98-100; mobile Perf 71-96 (local, noisy). Most seed items (hero preload, WebP/AVIF, logo srcset, fonts, defer) were already shipped.
- I did NOT chase mobile TBT: the cost is first style/layout, not script, and swings ±300 ms with machine load. Nothing public changed, so nothing public can regress.
- One real fix: 33 stale `var(--orange, #e8720c)` fallbacks in 13 `docs/pro` files are now `#BD5728` (codemod with `--check`).
- Added a local audit harness (static server, Lighthouse batch, screenshots+axe, asset inventory) and a baseline.
- Merge PR #2894 when CI is green. Nothing was merged or deployed.

## PRs
| PR | Theme | Summary | Risk | CI |
|---|---|---|---|---|
| [#2894](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2894) | pro-ux + tooling | orange fallback codemod; audit scripts; baseline | L | running at last check (19 pending); Auto-fix watching |

Only one PR: I found no further verified, safe improvements worth shipping, so I chose not to pad the list.

## Metrics
Baseline table: `overnight/METRICS.md` (median of 2 local Lighthouse runs). AFTER equals BEFORE for public pages (no public files changed). Screenshots: `overnight/baseline/shots/before/` (only those ≤200 KB are committed; the 1440 full-page shots over that limit are not). No `report.html` built: there are no after-shots to compare.

## Skills/tools
No GitHub discovery sweep was run: with nothing to adopt for a change that touched no public assets, I judged a sweep not worth the risk of importing code. Installed outside the repo: Lighthouse 12.8.2 and sharp in `C:\Users\jonat\nbd-overnight-tools`.

## NEEDS_JOE
See `overnight/NEEDS_JOE.md`: hero video weight on cellular (recommend Save-Data/slow-connection skip or a lighter phone cut); stray empty dir `C:\c\Users\jonat\AppData\Local\Temp\lhtest`.

## Attempted and reverted
Nothing reverted. Investigated mobile TBT and dropped it (observed long tasks are layout, not script; noise exceeds gain).

## Next-night backlog
1. Quiet-machine/CI Lighthouse (3 runs) to see whether mobile TBT on service pages is real; if so, `content-visibility:auto` on below-fold sections.
2. Hero video phone cut (needs Jo's call). CRM script-count work belongs to the concat/bundles worktrees.

## Rollback
Close PR #2894. Worktree `C:\Users\jonat\nbd-wt-overnight` remains (remove after merge). No quarantine dir was created. Local server on port 18431 was started by me and can be stopped.
