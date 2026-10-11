/**
 * tests/layout-system-2026-10-11.test.js — D0 of the CRM style integration:
 * the layout registry, the one precedence rule, LayoutEngine.apply, the
 * pre-paint cache and the --tap token.
 *
 *   1. layout-system.js (registry half): resolve() precedence — locked company layout >
 *      user choice > company default > classic — across surfaces, with the
 *      allowed list, unknown ids and an unsupported surface (pure, vm-free)
 *   2. layout-system.js (engine half) in a stubbed browser: apply() stamps data-layout,
 *      fires layoutchange once per real change, mounts/unmounts, lets a newer
 *      apply() supersede a slower one, writes the per-surface resolved cache,
 *      saveUser() writes a MERGE with nulls for cleared overrides, and a
 *      failed company read never drops a cached lock
 *   3. wiring: the preboot rides in the existing blocking shape-preboot.js (the
 *      boot budget allows no new blocking tag) and is run for real; layout-system.js
 *      is one deferred tag; nothing inline; the resolved-cache key survives sign-out
 *
 * Run: node tests/layout-system-2026-10-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// registry + engine live in ONE deferred file (the boot budget allows no extra tags)
const SYS_SRC = read('docs/pro/js/layout-system.js');
const REG_SRC = SYS_SRC;
const ENG_SRC = '';
const PREBOOT_SRC = read('docs/pro/js/shape-preboot.js');
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));

function fresh() {
  R._reset();
  R.register({ id: 'field', name: 'Field App', surfaces: ['phone', 'tablet'], script: 'js/layouts/field.js', css: 'css/layouts/field.css', supports: { sunlight: true } });
  R.register({ id: 'bento', name: 'Bento', surfaces: ['desktop', 'tablet'] });
  R.register({ id: 'focus', name: 'Focus', surfaces: ['phone', 'tablet', 'desktop'] });
}
const rid = (o) => R.resolve(o).id;
const rsrc = (o) => R.resolve(o).source;

console.log('\n1. precedence');
{
  fresh();
  ok('nothing set -> classic', rid({ surface: 'desktop' }) === 'classic' && rsrc({ surface: 'desktop' }) === 'classic');
  ok('classic is registered with all three surfaces and no assets',
    (() => { const c = R.get('classic'); return c.surfaces.length === 3 && c.script === null && c.css === null; })());
  ok('user choice beats the company default',
    rid({ surface: 'desktop', user: { id: 'bento' }, company: { defaultLayout: 'focus' } }) === 'bento');
  ok('company default applies when the user chose nothing',
    rid({ surface: 'desktop', company: { defaultLayout: 'focus' } }) === 'focus'
    && rsrc({ surface: 'desktop', company: { defaultLayout: 'focus' } }) === 'company-default');
  ok('a locked company layout beats the user choice',
    rid({ surface: 'desktop', user: { id: 'bento' }, company: { defaultLayout: 'focus', locked: true } }) === 'focus'
    && rsrc({ surface: 'desktop', user: { id: 'bento' }, company: { defaultLayout: 'focus', locked: true } }) === 'company-lock');
  ok('lock ignores `allowed` (the admin picked it themselves)',
    rid({ surface: 'desktop', company: { defaultLayout: 'focus', locked: true, allowed: ['bento'] } }) === 'focus');
  ok('lock whose pick cannot show on this surface -> classic, never the user choice',
    (() => {
      const o = { surface: 'desktop', user: { id: 'bento' }, company: { defaultLayout: 'field', locked: true } };
      return rid(o) === 'classic' && rsrc(o) === 'company-lock-fallback';
    })());
  ok('lock can differ per device: phone gets field, desktop gets the default',
    rid({ surface: 'phone', company: { defaultLayout: 'bento', defaultByDevice: { phone: 'field' }, locked: true } }) === 'field'
    && rid({ surface: 'desktop', company: { defaultLayout: 'bento', defaultByDevice: { phone: 'field' }, locked: true } }) === 'bento');
  ok('user byDevice override wins on that surface only',
    rid({ surface: 'phone', user: { id: 'bento', byDevice: { phone: 'field' } } }) === 'field'
    && rid({ surface: 'desktop', user: { id: 'bento', byDevice: { phone: 'field' } } }) === 'bento');
  ok('a layout is never picked for a surface it does not support',
    rid({ surface: 'desktop', user: { id: 'field' } }) === 'classic'
    && rid({ surface: 'phone', user: { id: 'bento' } }) === 'classic');
  ok('unsupported user pick falls through to the company default, not straight to classic',
    rid({ surface: 'desktop', user: { id: 'field' }, company: { defaultLayout: 'focus' } }) === 'focus');
  ok('allowed list hides a layout from the user choice',
    rid({ surface: 'desktop', user: { id: 'bento' }, company: { allowed: ['focus'] } }) === 'classic');
  ok('allowed never hides classic',
    rid({ surface: 'desktop', user: { id: 'classic' }, company: { defaultLayout: 'focus', allowed: ['focus'] } }) === 'classic'
    && rsrc({ surface: 'desktop', user: { id: 'classic' }, company: { defaultLayout: 'focus' } }) === 'user');
  ok('user explicitly choosing classic beats an unlocked company default',
    rid({ surface: 'desktop', user: { id: 'classic' }, company: { defaultLayout: 'bento' } }) === 'classic');
  ok('unknown ids and junk fall to classic',
    rid({ surface: 'desktop', user: { id: 'nope', byDevice: { desktop: '../../x' } }, company: { defaultLayout: 42 } }) === 'classic');
  ok('an unknown surface is treated as desktop', rid({ surface: 'watch', user: { id: 'bento' } }) === 'bento');
  ok('available() can veto (achievement-locked layouts)',
    rid({ surface: 'desktop', user: { id: 'bento' }, available: (d) => d.id !== 'bento' }) === 'classic');
  ok('company.locked must be literally true',
    rid({ surface: 'desktop', user: { id: 'bento' }, company: { defaultLayout: 'focus', locked: 'yes' } }) === 'bento');

  ok('surfaceFor: 768 is a phone (the app breakpoint), 769 touch is a tablet, mouse is desktop',
    R.surfaceFor(768, false) === 'phone' && R.surfaceFor(769, true) === 'tablet' && R.surfaceFor(1100, false) === 'desktop'
    && R.surfaceFor(1400, true) === 'desktop');

  const u = R.normalizeUser({ id: 'bento', byDevice: { phone: 'field', tablet: 'BAD ID', watch: 'x' }, glove: 'true',
    layoutState: { bento: [{ widgetId: 'rev' }], huge: 'x'.repeat(R.MAX_STATE_JSON + 5), 'bad key!': 1 } });
  ok('normalizeUser keeps valid ids/state, drops junk and oversized state; glove must be literal true',
    u.id === 'bento' && u.byDevice.phone === 'field' && !('tablet' in u.byDevice) && !('watch' in u.byDevice)
    && u.glove === false && Array.isArray(u.layoutState.bento) && !('huge' in u.layoutState) && !('bad key!' in u.layoutState));
  const c = R.normalizeCompany({ defaultLayout: 'focus', allowed: ['bento', 5, 'x y'], locked: true });
  ok('normalizeCompany filters allowed to ids', c.defaultLayout === 'focus' && c.allowed.join() === 'bento' && c.locked === true);
  ok('registering a bad id or a path-y script is refused/dropped',
    R.register({ id: '../x' }) === null && R.register({ id: 'evil', script: '//evil.example/x.js', css: 'http://x/y.css' }).script === null);
}

// ── engine in a stubbed browser ─────────────────────────────────────────
function makeBrowser(opts) {
  const o = opts || {};
  const attrs = {};
  const store = Object.assign({}, o.storage || {});
  const listeners = {};
  const events = [];
  const appended = [];
  const writes = [];
  let loadDelay = o.cssDelay || 0;
  const byId = {};
  const documentElement = {
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
  };
  const document = {
    readyState: 'complete',
    documentElement,
    head: { appendChild(el) {
      appended.push(el);
      if (el.id) byId[el.id] = el;
      el.parentNode = { removeChild(x) { if (x.id && byId[x.id] === x) delete byId[x.id]; } };
      const fire = () => (el._l.load || []).forEach((f) => f());
      if (el.tagName === 'link') setTimeout(fire, el.href.indexOf('slow') !== -1 ? 40 : loadDelay);
      if (el.tagName === 'script') setTimeout(() => el.onload && el.onload(), 0);
    } },
    createElement(tag) {
      const el = { tagName: tag, _l: {}, setAttribute(k, v) { this['@' + k] = v; }, getAttribute(k) { return this['@' + k] === undefined ? null : this['@' + k]; },
        addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } };
      return el;
    },
    getElementById(id) { return byId[id] || null; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent(ev) { events.push(ev); (listeners[ev.type] || []).forEach((f) => f(ev)); return true; },
  };
  const win = {
    document,
    innerWidth: o.width || 1280,
    matchMedia: (q) => ({ matches: /coarse/.test(q) ? !!o.coarse : false }),
    addEventListener() {},
    setTimeout, clearTimeout,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    _user: o.uid ? { uid: o.uid } : null,
    db: {}, doc: (...a) => ({ path: a.slice(1).join('/') }),
    getDoc: (ref) => {
      const r = o.docs && o.docs[ref.path];
      if (r === 'FAIL') return Promise.reject(new Error('offline'));
      return Promise.resolve({ exists: () => !!r, data: () => r, metadata: { fromCache: false } });
    },
    setDoc: (ref, data, opt) => { writes.push({ path: ref.path, data, opt }); return Promise.resolve(); },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    console,
  };
  win.window = win;
  win.CustomEvent = win.CustomEvent;
  return { win, attrs, store, events, appended, writes, document };
}
function loadEngine(b) {
  const ctx = vm.createContext(Object.assign({}, b.win, { document: b.document, CustomEvent: b.win.CustomEvent, localStorage: b.win.localStorage, navigator: {} }));
  ctx.window = ctx;
  vm.runInContext(REG_SRC, ctx, { filename: 'layout-registry.js' });
  ctx.LayoutRegistry.register({ id: 'field', name: 'Field App', surfaces: ['phone', 'tablet'], script: 'js/layouts/field.js', css: 'css/layouts/field.css' });
  ctx.LayoutRegistry.register({ id: 'bento', name: 'Bento', surfaces: ['desktop', 'tablet'], css: 'css/layouts/bento.css' });
  ctx.LayoutRegistry.register({ id: 'focus', name: 'Focus', surfaces: ['phone', 'tablet', 'desktop'] });
  vm.runInContext(ENG_SRC, ctx, { filename: 'layout-engine.js' });
  return ctx;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

(async () => {
  console.log('\n2. LayoutEngine');
  {
    const b = makeBrowser({});
    const ctx = loadEngine(b);
    const E = ctx.LayoutEngine;
    await tick(20);
    ok('boot with nothing cached applies classic and stamps data-layout', b.attrs['data-layout'] === 'classic' && E.current().id === 'classic');
    ok('classic adds no stylesheet and no script', b.appended.length === 0);

    let mounts = 0, unmounts = 0;
    ctx.LayoutEngine.implement('bento', { mount() { mounts++; }, unmount() { unmounts++; } });
    const before = b.events.length;
    await E.apply('bento', { source: 'user' });
    ok('apply stamps data-layout and loads exactly that layout\'s stylesheet',
      b.attrs['data-layout'] === 'bento' && b.appended.filter((e) => e.tagName === 'link' && /bento\.css$/.test(e.href)).length === 1);
    ok('layoutchange fires once with layout/previous/surface/source',
      b.events.length === before + 1 && b.events[before].type === 'layoutchange'
      && b.events[before].detail.layout === 'bento' && b.events[before].detail.previous === 'classic'
      && b.events[before].detail.surface === 'desktop' && b.events[before].detail.source === 'user');
    ok('mount ran once', mounts === 1 && unmounts === 0);
    await E.apply('bento', { source: 'user' });
    ok('applying the same layout again does not re-fire layoutchange or re-mount', b.events.length === before + 1 && mounts === 1);
    await E.apply('classic', {});
    ok('leaving a layout unmounts it and fires layoutchange', unmounts === 1 && b.events.length === before + 2 && b.attrs['data-layout'] === 'classic');
    ok('an unknown id applies classic, never throws', (await E.apply('does-not-exist', {})) === 'classic');
    ok('only one layout stylesheet is ever in the DOM',
      Object.keys(b.appended.reduce((m, e) => { if (e.tagName === 'link' && e.id) m[e.id] = 1; return m; }, {})).length >= 1
      && !b.document.getElementById('nbd-layout-css'));
  }
  {
    // a slower apply() must not land after a newer one
    const b = makeBrowser({});
    const ctx = loadEngine(b);
    ctx.LayoutRegistry.register({ id: 'slowpoke', name: 'S', surfaces: ['desktop'], css: 'css/layouts/slow.css' });
    ctx.LayoutRegistry.register({ id: 'quick', name: 'Q', surfaces: ['desktop'], css: 'css/layouts/quick.css' });
    const E = ctx.LayoutEngine;
    await tick(20);
    const p1 = E.apply('slowpoke', {});
    const p2 = E.apply('quick', {});
    await Promise.all([p1, p2]);
    ok('newer apply() supersedes an older one still loading its stylesheet', b.attrs['data-layout'] === 'quick' && E.current().id === 'quick');
  }
  {
    // lazy script: implement() after apply still mounts
    const b = makeBrowser({});
    const ctx = loadEngine(b);
    await tick(20);
    let mounted = 0;
    const p = ctx.LayoutEngine.apply('field', {});   // surface is desktop; apply does not gate on surface (resolve does)
    ctx.LayoutEngine.implement('field', { mount() { mounted++; }, unmount() {} });
    await p;
    ok('implement() before/while loading mounts exactly once', mounted === 1);
    ok('field script injected from /pro/js/layouts/ only', b.appended.some((e) => e.tagName === 'script' && e.src === '/pro/js/layouts/field.js'));
  }
  {
    // hydrate + resolve + cache + save
    const b = makeBrowser({ uid: 'u1', width: 400,
      docs: {
        'userSettings/u1': { layout: { id: 'bento', byDevice: { phone: 'field' } } },
        'companies/u1/settings/layout': { defaultLayout: 'focus', allowed: ['bento', 'field', 'focus'], locked: false },
      } });
    const ctx = loadEngine(b);
    await tick(30);
    ok('hydrate resolves the PHONE choice from byDevice', ctx.LayoutEngine.current().id === 'field' && b.attrs['data-layout'] === 'field');
    const cache = JSON.parse(b.store.nbd_layout_resolved);
    ok('pre-paint cache is written per surface with the uid', cache.uid === 'u1' && cache.byDevice.phone === 'field');
    const prefs = JSON.parse(b.store.nbd_layout_prefs);
    ok('prefs cache holds the raw user + company inputs', prefs.uid === 'u1' && prefs.company.defaultLayout === 'focus');

    const res = await ctx.LayoutEngine.saveUser({ id: null, device: 'phone' });
    const w = b.writes[b.writes.length - 1];
    ok('saveUser writes a MERGE to userSettings/{uid}.layout', w.path === 'userSettings/u1' && w.opt && w.opt.merge === true && w.data.layout);
    ok('a cleared override is written as null (so merge removes it), not omitted',
      w.data.layout.byDevice.phone === null && w.data.layout.byDevice.desktop === null && w.data.layout.id === 'bento');
    ok('clearing the phone override re-resolves to the company default on a phone', res.id === 'focus');
  }
  {
    // a failed company read must not drop a cached lock
    const b = makeBrowser({ uid: 'u2', width: 1280,
      storage: { nbd_layout_prefs: JSON.stringify({ uid: 'u2', user: { id: 'bento' }, company: { defaultLayout: 'focus', locked: true } }) },
      docs: { 'userSettings/u2': { layout: { id: 'bento' } }, 'companies/u2/settings/layout': 'FAIL' } });
    const ctx = loadEngine(b);
    await tick(30);
    ok('company read failed -> cached lock still wins over the user choice', ctx.LayoutEngine.current().id === 'focus'
      && ctx.LayoutEngine.current().source === 'company-lock');
  }
  {
    // another account's cache is forgotten
    const b = makeBrowser({ uid: 'u3',
      storage: { nbd_layout_prefs: JSON.stringify({ uid: 'someone-else', user: { id: 'bento' }, company: { defaultLayout: 'bento', locked: true } }) },
      docs: { 'userSettings/u3': { layout: { id: 'focus' } } } });
    const ctx = loadEngine(b);
    ctx.LayoutRegistry.register({ id: 'focus', name: 'F', surfaces: ['desktop', 'phone', 'tablet'] });
    await tick(30);
    ok('a different uid\'s cached lock never applies to this account', ctx.LayoutEngine.current().id === 'focus');
  }

  console.log('\n3. wiring');
  {
    const html = read('docs/pro/dashboard.html');
    const head = html.slice(0, html.indexOf('</head>'));
    const tagCount = (html.match(/layout-system\.js/g) || []).length;
    ok('layout-system.js is ONE deferred tag, after the head', tagCount === 1
      && /<script defer src="js\/layout-system\.js/.test(html) && html.indexOf('js/layout-system.js') > head.length);
    ok('no second preboot tag: the stamp rides in shape-preboot.js (blocking, in <head>, before the base styles)',
      !/layout-preboot/.test(html) && head.includes('js/shape-preboot.js')
      && head.indexOf('js/shape-preboot.js') < head.indexOf('css/dashboard-app.css')
      && !/<script[^>]*(defer|async)[^>]*shape-preboot/.test(head));
    ok('layout-system.css is linked in <head>', head.includes('css/layout-system.css'));
    const mine = [PREBOOT_SRC, SYS_SRC].join('\n');
    ok('no inline handlers / eval in the layout files',
      !/\son[a-z]+\s*=\s*["']/.test(mine.replace(/s\.onload|s\.onerror|el\.onload/g, '')) && !/\beval\(|new Function\(/.test(mine));
    const css = read('docs/pro/css/layout-system.css');
    ok('--tap: 56px default, 64px for glove',
      /:root\s*\{\s*--tap:\s*56px/.test(css) && /\[data-tap="glove"\]\s*\{\s*--tap:\s*64px/.test(css));
    ok('resolved cache survives sign-out (KEEP set in purgeAccountStorage)',
      /KEEP[\s\S]{0,2500}'nbd_layout_resolved'/.test(read('docs/pro/js/nbd-auth.js')));
    ok('preboot only ever stamps a regex-validated id, and only for a non-classic layout',
      /\[a-z\]\[a-z0-9-\]\{0,31\}/.test(PREBOOT_SRC) && /id === 'classic'/.test(PREBOOT_SRC));
    ok('preboot cache key matches the engine\'s',
      PREBOOT_SRC.includes("'nbd_layout_resolved'") && SYS_SRC.includes("'nbd_layout_resolved'"));
    ok('preboot surface rule matches R.surfaceFor (768 phone / 1180 touch tablet)',
      /w <= 768 \? 'phone'/.test(PREBOOT_SRC) && /w <= 1180 && coarse/.test(PREBOOT_SRC)
      && R.surfaceFor(768, false) === 'phone' && R.surfaceFor(1180, true) === 'tablet');
    // the preboot, run for real
    const run = (cache, width, coarse) => {
      const at = {}; const written = [];
      const ctx = vm.createContext({
        window: { innerWidth: width, matchMedia: () => ({ matches: !!coarse }) },
        document: { readyState: 'loading', documentElement: { setAttribute: (k, v) => { at[k] = v; } }, write: (s) => written.push(s) },
        localStorage: { getItem: (k) => (k === 'nbd_layout_resolved' ? cache : null) },
      });
      ctx.window.document = ctx.document; ctx.window.localStorage = ctx.localStorage;
      vm.runInContext(PREBOOT_SRC, ctx);
      return { at, written };
    };
    const c1 = JSON.stringify({ uid: 'u', byDevice: { phone: 'field', desktop: 'bento' }, glove: true });
    const r1 = run(c1, 400, true);
    ok('preboot: phone stamps data-layout=field, glove, and writes the layout stylesheet link',
      r1.at['data-layout'] === 'field' && r1.at['data-tap'] === 'glove' && r1.written.length === 1
      && /\/pro\/css\/layouts\/field\.css/.test(r1.written[0]));
    const r2 = run(c1, 1400, false);
    ok('preboot: a desktop window gets the desktop entry, not the phone one', r2.at['data-layout'] === 'bento');
    const r3 = run(JSON.stringify({ byDevice: { desktop: 'classic' } }), 1400, false);
    ok('preboot: classic stamps nothing and writes no link', !('data-layout' in r3.at) && r3.written.length === 0);
    const r4 = run(JSON.stringify({ byDevice: { desktop: '"><script>x' } }), 1400, false);
    ok('preboot: a junk id is refused (no attribute, no link)', !('data-layout' in r4.at) && r4.written.length === 0);
    const r5 = run('{not json', 1400, false);
    ok('preboot: corrupt cache is a no-op', Object.keys(r5.at).length === 0 && r5.written.length === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
