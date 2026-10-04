// tests/e2e/phone-field-photos.spec.js — field photos on the installed
// iPhone app at 390 × 844, standalone rules forced on (2026-10-04).
//
//   1. Burst capture: the CRM camera stays open between shots — a running
//      count and the last-shot thumbnail, no tag sheet, no camera restart —
//      and every shot lands as a /photos doc stamped with the phase from the
//      lead's stage (Installing → During), the session's GPS fix and
//      on-site. The done sheet links to Photo Review for tagging.
//   2. The photo editor in daylight: every tap target 44 px or larger, every
//      label 13 px or larger, at phone width; Save Tags still saves (now
//      through the durable queue).
//
// The camera is a fake stream (a painted canvas through captureStream —
// getUserMedia is replaced before any page script runs), geolocation is the
// browser context's, and the classifier callable is answered in the
// browser: nothing here reaches a paid API.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const LAT = 39.2001, LNG = -84.2502;
const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  geolocation: { latitude: LAT + 0.0001, longitude: LNG + 0.0001, accuracy: 8 },
  permissions: ['geolocation'],
};

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

async function signIn(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  // The classifier, stubbed: never a paid call from a test.
  await page.route('**/analyzePhotoVision**', (r) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    return r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{"result":{"pending":true}}' });
  });
  await page.addInitScript(() => {
    try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ }
    // A fake rear camera: a moving painted canvas, counted so the test can
    // prove burst never restarts the stream.
    window.__gum = 0;
    const fake = async () => {
      window.__gum++;
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      let n = 0;
      setInterval(() => { g.fillStyle = 'hsl(' + ((n += 7) % 360) + ',70%,45%)'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff'; g.fillRect(n % 600, 200, 40, 40); }, 50);
      g.fillStyle = '#8a5'; g.fillRect(0, 0, 640, 480);
      return c.captureStream(15);
    };
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    navigator.mediaDevices.getUserMedia = fake;
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

async function seedLead(page, extra) {
  return safeEvaluate(page, async (x) => {
    const stamp = Date.now();
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const lead = Object.assign({
      firstName: '[E2E] Field', lastName: 'Photos' + stamp,
      address: stamp + ' Ridge Rd, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7),
      stage: 'new', e2eTestData: true, userId: uid, companyId, createdAt: fsMod.serverTimestamp(),
    }, x || {});
    const id = (await fsMod.addDoc(fsMod.collection(db, 'leads'), lead)).id;
    if (typeof window.loadLeads === 'function') await window.loadLeads();
    for (let i = 0; i < 75 && !(window._leads || []).some((l) => l.id === id); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return id;
  }, extra || null);
}

async function photosFor(page, leadId) {
  return safeEvaluate(page, async (id) => {
    const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'photos'), fsMod.where('leadId', '==', id), fsMod.where('userId', '==', uid)));
    return snap.docs.map((d) => {
      const p = d.data();
      return { id: d.id, phase: p.phase || null, phaseSource: p.phaseSource || null, geo: p.geoLocation || null, onSite: p.onSite, capturedAt: p.capturedAt || null, tags: p.tags || [] };
    });
  }, leadId);
}

async function smallTargets(page, rootSel, selectors) {
  return page.evaluate(({ rootSel, selectors }) => {
    const root = document.querySelector(rootSel);
    if (!root) return ['no root ' + rootSel];
    const bad = [];
    root.querySelectorAll(selectors).forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // not rendered (collapsed strip, closed flyout)
      if (r.width < 43.5 || r.height < 43.5) {
        bad.push((el.className || el.tagName) + ' [' + (el.textContent || el.getAttribute('aria-label') || el.dataset.act || '').trim().slice(0, 20) + '] ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
    });
    return bad;
  }, { rootSel, selectors });
}

async function smallText(page, rootSel) {
  return page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return ['no root'];
    const bad = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el || el.closest('svg, option, script, style')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < 12.95) bad.push('"' + t.slice(0, 24) + '" ' + fs + 'px (' + (el.className || el.tagName) + ')');
    }
    return bad;
  }, rootSel);
}

test.describe('phone field photos: burst capture + daylight editor @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('burst: the camera stays open, every shot is saved and stamped, tagging is offered after', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    const leadId = await seedLead(page, { stage: 'install_in_progress', lat: LAT, lng: LNG });

    await safeEvaluate(page, async (id) => {
      try { localStorage.removeItem('photoEngineCaptureMode'); } catch (e) { /* ignore */ }
      await window.ScriptLoader.loadBundle('photos');
      window.PhotoEngine.openCamera(id);
    }, leadId);

    const modal = page.locator('#photo-camera-modal');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#mode-btn'), 'burst is the default').toHaveText(/burst/i);
    await expect(page.locator('#cam-hint')).toBeVisible();
    await safeWaitForFunction(page, () => {
      const v = document.getElementById('camera-video');
      return !!(v && v.videoWidth > 0);
    }, { timeout: 15_000 });

    const before = await page.locator('#cam-count').innerText();
    for (let i = 0; i < 3; i++) {
      await page.locator('#capture-btn').tap();
      await page.waitForTimeout(350);
    }
    await expect(page.locator('#cam-count'), 'a running count').toHaveText(String(Number(before) + 3));
    await expect(modal, 'the camera never closed').toBeVisible();
    await expect(page.locator('#photo-preview-modal'), 'no tag sheet after a shot').toHaveCount(0);
    await expect(page.locator('#cam-thumb-slot img.pe-cam-thumb'), 'the last-shot thumbnail').toBeVisible();
    expect(await page.evaluate(() => window.__gum), 'the camera stream was opened once, never restarted').toBe(1);

    const tiny = await smallTargets(page, '#photo-camera-modal', 'button');
    expect(tiny, 'camera controls are 44px+').toEqual([]);

    // All three reach Firestore, stamped.
    await expect.poll(async () => (await photosFor(page, leadId)).length, { timeout: 60_000 }).toBe(3);
    const docs = await photosFor(page, leadId);
    for (const d of docs) {
      expect(d.phase, 'phase from the lead\'s stage (Installing → During)').toBe('During');
      expect(d.phaseSource).toBe('stage');
      expect(d.geo && Math.abs(d.geo.lat - (LAT + 0.0001)) < 1e-6, 'the session GPS fix').toBe(true);
      expect(d.onSite, 'within 75 m of the lead').toBe(true);
      expect(typeof d.capturedAt).toBe('number');
      expect(d.tags, 'no tags asked for at capture').toEqual([]);
    }

    // Done → the tagging hand-off.
    await page.locator('#cam-back-btn').tap();
    await expect(modal).toHaveCount(0);
    const sheet = page.locator('#pe-burst-done');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.pe-burst-done-title')).toHaveText('3 photos saved');
    const href = await sheet.locator('[data-burst="review"]').getAttribute('href');
    expect(href).toContain('photo-review');
    expect(href).toContain(encodeURIComponent(leadId));
    expect(await smallTargets(page, '#pe-burst-done', 'button, a')).toEqual([]);
  });

  test('editor: 44px targets and 13px labels at 390 wide; Save Tags still saves', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const leadId = await seedLead(page, { stage: 'inspected', lat: LAT, lng: LNG });
    const photoIds = await safeEvaluate(page, async (id) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const uid = (window._auth || window.auth).currentUser.uid;
      const out = [];
      for (const f of ['joe-hero.jpg', 'joe-hero.webp']) {
        const ref = await fsMod.addDoc(fsMod.collection(db, 'photos'), {
          leadId: id, userId: uid, url: location.origin + '/assets/images/' + f, phase: 'Before', createdAt: new Date(),
        });
        out.push(ref.id);
      }
      return out;
    }, leadId);

    await page.goto('/pro/customer.html?id=' + leadId);
    await safeWaitForFunction(page, () => !!(window.NBDPhotoEditor && window._user), { timeout: 30_000 });
    expect(await forceStandalone(page)).toBeGreaterThan(0);
    await safeEvaluate(page, ({ ids, lead }) => {
      const url = (f) => location.origin + '/assets/images/' + f;
      const all = [{ id: ids[0], url: url('joe-hero.jpg'), phase: 'Before' }, { id: ids[1], url: url('joe-hero.webp'), phase: 'Before' }];
      window.NBDPhotoEditor.open(all[0].url, ids[0], lead, all[0], all);
    }, { ids: photoIds, lead: leadId });
    const ed = page.locator('.nbd-editor-overlay');
    await expect(ed).toBeVisible({ timeout: 15_000 });
    await expect(ed).toHaveClass(/nbd-daylight/);
    await page.waitForTimeout(600);

    const TARGETS = 'button, select, input[type="range"], .nbd-tool-btn, .nbd-swatch, .nbd-color-picker-btn, .nbd-severity-pill, .nbd-phase-tab, .nbd-strip-thumb, .nbd-tag-remove, .nbd-ann-item-delete, label.pex-dflex-aicenter-gap4px';
    expect(await smallTargets(page, '.nbd-editor-overlay', TARGETS), 'editor tap targets are 44px+ (closed panel)').toEqual([]);
    expect(await smallText(page, '.nbd-editor-overlay'), 'editor text is 13px+ (closed panel)').toEqual([]);

    // The damage-tag drawer.
    await page.locator('.nbd-editor-overlay [data-act="toggle-panel"]').evaluate((b) => b.click());
    await expect(page.locator('#nbd-panel.open')).toBeVisible();
    await page.waitForTimeout(400);
    expect(await smallTargets(page, '#nbd-panel', TARGETS), 'drawer tap targets are 44px+').toEqual([]);
    expect(await smallText(page, '#nbd-panel'), 'drawer labels are 13px+').toEqual([]);

    // Default stroke 6px.
    const width = await page.locator('.nbd-editor-overlay [data-prop="lineWidth"]').inputValue();
    expect(Number(width), 'default stroke').toBeGreaterThanOrEqual(6);

    // No inline style attributes inside the editor.
    const styled = await page.evaluate(() => Array.from(document.querySelectorAll('.nbd-editor-overlay [style]'))
      .filter((el) => !el.matches('.nbd-canvas-wrapper, #nbd-custom-color, .nbd-minimap-viewport, .nbd-canvas-wrapper canvas'))
      .map((el) => el.className + ':' + el.getAttribute('style')));
    expect(styled, 'only runtime geometry/colour goes through the CSSOM').toEqual([]);

    // Save Tags → through the queue → the doc.
    await page.locator('.nbd-editor-overlay .nbd-phase-tab[data-phase="After"]').tap();
    await page.locator('.nbd-editor-overlay [data-act="save-tags"]').evaluate((b) => b.click());
    await expect.poll(async () => safeEvaluate(page, async (pid) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const d = (await fsMod.getDoc(fsMod.doc(window.db || window._db, 'photos', pid))).data() || {};
      return d.phase + '/' + (Array.isArray(d.annotations) ? 'ann' : 'none');
    }, photoIds[0]), { timeout: 30_000 }).toBe('After/ann');
  });
});
