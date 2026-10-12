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

// Start from no skin: an attempt that failed mid-way leaves its settings and
// pictures behind, and the retry would begin from them instead of from zero.
async function clearSkin(email) {
  const { initializeApp, getApps } = require('firebase-admin/app');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro', storageBucket: 'nobigdeal-pro.firebasestorage.app' });
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  const uid = (await require('firebase-admin/auth').getAuth().getUserByEmail(email)).uid;
  await getFirestore().doc('userSettings/' + uid).set({ mySkin: FieldValue.delete() }, { merge: true });
  const bucket = require('firebase-admin/storage').getStorage().bucket('nobigdeal-pro.firebasestorage.app');
  for (const slot of ['wallpaper', 'texture', 'mascot']) await bucket.file('skins/' + uid + '/' + slot).delete().catch(() => {});
  await bucket.deleteFiles({ prefix: 'skins/' + uid + '/themes/' }).catch(() => {});
}

test.describe.serial('My Skin @shard2', () => {
  test('upload a wallpaper and mascot, survive a reload, turn off, remove', async ({ page }) => {
    test.setTimeout(150_000);
    const creds = requireTestUser();
    await clearSkin(creds.email);
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

  // Per-theme backgrounds (2026-10): a picture for one theme, painted on the
  // two-layer painter, swapped on a theme change, restored after a reload,
  // and its object gone after Clear. Real rules, real SDK, real encode.
  test('a picture per theme: upload, switch themes, reload, clear', async ({ page }) => {
    test.setTimeout(150_000);
    const creds = requireTestUser();
    await clearSkin(creds.email);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions.net|.run.app/, (route) => route.abort());
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window._user.uid && window.NBDMySkin && window.NBDMySkin.state().cfg && window.ThemeEngine), null, { timeout: 30_000 });

    // Per-theme on (the panel switch), then a picture for the current theme.
    await safeEvaluate(page, () => { window.goTo && window.goTo('settings'); });
    await page.locator('#stab-appearance').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#stab-appearance').click();
    await page.locator('#myskinPerTheme').check();
    await expect(page.locator('#myskinThemeCard')).toBeVisible({ timeout: 15_000 });
    await safeEvaluate(page, () => window.ThemeEngine.apply('pokemon', true));
    const up = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
      const x = c.getContext('2d'); x.fillStyle = '#8e24aa'; x.fillRect(0, 0, 3000, 2000);
      x.fillStyle = '#ffffff'; x.fillRect(750, 500, 1500, 1000);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return window.NBDMySkin.uploadTheme('pokemon', new File([blob], 'pic.png', { type: 'image/png' }));
    });
    expect(up).toBe(true);

    const s = await safeEvaluate(page, () => {
      const st = window.NBDMySkin.state();
      const h = document.documentElement;
      return {
        uid: st.uid, theme: st.theme, shown: st.shown, perTheme: st.cfg.perTheme,
        entry: st.cfg.themes.pokemon, classes: Array.from(h.classList).filter((c) => /^my-skin/.test(c)).sort().join(' '),
        layers: ['nbdSkinA', 'nbdSkinB'].map((id) => { const e = document.getElementById(id); return e ? e.style.getPropertyValue('--myskin-wallpaper') : null; }),
      };
    });
    expect(s.perTheme).toBe(true);
    expect(s.shown.source).toBe('theme');
    expect(s.classes).toContain('my-skin-layers');
    expect(s.layers.some((v) => v && v.indexOf('blob:') !== -1)).toBe(true);
    expect(s.entry.images.length).toBe(1);
    const img = s.entry.images[0];
    expect(img.path).toBe('skins/' + s.uid + '/themes/pokemon/' + img.id);
    expect(img.w).toBe(2560);

    // What reached Storage: lossy, capped, under the rule's 3 MB.
    const stored = await safeEvaluate(page, async (p) => {
      const st = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js');
      const md = await st.getMetadata(st.ref(window.storage, p));
      const bmp = await createImageBitmap(await st.getBlob(st.ref(window.storage, p)));
      return { type: md.contentType, size: md.size, w: bmp.width, h: bmp.height };
    }, img.path);
    expect(['image/webp', 'image/jpeg']).toContain(stored.type);
    expect(stored.w).toBe(2560);
    expect(stored.size).toBeLessThan(3 * 1024 * 1024);

    // A theme with nothing of its own and no wallpaper: nothing personal.
    await safeEvaluate(page, () => window.ThemeEngine.apply('nbd-original', false));
    await safeWaitForFunction(page, () => !window.NBDMySkin.state().shown, null, { timeout: 10_000 });
    expect(await safeEvaluate(page, () => document.documentElement.classList.contains('my-skin-layers'))).toBe(false);
    await safeEvaluate(page, () => window.ThemeEngine.apply('pokemon', true));
    await safeWaitForFunction(page, () => { const s = window.NBDMySkin.state().shown; return !!s && s.source === 'theme'; }, null, { timeout: 10_000 });

    // Reload: the entry comes back from userSettings and the picture from storage / cache.
    await page.reload();
    await safeWaitForFunction(page, () => { const s = window.NBDMySkin && window.NBDMySkin.state().shown; return !!s && s.source === 'theme'; }, null, { timeout: 30_000 });
    expect(await safeEvaluate(page, () => document.documentElement.classList.contains('my-skin-layers'))).toBe(true);

    // Clear: entry and object are gone.
    await safeEvaluate(page, async () => { await window.NBDMySkin.clearTheme('pokemon'); });
    expect(await safeEvaluate(page, () => !!window.NBDMySkin.state().cfg.themes.pokemon)).toBe(false);
    const gone = await safeEvaluate(page, async (p) => {
      const st = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js');
      try { await st.getBlob(st.ref(window.storage, p)); return false; } catch (e) { return /object-not-found/.test(e.code || ''); }
    }, img.path);
    expect(gone).toBe(true);
  });
});
