/**
 * tests/e2e/jobs-cards.spec.js — multi-job stage 2a in a real browser on the
 * emulators (2026-09-30; plan CRM-JOBS-AND-MONEY-PAPER-PLAN, Jo J3).
 *
 * Pat Oakfield's case: a $250 repair is closed but not yet paid in full,
 * and a new caulk job starts → the pipeline shows TWO cards for one customer.
 * Moving the caulk card writes only that job (the customer's own stage is
 * untouched). Once the first job is paid in full, only the caulk card shows.
 * A customer with one job still shows exactly one card (positive control).
 *
 * The server mirror (functions/jobs-mirror.js) is not running here, so the
 * test sets activeJobId / the jobs with the admin SDK, as the mirror would.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

let _admin = null;
function admin() {
  if (_admin) return _admin;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _admin = { db: getFirestore() };
  return _admin;
}

async function openCrm(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForLoadState('load');
      await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 15_000 });
      await page.evaluate(() => window.goTo('crm'));
      return;
    } catch (e) { if (!/Execution context was destroyed|navigation/i.test(String(e))) throw e; }
  }
}

test.describe.serial('Multi-job pipeline cards @shard2', () => {
  test('two open jobs → two cards; the extra card moves only its job; paid-in-full retires the first', async ({ page }) => {
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_kanban_view', 'simple'); } catch (_) {} });
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.setViewportSize({ width: 1400, height: 900 });
    await loginAs(page, creds);
    await openCrm(page);
    await safeWaitForFunction(page, () => window._leadsLoaded === true && !!window.NBDJobs, null, { timeout: 20_000 });

    const stamp = Date.now();
    const ids = await safeEvaluate(page, async (s) => {
      const two = await window._saveLead({ firstName: 'ZZMJ', lastName: 'Two' + s, address: '12 Two Jobs Ln, Mason, OH 45040', phone: '5135550' + String(s).slice(-3), stage: 'closed', jobValue: 250, e2eTestData: true });
      const one = await window._saveLead({ firstName: 'ZZMJ', lastName: 'One' + s, address: '34 One Job Ct, Mason, OH 45040', phone: '5135551' + String(s).slice(-3), stage: 'contacted', e2eTestData: true });
      return { two, one, uid: window._user.uid, companyId: (window._userClaims && window._userClaims.companyId) || window._user.uid };
    }, stamp);
    expect(ids.two && ids.one, 'two leads saved').toBeTruthy();

    // What the server mirror + stage 1 would have written.
    const { db } = admin();
    const leadTwo = (await db.doc('leads/' + ids.two).get()).data();
    const own = { userId: leadTwo.userId, companyId: leadTwo.companyId };
    await db.doc('leads/' + ids.two + '/jobs/j1').set(Object.assign({ stage: 'closed', stageRole: 'won', jobValue: 250, title: 'Shake repair', createdAt: new Date(1000) }, own));
    await db.doc('leads/' + ids.two + '/jobs/j2').set(Object.assign({ stage: 'new', stageRole: 'new', jobValue: 180, title: 'Caulk + sealant', createdAt: new Date(2000) }, own));
    await db.doc('leads/' + ids.two).update({ activeJobId: 'j1' });
    await db.doc('leads/' + ids.one + '/jobs/j1').set(Object.assign({ stage: 'contacted', stageRole: 'active', createdAt: new Date(1000) }, own));
    await db.doc('leads/' + ids.one).update({ activeJobId: 'j1' });

    // Reload leads (activeJobId) → jobs load → re-render.
    await safeEvaluate(page, async () => { if (typeof window.loadLeads === 'function') await window.loadLeads(); await window.NBDJobs.load(); window.renderLeads(window._leads, window._filteredLeads); });
    const cardsOf = (leadId) => safeEvaluate(page, (id) => [...document.querySelectorAll('.k-card[data-id="' + id + '"]')]
      .map((c) => ({ job: c.dataset.jobId || null, col: (c.closest('[id^="kbody-"]') || {}).id || '' })), leadId);

    await expect.poll(() => cardsOf(ids.two).then((c) => c.length), { timeout: 10_000 }).toBe(2);
    const two = await cardsOf(ids.two);
    ok(two.some((c) => c.job === null), 'the active job\'s card is the customer card (no job id)');
    ok(two.some((c) => c.job === 'j2' && /new/.test(c.col)), 'the caulk job\'s card sits in New: ' + JSON.stringify(two));
    expect((await cardsOf(ids.one)).length, 'a one-job customer still shows exactly one card').toBe(1);

    // Move the caulk card with its ▶ arrow.
    const arrow = page.locator('.k-card[data-id="' + ids.two + '"][data-job-id="j2"] [data-action="move-card"][data-job-id="j2"]').last();
    const target = await arrow.getAttribute('data-target-stage');
    await arrow.click();
    await expect.poll(async () => (await db.doc('leads/' + ids.two + '/jobs/j2').get()).data().stage, { timeout: 10_000 }).toBe(target);
    const leadAfter = (await db.doc('leads/' + ids.two).get()).data();
    expect(leadAfter.stage, 'the customer (active job) stage is untouched').toBe('closed');
    const j2 = (await db.doc('leads/' + ids.two + '/jobs/j2').get()).data();
    expect(Array.isArray(j2.stageHistory) && j2.stageHistory.some((h) => h.from === 'new' && h.to === target), 'the job keeps its own stage history').toBe(true);

    // The first job is paid in full → it is done → only the caulk card shows.
    await db.doc('leads/' + ids.two + '/jobs/j1').update({ paidInFull: true });
    await safeEvaluate(page, async () => { await window.NBDJobs.load(); window.renderLeads(window._leads, window._filteredLeads); });
    await expect.poll(() => cardsOf(ids.two), { timeout: 10_000 }).toEqual([expect.objectContaining({ job: 'j2' })]);
  });
});

function ok(cond, msg) { expect(cond, msg).toBe(true); }
