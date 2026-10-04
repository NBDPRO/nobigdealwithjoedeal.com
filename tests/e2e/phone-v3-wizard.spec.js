// tests/e2e/phone-v3-wizard.spec.js — the V3 one-thumb estimate wizard on a
// phone, walked step by step the way Jo prices a roof in the driveway.
//
// V3 (estimate-v3-wizard.js, 2026-10-02) is what opens by default. Its unit
// test pins the step lists and the tagging; nothing drove it in a browser
// at phone size until this spec. Jo runs the INSTALLED iPhone app, so the
// @media(display-mode: standalone) rules are forced on (a browser tab never
// matches them) and the viewport is an iPhone 14/15 (390 × 844).
//
// Every step is checked for what a thumb gets, not for class names:
//   - the header names the step and counts it (n / total);
//   - the step shows at least one real control;
//   - nothing on the step is wider than the screen;
//   - Next (and Back) are reachable: hit-tested at their centre;
//   - every visible control on the step is at least 44px tall.
// Then money: the package cards carry prices, the bar total follows the
// builder's own total, and Save writes an estimate whose grand total is the
// one on screen.
//
// Cloud Functions are mocked as in phone-estbuilder.spec.js.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

async function signIn(page) {
  await page.route('**/nominatim.openstreetmap.org/**', (r) =>
    r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/renderPdf**', (r) =>
    r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"status":"INTERNAL","message":"mocked in phone-v3-wizard.spec"}}' }));
  await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
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

// One customer of our own, straight to /leads (the lead UI is not under test).
async function seedLead(page) {
  return safeEvaluate(page, async () => {
    const stamp = Date.now();
    const fsMod = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const last = 'V3wiz' + stamp;
    const lead = {
      firstName: '[E2E] V3', lastName: last,
      address: stamp + ' Wizard Way, Milford, OH 45150',
      phone: '513' + String(stamp).slice(-7),
      email: 'e2e-v3-' + stamp + '@nbd.test',
      stage: 'new', e2eTestData: true,
      userId: uid, companyId, createdAt: fsMod.serverTimestamp(),
    };
    let id = null;
    try {
      id = (await fsMod.addDoc(fsMod.collection(db, 'leads'), lead)).id;
    } catch (e) {
      if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e;
      const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'leads'),
        fsMod.where('userId', '==', uid), fsMod.where('lastName', '==', last)));
      snap.forEach((d) => { if (!id) id = d.id; });
    }
    if (typeof window.loadLeads === 'function') await window.loadLeads();
    for (let i = 0; i < 75 && !(window._leads || []).some((x) => x.id === id); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return { id, name: lead.firstName + ' ' + lead.lastName };
  });
}

async function openWizard(page, arg) {
  await safeWaitForFunction(page, () => !!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function'), { timeout: 20_000 });
  await safeEvaluate(page, async (a) => {
    await window.ScriptLoader.loadBundle('estimates');
    window.openEstimateV2Builder(a);
  }, arg);
  await expect(page.locator('#estV2Modal.open.v3-on'), 'V3 opens by default').toBeVisible({ timeout: 15_000 });
  await safeWaitForFunction(page, () => !!(window.EstimateV2UI && window.EstimateV3), { timeout: 15_000 });
  await page.waitForTimeout(300);
}

// Opened from a lead with a name + address on file, the wizard skips the
// Customer step (2026-10-03) — prove that, then go Back to it so the walk
// below still covers every step from the start.
async function backToCustomerFromSkip(page) {
  await expect(page.locator('#estV2Modal .v3-title'), 'a prefilled lead skips Customer').toHaveText('Measure');
  await page.locator('#estV2Modal .v3-back').tap();
  await expect(page.locator('#estV2Modal .v3-title')).toHaveText('Customer & job');
}

// Host toasts are transient and sit above every overlay by design; clear them
// before hit-testing (same rule as phone-estbuilder.spec.js).
async function reachable(locator) {
  await locator.page().evaluate(() => {
    document.querySelectorAll('.toast-container .toast, #toast.toast').forEach((t) => t.remove());
  });
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (h === el || el.contains(h));
  });
}

// What a thumb meets on the current step.
async function stepReport(page) {
  return page.evaluate(() => {
    const m = document.getElementById('estV2Modal');
    const body = m.querySelector('.v2-body');
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const controls = Array.from(body.querySelectorAll('button, input:not([type=hidden]), select, textarea, [role=button]'))
      .filter((el) => vis(el) && !el.closest('.v3-head'));
    const name = (el) => (el.id ? '#' + el.id : '') + (el.dataset.action ? '[' + el.dataset.action + (el.dataset.arg ? '=' + el.dataset.arg : '') + ']' : '') + (el.dataset.v3Act ? '[v3:' + el.dataset.v3Act + ']' : '') + ' "' + String(el.textContent || el.placeholder || '').trim().slice(0, 24) + '"';
    const small = controls.filter((el) => {
      if (el.type === 'checkbox' || el.type === 'radio') {
        const lab = el.closest('label');
        return (lab ? lab.getBoundingClientRect().height : el.getBoundingClientRect().height) < 44;
      }
      return el.getBoundingClientRect().height < 44;
    }).map((el) => name(el) + ' ' + Math.round(el.getBoundingClientRect().height) + 'px');
    // A row that scrolls sideways on purpose (the Items category chips, one
    // swipeable row on touch since 2026-09-25) holds children past the edge
    // by design; only content that is NOT inside such a scroller counts.
    const inScroller = (el) => {
      for (let p = el.parentElement; p && p !== body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden') && p.getBoundingClientRect().right <= window.innerWidth + 1) return true;
      }
      return false;
    };
    const wide = Array.from(body.querySelectorAll('*')).filter((el) => vis(el) && el.getBoundingClientRect().right > window.innerWidth + 1 && !inScroller(el))
      .slice(0, 5).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0] + ' →' + Math.round(el.getBoundingClientRect().right));
    return {
      count: (m.querySelector('.v3-count') || {}).textContent || '',
      title: (m.querySelector('.v3-title') || {}).textContent || '',
      controls: controls.length,
      small,
      wide,
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

async function checkStep(page, expectTitle, idx, total) {
  const r = await stepReport(page);
  expect(r.title, 'step title').toBe(expectTitle);
  expect(r.count, 'step counter').toBe(idx + ' / ' + total);
  expect(r.controls, expectTitle + ': the step shows a control').toBeGreaterThan(0);
  expect(r.wide, expectTitle + ': nothing runs off the right edge').toEqual([]);
  expect(r.docOverflow, expectTitle + ': no sideways scroll').toBe(false);
  expect(r.small, expectTitle + ': every control is a thumb target (≥ 44px)').toEqual([]);
  const next = page.locator('#estV2Modal .v3-next');
  if (idx < total) {
    expect(await reachable(next), expectTitle + ': Next is not covered').toBe(true);
    const bb = await next.boundingBox();
    expect(bb.height, 'Next is thumb-sized').toBeGreaterThanOrEqual(48);
    expect(bb.y + bb.height, 'Next sits on screen').toBeLessThanOrEqual(844);
  }
}

const tapNext = (page) => page.locator('#estV2Modal .v3-next').tap();
const money = (s) => Math.round(Number(String(s).replace(/[^0-9.]/g, '')) * 100);

test.describe('phone V3 wizard: installed iPhone app @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('full roof, insurance: every step fits a thumb; packages priced; Save writes the total on screen', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    const lead = await seedLead(page);
    expect(lead && lead.id, 'a seeded customer').toBeTruthy();
    expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
    await openWizard(page, { leadId: lead.id });
    await backToCustomerFromSkip(page);

    const titles = ['Customer & job', 'Measure', 'Roof lines', 'Roof details', 'Penetrations & flashing', 'Package', 'Shingle & add-ons', 'Insurance claim', 'Photos', 'Review', 'Finish'];
    const total = titles.length;

    await test.step('1 Customer & job — insurance by default, Full roof picked', async () => {
      await expect(page.locator('#v2jobInsurance')).toHaveClass(/active/);
      await expect(page.locator('#estV2Modal .v3-kind-row .v3-big[data-v3-val="roof"]')).toHaveClass(/active/);
      await checkStep(page, titles[0], 1, total);
      await expect(page.locator('#estV2Modal .v3-back')).toBeDisabled();
      await tapNext(page);
    });
    await test.step('2 Measure — type the area, tap a pitch chip', async () => {
      await checkStep(page, titles[1], 2, total);
      await page.locator('#v2rawSqft').fill('2400');
      await page.locator('#v2rawSqft').dispatchEvent('input');
      const chip = page.locator('#estV2Modal .v3-chips .v3-chip[data-v3-for="v2pitch"]').nth(2);
      expect(await reachable(chip), 'a pitch chip is reachable').toBe(true);
      await chip.tap();
      await expect(chip).toHaveClass(/active/);
      await tapNext(page);
    });
    await test.step('3 Roof lines', async () => {
      await checkStep(page, titles[2], 3, total);
      for (const [id, v] of [['v2eaveLf', '120'], ['v2ridgeLf', '45']]) {
        await page.locator('#' + id).fill(v);
        await page.locator('#' + id).dispatchEvent('input');
      }
      await tapNext(page);
    });
    await test.step('4 Roof details — chips', async () => {
      await checkStep(page, titles[3], 4, total);
      await tapNext(page);
    });
    await test.step('5 Penetrations — the + stepper counts', async () => {
      await checkStep(page, titles[4], 5, total);
      const plus = page.locator('#estV2Modal .v3-step-btn[data-v3-act="inc"][data-v3-for="v2pipes"]');
      expect(await reachable(plus), '+ pipes is reachable').toBe(true);
      await plus.tap();
      await plus.tap();
      await expect(page.locator('#v2pipes')).toHaveValue('2');
      await tapNext(page);
    });
    await test.step('6 Package — load the roof system; line-item prices one package at a time, honestly', async () => {
      const load = page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]');
      await expect(load, 'an empty estimate offers to load the roof system').toBeVisible();
      expect(await reachable(load)).toBe(true);
      await load.tap();
      const tiers = page.locator('#estV2Modal .v3-pkg .v3-tier');
      await expect(tiers.first()).toBeVisible();
      // An insurance job prices line-item: no side-by-side. Every card shows
      // either a real price or says how to get one — never a bare "—".
      await expect(page.locator('#estV2Modal .v3-pkg .v3-pkg-one'), 'says why the packages are not side by side').toBeVisible();
      const prices = (await tiers.locator('.v3-tier-price').allTextContents()).map((p) => p.trim());
      expect(prices.length, 'a card per tier').toBeGreaterThanOrEqual(3);
      expect(prices.filter((p) => !/^\$[\d,]+$/.test(p) && p !== 'Tap to price'), 'no card reads "—"').toEqual([]);
      expect(prices.filter((p) => /^\$/.test(p)).length, 'the selected package is priced').toBeGreaterThanOrEqual(1);
      // Tapping a package prices it: Beyond (TAMKO HailGuard) re-prices the
      // scope, and its card and the bar both show that total.
      const beyond = page.locator('#estV2Modal .v3-pkg .v3-tier[data-v3-val="beyond"]');
      await beyond.scrollIntoViewIfNeeded();
      expect(await reachable(beyond), 'Beyond is reachable').toBe(true);
      await beyond.tap();
      const beyondCard = page.locator('#estV2Modal .v3-pkg .v3-tier[data-v3-val="beyond"]');
      await expect(beyondCard).toHaveClass(/active/);
      await expect(beyondCard.locator('.v3-tier-price')).toHaveText(/^\$[\d,]+$/);
      expect(money(await beyondCard.locator('.v3-tier-price').textContent()), 'the card = the bar').toBe(money(await page.locator('#estV2Modal .v3-bar-val').textContent()));
      const better = page.locator('#estV2Modal .v3-pkg .v3-tier[data-v3-val="better"]');
      await better.scrollIntoViewIfNeeded();
      await better.tap();
      await expect(page.locator('#estV2Modal .v3-pkg .v3-tier[data-v3-val="better"]')).toHaveClass(/active/);
      await page.locator('#estV2Modal .v2-body').evaluate((b) => { b.scrollTop = 0; });
      await checkStep(page, titles[5], 6, total);
      const bar = (await page.locator('#estV2Modal .v3-bar-val').textContent()) || '';
      expect(money(bar), 'the bar total is a real number').toBeGreaterThan(0);
      expect(bar.trim(), 'the bar shows the builder total').toBe(((await page.locator('#v2total').textContent()) || '').trim());
      await tapNext(page);
    });
    await test.step('7 Shingle & add-ons', async () => {
      await checkStep(page, titles[6], 7, total);
      await tapNext(page);
    });
    await test.step('8 Insurance claim — the claim fields', async () => {
      await checkStep(page, titles[7], 8, total);
      await expect(page.locator('#v2claimCarrier')).toBeVisible();
      await tapNext(page);
    });
    await test.step('9 Photos — a new customer has none: shoot one here, it rides the estimate', async () => {
      await checkStep(page, titles[8], 9, total);
      const add = page.locator('#estV2Modal [data-v3-act="photo-add"]');
      expect(await reachable(add), 'Add photos is reachable').toBe(true);
      // The camera / library sheet is the OS's; hand the input a real JPEG.
      const b64 = await page.evaluate(() => new Promise((res) => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 48;
        const x = c.getContext('2d'); x.fillStyle = '#7a5'; x.fillRect(0, 0, 64, 48);
        c.toBlob((b) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); }, 'image/jpeg', 0.8);
      }));
      await page.locator('#estV2Modal .v3-photo-input').setInputFiles({ name: 'roof.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
      await expect(page.locator('#estV2Modal .v3-photo-msg')).toHaveText(/1 photo added to this estimate/, { timeout: 30_000 });
      await expect(page.locator('#v2photosGrid [data-action="toggle-photo"]'), 'the grid shows it').toHaveCount(1);
      const picked = await safeEvaluate(page, () => (window.EstimateV2UI.getState().photos || []).length);
      expect(picked, 'and it is ticked for the estimate').toBe(1);
      await checkStep(page, titles[8], 9, total);
      await tapNext(page);
    });
    await test.step('10 Review — scope and total on screen', async () => {
      await checkStep(page, titles[9], 10, total);
      await expect(page.locator('#estV2Modal .v2-total-card')).toBeVisible();
      await tapNext(page);
    });
    let shown = 0;
    await test.step('11 Finish — no Next; Save (under More) is reachable and saves', async () => {
      await checkStep(page, titles[10], 11, total);
      await expect(page.locator('#estV2Modal .v3-next')).toBeHidden();
      shown = money(await page.locator('#estV2Modal .v3-bar-val').textContent());
      // One primary on Finish (2026-10-03): Save sits under More.
      await expect(page.locator('#v2saveBtn'), 'Save is tucked under More').toBeHidden();
      await page.locator('#estV2Modal .v3-more').tap();
      const save = page.locator('#v2saveBtn');
      await save.scrollIntoViewIfNeeded();
      expect(await reachable(save), 'Save is not covered').toBe(true);
      await save.tap();
      await expect(save).toHaveText(/Saved/, { timeout: 20_000 });
    });
    await test.step('the saved estimate carries the total that was on screen', async () => {
      const saved = await safeEvaluate(page, async (leadId) => {
        const fsMod = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
        const db = window.db || window._db;
        const uid = (window._auth || window.auth).currentUser.uid;
        const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'estimates'),
          fsMod.where('leadId', '==', leadId), fsMod.where('userId', '==', uid)));
        return snap.docs.map((d) => d.data()).map((d) => ({ grandTotal: d.grandTotal, total: d.total, photos: (d.photos || []).length }));
      }, lead.id);
      expect(saved.length, 'one estimate saved for the customer').toBe(1);
      expect(saved[0].photos, 'the photo shot in the wizard is on the saved estimate').toBe(1);
      const t = saved[0].grandTotal != null ? saved[0].grandTotal : saved[0].total;
      expect(Math.round(Number(t) * 100), 'saved grand total = the total on screen').toBe(shown);
    });
  });

  test('full roof, cash, Per-SQ: every package priced side by side, Economy → Beyond ascending', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const lead = await seedLead(page);
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await openWizard(page, { leadId: lead.id });
    await backToCustomerFromSkip(page);
    await page.locator('#v2jobCash').tap();
    await expect(page.locator('#v2jobCash')).toHaveClass(/active/);
    await tapNext(page);
    await page.locator('#v2rawSqft').fill('2400');
    await page.locator('#v2rawSqft').dispatchEvent('input');
    // Jump to Package through the step sheet (the jump is part of the UI).
    await page.locator('#estV2Modal .v3-jump').tap();
    await page.locator('#estV2Modal .v3-sheet:not([hidden]) .v3-sheet-row').filter({ hasText: 'Package' }).tap();
    await expect(page.locator('#estV2Modal .v3-title')).toHaveText('Package');
    await page.locator('#estV2Modal .v3-pkg [data-v3-act="preset"][data-v3-val="standard-reroof"]').tap();
    const perSq = page.locator('#v2modePerSq');
    await perSq.scrollIntoViewIfNeeded();
    expect(await reachable(perSq), 'Per-SQ is reachable on the Package step').toBe(true);
    await perSq.tap();
    await expect(perSq).toHaveClass(/active/);
    await expect(page.locator('#estV2Modal .v3-pkg .v3-pkg-one'), 'no one-at-a-time note on Per-SQ').toHaveCount(0);
    const prices = (await page.locator('#estV2Modal .v3-pkg .v3-tier .v3-tier-price').allTextContents()).map((p) => p.trim());
    expect(prices.every((p) => /^\$[\d,]+$/.test(p)), 'every package priced: ' + prices.join(' / ')).toBe(true);
    const cents = prices.map(money);
    expect(cents, 'packages climb from Economy to Beyond').toEqual([...cents].sort((a, b) => a - b));
    expect(new Set(cents).size, 'each package is its own price').toBe(cents.length);
    await checkStep(page, 'Package', 6, 10);
  });

  test('repair, cash: 7 steps; a repair preset prices it; jump sheet reaches any step', async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const lead = await seedLead(page);
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await openWizard(page, { leadId: lead.id });
    await backToCustomerFromSkip(page);

    await page.locator('#v2jobCash').tap();
    await expect(page.locator('#v2jobCash')).toHaveClass(/active/);
    const repairBtn = page.locator('#estV2Modal .v3-kind-row .v3-big[data-v3-val="repair"]');
    expect(await reachable(repairBtn)).toBe(true);
    await repairBtn.tap();
    await expect(repairBtn).toHaveClass(/active/);
    const titles = ['Customer & job', 'Repair type', 'Repair size', 'Items', 'Photos', 'Review', 'Finish'];
    await checkStep(page, titles[0], 1, titles.length);
    await tapNext(page);

    await checkStep(page, titles[1], 2, titles.length);
    const presets = page.locator('#estV2Modal .v2-preset-btns button:visible');
    const visibleArgs = await presets.evaluateAll((els) => els.map((e) => e.dataset.arg || e.dataset.action));
    expect(visibleArgs.filter((a) => a === 'standard-reroof' || a === 'storm-claim'), 'full-roof presets are hidden on a repair').toEqual([]);
    const patch = page.locator('#estV2Modal .v2-preset-btns [data-arg="small-repair"]');
    expect(await reachable(patch), 'the repair preset is reachable').toBe(true);
    await patch.tap();
    await expect.poll(async () => money(await page.locator('#estV2Modal .v3-bar-val').textContent()), { timeout: 5_000 }).toBeGreaterThan(0);
    await tapNext(page);

    for (let i = 2; i < titles.length - 1; i++) {
      await checkStep(page, titles[i], i + 1, titles.length);
      await tapNext(page);
    }
    await checkStep(page, titles[titles.length - 1], titles.length, titles.length);

    // The jump sheet: tap the step name, every step listed, jump back to Items.
    await page.locator('#estV2Modal .v3-jump').tap();
    const rows = page.locator('#estV2Modal .v3-sheet:not([hidden]) .v3-sheet-row');
    await expect(rows).toHaveCount(titles.length);
    const items = rows.filter({ hasText: 'Items' });
    expect(await reachable(items)).toBe(true);
    await items.tap();
    await expect(page.locator('#estV2Modal .v3-sheet')).toBeHidden();
    await expect(page.locator('#estV2Modal .v3-title')).toHaveText('Items');
  });
});
