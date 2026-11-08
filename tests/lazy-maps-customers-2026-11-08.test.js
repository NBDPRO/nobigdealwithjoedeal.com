/**
 * tests/lazy-maps-customers-2026-11-08.test.js — the Customers map layer
 * (docs/pro/js/maps-customers.js) loads with the Maps view, not on every
 * dashboard boot (boot-weight lane, 2026-11-08).
 *
 * Before: an eager <script defer> on every boot (about 25 KB shipped) for a
 * layer that only the Maps view's Customers toggle and zone tools read. After:
 * the ScriptLoader bundle `mapcustomers`, registered at runtime by maps-core.js
 * (script-loader.js is blocking and at its byte ceiling) and attached to the
 * 'map' view after 'mapvendor', so goTo('map') fetches it alongside Leaflet.
 * Pins:
 *   - on the REAL script-loader.js, maps-core.js registers the bundle and the
 *     view once, and preloadForView('map') then fetches maps-customers.js once;
 *   - toggleOverlay('customers') before the file lands toggles the button at
 *     once, throws nothing and shows the layer when it lands; after that it calls
 *     straight through; a failed fetch leaves the toggle working and calls nothing;
 *   - initMainMap redraws the saved zones when the file lands after the map was
 *     built (their rep labels read window.nbdRepList), and only then;
 *   - maps-customers.js executes with no Leaflet, map or ScriptLoader, defines its
 *     window API, and late-loaded beside maps-core.js reads its let bindings;
 *   - every other reader of its window API is typeof-guarded;
 *   - dashboard.html has no maps-customers.js tag; core → overlays → maps stay
 *     eager, in order, after the blocking script-loader.js.
 *
 * Run: node tests/lazy-maps-customers-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { codeOnly } = require('../scripts/lib/toplevel-scan.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const flush = () => new Promise((r) => setImmediate(r));
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const CORE = read('docs/pro/js/maps-core.js');
const CUST = read('docs/pro/js/maps-customers.js');
const LOADER = read('docs/pro/js/script-loader.js');
const API = ['buildCustomersLayer', 'showCustomersLayer', 'hideCustomersLayer', 'refreshCustomersLayer',
  'buildCustomerRoute', 'toggleCustomerRoute', 'openRouteInGmaps', 'nbdRepList'];

// A realm whose global object IS window, like a page: classic-script function
// declarations land on it and top-level let/const are shared across scripts.
function realm(extra) {
  const ctx = Object.assign({ console, Promise, URL, addEventListener() {} }, extra || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  return ctx;
}
function runIn(ctx, src, filename) { vm.runInContext(src, ctx, { filename }); }
function el() { const e = { on: null }; e.classList = { toggle(c, v) { if (c === 'on') e.on = !!v; } }; return e; }
// One tap on the Customers toggle; returns what it threw (null when nothing).
function tap(ctx, tog) { try { ctx.toggleOverlay('customers', tog); return null; } catch (e) { return e; } }
// A fake ScriptLoader whose `mapcustomers` load resolves when the test says so.
function fakeLoader() {
  let land;
  const landed = new Promise((r) => { land = r; });
  const calls = [];
  return { calls, land: () => land(), sl: { bundles: {}, views: { map: ['mapvendor'] }, loadBundle(name) { calls.push(name); return landed; } } };
}
// What maps-customers.js defines when it runs (counted stand-ins).
function arrive(ctx, n) {
  ctx.showCustomersLayer = () => { n.shows++; };
  ctx.hideCustomersLayer = () => { n.hides++; };
  ctx.nbdRepList = () => [];
}

(async function main() {
console.log('\nMAPS CUSTOMERS: the bundle, registered on the real script-loader.js');
{
  const appended = [];
  const document = {
    baseURI: 'https://x.test/pro/dashboard.html',
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => ({ tagName: String(tag).toUpperCase() }),
    head: { appendChild(node) { appended.push(node); return node; } },
  };
  const ctx = realm({ document, setTimeout, clearTimeout });
  runIn(ctx, LOADER, 'script-loader.js');
  const SL = ctx.ScriptLoader;
  ok('control: script-loader.js itself has no mapcustomers bundle and the map view is just mapvendor',
    !!SL && !SL.bundles.mapcustomers && JSON.stringify(SL.views.map) === '["mapvendor"]', SL && JSON.stringify(SL.views.map));
  ok('script-loader.js is untouched by this lane (blocking, at its byte ceiling)', !/maps-customers|mapcustomers/.test(LOADER));
  let threw = null;
  try { runIn(ctx, CORE, 'maps-core.js'); } catch (e) { threw = e; }
  ok('maps-core.js runs on the page realm without Leaflet', !threw, threw && threw.message);
  const list = (SL.bundles.mapcustomers || []).map((s) => String(s));
  ok('maps-core.js registers bundles.mapcustomers = [js/maps-customers.js?v=…]',
    list.length === 1 && /^js\/maps-customers\.js\?v=\d+$/.test(list[0]), JSON.stringify(list));
  ok('the bundle\'s file exists', list.length === 1 && fs.existsSync(path.join(ROOT, 'docs/pro', list[0].split('?')[0])));
  ok('the map view now loads mapvendor, then mapcustomers', JSON.stringify(SL.views.map) === '["mapvendor","mapcustomers"]', JSON.stringify(SL.views.map));
  ok('the draw view is unchanged', JSON.stringify(SL.views.draw) === '["mapvendor","drawtool"]', JSON.stringify(SL.views.draw));

  const custTags = () => appended.filter((n) => n.tagName === 'SCRIPT' && /maps-customers\.js/.test(n.src || ''));
  ok('nothing fetches maps-customers.js before the map view opens', custTags().length === 0);
  SL.preloadForView('map');
  await flush(); // loadBundle inserts each tag from its promise chain
  ok('goTo(\'map\')\'s preloadForView fetches maps-customers.js (in parallel with Leaflet, which is still on its first file)',
    custTags().length === 1 && appended.filter((n) => n.tagName === 'SCRIPT').length === 1, appended.map((n) => n.tagName + ' ' + (n.src || n.href)).join(' | '));
  SL.preloadForView('map');
  SL.loadBundle('mapcustomers');
  await flush();
  ok('…once: a second map entry or a direct loadBundle while it is on its way adds no second tag', custTags().length === 1);
  let resolved = false;
  SL.loadBundle('mapcustomers').then(() => { resolved = true; });
  const tag = custTags()[0];
  if (tag && typeof tag.onload === 'function') tag.onload();
  await flush();
  ok('the bundle resolves when the file has run', resolved && SL.isLoaded('mapcustomers'));
}
{
  const f = fakeLoader();
  f.sl.bundles.mapcustomers = ['js/other.js?v=1'];
  f.sl.views.map = ['mapvendor', 'mapcustomers'];
  const ctx = realm({ ScriptLoader: f.sl });
  runIn(ctx, CORE, 'maps-core.js');
  ok('an already-registered bundle is kept and the view is not attached twice',
    f.sl.bundles.mapcustomers[0] === 'js/other.js?v=1' && f.sl.views.map.length === 2, JSON.stringify(f.sl.views.map));
  let threw = null;
  try { runIn(realm(), CORE, 'maps-core.js'); } catch (e) { threw = e; }
  ok('no ScriptLoader on the page: maps-core.js still runs', !threw, threw && threw.message);
}

console.log('\nMAPS CUSTOMERS: toggleOverlay(\'customers\') before and after the file lands');
{
  const f = fakeLoader();
  const n = { shows: 0, hides: 0 };
  const ctx = realm({ ScriptLoader: f.sl });
  runIn(ctx, CORE, 'maps-core.js');
  const tog = el();
  const threw = tap(ctx, tog);
  ok('a tap before the file lands throws nothing', !threw, threw && threw.message);
  ok('…turns the toggle on at once (fabToggle reads the class right after)', tog.on === true && vm.runInContext('overlayState.customers', ctx) === true);
  ok('…and asks for the mapcustomers bundle', f.calls.join() === 'mapcustomers', f.calls.join());
  arrive(ctx, n);
  f.land();
  await flush();
  ok('when the file lands the layer is shown, once', n.shows === 1 && n.hides === 0, JSON.stringify(n));
  const t2 = tap(ctx, tog);
  ok('once it is here a tap calls straight through (hide, synchronously, no new fetch)', !t2 && n.hides === 1 && tog.on === false && f.calls.length === 1, JSON.stringify(n) + ' ' + f.calls.join());
  const t3 = tap(ctx, tog);
  ok('…and on again shows it synchronously', !t3 && n.shows === 2 && tog.on === true, JSON.stringify(n));
}
{
  const f = fakeLoader();
  const n = { shows: 0, hides: 0 };
  const ctx = realm({ ScriptLoader: f.sl });
  runIn(ctx, CORE, 'maps-core.js');
  const tog = el();
  const t1 = tap(ctx, tog) || tap(ctx, tog);
  arrive(ctx, n);
  f.land();
  await flush();
  ok('on then off before it lands: the layer ends hidden, as the toggle shows', !t1 && n.shows === 0 && n.hides >= 1 && tog.on === false, JSON.stringify(n));
}
{
  const f = fakeLoader();
  const ctx = realm({ ScriptLoader: f.sl });
  runIn(ctx, CORE, 'maps-core.js');
  const tog = el();
  const threw = tap(ctx, tog);
  f.land(); // loadBundle never rejects: a failed fetch resolves with the file absent
  await flush();
  ok('a failed fetch: the toggle still works, nothing throws, nothing is called', !threw && tog.on === true && unhandled === 0, (threw && threw.message) + ' unhandled=' + unhandled);
  const ctx2 = realm();
  runIn(ctx2, CORE, 'maps-core.js');
  const tog2 = el();
  const threw2 = tap(ctx2, tog2);
  await flush();
  ok('no ScriptLoader at all: the toggle still works and nothing throws', !threw2 && tog2.on === true && unhandled === 0, threw2 && threw2.message);
}

console.log('\nMAPS CUSTOMERS: saved zones redraw when the file lands after the map');
function mapRealm(f) {
  const timers = [];
  const L = {
    map() { const m = { setView() { return m; }, on() { return m; }, addLayer() { return m; }, invalidateSize() {} }; return m; },
    tileLayer() { const t = { addTo() { return t; }, on() { return t; } }; return t; },
  };
  const ctx = realm({ L, ScriptLoader: f && f.sl, setTimeout: (fn, ms) => { timers.push(ms); return timers.length; } });
  if (!f) delete ctx.ScriptLoader;
  runIn(ctx, CORE, 'maps-core.js');
  return { ctx, timers };
}
{
  const f = fakeLoader();
  const n = { shows: 0, hides: 0 };
  const { ctx, timers } = mapRealm(f);
  let renders = 0;
  ctx.renderSavedZones = () => { renders++; };
  let threw = null;
  try { ctx.initMainMap(); } catch (e) { threw = e; }
  ok('initMainMap builds the map with the file not here yet', !threw && timers.indexOf(400) !== -1, threw && threw.message);
  ok('…and asks for the mapcustomers bundle', f.calls.join() === 'mapcustomers', f.calls.join());
  ok('…but draws nothing extra before it lands', renders === 0);
  arrive(ctx, n);
  f.land();
  await flush();
  ok('when it lands the saved zones are drawn again (rep labels now resolve, e.g. "Me")', renders === 1, renders);
  ok('…without touching the Customers layer', n.shows === 0 && n.hides === 0);
}
{
  const f = fakeLoader();
  const { ctx } = mapRealm(f);
  let renders = 0;
  ctx.renderSavedZones = () => { renders++; };
  arrive(ctx, { shows: 0, hides: 0 });
  ctx.initMainMap();
  f.land();
  await flush();
  ok('file already here at initMainMap: no fetch and no extra zone draw (the 400 ms draw covers it)', f.calls.length === 0 && renders === 0, f.calls.join() + ' renders=' + renders);
}
{
  const f = fakeLoader();
  const { ctx } = mapRealm(f);
  let renders = 0;
  ctx.renderSavedZones = () => { renders++; };
  let threw = null;
  try { ctx.initMainMap(); } catch (e) { threw = e; }
  f.land();
  await flush();
  ok('a failed fetch: the map still builds, no extra draw, nothing throws', !threw && renders === 0 && unhandled === 0, threw && threw.message);
  let threw2 = null;
  try { mapRealm(null).ctx.initMainMap(); } catch (e) { threw2 = e; }
  ok('no ScriptLoader at all: the map still builds', !threw2, threw2 && threw2.message);
}

console.log('\nMAPS CUSTOMERS: the file itself runs late and alone');
{
  const ctx = realm();
  let threw = null;
  try { runIn(ctx, CUST, 'maps-customers.js'); } catch (e) { threw = e; }
  ok('maps-customers.js executes with no Leaflet, no map, no overlay state and no ScriptLoader', !threw, threw && threw.message);
  ok('it defines its whole window API', API.every((k) => typeof ctx[k] === 'function'), API.filter((k) => typeof ctx[k] !== 'function').join());
  ctx._leads = [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u1' }, { userId: 'u3', deleted: true }];
  const reps = ctx.nbdRepList();
  ok('window.nbdRepList works on its own (distinct live owners, palette-coloured)', Array.isArray(reps) && reps.length === 2 && reps.every((r) => r.key && r.color), JSON.stringify(reps));
}
{
  const ctx = realm();
  runIn(ctx, CORE, 'maps-core.js');
  let threw = null;
  try { runIn(ctx, CUST, 'maps-customers.js'); ctx.refreshCustomersLayer(); } catch (e) { threw = e; }
  ok('loaded after maps-core.js in the same realm (the lazy path), it reads maps-core\'s let overlayState: a leads refresh with the overlay off is a no-op', !threw, threw && threw.message);
}

console.log('\nMAPS CUSTOMERS: every other reader of its window API is guarded');
{
  const dir = path.join(ROOT, 'docs/pro/js');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(dir);
  const skip = new Set(['maps-customers.js', 'maps-core.js']); // the owner, and the toggle (proved by running it above)
  const unguarded = [];
  let guardedReads = 0;
  for (const p of files) {
    if (skip.has(path.basename(p))) continue;
    const code = codeOnly(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
    for (const name of API) {
      const re = new RegExp('(?:window\\.)?\\b' + name + '\\b', 'g');
      let m;
      while ((m = re.exec(code))) {
        const before = code.slice(Math.max(0, m.index - 240), m.index);
        if (/typeof\s+$/.test(before)) continue; // the guard itself
        if (new RegExp('typeof\\s+(?:window\\.)?' + name + '\\b').test(before)) { guardedReads++; continue; }
        unguarded.push(path.relative(ROOT, p) + ':' + (code.slice(0, m.index).split('\n').length) + ' ' + name);
      }
    }
  }
  ok('the scan sees the known readers (loadLeads\' refresh, the zone rep picker and labels)', guardedReads >= 3, guardedReads);
  ok('no file reads the Customers API without a typeof guard', unguarded.length === 0, unguarded.join(', '));
}

console.log('\nMAPS CUSTOMERS: dashboard.html');
{
  const dash = read('docs/pro/dashboard.html');
  const live = dash.replace(/<!--[\s\S]*?-->/g, '');
  ok('maps-customers.js is not a script tag on the dashboard any more', !/<script[^>]*src="[^"]*maps-customers\.js/.test(dash));
  const at = (re) => { const m = re.exec(live); return m ? m.index : -1; };
  const loader = at(/<script src="js\/script-loader\.js\?v=\d+"><\/script>/);
  const core = at(/<script defer src="js\/maps-core\.js\?v=(\d+)"><\/script>/);
  const overlays = at(/<script defer src="js\/maps-overlays\.js\?v=\d+"><\/script>/);
  const shim = at(/<script defer src="js\/maps\.js\?v=\d+"><\/script>/);
  ok('the blocking script-loader.js comes before maps-core.js (registration needs it)', loader > 0 && core > loader);
  ok('core → overlays → maps stay eager, in that order', core > 0 && overlays > core && shim > overlays);
  const v = Number((/maps-core\.js\?v=(\d+)/.exec(live) || [])[1]);
  ok('maps-core.js is re-versioned past 9 (a cached copy without the registration would leave the toggle dead)', v >= 10, v);
  ok('the Customers toggle and FAB are still in the page', /id="tog-customers" data-action="mapOverlay" data-target="customers"/.test(dash) && /id="fab-customers"[^>]*data-arg="customers"/.test(dash));
  ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-maps-customers-2026-11-08.test.js"') >= 0);
}

await flush();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ the suite crashed: ' + (e && e.stack || e)); process.exit(1); });
