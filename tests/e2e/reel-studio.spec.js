// @ts-check
// tests/e2e/reel-studio.spec.js — Reel Studio on the phone (2026-10-04).
//
// At 390 × 844 against the emulators (auth + firestore + storage + hosting +
// FUNCTIONS — tagged @gauntlet so CI boots the functions emulator):
//   1. seed a FINISHED job with a before + after photo (EXIF + GPS, like a
//      real phone photo);
//   2. Social Studio → Reels → + New reel → Photo slideshow → pick the job
//      (its photos are pre-picked) → Render;
//   3. the render worker finishes it. With ffmpeg-static installed (CI) it
//      is a real ffmpeg render; without it the emulator uses its stub MP4 —
//      the real-ffmpeg path is unit-tested in tests/reel-studio-2026-10-04.test.js;
//   4. the privacy check cannot run in the emulator (no AI calls, ever) →
//      "could not run — confirm" is shown;
//   5. Send to Social Studio (Facebook) → the reel is a DRAFT on the
//      calendar, in the Facebook lane, on its proposed day;
//   6. approval is refused while privacy is unconfirmed; after Confirm it
//      approves and schedules.
//
// No real API calls: claudeProxy is routed to a 503 stub; the emulator never
// calls Claude vision / Whisper (FUNCTIONS_EMULATOR gate in reel-studio.js).
const path = require('path');
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./fixtures/auth');
const { installLocalSdkShim } = require('./fixtures/local-sdk');

const EMULATOR_MODE = /localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')
  && !!process.env.FIRESTORE_EMULATOR_HOST
  && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

let _fn = null;
function fnAdmin() {
  if (_fn) return _fn;
  const fdir = path.join(__dirname, '..', '..', 'functions');
  const r = (m) => require(require.resolve(m, { paths: [fdir] }));
  const appMod = r('firebase-admin/app');
  if (!appMod.getApps().length) appMod.initializeApp({ projectId: 'nobigdeal-pro' });
  _fn = {
    auth: r('firebase-admin/auth').getAuth(),
    db: r('firebase-admin/firestore').getFirestore(),
    Timestamp: r('firebase-admin/firestore').Timestamp,
    storage: r('firebase-admin/storage').getStorage(),
    sharp: r('sharp'),
  };
  return _fn;
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.describe('Reel Studio — job photos → slideshow reel → draft on the calendar @gauntlet', () => {
  test.skip(!EMULATOR_MODE, 'emulator-only (seeds Storage + Firestore with the admin SDK)');
  test.setTimeout(240_000);

  test('slideshow reel from a finished job lands as a calendar draft; approval waits for the privacy confirm', async ({ page, context }) => {
    await installLocalSdkShim(context);
    await context.route(/\/claudeProxy(\?|$)/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"stubbed in E2E"}' }));
    const A = fnAdmin();
    const email = process.env.PLAYWRIGHT_TEST_USER_EMAIL || 'playwright-e2e@nbd.test';
    const uid = (await A.auth.getUserByEmail(email)).uid;
    const leadId = 'zzreel' + Date.now();

    const jpeg = (r, g, b) => A.sharp({ create: { width: 480, height: 360, channels: 3, background: { r, g, b } } })
      .jpeg().withExifMerge({ IFD0: { Make: 'ZZPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 59/1 55/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 37/1 36/1' } }).toBuffer();
    const before = await jpeg(120, 120, 120);
    const after = await jpeg(40, 60, 90);
    for (const b of ['nobigdeal-pro.firebasestorage.app', 'nobigdeal-pro.appspot.com']) {
      await A.storage.bucket(b).file('photos/' + uid + '/' + leadId + '-before.jpg').save(before, { contentType: 'image/jpeg' });
      await A.storage.bucket(b).file('photos/' + uid + '/' + leadId + '-after.jpg').save(after, { contentType: 'image/jpeg' });
    }
    const now = A.Timestamp.now();
    await A.db.doc('leads/' + leadId).set({
      userId: uid, companyId: uid, firstName: 'Zelda', lastName: 'Quackenbush', name: 'Zelda Quackenbush',
      address: '4417 Zzyzx Pines Dr, Florence, KY 41042', stage: 'install_complete', stageRole: 'won',
      acceptedTier: 'better', jobType: 'cash', createdAt: now, updatedAt: now, installCompletedAt: now,
    });
    await A.db.doc('photos/' + leadId + '-b').set({ leadId, userId: uid, companyId: uid, storagePath: 'photos/' + uid + '/' + leadId + '-before.jpg', phase: 'Before', createdAt: now });
    await A.db.doc('photos/' + leadId + '-a').set({ leadId, userId: uid, companyId: uid, storagePath: 'photos/' + uid + '/' + leadId + '-after.jpg', phase: 'After', createdAt: A.Timestamp.fromMillis(Date.now() + 1000) });

    await loginAs(page, { email, password: process.env.PLAYWRIGHT_TEST_USER_PASSWORD || 'nbd-e2e-password-1' });
    await page.goto('/pro/social.html');
    await page.locator('.ss-tab[data-tab="reels"]').click();
    const newBtn = page.locator('#srNew');
    await expect(newBtn).toBeEnabled({ timeout: 30_000 });
    expect((await newBtn.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await newBtn.click();

    // Template: Photo slideshow is the default; pick the job.
    await expect(page.locator('[data-act="rtpl"][data-tpl="slideshow"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#srPickJob').click();
    const job = page.locator('[data-act="rjob"][data-lead="' + leadId + '"]');
    await expect(job).toBeVisible({ timeout: 60_000 });
    await job.click();
    const picks = page.locator('#srDraft input[data-act="rpick"]');
    await expect(picks).toHaveCount(2, { timeout: 30_000 });
    await expect(picks.nth(0)).toBeChecked();
    await expect(picks.nth(1)).toBeChecked();
    // The picker names photos by phase + date — never the customer's street.
    expect(await page.locator('#srDraft').innerText()).not.toMatch(/Zzyzx|4417|41042/);
    await expect(page.locator('#srRender')).toBeEnabled();
    await page.locator('#srRender').click();
    await expect(page.locator('#ssToast')).toContainText(/Rendering/i, { timeout: 30_000 });

    // Server truth: one reel for this job, rendered by the worker.
    const reelQ = () => A.db.collection('companies').doc(uid).collection('reels').where('sourceLeadId', '==', leadId).get();
    await expect.poll(async () => { const s = await reelQ(); return s.size ? s.docs[0].data().status : 'none'; }, { timeout: 180_000, intervals: [1000, 2000, 3000] }).toBe('rendered');
    const reelSnap = (await reelQ()).docs[0];
    const reel = reelSnap.data();
    expect(reel.template).toBe('slideshow');
    expect(reel.output.key).toMatch(/^[a-f0-9]{32}$/);
    expect(reel.output.durationSec).toBeLessThanOrEqual(90);
    expect(reel.privacy.status).toBe('unchecked'); // the emulator never calls vision
    expect(JSON.stringify(reel)).not.toMatch(/Zelda|Quackenbush|Zzyzx|4417|41042/);
    const idx = (await A.db.doc('social_media/' + reel.output.key).get()).data();
    expect(idx.path).toMatch(/^social-media\/.+\.mp4$/);
    expect(idx.contentType).toBe('video/mp4');

    // The card: rendered, privacy "could not run", Confirm offered.
    const card = page.locator('.sr-card[data-reel="' + reelSnap.id + '"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('[data-privacy="unchecked"]')).toBeVisible();
    await expect(card.locator('video.sr-video')).toHaveCount(1);
    await expect(card.locator('[data-act="rconfirm"]')).toBeVisible();

    // Send to Social Studio (Facebook only) BEFORE confirming.
    await card.locator('[data-act="rsend"]').click();
    await page.locator('input[name="ssPlat"][value="instagram"]').uncheck();
    await page.locator('#srSendGo').click();
    await expect(page.locator('#ssToast')).toContainText(/reel draft.*calendar/i, { timeout: 30_000 });

    const postQ = await A.db.collection('companies').doc(uid).collection('social_posts').where('reelId', '==', reelSnap.id).get();
    expect(postQ.size).toBe(1);
    const post = postQ.docs[0].data();
    expect(post.status).toBe('draft');
    expect(post.format).toBe('reel');
    expect(post.platform).toBe('facebook');
    expect(post.video.key).toBe(reel.output.key);
    expect(post.kind).toBe('job_showcase');
    expect(post.caption).toMatch(/Florence/);
    expect(JSON.stringify(post)).not.toMatch(/Zelda|Quackenbush|Zzyzx|4417|41042/);

    // It is a DRAFT chip on the calendar, Facebook lane, on its proposed day.
    const target = await page.evaluate((ms) => {
      const S = window.NBDSocialLogic;
      return { key: S.ymdKey(ms), inWeek: S.weekKeys(Date.now()).includes(S.ymdKey(ms)) };
    }, post.scheduledAt.toMillis());
    await page.locator('#ssViewWeek').click();
    if (!target.inWeek) await page.locator('#ssNext').click();
    const chip = page.locator('[data-day="' + target.key + '"] .ss-lane[data-lane="facebook"] .ss-chip[data-id="' + postQ.docs[0].id + '"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveClass(/st-draft/);
    expect((await chip.boundingBox()).height).toBeGreaterThanOrEqual(44);

    // Approval is locked until the privacy check is confirmed.
    await chip.click();
    await expect(page.locator('#ssSheet')).toBeVisible();
    await expect(page.locator('#ssSheet video.ss-video')).toHaveCount(1);
    await page.locator('[data-act="approve"]').click();
    await expect(page.locator('#ssToast')).toContainText(/privacy check/i, { timeout: 30_000 });
    expect((await postQ.docs[0].ref.get()).data().status).toBe('draft');
    await page.locator('#ssSheet [data-act="close"]').click();

    await page.locator('.ss-tab[data-tab="reels"]').click();
    await card.locator('[data-act="rconfirm"]').click();
    await expect(card.locator('[data-privacy="confirmed"]')).toBeVisible({ timeout: 15_000 });
    if (process.env.NBD_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.NBD_E2E_SHOTS, 'reel-studio-reels-390.png'), fullPage: true });

    await page.locator('.ss-tab[data-tab="calendar"]').click();
    await chip.click();
    await page.locator('[data-act="approve"]').click();
    await expect(page.locator('#ssToast')).toContainText(/Approved and scheduled/i, { timeout: 30_000 });
    await expect.poll(async () => (await postQ.docs[0].ref.get()).data().status, { timeout: 15_000 }).toBe('scheduled');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if (process.env.NBD_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.NBD_E2E_SHOTS, 'reel-studio-390.png'), fullPage: true });
  });
});
