/**
 * tests/e2e/yard-signs-edit.spec.js — Jo's live-CRM handoff (2026-09-30) #6,
 * the Yard Signs sheet in a real browser on the emulators.
 *
 *  b) Opening "Place sign" does NOT ask for the device's location. The pin
 *     comes from the typed address (geocoded); GPS only on an explicit tap.
 *  c) A redraw error after a successful save shows the success toast only —
 *     never "Could not save the sign" for a sign that was saved.
 *  a) Edit: change the address (re-geocoded) and the note.
 *  d) A future "placing on" date shows the sign as Scheduled.
 *  e) Remove (soft delete): gone from the view, `deleted: true` in Firestore.
 *
 * Nominatim and map tiles are stubbed; the geolocation API is replaced with a
 * counting fake. @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const PINS = {
  '12 Test Ln': { lat: '39.3601', lon: '-84.3099' },
  '77 Moved Rd': { lat: '39.2002', lon: '-84.2002' },
};

async function openSigns(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForLoadState('load');
      await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 15_000 });
      await page.evaluate(() => window.goTo('signs'));
      break;
    } catch (e) { if (!/Execution context was destroyed|navigation/i.test(String(e))) throw e; }
  }
  await expect(page.locator('[data-ys-action="open-place"]')).toBeVisible({ timeout: 20_000 });
}

test.describe.serial('Yard signs — edit, no auto-GPS, scheduled, remove @shard2', () => {
  test.beforeEach(async ({ page }) => {
    const creds = requireTestUser();
    await page.addInitScript(() => {
      try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {}
      // Counting fake: the sheet must not call this unless "Use my location" is tapped.
      window.__geoCalls = 0;
      const fake = { getCurrentPosition(ok) { window.__geoCalls++; setTimeout(() => ok({ coords: { latitude: 39.0101, longitude: -84.0101, accuracy: 8 } }), 20); }, watchPosition() { return 0; }, clearWatch() {} };
      try { Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => fake }); } catch (_) {}
      window.__toasts = [];
    });
    await page.route(/nominatim\.openstreetmap\.org/, (route) => {
      const q = decodeURIComponent((route.request().url().match(/[?&]q=([^&]*)/) || [])[1] || '').replace(/\+/g, ' ');
      const hit = Object.keys(PINS).find((k) => q.includes(k));
      route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(hit ? [{ lat: PINS[hit].lat, lon: PINS[hit].lon, display_name: q, address: {} }] : []) });
    });
    await page.route(/tile\.openstreetmap\.org/, (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await openSigns(page);
    await safeEvaluate(page, () => {
      const orig = window.showToast;
      window.showToast = function (m, t) { window.__toasts.push((t || '') + ':' + m); return orig && orig.apply(this, arguments); };
    });
  });

  const lastSign = (page, stamp) => safeEvaluate(page, (s) => (window.YardSigns.list() || []).find((x) => String(x.note || '').includes(s)) || null, stamp);

  test('place from the desk: no location prompt, pin from the typed address, no false "could not save"', async ({ page }) => {
    const stamp = 'zzq' + Date.now();
    await page.click('[data-ys-action="open-place"]');
    await expect(page.locator('#ysPlaceModal')).toBeVisible();
    await page.waitForTimeout(800);
    expect(await safeEvaluate(page, () => window.__geoCalls), 'opening the sheet did not ask for the location').toBe(0);
    await expect(page.locator('#ysGps')).not.toContainText('Finding you');

    await page.fill('#ysAddr', '12 Test Ln, Mason, OH 45040');
    await page.fill('#ysNote', stamp);
    // Make the post-save redraw throw: the save itself must still report success only.
    await safeEvaluate(page, () => { const L = window.NBDYardSignLogic; window.__origSummary = L.summary; L.summary = () => { throw new Error('redraw boom'); }; });
    await page.click('[data-ys-action="save-place"]');
    await expect(page.locator('#ysPlaceModal')).toHaveCount(0, { timeout: 10_000 });
    await safeEvaluate(page, () => { window.NBDYardSignLogic.summary = window.__origSummary; });
    const toasts = await safeEvaluate(page, () => window.__toasts.slice());
    expect(toasts.some((t) => /Sign placed/.test(t)), 'success toast: ' + JSON.stringify(toasts)).toBe(true);
    expect(toasts.some((t) => /Could not save/.test(t)), 'no false "Could not save" after a saved sign: ' + JSON.stringify(toasts)).toBe(false);
    const s = await lastSign(page, stamp);
    expect(s, 'the sign is in the list').toBeTruthy();
    expect([s.lat, s.lng], 'pinned at the geocoded address, not the device').toEqual([39.3601, -84.3099]);
    expect(await safeEvaluate(page, () => window.__geoCalls)).toBe(0);
  });

  test('"Use my location" is the only way GPS is used, and it wins', async ({ page }) => {
    const stamp = 'zzg' + Date.now();
    await page.click('[data-ys-action="open-place"]');
    await page.fill('#ysAddr', '12 Test Ln, Mason, OH 45040');
    await page.fill('#ysNote', stamp);
    await page.click('[data-ys-action="gps"]');
    await expect(page.locator('#ysGps')).toContainText('Pinned where you are standing', { timeout: 5_000 });
    expect(await safeEvaluate(page, () => window.__geoCalls)).toBe(1);
    await page.click('[data-ys-action="save-place"]');
    await expect(page.locator('#ysPlaceModal')).toHaveCount(0, { timeout: 10_000 });
    const s = await lastSign(page, stamp);
    expect([s.lat, s.lng], 'tapped GPS pin used').toEqual([39.0101, -84.0101]);
  });

  test('edit: new address re-pins, future "placing on" makes it Scheduled; then remove it', async ({ page }) => {
    const stamp = 'zze' + Date.now();
    await page.click('[data-ys-action="open-place"]');
    await page.fill('#ysAddr', '12 Test Ln, Mason, OH 45040');
    await page.fill('#ysNote', stamp);
    await page.click('[data-ys-action="save-place"]');
    await expect(page.locator('#ysPlaceModal')).toHaveCount(0, { timeout: 10_000 });
    const s0 = await lastSign(page, stamp);

    // Edit
    await page.click(`[data-ys-action="edit"][data-ys-id="${s0.id}"]`);
    await expect(page.locator('#ysPlaceModal')).toContainText('Edit yard sign');
    await expect(page.locator('#ysAddr')).toHaveValue('12 Test Ln, Mason, OH 45040');
    await page.fill('#ysAddr', '77 Moved Rd, Lebanon, OH 45036');
    await page.fill('#ysNote', stamp + ' moved');
    const future = await safeEvaluate(page, () => { const d = new Date(Date.now() + 3 * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
    await page.fill('#ysPlaceOn', future);
    await page.locator('#ysPlaceOn').dispatchEvent('change');
    await expect(page.locator('#ysDue')).toContainText('Goes out');
    await page.click('[data-ys-action="save-place"]');
    await expect(page.locator('#ysPlaceModal')).toHaveCount(0, { timeout: 10_000 });
    const s1 = await lastSign(page, stamp);
    expect(s1.id).toBe(s0.id);
    expect(s1.note).toBe(stamp + ' moved');
    expect([s1.lat, s1.lng], 're-geocoded to the new address').toEqual([39.2002, -84.2002]);
    expect(await safeEvaluate(page, (x) => window.NBDYardSignLogic.statusOf(x), s1), 'future placing-on → Scheduled').toBe('scheduled');
    await expect(page.locator('#signsScroll'), 'Scheduled section shown').toContainText('Scheduled to go out');
    // Firestore agrees (status stays "out"; scheduled is derived).
    const stored = await safeEvaluate(page, async (id) => { const d = await window.getDoc(window.doc(window.db, 'yardSigns', id)); const v = d.data(); return { status: v.status, address: v.address, placed: v.placedAt && v.placedAt.toMillis ? v.placedAt.toMillis() : null }; }, s0.id);
    expect(stored.status).toBe('out');
    expect(stored.address).toBe('77 Moved Rd, Lebanon, OH 45036');
    expect(stored.placed > Date.now() + 86400000, 'placedAt stored in the future').toBe(true);

    // Remove
    await page.click(`[data-ys-action="edit"][data-ys-id="${s0.id}"]`);
    await page.click('[data-ys-action="remove"]');
    await page.click('#nbdConfirmModal .nbd-confirm-ok');
    await expect.poll(() => lastSign(page, stamp), { timeout: 10_000 }).toBeNull();
    const del = await safeEvaluate(page, async (id) => { const d = await window.getDoc(window.doc(window.db, 'yardSigns', id)); return d.exists() ? d.data().deleted : 'hard-deleted'; }, s0.id);
    expect(del, 'soft-deleted, not hard-deleted').toBe(true);
  });

  // 2026-09-30, Jo: "no yard sign markers … for the map". A sign saved with
  // lat/lng null passed the old isFinite() check (isFinite(null) is true) and
  // Leaflet threw on it, so every pin after it — often all of them — was
  // never drawn. The real data had two such signs.
  test('map: a sign with no location never blanks the map; one tap pins it from its address', async ({ page }) => {
    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
    const adb = getFirestore();
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const now = Date.now(), tag = 'zzmap' + now;
    const base = { userId: who.uid, companyId: who.co, status: 'out', durationDays: 14, extensions: 0, placedAt: new Date(now - 86400000) };
    // The no-location sign is due FIRST, so the old code hit it before any pin.
    await adb.collection('yardSigns').doc(tag + 'N1').set(Object.assign({}, base, { address: '999 Nowhere ' + tag, lat: null, lng: null, dueAt: new Date(now + 2 * 86400000), note: tag }));
    await adb.collection('yardSigns').doc(tag + 'P1').set(Object.assign({}, base, { address: 'Pinned ' + tag, lat: 39.1956, lng: -84.5778, dueAt: new Date(now + 9 * 86400000), note: tag }));
    await adb.collection('yardSigns').doc(tag + 'N2').set(Object.assign({}, base, { address: '77 Moved Rd ' + tag, lat: null, lng: null, dueAt: new Date(now + 10 * 86400000), note: tag }));
    await safeEvaluate(page, () => window.YardSigns.init());
    const pin = (addr) => page.locator('#ysMap .ys-map-pin[title="' + addr + '"]');
    await expect(pin('Pinned ' + tag), 'the real pin is drawn even though a no-location sign sorts first').toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#signsScroll'), 'the page says which signs are off the map').toContainText("aren't on the map");
    // One tap: N2's address geocodes (stubbed), N1's does not.
    await page.click('[data-ys-action="pin-missing"]');
    await expect.poll(async () => (await adb.collection('yardSigns').doc(tag + 'N2').get()).data().lat, { timeout: 10_000 }).toBe(39.2002);
    await expect(pin('77 Moved Rd ' + tag), 'the newly placed sign shows on the map').toHaveCount(1, { timeout: 10_000 });
    const n1 = (await adb.collection('yardSigns').doc(tag + 'N1').get()).data();
    expect(n1.lat, 'an address that cannot be found is left alone (never pinned at 0,0)').toBeNull();
    const toasts = await safeEvaluate(page, () => window.__toasts.slice());
    expect(toasts.some((t) => /placed on the map/.test(t) && /could not be found/.test(t)), 'the result is reported: ' + JSON.stringify(toasts)).toBe(true);
    // The edit sheet no longer treats a null pin as saved.
    await page.click('[data-ys-action="edit"][data-ys-id="' + tag + 'N1"]');
    await expect(page.locator('#ysGps')).toContainText('Pin comes from the address');
    await page.click('[data-ys-action="close-place"]');
  });

  // 2026-09-30, Jo: tap a sign's card → the map snaps to that sign; zoomed
  // out, every sign stays visible/findable without crowding (nearby signs
  // merge into one "🪧 N" bubble that splits as you zoom in).
  test('map: nearby signs cluster; tapping a sign card flies to it (neighbourhood zoom, not rooftop)', async ({ page }) => {
    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
    const adb = getFirestore();
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const now = Date.now(), tag = 'zzcl' + now;
    const base = { userId: who.uid, companyId: who.co, status: 'out', durationDays: 14, extensions: 0, placedAt: new Date(now - 86400000), dueAt: new Date(now + 9 * 86400000), note: tag };
    // Two neighbours ~40 m apart, and one across town.
    await adb.collection('yardSigns').doc(tag + 'A').set(Object.assign({}, base, { address: 'Neighbour A ' + tag, lat: 39.30000, lng: -84.30000 }));
    await adb.collection('yardSigns').doc(tag + 'B').set(Object.assign({}, base, { address: 'Neighbour B ' + tag, lat: 39.30030, lng: -84.30010 }));
    await adb.collection('yardSigns').doc(tag + 'F').set(Object.assign({}, base, { address: 'Across town ' + tag, lat: 39.10000, lng: -84.60000 }));
    await safeEvaluate(page, () => window.YardSigns.init());
    await page.waitForTimeout(600);
    const clusterTexts = () => safeEvaluate(page, () => [...document.querySelectorAll('#ysMap .ys-map-cluster')].map((c) => c.textContent.trim()));
    await expect.poll(async () => (await clusterTexts()).some((t) => /🪧\s*\d+/.test(t)), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('#ysMap .ys-map-pin[title="Neighbour A ' + tag + '"]'), 'zoomed out, the two neighbours are merged, not stacked').toHaveCount(0);
    if (process.env.YS_SHOTS) await page.locator('#ysMap').screenshot({ path: process.env.YS_SHOTS + '/ys-zoomed-out.png' });
    // Tap A's card (its text, not a button).
    await page.locator('.ys-row[data-ys-id="' + tag + 'A"] div[style*="font-weight:700"]').first().click();
    await expect(page.locator('#ysMap .ys-map-pin[title="Neighbour A ' + tag + '"]'), 'tapping the card splits the sign out and shows it').toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#ysMap .leaflet-popup-content'), 'its popup opens').toContainText('Neighbour A ' + tag, { timeout: 10_000 });
    const zoom = await safeEvaluate(page, () => { const m = document.getElementById('ysMap'); return m && m._leaflet_id ? null : null; });
    void zoom;
    if (process.env.YS_SHOTS) await page.locator('#ysMap').screenshot({ path: process.env.YS_SHOTS + '/ys-focused.png' });
    // A sign with no pin says so instead of doing nothing.
    await adb.collection('yardSigns').doc(tag + 'N').set(Object.assign({}, base, { address: 'No pin ' + tag, lat: null, lng: null }));
    await safeEvaluate(page, () => window.YardSigns.init());
    await page.locator('.ys-row[data-ys-id="' + tag + 'N"] div[style*="font-weight:700"]').first().click();
    await expect.poll(() => safeEvaluate(page, () => window.__toasts.slice(-1)[0] || ''), { timeout: 5_000 }).toMatch(/no map location yet/);
  });
});
