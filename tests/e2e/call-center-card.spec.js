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


// Test customers are written with the admin SDK, not window._saveLead: the
// specs test the call UI, and two back-to-back _saveLead commits on a busy
// emulator flaked with ALREADY_EXISTS (2026-10-02, then every retry timed out).
async function seedLead(page, db, fields) {
  const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
  const now = new Date();
  const ref = await db.collection('leads').add(Object.assign({
    userId: who.uid, companyId: who.co, deleted: false, e2eTestData: true, source: 'E2E', createdAt: now, updatedAt: now,
  }, fields, { phoneDigits: String(fields.phone || '').replace(/\D/g, '').slice(-10) }));
  return ref.id;
}

test.describe.serial('Call Center → customer card @shard2', () => {
  test('a Cube ACR call lists on its customer and plays from private Storage', async ({ page }) => {
    test.setTimeout(120_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    // ✓ Handled / Wrong customer → move (2026-10-03) go through callCenterAction;
    // its server side (tenant checks, the move itself) is covered by
    // tests/call-center-action-2026-10-01.test.js. Answered here in the browser.
    const actions = [];
    await page.route(/callCenterAction/, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' } });
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}').data || {}; } catch (_) {}
      actions.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ result: { ok: true, moved: body.action === 'move', leadId: body.leadId || null } }) });
    });
    await page.route(/nominatim\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'application/json', body: '[]', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!window._user && !!window._user.uid, null, { timeout: 20_000 });

    const s = Date.now();
    const phone = '5135554' + String(s).slice(-3);
    const id = await seedLead(page, admin().db, { firstName: 'ZZCC', lastName: 'Caller' + s, address: '9 Ring Rd, Mason, OH 45040', phone, stage: 'new', jobType: 'cash' });
    const other = await seedLead(page, admin().db, { firstName: 'ZZCC', lastName: 'Other' + s, address: '10 Ring Rd, Mason, OH 45040', phone: '5135559999', stage: 'new', jobType: 'cash' });
    expect(id && other, 'leads saved').toBeTruthy();

    const { db, bucket } = admin();
    const lead = (await db.doc('leads/' + id).get()).data();
    const uid = lead.userId;
    const path = 'calls/' + uid + '/cube-acr/2026-09-30/cube_zzcc' + s + '.wav';
    await bucket.file(path).save(silentWav(), { contentType: 'audio/wav', resumable: false });
    const base = { userId: uid, companyId: lead.companyId || uid, source: 'cube-acr', ymd: '2026-09-30', savedContact: true, tags: ['customer'], bucket: 'customer', alternateLeadIds: [], status: 'stored', transcript: null, summary: null, actionItems: [], createdAtMs: s };
    await db.doc('phone_calls/cube_zzcc' + s).set(Object.assign({}, base, {
      leadId: id, alternateLeadIds: [other], phoneDigits: phone, contactName: 'ZZCC Caller', direction: 'inbound', startedAtMs: Date.parse('2026-09-30T21:06:55Z'), storagePath: path,
      status: 'noted', summary: 'Gutter leaking again; Jo will send a quote.', followUpDate: '2026-10-02', urgent: true,
      promises: [{ who: 'jo', text: 'Send the gutter repair quote', due: '2026-10-02' }, { who: 'them', text: 'Leave the gate open', due: null }],
    }));
    await db.doc('phone_calls/cube_zzcc' + s + 'x').set(Object.assign({}, base, {
      leadId: other, phoneDigits: '5135559999', contactName: 'ZZCC Someone Else', direction: 'outbound', startedAtMs: Date.parse('2026-09-30T22:00:00Z'), storagePath: null,
    }));
    // Texts from the phone backup (phone_texts), this customer and another.
    const tbase = { userId: uid, companyId: lead.companyId || uid, source: 'sms-backup', kind: 'sms', group: false, bucket: 'customer', alternateLeadIds: [], createdAtMs: s };
    await db.doc('phone_texts/sms_zzcc' + s + 'a').set(Object.assign({}, tbase, { leadId: id, phoneDigits: phone, direction: 'inbound', sentAtMs: Date.parse('2026-09-30T14:00:00Z'), body: 'ZZCC can you come Tuesday?' }));
    await db.doc('phone_texts/sms_zzcc' + s + 'b').set(Object.assign({}, tbase, { leadId: id, phoneDigits: phone, direction: 'outbound', sentAtMs: Date.parse('2026-09-30T14:05:00Z'), body: 'ZZCC yes, 10am <b>sharp</b>' }));
    await db.doc('phone_texts/sms_zzcc' + s + 'x').set(Object.assign({}, tbase, { leadId: other, phoneDigits: '5135559999', direction: 'inbound', sentAtMs: Date.parse('2026-09-30T15:00:00Z'), body: 'ZZCC not this customer' }));

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

    // Texts thread: this customer's texts, inbound left / outbound right,
    // escaped; never another customer's.
    const thread = page.locator('#callsList [data-pt-thread]');
    await expect(thread).toBeVisible();
    await expect(thread.locator('.pt-in .pt-body')).toHaveText('ZZCC can you come Tuesday?');
    await expect(thread.locator('.pt-out .pt-body')).toHaveText('ZZCC yes, 10am <b>sharp</b>');
    expect(await thread.locator('b').count(), 'message text is escaped, never HTML').toBe(0);
    await expect(page.locator('#callsList')).not.toContainText('not this customer');

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

    // ✓ Handled, right on the customer page.
    const handled = card.locator('[data-calls-act="pc-handled"]');
    await expect(handled).toHaveText('✓ Handled');
    await handled.click();
    await expect.poll(() => actions.some((x) => x.id === 'cube_zzcc' + s && x.action === 'handled'), { timeout: 10_000 }).toBe(true);
    await expect(card.locator('[data-calls-act="pc-unhandled"]')).toHaveText('Not handled');
    // Wrong customer → move to…: the number's other customer is offered first.
    const moveOpen = card.locator('[data-calls-act="pc-moveopen"]');
    await expect(moveOpen).toHaveText('Wrong customer → move to…');
    await moveOpen.click();
    const pick = card.locator('[data-calls-act="pc-move"][data-lead="' + other + '"]');
    await expect(pick).toHaveText('Move to ZZCC Other' + s, { timeout: 15_000 });
    const fit = await safeEvaluate(page, (sel) => {
      const c = document.querySelector(sel);
      const hs = [...c.querySelectorAll('[data-calls-act]')].map((b) => b.getBoundingClientRect().height);
      let worst = 0; c.querySelectorAll('*').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width) worst = Math.max(worst, r.right); });
      return { minH: Math.min(...hs), worst, vw: document.documentElement.clientWidth };
    }, '[data-call-card="phone:cube_zzcc' + s + '"]');
    expect(fit.minH, 'every call-card button is a 44px phone target').toBeGreaterThanOrEqual(44);
    expect(fit.worst, 'nothing wider than the phone').toBeLessThanOrEqual(fit.vw + 1);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: 'test-results/customer-call-move-phone.png' });
    await pick.click();
    await expect.poll(() => actions.some((x) => x.id === 'cube_zzcc' + s && x.action === 'move' && x.leadId === other), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('#callsList [data-calls-notice]')).toContainText('call to ZZCC Other' + s + ', with its notes and follow-up task');
  });
});
