/**
 * tests/smoke/dashboard.test.js — dashboard chrome, ScriptLoader,
 * AdminManager, UI wire-ins, theme system, mobile chrome, Wave 2/3/4/5,
 * Phase C.4/C.6 inline-handler refactors, view template hydration,
 * Sentry config, NBDStore, syntax checks for dashboard-adjacent JS.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ROOT, PRO_JS, FUNCTIONS, read, readDashboard, readDashboardStyles, readCustomer, readDashboardMain, readCrm, readMaps, readD2DLive, readFunctionsIndex, syntaxCheck, jsSegments } = require('./_shared');

module.exports.run = function run(ctx) {
  const { assert, section, bumpPassed, bumpFailed } = ctx;

// ── Syntax sanity on the files we care about ────────────────
section('Syntax checks');
const syntaxFiles = [
  path.join(PRO_JS, 'script-loader.js'),
  path.join(PRO_JS, 'admin-manager.js'),
  path.join(PRO_JS, 'crm.js'),
  // Step 4b split — the four sibling modules must each parse.
  path.join(PRO_JS, 'crm-leads.js'),
  path.join(PRO_JS, 'crm-pipeline.js'),
  path.join(PRO_JS, 'crm-snooze.js'),
  path.join(PRO_JS, 'crm-portal-bridge.js'),
  path.join(PRO_JS, 'maps.js'),
  // Step 4d split — the three sibling modules must each parse.
  path.join(PRO_JS, 'maps-core.js'),
  path.join(PRO_JS, 'maps-overlays.js'),
  path.join(PRO_JS, 'maps-customers.js'),
  path.join(PRO_JS, 'maps-routing.js'),
  // Step 4f split — d2d-tracker-2026b core + ui modules must each parse.
  path.join(PRO_JS, 'd2d-tracker-core-2026b.js'),
  path.join(PRO_JS, 'd2d-tracker-ui-2026b.js'),
  path.join(PRO_JS, 'd2d-tracker-2026b.js'),
  // Step 4f split — sales-training engine + ui modules + shim must each parse.
  path.join(PRO_JS, 'sales-training-engine.js'),
  path.join(PRO_JS, 'sales-training-ui.js'),
  path.join(PRO_JS, 'sales-training.js'),
  path.join(PRO_JS, 'estimates.js'),
  path.join(PRO_JS, 'estimate-entry.js'),
  path.join(PRO_JS, 'estimate-crm-ops.js'),
  path.join(PRO_JS, 'estimate-v2-ui.js'),
  path.join(PRO_JS, 'estimate-finalization.js'),
  path.join(PRO_JS, 'nbd-doc-viewer.js'),
  // Boot-path prefs (de-moji, sizing, fonts, sidebar hidden-prefs) — a
  // parse error here silently kills every boot-applied UI pref at once.
  path.join(PRO_JS, 'dashboard-ui-prefs-boot.js'),
  // FCM Web Push token registration + its config slot — a parse error here
  // silently disables every push notification (the backend has no recipients).
  path.join(PRO_JS, 'push-registration.js'),
  path.join(PRO_JS, 'dashboard-fcm-config.js'),
  path.join(FUNCTIONS, 'index.js')
];
for (const f of syntaxFiles) {
  const result = syntaxCheck(f);
  assert('parses ' + path.relative(ROOT, f), result.ok, result.err && result.err.split('\n')[0]);
}

// ── FCM Web Push registration (client ↔ server contract) ─────
// The backend (push-functions.js) sends to users/{uid}/fcmTokens, but for a
// long time NOTHING on the client wrote that subcollection, so every push had
// zero recipients. These guards keep the registration path wired end-to-end.
section('FCM push registration');
{
  const pr = read(path.join(PRO_JS, 'push-registration.js'));
  const fcmCfg = read(path.join(PRO_JS, 'dashboard-fcm-config.js'));
  const dash = read(path.join(PRO_JS, '..', 'dashboard.html'));
  const sw = read(path.join(PRO_JS, '..', 'firebase-messaging-sw.js'));
  const pushFns = read(path.join(FUNCTIONS, 'push-functions.js'));

  // Client mints + persists a token to the exact path the server reads.
  assert('push-registration mints an FCM token (getToken)', /getToken\s*\(/.test(pr));
  assert('push-registration reads the VAPID key from config', /__NBD_VAPID_KEY/.test(pr) && /vapidKey/.test(pr));
  assert('push-registration registers the messaging service worker',
    /serviceWorker\.register\(/.test(pr) && /['"]\/pro\/firebase-messaging-sw\.js['"]/.test(pr));
  // The messaging SW must NOT register at scope /pro/ — sw.js (offline/PWA)
  // owns that scope, and a scope holds one SW, so /pro/ would clobber offline.
  assert('push-registration uses a dedicated SW scope (not /pro/, avoids clobbering sw.js)',
    /firebase-cloud-messaging-push-scope/.test(pr) && !/scope:\s*['"]\/pro\/['"]/.test(pr));
  assert('push-registration writes users/{uid}/fcmTokens', /['"]fcmTokens['"]/.test(pr) && /setDoc\s*\(/.test(pr));
  assert('push-registration only prompts on a user gesture (no page-load requestPermission)',
    /requestPermission/.test(pr) && /data-action="enable-notifications"/.test(pr));
  assert('push-registration wires a foreground onMessage handler', /onMessage\s*\(/.test(pr));
  assert('push-registration no-ops without a VAPID key (graceful)', /no-vapid/.test(pr));

  // The config slot exists and ships empty (so a real key is never committed).
  assert('dashboard-fcm-config sets window.__NBD_VAPID_KEY', /window\.__NBD_VAPID_KEY\s*=/.test(fcmCfg));
  // The VAPID public key (applicationServerKey) is public by design — committed,
  // not secret. Guard that a well-formed key is present (base64url, ~87 chars):
  // an empty/typo'd key silently disables push, and gitleaks allowlists it by
  // exact value in .gitleaks.toml.
  assert('dashboard-fcm-config carries a well-formed VAPID public key',
    /window\.__NBD_VAPID_KEY\s*=\s*["'][A-Za-z0-9_-]{80,100}["']/.test(fcmCfg));

  // Both scripts are loaded by dashboard.html (config classic+early, engine deferred).
  assert('dashboard.html loads dashboard-fcm-config.js', /src="js\/dashboard-fcm-config\.js/.test(dash));
  assert('dashboard.html loads push-registration.js (deferred)',
    /defer\s+src="js\/push-registration\.js/.test(dash));

  // The service worker the client registers actually handles background pushes.
  assert('messaging SW handles background messages', /onBackgroundMessage\s*\(/.test(sw));

  // Server still reads the same subcollection the client writes (contract).
  assert('server getUserFCMTokens reads users/{uid}/fcmTokens',
    /collection\(\s*['"]fcmTokens['"]\s*\)/.test(pushFns));
}

// ── QA sweep regression guards (Audit #4: F4/F5) ──────────
section('QA sweep fixes (F4/F5)');
{
  // F1 (template-suite writeBatch) retired — template-suite.js was removed
  // entirely (dead code: its UI was only reachable via a guard on a method
  // that never existed, and nothing consumed its API or synced data).
  const auth = read(path.join(PRO_JS, 'nbd-auth.js'));
  assert('F4: nbd-auth falls back client role to the custom claim', /_claimRole/.test(auth) && /userData\.role\s*\|\|\s*_claimRole/.test(auth));
  // F5 originally required each script to inline the functions/ resolution.
  // They now delegate to scripts/_admin.js, which owns it centrally (added
  // with the firebase-admin v14 port — v14 removed admin.apps/.firestore()/
  // .auth()/.credential, and nineteen scripts had copy-pasted the dead
  // pattern). The invariant is unchanged: never a bare require that would
  // need a root node_modules, which does not exist. So accept either shape —
  // and pin that _admin itself really does resolve out of functions/,
  // otherwise the indirection could hide a regression.
  const adminHelper = read(path.join(ROOT, 'scripts', '_admin.js'));
  assert('F5: scripts/_admin.js resolves firebase-admin from functions/',
    /require\.resolve\(['"]firebase-admin['"]/.test(adminHelper)
    && /createRequire\(/.test(adminHelper)
    && /'functions'/.test(adminHelper));
  assert('F5: scripts/_admin.js exports the modular API the scripts need',
    /getFirestore/.test(adminHelper) && /getAuth/.test(adminHelper)
    && /applicationDefault/.test(adminHelper));
  for (const s of ['seed-access-codes.js', 'grant-admin-claim.js', 'grant-demo-claim.js']) {
    const src = read(path.join(ROOT, 'scripts', s));
    assert('F5: ' + s + ' resolves firebase-admin from functions/ (inline or via _admin)',
      /require\.resolve\(['"]firebase-admin['"]/.test(src)
      || /require\(['"]\.\/_admin['"]\)/.test(src));
  }
}

// ── Template-suite removal + Message Templates wiring ──────────
// template-suite.js (NBDTemplateSuite) was deleted as dead code: its UI was
// gated on window.NBDTemplateSuite.render, a method it never exposed (the
// real name was renderTemplateLibrary), so the branch never fired — and had
// it fired it would have clobbered the curated docgen docs view. Nothing
// consumed its API, localStorage seed, or Firestore sync. The live snippet
// engine is templates-library.js (TemplatesLibrary), which IS consumed
// (portal-link-helpers pickAndRender, smart-followup apply) and whose
// manager UI is now reachable from the docs view header.
section('Template-suite removal + TemplatesLibrary manager wiring');
{
  const dash = readDashboard();
  const dashHtml = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const tl = read(path.join(PRO_JS, 'templates-library.js'));

  // 1. The dead module stays dead — no file, no script tag, no guard branch.
  assert('template-suite.js stays deleted',
    !fs.existsSync(path.join(PRO_JS, 'template-suite.js')),
    'template-suite.js came back — its UI was unreachable dead code, see PR');
  assert('dashboard.html does not load template-suite.js', !/template-suite\.js/.test(dashHtml));
  assert('no NBDTemplateSuite references remain in dashboard shards', !/NBDTemplateSuite/.test(dash));

  // 2. The docs view header wires the TemplatesLibrary manager via the
  //    CSP-safe module dispatch (no inline handlers, no registry entry —
  //    module dispatch resolves window.TemplatesLibrary.openManager).
  assert('docs view header opens TemplatesLibrary.openManager via module dispatch',
    /data-action="module"\s+data-target="TemplatesLibrary\.openManager"/.test(dashHtml),
    'expected a Message Templates button in tpl-view-docs using data-action="module"');
  assert('templates-library.js exports openManager on window.TemplatesLibrary',
    /window\.TemplatesLibrary\s*=\s*\{[\s\S]{0,600}openManager/.test(tl),
    'module dispatch target must exist or the button silently no-ops');
  assert('dashboard.html loads templates-library.js (manager must load on the page that dispatches it)',
    /src="js\/templates-library\.js/.test(dashHtml));
}

// ── QA sweep behavior guards (F2/F3/F6/F8: verified working-as-intended) ──
// These four were flagged during functional QA but proved to be NON-bugs on
// code review — headless/eval-timing artifacts (F2 screenshot-never-idles,
// F6 checked before the 1200ms redirect) and intentional design (F3 fail-open,
// F8 create-opener clears the edit-id). Guard the intended behavior so a
// future refactor can't silently regress it into the bug it merely resembled.
section('QA sweep behaviors (F2/F3/F6/F8)');
{
  const gx = read(path.join(PRO_JS, 'theme-gx.js'));
  assert('F2: theme-gx pauses the animated bg when the tab is hidden',
    /visibilitychange/.test(gx) && /document\.hidden/.test(gx) && /cancelAnimationFrame/.test(gx));

  // F3: softGate must NOT enforce limits before the plan loads — eager gating
  // would falsely nag paying users whose subscription doc hasn't synced yet.
  const bill = read(path.join(PRO_JS, 'billing-gate.js'));
  assert('F3: billing softGate fails open before the plan loads',
    /if\s*\(\s*!_loaded\s*\)\s*return true/.test(bill));

  const reg = read(path.join(PRO_JS, 'pages', 'register.js'));
  assert('F6: register signs in + redirects to the dashboard after account creation',
    /signInWithCustomToken/.test(reg) && /\/pro\/dashboard\.html/.test(reg));

  const leads = read(path.join(PRO_JS, 'crm-leads.js'));
  assert('F8: openLeadModal clears the lead edit-id on open (no create/edit state-bleed)',
    /function openLeadModal/.test(leads) && /lEditId/.test(leads) && /editId\.value\s*=\s*['"]{2}/.test(leads));
}

// ── Cmd+K ownership ──────────────────────────────────────────
// 2026-09-06: THREE files bound Cmd+K — command-palette.js (canonical,
// window.NBDCommand), global-search.js (already stood down) and ui.js (did
// not). dashboard.html loads all three, so one keypress opened two palettes
// stacked. This scans for any Cmd+K binding and requires every non-canonical
// one to defer, so a fourth palette can't quietly reintroduce the same bug.
section('Cmd+K: exactly one palette owns the shortcut');
{
  const CANONICAL = 'command-palette.js';
  const files = fs.readdirSync(PRO_JS).filter(f => f.endsWith('.js'));
  const binders = [];
  for (const f of files) {
    const src = read(path.join(PRO_JS, f));
    // a Cmd/Ctrl+K keydown branch: a metaKey/ctrlKey test near a 'k' compare
    if (/(metaKey|ctrlKey)[\s\S]{0,120}===\s*['"]k['"]|===\s*['"]k['"][\s\S]{0,120}(metaKey|ctrlKey)/.test(src)) {
      binders.push({ file: f, src });
    }
  }
  assert('found the Cmd+K binders (scanner still works)', binders.length >= 2);
  assert('command-palette.js is one of them (it is the canonical owner)',
    binders.some(b => b.file === CANONICAL));
  for (const b of binders) {
    if (b.file === CANONICAL) continue;
    assert(b.file + ' stands down for window.NBDCommand',
      /NBDCommand/.test(b.src));
  }
}

// ── ScriptLoader public API ──────────────────────────────────
section('ScriptLoader contract');
{
  const src = read(path.join(PRO_JS, 'script-loader.js'));
  assert('registers window.ScriptLoader', /window\.ScriptLoader\s*=/.test(src));
  assert('exposes load()',            /\bload\s*[,:]/.test(src));
  assert('exposes loadBundle()',      /\bloadBundle\s*[,:]/.test(src));
  assert('exposes preloadForView()',  /\bpreloadForView\s*[,:]/.test(src));
  // markLoaded() was removed 2026-09-06 — exported for four months, never
  // called. This asserts the replacement invariant instead of the dead name:
  // dedupe keys on the RESOLVED PATH, so '/pro/js/x.js?v=1' and 'js/x.js?v=9'
  // are one file. Regressing to a raw-src compare leaves a SECOND
  // supplement-ui.js tag in the DOM on the customer page and re-parses the
  // file. (Corrected 2026-09-07: this comment used to claim the re-execution
  // also duplicated its document.body MutationObserver. It does not —
  // supplement-ui.js returns on its own __NBD_LOADED sentinel first.)
  assert('dedupes on a resolved cacheKey, not the raw src',
    /function\s+cacheKey\s*\(/.test(src) && /new\s+URL\s*\(\s*src\s*,\s*document\.baseURI\s*\)/.test(src));
  assert('cacheKey drops the ?v= cache-buster', /u\.origin\s*\+\s*u\.pathname/.test(src));
  assert('the eager-tag scan compares cacheKeys',
    /querySelectorAll\(\s*'script\[src\]'\s*\)/.test(src) && !/querySelector\('script\[src="'\s*\+\s*src/.test(src));
  assert('markLoaded() is gone from the public API', !/^\s*markLoaded,\s*$/m.test(src));
  assert('defines BUNDLES table',     /const\s+BUNDLES\s*=/.test(src));
  assert('defines VIEW_BUNDLES map',  /const\s+VIEW_BUNDLES\s*=/.test(src));

  // Every view in VIEW_BUNDLES must reference a bundle that exists
  const bundleMatch  = src.match(/const BUNDLES\s*=\s*\{([\s\S]*?)\};/);
  const viewsMatch   = src.match(/const VIEW_BUNDLES\s*=\s*\{([\s\S]*?)\};/);
  const bundleNames  = bundleMatch ? [...bundleMatch[1].matchAll(/^\s*(\w+):\s*\[/gm)].map(m => m[1]) : [];
  const viewRefs     = viewsMatch  ? [...viewsMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(n => !/^[a-z]+_bundles$/.test(n)) : [];
  // Crude but effective: every bareword quoted string in VIEW_BUNDLES that
  // appears AFTER `[` should be a bundle name. Walk each line and compare.
  const orphans = [];
  for (const line of viewsMatch ? viewsMatch[1].split('\n') : []) {
    const inBrackets = line.match(/\[([^\]]*)\]/);
    if (!inBrackets) continue;
    const refs = [...inBrackets[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    for (const r of refs) if (!bundleNames.includes(r)) orphans.push(r);
  }
  assert('all view bundles reference real bundles', orphans.length === 0, orphans.join(', '));

  // PR 2a (perf): ApexCharts moved off the eager boot path into the lazy
  // `reports` bundle (~524 KB raw / ~137 KB gzipped saved per dashboard
  // load). Guard BOTH halves so a future merge can't silently re-add the
  // eager <script> tag or drop it from the bundle — the latter would break
  // the Rep Report view's charts. The CDN URL (not the word "ApexCharts",
  // which survives in a breadcrumb comment) is the precise signal here.
  const dashRaw = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('PR 2a: ApexCharts is NOT eager-loaded in dashboard.html',
    !/cdn\.jsdelivr\.net\/npm\/apexcharts/.test(dashRaw),
    'ApexCharts CDN must not be an eager <script src> in dashboard.html — it belongs in the ScriptLoader reports bundle');
  const reportsBundleSrc = (src.match(/reports:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  assert('PR 2a: ApexCharts IS lazy-loaded via the reports bundle',
    /apexcharts/i.test(reportsBundleSrc),
    'ApexCharts CDN URL must be in the reports bundle in script-loader.js so the Rep Report view still loads it');

  // PR 2b (perf): the doc-generation cluster (~419 KB) moved off the eager
  // boot path into the lazy `docgen` bundle, triggered load-then-run from the
  // lead-card doc chips (_generateDocWithPreflight) and the Docs view. Guard
  // that none of the four modules is eager in dashboard.html and that all
  // four are registered in the bundle.
  const DOCGEN = ['nbd-logo-asset.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js'];
  const docgenBundleSrc = (src.match(/docgen:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  for (const m of DOCGEN) {
    assert('PR 2b: ' + m + ' is NOT eager in dashboard.html',
      !new RegExp('<script[^>]+src="js/' + m.replace(/\./g, '\\.') + '\\?').test(dashRaw),
      m + ' must be lazy-loaded via the docgen bundle, not an eager <script> in dashboard.html');
    assert('PR 2b: ' + m + ' IS in the docgen bundle',
      docgenBundleSrc.includes(m),
      m + ' must be listed in the docgen bundle in script-loader.js');
  }
  // The Docs view must preload the docgen bundle (the click handlers also
  // load-then-run as a backstop, but preloading avoids the first-click wait).
  assert("PR 2b: docs view preloads the docgen bundle",
    /docs:\s*\[[^\]]*'docgen'/.test(src),
    "VIEW_BUNDLES['docs'] must include 'docgen' so opening the Docs view preloads it");

  // PR 2c (perf): the estimate engine (~530 KB, 12 modules) moved off the eager
  // boot path into the lazy `estimates` bundle, triggered load-then-run from the
  // startNewEstimate / openEstimateV2Builder stubs and preloaded on the est /
  // products views. estimate-config / review-engine / property-intel stay eager.
  // Verified end-to-end by tests/e2e/estimate-engine.spec.js (engine assembles
  // to 222 products / 298 merged catalog keys / 270 xactimate).
  const ESTMODS = ['estimates.js', 'estimate-entry.js', 'estimate-crm-ops.js',
    'product-data.js', 'product-library.js',
    'estimate-builder-v2.js', 'estimate-catalog-xactimate.js', 'estimate-v2-ui.js'];
  const estBundleSrc = (src.match(/estimates:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  for (const m of ESTMODS) {
    assert('PR 2c: ' + m + ' is NOT eager in dashboard.html',
      !new RegExp('<script[^>]+src="js/' + m.replace(/\./g, '\\.') + '\\?').test(dashRaw),
      m + ' must be lazy-loaded via the estimates bundle, not an eager <script> in dashboard.html');
    assert('PR 2c: ' + m + ' IS in the estimates bundle',
      estBundleSrc.includes(m),
      m + ' must be listed in the estimates bundle in script-loader.js');
  }
  // estimate-builder-v2 MUST precede estimate-catalog-xactimate (load-time
  // CATALOG merge); the xactimate merge produced the 298-key baseline.
  assert('PR 2c: builder-v2 loads before xactimate in the bundle (merge order)',
    estBundleSrc.indexOf('estimate-builder-v2.js') > -1 &&
    estBundleSrc.indexOf('estimate-builder-v2.js') < estBundleSrc.indexOf('estimate-catalog-xactimate.js'),
    'estimate-builder-v2.js must come before estimate-catalog-xactimate.js in the estimates bundle');
  // estimate-config stays eager (prerequisite read at load by the builder).
  assert('PR 2c: estimate-config stays eager',
    /<script[^>]+src="js\/estimate-config\.js\?/.test(dashRaw),
    'estimate-config.js must remain an eager <script> in dashboard.html');
  assert('PR 2c: est + products views preload the estimates bundle',
    /est:\s*\['estimates'\]/.test(src) && /products:\s*\['estimates'\]/.test(src),
    "VIEW_BUNDLES must map est + products to the estimates bundle");

  // Expense subsystem: the #/expenses view lazy-loads expense-config (the
  // category/money source of truth), profit-tracker (window.ProfitTracker —
  // NOT loaded anywhere else on dashboard.html; expenses.js's per-job margin
  // calls computeJobPLWithExpenses at render), then expenses.js. Order is
  // load-bearing: a missing/late profit-tracker silently degrades margin to
  // "set Job Value" (caught only by live browser verification, not unit tests).
  const EXPMODS = ['expense-config.js', 'profit-tracker.js', 'expenses.js'];
  const expBundleSrc = (src.match(/expenses:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  for (const m of EXPMODS) {
    assert('expenses bundle includes ' + m, expBundleSrc.includes(m),
      m + ' must be listed in the expenses bundle in script-loader.js');
  }
  assert('expenses bundle order: config + profit-tracker before expenses.js',
    expBundleSrc.indexOf('expense-config.js') < expBundleSrc.indexOf('expenses.js') &&
    expBundleSrc.indexOf('profit-tracker.js') < expBundleSrc.indexOf('expenses.js'),
    'expense-config.js and profit-tracker.js must load before expenses.js');
  assert('signs view preloads Leaflet then the yard-signs bundle (logic before UI)',
    /signs:\s*\['mapvendor',\s*'signs'\]/.test(src) &&
    ((src.match(/signs:\s*\[([\s\S]*?)\]/g) || []).join('').indexOf('yard-signs-logic.js') > -1),
    'VIEW_BUNDLES.signs must be [mapvendor, signs]; BUNDLES.signs must carry yard-signs-logic.js');
  assert('expenses view preloads the expenses bundle',
    /expenses:\s*\['expenses'\]/.test(src),
    "VIEW_BUNDLES must map expenses to the expenses bundle");

  // Money / P&L capstone view — lazy single-module bundle + preload mapping.
  const moneyBundleSrc = (src.match(/money:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  assert('money bundle includes money-dashboard.js', moneyBundleSrc.includes('money-dashboard.js'),
    'money-dashboard.js must be in the money bundle in script-loader.js');
  assert('money view preloads the money bundle',
    /money:\s*\['money'\]/.test(src),
    "VIEW_BUNDLES must map money to the money bundle");

  // PR 2d (perf): the photo + inspection engine (~200 KB) moved off the eager
  // boot path into the lazy `photos` bundle, with load-then-run stubs at the
  // entry points (camera / gallery / inspection builder / photo report).
  const PHOTOMODS = ['photo-engine.js', 'inspection-report-engine.js', 'photo-report.js'];
  const photosBundleSrc = (src.match(/photos:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  for (const m of PHOTOMODS) {
    assert('PR 2d: ' + m + ' is NOT eager in dashboard.html',
      !new RegExp('<script[^>]+src="js/' + m.replace(/\./g, '\\.') + '\\?').test(dashRaw),
      m + ' must be lazy-loaded via the photos bundle, not an eager <script> in dashboard.html');
    assert('PR 2d: ' + m + ' IS in the photos bundle',
      photosBundleSrc.includes(m),
      m + ' must be listed in the photos bundle in script-loader.js');
  }
  assert('PR 2d: photos view preloads the photos bundle',
    /photos:\s*\['photos'\]/.test(src),
    "VIEW_BUNDLES must map photos to the photos bundle");

  // PR 2e (perf): the D2D tracker (~180 KB) moved off the eager boot path into
  // the lazy `d2d` bundle, preloaded on the D2D view (goTo's waitForD2D poller
  // handles the late load). The maps engine intentionally stays eager because
  // maps.js doubles as the theme/font appearance engine (applies the theme at
  // boot + powers the Settings theme picker).
  const D2DMODS = ['d2d-tracker-core-2026b.js', 'd2d-tracker-ui-2026b.js', 'd2d-tracker-2026b.js'];
  const d2dBundleSrc = (src.match(/d2d:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  for (const m of D2DMODS) {
    assert('PR 2e: ' + m + ' is NOT eager in dashboard.html',
      !new RegExp('<script[^>]+src="js/' + m.replace(/\./g, '\\.') + '\\?').test(dashRaw),
      m + ' must be lazy-loaded via the d2d bundle, not an eager <script> in dashboard.html');
    assert('PR 2e: ' + m + ' IS in the d2d bundle',
      d2dBundleSrc.includes(m),
      m + ' must be listed in the d2d bundle in script-loader.js');
  }
  assert('PR 2e: d2d view preloads the d2d bundle (+ mapvendor since 2026-08-07)',
    /d2d:\s*\['mapvendor',\s*'d2d'\]/.test(src),
    "VIEW_BUNDLES must map d2d to the mapvendor + d2d bundles");
  // The maps engine MUST stay eager — maps.js applies the saved theme/font at
  // boot (nbdBoot) and powers the theme picker; deferring it would break theming.
  assert('PR 2e: maps.js stays eager (it is also the theme engine)',
    /<script[^>]+src="js\/maps\.js\?/.test(dashRaw),
    'maps.js must remain an eager <script> in dashboard.html (applies the theme at boot)');

  // PR 2b2 (perf): jsPDF + html2pdf (~1.1 MB) moved off the eager boot path into
  // the lazy `pdfexport` bundle, loaded on demand by the doc-viewer's PDF
  // download handler (nbd-doc-viewer.js handlePdf).
  assert('PR 2b2: html2pdf is NOT eager in dashboard.html',
    !/cdnjs\.cloudflare\.com\/ajax\/libs\/html2pdf/.test(dashRaw),
    'html2pdf must not be an eager <script> in dashboard.html — it belongs in the pdfexport bundle');
  assert('PR 2b2: jsPDF is NOT eager in dashboard.html',
    !/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf/.test(dashRaw),
    'standalone jsPDF must not be an eager <script> in dashboard.html — it belongs in the pdfexport bundle');
  const pdfBundleSrc = (src.match(/pdfexport:\s*\[([\s\S]*?)\]/) || [])[1] || '';
  assert('PR 2b2: pdfexport bundle contains jsPDF + html2pdf',
    /jspdf/i.test(pdfBundleSrc) && /html2pdf/i.test(pdfBundleSrc),
    'the pdfexport bundle must list jsPDF + html2pdf');
  assert('PR 2b2: doc-viewer handlePdf load-then-runs the pdfexport bundle',
    /loadBundle\(['"]pdfexport['"]\)/.test(read(path.join(PRO_JS, 'nbd-doc-viewer.js'))),
    'nbd-doc-viewer.js must ScriptLoader.loadBundle("pdfexport") before using html2pdf');

  // PR 2b3 (perf): same pdfexport deferral applied to customer.html. jsPDF +
  // html2pdf (~1.1 MB) no longer eager — the two inline export handlers
  // load-then-run the bundle, and NBDDocViewer.handlePdf (already lazy) covers
  // the html2pdf path.
  const custRaw = read(path.join(PRO_JS, '..', 'customer.html'));
  assert('PR 2b3: jsPDF is NOT eager in customer.html',
    !/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf/.test(custRaw),
    'jsPDF must not be an eager <script> in customer.html — load via the pdfexport bundle');
  assert('PR 2b3: html2pdf is NOT eager in customer.html',
    !/cdnjs\.cloudflare\.com\/ajax\/libs\/html2pdf/.test(custRaw),
    'html2pdf must not be an eager <script> in customer.html — load via the pdfexport bundle');
  assert('PR 2b3: customer.html loads ScriptLoader',
    /<script[^>]+src="js\/script-loader\.js/.test(custRaw),
    'customer.html must load script-loader.js to lazy-load the pdfexport bundle');
  // Was `>= 2` until 2026-09-06. The second of the "two jsPDF export handlers"
  // lived inside customer-photo-report-generator.js's window.generatePhotoReport,
  // which photo-report.js overwrote at load — i.e. it was DEAD CODE, and half
  // this assertion was guarding a handler that could never run. That block is
  // now deleted, leaving exactly one live jsPDF export handler on the customer
  // page (customer-bootstrap.module.js exportCustomerPDF).
  assert('PR 2b3: customer.html PDF handler load-then-runs pdfexport',
    (readCustomer().match(/loadBundle\(['"]pdfexport['"]\)/g) || []).length >= 1,
    'the jsPDF export handler must ScriptLoader.loadBundle("pdfexport") before window.jspdf — it lives in the extracted customer-*.js shards since the 2026-07-02 CSP extraction, hence readCustomer()');
}

// ── AdminManager public API ──────────────────────────────────
section('AdminManager contract');
{
  const src = read(path.join(PRO_JS, 'admin-manager.js'));
  assert('registers window.AdminManager', /window\.AdminManager\s*=/.test(src));
  for (const fn of ['init', 'refresh', 'openCreate', 'closeCreate', 'submitCreate',
                    'closeEdit', 'submitEdit', 'toggleDeactivate', 'applyGate']) {
    // Match shorthand property (`fn,` or `fn\n  }`) or longhand (`fn: ...`).
    assert('exposes ' + fn + '()', new RegExp('\\b' + fn + '\\s*[,:\\s]*\\}?').test(src));
  }
  assert('invokes listTeamMembers callable', /callable\(['"]listTeamMembers['"]\)/.test(src));
  assert('invokes createTeamMember callable', /callable\(['"]createTeamMember['"]\)/.test(src));
  assert('invokes updateUserRole callable',   /callable\(['"]updateUserRole['"]\)/.test(src));
  assert('invokes deactivateUser callable',   /callable\(['"]deactivateUser['"]\)/.test(src));
}

// ── H-2: iframe sandbox drops allow-same-origin ─────────────
section('H-2: iframe sandbox');
{
  const src = read(path.join(PRO_JS, 'nbd-doc-viewer.js'));
  assert("sandbox does not contain 'allow-same-origin'",
    !/allow-same-origin/.test(src.match(/sandbox[^'"]*['"][^'"]*['"]/)?.[0] || ''));
  assert('print listener injected via wrapWithPrintListener',
    /function wrapWithPrintListener/.test(src));
  assert('PDF path uses DOMParser (no contentDocument access)',
    /new DOMParser\(\)\.parseFromString/.test(src));
  assert('PDF path scrubs <script> and on* attrs',
    /querySelectorAll\('script, iframe, object, embed'\)[\s\S]{0,200}removeAttribute/.test(src));
}

section('UI-B: BoldSign send-for-signature + badges');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('Send-for-signature button present', /data-action="send-for-signature"/.test(src));
  assert('sendForSignature() wired', /async function sendForSignature\(/.test(src));
  assert('stores saved estimate id on window for signature flow',
    /window\._v2SavedEstimateId\s*=\s*savedId/.test(src));
  // Audit batch 10: search across dashboard.html + dashboard-main.js
  // since the inline handlers moved into the extracted file.
  const dash = readDashboard();
  assert('signature badge rendered on estimate cards',
    /signatureStatus === 'signed'/.test(dash) && /SIGNED/.test(dash));
  assert('sigTag injected into est-card-chips',
    /leadTag \+ builderTag \+ sigTag/.test(dash));
}

section('UI-C: Regrid wire-in to property-intel');
{
  const src = read(path.join(PRO_JS, 'property-intel.js'));
  assert('_regridToIntel mapper defined', /function _regridToIntel/.test(src));
  assert('fetchPropertyIntel tries NBDIntegrations.lookupParcel',
    /NBDIntegrations\.lookupParcel/.test(src));
  assert('Regrid path short-circuits on hit',
    /renderIntelCard\(targetElId, intel, countyClean, fullAddr\);\s*return;/.test(src));
}

section('UI-E: Cal.com in Settings');
{
  // CSP hotfix: _saveSettings lives in dashboard-bootstrap.module.js
  // after extraction, so use readDashboard() (HTML + all shards).
  const dash = readDashboard();
  assert('settingsCalcom input present', /id="settingsCalcom"/.test(dash));
  assert('settingsCalcomPreview anchor present',
    /id="settingsCalcomPreview"/.test(dash));
  assert('_saveSettings persists calcomUsername',
    /calcomUsername/.test(dash) && /setDoc[\s\S]{0,200}users[\s\S]{0,200}calcomUsername/.test(dash));
}

section('Wave A4: rotateAccessCodes button');
{
  const adm = read(path.join(PRO_JS, 'admin-manager.js'));
  assert('AdminManager.rotateAccessCodes defined',
    /async function rotateAccessCodes/.test(adm));
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('Team Manager header renders rotate button',
    /data-target="AdminManager\.rotateAccessCodes"/.test(dash));
}

// ── Null-guard smoke: hot-spot functions use guards ──────────
section('Null guards on hot paths');
{
  // Step 4b: crm.js was split into 4 modules + a shim — concat them
  // via readCrm() so these null-guard assertions find their patterns
  // regardless of which split file the code landed in.
  const crm = readCrm();
  assert('openLeadModal checks modal existence',
    /function openLeadModal[\s\S]{0,200}if \(!modal\) return/.test(crm));
  assert('saveLead guards modal elements',
    /saveLead[\s\S]{0,400}if\s*\(\s*!mErr\s*\|\|\s*!mOk/.test(crm));

  // Step 4d: openPinConfirm now lives in maps-overlays.js, recalcGutters
  // in maps-routing.js. readMaps() concats the split modules so the
  // existing regex assertions keep finding the functions.
  const maps = readMaps();
  assert('openPinConfirm guards dot/lbl/coord/notes',
    /function openPinConfirm[\s\S]{0,400}if\s*\(\s*dot\s*\)/.test(maps));
  assert('recalcGutters guards total+ds',
    /function recalcGutters[\s\S]{0,300}if\s*\(\s*totalEl\s*\)/.test(maps));

  const est = read(path.join(PRO_JS, 'estimates.js'));
  assert('startNewEstimateOriginal bails on missing builder',
    /startNewEstimateOriginal[\s\S]{0,400}if\s*\(!builder\)/.test(est));
  assert('buildReview guards reviewEl',
    /function buildReview[\s\S]{0,2000}if\s*\(\s*!reviewEl\s*\)/.test(est));
}

// ── Inline HTML <script> syntax ─────────────────────────────
// Guards against the class of bug where an inline <script> inside an
// HTML file has a syntax error (unclosed brace, etc.) — browsers
// silently log it to console and the page renders but every JS
// feature on the page is dead. Full fixture-based suite at
// tests/inline-html-scripts.test.js; we gate on it passing.
try {
  execSync('node ' + JSON.stringify(path.join(__dirname, '..', 'inline-html-scripts.test.js')), {
    stdio: 'inherit',
    cwd: ROOT,
  });
  bumpPassed();
} catch (e) {
  bumpFailed('inline-html-scripts.test.js — inline <script> in docs/ has syntax error (see output above)');
}

// ── CSP: strict pages stay free of inline event handlers ────
// firebase.json ships tight per-page CSPs (script-src-attr 'none')
// for the pages below. That header BLOCKS any onclick=/onsubmit=/
// onfocus= handler in the HTML — which is what we want, but the
// blocking is silent, so a stray inline handler just breaks the page
// without a visible error. This check refuses to let a new inline
// handler land on those files.
section('CSP: strict-CSP pages have zero inline event handlers');
{
  const STRICT_PAGES = [
    'docs/pro/login.html',
    'docs/pro/register.html',
    'docs/pro/stripe-success.html',
    'docs/pro/analytics.html',
    'docs/pro/leaderboard.html',
    'docs/pro/ask-joe.html',
    'docs/pro/diagnostic.html',
    'docs/pro/understand.html',
    'docs/pro/ai-tree.html',
    'docs/pro/roof-rep.html',
  ];
  const INLINE_HANDLER_RE = /\son(click|submit|change|input|load|focus|blur|keyup|keydown|mouseover|mouseout|mouseenter|mouseleave|drag|drop|touchstart|touchend)\s*=/;
  for (const p of STRICT_PAGES) {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) continue;
    const html = fs.readFileSync(full, 'utf8');
    const match = html.match(INLINE_HANDLER_RE);
    assert(p + ' has no inline event handlers (strict CSP)',
      !match,
      match ? 'found: ' + match[0] + ' at offset ' + match.index : '');
  }
}

// ── A11y: main landmark + skip-link on public pages ─────────
// These are the pages users touch before authentication. Screen-reader
// and keyboard users need a "skip to main content" target + a
// <main id="main"> landmark to jump to. The test is tight — we only
// gate the public auth-entry pages so adding landmarks to the rest of
// the app can happen incrementally without breaking CI.
section('A11y: main landmark + skip-link on public pages');
{
  const PAGES = ['docs/pro/login.html', 'docs/pro/register.html', 'docs/pro/pricing.html'];
  for (const p of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    assert(p + ' has <main id="main">',  /<main[^>]*id=["']main["']/.test(html));
    assert(p + ' has skip-to-main link',
      /href=["']#main["']/.test(html) && /Skip to main content/i.test(html));
  }
}

// ── Perf: no new oversized images ───────────────────────────
// Guard against someone dropping an uncompressed PNG/JPEG into the
// build. Anything > 1MB is almost always a mistake (should be a WebP
// under 200KB or a sized JPEG). The existing known offenders
// (roofivent product shots) are whitelisted — the guard is specifically
// for NEW regressions, not for retro-cleaning binaries we can't edit
// in this worktree.
section('Perf: oversized image regression guard');
{
  const MAX_IMAGE_BYTES = 1 * 1024 * 1024;  // 1 MB
  const WHITELIST = new Set([
    // Existing product imagery — documented large, lazy-loaded on
    // /services/roofivent/ below the fold, converted to WebP/AVIF
    // in a follow-up perf pass.
    'docs/assets/roofivent/ivent-roto.png',
    'docs/assets/roofivent/ivent-eco.png',
  ]);
  function walk(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(png|jpg|jpeg|gif|webp|avif)$/i.test(entry.name)) out.push(full);
    }
    return out;
  }
  const imgs = walk(path.join(ROOT, 'docs'), []);
  const offenders = [];
  for (const abs of imgs) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const size = fs.statSync(abs).size;
    if (size > MAX_IMAGE_BYTES && !WHITELIST.has(rel)) {
      offenders.push(rel + ' (' + (size / 1024 / 1024).toFixed(1) + ' MB)');
    }
  }
  assert('Perf: no new image > 1MB (' + imgs.length + ' scanned, ' + WHITELIST.size + ' whitelisted)',
    offenders.length === 0,
    offenders.length ? 'offenders: ' + offenders.join(', ') : '');
}

section('Visual regression baseline (Playwright pixel-diff)');
{
  const spec = read(path.join(ROOT, 'tests/e2e/visual-regression.spec.js'));
  const pkg  = JSON.parse(read(path.join(ROOT, 'tests/package.json')));
  // Suite covers public pages only — auth pages need a session.
  assert('visual-regression.spec.js covers login/register/pricing/landing',
    /\/pro\/login/.test(spec)
    && /\/pro\/register/.test(spec)
    && /\/pro\/pricing/.test(spec)
    && /name:\s*['"]landing['"]/.test(spec));
  // Three viewports — mobile/tablet/desktop. The mobile-375 snapshot
  // is the one Joe lives in (iPhone in the field).
  assert('three viewports configured (375 / 768 / 1280)',
    /width:\s*375/.test(spec)
    && /width:\s*768/.test(spec)
    && /width:\s*1280/.test(spec));
  // Animations must be neutralized before screenshot — fail-loud
  // if someone removes the disable-transitions style block, because
  // mid-animation pixels would flake the diff forever.
  assert('animations + transitions disabled before screenshot',
    /transition:\s*none\s*!important[\s\S]{0,80}animation:\s*none\s*!important/.test(spec));
  // Mask hooks for high-entropy regions — keeps live-counter pages
  // (pricing carousels, "as of" timestamps) from flaking.
  assert('mask hooks for live-timestamp + data-mask-visual',
    /mask:\s*\[[\s\S]{0,200}\.live-timestamp/.test(spec)
    && /\[data-mask-visual\]/.test(spec));
  // CI's hosting emulator forwards /api/* rewrites to PRODUCTION functions.
  // Live Google reviews turned every commit's landing diff red on 2026-09-13
  // (1337px taller at mobile-375). The spec pins those payloads and fails any
  // unpinned /api/* call by name. Matched on code with comments stripped: the
  // spec's WHY block names the same endpoint.
  {
    const code = spec.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    const routeAt = code.indexOf('pw.route(');
    assert('visual spec pins /api/google-reviews to the empty (fallback-card) payload',
      /'\/api\/google-reviews':\s*\{\s*reviews:\s*\[\],\s*total:\s*0\s*\}/.test(code));
    assert('visual spec routes /api/* BEFORE navigating, and fails on unpinned calls',
      routeAt > -1 && routeAt < code.indexOf('pw.goto(')
      && /route\.fulfill\(/.test(code) && /unpinned\.push\(/.test(code)
      && /expect\(unpinned[^)]*\)\.toEqual\(\[\]\)/.test(code));
  }
  // npm scripts wired so CI + local can run + update baselines.
  assert('test:e2e:visual + test:e2e:visual:update npm scripts',
    !!(pkg.scripts && pkg.scripts['test:e2e:visual'])
    && !!(pkg.scripts && pkg.scripts['test:e2e:visual:update']));
}

section('NBDStore — pub/sub state store + first-slice migration');
{
  const store    = read(path.join(ROOT, 'docs/pro/js/state-store.js'));
  const customer = readCustomer();
  const dash     = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const pkg      = JSON.parse(read(path.join(ROOT, 'tests/package.json')));

  // Public surface — these names are the migration contract; renaming
  // any of them silently breaks every call site that adopts the store.
  assert('state-store exports create + get + set + subscribe + bind on window.NBDStore',
    /window\.NBDStore\s*=\s*api/.test(store)
    && /create:\s*create/.test(store)
    && /get:\s*singleton\.get/.test(store)
    && /set:\s*singleton\.set/.test(store)
    && /subscribe:\s*singleton\.subscribe/.test(store)
    && /bind:\s*singleton\.bind/.test(store));

  // Identity-equality short-circuit — if this regresses, every legacy
  // call site that does `set.add(x); store.set('photos.selected', set)`
  // would silently fail to notify subscribers and the bulk-bar would
  // never re-render. Test directly in state-store.test.js; smoke just
  // pins the comparison line so a refactor can't drop it.
  assert('set short-circuits when prev === value',
    /if \(prev === value\) return false;/.test(store));

  // Subscriber-throw isolation — a single buggy listener must not
  // break every other listener for the same path.
  assert('notify catches subscriber throws and continues',
    /try \{[\s\S]{0,80}listeners\[i\]\(value, path\);[\s\S]{0,200}console\.error/.test(store));

  // bind() is one-way (store → window). Two-way would let legacy
  // direct writes to window._foo bypass subscribers entirely, so the
  // doc + the impl must both refuse it.
  assert('state-store documents one-way window mirror',
    /NOT a two-way sync/.test(store));

  // Both pages load the module BEFORE any feature script that might
  // want to subscribe (sentry-init seeds error reporting; everything
  // after that can read the store).
  assert('customer.html loads state-store.js after sentry-init',
    /sentry-init\.js[\s\S]{0,400}state-store\.js/.test(customer));
  assert('dashboard.html loads state-store.js after sentry-init',
    /sentry-init\.js[\s\S]{0,400}state-store\.js/.test(dash));

  // First slice migrated — photos.selected. The customer page wires
  // selection state into the store, binds it to the legacy global
  // for backward compat, and re-emits to updateBulkBarUI via a
  // subscriber so call sites don't need to know about the bar.
  assert('customer.html seeds photos.selected slice in NBDStore',
    /NBDStore\.set\(['"]photos\.selected['"], new Set\(\)\)/.test(customer));
  assert('customer.html binds _photoSelected → photos.selected (one-way)',
    /NBDStore\.bind\(['"]_photoSelected['"], ['"]photos\.selected['"]\)/.test(customer));
  assert('customer.html subscribes bulk-bar render to photos.selected',
    /NBDStore\.subscribe\(['"]photos\.selected['"][\s\S]{0,200}updateBulkBarUI/.test(customer));

  // Mutations now go through the helper that swaps the Set ref —
  // mutate-in-place would skip the identity check above and never
  // notify subscribers.
  assert('updatePhotoSelection swaps Set ref to trigger notify',
    /function updatePhotoSelection\(mutate\)[\s\S]{0,400}var next = new Set\(prev\);[\s\S]{0,200}NBDStore\.set\(['"]photos\.selected['"], next\)/.test(customer));

  // Test runner is wired so CI runs the unit suite. Since 2026-09-02 the
  // top-level `npm test` delegates to scripts/run-test-manifest.js (the
  // registry CI runs) after the smoke battery, instead of a hand-chained
  // aggregate that had silently dropped 22 suites — so the contract is
  // "state-store is in the node bucket", not "the chain names it".
  assert('test:state npm script runs state-store.test.js',
    !!(pkg.scripts && pkg.scripts['test:state'] === 'node ./state-store.test.js'));
  const topTest = (pkg.scripts && pkg.scripts.test) || '';
  assert('top-level test runs smoke.test.js first, then the manifest node + smoke buckets',
    /^node \.\/smoke\.test\.js && node \.\.\/scripts\/run-test-manifest\.js --bucket node && node \.\.\/scripts\/run-test-manifest\.js --bucket smoke$/.test(topTest),
    'got: ' + topTest);
  const manifest = JSON.parse(read(path.join(ROOT, 'tests/ci-manifest.json')));
  assert('state-store.test.js is classified in the manifest node bucket (so npm test runs it)',
    Array.isArray(manifest.node) && manifest.node.includes('state-store.test.js'));
}

section('Sentry — DSN config wired across high-value pages');
{
  const sentryConfig = read(path.join(ROOT, 'docs/pro/js/sentry-config.js'));
  // Config exposes the two globals sentry-init.js looks for.
  assert('sentry-config.js exposes window.__NBD_SENTRY_DSN',
    /window\.__NBD_SENTRY_DSN\s*=\s*NBD_SENTRY_DSN/.test(sentryConfig));
  assert('sentry-config.js exposes window.__NBD_RELEASE',
    /window\.__NBD_RELEASE\s*=\s*['"]web@/.test(sentryConfig));
  // Pages that need error reporting load BOTH the config and the SDK
  // shim, in that order. Config must come first so the DSN is on the
  // window before sentry-init reads it.
  ['dashboard.html', 'customer.html', 'login.html', 'register.html'].forEach(function (page) {
    var html = read(path.join(ROOT, 'docs/pro', page));
    assert(page + ' loads sentry-config.js before sentry-init.js',
      /sentry-config\.js[\s\S]{0,400}sentry-init\.js/.test(html),
      'sentry-config must come before sentry-init in ' + page);
  });
  // dashboard.html no longer hardcodes the DSN inline (it lives in
  // sentry-config.js now — single source of truth).
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('dashboard.html no longer inlines window.__NBD_SENTRY_DSN',
    !/window\.__NBD_SENTRY_DSN\s*=\s*"[^"]*";/.test(dash));
}

section('Hotkey scope fix — isHotkeyEnabled defined in the module');
{
  // Regression guard: isHotkeyEnabled is defined inside an IIFE in
  // dashboard-hotkey-toggles.js, invisible to this ES module. The keydown
  // handler must define its own (reading the same localStorage flag) or it
  // throws ReferenceError on every keypress and all shortcuts break.
  const boot = read(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'));
  assert('dashboard-bootstrap.module.js defines isHotkeyEnabled in module scope',
    /const isHotkeyEnabled\s*=\s*\(id\)\s*=>/.test(boot),
    'the keydown handler references isHotkeyEnabled; it must be defined in this module (the hotkey-toggles copy is IIFE-scoped and invisible)');
  assert('the keydown handler still gates the N shortcut on isHotkeyEnabled',
    /addEventListener\('keydown'[\s\S]*?isHotkeyEnabled\('hk_n'\)/.test(boot));
}

section('Audit batch 6 — repos.js wired into dashboard write path');
{
  // CSP hotfix: lead-create write path is in dashboard-bootstrap.module.js
  // now. We need raw HTML for the <script defer src="js/repos.js"> assertion
  // (that's about HTML structure, not JS content), so we keep both.
  const dashHtml = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const dash = readDashboard();
  const repos = read(path.join(ROOT, 'docs/pro/js/repos.js'));

  assert('dashboard.html loads repos.js in defer chain',
    /<script defer src="js\/repos\.js/.test(dashHtml),
    'expected <script defer src="js/repos.js" ...> in dashboard.html');

  assert('repos.js exposes window.NBDRepos.leads / photos / estimates',
    /window\.NBDRepos\s*=/.test(repos)
      && /leads:\s*leads/.test(repos)
      && /photos:\s*photos/.test(repos),
    'NBDRepos must export the lead + photo repositories');

  assert('repos.js falls back to uid when no companyId on claims (solo-operator support)',
    /\|\|\s*uid;/.test(repos) || /||\s*uid;/.test(repos),
    'companyId resolution must fall through to uid for solo operators');

  assert('dashboard.html lead-create migrated to NBDRepos.leads.create',
    /window\.NBDRepos\.leads\.create/.test(dash),
    'expected the lead-create write path to prefer NBDRepos.leads.create');
}

section('Audit batch 4 — admin function role-check drift guard');
{
  // Every Cloud Function the FUNCTIONS_INDEX.md classifies as ADMIN
  // must keep its role check. If someone refactors and drops the check
  // (no client caller would notice because admin functions have no
  // public client wrapper), the function silently becomes callable by
  // any authenticated user. CI catches that here.
  const indexPath = path.join(ROOT, 'functions/FUNCTIONS_INDEX.md');
  assert('functions/FUNCTIONS_INDEX.md exists',
    fs.existsSync(indexPath),
    'canonical functions taxonomy must exist');

  // Parse the ADMIN table out of the doc. Each row starts with
  // | `functionName` | ...
  const md = fs.existsSync(indexPath) ? read(indexPath) : '';
  const adminSection = md.match(/## ADMIN[\s\S]*?(?=\n## |$)/);
  const adminNames = adminSection
    ? Array.from(adminSection[0].matchAll(/\|\s*`(\w+)`\s*\|/g)).map(m => m[1])
    : [];
  assert('FUNCTIONS_INDEX lists at least 10 admin functions',
    adminNames.length >= 10,
    'expected the admin section to enumerate all admin exports');

  // The 5 known admin-gating patterns we accept anywhere in the file
  // that defines the function. Mostly we look at functions/index.js
  // because that's where the inline definitions live; for the few
  // admin functions exported from sub-modules we look at the source.
  const PATTERNS = [
    /role\s*===\s*['"]admin['"]/,
    /adminOnly:\s*true/,
    /requireTeamAdmin\s*\(/,
    /isAdmin\s*\(\)/,
    // integrationStatus uses an includes()-style allowlist —
    // `['admin', 'company_admin'].includes(callerRole)` — which the
    // original walker accidentally matched via the NEXT handler
    // (getAdminAnalytics) being within 8000 chars in the old monolithic
    // index.js. Step 4c split that out into its own handler file, so we
    // need an explicit pattern for the includes shape.
    /\[\s*['"]admin['"][^\]]*\]\.includes\(\s*[a-zA-Z_]+Role\s*\)/,
  ];

  // Scan every .js in functions/ (skip node_modules) for definitions
  // of each admin function. If we find one, assert at least one of the
  // patterns appears within 200 lines of the export.
  function adminGateOk(name) {
    const candidates = ['functions/index.js'];
    // Cheap: assume any sub-module that re-exports is the definition site
    const subFiles = fs.readdirSync(path.join(ROOT, 'functions'))
      .filter(f => f.endsWith('.js') && f !== 'index.js')
      .map(f => 'functions/' + f);
    candidates.push(...subFiles);
    // Step 4c: inline handlers moved to functions/handlers/<area>.js.
    // The definition site for setStorageCors, getAdminAnalytics,
    // integrationStatus, etc. is now inside that subdirectory.
    const handlersDir = path.join(ROOT, 'functions/handlers');
    if (fs.existsSync(handlersDir)) {
      const handlerFiles = fs.readdirSync(handlersDir)
        .filter(f => f.endsWith('.js'))
        .map(f => 'functions/handlers/' + f);
      candidates.push(...handlerFiles);
    }
    for (const c of candidates) {
      const full = path.join(ROOT, c);
      if (!fs.existsSync(full)) continue;
      const src = read(full);
      const declRe = new RegExp('(?:exports\\.' + name + '\\s*=|function\\s+' + name + '\\s*\\()', '');
      const m = src.match(declRe);
      if (!m) continue;
      // Look at the 200 lines after the declaration for an admin pattern.
      const idx = m.index;
      const window = src.slice(idx, idx + 8000);
      if (PATTERNS.some(p => p.test(window))) return true;
    }
    return false;
  }

  const skipped = new Set([
    // E2E test helpers — admin-gated but the pattern shows up in helper code
    // they're allowed.
  ]);
  const missing = [];
  for (const name of adminNames) {
    if (skipped.has(name)) continue;
    if (!adminGateOk(name)) missing.push(name);
  }
  assert('every admin function in FUNCTIONS_INDEX has a role/admin gate',
    missing.length === 0,
    missing.length ? 'admin gate missing from: ' + missing.join(', ') : '');

  // ── Coverage tripwire (audit 2026-08-05) ──────────────────────────
  // The doc went 2026-07-04 → 2026-08-05 with 21 undocumented exports —
  // including the whole Stripe Connect + seat-billing money path, which the
  // admin-gate check above therefore never scanned. Enforce the other
  // direction too: every export REACHABLE from functions/index.js must
  // appear somewhere in FUNCTIONS_INDEX.md. Static, dependency-free:
  //   1. direct `exports.name =` assignments in index.js
  //   2. one level of `Object.assign(exports, X)` where X was
  //      `const X = require('./mod')` — parse that module's own exports.
  {
    const idxSrc = read(path.join(ROOT, 'functions/index.js'));
    const names = new Set();
    for (const m of idxSrc.matchAll(/^exports\.(\w+)\s*=/gm)) names.add(m[1]);

    // Map require-variable → module path, then follow Object.assign mounts.
    const reqVars = {};
    for (const m of idxSrc.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(['"](\.[^'"]+)['"]\)/g)) {
      reqVars[m[1]] = m[2];
    }
    const mounted = [];
    for (const m of idxSrc.matchAll(/Object\.assign\(exports,\s*(\w+)\)/g)) {
      if (reqVars[m[1]]) mounted.push(reqVars[m[1]]);
    }
    for (const m of idxSrc.matchAll(/Object\.assign\(exports,\s*require\(['"](\.[^'"]+)['"]\)\)/g)) {
      mounted.push(m[1]);
    }
    for (const rel of mounted) {
      const p = path.join(ROOT, 'functions', rel.endsWith('.js') ? rel : rel + '.js');
      if (!fs.existsSync(p)) continue;
      const src = read(p);
      for (const m of src.matchAll(/^exports\.(\w+)\s*=/gm)) names.add(m[1]);
    }

    const md2 = read(path.join(ROOT, 'functions/FUNCTIONS_INDEX.md'));
    const undocumented = [...names].filter(n => !new RegExp('\\b' + n + '\\b').test(md2));
    assert('every index.js export appears in FUNCTIONS_INDEX (' + names.size + ' scanned)',
      undocumented.length === 0,
      undocumented.length ? 'undocumented exports: ' + undocumented.join(', ') : '');
  }
}

section('Rock 4 rollback twin retired (2026-09-02)');
{
  // The ?legacy=1 rollback (dashboard.legacy.html + dashboard-legacy-redirect.js,
  // Phase 3 prep, 2026-05) was byte-identical to dashboard.html by 2026-09-02
  // and was being refreshed by every dashboard commit — including all four
  // Globals Tranche 3 slices — so it offered no rollback, doubled the edit
  // surface, and lacked the no-store header its twin gets. Retired: both
  // files deleted, /pro/dashboard.legacy 301s to /pro/dashboard. These pins
  // keep it retired and keep the redirect honest.
  const dashHtml = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const fb = read(path.join(ROOT, 'firebase.json'));
  assert('dashboard.legacy.html stays deleted',
    !fs.existsSync(path.join(ROOT, 'docs/pro/dashboard.legacy.html')),
    'the twin came back — it was retired 2026-09-02 as a byte-identical duplicate');
  assert('dashboard-legacy-redirect.js stays deleted',
    !fs.existsSync(path.join(PRO_JS, 'dashboard-legacy-redirect.js')));
  // Script tags only — the retirement note in <head> names the deleted file.
  assert('dashboard.html no longer ships a ?legacy=1 redirect',
    !/<script[^>]*dashboard-legacy-redirect\.js/.test(dashHtml)
    && !/URLSearchParams\(location\.search\)\.has\(['"]legacy['"]\)/.test(dashHtml));
  assert('firebase.json 301s /pro/dashboard.legacy (and *) to /pro/dashboard',
    /"source":\s*"\/pro\/dashboard\.legacy",\s*"destination":\s*"\/pro\/dashboard",\s*"type":\s*301/.test(fb)
    && /"source":\s*"\/pro\/dashboard\.legacy\*",\s*"destination":\s*"\/pro\/dashboard",\s*"type":\s*301/.test(fb));
  assert('the noindex header glob no longer lists dashboard.legacy',
    !/@\([^)]*dashboard\.legacy[^)]*\)/.test(fb));
  // readDashboard() concatenates DASHBOARD_EXTRACTED_SHARDS; a stale entry for
  // the deleted redirect shard would throw inside every dashboard section.
  const shared = read(path.join(__dirname, '_shared.js'));
  assert('_shared.js no longer lists dashboard-legacy-redirect.js as a dashboard shard',
    !/dashboard-legacy-redirect\.js/.test(shared));
}

section('Visual-regression baselines are committed (the required CI job compares, not generates)');
{
  // ci.yml's visual-regression job self-selects: no snapshots dir →
  // --update-snapshots (always green, asserts nothing); dir present →
  // compare. It was promoted to REQUIRED on 2026-08-26 on a "10/10 green
  // streak" that was entirely the generate branch — the directory had never
  // been committed. Blessed 2026-09-02. This pin makes a missing or thinned
  // baseline set a red smoke run instead of a silently-green visual job.
  const snapDir = path.join(ROOT, 'tests/e2e/visual-regression.spec.js-snapshots');
  const spec = read(path.join(ROOT, 'tests/e2e/visual-regression.spec.js'));
  const pages = [...spec.matchAll(/name:\s*'([a-z-]+)'\s*\}/g)].map(m => m[1]);
  const viewports = [...spec.matchAll(/name:\s*'([a-z]+-\d+)'/g)].map(m => m[1]);
  assert('visual spec declares its page + viewport matrix', pages.length >= 4 && viewports.length >= 3,
    'pages=' + pages.join(',') + ' viewports=' + viewports.join(','));
  assert('baseline directory exists', fs.existsSync(snapDir));
  const pngs = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter(f => f.endsWith('.png')) : [];
  for (const p of pages) for (const v of viewports) {
    const want = `${p}--${v}-chromium-linux.png`;
    assert('baseline present: ' + want, pngs.includes(want), 'missing — the CI job would silently regenerate');
  }
  for (const f of pngs) {
    const sz = fs.statSync(path.join(snapDir, f)).size;
    assert('baseline is a real render (>50KB): ' + f, sz > 50 * 1024, sz + ' bytes');
  }
}

section('Wave 6b (A.2) — Pro Chrome on login.html + vault.html');
{
  const login = read(path.join(ROOT, 'docs/pro/login.html'));
  const vault = read(path.join(ROOT, 'docs/pro/vault.html'));
  // 1. login.html supplies its own --accent-fg + --accent-ring (it keeps
  //    --orange fixed for brand consistency, so it can't inherit per-theme
  //    overrides; the contract lives locally).
  assert('login.html defines --accent-fg + --accent-ring',
    /:root\{[\s\S]{0,800}--accent-fg:#fff[\s\S]{0,200}--accent-ring/.test(login),
    'expected login.html :root to declare --accent-fg + --accent-ring');
  // 2. login.html primary action surfaces consume the contract.
  assert('login.html .tab-btn.active uses var(--accent-fg)',
    /\.tab-btn\.active\{[^}]*background:var\(--orange\)[^}]*color:var\(--accent-fg\)/.test(login),
    'expected .tab-btn.active to color: var(--accent-fg)');
  assert('login.html .btn-main uses var(--accent-fg) + inset --accent-ring',
    /\.btn-main\{[^}]*color:var\(--accent-fg\)[\s\S]{0,500}box-shadow:inset 0 0 0 1px var\(--accent-ring\)/.test(login),
    'expected .btn-main to use --accent-fg + inset --accent-ring boundary');
  // 3. vault.html does the same.
  assert('vault.html declares --accent-fg + --accent-ring',
    /--accent-fg:#fff[\s\S]{0,200}--accent-ring:rgba/.test(vault),
    'expected vault.html to declare the accent tokens locally');
  assert('vault.html .btn-save / .btn-gold use var(--accent-fg)',
    /\.btn-save \{[\s\S]{0,400}color:\s*var\(--accent-fg\)/.test(vault)
    && /\.btn-gold \{[\s\S]{0,400}color:\s*var\(--accent-fg\)/.test(vault),
    'expected vault.html primary-action buttons to consume --accent-fg');
  // 4. Both files retired hardcoded NBD-orange rgba literals.
  for (const [name, body] of [['login.html', login], ['vault.html', vault]]) {
    assert(name + ': no hardcoded rgba(189,87,40,...) left',
      !/rgba\(189,\s*87,\s*40/.test(body),
      name + ' should use color-mix(in srgb, var(--orange) ...) instead of literal NBD-orange rgba');
  }
}

section('Wave 6 (A.1) — Pro Chrome on customer.html via shared theme-system.css');
{
  const themeCSS = read(path.join(ROOT, 'docs/pro/css/theme-system.css'));
  const customer = readCustomer();
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  // 1. Shared contract lives in theme-system.css now.
  assert('theme-system.css defines :root --accent-fg default #fff',
    /:root\s*\{[\s\S]{0,200}--accent-fg\s*:\s*#fff/.test(themeCSS),
    'expected --accent-fg default in shared theme-system.css');
  assert('theme-system.css defines :root --accent-ring default',
    /:root\s*\{[\s\S]{0,200}--accent-ring\s*:\s*rgba/.test(themeCSS),
    'expected --accent-ring default in shared theme-system.css');
  // 2. Per-theme overrides moved into the shared file. Some themes
  //    share a group selector (paper + ghost + easter etc. → one
  //    --accent-fg block), so we just check the theme name appears in
  //    a selector that sits above an --accent-fg declaration.
  for (const theme of ['paper','obsidian','steel','slate','neon','gold','batman','pokemon','zelda','blueprint-art']) {
    assert('theme-system.css overrides --accent-fg for ' + theme,
      new RegExp(':root\\[data-theme="' + theme + '"\\][^{]{0,800}\\{[\\s\\S]{0,400}--accent-fg').test(themeCSS),
      'expected theme-system.css to override --accent-fg for ' + theme);
  }
  // 3. dashboard.html no longer duplicates the contract.
  assert('dashboard.html no longer duplicates --accent-fg/--accent-ring defaults',
    !/  --accent-fg:#fff;\s*\n\s*--accent-ring:rgba\(0,0,0,\.35\)/.test(dash),
    'dashboard.html should inherit accent tokens from theme-system.css');
  // 4. customer.html .btn-orange consumes the contract.
  assert('customer.html .btn-orange uses var(--accent-fg)',
    /\.btn-orange\s*\{[\s\S]{0,400}color:\s*var\(--accent-fg\)/.test(customer),
    'expected customer.html .btn-orange to color: var(--accent-fg)');
  assert('customer.html .btn-orange has var(--accent-ring) inset boundary',
    /\.btn-orange\s*\{[\s\S]{0,400}inset 0 0 0 1px var\(--accent-ring\)/.test(customer),
    'expected customer.html .btn-orange to include inset boundary using --accent-ring');
  // 5. customer.html hardcoded NBD-orange rgba retired.
  assert('customer.html: no hardcoded rgba(189,87,40,...) left',
    !/rgba\(189,\s*87,\s*40/.test(customer),
    'customer.html should use color-mix(in srgb, var(--orange) ...) instead of literal rgba');
}

section('Pipeline header row is not a scroll box (2026-09-25 phone audit)');
{
  // Wave 5c (2026-05-14) made .crm-hdr-actions an overflow-x:auto side
  // scroller (mask fade, snap, 6px scrollbar) for a 12-15 button row, and
  // this section used to pin that treatment. The one-row toolbar
  // (2026-07-06) then moved those buttons INTO the Filters/Tools dropdowns,
  // which are absolutely positioned inside the row — so the scroll box
  // clipped both menus to nothing, at every width, for months. The row now
  // lays out (three controls) and each menu places itself on open. The
  // behaviour is pinned by tests/e2e/phone-pipeline.spec.js (hit-testing +
  // real taps); this keeps a scroller from quietly coming back. Comments
  // are stripped first: the fix's own comment names the old declarations.
  const css = readDashboardStyles().replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...css.matchAll(/\.crm-hdr-actions\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert('.crm-hdr-actions rule blocks found', blocks.length >= 2);
  assert('no .crm-hdr-actions block makes the row a scroll/clip box',
    blocks.every((b) => !/overflow(-x|-y)?\s*:\s*(auto|scroll|hidden|clip)/.test(b)),
    'a scrolling/clipping .crm-hdr-actions clips its own absolutely-positioned dropdown menus');
  assert('the base .crm-hdr-actions block says overflow:visible',
    blocks.some((b) => /(^|;|\s)overflow\s*:\s*visible/.test(b)));
  assert('the old side-scroller scrollbar/snap rules are gone',
    !/\.crm-hdr-actions::-webkit-scrollbar/.test(css) && !/\.crm-hdr-actions > \.crm-tools-wrap\s*\{\s*scroll-snap-align/.test(css));
  assert('dropdown menus scroll themselves when a screen is short',
    /\.crm-tools-menu\s*\{[^}]*overflow-y:\s*auto/.test(css));
  const ui = read(path.join(PRO_JS, 'dashboard-ui.js'));
  // 2026-09-25 follow-ups: both menus route through one _toggleCrmMenu (their
  // near-copies had drifted), which places the menu and arms the closer that
  // also re-places it on resize. phone-pipeline.spec.js carries the behaviour.
  assert('both header menus are placed on screen when they open',
    /function _placeCrmMenu\(menu\)/.test(ui)
    && /function _toggleCrmMenu\(id, ev\)[\s\S]{0,700}_placeCrmMenu\(menu\)/.test(ui)
    && /function toggleCrmToolsMenu\(ev\) \{ _toggleCrmMenu\('crmToolsMenu', ev\); \}/.test(ui)
    && /function toggleCrmFiltersMenu\(ev\) \{ _toggleCrmMenu\('crmFiltersMenu', ev\); \}/.test(ui));
}

section('Wave 5b — Gradient flatten + bulk accent-fg migration');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  // 1. .btn-orange no longer uses a linear-gradient for its base fill.
  // The BASE rule starts its own line; theme-scoped overrides (":root[data-theme=…] .btn-orange {") don't.
  const btnStart = dash.search(/(^|\n)\.btn-orange \{/);
  const btnBlock = dash.slice(btnStart, btnStart + 600);
  assert('.btn-orange base background is solid (no linear-gradient)',
    /\.btn-orange\s*\{\s*background:\s*var\(--orange\)/.test(btnBlock),
    'expected solid background:var(--orange) on .btn-orange — gradient was muddy on forest/neon themes');
  // 2. .kview-btn.active uses --accent-fg.
  assert('.kview-btn.active uses var(--accent-fg)',
    /\.kview-btn\.active\{background:var\(--orange\);color:var\(--accent-fg\)/.test(dash),
    'expected .kview-btn.active color: var(--accent-fg)');
  // 3. No remaining text-on-accent pairings using var(--t). Regex
  //    bounded by `"{};` so it stays within a single CSS rule or
  //    inline style attribute (the earlier unbounded version greedy-
  //    matched 10K chars across unrelated elements).
  assert('no remaining text-on-accent surfaces using var(--t)',
    !/background:\s*var\(--orange\)[^"{};]{0,200};\s*[^"{}]{0,80}color:\s*var\(--t\)/.test(dash),
    'found a text-on-orange surface still using var(--t) — should be var(--accent-fg) for theme contrast');
}

section('Wave 5 — Theme-aware accent + contrast tokens');
{
  // Wave 6 (A.1) moved the tokens themselves into the shared
  // theme-system.css — the Wave 6 section above asserts that. Here we
  // only check that dashboard.html still CONSUMES the contract.
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  // 3. .btn-orange consumes the tokens.
  assert('.btn-orange uses var(--accent-fg) for color',
    /\.btn-orange\s*\{[\s\S]{0,400}color:\s*var\(--accent-fg\)/.test(dash),
    'expected .btn-orange to color: var(--accent-fg)');
  assert('.btn-orange paints an inset 1px ring via --accent-ring',
    /\.btn-orange\s*\{[\s\S]{0,400}inset 0 0 0 1px var\(--accent-ring\)/.test(dash),
    'expected .btn-orange inset boundary using --accent-ring');
  // 4. Other static-accent surfaces upgraded.
  assert('#addLeadFab uses var(--accent-fg) + var(--accent-ring)',
    /#addLeadFab\{[\s\S]{0,400}color:\s*var\(--accent-fg\)[\s\S]{0,200}border:[^;]*var\(--accent-ring\)/.test(dash),
    'expected #addLeadFab to consume the new tokens');
  assert('.mn-item.mn-fab uses var(--accent-ring) border',
    /\.mn-item\.mn-fab\s*\{[\s\S]{0,400}border:[^;]*var\(--accent-ring\)/.test(dash),
    'expected .mn-item.mn-fab to use --accent-ring');
  {
    const shutter = dash.indexOf('.m-shutter-fab{');
    const shutterBlock = dash.slice(shutter, shutter + 800);
    assert('.m-shutter-fab uses var(--accent-fg)',
      /color:\s*var\(--accent-fg\)/.test(shutterBlock),
      'expected .m-shutter-fab to color: var(--accent-fg)');
    assert('.m-shutter-fab uses var(--accent-ring) border',
      /border:[^;]*var\(--accent-ring\)/.test(shutterBlock),
      'expected .m-shutter-fab to border via --accent-ring');
  }
  // 5. Hardcoded brand-orange glow strings retired in favor of --og (the
  //    per-theme tinted glow). Spot-check on #addLeadFab. Pinned to the
  //    CURRENT accent rgba(189,87,40,…): left on the retired rgba(232,114,12)
  //    this passes vacuously and stops catching new literals.
  const fab = dash.indexOf('#addLeadFab{');
  const fabBlock = dash.slice(fab, fab + 500);
  assert('#addLeadFab no longer uses rgba(189,87,40) glow',
    !/rgba\(189,87,40/.test(fabBlock),
    '#addLeadFab still has a hardcoded NBD-orange glow — should use var(--og)');
}

section('Add Lead revival (2026-07-06) — pipeline affordances cannot silently die again');
{
  // History this section exists to prevent repeating: the 2026-05-14
  // header cleanup removed the inline ＋ Add button because "the FAB is
  // the primary add action" — but the FAB was ALREADY dead: dashboard-ui
  // executes before dashboard-actions (which defines goTo), and
  // setupAddLeadFab's old `typeof goTo !== 'function' → return` guard
  // silently disabled it. Result: a pipeline with zero add-lead entry
  // points and no error anywhere.
  const ui = read(path.join(PRO_JS, 'dashboard-ui.js'));
  assert('setupAddLeadFab survives boot order (install() + retry, no bare bail)',
    /setupAddLeadFab[\s\S]{0,2500}if \(!install\(\)\)/.test(ui)
    && !/setupAddLeadFab[\s\S]{0,600}if \(typeof _origGoTo !== 'function'\) return;/.test(ui));

  const dashHtml = readDashboard();
  assert('pipeline header carries the restored ＋ Add Lead button (wired to openLeadModal)',
    /id="crmAddLeadBtn"[^>]*data-fn="openLeadModal"/.test(dashHtml));
  assert('#addLeadFab still present and wired to openLeadModal',
    /id="addLeadFab"[^>]*data-fn="openLeadModal"/.test(dashHtml));

  const styles = readDashboardStyles();
  assert('FAB is restacked ABOVE the capture-inbox FAB (196px slot, stack z-index)',
    /#addLeadFab\{[\s\S]{0,300}bottom:calc\(196px[\s\S]{0,200}z-index:9999/.test(styles));
  assert('FAB has no mobile bottom:80px override (collided with the capture FAB at 84px)',
    !/#addLeadFab\{\s*bottom:80px/.test(styles));

  const coord = read(path.join(PRO_JS, 'fab-stack-coordinator.js'));
  assert('fab-stack-coordinator hides addLeadFab with the rest of the stack',
    /FAB_IDS = \[[\s\S]{0,300}'addLeadFab'/.test(coord));
  assert('coordinator treats leadModal + quickAddModal as class-toggled blockers',
    /_CLASS_TOGGLED = new Set\(\[[^\]]*'leadModal'[^\]]*'quickAddModal'/.test(coord)
    && /BLOCKING_MODAL_IDS = \[[\s\S]{0,1800}'leadModal'/.test(coord));
  // nbd-picker-modal is STATIC in dashboard.html and class-toggled:
  // classifying it as display-toggled made "presence = open" hide the
  // whole FAB stack (mic/capture/inbox) on EVERY dashboard load (Wave
  // 149 regression, found 2026-07-06 by the add-lead revival E2E whose
  // restore assertion could never pass).
  assert('coordinator classifies the static appearance picker as class-toggled',
    /_CLASS_TOGGLED = new Set\(\[[^\]]*'nbd-picker-modal'/.test(coord));
  assert('coordinator observes class flips on the persistent class-toggled modals',
    /_CLASS_TOGGLED\.forEach[\s\S]{0,200}attributeFilter: \['class'\]/.test(coord));
}

section('Mobile FAB speed-dial (2026-07-06, Jo\'s pick) — one launcher, tools fan out');
{
  // Supersedes the same-day interim that display:none'd the field
  // tools on phones. Contract: phones show ⋯ (#nbd-fab-dial) + ＋ Add
  // Lead above it; the mic/capture/inbox FABs park faded at their fan
  // slots and appear only while body.nbd-dial-open. Desktop never
  // shows the launcher and keeps the classic vertical stack.
  const dial = read(path.join(PRO_JS, 'fab-speed-dial.js'));
  const styles = readDashboardStyles();
  const dashHtml = readDashboard();
  const coord = read(path.join(PRO_JS, 'fab-stack-coordinator.js'));

  assert('dashboard loads fab-speed-dial.js',
    /<script defer src="js\/fab-speed-dial\.js\?v=\d+"><\/script>/.test(dashHtml));
  assert('launcher toggles body.nbd-dial-open',
    /OPEN_CLASS = 'nbd-dial-open'/.test(dial)
    && /classList\.toggle\(OPEN_CLASS, open\)/.test(dial));
  assert('coordinator hides the launcher with the rest of the stack',
    /FAB_IDS = \[[\s\S]{0,400}'nbd-fab-dial'/.test(coord));

  // The mic swaps its glyph to ⏹ while recording; folding the dial
  // then would leave an unstoppable recording. Both dismiss paths and
  // the tool-tap fallthrough must respect it.
  assert('dismiss paths are recording-safe (⏹ guard + tool taps excluded)',
    /_micIsRecording[\s\S]{0,200}'⏹'/.test(dial)
    && /_onDocClick[\s\S]{0,400}_micIsRecording\(\)/.test(dial)
    && /_onDocClick[\s\S]{0,600}#nbd-whisper-fab, #nbd-qc-fab, #nbd-qci-fab/.test(dial));

  // CSS contract — parked tools: opacity WITHOUT !important (the
  // fab-stack-coordinator's inline hide must still win during modals),
  // positions WITH !important (must outrank the modules' inline
  // cssText). Launcher hidden on desktop, shown ≤768px.
  assert('mobile parks the field tools faded at fan slots (no !important on opacity)',
    /#nbd-whisper-fab\{\s*opacity:0; pointer-events:none;\s*bottom:calc\(75px[^}]*!important/.test(styles)
    && /#nbd-qc-fab\{\s*opacity:0; pointer-events:none;\s*bottom:calc\(78px[^}]*!important/.test(styles)
    && /#nbd-qci-fab\{\s*opacity:0; pointer-events:none;\s*bottom:calc\(80px[^}]*!important/.test(styles));
  assert('body.nbd-dial-open fans the tools out',
    /body\.nbd-dial-open #nbd-whisper-fab,\s*body\.nbd-dial-open #nbd-qc-fab,\s*body\.nbd-dial-open #nbd-qci-fab\{\s*opacity:1; pointer-events:auto;/.test(styles));
  assert('＋ Add Lead floats ABOVE the launcher on mobile (138px slot)',
    /#addLeadFab\{\s*bottom:calc\(138px \+ env\(safe-area-inset-bottom, 0px\)\) !important;/.test(styles));
  assert('launcher styled at the bottom slot, desktop-hidden, shown on mobile gated views',
    /#nbd-fab-dial\{\s*display:none;\s*position:fixed;\s*bottom:calc\(78px/.test(styles)
    && /@media \(max-width:768px\)\{[\s\S]{0,400}body\.show-field-tools #nbd-fab-dial\{ display:flex; \}\s*\}/.test(styles));
  // Field-tools cluster is gated to CRM + D2D via body.show-field-tools
  // (dashboard-ui.js sets it next to show-add-lead-fab). On every OTHER view
  // the mic / quick-capture / inbox FABs are display:none so the fixed
  // bottom-right stack can't float over the Photos card VIEW/ADD buttons —
  // the overlap Jo flagged from his phone.
  assert('field tools hidden on non-gated views (body:not(.show-field-tools))',
    /body:not\(\.show-field-tools\) #nbd-whisper-fab,\s*body:not\(\.show-field-tools\) #nbd-qc-fab,\s*body:not\(\.show-field-tools\) #nbd-qci-fab\{\s*display:none !important;/.test(styles));
  // CRM *and* D2D (view-map): a rep dictates the note right after a knock,
  // so the tools must be reachable on the door-knocking view too.
  const uiSrc = read(path.join(PRO_JS, 'dashboard-ui.js'));
  assert('dashboard-ui gates show-field-tools to the CRM + D2D views',
    /view-map['"]\)\?\.classList\.contains\(['"]active['"]\)/.test(uiSrc)
    && /show-field-tools['"],\s*!!\(onCrm \|\| onMap\)/.test(uiSrc));
  assert('Add Lead FAB stays CRM-only (not widened to D2D)',
    /show-add-lead-fab['"],\s*!!onCrm/.test(uiSrc));
  // A .view-scroll view with no FAB over it (Photos, …) only needs the 62px
  // #mobile-nav clearance — not the launcher's ~126px reach.
  assert('mobile .view-scroll clears the mobile nav (~80px, no FAB to clear)',
    /\.view-scroll \{ min-height:auto!important; padding-bottom:calc\(80px \+ env\(safe-area-inset-bottom, 0px\)\)!important; \}/.test(styles));
  // …but D2D DOES host the launcher, so its scroll region must reserve the
  // launcher's full reach (≥126px) or the value/streak cards sit trapped
  // under it again. Regression guard for the exact bug in the screenshots.
  // The map's spyglass row goes full-width static on mobile, putting its
  // 📍 / Go buttons in the launcher's right-hand column — tap-blocked until
  // the row reserves that column. Horizontal (not vertical) clearance,
  // because the row is in normal flow and scrolls.
  assert('map spyglass row clears the launcher column when field tools are shown (≥64px)',
    /body\.show-field-tools \.map-spyglass-panel\{\s*padding-right:calc\((6[4-9]|[7-9]\d|\d{3,})px \+ env\(safe-area-inset-right, 0px\)\)!important;/.test(styles));
  assert('D2D scroll region clears the launcher when field tools are shown (≥126px)',
    /body\.show-field-tools #d2dContent \{ padding-bottom:calc\((1[3-9]\d|[2-9]\d\d)px \+ env\(safe-area-inset-bottom, 0px\)\)!important; \}/.test(styles));

  // ── Collision guard: REVERTED (see below) ────────────────────────
  // fab-collision-guard.js shipped in #1061 and was reverted the same
  // night — it measured by writing dodge:0 and re-applying, so the browser
  // painted the intermediate state ~11x/sec (visible flicker), and its
  // MutationObserver watched `style` on the whole body subtree while the
  // dodge itself WRITES style on a body descendant — re-triggering itself
  // in a rAF busy-loop that dropped taps. Both are fixable (measure
  // arithmetically from the applied offset instead of resetting; scope the
  // observer and ignore self-writes) but it must not ship again without a
  // real-device soak. This guard fails the build if it comes back without
  // that fix, so the same regression can't return by copy-paste.
  assert('collision guard stays out until the flicker + self-trigger loop are fixed',
    !/fab-collision-guard\.js/.test(dashHtml));
}

section('Pipeline one-row toolbar (2026-07-06) — three controls, ids intact');
{
  // Jo's call after the header grew button-by-button until it overflowed
  // the viewport: the action row is exactly Filters ▾ / Tools ⋯ /
  // ＋ Add Lead. The filter/sort/bulk/csv buttons MOVED into the
  // dropdowns keeping their ids — every filter module and the toggle
  // delegate bind by id, so these contracts pin id + new container.
  const dashHtml = readDashboard();
  const actionsStart = dashHtml.indexOf('<div class="crm-hdr-actions">');
  const filtersMenu = dashHtml.slice(dashHtml.indexOf('id="crmFiltersMenu"'),
                                     dashHtml.indexOf('id="crmToolsBtn"'));
  const toolsMenu   = dashHtml.slice(dashHtml.indexOf('id="crmToolsMenu"'),
                                     dashHtml.indexOf('id="crmAddLeadBtn"'));
  assert('actions row exists with the Filters trigger + badge',
    actionsStart > -1
    && /id="crmFiltersBtn"[^>]*data-action="crmFiltersMenu"/.test(dashHtml)
    && /id="crmFiltersActiveBadge"/.test(dashHtml));
  for (const id of ['needsAttentionBtn', 'staleSharesBtn', 'snoozedToggleBtn',
                    'engagementSortBtn', 'prospectsToggleBtn']) {
    assert('filter control #' + id + ' lives inside #crmFiltersMenu',
      new RegExp('id="' + id + '"').test(filtersMenu));
  }
  for (const frag of ['id="bulkModeBtn"', 'id="csvExportBtn"',
                      'data-fn="openDeletedDrawer"', 'id="loadSampleDataBtn"',
                      'id="sidebarToggleBtn"', 'id="kanbanFullscreenBtn"',
                      'id="kanbanDensityToggleBtn"']) {
    assert('tools control ' + frag + ' lives inside #crmToolsMenu',
      toolsMenu.includes(frag));
  }
  assert('the duplicate .crm-tools-menu-mobile cluster is gone',
    !dashHtml.includes('class="crm-tools-menu-mobile"'));
  assert('view switcher sits in its own .crm-hdr-viewrow row',
    /class="crm-hdr-viewrow"[\s\S]{0,600}id="kanbanViewSwitcher"/.test(dashHtml));

  const ui = read(path.join(PRO_JS, 'dashboard-ui.js'));
  assert('delegate handles the crmFiltersMenu action',
    /if \(action === 'crmFiltersMenu'\)/.test(ui));
  assert('filter toggles inside ANY dropdown close both menus after acting',
    /closest\('\.crm-tools-menu'\)/.test(ui)
    && /closeCrmFiltersMenu/.test(ui));
  // Every filter module stamps .active on its button synchronously
  // (added 2026-07-06 — none did before; the old mobile menu's active
  // mirrors were silently dead because of it), and the sync fn counts
  // those classes into the Filters badge.
  assert('sync function counts stamped .active classes into the badge',
    /crmFiltersActiveBadge/.test(ui)
    && /\['needsAttentionBtn', 'noNextStepBtn', 'staleSharesBtn', 'snoozedToggleBtn', 'engagementSortBtn'\]/.test(ui));
  // The two kanban filters read their state from NBDLeadFilters now
  // (lead-filter-registry.js, 2026-09-03) instead of a private `active`
  // boolean, so their stamp reads `isActive()`. The assertion's intent is
  // unchanged — the module must still stamp .active on its own button — only
  // the expression it stamps FROM moved.
  for (const [f, flag] of [['needs-attention-filter.js', 'isActive\\(\\)'],
                           ['stale-shares-filter.js', 'isActive\\(\\)'],
                           ['lead-snooze.js', 'showing'], ['crm.js', 'on']]) {
    assert(f + " stamps .active on its filter button",
      new RegExp("classList\\.toggle\\('active', " + flag + "\\)").test(read(path.join(PRO_JS, f))));
  }

  const styles = readDashboardStyles();
  assert('menu-item normalization for moved .crm-hdr-btn/.crm-icon-btn',
    /\.crm-tools-menu \.crm-hdr-btn,\s*\.crm-tools-menu \.crm-icon-btn\{/.test(styles));
  assert('labels forced visible inside menus',
    /\.crm-tools-menu \.crm-hdr-btn-label\{ display:inline !important;/.test(styles));
  assert('mobile no longer id-hides the relocated filter buttons',
    !/#needsAttentionBtn,\s*#staleSharesBtn/.test(styles));
}

section('Pipeline lean triage list (2026-07-06) — Board/List toggle');
{
  // Jo's scope call: the list is a LEAN sortable table sharing the
  // kanban's fully-narrowed lead set — no bulk/thumbnails/drag (those
  // stay kanban-only), stage changes ride the same moveCard path.
  const lv = read(path.join(PRO_JS, 'crm-list-view.js'));
  assert('crm-list-view module exposes CrmListView + call-delegate entry points',
    /window\.CrmListView = \{ isActive, render, clear \}/.test(lv)
    && /window\.crmViewBoard = /.test(lv) && /window\.crmViewList\s*= /.test(lv));
  // 2026-09-30 (multi-job stage 2a): a job card's select also passes its jobId.
  assert('stage select rides moveCard (history + gating intact)',
    /window\.moveCard\(sel\.dataset\.id, sel\.value(, sel\.dataset\.jobId \? \{ jobId: sel\.dataset\.jobId \} : undefined)?\)/.test(lv));
  assert('mode persists in localStorage and gates body.crm-list-mode',
    /nbd-crm-view-mode/.test(lv) && /crm-list-mode/.test(lv));

  const dashHtml = readDashboard();
  assert('view row carries the Board/List toggle wired through the call delegate',
    /id="crmViewBoardBtn"[^>]*data-fn="crmViewBoard"/.test(dashHtml)
    && /id="crmViewListBtn"[^>]*data-fn="crmViewList"/.test(dashHtml));
  assert('list surface div sits beside the kanban board',
    /id="crmListWrap"[\s\S]{0,600}id="kanbanBoard"/.test(dashHtml));
  assert('crm-list-view.js ships as a script tag',
    /<script defer src="js\/crm-list-view\.js/.test(dashHtml));

  const state = read(path.join(PRO_JS, 'dashboard-state.js'));
  assert('call allowlist admits crmViewBoard/crmViewList',
    /'crmViewBoard', 'crmViewList'/.test(state));

  const pipe = read(path.join(PRO_JS, 'crm-pipeline.js'));
  assert('renderLeads hands the fully-narrowed list to CrmListView',
    /window\.CrmListView\.isActive\(\)\) window\.CrmListView\.render\(list\)/.test(pipe));

  const styles = readDashboardStyles();
  assert('body.crm-list-mode swaps the surfaces CSS-side',
    /body\.crm-list-mode #view-crm \.kanban-board\{ display:none !important; \}/.test(styles)
    && /body\.crm-list-mode \.crm-list-wrap\{ display:block/.test(styles));
}

section('Wave 4 — Design tokens (type / spacing / radius / tap-targets)');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  // 1. Type scale.
  for (const tok of ['--fs-2xs','--fs-xs','--fs-sm','--fs-md','--fs-base','--fs-lg','--fs-xl','--fs-2xl','--fs-3xl','--fs-4xl']) {
    assert('type token ' + tok + ' defined at :root',
      new RegExp(tok.replace(/-/g,'\\-') + '\\s*:').test(dash),
      'expected ' + tok + ' definition');
  }
  // 2. Spacing scale.
  for (const tok of ['--sp-0','--sp-1','--sp-2','--sp-4','--sp-6','--sp-8','--sp-12','--sp-16']) {
    assert('spacing token ' + tok + ' defined',
      new RegExp(tok.replace(/-/g,'\\-') + '\\s*:').test(dash),
      'expected ' + tok + ' definition');
  }
  // 3. Radius scale.
  for (const tok of ['--r-xs','--r-sm','--r-md','--r-lg','--r-xl','--r-full']) {
    assert('radius token ' + tok + ' defined',
      new RegExp(tok.replace(/-/g,'\\-') + '\\s*:').test(dash),
      'expected ' + tok + ' definition');
  }
  // 4. Tap-target + transition tokens.
  assert('tap-target token --tap-min defined (44px Apple HIG)',
    /--tap-min\s*:\s*44px/.test(dash),
    'expected --tap-min:44px');
  assert('transition tokens (--t-fast/--t-mid/--t-slow) defined',
    /--t-fast\s*:[\s\S]{0,80}--t-mid\s*:[\s\S]{0,80}--t-slow\s*:/.test(dash),
    'expected --t-fast/--t-mid/--t-slow definitions');
  // 5. Sample applications: tokens are actually being used by the
  //    new mobile components, not just defined.
  assert('.m-jd-name uses var(--fs-4xl)',
    /\.m-jd-name[\s\S]{0,400}font-size:\s*var\(--fs-4xl\)/.test(dash),
    'expected .m-jd-name to consume var(--fs-4xl)');
  assert('.m-create-row-lbl uses var(--fs-lg)',
    /\.m-create-row-lbl[\s\S]{0,200}font-size:\s*var\(--fs-lg\)/.test(dash),
    'expected .m-create-row-lbl to consume var(--fs-lg)');
}

section('Wave 3 — Kanban polish (column header + hover-reveal arrows)');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  // 1. Column header was tightened (padding 7px 12px + 1px border).
  assert('.kcol-header padding tightened to 7px 12px',
    /\.kcol-header\{\s*padding:\s*7px\s+12px\s*!important/.test(dash),
    'expected .kcol-header padding rule of 7px 12px !important');
  assert('.kcol-header border-bottom dropped to 1px',
    /\.kcol-header[\s\S]{0,400}border-bottom:\s*1px\s+solid\s+currentColor\s*!important/.test(dash),
    'expected .kcol-header border-bottom: 1px solid currentColor !important');
  // 2. Hover-reveal: default low-opacity (works on hybrid-touch desktops),
  //    full opacity on hover/focus, force-on inside @media (hover:none).
  assert('.kc-arrow default opacity is .35 (de-emphasized but visible)',
    /\.kc-arrow\{\s*opacity:\s*\.35/.test(dash),
    'expected .kc-arrow default opacity:.35 (Wave 3 hotfix replaced opacity:0 / pointer:fine gating)');
  assert('.k-card:hover .kc-arrow lifts to opacity:1',
    /\.k-card:hover\s+\.kc-arrow[\s\S]{0,200}opacity:\s*1/.test(dash),
    'expected .k-card:hover .kc-arrow → opacity:1');
  assert('@media (hover: none) forces .kc-arrow opacity:1',
    /@media\s*\(hover:\s*none\)[\s\S]{0,200}\.kc-arrow\{\s*opacity:\s*1/.test(dash),
    'expected touch-device override to keep arrows fully visible');
}

section('Phase orange-rgba — 7 deferred JS files reviewed');
{
  // Theme-aware surfaces converted to color-mix(in srgb, var(--orange) X%, transparent).
  for (const [file, opts] of [
    ['docs/pro/js/estimate-finalization.js', {expect: 0, kind: 'theme-aware (selected estimate card)'}],
    ['docs/pro/js/nbd-doc-viewer.js',        {expect: 0, kind: 'theme-aware (.nbdv-action-btn hover)'}],
    ['docs/pro/js/rep-report-generator.js',  {expect: 1, kind: 'partial — line ~497 converted; line ~1441 stays as literal (PDF narrative-badge brand-pin)'}],
  ]) {
    const src = read(path.join(ROOT, file));
    const n = (src.match(/rgba\(\s*189\s*,/g) || []).length;
    assert(file + ' has ' + opts.expect + ' rgba(189,…) literals — ' + opts.kind,
      n === opts.expect,
      'expected ' + opts.expect + ' rgba(189,…) in ' + file + '; got ' + n);
  }
  // Brand-pinned files keep their literals — these surfaces should NOT
  // theme-shift (PDFs, customer-facing auth + share, theme-engine config).
  for (const [file, expectedCount, reason] of [
    ['docs/pro/js/document-generator-templates.js', 1, 'PDF template box-shadow — brand-pin (PDFs do not theme-shift)'],
    // share-gallery.js was DELETED 2026-07-27: it uploaded a text/html Blob to a
    // Storage path whose write rule requires isImage(), so the Share Gallery
    // button could never succeed, and it minted permanent unrevocable links with
    // hardcoded NBD brand strings — the pre-#698 pattern #702 retired for GDPR.
    // Share now routes through PortalLinkHelpers (revocable, tenant-aware).
    ['docs/pro/js/nbd-auth.js',                     3, 'auth screen border + bg — brand-pin per Phase A'],
    ['docs/pro/js/theme-engine.js',                 2, 'theme-engine defaults (rgba(189,87,40,...)) — config, not styling'],
  ]) {
    const src = read(path.join(ROOT, file));
    const n = (src.match(/rgba\(\s*189\s*,\s*87\s*,\s*40\s*,/g) || []).length;
    assert(file + ' keeps ' + expectedCount + ' brand-pinned orange-rgba — ' + reason,
      n === expectedCount,
      'expected ' + expectedCount + ' rgba(189,87,40,…) in ' + file + '; got ' + n);
  }
}

section('Phase C.6 — inline-style sweep + utility-class layer');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const theme = read(path.join(ROOT, 'docs/pro/css/theme-system.css'));

  // The utility-class layer is declared in theme-system.css.
  for (const cls of ['dn','mb-md','mb-lg','meta-11','meta-10','f1','eyebrow','bc-chip',
                     'row-tight','body-13','btn-11','fs-11','bc-meta-cp','row-card',
                     'cp','cell','cell-t','cell-m','bb','w-full','mt-14',
                     'fs-12','fs-14','heading-13','flex-g8','fwgap-8',
                     'fg-orange','eyebrow-9','card-7','btn-input-40','kbd-input',
                     'pos-rel','ac-orange','chip-green','chip-blue']) {
    assert("theme-system.css declares ." + cls,
      new RegExp("\\." + cls + "\\s*\\{").test(theme),
      'expected utility class .' + cls + ' in theme-system.css');
  }

  // Hard upper bound — we cleaned up at least ~400 of the original 1,187
  // inline styles. Truly dynamic / one-off styles can remain, but the
  // count must not regress above 850 (was 1,187 before this sweep).
  const remaining = (dash.match(/style="[^"]+"/g) || []).length;
  assert('inline style count cut to ≤850 (was 1,187)',
    remaining <= 850,
    'expected ≤850 inline style attrs after C.6; got ' + remaining);

  // .dn class must hide WITHOUT !important — JS toggling style.display='block'
  // must still win over the class rule.
  assert('.dn rule uses display:none (no !important — keeps JS show/hide working)',
    /\.dn\{display:none;\}/.test(theme),
    '.dn should be display:none (no !important)');

  // Spot-check: the 7-property eyebrow / 8-property row-card declarations
  // are present and match exactly the strings the sweep replaced.
  assert('.eyebrow has the 7-property uppercase label declaration',
    /\.eyebrow\{font-size:10px;font-weight:700;letter-spacing:\.1em;text-transform:uppercase;color:var\(--m\);display:block;margin-bottom:6px;\}/.test(theme),
    'expected .eyebrow with the full 7-property declaration');
  assert('.row-card has the bordered row declaration',
    /\.row-card\{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var\(--s2\);border:1px solid var\(--br\);border-radius:7px;cursor:pointer;\}/.test(theme),
    'expected .row-card with the full row declaration');
}

section('Phase C.4 finale + C.5 — long-tail delegate + script-src tightening');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();
  const firebaseJson = read(path.join(ROOT, 'firebase.json'));

  // Zero inline onclicks left in dashboard.html.
  const remaining = (dash.match(/onclick=/g) || []).length;
  assert('dashboard.html has zero inline onclick handlers',
    remaining === 0,
    'expected 0 inline onclicks; got ' + remaining);

  // New generic delegate branches all present.
  for (const action of ['call','module','windowOpen','signOut','reload','closeOpen','clickProxy','hideEl','stopProp','removeSelf','removeParent','removeClosest','modalBackdropClose']) {
    assert("delegate handles action='" + action + "'",
      new RegExp("if \\(action === '" + action + "'\\)").test(mainJs),
      'expected ' + action + ' branch in _nbdActionDelegate');
  }

  // Allowlist Set declared and has a reasonable lower bound.
  assert('_NBD_CALL_ALLOWLIST Set declared with allowed call targets',
    /_NBD_CALL_ALLOWLIST\s*=\s*new Set\(\[/.test(mainJs),
    'expected _NBD_CALL_ALLOWLIST = new Set([...]) declaration');

  // (The on-window spot-check that used to live here is gone: the 14 cda*
  // wrappers converted in Tranche 2c-4a and the 20 one-off openers in Tranche
  // 2c-4c all moved OFF window into __NBD_CALL_REGISTRY. Their off-window +
  // registration guards live in the "Globals Tranches 0+1" and "Globals
  // Tranche 2c" sections below.)

  // C.5 — script-src 'unsafe-inline' dropped from line-44 enforcing CSP.
  // The Report-Only policy already lacked it; now the enforcing one matches.
  const csps = firebaseJson.match(/"Content-Security-Policy",\s*"value":\s*"([^"]+)"/g) || [];
  assert('at least one enforcing CSP declared',
    csps.length >= 1, 'expected ≥1 Content-Security-Policy in firebase.json');
  // Walk every enforcing-CSP entry and ensure none contain script-src
  // 'unsafe-inline' — EXCEPT entries inside a header block that carries
  // a FIXME(csp) _comment (documented temporary exception). Today the
  // only such exception is /pro/customer pending its inline-script
  // extraction (mirror of #398 dashboard.html work).
  const firebaseCfg = JSON.parse(firebaseJson);
  const headerEntries = (firebaseCfg.hosting?.headers || []);
  const offenders = [];
  for (const e of headerEntries) {
    const csp = (e.headers || []).find(h => h.key === 'Content-Security-Policy');
    if (!csp) continue;
    if (!/script-src\s+'self'\s+'unsafe-inline'/.test(csp.value)) continue;
    const cmt = e._comment || '';
    if (/FIXME\(csp\)/.test(cmt)) continue; // documented exception OK
    offenders.push(e.source || '<unknown source>');
  }
  assert("no enforcing CSP retains script-src 'self' 'unsafe-inline' (except documented FIXME(csp))",
    offenders.length === 0,
    offenders.length ? 'offending sources: ' + offenders.join(', ') : '');
  // The enforcing CSP also adds script-src-attr 'none' to block any
  // inline event-handler attribute that could be reintroduced.
  assert("enforcing CSP declares script-src-attr 'none'",
    /script-src-attr\s+'none'/.test(firebaseJson),
    "expected script-src-attr 'none' in enforcing CSP");
}

section('Phase C.4 kanban + zone-color + pin-status — 3 picker clusters');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  for (const action of ['kanbanView','zoneColor','selectPin']) {
    assert("delegate handles action='" + action + "'",
      new RegExp("if \\(action === '" + action + "'\\)").test(mainJs),
      'expected ' + action + ' branch in _nbdActionDelegate');
  }

  const kv = (dash.match(/data-action="kanbanView"\s+data-target="[a-z]+"/g) || []).length;
  assert('kanbanView conversions: 7 (Ins/Cash/Fin/War/Svc/Jobs/All)',
    kv === 7, 'expected 7 kanbanView data-actions; got ' + kv);

  const zc = (dash.match(/data-action="zoneColor"\s+data-target="[^"]+"/g) || []).length;
  assert('zoneColor conversions: 6 (D2D zone swatches)',
    zc === 6, 'expected 6 zoneColor data-actions; got ' + zc);

  const sp = (dash.match(/data-action="selectPin"\s+data-target="[a-z-]+"\s+data-color="[^"]+"/g) || []).length;
  assert('selectPin conversions: 8 (D2D pin status buttons)',
    sp === 8, 'expected 8 selectPin data-actions; got ' + sp);

  const remaining =
    (dash.match(/onclick="switchKanbanView\(/g) || []).length +
    (dash.match(/onclick="selectZoneColor\(/g) || []).length +
    (dash.match(/onclick="selectPin\(/g) || []).length;
  assert('no inline onclicks remain for these 3 clusters',
    remaining === 0,
    'expected 0 inline onclicks across the 3 clusters; got ' + remaining);

  // The kanban buttons preserve their data-view attribute (other code
  // reads it for filtering); confirm we didn't strip it.
  assert('kanban buttons preserve data-view alongside the new data-action',
    /data-view="insurance"[\s\S]{0,80}data-action="kanbanView"/.test(dash) ||
      /data-action="kanbanView"[\s\S]{0,80}data-view="insurance"/.test(dash),
    'expected data-view="insurance" preserved on the Ins kanban button');
}

section('Phase C.4 line-type — selLT via selLineType action');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  assert("delegate handles action='selLineType'",
    /if \(action === 'selLineType'\)/.test(mainJs),
    'expected selLineType branch in _nbdActionDelegate');
  assert("selLineType branch dispatches selLT(idx, el)",
    /selLT\(idx, el\)/.test(mainJs),
    'expected selLT(idx, el) dispatch');

  const count = (dash.match(/data-action="selLineType"\s+data-target="\d+"/g) || []).length;
  assert('selLineType conversions: 11 (one per draw-tool line type)',
    count === 11,
    'expected 11 selLineType data-actions; got ' + count);

  const remaining = (dash.match(/onclick="selLT\(/g) || []).length;
  assert('no inline selLT onclicks remain',
    remaining === 0,
    'expected 0 inline selLT onclicks; got ' + remaining);
}

section('Phase C.4 settings-tab — switchSettingsTab via settingsTab action');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  assert("delegate handles action='settingsTab'",
    /if \(action === 'settingsTab'\)/.test(mainJs),
    'expected settingsTab branch in _nbdActionDelegate');
  assert("settingsTab branch dispatches switchSettingsTab(target)",
    /switchSettingsTab\(target\)/.test(mainJs),
    'expected switchSettingsTab(target) dispatch');

  const count = (dash.match(/data-action="settingsTab"\s+data-target="[a-z]+"/g) || []).length;
  assert('settingsTab conversions: 11 (one per Settings tab, incl. Pipelines)',
    count === 11,
    'expected 11 settingsTab data-actions; got ' + count);

  const remaining = (dash.match(/onclick="switchSettingsTab\(/g) || []).length;
  assert('no inline switchSettingsTab onclicks remain',
    remaining === 0,
    'expected 0 inline switchSettingsTab onclicks; got ' + remaining);
}

section('Signature integration PR 2 — defaultSigners opt-in across contract-class templates');
{
  // Per [[signature-integration-v1]] design: nine templates declare
  // defaultSigners so the modal's Signers section auto-prechecks the
  // expected sign-set. This guards against future edits that silently
  // drop the field — losing a defaultSigners entry would mean the rep
  // has to re-add signers manually every time.
  const docGenSrc = read(path.join(ROOT, 'docs/pro/js/document-generator.js'));
  const TEMPLATES_WITH_SIGNERS = [
    'proposal', 'contract', 'inspectionHomeowner',
    'certificate_of_completion', 'scope_of_work',
    'change_order', 'work_authorization', 'payment_agreement'
  ];
  for (const tpl of TEMPLATES_WITH_SIGNERS) {
    // Match the template key followed (allow trailing chars/spaces) by an
    // object literal that contains defaultSigners. The trailing colon on
    // the literal key plus the rendered defaultSigners token is enough
    // to confirm the opt-in didn't get dropped by mistake.
    const re = new RegExp('^\\s*' + tpl + '\\s*:[\\s\\S]{0,500}defaultSigners:', 'm');
    assert("DOCUMENT_TYPES." + tpl + " declares defaultSigners",
      re.test(docGenSrc),
      'expected defaultSigners on ' + tpl + ' entry');
  }
  // Negative guard: a few templates intentionally stay off (per memory).
  // Templates without signers are single-line entries — match the ENTIRE
  // line and assert defaultSigners is absent from that line. (A greedier
  // regex would incorrectly catch defaultSigners from a neighboring
  // multi-line entry.)
  const SIGNER_OFF = ['invoice', 'customer_report', 'thank_you', 'door_hanger'];
  for (const tpl of SIGNER_OFF) {
    const lineRe = new RegExp('^\\s*' + tpl + '\\s*:.*$', 'm');
    const m = docGenSrc.match(lineRe);
    assert("DOCUMENT_TYPES." + tpl + " stays OFF (no defaultSigners)",
      m && !/defaultSigners/.test(m[0]),
      m ? ('found defaultSigners on ' + tpl + ' line: ' + m[0].slice(0, 120)) : (tpl + ' entry not found'));
  }
}

section('Signature integration PR 3a — saved-signature reuse store');
{
  // Per [[signature-integration-v1]] PR3 design: each captured signature
  // is persisted to leads/{leadId}/signatures/{role} so a future doc for
  // the same lead can offer "Use saved" (PR3b). PR3a builds the store.
  const widget = read(path.join(ROOT, 'docs/pro/js/signature-widget.js'));
  assert('widget finalize() surfaces the PNG per signer',
    /signedSigners\.push\(\{[^}]*png:\s*png/.test(widget));

  const docGen = read(path.join(ROOT, 'docs/pro/js/document-generator.js'));
  assert('onPersistFinalized writes leads/{id}/signatures/{role}',
    /setDoc\([\s\S]{0,120}window\.doc\(window\.db,\s*'leads',\s*_leadIdEarly,\s*'signatures'/.test(docGen));
  assert('saved sig write keyed by role with png',
    /'signatures',\s*String\(s\.role\)\)[\s\S]{0,200}png:\s*s\.png/.test(docGen));
  assert('doc metadata signedSigners stays lean (no png dataURLs)',
    /signedSigners:\s*Array\.isArray\(signedSigners\)[\s\S]{0,160}\.map\(s => \(\{ role: s\.role/.test(docGen));

  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('rules expose signatures subcollection (owner-scoped)',
    /match \/signatures\/\{sigRole\}/.test(rules));
  assert('signatures write requires lead ownership',
    /signatures\/\{sigRole\}[\s\S]{0,260}allow write: if isAuth\(\)[\s\S]{0,160}isOwner\(get\(\/databases/.test(rules));
}

section('Signature integration PR 3b — "Use saved" reuse UI');
{
  const widget = read(path.join(ROOT, 'docs/pro/js/signature-widget.js'));
  assert('widget accepts a savedSigs postMessage',
    /__nbd_sig === 'savedSigs'/.test(widget));
  assert('widget injects a "Use saved" button',
    /data-nbd-sig-action', 'use-saved'/.test(widget));
  assert('widget applies the saved PNG onto the pad',
    /function applySavedToPad/.test(widget) && /drawImage\(img/.test(widget));

  const viewer = read(path.join(ROOT, 'docs/pro/js/nbd-doc-viewer.js'));
  assert('viewer carries savedSigs on context',
    /savedSigs:\s*opts\.savedSigs/.test(viewer));
  assert('viewer posts savedSigs into the iframe on load',
    /addEventListener\('load'[\s\S]{0,160}__nbd_sig:\s*'savedSigs'/.test(viewer));

  const docGen = read(path.join(ROOT, 'docs/pro/js/document-generator.js'));
  assert('docgen fetches saved sigs from leads/{id}/signatures',
    /_fetchSavedSignatures[\s\S]{0,300}window\.collection\(window\.db,\s*'leads',\s*leadId,\s*'signatures'\)/.test(docGen));
  assert('docgen passes savedSigs to the viewer (only when signers present)',
    /hasSigners \? await this\._fetchSavedSignatures[\s\S]{0,200}savedSigs:\s*_savedSigs/.test(docGen));
}

section('Phase C.4 docgen — NBDDocGen.fillAndGenerate via docgen action');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  assert("delegate handles action='docgen'",
    /if \(action === 'docgen'\)/.test(mainJs),
    'expected docgen branch in _nbdActionDelegate');
  assert("docgen branch dispatches NBDDocGen.fillAndGenerate(target)",
    /window\.NBDDocGen\.fillAndGenerate\(target\)/.test(mainJs),
    'expected NBDDocGen.fillAndGenerate(target) dispatch');

  // 24: +1 for storm_history_report (2026-09-09) under Insurance
  // Documents — the free NOAA/NWS 5-year storm history doc; −1 for the
  // Assignment of Benefits row, retired 2026-09-27 (no assignment or
  // co-payee paperwork in any state).
  const docgenCount = (dash.match(/data-action="docgen"\s+data-target="[a-zA-Z_]+"/g) || []).length;
  assert('docgen conversions: 24 (every Templates view row)',
    docgenCount === 24,
    'expected 24 docgen data-actions; got ' + docgenCount);
  assert('no Templates row generates an AOB or a Direction to Pay',
    !/data-target="(assignment_of_benefits|direction_to_pay)"/.test(dash),
    'a retired document is still offered');

  const remaining = (dash.match(/onclick="NBDDocGen\.fillAndGenerate/g) || []).length;
  assert('no inline NBDDocGen.fillAndGenerate onclicks remain',
    remaining === 0,
    'expected 0 inline NBDDocGen onclicks; got ' + remaining);
}

section('Phase C.4 mobile-nav — bottom-nav and More-drawer items');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  assert("delegate handles action='mobileNav'",
    /if \(action === 'mobileNav'\)/.test(mainJs),
    'expected mobileNav branch in _nbdActionDelegate');
  // Globals Tranche 3 T3-A (2026-09-18): dashboard-ui.js is one whole-file
  // IIFE now, so a bare mobileNav(target) in this branch would bind to the
  // file's LOCAL original. mobile-nav-customizer.js replaces window.mobileNav
  // at init with its custom-tab-aware version, and that override is what the
  // bare call reached before the wrap. So the branch prefers window.mobileNav
  // and keeps the local declaration only as a fallback.
  assert("mobileNav branch dispatches window.mobileNav(target), local mobileNav only as fallback",
    /if \(typeof window\.mobileNav === 'function'\) window\.mobileNav\(target\);\r?\n\s*else mobileNav\(target\);/.test(mainJs),
    'expected window.mobileNav(target) with a local fallback (T3-A: the customizer override lives on window)');
  assert("mobileNav branch does not call the bare name first (inside the IIFE it would skip the customizer override)",
    !/if \(typeof mobileNav === 'function'\) mobileNav\(target\)/.test(mainJs));
  assert("mobileNav branch honors data-close-more flag",
    /el\.hasAttribute\('data-close-more'\)[\s\S]{0,120}closeMobileMore\(\)/.test(mainJs),
    'expected closeMobileMore() called when data-close-more present');

  // 3 bottom-nav items (mn-item) plus 21 More-drawer items = 24 total
  // mobileNav data-actions in the markup. (Crew-calendar More item
  // intentionally remains inline — defensive existence check.)
  // (Expenses + Money More-drawer items added with the expense initiative.)
  // (Reports + Referrals added 2026-09-25, phone audit views#1 — they were
  // sidebar-only and unreachable on a phone. Talk Tank came in with them but
  // is not counted: `[a-z]+` stops at the hyphen, same as job-templates.)
  const mnCount = (dash.match(/data-action="mobileNav"\s+data-target="[a-z]+"/g) || []).length;
  // (Yard Signs added 2026-09-29. Schedule added 2026-09-29 evening: the
  // Google Calendar panel lives there and Jo could not find the view.)
  // (Past Customers / win-back added 2026-10-01. Call Center added 2026-10-01.)
  assert('mobileNav conversions: 30 (3 bottom-nav + 27 more-drawer)',
    mnCount === 30,
    'expected 30 mobileNav data-actions; got ' + mnCount);

  const closeMoreCount = (dash.match(/data-action="mobileNav"\s+data-target="[a-z]+"\s+data-close-more/g) || []).length;
  assert('27 mobileNav items carry data-close-more (More-drawer items)',
    closeMoreCount === 27,
    'expected 27 data-close-more flags; got ' + closeMoreCount);

  // C.4 finale: every mobileNav handler is delegated (no inline onclicks).
  const remaining = (dash.match(/onclick="mobileNav\(/g) || []).length;
  assert('zero inline mobileNav onclicks remain (all delegated)',
    remaining === 0,
    'expected exactly 0 inline mobileNav onclicks; got ' + remaining);
}

section('Phase C.4 cluster 5 — arg-bearing toggle handlers');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  for (const action of ['navSection','mapSidebar','mapOverlay','tradeChip','crmToolsMenu']) {
    assert("delegate handles action='" + action + "'",
      new RegExp("if \\(action === '" + action + "'\\)").test(mainJs),
      'expected ' + action + ' branch in _nbdActionDelegate');
  }

  // Markup counts
  const navSec = (dash.match(/data-action="navSection"\s+data-target="[a-z-]+"/g) || []).length;
  assert('navSection conversions: 3',
    navSec === 3,
    'expected 3 navSection conversions; got ' + navSec);

  const mapSb = (dash.match(/data-action="mapSidebar"\s+data-target="[a-z-]+"/g) || []).length;
  assert('mapSidebar conversions: 2',
    mapSb === 2,
    'expected 2 mapSidebar conversions; got ' + mapSb);

  const mapOv = (dash.match(/data-action="mapOverlay"\s+data-target="[a-z]+"/g) || []).length;
  assert('mapOverlay conversions: 6 (heat/pins/jobs/customers/storm/weather)',
    mapOv === 6,
    'expected 6 mapOverlay conversions; got ' + mapOv);

  // Inline arg-bearing toggles retired (except the documented ternary).
  const argRemain = (dash.match(/onclick="toggle(NavSection|MapSidebar|Overlay|TradeChip|CrmToolsMenu)\(/g) || []).length;
  assert('no inline arg-bearing toggle onclicks remain (besides the mobileCreatePopover ternary)',
    argRemain === 0,
    'expected 0 arg-bearing toggle onclicks; got ' + argRemain);
}

section('Phase C.4 cluster 4 — no-arg toggle handlers via toggle action');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  assert("delegate handles action='toggle' via _NBD_TOGGLE_FNS",
    /if \(action === 'toggle'\)[\s\S]{0,400}_NBD_TOGGLE_FNS\[target\]/.test(mainJs),
    'expected toggle branch + _NBD_TOGGLE_FNS registry');

  // ── Globals Tranche 3 dispatch-map slice (2026-09-01) ──
  // Both name-string maps used to resolve with a bare `window[fnName]`, which
  // made every handler reachable only through them permanently un-convertible:
  // a module-scoped function is invisible to a string lookup on the global
  // object. They resolve via _nbdResolveMapped now — registry first, window
  // second. If either branch regresses to window[fnName], every handler already
  // converted to registry-only goes silently dead (a modal that will not close).
  assert('toggle branch resolves via _nbdResolveMapped, not a bare window[fnName]',
    /if \(action === 'toggle'\)[\s\S]{0,600}_nbdResolveMapped\(fnName\)/.test(mainJs)
      && !/if \(action === 'toggle'\)[\s\S]{0,600}const fn = window\[fnName\]/.test(mainJs),
    'registry-first resolution is what lets map-dispatched handlers leave window');
  assert('_nbdResolveMapped checks __NBD_CALL_REGISTRY before window',
    /function _nbdResolveMapped\(fnName\)[\s\S]{0,400}__NBD_CALL_REGISTRY[\s\S]{0,200}window\[fnName\]/.test(mainJs));
  // It must NOT gate on _NBD_CALL_ALLOWLIST. The name came from a curated
  // in-code map, not from markup, so the map IS the allowlist — and 35 of the
  // 36 map names are absent from _NBD_CALL_ALLOWLIST (only closeQuickAddLead
  // appears in both, and that entry serves its separate data-fn dispatch), so
  // adding that gate would kill nearly every toggle and modal-close button.
  assert('_nbdResolveMapped does NOT gate on _NBD_CALL_ALLOWLIST',
    !/function _nbdResolveMapped\(fnName\)[\s\S]{0,400}_NBD_CALL_ALLOWLIST/.test(mainJs),
    'the curated map is the allowlist; gating again would break all 36 names');

  for (const target of ['bulkMode','kanbanFullscreen','sidebarCollapse','engagementSort','needsAttention','showSnoozed','staleShares','notifications','mobileMore']) {
    assert('_NBD_TOGGLE_FNS registers ' + target,
      new RegExp("\\b" + target + ":\\s+'toggle").test(mainJs),
      'expected ' + target + ' in the toggle registry');
  }

  const conversions = (dash.match(/data-action="toggle"\s+data-target="\w+"/g) || []).length;
  assert('≥15 data-action="toggle" conversions present',
    conversions >= 15,
    'expected ≥15 toggle conversions; got ' + conversions);

  // Simple inline toggle onclicks should be retired (defensive form too)
  const simpleRemain = (dash.match(/onclick="toggle[A-Z]\w*\(\)"/g) || []).length;
  const defensiveRemain = (dash.match(/onclick="window\.toggle\w+\s*&&\s*window\.toggle\w+\(\)"/g) || []).length;
  assert('0 inline simple onclick="toggleXxx()" remain',
    simpleRemain === 0,
    'expected 0 simple toggle onclicks; got ' + simpleRemain);
  assert('0 inline defensive onclick="window.toggleXxx && window.toggleXxx()" remain',
    defensiveRemain === 0,
    'expected 0 defensive-form toggle onclicks; got ' + defensiveRemain);
}

section('Phase C.4 cluster 3 — modal-close handlers via closeModal action');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  assert("delegate handles action='closeModal'",
    /if \(action === 'closeModal'\)[\s\S]{0,400}_NBD_MODAL_CLOSE_FNS\[target\]/.test(mainJs),
    'expected closeModal branch in _nbdActionDelegate using _NBD_MODAL_CLOSE_FNS registry');

  // Globals Tranche 3 dispatch-map slice (2026-09-01) — see the matching pin in
  // the toggle section. Regressing this branch to a bare window[fnName] would
  // leave the two converted handlers (closeMobileInspection,
  // closeMobileCreatePopover) unreachable, i.e. modals the user cannot close.
  assert('closeModal branch resolves via _nbdResolveMapped, not a bare window[fnName]',
    /if \(action === 'closeModal'\)[\s\S]{0,600}_nbdResolveMapped\(fnName\)/.test(mainJs)
      && !/if \(action === 'closeModal'\)[\s\S]{0,600}const fn = window\[fnName\]/.test(mainJs));

  // Registry exposes the function mapping
  for (const target of ['leadModal','taskModal','photoModal','propertyIntelModal','quickAddModal','docViewerModal','cardDetailModal','comparisonModal']) {
    assert('_NBD_MODAL_CLOSE_FNS registers ' + target,
      new RegExp("\\b" + target + ":\\s+'close").test(mainJs),
      'expected ' + target + ' in the registry');
  }

  // Markup: ≥30 data-action="closeModal" elements (we converted 33)
  const conversions = (dash.match(/data-action="closeModal"\s+data-target="\w+"/g) || []).length;
  assert('≥30 data-action="closeModal" conversions present',
    conversions >= 30,
    'expected ≥30 closeModal conversions; got ' + conversions);

  // 0 simple inline closeXxx onclicks remain
  const remaining = (dash.match(/onclick="close[A-Z][A-Za-z]+\(\)"/g) || []).length;
  assert('0 inline onclick="closeXxx()" handlers remain',
    remaining === 0,
    'expected 0 remaining; got ' + remaining);
}

section('Phase C.4 cluster 2 — compound goTo handlers (newEstimate / filterByStage / toolMenuGoTo)');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  // Action handlers wired in the delegate switch.
  for (const action of ['newEstimate','filterByStage','toolMenuGoTo']) {
    assert("delegate handles action='" + action + "'",
      new RegExp("if \\(action === '" + action + "'\\)").test(mainJs),
      'expected ' + action + ' branch in _nbdActionDelegate');
  }

  // Markup conversions
  const newEst = (dash.match(/data-action="newEstimate"/g) || []).length;
  assert('data-action="newEstimate" appears 2× (the two + New Estimate buttons)',
    newEst === 2,
    'expected 2 newEstimate conversions; got ' + newEst);

  const stages = (dash.match(/data-action="filterByStage"\s+data-stage="[a-z_]+"/g) || []).length;
  assert('data-action="filterByStage" appears 6× (one per dashboard stage box)',
    stages === 6,
    'expected 6 filterByStage conversions; got ' + stages);

  const tools = (dash.match(/data-action="toolMenuGoTo"\s+data-target="[a-z]+"/g) || []).length;
  assert('data-action="toolMenuGoTo" appears 7× (CRM tools menu items)',
    tools === 7,
    'expected 7 toolMenuGoTo conversions; got ' + tools);

  // C.4 finale: every inline goTo() is delegated; the d2d maps-redirect
  // compound is routed through window.goToD2DFromMaps.
  const remaining = (dash.match(/onclick="goTo\(/g) || []).length;
  assert('zero inline onclick="goTo(..." remain (all delegated)',
    remaining === 0,
    'expected exactly 0 inline goTo onclicks; got ' + remaining);
}

section('Phase C.4 starter — body-level data-action delegate (goTo cluster)');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  // 1. Delegate is wired in dashboard-main.js — listens for [data-action]
  //    clicks at the document level and dispatches goTo when matched.
  assert('document-level click delegate registered for [data-action]',
    /document\.addEventListener\('click',\s*function _nbdActionDelegate/.test(mainJs),
    'expected the _nbdActionDelegate function bound to document click');
  assert('delegate handles action="goTo" → calls goTo(target)',
    /if \(action === 'goTo'\)[\s\S]{0,400}goTo\(target\)/.test(mainJs),
    'expected the goTo branch in the action delegate');

  // 2. dashboard.html now carries data-action="goTo" elements (≥40 — we
  //    converted 54 simple onclick="goTo(...)" handlers).
  const goToActions = (dash.match(/data-action="goTo"\s+data-target="[a-z][a-z0-9-]*"/g) || []).length;
  assert('dashboard.html carries ≥40 data-action="goTo" data-target="..." elements',
    goToActions >= 40,
    'expected ≥40 data-action goTo conversions; got ' + goToActions);

  // 3. Simple form `onclick="goTo('xxx')"` is fully retired (the only
  //    remaining onclick="goTo(...)" calls should be compound forms
  //    with multiple statements).
  const simpleGoTo = (dash.match(/onclick="goTo\('[a-z][a-z0-9-]*'\)"/g) || []).length;
  assert('no simple onclick="goTo(\'xxx\')" handlers remain in dashboard.html',
    simpleGoTo === 0,
    'expected 0 simple inline goTo handlers; got ' + simpleGoTo);
}

section('Phase C.6 step 2 — JS-file orange-rgba sweep');
{
  // Step 5 (2026-05-17): legacy docs/pro/js/d2d-tracker.js was deleted
  // — only the d2d-tracker-2026b.js shards are live now.
  const SAFE_FILES = [
    'docs/pro/js/close-board.js',
    'docs/pro/js/d2d-tracker-2026b.js',
    'docs/pro/js/doc-preflight.js',
    'docs/pro/js/help-icon.js',
    'docs/pro/js/mobile-nav-customizer.js',
    'docs/pro/js/photo-engine.js',
    'docs/pro/js/real-deal-academy-lab.js',
    'docs/pro/js/ui.js',
    'docs/pro/js/dashboard-main.js',
  ];
  for (const p of SAFE_FILES) {
    // Step 4f (2026-05-17): d2d-tracker-2026b.js was split into three
    // shards. Pull the concatenated post-split source so the assertion
    // catches orange-rgba in core or ui too, not just in the thin shim.
    const body = p === 'docs/pro/js/d2d-tracker-2026b.js'
      ? readD2DLive()
      : read(path.join(ROOT, p));
    assert(p + ': no hardcoded rgba(189,87,40,...)',
      !/rgba\(189,\s*87,\s*40/.test(body),
      p + ' should use color-mix(in srgb, var(--orange) X%, transparent)');
  }
}

section('Phase C.6 starter — retire hardcoded NBD-orange rgba in dashboard.html');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  // Same contract we already enforce on customer/login/vault.
  assert('dashboard.html: no hardcoded rgba(189,87,40,...) NBD-orange literals',
    !/rgba\(189,\s*87,\s*40/.test(dash),
    'expected dashboard.html to use color-mix(in srgb, var(--orange) X%, transparent) — not literal NBD-orange rgba');
  // Spot-check that the conversions used the right pattern (sample
  // a known-converted opacity).
  assert('dashboard.html now consumes color-mix(--orange) for theme-tinted decorations',
    /color-mix\(in srgb,\s*var\(--orange\)\s+\d+%,\s*transparent\)/.test(dash),
    'expected color-mix(in srgb, var(--orange) X%, transparent) usages');
}

section('Phase C.3 finish-finish — crm + map + docs');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  for (const v of ['crm','map','docs']) {
    assert('view-' + v + ' is an empty mount with data-view-template',
      new RegExp('<div class="view" id="view-' + v + '"\\s+data-view-template="tpl-view-' + v + '"></div>').test(dash),
      'expected mount div for view-' + v);
    assert('<template id="tpl-view-' + v + '"> exists',
      new RegExp('<template id="tpl-view-' + v + '">').test(dash),
      'expected tpl-view-' + v + ' template element');
  }
  // Sanity: NO view remains inline. view-est was the last raw view and
  // was templated by Rock 4 Phase 4 (commit b6cb61da) once the Rock 2
  // dep landed; this assertion previously allowed exactly ['est'].
  // Strict count of "still-inline" views = those whose mount doesn't
  // carry data-view-template attribute.
  const stillInline = [];
  const reAll = /class="view"[^>]*id="view-([a-z]+)"([^>]*)>/g;
  let m;
  while ((m = reAll.exec(dash)) !== null) {
    if (!/data-view-template/.test(m[2])) stillInline.push(m[1]);
  }
  assert('no view remains inline (Rock 4 Phase 4: view-est templated)',
    stillInline.length === 0,
    'expected zero inline views; got: ' + stillInline.join(','));
}

section('Routes: every view-* mount has a routeConfig entry (W160 regression class)');
{
  // dashboard-main.js gates BOTH the hashchange handler and the boot
  // router on routeConfig[name]. A view div without a route still works
  // from the sidebar (data-action="goTo" calls goTo directly) but its
  // deep link, hard refresh and browser-back silently land on the
  // previous view. W160 fixed eight of these in 2026-05; expenses / money
  // / refrewards then shipped in 2026-06/07 without entries and nothing
  // caught it until 2026-09-02. Set-compare in both directions so neither
  // side can drift again.
  const dash  = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const state = read(path.join(PRO_JS, 'dashboard-state.js'));
  const views = new Set();
  const reDiv = /<div\b([^>]*)>/g;
  let dm;
  while ((dm = reDiv.exec(dash)) !== null) {
    const attrs = dm[1];
    if (!/\bclass="view(?:\s|")/.test(attrs)) continue;
    const idm = /\bid="view-([a-z0-9-]+)"/.exec(attrs);
    if (idm) views.add(idm[1]);
  }
  const block = state.match(/const routeConfig = \{([\s\S]*?)\n\};/);
  assert('routeConfig block found in dashboard-state.js', !!block);
  const routes = new Set();
  if (block) {
    const reKey = /^\s*'([a-z0-9-]+)'\s*:/gm;
    let km;
    while ((km = reKey.exec(block[1])) !== null) routes.add(km[1]);
  }
  assert('found a plausible number of view mounts (>= 25)', views.size >= 25,
    'got ' + views.size + ' — if the mount markup changed, update the extractor');
  const unrouted = [...views].filter(v => !routes.has(v)).sort();
  const orphanRoutes = [...routes].filter(r => !views.has(r)).sort();
  assert('every view-* mount has a routeConfig entry',
    unrouted.length === 0, 'unrouted views (deep links broken): ' + unrouted.join(','));
  assert('every routeConfig key has a view-* mount',
    orphanRoutes.length === 0, 'routes without a view div: ' + orphanRoutes.join(','));
  for (const v of ['expenses', 'money', 'refrewards']) {
    assert('route ' + v + ' is registered (2026-09-02 fix)', routes.has(v));
  }
  assert('route signs is registered (yard signs 2026-09-29)', routes.has('signs'));
}

section('Phase C.3 finish — view-prospects + D.1 plumbing');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const testsPkg = read(path.join(ROOT, 'tests/package.json'));
  assert('view-prospects is an empty mount with data-view-template',
    /<div class="view" id="view-prospects"\s+data-view-template="tpl-view-prospects"><\/div>/.test(dash),
    'expected mount div for view-prospects');
  assert('<template id="tpl-view-prospects"> exists',
    /<template id="tpl-view-prospects">/.test(dash),
    'expected tpl-view-prospects template element');
  // D.1 — engines pin so future Node-version drift doesn't break the
  // playwright transitive install in fresh containers.
  assert('tests/package.json declares engines.node ≥22',
    /"engines":\s*\{\s*"node":\s*">=22"\s*\}/.test(testsPkg),
    'expected engines.node pin to >=22 in tests/package.json');
}

section('Phase C.3 wave 2 — draw + dash + reports + settings');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  // Each of the 4 big views: empty mount + matching template.
  for (const v of ['draw','dash','reports','settings']) {
    assert('view-' + v + ' is an empty mount with data-view-template',
      new RegExp('<div class="view" id="view-' + v + '"\\s+data-view-template="tpl-view-' + v + '"></div>').test(dash),
      'expected mount div for view-' + v);
    assert('<template id="tpl-view-' + v + '"> exists',
      new RegExp('<template id="tpl-view-' + v + '">').test(dash),
      'expected tpl-view-' + v + ' template element');
  }

  // _hydrateViewTemplate runs each template <script> once. Until 2026-09-25
  // it appended the clone and THEN swapped each cloned script in the live
  // view for a fresh one — but the clone is not inert (a <template> script
  // never started), so every template script ran twice. The swap now happens
  // in the detached fragment before it is inserted. The behavioural proof is
  // phone-views.spec.js "lazy view templates run each script once"; this
  // only pins the shape.
  const hydrate = (mainJs.match(/function _hydrateViewTemplate\(name\) \{[\s\S]*?\n\}/) || [''])[0];
  assert('_hydrateViewTemplate swaps each template <script> for a fresh one BEFORE inserting the fragment',
    /const frag = document\.importNode\(tpl\.content, true\);[\s\S]{0,200}frag\.querySelectorAll\('script'\)\.forEach[\s\S]{0,300}createElement\('script'\)[\s\S]{0,600}replaceWith\(newScript\)[\s\S]{0,100}view\.appendChild\(frag\)/.test(hydrate),
    'expected importNode → swap scripts in the fragment → view.appendChild(frag)');
  assert('_hydrateViewTemplate never swaps scripts that are already in the page (they have run once already)',
    hydrate && !/view\.querySelectorAll\('script'\)/.test(hydrate) && !/replaceChild/.test(hydrate),
    'a swap after insertion runs every template script twice');
  assert('_hydrateViewTemplate keeps external template scripts in page order (async = false)',
    /newScript\.async = false/.test(hydrate),
    'a script inserted by script runs async (load order) unless async is set false');

  // CSP hotfix (2026-05-16): the inline scripts inside tpl-view-draw
  // and tpl-view-settings were extracted to external files
  // (dashboard-accessory-panel-init.js + the appearance/team/billing/
  // hotkey/sidebar shards). _hydrateViewTemplate handles both inline
  // AND external scripts (createElement copies all attributes including
  // src), so the readyState guard logic now lives in
  // dashboard-accessory-panel-init.js.
  assert('tpl-view-draw script handles both initial-load and post-hydration',
    /tpl-view-draw[\s\S]*?dashboard-accessory-panel-init\.js/.test(dash) ||
    /tpl-view-draw[\s\S]*?_drawInit[\s\S]*?document\.readyState === 'loading'[\s\S]*?DOMContentLoaded[\s\S]*?_drawInit/.test(dash),
    'expected dashboard-accessory-panel-init.js inside tpl-view-draw, or the _drawInit pattern inline');

  // Confirm the extracted file still carries the readyState guard.
  const drawInit = fs.existsSync(path.join(ROOT, 'docs/pro/js/dashboard-accessory-panel-init.js'))
    ? read(path.join(ROOT, 'docs/pro/js/dashboard-accessory-panel-init.js')) : '';
  assert('dashboard-accessory-panel-init.js carries readyState/_drawInit guard',
    /_drawInit[\s\S]*?document\.readyState === 'loading'[\s\S]*?DOMContentLoaded[\s\S]*?_drawInit/.test(drawInit),
    'expected the extracted file to keep the readyState/DOMContentLoaded guard');

  // view-settings' 5 (formerly inline) scripts all live inside the
  // template now — either as inline or external references. Count
  // BOTH styles. Previously checked for `<script>` (5 inline blocks);
  // after CSP extraction these are `<script src="dashboard-*.js?v=1">`.
  {
    const tplStart = dash.indexOf('<template id="tpl-view-settings">');
    const tplEnd = dash.indexOf('</template><!-- /tpl-view-settings -->', tplStart);
    assert('tpl-view-settings is closed by a matching </template> tag',
      tplStart > -1 && tplEnd > tplStart,
      'expected </template><!-- /tpl-view-settings --> to close the settings template');
    const settingsBody = dash.slice(tplStart, tplEnd);
    // Count all <script ...> opening tags (inline or external) inside
    // the template. Inline = `<script>`; external = `<script src=...>`.
    // 6 → 7 on 2026-07-29: dashboard-connect-tab.js (Connect phase 2).
    const scriptCount = (settingsBody.match(/<script[\s>]/g) || []).length;
    assert('tpl-view-settings carries 7 <script> blocks (inline or external, incl. pipeline-builder)',
      scriptCount === 7,
      'expected 7 scripts inside the settings template, got ' + scriptCount);
    // The COUNT is a weak proxy for the thing that actually matters (CSP
    // extraction put these scripts inside the template, and a settings module
    // loaded OUTSIDE it runs before its markup exists). So also pin the intent:
    // every settings-tab module must be referenced from inside the template.
    // Bumping the number alone, next time, would satisfy the count and miss this.
    ['dashboard-custom-theme.js', 'dashboard-sidebar-customizer.js', 'pipeline-builder.js',
      'dashboard-team-tab.js', 'dashboard-billing-tab.js', 'dashboard-connect-tab.js',
      'dashboard-hotkey-toggles.js'].forEach((f) => {
      const insideCount = (settingsBody.match(new RegExp(f.replace(/\./g, '\\.'), 'g')) || []).length;
      const wholeFile = (dash.match(new RegExp('<script[^>]*' + f.replace(/\./g, '\\.'), 'g')) || []).length;
      assert(f + ' is loaded from INSIDE tpl-view-settings',
        insideCount > 0 && wholeFile === 1,
        'expected exactly one <script> for ' + f + ', inside the settings template');
    });
  }
}

section('Wave 5e (A.5) — second-pass theme contrast audit');
{
  const themeCSS = read(path.join(ROOT, 'docs/pro/css/theme-system.css'));
  // Programmatic luminance check — every theme's --orange should give
  // white text ≥ 3.5:1 contrast OR have an explicit --accent-fg
  // override. Parser pulls each theme's --orange value and per-theme
  // --accent-fg presence; assertion fails any theme that fails BOTH.
  const reTheme = /:root\[data-theme="([^"]+)"\][^{]*\{\s*--orange:\s*(#[0-9a-fA-F]{6})/g;
  const reFg = /:root\[data-theme="([^"]+)"\][^{]*\{[\s\S]*?--accent-fg/g;
  const themes = {};
  let m;
  while ((m = reTheme.exec(themeCSS)) !== null) themes[m[1]] = m[2];
  // Also parse the group-selector overrides (paper, ghost, etc.)
  const groupRe = /:root\[data-theme="[^"]+"\][^{]*(?:,\s*:root\[data-theme="[^"]+"\][^{]*)*\{\s*--accent-fg/g;
  const overridden = new Set();
  let g;
  while ((g = groupRe.exec(themeCSS)) !== null) {
    const sel = g[0];
    const names = [...sel.matchAll(/data-theme="([^"]+)"/g)].map(x => x[1]);
    names.forEach(n => overridden.add(n));
  }
  function lum(hex){
    const r=parseInt(hex.slice(1,3),16)/255;
    const gr=parseInt(hex.slice(3,5),16)/255;
    const b=parseInt(hex.slice(5,7),16)/255;
    const f=v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);
    return 0.2126*f(r)+0.7152*f(gr)+0.0722*f(b);
  }
  // nbd-original is the canonical NBD brand — white-on-orange is the
  // identity, so it's explicitly grandfathered here (3.07 contrast).
  const BRAND_GRANDFATHERED = new Set(['nbd-original']);
  const failingWithoutOverride = [];
  for (const [name, hex] of Object.entries(themes)) {
    if (BRAND_GRANDFATHERED.has(name)) continue;
    const oL = lum(hex);
    const cWhite = 1.05 / (oL + 0.05);
    if (cWhite < 3.5 && !overridden.has(name)) {
      failingWithoutOverride.push(`${name} (${hex}, white-contrast ${cWhite.toFixed(2)})`);
    }
  }
  assert('every sub-3.5 white-contrast theme has an explicit --accent-fg override',
    failingWithoutOverride.length === 0,
    'these themes still need --accent-fg overrides: ' + failingWithoutOverride.join(' | '));
  // Spot-check: A.5's 11 newly-covered themes are present.
  for (const t of ['forest','arctic','deep-space','glow','retro','vaporwave','halloween','android','ios26','candlelit','midnight-oil']) {
    assert('A.5 override present for theme "' + t + '"',
      new RegExp(':root\\[data-theme="' + t + '"\\][^{]*\\{[\\s\\S]{0,200}--accent-fg').test(themeCSS),
      'expected A.5 to override --accent-fg for ' + t);
  }
}

section('Wave 5d (A.4) — accent contract on remaining toggle-active states');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  // Step 4b: search-highlight + saveBtn cssText assertions cross
  // the split — concat via readCrm() so the regexes match
  // regardless of which split file the inline-style strings landed in.
  const crmJs = readCrm();
  // 1. .crm-icon-btn.active gains the inset --accent-ring boundary.
  assert('.crm-icon-btn.active includes box-shadow inset --accent-ring',
    /\.crm-icon-btn\.active\{[\s\S]{0,400}box-shadow:inset 0 0 0 1px var\(--accent-ring\)/.test(dash),
    'expected .crm-icon-btn.active to carry the inset --accent-ring boundary');
  // 2. JS-driven inline orange surfaces in crm.js use --accent-fg.
  // CO-M-1: the kanban search highlight moved from a buildCard innerHTML
  // string (<mark style="...">) to a TreeWalker text-node highlighter
  // (_highlightCardMatches), which creates the <mark> via createElement +
  // style.cssText. The theme-contrast contract (color via --accent-fg) is
  // unchanged — only the construction form moved from HTML string to cssText.
  assert('crm.js search-highlight <mark> uses var(--accent-fg)',
    /mark\.style\.cssText\s*=\s*'background:var\(--orange\);color:var\(--accent-fg\)/.test(crmJs),
    'expected the search-highlight <mark> to color via --accent-fg');
  assert('crm.js saveBtn.style.cssText uses var(--accent-fg) + accent-ring',
    /saveBtn\.style\.cssText\s*=\s*'background:var\(--orange\);border:1px solid var\(--orange\);color:var\(--accent-fg\);box-shadow:inset 0 0 0 1px var\(--accent-ring\)/.test(crmJs),
    'expected saveBtn inline cssText to use --accent-fg + inset --accent-ring');
}

section('Wave 2E.3 (A.3) — m-modal-bar on the last 5 dashboard modals');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const cases = [
    { id: 'quickAddModal',              eyebrow: 'Quick Add', titleId: null,                closeFn: 'closeQuickAddLead' },
    { id: 'warrantyCertModal',          eyebrow: 'NBD Guarantee', titleId: null,            closeFn: null },
    { id: 'docViewerModal',             eyebrow: 'Document Template', titleId: 'docViewerTitle', closeFn: 'closeDocViewer' },
    { id: 'cardDetailModal',            eyebrow: null, titleId: 'cardDetailName',           closeFn: 'closeCardDetailModal' },
    { id: 'propertyIntelConfirmModal',  eyebrow: 'Intel', titleId: null,                    closeFn: 'closePropertyIntelConfirmModal' },
  ];
  for (const c of cases) {
    const start = dash.indexOf('id="' + c.id + '"');
    const block = dash.slice(start, start + 3500);
    assert(c.id + ' inner .modal carries .m-modal-has-bar',
      /class="modal m-modal-has-bar"/.test(block),
      'expected ' + c.id + ' .modal class to include m-modal-has-bar');
    assert(c.id + ' renders an .m-modal-bar element',
      /class="m-modal-bar"/.test(block),
      'expected ' + c.id + ' to contain an .m-modal-bar element');
    if (c.eyebrow) {
      assert(c.id + ' eyebrow renders "' + c.eyebrow + '"',
        new RegExp('class="m-modal-bar-eyebrow"[^>]*>' + c.eyebrow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<').test(block),
        'expected eyebrow text "' + c.eyebrow + '" inside ' + c.id);
    }
    if (c.titleId) {
      assert(c.id + ' preserves id="' + c.titleId + '" on the bar title span',
        new RegExp('class="m-modal-bar-title"[^>]*id="' + c.titleId + '"').test(block),
        c.titleId + ' should move to the m-modal-bar-title span');
    }
    if (c.closeFn) {
      // C.4 cluster 3: the bar X was migrated from inline
      //   onclick="closeFn()"
      // to the body delegate:
      //   data-action="closeModal" data-target="<modal-id>"
      // We just verify the bar X carries the delegate hook; the
      // closeFn → modal-target mapping is locked by the
      // _NBD_MODAL_CLOSE_FNS registry assertions in the C.4 cluster 3
      // section above.
      assert(c.id + ' bar X uses data-action="closeModal"',
        /class="m-modal-bar-x"[^>]*data-action="closeModal"[^>]*data-target="[A-Za-z]+"/.test(block),
        'expected the bar X to carry data-action="closeModal" + data-target');
    }
  }
  // cardDetailModal got special treatment — kindLabel + name + stage
  // chip all moved into the bar, and the duplicate block below was
  // retired.
  const cd = dash.indexOf('id="cardDetailModal"');
  const cdBlock = dash.slice(cd, cd + 4000);
  assert('cardDetailModal: kindLabel migrated into m-modal-bar-eyebrow',
    /class="m-modal-bar-eyebrow" id="cardDetailKindLabel"/.test(cdBlock),
    'expected #cardDetailKindLabel to live on the eyebrow span');
  assert('cardDetailModal: stage chip carried into bar with id="cardDetailStage"',
    /class="m-modal-bar"[\s\S]{0,1200}id="cardDetailStage"/.test(cdBlock),
    'expected #cardDetailStage to live inside the m-modal-bar');
}

section('Wave 2E.2 — m-modal-bar applied to task / photo / propertyIntel');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  // Each modal must:
  //   1. have .m-modal-has-bar on its inner .modal
  //   2. contain an .m-modal-bar element
  //   3. have an eyebrow + title pair within it
  //   4. keep its existing id="*ModalTitle" if one existed (so JS still binds)
  const cases = [
    { id: 'taskModal',          eyebrow: 'Tasks',  titleId: 'taskModalTitle',  closeFn: 'closeTaskModal' },
    { id: 'photoModal',         eyebrow: 'Photos', titleId: 'photoModalTitle', closeFn: 'closePhotoModal' },
    { id: 'propertyIntelModal', eyebrow: 'Intel',  titleId: null,              closeFn: 'closePropertyIntelModal' },
  ];
  for (const c of cases) {
    const start = dash.indexOf('id="' + c.id + '"');
    const block = dash.slice(start, start + 2200);
    assert(c.id + ' .modal has class m-modal-has-bar',
      /class="modal m-modal-has-bar"/.test(block),
      'expected .modal class to carry m-modal-has-bar on ' + c.id);
    assert(c.id + ' contains an m-modal-bar',
      /class="m-modal-bar"/.test(block),
      'expected .m-modal-bar inside ' + c.id);
    assert(c.id + ' eyebrow renders "' + c.eyebrow + '"',
      new RegExp('class="m-modal-bar-eyebrow"[^>]*>' + c.eyebrow + '<').test(block),
      'expected eyebrow text "' + c.eyebrow + '" inside ' + c.id);
    // C.4 cluster 3: bar X migrated to the closeModal delegate.
    // closeFn → modal-target mapping is enforced by the
    // _NBD_MODAL_CLOSE_FNS registry assertion in the C.4 cluster 3
    // section above.
    assert(c.id + ' bar close button uses data-action="closeModal"',
      /class="m-modal-bar-x"\s+data-action="closeModal"\s+data-target="[A-Za-z]+"/.test(block),
      'expected the bar X to carry data-action="closeModal" + data-target');
    if (c.titleId) {
      assert(c.id + ' preserves id="' + c.titleId + '" on the bar title span',
        new RegExp('class="m-modal-bar-title"[^>]*id="' + c.titleId + '"').test(block),
        c.titleId + ' should move to the m-modal-bar-title span');
    }
  }
}

section('Wave 2E — m-modal-bar standardization');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  // 1. Pattern CSS exists.
  for (const cls of ['m-modal-bar','m-modal-bar-x','m-modal-bar-titles','m-modal-bar-eyebrow','m-modal-bar-title','m-modal-bar-action','m-modal-has-bar']) {
    assert('CSS class .' + cls + ' is defined',
      new RegExp('\\.' + cls.replace(/-/g,'\\-') + '\\b').test(dash),
      'expected .' + cls + ' rule');
  }
  // 2. .m-modal-has-bar hides the floating .modal-close.
  assert('.m-modal-has-bar hides floating .modal-close',
    /\.modal\.m-modal-has-bar\s*>\s*\.modal-close\s*\{\s*display:\s*none/.test(dash),
    'expected .modal-close hidden when .m-modal-has-bar applied');
  // 3. leadModal adopts the new pattern.
  const lmStart = dash.indexOf('<div class="modal-bg" id="leadModal">');
  const lmBlock = dash.slice(lmStart, lmStart + 1500);
  assert('leadModal applies .m-modal-has-bar to inner .modal',
    /class="modal m-modal-has-bar"/.test(lmBlock),
    'leadModal inner .modal should carry .m-modal-has-bar');
  assert('leadModal renders an .m-modal-bar header',
    /class="m-modal-bar"/.test(lmBlock),
    'leadModal should contain a .m-modal-bar element');
  assert('leadModal bar carries the "CRM" eyebrow',
    /class="m-modal-bar-eyebrow"[^>]*>CRM</.test(lmBlock),
    'expected the CRM eyebrow inside the m-modal-bar');
  assert('leadModal bar keeps id="leadModalTitle" on the title span',
    /class="m-modal-bar-title"[^>]*id="leadModalTitle"/.test(lmBlock),
    'leadModalTitle id should move to the bar title span so existing JS still finds it');
}

section('Wave 2D — Mobile inspection overlay');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  const mainJs = readDashboardMain();
  // 1. Overlay DOM exists.
  assert('m-inspection overlay element exists',
    /<div class="m-inspection" id="mInspection"/.test(dash),
    'expected <div class="m-inspection" id="mInspection">');
  assert('inspection overlay contains #mInspectionContainer',
    /id="mInspectionContainer"/.test(dash),
    'expected the engine mount point #mInspectionContainer');
  // 2. Close button wired via C.4 closeModal delegate
  //    (data-action="closeModal" data-target="mobileInspection").
  assert('inspection overlay has close button wired to closeModal delegate',
    /id="mInspBack"[\s\S]*data-action="closeModal"[\s\S]*data-target="mobileInspection"/.test(dash),
    'expected close button in m-inspection top bar to use the closeModal delegate');
  // 3. Entry CTA in mobile job-detail Activity tab.
  assert('mobile job-detail Activity tab has a .m-jd-cta Start Inspection button',
    /class="m-jd-cta"[\s\S]*data-action="call" data-fn="cdaOpenMobileInspection"/.test(dash),
    'expected a .m-jd-cta wired to cdaOpenMobileInspection');
  // 4. JS hooks exposed. Split by disposition: openMobileInspection is read as
  //    window.openMobileInspection by the 2c-4a cdaOpenMobileInspection wrapper
  //    (a different IIFE), so it stays. closeMobileInspection was only ever
  //    reached through _NBD_MODAL_CLOSE_FNS, which became registry-first on
  //    2026-09-01 — it is registry-only now.
  assert('window.openMobileInspection exposed (2c-4a cross-IIFE read)',
    /window\.openMobileInspection\s*=/.test(mainJs));
  assert('closeMobileInspection is registry-only, not on window (Tranche 3, 2026-09-01)',
    /closeMobileInspection:\s*closeMobileInspection/.test(mainJs)
      && !/window\.closeMobileInspection\s*=/.test(mainJs),
    'expected the modal-close handler to register and drop its window export');
  // 5. openMobileInspection delegates to InspectionReportEngine.openBuilder.
  assert('openMobileInspection mounts the existing InspectionReportEngine',
    /InspectionReportEngine\.openBuilder\(['"]mInspectionContainer['"]/.test(mainJs),
    'expected the mobile overlay to host InspectionReportEngine.openBuilder()');
  // 6. Desktop force-hide guard.
  assert('@media (min-width:769px) hides .m-inspection',
    /@media\s*\(min-width:\s*769px\)[\s\S]{0,400}\.m-inspection\s*\{\s*display:\s*none\s*!important/.test(dash),
    'expected desktop media query to force-hide .m-inspection');
}

section('Wave 2C.2 — Camera FAB + native share');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  const mainJs = readDashboardMain();
  // 1. Sprite has the new shutter + share glyphs.
  assert('sprite has nbd-icon-shutter',
    /<symbol id="nbd-icon-shutter"/.test(dash),
    'expected sprite symbol nbd-icon-shutter');
  assert('sprite has nbd-icon-share',
    /<symbol id="nbd-icon-share"/.test(dash),
    'expected sprite symbol nbd-icon-share');
  // 2. Camera FAB exists inside view-photos.
  const vp = dash.indexOf('id="view-photos"');
  const vpClose = dash.indexOf('<!-- ══ INSPECTION REPORT BUILDER OVERLAY', vp);
  const vpBlock = dash.slice(vp, vpClose === -1 ? vp + 8000 : vpClose);
  assert('view-photos contains the m-shutter-fab',
    /class="m-shutter-fab"[\s\S]*id="mShutterFab"/.test(vpBlock),
    'expected #mShutterFab button inside view-photos');
  // 3. Share button in mobile job-detail top bar.
  assert('mobile job-detail has #mJdShare button wired to _mJdShare',
    /id="mJdShare"[\s\S]*data-action="call" data-fn="_mJdShare"/.test(dash),
    'expected the share icon button in the mobile job-detail top bar');
  // 4. JS handler exposed.
  // Tranche 2c-4b: _mJdShare moved off window into the mobile IIFE and
  // registers in __NBD_CALL_REGISTRY (markup-dispatched, no window consumer).
  assert('_mJdShare registered in __NBD_CALL_REGISTRY and off window (2c-4b)',
    /_mJdShare:\s*_mJdShare/.test(mainJs) && !/window\._mJdShare\s*=/.test(mainJs),
    'expected _mJdShare registered and NOT window-exported');
  // 5. _mJdShare prefers navigator.share().
  assert('_mJdShare uses navigator.share when available',
    /navigator\.share\(\{\s*title:[^}]*url:\s*portal/.test(mainJs),
    'expected _mJdShare to call navigator.share() with title/text/url');
  // 6. Desktop force-hide guard for the FAB.
  assert('@media (min-width:769px) hides .m-shutter-fab',
    /@media\s*\(min-width:\s*769px\)[\s\S]{0,200}\.m-shutter-fab[\s\S]{0,80}display:\s*none\s*!important/.test(dash),
    'expected desktop media query to force-hide .m-shutter-fab');
}

section('Wave 2C.1 — Mobile create popover');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  const mainJs = readDashboardMain();
  // 1. Popover DOM + backdrop exist.
  assert('mCreatePopover element exists',
    /<div class="m-create-popover" id="mCreatePopover"/.test(dash),
    'expected <div class="m-create-popover" id="mCreatePopover">');
  assert('mCreateBackdrop element exists',
    /<div class="m-create-backdrop" id="mCreateBackdrop"/.test(dash),
    'expected the backdrop div');
  // 2. Five create rows wired (via data-action="call" data-fn="_mCreate").
  for (const kind of ['lead','photo','task','knock','note']) {
    assert('create row wires _mCreate(\'' + kind + '\') via delegate',
      new RegExp('data-action="call"\\s+data-fn="_mCreate"\\s+data-arg="' + kind + '"').test(dash),
      'missing _mCreate(' + kind + ') row');
  }
  // 3. Hidden camera-capture input present.
  assert('hidden camera input #mCreatePhotoInput with capture=environment',
    /<input type="file" id="mCreatePhotoInput"[^>]*capture="environment"/.test(dash),
    'expected hidden <input type="file" capture="environment"> for the Photo row');
  // 4. Handler exposure — split by disposition.
  //   toggleMobileCreatePopover KEEPS its window export: mCreateFabRoute, which
  //   lives outside this IIFE, calls window.toggleMobileCreatePopover.
  //   closeMobileCreatePopover was a 2c-4b MUST-STAY only because
  //   _NBD_MODAL_CLOSE_FNS dispatched it via a bare window[fnName]; that map
  //   became registry-first on 2026-09-01, so it is registry-only now.
  //   _mCreate moved to the registry in 2c-4b; openMobileCreatePopover is
  //   fully private (module-local, no export, no registry entry).
  assert('window.toggleMobileCreatePopover exposed (mCreateFabRoute, outside the IIFE)',
    /window\.toggleMobileCreatePopover\s*=/.test(mainJs));
  assert('closeMobileCreatePopover is registry-only, not on window (Tranche 3, 2026-09-01)',
    /closeMobileCreatePopover:\s*closeMobileCreatePopover/.test(mainJs)
      && !/window\.closeMobileCreatePopover\s*=/.test(mainJs),
    'expected the modal-close handler to register and drop its window export');
  assert('_mCreate registered in __NBD_CALL_REGISTRY (2c-4b, off window)',
    /_mCreate:\s*_mCreate/.test(mainJs) && !/window\._mCreate\s*=/.test(mainJs),
    'expected _mCreate registered and NOT window-exported');
  assert('openMobileCreatePopover is module-local (2c-4b PRIVATE — no window export)',
    !/window\.openMobileCreatePopover\s*=/.test(mainJs),
    'expected openMobileCreatePopover to have no window re-export');
  // 5. Center FAB routes through mCreateFabRoute (toggleMobileCreatePopover
  //    with an openLeadModal fallback). mCreateFabRoute moved OFF window in
  //    Tranche 2c-4c — it's now a module-local function registered in
  //    __NBD_CALL_REGISTRY, not window.mCreateFabRoute = function.
  assert('mobile-nav center FAB routes through mCreateFabRoute',
    /data-action="call" data-fn="mCreateFabRoute"/.test(dash) &&
    /mCreateFabRoute:\s*mCreateFabRoute/.test(mainJs),
    'expected the FAB data-fn wired + mCreateFabRoute registered in __NBD_CALL_REGISTRY');
  // 6. Desktop force-hide guard.
  assert('@media (min-width:769px) hides .m-create-popover',
    /@media\s*\(min-width:\s*769px\)[\s\S]{0,400}\.m-create-popover[\s\S]{0,100}display:\s*none\s*!important/.test(dash),
    'expected desktop media query to force-hide the popover');
}

section('Wave 2B — Mobile job-detail screen');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  const mainJs = readDashboardMain();
  // Step 4b: handleCardClick (asserted below) lives in crm-pipeline.js
  // post-split — concat via readCrm() so the assertion finds it.
  const crmJs = readCrm();
  // 1. Overlay DOM is present with the expected anchors.
  assert('m-jobdetail overlay element exists with id=mJobDetail',
    /<div class="m-jobdetail" id="mJobDetail"/.test(dash),
    'expected <div class="m-jobdetail" id="mJobDetail"...>');
  for (const id of ['mJdStatus','mJdName','mJdAddr','mJdHero','mJdStorm','mJdValue']) {
    assert('mobile job-detail has #' + id,
      new RegExp('id="' + id + '"').test(dash),
      '#' + id + ' missing from mobile job-detail');
  }
  // 2. The 5 action buttons exist.
  for (const id of ['mJdCall','mJdText','mJdEmail','mJdPhotos','mJdEstimate']) {
    assert('mobile job-detail action button #' + id,
      new RegExp('id="' + id + '"').test(dash),
      '#' + id + ' action button missing');
  }
  // 3. The 3 tabs exist.
  assert('mobile job-detail has 3 tabs (Activity/Photos/Details)',
    /data-tab="activity"[\s\S]*?data-tab="photos"[\s\S]*?data-tab="details"/.test(dash),
    'expected 3 tabs in order: activity, photos, details');
  // 4. CSS hides .m-jobdetail on desktop (≥769px).
  assert('@media (min-width:769px) hides .m-jobdetail',
    /@media\s*\(min-width:\s*769px\)\s*\{[\s\S]*?\.m-jobdetail\s*\{\s*display:\s*none\s*!important/.test(dash),
    'expected desktop media query to force-hide .m-jobdetail');
  // 5. JS hooks exposed on window.
  for (const fn of ['openMobileJobDetail','closeMobileJobDetail','openLeadDetail','_mJdSwitchTab','_mJdAct']) {
    assert('window.' + fn + ' exposed in dashboard-main.js',
      new RegExp('window\\.' + fn.replace(/_/g,'_') + '\\s*=').test(mainJs),
      'expected window.' + fn + ' to be exported');
  }
  // 6. openLeadDetail picks mobile vs desktop via matchMedia.
  assert('openLeadDetail routes via matchMedia(max-width:768px)',
    /matchMedia\(['"]\(max-width:\s*768px\)['"]\)/.test(mainJs),
    'expected matchMedia gate in openLeadDetail');
  // 7. crm.js's handleCardClick was rewired to openLeadDetail.
  assert('crm.js handleCardClick calls openLeadDetail (not openCardDetailModal directly)',
    /openLeadDetail\(id\)/.test(crmJs) && !/openCardDetailModal\(id\)/.test(crmJs),
    'expected handleCardClick to call openLeadDetail(id), removing the direct openCardDetailModal(id) call');
  // 8. Storm chip ⛈ is rendered via CSS ::before content (NBD differentiator).
  assert('mobile job-detail storm chip uses ⛈ glyph via CSS',
    /\.m-jd-storm::before\s*\{\s*content:\s*['"]⛈['"]/.test(dash),
    'expected .m-jd-storm::before with ⛈ content');
}

section('Wave 2A — Mobile chrome (nav SVG glyphs + centered FAB)');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  // 1. Sprite now ships the mobile-nav glyphs.
  for (const id of ['nbd-icon-home','nbd-icon-board','nbd-icon-plus','nbd-icon-more','nbd-icon-chat']) {
    assert('sprite has <symbol id="' + id + '">',
      new RegExp('<symbol id="' + id + '"').test(dash),
      'expected mobile-nav sprite symbol ' + id);
  }
  // 2. The bottom nav was rewritten — emoji glyphs gone.
  const navOpen = dash.indexOf('<nav id="mobile-nav">');
  const navClose = dash.indexOf('</nav>', navOpen);
  const navBlock = dash.slice(navOpen, navClose);
  for (const glyph of ['📊','🗺','👥','🤖','⋯']) {
    assert('mobile-nav no longer contains emoji glyph ' + glyph,
      !navBlock.includes(glyph),
      '#mobile-nav still has emoji ' + glyph + ' — should be SVG sprite ref');
  }
  // 3. The center "+" FAB exists.
  assert('mobile-nav has center FAB (.mn-fab) wired to a create handler',
    /class="mn-item mn-fab"[\s\S]{0,200}id="mni-create"/.test(navBlock),
    'expected an orange center "+" FAB with id="mni-create"');
  // 4. Sprite refs are present on every primary nav item.
  assert('mobile-nav primary items reference sprite via <use href="#nbd-icon-*"/>',
    (navBlock.match(/<use href="#nbd-icon-(home|board|plus|chat|more)"\/>/g) || []).length >= 5,
    'expected ≥5 sprite refs across the 5 nav items');
}

section('Pro Chrome — icon system + header consolidation');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  // 1. SVG sprite ships with the 5 chrome icons we replaced emoji with.
  for (const id of ['nbd-icon-clock','nbd-icon-bell','nbd-icon-palette','nbd-icon-gear','nbd-icon-book']) {
    assert('sprite has <symbol id="' + id + '">',
      new RegExp('<symbol id="' + id + '"').test(dash),
      'expected an inline SVG sprite symbol for ' + id);
  }
  // 2. The five .hdr-tool buttons are present and reference the sprite.
  //    Word-boundary regex so additional classes (e.g. the mobile
  //    .hdr-tools-desktop-only / .hdr-tools-mobile-only modifiers from
  //    PR #508) still count — the original literal `class="hdr-tool"`
  //    match missed any button that carried a sibling class.
  assert('global header uses .hdr-tool wrappers (≥5 instances)',
    (dash.match(/class="[^"]*\bhdr-tool\b[^"]*"/g) || []).length >= 5,
    'expected at least 5 .hdr-tool buttons in the global header');
  assert('header tools reference the sprite via <use href="#nbd-icon-*"/>',
    /<use href="#nbd-icon-(clock|bell|palette|gear|book)"\/>/.test(dash),
    'expected header buttons to <use> sprite symbols');
  // 3. The five raw-emoji glyphs the old buttons rendered must no longer
  //    appear inside the global <header>. We slice the header block and
  //    check it. (Decorative emoji elsewhere in the file — card chips,
  //    stage headers, settings tabs — are out of scope for this PR and
  //    intentionally untouched.)
  const headerOpen = dash.indexOf('<header>');
  const headerClose = dash.indexOf('</header>', headerOpen);
  const headerBlock = dash.slice(headerOpen, headerClose);
  for (const glyph of ['🕒','🔔','🎨','⚙','📖']) {
    // 🕒 = \u{1F552} clock, 🔔 = bell, 🎨 = palette,
    // ⚙ = gear, 📖 = book
    assert('header chrome no longer contains raw emoji ' + glyph,
      !headerBlock.includes(glyph),
      'global <header> still has emoji ' + glyph + ' — should be SVG sprite ref now');
  }
  // 4. The notif badge keeps working via the new .hdr-tool-badge class
  // (and may carry the .dn utility from the C.6 sweep when count=0).
  assert('notif button keeps its #notifBadge under .hdr-tool-badge',
    /<button class="hdr-tool"[^>]*id="notifBtn"[\s\S]{0,500}id="notifBadge" class="hdr-tool-badge( dn)?"/.test(dash),
    'expected #notifBadge inside the .hdr-tool#notifBtn with .hdr-tool-badge class');
  // 5. (superseded 2026-07-06) The action row used to carry ≥3
  //    .crm-hdr-sep group dividers; the one-row toolbar reduced it to
  //    three controls (Filters ▾ / Tools ⋯ / ＋ Add Lead) with no seps.
  //    The toolbar's own contracts live in the "Pipeline one-row
  //    toolbar" smoke section; here we just pin that the old sep-heavy
  //    sprawl doesn't come back.
  assert('CRM action row stays sep-free (one-row toolbar)',
    (dash.match(/class="crm-hdr-sep"/g) || []).length === 0,
    'a .crm-hdr-sep crept back into the pipeline header — the one-row toolbar has no dividers');
}

section('Sidebar customizer — hidden prefs apply at real page boot');
{
  // The customizer (dashboard-sidebar-customizer.js) ships inside the
  // lazily-hydrated tpl-view-settings template, so its own apply only runs
  // once the user first opens Settings → Appearance — saved hidden-nav
  // prefs came back on every fresh page load until then.
  // dashboard-ui-prefs-boot.js (a real, non-template <script src> that
  // executes before the sidebar markup parses) re-applies them at boot:
  // pre-paint <style> hide, then an inline-style handoff at
  // DOMContentLoaded. Contract: boot READS nbd_sidebar_hidden; the
  // customizer remains the single WRITER.
  const prefsBoot = read(path.join(PRO_JS, 'dashboard-ui-prefs-boot.js'));
  const sidebarSrc = read(path.join(PRO_JS, 'dashboard-sidebar-customizer.js'));
  const dashRaw = read(path.join(ROOT, 'docs/pro/dashboard.html'));

  // 1. The boot apply exists and reads the saved prefs.
  assert('prefs-boot reads nbd_sidebar_hidden at boot',
    /localStorage\.getItem\('nbd_sidebar_hidden'\)/.test(prefsBoot),
    'the boot script must apply saved hidden-nav prefs without waiting for the settings template to hydrate');
  // 2. Single-writer contract: boot never writes the key…
  assert('prefs-boot stays read-only on nbd_sidebar_hidden (customizer is the single writer)',
    !/(setItem|removeItem)\('nbd_sidebar_hidden'/.test(prefsBoot),
    'only dashboard-sidebar-customizer.js may write the key');
  // 2b. …and the customizer still owns the writes (a key rename there
  //     must break this pin together with the boot reader above).
  assert('customizer still owns the nbd_sidebar_hidden writes',
    /setItem\('nbd_sidebar_hidden'/.test(sidebarSrc) && /removeItem\('nbd_sidebar_hidden'\)/.test(sidebarSrc));
  // 3. Pre-paint hide + DOMContentLoaded handoff. The handoff is the
  //    part a refactor could silently drop: a leftover stylesheet rule
  //    overrides applySidebarCustomizer()'s el.style.display='' un-hide
  //    and wedges items hidden until reload.
  assert('boot hide is pre-paint with a DOMContentLoaded inline-style handoff',
    /nbdSidebarBootHide/.test(prefsBoot)
      && /readyState === 'loading'/.test(prefsBoot)
      && /st\.remove\(\)/.test(prefsBoot),
    "the injected <style> must be swapped for inline display:none and removed once the DOM is ready");
  // 4. The boot script ships as a real script tag OUTSIDE (before) the
  //    lazy settings template — inside it, the fix would not fix anything.
  assert('dashboard.html loads prefs-boot before tpl-view-settings',
    dashRaw.indexOf('js/dashboard-ui-prefs-boot.js') !== -1
      && dashRaw.indexOf('js/dashboard-ui-prefs-boot.js') < dashRaw.indexOf('id="tpl-view-settings"'),
    'the boot apply only fixes the reload gap if the script executes at real page boot');
}

section('Rock 4 Phase 3 — view-storm lazy hydration');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();
  // 1. The active view DIV is now an empty mount carrying the template ref.
  assert('view-storm is an empty mount div with data-view-template',
    /<div class="view" id="view-storm" data-view-template="tpl-view-storm"><\/div>/.test(dash),
    'expected: <div class="view" id="view-storm" data-view-template="tpl-view-storm"></div>');
  // 2. The original markup lives inside a <template> sibling.
  assert('tpl-view-storm template exists with stormCenterContainer inside',
    /<template id="tpl-view-storm">[\s\S]*?id="stormCenterContainer"[\s\S]*?<\/template>/.test(dash),
    'expected <template id="tpl-view-storm"> wrapping the original view markup');
  // 3. The hydration helper is defined.
  assert('_hydrateViewTemplate helper defined in dashboard-main.js',
    /function _hydrateViewTemplate\(name\)/.test(mainJs),
    'expected function _hydrateViewTemplate(name) in dashboard-main.js');
  // 4. goTo() calls the helper before the view-active update.
  assert('goTo() calls _hydrateViewTemplate(name) before reading view-' + 'name',
    /_hydrateViewTemplate\(name\)[\s\S]{0,400}document\.getElementById\(['"]view-['"]\+name\)/.test(mainJs),
    'expected _hydrateViewTemplate(name) to run before the view-active update');
}

section('Hardening 2026-06-09 — settings-tab renderers (post-#597 live surface)');
{
  // PR #597's readyState-guard fix made the Settings-tab renderers run
  // for the first time. This section pins the two bug classes that
  // became reachable with them:
  //  1. XSS hardening — dashboard-team-tab.js renders Firestore member
  //     docs (semi-external strings) into innerHTML. Every member field
  //     must round through the file's _nbdEscHtml escaper.
  //  2. CSP — the /pro/ header ships script-src-attr 'none', so JS-built
  //     markup carrying an inline on*-handler attribute renders dead
  //     controls (same class as the C-1 saveLead no-op). The settings
  //     shards must use the data-on-change delegate, and the handler
  //     names must be on _NBD_CALL_ALLOWLIST or the delegate silently
  //     ignores them.
  const teamSrc = read(path.join(PRO_JS, 'dashboard-team-tab.js'));
  const sidebarSrc = read(path.join(PRO_JS, 'dashboard-sidebar-customizer.js'));
  const hotkeySrc = read(path.join(PRO_JS, 'dashboard-hotkey-toggles.js'));
  const billingSrc = read(path.join(PRO_JS, 'dashboard-billing-tab.js'));
  const stateSrc = read(path.join(PRO_JS, 'dashboard-state.js'));

  // 1a. The escaper exists (widgets.js esc() is IIFE-scoped and
  //     unreachable from this hydrated-template script).
  assert('dashboard-team-tab.js defines the _nbdEscHtml escaper',
    /function _nbdEscHtml\(/.test(teamSrc),
    'member rows render Firestore strings into innerHTML; the file must define its own escaper');
  // 1b. Both email interpolations (row line + avatar initial) escape.
  assert('team rows escape m.email through _nbdEscHtml',
    /_nbdEscHtml\(m\.email\s*\|\|\s*''\)/.test(teamSrc)
      && /_nbdEscHtml\(\(m\.email\s*\|\|\s*'\?'\)\[0\]/.test(teamSrc),
    'both the email line and the avatar initial must be escaped');
  // 1c. Role (both interpolations) + status escape. Status renders via
  // statusLabel (derived from m.status; may read 'invite expired' past the
  // 30-day TTL) — still tenant data, still must pass through the escaper.
  assert('team rows escape m.role and m.status through _nbdEscHtml',
    (teamSrc.match(/_nbdEscHtml\(\(m\.role\s*\|\|\s*'rep'\)/g) || []).length >= 2
      && /_nbdEscHtml\(statusLabel\)/.test(teamSrc)
      && /statusLabel = inviteExpired \? 'invite expired' : \(m\.status \|\| 'invited'\)/.test(teamSrc),
    'role renders twice (meta line + badge) and statusLabel once; all three must be escaped');
  // 1d. No raw member-field concatenation survives.
  assert('no unescaped member-field interpolation remains in team rows',
    !/\+\s*\(m\.(email|role|status)/.test(teamSrc),
    'every "+ (m.<field>" concatenation must be wrapped in _nbdEscHtml(...)');

  // 2a. Zero inline handler attributes in any of the four settings shards.
  [['dashboard-team-tab.js', teamSrc],
   ['dashboard-sidebar-customizer.js', sidebarSrc],
   ['dashboard-hotkey-toggles.js', hotkeySrc],
   ['dashboard-billing-tab.js', billingSrc]].forEach(function(pair) {
    assert(pair[0] + " has zero inline on*-handler attributes (script-src-attr 'none')",
      !/\son(click|change|input|submit|load|error|focus|blur)\s*=/.test(pair[1]),
      'inline handler attributes are CSP-dead on /pro/ — use the data-on-change / data-action delegates');
  });
  // 2b. The two checkbox grids ride the delegate with the checked+arg shape.
  assert('sidebar-customizer checkboxes use the data-on-change delegate',
    /data-on-change="toggleSidebarItem" data-on-pass="checked" data-on-arg="/.test(sidebarSrc),
    'expected data-on-change="toggleSidebarItem" data-on-pass="checked" data-on-arg="<nav id>"');
  assert('hotkey-toggles checkboxes use the data-on-change delegate',
    /data-on-change="toggleHotkey" data-on-pass="checked" data-on-arg="/.test(hotkeySrc),
    'expected data-on-change="toggleHotkey" data-on-pass="checked" data-on-arg="<hk id>"');
  // 2c. Delegate handlers are allowlisted (missing entry = silent no-op).
  assert('toggleSidebarItem + toggleHotkey are on _NBD_CALL_ALLOWLIST',
    /'toggleSidebarItem'/.test(stateSrc) && /'toggleHotkey'/.test(stateSrc),
    'the data-on-change delegate ignores names missing from the allowlist (C-1 class)');
  // 2d. Their handler signatures match the delegate call shape (checked, id).
  assert('toggleSidebarItem signature matches delegate (on, navId)',
    /function toggleSidebarItem\(on, navId\)/.test(sidebarSrc));
  assert('toggleHotkey signature matches delegate (on, id)',
    /function toggleHotkey\(on, id\)/.test(hotkeySrc));
}

section('Routing: no relative bare-.html nav on /pro pages (404 footgun)');
{
  // A /pro page is served at a canonical clean URL (/pro/customer), so a
  // relative `href="dashboard.html"` or `location.href='dashboard.html'`
  // resolves against the current path (+ a .html→clean redirect hop) and can
  // 404 (the customer→dashboard 404, PR #771). All /pro inter-page nav must be
  // absolute canonical (/pro/<page>). This guard keeps the class from recurring.
  const PRO_DIR = path.join(ROOT, 'docs/pro');
  // Matches href=/location nav whose target is a BARE word.html (relative).
  // Absolute "/pro/foo.html" and "https://…" don't match (the char after the
  // quote is "/" or the word is followed by ":", not ".html").
  const RELN = /(?:href=|location(?:\.href)?\s*=\s*|location\.(?:assign|replace)\(\s*)["'][a-z0-9_-]+\.html/g;
  const offenders = [];
  for (const dir of [PRO_DIR, PRO_JS]) {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(html|js)$/.test(f)) continue;
      const hits = read(path.join(dir, f)).match(RELN);
      if (hits) offenders.push(f + ' (' + hits.slice(0, 2).join(', ') + ')');
    }
  }
  assert('no relative bare-.html nav on /pro (use absolute /pro/<page>)',
    offenders.length === 0, offenders.join(' | '));
}


section('Ops P1 #4 — loadLeads completeness + kanban render cap');
{
  const boot = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
  // Stage A contract: the fetch pages by documentId and keeps going until
  // a short page — window._leads stays COMPLETE. 11 consumers (KPIs, money
  // dashboard, search, export, forecasting, ROI) compute over the cache
  // and would silently under-report if a fetch cap were introduced. Do not
  // page-and-stop without migrating those consumers to server aggregates.
  assert('loadLeads pages with limit(_PAGE) + startAfter', /startAfter\(cursor\)/.test(boot) && /limit\(_PAGE\)/.test(boot));
  assert('loadLeads drains ALL pages (breaks only on short page)', /pageSnap\.size < _PAGE/.test(boot));
  assert('loadLeads runaway guard present (page cap)', /page < 200/.test(boot));

  const pipe = read(path.join(PRO_JS, 'crm-pipeline.js'));
  // Render cap: the DOM paint is bounded even though the cache is not.
  assert('kanban render cap defined', /KANBAN_RENDER_CAP = \d+/.test(pipe));
  assert('both column render paths use renderColumnCards',
    (pipe.match(/renderColumnCards\(body, cards, stage/g) || []).length >= 2,
    'expected the new-stage AND legacy paths to route through the capped renderer');
  assert('show-all expander mounts the remainder', /k-show-all/.test(pipe) && /_kbShowAll\[stageKey\] = true/.test(pipe));
  // Column counts/$ totals must keep computing from the FULL array, not the slice.
  assert('column count uses full cards array', /count\.textContent = cards\.length/.test(pipe));
}

// ── Globals refactor Tranches 0+1 (2026-07-05) — provably-private globals off window ──
// Tranche 0: 40 one-global self-registering widgets moved their API objects
// to module scope; double-load idempotency moved from per-widget window
// objects (__sentinel convention) to one shared window.__NBD_LOADED registry
// keyed by file slug. Tranche 1: repo-wide safe frontier — 18 vestigial
// window.X = X alias exports deleted, 47 single-assignment globals (mostly
// bind-once _NBD_*_DELEGATE flags) made module-local, 13 of them deleted
// outright as write-only dead exports. Every name passed the three-way
// proof (no external refs incl. tests, no in-string refs in own file, not
// window[fnName]-dispatchable). These names must never be reassigned onto
// window — that silently re-grows the surface the tranches removed. See
// docs/dev/dashboard-decomposition-plan.md, caveat 4 execution plan.
section('Globals Tranches 0+1: converted names stay off window');
{
  const T1_NAMES = [
    // Tranche 2c-2 (2026-07-06): the maps-routing.js drawing-tool call
    // cluster — the whole file is IIFE-wrapped now; these 21 handlers
    // are module-scoped and dispatched via __NBD_CALL_REGISTRY (see the
    // "Globals Tranche 2c" section below for wiring guards). NOT here:
    // goToMyLocation (still window[fnName]-dispatched via dashboard.html's
    // "My Location" button, data-fn="goToMyLocation", not yet registered —
    // maps.js's OWN bare re-export of it was deleted 2026-09-17, T3-B; this
    // is the independent, still-live reason it stays allowlisted) and the
    // file's deliberate window exports
    // (initDrawMap, selLT, setDrawMode, the toggle/close-map targets, …).
    'acceptAutoDetect', 'addStructure', 'applySmartWaste',
    'cancelAutoDetect', 'exportXactimateESX', 'generateScopeFromDrawing',
    'handleComparisonFile', 'loadDrawingFromCustomer', 'openComparisonMode',
    'recalc', 'runSolarAnalysis', 'saveDrawingToCustomer', 'screenshotMap',
    'setHistoricalLayer', 'showAngles', 'showMaterialTakeoff',
    'startAutoDetect', 'startPresentation', 'startShadowPitch',
    'updateHistoryOpacity', 'zoomToFit',
    // Tranche 2c (2026-07-06): the dashboard-ui-prefs-boot.js call
    // cluster — module-scoped, dispatched via __NBD_CALL_REGISTRY
    // (see the "Globals Tranche 2c" section below for wiring guards).
    'nbdSetSize', 'nbdApplyLegacyFont', 'toggleProfessionalMode',
    'nbdSetSidebarLabels', 'nbdGxSetEnabled', 'nbdGxSetGlow',
    'nbdGxSetAnimatedBg', 'nbdGxSetAccent', 'nbdGxSetIntensityFromSlider',
    'nbdOverlaysSetEnabled', 'nbdSoundsSetEnabled', 'nbdComfortSetMotion',
    'nbdComfortSetProMode', 'nbdComfortSetCbSafe', 'nbdComfortSetAutoTheme',
    'nbdSetCrmSecHeaderEnabledT', 'nbdSetKanbanBoldHierarchyT',
    'nbdSetCrmAutoCollapseT', 'nbdSelectPhotoLead', 'nbdTogglePhotosOnly',
    'd2dSetDispoFilter', 'nbdSettingsUpdateCalcomPreview',
    // Tranche 3 T3-C (2026-09-18): prefs-boot's size-button repaint hook
    // (ui.js switchSettingsTab's only window read of this file) joined the
    // same registry block. showToast/nbdRenderFontGrid stay window exports.
    'nbdSyncSizeBtns',
    // Tranche 3 T3-C (2026-09-18), same PR: the two lazy 'estimates'-bundle
    // render aliases (product-library.js / job-templates-ui.js → dashboard-
    // actions.js goTo fallbacks) and dashboard-insurance-overlay-toggle.js's
    // one name (whole 7-line file IIFE-wrapped; #estMode data-on-after +
    // dashboard-widgets.js viewEstimate). See the T3-C assertion block below.
    'renderProductLibrary', 'renderJobTemplatesLibrary', 'toggleInsuranceOverlay',
    // Tranche 2c-3 (2026-07-07): the crm-portal-bridge.js bulk-ops /
    // deleted-drawer / delete-confirm markup handlers — module-scoped now
    // (whole file IIFE-wrapped), dispatched via __NBD_CALL_REGISTRY. NOT
    // here: clearBulkSelection (lead-snooze.js calls it directly on window —
    // MUST-STAY, allowlisted like goToMyLocation) and this file's deliberate
    // window re-exports (editLead, deleteLead, showDeleteConfirm,
    // toggleCardSelection, updateBulkToolbar, restoreCrmSearch,
    // refreshTrashBadge; closeDeletedDrawer graduated off window in the
    // Tranche 3 dispatch-map slice, 2026-09-02; exitBulkMode, toggleBulkMode
    // and scrollToFollowUps in T3-C, 2026-09-18 — see the next group).
    'selectAllVisibleLeads', 'openDeletedDrawer', 'confirmDeleteLead',
    'cancelDeleteConfirm', 'bulkSnoozeLeads', 'bulkMoveStage', 'bulkDelete',
    'bulkAssignSource', 'bulkAssignJobType', 'bulkAssignDamage', 'bulkAssignCarrier',
    // Tranche 3 T3-C (2026-09-18): the bulk-mode / follow-ups / analytics
    // edge. crm-portal-bridge.js registers exitBulkMode (dashboard-actions.js
    // goTo), toggleBulkMode (lead-snooze.js + the _NBD_TOGGLE_FNS.bulkMode
    // map, registry-first) and scrollToFollowUps (analytics-kpi.js delegate);
    // analytics-kpi.js registers renderDoorsVerifiedCard and smart-calendar.js
    // registers loadSmartCalendar (both read by dashboard-bootstrap.module.js;
    // loadSmartCalendar also left the allowlist — its data-fn resolves
    // registry-first). See the T3-C bulk/follow-ups assertion block below.
    'exitBulkMode', 'toggleBulkMode', 'scrollToFollowUps',
    'renderDoorsVerifiedCard', 'loadSmartCalendar',
    // Tranche 2c-4a (2026-07-07): the dashboard-actions.js card-detail cluster
    // — 18 cda* / chip-picker / mobile photo-picker wrappers consolidated into
    // one IIFE and dispatched via __NBD_CALL_REGISTRY (see the "Globals Tranche
    // 2c" section below). NOT here: the file's MUST-STAY names (goTo router,
    // zone-draw, openLeadDetail, _mJdSwitchTab, the mobile close-* handlers)
    // which stay window-exported — see docs/dev/dashboard-actions-globals-
    // audit.md. **Correction 2026-09-18**: this "MUST-STAY" list was already
    // stale before today — _mJdSwitchTab graduated off window in a LATER
    // tranche (see its own entry below) despite still being named here.
    // viewProspectOnMap (plus confirmPromoteProspect/toggleProspectHidden/
    // absoluteDeleteProspect, the rest of the prospect-ops cluster it shipped
    // alongside) also graduated today (Tranche 3 T3-A) — see that section.
    'cdaReport', 'cdaEnrich', 'cdaPhotos', 'cdaInvoice', 'cdaInspection',
    'cdaInspectionDeep', 'cdPickStage', 'cdPickType', 'cdaMjdAct', 'cdaEditLead',
    'cdaOpenMobileInspection', 'cdaVoiceMemo', 'cdaOpenVoicemail',
    'cdaSharePortalLink', 'cdaRevokePortalLink', 'cdaConfirmPromote',
    'cdaOpenTaskModal', '_mCreatePhotoPicked',
    // Tranche 2c-4b (2026-07-07): the dashboard-actions.js mobile create/
    // job-detail cluster is IIFE-wrapped; these three lost their window export
    // (markup→registry for _mJdShare/_mCreate; openMobileCreatePopover is
    // private). NOT here: the 5 remaining MUST-STAY window re-exports
    // (_mJdSwitchTab, _mJdAct, openMobileInspection, toggleMobileCreatePopover,
    // openLeadDetail) — each read cross-IIFE or by a bare caller.
    '_mJdShare', '_mCreate', 'openMobileCreatePopover',
    // Tranche 3 dispatch-map slice (2026-09-01): these two WERE on that
    // MUST-STAY list, for one reason only — _NBD_MODAL_CLOSE_FNS dispatched
    // them through a bare window[fnName], which a module-scoped function is
    // invisible to. dashboard-ui.js's _nbdResolveMapped checks
    // __NBD_CALL_REGISTRY first now, so they are registry-only. They belong in
    // THIS list (a docs/-wide walk) and not only in the narrower
    // dashboard-actions.js pin, or a re-export added in some other file under
    // docs/ would go unnoticed.
    'closeMobileInspection', 'closeMobileCreatePopover',
    // Tranche 2c-4c (2026-07-07): the 20 one-off compound-rewrite openers in
    // dashboard-actions.js (incl. the two 2c-4b mobile-routing tail names
    // mCreateFabRoute/mQuickAddRoute) moved OFF window into one in-file IIFE,
    // dispatched via __NBD_CALL_REGISTRY. All markup-only — none re-exported.
    'openDailyProgramFromMore', 'mCreateFabRoute', 'mQuickAddRoute',
    'restartOnboardingTour', 'openDecisionPicker', 'openD2DOrGo',
    'clearAccentTheme', 'openSettingsTab', 'openPhotoEngineOrClickProxy',
    'openReportGenerator', 'enrichReportData', 'openPhotoEngineCurrentLead',
    'openInspectionBuilderCurrentLead', 'closeInspectionBuilder',
    'hideFollowUpAlerts', 'goToD2DFromMaps', 'openCalBookingUrl',
    'hardResetTest', 'gstaticTest', 'modeLineDraw',
    // Tranche 2c-4d (2026-07-07): daily-program ds* cluster IIFE-wrapped. These
    // 6 are off window (3 registered + 3 private). NOT here: dsRemoveFloor
    // (keeps window.dsRemoveFloor — dashboard-ui.js:2208 bare call).
    'dsGetConfig', 'dsLoadConfig', 'dsDefaultFloors',
    'dsAddFloor', 'dsSaveConfig', 'dsResetDefaults',
    // Tranche 2c-4e (2026-07-07): customer-page handoff cluster IIFE-wrapped.
    // The 4 openers are off window (registered). NOT here:
    // _stashLeadForCustomerPage (keeps window export — 7 widget callers).
    'openPhotosForLead', 'openDocsForLead', 'openFullCustomerDetails',
    'editCardDetails',
    // Tranche 2b (2026-07-06): widgets.js radar-map handle + task
    // checkbox handler (delegate calls the bare fn), tasks.js checkTask
    // export (only caller is its own data-tk-action delegate).
    '_wRadarMap', '_wToggleTask', 'checkTask',
    'dismissNotification', 'notifAction',
    'renderDismissedNotifications', 'renderNotifications',
    'restoreNotification', 'showShortcutsHelp', 'closeHdrMobileMenu',
    'restoreCrmSecondary', 'seedDemoEstimates', '$id', 'nbdIcon',
    '_deleteTask', '_loadTasks', '_saveTask', '_toggleTask',
    'renderTodayTasks', 'toggleTodayTask', 'handleQMDrop',
    '_di', '_NBD_BG_DELEGATE', 'isClaudeProxyAvailable',
    'nbdCopyToClipboard', '_dismissedNotifications',
    'toggleCustomerPhotoReorder', '_galleryUrl', 'removeDocFromQueue',
    '_NBD_CP_DELEGATE', '_NBD_DA_DELEGATE', 'firebase_onAuthStateChanged',
    '_bootStartedAt', 'nbdDiag', '_NBD_DW_DELEGATE',
    '_NBD_DG_DELEGATE_BOUND', '$addClass', '$html', '$removeClass',
    '$text', '$val', 'nbdSafeHTML', 'nbdSetText', '_NBD_ES_DELEGATE',
    'calculateEstimateV2', '_NBD_EST_DELEGATE', '_NBD_IC_DELEGATE',
    '_NBD_IP_DELEGATE_BOUND', '_NBD_MO_DELEGATE_BOUND',
    '_NBD_MR_DELEGATE_BOUND', '_presentSteps', '_NBD_MP_DELEGATE',
    '__NBD_SENTRY_BOOTSTRAPPED', '_NBD_NC_DELEGATE', '__NBD_EMU_LOGGED',
    '_NBD_PT_DELEGATE', '_NBD_PI_DELEGATE', '_NBD_SC_DELEGATE', 'nbdAlert',
    '_NBD_TK_DELEGATE', '_NBD_VM_DELEGATE', '_NBD_WIDGETS_DELEGATE_BOUND',
    '_wAddTask', '_wAskJoe', '_wMiniHeat', '_wQuickAddLead', '_wQuickDraw',
    '_wQuickEst',
    // Tranche 1b — the 7 deferred multi-assign state vars, now converted:
    '_searchQuery', '_notifDropdownOpen', '_dismissedDrawerOpen',
    '_lightboxIndex', '_perimClosing', '_needsAttentionActive',
    'handleQMFile',
    // Tranche 2a — mobile-nav-customizer delegate-then-scope rewrite:
    '_ncmAddTab', '_ncmRemoveTab', '_ncmSave', '_ncmReset', '_ncmClose',
    '_ncmDragStart', '_ncmDragOver', '_ncmDrop', '_ncmDragEnd',
    '_ncmTouchStart', '_ncmTouchMove', '_ncmTouchEnd',
    'openNavCustomizer', '_NBD_MNC_DELEGATE_BOUND',
    // Tranche 2b — email_system + crm-snooze own-file-wired remnants:
    'openEmailModal', 'closeEmailModal', 'emailEstimatePDF',
    'emailFollowUp', '_emailAttachment', '_emailContext', '_emailLeadId',
    '__NBD_COMM_LOG_DELEGATE', '_notifUnsub', 'loadNotifications',
    // Tranche 2c-4g (2026-07-08): dashboard-ui.js leaf comfort/kanban handlers —
    // `function X` → `const X` + __NBD_CALL_REGISTRY. NOT here: setKanbanDensity /
    // setPhotoMode / nbdComfortSet (MUST-STAY — auto-global backing and/or real
    // cross-file consumers; keep allowlist + window export).
    'cycleKanbanDensity', 'nbdComfortSetWhisperHotkey', 'nbdComfortSetWhisperKey',
    // Tranche 2c-4h (Slice H1, 2026-07-08): the 9 dashboard-ui.js cal/photo/
    // template leaf handlers — `function X` → `const X` + __NBD_CALL_REGISTRY.
    // Each lived only in dashboard-ui.js with zero cross-file callers.
    'saveCalSettings', 'updateCalEmbed', 'copyCalLink', 'shareCalViaSMS',
    'shareCalViaEmail', 'filterPhotoLeads', 'tlToggleCat', 'tlFilterCat',
    'handleDocUpload',
    // Tranche 2c-4h (Slice H2, 2026-07-08): 6 entangled dashboard-ui.js names —
    // single-defined here but forward-ref re-exported by maps.js + dashboard-
    // actions.js (those shims removed this slice). `function X` → `const X` + registry.
    'spyglassSearch', 'spyglassGoToLocation', 'fabToggle', 'quickStormCheck',
    'openUploadDoc', 'printDoc',
    // Tranche 3 T3-A (2026-09-18): dashboard-ui.js whole-file IIFE wrap. These
    // 21 function declarations were window globals only because the file was
    // an unwrapped classic script. Nothing outside the file reaches them, so
    // the wrap made them private with no export. NOT here: the 15 names the
    // file exports explicitly (outside consumers or the snapshot test seam),
    // showToast (the legacy duplicate was deleted; ui.js owns the global),
    // and the four zero-consumer explicit exports nbdComfortRefresh and
    // nbdAutoThemeStart/Stop/ApplyForNow, left byte-identical.
    // initAllAutocomplete joined 2026-09-22: its last window write was a dead
    // spyglass wrapper (it never ran; nothing called window.initAllAutocomplete),
    // deleted then. The file boots it with a bare, file-private call.
    'initAllAutocomplete',
    '_nbdResolveCall', '_nbdOnChangeDelegate', '_calSignOff', 'openTips',
    'initAddressAutocomplete', '_abbreviateRoadSuffix', '_state2letter',
    'selectAcItem', '_nbdRepName', '_nbdDocCompany', 'openDocTemplate',
    'loadSavedTheme', 'syncKanbanPrefControls', 'nbdAutoThemeIsDay',
    'nbdAutoThemePreferredFor', '_nbdRememberManualTheme',
    '_isCrmAutoCollapseOn', 'goToWithTheme', 'dsPickTheme', 'syncMobileBadge',
    'applyCrmSecHeaderState',
    // Tranche 2c-4h (Slice H2 part 2, 2026-07-08): the 4 property-intel twins —
    // byte-identical dupes in dashboard-ui.js + property-intel.js; dashboard-ui.js
    // copies DELETED, property-intel.js owns + registers them.
    'pullIntelForModal', 'updatePropertyIntelCost', 'confirmPropertyIntelPull',
    'executePullPropertyIntel',
    // Tranche 2c-4f (2026-07-07): dashboard-bootstrap.module.js settings/debug/
    // export handlers — module-scoped (real ES module, no IIFE), dispatched via
    // __NBD_CALL_REGISTRY. NOT here (MUST-STAY window exports): loadSampleData
    // (owned by dashboard-actions.js — the module's shadowed twin was deleted
    // 2026-09-22), _saveEstimateDefaultsV2 (self-read).
    'runLeadAction', 'retryLoadLeads', 'copyDebugInfo', 'testFirestoreRules',
    '_saveSettings', '_saveNotifSettings', '_saveCompanySettings', '_testNotif',
    '_resetEstimateDefaultsV2', '_saveSiteSlug', '_saveCompanyProfileSettings',
    '_resetCompanyProfileSettings', '_exportAllData', '_exportEstimates',
    '_exportPhotos',
    // Tranche 3 T3-C (2026-09-17): the settings-tab loader sextet graduated
    // off window into the same __NBD_CALL_REGISTRY block — switchSettingsTab's
    // bare window.X() reads in ui.js were rewired to read the registry instead.
    '_loadCompanySettings', '_loadCompanyProfileSettings', '_loadAccessInfo',
    '_loadBillingInfo', '_loadNotifSettings', '_loadProfileSettings',
    // Tranche 3 T3-C (2026-09-18): the sextet's deferred 7th — its two
    // in-module callers now call it directly — plus its zero-reader
    // _loadEstimateDefaults alias, deleted rather than kept on window.
    '_loadEstimateDefaultsV2', '_loadEstimateDefaults',
    // Tranche 3 slice T3-0 (2026-08-31): the shim-blocked residual — the
    // dashboard-actions.js zone cluster + damageNearMePhotos, IIFE-scoped and
    // dispatched via __NBD_CALL_REGISTRY. maps.js's six re-exports are gone.
    // NOT here: renderSavedZones (a real cross-file API — maps-core.js and
    // dashboard-bootstrap.module.js both invoke it off window).
    'selectZoneColor', 'startZoneDraw', 'cancelZoneDraw', 'saveZone',
    'deleteZone', 'damageNearMePhotos',
    // Tranche 3 dispatch-map slice (2026-09-02): the T3-M-freed dashboard-ui
    // band + the property-intel twin pair — top-level consts registered in
    // their owning file's __NBD_CALL_REGISTRY block, dispatched only through
    // the two name-string maps. Any re-export under docs/ fails this walk.
    'toggleHdrMobileMenu', 'toggleKanbanFullscreen', 'toggleSidebarCollapse',
    'closePhotoModal', 'closeDocViewer', 'closeTips',
    'closePropertyIntelModal', 'closePropertyIntelConfirmModal',
    // Slice 2 (2026-09-02): the maps-routing band of six, same conversion.
    'toggleDraw', 'toggleMapLayer', 'toggleHistoricalImagery',
    'toggleVoiceControl', 'closeComparisonMode', 'closeHistoricalImagery',
    // Slice 3 (2026-09-02): the crm-portal-bridge singleton.
    'closeDeletedDrawer',
    // The bonus eight (2026-09-02, same evening): the map-only names the
    // "still blocked (19)" ledger overcounted, registry-only across six
    // owner files. crm.js's needed the auto-global→const conversion; every
    // stale window-qualified comment was scrubbed in the same commit (the
    // walk scans comments — the :3883 lesson).
    'toggleDebugConsole', 'toggleRecentDropdown', 'toggleDismissedNotifications',
    'toggleNotificationDropdown', 'toggleNeedsAttention', 'toggleShowSnoozed',
    'toggleStaleShares', 'toggleEngagementSort',
    // Tranche 3 T3-C (2026-09-17): the crm-portal-bridge.js edge (5) and the
    // rep-report-generator.js edge (4 of the 5 verified names — _reports is
    // a data cache, not a callable, deliberately left off window via a
    // rep-report-generator.js-local cache instead of a registry entry; see
    // the T3-C assertion block below). None of these 9 were ever
    // markup-dispatched or allowlisted — a straight window-export-to-
    // registry graduation for real ES-module-to-classic-script calls.
    'toggleInsuranceFields', 'refreshSubTypeAndTrades', 'setSelectedTrades',
    '_deleteLead', '_loadDeletedLeads',
    '_saveReport', '_deleteReport', '_loadReports',
    // Tranche 3 T3-C (2026-09-18): the customer-bootstrap.module.js ->
    // customer-tasks-ui.js edge (customer.html has no dashboard-bootstrap.
    // module.js, so this is the first use of __NBD_CALL_REGISTRY on that
    // page). _bookingAsk/_bookingCustomerName/_bookingUrl/_currentStage were
    // also candidates but are shared DATA, not callables — stay on window,
    // same reasoning as _reports above; see the T3-C assertion block below.
    '_fetchPhotosRaw', 'loadPhotos', 'setLightboxSource', '_nbdTsToDate',
    // Tranche 3 T3-C (2026-09-18, T3-5): the same owner's
    // customer-quick-action-bar.js edge — the QAB's Comm Log tap listener.
    'logCommunication',
    // Tranche 3 T3-C (2026-09-18, T3-5): the reverse direction, owner
    // customer-tasks-ui.js — possible only after #1657's whole-file IIFE wrap
    // (before it, a top-level declaration auto-globalled regardless). None is
    // markup-dispatched, so _nbdCustomerActionDispatch never walks to them.
    'renderCoverHero', 'loadPhotosByPhase', 'loadNewPortalSections',
    'setupContactTab', 'loadCommunicationLog', 'logGeneratedDoc',
    // Tranche 3 T3-C (2026-09-18): two single-name edges outside the
    // dashboard shell — photo-report.js -> customer-photo-report-picker.js
    // (rename-on-register: _reportOptions registered as _photoReportOptions)
    // and pro-analytics.js -> pro-analytics-gate.js (the first registry use
    // on analytics.html). See the T3-C assertion block below.
    '_photoReportOptions', 'bootAnalytics',
    // Tranche 3 T3-C (2026-09-18): the pins + zones CRUD edges off
    // dashboard-bootstrap.module.js — maps-overlays.js's dropPin/deletePin
    // and dashboard-actions.js's saveZone/deleteZone. _zones (a loaded-zones
    // cache) and _DASH_DOC_PREREQUISITES (a static config object) were also
    // candidates but are DATA, not callables — stay on window.
    '_savePin', '_deletePin', '_saveZone', '_deleteZone',
    // Tranche 3 T3-C (2026-09-18): the mobile doc-picker edge off
    // dashboard-bootstrap.module.js, consumed by dashboard-actions.js's
    // _mJdOpenDocCreate/_mJdPickDocType. Its data sibling
    // _DASH_DOC_PREREQUISITES stays on window (see above).
    '_generateDocWithPreflight',
    // Tranche 3 T3-C (2026-09-18): the estimate CRUD edge off
    // dashboard-bootstrap.module.js, consumed by estimate-crm-ops.js.
    // _duplicateEstimate was NOT a candidate (multiple consumers).
    '_deleteEstimate', '_renameEstimate', '_assignEstimateToLead',
    // Tranche 3 T3-C (2026-09-18): the crm-leads.js edge off
    // dashboard-bootstrap.module.js. Zero HTML hits, zero prior test
    // coverage on either name.
    'filterStageDropdownByJobType', 'getSelectedTrades',
    // ...and refreshStageOptions, the same edge's third name (openLeadModal's
    // stage <select> rebuild), converted in a later PR.
    'refreshStageOptions',
    // Tranche 3 T3-C (2026-09-18): the warranty-claim.js edge. All three
    // are crm-stages.js imports bridged to a classic script; the "expose
    // to crm.js" comment nearby was stale for these two specifically —
    // warranty-claim.js is the real, sole consumer. Also loaded on
    // customer.html, where all 3 call sites were already guarded and
    // degrade gracefully — unchanged by this migration.
    'missingClaimFields', 'subTypeLabel', 'subTypeOptionsFor',
    // Tranche 3 T3-C (2026-09-18): the pipeline-builder.js edge. STAGE_ROLE
    // is a rename-on-export (imported as ROLE, registered as STAGE_ROLE).
    'applyPipelineConfig', 'resolvePipelineConfig', 'STAGE_ROLE',
    // Tranche 3 T3-C (2026-09-18): the crm-pipeline.js edge — another
    // crm-stages.js import bridge, sole consumer renderLeads. crm-pipeline.js's
    // _dragId implicit global is deliberately untouched.
    'partitionLeadsByColumn',
    // Tranche 3 T3-C (2026-09-18): the dashboard-widgets.js photo modal edge.
    '_uploadPhoto', '_getPhotos',
    // Tranche 3 T3-C (2026-09-18): the dashboard-actions.js -> dashboard-
    // widgets.js Messages/Voice-Intel teardown edge. Already a real
    // declaration (not an expression) inside dashboard-actions.js's
    // customer-detail-action-bar IIFE — only the redundant window export
    // line and the registry entry changed.
    '_mJdTeardownRealtimeTabs',
    // Tranche 3 T3-A (2026-09-18): the prospect-ops cluster, newly
    // IIFE-wrapped (not just re-registered within an existing IIFE like
    // every other T3-C entry above). confirmPromoteProspect's allowlist
    // entry (dashboard-state.js) also removed — see the dedicated
    // assertion block below.
    'confirmPromoteProspect', 'toggleProspectHidden', 'viewProspectOnMap',
    'absoluteDeleteProspect',
    // Tranche 3 T3-A (2026-09-18): dashboard-connect-tab.js, the session's
    // first WHOLE-FILE IIFE wrap. renderConnectCard/loadConnectStatus were
    // explicit window exports (now registry-only); the file's other 11
    // functions were already implicit top-level auto-globals with no
    // explicit window.X= line, so this regex walk was never able to catch
    // them either way — see the dedicated IIFE-wrap structural assertion
    // block below for that proof.
    'renderConnectCard', 'loadConnectStatus'];
  const NAMES = [...T1_NAMES, 'ActivityFeed', 'AlmostThere', 'AskJoeProactive',
    'CustomerAiDraftsPanel', 'CustomerDnDUpload', 'CustomerLastSharedChip',
    'CustomerQuickActionBar', 'CustomerSiblingSnooze',
    'CustomerSmartFollowupPanel', 'CustomerSnoozeBanner', 'CustomerViewedChip',
    'DataExport', 'EngagementCohortWidget', 'GlobalSearch', 'HotLeads',
    'LeadImport', 'NBDFabStackCoordinator', 'NBDLeadAlert', 'NBDLeadScorePanel',
    'NBDOfflineBanner', 'NBDPush', 'NBDPwaInstall', 'NBDReportsDashboard',
    'NBDReportsTrends', 'NBDSig', 'NBDSupplementUI', 'NBDThemeAudit',
    'NBDWhatsNew', 'NBD_ICONS', 'NbdAiPersona', 'NeedsAttention', 'NotifBell',
    'OfflineManager', 'PWAInstallNudge', 'PipelineBottleneck', 'PrefsSync',
    'ROOFIVENT_CATALOG', 'ShortcutsHelp', 'SmartFollowupBriefing',
    'StaleSharesWidget'];
  // Three shapes put a name back on the global object, and the walk must see
  // all of them (2026-09-22 — before this it only matched the dotted form, so
  // the other two re-grew a converted name silently):
  //   window.X = …                      dotted (the original check)
  //   window['X'] = … / window["X"]     bracket notation with a literal key
  //   Object.assign(window, { X, … })   bulk re-export (keys only: shorthand,
  //                                     `X: …`, quoted `'X': …`, method `X() {}`)
  // globalThis is treated the same as window for the last two. Dynamic
  // window[fnName] dispatch is not a re-export and is not flagged.
  // Object.assign(window.__NBD_CALL_REGISTRY, …) is the REGISTRY, not window,
  // and must not match.
  const windowReexportedNames = (src) => {
    const out = new Set();
    for (const m of src.matchAll(/\b(?:window|globalThis)\s*\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]/g)) out.add(m[2]);
    const OA = /\bObject\.assign\s*\(\s*(?:window|globalThis)\s*,/g;
    let m;
    while ((m = OA.exec(src))) {
      // Scan to the matching close paren, skipping string literals and comments.
      let depth = 1, i = OA.lastIndex, arg = '';
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
          let j = i + 1;
          while (j < src.length && src[j] !== c) j += (src[j] === '\\') ? 2 : 1;
          arg += src.slice(i, j + 1); i = j + 1; continue;
        }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
        arg += c; i++;
      }
      // A key sits right after `{` or `,`; a value sits after `:` and is not a key.
      for (const k of arg.matchAll(/[{,]\s*(['"]?)([A-Za-z_$][\w$]*)\1\s*(?=[:,}(])/g)) out.add(k[2]);
    }
    return out;
  };
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fp); continue; }
      if (!/\.(js|html)$/.test(entry.name)) continue;
      const src = fs.readFileSync(fp, 'utf8');
      const reexported = windowReexportedNames(src);
      for (const n of NAMES) {
        // $-prefixed names must be escaped or the RegExp reads them as anchors
        const esc = n.replace(/\$/g, '\\$');
        if (new RegExp('window\\.' + esc + '\\b').test(src) || reexported.has(n)) {
          offenders.push(path.relative(ROOT, fp) + ':' + n);
        }
      }
    }
  };
  // The walk's own detector, pinned on fixtures so it cannot quietly go blind.
  // Each POSITIVE shape was missed by the dotted-only check this replaced.
  {
    const pos = {
      'bracket, single quote': "window['fooName'] = fooName;",
      'bracket, double quote + spaces': 'window[ "fooName" ] = fooName;',
      'bracket, globalThis': "globalThis['fooName'] = fooName;",
      'Object.assign shorthand': 'Object.assign(window, { barName, fooName });',
      'Object.assign key: value': 'Object.assign(window, {\n  fooName: fooName,\n});',
      'Object.assign quoted key': "Object.assign(window, { 'fooName': fooImpl });",
      'Object.assign after a comment': 'Object.assign(window, { // exports\n  fooName });',
      'Object.assign method shorthand': 'Object.assign(window, { fooName() { return 1; } });',
      'Object.assign(globalThis, …)': 'Object.assign(globalThis, { fooName });',
    };
    for (const [label, src] of Object.entries(pos)) {
      assert('T1 walk detector catches the ' + label + ' re-export shape',
        windowReexportedNames(src).has('fooName'));
    }
    const neg = {
      'the registry (Object.assign(window.__NBD_CALL_REGISTRY, …))':
        'Object.assign(window.__NBD_CALL_REGISTRY, { fooName: fooName });',
      'a value, not a key': 'Object.assign(window, { other: fooName });',
      'dynamic window[fnName] dispatch': 'const fnName = "fooName"; window[fnName]();',
      'the name inside a string value': "Object.assign(window, { other: 'fooName' });",
      'the name only in a comment': 'Object.assign(window, { /* fooName */ other });',
    };
    for (const [label, src] of Object.entries(neg)) {
      assert('T1 walk detector does NOT flag ' + label,
        !windowReexportedNames(src).has('fooName'));
    }
  }
  walk(path.join(ROOT, 'docs'));
  assert('no window.<TrancheZeroName> references anywhere under docs/ — '
      + (offenders.slice(0, 5).join(', ') || 'clean'), offenders.length === 0);

  // The replacement idempotency convention: guarded widgets key into the
  // shared __NBD_LOADED registry instead of testing their own window object.
  const af = read(path.join(PRO_JS, 'activity-feed.js'));
  assert('activity-feed.js uses the __NBD_LOADED registry guard',
    /__NBD_LOADED\['activity-feed'\]/.test(af));
  const sig = read(path.join(PRO_JS, 'signature-widget.js'));
  assert('signature-widget.js migrated its bespoke sentinel to the registry',
    /__NBD_LOADED\['signature-widget'\]/.test(sig) && !/__NBDSig__sentinel/.test(sig));

  // Tranche 2a: mobile-nav-customizer's drag/touch handlers were wired
  // through GENERATED inline attributes (ontouchstart="window._ncm...").
  // script-src-attr 'none' in the prod CSP blocks those — reorder was
  // silently dead until the delegation rewrite. They must never return.
  const mnc = read(path.join(PRO_JS, 'mobile-nav-customizer.js'));
  assert('mobile-nav-customizer generates NO inline handler attributes (CSP script-src-attr none)',
    !/on(touchstart|touchmove|touchend|dragstart|dragover|drop|dragend|click)\s*=\s*"/.test(mnc));
  assert('mobile-nav-customizer binds drag/touch via modal-level delegation',
    /_bindDnd\(modal\)/.test(mnc) && /addEventListener\('touchmove'[\s\S]{0,80}passive: false/.test(mnc));

  // First-run punch list follow-up (2026-07-29): the customizer REBUILDS
  // #mobile-nav at boot, so the static markup's create FAB only exists if the
  // registry + defaults carry it. Without these pins a default-tab tweak
  // silently removes the ONLY add-lead control on the mobile home view.
  assert('mobile-nav-customizer: create FAB is a registry tab AND a default tab',
    /\{ id: 'create',[\s\S]{0,80}action: 'create'/.test(mnc)
    && /const DEFAULT_TABS = \['dash', 'crm', 'create', 'joe'\]/.test(mnc),
    'the mobile home view must always ship with an add-lead control by default');
  assert('mobile-nav-customizer renders the create FAB with the static markup identity',
    /class="mn-item mn-fab" id="mni-create" data-mnc-action="create"/.test(mnc),
    '.mn-fab CSS treatment + onboarding-tour #mni-create anchor depend on this shape');
  assert('mobile-nav-customizer dispatches create via __NBD_CALL_REGISTRY first',
    /case 'create':[\s\S]{0,400}__NBD_CALL_REGISTRY[\s\S]{0,200}mCreateFabRoute/.test(mnc),
    'mCreateFabRoute lives in the call registry, not on window (Tranche 2c-4c)');

  // CSP-dead handler audit (2026-07-05, post-2a sweep). Three more prod
  // breakages of the same class, all pinned here so they can't return:
  const bootSrc = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
  assert('kanban columns: no inline ondragover/ondrop (CSP-dead) — board-level delegation instead',
    !/on(dragover|drop)\s*=\s*"/.test(bootSrc) && /nbdDndBound/.test(bootSrc));
  // Raw HTML only — readDashboard() concatenates extracted JS shards whose
  // comments legitimately mention historical onclick="" patterns.
  const dashHtml = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('dashboard.html: ZERO inline handler attributes (incl. the old font-swap onload)',
    !/ on(load|click|change|error|input|submit|keydown)\s*=\s*"/.test(dashHtml));
  const sl = read(path.join(PRO_JS, 'script-loader.js'));
  assert('script-loader performs the CSP-safe font-swap for link[data-nbd-font-swap]',
    /data-nbd-font-swap/.test(sl) && /data-nbd-font-swap/.test(dashHtml));
  const toolsSrc = read(path.join(PRO_JS, 'tools.js'));
  assert('tools.js saveQuickLead selects the save button by data-fn (old [onclick=] selector crashed every save)',
    /button\[data-fn="saveQuickLead"\]/.test(toolsSrc) && !/button\[onclick="saveQuickLead/.test(toolsSrc));

  // Deal-room strict rewrite (option B): the generated customer page must
  // carry NO executable inline script and NO inline handlers — its logic
  // lives in the external /pro/deal-room.js, config in a JSON data island,
  // token/submit-URL in serve-time meta tags (deal-acceptance.js).
  const cb = read(path.join(PRO_JS, 'close-board.js'));
  assert('close-board deal template: zero inline handler attributes', !/on(click|touchstart|drag)\w*\s*=\s*"/.test(cb));
  assert('close-board deal template: config rides the nbd-deal-data JSON island (with < escaped)',
    /nbd-deal-data/.test(cb) && /u003c/.test(cb));
  assert('close-board deal template: references the external deal-room.js absolutely',
    /https:\/\/nobigdealwithjoedeal\.com\/pro\/deal-room\.js/.test(cb));
  assert('close-board deal template: the old inline logic <script> is gone',
    !/<script>\s*let selectedTier/.test(cb));
  const dr = read(path.join(ROOT, 'docs/pro/deal-room.js'));
  assert('deal-room.js wires tiers/financing/signature via delegation + reads meta token',
    /data-deal-tier/.test(dr) && /data-deal-action/.test(dr)
    && /nbd-deal-token/.test(dr) && /nbd-deal-data/.test(dr));
  const da = read(path.join(FUNCTIONS, 'deal-acceptance.js'));
  assert('getDealRoom injects CSP-safe meta tags for token + submit URL',
    /meta name="nbd-deal-token"/.test(da) && /meta name="nbd-deal-submit"/.test(da));

  // Mobile header safe-area (2026-07): global box-sizing:border-box means
  // a fixed height:48px INCLUDES the padding-top:env(safe-area-inset-top)
  // added for the notch — leaving negative content space so the logo/
  // icons/title spilled below the black bar on real iPhones (invisible to
  // headless CI, which has inset:0). The mobile header rule must reserve
  // the inset via min-height, never a bare fixed height.
  const appCss = read(path.join(PRO_JS, '..', 'css', 'dashboard-app.css'));
  const mobileHeader = (appCss.match(/@media\(max-width:768px\)\{[\s\S]*?\n\}/) || [''])[0];
  // Pull the specific header{...} declaration inside the 768 block.
  const hdrRule = (appCss.match(/  header\{padding:env\(safe-area-inset-top[^}]*\}/) || [''])[0];
  assert('mobile header reserves the notch inset via min-height calc (not a bare fixed height)',
    /min-height:calc\(48px \+ env\(safe-area-inset-top/.test(hdrRule)
    && /padding:env\(safe-area-inset-top/.test(hdrRule)
    && !/height:48px/.test(hdrRule));
}

// ── Globals Tranche 2c: the __NBD_CALL_REGISTRY dispatch layer ──
// prefs-boot's 22 markup-dispatched handlers moved into module scope and
// register in window.__NBD_CALL_REGISTRY; the dashboard-ui.js dispatchers
// resolve the registry BEFORE the allowlisted-window fallback. These
// guards pin (a) the resolver + all three dispatch sites, (b) every
// registration, (c) allowlist removal (a stale entry would re-route
// dispatch to a window global that no longer exists = silent dead
// control), and (d) a FULL markup↔dispatch wiring audit of dashboard.html
// — every data-fn / data-on-change / data-on-input / data-on-after name
// must be allowlisted or registered. (d) is the invariant whose violation
// produced the C-1 saveLead and H-4 21-dead-buttons classes.
section('Globals Tranche 2c: __NBD_CALL_REGISTRY dispatch layer');
{
  const T2C_NAMES = [
    'nbdSetSize', 'nbdApplyLegacyFont', 'toggleProfessionalMode',
    'nbdSetSidebarLabels', 'nbdGxSetEnabled', 'nbdGxSetGlow',
    'nbdGxSetAnimatedBg', 'nbdGxSetAccent', 'nbdGxSetIntensityFromSlider',
    'nbdOverlaysSetEnabled', 'nbdSoundsSetEnabled', 'nbdComfortSetMotion',
    'nbdComfortSetProMode', 'nbdComfortSetCbSafe', 'nbdComfortSetAutoTheme',
    'nbdSetCrmSecHeaderEnabledT', 'nbdSetKanbanBoldHierarchyT',
    'nbdSetCrmAutoCollapseT', 'nbdSelectPhotoLead', 'nbdTogglePhotosOnly',
    'd2dSetDispoFilter', 'nbdSettingsUpdateCalcomPreview'];

  const ui = read(path.join(PRO_JS, 'dashboard-ui.js'));
  assert('dashboard-ui.js defines the _nbdResolveCall registry-first resolver',
    /function _nbdResolveCall\(/.test(ui) && /__NBD_CALL_REGISTRY/.test(ui));
  assert('change/input delegate resolves via _nbdResolveCall',
    /_nbdResolveCall\(el\.getAttribute\(attrName\)\)/.test(ui));
  assert('data-on-after resolves via _nbdResolveCall',
    /_nbdResolveCall\(el\.getAttribute\('data-on-after'\)\)/.test(ui));
  assert('click `call` action resolves via _nbdResolveCall',
    /_nbdResolveCall\(el\.dataset\.fn\)/.test(ui));

  const prefsBoot = read(path.join(PRO_JS, 'dashboard-ui-prefs-boot.js'));
  const regBlock = (prefsBoot.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/) || ['', ''])[1];
  for (const n of T2C_NAMES) {
    assert('prefs-boot registers ' + n + ' in __NBD_CALL_REGISTRY',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(regBlock));
  }

  const stateSrc = read(path.join(PRO_JS, 'dashboard-state.js'));
  for (const n of T2C_NAMES) {
    assert('allowlist no longer carries ' + n + ' (the registry entry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
  }

  // ── Tranche 2c-2: the maps-routing.js drawing-tool cluster ──
  // Same pattern, second module: 21 of its 22 allowlisted names register
  // in __NBD_CALL_REGISTRY and leave the allowlist. goToMyLocation is the
  // deliberate exception — the maps.js shim re-states it on window (real
  // cross-file reference), so it keeps its allowlist entry until the
  // shim's export block is unwound (Tranche 3).
  const T2C2_NAMES = [
    'acceptAutoDetect', 'addStructure', 'applySmartWaste',
    'cancelAutoDetect', 'exportXactimateESX', 'generateScopeFromDrawing',
    'handleComparisonFile', 'loadDrawingFromCustomer', 'openComparisonMode',
    'recalc', 'runSolarAnalysis', 'saveDrawingToCustomer', 'screenshotMap',
    'setHistoricalLayer', 'showAngles', 'showMaterialTakeoff',
    'startAutoDetect', 'startPresentation', 'startShadowPitch',
    'updateHistoryOpacity', 'zoomToFit'];

  const mapsRouting = read(path.join(PRO_JS, 'maps-routing.js'));
  const mrRegBlock = (mapsRouting.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/) || ['', ''])[1];
  for (const n of T2C2_NAMES) {
    assert('maps-routing registers ' + n + ' in __NBD_CALL_REGISTRY',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(mrRegBlock));
  }
  for (const n of T2C2_NAMES) {
    assert('allowlist no longer carries ' + n + ' (the registry entry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
  }
  // goToMyLocation must stay BOTH allowlisted and window-exported — the
  // dispatcher reaches it as window[fn]. (maps.js's own bare re-export of
  // this name — the second half of the old reasoning here — was deleted
  // 2026-09-17, T3-B; maps-routing.js's explicit export below is now the
  // only source of window.goToMyLocation, and always was the one that
  // actually mattered.) Losing this half = a dead "My Location" button.
  assert('goToMyLocation keeps its allowlist entry (failed the three-way proof)',
    /'goToMyLocation'/.test(stateSrc));
  assert('maps-routing re-exports goToMyLocation for the maps.js shim',
    /window\.goToMyLocation = goToMyLocation;/.test(mapsRouting));
  // The IIFE wrap must not orphan the allowlisted data-fn targets or the
  // cross-file bare-name consumers — those still resolve as window[fn] or
  // bare globals, so each keeps its explicit export. (The six map-dispatched
  // names that used to sit in this list graduated in the Tranche 3
  // dispatch-map slice, 2026-09-02 — their pins moved to the graduate block
  // in the 2c-4b section, which asserts the OPPOSITE: registered + off
  // window.)
  for (const n of ['initDrawMap', 'selLT', 'renderAccessoryPanel',
    'setDrawMode', 'clearDraw', 'undoLine', 'exportDrawReport',
    'importToEstimate', 'perimChooseType', 'searchDraw']) {
    assert('maps-routing window-exports ' + n + ' (window[fn]-dispatched or bare-called cross-file)',
      new RegExp('window\\.' + n + ' = ' + n + ';').test(mapsRouting));
  }
  // drawMap must stay a top-level let OUTSIDE the module IIFE —
  // dashboard-actions/ui/sw-bootstrap read it as a bare global at runtime.
  assert('drawMap survives as a top-level global let',
    /^let drawMap;$/m.test(mapsRouting));

  // ── Tranche 2c-3: the crm-portal-bridge.js bulk-ops cluster ──
  // Same pattern, third module. The whole file is IIFE-wrapped; 11
  // markup-only handlers register in __NBD_CALL_REGISTRY and leave the
  // allowlist. clearBulkSelection is the deliberate exception — the same
  // MUST-STAY shape as goToMyLocation: lead-snooze.js calls
  // window.clearBulkSelection() OUTSIDE the registry-first dispatcher, so
  // it keeps BOTH its allowlist entry and a window re-export.
  const T2C3_NAMES = [
    'selectAllVisibleLeads', 'openDeletedDrawer', 'confirmDeleteLead',
    'cancelDeleteConfirm', 'bulkSnoozeLeads', 'bulkMoveStage', 'bulkDelete',
    'bulkAssignSource', 'bulkAssignJobType', 'bulkAssignDamage', 'bulkAssignCarrier'];
  const crmPortalBridge = read(path.join(PRO_JS, 'crm-portal-bridge.js'));
  const cpbRegBlock = (crmPortalBridge.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/) || ['', ''])[1];
  assert('crm-portal-bridge.js is IIFE-wrapped (its top-level names leave window)',
    /^\(function \(\) \{$/m.test(crmPortalBridge) && /\}\)\(\);\s*$/.test(crmPortalBridge.trimEnd()));
  for (const n of T2C3_NAMES) {
    assert('crm-portal-bridge registers ' + n + ' in __NBD_CALL_REGISTRY',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(cpbRegBlock));
    assert('allowlist no longer carries ' + n + ' (the registry entry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
  }
  // clearBulkSelection MUST stay BOTH allowlisted and window-exported —
  // lead-snooze.js:773 calls window.clearBulkSelection() directly, and it
  // is NOT registered (would be redundant). Losing either half = a dead
  // best-effort bulk-exit after a snooze action.
  assert('clearBulkSelection keeps its allowlist entry (lead-snooze direct call)',
    /'clearBulkSelection'/.test(stateSrc));
  assert('crm-portal-bridge re-exports clearBulkSelection on window',
    /window\.clearBulkSelection = clearBulkSelection;/.test(crmPortalBridge));
  assert('clearBulkSelection is NOT registered (window path only)',
    !/\bclearBulkSelection:\s*clearBulkSelection\b/.test(cpbRegBlock));
  // The IIFE wrap must not orphan the cross-file consumers — these resolve
  // as bare globals or window.X() calls, so each needs an explicit re-export
  // from this file now that crm.js no longer provides it. (closeDeletedDrawer
  // left this list in the Tranche 3 dispatch-map slice, 2026-09-02 — its only
  // reach was the registry-first _NBD_MODAL_CLOSE_FNS entry; its inverted pin
  // lives in the graduate block. toggleBulkMode and scrollToFollowUps left it
  // in Tranche 3 T3-C, 2026-09-18 — their inverted pins are the block below.)
  for (const n of ['editLead', 'deleteLead', 'showDeleteConfirm',
    'toggleCardSelection', 'updateBulkToolbar', 'restoreCrmSearch',
    'refreshTrashBadge']) {
    assert('crm-portal-bridge window-exports ' + n + ' (cross-file consumer)',
      new RegExp('window\\.' + n + ' = ' + n + ';').test(crmPortalBridge));
  }

  // ── Tranche 3 T3-C (2026-09-18): the bulk-mode / follow-ups / analytics
  // edge ── five cross-file JS calls that used to go through window.X now read
  // __NBD_CALL_REGISTRY. Every consumer keeps a typeof guard that turns a
  // missing entry into a NO-OP (never a fallback to some other global), and
  // the T1_NAMES walk above fails any window.X reference left under docs/.
  // Owner halves: the registry entry is the ONLY way each consumer reaches
  // the function now — lose it and bulk mode survives navigation (H4), the
  // bulk-snooze never leaves select mode, the overdue-follow-ups KPI tap
  // lands on the CRM without scrolling, the Doors Verified card never
  // renders, and the schedule refresh button goes silently dead.
  {
    const regKeysOf = (src) => {
      const keys = new Set();
      for (const m of src.matchAll(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/g)) {
        for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g)) keys.add(k[1] + '=' + k[2]);
      }
      return keys;
    };
    const t3cActions = read(path.join(PRO_JS, 'dashboard-actions.js'));
    const t3cSnooze = read(path.join(PRO_JS, 'lead-snooze.js'));
    const t3cKpi = read(path.join(PRO_JS, 'analytics-kpi.js'));
    const t3cCal = read(path.join(PRO_JS, 'smart-calendar.js'));
    const t3cBoot = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
    const t3cDash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
    // [name, owner src, owner label, consumer src, consumer label]
    const T3C_BULK_EDGE = [
      ['exitBulkMode', crmPortalBridge, 'crm-portal-bridge.js', t3cActions, 'dashboard-actions.js'],
      ['toggleBulkMode', crmPortalBridge, 'crm-portal-bridge.js', t3cSnooze, 'lead-snooze.js'],
      ['scrollToFollowUps', crmPortalBridge, 'crm-portal-bridge.js', t3cKpi, 'analytics-kpi.js'],
      ['renderDoorsVerifiedCard', t3cKpi, 'analytics-kpi.js', t3cBoot, 'dashboard-bootstrap.module.js'],
      ['loadSmartCalendar', t3cCal, 'smart-calendar.js', t3cBoot, 'dashboard-bootstrap.module.js'],
    ];
    for (const [n, ownerSrc, owner, consSrc, cons] of T3C_BULK_EDGE) {
      assert(owner + ' registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C bulk/follow-ups edge)',
        regKeysOf(ownerSrc).has(n + '=' + n));
      assert(owner + ' no longer assigns window.' + n + ' (T3-C off window)',
        !new RegExp('window\\.' + n + '\\s*=').test(ownerSrc));
      // Per call site, not per file: the registry read must sit directly above
      // THIS name's guard (dashboard-bootstrap.module.js has two consumer
      // sites, so a file-wide match let either site's declaration satisfy
      // both — drop one and that site throws a ReferenceError; the Doors-card
      // one inside a setTimeout, so the card just never renders). The
      // read must END at the registry (`\s*;`): `window.__NBD_CALL_REGISTRY
      // || window` is the permissive-default class this tranche forbids. No
      // reassignment of _nbdReg may sit between the read and the guard.
      assert(cons + ' calls ' + n + ' off the registry behind a fail-closed typeof guard',
        new RegExp('_nbdReg\\s*=\\s*window\\.__NBD_CALL_REGISTRY\\s*;'
          + '(?:(?!_nbdReg\\s*(?:\\|\\||&&|\\?\\?)?=(?!=))[\\s\\S]){0,200}?'
          + '_nbdReg && typeof _nbdReg\\.' + n + " === 'function'").test(consSrc)
          && new RegExp('_nbdReg\\.' + n + '\\(').test(consSrc)
          && !new RegExp('window\\.' + n + '\\b').test(consSrc));
    }
    // goTo's H4 force-exit must still only fire when LEAVING the kanban with
    // bulk mode on — the registry read must not have widened or dropped that.
    const goToBody = t3cActions.slice(t3cActions.indexOf('function goTo('),
      t3cActions.indexOf('_hydrateViewTemplate(name);'));
    assert('goTo force-exits bulk mode via the registry only when leaving crm with _bulkMode set (H4)',
      /if \(name !== 'crm' && window\._bulkMode && _nbdReg && typeof _nbdReg\.exitBulkMode === 'function'\) \{\s*_nbdReg\.exitBulkMode\(\);/.test(goToBody));
    // #bulkModeBtn reaches toggleBulkMode ONLY through the toggle map (resolved
    // registry-first by _nbdResolveMapped) — the map entry must stay, and the
    // name must not be re-added to the allowlist (the map IS its allowlist).
    assert('_NBD_TOGGLE_FNS still routes bulkMode -> toggleBulkMode (its markup dispatch path)',
      /bulkMode:\s*'toggleBulkMode'/.test(stateSrc)
        && /data-action="toggle" data-target="bulkMode"/.test(t3cDash));
    // loadSmartCalendar left _NBD_CALL_ALLOWLIST: the schedule view's refresh
    // button resolves registry-first via _nbdResolveCall, so the registration
    // replaced the allowlist entry. A stale re-add would be a window fallback
    // for a name that is no longer on window.
    assert('allowlist no longer carries loadSmartCalendar (registry replaced it)',
      !/'loadSmartCalendar'/.test(stateSrc));
    assert('schedule refresh button still dispatches loadSmartCalendar via data-fn',
      /data-action="call" data-fn="loadSmartCalendar"/.test(t3cDash));
  }

  // ── Tranche 2c-4a: the dashboard-actions.js card-detail cluster ──
  // First slice of the dashboard-actions.js decomposition. 18 cda* /
  // chip-picker / mobile photo-picker wrappers are consolidated into ONE
  // in-file IIFE (the file is NOT wholly wrapped — the goTo router, zone-draw
  // shims and other MUST-STAY names stay as top-level window globals) and
  // register in __NBD_CALL_REGISTRY, leaving the allowlist. cdaMjdAct /
  // cdaOpenMobileInspection call the 2c-4b mobile cluster via window._mJdAct /
  // window.openMobileInspection so they survive when those callees go
  // module-local. See docs/dev/dashboard-actions-globals-audit.md.
  const T2C4A_NAMES = [
    'cdaReport', 'cdaEnrich', 'cdaPhotos', 'cdaInvoice', 'cdaInspection',
    'cdaInspectionDeep', 'cdPickStage', 'cdPickType', 'cdaMjdAct', 'cdaEditLead',
    'cdaOpenMobileInspection', 'cdaVoiceMemo', 'cdaOpenVoicemail',
    'cdaSharePortalLink', 'cdaRevokePortalLink', 'cdaConfirmPromote',
    'cdaOpenTaskModal', '_mCreatePhotoPicked'];
  const dashActions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  // dashboard-actions.js now carries MORE THAN ONE registry block (2c-4a card-
  // detail + 2c-4b mobile, and the 2c-4b block is physically earlier in the
  // file). A first-match .match() would silently grab only the 2c-4b block and
  // fail every 2c-4a assertion below — aggregate ALL blocks instead.
  const daRegBlock = [...dashActions.matchAll(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/g)].map(m => m[1]).join('\n');
  for (const n of T2C4A_NAMES) {
    assert('dashboard-actions registers ' + n + ' in __NBD_CALL_REGISTRY',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlock));
    assert('allowlist no longer carries ' + n + ' (the registry entry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    // Off window: no file may reassign window.<cdaName> (would shadow-resurrect).
    assert('dashboard-actions no longer defines window.' + n,
      !new RegExp('window\\.' + n + '\\s*=\\s*function').test(dashActions));
  }
  // The cross-slice calls resolve via window.* — those callees (2c-4b) are
  // re-exported now, so cdaMjdAct / cdaOpenMobileInspection keep working and
  // will survive the mobile cluster going module-local.
  assert('cdaMjdAct calls the mobile handler via window._mJdAct (cross-slice-safe)',
    /window\._mJdAct\(actionType/.test(dashActions));
  assert('cdaOpenMobileInspection calls via window.openMobileInspection (cross-slice-safe)',
    /window\.openMobileInspection\(window\._cardDetailLeadId\)/.test(dashActions));
  assert('dashboard-actions window-exports _mJdAct for the cross-slice call',
    /window\._mJdAct = _mJdAct;/.test(dashActions));
  assert('dashboard-actions window-exports openMobileInspection for the cross-slice call',
    /window\.openMobileInspection = openMobileInspection;/.test(dashActions));
  // MUST-STAY: the goTo router keeps its allowlist entry (never converted).
  assert('goTo router stays allowlisted (MUST-STAY — 27 cross-file callers)',
    /'goTo'/.test(stateSrc));

  // ── Tranche 2c-4b: the dashboard-actions.js mobile create/job-detail cluster ──
  // Second slice: the contiguous mobile block is IIFE-wrapped. Three markup-
  // dispatched convertibles register in __NBD_CALL_REGISTRY and leave the
  // allowlist; seven names keep a window re-export for a cross-boundary consumer
  // (cross-slice 2c-4a call, _NBD_MODAL_CLOSE_FNS window[fn] dispatch, or a
  // bare cross-file caller). openMobileCreatePopover is private.
  const T2C4B_REG = ['_mJdSwitchTab', '_mJdShare', '_mCreate'];
  for (const n of T2C4B_REG) {
    assert('dashboard-actions registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4b)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4b — registry/vestigial)',
      !new RegExp("'" + n + "'").test(stateSrc));
  }
  // _mJdAct also leaves the allowlist (never markup-dispatched; reached via
  // window._mJdAct from the 2c-4a cdaMjdAct wrapper).
  assert("allowlist no longer carries _mJdAct (reached via window._mJdAct only)",
    !/'_mJdAct'/.test(stateSrc));
  // The load-bearing window re-exports — each pinned to its consumer. Dropping
  // any one is a silent dead control (cross-IIFE read or bare caller),
  // invisible to the data-fn wiring audit.
  //
  // This list was 7 until 2026-09-01. The two modal-close handlers left it that
  // day: they were load-bearing ONLY because _NBD_MODAL_CLOSE_FNS resolved with
  // a bare window[fnName], and dashboard-ui.js's _nbdResolveMapped now checks
  // __NBD_CALL_REGISTRY first. That is the whole point of the dispatch-map
  // slice — "MUST-STAY because a name-string map can't see module scope" was
  // never a property of these handlers, only of the map.
  for (const [n, why] of [
    ['_mJdSwitchTab', 'dashboard-widgets.js bare call'],
    ['_mJdAct', '2c-4a cdaMjdAct window._mJdAct'],
    ['openMobileInspection', '2c-4a cdaOpenMobileInspection window.openMobileInspection'],
    ['toggleMobileCreatePopover', 'mCreateFabRoute (outside IIFE)'],
    ['openLeadDetail', 'crm-pipeline.js bare call']]) {
    assert('dashboard-actions keeps window.' + n + ' re-export (' + why + ')',
      new RegExp('window\\.' + n + '\\s*=\\s*' + n + ';').test(dashActions));
  }
  // The two that graduated: registered AND off window. Both are dispatched
  // solely through _NBD_MODAL_CLOSE_FNS, so the registry entry is now the only
  // thing keeping their modals closable — losing it is a trap-the-user bug.
  for (const [n, key] of [['closeMobileInspection', 'mobileInspection'],
    ['closeMobileCreatePopover', 'mobileCreatePopover']]) {
    assert(n + ' registered in __NBD_CALL_REGISTRY + off window (Tranche 3 dispatch-map slice)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlock)
        && !new RegExp('window\\.' + n + '\\s*=').test(dashActions));
    assert('_NBD_MODAL_CLOSE_FNS still maps ' + key + ' -> ' + n,
      new RegExp(key + ':\\s*\'' + n + '\'').test(stateSrc),
      'the map entry is the only dispatch path left for this handler');
  }
  // openMobileCreatePopover is private — no registry entry, no window export.
  assert('openMobileCreatePopover is neither registered nor window-exported (2c-4b private)',
    !/openMobileCreatePopover:\s*openMobileCreatePopover/.test(daRegBlock)
      && !/window\.openMobileCreatePopover\s*=/.test(dashActions));

  // ── Tranche 3 dispatch-map slice (2026-09-02): eight more graduates ──
  // Six dashboard-ui.js handlers + the two property-intel twins, each
  // dispatched SOLELY through _NBD_TOGGLE_FNS / _NBD_MODAL_CLOSE_FNS
  // (registry-first since T3-M). Same trap-the-user stakes as the pair
  // above: registry entry + map entry are now the only dispatch path —
  // losing either half is a control Joe cannot use, thrown by nothing.
  // The twins' dashboard-ui.js copies are DELETED (property-intel.js is
  // sole owner); a reappearing copy there would be a silent window
  // fallback shadowing a registered name.
  {
    const dashUi = read(path.join(PRO_JS, 'dashboard-ui.js'));
    const propIntel = read(path.join(PRO_JS, 'property-intel.js'));
    const bootMod = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
    const notifBell = read(path.join(PRO_JS, 'notif-bell.js'));
    const naFilter = read(path.join(PRO_JS, 'needs-attention-filter.js'));
    const snooze = read(path.join(PRO_JS, 'lead-snooze.js'));
    const staleShares = read(path.join(PRO_JS, 'stale-shares-filter.js'));
    const crmSrc = read(path.join(PRO_JS, 'crm.js'));
    // Rows: [dispatched name, map key, owner source, owner label, registry
    // VALUE identifier when it differs from the name (IIFE-local aliases)].
    const T3_MAP_GRADS = [
      ['toggleHdrMobileMenu', 'hdrMobileMenu', dashUi, 'dashboard-ui.js'],
      ['toggleKanbanFullscreen', 'kanbanFullscreen', dashUi, 'dashboard-ui.js'],
      ['toggleSidebarCollapse', 'sidebarCollapse', dashUi, 'dashboard-ui.js'],
      ['closePhotoModal', 'photoModal', dashUi, 'dashboard-ui.js'],
      ['closeDocViewer', 'docViewerModal', dashUi, 'dashboard-ui.js'],
      ['closeTips', 'tipsModal', dashUi, 'dashboard-ui.js'],
      ['closePropertyIntelModal', 'propertyIntelModal', propIntel, 'property-intel.js'],
      ['closePropertyIntelConfirmModal', 'propertyIntelConfirmModal', propIntel, 'property-intel.js'],
      // Slice 2 (maps-routing band, same day): the six the file's own export-
      // block comment had queued. Their old export pins in the 2c-2 section's
      // IIFE-wrap loop were removed in the same commit — these assertions are
      // their replacements, inverted.
      ['toggleDraw', 'drawing', mapsRouting, 'maps-routing.js'],
      ['toggleMapLayer', 'mapLayer', mapsRouting, 'maps-routing.js'],
      ['toggleHistoricalImagery', 'historicalImagery', mapsRouting, 'maps-routing.js'],
      ['toggleVoiceControl', 'voiceControl', mapsRouting, 'maps-routing.js'],
      ['closeComparisonMode', 'comparisonModal', mapsRouting, 'maps-routing.js'],
      ['closeHistoricalImagery', 'historicalImagery', mapsRouting, 'maps-routing.js'],
      // Slice 3 (2026-09-02): the crm-portal-bridge singleton — the export
      // line's own comment had queued exactly this conversion.
      ['closeDeletedDrawer', 'deletedDrawer',
        read(path.join(PRO_JS, 'crm-portal-bridge.js')), 'crm-portal-bridge.js'],
      // The bonus eight (2026-09-02, same evening): map-only names the T3-M
      // ledger's "still blocked (19)" overcounted — each individually
      // prover+refuter verified. Four register an IIFE-local alias (5th
      // column); crm.js's needed the auto-global→const conversion and the
      // dead W93 block deleted.
      ['toggleDebugConsole', 'debugConsole', bootMod, 'dashboard-bootstrap.module.js'],
      ['toggleRecentDropdown', 'recentDropdown', bootMod, 'dashboard-bootstrap.module.js'],
      ['toggleNotificationDropdown', 'notifications', notifBell, 'notif-bell.js', 'toggleDropdown'],
      ['toggleDismissedNotifications', 'dismissedNotifications', notifBell, 'notif-bell.js', 'toggleDismissedView'],
      ['toggleNeedsAttention', 'needsAttention', naFilter, 'needs-attention-filter.js', 'toggle'],
      ['toggleShowSnoozed', 'showSnoozed', snooze, 'lead-snooze.js'],
      ['toggleStaleShares', 'staleShares', staleShares, 'stale-shares-filter.js', 'toggle'],
      ['toggleEngagementSort', 'engagementSort', crmSrc, 'crm.js'],
    ];
    for (const [n, key, src, owner, valIdent] of T3_MAP_GRADS) {
      const val = valIdent || n;
      assert(n + ' registered in ' + owner + ' __NBD_CALL_REGISTRY + off window (Tranche 3 dispatch-map slice)',
        new RegExp('\\b' + n + ':\\s*' + val + '\\b').test(src)
          && !new RegExp('window\\.' + n + '\\s*=').test(src));
      assert('dispatch map still routes ' + key + ' -> ' + n,
        new RegExp(key + ':\\s*\'' + n + '\'').test(stateSrc),
        'the map entry is the only dispatch path left for this handler');
    }
    for (const n of ['closePropertyIntelModal', 'closePropertyIntelConfirmModal']) {
      assert('dashboard-ui.js twin of ' + n + ' stays deleted (property-intel.js sole owner)',
        !new RegExp('function ' + n + '\\b').test(dashUi)
          && !new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(dashUi));
    }
  }

  // ── Tranche 2c-4c: the dashboard-actions.js one-off compound-rewrite openers ──
  // Third slice: 20 markup-dispatched openers (incl. the 2c-4b mobile-routing
  // tail mCreateFabRoute/mQuickAddRoute) wrapped in one in-file IIFE. All
  // REGISTER_ONLY — register in __NBD_CALL_REGISTRY, leave the allowlist, no
  // window re-export. NOTE: hardResetTest/gstaticTest are dispatched from
  // GENERATED markup (dashboard-load-status-banner.js), so the dashboard.html
  // data-fn wiring audit below can't see them — these registry assertions are
  // their ONLY guard against a silent dead button.
  const T2C4C_NAMES = [
    'openDailyProgramFromMore', 'mCreateFabRoute', 'mQuickAddRoute',
    'restartOnboardingTour', 'openDecisionPicker', 'openD2DOrGo',
    'clearAccentTheme', 'openSettingsTab', 'openPhotoEngineOrClickProxy',
    'openReportGenerator', 'enrichReportData', 'openPhotoEngineCurrentLead',
    'openInspectionBuilderCurrentLead', 'closeInspectionBuilder',
    'hideFollowUpAlerts', 'goToD2DFromMaps', 'openCalBookingUrl',
    'hardResetTest', 'gstaticTest', 'modeLineDraw'];
  for (const n of T2C4C_NAMES) {
    assert('dashboard-actions registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4c)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4c — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-actions no longer defines window.' + n + ' (2c-4c off window)',
      !new RegExp('window\\.' + n + '\\s*=\\s*function').test(dashActions));
  }

  // ── Tranche 2c-4d: the dashboard-actions.js daily-program config cluster ──
  // Cluster + its callers (goTo settings-hook + DOMContentLoaded handler)
  // IIFE-wrapped. 3 registered; dsRemoveFloor WINDOW_ONLY (bare-called at
  // dashboard-ui.js:2208); 3 helpers private. The load-time typeof-guarded
  // ds* re-export block is deleted (would read undefined post-wrap).
  const T2C4D_REG = ['dsAddFloor', 'dsSaveConfig', 'dsResetDefaults'];
  for (const n of T2C4D_REG) {
    assert('dashboard-actions registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4d)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4d — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-actions no longer defines window.' + n + ' = ' + n + ' (2c-4d off window)',
      !new RegExp('window\\.' + n + '\\s*=\\s*' + n + '\\b').test(dashActions));
  }
  assert('dashboard-actions keeps window.dsRemoveFloor re-export (dashboard-ui.js:2208 bare call)',
    /window\.dsRemoveFloor = dsRemoveFloor;/.test(dashActions));
  assert('the load-time typeof-guarded ds* re-export block is gone (2c-4d)',
    !/typeof dsAddFloor!==/.test(dashActions) && !/typeof dsResetDefaults!==/.test(dashActions));
  for (const n of ['dsGetConfig', 'dsLoadConfig', 'dsDefaultFloors']) {
    assert(n + ' is private (2c-4d — not registered, not window-exported)',
      !new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlock)
        && !new RegExp('window\\.' + n + '\\s*=').test(dashActions));
  }

  // ── Tranche 2c-4e: the dashboard-actions.js customer-page handoff cluster ──
  // 4 openers registered + off window; _stashLeadForCustomerPage WINDOW_ONLY
  // (7 typeof-guarded widget callers) keeps its export inside the wrap.
  const T2C4E_REG = ['openPhotosForLead', 'openDocsForLead', 'openFullCustomerDetails', 'editCardDetails'];
  for (const n of T2C4E_REG) {
    assert('dashboard-actions registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4e)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4e — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-actions no longer defines window.' + n + ' = ' + n + ' (2c-4e off window)',
      !new RegExp('window\\.' + n + '\\s*=\\s*' + n + '\\b').test(dashActions));
  }
  assert('dashboard-actions keeps window._stashLeadForCustomerPage re-export (7 widget callers)',
    /window\._stashLeadForCustomerPage = _stashLeadForCustomerPage;/.test(dashActions));

  // ── Tranche 2c-4g: dashboard-ui.js leaf handlers (the DISPATCHER file) ──
  // `function X` → `const X = function` (off window in this non-IIFE-wrapped
  // classic script) + registered in the file's own __NBD_CALL_REGISTRY block.
  // The 3 converted names are pure leaf UI handlers — none touches the resolver
  // / delegate / allowlist machinery that also lives in this file.
  const T2C4G_NAMES = ['cycleKanbanDensity', 'nbdComfortSetWhisperHotkey', 'nbdComfortSetWhisperKey'];
  const duRegBlock = (ui.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/) || ['', ''])[1];
  for (const n of T2C4G_NAMES) {
    assert('dashboard-ui registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4g)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(duRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4g — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-ui no longer exposes window.' + n + ' (2c-4g off window)',
      !new RegExp('window\\.' + n + '\\s*=\\s*' + n + '\\b').test(ui));
  }
  // setKanbanDensity is the MUST-STAY sibling (auto-global backing + no clean
  // wrap-free form) — keeps BOTH its allowlist entry and window re-export.
  assert('setKanbanDensity keeps its allowlist entry + window export (2c-4g MUST-STAY)',
    /'setKanbanDensity'/.test(stateSrc) && /window\.setKanbanDensity = setKanbanDensity;/.test(ui));

  // ── Tranche 2c-4h: dashboard-ui.js Slice H1 (9 cal/photo/template leaves) ──
  // Same file + mechanism as 2c-4g: `function X` → `const X = function` (off
  // window in this non-IIFE classic script) + registered in the file's own
  // __NBD_CALL_REGISTRY block, allowlist entry dropped. All 9 are bare
  // auto-globals living ONLY in dashboard-ui.js with zero cross-file callers
  // (21-agent audit 2026-07-08). Reuses duRegBlock from the 2c-4g check above.
  const T2C4H_NAMES = ['saveCalSettings', 'updateCalEmbed', 'copyCalLink',
    'shareCalViaSMS', 'shareCalViaEmail', 'filterPhotoLeads', 'tlToggleCat',
    'tlFilterCat', 'handleDocUpload'];
  for (const n of T2C4H_NAMES) {
    assert('dashboard-ui registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4h)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(duRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4h — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-ui no longer exposes window.' + n + ' (2c-4h off window)',
      !new RegExp('window\\.' + n + '\\s*=\\s*' + n + '\\b').test(ui));
  }

  // ── Tranche 2c-4h Slice H2: dashboard-ui.js entangled names (6 of 10) ──
  // 6 names single-defined in dashboard-ui.js whose only entanglement was
  // forward-ref `window.X = X` re-export shims in maps.js + dashboard-actions.js
  // (those defeated the off-window move until removed in the SAME slice — the
  // shim resolves the name via the shared global lexical scope). `function X` →
  // `const X` + registered here; both shim sets deleted; allowlist dropped. The
  // other 4 H2 names (property-intel twins) are Slice H2 part 2 (a dedup +
  // property-intel.js ownership migration, not a shim removal).
  const T2C4H2_NAMES = ['spyglassSearch', 'spyglassGoToLocation', 'fabToggle',
    'quickStormCheck', 'openUploadDoc', 'printDoc'];
  const mapsSrc = read(path.join(PRO_JS, 'maps.js'));
  for (const n of T2C4H2_NAMES) {
    assert('dashboard-ui registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4h H2)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(duRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4h H2 — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('maps.js no longer re-exports window.' + n + ' (2c-4h H2 shim removed)',
      !new RegExp('window\\.' + n + '\\s*=').test(mapsSrc));
    assert('dashboard-actions no longer re-exports window.' + n + ' (2c-4h H2 shim removed)',
      !new RegExp('window\\.' + n + '\\s*=').test(dashActions));
  }
  // damagNearMe dedup (2026-08-07, deferred-queue item 5): the single
  // implementation lives in maps-overlays.js (per-PositionError messaging) and
  // registers in __NBD_CALL_REGISTRY; the three shadowing aliases
  // (dashboard-actions ×2, maps.js ×1 → spyglassGoToLocation) are deleted and
  // the allowlist entry dropped (registry-registered names must not keep a
  // window fallback).
  const moSrc = read(path.join(PRO_JS, 'maps-overlays.js'));
  assert('maps-overlays defines the damagNearMe implementation',
    /function damagNearMe\(\)/.test(moSrc));
  assert('maps-overlays registers damagNearMe in __NBD_CALL_REGISTRY',
    /damagNearMe:\s*damagNearMe/.test(moSrc));
  assert('maps.js no longer aliases window.damagNearMe',
    !/window\.damagNearMe\s*=/.test(mapsSrc));
  assert('dashboard-actions no longer aliases window.damagNearMe',
    !/window\.damagNearMe\s*=/.test(dashActions));
  assert('allowlist no longer carries damagNearMe (registry replaced it)',
    !/'damagNearMe'/.test(stateSrc));

  // ── Tranche 2c-4h Slice H2 part 2: property-intel twin dedup (4 of 10) ──
  // The selective-pull cluster was byte-identical in dashboard-ui.js AND
  // property-intel.js (the latter loads last → already won on window). The
  // dashboard-ui.js twins are DELETED; property-intel.js is the sole owner and
  // registers them in ITS OWN __NBD_CALL_REGISTRY block; the dashboard-actions.js
  // forward-ref shims + allowlist entries are dropped.
  const T2C4H_PI_NAMES = ['pullIntelForModal', 'updatePropertyIntelCost',
    'confirmPropertyIntelPull', 'executePullPropertyIntel'];
  const piSrc = read(path.join(PRO_JS, 'property-intel.js'));
  const piRegBlock = (piSrc.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/) || ['', ''])[1];
  for (const n of T2C4H_PI_NAMES) {
    assert('property-intel registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4h H2 pt2)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(piRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4h H2 pt2 — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-ui.js twin deleted — no `function ' + n + '` remains (2c-4h H2 pt2)',
      !new RegExp('function ' + n + '\\b').test(ui));
    assert('dashboard-actions no longer re-exports window.' + n + ' (2c-4h H2 pt2)',
      !new RegExp('window\\.' + n + '\\s*=').test(dashActions));
    assert('property-intel no longer window-exports ' + n + ' (off window, registry-only)',
      !new RegExp('window\\.' + n + '\\s*=').test(piSrc));
  }
  // ── Tranche 3 T3-A (2026-09-18): dashboard-ui.js explicit window exports ──
  // Prep for the dashboard-ui.js whole-file IIFE wrap (stacked PR). Fourteen
  // function declarations in this file are reached from OUTSIDE it through the
  // global object: bare cross-file calls (updateBreadcrumb and
  // _hydrateViewTemplate inside goTo(), loadCalSettings, renderAcDrop,
  // closeUploadDoc, applyTheme, dsRenderFloors, dsBuildThemeGrid,
  // getCrmSecHeaderEnabled), window.X or typeof-guarded bare reads (hideAcDrop,
  // mobileNav, toggleMobileMore, closeMobileMore) and the REQUIRED @audit
  // shard's fnCheck('toggleMapSidebar'). _nbdResolveMapped rides along as a
  // documented test seam for tests/e2e/globals-surface-snapshot.spec.js. Each
  // gets a plain window.X = X; line in ONE block at the top of the file.
  //
  // Today those lines are redundant: a top-level classic-script function
  // declaration already owns its window slot. Once the file is wrapped they
  // are the only thing keeping these names reachable, so a missing line is a
  // ReferenceError on every navigation (goTo) or a control that silently does
  // nothing (the live mobile More button). The block has to precede the first
  // statement that can throw at load, or a throw lower down strands the names.
  const DU_T3A_EXPORTS = ['updateBreadcrumb', '_hydrateViewTemplate', 'loadCalSettings',
    'renderAcDrop', 'hideAcDrop', 'closeUploadDoc', 'applyTheme', 'dsRenderFloors',
    'dsBuildThemeGrid', 'getCrmSecHeaderEnabled', 'mobileNav', 'toggleMobileMore',
    'closeMobileMore', 'toggleMapSidebar', '_nbdResolveMapped'];
  const DU_EXP_MARK = '// WINDOW EXPORTS — Globals Tranche 3 T3-A';
  const duExpStart = ui.indexOf(DU_EXP_MARK);
  const duFirstLoadStmt = ui.indexOf('(function _eagerHydrateActiveViews(){');
  assert('dashboard-ui.js has ONE window-export block, above the eager hydrate (T3-A)',
    duExpStart > 0 && duFirstLoadStmt > duExpStart
      && ui.indexOf(DU_EXP_MARK, duExpStart + 1) === -1);
  const duExpBlock = (duExpStart > 0 && duFirstLoadStmt > duExpStart)
    ? ui.slice(duExpStart, duFirstLoadStmt) : '';
  for (const n of DU_T3A_EXPORTS) {
    assert('dashboard-ui.js export block has a plain window.' + n + ' = ' + n + '; (T3-A)',
      new RegExp('^window\\.' + n + ' = ' + n + ';', 'm').test(duExpBlock));
    assert('dashboard-ui.js still declares function ' + n + ' (the export names a hoisted binding)',
      new RegExp('^function ' + n + '\\(', 'm').test(ui));
  }

  // ── Tranche 3 T3-A (2026-09-18): the dashboard-ui.js whole-file IIFE wrap ──
  // The file is now ONE IIFE, from (function () { on line 1 to the })(); after
  // the __NBD_CALL_REGISTRY block. House style from #1656/#1657: no
  // re-indentation and no 'use strict' (strict mode would also change the
  // this the goTo wrappers forward). The 21 names in T1_NAMES are private now.
  // The 15 exported names above, the 16 pre-existing window.X = X exports and
  // the _syncKanbanPrefControls alias keep their window slots. The legacy
  // showToast copy is gone, so bare showToast calls resolve to ui.js's global
  // exactly as before.
  assert('dashboard-ui.js opens the whole-file IIFE on line 1, ahead of the header comment (T3-A)',
    /^\(function \(\) \{\r?\n\/\*\*\r?\n \* dashboard-ui\.js/.test(ui));
  assert('dashboard-ui.js closes the IIFE straight after the __NBD_CALL_REGISTRY block, at end of file (T3-A)',
    /\r?\n  closeTips: closeTips\r?\n\}\);\r?\n\}\)\(\);\r?\n?$/.test(ui));
  // Brace-depth proof, not just the two ends: walk the CODE segments only
  // (jsSegments, so braces in strings, comments, regexes and template text do
  // not count; a template hole's opening brace sits in the code segment while
  // its closing brace sits in the string segment, so the hole's own brace is
  // skipped) and require exactly one depth-0 brace pair, closing at the file's
  // final })();. An early })(); would leave the rest of the file at top level,
  // where every function declaration is a window global again.
  {
    let depth = 0, zeroOpens = 0, closedAt = -1, minDepth = 0;
    for (const s of jsSegments(ui)) {
      if (s.kind !== 'code') continue;
      const hole = ui.startsWith('$' + '{', s.start);
      for (let i = s.start + (hole ? 2 : 0); i < s.end; i++) {
        if (ui[i] === '{') { if (depth === 0) zeroOpens++; depth++; }
        else if (ui[i] === '}') { depth--; if (depth < minDepth) minDepth = depth; if (depth === 0) closedAt = i; }
      }
    }
    const tail = closedAt >= 0 ? ui.slice(closedAt) : '';
    assert('dashboard-ui.js has exactly one top-level brace pair (the IIFE body) and it closes at end of file (T3-A)',
      depth === 0 && minDepth === 0 && zeroOpens === 1 && /^\}\)\(\);\s*$/.test(tail),
      'depth-0 opens=' + zeroOpens + ' final depth=' + depth + ' min depth=' + minDepth
        + ' tail=' + JSON.stringify(tail.slice(0, 40)));
  }
  assert('dashboard-ui.js does not add \'use strict\' (T3-A house style)',
    !/^\s*['"]use strict['"]/m.test(ui));
  // Load-once guard, the shared Tranche 0 idiom. Before the wrap, the file's
  // top-level consts made a second execution a redeclaration SyntaxError that
  // aborted cleanly. Inside the IIFE a second run would succeed and bind the
  // document-level data-action / data-on-change / data-on-input delegates
  // twice. The guard has to run before the first listener and the exports.
  const duGuardIdx = ui.indexOf("if (__NBD_LOADED['dashboard-ui']) return;");
  assert('dashboard-ui.js has the __NBD_LOADED load-once guard, above the export block and every listener (T3-A)',
    /const __NBD_LOADED = window\.__NBD_LOADED = window\.__NBD_LOADED \|\| \{\};\r?\nif \(__NBD_LOADED\['dashboard-ui'\]\) return;\r?\n__NBD_LOADED\['dashboard-ui'\] = true;/.test(ui)
      && duGuardIdx > 0 && duExpStart > duGuardIdx
      && ui.indexOf('addEventListener(') > duGuardIdx);
  // The registry block: duRegBlock (2c-4g, above) captures the FIRST
  // Object.assign(window.__NBD_CALL_REGISTRY, ...) in the file. There must be
  // exactly one, and it must still be the full 24-entry block.
  const duRegAll = [...ui.matchAll(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/g)];
  assert('dashboard-ui.js has exactly ONE __NBD_CALL_REGISTRY Object.assign block and duRegBlock is it (T3-A)',
    duRegAll.length === 1 && duRegAll[0][1] === duRegBlock
      && (duRegBlock.match(/\b(\w+):\s*\1\b/g) || []).length === 24);
  const DU_T3A_PRIVATE = ['_nbdResolveCall', '_nbdOnChangeDelegate', '_calSignOff', 'openTips',
    'initAddressAutocomplete', '_abbreviateRoadSuffix', '_state2letter', 'selectAcItem',
    '_nbdRepName', '_nbdDocCompany', 'openDocTemplate', 'loadSavedTheme', 'syncKanbanPrefControls',
    'nbdAutoThemeIsDay', 'nbdAutoThemePreferredFor', '_nbdRememberManualTheme',
    '_isCrmAutoCollapseOn', 'goToWithTheme', 'dsPickTheme', 'syncMobileBadge',
    'applyCrmSecHeaderState'];
  for (const n of DU_T3A_PRIVATE) {
    assert(n + ' stays private to the dashboard-ui.js IIFE: declared, no window export in any form, no registry entry (T3-A)',
      new RegExp('^function ' + n + '\\(', 'm').test(ui)
        && !new RegExp('window\\.' + n + '\\s*=').test(ui)
        && !new RegExp('window\\[\\s*[\'"]' + n + '[\'"]\\s*\\]\\s*=').test(ui)
        && !new RegExp('\\b' + n + '\\s*:\\s*' + n + '\\b').test(duRegBlock));
  }
  // The file's pre-existing exports are untouched, byte for byte.
  const DU_KEPT_EXPORTS = ['setPhotoMode', 'formatMailingAddress', 'setKanbanDensity',
    'setKanbanBoldHierarchy', 'nbdComfortSet', 'nbdAutoThemeStart', 'nbdAutoThemeStop',
    'nbdAutoThemeApplyForNow', 'nbdComfortRefresh', 'toggleCrmToolsMenu', 'closeCrmToolsMenu',
    'toggleCrmFiltersMenu', 'closeCrmFiltersMenu', 'syncMobileToolsMenuActive',
    'setCrmAutoCollapse', 'setCrmSecHeaderEnabled'];
  for (const n of DU_KEPT_EXPORTS) {
    assert('dashboard-ui.js keeps its pre-existing window.' + n + ' = ' + n + '; line (T3-A leaves it as is)',
      new RegExp('^window\\.' + n + ' = ' + n + ';\\r?$', 'm').test(ui));
  }
  assert('dashboard-ui.js keeps the window._syncKanbanPrefControls alias (ui.js switchSettingsTab calls it)',
    /^window\._syncKanbanPrefControls = syncKanbanPrefControls;\r?$/m.test(ui));
  // showToast: ui.js owns the global. A local declaration of any kind would
  // shadow it for this file only, inside the IIFE, and flip every bare
  // showToast(...) here onto a different toast.
  assert('dashboard-ui.js declares no showToast of its own and no legacy toast queue (T3-A)',
    !/\b(?:function|const|let|var)\s+showToast\b/.test(ui)
      && !/\bprocessToastQueue\b/.test(ui)
      && !/toastQueue\.(?:push|shift)\(/.test(ui));
  assert('dashboard-state.js no longer declares the dead toastQueue / toastActive toast state (deleted 2026-09-22)',
    !/\b(?:const|let|var)\s+(?:toastQueue|toastActive)\b/.test(stateSrc));
  const duToastOwnerSrc = read(path.join(PRO_JS, 'ui.js'));
  assert('ui.js still owns the global showToast that dashboard-ui.js\'s bare calls resolve to',
    /^function showToast\(/m.test(duToastOwnerSrc) && /window\.showToast = showToast;/.test(duToastOwnerSrc));
  // ── Tranche 2c-4f: the dashboard-bootstrap.module.js settings cluster ──
  // First NON-dashboard-actions module in this tranche, and a real ES module —
  // so the 15 markup-dispatched settings/debug/export handlers just move from
  // window.X to a single __NBD_CALL_REGISTRY block (no IIFE). Three MUST-STAY
  // names keep BOTH window export + allowlist (self-read / ui.js cross-file).
  // loadSampleData stays on window + allowlist too, but it is owned by
  // dashboard-actions.js alone — see the pin block right below.
  const T2C4F_NAMES = ['runLeadAction', 'retryLoadLeads', 'copyDebugInfo',
    'testFirestoreRules', '_saveSettings', '_saveNotifSettings', '_saveCompanySettings',
    '_testNotif', '_resetEstimateDefaultsV2', '_saveSiteSlug', '_saveCompanyProfileSettings',
    '_resetCompanyProfileSettings', '_exportAllData', '_exportEstimates', '_exportPhotos'];
  const bootReg = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
  const bootRegBlock = (bootReg.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/) || ['', ''])[1];
  for (const n of T2C4F_NAMES) {
    assert('dashboard-bootstrap registers ' + n + ' in __NBD_CALL_REGISTRY (2c-4f)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootRegBlock));
    assert('allowlist no longer carries ' + n + ' (2c-4f — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-bootstrap no longer exposes window.' + n + ' (2c-4f off window)',
      !new RegExp('window\\.' + n + '\\s*=\\s*' + n + '\\b').test(bootReg));
  }
  // MUST-STAY: still window-exported in the module AND still allowlisted.
  for (const [n, why] of [['_saveEstimateDefaultsV2', 'intra-module self-read']]) {
    assert('dashboard-bootstrap keeps window.' + n + ' (' + why + ')',
      new RegExp('window\\.' + n + '\\s*=').test(bootReg) && new RegExp("'" + n + "'").test(stateSrc));
  }
  // loadSampleData (2026-09-22). The module used to carry a confirm-less twin
  // (no _leadsLoaded gate, no "you already have N leads" confirm) and export it
  // as window.loadSampleData. It was always shadowed: the module runs first
  // (document order, no top-level await) and dashboard-actions.js's top-level
  // declaration then replaces the window property. The twin was deleted; these
  // pins keep what the old MUST-STAY entry protected — a live, guarded,
  // markup-dispatchable loadSampleData — and keep the twin from coming back.
  {
    const lsdActions = read(path.join(PRO_JS, 'dashboard-actions.js'));
    const lsdAt = lsdActions.search(/^async function loadSampleData\(\)/m);
    const lsdBody = lsdAt >= 0 ? lsdActions.slice(lsdAt, lsdActions.indexOf('\n}', lsdAt)) : '';
    assert('dashboard-actions.js declares loadSampleData at top level (a window property, so data-fn dispatch reaches it)',
      lsdAt >= 0);
    assert('loadSampleData stays in _NBD_CALL_ALLOWLIST (window-dispatched, not registered)',
      /'loadSampleData'/.test(stateSrc));
    assert('loadSampleData refuses on an unconfirmed lead cache (_leadsLoaded gate)',
      /if \(window\._leadsLoaded !== true\)[\s\S]{0,200}return;/.test(lsdBody));
    assert('loadSampleData asks before seeding into a populated book (nbdConfirm-first confirm)',
      /window\.nbdConfirm \|\| \(\(m\) => Promise\.resolve\(window\.confirm\(m\)\)\)/.test(lsdBody)
        && /if\(!\(await _ask\(/.test(lsdBody));
    assert('loadSampleData seeds through demo.js seedDemoLeads (whose phoneDigits stamp phone-digits.test.js pins)',
      /await seedDemoLeads\(user\.uid\)/.test(lsdBody));
    assert('dashboard-bootstrap.module.js has no loadSampleData twin and no window.loadSampleData export',
      !/\bfunction loadSampleData\b/.test(bootReg) && !/window\.loadSampleData\s*=/.test(bootReg)
        && !/window\[\s*['"]loadSampleData['"]\s*\]\s*=/.test(bootReg));
  }

  // ── Tranche 3 T3-C (2026-09-17): the settings-tab loader sextet ──
  // _loadCompanySettings and _loadCompanyProfileSettings were the ONLY two
  // MUST-STAY names left over from 2c-4f — kept window-exported + allowlisted
  // because switchSettingsTab (ui.js) read them as bare window.X() calls. That
  // was the same shape as four other settings-tab loaders that had never been
  // touched at all (_loadAccessInfo, _loadBillingInfo, _loadNotifSettings,
  // _loadProfileSettings — no prior tranche, still auto-globals). Rewiring
  // ui.js's reads to the registry unblocked graduating all six together.
  const T3C_UI_EDGE_NAMES = ['_loadCompanySettings', '_loadCompanyProfileSettings',
    '_loadAccessInfo', '_loadBillingInfo', '_loadNotifSettings', '_loadProfileSettings'];
  const uiJsSrc = read(path.join(PRO_JS, 'ui.js'));
  for (const n of T3C_UI_EDGE_NAMES) {
    assert('dashboard-bootstrap registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootRegBlock));
    assert('allowlist no longer carries ' + n + ' (T3-C — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-bootstrap no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=\\s*' + n + '\\b').test(bootReg));
    assert('ui.js switchSettingsTab reads ' + n + ' off the registry, not bare window.' + n,
      new RegExp('_nbdReg\\.' + n + '\\b').test(uiJsSrc) && !new RegExp('window\\.' + n + '\\s*\\(').test(uiJsSrc));
  }

  // ── Tranche 3 T3-C (2026-09-18): estimates-bundle render aliases +
  // settings/estimate view hooks ──
  // Four single-consumer names, each a callable whose only reader already
  // tolerated its absence: nbdSyncSizeBtns (prefs-boot → ui.js
  // switchSettingsTab), renderProductLibrary / renderJobTemplatesLibrary
  // (lazy 'estimates' bundle → dashboard-actions.js goTo fallbacks) and
  // toggleInsuranceOverlay (a <script src> inside tpl-view-est → #estMode's
  // data-on-after + dashboard-widgets.js viewEstimate). Off-window status is
  // the T1_NAMES walk above; these pin the registry half of each edge.
  // Block-scoped so its consts cannot collide with sibling T3-C blocks.
  {
    // nbdSyncSizeBtns: a real declaration inside prefs-boot's IIFE, joined to
    // the file's ONE existing registry block (regBlock = that block). The
    // IIFE body is not indented, so this text pin cannot tell inside-the-IIFE
    // from top-level; the vm run at the end of this block owns the scope claim.
    assert('prefs-boot declares nbdSyncSizeBtns as a function declaration (not a window-assigned expression)',
      /^function nbdSyncSizeBtns\(\) \{/m.test(prefsBoot));
    assert('prefs-boot registers nbdSyncSizeBtns in its __NBD_CALL_REGISTRY block (T3-C)',
      /\bnbdSyncSizeBtns:\s*nbdSyncSizeBtns\b/.test(regBlock));
    assert('ui.js switchSettingsTab reads nbdSyncSizeBtns off the registry, guarded (no-op if absent)',
      /typeof window\.__NBD_CALL_REGISTRY\.nbdSyncSizeBtns === 'function'\) \{\s*window\.__NBD_CALL_REGISTRY\.nbdSyncSizeBtns\(\);/.test(uiJsSrc));
    const t3cDashRaw = read(path.join(ROOT, 'docs/pro/dashboard.html'));
    assert('dashboard.html runs prefs-boot (registers nbdSyncSizeBtns) before ui.js (reads it)',
      t3cDashRaw.indexOf('src="js/dashboard-ui-prefs-boot.js') !== -1
        && t3cDashRaw.indexOf('src="js/dashboard-ui-prefs-boot.js') < t3cDashRaw.indexOf('src="js/ui.js'));

    // renderProductLibrary / renderJobTemplatesLibrary: lazy-bundle consumer
    // rule — the goTo branch must read the registry INSIDE the preload's
    // .then (load → re-read), never a reference captured before the bundle
    // arrived, and must no-op when the entry is absent (fail-closed).
    const t3cDaSrc = read(path.join(PRO_JS, 'dashboard-actions.js'));
    for (const [n, owner, view, ns] of [
      ['renderProductLibrary', 'product-library.js', 'products', 'window._productLib'],
      ['renderJobTemplatesLibrary', 'job-templates-ui.js', 'job-templates', 'window.JobTemplatesUI']]) {
      const ownerSrc = read(path.join(PRO_JS, owner));
      assert(owner + ' registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
        new RegExp('Object\\.assign\\(window\\.__NBD_CALL_REGISTRY, \\{ ' + n + ': render \\}\\);').test(ownerSrc));
      assert(owner + ' guards the registry object instead of overwriting it (shared across the bundle)',
        /window\.__NBD_CALL_REGISTRY = window\.__NBD_CALL_REGISTRY \|\| Object\.create\(null\);/.test(ownerSrc));
      const start = t3cDaSrc.indexOf("if(name==='" + view + "') {");
      const branch = start === -1 ? '' : t3cDaSrc.slice(start, t3cDaSrc.indexOf('\n  }', start));
      const thenAt = branch.indexOf('_lazyPreload.then(function () {');
      const readAt = branch.indexOf('window.__NBD_CALL_REGISTRY.' + n + '()');
      assert("goTo('" + view + "') reads " + n + ' off the registry only after the lazy bundle loads',
        thenAt !== -1 && readAt > thenAt && branch.indexOf(ns + '.render()') > thenAt);
      assert("goTo('" + view + "') calls " + n + ' only behind a typeof guard (absent entry = no-op)',
        branch.indexOf("typeof window.__NBD_CALL_REGISTRY." + n + " === 'function') { ") !== -1);
    }

    // toggleInsuranceOverlay: the whole 1-name file is IIFE-wrapped so the
    // declaration cannot auto-global; the Object.assign form is what wiring
    // audit (d) reads to resolve #estMode's data-on-after.
    const insToggleSrc = read(path.join(PRO_JS, 'dashboard-insurance-overlay-toggle.js'));
    assert('dashboard-insurance-overlay-toggle.js is IIFE-wrapped (its function leaves window)',
      /^\(function \(\) \{\r?$/m.test(insToggleSrc) && /\}\)\(\);$/.test(insToggleSrc.trimEnd()));
    assert('dashboard-insurance-overlay-toggle.js registers toggleInsuranceOverlay (Object.assign form)',
      /Object\.assign\(window\.__NBD_CALL_REGISTRY, \{ toggleInsuranceOverlay: toggleInsuranceOverlay \}\);/.test(insToggleSrc));
    assert('allowlist no longer carries toggleInsuranceOverlay (T3-C — registry replaced it)',
      !/'toggleInsuranceOverlay'/.test(stateSrc));
    assert('dashboard.html still wires #estMode data-on-after to toggleInsuranceOverlay',
      /id="estMode" data-on-change="calcTierPrices" data-on-after="toggleInsuranceOverlay"/.test(t3cDashRaw));
    const t3cWidgetsSrc = read(path.join(PRO_JS, 'dashboard-widgets.js'));
    // Sliced to viewEstimate's own body, and the local _nbdReg binding is
    // part of the match: no global _nbdReg exists anywhere under docs/, so a
    // dropped binding would ReferenceError mid-viewEstimate.
    const veStart = t3cWidgetsSrc.indexOf('function viewEstimate(id) {');
    const veEnd = veStart === -1 ? -1 : t3cWidgetsSrc.slice(veStart).search(/\n\}\r?\n/);
    const veBody = veEnd === -1 ? '' : t3cWidgetsSrc.slice(veStart, veStart + veEnd);
    assert('dashboard-widgets.js viewEstimate binds _nbdReg to the registry and reads toggleInsuranceOverlay off it, guarded',
      /(?:var|let|const) _nbdReg = window\.__NBD_CALL_REGISTRY;\s*if \(_nbdReg && typeof _nbdReg\.toggleInsuranceOverlay === 'function'\) \{\s*_nbdReg\.toggleInsuranceOverlay\(\);/.test(veBody));
    // Behaviour, not just text: run the real file TWICE in one context (the
    // tpl-view-est hydration re-executes it) with window === the global, so a
    // leaked top-level declaration would show up as a window property.
    const vm = require('vm');
    const els = { estMode: { value: 'insurance' }, estInsuranceBlock: { style: { display: '' } } };
    const keep = function () {};
    const sb = { document: { getElementById: (id) => els[id] || null }, Object, __NBD_CALL_REGISTRY: { keep } };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(insToggleSrc, sb);
    vm.runInContext(insToggleSrc, sb);
    const reg = sb.__NBD_CALL_REGISTRY;
    const fn = reg && reg.toggleInsuranceOverlay;
    assert('toggleInsuranceOverlay: re-execution keeps the existing registry (no clobber) and leaks nothing onto window',
      typeof fn === 'function' && reg.keep === keep && !('toggleInsuranceOverlay' in sb));
    let shown = '', hidden = '';
    if (typeof fn === 'function') {
      fn(); shown = els.estInsuranceBlock.style.display;
      els.estMode.value = 'cash'; fn(); hidden = els.estInsuranceBlock.style.display;
    }
    assert('toggleInsuranceOverlay (via the registry) shows the insurance block for insurance, hides it for cash',
      shown === 'block' && hidden === 'none', 'got ' + JSON.stringify([shown, hidden]));

    // nbdSyncSizeBtns module scope, behaviourally: run the real prefs-boot
    // with window === the global. A declaration hoisted out of the IIFE, or
    // any window['nbdSyncSizeBtns'] re-export, lands as an own property of
    // the global; the text pins above cannot see either. document/navigator
    // are an inert Proxy (every read/call returns the stub), localStorage a
    // Map.
    const pbStub = new Proxy(function () {}, {
      get: (t, k) => (k === Symbol.toPrimitive ? () => '' : typeof k === 'symbol' ? undefined : pbStub),
      apply: () => pbStub, construct: () => pbStub, set: () => true,
    });
    const pbStore = new Map();
    const pbSb = { document: pbStub, navigator: pbStub, localStorage: {
      getItem: (k) => (pbStore.has(k) ? pbStore.get(k) : null),
      setItem: (k, v) => { pbStore.set(k, String(v)); },
      removeItem: (k) => { pbStore.delete(k); } } };
    pbSb.window = pbSb;
    vm.createContext(pbSb);
    let pbErr = '';
    try { vm.runInContext(prefsBoot, pbSb); } catch (e) { pbErr = String(e && e.message || e); }
    const pbFn = pbSb.__NBD_CALL_REGISTRY && pbSb.__NBD_CALL_REGISTRY.nbdSyncSizeBtns;
    assert('prefs-boot keeps nbdSyncSizeBtns off window (vm: not an own property of the global) and registers it',
      !pbErr && !Object.prototype.hasOwnProperty.call(pbSb, 'nbdSyncSizeBtns') && typeof pbFn === 'function',
      pbErr ? 'prefs-boot threw under the vm stubs: ' + pbErr : 'nbdSyncSizeBtns leaked onto window or is missing from the registry');
    // …and the registry entry is the real repaint, not a placeholder.
    const pbBtns = [{ dataset: { size: 'large' }, style: {} }, { dataset: { size: 'default' }, style: {} }];
    let pbPainted = [], pbCallErr = '';
    if (typeof pbFn === 'function') {
      pbStore.set('nbd_ui_size', 'large');
      pbSb.document = { querySelectorAll: (sel) => (sel === '.nbd-size-btn' ? pbBtns : []) };
      try { pbFn(); } catch (e) { pbCallErr = String(e && e.message || e); }
      pbPainted = pbBtns.map((b) => b.style.fontWeight);
    }
    assert('nbdSyncSizeBtns (via the registry) paints the saved size button active and the rest inactive',
      !pbCallErr && pbPainted[0] === '800' && pbPainted[1] === '',
      pbCallErr ? 'threw: ' + pbCallErr : 'got ' + JSON.stringify(pbPainted));
  }

  // ── Tranche 3 T3-C (2026-09-17): crm-portal-bridge.js + rep-report-
  // generator.js edges ──
  // Two more one-consumer edges off dashboard-bootstrap.module.js, re-derived
  // from scratch after the plan doc's original "5" / "4" / "4" estimates
  // proved partly wrong on inspection: crm-portal-bridge.js's 5 held up
  // exactly; rep-report-generator.js's 4 held up as 3 real functions plus
  // _reports, a data cache (not a callable) deliberately routed through a
  // rep-report-generator.js-local cache instead of the registry — see below;
  // the third candidate edge (crm-pipeline.js) turned out to have ZERO
  // convertible names (misattributed T3-D-cluster ownership plus a genuine
  // _dragId shared-mutable-state landmine) and was not attempted.
  const T3C_PORTAL_BRIDGE_NAMES = ['toggleInsuranceFields', 'refreshSubTypeAndTrades',
    'setSelectedTrades', '_deleteLead', '_loadDeletedLeads'];
  const T3C_REPORT_GEN_NAMES = ['_saveReport', '_deleteReport', '_loadReports'];
  const crmPortalBridgeSrc = read(path.join(PRO_JS, 'crm-portal-bridge.js'));
  const repReportGenSrc = read(path.join(PRO_JS, 'rep-report-generator.js'));
  for (const n of [...T3C_PORTAL_BRIDGE_NAMES, ...T3C_REPORT_GEN_NAMES]) {
    assert('dashboard-bootstrap registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootRegBlock));
    assert('allowlist never carried ' + n + ' (T3-C — no markup dispatch, pure cross-file call)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('dashboard-bootstrap no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(bootReg));
  }
  for (const n of T3C_PORTAL_BRIDGE_NAMES) {
    assert('crm-portal-bridge.js reads ' + n + ' off the registry, not bare window.' + n,
      new RegExp('_nbdReg\\.' + n + '\\b|__NBD_CALL_REGISTRY\\.' + n + '\\b').test(crmPortalBridgeSrc)
        && !new RegExp('window\\.' + n + '\\b').test(crmPortalBridgeSrc));
  }
  for (const n of ['_saveReport', '_deleteReport', '_loadReports']) {
    assert('rep-report-generator.js reads ' + n + ' off the registry, not bare window.' + n,
      new RegExp('_nbdReg\\.' + n + '\\b').test(repReportGenSrc)
        && !new RegExp('window\\.' + n + '\\b').test(repReportGenSrc));
  }
  // _reports is a data cache, not a callable — it can't go through the call
  // registry the way the 3 functions above do. rep-report-generator.js keeps
  // its own local cache (populated from _loadReports()'s return value, not
  // by re-reading window._reports) instead; dashboard-bootstrap.module.js's
  // _loadReports still sets window._reports as a harmless, now-unread,
  // internal implementation detail — deliberately left in place rather than
  // touched for no behavioral gain.
  assert('rep-report-generator.js no longer reads window._reports directly',
    !/window\._reports\b/.test(repReportGenSrc));
  assert('rep-report-generator.js caches its own report list locally',
    /_reportsCache/.test(repReportGenSrc));

  // ── Tranche 3 T3-C (2026-09-18): customer-bootstrap.module.js ->
  // customer-tasks-ui.js edge ──
  // customer.html has no dashboard-bootstrap.module.js, so this is the first
  // use of __NBD_CALL_REGISTRY on that page — a fresh registry object, not
  // the dashboard one. _fetchPhotosRaw/loadPhotos/setLightboxSource are
  // module-top-level and registered in one Object.assign block at the end
  // of the file; _nbdTsToDate is declared inside a render function (not
  // module scope), so it registers itself inline near its own definition —
  // both shapes are asserted below. _bookingAsk/_bookingCustomerName/
  // _bookingUrl/_currentStage were also census candidates for this edge but
  // are shared DATA (strings set on one event, read on another), not
  // callables — they stay on window, same reasoning as _reports above.
  const custBootSrc = read(path.join(PRO_JS, 'customer-bootstrap.module.js'));
  const custTasksSrc = read(path.join(PRO_JS, 'customer-tasks-ui.js'));
  for (const n of ['_fetchPhotosRaw', 'loadPhotos', 'setLightboxSource']) {
    assert('customer-bootstrap.module.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(custBootSrc));
  }
  assert('customer-bootstrap.module.js registers _nbdTsToDate inline (declared inside a render function, not module scope)',
    /window\.__NBD_CALL_REGISTRY\._nbdTsToDate = tsToDate;/.test(custBootSrc));
  assert('_fetchPhotosRaw and setLightboxSource are real declarations now, not window-assigned anonymous expressions',
    /^function _fetchPhotosRaw\(leadId\) \{/m.test(custBootSrc) && /^function setLightboxSource\(srcArray, idx\) \{/m.test(custBootSrc));
  assert('customer-tasks-ui.js\'s loadPhotosByPhase reads _fetchPhotosRaw off the registry, not bare window',
    /window\.__NBD_CALL_REGISTRY\._fetchPhotosRaw\(leadId\)/.test(custTasksSrc));
  assert('both photo-delete handlers read loadPhotos off the registry, not bare window',
    (custTasksSrc.match(/window\.__NBD_CALL_REGISTRY\.loadPhotos\(window\._customerId\)/g) || []).length === 2);
  assert('openPhotoLightbox reads setLightboxSource off the registry, not bare window',
    /_nbdReg\.setLightboxSource\(srcArray, Number\(idx\) \|\| 0\)/.test(custTasksSrc));
  assert('the project-timeline milestone renderer reads _nbdTsToDate off the registry, not bare window',
    /_nbdReg\._nbdTsToDate\(stageDates\[milestone\.stage\]\)/.test(custTasksSrc));

  // ── Tranche 3 T3-C (2026-09-18, T3-5): the customer-tasks-ui.js cluster +
  // logCommunication ──
  // #1657 IIFE-wrapped customer-tasks-ui.js but deliberately left these 6
  // cross-file callables on window; now they are real IIFE-scoped
  // declarations registered in ONE block at the TOP of the wrap (hoisted, so
  // a later throw in the 2500-line body can't strand them). logCommunication
  // joins its owner's existing end-of-file block above. customer.html's
  // _nbdCustomerActionDispatch walks WINDOW for data-action/data-change-action,
  // so none of these may ever become markup-dispatched — asserted below.
  const T3C5_TASKS = ['renderCoverHero', 'loadPhotosByPhase', 'loadNewPortalSections',
    'setupContactTab', 'loadCommunicationLog', 'logGeneratedDoc'];
  for (const n of T3C5_TASKS) {
    assert('customer-tasks-ui.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(custTasksSrc));
    assert('customer-tasks-ui.js declares ' + n + ' as a real IIFE-scoped function, not a window assignment',
      new RegExp('^(async )?function ' + n + '\\(', 'm').test(custTasksSrc)
      && !new RegExp('window\\.' + n + '\\s*=').test(custTasksSrc));
  }
  const t3c5RegAt = custTasksSrc.indexOf('Object.assign(window.__NBD_CALL_REGISTRY, {');
  assert('customer-tasks-ui.js\'s registry block sits at the TOP of the IIFE (before the first IIFE-level statement), behind the || guard',
    t3c5RegAt > 0
    && t3c5RegAt < custTasksSrc.indexOf('window.nbdNavCount = function')
    && custTasksSrc.indexOf('window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);') > 0
    && custTasksSrc.indexOf('window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);') < t3c5RegAt);
  assert('customer-tasks-ui.js\'s in-file callers use the bare IIFE bindings',
    /\n\s+renderCoverHero\(updates\.coverPhotoUrl\);/.test(custTasksSrc)
    && /\n\s+logGeneratedDoc\(type, data\);/.test(custTasksSrc)
    && /\n\s+loadCommunicationLog\(leadId\)\r?\n\s+\]\);/.test(custTasksSrc));
  assert('customer-bootstrap.module.js reads renderCoverHero off the registry, typeof-guarded (no-op if absent)',
    /if \(window\.__NBD_CALL_REGISTRY && typeof window\.__NBD_CALL_REGISTRY\.renderCoverHero === 'function'\) \{\r?\n\s+window\.__NBD_CALL_REGISTRY\.renderCoverHero\(lead\.coverPhotoUrl \|\| null\);/.test(custBootSrc));
  assert('customer-bootstrap.module.js\'s loadAllCustomerPhotos reads loadPhotosByPhase off the registry (absent → Promise.resolve())',
    /\(window\.__NBD_CALL_REGISTRY && typeof window\.__NBD_CALL_REGISTRY\.loadPhotosByPhase === 'function'\)\r?\n\s+\? window\.__NBD_CALL_REGISTRY\.loadPhotosByPhase\(leadId\) : Promise\.resolve\(\),/.test(custBootSrc));
  assert('customer-bootstrap.module.js calls loadNewPortalSections + setupContactTab off the registry INSIDE the existing try/catch (absent → caught, both skipped)',
    /try \{\r?\n\s+await window\.__NBD_CALL_REGISTRY\.loadNewPortalSections\(id\);\r?\n\s+\/\/ Setup contact tab\r?\n\s+window\.__NBD_CALL_REGISTRY\.setupContactTab\(lead\);\r?\n\s+\} catch \(e\) \{ console\.warn\('Portal sections render failed:'/.test(custBootSrc));
  assert('customer-bootstrap.module.js registers logCommunication (a real module-scope declaration) in its end-of-file block',
    /^async function logCommunication\(leadId, type, content, extra = \{\}\) \{/m.test(custBootSrc)
    && /\blogCommunication:\s*logCommunication\b/.test(custBootSrc));
  const t3c5Qab = read(path.join(PRO_JS, 'customer-quick-action-bar.js'));
  assert('customer-quick-action-bar.js reads logCommunication off the registry and bails (no log, no throw) if absent',
    /if \(!leadId \|\| !_nbdReg \|\| typeof _nbdReg\.logCommunication !== 'function'\) return;/.test(t3c5Qab)
    && /_nbdReg\.logCommunication\(leadId, type, label\)/.test(t3c5Qab));
  const t3c5Aid = read(path.join(PRO_JS, 'customer-ai-drafts-panel.js'));
  assert('customer-ai-drafts-panel.js reads loadCommunicationLog off the registry, guarded',
    /if \(_nbdReg && typeof _nbdReg\.loadCommunicationLog === 'function' && window\._customerId\) \{\r?\n\s+_nbdReg\.loadCommunicationLog\(window\._customerId\);/.test(t3c5Aid));
  const t3c5Pre = read(path.join(PRO_JS, 'doc-preflight.js'));
  assert('doc-preflight.js reads logGeneratedDoc off the registry, guarded (no-op on dashboard.html, where it never exists)',
    /if \(_logDocReg && typeof _logDocReg\.logGeneratedDoc === 'function'\) \{\r?\n\s+try \{ _logDocReg\.logGeneratedDoc\(state\.type, mergedData\); \}/.test(t3c5Pre));
  // The window-walking dispatcher can't reach registry-only names: none of
  // the 7 may appear as a data-action / data-change-action value anywhere.
  const t3c5Markup = [read(path.join(ROOT, 'docs/pro/customer.html'))];
  for (const f of fs.readdirSync(PRO_JS)) if (/\.js$/.test(f)) t3c5Markup.push(read(path.join(PRO_JS, f)));
  const t3c5Dispatched = [...T3C5_TASKS, 'logCommunication'].filter((n) =>
    t3c5Markup.some((src) => new RegExp('data-(?:change-)?action=\\\\?["\']' + n + '\\\\?["\']').test(src)));
  assert('none of the T3-5 registry-only names is data-action/data-change-action dispatched (the customer.html dispatcher walks window) — '
    + (t3c5Dispatched.join(', ') || 'clean'), t3c5Dispatched.length === 0);
  // Runtime proof, not just regex: vm-run the REAL file with window === the
  // sandbox global (as in a browser), so "off window" means genuinely absent.
  {
    const vm = require('vm');
    const t3c5Run = (preRegistry) => {
      const els = {};
      const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, appendChild() {},
        querySelector() { return null; }, querySelectorAll() { return []; } });
      const sb = { console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {},
        addEventListener() {},
        document: { readyState: 'loading', head: { appendChild() {} }, body: el('body'),
          createElement: () => el('_created'), getElementById: el, addEventListener() {},
          querySelector: () => null, querySelectorAll: () => [] } };
      sb.window = sb;
      if (preRegistry) sb.__NBD_CALL_REGISTRY = preRegistry;
      let threw = null;
      try { vm.createContext(sb); vm.runInContext(custTasksSrc, sb); } catch (e) { threw = e; }
      return { sb, els, threw };
    };
    const fresh = t3c5Run(null);
    const reg = fresh.sb.__NBD_CALL_REGISTRY || {};
    assert('customer-tasks-ui.js executes cleanly in a fresh page (registry created by its own || guard)'
      + (fresh.threw ? ' — ' + fresh.threw.message : ''), !fresh.threw && !!fresh.sb.__NBD_CALL_REGISTRY);
    assert('at runtime all 6 are callable off __NBD_CALL_REGISTRY',
      T3C5_TASKS.every((n) => typeof reg[n] === 'function'));
    assert('at runtime none of the 6 is on window (while window exports like generateCustomerDoc/nbdNavCount still are)',
      T3C5_TASKS.every((n) => !(n in fresh.sb))
      && typeof fresh.sb.generateCustomerDoc === 'function' && typeof fresh.sb.nbdNavCount === 'function');
    if (typeof reg.renderCoverHero === 'function') reg.renderCoverHero('https://x.test/a.jpg');
    assert('the registered renderCoverHero is the real renderer (paints #coverHero)',
      fresh.els.coverHero && fresh.els.coverHero.style.display === 'block');
    // loadNewPortalSections must call its IIFE-local loadCommunicationLog, never
    // a stale window copy (the sync prefix of the real one paints #communicationLog).
    let staleCalled = false;
    fresh.sb.loadProjectTimeline = fresh.sb.loadInvoices = fresh.sb.loadReports = () => Promise.resolve();
    fresh.sb.loadCommunicationLog = () => { staleCalled = true; return Promise.resolve(); };
    if (typeof reg.loadNewPortalSections === 'function') reg.loadNewPortalSections('L1');
    assert('loadNewPortalSections calls the IIFE-local loadCommunicationLog, not window.loadCommunicationLog',
      !staleCalled && /Sign in to view messages/.test((fresh.els.communicationLog || {}).innerHTML || ''));
    // Module-first load order: the bootstrap's registry (with its entries) survives.
    const pre = Object.create(null);
    const preLoadPhotos = () => {};
    pre.loadPhotos = preLoadPhotos;
    const second = t3c5Run(pre);
    assert('when customer-bootstrap.module.js registered first, its registry object and entries survive and gain the 6',
      !second.threw && second.sb.__NBD_CALL_REGISTRY === pre && pre.loadPhotos === preLoadPhotos
      && T3C5_TASKS.every((n) => typeof pre[n] === 'function'));
  }
  // ── Tranche 3 T3-C (2026-09-18): two single-name edges outside the
  // dashboard shell ──
  // photo-report.js -> customer-photo-report-picker.js: _reportOptions was
  // already a real declaration inside photo-report.js's IIFE, exported under a
  // DIFFERENT public name — now registered under that same public name
  // (rename-on-register, the STAGE_ROLE precedent). photo-report.js rides the
  // lazy ScriptLoader 'photos' bundle, so it must create-or-reuse the registry,
  // never replace it (customer.html's own entries are already in it by then —
  // tests/photo-report-builder.test.js executes that behaviourally).
  // Block-scoped: parallel T3-C PRs append beside this section.
  {
    const photoReportSrc = read(path.join(PRO_JS, 'photo-report.js'));
    const prPickerSrc = read(path.join(PRO_JS, 'customer-photo-report-picker.js'));
    assert('photo-report.js registers _reportOptions as __NBD_CALL_REGISTRY._photoReportOptions (T3-C)',
      /window\.__NBD_CALL_REGISTRY = window\.__NBD_CALL_REGISTRY \|\| Object\.create\(null\);\r?\n\s*window\.__NBD_CALL_REGISTRY\._photoReportOptions = _reportOptions;/.test(photoReportSrc));
    // Anchors WHERE `reg` comes from, not just the second line: `var reg =
    // window;` would put the read back on window as `reg._photoReportOptions`,
    // which the T1_NAMES walk above cannot see. tests/photo-report-builder.test.js
    // executes the picker against a registry + window decoy for any other spelling.
    assert('customer-photo-report-picker.js resolves _photoReportOptions off the registry, null when absent',
      /var reg = window\.__NBD_CALL_REGISTRY;\r?\n\s*return \(reg && typeof reg\._photoReportOptions === 'function'\) \? reg\._photoReportOptions : null;/.test(prPickerSrc));
    assert('all 3 picker call sites (resetState, bundle-warm gate, re-seed) go through that resolver',
      /var optsFn = _reportOptionsFn\(\);/.test(prPickerSrc)
      && /if \(!_reportOptionsFn\(\)\r?\n\s*&& window\.ScriptLoader/.test(prPickerSrc)
      && /if \(_reportOptionsFn\(\) && state\) setPreset\(state\.mode\);/.test(prPickerSrc));
    // pro-analytics.js -> pro-analytics-gate.js: both are ES modules on
    // analytics.html, which loads no other registry owner, so pro-analytics.js
    // creates the registry. Registered right beside the declaration (not at file
    // end) so the entry exists at the same point in module evaluation the old
    // window assignment did — the gate's onReady timing is unchanged.
    const proAnalyticsSrc = read(path.join(PRO_JS, 'pages', 'pro-analytics.js'));
    const proAnalyticsGateSrc = read(path.join(PRO_JS, 'pages', 'pro-analytics-gate.js'));
    assert('pro-analytics.js declares bootAnalytics and registers it right beside the declaration (T3-C)',
      /\nasync function bootAnalytics\(\) \{[\s\S]{0,120}?\r?\n\}\r?\nwindow\.__NBD_CALL_REGISTRY = window\.__NBD_CALL_REGISTRY \|\| Object\.create\(null\);\r?\nwindow\.__NBD_CALL_REGISTRY\.bootAnalytics = bootAnalytics;/.test(proAnalyticsSrc));
    assert('pro-analytics-gate.js boots through the registry, typeof-guarded (missing entry = no boot)',
      /const _nbdReg = window\.__NBD_CALL_REGISTRY;\r?\n\s*if \(_nbdReg && typeof _nbdReg\.bootAnalytics === 'function'\) _nbdReg\.bootAnalytics\(\);/.test(proAnalyticsGateSrc));
    // A classic-script load would turn the top-level `async function
    // bootAnalytics` back into an implicit window global — invisible to the
    // T1_NAMES walk above, which only sees explicit window.X text.
    const analyticsTags = read(path.join(ROOT, 'docs/pro/analytics.html'))
      .match(/<script\b[^>]*\bsrc="[^"]*\/pro-analytics\.js(?:\?[^"]*)?"[^>]*>/g) || [];
    assert('analytics.html loads pro-analytics.js only as type="module" (a classic load would auto-global bootAnalytics)',
      analyticsTags.length > 0 && analyticsTags.every((t) => /\btype="module"/.test(t)),
      analyticsTags.join(' | ') || 'no pro-analytics.js tag found');
    {
      // Behavioural twin of the text pins above, since the T1_NAMES walk only
      // sees the dotted `window.X` spelling. Evaluate pro-analytics.js's top
      // level (import lines stripped — the gstatic URL cannot load under node)
      // inside a strict function scope, which is what module scope amounts to
      // here, against stub window/document. DOMContentLoaded never fires, so the
      // entry must come from top-level evaluation itself, and no assignment
      // shape (dotted, bracketed, globalThis) may leave the name on the global.
      const vmT3c = require('vm');
      const win = { addEventListener: () => {} };
      const box = { window: win, document: { addEventListener: () => {} }, console };
      vmT3c.createContext(box);
      let evalErr = null;
      try {
        vmT3c.runInContext("(function () { 'use strict';\n"
          + proAnalyticsSrc.replace(/^import [^\n]*\n/gm, '') + '\n})();', box);
      } catch (e) { evalErr = e; }
      assert('pro-analytics.js top level evaluates under stubs (the checks below are live)',
        !evalErr, evalErr && evalErr.message);
      assert('evaluating pro-analytics.js registers bootAnalytics without waiting for DOMContentLoaded',
        !!win.__NBD_CALL_REGISTRY && typeof win.__NBD_CALL_REGISTRY.bootAnalytics === 'function');
      assert('evaluating pro-analytics.js leaves bootAnalytics off the global object, in any spelling',
        !Object.prototype.hasOwnProperty.call(win, 'bootAnalytics')
        && !Object.prototype.hasOwnProperty.call(box, 'bootAnalytics'));
    }
  }

  // ── Tranche 3 T3-C (2026-09-18): the pins + zones CRUD edges off
  // dashboard-bootstrap.module.js ──
  // maps-overlays.js's dropPin/deletePin and dashboard-actions.js's
  // saveZone/deleteZone. _zones (a loaded-zones cache) and
  // _DASH_DOC_PREREQUISITES (a static doc-type config object) were also
  // census candidates for these two edges but are DATA, not callables —
  // stay on window, same reasoning as _reports above.
  const mapsOverlaysSrc = read(path.join(PRO_JS, 'maps-overlays.js'));
  const dashActionsSrc = read(path.join(PRO_JS, 'dashboard-actions.js'));
  for (const n of ['_savePin', '_deletePin', '_saveZone', '_deleteZone']) {
    assert('dashboard-bootstrap.module.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootReg));
    assert('dashboard-bootstrap.module.js no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(bootReg));
  }
  assert('_savePin and _deletePin are real declarations, registered in scope for the 3 self-references below',
    /async function _savePin\(data\) \{/.test(bootReg) && /async function _deletePin\(id\) \{/.test(bootReg));
  assert('_saveZone and _deleteZone are real declarations too',
    /async function _saveZone\(data\) \{/.test(bootReg) && /async function _deleteZone\(id\) \{/.test(bootReg));
  assert('all 3 in-module self-references to _savePin were rewired to bare calls (D2D pin-to-lead linking)',
    (bootReg.match(/(?<!window\.)(?<!function )\b_savePin\(/g) || []).length === 3
    && !/window\._savePin\(/.test(bootReg));
  assert('maps-overlays.js\'s dropPin reads _savePin off the registry, not bare window',
    /window\.__NBD_CALL_REGISTRY\._savePin\(\{lat,lng,status,color,notes\}\)/.test(mapsOverlaysSrc));
  assert('maps-overlays.js\'s deletePin reads _deletePin off the registry, not bare window',
    /_nbdReg\._deletePin\(id\)/.test(mapsOverlaysSrc) && !/window\._deletePin\(/.test(mapsOverlaysSrc));
  assert('dashboard-actions.js\'s saveZone reads _saveZone off the registry, not bare window',
    /_nbdReg\._saveZone\(\{ name, color: fillColor, points: pts/.test(dashActionsSrc));
  assert('dashboard-actions.js\'s deleteZone reads _deleteZone off the registry, not bare window',
    /_nbdReg\._deleteZone\(zone\.id\)/.test(dashActionsSrc) && !/window\._deleteZone\(/.test(dashActionsSrc));

  // ── Tranche 3 T3-C (2026-09-18): the estimate CRUD edge off
  // dashboard-bootstrap.module.js ──
  // estimate-crm-ops.js's renameEstimateAction/deleteEstimateAction/
  // assignEstimateAction. _duplicateEstimate was NOT a candidate for this
  // edge (multiple consumers, out of scope for a one-consumer T3-C slice).
  const estCrmOpsSrc = read(path.join(PRO_JS, 'estimate-crm-ops.js'));
  for (const n of ['_deleteEstimate', '_renameEstimate', '_assignEstimateToLead']) {
    assert('dashboard-bootstrap.module.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootReg));
    assert('dashboard-bootstrap.module.js no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(bootReg));
  }
  assert('_deleteEstimate, _renameEstimate, _assignEstimateToLead are real declarations',
    /async function _deleteEstimate\(id\) \{/.test(bootReg)
    && /async function _renameEstimate\(id, newName\) \{/.test(bootReg)
    && /async function _assignEstimateToLead\(id, leadId\) \{/.test(bootReg));
  assert('estimate-crm-ops.js\'s renameEstimateAction reads _renameEstimate off the registry, not bare window',
    /_nbdReg\._renameEstimate\(id, trimmed\)/.test(estCrmOpsSrc));
  assert('estimate-crm-ops.js\'s deleteEstimateAction reads _deleteEstimate off the registry, not bare window',
    /_nbdReg\._deleteEstimate\(id\)/.test(estCrmOpsSrc));
  // 2026-09-18 (Fix broken Assign on customer-page estimate hub): the two
  // call sites originally read window.__NBD_CALL_REGISTRY._assignEstimateToLead
  // directly with no existence guard. _assignEstimateToLead is registered only
  // by THIS file (dashboard-bootstrap.module.js), which customer.html never
  // loads, so clicking Assign there threw an unhandled rejection instead of
  // showing an error. Now guarded like _deleteEstimate/_renameEstimate above.
  assert('estimate-crm-ops.js\'s two _assignEstimateToLead call sites (unassign + lead-row pick) both read off the registry, guarded like _deleteEstimate/_renameEstimate',
    (estCrmOpsSrc.match(/_nbdReg\._assignEstimateToLead\(estimateId, (null|lead\.id)\)/g) || []).length === 2
    && !/window\._assignEstimateToLead\(/.test(estCrmOpsSrc)
    && !/window\.__NBD_CALL_REGISTRY\._assignEstimateToLead\(/.test(estCrmOpsSrc));
  assert('both _assignEstimateToLead call sites guard on typeof before calling (customer.html has no _assignEstimateToLead registered)',
    (estCrmOpsSrc.match(/typeof _nbdReg\._assignEstimateToLead !== 'function'/g) || []).length === 2);

  // ── Tranche 3 T3-C (2026-09-18): the crm-leads.js edge off
  // dashboard-bootstrap.module.js ──
  // Zero HTML hits, zero prior test coverage on either name.
  const crmLeadsSrc = read(path.join(PRO_JS, 'crm-leads.js'));
  for (const n of ['filterStageDropdownByJobType', 'getSelectedTrades']) {
    assert('dashboard-bootstrap.module.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootReg));
    assert('dashboard-bootstrap.module.js no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(bootReg));
  }
  assert('filterStageDropdownByJobType and getSelectedTrades are real declarations now',
    /function filterStageDropdownByJobType\(jobType\) \{/.test(bootReg)
    && /function getSelectedTrades\(\) \{/.test(bootReg));
  assert('toggleInsuranceFields\' self-reference to filterStageDropdownByJobType was rewired to a bare call',
    /filterStageDropdownByJobType\(jt\);/.test(bootReg) && !/window\.filterStageDropdownByJobType\b/.test(bootReg));
  assert('crm-leads.js reads filterStageDropdownByJobType off the registry, not bare window',
    /_nbdReg\.filterStageDropdownByJobType\(jtEl\?\.value \|\| ''\)/.test(crmLeadsSrc));
  assert('crm-leads.js reads getSelectedTrades off the registry, not bare window',
    /window\.__NBD_CALL_REGISTRY\.getSelectedTrades\(\)/.test(crmLeadsSrc) && !/window\.getSelectedTrades\(/.test(crmLeadsSrc));
  // ...and refreshStageOptions, the same edge's third name (a later PR): was
  // an anonymous window.X = function expression, now a real declaration.
  assert('dashboard-bootstrap.module.js registers refreshStageOptions in __NBD_CALL_REGISTRY (T3-C)',
    /\brefreshStageOptions:\s*refreshStageOptions\b/.test(bootRegBlock));
  assert('dashboard-bootstrap.module.js no longer exposes window.refreshStageOptions (T3-C off window, dot or bracket form)',
    !/window\.refreshStageOptions\s*=/.test(bootReg) && !/window\[\s*['"]refreshStageOptions['"]\s*\]/.test(bootReg));
  assert('refreshStageOptions is a real declaration now',
    /^  function refreshStageOptions\(keepValue\) \{/m.test(bootReg));
  const openLeadModalFn = crmLeadsSrc.slice(crmLeadsSrc.indexOf('function openLeadModal('), crmLeadsSrc.indexOf('function closeLeadModal('));
  assert('crm-leads.js\'s openLeadModal reads refreshStageOptions off the registry, not bare window',
    /if \(_nbdReg && typeof _nbdReg\.refreshStageOptions === 'function'\) \{/.test(openLeadModalFn)
    && /_nbdReg\.refreshStageOptions\(want \|\| 'new'\)/.test(openLeadModalFn)
    && !/window\.refreshStageOptions\b/.test(crmLeadsSrc));
  // `var _nbdReg` hoists: if the declaration sat BELOW the refreshStageOptions
  // guard (where it was for filterStageDropdownByJobType), the guard would
  // read `undefined` and silently skip the tenant-pipeline rebuild forever.
  const _olmReg = openLeadModalFn.indexOf('var _nbdReg = window.__NBD_CALL_REGISTRY;');
  assert('openLeadModal assigns _nbdReg BEFORE the refreshStageOptions guard reads it (hoisted-var trap)',
    _olmReg !== -1 && _olmReg < openLeadModalFn.indexOf('typeof _nbdReg.refreshStageOptions'));

  // ── Tranche 3 T3-C (2026-09-18): the warranty-claim.js edge off
  // dashboard-bootstrap.module.js ──
  // All three (missingClaimFields, subTypeLabel, subTypeOptionsFor) are
  // crm-stages.js imports bridged to a classic script, not local
  // declarations — the registry entry references the imported binding
  // directly rather than a function declaration.
  const warrantyClaimSrc = read(path.join(PRO_JS, 'warranty-claim.js'));
  for (const n of ['missingClaimFields', 'subTypeLabel', 'subTypeOptionsFor']) {
    assert('dashboard-bootstrap.module.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootReg));
    assert('dashboard-bootstrap.module.js no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(bootReg));
  }
  assert('subTypeOptionsFor\'s in-module self-reference (refreshSubTypeAndTrades) reads the bare imported binding, not window',
    /const options = subTypeOptionsFor\(jobType\);/.test(bootReg) && !/window\.subTypeOptionsFor\(/.test(bootReg));
  assert('warranty-claim.js\'s promptIntake reads subTypeOptionsFor off the registry, not bare window',
    /_nbdReg\.subTypeOptionsFor\('warranty'\)/.test(warrantyClaimSrc));
  assert('warranty-claim.js\'s advanceClaimStatus reads missingClaimFields off the registry, not bare window',
    /_nbdReg\.missingClaimFields\(extra \|\| \{\}, newStatus\)/.test(warrantyClaimSrc));
  assert('warranty-claim.js\'s renderPanel reads subTypeLabel off the registry, not bare window',
    /_nbdReg\.subTypeLabel\('warranty', claim\.reason\)/.test(warrantyClaimSrc));

  // ── Tranche 3 T3-C (2026-09-18): the pipeline-builder.js edge off
  // dashboard-bootstrap.module.js ──
  // applyPipelineConfig was a NAMED function expression assigned to
  // window (not anonymous like most other T3-C conversions) — converting
  // it to a plain declaration keeps the same name. STAGE_ROLE is a
  // rename-on-export: the imported binding is ROLE, the registry key is
  // STAGE_ROLE (key differs from value, unlike every other entry in this
  // block).
  const pipelineBuilderSrc = read(path.join(PRO_JS, 'pipeline-builder.js'));
  for (const n of ['applyPipelineConfig', 'resolvePipelineConfig']) {
    assert('dashboard-bootstrap.module.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootReg));
    assert('dashboard-bootstrap.module.js no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(bootReg));
  }
  assert('dashboard-bootstrap.module.js registers STAGE_ROLE as a rename-on-export of ROLE (T3-C)',
    /STAGE_ROLE:\s*ROLE\b/.test(bootReg) && !/window\.STAGE_ROLE\s*=/.test(bootReg));
  assert('applyPipelineConfig is a real named function declaration now, not window.X = function applyPipelineConfig()',
    /^  function applyPipelineConfig\(\) \{/m.test(bootReg));
  // 2026-09-25 (lane profretry): a landing applies the config through the
  // 'nbd:company-profile-loaded' listener (boot read, its retry, or
  // company-profile.js starting the read itself); the boot callback applies
  // the cached config only when its read failed.
  assert('applyPipelineConfig\'s in-module self-references (profile-landed listener + failed-boot-read callback) read the bare declaration, not window',
    /window\.addEventListener\('nbd:company-profile-loaded', \(\) => \{ applyPipelineConfig\(\); \}\);/.test(bootReg)
    && /if \(window\._companyProfileLoaded === true\) return;\s*applyPipelineConfig\(\);/.test(bootReg)
    && !/window\.applyPipelineConfig\(/.test(bootReg));
  assert('pipeline-builder.js\'s ROLES() reads STAGE_ROLE off the registry, not bare window',
    /_nbdReg\.STAGE_ROLE\)/.test(pipelineBuilderSrc));
  assert('pipeline-builder.js\'s resolved() reads resolvePipelineConfig off the registry, not bare window',
    /_nbdReg && _nbdReg\.resolvePipelineConfig/.test(pipelineBuilderSrc));
  assert('pipeline-builder.js\'s two applyPipelineConfig call sites (reset + save) both read off the registry',
    (pipelineBuilderSrc.match(/_nbdReg\.applyPipelineConfig\(\)/g) || []).length === 2
    && !/window\.applyPipelineConfig\(/.test(pipelineBuilderSrc));

  // ── Tranche 3 T3-C (2026-09-18): the crm-pipeline.js edge off
  // dashboard-bootstrap.module.js ──
  // partitionLeadsByColumn is a crm-stages.js import bridged to a classic
  // script (same shape as the warranty-claim.js edge). renderLeads is the
  // sole consumer; its inline fallback bucketer (registry/entry missing)
  // is unchanged. crm-pipeline.js's _dragId implicit global is NOT part of
  // this edge and must stay exactly as it was.
  const crmPipelineSrc = read(path.join(PRO_JS, 'crm-pipeline.js'));
  assert('dashboard-bootstrap.module.js registers partitionLeadsByColumn in __NBD_CALL_REGISTRY (T3-C)',
    /\bpartitionLeadsByColumn:\s*partitionLeadsByColumn\b/.test(bootRegBlock));
  assert('dashboard-bootstrap.module.js no longer exposes window.partitionLeadsByColumn (T3-C off window, dot or bracket form)',
    !/window\.partitionLeadsByColumn\s*=/.test(bootReg) && !/window\[\s*['"]partitionLeadsByColumn['"]\s*\]/.test(bootReg));
  assert('crm-pipeline.js\'s renderLeads reads partitionLeadsByColumn off the registry, not bare window',
    /const _nbdReg = window\.__NBD_CALL_REGISTRY;\s*if \(_nbdReg && typeof _nbdReg\.partitionLeadsByColumn === 'function'\) \{\s*const _part = _nbdReg\.partitionLeadsByColumn\(list, stageKeys, \{/.test(crmPipelineSrc)
    && !/window\.partitionLeadsByColumn\b/.test(crmPipelineSrc));

  // ── Tranche 3 T3-C (2026-09-18): the dashboard-widgets.js photo modal
  // edge off dashboard-bootstrap.module.js ──
  const dashWidgetsSrc = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  for (const n of ['_uploadPhoto', '_getPhotos']) {
    assert('dashboard-bootstrap.module.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-C)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(bootReg));
    assert('dashboard-bootstrap.module.js no longer exposes window.' + n + ' (T3-C off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(bootReg));
  }
  assert('_uploadPhoto and _getPhotos are real declarations now',
    /async function _uploadPhoto\(leadId, file\) \{/.test(bootReg) && /async function _getPhotos\(leadId\) \{/.test(bootReg));
  assert('dashboard-widgets.js\'s photo-badge opener reads _getPhotos off the registry, not bare window',
    /window\.__NBD_CALL_REGISTRY\._getPhotos\(leadId\)/.test(dashWidgetsSrc));
  assert('dashboard-widgets.js\'s upload handler reads both _uploadPhoto and _getPhotos off the registry, not bare window',
    /_nbdReg\._uploadPhoto\(currentPhotoLeadId,f\)/.test(dashWidgetsSrc)
    && /_nbdReg\._getPhotos\(currentPhotoLeadId\)/.test(dashWidgetsSrc)
    && !/window\._uploadPhoto\(/.test(dashWidgetsSrc) && !/window\._getPhotos\(/.test(dashWidgetsSrc));

  // ── Tranche 3 slice T3-0 (2026-08-31): the shim-blocked residual ──
  // The last open item of Tranche 2. The zone-draw cluster was deferred
  // because maps.js re-stated its names with an UNGUARDED right-hand side —
  // scoping them would ReferenceError at maps.js load and take the whole map
  // surface down. That block became typeof-guarded + try/catch-fenced on
  // 2026-08-07, which unblocked the conversion: the cluster is IIFE-scoped in
  // dashboard-actions.js and the six re-exports in maps.js are deleted.
  // Two cross-file BARE calls had to be rewired first, or scoping the names
  // would have silently killed live controls:
  //   - dashboard-widgets.js's generated zone-delete button called deleteZone
  //     as a bare identifier → now dispatches via data-action="call".
  //   - dashboard-ui.js's `zoneColor` action probed `typeof selectZoneColor`
  //     → now resolves through _nbdResolveCall (registry first).
  const T30_NAMES = ['selectZoneColor', 'startZoneDraw', 'cancelZoneDraw',
    'saveZone', 'deleteZone', 'damageNearMePhotos'];
  const daRegBlocks = (dashActions.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{[\s\S]*?\}\);/g) || []).join('\n');
  for (const n of T30_NAMES) {
    assert('dashboard-actions registers ' + n + ' in __NBD_CALL_REGISTRY (T3-0)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(daRegBlocks));
    assert('allowlist no longer carries ' + n + ' (T3-0 — registry replaced it)',
      !new RegExp("'" + n + "'").test(stateSrc));
    assert('maps.js no longer re-exports window.' + n + ' (T3-0 shim unwound)',
      !new RegExp('window\\.' + n + '\\s*=').test(mapsSrc));
    assert('dashboard-actions no longer re-exports window.' + n + ' (T3-0 off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(dashActions));
  }
  // The zone cluster must stay inside its IIFE — an unwrapped declaration
  // re-grows every one of these as an auto-global at file top level.
  assert('the zone cluster is IIFE-wrapped in dashboard-actions.js (T3-0)',
    /\(function \(\)\s*\{\s*\nfunction selectZoneColor\(color, el\)/.test(dashActions),
    'selectZoneColor must be the first declaration inside the zone IIFE');
  assert('damageNearMePhotos is IIFE-wrapped in dashboard-actions.js (T3-0)',
    /\(function \(\)\s*\{\s*\nfunction damageNearMePhotos\(\)/.test(dashActions));
  // MUST-STAY: renderSavedZones is a real cross-file API — maps-core.js redraws
  // zones 400ms after map init and dashboard-bootstrap.module.js redraws them
  // when the /zones read resolves. Both reach it off window.
  assert('renderSavedZones keeps its window export (maps-core + bootstrap call it)',
    /window\.renderSavedZones = renderSavedZones/.test(dashActions));
  // The two rewired call sites. Without these the controls die silently:
  // the delegate/probe returns early and no error is thrown anywhere.
  const widgetsSrc = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  assert('renderZoneList delegates delete via data-action="call" (T3-0, H-1 pattern)',
    /data-action="call" data-fn="deleteZone" data-arg="\$\{esc\(z\.id\)\}"/.test(widgetsSrc));
  assert('renderZoneList no longer calls deleteZone as a bare cross-file identifier',
    !/addEventListener\('click', \(\) => deleteZone\(/.test(widgetsSrc));
  assert('the zoneColor action resolves selectZoneColor through the registry (T3-0)',
    /action === 'zoneColor'[\s\S]{0,260}_nbdResolveCall\('selectZoneColor'\)/.test(ui));
  assert('the zoneColor action no longer probes a bare typeof selectZoneColor',
    !/typeof selectZoneColor === 'function'/.test(ui));

  // ── Tranche 3 slice T3-A part 1 (2026-08-31): the forward-reference block ──
  // dashboard-actions.js carried 86 guarded re-exports left over from the
  // monolith split, of the form `if (typeof X !== 'undefined') window.X = X;`.
  // ALL of them were inert: 62 dead (the subject is defined in a script that
  // loads AFTER this one — or, for the estimates.js names, only ever arrives via
  // the lazy ScriptLoader bundle — so the typeof read was always 'undefined'),
  // and 24 redundant (the subject is a top-level `function` in an EARLIER
  // classic script, so it was already a window property). A live before/after
  // snapshot of all 85 distinct names was byte-identical, twice — see
  // tests/e2e/globals-surface-snapshot.spec.js.
  //
  // They are pinned at zero because the block was actively harmful: the globals
  // census (scripts/globals-xref.js) infers ownership from the literal text
  // `window.X =`, so these lines made dashboard-actions.js look like the
  // assigner of names it does not define. That is where the Tranche 3 plan's
  // "dashboard-actions.js (33) mechanically-safe" figure came from — 26 of
  // those 34 names were phantoms, and deleting the block dropped the census
  // from 821 rows to 782 without changing one byte of behaviour.
  // Strictly single-line: [ \t] rather than \s, because \s matches newlines and
  // would otherwise swallow the legitimate multi-line lazy-stub installer
  //   if (typeof startNewEstimate === 'function') { window.startNewEstimate = ... }
  //   else { ...install load-then-run stubs for the estimates bundle... }
  // whose else-branch is load-bearing and must stay.
  //
  // Widened 2026-09-22. The original pattern ended `;[ \t]*\}?[ \t]*$`, so a
  // trailing `// comment` (the house style for export lines), a missing
  // semicolon, or the bracket form `window['X'] = X` each slipped through.
  // Still single-line, still requires the value to be exactly the subject.
  const FWD_GUARD = /^[ \t]*if[ \t]*\([ \t]*typeof[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?:!==|!=|===|==)[ \t]*['"](?:undefined|function)['"][ \t]*\)[ \t]*\{?[ \t]*window(?:[ \t]*\.[ \t]*\1|[ \t]*\[[ \t]*(['"`])\1\2[ \t]*\])[ \t]*=[ \t]*\1[ \t]*;?[ \t]*\}?[ \t]*;?[ \t]*(?:\/\/[^\r\n]*|\/\*[^\r\n]*?\*\/[ \t]*)?\r?$/gm;
  {
    const fwdPos = {
      'plain': "if (typeof fooName !== 'undefined') window.fooName = fooName;",
      'trailing line comment': "if (typeof fooName !== 'undefined') window.fooName = fooName; // re-export",
      'braced + trailing comment': "if (typeof fooName === 'function') { window.fooName = fooName; } // why",
      'trailing block comment': "if (typeof fooName != 'undefined') window.fooName = fooName; /* legacy */",
      'no semicolon': "if (typeof fooName !== 'undefined') window.fooName = fooName",
      'bracket form': "if (typeof fooName !== 'undefined') window['fooName'] = fooName;",
      'CRLF line end + comment': "if (typeof fooName !== 'undefined') window.fooName = fooName; // x\r\nnext();",
    };
    for (const [label, src] of Object.entries(fwdPos)) {
      assert('FWD_GUARD catches the ' + label + ' forward-reference shape',
        [...src.matchAll(FWD_GUARD)].map(m => m[1]).includes('fooName'));
    }
    const fwdNeg = {
      'the multi-line lazy-stub installer (real startNewEstimate shape)': "if (typeof fooName === 'function') {\n  window.fooName = fooName;\n} else {\n  window.fooName = stub;\n}",
      'a same-line else branch': "if (typeof fooName === 'function') { window.fooName = fooName; } else { window.fooName = stub; }",
      'a different value': "if (typeof fooName !== 'undefined') window.fooName = fooName || stub;",
      'a plain unguarded export': 'window.fooName = fooName; // consumer',
    };
    for (const [label, src] of Object.entries(fwdNeg)) {
      assert('FWD_GUARD does NOT flag ' + label,
        ![...src.matchAll(FWD_GUARD)].map(m => m[1]).includes('fooName'));
    }
  }
  const fwdLeft = [...dashActions.matchAll(FWD_GUARD)].map(m => m[1]);
  assert('dashboard-actions.js has NO `typeof X` forward-reference re-exports left — '
      + (fwdLeft.slice(0, 6).join(', ') || 'clean'),
    fwdLeft.length === 0,
    'a module exposes its own API; a forward reference here is either dead (subject '
    + 'loads later) or redundant (subject is already an auto-global), and it corrupts '
    + 'the globals census either way');
  // The same anti-pattern must not migrate into the other big dashboard files.
  for (const f of ['dashboard-ui.js', 'dashboard-widgets.js', 'dashboard-state.js']) {
    const s = read(path.join(PRO_JS, f));
    const hits = [...s.matchAll(FWD_GUARD)].map(m => m[1]);
    assert('no forward-reference re-export block in ' + f + ' — '
        + (hits.slice(0, 4).join(', ') || 'clean'), hits.length === 0);
  }

  // ⚠ The one export in this file that LOOKS vestigial but is load-bearing.
  // `_mJdOpenEstimate` is IIFE-scoped (2c-4b), so `window._mJdOpenEstimate = …`
  // reads as a leftover self-export — but its __NBD_CALL_REGISTRY entry sits in
  // a DIFFERENT IIFE, where the bare identifier is not lexically in scope and
  // resolves through the global object instead. Removing the window export
  // alone makes that registry line throw at load, aborting its whole IIFE and
  // silently killing all 19 registry entries in it (the customer-detail action
  // bar). Retiring it safely means moving the registry entry into the defining
  // IIFE FIRST. This pin exists so that ordering cannot be discovered the hard
  // way; delete it only together with the line it guards.
  {
    const exportLine = /window\._mJdOpenEstimate\s*=\s*_mJdOpenEstimate\s*;/.test(dashActions);
    const regEntry = /_mJdOpenEstimate:\s*_mJdOpenEstimate/.test(dashActions);
    const iifeOpens = [...dashActions.matchAll(/^\(function \(\)\s*\{/gm)].map(m => m.index);
    const iifeCloses = [...dashActions.matchAll(/^\}\)\(\);/gm)].map(m => m.index);
    const blockOf = (idx) => {
      for (let i = 0; i < iifeOpens.length; i++) {
        if (iifeOpens[i] < idx && idx < (iifeCloses[i] !== undefined ? iifeCloses[i] : Infinity)) return i;
      }
      return -1;
    };
    const expIdx = dashActions.search(/window\._mJdOpenEstimate\s*=\s*_mJdOpenEstimate\s*;/);
    const regIdx = dashActions.search(/_mJdOpenEstimate:\s*_mJdOpenEstimate/);
    const sameBlock = expIdx >= 0 && regIdx >= 0 && blockOf(expIdx) === blockOf(regIdx);
    assert('_mJdOpenEstimate: the window export survives while its registry entry '
        + 'is in a different IIFE (removing it alone kills 19 registry entries)',
      sameBlock || exportLine,
      regEntry && !exportLine && !sameBlock
        ? 'the registry entry is in another IIFE and the window export it depends on is GONE — '
          + 'the customer-detail action bar will be dead at runtime'
        : 'expected either the export to remain, or the registry entry to have moved '
          + 'into the same IIFE as the definition');
  }

  // The resolver's window fallback is allowlist-gated; keep state ahead of
  // dashboard-ui in the defer queue so the gate exists when dispatch runs.
  const dashRaw = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('dashboard.html loads dashboard-state.js before dashboard-ui.js',
    dashRaw.indexOf('js/dashboard-state.js') !== -1
      && dashRaw.indexOf('js/dashboard-state.js') < dashRaw.indexOf('js/dashboard-ui.js'));

  // (d) FULL wiring audit — every markup-dispatched name in dashboard.html
  // must be resolvable: quoted in dashboard-state.js (allowlist/toggle/
  // modal maps) or registered in some __NBD_CALL_REGISTRY block under
  // docs/pro/js/. New markup wired to an unlisted, unregistered name is a
  // silently dead control (the delegate returns early).
  const registered = new Set();
  for (const file of fs.readdirSync(PRO_JS)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(PRO_JS, file), 'utf8');
    for (const m of src.matchAll(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/g)) {
      for (const k of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) registered.add(k[1]);
    }
  }
  const DISPATCH_RE = /data-(?:fn|on-change|on-input|on-after|enter-action)="([A-Za-z_$][\w$]*)"/g;
  const dispatchNames = new Set();
  // data-enter-action is included: its keydown delegate (dashboard-ui.js) now
  // resolves registry-first via _nbdResolveCall, so an enter-action name that is
  // neither allowlisted nor registered is a silent dead control on Enter — the
  // exact gap that hid the spyglassSearch Enter-key regression (Tranche 2c-4h H2).
  for (const m of dashRaw.matchAll(DISPATCH_RE)) {
    dispatchNames.add(m[1]);
  }
  const unresolved = [...dispatchNames].filter(n => !registered.has(n) && stateSrc.indexOf("'" + n + "'") === -1);
  assert('every markup-dispatched name in dashboard.html is allowlisted or registered — '
      + (unresolved.slice(0, 5).join(', ') || 'clean'), unresolved.length === 0);
  assert('wiring audit saw the real markup surface (sanity floor)', dispatchNames.size > 150);

  // (e) FULL wiring audit, part 2 — the markup JS GENERATES ────────────────
  // dashboard.html is only half the dispatch surface. docs/pro/js/*.js emits
  // markup from string and template literals (the load-status banner buttons,
  // the referral rows, the zone-delete control, the hotkey/sidebar toggle
  // rows, the font cards), and every one of those names lands in the very
  // same delegate — so an unregistered one is the very same silently dead
  // control. Scan (d) reads only dashboard.html and cannot see any of it.
  // docs/dev/dashboard-actions-globals-audit.md has carried this as a known
  // hole in its 2c-4c row since hardResetTest/gstaticTest moved into a
  // generated banner ("invisible to the wiring audit → their registry
  // assertions are the only guard").
  //
  // Why it stayed unwritten until now: a plain grep over the .js files
  // reports five names that exist ONLY in dashboard-ui.js's delegate
  // documentation — setFoo, setBar, setBaz, handleUpload, fnName — as dead
  // controls. Hardcoding those five as exclusions would be a gate that stops
  // matching the day someone rewords a comment, and silently starts passing
  // real markup through the hole. So instead of naming them, jsSegments()
  // classifies every byte of each file as code / string / comment / regex and
  // we read the string segments only: prose is excluded because of WHERE it
  // sits, not because of what it happens to be called. (Selector strings like
  // `[data-fn="selectTier"]` count too — a querySelector for a name nothing
  // resolves is dead from the other end.)
  //
  // Escapes are resolved inside string literals so "<b data-fn=\"x\">" is
  // read the same as '<b data-fn="x">'.
  const segText = (src, s) => {
    const raw = src.slice(s.start, s.end);
    return s.kind === 'string' ? raw.replace(/\\(.)/g, '$1') : raw;
  };

  // The scanner is the load-bearing half of this gate, so it is checked
  // against its own fixture before it is pointed at the corpus. A later edit
  // that breaks the lexer fails HERE, with a name-set diff, instead of
  // quietly blinding the audit — the failure mode a grep-based gate has no
  // way to detect at all. Every line below is a case that a naive
  // strip-the-comments regex gets wrong.
  const SCANNER_FIXTURE = [
    '// doc comment: <input data-on-change="wDocLine" data-on-pass="checked">',
    '/* block doc — mentions data-fn="wDocBlock" and an apostrophe: don\'t',
    '   plus a stray backtick ` and a "quote" that must not open anything */',
    'var a = \'<b data-fn="wSingle">\';',
    'var b = "<b data-fn=\\"wDouble\\">";',
    'var c = `<b data-fn="wTemplate" data-arg="${id}">`;',
    'var d = `${cond ? \'<b data-fn="wInHole">\' : \'\'}`;',
    'var e = "https://example.com/x"; var e2 = \'<b data-fn="wAfterUrl">\';',
    'var f = s.replace(/["\']/g, \'\'); var f2 = \'<b data-fn="wAfterRegex">\';',
    'function g(s) { return /data-fn="wRegexLiteral"/.test(s); }',
    'var h = (p + q) / r; var h2 = \'<b data-fn="wAfterDivide">\';',
    'var i = "/* not a comment */"; var i2 = \'<b data-fn="wAfterStarSlash">\';',
    'var j = `${ /* data-fn="wHoleComment" */ k }<b data-fn="wAfterHoleComment">`;',
    'var l = `${ fn({ a: 1 }) }<b data-fn="wAfterNestedBraces">`;',
  ].join('\n');
  const fixSegs = jsSegments(SCANNER_FIXTURE);
  const fixSeen = { string: new Set(), comment: new Set(), code: new Set(), regex: new Set() };
  for (const s of fixSegs) {
    for (const m of segText(SCANNER_FIXTURE, s).matchAll(DISPATCH_RE)) fixSeen[s.kind].add(m[1]);
  }
  const list = (names) => [...names].sort().join(',');
  assert('jsSegments returns a gapless partition of its input (fixture)',
    fixSegs.every((s, k) => s.start === (k ? fixSegs[k - 1].end : 0))
      && fixSegs.reduce((a, s) => a + (s.end - s.start), 0) === SCANNER_FIXTURE.length);
  assert('jsSegments sees generated markup in every literal form (fixture)',
    list(fixSeen.string) === list(['wAfterDivide', 'wAfterHoleComment', 'wAfterNestedBraces',
      'wAfterRegex', 'wAfterStarSlash', 'wAfterUrl', 'wDouble', 'wInHole', 'wSingle', 'wTemplate']),
    'got: ' + list(fixSeen.string));
  assert('jsSegments keeps doc-comment placeholders out of the markup surface (fixture)',
    list(fixSeen.comment) === 'wDocBlock,wDocLine,wHoleComment', 'got: ' + list(fixSeen.comment));
  assert('jsSegments keeps regex literals out of the markup surface (fixture)',
    list(fixSeen.regex) === 'wRegexLiteral', 'got: ' + list(fixSeen.regex));
  assert('jsSegments leaves no dispatch attribute stranded in bare code (fixture)',
    fixSeen.code.size === 0, 'got: ' + list(fixSeen.code));

  const genNames = new Map();      // name → 'file:line' of its first emit site
  const commentOnly = new Set();   // names seen ONLY in prose
  const scanDrift = new Set();     // files the partition failed to cover
  for (const file of fs.readdirSync(PRO_JS)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(PRO_JS, file), 'utf8');
    const segs = jsSegments(src);
    let cursor = 0;
    for (const s of segs) { if (s.start !== cursor) scanDrift.add(file); cursor = s.end; }
    if (cursor !== src.length) scanDrift.add(file);
    for (const s of segs) {
      if (s.kind !== 'string' && s.kind !== 'comment') continue;
      for (const m of segText(src, s).matchAll(DISPATCH_RE)) {
        if (s.kind === 'comment') { commentOnly.add(m[1]); continue; }
        if (!genNames.has(m[1])) {
          genNames.set(m[1], file + ':' + (src.slice(0, s.start + m.index).split('\n').length));
        }
      }
    }
  }
  for (const n of genNames.keys()) commentOnly.delete(n);

  assert('jsSegments covers every byte of every docs/pro/js file (no scanner drift) — '
      + ([...scanDrift].slice(0, 3).join(', ') || 'clean'), scanDrift.size === 0);
  const genUnresolved = [...genNames]
    .filter(([n]) => !registered.has(n) && stateSrc.indexOf("'" + n + "'") === -1)
    .map(([n, where]) => n + ' (' + where + ')');
  assert('every JS-generated dispatch name is allowlisted or registered — '
      + (genUnresolved.slice(0, 5).join(', ') || 'clean'), genUnresolved.length === 0);
  assert('generated-markup audit saw the real generated surface (sanity floor)',
    genNames.size >= 12, 'found ' + genNames.size);
  // The canary for the whole approach. If this ever reads NONE, the
  // code/prose split stopped being load-bearing on the real corpus — which is
  // exactly what a regression to a plain grep looks like, and the five
  // dashboard-ui.js delegate placeholders would then sail into the assertion
  // above as phantom dead controls.
  assert('doc-comment-only dispatch names are excluded by position, not by name — '
      + ([...commentOnly].sort().slice(0, 5).join(', ') || 'NONE'), commentOnly.size > 0);
}

section('Mobile lead detail — Estimate opens the lead; Activity shows estimates');
{
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  const css = read(path.join(ROOT, 'docs/pro/css/dashboard-app.css'));

  // Phase 1c: the ESTIMATE quick-action STAYS on the customer — it switches to
  // the embedded Estimates tab instead of closing the overlay and navigating to
  // the generic est view. The pre-1c version guessed at "the newest estimate for
  // this lead" and opened the full-screen builder, so a customer with two
  // estimates could only ever reach one of them from this button.
  const mJdAct = actions.slice(actions.indexOf('function _mJdAct('),
                              actions.indexOf('window._mJdAct = _mJdAct'));
  assert('_mJdAct estimate case switches to the embedded Estimates tab',
    /case 'estimate'[\s\S]{0,900}_mJdSwitchTab\('estimates'\)/.test(mJdAct));
  assert('_mJdAct estimate case no longer closes the overlay or navigates away',
    !/case 'estimate'[\s\S]{0,900}(closeMobileJobDetail\(\)|goTo\('est'\))/.test(mJdAct));
  assert('_mJdAct estimate case no longer relies on the dead _currentEstimateLeadId global',
    !/_currentEstimateLeadId/.test(mJdAct));

  // A specific estimate row is tappable via a registered call target.
  assert('_mJdOpenEstimate defined + registered (CSP-safe row open)',
    /function _mJdOpenEstimate\(estimateId\)[\s\S]{0,1200}viewEstimate\(estimateId\)/.test(actions) &&
    /_mJdOpenEstimate: _mJdOpenEstimate/.test(actions));

  // Bug A: openMobileJobDetail now populates the Activity tab (was a static
  // "No activity yet" stub) with the lead's estimates + stage history.
  const openFn = widgets.slice(widgets.indexOf('function openMobileJobDetail'),
                               widgets.indexOf('window.openMobileJobDetail'));
  assert('openMobileJobDetail builds the Activity list from estimates + stageHistory',
    /mJdTabActivity/.test(openFn) &&
    /m-jd-act-list/.test(openFn) &&
    /data-fn="_mJdOpenEstimate"/.test(openFn) &&
    /lead\.stageHistory/.test(openFn));
  assert('Activity list toggles the empty-state message',
    /emptyEl\.hidden = items\.length > 0/.test(openFn));
  // Uses in-memory data (no new Firestore reads on open).
  assert('Activity list reads window._estimates in-memory (no extra query)',
    /window\._estimates \|\| \[\]/.test(openFn));

  assert('m-jd Activity item styling present',
    /\.m-jd-act-item\{/.test(css) && /\.m-jd-act-list\{/.test(css));
}

section('Embedded per-customer estimate hub (CustomerEstimateHub)');
{
  const hub = read(path.join(PRO_JS, 'customer-estimate-hub.js'));
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));

  // ── The tab exists on the dashboard (the legacy twin was retired 2026-09-02),
  //    wired to the already-registered _mJdSwitchTab (no new call-registry entry needed).
  for (const page of ['dashboard.html']) {
    const html = read(path.join(ROOT, 'docs/pro', page));
    assert(`${page}: Estimates tab button dispatches _mJdSwitchTab('estimates')`,
      /data-tab="estimates"[^>]*data-fn="_mJdSwitchTab" data-arg="estimates"/.test(html));
    assert(`${page}: #mJdTabEstimates panel exists for the hub to mount into`,
      /id="mJdTabEstimates"[^>]*role="tabpanel"/.test(html));
    assert(`${page}: loads customer-estimate-hub.js`,
      /customer-estimate-hub\.js/.test(html));
  }

  // ── Tab routing + lazy mount.
  assert('_mJdSwitchTab maps the estimates tab to #mJdTabEstimates',
    /estimates:'mJdTabEstimates'/.test(actions));
  assert('hub mounts lazily on the first switch to the Estimates tab',
    /if \(tab === 'estimates'\) _mountEstimateHub\(\);/.test(actions));
  assert('_mountEstimateHub mounts for the CURRENT overlay lead',
    /function _mountEstimateHub\(\)[\s\S]{0,700}window\._cardDetailLeadId[\s\S]{0,700}CustomerEstimateHub\.mount\(host, leadId/.test(actions));
  // Missing module must degrade to a message, never throw into the tab switch.
  assert('_mountEstimateHub degrades gracefully when the module is absent',
    /if \(!window\.CustomerEstimateHub\)[\s\S]{0,220}return;/.test(actions));

  // ── Stale-customer guard: opening lead B must never show lead A's money.
  const openFn = widgets.slice(widgets.indexOf('function openMobileJobDetail'),
                               widgets.indexOf('window.openMobileJobDetail'));
  assert('openMobileJobDetail unmounts the hub when the lead changes',
    /CustomerEstimateHub\.leadId\(\) !== leadId[\s\S]{0,120}\.unmount\(\)/.test(openFn));

  // ── Live refresh: the snapshot rebuild repaints the hub, and the hook sits
  //    ABOVE renderEstimatesList's estListWrap early-return (the CRM route has
  //    no wrapper, and that's exactly where the hub is used).
  const idxHook = widgets.indexOf('CustomerEstimateHub.isMounted()');
  const idxBail = widgets.indexOf("if (!wrap) return;");
  assert('renderEstimatesList refreshes a mounted hub', idxHook !== -1);
  assert('hub refresh hook precedes the estListWrap early-return', idxHook !== -1 && idxHook < idxBail);

  // ── Every action is wired to a REAL handler, not a stub. This is the whole
  //    point of the wave: the button did nothing but navigate before.
  for (const [act, fn] of [
    ['assign',    'assignEstimateAction'],
    ['archive',   'deleteEstimateAction'],
  ]) {
    assert(`hub '${act}' action calls ${fn}`,
      new RegExp(`case '${act}':\\s*withEstimates\\('${fn}'`).test(hub));
  }
  // 'duplicate' deliberately no longer routes through duplicateEstimateAction.
  // That path's _duplicateEstimate sets `leadId = null` so the copy can be
  // assigned from the dashboard estimates list — correct THERE, wrong here: this
  // hub lists BY leadId, so the copy was filtered straight out and the rep got a
  // "✓ Estimate duplicated" toast over an unchanged list. The hub now duplicates
  // and attaches to its own lead. See tests/estimate-hub-controls.test.js.
  assert("hub 'duplicate' uses the lead-attaching local handler",
    /case 'duplicate':\s*doDuplicate\(id\);/.test(hub)
    && /function doDuplicate\(id\)/.test(hub));
  assert("hub 'new' action opens the V2 builder prefilled with the lead",
    /function newEstimate\(\)[\s\S]{0,200}openEstimateV2Builder', \[\{ leadId: _leadId \}\]/.test(hub));
  // V2 opens its own modal and a Log Estimate record its amount editor (phone
  // audit 2026-09-25), both over the customer overlay, so only Classic leaves.
  const openBuilderSrc = hub.slice(hub.indexOf('function openBuilder('), hub.indexOf('function newEstimate('))
    .replace(/\/\/.*$/gm, '');
  assert('hub edit keeps V2 and logged records in-context and only navigates for Classic',
    /if \(isV2\(est\)\) \{\s*withEstimates\('openEstimateV2Builder'[^;]*;\s*return;\s*\}/.test(openBuilderSrc)
    && /if \(isLogged\(est\)[^)]*\) \{\s*window\.viewEstimate\(estId\);\s*return;\s*\}/.test(openBuilderSrc)
    && openBuilderSrc.indexOf("goTo('est')") > openBuilderSrc.indexOf('window.viewEstimate(estId)'));
  // The estimate engine is lazy — actions must load the bundle, not no-op.
  assert('hub actions load the lazy estimates bundle before firing',
    /function withEstimates\([\s\S]{0,700}ScriptLoader\.loadBundle\('estimates'\)/.test(hub));
  assert('hub skips lazy-stub functions rather than calling them',
    /__nbdLazyEstimateStub/.test(hub));

  // ── make-primary write contract (mirrors customer-bootstrap setPrimaryEstimate):
  //    money fields ONLY. Switching which estimate counts is not a funnel event.
  const mp = hub.slice(hub.indexOf('function makePrimary('), hub.indexOf('function onClick('));
  assert('makePrimary writes jobValue + primaryEstimateId + lastEstimateAt',
    /jobValue: newVal[\s\S]{0,120}primaryEstimateId: estId[\s\S]{0,120}lastEstimateAt/.test(mp));
  assert('makePrimary NEVER touches stage or stageRole',
    !/stageRole|\bstage:/.test(mp));
  assert('makePrimary confirms before zeroing a live job value with a $0 draft',
    /newVal <= 0[\s\S]{0,200}ask\(/.test(mp));
  assert('makePrimary repaints the kanban (cards read lead.jobValue)',
    /renderLeads\(window\._leads/.test(mp));
  assert('makePrimary logs a communications note for the customer timeline',
    /type: 'note'[\s\S]{0,400}source: 'primary_switch'/.test(mp));

  // ── CSP + XSS: delegated listener only, every interpolation escaped.
  assert('hub has zero inline handlers',
    !/\son[a-z]+\s*=\s*["']/.test(hub) && !/javascript:/.test(hub));
  assert('hub routes clicks through one delegated data-ceh-act listener',
    /data-ceh-act/.test(hub) && /addEventListener\('click'/.test(hub));
  // Customer/estimate names are stored-XSS sources (public lead intake).
  assert('hub escapes the estimate title and customer name',
    /esc\(titleOf\(est\)\)/.test(hub) && /esc\(custName\)/.test(hub));
  assert('hub URL-encodes the address into the maps link',
    /encodeURIComponent\(addr\)/.test(hub));

  // ── Both estimate shapes render (V2 rows / Classic lineItems), same bug the
  //    preview sheet fixed — a V2 doc must not read as "$0, no lines".
  assert('hub normalizes V2 rows AND Classic lineItems',
    /est\.rows/.test(hub) && /est\.lineItems/.test(hub));
  assert('hub reads grandTotal | total | amount for the money figure',
    /grandTotal != null[\s\S]{0,140}est\.amount/.test(hub));
  // The strip must show the LEAD's jobValue (what pipeline/KPIs read), not a
  // recomputed sum that could disagree with the kanban card.
  assert('hub money strip shows lead.jobValue, not a recomputed sum',
    /var jobValue = Number\(lead\.jobValue\)/.test(hub));

  const css = read(path.join(ROOT, 'docs/pro/css/dashboard-app.css'));
  // 2026-09-17: 7-tab now (Documents/Messages/Voice Intel added). flex:1
  // equal-width broke at 7 tabs — "Voice Intel" wrapped to two lines and
  // crowded the Messages badge onto its own line at a real 375px width
  // (screenshot-verified). Switched to a horizontally-scrollable strip
  // (flex:0 0 auto + overflow-x:auto), the pattern that survives an 8th or
  // 9th tab without another CSS fire drill.
  assert('m-jd-tabs scrolls horizontally instead of forcing every tab into an equal-width column',
    /\.m-jd-tabs\{[\s\S]{0,160}overflow-x:auto/.test(css));
  assert('m-jd-tab is natural-width + nowrap, not flex:1 (which is what broke at 7 tabs)',
    /\.m-jd-tab\{[\s\S]{0,80}flex:0 0 auto[\s\S]{0,40}white-space:nowrap/.test(css));
}

section('Mobile job-detail Documents tab (leads/{id}/documents parity)');
{
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  const bootstrap = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
  const loader = read(path.join(PRO_JS, 'script-loader.js'));
  const html = read(path.join(ROOT, 'docs/pro/dashboard.html'));

  // 2026-09-17: Jo, from real use on his phone — "I can never click
  // documents or see an area for it." The mobile job-detail overlay never
  // had a Documents tab; customer.html's own 7-tab desktop nav
  // (Overview/Timeline/Photos/Files/Messages/Voice Intel/Contact) had no
  // mobile equivalent for this one at all.
  assert("dashboard.html: Documents tab button dispatches _mJdSwitchTab('documents')",
    /data-tab="documents"[^>]*data-fn="_mJdSwitchTab" data-arg="documents"/.test(html));
  assert('dashboard.html: #mJdTabDocuments panel exists to mount into',
    /id="mJdTabDocuments"[^>]*role="tabpanel"/.test(html));

  assert("_mJdSwitchTab maps the documents tab to #mJdTabDocuments",
    /documents:'mJdTabDocuments'/.test(actions));
  assert('hub mounts lazily on the first switch to the Documents tab',
    /if \(tab === 'documents'\) _mountDocumentsHub\(\);/.test(actions));

  const mountFn = actions.slice(actions.indexOf('function _mountDocumentsHub'),
                                 actions.indexOf('// Recompute the job-detail hero'));
  assert('_mountDocumentsHub is defined', mountFn.length > 0);
  assert('_mountDocumentsHub reads the CURRENT overlay lead, not a stale global',
    /window\._cardDetailLeadId/.test(mountFn));
  // Reuses the SAME store customer.html reads — not a second fetch/normalize
  // implementation (the exact class of drift this session's other fixes
  // (document status field, tier source of truth) were closing elsewhere).
  assert("_mountDocumentsHub reuses window.NBDCustomerDocs.load(), not its own Firestore read",
    /window\.NBDCustomerDocs\.load\(leadId\)/.test(mountFn) && !/getDocs\(/.test(mountFn));
  assert('_mountDocumentsHub degrades gracefully when the module is absent, never throws into the tab switch',
    /if \(!window\.NBDCustomerDocs\)[\s\S]{0,220}return;/.test(mountFn));
  // Lazy bundle load — same contract as _generateDocWithPreflight, not a
  // second eager <script> tag.
  assert("_mountDocumentsHub lazy-loads the docgen bundle if not yet present",
    /window\.ScriptLoader\.loadBundle\('docgen'\)/.test(mountFn));
  // Stale-response guard: a slow load must not paint a lead the rep already
  // navigated away from.
  assert('_mountDocumentsHub discards a stale response if the overlay lead changed mid-fetch',
    /window\._cardDetailLeadId !== leadId\) return;/.test(mountFn));
  // Opening a generated doc reuses customer-documents.js's own [data-doc-view]
  // click delegate — no second click handler for the same action.
  assert('a generated (htmlPath) row uses data-doc-view, the existing global click delegate',
    /data-doc-view=/.test(mountFn));
  // An uploaded doc with a real URL opens directly, same as desktop, through
  // the same normalize()-validated (scheme-safe) url field.
  assert('an uploaded row with a real URL opens via a plain anchor to the normalized url',
    /d\.url\)[\s\S]{0,200}href="[\s\S]{0,40}esc\(d\.url\)/.test(mountFn));
  // The status field this session's other fix (PR #1612) established as the
  // source of truth surfaces here too, not just on desktop.
  assert("surfaces the sent/signed status established as the source of truth elsewhere this session",
    /d\.status === 'sent'/.test(mountFn) && /d\.signed/.test(mountFn));

  assert('openMobileJobDetail resets the Documents tab (and its load cache) on every open',
    /mJdTabDocuments[\s\S]{0,200}delete docBody\.dataset\.loadedFor/.test(widgets));

  assert('dashboard-bootstrap.module.js exports _stageWindowStateForLead for cross-file reuse',
    /window\._stageWindowStateForLead = _stageWindowStateForLead;/.test(bootstrap));

  assert('script-loader.js: docgen bundle carries customer-documents.js (lazy, not a second eager tag)',
    /docgen:\s*\[[\s\S]{0,700}customer-documents\.js/.test(loader));

  // 2026-09-17, same day as ship — Jo: "I love that we added a document
  // section... but no generate new doc or upload button so we can see it's
  // empty but do nothing about it." The Generate/Scan/Upload rows were only
  // built inside the docs.length branch; a rep with ZERO documents on a
  // lead (the exact moment they'd want to add one) saw "No documents yet"
  // and nothing else. actionRows must now be built once and used by BOTH
  // branches.
  assert('_mountDocumentsHub builds its action rows once, before branching on docs.length (not only inside the populated branch)',
    /const actionRows = genBtn \+ scanBtn \+ uploadBtn;[\s\S]{0,40}if \(!docs\.length\)/.test(mountFn));
  assert('the EMPTY-documents branch still renders actionRows, not just the empty message',
    /if \(!docs\.length\) \{[\s\S]{0,120}actionRows[\s\S]{0,120}No documents yet/.test(mountFn));
  assert('the populated-documents branch renders the SAME actionRows (not a second, divergent set)',
    /host\.innerHTML = '<div class="m-jd-act-list">' \+ actionRows \+ docs\.map/.test(mountFn));

  assert('a "Scan a signed document" row dispatches uploadSignedDoc(\'camera\') through the registry',
    /data-action="call" data-fn="uploadSignedDoc" data-arg="camera"/.test(mountFn));
  assert('an "Upload a file" row dispatches uploadSignedDoc(\'file\') through the registry',
    /data-action="call" data-fn="uploadSignedDoc" data-arg="file"/.test(mountFn));
  assert('_mountDocumentsHub wires the signed-upload file inputs on every mount (idempotent)',
    /_mJdWireSignedUploadInputs\(\);/.test(mountFn));

  const wireFn = actions.slice(actions.indexOf('function _mJdWireSignedUploadInputs'), actions.indexOf('// Mobile "Generate a document" entry point'));
  assert('_mJdWireSignedUploadInputs is defined and targets the same ids dashboard.html declares',
    /signedDocFileInput/.test(wireFn) && /signedDocBrowseInput/.test(wireFn));
  assert('the wiring is guarded so repeated tab visits never stack duplicate change listeners',
    /dataset\.mJdWired/.test(wireFn));
  assert('a change event reuses handleSignedDocUpload from customer-signed-doc-upload.js, not a second upload path',
    /window\.handleSignedDocUpload\(el\)/.test(wireFn));
  assert('after the upload settles, the mobile panel re-fetches and repaints (success or failure)',
    /delete host\.dataset\.loadedFor/.test(wireFn) && /_mountDocumentsHub\(\);/.test(wireFn));

  assert('uploadSignedDoc is registered in __NBD_CALL_REGISTRY (bare window.X exports never dispatch — see _mJdSwitchTab\'s own registry block)',
    /uploadSignedDoc: \(\.\.\.args\) => \(typeof window\.uploadSignedDoc === 'function'\) && window\.uploadSignedDoc\(\.\.\.args\)/.test(actions));

  assert('dashboard.html declares the two hidden signed-doc file inputs with the ids the wiring targets',
    /id="signedDocFileInput"[^>]*capture="environment"/.test(html) &&
    /id="signedDocBrowseInput"/.test(html));

  assert('script-loader.js: docgen bundle also carries customer-signed-doc-upload.js',
    /docgen:\s*\[[\s\S]{0,900}customer-signed-doc-upload\.js/.test(loader));
}

section('Customer-surface sweep — blockers caught in review (regression pins)');
{
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // ── 1. Job Value round-trip. The field is type="number"; assigning a legacy
  //    display string ("$45,000") to it makes the browser sanitize .value to '',
  //    so an unrelated save then wrote jobValue:0 over a live deal. BOTH ends of
  //    the round-trip must strip.
  const editModal = read(path.join(PRO_JS, 'customer-edit-modal.js'));
  assert('edit-modal SEEDS Job Value as a bare number (legacy "$45,000" survives)',
    /replace\(\/\[\^0-9\.\\-\]\/g, ''\)[\s\S]{0,200}getElementById\('editJobValue'\)\.value =/.test(editModal));
  assert('edit-modal WRITES Job Value as a number, never a raw string',
    /jobValue: parseFloat\(String\(document\.getElementById\('editJobValue'\)\.value\)\.replace/.test(editModal));
  const custHtml = read(path.join(ROOT, 'docs/pro/customer.html'));
  assert('Job Value input is type="number"',
    /id="editJobValue"[^>]*type="number"|type="number"[^>]*id="editJobValue"/.test(custHtml));

  // ── 2. Lightbox handshake. setLightboxSource is a CURSOR SETTER — it displays
  //    nothing. Returning early on it left the lightbox permanently closed, and
  //    the arg order (url, desc, arr, idx) into a (srcArray, idx) setter nulled
  //    the source, forcing the ‹ › arrows back onto the wrong customer's array.
  const tasksUi = read(path.join(PRO_JS, 'customer-tasks-ui.js'));
  // Comments in this function NAME setLightboxSource while explaining the
  // ordering rule, so the ordering check has to run against code only.
  const openLb = decomment(tasksUi.slice(tasksUi.indexOf('window.openPhotoLightbox = function'),
                                         tasksUi.indexOf('window.openPhotoLightbox = function') + 1900));
  assert('openPhotoLightbox DISPLAYS before handing over the cursor',
    openLb.indexOf("classList.add('active')") !== -1 &&
    openLb.indexOf('setLightboxSource') !== -1 &&
    openLb.indexOf("classList.add('active')") < openLb.indexOf('setLightboxSource'));
  assert('openPhotoLightbox calls the setter with (srcArray, idx) — its real signature',
    /setLightboxSource\(srcArray, Number\(idx\) \|\| 0\)/.test(openLb));
  assert('openPhotoLightbox locks body scroll (pairs with the canonical closeLightbox reset)',
    /document\.body\.style\.overflow = 'hidden'/.test(openLb));
  const bootstrap = read(path.join(PRO_JS, 'customer-bootstrap.module.js'));
  assert('setLightboxSource really is a two-arg cursor setter',
    /function setLightboxSource\(srcArray, idx\)/.test(bootstrap));
  assert('exactly one closeLightbox definition survives (the one that unlocks scroll)',
    (read(path.join(PRO_JS, 'customer-tasks-ui.js')).split('window.closeLightbox =').length - 1) === 0
    && (bootstrap.split('window.closeLightbox =').length - 1) === 1);

  // ── 3. _mJdShare lives on the DASHBOARD, where customer-portal.js is never
  //    loaded — so PortalLinkHelpers.resolveUrl/copyForLead throw 'Portal module
  //    not loaded'. It must mint through the dashboard's own callable path.
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const share = decomment(actions.slice(actions.indexOf('function _mJdShare()'),
                                        actions.indexOf('function _mJdAct(')));
  assert('_mJdShare mints via _mintPortalUrl (works on the dashboard)',
    /window\._mintPortalUrl\(id\)/.test(share));
  assert('_mJdShare does NOT use the customer-page-only PortalLinkHelpers minter',
    !/PortalLinkHelpers\.(resolveUrl|copyForLead)/.test(share));
  assert('_mJdShare still prefers the OS share sheet',
    /navigator\.share\(\{[\s\S]{0,200}url: portal/.test(share));
  assert('_mJdShare treats an AbortError as a dismissal, not a failure',
    /err\.name === 'AbortError'/.test(share));
  assert('_mJdShare records the share (feeds fresh pulse / stale-shares / engagement)',
    /recordShare\(id, 'share'\)/.test(share));
  const api = read(path.join(PRO_JS, 'dashboard-api.js'));
  // Scope to the minter's own body — _sharePortalLink sits directly below it
  // and legitimately does use the clipboard.
  const minter = decomment(api.slice(api.indexOf('window._mintPortalUrl = async function'),
                                     api.indexOf('window._sharePortalLink = async function')));
  assert('_mintPortalUrl is side-effect free (no clipboard/SMS/share-record in the minter)',
    minter.length > 0 &&
    !/navigator\.clipboard|window\.open\(|recordShare|showToast/.test(minter) &&
    /return location\.origin \+ '\/pro\/portal\.html\?token='/.test(minter));
  for (const page of ['dashboard.html']) {
    assert(`${page} still does NOT load customer-portal.js (the minter must not depend on it)`,
      !/customer-portal\.js/.test(read(path.join(ROOT, 'docs/pro', page))));
  }

  // ── 4. The mobile quick-action bar must NOT send on tap. smsForLead mints a
  //    portal link, composes a fixed body and POSTs to Twilio with no preview —
  //    an irreversible customer-facing send behind a button labelled "Text".
  const qab = read(path.join(PRO_JS, 'customer-quick-action-bar.js'));
  assert('quick-action bar Text/Email open the OS composer, never auto-send',
    /href="sms:\$\{escapeAttr\(phone\)\}"/.test(qab) &&
    /href="mailto:\$\{escapeAttr\(email\)\}"/.test(qab));
  assert('quick-action bar does not call the auto-sending portal helpers',
    !/(smsForLead|emailForLead)/.test(decomment(qab)));
}

section('Embedded per-customer photo hub (CustomerPhotoHub)');
{
  const hub = read(path.join(PRO_JS, 'customer-photo-hub.js'));
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  const engine = read(path.join(PRO_JS, 'photo-engine.js'));

  // "Does this file CALL X" assertions must not match X appearing in a comment
  // that explains why the file deliberately does NOT call it. These modules
  // carry long rationale headers, so strip comments before those checks.
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hubCode = decomment(hub);

  // ── The PHOTOS action must STAY on the customer, like the estimate action.
  const mJdAct = actions.slice(actions.indexOf('function _mJdAct('),
                               actions.indexOf('window._mJdAct = _mJdAct'));
  assert("_mJdAct photos case switches to the embedded Photos tab",
    /case 'photos':[\s\S]{0,700}_mJdSwitchTab\('photos'\)/.test(mJdAct));
  assert("_mJdAct photos case no longer closes the overlay or navigates to the photos view",
    !/case 'photos':[\s\S]{0,700}(closeMobileJobDetail\(\)|goTo\('photos'\))/.test(mJdAct));
  // The dead handoff global that navigation used is no longer WRITTEN here
  // (nbdSelectPhotoLead still owns it for the standalone photos view).
  assert('_mJdAct no longer sets the _currentPhotoLeadId handoff global',
    !/_currentPhotoLeadId\s*=/.test(decomment(mJdAct)));

  assert('hub mounts lazily on the first switch to the Photos tab',
    /if \(tab === 'photos'\) _mountPhotoHub\(\);/.test(actions));
  assert('_mountPhotoHub mounts for the CURRENT overlay lead',
    /function _mountPhotoHub\(\)[\s\S]{0,700}window\._cardDetailLeadId[\s\S]{0,700}CustomerPhotoHub\.mount\(host, leadId/.test(actions));
  assert('_mountPhotoHub degrades gracefully when the module is absent',
    /function _mountPhotoHub[\s\S]{0,400}if \(!window\.CustomerPhotoHub\)[\s\S]{0,220}return;/.test(actions));

  // ── The old read-only grid is GONE from openMobileJobDetail; the hub owns
  //    that tab. Re-adding it would resurrect the un-tappable thumbnails.
  const openFn = widgets.slice(widgets.indexOf('function openMobileJobDetail'),
                               widgets.indexOf('window.openMobileJobDetail'));
  assert('openMobileJobDetail no longer paints the dead read-only photo grid',
    !/m-jd-photo-grid/.test(openFn));
  assert('openMobileJobDetail unmounts the photo hub when the lead changes',
    /CustomerPhotoHub\.leadId\(\) !== leadId[\s\S]{0,120}\.unmount\(\)/.test(openFn));

  // ── The dashboard loads it (the legacy twin was retired 2026-09-02).
  for (const page of ['dashboard.html']) {
    const html = read(path.join(ROOT, 'docs/pro', page));
    assert(`${page}: loads customer-photo-hub.js`, /customer-photo-hub\.js/.test(html));
  }

  // ── The tab is a WORKSPACE, not a gallery: every control does real work.
  for (const [act, marker] of [
    ['camera', 'doCamera'],
    ['upload', 'doUpload'],
    ['cover',  'doCover'],
    ['tag',    'doTag'],
    ['delete', 'doDelete'],
  ]) {
    assert(`hub '${act}' action is wired to ${marker}`,
      new RegExp(`case '${act}':\\s*${marker}\\(`).test(hub));
  }
  // Tiles are buttons now, not inert <img> — the reported dead-control.
  assert('photo tiles are tappable buttons carrying a photo id',
    /class="cph-tile[\s\S]{0,120}data-cph-act="open" data-cph-id="/.test(hub));

  // ── The photo engine is lazy; every engine-backed action must load it first.
  assert('hub loads the lazy photos bundle before engine calls',
    /function ensureEngine\([\s\S]{0,300}ScriptLoader\.loadBundle\('photos'\)/.test(hub));
  assert('hub camera/upload/delete/tag all route through ensureEngine',
    (hub.match(/ensureEngine\(\)\.then/g) || []).length >= 4);

  // ── Cover contract mirrors customer-tasks-ui.js: BOTH the id and the
  //    denormalized url, toggle-to-clear. Every consumer reads coverPhotoUrl.
  const cover = hub.slice(hub.indexOf('function doCover('), hub.indexOf('function doTag('));
  assert('cover write sets coverPhotoId AND the denormalized coverPhotoUrl',
    /coverPhotoId: id, coverPhotoUrl: url/.test(cover));
  assert('cover is toggle-to-clear (second tap nulls both fields)',
    /coverPhotoId: null, coverPhotoUrl: null/.test(cover));
  assert('cover repaints the kanban (card thumb strip reads coverPhotoUrl)',
    /renderLeads\(window\._leads/.test(cover));
  // A deleted photo must not remain the lead's cover.
  assert('deleting the cover photo clears the cover',
    /coverPhotoId === id\) clearCover/.test(hub));

  // ── Mutations keep _photoCache authoritative rather than re-querying:
  //    PhotoEngine.getPhotosForLead is userId-only and would NARROW a team
  //    member's view, so it must NOT be used as the hub's refresh path.
  assert('hub renders from the team-scoped window._photoCache',
    /window\._photoCache\[_leadId\]/.test(hubCode));
  assert('hub does not refresh via the userId-only getPhotosForLead',
    !/getPhotosForLead|getPhotosForReport/.test(hubCode));

  // ── Safety.
  assert('hub has zero inline handlers',
    !/\son[a-z]+\s*=\s*["']/.test(hubCode) && !/javascript:/.test(hubCode));
  assert('hub refuses non-http photo urls (no javascript: into src/href)',
    /function safeUrl\([\s\S]{0,200}\^https\?:\\\/\\\//.test(hub));
  assert('hub escapes interpolated photo fields',
    /esc\(sel\.description/.test(hub) && /esc\(p\.id\)/.test(hub));

  // ── Tenancy: uploads must be visible to teammates. The dashboard's photo
  //    cache queries userId==me OR companyId==my tenant; uploads that stamped
  //    only userId were invisible to every teammate.
  assert('photo uploads stamp companyId for team visibility',
    /companyId: window\._userClaims\.companyId/.test(engine));
  assert('companyId is omitted (not null) when the user has no company claim',
    /window\._userClaims && window\._userClaims\.companyId[\s\S]{0,120}: \{\}/.test(engine));
}

section('Load-status banner yields to full-screen overlays (max-z occlusion)');
{
  // The banner is fixed bottom-right at z-index 2147483646 — above EVERY
  // overlay in the app. A browser occlusion sweep (390x844) caught it
  // sitting on the V2 builder's mobile step bar, blocking the "② Items"
  // button and the live grand total; the same corner holds modal primary
  // actions generally. It must suppress itself while an overlay is open.
  const src = read(path.join(PRO_JS, 'dashboard-load-status-banner.js'));
  assert('_overlayOpen covers the builder, preview sheet, presentation + modals',
    /function _overlayOpen\(\)[\s\S]{0,600}#estV2Modal\.open[\s\S]{0,300}nbd-ep-overlay[\s\S]{0,300}v2Present[\s\S]{0,300}\.modal-bg\.open/.test(src));
  assert('_render bails early (hidden) while an overlay is open',
    /if \(_overlayOpen\(\)\) \{\s*if \(banner\) banner\.style\.display = 'none';/.test(src));
  // Hiding must not burn the 30s auto-dismiss clock — otherwise the banner
  // silently expires behind a modal and the rep never sees the retry.
  assert('auto-dismiss clock holds while suppressed',
    /if \(_overlayOpen\(\)\)[\s\S]{0,200}if \(_shownAt\) _shownAt = Date\.now\(\);/.test(src));
  // Suppression only — never a permanent dismiss, so it returns on close.
  assert('suppression does not set the user-dismissed flag',
    !/if \(_overlayOpen\(\)\)[\s\S]{0,200}_dismissedByUser = true/.test(src));
}

section('Storm Proof button: works before the lazy storm bundle loads');
{
  // The card-detail 🛡️ Storm Proof button dispatches data-action="call"
  // data-fn="verifyStormProofForLead", but the real function rides the lazy
  // 'storm' bundle — reachable-from-CRM taps hit an unresolved registry key
  // and the delegate no-ops silently (the reported dead button). The eager
  // stub in dashboard-actions.js must load the bundle on first tap.
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  assert('eager stub loads the storm bundle then delegates to StormIntegration',
    /async function verifyStormProofForLeadLazy\(\)[\s\S]{0,900}ScriptLoader\.loadBundle\('storm'\)[\s\S]{0,600}StormIntegration\.verifyStormProofForLead\(\)/.test(actions));
  assert('stub registered under the button\'s data-fn name',
    /verifyStormProofForLead: verifyStormProofForLeadLazy,/.test(actions));
  const storm = read(path.join(PRO_JS, 'storm-integration.js'));
  assert('storm-integration replaces the stub with the real registration on load',
    /Object\.assign\(window\.__NBD_CALL_REGISTRY, \{\s*verifyStormProofForLead: verifyStormProofForLead\s*\}\)/.test(storm));
  const dashHtml = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('card-detail button dispatches via data-action=call (CSP-safe)',
    /data-action="call" data-fn="verifyStormProofForLead"/.test(dashHtml));
}

section('Metrics audit F1-F9: one honest definition per number');
{
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  const api = read(path.join(PRO_JS, 'dashboard-api.js'));
  const crm = readCrm();
  const kpi = read(path.join(PRO_JS, 'analytics-kpi.js'));
  const ea = read(path.join(PRO_JS, 'estimate-analytics.js'));
  const rep = read(path.join(PRO_JS, 'rep-report-generator.js'));
  const d2d = read(path.join(PRO_JS, 'd2d-tracker-core-2026b.js'));

  // F1 — the "Pipeline Value" tile belongs to renderLeads alone. The old
  // estimate-sum write in renderEstimatesList was masked by boot ordering
  // and resurfaced on every live estimates-snapshot repaint.
  const rel = widgets.slice(widgets.indexOf('function renderEstimatesList'),
                            widgets.indexOf('function renderEstimatesList') + 2200);
  assert('F1: renderEstimatesList never writes #statVal',
    !/getElementById\('statVal'\)/.test(rel));

  // F2 — CRM pipeline value counts deals still in play only; a dollar lives
  // in exactly one bucket (pipeline until closed, closedRev after).
  assert('F2: pipeVal excludes closed/won money (active only)',
    /if\(!isLost && !isClosed\) pipeVal\+=v;/.test(crm));

  // F3 — close-date attribution uses stageStartedAt, not the updatedAt
  // proxy that re-attributed old closes to whatever month you last touched
  // the record.
  assert('F3: analytics-kpi attributes monthly revenue by stageStartedAt',
    /toJSDate\(l\.stageStartedAt \|\| l\.updatedAt\)/.test(kpi));
  assert('F3: rep report has a stageStartedAt-first stageDate helper',
    /const stageDate = \(lead\) => toDate\(lead\.stageStartedAt \|\| lead\.updatedAt \|\| lead\.createdAt\)/.test(rep));
  // Multi-job (2026-09-30): over every job's record (`recs`) — same stageDate rule.
  assert('F3: rep report core KPIs decide won/lost by stageDate',
    /const decidedInRange = (leads|recs)\.filter\(l =>\s*inRange\(stageDate\(l\)/.test(rep));

  // F4 — leaderboard attributes by the lead's OWNER, and the viewer's knock
  // count lands on the viewer's own row (not "first rep in object order").
  const lb = api.slice(api.indexOf('async function renderLeaderboard'),
                       api.indexOf('async function renderLeaderboard') + 4200);
  // Multi-job (2026-09-30): rows via rep(l.userId || '(unknown)') for both the
  // customer count and the per-job wins — still keyed by the OWNER uid.
  assert('F4: leaderboard groups by lead.userId (owner), not display name',
    (/const owner = l\.userId \|\| '\(unknown\)'/.test(lb) || (lb.match(/rep\(l\.userId \|\| '\(unknown\)'\)/g) || []).length === 2)
    && !/const n = l\.repName \|\| window\._user/.test(lb));
  assert('F4: viewer\'s knocks land on the viewer\'s own row',
    /reps\[uid\]\.knocks = knockCount/.test(lb));

  // F4 follow-up (first-run audit 2026-07-28): the knocks enrichment used
  // to materialize the viewer's row unconditionally, which handed a
  // brand-new tenant a gold medal at 0 leads / 0 knocks and made the
  // authored empty state below it dead code.
  assert('leaderboard: viewer row is only materialized when knocks exist',
    /if \(knockCount > 0\) \{[\s\S]{0,400}if \(!reps\[uid\]\) reps\[uid\][\s\S]{0,300}reps\[uid\]\.knocks = knockCount;[\s\S]{0,50}\}/.test(lb));
  assert('leaderboard: no unconditional viewer-row insert after the knocks query',
    !/knockCount = snap\.size;\s*\n\s*if \(!reps\[uid\]\)/.test(lb));
  assert('leaderboard: zero-data empty state exists and is reachable',
    /No data yet\. Close deals to appear on the leaderboard/.test(lb));

  // F5 — viewed counts every opened estimate; View→Sign numerator is a
  // strict subset of its denominator (can't exceed 100%).
  assert('F5: viewed counted across all buckets + signedViewed numerator',
    /if \(viewedMs\) out\.viewed\+\+;/.test(ea)
    && /if \(viewedMs\) out\.signedViewed\+\+;/.test(ea)
    && /out\.signedViewed \/ out\.viewed/.test(ea)
    && /_pct\(s\.signedViewed, s\.viewed\)/.test(ea));

  // F6 — lost estimates stay in the close-rate denominator (no survivor bias).
  assert('F6: estimate close rate includes lost in the denominator',
    /out\.signed \/ \(out\.sent \+ out\.signed \+ out\.lost\)/.test(ea)
    && /_pct\(s\.signed, s\.sent \+ s\.signed \+ s\.lost\)/.test(ea));

  // F7 — the mobile KPI row's overdue count skips in-production leads, same
  // as the CRM's #12 definition.
  // 2026-10-03: via THE follow-up rule (today-plan.js followUpDue skips
  // won / lost / job by role — tests/today-plan-2026-10-03.test.js).
  assert('F7: overdueFollowUps skips job-role leads',
    /var overdueFollowUps = fuDue \? leads\.filter\(function \(l\) \{ return fuDue\(l, now\.getTime\(\)\); \}\)\.length : 0;/.test(kpi));

  // F8 — in-production (job role) money is closed-won everywhere, never
  // "active pipeline".
  assert('F8: analytics-kpi active pipeline excludes job-role leads',
    /return !_isDecided\(l\) && !_isJob\(l\) && !l\.deleted;/.test(kpi));
  assert('F8: analytics-kpi counts won OR job as closed-won',
    /function _isClosedWon\(l\) \{ return _isWon\(l\) \|\| _isJob\(l\); \}/.test(kpi));
  assert('F8: rep report isWon is role-aware (won or job)',
    /return r === 'won' \|\| r === 'job';/.test(rep));

  // F9 — expected-value calibration: dispo weights blend the static priors
  // with this tenant's own observed outcomes (Beta shrinkage), and the deal
  // size falls back D2D closes → CRM won average → industry default.
  assert('F9: calibratedDispoWeights blends observed outcomes with priors',
    /function calibratedDispoWeights\(\)/.test(d2d)
    && /CALIBRATION_PRIOR_STRENGTH = 12/.test(d2d)
    && /\(s\.won \+ out\[k\] \* CALIBRATION_PRIOR_STRENGTH\)\s*\/ \(s\.decided \+ CALIBRATION_PRIOR_STRENGTH\)/.test(d2d));
  assert('F9: pipeline valuation uses the calibrated weights',
    /const calibrated = calibratedDispoWeights\(\);/.test(d2d)
    && /pipelineValue \+= \(dispoWeights\[k\.disposition\] \|\| 0\) \* dealValue/.test(d2d));
  assert('F9: deal size averages ALL closes with CRM-won fallback',
    /const allClosedKnocks = state\.knocks\.filter\(k => k\.closedDealValue > 0\)/.test(d2d)
    && /const dealValue = avgDealSize \|\| crmAvgDeal \|\| DEFAULT_JOB_VALUE;/.test(d2d));
  assert('F9: revenue metrics expose calibration provenance',
    /dealValueSource: avgDealSize \? 'd2d-closes' : \(crmAvgDeal \? 'crm-won-avg' : 'default'\)/.test(d2d)
    && /calibratedDispos: calibrated\.calibratedCount/.test(d2d));
}

section('Search job cards: palette phone/email search + RoofLink-style result rows');
{
  const cp  = read(path.join(ROOT, 'docs/pro/js/command-palette.js'));
  const crm = read(path.join(ROOT, 'docs/pro/js/crm-pipeline.js'));

  // Phone search — digits vs digits, 3-digit floor, prefers the
  // canonical phoneDigits key with raw-phone fallback.
  assert('palette matches phone by normalized digits (3-digit floor, phoneDigits||phone)',
    /const qDigits = q\.replace\(\/\\D\/g, ''\)/.test(cp)
    && /qDigits\.length >= 3/.test(cp)
    && /l\.phoneDigits \|\| l\.phone/.test(cp)
    && /digits\.includes\(qDigits\)\) fuzzy = Math\.max\(fuzzy, 80\)/.test(cp));
  assert('palette matches email substring (3-char floor)',
    /email && email\.includes\(qLower\)\) fuzzy = Math\.max\(fuzzy, 70\)/.test(cp));

  // Job-card context — every source best-effort behind window guards.
  assert('lead rows carry card context: stage label/role color, jobType meta, thumb, value, assignee',
    /window\.stageLabel/.test(cp)
    && /window\.stageRole/.test(cp)
    && /_ROLE_COLORS\[role\]/.test(cp)
    && /window\.JOB_TYPE_META && lead\.jobType/.test(cp)
    && /window\._photoCache && window\._photoCache\[lead\.id\]/.test(cp)
    && /window\._repNames \|\| window\._teamNames/.test(cp));
  assert('photo thumb only renders http(s) URLs',
    /photos\.find\(p => \/\^https\?:\/i\.test\(String\(\(p && p\.url\) \|\| ''\)\)\)/.test(cp));
  assert('card rows render stage dot + chips, escaped, with compact fallback for actions',
    /const c = item\.card;/.test(cp)
    && /width:7px;height:7px;border-radius:50%/.test(cp)
    && /escHtml\(c\.thumb\)/.test(cp) && /escHtml\(c\.stage\)/.test(cp) && /escHtml\(c\.jobType\)/.test(cp));

  // CRM board search bar gets the same digit-normalized phone matching.
  assert('kanbanFilter matches digit-normalized phone with 3-digit floor',
    /const searchDigits = search\.replace\(\/\\D\/g, ''\)/.test(crm)
    && /searchDigits\.length >= 3 && phoneDigits\.includes\(searchDigits\)/.test(crm)
    && /l\.phoneDigits \|\| l\.phone/.test(crm));

  // Cache-bust: markup must load the upgraded palette.
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('dashboard loads command-palette v2+',
    /js\/command-palette\.js\?v=([2-9]|\d{2,})/.test(dash));
}

section('Canonical estimate money reader ships with its consumers');
{
  // customer-estimate-rows.js owns estimateValue() — the ONE reader that maps
  // both estimate shapes (V2 grandTotal / Classic total|amount) to a number.
  // Its consumers all guard with `window.NBDCustomerEstimateRows && ...` and
  // fall back to a weaker inline ladder, which makes a missing <script> tag
  // invisible: nothing throws, the numbers just quietly come out low or zero.
  //
  // It was loaded ONLY on customer.html, so every consumer on both dashboard
  // pages ran the fallback — including invoice-pipeline (a money path) and the
  // embedded estimate hub, whose ★ Primary button writes lead.jobValue, the
  // value the kanban $, KPIs and leaderboard all read.
  //
  // So: any page loading a consumer must also load the reader, BEFORE it.
  const CONSUMERS = [
    'customer-estimate-hub.js',
    'invoice-pipeline.js',
    'dashboard-widgets.js',
  ];
  const PAGES = ['docs/pro/dashboard.html', 'docs/pro/customer.html'];

  for (const page of PAGES) {
    const html = read(path.join(ROOT, page));
    const used = CONSUMERS.filter((c) => html.includes(c));
    if (!used.length) continue;
    const readerAt = html.indexOf('customer-estimate-rows.js');
    assert(`${page} loads the canonical reader (consumers: ${used.join(', ')})`,
      readerAt > -1,
      'without it these consumers silently fall back to a weaker money ladder');
    // Order matters for the same reason nbd-url.js loads before its callers:
    // a consumer that runs first sees window.NBDCustomerEstimateRows undefined.
    for (const c of used) {
      assert(`${page} loads the reader before ${c}`,
        readerAt > -1 && readerAt < html.indexOf(c),
        'defer scripts execute in document order — a later reader is too late');
    }
  }

  // The hub keeps a local fallback for the case where the reader is absent.
  // It must parse display strings the way numFrom() does; Number('$14,500')
  // is NaN and collapses to 0, which is how a live deal gets zeroed.
  const hub = read(path.join(PRO_JS, 'customer-estimate-hub.js'));
  assert('hub totalOf prefers the canonical reader',
    /NBDCustomerEstimateRows[\s\S]{0,120}estimateValue/.test(hub));
  assert('hub totalOf fallback strips commas instead of Number()-ing a display string',
    /match\(\/-\?\\d\[\\d,\]\*\\\.\?\\d\*\//.test(hub) && /replace\(\/,\/g, ''\)/.test(hub));

  // Classic docs carry their value on `amount`; a ladder that stops at
  // grandTotal|total scores them 0 and drops the "· $X" suffix entirely.
  const dw = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  assert('job-detail activity reads Classic `amount`, not just grandTotal|total',
    /estimateValue\(e\)/.test(dw) && /e\.amount/.test(dw));
}

section('First-run tour: anchors resolve + direction-aware skip (first-run audit 2026-07-28)');
{
  // The tour's "Tap the orange + button" tooltip floated centered with no
  // spotlight because every selector in the step-3 anchor list was
  // unresolvable (wrong id, CSP-dead [onclick*=], position:fixed rejected
  // by the offsetParent visibility test). These pins guard the three
  // contracts that prevent a recurrence.
  const tour = read(path.join(PRO_JS, 'onboarding-tour.js'));
  const pages = {
    'docs/pro/dashboard.html': read(path.join(ROOT, 'docs/pro/dashboard.html')),
  };

  // (a) every #id anchor in the tour must exist in the dashboard page —
  // the exact class of markup drift that caused the defect.
  const anchorLiterals = [...tour.matchAll(/anchor:\s*'([^']+)'/g)].map((m) => m[1]);
  assert('tour declares anchored steps', anchorLiterals.length >= 2);
  for (const literal of anchorLiterals) {
    for (const sel of literal.split(',').map((s) => s.trim()).filter(Boolean)) {
      // (b) CSP sweep: no on*= attributes exist anywhere under /pro, so an
      // [onclick*=...] anchor can never resolve — ban the pattern outright.
      assert(`tour anchor "${sel}" is not an [onclick sniff (CSP: no on*= attrs)`,
        !sel.includes('[onclick'));
      const idMatch = sel.match(/^#([A-Za-z0-9_-]+)$/);
      if (!idMatch) continue;
      for (const [page, html] of Object.entries(pages)) {
        assert(`tour anchor #${idMatch[1]} exists in ${page}`,
          html.includes(`id="${idMatch[1]}"`));
      }
    }
  }
  // The one non-#id anchor (desktop Settings gear) must keep matching too.
  for (const [page, html] of Object.entries(pages)) {
    assert(`tour Settings anchor (.hdr-tool[data-target="settings"]) matches markup in ${page}`,
      /class="hdr-tool[^"]*"[^>]*data-target="settings"/.test(html));
  }

  // (c) visibility contract: findAnchor must judge visibility by layout box
  // + computed style — offsetParent is null for position:fixed elements
  // that ARE visible (the FAB, the mobile bottom nav) and non-null for
  // visibility:hidden ones.
  const fa = tour.slice(tour.indexOf('function findAnchor'),
                        tour.indexOf('function findAnchor') + 1100);
  assert('tour: findAnchor visibility uses rect + computed style',
    /getBoundingClientRect\(\)/.test(fa) && /getComputedStyle\(/.test(fa));
  assert('tour: findAnchor no longer relies on offsetParent',
    !/offsetParent/.test(tour));

  // (d) skip contract: an anchored step whose anchor can't be found is
  // skipped in the direction of travel (never rendered as a floating
  // centered tooltip). Loose regex on intent, not mechanism.
  const rs = tour.slice(tour.indexOf('function renderStep'),
                        tour.indexOf('function renderStep') + 1600);
  assert('tour: renderStep skips unresolvable anchored steps in the travel direction',
    /while\s*\(STEPS\[_stepIdx\][\s\S]{0,260}findAnchor\(STEPS\[_stepIdx\]\.anchor\)\)[\s\S]{0,160}_stepIdx \+= _dir/.test(rs));
  // Backward exhaustion clamps to step 0 — which therefore must stay an
  // unanchored placement:'center' step or the skip loop loses its
  // guaranteed landing spot.
  const firstStep = tour.slice(tour.indexOf('const STEPS = ['),
                               tour.indexOf('const STEPS = [') + 500);
  assert('tour: step 0 stays unanchored + centered (backward-skip clamp target)',
    /anchor:\s*null/.test(firstStep) && /placement:\s*'center'/.test(firstStep));

  // Public API unchanged — dashboard-actions' restartOnboardingTour guards
  // on forceRestart existing.
  assert('tour: public API start/stop/forceRestart intact',
    /window\.OnboardingTour = \{\s*start,\s*stop: complete,\s*forceRestart/.test(tour));
}

section('Mobile overflow sweep 2026-09-14 — 5 invisible-horizontal-scroll bugs');
{
  // Same defect class as PR #1531's Wave 5c-adjacent fix (.jump-nav,
  // .crm-hdr-views, .cb-stats-row): a tab/chip/stat row using
  // overflow-x:auto with the scrollbar hidden or effectively invisible on
  // iOS, so it silently truncates instead of signaling more content. Fixed
  // with the same CSS mask-image right-edge fade (no JS) where the row is
  // "always tight", and with a grid-collapse / flex-wrap where the overflow
  // is a layout floor rather than a scroller.
  const dash = readDashboardStyles(); // dashboard.html + extracted css
  const repOs = read(path.join(PRO_JS, 'rep-os.js'));
  const productLib = read(path.join(PRO_JS, 'product-library.js'));
  const rda = read(path.join(PRO_JS, 'real-deal-academy.js'));

  // 1. Settings — #stab-bar (13 .stab-btn tabs), dashboard.html + dashboard-app.css.
  assert('#stab-bar gets a mobile mask-image fade (Settings tab bar)',
    /#stab-bar\{\s*-webkit-mask-image:linear-gradient\(to right,#000 calc\(100% - 24px\),transparent 100%\);\s*mask-image:linear-gradient\(to right,#000 calc\(100% - 24px\),transparent 100%\);\s*\}/.test(dash),
    'expected #stab-bar to get the same mask-image right-edge fade as .crm-hdr-views/.cb-stats-row');
  const stabBarTag = /<div id="stab-bar" style="([^"]*)"/.exec(dash);
  assert('#stab-bar inline style enables -webkit-overflow-scrolling:touch',
    !!stabBarTag && /-webkit-overflow-scrolling:touch/.test(stabBarTag[1]),
    'expected #stab-bar to opt into momentum scrolling on iOS like the other scroll-affordance fixes');

  // 2. Rep OS — Performance Snapshot row (rep-os.js), 4 cards with a
  //    304px floor width that overflows a ~296px 320px-phone content width.
  assert('rep-os.js Performance Snapshot row uses the .ros-perf-row class',
    // (reskin 2026-10-02: the row's layout moved to a class in css/rep-os.css)
    /class="ros-perf-row rpx-dflex-gap8px-mb10px"/.test(repOs) &&
      /\.rpx-dflex-gap8px-mb10px[^{]*\{ display: flex; gap: 8px; margin-bottom: 10px; overflow-x: auto; \}/.test(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'docs', 'pro', 'css', 'rep-os.css'), 'utf8')),
    'expected the Performance Snapshot row to carry a class so dashboard-app.css can target it');
  assert('.ros-perf-row has a mask-image fade (Rep OS Performance Snapshot)',
    /\.ros-perf-row\{\s*-webkit-mask-image:linear-gradient\(to right,#000 calc\(100% - 24px\),transparent 100%\);\s*mask-image:linear-gradient\(to right,#000 calc\(100% - 24px\),transparent 100%\);\s*\}/.test(dash),
    'expected .ros-perf-row to get the same mask-image right-edge fade as .cb-stats-row');

  // 3. Products — product card grid (product-library.js), minmax(320px,1fr)
  //    floor is wider than the ~296px content width at a 320px viewport.
  assert('product-library.js grid uses the .pl-product-grid class',
    /class="pl-product-grid" style="display:\$\{isCollapsed \? 'none' : 'grid'\};margin-top:/.test(productLib),
    'expected the product card grid to carry a class so a media query can collapse its columns');
  // A bare `1fr` track is NOT the same as `minmax(0,1fr)`: per the CSS Grid
  // spec, a flex track with no minmax() wrapper gets an IMPLICIT automatic
  // minimum of `auto` — i.e. the widest min-content contribution among the
  // grid's children — not 0. This card's own content (a `white-space:nowrap`
  // cost/meta badge) has a ~307px min-content width, so a bare `1fr` still
  // silently clipped a badge/button with no scrollbar at a 320px viewport
  // even though the rule LOOKED like a correct single-column collapse
  // (verified live: forcing `grid-template-columns:1fr !important` via
  // devtools did not change the computed track size at all — the fix has to
  // be `minmax(0,1fr)`, explicitly overriding the implicit `auto` floor).
  assert('.pl-product-grid collapses to a TRUE zero-floor single column under 360px',
    /@media \(max-width:360px\)\{\.pl-product-grid\{grid-template-columns:minmax\(0,1fr\);\}\}/.test(productLib),
    'expected minmax(0,1fr), not bare 1fr — a bare flex track has an implicit auto (min-content) minimum, so it can still overflow its container');
  assert('.pl-product-grid does NOT regress to the bare-1fr shape that still clips at 320px',
    !/@media \(max-width:360px\)\{\.pl-product-grid\{grid-template-columns:1fr;\}\}/.test(productLib),
    'a bare 1fr here silently clips a card badge/button with no scrollbar — confirmed live at a real 320px viewport in both a Chromium/Playwright load and the Browser-pane MCP tool');

  // 4. Drawing Tool — .draw-mode-row (dashboard.html/dashboard-app.css),
  //    4 flex:1 buttons with no flex-wrap, inconsistent with its sibling
  //    .draw-btns groups two elements over which already wrap.
  assert('.draw-mode-row wraps its buttons instead of forcing an overflow',
    /\.draw-mode-row\{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;\}/.test(dash),
    'expected .draw-mode-row to add flex-wrap:wrap, matching the sibling .draw-btns groups');

  // 5. Bonus — Real Deal Academy tabs (real-deal-academy.js): the existing
  //    @media(max-width:768px) block shrinks gap/padding/font-size but never
  //    added an affordance for the long Overview/Insurance/Retail/... labels.
  assert('.rda-tabs mobile override adds a mask-image scroll affordance',
    /\.rda-tabs\s*\{\s*gap:\s*2px;\s*-webkit-mask-image:\s*linear-gradient\(to right,\s*#000 calc\(100% - 24px\),\s*transparent 100%\);\s*mask-image:\s*linear-gradient\(to right,\s*#000 calc\(100% - 24px\),\s*transparent 100%\);\s*\}/.test(rda),
    'expected the existing @media(max-width:768px) .rda-tabs override to add a mask-image fade like the other mobile tab/chip rows');
}

section('Mobile job-detail full parity: Voice Intel, Messages, Documents actions (2026-09-17)');
{
  // Jo: "I want the same capabilities as computer. That's what we sold the
  // CRM for at the landing page. Full CRM in your phone NOT half in your
  // phone the rest at home" — docs/pro/index.html:1215 stakes the whole
  // pitch on this ("Whatever you're using better work on your phone...or
  // it doesn't work"). This section covers the three follow-ups that
  // completed the mobile job-detail overlay's parity with customer.html's
  // Documents/Messages/Voice Intel tabs.
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  const bootstrap = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
  const html = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const realtime = read(path.join(PRO_JS, 'customer-realtime.module.js'));
  const realtimeBootstrap = read(path.join(PRO_JS, 'customer-realtime-bootstrap.module.js'));
  const bridge = read(path.join(PRO_JS, 'voice-intel-dashboard-bridge.module.js'));

  // ── Voice Intel tab ──────────────────────────────────────────────────
  assert("dashboard.html: Voice Intel tab button dispatches _mJdSwitchTab('voice')",
    /data-tab="voice"[^>]*data-fn="_mJdSwitchTab" data-arg="voice"/.test(html));
  assert('dashboard.html: #mJdTabVoice panel + #mJdVoiceIntelRoot mount point exist',
    /id="mJdTabVoice"[^>]*role="tabpanel"/.test(html) && /id="mJdVoiceIntelRoot"/.test(html));
  assert('dashboard.html loads voice-intelligence.css (Voice Intel styling)',
    /voice-intelligence\.css/.test(html));
  assert("_mJdSwitchTab maps the voice tab to #mJdTabVoice and mounts lazily",
    /voice:'mJdTabVoice'/.test(actions) && /if \(tab === 'voice'\) _mountVoiceIntel\(\);/.test(actions));
  const voiceFn = actions.slice(actions.indexOf('function _mountVoiceIntel'), actions.indexOf('// Called from openMobileJobDetail'));
  assert('_mountVoiceIntel is defined', voiceFn.length > 0);
  assert('_mountVoiceIntel calls window.VoiceIntel.mount with the overlay lead + live auth/db/storage',
    /window\.VoiceIntel\.mount\(\{/.test(voiceFn) && /leadId, containerEl: host, auth: window\.auth, db: window\.db, storage: window\.storage/.test(voiceFn));
  assert('_mountVoiceIntel skips re-mounting for the SAME lead (avoids a duplicate Firestore listener)',
    /if \(_voiceMountedFor === leadId\) return;/.test(voiceFn));
  assert('_mountVoiceIntel degrades gracefully when the bridge module is absent',
    /if \(!window\.VoiceIntel[\s\S]{0,160}return;/.test(voiceFn));
  assert('voice-intel-dashboard-bridge.module.js imports the REAL initVoiceIntel (no reimplementation)',
    /import \{ initVoiceIntel \} from '\.\/voice-intelligence\.js';/.test(bridge) &&
    /window\.VoiceIntel = \{ mount: initVoiceIntel \};/.test(bridge));

  // ── Messages tab ─────────────────────────────────────────────────────
  assert("dashboard.html: Messages tab button dispatches _mJdSwitchTab('messages')",
    /data-tab="messages"[^>]*data-fn="_mJdSwitchTab" data-arg="messages"/.test(html));
  assert('dashboard.html: #mJdTabMessages panel carries the SAME repMsg* ids customer.html uses',
    /id="mJdTabMessages"[^>]*role="tabpanel"/.test(html) &&
    /id="repMsgThread"/.test(html) && /id="repMsgEmpty"/.test(html) &&
    /id="repMsgText"/.test(html) && /id="repMsgSend"/.test(html) && /id="repMsgStatus"/.test(html));
  assert('dashboard.html: Messages tab button carries its own #mJdMsgBadge unread badge',
    /id="mJdMsgBadge"/.test(html));
  assert("_mJdSwitchTab maps the messages tab to #mJdTabMessages and mounts lazily",
    /messages:'mJdTabMessages'/.test(actions) && /if \(tab === 'messages'\) _mountMessagesHub\(\);/.test(actions));
  const msgFn = actions.slice(actions.indexOf('function _mountMessagesHub'), actions.indexOf('function _mountVoiceIntel'));
  assert('_mountMessagesHub is defined', msgFn.length > 0);
  assert('_mountMessagesHub reuses window.CustomerMessages.mount(), not a second Firestore subscription',
    /window\.CustomerMessages\.mount\(\{ leadId, db: window\.db \}\)/.test(msgFn));
  assert('_mountMessagesHub skips re-mounting for the SAME lead (avoids a duplicate onSnapshot)',
    /if \(_messagesMountedFor === leadId\) return;/.test(msgFn));
  assert('_mountMessagesHub clears the thread synchronously so the PREVIOUS lead\'s bubbles never show mid-fetch',
    /threadEl\.querySelectorAll\('\.rep-bubble'\)\)\.forEach\(n => n\.remove\(\)\)/.test(msgFn));

  // Teardown: a listener mounted for lead A must not keep running once the
  // rep opens lead B without ever revisiting these tabs.
  assert('_mJdTeardownRealtimeTabs is defined and registered in __NBD_CALL_REGISTRY for dashboard-widgets.js to call (Globals Tranche 3 T3-C)',
    /function _mJdTeardownRealtimeTabs\(newLeadId\)/.test(actions) &&
    /_mJdTeardownRealtimeTabs: _mJdTeardownRealtimeTabs,/.test(actions) &&
    !/window\._mJdTeardownRealtimeTabs\s*=/.test(actions));
  assert('_mJdTeardownRealtimeTabs unmounts Messages/Voice ONLY when the lead actually changed',
    /_messagesMountedFor && _messagesMountedFor !== newLeadId/.test(actions) &&
    /_voiceMountedFor && _voiceMountedFor !== newLeadId/.test(actions));
  // Scoped to openMobileJobDetail's own body — openCardDetailModal (the
  // DESKTOP card modal, earlier in this file) sets the same
  // window._cardDetailLeadId global itself, so an unscoped search matches
  // the wrong function.
  const openMobileFn = widgets.slice(widgets.indexOf('function openMobileJobDetail'),
                                      widgets.indexOf('window.openMobileJobDetail'));
  assert('openMobileJobDetail calls the teardown on every open, before staging the new lead\'s data',
    /window\._cardDetailLeadId = leadId;[\s\S]{0,1200}_nbdReg\._mJdTeardownRealtimeTabs\(leadId\)/.test(openMobileFn));

  // ── Tranche 3 T3-A (2026-09-18): the prospect-ops cluster —
  // confirmPromoteProspect, toggleProspectHidden, viewProspectOnMap,
  // absoluteDeleteProspect ──
  // Unlike every T3-C edge above, this one required NEWLY IIFE-wrapping a
  // region of dashboard-actions.js that was previously true top-level
  // classic-script code (between two pre-existing IIFEs) — a genuinely
  // different, higher-risk shape (converting window.X = function(){} to a
  // plain declaration at TRUE top level would NOT take it off window;
  // wrapping in a new IIFE is what actually does). _prospectConfirm/
  // _prospectPrompt are private helpers with no external consumer — no
  // registry entry, stay module-local inside the new IIFE.
  const prospectFn = actions.slice(actions.indexOf('_prospectConfirm(message, opts)'),
                                    actions.indexOf('CUSTOMER-PAGE HANDOFF'));
  assert('the prospect-ops cluster is wrapped in its own new IIFE (not left at top level)',
    /\(function \(\) \{\r?\n\/\/ Async confirm helper/.test(actions) &&
    /confirmPromoteProspect: confirmPromoteProspect,[\s\S]{0,220}\}\);\r?\n\}\)\(\);/.test(actions));
  for (const n of ['confirmPromoteProspect', 'toggleProspectHidden', 'viewProspectOnMap', 'absoluteDeleteProspect']) {
    assert('dashboard-actions.js registers ' + n + ' in __NBD_CALL_REGISTRY (T3-A)',
      new RegExp('\\b' + n + ':\\s*' + n + '\\b').test(prospectFn));
    assert('dashboard-actions.js no longer exposes window.' + n + ' (T3-A off window)',
      !new RegExp('window\\.' + n + '\\s*=').test(prospectFn));
  }
  assert('_prospectConfirm and _prospectPrompt stay private (no registry entry — no consumer outside this cluster)',
    !/_prospectConfirm:/.test(prospectFn) && !/_prospectPrompt:/.test(prospectFn));
  assert('confirmPromoteProspect is no longer in the __NBD_CALL_ALLOWLIST (its real markup dispatch was always cdaConfirmPromote, already registered separately)',
    !/'confirmPromoteProspect'/.test(read(path.join(PRO_JS, 'dashboard-state.js'))));
  assert('cdaConfirmPromote (the card-detail-action IIFE, a DIFFERENT scope) reads confirmPromoteProspect off the registry, not bare window',
    /_nbdReg\.confirmPromoteProspect\(window\._cardDetailLeadId\)/.test(actions) && !/window\.confirmPromoteProspect\(/.test(actions));
  assert('dashboard-widgets.js\'s prospect quick-actions read all 3 of its names off the registry, not bare window',
    /_nbdReg && _nbdReg\.viewProspectOnMap\(lead\.id\)/.test(widgets) &&
    /_nbdReg && _nbdReg\.toggleProspectHidden\(lead\.id\)/.test(widgets) &&
    /_nbdReg && _nbdReg\.absoluteDeleteProspect\(lead\.id\)/.test(widgets) &&
    !/window\.viewProspectOnMap\(/.test(widgets) && !/window\.toggleProspectHidden\(/.test(widgets) && !/window\.absoluteDeleteProspect\(/.test(widgets));

  // ── Tranche 3 T3-A (2026-09-18): dashboard-connect-tab.js — the session's
  // first WHOLE-FILE IIFE wrap (432 lines, previously zero IIFE structure at
  // all — every one of its 13 functions was a true top-level classic-script
  // auto-global). Unlike the prospect-ops cluster (a narrow gap between two
  // existing IIFEs), this file had NO existing scope to join, so the whole
  // body is now one new IIFE. renderConnectCard/loadConnectStatus are the
  // only 2 names anything outside this file ever reaches (the vm-sandboxed
  // tests/stripe-connect-ui.test.js harness) — registered. The other 11
  // (_nbdConnectVisible, _nbdConnectEsc, _nbdConnectPrettyReq,
  // _nbdConnectCallable, _nbdConnectBtn, _nbdConnectReqList,
  // _nbdConnectCapabilityNote, _nbdConnectAwaitClaims, _nbdConnectGoToOnboarding,
  // _nbdConnectAction, _nbdInstallConnectHook) have zero external consumers —
  // no registry entry, stay fully private to the new IIFE. The file's own
  // header documents it is RE-EXECUTED on every Settings-tab hydration; an
  // IIFE wrap is safe for that (each call gets a fresh local scope) and the
  // load-bearing window.* guard flags (_NBD_CONNECT_DELEGATE,
  // _NBD_CONNECT_TAB_HOOK, _NBD_CONNECT_HOOK_RETRY) and cross-file data
  // (_nbdConnectPendingRefresh, set by dashboard-bootstrap.module.js) are
  // untouched explicit window.* reads/writes, unaffected by the wrap.
  const connectTab = read(path.join(PRO_JS, 'dashboard-connect-tab.js'));
  assert('dashboard-connect-tab.js is wrapped in a single top-level IIFE spanning the whole file',
    /^\(function \(\) \{\r?\n\s*\/\/ ── Stripe Connect/.test(connectTab) &&
    /\}\)\(\);\s*$/.test(connectTab));
  assert('renderConnectCard and loadConnectStatus are registered in __NBD_CALL_REGISTRY',
    /renderConnectCard: renderConnectCard,/.test(connectTab) &&
    /loadConnectStatus: loadConnectStatus/.test(connectTab));
  assert('dashboard-connect-tab.js no longer explicitly exports window.renderConnectCard or window.loadConnectStatus',
    !/window\.renderConnectCard\s*=/.test(connectTab) && !/window\.loadConnectStatus\s*=/.test(connectTab));
  for (const n of ['_nbdConnectVisible', '_nbdConnectEsc', '_nbdConnectPrettyReq', '_nbdConnectCallable',
    '_nbdConnectBtn', '_nbdConnectReqList', '_nbdConnectCapabilityNote', '_nbdConnectAwaitClaims',
    '_nbdConnectGoToOnboarding', '_nbdConnectAction', '_nbdInstallConnectHook']) {
    assert(n + ' stays private — no registry entry, no window export (T3-A, zero external consumer)',
      !new RegExp(n + ':\\s*' + n).test(connectTab) && !new RegExp('window\\.' + n + '\\s*=').test(connectTab));
  }
  // The load-bearing re-execution/guard-flag/App-Check/CSP behavior itself is
  // covered in depth by tests/stripe-connect-ui.test.js's own Parts 3-4 — not
  // duplicated here.

  // ── Tranche 3 T3-A (2026-09-18): customer-tasks-ui.js — the session's
  // SECOND whole-file IIFE wrap (2521 lines, 93 total top-level names, only
  // 1 tiny pre-existing IIFE at the very end for the unrelated jump-nav
  // scroll-spy). Unlike dashboard-connect-tab.js, this file's markup
  // dispatch (_nbdCustomerActionDispatch, CSP-safe data-action/data-change
  // -action resolution) reads straight off `window`, not
  // __NBD_CALL_REGISTRY — so the ~30 markup-dispatched names and the 5
  // already-documented T3-A names (renderCoverHero, loadPhotosByPhase,
  // loadNewPortalSections, setupContactTab, all read by
  // customer-bootstrap.module.js; _uploadPhase, a DATA value not a
  // function) all KEEP their existing explicit window.X = lines completely
  // untouched — the wrap only removes the ~60 names that had ZERO
  // external consumer of any kind (no markup, no cross-file JS, no test
  // that executes rather than regex-matches).
  //
  // One real landmine the pre-edit census caught: getCustomerDocData (a
  // bare function, no window.X= line before this PR) is read externally
  // by doc-preflight.js:2137 as its customer.html data-bridge fallback —
  // that only worked before because a top-level classic-script function
  // auto-globals regardless of assignment syntax. A naive wrap would have
  // silently broken it (doc-preflight.js has no error path, it just falls
  // back to {} and document generation loses all its data). Fixed with a
  // new explicit `window.getCustomerDocData = getCustomerDocData;` line.
  // checkPrerequisites, right next to it and the same bare-declaration
  // shape, does NOT have this problem — doc-preflight.js only mentions it
  // in a header comment, never calls it; confirmed independently by
  // grepping doc-preflight.js for both an actual call and any window[...]
  // bracket-dispatch form. It stays private, no export added.
  const custTasks = read(path.join(PRO_JS, 'customer-tasks-ui.js'));
  assert('customer-tasks-ui.js is wrapped in a new top-level IIFE spanning the whole classic-script body',
    /^\(function \(\) \{\r?\n\/\/ ═+\r?\n\/\/ CUSTOMER PAGE ENHANCEMENTS/.test(custTasks) &&
    /console\.log\('✓ Customer page enhancements loaded'\);\r?\n\}\)\(\);/.test(custTasks));
  assert('the pre-existing jump-nav scroll-spy IIFE sits AFTER the new wrap closes, not nested inside it',
    /\}\)\(\);\r?\n\r?\n\r?\n\/\/ ── nbd jump-nav scroll-spy/.test(custTasks));
  assert('getCustomerDocData now has an explicit window export (doc-preflight.js\'s customer.html data-bridge fallback)',
    /function getCustomerDocData\(\)/.test(custTasks) &&
    /window\.getCustomerDocData = getCustomerDocData;/.test(custTasks));
  assert('checkPrerequisites stays private — doc-preflight.js never actually calls it, only mentions it in a comment',
    /function checkPrerequisites\(type, data\)/.test(custTasks) &&
    !/window\.checkPrerequisites\s*=/.test(custTasks));
  for (const n of ['buildPhotoBadges', 'buildPhotoTile', 'updatePhotoTile', 'isPhotoSelectMode',
    'ensurePhotoGridDelegate', 'renderPhotoGrid', 'photoDocToView', 'applyPhotosToView',
    'updatePhotoStats', '_pulseTarget', '_blankifyDocData', '_orderedDocTemplates',
    '_renderDocCreateGrid', '_nbdCustomerActionDispatch', 'nbdEscFn', '_dmgNorm', '_dmgLabel',
    '_dmgOptions']) {
    assert(n + ' stays private inside the new IIFE — zero external consumer (T3-A)',
      !new RegExp('window\\.' + n + '\\s*=').test(custTasks));
  }
  // Spot-check: _uploadPhase (DATA) AND a sample of the markup-dispatched
  // names keep their EXACT pre-existing window exports — the wrap must not
  // have touched these lines at all. (renderCoverHero, loadPhotosByPhase,
  // loadNewPortalSections, setupContactTab graduated to registry-only in the
  // later T3-5 T3-C slice — pinned in the T3-C block and T1_NAMES instead.)
  for (const n of ['_uploadPhase', 'openTaskModal', 'saveTask', 'saveEvent',
    'generateCustomerDoc', 'toggleTask', 'nbdNavCount']) {
    assert(n + ' keeps its existing window export — a real external consumer needs it, the wrap must not touch this line',
      new RegExp('window\\.' + n + '\\s*=').test(custTasks));
  }

  // customer-realtime.module.js refactor: pure export now, no top-level
  // side effect — importing mountMessages from the dashboard bridge must
  // NOT re-trigger customer.html's auto-mount.
  assert('customer-realtime.module.js exports mountMessages() and has NO top-level whenReady auto-run left',
    /export function mountMessages\(/.test(realtime) && !/whenReady\(10000\)\.then/.test(realtime));
  assert('customer-realtime.module.js\'s cleanup() unsubscribes AND removes the compose listeners (no double-bind on re-mount)',
    /unsubscribeMessages && unsubscribeMessages\(\)/.test(realtime) &&
    /textEl\.removeEventListener\('input', onInput\)/.test(realtime) &&
    /sendBtn\.removeEventListener\('click', onSend\)/.test(realtime));
  assert('customer-realtime.module.js checks BOTH badge ids (desktop msgUnreadBadge, mobile mJdMsgBadge)',
    /\['msgUnreadBadge', 'mJdMsgBadge'\]/.test(realtime));
  assert('customer.html\'s own auto-mount moved to customer-realtime-bootstrap.module.js, unchanged behavior',
    /import \{ mountMessages \} from '\.\/customer-realtime\.module\.js';/.test(realtimeBootstrap) &&
    /whenReady\(10000\)\.then/.test(realtimeBootstrap));
  assert('customer.html now loads the bootstrap file, not customer-realtime.module.js directly',
    /customer-realtime-bootstrap\.module\.js/.test(read(path.join(ROOT, 'docs/pro/customer.html'))) &&
    !/src="js\/customer-realtime\.module\.js/.test(read(path.join(ROOT, 'docs/pro/customer.html'))));

  // ── Documents tab actions: generate / delete / share / homeowner-toggle ─
  const docsFn = actions.slice(actions.indexOf('function _mountDocumentsHub'), actions.indexOf('async function _mJdDeleteDoc'));
  assert('the Documents tab renders a "Generate a document" entry point',
    /Generate a document/.test(docsFn) && /_mJdOpenDocCreate/.test(docsFn));
  assert('share/homeowner-toggle buttons dispatch through customer-documents.js\'s OWN [data-doc-share]/[data-doc-homeowner-share] delegates, not a second handler',
    /data-doc-share="/.test(docsFn) && /data-doc-homeowner-share="/.test(docsFn) &&
    /if \(d\.shareable\)/.test(docsFn) && /if \(!d\.generated && !d\.legacy\)/.test(docsFn));
  assert('delete button always renders and dispatches through the registry (data-action="call")',
    /data-action="call" data-fn="_mJdDeleteDoc"/.test(docsFn));

  const deleteFn = actions.slice(actions.indexOf('async function _mJdDeleteDoc'), actions.indexOf('// Mobile "Generate a document" entry point'));
  assert('_mJdDeleteDoc calls the REAL window.deleteCustomerDoc (soft-delete + confirm), not a reimplementation',
    /window\.deleteCustomerDoc\(docId, label\)/.test(deleteFn));
  assert('_mJdDeleteDoc re-fetches the mobile panel after a successful delete (deleteCustomerDoc only repaints customer.html\'s own lists)',
    /delete host\.dataset\.loadedFor/.test(deleteFn) && /_mountDocumentsHub\(\);/.test(deleteFn));

  const genFn = actions.slice(actions.indexOf('function _mJdOpenDocCreate'), actions.indexOf('function _mJdPickDocType'));
  assert('_mJdOpenDocCreate builds its type list from window._DASH_DOC_PREREQUISITES — one catalog, not a second hand-written one',
    /window\._DASH_DOC_PREREQUISITES/.test(genFn) && /Object\.keys\(prereqs\)/.test(genFn));
  // Globals Tranche 3 T3-C (2026-09-18): _generateDocWithPreflight moved off
  // window into dashboard-bootstrap.module.js's __NBD_CALL_REGISTRY block;
  // both mobile-picker reads resolve it there (fail-closed: registry or entry
  // missing → the picker toasts/returns, never a bare window read).
  // _DASH_DOC_PREREQUISITES is DATA, not a callable — it stays on window.
  const pickFn = actions.slice(actions.indexOf('function _mJdPickDocType'), actions.indexOf('// ── Messages + Voice Intel: mount-once-per-lead'));
  assert('_mJdPickDocType runs the SAME staging+prereq+DocPreflight chain the desktop lead-card doc chips use (_generateDocWithPreflight via the registry), not a second implementation',
    /_nbdReg\._generateDocWithPreflight\(type, leadId\)/.test(pickFn));
  assert('_mJdOpenDocCreate and _mJdPickDocType both gate on the registry entry (fail-closed), never window._generateDocWithPreflight',
    /!_nbdReg \|\| typeof _nbdReg\._generateDocWithPreflight !== 'function'/.test(genFn)
    && /!_nbdReg \|\| typeof _nbdReg\._generateDocWithPreflight !== 'function'\) return;/.test(pickFn)
    && !/window\._generateDocWithPreflight\b/.test(actions));
  const bootRegBlockDocs = (bootstrap.match(/Object\.assign\(window\.__NBD_CALL_REGISTRY,\s*\{([\s\S]*?)\}\);/) || ['', ''])[1];
  assert('dashboard-bootstrap.module.js registers _generateDocWithPreflight in __NBD_CALL_REGISTRY (T3-C) and keeps _DASH_DOC_PREREQUISITES on window for the mobile picker',
    /\b_generateDocWithPreflight:\s*_generateDocWithPreflight\b/.test(bootRegBlockDocs) &&
    !/window\._generateDocWithPreflight\s*=/.test(bootstrap) &&
    !/window\[\s*['"]_generateDocWithPreflight['"]\s*\]/.test(bootstrap) &&
    /window\._DASH_DOC_PREREQUISITES = _DASH_DOC_PREREQUISITES;/.test(bootstrap));

  // Every new data-fn button dispatches through __NBD_CALL_REGISTRY, the
  // SAME convention _mJdSwitchTab uses — NOT a bare window[fnName] export,
  // which _nbdResolveCall only honors for names on _NBD_CALL_ALLOWLIST.
  assert('every new mobile doc-action handler registers in __NBD_CALL_REGISTRY (dispatchable via data-action="call")',
    /_mJdDeleteDoc: _mJdDeleteDoc,/.test(actions) &&
    /_mJdOpenDocCreate: _mJdOpenDocCreate,/.test(actions) &&
    /_mJdCloseDocTypeSheet: _mJdCloseDocTypeSheet,/.test(actions) &&
    /_mJdPickDocType: _mJdPickDocType,/.test(actions));

  // Tab-bar CSS: the 7th tab is what actually broke flex:1 — screenshot-
  // verified at a real 375px viewport (Voice Intel wrapped, Messages badge
  // crowded onto its own line) before the overflow-x:auto fix.
  const css = read(path.join(ROOT, 'docs/pro/css/dashboard-app.css'));
  assert('.m-jd-doc-actions / .m-jd-doc-action styling exists for the new secondary-action row',
    /\.m-jd-doc-actions\{/.test(css) && /\.m-jd-doc-action\{/.test(css));
}

section('Mobile job-detail: homeowner portal activity + communication log (2026-09-17)');
{
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  const html = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const css = read(path.join(ROOT, 'docs/pro/css/dashboard-app.css'));

  // The Activity tab's estimates/stage-history list (openMobileJobDetail,
  // shipped #1081) is real and was NOT a stub — an earlier research pass
  // this session wrongly flagged the whole tab as empty. What genuinely
  // never existed: the homeowner-PORTAL audit log customer.html's own
  // Timeline tab shows under "Customer Activity" (customerAuditEvents).
  assert('dashboard.html: the Activity tab carries a homeowner-portal-activity container',
    /id="mJdCustomerActivityFeed"/.test(html));
  assert("_mJdSwitchTab mounts the portal-activity feed on switching to 'activity'",
    /if \(tab === 'activity'\) _mountCustomerActivityFeed\(\);/.test(actions));

  const feedFn = actions.slice(actions.indexOf('function _mountCustomerActivityFeed'), actions.indexOf('// Communication Log for the Details tab'));
  assert('_mountCustomerActivityFeed is defined and reads the CURRENT overlay lead',
    feedFn.length > 0 && /window\._cardDetailLeadId/.test(feedFn));
  assert('_mountCustomerActivityFeed queries the SAME customerAuditEvents collection/shape loadCustomerActivity uses (leadId + ownerUid, orderBy createdAt desc, limit 50)',
    /collection\(window\.db, 'customerAuditEvents'\)/.test(feedFn) &&
    /where\('leadId', '==', leadId\)/.test(feedFn) &&
    /where\('ownerUid', '=='/.test(feedFn) &&
    /orderBy\('createdAt', 'desc'\)/.test(feedFn) &&
    /limit\(50\)/.test(feedFn));
  assert('_mountCustomerActivityFeed discards a stale response if the overlay lead changed mid-fetch',
    /window\._cardDetailLeadId !== leadId\) return;/.test(feedFn));
  assert('_mountCustomerActivityFeed caches per-lead via the host dataset (same convention as _mountDocumentsHub)',
    /host\.dataset\.loadedFor === leadId\) return;/.test(feedFn) && /host\.dataset\.loadedFor = leadId;/.test(feedFn));

  // Details tab: Communication Log (email_log/sms_log send history) —
  // distinct from the Messages tab's live two-way homeowner chat.
  assert('dashboard.html: the Details tab carries a Communication Log container',
    /id="mJdCommsLog"/.test(html));
  assert("_mJdSwitchTab mounts the comms log on switching to 'details'",
    /if \(tab === 'details'\) \{ _mountCommsLog\(\); _mountNotesTab\(\); \}/.test(actions));

  const commsFn = actions.slice(actions.indexOf('function _mountCommsLog'), actions.lastIndexOf('// Bring the tab row to the top'));
  assert('_mountCommsLog is defined', commsFn.length > 0);
  assert('_mountCommsLog scopes by team thread (role/companyId) vs individual uid, same as loadCommunicationLog',
    /const teamThread = !!\(companyId && \(role === 'company_admin'/.test(commsFn));
  assert('_mountCommsLog reads both email_log and sms_log, same collections as the desktop Contact tab',
    /collection\(window\.db, 'email_log'\)/.test(commsFn) && /collection\(window\.db, 'sms_log'\)/.test(commsFn));
  assert('_mountCommsLog caches per-lead via the host dataset',
    /host\.dataset\.loadedFor === leadId\) return;/.test(commsFn) && /host\.dataset\.loadedFor = leadId;/.test(commsFn));

  // Both new panels must be re-fetched on every overlay open (a stale
  // dataset flag from the PREVIOUS lead must never survive to the next
  // one) — same contract Documents already established.
  const openMobileFn2 = widgets.slice(widgets.indexOf('function openMobileJobDetail'),
                                       widgets.indexOf('window.openMobileJobDetail'));
  assert('openMobileJobDetail clears the portal-activity feed\'s cache flag on every open',
    /mJdCustomerActivityFeed[\s\S]{0,200}delete actFeedBody\.dataset\.loadedFor/.test(openMobileFn2));
  assert('openMobileJobDetail clears the comms log\'s cache flag on every open',
    /mJdCommsLog[\s\S]{0,200}delete commsBody\.dataset\.loadedFor/.test(openMobileFn2));

  assert('.m-jd-act-section-title styling exists for the new sub-section headers',
    /\.m-jd-act-section-title\{/.test(css));
}

section('Job Templates link from customer.html (2026-09-17, Jo: "job templates are way faster than an estimate")');
{
  const customer = readCustomer();
  const bootstrap = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));

  // customer.html had NO path to Job Templates at all before this — the
  // Estimates panel offered Log Estimate / Build Estimate only.
  assert('the Estimates panel has a "Job Templates" button next to Log Estimate / Build Estimate',
    /data-action="_openInDashboardJobTemplates"/.test(customer) && /Job Templates/.test(customer));
  assert('_openInDashboardJobTemplates navigates to the dashboard with the lead pre-selected AND a templates flag',
    /function _openInDashboardJobTemplates\(\)[\s\S]{0,160}\/pro\/dashboard\?lead=' \+ window\._customerId \+ '&templates=1'/.test(customer));
  assert('_openInDashboardJobTemplates is exported to window (customer.html\'s data-action delegate resolves plain window.X, not a registry)',
    /window\._openInDashboardJobTemplates\s*=\s*_openInDashboardJobTemplates;/.test(customer));

  // The deep-link handler must check templates+lead BEFORE the general
  // est||lead branch, or a plain ?lead=&templates=1 would fall into the
  // "new estimate" branch instead and never reach the templates picker.
  const templatesBranchIdx = bootstrap.indexOf("if (templatesParam && leadParam)");
  const estOrLeadBranchIdx = bootstrap.indexOf("} else if (estParam || leadParam)");
  assert('dashboard-bootstrap.module.js reads a templates= query param',
    /const templatesParam = urlParams\.get\('templates'\);/.test(bootstrap));
  assert('the templates+lead branch exists and is checked before the general est||lead branch',
    templatesBranchIdx > -1 && estOrLeadBranchIdx > -1 && templatesBranchIdx < estOrLeadBranchIdx);
  const templatesFn = bootstrap.slice(templatesBranchIdx, estOrLeadBranchIdx);
  assert('the templates deep link calls openJobTemplatesForLead — the SAME entry point the dashboard\'s own "Template Quote" button uses, not a second picker',
    /window\.openJobTemplatesForLead\(leadParam\)/.test(templatesFn));
  assert('the templates deep link cleans the URL after opening (same convention every other deep link here uses)',
    // …keeping the view hash (2026-09-28): dropping it let the queued
    // hashchange route to Home behind the Templates modal.
    /window\.history\.replaceState\(\{\}, '', '\/pro\/dashboard\.html' \+ window\.location\.hash\)/.test(templatesFn));
}

section('Mobile Details-tab parity round 2: Warranty Claim, Insurance Details, Job Checklist, Notes (2026-09-17)');
{
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  const html = read(path.join(ROOT, 'docs/pro/dashboard.html'));

  const openMobileFn3 = widgets.slice(widgets.indexOf('function openMobileJobDetail'),
                                       widgets.indexOf('window.openMobileJobDetail'));

  // ── Staging: window._customerId must be set BEFORE a rep can interact
  // with the checklist, not only lazily on the Documents tab's first visit.
  assert('openMobileJobDetail stages window._customerId (etc.) unconditionally on every open, not just lazily via Documents',
    /window\._cardDetailLeadId = leadId;[\s\S]{0,700}window\._stageWindowStateForLead\(leadId\)/.test(openMobileFn3));
  assert('openMobileJobDetail sets window._currentLead (customer-checklist.js\'s toggleJobChecklistItem reads it directly, not as a passed arg)',
    /window\._currentLead = lead;/.test(openMobileFn3));

  // ── Warranty Claim ──
  assert('dashboard.html: the Details tab carries a Warranty Claim panel container',
    /id="mJdWarrantyClaimPanel"/.test(html));
  assert('openMobileJobDetail calls window.WarrantyClaim.renderPanel UNMODIFIED, pointed at the mobile container',
    /window\.WarrantyClaim && typeof window\.WarrantyClaim\.renderPanel === 'function'\)[\s\S]{0,80}window\.WarrantyClaim\.renderPanel\('mJdWarrantyClaimPanel', lead\)/.test(openMobileFn3));

  // ── Insurance Details ──
  assert('dashboard.html: the Details tab carries an Insurance Details panel container',
    /id="mJdInsurancePanel"/.test(html));
  // Any ?v= — the point is that it loads; the cache-bust number moves with the
  // file (v=4 since 2026-09-29, the adjuster-meeting fields).
  assert('dashboard.html now loads claim-core.js (not loaded there before this round)',
    /<script defer src="js\/claim-core\.js\?v=\d+"><\/script>/.test(html));
  assert('openMobileJobDetail gates the insurance panel the SAME way customer-bootstrap.module.js gates #insurancePanel',
    /const isInsurance = lead\.jobType === 'insurance' \|\| lead\.insCarrier \|\| lead\.insuranceCarrier/.test(openMobileFn3));
  assert('openMobileJobDetail calls window.ClaimPanel.render UNMODIFIED, pointed at the mobile container',
    /window\.ClaimPanel\.render\('mJdInsurancePanel', lead\)/.test(openMobileFn3));

  // ── Job Checklist ──
  assert('dashboard.html: the Details tab reuses the SAME #checklistPanel id customer.html uses (render() hardcodes it, not container-agnostic)',
    /id="checklistPanel"/.test(html));
  assert('dashboard.html now loads customer-checklist.js (not loaded there before this round)',
    /<script defer src="js\/customer-checklist\.js\?v=2"><\/script>/.test(html));
  assert('openMobileJobDetail calls window.JobChecklist.render UNMODIFIED',
    /window\.JobChecklist && typeof window\.JobChecklist\.render === 'function'\)[\s\S]{0,60}window\.JobChecklist\.render\(lead\)/.test(openMobileFn3));
  assert('a document-level change delegate dispatches checklist checkbox taps to the REAL window.toggleJobChecklistItem (customer-tasks-ui.js\'s own delegate isn\'t loaded on this page)',
    /data-change-action="toggleJobChecklistItem"/.test(actions) &&
    /window\.toggleJobChecklistItem\(key, el\)/.test(actions));

  // ── Notes ──
  assert('dashboard.html: the Details tab carries the Notes quick-add + list markup',
    /id="mJdNotesInput"/.test(html) && /id="mJdNotesSend"/.test(html) &&
    /id="mJdNotesStatus"/.test(html) && /id="mJdNotesList"/.test(html));
  assert('the Send button dispatches through the registry to _mJdQuickAddNote',
    /data-action="call" data-fn="_mJdQuickAddNote"/.test(html));

  const notesFn = actions.slice(actions.indexOf('function _mountNotesTab'), actions.indexOf('async function _mJdQuickAddNote'));
  assert('_mountNotesTab is defined and reads the CURRENT overlay lead',
    notesFn.length > 0 && /window\._cardDetailLeadId/.test(notesFn));
  assert('_mountNotesTab queries the SAME `notes` collection/shape loadNotes uses (leadId only, no author filter)',
    /collection\(window\.db, 'notes'\)/.test(notesFn) && /where\('leadId', '==', leadId\)/.test(notesFn) &&
    !/where\('userId'/.test(notesFn));
  assert('_mountNotesTab discards a stale response if the overlay lead changed mid-fetch',
    /window\._cardDetailLeadId !== leadId\) return;/.test(notesFn));
  assert('_mountNotesTab caches per-lead via the host dataset (same convention as _mountDocumentsHub)',
    /host\.dataset\.loadedFor === leadId\) return;/.test(notesFn) && /host\.dataset\.loadedFor = leadId;/.test(notesFn));

  const quickAddFn = actions.slice(actions.indexOf('async function _mJdQuickAddNote'), actions.indexOf('document.addEventListener(\'keydown\''));
  assert('_mJdQuickAddNote is defined', quickAddFn.length > 0);
  assert('_mJdQuickAddNote writes the SAME field shape quickAddNote uses (leadId/userId/text/createdAt/createdBy)',
    /collection\(window\.db, 'notes'\)/.test(quickAddFn) &&
    /leadId: leadId/.test(quickAddFn) && /userId: window\.auth\.currentUser\.uid/.test(quickAddFn) &&
    /createdAt: window\.serverTimestamp\(\)/.test(quickAddFn) && /createdBy: window\.auth\.currentUser\.email/.test(quickAddFn));
  assert('_mJdQuickAddNote re-fetches the mobile notes list after a successful save',
    /delete host\.dataset\.loadedFor;[\s\S]{0,20}_mountNotesTab\(\);/.test(quickAddFn));
  assert('_mJdQuickAddNote is registered in __NBD_CALL_REGISTRY (bare window.X exports never dispatch)',
    /_mJdQuickAddNote: _mJdQuickAddNote,/.test(actions));
  assert('Cmd/Ctrl+Enter on the mobile notes textarea submits, same UX as desktop\'s quickNoteInput',
    /ev\.target\.id === 'mJdNotesInput' && ev\.key === 'Enter' && \(ev\.metaKey \|\| ev\.ctrlKey\)/.test(actions));

  // ── Cache reset on open — all three lazily-fetched panels above must be
  // re-fetched on every overlay open, same contract Documents established.
  assert('openMobileJobDetail clears the notes list\'s cache flag on every open',
    /mJdNotesList[\s\S]{0,200}delete notesBody\.dataset\.loadedFor/.test(openMobileFn3));
}


// ── Sidebar collapse must actually resize the maps (2026-09-22) ──
// window.mainMap / window.d2dMap are never set: mainMap/drawMap are
// classic-script top-level lets and the D2D map lives in the tracker's
// private state. Both sidebar-collapse handlers read them off window, so the
// Leaflet invalidateSize they intended never ran (gray strip after collapse).
section('Sidebar collapse resizes the maps');
{
  const collapseFiles = [
    ['dashboard-ui.js', read(path.join(PRO_JS, 'dashboard-ui.js'))],
    ['dashboard-ui-prefs-boot.js', read(path.join(PRO_JS, 'dashboard-ui-prefs-boot.js'))],
  ];
  const deadRead = /window\.(mainMap|d2dMap)\s*(\?\.|&&|\.invalidateSize)/;
  for (const [name, src] of collapseFiles) {
    assert(name + ' never reads the unset window.mainMap / window.d2dMap handles', !deadRead.test(src));
    const i = src.indexOf("classList.toggle('active', collapsed)");
    const win = i >= 0 ? src.slice(i, i + 1600) : '';
    assert(name + ' collapse handler invalidates mainMap by its bare typeof-guarded name',
      /typeof mainMap !== 'undefined' && mainMap[\s\S]{0,40}invalidateSize\(\)/.test(win));
    assert(name + ' collapse handler fires a window resize so the D2D map (private state) resizes too',
      /window\.dispatchEvent\(new Event\('resize'\)\)/.test(win));
  }
}

};
