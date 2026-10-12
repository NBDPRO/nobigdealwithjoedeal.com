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

test.describe.serial('Mission Control @shard2', () => {
  test('war room: swath, in the path, customer, canvass draft, themes, switch back', async ({ page }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await stubWorld(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });

    const s = Date.now();
    await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZMC', lastName: 'InPath' + st, address: '7 Storm Row, Mason, OH 45040', phone: '5135550188', stage: 'new', lat: 39.1, lng: -84.5 }), s);
    await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZMC', lastName: 'Outside' + st, address: '9 Far Rd, Cleves, OH 45002', phone: '5135550189', stage: 'new', lat: 39.4, lng: -84.9 }), s);
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
    await expect(page.locator('.mc-root .lk-act[data-lk-link="call"]')).toHaveAttribute('href', 'tel:+15135550188');
    await expect(page.locator('.mc-root .lk-act[data-lk-link="text"]')).toHaveAttribute('href', 'sms:+15135550188');
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
    const s = Date.now();
    await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZMC', lastName: 'Phone' + st, address: '7 Storm Row, Mason, OH 45040', phone: '5135550190', stage: 'new', lat: 39.1, lng: -84.5 }), s);
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
    // storm-mode.js rides the lazy 'theme' bundle
    await safeEvaluate(page, () => window.ScriptLoader.loadBundle('theme'));
    await safeWaitForFunction(page, () => !!window.NBDStormMode, null, { timeout: 30_000 });
    const s = Date.now();
    await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZMC', lastName: 'Offer' + st, address: '7 Storm Row, Mason, OH 45040', phone: '5135550191', stage: 'new', lat: 39.1, lng: -84.5 }), s);
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
});
