/**
 * tests/e2e/layout-island.spec.js — L04 Island Dock end to end on the
 * emulators (2026-10-12).
 *
 * A rep who chose Island Dock has no sidebar: a floating pill nav at the top,
 * a floating dock (New lead / Filter / Sort) at the bottom, Home leads with a
 * giant PROJECTED "in play" number (it must equal the Pipeline header's own
 * "$N pipeline", the independent oracle) and the pipeline's columns are
 * swipeable stage lanes. The job view opens with the hero image of the house.
 *
 * Phone-scale rule: checked at desktop 1280, tablet 820 and iPhone 390, on one
 * light and one dark theme, with and without a wallpaper; plus Reduce Motion
 * and prefers-contrast: more.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

// an absolute http(s) url: renderCoverHero (and the hero) accept nothing else
const COVER = (process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000').replace(/[/]$/, '') +'/assets/images/drone-hero-crew-800.webp';

async function resetSettings(email) {
  const { initializeApp, getApps } = require('firebase-admin/app');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const uid = (await require('firebase-admin/auth').getAuth().getUserByEmail(email)).uid;
  await getFirestore().doc('userSettings/' + uid).set({ layout: FieldValue.delete() }, { merge: true });
  await getFirestore().doc('companies/' + uid + '/settings/layout').delete().catch(() => {});
  return uid;
}

async function overflowX(page) {
  return safeEvaluate(page, () => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}

test.describe.serial('Island Dock @shard2', () => {
  test.afterEach(async () => { await resetSettings(requireTestUser().email).catch(() => {}); });

  test('pill + dock + in-play headline + stage lanes + hero, across widths and themes', async ({ page }) => {
    test.setTimeout(300_000);
    const creds = requireTestUser();
    await resetSettings(creds.email);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });

    // two open jobs with a value, one lost (must not count), one with a cover
    const s = Date.now();
    // distinct phone + street per lead: the duplicate guard would otherwise stop the second save
    let n = 0;
    const mk = (last, stage, jobValue, extra) => { n++; return safeEvaluate(page, (a) => window._saveLead(Object.assign({
      firstName: 'ZZIS', lastName: a.last + a.s, address: (40 + a.n) + ' Island Way, Mason, OH 45040', phone: '51355502' + String(10 + a.n), stage: a.stage, jobValue: a.jobValue,
    }, a.extra || {})), { last, s, stage, jobValue, extra, n }); };
    await mk('OpenA', 'new', 12000);
    await mk('OpenB', 'new', 8000);
    await mk('Lost', 'lost', 50000);
    const coverId = await mk('Cover', 'new', 1000, { coverPhotoUrl: COVER });
    await safeWaitForFunction(page, (st) => (window._leads || []).filter((l) => (l.lastName || '').endsWith(st)).length >= 4, s, { timeout: 30_000 });

    // Classic: the sidebar is there
    expect(await safeEvaluate(page, () => !!document.querySelector('.sidebar') && getComputedStyle(document.querySelector('.sidebar')).display !== 'none')).toBe(true);
    const oracle = await (async () => {
      await safeEvaluate(page, () => window.goTo('crm'));
      await page.locator('#crmSubLine .crm-stat-money-full').waitFor({ state: 'attached', timeout: 20_000 });
      return safeEvaluate(page, () => document.querySelector('#crmSubLine .crm-stat-money-full').textContent.trim());
    })();
    expect(oracle).toMatch(/^\$[\d,]+$/);

    // choose island for all three surfaces
    for (const device of ['desktop', 'tablet', 'phone']) {
      const saved = await safeEvaluate(page, (d) => window.LayoutEngine.saveUser({ id: 'island', device: d }), device);
      expect(saved.saved).toBe(true);
    }
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'island' && !!document.getElementById('nbdIslandPill'), null, { timeout: 40_000 });

    // the app reopens on the last page (Pipeline); start the walk from Home
    await safeEvaluate(page, () => window.goTo('home'));
    await page.locator('#view-home.active').waitFor({ state: 'attached', timeout: 15_000 });

    // ── chrome: no sidebar, pill + dock ──
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('#nbdIslandPill')).toBeVisible();
    expect(await page.locator('#nbdIslandPill .isl-item').count()).toBeGreaterThanOrEqual(4);
    await expect(page.locator('#nbdIslandDock .isl-item')).toHaveCount(3);
    await expect(page.locator('#nbdIslandDock')).toContainText('New lead');
    await expect(page.locator('#nbdIslandPill .isl-active')).toContainText('Today');

    // ── Home: the projected headline equals the Pipeline header ──
    await page.locator('.isl-hero-num[data-isl="in-play"]').waitFor({ state: 'visible', timeout: 40_000 });
    await expect(page.locator('.isl-hero-k')).toContainText('projected');
    await expect(page.locator('.isl-hero-sub')).toContainText('not money collected');
    const homeVal = (await page.locator('.isl-hero-num[data-isl="in-play"]').innerText()).trim();
    expect(homeVal).toBe(oracle);
    expect(homeVal).not.toBe('$0');
    await expect(page.locator('#nbdIslandHome')).not.toContainText(/revenue/i);

    // ── dock: New lead opens the real form; Sort + Filter drive the Pipeline's own buttons ──
    await safeEvaluate(page, () => { window.__islLead = 0; const o = window.openLeadModal; window.openLeadModal = function () { window.__islLead++; return o.apply(this, arguments); }; });
    await page.locator('[data-lk-nav="newlead"]').click();
    expect(await safeEvaluate(page, () => window.__islLead)).toBe(1);
    await expect(page.locator('#leadModal')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#leadModal')).toBeHidden({ timeout: 10_000 });

    await page.locator('#nbdIslandPill [data-lk-nav="crm"]').click();
    await page.locator('#view-crm.active').waitFor({ state: 'attached', timeout: 15_000 });
    await expect(page.locator('#nbdIslandPill .isl-active')).toContainText('Pipeline');
    // stage lanes: tabs over a board that snaps
    await page.locator('#nbdIslandLanes .isl-lane').first().waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.locator('#nbdIslandLanes .isl-lane').count()).toBeGreaterThanOrEqual(3);
    expect(await safeEvaluate(page, () => getComputedStyle(document.getElementById('kanbanBoard')).scrollSnapType)).toMatch(/x/);
    await expect(page.locator('#nbdIslandLanes .isl-lane-on')).toHaveCount(1);
    // sort: the real "Hot first" toggle flips and the dock reflects it
    const before = await safeEvaluate(page, () => localStorage.getItem('nbd_crm_sort_engagement'));
    await page.locator('[data-lk-nav="sort"]').click();
    await safeWaitForFunction(page, (b) => localStorage.getItem('nbd_crm_sort_engagement') !== b, before, { timeout: 10_000 });
    await expect(page.locator('[data-lk-nav="sort"]')).toHaveAttribute('aria-pressed', /true|false/);
    await page.locator('[data-lk-nav="sort"]').click();   // put it back
    // filter: the Pipeline's Filters menu opens
    await page.locator('[data-lk-nav="filter"]').click();
    await expect(page.locator('#crmFiltersMenu')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');

    // ── More: the sidebar's own entries; Settings is one tap away ──
    await page.locator('#nbdIslandPill [data-lk-nav="more"]').click();
    await expect(page.locator('#nbdIslandMore')).toBeVisible();
    expect(await page.locator('#nbdIslandMore .isl-more-item').count()).toBeGreaterThan(8);
    await page.locator('#nbdIslandMore .isl-more-item', { hasText: 'Settings' }).first().click();
    await page.locator('#view-settings.active').waitFor({ state: 'attached', timeout: 15_000 });
    await expect(page.locator('#nbdIslandMore')).toBeHidden();
    await expect(page.locator('#nbdIslandPill .isl-more-btn')).toHaveClass(/isl-active/);

    // ── job view: the cover is the hero of the house ──
    await page.goto('/pro/customer.html?id=' + coverId);
    await safeWaitForFunction(page, () => document.documentElement.classList.contains('ij-has-hero'), null, { timeout: 40_000 });
    const hero = await safeEvaluate(page, () => {
      const h = document.getElementById('coverHero');
      const r = h.getBoundingClientRect();
      return { bg: h.style.backgroundImage, display: h.style.display, h: Math.round(r.height), w: Math.round(r.width) };
    });
    expect(hero.display).toBe('block');
    expect(hero.bg).toContain('drone-hero-crew-800');
    expect(hero.h).toBeGreaterThanOrEqual(220);
    await page.goBack();
    await safeWaitForFunction(page, () => !!document.getElementById('nbdIslandPill'), null, { timeout: 40_000 });

    // ── widths x themes x wallpaper ──
    const widths = [[1280, 900], [820, 1180], [390, 844]];
    const themes = [['chalk-line', 'light'], ['tar-paper', 'dark']];
    for (const [w, h] of widths) {
      await page.setViewportSize({ width: w, height: h });
      for (const [theme, mode] of themes) {
        for (const paper of [false, true]) {
          // theme first and let the theme / My Skin engines settle, THEN stamp the
          // wallpaper class: my-skin.js re-derives its classes on a theme change
          await safeEvaluate(page, (a) => {
            document.documentElement.setAttribute('data-theme', a.theme);
            document.documentElement.setAttribute('data-mode', a.mode);
          }, { theme, mode });
          await page.waitForTimeout(500);
          await safeEvaluate(page, (a) => {
            const de = document.documentElement;
            de.classList.toggle('my-skin-wallpaper', a.paper);
            if (a.paper) de.style.setProperty('--myskin-wallpaper', 'linear-gradient(135deg, #7a9, #345)');
            else de.style.removeProperty('--myskin-wallpaper');
          }, { theme, mode, paper });
          await page.locator('#nbdIslandPill').waitFor({ state: 'visible' });
          const tag = `${w}px ${theme} ${paper ? 'wallpaper' : 'no wallpaper'}`;
          const m = await safeEvaluate(page, () => {
            const pill = document.querySelector('#nbdIslandPill .isl-pill-in');
            const dock = document.querySelector('#nbdIslandDock .isl-dock-in');
            const pr = pill.getBoundingClientRect(), dr = dock.getBoundingClientRect();
            const bg = getComputedStyle(pill).backgroundColor;
            // color-mix() serialises as color(srgb r g b / a); rgba(r, g, b, a) for plain colours
            let alpha = 1;
            const slash = /[/]\s*([0-9.]+)\s*[)]$/.exec(bg);
            const comma = /^rgba[(]([^)]+)[)]$/.exec(bg);
            if (slash) alpha = parseFloat(slash[1]);
            else if (comma) alpha = parseFloat(comma[1].split(',')[3]);
            const small = Array.from(document.querySelectorAll('#nbdIslandPill .isl-item, #nbdIslandDock .isl-item'))
              .filter((e) => e.getBoundingClientRect().height < 44).length;
            return {
              pillInView: pr.left >= 0 && pr.right <= window.innerWidth + 1,
              dockInView: dr.left >= 0 && dr.right <= window.innerWidth + 1 && dr.bottom <= window.innerHeight,
              alpha, bg,
              blur: getComputedStyle(pill).backdropFilter || getComputedStyle(pill).webkitBackdropFilter,
              bodyImg: getComputedStyle(document.body).backgroundImage,
              sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
              small,
            };
          });
          expect(m.pillInView, tag).toBe(true);
          expect(m.dockInView, tag).toBe(true);
          expect(m.sidebar, tag).toBe('none');
          expect(m.small, tag + ' tap targets >= 44px').toBe(0);
          expect(m.alpha, tag + ' pill is translucent').toBeLessThan(1);
          expect(m.blur, tag + ' pill blurs').toMatch(/blur/);
          if (paper) expect(m.bodyImg, tag).not.toMatch(/radial-gradient/);
          else expect(m.bodyImg, tag + ' falls back to the --glow2 wash').toMatch(/radial-gradient/);
          expect(await overflowX(page), tag + ' no horizontal page scroll').toBeLessThanOrEqual(1);
        }
      }
    }

    // ── Reduce Motion and prefers-contrast: more ──
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const dur = await safeEvaluate(page, () => getComputedStyle(document.querySelector('#nbdIslandPill .isl-item')).transitionDuration);
    expect(dur).toMatch(/^0s(, 0s)*$/);
    await page.emulateMedia({ reducedMotion: 'no-preference', contrast: 'more' });
    const hc = await safeEvaluate(page, () => {
      const cs = getComputedStyle(document.querySelector('#nbdIslandPill .isl-pill-in'));
      return { f: cs.backdropFilter || cs.webkitBackdropFilter, bg: cs.backgroundColor };
    });
    expect(hc.f).toMatch(/none|^$/);
    expect(hc.bg).not.toMatch(/(,|\/)\s*0?\.\d+\s*\)$/);   // opaque: no fractional alpha
    await page.emulateMedia({ contrast: 'no-preference' });
  });
});
