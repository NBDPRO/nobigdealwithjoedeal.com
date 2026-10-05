// @ts-check
// tests/e2e/social-studio.spec.js — Social Studio on the phone (2026-10-04).
//
// At 390 × 844 against the emulators (auth + firestore + storage + hosting +
// FUNCTIONS — tagged @gauntlet so CI boots the functions emulator):
//   1. seed a FINISHED job (install_complete) with a before + after photo —
//      the photos carry EXIF with GPS, like a real phone photo;
//   2. Social Studio → "+ Draft from a job" → pick the job → Generate;
//   3. the drafts land in Approve with the town only — never the customer's
//      name or street — and their media are re-encoded copies with no EXIF;
//   4. open a draft, set a time, Approve & schedule;
//   5. the calendar shows it on that day, in its platform lane.
//
// No real API calls: the AI caption attempt goes to the emulator's
// claudeProxy (dummy key → fails) and the page falls back to the template.
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

test.describe('Social Studio — draft from a finished job, approve, schedule @gauntlet', () => {
  test.skip(!EMULATOR_MODE, 'emulator-only (seeds Storage + Firestore with the admin SDK)');
  test.setTimeout(180_000);

  test('job → draft (town only, EXIF-free media) → approve & schedule → on the calendar', async ({ page, context }) => {
    await installLocalSdkShim(context);
    // No real API calls: the AI caption request never leaves the browser —
    // the proxy "is down", so the page must keep the template caption.
    await context.route(/\/claudeProxy(\?|$)/, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"stubbed in E2E"}' }));
    const A = fnAdmin();
    const email = process.env.PLAYWRIGHT_TEST_USER_EMAIL || 'playwright-e2e@nbd.test';
    const uid = (await A.auth.getUserByEmail(email)).uid;
    const stamp = Date.now();
    const leadId = 'zzsocial' + stamp;

    // Two phone-like JPEGs with EXIF + GPS.
    const jpeg = (r, g, b) => A.sharp({ create: { width: 320, height: 240, channels: 3, background: { r, g, b } } })
      .jpeg().withExifMerge({ IFD0: { Make: 'ZZPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 59/1 55/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 37/1 36/1' } }).toBuffer();
    const before = await jpeg(120, 120, 120);
    const after = await jpeg(40, 60, 90);
    // Seed into every bucket name the functions emulator might default to.
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
    const newBtn = page.locator('#ssNewFromJob');
    await expect(newBtn).toBeEnabled({ timeout: 30_000 });
    const box = await newBtn.boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(44);

    await newBtn.click();
    const job = page.locator('.ss-job[data-lead="' + leadId + '"]');
    await expect(job).toBeVisible({ timeout: 60_000 });
    await job.click();
    await expect(job).toHaveAttribute('aria-pressed', 'true');
    // Facebook only keeps the assertion simple; Instagram is on by default too.
    await page.locator('input[name="ssPlat"][value="instagram"]').uncheck();
    await page.locator('#ssGenerate').click();
    await expect(page.locator('#ssToast')).toContainText(/draft.*ready.*template caption/i, { timeout: 90_000 });

    // The draft (Approve tab) — town only.
    const card = page.locator('#ssDrafts .ss-card').first();
    await expect(card).toBeVisible();
    const text = await card.innerText();
    expect(text).toMatch(/Florence/);
    expect(text).not.toMatch(/Zelda|Quackenbush|Zzyzx|4417|41042/);

    // Server truth: the stored post + its media.
    const snap = await A.db.collection('companies').doc(uid).collection('social_posts').where('sourceLeadId', '==', leadId).get();
    expect(snap.size).toBe(1);
    const post = snap.docs[0].data();
    expect(post.status).toBe('draft');
    expect(post.format).toBe('before_after');
    expect(post.media.length).toBe(2);
    expect(JSON.stringify(post)).not.toMatch(/Zelda|Quackenbush|Zzyzx|4417|41042|38\.99|token=/);
    for (const m of post.media) {
      const idx = (await A.db.doc('social_media/' + m.key).get()).data();
      expect(idx.path).toMatch(/^social-media\//);
      let bytes = null;
      for (const b of ['nobigdeal-pro.firebasestorage.app', 'nobigdeal-pro.appspot.com']) {
        try { [bytes] = await A.storage.bucket(b).file(idx.path).download(); break; } catch (_) { /* other bucket */ }
      }
      expect(bytes, 're-encoded copy stored').toBeTruthy();
      const meta = await A.sharp(bytes).metadata();
      expect(meta.exif, 'no EXIF (GPS) on the social copy').toBeFalsy();
      expect(bytes.includes(Buffer.from('ZZPhone'))).toBe(false);
    }

    // Approve & schedule for 10:00 ET one week out.
    await card.locator('[data-act="edit"]').click();
    await expect(page.locator('#ssSheet')).toBeVisible();
    const target = await page.evaluate(() => {
      const S = window.NBDSocialLogic;
      const t = Date.now() + 7 * 86400000;
      const key = S.ymdKey(t);
      const [y, m, d] = key.split('-').map(Number);
      return { key, local: key + 'T10:00', ms: S.zonedMs(y, m, d, 10, 0) };
    });
    await page.locator('#ssEdWhen').fill(target.local);
    await page.locator('[data-act="approve"]').click();
    await expect(page.locator('#ssToast')).toContainText(/Approved and scheduled/i, { timeout: 30_000 });
    await expect.poll(async () => (await snap.docs[0].ref.get()).data().status, { timeout: 15_000 }).toBe('scheduled');
    const after2 = (await snap.docs[0].ref.get()).data();
    expect(after2.scheduledAt.toMillis()).toBe(target.ms);
    expect(after2.approvedBy).toBe(uid);

    // On the calendar: that day, Facebook lane.
    await page.locator('.ss-tab[data-tab="calendar"]').click();
    await page.locator('#ssViewWeek').click();
    await page.locator('#ssNext').click();
    const chip = page.locator('[data-day="' + target.key + '"] .ss-lane[data-lane="facebook"] .ss-chip[data-id="' + snap.docs[0].id + '"]');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveClass(/st-scheduled/);
    const cb = await chip.boundingBox();
    expect(cb && cb.height).toBeGreaterThanOrEqual(44);

    // No horizontal scroll at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if (process.env.NBD_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.NBD_E2E_SHOTS, 'social-studio-390.png'), fullPage: true });
  });
});
