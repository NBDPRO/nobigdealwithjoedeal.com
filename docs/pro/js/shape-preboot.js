/**
 * NBD Pro — Shape & Depth Preboot
 *
 * Reads the user's Shape & Depth preference (Settings > Appearance) from
 * localStorage and stamps <html data-shape="..."> before the page paints,
 * so dashboard-app.css rules keyed on [data-shape="..."] apply on the
 * first frame instead of flashing "sharp" and then switching.
 *
 * Must load synchronously in <head> BEFORE css/dashboard-app.css, the
 * same way theme-mode-preboot.js already does for light/dark mode.
 * "sharp" is the true no-op default — an absent attribute already
 * renders identically, so this only sets one when a non-default
 * preference was actually saved.
 */
(function () {
  try {
    var shape = localStorage.getItem('nbd_shape_style');
    if (shape && shape !== 'sharp') {
      document.documentElement.setAttribute('data-shape', shape);
    }
    // Surface style (Comfort: Solid / Tinted / Glass, 2026-10-11). Same
    // pre-paint rule as density: stamp it before CSS so a Glass user never
    // sees one solid frame. 'solid' is the absent-attribute no-op. The
    // readability guard (--glass-frost-eff) is recomputed once the theme
    // engine is up; until then the raw frost value is used.
    var surf = localStorage.getItem('nbd_surface_style');
    if (surf === 'tinted' || surf === 'glass') {
      document.documentElement.setAttribute('data-surface', surf);
      var sb = parseInt(localStorage.getItem('nbd_surface_blur'), 10);
      var sf = parseInt(localStorage.getItem('nbd_surface_frost'), 10);
      if (sb >= 0 && sb <= 30) document.documentElement.style.setProperty('--glass-blur', sb + 'px');
      if (sf >= 40 && sf <= 95) document.documentElement.style.setProperty('--glass-frost', sf + '%');
    }
  } catch (e) {}
})();
