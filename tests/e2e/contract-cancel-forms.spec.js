// tests/e2e/contract-cancel-forms.spec.js — the 3-day right to cancel on a
// contract signed in person, on a phone (2026-10-04).
//
// The bug: a contract signed IN THE APP carried no FTC Notice of
// Cancellation — only the server-rendered PDF attached it. At 390 x 844 on
// the customer page:
//
//   Contract tile → pre-flight → Generate opens the doc viewer; the contract
//   carries the 16 CFR 429.1(a) statement beside the signature pads and the
//   Notice of Right to Cancel with two completed FTC Notice of Cancellation
//   forms after them;
//   the homeowner and the rep sign on the phone, Save to Customer; the SIGNED
//   record in Storage carries the notice + both forms dated today, and
//   cancelBy (3 business days) is on the document row and the lead;
//   the customer page shows "Cancellation window ends <date>";
//   moving the job to Materials Ordered inside the window warns in the
//   confirm (the move is not blocked).
//
// Seeds its own [E2E] lead + estimate through the page's SDK. No Cloud
// Function is called (in-person signing persists straight to Firestore +
// Storage).
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
    firstName: '[E2E] Cancel', lastName: 'Forms' + stamp, address: (stamp % 10000) + ' Ridge Rd, Cincinnati, OH 45230',
    phone: '513' + String(stamp).slice(-7), email: 'e2e-cxl-' + stamp + '@nbd.test',
    stage: 'permit_pulled', jobType: 'cash', jobValue: 15000,
    scopeOfWork: 'Full tear-off and replacement.', e2eTestData: true, userId: uid, companyId,
    meter: 'manual', // server lead meter (firestore.rules leadMeterOk, #2152)
  };
  const est = {
    userId: uid, companyId, name: 'E2E cancel ' + stamp, e2eTestData: true,
    priceMode: 'per-sq', prices: { good: 12000, better: 15000, best: 18000 }, selectedTier: 'better', tier: 'better',
    grandTotal: 15000, total: 15000, taxRate: 0, mode: 'cash',
    lineItems: [{ description: 'Full roof replacement', qty: 1, unit: 'JOB', unitPrice: 15000, total: 15000 }],
    rows: [{ code: 'RFG 240', name: 'Architectural shingles', qty: 30, unit: 'SQ', total: 15000 }],
  };
  const leadId = 'e2e-cxl-lead-' + stamp;
  const estimateId = 'e2e-cxl-est-' + stamp;
  return safeEvaluate(page, async ({ lead, est, leadId, estimateId }) => {
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    await fs.setDoc(fs.doc(db, 'leads', leadId), Object.assign({}, lead, { primaryEstimateId: estimateId, createdAt: fs.serverTimestamp() }));
    await fs.setDoc(fs.doc(db, 'estimates', estimateId), Object.assign({}, est, { leadId, createdAt: fs.serverTimestamp() }));
    return { leadId, estimateId, name: lead.firstName + ' ' + lead.lastName };
  }, { lead, est, leadId, estimateId });
}

// A finger stroke on a signature pad inside the viewer's document frame.
async function drawSignature(page, frame, frameEl, role) {
  await frame.evaluate((r) => document.querySelector('[data-nbd-sig="' + r + '"]').scrollIntoView({ block: 'center' }), role);
  const fr = await frameEl.boundingBox();
  const c = await frame.evaluate((r) => { const b = document.querySelector('[data-nbd-sig="' + r + '"] canvas').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; }, role);
  await page.mouse.move(fr.x + c.x + 20, fr.y + c.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(fr.x + c.x + 20 + i * ((c.w - 40) / 12), fr.y + c.y + 40 + (i % 3) * 12);
  await page.mouse.up();
}

const count = (s, re) => (String(s).match(re) || []).length;

test.describe('contract signed in person carries the 3-day cancellation forms at 390x844 @shard2', () => {
  test.skip(!creds, 'needs PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD');
  test.use(IPHONE);
  test.setTimeout(240_000);

  test('sign a contract on the phone; the signed record has the notice + both forms; cancelBy shows and warns', async ({ page }) => {
    page.on('console', (m) => { const t = m.text(); if (/cxl-e2e|cancelBy|Signed|failed/i.test(t)) console.log('[page] ' + t.slice(0, 300)); });
    await signIn(page);
    const ids = await seed(page);
    await page.goto('/pro/customer.html?id=' + ids.leadId);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 25_000 });
    await safeWaitForFunction(page, () => Array.isArray(window._customerEstimates) && window._customerEstimates.length > 0, { timeout: 25_000 });
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
    await expect(page.locator('#cancelWindowChip'), 'no chip before a contract is signed').toBeHidden();

    // ── Generate the contract ──
    const tile = page.locator('#docTemplateGrid [data-action="generateCustomerDoc"][data-doc-type="contract"]');
    await expect(tile).toHaveCount(1);
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    const modal = page.locator('#docPreflightModal');
    await expect(modal).toBeVisible({ timeout: 20_000 });
    for (const [field, value] of [['projectDescription', 'Full tear-off and replacement.'], ['totalPrice', '15000']]) {
      const el = modal.locator('[data-field="' + field + '"]');
      if (await el.count() && !(await el.inputValue().catch(() => 'x'))) await el.fill(value);
    }
    await page.screenshot({ path: test.info().outputPath('contract-preflight-390.png') });
    await modal.locator('[data-dpf-submit]').click();
    const frameEl = page.locator('#nbd-doc-viewer-overlay.open #nbdv-iframe');
    await expect(frameEl).toBeVisible({ timeout: 30_000 });
    const frame = page.frameLocator('#nbd-doc-viewer-overlay.open #nbdv-iframe');
    await expect(frame.locator('body')).toContainText('Roofing Contract', { timeout: 15_000 });
    const preview = await frameEl.getAttribute('srcdoc');
    expect(preview, 'the 429.1(a) statement beside the signatures').toMatch(/data-nbd-statutory="ftc-429-1-a"/);
    expect(preview.indexOf('data-nbd-statutory="ftc-429-1-a"'), 'statement before the homeowner pad')
      .toBeLessThan(preview.indexOf('data-nbd-sig="homeowner"'));
    expect(count(preview, /data-nbd-noc="ftc"/g), 'two FTC Notice of Cancellation forms').toBe(2);
    expect(preview).toContain('Notice of Right to Cancel');
    await frame.locator('.nbd-cxl').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('contract-cancel-notice-390.png') });

    // ── Sign in person: homeowner + rep, Save to Customer ──
    const frameHandle = await frameEl.elementHandle();
    const f = await frameHandle.contentFrame();
    await drawSignature(page, f, frameEl, 'homeowner');
    await drawSignature(page, f, frameEl, 'rep');
    await page.locator('.nbdv-action-btn', { hasText: 'Save to Customer' }).click();

    // The documents row flips to signed with cancelBy; the lead gets cancelBy.
    const want = await page.evaluate(() => window.NBDJurisdiction.cancelBy(new Date(), 'America/New_York'));
    const signed = await safeEvaluate(page, async ({ leadId, want }) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      for (let i = 0; i < 60; i++) {
        const snap = await fs.getDocs(fs.collection(db, 'leads', leadId, 'documents'));
        const row = snap.docs.map((d) => d.data()).find((d) => d.type === 'contract' && d.status === 'signed');
        const lead = (await fs.getDoc(fs.doc(db, 'leads', leadId))).data() || {};
        if (row && row.cancelBy === want && lead.cancelBy === want) {
          const st = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js');
          const bytes = await st.getBytes(st.ref(window.storage || st.getStorage(), row.htmlPath));
          return { row, leadCancelBy: lead.cancelBy, html: new TextDecoder().decode(bytes) };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const snap = await fs.getDocs(fs.collection(db, 'leads', leadId, 'documents'));
      const lead = (await fs.getDoc(fs.doc(db, 'leads', leadId))).data() || {};
      console.log('[cxl-e2e] rows=' + JSON.stringify(snap.docs.map((d) => ({ type: d.data().type, status: d.data().status, cancelBy: d.data().cancelBy })))
        + ' lead.cancelBy=' + lead.cancelBy);
      return null;
    }, { leadId: ids.leadId, want });
    expect(signed, 'the signed contract row + lead carry cancelBy = ' + want).not.toBeNull();
    expect(signed.row.cancelBy).toBe(want);
    expect(signed.leadCancelBy).toBe(want);
    // The SIGNED record in Storage: signatures + the notice + both completed forms, dated today.
    expect(signed.html).toMatch(/data-nbd-sig-finalized="1"/);
    expect(count(signed.html, /data-nbd-noc="ftc"/g), 'signed record: two FTC forms').toBe(2);
    expect(signed.html).toContain('Notice of Right to Cancel');
    expect(signed.html).toContain('data-nbd-cancel-by="' + want + '"');
    expect(signed.html).toMatch(/data-nbd-statutory="ftc-429-1-a"/);

    // ── Customer page: the chip, then the stage-move warning ──
    await page.evaluate(() => { window.nbdConfirm = () => Promise.resolve(true); });
    page.once('dialog', (d) => d.accept().catch(() => {}));
    await page.locator('#nbdv-close').click().catch(() => {});
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 25_000 });
    const chip = page.locator('#cancelWindowChip');
    const day = await page.evaluate((w) => window.NBDJurisdiction.cancelByText(w), want);
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveText('Cancellation window ends ' + day);
    const box = await chip.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, 'the chip fits a 390px screen').toBeTruthy();
    await chip.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: test.info().outputPath('customer-cancel-chip-390.png') });

    // Permit Pulled → Materials Ordered inside the window: the confirm warns.
    await page.evaluate(() => {
      window.__cxlAsked = [];
      window.nbdConfirm = (m) => { window.__cxlAsked.push(String(m)); return Promise.resolve(false); };
    });
    await page.evaluate(() => window.progressStage());
    const asked = await page.evaluate(() => window.__cxlAsked);
    expect(asked.length, 'the move asked for confirmation').toBeGreaterThan(0);
    expect(asked[0]).toContain('still in the 3-day cancellation window');
    expect(asked[0]).toContain('Materials Ordered');
  });
});
