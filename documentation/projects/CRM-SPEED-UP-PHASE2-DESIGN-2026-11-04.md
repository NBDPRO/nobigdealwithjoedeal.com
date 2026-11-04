# CRM speed-up Phase 2: deploy-time concatenation (design, 2026-11-04)

**Status: design for Jo's go-ahead. No code yet.** Builds on the plan (`documentation/projects/CRM-SPEED-UP-PLAN-2026-11-04.md`,
PR #2830). Phase 1 shipped as #2831 (parallel bundle downloads; expenses 9.1 → 3.7 s at 150 ms RTT) and #2836
(modulepreload; the boot modules' imports start about 0.6 s earlier). Phase 1.3 (lazy view CSS) and 1.4 (merge the
Home bundles) were folded into this phase; see #2836.

## Goal

The dashboard boots about 205 script tags and 59 stylesheets (outside `<template>`s). Each is a request, and on every
warm visit `/pro/sw.js` revalidates each one with the server. Target: **about 30 script requests and 2-3 stylesheets at
boot**, with the readable source tree, the 354 single-file vm tests and today's run order unchanged.

## Shape: a deploy step, like `minify-shipped.js`

A new `scripts/concat-shipped.js` runs in `firebase-deploy.yml` (and in `ci.yml`'s pro-demo-zero-network job, so what
ships is what gets tested), **after** `minify-shipped.js` and before `firebase deploy`. Like minify, it rewrites only
the runner checkout, and `docs/` stays the source of truth. It:

1. **Reads `docs/pro/dashboard.html`** and lists the boot `<script>` tags outside `<template>`s and comments, in order.
   Today they fall into runs (B = blocking, M = module, D = defer):
   `B9 M1 B3 D3 B2 M2 B4 D11 M1 D146 B1 D21 B1`.
2. **Groups only consecutive `defer` classic scripts, breaking at every module and every blocking script.** Deferred
   classic scripts and module scripts run in one shared document order, so a group may never cross a module. That
   gives four groups (3, 11, 146 and 21 files) and leaves the 20 blocking scripts and 4 modules as they are.
3. **Writes each group as one file**, `docs/pro/js/_b/<name>.<contenthash>.js`: the already-minified files joined in
   order, one file per line, each preceded by a `;` and a `//# file: js/x.js` marker. In the deploy copy of
   `dashboard.html`, it replaces the group's tags with one `<script defer src>`. The content hash in the name makes
   the file safe to cache long, which Phase 3 uses.
4. **Does the same for the head stylesheets.** The 56 local `docs/pro/css/*` links in `<head>` become one
   `css/_b/<hash>.css` in the same directory depth, so the two files with relative `url()` still resolve. Order is
   kept, and the cascade is unchanged because order is all CSS depends on here (no `@import`, no `media=`). The one
   `/assets/css` file and Google Fonts stay separate.
5. **Leaves out, as their own tags,** the files the sample account's worker swaps by exact path
   (`dashboard-appcheck-config.js`, `dashboard-fcm-config.js`, `sentry-config.js`, `claude-proxy.js`; see
   `explore/demo-sw.js` `EMPTY_SCRIPTS` / `SWAPS`). It also leaves `<template>` scripts and lazy `ScriptLoader`
   bundles (a later 2b, below).

## What changes for JavaScript, and the guard for each

Joining classic scripts into one file is safe only if no file depended on being its own script. These are the
differences; the step **refuses to write** (the deploy fails, nothing ships) when one is found:

| Difference after joining | Measured today in the 146-file run | Guard in the step |
|---|---|---|
| A top-level `function f` declared in two files: in one script the **last** one wins for all code, even code that runs before it | 2: `renderIntelCard`, `fetchPropertyIntelModal` (`dashboard-widgets.js` and `property-intel.js`) | Parse every file (esbuild/acorn); fail on duplicate top-level function names. **Prep PR:** delete the dead copy |
| A top-level `let`/`const`/`class` declared twice is a SyntaxError for the whole group (today only the second file fails) | 0 | Same parse; fail on duplicates |
| An earlier file touching a later file's top-level `let`/`const` hits the TDZ (`typeof x` throws) instead of seeing "not defined" | 0 found by pattern scan | AST check of earlier files' references; fail, or split the group at that point |
| A top-level `'use strict'` applies only if it is first in the group, and then to every file after it | 0 files with a top-level directive (they use it inside their IIFEs) | Fail on any top-level directive not first in a group |
| `document.currentScript` would point at the group file | 0 uses | Fail on any use in a grouped file |
| **A runtime throw at a file's top level now stops the rest of the group** (today it stops only that file) | Not statically knowable | (a) Run the pro-demo zero-network walk and the authed E2E shards **on the concatenated output**, with a "no top-level error during boot" assertion. (b) The `;` + `//# file:` separators, so an error names its file |

Syntax errors can't sneak through: minify already parses every shipped file and fails the deploy on one.

## What stays the same

- `docs/`, every test that reads source, and `?v=` in the source.
- Execution order (same files, same order, same `defer` semantics).
- CSP: external files, `'self'`.
- The sample account: the swapped config files stay their own tags, and `demo-sw` maps `/pro/explore/js/_b/*` the same
  way it maps every other path.

## Error reports (Sentry)

Minify already writes source maps to a runner artifact. Concatenation writes an **index source map** (a `sections`
map: each line points at that file's own map), so stack traces resolve to the original file and line. **To verify in
step 1:** that the Sentry setup reads index maps. If it doesn't, a fallback flattens the maps into one with the
`source-map` library at deploy time.

## Rollback

One switch in the workflow (`NBD_CONCAT=0`) skips the step, so the next deploy ships separate files again. The source
tree never changes, so rollback needs no revert.

## Steps (each its own PR)

1. **Prep:** delete the dead duplicate `renderIntelCard` / `fetchPropertyIntelModal`. Check whether Sentry reads index
   maps.
2. **Build the step** behind the switch, off by default, with its own tests: the grouping, each guard proven red on a
   fixture, and the HTML rewrite. Run it in CI only (pro-demo job + an authed E2E shard on the output).
3. **Turn it on for deploys.** Measure the live signed-in dashboard cold and warm on a phone against the Phase 0
   baseline, and keep it on only if it's faster.
4. **2b, lazy bundles:** the same treatment for each `ScriptLoader` bundle (one file per bundle via a small manifest the
   loader reads).
5. **Phase 3:** `/pro/sw.js` serves the hashed `_b/` files cache-first, so a warm visit fetches almost nothing.

## Expected effect

At boot, scripts go from 205 requests to about 30 (20 blocking + 4 modules + 4 groups + the excluded config files),
and stylesheets from 59 to 3. Bytes barely change (minify already ran). The wins are fewer round trips, far fewer
service-worker revalidations on warm visits, and long-cacheable hashed files. Not addressed here: main-thread time
(Lighthouse measured about 8.9 s on the sample dashboard), which is the next thing to look at once requests are down.
