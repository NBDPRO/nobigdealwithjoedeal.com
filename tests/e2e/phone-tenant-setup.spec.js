// tests/e2e/phone-tenant-setup.spec.js — a brand-new contractor on a phone
// (2026-10-04, tenant-ready). Jo's bar: NBD Pro has to work for a new
// contractor without Jo's help.
//
// The account is provisioned exactly the way createCompany leaves it
// (companies/{uid} + a neutral companyProfile seed + a Free subscriptions doc
// + companyId / company_admin claims) through the admin SDK, so this spec runs
// on the auth + firestore + hosting rig; the createCompany callable itself is
// proven end to end by stranger.spec.js on the functions shard. Then, at
// iPhone size (390 × 844), it walks what the owner meets:
//   1. Home shows the setup checklist — nothing done, nothing runs sideways;
//   2. "Set prices" opens Settings → Estimates; the owner's package prices are
//      saved to the COMPANY (companyProfile.pricing.tierRates), and the
//      Business Rules panel shows the company's three tiers;
//   3. back on Home the prices step is ticked;
//   4. the V3 estimate wizard's package cards show the owner's $/SQ and only
//      the company's three tiers — no starter-price hint.
const { test, expect } = require('@playwright/test');
const { loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const EMULATOR_MODE = /localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')
  && !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

let _admin = null;
function admin() {
  if (_admin) return _admin;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _admin = { auth: getAuth(), db: getFirestore(), FieldValue };
  return _admin;
}

async function provisionFreshTenant() {
  const { auth, db, FieldValue } = admin();
  const stamp = Date.now();
  const email = 'e2e-tenant-' + stamp + '@nbd.test';
  const password = 'tenant-e2e-' + stamp;
  const user = await auth.createUser({ email, password, emailVerified: true, displayName: 'Pat Oak' });
  const uid = user.uid;
  await auth.setCustomUserClaims(uid, { companyId: uid, role: 'company_admin' });
  const now = FieldValue.serverTimestamp();
  // The createCompany shape (functions/handlers/provisioning.js).
  await db.doc('companies/' + uid).set({ name: 'Oak Ridge Roofing ' + stamp, ownerId: uid, status: 'active', plan: 'free', source: 'self-serve', createdAt: now });
  await db.doc('companyProfile/' + uid).set({ brand: { legalName: 'Oak Ridge Roofing ' + stamp, contact: { alertEmail: email } }, provisionedBy: 'createCompany-v1', createdAt: now });
  await db.doc('subscriptions/' + uid).set({ plan: 'free', status: 'none', source: 'self-serve', usage: { leads: 0, reports: 0, aiCalls: 0, cycleStart: new Date().toISOString() }, createdAt: now });
  return { uid, email, password };
}

async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) {
          for (const inner of r.cssRules) css += inner.cssText + '\n';
        }
      }
    }
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
    return css.length;
  });
}

async function goHome(page) {
  await safeEvaluate(page, () => window.goTo('home'));
  await page.waitForTimeout(300);
  await safeEvaluate(page, () => window.NBDSetupChecklist && window.NBDSetupChecklist.refresh());
}

test.describe('phone tenant setup: a new contractor sets up alone @shard2', () => {
  test.skip(!EMULATOR_MODE, 'needs the auth + firestore emulators (PLAYWRIGHT_BASE_URL on localhost)');
  test.use(IPHONE);

  test('checklist → set prices for the company → V3 quotes them', async ({ page }) => {
    test.setTimeout(180_000);
    const t = await provisionFreshTenant();
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
    await loginAs(page, { email: t.email, password: t.password });
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid) && window._companyProfileLoaded === true, { timeout: 30_000 });
    await forceStandalone(page);

    await test.step('1 Home shows the setup checklist', async () => {
      await goHome(page);
      const card = page.locator('#nbdSetupChecklist');
      await expect(card, 'the new owner sees the checklist').toBeVisible({ timeout: 20_000 });
      await expect(card.locator('.sc-title')).toHaveText(/^0 of \d+ done$/);
      const ids = await card.locator('.sc-step').evaluateAll((els) => els.map((e) => e.getAttribute('data-sc-step')));
      expect(ids.slice(0, 5), 'brand → import → prices → team → stripe').toEqual(['brand', 'import', 'prices', 'team', 'stripe']);
      expect(ids[ids.length - 1]).toBe('estimate');
      const overflow = await page.evaluate(() => {
        const c = document.getElementById('nbdSetupChecklist');
        return Array.from(c.querySelectorAll('*')).some((el) => el.getBoundingClientRect().right > window.innerWidth + 1);
      });
      expect(overflow, 'nothing on the checklist runs off a 390px screen').toBe(false);
      const go = card.locator('[data-sc-step="prices"] .sc-go');
      const bb = await go.boundingBox();
      expect(bb.height, '"Set prices" is a thumb target').toBeGreaterThanOrEqual(36);
    });

    await test.step('2 Set prices — saved for the company, Business Rules shows 3 tiers', async () => {
      await page.locator('#nbdSetupChecklist [data-sc-step="prices"] .sc-go').tap();
      await expect(page.locator('#stab-panel-estimates')).toBeVisible({ timeout: 15_000 });
      await safeWaitForFunction(page, () => !!window.EstimateBuilderV2, { timeout: 20_000 });
      await expect(page.locator('#tenantRulesPanel')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
      // The price inputs are painted from the company profile only once the
      // WHOLE 'estimates' bundle has loaded (ui.js switchSettingsTab defers
      // _loadEstimateDefaultsV2 to loadBundle('estimates').then — one paint
      // per call), not when EstimateBuilderV2 first appears. Typing before
      // that is either saved before the company inputs are resolved (Save
      // All skips the company write: tierRates never reached the profile) or
      // painted over with the defaults (550/660/770 saved instead). Wait for
      // the bundle, let every queued paint run (a macrotask turn), and for
      // the painted marker the panel sets on each company input.
      await safeEvaluate(page, async () => {
        await window.ScriptLoader.loadBundle('estimates');
        await new Promise((r) => setTimeout(r, 0));
      });
      await expect(page.locator('#v2rateGood'), 'the price inputs were painted from the company profile').toHaveAttribute('data-nbd-painted', /\S/);
      const enabled = await page.locator('#tenantRulesPanel input[data-tr="enabled"]:checked').evaluateAll((els) => els.map((e) => e.getAttribute('data-tier')));
      expect(enabled, 'a new company offers three tiers').toEqual(['good', 'better', 'best']);
      await expect(page.locator('#tenantRulesPanel input[data-tr="label"][data-tier="good"]')).toHaveValue('Good');
      for (const [id, v] of [['Good', '600'], ['Better', '700'], ['Best', '800']]) {
        await page.locator('#v2rate' + id).fill(v);
      }
      await page.locator('[data-fn="_saveEstimateDefaultsV2"]').first().tap();
      const { db } = admin();
      let rates = null;
      for (let i = 0; i < 40; i++) {
        const s = await db.doc('companyProfile/' + t.uid).get();
        rates = s.exists && s.data().pricing && s.data().pricing.tierRates;
        if (rates && rates.good === 600) break;
        await page.waitForTimeout(500);
      }
      expect(rates && [rates.good, rates.better, rates.best], 'prices saved on the COMPANY profile').toEqual([600, 700, 800]);
    });

    await test.step('3 Home ticks the prices step', async () => {
      await goHome(page);
      await expect(page.locator('#nbdSetupChecklist [data-sc-step="prices"]')).toHaveClass(/is-done/, { timeout: 15_000 });
      await expect(page.locator('#nbdSetupChecklist .sc-title')).toHaveText(/^1 of \d+ done$/);
    });

    await test.step('4 V3 package cards quote the company prices', async () => {
      await safeEvaluate(page, async () => { await window.ScriptLoader.loadBundle('estimates'); window.openEstimateV2Builder(); });
      await expect(page.locator('#estV2Modal.open.v3-on')).toBeVisible({ timeout: 15_000 });
      await page.locator('#v2jobCash').tap();
      await page.locator('#estV2Modal .v3-next').tap();
      await page.locator('#v2rawSqft').fill('2400');
      await page.locator('#v2rawSqft').dispatchEvent('input');
      await page.locator('#estV2Modal .v3-jump').tap();
      await page.locator('#estV2Modal .v3-sheet:not([hidden]) .v3-sheet-row').filter({ hasText: 'Package' }).tap();
      await expect(page.locator('#estV2Modal .v3-title')).toHaveText('Package');
      await page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]').tap();
      const perSq = page.locator('#v2modePerSq');
      await perSq.scrollIntoViewIfNeeded();
      await perSq.tap();
      await expect(perSq).toHaveClass(/active/);
      const tiers = page.locator('#estV2Modal .v3-pkg .v3-tier');
      await expect(tiers, 'only the company\'s three tiers').toHaveCount(3);
      const notes = (await page.locator('#estV2Modal .v3-pkg .v3-tier .v3-tier-note').allTextContents()).join(' | ');
      expect(notes, 'cards print the company $/SQ').toMatch(/\$600\/SQ/);
      expect(notes).toMatch(/\$700\/SQ/);
      expect(notes).toMatch(/\$800\/SQ/);
      expect(notes, 'never NBD\'s HailGuard lock').not.toMatch(/HailGuard/);
      await expect(page.locator('#estV2Modal [data-v3-starter-rates]'), 'no starter-price hint once prices are set').toHaveCount(0);
      const prices = (await page.locator('#estV2Modal .v3-pkg .v3-tier .v3-tier-price').allTextContents())
        .map((p) => Math.round(Number(p.replace(/[^0-9.]/g, '')) * 100));
      expect(prices.every((c) => c > 0), 'every package priced').toBe(true);
      expect(prices, 'Good < Better < Best').toEqual([...prices].sort((a, b) => a - b));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), 'no sideways scroll').toBe(false);
    });
  });
});
