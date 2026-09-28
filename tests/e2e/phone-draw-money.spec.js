// tests/e2e/phone-draw-money.spec.js — the Drawing Tool's money and
// correctness fixes (draw lane L2, 2026-09-25), driven with a real finger.
//
// Every test here failed on origin/main before L2 (break-tested: the intended
// assertion is the one that reddens — see the PR). What each one pins:
//   B4  closing a section then tapping to start the next saved the first
//       one again: 1,075 sf read 2,150 sf and went to the estimate doubled.
//   B5  a second gutter run chained onto the first with a fake segment
//       (81.8 ft read 122.3 ft, 3 downspouts became 4); now runs end on a
//       tap on the last point, Finish, Enter, Stop or a mode switch.
//   B7  Generate Estimate sent Valley as rake, Rake as wall flashing and
//       Ridge Vent as valley, never sent gutter feet or placed accessories,
//       sent a Flat drawing as the steep 8/12, and "Classic" threw.
//   B3  a single line could not be deleted or retyped (decimal ids vs
//       parseInt), from the popup or the list.
//   B8  an Eave/Rake toggle tap on a closed section's edge did nothing.
//   B9  a close left pending by Clear leaked into the next outline.
//   H6  Undo removed the wrong thing; now it undoes the last action.
//   Structures (Jo decision 3): switching wiped the drawing; now each
//       structure keeps its own drawing and totals, the estimate gets the sum.
//   Ridge vent / parapet (decision 6), slope-corrected rake/hip/valley
//       (decision 7, default ON), downspouts per run, gutter-only estimates
//       behind a "no roof area" acknowledgement, Save to Customer (was
//       throwing on every facet), restore of a legacy autosave, the dead
//       30 ms touch-poll, and ghost labels after Clear.
//
// How it measures — the L1 harness (fixtures/draw-touch.js): CDP touch, a
// stubbed tile PNG, the WING z21 fixture converted to client px at run time,
// and state read from the #cr-* / #gr-* readouts and the localStorage
// autosave. Expected numbers are computed HERE from the geometry (hav on the
// fixture points, the type -> field table spelled out below), not read from
// the page's own module, so the break-test against main is a real oracle.
// The estimate builders are stubbed at window.openEstimateV2Builder (a
// capture), Save/Load at window.addDoc/getDocs — nothing is written to the
// shared Firestore emulator.
//
// @shard2. Phones at 412 and 360 (one login each, serial), desktop 1280 with
// a mouse. Run locally against a served worktree:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//     PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//     npx playwright test --config=playwright.config.js phone-draw-money.spec.js --workers=1
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeWaitForFunction } = require('./fixtures/auth');
const T = require('./fixtures/draw-touch');
const { legacyAutosave } = require('./fixtures/draw-legacy-autosave');
const G = require(path.join(__dirname, '..', '..', 'docs', 'pro', 'js', 'draw-geom.js'));

const { WING } = T;

let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

// ── Geometry (node side — the oracle) ──────────────────────────────
const FT_DEG = G.EARTH_R_FT * Math.PI / 180;
const at = (o, eastFt, northFt) => ({ lat: o.lat + northFt / FT_DEG, lng: o.lng + eastFt / (FT_DEG * Math.cos(o.lat * Math.PI / 180)) });
const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
// Run 2 of the audit: 15.2 ft along the rear eave from A toward B.
const E = lerp(WING.A, WING.B, 15.2 / G.hav(WING.A, WING.B));
// The garage: a 22 x 20 ft rectangle 12 ft south of the wing (440 sf).
const G0 = at(WING.D, 2, -12);
const GARAGE = [G0, at(G0, 22, 0), at(G0, 22, -20), at(G0, 0, -20)];
const GARAGE_VIEW = at(WING.view, 0, -15);
const RISE8 = G.slopeFactors(8); // #pitchSel default 1.202 = 8/12
// Where each LT type must land in the V2 import (audit B7 + Jo decision 6).
// Written out here, not read from draw-geom, so main is judged by it too.
const FIELD = { 0: 'ridgeLf', 2: 'hipLf', 3: 'valleyLf', 4: 'rakeLf', 5: 'eaveLf', 6: 'wallLf', 7: 'wallLf', 9: 'wallLf', 10: 'guttersLf' };
const SLOPE = { 2: RISE8.hipValley, 3: RISE8.hipValley, 4: RISE8.rake };

async function stubNetwork(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
}
async function returningUser(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
      localStorage.removeItem('nbd_draw_slope_lf');
    } catch (e) { /* storage blocked */ }
  });
}
// Native dialogs: accept (clearDraw's confirm, Save's lead confirmation) —
// except when a test asks to dismiss the next one (main's "Classic" = Cancel).
function dialogs(page) {
  page.__dialogLog = [];
  page.__dismissNext = false;
  page.on('dialog', (d) => {
    page.__dialogLog.push(d.message());
    const dismiss = page.__dismissNext;
    page.__dismissNext = false;
    (dismiss ? d.dismiss() : d.accept()).catch(() => {});
  });
}

// One describe per device. `touch` = CDP finger (phones) or null (mouse).
function suite(label, ctxOpts, opts) {
  const phone = !!opts.phone;
  test.describe.serial(`draw money fixes ${label} @shard2`, () => {
    /** @type {import('@playwright/test').BrowserContext} */ let context;
    /** @type {import('@playwright/test').Page} */ let page;
    let touch = null;
    const pageErrors = [];

    async function press(pt, o) {
      if (touch) await touch.tap(pt, o);
      else { await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(250); }
    }
    async function tapLL(ll, name, o) {
      const pt = await T.ll2client(page, ll);
      const hit = await T.hitAt(page, pt);
      expect(hit.ok, `${name} at (${Math.round(pt.x)}, ${Math.round(pt.y)}) is open map, not ${hit.what}`).toBe(true);
      await press(pt, o);
      return pt;
    }
    // Close toasts the way this device can: a finger taps, a mouse clicks.
    async function quiet() {
      if (touch) return T.quietToasts(page);
      for (let k = 0; k < 8; k++) {
        const close = page.locator('#toastContainer .toast-close').first();
        if (!(await close.count())) return;
        await close.click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(250);
      }
    }
    async function chooseEdge(type) {
      if ((await T.drawState(page)).reChooserVisible) await page.evaluate((t) => window.perimChooseType(t), type);
    }
    async function fresh(mode, view, zoom) {
      await quiet();
      await T.resetDrawing(page);
      await page.evaluate(() => {
        const p = document.getElementById('pitchSel'); if (p) { p.value = '1.202'; }
        window.selLT(0, document.querySelectorAll('.lt-btn')[0]); // Line mode draws Ridge unless a test picks
      });
      await T.setView(page, view || WING.view, zoom || WING.zoom);
      await T.arm(page, mode);
    }
    async function trace(pts, types) {
      await tapLL(pts[0], 'corner 1');
      for (let i = 1; i < pts.length; i++) { await tapLL(pts[i], 'corner ' + (i + 1)); await chooseEdge(types[(i - 1) % types.length]); }
      await tapLL(pts[0], 'corner 1 again (close)'); await chooseEdge(types[(pts.length - 1) % types.length]);
    }
    const closeWing = () => trace([WING.A, WING.B, WING.C, WING.D], ['eave', 'rake']);
    async function stubImport() {
      await page.evaluate(() => {
        window.__imports = window.__imports || [];
        // The real opener, kept once for the 'carry' test's real-builder check.
        if (!window.__realOpenV2 && typeof window.openEstimateV2Builder === 'function' && !window.openEstimateV2Builder.__capture) window.__realOpenV2 = window.openEstimateV2Builder;
        const capture = function (opts) { window.__imports.push(JSON.parse(JSON.stringify(opts || {}))); };
        capture.__capture = true;
        window.openEstimateV2Builder = capture;
      });
    }
    // Place n markers of one accessory kind (panel buttons are in the closed
    // phone drawer; its delegate is a document click). `at0` is where the
    // first goes; the rest step 10 ft east.
    async function placeAccessories(kind, n, at0) {
      await page.evaluate((k) => document.querySelector(`#accessoryPanel [data-mr-action="toggleAccessoryMode"][data-mr-id="${k}"]`).click(), kind);
      await quiet();
      for (let j = 0; j < n; j++) await tapLL(at(at0, j * 10, 0), `${kind} ${j + 1}`);
      await page.evaluate((k) => document.querySelector(`#accessoryPanel [data-mr-action="toggleAccessoryMode"][data-mr-id="${k}"]`).click(), kind);
      await quiet();
    }
    // Generate Estimate the way a rep does. The L2 in-page chooser names both
    // builders; main's native confirm is answered by the dialog handler.
    async function generate(builder, o) {
      o = o || {};
      const before = await page.evaluate(() => (window.__imports || []).length);
      if (builder === 'classic') page.__dismissNext = true;
      await page.evaluate(() => { window.importToEstimate(); });
      const chooser = page.locator('#drawEstChooser.open');
      const shown = await chooser.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false);
      page.__dismissNext = false;
      const info = { chooser: shown };
      if (shown) {
        await page.waitForTimeout(350); // .modal scales in; measure it settled
        info.text = await chooser.innerText();
        info.warning = (await chooser.locator('[data-role="est-warning"]').count()) > 0 ? await chooser.locator('[data-role="est-warning"]').innerText() : null;
        info.v2Disabled = await chooser.locator('[data-role="est-v2"]').isDisabled();
        const btns = await chooser.locator('button').evaluateAll((els) => els.map((b) => b.getBoundingClientRect().height));
        info.minButtonH = Math.min(...btns);
        const r = await chooser.locator('.modal').boundingBox();
        info.fits = !!r && r.x >= 0 && r.x + r.width <= (page.viewportSize().width + 0.5);
        if (o.ack) await chooser.locator('#drawEstAck').check();
        const btn = chooser.locator(builder === 'classic' ? '[data-role="est-classic"]' : '[data-role="est-v2"]');
        // Nothing (a toast sits above modals) may cover the button a rep taps.
        const covered = await btn.evaluate((b) => { const r = b.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h && !(h === b || b.contains(h)) ? (h.className || h.tagName) : ''; });
        expect(covered, 'the builder button is not covered').toBe('');
        if (touch) await btn.tap(); else await btn.click();
      }
      if (builder !== 'classic') {
        await expect.poll(() => page.evaluate(() => (window.__imports || []).length), { message: 'the V2 builder received an import' }).toBe(before + 1);
        info.imp = await page.evaluate(() => window.__imports[window.__imports.length - 1].importMeasurements);
      }
      return info;
    }
    const lineSum = (lines, t) => lines.filter((l) => l.type === t).reduce((s, l) => s + l.dist, 0);
    // Each device runs the subset its opts.tests names (the rest are covered
    // on another width, where the code path is the same).
    const only = (key, title, fn) => { if (opts.tests.includes(key)) test(title, fn); };

    test.beforeAll(async ({ browser }, testInfo) => {
      if (!creds) return;
      testInfo.setTimeout(90_000);
      context = await browser.newContext(ctxOpts);
      await returningUser(context);
      page = await context.newPage();
      dialogs(page);
      await T.stubTiles(page);
      await stubNetwork(page);
      await loginAs(page, creds);
      await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
      await T.openDraw(page);
      page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      if (phone) touch = await T.touchSession(page);
    });
    test.afterAll(async () => {
      if (touch) await touch.detach();
      if (context) await context.close();
    });
    test.beforeEach(async ({}, testInfo) => {
      if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
    });

    only('b4', 'B4: after a section closes, the next tap starts the next one — 1,075 sf stays 1,075 sf', async () => {
      await fresh('perim', GARAGE_VIEW);
      await closeWing();
      const s1 = await T.drawState(page);
      expect(Math.abs(parseFloat(s1.text.base) - 1075), `closed wing ${s1.text.base}`).toBeLessThanOrEqual(6);
      await tapLL(GARAGE[0], 'the garage\'s first corner (starts section 2)');
      expect(await page.locator('#facetList .facet-row').count(), 'section rows after one tap on the next section (was "FACET 2 1075 sf")').toBe(1);
      // The next edge recalculates (the double count used to show from here).
      await tapLL(GARAGE[1], 'the garage\'s second corner'); await chooseEdge('eave');
      const s2 = await T.drawState(page);
      expect(s2.text.base, '#cr-base once section 2 has an edge').toBe(s1.text.base);
      expect(s2.text.sq, '#cr-sq').toBe(s1.text.sq);
      expect(s2.saved.facets.length, 'sections saved').toBe(1);
      await stubImport();
      const g = await generate('v2');
      expect(g.imp.rawSqft, 'V2 rawSqft = the one section, pitched').toBe(Math.round(parseFloat(s1.text.pitched)));
    });

    only('ghost', 'Clear leaves no ghost area or angle labels', async () => {
      await fresh('perim');
      await closeWing();
      expect(await page.locator('.facet-area-label').count(), 'the F1 label while the section exists').toBe(1);
      await T.resetDrawing(page);
      const st = await T.drawState(page);
      expect(st.text.base).toBe('0 sf');
      expect(await page.locator('.facet-area-label').count(), '"F1: 1075 sf" after Clear').toBe(0);
      expect(await page.locator('.angle-label-marker').count(), 'angle labels after Clear').toBe(0);
    });

    only('b5', 'B5: two gutter runs — 66.6 + 15.2 = 81.8 ft, 3 downspouts, no bridge; a mode switch never chains', async () => {
      await fresh('gutter');
      await tapLL(WING.D, 'D'); await tapLL(WING.C, 'C'); await tapLL(WING.B, 'B');
      // The autosave holds the run's LAST point too (it used to be written
      // before the push, one point behind).
      expect((await T.drawState(page)).saved.gutterPoints.length, 'autosaved points of the open run D-C-B').toBe(3);
      if (phone) await tapLL(WING.B, 'B again — finishes run 1');
      else { await page.keyboard.press('Enter'); await page.waitForTimeout(200); }
      await quiet();
      await tapLL(WING.A, 'A — starts run 2'); await tapLL(E, 'E, 15.2 ft along the rear eave');
      const st = await T.drawState(page);
      const truth = G.hav(WING.D, WING.C) + G.hav(WING.C, WING.B) + G.hav(WING.A, E);
      expect(Math.abs(parseFloat(st.text.gutter) - truth), `#gr-total ${st.text.gutter} vs the two real runs ${truth.toFixed(1)} ft`).toBeLessThanOrEqual(0.4);
      expect(st.text.gutter).toBe('81.8 ft');
      expect(st.text.ds, '#gr-ds: 2 for the 66.6 ft run + 1 for the 15.2 ft run').toBe('3');
      const segs = st.saved.lines.filter((l) => l.type === 10);
      expect(segs.length, 'gutter segments (no bridge B->A)').toBe(3);
      expect(new Set(segs.map((l) => l.runId)).size, 'two runs').toBe(2);
      // A mode switch ends run 2: the next gutter tap starts a new run.
      await T.arm(page, 'line');
      await T.arm(page, 'gutter');
      const F = at(WING.C, -12, -9), F2 = at(F, 8, 0);
      await tapLL(F, 'a new spot after Lines -> Gutters');
      const s2 = await T.drawState(page);
      expect(s2.saved.lines.filter((l) => l.type === 10).length, 'segments after the mode switch + one tap').toBe(3);
      expect(s2.text.gutter).toBe('81.8 ft');
      // An 8 ft third run: one downspout of its own (Jo, decision 7) —
      // per run 2 + 1 + 1 = 4, where ceil(89.8 / 40) would say 3.
      await tapLL(F2, 'F2, 8 ft on');
      const s3 = await T.drawState(page);
      expect(s3.text.ds, '#gr-ds with a third, 8 ft run').toBe('4');
      expect(Math.abs(parseFloat(s3.text.gutter) - (truth + G.hav(F, F2))), `#gr-total ${s3.text.gutter}`).toBeLessThanOrEqual(0.4);
    });

    only('b7', 'B7: Generate Estimate puts every line type in its own field, slope-corrected, with gutters and accessories', async () => {
      await fresh('line');
      // One line per type, two columns, rows 8 ft apart (clear of labels and
      // the 12px snap). Type t is (10 + t) ft long.
      const types = opts.fullTypes ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 3, 4, 9, 10];
      for (let k = 0; k < types.length; k++) {
        const t = types[k];
        const col = k % 2, row = Math.floor(k / 2);
        const p1 = at(WING.view, col ? 2 : -32, 30 - row * 8);
        await page.evaluate((i) => window.selLT(i, document.querySelectorAll('.lt-btn')[i]), t);
        await tapLL(p1, `type ${t} start`);
        await tapLL(at(p1, 10 + t, 0), `type ${t} end`);
      }
      // Accessories: 2 pipe boots, a chimney, a skylight (panel buttons are in
      // the closed phone drawer; its delegate is a document click).
      // Above the lines, clear of the toast strip over the lower map.
      const accAt = (i) => at(WING.view, -22 + i * 10, 38);
      let i = 0;
      for (const [kind, n] of [['pipe', 2], ['chimney', 1], ['skylight', 1]]) {
        await page.evaluate((k) => document.querySelector(`#accessoryPanel [data-mr-action="toggleAccessoryMode"][data-mr-id="${k}"]`).click(), kind);
        await quiet();
        for (let j = 0; j < n; j++) await tapLL(accAt(i++), `${kind} ${j + 1}`);
        await page.evaluate((k) => document.querySelector(`#accessoryPanel [data-mr-action="toggleAccessoryMode"][data-mr-id="${k}"]`).click(), kind);
      }
      await quiet();
      const st = await T.drawState(page);
      expect(st.saved.lines.length, 'one line per type').toBe(types.length);
      const want = { pitch: 8 };
      for (const t of Object.keys(FIELD).map(Number)) {
        if (!types.includes(t)) continue;
        want[FIELD[t]] = (want[FIELD[t]] || 0) + lineSum(st.saved.lines, t) * (SLOPE[t] || 1);
      }
      Object.keys(want).forEach((k) => { want[k] = Math.round(want[k]); });
      await stubImport();
      const g = await generate('v2', { ack: true });
      const imp = g.imp;
      for (const k of Object.keys(want)) expect(imp[k], `import ${k}`).toBe(want[k]);
      if (types.includes(1)) expect(imp.ridgeLf || 0, 'Ridge Vent is not ridge cap (ridgeLf = Ridge lines only)').toBe(want.ridgeLf || 0);
      expect(imp.pipes, 'pipes').toBe(2);
      expect(imp.chimneys, 'chimneys').toBe(1);
      expect(imp.skylights, 'skylights').toBe(1);
      expect(g.chooser, 'an in-page chooser names both builders').toBe(true);
      // Only eave x rake is area evidence without a closed section (2026-09-27:
      // the old (sum of any lines / 4)^2 guess is gone). The short type list
      // has rake but no eave, so it has no area at all and must say so.
      const footprint = types.includes(5) && types.includes(4);
      expect(g.warning, 'no closed section: the guessed or missing area must be acknowledged')
        .toMatch(footprint ? /estimated/i : /No roof area drawn/i);
      expect(g.text, 'rake shown flat beside sloped').toMatch(/Rake[\s\S]*flat[\s\S]*sloped/);
      expect(g.fits, 'the chooser fits the screen').toBe(true);
      expect(g.minButtonH, 'chooser buttons are finger-sized').toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => !document.getElementById('cr-est-badge').hidden), '"est." beside Base Area only when an area is guessed').toBe(footprint);
      expect(await page.evaluate(() => document.getElementById('lineList').textContent), 'sloped feet beside the flat chips').toMatch(/sloped/);
      // Slope switch OFF -> flat feet; Flat pitch -> 3/12, never the steep 8.
      await page.evaluate(() => { const b = document.getElementById('slopeLfToggle'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); });
      const flat = (await generate('v2', { ack: true })).imp;
      expect(flat.rakeLf, 'slope off: rakeLf flat').toBe(Math.round(lineSum(st.saved.lines, 4)));
      await page.evaluate(() => { const b = document.getElementById('slopeLfToggle'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.evaluate(() => { const p = document.getElementById('pitchSel'); p.value = '1.0'; p.dispatchEvent(new Event('change', { bubbles: true })); });
      const fl = (await generate('v2', { ack: true })).imp;
      expect(fl.pitch, 'a Flat drawing goes as 3/12 (the builder\'s lowest), not the steep 8/12').toBe(3);
      await page.evaluate(() => { const p = document.getElementById('pitchSel'); p.value = '1.202'; p.dispatchEvent(new Event('change', { bubbles: true })); });
    });

    only('gutterOnly', 'Gutter-only drawing: "No roof area drawn" must be acknowledged, then gutters go as guttersLf', async () => {
      await fresh('gutter');
      await tapLL(WING.D, 'D'); await tapLL(WING.C, 'C'); await tapLL(WING.B, 'B');
      // Finish the run and go straight to Generate Estimate: the "Gutter run
      // finished" toast stacks above modals and must not cover the chooser.
      if (phone) await tapLL(WING.B, 'B again — finishes the run');
      await stubImport();
      // (The overlap itself reproduced only in WebKit's iPhone layout — see
      // the PR; here generate() asserts nothing covers the button it taps.)
      const g = await generate('v2', { ack: true });
      expect(g.chooser && g.warning, 'the chooser warns').toMatch(/No roof area drawn/);
      expect(g.v2Disabled, 'V2 is disabled until the rep acknowledges').toBe(true);
      expect(g.imp.guttersLf, 'drawn gutter feet').toBe(Math.round(G.hav(WING.D, WING.C) + G.hav(WING.C, WING.B)));
      expect(g.imp.rawSqft).toBe(0);
    });

    // L2 review (blocking): V2 keeps its state across a close when no lead is
    // attached (and restores its draft for 10 minutes); guttersLf and the
    // marker counts went only when > 0, so job B, with no gutters drawn, was
    // priced with job A's 67 LF instead of its own eave, and kept A's pipes.
    only('carry', 'the next job never inherits the last drawing\'s gutter feet or marker counts (V2, through the real builder)', async () => {
      const gutterTruth = Math.round(G.hav(WING.D, WING.C) + G.hav(WING.C, WING.B));
      // Job A: the wing, gutter D-C-B, 2 pipe boots and a skylight.
      await fresh('perim');
      await closeWing();
      await T.arm(page, 'gutter');
      await tapLL(WING.D, 'D'); await tapLL(WING.C, 'C'); await tapLL(WING.B, 'B');
      await placeAccessories('pipe', 2, at(WING.view, -22, 38));
      await placeAccessories('skylight', 1, at(WING.view, 8, 38));
      await stubImport();
      const a = (await generate('v2')).imp;
      expect(a.guttersLf, 'job A: drawn gutter feet').toBe(gutterTruth);
      expect([a.pipes, a.skylights], 'job A: pipes, skylights').toEqual([2, 1]);
      // Job B: the wing only, at 4/12 (so its import is told apart from A's).
      await fresh('perim');
      await page.evaluate(() => { const p = document.getElementById('pitchSel'); p.value = '1.054'; p.dispatchEvent(new Event('change', { bubbles: true })); });
      await closeWing();
      const gb = await generate('v2');
      const b = gb.imp;
      expect(b.guttersLf, 'job B, no gutters drawn: guttersLf is sent as 0 (the engine then prices from eave), never omitted').toBe(0);
      expect(b.pipes, 'job B: A\'s pipe count is cleared').toBe(0);
      expect(b.skylights, 'job B: A\'s skylight is cleared').toBe(0);
      expect('chimneys' in b, 'a count no drawing set is left alone (a typed / prefilled one survives)').toBe(false);
      expect(gb.text, 'the chooser says the gutters are none drawn').toMatch(/Gutters\s*none drawn/);
      // The same two imports, in order, through the REAL V2 builder (its
      // applyImportedMeasurements merges only the keys it gets). Its draft
      // store is Firestore: those calls are no-ops here, nothing is written.
      const st = await page.evaluate(async ([ia, ib]) => {
        const isDraft = (ref) => !!ref && /estimate_drafts/.test(String((ref && ref.path) || ''));
        const keep = { setDoc: window.setDoc, getDoc: window.getDoc, deleteDoc: window.deleteDoc };
        window.setDoc = function (ref) { return isDraft(ref) ? Promise.resolve() : keep.setDoc.apply(this, arguments); };
        window.getDoc = function (ref) { return isDraft(ref) ? Promise.resolve({ exists: () => false, data: () => null }) : keep.getDoc.apply(this, arguments); };
        window.deleteDoc = function (ref) { return isDraft(ref) ? Promise.resolve() : keep.deleteDoc.apply(this, arguments); };
        try { localStorage.removeItem('nbd_v2_draft_v1'); } catch (e) { /* storage blocked */ }
        const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 100)); } return false; };
        const m = () => window.EstimateV2UI.getState().measurements;
        const open = window.__realOpenV2;
        try {
          open({ importMeasurements: ia });
          const gotA = await until(() => m().guttersLf === ia.guttersLf && m().pitch === ia.pitch, 20000);
          const afterA = gotA ? { guttersLf: m().guttersLf, pipes: m().pipes, skylights: m().skylights } : null;
          window.EstimateV2UI.close();
          await new Promise((r) => setTimeout(r, 400));
          open({ importMeasurements: ib });
          const gotB = await until(() => m().pitch === ib.pitch, 20000);
          const s = window.EstimateV2UI.getState().measurements;
          const input = document.querySelector('#estV2Modal [data-field="guttersLf"]');
          const out = { gotA, afterA, gotB, guttersLf: s.guttersLf, eaveLf: s.eaveLf, pipes: s.pipes, skylights: s.skylights, input: input ? input.value : null };
          window.EstimateV2UI.close();
          return out;
        } finally { Object.assign(window, keep); }
      }, [a, b]);
      expect(st.gotA && st.afterA, 'V2 took job A: ' + JSON.stringify(st)).toEqual({ guttersLf: gutterTruth, pipes: 2, skylights: 1 });
      expect(st.gotB, 'V2 took job B').toBe(true);
      expect(st.guttersLf, `V2 guttersLf after job B (A's ${gutterTruth} LF would price B's gutters)`).toBe(0);
      expect(st.eaveLf, 'V2 eaveLf = job B\'s eave').toBe(b.eaveLf);
      expect([st.pipes, st.skylights], 'V2 pipes, skylights after job B').toEqual([0, 0]);
      expect(st.input, 'the V2 gutter box does not show A\'s feet').not.toBe(String(gutterTruth));
      await quiet();
    });

    only('lineGutter', 'Line mode: a Gutters line drawn on a run\'s end continues that run (one downspout, not two)', async () => {
      await fresh('line');
      await page.evaluate(() => window.selLT(10, document.querySelectorAll('.lt-btn')[10]));
      const p1 = at(WING.view, -20, 20), p2 = at(p1, 18, 0), p3 = at(p2, 0, -14);
      await tapLL(p1, 'gutter 1 start'); await tapLL(p2, 'gutter 1 end');
      await tapLL(p2, 'gutter 2 start, on gutter 1\'s end'); await tapLL(p3, 'gutter 2 end');
      const st = await T.drawState(page);
      const segs = st.saved.lines.filter((l) => l.type === 10);
      expect(segs.length, 'two gutter lines').toBe(2);
      expect(new Set(segs.map((l) => l.runId)).size, 'one run (each Line-mode gutter used to be its own)').toBe(1);
      expect(st.text.ds, '#gr-ds for one 32 ft run').toBe('1');
    });

    only('b3', 'B3: a single line is deleted and retyped from its popup and from the list; ids are integers', async () => {
      await fresh('line');
      const rows = [[0, 30], [2, 22], [3, 14]];
      for (const [t, y] of rows) {
        await page.evaluate((i) => window.selLT(i, document.querySelectorAll('.lt-btn')[i]), t);
        await tapLL(at(WING.view, -20, y), `type ${t} start`); await tapLL(at(WING.view, 4, y), `type ${t} end`);
      }
      let st = await T.drawState(page);
      expect(st.saved.lines.every((l) => Number.isInteger(l.id)), 'line ids are integers: ' + st.saved.lines.map((l) => l.id).join(', ')).toBe(true);
      await page.evaluate(() => window.__NBD_CALL_REGISTRY.toggleDraw()); // Stop
      await tapLL(at(WING.view, -14, 30), 'the Ridge line (popup)');
      const pop = page.locator('.nbd-line-picker-popup');
      await expect(pop, 'the type picker opens').toBeVisible();
      const valleyBtn = pop.locator('[data-mr-action="retypeLine"][data-mr-arg2="3"]');
      if (touch) await valleyBtn.tap(); else await valleyBtn.click();
      st = await T.drawState(page);
      expect(st.saved.lines[0].type, 'popup retype Ridge -> Valley').toBe(3);
      await tapLL(at(WING.view, -14, 22), 'the Hip line (popup)');
      await expect(pop).toBeVisible();
      const del = pop.locator('[data-mr-action="deleteLine"]');
      if (touch) await del.tap(); else await del.click();
      st = await T.drawState(page);
      expect(st.saved.lines.map((l) => l.type), 'popup Delete removed the Hip').toEqual([3, 3]);
      await page.evaluate(() => document.querySelector('#lineList .line-del').click());
      st = await T.drawState(page);
      expect(st.saved.lines.length, 'the list ✕ removed one').toBe(1);
      await page.evaluate(() => document.querySelector('#lineList .line-item').click());
      expect(await page.locator('#lineList .line-item.selected').count(), 'row select').toBe(1);
      await page.evaluate(() => { const s = document.querySelector('#lineList .line-type-sel'); s.value = '4'; s.dispatchEvent(new Event('change', { bubbles: true })); });
      st = await T.drawState(page);
      expect(st.saved.lines[0].type, 'the row\'s type select retypes it').toBe(4);
    });

    only('b8', 'B8: one tap on a closed section\'s edge in Eave/Rake mode flips it exactly once', async () => {
      await fresh('perim');
      await closeWing();
      await quiet();
      await page.evaluate(() => window.setDrawMode('er', document.getElementById('modeERBtn')));
      const before = (await T.drawState(page)).saved.lines[0].type;
      await page.evaluate(() => { window.__toasts = 0; new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (/Toggled to/.test(n.textContent || '')) window.__toasts++; }))).observe(document.body, { childList: true, subtree: true }); });
      await tapLL(lerp(WING.A, WING.B, 0.3), 'the A-B edge, on the line');
      await page.waitForTimeout(300);
      const st = await T.drawState(page);
      expect(st.saved.lines[0].type, 'A-B flipped Eave -> Rake').toBe(before === 5 ? 4 : 5);
      expect(await page.evaluate(() => window.__toasts), 'toggle toasts for one tap').toBe(1);
    });

    only('b9', 'B9: a close left pending by Clear does not leak into the next outline', async () => {
      await fresh('perim');
      await tapLL(WING.A, 'A'); await tapLL(WING.B, 'B'); await chooseEdge('eave');
      await tapLL(WING.C, 'C'); await chooseEdge('rake'); await tapLL(WING.D, 'D'); await chooseEdge('eave');
      await tapLL(WING.A, 'A again (close pending)');
      expect((await T.drawState(page)).reChooserVisible, 'the close waits for Eave/Rake').toBe(true);
      await T.resetDrawing(page);
      await T.arm(page, 'perim');
      await tapLL(WING.A, 'A'); await tapLL(WING.B, 'B'); await chooseEdge('eave');
      const st = await T.drawState(page);
      expect(st.saved.facets.length, 'no section closed by one edge').toBe(0);
      expect(st.polys, 'no polygon').toBe(0);
      expect(st.text.base, 'no area from a 1-point "facet"').toBe('0 sf');
      // One edge meets nothing: any angle label now is a ghost of the Clear.
      expect(await page.locator('.angle-label-marker').count(), 'angle labels left over from before Clear').toBe(0);
    });

    only('undo', 'Undo removes the last action: a pending point first, a pending corner, then edges; runs never re-chain', async () => {
      await fresh('line');
      await tapLL(at(WING.view, -20, 20), 'line start'); await tapLL(at(WING.view, 5, 20), 'line end');
      await tapLL(at(WING.view, -20, 8), 'a second line\'s start (pending)');
      await page.evaluate(() => window.undoLine());
      let st = await T.drawState(page);
      expect(st.saved.lines.length, 'Undo #1 drops the pending point, keeps the finished line').toBe(1);
      expect(st.dots, 'dots after Undo #1').toBe(2);
      await page.evaluate(() => window.undoLine());
      st = await T.drawState(page);
      expect(st.saved.lines.length, 'Undo #2 removes the line').toBe(0);
      await page.evaluate(() => window.__NBD_CALL_REGISTRY.redoLine());
      st = await T.drawState(page);
      expect(st.saved.lines.length, 'Redo brings it back').toBe(1);
      // Perimeter: a corner waiting for Eave/Rake is undone first.
      await T.arm(page, 'perim');
      await tapLL(WING.A, 'A'); await tapLL(WING.B, 'B (pending)');
      await page.evaluate(() => window.undoLine());
      st = await T.drawState(page);
      expect(st.reChooserVisible, 'the chooser closes').toBe(false);
      expect(st.saved.perimPoints.length, 'the outline keeps A').toBe(1);
      await tapLL(WING.B, 'B'); await chooseEdge('eave');
      st = await T.drawState(page);
      expect(st.saved.lines.filter((l) => l.isPerim).length, 'A-B committed').toBe(1);
      await page.evaluate(() => window.undoLine());
      st = await T.drawState(page);
      expect(st.saved.lines.filter((l) => l.isPerim).length, 'Undo removes the A-B edge').toBe(0);
      expect(st.saved.perimPoints.length, '...and keeps A').toBe(1);
      // Gutters: undo inside a new run never re-chains to the finished one.
      await T.arm(page, 'gutter');
      await tapLL(WING.D, 'D'); await tapLL(WING.C, 'C'); await tapLL(WING.B, 'B');
      await page.evaluate(() => window.__NBD_CALL_REGISTRY.finishGutterRun());
      await quiet();
      await tapLL(E, 'E starts run 2');
      await page.evaluate(() => window.undoLine());
      await tapLL(at(WING.A, 0, -6), 'a tap after undoing run 2\'s first point');
      st = await T.drawState(page);
      expect(st.saved.lines.filter((l) => l.type === 10).length, 'still 2 gutter segments — no chain from B').toBe(2);
    });

    only('structures', 'Structures: switching never erases; each keeps its own totals; the estimate gets the sum', async () => {
      await fresh('perim', GARAGE_VIEW);
      await closeWing();
      await page.evaluate(() => window.__NBD_CALL_REGISTRY.addStructure('Garage'));
      await quiet();
      await T.arm(page, 'perim');
      await trace(GARAGE, ['eave', 'rake']);
      await quiet();
      await page.evaluate(() => { const r = document.querySelector('#structureList [data-mr-action="switchStructure"]'); r.click(); });
      const st = await T.drawState(page);
      expect(st.polys, 'both sections still on the map after switching back').toBe(2);
      expect(st.saved.facets.length).toBe(2);
      expect(new Set(st.saved.facets.map((f) => f.structureId)).size, 'one section per structure').toBe(2);
      const wing = G.shoelace([WING.A, WING.B, WING.C, WING.D]), garage = G.shoelace(GARAGE);
      expect(Math.abs(parseFloat(st.text.base) - (wing + garage)), `job #cr-base ${st.text.base} = wing + garage`).toBeLessThanOrEqual(10);
      // Each row: one structure's own numbers (the name is a separate node).
      const rows = await page.evaluate(() => [...document.querySelectorAll('#structureList .structure-row')].map((r) => {
        const t = r.querySelector('.structure-totals');
        return t ? t.textContent : '';
      }));
      const perS = rows.map((r) => { const m = /^(\d+) sf/.exec(r.trim()); return m ? Number(m[1]) : NaN; });
      expect(perS.length, 'each structure shows its own area').toBe(2);
      expect(Math.abs(perS[0] - wing), `structure 1 ${perS[0]} sf`).toBeLessThanOrEqual(6);
      expect(Math.abs(perS[1] - garage), `garage ${perS[1]} sf`).toBeLessThanOrEqual(6);
      await stubImport();
      const g = await generate('v2');
      expect(g.imp.rawSqft, 'the estimate gets the combined pitched area').toBe(Math.round(parseFloat(st.text.pitched)));
      expect(g.text, 'the chooser breaks it down by structure').toMatch(/By structure[\s\S]*Garage/i);
      expect(g.warning, 'both structures are measured: nothing to acknowledge').toBe(null);
      // A third structure with only an eave and a rake line: its area is a
      // guess. The warning names IT and ITS guessed footprint (L2 review: it
      // said "No roof section is closed" and quoted the whole job's area).
      await page.evaluate(() => window.__NBD_CALL_REGISTRY.addStructure('Shed'));
      await quiet();
      await T.arm(page, 'line');
      const s0 = at(WING.view, 8, -30); // east of the garage, clear of its corners
      await page.evaluate(() => window.selLT(5, document.querySelectorAll('.lt-btn')[5]));
      await tapLL(s0, 'shed eave start'); await tapLL(at(s0, 12, 0), 'shed eave end');
      await page.evaluate(() => window.selLT(4, document.querySelectorAll('.lt-btn')[4]));
      await tapLL(at(s0, 16, 0), 'shed rake start'); await tapLL(at(s0, 16, -8), 'shed rake end');
      const s3 = await T.drawState(page);
      const shedLines = s3.saved.lines.filter((l) => !l.isPerim);
      const shedSf = Math.round(lineSum(shedLines, 5) * lineSum(shedLines, 4));
      const g3 = await generate('v2', { ack: true });
      expect(g3.warning, 'the warning names the guessed structure').toMatch(/Shed has no closed section/);
      expect(g3.warning, `...and only its own guessed ${shedSf} sf`).toContain(shedSf + ' sf footprint is guessed');
      expect(g3.warning, 'the measured structures are said to be measured').toMatch(/the rest is measured/);
    });

    only('h4', 'H4: while drawing, a tap ON an existing line places a point (it was swallowed)', async () => {
      await fresh('line');
      const p1 = at(WING.view, -20, 10), p2 = at(WING.view, 10, 10);
      await tapLL(p1, 'line start'); await tapLL(p2, 'line end');
      const s0 = await T.drawState(page);
      await tapLL(lerp(p1, p2, 0.3), 'a point ON the line, 30% along');
      const s1 = await T.drawState(page);
      expect(s1.dots - s0.dots, 'the tap on the line placed a point').toBe(1);
      await tapLL(at(WING.view, -5, -6), 'the new line\'s end');
      const s2 = await T.drawState(page);
      expect(s2.saved.lines.length, 'a second line starts ON the first').toBe(2);
    });

    only('drag', 'drag a shared corner: both edges and the area follow; Undo puts it back', async () => {
      await fresh('perim');
      await closeWing();
      await page.evaluate(() => window.__NBD_CALL_REGISTRY.toggleDraw()); // Stop: dots drag only while not drawing
      const s0 = await T.drawState(page);
      const b = await T.ll2client(page, WING.B);
      await page.mouse.move(b.x, b.y);
      await page.mouse.down();
      for (let k = 1; k <= 10; k++) { await page.mouse.move(b.x + 3 * k, b.y); await page.waitForTimeout(16); }
      await page.mouse.up();
      await page.waitForTimeout(300);
      const s1 = await T.drawState(page);
      expect(parseFloat(s1.text.base), `#cr-base after dragging B 30px east (dead-centre grab): ${s1.text.base}`).toBeGreaterThan(parseFloat(s0.text.base) + 20);
      expect(s1.saved.lines[0].dist, 'A-B grew').toBeGreaterThan(s0.saved.lines[0].dist + 3);
      expect(Math.abs(s1.saved.lines[1].dist - s0.saved.lines[1].dist), 'B-C moved with it (one shared corner)').toBeGreaterThan(0.05);
      await page.evaluate(() => window.undoLine());
      const s2 = await T.drawState(page);
      expect(s2.text.base, 'Undo restores the area').toBe(s0.text.base);
      expect(s2.saved.lines.map((l) => l.dist.toFixed(3)), 'Undo restores every edge').toEqual(s0.saved.lines.map((l) => l.dist.toFixed(3)));
    });

    only('timers', 'the dead 30 ms touch-poll is gone', async () => {
      await fresh('perim');
      await closeWing();
      const s = await T.sampleTimers(page, 1000);
      expect(s.byDelay['30'] || 0, 'setTimeout(…, 30) calls in 1 s with the wing\'s dots on the map').toBeLessThan(5);
    });

    {
      only('saveLoad', 'Save to Customer: names the lead, writes a Firestore-safe v2 doc; Load paints it back', async () => {
        await fresh('perim');
        await closeWing();
        await T.arm(page, 'gutter');
        await tapLL(WING.D, 'D'); await tapLL(WING.C, 'C'); await tapLL(WING.B, 'B');
        const before = await T.drawState(page);
        const docs = await page.evaluate(async () => {
          const keep = {};
          ['addDoc', 'getDocs', 'collection', 'query', 'where', 'orderBy', 'limit'].forEach((k) => { keep[k] = window[k]; });
          const leads = window._leads;
          const saved = [];
          try {
            window.addDoc = async (coll, data) => { saved.push(data); return { id: 'e2e-drawing' }; };
            window.getDocs = async () => ({ size: 0, empty: !saved.length, docs: saved.slice(-1).map((d) => ({ data: () => d })) });
            window.collection = (...a) => ({ path: a.slice(1).join('/') });
            window.query = (c) => c; window.where = () => null; window.orderBy = () => null; window.limit = () => null;
            window._leads = [{ id: 'e2e-lead', firstName: 'Pat', lastName: 'Tester', address: '5520 Wolfpen Pleasant Hill Rd' }];
            document.getElementById('drawSearch').value = '5520 Wolfpen Pleasant Hill Rd';
            await window.__NBD_CALL_REGISTRY.saveDrawingToCustomer();
            const doc = saved[saved.length - 1] || null;
            const undef = [];
            const walk = (v, p) => {
              if (v === undefined) { undef.push(p); return; }
              if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], p + '[' + i + ']'); return; }
              if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) Object.keys(v).forEach((k) => walk(v[k], p + '.' + k));
            };
            walk(doc, 'doc');
            // Load it back onto a cleared canvas.
            window.setDrawMode('line', document.getElementById('modeLineBtn'));
            await window.clearDraw();
            await window.__NBD_CALL_REGISTRY.loadDrawingFromCustomer();
            return { doc: doc && JSON.parse(JSON.stringify(doc, (k, v) => (v === undefined ? '__UNDEFINED__' : v))), undef };
          } finally {
            Object.assign(window, keep);
            window._leads = leads;
          }
        });
        expect(docs.undef, 'no undefined anywhere in the doc (Firestore rejects it — every Save with a section threw)').toEqual([]);
        expect(page.__dialogLog.some((m) => /Save this drawing to Pat Tester/.test(m)), 'the rep confirms the named lead before the write: ' + JSON.stringify(page.__dialogLog.slice(-3))).toBe(true);
        const d = docs.doc;
        expect(d.facets[0].name, 'facets[].name').toBe('Facet 1');
        expect(d.schemaVersion).toBe(2);
        expect(d.gutterLF).toBeCloseTo(G.hav(WING.D, WING.C) + G.hav(WING.C, WING.B), 1);
        expect(d.downspouts).toBe(2);
        ['totalAreaSF', 'pitchedAreaSF', 'withWasteSF', 'squares', 'ridgeLF', 'eaveLF', 'rakeLF', 'hipLF', 'valleyLF'].forEach((k) => expect(typeof d.measurements[k], 'v1 key measurements.' + k).toBe('number'));
        expect(d.lines.every((l) => typeof l.subtype === 'string'), 'lines[].subtype').toBe(true);
        const after = await T.drawState(page);
        await page.evaluate(() => { document.getElementById('drawSearch').value = ''; });
        expect(after.text.base, 'Load reproduces the area').toBe(before.text.base);
        expect(after.text.gutter, 'Load reproduces the gutter feet').toBe(before.text.gutter);
        expect(after.polys, 'Load paints the section').toBe(1);
        expect(await page.evaluate(() => document.getElementById('facetList').textContent), 'Load keeps the section label').toMatch(/Facet 1/);
      });
    }

    {
      only('reload', 'restore: a pre-L2 autosave (decimal ids, a duplicated facet, stacked dots) comes back repaired', async () => {
        const legacy = legacyAutosave();
        legacy.ts = Date.now();
        await page.evaluate((d) => { localStorage.setItem('nbd_draw_default', JSON.stringify(d)); }, legacy);
        await page.reload();
        await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
        await page.evaluate(() => { try { localStorage.setItem('nbd_draw_hint_shown', '1'); } catch (e) {} window.goTo('draw'); });
        await page.waitForFunction(() => typeof drawMap !== 'undefined' && drawMap && typeof window.clearDraw === 'function' && drawMap.getSize().y > 200, null, { timeout: 20_000 });
        await page.waitForTimeout(1700);
        await T.closeDrawer(page);
        if (touch) { await touch.detach(); touch = await T.touchSession(page); }
        const st = await T.drawState(page);
        expect(st.text.base, 'one 40x30 section, not two').toBe('1205 sf');
        expect(st.text.pitched).toBe('1449 sf');
        // The stored autosave is left as it was until the next edit; the live
        // lines (the list rows' ids, which the ✕ / select handlers read) are
        // integers.
        const liveIds = await page.evaluate(() => [...document.querySelectorAll('#lineList .line-item')].map((e) => e.dataset.lineId));
        expect(liveIds.length, 'nine lines restored').toBe(9);
        expect(liveIds.every((id) => /^\d+$/.test(id)), 'ids repaired to integers: ' + liveIds.join(', ')).toBe(true);
        expect(st.dots, 'one dot per corner (29 stacked dots before)').toBe(G.uniqueCorners(legacyAutosave()).vertices.length);
        const labels = await page.evaluate(() => [...document.querySelectorAll('.facet-area-label')].map((e) => e.textContent.trim()));
        expect(labels, 'the area label').toEqual(['F1: 1205 sf']);
        expect(await page.evaluate(() => document.getElementById('facetList').textContent), 'the facet label').toMatch(/Facet 1/);
        await page.evaluate(() => { window.__NBD_CALL_REGISTRY.toggleDraw(); window.__NBD_CALL_REGISTRY.toggleDraw(); }); // leave it idle
      });
    }

    // Last: it navigates to the estimates view.
    only('classic', 'Classic builder: fills its fields (gutters included) and throws nothing', async () => {
      await fresh('perim');
      await closeWing();
      await T.arm(page, 'gutter');
      await tapLL(WING.D, 'D'); await tapLL(WING.C, 'C'); await tapLL(WING.B, 'B');
      const st = await T.drawState(page);
      const errsBefore = pageErrors.length;
      await generate('classic');
      await expect.poll(() => page.evaluate(() => (document.getElementById('estRawSqft') || {}).value || ''), { message: 'the classic form was filled', timeout: 10_000 }).toBe(String(Math.round(parseFloat(st.text.pitched))));
      const f = await page.evaluate(() => ({
        gutter: document.getElementById('estGutterLF').value, pitch: document.getElementById('estPitch').value,
        eave: document.getElementById('estEave').value, raw: (document.getElementById('ec-raw') || {}).textContent,
      }));
      expect(pageErrors.slice(errsBefore), 'page errors (was: ReferenceError updateEstCalc)').toEqual([]);
      expect(f.gutter, 'estGutterLF = drawn gutter feet').toBe(String(Math.round(G.hav(WING.D, WING.C) + G.hav(WING.C, WING.B))));
      expect(f.pitch).toBe('1.0|Flat');
      expect(f.raw, 'updateEstCalc ran').toBe(Math.round(parseFloat(st.text.pitched)) + ' sf');
      // L2 review (blocking): the next drawing, with no gutters, must not
      // keep these feet — startNewEstimateOriginal() never clears the field,
      // and it used to be set only when > 0 ($960.50 on a job with none).
      await T.openDraw(page);
      if (touch) { await touch.detach(); touch = await T.touchSession(page); }
      await fresh('perim');
      await closeWing();
      await page.evaluate(() => { document.getElementById('estRawSqft').value = ''; });
      await generate('classic');
      await expect.poll(() => page.evaluate(() => (document.getElementById('estRawSqft') || {}).value || ''), { message: 'the classic form was filled again', timeout: 10_000 }).toBe(String(Math.round(parseFloat(st.text.pitched))));
      expect(await page.evaluate(() => document.getElementById('estGutterLF').value), 'estGutterLF after a drawing with no gutters (was the previous drawing\'s feet)').toBe('');
      expect(pageErrors, 'uncaught page errors while drawing').toEqual([]);
    });
  });
}

// 412 runs everything; 360 the money paths again at the narrowest width (the
// chooser must fit it); desktop the paths where the mouse differs (Enter to
// finish a run, a click on a line, a dead-centre corner drag) plus the money
// basics. Keeps the file near 3 minutes for @shard2.
suite('412px', T.phoneContextOptions(412), {
  phone: true, fullTypes: true,
  tests: ['b4', 'ghost', 'b5', 'b7', 'gutterOnly', 'carry', 'lineGutter', 'b3', 'b8', 'b9', 'undo', 'structures', 'h4', 'timers', 'saveLoad', 'reload', 'classic'],
});
suite('360px', T.phoneContextOptions(360), {
  phone: true, fullTypes: false,
  tests: ['b4', 'b5', 'b7', 'gutterOnly', 'b8', 'b9', 'structures'],
});
suite('desktop 1280', { viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' }, {
  phone: false, fullTypes: false,
  tests: ['b4', 'b5', 'b7', 'lineGutter', 'h4', 'drag', 'undo'],
});
