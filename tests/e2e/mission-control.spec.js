/**
 * tests/e2e/mission-control.spec.js - L02 Mission Control end to end on the
 * emulators (2026-10-12, M2). The NWS feed, the storm reports and the map tiles
 * are STUBBED with an injected scenario, so nothing here depends on the sky or
 * the network, and no SMS / email can go out (the callable plane is aborted).
 *
 *   - choosing the layout mounts the war room: a real Leaflet map, the warning
 *     swath in --red (hail >= 1.75"), the in-path customer, the alert rail
 *   - Customer: hail at the address + next action, Call/Text are tel:/sms: links
 *   - Canvass: turfs cut from the warning, door counts, the script, and the
 *     hand-off is a DRAFT (nothing sent)
 *   - re-themes on themechange (light and dark), at desktop and iPhone width
 *   - the storm banner OFFERS Mission Control (never switches silently), a
 *     company lock removes the offer, and "Switch back" returns the layout
 *
 * @shard2 - runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

// a warning polygon around the test customers (lat, lng) and the NWS GeoJSON shape (lng, lat)
const RING = [[-84.62, 39.02], [-84.62, 39.18], [-84.38, 39.18], [-84.38, 39.02], [-84.62, 39.02]];
function alertsJson() {
  return {
    features: [{
      id: 'urn:e2e:mc1',
      geometry: { type: 'Polygon', coordinates: [RING] },
      properties: {
        id: 'urn:e2e:mc1', event: 'Severe Thunderstorm Warning', status: 'Actual', messageType: 'Alert',
        headline: 'Severe Thunderstorm Warning (e2e)', expires: new Date(Date.now() + 3600_000).toISOString(),
        parameters: { maxHailSize: ['1.75'] }, geocode: { UGC: ['OHC061'] },
      },
    }],
  };
}
// 1x1 fully transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, OPTIONS' };

async function stubWorld(page, opts) {
  const o = opts || {};
  await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
  await page.route(/tile\.openstreetmap\.org|arcgisonline\.com|nationalmap\.gov/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('https://api.weather.gov/**', (route) => {
    const u = route.request().url();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (/\/points\//.test(u)) {
      return route.fulfill({ headers: CORS, contentType: 'application/geo+json', body: JSON.stringify({ properties: { county: 'https://api.weather.gov/zones/county/OHC061', forecastZone: 'https://api.weather.gov/zones/forecast/OHZ078', relativeLocation: { properties: { state: 'OH' } } } }) });
    }
    if (/\/alerts\/active/.test(u)) {
      return route.fulfill({ headers: CORS, contentType: 'application/geo+json', body: JSON.stringify(o.quiet ? { features: [] } : alertsJson()) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.route(/\/api\/storm-report/, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ events: [
      { type: 'hail', magnitude: 1.5, lat: 39.1, lon: -84.5, date: new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 16), city: 'Mason' },
      { type: 'hail', magnitude: 1.0, lat: 39.12, lon: -84.52, date: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 16), city: 'Mason' },
    ] }),
  }));
}

// _saveLead runs a duplicate check (same address / phone as an existing lead
// opens a prompt nobody answers, and the call hangs): every lead here gets an
// address and a phone no other lead in the run has.
function uniqAddr(s, k) { return k + ' Storm Row ' + (s % 1000000) + ', Mason, OH 45040'; }
function uniqPhone(s, k) { return '513' + String(s).slice(-6) + String(k % 10); }

// The emulator sometimes answers a lead create with ALREADY_EXISTS after the
// write actually landed (a retried create under load). The lead is there:
// find it instead of failing the whole run on a duplicate-create echo.
function installSaveHelper() {
  window.__mcSaveLead = async (d) => {
    try { return await window._saveLead(d); } catch (e) {
      if (!/ALREADY_EXISTS/.test(String((e && (e.code || e.message)) || e))) throw e;
      for (let i = 0; i < 20; i++) {
        const m = (window._leads || []).find((l) => l.lastName === d.lastName);
        if (m) return m.id;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw e;
    }
  };
}

function adb() {
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  return getFirestore();
}
// the Day route starts from today's appointments; this spec owns its day (the
// shard shares ONE rep, and other specs leave scheduled leads / appointments).
async function emptyToday(uid) {
  const db = adb();
  const { FieldValue } = require('firebase-admin/firestore');
  const leads = await db.collection('leads').where('userId', '==', uid).get();
  for (const d of leads.docs) {
    const x = d.data();
    if (x.e2eTestData === true && x.scheduledDate) await d.ref.update({ scheduledDate: FieldValue.delete() });
  }
  const appts = await db.collection('appointments').where('repUid', '==', uid).get();
  for (const d of appts.docs) await d.ref.delete();
}

test.describe.serial('Mission Control @shard2', () => {
  test('war room: swath, in the path, customer, canvass draft, themes, switch back', async ({ page }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await stubWorld(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });
    await safeEvaluate(page, installSaveHelper);

    const s = Date.now();
    await safeEvaluate(page, (a) => window.__mcSaveLead({ firstName: 'ZZMC', lastName: 'InPath' + a.s, address: a.addr, phone: a.phone, stage: 'new', lat: 39.1, lng: -84.5 }), { s, addr: uniqAddr(s, 1), phone: uniqPhone(s, 1) });
    await safeEvaluate(page, (a) => window.__mcSaveLead({ firstName: 'ZZMC', lastName: 'Outside' + a.s, address: a.addr, phone: a.phone, stage: 'new', lat: 39.4, lng: -84.9 }), { s, addr: uniqAddr(s, 2), phone: uniqPhone(s, 2) });
    const saved = await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'mission', device: 'desktop' }));
    expect(saved.saved).toBe(true);
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'mission' && !!document.getElementById('nbdMissionRoot'), null, { timeout: 40_000 });

    // a real map with the swath in --red and the in-path customer listed
    await page.locator('.nbd-mv.leaflet-container').waitFor({ state: 'visible', timeout: 40_000 });
    await expect(page.locator('.mc-chip-hot')).toContainText('1 active warning', { timeout: 40_000 });
    await expect(page.locator('.mc-alert-ev')).toContainText('Severe Thunderstorm Warning');
    await expect(page.locator('.mc-alert-sub')).toContainText('Hail up to 1.75"');
    await expect(page.locator('.mc-row-name', { hasText: 'ZZMC' }).first()).toBeVisible();
    await expect(page.locator('.mc-row-name', { hasText: 'Outside' + s })).toHaveCount(0);
    const swath = await page.locator('path.mv-swath--red').first();
    await expect(swath).toBeAttached();
    const fill = await safeEvaluate(page, () => {
      const el = document.querySelector('path.mv-swath--red');
      return { fill: getComputedStyle(el).fill, red: getComputedStyle(document.documentElement).getPropertyValue('--red').trim() };
    });
    expect(fill.fill).toMatch(/^rgb/);
    expect(await page.locator('path.mv-swath--red').count()).toBe(1);
    // positive control: a swath class that should NOT be there is absent
    expect(await page.locator('path.mv-swath--turf').count()).toBe(0);
    // Storm timeline has the two stubbed reports
    await expect(page.locator('.mc-tl-label')).toContainText('2 of 2 reports');
    await page.locator('[data-mc="play"]').click();
    await page.locator('[data-mc="play"]').click();

    // Customer: hail at the address, next action, tel / sms links
    await page.locator('.mc-row', { hasText: 'InPath' + s }).first().click();
    await expect(page.locator('.mc-cust-name')).toContainText('ZZMC');
    await expect(page.locator('.mc-block').first()).toContainText('hail up to 1.75"');
    await expect(page.locator('.mc-block').first()).toContainText('Nearest hail report: 1.5"');
    await expect(page.locator('.mc-fine')).toContainText('not an inspection finding');
    await expect(page.locator('.mc-root .lk-act[data-lk-link="call"]')).toHaveAttribute('href', /^tel:\+1513\d{7}$/);
    await expect(page.locator('.mc-root .lk-act[data-lk-link="text"]')).toHaveAttribute('href', /^sms:\+1513\d{7}$/);
    const small = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdMissionRoot .lk-act, #nbdMissionRoot .mc-row'))
      .filter((e) => e.getBoundingClientRect().height < 55).map((e) => e.className));
    expect(small).toEqual([]);

    // Canvass: turfs cut from the warning, the script, the DRAFT hand-off
    await page.locator('[data-mc="tab"][data-to="canvass"]').click();
    await expect(page.locator('.mc-turf')).toHaveCount(3);
    await expect(page.locator('.mc-script')).toContainText('checking roofs on this street');
    await page.locator('[data-mc="turfs"][data-d="-1"]').click();
    await expect(page.locator('.mc-turf')).toHaveCount(2);
    await expect(page.locator('path.mv-swath--turf').first()).toBeAttached();
    await page.locator('input[data-mc-rep="0"]').fill('E2E Rep');
    await page.locator('[data-mc="sheet"]').click();
    await expect(page.locator('.mc-sheet')).toContainText('Nothing was sent');
    await expect(page.locator('.mc-sheet-text')).toHaveValue(/Turf A - E2E Rep: \d+ known door/);
    await expect(page.locator('.mc-sheet-text')).toHaveValue(/draft, review before sharing/);
    await page.locator('[data-mc="tab"][data-to="watch"]').click();

    // re-themes: the app's mode preference decides light/dark (a theme only
    // supplies the palette), so flip it both ways; the map follows --bg
    for (const mode of ['dark', 'light', 'dark']) {
      await safeEvaluate(page, (m) => { window.ThemeEngine.apply('midnight', false); window.ThemeEngine.setModePref(m); }, mode);
      await safeWaitForFunction(page, (w) => document.querySelector('.nbd-mv') && document.querySelector('.nbd-mv').getAttribute('data-mv-theme') === w, mode, { timeout: 15_000 });
    }
    // the swath is still --red in the dark theme (danger reads the same everywhere)
    const darkFill = await safeEvaluate(page, () => {
      const probe = document.createElement('span'); probe.style.color = 'var(--red)'; document.body.appendChild(probe);
      const red = getComputedStyle(probe).color; probe.remove();
      return { fill: getComputedStyle(document.querySelector('path.mv-swath--red')).fill, red };
    });
    expect(darkFill.fill).toBe(darkFill.red);
    await safeEvaluate(page, () => window.ThemeEngine.setModePref('auto'));

    // Switch back: this layout is the rep's own pick, so it steps out to Classic for the session
    await page.locator('[data-mc="back"]').click();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'classic', null, { timeout: 15_000 });
    expect(await page.locator('#nbdMissionRoot').count()).toBe(0);

    // clean up the pick so later specs start from Classic
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: null, device: 'desktop' }));
  });

  test('iPhone width: panels stack under the map, tap targets, no sideways scroll', async ({ page }) => {
    test.setTimeout(180_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await stubWorld(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });
    await safeEvaluate(page, installSaveHelper);
    const s = Date.now();
    await safeEvaluate(page, (a) => window.__mcSaveLead({ firstName: 'ZZMC', lastName: 'Phone' + a.s, address: a.addr, phone: a.phone, stage: 'new', lat: 39.1, lng: -84.5 }), { s, addr: uniqAddr(s, 3), phone: uniqPhone(s, 3) });
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'mission', device: 'phone' }));
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'mission' && !!document.getElementById('nbdMissionRoot'), null, { timeout: 40_000 });
    await page.locator('.nbd-mv.leaflet-container').waitFor({ state: 'visible', timeout: 40_000 });
    await expect(page.locator('.mc-chip-hot')).toBeVisible({ timeout: 40_000 });
    const geo = await safeEvaluate(page, () => {
      const r = document.querySelector('.mc-root').getBoundingClientRect();
      const map = document.querySelector('.mc-map').getBoundingClientRect();
      const left = document.querySelector('.mc-left').getBoundingClientRect();
      const body = document.querySelector('.mc-body');
      return { w: r.width, mapW: map.width, mapH: map.height, leftTop: left.top, mapBottom: map.bottom, sideways: body.scrollWidth - body.clientWidth };
    });
    expect(geo.mapW).toBeLessThanOrEqual(391);
    expect(geo.mapH).toBeGreaterThan(200);
    expect(geo.leftTop).toBeGreaterThanOrEqual(geo.mapBottom - 1);   // panels are UNDER the map
    expect(geo.sideways).toBeLessThanOrEqual(1);
    const small = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdMissionRoot .mc-tab, #nbdMissionRoot .mc-btn'))
      .filter((e) => e.getBoundingClientRect().height < 39).map((e) => e.className));
    expect(small).toEqual([]);
    await safeEvaluate(page, () => window.ThemeEngine.setModePref('dark'));
    await safeWaitForFunction(page, () => document.querySelector('.nbd-mv').getAttribute('data-mv-theme') === 'dark', null, { timeout: 15_000 });
    await safeEvaluate(page, () => window.ThemeEngine.setModePref('auto'));
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: null, device: 'phone' }));
  });

  test('storm banner OFFERS Mission Control; a company lock removes the offer', async ({ page }) => {
    test.setTimeout(180_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await stubWorld(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine && !!window.ScriptLoader, null, { timeout: 30_000 });
    await safeEvaluate(page, installSaveHelper);
    // storm-mode.js rides the lazy 'theme' bundle
    await safeEvaluate(page, () => window.ScriptLoader.loadBundle('theme'));
    await safeWaitForFunction(page, () => !!window.NBDStormMode, null, { timeout: 30_000 });
    const s = Date.now();
    await safeEvaluate(page, (a) => window.__mcSaveLead({ firstName: 'ZZMC', lastName: 'Offer' + a.s, address: a.addr, phone: a.phone, stage: 'new', lat: 39.1, lng: -84.5 }), { s, addr: uniqAddr(s, 4), phone: uniqPhone(s, 4) });
    // Storm Mode ON (opt in), drafts off so nothing is filed, then poll once
    await safeEvaluate(page, () => { window.NBDStormMode.update({ drafts: false }); window.NBDStormMode.setEnabled(true); return window.NBDStormMode.poll(); });
    const banner = page.locator('#stormModeBanner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    const mc = page.locator('[data-sm-mission]');
    await expect(mc).toBeVisible();
    // not silent: still Classic until the rep taps
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-layout'))).toBe('classic');
    await mc.click();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'mission' && !!document.getElementById('nbdMissionRoot'), null, { timeout: 30_000 });
    // entered by the storm switch: Switch back returns to the rep's own layout
    await page.locator('[data-mc="back"]').click();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'classic', null, { timeout: 15_000 });

    // a company LOCK to Classic: the offer is withheld
    await safeEvaluate(page, () => window.LayoutEngine._setCompany({ defaultLayout: 'classic', locked: true }));
    await safeEvaluate(page, () => window.NBDStormMode.endPreview && 0);
    await safeEvaluate(page, () => window.NBDStormMode.poll());
    await page.waitForTimeout(800);
    await safeEvaluate(page, () => { const b = document.getElementById('stormModeBanner'); return b ? true : false; });
    await expect(page.locator('[data-sm-mission]')).toBeHidden();
    await safeEvaluate(page, () => { window.LayoutEngine._setCompany({ defaultLayout: null, locked: false }); window.NBDStormMode.setEnabled(false); });
  });

  test('day route: numbered stops, shortest order, layers, On my way is a draft behind the text check', async ({ page }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await stubWorld(page, { quiet: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });
    await safeEvaluate(page, installSaveHelper);
    const uid = await safeEvaluate(page, () => window._user.uid);
    await emptyToday(uid);

    // three stops: A near, B far north, C right beside A. By time the order is A, B, C
    // (two long hops); shortest is A, C, B.
    const s = Date.now();
    const defs = [
      { n: 'Aaa', lat: 39.10, lng: -84.50, mins: 60 },
      { n: 'Bbb', lat: 39.30, lng: -84.50, mins: 150 },
      { n: 'Ccc', lat: 39.11, lng: -84.51, mins: 240 },
    ];
    for (const d of defs) {
      const id = await safeEvaluate(page, (a) => window.__mcSaveLead({ firstName: 'ZZRT', lastName: a.n + a.s, address: a.addr, phone: a.phone, stage: 'new', lat: a.lat, lng: a.lng }), { n: d.n, s, lat: d.lat, lng: d.lng, addr: uniqAddr(s, 5 + defs.indexOf(d)), phone: uniqPhone(s, 5 + defs.indexOf(d)) });
      expect(id).toBeTruthy();
      // the save path may geocode over the coordinates; pin them for a deterministic route
      await adb().doc('leads/' + id).update({ lat: d.lat, lng: d.lng });
      const when = new Date(Date.now() + d.mins * 60 * 1000);
      await adb().doc('appointments/rt-' + s + '-' + d.n).set({
        repUid: uid, userId: uid, leadId: id, title: 'Roof inspection', attendeeName: 'ZZRT ' + d.n + s,
        startTime: when, endTime: new Date(when.getTime() + 45 * 60 * 1000), status: 'confirmed', location: uniqAddr(s, 5 + defs.indexOf(d)),
      });
    }
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'mission', device: 'desktop' }));
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'mission' && !!document.getElementById('nbdMissionRoot'), null, { timeout: 40_000 });
    await page.locator('.nbd-mv.leaflet-container').waitFor({ state: 'visible', timeout: 40_000 });
    await page.locator('[data-mc="tab"][data-to="route"]').click();

    // by time: A, B, C numbered 1-3 with estimated drive times
    await expect(page.locator('.mc-stop')).toHaveCount(3, { timeout: 40_000 });
    const names = async () => (await page.locator('.mc-stop .mc-row-name').allInnerTexts()).map((t) => t.replace(/ZZRT |\d+$/g, ''));
    expect(await names()).toEqual(['Aaa', 'Bbb', 'Ccc']);
    await expect(page.locator('.mc-stop .mc-drive').nth(1)).toContainText('(est.)');
    await expect(page.locator('.mc-stop .mc-drive').first()).toHaveText('Start');
    expect(await page.locator('.mv-pin--stop b').allInnerTexts()).toEqual(['1', '2', '3']);
    expect(await page.locator('path.mv-route').count()).toBe(1);
    const byTimeNote = await page.locator('.mc-note strong').first().locator('xpath=..').innerText();
    expect(byTimeNote).toMatch(/3 stops · about \d+ min driving · [\d.]+ mi \(est\.\)/);

    // shortest: A, C, B; says what it saves and that it differs from appointment times
    await page.locator('[data-mc="mode"][data-m="short"]').click();
    await expect.poll(names).toEqual(['Aaa', 'Ccc', 'Bbb']);
    await expect(page.locator('.mc-note').filter({ hasText: 'Saves about' })).toBeVisible();
    await expect(page.locator('.mc-chip-warn', { hasText: 'Order differs from appointment times' })).toBeVisible();
    await page.locator('[data-mc="mode"][data-m="time"]').click();
    await expect.poll(names).toEqual(['Aaa', 'Bbb', 'Ccc']);

    // layers: Crews is off with a reason; Leads adds pins (the swath is a toggle, quiet sky here)
    await expect(page.locator('.mc-layer-off')).toHaveText('Crews');
    await expect(page.locator('.mc-layer-off')).toBeDisabled();
    const before = await page.locator('.nbd-mv .mv-pin--lead').count();
    await safeEvaluate(page, (st) => { (window._leads || []).push({ id: 'zz-layer-' + st, firstName: 'ZZRT', lastName: 'Layer', address: '5 Lead Ln, Mason, OH', lat: 39.2, lng: -84.4, stage: 'new', _stageKey: 'new' }); }, s);
    await page.locator('[data-mc="layer"][data-l="leads"]').click();
    await expect(page.locator('[data-mc="layer"][data-l="leads"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.locator('.nbd-mv .mv-pin--lead').count()).toBeGreaterThan(before);

    // On my way: the text check runs first; the default is blocked (callable plane aborted) and NO draft opens
    await page.locator('.mc-stop').nth(1).click();
    await page.locator('[data-mc="omw"]').click();
    await expect(page.locator('.mc-open-sms')).toHaveCount(0);
    await expect(page.locator('.mc-note').filter({ hasText: /text|texted|Nothing was drafted/ }).first()).toBeVisible();
    // positive control: when the server check says yes, a DRAFT appears, with the sms: link, still nothing sent
    await safeEvaluate(page, () => { window.NBDPhoneShare = { checkText: async () => ({ ok: true }) }; });
    await page.locator('[data-mc="omw"]').click();
    const link = page.locator('.mc-open-sms');
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^sms:\+1513\d{7}\?&body=/);
    const body = decodeURIComponent(href.split('&body=')[1]);
    expect(body).toMatch(/^Hi ZZRT, .*I'm on my way to you now\. I should be there in about \d+ minutes\.$/);
    await expect(page.locator('.mc-fine').filter({ hasText: 'Nothing is sent until you press Send' })).toBeVisible();

    // clean up so later specs start from Classic with an empty day
    await emptyToday(uid);
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: null, device: 'desktop' }));
  });
});
