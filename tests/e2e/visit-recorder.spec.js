// tests/e2e/visit-recorder.spec.js - the in-person visit recorder, end to end
// on the emulator, at 390 x 844 as the installed iPhone app.
//
//   documentation/projects/VISIT-RECORDER-PR1-2026-10-13.md
//
// Real Chromium MediaRecorder (fake microphone device), real IndexedDB, real
// Storage + Firestore emulators and the REAL firestore.rules / storage.rules.
// "The network stubbed" means: no Groq, Anthropic, Twilio or e-mail is
// reachable from this PR at all (no server step), and the offline leg is
// context.setOffline(true), not a mock.
//
//   1. Home: the Record bar is thumb-sized and above the bottom nav.
//   2. Record with NO signal -> Stop -> "Saved on phone - waiting for signal"
//      -> chips show their evidence -> Save unattached -> Unfiled (1).
//   3. Signal returns -> uploads by itself -> doc is "uploaded" under
//      audio/{uid}/_inbox/ and carries nothing the server owns.
//   4. Unfiled -> Attach -> Search customer -> attached (and only now).
//   5. Customer page: Record visit is pre-attached; the do-not-record toggle
//      makes the recorder refuse, including through the deep link.
//   6. The deep link ?capture=1 starts a recording and strips its own params.
//   7. Today's appointment row has "Record visit", pre-attached.
//
// Nothing here sends anything to anyone.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const Logic = require('../../docs/pro/js/visit-recorder-logic.js');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  permissions: ['microphone', 'geolocation'],
  geolocation: { latitude: 39.1031, longitude: -84.512 },
  launchOptions: Object.assign(
    { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}
  ),
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }
// File-level (launchOptions forces a new worker, so it cannot sit in a describe).
test.use(IPHONE);

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
async function seed(stamp) {
  const { db, auth } = admin();
  const user = await auth.getUserByEmail(creds.email);
  const uid = user.uid;
  const co = ((user.customClaims || {}).companyId) || uid;
  const old = await db.collection('users/' + uid + '/visit_captures').get();
  await Promise.all(old.docs.map((d) => d.ref.delete()));
  const lead = (await db.collection('leads').add({
    userId: uid, companyId: co, e2eTestData: true, deleted: false, createdAt: new Date(),
    firstName: 'ZZVisit', lastName: 'Reyes' + stamp, stage: 'inspected', jobType: 'cash', jobValue: 12000,
    phone: '5135550199', address: stamp + ' Oak Hill Dr, Mason, OH',
  })).id;
  const start = new Date(Date.now() + 15 * 60000);
  const appt = (await db.collection('appointments').add({
    repUid: uid, userId: uid, companyId: co, leadId: lead, title: 'Roof inspection', attendeeName: 'ZZVisit Reyes' + stamp,
    startTime: start, endTime: new Date(start.getTime() + 3600000), status: 'confirmed', location: stamp + ' Oak Hill Dr, Mason, OH', e2eTestData: true,
  })).id;
  return { db, uid, co, lead, appt, name: 'ZZVisit Reyes' + stamp };
}
const initStorage = () => {
  try {
    localStorage.setItem('nbd-onboarding-complete', '1');
    localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
  } catch (e) { /* storage blocked */ }
};
const recorderRows = (page) => safeEvaluate(page, () => window.NBDVisitRecorder.list());
async function waitForRecorder(page) {
  await safeWaitForFunction(page, () => !!(window.NBDVisitRecorder && window.NBDVisitRecorderUI), null, { timeout: 45_000 });
}
const visitDocs = async (db, uid) => (await db.collection('users/' + uid + '/visit_captures').get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));

// The Home bar has TWO buttons with the .nbd-vr-unfiled class: the 'Unfiled visits (n)' badge and the
// 'Recent visits' button (visit-recorder-launcher.js reuses the class). Address the badge, not both.
const UNFILED = '.nbd-vr-unfiled:not(.nbd-vr-recent)';

test.describe('visit recorder: record first, save on the phone, upload later, attach by a tap @shard3', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.describe.configure({ mode: 'serial' });
  const stamp = Date.now();
  let S = null;

  test.describe('390 installed app', () => {
    test('Home bar -> record offline -> saved on phone -> uploads on reconnect -> attach by search', async ({ page, context }) => {
      test.setTimeout(240_000);
      S = await seed(stamp);
      await page.addInitScript(initStorage);
      await loginAs(page, creds);
      expect(await forceStandalone(page)).toBeGreaterThan(200);
      await safeEvaluate(page, () => window.goTo('home'));
      const bar = page.locator('#nbd-vr-bar .nbd-vr-barbtn');
      await expect(bar, 'the Record button is on Home').toBeVisible({ timeout: 30_000 });
      const b = await bar.boundingBox();
      const nav = await page.locator('#mobile-nav').first().boundingBox();
      expect(Math.round(b.height), 'thumb-sized').toBeGreaterThanOrEqual(44);
      expect(b.x >= 0 && b.x + b.width <= 390, 'fits the 390 px screen').toBe(true);
      if (nav) expect(b.y + b.height, 'above the bottom nav').toBeLessThanOrEqual(nav.y + 1);
      // leads must be loaded so the recent chip can name the customer; then leave the network
      await safeWaitForFunction(page, (lead) => Array.isArray(window._leads) && window._leads.some((l) => l.id === lead), S.lead, { timeout: 40_000 });
      await safeEvaluate(page, (id) => localStorage.setItem('nbd_recent_customers', JSON.stringify([{ id, ts: Date.now() }])), S.lead);
      await waitForRecorder(page);   // the recorder code is fetched on idle, before the signal goes
      await context.setOffline(true);

      await bar.tap();
      const live = page.locator('.nbd-vr-live');
      await expect(live, 'recording starts with no signal').toBeVisible({ timeout: 15_000 });
      await expect(live).toContainText('Recording');
      await expect(live).toContainText(/cannot record in the background/i);
      await expect(live.locator('.nbd-vr-stop')).toBeVisible();
      await page.waitForTimeout(6500);   // a few 2 s chunks
      await page.screenshot({ path: test.info().outputPath('recording-390.png') });
      await live.locator('.nbd-vr-stop').tap();

      const sheet = page.locator('.nbd-vr-sheet');
      await expect(sheet.locator('.nbd-vr-title')).toHaveText('Who was this?', { timeout: 15_000 });
      await expect(sheet.locator('.nbd-vr-badge')).toContainText(/Saved on phone - waiting for signal/);
      const chip = sheet.locator('.nbd-vr-chip', { hasText: S.name });
      await expect(chip, 'the customer is offered, with its evidence').toBeVisible({ timeout: 15_000 });
      // They are on today's calendar 15 min out AND the most recent customer: the appointment is
      // the stronger evidence and says why.
      await expect(chip).toContainText(/On your calendar at .*15 min after you started/i);
      await page.screenshot({ path: test.info().outputPath('who-was-this-390.png') });
      // not attached until a person taps
      const before = await recorderRows(page);
      expect(before.length).toBe(1);
      expect(before[0].leadId, 'nothing was filed on its own').toBeNull();
      expect(before[0].status).toBe('stored');
      expect(before[0].sizeBytes).toBeGreaterThan(500);
      await sheet.locator('.nbd-vr-btn', { hasText: 'Save unattached' }).tap();
      await expect(page.locator(UNFILED)).toHaveText('Unfiled visits (1)');

      // signal returns: no tap needed
      await context.setOffline(false);
      await expect.poll(async () => { const r = await recorderRows(page); return r[0] && r[0].status + ':' + r[0].docSynced; }, { timeout: 60_000, message: 'uploads by itself' }).toBe('uploaded:true');
      const rows = await recorderRows(page);
      const id = rows[0].id;
      const docs = await visitDocs(S.db, S.uid);
      const d = docs.find((x) => x.id === id);
      expect(d, 'the visit doc exists').toBeTruthy();
      expect(d.status).toBe('uploaded');
      expect(d.leadId).toBeNull();
      expect(d.audioPath).toMatch(new RegExp('^audio/' + S.uid + '/_inbox/' + id + '\\.(webm|m4a)$'));
      expect(Object.keys(d).filter((k) => k !== 'id' && Logic.DOC_FIELDS.indexOf(k) < 0), 'no field the client may not set').toEqual([]);
      expect(d.lat, 'location came with it').toBeCloseTo(39.1031, 3);
      expect(d.sizeBytes).toBeGreaterThan(500);
      // the object really is in Storage, and the audio left the phone only now
      const url = await safeEvaluate(page, (p) => window.getDownloadURL(window.ref(window.storage, p)).then((u) => !!u, () => false), d.audioPath);
      expect(url, 'the Storage object exists').toBe(true);
      expect(await safeEvaluate(page, (i) => window.NBDVisitRecorder._chunksFor(i).then((c) => c.length), id)).toBe(0);

      // PR 2: attaching an UPLOADED visit asks the server to file it (attachVisitCapture). The
      // function is not deployed to the emulator, so the browser's request is answered here and
      // recorded; its server logic is covered by tests/visit-capture-pipeline-2026-10-13.test.js.
      const attachCalls = [];
      await page.route(/attachVisitCapture/, async (route) => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
        if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
        let body = {};
        try { body = JSON.parse(route.request().postData() || '{}').data || {}; } catch (_) {}
        attachCalls.push(body);
        await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ result: { ok: true, leadId: body.leadId || null, tasksMade: 0 } }) });
      });

      // attach by search, from the Unfiled list
      await page.locator(UNFILED).tap();
      const list = page.locator('.nbd-vr-sheet');
      await expect(list.locator('.nbd-vr-title')).toHaveText('Unfiled visits');
      await expect(list.locator('.nbd-vr-item')).toHaveCount(1);
      await expect(list.locator('.nbd-vr-badge')).toContainText('Uploaded');
      await list.locator('.nbd-vr-btn', { hasText: 'Attach' }).tap();
      await page.locator('.nbd-vr-sheet .nbd-vr-btn', { hasText: 'Search customer' }).tap();
      await page.locator('.nbd-vr-input').fill('ZZVisit Reyes' + stamp);
      await page.locator('.nbd-vr-chip', { hasText: S.name }).first().tap();
      await expect.poll(async () => ((await S.db.doc('users/' + S.uid + '/visit_captures/' + id).get()).data() || {}).leadId, { timeout: 20_000 }).toBe(S.lead);
      expect(attachCalls.length, 'the server was asked once, for this visit and this customer').toBe(1);
      expect(attachCalls[0]).toMatchObject({ visitId: id, action: 'attach', leadId: S.lead });
      await expect(page.locator(UNFILED), 'the Home badge clears').toBeHidden();
    });

    test('customer page: Record visit is pre-attached; do-not-record is respected, including the deep link', async ({ page }) => {
      test.setTimeout(240_000);
      if (!S) S = await seed(stamp);
      await page.addInitScript(initStorage);
      await loginAs(page, creds);
      await page.goto('/pro/customer.html?id=' + S.lead);
      await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', null, { timeout: 30_000 });
      const rec = page.locator('#nbd-vr-custbtn');
      await rec.scrollIntoViewIfNeeded();
      await expect(rec).toBeVisible({ timeout: 20_000 });
      expect(Math.round((await rec.boundingBox()).height)).toBeGreaterThanOrEqual(44);
      await rec.tap();
      const live = page.locator('.nbd-vr-live');
      await expect(live).toBeVisible({ timeout: 20_000 });
      await expect(live).toContainText('Attached to');
      await page.waitForTimeout(3500);
      await live.locator('.nbd-vr-stop').tap();
      const sheet = page.locator('.nbd-vr-sheet');
      await expect(sheet.locator('.nbd-vr-title')).toHaveText('Saved on phone', { timeout: 15_000 });
      await expect(sheet).toContainText('Attached to');
      await sheet.locator('.nbd-vr-btn', { hasText: 'Done' }).tap();
      await expect.poll(async () => (await visitDocs(S.db, S.uid)).filter((d) => d.leadId === S.lead && d.source === 'customer').length, { timeout: 40_000 }).toBeGreaterThanOrEqual(1);

      // do not record
      // the toggle is a control, not a primary action: it sits behind More on a phone
      const more = page.locator('#qaMoreBtn');
      if (await more.isVisible() && /^More/.test((await more.textContent()) || '')) await more.tap();
      const dnr = page.locator('#nbd-vr-dnr');
      await dnr.scrollIntoViewIfNeeded();
      await expect(dnr).toBeVisible({ timeout: 15_000 });
      await dnr.tap();
      await expect.poll(async () => ((await S.db.doc('leads/' + S.lead).get()).data() || {}).doNotRecord, { timeout: 15_000 }).toBe(true);
      await expect(rec, 'the record button is disabled for a flagged customer').toBeDisabled();
      // through the deep link: refused, nothing started, no mic
      await page.goto('/pro/dashboard.html?capture=1&lead=' + S.lead);
      await waitForRecorder(page);
      const sheet2 = page.locator('.nbd-vr-sheet');
      await expect(sheet2).toContainText(/marked do not record/i, { timeout: 30_000 });
      expect(await safeEvaluate(page, () => window.NBDVisitRecorder.getState().active)).toBeNull();
      // put it back so later runs are clean
      await S.db.doc('leads/' + S.lead).update({ doNotRecord: false });
    });

    test('deep link ?capture=1 starts recording and strips its own parameters', async ({ page }) => {
      test.setTimeout(180_000);
      if (!S) S = await seed(stamp);
      await page.addInitScript(initStorage);
      await loginAs(page, creds);
      await page.goto('/pro/dashboard.html?capture=1');
      const live = page.locator('.nbd-vr-live');
      await expect(live, 'recording started from the link').toBeVisible({ timeout: 60_000 });
      await expect.poll(() => page.url(), { message: 'the capture parameter is gone so a reload cannot restart it' }).not.toMatch(/capture=/);
      await page.waitForTimeout(2500);
      await live.locator('.nbd-vr-btn', { hasText: 'Pause' }).tap();
      await expect(live).toContainText('Paused');
      await live.locator('.nbd-vr-btn', { hasText: 'Resume' }).tap();
      await live.locator('.nbd-vr-stop').tap();
      await expect(page.locator('.nbd-vr-sheet .nbd-vr-title')).toHaveText('Who was this?', { timeout: 15_000 });
      await expect.poll(async () => (await visitDocs(S.db, S.uid)).filter((d) => d.source === 'deeplink').length, { timeout: 40_000 }).toBeGreaterThanOrEqual(1);
    });

    test('today\'s appointment row has Record visit, pre-attached with the appointment', async ({ page }) => {
      test.setTimeout(180_000);
      if (!S) S = await seed(stamp);
      await page.addInitScript(initStorage);
      await loginAs(page, creds);
      await safeEvaluate(page, () => window.goTo('home'));
      const btn = page.locator('.tp-row[data-tp-row="appt:' + S.appt + '"] .nbd-vr-rowbtn');
      await expect(btn, 'the appointment row carries Record visit').toBeVisible({ timeout: 60_000 });
      expect(Math.round((await btn.boundingBox()).height)).toBeGreaterThanOrEqual(44);
      await btn.tap();
      const live = page.locator('.nbd-vr-live');
      await expect(live).toBeVisible({ timeout: 20_000 });
      await expect(live).toContainText('Attached to');
      await page.waitForTimeout(2500);
      await live.locator('.nbd-vr-stop').tap();
      await expect.poll(async () => (await visitDocs(S.db, S.uid)).filter((d) => d.source === 'appointment' && d.appointmentId === S.appt && d.leadId === S.lead).length, { timeout: 40_000 }).toBeGreaterThanOrEqual(1);
    });
  });
});
