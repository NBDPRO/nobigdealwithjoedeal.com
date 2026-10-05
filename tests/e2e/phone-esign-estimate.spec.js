// tests/e2e/phone-esign-estimate.spec.js — Send for signature on the phone,
// end to end on the in-house e-sign (BoldSign retired 2026-10-04).
//
// 390 × 844, standalone rules forced on (same harness as phone-close-flow).
//
//   1. The rep builds an Ohio cash estimate in the V3 wizard and taps
//      Finish → More → "✍️ Send for Signature". The REAL sendEstimateEnvelope
//      runs in the functions emulator: it saves-then-builds the contract PDF,
//      registers the envelope and returns the single-use link (the email is
//      stubbed in the emulator — nothing is sent).
//   2. The homeowner opens that link on their phone (a fresh, signed-out
//      context): the real getEsignEnvelope serves the PDF; they draw a
//      signature, accept today's date, consent, type their name, submit — the
//      real submitEsignEnvelope stamps it.
//   3. The executed record exists: envelope completed with per-signer ESIGN
//      evidence (consent + text, IP, user agent, time, values digest), the
//      signed PDF is in Storage (a real PDF, larger than the source, with the
//      certificate page), and the estimate reads "signed".
//
// The signing page calls the functions emulator cross-origin; the functions'
// CORS allow-list is the production origins only, so those two requests are
// relayed by the test (route.fetch → real emulator response + an ACAO header)
// rather than mocked: what comes back is the function's own answer.
//
// Requires the FUNCTIONS emulator (NBD_EMU_FUNCTIONS=1; the @gauntlet shard
// boots it in CI) with dummy secrets.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { installLocalSdkShim } = require('./fixtures/local-sdk');

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const SHOTS = process.env.NBD_E2E_SHOTS || '';
const BASE = process.env.PLAYWRIGHT_BASE_URL || '';
const EMULATOR_MODE = /localhost|127\.0\.0\.1/.test(BASE) && !!process.env.FIRESTORE_EMULATOR_HOST;
const FUNCTIONS_UP = !!process.env.NBD_EMU_FUNCTIONS;

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _admin = null;
function admin() {
  if (_admin) return _admin;
  const { initializeApp, getApps } = require('firebase-admin/app');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  const { getFirestore } = require('firebase-admin/firestore');
  const { getStorage } = require('firebase-admin/storage');
  _admin = { db: getFirestore(), storage: getStorage() };
  return _admin;
}
/** The object at `p` in whichever default bucket the functions emulator used. */
async function readStored(p) {
  for (const b of ['nobigdeal-pro.firebasestorage.app', 'nobigdeal-pro.appspot.com']) {
    const f = admin().storage.bucket(b).file(p);
    const [exists] = await f.exists().catch(() => [false]);
    if (exists) { const [buf] = await f.download(); return buf; }
  }
  return null;
}

async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) {
          for (const inner of r.cssRules) css += inner.cssText + '\n';
        }
      }
    }
    const s = document.createElement('style');
    s.id = 'e2e-force-standalone';
    s.textContent = css;
    document.head.appendChild(s);
    return css.length;
  });
}
async function seedLead(page) {
  return safeEvaluate(page, async () => {
    const stamp = Date.now();
    const fsMod = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const lead = {
      firstName: '[E2E] Esign', lastName: 'Owner' + stamp,
      address: stamp + ' Sign Way, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7),
      email: 'e2e-esign-' + stamp + '@nbd.test',
      jobType: 'cash', stage: 'new', e2eTestData: true,
      userId: uid, companyId, createdAt: fsMod.serverTimestamp(),
    };
    const id = (await fsMod.addDoc(fsMod.collection(db, 'leads'), lead)).id;
    if (typeof window.loadLeads === 'function') await window.loadLeads();
    for (let i = 0; i < 75 && !(window._leads || []).some((l) => l.id === id); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return { id, email: lead.email, name: lead.firstName + ' ' + lead.lastName };
  });
}
async function openWizard(page, arg) {
  await safeWaitForFunction(page, () => !!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function'), { timeout: 20_000 });
  await safeEvaluate(page, async (a) => {
    await window.ScriptLoader.loadBundle('estimates');
    window.openEstimateV2Builder(a);
  }, arg);
  await expect(page.locator('#estV2Modal.open.v3-on')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
}
async function jumpTo(page, title) {
  await page.locator('#estV2Modal .v3-jump').tap();
  await page.locator('#estV2Modal .v3-sheet:not([hidden]) .v3-sheet-row').filter({ hasText: title }).tap();
  await expect(page.locator('#estV2Modal .v3-title')).toHaveText(title);
}

/** Relay the signing page's two cross-origin calls to the real functions emulator. */
async function relayEsignCalls(ctx) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  await ctx.route(/127\.0\.0\.1:5001\/nobigdeal-pro\/us-central1\/(getEsignEnvelope|submitEsignEnvelope|declineEsignEnvelope)$/, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const resp = await route.fetch();
    return route.fulfill({ response: resp, headers: Object.assign({}, resp.headers(), cors) });
  });
}

test.describe('phone e-sign: Send for signature → homeowner signs → signed PDF stored @gauntlet', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.skip(!EMULATOR_MODE || !FUNCTIONS_UP, 'needs the auth/firestore/storage/hosting + FUNCTIONS emulators (NBD_EMU_FUNCTIONS=1)');
  test.use(IPHONE);

  test('remote send → sign on a phone → executed record with evidence', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await installLocalSdkShim(page.context());
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.route('**/renderPdf**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"status":"INTERNAL","message":"mocked"}}' }));
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid), { timeout: 20_000 });
    const lead = await seedLead(page);
    expect(await forceStandalone(page)).toBeGreaterThan(200);

    let link = '';
    await test.step('rep: build the estimate and Send for Signature (real sendEstimateEnvelope)', async () => {
      await openWizard(page, { leadId: lead.id });
      await expect(page.locator('#estV2Modal .v3-title')).toHaveText('Measure');
      await page.locator('#v2rawSqft').fill('2400');
      await page.locator('#v2rawSqft').dispatchEvent('input');
      await jumpTo(page, 'Package');
      await page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]').tap();
      await expect(page.locator('#estV2Modal .v3-pkg .v3-tier').first()).toBeVisible();
      await jumpTo(page, 'Finish');
      await page.locator('#estV2Modal .v3-more').tap();
      const sign = page.locator('#v2signBtn');
      await sign.scrollIntoViewIfNeeded();
      await expect(sign, 'Ohio cash: Send for Signature is offered').toBeVisible();
      expect((await sign.boundingBox()).height, 'thumb-sized').toBeGreaterThanOrEqual(44);
      await expect(page.locator('#v2cosign'), 'the optional co-owner fields are there').toBeVisible();
      await sign.tap();
      // The emulator stubs the email, so the rep is told to text the link.
      await expect(page.locator('#v2signStatus')).toHaveText(/Link ready|Sent to/, { timeout: 60_000 });
      link = (await page.locator('#v2shareBox .v2-share-url').textContent() || '').trim();
      expect(link, 'a single-use esign.html link came back').toMatch(/^https:\/\/nobigdealwithjoedeal\.com\/pro\/esign\.html\?t=[A-Z2-9]{24}$/);
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      expect(noOverflow, 'no sideways scroll at 390').toBe(true);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'esign-sent-390.png') });
    });

    const est = await safeEvaluate(page, async (id) => {
      const fsMod = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const uid = (window._auth || window.auth).currentUser.uid;
      const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'estimates'), fsMod.where('leadId', '==', id), fsMod.where('userId', '==', uid)));
      return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    }, lead.id);
    expect(est.length, 'the estimate was saved before the send').toBe(1);
    expect(est[0].signatureStatus, 'estimate reads sent').toBe('sent');
    expect(est[0].signatureProvider).toBe('nbd-esign');
    const envelopeId = est[0].signatureEnvelopeId;
    expect(envelopeId).toMatch(/^est_/);

    await test.step('homeowner: open the link on a phone, sign, consent, submit (real functions)', async () => {
      const ho = await browser.newContext(IPHONE);
      await installLocalSdkShim(ho);
      await relayEsignCalls(ho);
      const hp = await ho.newPage();
      const errors = [];
      hp.on('pageerror', (e) => errors.push(String(e)));
      const token = link.split('?t=')[1];
      await hp.goto(BASE.replace(/\/$/, '') + '/pro/esign.html?t=' + token);
      await hp.waitForSelector('.es-field', { timeout: 60_000 });
      expect(await hp.locator('.es-field').count(), 'the homeowner\'s two boxes: signature + date').toBe(2);
      await expect(hp.locator('#esDeclineBtn'), 'Decline is offered').toBeVisible();
      expect(await hp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll at 390').toBe(true);
      if (SHOTS) await hp.screenshot({ path: path.join(SHOTS, 'esign-signer-390.png') });

      await hp.locator('.es-field[data-field-id="sig_signer"]').click();
      await hp.waitForSelector('#esSheet:not([hidden])');
      const box = await hp.locator('#esPad').boundingBox();
      await hp.mouse.move(box.x + 30, box.y + box.height / 2);
      await hp.mouse.down();
      for (let i = 1; i <= 14; i++) await hp.mouse.move(box.x + 30 + i * 12, box.y + box.height / 2 + Math.sin(i) * 22);
      await hp.mouse.up();
      await hp.locator('#esApply').click();
      await hp.waitForSelector('#esSheet', { state: 'hidden' });

      await hp.locator('.es-field[data-field-id="date_signer"]').click();
      await hp.waitForSelector('#esSheet:not([hidden])');
      expect(await hp.locator('#esTextInput').inputValue(), 'date prefilled').toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
      await hp.locator('#esApply').click();
      await hp.waitForSelector('#esSheet', { state: 'hidden' });

      await hp.locator('#esFinish').click();
      await hp.waitForSelector('#esDone:not([hidden])');
      await hp.locator('#esConsent').check();
      await hp.locator('#esSignerName').fill(lead.name);
      await hp.locator('#esSubmit').click();
      await expect(hp.locator('#esMsgTitle')).toHaveText(/All done/, { timeout: 90_000 });
      await expect(hp.locator('#esMsgBody')).toContainText('copy is on its way to your email');
      expect(errors, 'no page errors on the signing page').toEqual([]);
      if (SHOTS) await hp.screenshot({ path: path.join(SHOTS, 'esign-done-390.png') });
      await ho.close();
    });

    await test.step('the executed record: evidence, signed PDF in Storage, estimate signed', async () => {
      const env = (await admin().db.doc('esign_envelopes/' + envelopeId).get()).data() || {};
      expect(env.status, 'envelope completed').toBe('completed');
      expect(env.signedPath).toBe(`esign/${env.ownerUid}/${lead.id}/${envelopeId}/signed.pdf`);
      const s = (env.signers || [])[0] || {};
      expect(s.consent && s.consent.agreed, 'consent recorded').toBe(true);
      expect(s.consent && s.consent.text, 'with the text shown').toMatch(/legal equivalent of my handwritten signature/);
      expect(s.ip, 'signer IP recorded').toBeTruthy();
      expect(s.ua, 'signer user agent recorded').toMatch(/iPhone/);
      expect(s.signedAt, 'signing time recorded').toBeGreaterThan(0);
      expect(s.typedName, 'typed legal name recorded').toBe(lead.name);
      expect(s.valuesSha256, 'values digest recorded').toMatch(/^[0-9a-f]{64}$/);
      expect(env.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(env.signedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect((env.copiesDelivered || []).length, 'the signed copy delivery is recorded (stubbed in the emulator)').toBe(1);

      const signed = await readStored(env.signedPath);
      expect(signed, 'the signed PDF is in Storage').toBeTruthy();
      expect(signed.slice(0, 5).toString(), 'a real PDF').toBe('%PDF-');
      expect(require('crypto').createHash('sha256').update(signed).digest('hex'), 'and it is the one the digest names').toBe(env.signedSha256);
      const source = await readStored(env.sourcePath);
      expect(signed.length, 'larger than the source (signature + certificate page)').toBeGreaterThan(source.length);

      const estAfter = (await admin().db.doc('estimates/' + est[0].id).get()).data() || {};
      expect(estAfter.signatureStatus, 'the estimate reads signed').toBe('signed');
    });
  });
});
