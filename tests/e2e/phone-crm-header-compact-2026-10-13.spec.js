// tests/e2e/phone-crm-header-compact-2026-10-13.spec.js — the CRM tab shows
// cards, not chrome, on the installed iPhone app.
//
// Jo, 2026-10-13: "CRM tab is getting a bit tight again". At 390 wide the
// stacked Pipeline header (title row, search + type select, toolbar, the
// seven view tabs wrapping ALL onto a second row, a ~230px "N customers have
// no job type" banner, three stat chips, a Compact/Rich/Photo row) pushed the
// first card to ~60% of the viewport. This pins the compact header:
//   1  the seven view tabs share ONE row (ALL no longer wraps), still 44px
//      tall and tappable;
//   2  the no-job-type banner is one slim line with both actions reachable;
//   3  the stat chips and the card-style switch share one row;
//   4  the first card starts above 52% of the viewport.
// Every check is geometry in the installed-app cascade (standalone rules
// forced, notch inset live), asserted behaviourally (elementFromPoint).
// Set NBD_QA_SHOTS=<dir> to also write full-viewport PNGs.
// Local run (from tests/, emulator up):
//   PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//   PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//   PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//   npx playwright test --config=playwright.config.js phone-crm-header-compact-2026-10-13.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction, ensureClassicLayout } = require('./fixtures/auth');
const { deleteSeededRun } = require('./fixtures/seeded-run');

const W = 390;
const H = 844;
const INSET_TOP = 47;
const INSET_BOTTOM = 34;
const TAP = 44;

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
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  };
}

async function applyInsets(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: INSET_TOP, bottom: INSET_BOTTOM, left: 0, right: 0 },
  });
}

// The installed app's @media (display-mode: standalone) cascade copied to
// the top level (a browser tab never matches display-mode: standalone).
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
  await safeEvaluate(page, () => {
    const o = document.getElementById('nbd-onb-overlay'); if (o) o.remove();
    document.querySelectorAll('#toastContainer > *, .toast, #nbd-push-optin').forEach((t) => t.remove());
  });
}

// Everything the header is made of, measured in one pass (CSS px).
async function measure(page) {
  return safeEvaluate(page, () => {
    const box = (el) => {
      if (!el || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const rows = (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top / 8))).size;
    const tabs = [...document.querySelectorAll('#kanbanViewSwitcher .kview-btn')];
    const cards = [...document.querySelectorAll('#kanbanBoard .k-card')].filter((c) => c.getClientRects().length);
    cards.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const strip = document.getElementById('krStrip');
    const btns = (sel) => [...document.querySelectorAll(sel)].filter((b) => b.getClientRects().length).map((b) => {
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      const h = document.elementFromPoint(x, y);
      return { t: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), ok: !!h && (h === b || b.contains(h)) };
    });
    return {
      vh: innerHeight,
      header: box(document.querySelector('.crm-header')),
      tabs: tabs.map((t) => box(t)),
      tabRows: rows(tabs),
      tabHits: btns('#kanbanViewSwitcher .kview-btn'),
      banner: box(document.querySelector('#sortCustomersWrap .sc-banner')),
      bannerBtns: btns('#sortCustomersWrap .sc-btn'),
      strip: box(strip),
      stats: box(strip && strip.querySelector('.kr-stats')),
      sw: box(strip && strip.querySelector('.kr-switch')),
      swBtns: btns('#krStrip .kr-sw'),
      statBtns: btns('#krStrip .kr-stat'),
      bannerLabel: (() => {
        const t = document.querySelector('#sortCustomersWrap .sc-banner-text');
        return (t && t.getAttribute('aria-label')) || '';
      })(),
      cycle: btns('#krStrip .kr-cycle'),
      density: document.documentElement.getAttribute('data-density') || '',
      board: box(document.getElementById('kanbanBoard')),
      firstCard: box(cards[0]),
    };
  });
}

test.describe('CRM tab on the installed iPhone — compact header @shard2', () => {
  test.describe.configure({ mode: 'default' });
  /** @type {import('@playwright/test').BrowserContext} */ let ctx;
  /** @type {import('@playwright/test').Page} */ let page;
  let run = '';

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!creds) return;
    testInfo.setTimeout(150_000);
    const stamp = Date.now();
    run = `phone-crm-header@390:${stamp}`;
    ctx = await browser.newContext(contextOptions(testInfo));
    page = await ctx.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.route('**/nominatim.openstreetmap.org/**', (r) => r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.route(/cloudfunctions\.net\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"result":{}}' }));
    await page.addInitScript(() => {
      try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) { /* storage blocked */ }
    });
    await applyInsets(page);
    await loginAs(page, creds);
    await ensureClassicLayout(page); // the shard shares one rep: a leftover Crew pick changed the CRM tab (2026-10-25)
    await applyInsets(page);
    await safeWaitForFunction(page, () => typeof window.addDoc === 'function' && !!window.db && !!window._user && typeof window._loadLeads === 'function', { timeout: 30_000 });
    await safeEvaluate(page, ({ s, tag }) => {
      window.__e2eSeeding = (async () => {
        const uid = window._user.uid;
        const base = {
          userId: uid, companyId: (window._userClaims && window._userClaims.companyId) || uid,
          source: 'Door Knock', damageType: 'Roof - Hail', claimStatus: 'No Claim',
          createdAt: new Date(), updatedAt: new Date(), meter: 'manual', e2eTestData: true, e2eRun: tag,
        };
        const rows = [];
        const stages = ['new', 'new', 'contacted', 'inspected', 'new', 'contacted'];
        // typed leads, and untyped ones (no jobType) so the banner shows
        for (let i = 0; i < 10; i++) {
          rows.push({ firstName: 'Hdr', lastName: 'Typed' + i + '-' + s, stage: stages[i % stages.length], jobType: i % 3 ? 'insurance' : 'cash', jobValue: 8000 + i * 500 });
        }
        for (let i = 0; i < 8; i++) {
          rows.push({ firstName: 'Hdr', lastName: 'Untyped' + i + '-' + s, stage: stages[i % stages.length], jobValue: 7000 + i * 400 });
        }
        let n = 0;
        for (const r of rows) {
          n += 1;
          await window.addDoc(window.collection(window.db, 'leads'), Object.assign({}, base, r, {
            address: (10 + n) + ' Header Ln, Milford OH 45150', phone: '(513) 555-' + String(1000 + n),
          }));
        }
        await window._loadLeads();
        return n;
      })();
      return window.__e2eSeeding;
    }, { s: stamp, tag: run });
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(120_000);
    if (!page) return;
    const res = await deleteSeededRun({ page, context: ctx, creds, run });
    // eslint-disable-next-line no-console
    if (res.failed.length) console.warn('[phone-crm-header] cleanup: ' + res.failed.join('; '));
    if (ctx) await ctx.close();
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  async function openCrm() {
    if (!page.url().includes('/pro/dashboard')) {
      await page.goto('/pro/dashboard.html');
      await applyInsets(page);
    }
    await safeWaitForFunction(page, () => typeof window.goTo === 'function' && !!(window._user && window._user.uid), { timeout: 30_000 });
    await skipTour(page);
    await safeEvaluate(page, () => { window.goTo('crm'); });
    await page.waitForFunction(() => {
      const el = document.getElementById('view-crm');
      return !!el && el.classList.contains('active') && !!document.getElementById('crmViewBoardBtn');
    }, null, { timeout: 30_000 });
    // Jo's screenshot is the Board; the phone may default to List.
    await safeEvaluate(page, () => { if (typeof window.crmViewBoard === 'function') window.crmViewBoard(); });
    await page.waitForFunction(() => !!document.querySelector('#kanbanBoard .k-card') && !!document.getElementById('krStrip'), null, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    // Worst case, as on Jo's real book: three-digit counts on every tab.
    await safeEvaluate(page, () => {
      const c = { insurance: '188', cash: '41', finance: '', warranty: '1', service: '19', jobs: '41', simple: '249' };
      Object.keys(c).forEach((k) => { const el = document.getElementById('kview-count-' + k); if (el) el.textContent = c[k]; });
    });
    await forceStandalone(page);
    await skipTour(page);
    await safeEvaluate(page, () => {
      window.scrollTo(0, 0);
      const el = document.getElementById('view-crm');
      if (el) { el.scrollTop = 0; el.querySelectorAll('.view-scroll').forEach((x) => { x.scrollTop = 0; }); }
    });
    await page.waitForTimeout(200);
  }

  // A failed test restarts the worker (fresh login, lands on Home), so every
  // test makes sure it is on the CRM Board before it measures.
  async function ensureCrm() {
    const on = await safeEvaluate(page, () => {
      const v = document.getElementById('view-crm');
      return !!v && v.classList.contains('active') && !!document.querySelector('#kanbanBoard .k-card') && !!document.getElementById('krStrip');
    }).catch(() => false);
    if (!on) await openCrm();
  }

  const bad = (rows) => rows.filter((r) => !r.ok).map((r) => `${r.t}: covered`);
  const shortOf = (rows) => rows.filter((r) => r.h < TAP).map((r) => `${r.t}: ${r.w}x${r.h}`);

  test('positive control: notch inset live, board rendered with the banner and strip', async () => {
    await openCrm();
    const inset = await safeEvaluate(page, () => {
      const p = document.createElement('div');
      p.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);';
      document.body.appendChild(p);
      const h = parseFloat(getComputedStyle(p).height);
      p.remove();
      return h;
    });
    expect(inset, 'CDP safe-area override reached the page').toBe(INSET_TOP);
    const m = await measure(page);
    // eslint-disable-next-line no-console
    console.log('[crm-header] ' + JSON.stringify(m));
    if (process.env.NBD_QA_SHOTS) {
      await page.screenshot({ path: process.env.NBD_QA_SHOTS + '/crm-header-' + (process.env.NBD_QA_TAG || 'run') + '.png' });
    }
    expect(m.tabs.length, 'the seven view tabs rendered').toBe(7);
    expect(m.banner, 'the no-job-type banner rendered (untyped customers seeded)').toBeTruthy();
    expect(m.strip, 'the Open / Weighted / Going cold strip rendered').toBeTruthy();
    expect(m.firstCard, 'a card rendered').toBeTruthy();
  });

  test('1 · the seven view tabs share ONE row, 44px tall, every one tappable', async () => {
    await ensureCrm();
    const m = await measure(page);
    expect(m.tabRows, 'rows the tabs sit on (ALL used to wrap onto a second row); tabs: ' + m.tabHits.map((t) => t.t + ' ' + t.w + 'x' + t.h).join(', ') + ' in ' + m.vw + 'px').toBe(1);
    expect(m.tabHits.length).toBe(7);
    expect(shortOf(m.tabHits), 'tab heights').toEqual([]);
    expect(bad(m.tabHits), 'tabs under a finger').toEqual([]);
    const last = m.tabs[6];
    expect(last.right, 'ALL ends inside the viewport').toBeLessThanOrEqual(W);
  });

  test('2 · the no-job-type banner is one slim line with both actions', async () => {
    await ensureCrm();
    const m = await measure(page);
    expect(m.banner.h, 'banner height (was 115px+ on 390)').toBeLessThanOrEqual(60);
    expect(m.bannerBtns.map((b) => b.t).join('|'), 'both actions kept').toBe('One at a time|See the list');
    expect(shortOf(m.bannerBtns), 'banner buttons 44px').toEqual([]);
    expect(bad(m.bannerBtns), 'banner buttons under a finger').toEqual([]);
    expect(Math.abs(m.bannerBtns[0].top - m.bannerBtns[1].top), 'both actions on one row').toBeLessThanOrEqual(2);
    expect(m.bannerLabel, 'the full explanation is kept for assistive tech').toMatch(/no job type, so they only show on All and Insurance/);
  });

  test('3 · stats and card style share one row; the style button cycles', async () => {
    await ensureCrm();
    let m = await measure(page);
    expect(m.strip.h, 'strip is one 44px row (was two stacked rows, 80px)').toBeLessThanOrEqual(48);
    expect(Math.abs(m.stats.top - m.sw.top), 'stats and style on the same line').toBeLessThanOrEqual(2);
    expect(m.statBtns.length, 'Open / Weighted / Going cold').toBe(3);
    expect(bad(m.statBtns), 'stat chips under a finger').toEqual([]);
    expect(m.cycle.length, 'one cycle button on the phone').toBe(1);
    expect(bad(m.cycle), 'cycle button under a finger').toEqual([]);
    expect(m.swBtns, 'the three-segment switch is hidden on the phone').toEqual([]);
    // 44px hit area: tap 20px above and below the 32px chip's centre
    const hitArea = await safeEvaluate(page, () => {
      const b = document.querySelector('#krStrip .kr-cycle');
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const up = document.elementFromPoint(x, r.top - 5);
      const down = document.elementFromPoint(x, r.bottom + 5);
      const d = (e) => (e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + String(e.className).split(' ')[0] : 'none');
      return { up: !!up && (up === b || b.contains(up)), down: !!down && (down === b || b.contains(down)), upHit: d(up), downHit: d(down) };
    });
    expect({ up: hitArea.up, down: hitArea.down }, 'cycle hit area reaches 44px ' + JSON.stringify(hitArea)).toEqual({ up: true, down: true });
    // cycle from the default (no style chosen): Cards > Compact > Rich > Photo > Compact
    await safeEvaluate(page, () => { window.setKanbanDensity('comfortable'); });
    await page.waitForTimeout(500);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await page.locator('#krStrip .kr-cycle').tap();
      await page.waitForTimeout(500);
      seen.push(await safeEvaluate(page, () => ({
        density: document.documentElement.getAttribute('data-density'),
        style: document.documentElement.getAttribute('data-rich-style'),
        label: document.querySelector('#krStrip .kr-cycle').textContent.trim(),
      })));
    }
    // eslint-disable-next-line no-console
    console.log('[crm-header] cycle ' + JSON.stringify(seen));
    expect(seen.map((x) => x.label), 'label names the style it just set').toEqual(['Compact', 'Rich', 'Photo', 'Compact']);
    expect(seen[0].density, 'first tap').toBe('compact');
    expect(seen[1].density, 'second tap').toBe('rich');
    expect(seen[2].style, 'third tap').toBe('photo');
    expect(seen[3].density, 'fourth tap').toBe('compact');
    await safeEvaluate(page, () => { window.setKanbanDensity('comfortable'); });
    await page.waitForTimeout(300);
    m = await measure(page);
    expect(m.strip.h, 'strip stays one row in every style').toBeLessThanOrEqual(48);
  });

  test('4 · the first card starts in the top half of the screen', async () => {
    await ensureCrm();
    const m = await measure(page);
    // eslint-disable-next-line no-console
    console.log(`[crm-header] first card top=${m.firstCard.top}px of ${m.vh}px (${Math.round(100 * m.firstCard.top / m.vh)}%); was 588px (70%) before the compact header`);
    // CI 2026-10-25 (@shard2, test 160 of 168): 424px alone, over 52% in the shard. The message names every visible
    // block between the top of the page and the first card, so the next miss names the cover instead of the symptom.
    const stack = await safeEvaluate(page, (cardTop) => [...document.querySelectorAll('#view-crm *')].filter((e) => { const r = e.getBoundingClientRect(); return r.height >= 16 && r.width >= 200 && r.top >= 0 && r.bottom <= cardTop + 1 && e.children.length < 12 && !e.closest('.k-card'); }).slice(0, 24).map((e) => { const r = e.getBoundingClientRect(); return (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]) + ' ' + Math.round(r.top) + '-' + Math.round(r.bottom); }).join(' | ') + ' || layout=' + document.documentElement.getAttribute('data-layout') + ' density=' + document.documentElement.getAttribute('data-density') + ' body=' + document.body.className, m.firstCard.top);
    expect(m.firstCard.top, 'first card top (px); above it: ' + stack).toBeLessThanOrEqual(Math.round(m.vh * 0.52));
  });

  test('5 · a desktop-width window keeps the three-segment style switch', async () => {
    await ensureCrm();
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(500);
    const r = await safeEvaluate(page, () => {
      const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
      return {
        segs: [...document.querySelectorAll('#krStrip .kr-sw')].filter(vis).map((b) => b.textContent.trim()),
        cycle: vis(document.querySelector('#krStrip .kr-cycle')),
      };
    });
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(300);
    expect(r.segs, 'Compact / Rich / Photo').toEqual(['Compact', 'Rich', 'Photo']);
    expect(r.cycle, 'cycle button hidden on a wide window').toBe(false);
  });
});
