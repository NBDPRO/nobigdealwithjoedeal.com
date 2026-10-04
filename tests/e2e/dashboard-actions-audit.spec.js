// @ts-check
// Full data-action wiring audit of the dashboard.
//
// NOTE (corrected 2026-09-01): this header used to say "opt-in; not part of the
// pinned CI e2e job". That is FALSE and has been for a while — '@audit' is one
// of the six REQUIRED shards in the Authed E2E matrix (.github/workflows/ci.yml,
// the `shard:` list). Treat every change here as CI-blocking, and note that the
// spec's own tap sequence is load-bearing: a helper that silently no-ops can
// leave a backdrop swallowing later taps while the suite still reports green.
//
// Logs in, hydrates every view, then cross-references
// every [data-action] element in the DOM against the live delegate state
// (dashboard-ui.js switch + dashboard-state.js allowlists + window globals) —
// the class of regression where a CSP sweep or globals tranche drops an
// allowlist entry / window fn and a button silently no-ops (see the
// QA 2026-06-07 C-1/H-4 notes in dashboard-state.js). Also taps the mobile
// bottom nav + dash widgets like a phone user and verifies the active view
// changes. FAILS when any element resolves to a dead handler.
//
// Run against the emulator suite:
//   cd tests && npx firebase emulators:exec --only auth,firestore,storage,hosting \
//     --project nobigdeal-pro "node ./e2e/fixtures/seed-emulator.js && \
//     PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//     PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//     npx playwright test dashboard-actions-audit.spec.js"
// Sandboxes where www.gstatic.com is blocked: bundle firebase@10.12.2 per
// entrypoint with esbuild (share @firebase/app) and set FIREBASE_SDK_DIR to
// the output dir; requests are then served from disk.
// Output: JSON report at tests/e2e/.audit-report.json + stdout summary.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs } = require('./fixtures/auth');

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});

// The SDK is self-hosted under /assets/vendor/firebase/<ver>/ since 2026-10-04
// (scripts/vendor-firebase-sdk.js), so no gstatic egress is needed any more;
// this override (FIREBASE_SDK_DIR) remains for swapping in local builds (set FIREBASE_SDK_DIR to the esbuild output).
// Shared by both tests in this file.
async function installSandboxRoutes(page) {
  const sdkDir = process.env.FIREBASE_SDK_DIR;
  if (!sdkDir) return;
  await page.route(/\/assets\/vendor\/firebase\/[\d.]+\/(firebase-[a-z-]+\.js)/, (route, req) => {
    const m = req.url().match(/(firebase-[a-z-]+\.js)$/);
    const f = m && path.join(sdkDir, m[1]);
    if (f && fs.existsSync(f)) {
      route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f, 'utf8') });
    } else {
      route.abort();
    }
  });
  // fail fast on other blocked third-party hosts instead of proxy 403 stalls
  await page.route(/https:\/\/(browser\.sentry-cdn\.com|www\.google\.com|www\.googletagmanager\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com)\/.*/, (r) => r.abort());
}

test('dashboard-actions-audit @audit', async ({ page }) => {
  test.setTimeout(300_000);
  let creds;
  try { creds = requireTestUser(); } catch (e) { test.skip(true, String(e.message)); return; }

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500)); });
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 500)));

  // First-run UI (onboarding tour, push opt-in card) are legitimate visible
  // overlays but would sit over the tap targets below and turn every tap
  // result into noise — pre-dismiss them like a returning user.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
    } catch (e) {}
  });

  await installSandboxRoutes(page);

  const consoleAll = [];
  page.on('console', (msg) => consoleAll.push(msg.type() + ': ' + msg.text().slice(0, 300)));
  try {
    await loginAs(page, creds);
  } catch (e) {
    console.log('LOGIN_FAILED: ' + String(e).slice(0, 200));
    console.log('CONSOLE_DUMP:\n' + consoleAll.slice(-40).join('\n'));
    throw e;
  }
  await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 20_000 });
  await page.waitForTimeout(3000);

  // Stub lead data so the KPI row renders every card (incl. overdue) without
  // depending on Firestore contents, then render.
  await page.evaluate(() => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    window._leads = [
      { id: 'a1', stage: 'new', jobValue: '12000', createdAt: new Date().toISOString(), followUp: yesterday, source: 'Door Knock' },
      { id: 'a2', stage: 'contacted', jobValue: '34000', createdAt: new Date().toISOString(), followUp: yesterday, source: 'Door Knock' },
      { id: 'a3', stage: 'closed', jobValue: '14000', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'Referral' },
      { id: 'a4', stage: 'lost', jobValue: '9000', createdAt: new Date().toISOString(), source: 'Web' },
    ];
    if (typeof window.renderKPIRow === 'function') window.renderKPIRow();
  });

  // ── Hydrate every view so template-stamped [data-action] markup exists ──
  const viewIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.view[id^="view-"]')).map((v) => v.id.replace(/^view-/, ''))
  );
  const hydrateErrors = {};
  for (const id of viewIds) {
    const before = consoleErrors.length + pageErrors.length;
    try {
      await page.evaluate((v) => { window.goTo(v); }, id);
      await page.waitForTimeout(700);
    } catch (e) {
      hydrateErrors[id] = String(e).slice(0, 300);
    }
    const after = consoleErrors.length + pageErrors.length;
    if (after > before) hydrateErrors[id] = consoleErrors.concat(pageErrors).slice(before).join(' | ');
  }
  await page.evaluate(() => window.goTo('dash'));
  await page.waitForTimeout(500);
  await page.evaluate(() => { if (typeof window.renderKPIRow === 'function') window.renderKPIRow(); });

  // ── Static audit: resolve every [data-action] the way the delegate would ──
  const audit = await page.evaluate(() => {
    /* eslint-disable no-undef */
    const results = [];
    const seen = new Map(); // dedupe identical signatures
    const has = (name) => {
      try { return typeof window[name] === 'function'; } catch { return false; }
    };
    // script-level consts aren't window props; reach them lexically
    const TOGGLES = typeof _NBD_TOGGLE_FNS !== 'undefined' ? _NBD_TOGGLE_FNS : null;
    const CLOSES = typeof _NBD_MODAL_CLOSE_FNS !== 'undefined' ? _NBD_MODAL_CLOSE_FNS : null;
    const ALLOW = typeof _NBD_CALL_ALLOWLIST !== 'undefined' ? _NBD_CALL_ALLOWLIST : null;
    // Tranche 2c: converted modules register handlers in
    // window.__NBD_CALL_REGISTRY instead of window+allowlist; mirror the
    // dispatcher's registry-FIRST resolution (_nbdResolveCall) or every
    // converted name audits as a false DEAD.
    const REG = window.__NBD_CALL_REGISTRY || null;
    const registered = (name) => !!(REG && typeof REG[name] === 'function');

    // actions implemented by dashboard-ui.js's delegate
    const UI_ACTIONS = new Set(['call','clickProxy','closeModal','closeOpen','crmToolsMenu','docgen','filterByStage','goTo','hideEl','kanbanView','mapOverlay','mapSidebar','mobileNav','modalBackdropClose','module','navSection','newEstimate','peBulkAnalyze','peDeletePhoto','peOpenLightbox','peRemove','peStagePhoto','peTagToggle','reload','removeClosest','removeParent','removeSelf','selLineType','selectPin','settingsTab','signOut','stopProp','toggle','toolMenuGoTo','tradeChip','windowOpen','zoneColor']);
    // actions known to be handled by other view-scoped delegates (audited separately)
    const OTHER_DELEGATE_FILES = { };

    document.querySelectorAll('[data-action]').forEach((el) => {
      const action = el.dataset.action;
      const target = el.dataset.target || '';
      const fn = el.dataset.fn || '';
      const view = el.closest('.view') ? el.closest('.view').id : (el.closest('#mobile-nav') ? '#mobile-nav' : (el.closest('#sidebar,.sidebar,nav') ? 'nav/other' : 'global'));
      const sig = [action, target, fn, view].join('|');
      if (seen.has(sig)) { seen.get(sig).count++; return; }

      let status = 'ok';
      let why = '';
      const label = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);

      const fnCheck = (name) => { if (!has(name)) { status = 'DEAD'; why = 'window.' + name + ' is not a function'; } };

      if (!UI_ACTIONS.has(action)) {
        status = 'UNKNOWN_ACTION'; why = 'no branch in dashboard-ui.js delegate (may belong to a view-scoped delegate)';
      } else {
        switch (action) {
          case 'goTo': case 'toolMenuGoTo':
            if (!has('goTo')) { status = 'DEAD'; why = 'goTo missing'; }
            else if (!document.getElementById('view-' + target)) { status = 'DEAD'; why = 'no #view-' + target; }
            break;
          case 'mobileNav':
            if (!has('mobileNav')) { status = 'DEAD'; why = 'mobileNav missing'; }
            else if (!document.getElementById('view-' + target)) { status = 'DEAD'; why = 'no #view-' + target; }
            break;
          case 'newEstimate':
            if (!has('goTo')) { status = 'DEAD'; why = 'goTo missing'; }
            else if (!has('startNewEstimate')) { status = 'PARTIAL'; why = 'startNewEstimate missing (goTo still fires)'; }
            break;
          case 'filterByStage': fnCheck('filterByStage'); break;
          case 'navSection': fnCheck('toggleNavSection'); break;
          case 'mapSidebar': fnCheck('toggleMapSidebar'); break;
          case 'mapOverlay': fnCheck('toggleOverlay'); break;
          case 'tradeChip': fnCheck('toggleTradeChip'); break;
          case 'crmToolsMenu': fnCheck('toggleCrmToolsMenu'); break;
          case 'kanbanView': fnCheck('switchKanbanView'); break;
          // Globals Tranche 3 T3-0: the zoneColor branch in dashboard-ui.js
          // resolves through _nbdResolveCall now (selectZoneColor is
          // module-scoped in dashboard-actions.js), so this must mirror the
          // registry-FIRST order or the swatches audit as a false DEAD.
          case 'zoneColor':
            if (!registered('selectZoneColor')) fnCheck('selectZoneColor');
            break;
          case 'selectPin': fnCheck('selectPin'); break;
          case 'selLineType': fnCheck('selLT'); break;
          case 'settingsTab': fnCheck('switchSettingsTab'); break;
          // Globals Tranche 3 (2026-09-01): both maps resolve through
          // _nbdResolveMapped now — __NBD_CALL_REGISTRY first, then window. A
          // handler that has been converted to registry-only is NOT on window
          // and would audit as a false DEAD if we only checked `has()`.
          case 'toggle':
            if (!TOGGLES) { status = 'DEAD'; why = '_NBD_TOGGLE_FNS unreachable'; }
            else if (!TOGGLES[target]) { status = 'DEAD'; why = 'target "' + target + '" not in _NBD_TOGGLE_FNS'; }
            else if (!registered(TOGGLES[target]) && !has(TOGGLES[target])) { status = 'DEAD'; why = TOGGLES[target] + ' is in neither __NBD_CALL_REGISTRY nor window'; }
            break;
          case 'closeModal':
            if (!CLOSES) { status = 'DEAD'; why = '_NBD_MODAL_CLOSE_FNS unreachable'; }
            else if (!CLOSES[target]) { status = 'DEAD'; why = 'target "' + target + '" not in _NBD_MODAL_CLOSE_FNS'; }
            else if (!registered(CLOSES[target]) && !has(CLOSES[target])) { status = 'DEAD'; why = CLOSES[target] + ' is in neither __NBD_CALL_REGISTRY nor window'; }
            break;
          case 'call':
            if (registered(fn)) break; // registry-first, same as _nbdResolveCall
            if (!ALLOW) { status = 'DEAD'; why = '_NBD_CALL_ALLOWLIST unreachable'; }
            else if (!ALLOW.has(fn)) { status = 'DEAD'; why = '"' + fn + '" not registered in __NBD_CALL_REGISTRY nor in _NBD_CALL_ALLOWLIST'; }
            else if (!has(fn)) { status = 'DEAD'; why = 'window.' + fn + ' is not a function'; }
            break;
          case 'module': {
            const dot = target.indexOf('.');
            if (dot === -1) { status = 'DEAD'; why = 'bad module target'; break; }
            const mod = window[target.slice(0, dot)];
            const meth = target.slice(dot + 1);
            if (!mod || typeof mod[meth] !== 'function') {
              status = el.dataset.fallbackToast ? 'PARTIAL' : 'DEAD';
              why = target + ' unresolved' + (el.dataset.fallbackToast ? ' (falls back to toast)' : '');
            }
            break;
          }
          case 'closeOpen': case 'clickProxy': case 'hideEl':
            if (!document.getElementById(target)) { status = 'DEAD'; why = 'no #' + target + ' in DOM'; }
            break;
          case 'signOut': fnCheck('_signOut'); break;
          default: break; // windowOpen, reload, stopProp, remove*, pe* checked loosely
        }
      }
      const entry = { action, target, fn, view, label, status, why, count: 1 };
      seen.set(sig, entry);
      results.push(entry);
    });

    // data-on-change / data-on-input audit
    document.querySelectorAll('[data-on-change],[data-on-input]').forEach((el) => {
      const fnName = el.getAttribute('data-on-change') || el.getAttribute('data-on-input');
      const view = el.closest('.view') ? el.closest('.view').id : 'global';
      const sig = ['on-change', fnName, view].join('|');
      if (seen.has(sig)) { seen.get(sig).count++; return; }
      let status = 'ok'; let why = '';
      if (registered(fnName)) { /* registry-first, same as _nbdResolveCall */ }
      else if (ALLOW && !ALLOW.has(fnName)) { status = 'DEAD'; why = '"' + fnName + '" not registered in __NBD_CALL_REGISTRY nor in _NBD_CALL_ALLOWLIST'; }
      else if (typeof window[fnName] !== 'function') { status = 'DEAD'; why = 'window.' + fnName + ' is not a function'; }
      const entry = { action: 'data-on-change/input', target: '', fn: fnName, view, label: (el.id || el.name || ''), status, why, count: 1 };
      seen.set(sig, entry); results.push(entry);
    });
    return results;
  });

  // ── Dynamic tap test: bottom nav + dash-view widgets like a phone user ──
  const tapResults = [];
  async function activeView() {
    return page.evaluate(() => (document.querySelector('.view.active') || {}).id || 'none');
  }
  async function tapAndCheck(selector, describe) {
    await page.evaluate(() => window.goTo('dash'));
    await page.waitForTimeout(400);
    const before = await activeView();
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) { tapResults.push({ describe, selector, result: 'NOT_FOUND' }); return; }
    let visible = await loc.isVisible();
    if (!visible) { tapResults.push({ describe, selector, result: 'HIDDEN' }); return; }
    const errBefore = pageErrors.length;
    try { await loc.tap({ timeout: 3000 }); }
    catch { try { await loc.click({ timeout: 3000, force: true }); } catch (e2) { tapResults.push({ describe, selector, result: 'UNTAPPABLE', err: String(e2).slice(0, 200) }); return; } }
    await page.waitForTimeout(600);
    const after = await activeView();
    const modalOpen = await page.evaluate(() => {
      const cands = document.querySelectorAll('.modal.open,[role="dialog"]:not([hidden]),.m-create-popover:not([hidden]),#mobile-more-menu.open,#navCustomizeModal.open');
      return Array.from(cands).map((m) => m.id || m.className.split(' ')[0]).join(',');
    });
    tapResults.push({ describe, selector, result: before !== after ? 'VIEW:' + before + '->' + after : (modalOpen ? 'MODAL:' + modalOpen : 'NO_VISIBLE_EFFECT'), newErrors: pageErrors.slice(errBefore) });
    // reset any modal state (incl. the full-screen V2 estimate builder the
    // newEstimate tap legitimately opens — it covers every later tap target)
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
      document.querySelectorAll('#mobile-more-menu.open').forEach((m) => m.classList.remove('open'));
      if (typeof window.closeMobileMore === 'function') window.closeMobileMore();
      // The bottom-nav create FAB opens the m-create bottom sheet; its
      // backdrop sits ABOVE the nav (z 1900+) and would swallow every later
      // forced tap as a backdrop-close if left open.
      // Registry-first: closeMobileCreatePopover moved off window on 2026-09-01
      // (Globals Tranche 3 dispatch-map slice). Left as a bare window read this
      // would silently no-op, the m-create backdrop would stay up, and it sits
      // above the nav at z 1900+ — every later forced tap would land on the
      // backdrop instead of its target and the whole tap sweep would go green
      // while testing nothing.
      const _closeCreate = (window.__NBD_CALL_REGISTRY
        && window.__NBD_CALL_REGISTRY.closeMobileCreatePopover)
        || window.closeMobileCreatePopover;
      if (typeof _closeCreate === 'function') _closeCreate();
      document.getElementById('estV2Modal')?.classList.remove('open');
      document.querySelectorAll('.modal.open').forEach((m) => m.classList.remove('open'));
    }).catch(() => {});
  }

  await tapAndCheck('#view-dash [data-action="newEstimate"]', 'dash: + New Estimate');
  await tapAndCheck('#kpiRow .kpi-primary', 'dash KPI: Active Pipeline card');
  await tapAndCheck('#kpiRow .kpi-green', 'dash KPI: Revenue This Month card');
  await tapAndCheck('#kpiRow .kpi-warning', 'dash KPI: Overdue Follow-Ups card');
  await tapAndCheck('#view-dash [data-action="goTo"][data-target="crm"]', 'dash: Activity New Leads tile → crm');
  await tapAndCheck('#view-dash [data-action="goTo"][data-target="est"]', 'dash: Activity Estimates tile → est');
  await tapAndCheck('#view-dash .stat-card[data-action="goTo"]', 'dash: stat card → crm');
  // bottom nav — whatever tabs are rendered
  const navItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#mobile-nav .mn-item')).map((el) => ({ id: el.id, action: el.dataset.action, target: el.dataset.target || el.dataset.fn }))
  );
  for (const item of navItems) {
    if (item.id) await tapAndCheck('#' + item.id, 'bottom nav: ' + (item.target || item.id));
  }

  const report = {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    viewIds,
    hydrateErrors,
    deadCount: audit.filter((a) => a.status !== 'ok').length,
    totalAudited: audit.length,
    problems: audit.filter((a) => a.status !== 'ok'),
    tapResults,
    consoleErrors: consoleErrors.slice(0, 60),
    pageErrors: pageErrors.slice(0, 60),
  };
  const out = path.join(__dirname, '.audit-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('AUDIT_REPORT_WRITTEN ' + out + ' problems=' + report.problems.length + ' taps=' + tapResults.length);

  // Hard-fail only on DEAD wiring (missing window fn / allowlist entry /
  // view). UNKNOWN_ACTION entries are view-scoped delegates (kanban cards,
  // widget rows) that bind their own listeners — surfaced in the report for
  // eyeballing but not failures. PARTIAL entries degrade with a toast.
  const dead = audit.filter((a) => a.status === 'DEAD');
  expect(dead, 'dead data-action wiring (see tests/e2e/.audit-report.json)').toEqual([]);

  // Regression gate for tap-stealing overlays (push opt-in card, PWA install
  // banners — 2026-07-05): every routed bottom-nav tap must have navigated.
  // mni-dash is exempt (already on dash → correctly a no-op), mni-more opens
  // the More drawer, and mni-create opens the create popover — those two are
  // asserted as MODAL results instead.
  const deadNavTaps = tapResults.filter((t) =>
    /bottom nav/.test(t.describe) && !/mni-dash|mni-more|mni-create/.test(t.selector) &&
    !/^VIEW:/.test(t.result) && t.result !== 'NOT_FOUND' && t.result !== 'HIDDEN');
  expect(deadNavTaps, 'bottom-nav taps that did not navigate (overlay covering the tab bar?)').toEqual([]);

  // The create FAB is a default tab (mobile-nav-customizer DEFAULT_TABS,
  // 2026-07-29) and its tap must open the create popover — a silent no-op
  // here means the registry dispatch (mCreateFabRoute) went dead.
  const createTap = tapResults.find((t) => /mni-create/.test(t.selector));
  expect(createTap, 'bottom nav must include the create FAB (default tab)').toBeTruthy();
  expect(createTap.result, 'create FAB tap must open the create popover').toMatch(/^MODAL:/);
});

// ── First-run onboarding tour: anchors resolve, unresolvable steps skip ──
// First-run audit 2026-07-28: the "Tap the orange + button" tooltip floated
// centered with no spotlight because every selector in the step's anchor
// list was unresolvable (wrong id / CSP-dead [onclick*=] / position:fixed
// rejected by the offsetParent visibility test). Invariant under test:
// whenever the spotlight is hidden, the tooltip must be a genuine centered
// step (welcome / closer) — an anchored step either spotlights a real
// element or is skipped in the direction of travel.
//
// Runs in its OWN browser contexts (fresh storage) so it never races the
// audit test above, which pre-dismisses the tour via nbd-onboarding-complete.
test('onboarding-tour-anchors @audit', async ({ browser }) => {
  test.setTimeout(300_000);
  let creds;
  try { creds = requireTestUser(); } catch (e) { test.skip(true, String(e.message)); return; }

  const CENTER_TITLES = ['Welcome to NBD Pro', "You're set"];

  async function walkTour(contextOpts) {
    const context = await browser.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://nobigdealwithjoedeal.com',
      serviceWorkers: 'block',
      ...(/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(process.env.PLAYWRIGHT_BASE_URL || '')
        ? { bypassCSP: true }
        : {}),
      ...(process.env.PLAYWRIGHT_PROXY_SERVER
        ? { proxy: { server: process.env.PLAYWRIGHT_PROXY_SERVER, bypass: '127.0.0.1,localhost' }, ignoreHTTPSErrors: true }
        : {}),
      ...contextOpts,
    });
    const page = await context.newPage();
    try {
      // Force the tour the way how-to.html's "▶ Restart Tour" does: clear
      // the completion flag + set the one-shot force key. Snooze the push
      // opt-in card so it can't overlap the tooltip.
      await page.addInitScript(() => {
        try {
          localStorage.removeItem('nbd-onboarding-complete');
          localStorage.setItem('nbd-tour-force', '1');
          localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
        } catch (e) {}
      });
      await installSandboxRoutes(page);
      await loginAs(page, creds);
      await page.waitForSelector('#nbd-onb-tooltip', { timeout: 60_000 });

      const seen = [];
      for (let i = 0; i < 12; i++) {
        const state = await page.evaluate(() => {
          const tip = document.getElementById('nbd-onb-tooltip');
          if (!tip) return null; // tour completed
          const spot = document.getElementById('nbd-onb-spotlight');
          const spotVisible = !!spot && getComputedStyle(spot).display !== 'none';
          const rectOf = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
          };
          return {
            title: ((tip.querySelector('.nbd-onb-title') || {}).textContent || '').trim(),
            centered: tip.classList.contains('nbd-onb-tooltip-center'),
            spotVisible,
            spotRect: spotVisible ? rectOf(spot) : null,
            hdrMobileRect: rectOf(document.getElementById('hdrMobileBtn')),
            mniCreateRect: rectOf(document.getElementById('mni-create')),
          };
        });
        if (!state) break;
        seen.push(state);
        const next = page.locator('#nbd-onb-tooltip button[data-act="next"]');
        if ((await next.count()) === 0) break;
        await next.click({ force: true });
        await page.waitForTimeout(600);
      }
      return seen;
    } finally {
      await context.close();
    }
  }

  function assertNoFloatingTooltips(seen, label) {
    const violations = seen.filter((s) =>
      !s.spotVisible && !(s.centered && CENTER_TITLES.some((t) => s.title.includes(t))));
    expect(violations, label + ': steps rendered with no spotlight that are not genuine centered steps')
      .toEqual([]);
    expect(seen.length, label + ': tour rendered at least the two centered steps').toBeGreaterThanOrEqual(2);
  }

  // Desktop: sidebar visible → #nav-crm / #nav-d2d anchor; the add-lead
  // step may legitimately skip on the home view (no add control on-screen)
  // — the invariant is simply "never a floating unanchored tooltip".
  const desktopSeen = await walkTour({ viewport: { width: 1280, height: 800 } });
  assertNoFloatingTooltips(desktopSeen, 'desktop');

  // Mobile: sidebar is display:none ≤900px → the two sidebar steps must be
  // SKIPPED (not rendered centered). mobile-nav-customizer.js REBUILDS
  // #mobile-nav at boot, and since 2026-07-29 its DEFAULT_TABS include the
  // create FAB — so the add-lead step must render spotlighting the rebuilt
  // #mni-create (position:fixed nav — the exact element class the old
  // offsetParent visibility test could never return). The settings step
  // additionally proves findAnchor falls through a hidden selector
  // (.hdr-tool[data-target="settings"] is desktop-only ≤768px) to the
  // visible #hdrMobileBtn kebab.
  const mobileSeen = await walkTour({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  assertNoFloatingTooltips(mobileSeen, 'mobile');
  const mobileTitles = mobileSeen.map((s) => s.title).join(' | ');
  expect(mobileTitles, 'mobile: sidebar step #nav-crm must be skipped (sidebar hidden)')
    .not.toContain('Pipeline is home base');
  expect(mobileTitles, 'mobile: sidebar step #nav-d2d must be skipped (sidebar hidden)')
    .not.toContain('Door-to-Door built in');
  const rectsOverlap = (a, b) =>
    !!(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
  const addStep = mobileSeen.find((s) => s.title.includes('Add your first lead'));
  expect(addStep, 'mobile: the add-lead step must render (create FAB is a default tab)').toBeTruthy();
  expect(addStep.spotVisible, 'mobile: add-lead step must have a visible spotlight').toBe(true);
  expect(rectsOverlap(addStep.spotRect, addStep.mniCreateRect),
    'mobile: add-lead spotlight must cover the rebuilt #mni-create').toBe(true);
  const settingsStep = mobileSeen.find((s) => s.title.includes('Make it yours'));
  expect(settingsStep, 'mobile: the settings step must render (anchored to #hdrMobileBtn)').toBeTruthy();
  expect(settingsStep.spotVisible, 'mobile: settings step must have a visible spotlight').toBe(true);
  expect(rectsOverlap(settingsStep.spotRect, settingsStep.hdrMobileRect),
    'mobile: spotlight must cover #hdrMobileBtn').toBe(true);
});
