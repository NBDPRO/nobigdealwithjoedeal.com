/**
 * tests/e2e/field-app.spec.js — L08 Field App end to end on the emulators
 * (2026-10-11, D3 of the style integration), at iPhone width.
 *
 * A signed-in rep who picked the Field App for their PHONE gets: today's stop
 * as a big Now card (Navigate / Call / Photo), the stop's Lead screen with a
 * slide-to-confirm "I'm on site" that stamps time + GPS on the lead's
 * timeline, and the Capture camera with a 10x10 test-square overlay, slope
 * chips and a +/- counter. A shot goes through the EXISTING durable photo
 * queue (offline: "No signal · 1 queued", then it uploads when the phone is
 * back online) and lands as a photos doc tagged test_square with the count in
 * its description. Sunlight mode swaps only colour tokens and border widths
 * and survives a reload. Nothing is sent to anyone.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  permissions: ['geolocation', 'camera'],
  geolocation: { latitude: 39.1031, longitude: -84.512, accuracy: 12 },
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

function adb() {
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  return getFirestore();
}

// The Now card is the FIRST stop on today's list, and an all-day booking (a lead
// with a date-only scheduledDate) sorts before every timed appointment
// (today-plan.js: sortMs null -> 0). This spec shares ONE rep with the whole
// shard, and pro-authed.spec.js leaves a '[E2E] Sched' lead scheduled today
// (field-app.spec.js runs after pro-authed.spec.js in the shard), so the Now card
// showed that lead and not this spec's stop. Start from an empty day: the
// product is right to put an all-day job first; the spec has to own its day.
async function emptyToday(uid) {
  const db = adb();
  const { FieldValue } = require('firebase-admin/firestore');
  const leads = await db.collection('leads').where('userId', '==', uid).get();
  for (const d of leads.docs) {
    const x = d.data();
    if (x.e2eTestData === true && x.scheduledDate) await d.ref.update({ scheduledDate: FieldValue.delete() });
  }
  const appts = await db.collection('appointments').where('repUid', '==', uid).get();
  for (const d of appts.docs) await d.ref.delete();
}

test.describe.serial('Field App @shard2', () => {
  test('today -> stop -> on site -> test-square capture (offline queue) -> sunlight', async ({ page, context }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app|api\.weather\.gov/, (route) => route.abort());
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && window.LayoutEngine, null, { timeout: 30_000 });

    await emptyToday(await safeEvaluate(page, () => window._user.uid));

    // a customer with a stop on today's calendar
    const s = Date.now();
    const leadId = await safeEvaluate(page, (st) => window._saveLead({
      firstName: 'ZZFA', lastName: 'Stop' + st, address: '14 Field Ct, Florence, KY 41042', phone: '5135550142', stage: 'new', lat: 39.0, lng: -84.6,
    }), s);
    expect(leadId).toBeTruthy();
    const uid = await safeEvaluate(page, () => window._user.uid);
    const when = new Date(Date.now() + 40 * 60 * 1000);
    await adb().doc('appointments/fa-' + s).set({
      repUid: uid, userId: uid, leadId, title: 'Roof inspection', attendeeName: 'ZZFA Stop' + s,
      startTime: when, endTime: new Date(when.getTime() + 60 * 60 * 1000), status: 'confirmed', location: '14 Field Ct, Florence, KY 41042',
    });

    // choose the Field App for the PHONE, through the engine the picker uses
    const saved = await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'field', device: 'phone' }));
    expect(saved.saved).toBe(true);
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'field' && !!document.getElementById('nbdFieldRoot'), null, { timeout: 40_000 });

    const chrome = await safeEvaluate(page, () => ({
      tap: getComputedStyle(document.documentElement).getPropertyValue('--tap').trim(),
      mobileNav: getComputedStyle(document.getElementById('mobile-nav')).display,
      navItems: document.querySelectorAll('#nbdFieldNav .lk-nav-item').length,
      raised: !!document.querySelector('#nbdFieldNav .lk-nav-raised'),
    }));
    expect(chrome.tap).toBe('56px');
    expect(chrome.mobileNav).toBe('none');
    expect(chrome.navItems).toBe(5);
    expect(chrome.raised).toBe(true);

    // Today: the Now card with Navigate / Call / Photo
    await page.locator('.fa-now-name').waitFor({ state: 'visible', timeout: 40_000 });
    await expect(page.locator('.fa-now-name')).toContainText('ZZFA');
    await expect(page.locator('.fa-now .lk-act-navigate')).toHaveAttribute('href', /google\.com\/maps\/search\/\?api=1&query=14%20Field%20Ct/);
    await expect(page.locator('.fa-now .lk-act-call')).toHaveAttribute('href', 'tel:+15135550142');
    // every tap target on Today is at least --tap (56px) tall
    const small = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdFieldRoot .lk-act, #nbdFieldRoot .fa-big, #nbdFieldNav .lk-nav-item'))
      .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 55).map((e) => e.className + ':' + Math.round(e.getBoundingClientRect().height)));
    expect(small).toEqual([]);

    // Lead screen -> slide to confirm
    await page.locator('[data-fa="lead"]').first().click();
    await page.locator('[data-fa-slide]').waitFor({ state: 'visible' });
    const box = await page.locator('[data-fa-knob]').boundingBox();
    const track = await page.locator('[data-fa-slide]').boundingBox();
    // a short slide snaps back and stamps nothing (a pocket tap can't do it)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('.fa-onsite')).toHaveCount(0);
    // a full slide confirms
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width - 6, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.fa-onsite')).toContainText('On site', { timeout: 15_000 });
    await expect(page.locator('.fa-onsite')).toContainText('GPS ±');
    const act = await safeEvaluate(page, async (id) => {
      const g = await window.getDocs(window.collection(window.db, 'leads', id, 'activity'));
      return g.docs.map((d) => d.data()).filter((d) => d.channel === 'field-app').map((d) => ({ type: d.type, source: d.source, lat: d.lat, msg: d.message }));
    }, leadId);
    expect(act.length).toBe(1);
    expect(act[0].type).toBe('note');
    expect(act[0].source).toBe('rep');
    expect(act[0].msg).toMatch(/^On site at /);
    expect(typeof act[0].lat).toBe('number');

    // Capture: overlay + chips + counter
    await page.locator('[data-fa="capture"]').click();
    await page.locator('.fa-sq').waitFor({ state: 'visible' });
    await expect(page.locator('.fa-cam-title')).toContainText('10 ft × 10 ft test square');
    expect(await page.locator('.fa-chip').count()).toBe(6);
    for (let i = 0; i < 3; i++) await page.locator('[data-fa="plus"]').click();
    await expect(page.locator('#faN')).toHaveText('3');
    await expect(page.locator('#faLine')).toContainText('3 hits counted in this square');
    await expect(page.locator('#faLine')).toContainText('your carrier sets the real number');
    await page.locator('[data-fa="minus"]').click();
    await expect(page.locator('#faN')).toHaveText('2');
    await page.locator('[data-fa="plus"]').click();
    // the live camera is playing (fake device)
    await safeWaitForFunction(page, () => { const v = document.querySelector('[data-fa-video]'); return v && v.videoWidth > 0; }, null, { timeout: 20_000 });

    // OFFLINE: the shot is held on the phone, the line says so, and nothing is lost
    await context.setOffline(true);
    await page.locator('[data-fa="shutter"]').click();
    await expect(page.locator('#faQ')).toContainText('No signal · 1 queued', { timeout: 15_000 });
    // back online: it drains through the existing queue
    await context.setOffline(false);
    await expect.poll(() => safeEvaluate(page, async (id) => {
      const g = await window.getDocs(window.query(window.collection(window.db, 'photos'), window.where('leadId', '==', id)));
      return g.size;
    }, leadId), { timeout: 60_000, intervals: [1500] }).toBeGreaterThanOrEqual(1);
    const photo = await safeEvaluate(page, async (id) => {
      const g = await window.getDocs(window.query(window.collection(window.db, 'photos'), window.where('leadId', '==', id)));
      const d = g.docs[0].data();
      return { tags: d.tags, description: d.description, userId: d.userId };
    }, leadId);
    expect(photo.tags).toEqual(expect.arrayContaining(['hail', 'test_square', 'south_slope']));
    expect(photo.description).toBe('Test square, S: 3 hits counted in 10 ft x 10 ft');

    // Sunlight: colour tokens + border widths only; the theme comes back off
    await page.locator('[data-fa="back"]').first().click();
    const before = await safeEvaluate(page, () => {
      const cs = getComputedStyle(document.documentElement);
      return { bg: cs.getPropertyValue('--bg').trim(), t: cs.getPropertyValue('--t').trim(), tap: cs.getPropertyValue('--tap').trim() };
    });
    await page.locator('[data-fa="sun"]').click();
    const sun = await safeEvaluate(page, () => {
      const cs = getComputedStyle(document.documentElement);
      const box = document.querySelector('#nbdFieldRoot .fa-now, #nbdFieldRoot .fa-empty');
      return {
        on: document.documentElement.classList.contains('sun'),
        bg: cs.getPropertyValue('--bg').trim(), t: cs.getPropertyValue('--t').trim(), rule: cs.getPropertyValue('--rule').trim(),
        tap: cs.getPropertyValue('--tap').trim(), bw: cs.getPropertyValue('--fa-bw').trim(),
        border: box ? getComputedStyle(box).borderTopWidth : '',
      };
    });
    expect(sun.on).toBe(true);
    expect(sun.bg).toBe('#ffffff');
    expect(sun.t).toBe('#000000');
    expect(sun.rule).toBe('#000000');
    expect(sun.bw).toBe('2.5px');
    expect(sun.tap).toBe(before.tap);   // sizes untouched: only colour + border widths change
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.classList.contains('sun'), null, { timeout: 30_000 });
    await page.locator('[data-fa="sun"]').click();   // off again
    const after = await safeEvaluate(page, () => ({ on: document.documentElement.classList.contains('sun'), t: getComputedStyle(document.documentElement).getPropertyValue('--t').trim() }));
    expect(after.on).toBe(false);
    expect(after.t).toBe(before.t);
  });
});
