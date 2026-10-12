# Dashboard boot weight — blocking-script budget, 2026-10-12

Lane: `perf/boot-weight`. Companion to [BOOT-WEIGHT-2026-09-06](BOOT-WEIGHT-2026-09-06.md)
(which already noted that `<template>`-inert scripts must be excluded from a
boot-weight count) and the ratchet in
`tests/dashboard-boot-budget-2026-10-03.test.js`.

## Problem

`blockingBytes` sat at 306,973 of 307,200 (LF) — 227 bytes of headroom — so
every PR touching a blocking script tripped the gate and agents spent cycles
condensing comments or pushing code into lazy bundles.

## Finding: ~43% of the "blocking" bytes never block

The gate counted every `<script src>` without `defer`/`async`/`type=module`
in `docs/pro/dashboard.html`, including ones sitting **inside a `<template>`**
(`tpl-view-settings`, `tpl-view-draw`, `tpl-view-est`). Template content is
inert: `_hydrateViewTemplate` (`docs/pro/js/dashboard-ui.js`) `importNode`s the
fragment on first open of the view and swaps each `<script>` for a fresh
`createElement` copy with `async = false`. That is a dynamic insert after
first paint — it cannot block parsing or first paint.

| | scripts | LF bytes |
|---|---|---|
| counted as blocking before | 29 | 306,973 |
| of which inside a `<template>` (inert until the view opens) | 9 | 132,882 |
| **actually parser-blocking at boot** | **20** | **174,091** (170 KB) |

No behavior changed: no tag moved, no load order changed. The measurement now
matches what the browser does.

**Caveat — "not blocking" is not "free on every load".** Template scripts are
not parser- or render-blocking, but the Settings template (~130 KB of its own
scripts) hydrates *during boot* on deep links: `#/settings`,
`?settings=billing&connect=return`, `?est=`, `?lead=`, and command-palette /
agent-bots `goTo('settings')`. On those loads it delays window `load`. The
default Today route never pays it. The test keeps this visible: a
"template-deferred" console line, its own ceiling (9 scripts / 136 KB), and
the set pinned by file name so a new template script is a conscious edit.

## Ranked list (LF bytes, document order index in brackets)

Parser-blocking at boot (counts against the ceiling):

| bytes | script |
|---|---|
| 42,027 | js/dashboard-ui-prefs-boot.js |
| 32,018 | js/script-loader.js |
| 23,863 | js/demo-mode.js (must run first on the demo; returns on line one otherwise) |
| 16,824 | js/standalone-compat.js |
| 12,490 | js/dashboard-load-status-banner.js |
| 9,477 | js/nbd-modal.js |
| 8,355 | js/dashboard-sw-bootstrap.js |
| 8,081 | js/state-store.js |
| 4,580 | js/sentry-init.js |
| 3,863 | js/dashboard-nav-init.js |
| 3,617 | js/shape-preboot.js |
| 2,088 | js/sentry-config.js |
| 1,634 | js/console-quiet.js |
| 1,142 | js/dashboard-fcm-config.js |
| 830 | js/pages/theme-init.js |
| 829 | js/theme-mode-preboot.js |
| 789 | js/material-preboot.js |
| 754 | js/dashboard-appcheck-config.js |
| 502 | js/dashboard-shortcuts-tabs.js |
| 328 | js/dashboard-loader-fadeout.js |

Inside a `<template>` (reported separately by the test now, still counted in
`localScripts` / `localBytes`):

| bytes | script | hydrates with |
|---|---|---|
| 40,416 | js/pipeline-builder.js | Settings |
| 35,430 | js/dashboard-team-tab.js | Settings |
| 24,082 | js/dashboard-connect-tab.js | Settings |
| 16,673 | js/dashboard-billing-tab.js | Settings |
| 6,751 | js/dashboard-sidebar-customizer.js | Settings |
| 4,163 | js/dashboard-custom-theme.js | Settings |
| 2,731 | js/dashboard-hotkey-toggles.js | Settings |
| 1,460 | js/dashboard-accessory-panel-init.js | Draw |
| 1,176 | js/dashboard-insurance-overlay-toggle.js | Estimates |

## What changed

`tests/dashboard-boot-budget-2026-10-03.test.js`:

- `measure()` tracks `<template>` depth; a blocking-shaped tag inside a
  template is reported as "template-deferred", not blocking. Nested templates
  handled; a tag after the template closes is blocking again.
- Sizes are LF-only (CR bytes dropped) so a Windows CRLF checkout and CI agree.
- Ceilings **lowered**, none raised: `blockingBytes` 300 KB → 192 KB
  (measured 170 KB, ~22 KB real headroom), `blockingScripts` 29 → 22
  (measured 20). `localScripts` / `localBytes` / `htmlBytes` untouched.
- HTML is read with a small tokenizer (skips comments, raw-text bodies and
  quoted attribute values; defer/async are attribute *names*; single-quoted
  and unquoted `src` are seen) instead of regexes over the raw string. The
  earlier regex depth counter was vacuous: one stray `<template>` string in an
  attribute swallowed every later script and the test stayed green.
- New guards: template depth must be 0 at EOF, the template-script set equals
  the pinned 9 files, and template-deferred has its own ceiling.
- Positive controls for each hole: `<template>` in an attribute / inline
  script, `data-async-note` / `id="async-loader"` / `?mode=defer`,
  single-quoted + unquoted src, `<!--` in an attribute, unclosed template.

## Real boot-path wins still available (not done here — each changes order)

These are genuinely blocking and the largest. None was analysed for
deferability in this lane; each needs its consumers checked for synchronous
`window.*` reads before it moves:

1. `dashboard-ui-prefs-boot.js` (42 KB) — largest; a preboot-by-name, so
   probably splittable into a tiny preboot + a deferred remainder.
2. `dashboard-load-status-banner.js` (12.5 KB) — sits at the end of the body.
3. `standalone-compat.js` (16.8 KB), `dashboard-sw-bootstrap.js` (8.4 KB).

Ceiling now leaves room to do these as separate, individually-proven PRs.
