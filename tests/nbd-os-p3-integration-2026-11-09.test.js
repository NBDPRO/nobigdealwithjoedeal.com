/**
 * tests/nbd-os-p3-integration-2026-11-09.test.js - NBD OS P3, where the six lanes meet.
 *
 * Each P3 lane (Pocket, Knock block, privacy lock, wallpaper palette, Saved view + Copy my
 * setup, Nearby) was built alone on a0beb164b. This suite pins what only shows once they
 * are together:
 *   1. keyboard: Pocket's Alt+`, the lock's Ctrl+Alt+L and the desk's Ctrl+Alt family
 *      (O, 1-4, arrows) never match the same key; each feature has a keyboard path
 *   2. hot corners: the privacy lock never offers or uses the action runner's top-left corner
 *   3. one runtime bundle per name; the os layout's `needs` list is unchanged
 *   4. the Add sheet's Tools group holds Knock block, Saved view and Nearby
 *   5. "In a home": Nearby is never painted or loaded (it names customers); the Saved view
 *      tile and the Knock block show counts only; Pocket's own test pins its half
 *      (tests/nbd-os-pocket-dom-2026-11-09.test.js section 13)
 *   6. the wallpaper palette never reaches NBD, documents or the CRM's own windows
 *   7. the Control Center holds every P3 tile at once
 *
 * Run: node tests/nbd-os-p3-integration-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, text } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 500) : '')); }
}
const J = (v) => JSON.stringify(v);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
async function G(fn) { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const WM = require(path.join(ROOT, 'docs/pro/js/layouts/os-wm-logic.js'));
const PV = require(path.join(ROOT, 'docs/pro/js/os/privacy.js'));
const WL = require(path.join(ROOT, 'docs/pro/js/os/wallpaper-logic.js'));
const OS_JS = read('docs/pro/js/layouts/os.js');
const HOME_JS = read('docs/pro/js/os/home.js');

(async () => {
  console.log('\n1. keyboard: no two P3 shortcuts share a key');
  await G(async () => {
    const body = { tagName: 'BODY' };
    const ev = (code, mods, key) => Object.assign({ code, key: key || '', target: body, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, getModifierState: () => false }, mods || {});
    const desk = (e) => e.ctrlKey && e.altKey && !e.metaKey && (/^Digit[1-4]$/.test(e.code) || (!e.shiftKey && e.code === 'KeyO')
      || (!e.shiftKey && /^Arrow/.test(e.key)));
    const combos = [];
    ['Backquote', 'KeyL', 'KeyO', 'Digit1', 'Digit4', 'KeyK'].forEach((code) => {
      [{}, { altKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true }, { altKey: true, shiftKey: true }, { metaKey: true, altKey: true }]
        .forEach((m) => combos.push(ev(code, m, code === 'KeyL' ? 'l' : code === 'Backquote' ? '`' : '')));
    });
    ['ArrowLeft', 'ArrowUp'].forEach((k) => combos.push(ev(k, { ctrlKey: true, altKey: true }, k)));
    const clash = combos.filter((e) => [WM.pocketKey(e), PV._pure.isLockKey(e, false), desk(e)].filter(Boolean).length > 1);
    ok('no key matches two of Pocket, the lock and the desk keys', clash.length === 0, J(clash.map((e) => e.code)));
    ok('Alt+` is Pocket\'s', WM.pocketKey(ev('Backquote', { altKey: true }, '`')) === true);
    ok('Ctrl+Alt+L is the lock\'s', PV._pure.isLockKey(ev('KeyL', { ctrlKey: true, altKey: true }, 'l'), false) === true);
    ok('Ctrl+Alt+` is neither (Pocket refuses Ctrl)', !WM.pocketKey(ev('Backquote', { ctrlKey: true, altKey: true })) && !PV._pure.isLockKey(ev('Backquote', { ctrlKey: true, altKey: true }), false));
    ok('Alt+L is neither (the lock needs Ctrl too)', !WM.pocketKey(ev('KeyL', { altKey: true }, 'l')) && !PV._pure.isLockKey(ev('KeyL', { altKey: true }, 'l'), false));
    ok('Ctrl+K stays the command palette\'s (neither P3 key takes it)', !WM.pocketKey(ev('KeyK', { ctrlKey: true }, 'k')) && !PV._pure.isLockKey(ev('KeyK', { ctrlKey: true }, 'k'), false));
    ok('the Knock block, Saved view and Nearby are reached by Tab: their actions are <button>s',
      ['focus', 'kpi', 'nearby'].every((id) => /<button type="button"/.test(read('docs/pro/js/os/' + id + '.js'))));
    ok('Pocket and the lock each have a Control Center tile too (a non-keyboard way in)',
      /id: 'os-pocket'/.test(OS_JS) && /id: 'os-privacy'/.test(OS_JS));
    ok('Pocket does not open on the lock screen', /function onPocketKey[\s\S]{0,400}os-locked/.test(OS_JS));
  });

  console.log('\n2. hot corners: privacy and the runner never share one');
  await G(async () => {
    const corners = ['tl', 'tr', 'br', 'bl'].filter((c) => PV._pure.normCorner(c) === c);
    ok('the lock offers top right, bottom right and bottom left only', J(corners) === J(['tr', 'br', 'bl']), J(corners));
    ok('a stored "tl" reads as off', PV._pure.normCorner('tl') === '');
    ok('the top-left pixel never locks, whatever corner is stored', ['tl', 'tr', 'br', 'bl', ''].every((c) => PV._pure.inCorner(c, 0, 0, 1280, 800) === false));
    ok('the runner\'s corner is top left', /top-left corner/.test(read('docs/pro/js/command-runner.js')));
  });

  console.log('\n3. runtime bundles and the layout\'s needs');
  await G(async () => {
    const src = ['docs/pro/js/layouts/os.js', 'docs/pro/js/os/home.js'].map((f) => noComments(read(f))).join('\n');
    const consts = {};
    src.replace(/var ([A-Z_]+) = '([a-z0-9]+)'/g, (m, k, v) => { consts[k] = v; });
    const names = [];
    src.replace(/bundles(?:\.([a-z0-9]+)|\[([A-Z_]+)\]) = /g, (m, a, b) => { names.push(a || consts[b] || b); });
    const dup = names.filter((n, i) => names.indexOf(n) !== i && n !== 'cmdrunner');
    ok('each bundle name is registered once (' + names.length + ')', dup.length === 0, J(names));
    ['ospocket', 'osprivacy', 'oswp', 'ossetup', 'osfocus', 'oskpi', 'osnearby'].forEach((n) => ok('…' + n + ' is registered', names.indexOf(n) !== -1, J(names)));
    const ls = read('docs/pro/js/layout-system.js');
    const needs = /script: 'js\/layouts\/os\.js'[^\n]*\n\s*needs: \{ script: \[([^\]]*)\]/.exec(ls);
    ok('the os layout\'s needs.script list is unchanged (full: P3 adds nothing to it)', needs && J(needs[1].split(',').map((s) => s.trim())) === J(["'js/os/system-logic.js'", "'js/layouts/os-wm-logic.js'", "'js/os/home-logic.js'", "'js/os/coach-logic.js'", "'js/os/home.js'", "'js/layouts/board-logic.js'"]), needs && needs[1]);
    ok('no new <script> tag for a P3 file on the dashboard', !/os\/(pocket|privacy|focus|kpi|nearby|setup|wallpaper-logic)/.test(read('docs/pro/dashboard.html')));
  });

  console.log('\n4. the Add sheet: Tools holds the three P3 widgets');
  await G(async () => {
    const tools = HL.ids().filter((id) => HL.CATALOG[id].cat === 'tools');
    ok('Knock block, Saved view and Nearby are in Tools', ['focus', 'kpi', 'nearby'].every((id) => tools.indexOf(id) !== -1), J(tools));
    ok('their titles', HL.CATALOG.focus.title === 'Knock block' && HL.CATALOG.kpi.title === 'Saved view' && HL.CATALOG.nearby.title === 'Nearby');
    ok('each has its own lazy bundle', HL.CATALOG.focus.bundle === 'osfocus' && HL.CATALOG.kpi.bundle === 'oskpi' && HL.CATALOG.nearby.bundle === 'osnearby');
    ok('a paint reads nothing from Firestore (reads: 0)', ['focus', 'kpi', 'nearby'].every((id) => HL.CATALOG[id].reads === 0));
    ok('home.js paints all three', /focus: knockBlock, kpi: kpi, nearby: nearby/.test(HOME_JS));
  });

  console.log('\n5. "In a home"');
  await G(async () => {
    const P = { privacy: true };
    ok('Nearby is hidden (it names customers)', HL.actHides(P, 'nearby') === true);
    ok('the Saved view tile and the Knock block show (counts, no names, no money)', HL.actHides(P, 'kpi') === false && HL.actHides(P, 'focus') === false
      && !HL.CATALOG.kpi.money && !HL.CATALOG.kpi.names && !HL.CATALOG.focus.money && !HL.CATALOG.focus.names);
    const leads = [{ id: 'L1', firstName: 'Pat', lastName: 'Nearbyname', stage: 'new', lat: 39.1, lng: -84.5, address: '1 Near St' }];
    const home = (on) => ({ v: 1, phone: [{ id: 'nearby', s: 'm' }, { id: 'glance', s: 'm' }],
      acts: [{ id: 'inhome', name: 'In a home', focus: { privacy: true }, phone: [{ id: 'nearby', s: 'm' }, { id: 'glance', s: 'm' }] }], on: on ? { phone: 'inhome' } : {} });
    const mk = (on) => {
      const T = makeWin({ surface: 'phone', leads, uid: 'u1', claims: { role: 'owner', companyId: 'u1' }, home: home(on) });
      T.W.bundleLoads = [];
      T.W.ScriptLoader = { bundles: {}, loadBundle(n) { T.W.bundleLoads.push(n); (this.bundles[n] || []).forEach((src) => { if (/\.css(\?|$)/.test(src)) return; const f = 'docs/pro/' + String(src).replace(/\?.*$/, ''); vm.runInContext(read(f), T.W, { filename: f }); }); return Promise.resolve(); } };
      T.W._impl.mount({ surface: 'phone' });
      return T;
    };
    const T = mk(true);
    await flush();
    const ph = T.document.getElementById('osPhone');
    ok('with the mode on: no Nearby card and no customer name', !/Nearbyname|Near St/.test(text(ph)) && !ph.querySelector('[data-oshw-nb]'), text(ph).slice(0, 300));
    ok('…and the osnearby bundle is never loaded', T.W.bundleLoads.indexOf('osnearby') === -1, J(T.W.bundleLoads));
    const C = mk(false);
    await flush();
    ok('control: with the mode off Nearby loads and paints', C.W.bundleLoads.indexOf('osnearby') !== -1 && /Nearby/.test(text(C.document.getElementById('osPhone'))), J(C.W.bundleLoads));
  });

  console.log('\n6. the wallpaper palette: tenants only, home surfaces only');
  await G(async () => {
    ok('NBD (the platform tenant) never gets a wash', WL.allowed({ nbd: true, known: true, locked: false, on: true }) === false);
    ok('nor an unknown identity, a locked My Skin or a switched-off member', !WL.allowed({ nbd: false, known: false }) && !WL.allowed({ nbd: false, known: true, locked: true }) && !WL.allowed({ nbd: false, known: true, on: false }));
    ok('a known tenant with the switch on may', WL.allowed({ nbd: false, known: true, locked: false, on: true }) === true);
    const css = read('docs/pro/css/layouts/os.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = css.split('}').filter((r) => /--os-pal-s/.test(r) && /--s:/.test(r));
    ok('the --s / --s2 override is only inside [data-os-pal][data-os-wp="img"] on .os-phone or the desk\'s widgets, taskbar and Start',
      rules.length === 1 && /\.os-phone\[data-os-pal\]\[data-os-wp="img"\]/.test(rules[0]) && /\.os-desk\[data-os-pal\]\[data-os-wp="img"\] :is\(\.os-widgets, \.os-taskbar, \.os-start\)/.test(rules[0]) && !/os-wins|html\s*\{|body/.test(rules[0].split('{')[0]), rules.join(' | '));
    const docFiles = ['docs/pro/js/document-generator.js', 'docs/pro/js/document-generator-templates.js', 'functions/render-pdf.js', 'docs/pro/css/nbd-brand.css'];
    ok('no document or customer-facing brand file mentions the palette', docFiles.every((f) => !/os-pal|NBDOSWallpaperLogic|surfaceTint/.test(read(f))));
  });

  console.log('\n7. the Control Center holds every P3 tile');
  await G(async () => {
    const ids = /var CONTROL_IDS = \[([^\]]*)\]/.exec(OS_JS);
    ok('CONTROL_IDS lists Pocket, Privacy lock and Copy my setup with the P2 tiles', ids && ['os-home-edit', 'os-wallpaper', 'os-acts', 'os-runner-type', 'os-pocket', 'os-privacy', 'os-setup'].every((id) => ids[1].indexOf("'" + id + "'") !== -1), ids && ids[1]);
    for (const surface of ['desktop', 'phone']) {
      const T = makeWin({ surface, system: true, loader: true });
      T.W._impl.mount({ surface });
      T.fire && T.fire(2000);
      await flush();
      const got = (T.W.controls || []).map((c) => c.id);
      ok(surface + ': Pocket, Privacy lock and Copy my setup tiles are all registered', ['os-pocket', 'os-privacy', 'os-setup'].every((id) => got.indexOf(id) !== -1), J(got));
    }
  });

  // the one-column desk below 1100px gives each widget a 96px floor; an M whose foot holds a 44px
  // control (Saved view's Change view / Pick a view, the Knock block's End and its lines) keeps the
  // full 160px row, as Nearby and Up Next with Peek do (seen cut in half at 1000px)
  console.log('\n8. the one-column desk (< 1100px): M tiles with a control at the foot keep a 160px row');
  await G(async () => {
    const one = (f) => { const c = read(f).replace(/\/\*[\s\S]*?\*\//g, ''); const m = /@media \(max-width: 1100px\) \{([\s\S]*?)\n\}/.exec(c); return m ? m[1] : ''; };
    ok('Nearby M (its own rule, unchanged)', /\.os-hw-board \.os-hw\.os-hw\.os-hw-nearby\.is-m \{ min-height: 160px; \}/.test(one('docs/pro/css/os/nearby.css')));
    ok('Saved view M', /\.os-hw-board \.os-hw\.os-hw\.os-hw-kpi\.is-m \{ min-height: 160px; \}/.test(one('docs/pro/css/os/kpi.css')), one('docs/pro/css/os/kpi.css'));
    ok('Knock block M', /\.os-hw-board \.os-hw\.os-hw\.os-hw-focus\.is-m \{ min-height: 160px; \}/.test(one('docs/pro/css/os/focus.css')), one('docs/pro/css/os/focus.css'));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
