# Overnight session 2026-11-05: site visual / speed / CRM polish

Unattended session in worktree `nbd-wt-overnight` (branches `overnight/2026-11-05-*`). The working files
(state, plan, log, decisions, metrics, skills log, gates) live in `overnight/` at the repo root of the
branch that carries them. Nothing was merged or deployed.

## Baseline (local server, Lighthouse 12.8.2, 2 runs/page median, 390x844 mobile)

- Homeowner pages already score A11y 100, SEO 100, BP 96. Mobile Perf is 71-96; the swing is almost
  entirely TBT (65-780 ms between pages and between runs on this machine, benchmarkIndex about 1300).
  CLS is 0 everywhere. Desktop Perf is 98-100.
- The heavy mobile TBT is first style/layout work (two observed tasks of 278 ms and 164 ms on a 673-element
  page), not script execution (`nbd-nav.js` scripting is 16 ms). It moves with machine load, so it is not a
  clean target for a code change tonight.
- Hero/LCP preloads, WebP/AVIF `<picture>`, logo `srcset`, font preloads, `defer` on every script and
  explicit image sizes are already in place; most of the seed backlog was already done.

## Shipped in PR 1 (`overnight/2026-11-05-site-visual`)

- `scripts/fix-pro-orange-fallback.js` (dry run / `--apply` / `--check`): the retired orange `#e8720c`
  survived as the fallback literal in 33 `var(--orange, #e8720c)` uses across 13 `docs/pro` CSS/JS files.
  Now `#BD5728`. The token still wins at runtime; this only changes the unthemed fallback.
- Tooling: `scripts/overnight-serve.mjs` (cleanUrls static server), `scripts/overnight-lh.mjs` (mobile and
  desktop Lighthouse batch), `scripts/overnight-shots.mjs` (390/1440 screenshots, console/404, axe),
  `scripts/overnight-asset-inventory.js` (image/CSS/JS/font inventory).

## Gotchas learned

- Ports 8080 and 8765 are taken on Jo's machine; 8080 is an unrelated SvelteKit app, so Lighthouse against
  it measures the wrong site. Use 18431.
- In Git Bash set `MSYS_NO_PATHCONV=1` and use repo-relative `--out` paths, or Node writes to `C:\c\...`.
- A backgrounded `nohup node ... &` survives its wrapper; two Lighthouse batches at once poison TBT.

Back to [INDEX](../INDEX.md).
