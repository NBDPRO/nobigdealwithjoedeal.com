// tests/e2e/phone-draw-crosshair.spec.js — the phone crosshair screen of the
// Drawing Tool (docs/pro/js/draw-reticle.js + css/draw-reticle.css), draw
// lane L4, 2026-09-25.
//
// Jo's decision 4 is the flow under test: a fixed crosshair; Add drops a
// PENDING point there (nothing committed); the rep fine-tunes it by dragging
// it (or nudging the map) while a magnifier shows the imagery around it,
// offset above the finger; Confirm commits it at the crosshair; Cancel
// throws it away. Plus the bar around it: sticky Eave/Rake chips, the snap
// ring and same-spot guard, per-structure totals (decision 3), Undo/Redo,
// Edit's Move/Drop/Flip/Type, and ☰ Tools as an overlay sheet that never
// resizes the map and keeps #1757's installed-app guarantee.
// Added after the L4 review (2026-09-25): toasts clear of the crosshair and
// the pending point; a double tap on Add never commits; landscape (the bar
// docks right); Shadow Pitch through Add; a no-move Drop; no tile-wiping
// view reset on Confirm.
// Release gate (2026-09-25, Jo decision 8): the screen ships OFF behind
// "Crosshair drawing (beta)" in ☰ Tools (localStorage nbd_draw_crosshair).
// The stub blocks and the landscape / Tools checks opt in with an init
// script ('1'); the "beta switch" block and the real-engine block start with
// NO preference and pin the default (no screen, tap-to-place, no seam call),
// the switch itself at every phone layout, live on / off, reload, re-entry,
// and on / off x5 with no leak. The desktop block opts in and still gets
// nothing.
// Gate review (same day): with no preference ☰ Tools is main's drawer (the
// Eave/Rake chooser, Line Type and ✓ Finish run where they were — the
// switch sits below Controls); the switch is reached by a real finger
// dragging the drawer (not scrollIntoView, which scrolls the page); a
// toast's ✕ keeps off ☰ Tools; on / off x5 also checks the screen's timers
// and frame are cancelled; Eave/Rake mode ('er') at switch-on shows Edit and
// hides the drawer's "tap" bars.
//
// How it measures:
//   - The engine seam (drawMap.nbdDraw, draw lane L3) is a TEST-ONLY stub
//     from fixtures/draw-seam-stub.js, injected with addInitScript: it keeps
//     its own model and records every call, with the map centre at each
//     placement. The real engine underneath is never armed.
//   - Real touch: CDP Input.dispatchTouchEvent (fixtures/draw-touch.js) for
//     drags and pans; locator.tap() for buttons; hit-tests with
//     document.elementFromPoint, as phone-dashnav does.
//   - Hermetic: map tiles are the stubbed 256px PNG; geometry is the fixed
//     z21 WING fixture; expected numbers come from docs/pro/js/draw-geom.js
//     required here in node.
//   - 412x860 and 360x640 (the tightest phone: the crosshair must still sit
//     above the bar), plus a 1280 desktop block (mouse, pointer: fine).
//
// One login per viewport (serial). Tagged @shard2 for its CI shard.
// Run locally against a served worktree:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//     PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//     npx playwright test --config=playwright.config.js phone-draw-crosshair.spec.js --workers=1
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeWaitForFunction } = require('./fixtures/auth');
const T = require('./fixtures/draw-touch');
const { installSeamStub } = require('./fixtures/draw-seam-stub');
const G = require(path.join(__dirname, '..', '..', 'docs', 'pro', 'js', 'draw-geom.js'));

const { WING } = T;
const PITCH = 1.202, WASTE = 1.17; // #pitchSel / #wasteSel defaults (the stub's too)

let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

async function stubNetwork(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
}
async function returningUser(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
      localStorage.setItem('nbd_draw_crosshair_coached', '1');
    } catch (e) { /* storage blocked */ }
  });
}
// The screen is an opt-in beta (off by default): the blocks that test the
// screen itself switch it on the way a rep's choice is kept — '1' in
// localStorage — before every load.
const PREF = 'nbd_draw_crosshair';
async function crosshairOn(context) {
  await context.addInitScript((k) => { try { localStorage.setItem(k, '1'); } catch (e) { /* storage blocked */ } }, PREF);
}
// Counts what draw-reticle.js has attached to window and document (by the
// stack at addEventListener time) and the Mutation/ResizeObservers it has
// observing, so an on / off cycle can be checked for leaks. Test-only.
function leakProbeInit() {
  Error.stackTraceLimit = 80;
  const mine = () => (new Error().stack || '').indexOf('draw-reticle.js') !== -1;
  const live = { window: new Map(), document: new Map() };
  const keyOf = (type, opts) => type + '|' + (typeof opts === 'boolean' ? opts : !!(opts && opts.capture));
  const bucketOf = (t) => (t === window ? live.window : t === document ? live.document : null);
  const add = EventTarget.prototype.addEventListener;
  const rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const b = bucketOf(this);
    if (b && fn && mine()) { const k = keyOf(type, opts); if (!b.has(k)) b.set(k, new Set()); b.get(k).add(fn); }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const b = bucketOf(this);
    if (b && fn) { const s = b.get(keyOf(type, opts)); if (s) s.delete(fn); }
    return rem.call(this, type, fn, opts);
  };
  const observers = new Set();
  for (const C of [window.MutationObserver, window.ResizeObserver]) {
    if (!C) continue;
    const obs = C.prototype.observe, disc = C.prototype.disconnect;
    C.prototype.observe = function () { if (mine()) observers.add(this); return obs.apply(this, arguments); };
    C.prototype.disconnect = function () { observers.delete(this); return disc.apply(this, arguments); };
  }
  const count = (m) => { let n = 0; m.forEach((s) => { n += s.size; }); return n; };
  Object.defineProperty(window, '__e2eLeaks', { value: () => ({ window: count(live.window), document: count(live.document), observers: observers.size }) });
  // Timers and frames the SCREEN has pending: the direct caller of
  // setTimeout / requestAnimationFrame is in draw-reticle.js and is not
  // relayout() — the switch's own re-measure after a flip, which outlives a
  // screen on purpose (350 ms). V8 stack: [0] Error, [1] screenCall, [2] the
  // wrapper, then Sentry's own wrapper frames (it wraps both after this
  // script runs), then the caller. (Gate review 2026-09-25: deleting
  // destroy()'s cancelAnimationFrame and clearTimeout lines left every test
  // green.)
  const screenCall = () => {
    const c = (new Error().stack || '').split('\n').slice(3).find((l) => !/sentry/i.test(l)) || '';
    return c.indexOf('draw-reticle.js') !== -1 && !/\brelayout\b/.test(c);
  };
  const pending = { timers: new Set(), frames: new Set() };
  const sT = window.setTimeout, cT = window.clearTimeout, rAF = window.requestAnimationFrame, cAF = window.cancelAnimationFrame;
  window.setTimeout = function (fn, ms) {
    if (typeof fn !== 'function' || !screenCall()) return sT.apply(window, arguments);
    const rest = Array.prototype.slice.call(arguments, 2);
    const id = sT.call(window, function () { pending.timers.delete(id); return fn.apply(this, rest); }, ms);
    pending.timers.add(id);
    return id;
  };
  window.clearTimeout = function (id) { pending.timers.delete(id); return cT.call(window, id); };
  window.requestAnimationFrame = function (fn) {
    if (typeof fn !== 'function' || !screenCall()) return rAF.call(window, fn);
    const id = rAF.call(window, function (t) { pending.frames.delete(id); return fn(t); });
    pending.frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { pending.frames.delete(id); return cAF.call(window, id); };
  Object.defineProperty(window, '__e2ePending', { value: () => ({ timers: pending.timers.size, frames: pending.frames.size }) });
}
// Everything the screen adds to the page outside its own root, and the switch.
async function screenState(page) {
  return page.evaluate((k) => {
    const view = document.getElementById('view-draw');
    const sw = document.getElementById('drawCrosshairSwitch');
    const bs = document.body.style;
    const vars = ['--dr-toast-top', '--dr-toast-left', '--dr-toast-right'].map((v) => bs.getPropertyValue(v))
      .concat([view.style.getPropertyValue('--dr-floor')]).filter(Boolean);
    let pref = null;
    try { pref = localStorage.getItem(k); } catch (e) { pref = 'blocked'; }
    return {
      roots: document.querySelectorAll('.dr-root').length,
      drOn: view.classList.contains('dr-on'),
      barOn: document.body.classList.contains('dr-bar-on'),
      vars,
      pref,
      sw: sw ? { checked: sw.getAttribute('aria-checked'), role: sw.getAttribute('role'), label: (document.getElementById(sw.getAttribute('aria-labelledby')) || {}).textContent || '' } : null,
      switches: document.querySelectorAll('#drawCrosshairSwitch').length,
    };
  }, PREF);
}
const TOOLS = '[data-action="mapSidebar"][data-target="map-sidebar-draw"]';
// Bring the switch into the part of ☰ Tools a thumb can reach — the drawer's
// box, on screen, above the bottom nav — the way a rep does: with `touch`,
// a real finger drags inside the drawer (held still before lifting, so
// nothing flings); without, the drawer itself scrolls. Never the page: the
// first cut used scrollIntoView(), which also scrolls the PAGE, and a
// finger cannot — at 740x360 Tools opens wholly below the screen and a
// swipe on the header or the map leaves the page where it is (gate review,
// 2026-09-25). Returns where the switch ended up.
async function revealSwitch(page, touch) {
  const where = () => page.evaluate(() => {
    const d = document.getElementById('map-sidebar-draw');
    const r = d.getBoundingClientRect();
    const s = document.getElementById('drawCrosshairSwitch').getBoundingClientRect();
    const nav = document.getElementById('mobile-nav');
    const nr = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null;
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, innerHeight, nr && nr.height ? nr.top : Infinity);
    return { top, bottom, x: r.left + r.width / 2, dy: (s.top + s.height / 2) - (top + bottom) / 2, inside: s.top >= top + 4 && s.bottom <= bottom - 4, scrollY };
  });
  let w = await where();
  if (!touch) {
    await page.evaluate((dy) => { document.getElementById('map-sidebar-draw').scrollTop += dy; }, w.dy);
  } else {
    for (let i = 0; i < 10 && !w.inside && w.bottom - w.top > 80; i++) {
      const span = Math.min(Math.abs(w.dy), (w.bottom - w.top) * 0.6);
      const mid = (w.top + w.bottom) / 2, dir = Math.sign(w.dy);
      await touch.pan({ x: w.x, y: mid + dir * span / 2 }, { x: w.x, y: mid - dir * span / 2 }, { steps: 20, stepMs: 16, holdEndMs: 150, settleMs: 300 });
      w = await where();
    }
  }
  await page.waitForTimeout(150);
  return where();
}
// Open / close ☰ Tools with a real tap (no-op if it is already that way).
async function setTools(page, open) {
  const isOpen = await page.evaluate(() => document.getElementById('map-sidebar-draw').classList.contains('open'));
  if (isOpen === open) return;
  await page.locator(TOOLS).tap();
  if (open) await expect(page.locator('#map-sidebar-draw')).toHaveClass(/\bopen\b/);
  else await expect(page.locator('#map-sidebar-draw')).not.toHaveClass(/\bopen\b/);
  await page.waitForTimeout(400); // max-height transition
}
const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const fmtSq = (base) => (base * PITCH * WASTE / 100).toFixed(2);
const fmtSf = (base) => Math.round(base).toLocaleString('en-US');

// Everything the specs read: the crosshair screen's DOM and the stub's log.
async function ui(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const box = (e) => {
      if (!e || e.hidden) return null;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, b: r.bottom, r: r.right };
    };
    const b = (s) => { const e = q(s); return e ? { text: e.textContent.trim(), disabled: e.disabled, hidden: e.hidden } : null; };
    const h = q('.dr-handle');
    const lo = q('.dr-loupe');
    const api = drawMap.nbdDraw;
    const m = drawMap.getContainer().getBoundingClientRect();
    const s = drawMap.getSize();
    return {
      map: { x: m.left, y: m.top, w: m.width, h: m.height, cx: m.left + s.x / 2, cy: m.top + s.y / 2 },
      zoom: drawMap.getZoom(),
      cross: box(q('.dr-cross')), bar: box(q('.dr-bar')), ring: box(q('.dr-snap:not(.dr-pickring)')), pickRing: box(q('.dr-pickring')),
      handle: box(h), handleLL: h && !h.hidden ? { lat: Number(h.dataset.lat), lng: Number(h.dataset.lng) } : null,
      loupe: box(lo), loupeLL: lo && !lo.hidden ? { lat: Number(lo.dataset.lat), lng: Number(lo.dataset.lng), zoom: Number(lo.dataset.zoom) } : null,
      loupeTiles: [...document.querySelectorAll('.dr-loupe img.leaflet-tile')].filter((i) => i.complete && i.naturalWidth > 0).length,
      add: b('[data-dr-act="add"]'), confirm: b('[data-dr-act="confirm"]'), cancel: b('[data-dr-act="cancel"]'), aux: b('[data-dr-act="aux"]'),
      undo: b('[data-dr-act="undo"]'), flip: b('[data-dr-act="flip"]'),
      readMain: q('.dr-read-main').textContent, readSub: q('.dr-read-sub').textContent,
      calls: api.__calls.map((c) => ({ fn: c.fn, args: c.args, centre: c.centre, result: c.result })),
      model: api.__model(),
    };
  });
}
// px between two lat/lngs at the map's current zoom (or `zoom`).
async function pxApart(page, a, b, zoom) {
  return page.evaluate(([a1, b1, z]) => {
    const crs = drawMap.options.crs;
    const zz = z == null ? drawMap.getZoom() : z;
    return crs.latLngToPoint(L.latLng(a1.lat, a1.lng), zz).distanceTo(crs.latLngToPoint(L.latLng(b1.lat, b1.lng), zz));
  }, [a, b, zoom == null ? null : zoom]);
}
const placements = (u) => u.calls.filter((c) => c.fn === 'placeAtReticle');

// What a thumb on `selector` would hit (phone-dashnav's hitTest).
async function hitTest(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, why: 'missing' };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { ok: false, why: '0x0' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { ok: false, why: `off-screen at y=${Math.round(y)}` };
    const h = document.elementFromPoint(x, y);
    const ok = !!h && (h === el || el.contains(h));
    return { ok, why: ok ? 'hit' : `covered by ${h ? h.tagName + '#' + h.id + '.' + String(h.className).split(' ')[0] : 'nothing'}` };
  }, selector);
}
async function expectTappable(page, selector, label) {
  await expect.poll(async () => (await hitTest(page, selector)).why, { message: `${label} (${selector}) is under a thumb`, timeout: 5_000 }).toBe('hit');
}
// Copy the @media(display-mode: standalone) rules to the top level: the
// cascade the INSTALLED app gets (no browser can emulate display-mode). A
// block that is also (max-width:768px) is kept only at that width, so a
// phone on its side (852px) gets what the installed app would.
async function forceStandalone(page) {
  return page.evaluate(() => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        const mq = r.media ? (r.conditionText || r.media.mediaText) : '';
        if (!/display-mode:\s*standalone/.test(mq)) continue;
        if (/max-width:\s*768px/.test(mq) && innerWidth > 768) continue;
        for (const inner of r.cssRules) css += inner.cssText + '\n';
      }
    }
    const s = document.createElement('style');
    s.id = 'e2e-force-standalone';
    s.textContent = css;
    document.head.appendChild(s);
    return css.length;
  });
}

for (const [width, height] of [[412, 860], [360, 640]]) {
  test.describe.serial(`phone draw crosshair ${width}x${height} @shard2`, () => {
    /** @type {import('@playwright/test').BrowserContext} */ let context;
    /** @type {import('@playwright/test').Page} */ let page;
    let touch = null;
    const pageErrors = [];
    const urls = [];
    let bootUrls = [];

    // A real tap, then wait for the click Chromium synthesises from it (it can
    // land after tap() resolves) and for the screen's next frame.
    async function tapSel(sel) {
      await page.evaluate((s) => {
        const e = document.querySelector(s);
        e.dataset.e2eClicked = '0';
        e.addEventListener('click', () => { e.dataset.e2eClicked = '1'; }, { once: true, capture: true });
      }, sel);
      await page.locator(sel).tap();
      await expect.poll(() => page.evaluate((s) => document.querySelector(s).dataset.e2eClicked, sel), { message: `a tap on ${sel} clicks it`, timeout: 3_000 }).toBe('1');
      await nextFrames(page);
    }
    async function mode(name) { await tapSel(`.dr-mode[data-dr-mode="${name}"]`); }
    // Commit a corner exactly at `ll` the way a rep does: crosshair on it,
    // Add, Confirm.
    async function placeAt(ll) {
      await T.setView(page, ll, WING.zoom);
      await tapSel('[data-dr-act="add"]');
      await tapSel('[data-dr-act="confirm"]');
    }
    // Every control on the bar and the side column is under a thumb and
    // finger-sized: 44px chips, 56px action buttons, 44px round buttons.
    async function checkControls(phase) {
      const list = await page.evaluate(() => [...document.querySelectorAll('.dr-bar button, .dr-side button')]
        .filter((e) => !e.hidden && e.offsetParent !== null)
        .map((e) => ({ cls: e.className, label: e.getAttribute('aria-label') || e.textContent.trim(), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })));
      expect(list.length, `${phase}: controls found`).toBeGreaterThan(6);
      for (const c of list) {
        const min = /dr-act/.test(c.cls) ? 56 : 44;
        expect(c.h, `${phase}: "${c.label}" height`).toBeGreaterThanOrEqual(min);
        expect(c.w, `${phase}: "${c.label}" width`).toBeGreaterThanOrEqual(44);
      }
      const n = await page.evaluate(() => {
        document.querySelectorAll('[data-e2e-hit]').forEach((e) => e.removeAttribute('data-e2e-hit'));
        const vis = [...document.querySelectorAll('.dr-bar button, .dr-side button')].filter((e) => !e.hidden && e.offsetParent !== null);
        vis.forEach((e, i) => e.setAttribute('data-e2e-hit', String(i)));
        return vis.length;
      });
      for (let i = 0; i < n; i++) await expectTappable(page, `[data-e2e-hit="${i}"]`, `${phase}: control #${i}`);
    }
    async function confirmReady() {
      await expect.poll(async () => (await ui(page)).confirm.disabled, { message: 'Confirm enabled once the double-tap guard runs out', timeout: 3_000 }).toBe(false);
    }
    async function reset() {
      await page.evaluate(() => drawMap.nbdDraw.__seed({}));
      await page.evaluate(() => { drawMap.nbdDraw.__calls.length = 0; });
      if (!(await ui(page)).cancel.hidden) await tapSel('[data-dr-act="cancel"]');
      await T.setView(page, WING.view, WING.zoom);
    }
    // A finger on the page, held down between calls (CDP touch).
    const finger = {
      down: (p) => touch.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 0, radiusX: 8, radiusY: 8, force: 1 }] }),
      move: (p) => touch.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 0, radiusX: 8, radiusY: 8, force: 1 }] }),
      up: () => touch.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
      async drag(from, to, steps) {
        await finger.down(from);
        for (let i = 1; i <= (steps || 16); i++) {
          await finger.move({ x: from.x + (to.x - from.x) * i / (steps || 16), y: from.y + (to.y - from.y) * i / (steps || 16) });
          await page.waitForTimeout(16);
        }
      },
    };

    test.beforeAll(async ({ browser }, testInfo) => {
      if (!creds) return;
      testInfo.setTimeout(90_000);
      context = await browser.newContext(T.phoneContextOptions(width, height));
      await returningUser(context);
      await crosshairOn(context);
      await installSeamStub(context);
      page = await context.newPage();
      page.on('request', (r) => urls.push(r.url()));
      await T.acceptDialogs(page);
      await T.stubTiles(page);
      await stubNetwork(page);
      await loginAs(page, creds);
      await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
      bootUrls = urls.slice();
      await T.openDraw(page);
      await page.waitForSelector('#view-draw.dr-on .dr-root .dr-bar', { timeout: 10_000 });
      page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      touch = await T.touchSession(page);
      await T.quietToasts(page);
      await T.setView(page, WING.view, WING.zoom);
    });

    test.afterAll(async () => {
      if (touch) await touch.detach();
      if (context) await context.close();
    });

    test.beforeEach(async ({}, testInfo) => {
      if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
    });

    test('lazy: the crosshair files are not fetched at boot, and arrive with the Draw view', async () => {
      const hits = (list, name) => list.filter((u) => u.includes(name)).length;
      expect(hits(bootUrls, 'draw-reticle.js'), 'draw-reticle.js at boot').toBe(0);
      expect(hits(bootUrls, 'draw-reticle.css'), 'draw-reticle.css at boot').toBe(0);
      expect(hits(urls, 'draw-reticle.js'), 'draw-reticle.js with the Draw view').toBeGreaterThan(0);
      expect(hits(urls, 'draw-reticle.css'), 'draw-reticle.css with the Draw view').toBeGreaterThan(0);
      const calls = await page.evaluate(() => drawMap.nbdDraw.__calls.map((c) => c.fn));
      expect(calls, 'the screen switched the engine into crosshair mode').toContain('setCrosshair');
      const s = await screenState(page);
      expect(s.sw && s.sw.checked, 'opted in: the beta switch in ☰ Tools reads on').toBe('true');
    });

    test('layout: the crosshair is the map centre with the map under it, above a bar clear of the nav and attribution', async () => {
      await reset();
      await mode('perim');
      const u = await ui(page);
      expect(Math.abs(u.cross.cx - u.map.cx), 'crosshair x = map centre').toBeLessThanOrEqual(1);
      expect(Math.abs(u.cross.cy - u.map.cy), 'crosshair y = map centre').toBeLessThanOrEqual(1);
      const under = await page.evaluate(([x, y]) => {
        const e = document.elementFromPoint(x, y);
        return { inMap: !!e && document.getElementById('drawMap').contains(e), what: e ? e.tagName + '.' + String(e.className).split(' ')[0] : 'nothing' };
      }, [u.map.cx, u.map.cy]);
      expect(under.inMap, `a finger at the crosshair reaches the map (not ${under.what})`).toBe(true);
      expect(u.cross.b, 'the whole crosshair sits above the bar').toBeLessThan(u.bar.y - 8);
      const chrome = await page.evaluate(() => {
        const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return b.height ? { t: b.top, b: b.bottom, l: b.left, r: b.right } : null; };
        return { nav: r('#mobile-nav'), attrib: r('#drawMap .leaflet-control-attribution'), vw: innerWidth };
      });
      expect(chrome.attrib, 'Leaflet attribution is rendered').not.toBeNull();
      expect(u.bar.b, 'bar bottom vs the attribution strip').toBeLessThanOrEqual(chrome.attrib.t + 0.5);
      // ...and right on it: a floor measured while the view was still
      // sliding in left the bar up to 7px high (L4 fix, 2026-09-25).
      expect(chrome.attrib.t - u.bar.b, 'bar sits just above the attribution strip').toBeLessThanOrEqual(4);
      if (chrome.nav) expect(u.bar.b, 'bar bottom vs the bottom nav').toBeLessThanOrEqual(chrome.nav.t + 0.5);
      expect(u.bar.x, 'bar inside the screen (left)').toBeGreaterThanOrEqual(0);
      expect(u.bar.r, 'bar inside the screen (right)').toBeLessThanOrEqual(chrome.vw);
      expect(u.bar.h, 'bar height cap').toBeLessThanOrEqual(190);

      await T.quietToasts(page);
      await checkControls('aiming');
      await tapSel('[data-dr-act="add"]');
      await checkControls('pending');
      await tapSel('[data-dr-act="cancel"]');
    });

    // 2026-09-25 (L4 review): lifted to just above the bar, a toast sat ON
    // the crosshair at 360x640 and 393x660 — the engine toasts after every
    // close, flip, finish run and empty undo — hiding it and taking the
    // finger meant for the pending point for its 5 s life. On the Draw
    // screen toasts now sit at the top of the map.
    test('a toast clears the crosshair, the pending point, the magnifier and ☰ Tools, and lets a finger through', async () => {
      await reset();
      await mode('perim');
      // Open and close ☰ Tools once: it is relabelled "☰ Tools" (narrower,
      // so further right), the label it had when a toast's ✕ sat on its
      // centre and ate the tap meant for it (gate review, 2026-09-25).
      await setTools(page, true);
      await setTools(page, false);
      await nextFrames(page);
      await T.quietToasts(page);
      await page.evaluate(() => window.showToast('Facet 1 closed — 1075 sf', 'info'));
      await expect(page.locator('#toastContainer .toast')).toHaveCount(1);
      await page.waitForTimeout(300); // slide-in
      const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
      const toastBox = () => page.evaluate(() => {
        const r = document.querySelector('#toastContainer .toast').getBoundingClientRect();
        return { x: r.left, y: r.top, r: r.right, b: r.bottom, h: r.height };
      });
      let u = await ui(page);
      let t = await toastBox();
      expect(overlap(t, u.cross), `toast ${JSON.stringify(t)} vs the crosshair ${JSON.stringify(u.cross)}`).toBe(false);
      expect(overlap(t, u.bar), 'toast vs the bar').toBe(false);
      const at = await T.hitAt(page, { x: u.map.cx, y: u.map.cy });
      expect(at.ok, `a finger at the crosshair reaches the map (${at.what || ''})`).toBe(true);
      await tapSel('[data-dr-act="add"]');
      u = await ui(page);
      t = await toastBox();
      expect(overlap(t, u.handle), 'toast vs the pending point').toBe(false);
      expect(overlap(t, u.loupe), `toast vs the magnifier ${JSON.stringify(u.loupe)}`).toBe(false);
      // Hit-tested once, NOW, not polled: a poll outlasts the toast's 5 s
      // life and passes on a toast that did swallow the tap (break-tested).
      expect((await hitTest(page, '.dr-handle')).why, 'the pending point with a toast up').toBe('hit');
      // The toast body lets taps through to the zoom button it floats over;
      // its ✕ still closes it.
      const under = await page.evaluate(() => {
        const t = document.querySelector('#toastContainer .toast').getBoundingClientRect();
        const z = document.querySelector('#drawMap .leaflet-control-zoom-in').getBoundingClientRect();
        const x = z.left + z.width / 2, y = z.top + z.height / 2;
        return { overlaps: x > t.left && x < t.right && y > t.top && y < t.bottom };
      });
      expect(under.overlaps, 'the toast floats over zoom-in (+) — the case this pins').toBe(true);
      expect((await hitTest(page, '#drawMap .leaflet-control-zoom-in')).why, 'zoom-in (+) under the toast').toBe('hit');
      expect((await hitTest(page, '#toastContainer .toast-close')).why, 'the toast ✕').toBe('hit');
      // ☰ Tools — the way back to the beta switch — is clear of the whole
      // toast, so its ✕ cannot take a tap meant for Tools.
      const tb = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, label: document.querySelector(s).textContent.trim() }; }, TOOLS);
      expect(tb.label, 'Tools relabelled after one open / close').toBe('☰ Tools');
      expect(overlap(await toastBox(), tb), `toast vs ☰ Tools ${JSON.stringify(tb)}`).toBe(false);
      expect((await hitTest(page, TOOLS)).why, '☰ Tools with a toast up').toBe('hit');
      await expect(page.locator('#toastContainer .toast'), 'the toast was up for all four').toHaveCount(1);
      await tapSel('[data-dr-act="cancel"]');
      await T.quietToasts(page);
      await expect(page.locator('#toastContainer .toast')).toHaveCount(0);
    });

    test('Add drops a PENDING point at the crosshair — nothing is committed, the magnifier opens', async () => {
      await reset();
      await mode('perim');
      await tapSel('[data-dr-act="add"]');
      const u = await ui(page);
      expect(u.handle, 'the pending point is on screen').not.toBeNull();
      expect(Math.hypot(u.handle.cx - u.map.cx, u.handle.cy - u.map.cy), 'pending point at the crosshair').toBeLessThanOrEqual(1);
      const centre = await T.client2ll(page, { x: u.map.cx, y: u.map.cy });
      expect(await pxApart(page, u.handleLL, centre), 'pending lat/lng = the crosshair').toBeLessThanOrEqual(1);
      expect(placements(u).length, 'placeAtReticle calls after Add').toBe(0);
      expect(u.model.open.length + u.model.lines.length, 'committed points/edges after Add').toBe(0);
      expect(u.loupe, 'magnifier shows while placing').not.toBeNull();
      expect(u.confirm.hidden || u.cancel.hidden, 'Confirm and Cancel replace Add').toBe(false);
      expect(u.add.hidden, 'Add hides while a point is pending').toBe(true);
      expect(u.confirm.disabled, 'Confirm (in Add\'s slot) waits out a double tap').toBe(true);
    });

    test('drag: the pending point follows the finger, and the magnifier sits above the finger, centred on it', async () => {
      const u0 = await ui(page);
      expect(u0.handle, 'still pending from the previous test').not.toBeNull();
      const from = { x: u0.handle.cx, y: u0.handle.cy };
      const to = { x: from.x + 52, y: from.y + 36 };
      await finger.drag(from, to);
      await nextFrames(page);
      try {
        const u = await ui(page);
        expect(Math.hypot(u.handle.cx - to.x, u.handle.cy - to.y), 'the point is under the finger').toBeLessThanOrEqual(1.5);
        const atHandle = await T.client2ll(page, { x: u.handle.cx, y: u.handle.cy });
        expect(await pxApart(page, u.handleLL, atHandle), 'pending lat/lng = where the point is drawn').toBeLessThanOrEqual(1);
        expect(Math.hypot(u.cross.cx - u.map.cx, u.cross.cy - u.map.cy), 'the crosshair did not move').toBeLessThanOrEqual(1);
        // The magnifier: visible, wholly above the fingertip, over it.
        expect(u.loupe, 'magnifier visible while dragging').not.toBeNull();
        expect(u.loupe.b, 'magnifier bottom clears the fingertip').toBeLessThanOrEqual(to.y - 30);
        expect(Math.abs(u.loupe.cx - to.x), 'magnifier centred over the finger').toBeLessThanOrEqual(2);
        // ...and it magnifies THIS spot: its map is centred on the pending
        // lat/lng (within 2px at its own zoom), two zooms deeper, with tiles.
        expect(u.loupeLL.zoom, 'magnifier zoom = map zoom + 2').toBe(u.zoom + 2);
        expect(await pxApart(page, u.loupeLL, u.handleLL, u.loupeLL.zoom), 'magnifier centre vs the pending point (px at its zoom)').toBeLessThanOrEqual(2);
        await expect.poll(async () => (await ui(page)).loupeTiles, { message: 'magnifier tiles decoded' }).toBeGreaterThan(0);
        expect(placements(u).length, 'dragging commits nothing').toBe(0);
      } finally {
        await finger.up();
      }
      await nextFrames(page);
      const after = await ui(page);
      expect(Math.hypot(after.handle.cx - to.x, after.handle.cy - to.y), 'the point stays where the finger left it').toBeLessThanOrEqual(1.5);
      expect(after.loupe, 'magnifier stays up until Confirm / Cancel').not.toBeNull();
    });

    test('Confirm commits exactly one point where the pending point is — centred under the crosshair first', async () => {
      const u0 = await ui(page);
      const want = u0.handleLL;
      expect(Math.hypot(u0.handle.cx - u0.map.cx, u0.handle.cy - u0.map.cy), 'the point was dragged off the crosshair').toBeGreaterThan(30);
      // 2026-09-25 (L4 review): the recentre was setView({reset:true}), whose
      // viewprereset throws every tile away — the imagery blanked for ~300ms
      // on each adjusted Confirm. It must be a plain pan now.
      await page.evaluate(() => { window.__e2eResets = 0; drawMap.on('viewprereset', () => { window.__e2eResets++; }); });
      await tapSel('[data-dr-act="confirm"]');
      expect(await page.evaluate(() => window.__e2eResets), 'view resets (tile wipes) during Confirm').toBe(0);
      const u = await ui(page);
      const put = placements(u);
      expect(put.length, 'placeAtReticle calls').toBe(1);
      expect(put[0].result && put[0].result.ok, 'the engine accepted it').toBe(true);
      expect(await pxApart(page, put[0].centre, want), 'the map was centred on the pending point when it committed').toBeLessThanOrEqual(1);
      expect(u.model.open.length, 'one corner committed').toBe(1);
      expect(await pxApart(page, u.model.open[0], want), 'the corner is where the pending point was').toBeLessThanOrEqual(1);
      expect(u.handle, 'no pending point after Confirm').toBeNull();
      expect(u.loupe, 'magnifier gone after Confirm').toBeNull();
      expect(u.add.hidden, 'Add is back').toBe(false);
    });

    test('nudge: a pending point that was not dragged rides the crosshair as the map moves; the live length follows; Cancel commits nothing', async () => {
      const u0 = await ui(page);
      const anchor = u0.model.open[0];
      // Confirm left the crosshair ON the new corner: Add is refused there.
      expect(u0.add.disabled, 'Add right after Confirm (same spot)').toBe(true);
      // Pan on open map, well away from the handle and the bar.
      const box = await T.mapBox(page);
      const from = { x: box.x + box.w * 0.25, y: box.y + box.h * 0.22 };
      expect((await T.hitAt(page, from)).ok, 'pan starts on open map').toBe(true);
      await touch.pan(from, { x: from.x - 60, y: from.y + 50 }, { steps: 20, settleMs: 500 });
      await tapSel('[data-dr-act="add"]');
      const start = (await ui(page)).handleLL;
      await touch.pan(from, { x: from.x + 70, y: from.y + 44 }, { steps: 20, settleMs: 500 });
      const u = await ui(page);
      const centre = await T.client2ll(page, { x: u.map.cx, y: u.map.cy });
      expect(await pxApart(page, u.handleLL, centre), 'the pending point is still on the crosshair').toBeLessThanOrEqual(1);
      expect(await pxApart(page, u.handleLL, start), 'and so it moved with the nudge').toBeGreaterThan(60);
      const seg = G.hav(anchor, u.handleLL);
      expect(Math.abs(parseFloat(u.readMain) - seg), `live length "${u.readMain}" vs ${seg.toFixed(2)} ft`).toBeLessThanOrEqual(0.06);
      expect(placements(u).length, 'nudging commits nothing').toBe(1);
      await tapSel('[data-dr-act="cancel"]');
      const c = await ui(page);
      expect(c.handle, 'Cancel removes the pending point').toBeNull();
      expect(placements(c).length, 'Cancel commits nothing').toBe(1);
      expect(c.model.open.length, 'still one corner').toBe(1);
    });

    // 2026-09-25: touch-action:none alone let Chromium turn a drag of the
    // pending point, lifted while still moving, into a fling — and the very
    // next tap (Confirm) was swallowed as the tap that stops a fling: no
    // click at all. The handle now consumes its own touches. The tap must
    // follow the lift at once: extra frames in between let the headless fling
    // finish and hide the bug (measured).
    test('a drag lifted mid-motion does not swallow the next tap (Confirm)', async () => {
      const u0 = await ui(page);
      const box = await T.mapBox(page);
      const from0 = { x: box.x + box.w * 0.3, y: box.y + box.h * 0.2 };
      await touch.pan(from0, { x: from0.x - 50, y: from0.y + 40 }, { steps: 16, settleMs: 450 }); // off the last corner
      await tapSel('[data-dr-act="add"]');
      // Out of the double-tap guard BEFORE the drag, so the tap below still
      // follows the lift at once (tap() would otherwise wait for Confirm).
      await confirmReady();
      const h = (await ui(page)).handle;
      await finger.drag({ x: h.cx, y: h.cy }, { x: h.cx + 52, y: h.cy + 36 }, 16);
      await finger.up();
      await tapSel('[data-dr-act="confirm"]');
      expect(placements(await ui(page)).length, 'Confirm committed the dragged point').toBe(placements(u0).length + 1);
    });

    // 2026-09-25 (L4 review): Add turns into Cancel | Confirm in the same
    // row, with Confirm in Add's slot, so a double tap on Add — or a second
    // tap in glare when the first seemed not to take — committed the point
    // and skipped Jo's adjust step (measured at 120-400 ms gaps). Raw CDP
    // taps here: locator.tap() would wait for Confirm to be enabled.
    test('a double tap on Add leaves the point pending — the second tap does not Confirm it', async () => {
      await reset();
      await mode('perim');
      await T.quietToasts(page);
      const box = await page.locator('[data-dr-act="add"]').boundingBox();
      const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      for (const gap of [120, 250, 400]) {
        const a = (await ui(page)).add;
        expect(a.hidden || a.disabled, `Add ready (gap ${gap} ms)`).toBe(false);
        await finger.down(p); await finger.up();
        await page.waitForTimeout(gap);
        await finger.down(p); await finger.up();
        await page.waitForTimeout(200);
        await nextFrames(page);
        const u = await ui(page);
        expect(u.handle, `second tap ${gap} ms after Add: the first tap made a pending point`).not.toBeNull();
        expect(placements(u).length, `second tap ${gap} ms after Add: nothing committed`).toBe(0);
        await tapSel('[data-dr-act="cancel"]');
        await page.waitForTimeout(350); // not a double tap with the next Add
      }
      await tapSel('[data-dr-act="add"]');
      await confirmReady();
      await tapSel('[data-dr-act="confirm"]');
      expect(placements(await ui(page)).length, 'a deliberate Confirm still commits').toBe(1);
    });

    test('outline: sticky Eave/Rake chips type every edge; same-spot guard; the snap ring closes the shape on corner A', async () => {
      await reset();
      await mode('perim');
      await placeAt(WING.A);
      // Crosshair right on the last point: Add is refused, and says why.
      let u = await ui(page);
      expect(u.add.disabled, 'Add on the last point').toBe(true);
      expect(u.readMain, 'readout explains').toMatch(/On the last point/);
      // ...and a pending point dragged back onto it cannot be confirmed.
      const a0 = await T.ll2client(page, WING.A);
      await page.evaluate(([x, y]) => { const r = drawMap.getContainer().getBoundingClientRect(); drawMap.setView(drawMap.containerPointToLatLng([x - r.left, y - r.top]), drawMap.getZoom(), { animate: false }); }, [a0.x + 60, a0.y + 40]);
      await page.waitForTimeout(250);
      await tapSel('[data-dr-act="add"]');
      const h0 = (await ui(page)).handle;
      const onA = await T.ll2client(page, WING.A);
      await finger.drag({ x: h0.cx, y: h0.cy }, { x: onA.x + 3, y: onA.y + 2 }, 12);
      await finger.up();
      await nextFrames(page);
      u = await ui(page);
      expect(u.confirm.disabled, 'Confirm with the pending point on the last point').toBe(true);
      expect(u.readMain, 'readout explains').toMatch(/Same spot/);
      await tapSel('[data-dr-act="cancel"]');
      expect(placements(await ui(page)).length, 'still only corner A').toBe(1);
      await tapSel('.dr-edge[data-dr-edge="rake"]');
      await placeAt(WING.B);
      await placeAt(WING.C);
      await tapSel('.dr-edge[data-dr-edge="eave"]');
      await placeAt(WING.D);
      // 8px off corner A: the ring lights on A, and Add / Confirm say Close.
      const a = await T.ll2client(page, WING.A);
      await page.evaluate(([x, y]) => { const r = drawMap.getContainer().getBoundingClientRect(); drawMap.setView(drawMap.containerPointToLatLng([x - r.left, y - r.top]), drawMap.getZoom(), { animate: false }); }, [a.x + 6, a.y - 5]);
      await page.waitForTimeout(250);
      await nextFrames(page);
      u = await ui(page);
      expect(u.ring, 'snap ring shows').not.toBeNull();
      const ringOn = await T.ll2client(page, WING.A);
      expect(Math.hypot(u.ring.cx - ringOn.x, u.ring.cy - ringOn.y), 'snap ring on corner A').toBeLessThanOrEqual(1);
      expect(u.add.text, 'Add says Close').toBe('Close');
      await tapSel('[data-dr-act="add"]');
      expect((await ui(page)).confirm.text).toMatch(/Confirm close/);
      await tapSel('[data-dr-act="confirm"]');
      u = await ui(page);
      const put = placements(u);
      expect(put.length, 'five placements (A B C D, close on A)').toBe(5);
      expect(put.map((p) => p.args && p.args.edgeType), 'edge type sent with each placement').toEqual(['eave', 'rake', 'rake', 'eave', 'eave']);
      expect(await pxApart(page, put[4].centre, u.model.facets[0].points[0]), 'the close was centred ON corner A, not 8px off it').toBeLessThanOrEqual(0.75);
      expect(u.model.facets.length, 'one closed facet').toBe(1);
      expect(u.model.lines.map((l) => l.type), 'edges typed by the sticky chips: rake, rake, eave, eave').toEqual([4, 4, 5, 5]);
      const base = G.shoelace(u.model.facets[0].points);
      expect(Math.abs(base - WING.expected.appAreaSf) / WING.expected.appAreaSf, 'the wing traced by crosshair').toBeLessThanOrEqual(0.005);
      expect(u.readMain, 'bar: this structure').toBe(`Structure 1 · ${fmtSf(base)} sf · ${fmtSq(base)} sq`);
    });

    test('totals: every structure on the bar (Jo decision 3) — sq per structure and the job; gutters per structure', async () => {
      const wing = [WING.A, WING.B, WING.C, WING.D];
      const FT_DEG = G.EARTH_R_FT * Math.PI / 180;
      const at = (o, e, n) => ({ lat: o.lat + n / FT_DEG, lng: o.lng + e / (FT_DEG * Math.cos(o.lat * Math.PI / 180)) });
      const g0 = at(WING.D, 2, -12);
      const garage = [g0, at(g0, 22, 0), at(g0, 22, -20), at(g0, 0, -20)];
      const wingSf = G.shoelace(wing), garageSf = G.shoelace(garage);
      const run = [WING.D, WING.C, WING.B];
      const seg = (i) => ({ id: 10 + i, type: 10, name: 'Gutters', color: '#06B6D4', p1: run[i], p2: run[i + 1], dist: G.hav(run[i], run[i + 1]), runId: 1, structureId: 1 });
      const gutterLf = seg(0).dist + seg(1).dist;
      await page.evaluate((m) => drawMap.nbdDraw.__seed(m), {
        mode: 'perim', structures: [{ id: 1, name: 'House' }, { id: 2, name: 'Garage' }], structureId: 1,
        facets: [
          { id: 1, points: wing, closed: true, baseArea: wingSf, pitch: PITCH, structureId: 1 },
          { id: 2, points: garage, closed: true, baseArea: garageSf, pitch: PITCH, structureId: 2 },
        ],
        lines: [seg(0), seg(1)], nextId: 20,
      });
      await nextFrames(page);
      let u = await ui(page);
      expect(u.readMain, 'Outline: the active structure').toBe(`House · ${fmtSf(wingSf)} sf · ${fmtSq(wingSf)} sq`);
      expect(u.readSub, 'every structure, then the job').toBe(`House ${fmtSq(wingSf)} sq · Garage ${fmtSq(garageSf)} sq · Job ${fmtSq(wingSf + garageSf)} sq`);
      await mode('gutter');
      u = await ui(page);
      expect(u.readMain, 'Gutters: the active structure\'s LF and downspouts').toBe(`House · ${gutterLf.toFixed(1)} ft · ${Math.ceil(gutterLf / 40)} downspouts`);
    });

    test('edit: aim at a shared corner, Move, drag, Drop moves it on both edges; Flip, Type and Undo/Redo go through the seam', async () => {
      const pts = [WING.A, WING.B, WING.C, WING.D];
      const types = [5, 4, 5, 4];
      const lines = pts.map((p, i) => ({ id: i + 1, type: types[i], name: types[i] === 4 ? 'Rake' : 'Eave', color: '#BE185D', p1: p, p2: pts[(i + 1) % 4], dist: G.hav(p, pts[(i + 1) % 4]), structureId: 1, facetId: 1 }));
      await page.evaluate((m) => drawMap.nbdDraw.__seed(m), {
        facets: [{ id: 1, points: pts, closed: true, baseArea: G.shoelace(pts), pitch: PITCH, structureId: 1 }], lines, nextId: 5,
      });
      await mode('edit');
      await T.setView(page, WING.B, WING.zoom);
      let u = await ui(page);
      expect(u.pickRing, 'the corner under the crosshair is picked').not.toBeNull();
      expect(u.add.text, 'Add becomes Move corner').toBe('Move corner');
      expect(u.add.disabled).toBe(false);
      await tapSel('[data-dr-act="add"]');
      u = await ui(page);
      const from = { x: u.handle.cx, y: u.handle.cy };
      const to = { x: from.x + 52, y: from.y + 36 };
      await finger.drag(from, to, 16);
      await finger.up();
      await nextFrames(page);
      u = await ui(page);
      const dropped = u.handleLL;
      expect(u.confirm.text, 'Confirm reads Drop').toMatch(/Drop/);
      await tapSel('[data-dr-act="confirm"]');
      u = await ui(page);
      const mv = u.calls.filter((c) => c.fn === 'moveVertex');
      expect(mv.length, 'one moveVertex').toBe(1);
      expect(await pxApart(page, mv[0].args[0], WING.B), 'from = corner B').toBeLessThanOrEqual(0.5);
      expect(await pxApart(page, mv[0].args[1], dropped), 'to = where it was dropped').toBeLessThanOrEqual(0.5);
      const ab = u.model.lines.find((l) => l.id === 1), bc = u.model.lines.find((l) => l.id === 2);
      expect(await pxApart(page, ab.p2, dropped), 'A-B follows the corner').toBeLessThanOrEqual(0.5);
      expect(await pxApart(page, bc.p1, dropped), 'B-C follows the corner').toBeLessThanOrEqual(0.5);

      // An edge: the middle of C-D (an Eave). Flip -> Rake; Type -> Valley.
      const midCD = { lat: (WING.C.lat + WING.D.lat) / 2, lng: (WING.C.lng + WING.D.lng) / 2 };
      await T.setView(page, midCD, WING.zoom);
      await nextFrames(page);
      u = await ui(page);
      expect(u.readMain, 'the picked edge is named with its length').toMatch(/^Eave · \d+\.\d ft$/);
      await tapSel('[data-dr-act="flip"]');
      u = await ui(page);
      expect(u.calls.filter((c) => c.fn === 'flip').map((c) => c.args[0]), 'flip(id of C-D)').toEqual([3]);
      expect(u.model.lines.find((l) => l.id === 3).type, 'C-D is a Rake now').toBe(4);
      await tapSel('[data-dr-act="undo"]');
      expect((await ui(page)).model.lines.find((l) => l.id === 3).type, 'Undo puts the Eave back').toBe(5);
      await tapSel('[data-dr-act="redo"]');
      expect((await ui(page)).model.lines.find((l) => l.id === 3).type, 'Redo flips it again').toBe(4);
      await tapSel('[data-dr-act="type"]');
      await tapSel('.dr-typechip[data-dr-lt="3"]');
      u = await ui(page);
      expect(u.calls.filter((c) => c.fn === 'retype').map((c) => c.args), 'retype(id, Valley)').toEqual([[3, 3]]);
      expect(u.model.lines.find((l) => l.id === 3).name).toBe('Valley');
    });

    // 2026-09-25 (L4 review): the real engine refuses a Drop where the corner
    // already is ('no-move'); the screen only told the screen reader, and
    // the rep was stranded on "Moving corner — drag it, then Drop" with a
    // Drop that did nothing. (The stub accepted it then; it refuses now.)
    test('edit: Drop without moving the corner puts it back and says so — the rep is never stranded on "Moving corner"', async () => {
      const pts = [WING.A, WING.B, WING.C, WING.D];
      const lines = pts.map((p, i) => ({ id: i + 1, type: 5, name: 'Eave', color: '#BE185D', p1: p, p2: pts[(i + 1) % 4], dist: G.hav(p, pts[(i + 1) % 4]), structureId: 1, facetId: 1 }));
      await page.evaluate((m) => drawMap.nbdDraw.__seed(m), {
        facets: [{ id: 1, points: pts, closed: true, baseArea: G.shoelace(pts), pitch: PITCH, structureId: 1 }], lines, nextId: 5,
      });
      await page.evaluate(() => { drawMap.nbdDraw.__calls.length = 0; });
      await mode('edit');
      await T.setView(page, WING.B, WING.zoom);
      await tapSel('[data-dr-act="add"]');
      let u = await ui(page);
      expect(u.confirm.text, 'Move corner is pending').toMatch(/Drop/);
      await tapSel('[data-dr-act="confirm"]');
      u = await ui(page);
      expect(u.handle, 'no pending corner after the Drop').toBeNull();
      expect(u.add.hidden, 'Move corner is back on the bar').toBe(false);
      expect(u.readMain, 'the readout says what happened').toBe('Corner left where it was');
      expect(u.calls.filter((c) => c.fn === 'moveVertex' && c.result && c.result.ok).length, 'nothing moved').toBe(0);
      expect(await pxApart(page, u.model.lines.find((l) => l.id === 1).p2, WING.B), 'corner B is where it was').toBeLessThanOrEqual(0.01);
    });

    // 2026-09-25 (L4 review): in crosshair mode a real tap only aims, so the
    // drawer's Shadow Pitch (two points along a shadow, two along the roof
    // edge) had no way to place a point on phones. Add now places them.
    test('Shadow Pitch works through the crosshair: Add places each of its four points, unsnapped, with its own labels', async () => {
      const btn = await page.evaluate(() => { const b = document.querySelector('#map-sidebar-draw [data-fn="startShadowPitch"]'); return b ? getComputedStyle(b).display : 'missing'; });
      expect(['none', 'missing'], `Shadow Pitch stays in ☰ Tools on phones (display ${btn})`).not.toContain(btn);
      await reset();
      await mode('perim');
      await placeAt(WING.A);
      await placeAt(WING.B);
      await page.evaluate(() => { const api = drawMap.nbdDraw; const m = api.__model(); m.shadow = 'shadow'; api.__seed(m); api.__calls.length = 0; });
      // 8 px off corner B, the last corner: Outline would snap onto B and
      // refuse the same spot. A shadow point does neither.
      const b = await T.ll2client(page, WING.B);
      await page.evaluate(([x, y]) => { const r = drawMap.getContainer().getBoundingClientRect(); drawMap.setView(drawMap.containerPointToLatLng([x - r.left, y - r.top]), drawMap.getZoom(), { animate: false }); }, [b.x + 6, b.y - 5]);
      await page.waitForTimeout(250);
      await nextFrames(page);
      let u = await ui(page);
      expect(u.add.text, 'Add names the step').toBe('Place shadow point');
      expect(u.readMain, 'the readout names the step').toMatch(/^Shadow Pitch 1\/2/);
      expect(u.add.disabled, 'Add is live beside the last corner').toBe(false);
      expect(u.ring, 'no snap ring for a shadow point').toBeNull();
      expect(await page.locator('.dr-edge[data-dr-edge="eave"]').isHidden(), 'no Eave / Rake chips').toBe(true);
      const centre = await T.client2ll(page, { x: u.map.cx, y: u.map.cy });
      await tapSel('[data-dr-act="add"]');
      await confirmReady();
      await tapSel('[data-dr-act="confirm"]');
      u = await ui(page);
      expect(placements(u).map((c) => c.args), 'placed unsnapped').toEqual([{ snap: false }]);
      expect(await pxApart(page, u.model.shadowPts[0], centre), 'the point is where the crosshair was').toBeLessThanOrEqual(0.75);
      expect(await pxApart(page, u.model.shadowPts[0], WING.B), '... not pulled onto corner B').toBeGreaterThan(5);
      await placeAt(WING.C);
      u = await ui(page);
      expect(u.add.text, 'step 2').toBe('Place roof-edge point');
      expect(u.readMain).toMatch(/^Shadow Pitch 2\/2/);
      await placeAt(WING.D);
      await placeAt({ lat: (WING.A.lat + WING.C.lat) / 2, lng: (WING.A.lng + WING.C.lng) / 2 });
      u = await ui(page);
      expect(u.calls.map((c) => c.fn), 'the engine estimated the pitch').toContain('shadow-estimated');
      expect(placements(u).length, 'four Shadow Pitch placements').toBe(4);
      expect(u.add.text, 'back to the outline').toBe('Add corner');
      expect(u.model.open.length, 'the outline was not touched').toBe(2);
    });

    if (width === 412) {
      // 2026-09-25 (L4 review): the installed app rotates (manifest
      // orientation "any"), and on its side the 174px bar across the bottom
      // covered the crosshair outright, while the desktop's 280px Tools
      // column came back and shrank the map. The bar docks right instead.
      test('landscape: the bar docks right, clear of the crosshair; Add / Confirm, ☰ Tools and toasts work on a phone on its side', async () => {
        await reset();
        await mode('perim');
        await T.quietToasts(page);
        const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
        const boxOf = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left, y: r.top, r: r.right, b: r.bottom } : null; }, sel);
        let placed = 0;
        try {
          for (const [w, h] of [[852, 393], [740, 360]]) {
            const tag = `${w}x${h}`;
            await page.setViewportSize({ width: w, height: h });
            await page.waitForTimeout(700);
            await T.setView(page, WING.view, WING.zoom);
            await nextFrames(page);
            const u = await ui(page);
            expect(Math.hypot(u.cross.cx - u.map.cx, u.cross.cy - u.map.cy), `${tag}: crosshair = map centre`).toBeLessThanOrEqual(1);
            expect(overlap(u.bar, u.cross), `${tag}: bar ${JSON.stringify(u.bar)} vs crosshair ${JSON.stringify(u.cross)}`).toBe(false);
            expect(overlap(await boxOf('.dr-side'), u.cross), `${tag}: side buttons vs crosshair`).toBe(false);
            const hit = await T.hitAt(page, { x: u.map.cx, y: u.map.cy });
            expect(hit.ok, `${tag}: a finger at the crosshair reaches the map (${hit.what})`).toBe(true);
            expect(u.bar.r, `${tag}: bar inside the screen`).toBeLessThanOrEqual(w);
            if (w === 852) await checkControls(`${tag} aiming`);
            else for (const s of ['.dr-mode[data-dr-mode="line"]', '.dr-read', '[data-dr-act="add"]']) await expectTappable(page, s, `${tag}: ${s}`);
            await tapSel('[data-dr-act="add"]');
            const p = await ui(page);
            expect(overlap(p.bar, p.handle), `${tag}: bar vs the pending point`).toBe(false);
            expect(overlap(p.bar, p.loupe), `${tag}: bar vs the magnifier ${JSON.stringify(p.loupe)}`).toBe(false);
            expect(p.loupe.y >= p.map.y - 0.5 && p.loupe.x >= -0.5 && p.loupe.b <= p.map.y + p.map.h + 0.5, `${tag}: magnifier on the map`).toBe(true);
            await expectTappable(page, '.dr-handle', `${tag}: the pending point`);
            await expectTappable(page, '[data-dr-act="confirm"]', `${tag}: Confirm`);
            await tapSel('[data-dr-act="confirm"]');
            placed += 1;
            expect(placements(await ui(page)).length, `${tag}: Add, Confirm commits`).toBe(placed);
            await tapSel('[data-dr-act="undo"]');
          }
          // 852x393: ☰ Tools overlays (the desktop column would shrink the map), with Lines / Gutters under a thumb; a toast clears the crosshair and the bar.
          await page.setViewportSize({ width: 852, height: 393 });
          await page.waitForTimeout(700);
          // The installed app on its side gets the DESKTOP standalone rules
          // (over 768px): the view pinned to 100dvh-60px, the map to
          // 100dvh-120px, the body padded 80px. The map overran its clipped
          // view and cut Cancel / Confirm in half (WebKit, L4 fix).
          expect(await forceStandalone(page), '852x393: standalone rules found').toBeGreaterThan(200);
          try {
            await page.evaluate(() => window.dispatchEvent(new Event('resize')));
            await page.waitForTimeout(700);
            const fit = await page.evaluate(() => {
              const v = document.getElementById('view-draw').getBoundingClientRect();
              const m = drawMap.getContainer().getBoundingClientRect();
              const b = document.querySelector('.dr-bar').getBoundingClientRect();
              return { viewB: v.bottom, mapB: m.bottom, barB: b.bottom, vh: innerHeight };
            });
            expect(fit.mapB, `852x393 installed: the map ends inside its view ${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.viewB + 0.5);
            expect(fit.barB, '852x393 installed: the bar ends inside the view').toBeLessThanOrEqual(fit.viewB + 0.5);
            const cu = await ui(page);
            expect(overlap(cu.bar, cu.cross), '852x393 installed: bar vs crosshair').toBe(false);
            await expectTappable(page, '[data-dr-act="add"]', '852x393 installed: Add');
            await expectTappable(page, '[data-dr-act="undo"]', '852x393 installed: Undo');
          } finally {
            await page.evaluate(() => { const st = document.getElementById('e2e-force-standalone'); if (st) st.remove(); window.dispatchEvent(new Event('resize')); });
            await page.waitForTimeout(500);
          }
          const tools = '[data-action="mapSidebar"][data-target="map-sidebar-draw"]';
          const before = await T.mapBox(page);
          await expectTappable(page, tools, '852x393: ☰ Draw Tools');
          await page.locator(tools).tap();
          await expect(page.locator('#map-sidebar-draw')).toHaveClass(/\bopen\b/);
          await page.waitForTimeout(400);
          expect(await T.mapBox(page), '852x393: the map box with the sheet open').toEqual(before);
          expect(await page.evaluate(() => getComputedStyle(document.getElementById('map-sidebar-draw')).position), '852x393: the sheet overlays').toBe('absolute');
          // ~250px of sheet on its side: Draw Mode is a scroll down inside it.
          await page.locator('#modeLineBtn').scrollIntoViewIfNeeded();
          expect(await T.mapBox(page), '852x393: scrolling the sheet leaves the map alone').toEqual(before);
          await expectTappable(page, '#modeLineBtn', '852x393: Lines in the sheet');
          await expectTappable(page, '#modeGutterBtn', '852x393: Gutters in the sheet');
          await page.locator(tools).tap();
          await expect(page.locator('#map-sidebar-draw')).not.toHaveClass(/\bopen\b/);
          await page.evaluate(() => window.showToast('Facet 1 closed — 1075 sf', 'info'));
          await page.waitForTimeout(300);
          const t = await boxOf('#toastContainer .toast');
          const u2 = await ui(page);
          expect(overlap(t, u2.cross), `852x393: toast ${JSON.stringify(t)} vs the crosshair`).toBe(false);
          expect(overlap(t, u2.bar), '852x393: toast vs the bar').toBe(false);
          const tb = await boxOf(tools);
          expect(overlap(t, tb), `852x393: toast vs ☰ Tools ${JSON.stringify(tb)}`).toBe(false);
          expect((await hitTest(page, tools)).why, '852x393: ☰ Tools with a toast up').toBe('hit');
          await T.quietToasts(page);
        } finally {
          if (await page.locator('#map-sidebar-draw.open').count()) await page.locator('[data-action="mapSidebar"][data-target="map-sidebar-draw"]').tap().catch(() => {});
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(700);
        }
      });
    }

    for (const installed of [false, true]) {
      test(`Tools opens an overlay sheet${installed ? ' (installed app)' : ''}: the map keeps its size, Lines / Gutters stay under a thumb, Add waits`, async () => {
        await reset();
        await mode('perim');
        if (installed) expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
        try {
          const before = await T.mapBox(page);
          const tools = '[data-action="mapSidebar"][data-target="map-sidebar-draw"]';
          await T.quietToasts(page);
          await expectTappable(page, tools, '☰ Draw Tools');
          await page.locator(tools).tap();
          await expect(page.locator('#map-sidebar-draw')).toHaveClass(/\bopen\b/);
          await page.waitForTimeout(400); // max-height transition
          const after = await T.mapBox(page);
          expect(after.h, 'the map height with the sheet open').toBe(before.h);
          expect(after.y, 'the map top with the sheet open').toBe(before.y);
          const sheet = await page.evaluate(() => {
            const s = document.getElementById('map-sidebar-draw');
            const r = s.getBoundingClientRect();
            return { pos: getComputedStyle(s).position, top: r.top, bottom: r.bottom, h: r.height };
          });
          expect(sheet.pos, 'the sheet overlays the map').toBe('absolute');
          expect(sheet.h, 'the sheet is open on screen').toBeGreaterThan(200);
          await T.quietToasts(page);
          await expectTappable(page, '#modeLineBtn', 'Draw Mode: Lines (inside the sheet)');
          await expectTappable(page, '#modeGutterBtn', 'Draw Mode: Gutters (inside the sheet)');
          expect((await ui(page)).add.disabled, 'Add waits while the sheet is open').toBe(true);
          await page.locator(tools).tap();
          await expect(page.locator('#map-sidebar-draw')).not.toHaveClass(/\bopen\b/);
          await nextFrames(page);
          expect((await ui(page)).add.disabled, 'Add is back once the sheet closes').toBe(false);
        } finally {
          await page.evaluate(() => { const s = document.getElementById('e2e-force-standalone'); if (s) s.remove(); });
        }
      });
    }

    test('no page errors while drawing', async () => {
      expect(pageErrors, 'uncaught page errors').toEqual([]);
    });
  });
}

// 2026-09-25 (release gate, Jo decision 8): the screen ships OFF. This block
// starts with NO preference, on the stub seam at 412x860, and pins the gate:
// off is the phone as it was before the screen (no .dr-root, no body classes
// or CSS vars, no seam call, tap-to-place); the switch builds and tears the
// screen down live, survives a reload, is re-read on coming back to Draw,
// cycles on / off with nothing left behind, and is under a thumb at every
// phone layout. (The real-engine block below repeats default / on / off on
// L3's seam.)
test.describe.serial('crosshair beta switch, off by default 412x860 @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let touch = null;
  const pageErrors = [];
  const SW = '#drawCrosshairSwitch';
  const crosshairCalls = () => page.evaluate(() => drawMap.nbdDraw.__calls.filter((c) => c.fn === 'setCrosshair').map((c) => c.args[0]));
  async function tapSel(sel) {
    await page.evaluate((s) => { const e = document.querySelector(s); e.dataset.e2eClicked = '0'; e.addEventListener('click', () => { e.dataset.e2eClicked = '1'; }, { once: true, capture: true }); }, sel);
    await page.locator(sel).tap();
    await expect.poll(() => page.evaluate((s) => document.querySelector(s).dataset.e2eClicked, sel), { message: `a tap on ${sel} clicks it`, timeout: 3_000 }).toBe('1');
    await nextFrames(page);
  }
  async function openDrawView() {
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
    await T.openDraw(page);
    await page.waitForFunction(() => !!(drawMap && drawMap.nbdDraw && drawMap.nbdDraw.__calls) && !!document.getElementById('drawCrosshairSwitch'), null, { timeout: 10_000 });
  }
  // Two real finger taps on the map with Lines armed on the engine: tap-to-
  // place, the path a phone has with the screen off.
  async function tapToPlace() {
    await T.resetDrawing(page);
    await T.setView(page, WING.view, WING.zoom);
    await T.arm(page, 'line');
    const a = await T.ll2client(page, WING.A), b = await T.ll2client(page, WING.B);
    expect((await T.hitAt(page, a)).ok, `a finger at corner A reaches the map (${(await T.hitAt(page, a)).what})`).toBe(true);
    await touch.tap(a);
    await touch.tap(b);
    const st = await T.drawState(page);
    await T.resetDrawing(page);
    return st;
  }
  const leaks = () => page.evaluate(() => Object.assign({
    roots: document.querySelectorAll('.dr-root').length,
    leaflets: document.querySelectorAll('.leaflet-container').length,
    mapListeners: Object.values(drawMap._events || {}).reduce((n, a) => n + a.length, 0),
    seamListeners: drawMap.nbdDraw.__listenerCount(),
    barOn: document.body.classList.contains('dr-bar-on'),
    drOn: document.getElementById('view-draw').classList.contains('dr-on'),
  }, window.__e2eLeaks()));

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    context = await browser.newContext(T.phoneContextOptions(412, 860));
    await returningUser(context);
    await installSeamStub(context);
    await context.addInitScript(leakProbeInit);
    page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    await T.acceptDialogs(page);
    await T.stubTiles(page);
    await stubNetwork(page);
    await loginAs(page, creds);
    await openDrawView();
    touch = await T.touchSession(page);
    await T.quietToasts(page);
    await T.setView(page, WING.view, WING.zoom);
  });
  test.afterAll(async () => {
    if (touch) await touch.detach();
    if (context) await context.close();
  });
  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('default (no preference): no screen, no seam call, tap-to-place — and the switch in ☰ Tools reads off', async () => {
    const s = await screenState(page);
    expect(s.pref, 'no preference stored').toBeNull();
    expect(s.roots, 'no crosshair screen (.dr-root)').toBe(0);
    expect(s.drOn, '#view-draw.dr-on').toBe(false);
    expect(s.barOn, 'body.dr-bar-on (the toast move)').toBe(false);
    expect(s.vars, 'no --dr-* CSS vars on body or #view-draw').toEqual([]);
    expect(await crosshairCalls(), 'the screen never called setCrosshair').toEqual([]);
    expect(s.switches, 'one switch').toBe(1);
    expect(s.sw.role, 'a real switch').toBe('switch');
    expect(s.sw.label, 'its label').toBe('Crosshair drawing (beta)');
    expect(s.sw.checked, 'it reads off').toBe('false');
    await setTools(page, true);
    await T.quietToasts(page);
    await revealSwitch(page, touch);
    await expect(page.locator(SW), 'the switch shows in ☰ Tools').toBeVisible();
    await expectTappable(page, SW, 'the beta switch');
    expect((await page.locator(SW).boundingBox()).height, 'switch height').toBeGreaterThanOrEqual(44);
    await expect(page.locator('#drawCrosshairSwitchHint'), 'with its one-line hint').toHaveText(/crosshair/i);
    await setTools(page, false);
    const st = await tapToPlace();
    expect(st.saved && st.saved.lines.length, 'two taps on the map drew one line (tap-to-place, the engine path)').toBe(1);
    expect(Math.abs(st.saved.lines[0].dist - G.hav(WING.A, WING.B)), 'its length').toBeLessThanOrEqual(0.5);
    expect(await crosshairCalls(), 'still no setCrosshair').toEqual([]);
  });

  test('switch on: the screen builds at once, with no reload, and turns crosshair mode on', async () => {
    await setTools(page, true);
    await tapSel(SW);
    let s = await screenState(page);
    expect(s.sw.checked, 'the switch reads on').toBe('true');
    expect(s.pref, 'the choice is kept').toBe('1');
    expect(s.roots, 'one crosshair screen, built live').toBe(1);
    expect(s.drOn, '#view-draw.dr-on').toBe(true);
    expect(await crosshairCalls(), 'setCrosshair(true), once').toEqual([true]);
    await setTools(page, false);
    await expect(page.locator('#view-draw.dr-on .dr-root .dr-bar'), 'the bar is up').toBeVisible();
    await nextFrames(page);
    s = await screenState(page);
    expect(s.barOn, 'body.dr-bar-on').toBe(true);
    // The drawer sat in the page (off) and now overlays the map (on): the
    // map was re-measured, so the crosshair is Leaflet's centre.
    const off = await page.evaluate(() => {
      const c = document.querySelector('.dr-cross').getBoundingClientRect();
      const m = drawMap.getContainer().getBoundingClientRect();
      const z = drawMap.getSize();
      return { dx: c.left + c.width / 2 - (m.left + z.x / 2), dy: c.top + c.height / 2 - (m.top + z.y / 2), h: m.height, lh: z.y };
    });
    expect(Math.abs(off.lh - off.h), 'Leaflet knows the map\'s new height').toBeLessThanOrEqual(1);
    expect(Math.hypot(off.dx, off.dy), 'crosshair = the map centre').toBeLessThanOrEqual(1);
  });

  test('reload: the choice is kept, and the screen builds on the next visit to Draw', async () => {
    if (touch) { await touch.detach(); touch = null; }
    await page.reload();
    await openDrawView();
    touch = await T.touchSession(page);
    await expect(page.locator('#view-draw.dr-on .dr-root .dr-bar'), 'the bar is up after a reload').toBeVisible({ timeout: 10_000 });
    const s = await screenState(page);
    expect(s.roots, 'one screen').toBe(1);
    expect(s.sw.checked, 'the switch reads on').toBe('true');
    expect(await crosshairCalls(), 'the new page turned crosshair mode on').toEqual([true]);
    await T.quietToasts(page);
    await T.setView(page, WING.view, WING.zoom);
  });

  test('coming back to Draw re-reads the choice: off, on, and cleared (what sign-out does) = the default, off', async () => {
    const away = async (value) => {
      await page.evaluate(() => window.goTo('crm'));
      await page.waitForTimeout(300);
      await page.evaluate(([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, [PREF, value]);
      await page.evaluate(() => window.goTo('draw'));
      await page.waitForTimeout(800);
      return screenState(page);
    };
    let s = await away('0');
    expect(s.roots, "'0' on the way back: no screen").toBe(0);
    expect(s.sw.checked, 'the switch follows').toBe('false');
    expect((await crosshairCalls()).slice(-1), 'crosshair mode off').toEqual([false]);
    s = await away('1');
    expect(s.roots, "'1' on the way back: the screen").toBe(1);
    expect(s.sw.checked).toBe('true');
    // NBDAuth.purgeAccountStorage() removes every nbd_ key on sign-out.
    s = await away(null);
    expect(s.roots, 'no preference: the default (off)').toBe(0);
    expect(s.barOn, 'body.dr-bar-on').toBe(false);
    expect(s.sw.checked).toBe('false');
    s = await away('1');
    expect(s.roots, 'on again for the next test').toBe(1);
    await expect(page.locator('#view-draw.dr-on .dr-root .dr-bar')).toBeVisible();
    await T.quietToasts(page);
  });

  test('switch off: the whole screen goes, live — DOM, body classes, CSS vars — the engine leaves crosshair mode, and tap-to-place is back', async () => {
    await page.evaluate(() => { drawMap.nbdDraw.__seed({}); });
    await T.setView(page, WING.view, WING.zoom);
    await tapSel('.dr-mode[data-dr-mode="perim"]');
    await tapSel('[data-dr-act="add"]');
    await expect(page.locator('.dr-loupe'), 'a point pending, the magnifier up').toBeVisible();
    const before = await screenState(page);
    expect(before.barOn && before.drOn && before.vars.length > 0, `on: classes and vars are there to clear ${JSON.stringify(before)}`).toBe(true);
    await setTools(page, true);
    await tapSel(SW);
    const s = await screenState(page);
    expect(s.sw.checked, 'the switch reads off').toBe('false');
    expect(s.pref, 'the choice is kept').toBe('0');
    expect(s.roots, '.dr-root gone').toBe(0);
    expect(s.drOn, '#view-draw.dr-on cleared').toBe(false);
    expect(s.barOn, 'body.dr-bar-on cleared (toasts back where they were)').toBe(false);
    expect(s.vars, '--dr-* CSS vars cleared').toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll('.dr-loupe, .dr-bar, .dr-cross').length), 'bar, crosshair and magnifier gone').toBe(0);
    expect((await crosshairCalls()).slice(-1), 'setCrosshair(false)').toEqual([false]);
    await setTools(page, false);
    const st = await tapToPlace();
    expect(st.saved && st.saved.lines.length, 'two taps on the map drew one line again').toBe(1);
  });

  test('on / off x5: one screen when on, none when off, and no listener, observer or map left behind', async () => {
    await page.evaluate(() => { drawMap.nbdDraw.__seed({}); });
    const off0 = await leaks();
    expect(off0.roots, 'starts off').toBe(0);
    let on1 = null;
    for (let i = 1; i <= 5; i++) {
      await page.evaluate(() => document.getElementById('drawCrosshairSwitch').click());
      await nextFrames(page);
      // Outline, then Add: a pending point, so the magnifier's own map is
      // built too and has to go at off.
      await page.evaluate(() => document.querySelector('.dr-mode[data-dr-mode="perim"]').click());
      await nextFrames(page);
      await page.evaluate(() => document.querySelector('[data-dr-act="add"]').click());
      await nextFrames(page);
      const on = await leaks();
      expect(on.roots, `cycle ${i}: exactly one screen`).toBe(1);
      expect(on.leaflets, `cycle ${i}: the map + the magnifier's map`).toBe(off0.leaflets + 1);
      if (!on1) on1 = on;
      else expect(on, `cycle ${i}: on, the same listeners / observers / maps as cycle 1`).toEqual(on1);
      // Off with a frame queued (a resize makes the screen re-measure) and
      // the Confirm guard's timer live (Add was a frame ago), in the same
      // task, so nothing can run first: destroy() must cancel both.
      const at = await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        const before = window.__e2ePending();
        document.getElementById('drawCrosshairSwitch').click();
        return { before, after: window.__e2ePending() };
      });
      expect(at.before.frames, `cycle ${i}: a screen frame was queued at off`).toBeGreaterThanOrEqual(1);
      expect(at.before.timers, `cycle ${i}: a screen timer was live at off (the Confirm guard)`).toBeGreaterThanOrEqual(1);
      expect(at.after, `cycle ${i}: off cancels the screen's frame and timers`).toEqual({ timers: 0, frames: 0 });
      await nextFrames(page);
      expect(await leaks(), `cycle ${i}: off leaves the page as it found it`).toEqual(off0);
    }
    expect(on1.window + on1.document + on1.observers, 'the probe saw the screen\'s own listeners').toBeGreaterThan(off0.window + off0.document + off0.observers);
    expect(on1.mapListeners, 'and its map listeners').toBeGreaterThan(off0.mapListeners);
    expect(on1.seamListeners, 'and its seam listeners').toBeGreaterThan(off0.seamListeners);
  });

  // Reached by a real finger dragging inside ☰ Tools (revealSwitch). Not at
  // 740x360 (a small phone on its side, under 769px wide): there ☰ Tools
  // opens wholly below the screen and no swipe brings it up — on main too,
  // for everything in Tools (gate review, 2026-09-25). The first cut
  // "reached" it with scrollIntoView(), which scrolls the page from code.
  test('the switch is under a thumb: 412x860, 360x640 and 852x393, browser and installed app, off and on', async () => {
    test.setTimeout(120_000);
    try {
      for (const [w, h] of [[412, 860], [360, 640], [852, 393]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(500);
        for (const installed of [false, true]) {
          if (installed) expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
          try {
            for (const on of [false, true]) {
              const tag = `${w}x${h}${installed ? ' installed' : ''}, ${on ? 'on' : 'off'}`;
              if (((await screenState(page)).sw.checked === 'true') !== on) await page.evaluate(() => document.getElementById('drawCrosshairSwitch').click());
              await page.evaluate(() => window.dispatchEvent(new Event('resize')));
              await page.waitForTimeout(450);
              // ☰ Tools is the way in wherever it shows; a desktop-width
              // column (a phone on its side, screen off) is always open.
              const viaTools = await page.evaluate((s) => { const b = document.querySelector(s); return !!b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0; }, TOOLS);
              if (viaTools) await setTools(page, true);
              await T.quietToasts(page);
              const got = await revealSwitch(page, touch);
              expect(got.inside, `${tag}: a finger dragging in ☰ Tools brings the switch on screen ${JSON.stringify(got)}`).toBe(true);
              const box = await page.locator(SW).boundingBox();
              expect(box && box.height, `${tag}: switch height`).toBeGreaterThanOrEqual(44);
              expect(box.x >= 0 && box.x + box.width <= w + 0.5, `${tag}: switch inside the screen ${JSON.stringify(box)}`).toBe(true);
              await expectTappable(page, SW, `${tag}: the beta switch`);
              if (w === 360 && installed && !on) {
                // ...and a real tap there works it.
                await tapSel(SW);
                expect((await screenState(page)).sw.checked, `${tag}: a tap turns it on`).toBe('true');
                expect((await screenState(page)).roots, `${tag}: the screen is built`).toBe(1);
              }
              if (viaTools) await setTools(page, false);
            }
          } finally {
            if (installed) await page.evaluate(() => { const st = document.getElementById('e2e-force-standalone'); if (st) st.remove(); });
          }
        }
      }
    } finally {
      if (await page.locator('#map-sidebar-draw.open').count()) await page.locator(TOOLS).tap().catch(() => {});
      await page.setViewportSize({ width: 412, height: 860 });
      await page.waitForTimeout(500);
    }
  });

  test('no page errors through the switching', async () => {
    expect(pageErrors, 'uncaught page errors').toEqual([]);
  });
});

// 2026-09-25: L3 (#1768) is on main, so the screen also runs here on the
// REAL engine seam — no stub. The stub blocks above pin the screen's own
// behaviour call by call; this block pins that the two fit: crosshair mode
// on, a map tap only aims, an outline traced by Add / Confirm closes at the
// wing's area with its edges typed by the chips, the engine's own close toast
// stays off the crosshair, and Shadow Pitch runs start to finish.
// Release gate (same day): it starts with NO preference — the engine keeps
// tap-to-place and crosshair mode off — then the beta switch turns the
// screen on live, and at the end off again, back to tap-to-place.
test.describe.serial('phone draw crosshair on the real engine (L3) 412x860 @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let touch = null;
  const pageErrors = [];
  const api = (fn, ...args) => page.evaluate(([f, a]) => drawMap.nbdDraw[f](...a), [fn, args]);
  const box = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.left, y: r.top, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null; }, sel);
  const text = (sel) => page.evaluate((s) => document.querySelector(s).textContent.trim(), sel);
  const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
  async function tapSel(sel) {
    await page.evaluate((s) => { const e = document.querySelector(s); e.dataset.e2eClicked = '0'; e.addEventListener('click', () => { e.dataset.e2eClicked = '1'; }, { once: true, capture: true }); }, sel);
    await page.locator(sel).tap();
    await expect.poll(() => page.evaluate((s) => document.querySelector(s).dataset.e2eClicked, sel), { message: `a tap on ${sel} clicks it`, timeout: 3_000 }).toBe('1');
    await nextFrames(page);
  }
  async function place(ll) {
    await T.setView(page, ll, WING.zoom);
    await tapSel('[data-dr-act="add"]');
    await tapSel('[data-dr-act="confirm"]'); // tap() waits out the double-tap guard
  }
  async function aimOff(ll, dx, dy) {
    const p = await T.ll2client(page, ll);
    await page.evaluate(([x, y]) => { const r = drawMap.getContainer().getBoundingClientRect(); drawMap.setView(drawMap.containerPointToLatLng([x - r.left, y - r.top]), drawMap.getZoom(), { animate: false }); }, [p.x + dx, p.y + dy]);
    await page.waitForTimeout(300);
    await nextFrames(page);
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    context = await browser.newContext(T.phoneContextOptions(412, 860));
    await returningUser(context);
    page = await context.newPage();
    await T.acceptDialogs(page);
    await T.stubTiles(page);
    await stubNetwork(page);
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
    await T.openDraw(page);
    await page.waitForFunction(() => !!(drawMap && drawMap.nbdDraw) && !!document.getElementById('drawCrosshairSwitch'), null, { timeout: 10_000 });
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    touch = await T.touchSession(page);
    await T.resetDrawing(page);
    await T.quietToasts(page);
    await T.setView(page, WING.view, WING.zoom);
  });
  test.afterAll(async () => {
    if (touch) await touch.detach();
    if (context) await context.close();
  });
  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });
  // Lines armed on the engine, two real taps on the map: tap-to-place.
  async function tapToPlace() {
    await T.resetDrawing(page);
    await T.setView(page, WING.view, WING.zoom);
    await T.arm(page, 'line');
    const a = await T.ll2client(page, WING.A), b = await T.ll2client(page, WING.B);
    await touch.tap(a);
    await touch.tap(b);
    const st = await T.drawState(page);
    await T.resetDrawing(page);
    return st;
  }
  const leafletOpts = () => page.evaluate(() => ({
    inertia: drawMap.options.inertia, touchZoom: drawMap.options.touchZoom, doubleClickZoom: drawMap.options.doubleClickZoom,
    crosshairClass: drawMap.getContainer().classList.contains('nbd-crosshair'),
  }));

  test('default (no preference): no screen, crosshair mode off, a tap places a point; the switch reads off', async () => {
    expect(typeof (await page.evaluate(() => drawMap.nbdDraw.__calls)), 'the real seam, not the test stub').toBe('undefined');
    const s = await screenState(page);
    expect(s.pref, 'no preference stored').toBeNull();
    expect(s.roots, 'no crosshair screen (.dr-root)').toBe(0);
    expect([s.drOn, s.barOn], '#view-draw.dr-on, body.dr-bar-on').toEqual([false, false]);
    expect(s.vars, 'no --dr-* CSS vars').toEqual([]);
    expect((await api('state')).crosshair, 'the engine is not in crosshair mode').toBe(false);
    expect(await leafletOpts(), 'Leaflet options untouched').toEqual({ inertia: true, touchZoom: true, doubleClickZoom: true, crosshairClass: false });
    expect(s.sw && s.sw.checked, 'the switch reads off').toBe('false');
    await setTools(page, true);
    await revealSwitch(page, touch);
    await expectTappable(page, '#drawCrosshairSwitch', 'the beta switch in ☰ Tools');
    await setTools(page, false);
    const st = await tapToPlace();
    expect(st.saved && st.saved.lines.length, 'two taps drew one line (tap-to-place)').toBe(1);
    expect(Math.abs(st.saved.lines[0].dist - G.hav(WING.A, WING.B)), 'its length').toBeLessThanOrEqual(0.5);
  });

  // 2026-09-25 (gate review, blocking): with no preference ☰ Tools must be
  // main's drawer. The first cut mounted the switch under Draw Mode, and its
  // 56px row pushed the Eave/Rake chooser, the Line Type grid and ✓ Finish
  // run under the bottom nav at 393x852 and 412x860 — on screen there on
  // main when Tools opens (drawer at its top). The switch sits below
  // Controls now, after every control the drawing flow uses.
  test('default (no preference): ☰ Tools is main\'s drawer — Line Type, the Eave/Rake chooser and ✓ Finish run are under a thumb as it opens (393x852, 412x860)', async () => {
    test.setTimeout(150_000);
    // ☰ Tools opened by a finger, the drawer at its top.
    const openAtTop = async () => {
      await T.quietToasts(page);
      await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('map-sidebar-draw').scrollTop = 0; });
      await setTools(page, true);
      await page.evaluate(() => { document.getElementById('map-sidebar-draw').scrollTop = 0; });
      await T.quietToasts(page);
    };
    // `mode` armed, two finger taps on the map (A, B): tap-to-place.
    const twoTaps = async (mode) => {
      await T.resetDrawing(page);
      await T.setView(page, WING.view, WING.zoom);
      await T.arm(page, mode);
      await touch.tap(await T.ll2client(page, WING.A));
      await touch.tap(await T.ll2client(page, WING.B));
    };
    try {
      for (const [w, h] of [[393, 852], [412, 860]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(600);
        for (const installed of [false, true]) {
          const tag = `${w}x${h}${installed ? ' installed' : ''}`;
          if (installed) expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
          try {
            await page.evaluate(() => window.dispatchEvent(new Event('resize')));
            await page.waitForTimeout(500);
            expect((await screenState(page)).roots, `${tag}: no crosshair screen`).toBe(0);
            // Lines: the Line Type grid.
            await T.resetDrawing(page);
            await T.arm(page, 'line');
            await openAtTop();
            for (const sel of ['#ltGrid .lt-btn:nth-child(1)', '#ltGrid .lt-btn:nth-child(2)']) await expectTappable(page, sel, `${tag}, Lines: ${sel}`);
            await setTools(page, false);
            // Perimeter, two taps: the Eave / Rake chooser for that edge.
            await twoTaps('perim');
            await expect(page.locator('#reChooser'), `${tag}: the Eave / Rake chooser is up`).toHaveClass(/\bvisible\b/);
            await openAtTop();
            for (const sel of ['.re-btn-eave', '.re-btn-rake']) await expectTappable(page, sel, `${tag}, Perimeter: ${sel}`);
            await setTools(page, false);
            // Gutters, two taps: ✓ Finish run.
            await twoTaps('gutter');
            await openAtTop();
            await expectTappable(page, '#gutterFinishBtn', `${tag}, Gutters: ✓ Finish run`);
            await setTools(page, false);
          } finally {
            if (installed) await page.evaluate(() => { const st = document.getElementById('e2e-force-standalone'); if (st) st.remove(); });
          }
        }
      }
    } finally {
      if (await page.locator('#map-sidebar-draw.open').count()) await page.locator(TOOLS).tap().catch(() => {});
      await T.resetDrawing(page);
      await page.setViewportSize({ width: 412, height: 860 });
      await page.waitForTimeout(600);
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await T.setView(page, WING.view, WING.zoom);
    }
  });

  test('switch on: the screen builds live and the engine goes into crosshair mode', async () => {
    await setTools(page, true);
    await tapSel('#drawCrosshairSwitch');
    const s = await screenState(page);
    expect(s.sw.checked, 'the switch reads on').toBe('true');
    expect(s.roots, 'one screen, no reload').toBe(1);
    expect((await api('state')).crosshair, 'crosshair mode').toBe(true);
    expect((await leafletOpts()).crosshairClass, 'the map container is in crosshair mode').toBe(true);
    await setTools(page, false);
    await expect(page.locator('#view-draw.dr-on .dr-root .dr-bar')).toBeVisible();
    await T.quietToasts(page);
    await T.setView(page, WING.view, WING.zoom);
  });

  test('the screen turns crosshair mode on, and a tap on the map only aims', async () => {
    expect(typeof (await page.evaluate(() => drawMap.nbdDraw.__calls)), 'the real seam, not the test stub').toBe('undefined');
    await tapSel('.dr-mode[data-dr-mode="perim"]');
    const s = await api('state');
    expect(s.crosshair, 'crosshair mode').toBe(true);
    expect(s.armed && s.mode === 'perim', 'Outline armed the engine').toBe(true);
    const mb = await T.mapBox(page);
    await touch.tap({ x: mb.x + mb.w * 0.3, y: mb.y + mb.h * 0.25 });
    await page.waitForTimeout(600);
    expect((await api('state')).counts.vertices, 'points after a map tap').toBe(0);
  });

  test('an outline traced by Add / Confirm closes at the wing\'s area, edges typed by the chips, with the close toast off the crosshair', async () => {
    await T.quietToasts(page);
    // Corner A the long way: Add off the corner, drag the point onto it, Confirm.
    await aimOff(WING.A, 40, 30);
    await tapSel('[data-dr-act="add"]');
    await expect.poll(async () => (await box('[data-dr-act="confirm"]')) && (await page.evaluate(() => document.querySelector('[data-dr-act="confirm"]').disabled)), { message: 'Confirm enabled once the double-tap guard runs out' }).toBe(false);
    const h = await box('.dr-handle');
    const onA = await T.ll2client(page, WING.A);
    await touch.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: h.cx, y: h.cy, id: 0, radiusX: 8, radiusY: 8, force: 1 }] });
    for (let i = 1; i <= 16; i++) {
      await touch.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: h.cx + (onA.x - h.cx) * i / 16, y: h.cy + (onA.y - h.cy) * i / 16, id: 0, radiusX: 8, radiusY: 8, force: 1 }] });
      await page.waitForTimeout(16);
    }
    await touch.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await nextFrames(page);
    const dropped = await page.evaluate(() => { const e = document.querySelector('.dr-handle'); return { lat: +e.dataset.lat, lng: +e.dataset.lng }; });
    await page.evaluate(() => { window.__e2eResets = 0; drawMap.on('viewprereset', () => { window.__e2eResets++; }); });
    await tapSel('[data-dr-act="confirm"]');
    let s = await api('state');
    expect(s.openCount, 'corner A committed').toBe(1);
    expect(await page.evaluate(() => window.__e2eResets), 'no tile-wiping view reset').toBe(0);
    expect(await page.evaluate(([a, b]) => drawMap.latLngToContainerPoint(a).distanceTo(drawMap.latLngToContainerPoint(b)), [s.first, dropped]), 'A is where the point was dropped (px)').toBeLessThanOrEqual(0.75);
    await tapSel('.dr-edge[data-dr-edge="rake"]');
    await place(WING.B);
    await place(WING.C);
    await tapSel('.dr-edge[data-dr-edge="eave"]');
    await place(WING.D);
    expect((await api('state')).openCount, 'four corners').toBe(4);
    await aimOff(WING.A, 6, -5);
    expect(await text('[data-dr-act="add"]'), 'the snap ring on A makes Add a Close').toBe('Close');
    await tapSel('[data-dr-act="add"]');
    await tapSel('[data-dr-act="confirm"]');
    s = await api('state');
    expect(s.counts.facets, 'one closed facet').toBe(1);
    const base = (await api('totals')).combined.base;
    expect(Math.abs(base - WING.expected.appAreaSf) / WING.expected.appAreaSf, `the wing by crosshair: ${base.toFixed(1)} sf`).toBeLessThanOrEqual(0.005);
    const types = ((await T.drawState(page)).saved.lines || []).map((l) => l.type).sort();
    expect(types, 'two rake, two eave edges').toEqual([4, 4, 5, 5]);
    expect(await text('.dr-read-main'), 'the bar reads this structure').toMatch(new RegExp(' · ' + fmtSf(base) + ' sf · ' + fmtSq(base) + ' sq$'));
    // The engine's own "Facet 1 closed" toast: at the top, off the crosshair.
    await expect(page.locator('#toastContainer .toast').first(), 'the engine toasts the close').toBeVisible();
    const t = await box('#toastContainer .toast');
    const c = await box('.dr-cross');
    expect(overlap(t, c), `toast ${JSON.stringify(t)} vs the crosshair`).toBe(false);
    expect((await T.hitAt(page, { x: c.cx, y: c.cy })).ok, 'a finger at the crosshair reaches the map').toBe(true);
  });

  test('Shadow Pitch from ☰ Tools runs through Add: four points, then the engine is done with it', async () => {
    await T.quietToasts(page);
    const tools = '[data-action="mapSidebar"][data-target="map-sidebar-draw"]';
    await page.locator(tools).tap();
    await expect(page.locator('#map-sidebar-draw')).toHaveClass(/\bopen\b/);
    const sp = page.locator('#map-sidebar-draw [data-fn="startShadowPitch"]');
    await sp.scrollIntoViewIfNeeded();
    await sp.tap();
    if (await page.locator('#map-sidebar-draw.open').count()) await page.locator(tools).tap();
    await expect(page.locator('#map-sidebar-draw')).not.toHaveClass(/\bopen\b/);
    await nextFrames(page);
    expect((await api('state')).shadow, 'the engine is in Shadow Pitch').toBe('shadow');
    expect(await text('[data-dr-act="add"]')).toBe('Place shadow point');
    await aimOff(WING.B, 6, -5);
    expect(await box('.dr-snap:not(.dr-pickring)'), 'no snap ring for a shadow point').toBeNull();
    await tapSel('[data-dr-act="add"]');
    await tapSel('[data-dr-act="confirm"]');
    await place(WING.C);
    expect((await api('state')).shadow, 'two shadow points, then the roof edge').toBe('edge');
    expect(await text('[data-dr-act="add"]')).toBe('Place roof-edge point');
    await place(WING.D);
    await place({ lat: (WING.A.lat + WING.C.lat) / 2, lng: (WING.A.lng + WING.C.lng) / 2 });
    expect((await api('state')).shadow, 'four points: Shadow Pitch is done').toBeNull();
    expect((await api('state')).counts.facets, 'the outline was not touched').toBe(1);
  });

  // #1768's note for L4: the engine snaps a crosshair point within 16 px but
  // never more than 3 ft of ground (~8 px at z20). The ring is the engine's
  // own snap() answer (no radius of the screen's), and Confirm places
  // {snap:false} when no ring shows — so what the ring says is what commits.
  test('the snap ring is the engine\'s rule: none 12 px off a corner at z20 (3 ft cap), one 4 px off, and Confirm lands as it showed', async () => {
    const pxBetween = (a, b) => page.evaluate(([a1, b1]) => drawMap.latLngToContainerPoint(a1).distanceTo(drawMap.latLngToContainerPoint(b1)), [a, b]);
    await T.quietToasts(page);
    await tapSel('.dr-mode[data-dr-mode="line"]');
    await T.setView(page, WING.B, 20);
    const r = (await api('state')).snapRadiusPx;
    expect(r, `the engine's snap radius at z20 (${r} px) is under 12`).toBeLessThan(12);
    expect(r, 'and snapping is on').toBeGreaterThanOrEqual(4);
    const onB = (await api('pick', WING.B, 3)).count;
    await aimOff(WING.B, 12, 0);
    expect(await box('.dr-snap:not(.dr-pickring)'), '12 px off B at z20: no ring').toBeNull();
    expect((await api('snap')).snapped, '...and the engine would not snap there').toBe(false);
    const aim = await page.evaluate(() => { const c = drawMap.getCenter(); return { lat: c.lat, lng: c.lng }; });
    await tapSel('[data-dr-act="add"]');
    await tapSel('[data-dr-act="confirm"]');
    const start = (await api('state')).anchor;
    expect(start, 'the line is started').not.toBeNull();
    expect(await pxBetween(start, aim), 'it starts where the crosshair was (px)').toBeLessThanOrEqual(0.75);
    expect(await pxBetween(start, WING.B), '...not on B (px)').toBeGreaterThan(10);
    expect((await api('pick', WING.B, 3)).count, 'B has no new edge').toBe(onB);
    const onC = (await api('pick', WING.C, 3)).count;
    await aimOff(WING.C, 4, 0);
    expect(await box('.dr-snap:not(.dr-pickring)'), '4 px off C: the ring').not.toBeNull();
    await tapSel('[data-dr-act="add"]');
    await tapSel('[data-dr-act="confirm"]');
    expect((await api('pick', WING.C, 3)).count, 'the line ends ON corner C (one more edge there)').toBe(onC + 1);
    await T.setView(page, WING.view, WING.zoom);
  });

  // An accessory shows no ring, so it must not snap either: before the gate
  // lane its Confirm sent {edgeType}, and the engine's crosshair snap pulled
  // a pipe boot aimed 5 px off a corner onto the corner.
  test('an accessory lands exactly at the crosshair — never pulled onto a corner it showed no ring for', async () => {
    const pxBetween = (a, b) => page.evaluate(([a1, b1]) => drawMap.latLngToContainerPoint(a1).distanceTo(drawMap.latLngToContainerPoint(b1)), [a, b]);
    const toggle = () => page.evaluate(() => document.querySelector('#accessoryPanel [data-mr-action="toggleAccessoryMode"][data-mr-id="pipe"]').click());
    await toggle();
    await T.quietToasts(page);
    await T.setView(page, WING.D, WING.zoom);
    await aimOff(WING.D, 5, 0);
    expect(await text('[data-dr-act="add"]'), 'Add places the pipe boot').toMatch(/^Place /);
    expect(await box('.dr-snap:not(.dr-pickring)'), 'no ring for an accessory').toBeNull();
    expect((await api('snap')).snapped, 'the engine WOULD snap a crosshair point here (z21, 5 px)').toBe(true);
    const aim = await page.evaluate(() => { const c = drawMap.getCenter(); return { lat: c.lat, lng: c.lng }; });
    const before = ((await T.drawState(page)).saved.accessories || []).length;
    await tapSel('[data-dr-act="add"]');
    await tapSel('[data-dr-act="confirm"]');
    const acc = (await T.drawState(page)).saved.accessories || [];
    expect(acc.length, 'one pipe boot placed').toBe(before + 1);
    const put = acc[acc.length - 1];
    expect(await pxBetween(put, aim), 'the pipe boot is where the crosshair was (px)').toBeLessThanOrEqual(0.75);
    expect(await pxBetween(put, WING.D), '...not on corner D (px)').toBeGreaterThan(4);
    await toggle();
    await T.quietToasts(page);
    await T.setView(page, WING.view, WING.zoom);
  });

  test('switch off: the screen comes down whole, crosshair mode off, Leaflet\'s options back, and a tap places a point again', async () => {
    await T.quietToasts(page);
    await tapSel('[data-dr-act="add"]'); // a point pending, so there is a magnifier to take down too
    await setTools(page, true);
    await tapSel('#drawCrosshairSwitch');
    const s = await screenState(page);
    expect(s.sw.checked, 'the switch reads off').toBe('false');
    expect(s.roots, '.dr-root gone').toBe(0);
    expect([s.drOn, s.barOn], '#view-draw.dr-on, body.dr-bar-on cleared').toEqual([false, false]);
    expect(s.vars, '--dr-* CSS vars cleared').toEqual([]);
    expect((await api('state')).crosshair, 'crosshair mode off').toBe(false);
    expect(await leafletOpts(), 'Leaflet options back').toEqual({ inertia: true, touchZoom: true, doubleClickZoom: true, crosshairClass: false });
    await setTools(page, false);
    const st = await tapToPlace();
    expect(st.saved && st.saved.lines.length, 'two taps drew one line again (tap-to-place)').toBe(1);
    expect(Math.abs(st.saved.lines[0].dist - G.hav(WING.A, WING.B)), 'its length').toBeLessThanOrEqual(0.5);
  });

  // Gate review 2026-09-25: the engine can be in the drawer's Eave/Rake mode
  // ('er') when the switch goes on. On the screen a tap only aims, so 'er'
  // shows as Edit on the bar (whose Flip does that job), and the drawer's
  // Eave/Rake button and its "Tap any Eave or Rake line" bar are hidden —
  // the first cut left that bar up. The perimeter bar's "tap map to trace"
  // goes too. Each is checked shown with the switch off first, and a tap on
  // the line flips it with the switch off: the control for "flips nothing".
  test('Eave/Rake mode as the switch goes on: Edit on the bar, the drawer\'s "tap" bars hidden, a tap on an edge flips nothing', async () => {
    const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; }, sel);
    const types = async () => ((await T.drawState(page)).saved || { lines: [] }).lines.map((l) => l.type);
    const onLine = { lat: WING.A.lat + (WING.B.lat - WING.A.lat) * 0.3, lng: WING.A.lng + (WING.B.lng - WING.A.lng) * 0.3 }; // clear of the length chip
    try {
      // One Eave line A-B, by tap-to-place (switch off).
      await T.resetDrawing(page);
      await T.setView(page, WING.view, WING.zoom);
      await api('setMode', 'line', { lineType: 5 });
      await touch.tap(await T.ll2client(page, WING.A));
      await touch.tap(await T.ll2client(page, WING.B));
      await expect.poll(types, { message: 'one Eave line' }).toEqual([5]);
      await T.quietToasts(page);
      // Perimeter armed, switch off: its bar shows.
      await T.arm(page, 'perim');
      await setTools(page, true);
      expect(await shown('#perimBar'), 'off: the perimeter bar shows').toBe(true);
      // The drawer's Eave/Rake mode, by a finger; its bar shows.
      await tapSel('#modeERBtn');
      expect((await api('state')).mode, 'the engine is in Eave/Rake mode').toBe('er');
      expect(await shown('#erBar'), 'off: the Eave/Rake bar shows').toBe(true);
      await setTools(page, false);
      await touch.tap(await T.ll2client(page, onLine));
      await expect.poll(types, { message: 'off: a tap on the line flips it (Eave -> Rake)' }).toEqual([4]);
      await T.quietToasts(page);
      // Switch on, with the engine in 'er'.
      await setTools(page, true);
      await revealSwitch(page, touch);
      await tapSel('#drawCrosshairSwitch');
      expect(await shown('#modeERBtn'), 'on: the drawer\'s Eave/Rake button is hidden').toBe(false);
      expect(await shown('#erBar'), 'on: its "Tap any Eave or Rake line" bar is hidden').toBe(false);
      await setTools(page, false);
      await expect(page.locator('#view-draw.dr-on .dr-root .dr-bar')).toBeVisible();
      expect(await page.evaluate(() => document.querySelector('.dr-mode[data-dr-mode="edit"]').getAttribute('aria-pressed')), 'on: the bar shows Edit').toBe('true');
      expect((await api('state')).mode, 'the engine is still in Eave/Rake mode').toBe('er');
      await T.setView(page, WING.view, WING.zoom);
      const at = await T.ll2client(page, onLine);
      expect((await T.hitAt(page, at)).ok, `on: a finger there reaches the map (${(await T.hitAt(page, at)).what})`).toBe(true);
      await touch.tap(at);
      await page.waitForTimeout(500);
      expect(await types(), 'on: a tap on the line only aims — nothing flips').toEqual([4]);
      // Outline on the bar leaves 'er'; the perimeter bar's "tap map to trace" stays hidden.
      await tapSel('.dr-mode[data-dr-mode="perim"]');
      expect((await api('state')).mode, 'Outline takes the engine out of Eave/Rake mode').toBe('perim');
      await setTools(page, true);
      expect(await shown('#perimBar'), 'on: the perimeter bar ("tap map to trace") is hidden').toBe(false);
      // Off: the drawer is main's again.
      await revealSwitch(page, touch);
      await tapSel('#drawCrosshairSwitch');
      expect((await screenState(page)).roots, 'off: the screen is gone').toBe(0);
      expect(await shown('#perimBar'), 'off: the perimeter bar is back').toBe(true);
      expect(await shown('#modeERBtn'), 'off: the Eave/Rake button is back').toBe(true);
    } finally {
      if (await page.locator('#map-sidebar-draw.open').count()) await page.locator(TOOLS).tap().catch(() => {});
      await T.quietToasts(page);
      await T.resetDrawing(page);
    }
  });

  test('no page errors on the real engine', async () => {
    expect(pageErrors, 'uncaught page errors').toEqual([]);
  });
});

test.describe.serial('desktop draw (1280, mouse) has no crosshair screen @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  const urls = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await returningUser(context);
    // Opted in, even: a mouse still gets no switch and no screen.
    await crosshairOn(context);
    await installSeamStub(context);
    page = await context.newPage();
    page.on('request', (r) => urls.push(r.url()));
    await T.acceptDialogs(page);
    await T.stubTiles(page);
    await stubNetwork(page);
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
    await T.openDraw(page);
    await page.waitForFunction(() => !!(drawMap && drawMap.nbdDraw), null, { timeout: 10_000 });
    await page.waitForTimeout(500);
  });
  test.afterAll(async () => { if (context) await context.close(); });
  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('pointer: fine — the files arrive with the bundle but build nothing (not even the beta switch, opted in), and click-to-place still works', async () => {
    const d = await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      pref: localStorage.getItem('nbd_draw_crosshair'),
      switches: document.querySelectorAll('#drawCrosshairSwitch, [data-nbd="draw-crosshair-switch"]').length,
      root: document.querySelectorAll('.dr-root').length,
      on: document.getElementById('view-draw').classList.contains('dr-on'),
      barOn: document.body.classList.contains('dr-bar-on'),
      calls: drawMap.nbdDraw.__calls.map((c) => c.fn),
      sidebar: getComputedStyle(document.getElementById('map-sidebar-draw')).position,
      sidebarW: Math.round(document.getElementById('map-sidebar-draw').getBoundingClientRect().width),
    }));
    expect(d.coarse, 'a mouse desktop').toBe(false);
    expect(d.pref, 'the crosshair preference is on').toBe('1');
    expect(d.switches, 'no beta switch in the Tools column').toBe(0);
    expect(urls.some((u) => u.includes('draw-reticle.js')), 'draw-reticle.js rides the drawtool bundle').toBe(true);
    expect(d.root, 'no crosshair screen').toBe(0);
    expect(d.on, '#view-draw.dr-on').toBe(false);
    expect(d.barOn, 'body.dr-bar-on').toBe(false);
    expect(d.calls, 'the screen never touched the seam').toEqual([]);
    expect(d.sidebar, 'the Tools column is untouched').not.toBe('absolute');
    expect(d.sidebarW, 'the 280px Tools column').toBe(280);
    // Click-to-place on the real engine, as before.
    await T.resetDrawing(page);
    await T.setView(page, WING.view, WING.zoom);
    await T.arm(page, 'line');
    const a = await T.ll2client(page, WING.A), b = await T.ll2client(page, WING.B);
    await page.mouse.click(a.x, a.y);
    await page.waitForTimeout(250);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(400);
    const st = await T.drawState(page);
    expect(st.saved && st.saved.lines.length, 'two clicks drew one line').toBe(1);
    expect(Math.abs(st.saved.lines[0].dist - G.hav(WING.A, WING.B)), 'its length').toBeLessThanOrEqual(0.3);
    await T.resetDrawing(page);
  });
});
