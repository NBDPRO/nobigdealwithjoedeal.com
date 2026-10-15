/**
 * tests/e2e/bento-board.spec.js — L01 Bento Board end to end on the emulators
 * (2026-10-12, D5 of the style integration).
 *
 * A signed-in rep who picked the Bento Board sees Home as tiles: money tiles
 * are labelled honestly (revenue = collected, pipeline = projected), the
 * classic widget grid steps aside (no duplicate widget ids), and the board is
 * rearranged with the per-tile buttons, the arrow keys (Shift resizes) or a
 * pointer drag. The board is saved on userSettings/{uid}.layout.layoutState.bento
 * and survives a reload; an owner can save it as the company default, which is
 * what "Reset my board" (and a new hire) falls back to. At iPhone width the
 * grid is two columns in reading order with no sideways scroll. Light + dark
 * theme and Reduce Motion are exercised. Nothing is sent to anyone.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

function adb() {
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  return getFirestore();
}

const cellState = (page, id) => safeEvaluate(page, (i) => {
  const c = document.querySelector('#nbdBentoRoot [data-bn-id="' + i + '"]');
  if (!c) return null;
  const m = (re) => { const x = c.className.match(re); return x ? Number(x[1]) : 0; };
  return { x: m(/bn-c(\d+)/) - 1, y: m(/bn-r(\d+)/) - 1, w: m(/bn-w(\d+)/), h: m(/bn-h(\d+)/) };
}, id);

async function useTheme(page, key) {
  await safeEvaluate(page, (k) => {
    if (window.ThemeEngine && typeof window.ThemeEngine.apply === 'function') window.ThemeEngine.apply(k, false);
    else document.documentElement.setAttribute('data-theme', k);
  }, key);
  await page.waitForTimeout(150);
}

// "rgb(...)" or "color(srgb r g b)" -> [r,g,b] 0..255 (null when it cannot be read)
function contrastProbe() {
  const parse = (s) => {
    let m = s.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return p.slice(0, 3); }
    m = s.match(/color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[ \/]+/).filter(Boolean).map(Number); return p.slice(0, 3).map((v) => v * 255); }
    return null;
  };
  const lum = (c) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  const el = document.querySelector('#nbdBentoRoot .lk-w-title');
  const w = el && el.closest('.lk-widget');
  if (!el || !w) return null;
  const fg = parse(getComputedStyle(el).color), bg = parse(getComputedStyle(w).backgroundColor);
  if (!fg || !bg) return null;
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test.describe.serial('Bento Board @shard2', () => {
  test('tiles -> edit (buttons, keys, drag) -> save -> company default -> phone -> themes', async ({ page }) => {
    test.setTimeout(300_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app|api\.weather\.gov/, (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });
    const uid = await safeEvaluate(page, () => window._user.uid);

    // a customer with a hail stamp so the native tile has something to say
    const s = Date.now();
    const leadId = await safeEvaluate(page, (st) => window._saveLead({
      firstName: 'ZZBN', lastName: 'Hail' + st, address: '9 Bento Way, Mason, OH 45040', phone: '5135550188', stage: 'new', lat: 39.3, lng: -84.3,
    }), s);
    expect(leadId).toBeTruthy();
    await adb().doc('leads/' + leadId).update({ hailHit: { sizeInches: 1.75, date: '2026-10-01' } });

    // start clean: no saved board, no company default (the spec owns its state)
    await safeEvaluate(page, async () => {
      await window.LayoutEngine.saveUser({ id: 'bento', device: 'desktop', layoutState: { bento: null } });
    });
    await adb().doc('companies/' + uid + '/settings/layout').delete().catch(() => {});

    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'bento' && !!document.querySelector('#nbdBentoRoot .bn-cell'), null, { timeout: 40_000 });

    // ── tiles + honest labels ──────────────────────────────────────────
    await expect(page.locator('#nbdBentoRoot [data-widget="revenue"] .lk-w-title')).toHaveText('Revenue · collected');
    await expect(page.locator('#nbdBentoRoot [data-widget="pipeline"] .lk-w-title')).toHaveText('Pipeline · projected');
    await expect(page.locator('#nbdBentoRoot [data-widget="hail"] .bn-chip').first()).toContainText('1.8"', { timeout: 30_000 });
    // the wrapped revenue widget's own sub-line says collected, and ids are not doubled
    await expect(page.locator('#nbdBentoRoot #wb-revenue-month')).toContainText(/collected/i, { timeout: 30_000 });
    const dupes = await safeEvaluate(page, () => ['wb-revenue-month', 'wb-win-rate', 'wb-pipeline-value'].map((i) => document.querySelectorAll('#' + i).length));
    expect(dupes).toEqual([1, 1, 1]);
    // the Today list moved into its tile (adopted, not copied)
    expect(await safeEvaluate(page, () => !!document.querySelector('#nbdBentoRoot [data-bn-id="today"] #todayPlan'))).toBe(true);
    // the classic grid + header customise button step aside
    expect(await safeEvaluate(page, () => document.querySelectorAll('#widgetGrid .w-card').length)).toBe(0);
    // desktop: four columns
    const cols = await safeEvaluate(page, () => getComputedStyle(document.querySelector('#nbdBentoRoot .bn-grid')).gridTemplateColumns.split(' ').length);
    expect(cols).toBe(4);

    // ── edit with the per-tile buttons ─────────────────────────────────
    await page.locator('[data-bn-top="edit"]').click();
    await expect(page.locator('#nbdBentoRoot.bn-editing')).toHaveCount(1);
    const before = await cellState(page, 'closerate');
    expect(before).toEqual({ x: 3, y: 0, w: 1, h: 1 });
    await page.locator('[data-bn-id="closerate"] [data-bn-act="left"]').click();      // swaps into revenue's column? left of x=3 is x=2 (revenue) -> pushes revenue down
    const afterLeft = await cellState(page, 'closerate');
    expect(afterLeft.x).toBe(2);
    // the right edge is a real limit: the button is disabled, not a no-op
    await page.locator('[data-bn-id="closerate"] [data-bn-act="right"]').click();
    await expect(page.locator('[data-bn-id="closerate"] [data-bn-act="right"]')).toBeDisabled();

    // ── keyboard: arrows move, Shift+arrows resize ─────────────────────
    await page.locator('[data-bn-id="hail"]').focus();
    const h0 = await cellState(page, 'hail');
    await page.keyboard.press('Shift+ArrowRight');
    const h1 = await cellState(page, 'hail');
    expect(h1.w).toBe(h0.w + 1);
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await cellState(page, 'hail')).w).toBe(h0.w);
    await expect(page.locator('#nbdBentoRoot .bn-live')).toContainText('Hail near customers');
    // 56px is for the Field App; edit buttons here are >= 40px
    const small = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdBentoRoot .bn-tbtn, #nbdBentoRoot .bn-btn'))
      .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 39).map((e) => e.className));
    expect(small).toEqual([]);

    // ── pointer drag (desktop) ─────────────────────────────────────────
    // the first-run setup card sits above Home's scroller and can cover tiles; this spec is about the board
    await safeEvaluate(page, () => { const st = document.createElement('style'); st.textContent = '.sc-card{display:none !important}'; document.head.appendChild(st); });
    await page.locator('[data-bn-id="tasks"]').scrollIntoViewIfNeeded();
    const grid = await page.locator('#nbdBentoRoot .bn-grid').boundingBox();
    const tasks = await page.locator('[data-bn-id="tasks"]').boundingBox();
    const t0 = await cellState(page, 'tasks');
    await page.mouse.move(tasks.x + tasks.width / 2, tasks.y + 8);
    await page.mouse.down();
    await page.mouse.move(grid.x + 20, tasks.y + 8, { steps: 8 });   // to column 0
    await page.mouse.up();
    const t1 = await cellState(page, 'tasks');
    if (t1.x !== 0) console.log('DRAGDEBUG', JSON.stringify({ t0, t1, grid, tasks, dragging: await safeEvaluate(page, () => document.querySelectorAll('.bn-dragging').length), at: await safeEvaluate(page, () => { const e = document.elementFromPoint(window.innerWidth / 2, 300); return e && e.className; }) }));
    expect(t1.x).toBe(0);
    expect(t1.x).not.toBe(t0.x);

    // ── add from the drawer, remove ────────────────────────────────────
    await page.locator('[data-bn-top="add"]').click();
    await expect(page.locator('#bnDrawer')).toBeVisible();
    await page.locator('[data-bn-add="estimates"]').click();
    await expect(page.locator('[data-bn-id="estimates"]')).toHaveCount(1);
    await page.locator('[data-bn-id="estimates"] [data-bn-act="remove"]').click();
    await expect(page.locator('[data-bn-id="estimates"]')).toHaveCount(0);
    await page.locator('[data-bn-top="done"]').click();
    await expect(page.locator('#nbdBentoRoot.bn-editing')).toHaveCount(0);

    // ── saved on userSettings and survives a reload ────────────────────
    await safeWaitForFunction(page, () => {
      const p = window.LayoutEngine.prefs().user.layoutState;
      return !!(p && Array.isArray(p.bento) && p.bento.length > 0);
    }, null, { timeout: 15_000 });
    const mine = await safeEvaluate(page, async (u) => {
      const snap = await window.getDoc(window.doc(window.db, 'userSettings', u));
      return ((snap.data() || {}).layout || {}).layoutState || null;
    }, uid);
    expect(mine && Array.isArray(mine.bento)).toBe(true);
    const ids = mine.bento.map((x) => x.widgetId);
    expect(ids).toContain('closerate');
    expect(ids).not.toContain('estimates');
    const closeSaved = mine.bento.find((x) => x.widgetId === 'closerate');
    await page.reload();
    await safeWaitForFunction(page, () => !!document.querySelector('#nbdBentoRoot .bn-cell'), null, { timeout: 40_000 });
    const closeAfter = await cellState(page, 'closerate');
    expect(closeAfter).toEqual({ x: closeSaved.x, y: closeSaved.y, w: closeSaved.w, h: closeSaved.h });

    // ── company default: owner saves it; reset falls back to it ────────
    await page.locator('[data-bn-top="edit"]').click();
    await page.locator('[data-bn-id="storm"] [data-bn-act="remove"]').click();
    await page.locator('[data-bn-top="company-save"]').click();
    await safeWaitForFunction(page, async () => {
      const k = window._user.uid;
      const snap = await window.getDoc(window.doc(window.db, 'companies', k, 'settings', 'layout'));
      const d = snap.exists() ? snap.data() : null;
      return !!(d && d.defaultWidgets && Array.isArray(d.defaultWidgets.bento) && d.defaultWidgets.bento.length > 0);
    }, null, { timeout: 20_000 });
    const company = await adb().doc('companies/' + uid + '/settings/layout').get();
    const cd = company.data();
    expect(cd.defaultWidgets.bento.map((x) => x.widgetId)).not.toContain('storm');
    expect(cd.defaultLayout || null).toBe(null);     // saving the board does not pick the layout for the team
    // the picker's own saves must not wipe it (saveCompany carries defaultWidgets forward)
    await safeEvaluate(page, () => window.LayoutEngine.saveCompany({ locked: false }));
    const again = await adb().doc('companies/' + uid + '/settings/layout').get();
    expect(again.data().defaultWidgets.bento.length).toBe(cd.defaultWidgets.bento.length);
    // my own board changes after that; Reset my board returns to the company default
    await page.locator('[data-bn-id="map"] [data-bn-act="remove"]').click();
    // Reset asks first (2026-10-15); a browser tab has no nbdConfirm, so it is the native confirm
    page.once('dialog', (d) => d.accept());
    await page.locator('[data-bn-top="reset"]').click();
    await expect(page.locator('[data-bn-id="map"]')).toHaveCount(1);
    await expect(page.locator('[data-bn-id="storm"]')).toHaveCount(0);
    // a "new hire": no saved board of their own -> the company default
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ layoutState: { bento: null } }));
    await page.reload();
    await safeWaitForFunction(page, () => !!document.querySelector('#nbdBentoRoot .bn-cell'), null, { timeout: 40_000 });
    await expect(page.locator('[data-bn-id="storm"]')).toHaveCount(0);
    await expect(page.locator('[data-bn-id="revenue"]')).toHaveCount(1);

    // ── themes (one dark, one light) + Reduce Motion ───────────────────
    for (const theme of ['nbd-original', 'paper']) {
      await useTheme(page, theme);
      const ratio = await safeEvaluate(page, contrastProbe);
      expect(ratio, theme + ' tile title contrast').toBeGreaterThan(3);
      await page.screenshot({ path: test.info().outputPath('bento-' + theme + '-desktop.png') });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const dur = await safeEvaluate(page, () => {
      const c = document.querySelector('#nbdBentoRoot .bn-cell');
      c.classList.add('bn-dragging');
      const d = getComputedStyle(c).transitionDuration;
      c.classList.remove('bn-dragging');
      return d;
    });
    expect(dur.split(',').every((x) => x.trim() === '0s')).toBe(true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // ── iPhone width: two columns, reading order, no sideways scroll ───
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: 'bento', device: 'phone' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await safeWaitForFunction(page, () => !!document.querySelector('#nbdBentoRoot .bn-cell'), null, { timeout: 40_000 });
    const phone = await safeEvaluate(page, () => ({
      cols: getComputedStyle(document.querySelector('#nbdBentoRoot .bn-grid')).gridTemplateColumns.split(' ').length,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      layout: document.documentElement.getAttribute('data-layout'),
    }));
    expect(phone.layout).toBe('bento');
    expect(phone.cols).toBe(2);
    expect(phone.overflow).toBeLessThanOrEqual(1);
    for (const theme of ['nbd-original', 'paper']) {
      await useTheme(page, theme);
      await page.screenshot({ path: test.info().outputPath('bento-' + theme + '-phone.png') });
    }
    // edit on the phone: earlier / later (left+right are hidden)
    await page.locator('[data-bn-top="edit"]').click();
    const order = () => safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdBentoRoot .bn-cell')).map((c) => c.getAttribute('data-bn-id')));
    const o0 = await order();
    expect(await safeEvaluate(page, () => getComputedStyle(document.querySelector('#nbdBentoRoot .bn-t-left')).display)).toBe('none');
    await page.locator('[data-bn-id="' + o0[0] + '"] [data-bn-act="down"]').click();
    const o1 = await order();
    expect(o1[1]).toBe(o0[0]);
    const overflow2 = await safeEvaluate(page, () => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow2).toBeLessThanOrEqual(1);
    await page.locator('[data-bn-top="done"]').click();

    // leave the account the way the other specs expect it: Classic, no board
    await safeEvaluate(page, () => window.LayoutEngine.saveUser({ id: null, device: 'desktop', layoutState: { bento: null } }).then(() => window.LayoutEngine.saveUser({ id: null, device: 'phone' })));
    await adb().doc('companies/' + uid + '/settings/layout').delete().catch(() => {});
  });
});
