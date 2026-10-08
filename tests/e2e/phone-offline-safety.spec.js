// tests/e2e/phone-offline-safety.spec.js — the installed iPhone app on a roof
// with no signal (2026-10-04).
//
// Jo runs NBD Pro as a home-screen app. With bad signal three things lost
// work or locked him out:
//   1. An edit made offline lived only in memory (Firestore had no local
//      cache) — iOS killing the backgrounded app threw it away.
//   2. Reopening the app offline showed the browser's error page: the
//      service worker never answered navigations.
//   3. Door knocks queued offline were wiped by sign-out (nbd_ purge).
//
// Each test is BEHAVIOUR on the real app against the emulator, at 390x844
// with an iPhone user agent (single-tab persistent cache) and the installed
// app's @media (display-mode: standalone) rules forced on:
//   - offline → edit → reload (the iOS kill) → the edit is still queued on
//     the phone, the shell came from the service worker, the badge counts
//     it → back online → it reaches the SERVER (read with getDocFromServer).
//   - a knock queued offline survives NBDAuth.logout(), and after signing
//     back in the D2D flush sends it.
//
// Service workers are ALLOWED here (most phone specs block them). One login,
// one seeded lead (deleted by tag in afterAll). Tagged @shard2.
// Local run (from tests/, emulator up):
//   PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//   PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//   PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//   npx playwright test --config=playwright.config.js phone-offline-safety.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390;
const H = 844;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let creds = null;
try { creds = requireTestUser(); } catch (_) { /* every test skips below */ }

function contextOptions(testInfo) {
  const u = testInfo.project.use || {};
  const pick = {};
  for (const k of ['baseURL', 'bypassCSP', 'proxy', 'ignoreHTTPSErrors']) if (u[k] !== undefined) pick[k] = u[k];
  return {
    ...pick,
    viewport: { width: W, height: H },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'allow',
    userAgent: IPHONE_UA,
  };
}

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

async function skipTour(page) {
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  await safeEvaluate(page, () => { const o = document.getElementById('nbd-onb-overlay'); if (o) o.remove(); });
}

async function dashboardReady(page, timeout) {
  await safeWaitForFunction(page, () => !!(window._user && window._user.uid && typeof window._saveLead === 'function'
    && window.NBDOfflineSync && window.NBDFirestoreSync), { timeout: timeout || 45_000 });
}

test.describe('installed iPhone app — offline safety @shard2', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').BrowserContext} */ let ctx;
  /** @type {import('@playwright/test').Page} */ let page;
  let leadId = null;
  let run = '';
  let stamp = 0;
  const logs = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(180_000);
    stamp = Date.now();
    run = `phone-offline@390:${stamp}`;
    ctx = await browser.newContext(contextOptions(testInfo));
    page = await ctx.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    // Kept for the failure message: what the app said while booting offline.
    page.on('console', (m) => { logs.push(m.type() + ': ' + m.text().slice(0, 200)); if (logs.length > 400) logs.shift(); });
    page.on('pageerror', (e) => logs.push('pageerror: ' + String(e && e.message).slice(0, 200)));
    // NOT page.route(): any Playwright route turns Chromium's HTTP cache off,
    // and an offline relaunch loads the Firebase SDK modules (gstatic, a
    // year's max-age, deliberately not service-worker handled — INFRA-2)
    // from exactly that cache. Geocoding is stubbed in the page instead.
    await page.addInitScript(() => {
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (/nominatim\.openstreetmap\.org/.test(u)) return Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
        return real(input, init);
      };
    });
    await loginAs(page, creds);
    await dashboardReady(page);
    // First visit installs the worker; its activate() posts
    // SW_UPDATE_AVAILABLE and the page reloads onto it. Wait for a page that
    // is CONTROLLED, then for the boot after that reload.
    await safeWaitForFunction(page, () => !!(navigator.serviceWorker && navigator.serviceWorker.controller), { timeout: 60_000 });
    await page.waitForTimeout(2500);
    await dashboardReady(page);
    await skipTour(page);
    leadId = await safeEvaluate(page, async ({ s, tag }) => {
      await window._saveLead({
        firstName: '[E2E] Offline', lastName: String(s), address: `${String(s).slice(-4)} Ridge Rd, Cincinnati, OH`,
        phone: '513' + String(s).slice(-7), email: `e2e-offline-${s}@nbd.test`, stage: 'new',
        e2eTestData: true, e2eRun: tag,
      });
      for (let i = 0; i < 60 && !(window._leads || []).some((l) => l.lastName === String(s)); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const l = (window._leads || []).find((x) => x.lastName === String(s));
      return l ? l.id : null;
    }, { s: stamp, tag: run });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    if (ctx) { try { await ctx.setOffline(false); } catch (_) {} }
    const res = await deleteSeededRun({ page, context: ctx, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-offline-safety] cleanup: ' + res.failed.join('; '));
    if (ctx) await ctx.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('the app runs Firestore with a persistent single-tab cache (iPhone)', async () => {
    expect(leadId, 'seeded lead').toBeTruthy();
    const mode = await safeEvaluate(page, () => window.__NBD_FS_CACHE);
    expect(mode).toBe('single');
  });

  test('offline edit → reload (iOS kill) → still queued on the phone → syncs when back online', async () => {
    test.setTimeout(240_000);
    // The service worker has stored the app shell for an offline launch.
    await expect.poll(() => safeEvaluate(page, async () => {
      const c = await caches.open('nbd-appshell-v1');
      return !!(await c.match('/pro/__app-shell__/dashboard'));
    }), { timeout: 30_000, message: 'app shell cached by sw.js' }).toBe(true);
    // Let the controlled load finish populating the asset cache (never
    // networkidle: Firestore long polling keeps a request open forever).
    await page.waitForTimeout(3000);

    await ctx.setOffline(true);
    await expect.poll(() => safeEvaluate(page, () => navigator.onLine), { timeout: 10_000 }).toBe(false);
    const note = 'offline edit ' + stamp;
    const t0 = Date.now();
    const saved = await safeEvaluate(page, async ({ id, n }) => {
      const lead = (window._leads || []).find((l) => l.id === id) || {};
      const out = await Promise.race([
        window._saveLead({ id, firstName: lead.firstName, lastName: lead.lastName, address: lead.address, phone: lead.phone, notes: n }).then(() => 'returned'),
        new Promise((r) => setTimeout(() => r('HUNG'), 15000)),
      ]);
      return out;
    }, { id: leadId, n: note });
    expect(saved, 'Save returns offline instead of hanging on the server ack').toBe('returned');
    expect(Date.now() - t0).toBeLessThan(14_000);
    await expect.poll(() => safeEvaluate(page, () => window.NBDOfflineSync.countPending()), { timeout: 15_000, message: 'the edit is in Firestore\'s on-phone queue' }).toBeGreaterThanOrEqual(1);
    await forceStandalone(page);
    const badge = page.locator('#nbdSyncBadge');
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText(/waiting to sync/);
    await page.screenshot({ path: test.info().outputPath('offline-badge-390.png') });

    // The iOS kill: the page is gone; the app is reopened with no signal.
    logs.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await dashboardReady(page, 90_000);
    } catch (e) {
      const st = await safeEvaluate(page, () => ({ user: !!(window._user && window._user.uid), save: typeof window._saveLead, sync: typeof window.NBDOfflineSync, fsync: typeof window.NBDFirestoreSync, url: location.href })).catch(() => null);
      const noise = /cleardot|Listen\/channel|INTERNET_DISCONNECTED/;
      throw new Error('offline relaunch never became ready: ' + JSON.stringify(st) + '\n' + logs.filter((l) => !noise.test(l)).slice(-40).join('\n'));
    }
    await forceStandalone(page);
    const after = await safeEvaluate(page, async ({ id, n }) => {
      const pending = await window.NBDOfflineSync.countPending();
      for (let i = 0; i < 40 && !(window._leads || []).some((l) => l.id === id); i++) await new Promise((r) => setTimeout(r, 250));
      const lead = (window._leads || []).find((l) => l.id === id);
      return {
        pending,
        online: navigator.onLine,
        controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        notes: lead ? lead.notes : null,
        fromCache: window._leadsFromCache === true,
        confirmed: window._leadsLoaded === true,
      };
    }, { id: leadId, n: note });
    expect(after.online).toBe(false);
    expect(after.controlled, 'the reloaded page was served by the service worker').toBe(true);
    expect(after.pending, 'the offline edit survived the reload, still queued').toBeGreaterThanOrEqual(1);
    expect(after.notes, 'the board shows the edit from the on-phone cache').toBe(note);
    expect(after.fromCache, 'the book came from the cache').toBe(true);
    expect(after.confirmed, 'a cache book is NOT treated as a confirmed load (sample data / import guards)').toBe(false);
    await expect(page.locator('#nbdSyncBadge')).toBeVisible({ timeout: 10_000 });
    // Not hidden behind offline-banner.js's full-width notice, and on screen.
    await expect.poll(() => safeEvaluate(page, () => {
      const r = document.getElementById('nbdSyncBadge').getBoundingClientRect();
      const ob = document.getElementById('nbd-offline-banner');
      const under = ob ? ob.getBoundingClientRect().bottom : 0;
      return r.top >= under - 1 && r.left >= 0 && r.right <= innerWidth && r.height > 0;
    }), { timeout: 5_000, message: 'badge sits below the offline banner, inside 390px' }).toBe(true);
    await page.screenshot({ path: test.info().outputPath('offline-reloaded-390.png') });
    const overflow = await safeEvaluate(page, () => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, 'no sideways scroll at 390px').toBeLessThanOrEqual(0);

    // Signal back: the queued edit reaches the server by itself.
    await ctx.setOffline(false);
    await expect.poll(() => safeEvaluate(page, () => window.NBDOfflineSync.countPending()), { timeout: 60_000, message: 'queue drained' }).toBe(0);
    const server = await safeEvaluate(page, async (id) => {
      const m = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      const snap = await m.getDocFromServer(m.doc(window._db, 'leads', id));
      return snap.exists() ? snap.data().notes : null;
    }, leadId);
    expect(server, 'the edit made offline is on the server').toBe(note);
    await expect(page.locator('#nbdSyncBadge')).toBeHidden({ timeout: 15_000 });
  });

  test('a knock queued offline survives sign-out and syncs after signing back in', async () => {
    test.setTimeout(180_000);
    const addr = `${String(stamp).slice(-4)} Knock Ln, Cincinnati, OH`;
    await safeEvaluate(page, ({ a }) => {
      const uid = window._user.uid;
      localStorage.setItem('nbd_d2d_sync_queue', JSON.stringify([{ action: 'submitKnock', data: { address: a, disposition: 'not_home', notes: 'e2e offline knock' }, timestamp: Date.now(), uid }]));
      localStorage.setItem('nbd_d2d_queue_last_known_size', '1');
      localStorage.setItem('nbd_e2e_purge_probe', 'account data');   // positive control: must be purged
    }, { a: addr });
    // logout() → replace('/pro/login.html') → hosting's 301 to /pro/login:
    // the first navigation aborts by design, so poll the URL, not waitForURL.
    await safeEvaluate(page, () => { window.NBDAuth.logout(); });
    await expect.poll(() => page.url(), { timeout: 30_000, message: 'signed out to login' }).toMatch(/\/pro\/login/);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await safeWaitForFunction(page, () => !!document.getElementById('loginBtn'), { timeout: 30_000 });
    const kept = await safeEvaluate(page, () => ({
      queue: localStorage.getItem('nbd_d2d_sync_queue'),
      probe: localStorage.getItem('nbd_e2e_purge_probe'),
    }));
    expect(kept.probe, 'positive control: ordinary nbd_ data IS purged at sign-out').toBeNull();
    expect(kept.queue && JSON.parse(kept.queue).length, 'the offline knock survived sign-out').toBe(1);

    await loginAs(page, creds);
    await dashboardReady(page);
    await skipTour(page);
    await safeEvaluate(page, () => window.goTo('d2d'));
    let knockId = null;
    await expect.poll(async () => {
      const r = await safeEvaluate(page, (a) => {
        const st = window._D2DState || {};
        const k = (st.knocks || []).find((x) => x.address === a);
        return { left: (st.offlineQueue || []).length, id: k ? k.id : null };
      }, addr);
      knockId = r.id;
      return r.left === 0 && !!r.id;
    }, { timeout: 60_000, message: 'D2D flush sent the kept knock' }).toBe(true);
    // Clean up the knock (submitKnock writes no e2eRun tag).
    await safeEvaluate(page, async (id) => {
      const m = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
      await m.deleteDoc(m.doc(window._db, 'knocks', id));
    }, knockId).catch(() => {});
  });
});
