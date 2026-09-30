/**
 * tests/e2e/invoice-job-id.spec.js — an invoice records the JOB it bills
 * (multi-job, 2026-09-30). money-paper.js marks exactly that job paid in
 * full, so an invoice must not follow whatever job later takes over the
 * customer's card.
 *
 *  - no job named on the estimate → the job on the customer's card now
 *  - the estimate names a job → that job
 *
 * The server mirror is not running here: the test seeds the jobs and
 * activeJobId with the admin SDK, as the mirror would.
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

test.describe.serial('Invoice → job @shard2', () => {
  test('an invoice made from an estimate carries the job it bills', async ({ page }) => {
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.InvoicePipeline, null, { timeout: 20_000 });

    const s = Date.now();
    const id = await safeEvaluate(page, (st) => window._saveLead({ firstName: 'ZZIJ', lastName: 'Invoice' + st, address: '8 Billing Way, Mason, OH 45040', phone: '5135553' + String(st).slice(-3), email: 'delivered@resend.dev', stage: 'closed', e2eTestData: true }), s);
    expect(id, 'lead saved').toBeTruthy();
    const db = adb();
    const lead = (await db.doc('leads/' + id).get()).data();
    const own = {};
    if (lead.userId) own.userId = lead.userId;
    if (lead.companyId) own.companyId = lead.companyId;
    await db.doc('leads/' + id + '/jobs/j1').set(Object.assign({ stage: 'closed', stageRole: 'won', title: 'Roof', createdAt: new Date(1000) }, own));
    await db.doc('leads/' + id + '/jobs/j2').set(Object.assign({ stage: 'contract_signed', stageRole: 'job', title: 'Gutter guards', createdAt: new Date(2000) }, own));
    await db.doc('leads/' + id).update({ activeJobId: 'j2' });
    await safeEvaluate(page, async () => { if (typeof window.loadLeads === 'function') await window.loadLeads(); });

    const est = (extra) => Object.assign({ leadId: id, userId: lead.userId, createdBy: lead.userId, companyId: lead.companyId || lead.userId, title: 'ZZIJ estimate', total: 1450, amount: 1450,
      lineItems: [{ description: 'Gutter guards, 120 LF', qty: 1, rate: 1450 }], e2eTestData: true, createdAt: new Date() }, extra);
    await db.doc('estimates/zzij' + s + 'a').set(est({}));
    await db.doc('estimates/zzij' + s + 'b').set(est({ jobId: 'j1' }));

    const invA = await safeEvaluate(page, (eid) => window.InvoicePipeline.createInvoiceFromEstimate(eid), 'zzij' + s + 'a');
    const invB = await safeEvaluate(page, (eid) => window.InvoicePipeline.createInvoiceFromEstimate(eid), 'zzij' + s + 'b');
    expect(invA && invB, 'both invoices created: ' + JSON.stringify([invA, invB])).toBeTruthy();
    const a = (await db.doc('invoices/' + invA).get()).data();
    const b = (await db.doc('invoices/' + invB).get()).data();
    expect(a.jobId, 'no job on the estimate → the job on the customer\'s card (gutters)').toBe('j2');
    expect(b.jobId, 'the estimate names the roof job → the roof').toBe('j1');
    expect(a.total, 'the invoice is otherwise the same').toBe(1450);
  });
});
