// tests/e2e/phone-estimate-from-lead.spec.js — an estimate from a lead on the
// installed iPhone app (CRM phone audit 2026-10-07 #5; batch D, 2026-10-08).
//
// 390 × 844, standalone rules forced, real taps, on the emulator:
//   - the customer page's Build estimate opens the V3 wizard for THAT lead
//     (Customer step skipped) and the header Close reads "‹ Back to <name>";
//   - a preset picked on Package answers Shingle & add-ons: Next skips it and
//     "Looks right → Review" lands on Review with the same total;
//   - jumping back to Shingle & add-ons shows the loaded preset, not the
//     preset question again (one tap reopens the presets);
//   - Close returns to that customer's page, not the dashboard.
// Nothing here sends anything: no Send to homeowner, no Cloud Function.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _app = null;
function admin() {
  if (_app) return _app;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _app = { db: getFirestore(), auth: getAuth() };
  return _app;
}
async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
    }
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    return css.length;
  });
}
const title = (page) => page.locator('#estV2Modal .v3-title').innerText().then((t) => t.trim().toUpperCase()).catch(() => '');

test.describe('phone: estimate from a lead returns to the lead; the preset is asked once @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('Build estimate → wizard for that lead → Looks right → Review → Close back on the customer', async ({ page }) => {
    test.setTimeout(180_000);
    const { db, auth } = admin();
    const user = await auth.getUserByEmail(creds.email);
    const uid = user.uid;
    const co = ((user.customClaims || {}).companyId) || uid;
    const s = Date.now();
    const lead = (await db.collection('leads').add({ userId: uid, companyId: co, e2eTestData: true, deleted: false, meter: 'manual', createdAt: new Date(),
      firstName: 'Zelda', lastName: 'FromLead' + s, address: String(s).slice(-4) + ' Estimate Way, Mason, OH 45040', phone: '5135550191', email: 'e2e-fromlead-' + s + '@nbd.test', stage: 'inspected', jobType: 'cash' })).id;
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
      } catch (e) { /* storage blocked */ }
    });
    await loginAs(page, creds);
    await page.goto('/pro/customer.html?id=' + lead);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 30_000 });
    await forceStandalone(page);

    // 1. Build estimate opens the wizard for THIS lead.
    const build = page.locator('[data-action="_openInDashboardEstimate"]').first();
    await build.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await build.tap();
    await page.waitForURL(/\/pro\/dashboard/, { timeout: 30_000 });
    await expect(page.locator('#estV2Modal.open.v3-on')).toBeVisible({ timeout: 30_000 });
    await forceStandalone(page);
    await expect.poll(() => title(page), { message: 'the Customer step is skipped (prefilled from the lead)', timeout: 15_000 }).toBe('MEASURE');
    await expect(page.locator('#v2custName')).toHaveValue('Zelda FromLead' + s);
    await expect(page.locator('#estV2Modal .v2-close')).toHaveText('‹ Back to Zelda');

    // 2. Measure → Package with only the area typed.
    await page.locator('#v2rawSqft').fill('2400');
    await page.locator('#v2rawSqft').dispatchEvent('input');
    for (const t of ['MEASURE', 'ROOF LINES', 'ROOF DETAILS', 'PENETRATIONS & FLASHING']) {
      await expect.poll(() => title(page)).toBe(t);
      await page.locator('#estV2Modal .v3-next').tap();
    }
    await expect.poll(() => title(page)).toBe('PACKAGE');
    await expect(page.locator('#estV2Modal [data-v3-act="looks-right"]'), 'no shortcut before the roof system is loaded').toHaveCount(0);
    await page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]').tap();
    await page.locator('#estV2Modal .v3-pkg .v3-tier[data-v3-val="better"]').tap();
    const looks = page.locator('#estV2Modal [data-v3-act="looks-right"]');
    await expect(looks).toBeVisible();
    const lb = await looks.boundingBox();
    expect(Math.round(lb.height), 'Looks right is thumb-sized').toBeGreaterThanOrEqual(44);
    await expect(page.locator('#estV2Modal .v3-next'), 'Next skips the answered add-ons step').toHaveText(/^Photos/);
    const total = (await page.locator('#v2total').innerText()).trim();
    expect(total).toMatch(/^\$[\d,]+$/);

    // 3. Edit shingle & add-ons: the preset is NOT asked again.
    await page.locator('#estV2Modal [data-v3-act="edit-scope"]').tap();
    await expect.poll(() => title(page)).toBe('SHINGLE & ADD-ONS');
    await expect(page.locator('#estV2Modal .v2-preset-btns'), 'the preset row stays folded').toBeHidden();
    await expect(page.locator('#estV2Modal .v3-preset-done')).toBeVisible();
    await page.locator('#estV2Modal [data-v3-act="show-presets"]').tap();
    await expect(page.locator('#estV2Modal .v2-preset-btns'), 'one tap brings the presets back').toBeVisible();

    // 4. Back to Package → Looks right → Review, same total.
    await page.locator('#estV2Modal .v3-back').tap();
    await expect.poll(() => title(page)).toBe('PACKAGE');
    await page.locator('#estV2Modal [data-v3-act="looks-right"]').tap();
    await expect.poll(() => title(page), { message: 'Looks right lands on Review' }).toBe('REVIEW');
    await expect(page.locator('#v2total'), 'skipping changed no price').toHaveText(total);
    await page.screenshot({ path: test.info().outputPath('review-after-looks-right-390.png') });

    // 5. Close → back on the customer's page.
    await page.locator('#estV2Modal .v2-close').tap();
    await page.waitForURL(new RegExp('/pro/customer(\\.html)?\\?id=' + lead), { timeout: 15_000 });
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 30_000 });
    expect(await safeEvaluate(page, () => window._customerId)).toBe(lead);
  });

  test('a new estimate opened any other way still closes onto the dashboard', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (e) { /* storage blocked */ }
    });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function'), { timeout: 20_000 });
    await safeEvaluate(page, async () => { await window.ScriptLoader.loadBundle('estimates'); window.openEstimateV2Builder({}); });
    await expect(page.locator('#estV2Modal.open.v3-on')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#estV2Modal .v2-close')).not.toHaveText(/Back to/);
    await page.locator('#estV2Modal .v2-close').tap();
    await expect(page.locator('#estV2Modal.open')).toHaveCount(0);
    await page.waitForTimeout(1_200);
    expect(page.url(), 'stays on the dashboard').toMatch(/\/pro\/dashboard/);
  });
});
