/**
 * tests/e2e/customer-jobs.spec.js — multi-job stage 2b UI on the emulators
 * (2026-09-30; plan CRM-JOBS-AND-MONEY-PAPER-PLAN, Jo J3).
 *
 * The customer page's Jobs panel lists the customer's jobs; "＋ Add job"
 * writes a new job through the real Firestore rules (jobWriteOk: stamps equal
 * the lead's), and it shows as a second open job with its own card. The
 * duplicate-lead prompt's "Add a job to them" lands on
 * customer.html?id=X#addJob, which opens the add sheet on load.
 *
 * The server mirror is not running here, so the test seeds j1 + activeJobId
 * with the admin SDK, as the mirror would.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

let _db = null;
function adb() {
  if (_db) return _db;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _db = getFirestore();
  return _db;
}

async function openCustomer(page, id, hash) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto('/pro/customer.html?id=' + id + (hash || '')); break; }
    catch (e) {
      if (!/ERR_ABORTED|interrupted by another navigation/.test(String(e)) || attempt === 2) throw e;
      await page.waitForTimeout(1_500);
    }
  }
}

test.describe.serial('Customer page: jobs + add job @shard2', () => {
  test('each job shows its own direct costs and margin; an older job-less expense counts toward the first job', async ({ page }) => {
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user, null, { timeout: 20_000 });
    const s = Date.now();
    const id = await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZCC', lastName: 'Costs' + st, address: '9 Cost Ct, Mason, OH 45040', phone: '5135556' + String(st).slice(-3), stage: 'closed', jobValue: 900, e2eTestData: true }), s);
    const db = adb();
    const lead = (await db.doc('leads/' + id).get()).data();
    const own = {};
    if (lead.userId) own.userId = lead.userId;
    if (lead.companyId) own.companyId = lead.companyId;
    await db.doc('leads/' + id + '/jobs/j1').set(Object.assign({ stage: 'closed', stageRole: 'won', jobValue: 900, title: 'Roof repair', createdAt: new Date(1000) }, own));
    await db.doc('leads/' + id + '/jobs/j2').set(Object.assign({ stage: 'new', stageRole: 'new', jobValue: 1450, title: 'Gutter guards', createdAt: new Date(2000) }, own));
    await db.doc('leads/' + id).update({ activeJobId: 'j1' });
    const exp = (extra) => Object.assign({ userId: lead.userId, companyId: lead.companyId || lead.userId, leadId: id, category: 'materials', costType: 'direct', amountCents: 0, date: new Date(), supplier: 'ZZCC ' + s, e2eTestData: true }, extra);
    await db.collection('expenses').add(exp({ jobId: 'j2', amountCents: 50000 }));            // $500 on the gutter job
    await db.collection('expenses').add(exp({ amountCents: 10000 }));                         // $100, logged before jobs → the first job
    await db.collection('expenses').add(exp({ jobId: 'j2', costType: 'overhead', category: 'vehicle_fuel', amountCents: 99900 })); // overhead: not a job cost

    await openCustomer(page, id);
    const row = (jid) => page.locator('#jobsPanel [data-cj-job="' + jid + '"] .cj-cost');
    await expect(row('j2'), 'the gutter job: its own $500 direct cost, margin on $1,450').toHaveText('costs $500 · 66% margin', { timeout: 20_000 });
    await expect(row('j1'), 'the roof repair: the older job-less $100').toHaveText('costs $100 · 89% margin');
  });

  test('Jobs panel lists the job; ＋ Add job writes a second open job through the rules; #addJob opens the sheet', async ({ page }) => {
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user, null, { timeout: 20_000 });

    const s = Date.now();
    const id = await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZCJ', lastName: 'Jobs' + st, address: '56 Add Job Way, Mason, OH 45040', phone: '5135552' + String(st).slice(-3), stage: 'contacted', jobValue: 900, e2eTestData: true }), s);
    expect(id, 'lead saved').toBeTruthy();
    const db = adb();
    const lead = (await db.doc('leads/' + id).get()).data();
    const own = {};
    if (lead.userId) own.userId = lead.userId;
    if (lead.companyId) own.companyId = lead.companyId;
    await db.doc('leads/' + id + '/jobs/j1').set(Object.assign({ stage: 'contacted', stageRole: 'active', jobValue: 900, title: 'Roof replacement', createdAt: new Date(1000) }, own));
    await db.doc('leads/' + id).update({ activeJobId: 'j1' });

    await openCustomer(page, id);
    const panel = page.locator('#jobsPanel');
    await expect(panel, 'the Jobs panel renders').toContainText('Roof replacement', { timeout: 20_000 });
    await expect(panel.locator('[data-cj-job="j1"] [data-cj-standing]')).toHaveAttribute('data-cj-standing', 'card');

    // Add a job.
    await panel.locator('[data-cj-add]').click();
    await expect(page.locator('#cjAddSheet')).toBeVisible();
    await page.locator('#cjSave').click();
    await expect(page.locator('#cjErr'), 'a title is required').toContainText('Say what the job is');
    await page.locator('#cjTitle').fill('Gutter guards');
    await page.locator('#cjType').selectOption('cash');
    await page.locator('#cjValue').fill('1450');
    await page.locator('#cjScope').fill('Lock-In guards, front + back runs');
    await page.locator('#cjSave').click();
    await expect(page.locator('#cjAddSheet'), 'the sheet closes on save').toHaveCount(0, { timeout: 10_000 });

    const jobs = (await db.collection('leads/' + id + '/jobs').get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const added = jobs.find((j) => j.title === 'Gutter guards');
    expect(added, 'the new job is in Firestore: ' + JSON.stringify(jobs.map((j) => j.id))).toBeTruthy();
    expect(added.stage).toBe('new');
    expect(added.jobType).toBe('cash');
    expect(added.jobValue).toBe(1450);
    expect(added.scopeOfWork).toContain('Lock-In');
    expect(added.userId || null, 'owner stamp equals the lead\'s').toBe(lead.userId || null);
    expect(added.companyId || null, 'company stamp equals the lead\'s').toBe(lead.companyId || null);
    expect(added.property && added.property.address).toBe('56 Add Job Way, Mason, OH 45040');
    const after = (await db.doc('leads/' + id).get()).data();
    expect(after.activeJobId, 'the customer card stays on the first job').toBe('j1');
    expect(after.jobValue).toBe(900);

    await expect(panel.locator('[data-cj-job="' + added.id + '"] [data-cj-standing]'), 'the new job is open with its own card').toHaveAttribute('data-cj-standing', 'open');
    await expect(panel).toContainText('Jobs (2)');

    // The duplicate-lead prompt's "Add a job to them" link.
    await openCustomer(page, id, '#addJob');
    await expect(page.locator('#cjAddSheet'), '#addJob opens the add sheet on load').toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#cjAddSheet')).toHaveCount(0);

    // Phone scale (standing rule): the panel and the sheet fit an iPhone.
    await page.setViewportSize({ width: 390, height: 844 });
    await openCustomer(page, id, '#addJob');
    await expect(page.locator('#cjAddSheet')).toBeVisible({ timeout: 20_000 });
    const box = await page.locator('#cjAddForm').boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, 'the sheet fits a 390px screen: ' + JSON.stringify(box)).toBe(true);
    if (process.env.CJ_SHOTS) await page.screenshot({ path: process.env.CJ_SHOTS + '/cj-sheet-phone.png' });
    await page.keyboard.press('Escape');
    await page.locator('#jobsPanel').scrollIntoViewIfNeeded();
    const pbox = await page.locator('#jobsPanel').boundingBox();
    expect(pbox && pbox.x + pbox.width <= 390, 'the Jobs panel fits: ' + JSON.stringify(pbox)).toBe(true);
    if (process.env.CJ_SHOTS) await page.locator('#jobsPanel').screenshot({ path: process.env.CJ_SHOTS + '/cj-panel-phone.png' });
  });
});
