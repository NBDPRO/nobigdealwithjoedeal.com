/**
 * tests/e2e/call-center-view.spec.js — the Call Center view (#/calls),
 * 2026-10-01. phone_calls is server-written, so the test seeds it with the
 * admin SDK exactly as the ingest/notes stages write it, and answers the
 * callCenterAction callable in the browser (its server logic is covered by
 * tests/call-center-action-2026-10-01.test.js).
 *
 *  - reachable from the nav; lazy bundle loads on goTo('calls')
 *  - "Needs attention" holds the right calls; tabs count; search by name,
 *    number and note text; another tenant's call never appears
 *  - Play streams the private recording into a blob: <audio>
 *  - ✓ Handled calls the action and drops the call off "Needs attention"
 *  - Attach sends the picked customer's id
 *  - phone width: 44px controls, no horizontal overflow
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
function silentWav() {
  const n = 1000, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
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

test.describe.serial('Call Center view @shard2', () => {
  test('list, filter, search, play, handle, attach', async ({ page }) => {
    test.setTimeout(150_000);
    const creds = requireTestUser();
    const actions = [];
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (_) {} });
    await page.route(/callCenterAction/, async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}').data || {}; } catch (_) {}
      actions.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { ok: true, leadId: body.leadId || null, phoneAdded: true, requeued: body.action === 'notpersonal' } }) });
    });
    await page.route(/cloudfunctions\.net|\.run\.app/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"result":{}}' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!window._user && !!window._user.uid && typeof window.goTo === 'function', null, { timeout: 30_000 });

    const s = Date.now();
    const leadId = await seedLead(page, admin().db, { firstName: 'ZZCV', lastName: 'Cust' + s, address: '1 Call Ct, Mason OH 45040', phone: '5135557' + String(s).slice(-3), stage: 'new', jobType: 'cash' });
    await safeEvaluate(page, async () => { if (typeof window._loadLeads === 'function') await window._loadLeads(); });
    const { db, bucket } = admin();
    const uid = (await db.doc('leads/' + leadId).get()).data().userId;
    const path = 'calls/' + uid + '/cube-acr/2026-09-30/cube_zzcv' + s + 'a.wav';
    await bucket.file(path).save(silentWav(), { contentType: 'audio/wav', resumable: false });
    const base = { userId: uid, companyId: uid, source: 'cube-acr', ymd: '2026-09-30', tags: [], alternateLeadIds: [], transcript: null, createdAtMs: s };
    const docs = {
      a: { leadId, bucket: 'customer', contactName: 'ZZCV Cust', phoneDigits: '5135557001', direction: 'inbound', startedAtMs: s - 1000, status: 'noted', storagePath: path,
           summary: 'Gutter leaking; Jo will send the quote.', promises: [{ who: 'jo', text: 'Send the gutter quote', due: '2026-10-02' }], transcript: 'zzcv transcript words' },
      b: { leadId: null, bucket: 'insurance', contactName: 'ZZCV Example Claims', phoneDigits: '8775550100', direction: 'outbound', startedAtMs: s - 2000, status: 'noted', storagePath: null, summary: 'Claim number given.', promises: [] },
      c: { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550142', direction: 'inbound', startedAtMs: s - 3000, status: 'stored', storagePath: null },
      p: { leadId: null, bucket: 'contact', contactName: 'ZZCV Misjudged', phoneDigits: '5135550188', direction: 'outbound', startedAtMs: s - 5000, status: 'personal', storagePath: null, summary: 'Personal call.', promises: [], driveFileId: 'drvzz' },
      d: { leadId, bucket: 'customer', contactName: 'ZZCV Cust', phoneDigits: '5135557001', direction: 'outbound', startedAtMs: s - 4000, status: 'noted', storagePath: null, summary: 'Quick check-in. Nothing owed.', promises: [] },
      // One unknown number, two open calls: one person, one card.
      e: { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550177', direction: 'inbound', startedAtMs: s - 6000, status: 'noted', storagePath: null, summary: 'ZZCV asked about siding.', promises: [] },
      f: { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550177', direction: 'inbound', startedAtMs: s - 7000, status: 'noted', storagePath: null, summary: 'ZZCV first call, left a message.', promises: [] },
    };
    for (const [k, v] of Object.entries(docs)) await db.doc('phone_calls/cube_zzcv' + s + k).set(Object.assign({}, base, v));
    // A day of texts (phone_text_days) with a promise Jo made.
    await db.doc('phone_text_days/txt_5135557' + String(s).slice(-3) + '_20261001').set({ userId: uid, companyId: uid, channel: 'text', status: 'noted', leadId, contactName: 'ZZCV Cust', phoneDigits: '5135557' + String(s).slice(-3), ymd: '2026-10-01', startedAtMs: s - 500, messageCount: 4, summary: 'ZZCV texted about the gutter quote.', promises: [{ who: 'jo', text: 'Text the quote tonight', due: null }], followUpDate: null, urgent: false });
    await db.doc('phone_calls/cube_zzcv' + s + 'x').set(Object.assign({}, base, { userId: 'someone-else', companyId: 'other-co', contactName: 'ZZCV Other Tenant', bucket: 'unknown', startedAtMs: s, status: 'noted' }));

    // Reachable from the nav; lazy bundle.
    expect(await safeEvaluate(page, () => !!window.NBDCallCenter)).toBe(false);
    await safeEvaluate(page, () => window.goTo('calls'));
    await safeWaitForFunction(page, () => !!window.NBDCallCenter && window.NBDCallCenter._state.loaded, null, { timeout: 20_000 });
    const card = (k) => page.locator('#view-calls .cc-card[data-call-id="cube_zzcv' + s + k + '"]');

    // Needs attention is grouped by PERSON (Jo, 2026-10-02): the customer's
    // call a and their day of texts share one card; b and c are one call
    // each; e + f are one unknown number; not d (nothing owed).
    const group = page.locator('#view-calls .cc-group[data-group="lead:' + leadId + '"]');
    await expect(group).toBeVisible();
    await expect(group.locator('.cc-group-call')).toHaveCount(2);
    await expect(group.locator('.pc-promise-jo')).toContainText(['Text the quote tonight', 'Send the gutter quote']);
    await expect(group.locator('[data-cc="handledgroup"]')).toHaveText('✓ Handled (all 2)');
    await expect(card('a'), 'call a is inside its person card').toHaveCount(0);
    await expect(card('b')).toBeVisible();
    await expect(card('c')).toBeVisible();
    await expect(card('d')).toHaveCount(0);
    await expect(page.locator('#view-calls')).not.toContainText('ZZCV Other Tenant');
    await expect(card('c')).toContainText('(513) 555-0142');
    const num = page.locator('#view-calls .cc-group[data-group="num:5135550177"]');
    await expect(num).toContainText('2 open');
    // The tab counts people: one per card on the list (other specs may seed
    // calls for this user too, so compare to what is on screen).
    const tabCount = async () => Number(await page.locator('#view-calls [data-cc="filter"][data-arg="attention"] .cc-count').textContent());
    const people = () => page.locator('#view-calls .cc-list > .cc-card').count();
    const before = await tabCount();
    expect(before, 'the tab counts people, not calls').toBe(await people());

    // ✓ Handled (all 2) clears both of that number's calls in one tap.
    await num.locator('[data-cc="handledgroup"]').click();
    await expect.poll(() => ['e', 'f'].every((k) => actions.some((x) => x.id === 'cube_zzcv' + s + k && x.action === 'handled')), { timeout: 10_000 }).toBe(true);
    await expect(num).toHaveCount(0);
    await expect.poll(tabCount, { message: 'one person fewer' }).toBe(before - 1);

    // A day of texts on its own tab.
    const textCard = page.locator('#view-calls .cc-card.cc-text[data-call-id="txt_5135557' + String(s).slice(-3) + '_20261001"]');
    await page.locator('#view-calls [data-cc="filter"][data-arg="texts"]').click();
    await expect(textCard).toBeVisible();
    await expect(textCard).toContainText('4 texts');
    await expect(textCard.locator('.pc-promise-jo')).toContainText('Text the quote tonight');
    await expect(card('a')).toHaveCount(0);
    await textCard.locator('[data-cc="handled"]').click();
    await expect.poll(() => actions.some((x) => /^txt_/.test(x.id) && x.action === 'handled'), { timeout: 10_000 }).toBe(true);
    await page.locator('#view-calls [data-cc="filter"][data-arg="attention"]').click();

    // Tabs.
    await page.locator('#view-calls [data-cc="filter"][data-arg="all"]').click();
    await expect(card('d')).toBeVisible();
    await page.locator('#view-calls [data-cc="filter"][data-arg="insurance"]').click();
    await expect(card('b')).toBeVisible();
    await expect(card('a')).toHaveCount(0);
    await page.locator('#view-calls [data-cc="filter"][data-arg="all"]').click();

    // Search: note text, number digits.
    await page.locator('#ccSearch').fill('transcript words');
    await expect(card('a')).toBeVisible();
    await expect(card('b')).toHaveCount(0);
    await page.locator('#ccSearch').fill('0142');
    await expect(card('c')).toBeVisible();
    await expect(card('a')).toHaveCount(0);
    await page.locator('#ccSearch').fill('');

    // Phone fit.
    const fit = await safeEvaluate(page, (id) => {
      const v = document.querySelector('#view-calls');
      const btn = document.querySelector('.cc-card[data-call-id="' + id + '"] [data-cc="play"]').getBoundingClientRect();
      const tab = document.querySelector('#view-calls .cc-tab').getBoundingClientRect();
      const search = document.getElementById('ccSearch').getBoundingClientRect();
      let worst = 0; v.querySelectorAll('*').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width) worst = Math.max(worst, r.right); });
      return { btn: btn.height, tab: tab.height, search: search.height, worst, vw: document.documentElement.clientWidth };
    }, 'cube_zzcv' + s + 'a');
    expect(fit.btn).toBeGreaterThanOrEqual(44);
    expect(fit.tab).toBeGreaterThanOrEqual(44);
    expect(fit.search).toBeGreaterThanOrEqual(44);
    expect(fit.worst, 'nothing wider than the phone').toBeLessThanOrEqual(fit.vw + 1);
    await page.screenshot({ path: 'test-results/call-center-view-phone.png' });

    // Play.
    await card('a').locator('[data-cc="play"]').click();
    await card('a').locator('audio').waitFor({ state: 'attached', timeout: 20_000 });
    expect(await card('a').locator('audio').getAttribute('src')).toMatch(/^blob:/);

    // Handled → leaves Needs attention.
    await card('a').locator('[data-cc="handled"]').click();
    await expect(card('a').locator('[data-cc="unhandled"]')).toBeVisible({ timeout: 10_000 });
    expect(actions.some((x) => x.id === 'cube_zzcv' + s + 'a' && x.action === 'handled')).toBe(true);
    await page.locator('#view-calls [data-cc="filter"][data-arg="attention"]').click();
    await expect(card('a')).toHaveCount(0);

    // A call the AI called personal: "It wasn't personal" sends notpersonal.
    await page.locator('#view-calls [data-cc="filter"][data-arg="all"]').click();
    await card('p').locator('[data-cc="notpersonal"]').click();
    await expect.poll(() => actions.some((x) => x.id === 'cube_zzcv' + s + 'p' && x.action === 'notpersonal'), { timeout: 10_000 }).toBe(true);
    await expect(card('p').locator('[data-cc-status]')).toContainText('notes will be redone');
    await page.locator('#view-calls [data-cc="filter"][data-arg="attention"]').click();

    // Attach the unknown number to the customer.
    await card('c').locator('[data-cc="attachopen"]').click();
    const input = page.locator('#ccAttach-cube_zzcv' + s + 'c');
    await input.fill('ZZCV Cust' + s + ' — 1 Call Ct, Mason OH 45040 #' + leadId);
    await card('c').locator('[data-cc="attach"]').click();
    await expect.poll(() => actions.some((x) => x.id === 'cube_zzcv' + s + 'c' && x.action === 'attach' && x.leadId === leadId), { timeout: 10_000 }).toBe(true);
    // Filed on a customer + nothing promised → leaves Needs attention.
    await expect(card('c')).toHaveCount(0);

    // Cleanup.
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'p', 'x']) await db.doc('phone_calls/cube_zzcv' + s + k).delete().catch(() => {});
    await db.doc('phone_text_days/txt_5135557' + String(s).slice(-3) + '_20261001').delete().catch(() => {});
    await bucket.file(path).delete().catch(() => {});
  });
});
