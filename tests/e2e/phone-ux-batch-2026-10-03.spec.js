// tests/e2e/phone-ux-batch-2026-10-03.spec.js — the installed iPhone app's
// tap targets, measured the way a thumb meets them.
//
// Jo runs NBD Pro as a home-screen app on an iPhone (390x844, a 47px notch
// inset at the top and a 34px home bar at the bottom). A scout pass over
// origin/main on 2026-10-03 found ten places where a tap landed on the
// wrong thing, or on nothing. Each test below pins one of them:
//
//   1  customer header under the notch: the page asks for viewport-fit=cover
//      and a translucent status bar, but the header was a flat 52px with no
//      safe-area padding, so Back and the mic sat under the clock; the
//      pinned jump-nav stuck at top:0, under the notch too.
//   2  the customer jump-nav sat at y~768 on load, UNDER the fixed
//      Call/Text/Task bar — Overview/Timeline/Photos/Files taps dialled or
//      texted the homeowner instead.
//   3  D2D: an inline height:55dvh on #d2dMap (and a standalone-only
//      !important twin) beat the phone heights, so Knock/Heat/Hail opened
//      below the bottom nav.
//   4  "Turn on appointment reminders": its snooze key was wiped by every
//      sign-out (purgeAccountStorage keep-list), so it came back each time,
//      and its buttons were 27px tall.
//   5  pipeline view tabs: Jobs/All scrolled under the Board/List toggle.
//   6  "← Back to …" breadcrumbs were 12px tall.
//   7  the connection dot (#nbd-conn-btn) was 31x19.
//   8  chips at 25-29px: Ask Joe prompts, Reports periods, Docs filters,
//      Photos mode, pipeline list names.
//   9  the doc-template ⓘ preview was 22x22 and scrolled under the quick bar.
//  10  Log Expense: Category and the receipt picker were clipped.
//
// Every check is BEHAVIOUR: document.elementFromPoint at the control's
// centre must return the control (or a descendant), and sizes are
// getBoundingClientRect. The installed app is reproduced with the
// @media (display-mode: standalone) rules copied to the top level (same
// technique as phone-chrome / phone-views) plus a real safe-area inset from
// CDP Emulation.setSafeAreaInsetsOverride — asserted live by a positive
// control first, so a browser that ignores the override fails loudly
// instead of passing every inset check at 0px.
//
// One login, one seeded lead (deleted by tag in afterAll). Tagged @shard2.
// Local run (from tests/, emulator up):
//   PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//   PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//   PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//   npx playwright test --config=playwright.config.js phone-ux-batch-2026-10-03.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390;
const H = 844;
const INSET_TOP = 47;
const INSET_BOTTOM = 34;
const TAP = 44; // Apple HIG minimum

let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

// Context options the config's `use` would normally supply; a context made
// in beforeAll doesn't inherit them.
function contextOptions(testInfo) {
  const u = testInfo.project.use || {};
  const pick = {};
  for (const k of ['baseURL', 'bypassCSP', 'proxy', 'ignoreHTTPSErrors']) if (u[k] !== undefined) pick[k] = u[k];
  return {
    ...pick,
    viewport: { width: W, height: H },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  };
}

// The notch + home bar. Re-sent after every navigation (cheap, idempotent).
async function applyInsets(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: INSET_TOP, bottom: INSET_BOTTOM, left: 0, right: 0 },
  });
}

// The installed app's @media (display-mode: standalone) cascade, copied to
// the top level: a browser tab never matches display-mode: standalone.
// Re-run after anything that may have added sheets (idempotent).
async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    const old = document.getElementById('e2e-force-standalone');
    if (old) old.remove();
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

// elementFromPoint at the centre of every visible match. ok = the thumb
// would land on that control right now, inside the viewport.
async function hits(page, selector, opts) {
  return safeEvaluate(page, ({ sel, o }) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
      if (o && o.reveal) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const label = (el.id ? '#' + el.id : '') + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24) + '"';
      let why = 'hit';
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) why = 'off-screen at ' + Math.round(x) + ',' + Math.round(y);
      else {
        const h = document.elementFromPoint(x, y);
        if (!h || !(h === el || el.contains(h))) {
          why = 'covered by ' + (h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') + (typeof h.className === 'string' && h.className ? '.' + h.className.trim().split(/\s+/)[0] : '') : 'nothing');
        }
      }
      out.push({ label, why, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) });
      if (o && o.max && out.length >= o.max) break;
    }
    return out;
  }, { sel: selector, o: opts || null });
}

const covered = (rows) => rows.filter((r) => r.why !== 'hit').map((r) => `${r.label}: ${r.why}`);
const short = (rows, min) => rows.filter((r) => r.h < min).map((r) => `${r.label}: ${r.w}x${r.h}`);
const narrow = (rows, min) => rows.filter((r) => r.w < min).map((r) => `${r.label}: ${r.w}x${r.h}`);

// Toasts, and the reminders card: test 4 measures the card on purpose, but
// on any fresh page (a worker restarted after a failure logs in again with
// empty localStorage) it boots 4s in and would decide every other hit-test.
async function dropToasts(page) {
  await safeEvaluate(page, () => {
    document.querySelectorAll('#toastContainer > *, .toast, #nbd-push-optin').forEach((t) => t.remove());
  });
}

async function onDashboard(page) {
  if (!page.url().includes('/pro/dashboard')) {
    await page.goto('/pro/dashboard.html');
    await applyInsets(page);
  }
  await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!(window._user && window._user.uid), { timeout: 30_000 });
  await skipTour(page);
}

// A fresh login can open the onboarding tour, whose overlay takes every tap.
async function skipTour(page) {
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  await safeEvaluate(page, () => { const o = document.getElementById('nbd-onb-overlay'); if (o) o.remove(); });
}

async function goView(page, view) {
  await onDashboard(page);
  await safeEvaluate(page, (v) => { window.goTo(v); }, view);
  await page.waitForFunction((v) => {
    const el = document.getElementById('view-' + v);
    return !!el && el.classList.contains('active') && el.getBoundingClientRect().height > 0;
  }, view, { timeout: 15_000 });
  await page.waitForTimeout(700);
  // Start every view at the top: an earlier test may have left it scrolled.
  await safeEvaluate(page, (v) => {
    window.scrollTo(0, 0);
    const el = document.getElementById('view-' + v);
    if (el) { el.scrollTop = 0; el.querySelectorAll('.view-scroll').forEach((x) => { x.scrollTop = 0; }); }
  }, view);
  await forceStandalone(page);
  await dropToasts(page);
}

test.describe('installed iPhone app — tap targets and safe areas @shard2', () => {
  // NOT serial: one failing check must not skip the other nine. Each test
  // gets itself onto the page it measures (onDashboard / onCustomer), so a
  // worker restarted after a failure (fresh login in beforeAll) still works.
  test.describe.configure({ mode: 'default' });
  /** @type {import('@playwright/test').BrowserContext} */ let ctx;
  /** @type {import('@playwright/test').Page} */ let page;
  let leadId = null;
  let run = '';

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(120_000);
    const stamp = Date.now();
    run = `phone-ux-batch@390:${stamp}`; // set before the first write (seeded-run.js)
    ctx = await browser.newContext(contextOptions(testInfo));
    page = await ctx.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    // A mis-tap on the quick bar must never leave the page (tel:/sms:).
    await page.addInitScript(() => {
      document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[href^="tel:"],a[href^="sms:"],a[href^="mailto:"]');
        if (a) e.preventDefault();
      }, true);
    });
    await applyInsets(page);
    await loginAs(page, creds);
    await applyInsets(page);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid && typeof window._saveLead === 'function'), { timeout: 30_000 });
    leadId = await safeEvaluate(page, ({ s, tag }) => {
      window.__e2eSeeding = (async () => {
        try {
          await window._saveLead({
            firstName: '[E2E] UxBatch', lastName: String(s), address: `${String(s).slice(-4)} Notch Way, Cincinnati, OH`,
            phone: '513' + String(s).slice(-7), email: `e2e-uxbatch-${s}@nbd.test`, stage: 'new',
            e2eTestData: true, e2eRun: tag,
          });
        } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
        for (let i = 0; i < 60 && !(window._leads || []).some((l) => l.lastName === String(s)); i++) {
          if (i % 10 === 0 && typeof window._loadLeads === 'function') await window._loadLeads().catch(() => {});
          await new Promise((r) => setTimeout(r, 250));
        }
        const l = (window._leads || []).find((x) => x.lastName === String(s));
        return l ? l.id : null;
      })();
      return window.__e2eSeeding;
    }, { s: stamp, tag: run });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    const res = await deleteSeededRun({ page, context: ctx, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-ux-batch] cleanup: ' + res.failed.join('; '));
    if (ctx) await ctx.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('positive control: the notch and home-bar insets are live', async () => {
    const inset = await safeEvaluate(page, () => {
      const p = document.createElement('div');
      p.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);';
      document.body.appendChild(p);
      const cs = getComputedStyle(p);
      const r = { top: parseFloat(cs.height), bottom: parseFloat(cs.paddingBottom) };
      p.remove();
      return r;
    });
    expect(inset, 'CDP safe-area override reached the page (otherwise every inset check below is vacuous)').toEqual({ top: INSET_TOP, bottom: INSET_BOTTOM });
    expect(leadId, 'seeded lead has an id').toBeTruthy();
  });

  test('4 · reminders card: 44px buttons, and "Not now" survives a sign-out', async () => {
    // The card boots 4s after the dashboard is ready, only while
    // Notification.permission is "default" and the snooze is unset.
    // A fresh dashboard load with the snooze cleared (the card checks it at boot).
    await onDashboard(page);
    await safeEvaluate(page, () => { try { localStorage.removeItem('nbd_push_optin_snoozed_until'); } catch (_) {} });
    await page.reload();
    await applyInsets(page);
    const appeared = await page.waitForSelector('#nbd-push-optin', { timeout: 15_000 }).then(() => true, () => false);
    if (appeared) {
      await forceStandalone(page);
      const btns = await hits(page, '#nbd-push-optin button');
      expect(btns.length, 'Not now + Enable').toBe(2);
      // soft: the keep-list half below must run (and report) either way.
      expect.soft(short(btns, TAP), 'reminder card buttons under 44px tall').toEqual([]);
      expect.soft(covered(btns), 'reminder card buttons take a tap').toEqual([]);
      // The taller card must not sit over what a rep is typing for: with a
      // text field focused (keyboard up) it stands aside, and comes back on blur.
      const yieldState = await safeEvaluate(page, async () => {
        const vis = () => getComputedStyle(document.getElementById('nbd-push-optin')).display !== 'none';
        const inp = document.createElement('input');
        inp.type = 'search';
        inp.className = 'e2e-kbd-probe';
        document.body.appendChild(inp);
        inp.focus();
        await new Promise((r) => setTimeout(r, 50));
        const typing = vis();
        inp.blur();
        await new Promise((r) => setTimeout(r, 50));
        const after = vis();
        inp.remove();
        return { typing, after };
      });
      expect.soft(yieldState, 'card hidden while typing, back after').toEqual({ typing: false, after: true });
      await page.locator('#nbd-push-optin button', { hasText: 'Not now' }).tap();
      await expect(page.locator('#nbd-push-optin')).toHaveCount(0);
    } else {
      // A browser without push support never shows it; snooze by hand so
      // the keep-list half still runs.
      test.info().annotations.push({ type: 'note', description: 'push opt-in card not offered by this browser' });
      // eslint-disable-next-line no-console
      console.warn('[phone-ux-batch] push opt-in card not offered — button sizes NOT measured this run');
      await safeEvaluate(page, () => localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 864e5)));
    }
    const kept = await safeEvaluate(page, async () => {
      const before = localStorage.getItem('nbd_push_optin_snoozed_until');
      await window.NBDAuth.purgeAccountStorage();
      return { before: !!before, after: localStorage.getItem('nbd_push_optin_snoozed_until') };
    });
    expect(kept.before, 'snooze was recorded').toBe(true);
    expect(kept.after, 'snooze survives the sign-out purge').not.toBeNull();
  });

  test('7 · the connection dot is a 44x44 target', async () => {
    await goView(page, 'dash');
    const r = await hits(page, '#nbd-conn-btn');
    expect(r.length, '#nbd-conn-btn rendered').toBe(1);
    expect([...short(r, TAP), ...narrow(r, TAP)], '#nbd-conn-btn size').toEqual([]);
    expect(covered(r), '#nbd-conn-btn takes a tap').toEqual([]);
  });

  test('5 · every pipeline view tab is on screen, none under Board/List', async () => {
    await goView(page, 'crm');
    const overlap = await safeEvaluate(page, () => {
      const a = document.getElementById('kanbanViewSwitcher').getBoundingClientRect();
      const b = document.querySelector('.crm-view-mode').getBoundingClientRect();
      const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return Math.round(ix * iy);
    });
    expect(overlap, 'px² of the view-tab row under the Board/List toggle').toBe(0);
    // At load, no swipe: the old row scrolled sideways, so All sat out of
    // sight with its centre under ▦ Board, and the fade was the only hint.
    const tabs = await hits(page, '#kanbanViewSwitcher .kview-btn');
    expect(tabs.length, 'all seven view tabs').toBe(7);
    expect(covered(tabs), 'view tabs on screen and tappable without a swipe').toEqual([]);
    expect(covered(await hits(page, '.crm-view-mode .kview-btn')), 'Board / List').toEqual([]);
  });

  test('8 · pipeline list names are 44px tall', async () => {
    await goView(page, 'crm');
    await page.locator('#crmViewListBtn').tap();
    await safeWaitForFunction(page, () => !!document.querySelector('.cl-card-name'), { timeout: 15_000 });
    await forceStandalone(page);
    const names = await hits(page, 'a.cl-card-name', { max: 3 });
    expect(names.length, 'list rendered a customer name').toBeGreaterThan(0);
    expect(short(names, TAP), 'pipeline list name links').toEqual([]);
    await page.locator('#crmViewBoardBtn').tap();
  });

  test('6 · breadcrumbs are 44px tall without growing the text', async () => {
    await goView(page, 'photos');
    const r = await hits(page, '#view-photos .bc-meta-cp');
    expect(r.length, 'photos breadcrumb rendered').toBeGreaterThan(0);
    expect(short(r, TAP), '"← Back to …" tap height').toEqual([]);
    expect(covered(r), 'breadcrumb takes a tap').toEqual([]);
    const fs = await safeEvaluate(page, () => getComputedStyle(document.querySelector('#view-photos .bc-meta-cp')).fontSize);
    expect(fs, 'visual text size unchanged').toBe('10px');
  });

  test('8 · chips clear 44px: Photos mode, Docs filters, Ask Joe prompts, Reports periods', async () => {
    const cases = [
      ['photos', '#view-photos .ph-mode-btn'],
      ['docs', '#view-docs .tl-filter-btn'],
      ['joe', '#view-joe .joe-quick'],
      ['reports', '#view-reports .nbd-rdash-period'],
    ];
    const bad = [];
    for (const [view, sel] of cases) {
      await goView(page, view);
      if (view === 'reports') await safeWaitForFunction(page, () => !!document.querySelector('.nbd-rdash-period'), { timeout: 15_000 });
      const r = await hits(page, sel, { max: 6 });
      if (!r.length) bad.push(`${sel}: none rendered`);
      bad.push(...short(r, TAP).map((s) => `${view} ${s}`));
    }
    expect(bad, 'chips under 44px tall').toEqual([]);
  });

  test('3 · D2D: Knock / Heat / Hail open above the bottom nav', async () => {
    await goView(page, 'd2d');
    await safeWaitForFunction(page, () => !!document.querySelector('.d2d-action-bar .d2d-big-btn'), { timeout: 20_000 });
    await page.waitForTimeout(800);
    await forceStandalone(page);
    await dropToasts(page);
    await safeEvaluate(page, () => {
      window.scrollTo(0, 0);
      const c = document.getElementById('d2dContent'); if (c) c.scrollTop = 0;
      const v = document.getElementById('view-d2d'); if (v) v.scrollTop = 0;
    });
    const map = await safeEvaluate(page, () => Math.round(document.getElementById('d2dMap').getBoundingClientRect().height));
    const r = await hits(page, '.d2d-action-bar .d2d-big-btn', { max: 3 });
    expect(r.length, 'Knock, Heat, Hail').toBe(3);
    expect(covered(r), `D2D action row on load (map ${map}px tall)`).toEqual([]);
  });

  test('10 · Log Expense: Category and the receipt picker are not clipped', async () => {
    await goView(page, 'expenses');
    await page.locator('[data-exp-action="open-form"]').first().tap();
    await page.waitForSelector('#expFormOverlay.open #expCategory', { timeout: 10_000 });
    await page.waitForTimeout(400);
    const m = await safeEvaluate(page, () => {
      const form = document.querySelector('#expFormOverlay .modal');
      const cs = getComputedStyle(form);
      const inner = form.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const sel = document.getElementById('expCategory');
      const opt = sel.options[sel.selectedIndex];
      // Width the selected label needs, in the select's own font, plus the
      // select's padding and the native arrow (~24px).
      const probe = document.createElement('span');
      const scs = getComputedStyle(sel);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + scs.font + ';letter-spacing:' + scs.letterSpacing;
      probe.textContent = opt ? opt.textContent : '';
      document.body.appendChild(probe);
      const need = probe.getBoundingClientRect().width + parseFloat(scs.paddingLeft) + parseFloat(scs.paddingRight) + 24;
      probe.remove();
      return {
        inner: Math.round(inner),
        sel: Math.round(sel.getBoundingClientRect().width),
        need: Math.round(need),
        label: opt ? opt.textContent : '',
        file: Math.round(document.getElementById('expFile').getBoundingClientRect().width),
      };
    });
    expect(m.sel, `Category select (${m.sel}px) fits "${m.label}" (${m.need}px)`).toBeGreaterThanOrEqual(m.need);
    expect(m.file, `receipt picker (${m.file}px) spans the form (${m.inner}px)`).toBeGreaterThanOrEqual(Math.floor(m.inner * 0.9));
    await page.locator('#expFormOverlay [data-exp-action="close-form"]').tap();
  });

  // Fresh load of this test's lead, so every customer test starts at scroll 0
  // on a page that has not been touched by an earlier one.
  async function onCustomer() {
    await page.goto(`/pro/customer.html?id=${leadId}`);
    await applyInsets(page);
    await safeWaitForFunction(page, () => document.documentElement.style.opacity === '1', { timeout: 30_000 });
    await page.waitForSelector('#nbd-quick-action-bar .qab-call', { timeout: 15_000 });
    await page.waitForTimeout(600);
    await skipTour(page);
    await forceStandalone(page);
    await dropToasts(page);
  }

  test('1 · customer header clears the notch; the pinned jump-nav pins below it', async () => {
    await onCustomer();
    const head = await safeEvaluate(page, () => {
      const out = [];
      for (const el of document.querySelectorAll('header a, header button, header .logo')) {
        if (!el.getClientRects().length) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height) out.push({ label: (el.textContent || '').trim().slice(0, 16), top: Math.round(r.top) });
      }
      return out;
    });
    expect(head.length, 'header controls rendered').toBeGreaterThan(0);
    expect(head.filter((h) => h.top < INSET_TOP).map((h) => `${h.label} @${h.top}`), 'header controls under the notch').toEqual([]);

    // Scroll far enough that the jump-nav pins.
    await safeEvaluate(page, () => window.scrollTo(0, document.getElementById('photosTab').offsetTop));
    await page.waitForTimeout(500);
    const nav = await safeEvaluate(page, () => Math.round(document.getElementById('tabBar').getBoundingClientRect().top));
    expect(nav, 'pinned jump-nav top (inside the notch when < 47)').toBeGreaterThanOrEqual(INSET_TOP - 1);
    expect(covered(await hits(page, '#tabBar a', { max: 3 })), 'pinned chips take a tap').toEqual([]);
  });

  test('2 · on load, Overview / Timeline / Photos / Files are not under the quick bar', async () => {
    await onCustomer();
    const r = await hits(page, '#tabBar a[href="#overviewTab"], #tabBar a[href="#timelineTab"], #tabBar a[href="#photosTab"], #tabBar a[href="#documentsTab"]', { reveal: true });
    expect(r.length, 'four chips').toBe(4);
    expect(covered(r), 'jump-nav chips on load').toEqual([]);
  });

  test('9 · doc-template ⓘ previews are 44x44 and scroll clear of the quick bar', async () => {
    await onCustomer();
    await safeWaitForFunction(page, () => document.querySelectorAll('.dt-preview-btn').length > 0, { timeout: 15_000 });
    await forceStandalone(page);
    await dropToasts(page);
    const r = await hits(page, '.dt-preview-btn', { reveal: true, max: 6 });
    expect(r.length, 'preview buttons rendered').toBeGreaterThan(0);
    expect([...short(r, TAP), ...narrow(r, TAP)], 'ⓘ preview size').toEqual([]);
    expect(covered(r), 'ⓘ preview scrolled into view takes a tap').toEqual([]);
  });
});
