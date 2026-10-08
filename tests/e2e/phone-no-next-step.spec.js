// tests/e2e/phone-no-next-step.spec.js — "No next step" on an iPhone
// (2026-10-03 audit: 161 of 179 open leads had no follow-up and no open task).
//
// Installed-app rules forced, 390 × 844, real taps:
//   - the Home card lists an open lead with no follow-up / no open task,
//     oldest first; every action button is thumb-sized (≥ 44px) and the page
//     does not scroll sideways;
//   - ONE tap on "1w" writes followUp = today + 7 (local) to THAT lead and the
//     row leaves the list;
//   - a door-knock lead with no phone sits in its own group, not the list;
//   - the board filter shows exactly the no-next-step leads.
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
function ymdIn(n) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

test.describe('phone: no next step @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('Home card: one tap sets a follow-up on that lead; knock group apart; board filter', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.NBDNoNextStep && window.NBDFollowUpDeck && window.NBDFollowUpDeck.setFollowUp), null, { timeout: 30_000 });
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    // Start clean: an earlier attempt's 2019-dated ZZNext leads sit above this
    // attempt's and fail "oldest first" on every retry.
    for (const d of (await adb().collection('leads').where('userId', '==', who.uid).where('firstName', '==', 'ZZNext').get()).docs) await d.ref.delete();
    const s = String(Date.now()).slice(-7);
    const base = { userId: who.uid, companyId: who.co, stage: 'contacted', e2eTestData: true, deleted: false };
    const old = new Date('2019-01-02T12:00:00Z');   // older than anything seeded → top of the list
    const quiet = (await adb().collection('leads').add(Object.assign({}, base, {
      firstName: 'ZZNext', lastName: 'Quiet' + s, phone: '(859) 55' + s.slice(0, 1) + '-' + s.slice(1, 5), createdAt: old, updatedAt: old,
    }))).id;
    const knock = (await adb().collection('leads').add(Object.assign({}, base, {
      firstName: 'ZZNext', lastName: 'Knock' + s, source: 'Door Knock', phone: '', address: s + ' Knock Ln, Union KY', createdAt: old, updatedAt: old,
    }))).id;
    await safeEvaluate(page, async () => {
      if (typeof window._loadLeads === 'function') await window._loadLeads(); else if (typeof window.loadLeads === 'function') await window.loadLeads();
      if (typeof window.loadAllTasks === 'function') await window.loadAllTasks();
    });
    await page.waitForFunction((ids) => ids.every((id) => (window._leads || []).some((l) => l.id === id)), [quiet, knock], { timeout: 30_000 });
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await page.evaluate(() => { window.goTo && window.goTo('home'); });

    const card = page.locator('#homeNoNextStep');
    // On a phone the full list folds behind "More on Home" (2026-10-08, phone
    // audit #6 — Today carries its one-line "Swipe through" row); one tap opens it.
    const moreToggle = page.locator('#homeMoreToggle');
    await expect(moreToggle).toBeVisible({ timeout: 20_000 });
    await expect(card, 'folded until More on Home').toBeHidden();
    const optOut = page.locator('#nbd-push-optin button', { hasText: 'Not now' });
    if (await optOut.isVisible().catch(() => false)) await optOut.tap();
    await moreToggle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await moreToggle.tap();
    await expect(card, 'the Home card shows').toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => window.NBDNoNextStep.render());
    const row = card.locator('.nns-row', { hasText: 'Quiet' + s });
    await expect(row, 'our quiet lead is listed').toBeVisible();
    const firstName = await card.locator('#nnsList .nns-row .nns-name').first().textContent();
    expect(firstName, 'oldest first').toContain('Quiet' + s);

    // The knock lead with no phone is grouped apart, not in the main list.
    await expect(card.locator('.nns-knock')).toBeVisible();
    await expect(card.locator('#nnsList .nns-row', { hasText: 'Knock' + s })).toHaveCount(0);

    // Thumb-sized buttons; no sideways scroll at 390.
    // The card redraws on a 200ms debounce (no-next-step.js schedule()) and
    // each redraw replaces its innerHTML, so buttons read mid-redraw detach
    // (boundingBox() → null). Wait until the card has been quiet for longer
    // than the debounce, then re-query each button and wait for it.
    await page.evaluate(() => {
      const el = document.getElementById('homeNoNextStep');
      window.__nnsLastMut = Date.now();
      if (el && !window.__nnsObs) {
        window.__nnsObs = new MutationObserver(() => { window.__nnsLastMut = Date.now(); });
        window.__nnsObs.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
      }
    });
    await page.waitForFunction(() => Date.now() - window.__nnsLastMut > 600, null, { timeout: 15_000, polling: 100 });
    await expect(row, 'our quiet lead is still listed after the redraws').toBeVisible();
    const nButtons = await row.locator('button').count();
    expect(nButtons, 'the row has its action buttons').toBeGreaterThan(0);
    for (let i = 0; i < nButtons; i++) {
      const b = row.locator('button').nth(i);
      await expect(b).toBeVisible();
      const box = await b.boundingBox();
      expect(box, 'button ' + i + ' has a layout box').not.toBeNull();
      expect(box.height, 'tap target height').toBeGreaterThanOrEqual(44);
      expect(box.width, 'tap target width').toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, 'button inside the viewport').toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no horizontal page scroll').toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'test-results/no-next-step-390.png', fullPage: false });

    // ONE tap: follow up in 1 week → written to THAT lead, row leaves.
    await row.locator('[data-nns-act="fu"][data-nns-days="7"]').tap();
    await expect.poll(async () => ((await adb().doc('leads/' + quiet).get()).data() || {}).followUp, { message: 'followUp saved on the lead', timeout: 15_000 }).toBe(ymdIn(7));
    await expect(card.locator('.nns-row', { hasText: 'Quiet' + s }), 'the row leaves the list').toHaveCount(0, { timeout: 10_000 });
    const knockDoc = (await adb().doc('leads/' + knock).get()).data() || {};
    expect(knockDoc.followUp || '', 'nothing else was written').toBe('');

    // Board filter: exactly the no-next-step leads (the knock lead in, the quiet one now out).
    await page.evaluate(() => { window.goTo && window.goTo('crm'); });
    await page.waitForTimeout(600);
    await page.evaluate(() => window.NBDNoNextStep.toggleFilter());
    const filtered = await page.evaluate(() => (window._filteredLeads || []).map((l) => l.id));
    expect(filtered, 'the knock lead is in the filter').toContain(knock);
    expect(filtered, 'the lead that now has a follow-up is not').not.toContain(quiet);
    await expect(page.locator('#noNextStepBtn')).toHaveClass(/active/);
    await page.evaluate(() => window.NBDNoNextStep.toggleFilter());

    await adb().doc('leads/' + quiet).delete();
    await adb().doc('leads/' + knock).delete();
  });
});
