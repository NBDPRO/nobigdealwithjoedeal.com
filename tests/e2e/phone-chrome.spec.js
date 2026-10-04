// tests/e2e/phone-chrome.spec.js — the customer page's fixed chrome must
// yield to what the rep is actually doing, on a phone.
//
// Phone audit 2026-09-25 (Jo runs NBD Pro from an Android at ~412px). On
// /pro/customer the bottom CALL / TEXT / EMAIL / TASK bar sat at z-index
// 99985, above every overlay on the page (all at --z-overlay 10000+). It
// painted over the document viewer's Save / Email / Print / Download PDF,
// the photo editor's tool strip, the estimate sheet's Edit / Archive /
// Close and every toast — and a tap on "Save to Customer" or "Edit" landed
// on the bar's tel: link and dialled the homeowner. The three field-tool
// FABs stood in a 166px column over the right edge of every panel, the
// Edit Photo sheet (z 9000) sat UNDER them, the editor's Save was
// off-screen, the upload modal buried its Upload button under the batch,
// and the pinned jump-nav left a see-through notch and landed jumps 140px
// down. Follow-ups (review:chrome): the Voice Intel error toast still sat on
// the bar, and toasts landed on the in-flight upload indicator's "View
// details" (phone and desktop) — both now stack clear.
//
// Every assertion here is BEHAVIOUR: document.elementFromPoint at a
// control's centre must return that control, and taps are real taps.
// A class check ('.open') is what kept the pipeline menus "green" for
// months while nothing could be tapped.
//
// One login per describe (serial, shared page); the phone tests walk 412
// and 360 (PHONE_WIDTHS). Each describe seeds one lead + estimate + two
// photos and deletes them by tag in afterAll (fixtures/seeded-run.js).
// Tagged @audit so the audit shard of the authed emulator job runs it.
// Local run:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//     PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//     npx playwright test --config=playwright.config.js phone-chrome.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

// Jo's Android, then the small-Android floor of the standing phone rule.
// 2026-09-25 follow-up: the toast, upload, warranty, launcher, dictation,
// Edit Photo, editor and upload-modal tests ran at 412 only while the
// findings they pin were measured at 412 AND 360; each now walks both.
const PHONE_WIDTHS = [412, 360];

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
// 1x1 PNG — enough for the upload modal to queue and preview a file.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// A fake microphone, so the dictation test can record for real. Keeps the
// config's pinned-Chromium escape hatch (test.use replaces launchOptions).
test.use({
  launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

// Context options the config's `use` would normally supply; a context made
// in beforeAll doesn't inherit them.
function contextOptions(testInfo, extra) {
  const u = testInfo.project.use || {};
  const pick = {};
  for (const k of ['baseURL', 'bypassCSP', 'proxy', 'ignoreHTTPSErrors']) if (u[k] !== undefined) pick[k] = u[k];
  return { ...pick, serviceWorkers: 'block', ...extra };
}

async function prepare(page) {
  // A mis-tap on the quick bar must never leave the page (tel:/sms:/mailto:
  // would navigate) — record it instead, so a test can assert none happened.
  await page.addInitScript(() => {
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href^="tel:"],a[href^="sms:"],a[href^="mailto:"]');
      if (a) { e.preventDefault(); window.__protoTaps = (window.__protoTaps || []).concat(a.getAttribute('href')); }
    }, true);
  });
  // "Close without saving?" etc. — accept, as a rep would.
  page.on('dialog', (d) => d.accept().catch(() => {}));
  // _saveLead geocodes via OSM, which rate-limits CI (same stub as pro-authed).
  await page.route('**/nominatim.openstreetmap.org/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }));
}

// Seed a lead with a phone + email (so the bar shows all four buttons), an
// estimate (for the preview sheet) and two photos (strip + Photos grid).
// Every doc carries e2eTestData:true and the describe's `run` tag, so its
// afterAll can delete them by tag (fixtures/seeded-run.js) — until the
// 2026-09-25 follow-up they stayed in the emulator for every later spec in
// the shard, two leads per run and more with CI retries.
async function seedLead(page, stamp, run) {
  await safeWaitForFunction(page, () => !!(window._user && window._user.uid && typeof window._saveLead === 'function'), { timeout: 20_000 });
  return safeEvaluate(page, ({ s, tag }) => {
    window.__e2eSeeding = (async () => {
      try {
        await window._saveLead({
          firstName: '[E2E] Chrome',
          lastName: String(s),
          address: `${String(s).slice(-3)} Chrome Layer Ct, Cincinnati, OH`,
          phone: '513' + String(s).slice(-7),
          email: `e2e-chrome-${s}@nbd.test`,
          stage: 'new',
          e2eTestData: true,
          e2eRun: tag,
        });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      const fs = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
      const db = window.db || window._db;
      const uid = (window._auth || window.auth).currentUser.uid;
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'leads'),
        fs.where('userId', '==', uid), fs.where('lastName', '==', String(s)), fs.where('e2eTestData', '==', true)));
      if (snap.empty) return null;
      const leadId = snap.docs[0].id;
      const add = async (coll, data) => {
        try { await fs.addDoc(fs.collection(db, coll), data); }
        catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      };
      await add('estimates', {
        leadId, userId: uid, type: 'Good', title: 'Good Estimate', status: 'Draft',
        amount: 12450.75, grandTotal: 12450.75, notes: '', createdBy: 'phone-chrome.spec',
        createdAt: fs.serverTimestamp(), e2eTestData: true, e2eRun: tag,
      });
      for (let i = 0; i < 2; i++) {
        await add('photos', {
          // Absolute: the strip only opens the editor for an http(s) URL.
          leadId, userId: uid, url: location.origin + '/pro/img/nbd-icon-512.png', filename: `chrome-${i}.png`,
          type: 'image/png', size: 1, phase: null, category: 'Property', damageType: '', severity: '', location: '',
          createdAt: fs.serverTimestamp(), date: fs.serverTimestamp(), uploadedAt: fs.serverTimestamp(),
          e2eTestData: true, e2eRun: tag,
        });
      }
      return leadId;
    })();
    return window.__e2eSeeding;
  }, { s: stamp, tag: run });
}

async function openCustomer(page, leadId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto(`/pro/customer.html?id=${leadId}`); break; }
    catch (e) {
      if (attempt === 2 || !/ERR_ABORTED|interrupted by another navigation/.test(String(e))) throw e;
      await page.waitForTimeout(1_500);
    }
  }
  await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 30_000 });
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
}

// Topmost-element check at the centre of every match: the control a thumb
// aims for must be the control that receives the tap.
async function hitReport(page, selector) {
  return safeEvaluate(page, (sel) => [...document.querySelectorAll(sel)]
    .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const onScreen = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
      const ok = onScreen && !!hit && (hit === el || el.contains(hit));
      const who = hit ? ((hit.closest('[id]') ? '#' + hit.closest('[id]').id + ' ' : '') + hit.tagName.toLowerCase()) : 'nothing (off-screen)';
      return { label: (el.innerText || el.getAttribute('aria-label') || el.title || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30), ok, who };
    }), selector);
}

// The bar re-renders (remove + rebuild) 120ms after any resize and 60ms
// after every nbd:data-refreshed, then slides in over 250ms. Measure it
// present and at rest: on a phone an absent bar would make every "is the
// bar on top?" probe below pass vacuously.
async function settleBar(page) {
  await page.waitForTimeout(200);
  await safeWaitForFunction(page, () => {
    const bar = document.getElementById('nbd-quick-action-bar');
    if (!bar) return innerWidth > 640;
    return !!bar.querySelector('.qab-call') && bar.getAnimations().every((a) => a.playState === 'finished');
  }, { timeout: 8_000 });
}

// Toasts deliberately sit above every overlay (--z-toast); a lingering
// "Job costs saved" from an earlier test is not what a later test measures.
async function clearToasts(page) {
  await safeEvaluate(page, () => document.querySelectorAll('#toastContainer > div').forEach((t) => t.remove()));
  await settleBar(page);
}

// The in-flight upload indicator, raised the way a rep raises it
// (2026-09-25, #1767 review): queue a photo, put it in flight — the state
// uploadPhotos() gives each item before its Storage put — and tap Cancel.
// _uploadModalOnClose keeps the running batch, and updateGlobalUploadStatus()
// shows the widget AND publishes --nbd-upload-lift in the same task. These
// tests used to add .active by hand, which skipped that call and left the
// lift to the widget's ResizeObserver a frame later; the toast was measured
// before it rose (flaky in CI at 412px, red locally at 1280px, and 16 of 24
// rig rounds overlapped). Returns the lift and the widget height it read.
async function raiseUploadIndicator(page, { touch }) {
  const press = (loc) => (touch ? loc.tap() : loc.click());
  const open = page.locator('[data-action="openUploadModal"]:visible').first();
  await open.scrollIntoViewIfNeeded();
  await press(open);
  await page.waitForSelector('#uploadModal.open #uploadZone');
  await page.locator('#fileInput').setInputFiles({ name: 'roof.png', mimeType: 'image/png', buffer: PNG_1PX });
  // The tile, not just the count: an emptied queue hides the Upload button but
  // leaves #uploadCount as it was, so on a second raise (the next width) the
  // count reads 1 before the FileReader has queued anything and
  // _uploadQueue[0] below is undefined. openUploadModal clears the tiles.
  await expect(page.locator('#uploadPreview .preview-item')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#uploadCount')).toHaveText('1', { timeout: 15_000 });
  await safeEvaluate(page, () => { const it = window._uploadQueue[0]; it.uploading = true; it.progress = 40; });
  await press(page.locator('#uploadModal button.btn[data-action="closeUploadModal"]'));
  await expect(page.locator('#uploadModal.open')).toHaveCount(0);
  await expect(page.locator('#nbdUploadWidget.active')).toBeVisible();
  return safeEvaluate(page, () => ({
    lift: getComputedStyle(document.documentElement).getPropertyValue('--nbd-upload-lift').trim(),
    height: document.getElementById('nbdUploadWidget').offsetHeight,
  }));
}

// ...and taken down the way a finished batch takes it down: the item leaves
// the in-flight set and updateGlobalUploadStatus() hides the widget and drops
// the lift. removeFromQueue() is the page global that runs that refresh (a
// no-op splice on an empty queue), so this is also the cleanup after a
// failure — it first closes a modal a failed step left open.
async function finishUpload(page) {
  await safeEvaluate(page, () => {
    if (document.querySelector('#uploadModal.open')) window.closeUploadModal();
    window.removeFromQueue(0);
  });
}

// RGBA of one screen pixel. A 1x1 clip screenshot is a PNG whose IDAT
// inflates to [filter byte, R, G, B(, A)] — no image library needed.
async function pixelAt(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  const zlib = require('zlib');
  const idat = [];
  let colorType = 6;
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') colorType = png[o + 8 + 9];
    if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { r: raw[1], g: raw[2], b: raw[3], a: colorType === 6 ? raw[4] : 255 };
}

function covered(report) {
  return report.filter((r) => !r.ok).map((r) => `"${r.label}" is under ${r.who}`);
}

// While an overlay is open, the page chrome must be BEHIND its backdrop:
// sample the bar and the corner where the FAB launcher lives.
async function chromeTopmostWhileOpen(page) {
  return safeEvaluate(page, () => {
    const out = [];
    const probe = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      if (hit && hit.closest('#nbd-quick-action-bar,#nbd-fab-dial,#nbd-whisper-fab,#nbd-qc-fab,#nbd-qci-fab')) {
        out.push(`(${Math.round(x)},${Math.round(y)}) → #${hit.closest('[id]').id}`);
      }
    };
    const bar = document.getElementById('nbd-quick-action-bar');
    if (bar && bar.getClientRects().length) {
      const r = bar.getBoundingClientRect();
      for (let i = 1; i <= 4; i++) probe(r.left + (r.width * i) / 5, r.top + r.height / 2);
    }
    for (const id of ['nbd-fab-dial', 'nbd-whisper-fab', 'nbd-qc-fab', 'nbd-qci-fab']) {
      const el = document.getElementById(id);
      if (el && el.getClientRects().length) {
        const r = el.getBoundingClientRect();
        probe(r.left + r.width / 2, r.top + r.height / 2);
      }
    }
    return out;
  });
}

// ── "View details" mid-upload keeps the batch (2026-09-25) ────────────────
// The in-flight indicator's "View details" is data-action="openUploadModal",
// and openUploadModal() opened with a fresh-start reset: window._uploadQueue
// = []. uploadPhotos() walks that array by index, so the loop ended after
// the photo already in flight and the rest of the batch was never sent. It
// then toasted "✓ Uploaded 3 photos" from a count taken before the loop and
// closed the modal the rep had just opened. On the rig at 412 and 1280: 3
// queued, 1 in flight, one tap — queue 3 → 0, widget gone, empty modal.
//
// So these run a REAL batch: the page's own Storage SDK against the
// emulator's Storage (:9199 — the authed CI job boots it too) and real photo
// docs in Firestore. The only interference is at the network. The request
// that starts the FIRST photo's upload (a 1x1 PNG goes up as one multipart
// POST; a big file would open a resumable session with X-Goog-Upload-Command
// "start") is held until the test lets it go, so exactly one photo is in
// flight while the rep looks. `fail` answers the chosen photos' start with a
// 403, which Storage never retries, to prove a failure is counted and the
// batch carries on past it. `holdAt` holds a later photo instead, so the
// rep can look at a batch with a failure already in it.
function holdStorageUploads(page, { fail = [], holdAt = 1 } = {}) {
  let starts = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const match = (url) => /\/v0\/b\/[^/]+\/o$/.test(url.pathname);
  const handler = async (route) => {
    const req = route.request();
    const h = req.headers();
    const begins = req.method() === 'POST'
      && (/multipart/i.test(h['x-goog-upload-protocol'] || '') || /start/i.test(h['x-goog-upload-command'] || ''));
    if (begins) {
      starts += 1;
      if (starts === holdAt) await gate;
      else if (fail.includes(starts)) {
        // CORS headers, or the browser reports a network error instead —
        // which Storage DOES retry, for up to ten minutes.
        return route.fulfill({
          status: 403, contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' },
          body: JSON.stringify({ error: { code: 403, message: 'Permission denied. (e2e: failed on purpose)' } }),
        });
      }
    }
    return route.continue();
  };
  return page.route(match, handler).then(() => ({
    starts: () => starts,
    release: () => release(),
    stop: () => page.unroute(match, handler).catch(() => {}),
  }));
}

// Photo docs Firestore holds for the lead — what actually uploaded, read the
// way the page scopes its own photo queries (leadId + the rep's uid).
async function photoDocCount(page, leadId) {
  return safeEvaluate(page, async (id) => {
    const fs = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'photos'),
      fs.where('leadId', '==', id), fs.where('userId', '==', uid)));
    return snap.size;
  }, leadId);
}

// A button is tappable end to end, not just at its centre: probe its middle
// and 12px in from each end. On desktop the dictation mic sat on the right
// end of "View details" while the centre still hit-tested clean.
async function edgeHits(page, selector) {
  return safeEvaluate(page, (sel) => {
    const el = document.querySelector(sel);
    if (!el || !el.getClientRects().length) return [`${sel} is not rendered`];
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    return [['left end', r.left + 12], ['centre', r.left + r.width / 2], ['right end', r.right - 12]]
      .map(([where, x]) => ({ where, hit: document.elementFromPoint(x, y) }))
      .filter(({ hit }) => !hit || !(hit === el || el.contains(hit)))
      .map(({ where, hit }) => `${where} is under ${hit ? (hit.closest('[id]') ? '#' + hit.closest('[id]').id + ' ' : '') + hit.tagName.toLowerCase() : 'nothing'}`);
  }, selector);
}

// The upload modal's tiles as the rep sees them: each one's label ("40%",
// "Failed", or nothing for a photo still waiting) and whether it is marked
// failed, plus the Upload button's count and whether it shows at all.
async function uploadTiles(page) {
  return safeEvaluate(page, () => {
    const tiles = [...document.querySelectorAll('#uploadPreview .preview-item')];
    const btn = document.getElementById('uploadBtn');
    const c = document.getElementById('uploadCount');
    return {
      labels: tiles.map((t) => {
        const p = t.querySelector('.preview-progress-pct');
        return p && getComputedStyle(p).display !== 'none' ? p.textContent.trim() : '';
      }),
      failed: tiles.map((t) => t.classList.contains('failed')),
      uploadShown: !!btn && getComputedStyle(btn).display !== 'none',
      count: c ? c.textContent.trim() : null,
    };
  });
}

// Queue three photos, tap Upload, hold photo 1 (or `holdAt`) in flight, put
// the modal away and tap "View details" — the rep's path. `beforeReopen`
// runs with the indicator showing (the desktop test raises a toast there);
// `beforeRelease` with the reopened modal up, before the held photo goes.
// `latePick` names photos the picker hands back only AFTER the batch has
// ended — the rep opened it from View details and was still browsing when
// the last photo settled. Returns what the reopened modal showed and how the
// batch ended.
async function viewDetailsMidBatch(page, { touch, leadId, fail = [], holdAt = 1, beforeReopen, beforeRelease, latePick = [] }) {
  const press = (loc) => (touch ? loc.tap() : loc.click());
  const before = await photoDocCount(page, leadId);
  const net = await holdStorageUploads(page, { fail, holdAt });
  const out = {};
  try {
    const open = page.locator('[data-action="openUploadModal"]:visible').first();
    await open.scrollIntoViewIfNeeded();
    await press(open);
    await page.waitForSelector('#uploadModal.open #uploadZone');
    await page.locator('#fileInput').setInputFiles(['a', 'b', 'c'].map((n) => ({ name: `batch-${n}.png`, mimeType: 'image/png', buffer: PNG_1PX })));
    await expect(page.locator('#uploadCount'), 'three photos staged').toHaveText('3', { timeout: 15_000 });
    await press(page.locator('#uploadBtn'));
    await expect.poll(() => net.starts(), { message: `photo ${holdAt} reaches Storage`, timeout: 20_000 }).toBe(holdAt);
    out.startedWith = await safeEvaluate(page, () => (window._uploadQueue || []).map((it) => !!(it && it.uploading)));
    // The rep puts the modal away and carries on; the indicator takes over.
    await press(page.locator('#uploadModal button.btn[data-action="closeUploadModal"]'));
    await expect(page.locator('#uploadModal.open')).toHaveCount(0);
    await expect(page.locator('#nbdUploadWidget.active')).toBeVisible();
    out.widgetCount = (await page.locator('#nbdUploadWidgetCount').textContent()).trim();
    if (beforeReopen) await beforeReopen(out);
    out.reopenEdges = await edgeHits(page, '#nbdUploadWidgetReopen');
    await press(page.locator('#nbdUploadWidgetReopen'));
    await expect(page.locator('#uploadModal.open')).toHaveCount(1);
    out.reopened = await safeEvaluate(page, () => {
      const q = window._uploadQueue || [];
      const tiles = [...document.querySelectorAll('#uploadPreview .preview-item')];
      const bar = tiles[0] && tiles[0].querySelector('.preview-progress');
      const c = document.getElementById('uploadCount');
      return {
        queued: q.length,
        inFlight: q.filter((it) => it && it.uploading).length,
        tiles: tiles.length,
        progressShown: !!bar && getComputedStyle(bar).display !== 'none',
        count: c ? c.textContent.trim() : null,
      };
    });
    out.reopenedTiles = await uploadTiles(page);
    if (beforeRelease) await beforeRelease(out);
    // Let the held photo through: the rest of the batch must follow on its own.
    net.release();
    const toast = page.locator('#toastContainer > div', { hasText: /Uploaded|failed/i }).last();
    await expect(toast, 'the batch reports how it ended').toBeVisible({ timeout: 30_000 });
    out.toast = (await toast.locator('span').first().textContent()).trim();
    // Its words stay inside it (a raw Storage error is one long path token).
    out.toastFits = await toast.evaluate((t) => t.querySelector('span').getBoundingClientRect().right <= t.getBoundingClientRect().right + 0.5);
    out.saved = (await photoDocCount(page, leadId)) - before;
    out.starts = net.starts();
    await expect(page.locator('#nbdUploadWidget.active'), 'the indicator hides once the batch ends').toHaveCount(0);
    out.after = await safeEvaluate(page, () => ({
      queued: (window._uploadQueue || []).length,
      modalOpen: !!document.querySelector('#uploadModal.open'),
    }));
    out.afterTiles = await uploadTiles(page);
    if (latePick.length) {
      // The picker hands its photos back now, over a modal the finished batch
      // has closed. They used to land in a fresh queue behind it — no tiles,
      // no Upload button, no indicator — and the next open threw them away.
      await page.locator('#fileInput').setInputFiles(latePick.map((n) => ({ name: `${n}.png`, mimeType: 'image/png', buffer: PNG_1PX })));
      await expect.poll(() => safeEvaluate(page, () => (window._uploadQueue || []).length), { message: 'the late photos are queued', timeout: 15_000 }).toBe(latePick.length);
      await page.waitForTimeout(300); // the modal's open transition
      out.late = { modalOpen: await page.locator('#uploadModal.open').count() === 1, ...(await uploadTiles(page)) };
      if (out.late.modalOpen) {
        out.late.uploadHit = covered(await hitReport(page, '#uploadModal #uploadBtn'));
        const saved = await photoDocCount(page, leadId);
        await press(page.locator('#uploadBtn'));
        const lateToast = page.locator('#toastContainer > div', { hasText: `Uploaded ${latePick.length} photo` }).last();
        await expect(lateToast, 'the late photos report how they ended').toBeVisible({ timeout: 30_000 });
        out.late.toast = (await lateToast.locator('span').first().textContent()).trim();
        out.late.saved = (await photoDocCount(page, leadId)) - saved;
      }
    }
    return out;
  } finally {
    net.release();
    await net.stop();
    // A failed step can leave the batch running or the modal open: let it
    // settle, then leave the page as the next test expects it.
    await safeWaitForFunction(page, () => !document.querySelector('#nbdUploadWidget.active'), { timeout: 30_000 }).catch(() => {});
    await safeEvaluate(page, () => { if (document.querySelector('#uploadModal.open')) window.closeUploadModal(); });
  }
}

// uploadSinglePhoto fires PhotoAIClassifier.classify for every saved photo,
// through a Functions instance nothing points at the emulator — i.e.
// production (ci-e2e-calls-production-functions). Answered here instead, in
// the callable wire format.
function answerPhotoVision(route) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  return route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors })
    : route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ result: null }) });
}

// The toast's own count, as a number ("✓ Uploaded 3 photos" → 3,
// "Uploaded 2 of 3 photos …" → 2).
function toastUploaded(text) {
  const m = /Uploaded (\d+)/.exec(text || '');
  return m ? Number(m[1]) : null;
}

// The installed app's @media (display-mode: standalone) cascade, copied to
// the top level (same technique as phone-views.spec.js / phone-dashnav):
// Jo runs the iPhone home-screen app, and a browser tab never matches it.
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

test.describe.serial('customer page chrome on a phone @audit', () => {
  let creds = null;
  let ctx;
  let page;
  let leadId;
  let run = ''; // e2eRun tag on everything this describe seeds

  test.beforeAll(async ({ browser }, testInfo) => {
    try { creds = requireTestUser(); } catch (e) { console.warn('[phone-chrome] ' + e.message); return; }
    testInfo.setTimeout(120_000);
    // Tagged before the first write, so afterAll finds the seeds even if
    // this hook dies before leadId is assigned.
    const stamp = Date.now();
    run = `phone-chrome@phone:${stamp}`;
    ctx = await browser.newContext(contextOptions(testInfo, {
      viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA,
      permissions: ['microphone'],
    }));
    page = await ctx.newPage();
    await prepare(page);
    await loginAs(page, creds);
    leadId = await seedLead(page, stamp, run);
    expect(leadId, 'seeded [E2E] Chrome lead has an id').toBeTruthy();
    await openCustomer(page, leadId);
    await page.waitForSelector('#nbd-quick-action-bar .qab-call', { timeout: 15_000 });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000); // a stalled rig: seed + pending writes + retried lookups (fixtures/seeded-run.js)
    const res = await deleteSeededRun({ page, context: ctx, creds, run });
    if (res.failed.length) console.warn('[phone-chrome] cleanup: ' + res.failed.join('; '));
    if (ctx) await ctx.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('document viewer footer is reachable, not the bar under it', async () => {
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await settleBar(page);
      const more = page.locator('#qaMoreBtn');
      if (await more.isVisible().catch(() => false) && !(await page.locator('.quick-actions [data-action="exportCustomerPDF"]').isVisible())) {
        await more.tap();
      }
      const report = page.locator('.quick-actions [data-action="exportCustomerPDF"]');
      await report.scrollIntoViewIfNeeded();
      await report.tap();
      await page.waitForSelector('#nbd-doc-viewer-overlay.open .nbdv-action-btn', { timeout: 30_000 });
      await page.waitForTimeout(500);
      const footer = await hitReport(page, '#nbd-doc-viewer-overlay .nbdv-action-btn');
      expect(footer.length, `viewer footer buttons at ${width}px`).toBeGreaterThanOrEqual(4);
      expect(covered(footer), `viewer footer at ${width}px`).toEqual([]);
      expect(await chromeTopmostWhileOpen(page), `page chrome above the viewer at ${width}px`).toEqual([]);
      await page.locator('#nbdv-close').tap();
      await expect(page.locator('#nbd-doc-viewer-overlay.open')).toHaveCount(0);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('estimate sheet Edit / Archive / Close are the sheet, and Close closes it', async () => {
    await clearToasts(page);
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await settleBar(page);
      await safeEvaluate(page, () => { window.__protoTaps = []; });
      const row = page.locator('.nbd-est-row').first();
      await row.scrollIntoViewIfNeeded();
      // Top-left of the row: its centre carries the row's own Export button.
      await row.tap({ position: { x: 24, y: 14 } });
      await page.waitForSelector('.ep-overlay .ep-actions button', { timeout: 10_000 });
      // The sheet slides up from below the screen; measure it once it lands.
      await safeWaitForFunction(page, () => {
        const b = document.querySelector('.ep-overlay .ep-actions button');
        return !!b && b.getBoundingClientRect().bottom <= innerHeight;
      }, { timeout: 5_000 });
      await page.waitForTimeout(300);
      const actions = await hitReport(page, '.ep-overlay .ep-actions button');
      expect(actions.length, `sheet actions at ${width}px`).toBeGreaterThanOrEqual(3);
      expect(covered(actions), `sheet actions at ${width}px`).toEqual([]);
      // Real tap on Close. Before the fix this hit the bar's TASK button:
      // the task modal opened behind a sheet that stayed open.
      await page.locator('.ep-overlay .ep-actions button', { hasText: /close/i }).tap();
      await expect(page.locator('.ep-overlay')).toHaveCount(0);
      await expect(page.locator('#taskModal.open')).toHaveCount(0);
      expect(await safeEvaluate(page, () => window.__protoTaps || []), 'no call/text/email fired').toEqual([]);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('a save toast shows above the bar and leaves CALL / TASK tappable', async () => {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page); // one toast per width: the last width's must not stack under this one
      const save = page.locator('[data-pt-action="save"]').first();
      await save.scrollIntoViewIfNeeded();
      await save.tap();
      const toast = page.locator('#toastContainer > div', { hasText: /costs saved/i }).last();
      await expect(toast).toBeVisible({ timeout: 10_000 });
      const r = await safeEvaluate(page, () => {
        const t = [...document.querySelectorAll('#toastContainer > div')].filter((d) => /costs saved/i.test(d.textContent)).pop();
        const tr = t.getBoundingClientRect();
        const hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
        const bar = document.getElementById('nbd-quick-action-bar').getBoundingClientRect();
        const barBtns = [...document.querySelectorAll('#nbd-quick-action-bar .qab-btn')].map((b) => {
          const br = b.getBoundingClientRect();
          const h = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
          return { label: b.textContent.trim(), ok: !!h && (h === b || b.contains(h)), who: h ? h.tagName + '.' + String(h.className).slice(0, 30) : 'null' };
        });
        const dial = document.getElementById('nbd-fab-dial');
        const dr = dial && dial.getClientRects().length ? dial.getBoundingClientRect() : null;
        return {
          toastOnTop: !!hit && t.contains(hit),
          toastBottom: tr.bottom, barTop: bar.top,
          barBtns,
          overlapsLauncher: !!dr && !(tr.bottom <= dr.top || tr.top >= dr.bottom || tr.right <= dr.left || tr.left >= dr.right),
        };
      });
      expect(r.toastOnTop, `the toast is the topmost thing where it sits at ${width}px`).toBe(true);
      expect(r.toastBottom, `the toast sits above the quick-action bar at ${width}px`).toBeLessThanOrEqual(r.barTop);
      expect(r.barBtns.filter((b) => !b.ok), `bar buttons stay tappable while a toast shows at ${width}px`).toEqual([]);
      expect(r.overlapsLauncher, `the toast clears the field-tools launcher at ${width}px`).toBe(false);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('a Voice Intel error toast sits above the bar, not on CALL / TEXT / EMAIL / TASK', async () => {
    // Follow-up (review:chrome): #toastContainer was lifted above the bar but
    // the Voice Intel toast kept bottom:20px, so for its 5s life it covered
    // TEXT / EMAIL / TASK. voice-intelligence.js showToast() appends exactly
    // this element to the panel root on a recording or upload failure; the
    // feature is flag-gated, so build it the same way instead of recording.
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page);
      const r = await safeEvaluate(page, () => {
        const t = document.createElement('div');
        t.className = 'nbd-voice-toast nbd-voice-toast-err';
        t.textContent = 'Upload failed: network error while sending the recording';
        (document.getElementById('voiceIntelRoot') || document.body).appendChild(t);
        try {
          const tr = t.getBoundingClientRect();
          const hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
          const bar = document.getElementById('nbd-quick-action-bar').getBoundingClientRect();
          const barBtns = [...document.querySelectorAll('#nbd-quick-action-bar .qab-btn')].map((b) => {
            const br = b.getBoundingClientRect();
            const h = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
            return { label: b.textContent.trim(), ok: !!h && (h === b || b.contains(h)), who: h ? h.tagName + '.' + String(h.className).slice(0, 30) : 'null' };
          });
          const dial = document.getElementById('nbd-fab-dial');
          const dr = dial && dial.getClientRects().length ? dial.getBoundingClientRect() : null;
          return {
            painted: tr.width > 0 && tr.height > 0,
            toastOnTop: !!hit && t.contains(hit),
            toastBottom: tr.bottom, toastLeft: tr.left, barTop: bar.top,
            barBtns,
            overlapsLauncher: !!dr && !(tr.bottom <= dr.top || tr.top >= dr.bottom || tr.right <= dr.left || tr.left >= dr.right),
          };
        } finally { t.remove(); }
      });
      expect(r.painted, `voice toast renders at ${width}px`).toBe(true);
      expect(r.toastOnTop, `the voice toast is the topmost thing where it sits at ${width}px`).toBe(true);
      expect(r.toastBottom, `the voice toast sits above the quick-action bar at ${width}px`).toBeLessThanOrEqual(r.barTop);
      expect(r.toastLeft, `the voice toast keeps a gutter at ${width}px`).toBeGreaterThanOrEqual(8);
      expect(r.barBtns.filter((b) => !b.ok), `bar buttons stay tappable under a voice toast at ${width}px`).toEqual([]);
      expect(r.overlapsLauncher, `the voice toast clears the field-tools launcher at ${width}px`).toBe(false);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('in-flight upload indicator rides above the bar, and toasts stack above it', async () => {
    // A batch left uploading behind a closed modal — the real show path, not
    // a hand-added .active (see raiseUploadIndicator). Raised and finished
    // once per width: each pass measures the lift its own show published, and
    // the indicator is down again before the next width re-renders the bar.
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page);
      try {
        const up = await raiseUploadIndicator(page, { touch: true });
        expect(up.lift, `the indicator publishes its lift as it shows at ${width}px`).toBe(`${up.height + 8}px`);
        expect(covered(await hitReport(page, '#nbdUploadWidgetReopen')), `"View details" on the upload indicator at ${width}px`).toEqual([]);
        // Follow-up (review:chrome): the widget and #toastContainer shared one
        // bottom offset in one corner, so a toast raised mid-upload sat on
        // "View details" for its whole life. A real toast now stacks above.
        await safeEvaluate(page, () => window.showToast('Customer info updated', 'success'));
        const toast = page.locator('#toastContainer > div', { hasText: 'Customer info updated' }).last();
        await expect(toast).toBeVisible();
        const s = await safeEvaluate(page, () => {
          const w = document.getElementById('nbdUploadWidget').getBoundingClientRect();
          const t = [...document.querySelectorAll('#toastContainer > div')].filter((d) => /Customer info updated/.test(d.textContent)).pop();
          const tr = t.getBoundingClientRect();
          const hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
          return { overlap: !(tr.bottom <= w.top || tr.top >= w.bottom || tr.right <= w.left || tr.left >= w.right), toastOnTop: !!hit && t.contains(hit) };
        });
        expect(s.overlap, `the toast and the upload indicator overlap at ${width}px`).toBe(false);
        expect(s.toastOnTop, `the toast is the topmost thing where it sits at ${width}px`).toBe(true);
        expect(covered(await hitReport(page, '#nbdUploadWidgetReopen')), `"View details" while a toast shows at ${width}px`).toEqual([]);
        // ...and so does the Voice Intel toast.
        const v = await safeEvaluate(page, () => {
          document.querySelectorAll('#toastContainer > div').forEach((d) => d.remove());
          const t = document.createElement('div');
          t.className = 'nbd-voice-toast nbd-voice-toast-err';
          t.textContent = 'Recording failed';
          (document.getElementById('voiceIntelRoot') || document.body).appendChild(t);
          try {
            const w = document.getElementById('nbdUploadWidget').getBoundingClientRect();
            const tr = t.getBoundingClientRect();
            return !(tr.bottom <= w.top || tr.top >= w.bottom || tr.right <= w.left || tr.left >= w.right);
          } finally { t.remove(); }
        });
        expect(v, `the voice toast and the upload indicator overlap at ${width}px`).toBe(false);
      } finally {
        await finishUpload(page);
      }
      await expect(page.locator('#nbdUploadWidget.active'), `the indicator is down again after ${width}px`).toHaveCount(0);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('warranty claim modal covers the page chrome', async () => {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page);
      // The same call a stage move into Warranty Claim makes
      // (customer-bootstrap.module.js progressStage → promptIntake).
      await safeEvaluate(page, () => { window.__wcDone = window.WarrantyClaim.promptIntake(window._currentLead || {}).then(() => true); });
      await page.waitForSelector('#nbd-warranty-claim-modal button', { timeout: 5_000 });
      expect(covered(await hitReport(page, '#nbd-warranty-claim-modal button, #nbd-warranty-claim-modal textarea, #nbd-warranty-claim-modal select')), `warranty modal controls at ${width}px`).toEqual([]);
      expect(await chromeTopmostWhileOpen(page), `bar / launcher above the warranty backdrop at ${width}px`).toEqual([]);
      await page.locator('#nbd-warranty-claim-modal button', { hasText: /^cancel$/i }).tap();
      await expect(page.locator('#nbd-warranty-claim-modal')).toHaveCount(0);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('field tools collapse behind one launcher and fan out on tap', async () => {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      const parked = await safeEvaluate(page, () => ['nbd-whisper-fab', 'nbd-qc-fab', 'nbd-qci-fab']
        .filter((id) => document.getElementById(id))
        .map((id) => {
          const el = document.getElementById(id);
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { id, tappable: !!hit && (hit === el || el.contains(hit)), opacity: getComputedStyle(el).opacity };
        }));
      expect(parked.length, `the three field tools exist at ${width}px`).toBe(3);
      expect(parked.filter((t) => t.tappable || t.opacity !== '0'), `closed dial: tools parked, faded and untappable at ${width}px`).toEqual([]);

      const dial = page.locator('#nbd-fab-dial');
      await expect(dial).toBeVisible();
      expect(covered(await hitReport(page, '#nbd-fab-dial')), `launcher is tappable at ${width}px`).toEqual([]);
      await dial.tap();
      await safeWaitForFunction(page, () => getComputedStyle(document.getElementById('nbd-whisper-fab')).opacity === '1', { timeout: 5_000 });
      const fanned = await hitReport(page, '#nbd-whisper-fab, #nbd-qc-fab, #nbd-qci-fab');
      expect(covered(fanned), `fanned-out tools are tappable at ${width}px`).toEqual([]);
      const clear = await safeEvaluate(page, () => {
        const bar = document.getElementById('nbd-quick-action-bar').getBoundingClientRect();
        return ['nbd-whisper-fab', 'nbd-qc-fab', 'nbd-qci-fab', 'nbd-fab-dial'].filter((id) => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.bottom > bar.top || r.left < 0 || r.right > innerWidth;
        });
      });
      expect(clear, `fan row sits above the bar and inside the screen at ${width}px`).toEqual([]);
      await page.touchscreen.tap(40, 300);
      await safeWaitForFunction(page, () => getComputedStyle(document.getElementById('nbd-whisper-fab')).opacity === '0', { timeout: 5_000 });
    }
    await page.setViewportSize({ width: 412, height: 860 });

    // The bar re-renders and slides in again on every resize and data
    // refresh. fab-stack-coordinator.js used to measure it mid-slide (still
    // below the screen), publish an 8px corner claim, and leave the launcher
    // parked ON the bar's TASK button until its 1.5s safety re-check.
    // Whether that re-check lands before the probe is chance (~20% per
    // re-render), so run three re-renders: the old code slips all three
    // well under 1% of the time.
    const misses = [];
    for (let i = 0; i < 3; i++) {
      await page.setViewportSize({ width: 360, height: 860 });
      await page.setViewportSize({ width: 412, height: 860 });
      await settleBar(page);
      const r = await safeEvaluate(page, () => {
        const dial = document.getElementById('nbd-fab-dial').getBoundingClientRect();
        const bar = document.getElementById('nbd-quick-action-bar').getBoundingClientRect();
        const task = document.querySelector('#nbd-quick-action-bar .qab-task');
        const tr = task.getBoundingClientRect();
        const hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
        return { dialBottom: dial.bottom, barTop: bar.top, taskOk: !!hit && task.contains(hit) };
      });
      if (r.dialBottom > r.barTop || !r.taskOk) misses.push(`re-render ${i + 1}: launcher bottom ${Math.round(r.dialBottom)} vs bar top ${Math.round(r.barTop)}, TASK tappable ${r.taskOk}`);
    }
    expect(misses, 'launcher stays above the bar and TASK stays tappable right after the bar re-renders').toEqual([]);
  });

  test('dictation: the recording pill and the result stay off the mic', async () => {
    await clearToasts(page);
    // Never let a test reach a real transcription backend: in CI a callable
    // can resolve to production (ci-e2e-calls-production-functions). Answer
    // it here in the callable wire format.
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    const answer = (route) => (route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ result: { transcript: 'check the ridge vent', cleaned: 'Check the ridge vent.' } }) }));
    await page.route('**/dictate', answer);
    await page.route('**/transcribeVoiceMemo', answer);
    try {
      for (const width of PHONE_WIDTHS) {
        await page.setViewportSize({ width, height: 860 });
        await clearToasts(page);
        await page.evaluate(() => { window.scrollTo(0, 0); if (document.activeElement) document.activeElement.blur(); });
        await page.locator('#nbd-fab-dial').tap();
        const mic = page.locator('#nbd-whisper-fab');
        await safeWaitForFunction(page, () => getComputedStyle(document.getElementById('nbd-whisper-fab')).opacity === '1', { timeout: 5_000 });
        await mic.tap();
        await safeWaitForFunction(page, () => {
          const v = document.getElementById('nbd-whisper-viz');
          return /⏹/.test(document.getElementById('nbd-whisper-fab').textContent) && !!v && v.style.display !== 'none';
        }, { timeout: 10_000 });
        await page.waitForTimeout(1_200); // a clip long enough to be sent
        // Before the fix the pill sat on the mic, so ⏹ — the only way to stop
        // a dictation short of the 60s ceiling — hit-tested as the pill.
        expect(covered(await hitReport(page, '#nbd-whisper-fab')), `the ⏹ stop control while recording at ${width}px`).toEqual([]);
        await mic.tap();
        await safeWaitForFunction(page, () => !/⏹/.test(document.getElementById('nbd-whisper-fab').textContent), { timeout: 5_000 });
        await page.waitForSelector('#nbd-whisper-tip', { timeout: 10_000 });
        expect(covered(await hitReport(page, '#nbd-whisper-fab, #nbd-qc-fab, #nbd-qci-fab, #nbd-fab-dial')), `field tools with the dictation result showing at ${width}px`).toEqual([]);
        await page.locator('#nbd-whisper-tip .nbd-whisper-tip-close').tap();
        await expect(page.locator('#nbd-whisper-tip')).toHaveCount(0);
        await page.touchscreen.tap(40, 300); // fold the dial for the next width
        await safeWaitForFunction(page, () => getComputedStyle(document.getElementById('nbd-whisper-fab')).opacity === '0', { timeout: 5_000 });
      }
    } finally {
      await page.unroute('**/dictate');
      await page.unroute('**/transcribeVoiceMemo');
      // A failure mid-loop leaves the dial open; a tap on a closed dial's
      // page would land on whatever sits at (40, 300).
      if (await safeEvaluate(page, () => getComputedStyle(document.getElementById('nbd-whisper-fab')).opacity !== '0').catch(() => false)) {
        await page.touchscreen.tap(40, 300);
      }
      await page.setViewportSize({ width: 412, height: 860 });
    }
  });

  test('Edit Photo sheet covers the page chrome; Delete is the sheet', async () => {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page);
      const tile = page.locator('.nbd-phase-photo').first();
      await tile.scrollIntoViewIfNeeded();
      await tile.tap();
      await page.waitForSelector('#photoActionPopup [data-action="deletePhoto"]', { timeout: 10_000 });
      const btns = await hitReport(page, '#photoActionPopup button');
      expect(covered(btns), `every Edit Photo control at ${width}px`).toEqual([]);
      expect(await chromeTopmostWhileOpen(page), `bar / launcher above the Edit Photo backdrop at ${width}px`).toEqual([]);
      const close = await safeEvaluate(page, () => {
        const r = document.querySelector('#photoActionPopup [data-action="_closePhotoActionPopup"]').getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      expect(Math.min(close.w, close.h), `close × is thumb-sized at ${width}px`).toBeGreaterThanOrEqual(40);
      await page.locator('#photoActionPopup [data-action="_closePhotoActionPopup"]').tap();
      await expect(page.locator('#photoActionPopup')).toHaveCount(0);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('photo editor: tools, Save and Toggle Panel are reachable by a finger', async () => {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page);
      const item = page.locator('#photoList .nbd-photo-item').first();
      await item.scrollIntoViewIfNeeded();
      await item.tap();
      await page.waitForSelector('.nbd-editor-overlay #nbd-toolbar .nbd-tool-btn', { timeout: 15_000 });
      await page.waitForTimeout(600);
      // The tool strip scrolls sideways (overflow-x), so the tools a finger
      // can reach without a swipe are the ones whose centre is on screen:
      // eight at 412; at 360 the eighth (Text) sits past the edge (2026-09-25
      // review of the chrome lane). Every one of those must take the tap, and
      // at least that many must fit, so a collapsed strip can't pass empty.
      const tools = await safeEvaluate(page, () => [...document.querySelectorAll('.nbd-editor-overlay #nbd-toolbar .nbd-tool-btn')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const onScreen = r.width > 0 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight;
          const hit = onScreen ? document.elementFromPoint(x, y) : null;
          return { label: (el.title || el.getAttribute('aria-label') || el.textContent).trim().slice(0, 20), onScreen, ok: !!hit && (hit === el || el.contains(hit)), who: hit ? (hit.id ? '#' + hit.id + ' ' : '') + hit.tagName.toLowerCase() : 'off-screen' };
        }).filter((t) => t.onScreen));
      expect(tools.length, `editor tools reachable without a swipe at ${width}px`).toBeGreaterThanOrEqual(width >= 412 ? 8 : 7);
      expect(covered(tools), `on-screen editor tools at ${width}px`).toEqual([]);
      expect(covered(await hitReport(page, '.nbd-editor-overlay [data-act="save-over"]')), `Save is on screen and tappable at ${width}px`).toEqual([]);
      expect(await chromeTopmostWhileOpen(page), `page chrome above the editor at ${width}px`).toEqual([]);
      // Toggle Panel (the only way into the damage-tag drawer) sits at the end
      // of the top bar's swipe strip: drag it into view with a real touch,
      // starting 32px in from this width's right edge. One 300px swipe
      // reaches it at 412; the strip is 52px narrower at 360 and takes a
      // second, as it would for a thumb. Three that never get there fail.
      const toggle = '.nbd-editor-overlay [data-act="toggle-panel"]';
      const y = await safeEvaluate(page, () => {
        const r = document.querySelector('.nbd-editor-overlay [data-act="save-over"]').getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      });
      const cdp = await page.context().newCDPSession(page);
      const pt = (x) => [{ x: Math.round(x), y, id: 1 }];
      const x0 = width - 32;
      for (let swipes = 0; swipes < 3; swipes++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0) });
        for (let i = 1; i <= 12; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 - 25 * i) });
          await page.waitForTimeout(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(500);
        const r = await hitReport(page, toggle);
        if (r.length && !covered(r).length) break;
      }
      await cdp.detach().catch(() => {});
      const tp = await hitReport(page, toggle);
      expect(tp.length, `Toggle Panel is rendered at ${width}px`).toBe(1);
      expect(covered(tp), `Toggle Panel after swiping the top bar at ${width}px`).toEqual([]);
      await page.locator('.nbd-editor-overlay [data-act="toggle-panel"]').tap();
      await expect(page.locator('#nbd-panel.open')).toHaveCount(1);
      await page.locator('.nbd-editor-overlay [data-act="back"]').tap();
      await expect(page.locator('.nbd-editor-overlay')).toHaveCount(0, { timeout: 5_000 });
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('upload modal keeps Upload on screen with a batch queued', async () => {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: 860 });
      await clearToasts(page);
      const open = page.locator('[data-action="openUploadModal"]').first();
      await open.scrollIntoViewIfNeeded();
      await open.tap();
      await page.waitForSelector('#uploadModal.open #uploadZone');
      // openUploadModal empties the queue, so each width starts from 0.
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#uploadZone').tap()]);
      await chooser.setFiles(Array.from({ length: 15 }, (_, i) => ({ name: `batch-${i}.png`, mimeType: 'image/png', buffer: PNG_1PX })));
      // Wait on the tiles: #uploadCount keeps the last batch's 15 after Cancel
      // (an emptied queue only hides the button), so at the second width it
      // read 15 before any file had loaded and the Upload button was still
      // display:none (2 of 40 back-to-back rounds on the local rig).
      await expect(page.locator('#uploadPreview .preview-item')).toHaveCount(15, { timeout: 15_000 });
      await expect(page.locator('#uploadCount')).toHaveText('15', { timeout: 15_000 });
      // No scrolling: the rep must see the primary action as soon as the batch lands.
      // Selected by role, not by the footer's class, so a break-test against
      // the old markup fails on reachability rather than on a missing class.
      const btns = await hitReport(page, '#uploadModal #uploadBtn, #uploadModal button.btn[data-action="closeUploadModal"]');
      expect(btns.length, `Upload + Cancel rendered at ${width}px`).toBe(2);
      expect(covered(btns), `Upload / Cancel with 15 queued at ${width}px`).toEqual([]);
      expect(await chromeTopmostWhileOpen(page), `page chrome above the upload modal at ${width}px`).toEqual([]);
      await page.locator('#uploadModal button.btn[data-action="closeUploadModal"]').tap();
      await expect(page.locator('#uploadModal.open')).toHaveCount(0);
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('pinned jump-nav spans the width and a jump lands just under it', async () => {
    await clearToasts(page);
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      const chip = page.locator('#tabBar a[href="#photosTab"]');
      await chip.scrollIntoViewIfNeeded();
      await chip.tap();
      await page.waitForTimeout(900);
      const r = await safeEvaluate(page, () => {
        const nav = document.getElementById('tabBar').getBoundingClientRect();
        const sec = document.getElementById('photosTab').getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const y = nav.top + nav.height / 2;
        // The container's side padding is the only gap allowed beside the bar.
        const pad = parseFloat(getComputedStyle(document.getElementById('tabBar').parentElement).paddingRight) || 0;
        const leaks = [];
        for (let x = nav.left + nav.width * 0.6; x < vw - pad - 1; x += 8) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || !hit.closest('#tabBar')) leaks.push(Math.round(x) + ':' + (hit ? hit.tagName.toLowerCase() : 'null'));
        }
        return { navTop: nav.top, navBottom: nav.bottom, secTop: sec.top, leaks };
      });
      expect(r.navTop, `bar pinned at ${width}px`).toBeLessThanOrEqual(1);
      expect(r.leaks, `page shows through beside the pinned bar at ${width}px`).toEqual([]);
      expect(r.secTop, `section starts below the bar at ${width}px`).toBeGreaterThanOrEqual(r.navBottom - 1);
      expect(r.secTop - r.navBottom, `gap between bar and section at ${width}px`).toBeLessThanOrEqual(24);

      // Hit-testing can't see a mask: a masked-out edge still hit-tests as
      // the bar while painting whatever scrolls under it. Put a red band
      // UNDER the pinned bar and read the pixel at the bar's right edge.
      const edge = await safeEvaluate(page, () => {
        const band = document.createElement('div');
        band.id = '__chromeProbeBand';
        band.style.cssText = 'position:fixed;left:0;right:0;top:0;height:64px;background:#ff0000;z-index:1;pointer-events:none;';
        document.body.appendChild(band);
        const nav = document.getElementById('tabBar').getBoundingClientRect();
        return { x: nav.right - 3, y: nav.top + nav.height / 2 };
      });
      try {
        const px = await pixelAt(page, edge.x, edge.y);
        expect(px.r - Math.max(px.g, px.b), `red band shows through the pinned bar's right edge at ${width}px (rgb ${px.r},${px.g},${px.b})`).toBeLessThan(80);
      } finally {
        await safeEvaluate(page, () => { const b = document.getElementById('__chromeProbeBand'); if (b) b.remove(); });
      }
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  // See viewDetailsMidBatch. Two real batches in one page, which also proves
  // the second batch still previews: the Upload button's busy label used to
  // be set with textContent, which deleted #uploadCount for the page's life.
  // Each width then picks two more photos that land only after the batch has
  // ended (#1773 review): they must come back up in the modal, staged, and
  // upload on the rep's tap — not sit unseen behind a closed modal.
  test('"View details" mid-upload keeps the batch; all three upload and the toast counts them; photos picked as it ends are not lost', async () => {
    test.setTimeout(180_000);
    await page.route('**/analyzePhotoVision', answerPhotoVision);
    expect(await forceStandalone(page), 'found the installed-app rules to force').toBeGreaterThan(0);
    try {
      for (const width of [412, 360]) {
        await page.setViewportSize({ width, height: 860 });
        await clearToasts(page);
        const r = await viewDetailsMidBatch(page, { touch: true, leadId, latePick: ['late-1', 'late-2'] });
        expect(r.startedWith, `one photo in flight, two waiting at ${width}px`).toEqual([true, false, false]);
        expect(r.widgetCount, `the indicator counts the whole batch at ${width}px`).toMatch(/^1 \/ 3\b/);
        expect(r.reopenEdges, `"View details" end to end at ${width}px`).toEqual([]);
        expect(r.reopened.queued, `View details kept the batch queued at ${width}px`).toBe(3);
        expect(r.reopened.tiles, `the reopened modal shows the whole batch at ${width}px`).toBe(3);
        expect(r.reopened.inFlight, `still exactly one in flight at ${width}px`).toBe(1);
        expect(r.reopened.progressShown, `the photo in flight shows its progress at ${width}px`).toBe(true);
        expect(r.reopened.count, `the Upload button still carries its count at ${width}px`).toBe('3');
        expect(r.starts, `all three photos reached Storage at ${width}px`).toBe(3);
        expect(r.saved, `all three photos saved at ${width}px`).toBe(3);
        expect(r.toast, `the toast at ${width}px`).toMatch(/^✓ Uploaded 3 photos$/);
        expect(toastUploaded(r.toast), `the toast counts what saved at ${width}px`).toBe(r.saved);
        expect(r.after, `the finished batch clears and closes at ${width}px`).toEqual({ queued: 0, modalOpen: false });
        expect(r.late.modalOpen, `photos picked after the batch ended bring the modal back up at ${width}px`).toBe(true);
        expect(r.late, `...staged, counted on the Upload button at ${width}px`).toMatchObject({ labels: ['', ''], failed: [false, false], uploadShown: true, count: '2' });
        expect(r.late.uploadHit, `Upload is tappable for the late photos at ${width}px`).toEqual([]);
        expect(r.late.toast, `the late photos upload on the rep's tap at ${width}px`).toBe('✓ Uploaded 2 photos');
        expect(r.late.saved, `both late photos saved at ${width}px`).toBe(2);
      }
    } finally {
      await safeEvaluate(page, () => { const s = document.getElementById('e2e-force-standalone'); if (s) s.remove(); });
      await page.unroute('**/analyzePhotoVision');
      await page.setViewportSize({ width: 412, height: 860 });
    }
  });
});

// Desktop keeps its layout: no bar, no launcher, the classic FAB stack, and
// the jump landing fix (the doubled offset was a desktop bug too).
test.describe.serial('customer page chrome on desktop @audit', () => {
  let creds = null;
  let ctx;
  let page;
  let leadId;
  let run = '';

  test.beforeAll(async ({ browser }, testInfo) => {
    try { creds = requireTestUser(); } catch (e) { return; }
    testInfo.setTimeout(120_000);
    const stamp = Date.now();
    run = `phone-chrome@desktop:${stamp}`;
    ctx = await browser.newContext(contextOptions(testInfo, { viewport: { width: 1280, height: 860 } }));
    page = await ctx.newPage();
    await prepare(page);
    await loginAs(page, creds);
    leadId = await seedLead(page, stamp, run);
    expect(leadId, 'seeded lead').toBeTruthy();
    await openCustomer(page, leadId);
    await page.waitForTimeout(2_000); // past the bar's 1.5s deferred render
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    const res = await deleteSeededRun({ page, context: ctx, creds, run });
    if (res.failed.length) console.warn('[phone-chrome desktop] cleanup: ' + res.failed.join('; '));
    if (ctx) await ctx.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('no phone chrome on desktop; FABs stay a tappable stack; jumps land under the bar', async () => {
    const r = await safeEvaluate(page, () => {
      const vis = (id) => { const el = document.getElementById(id); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none'; };
      return { bar: vis('nbd-quick-action-bar'), dial: vis('nbd-fab-dial') };
    });
    expect(r.bar, 'quick-action bar hidden on desktop').toBe(false);
    expect(r.dial, 'speed-dial launcher hidden on desktop').toBe(false);
    expect(covered(await hitReport(page, '#nbd-whisper-fab, #nbd-qc-fab, #nbd-qci-fab')), 'desktop FAB stack').toEqual([]);

    await page.locator('#tabBar a[href="#photosTab"]').click();
    await page.waitForTimeout(900);
    const j = await safeEvaluate(page, () => ({
      navBottom: document.getElementById('tabBar').getBoundingClientRect().bottom,
      secTop: document.getElementById('photosTab').getBoundingClientRect().top,
    }));
    expect(j.secTop, 'section starts below the bar').toBeGreaterThanOrEqual(j.navBottom - 1);
    expect(j.secTop - j.navBottom, 'gap between bar and section').toBeLessThanOrEqual(24);
  });

  test('a toast raised mid-upload stacks above the upload indicator, and drops back after', async () => {
    // Desktop had the same overlap (widget bottom:16px, toasts bottom:20px,
    // both right-aligned): "View details" sat under every toast.
    await safeEvaluate(page, () => document.querySelectorAll('#toastContainer > div').forEach((d) => d.remove()));
    const measure = () => safeEvaluate(page, () => {
      const w = document.getElementById('nbdUploadWidget');
      const wr = w.getBoundingClientRect();
      const t = [...document.querySelectorAll('#toastContainer > div')].filter((d) => /Job costs saved/.test(d.textContent)).pop();
      // A toast that has timed out reads as "not dropped back" (null), not a
      // TypeError that hides which assertion failed.
      if (!t) return { active: w.classList.contains('active'), overlap: null, reopenOk: null, toastBottom: null };
      const tr = t.getBoundingClientRect();
      const re = document.getElementById('nbdUploadWidgetReopen').getBoundingClientRect();
      const h = document.elementFromPoint(re.left + re.width / 2, re.top + re.height / 2);
      return {
        active: w.classList.contains('active'),
        overlap: w.classList.contains('active') && !(tr.bottom <= wr.top || tr.top >= wr.bottom || tr.right <= wr.left || tr.left >= wr.right),
        reopenOk: !w.classList.contains('active') || (!!h && h.id === 'nbdUploadWidgetReopen'),
        toastBottom: tr.bottom,
      };
    });
    try {
      // The real show path (see raiseUploadIndicator), then the toast.
      const lifted = await raiseUploadIndicator(page, { touch: false });
      expect(lifted.lift, 'the indicator publishes its lift as it shows').toBe(`${lifted.height + 8}px`);
      await safeEvaluate(page, () => window.showToast('Job costs saved', 'success'));
      await expect(page.locator('#toastContainer > div', { hasText: 'Job costs saved' }).last()).toBeVisible();
      const up = await measure();
      expect(up.overlap, 'toast vs upload indicator').toBe(false);
      expect(up.reopenOk, '"View details" is not under the toast').toBe(true);
      // Upload finished: the widget hides and the stack settles back down.
      await finishUpload(page);
      await expect(page.locator('#nbdUploadWidget.active')).toHaveCount(0);
      await expect.poll(async () => (await measure()).toastBottom, { message: 'toast drops back once the indicator hides' }).toBeGreaterThan(up.toastBottom + 40);
    } finally {
      await finishUpload(page);
    }
  });

  // See viewDetailsMidBatch. On desktop the indicator and the toasts also
  // shared the FAB column: the mic (right 20px, 54px wide) covered the right
  // end of "View details", and a toast lifted above the indicator landed on
  // the Quick Capture FAB. Both now step sideways out of the column
  // (--nbd-toast-right), the dashboard's call for its toasts.
  test('"View details" mid-upload keeps the batch, clear of the FAB column; a failure is counted, not hidden', async () => {
    test.setTimeout(180_000);
    await page.route('**/analyzePhotoVision', answerPhotoVision);
    try {
      await safeEvaluate(page, () => document.querySelectorAll('#toastContainer > div').forEach((d) => d.remove()));
      const r = await viewDetailsMidBatch(page, {
        touch: false,
        leadId,
        beforeReopen: async (out) => {
          await safeEvaluate(page, () => window.showToast('Customer info updated', 'success'));
          await expect(page.locator('#toastContainer > div', { hasText: 'Customer info updated' }).last()).toBeVisible();
          out.withToast = await safeEvaluate(page, () => {
            const meets = (a, b) => !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
            const lanes = [['the upload indicator', document.getElementById('nbdUploadWidget')]]
              .concat([...document.querySelectorAll('#toastContainer > div')].map((t) => ['a toast', t]));
            const fab = (id) => {
              const el = document.getElementById(id);
              const b = el.getBoundingClientRect();
              const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return {
                tappable: !!hit && (hit === el || el.contains(hit)),
                under: lanes.filter(([, l]) => meets(l.getBoundingClientRect(), b)).map(([n]) => n),
              };
            };
            return { qc: fab('nbd-qc-fab'), mic: fab('nbd-whisper-fab') };
          });
          out.edgesWithToast = await edgeHits(page, '#nbdUploadWidgetReopen');
        },
      });
      expect(r.startedWith, 'one photo in flight, two waiting').toEqual([true, false, false]);
      expect(r.widgetCount, 'the indicator counts the whole batch').toMatch(/^1 \/ 3\b/);
      expect(r.reopenEdges, '"View details" end to end (the mic sat on its right end)').toEqual([]);
      expect(r.edgesWithToast, '"View details" end to end while a toast shows').toEqual([]);
      expect(r.withToast.qc, 'Quick Capture FAB while a toast shows mid-upload').toEqual({ tappable: true, under: [] });
      expect(r.withToast.mic, 'dictation mic while a toast shows mid-upload').toEqual({ tappable: true, under: [] });
      expect(r.reopened.queued, 'View details kept the batch queued').toBe(3);
      expect(r.reopened.tiles, 'the reopened modal shows the whole batch').toBe(3);
      expect(r.reopened.inFlight, 'still exactly one in flight').toBe(1);
      expect(r.reopened.progressShown, 'the photo in flight shows its progress').toBe(true);
      expect(r.starts, 'all three photos reached Storage').toBe(3);
      expect(r.saved, 'all three photos saved').toBe(3);
      expect(r.toast).toMatch(/^✓ Uploaded 3 photos$/);
      expect(toastUploaded(r.toast), 'the toast counts what saved').toBe(r.saved);
      expect(r.after, 'the finished batch clears and closes').toEqual({ queued: 0, modalOpen: false });

      // Photo 2 is refused. The old loop aborted the whole batch on the first
      // error — photo 3 was never sent — and reported only "Some uploads
      // failed". The batch now carries on and the toast says what happened.
      // Photo 3 is the one held, so View details opens on a batch with the
      // failure already in it; the refused photo's tile used to go on reading
      // "0%" (#1773 review). The rep then puts the modal away until the end.
      await safeEvaluate(page, () => document.querySelectorAll('#toastContainer > div').forEach((d) => d.remove()));
      const f = await viewDetailsMidBatch(page, {
        touch: false,
        leadId,
        fail: [2],
        holdAt: 3,
        beforeRelease: async () => {
          await page.locator('#uploadModal button.btn[data-action="closeUploadModal"]').click();
          await expect(page.locator('#uploadModal.open')).toHaveCount(0);
        },
      });
      expect(f.reopened.queued, 'View details kept the batch queued (failure run)').toBe(3);
      expect(f.reopenedTiles.failed, 'the reopened modal marks the photo that failed').toEqual([false, true, false]);
      expect(f.reopenedTiles.labels[1], '...and says so on its tile').toBe('Failed');
      expect(f.starts, 'photo 3 was still sent after photo 2 failed').toBe(3);
      expect(f.saved, 'photos 1 and 3 saved').toBe(2);
      expect(toastUploaded(f.toast), 'the toast counts what saved, not what was queued').toBe(f.saved);
      expect(f.toast, 'the toast owns up to the failure, in words').toBe('Uploaded 2 of 3 photos — 1 failed (permission denied)');
      expect(f.toastFits, 'the failure toast keeps its text inside it').toBe(true);
      expect(f.after, 'the batch ends holding only the photo that failed').toEqual({ queued: 1, modalOpen: false });

      // Opening the modal again shows the photo that did not save, marked. It
      // used to empty with the batch, and a rep who had the modal shut was
      // left with a 9-second toast to remember which shot to pick again. A
      // record, not a retry: the Upload button neither counts nor shows for it.
      await page.locator('[data-action="openUploadModal"]:visible').first().click();
      await page.waitForSelector('#uploadModal.open #uploadZone');
      expect(await uploadTiles(page), 'the failed photo waits in the reopened modal, marked')
        .toEqual({ labels: ['Failed'], failed: [true], uploadShown: false, count: '0' });

      // The rep picks that shot again. It is the whole next batch — not
      // "2 / 2 • 1 failed" with the dead tile riding along.
      const again = await holdStorageUploads(page, {});
      try {
        const savedBefore = await photoDocCount(page, leadId);
        await page.locator('#fileInput').setInputFiles({ name: 'again.png', mimeType: 'image/png', buffer: PNG_1PX });
        await expect(page.locator('#uploadCount'), 'the re-picked photo alone is counted').toHaveText('1', { timeout: 15_000 });
        await page.locator('#uploadBtn').click();
        await expect.poll(() => again.starts(), { message: 'the re-picked photo reaches Storage', timeout: 20_000 }).toBe(1);
        const mid = await safeEvaluate(page, () => ({
          indicator: document.getElementById('nbdUploadWidgetCount').textContent.trim(),
          tiles: document.querySelectorAll('#uploadPreview .preview-item').length,
        }));
        expect(mid.indicator, 'the next batch counts only itself').toMatch(/^1 \/ 1 • \d+%$/);
        expect(mid.tiles, 'the next batch leaves the failed tile behind').toBe(1);
        again.release();
        await expect(page.locator('#toastContainer > div', { hasText: '✓ Uploaded 1 photo' }).last()).toBeVisible({ timeout: 30_000 });
        expect((await photoDocCount(page, leadId)) - savedBefore, 'the re-picked photo saved').toBe(1);
        await expect(page.locator('#uploadModal.open'), 'the finished batch closes the modal').toHaveCount(0);
        expect(await safeEvaluate(page, () => window._uploadQueue.length), '...and clears it').toBe(0);
      } finally {
        again.release();
        await again.stop();
        await safeEvaluate(page, () => { if (document.querySelector('#uploadModal.open')) window.closeUploadModal(); });
      }

      // Every open of the modal — and View details is one — used to bind
      // another drop listener to #uploadZone, so one dragged photo queued
      // once per open (five here) and uploaded that many copies.
      await safeEvaluate(page, () => document.querySelectorAll('#toastContainer > div').forEach((d) => d.remove()));
      await page.locator('[data-action="openUploadModal"]:visible').first().click();
      await page.waitForSelector('#uploadModal.open #uploadZone');
      await safeEvaluate(page, (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
        document.getElementById('uploadZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, PNG_1PX.toString('base64'));
      await expect(page.locator('#uploadCount')).not.toHaveText('0', { timeout: 10_000 });
      await page.waitForTimeout(500); // every duplicate's FileReader has landed
      expect(await safeEvaluate(page, () => window._uploadQueue.length), 'one dropped photo queues once').toBe(1);
      await page.locator('#uploadModal button.btn[data-action="closeUploadModal"]').click();
      await expect(page.locator('#uploadModal.open')).toHaveCount(0);
    } finally {
      await page.unroute('**/analyzePhotoVision');
    }
  });
});
