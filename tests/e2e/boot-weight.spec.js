// @ts-check
// Boot-weight + duplicate-execution guards (2026-09-06).
//
// These assert BEHAVIOUR on the real authed pages, not file lists — a lazy
// file that every boot immediately fetches has saved nothing, and a lazy file
// the page needs but never fetches is a silent, user-facing break that only
// shows up on the one interaction that needs it.
//
// What it locks down:
//   1. customer.html does NOT fetch the docgen cluster at boot, and DOES
//      resolve it on demand (window.NBDDocGen / window.DocPreflight).
//   2. profit-tracker.js / supplement-ui.js stay EAGER on customer.html —
//      both render at load (cost panel, "+ Supplement" buttons), so lazy
//      would blank a live surface with no error.
//   3. ScriptLoader dedupes on the RESOLVED PATH: loading the 'estimates'
//      bundle must not re-fetch or re-execute customer.html's absolute-path
//      supplement-ui.js tag (which registers a document.body MutationObserver
//      at load and has no re-entry guard).
//   4. Cmd+K opens exactly ONE palette on the dashboard.
//   5. The Leaflet stylesheets ride the lazy mapvendor bundle and are
//      actually APPLIED once it loads.
//
// Runs in the emulator harness: npm run test:e2e:authed:emu

const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate } = require('./fixtures/auth');

const DOCGEN = [
  'document-generator.js',
  'document-generator-templates.js',
  'doc-preflight.js',
  'nbd-logo-asset.js',
];

/** Record every request URL the page makes, from before the first navigation. */
function trackRequests(page) {
  const urls = [];
  page.on('request', (r) => urls.push(r.url()));
  return urls;
}
const hits = (urls, name) => urls.filter((u) => u.includes(name)).length;

test.describe('boot weight — customer.html docgen is lazy @engines', () => {
  test('docgen is absent at boot and resolves on demand', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));

    await loginAs(page, creds);
    const urls = trackRequests(page);

    // Any customer page — the id need not resolve to a real lead for the
    // boot-path assertions; the scripts load regardless of the data read.
    await page.goto('/pro/customer.html?id=E2E-BOOT-WEIGHT');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => !!(window.ScriptLoader && window.ScriptLoader.loadBundle), null, { timeout: 20_000 });

    // 1. the cluster must NOT be on the boot path
    for (const f of DOCGEN) {
      expect(hits(urls, f), f + ' must not be fetched at boot').toBe(0);
    }
    expect(await safeEvaluate(page, () => typeof window.NBDDocGen)).toBe('undefined');

    // 2. …and the entry points' load-then-run must actually deliver it
    const got = await safeEvaluate(page, async () => {
      await window.ScriptLoader.loadBundle('docgen');
      return {
        generate: typeof (window.NBDDocGen && window.NBDDocGen.generate),
        preflight: typeof (window.DocPreflight && window.DocPreflight.open),
      };
    });
    expect(got.generate, 'NBDDocGen.generate after loadBundle').toBe('function');
    expect(got.preflight, 'DocPreflight.open after loadBundle').toBe('function');
    for (const f of DOCGEN) {
      expect(hits(urls, f), f + ' fetched on demand').toBeGreaterThan(0);
    }

    expect(errors, 'no uncaught page errors').toEqual([]);
  });

  test('the render-time modules stay eager', async ({ page }) => {
    const creds = requireTestUser(test);
    await loginAs(page, creds);
    const urls = trackRequests(page);
    await page.goto('/pro/customer.html?id=E2E-BOOT-WEIGHT');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => !!window.ScriptLoader, null, { timeout: 20_000 });

    // profit-tracker renders the cost panel during the customer render, and
    // supplement-ui paints the "+ Supplement" button onto every estimate row.
    // Neither has a user-intent trigger to hang a lazy load on.
    expect(hits(urls, 'profit-tracker.js'), 'profit-tracker.js eager').toBeGreaterThan(0);
    expect(hits(urls, 'supplement-ui.js'), 'supplement-ui.js eager').toBeGreaterThan(0);
  });

  test('loading the estimates bundle does not re-execute supplement-ui', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await loginAs(page, creds);
    const urls = trackRequests(page);
    await page.goto('/pro/customer.html?id=E2E-BOOT-WEIGHT');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => !!(window.ScriptLoader && window.ScriptLoader.loadBundle), null, { timeout: 20_000 });

    const before = hits(urls, 'supplement-ui.js');
    expect(before, 'supplement-ui.js on the boot path exactly once').toBe(1);

    // customer.html's tag is '/pro/js/supplement-ui.js?v=1'; the bundle entry
    // is 'js/supplement-ui.js?v=1'. A raw-string dedupe sees two files.
    await safeEvaluate(page, async () => { await window.ScriptLoader.loadBundle('estimates'); });
    await page.waitForTimeout(750);

    expect(hits(urls, 'supplement-ui.js'), 'not re-fetched by the estimates bundle').toBe(before);
    const tags = await safeEvaluate(page, () =>
      document.querySelectorAll('script[src*="supplement-ui.js"]').length);
    expect(tags, 'exactly one supplement-ui.js tag in the DOM').toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe('boot weight — photo-report.js is lazy on customer.html @engines', () => {
  // 2026-09-06: photo-report.js was eager here ONLY to out-race a rival
  // window.generatePhotoReport in customer-photo-report-generator.js. That rival
  // was dead (this file overwrote it) and is deleted, so the tag went too. The
  // failure mode this guards is SILENT: without the load-then-run stub the
  // "📋 Generate Report" button logs an unknown action and does nothing visible.
  test('absent at boot, and the stub resolves it on demand', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await loginAs(page, creds);
    const urls = trackRequests(page);
    await page.goto('/pro/customer.html?id=E2E-BOOT-WEIGHT');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => !!(window.ScriptLoader && window.ScriptLoader.loadBundle), null, { timeout: 20_000 });

    expect(hits(urls, 'photo-report.js'), 'photo-report.js must not be fetched at boot').toBe(0);

    // the global must EXIST (or every entry point is a silent no-op) and be the stub
    const before = await safeEvaluate(page, () => ({
      type: typeof window.generatePhotoReport,
      isStub: !!(window.generatePhotoReport && window.generatePhotoReport.__nbdLazyPhotoReportStub),
    }));
    expect(before.type, 'generatePhotoReport must be defined at boot').toBe('function');
    expect(before.isStub, 'and it must be the lazy stub').toBe(true);

    // the dead rival must not be reachable any more
    expect(await safeEvaluate(page, () => typeof window.fetchImageAsBase64)).toBe('undefined');

    // loading the bundle must replace the stub with the real renderer
    const after = await safeEvaluate(page, async () => {
      await window.ScriptLoader.loadBundle('photos');
      return {
        type: typeof window.generatePhotoReport,
        stillStub: !!(window.generatePhotoReport && window.generatePhotoReport.__nbdLazyPhotoReportStub),
        pairs: typeof window._buildPhotoReportPairs,
      };
    });
    expect(after.type).toBe('function');
    expect(after.stillStub, 'the real photo-report.js must overwrite the stub').toBe(false);
    expect(after.pairs, 'photo-report.js actually executed').toBe('function');
    expect(hits(urls, 'photo-report.js'), 'fetched on demand').toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

test.describe('duplicate execution — Cmd+K @engines', () => {
  test('one keypress opens exactly one palette', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await loginAs(page, creds);
    await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 20_000 });

    // Both palettes must actually be present, or this test proves nothing.
    const present = await safeEvaluate(page, () => ({
      legacy: !!document.getElementById('cmdPalette'),
      canonical: !!window.NBDCommand,
    }));
    expect(present.legacy, 'ui.js #cmdPalette exists on the dashboard').toBe(true);
    expect(present.canonical, 'command-palette.js NBDCommand is loaded').toBe(true);

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    const open = await safeEvaluate(page, () => {
      const legacyEl = document.getElementById('cmdPalette');
      const legacy = !!legacyEl && getComputedStyle(legacyEl).display !== 'none';
      // NBDCommand renders its own modal; find any other visible palette node.
      const others = [...document.querySelectorAll('[id]')]
        .filter((e) => e.id !== 'cmdPalette' && /cmdk|command|palette/i.test(e.id))
        .filter((e) => getComputedStyle(e).display !== 'none');
      return { legacy, canonical: others.length > 0, ids: others.map((e) => e.id) };
    });

    expect(open.legacy, 'the legacy ui.js palette must stand down').toBe(false);
    expect(open.canonical, 'the canonical NBDCommand palette opens (ids: ' + open.ids.join(',') + ')').toBe(true);
    expect(errors).toEqual([]);
  });
});

test.describe('boot weight — Leaflet CSS rides the lazy bundle @engines', () => {
  // NOTE ON SCOPE, measured 2026-09-06: 'weather-radar' is in DEFAULT_WIDGETS
  // (widgets.js), and its render() calls _withLeaflet → loadBundle('mapvendor').
  // So on a DEFAULT home view the Leaflet bytes still arrive shortly after
  // boot — what this change removes is four RENDER-BLOCKING <link>s from
  // <head>, not the bytes. Asserting "never fetched" would therefore be a
  // false gate. The honest invariants are: not parser-blocking, and correct
  // (applied, and ahead of leaflet.js) whenever the bundle does load.
  test('stylesheets are not parser-blocking, and apply when the bundle loads', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await loginAs(page, creds);
    await page.waitForFunction(() => !!(window.ScriptLoader && window.ScriptLoader.loadBundle), null, { timeout: 20_000 });

    // 1. the served HTML must carry no leaflet stylesheet <link> — that is
    //    what put them on the critical path.
    const html = await (await page.request.get('/pro/dashboard.html')).text();
    const blocking = (html.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) || [])
      .filter((t) => /leaflet|MarkerCluster/i.test(t));
    expect(blocking, 'no render-blocking leaflet <link> in dashboard.html').toEqual([]);

    // 2. whenever the bundle loads, the CSS must be there and APPLIED —
    //    leaflet.css sets `.leaflet-pane { position: absolute }`; without the
    //    rule the computed value falls back to `static`.
    const after = await safeEvaluate(page, async () => {
      await window.ScriptLoader.loadBundle('mapvendor');
      const probe = document.createElement('div');
      probe.className = 'leaflet-pane';
      document.body.appendChild(probe);
      const position = getComputedStyle(probe).position;
      probe.remove();
      const sheets = [...document.querySelectorAll('link[rel="stylesheet"][href]')]
        .map((l) => l.getAttribute('href'))
        .filter((h) => /leaflet|MarkerCluster/i.test(h));
      return { position, sheets: sheets.length, hasL: typeof window.L };
    });
    expect(after.sheets, 'all four leaflet stylesheets injected').toBe(4);
    expect(after.position, '.leaflet-pane is styled — the CSS actually applied').toBe('absolute');
    expect(after.hasL, 'leaflet.js loaded behind its CSS').toBe('object');

    // 3. the user-visible proof: the default home view's radar widget still
    //    builds a real map (Leaflet only creates .leaflet-pane children once
    //    L.map() has run against a styled container).
    const radar = await safeEvaluate(page, async () => {
      const el = document.getElementById('w-radar-map');
      if (!el) return { present: false };
      for (let i = 0; i < 40 && !el.querySelector('.leaflet-pane'); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return { present: true, panes: el.querySelectorAll('.leaflet-pane').length };
    });
    if (radar.present) {
      expect(radar.panes, 'weather-radar widget built a Leaflet map').toBeGreaterThan(0);
    }

    expect(errors).toEqual([]);
  });
});

test.describe('boot weight — maps-routing.js (drawtool) is lazy on the dashboard @engines', () => {
  // 2026-09-14: maps-routing.js (172 KiB, the #2 static file on the page)
  // was the last of the four maps-split siblings still eager — see its own
  // header and script-loader.js's `drawtool` bundle comment for the full
  // rationale. goTo('draw') already polled window.initDrawMap via the same
  // waitForMapFn() used for Leaflet itself, so the dispatcher needed no
  // change; the one gap was a bare `if(drawMap)` read in the drawSearch
  // autocomplete callback (dashboard-ui.js), fixed alongside this move.
  test('absent at boot, and goTo(\'draw\') fetches it and builds a real map', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await loginAs(page, creds);
    const urls = trackRequests(page);
    await page.goto('/pro/dashboard.html');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 20_000 });

    // 1. not on the boot path
    expect(hits(urls, 'maps-routing.js'), 'maps-routing.js must not be fetched at boot').toBe(0);
    expect(await safeEvaluate(page, () => typeof window.initDrawMap)).toBe('undefined');
    // draw-geom.js (2026-09-25, draw lane L1) rides the same bundle, ahead of
    // maps-routing.js — lazy with it, never on the boot path.
    expect(hits(urls, 'draw-geom.js'), 'draw-geom.js must not be fetched at boot').toBe(0);
    expect(await safeEvaluate(page, () => typeof window.NBDDrawGeom)).toBe('undefined');
    // drawMap is a bare sibling-scope `let`, never a window property (see
    // maps-routing.js's header) — confirm the ReferenceError class of bug
    // this PR fixed doesn't exist at boot, i.e. the drawSearch callback
    // survives being invoked before the module has ever loaded.
    const preNav = await safeEvaluate(page, () => {
      try {
        const cb = window._acCallbacks && window._acCallbacks['drawSearch'];
        if (typeof cb !== 'function') return { ran: false, reason: 'no drawSearch callback registered' };
        cb({ lat: '39.1', lon: '-84.5' });
        return { ran: true };
      } catch (e) {
        return { ran: false, threw: String((e && e.message) || e) };
      }
    });
    expect(preNav.threw, 'drawSearch must not throw before maps-routing.js loads (regression: bare `if(drawMap)`)').toBeUndefined();

    // 2. goTo('draw') fetches the bundle and constructs a real Leaflet map
    await safeEvaluate(page, () => { window.goTo('draw'); });
    await page.waitForFunction(
      () => typeof window.initDrawMap === 'function',
      null, { timeout: 20_000 }
    );
    await page.waitForFunction(
      () => { const el = document.getElementById('drawMap'); return !!(el && el.querySelector('.leaflet-pane')); },
      null, { timeout: 20_000 }
    );

    expect(hits(urls, 'maps-routing.js'), 'fetched once the draw view opens').toBeGreaterThan(0);
    expect(hits(urls, 'draw-geom.js'), 'draw-geom.js fetched with the drawtool bundle').toBeGreaterThan(0);
    expect(await safeEvaluate(page, () => typeof (window.NBDDrawGeom && window.NBDDrawGeom.computeTotals)),
      'window.NBDDrawGeom is live once the draw view opens').toBe('function');
    const panes = await safeEvaluate(page, () =>
      document.getElementById('drawMap').querySelectorAll('.leaflet-pane').length);
    expect(panes, 'the draw map actually constructed Leaflet panes').toBeGreaterThan(0);

    // 3. the drawSearch callback works for real once the module has loaded
    const postNav = await safeEvaluate(page, () => {
      try {
        window._acCallbacks['drawSearch']({ lat: '39.2', lon: '-84.6' });
        return { threw: undefined };
      } catch (e) {
        return { threw: String((e && e.message) || e) };
      }
    });
    expect(postNav.threw).toBeUndefined();

    expect(errors, 'no uncaught page errors').toEqual([]);
  });
});

test.describe('boot weight — talk-tank.js is lazy on the dashboard @engines', () => {
  // 2026-09-14: two static <script> tags (talk-tank.js was one) with zero
  // callers outside their own view — the same treatment already given to
  // storm/closeboard/expenses/money/repos via the `_lazyPreload.then(...)`
  // chain in dashboard-actions.js's goTo() dispatcher.
  test('absent at boot, and goTo(\'talk-tank\') fetches it and initializes', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await loginAs(page, creds);
    const urls = trackRequests(page);
    await page.goto('/pro/dashboard.html');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 20_000 });

    expect(hits(urls, 'talk-tank.js'), 'talk-tank.js must not be fetched at boot').toBe(0);
    expect(await safeEvaluate(page, () => typeof window.TalkTank)).toBe('undefined');

    await safeEvaluate(page, () => { window.goTo('talk-tank'); });
    await page.waitForFunction(
      () => !!(window.TalkTank && typeof window.TalkTank.init === 'function'),
      null, { timeout: 20_000 }
    );

    expect(hits(urls, 'talk-tank.js'), 'fetched once the talk-tank view opens').toBeGreaterThan(0);
    const after = await safeEvaluate(page, () => ({
      init: typeof window.TalkTank.init,
      refresh: typeof window.TalkTank.refresh,
      render: typeof window.TalkTank.render,
    }));
    expect(after.init).toBe('function');
    expect(after.refresh).toBe('function');
    expect(after.render).toBe('function');

    expect(errors, 'no uncaught page errors').toEqual([]);
  });
});

// ── Boot READS (startup audit 2026-10-04) ────────────────────────────────
// The rows above guard boot BYTES; this guards boot Firestore READS. Until
// 2026-10-04 loadLeads finished every boot with an unbounded read of EVERY
// photos doc in scope (own + company), and loadPins / loadZones read whole
// collections. Measured here from the client's own Listen-channel traffic:
// every query the SDK starts is an addTarget carrying its structuredQuery,
// so the collectionIds in those request bodies ARE the boot queries — the
// same measure works against old and new code (old: one photos query per
// scope at boot; new: none until a lead is opened).
function trackFirestoreQueries(page) {
  const queries = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel/.test(r.url())) return;
    let body = r.postData() || '';
    // Form-encoded (count=N&ofs=..&req0___data__=<json>&req1___data__=…):
    // decode PER FIELD — one malformed escape must not leave the whole body raw.
    try { body = [...new URLSearchParams(body).values()].join('\n'); } catch (_) { /* keep raw */ }
    for (const m of body.matchAll(/"structuredQuery":\{"from":\[\{"collectionId":"([\w-]+)"[^\]]*\]([\s\S]*?)\}\}?,"targetId"/g)) {
      queries.push({ collection: m[1], body: m[2] });
    }
  });
  return queries;
}

test.describe('boot reads — no photo read at boot; pins / zones capped @engines', () => {
  test('dashboard boot issues no photos query; opening a lead fetches only that lead', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await loginAs(page, creds);
    const queries = trackFirestoreQueries(page);
    await page.goto('/pro/dashboard.html');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => window._leadsLoaded === true, null, { timeout: 30_000 });
    // Let the post-load tail (pins, zones, estimates, jobs) run.
    await page.waitForTimeout(3000);

    const byColl = {};
    for (const q of queries) byColl[q.collection] = (byColl[q.collection] || 0) + 1;
    console.log('[boot-reads] queries during boot by collection: ' + JSON.stringify(byColl));
    expect(queries.length, 'the channel tracker saw the boot queries (leads at least)').toBeGreaterThan(0);
    expect(byColl.leads || 0, 'leads are still read in full (kanban must stay complete)').toBeGreaterThan(0);
    expect(byColl.photos || 0, 'NO photos query at dashboard boot').toBe(0);
    for (const q of queries.filter((x) => x.collection === 'pins' || x.collection === 'zones')) {
      expect(q.body, q.collection + ' query carries a limit').toMatch(/"limit"/);
    }

    // The zones read is capped: drive it explicitly (window.loadZones is the
    // map's own refresh entry) and read the query the SDK sent.
    const zBefore = queries.length;
    await safeEvaluate(page, async () => { await window.loadZones(); });
    const zq = queries.slice(zBefore).filter((q) => q.collection === 'zones');
    expect(zq.length, 'loadZones issued a zones query').toBeGreaterThan(0);
    for (const q of zq) expect(q.body, 'zones query carries limit(ZONE_CAP)').toMatch(/"limit":300/);

    // On demand: ask for one lead the way the job detail does.
    const leadId = await safeEvaluate(page, () => (window._leads && window._leads[0] && window._leads[0].id) || null);
    test.skip(!leadId, 'seeded tenant has no lead to open');
    const before = queries.length;
    await safeEvaluate(page, async (id) => { await window.NBDPhotoCache.ensure([id]); }, leadId);
    const photoQs = queries.slice(before).filter((q) => q.collection === 'photos');
    expect(photoQs.length, 'opening one lead → photos read in the user\'s scope(s)').toBeGreaterThan(0);
    for (const q of photoQs) {
      expect(q.body, 'photo read is bounded to the requested lead (leadId IN [...])').toMatch(/"fieldPath":"leadId"\},"op":"IN"/);
      expect(q.body).toContain(leadId);
    }
    const loaded = await safeEvaluate(page, (id) => window.NBDPhotoCache.isLoaded(id) && Array.isArray(window._photoCache[id]), leadId);
    expect(loaded, 'the lead\'s bag is in _photoCache').toBe(true);
    const again = queries.length;
    await safeEvaluate(page, async (id) => { await window.NBDPhotoCache.ensure([id]); }, leadId);
    expect(queries.length, 'asking again reads nothing').toBe(again);

    expect(errors, 'no uncaught page errors').toEqual([]);
  });
});
