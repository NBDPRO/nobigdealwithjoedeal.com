// tests/e2e/phone-portal.spec.js — the homeowner pages, on a phone.
//
// Jo's standing rule (2026-09-24): NBD Pro must fit and work flawlessly on a
// phone. The homeowner portal (/pro/portal.html) and the itemized estimate
// (/pro/estimate-view.html) are the two pages a CUSTOMER opens, from a text,
// on a phone — a broken one costs a job. The 2026-09-25 phone audit found
// eight defects here that no gate could see (homeowner#0/4/5/7/8/11/12/13);
// each block below pins one by BEHAVIOUR — a real tap, a real touch drag, a
// hit-test at the control's centre — never by a class name, because a
// class-name check is exactly how the pipeline menus stayed "green" for
// months while broken.
//
// Both pages call Cloud Functions the CI rig does not run, so every
// function is answered by context.route() with payloads shaped like
// functions/portal.js returns. Cal.com and BoldSign are stubbed too: nothing
// leaves the machine except Google Fonts.
//
// Tagged @shard2 for the authed emulator job. Run locally:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=... PLAYWRIGHT_TEST_USER_PASSWORD=... \
//     npx playwright test --config=playwright.config.js phone-portal.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { buildContract, measureContract, expectReadableOnPhone, expectPaperOnDesktop } = require('./fixtures/generated-contract');

const PHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 412, height: 860 },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
};
const TOKEN = 'PhonePortalTok0123456789';
const EST_ID = 'est_phone_portal';

// This spec belongs to the emulator job. Skip, like its siblings, when the
// job's credentials are absent (a prod-targeted run has no business
// answering the prod functions' URLs with mocks).
function skipWithoutCreds() {
  try { requireTestUser(); return false; } catch (_) { return true; }
}

// ── Mock backend ───────────────────────────────────────────────────
const FN_RE = /^(?:http:\/\/127\.0\.0\.1:5001\/nobigdeal-pro\/us-central1|https:\/\/us-central1-nobigdeal-pro\.cloudfunctions\.net)\/([A-Za-z]+)/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
const img = (n) => '/assets/images/' + n;
const MILESTONES = [
  { key: 'inspected', label: 'Inspection', blurb: 'We have looked at your property.' },
  { key: 'estimate_sent', label: 'Estimate', blurb: 'You have a written quote.' },
  { key: 'contract_signed', label: 'Contract', blurb: 'Signed and ready to schedule.' },
  { key: 'install', label: 'Installation', blurb: 'The crew is on the job.' },
  { key: 'complete', label: 'Complete', blurb: 'Project finished.' },
];

// kind: 'estimate' (awaiting signature: sign + booking embeds) or
// 'complete' (sliders, rating, warranty, referral — every input on the page).
function portalView(kind) {
  const idx = kind === 'complete' ? 4 : 1;
  const done = kind === 'complete';
  const pair = (b, a, location) => ({ location, before: { url: img(b) }, after: { url: img(a) } });
  return {
    homeowner: { firstName: 'Pat', lastName: 'Homeowner', address: '100 Test Ln, Loveland OH', customerId: 'NBD-0042' },
    rep: { displayName: 'Joe Deal', phone: '(859) 555-0100', calcomUsername: 'joedeal', calcomEventSlug: 'roof-inspection' },
    company: { name: 'No Big Deal Home Solutions', logoUrl: null, colors: null },
    progress: {
      milestones: MILESTONES, currentKey: MILESTONES[idx].key, currentIndex: idx, currentLabel: MILESTONES[idx].label,
      nextLabel: MILESTONES[idx + 1] ? MILESTONES[idx + 1].label : null,
      nextBlurb: MILESTONES[idx + 1] ? MILESTONES[idx + 1].blurb : null,
      scheduledDate: null, milestoneDates: {},
    },
    estimate: {
      id: EST_ID, grandTotal: 18430, tierName: 'Preferred',
      signatureStatus: done ? 'signed' : 'sent',
      signedAt: done ? '2026-09-09T15:00:00Z' : null,
      signEmbedUrl: done ? null : 'https://app.boldsign.com/document/sign/?documentId=phone-portal',
    },
    bookingUrl: 'https://cal.com/joedeal/roof-inspection',
    photos: [],
    photoPairs: done ? [pair('roofing-1.webp', 'drone-completed-brick.webp', 'Front slope'),
      pair('roofing-2.webp', 'roofing-4.webp', 'Back slope'), pair('roofing-3.webp', 'drone-hero-curb.webp', 'Garage')] : [],
    documents: [{ id: 'doc1', name: 'Roofing Contract', date: '2026-09-09T15:00:00Z', url: null, viaHtml: true }],
    balance: null,
    warranty: done ? { tier: 'preferred', tierLabel: 'NBD Preferred Warranty', installDate: '2026-09-20', certNumber: 'NBD-W-0042', openWarrantyClaimId: null } : null,
    tokenInfo: { daysRemaining: 27 },
    rating: { canRate: done, submitted: false, stars: null },
  };
}
const EST_LINES = [
  ['Tear off existing roofing — 1 layer', '28.40 SQ', 2130],
  ['GAF Timberline HDZ architectural shingles (Charcoal)', '31.20 SQ', 7488],
  ['GAF WeatherWatch ice & water shield — eaves, valleys, penetrations', '6 RL', 810],
  ['Replace damaged decking (7/16" OSB) — as needed, per sheet', '8 SHT', 640],
  ['Permit and inspection', '1 EA', 180],
].map(([name, quantity, lineTotal]) => ({ name, quantity, unit: '', lineTotal }));
const EST_PAYLOAD = {
  estimate: { id: EST_ID, tier: 'better', grandTotal: 11248, lines: EST_LINES, number: 'EST-2026-0188',
    owner: 'Pat Homeowner', addr: '100 Test Ln, Loveland OH', tiers: null, photos: [] },
  company: { name: 'No Big Deal Home Solutions', logoUrl: null, colors: null },
};

// estimate: a function (route) => void to override getEstimateForView.
// Only the homeowner pages' own functions are answered; anything else (the
// rep dashboard's callables, in the preview test) falls through untouched.
const HOMEOWNER_FNS = new Set(['getHomeownerPortalView', 'getEstimateForView', 'getPortalMessages',
  'getPortalDocumentHtml', 'recordCustomerEvent']);
async function mockBackend(context, { kind = 'estimate', estimate, doc } = {}) {
  await context.route(FN_RE, async (route) => {
    const req = route.request();
    const fn = FN_RE.exec(req.url())[1];
    if (!HOMEOWNER_FNS.has(fn)) return route.fallback();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (body, status) => route.fulfill({ status: status || 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (fn === 'getHomeownerPortalView') return json(portalView(kind));
    if (fn === 'getEstimateForView') return estimate ? estimate(route) : json(EST_PAYLOAD);
    if (fn === 'getPortalMessages') return json({ messages: [] });
    if (fn === 'getPortalDocumentHtml') {
      if (doc) return doc(route);
      return json({ html: '<!doctype html><html><body style="font:16px sans-serif;padding:16px">'
        + '<p>Contract text.</p>'.repeat(60) + '</body></html>' });
    }
    return json({ ok: true });
  });
  const stub = (title) => '<!doctype html><html><body style="font-family:sans-serif;margin:0;padding:12px">'
    + '<h3>' + title + '</h3>' + '<p>Stub line.</p>'.repeat(120) + '</body></html>';
  await context.route(/^https:\/\/cal\.com\//, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: stub('Booking') }));
  await context.route(/^https:\/\/app\.boldsign\.com\//, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: stub('Signer') }));
}

async function openPortal(page, kind, { mocked = false, doc } = {}) {
  if (!mocked) await mockBackend(page.context(), { kind, doc });
  await page.goto('/pro/portal.html?token=' + TOKEN);
  await page.waitForSelector('#mainWrap .card', { timeout: 15_000 });
}

// The control's centre must hit the control (or a child of it) — not the
// Live pill, not an iframe, not nothing.
async function hitsItself(page, selector) {
  return safeEvaluate(page, (sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit)) ? 'ok' : 'covered by ' + (hit ? hit.tagName + '#' + hit.id + '.' + hit.className : 'nothing');
  }, selector);
}

// A real finger drag through Chrome's input pipeline (touch-action, scroll
// chaining, pointercancel all apply), not synthetic DOM events.
async function touchDrag(page, x, y, dx, dy) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 12;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(600); // let any fling settle before measuring
}

const scrollY = (page) => safeEvaluate(page, () => Math.round(window.scrollY));

// homeowner#2's portal half: a REAL generated contract (the generator runs
// in the rep's signed-in dashboard — the only place its bundle loads), served
// as getPortalDocumentHtml's html, opened with the homeowner's "View".
// Returns the document's frame once the contract is in it.
async function openContractInPortal(page, kind, { touch = true } = {}) {
  await loginAs(page, requireTestUser());
  const contract = await buildContract(page);
  expect(contract, 'generator produced a contract').toMatch(/class="document-container"/);
  await openPortal(page, kind, {
    doc: (route) => route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ html: contract }) }),
  });
  const view = page.locator('.portal-doc-view').first();
  await view.scrollIntoViewIfNeeded();
  if (touch) await view.tap(); else await view.click();
  await page.waitForSelector('.doc-modal-overlay.open .doc-modal-iframe', { state: 'visible', timeout: 15_000 });
  const f = await (await page.$('.doc-modal-iframe')).contentFrame();
  await f.waitForFunction(() => !!document.querySelector('.document-container .document-header'), null, { timeout: 15_000 });
  return f;
}

// ═══════════════════════════════════════════════════════════════════
test.describe('phone portal: the estimate page @shard2 @phoneportal', () => {
  test.use(PHONE);
  test.skip(skipWithoutCreds(), 'PLAYWRIGHT_TEST_USER_* not set');

  // homeowner#0 — "Back" was history.back(), which does nothing in the new
  // tab the portal opens (history.length 1). All three ways in must land on
  // the homeowner's portal.
  test('Back reaches the portal from the portal\'s new tab, a texted link, and a same-tab visit', async ({ page, context }) => {
    await openPortal(page, 'estimate');
    const link = page.getByRole('link', { name: /what.s included/i });
    await link.scrollIntoViewIfNeeded();
    const [tab] = await Promise.all([context.waitForEvent('page'), link.tap()]);
    await tab.waitForSelector('.ev-grand', { timeout: 15_000 });
    expect(await tab.evaluate(() => history.length), 'the portal opens the estimate in a fresh tab').toBe(1);
    expect(await hitsItself(tab, '[data-ev-action="back"]')).toBe('ok');
    const back = tab.locator('[data-ev-action="back"]');
    await back.tap();
    await expect(tab, 'new tab: tapping Back lands on the project').toHaveURL(/\/pro\/portal(\.html)?\?token=/, { timeout: 10_000 });
    expect(new URL(tab.url()).searchParams.get('token'), 'new tab: ...the same project').toBe(TOKEN);
    await tab.close();

    // A link texted to the homeowner: fresh page, no referrer.
    const direct = await context.newPage();
    await direct.goto('/pro/estimate-view.html?token=' + TOKEN + '&estimateId=' + EST_ID);
    await direct.waitForSelector('.ev-grand', { timeout: 15_000 });
    await expect(direct.locator('[data-ev-action="back"]'), 'says where it goes').toHaveText('Back to your project');
    await direct.locator('[data-ev-action="back"]').tap();
    await expect(direct, 'texted link: tapping Back lands on the project').toHaveURL(/\/pro\/portal(\.html)?\?token=/, { timeout: 10_000 });
    await direct.close();

    // Same tab (portal → estimate here): Back returns through history, so
    // the portal comes back where it was instead of stacking a new copy. A
    // back navigation leaves history.length alone; following the link would
    // have added an entry.
    await page.evaluate(() => { const a = [...document.querySelectorAll('a')].find((x) => /included/i.test(x.textContent)); a.target = '_self'; });
    await Promise.all([page.waitForURL(/estimate-view/), link.tap()]);
    await page.waitForSelector('.ev-grand', { timeout: 15_000 });
    const depth = await page.evaluate(() => history.length);
    await page.locator('[data-ev-action="back"]').tap();
    await expect(page).toHaveURL(/\/pro\/portal(\.html)?\?token=/, { timeout: 10_000 });
    await page.waitForSelector('#mainWrap .card', { timeout: 15_000 });
    expect(await page.evaluate(() => history.length), 'same tab: Back goes back through history').toBe(depth);
  });

  // homeowner#7 — a dropped connection printed the browser's "Failed to
  // fetch" as one red line with nothing to tap.
  test('a dropped connection shows homeowner copy, and Try again recovers', async ({ page }) => {
    let offline = true;
    await mockBackend(page.context(), {
      estimate: (route) => (offline ? route.abort('internetdisconnected')
        : route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(EST_PAYLOAD) })),
    });
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      offline = true;
      await page.goto('/pro/estimate-view.html?token=' + TOKEN + '&estimateId=' + EST_ID);
      await expect(page.locator('#evRoot .ev-error')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#evRoot'), `${width}px: no raw browser error`).not.toContainText(/failed to fetch|typeerror/i);
      await expect(page.getByRole('heading', { name: /couldn.t load your estimate/i })).toBeVisible();
      await expect(page.locator('#evRoot')).toContainText(/check your connection/i);
      expect(await hitsItself(page, '[data-ev-action="retry"]'), `${width}px Try again`).toBe('ok');
      expect(await hitsItself(page, '[data-ev-action="back"]'), `${width}px Back`).toBe('ok');
      expect(await page.getByRole('link', { name: 'Back to your project' }).getAttribute('href')).toContain('token=' + TOKEN);
      offline = false;
      await page.getByRole('button', { name: 'Try again' }).tap();
      await expect(page.locator('.ev-grand'), `${width}px: Try again loads the estimate`).toBeVisible({ timeout: 15_000 });
    }
  });

  test('an expired link says so, without a retry or portal link that cannot work', async ({ page }) => {
    await mockBackend(page.context(), {
      estimate: (route) => route.fulfill({ status: 410, headers: CORS, contentType: 'application/json', body: '{"error":"This link has expired."}' }),
    });
    await page.goto('/pro/estimate-view.html?token=' + TOKEN + '&estimateId=' + EST_ID);
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#evRoot a, #evRoot button')).toHaveCount(0);
  });

  // homeowner#12 — two 80px column floors left the description 110px wide
  // at 360 and wrapped it to four lines.
  test('line items give the description the width on a phone', async ({ page }) => {
    await mockBackend(page.context());
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await page.goto('/pro/estimate-view.html?token=' + TOKEN + '&estimateId=' + EST_ID);
      await page.waitForSelector('.ev-line', { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      const rows = await safeEvaluate(page, () => [...document.querySelectorAll('.ev-line')].map((li) => {
        const name = li.querySelector('.ev-line-name');
        const lh = parseFloat(getComputedStyle(name).lineHeight) || 20;
        return { row: li.getBoundingClientRect().width, name: name.getBoundingClientRect().width,
          lines: Math.round(name.getBoundingClientRect().height / lh), text: name.textContent.slice(0, 30) };
      }));
      for (const r of rows) {
        expect(r.name / r.row, `${width}px "${r.text}": description gets most of the row`).toBeGreaterThan(0.6);
        expect(r.lines, `${width}px "${r.text}": wraps to at most two lines`).toBeLessThanOrEqual(2);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
test.describe('phone portal: the project page @shard2 @phoneportal', () => {
  test.use(PHONE);
  test.skip(skipWithoutCreds(), 'PLAYWRIGHT_TEST_USER_* not set');

  // homeowner#4 — touch-action:none + preventDefault on pointerdown made
  // every touch on a slider a drag, so a thumb on one could not scroll.
  test('a vertical swipe on a before/after slider scrolls the page; a sideways drag still slides', async ({ page }) => {
    await openPortal(page, 'complete');
    await page.waitForSelector('#ba-card .nbd-ba', { timeout: 15_000 });
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      const box = await safeEvaluate(page, () => {
        const el = document.querySelector('#ba-card .nbd-ba');
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
      await page.waitForTimeout(300);
      const handle = () => safeEvaluate(page, () => document.querySelector('#ba-card .nbd-ba-handle').style.left || '50%');
      const y0 = await scrollY(page);
      const h0 = await handle();
      // Thumb lands on the photo (off the grip) and swipes up to keep reading.
      await touchDrag(page, box.x + box.w * 0.75, box.y + box.h * 0.7, 0, -250);
      const y1 = await scrollY(page);
      expect(y1 - y0, `${width}px: swipe up on a slider scrolls the page`).toBeGreaterThan(100);
      expect(await handle(), `${width}px: ...without yanking the handle`).toBe(h0);

      const b2 = await safeEvaluate(page, () => {
        const r = document.querySelector('#ba-card .nbd-ba').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
      });
      await touchDrag(page, b2.x, b2.y, -b2.w * 0.3, 0);
      expect(parseFloat(await handle()), `${width}px: a sideways drag moves the handle`).toBeLessThan(35);
      expect(await scrollY(page), `${width}px: ...and does not scroll`).toBe(y1);

      // A plain tap still reveals up to the tapped point.
      const slider = page.locator('#ba-card .nbd-ba').first();
      const sb = await slider.boundingBox();
      await slider.tap({ position: { x: sb.width * 0.8, y: sb.height / 2 } });
      expect(parseFloat(await handle()), `${width}px: a tap moves the handle to the tap`).toBeGreaterThan(70);
    }
  });

  // homeowner#5 — both embeds were 820px on phones, taller than the
  // screen, so every swipe landed inside one.
  test('the signing embed leaves page to scroll by, and booking is a button on a phone', async ({ page, context }) => {
    await openPortal(page, 'estimate');
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      const frame = await safeEvaluate(page, () => {
        const f = document.querySelector('iframe[title="Sign Contract"]');
        window.scrollTo(0, f.getBoundingClientRect().top + window.scrollY - 20);
        const r = f.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: r.height, vh: window.innerHeight };
      });
      await page.waitForTimeout(300);
      expect(frame.h, `${width}px: signing frame is shorter than the screen`).toBeLessThanOrEqual(frame.vh - 200);
      // With the frame at the top of the screen, a thumb in the lower part
      // of the screen is on the PAGE and scrolls it.
      const sx = width / 2, sy = frame.vh - 60;
      const under = await safeEvaluate(page, ([x, y]) => document.elementFromPoint(x, y).tagName, [sx, sy]);
      expect(under, `${width}px: thumb zone below the frame is page, not frame`).not.toBe('IFRAME');
      const y0 = await scrollY(page);
      await touchDrag(page, sx, sy, 0, -300);
      expect((await scrollY(page)) - y0, `${width}px: swipe below the frame scrolls the page`).toBeGreaterThan(100);

      const cal = await safeEvaluate(page, () => {
        const f = document.querySelector('iframe[title="Schedule"]');
        const r = f.getBoundingClientRect();
        return r.width * r.height;
      });
      expect(cal, `${width}px: no inline booking calendar to get trapped in`).toBe(0);
    }
    const book = page.getByRole('link', { name: /open booking page/i });
    expect(await hitsItself(page, 'a[href^="https://cal.com/"].btn')).toBe('ok');
    const [calTab] = await Promise.all([context.waitForEvent('page'), book.tap()]);
    await calTab.waitForLoadState('domcontentloaded');
    expect(calTab.url(), 'the booking button opens Cal.com').toMatch(/^https:\/\/cal\.com\//);
    await calTab.close();
  });

  // homeowner#8 — 12-14px fields make iOS Safari zoom on focus. Chromium
  // cannot show the zoom; the computed size is the contract.
  test('every text field is at least 16px and takes a real tap', async ({ page }) => {
    await openPortal(page, 'complete');
    await page.locator('.cr-star').first().tap(); // reveals the rating comment
    await page.setInputFiles('#cuh-file', {
      name: 'roof.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    });
    await page.waitForSelector('#cuh-caption', { timeout: 10_000 });
    const ids = ['pm-text', 'cb-note', 'cr-comment', 'wc-issue', 'rf-link', 'cuh-caption'];
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      for (const id of ids) {
        expect(await hitsItself(page, '#' + id), `${width}px #${id} reachable`).toBe('ok');
        await page.locator('#' + id).tap();
        expect(await page.evaluate(() => document.activeElement && document.activeElement.id), `${width}px tap focuses #${id}`).toBe(id);
        const px = await page.evaluate((i) => parseFloat(getComputedStyle(document.getElementById(i)).fontSize), id);
        expect(px, `${width}px #${id} font-size (iOS zooms under 16px)`).toBeGreaterThanOrEqual(16);
      }
    }
  });

  // homeowner#11 — 9px labels, ellipsized to "Installa…" at 320 and in the
  // rep's 318px Preview Portal frame.
  test('milestone names are readable and whole at 412, 360 and 320', async ({ page }) => {
    await openPortal(page, 'complete');
    await page.evaluate(() => document.fonts.ready);
    for (const width of [412, 360, 320]) {
      await page.setViewportSize({ width, height: 860 });
      await page.waitForTimeout(200);
      const labels = await safeEvaluate(page, () => [...document.querySelectorAll('.progress-step-label')].map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = range.getBoundingClientRect();
        return { text: el.textContent, px: parseFloat(getComputedStyle(el).fontSize),
          clipped: el.scrollWidth > el.clientWidth + 0.5, left: t.left, right: t.right };
      }));
      expect(labels.length).toBe(5);
      labels.forEach((l, i) => {
        expect(l.px, `${width}px "${l.text}" font-size`).toBeGreaterThanOrEqual(11);
        expect(l.clipped, `${width}px "${l.text}" is not cut off`).toBe(false);
        if (i) expect(l.left, `${width}px "${l.text}" does not run into "${labels[i - 1].text}"`).toBeGreaterThanOrEqual(labels[i - 1].right);
      });
    }
  });

  // homeowner#13 — the Live pill took taps meant for the controls under it
  // and drew on top of the document viewer.
  test('the Live pill lets taps through and sits under the document viewer', async ({ page }) => {
    await openPortal(page, 'complete');
    await page.waitForSelector('#livePill');
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      // Put "Choose a photo" right under the pill, then tap the pill where
      // it overlaps the button (the pill hangs past the button's right end,
      // so its own centre is on the card edge).
      const at = await safeEvaluate(page, () => {
        const btn = document.getElementById('cuh-pick');
        const pill = document.getElementById('livePill').getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        window.scrollBy(0, (b.top + b.height / 2) - (pill.top + pill.height / 2));
        window.__pickTaps = 0;
        if (!window.__pickCounted) {
          btn.addEventListener('click', () => { window.__pickTaps++; });
          window.__pickCounted = true;
        }
        const p = document.getElementById('livePill').getBoundingClientRect();
        const r = btn.getBoundingClientRect();
        return { x: (p.left + Math.min(p.right, r.right)) / 2, y: p.top + p.height / 2 };
      });
      await page.waitForTimeout(200);
      const top = await safeEvaluate(page, ([x, y]) => { const h = document.elementFromPoint(x, y); return h && (h.closest('#cuh-pick') ? 'cuh-pick' : h.id || h.tagName); }, [at.x, at.y]);
      expect(top, `${width}px: under the pill, the button is what a tap hits`).toBe('cuh-pick');
      await page.touchscreen.tap(at.x, at.y);
      expect(await page.evaluate(() => window.__pickTaps), `${width}px: a tap on the pill reaches "Choose a photo"`).toBe(1);
    }
    await page.locator('.portal-doc-view').first().tap();
    await page.waitForSelector('.doc-modal-overlay.open', { timeout: 10_000 });
    const onTop = await safeEvaluate(page, () => {
      const p = document.getElementById('livePill').getBoundingClientRect();
      const pill = document.getElementById('livePill');
      pill.style.pointerEvents = 'auto'; // measure stacking, not hit-transparency
      const hit = document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2);
      pill.style.pointerEvents = '';
      return hit && hit.closest('#livePill') ? 'pill' : 'viewer';
    });
    expect(onTop, 'the open document viewer covers the pill').toBe('viewer');
  });

  // homeowner#7's sibling on this page: the document viewer printed the
  // server's log-style error string ("Not shared") to the homeowner.
  test('the document viewer explains a refused document in homeowner words', async ({ page }) => {
    await openPortal(page, 'complete', {
      doc: (route) => route.fulfill({ status: 403, headers: CORS, contentType: 'application/json', body: '{"error":"Not shared"}' }),
    });
    await page.locator('.portal-doc-view').first().tap();
    const status = page.locator('.doc-modal-status');
    await expect(status).toContainText(/ask your rep/i, { timeout: 10_000 });
    await expect(status).not.toContainText('Not shared');
    expect(await hitsItself(page, '.doc-modal-close'), 'the viewer can still be closed').toBe('ok');
  });

  // homeowner#2, second half — "Your Documents → View" showed the generated
  // contract at print size: 9px clause text (the 3-day cancellation notice
  // included) in a narrow column inside a card with a 16px margin. It now
  // shares sign.html's phone layout (js/doc-phone-layout.js), and on a phone
  // the viewer takes the whole screen that layout was sized for.
  test('a generated contract in Your Documents reads at phone size, on the whole screen', async ({ page }) => {
    test.setTimeout(120_000);
    const f = await openContractInPortal(page, 'complete');
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await page.waitForTimeout(200);
      const frame = await safeEvaluate(page, () => {
        const r = document.querySelector('.doc-modal-iframe').getBoundingClientRect();
        return { left: r.left, width: r.width };
      });
      expect(frame.left, `${width}px: the document starts at the screen edge`).toBeLessThanOrEqual(0.5);
      expect(frame.width, `${width}px: the document gets the whole width`).toBeGreaterThanOrEqual(width - 1);
      expectReadableOnPhone(expect, await f.evaluate(measureContract), width, 'portal');
      const close = await safeEvaluate(page, () => {
        const b = document.querySelector('.doc-modal-close').getBoundingClientRect();
        return { w: b.width, h: b.height };
      });
      expect(close.h, `${width}px: Close height`).toBeGreaterThanOrEqual(44);
      expect(close.w, `${width}px: Close width`).toBeGreaterThanOrEqual(44);
      expect(await hitsItself(page, '.doc-modal-close'), `${width}px: Close is reachable`).toBe('ok');
    }
    await page.locator('.doc-modal-close').tap();
    await expect(page.locator('.doc-modal-overlay'), 'a tap on Close closes the viewer').not.toHaveClass(/\bopen\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// The same pages at 1280 with a mouse: the phone fixes above are scoped,
// so desktop keeps its table, its inline calendar and its field sizes.
test.describe('phone portal: desktop unchanged @shard2 @phoneportal', () => {
  test.use({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  test.skip(skipWithoutCreds(), 'PLAYWRIGHT_TEST_USER_* not set');

  test('desktop keeps the line-item table, the inline calendar and its field sizes', async ({ page }) => {
    await mockBackend(page.context(), { kind: 'estimate' });
    await page.goto('/pro/estimate-view.html?token=' + TOKEN + '&estimateId=' + EST_ID);
    await page.waitForSelector('.ev-line', { timeout: 15_000 });
    const row = await safeEvaluate(page, () => {
      const li = document.querySelector('.ev-line');
      const n = li.querySelector('.ev-line-name').getBoundingClientRect();
      const q = li.querySelector('.ev-line-qty').getBoundingClientRect();
      return { sameLine: Math.abs(n.top - q.top) < 2, qtyW: Math.round(q.width) };
    });
    expect(row.sameLine, 'desktop: quantity stays in its own column').toBe(true);
    expect(row.qtyW).toBe(80);

    await openPortal(page, 'estimate', { mocked: true });
    const h = await safeEvaluate(page, () => ['Sign Contract', 'Schedule'].map((t) => Math.round(document.querySelector('iframe[title="' + t + '"]').getBoundingClientRect().height)));
    expect(h, 'desktop: both embeds keep 680px').toEqual([680, 680]);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('pm-text')).fontSize)).toBe('14px');
    await page.locator('#pm-text').click();
    expect(await page.evaluate(() => document.activeElement.id)).toBe('pm-text');
  });

  test('desktop: dragging a before/after slider with the mouse still slides it', async ({ page }) => {
    await openPortal(page, 'complete');
    const slider = page.locator('#ba-card .nbd-ba').first();
    await slider.scrollIntoViewIfNeeded();
    const b = await slider.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    const left = await page.evaluate(() => parseFloat(document.querySelector('#ba-card .nbd-ba-handle').style.left));
    expect(left, 'desktop: the handle follows the mouse').toBeLessThan(25);
  });

  test('desktop: a generated contract in Your Documents keeps its paper layout in the card', async ({ page }) => {
    test.setTimeout(120_000);
    const f = await openContractInPortal(page, 'complete', { touch: false });
    expectPaperOnDesktop(expect, await f.evaluate(measureContract), 'portal');
    expect(await f.evaluate(() => !!document.getElementById('nbd-doc-phone')), 'the phone sheet rides along (screen-only, inactive at this width)').toBe(true);
    const card = await safeEvaluate(page, () => Math.round(document.querySelector('.doc-modal').getBoundingClientRect().width));
    expect(card, 'desktop: the viewer stays an 820px card').toBe(820);
  });
});

// ═══════════════════════════════════════════════════════════════════
// homeowner#11's other surface: the rep's own 🔍 Preview Portal modal,
// which frames the portal at 318px on a 360 phone.
test.describe('phone portal: the rep preview @shard2 @phoneportal', () => {
  test.use({ ...PHONE, viewport: { width: 360, height: 800 } });
  test.skip(skipWithoutCreds(), 'PLAYWRIGHT_TEST_USER_* not set');

  test('the rep\'s portal preview shows every milestone name whole', async ({ page }) => {
    test.setTimeout(120_000);
    await mockBackend(page.context(), { kind: 'complete' });
    await loginAs(page, requireTestUser());
    const stamp = Date.now();
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function', { timeout: 30_000 });
    const leadId = await safeEvaluate(page, async (s) => {
      try {
        await window._saveLead({ firstName: '[E2E] Portal', lastName: String(s), address: `${String(s).slice(-3)} Preview Ln, Loveland, OH`,
          phone: '513' + String(s).slice(-7), email: `e2e-portal-${s}@nbd.test`, stage: 'new', e2eTestData: true });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      const fs = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
      const uid = (window._auth || window.auth).currentUser.uid;
      const snap = await fs.getDocs(fs.query(fs.collection(window.db || window._db, 'leads'),
        fs.where('userId', '==', uid), fs.where('lastName', '==', String(s)), fs.where('e2eTestData', '==', true)));
      let id = null; snap.forEach((d) => { if (!id) id = d.id; });
      return id;
    }, stamp);
    expect(leadId, 'seeded a lead to preview').toBeTruthy();
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await page.goto('/pro/customer.html?id=' + leadId); break; } catch (e) {
        if (!/ERR_ABORTED|interrupted by another navigation/.test(String(e)) || attempt === 2) throw e;
        await page.waitForTimeout(1_500);
      }
    }
    await safeWaitForFunction(page, () => window.CustomerPortal && typeof window.CustomerPortal.mintUrl === 'function', { timeout: 30_000 });
    const skip = page.getByText('Skip tour', { exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.tap().catch(() => {});
    // createPortalToken is a Cloud Function the rig does not run: stub only
    // the mint, so the real preview modal frames the (mocked) portal.
    await safeEvaluate(page, (tok) => { window.CustomerPortal.mintUrl = async () => location.origin + '/pro/portal.html?token=' + tok; }, TOKEN);
    const btn = page.locator('#quickPreviewPortalBtn');
    if (await skip.isVisible().catch(() => false)) await skip.tap().catch(() => {}); // a late-starting tour
    if (!(await btn.isVisible().catch(() => false))) await page.locator('#qaMoreBtn').tap();
    await btn.tap();
    const frame = page.frameLocator('#nbd-portal-preview-iframe');
    await frame.locator('.progress-step-label').first().waitFor({ timeout: 20_000 });
    const box = await page.locator('#nbd-portal-preview-iframe').boundingBox();
    expect(box.width, 'the preview frame is narrower than the phone').toBeLessThan(340);
    const labels = await frame.locator('.progress-step-label').evaluateAll((els) => els.map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const t = range.getBoundingClientRect();
      return { text: el.textContent, px: parseFloat(getComputedStyle(el).fontSize), clipped: el.scrollWidth > el.clientWidth + 0.5, left: t.left, right: t.right };
    }));
    expect(labels.length).toBe(5);
    labels.forEach((l, i) => {
      expect(l.px, `preview "${l.text}" font-size`).toBeGreaterThanOrEqual(11);
      expect(l.clipped, `preview "${l.text}" is not cut off`).toBe(false);
      if (i) expect(l.left, `preview "${l.text}" clear of "${labels[i - 1].text}"`).toBeGreaterThanOrEqual(labels[i - 1].right);
    });
  });
});
