/**
 * tests/dead-controls-tail.test.js — controls that closed, did nothing, and
 * said nothing.
 *
 * Six defects from the silent-failure sweep, sharing one theme: a control whose
 * dependency lives on a DIFFERENT page or inside a lazy bundle nobody asked
 * for. In every case the guard that was supposed to make this safe
 * (`typeof x === 'function'`, `if (!engine) bail`) converted a crash into
 * silence, which is strictly harder to notice.
 *
 *  15/16 command-palette — window.openCardDetail has never existed repo-wide
 *        (the real global is openCardDetailModal), and window.goTo /
 *        openNewLeadModal / _signOut are dashboard globals while the palette
 *        also loads on customer.html. Cmd+K → type a name → Enter did nothing.
 *  17    customer-dnd-upload — photo-engine.js has no static <script> tag
 *        anywhere; it ships only in the lazy 'photos' bundle, which nothing on
 *        customer.html (this module's only surface) requests. Every dropped
 *        image failed with "refresh and try again", and refreshing never helped.
 *  18    supplement-ui — window.NBD_XACT_CATALOG ships only in the lazy
 *        'estimates' bundle, likewise never requested on customer.html, so the
 *        catalog search returned "Catalog not loaded." forever.
 *  19    maps-routing — "📂 Load from Customer" called redrawAll(), which exists
 *        nowhere, and clearAll(), likewise. The drawing loaded into memory and
 *        nothing was painted; the previous drawing's layers stayed on the map.
 *  20    nbd-comms — the stage-email toast built HTML for a renderer that uses
 *        textContent, so the rep saw the raw <button> markup as text.
 *
 * Zero deps.  Run: node tests/dead-controls-tail.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');
const read = (p) => fs.readFileSync(path.join(PRO_JS, p), 'utf8');
const decomment = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('DEAD CONTROLS — palette globals, lazy bundles, maps redraw, toast markup');

// ── 15/16. Command palette ────────────────────────────────────────────
{
  const cp = decomment(read('command-palette.js'));

  ok('the palette no longer calls the never-existent window.openCardDetail',
    !/window\.openCardDetail\b(?!Modal)/.test(cp),
    'openCardDetailModal is the real global (dashboard-widgets.js)');
  ok('it targets openCardDetailModal', /window\.openCardDetailModal/.test(cp));
  ok('and still lands somewhere real when neither global exists',
    /location\.href = '\/pro\/customer\.html\?id=' \+ encodeURIComponent\(lead\.id\)/.test(cp),
    'the palette also loads on customer.html, where no card-detail global is defined');

  ok('_goTo falls back to a real navigation off-dashboard',
    /location\.href = '\/pro\/dashboard\.html#'/.test(cp),
    'window.goTo is a dashboard SPA router; all 19 Navigation rows were inert elsewhere');
  ok('Sign Out cannot silently no-op',
    /firebase-auth\.js'\)\s*\n?\s*\.then\(\(m\) => m\.signOut\(window\.auth\)\)/.test(cp)
    || /m\.signOut\(window\.auth\)/.test(cp),
    'sign-out is the one action a rep must never be left stuck on');
  // A redirect to /pro/login.html would NOT sign the user out — that page has
  // no sign-out handling — so the fallback has to actually call signOut.
  ok('the sign-out fallback really signs out (not just a redirect)',
    /signOut\(window\.auth\)/.test(cp));

  // The confusing name is present elsewhere too; note it rather than silently
  // fixing only the copy we happened to touch.
  const bis = read('buying-intent-strike.js');
  ok('buying-intent-strike still has a real destination despite the same wrong name',
    /window\.openCardDetail\b/.test(bis) === false || /customer\.html\?id=/.test(bis),
    'it carries the same wrong global but does fall back to a real page');
}

// ── 17/18. Lazy bundles requested instead of bailed on ────────────────
{
  const dnd = decomment(read('customer-dnd-upload.js'));
  ok('drag-drop upload loads the photos bundle before giving up',
    /loadBundle\('photos'\)/.test(dnd),
    'the bail was unconditional — photo-engine.js has no static script tag anywhere');
  ok('drag-drop upload rejects the lazy placeholder too',
    /__nbdLazyPhotosStub/.test(dnd),
    'the stub satisfies a truthiness check while meaning "not loaded"');

  const sup = decomment(read('supplement-ui.js'));
  ok('catalog search loads the estimates bundle before giving up',
    /loadBundle\('estimates'\)/.test(sup));
  ok('catalog search tells the user it is loading rather than lying about failure',
    /Loading catalog…/.test(sup));
  ok('the "Catalog not loaded." bail survives as a genuine last resort',
    /Catalog not loaded\./.test(sup));
}

// ── 19. Maps "Load from Customer" paints what it loads ────────────────
{
  const mr = decomment(read('maps-routing.js'));
  ok('no call to the non-existent redrawAll()', !/redrawAll\(\)/.test(mr));
  ok('no call to the non-existent clearAll()', !/\bclearAll\(\)/.test(mr));
  // 2026-09-25 (draw lane L2): Load, the autosave restore and Undo/Redo share
  // ONE restore path, _applyPayload(), which paints through the same line and
  // facet factories live drawing uses. The pins follow the paint, not the old
  // inline loop.
  // Bounded to the load function's own body (the next `function ` ends it):
  // an unbounded lazy match found tryRestoreDrawing's call further down and
  // stayed green with Load's call deleted (break-tested).
  const loadFn = (() => {
    const a = mr.indexOf('async function loadDrawingFromCustomer');
    const b = a >= 0 ? mr.indexOf('function ', a + 40) : -1;
    return a >= 0 ? mr.slice(a, b > a ? b : undefined) : '';
  })();
  ok('Load goes through the one restore path', /_applyPayload\(data/.test(loadFn));
  ok('rehydrated lines are added to the map',
    /function _addLine\([\s\S]{0,600}L\.polyline\(\[rec\.p1, rec\.p2\][\s\S]{0,120}\.addTo\(drawMap\)/.test(mr)
      && /function _applyPayload\([\s\S]*?_addLine\(\{/.test(mr),
    'the loop used to push plain objects with no Leaflet layers');
  ok('rehydrated facets are added to the map',
    /function _addFacet\([\s\S]*?f\.polygon = L\.polygon\(f\.points[\s\S]{0,140}\.addTo\(drawMap\)/.test(mr)
      && /function _applyPayload\([\s\S]*?_addFacet\(\{/.test(mr));
  ok('the sidebars are repainted after a load',
    /renderLineList\(\);/.test(mr) && /renderFacetList\(\);/.test(mr));
  ok('the previous drawing is actually removed from the map',
    /drawMap\.removeLayer\(l\.line\)/.test(mr),
    'the old fallback reset the arrays only, leaving the old layers painted');
  // clearDraw() prompts; the load path has already asked. Double-prompting is
  // its own defect, so the teardown must be inline rather than a clearDraw call.
  ok('the load path does not double-prompt via clearDraw()',
    !/clearDraw\(\)/.test(mr.slice(mr.indexOf('Replace the current drawing'), mr.indexOf('Replace the current drawing') + 2000)));
}

// ── 20. Stage-email toast is plain text ───────────────────────────────
{
  const nc = decomment(read('nbd-comms.js'));
  ok('the stage-email toast no longer builds <button> markup',
    !/data-nc-action="sendStageNow"[\s\S]{0,80}<\/button>/.test(nc),
    'showToast renders with textContent — markup arrives as literal characters');
  ok('the toast message is plain text', /Stage email ready for \$\{name\}/.test(nc));
  ok('the customer name is NOT escaped into a text sink',
    !/escHtml\(name\)/.test(nc),
    'escHtml through textContent renders "Bob & Sons" as "Bob &amp; Sons"');

  // The renderer contract this depends on.
  const ui = read('ui.js');
  ok('showToast still renders with textContent (the reason for all of the above)',
    /_msgEl\.textContent = /.test(ui));
}

// ── Audit 2026-08-02: dead toast sinks + camera-fallback silent drop ──
// Same class as above: window._showToast was assigned NOWHERE (every
// job-templates / product-library toast was console-only), #product-toast
// exists on no page, and photo-engine's camera fallback routed picked files
// to window.handlePhotoFiles (defined nowhere) with a handleFileSelect
// backup that only exists on customer.html — while the bundle loads on the
// dashboard. Files silently vanished.
{
  const jt = decomment(read('job-templates-ui.js'));
  const pl = decomment(read('product-library.js'));
  const pe = decomment(read('photo-engine.js'));

  ok('job-templates-ui toasts through window.showToast (the real dashboard global)',
    !/window\._showToast/.test(jt) && /window\.showToast\(msg, type\)/.test(jt));
  ok('product-library toasts through window.showToast; dead #product-toast DOM fallback gone',
    !/window\._showToast/.test(pl) && !/product-toast/.test(pl)
    && /window\.showToast\(msg, type\)/.test(pl));
  ok('the phantom handlePhotoFiles branch is gone from photo-engine',
    !/handlePhotoFiles/.test(pe) && !/handleFileSelect\(\{ target: \{ files \} \}\)/.test(pe));
  // 2026-11-14 (wave-1 field #2): picked files now ride the durable queue
  // (_saveFallbackFiles → _saveBurstShot) instead of a direct upload that lost
  // them offline; behaviour in tests/photo-queue-unblock-2026-11-14.test.js.
  ok('camera fallback saves picked files through the queue and always reports',
    /fallback\.onchange = \(e\) => _saveFallbackFiles\(/.test(pe)
    && /_saveBurstShot\(file, leadId, null\)/.test(pe)
    && /Could not save the selected photos/.test(pe));
  // The real toast global this all rides on must stay early on dashboard.
  const boot = read('dashboard-ui-prefs-boot.js');
  ok('dashboard-ui-prefs-boot still defines window.showToast (load-bearing for lazy bundles)',
    /window\.showToast = function/.test(boot));
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
