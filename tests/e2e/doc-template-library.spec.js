// tests/e2e/doc-template-library.spec.js — the template library on a phone.
//
// Jo, 2026-10-04: "we need to greatly expand templates contracts proposals
// etc", and yes to lien waivers. At 390 x 844 on the customer page:
//
//   the Generate Documents grid offers a Lien Waiver tile, marked DRAFT for
//   attorney review (CRM chrome), next to the Change Order tile (same mark);
//   tapping it opens the pre-flight with the waiver's fields filled from the
//   lead (property state from the address, payer from the claim on file);
//   Generate opens the document viewer, whose preview is the waiver — the
//   owner, the amount, the state's lien law, an in-app signature pad — and
//   carries no DRAFT / attorney text;
//   the Change Order does the same, its totals computed in cents (the old
//   form's required "0" New Total printed $0.00).
//
// Seeds its own [E2E] lead + estimate through the page's SDK. No Cloud
// Function is called (the docs persist straight to Firestore + Storage).
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

async function signIn(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
  await loginAs(page, creds);
  await safeWaitForFunction(page, () => !!(window._user && window._user.uid), { timeout: 20_000 });
}

async function seed(page) {
  const uid = await page.evaluate(() => window._user.uid);
  const companyId = await page.evaluate(() => (window._userClaims && window._userClaims.companyId) || window._user.uid);
  const stamp = Date.now();
  const lead = {
    firstName: '[E2E] Lien', lastName: 'Waiver' + stamp, address: stamp % 10000 + ' Linden Ave, Fort Thomas, KY 41075',
    phone: '859' + String(stamp).slice(-7), email: 'e2e-lien-' + stamp + '@nbd.test',
    stage: 'install_complete', jobType: 'insurance', insCarrier: 'State Farm', claimNumber: 'SF-' + stamp,
    scopeOfWork: 'Full roof replacement.', e2eTestData: true, userId: uid, companyId,
    meter: 'manual', // server lead meter (firestore.rules leadMeterOk, #2152)
  };
  const est = {
    userId: uid, companyId, name: 'E2E lien ' + stamp, e2eTestData: true,
    priceMode: 'per-sq', prices: { good: 12000, better: 15000, best: 18000 }, selectedTier: 'better', tier: 'better',
    grandTotal: 15000, total: 15000, taxRate: 0, mode: 'insurance',
    rows: [{ code: 'RFG 240-TAMKO-HAIL', name: 'TAMKO HailGuard Shingles' }],
  };
  // Fixed ids + setDoc: an addDoc whose ack is lost under emulator load is
  // retried by the SDK and fails ALREADY_EXISTS; an upsert cannot.
  const leadId = 'e2e-tpl-lead-' + stamp;
  const estimateId = 'e2e-tpl-est-' + stamp;
  return safeEvaluate(page, async ({ lead, est, leadId, estimateId }) => {
    const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    await fs.setDoc(fs.doc(db, 'leads', leadId), Object.assign({}, lead, { primaryEstimateId: estimateId, createdAt: fs.serverTimestamp() }));
    await fs.setDoc(fs.doc(db, 'estimates', estimateId), Object.assign({}, est, { leadId, createdAt: fs.serverTimestamp() }));
    return { leadId, estimateId, name: lead.firstName + ' ' + lead.lastName };
  }, { lead, est, leadId, estimateId });
}

// Tap a Generate Documents tile; returns the tile's badge text ('' if none).
async function openTile(page, type) {
  const tile = page.locator('#docTemplateGrid [data-action="generateCustomerDoc"][data-doc-type="' + type + '"]');
  await expect(tile).toHaveCount(1);
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390, type + ' tile fits a 390px screen').toBeTruthy();
  const badge = (await tile.locator('.dt-draft-badge').textContent().catch(() => '')) || '';
  await tile.click();
  await expect(page.locator('#docPreflightModal')).toBeVisible({ timeout: 20_000 });
  return badge.trim();
}

async function generateAndPreview(page, heading) {
  await page.locator('#docPreflightModal [data-dpf-submit]').click();
  await expect(page.locator('#nbd-doc-viewer-overlay.open #nbdv-iframe')).toBeVisible({ timeout: 30_000 });
  const frame = page.frameLocator('#nbd-doc-viewer-overlay.open #nbdv-iframe');
  // The test user's tenant brand (not NBD's) heads the document.
  await expect(frame.locator('body')).toContainText(heading, { timeout: 15_000 });
  return {
    frame,
    // textContent, not innerText: headings are text-transform:uppercase.
    text: (await frame.locator('body').textContent()).replace(/\s+/g, ' '),
    html: await page.locator('#nbdv-iframe').getAttribute('srcdoc'),
  };
}

async function closeViewer(page) {
  // The viewer asks "Close without saving?" for an unsigned signable doc —
  // answer OK (the nbdConfirm modal on a phone, native confirm otherwise).
  await page.evaluate(() => { window.nbdConfirm = () => Promise.resolve(true); });
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await page.locator('#nbdv-close').click();
  await expect(page.locator('#nbd-doc-viewer-overlay.open')).toHaveCount(0, { timeout: 10_000 });
}

test.describe('template library: lien waiver + change order from the customer page at 390x844 @shard2', () => {
  test.skip(!creds, 'needs PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD');
  test.use(IPHONE);
  test.setTimeout(180_000);

  test('generate a lien waiver and a change order, see the preview', async ({ page }) => {
    await signIn(page);
    const ids = await seed(page);
    await page.goto('/pro/customer.html?id=' + ids.leadId);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 25_000 });
    await safeWaitForFunction(page, () => Array.isArray(window._customerEstimates) && window._customerEstimates.length > 0, { timeout: 25_000 });
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

    // ── Lien waiver ──
    const lienBadge = await openTile(page, 'lien_waiver');
    expect(lienBadge).toBe('DRAFT — have your attorney review before first use');
    const modal = page.locator('#docPreflightModal');
    // Prefilled from the lead: Kentucky from the address, the carrier's check.
    await expect(modal.locator('[data-field="waiverState"]')).toHaveValue('KY');
    await expect(modal.locator('[data-field="payerType"]')).toHaveValue('insurance');
    await expect(modal.locator('[data-field="insCarrier"]')).toHaveValue('State Farm');
    await modal.locator('[data-field="waiverKind"]').selectOption('conditional_final');
    await modal.locator('[data-field="amount"]').fill('8750.25');
    await modal.locator('[data-field="checkNumber"]').fill('4471');
    await page.screenshot({ path: test.info().outputPath('lien-preflight-390.png') });
    const lien = await generateAndPreview(page, 'Conditional Waiver and Release of Lien');
    expect(lien.text).toContain('Conditional Waiver and Release of Lien');
    expect(lien.text).toContain(ids.name);
    expect(lien.text).toContain('$8,750.25');
    expect(lien.text).toContain('Insurance company — State Farm');
    expect(lien.text).toContain('Kentucky Revised Statutes Chapter 376');
    expect(lien.html).toMatch(/data-nbd-sig="rep"/);
    expect(lien.html).not.toMatch(/DRAFT|attorney review|have your attorney/i);
    await page.screenshot({ path: test.info().outputPath('lien-preview-390.png') });
    await closeViewer(page);

    // ── Change order ──
    const coBadge = await openTile(page, 'change_order');
    expect(coBadge).toBe('DRAFT — have your attorney review before first use');
    await modal.locator('[data-field="changeDescription"]').fill('Replace 3 sheets of rotted decking.');
    await modal.locator('[data-field="changeAmount"]').fill('1250.25');
    await modal.locator('[data-field="scheduleDays"]').fill('1');
    // New Total left blank: the document computes it.
    const co = await generateAndPreview(page, 'CHANGE ORDER');
    expect(co.text).toContain('CHANGE ORDER');
    expect(co.text).toContain('Replace 3 sheets of rotted decking.');
    expect(co.text).toContain('$15,000.00');
    expect(co.text).toContain('+$1,250.25');
    expect(co.text).toContain('$16,250.25');
    expect(co.text).not.toContain('$0.00');
    expect(co.text).toContain('This change adds 1 working day to the schedule.');
    expect(co.html).toMatch(/data-nbd-sig="homeowner"/);
    expect(co.html).not.toMatch(/DRAFT|attorney review|have your attorney/i);
    // The preview fits the phone: nothing in the document is wider than its frame.
    const overflow = await co.frame.locator('body').evaluate((b) => b.scrollWidth - b.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath('change-order-preview-390.png') });
    await closeViewer(page);
  });
});
