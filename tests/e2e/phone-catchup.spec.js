// tests/e2e/phone-catchup.spec.js — "Catch up my numbers" on an iPhone
// (390x844), 2026-10-04. Two seeded won jobs, each missing everything
// (no payment, close date = created date, no package, no costs):
//   1. Job A: "Paid in full? Yes" → the sheet shows the job total, Jo picks
//      Zelle and a date → ONE payment of the job total lands on a new
//      invoice, dated the day he entered. Package in one tap, close date
//      saved, Done → the deck moves to job B.
//   2. Job B: package tapped, then Undo puts it back; picked again; Done.
//   3. Reload → back on #/catchup the two jobs are still done (progress is
//      saved to owner_numbers/catchup) and the count moved by two.
// No functions emulator runs, and every callable route is stubbed: nothing
// can email. Every seeded lead carries e2eTestData + an e2eRun tag.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390, H = 844;
const DAY = 86400000;
let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

const readDoc = (page, p) => safeEvaluate(page, async (path) => {
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const s = await fs.getDocFromServer(fs.doc(window.db || window._db, path));
  if (!s.exists()) return null;
  const d = s.data();
  const ms = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis() : v;
  return Object.assign({}, d, { closedAt: ms(d.closedAt), soldTierAt: ms(d.soldTierAt) });
}, p);
const invoicesFor = (page, leadId) => safeEvaluate(page, async (id) => {
  const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const q = fs.query(fs.collection(window.db, 'invoices'), fs.where('leadId', '==', id), fs.where('createdBy', '==', window._user.uid));
  const s = await fs.getDocsFromServer(q);
  return s.docs.map((d) => {
    const v = d.data();
    return { id: d.id, total: v.total, status: v.status, amountPaid: v.amountPaid, balanceDue: v.balanceDue,
      payments: (v.payments || []).map((p) => ({ amount: p.amount, method: p.method, at: p.at && p.at.toMillis ? p.at.toMillis() : p.at })) };
  });
}, leadId);
function ymd(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

test.describe.serial('phone catch-up: two won jobs, reload keeps progress @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let run = '';
  let stamp = 0;
  const ids = {};

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
  async function reloadLeads(want) {
    await safeEvaluate(page, () => window._loadLeads && window._loadLeads());
    await safeEvaluate(page, (w) => { window.__nbWant = w; }, want);
    await safeWaitForFunction(page, () => (window.__nbWant || []).every((id) => (window._leads || []).some((l) => l.id === id)), { timeout: 20_000 });
  }
  async function openCatchUp() {
    await safeEvaluate(page, () => { window.goTo('catchup'); window.scrollTo(0, 0); });
    await expect(page.locator('#view-catchup .cu-title')).toHaveText(/Catch up my numbers/i, { timeout: 20_000 });
    await expect(page.locator('#view-catchup [data-cu-progress]')).toBeVisible({ timeout: 20_000 });
  }
  async function bootPage() {
    page = await context.newPage();
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    // No functions on this rig, and nothing reaches a sender even if one ran.
    await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
    await page.route('**/api/google-reviews**', (r) => r.fulfill({ contentType: 'application/json', body: '{"reviews":[]}' }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user && Array.isArray(window._leads)
      && !!window.NBDNumbers && !!window.NBDNumbersData && !!window.InvoicePipeline && !!window.NBDLostReason, { timeout: 30_000 });
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    stamp = Date.now();
    run = 'phone-catchup:' + stamp;
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
    await bootPage();
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    if (!context) return;
    // The invoices + timeline notes Record payment made carry no run tag: remove them by lead.
    try {
      await safeEvaluate(page, async (leadIds) => {
        const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const uid = window._user.uid;
        for (const id of leadIds) {
          for (const c of ['invoices', 'notes']) {
            const field = c === 'invoices' ? 'createdBy' : 'userId';
            const s = await fs.getDocs(fs.query(fs.collection(window.db, c), fs.where('leadId', '==', id), fs.where(field, '==', uid)));
            for (const d of s.docs) { try { await fs.deleteDoc(d.ref); } catch (_) {} }
          }
        }
        // Take this run's jobs back out of the catch-up progress.
        const co = window.NBDNumbersData.companyId();
        const ref = fs.doc(window.db, 'companies', co, 'owner_numbers', 'catchup');
        const cur = await fs.getDoc(ref);
        if (cur.exists()) {
          const d = cur.data();
          const done = Object.assign({}, d.doneJobs || {});
          leadIds.forEach((id) => { delete done[id]; });
          const log = (d.log || []).filter((e) => leadIds.indexOf(e.leadId) === -1);
          await fs.setDoc(ref, { doneJobs: done, log });
        }
      }, Object.values(ids));
    } catch (_) { /* best effort */ }
    const res = await deleteSeededRun({ page, context, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-catchup] cleanup: ' + res.failed.join('; '));
    await context.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('work through two won jobs, then reload: progress persists', async () => {
    test.setTimeout(240_000);
    const tag = String(stamp).slice(-6);
    const now = Date.now();
    const made = now - 45 * DAY;
    // Huge job values so these two lead the deck (most gaps, biggest booked).
    ids.a = await seedLead({ firstName: '[E2E] CatchA', lastName: 'Cu' + tag, address: tag + ' Alpha Way, Milford, OH 45150', stage: 'closed', stageRole: 'won', source: 'Referral', jobValue: 987654, createdAt: made, closedAt: made });
    ids.b = await seedLead({ firstName: '[E2E] CatchB', lastName: 'Cu' + tag, address: tag + ' Bravo Way, Milford, OH 45150', stage: 'closed', stageRole: 'won', source: 'Referral', jobValue: 987653, createdAt: made, closedAt: made });
    await reloadLeads([ids.a, ids.b]);

    await openCatchUp();
    const progress = page.locator('#view-catchup [data-cu-progress]');
    const before = Number(((await progress.textContent()) || '').match(/^(\d+) of/)[1]);
    const card = page.locator('#view-catchup .cu-card[data-cu-card="job"]');
    await expect(card).toHaveAttribute('data-id', ids.a, { timeout: 15_000 });
    await expect(card.locator('.cu-chip.cu-miss')).toHaveCount(4);

    // Fits the phone: nothing wider than the screen, no page-level sideways scroll.
    const overflow = await safeEvaluate(page, () => {
      const offenders = [];
      document.querySelectorAll('#view-catchup .cu-page *').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width && r.right > innerWidth + 1) offenders.push((el.className || el.tagName) + ' ' + Math.round(r.right)); });
      return { offenders, doc: document.scrollingElement.scrollWidth - innerWidth };
    });
    expect(overflow.offenders, 'nothing on the deck is wider than 390px').toEqual([]);
    expect(overflow.doc, 'no page-level horizontal scroll').toBeLessThanOrEqual(1);
    for (const sel of ['[data-cu="pif-yes"]', '[data-cu="done-job"]', '[data-cu="skip-job"]', '[data-cu="tier"][data-tier="better"]', '[data-cu="add-cost"]']) {
      const h = await safeEvaluate(page, (s) => { const el = document.querySelector('#view-catchup .cu-card ' + s); return el ? el.getBoundingClientRect().height : 0; }, sel);
      expect(h, sel + ' is a 44px target (sub-pixel rounding allowed)').toBeGreaterThanOrEqual(43.5);
    }

    // ── Job A: Paid in full ──
    await card.locator('[data-cu="pif-yes"]').tap();
    const sheet = page.locator('#cu-pif .nb-sheet');
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await expect(sheet.locator('[data-cu-amount]')).toHaveText('$987,654.00');
    await expect(sheet).toContainText('No receipt is emailed');
    const sb = await safeEvaluate(page, () => document.querySelector('#cu-pif .nb-sheet').getBoundingClientRect().right);
    expect(sb, 'the sheet fits the screen').toBeLessThanOrEqual(W + 0.5);
    // Close date == created date, no history → no date guessed: Jo enters it.
    await expect(page.locator('#cuPifDate')).toHaveValue('');
    const payDay = ymd(now - 10 * DAY);
    await page.locator('#cuPifDate').fill(payDay);
    await sheet.locator('[data-cu-method="zelle"]').tap();
    await sheet.locator('[data-cu-pif="save"]').tap();
    await expect(page.locator('#cu-pif')).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(async () => (await invoicesFor(page, ids.a)).length, { message: 'one invoice for job A', timeout: 20_000 }).toBe(1);
    const inv = (await invoicesFor(page, ids.a))[0];
    expect(inv.payments.length, 'exactly ONE payment').toBe(1);
    expect(inv.payments[0].amount, 'the job total').toBe(987654);
    expect(inv.payments[0].method).toBe('zelle');
    expect(ymd(inv.payments[0].at), 'dated the day Jo entered').toBe(payDay);
    expect(inv.status).toBe('paid');
    expect(inv.balanceDue).toBe(0);
    await expect(card.locator('.cu-chip.cu-ok')).toContainText(['Payments'], { timeout: 15_000 });

    // Package in one tap; close date saved.
    await card.locator('[data-cu="tier"][data-tier="better"]').tap();
    await expect.poll(async () => (await readDoc(page, 'leads/' + ids.a)).soldTier, { message: 'package saved', timeout: 15_000 }).toBe('better');
    const closeDay = ymd(now - 30 * DAY);
    await card.locator('[data-cu="close-date"]').fill(closeDay);
    await card.locator('[data-cu="save-close"]').tap();
    await expect.poll(async () => { const d = await readDoc(page, 'leads/' + ids.a); return d.closedAt ? ymd(d.closedAt) : ''; }, { message: 'close date saved', timeout: 15_000 }).toBe(closeDay);
    expect((await readDoc(page, 'leads/' + ids.a)).closedAtSource).toBe('manual');
    await card.locator('[data-cu="done-job"]').tap();
    await expect(card).toHaveAttribute('data-id', ids.b, { timeout: 15_000 });

    // ── Job B: package, Undo, package again, Done ──
    await card.locator('[data-cu="tier"][data-tier="good"]').tap();
    await expect.poll(async () => (await readDoc(page, 'leads/' + ids.b)).soldTier, { timeout: 15_000 }).toBe('good');
    await expect(page.locator('#view-catchup .cu-undo')).toContainText('Standard package');
    await page.locator('#view-catchup [data-cu="undo"]').tap();
    await expect.poll(async () => (await readDoc(page, 'leads/' + ids.b)).soldTier || null, { message: 'Undo put the package back', timeout: 15_000 }).toBe(null);
    await card.locator('[data-cu="tier"][data-tier="best"]').tap();
    await expect.poll(async () => (await readDoc(page, 'leads/' + ids.b)).soldTier, { timeout: 15_000 }).toBe('best');
    await card.locator('[data-cu="done-job"]').tap();
    await expect(progress).toHaveText(new RegExp('^' + (before + 2) + ' of '), { timeout: 15_000 });

    // ── Reload: the progress is still there ──
    await page.reload();
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user && Array.isArray(window._leads) && window._leads.length > 0
      && !!window.NBDNumbersData, { timeout: 30_000 });
    await reloadLeads([ids.a, ids.b]);
    await openCatchUp();
    await expect(progress).toHaveText(new RegExp('^' + (before + 2) + ' of '), { timeout: 20_000 });
    const shown = await safeEvaluate(page, () => { const c = document.querySelector('#view-catchup .cu-card[data-cu-card="job"]'); return c ? c.dataset.id : null; });
    expect([ids.a, ids.b], 'neither finished job is back on the deck').not.toContain(shown);
    const st = await safeEvaluate(page, () => window.NBDCatchUp._state().progress.doneJobs);
    expect(st[ids.a] && st[ids.b], 'both marked done in owner_numbers/catchup').toBe(true);
  });
});
