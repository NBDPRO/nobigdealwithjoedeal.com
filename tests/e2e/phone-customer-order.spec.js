// tests/e2e/phone-customer-order.spec.js — the customer page ordered for a
// phone on a roof (2026-10-08, phone audit 2026-10-07 item 1).
//
// The audit measured the customer page at 390×844 (installed-app rules) at
// 15 phone screens, with the quick-note box 4.9 screens down, Build Estimate
// 4.7 and Record payment 12.3 — under 22 document-template tiles. This pins
// the fix by BEHAVIOUR:
//
//   1. The roof-day action row (Call · Text · Note · Estimate · Payment ·
//      Navigate) is on the first screen, every button is ≥ 44px, and each one
//      reaches the SAME handler the page already used for that job — proved
//      by tapping the row button and then the original control and watching
//      the same spy fire.
//   2. The bottom bar's EMAIL slot is NOTE now, and it opens the note sheet.
//   3. Documents (22 tiles) start folded on a phone; a jump to Files opens
//      them. The page is shorter, Notes / Build Estimate / Record payment sit
//      near the top, and every tap target on the page is ≥ 44px.
//   4. An owed balance floats Invoices & Payments above Notes.
//   5. Desktop keeps two columns and open panels.
//
// Nothing leaves the machine: every Cloud Function call is answered here,
// tel:/sms: navigations are cancelled, and the estimate / payment entry
// points are replaced by spies AFTER their identity is checked.
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const H = 844;

let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    if (document.getElementById('e2e-force-standalone')) return -1;
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

async function rig(page) {
  const fnCalls = [];
  await page.route(/(127\.0\.0\.1:5001|cloudfunctions\.net|\.run\.app)\//, (route) => {
    fnCalls.push(route.request().url());
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'stubbed by phone-customer-order' } }) });
  });
  await page.route(/(api\.twilio\.com|api\.resend\.com|api\.stripe\.com|fcm\.googleapis\.com)/, (r) => r.abort());
  await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (e) { /* private mode */ } });
  return fnCalls;
}

async function seed(page, { owed }) {
  return safeEvaluate(page, async (owed) => {
    const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
    const db = window.db || window._db;
    const uid = window._user.uid;
    const companyId = (window._userClaims && window._userClaims.companyId) || uid;
    const stamp = Date.now() + (owed ? 1 : 0);
    const lead = {
      firstName: '[E2E] Roof', lastName: 'Order' + stamp, address: (stamp % 9000 + 100) + ' Ridge Vent Rd, Loveland, OH 45140',
      phone: '513' + String(stamp).slice(-7), email: 'delivered@resend.dev',
      stage: owed ? 'install_complete' : 'inspected', jobType: 'cash', jobValue: 14200,
      e2eTestData: true, userId: uid, companyId, meter: 'manual', createdAt: fs.serverTimestamp(),
    };
    const id = (await fs.addDoc(fs.collection(db, 'leads'), lead)).id;
    if (owed) {
      await fs.addDoc(fs.collection(db, 'invoices'), {
        leadId: id, createdBy: uid, companyId, userId: uid, customerName: lead.firstName + ' ' + lead.lastName,
        description: 'Roof replacement', status: 'sent', total: 14200, subtotal: 14200, tax: 0,
        amountPaid: 0, balanceDue: 14200, payments: [], createdAt: new Date(), e2eTestData: true,
      });
    }
    return { id, address: lead.address };
  }, owed);
}

async function openCustomer(page, id, { phone = true } = {}) {
  await page.goto('/pro/customer.html?id=' + id);
  await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 30_000 });
  await safeWaitForFunction(page, () => !!(window._currentLead && window._customerId), { timeout: 30_000 });
  if (phone) await forceStandalone(page);
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  // Late panels (suggestion card, lead score, invoices) keep landing for a
  // beat after hydration; measure the settled page.
  await safeWaitForFunction(page, () => !/Loading invoices/.test((document.getElementById('invoiceList') || {}).textContent || ''), { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
}

// tel:/sms: never leave the page; every such tap is recorded with the
// anchor that received it. Spies wrap (not replace) the note sheet so it
// really opens; estimate and payment are replaced so nothing navigates or
// writes — after recording that the page delegate would have called them.
async function installSpies(page) {
  await page.evaluate(() => {
    window.__hits = [];
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href^="tel:"], a[href^="sms:"]');
      if (!a) return;
      e.preventDefault();
      // The row's own anchor is the TAP; what counts is where it lands.
      if (a.closest('#roofActionRow')) return;
      window.__hits.push('nav:' + (a.id || a.className) + ':' + a.getAttribute('href').replace(/\d+/, 'N'));
    }, true);
    const cl = document.getElementById('callLink');
    const orig = cl.onclick;
    cl.onclick = function (e) { window.__hits.push('callLink.onclick'); return orig ? orig.call(this, e) : undefined; };
    const note = window.openNotesModal;
    window.openNotesModal = function () { window.__hits.push('openNotesModal'); return note.apply(this, arguments); };
    window._openInDashboardEstimate = function () { window.__hits.push('estimate:' + window._customerId); };
    window.NBDCustomerInvoices.recordPayment = function (leadId) { window.__hits.push('recordPayment:' + leadId); return Promise.resolve(false); };
  });
}
const hits = (page) => page.evaluate(() => window.__hits.splice(0));
async function closeNotes(page) {
  await page.evaluate(() => window.closeNotesModal && window.closeNotesModal());
  await expect(page.locator('#notesModal')).toBeHidden();
}

test.describe.serial('customer page, roof-day order on a phone @shard2', () => {
  test.skip(!creds, 'needs PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD');
  test.use(IPHONE);
  let ctx, page, fnCalls, A, B;

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    ctx = await browser.newContext({ ...IPHONE, baseURL: testInfo.project.use.baseURL });
    page = await ctx.newPage();
    fnCalls = await rig(page);
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid && (window.db || window._db)), { timeout: 30_000 });
    A = await seed(page, { owed: false });
    B = await seed(page, { owed: true });
  });
  test.afterAll(async () => { if (ctx) await ctx.close(); });

  test('the six roof-day actions sit on the first screen, 44px or more', async () => {
    test.setTimeout(90_000);
    await openCustomer(page, A.id);
    const r = await page.evaluate(() => {
      const bar = document.getElementById('nbd-quick-action-bar');
      const barTop = bar ? bar.getBoundingClientRect().top : innerHeight;
      return { barTop, btns: [...document.querySelectorAll('#roofActionRow [data-roof]')].map((b) => {
        const x = b.getBoundingClientRect(); return { k: b.getAttribute('data-roof'), top: x.top, bottom: x.bottom, w: x.width, h: x.height, vis: !b.hidden };
      }) };
    });
    expect(r.btns.map((b) => b.k)).toEqual(['call', 'text', 'note', 'estimate', 'payment', 'navigate']);
    for (const b of r.btns) {
      expect(b.vis, b.k + ' shown (the lead has a phone and an address)').toBe(true);
      expect(b.h, b.k + ' ≥ 44px tall').toBeGreaterThanOrEqual(44);
      expect(b.w, b.k + ' ≥ 44px wide').toBeGreaterThanOrEqual(44);
      expect(b.bottom, b.k + ' above the bottom bar at scroll 0').toBeLessThanOrEqual(r.barTop);
    }
    await page.screenshot({ path: test.info().outputPath('roof-row-390.png') });
  });

  test('each row button reaches the handler the page already used', async () => {
    test.setTimeout(90_000);
    await openCustomer(page, A.id);
    await installSpies(page);
    const row = (k) => page.locator('#roofActionRow [data-roof="' + k + '"]');

    // Call → the header's #callLink (its onclick writes the Comm Log row).
    await row('call').tap();
    expect(await hits(page)).toEqual(['nav:callLink:tel:N', 'callLink.onclick']);

    // Text → the bottom bar's Text anchor (its capture listener logs).
    await row('text').tap();
    const t = await hits(page);
    expect(t.length, 'one navigation').toBe(1);
    expect(t[0]).toMatch(/^nav:qab-btn qab-sms:sms:N$/);

    // Note → openNotesModal, the same sheet as the Notes panel's editor link.
    await row('note').tap();
    expect(await hits(page)).toEqual(['openNotesModal']);
    await expect(page.locator('#notesModal')).toBeVisible();
    await closeNotes(page);
    await page.locator('.cpo-notes [data-action="openNotesModal"]').click();
    expect(await hits(page), 'the panel link calls the same function').toEqual(['openNotesModal']);
    await closeNotes(page);

    // Estimate → _openInDashboardEstimate, same as the Estimates panel button.
    await row('estimate').tap();
    expect(await hits(page)).toEqual(['estimate:' + A.id]);
    await page.locator('.cpo-estimates [data-action="_openInDashboardEstimate"]').click();
    expect(await hits(page)).toEqual(['estimate:' + A.id]);

    // Payment → NBDCustomerInvoices.recordPayment(leadId), same as the
    // Invoices panel's Record payment.
    await row('payment').tap();
    expect(await hits(page)).toEqual(['recordPayment:' + A.id]);
    await page.locator('#invoiceList [data-rp-open]').click();
    expect(await hits(page)).toEqual(['recordPayment:' + A.id]);

    // Navigate → directions to the header's address (Apple Maps on iPhone).
    const nav = await row('navigate').evaluate((a) => ({ href: a.href, target: a.target, rel: a.rel }));
    expect(nav.href).toBe('https://maps.apple.com/?daddr=' + encodeURIComponent(A.address));
    expect(nav.target).toBe('_blank');
    expect(nav.rel).toContain('noopener');
  });

  test('the bottom bar: Call · Text · Note · Task — Note opens the note sheet, Email is in More', async () => {
    test.setTimeout(60_000);
    await openCustomer(page, A.id);
    await installSpies(page);
    await safeWaitForFunction(page, () => !!document.querySelector('#nbd-quick-action-bar .qab-note'), { timeout: 15_000 });
    const labels = await page.$$eval('#nbd-quick-action-bar .qab-btn > span:last-child', (bs) => bs.map((b) => b.textContent.trim()));
    expect(labels).toEqual(['Call', 'Text', 'Note', 'Task']);
    expect(await page.locator('#nbd-quick-action-bar a[href^="mailto:"]').count()).toBe(0);
    await page.locator('#nbd-quick-action-bar .qab-note').tap();
    expect(await hits(page)).toEqual(['openNotesModal']);
    await expect(page.locator('#notesModal')).toBeVisible();
    await closeNotes(page);
    // Email: one tap on More, then it is there.
    await page.locator('#qaMoreBtn').tap();
    await expect(page.locator('.quick-actions #emailLink')).toBeVisible();
    await page.locator('#qaMoreBtn').tap();
  });

  test('documents start folded; a jump to Files opens them; the page is shorter and every target is 44px', async () => {
    test.setTimeout(90_000);
    await openCustomer(page, A.id);
    // Selectors that exist on the old page too, so a revert fails on the
    // numbers, not on a missing hook. Panel controls only (not the row).
    const m = await page.evaluate((H) => {
      const y = (s) => {
        const el = [...document.querySelectorAll(s)].find((e) => !e.closest('#roofActionRow'));
        return el ? (el.getBoundingClientRect().top + scrollY) / H : null;
      };
      return { screens: document.scrollingElement.scrollHeight / H, note: y('#quickNoteInput'),
        build: y('[data-action="_openInDashboardEstimate"]'), pay: y('#invoiceList [data-rp-open]') };
    }, H);
    console.log('[phone-customer-order] screens/note/build/pay', JSON.stringify(m));
    // origin/main (f8d07b8d) measured this seeded lead at 15.1 screens, with
    // the Notes box at 4.9, Build Estimate at 4.5 and Record payment at 11.8
    // (this branch: 9.7 / 1.6 / 2.7 / 3.1).
    expect(m.screens, 'page length in phone screens').toBeLessThan(10.5);
    expect(m.note, 'Notes panel').toBeLessThan(2.2);
    expect(m.build, 'Estimates panel Build Estimate').toBeLessThan(3);
    expect(m.pay, 'Invoices panel Record payment').toBeLessThan(3.5);

    const fold = page.locator('#docTemplatesFold');
    expect(await fold.evaluate((d) => d.open), 'Documents start closed on a phone').toBe(false);
    const tiles = await page.locator('#docTemplateGrid .doc-template-card').count();
    expect(tiles).toBeGreaterThan(20);
    await expect(fold.locator('.cpo-fold-count')).toHaveText(String(tiles));
    await expect(page.locator('#docTemplateGrid .doc-template-card').first()).toBeHidden();

    const small = await page.evaluate(() => {
      const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const out = [];
      document.querySelectorAll('.container a[href], .container button, .container input:not([type=hidden]), .container select, .container textarea, .container [role=button], .container [data-action], .container summary, header a[href], header button').forEach((el) => {
        if (!vis(el) || el.closest('.nbd-photo-badge')) return;
        if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p,li,small')) return;
        if (el.tagName === 'INPUT' && /checkbox|radio/.test(el.type) && el.closest('label')) { const l = el.closest('label').getBoundingClientRect(); if (l.height >= 44 && l.width >= 44) return; }
        const r = el.getBoundingClientRect();
        if (r.height < 43.5 || r.width < 43.5) out.push((el.id || el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (el.textContent || '').trim().slice(0, 24) + '"');
      });
      return out;
    });
    expect(small, 'tap targets under 44px at 390').toEqual([]);

    // The jump nav's Files chip opens every fold in that section.
    await page.locator('#tabBar a[href="#documentsTab"]').tap();
    await expect.poll(() => fold.evaluate((d) => d.open)).toBe(true);
    await expect(page.locator('#docTemplateGrid .doc-template-card').first()).toBeVisible();
    expect(await page.locator('#documentsTab details.cpo-fold:not([open])').count(), 'all Files folds open').toBe(0);
    await page.screenshot({ path: test.info().outputPath('files-opened-390.png') });
  });

  test('money first: an owed balance floats Invoices & Payments above Notes', async () => {
    test.setTimeout(60_000);
    await openCustomer(page, B.id);
    await expect(page.locator('#invoicesPanel')).toHaveAttribute('data-owed', '1', { timeout: 20_000 });
    const ys = await page.evaluate(() => ({ money: document.getElementById('invoicesPanel').getBoundingClientRect().top,
      notes: document.querySelector('.cpo-notes').getBoundingClientRect().top, est: document.querySelector('.cpo-estimates').getBoundingClientRect().top }));
    expect(ys.money, 'owed money above Notes').toBeLessThan(ys.notes);
    // …and with nothing owed it waits below Estimates.
    await openCustomer(page, A.id);
    await expect(page.locator('#invoicesPanel')).not.toHaveAttribute('data-owed', '1');
    const ya = await page.evaluate(() => ({ money: document.getElementById('invoicesPanel').getBoundingClientRect().top,
      est: document.querySelector('.cpo-estimates').getBoundingClientRect().top }));
    expect(ya.money).toBeGreaterThan(ya.est);
    expect(fnCalls.filter((u) => /send(Email|SMS|Sms)/.test(u)), 'nothing sent').toEqual([]);
  });

  // Dark (the default navy) and a light theme. The customer page has no
  // ThemeEngine (theme-system.css keys off :root[data-theme]), so setting the
  // attribute IS what a rep's saved theme does at boot.
  for (const theme of ['nbd-original', 'paper']) {
    test('theme ' + theme + ' at 390: no sideways scroll, row readable, targets 44px', async () => {
      test.setTimeout(90_000);
      await openCustomer(page, B.id);
      await safeEvaluate(page, (t) => {
        const st = document.createElement('style');
        st.textContent = '*, *::before, *::after { transition: none !important; }';
        document.head.appendChild(st);
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        // Let the canvas resolve any CSS colour syntax (rgb(), color(srgb ...) from
        // color-mix(), oklab...) to RGBA, instead of parsing strings by hand.
        const cv = document.createElement('canvas'); cv.width = cv.height = 1;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        const rgb = (c) => {
          cx.clearRect(0, 0, 1, 1);
          cx.fillStyle = '#010203'; cx.fillStyle = String(c);
          cx.fillRect(0, 0, 1, 1);
          const d = cx.getImageData(0, 0, 1, 1).data;
          return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        };
        const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
        const lum = (c) => { const x = [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]; };
        const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
        // Background under an element: composite each ancestor's fill, bottom up.
        const under = (el) => {
          const chain = [];
          for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0) chain.push(c); if (c && c.a >= 1) break; }
          let acc = { r: 255, g: 255, b: 255, a: 1 };
          for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
          return acc;
        };
        const doc = document.documentElement;
        const btns = [...document.querySelectorAll('#roofActionRow [data-roof]')].map((b) => {
          const cs = getComputedStyle(b);
          const bg = under(b);
          const fg = rgb(cs.color);
          return { k: b.getAttribute('data-roof'), h: b.getBoundingClientRect().height, ratio: ratio(over(fg, bg), bg), right: b.getBoundingClientRect().right };
        });
        return { theme: doc.getAttribute('data-theme'), sw: doc.scrollWidth, cw: doc.clientWidth, vw: innerWidth, btns,
          owed: document.getElementById('invoicesPanel').getAttribute('data-owed') };
      });
      expect(r.theme).toBe(theme);
      expect(r.sw, 'document scrollWidth within the viewport').toBeLessThanOrEqual(r.cw);
      expect(r.owed, 'owed balance still floats money first').toBe('1');
      expect(r.btns.length).toBe(6);
      for (const b of r.btns) {
        expect(b.h, b.k + ' height').toBeGreaterThanOrEqual(44);
        expect(b.right, b.k + ' inside the viewport').toBeLessThanOrEqual(r.vw);
        expect(b.ratio, b.k + ' label contrast on ' + theme).toBeGreaterThanOrEqual(4.5);
      }
      await page.screenshot({ path: test.info().outputPath('theme-' + theme + '-390.png') });
    });
  }

  test('desktop keeps two columns, open panels and a one-line action row', async ({ browser }, testInfo) => {
    test.setTimeout(90_000);
    const d = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', baseURL: testInfo.project.use.baseURL });
    const p = await d.newPage();
    await rig(p);
    await loginAs(p, creds);
    await openCustomer(p, A.id, { phone: false });
    const r = await p.evaluate(() => {
      const box = (s) => { const el = document.querySelector(s); const x = el.getBoundingClientRect(); return { x: x.left, top: x.top, bottom: x.bottom }; };
      const btns = [...document.querySelectorAll('#roofActionRow [data-roof]')].map((b) => b.getBoundingClientRect().top);
      return { est: box('.cpo-estimates'), files: box('.cpo-files'), money: box('#invoicesPanel'),
        rowLines: new Set(btns.map((t) => Math.round(t))).size,
        folded: document.querySelectorAll('details.cpo-fold:not([open])').length,
        tilesShown: document.querySelector('#docTemplateGrid .doc-template-card').getBoundingClientRect().height > 0 };
    });
    expect(r.rowLines, 'the action row is one line on desktop').toBe(1);
    expect(r.est.x, 'Estimates stay in the right column').toBeGreaterThan(r.files.x);
    expect(r.money.x, 'Invoices sit in the right column with Estimates').toBe(r.est.x);
    expect(r.money.top, 'below Estimates').toBeGreaterThan(r.est.top);
    expect(r.folded, 'no panel is folded on desktop').toBe(0);
    expect(r.tilesShown).toBe(true);
    await p.screenshot({ path: test.info().outputPath('desktop-1440.png') });
    await d.close();
  });
});
