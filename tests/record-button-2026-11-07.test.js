/**
 * tests/record-button-2026-11-07.test.js - the round record button that
 * replaced the visit-recorder pill bar over Home (#nbd-vr-bar), which covered
 * the Today list's Attach / Keep / Discard buttons.
 *
 *   documentation/projects/RECORD-BUTTON-2026-11-07.md
 *
 * Runs the REAL docs/pro/js/visit-recorder-launcher.js and
 * docs/pro/js/visit-recorder-menu.js together in a small fake DOM (no jsdom in
 * this repo) and drives them like a person: tap the button, read the menu,
 * move with the arrow keys, close it every way the spec names, and pick each
 * of the old bar's three actions (Record visit, Recent visits, Unfiled visits)
 * to prove each still reaches the recorder. Then static checks on the CSS
 * (placement, hiding, tokens), the FAB coordinator and the boot budget.
 *
 * Run: node tests/record-button-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

// ── a small fake DOM: enough for the launcher and the menu ──────────────────
function makeDom() {
  const docListeners = { true: {}, false: {} };
  const document = { readyState: 'complete', activeElement: null };
  function matches(el, sel) {
    if (!el || !el.attrs) return false;
    let m;
    if ((m = /^\.([\w-]+)$/.exec(sel))) return el.className.split(/\s+/).indexOf(m[1]) >= 0;
    if ((m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel))) return el.getAttribute(m[1]) === m[2];
    if ((m = /^\[([\w-]+)\]$/.exec(sel))) return el.hasAttribute(m[1]);
    if ((m = /^#([\w-]+)$/.exec(sel))) return el.id === m[1];
    return false;   // anything fancier: no match (the decorators look for rows this page does not have)
  }
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
      this.className = ''; this._text = ''; this.hidden = false; this.id = ''; this.listeners = {}; this.type = '';
      const self = this;
      this.classList = {
        add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
        remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); return on; },
        contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
      };
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    get isConnected() { let n = this; while (n) { if (n === document.body) return true; n = n.parentNode; } return false; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      const i = ref ? this.children.indexOf(ref) : -1;
      c.parentNode = this;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
    contains(o) { while (o) { if (o === this) return true; o = o.parentNode; } return false; }
    closest(sel) { let n = this; while (n && n.attrs) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) { const out = []; (function walk(n) { n.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); }); })(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    focus() { document.activeElement = this; }
  }
  document.createElement = (t) => new El(t);
  document.body = new El('body');
  document.head = new El('head');
  document.documentElement = new El('html');
  document.addEventListener = (t, fn, opt) => { const cap = !!(opt === true || (opt && opt.capture)); (docListeners[cap][t] = docListeners[cap][t] || []).push(fn); };
  document.removeEventListener = (t, fn, opt) => { const cap = !!(opt === true || (opt && opt.capture)); docListeners[cap][t] = (docListeners[cap][t] || []).filter((f) => f !== fn); };
  document.getElementById = (id) => { const all = [document.body, ...document.body.querySelectorAll('#' + id)]; return all.find((e) => e.id === id) || null; };
  document.querySelector = (sel) => document.body.querySelector(sel) || document.head.querySelector(sel);
  document.querySelectorAll = (sel) => document.body.querySelectorAll(sel).concat(document.head.querySelectorAll(sel));
  /** Dispatch like a browser: document capture, then target and its ancestors, then document bubble. */
  function fire(target, type, init) {
    const ev = Object.assign({ type, target, defaultPrevented: false, _stop: false }, init || {});
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => { ev._stop = true; };
    (docListeners.true[type] || []).slice().forEach((fn) => { if (!ev._stop) fn(ev); });
    let n = target;
    while (n && !ev._stop) { (n.listeners[type] || []).slice().forEach((fn) => fn(ev)); n = n.parentNode; }
    if (!ev._stop) (docListeners.false[type] || []).slice().forEach((fn) => fn(ev));
    return ev;
  }
  return { document, El, fire };
}

/** Boot the real launcher + menu in a fake dashboard. */
function boot(opts) {
  opts = opts || {};
  const { document, fire } = makeDom();
  if (opts.layout) document.documentElement.setAttribute('data-layout', opts.layout);
  if (opts.home !== false) {
    const home = document.createElement('div'); home.id = 'view-home'; home.className = 'view active';
    document.body.appendChild(home);
  }
  const other = document.createElement('button'); other.id = 'today-attach'; other.textContent = 'Attach';
  document.body.appendChild(other);
  const store = { nbd_vr_unfiled: String(opts.unfiled == null ? 2 : opts.unfiled) };
  const calls = [];
  const win = {
    document, console, URL, URLSearchParams, Promise,
    location: { search: '', pathname: opts.path || '/pro/dashboard', href: 'https://x' + (opts.path || '/pro/dashboard'), hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    addEventListener() {}, setTimeout: () => 0,
    showToast: (m, tone) => calls.push(['toast', m, tone]),
    // the recorder is already loaded (its idle preload ran), so load() resolves at once
    NBDVisitRecorder: { getState: () => ({ active: false }), subscribe() {}, wire() {}, refreshConfig() {} },
    NBDVisitRecorderUI: {
      begin: (o) => { calls.push(['begin', o]); return null; },
      openRecent: () => calls.push(['openRecent']),
      openUnfiled: () => calls.push(['openUnfiled']),
    },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/visit-recorder-launcher.js'), 'utf8'), ctx, { filename: 'visit-recorder-launcher.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/visit-recorder-menu.js'), 'utf8'), ctx, { filename: 'visit-recorder-menu.js' });
  const fab = document.getElementById('nbd-vr-fab');
  const btn = fab && fab.querySelector('.nbd-vr-fabbtn');
  const badge = fab && fab.querySelector('.nbd-vr-fabbadge');
  const menu = () => document.getElementById('nbd-vr-menu');
  const items = () => (menu() ? menu().querySelectorAll('[role="menuitem"]') : []);
  const dim = () => document.body.querySelector('.nbd-vr-dim');
  const isOpen = () => !!(menu() && !menu().hidden);
  const tick = () => new Promise((r) => setImmediate(r));
  async function tap(el) { fire(el, 'pointerdown'); fire(el, 'click'); await tick(); await tick(); }
  const key = (k, el) => fire(el || document.activeElement, 'keydown', { key: k });
  return { win, document, fire, fab, btn, badge, menu, items, dim, isOpen, tap, key, calls, store, other, label: (el) => el.textContent.trim() };
}

(async () => {
  console.log('\n1. the button (boot launcher)');
  {
    const P = boot();
    ok('Classic Home mounts one round button (#nbd-vr-fab), shown', P.fab && P.fab.hidden === false && P.btn && P.fab.children.length === 1);
    ok('it is a menu button: aria-haspopup="menu", aria-expanded="false"', P.btn.getAttribute('aria-haspopup') === 'menu' && P.btn.getAttribute('aria-expanded') === 'false');
    ok('no label, no mic: a record dot and the badge only', P.btn.querySelector('.nbd-vr-fabdot') && !/Record|Mic/i.test(P.btn.textContent), P.btn.textContent);
    ok('closed, the badge shows the unfiled count (2)', P.badge.hidden === false && P.badge.textContent === '2');
    ok('screen readers hear the count on the button', P.btn.getAttribute('aria-label') === 'Visits, 2 unfiled', P.btn.getAttribute('aria-label'));
    ok('the old pill bar is gone', !P.document.getElementById('nbd-vr-bar'));
    ok('the menu is NOT built at boot (it is the lazy file\'s job)', !P.menu());
    P.store.nbd_vr_unfiled = '0'; P.win.NBDVisitRecorderLauncher.paint();
    ok('no badge at zero, and the label drops the count', P.badge.hidden === true && P.btn.getAttribute('aria-label') === 'Visits');
  }
  {
    const P = boot({ layout: 'bento' });
    ok('Bento shows it too', P.fab && P.fab.hidden === false);
    ['island', 'field', 'focus', 'inbox', 'mission', 'crew'].forEach((id) => {
      const Q = boot({ layout: id });
      ok(id + ' hides it (that layout has its own Record entry)', Q.fab && Q.fab.hidden === true && !Q.document.documentElement.classList.contains('nbd-vr-bar-on'));
    });
    const away = boot();
    away.document.getElementById('view-home').className = 'view';   // another dashboard screen is active
    away.win.NBDVisitRecorderLauncher.paint();
    ok('it stays on every dashboard screen, not only Home', away.fab.hidden === false);
    const cust = boot({ home: false, path: '/pro/customer' });
    ok('the customer page gets no round button (its quick-action bar keeps Record visit)', !cust.fab);
  }

  console.log('\n2. the menu: order, focus, keys');
  {
    const P = boot({ unfiled: 2 });
    await P.tap(P.btn);
    const it = P.items();
    ok('a tap opens the menu (role="menu")', P.isOpen() && P.menu().getAttribute('role') === 'menu');
    ok('aria-expanded follows it', P.btn.getAttribute('aria-expanded') === 'true' && P.btn.getAttribute('aria-controls') === 'nbd-vr-menu');
    ok('three items, top to bottom: Unfiled visits (2), Recent visits, Record visit',
      it.length === 3 && /^Unfiled visits/.test(P.label(it[0])) && it[0].getAttribute('aria-label') === 'Unfiled visits (2)'
      && P.label(it[1]) === 'Recent visits' && P.label(it[2]) === 'Record visit', it.map(P.label).join(' | '));
    ok('Record visit is the big pill, last (nearest the thumb)', it[2].classList.contains('is-big') && !it[0].classList.contains('is-big') && !it[1].classList.contains('is-big'));
    ok('every item is a role="menuitem" button', it.every((b) => b.tagName === 'BUTTON' && b.getAttribute('role') === 'menuitem' && b.type === 'button'));
    ok('focus goes to the first item', P.document.activeElement === it[0]);
    ok('the badge hides while the menu is open (the count is in the menu)', P.fab.classList.contains('is-open'));
    ok('a light dim sits behind the open menu', P.dim() && P.dim().hidden === false && P.dim().isConnected);
    P.key('ArrowDown'); ok('ArrowDown moves to the next item', P.document.activeElement === it[1]);
    P.key('ArrowDown'); P.key('ArrowDown'); ok('...and wraps from the last to the first', P.document.activeElement === it[0]);
    P.key('ArrowUp'); ok('ArrowUp wraps from the first to the last', P.document.activeElement === it[2]);
    P.key('Home'); ok('Home goes to the first', P.document.activeElement === it[0]);
    P.key('End'); ok('End goes to the last', P.document.activeElement === it[2]);
    const ev = P.key('ArrowDown');
    ok('arrow keys are consumed (no page scroll)', ev.defaultPrevented === true);
  }
  {
    const P = boot({ unfiled: 0 });
    await P.tap(P.btn);
    const it = P.items();
    ok('with nothing unfiled, no Unfiled item: Recent visits, Record visit', it.length === 2 && P.label(it[0]) === 'Recent visits' && P.label(it[1]) === 'Record visit', it.map(P.label).join(' | '));
    ok('...and focus goes to Recent visits, the first item', P.document.activeElement === it[0]);
  }

  console.log('\n3. closing: Escape, the button again, a tap outside, Tab');
  {
    const P = boot();
    await P.tap(P.btn);
    P.key('Escape');
    ok('Escape closes it', !P.isOpen() && P.btn.getAttribute('aria-expanded') === 'false' && !P.fab.classList.contains('is-open'));
    ok('...the dim goes with it', P.dim().hidden === true);
    ok('...and focus returns to the button', P.document.activeElement === P.btn);
    await P.tap(P.btn); ok('control: it opens again', P.isOpen());
    await P.tap(P.btn);
    ok('tapping the button again closes it, focus on the button', !P.isOpen() && P.document.activeElement === P.btn);
    await P.tap(P.btn);
    P.fire(P.dim(), 'pointerdown');
    ok('pressing on the dim does not close it yet (so the tap cannot fall through to the page)', P.isOpen());
    P.fire(P.dim(), 'click');
    ok('the dim\'s click closes it', !P.isOpen());
    await P.tap(P.btn);
    P.fire(P.other, 'pointerdown');
    ok('a press anywhere outside closes it', !P.isOpen());
    ok('...without pulling focus back to the button', P.document.activeElement !== P.btn);
    await P.tap(P.btn);
    P.key('Tab');
    ok('Tab closes it and lets focus move on', !P.isOpen());
    P.other.focus();
    P.key('Escape', P.other);
    ok('control: Escape with the menu closed leaves focus where it is', P.document.activeElement === P.other);
  }

  console.log('\n4. the old bar\'s three actions still work, from the menu');
  {
    const P = boot({ unfiled: 2 });
    await P.tap(P.btn);
    await P.tap(P.items()[2]);
    const b = P.calls.find((c) => c[0] === 'begin');
    ok('Record visit starts the recorder (NBDVisitRecorderUI.begin)', !!b, JSON.stringify(P.calls));
    ok('...with source "fab", as the old bar did, and no lead', b && b[1].source === 'fab' && b[1].leadId === null && b[1].appointmentId === null, b && JSON.stringify(b[1]));
    ok('picking an item closes the menu and returns focus to the button', !P.isOpen() && P.document.activeElement === P.btn);
  }
  {
    const P = boot({ unfiled: 2 });
    await P.tap(P.btn);
    await P.tap(P.items()[1]);
    ok('Recent visits opens the same Recent sheet (NBDVisitRecorderUI.openRecent)', P.calls.some((c) => c[0] === 'openRecent') && !P.calls.some((c) => c[0] === 'begin'), JSON.stringify(P.calls));
    ok('...and closes the menu', !P.isOpen());
  }
  {
    const P = boot({ unfiled: 2 });
    await P.tap(P.btn);
    await P.tap(P.items()[0]);
    ok('Unfiled visits opens the same Unfiled sheet (NBDVisitRecorderUI.openUnfiled)', P.calls.some((c) => c[0] === 'openUnfiled') && !P.calls.some((c) => c[0] === 'begin' || c[0] === 'openRecent'), JSON.stringify(P.calls));
    ok('...and closes the menu', !P.isOpen());
  }
  {
    // the recorder could not load (no signal, never preloaded): the tap says so instead of doing nothing
    const P = boot();
    delete P.win.NBDVisitRecorderUI;
    let threw = null;
    try { await P.tap(P.btn); } catch (e) { threw = e; }
    // load() appends script tags whose onload never fires in the fake DOM; fire their onerror
    P.document.head.children.filter((n) => n.tagName === 'SCRIPT').forEach((n) => { if (typeof n.onerror === 'function') n.onerror(); });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok('a failed recorder load shows a toast, not a dead button', !threw && P.calls.some((c) => c[0] === 'toast' && /Could not load the recorder/.test(c[1]) && c[2] === 'error'), JSON.stringify(P.calls));
  }

  console.log('\n5. CSS: place, size, tokens, hiding');
  {
    const css = read('docs/pro/css/visit-recorder.css');
    const block = (sel) => (new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css) || [])[1] || '';
    const fab = block('.nbd-vr-fab'), btn = block('.nbd-vr-fabbtn'), big = block('.nbd-vr-mi.is-big');
    ok('phone: bottom-left, just above the 62px bottom nav plus the safe area', /left:16px/.test(fab) && /bottom:calc\(62px \+ 14px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(fab) && !/right:/.test(fab), fab);
    ok('desktop: the same corner, 24px in', /@media \(min-width:769px\)\{\s*\.nbd-vr-fab\{ left:24px; bottom:24px; \}/.test(css));
    ok('desktop: the sidebar\'s last item gets room under the button', /min-width:769px\)\{[\s\S]*?html\.nbd-vr-bar-on \.sidebar\{ padding-bottom:96px; \}/.test(css));
    ok('a 56px circle', /width:56px; height:56px/.test(btn) && /border-radius:50%/.test(btn));
    ok('brand orange from the theme token, never a hex', /background:var\(--orange\);/.test(btn) && !/#[0-9a-f]{3,8}\b/i.test(btn + fab + block('.nbd-vr-fabbadge') + block('.nbd-vr-fabdot') + block('.nbd-vr-fabdot::after') + big + block('.nbd-vr-mi') + block('.nbd-vr-dim')));
    ok('a light shadow from the elevation ladder', /box-shadow:var\(--ui-elev-3\)/.test(btn));
    ok('every menu item is at least 48px tall, Record visit 56px', /min-height:48px/.test(block('.nbd-vr-mi')) && /min-height:56px/.test(big));
    ok('the record dot: white disc with a red centre', /background:white/.test(block('.nbd-vr-fabdot')) && /background:var\(--red\)/.test(block('.nbd-vr-fabdot::after')));
    ok('the badge hides while the menu is open, and at zero ([hidden])', /\.nbd-vr-fabbadge\[hidden\], \.nbd-vr-fab\.is-open \.nbd-vr-fabbadge\{ display:none; \}/.test(css));
    ok('hidden while recording (the red live bar stays as it was)', /body:has\(\.nbd-vr-live\) \.nbd-vr-fab/.test(css));
    ok('hidden while a recorder sheet is up', /body:has\(\.nbd-vr-scrim\) \.nbd-vr-fab/.test(css));
    ok('hidden while the phone keyboard is up (keyboard-viewport.js html.nbd-kb-open)', /html\.nbd-kb-open \.nbd-vr-fab/.test(css) && /classList\.add\('nbd-kb-open'\)/.test(read('docs/pro/js/keyboard-viewport.js')));
    ok('the hide rule really is display:none', /body:has\(\.nbd-vr-scrim\) \.nbd-vr-fab\{ display:none; \}/.test(css));
    ok('the dim sits just under the open button and menu, both over the nav, toasts and the sample strip (10008)',
      /z-index:10010/.test(block('.nbd-vr-dim')) && /z-index:10011/.test(block('.nbd-vr-fab.is-open')) && /z-index:900/.test(fab));
    ok('the menu opens up and to the right of the button', /left:0; bottom:66px;/.test(block('.nbd-vr-menu')) && /transform-origin:0 100%/.test(block('.nbd-vr-menu')));
    ok('motion uses the duration tokens and stops for reduced motion', /animation:nbd-vr-menu-in var\(--ui-dur-enter\)/.test(css) && /prefers-reduced-motion: reduce\)\{ \.nbd-vr-menu\{ animation:none; \} \}/.test(css));
    ok('the old pill bar\'s rules are gone', !/\.nbd-vr-bar\{|\.nbd-vr-barbtn|\.nbd-vr-unfiled\{/.test(css));
    ok('Island\'s own sheet hides the button too', /html\[data-layout="island"\] \.nbd-vr-fab \{ display: none !important; \}/.test(read('docs/pro/css/layouts/island.css')));
  }

  console.log('\n6. modals, budget, wiring');
  {
    const coord = read('docs/pro/js/fab-stack-coordinator.js');
    const ids = (/const FAB_IDS = \[([\s\S]*?)\];/.exec(coord) || [])[1] || '';
    ok('the FAB coordinator hides it whenever a blocking modal is open', /'nbd-vr-fab'/.test(ids), ids);
    const L = read('docs/pro/js/visit-recorder-launcher.js');
    ok('the menu file loads with the recorder (FILES), not at boot', /'\/pro\/js\/visit-recorder-menu\.js\?v=\d+'/.test((/var FILES = \[([\s\S]*?)\];/.exec(L) || [])[1] || ''));
    const html = read('docs/pro/dashboard.html');
    ok('dashboard.html does not load the menu file at boot (the shipped-bytes budget)', !/visit-recorder-menu\.js/.test(html));
    ok('the launcher is still a deferred boot script', /<script defer src="js\/visit-recorder-launcher\.js\?v=\d+"><\/script>/.test(html));
    // phones keep a cached copy until the URL changes: both pages ask for the new launcher and coordinator
    const cust = read('docs/pro/customer.html');
    ok('dashboard + customer pages load the new launcher (v>=5) and coordinator (v>=3)',
      [html, cust].every((p) => /visit-recorder-launcher\.js\?v=([5-9]|\d\d+)"/.test(p) && /fab-stack-coordinator\.js\?v=([3-9]|\d\d+)"/.test(p)));
    ok('the stylesheet is re-versioned in both places (v=5)', (L.match(/visit-recorder\.css\?v=5/g) || []).length === 2);
    const M = read('docs/pro/js/visit-recorder-menu.js');
    ok('menu: no innerHTML and no inline styles (strict CSP)', !/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|\.style\.|setAttribute\(\s*['"]style/.test(M.replace(/\/\*[\s\S]*?\*\//g, '')));
    ok('menu: Record and Recent ride the launcher\'s own delegates (one path for every entry point)',
      /setAttribute\('data-nbd-record-visit', ''\)/.test(M) && /setAttribute\('data-source', 'fab'\)/.test(M) && /setAttribute\('data-nbd-recent-visits', ''\)/.test(M));
    ok('demo strip lifts above the button on every screen (not only Home)', /html\.nbd-demo\.nbd-vr-bar-on \.nbd-demo-strip \{ bottom: calc\(138px/.test(read('docs/pro/css/demo-mode.css')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
