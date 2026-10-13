// tests/e2e/phone-already-completed.spec.js — "Already completed" on the
// Schedule view's Plan jobs panel, on an iPhone (390x844) in the INSTALLED
// app (2026-10-13).
//
// Jo: "We need to be able to say already completed on anything that missed
// scheduling and it forwards it to the next stage." Target Install Done; the
// completion date is asked each time (default today, never in the future);
// the move is QUIET.
//
//   1. A "Needs a date" row and a "Missed" row (date passed, never advanced)
//      both carry the button; a job already at Install Done / a lead on the
//      estimate side does not. Targets are 44px and the panel does not
//      scroll sideways.
//   2. A future date is refused (nothing written); a real past day moves the
//      lead to Install Done through the stage-write path: completedAt on that
//      day, completedBackfill (quiet), a stageHistory event, the activity
//      note, and NOTHING customer-facing (no Before & After report flag).
//   3. Undo puts the stage back and clears the completion fields; the row is
//      back in its list.
//
// No gateway is called: the callables are stubbed at the network, so nothing
// can text or email anyone. Every seeded doc carries e2eTestData + an e2eRun
// tag (fixtures/seeded-run.js) and is removed in afterAll.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390, H = 844;
let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

async function noSideScroll(page) {
  return safeEvaluate(page, () => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function box(page, selector) {
  const b = await page.locator(selector).first().boundingBox();
  return b || { x: -1, y: -1, width: 0, height: 0 };
}
async function dismissToasts(page) {
  for (let i = 0; i < 8; i++) {
    const close = page.locator('#toastContainer .toast-close').first();
    if (!(await close.count())) return;
    await close.tap({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
}
const readLead = (page, id) => safeEvaluate(page, async (leadId) => {
  const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
  const s = await fs.getDocFromServer(fs.doc(window.db || window._db, 'leads', leadId));
  return s.exists() ? s.data() : null;
}, id);
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

test.describe.serial('already completed on Plan jobs at 390px, installed app @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let run = '';
  let stamp = 0;
  let tag = '';
  const ids = {};

  async function seedLead(fields) {
    return safeEvaluate(page, async ({ f, t }) => {
      const id = await window._saveLead(Object.assign({ e2eTestData: true, e2eRun: t }, f));
      if (id) return id;
      const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const snap = await fs.getDocs(fs.query(fs.collection(window.db, 'leads'), fs.where('userId', '==', window._user.uid), fs.where('lastName', '==', f.lastName)));
      return snap.docs.length ? snap.docs[0].id : null;
    }, { f: fields, t: run });
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    stamp = Date.now();
    run = 'phone-already-completed:' + stamp;
    tag = 'ACmp' + String(stamp).slice(-6);
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
    // Callables answer null: nothing here can text or email anyone.
    await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user && Array.isArray(window._leads)
      && typeof window._saveLead === 'function', { timeout: 30_000 });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    if (!context) return;
    const res = await deleteSeededRun({ page, context, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-already-completed] cleanup: ' + res.failed.join('; '));
    await context.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('1. Needs-a-date and Missed rows carry "Already completed"; done / pre-sale rows do not', async () => {
    const addr = (n) => String(stamp).slice(-4) + ' ' + n + ' Way, Milford, OH';
    ids.needs = await seedLead({ firstName: '[E2E] Needs', lastName: tag + 'N', address: addr('Needs'), stage: 'contract_signed', jobType: 'cash', jobValue: 12000, contractFiledAt: '2026-09-01T00:00:00Z' });
    ids.missed = await seedLead({ firstName: '[E2E] Missed', lastName: tag + 'M', address: addr('Missed'), stage: 'install_in_progress', jobType: 'cash', jobValue: 9000, scheduledDate: dayOffset(-6) });
    ids.done = await seedLead({ firstName: '[E2E] Done', lastName: tag + 'D', address: addr('Done'), stage: 'install_complete', jobType: 'cash', jobValue: 8000, scheduledDate: dayOffset(-9) });
    ids.estimate = await seedLead({ firstName: '[E2E] Estimate', lastName: tag + 'E', address: addr('Estimate'), stage: 'estimate_sent_cash', jobType: 'cash', jobValue: 7000 });
    expect(ids.needs && ids.missed && ids.done && ids.estimate, 'all four seeded').toBeTruthy();
    await safeWaitForFunction(page, (n) => (window._leads || []).filter((l) => String(l.lastName || '').startsWith(n)).length === 4, { timeout: 20_000 }, tag)
      .catch(async () => { await safeEvaluate(page, () => window._loadLeads && window._loadLeads()); });
    await safeEvaluate(page, () => { window.goTo('schedule'); window.scrollTo(0, 0); });
    await expect(page.locator('#schedPlanBody')).toBeVisible({ timeout: 15_000 });
    await safeEvaluate(page, (n) => {
      const all = document.getElementById('spAll');
      if (all && !all.checked) all.click();
      const s = document.getElementById('spSearch');
      s.value = n; s.dispatchEvent(new Event('input', { bubbles: true }));
    }, tag);
    const needsRow = `.sp-row[data-id="${ids.needs}"]`;
    const missedRow = `.sp-row[data-id="${ids.missed}"]`;
    await expect(page.locator(needsRow)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(missedRow)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(needsRow + ' [data-sp-action="done-open"]')).toHaveCount(1);
    await expect(page.locator(missedRow + ' [data-sp-action="done-open"]')).toHaveCount(1);
    await expect(page.locator('.sp-h', { hasText: 'Missed' }), 'the Missed group is on the panel').toBeVisible();
    await expect(page.locator(missedRow + ' .sp-week-late')).toContainText('never moved on');
    await expect(page.locator(`.sp-row[data-id="${ids.done}"]`), 'an already-done job is in no list').toHaveCount(0);
    await expect(page.locator(`.sp-row[data-id="${ids.estimate}"] [data-sp-action="done-open"]`), 'a pre-sale lead is not offered it').toHaveCount(0);
    await page.locator(needsRow + ' [data-sp-action="done-open"]').scrollIntoViewIfNeeded();
    expect((await box(page, needsRow + ' [data-sp-action="done-open"]')).height, 'a 44px target').toBeGreaterThanOrEqual(44);
    expect(await noSideScroll(page), 'no sideways scroll at 390px').toBe(true);
  });

  test('2. a future day is refused; a real past day moves it to Install Done, quietly', async () => {
    const row = `.sp-row[data-id="${ids.needs}"]`;
    await dismissToasts(page);
    await page.locator(row + ' [data-sp-action="done-open"]').tap();
    const input = page.locator(row + ' .sp-done-date');
    await expect(input).toBeVisible();
    const today = dayOffset(0);
    await expect(input, 'defaults to today').toHaveValue(today);
    await expect(input, 'cannot go past today').toHaveAttribute('max', today);
    for (const sel of ['.sp-done-go', '.sp-done-no']) {
      expect((await box(page, row + ' ' + sel)).height, sel + ' is a 44px target').toBeGreaterThanOrEqual(44);
    }
    expect(await noSideScroll(page), 'the confirm fits 390px').toBe(true);

    // A future day: refused, nothing written.
    await input.fill(dayOffset(3));
    await input.dispatchEvent('change');
    await page.locator(row + ' [data-sp-action="done-go"]').tap();
    await expect(page.locator(row + ' .sp-msg')).toContainText('future', { timeout: 5_000 });
    const still = await readLead(page, ids.needs);
    expect(still.stage, 'a refused date moves nothing').toBe('contract_signed');
    expect(still.completedAt || null).toBeNull();

    // A real past day.
    const past = dayOffset(-4);
    await input.fill(past);
    await input.dispatchEvent('change');
    await page.locator(row + ' [data-sp-action="done-go"]').tap();
    await expect.poll(async () => (await readLead(page, ids.needs)).stage, { timeout: 15_000 }).toBe('install_complete');
    const l = await readLead(page, ids.needs);
    expect(l.completedBackfill && l.completedBackfill.date, 'the completion day').toBe(past);
    expect(l.completedBackfill.quiet, 'quiet flag').toBe(true);
    expect(l.completedBackfill.byUid, 'who did it').toBeTruthy();
    // A Timestamp crosses page.evaluate as { seconds, nanoseconds } (methods are lost).
    const sec = l.completedAt ? (l.completedAt.seconds != null ? l.completedAt.seconds : l.completedAt._seconds) : null;
    const at = sec != null ? new Date(sec * 1000) : null;
    expect(at && ymd(at), 'completedAt is that day').toBe(past);
    const ev = (l.stageHistory || []).filter((h) => h && h.to === 'install_complete').pop() || {};
    expect(ev.backfill, 'stage history says it was a backfill').toBe(true);
    expect(ev.completedOn).toBe(past);
    // Quiet: no automatic Before & After report was requested.
    await page.waitForTimeout(2_500);
    const q = await readLead(page, ids.needs);
    expect(q.beforeAfterReportAt || null, 'no report filed').toBeNull();
    expect(q.beforeAfterReportPending || null, 'no report queued').toBeNull();
    await expect(page.locator(row), 'the row left the list').toHaveCount(0);
    await expect(page.locator('#toastContainer .toast-message', { hasText: 'Marked completed' })).toBeVisible();
    await expect(page.locator('#toastContainer .toast-message', { hasText: 'now Install Done' })).toBeVisible();
    expect(ids.needs).toBeTruthy();
  });

  test('3. Undo restores the stage and clears the completion fields; the row is back', async () => {
    const row = `.sp-row[data-id="${ids.needs}"]`;
    const undo = page.locator('#toastContainer .toast-btn-primary', { hasText: 'Undo' }).first();
    await expect(undo).toBeVisible({ timeout: 5_000 });
    await undo.tap();
    await expect.poll(async () => (await readLead(page, ids.needs)).stage, { timeout: 15_000 }).toBe('contract_signed');
    const l = await readLead(page, ids.needs);
    expect(l.completedAt || null, 'completion date cleared').toBeNull();
    expect(l.completedBackfill || null, 'quiet flag cleared').toBeNull();
    await expect(page.locator(row), 'back in Needs a date').toBeVisible({ timeout: 10_000 });
    expect(await noSideScroll(page)).toBe(true);
  });

  test('4. a Missed row completes the same way', async () => {
    const row = `.sp-row[data-id="${ids.missed}"]`;
    await dismissToasts(page);
    await page.locator(row + ' [data-sp-action="done-open"]').tap();
    const past = dayOffset(-5);
    await page.locator(row + ' .sp-done-date').fill(past);
    await page.locator(row + ' .sp-done-date').dispatchEvent('change');
    await page.locator(row + ' [data-sp-action="done-go"]').tap();
    await expect.poll(async () => (await readLead(page, ids.missed)).stage, { timeout: 15_000 }).toBe('install_complete');
    expect((await readLead(page, ids.missed)).completedBackfill.date).toBe(past);
    await expect(page.locator(row)).toHaveCount(0);
  });
});
