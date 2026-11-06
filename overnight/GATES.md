# GATES — run before every push

Run from the worktree root. Baseline on untouched origin/main a9f1a50e (2026-11-05 ~21:55 ET).
`functions/` deps installed (`cd functions && npm install`; revert `functions/package-lock.json` drift with `git checkout --`).

| # | Gate | Command | Baseline |
|---|---|---|---|
| 1 | JS syntax | `node scripts/check-js-syntax.js` | PASS (29s) |
| 2 | Site integrity | `node scripts/check-site-integrity.js --quiet` | PASS |
| 3 | Partials drift | `node scripts/apply-partials.js --check --diff` | PASS |
| 4 | Sitemap drift (dry run) | `node scripts/build-sitemap.js` | PASS |
| 5 | Projects | `node scripts/build-projects.mjs --check` | PASS |
| 6 | Town pages | `node scripts/build-town-pages.mjs --check` | PASS |
| 7 | llms regions | `node scripts/build-llms.mjs --check-regions` | PASS |
| 8 | Inline scripts | `node scripts/check-inline-html-scripts.js` | PASS |
| 9 | Image privacy | `node scripts/check-image-privacy.js` | PASS |
| 10 | Vault index | `node scripts/check-vault-index.js` | PASS |
| 11 | Nav CSS | `node scripts/ensure-nav-css.js` | PASS |
| 12 | Icon CSS | `node scripts/ensure-icon-css.js` | PASS |
| 13 | Chrome governance | `node scripts/check-chrome-governance.js` | PASS |
| 14 | Marketing polish contract | `node tests/marketing-polish-contract.test.js` | PASS (12s) |
| 15 | Smoke | `node tests/smoke.test.js` | PASS (64s) |
| 16 | QC render sweep | `node scripts/qc-render-sweep.js --base http://127.0.0.1:<port> --json <file>` | needs a server (ERR_CONNECTION_REFUSED with none) — run with `node scripts/overnight-serve.mjs --port 18431` |

Also in CI "Site integrity" job (run if the change touches them): `ensure-readability-css`, `ensure-nav-responsive-css`,
`ensure-social-css`, `ensure-footer-contrast-css`, `ensure-nav-logo-mobile-css`, `normalize-favicons --check`,
`build-feed.mjs`, `build-credentials.mjs --check`, `crm-audit.js`, `check-storage-prefix-registry.js`,
`run-test-manifest.js --check`, `tests/inline-html-scripts.test.js`.
Manifest buckets: `node scripts/run-test-manifest.js --bucket node` / `--bucket smoke`.

Helper: `bash` loop used for baseline is in the session scratchpad; the commands above are the source of truth.

## Environment notes
- Ports 8080 and 8765 are occupied on Jo's machine by unrelated apps (8080 is a SvelteKit app!). Use 18431.
- Git Bash mangles `/` args (`MSYS_NO_PATHCONV=1` required) and `/c/...` paths for Node — use repo-relative paths.
- No root package.json. Playwright + axe live in `tests/` (installed locally, lockfile untouched). Lighthouse 12.8.2 + sharp
  installed OUTSIDE the repo in `C:\Users\jonat\nbd-overnight-tools`.
- E2E / visual-regression / emulator suites need the Firebase emulator rig and CI-rendered (Linux) baselines — out of scope locally.
