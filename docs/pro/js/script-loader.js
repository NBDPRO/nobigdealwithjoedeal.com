/**
 * script-loader.js — lazy-load view-specific bundles
 *
 * The dashboard historically eager-loaded ~65 deferred scripts on every
 * page open. Most of those (academy, storm, close-board, rep-os, etc.)
 * are only relevant to one specific view, yet they still cost parse +
 * execution time at first paint.
 *
 * This loader lets us keep the critical boot path lean (crm, home,
 * widgets, auth, maps, ui, ai) while deferring view-only modules until
 * the user actually navigates to that view. Scripts are cached after
 * first load so subsequent visits to a view are instant.
 *
 * The loader is a DROP-IN addition — it does not take over the <script
 * defer> tags. Dashboard.html hooks it into goTo() so each view
 * preload runs before its init callback.
 *
 * Public API:
 *   ScriptLoader.load(src)            → Promise<void> — load one file
 *   ScriptLoader.loadBundle(name)     → Promise<void> — load a named group
 *   ScriptLoader.preloadForView(name) → Promise<void> — load all bundles for a view
 *   ScriptLoader.isLoaded(name)       → boolean
 *
 * Script identity is the RESOLVED PATH (see cacheKey), so a file already on
 * the page as an eager <script> tag is never re-injected, whatever path form
 * or ?v= cache-buster either reference happens to use.
 */
// CSP fix: the Google Fonts preload->stylesheet swap lived in an inline
// onload attribute, which script-src-attr 'none' blocks — so the 14 theme
// font families NEVER applied in prod (every themed surface fell back to
// system fonts). Flip rel from JS instead; load-listener plus a short
// failsafe covers the already-loaded race.
(function () {
  var l = document.querySelector('link[data-nbd-font-swap]');
  if (!l) return;
  var done = false;
  var flip = function () { if (done) return; done = true; l.rel = 'stylesheet'; };
  l.addEventListener('load', flip, { once: true });
  setTimeout(flip, 3000);
})();

(function () {
  'use strict';

  if (window.ScriptLoader && window.ScriptLoader.__sentinel === 'nbd-script-loader-v2') return;

  const loaded = new Set();
  const pending = new Map();

  // Identity of a script = its resolved path, NOT the src string as written.
  // Two things used to defeat the old raw-string comparison:
  //   1. path form   — '/pro/js/x.js' (customer.html) vs 'js/x.js' (bundles)
  //   2. cache-buster — 'js/x.js?v=7' vs 'js/x.js?v=10' (same bytes on disk)
  // Both resolve to the same pathname, so both dedupe correctly now.
  function cacheKey(src) {
    if (!src) return '';
    try {
      const u = new URL(src, document.baseURI);
      return u.origin + u.pathname;
    } catch (e) {
      return String(src).split('?')[0].split('#')[0];
    }
  }

  // Files we ship on-demand. Anything NOT listed here stays in the
  // eager <script defer> list in dashboard.html. Each bundle is a
  // list of files that load together (parallel fetch).
  const BUNDLES = {
    // Academy / training — never loaded unless the user enters an
    // academy or training tab. Biggest single lazy win (~150KB).
    academy: [
      'js/academy-insurance-tree-data.js?v=2',
      'js/academy-insurance-tree.js?v=2',
      'js/academy-retail-tree.js?v=1',
      'js/academy-courses.js?v=1',
      'js/academy-admin.js?v=3',
      'js/real-deal-academy-lab.js?v=2',
      'js/real-deal-academy.js?v=3'
    ],
    training: [
      // Step 4f (2026-05-17): sales-training.js split into engine +
      // ui modules + thin shim. Load order: engine → ui → shim.
      'js/sales-training-engine.js?v=2',
      'js/sales-training-ui.js?v=3',
      'js/sales-training.js?v=2'
    ],
    storm: [
      'js/storm-center.js?v=5',
      'js/storm-integration.js?v=2',
      // SPC Day-1 outlook overlay (2026-09-05). Independent of the other two;
      // storm-center calls window.StormOutlook defensively if it is present.
      'js/storm-outlook.js?v=1'
    ],
    closeboard: [
      // The shared financing APR band (public estimator + deal page, 2026-10-03)
      // — close-board.js prints payments only from it.
      '/assets/js/financing-band.js?v=1',
      'js/close-board.js?v=9'
    ],
    // Expenses & supplier-spend view — only loaded on the Expenses tab.
    // expense-config.js (the shared category/money source of truth) MUST load
    // before expenses.js, which reads window.ExpenseConfig at render time.
    // profit-tracker.js is NOT loaded anywhere else on dashboard.html (only
    // customer.html loads it), and expenses.js's per-job margin calls
    // window.ProfitTracker.computeJobPLWithExpenses at render — so it must ride
    // this bundle or the margin silently degrades to "set Job Value".
    expenses: [
      'js/expense-config.js?v=2',
      // Same ?v as customer.html, which keeps this file EAGER: its
      // renderCostPanel('profitPanel') runs during the customer render, so it
      // cannot be lazy there. Same cache key on both pages.
      'css/profit-tracker-view.css?v=1',
      'js/profit-tracker.js?v=4',
      'js/expenses.js?v=8',
      // Home Depot Pro Xtra CSV import (2026-09-29) — the header button only
      // renders when this has loaded.
      'js/hd-import.js?v=3',
      // The company price book (2026-10-02) — hd-import.js records each
      // receipt's SKU prices into it; loads after, read at call time.
      'js/price-book.js?v=2'
    ],
    // Money / P&L capstone — self-contained (reads doc fields directly, no
    // ExpenseConfig dependency), so it's a single-module bundle.
    money: [
      'js/stripe-ledger-ui-logic.js?v=1',
      'js/stripe-ledger-panel.js?v=1',
      // One-tap overdue reminder (2026-10-01): the Collections queue's "Remind".
      'js/invoice-reminder.js?v=4',
      'js/money-dashboard.js?v=8'
    ],
    repos: [
      'js/rep-os.js?v=3'
    ],
    // Yard-sign tracker (2026-09-29): placements, photos, pickup dates +
    // reminders. Pure rules first so the view can use them at init.
    signs: [
      'js/yard-signs-logic.js?v=3',
      'js/yard-signs.js?v=5'
    ],
    // Past Customers win-back list (2026-10-01): pure rules + drafts first,
    // then the view. Nothing is sent without the rep tapping Send.
    winback: [
      'js/winback-logic.js?v=1',
      'css/winback-view.css?v=1',
      'js/winback.js?v=2'
    ],
    decision: [
      'css/decision-engine-view.css?v=2',
      'js/decision-engine.js?v=4'
    ],
    reports: [
      // ApexCharts must load BEFORE rep-report-generator.js, which calls
      // `new ApexCharts(...)` when the Rep Report view renders its charts.
      // It was eager in dashboard.html (~150 KB gzipped on every boot);
      // PR 2a moved it here so it loads only when the reports view opens.
      // loadBundle() runs entries sequentially (async=false), so the
      // ApexCharts global is defined before the generator executes. If the
      // CDN fetch fails, load() resolves anyway and the generator's existing
      // `typeof ApexCharts === 'undefined'` guard degrades gracefully.
      '/assets/vendor/apexcharts/apexcharts.min.js',
      'js/rep-report-generator.js?v=6'
    ],
    // Doc-generation cluster (PR 2b). Only needed when the rep generates a
    // document — from a lead-card doc chip (_generateDocWithPreflight) or
    // inside the Docs view. ~420 KB off the boot path. Order matters:
    // nbd-logo-asset + document-generator define the globals that
    // document-generator-templates augments and doc-preflight consumes.
    // Version strings match customer.html's retired eager tags (v=10 / v=8).
    // They were v=7 here, so a rep who opened both pages fetched the same two
    // files twice under two cache keys. One key per file, repo-wide.
    docgen: [
      'js/nbd-logo-asset.js?v=3',
      'js/nbd-badge-assets.js?v=1',
      'js/document-generator.js?v=14',
      'js/document-generator-templates.js?v=12',
      'js/document-generator-library.js?v=1', // 2026-10-04 template library; needs -templates' _tpl
      'js/doc-preflight.js?v=4',
      // Mobile job-detail Documents tab (dashboard-actions.js
      // _mountDocumentsHub) reads leads/{id}/documents through this same
      // store customer.html uses — one reader, not a second copy of the
      // fetch/normalize logic. Version matches customer.html's own tag.
      'js/customer-documents.js?v=7',
      // Same tab's "scan/upload a signed document" rows (2026-09-17) —
      // uploadSignedDoc/handleSignedDocUpload are the exact functions
      // customer.html's Documents tab uses; no second upload path.
      'js/customer-signed-doc-upload.js?v=3'
    ],
    // Estimate engine (PR 2c). The revenue-critical builder + its product/
    // catalog data. Only needed when the rep builds an estimate, opens the
    // Estimates/Products view, or the estimate-defaults settings tab. ~530 KB
    // off the boot path. ORDER IS load-bearing and verified by
    // tests/e2e/estimate-engine.spec.js (snapshot: 222 products / 298 merged
    // catalog keys / 270 xactimate):
    //   product-data → roofivent-catalog (merges into NBD_PRODUCTS) →
    //   catalog-costs (merges the private cost/labor half back in) →
    //   product-library (reads NBD_* + defines _productLib, before estimates.js) →
    //   estimate-builder-v2 (defines EstimateBuilderV2.CATALOG) BEFORE
    //   estimate-catalog-xactimate (merges 277 items into that CATALOG at load) →
    //   estimates (window.R, startNewEstimate) → finalization → v2-ui (last).
    // estimate-config, review-engine, property-intel stay EAGER.
    //
    // catalog-costs MUST sit between the catalogs and product-library: the
    // catalog files no longer carry cost/labor (they are public files on a
    // public repo), and product-library seeds localStorage synchronously at
    // load. Its cache-first pass patches window.NBD_PRODUCTS in time on any
    // device that has hydrated before; the async fetch behind it calls
    // _productLib.applyCostSeed for the cold-device case.
    //
    // catalog-costs ALSO feeds the job-template custom-item bridge
    // (2026-08-18). job-templates-data.js no longer carries the 84 custom
    // items' materialCost/laborCost either; job-templates.js reads them from
    // NBDCatalogCosts.jobItem() at its own load time. It sits fourteen entries
    // BELOW catalog-costs here, so on a warm device the book is already in
    // memory when registerAllCustomItems() runs; on a cold device
    // catalog-costs calls JobTemplates.applyJtCostSeed() once Firestore
    // answers, which re-registers every item and drops the UI band cache.
    // 'job-templates': ['estimates'] below is the ONLY entry point, so there
    // is no page where job templates load without the cost book.
    estimates: [
      // The full brand mark for the V2 Retail Quote / Insurance Scope exports.
      // Without it _brandLogoSrc() fell back to nbd-logo.png, which renders
      // only "DEAL / Home Solutions" — a different letterhead from every
      // Templates document. Same cache key as the docgen bundle.
      'js/nbd-logo-asset.js?v=3',
      'js/product-data.js?v=3',
      'js/roofivent-catalog.js?v=2',
      'js/catalog-costs.js?v=3',
      'js/product-library.js?v=8',
      // Price book viewer (2026-10-02): the Product Library's "Price book"
      // button. Same file the expenses bundle loads for the HD import.
      'css/price-book.css?v=1',
      'js/price-book.js?v=2',
      'js/estimate-labor-catalog.js?v=2',
      'js/estimate-builder-v2.js?v=9',
      'js/estimate-catalog-xactimate.js?v=3',
      'js/estimate-logic-engine.js?v=7',
      // Classic review step's layout (reskin 2026-10-03), before the script.
      'css/estimates-review.css?v=1',
      'js/estimates.js?v=12',
      // Rock 2 PR 6: the New-Estimate front door (chooser) split out of
      // estimates.js. Loads after it — showNewEstimateChooser falls back to
      // estimates.js's showEstimateTypeSelector when V2 is missing.
      'js/estimate-entry.js?v=1',
      // Rock 2 PR 6: the estimates-list row actions (Firestore CRM ops, no
      // pricing math) split out of estimates.js.
      'js/estimate-crm-ops.js?v=3',
      'js/estimate-finalization.js?v=6',
      'js/estimate-v2-ui.js?v=21',
      // V3 (2026-10-02): the one-thumb step-by-step layer over the V2 modal.
      // V2's open()/render() call it if present, so it may load after.
      'js/estimate-v3-wizard.js?v=4',
      'js/estimate-supplement.js?v=2',
      'js/supplement-ui.js?v=3',
      // Job templates ride the estimates bundle: data is inert, the engine
      // resolves through EstimateLogic + registers custom items into
      // EstimateBuilderV2.CATALOG (so it must load after both), and the UI
      // inserts into the V2 builder — end-of-bundle satisfies all three.
      // entity-resolver.js (the lead search/quick-create picker) must load
      // before job-templates-ui.js, which calls it from paintModal.
      'js/job-templates-data.js?v=4',
      'js/job-templates.js?v=6',
      'js/entity-resolver.js?v=2',
      'js/job-templates-ui.js?v=8',
      // Upgrades & Add-ons (2026-09-25): the retail upgrade library, then the
      // pure pricing core that reads it, then Settings → Upgrade prices,
      // which needs both. The Estimates settings tab loads this bundle
      // before _loadEstimateDefaultsV2 renders the panel. Its stylesheet
      // rides here too: nothing outside that panel uses it. The Job Templates
      // Upgrades card (job-templates.js applyUpgrades) and V2's reopen of an
      // upgraded estimate (estimate-v2-ui.js) read NBDUpgrades at CALL time
      // only, so their place after both in this list is safe (stage 2 card).
      // 2026-09-25 (PR #1774, company-profile boot retry): the settings
      // panel repaints on its tenant's landing and checks its save's key —
      // v1 -> 3 (#1776 had already shipped its own edit as v2), and this
      // file's own ?v 11 -> 12 in dashboard.html + customer.html.
      'css/upgrade-price-settings.css?v=1',
      'js/upgrade-library.js?v=1',
      'js/upgrade-pricing.js?v=2',
      'js/upgrade-price-settings.js?v=3'
    ],
    // Photo + inspection engine (PR 2d). Camera capture / gallery / lightbox /
    // bulk-analyze (photo-engine), the photo-report doc (photo-report), and the
    // inspection report builder (inspection-report-engine). ~200 KB off boot.
    // Only needed on the Photos view or the card-detail photo/camera/inspection
    // buttons. Every consumer guards on the global, and the entry points have
    // load-then-run stubs in dashboard-actions.js, so a click before the bundle
    // loads still works.
    photos: [
      'js/photo-engine.js?v=8',
      // photo-queue-store.js + photo-queue-recovery.js were static-tagged
      // only on dashboard.html until 2026-09-14 — customer.html's own
      // uploadSinglePhoto never enqueued a photo into the durable IndexedDB
      // queue before attempting the network upload, so a no-signal shot from
      // this page was lost outright (not merely delayed) on a failed upload
      // or a reload mid-upload. Bundled here, NOT static-tagged, per the
      // existing dedupe trap this file documents elsewhere: ScriptLoader
      // dedupes on resolved path, so an eager tag for either file would make
      // loadBundle('photos') a no-op for it and nothing would load lazily.
      'js/photo-queue-store.js?v=3',
      'js/photo-queue-recovery.js?v=2',
      // KY claim-wording filter (2026-10-04) — BEFORE the two report
      // builders, which run every caption / report string through it.
      'js/claim-wording-filter.js?v=1',
      'js/inspection-report-engine.js?v=7',
      'js/photo-report.js?v=5'
    ],
    // D2D tracker (PR 2e). The door-to-door knock tracker — only the D2D
    // view uses it. ~180 KB off boot. Load order locked: core publishes
    // window._D2DState, ui extends it, the shim composes window.D2D from both.
    // goTo('d2d')'s existing waitForD2D() poller handles the late load; the one
    // other consumer (crm-pipeline.js) guards on window.D2D. The maps engine
    // stays eager — maps.js doubles as the theme/font appearance engine.
    d2d: [
      // Pure knock→lead rules + the lead event writer the core's convert uses (2026-10-03).
      'js/d2d-knock-lead-logic.js?v=1',
      'js/lead-events.js?v=1',
      'js/d2d-tracker-core-2026b.js?v=13',
      'js/d2d-tracker-ui-2026b.js?v=7',
      'js/d2d-tracker-2026b.js?v=3'
    ],
    // PDF export libs (PR 2b2). jsPDF + html2pdf — ~1.1 MB combined (html2pdf
    // bundles html2canvas + its own jsPDF). The ONLY dashboard consumer is the
    // doc-viewer's "Download PDF" handler (nbd-doc-viewer.js handlePdf), which
    // load-then-runs this bundle on demand. Standalone jsPDF is unused on the
    // dashboard (only customer.html instantiates it) but kept here for safety.
    pdfexport: [
      '/assets/vendor/jspdf/jspdf.umd.min.js',
      '/assets/vendor/html2pdf/html2pdf.bundle.min.js'
    ],
    // Warranty cert wizard — opened from the Docs view only.
    warranty: [
      'js/warranty-cert.js?v=6'
    ],
    // Theme engine cluster (2026-08-07). The 189-theme engine (162 KB) + its
    // four cosmetic companions were eager on every boot; they are a Settings/
    // picker concern. dashboard-state.js kicks this bundle at boot for users
    // with a saved theme (fetch off the parse path); default-theme users load
    // it with the Settings view or the theme picker. Order: engine first —
    // companions read window.ThemeEngine at init. After this bundle resolves,
    // loadBundle() calls window._nbdInitThemeStack (dashboard-ui.js owns the
    // init sequence; the hook is idempotent).
    theme: [
      'js/theme-engine.js?v=7',
      'js/theme-overlays.js?v=3',
      'js/theme-sounds.js?v=1',
      'js/theme-achievements.js?v=1',
      'js/theme-gx.js?v=2'
    ],
    // Leaflet vendor stack (~225 KB, 2026-08-07) — was eager on every boot for
    // a Maps view most sessions never open. Order is load-bearing: plugins
    // extend window.L. Consumers already tolerate late arrival: goTo('map'/
    // 'draw') sits behind waitForLeaflet(), storm-center's initMap self-polls,
    // d2d retries with a friendly failure state, and the two home widgets
    // (weather-radar, territory-mini) load-then-run via widgets.js
    // _withLeaflet. maps-core.js → maps-overlays.js → maps.js stay eager —
    // maps.js doubles as the theme/font appearance engine and neither of the
    // other two references anything drawing-tool-specific. maps-routing.js
    // (the fourth sibling in that split — see its own header) moved to the
    // `drawtool` bundle below (2026-09-14, boot-weight containment): it's
    // 172 KiB, the #2 static file on the page, and nothing but the draw view
    // touches it. Safe because dashboard-actions.js's goTo('draw') already
    // polls window.initDrawMap via the same waitForMapFn() used for Leaflet
    // itself, and `drawMap` (its one bare sibling-scope global, per that
    // file's header) has exactly one unguarded external read — fixed
    // alongside this move at dashboard-ui.js's drawSearch autocomplete
    // callback.
    // The four Leaflet stylesheets (21.8 KiB) were render-blocking <link>s in
    // dashboard.html's <head> even though the JS below them has been lazy
    // since 2026-08-07 — CSS for a map most sessions never open, on the
    // critical path of every boot. They ride the bundle now, and lead it, so
    // the panes are styled before leaflet.js constructs a map.
    mapvendor: [
      '/assets/vendor/leaflet/leaflet.css',
      '/assets/vendor/leaflet-draw/leaflet.draw.css',
      '/assets/vendor/leaflet-markercluster/MarkerCluster.css',
      '/assets/vendor/leaflet-markercluster/MarkerCluster.Default.css',
      '/assets/vendor/leaflet/leaflet.js',
      '/assets/vendor/leaflet-draw/leaflet.draw.js',
      '/assets/vendor/leaflet-heat/leaflet-heat.js',
      '/assets/vendor/leaflet-markercluster/leaflet.markercluster.js'
    ],
    // Drawing-tool surface (172 KiB) — see the mapvendor comment above.
    // Requires mapvendor (Leaflet) to already be present; VIEW_BUNDLES lists
    // both for the 'draw' route so ScriptLoader resolves them in order.
    // draw-geom.js (2026-09-25, draw lane L1) is the pure geometry/totals
    // module the phone Draw rebuild moves maps-routing.js onto. It rides
    // FIRST so window.NBDDrawGeom exists before maps-routing.js runs; in
    // L1 nothing calls it yet. This registry edit re-bumps script-loader.js's
    // own ?v in dashboard.html + customer.html (the #1712 sweep convention).
    // 2026-09-25 (draw lane L2): maps-routing.js now calls it (totals,
    // restore, estimate import) — both re-versioned together, and this file's
    // own ?v re-bumped 7 -> 8 (after #1762's registry edit took 7).
    // 2026-09-25 (draw lane L3): maps-routing.js gains the crosshair-ready
    // engine seam (drawMap.nbdDraw) — v5 -> v6; this file's own ?v 8 -> 9.
    // draw-reticle.css + draw-reticle.js (2026-09-25, draw lane L4) are the
    // phone crosshair screen. They ride AFTER maps-routing.js (the smoke pin
    // only needs draw-geom -> maps-routing first) and stay lazy with it; the
    // JS returns at once unless (pointer: coarse), so desktop gets nothing
    // but the two small fetches. On a phone it ships OFF (Jo's release gate):
    // it adds only a "Crosshair drawing (beta)" switch to ☰ Tools until the
    // rep turns that on. Stylesheet first, so the bar is styled the moment
    // the JS builds it. This file's own ?v re-bumped 9 -> 10.
    drawtool: [
      'css/maps-routing-view.css?v=2',
      'js/draw-geom.js?v=2',
      'js/maps-routing.js?v=9',
      'css/draw-reticle.css?v=1',
      'js/draw-reticle.js?v=1',
      // Instant Roofer cross-check card + the V3 wizard's "Draw it" hand-off
      // (2026-10-04). Last: it binds to the engine seam like draw-reticle.
      'css/draw-measure-check.css?v=1',
      'js/draw-measure-check.js?v=1'
    ],
    // Talk Tank inbox (2026-09-14, boot-weight containment) — a single-view
    // module with zero callers outside goTo('talk-tank'); was two static
    // <script> tags away from the same treatment already given to
    // storm/closeboard/expenses/money/repos below.
    talktank: [
      'js/talk-tank.js?v=1'
    ],
    // Call Center (2026-10-01): one view, goTo('calls') only.
    callcenter: [
      'js/call-center-view.js?v=11'
    ]
  };

  // View → bundle mapping. Routes hit by goTo(name) trigger these.
  const VIEW_BUNDLES = {
    docs:        ['warranty', 'docgen'],
    documents:   ['warranty', 'docgen'],
    est:         ['estimates'],
    products:    ['estimates'],
    'job-templates': ['estimates'],
    photos:      ['photos'],
    d2d:         ['mapvendor', 'd2d'],
    academy:     ['academy'],
    training:    ['training'],
    storm:       ['mapvendor', 'storm'],
    closeboard:  ['closeboard'],
    expenses:    ['expenses'],
    money:       ['money'],
    signs:       ['mapvendor', 'signs'],
    winback:     ['winback'],
    repos:       ['repos'],
    'talk-tank': ['talktank'],
    calls:       ['callcenter'],
    aitree:      ['decision'],
    understand:  ['decision'],
    reports:     ['reports'],
    map:         ['mapvendor'],
    draw:        ['mapvendor', 'drawtool'],
    settings:    ['theme']
  };

  // A bundle entry ending in .css is injected as a stylesheet instead of a
  // script. Same dedupe key, same sequential ordering inside loadBundle, so a
  // vendor's CSS can sit directly above the JS that needs it.
  function loadCss(href) {
    const key = cacheKey(href);
    if (loaded.has(key)) return Promise.resolve();
    if (pending.has(key)) return pending.get(key);
    try {
      const links = document.querySelectorAll('link[rel="stylesheet"][href]');
      for (let i = 0; i < links.length; i++) {
        if (cacheKey(links[i].getAttribute('href')) === key) {
          loaded.add(key);
          return Promise.resolve();
        }
      }
    } catch (e) {}
    const p = new Promise((resolve) => {
      const el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
      const done = () => { loaded.add(key); pending.delete(key); resolve(); };
      el.onload = done;
      // Never reject — a missing stylesheet must not stall the JS behind it.
      el.onerror = () => { console.warn('[ScriptLoader] failed to load:', href); pending.delete(key); resolve(); };
      document.head.appendChild(el);
    });
    pending.set(key, p);
    return p;
  }

  function load(src) {
    if (/\.css(\?|#|$)/i.test(String(src))) return loadCss(src);
    const key = cacheKey(src);
    if (loaded.has(key)) return Promise.resolve();
    if (pending.has(key)) return pending.get(key);
    // A page may already ship this file as an eager <script> tag
    // (the legacy twin, retired 2026-09-02, kept Leaflet + the theme cluster eager) —
    // never double-inject. If the eager tag is still queued (defer), the
    // consumer's own guard/poll covers the gap, same as a slow fetch.
    //
    // Compare RESOLVED keys, not raw src strings. customer.html writes its
    // tags absolute (`/pro/js/supplement-ui.js?v=1`) while the bundles here
    // are page-relative (`js/supplement-ui.js?v=1`); a raw-string match sees
    // two different files and re-injects, leaving a second supplement-ui.js
    // tag in the DOM and re-parsing the file. (Corrected 2026-09-07: an
    // earlier version of this comment said that left TWO document.body
    // MutationObservers. It did not — supplement-ui.js:34 returns on its own
    // __NBD_LOADED sentinel before _bootstrap() registers one. The cost is the
    // duplicate tag and parse, which is what the e2e gate asserts.) Same trap
    // for a `?v=` bump.
    try {
      const tags = document.querySelectorAll('script[src]');
      for (let i = 0; i < tags.length; i++) {
        if (cacheKey(tags[i].getAttribute('src')) === key) {
          loaded.add(key);
          return Promise.resolve();
        }
      }
    } catch (e) {}

    const p = new Promise((resolve) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = false; // preserve execution order within a bundle
      el.onload = () => {
        loaded.add(key);
        pending.delete(key);
        resolve();
      };
      el.onerror = () => {
        // Never reject — a missing lazy module shouldn't break the app.
        // Individual views already tolerate missing modules (they log
        // and render an empty state).
        console.warn('[ScriptLoader] failed to load:', src);
        pending.delete(key);
        resolve();
      };
      document.head.appendChild(el);
    });
    pending.set(key, p);
    return p;
  }

  function loadBundle(name) {
    const bundle = BUNDLES[name];
    if (!bundle) return Promise.resolve();
    // Sequential load to preserve dependency order (engine before UI).
    const p = bundle.reduce((prev, src) => prev.then(() => load(src)), Promise.resolve());
    // Theme cluster needs a one-shot init after arrival, whichever path
    // loaded it (boot kick, Settings view, picker). dashboard-ui.js owns
    // the sequence and the hook is idempotent.
    if (name === 'theme') {
      return p.then(() => {
        try { if (window._nbdInitThemeStack) window._nbdInitThemeStack(); } catch (e) {}
      });
    }
    return p;
  }

  function preloadForView(name) {
    const bundleNames = VIEW_BUNDLES[name];
    if (!bundleNames || !bundleNames.length) return Promise.resolve();
    return Promise.all(bundleNames.map(loadBundle));
  }

  function isLoaded(name) {
    if (loaded.has(cacheKey(name))) return true; // a src
    const bundle = BUNDLES[name];
    if (!bundle) return false;
    return bundle.every(src => loaded.has(cacheKey(src)));
  }

  // markLoaded() was removed on 2026-09-06. It existed so a page could tell
  // the loader "this file is already in my <script defer> list, don't fetch
  // it again" — but nothing ever called it in the four months it shipped, and
  // the only reference was a smoke test asserting it was exported. The
  // cacheKey() scan of live <script src> tags in load() now does that job
  // automatically, for every page, with no hand-maintained list to drift.

  function debug() {
    console.group('[ScriptLoader]');
    console.log('loaded:', Array.from(loaded));
    console.log('pending:', Array.from(pending.keys()));
    console.log('bundles:', Object.keys(BUNDLES));
    console.log('views:', Object.keys(VIEW_BUNDLES));
    console.groupEnd();
  }

  window.ScriptLoader = {
    __sentinel: 'nbd-script-loader-v2',
    load,
    loadBundle,
    preloadForView,
    isLoaded,
    debug,
    bundles: BUNDLES,
    views: VIEW_BUNDLES
  };
})();
