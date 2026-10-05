// tests/e2e/phone-brief-me.spec.js — "Brief me" + "Ask for review" on the
// customer page, on a phone (390x844), 2026-10-04.
//
// Brief me is the pre-visit tool: Jo opens the customer standing in the
// driveway, taps once, reads a summary. So on a phone the button must be in
// the primary row (NOT behind "More"), a real finger tap must land on it, the
// summary must render readable without widening the page, Refresh must ask
// the server to regenerate, and Close must put it away.
//
// The leadBrief callable (Claude Haiku 4.5, server-side) is answered by
// page.route — no model is ever called. Ask for review goes through the
// platform sender (sendEmail, also routed) and must stamp reviewRequested on
// the lead only because the platform answered "sent".
//
// Run (emulator): see tests/package.json test:e2e:authed:emu.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const W = 390;
const H = 844;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers().origin || '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

test.describe('@shard2 Brief me on a phone (390x844)', () => {
  test.describe.configure({ mode: 'serial' });

  test('one tap → readable summary; Refresh regenerates; review ask stamps only on a real send', async ({ browser }, testInfo) => {
    let creds;
    try { creds = requireTestUser(); } catch (e) { test.skip(true, e.message); return; }
    const ctx = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      bypassCSP: !!testInfo.project.use.bypassCSP,
      viewport: { width: W, height: H }, isMobile: true, hasTouch: true, serviceWorkers: 'block', userAgent: UA,
    });
    const page = await ctx.newPage();
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));

    const briefCalls = [];
    await page.route(/\/leadBrief(\?|$)/, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(req) });
      const body = JSON.parse(req.postData() || '{}');
      briefCalls.push(body.data || {});
      const n = briefCalls.length;
      return route.fulfill({ status: 200, headers: cors(req), contentType: 'application/json', body: JSON.stringify({ result: {
        oneLine: n === 1 ? 'You promised shingle samples Thursday; she owes $250.' : 'Refreshed: samples still owed; inspection Tue 9:00 AM.',
        bullets: ['You promised: bring shingle samples (due Oct 6)', 'Last talked Oct 3: wants the charcoal color', 'Owes $250', '37 photos on file', 'Next: Inspection Tue, Oct 7, 9:00 AM'],
        source: 'ai', generatedAtMs: Date.now(), cached: false,
      } }) });
    });
    const emailCalls = [];
    await page.route(/\/sendEmail(\?|$)/, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(req) });
      emailCalls.push(JSON.parse(req.postData() || '{}'));
      return route.fulfill({ status: 200, headers: cors(req), contentType: 'application/json', body: JSON.stringify({ success: true, id: 'resend-e2e' }) });
    });

    await loginAs(page, creds);
    await page.goto('/pro/dashboard.html');
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && window._user && window._user.uid, { timeout: 25_000 });
    const leadId = await safeEvaluate(page, async () => {
      const stamp = Date.now();
      try {
        await window._saveLead({ firstName: '[E2E] Brief', lastName: String(stamp), address: String(stamp).slice(-4) + ' Main St, Milford, OH 45150',
          phone: '513' + String(stamp).slice(-7), email: 'e2e-brief-' + stamp + '@nbd.test', stage: 'closed', e2eTestData: true });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const uid = (window._auth || window.auth).currentUser.uid;
      let id = null;
      for (let i = 0; i < 20 && !id; i++) {
        if (i) await new Promise((r) => setTimeout(r, 500));
        const snap = await fs.getDocs(fs.query(fs.collection(db, 'leads'), fs.where('userId', '==', uid), fs.where('lastName', '==', String(stamp)), fs.where('e2eTestData', '==', true)));
        snap.forEach((d) => { id = id || d.id; });
      }
      if (!id) throw new Error('seeded lead not found');
      return id;
    });

    await page.goto('/pro/customer.html?id=' + leadId);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1' && typeof window.NBDLeadAI === 'object' && !!document.getElementById('briefMeBtn'), { timeout: 25_000 });
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));

    // Primary on a phone: visible without opening More, and a finger lands on it.
    const btn = page.locator('#briefMeBtn');
    await expect(btn, 'Brief me sits in the phone primary row, not behind More').toBeVisible();
    await btn.scrollIntoViewIfNeeded();
    const hit = await page.evaluate(() => {
      const el = document.getElementById('briefMeBtn');
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { ok: !!h && (h === el || el.contains(h)), h: r.height, right: r.right };
    });
    expect(hit.ok, 'a finger on Brief me lands on it').toBe(true);
    expect(hit.h, 'thumb-size target').toBeGreaterThanOrEqual(40);
    expect(hit.right, 'ends on the screen').toBeLessThanOrEqual(W);

    await btn.tap();
    const panel = page.locator('#leadBriefPanel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('You promised shingle samples Thursday');
    await expect(panel.locator('li')).toHaveCount(5);
    expect(briefCalls[0], 'asked the server for THIS lead').toMatchObject({ leadId, refresh: false });
    const geo = await page.evaluate(() => {
      const p = document.getElementById('leadBriefPanel').getBoundingClientRect();
      return { left: p.left, right: p.right, scroll: document.documentElement.scrollWidth, inner: window.innerWidth };
    });
    expect(geo.right, 'the summary fits the screen').toBeLessThanOrEqual(W);
    expect(geo.left).toBeGreaterThanOrEqual(0);
    expect(geo.scroll, 'and the page never scrolls sideways').toBeLessThanOrEqual(W);
    expect(geo.inner, 'nor widens the layout viewport').toBe(W);
    await testInfo.attach('brief-me-390x844', { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });

    await panel.getByRole('button', { name: 'Refresh' }).tap();
    await expect(panel).toContainText('Refreshed: samples still owed');
    expect(briefCalls.length).toBe(2);
    expect(briefCalls[1].refresh, 'Refresh asks the server to regenerate').toBe(true);

    await panel.getByRole('button', { name: 'Close the brief' }).tap();
    await expect(panel).toBeHidden();

    // Ask for review — behind More on a phone; one tap; stamps on a real send.
    const more = page.locator('#qaMoreBtn');
    if (await more.isVisible().catch(() => false) && !(await page.locator('#askReviewBtn').isVisible())) await more.tap();
    await expect(page.locator('#askReviewBtn')).toBeVisible();
    await page.locator('#askReviewBtn').tap();
    await expect.poll(() => emailCalls.length, { message: 'one review email through the platform sender' }).toBe(1);
    expect(emailCalls[0]).toMatchObject({ leadId, kind: 'review_request' });
    await expect.poll(async () => safeEvaluate(page, async (id) => {
      const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const snap = await fs.getDoc(fs.doc(window.db || window._db, 'leads', id));
      const d = snap.data() || {};
      return !!(d.reviewRequested && d.reviewRequestedAt);
    }, leadId), { message: 'reviewRequested + reviewRequestedAt stamped after the platform sent it', timeout: 10_000 }).toBe(true);

    await ctx.close();
  });
});
