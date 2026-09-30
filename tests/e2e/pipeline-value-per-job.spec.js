/**
 * tests/e2e/pipeline-value-per-job.spec.js — money totals count every JOB
 * (multi-job, 2026-09-30; jobs-store.js recordsFor).
 *
 * A customer whose card shows a won roof ($250) also has an open caulk job
 * ($180). On the real dashboard: the KPI pipeline value includes the caulk
 * job; the customer's own record is unchanged. The server mirror is not
 * running here, so the test seeds the jobs + activeJobId with the admin SDK.
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

test.describe.serial('Pipeline value per job @shard2', () => {
  test('a customer\'s second open job adds its own value to the KPI pipeline', async ({ page }) => {
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => window._leadsLoaded === true && !!window.NBDJobs && typeof window.computeKPIs === 'function', null, { timeout: 20_000 });

    const s = Date.now();
    const id = await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZPV', lastName: 'Value' + st, address: '7 Value Ct, Mason, OH 45040', phone: '5135554' + String(st).slice(-3), stage: 'closed', jobValue: 250, e2eTestData: true }), s);
    const db = adb();
    const lead = (await db.doc('leads/' + id).get()).data();
    const own = {};
    if (lead.userId) own.userId = lead.userId;
    if (lead.companyId) own.companyId = lead.companyId;
    await db.doc('leads/' + id + '/jobs/j1').set(Object.assign({ stage: 'closed', stageRole: 'won', jobValue: 250, title: 'Roof', createdAt: new Date(1000) }, own));
    await db.doc('leads/' + id).update({ activeJobId: 'j1' });

    const pipeline = () => safeEvaluate(page, async () => { if (typeof window.loadLeads === 'function') await window.loadLeads(); await window.NBDJobs.load(); return window.computeKPIs().pipelineValue; });
    const before = await pipeline();
    await db.doc('leads/' + id + '/jobs/j2').set(Object.assign({ stage: 'new', stageRole: 'new', jobValue: 180, title: 'Caulk', createdAt: new Date(2000) }, own));
    const after = await pipeline();
    expect(after - before, 'the caulk job adds its own $180 to the pipeline (the won roof is not pipeline)').toBe(180);
    const recs = await safeEvaluate(page, (lid) => window.NBDJobs.recordsFor(window._leads.filter((l) => l.id === lid)).map((r) => ({ job: r._jobId || null, role: r._stageRole, v: r.jobValue })), id);
    expect(recs, 'two records: the customer (won roof) and the caulk job (new)').toEqual([{ job: null, role: 'won', v: 250 }, { job: 'j2', role: 'new', v: 180 }]);
  });
});
