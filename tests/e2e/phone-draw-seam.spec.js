// tests/e2e/phone-draw-seam.spec.js — the crosshair-ready Draw engine
// (draw lane L3, 2026-09-25): drawMap.nbdDraw, crosshair mode, shared
// corners, the guards and the preview, driven with a real finger.
//
// What it pins (the campaign plan's L3 test list, Jo's decisions 1/4/8):
//   - the seam: drawMap.nbdDraw + one 'nbd:drawmap-ready' on document, and
//     nothing new on window; crosshair mode is OFF until the crosshair screen
//     (L4) turns it on — Jo test-drives it before it reaches everyone (8);
//   - crosshair mode on a coarse pointer: a one-finger pan and a tap add 0
//     points, a tap AIMS (the tapped spot slides under the crosshair), a
//     pinch that starts off-centre zooms around the crosshair, no inertia;
//     lines, length chips and dots stop taking taps;
//   - placeAtReticle: after a flick it places at the centre the map stopped
//     at; with a finger still down it is refused, and preview() mid-pan is
//     hav(anchor, centre) — the committed length equals the last preview;
//     the same-spot guard (6 px); perimeter edges commit as the sticky type
//     with no chooser, and an Add snapped onto the first corner closes;
//   - shared corners: an Add on an existing corner starts ON it (vertex
//     count unchanged); moveVertex on a corner two sections share moves
//     every edge and both areas, with no tearing; Undo puts it back;
//   - the preview band is ONE reused layer (50 moves, same layer count);
//   - the DRAW MODE / NAVIGATE toggle is gone; "tap" on a phone, "click"
//     with a mouse;
//   - desktop parity (1280, mouse): no crosshair, the Eave/Rake chooser after
//     every edge, keyboard shortcuts, a corner dragged from dead-centre (even
//     under its length chip) moves every line on it, and Set length moves the
//     far corner as a shared corner (it used to tear the next edge off).
//
// How it measures — the L1 harness (fixtures/draw-touch.js): CDP touch, a
// stubbed tile PNG, the WING z21 fixture converted to client px at run time.
// Expected numbers come from docs/pro/js/draw-geom.js required in node.
// The tap-aim, pinch and toggle tests run WITHOUT the seam when it is
// missing (the break-test against main / the L2 base shows the real
// behaviour there: a tap places a point, the pinch drifts, the toggle sits
// on the map). Nothing is written to Firestore.
//
// @shard3 (registered in tests/package.json by L1). Phones at 412 and 360
// (one login each, serial), desktop 1280 with a mouse. Run locally:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//     PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//     npx playwright test --config=playwright.config.js phone-draw-seam.spec.js --workers=1
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeWaitForFunction } = require('./fixtures/auth');
const T = require('./fixtures/draw-touch');
const G = require(path.join(__dirname, '..', '..', 'docs', 'pro', 'js', 'draw-geom.js'));

const { WING } = T;

let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

const FT_DEG = G.EARTH_R_FT * Math.PI / 180;
const at = (o, eastFt, northFt) => ({ lat: o.lat + northFt / FT_DEG, lng: o.lng + eastFt / (FT_DEG * Math.cos(o.lat * Math.PI / 180)) });
const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
const px = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
// Section 2: a 20 ft wide section east of the wing, sharing its B-C edge.
const E2 = at(WING.B, 20, 0);
const F2 = at(WING.C, 20, 0);

async function stubNetwork(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
}
async function returningUser(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
    } catch (e) { /* storage blocked */ }
    // Count the seam's announcement (test-only globals in the test page).
    document.addEventListener('nbd:drawmap-ready', (e) => {
      window.__drawReady = (window.__drawReady || 0) + 1;
      window.__drawReadyApi = !!(e.detail && e.detail.api && e.detail.map && e.detail.map.nbdDraw === e.detail.api);
    });
  });
}
// Native dialogs: accept; a prompt() gets page.__promptValue when set.
function dialogs(page) {
  page.__dialogLog = [];
  page.on('dialog', (d) => {
    page.__dialogLog.push(d.type() + ': ' + d.message());
    const v = d.type() === 'prompt' && page.__promptValue != null ? String(page.__promptValue) : undefined;
    (v !== undefined ? d.accept(v) : d.accept()).catch(() => {});
  });
}

// Shared page helpers — `ctx` = {page}.
function helpers(ctx) {
  const page = () => ctx.page;
  const call = (fn, ...args) => page().evaluate(([f, a]) => {
    const api = typeof drawMap !== 'undefined' && drawMap && drawMap.nbdDraw;
    if (!api) throw new Error('drawMap.nbdDraw is missing');
    return api[f](...a);
  }, [fn, args]);
  const hasSeam = () => page().evaluate(() => !!(typeof drawMap !== 'undefined' && drawMap && drawMap.nbdDraw));
  // Put `ll` exactly under the crosshair (reset: Leaflet re-origins the view
  // instead of panning by a truncated whole-pixel offset).
  const centreOn = async (ll, z) => {
    await page().evaluate(([lat, lng, zz]) => drawMap.setView([lat, lng], zz || drawMap.getZoom(), { animate: false, reset: true }), [ll.lat, ll.lng, z || 0]);
    await page().waitForTimeout(40);
  };
  const nudge = async (dx, dy) => {
    await page().evaluate(([x, y]) => drawMap.panBy([x, y], { animate: false }), [dx, dy]);
    await page().waitForTimeout(30);
  };
  const placeAt = async (ll, opts) => { await centreOn(ll); return call('placeAtReticle', opts || {}); };
  const centreClient = async () => { const b = await T.mapBox(page()); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
  const centreLL = () => page().evaluate(() => { const c = drawMap.getCenter(); return { lat: c.lat, lng: c.lng }; });
  const layerCount = () => page().evaluate(() => { let n = 0; drawMap.eachLayer(() => { n++; }); return n; });
  return { call, hasSeam, centreOn, nudge, placeAt, centreClient, centreLL, layerCount };
}

// ─────────────────────────────────────────────────────────────────────
// Phones: 412 and 360, real CDP touch.
// ─────────────────────────────────────────────────────────────────────
for (const width of [412, 360]) {
  test.describe.serial(`draw seam ${width}px @shard3`, () => {
    /** @type {import('@playwright/test').BrowserContext} */ let context;
    const ctx = { page: null };
    let touch = null;
    const pageErrors = [];
    const H = helpers(ctx);
    const page = () => ctx.page;

    async function crosshairOn() {
      return page().evaluate(() => !!(typeof drawMap !== 'undefined' && drawMap && drawMap.nbdDraw && drawMap.nbdDraw.setCrosshair(true)));
    }
    // Clean drawing, the wing in view, crosshair on (when the seam exists).
    // `mode` arms through the drawer's own handlers (works without the seam).
    async function fresh(mode, view, zoom) {
      await T.quietToasts(page());
      await T.resetDrawing(page());
      await T.setView(page(), view || WING.view, zoom || WING.zoom);
      await crosshairOn();
      if (mode) await T.arm(page(), mode);
    }
    const st = () => H.call('state');
    const saved = async () => (await T.drawState(page())).saved || { lines: [], facets: [] };

    test.beforeAll(async ({ browser }, testInfo) => {
      if (!creds) return;
      testInfo.setTimeout(90_000);
      context = await browser.newContext(T.phoneContextOptions(width));
      await returningUser(context);
      ctx.page = await context.newPage();
      dialogs(page());
      await T.stubTiles(page());
      await stubNetwork(page());
      await loginAs(page(), creds);
      await safeWaitForFunction(page(), () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
      await T.openDraw(page());
      page().on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      touch = await T.touchSession(page());
    });
    test.afterAll(async () => {
      if (touch) await touch.detach();
      if (context) await context.close();
    });
    test.beforeEach(async ({}, testInfo) => {
      if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
    });

    test('the seam: drawMap.nbdDraw, announced once, nothing on window; the toggle is gone; z22 over native tiles', async () => {
      const info = await page().evaluate(() => ({
        toggle: document.querySelectorAll('#drawModeToggle').length,
        seam: !!(drawMap && drawMap.nbdDraw),
        ready: window.__drawReady || 0, readyApi: !!window.__drawReadyApi,
        onWindow: ['nbdDraw', 'placeAtReticle', 'moveVertex', 'setCrosshair', 'pick', 'snap', 'finishRun', 'closeShape', 'setMode']
          .filter((k) => Object.prototype.hasOwnProperty.call(window, k)),
        coarse: matchMedia('(pointer: coarse)').matches,
        tolerance: drawMap.options.renderer && drawMap.options.renderer.options ? drawMap.options.renderer.options.tolerance : null,
        maxZoom: drawMap.getMaxZoom(),
      }));
      expect(info.toggle, 'no DRAW MODE / NAVIGATE toggle on the map').toBe(0);
      expect(info.seam, 'drawMap.nbdDraw is attached at the end of init').toBe(true);
      expect(info.ready, "one 'nbd:drawmap-ready' on document").toBe(1);
      expect(info.readyApi, 'its detail carries {map, api} and api === map.nbdDraw').toBe(true);
      expect(info.onWindow, 'no new window globals').toEqual([]);
      expect(info.coarse, 'a coarse-pointer phone').toBe(true);
      expect(info.tolerance, 'the canvas hit-tests with 10 px of finger slack').toBe(10);
      expect(info.maxZoom, 'maxZoom').toBe(22);
      // Every base layer: maxZoom 22 over its provider's native cap, so z22
      // upscales instead of asking for tiles that do not exist.
      const layers = [];
      for (let i = 0; i < 3; i++) {
        layers.push(await page().evaluate(() => {
          const out = [];
          drawMap.eachLayer((l) => { if (l instanceof L.TileLayer) out.push({ host: String(l._url).split('/')[2], maxZoom: l.options.maxZoom, native: l.options.maxNativeZoom }); });
          return out;
        }));
        await page().evaluate(() => window.__NBD_CALL_REGISTRY.toggleMapLayer());
      }
      const flat = layers.flat();
      expect(flat.length, 'satellite, street, hybrid (2 layers)').toBe(4);
      for (const l of flat) {
        expect(l.maxZoom, `${l.host} maxZoom`).toBe(22);
        expect(l.native, `${l.host} maxNativeZoom`).toBe(/google/.test(l.host) ? 21 : 19);
      }
      const s0 = await st();
      expect(s0.crosshair, 'crosshair mode is OFF until the crosshair screen turns it on (Jo, decision 8)').toBe(false);
      expect(s0.coarse).toBe(true);
      expect(await H.call('setCrosshair', true), 'setCrosshair(true) on a coarse pointer').toBe(true);
      const opts = await page().evaluate(() => ({
        inertia: drawMap.options.inertia, touchZoom: drawMap.options.touchZoom, dbl: drawMap.options.doubleClickZoom,
        dragging: drawMap.dragging.enabled(), dblOn: drawMap.doubleClickZoom.enabled(),
      }));
      expect(opts, 'crosshair map options').toEqual({ inertia: false, touchZoom: 'center', dbl: 'center', dragging: true, dblOn: true });
      expect((await st()).crosshair).toBe(true);
    });

    test('crosshair mode: a one-finger pan adds 0 points and moves the centre; a tap AIMS — 0 points, the spot slides under the crosshair', async () => {
      await fresh('perim');
      const box = await T.mapBox(page());
      const c = await H.centreClient();
      const from = { x: box.x + box.w * 0.7, y: box.y + box.h * 0.3 };
      expect((await T.hitAt(page(), from)).ok, 'pan start is open map').toBe(true);
      const s0 = await T.drawState(page());
      await touch.pan(from, { x: from.x - 40, y: from.y + 150 });
      const s1 = await T.drawState(page());
      expect(s1.dots, 'points after a 155 px pan').toBe(0);
      expect(Math.abs(s1.center.lat - s0.center.lat), 'the pan moved the map').toBeGreaterThan(5e-5);
      // A tap on open map, off-centre.
      const spot = { x: c.x - 80, y: c.y + 70 };
      expect((await T.hitAt(page(), spot)).ok, 'the tap lands on open map').toBe(true);
      const spotLL = await T.client2ll(page(), spot);
      await touch.tap(spot, { settleMs: 700 });
      const s2 = await T.drawState(page());
      expect(s2.dots, 'points after a tap (tap-to-place would add 1)').toBe(0);
      expect((s2.saved && s2.saved.perimPoints || []).length, 'no outline started').toBe(0);
      const now = await T.ll2client(page(), spotLL);
      expect(px(now, await H.centreClient()), 'the tapped spot is under the crosshair (px)').toBeLessThanOrEqual(2);
    });

    test('crosshair mode: a pinch that starts off-centre zooms around the crosshair — the target stays within 2 px, 0 points', async () => {
      await fresh('perim');
      const c = await H.centreClient();
      const target = await H.centreLL();
      const z0 = (await T.drawState(page())).zoom;
      // Out first (z21 → z20: works at the old z21 cap too), fingers up and
      // left of centre; then back in, fingers down and right.
      await touch.pinch({ x: c.x - 70, y: c.y - 90 }, 230, 100, { steps: 12 });
      const s1 = await T.drawState(page());
      expect(s1.zoom, 'the pinch zoomed out').toBeLessThan(z0);
      expect(s1.dots, 'points after a pinch').toBe(0);
      expect(px(await T.ll2client(page(), target), await H.centreClient()), 'the corner under the crosshair before the pinch is still under it (px)').toBeLessThanOrEqual(2);
      await touch.pinch({ x: c.x + 60, y: c.y + 110 }, 90, 230, { steps: 12 });
      const s2 = await T.drawState(page());
      expect(s2.zoom, 'pinched back in').toBeGreaterThan(s1.zoom);
      expect(px(await T.ll2client(page(), target), await H.centreClient()), 'after zooming back in (px)').toBeLessThanOrEqual(2);
      expect(s2.dots).toBe(0);
    });

    test('placeAtReticle after a flick lands on the centre the map stopped at, and the map does not coast', async () => {
      await fresh();
      await H.call('setMode', 'line', { lineType: 0 });
      const c = await H.centreClient();
      const c0 = await H.centreLL();
      await touch.flick({ x: c.x + 70, y: c.y - 20 }, { x: c.x - 150, y: c.y + 30 }, { steps: 3, stepMs: 8 });
      const res = await H.call('placeAtReticle');
      const stopped = await H.centreLL();
      expect(res.ok, `placed (${JSON.stringify(res)})`).toBe(true);
      expect(px(await T.ll2client(page(), res.at), await H.centreClient()), 'the point is on the stopped centre (px)').toBeLessThanOrEqual(1);
      expect(same((await st()).anchor, res.at), 'the Line starts there').toBe(true);
      expect(G.hav(c0, stopped) / G.ftPerPx(c0.lat, WING.zoom), 'the flick moved the map (px)').toBeGreaterThan(100);
      await page().waitForTimeout(700);
      expect(G.hav(stopped, await H.centreLL()) / G.ftPerPx(c0.lat, WING.zoom), 'no inertia coast after the flick (px)').toBeLessThan(0.5);
    });

    test('mid-pan with a finger still down: Add is refused, preview() is hav(anchor, centre) ±0.1 ft, and the committed length equals the last preview', async () => {
      await fresh();
      await H.call('setMode', 'gutter');
      const first = await H.placeAt(at(WING.D, 0, -8));
      expect(first.ok, 'first gutter point').toBe(true);
      const c = await H.centreClient();
      const send = (type, pts) => touch.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 8, radiusY: 8, force: 1 })) });
      const from = { x: c.x + 60, y: c.y - 60 };
      await send('touchStart', [from]);
      for (let i = 1; i <= 20; i++) { await send('touchMove', [{ x: from.x - 7 * i, y: from.y + 2 * i }]); await page().waitForTimeout(16); }
      const mid = await page().evaluate(() => {
        const api = drawMap.nbdDraw;
        const p = api.preview();
        const c2 = drawMap.getCenter();
        return { p, centre: { lat: c2.lat, lng: c2.lng }, place: api.placeAtReticle(), moving: api.state().moving };
      });
      await send('touchEnd', []);
      await page().waitForTimeout(300);
      expect(mid.moving, 'state().moving with a finger on the map').toBe(true);
      expect(mid.place.ok === false && mid.place.reason, 'Add while the finger is still down').toBe('moving');
      expect(mid.p.anchor && same(mid.p.anchor, first.at), 'the preview is anchored on the last point').toBe(true);
      const truth = G.hav(first.at, mid.centre);
      expect(Math.abs(mid.p.segmentFt - truth), `preview ${mid.p.segmentFt.toFixed(3)} vs hav(anchor, centre) ${truth.toFixed(3)} ft`).toBeLessThanOrEqual(0.1);
      expect(mid.p.segmentFt, 'a real segment').toBeGreaterThan(10);
      const res = await H.call('placeAtReticle');
      expect(res.ok, 'Add after the finger lifts').toBe(true);
      const segs = (await saved()).lines.filter((l) => l.type === 10);
      expect(segs.length, 'one gutter segment').toBe(1);
      expect(Math.abs(segs[0].dist - mid.p.segmentFt), 'committed length === last preview').toBeLessThan(1e-6);
    });

    test('same-spot guard: Add within 6 px of the last point is refused — no 0 ft segment', async () => {
      await fresh();
      await H.call('setMode', 'gutter');
      expect((await H.placeAt(WING.D)).ok).toBe(true);
      const again = await H.call('placeAtReticle');
      expect(again.ok === false && again.reason, 'Add on the last point').toBe('same-spot');
      expect((await st()).sameSpot, 'state().sameSpot').toBe(true);
      expect((await st()).canAdd, 'state().canAdd').toBe(false);
      await H.nudge(4, 0);
      const near = await H.call('placeAtReticle');
      expect(near.ok === false && near.reason, 'Add 4 px away').toBe('same-spot');
      expect((await saved()).lines.length, 'no 0 ft segment was made').toBe(0);
      await H.nudge(8, 0);
      const ok = await H.call('placeAtReticle');
      expect(ok.ok, 'Add 12 px away').toBe(true);
      const segs = (await saved()).lines;
      expect(segs.length, 'one short segment').toBe(1);
      expect(segs[0].dist, '~12 px of ground').toBeGreaterThan(1.5);
    });

    test('crosshair outline: each Add commits its edge as the sticky type (no chooser); an Add snapped onto the first corner closes — 1,075 sf', async () => {
      await fresh();
      await H.call('setMode', 'perim');
      const types = [];
      const add = async (ll, edgeType) => {
        const r = await H.placeAt(ll, { edgeType });
        expect(r.ok, `Add (${edgeType}) ${JSON.stringify(r)}`).toBe(true);
        expect((await T.drawState(page())).reChooserVisible, 'no Eave/Rake chooser on a phone').toBe(false);
        types.push(edgeType);
        return r;
      };
      await add(WING.A, 'eave');
      await add(WING.B, 'eave');
      // The sticky type: set once, and an Add with no edgeType uses it.
      expect(await H.call('setEdgeType', 'rake'), 'setEdgeType').toBe(true);
      expect((await st()).edgeType, 'state().edgeType').toBe('rake');
      const rc = await H.placeAt(WING.C);
      expect(rc.ok, 'Add with the sticky Rake').toBe(true);
      expect((await T.drawState(page())).reChooserVisible).toBe(false);
      await add(WING.D, 'eave');
      // Aim 5 px off A: the crosshair snaps onto it, and Add closes.
      await H.centreOn(WING.A);
      await H.nudge(4, -3);
      const s = await st();
      expect(s.closes, 'state().closes with the crosshair snapped onto A').toBe(true);
      expect(same(s.snap, WING.A), 'the snap target is A').toBe(true);
      expect(s.canClose).toBe(true);
      const close = await H.call('placeAtReticle', { edgeType: 'rake' });
      expect(close.ok && close.closed, 'Add on A closed the shape').toBe(true);
      const d = await T.drawState(page());
      expect(d.reChooserVisible).toBe(false);
      expect(d.polys, 'one section').toBe(1);
      expect(d.saved.lines.map((l) => l.type), 'edge types follow the sticky chip: A-B eave, B-C rake, C-D eave, D-A rake').toEqual([5, 4, 5, 4]);
      const base = parseFloat(d.text.base);
      expect(Math.abs(base - WING.expected.appAreaSf) / WING.expected.appAreaSf, `#cr-base ${d.text.base}`).toBeLessThanOrEqual(0.005);
      expect(d.dots, 'four corners, four dots').toBe(4);
    });

    test('shared corners: an Add on an existing corner starts ON it; a second section shares B and C; moveVertex(B) moves every edge and both areas — no tearing; Undo restores', async () => {
      // The wing from the previous test is still drawn (serial).
      const s0 = await st();
      expect(s0.counts.facets, 'the wing is drawn').toBe(1);
      // Lines: aim 4 px off corner D, Add — the line starts exactly on D.
      await H.call('setMode', 'line', { lineType: 0 });
      await H.centreOn(WING.D);
      await H.nudge(3, 3);
      const sn = await H.call('snap');
      expect(sn.snapped && same(sn.latlng, WING.D), 'snap() at the crosshair finds D').toBe(true);
      const v0 = (await st()).counts.vertices;
      const r1 = await H.call('placeAtReticle');
      expect(r1.ok && same(r1.at, WING.D), 'the Line starts exactly on D').toBe(true);
      expect((await st()).counts.vertices, 'vertex count unchanged by a start on a corner').toBe(v0);
      const r2 = await H.placeAt(at(WING.D, 0, -12));
      expect(r2.ok).toBe(true);
      const ln = (await saved()).lines.find((l) => l.type === 0);
      expect(ln && same(ln.p1, WING.D), 'the new Ridge line shares corner D').toBe(true);
      await H.call('undo');
      expect((await saved()).lines.filter((l) => l.type === 0).length, 'Undo took the line back').toBe(0);
      // Section 2, sharing B and C: start on B (snapped), E2, F2, C (snapped), close on B.
      await H.call('setMode', 'perim');
      await H.centreOn(WING.B); await H.nudge(-3, 4);
      const start = await H.call('placeAtReticle', { edgeType: 'eave' });
      expect(start.ok && same(start.at, WING.B), 'section 2 starts exactly on B').toBe(true);
      expect((await st()).counts.vertices, 'no new vertex for a start on B').toBe(4);
      expect((await H.placeAt(E2, { edgeType: 'eave' })).ok).toBe(true);
      expect((await H.placeAt(F2, { edgeType: 'rake' })).ok).toBe(true);
      await H.centreOn(WING.C); await H.nudge(4, 2);
      const onC = await H.call('placeAtReticle', { edgeType: 'eave' });
      expect(onC.ok && same(onC.at, WING.C), 'the outline reaches C exactly').toBe(true);
      await H.centreOn(WING.B); await H.nudge(2, -4);
      const closed = await H.call('placeAtReticle', { edgeType: 'rake' });
      expect(closed.ok && closed.closed, 'section 2 closed on B').toBe(true);
      const before = await saved();
      const d0 = await T.drawState(page());
      expect(before.facets.length, 'two sections').toBe(2);
      expect((await st()).counts.vertices, 'A B C D E F').toBe(6);
      expect(d0.dots, 'one dot per corner').toBe(6);
      // pick() at B: a vertex both sections share.
      const pk = await H.call('pick', WING.B, 16);
      expect(pk && pk.kind, 'pick at B').toBe('vertex');
      expect(same(pk.latlng, WING.B)).toBe(true);
      expect(pk.count, 'four edges meet at B (A-B, B-C, B-E, C-B)').toBe(4);
      expect(pk.facets.length, 'both sections').toBe(2);
      // Move B 3 ft east, 2 ft north.
      const B2 = at(WING.B, 3, 2);
      const mv = await H.call('moveVertex', pk.latlng, B2);
      expect(mv.ok, `moveVertex ${JSON.stringify(mv)}`).toBe(true);
      const after = await saved();
      const d1 = await T.drawState(page());
      const ends = after.lines.flatMap((l) => [l.p1, l.p2]);
      expect(ends.filter((p) => same(p, WING.B)).length, 'no edge left behind on the old B (tearing)').toBe(0);
      expect(ends.filter((p) => same(p, B2)).length, 'all four edge ends moved to the new B').toBe(4);
      after.facets.forEach((f, i) => {
        expect(f.points.some((p) => same(p, B2)), `section ${i + 1} has the new B`).toBe(true);
        expect(Math.abs(f.baseArea - G.shoelace(f.points)), `section ${i + 1} area is its own corners' area`).toBeLessThan(1e-6);
        expect(Math.abs(f.baseArea - before.facets[i].baseArea), `section ${i + 1} area changed`).toBeGreaterThan(5);
      });
      after.lines.forEach((l) => expect(Math.abs(l.dist - G.hav(l.p1, l.p2)), `line ${l.id} dist is hav(p1, p2)`).toBeLessThan(1e-6));
      expect(d1.text.base, '#cr-base = both sections').toBe((after.facets[0].baseArea + after.facets[1].baseArea).toFixed(0) + ' sf');
      expect(d1.dots, 'still one dot per corner').toBe(6);
      await H.call('undo');
      const back = await saved();
      expect(back.lines.map((l) => [l.p1, l.p2, l.dist.toFixed(4)]), 'Undo puts every edge back').toEqual(before.lines.map((l) => [l.p1, l.p2, l.dist.toFixed(4)]));
      expect(back.facets.map((f) => f.baseArea.toFixed(3)), 'and both areas').toEqual(before.facets.map((f) => f.baseArea.toFixed(3)));
    });

    test('in crosshair mode a tap on a length chip, an edge or a corner dot only aims: no point, no popup, no flip', async () => {
      // The two sections from the previous test are still drawn.
      await H.call('setMode', 'perim');
      await T.setView(page(), WING.view, WING.zoom);
      await T.quietToasts(page());
      const before = await T.drawState(page());
      const targets = [];
      const chip = await page().evaluate(() => {
        const box = document.getElementById('drawMap').getBoundingClientRect();
        const el = [...document.querySelectorAll('#drawMap .meas-label')].find((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.left > box.left + 60 && r.right < box.right - 20 && r.top > box.top + 60 && r.bottom < box.bottom - 120;
        });
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      expect(chip, 'a length chip on screen').not.toBeNull();
      targets.push(['a length chip', chip]);
      targets.push(['an edge (C-D, a quarter along)', await T.ll2client(page(), lerp(WING.C, WING.D, 0.25))]);
      targets.push(['a corner dot (D)', await T.ll2client(page(), WING.D)]);
      for (const [name, pt] of targets) {
        await T.setView(page(), WING.view, WING.zoom);
        const ll = await T.client2ll(page(), pt);
        await touch.tap(pt, { settleMs: 700 });
        const s = await T.drawState(page());
        expect(s.dots, `${name}: no point added`).toBe(before.dots);
        expect(s.saved.lines.map((l) => l.type), `${name}: no edge flipped or added`).toEqual(before.saved.lines.map((l) => l.type));
        expect(await page().locator('.leaflet-popup').count(), `${name}: no line popup`).toBe(0);
        expect(page().__dialogLog.filter((m) => /^prompt/.test(m)), `${name}: no length prompt`).toEqual([]);
        expect(px(await T.ll2client(page(), ll), await H.centreClient()), `${name}: aimed (px)`).toBeLessThanOrEqual(2);
      }
    });

    test('the preview band is one reused layer: 50 preview moves leave the layer count unchanged; preview(null) clears it', async () => {
      await fresh();
      await H.call('setMode', 'line', { lineType: 2 });
      expect((await H.placeAt(WING.A)).ok).toBe(true);
      const r = await page().evaluate(async ([a]) => {
        const api = drawMap.nbdDraw;
        const count = () => { let n = 0; drawMap.eachLayer(() => { n++; }); return n; };
        const band = () => { let id = null; drawMap.eachLayer((l) => { if (l instanceof L.Polyline && !(l instanceof L.Polygon) && l.options.dashArray === '6,4') id = L.stamp(l); }); return id; };
        const p0 = api.preview({ lat: a.lat - 0.00003, lng: a.lng + 0.00004 });
        await new Promise((res) => requestAnimationFrame(res));
        const n1 = count(), id1 = band();
        let last = null;
        for (let i = 0; i < 50; i++) {
          last = api.preview({ lat: a.lat - 0.00003 - i * 1e-6, lng: a.lng + 0.00004 + i * 2e-6 });
          await new Promise((res) => requestAnimationFrame(res));
        }
        const n2 = count(), id2 = band();
        api.preview(null);
        const n3 = count(), id3 = band();
        return { p0, last, n1, n2, n3, id1, id2, id3 };
      }, [WING.A]);
      expect(r.p0.segmentFt, 'a live length').toBeGreaterThan(5);
      expect(r.id1, 'the band is on the map').not.toBeNull();
      expect(r.n2, 'layers after 50 preview moves').toBe(r.n1);
      expect(r.id2, 'the same polyline, moved (setLatLngs)').toBe(r.id1);
      expect(r.last.segmentFt).toBeGreaterThan(r.p0.segmentFt);
      expect(r.n3, 'preview(null) removes the band and its chip').toBe(r.n1 - 2);
      expect(r.id3).toBeNull();
    });

    test('wording follows the pointer: "Tap", never "click", on a phone', async () => {
      await fresh();
      const txt = await page().evaluate(() => ({
        perim: (document.getElementById('perimBar') || {}).textContent || '',
        er: (document.getElementById('erBar') || {}).textContent || '',
      }));
      expect(txt.perim, '#perimBar').toMatch(/tap map to trace\. Tap first dot to close\./);
      expect(txt.er, '#erBar').toMatch(/Tap any Eave or Rake line/);
      expect(/click/i.test(txt.perim + txt.er), 'no "click" left').toBe(false);
    });

    test('crosshair off again (the shipped default): map options restored, a tap places a point as before', async () => {
      await fresh();
      expect(await H.call('setCrosshair', false)).toBe(false);
      const opts = await page().evaluate(() => ({ inertia: drawMap.options.inertia, touchZoom: drawMap.options.touchZoom, dbl: drawMap.options.doubleClickZoom }));
      expect(opts, 'Leaflet defaults back').toEqual({ inertia: true, touchZoom: true, dbl: true });
      await T.arm(page(), 'gutter');
      const c = await H.centreClient();
      const spot = { x: c.x - 60, y: c.y + 40 };
      const before = (await T.drawState(page())).dots;
      await touch.tap(spot);
      expect((await T.drawState(page())).dots - before, 'a tap placed one point').toBe(1);
      expect(pageErrors, 'uncaught page errors while drawing').toEqual([]);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Desktop parity: 1280, a mouse. Nothing about the crosshair reaches it.
// ─────────────────────────────────────────────────────────────────────
test.describe.serial('draw seam desktop 1280 @shard3', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  const ctx = { page: null };
  const pageErrors = [];
  const H = helpers(ctx);
  const page = () => ctx.page;

  async function clickLL(ll, name) {
    const pt = await T.ll2client(page(), ll);
    const hit = await T.hitAt(page(), pt);
    expect(hit.ok, `${name} at (${Math.round(pt.x)}, ${Math.round(pt.y)}) is open map, not ${hit.what}`).toBe(true);
    await page().mouse.click(pt.x, pt.y);
    await page().waitForTimeout(200);
    return pt;
  }
  async function quiet() {
    for (let k = 0; k < 8; k++) {
      const close = page().locator('#toastContainer .toast-close').first();
      if (!(await close.count())) return;
      await close.click({ timeout: 2_000 }).catch(() => {});
      await page().waitForTimeout(200);
    }
  }
  async function fresh(mode) {
    await quiet();
    await T.resetDrawing(page());
    await T.setView(page(), WING.view, WING.zoom);
    if (mode) await T.arm(page(), mode);
  }
  // The Eave/Rake chooser, answered with its own buttons.
  async function choose(type) {
    const rc = page().locator('#reChooser');
    await expect(rc, 'the Eave/Rake chooser appears after the edge').toHaveClass(/\bvisible\b/);
    await rc.locator(type === 'rake' ? '.re-btn-rake' : '.re-btn-eave').click();
    await expect(rc).not.toHaveClass(/\bvisible\b/);
  }
  async function trace(pts, types) {
    await clickLL(pts[0], 'corner 1');
    for (let i = 1; i < pts.length; i++) { await clickLL(pts[i], 'corner ' + (i + 1)); await choose(types[(i - 1) % types.length]); }
    await clickLL(pts[0], 'corner 1 again (close)'); await choose(types[(pts.length - 1) % types.length]);
  }
  const saved = async () => (await T.drawState(page())).saved || { lines: [], facets: [] };
  async function stopDrawing() {
    if (/Stop/.test(await page().locator('#drawToggle').textContent())) await page().evaluate(() => window.__NBD_CALL_REGISTRY.toggleDraw());
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await returningUser(context);
    ctx.page = await context.newPage();
    dialogs(page());
    await T.stubTiles(page());
    await stubNetwork(page());
    await loginAs(page(), creds);
    await safeWaitForFunction(page(), () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
    await T.openDraw(page());
    page().on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
  });
  test.afterAll(async () => { if (context) await context.close(); });
  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('desktop: no crosshair on a mouse; click-to-place keeps the Eave/Rake chooser after every edge; "click" wording', async () => {
    const info = await page().evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, toggle: document.querySelectorAll('#drawModeToggle').length }));
    expect(info.coarse).toBe(false);
    expect(info.toggle).toBe(0);
    expect(await H.call('setCrosshair', true), 'setCrosshair(true) is refused on a fine pointer').toBe(false);
    const s = await H.call('state');
    expect(s.crosshair).toBe(false);
    expect(s.coarse).toBe(false);
    await fresh('perim');
    expect(await page().locator('#perimBar').textContent(), '#perimBar says click').toMatch(/click map to trace\. Click first dot to close\./);
    await trace([WING.A, WING.B, WING.C, WING.D], ['eave', 'rake']);
    const d = await T.drawState(page());
    expect(d.polys).toBe(1);
    expect(Math.abs(parseFloat(d.text.base) - WING.expected.appAreaSf) / WING.expected.appAreaSf, `#cr-base ${d.text.base}`).toBeLessThanOrEqual(0.005);
    expect(d.saved.lines.map((l) => l.type), 'the chooser typed each edge').toEqual([5, 4, 5, 4]);
  });

  test('desktop keyboard: D toggles drawing, 3 picks Hip, Z undoes, Shift+Z redoes', async () => {
    // The closed wing from the previous test (serial).
    await page().mouse.move(5, 5); // off any input; the handler listens on document
    const armed0 = (await H.call('state')).armed;
    await page().keyboard.press('d');
    expect((await H.call('state')).armed, 'D').toBe(!armed0);
    await page().keyboard.press('3');
    expect((await H.call('state')).lineType, '3 → Hip').toBe(2);
    expect(await page().locator('.lt-btn').nth(2).getAttribute('class')).toMatch(/\bactive\b/);
    const f0 = (await saved()).facets.length;
    await page().keyboard.press('z');
    expect((await saved()).facets.length, 'Z undid the close').toBe(f0 - 1);
    await page().keyboard.press('Shift+Z');
    expect((await saved()).facets.length, 'Shift+Z redid it').toBe(f0);
  });

  test('desktop Set length: the far end moves as a shared corner — the next edge follows (it used to tear off)', async () => {
    await fresh('perim');
    await trace([WING.A, WING.B, WING.C, WING.D], ['eave', 'rake']);
    await stopDrawing();
    await quiet();
    const before = await saved();
    const ab = before.lines[0];
    // A-B's length chip → prompt → 50 ft.
    page().__promptValue = '50';
    const chip = await page().evaluate(([p1, p2]) => {
      const want = drawMap.latLngToContainerPoint([(p1.lat + p2.lat) / 2, (p1.lng + p2.lng) / 2]);
      const box = drawMap.getContainer().getBoundingClientRect();
      const el = [...document.querySelectorAll('#drawMap .meas-label')].map((e) => ({ e, r: e.getBoundingClientRect() }))
        .sort((a, b) => Math.hypot(a.r.left - box.left - want.x, a.r.top + 10 - box.top - want.y) - Math.hypot(b.r.left - box.left - want.x, b.r.top + 10 - box.top - want.y))[0];
      return el ? { x: el.r.left + el.r.width / 2, y: el.r.top + el.r.height / 2 } : null;
    }, [ab.p1, ab.p2]);
    expect(chip, "A-B's length chip").not.toBeNull();
    await page().mouse.click(chip.x, chip.y);
    await expect.poll(() => page().__dialogLog.filter((m) => /^prompt/.test(m)).length, { message: 'the length prompt opened' }).toBeGreaterThan(0);
    page().__promptValue = null;
    await page().waitForTimeout(300);
    const after = await saved();
    const ab2 = after.lines.find((l) => l.id === ab.id);
    const bc2 = after.lines.find((l) => l.id === before.lines[1].id);
    expect(Math.abs(ab2.dist - 50), `A-B is 50 ft (${ab2.dist.toFixed(3)})`).toBeLessThan(0.05);
    expect(same(bc2.p1, ab2.p2), 'B-C starts on the moved corner (no tearing)').toBe(true);
    expect(after.facets[0].points.some((p) => same(p, ab2.p2)), "the section's corner moved too").toBe(true);
    expect(Math.abs(after.facets[0].baseArea - G.shoelace(after.facets[0].points)), 'area = its corners').toBeLessThan(1e-6);
    expect(after.facets[0].baseArea, 'the section grew').toBeGreaterThan(before.facets[0].baseArea + 20);
    expect((await T.drawState(page())).dots, 'still one dot per corner').toBe(4);
  });

  test('desktop drag from dead-centre: a shared corner moves every line on it (two sections), even with a length chip over the dot; the release opens nothing; Undo restores', async () => {
    await fresh('perim');
    await trace([WING.A, WING.B, WING.C, WING.D], ['eave', 'rake']);
    // Section 2 shares B and C (a click within 12 px joins a corner).
    await trace([WING.B, E2, F2, WING.C], ['eave', 'rake']);
    await stopDrawing();
    await quiet();
    const before = await saved();
    expect(before.facets.length).toBe(2);
    const popups0 = await page().locator('.leaflet-popup').count();
    const b = await T.ll2client(page(), WING.B);
    await page().mouse.move(b.x, b.y);
    await page().mouse.down();
    for (let k = 1; k <= 10; k++) { await page().mouse.move(b.x + 3 * k, b.y + k); await page().waitForTimeout(16); }
    await page().mouse.up();
    await page().waitForTimeout(300);
    const after = await saved();
    const moved = await T.client2ll(page(), { x: b.x + 30, y: b.y + 10 });
    const ends = after.lines.flatMap((l) => [l.p1, l.p2]);
    expect(ends.filter((p) => same(p, WING.B)).length, 'no line left on the old B').toBe(0);
    const newB = after.facets[0].points[1];
    expect(G.hav(newB, moved), 'B followed the mouse (ft)').toBeLessThan(0.5);
    expect(ends.filter((p) => same(p, newB)).length, 'all four line ends moved with B').toBe(4);
    after.facets.forEach((f, i) => expect(Math.abs(f.baseArea - before.facets[i].baseArea), `section ${i + 1} area changed`).toBeGreaterThan(5));
    expect(await page().locator('.leaflet-popup').count(), 'the click after the drag opened no line popup').toBe(popups0);
    await page().evaluate(() => window.undoLine());
    const back = await saved();
    expect(back.lines.map((l) => l.dist.toFixed(3)), 'Undo restores every edge').toEqual(before.lines.map((l) => l.dist.toFixed(3)));
    // A 6 ft line: its length chip (anchored at the midpoint, text to the
    // right) sits over the far dot. The corner still drags from its centre.
    await T.arm(page(), 'line');
    const P = at(WING.view, -30, -25), Q = at(P, 6, 0);
    await clickLL(P, 'short line start'); await clickLL(Q, 'short line end');
    await stopDrawing();
    const q = await T.ll2client(page(), Q);
    const covered = await page().evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('.meas-label, .leaflet-marker-icon')); }, [q.x, q.y]);
    expect(covered, 'precondition: the length chip covers the far dot').toBe(true);
    const n0 = page().__dialogLog.length;
    const s0 = await saved();
    const short0 = s0.lines[s0.lines.length - 1];
    await page().mouse.move(q.x, q.y);
    await page().mouse.down();
    for (let k = 1; k <= 8; k++) { await page().mouse.move(q.x, q.y + 3 * k); await page().waitForTimeout(16); }
    await page().mouse.up();
    await page().waitForTimeout(300);
    const s1 = await saved();
    const short1 = s1.lines.find((l) => l.id === short0.id);
    const dropped = await T.client2ll(page(), { x: q.x, y: q.y + 24 });
    expect(G.hav(short1.p2, short0.p2), 'the covered corner moved (ft; 24 px at z21 is ~4.6 ft)').toBeGreaterThan(3);
    expect(G.hav(short1.p2, dropped), 'to where the mouse let go (ft)').toBeLessThan(0.3);
    expect(page().__dialogLog.length, 'no length prompt from the chip under the pointer').toBe(n0);
  });

  test('desktop mouse preview: 50 moves reuse one band', async () => {
    await fresh('line');
    await clickLL(WING.A, 'line start');
    const a = await T.ll2client(page(), WING.A);
    const band = () => page().evaluate(() => { let id = null, n = 0; drawMap.eachLayer((l) => { n++; if (l instanceof L.Polyline && !(l instanceof L.Polygon) && l.options.dashArray === '6,4') id = L.stamp(l); }); return { id, n }; });
    await page().mouse.move(a.x + 40, a.y + 30);
    await page().waitForTimeout(100);
    const b1 = await band();
    for (let i = 0; i < 50; i++) await page().mouse.move(a.x + 40 + i * 2, a.y + 30 + i);
    await page().waitForTimeout(100);
    const b2 = await band();
    expect(b1.id, 'the band follows the mouse').not.toBeNull();
    expect(b2.id, 'the same polyline').toBe(b1.id);
    expect(b2.n, 'layer count after 50 moves').toBe(b1.n);
    expect(pageErrors, 'uncaught page errors while drawing').toEqual([]);
  });
});
