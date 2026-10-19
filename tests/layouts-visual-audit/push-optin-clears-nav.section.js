/* Global chrome: the opt-in card anchored itself above #mobile-nav only. Field's own bottom bar
 * (#nbdFieldNav) and Island's dock sat under it, so the tabs were unreachable until the card was
 * dismissed (the comment in push-registration.js already records the same bug for #mobile-nav). */
'use strict';
module.exports = {
  name: 'Global chrome: the push opt-in card clears Field\'s tab bar and Island\'s dock',
  async run({ open, useLayout, ok }) {
    // the module is inert without a VAPID key: give the sample page one so the card can show
    const init = () => { Object.defineProperty(window, '__NBD_VAPID_KEY', { get: () => 'audit-test-key', set: () => {}, configurable: true });
      // CI's headless Chromium reports 'denied' (no card); a real phone before the first ask reports 'default'
      try { Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }); } catch (_) {}
    };
    for (const [layout, nav] of [['field', '#nbdFieldNav'], ['island', '.isl-dock-in']]) {
      const P = await open({ w: 390, h: 844, touch: true, scheme: 'dark', init });
      await useLayout(P.page, layout);
      await P.page.waitForSelector('#nbd-push-optin', { timeout: 20000 }).catch(() => {});
      const r = await P.page.evaluate((nav) => {
        const c = document.getElementById('nbd-push-optin'); const n = document.querySelector(nav);
        if (!c || !n) return { card: !!c, nav: !!n };
        const a = c.getBoundingClientRect(), b = n.getBoundingClientRect();
        return { card: true, nav: true, overlap: a.bottom > b.top + 1 && a.top < b.bottom - 1 && a.right > b.left && a.left < b.right };
      }, nav);
      ok(layout + ': the opt-in card shows (so the check is not vacuous)', r.card === true && r.nav === true, JSON.stringify(r));
      ok(layout + ': the card does not sit on ' + nav, r.overlap === false, JSON.stringify(r));
      await P.ctx.close();
    }
  },
};
