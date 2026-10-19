// @ts-check
/**
 * tests/e2e/phone-job-cost-audit.spec.js — the Job cost auditor fits a phone and
 * does what its buttons say (2026-10-19).
 *
 * Loads the real css + logic + UI files into a blank page with a stubbed CRM
 * (flag on, synthetic leads / costs / roster, spies for addDoc and updateDoc).
 * No server and no network: nothing can reach the real CRM.
 *
 *   1. at 360px and 412px nothing in the queue, the job sheet or Ask me passes
 *      the right edge, and every button, chip and input is thumb-sized;
 *   2. a saved cost is the /expenses document the CRM already uses, with an edit
 *      log (source cost-auditor) and cents;
 *   3. with fewer than 3 similar jobs the sheet says so and the box is empty;
 *      with 3, "Use median" fills it from the company's own jobs;
 *   4. an estimate is saved estimated:true;
 *   5. Skip is remembered on the lead; Costs complete is written once;
 *   6. a void needs a reason and stamps deletedAt.
 *
 * Tagged @phonefit like phone-fit.spec.js.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'docs', 'pro');

const STUB = () => {
  window.__adds = []; window.__upd = [];
  window.NBDFlags = { enabled: (n) => n === 'jobCostAuditor' };
  window._user = { uid: 'u1' }; window._userClaims = { companyId: 'co1' };
  window.db = {};
  window.doc = (d, c, i) => c + '/' + i;
  window.collection = (d, ...p) => p.join('/');
  window.serverTimestamp = () => '__ts__';
  window.getDocs = async () => ({ forEach(cb) { [{ id: 's1', name: 'Sample Crew', trade: 'roofing', active: true }, { id: 's2', name: 'Other Sub', trade: 'gutters', active: true }].forEach((d) => cb({ id: d.id, data: () => d })); } });
  window.addDoc = async (col, data) => { window.__adds.push({ col, data }); return { id: 'new' + window.__adds.length }; };
  window.updateDoc = async (ref, p) => { window.__upd.push({ ref, p }); };
  window.showToast = () => {};
  const created = new Date('2026-01-05T12:00:00');
  const lead = (id, first, extra) => Object.assign({ id, firstName: first, lastName: 'Sample', stage: 'closed', trades: ['roof'], createdAt: created, address: '1 Sample St, Town, OH' }, extra || {});
  window.__peers = false;
  window._leads = [lead('a', 'Alpha'), lead('b', 'Bravo'), lead('p1', 'Peerone'), lead('p2', 'Peertwo'), lead('p3', 'Peerthree')];
  const inv = (leadId, total) => ({ leadId, total, balanceDue: 0, payments: [{ amount: total, at: new Date('2026-08-01T12:00:00') }] });
  const INV = [inv('a', 12000), inv('b', 9000), inv('p1', 10000), inv('p2', 10000), inv('p3', 10000)];
  window.NBDRevenue = {
    loadInvoices: async () => INV,
    collectedByLead: () => ({ a: 12000, b: 9000, p1: 10000, p2: 10000, p3: 10000 }),
  };
  const row = (id, leadId, category, cents, extra) => Object.assign({ id, leadId, category, costType: 'direct', amountCents: cents, taxCents: 0, supplier: 'S' + id, date: new Date('2026-08-02T12:00:00'), userId: 'u1' }, extra || {});
  window.__E = [row('m1', 'a', 'materials', 200000), row('m2', 'b', 'materials', 100000),
    row('s1', 'p1', 'subcontractor', 380000), row('s2', 'p2', 'subcontractor', 440000), row('s3', 'p3', 'subcontractor', 520000)];
  window.Expenses = { list: () => window.__E, refresh() {} };
};

async function boot(page, withPeers) {
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="boot"></body></html>');
  await page.evaluate(STUB);
  if (!withPeers) await page.evaluate(() => { window.__E = window.__E.filter((e) => e.id !== 's3' && e.id !== 's2'); });
  await page.addStyleTag({ path: path.join(ROOT, 'css', 'job-cost-audit.css') });
  await page.addScriptTag({ path: path.join(ROOT, 'js', 'job-cost-audit-logic.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'js', 'job-cost-audit.js') });
  await page.evaluate(() => window.NBDJobCostAuditor.open());
  await page.waitForSelector('.jc-sheet');
}

const fits = async (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const off = [];
  document.querySelectorAll('.jc-overlay *').forEach((el) => { const b = el.getBoundingClientRect(); if (b.width && b.right > vw + 0.5) off.push(el.className + ':' + Math.round(b.right)); });
  const small = [...document.querySelectorAll('.jc-btn, .jc-chip, .jc-x, .jc-in, .jc-check')].filter((b) => b.getBoundingClientRect().height < 44 && b.getBoundingClientRect().height > 0).map((b) => b.className + ':' + Math.round(b.getBoundingClientRect().height));
  return { off, small, scrollW: document.querySelector('.jc-overlay').scrollWidth, vw };
});

for (const width of [360, 412]) {
  test.describe(`job cost auditor at ${width}px @phonefit @audit`, () => {
    test.use({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true });

    test('the queue, the job sheet and Ask me fit and are thumb-sized', async ({ page }) => {
      await boot(page, true);
      let r = await fits(page);
      expect(r.off, 'queue: past the right edge').toEqual([]);
      expect(r.scrollW).toBeLessThanOrEqual(r.vw);
      expect(r.small, 'queue: under 44px').toEqual([]);
      await page.click('[data-jc-action="open"][data-jc-id="a"]');
      await page.waitForSelector('#jcAmount');
      r = await fits(page);
      expect(r.off, 'sheet: past the right edge').toEqual([]);
      expect(r.scrollW).toBeLessThanOrEqual(r.vw);
      expect(r.small, 'sheet: under 44px').toEqual([]);
      await page.click('[data-jc-action="back"]');
      await page.click('[data-jc-action="ask-start"]');
      await page.waitForSelector('.jc-q');
      r = await fits(page);
      expect(r.off, 'ask: past the right edge').toEqual([]);
      expect(r.scrollW).toBeLessThanOrEqual(r.vw);
      expect(r.small, 'ask: under 44px').toEqual([]);
    });

    test('a saved cost is an expenses document with cents and an edit log', async ({ page }) => {
      await boot(page, true);
      await page.click('[data-jc-action="open"][data-jc-id="a"]');
      await page.click('[data-jc-action="who"][data-jc-name="Sample Crew"]');
      await page.fill('#jcAmount', '4,400.50');
      await page.click('[data-jc-action="save"]');
      const adds = await page.evaluate(() => window.__adds);
      expect(adds).toHaveLength(1);
      expect(adds[0].col).toBe('expenses');
      const d = adds[0].data;
      expect(d).toMatchObject({ leadId: 'a', category: 'subcontractor', costType: 'direct', amountCents: 440050, taxCents: 0, supplier: 'Sample Crew', subId: 's1', source: 'cost_auditor', auditKind: 'sub', estimated: false, userId: 'u1', companyId: 'co1', needsReview: false });
      expect(d.editLog).toHaveLength(1);
      expect(d.editLog[0]).toMatchObject({ what: 'create', source: 'cost-auditor', by: 'u1' });
      expect(typeof d.editLog[0].at).toBe('number');
      // the new cost shows in the list right away
      await expect(page.locator('.jc-costs')).toContainText('$4,400.50');
    });

    test('under 3 similar jobs: it says so and the box stays empty', async ({ page }) => {
      await boot(page, false);
      await page.click('[data-jc-action="open"][data-jc-id="a"]');
      await expect(page.locator('.jc-sug')).toContainText('need 3');
      expect(await page.inputValue('#jcAmount')).toBe('');
      await expect(page.locator('[data-jc-action="use"]')).toHaveCount(0);
    });

    test('with 3 similar jobs, Use median fills the box from the company\'s own jobs', async ({ page }) => {
      await boot(page, true);
      await page.click('[data-jc-action="open"][data-jc-id="a"]');
      await expect(page.locator('.jc-sug')).toContainText('Similar jobs: sub cost 38-52% of collected, median 44%');
      await page.click('[data-jc-action="use"][data-jc-p="median"]');
      expect(await page.inputValue('#jcAmount')).toBe('5280.00'); // 44% of $12,000
      expect(await page.inputValue('#jcPct')).toBe('44');
      // the slider moves the amount
      await page.evaluate(() => { const r = document.getElementById('jcPct'); r.value = '10'; r.dispatchEvent(new Event('input', { bubbles: true })); });
      expect(await page.inputValue('#jcAmount')).toBe('1200.00');
    });

    test('an estimate is saved estimated:true', async ({ page }) => {
      await boot(page, true);
      await page.click('[data-jc-action="open"][data-jc-id="a"]');
      await page.click('[data-jc-action="who"][data-jc-name="Other Sub"]');
      await page.click('[data-jc-action="estimate"]');
      expect(await page.inputValue('#jcAmount')).toBe('5280.00');
      await page.click('[data-jc-action="save"]');
      const adds = await page.evaluate(() => window.__adds);
      expect(adds[0].data.estimated).toBe(true);
      await expect(page.locator('.jc-costs')).toContainText('estimate');
    });

    test('Ask me: Skip is remembered on the lead; Costs complete is written', async ({ page }) => {
      await boot(page, true);
      await page.click('[data-jc-action="ask-start"]');
      await expect(page.locator('.jc-q')).toContainText('Did a sub do this one');
      await page.click('[data-jc-action="ask-answer"][data-jc-a="skip"]');
      let u = await page.evaluate(() => window.__upd);
      expect(u).toHaveLength(1);
      expect(u[0].ref).toMatch(/^leads\//);
      expect(u[0].p['costAudit.asked.sub']).toBe('skip');
      // the next question is NOT the sub question again
      await expect(page.locator('.jc-q')).not.toContainText('Did a sub do this one');
      await page.click('[data-jc-action="ask-stop"]');
      await page.click('[data-jc-action="open"][data-jc-id="a"]');
      // the job still has a flag, so the first tap asks, the second completes
      await page.click('.jc-act [data-jc-action="complete"]');
      await expect(page.locator('.jc-warnbox')).toBeVisible();
      await page.click('.jc-act [data-jc-action="complete"]');
      u = await page.evaluate(() => window.__upd);
      const c = u[u.length - 1];
      expect(c.p['costAudit.complete']).toBe(true);
      expect(c.p['costAudit.completeBy']).toBe('u1');
      expect(c.p['costAudit.completeAt']).toBe('__ts__');
      await expect(page.locator('[data-jc-row="a"]')).toHaveCount(0);
    });

    test('a void needs a reason and stamps deletedAt', async ({ page }) => {
      await boot(page, true);
      await page.click('[data-jc-action="open"][data-jc-id="a"]');
      await page.click('[data-jc-action="void-ask"][data-jc-cid="m1"]');
      await page.click('[data-jc-action="void-go"]');
      expect(await page.evaluate(() => window.__upd.length)).toBe(0);
      await page.fill('#jcVoidNote', 'entered twice');
      await page.click('[data-jc-action="void-go"]');
      const u = await page.evaluate(() => window.__upd);
      expect(u).toHaveLength(1);
      expect(u[0].ref).toBe('expenses/m1');
      expect(u[0].p.deleted).toBe(true);
      expect(u[0].p.deletedAt).toBe('__ts__');
      expect(u[0].p.editLog.pop()).toMatchObject({ what: 'void', source: 'cost-auditor', note: 'entered twice' });
    });
  });
}
