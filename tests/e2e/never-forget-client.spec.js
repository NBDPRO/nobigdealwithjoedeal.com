/**
 * tests/e2e/never-forget-client.spec.js - the client-side never-forget findings
 * (documentation/qa/never-forget-2026-10-13/FINDINGS.md) in a real browser, on
 * the installed-iPhone shape: 390 x 844, standalone rules forced, real taps.
 *
 *   1. H4: a promise saved from a call's sheet is on Today at once - no
 *      leads refresh. (callCenterAction is answered in the browser, with the
 *      writes the server makes; its own logic is covered by
 *      tests/promise-capture-2026-10-12.test.js.)
 *   2. Waiting on them counts PEOPLE, and an item ripens on its "Nudge me on"
 *      date (a dated-later item stays out; two items for one customer are one
 *      row).
 *   3. A failed texts read is never an all-clear: Today and the Call Center
 *      say so.
 *
 * Nothing here sends anything to anyone and nothing calls a Cloud Function.
 *
 * @shard2 - runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction, ensureClassicLayout } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _app = null;
function admin() {
  if (_app) return _app;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _app = { db: getFirestore(), auth: getAuth() };
  return _app;
}
async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
    }
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    return css.length;
  });
}
const localYmd = (offsetDays) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

async function who() {
  const { auth } = admin();
  const user = await auth.getUserByEmail(creds.email);
  return { uid: user.uid, co: ((user.customClaims || {}).companyId) || user.uid };
}
async function boot(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
    } catch (e) { /* storage blocked */ }
  });
  await page.route(/cloudfunctions\.net|\.run\.app|api\.weather\.gov/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"result":{}}' }));
  await loginAs(page, creds);
  await ensureClassicLayout(page); // the shard shares one rep; a Crew pick from crew-calendar.spec put #nbdCrewRoot over Today (2026-10-25)
  expect(await forceStandalone(page)).toBeGreaterThan(200);
  await expect(page.locator('#view-home #todayPlan')).toBeVisible({ timeout: 30_000 });
}

test.describe('never-forget client findings @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('H4: a promise saved from a call sheet is on Today with no refresh', async ({ page }) => {
    test.setTimeout(150_000);
    const { db } = admin();
    const { uid, co } = await who();
    const s = Date.now();
    const base = { userId: uid, companyId: co, e2eTestData: true, createdAt: new Date(), deleted: false };
    const leadId = (await db.collection('leads').add(Object.assign({}, base, { firstName: 'ZZNFProm', lastName: 'Cust' + s, stage: 'contacted', phone: '5135550451', phoneDigits: '5135550451' }))).id;
    const callId = 'cube_e2enf' + s;
    await db.doc('phone_calls/' + callId).set({ userId: uid, companyId: co, leadId, phoneDigits: '5135550451', bucket: 'customer', direction: 'inbound', status: 'noted', urgent: true, startedAtMs: Date.now() - 600000, summary: 'ZZNF wants a quote' + s, promises: [] });
    const actions = [];
    await page.route(/callCenterAction/, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' } });
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}').data || {}; } catch (_) { /* none */ }
      actions.push(body);
      // Anything but a promise with a kind (a plain 'handled', say) is answered, not crashed on; the assertion below names it (2026-10-25).
      if (body.action !== 'promise' || !body.kind) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ result: { ok: true, on: 'none', sample: 'spec: not a promise' } }) });
      // What the server writes: the promise task + the call handled.
      const taskId = 'promise-' + body.id;
      await db.doc('leads/' + leadId + '/tasks/' + taskId).set({ kind: 'promise', promiseKind: body.kind, text: 'Call back', title: 'Call back', done: false, dueDate: body.dueYmd, madeYmd: body.dueYmd, missCount: 0, rescheduleCount: 0, leadId, userId: uid, companyId: co, createdAt: new Date() });
      await db.doc('phone_calls/' + body.id).set({ handledAtMs: Date.now(), promiseTaskId: taskId }, { merge: true });
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ result: { ok: true, on: 'task', taskId, dueDate: body.dueYmd } }) });
    });
    await boot(page);
    const plan = page.locator('#view-home #todayPlan');
    const row = plan.locator('[data-tp-sec="promised"] [data-tp-row], [data-tp-sec="promises"] [data-tp-row], [data-tp-sec="calls"] [data-tp-row]', { hasText: 'ZZNFProm Cust' + s });
    await expect(row.first(), 'the call is on Today first').toBeVisible({ timeout: 30_000 });
    // Handled is one tap with an Undo since #2668 (UX walk H3); the sheet opens from "I promised something".
    await row.first().locator('[data-tp-act="promised"]').tap();
    const sheet = page.locator('#prSheet');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheet.locator('[data-pr-act="kind"][data-pr-val="callback"]').tap();
    await sheet.locator('[data-pr-act="save"]').tap();
    await expect(sheet).toBeHidden({ timeout: 15_000 });
    expect(actions.some((a) => a.action === 'promise' && a.kind === 'callback'), 'the sheet sent a callback promise; got ' + JSON.stringify(actions)).toBe(true);
    // The promise is a row in the Promises section NOW (same page, no reload, no leads refresh).
    const prom = plan.locator('[data-tp-sec="promises"] [data-tp-row]', { hasText: 'ZZNFProm Cust' + s });
    await expect(prom, 'the saved promise is on Today at once').toHaveCount(1, { timeout: 8_000 });
    await expect(prom.locator('[data-tp-act="pkept"]')).toBeVisible();
  });

  test('Waiting counts people and honors the Nudge-me-on date', async ({ page }) => {
    test.setTimeout(150_000);
    const { db } = admin();
    const { uid, co } = await who();
    const s = Date.now();
    const base = { userId: uid, companyId: co, e2eTestData: true, createdAt: new Date(), deleted: false };
    const mkLead = async (n, phone) => (await db.collection('leads').add(Object.assign({}, base, { firstName: 'ZZNFWait', lastName: n + s, stage: 'contacted', phone, phoneDigits: phone }))).id;
    const wt = (leadId, o) => Object.assign({ kind: 'promise', promiseKind: 'waiting', text: 'Waiting on the adjuster', title: 'Waiting on the adjuster', done: false, waitingOn: 'adjuster', nudgeCount: 0, missCount: 0, rescheduleCount: 0, leadId, userId: uid, companyId: co, createdAt: new Date() }, o);
    const two = await mkLead('Two', '5135550461');
    const later = await mkLead('Later', '5135550462');
    await db.doc('leads/' + two + '/tasks/w1' + s).set(wt(two, { waitingSince: localYmd(-6), dueDate: localYmd(-1), waitingOn: 'adjuster' }));
    await db.doc('leads/' + two + '/tasks/w2' + s).set(wt(two, { waitingSince: localYmd(-5), dueDate: localYmd(-1), waitingOn: 'supplier', text: 'Waiting on the supplier', title: 'Waiting on the supplier' }));
    // 5 days waited (the old clock would ripen it) but Jo said nudge me in 5 days.
    await db.doc('leads/' + later + '/tasks/w3' + s).set(wt(later, { waitingSince: localYmd(-5), dueDate: localYmd(5) }));
    await boot(page);
    const plan = page.locator('#view-home #todayPlan');
    const sec = plan.locator('[data-tp-sec="waiting"]');
    await expect(sec, 'the Waiting group shows').toBeVisible({ timeout: 30_000 });
    await expect(sec.locator('.tp-sec-title .tp-count')).toHaveText('1');
    await expect(sec.locator('[data-tp-row]', { hasText: 'ZZNFWait Two' + s })).toHaveCount(1);
    await expect(sec.locator('[data-tp-row]', { hasText: 'ZZNFWait Two' + s }).locator('[data-tp-act="pnudge"]')).toHaveCount(2);
    await expect(sec.locator('[data-tp-row]', { hasText: 'ZZNFWait Later' + s }), 'a date a week out is not ripe').toHaveCount(0);
    // thumb-sized
    const nudge = sec.locator('[data-tp-act="pnudge"]').first();
    await expect.poll(() => nudge.evaluate((el) => Math.round(el.getBoundingClientRect().height)).catch(() => 0)).toBeGreaterThanOrEqual(44);
    // no horizontal overflow at 390
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('a failed texts read is not an all-clear (Today + Call Center)', async ({ page }) => {
    test.setTimeout(150_000);
    await boot(page);
    // Make the texts read fail the way a missing index / rules denial would.
    await safeEvaluate(page, () => {
      const orig = window.getDocs;
      window.__origGetDocs = orig;
      window.getDocs = async function (q) {
        let name = '';
        try { name = q && q._query && q._query.path && q._query.path.canonicalString ? q._query.path.canonicalString() : ''; } catch (e) { name = ''; }
        if (name === 'phone_text_days') throw Object.assign(new Error('failed-precondition'), { code: 'failed-precondition' });
        return orig.apply(this, arguments);
      };
    });
    await safeEvaluate(page, () => window.NBDHomeAttention.render(true));
    const plan = page.locator('#view-home #todayPlan');
    await expect(plan.locator('.tp-readfail'), 'Today says the read failed').toContainText(/NOT an all-clear/, { timeout: 15_000 });
    await expect(plan).not.toContainText('Go knock some doors');
    await safeEvaluate(page, () => window.goTo('calls'));
    await expect(page.locator('#view-calls .cc-readfail'), 'it names the texts read (the mocked said-you-would-do callable also fails here)').toContainText(/your texts.*NOT an all-clear/s, { timeout: 30_000 });
    await expect(page.locator('#view-calls .cc-list')).not.toContainText('Nothing needs you');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
});
