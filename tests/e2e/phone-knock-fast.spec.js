// tests/e2e/phone-knock-fast.spec.js — the door-knock sheet's fast path on an
// iPhone (390x844, installed app). CRM phone audit 2026-10-07, item 3 / batch C.
//
// The finding: one Not Home took 8 taps + 4 swipes. Save sat ~2.2 screens down
// the sheet, and the door-number confirm only appeared after Save failed —
// back at the top. What this file pins, by behaviour (real taps, hit-tests,
// the knock doc read back from Firestore):
//   gate      the door-number tick is on screen BEFORE any Save, beside the
//             outcomes; Save is in view without a swipe, and still is with
//             the keyboard up (viewport shrunk to the space above it).
//   one-tap   tick + Not Home saves the knock — the same fields a Save-button
//             knock writes — and the Undo bar deletes it.
//   refused   unticked, Not Home saves nothing and points at the tick.
//   door #    GPS finds the street but no house number: the sheet fills the
//             street in and asks for the door number inline.
//   consent   "OK to text" still decides smsConsent (Come Back, no lead made).
//   interested  Interested never saves on the tap: it opens the contact fields.
//   offline   one tap queues the knock ONCE and closes the sheet; it syncs
//             when the phone is back online.
//
// Knocks this file writes carry a unique address prefix and are deleted in
// afterAll (knocks have no e2eRun field — the app writes a fixed shape).
// No Interested / hot knock is saved, so no CRM lead is created.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const W = 390, H = 844;
let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

// Fields every knock doc carries (d2d-tracker-core-2026b.js submitKnock). A
// one-tap knock must write exactly these — no more, no fewer.
const KNOCK_KEYS = ['addrConfidence', 'addrConfirmed', 'addrHouseNumber', 'addrNeedsReverify', 'addrRoundTripMeters', 'addrSources',
  'addrVerifiedAt', 'address', 'appointmentAt', 'attemptNumber', 'claimNumber', 'clientTempId', 'closedDealValue', 'companyId',
  'convertedToLead', 'createdAt', 'disposition', 'email', 'estimateValue', 'followUpDate', 'followUpSource', 'followUpTime',
  'gpsAccuracy', 'homeowner', 'insCarrier', 'lat', 'lng', 'notes', 'phone', 'photoPaths', 'photoUrls', 'repId', 'repName',
  'smsConsent', 'stage', 'updatedAt', 'userId', 'voiceUrl'].sort();

async function hitTest(page, selector) {
  return safeEvaluate(page, (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { why: 'missing' };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { why: '0x0' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { why: 'off-screen at y=' + Math.round(y) };
    const h = document.elementFromPoint(x, y);
    const ok = !!h && (h === el || el.contains(h));
    return { why: ok ? 'hit' : 'covered by ' + (h ? h.tagName + '.' + String(h.className).split(' ')[0] : 'nothing'), height: r.height, width: r.width, right: r.right, bottom: r.bottom };
  }, selector);
}
async function expectTappable(page, selector, label) {
  await expect.poll(async () => (await hitTest(page, selector)).why, { message: `${label} (${selector}) is under a thumb`, timeout: 8_000 }).toBe('hit');
  const h = await hitTest(page, selector);
  expect(h.height, `${label} is a 44px target`).toBeGreaterThanOrEqual(44);
  expect(h.right, `${label} fits the ${W}px screen`).toBeLessThanOrEqual(W);
}
async function dismissToasts(page) {
  for (let i = 0; i < 8; i++) {
    const close = page.locator('#toastContainer .toast-close').first();
    if (!(await close.count())) return;
    await close.tap({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

// Knocks by address, read from the server.
const knocksAt = (page, address) => safeEvaluate(page, async (addr) => {
  const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
  const snap = await fs.getDocsFromServer(fs.query(fs.collection(window._db, 'knocks'), fs.where('userId', '==', window._user.uid), fs.where('address', '==', addr)));
  return snap.docs.map((d) => Object.assign({ id: d.id, keys: Object.keys(d.data()).sort() }, d.data()));
}, address);

test.describe.serial('phone knock sheet fast path at 390px, installed app @shard2', () => {
  /** @type {import('@playwright/test').BrowserContext} */ let context;
  /** @type {import('@playwright/test').Page} */ let page;
  let stamp = 0;
  let prefix = '';
  // Reverse geocode answer for the GPS test: a road with no house number.
  const geo = { streetOnly: false };

  const sheet = '#d2d-quick-knock-overlay';
  const addrFor = (tag) => `${prefix}${tag} Fastknock Ln, Cincinnati, OH 45202`;

  async function openSheet(address) {
    await safeEvaluate(page, (a) => window.D2D.openQuickKnock({ address: a }), address);
    await expect(page.locator(sheet + '.open')).toBeVisible({ timeout: 10_000 });
    // The open-time verify (stubbed: no source answers) settles the badge
    // ('' until it starts, 'resolving' while it runs).
    await expect.poll(() => safeEvaluate(page, () => (document.getElementById('d2d-addr-badge') || {}).dataset.state || ''), { timeout: 10_000 }).toMatch(/^(unverified|likely|verified|conflict|error)$/);
    await dismissToasts(page);
  }
  async function closed() {
    await expect(page.locator(sheet + '.open')).toHaveCount(0, { timeout: 20_000 });
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(90_000);
    stamp = Date.now();
    prefix = String(stamp).slice(-4);
    context = await browser.newContext({
      viewport: { width: W, height: H }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
      geolocation: { latitude: 39.1031, longitude: -84.512, accuracy: 8 }, permissions: ['geolocation'],
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await context.addInitScript(() => {
      try { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); } catch (_) {}
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
        const today = new Date().toISOString().split('T')[0];
        ['overdue_scan', 'pending_estimate_scan', 'morning_briefing'].forEach((k) => localStorage.setItem('nbd_proactive_' + k, today));
      } catch (_) {}
    });
    page = await context.newPage();
    await page.route('**/nominatim.openstreetmap.org/**', (r) => {
      if (/reverse/.test(r.request().url()) && geo.streetOnly) {
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ display_name: 'Fastknock Lane, Cincinnati, Ohio, 45202', addresstype: 'road', lat: '39.1031', lon: '-84.512', address: { road: 'Fastknock Lane', city: 'Cincinnati', state: 'Ohio', postcode: '45202' } }) });
      }
      return r.fulfill({ contentType: 'application/json', body: '[]' });
    });
    // Nothing leaves: every callable answers null (resolveAddress → no source).
    await page.route(/127\.0\.0\.1:5001\/|cloudfunctions\.net\//, (r) => r.fulfill({ contentType: 'application/json', body: '{"result":null}' }));
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!window._user, { timeout: 30_000 });
    await safeEvaluate(page, () => window.goTo('d2d'));
    await safeWaitForFunction(page, () => window.D2D && typeof window.D2D.openQuickKnock === 'function' && !!window._D2DState, { timeout: 30_000 });
    // The installed app's own CSS (display-mode: standalone can't be emulated).
    await safeEvaluate(page, () => {
      let css = '';
      for (const sh of document.styleSheets) {
        let rules; try { rules = sh.cssRules; } catch (e) { continue; }
        for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
      }
      const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(60_000);
    if (!page) return;
    await context.setOffline(false).catch(() => {});
    const left = await safeEvaluate(page, async (pre) => {
      const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const snap = await fs.getDocsFromServer(fs.query(fs.collection(window._db, 'knocks'), fs.where('userId', '==', window._user.uid)));
      const mine = snap.docs.filter((d) => String(d.data().address || '').indexOf(pre) === 0 && / Fastknock L/.test(d.data().address));
      await Promise.all(mine.map((d) => fs.deleteDoc(d.ref)));
      return mine.length;
    }, prefix).catch((e) => 'cleanup failed: ' + (e && e.message));
    // eslint-disable-next-line no-console
    console.log('[phone-knock-fast] removed knocks:', left);
    if (context) await context.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('gate: the door-number tick is on screen before any Save, and Save never needs a swipe', async () => {
    await openSheet(addrFor('10'));
    // Unverified number (no source answered) → the tick is shown up front, ABOVE
    // the outcomes. On main it stayed hidden until a failed Save.
    await expect(page.locator('#d2d-addr-confirm')).toBeVisible();
    // Save on the first screen of the sheet, no swipe (main: ~2 screens down).
    await expectTappable(page, '#d2d-qk-save', 'Save');
    await expect(page.locator('#d2d-addr-confirm-txt')).toContainText('#' + prefix + '10');
    await expectTappable(page, '.d2d-addr-confirm-lbl', 'door-number tick');
    for (const k of ['not_home', 'not_interested', 'left_material', 'come_back', 'interested']) {
      await expectTappable(page, `${sheet} .d2d-quick-btn[data-quick="${k}"]`, 'outcome ' + k);
    }
    await expectTappable(page, '#d2d-qk-save', 'Save');
    // Scroll the sheet's body to its end: Save stays where it is.
    await safeEvaluate(page, () => { const b = document.querySelector('#d2d-quick-knock-overlay .d2d-modal-body'); b.scrollTop = b.scrollHeight; });
    await expectTappable(page, '#d2d-qk-save', 'Save after scrolling the sheet');
    // Keyboard up: the space above an iPhone keyboard (~508 of 844). The sheet
    // follows the visual viewport, so Save sits just above the keyboard.
    await page.locator('#d2d-quick-knock-overlay .d2d-details > summary').tap();
    await page.locator('#d2d-qk-notes').tap();
    await page.setViewportSize({ width: W, height: 508 });
    await expect.poll(async () => (await hitTest(page, '#d2d-qk-save')).why, { message: 'Save above the keyboard' }).toBe('hit');
    expect((await hitTest(page, '#d2d-qk-save')).bottom).toBeLessThanOrEqual(508);
    await page.setViewportSize({ width: W, height: H });
    await page.locator(sheet + ' .d2d-modal-close').tap();
    await closed();
    expect(await knocksAt(page, addrFor('10')), 'closing writes nothing').toHaveLength(0);
  });

  test('refused: without the tick, Not Home saves nothing and points at the box', async () => {
    await openSheet(addrFor('20'));
    await page.locator(`${sheet} .d2d-quick-btn[data-quick="not_home"]`).tap();
    await expect(page.locator('#toastContainer')).toContainText('Confirm the door number', { timeout: 5_000 });
    await expect(page.locator(sheet + '.open')).toBeVisible();
    await expectTappable(page, '.d2d-addr-confirm-lbl', 'door-number tick after the refusal');
    expect(await knocksAt(page, addrFor('20'))).toHaveLength(0);
    await page.locator(sheet + ' .d2d-modal-close').tap();
    await closed();
  });

  test('one-tap: tick + Not Home writes the same knock as Save, and Undo deletes it', async () => {
    // Reference: the long way — pick Not Home in the full grid, tap Save.
    await openSheet(addrFor('30'));
    await page.locator('.d2d-addr-confirm-lbl').tap();
    await page.locator(`${sheet} .d2d-dispo-btn[data-dispo="not_home"]`).scrollIntoViewIfNeeded();
    await page.locator(`${sheet} .d2d-dispo-btn[data-dispo="not_home"]`).tap();
    await page.locator('#d2d-qk-save').tap();
    await closed();
    let ref = [];
    await expect.poll(async () => (ref = await knocksAt(page, addrFor('30'))).length, { timeout: 15_000 }).toBe(1);

    // One tap.
    await openSheet(addrFor('32'));
    await page.locator('.d2d-addr-confirm-lbl').tap();
    await expect(page.locator('#d2d-addr-confirm-chk')).toBeChecked();
    await page.locator(`${sheet} .d2d-quick-btn[data-quick="not_home"]`).tap();
    await closed();
    let quick = [];
    await expect.poll(async () => (quick = await knocksAt(page, addrFor('32'))).length, { timeout: 15_000 }).toBe(1);
    const k = quick[0];
    expect(k.keys, 'the one-tap knock writes the standard knock fields').toEqual(KNOCK_KEYS);
    expect(k.keys, 'same fields as a Save-button knock').toEqual(ref[0].keys);
    expect(k.disposition).toBe('not_home');
    expect(k.stage).toBe('knock');
    expect(k.addrConfirmed, 'the rep ticked the door number').toBe(true);
    expect(k.smsConsent).toBe(false);
    expect(k.followUpSource, 'same follow-up as the Save path').toBe(ref[0].followUpSource);
    expect(k.createdAt, 'createdAt is set (the knock list orders by it)').toBeTruthy();

    // Undo.
    await expectTappable(page, '#d2d-undo-bar .d2d-undo-btn', 'Undo');
    await expect(page.locator('#d2d-undo-bar')).toContainText('Not Home');
    await page.locator('#d2d-undo-bar .d2d-undo-btn').tap();
    await expect.poll(async () => (await knocksAt(page, addrFor('32'))).length, { message: 'Undo deleted the knock', timeout: 15_000 }).toBe(0);
    expect(await knocksAt(page, addrFor('30')), 'Undo touched only its own knock').toHaveLength(1);
  });

  test('door #: GPS finds the street but no number — the sheet asks for the door number inline', async () => {
    geo.streetOnly = true;
    await safeEvaluate(page, () => {
      localStorage.removeItem('nbd_d2d_addr_cache_v1');
      const s = window._D2DState;
      s.currentLocation = [39.1031, -84.512]; s.gpsFixAt = Date.now(); s.gpsAccuracy = 8;
    });
    await dismissToasts(page);
    await page.locator('button.d2d-big-btn', { hasText: 'Knock' }).first().tap();
    await expect(page.locator(sheet + '.open')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#d2d-qk-address')).toHaveValue(/^Fastknock Lane, Cincinnati/, { timeout: 10_000 });
    await expect(page.locator('#d2d-doornum-row')).toBeVisible();
    await expect(page.locator('#d2d-addr-confirm'), 'nothing to confirm before there is a number').toBeHidden();
    await expectTappable(page, '#d2d-qk-doornum', 'Door # box');
    await page.locator('#d2d-qk-doornum').tap();
    await page.locator('#d2d-qk-doornum').pressSequentially(prefix + '40');
    await expect(page.locator('#d2d-qk-address')).toHaveValue(`${prefix}40 Fastknock Lane, Cincinnati, Ohio 45202`);
    await expect(page.locator('#d2d-doornum-row'), 'the box stays while typing').toBeVisible();
    await expect(page.locator('#d2d-addr-confirm')).toBeVisible();
    await page.locator('.d2d-addr-confirm-lbl').tap();
    await page.locator(`${sheet} .d2d-quick-btn[data-quick="not_home"]`).tap();
    await closed();
    let k = [];
    const addr = `${prefix}40 Fastknock Lane, Cincinnati, Ohio 45202`;
    await expect.poll(async () => (k = await knocksAt(page, addr)).length, { timeout: 15_000 }).toBe(1);
    expect(k[0].addrHouseNumber).toBe(prefix + '40');
    expect(k[0].addrNeedsReverify, 'a typed door number goes to the re-verify queue').toBe(true);
    expect(k[0].lat, 'the knock keeps the GPS position').toBeCloseTo(39.1031, 3);
    geo.streetOnly = false;
  });

  test('consent: "OK to text" still decides smsConsent', async () => {
    for (const [tag, tick] of [['50', false], ['52', true]]) {
      await openSheet(addrFor(tag));
      await page.locator('.d2d-addr-confirm-lbl').tap();
      // Come Back: selects and opens Contact & Notes (no lead is made).
      await page.locator(`${sheet} .d2d-quick-btn[data-quick="come_back"]`).tap();
      await expect(page.locator(sheet + '.open'), 'Come Back does not save on the tap').toBeVisible();
      await expect(page.locator('#d2d-qk-phone')).toBeVisible();
      await page.locator('#d2d-qk-phone').fill('513555' + prefix);
      if (tick) {
        await page.locator(`${sheet} .d2d-consent-lbl`).scrollIntoViewIfNeeded(); // one swipe down the sheet
        await expectTappable(page, `${sheet} .d2d-consent-lbl`, 'OK to text');
        await page.locator(`${sheet} .d2d-consent-lbl`).tap();
        await expect(page.locator('#d2d-qk-sms-consent')).toBeChecked();
      }
      await expectTappable(page, '#d2d-qk-save', 'Save');
      await page.locator('#d2d-qk-save').tap();
      await closed();
      let k = [];
      await expect.poll(async () => (k = await knocksAt(page, addrFor(tag))).length, { timeout: 15_000 }).toBe(1);
      expect(k[0].disposition).toBe('come_back');
      expect(k[0].smsConsent, tick ? 'ticked → consent on file' : 'not ticked → no consent').toBe(tick);
    }
  });

  test('interested: never saves on the tap — opens the contact fields with the name ready', async () => {
    await openSheet(addrFor('60'));
    await page.locator('.d2d-addr-confirm-lbl').tap();
    await page.locator(`${sheet} .d2d-quick-btn[data-quick="interested"]`).tap();
    await expect(page.locator(sheet + '.open')).toBeVisible();
    await expect(page.locator('#d2d-qk-save')).toContainText('Interested');
    await expect.poll(() => safeEvaluate(page, () => document.activeElement && document.activeElement.id)).toBe('d2d-qk-homeowner');
    await expect(page.locator('#d2d-qk-sms-consent')).not.toBeChecked();
    expect(await knocksAt(page, addrFor('60'))).toHaveLength(0);
    await page.locator(sheet + ' .d2d-modal-close').tap();
    await closed();
  });

  test('offline: one tap queues the knock once and closes the sheet; it syncs back online', async () => {
    const qLen = () => safeEvaluate(page, () => { try { return JSON.parse(localStorage.getItem('nbd_d2d_sync_queue') || '[]').length; } catch (_) { return -1; } });
    const before = await qLen();
    await context.setOffline(true);
    await expect.poll(() => safeEvaluate(page, () => window._D2DState.isOnline)).toBe(false);
    await openSheet(addrFor('70'));
    await page.locator('.d2d-addr-confirm-lbl').tap();
    await page.locator(`${sheet} .d2d-quick-btn[data-quick="not_home"]`).tap();
    await closed();
    expect(await qLen(), 'queued exactly once').toBe(before + 1);
    await expect(page.locator('#d2d-undo-bar')).toContainText('offline');
    await context.setOffline(false);
    await expect.poll(async () => (await knocksAt(page, addrFor('70'))).length, { message: 'the queued knock synced', timeout: 30_000 }).toBe(1);
    await expect.poll(qLen, { timeout: 10_000 }).toBe(before);
  });
});
