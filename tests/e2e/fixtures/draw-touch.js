// tests/e2e/fixtures/draw-touch.js — real-touch harness for the Draw view
// (docs/pro/js/maps-routing.js), shared by every tests/e2e/phone-draw-*.spec.js.
//
// 2026-09-25, draw lane L1. The phone audit found the Draw tool's failures
// only with a real finger: synthetic DOM events and Playwright's
// locator.tap() never produce a finger ROLL, a slow drag, a flick or a
// pinch, and the canvas renderer draws dots with no DOM element to tap.
// So input here goes through CDP Input.dispatchTouchEvent (the browser then
// synthesises click / pan / pinch itself, exactly as on a phone — the
// pattern phone-pipeline.spec.js and phone-chrome.spec.js already use).
//
// Also here, so no spec depends on imagery or the network:
//   - stubTiles(): Google / Esri / OSM tile requests answer a 256px PNG.
//   - WING: a fixed z21 geometry fixture (the audit's 4-corner wing).
//   - ll2client(): lat/lng -> client px through drawMap.latLngToContainerPoint.
//   - sampleTimers(): wraps window.setTimeout to count calls by delay.
//
// No @playwright/test import on purpose: tests/draw-geom.test.js (a plain
// node suite) requires WING from here.
'use strict';

const zlib = require('zlib');
const { autoDialogs } = require('./dialogs');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

// Context options for a phone. bypassCSP comes from playwright.config.js
// when PLAYWRIGHT_BASE_URL is local (the emulator CSP has no carve-out).
function phoneContextOptions(width, height) {
  return {
    viewport: { width: width, height: height || 860 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    userAgent: PHONE_UA,
  };
}

// ── Geometry fixture ───────────────────────────────────────────────
// The audit wing (phone audit 2026-09-25): four roof corners measured as z21
// pixel offsets on the rig, independently 1077.7 sf with sides 40.5 / 25.6 /
// 41.0 / 27.2 ft; the app computes 1075 sf (its haversine uses the mean earth
// radius). Re-anchored to lng -84.17, off the demo lead's geocode — only
// latitude changes a length or an area, so every number is unchanged.
// Taps are converted from these lat/lngs at run time, so the fixture holds
// at any viewport width.
const WING = Object.freeze({
  zoom: 21,
  view: Object.freeze({ lat: 39.16760509549959, lng: -84.1700509619713 }),
  A: Object.freeze({ lat: 39.16764590609215, lng: -84.17012069940567 }),
  B: Object.freeze({ lat: 39.167636548251366, lng: -84.16997787177563 }),
  C: Object.freeze({ lat: 39.167566364405765, lng: -84.16998055398464 }),
  D: Object.freeze({ lat: 39.167571563211546, lng: -84.17012539327145 }),
  // What the audit measured, for reference in assertions and messages.
  expected: Object.freeze({ appAreaSf: 1075, independentAreaSf: 1077.66, sidesFt: Object.freeze([40.5, 25.6, 41.0, 27.2]), gutterDcbFt: 66.6 }),
});

// ── Hermetic tiles ─────────────────────────────────────────────────
// A real, decodable 256x256 PNG (colour type 2, one IDAT). Built here rather
// than committed as a binary so it cannot silently rot (binary assets need a
// render check — the spec asserts a stubbed tile decodes at 256px).
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const TILE_PNG = solidPng(256, [52, 70, 56]);
const TILE_HOSTS = [
  /^https:\/\/mt[0-3]\.google\.com\//,
  /^https:\/\/server\.arcgisonline\.com\//,
  /^https:\/\/[abc]\.tile\.openstreetmap\.org\//,
];
// Register BEFORE the first navigation. Counts served tiles on page.__drawTiles.
async function stubTiles(page) {
  page.__drawTiles = 0;
  const fulfil = (route) => {
    page.__drawTiles++;
    return route.fulfill({ status: 200, contentType: 'image/png', body: TILE_PNG, headers: { 'access-control-allow-origin': '*' } });
  };
  for (const re of TILE_HOSTS) await page.route(re, fulfil);
}

// ── Page helpers ───────────────────────────────────────────────────
// clearDraw() asks through native confirm() in a browser tab; Playwright
// dismisses unhandled dialogs (confirm -> false), which would silently skip
// the clear. Accept them for the page's lifetime.
// Since #3221 clearDraw() asks through nbdConfirm, an in-tab DOM dialog in every browser,
// so the in-tab one is answered too (fixtures/dialogs.js); await this.
async function acceptDialogs(page) {
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await autoDialogs(page);
}

// Open the Draw view with no restored drawing and no first-use shortcut hint
// (a 6s overlay inside .map-area). `nbd_draw_default` is the no-address
// autosave key (maps-routing.js _drawStorageKey).
async function openDraw(page) {
  await page.evaluate(() => {
    try { localStorage.removeItem('nbd_draw_default'); localStorage.setItem('nbd_draw_hint_shown', '1'); } catch (e) { /* storage blocked */ }
    window.goTo('draw');
  });
  await page.waitForFunction(() => typeof drawMap !== 'undefined' && drawMap
    && !!document.querySelector('#drawMap .leaflet-map-pane')
    && typeof window.setDrawMode === 'function' && typeof window.clearDraw === 'function'
    && drawMap.getSize().y > 200, null, { timeout: 20_000 });
  // initDrawMap re-runs invalidateSize at 100/500/1500ms; let those land
  // before any view is set, so nothing re-centres under a finger.
  await page.waitForTimeout(1700);
  await closeDrawer(page);
}

// The phone Tools drawer squashes the map when open (374px at 412x860).
async function closeDrawer(page) {
  const open = await page.evaluate(() => {
    const sb = document.getElementById('map-sidebar-draw');
    return !!(sb && sb.classList.contains('open'));
  });
  if (!open) return;
  await page.locator('#view-draw .map-toggle-btn').tap();
  await page.waitForTimeout(600);
}

async function setView(page, ll, zoom) {
  await page.evaluate(([lat, lng, z]) => { drawMap.setView([lat, lng], z, { animate: false }); }, [ll.lat, ll.lng, zoom]);
  await page.waitForTimeout(350);
}

// lat/lng -> client (viewport) px, unrounded.
async function ll2client(page, ll) {
  return page.evaluate(([lat, lng]) => {
    const p = drawMap.latLngToContainerPoint([lat, lng]);
    const r = drawMap.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [ll.lat, ll.lng]);
}
async function client2ll(page, pt) {
  return page.evaluate(([x, y]) => {
    const r = drawMap.getContainer().getBoundingClientRect();
    const ll = drawMap.containerPointToLatLng([x - r.left, y - r.top]);
    return { lat: ll.lat, lng: ll.lng };
  }, [pt.x, pt.y]);
}
async function mapBox(page) {
  return page.evaluate(() => {
    const r = drawMap.getContainer().getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

// What a finger at (x, y) would land on. ok = the map surface itself, not a
// control, marker/label, button or overlay (those swallow the tap — audit H4).
async function hitAt(page, pt) {
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const map = document.getElementById('drawMap');
    const inMap = !!el && !!map && map.contains(el);
    const blocked = !!el && !!el.closest('.leaflet-marker-icon, .leaflet-control, .leaflet-popup, button, a, input, select');
    return { ok: inMap && !blocked, what: el ? el.tagName + (el.id ? '#' + el.id : '') + '.' + String(el.className || '').split(' ')[0] : 'nothing' };
  }, [pt.x, pt.y]);
}

// Draw mode + armed. Mode switching and arming go through the same window /
// registry handlers the drawer's buttons call; the drawer UI itself is what
// the later lanes replace, so the harness does not drive it.
async function arm(page, mode) {
  await page.evaluate((m) => {
    const ids = { line: 'modeLineBtn', perim: 'modePerimBtn', gutter: 'modeGutterBtn' };
    window.setDrawMode(m, document.getElementById(ids[m]));
    const on = /Stop/.test((document.getElementById('drawToggle') || {}).textContent || '');
    if (!on) window.__NBD_CALL_REGISTRY.toggleDraw();
  }, mode);
}

// Toasts ("Facet 1 closed — 1075 sf") float over the lower map for ~2.6s
// and would swallow a tap there. Close them the way a rep would.
async function quietToasts(page) {
  for (let i = 0; i < 8; i++) {
    const close = page.locator('#toastContainer .toast-close').first();
    if (!(await close.count())) return;
    await close.tap({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

// Disarm, then Clear (answers its confirm). setDrawMode first: it drops a
// pending Eave/Rake choice before clearDraw runs.
async function resetDrawing(page) {
  await page.evaluate(async () => {
    window.setDrawMode('line', document.getElementById('modeLineBtn'));
    await window.clearDraw();
    try { localStorage.removeItem('nbd_draw_default'); } catch (e) { /* storage blocked */ }
  });
}

// Everything a spec asserts on, read the way the app exposes it: Leaflet
// layers, the #cr-* / #gr-* readout text (itself a contract — 8+ consumers
// parseFloat it) and the localStorage autosave (the unrounded line dists and
// the committed points).
async function drawState(page) {
  return page.evaluate(() => {
    const txt = (id) => ((document.getElementById(id) || {}).textContent || '').trim();
    let dots = 0, rings = 0, lines = 0, polys = 0;
    drawMap.eachLayer((l) => {
      if (l instanceof L.CircleMarker && !(l instanceof L.Circle)) { if (l.options.radius <= 8) dots++; else rings++; }
      else if (l instanceof L.Polygon) polys++;
      else if (l instanceof L.Polyline) lines++;
    });
    let saved = null;
    try {
      const addr = ((document.getElementById('drawSearch') || {}).value || '').trim();
      const raw = localStorage.getItem('nbd_draw_' + (addr ? addr.replace(/\s+/g, '_').substring(0, 60) : 'default'));
      saved = raw ? JSON.parse(raw) : null;
    } catch (e) { saved = null; }
    const rc = document.getElementById('reChooser');
    const c = drawMap.getCenter();
    return {
      zoom: drawMap.getZoom(), center: { lat: c.lat, lng: c.lng },
      dots, rings, lines, polys,
      text: { base: txt('cr-base'), pitched: txt('cr-pitched'), waste: txt('cr-waste'), sq: txt('cr-sq'), gutter: txt('gr-total'), ds: txt('gr-ds') },
      pitch: (document.getElementById('pitchSel') || {}).value, waste: (document.getElementById('wasteSel') || {}).value,
      reChooserVisible: !!(rc && rc.classList.contains('visible')),
      // textContent, not innerText: the rows sit in the (closed) phone drawer.
      lineLens: [...document.querySelectorAll('#lineList .line-item .line-len')].map((e) => e.textContent.trim()),
      saved,
    };
  });
}

// Wrap window.setTimeout for `ms` and count calls, total and by delay.
async function sampleTimers(page, ms) {
  return page.evaluate(async (dur) => {
    const orig = window.setTimeout;
    const byDelay = {};
    let total = 0;
    window.setTimeout = function (fn, d, ...a) { total++; const k = String(d === undefined ? 0 : d); byDelay[k] = (byDelay[k] || 0) + 1; return orig.call(this, fn, d, ...a); };
    try { await new Promise((r) => orig(r, dur)); } finally { window.setTimeout = orig; }
    return { total, byDelay };
  }, ms);
}

// ── Touch ──────────────────────────────────────────────────────────
// One CDP session per page. Coordinates are client px (floats are fine).
async function touchSession(page) {
  const cdp = await page.context().newCDPSession(page);
  const tp = (pts) => pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 8, radiusY: 8, force: 1 }));
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: tp(pts) });
  const wait = (ms) => page.waitForTimeout(ms);
  return {
    cdp,
    // A finger tap. roll = px the contact point creeps diagonally between
    // down and up (real fingertips roll 2-12px); holdMs = contact time.
    async tap(pt, opts) {
      const o = Object.assign({ roll: 0, holdMs: 60, settleMs: 450 }, opts || {});
      await send('touchStart', [pt]);
      if (o.roll) {
        await wait(Math.max(10, o.holdMs / 3));
        await send('touchMove', [{ x: pt.x + o.roll / 2 * 0.7071, y: pt.y + o.roll / 2 * 0.7071 }]);
        await wait(20);
        await send('touchMove', [{ x: pt.x + o.roll * 0.7071, y: pt.y + o.roll * 0.7071 }]);
        await wait(Math.max(10, o.holdMs - o.holdMs / 3 - 20));
      } else {
        await wait(o.holdMs);
      }
      await send('touchEnd', []);
      await wait(o.settleMs);
    },
    // A slow one-finger pan: >= 20 moves at ~16ms (a deliberate drag, not a
    // flick). holdEndMs keeps the finger down at the end before lifting.
    async pan(from, to, opts) {
      const o = Object.assign({ steps: 24, stepMs: 16, holdEndMs: 0, settleMs: 400 }, opts || {});
      await send('touchStart', [from]);
      for (let i = 1; i <= o.steps; i++) {
        await send('touchMove', [{ x: from.x + (to.x - from.x) * i / o.steps, y: from.y + (to.y - from.y) * i / o.steps }]);
        await wait(o.stepMs);
      }
      if (o.holdEndMs) await wait(o.holdEndMs);
      await send('touchEnd', []);
      await wait(o.settleMs);
    },
    // A fast flick: few big moves, released while moving (inertia coasts).
    async flick(from, to, opts) {
      const o = Object.assign({ steps: 3, stepMs: 8, settleMs: 0 }, opts || {});
      await send('touchStart', [from]);
      for (let i = 1; i <= o.steps; i++) {
        await send('touchMove', [{ x: from.x + (to.x - from.x) * i / o.steps, y: from.y + (to.y - from.y) * i / o.steps }]);
        await wait(o.stepMs);
      }
      await send('touchEnd', []);
      if (o.settleMs) await wait(o.settleMs);
    },
    // Two fingers on a horizontal line through `center`, spread d0 -> d1 px
    // (d1 > d0 zooms in, d1 < d0 zooms out).
    async pinch(center, d0, d1, opts) {
      const o = Object.assign({ steps: 12, stepMs: 20, settleMs: 700 }, opts || {});
      const at = (d) => [{ x: center.x - d / 2, y: center.y }, { x: center.x + d / 2, y: center.y }];
      await send('touchStart', at(d0));
      for (let i = 1; i <= o.steps; i++) { await send('touchMove', at(d0 + (d1 - d0) * i / o.steps)); await wait(o.stepMs); }
      await send('touchEnd', []);
      await wait(o.settleMs);
    },
    async detach() { await cdp.detach().catch(() => {}); },
  };
}

module.exports = {
  PHONE_UA, phoneContextOptions, WING, TILE_PNG, solidPng, stubTiles,
  acceptDialogs, openDraw, closeDrawer, setView, ll2client, client2ll, mapBox, hitAt,
  arm, quietToasts, resetDrawing, drawState, sampleTimers, touchSession,
};
