# CRM speed-up plan, 2026-11-04

This plan follows `documentation/audit/PERF-AUDIT-2026-11-04.md` (PR #2826) item 4. Lighthouse on the sample account
(`/pro/explore/dashboard`, phone, simulated slow 4G) measured performance 52-55, first paint 11.8 s, LCP 23.8 s, and
**475 script + 155 stylesheet requests** (169 KB of JS transferred).

The research was a read-only map of `docs/pro/dashboard.html` and its loaders. The two claims marked "checked" were
re-read in the source; the rest carry the mapper's file:line and are leads to confirm when each phase starts.

## What the dashboard actually loads

- **In the HTML:** 214 `<script src>` tags: 181 classic `defer`, 4 `type="module"`, 20 blocking at boot, and 9 more
  inside `<template>`s. Also 71 stylesheet links, all in `<head>`, so all of them block render. That's about 1.0 MB of
  raw CSS; `dashboard-app.css` alone is 283 KB.
- **At runtime:** `docs/pro/js/script-loader.js` holds 39 named `BUNDLES` (153 JS + 35 CSS entries). `today-home.js`
  starts 10 of them at boot (about 23 files); layouts, demo mode and the theme stack add more.
- **ES modules are a small part:** 12 `*.module.js` files with a shallow graph. The Firebase SDK is vendored under
  `/assets/vendor/firebase/10.12.2/` and cached for a year (immutable).
- **About 240-260 JS URLs at boot.** The other ~120-140 bundle files load when their view opens.
- **Checked: the 475 is roughly double.** `explore/demo-sw.js` maps every `/pro/explore/*` request onto `/pro/*` and
  fetches it again, so Lighthouse counts both. A signed-in visitor's real dashboard makes about half the requests.
  It's still about 250, which is a lot on a phone.
- **Checked: bundle files load one at a time.** `loadBundle` (`script-loader.js:718`) chains
  `prev.then(() => load(src))`, so each file waits for the previous one to finish **downloading**, even though
  `el.async = false` already guarantees execution order. The `expenses` view is about 35 round trips in a row and
  `estimates` about 31.
- **The `/pro` service worker** (`/pro/sw.js`) precaches only the manifest and the offline page, and revalidates every
  JS and CSS file on every load (`firebase.json`: `max-age=0, must-revalidate`). A warm visit still sends one
  conditional request per file.

## Constraints any change must respect

- **Strict CSP** (`script-src 'self'`, `script-src-attr 'none'`, no `unsafe-inline`). Bundles must be external files.
- **Classic scripts share top-level `let`/`const` across files.** The CRM was split that way deliberately (the
  "globals tranche" notes, `docs/dev/globals-*`). Plain concatenation **in document order** keeps that working.
  Wrapping each file in its own scope (an IIFE, esbuild `bundle`) breaks it. In one combined file, a single duplicate
  top-level `let` breaks the whole file instead of one script. Modules and classic scripts can't share a bundle.
- **Demo config files must stay separate:** `demo-sw.js` blanks `dashboard-appcheck-config.js`,
  `dashboard-fcm-config.js` and `sentry-config.js` by exact path, and swaps `claude-proxy.js`. Bundling them would
  ship production config into the sample account.
- **Tests read single files:** 578 of 926 tests reference `docs/pro/js` paths, and 354 load single files in a vm. 204
  read `dashboard.html`; 41 pin `?v=N`. **So bundling belongs at deploy time** (like `scripts/minify-shipped.js`,
  which already runs esbuild at deploy without bundling), never in the source tree.

## The plan, in phases

**Phase 0: a real baseline (half a day).** Measure the signed-in CRM (the emulator rig, a seeded tenant) cold and warm
at phone throttling: requests, first paint, time to a usable Home. Also re-run the sample. Every later phase is judged
against this, not against the doubled demo count.

**Phase 1: cheap wins, no bundler (one PR each, low risk).**
1. **Parallel bundle loading.** Inject every file of a bundle at once with `async = false`. The browser downloads
   them in parallel and still runs them in order. This cuts the 30-35 round-trip chains to about one, so every lazy
   view opens faster. Keep the per-file dedupe and "never reject" behavior, and add a vm test that asserts execution
   order is unchanged.
2. **Preload the module graph.** `<link rel="modulepreload">` for the vendored `firebase-app.js` and its first-level
   imports, which today are found only one hop down.
3. **View-only CSS out of `<head>`.** About 20 stylesheets for views that are lazy anyway (Storm Center, Close Board,
   Expenses, Care Plan, D2D, Money, Yard Signs, Product Library, Supplement, Voicemail) move into their bundles; the
   loader already handles `.css`. Fewer render-blocking files on every boot.
4. **Merge the Home boot bundles.** The 10 bundles `today-home.js` starts (about 23 files) become one bundle.
5. **Check eager-but-view-only scripts** (`d2d-storm-layer.js`, `smart-calendar.js`, `forecasting.js`,
   `onboarding-tour.js`, `voicemail.js`, `quick-capture-inbox.js`). Move one to lazy only after proving nothing reads
   it at boot (grep for a caller first).

**Phase 2: deploy-time concatenation (a project; plan before code).** A deploy step next to `minify-shipped.js`
concatenates the classic `defer` scripts, in document order, into a few files (for example shell, CRM core, Home) and
rewrites `dashboard.html` in the deploy copy only. Excluded: modules, `<template>` scripts and the demo config files.
The source tree and the 354 vm tests are unchanged. What needs work: `dashboard-boot-budget`, `e2e/boot-weight`,
`e2e/globals-surface-snapshot` and the pro-demo zero-network job. A pre-deploy check fails on any duplicate top-level
declaration across the concatenated files. That takes boot from roughly 200+ requests to about 10-20.

**Phase 3: the service worker (after Phase 2).** With a few versioned bundle files, `/pro/sw.js` can cache them
cache-first, so a warm visit makes almost no requests. Doing this before Phase 2 would mean versioning 240 files.

**Sample account only:** a Hosting rewrite of `/pro/explore/js/**` → `/pro/js/**` might let `demo-sw` stop re-fetching
plain files (unverified). It still has to intercept the config and SDK paths, so any change there must keep the
zero-network guarantee.

## Order and expected effect

Start with Phase 0, then Phase 1.1 (parallel bundles), the biggest felt win per line changed. Then 1.3 and 1.2, then
1.4. Phase 2 gets its own written design and Jo's go-ahead before code, because it changes what ships.
