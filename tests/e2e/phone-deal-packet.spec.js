// tests/e2e/phone-deal-packet.spec.js — "Full packet" or "Paperwork only"
// when Jo sends a deal to the homeowner (2026-10-04). The installed iPhone
// app at 390 × 844 (same harness as phone-close-flow.spec.js).
//
//   1. Finish shows the choice, Full packet pressed, with the lead's
//      inspection photos; Jo leaves one out and sends. The deal (Firestore)
//      carries packet 'full' + the photo IDs — never a URL — and the deal
//      page shows the photos, each served at /deal/<token>/photo/<n>, with no
//      Storage download URL in the page.
//   2. Paperwork only: the deal carries packet 'paperwork' and no photo IDs;
//      the deal page has no photos section.
//   3. The choice is remembered (userSettings/{uid}.dealPacket) — a reopened
//      builder, with the local copy wiped, comes back on Paperwork only.
//
// Nothing is sent from the server: the createDealAcceptToken callable and the
// /deal/<token> page + photos are answered in the browser (the functions
// emulator is not started). The page is served through the REAL server rule
// (functions/deal-packet-logic.js injectPhotos) and each photo through the
// REAL re-encode (functions/photo-reencode.js), and navigator.share is
// recorded, not shown.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const ROOT = path.join(__dirname, '..', '..');
const DP = require(path.join(ROOT, 'functions', 'deal-packet-logic.js'));

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const SHOTS = process.env.NBD_E2E_SHOTS || '';

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

const DEAL_ROOM_JS = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'deal-room.js'), 'utf8');
// A 1×1 JPEG for the rep-side thumbnails (their fake download URLs).
const THUMB = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

async function photoBytes() {
  // The server path: a camera JPEG (with EXIF) re-encoded by photo-reencode.js.
  const sharp = require(path.join(ROOT, 'functions', 'node_modules', 'sharp'));
  const { reencodePhoto } = require(path.join(ROOT, 'functions', 'photo-reencode.js'));
  const src = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#8a5a2b' } })
    .jpeg().withExif({ IFD0: { Make: 'E2ECAM' } }).toBuffer();
  return reencodePhoto(src, 'jpeg', { maxEdge: 1600 });
}

async function signIn(page, token) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/renderPdf**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"status":"INTERNAL","message":"mocked"}}' }));
  await page.route('**/createDealAcceptToken**', (r) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    return r.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ result: { token, acceptUrl: 'http://127.0.0.1:5000/deal/' + token, expiresAt: Date.now() + 864e5 } }) });
  });
  // The seeded photos' (fake) download URLs — rep-side thumbnails only.
  await page.route('**/e2e-packet-photos/**', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: THUMB }));
  await page.addInitScript(() => {
    try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ }
    window.__shared = [];
    navigator.share = (d) => { window.__shared.push(d); return Promise.resolve(); };
  });
  await loginAs(page, creds);
  await safeWaitForFunction(page, () => !!(window._user && window._user.uid), { timeout: 20_000 });
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

// A cash lead with three inspection photos (own, on this lead).
async function seedLeadWithPhotos(page) {
  return safeEvaluate(page, async () => {
    const stamp = Date.now();
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const id = (await fsMod.addDoc(fsMod.collection(db, 'leads'), {
      firstName: '[E2E] Packet', lastName: 'Packet' + stamp,
      address: stamp + ' Packet Way, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7), email: 'e2e-packet-' + stamp + '@nbd.test',
      stage: 'new', jobType: 'cash', e2eTestData: true,
      userId: uid, companyId, createdAt: fsMod.serverTimestamp(),
    })).id;
    const photoIds = [];
    for (let i = 0; i < 3; i++) {
      const p = 'photos/' + uid + '/' + id + '/' + stamp + '_' + i + '.jpg';
      const ref = await fsMod.addDoc(fsMod.collection(db, 'photos'), {
        userId: uid, companyId, leadId: id, storagePath: p,
        // The shape a real upload has: a Storage download-token URL. It must
        // never reach the homeowner.
        url: 'http://127.0.0.1:5000/e2e-packet-photos/' + i + '.jpg?alt=media&token=e2e-secret-' + i,
        category: 'Damage', phase: 'Before', e2eTestData: true,
        createdAt: fsMod.serverTimestamp(),
      });
      photoIds.push(ref.id);
    }
    if (typeof window.loadLeads === 'function') await window.loadLeads();
    for (let i = 0; i < 75 && !(window._leads || []).some((l) => l.id === id); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return { id, photoIds };
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
async function priceRoof(page) {
  await page.locator('#v2rawSqft').fill('2400');
  await page.locator('#v2rawSqft').dispatchEvent('input');
  await jumpTo(page, 'Package');
  await page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]').tap();
  await expect(page.locator('#estV2Modal .v3-pkg .v3-tier').first()).toBeVisible();
}
async function dealDoc(page) {
  return safeEvaluate(page, async () => {
    const d = (window.CloseBoard.getDeals() || [])[0];
    if (!d) return null;
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    for (let i = 0; i < 40; i++) {
      const s = await fsMod.getDoc(fsMod.doc(window.db || window._db, 'deal_rooms', d.id));
      const v = s.exists() ? s.data() : null;
      if (v && v.packet === d.packet) return v;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  });
}

test.describe('phone deal packet: Full packet vs Paperwork only @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('full packet shows the inspection photos via the deal link; paperwork shows none; the choice is remembered', async ({ page, context }) => {
    test.setTimeout(240_000);
    const token = 'TOKE2EPACKET' + String(Date.now()).slice(-8);
    await signIn(page, token);
    const lead = await seedLeadWithPhotos(page);
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    // Start from the default, whatever an earlier run remembered.
    await safeEvaluate(page, async () => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      await fsMod.setDoc(fsMod.doc(window.db || window._db, 'userSettings', window._user.uid), { dealPacket: 'full' }, { merge: true });
    });

    // /deal/<token> — what getDealRoom serves: the page the app generated,
    // through the server's own photo rule; and /deal/<token>/photo/<n>.
    const served = { html: '' };
    const bytes = await photoBytes();
    await context.route('**/deal/' + token + '/photo/*', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'cache-control': 'private, no-store' }, body: bytes }));
    await context.route('**/deal/' + token, async (r) => {
      const deal = await page.evaluate(() => window.CloseBoard.getDeals()[0]);
      const html = await page.evaluate((d) => window.CloseBoard.generatePageHTML(d), deal);
      const items = DP.packetPhotoIds(deal).map((id, i) => ({ i }));
      served.html = DP.injectPhotos(html, { token, packet: deal.packet, items });
      await r.fulfill({ status: 200, contentType: 'text/html', body: served.html });
    });
    await context.route('https://nobigdealwithjoedeal.com/pro/deal-room.js**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: DEAL_ROOM_JS }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

    await openWizard(page, { leadId: lead.id });
    await priceRoof(page);
    await jumpTo(page, 'Finish');

    await test.step('Finish: Full packet is the default, with the lead\'s photos', async () => {
      await expect(page.locator('#v2packetFull')).toBeVisible();
      await expect(page.locator('#v2packetFull')).toHaveClass(/active/);
      await expect(page.locator('#v2packetPaper')).not.toHaveClass(/active/);
      for (const sel of ['#v2packetFull', '#v2packetPaper']) {
        expect((await page.locator(sel).boundingBox()).height, sel + ' is thumb-sized').toBeGreaterThanOrEqual(44);
      }
      await expect(page.locator('#v2packetPhotos .v2-packet-ph')).toHaveCount(3, { timeout: 15_000 });
      await expect(page.locator('#v2packetHint')).toContainText('3 inspection photos');
      // Jo leaves the third one out.
      await page.locator('#v2packetPhotos .v2-packet-ph').nth(2).tap();
      await expect(page.locator('#v2packetPhotos .v2-packet-ph.off')).toHaveCount(1);
      await expect(page.locator('#v2packetHint')).toContainText('2 inspection photos');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'packet-finish-full-390.png') });
    });

    let fullIds = [];
    await test.step('send the full packet: deal = packet full + 2 photo IDs, no URL', async () => {
      await page.locator('#v2sendHoBtn').tap();
      await expect(page.locator('#v2shareStatus')).toHaveText(/Link ready/, { timeout: 30_000 });
      const deal = await page.evaluate(() => window.CloseBoard.getDeals()[0]);
      expect(deal.packet).toBe('full');
      expect(deal.packetPhotoIds.length, 'two photos (one left out)').toBe(2);
      expect(lead.photoIds, 'IDs of the lead\'s own photos').toEqual(expect.arrayContaining(deal.packetPhotoIds));
      fullIds = deal.packetPhotoIds;
      const remote = await dealDoc(page);
      expect(remote && remote.packet, 'packet on the Firestore deal doc').toBe('full');
      expect(JSON.stringify(remote.packetPhotoIds)).toBe(JSON.stringify(fullIds));
      expect(JSON.stringify(remote.packetPhotoIds) + JSON.stringify(remote.scopeSummary || []), 'no Storage URL on the deal').not.toMatch(/alt=media|token=/);
    });

    await test.step('the deal page (390 × 844) shows the photos through the link', async () => {
      const home = await context.newPage();
      await home.setViewportSize({ width: 390, height: 844 });
      await home.goto('http://127.0.0.1:5000/deal/' + token);
      await expect(home.locator('body[data-packet="full"]')).toBeAttached();
      const imgs = home.locator('.deal-photo img');
      await expect(imgs).toHaveCount(2);
      await imgs.first().scrollIntoViewIfNeeded();
      await expect(imgs.first()).toBeVisible();
      await expect.poll(() => imgs.evaluateAll((els) => els.filter((e) => e.complete && e.naturalWidth > 0).length), { timeout: 15_000 }).toBe(2);
      const srcs = await imgs.evaluateAll((els) => els.map((e) => e.getAttribute('src')));
      expect(srcs).toEqual(['/deal/' + token + '/photo/0', '/deal/' + token + '/photo/1']);
      expect(served.html, 'no Storage download URL in the page').not.toMatch(/alt=media|token=/);
      await expect(home.locator('text=What\'s Included')).toBeVisible();
      await expect(home.locator('text=Why Homeowners Choose Us')).toBeVisible();
      const overflow = await home.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, 'no sideways scroll at 390').toBeLessThanOrEqual(0);
      if (SHOTS) {
        await home.locator('#dealPhotos').scrollIntoViewIfNeeded();
        await home.screenshot({ path: path.join(SHOTS, 'packet-deal-full-390.png') });
      }
      await home.close();
    });

    await test.step('Paperwork only: no photo IDs on the deal, no photos on the page', async () => {
      await page.locator('#v2packetPaper').tap();
      await expect(page.locator('#v2packetPaper')).toHaveClass(/active/);
      await expect(page.locator('#v2packetPhotos')).toBeHidden();
      await expect(page.locator('#v2packetHint')).toHaveText(/no photos/);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'packet-finish-paperwork-390.png') });
      await page.locator('#v2sendHoBtn').tap();
      await expect.poll(async () => (await page.evaluate(() => window.__shared.length)), { timeout: 30_000 }).toBe(2);
      const deal = await page.evaluate(() => window.CloseBoard.getDeals()[0]);
      expect(deal.packet).toBe('paperwork');
      expect(deal.packetPhotoIds).toEqual([]);
      const remote = await dealDoc(page);
      expect(remote && remote.packet).toBe('paperwork');

      const home = await context.newPage();
      await home.setViewportSize({ width: 390, height: 844 });
      await home.goto('http://127.0.0.1:5000/deal/' + token);
      await expect(home.locator('body[data-packet="paperwork"]')).toBeAttached();
      await expect(home.locator('#sigCanvas'), 'terms + signature still there').toBeVisible();
      await expect(home.locator('.deal-photo')).toHaveCount(0);
      await expect(home.locator('img')).toHaveCount(0);
      await expect(home.locator('text=What\'s Included')).toHaveCount(0);
      if (SHOTS) await home.screenshot({ path: path.join(SHOTS, 'packet-deal-paperwork-390.png') });
      await home.close();
    });

    await test.step('remembered: userSettings says paperwork; a reopened builder starts there', async () => {
      const saved = await safeEvaluate(page, async () => {
        const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const s = await fsMod.getDoc(fsMod.doc(window.db || window._db, 'userSettings', window._user.uid));
        return s.exists() ? s.data().dealPacket : null;
      });
      expect(saved).toBe('paperwork');
      // Forget the local copies — only the server copy can answer now.
      await page.evaluate(() => {
        try { localStorage.removeItem('dealPacketChoice:' + window._user.uid); } catch (_) {}
        window.NBDDealPacket._reset();
        window.closeEstimateV2Builder();
      });
      await openWizard(page, { leadId: lead.id });
      await jumpTo(page, 'Finish');
      await expect(page.locator('#v2packetPaper')).toHaveClass(/active/, { timeout: 15_000 });
      await expect(page.locator('#v2packetFull')).not.toHaveClass(/active/);
    });
  });
});
