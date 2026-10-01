/**
 * tests/e2e/call-center-card.spec.js — a phone call filed by the Call Center
 * ingest (functions/call-center.js, Cube ACR recordings) shows on its
 * customer's card and plays (2026-10-01).
 *
 * The ingest isn't running here: the test seeds the phone_calls doc and the
 * audio object with the admin SDK, exactly as the ingest writes them. The
 * card must list it under Calls (direction, contact name) and "Play
 * recording" must stream it through getBlob into a blob: <audio>, never a
 * download URL. A call on ANOTHER customer must not show.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

let _app = null;
function admin() {
  if (_app) return _app;
  const { initializeApp, getApps } = require('firebase-admin/app');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro', storageBucket: 'nobigdeal-pro.firebasestorage.app' });
  const { getFirestore } = require('firebase-admin/firestore');
  const { getStorage } = require('firebase-admin/storage');
  _app = { db: getFirestore(), bucket: getStorage().bucket() };
  return _app;
}

// A real (silent) 0.25 s mono WAV so <audio> can decode it.
function silentWav() {
  const rate = 8000, n = 2000, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

test.describe.serial('Call Center → customer card @shard2', () => {
  test('a Cube ACR call lists on its customer and plays from private Storage', async ({ page }) => {
    test.setTimeout(120_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user, null, { timeout: 20_000 });

    const s = Date.now();
    const phone = '5135554' + String(s).slice(-3);
    const id = await safeEvaluate(page, (a) => window._saveLead({ firstName: 'ZZCC', lastName: 'Caller' + a.s, address: '9 Ring Rd, Mason, OH 45040', phone: a.phone, stage: 'new', jobType: 'cash', e2eTestData: true }), { s, phone });
    const other = await safeEvaluate(page, (a) => window._saveLead({ firstName: 'ZZCC', lastName: 'Other' + a.s, address: '10 Ring Rd, Mason, OH 45040', phone: '5135559999', stage: 'new', jobType: 'cash', e2eTestData: true }), { s });
    expect(id && other, 'leads saved').toBeTruthy();

    const { db, bucket } = admin();
    const lead = (await db.doc('leads/' + id).get()).data();
    const uid = lead.userId;
    const path = 'calls/' + uid + '/cube-acr/2026-09-30/cube_zzcc' + s + '.wav';
    await bucket.file(path).save(silentWav(), { contentType: 'audio/wav', resumable: false });
    const base = { userId: uid, companyId: lead.companyId || uid, source: 'cube-acr', ymd: '2026-09-30', savedContact: true, tags: ['customer'], bucket: 'customer', alternateLeadIds: [], status: 'stored', transcript: null, summary: null, actionItems: [], createdAtMs: s };
    await db.doc('phone_calls/cube_zzcc' + s).set(Object.assign({}, base, {
      leadId: id, phoneDigits: phone, contactName: 'ZZCC Caller', direction: 'inbound', startedAtMs: Date.parse('2026-09-30T21:06:55Z'), storagePath: path,
      status: 'noted', summary: 'Gutter leaking again; Jo will send a quote.', followUpDate: '2026-10-02', urgent: true,
      promises: [{ who: 'jo', text: 'Send the gutter repair quote', due: '2026-10-02' }, { who: 'them', text: 'Leave the gate open', due: null }],
    }));
    await db.doc('phone_calls/cube_zzcc' + s + 'x').set(Object.assign({}, base, {
      leadId: other, phoneDigits: '5135559999', contactName: 'ZZCC Someone Else', direction: 'outbound', startedAtMs: Date.parse('2026-09-30T22:00:00Z'), storagePath: null,
    }));

    await page.goto('/pro/customer.html?id=' + encodeURIComponent(id));
    const card = page.locator('[data-call-card="phone:cube_zzcc' + s + '"]');
    await card.waitFor({ state: 'attached', timeout: 30_000 });
    await expect(card).toContainText('ZZCC Caller');
    await expect(card).toContainText('Incoming');
    // Stage 2 AI notes: summary, who promised what, follow-up, urgent.
    await expect(card).toContainText('Gutter leaking again');
    await expect(card.locator('.pc-promise-jo')).toContainText('Send the gutter repair quote');
    await expect(card.locator('.pc-promise-them')).toContainText('Leave the gate open');
    await expect(card).toContainText('Follow up 2026-10-02');
    await expect(card).toContainText('Urgent');
    expect(await page.locator('#callsList').innerText(), 'another customer\'s call stays off this card').not.toContain('Someone Else');

    // Play: getBlob → blob: <audio>; the bytes are the ones the ingest stored.
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const playBtn = card.locator('[data-calls-act="play"]');
    const box = await playBtn.boundingBox().catch(() => null);
    await safeEvaluate(page, (sel) => document.querySelector(sel).click(), '[data-call-card="phone:cube_zzcc' + s + '"] [data-calls-act="play"]');
    const audio = card.locator('audio');
    await audio.waitFor({ state: 'attached', timeout: 20_000 });
    const got = await safeEvaluate(page, async (sel) => {
      const a = document.querySelector(sel);
      const blob = await (await fetch(a.src)).blob();
      return { src: a.src.slice(0, 5), size: blob.size, err: a.error && a.error.code };
    }, '[data-call-card="phone:cube_zzcc' + s + '"] audio');
    expect(got.src).toBe('blob:');
    expect(got.size).toBe(silentWav().length);
    if (box) expect(box.height, 'play button is a 44px phone target').toBeGreaterThanOrEqual(44);
  });
});
