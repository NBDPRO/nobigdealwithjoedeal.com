// tests/e2e/portal-progress-steps.spec.js — the homeowner's 9-step progress
// tracker on a 390x844 phone (2026-10-03 rebuild).
//
// The portal's Cloud Functions are not run by the emulator rig, so
// getHomeownerPortalView is answered by context.route() — but the progress
// payload is built by the REAL resolver and wording constant
// (functions/homeowner-progress.js), the same objects the function returns.
// What this proves on a real phone-sized Chrome: the compact card (current
// step, done count, next step), the date fill, the pay link, the review gate,
// and the expandable list with 44px rows — by behaviour, not class names.
//
// Tagged @shard2 for the authed emulator job (it skips without that job's
// credentials, like phone-portal.spec.js, so it never runs against prod).
const { test, expect } = require('@playwright/test');
const { requireTestUser, safeEvaluate } = require('./fixtures/auth');
const HP = require('../../functions/homeowner-progress');

const PHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const TOKEN = 'ProgressStepsTok0123456789';
const PAY_LINK = 'https://buy.stripe.com/test_progress_steps';
const FN_RE = /^(?:http:\/\/127\.0\.0\.1:5001\/nobigdeal-pro\/us-central1|https:\/\/us-central1-nobigdeal-pro\.cloudfunctions\.net)\/([A-Za-z]+)/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

function skipWithoutCreds() {
  try { requireTestUser(); return false; } catch (_) { return true; }
}

// Mirrors getHomeownerPortalView's assembly: progress from the resolver,
// payLink only on an unpaid Final payment step, canRate = paidInFull.
function viewFor(lead, invoices, extra) {
  const inv = invoices || [];
  const hp = HP.resolveHomeownerProgress(lead, { invoices: inv, repName: 'Joe Deal' });
  const owed = inv.find(HP.invoiceOwes) || null;
  const balance = owed ? { amountCents: Math.round(owed.balanceDue * 100), stripePaymentLink: owed.stripePaymentLink || null } : null;
  return Object.assign({
    homeowner: { firstName: 'Pat', lastName: 'Homeowner', address: '100 Test Ln, Loveland OH', customerId: 'NBD-0042' },
    rep: { displayName: 'Joe Deal', phone: '(859) 555-0100' },
    company: { name: 'No Big Deal Home Solutions', logoUrl: null, colors: null },
    progress: {
      milestones: hp.steps, currentKey: hp.currentKey, currentIndex: hp.currentIndex, currentLabel: hp.currentLabel,
      currentBlurb: hp.currentBlurb, pending: hp.pending, doneCount: hp.doneCount, total: hp.total,
      nextLabel: hp.nextLabel, paidInFull: hp.paidInFull, paidLine: hp.paidLine, warrantyOnFile: hp.warrantyOnFile,
      payLink: (hp.currentKey === 'payment' && hp.pending && balance && balance.stripePaymentLink) || null,
      copy: HP.HOMEOWNER_PROGRESS_COPY.ui,
      scheduledDate: lead.scheduledDate || null, scheduleWindow: null, scheduledWeek: null, milestoneDates: {}, otherJobs: [],
    },
    estimate: null, bookingUrl: null, photos: [], photoPairs: [], documents: [],
    balance,
    warranty: lead.warranty || null,
    tokenInfo: { daysRemaining: 27 },
    rating: { canRate: hp.paidInFull, submitted: false, stars: null },
  }, extra || {});
}

async function openWith(page, view) {
  await page.context().route(FN_RE, async (route) => {
    const req = route.request();
    const fn = FN_RE.exec(req.url())[1];
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (body) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (fn === 'getHomeownerPortalView') return json(view);
    if (fn === 'getPortalMessages') return json({ messages: [] });
    return json({ ok: true });
  });
  await page.goto('/pro/portal.html?token=' + TOKEN);
  await page.waitForSelector('#mainWrap .progress-card', { timeout: 15_000 });
}

const card = (page) => page.locator('.progress-card');

async function noSideScroll(page) {
  const w = await safeEvaluate(page, () => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(w.sw, 'no horizontal scroll at 390').toBeLessThanOrEqual(w.cw);
}

test.describe('portal progress tracker, 9 steps on a phone @shard2 @phoneportal', () => {
  test.use(PHONE);
  test.skip(skipWithoutCreds(), 'PLAYWRIGHT_TEST_USER_* not set');

  test('unpaid final photos: Final walkthrough, no rating card, no referral card', async ({ page }) => {
    await openWith(page, viewFor({ stage: 'final_photos' }, [{ balanceDue: 4200, stripePaymentLink: PAY_LINK }]));
    await expect(card(page).locator('.card-title')).toHaveText('Final walkthrough');
    await expect(card(page).locator('.progress-count')).toHaveText('6 of 9 done');
    await expect(card(page).locator('.progress-blurb')).toHaveText('Done. Joe walks the job with you and sends your final photos.');
    await expect(card(page).locator('.progress-next')).toContainText('Final payment');
    await expect(page.locator('#cr-card'), 'no review ask before paid in full').toHaveCount(0);
    await expect(page.getByText(/Refer a friend/i), 'no referral ask before paid in full').toHaveCount(0);
    await expect(card(page).locator('.progress-action'), 'the pay button waits for the payment step').toHaveCount(0);
    await expect(card(page).locator('.progress-seg')).toHaveCount(9);
    await noSideScroll(page);
  });

  test('unpaid final payment: the existing pay link, 44px, tappable', async ({ page }) => {
    await openWith(page, viewFor({ stage: 'final_payment' }, [{ balanceDue: 4200, stripePaymentLink: PAY_LINK }]));
    await expect(card(page).locator('.card-title')).toHaveText('Final payment');
    await expect(card(page).locator('.progress-blurb')).toHaveText('Your final invoice is ready.');
    const pay = card(page).locator('a.progress-action', { hasText: 'Pay your invoice' });
    await expect(pay).toHaveAttribute('href', PAY_LINK);
    const box = await pay.boundingBox();
    expect(box.height, 'pay button is a 44px target').toBeGreaterThanOrEqual(44);
    const hit = await safeEvaluate(page, () => {
      const el = document.querySelector('.progress-card a.progress-action');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!h && (h === el || el.contains(h));
    });
    expect(hit, 'nothing sits on top of the pay button').toBe(true);
    await expect(page.locator('#cr-card')).toHaveCount(0);
    await noSideScroll(page);
  });

  test('build day: the date fills in, in the reader\'s own day', async ({ page }) => {
    await openWith(page, viewFor({ stage: 'crew_scheduled', scheduledDate: '2026-10-12' }));
    await expect(card(page).locator('.card-title')).toHaveText('Build day set');
    await expect(card(page).locator('.progress-blurb')).toHaveText('Your build day: Monday, October 12.');
    await expect(card(page).locator('.progress-count')).toHaveText('4 of 9 done');
  });

  test('build day with no date: the promise, not a blank', async ({ page }) => {
    await openWith(page, viewFor({ stage: 'crew_scheduled' }));
    await expect(card(page).locator('.progress-blurb')).toHaveText('We\'ll confirm your build day soon.');
  });

  test('paid in full: Review, rating card, and the full list opens with 44px rows', async ({ page }) => {
    await openWith(page, viewFor({ stage: 'closed', warranty: { tier: 'preferred', tierLabel: 'NBD Preferred Warranty', installDate: '2026-09-20', certNumber: 'NBD-W-0042' } }, [{ balanceDue: 0, status: 'paid' }]));
    await expect(card(page).locator('.card-title')).toHaveText('Review');
    await expect(card(page).locator('.progress-blurb')).toHaveText('How did we do?');
    await expect(card(page).locator('.progress-paid')).toHaveText('Paid in full — thank you.');
    await expect(page.locator('#cr-card'), 'the rating card opens once paid').toHaveCount(1);
    const rate = card(page).locator('a.progress-action', { hasText: 'Leave a rating' });
    await expect(rate).toHaveAttribute('href', '#cr-card');
    await rate.tap();
    await expect.poll(() => safeEvaluate(page, () => {
      const r = document.getElementById('cr-card').getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0;
    }), { message: 'tapping it brings the rating card on screen' }).toBe(true);

    const summary = card(page).locator('details.progress-all > summary');
    await summary.scrollIntoViewIfNeeded();
    expect((await summary.boundingBox()).height, 'summary is a 44px target').toBeGreaterThanOrEqual(44);
    await expect(summary).toHaveText('See all 9 steps');
    await summary.tap();
    const rows = card(page).locator('.progress-item');
    await expect(rows).toHaveCount(9);
    const heights = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    heights.forEach((h, i) => expect(h, 'row ' + (i + 1) + ' is 44px+').toBeGreaterThanOrEqual(44));
    const states = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
    expect(states).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'current']);
    await expect(rows.nth(8)).toHaveAttribute('aria-current', 'step');
    await noSideScroll(page);
    if (process.env.PJ_SHOTS) await card(page).screenshot({ path: process.env.PJ_SHOTS + '/portal-progress-paid.png' });
  });

  test('a new lead: Inspection is upcoming and says so', async ({ page }) => {
    await openWith(page, viewFor({ stage: 'new' }));
    await expect(card(page).locator('.card-title')).toHaveText('Inspection');
    await expect(card(page).locator('.progress-blurb')).toHaveText('Joe will come out and look at your roof.');
    await expect(card(page).locator('.progress-count')).toHaveText('0 of 9 done');
    if (process.env.PJ_SHOTS) await card(page).screenshot({ path: process.env.PJ_SHOTS + '/portal-progress-new.png' });
  });
});
