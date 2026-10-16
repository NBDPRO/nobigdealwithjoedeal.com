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
 *
 * LAYOUT PREBOOT (2026-10-11, layout system D0) lives here too — one blocking
 * tag instead of two, because the dashboard boot budget allows no more.
 * It reads what layout-system.js resolved last time (localStorage
 * `nbd_layout_resolved`, { uid, byDevice:{phone,tablet,desktop}, glove }) and
 * stamps <html data-layout> / data-tap before first paint, so a rep who chose a
 * layout never sees Classic flash first. Classic stays the no-op default: no
 * attribute, no extra stylesheet. The cache is keyed by SURFACE so a phone's
 * layout never paints on a desktop window; layout-system.js re-resolves after
 * settings load and corrects anything stale (one corrected frame, never a
 * stuck state).
 *
 * The layout's stylesheet is written as a parser-inserted <link> (a script-
 * inserted one is not render-blocking and would flash an unstyled layout). It
 * therefore lands BEFORE the base styles, so every layout stylesheet must scope
 * its rules under `html[data-layout="<id>"]`.
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
  try {
    var de = document.documentElement;
    var c = JSON.parse(localStorage.getItem('nbd_layout_resolved') || 'null');
    if (!c || typeof c !== 'object') return;
    var coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) {}
    var w = window.innerWidth || 1024;
    var surface = w <= 768 ? 'phone' : (w <= 1180 && coarse ? 'tablet' : 'desktop');
    if (c.glove === true) de.setAttribute('data-tap', 'glove');
    var id = c.byDevice && c.byDevice[surface];
    // 'pixel' was never a real layout (no stylesheet, no implementation) and is
    // no longer offered (2026-10-15): a cache left from when it was in the
    // picker paints Classic and asks for no missing pixel.css.
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || id === 'classic' || id === 'pixel') return;
    de.setAttribute('data-layout', id);
    // this layout's own button size (layout-system.js densityFor): big = glove, compact = 48px
    var dz = c.density && typeof c.density === 'object' ? c.density[id] : null;
    if (dz === 'big') de.setAttribute('data-tap', 'glove');
    else if (dz === 'compact') de.setAttribute('data-tap', 'compact');
    else if (dz === 'comfortable') de.removeAttribute('data-tap');
    if (document.readyState === 'loading') {
      document.write('<link rel="stylesheet" id="nbd-layout-css" data-layout-css="' + id + '" href="/pro/css/layouts/' + id + '.css">');
    }
  } catch (e) {}
})();
