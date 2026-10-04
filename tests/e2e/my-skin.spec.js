/**
 * tests/e2e/my-skin.spec.js — "My Skin" end to end on the emulators (2026-10-01).
 *
 * A picture made in the page is uploaded through NBDMySkin.upload: it lands
 * at skins/{uid}/wallpaper in the Storage emulator (re-encoded JPEG), the
 * settings doc records it, <html> gets the my-skin classes and the wallpaper
 * layer paints a blob: URL. After a reload the skin comes back from
 * userSettings + getBlob. Turning it off clears every class; Remove deletes
 * the object. Phone width (390px), and the panel's controls are 44px.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

async function makePicture(page, slot, w, h, color) {
  return page.evaluate(async ({ slot, w, h, color }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
    x.fillStyle = '#ffffff'; x.fillRect(w / 4, h / 4, w / 2, h / 2);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], slot + '.png', { type: 'image/png' });
    return window.NBDMySkin.upload(slot, file);
  }, { slot, w, h, color });
}

test.describe.serial('My Skin @shard2', () => {
  test('upload a wallpaper and mascot, survive a reload, turn off, remove', async ({ page }) => {
    test.setTimeout(150_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid && window.NBDMySkin && window.NBDMySkin.state().cfg), null, { timeout: 30_000 });

    // A 3000×2000 picture: re-encoded down to the 2560 long edge as JPEG.
    expect(await makePicture(page, 'wallpaper', 3000, 2000, '#1b5e20')).toBe(true);
    expect(await makePicture(page, 'mascot', 300, 300, '#c62828')).toBe(true);

    const painted = await safeEvaluate(page, () => {
      const h = document.documentElement;
      return {
        classes: Array.from(h.classList).filter((c) => /^my-skin/.test(c)).sort().join(' '),
        layer: getComputedStyle(h, '::before').backgroundImage,
        mascot: !!document.querySelector('#nbdMySkinMascot[aria-hidden="true"]'),
        state: window.NBDMySkin.state(),
      };
    });
    expect(painted.classes).toBe('my-skin my-skin-mascot my-skin-mascot-left my-skin-wallpaper');
    expect(painted.layer).toContain('blob:');
    expect(painted.mascot).toBe(true);
    expect(painted.state.cfg.enabled).toBe(true);
    const uid = painted.state.uid;
    expect(painted.state.cfg.slots.wallpaper.path).toBe('skins/' + uid + '/wallpaper');

    // What reached Storage is the re-encoded JPEG at the capped size.
    const stored = await safeEvaluate(page, async (p) => {
      const st = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js');
      const md = await st.getMetadata(st.ref(window.storage, p));
      const blob = await st.getBlob(st.ref(window.storage, p));
      const bmp = await createImageBitmap(blob);
      return { type: md.contentType, w: bmp.width, h: bmp.height };
    }, 'skins/' + uid + '/wallpaper');
    expect(stored).toEqual({ type: 'image/jpeg', w: 2560, h: 1707 });

    // Reload: the skin comes back from userSettings + getBlob.
    await page.reload();
    await safeWaitForFunction(page, () => document.documentElement.classList.contains('my-skin-wallpaper'), null, { timeout: 30_000 });
    expect(await safeEvaluate(page, () => getComputedStyle(document.documentElement, '::before').backgroundImage)).toContain('blob:');

    // The panel: controls reflect the config and are phone-sized.
    await safeEvaluate(page, () => { window.goTo && window.goTo('settings'); });
    // The settings view mounts from a template: wait for the real tab, click it like a person.
    await page.locator('#stab-appearance').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#stab-appearance').click();
    await page.locator('#myskinPanel').scrollIntoViewIfNeeded();
    await expect(page.locator('#myskinEnabled')).toBeChecked({ timeout: 15_000 });
    await expect(page.locator('#myskinPanel [data-myskin-slot="wallpaper"] .myskin-thumb-img')).toBeVisible();
    await page.screenshot({ path: 'test-results/my-skin-panel.png' });
    const sizes = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#myskinPanel .myskin-btn')).filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().height)));
    expect(sizes.length).toBeGreaterThan(3);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);

    // Off: every class gone, the mascot removed.
    await page.locator('#myskinEnabled').uncheck();
    await safeWaitForFunction(page, () => !Array.from(document.documentElement.classList).some((c) => /^my-skin/.test(c)) && !document.getElementById('nbdMySkinMascot'), null, { timeout: 10_000 });

    // Remove both pictures: the objects are gone from Storage.
    await safeEvaluate(page, async () => { await window.NBDMySkin.remove('wallpaper'); await window.NBDMySkin.remove('mascot'); });
    const gone = await safeEvaluate(page, async (u) => {
      const st = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js');
      try { await st.getBlob(st.ref(window.storage, 'skins/' + u + '/wallpaper')); return false; } catch (e) { return /object-not-found/.test(e.code || ''); }
    }, uid);
    expect(gone).toBe(true);
    expect(await safeEvaluate(page, () => Object.keys(window.NBDMySkin.state().cfg.slots).length)).toBe(0);
  });
});
