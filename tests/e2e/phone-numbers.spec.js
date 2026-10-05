// tests/e2e/phone-numbers.spec.js — "knowing your numbers" on an iPhone
// (390x844), 2026-10-04:
//   1. Moving a lead to Lost REQUIRES a reason: the quick-pick sheet opens,
//      Mark Lost stays disabled until a reason is picked ("Other" also needs a
//      note), and the reason lands on the lead. Cancel leaves the lead alone.
//   2. The Sunday review page (#/weekreview) renders at phone width with no
//      sideways scroll; a win's sold package is picked in one tap, a loss's
//      reason is set in bulk, and the week's "one decision" is saved to the
//      owner-only owner_numbers doc.
//
// Every seeded doc carries e2eTestData + an e2eRun tag (fixtures/seeded-run.js).
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390, H = 844;
let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

async function box(page, selector) {
  return safeEvaluate(page, (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { h: r.height, w: r.width, right: r.right, left: r.left };
  }, selector);
}
const readDoc = (page, path) => safeEvaluate(page, async (p) => {
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const s = await fs.getDocFromServer(fs.doc(window.db || window._db, p));
  return s.exists() ? s.data() : null;
}, path);

test.describe.serial('phone numbers: lost reason + Sunday review at 390px @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let run = '';
  let stamp = 0;

  // Writes a lead straight to Firestore (so createdAt / closedAt can be set),
  // tagged for cleanup; returns its id after the dashboard has it in memory.
  async function seedLead(fields) {
    return safeEvaluate(page, async ({ f, tag }) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const uid = window._user.uid;
      const co = (window._userClaims && window._userClaims.companyId) || uid;
      const data = Object.assign({ userId: uid, companyId: co, e2eTestData: true, e2eRun: tag }, f);
      ['createdAt', 'closedAt', 'stageStartedAt'].forEach((k) => { if (typeof data[k] === 'number') data[k] = fs.Timestamp.fromMillis(data[k]); });
      const ref = await fs.addDoc(fs.collection(window.db, 'leads'), data);
      return ref.id;
    }, { f: fields, tag: run });
  }
  async function reloadLeads(ids) {
    await safeEvaluate(page, () => window._loadLeads && window._loadLeads());
    await safeEvaluate(page, (want) => { window.__nbWant = want; }, ids);
    await safeWaitForFunction(page, () => (window.__nbWant || []).every((id) => (window._leads || []).some((l) => l.id === id)), { timeout: 20_000 });
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    stamp = Date.now();
    run = 'phone-numbers:' + stamp;
    context = await browser.newContext({
      viewport: { width: W, height: H }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await context.addInitScript(() => {
      try { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); } catch (_) {}
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
        const today = new Date().toISOString().split('T')[0];
        ['overdue_scan', 'pending_estimate_scan', 'morning_briefing'].forEach((k) => localStorage.setItem('nbd_proactive_' + k, today));
      } catch (_) {}
    });
    page = await context.newPage();
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
    await page.route('**/api/google-reviews**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ reviews: [{ time: Math.floor(Date.now() / 1000) - 3600 }] }) }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user && Array.isArray(window._leads)
      && typeof window.moveCard === 'function' && !!window.NBDLostReason && !!window.NBDNumbers && !!window.NBDNumbersData, { timeout: 30_000 });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    if (!context) return;
    const res = await deleteSeededRun({ page, context, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-numbers] cleanup: ' + res.failed.join('; '));
    await context.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('1. Lost needs a reason: the sheet, Other needs a note, the reason is saved; Cancel moves nothing', async () => {
    test.setTimeout(90_000);
    const tag = String(stamp).slice(-6);
    const id = await seedLead({ firstName: '[E2E] Lost', lastName: 'NumLost' + tag, address: tag + ' Lost Way, Milford, OH', stage: 'contacted', stageRole: 'active', source: 'Thumbtack', createdAt: Date.now() - 5 * 86400000 });
    const keep = await seedLead({ firstName: '[E2E] Keep', lastName: 'NumKeep' + tag, address: tag + ' Keep Way, Milford, OH', stage: 'contacted', stageRole: 'active', source: 'Thumbtack', createdAt: Date.now() - 5 * 86400000 });
    await reloadLeads([id, keep]);
    await safeEvaluate(page, () => window.goTo('crm'));

    // Cancel first: nothing moves.
    await safeEvaluate(page, (lid) => { window.__mv = window.moveCard(lid, 'lost'); }, keep);
    await expect(page.locator('#nbd-lost-reason-modal .nb-sheet')).toBeVisible({ timeout: 10_000 });
    await page.locator('#nbd-lost-reason-modal [data-lr="cancel"]').tap();
    await expect(page.locator('#nbd-lost-reason-modal')).toHaveCount(0);
    await page.waitForTimeout(800);
    expect((await readDoc(page, 'leads/' + keep)).stage, 'cancel leaves the lead where it was').toBe('contacted');

    // The required path.
    await safeEvaluate(page, (lid) => { window.__mv = window.moveCard(lid, 'lost'); }, id);
    const sheet = page.locator('#nbd-lost-reason-modal .nb-sheet');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    const save = page.locator('#nbd-lost-reason-modal [data-lr="save"]');
    await expect(save, 'Mark Lost waits for a reason').toBeDisabled();
    await expect(page.locator('#nbd-lost-reason-modal [data-reason]')).toHaveCount(6);
    await expect(page.locator('#nbd-lost-reason-modal')).not.toContainText('Skip');
    // Every quick pick is a thumb-sized target on the screen.
    for (const key of ['price', 'competitor', 'no_damage', 'no_response', 'insurance_denied', 'other']) {
      const b = await box(page, `#nbd-lost-reason-modal [data-reason="${key}"]`);
      expect(b && b.h, key + ' is a 44px target').toBeGreaterThanOrEqual(44);
      expect(b.right, key + ' fits the screen').toBeLessThanOrEqual(W);
    }
    const sb = await box(page, '#nbd-lost-reason-modal .nb-sheet');
    expect(sb.right, 'the sheet fits the 390px screen').toBeLessThanOrEqual(W + 0.5);
    await page.locator('#nbd-lost-reason-modal [data-reason="other"]').tap();
    await expect(save, '"Other" still needs a note').toBeDisabled();
    await page.locator('#nbLostNote').fill('Homeowner sold the house');
    await expect(save).toBeEnabled();
    await save.tap();
    await expect(page.locator('#nbd-lost-reason-modal')).toHaveCount(0);
    await expect.poll(async () => { const d = await readDoc(page, 'leads/' + id); return d && d.stage; }, { message: 'the lead moved to Lost', timeout: 15_000 }).toBe('lost');
    const lead = await readDoc(page, 'leads/' + id);
    expect(lead.lostReasonKey).toBe('other');
    expect(lead.lostReason).toBe('Other — Homeowner sold the house');
    expect(lead.lostReasonNote).toBe('Homeowner sold the house');
    expect(lead.closedAt, 'the loss is dated').toBeTruthy();
  });

  test('2. Sunday review: fits the phone, package in one tap, bulk lost reason, the week\'s decision saved', async () => {
    test.setTimeout(120_000);
    const tag = String(stamp).slice(-6);
    const now = Date.now();
    const won = await seedLead({ firstName: '[E2E] Won', lastName: 'NumWon' + tag, address: tag + ' Won Way, Milford, OH', stage: 'contract_signed', stageRole: 'active', source: 'Website — Cal.com booking', jobValue: 14200, createdAt: now - 9 * 86400000, closedAt: now - 2 * 86400000 });
    const sameDay = now - 40 * 86400000;
    const imported = await seedLead({ firstName: '[E2E] Imported', lastName: 'NumImp' + tag, address: tag + ' Old Way, Milford, OH', stage: 'closed', stageRole: 'won', source: 'Referral', jobValue: 9000, createdAt: sameDay, closedAt: sameDay });
    const lostNoReason = await seedLead({ firstName: '[E2E] Gone', lastName: 'NumGone' + tag, address: tag + ' Gone Way, Milford, OH', stage: 'lost', stageRole: 'lost', source: 'Thumbtack', createdAt: now - 6 * 86400000, closedAt: now - 1 * 86400000 });
    await reloadLeads([won, imported, lostNoReason]);

    await safeEvaluate(page, () => { window.goTo('weekreview'); window.scrollTo(0, 0); });
    await expect(page.locator('#view-weekreview .wr-title')).toHaveText(/Sunday review/i, { timeout: 20_000 });
    await expect(page.locator('#wrGaps')).toBeVisible({ timeout: 20_000 });
    // No sideways scroll on the page itself (wide tables scroll in their wrap).
    const overflow = await safeEvaluate(page, () => {
      const sc = document.querySelector('#view-weekreview .view-scroll');
      const offenders = [];
      document.querySelectorAll('#view-weekreview .wr-page > *').forEach((el) => { const r = el.getBoundingClientRect(); if (r.right > innerWidth + 1) offenders.push(el.className + ' ' + Math.round(r.right)); });
      return { scroll: sc ? sc.scrollWidth - sc.clientWidth : 0, doc: document.scrollingElement.scrollWidth - innerWidth, offenders };
    });
    expect(overflow.offenders, 'no review card wider than the screen').toEqual([]);
    expect(overflow.doc, 'no page-level horizontal scroll').toBeLessThanOrEqual(1);
    // The win this week is counted, projected.
    await expect(page.locator('#view-weekreview')).toContainText('projected');

    // Wins with no package → pick one.
    await page.locator('#wrGaps [data-wr="toggle"][data-key="pkg"]').tap();
    const sel = page.locator(`#wrGaps select[data-wr="tier"][data-id="${won}"]`);
    await expect(sel).toBeVisible({ timeout: 10_000 });
    const sbx = await box(page, `#wrGaps select[data-wr="tier"][data-id="${won}"]`);
    expect(sbx.h, 'package picker is a 40px+ target').toBeGreaterThanOrEqual(40);
    await sel.selectOption('better');
    await expect.poll(async () => (await readDoc(page, 'leads/' + won)).soldTier, { message: 'soldTier saved', timeout: 15_000 }).toBe('better');
    expect((await readDoc(page, 'leads/' + won)).soldTierSource).toBe('manual');

    // The imported win's close date is flagged and fixable.
    await page.locator('#wrGaps [data-wr="toggle"][data-key="close"]').tap();
    await expect(page.locator(`#wrGaps [data-wr="close-date"][data-id="${imported}"]`)).toBeVisible({ timeout: 10_000 });

    // Losses with no reason → bulk set.
    await page.locator('#wrGaps [data-wr="toggle"][data-key="lost"]').tap();
    const pick = page.locator(`#wrGaps input[data-wr="lost-pick"][data-id="${lostNoReason}"]`);
    await expect(pick).toBeVisible({ timeout: 10_000 });
    await pick.check();
    await page.locator('#wrLostReason').selectOption('price');
    await page.locator('#wrGaps [data-wr="lost-apply"]').tap();
    await expect.poll(async () => (await readDoc(page, 'leads/' + lostNoReason)).lostReasonKey, { message: 'bulk reason saved', timeout: 15_000 }).toBe('price');

    // One decision for the week.
    const text = 'E2E decision ' + tag;
    await page.locator('#wrDecision').fill(text);
    await page.locator('[data-wr="save-decision"]').tap();
    const where = await safeEvaluate(page, () => ({ co: window.NBDNumbersData.companyId(), wk: window.NBDNumbers.weekKey(Date.now()) }));
    await expect.poll(async () => { const d = await readDoc(page, 'companies/' + where.co + '/owner_numbers/week_' + where.wk); return d && d.decision; },
      { message: 'the decision is saved for the week', timeout: 15_000 }).toBe(text);
    // Tidy: the note is not tagged, so clear it.
    await safeEvaluate(page, async (p) => {
      const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      await fs.setDoc(fs.doc(window.db, p), { decision: '' }, { merge: true });
    }, 'companies/' + where.co + '/owner_numbers/week_' + where.wk);
  });
});
