// tests/e2e/phone-estbuilder.spec.js — the V2 estimate builder on a phone.
//
// Regression lane for the 2026-09-25 phone audit (estimate#2, #3, #4, #5, #6,
// #8, #12). Jo runs his roofing business from an Android at ~412px; the V2
// builder is where he prices a roof in the driveway. Every finding here was
// reproduced with real taps before it was fixed, and every assertion below
// checks what a thumb gets — hit-testing (document.elementFromPoint at the
// control's centre must land on the control) and real locator.tap() calls —
// not class names. The pipeline menus stayed "green" for months behind a test
// that only checked '.open'; don't write that test here.
//
//   estimate#2  every step opened with all sections collapsed (Setup = five
//               bare headers; Review hid the scope, total and Save)
//   estimate#3  price-adder checkboxes were 13x13 and their text not tappable
//   estimate#4  9px labels; grey "3900" placeholders read as entered values
//   estimate#5  Items category chips were 22px tall, wrapping into 3-4 rows
//   estimate#6  22px note button; × deleted a priced line with no undo;
//               quantity edits went through window.prompt (text keyboard)
//   estimate#8  reopening a saved estimate blanked the customer's phone and
//               email — the Retail Quote printed "—"
//   estimate#12 the dashboard showed through a short V2 step and the Job
//               Templates modal; the JT title was #fff on a cream header
//
// Cloud Functions are mocked (renderPdf → 500, so the quote renders through
// the local viewer and CI never calls production). One login per describe.
//
// Run locally against a served worktree + the emulators:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=... PLAYWRIGHT_TEST_USER_PASSWORD=... \
//     npx playwright test --config=playwright.config.js phone-estbuilder.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const ANDROID = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
};

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

// ── helpers ────────────────────────────────────────────────────────────────

async function signIn(page) {
  // _saveLead geocodes new addresses and OSM rate-limits CI IPs with no
  // client timeout; the quote's server render is a Cloud Function. Neither
  // is under test — keep both local and deterministic.
  await page.route('**/nominatim.openstreetmap.org/**', (r) =>
    r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/renderPdf**', (r) =>
    r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"status":"INTERNAL","message":"mocked in phone-estbuilder.spec"}}' }));
  // The first-run tour mounts 1.5s after the dashboard and its overlay eats
  // taps; a one-shot "Skip tour" check races it. Mark it done up front
  // (onboarding-tour.js STORAGE_KEY).
  await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
  await loginAs(page, creds);
  await safeWaitForFunction(page, () => !!(window._user && window._user.uid), { timeout: 20_000 });
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
}

// Open the builder the way the customer page's "Build Estimate" does — the
// entry is not under test, the builder is.
async function openBuilder(page, arg) {
  await safeWaitForFunction(page, () => !!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function'), { timeout: 20_000 });
  await safeEvaluate(page, async (a) => {
    await window.ScriptLoader.loadBundle('estimates');
    window.openEstimateV2Builder(a);
  }, arg);
  await expect(page.locator('#estV2Modal.open')).toBeVisible({ timeout: 15_000 });
  await safeWaitForFunction(page, () => !!(window.NBD_XACT_CATALOG && window.EstimateV2UI), { timeout: 15_000 });
  await page.waitForTimeout(400);
  // V3 (2026-10-02) opens by default; this spec covers the V2 editor, which
  // stays one tap away behind "Full editor" (estimate-v3-wizard.js).
  const toFull = page.locator('#estV2Modal.v3-on #v3Toggle');
  if (await toFull.count()) {
    await toFull.click();
    await expect(page.locator('#estV2Modal.v3-on')).toHaveCount(0);
    await page.waitForTimeout(200);
  }
}

// The control's centre, hit-tested: what a thumb landing there would touch.
// Host-page toasts are cleared first: they are transient, sit above every
// overlay by design (--z-toast), and the seeding here raises its own
// ("Address not found" from the stubbed geocoder) plus the dashboard's
// timers ("8 overdue follow-ups"). A toast over a control is not what these
// steps measure; the builder's own layers (step bar, undo bar) still count.
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

// Customers of our own, written straight to /leads. The lead-save UI path is
// not under test here, and window._saveLead swallows a failed write into a
// `null` return (seen on a loaded emulator), which left this spec with no
// customer and an unrelated red. The doc carries what the leads create rule
// requires (userId + the caller's companyId) and what the builder reads.
async function seedLeads(page, n) {
  return safeEvaluate(page, async (count) => {
    const stamp = Date.now();
    const fsMod = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = (window._auth || window.auth).currentUser.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const out = [];
    for (let i = 0; i < count; i++) {
      const last = 'Estb' + stamp + '-' + i;
      const lead = {
        firstName: '[E2E] Estb', lastName: last,
        address: stamp + '-' + i + ' Estbuilder Way, Milford, OH 45150',
        phone: '513' + String(stamp + i).slice(-7),
        email: 'e2e-estb-' + stamp + '-' + i + '@nbd.test',
        stage: 'new', e2eTestData: true,
        userId: uid, companyId: companyId, createdAt: fsMod.serverTimestamp(),
      };
      let id = null;
      try {
        id = (await fsMod.addDoc(fsMod.collection(db, 'leads'), lead)).id;
      } catch (e) {
        // ALREADY_EXISTS = the emulator commit-retry bug: the write landed,
        // so find it by its unique lastName.
        if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e;
        const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'leads'),
          fsMod.where('userId', '==', uid), fsMod.where('lastName', '==', last)));
        snap.forEach((d) => { if (!id) id = d.id; });
      }
      out.push({ id, name: lead.firstName + ' ' + lead.lastName, email: lead.email, phone: lead.phone, address: lead.address });
    }
    if (typeof window.loadLeads === 'function') await window.loadLeads();
    // The builder prefills from window._leads — wait until they're in it.
    for (let i = 0; i < 75 && !out.every((l) => (window._leads || []).some((x) => x.id === l.id)); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return out;
  }, n);
}

async function stepTo(page, n) {
  await page.locator(`#v2mStepBar [data-action="mstep"][data-arg="${n}"]`).first().tap();
  await expect(page.locator('#estV2Modal')).toHaveAttribute('data-mstep', String(n));
}

// Scope set-up through the builder's own API. Not under test here, and kept
// off the Setup step on purpose: a break in Setup must redden the Setup
// assertions, not every describe that merely needs a priced scope.
async function loadStandardReroof(page, measured) {
  await safeEvaluate(page, (m) => {
    const u = window.EstimateV2UI;
    if (m) { u.updateMeasurement('rawSqft', 2400); u.updateMeasurement('eaveLf', 120); u.updateMeasurement('ridgeLf', 45); }
    u.loadPreset('standard-reroof');
  }, !!measured);
  await expect(page.locator('#v2scopeList .v2-scope-item').first()).toBeAttached();
}

const scopeTotal = (page) => page.locator('#v2total').textContent();

// estimate#12 only shows on a SHORT step: with its sections open a pane runs
// past the step bar on its own, so the check would pass vacuously. Fold every
// section with real header taps (what a rep does to get an overview), then
// hit-test just above the step bar: it must be the pane, not the dashboard
// seen through the modal's backdrop.
async function foldedPaneFillsScreen(page, paneSel) {
  const pane = page.locator('#estV2Modal ' + paneSel);
  const open = pane.locator('.v2-section:not(.collapsed)');
  for (let n = await open.count(); n > 0; n = await open.count()) {
    await open.first().scrollIntoViewIfNeeded();
    await open.first().tap();
  }
  await pane.evaluate((el) => { el.scrollTop = 0; });
  // Sections fold with a max-height transition: measure only once the pane's
  // content has actually finished shrinking. Hit-testing mid-transition lands
  // on a still-collapsing section and passes even with the fix removed (a
  // break-test caught exactly that — the settle-time-skips-the-transient
  // lesson, inverted).
  const measure = () => page.evaluate((sel) => {
    const p = document.querySelector('#estV2Modal ' + sel);
    const bottom = Math.max(...[...p.children].map((c) => c.getBoundingClientRect().bottom));
    const y = document.getElementById('v2mStepBar').getBoundingClientRect().top - 8;
    const h = document.elementFromPoint(window.innerWidth / 2, y);
    return { short: bottom < y - 40, inPane: !!h && p.contains(h), hit: h ? String(h.className) : null };
  }, paneSel);
  await expect.poll(async () => (await measure()).short, { timeout: 5_000 }).toBe(true);
  return measure();
}

// ── 1. Layout of the three steps, at the small-Android width ───────────────

test.describe('phone estbuilder: V2 steps open usable at 360px @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use({ ...ANDROID, viewport: { width: 360, height: 860 } });

  test('Setup, Items and Review each show their controls — no header taps needed', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    // A customer of our own: the lead path skips draft restore (another
    // spec's autosaved draft would otherwise fill the boxes), so every field
    // starts from the page-load state.
    const [lead] = await seedLeads(page, 1);
    await openBuilder(page, { leadId: lead.id });
    const setup = page.locator('#estV2Modal .pane-setup');

    await test.step('estimate#2: Setup opens with its inputs on screen', async () => {
      await expect(page.locator('#estV2Modal')).toHaveAttribute('data-mstep', '1');
      expect(await reachable(page.locator('#v2county')), 'county select is tappable on open').toBe(true);
      expect(await reachable(page.locator('#v2rawSqft')), 'roof-area input is tappable on open').toBe(true);
      await page.locator('#v2rawSqft').tap();
      await expect(page.locator('#v2rawSqft')).toBeFocused();
    });

    await test.step('estimate#4: labels are readable; empty boxes show hints, not values', async () => {
      const info = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('#estV2Modal .pane-setup .v2-field > label')]
          .filter((l) => l.offsetParent);
        const inputs = [...document.querySelectorAll('#estV2Modal .pane-setup input[type=number]')];
        const empty = inputs.filter((i) => !i.value);
        return {
          n: labels.length,
          minPx: Math.min(...labels.map((l) => parseFloat(getComputedStyle(l).fontSize))),
          empty: empty.length,
          // A bare number in grey reads like a measurement already entered;
          // "0" is the one honest bare hint (an empty box IS zero).
          bare: empty.filter((i) => /^\d+(\.\d+)?$/.test(i.placeholder.trim()) && i.placeholder.trim() !== '0')
            .map((i) => i.id + '=' + i.placeholder),
        };
      });
      expect(info.n).toBeGreaterThan(10);
      expect(info.minPx, 'smallest Setup field label (px)').toBeGreaterThanOrEqual(11);
      expect(info.empty, 'a fresh estimate has empty measurement boxes to check').toBeGreaterThan(5);
      expect(info.bare, 'empty boxes whose hint looks like an entered value').toEqual([]);
    });

    await test.step('estimate#3: tapping a price adder\'s text toggles it', async () => {
      for (const [id, re] of [['v2cutup', /^Cut-up Roof/], ['v2chimneyFlash', /^Chimney Flashing/], ['v2skylightFlash', /^Skylight Flashing/]]) {
        const box = page.locator('#' + id);
        const text = setup.getByText(re);
        const before = await box.isChecked();
        await text.tap();
        await expect(box, `${id}: a tap on its text toggles it`).toBeChecked({ checked: !before });
        const field = await box.getAttribute('data-field');
        expect(await page.evaluate((f) => window.EstimateV2UI.getState().measurements[f], field),
          `${id}: the estimate's state follows the tap`).toBe(!before);
        const bb = await box.boundingBox();
        expect(Math.min(bb.width, bb.height), `${id}: the box itself is thumb-sized`).toBeGreaterThanOrEqual(20);
        await text.tap(); // put it back
        await expect(box).toBeChecked({ checked: before });
      }
    });

    await test.step('estimate#12: a folded-up Setup step still fills the screen', async () => {
      const g = await foldedPaneFillsScreen(page, '.pane-setup');
      expect(g.short, 'folded, the Setup content ends well above the step bar').toBe(true);
      expect(g.inPane, `just above the step bar is the builder, not the dashboard behind it (hit ${g.hit})`).toBe(true);
    });

    await test.step('estimate#5: Items category chips are thumb-sized, one row, and filter', async () => {
      await stepTo(page, 2);
      const g = await page.evaluate(() => {
        const bs = [...document.querySelectorAll('#v2cats button')];
        return { n: bs.length, minH: Math.min(...bs.map((b) => b.getBoundingClientRect().height)),
          rowH: document.getElementById('v2cats').getBoundingClientRect().height };
      });
      expect(g.n).toBeGreaterThan(5);
      expect(g.minH, 'shortest category chip (px)').toBeGreaterThanOrEqual(36);
      expect(g.rowH, 'chips take one row, not three or four').toBeLessThan(60);
      // The last chip starts off-screen in the sideways row; a real tap
      // scrolls to it and must filter the list to that category.
      const last = page.locator('#v2cats button').last();
      const want = Number(((await last.textContent()) || '').match(/\((\d+)\)/)[1]);
      await last.tap();
      expect(await reachable(page.locator('#v2cats button').last()), 'the tapped chip is on screen').toBe(true);
      await expect(page.locator('#v2items .v2-item')).toHaveCount(want);
    });

    await test.step('estimate#2: Review shows the scope, total and Save without opening a section', async () => {
      await loadStandardReroof(page, false);
      await stepTo(page, 3);
      const row = page.locator('#v2scopeList .v2-scope-item').first();
      await row.scrollIntoViewIfNeeded();
      expect(await reachable(row), 'first scope line is on screen and tappable').toBe(true);
      for (const sel of ['.v2-total-card', '#v2saveBtn']) {
        const el = page.locator('#estV2Modal ' + sel);
        await el.scrollIntoViewIfNeeded();
        expect(await reachable(el), sel + ' is reachable by scrolling alone').toBe(true);
      }
    });

    await test.step('estimate#12: a folded-up Review step still fills the screen', async () => {
      const g = await foldedPaneFillsScreen(page, '.pane-review');
      expect(g.short, 'folded, the Review content ends well above the step bar').toBe(true);
      expect(g.inPane, `just above the step bar is the builder, not the dashboard behind it (hit ${g.hit})`).toBe(true);
    });
  });
});

// ── 2. Review scope-row controls at Jo's width ─────────────────────────────

test.describe('phone estbuilder: scope rows at 412px @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use({ ...ANDROID, viewport: { width: 412, height: 860 } });

  test('note/qty/remove are thumb targets; qty edits in place; remove can be undone', async ({ page }) => {
    test.setTimeout(120_000);
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.type() + ': ' + d.message().slice(0, 60)); await d.dismiss(); });
    await signIn(page);
    const [lead] = await seedLeads(page, 1);
    await openBuilder(page, { leadId: lead.id });
    await loadStandardReroof(page, true);
    await stepTo(page, 3);

    const firstRow = page.locator('#v2scopeList .v2-scope-item').first();
    await firstRow.scrollIntoViewIfNeeded();
    const code = await firstRow.getAttribute('data-code');
    const row = page.locator(`#v2scopeList .v2-scope-item[data-code="${code}"]`);

    await test.step('estimate#6: 📝 ✎ × are each a 40px target a thumb actually hits', async () => {
      for (const cls of ['edit-note', 'edit-qty', 'rm']) {
        const b = row.locator('button.' + cls);
        const bb = await b.boundingBox();
        expect(Math.min(bb.width, bb.height), `${cls} size`).toBeGreaterThanOrEqual(39.5);
        expect(await reachable(b), `${cls} is not covered`).toBe(true);
      }
    });

    let T1 = null;
    await test.step('estimate#6: ✎ edits the quantity in the row with a number pad — no prompt()', async () => {
      const T0 = await scopeTotal(page);
      await row.locator('button.edit-qty').tap();
      const input = page.locator('#v2RowEditInput');
      await expect(input, 'an in-row quantity box opens').toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute('inputmode', 'decimal');
      await input.fill('30');
      await page.locator('#v2scopeList [data-action="row-edit-apply"]').tap();
      await expect(row.locator('.qty')).toContainText('30.0');
      await expect(row.locator('.qty')).toContainText('manual');
      T1 = await scopeTotal(page);
      expect(T1, 'the override re-prices the estimate').not.toBe(T0);
      expect(dialogs, 'no native dialog on the way').toEqual([]);
    });

    await test.step('estimate#6: × on a priced line can be undone, override intact', async () => {
      const n = await page.locator('#v2scopeList .v2-scope-item').count();
      const idx = await page.evaluate((c) => [...document.querySelectorAll('#v2scopeList .v2-scope-item')]
        .findIndex((r) => r.dataset.code === c), code);
      await row.locator('button.rm').tap();
      await expect(page.locator('#v2scopeList .v2-scope-item')).toHaveCount(n - 1);
      expect(await scopeTotal(page), 'removing the line drops the total').not.toBe(T1);
      const undo = page.locator('#estV2Modal').getByRole('button', { name: 'Undo' });
      await expect(undo, 'an Undo control is offered').toBeVisible();
      expect(await reachable(undo), 'Undo is not covered (e.g. by the step bar)').toBe(true);
      await undo.tap();
      await expect(page.locator('#v2scopeList .v2-scope-item')).toHaveCount(n);
      await expect(row.locator('.qty')).toContainText('manual');
      expect(await scopeTotal(page), 'undo restores the exact total').toBe(T1);
      expect(await page.evaluate((c) => [...document.querySelectorAll('#v2scopeList .v2-scope-item')]
        .findIndex((r) => r.dataset.code === c), code), 'back in its original position').toBe(idx);
      expect(dialogs).toEqual([]);
    });
  });
});

// ── 3. Reopen keeps the customer's contact (data bug, any width) ───────────

test.describe('phone estbuilder: reopened estimate keeps contact @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use({ ...ANDROID, viewport: { width: 412, height: 860 } });

  test('save → reopen → Retail Quote still carries phone + email; the next customer starts clean', async ({ page }) => {
    test.setTimeout(150_000);
    // The document viewer asks "Close without saving?" — accept that one.
    page.on('dialog', async (d) => {
      if (/close without saving/i.test(d.message())) await d.accept(); else await d.dismiss();
    });
    await signIn(page);
    const [A, B] = await seedLeads(page, 2);
    expect(A.id && B.id, 'two seeded customers').toBeTruthy();
    await safeWaitForFunction(page, () => (window._leads || []).length > 0, { timeout: 15_000 });

    await openBuilder(page, { leadId: A.id });
    await loadStandardReroof(page, true);
    await stepTo(page, 3);
    await expect(page.locator('#v2custEmail')).toHaveValue(A.email);

    let estId = null;
    await test.step('estimate#8: Save persists the phone + email the estimate was written for', async () => {
      // The builder's own save() — the button is covered by the layout steps.
      await safeEvaluate(page, () => window.EstimateV2UI.save());
      await expect(page.locator('#v2saveStatus')).toHaveText(/Saved|error|fail/i, { timeout: 20_000 });
      // Recover by leadId: survives the emulator's ALREADY_EXISTS retry bug
      // (the write lands, the client reports an error).
      const saved = await safeEvaluate(page, async (lid) => {
        const fsMod = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
        const db = window.db || window._db;
        const uid = (window._auth || window.auth).currentUser.uid;
        const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'estimates'),
          fsMod.where('userId', '==', uid), fsMod.where('leadId', '==', lid)));
        let out = null; snap.forEach((d) => { if (!out) out = { id: d.id, ...d.data() }; });
        return out && { id: out.id, customerEmail: out.customerEmail, customerPhone: out.customerPhone };
      }, A.id);
      expect(saved, 'the estimate was saved against the customer').toBeTruthy();
      expect(saved.customerEmail).toBe(A.email);
      expect(saved.customerPhone).toBe(A.phone);
      estId = saved.id;
    });

    await test.step('estimate#8: reopening lands on Review with phone + email filled in', async () => {
      await page.locator('#estV2Modal .v2-close').tap();
      await expect(page.locator('#estV2Modal')).toBeHidden();
      await page.waitForFunction((id) => (window._estimates || []).some((e) => e.id === id), estId, { timeout: 20_000 });
      await openBuilder(page, { estimateId: estId });
      await expect(page.locator('#estV2Modal')).toHaveAttribute('data-mstep', '3');
      await expect(page.locator('#v2custEmail')).toHaveValue(A.email);
      await expect(page.locator('#v2custPhone')).toHaveValue(A.phone);
      expect(await reachable(page.locator('#v2custEmail')), 'the reopened contact is on screen').toBe(true);
    });

    await test.step('estimate#8: the regenerated Retail Quote prints them', async () => {
      const rq = page.locator('#estV2Modal [data-action="finalize"][data-arg="retail-quote"]');
      await rq.scrollIntoViewIfNeeded();
      await rq.tap();
      const doc = page.frameLocator('#nbdv-iframe').locator('body');
      await expect(doc).toContainText(A.email, { timeout: 20_000 });
      await expect(doc).toContainText(A.phone);
    });

    await test.step('estimate#8 sibling: the next customer\'s new estimate does not inherit this one', async () => {
      await page.locator('#nbdv-close').tap(); // "Close without saving?" → OK (handler above)
      await expect(page.locator('#nbdv-close')).toBeHidden({ timeout: 10_000 });
      await page.locator('#estV2Modal .v2-close').tap();
      await expect(page.locator('#estV2Modal')).toBeHidden();
      await openBuilder(page, { leadId: B.id });
      await expect(page.locator('#v2custName')).toHaveValue(B.name);
      await expect(page.locator('#v2custEmail')).toHaveValue(B.email);
      await expect(page.locator('#v2custAddress')).toHaveValue(B.address);
      expect(await page.evaluate(() => {
        const s = window.EstimateV2UI.getState();
        return { scope: s.scope.length, leadId: s.leadId, linked: s.customer.leadId };
      }), 'a clean scope, and Save would file it under B — not A').toEqual({ scope: 0, leadId: null, linked: B.id });
    });
  });
});

// ── 3b. Upgrades & Add-ons on the Job Templates build screen (stage 2) ────
//
// 2026-09-25 (documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md):
// the rep picks a leaf guard on the build screen's Upgrades card, hands the
// phone over on "Show homeowner", the homeowner adds it, and the estimate is
// saved with that line at exactly the price on the card. Jo runs this from
// the INSTALLED iPhone app, so the @media(display-mode: standalone) rules
// are forced on (a browser tab never matches them — see phone-dashnav's
// 'draw (installed app)'). Money is read back from the SAVED doc, not
// assumed: the card's line = the preview line = the saved row, and the
// homeowner's running total = the saved grand total.

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

const dollarsToCents = (s) => Math.round(Number(String(s).replace(/[$,]/g, '')) * 100);

test.describe('phone estbuilder: Job Templates upgrades, installed app at 412px @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use({ ...ANDROID, viewport: { width: 412, height: 860 } });

  test('pick Alu-Rex → Show homeowner → Add → preview and save carry the quoted line', async ({ page }) => {
    test.setTimeout(150_000);
    await signIn(page);
    const [lead] = await seedLeads(page, 1);
    expect(lead && lead.id, 'a seeded customer').toBeTruthy();
    expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
    await safeWaitForFunction(page, () => !!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function'), { timeout: 20_000 });
    await safeEvaluate(page, async (leadId) => {
      await window.ScriptLoader.loadBundle('estimates');
      window.JobTemplatesUI.openPicker({ leadId });
    }, lead.id);
    await expect(page.locator('#jtModal.open')).toBeVisible({ timeout: 15_000 });
    const use = page.locator('#jtModal [data-jt-action="quick-use"][data-id="jt_gi_k5_seamless_full"]');
    await use.scrollIntoViewIfNeeded();
    await use.tap();
    const card = page.locator('#jtUpgCard [data-upg-card]');
    await expect(card, 'the build screen shows an Upgrades card').toBeVisible({ timeout: 15_000 });

    let lineCents = 0;
    await test.step('the card: nothing pre-ticked; Alu-Rex is a thumb target priced with its footage', async () => {
      await expect(page.locator('#jtUpgCard [data-jt-action="upg-pick-none"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#jtUpgCard [data-jt-action="upg-pick"][aria-pressed="true"]')).toHaveCount(0);
      const pick = page.locator('#jtUpgCard [data-jt-action="upg-pick"][data-id="alurex"]');
      await pick.scrollIntoViewIfNeeded();
      expect(await reachable(pick), 'the Alu-Rex row is not covered').toBe(true);
      const bb = await pick.boundingBox();
      expect(bb.height, 'the Alu-Rex row is a big tap target').toBeGreaterThanOrEqual(48);
      const price = (await page.locator('#jtUpgCard [data-upg-px="alurex"]').textContent()) || '';
      const m = /^(\d+) ft × \$18 = (\$[\d,]+(?:\.\d\d)?)$/.exec(price.trim());
      expect(m, 'price with quantity, e.g. "150 ft × $18 = $2,700" — got "' + price + '"').toBeTruthy();
      lineCents = dollarsToCents(m[2]);
      expect(lineCents, 'the line is footage × $18 exactly').toBe(Number(m[1]) * 1800);
      await pick.tap();
      await expect(pick).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#jtUpgCard [data-upg-sum]')).toHaveText('· 1 picked · +' + m[2]);
    });

    let hoTotalCents = 0;
    let withoutCents = 0;
    let savedId = null;
    await test.step('Show homeowner: its own page; No thanks / Add move the total; hand back', async () => {
      const show = page.locator('#jtUpgCard [data-jt-action="upg-show-homeowner"]');
      await show.scrollIntoViewIfNeeded();
      expect(await reachable(show), 'Show homeowner is reachable').toBe(true);
      await show.tap();
      const ho = page.locator('#jtHomeowner.open');
      await expect(ho).toBeVisible();
      const add = ho.locator('[data-jt-action="upg-ho-add"][data-id="alurex"]');
      const no = ho.locator('[data-jt-action="upg-ho-no"][data-id="alurex"]');
      await add.scrollIntoViewIfNeeded();
      const [a, n] = [await add.boundingBox(), await no.boundingBox()];
      expect(Math.round(a.width), 'Add and No thanks are the same size').toBe(Math.round(n.width));
      expect(Math.round(a.height)).toBe(Math.round(n.height));
      expect(a.height, 'thumb-sized').toBeGreaterThanOrEqual(48);
      const total = async () => dollarsToCents(((await ho.locator('[data-ho-total] b').textContent()) || '').trim());
      expect(await reachable(no), 'No thanks is not covered').toBe(true);
      await no.tap();
      await expect(no).toHaveAttribute('aria-pressed', 'true');
      withoutCents = await total();
      expect(await reachable(add), 'Add is not covered').toBe(true);
      await add.tap();
      await expect(add).toHaveAttribute('aria-pressed', 'true');
      hoTotalCents = await total();
      expect(hoTotalCents - withoutCents, 'Add moves the total by at least the quoted line').toBeGreaterThanOrEqual(lineCents);
      const done = ho.locator('[data-jt-action="upg-ho-done"]');
      expect(await reachable(done), 'hand back is reachable').toBe(true);
      await done.tap();
      await expect(page.locator('#jtHomeowner.open')).toHaveCount(0);
      await expect(page.locator('#jtUpgCard [data-jt-action="upg-pick"][data-id="alurex"]')).toHaveAttribute('aria-pressed', 'true');
    });

    await test.step('the proposal preview prints the upgrade line and the homeowner\'s total', async () => {
      const go = page.locator('#jtModalFoot [data-jt-action="go-preview"]');
      expect(await reachable(go), 'Preview proposal is reachable').toBe(true);
      await go.tap();
      await expect(page.locator('.jt-prop')).toBeVisible({ timeout: 10_000 });
      const row = page.locator('.jt-prop tr', { hasText: 'Upgrade — Alu-Rex DoublePro gutter guard' });
      await expect(row, 'the preview paper has the upgrade line').toHaveCount(1, { timeout: 5_000 });
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();
      const cells = await row.locator('td').allTextContents();
      expect(dollarsToCents(cells[cells.length - 1]), 'preview line = card line').toBe(lineCents);
      const tot = await page.locator('.jt-prop-tots .r.g span').last().textContent();
      expect(dollarsToCents(tot), 'preview total = the homeowner\'s running total').toBe(hoTotalCents);
    });

    await test.step('Create estimate saves the row at the card price and the same total', async () => {
      const create = page.locator('#jtModal [data-jt-action="create-estimate"]');
      await create.scrollIntoViewIfNeeded();
      await create.tap();
      await expect(page.locator('#jtModal .jt-success')).toBeVisible({ timeout: 20_000 });
      const saved = await safeEvaluate(page, async (lid) => {
        const fsMod = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
        const db = window.db || window._db;
        const uid = (window._auth || window.auth).currentUser.uid;
        const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, 'estimates'),
          fsMod.where('userId', '==', uid), fsMod.where('leadId', '==', lid)));
        let out = null; snap.forEach((d) => { if (!out) out = { id: d.id, ...d.data() }; });
        if (!out) return null;
        const row = (out.rows || []).find((r) => r.code === 'UPG LG-ARX') || null;
        return { id: out.id, grandTotal: out.grandTotal, upgradeCents: out.upgradeCents, upgradeTaxCents: out.upgradeTaxCents,
          row: row && { desc: row.desc, retailTotal: row.retailTotal, upgrade: row.upgrade },
          log: (out.upgradeLog && out.upgradeLog.items || []).map((i) => i.id + ':' + i.status) };
      }, lead.id);
      expect(saved, 'the estimate was saved against the customer').toBeTruthy();
      expect(saved.row, 'the saved estimate carries the upgrade row').toEqual({ desc: 'Upgrade — Alu-Rex DoublePro gutter guard', retailTotal: lineCents / 100, upgrade: true });
      expect(saved.upgradeCents, 'saved upgradeCents = card line').toBe(lineCents);
      expect(Math.round(saved.grandTotal * 100), 'saved total = the homeowner\'s running total').toBe(hoTotalCents);
      expect(hoTotalCents - withoutCents, 'Add moved the total by EXACTLY the line + its saved tax').toBe(lineCents + saved.upgradeTaxCents);
      expect(saved.log, 'the offered / chosen log').toEqual(expect.arrayContaining(['alurex:chosen']));
      savedId = saved.id;
    });

    // V2 used to drop an unknown "UPG …" code on the first edit after a
    // reopen (its live re-resolve runs every scope code through the catalog).
    await test.step('Open in Estimate Builder → edit → Save keeps the upgrade line and the total', async () => {
      const open = page.locator('#jtModal [data-jt-action="open-in-v2"]');
      expect(await reachable(open), 'Open in Estimate Builder is reachable').toBe(true);
      await open.tap();
      await expect(page.locator('#estV2Modal.open')).toBeVisible({ timeout: 15_000 });
      const upRow = page.locator('#v2scopeList .v2-scope-item[data-code="UPG LG-ARX"]');
      await expect(upRow, 'the reopened estimate lists the upgrade').toHaveCount(1, { timeout: 10_000 });
      await expect(upRow.locator('.name')).toContainText('Upgrade — Alu-Rex');
      expect(dollarsToCents(await upRow.locator('.total').textContent()), 'V2 row = card line').toBe(lineCents);
      // An edit that changes no price: from here V2 re-resolves live.
      await safeEvaluate(page, () => {
        const u = window.EstimateV2UI;
        u.updateMeasurement('stories', u.getState().measurements.stories);
      });
      expect(await safeEvaluate(page, () => window.EstimateV2UI.getState()._reopenedClean), 'the edit switched V2 to a live re-resolve').toBe(false);
      await expect(upRow, 'still listed after the edit').toHaveCount(1);
      // To the cent (review of #1763): #v2total printed whole dollars, so an
      // upgraded total with tax cents read differently here than on paper.
      expect(dollarsToCents(await page.locator('#v2total').textContent()), 'V2 total after the edit = the saved total, to the cent').toBe(hoTotalCents);
      await safeEvaluate(page, () => window.EstimateV2UI.save());
      await expect(page.locator('#v2saveStatus')).toHaveText(/Saved|error|fail/i, { timeout: 20_000 });
      const again = await safeEvaluate(page, async (id) => {
        const fsMod = await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
        const snap = await fsMod.getDoc(fsMod.doc(window.db || window._db, 'estimates', id));
        const d = snap.data() || {};
        const row = (d.rows || []).find((r) => r.code === 'UPG LG-ARX') || null;
        return { builder: d.builder, grandTotal: d.grandTotal, upgradeCents: d.upgradeCents,
          row: row && { desc: row.desc, retailTotal: row.retailTotal, upgrade: row.upgrade } };
      }, savedId);
      expect(again.builder, 'the V2 save updated the same estimate').toBe('v2');
      expect(again.row, 'the re-saved estimate still carries the tagged upgrade row').toEqual({ desc: 'Upgrade — Alu-Rex DoublePro gutter guard', retailTotal: lineCents / 100, upgrade: true });
      expect(Math.round(again.grandTotal * 100), 'and the same total, to the cent').toBe(hoTotalCents);
      expect(again.upgradeCents).toBe(lineCents);
    });
  });

  // Review of #1763 (2026-09-25, all three lenses): with a guard set to
  // "Make required", the homeowner page still offered the other guards of
  // its pick-one group, and "Add" on one silently swapped the rep's required
  // guard OUT — the total moved by the price difference, not by the price on
  // the card. Now a group holding a required pick is base scope: the page
  // offers none of it, and the rep's card refuses a sibling tap inline.
  test('Make required: the guard stays in the price; the homeowner page offers none of its group', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
    await safeWaitForFunction(page, () => !!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function'), { timeout: 20_000 });
    // company-profile.js replaces window._companyProfile when its one-shot
    // read lands; set the in-page price only after that, or it is wiped.
    await safeWaitForFunction(page, () => window._companyProfileLoaded === true, { timeout: 20_000 });
    await safeEvaluate(page, async () => {
      await window.ScriptLoader.loadBundle('estimates');
      // In-page tenant price for the 3x4 step-up, so the homeowner page has
      // an option OUTSIDE the leaf group (nothing is written anywhere).
      // Settings → Upgrade prices' shape (#1762), in memory only.
      const cp = window._companyProfile || {};
      window._companyProfile = Object.assign({}, cp, { pricing: Object.assign({}, cp.pricing || {},
        { upgradePrices: { downspout_3x4_step_up: { cents: 400, enabled: true, installerName: '' } } }) });
      window.JobTemplatesUI.openPicker({});
    });
    await expect(page.locator('#jtModal.open')).toBeVisible({ timeout: 15_000 });
    const use = page.locator('#jtModal [data-jt-action="quick-use"][data-id="jt_gi_k5_seamless_full"]');
    await use.scrollIntoViewIfNeeded();
    await use.tap();
    const card = page.locator('#jtUpgCard [data-upg-card]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#jtUpgCard [data-jt-action="upg-pick"][data-id="downspout_3x4_step_up"]'),
      'fixture: the in-page tenant price makes the 3x4 step-up pickable').toBeEnabled();

    const LB = 'leafblaster_pro_micromesh';
    const req = page.locator('#jtUpgCard [data-jt-action="upg-require"][data-id="' + LB + '"]');
    await req.scrollIntoViewIfNeeded();
    expect(await reachable(req), 'Make required is reachable').toBe(true);
    await req.tap();
    await expect(req).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#jtUpgCard [data-upg-grp-req="leaf_protection"]'), 'the group says its guard is in the price').toBeVisible();

    await test.step('the rep card refuses a sibling tap, on that row', async () => {
      const alu = page.locator('#jtUpgCard [data-jt-action="upg-pick"][data-id="alurex"]');
      await alu.scrollIntoViewIfNeeded();
      expect(await reachable(alu), 'the Alu-Rex row is reachable').toBe(true);
      await alu.tap();
      await expect(alu, 'Alu-Rex did not replace the required guard').toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#jtUpgCard [data-jt-action="upg-pick"][data-id="' + LB + '"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(req).toHaveAttribute('aria-pressed', 'true');
      const why = page.locator('#jtUpgCard [data-upg-err="alurex"]');
      await expect(why).toHaveText(/is required on this job\. Tap its “✓ Required” to release it first\./);
      await why.scrollIntoViewIfNeeded();
      expect(await reachable(why), 'the refusal is on screen, not under a layer').toBe(true);
    });

    await test.step('Show homeowner: none of the leaf group; Add on the other option moves the total by exactly its price + tax', async () => {
      const show = page.locator('#jtUpgCard [data-jt-action="upg-show-homeowner"]');
      await show.scrollIntoViewIfNeeded();
      await show.tap();
      const ho = page.locator('#jtHomeowner.open');
      await expect(ho).toBeVisible();
      for (const id of ['amerimax_lockin_mesh', LB, 'leafblaster_pro_reinforced', 'alurex']) {
        await expect(ho.locator('[data-id="' + id + '"], [data-ho-id="' + id + '"]'), id + ' is not offered to the homeowner').toHaveCount(0);
      }
      await ho.locator('.jt-ho-incl summary').tap();
      await expect(ho.locator('.jt-ho-incl li', { hasText: 'LeafBlaster PRO stainless micromesh gutter guard' }), 'the required guard is "Already included"').toHaveCount(1);
      const total = async () => dollarsToCents(((await ho.locator('[data-ho-total] b').textContent()) || '').trim());
      const t0 = await total();
      const line = dollarsToCents(await ho.locator('[data-ho-px="downspout_3x4_step_up"] b').textContent());
      const tax = await safeEvaluate(page, (c) => {
        const JT = window.JobTemplates;
        const res = JT.resolveSelection([{ templateId: 'jt_gi_k5_seamless_full' }], {});
        return window.NBDUpgrades.taxCentsAt(c, JT.buildEstimatePayload(res, {}).taxRate);
      }, line);
      const add = ho.locator('[data-jt-action="upg-ho-add"][data-id="downspout_3x4_step_up"]');
      await add.scrollIntoViewIfNeeded();
      expect(await reachable(add), 'Add is reachable').toBe(true);
      await add.tap();
      await expect(add).toHaveAttribute('aria-pressed', 'true');
      expect(await total() - t0, 'Add moved the total by EXACTLY the card line + its tax').toBe(line + tax);
      await ho.locator('[data-jt-action="upg-ho-done"]').tap();
      await expect(page.locator('#jtHomeowner.open')).toHaveCount(0);
      await expect(req, 'after hand back the guard is still required').toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#jtUpgCard [data-jt-action="upg-pick"][data-id="' + LB + '"]')).toHaveAttribute('aria-pressed', 'true');
    });
    await safeEvaluate(page, () => window.JobTemplatesUI.closeModal());
  });
});

// ── 4. Desktop keeps its layout; Job Templates modal is opaque + readable ──

test.describe('phone estbuilder: desktop + Job Templates modal @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use({ viewport: { width: 1280, height: 860 } });

  test('three-pane desktop layout intact; Job Templates title readable on a light header', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    // The light theme's surface tokens as the audit measured them on a phone
    // in light mode (header #fcf8f6, text #0f172a). Pinned so the check runs
    // against the palette that exposed the bug whatever theme CI boots.
    await page.addStyleTag({ content: ':root{--s:#fcf8f6 !important;--t:#0f172a !important;--bg:#faf2ee !important;}' });
    await openBuilder(page, {});

    await test.step('desktop: all three panes still side by side, nothing folded', async () => {
      const g = await page.evaluate(() => ['.pane-setup', '.pane-items', '.pane-review'].map((s) => {
        const r = document.querySelector('#estV2Modal ' + s).getBoundingClientRect();
        return { w: Math.round(r.width), top: Math.round(r.top) };
      }));
      for (const p of g) expect(p.w).toBeGreaterThan(200);
      expect(new Set(g.map((p) => p.top)).size, 'panes share one row').toBe(1);
      expect(await page.locator('#estV2Modal .v2-section.collapsed').count(), 'no section starts folded on desktop').toBe(0);
    });

    await test.step('estimate#12: Job Templates modal — readable title, opaque body', async () => {
      await page.locator('#estV2Modal [data-action="open-job-templates"]').click();
      await expect(page.locator('#jtModal.open')).toBeVisible({ timeout: 15_000 });
      const r = await page.evaluate(() => {
        const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
        const lum = (c) => { const m = rgb(c); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
        const title = document.querySelector('#jtModal .jt-m-title');
        const hdr = document.querySelector('#jtModal .jt-m-hdr');
        const body = document.getElementById('jtModalBody');
        const a = lum(getComputedStyle(title).color), b = lum(getComputedStyle(hdr).backgroundColor);
        const bg = rgb(getComputedStyle(body).backgroundColor);
        const h = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 40);
        return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), bodyAlpha: bg.length === 4 ? bg[3] : 1,
          bottomInBody: !!h && body.contains(h) };
      });
      expect(r.contrast, 'modal title vs its header (WCAG ratio)').toBeGreaterThanOrEqual(4.5);
      expect(r.bottomInBody).toBe(true);
      expect(r.bodyAlpha, 'the modal body is opaque — the dashboard never shows through').toBe(1);
    });
  });
});
