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
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || id === 'classic') return;
    de.setAttribute('data-layout', id);
    if (document.readyState === 'loading') {
      document.write('<link rel="stylesheet" id="nbd-layout-css" data-layout-css="' + id + '" href="/pro/css/layouts/' + id + '.css">');
    }
  } catch (e) {}
})();
