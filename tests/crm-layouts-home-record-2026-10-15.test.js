/**
 * tests/crm-layouts-home-record-2026-10-15.test.js — Joe's phone screenshot
 * (installed iPhone app, Island, dark) and the layout audits, fixed in one PR.
 *
 *   1. Record visit: ONE entry point per layout, the same label everywhere
 *      (kit.recordButton run for real; each layout draws it; Island has it as
 *      the dock's primary; Classic/Bento keep the centred floating bar, the
 *      others hide it; Home reserves room under it)
 *   2. no double safe-area: the header alone owns the top inset on the pages
 *      whose header pads for it; the full-screen overlays pad both insets
 *   3. Focus / Inbox / Mission: the phone nav is hidden only while the overlay
 *      is up (kit.setOverlay run for real), and every layout's way out is Menu
 *   4. Mission map rebuild guard: mission.js run in a stub DOM: mount, unmount,
 *      mount builds a NEW map; a null MV.create shows "Map couldn't load" + Retry
 *   5. Pixel World decision: removed from the picker (not registered, the
 *      preboot ignores a stale 'pixel' and asks for no pixel.css)
 *   6. fallback to Classic: a layout whose script never implements it lands on
 *      Classic with source 'fallback' and one toast; the engine boots on
 *      DOMContentLoaded, not when its deferred tag runs
 *   7. tap targets >= 44px and fonts >= 12px in the changed layout CSS
 *   8. Home: the developer warning is console-only; the big-day headline;
 *      the even chip grid
 *
 * Run: node tests/crm-layouts-home-record-2026-10-15.test.js
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
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

const L = (n) => read('docs/pro/js/layouts/' + n + '.js');
const C = (n) => read('docs/pro/css/layouts/' + n + '.css');
const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));

(async () => {
  // ═══ 1. Record visit ═══════════════════════════════════════════════════
  console.log('\n1. Record visit: one entry per layout, one label');
  {
    const b = K.recordButton({ source: 'field', leadId: 'L"1<x>', appointmentId: 'a1', cls: 'fa-rec' });
    ok('kit.recordButton is a [data-nbd-record-visit] button the launcher delegates, with lead/appointment/source',
      /^<button type="button" class="lk-rec fa-rec" data-nbd-record-visit=""/.test(b) && /data-source="field"/.test(b)
      && /data-appointment-id="a1"/.test(b) && /data-lead-id="L&quot;1&lt;x&gt;"/.test(b), b);
    ok('...labelled "Record visit", no inline handler or style', K.RECORD_LABEL === 'Record visit' && />Record visit</.test(b) && !/\son[a-z]+=|style=/.test(b));
    const bare = K.recordButton({});
    ok('...with no lead it attaches none (the recorder asks who)', !/data-lead-id/.test(bare) && !/data-appointment-id/.test(bare));
    const pair = K.recordEntry({ source: 'crew', leadId: 'L9', cls: 'cw-rec' });
    ok('kit.recordEntry = Record visit + Recent visits beside it ([data-nbd-recent-visits]); cls on the pair',
      /^<span class="lk-rec-pair cw-rec"><button type="button" class="lk-rec" data-nbd-record-visit="" data-source="crew" data-lead-id="L9">/.test(pair)
      && /<button type="button" class="lk-recent" data-nbd-recent-visits="" data-source="crew">Recent visits<\/button><\/span>$/.test(pair), pair);
  }
  {
    const want = {
      field: /K\.recordEntry\(\{ source: 'field', leadId: current\.leadId/,
      focus: /K\.recordEntry\(\{ source: 'focus', leadId: it\.id/,
      inbox: /K\.recordEntry\(\{ source: 'inbox', leadId: it\.leadId/,
      mission: /K\.recordEntry\(\{ source: 'mission', leadId: l\.id/,
      crew: /K\.recordEntry\(\{ source: 'crew', leadId: l\.id/,
    };
    Object.keys(want).forEach((id) => ok(id + ' draws Record visit + Recent visits in its own UI, with the lead it is showing', want[id].test(L(id)) && !/K\.recordButton\(/.test(L(id))));
    ok('Mission also has it on a route stop', /K\.recordEntry\(\{ source: 'mission-route', leadId: s\.leadId/.test(L('mission')));
    ok('Island dock: Recent visits sits beside Record', /data-nbd-recent-visits="" data-source="island-dock"/.test(L('island')));
    ok('Field passes the current stop\'s appointment too', /appointmentId: apptIdOf\(current\)/.test(L('field')) && /'appt:'/.test(L('field')));
    const I = require(path.join(ROOT, 'docs/pro/js/layouts/island.js'));
    ok('Island: Record visit is the dock\'s ONE primary action', I.DOCK[0].id === 'record' && I.DOCK.filter((d) => d.primary).length === 1 && I.DOCK[0].primary === true);
    ok('Island dock draws it as a [data-nbd-record-visit] button (not a nav item)', /data-nbd-record-visit="" data-source="island-dock"/.test(L('island')));
    ok('Island hides the floating bar (one bar, not two stacked)', /html\[data-layout="island"\] \.nbd-vr-bar \{ display: none !important; \}/.test(C('island')));
  }
  {
    const lsrc = read('docs/pro/js/visit-recorder-launcher.js');
    const vcss = read('docs/pro/css/visit-recorder.css');
    ok('the launcher says "Record visit" everywhere (no "Record a visit", no "● Record visit")',
      /var RECORD_LABEL = 'Record visit'/.test(lsrc) && !/Record a visit/.test(lsrc) && !/● Record visit/.test(lsrc));
    ok('the floating bar is Classic and Bento only', /var BAR_LAYOUTS = \{ classic: 1, bento: 1 \}/.test(lsrc) && /show = [^;]*layoutWantsBar\(\)/.test(lsrc));
    ['island', 'field', 'focus', 'inbox', 'mission', 'crew'].forEach((id) =>
      ok('visit-recorder.css hides the bar under ' + id, new RegExp('html\\[data-layout="' + id + '"\\] \\.nbd-vr-bar').test(vcss)));
    ok('the bar is centred', /\.nbd-vr-bar\{[^}]*justify-content:center/.test(vcss) && /min-width:769px\)\{\s*\.nbd-vr-bar\{ left:24px; right:24px;/.test(vcss));
    ok('Home reserves room under the bar while it shows (no card under it)',
      /classList\.toggle\('nbd-vr-bar-on', show\)/.test(lsrc) && /html\.nbd-vr-bar-on #view-home \.view-scroll\{ padding-bottom:calc\(74px/.test(vcss));
    ok('the bar follows a layout switch', /addEventListener\('layoutchange', paintBar\)/.test(lsrc));
    ok('Recent visits: delegated, and it loads the recorder first (the Record path) before NBDVisitRecorderUI.openRecent()',
      /closest\('\[data-nbd-recent-visits\]'\)[\s\S]{0,80}openRecent\(\)/.test(lsrc)
      && /function openRecent\(\) \{\s*return load\(\)\.then\(function \(\) \{\s*var UI = window\.NBDVisitRecorderUI;\s*if \(UI && typeof UI\.openRecent === 'function'\) \{ UI\.openRecent\(\); return; \}/.test(lsrc)
      && /openRecent: openRecent/.test(lsrc));
    ok('the bar stylesheet is re-versioned (and only it)', /BAR_CSS = '\/pro\/css\/visit-recorder\.css\?v=([3-9]|[1-9]\d)(?!\d)'/.test(lsrc)   /* >= 3: 4 since the phone Home clearance fix (2026-10-21) */ && /visit-recorder-ui\.js\?v=' \+ V/.test(lsrc));
  }
  {
    // the launcher's bar, run for real in a stub page: Classic shows it, Island does not
    function runLauncher(layout) {
      const attrs = {}; const cls = new Set();
      const mk = (tag) => {
        const e = { tagName: tag, hidden: false, children: [], attrs: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
          appendChild(c) { this.children.push(c); return c; }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
        return e;
      };
      const home = mk('div'); home.classList.contains = (c) => c === 'active';
      const docEl = { getAttribute: (k) => (k === 'data-layout' ? layout : (attrs[k] == null ? null : attrs[k])), setAttribute: (k, v) => { attrs[k] = v; },
        classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) } };
      const body = mk('body'); const head = mk('head');
      const document = { readyState: 'complete', documentElement: docEl, body, head,
        getElementById: (id) => (id === 'view-home' ? home : null), createElement: mk, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
      const win = { document, location: { search: '', pathname: '/pro/dashboard', href: 'https://x/pro/dashboard', hash: '' }, localStorage: { getItem: () => null, setItem() {} },
        addEventListener() {}, setTimeout: () => 0, URLSearchParams, URL, console };
      win.window = win;
      vm.runInContext(read('docs/pro/js/visit-recorder-launcher.js'), vm.createContext(win));
      const bar = body.children.find((c) => c.className === 'nbd-vr-bar');
      return { bar, cls };
    }
    const classic = runLauncher(null);
    const recBtn = classic.bar && classic.bar.children[0];
    ok('run: Classic Home shows the bar, labelled Record visit, and reserves room under it',
      classic.bar && classic.bar.hidden === false && recBtn.children[1].textContent === 'Record visit' && classic.cls.has('nbd-vr-bar-on'));
    ok('run: Recent visits sits beside Record on the bar', classic.bar.children[1].textContent === 'Recent visits' && 'data-nbd-recent-visits' in classic.bar.children[1].attrs);
    const bento = runLauncher('bento');
    ok('run: Bento shows it too', bento.bar && bento.bar.hidden === false);
    const island = runLauncher('island');
    ok('run: Island hides it and reserves nothing (its dock has Record visit)', island.bar && island.bar.hidden === true && !island.cls.has('nbd-vr-bar-on'));
  }

  // ═══ 2. safe area ══════════════════════════════════════════════════════
  console.log('\n2. no double safe-area');
  {
    const sc = read('docs/pro/js/standalone-compat.js');
    ok('standalone-compat pads <body> for the top inset ONLY when the page header does not own it',
      /const headerOwnsTop = document\.documentElement\.getAttribute\('data-safe-top'\) === 'header'/.test(sc)
      && /\$\{headerOwnsTop \? '' : 'body\{ padding-top: env\(safe-area-inset-top\); \}'\}/.test(sc));
    ['dashboard', 'customer'].forEach((p) => ok(p + '.html says its header owns the top inset', /<html lang="en" data-theme="nbd-original" data-safe-top="header">/.test(read('docs/pro/' + p + '.html'))));
    ok('...and its header really does pad for it (dashboard-app.css)', /header\s*\{\s*padding-top:\s*env\(safe-area-inset-top/.test(read('docs/pro/css/dashboard-app.css')));
    ok('...customer.html header too', /padding-top:env\(safe-area-inset-top, 0px\);/.test(read('docs/pro/customer.html')));
    ['analytics', 'ask-joe', 'login', 'onboarding', 'register'].forEach((p) =>
      ok(p + '.html (no inset header) keeps the body padding, on a bumped tag', !/data-safe-top/.test(read('docs/pro/' + p + '.html')) && /standalone-compat\.js\?v=2/.test(read('docs/pro/' + p + '.html'))));
    const insets = { field: '.fa-scroll', focus: '.fo-wrap', inbox: '.ib-wrap', mission: '.mc-top', crew: '.cw-wrap' };
    Object.keys(insets).forEach((id) => {
      const css = C(id);
      const sel = insets[id].replace('.', '\\.');
      const rule = (css.match(new RegExp('html\\[data-layout="' + id + '"\\] ' + sel + ' \\{[^}]*\\}')) || [''])[0];
      const bottom = id === 'mission' ? /\.mc-wrap \{[^}]*safe-area-inset-bottom/.test(css) : /safe-area-inset-bottom/.test(rule);
      ok(id + ' ' + insets[id] + ' pads the top inset' + (id === 'mission' ? ' (and .mc-wrap the bottom)' : ' and the bottom inset'), /safe-area-inset-top/.test(rule) && bottom, rule);
    });
  }

  // ═══ 3. no dead ends ═══════════════════════════════════════════════════
  console.log('\n3. the way out is Menu, the way back is the phone nav');
  {
    ['focus', 'inbox', 'mission'].forEach((id) => ok(id + '.css no longer hides #mobile-nav on every view', !/#mobile-nav\s*\{\s*display:\s*none/.test(C(id))));
    ok('kit.css hides the phone nav only while a layout overlay is up', /html\.lk-overlay-on #mobile-nav \{ display: none !important; \}/.test(C('kit')));
    ['focus', 'inbox', 'mission', 'crew', 'field'].forEach((id) => ok(id + ' shows/hides its overlay through kit.setOverlay and clears it on unmount',
      /K\.setOverlay\(rootEl, homeActive\(\)\)/.test(L(id)) && /K\.clearOverlay\(\)/.test(L(id)) && !/rootEl\.hidden = !homeActive\(\)/.test(L(id))));
    // run it: the class follows the overlay
    const cls = new Set();
    const win = { document: { documentElement: { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } } } };
    win.window = win;
    const ctx = vm.createContext(win);
    vm.runInContext(read('docs/pro/js/layouts/kit.js'), ctx);
    const el = { hidden: true };
    ctx.NBDLayoutKit.setOverlay(el, true);
    const shownOn = el.hidden === false && cls.has('lk-overlay-on');
    ctx.NBDLayoutKit.setOverlay(el, false);   // Menu > Pipeline: Home is not the view
    const hiddenOff = el.hidden === true && !cls.has('lk-overlay-on');
    ctx.NBDLayoutKit.setOverlay(el, true); ctx.NBDLayoutKit.clearOverlay();
    ok('run: overlay up -> nav hidden; another view -> nav back; unmount -> nav back', shownOn && hiddenOff && !cls.has('lk-overlay-on'));
    const menu = K.menuItems('fo');
    ok('one Menu: Pipeline, Schedule, Map, Call Center, Settings, in the layout\'s own delegated attribute',
      (menu.match(/data-fo="goto"/g) || []).length === 5 && /data-to="crm">Pipeline</.test(menu) && /data-to="d2d">Map</.test(menu) && /data-to="calls">Call Center</.test(menu));
    ['focus', 'inbox', 'crew', 'mission', 'field'].forEach((id) => ok(id + ' uses the shared Menu', new RegExp("K\\.menuItems\\('" + ({ focus: 'fo', inbox: 'ib', crew: 'cw', mission: 'mc', field: 'fa' })[id] + "'\\)").test(L(id))));
    ok('Field\'s last tab is "Menu" (was "Me", straight to Settings)', /\{ id: 'menu', label: 'Menu', icon: 'menu' \}/.test(L('field')) && !/label: 'Me'/.test(L('field')));
    ok('Mission: Menu holds "Leave Mission Control" (was the bare "Switch back")', /data-mc="back">Leave Mission Control</.test(L('mission')) && !/>Switch back</.test(L('mission')));
    ok('"Map" is the door-knock map everywhere (Bento\'s tile went to goTo(\'map\'))', !/data-bn-goto="map"/.test(L('bento')) && /nav: 'd2d',\s+about: 'One tap to the map\.'/.test(L('bento')) && /map: 'd2d'/.test(L('field')));
    ok('Crew\'s drawer sits above the phone nav (z 1900)', /\.cw-drawer \{[^}]*z-index: 1951/.test(C('crew')) && /\.cw-scrim \{[^}]*z-index: 1950/.test(C('crew')));
  }

  // ═══ 4. Mission map rebuild ════════════════════════════════════════════
  console.log('\n4. Mission Control map: rebuilt after an unmount, honest when it fails');
  {
    const src = L('mission');
    ok('the guard is an in-flight flag, not the ever-growing mapSeq', /if \(map \|\| mapLoading\) return;/.test(src) && !/if \(map \|\| mapSeq\) return/.test(src));
    ok('unmount resets the flag', /mapSeq\+\+;[^\n]*\n\s*mapLoading = false;/.test(src));

    // run mission.js in a stub DOM
    function makeEnv(createResult) {
      const creates = []; let impl = null; const cls = new Set();
      function el(tag) {
        const e = { tagName: tag, attrs: {}, children: [], hidden: false, _html: '', parentNode: null, slots: {}, className: '',
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, contains: () => true,
          appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
          removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
          replaceChild(n, o) { n.parentNode = this; o.parentNode = null; if (this === root && o === root.mapEl) root.mapEl = n; return o; },
          querySelector(sel) {
            if (sel === '.mc-map') return this.mapEl || null;
            const m = /^\[data-mc-slot="([a-z]+)"\]$/.exec(sel);
            if (m) { this.slots[m[1]] = this.slots[m[1]] || el('div'); return this.slots[m[1]]; }
            return null;
          },
          querySelectorAll: () => [] };
        Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); if (this.className === 'mc-root' && /mc-map/.test(v)) { this.mapEl = el('div'); this.mapEl.className = 'mc-map'; this.mapEl.parentNode = this; } } });
        return e;
      }
      let root = null;
      const document = {
        documentElement: { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } },
        body: { appendChild(c) { root = c; c.parentNode = document.body; return c; }, removeChild(c) { if (root === c) root = null; } },
        createElement: (t) => el(t), querySelector: (s) => (s === '.view.active' ? { id: 'view-home' } : null), hidden: false, activeElement: null,
      };
      const inst = () => ({ on() {}, setPins() {}, setSwaths() {}, setRoutes() {}, fit() {}, select() {}, invalidate() {}, destroy() { this.destroyed = true; } });
      const anyArr = new Proxy({}, { get: (t, k) => (k === 'leadCenter' ? () => null : () => []) });
      const win = {
        document, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, addEventListener() {}, removeEventListener() {},
        _leads: [], _leadsLoaded: false, Promise,
        NBDLayoutKit: null, NBDMissionLogic: anyArr, NBDRoutePlan: anyArr,
        NBDMapView: { create(elx) { creates.push(elx); return Promise.resolve(typeof createResult === 'function' ? createResult(creates.length) : inst()); }, levelForHail: () => 'warn' },
        LayoutEngine: { implement(id, i) { impl = i; }, resolve: () => ({ id: 'mission' }), apply() {}, refresh() {} },
      };
      win.window = win;
      const ctx = vm.createContext(win);
      vm.runInContext(read('docs/pro/js/layouts/kit.js'), ctx);
      vm.runInContext(src, ctx);
      return { impl: () => impl, creates, root: () => root, cls };
    }
    const env = makeEnv();
    env.impl().mount();
    await tick(10);
    const first = env.creates.length;
    env.impl().unmount();
    env.impl().mount();
    await tick(10);
    ok('run: mount, unmount, mount builds a second map (it was never rebuilt)', first === 1 && env.creates.length === 2, 'creates=' + env.creates.length);
    ok('run: the overlay class is set while Mission is on Home', env.cls.has('lk-overlay-on'));
    env.impl().unmount();
    ok('run: and cleared on unmount', !env.cls.has('lk-overlay-on'));
    // unmounted while the first create() is still in flight (a quick layout switch)
    const fast = makeEnv();
    fast.impl().mount();
    fast.impl().unmount();
    fast.impl().mount();
    await tick(10);
    ok('run: unmount mid-load, then mount again: a new map is built', fast.creates.length === 2, 'creates=' + fast.creates.length);
    fast.impl().unmount();

    const failEnv = makeEnv((n) => (n === 1 ? null : { on() {}, setPins() {}, setSwaths() {}, setRoutes() {}, fit() {}, select() {}, invalidate() {}, destroy() {} }));
    failEnv.impl().mount();
    await tick(10);
    const mapEl = failEnv.root().mapEl;
    ok('run: MV.create() returning null shows "Map couldn\'t load" with Retry', /Map couldn&#39;t load|Map couldn't load/.test(mapEl.innerHTML) && /data-mc="map-retry">Retry</.test(mapEl.innerHTML), mapEl.innerHTML);
    ok('Retry builds into a fresh container and tries again', /if \(a === 'map-retry'\)[\s\S]{0,400}replaceChild\(fresh, old\)[\s\S]{0,40}ensureMap\(\)/.test(src));
    failEnv.impl().unmount();

    ok('Day route: an empty day turns the Leads layer on (unless the rep set layers) and says how to add a stop',
      /if \(!routeStops\(\)\.length && !S\.route\.layersTouched\) S\.route\.layers\.leads = true;/.test(src) && /Tap a customer on the map \(the Leads layer shows them\)/.test(src));
    ok('the tabs scroll instead of widening the bar', /\.mc-tabs \{[^}]*overflow-x: auto/.test(C('mission')));
  }

  // ═══ 5. Pixel World ════════════════════════════════════════════════════
  console.log('\n5. Pixel World: removed from the picker (the smaller safe change)');
  {
    const px = read('docs/pro/js/pixel-mode.js');
    ok('pixel-mode.js no longer registers a layout', !/LayoutRegistry/.test(px.replace(/\/\*[\s\S]*?\*\//g, '')) && !/id: 'pixel'/.test(px));
    const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
    ok('the registry has no pixel layout, so the picker cannot offer one', R.get('pixel') === null && !R.list().some((d) => d.id === 'pixel'));
    ok('Pixel World is still opened from its Settings card (NBDPixelMode.open)', /open: function \(\) \{ return viaCore\('open'\); \}/.test(px));
    const PRE = read('docs/pro/js/shape-preboot.js');
    const at = {}; const written = [];
    const ctx = vm.createContext({
      window: { innerWidth: 390, matchMedia: () => ({ matches: true }) },
      document: { readyState: 'loading', documentElement: { setAttribute: (k, v) => { at[k] = v; } }, write: (s) => written.push(s) },
      localStorage: { getItem: (k) => (k === 'nbd_layout_resolved' ? JSON.stringify({ byDevice: { phone: 'pixel' } }) : null) },
    });
    ctx.window.document = ctx.document; ctx.window.localStorage = ctx.localStorage;
    vm.runInContext(PRE, ctx);
    ok('run: a stale cached "pixel" paints Classic and asks for no missing pixel.css', !('data-layout' in at) && written.length === 0, JSON.stringify({ at, written }));
  }

  // ═══ 6. fallback + boot ════════════════════════════════════════════════
  console.log('\n6. a layout that fails to load falls back to Classic; boot waits for DOMContentLoaded');
  function browser(readyState) {
    const attrs = {}; const listeners = {}; const winL = {}; const toasts = [];
    const documentElement = { setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; }, removeAttribute(k) { delete attrs[k]; } };
    const document = {
      readyState, documentElement,
      head: { appendChild(e) { e.parentNode = { removeChild() {} }; if (e.tagName === 'link') setTimeout(() => (e._l.load || []).forEach((f) => f()), 0); if (e.tagName === 'script') setTimeout(() => e.onload && e.onload(), 0); } },
      createElement(tag) { return { tagName: tag, _l: {}, setAttribute(k, v) { this['@' + k] = v; }, getAttribute(k) { return this['@' + k] === undefined ? null : this['@' + k]; }, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } }; },
      getElementById() { return null; },
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      dispatchEvent() { return true; },
    };
    const win = { document, innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener(t, f) { (winL[t] = winL[t] || []).push(f); },
      setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} }, CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
      showToast: (m, t) => toasts.push([m, t]), console: { warn() {}, log() {} } };
    win.window = win;
    const ctx = vm.createContext(Object.assign({}, win, { navigator: {} }));
    ctx.window = ctx;
    return { ctx, attrs, listeners, winL, toasts };
  }
  {
    const b = browser('complete');
    vm.runInContext(read('docs/pro/js/layout-system.js'), b.ctx);
    b.ctx.LayoutRegistry.register({ id: 'broken', name: 'Broken Layout', surfaces: ['desktop'], script: 'js/layouts/broken.js', css: 'css/layouts/broken.css' });
    await tick(10);
    const id = await b.ctx.LayoutEngine.apply('broken', { source: 'user' });
    ok('run: a layout whose script never implements it lands on Classic with source "fallback"',
      id === 'classic' && b.attrs['data-layout'] === 'classic' && b.ctx.LayoutEngine.current().source === 'fallback', JSON.stringify(b.ctx.LayoutEngine.current()));
    await b.ctx.LayoutEngine.apply('broken', { source: 'user' });
    ok('run: one toast, naming the layout, not one per retry', b.toasts.length === 1 && /Broken Layout didn't load/.test(b.toasts[0][0]) && b.toasts[0][1] === 'error', JSON.stringify(b.toasts));
    b.ctx.LayoutRegistry.register({ id: 'good', name: 'Good', surfaces: ['desktop'], script: 'js/layouts/good.js' });
    b.ctx.LayoutEngine.implement('good', { mount() {}, unmount() {} });
    ok('run: a layout that did implement itself still applies', (await b.ctx.LayoutEngine.apply('good', {})) === 'good');
  }
  {
    const b = browser('interactive');   // a deferred tag mid-list
    vm.runInContext(read('docs/pro/js/layout-system.js'), b.ctx);
    await tick(10);
    const before = b.attrs['data-layout'];
    (b.listeners.DOMContentLoaded || []).forEach((f) => f());
    await tick(10);
    ok('run: the engine boots on DOMContentLoaded, not when its deferred tag runs', before === undefined && b.attrs['data-layout'] === 'classic', String(before));
    (b.winL.load || []).forEach((f) => f());
    ok('run: the load backstop does not boot it twice', (b.listeners.DOMContentLoaded || []).length === 1 && (b.winL.load || []).length === 1);
  }

  // ═══ 7. tap targets + fonts ════════════════════════════════════════════
  console.log('\n7. tap targets >= 44px, fonts >= 12px in the changed CSS');
  {
    const files = ['bento', 'inbox', 'island', 'mission', 'crew', 'picker', 'field', 'kit', 'focus', 'mapview'];
    files.forEach((f) => {
      const small = (C(f).match(/font-size:\s*(\d+(?:\.\d+)?)px/g) || []).filter((m) => parseFloat(m.replace(/[^\d.]/g, '')) < 12);
      ok(f + '.css: no font under 12px', small.length === 0, small.join(' | '));
    });
    const target = (file, sel, prop) => {
      const css = C(file);
      const i = css.indexOf(sel + ' {') !== -1 ? css.indexOf(sel + ' {') : css.indexOf(sel + ',');
      const body = i === -1 ? '' : css.slice(i, css.indexOf('}', i));
      const m = new RegExp(prop + ':\\s*(\\d+)px').exec(body);
      return m ? Number(m[1]) : NaN;
    };
    const checks = [
      ['bento', 'html[data-layout="bento"] .bn-btn', 'min-height'], ['bento', 'html[data-layout="bento"] .bn-open', 'height'],
      ['bento', 'html[data-layout="bento"] .bn-go', 'min-height'], ['bento', 'html[data-layout="bento"] .bn-tbtn', 'min-height'],
      ['inbox', 'html[data-layout="inbox"] .ib-tab', 'min-height'], ['inbox', 'html[data-layout="inbox"] .ib-sheet button', 'min-height'],
      ['inbox', 'html[data-layout="inbox"] .ib-folder', 'min-height'],
      ['island', 'html[data-layout="island"] .isl-lane', 'min-height'],
      ['mission', 'html[data-layout="mission"] .mc-btn', 'min-height'],   // the rule shared by .mc-tab, .mc-btn ['mission', 'html[data-layout="mission"] .mc-rep input', 'min-height'],
      ['mission', 'html[data-layout="mission"] .mc-layer', 'min-height'],
      ['crew', 'html[data-layout="crew"] .cw-x', 'height'], ['crew', 'html[data-layout="crew"] .cw-grip', 'min-height'], ['crew', 'html[data-layout="crew"] .cw-stop-nav', 'min-height'],
      ['picker', '.lp-dev', 'min-height'], ['picker', '.lp-btn', 'min-height'], ['picker', '.lp-select', 'min-height'],
      ['mapview', '.nbd-mv .leaflet-touch .leaflet-bar a', 'height'],   // the zoom-size rule (touch and mouse)
    ];
    checks.forEach(([f, sel, prop]) => { const v = target(f, sel, prop); ok(f + ': ' + sel.replace(/^html\[data-layout="[a-z]+"\] /, '') + ' ' + prop + ' >= 44px', v >= 44, String(v)); });
    ok('island.css: glass edges/shadows are tokens, no #ffffff / #000000', !/#ffffff|#000000/i.test(C('island')) && /--isl-edge: var\(--t\)/.test(C('island')));
    ok('Island: the pill is sticky; the phone body drops the hidden nav\'s 62px; views without .view-scroll get dock room',
      /\.isl-pill \{[^}]*position: sticky/.test(C('island')) && /html\[data-layout="island"\] body \{ padding-bottom: calc\(var\(--nbd-bottom-chrome, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\) !important; \}/.test(C('island'))
      && /\.view\.active:not\(:has\(> \.view-scroll\)\)/.test(C('island')));
    ok('Island: the Pipeline wait interval is tracked and cleared on unmount', /pipeTimer = setInterval/.test(L('island')) && /stopPipelineWait\(\);\s*\n\s*listeners\.forEach/.test(L('island')));
    const row = K.card({ id: 'L1', name: 'Pat' }, { density: 'row', link: false });
    ok('Field: a row inside a <button> has no <a> (kit card link:false)', !/<a\b/.test(row) && /lk-open/.test(row) && (L('field').match(/density: 'row', link: false/g) || []).length === 2);
    ok('Bento: a loading state instead of "0" before the leads load; Reset asks first',
      /if \(W\._leadsLoaded !== true\) \{\s*el\.innerHTML = '<div class="bn-note" role="status">Loading your customers…<\/div>'/.test(L('bento')) && /ask\('Reset your board\?/.test(L('bento')));
    ok('island-job: ij-has-hero follows the hero\'s visibility', /MutationObserver\(syncHeroClass\)\.observe\(hero, \{ attributes: true, attributeFilter: \['style'/.test(read('docs/pro/js/layouts/island-job.js')));
    const pk = L('picker');
    ok('Picker: Try it opens Home and only on this screen; cards for crew, island, inbox; no stale "on the way" copy',
      /goView\('home'\)/.test(pk) && /\(off \|\| current \|\| !here \? ' disabled' : ''\)/.test(pk) && /state\.device !== E\.surface\(\)\) return;/.test(pk)
      && /\n\s+crew: '<rect/.test(pk) && /\n\s+island: '<rect/.test(pk) && /\n\s+inbox: '<rect/.test(pk) && /\n\s+crew: 'Your crews/.test(pk) && !/More layouts are on the way/.test(pk));
    const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
    const isl = R.get('island');
    ok('Island registers version / surfaces / tier like the rest', /id: 'island', name: 'Island Dock', version: 1,/.test(read('docs/pro/js/layout-system.js')) && isl.surfaces.length === 3 && isl.tier === 'free');
    ok('Crew: no stale "route map joins this view" copy', !/joins this view/.test(L('crew')) && !/waits for the shared MapView/.test(L('crew')));
  }

  // ═══ 8. Home ═══════════════════════════════════════════════════════════
  console.log('\n8. Home');
  {
    const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
    const logged = [];
    const origInfo = console.info; console.info = (m) => logged.push(m);
    const html = HA.stripHtml({ oldCapped: true, oldCap: 300 });
    HA.stripHtml({ oldCapped: true, oldCap: 300 });
    console.info = origInfo;
    ok('the developer warning is gone from the owner\'s strip', !/45-day window/.test(html) && !/newest 300/.test(html), html);
    ok('...and logged to the console once', logged.length === 1 && /hit its cap of 300/.test(logged[0]));
    ok('a FAILED old read still shows', /NOT an all-clear/.test(HA.stripHtml({ oldFailed: true })));
    const th = read('docs/pro/js/today-home.js');
    ok('Today says it plainly: "Some older calls aren\'t shown here."', /Some older calls aren\\'t shown here\./.test(th) && !/older open promises may not be listed/.test(th));
    // big day: run bigDay through the exported hook
    const m = /var BIG_DAY = 25;\n  function bigDay\(p\) \{[\s\S]*?\n  \}\n/.exec(th);
    const bigDay = vm.runInNewContext(m[0] + '; bigDay;');
    const p = { total: 100, stalled: new Array(88) };
    const r = bigDay(p);
    ok('"100 things today" (a true count, not a cap) reads "Today: 12 to do" with the rest named, nothing re-counted',
      r.title === 'Today: 12 to do' && /88 overdue follow-ups in Stalled leads below \(100 in all\)/.test(r.sub) && p.total === 100, JSON.stringify(r));
    ok('a normal day keeps "N things today"', bigDay({ total: 7, stalled: [1, 2] }) === null && bigDay({ total: 30, stalled: [] }) === null);
    ok('an all-follow-ups day says so', bigDay({ total: 30, stalled: new Array(30) }).title === 'Today: 30 overdue follow-ups');
    ok('the headline keeps data-tp-total = the full count', /data-tp-total="' \+ p\.total \+ '"/.test(th) && /big \? big\.title : P\.headline\(p\.total\)/.test(th));
    const tcss = read('docs/pro/css/today-home.css');
    ok('the chips are an even grid (two columns on a phone) before the alldup rule',
      /#homeAttention\.ha-strip:not\(\[hidden\]\)\{display:grid;/.test(tcss) && /#homeAttention\.ha-strip:not\(\[hidden\]\)\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);\}/.test(tcss)
      && tcss.indexOf('#homeAttention.ha-strip:not([hidden]){display:grid') < tcss.indexOf('[data-ha-alldup="1"]'));
    ok('the welcome row sits on the cards\' edges with a 44px button', /#view-home \.view-scroll > \.page-hdr\{width:100%;margin-left:0;margin-right:0;padding-left:0;padding-right:0;/.test(tcss) && /\.home-hdr-acts > \.btn\{min-height:44px;/.test(tcss));
    const dash = read('docs/pro/dashboard.html');
    ok('dashboard tags are re-versioned for the files changed',
      /today-home\.css\?v=6/.test(dash) && /home-attention\.js\?v=(2[3-9]|[3-9]\d)(?!\d)/.test(dash)   /* >= 23: 24 since the app badge (2026-10-16) */ && /today-home\.js\?v=(1[6-9]|[2-9]\d)(?!\d)/.test(dash)   /* >= 16: 17 since the closes-this-week kick (2026-10-15) */ && /layout-system\.js\?v=([2-9]|[1-9]\d)(?!\d)/.test(dash)   /* >= 2: 3 since the fail-closed hydrate (layouts audit D14, 2026-10-15) */
      && /pixel-mode\.js\?v=2/.test(dash) && /visit-recorder-launcher\.js\?v=([2-9]|[1-9]\d)(?!\d)/.test(dash)   /* >= 2: 3 since the phone Home clearance fix (2026-10-21) */ && /shape-preboot\.js\?v=([3-9]|[1-9]\d)(?!\d)/.test(dash)   /* >= 3: 4 since per-layout button size (2026-10-16) */ && /standalone-compat\.js\?v=2/.test(dash));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);   // the engine's boot poll would otherwise hold the process open
})().catch((e) => { console.error(e); process.exit(1); });
