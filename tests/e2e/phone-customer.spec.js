// tests/e2e/phone-customer.spec.js — the customer record on a phone.
//
// Jo runs the business from an Android at ~412px, and his standing rule
// (2026-09-24) is that the CRM must fit and work flawlessly there. The
// 2026-09-25 phone audit drove customer.html with real taps at 412 and 360
// and found the defects pinned below. phone-fit.spec.js cannot see any of
// them: it only switches dashboard views and never opens this page, never
// opens the Share Portal panel, and its seeded leads carry no uploaded
// file, no photos and no claim.
//
// Every assertion here is about BEHAVIOUR — a control's centre hit-tests
// to the control, a real tap lands, the page does not grow wider than the
// screen — never about which class is set. The pipeline menus stayed
// "green" for months behind a test that only checked `.open`.
//
// One login per describe: each describe seeds its own [E2E] lead (an
// insurance claim, one uploaded file, one generated file, and photos where
// needed) and shares one page across its tests. The only Cloud Function in
// reach, createPortalToken, is answered by page.route.
//
// Run locally against a served worktree:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=... PLAYWRIGHT_TEST_USER_PASSWORD=... \
//     npx playwright test --config=playwright.config.js phone-customer.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const HEIGHT = 860;

// ── shared rig ────────────────────────────────────────────────────────

async function phonePage(browser, testInfo, width) {
  const ctx = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    bypassCSP: !!testInfo.project.use.bypassCSP,
    viewport: { width, height: HEIGHT },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    userAgent: UA,
  });
  const page = await ctx.newPage();
  // _saveLead geocodes new addresses; OSM rate-limits CI IPs.
  await page.route('**/nominatim.openstreetmap.org/**', (r) =>
    r.fulfill({ contentType: 'application/json', body: '[]' }));
  return { ctx, page };
}

// Seeds on the dashboard (the only surface exposing _saveLead), then adds
// the subcollection rows and photos straight through the page's SDK.
async function seedLead(page, { photos }) {
  await safeWaitForFunction(page, () => typeof window._saveLead === 'function'
    && window._user && window._user.uid, { timeout: 20_000 });
  return safeEvaluate(page, async (n) => {
    const stamp = Date.now();
    try {
      await window._saveLead({
        firstName: '[E2E] Phone', lastName: String(stamp),
        address: String(stamp).slice(-4) + ' Wolfpen Pleasant Hill Rd, Milford, OH 45150',
        phone: '513' + String(stamp).slice(-7), email: 'e2e-phone-' + stamp + '@nbd.test',
        stage: 'claim-filed', jobType: 'insurance', insCarrier: 'State Farm',
        claimNumber: 'CLM-' + stamp, claimStatus: 'Claim Filed', e2eTestData: true,
      });
    } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    // Polled: under emulator load the write can land a beat after
    // _saveLead resolves (it returns null on the geocoded path).
    let id = null;
    for (let i = 0; i < 20 && !id; i++) {
      if (i) await new Promise((r) => setTimeout(r, 500));
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'leads'),
        fs.where('userId', '==', uid), fs.where('lastName', '==', String(stamp)),
        fs.where('e2eTestData', '==', true)));
      snap.forEach((d) => { id = id || d.id; });
    }
    if (!id) throw new Error('seeded lead not found');
    const img = (f) => location.origin + '/assets/images/' + f;
    // An UPLOADED row is the one that renders "Share with homeowner".
    await fs.addDoc(fs.collection(db, 'leads', id, 'documents'), {
      name: 'signed-contract-scan.png', url: img('joe-hero.jpg'), size: 4096,
      uploadedAt: new Date(), source: 'signed_upload', status: 'signed', signedAt: new Date(),
    });
    await fs.addDoc(fs.collection(db, 'leads', id, 'documents'), {
      filename: 'Roofing Contract', typeName: 'Roofing Contract', type: 'contract',
      htmlPath: 'e2e/none.html', createdAt: new Date(Date.now() - 86_400_000), status: 'draft',
    });
    const files = ['drone-hero-crew-800.webp', 'drone-completed-brick.webp', 'joe-hero.webp', 'drone-hero-curb.webp'];
    for (let i = 0; i < n; i++) {
      await fs.addDoc(fs.collection(db, 'photos'), {
        leadId: id, userId: uid, url: img(files[i % files.length]),
        phase: i < n / 2 ? 'Before' : 'During', createdAt: new Date(Date.now() - i * 60_000),
      });
    }
    return id;
  }, photos);
}

async function openCustomer(page, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto('/pro/customer.html?id=' + id); break; }
    catch (e) {
      if (!/ERR_ABORTED|interrupted by another navigation/.test(String(e)) || attempt === 2) throw e;
      await page.waitForTimeout(1_500);
    }
  }
  await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 25_000 });
  // Every surface the tests touch has painted.
  await safeWaitForFunction(page, () =>
    !!document.querySelector('#docList [data-doc-homeowner-share]')
    && !!document.querySelector('#insurancePanel [data-action="openClaimEditor"]')
    && !!document.querySelector('#insuranceClaimWorkflow .claim-stages'), { timeout: 25_000 });
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  // Late panels (the header's suggested-action card, lead score, cover)
  // keep pushing the page down for a while after hydration; a control
  // scrolled to mid-screen before that ends up under the bottom bar.
  await safeEvaluate(page, async () => {
    let last = -1, stable = 0;
    for (let i = 0; i < 25 && stable < 3; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const h = document.documentElement.scrollHeight;
      stable = h === last ? stable + 1 : 0;
      last = h;
    }
  });
}

// Where a control really is, and what a finger at its centre would touch.
// `width` is the SCREEN width: the Share Portal bug widened the layout
// viewport (innerWidth 455 on a 412 screen), so innerWidth cannot be the
// yardstick for "on screen".
async function probe(page, selector, width) {
  return page.evaluate(({ sel, W }) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null;
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const at = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h)); };
    const hit = h => (h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') + (typeof h.className === 'string' && h.className ? '.' + h.className.split(' ')[0] : '') : 'nothing');
    const onScreen = cx >= 0 && cx <= W && cy >= 0 && cy <= innerHeight;
    // Rendered text lines: cluster the tops of the text's line boxes (an
    // emoji and the text beside it can sit a pixel or two apart).
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0)
      .map((b) => b.top).sort((a, b) => a - b);
    let lines = 0;
    tops.forEach((t, i) => { if (i === 0 || t - tops[i - 1] > 6) lines++; });
    return {
      found: true, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, lines,
      onScreen, hitsCentre: onScreen && at(cx, cy),
      hitsTopEdge: at(cx, r.top + 3), hitsBottomEdge: at(cx, r.bottom - 3),
      topmost: onScreen ? hit(document.elementFromPoint(cx, cy)) : 'off-screen',
    };
  }, { sel: selector, W: width });
}

// A finger at the control's centre lands on the control. Polled for a few
// seconds so a toast or a chrome bar sliding past cannot flake it; a
// control that is off-screen or under something fails every poll, and the
// failure names what is on top.
// With `edges`, a finger landing 3px inside the top or bottom edge must
// land on it too — that is what a bigger tap target actually buys. With
// `center`, each poll first scrolls the page (vertically — all a thumb can
// do) to put the control mid-screen, so a late layout shift cannot leave
// it under the bottom bar; never used where the page position IS the test
// (the pinned bulk bar).
async function expectHit(page, selector, width, what, opts) {
  const { edges, center } = opts || {};
  await expect.poll(async () => {
    if (center) await toMid(page, selector);
    const p = await probe(page, selector, width);
    if (!p.found) return 'missing';
    if (!p.hitsCentre) return p.topmost;
    if (edges && !(p.hitsTopEdge && p.hitsBottomEdge)) return 'centre only, not its edges';
    return 'hit';
  }, { message: what + ' — a finger on it must land on it', timeout: 4_000 }).toBe('hit');
}

// Brings an element to mid-screen by scrolling the PAGE only.
async function toMid(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - innerHeight * 0.45);
  }, selector);
  await page.waitForTimeout(250);
}

async function pageWidth(page) {
  return page.evaluate(() => ({ inner: window.innerWidth, innerH: window.innerHeight, scroll: document.documentElement.scrollWidth }));
}

function skipWithoutCreds() {
  try { return requireTestUser(); }
  catch (e) { console.warn('[phone-customer] ' + e.message); return null; } // eslint-disable-line no-console
}

// Share Portal: tap More, tap Share Portal, then the panel's 👁 must be on
// the screen, hit-testable and live, and the page must not have widened.
async function shareeyeJourney(page, ctx, width, tokenCalls) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const more = page.locator('#qaMoreBtn');
  if (await more.isVisible()) await more.tap();
  await page.locator('.quick-actions > [data-action="openGallerySharePanel"]').tap();
  await expect(page.locator('#gallerySharePanel')).toBeVisible();
  await toMid(page, '#fullPortalUrl');

  const w = await pageWidth(page);
  expect(w.inner, 'opening Share Portal must not widen the layout viewport past the screen').toBe(width);
  expect(w.scroll, 'and the document must not scroll sideways').toBeLessThanOrEqual(width);
  // The widened layout viewport also grew TALLER (950 on an 860 screen),
  // which is what pushed the fixed bottom bar below the screen.
  expect(w.innerH, 'nor stretch the layout viewport below the screen').toBe(HEIGHT);

  const eyeSel = '#gallerySharePanel [data-action="CustomerPortal.preview"]';
  const eye = await probe(page, eyeSel, width);
  expect(eye.right, '👁 preview must end on the screen, not past its edge').toBeLessThanOrEqual(width);
  await expectHit(page, eyeSel, width, '👁 preview', { center: true });
  expect(eye.height, '👁 is a thumb-size target').toBeGreaterThanOrEqual(36);
  const close = await probe(page, '[data-action="_closeGallerySharePanel"]', width);
  expect(close.width, 'Close sizes to its label instead of stretching across the header').toBeLessThan(120);

  // A real finger tap on 👁 reaches the preview: it mints a token and
  // opens the portal preview.
  const before = tokenCalls();
  const popup = ctx.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  await page.locator(eyeSel).tap();
  const opened = await popup;
  expect(tokenCalls(), 'tapping 👁 asked createPortalToken for a link').toBeGreaterThan(before);
  if (opened) {
    expect(opened.url()).toContain('preview=1');
    await opened.close().catch(() => {});
  }
  await page.locator('[data-action="_closeGallerySharePanel"]').tap();
  await expect(page.locator('#gallerySharePanel')).toBeHidden();
}

async function routeCallables(page) {
  let calls = 0;
  await page.route(/createPortalToken/, (route) => {
    const req = route.request();
    const cors = {
      'Access-Control-Allow-Origin': req.headers().origin || '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls++;
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ result: { token: 'phone-spec-token' } }) });
  });
  return () => calls;
}

// The uploaded row: name readable, actions reachable, nothing past the edge.
async function docRowChecks(page, width) {
  await toMid(page, '#docList [data-doc-homeowner-share]');
  const row = await page.evaluate((W) => {
    const share = document.querySelector('#docList [data-doc-homeowner-share]');
    const item = share.closest('.doc-item');
    const name = item.querySelector('.doc-name').getBoundingClientRect();
    const tops = [...item.querySelectorAll('.doc-actions > *')].map((b) => Math.round(b.getBoundingClientRect().top));
    const rights = [...item.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right);
    return { nameWidth: name.width, actionTops: tops, maxRight: Math.max(...rights), rowRight: item.getBoundingClientRect().right, W };
  }, width);
  expect(row.nameWidth, 'the file name keeps a readable column (it collapsed to 0px)').toBeGreaterThanOrEqual(100);
  expect(row.maxRight, 'no part of the row reaches past its own right edge').toBeLessThanOrEqual(row.rowRight + 1);
  expect(new Set(row.actionTops).size, 'View / Share with homeowner / ✕ fit on one line at the doc-button size').toBe(1);
  const w = await pageWidth(page);
  expect(w.inner, 'an uploaded file row must not widen the page').toBe(width);
  for (const sel of ['#docList [data-doc-homeowner-share]', '#docList .doc-item:has([data-doc-homeowner-share]) [data-action="deleteCustomerDoc"]']) {
    await expectHit(page, sel, width, sel, { center: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════
test.describe.serial('customer page at 412px, Jo\'s Android @shard2', () => {
  const W = 412;
  let ctx, page, leadId, tokenCalls;

  test.beforeAll(async ({ browser }, testInfo) => {
    const creds = skipWithoutCreds();
    test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
    testInfo.setTimeout(120_000);
    ({ ctx, page } = await phonePage(browser, testInfo, W));
    tokenCalls = await routeCallables(page);
    await loginAs(page, creds);
    leadId = await seedLead(page, { photos: 14 });
    await openCustomer(page, leadId);
  });
  test.afterAll(async () => { if (ctx) await ctx.close(); });

  test('Share Portal: the 👁 preview is on screen and a tap opens it; the page does not widen', async () => {
    await shareeyeJourney(page, ctx, W, tokenCalls);
  });

  test('Files: an uploaded row keeps its name and its actions reachable; the toggle works by tap', async () => {
    await docRowChecks(page, W);
    const share = page.locator('#docList [data-doc-homeowner-share]');
    await share.tap();
    await expect(share, 'a real tap flips the homeowner-share toggle').toHaveText('✓ Shared', { timeout: 10_000 });
  });

  test('Photos: the pinned bulk bar sits below the jump-nav and its controls take a tap', async () => {
    const toggle = page.locator('#nbdPhotoSelectToggle');
    await toMid(page, '#nbdPhotoSelectToggle');
    const t = await probe(page, '#nbdPhotoSelectToggle', W);
    expect(t.height, 'Select is a thumb-size target (it was 22px)').toBeGreaterThanOrEqual(36);
    await toggle.tap();
    const tiles = page.locator('#photosByPhase .nbd-phase-photo');
    await expect(tiles.first()).toBeVisible();
    for (let i = 0; i < 3; i++) await tiles.nth(i).tap();
    await expect(page.locator('#nbdPhotoBulkCount')).toHaveText('3 selected');
    // Scroll the grid under the pinned bar.
    await page.evaluate(() => {
      const bar = document.getElementById('nbdPhotoBulkBar');
      window.scrollTo(0, bar.getBoundingClientRect().top + scrollY + 600);
    });
    await page.waitForTimeout(400);
    const bar = await probe(page, '#nbdPhotoBulkBar', W);
    const nav = await probe(page, '#tabBar', W);
    expect(bar.top, 'the bar is pinned (this is the state that broke)').toBeLessThan(120);
    expect(bar.top, 'pinned BELOW the jump-nav, not under it').toBeGreaterThanOrEqual(nav.bottom - 1);
    expect(bar.height, 'compact enough not to bury the grid (was 179px)').toBeLessThanOrEqual(160);
    for (const sel of ['#nbdPhotoBulkCount', '#nbdBulkPhase', '#nbdBulkDamage', '#nbdBulkSeverity', '#nbdPhotoBulkBar .nbd-bulk-delete', '#nbdPhotoBulkBar .nbd-bulk-cancel']) {
      await expectHit(page, sel, W, sel + ' in the pinned bar (the count and Set phase were under the jump-nav)');
    }
    // A thumb on "Set phase…" used to fire the jump-nav chip underneath and
    // yank the page ~1060px back up.
    const y0 = await page.evaluate(() => scrollY);
    await page.locator('#nbdBulkPhase').tap();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'the tap reached Set phase').toBe('nbdBulkPhase');
    expect(Math.abs((await page.evaluate(() => scrollY)) - y0), 'and did not jump the page').toBeLessThan(10);
    await page.locator('#nbdPhotoBulkBar .nbd-bulk-cancel').tap();
    await expect(page.locator('#nbdPhotoBulkBar')).toBeHidden();
  });

  test('Jump-nav: the highlighted chip is always on screen, chips are thumb-size', async () => {
    const scrollTo = async (sectionSel, offset) => {
      const target = await page.evaluate(({ s, o }) =>
        document.querySelector(s).getBoundingClientRect().top + scrollY + o, { s: sectionSel, o: offset });
      let y = await page.evaluate(() => scrollY);
      const step = target > y ? 400 : -400;
      for (; step > 0 ? y < target : y > target; y += step) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(40);
      }
      await page.evaluate((yy) => window.scrollTo(0, yy), target);
      await page.waitForTimeout(900); // smooth horizontal scroll settles
    };
    const activeChip = async () => page.evaluate((Wd) => {
      const nav = document.getElementById('tabBar');
      const a = nav.querySelector('a.active');
      if (!a) return null;
      const nb = nav.getBoundingClientRect(), ab = a.getBoundingClientRect();
      const cx = ab.left + ab.width / 2, cy = ab.top + ab.height / 2;
      const h = document.elementFromPoint(cx, cy);
      return { text: a.textContent.trim(), inBar: ab.left >= nb.left - 1 && ab.right <= nb.right + 1 && ab.right <= Wd,
        hits: !!h && (h === a || a.contains(h)), height: ab.height };
    }, W);

    await page.evaluate(() => window.scrollTo(0, 0));
    // Section top ~100px down the screen: the spy's band (20-30% of the
    // viewport) then sits inside Voice Intel, which is short on a lead with
    // no recordings.
    await scrollTo('#voiceTab', -100);
    let chip = await activeChip();
    expect(chip && chip.text, 'Voice Intel is the current section').toMatch(/Voice Intel/);
    expect(chip.inBar, 'its chip is scrolled into the visible part of the bar (was x=446 in a bar ending at 306)').toBe(true);
    expect(chip.hits, 'and a finger at its centre touches it').toBe(true);
    expect(chip.height, 'chips are thumb-size (were 28px)').toBeGreaterThanOrEqual(36);
    const navH = await page.evaluate(() => document.getElementById('tabBar').offsetHeight);
    expect(navH, 'the pinned bar did not grow to pay for it').toBeLessThanOrEqual(50);

    await page.locator('#tabBar a[href="#contactTab"]').tap();
    await page.waitForTimeout(1_000);
    await scrollTo('#overviewTab', 300);
    chip = await activeChip();
    expect(chip && chip.text, 'back in Overview').toMatch(/Overview/);
    expect(chip.inBar, 'the Overview chip came back into view (was x=-299)').toBe(true);
    expect(chip.hits).toBe(true);
    // A tapped chip kept :hover on a touch screen, so CONTACT still wore the
    // accent border — the one emphasised chip in view was the wrong one.
    const lookalikes = await page.evaluate(() => {
      const nav = document.getElementById('tabBar');
      const active = nav.querySelector('a.active');
      const accent = getComputedStyle(active).borderTopColor;
      return [...nav.querySelectorAll('a')].filter((a) => a !== active
        && getComputedStyle(a).borderTopColor === accent).map((a) => a.textContent.trim());
    });
    expect(lookalikes, 'no other chip wears the current-section accent').toEqual([]);
  });

  test('Claim: "+ Add" beside Claim Handler opens the editor AT that section, focused', async () => {
    // Found by its row label, not by data-arg, so this is the same control
    // with or without the fix.
    const add = page.locator('#insurancePanel div:has(> div:text-is("Claim Handler")) [data-action="openClaimEditor"]');
    await expect(add).toHaveCount(1);
    await add.scrollIntoViewIfNeeded();
    await add.tap();
    await expect(page.locator('#claimEditModal')).toHaveClass(/open/);
    await page.waitForTimeout(300);
    await expectHit(page, '#clmHandlerName', W, 'Claim Handler Name, on screen and uncovered (it sat at y=861, below the fold)');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'and has the caret').toBe('clmHandlerName');
    const tops = await page.evaluate(() => ['clmDeductible', 'clmEstimateAmount', 'clmApprovedAmount']
      .map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top)));
    expect(new Set(tops).size, 'the three Money inputs line up (Deductible sat 13px high)').toBe(1);
    await page.locator('#claimEditModal [data-action="closeClaimEditor"]').first().tap();
    await expect(page.locator('#claimEditModal')).not.toHaveClass(/open/);

    // ✎ Edit is not a section shortcut: it still opens at the top.
    const edit = page.locator('#insurancePanel [data-action="openClaimEditor"]').filter({ hasText: 'Edit' });
    await edit.scrollIntoViewIfNeeded();
    await edit.tap();
    await expect(page.locator('#claimEditModal')).toHaveClass(/open/);
    await page.waitForTimeout(300);
    await expectHit(page, '#clmNumber', W, 'Edit opens at the first field');
    await page.locator('#claimEditModal [data-action="closeClaimEditor"]').first().tap();
  });

  test('Claim progress: the stage list reads as status, and Advance answers with a toast', async () => {
    await toMid(page, '#insuranceClaimWorkflow .claim-stages');
    const s = await page.evaluate(() => {
      const grid = document.querySelector('#insuranceClaimWorkflow .claim-stages');
      const items = [...grid.children];
      return {
        role: grid.getAttribute('role'),
        pointers: items.filter((t) => getComputedStyle(t).cursor === 'pointer').length,
        current: items.findIndex((t) => t.getAttribute('aria-current') === 'step'),
        n: items.length, height: grid.getBoundingClientRect().height,
      };
    });
    expect(s.n).toBe(11);
    expect(s.pointers, 'no stage advertises a click it does not have (all 11 had cursor:pointer)').toBe(0);
    expect(s.role, 'announced as a list, not a set of controls').toBe('list');
    expect(s.current, 'the current stage is marked for assistive tech').toBe(0);
    expect(s.height, 'compact (the 11 tiles took 300px)').toBeLessThanOrEqual(240);

    const adv = page.locator('#insuranceClaimWorkflow [data-ic-action="advance"]');
    await adv.scrollIntoViewIfNeeded();
    await adv.tap();
    await expect(page.getByText('Claim moved to Documentation'), 'Advance confirms what it did').toBeAttached({ timeout: 10_000 });
    await expect(page.locator('#insuranceClaimWorkflow [aria-current="step"]')).toContainText('Documentation');
  });

  test('Panel headers: titles stay on one line, Build Estimate is a full-size primary button', async () => {
    // Selectors from the pre-fix markup, so a revert fails on layout, not
    // on a missing hook.
    const B = '#estimatesPanelTitle ~ div > [data-action="_openInDashboardEstimate"]';
    const L = '#estimatesPanelTitle ~ div > [data-action="openEstimateModal"]';
    const T = '#estimatesPanelTitle ~ div > [data-action="_openInDashboardJobTemplates"]';
    const est = await probe(page, '#estimatesPanelTitle', W);
    expect(est.lines, 'ESTIMATES title on one line (was a 62px two-line column)').toBe(1);
    const build = await probe(page, B, W);
    const log = await probe(page, L, W);
    const tpl = await probe(page, T, W);
    expect(build.found && log.found && tpl.found, 'the three header actions exist').toBe(true);
    expect(build.top, 'the actions sit below the title, not squeezing it into a column').toBeGreaterThanOrEqual(est.bottom);
    expect(build.height, 'Build Estimate is at least as tall as its siblings').toBeGreaterThanOrEqual(Math.max(log.height, tpl.height));
    expect(build.height).toBeGreaterThanOrEqual(40);
    expect(build.width, 'and at least as wide').toBeGreaterThanOrEqual(Math.max(log.width, tpl.width));
    expect(build.top, 'and first').toBeLessThan(log.top);
    for (const sel of [B, L, T]) {
      await expectHit(page, sel, W, sel, { center: true });
      expect((await probe(page, sel, W)).lines, sel + ' label on one line (Build Estimate wrapped to two)').toBe(1);
    }

    const voice = await page.evaluate(() => {
      const t = [...document.querySelectorAll('#voiceTab .panel-title')].find((x) => /Voice Intelligence/.test(x.textContent));
      const d = t.nextElementSibling;
      return { titleH: t.getBoundingClientRect().height, titleBottom: t.getBoundingClientRect().bottom, descTop: d.getBoundingClientRect().top };
    });
    expect(voice.titleH, 'VOICE INTELLIGENCE on one line').toBeLessThanOrEqual(24);
    expect(voice.descTop, 'its description sits under it, not jammed beside it').toBeGreaterThanOrEqual(voice.titleBottom);
  });

  test('Tap targets: the controls a rep hits over and over take a thumb', async () => {
    const targets = [
      ['.tl-pill[data-filter="stage"]', 36], ['.photo-filter-btn[data-arg="Before"]', 36],
      ['#quickNoteSend', 40], ['#notesPanelTitle ~ [data-action="openNotesModal"]', 36],
      ['[data-action="openEventModal"]', 40], ['[data-action="openTaskModal"]', 40],
      // The checklist's "Generate →" on a gate row (AOB, on an insurance
      // lead) measured 57x13.
      ['#checklistPanel a[href="#documentsTab"]', 30],
    ];
    for (const [sel, min] of targets) {
      await toMid(page, sel);
      const p = await probe(page, sel, W);
      expect(p.found, sel + ' exists').toBe(true);
      expect(p.height, sel + ' is at least ' + min + 'px tall (was 13-29px)').toBeGreaterThanOrEqual(min);
      await expectHit(page, sel, W, sel, { edges: true, center: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
test.describe.serial('customer page at 360px, small Androids @shard2', () => {
  const W = 360;
  let ctx, page, tokenCalls;

  test.beforeAll(async ({ browser }, testInfo) => {
    const creds = skipWithoutCreds();
    test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
    testInfo.setTimeout(120_000);
    ({ ctx, page } = await phonePage(browser, testInfo, W));
    tokenCalls = await routeCallables(page);
    await loginAs(page, creds);
    const id = await seedLead(page, { photos: 0 });
    await openCustomer(page, id);
  });
  test.afterAll(async () => { if (ctx) await ctx.close(); });

  test('Header: Back and Presentation fit on one line inside the screen, on and off', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const check = async (label) => {
      for (const sel of ['header a.back-btn', '#presentationModeBtn']) {
        const p = await probe(page, sel, W);
        expect(p.top, label + ': ' + sel + ' does not poke above the screen (was y=-7)').toBeGreaterThanOrEqual(0);
        expect(p.lines, label + ': ' + sel + ' label on one line (Back wrapped to three)').toBe(1);
        expect(p.right, label + ': ' + sel + ' ends on the screen').toBeLessThanOrEqual(W);
        await expectHit(page, sel, W, label + ': ' + sel);
      }
    };
    await check('presentation off');
    await page.locator('#presentationModeBtn').tap();
    await expect(page.locator('#presentationModeBtn')).toHaveAttribute('aria-pressed', 'true');
    await check('presentation on');
    await page.locator('#presentationModeBtn').tap();
    await expect(page.locator('#presentationModeBtn')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Share Portal: the 👁 preview is on screen and a tap opens it; the page does not widen', async () => {
    await shareeyeJourney(page, ctx, W, tokenCalls);
  });

  test('Files: an uploaded row keeps its name and never widens the page', async () => {
    await docRowChecks(page, W);
  });

  // 2026-09-29: a lead that was shared, viewed, hot and scored carries six
  // chips in the header's stage item. Unwrapped they ran 351px inside a
  // 309px row and the whole record scrolled sideways at 375. The seeded
  // lead has none of those chips, so add the worst case to the real row.
  test('Header: a stage item full of chips wraps instead of widening the page', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const res = await page.evaluate(() => {
      const item = document.querySelector('.customer-meta .meta-item');
      if (!item) return null;
      ['1 day in stage', '📤 copied today', '👁 viewed today', '🔥 Hot', '70 SCORE'].forEach((t) => {
        const s = document.createElement('span');
        s.className = 'stage-badge';
        s.textContent = t;
        item.appendChild(s);
      });
      return { right: item.getBoundingClientRect().right, scroll: document.documentElement.scrollWidth };
    });
    expect(res, 'the header stage item exists').not.toBeNull();
    expect(res.right, 'the chips end on the screen').toBeLessThanOrEqual(W);
    expect(res.scroll, 'the record does not scroll sideways').toBeLessThanOrEqual(W);
  });

  test('Timeline & Tasks header: one-line title, one-line buttons, both reachable', async () => {
    const title = await page.evaluate(() => {
      const t = [...document.querySelectorAll('.panel-title')].find((x) => /Timeline & Tasks/.test(x.textContent));
      return t.getBoundingClientRect().height;
    });
    expect(title, 'TIMELINE & TASKS on one line').toBeLessThanOrEqual(24);
    for (const sel of ['[data-action="openEventModal"]', '[data-action="openTaskModal"]']) {
      await toMid(page, sel);
      const p = await probe(page, sel, W);
      expect(p.lines, sel + ' label on one line (it wrapped to two)').toBe(1);
      expect(p.height, sel + ' at a thumb size').toBeGreaterThanOrEqual(40);
      await expectHit(page, sel, W, sel, { center: true });
    }
    const w = await pageWidth(page);
    expect(w.scroll, 'nothing on the record scrolls the page sideways at 360').toBeLessThanOrEqual(W);
  });
});
