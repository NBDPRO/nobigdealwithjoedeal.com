/**
 * tests/lazy-my-skin-2026-11-08.test.js — My Skin (my-skin-logic.js +
 * my-skin.js) loads only for an account that uses it (boot-weight lane,
 * 2026-11-08).
 *
 * Before: two deferred <script> tags on every dashboard and customer page boot
 * (~70 KB shipped), running for the page's life for every user: ten document
 * listeners, a body-wide MutationObserver, two Firestore listeners, though
 * most accounts never set a skin. After: js/my-skin-boot.js registers the
 * `myskin` ScriptLoader bundle at runtime and loads it when this device
 * painted a skin last time (localStorage nbd_myskin_boot, written by
 * my-skin.js), when the boot read finds a skin (userSettings mySkin, or the
 * company's skin/config enabled), when that read cannot be answered, or when
 * Settings opens. Pins:
 *   - the kicker in a vm with fakes: what loads, what is read, and when;
 *   - it registers on the REAL script-loader.js (logic before my-skin.js) and
 *     goTo('settings')'s preloadForView then fetches both, in order;
 *   - my-skin.js writes the hint when it paints and drops it when nothing
 *     paints, and the sign-out sweep in nbd-auth.js wipes it;
 *   - both pages carry the kicker and neither eager tag; my-skin.css stays an
 *     eager stylesheet.
 *
 * Run: node tests/lazy-my-skin-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
let passed = 0, failed = 0, finished = false;
process.on('exit', () => { if (!finished) { console.log('  ✗ the suite did not finish'); process.exitCode = 1; } });
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const KICKER = 'docs/pro/js/my-skin-boot.js';
const SRC = exists(KICKER) ? read(KICKER) : '';
const snapOf = (data, fromCache) => ({ exists: () => !!data, data: () => data, metadata: { fromCache: !!fromCache, hasPendingWrites: false } });

// ── the kicker with a fake ScriptLoader / Firestore / localStorage ─────────
// docs: path -> data, or a function (n) -> snap | throws, n = the read count for that path.
function kicker(opts) {
  opts = opts || {};
  const loads = [], reads = [], listeners = [];
  const store = Object.assign({}, opts.storage || {});
  const fast = (fn, ms) => setTimeout(fn, Math.max(0, Math.ceil((ms || 0) / 100)));
  const w = {
    setTimeout: fast, clearTimeout, Promise, console,
    addEventListener(t) { listeners.push('window:' + t); },
    document: { addEventListener(t) { listeners.push('document:' + t); } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    loads, reads, listeners, store,
  };
  if (opts.loader !== false) {
    w.ScriptLoader = {
      bundles: {}, views: { settings: ['theme', 'tenantsettings', 'companydocs'] },
      loadBundle(name) { loads.push(name); if (opts.throwOnLoad) throw new Error('boom'); return Promise.resolve(); },
    };
  }
  if (opts.user !== false) {
    const docs = opts.docs || {};
    const count = {};
    w._user = { uid: 'u1' };
    w._userClaims = opts.claims || {};
    w.db = {}; w.storage = {};
    w.doc = (db, ...parts) => ({ path: parts.join('/') });
    w.getDoc = async (ref) => {
      reads.push(ref.path);
      count[ref.path] = (count[ref.path] || 0) + 1;
      const d = docs[ref.path];
      if (typeof d === 'function') return d(count[ref.path]);
      return snapOf(d || null, false);
    };
  }
  if (opts.lateUser) { w._user = undefined; }
  w.window = w;
  return w;
}
function run(w) {
  const ctx = vm.createContext(w);
  vm.runInContext(SRC, ctx, { filename: 'my-skin-boot.js' });
  return w;
}
const settle = async (w, ms) => { for (let i = 0; i < (ms || 150); i++) await tick(2); return w; };

(async () => {
  console.log('\nMY SKIN BOOT: the kicker');
  ok('js/my-skin-boot.js exists', SRC.length > 0);
  {
    const w = await settle(run(kicker({ docs: {} })));
    ok('no mySkin and no company set: the bundle is never loaded', w.loads.length === 0, w.loads);
    ok('...after one read of userSettings and one of the company config (the solo owner\'s own id)', w.reads.join() === 'userSettings/u1,companies/u1/skin/config', w.reads);
    ok('it registers the myskin bundle at runtime', !!(w.ScriptLoader.bundles.myskin && w.ScriptLoader.bundles.myskin.length === 2), JSON.stringify(w.ScriptLoader.bundles));
    ok('Settings opening loads it: views.settings gains myskin once, its bundles kept', w.ScriptLoader.views.settings.join() === 'theme,tenantsettings,companydocs,myskin', w.ScriptLoader.views.settings);
    ok('no page-lifetime listener (no addEventListener at all)', w.listeners.length === 0, w.listeners);
  }
  {
    const w = await settle(run(kicker({ docs: { 'userSettings/u1': { mySkin: { enabled: false } } } })));
    ok('a saved mySkin (even switched off): loaded once', w.loads.join() === 'myskin', w.loads);
    ok('...and the company config is not read', w.reads.join() === 'userSettings/u1', w.reads);
  }
  {
    const w = await settle(run(kicker({ claims: { companyId: 'co9' }, docs: { 'companies/co9/skin/config': { enabled: true } } })));
    ok('the company\'s set is on: loaded once, read from the claims\' company', w.loads.join() === 'myskin' && w.reads.indexOf('companies/co9/skin/config') >= 0, w.loads + ' / ' + w.reads);
  }
  {
    const w = await settle(run(kicker({ docs: { 'companies/u1/skin/config': { enabled: false, themes: {} } } })));
    ok('a company set that is switched off: not loaded', w.loads.length === 0, w.loads);
  }
  {
    const w = run(kicker({ storage: { nbd_myskin_boot: '1' }, docs: {} }));
    ok('the device hint: loaded at once, before any read', w.loads.join() === 'myskin' && w.reads.length === 0, w.loads + ' / ' + w.reads);
    await settle(w);
    ok('...and nothing is read afterwards', w.reads.length === 0 && w.loads.length === 1, w.reads);
  }
  {
    const w = await settle(run(kicker({ user: false })));
    ok('signed out: nothing is read and nothing loads', w.reads.length === 0 && w.loads.length === 0);
  }
  {
    const w = kicker({ docs: { 'userSettings/u1': { mySkin: { enabled: true } } } });
    const u = w._user; w._user = undefined;
    run(w);
    await settle(w, 20);
    ok('before sign-in: no read yet', w.reads.length === 0 && w.loads.length === 0, w.reads);
    w._user = u;
    await settle(w);
    ok('signed in later: the read runs and the skin loads', w.loads.join() === 'myskin', w.loads + ' / ' + w.reads);
  }
  {
    const w = await settle(run(kicker({ docs: { 'userSettings/u1': (n) => (n === 1 ? snapOf(null, true) : snapOf({ mySkin: { enabled: true } }, false)) } })), 300);
    ok('an EMPTY cached first answer is asked again: the server\'s skin loads', w.loads.join() === 'myskin' && w.reads.filter((p) => p === 'userSettings/u1').length === 2, w.loads + ' / ' + w.reads);
  }
  {
    const w = await settle(run(kicker({ docs: { 'userSettings/u1': () => snapOf(null, true) } })), 600);
    const n = w.reads.filter((p) => p === 'userSettings/u1').length;
    ok('only empty cached answers (offline): asked a bounded number of times, then loaded (as before)', w.loads.join() === 'myskin' && n >= 2 && n <= 6, w.loads + ' reads=' + n);
  }
  {
    const w = await settle(run(kicker({ docs: { 'userSettings/u1': () => { throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' }); } } })), 300);
    ok('the settings read fails: loaded (as before), the CRM untouched', w.loads.join() === 'myskin', w.loads);
  }
  {
    const w = await settle(run(kicker({ docs: { 'companies/u1/skin/config': () => { throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); } } })));
    ok('the company read is refused: not loaded (no set to paint, as my-skin.js treats it)', w.loads.length === 0, w.loads);
  }
  {
    // Any other failure is no answer, not "no set": a team's background
    // must not vanish for the session because one read hit a dead spot.
    const w = await settle(run(kicker({ docs: { 'companies/u1/skin/config': () => { throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' }); } } })), 300);
    ok('the company read fails offline: loaded (no answer, as before)', w.loads.join() === 'myskin', w.loads);
  }
  {
    let threw = false;
    try { const w = run(kicker({ loader: false, docs: { 'userSettings/u1': { mySkin: {} } } })); await settle(w); ok('no ScriptLoader: nothing is read', w.reads.length === 0, w.reads); } catch (e) { threw = e; }
    ok('no ScriptLoader on the page: nothing throws', !threw, threw);
    let threw2 = false;
    try { const w = run(kicker({ throwOnLoad: true, storage: { nbd_myskin_boot: '1' } })); await settle(w); } catch (e) { threw2 = e; }
    ok('a loadBundle that throws does not escape', !threw2, threw2);
    let threw3 = false;
    try { const w = kicker({}); w.localStorage = { getItem() { throw new Error('SecurityError'); } }; run(w); await settle(w); ok('storage that throws: falls back to the read', w.reads.length === 2, w.reads); } catch (e) { threw3 = e; }
    ok('storage that throws does not escape', !threw3, threw3);
  }
  {
    const w = kicker({ docs: { 'userSettings/u1': { mySkin: { enabled: true } } } });
    run(w); run(w);
    await settle(w);
    ok('running the file twice: one read, one load, myskin listed once', w.reads.filter((p) => p === 'userSettings/u1').length === 1 && w.loads.length === 1 && w.ScriptLoader.views.settings.filter((n) => n === 'myskin').length === 1, w.reads + ' / ' + w.loads);
  }

  console.log('\nMY SKIN BOOT: the real script-loader.js');
  {
    const inserted = [];
    const document = {
      querySelector: () => null, querySelectorAll: () => [], baseURI: 'https://x.test/pro/',
      createElement: (tag) => ({ tag }),
      head: { appendChild(el) { if (el.tag === 'script') inserted.push(el.src); setTimeout(() => el.onload && el.onload(), 1); } },
    };
    const ctx = { window: { addEventListener() {} }, document, console, setTimeout, URL };
    ctx.window.document = document;
    vm.createContext(ctx);
    vm.runInContext(read('docs/pro/js/script-loader.js'), ctx, { filename: 'script-loader.js' });
    const SL = ctx.window.ScriptLoader;
    ok('control: script-loader.js itself has no myskin bundle (it is blocking, at its byte ceiling)', !SL.bundles.myskin && !/myskin|my-skin/.test(read('docs/pro/js/script-loader.js')));
    vm.runInContext(SRC, ctx, { filename: 'my-skin-boot.js' });
    const B = (SL.bundles.myskin || []).map((s) => String(s).split('?')[0]);
    ok('myskin is registered on the real loader: my-skin-logic.js, then my-skin.js', B.join() === 'js/my-skin-logic.js,js/my-skin.js', B);
    ok('no stylesheet in the bundle (my-skin.css stays an eager link)', (SL.bundles.myskin || []).every((s) => !/\.css/.test(s)));
    ok('the real views.settings lists myskin after its own bundles', (SL.views.settings || []).join() === 'theme,tenantsettings,companydocs,myskin', SL.views.settings);
    inserted.length = 0;
    await SL.preloadForView('settings');
    const mine = inserted.map((s) => String(s).split('?')[0]).filter((s) => /my-skin/.test(s));
    ok('goTo(\'settings\') (preloadForView) fetches both files, logic first', mine.join() === 'js/my-skin-logic.js,js/my-skin.js', inserted);
    const v = (re, s) => ((s || '').match(re) || [])[1];
    const reg = (SL.bundles.myskin || []).join(' ');
    ok('the bundle\'s logic cache-buster is the one the encode worker imports', !!v(/my-skin-logic\.js\?v=(\d+)/, reg) && v(/my-skin-logic\.js\?v=(\d+)/, reg) === v(/my-skin-logic\.js\?v=(\d+)/, read('docs/pro/js/my-skin-encode-worker.js')), reg);
    ok('my-skin.js\'s cache-buster is bumped for the hint it now writes (v=12) and the NBD OS wallpaper API (v=13)', /js\/my-skin\.js\?v=13\b/.test(reg), reg);
  }

  console.log('\nMY SKIN BOOT: my-skin.js writes the device hint');
  function skin(mySkin, store) {
    const els = {};
    const nullEl = () => ({ hidden: false, style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; }, appendChild() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
    // classList as a real array (paint() strips with Array.prototype.slice.call(root.classList)).
    const cls = [];
    cls.add = (...c) => c.forEach((x) => { if (cls.indexOf(x) < 0) cls.push(x); });
    cls.remove = (...c) => c.forEach((x) => { const i = cls.indexOf(x); if (i >= 0) cls.splice(i, 1); });
    cls.contains = (c) => cls.indexOf(c) >= 0;
    cls.toggle = (c, on) => { if (on === undefined ? !cls.contains(c) : on) cls.add(c); else cls.remove(c); };
    cls.has = cls.contains;
    const html = nullEl();
    html.classList = cls;
    const document = {
      readyState: 'complete', body: nullEl(), documentElement: html, activeElement: null,
      addEventListener() {}, getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [], createElement: nullEl,
    };
    const win = {
      document, setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, Math.ceil((ms || 0) / 50))), clearTimeout, console, Promise, Date, JSON, Math, Object, Array, String, Number, Error, RegExp, Map, Set, Symbol,
      MutationObserver: function () { this.observe = () => {}; },
      sessionStorage: { length: 0, key() { return null; }, getItem() { return null; }, setItem() {}, removeItem() {} },
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      indexedDB: { deleteDatabase() {} },
      _user: { uid: 'u1' }, db: {}, storage: {},
      doc: (db, ...parts) => ({ path: parts.join('/') }),
      onSnapshot: (ref, a, b) => { const next = typeof a === 'function' ? a : b; setTimeout(() => next(ref.path.indexOf('skin/config') > -1 ? snapOf(null) : snapOf({ mySkin })), 1); return () => {}; },
      getDoc: async () => snapOf({ mySkin }),
      setDoc: async () => {},
    };
    if (store) win.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
    win.window = win; win.self = win;
    const ctx = vm.createContext(win);
    vm.runInContext(read('docs/pro/js/my-skin-logic.js'), ctx, { filename: 'my-skin-logic.js' });
    vm.runInContext(read('docs/pro/js/my-skin.js'), ctx, { filename: 'my-skin.js' });
    return { ctx, cls, ready: async () => { for (let i = 0; i < 200 && !ctx.NBDMySkin.state().cfg; i++) await tick(5); await tick(20); } };
  }
  {
    const store = {};
    const s = skin({ enabled: true, accent: '#ffcc00' }, store); await s.ready();
    ok('control: a skin with a custom accent paints (my-skin + my-skin-accent on <html>)', s.cls.has('my-skin') && s.cls.has('my-skin-accent'), [...s.cls].join(' '));
    ok('a painted skin writes nbd_myskin_boot=1 (the next boot loads My Skin at once)', store.nbd_myskin_boot === '1', JSON.stringify(store));
    s.ctx.NBDMySkin.purgeLocal();
    ok('sign-out (purgeLocal): the hint is gone with the skin', !('nbd_myskin_boot' in store) && s.cls.length === 0, JSON.stringify(store));
  }
  {
    const store = { nbd_myskin_boot: '1' };
    const s = skin({ enabled: false, accent: '#ffcc00' }, store); await s.ready();
    ok('a skin that paints nothing (switched off) removes a stale hint', !!s.ctx.NBDMySkin.state().cfg && !('nbd_myskin_boot' in store) && s.cls.length === 0, JSON.stringify(store));
  }
  {
    let threw = false;
    try { const s = skin({ enabled: true, accent: '#ffcc00' }, null); await s.ready(); ok('no localStorage: it still paints', s.cls.has('my-skin-accent')); } catch (e) { threw = e; }
    ok('no localStorage on the page: nothing throws', !threw, threw);
  }
  {
    const A = read('docs/pro/js/nbd-auth.js');
    const a = A.indexOf('const KEEP = new Set(['), b = A.indexOf('drop.forEach', a);
    const body = a > 0 && b > a ? A.slice(a, A.indexOf('\n', b)) : '';
    const store = { nbd_myskin_boot: '1', 'nbd-theme': 'x' };
    const ls = { get length() { return Object.keys(store).length; }, key: (i) => Object.keys(store)[i] || null, removeItem: (k) => { delete store[k]; } };
    try { vm.runInNewContext(body, { localStorage: ls, Set }); } catch (e) { /* reported below */ }
    ok('the real sign-out sweep (nbd-auth.js purgeAccountStorage) wipes nbd_myskin_boot and keeps device prefs', body.length > 0 && !('nbd_myskin_boot' in store) && store['nbd-theme'] === 'x', JSON.stringify(store));
  }

  console.log('\nMY SKIN BOOT: the pages');
  for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
    const h = read(page).replace(/<!--[\s\S]*?-->/g, '');
    const n = page.split('/').pop();
    ok(n + ': the kicker is a deferred external tag', /<script defer src="js\/my-skin-boot\.js\?v=\d+"><\/script>/.test(h));
    ok(n + ': no eager tag for my-skin.js or my-skin-logic.js', !/<script[^>]*src="[^"]*js\/my-skin(-logic)?\.js/.test(h));
    ok(n + ': my-skin.css is still a plain eager stylesheet (first-screen, gated on html classes)', /<link rel="stylesheet" href="css\/my-skin\.css\?v=\d+">/.test(h));
    ok(n + ': the kicker comes after script-loader.js (registration needs it)', h.indexOf('js/script-loader.js') > 0 && h.indexOf('js/my-skin-boot.js') > h.indexOf('js/script-loader.js'));
  }
  ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-my-skin-2026-11-08.test.js"') >= 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  finished = true;
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ the suite threw: ' + (e && e.stack || e)); finished = true; process.exit(1); });
