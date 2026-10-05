// tests/e2e/phone-deposit-draft.spec.js — the draft deposit invoice on a phone.
//
// Jo, 2026-10-03: "when a contract is signed, auto-create a DRAFT deposit
// invoice — it never sends until Jo taps it." The server makes the draft
// (functions/deposit-draft.js); this spec builds the exact document the
// server writes — with the REAL decision code, functions/deposit-draft-logic.js
// — seeds it, and walks the customer page at 390 × 844, standalone rules
// forced:
//
//   the Invoices & Payments row shows "Draft deposit — review & send",
//   Total Owed leaves the draft out (it was never sent),
//   Review & send opens the existing invoice detail (its Send to Customer
//   button is the only way out) — and the invoice is still a draft after.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const D = require(path.join(__dirname, '..', '..', 'functions', 'deposit-draft-logic.js'));

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
    s.id = 'e2e-force-standalone';
    s.textContent = css;
    document.head.appendChild(s);
    return css.length;
  });
}

test.describe('phone deposit draft: review & send chip on the customer page @shard2', () => {
  test.skip(!creds, 'needs PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD');
  test.use(IPHONE);
  test.setTimeout(120_000);

  test('a signed cash job shows its draft deposit invoice — not owed, opened for review, never sent', async ({ page }) => {
    await signIn(page);
    const uid = await page.evaluate(() => window._user.uid);
    const companyId = await page.evaluate(() => (window._userClaims && window._userClaims.companyId) || window._user.uid);
    const stamp = Date.now();

    const lead = {
      firstName: '[E2E] Deposit', lastName: 'Draft' + stamp, address: stamp + ' Signing Way, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7), email: 'e2e-dep-' + stamp + '@nbd.test',
      stage: 'contract_signed', jobType: 'cash', e2eTestData: true, userId: uid, companyId,
    };
    const est = {
      userId: uid, companyId, name: 'E2E deposit ' + stamp, e2eTestData: true,
      priceMode: 'per-sq', prices: { good: 12000, better: 15000, best: 18000 }, selectedTier: 'better',
      grandTotal: 15000, total: 15000, taxRate: 0, mode: 'cash',
    };

    // Lead + estimate first (ids), then the server-shaped draft.
    const ids = await safeEvaluate(page, async ({ lead, est }) => {
      const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const leadId = (await fs.addDoc(fs.collection(db, 'leads'), Object.assign({ meter: 'manual' }, lead, { createdAt: fs.serverTimestamp() }))).id;
      const estimateId = (await fs.addDoc(fs.collection(db, 'estimates'), Object.assign({}, est, { leadId, createdAt: fs.serverTimestamp() }))).id;
      await fs.updateDoc(fs.doc(db, 'leads', leadId), { primaryEstimateId: estimateId });
      return { leadId, estimateId };
    }, { lead, est });

    const decision = D.decideDepositDraft({
      leadId: ids.leadId, event: 'contract_signed', sourceId: 'doc_e2e', estimateId: ids.estimateId, nowMs: Date.now(),
      lead: Object.assign({}, lead, { primaryEstimateId: ids.estimateId }), est: Object.assign({}, est, { leadId: ids.leadId }),
    });
    expect(decision.action).toBe('create');
    expect(decision.plan.depositCents).toBe(750000); // 50% of $15,000, in cents
    const inv = Object.assign({}, decision.invoice, { dueDateMs: decision.invoice.dueDate.getTime() });
    delete inv.dueDate;

    // A sent $2,000 invoice too, so Total Owed has something real to count.
    await safeEvaluate(page, async ({ id, inv, leadId, uid, companyId }) => {
      const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const due = new Date(inv.dueDateMs); delete inv.dueDateMs;
      await fs.setDoc(fs.doc(db, 'invoices', id), Object.assign({}, inv, { dueDate: due, createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() }));
      await fs.addDoc(fs.collection(db, 'invoices'), {
        leadId, createdBy: uid, companyId, status: 'sent', total: 2000, balanceDue: 2000, amountPaid: 0,
        depositAmount: 0, items: [], createdAt: fs.serverTimestamp(), dueDate: new Date(Date.now() + 864e5), e2eTestData: true,
      });
    }, { id: decision.invoiceId, inv, leadId: ids.leadId, uid, companyId });

    await page.goto('/pro/customer.html?id=' + ids.leadId);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 25_000 });
    await forceStandalone(page);
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});

    const chip = page.locator('#invoiceList [data-deposit-draft]');
    await expect(chip).toHaveCount(1, { timeout: 25_000 });
    await expect(chip).toHaveText('Draft deposit — review & send');
    await chip.scrollIntoViewIfNeeded();
    // Nothing on the row runs off a 390px screen.
    const box = await chip.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();

    // Total Owed counts the sent $2,000, not the $15,000 draft.
    const owed = await page.locator('#invoiceList .summary-item').filter({ hasText: 'Total Owed' }).locator('.summary-value').textContent();
    expect(owed.trim()).toBe('$2,000.00');

    await page.screenshot({ path: test.info().outputPath('deposit-draft-row-390.png') });

    // Review & send → the existing invoice detail, with its own Send button.
    const review = page.locator('#invoiceList [data-action="NBDCustomerInvoices.review"]');
    await expect(review).toHaveCount(1);
    const rb = await review.boundingBox();
    expect(rb && rb.height >= 44).toBeTruthy(); // a thumb-sized tap
    // Every action on the draft row stays on the 390px screen.
    const offscreen = await page.evaluate(() => [...document.querySelectorAll('#invoiceList .is-deposit-draft .doc-btn, #invoiceList .is-deposit-draft [data-deposit-draft]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > 390; }).map((el) => el.textContent.trim()));
    expect(offscreen).toEqual([]);
    await review.click();
    const modal = page.locator('#nbd-invoice-detail-modal');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal.locator('[data-deposit-draft]')).toHaveText('Draft deposit — review & send', { timeout: 15_000 });
    await expect(modal.locator('[data-deposit-draft-note]')).toContainText('Nothing has been sent');
    await expect(modal.getByRole('button', { name: 'Send to Customer' })).toBeVisible();
    await expect(modal).toContainText('$15,000');
    await page.screenshot({ path: test.info().outputPath('deposit-draft-review-390.png') });

    // Opening it sent nothing: still a draft, never sent, no link.
    const after = await safeEvaluate(page, async (id) => {
      const s = await window.getDoc(window.doc(window.db, 'invoices', id));
      const d = s.data() || {};
      return { status: d.status, sentAt: d.sentAt || null, link: d.stripePaymentLink || null };
    }, decision.invoiceId);
    expect(after).toEqual({ status: 'draft', sentAt: null, link: null });
  });
});
