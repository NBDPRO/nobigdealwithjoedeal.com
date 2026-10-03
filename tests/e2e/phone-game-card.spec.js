// tests/e2e/phone-game-card.spec.js — the OPTIONAL game card (Jo, 2026-10-03).
//
// Installed iPhone app at 390 × 844:
//   - off by default: Home shows no game card;
//   - Settings › Appearance › Game mode turns it on; avatar picks save to
//     userSettings/{uid}.game at once and survive a reload;
//   - the Home card shows level, the XP bar, this week vs last week and the
//     breakdown — from getGameCard (answered in the browser here, so nothing
//     reads production); every tap target fits and is reachable;
//   - turning it off removes the card.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _db = null;
function adb() {
  if (_db) return _db;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _db = getFirestore();
  return _db;
}
async function reachable(locator) {
  await locator.page().evaluate(() => document.querySelectorAll('.toast-container .toast, #toast.toast, [id^="toast-"]').forEach((t) => t.remove()));
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (h === el || el.contains(h));
  });
}

const CARD = { totalXp: 1840, level: 7, title: 'Roof boss', levelFloor: 1400, levelNext: 2800, week: { start: '2026-09-28', xp: 410 }, lastWeek: { start: '2026-09-21', xp: 355 },
  breakdown: [{ kind: 'task', label: 'Follow-ups done', count: 11, xp: 110 }, { kind: 'collected', label: 'Money collected', count: 6000, xp: 60 }], partial: [] };

test.describe('phone: optional game card @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('off by default; Settings turns it on; avatar saves and survives reload; Home card; off removes it', async ({ page }) => {
    test.setTimeout(150_000);
    const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    let calls = 0;
    await page.route(/getGameCard/, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      calls++;
      await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ result: CARD }) });
    });
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (_) {} });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.NBDGameCard && typeof window.goTo === 'function'), null, { timeout: 60_000 });
    const uid = await safeEvaluate(page, () => window._user.uid);
    await adb().doc('userSettings/' + uid).set({ game: { enabled: false } }, { merge: true });
    await page.reload();
    await safeWaitForFunction(page, () => !!(window._user && window.NBDGameCard && window.NBDGameCard._state.settings), null, { timeout: 60_000 });

    // Off by default: no card, no XP call.
    await expect(page.locator('#homeGameCard')).toBeHidden();
    expect(calls, 'nothing is fetched while it is off').toBe(0);

    // Settings › Appearance › Game mode.
    await page.evaluate(() => { window.goTo('settings'); });
    await safeWaitForFunction(page, () => typeof window.switchSettingsTab === 'function', null, { timeout: 30_000 });
    await page.locator('#stab-appearance').tap();
    const sw = page.locator('#gcEnabled');
    await expect(sw).toBeAttached({ timeout: 15_000 });
    await sw.scrollIntoViewIfNeeded();
    await sw.check();
    await expect.poll(async () => (((await adb().doc('userSettings/' + uid).get()).data() || {}).game || {}).enabled, { timeout: 10_000 }).toBe(true);
    // Pick a red hard hat and a ladder; each saves at once.
    const red = page.locator('#gameSettingsMount [data-key="hatColor"][data-val="2"]');
    await red.scrollIntoViewIfNeeded();
    expect(await reachable(red), 'a swatch is tappable at 390').toBe(true);
    const box = await red.boundingBox();
    expect(box.width >= 36 && box.height >= 36, 'swatches are at least 36px').toBe(true);
    await red.tap();
    await page.locator('#gameSettingsMount [data-key="tool"][data-val="ladder"]').tap();
    await expect.poll(async () => JSON.stringify(((((await adb().doc('userSettings/' + uid).get()).data() || {}).game || {}).avatar) || {}), { timeout: 10_000 })
      .toContain('"hatColor":2');
    await expect.poll(async () => ((((await adb().doc('userSettings/' + uid).get()).data() || {}).game || {}).avatar || {}).tool, { timeout: 10_000 }).toBe('ladder');

    // Home card.
    await page.evaluate(() => window.goTo('home'));
    const card = page.locator('#homeGameCard');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Level 7 · Roof boss');
    await expect(card).toContainText('This week');
    await expect(card).toContainText('410 XP');
    await expect(card).toContainText('Last week (your ghost)');
    await expect(card).toContainText('Ahead of your ghost by 55 XP');
    await expect(card).toContainText('Follow-ups done (11)');
    await expect(card).toContainText('Money collected ($6,000)');
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the card fits at 390').toBe(true);
    await expect(page.locator('#homeGameCard .gc-fill')).toHaveClass(/gc-w30/);   // (1840-1400)/(2800-1400) = 31% → 30

    // Survives a reload (userSettings, not localStorage).
    await page.reload();
    await safeWaitForFunction(page, () => !!(window.NBDGameCard && window.NBDGameCard._state.settings && window.NBDGameCard._state.settings.enabled), null, { timeout: 60_000 });
    await expect(page.locator('#homeGameCard')).toBeVisible({ timeout: 15_000 });
    const av = await page.evaluate(() => window.NBDGameCard._state.settings.avatar);
    expect(av.hatColor === 2 && av.tool === 'ladder', 'avatar picks survive a reload').toBe(true);

    // Off again → gone.
    await page.evaluate(() => { window.goTo('settings'); });
    await page.locator('#stab-appearance').tap();
    await page.locator('#gcEnabled').uncheck();
    await page.evaluate(() => window.goTo('home'));
    await expect(page.locator('#homeGameCard')).toBeHidden();
    await adb().doc('userSettings/' + uid).set({ game: { enabled: false } }, { merge: true });
  });
});
