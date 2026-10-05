// tests/e2e/phone-inperson-sign.spec.js — an in-person signature moves the card.
//
// Jo, 2026-10-03: remote, e-sign and deal-room signings reach the job spine
// on the server; the in-person signing on the rep's phone was saved only from
// the browser, so the card stayed put and no deposit invoice was drafted.
// document-generator.js now calls recordInPersonSignature after it saves the
// signed contract.
//
// On the iPhone viewport (390x844, the installed app's standalone rules
// forced), a real generated contract is signed in the rep's doc viewer and
// saved. The callable's network call is answered by the REAL server logic
// (functions/in-person-signing.js handleInPersonSignature) run in this test
// process against the Firestore emulator — the client SDK points at the
// production functions URL, so the request is caught with page.route and
// never leaves the machine. The test then reads the emulator: the lead is at
// Contract Signed, the spine marker exists, and one DRAFT deposit invoice
// was made (never sent).
//
// The second case makes the call fail: the contract is still saved signed,
// the card does not move, and the rep sees the "move it by hand" toast.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _db = null;
function adb() {
  if (_db) return _db;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _db = getFirestore();
  return _db;
}
// The server logic, with this process's admin SDK (the emulator). The logic
// module needs no functions/node_modules — this CI job does not install them.
function serverHandle(auth, data) {
  const IPS = require(path.join(__dirname, '..', '..', 'functions', 'in-person-signing-logic.js'));
  const { FieldValue } = require('firebase-admin/firestore');
  const quiet = { info() {}, warn() {}, error() {} };
  return IPS.handleInPersonSignature(adb(), auth, data, { FieldValue, logger: quiet });
}
// The callable's caller, from the Bearer ID token the client SDK sends
// (emulator tokens are unsigned; the payload is all we need).
function callerOf(req) {
  const h = req.headers()['authorization'] || '';
  const tok = h.replace(/^Bearer\s+/i, '').split('.')[1] || '';
  const claims = JSON.parse(Buffer.from(tok.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') || '{}');
  return { uid: claims.user_id || claims.sub, token: claims };
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

// A finger stroke across a pad inside the document frame.
async function drawSignature(p, f, frameEl, role) {
  await f.evaluate((r) => document.querySelector(`[data-nbd-sig="${r}"]`).scrollIntoView({ block: 'center' }), role);
  const fr = await frameEl.boundingBox();
  const c = await f.evaluate((r) => { const b = document.querySelector(`[data-nbd-sig="${r}"] canvas`).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; }, role);
  await p.mouse.move(fr.x + c.x + 20, fr.y + c.y + 40);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(fr.x + c.x + 20 + i * ((c.w - 40) / 12), fr.y + c.y + 40 + (i % 3) * 12);
  await p.mouse.up();
}

async function seedLead(uid, co, tag) {
  const s = Date.now();
  const estRef = adb().collection('estimates').doc();
  const leadRef = adb().collection('leads').doc();
  await estRef.set({ leadId: leadRef.id, userId: uid, companyId: co, priceMode: 'per-sq', prices: { good: 12000, better: 15000, best: 18000 }, selectedTier: 'better', grandTotal: 15000, taxRate: 0, mode: 'cash', e2eTestData: true, createdAt: new Date(s) });
  await leadRef.set({ userId: uid, companyId: co, firstName: 'ZZSign', lastName: tag + s, phone: '(513) 555-0177', email: 'delivered@resend.dev',
    address: '118 Maple Ridge Ct, Loveland, OH 45140', stage: 'estimate_sent_cash', stageRole: 'active', jobType: 'cash',
    primaryEstimateId: estRef.id, e2eTestData: true, deleted: false, createdAt: new Date(s) });
  return leadRef.id;
}

// Generate the contract for the lead in the doc viewer, sign both pads, Save.
async function signInPerson(page, leadId) {
  await safeEvaluate(page, async (id) => {
    await window.ScriptLoader.loadBundle('docgen');
    for (let i = 0; i < 100 && !(window.NBDDocGen && window.NBDDocGen.generate); i++) await new Promise((r) => setTimeout(r, 100));
    window.__toasts = [];
    const real = window.showToast;
    window.showToast = (m, k) => { window.__toasts.push([String(m), k]); if (typeof real === 'function') try { real(m, k); } catch (_) {} };
    window.NBDDocGen.generate('contract', {
      leadId: id, homeownerName: 'ZZSign Phone', address: '118 Maple Ridge Ct, Loveland, OH 45140', phone: '(513) 555-0177',
      email: 'delivered@resend.dev', contractPrice: '$15,000.00', startDate: '2026-10-20',
      lineItems: [{ description: 'Tear-off and replace architectural shingles', qty: 30, unit: 'SQ', unitPrice: 500 }],
      signers: [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'contractor', label: 'Contractor', required: true }],
    });
  }, leadId);
  const frameEl = await page.waitForSelector('#nbdv-iframe', { timeout: 30_000 });
  const f = await frameEl.contentFrame();
  await f.waitForFunction(() => document.querySelector('.document-container') && window.__NBD_LOADED && window.__NBD_LOADED['signature-widget'], null, { timeout: 20_000 });
  await drawSignature(page, f, frameEl, 'homeowner');
  await drawSignature(page, f, frameEl, 'contractor');
  await page.locator('.nbdv-action-btn', { hasText: 'Save to Customer' }).tap();
}

test.describe('phone: in-person signing moves the card @shard2', () => {
  test.skip(!creds, 'needs PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD');
  test.use(IPHONE);

  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('nbd-onboarding-complete', '1');
        localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
      } catch (_) {}
    });
  });

  test('sign in person on the phone → Contract Signed + one draft deposit invoice, nothing sent', async ({ page }) => {
    test.setTimeout(180_000);
    const calls = []; const results = [];
    await page.route(/recordInPersonSignature/, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      let data = {};
      try { data = JSON.parse(req.postData() || '{}').data || {}; } catch (_) {}
      calls.push(data);
      try {
        const result = await serverHandle(callerOf(req), data);
        results.push(result);
        await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ result }) });
      } catch (e) {
        await route.fulfill({ status: 400, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: { status: 'FAILED_PRECONDITION', message: String(e && e.message) } }) });
      }
    });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.ScriptLoader && window.NBDDocViewer), null, { timeout: 30_000 });
    await page.waitForSelector('#nbd-loader', { state: 'detached', timeout: 20_000 }).catch(() => {});
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const leadId = await seedLead(who.uid, who.co, 'Moves');
    expect(await forceStandalone(page)).toBeGreaterThan(200);

    await signInPerson(page, leadId);

    await expect.poll(() => calls.length, { message: 'the doc viewer called recordInPersonSignature', timeout: 30_000 }).toBeGreaterThan(0);
    expect(calls[0].leadId).toBe(leadId);
    const docSnap = await adb().doc(`leads/${leadId}/documents/${calls[0].docId}`).get();
    expect(docSnap.exists, 'the call names the saved document').toBe(true);
    expect(docSnap.data().status, 'the contract was saved signed BEFORE the call').toBe('signed');

    const leadOf = async () => (await adb().doc('leads/' + leadId).get()).data() || {};
    await expect.poll(async () => (await leadOf()).stage, { message: 'the card moved to Contract Signed', timeout: 20_000 }).toBe('contract_signed');
    expect((await leadOf()).contractFiledAt, 'Contract Filed was stamped too').toBeTruthy();
    const marker = await adb().doc(`job_events/${leadId}__contract_signed__doc_${calls[0].docId}`).get();
    expect(marker.exists, 'through the job spine (idempotent marker)').toBe(true);
    // The draft is made right after the stage move, in the same server call.
    await expect.poll(() => results.length, { message: 'the server call finished', timeout: 20_000 }).toBeGreaterThan(0);
    const invs = await adb().collection('invoices').where('leadId', '==', leadId).get();
    expect(invs.size, 'one deposit invoice drafted — server said ' + JSON.stringify(results[0])).toBe(1);
    expect(results[0].depositDraft && results[0].depositDraft.created, 'the callable reports the draft').toBe(true);
    const inv = invs.docs[0].data();
    expect(inv.status, '…as a DRAFT, never sent').toBe('draft');
    expect(inv.sentAt || null).toBeNull();
    await expect.poll(() => safeEvaluate(page, () => (window.__toasts || []).map((t) => t[0]).join(' | ')), { timeout: 10_000 }).toMatch(/card moved to Contract Signed/);

    // The same call again (a retry, a double tap, a re-finalize) is the same
    // document → a duplicate: no second move, no second invoice.
    const again = await serverHandle({ uid: who.uid, token: { user_id: who.uid } }, calls[0]);
    expect(again.duplicate, 'replayed call is a duplicate').toBe(true);
    expect(again.moved).toBe(false);
    expect((await adb().collection('invoices').where('leadId', '==', leadId).get()).size, 'still one invoice').toBe(1);
  });

  test('the call fails → the contract is still saved, the card stays, the rep is told', async ({ page }) => {
    test.setTimeout(180_000);
    let hits = 0;
    await page.route(/recordInPersonSignature/, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      hits++;
      await route.fulfill({ status: 500, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: { status: 'INTERNAL', message: 'boom' } }) });
    });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.ScriptLoader && window.NBDDocViewer), null, { timeout: 30_000 });
    await page.waitForSelector('#nbd-loader', { state: 'detached', timeout: 20_000 }).catch(() => {});
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const leadId = await seedLead(who.uid, who.co, 'Fails');
    expect(await forceStandalone(page)).toBeGreaterThan(200);

    await signInPerson(page, leadId);
    await expect.poll(() => hits, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(() => safeEvaluate(page, () => (window.__toasts || []).map((t) => t[0]).join(' | ')), { timeout: 10_000 }).toMatch(/did not move/);
    const docs = await adb().collection(`leads/${leadId}/documents`).get();
    expect(docs.docs.some((d) => d.data().status === 'signed'), 'the signed contract is saved regardless').toBe(true);
    expect(((await adb().doc('leads/' + leadId).get()).data() || {}).stage, 'the card did not move').toBe('estimate_sent_cash');
    await expect(page.locator('#nbdv-iframe'), 'the viewer is still open — signing was not blocked').toBeVisible();
  });
});
