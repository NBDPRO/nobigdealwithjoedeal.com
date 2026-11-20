// tests/e2e/phone-draw-baseline.spec.js — what the Drawing Tool already does
// RIGHT with a real finger, pinned before the phone rebuild touches it
// (draw lane L1, 2026-09-25).
//
// The phone audit (412 and 360 wide, CDP touch) found the Draw view broken in
// nine places, and also found what works: a tap places exactly one point
// through 0-12px of finger roll and 300-900ms holds; a one-finger pan or a
// pinch while armed places nothing; line and single-run gutter lengths are
// exact; a traced 4-corner wing reads 1075 sf (independently 1077.7 sf).
// The rebuild (L2 money fixes, L3 engine seam, L4 crosshair screen) must not
// lose any of that, so this file passes on the code as it is today.
//
// How it measures:
//   - Real touch: CDP Input.dispatchTouchEvent via fixtures/draw-touch.js.
//     The browser makes the click / pan / pinch itself, as on a phone.
//   - Hermetic: map tiles are a stubbed 256px PNG; geometry is a fixed z21
//     fixture (WING) converted to client px through drawMap at run time.
//   - Expected numbers come from docs/pro/js/draw-geom.js, required here in
//     node — the page does not need to load it, so this also passes on a
//     main that predates it.
//   - Modes are armed through the same window/registry handlers the drawer
//     buttons call; the drawer UI itself is what later lanes replace.
//
// One login per width (serial), so the file stays well under two minutes at
// --workers=1. Tagged @shard2 for its CI shard.
// Run locally against a served worktree:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//     PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//     npx playwright test --config=playwright.config.js phone-draw-baseline.spec.js --workers=1
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeWaitForFunction } = require('./fixtures/auth');
const T = require('./fixtures/draw-touch');
const G = require(path.join(__dirname, '..', '..', 'docs', 'pro', 'js', 'draw-geom.js'));

const { WING } = T;

let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

// Geocoding (searchDraw / address autocomplete) and Cloud Functions are not
// part of anything measured here; answer them locally (functions-less shard).
async function stubNetwork(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
}

// Arrive as a returning user: the onboarding tour and push opt-in land over
// the page a moment after boot on a fresh CI tenant (see phone-dashnav).
async function returningUser(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
    } catch (e) { /* storage blocked: the tour just shows */ }
  });
}

const px = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// recalc()'s in-progress-perimeter term reads the module-private
// perimBaseArea, which the autosave does not store. Rebuild it from what is
// stored: a closed perimeter whose points ARE the last facet's points was
// saved as that facet, so its area is that facet's baseArea — the page's own
// number. Recomputing it here with G.shoelace() is NOT equivalent: Chromium's
// V8 and node's V8 differ by one ulp on this wing's area (measured
// 2026-09-25: 1075.2482543866156 vs ...158), and recalc() dedupes that term
// with ===, so a node-side recompute double-counts the facet.
function perimOpts(saved) {
  const perim = saved.perimPoints || [];
  const last = (saved.facets || [])[saved.facets.length - 1];
  const same = !!last && JSON.stringify(last.points) === JSON.stringify(perim);
  return { perimClosed: !!saved.perimClosed, perimBaseArea: same ? last.baseArea : G.shoelace(perim) };
}

for (const width of [412, 360]) {
  test.describe.serial(`phone draw baseline ${width}px @shard2`, () => {
    /** @type {import('@playwright/test').BrowserContext} */ let context;
    /** @type {import('@playwright/test').Page} */ let page;
    let touch = null;
    const pageErrors = [];

    // Tap a fixture point after checking a finger there would reach the map
    // (not a label, control or toast), so a covered target fails by name.
    async function tapLL(ll, label, opts) {
      const pt = await T.ll2client(page, ll);
      const hit = await T.hitAt(page, pt);
      expect(hit.ok, `${label} at (${Math.round(pt.x)}, ${Math.round(pt.y)}) is open map, not ${hit.what}`).toBe(true);
      await touch.tap(pt, opts);
      return pt;
    }
    // Answer the Eave/Rake chooser the way its buttons do. Only when it is
    // showing: once phones commit edges directly (L3) this becomes a no-op.
    async function chooseEdge(type) {
      if ((await T.drawState(page)).reChooserVisible) await page.evaluate((t) => window.perimChooseType(t), type);
    }
    async function fresh(mode) {
      await T.quietToasts(page);
      await T.resetDrawing(page);
      await T.setView(page, WING.view, WING.zoom);
      await T.arm(page, mode);
    }

    test.beforeAll(async ({ browser }, testInfo) => {
      if (!creds) return;
      testInfo.setTimeout(90_000);
      context = await browser.newContext(T.phoneContextOptions(width));
      await returningUser(context);
      page = await context.newPage();
      await T.acceptDialogs(page);
      await T.stubTiles(page);
      await stubNetwork(page);
      await loginAs(page, creds);
      await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
      await T.openDraw(page);
      // Only errors raised while drawing count; boot noise is other specs' job.
      page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      touch = await T.touchSession(page);
    });

    test.afterAll(async () => {
      if (touch) await touch.detach();
      if (context) await context.close();
    });

    test.beforeEach(async ({}, testInfo) => {
      if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
    });

    test('harness: a coarse-pointer phone, stubbed tiles that decode, a sampler that counts', async () => {
      await T.setView(page, WING.view, WING.zoom);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the page sees a touch phone').toBe(true);
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#drawMap img.leaflet-tile')]
        .filter((i) => i.complete && i.naturalWidth === 256).length), { message: 'stubbed tiles decoded at 256px' }).toBeGreaterThan(0);
      expect(page.__drawTiles, 'tile requests answered by the stub').toBeGreaterThan(0);
      // The sampler must see timers scheduled while it runs, or a later
      // "fewer than N" assertion built on it would pass vacuously.
      const sampling = T.sampleTimers(page, 500);
      await page.waitForTimeout(80); // let the wrapper install first
      await page.evaluate(() => { for (let i = 0; i < 3; i++) setTimeout(() => {}, 30); });
      const s = await sampling;
      expect(s.byDelay['30'] || 0, 'sampled 30ms timers').toBeGreaterThanOrEqual(3);
    });

    test('line: two taps measure the haversine length of the points the finger placed', async () => {
      await fresh('line');
      const pa = await tapLL(WING.A, 'corner A');
      const pb = await tapLL(WING.B, 'corner B');
      const pc = await tapLL(WING.C, 'corner C');
      const pd = await tapLL(WING.D, 'corner D');
      const st = await T.drawState(page);
      expect(st.dots, 'one dot per tap').toBe(4);
      expect(st.saved && st.saved.lines.length, 'two lines (A-B, C-D) in the autosave').toBe(2);
      const pairs = [[pa, pb, WING.A, WING.B], [pc, pd, WING.C, WING.D]];
      for (let i = 0; i < 2; i++) {
        const l = st.saved.lines[i];
        const [f1, f2, t1, t2] = pairs[i];
        // Each end lands where the finger was.
        expect(px(await T.ll2client(page, l.p1), f1), `line ${i + 1} start vs the tap`).toBeLessThanOrEqual(1.5);
        expect(px(await T.ll2client(page, l.p2), f2), `line ${i + 1} end vs the tap`).toBeLessThanOrEqual(1.5);
        // The stored length IS the haversine of the committed ends...
        expect(Math.abs(l.dist - G.hav(l.p1, l.p2)), `line ${i + 1} dist is hav(p1, p2)`).toBeLessThan(1e-9);
        // ...and within pixel rounding (0.19 ft/px at z21) of the true side.
        expect(Math.abs(l.dist - G.hav(t1, t2)), `line ${i + 1} vs the analytic side`).toBeLessThanOrEqual(0.3);
        expect(st.lineLens[i], `line ${i + 1} list row`).toBe(l.dist.toFixed(1) + ' ft');
      }
    });

    test('gutter: one three-tap run reads its exact LF and downspouts', async () => {
      await fresh('gutter');
      await tapLL(WING.D, 'corner D');
      await tapLL(WING.C, 'corner C');
      await tapLL(WING.B, 'corner B');
      const st = await T.drawState(page);
      expect(st.dots, 'one dot per tap').toBe(3);
      const segs = (st.saved && st.saved.lines) || [];
      expect(segs.map((l) => l.type), 'two Gutters segments').toEqual([10, 10]);
      const lf = segs.reduce((s, l) => s + l.dist, 0);
      const truth = G.hav(WING.D, WING.C) + G.hav(WING.C, WING.B);
      expect(Math.abs(lf - truth), `run LF ${lf.toFixed(2)} vs analytic ${truth.toFixed(2)}`).toBeLessThanOrEqual(0.4);
      // #gr-total / #gr-ds are text contracts: exactly what draw-geom computes.
      const tot = G.computeTotals(segs, [], st.pitch, st.waste);
      expect(st.text.gutter, '#gr-total').toBe(tot.text.gutter);
      expect(st.text.gutter).toBe(lf.toFixed(1) + ' ft');
      expect(st.text.ds, '#gr-ds = ceil(LF / 40)').toBe(String(Math.ceil(lf / 40)));
      expect(st.text.ds).toBe('2');
    });

    test('perimeter: the 4-corner wing closes at 1075 sf ±0.5%, and the readout is draw-geom\'s', async () => {
      await fresh('perim');
      await tapLL(WING.A, 'corner A');
      await tapLL(WING.B, 'corner B'); await chooseEdge('eave');
      await tapLL(WING.C, 'corner C'); await chooseEdge('rake');
      await tapLL(WING.D, 'corner D'); await chooseEdge('eave');
      await tapLL(WING.A, 'corner A again (close)'); await chooseEdge('rake');
      const st = await T.drawState(page);
      expect(st.polys, 'one closed facet polygon').toBe(1);
      expect(st.saved && st.saved.facets.filter((f) => f.closed).length, 'one closed facet saved').toBe(1);
      const sides = st.saved.lines.map((l) => l.dist);
      const truth = [G.hav(WING.A, WING.B), G.hav(WING.B, WING.C), G.hav(WING.C, WING.D), G.hav(WING.D, WING.A)];
      expect(sides.length, 'four edges').toBe(4);
      sides.forEach((d, i) => expect(Math.abs(d - truth[i]), `edge ${i + 1}: ${d.toFixed(2)} vs ${truth[i].toFixed(2)} ft`).toBeLessThanOrEqual(0.3));
      const base = parseFloat(st.text.base);
      expect(Math.abs(base - WING.expected.appAreaSf) / WING.expected.appAreaSf, `#cr-base ${st.text.base} vs 1075 sf`).toBeLessThanOrEqual(0.005);
      const analytic = G.shoelace([WING.A, WING.B, WING.C, WING.D]);
      expect(Math.abs(base - analytic) / analytic, `#cr-base vs the fixture's own area ${analytic.toFixed(1)}`).toBeLessThanOrEqual(0.005);
      // Every readout string equals draw-geom's copy of recalc() run on the
      // committed state — the contract L2 swaps recalc() onto.
      const tot = G.computeTotals(st.saved.lines, st.saved.facets, st.pitch, st.waste, perimOpts(st.saved));
      expect(tot.source).toBe('facets');
      expect(st.text.base, '#cr-base').toBe(tot.text.base);
      expect(st.text.pitched, '#cr-pitched').toBe(tot.text.pitched);
      expect(st.text.waste, '#cr-waste').toBe(tot.text.waste);
      expect(st.text.sq, '#cr-sq').toBe(tot.text.sq);
    });

    test('taps: 0-12px of finger roll and 300-900ms holds each add exactly one point', async () => {
      await fresh('gutter');
      const box = await T.mapBox(page);
      const got = [];
      const one = async (pt, opts, label) => {
        const hit = await T.hitAt(page, pt);
        expect(hit.ok, `${label} lands on open map, not ${hit.what}`).toBe(true);
        const before = (await T.drawState(page)).dots;
        await touch.tap(pt, opts);
        got.push({ label, added: (await T.drawState(page)).dots - before });
      };
      // Left to right along one row, 22px+ apart: never on an earlier dot or
      // segment, never within the 12px snap of the previous point; high
      // enough to stay clear of the toast strip above the bottom nav.
      for (const roll of [0, 2, 3, 4, 6, 8, 12]) {
        await one({ x: box.x + 40 + roll * 22, y: box.y + box.h - 200 }, { roll, holdMs: 100 }, `roll ${roll}px`);
      }
      for (const hold of [300, 600, 900]) {
        await one({ x: box.x + 200, y: box.y + 200 + hold / 10 }, { holdMs: hold }, `hold ${hold}ms`);
      }
      expect(got, 'points added per tap').toEqual(got.map((g) => ({ label: g.label, added: 1 })));
      const st = await T.drawState(page);
      expect(st.saved && st.saved.lines.length, '10 gutter taps chain 9 segments').toBe(9);
    });

    test('gestures: a slow one-finger pan and a pinch while armed add no points', async () => {
      await fresh('line');
      const box = await T.mapBox(page);
      const from = { x: box.x + box.w * 0.7, y: box.y + box.h * 0.3 };
      expect((await T.hitAt(page, from)).ok, 'pan start is open map').toBe(true);
      const s0 = await T.drawState(page);
      await touch.pan(from, { x: from.x, y: from.y + 180 }, { steps: 24, stepMs: 16 });
      const s1 = await T.drawState(page);
      expect(s1.dots, 'points after a 180px pan').toBe(0);
      expect(Math.abs(s1.center.lat - s0.center.lat), 'the pan moved the map').toBeGreaterThan(5e-5);
      const mid = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      await touch.pinch(mid, 220, 70, { steps: 12 });
      const s2 = await T.drawState(page);
      expect(s2.zoom, 'the pinch zoomed out').toBeLessThan(WING.zoom);
      expect(s2.dots, 'points after a pinch').toBe(0);
      expect((s2.saved && s2.saved.lines.length) || 0, 'no lines').toBe(0);
      expect(pageErrors, 'uncaught page errors while drawing').toEqual([]);
    });
  });
}
