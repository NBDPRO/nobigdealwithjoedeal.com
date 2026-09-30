// tests/e2e/portal-other-jobs.spec.js — the homeowner portal's "Also
// scheduled" line for a customer's OTHER jobs (multi-job, 2026-09-30).
//
// getHomeownerPortalView is answered by context.route() with the shape
// functions/portal.js returns (progress.otherJobs from otherJobsFor). On a
// phone: the lines render under the main date, a past day says nothing, a
// title with markup is shown as text, and nothing widens the page.
//
// Tagged @shard2 for the authed emulator job (it only needs the hosting
// emulator, like phone-portal.spec.js).
const { test, expect } = require('@playwright/test');
const { requireTestUser } = require('./fixtures/auth');

const PHONE = { isMobile: true, hasTouch: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } };
const FN_RE = /^(?:http:\/\/127\.0\.0\.1:5001\/nobigdeal-pro\/us-central1|https:\/\/us-central1-nobigdeal-pro\.cloudfunctions\.net)\/([A-Za-z]+)/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const ymd = (d) => { const p = (v) => String(v).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const mondayIn = (weeks) => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * weeks); return ymd(d); };

function view() {
  const M = [
    { key: 'inspected', label: 'Inspection', blurb: 'We have looked at your property.' },
    { key: 'contract_signed', label: 'Contract', blurb: 'Signed and ready to schedule.' },
    { key: 'install', label: 'Installation', blurb: 'The crew is on the job.' },
    { key: 'complete', label: 'Complete', blurb: 'Project finished.' },
  ];
  return {
    homeowner: { firstName: 'Pat', lastName: 'ZZ_QA', address: '100 Test Ln, Loveland OH', customerId: 'NBD-0042' },
    rep: { displayName: 'Joe Deal', phone: '(859) 555-0100' },
    company: { name: 'No Big Deal Home Solutions', logoUrl: null, colors: null },
    progress: {
      milestones: M, currentKey: 'contract_signed', currentIndex: 1, currentLabel: 'Contract', nextLabel: 'Installation', nextBlurb: 'The crew is on the job.',
      scheduledDate: inDays(3), scheduleWindow: { scheduledStart: '07:00', scheduledDurationMin: null, scheduledEndDate: inDays(4) }, milestoneDates: {},
      otherJobs: [
        { title: 'Gutter guards', scheduledDate: inDays(10), scheduledWeek: null, scheduleWindow: { scheduledStart: '09:00', scheduledDurationMin: 120, scheduledEndDate: null } },
        { title: 'Skylight <b>reflash</b>', scheduledDate: null, scheduledWeek: mondayIn(3), scheduleWindow: null },
        { title: 'Old repair', scheduledDate: inDays(-5), scheduledWeek: null, scheduleWindow: null },
      ],
    },
    estimate: null, photos: [], photoPairs: [], documents: [], balance: null, warranty: null,
    tokenInfo: { daysRemaining: 27 }, rating: { canRate: false, submitted: false, stars: null },
  };
}

test.describe('Portal: a customer\'s other jobs @shard2', () => {
  test.skip(() => { try { requireTestUser(); return false; } catch (_) { return true; } }, 'emulator job only');
  test.use(PHONE);

  test('"Also scheduled" lines under the main date; past says nothing; text is escaped; fits a phone', async ({ page, context }) => {
    await context.route(FN_RE, async (route) => {
      const req = route.request();
      const fn = FN_RE.exec(req.url())[1];
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const json = (b) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(b) });
      if (fn === 'getHomeownerPortalView') return json(view());
      if (fn === 'getPortalMessages') return json({ messages: [] });
      return json({ ok: true });
    });
    await page.goto('/pro/portal.html?token=OtherJobsTok0123456789ab');
    await page.waitForSelector('#mainWrap .progress-card', { timeout: 15_000 });
    const lines = page.locator('.progress-card [data-other-job]');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText(/Also scheduled — Gutter guards: Crew arrives \w+, \w+ \d+/);
    await expect(lines.nth(0), 'its arrival time rides along').toContainText(/9:00/);
    await expect(lines.nth(1)).toContainText(/Also scheduled — Skylight <b>reflash<\/b>: Scheduled for the week of/);
    expect(await lines.nth(1).locator('b').count(), 'a title is text, never markup').toBe(0);
    await expect(page.locator('.progress-card'), 'a past day claims nothing').not.toContainText('Old repair');
    // Order: main date first, then the others, then "Next up".
    const order = await page.evaluate(() => [...document.querySelectorAll('.progress-card .progress-schedule, .progress-card .progress-next')].map((e) => (e.hasAttribute('data-other-job') ? 'other' : e.className)));
    expect(order, JSON.stringify(order)).toEqual(['progress-schedule', 'other', 'other', 'progress-next']);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide, 'nothing widens the page').toBeLessThanOrEqual(0);
    if (process.env.PJ_SHOTS) await page.locator('.progress-card').screenshot({ path: process.env.PJ_SHOTS + '/portal-other-jobs.png' });
  });
});
