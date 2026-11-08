/**
 * tests/record-button-menu-guard-2026-11-08.test.js - VR-MENU-GUARD: the round
 * record button when only its menu file fails to fetch.
 *
 * visit-recorder-launcher.js fetches the recorder files and
 * visit-recorder-menu.js in ONE lazy chain, and load() short-circuits for good
 * once NBDVisitRecorder + NBDVisitRecorderUI exist. If the menu file alone failed
 * (signal dropped on the last file, a stale deploy), the recorder is in but the
 * menu is not. Before the fix every later tap read
 * window.NBDVisitRecorderMenu.toggle bare, threw, and showed "Could not load the
 * recorder" for ever, with no retry of the menu file. Now the tap guards the
 * read, fetches the menu file once more, and if it is still not there starts
 * Record visit (the same begin() every entry point uses), so a tap always does
 * something.
 *
 * Runs the REAL docs/pro/js/visit-recorder-launcher.js in a small fake DOM (the
 * one from tests/record-button-2026-11-07.test.js), plays the network by firing
 * each appended <script>'s onload / onerror, and runs the real
 * visit-recorder-menu.js when a retry "arrives".
 *
 * Run: node tests/record-button-menu-guard-2026-11-08.test.js
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
    return false;
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
    get isConnected() { let n = this; while (n) { if (n === document.body) return true; n = n.parentNode; } return false; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
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
  function fire(target, type, init) {
    const ev = Object.assign({ type, target, defaultPrevented: false, _stop: false }, init || {});
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => { ev._stop = true; };
    (docListeners.true[type] || []).slice().forEach((fn) => { if (!ev._stop) fn(ev); });
    let n = target;
    while (n && !ev._stop) { ev.currentTarget = n; (n.listeners[type] || []).slice().forEach((fn) => fn(ev)); n = n.parentNode; }
    if (!ev._stop) (docListeners.false[type] || []).slice().forEach((fn) => fn(ev));
    return ev;
  }
  return { document, fire };
}

const LAUNCHER = read('docs/pro/js/visit-recorder-launcher.js');
const MENU = read('docs/pro/js/visit-recorder-menu.js');
const tick = () => new Promise((r) => setImmediate(r));

/** Boot the real launcher in a fake Classic dashboard. Nothing is preloaded unless opts.preloaded. */
function boot(opts) {
  opts = opts || {};
  const { document, fire } = makeDom();
  const home = document.createElement('div'); home.id = 'view-home'; home.className = 'view active';
  document.body.appendChild(home);
  const store = { nbd_vr_unfiled: '2' };
  const calls = [];
  const timers = [];
  const win = {
    document, console, URL, URLSearchParams, Promise,
    location: { search: '', pathname: '/pro/dashboard', href: 'https://x/pro/dashboard', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    addEventListener() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    navigator: {},
    showToast: (m, tone) => calls.push(['toast', m, tone]),
  };
  win.window = win;
  const ctx = vm.createContext(win);
  const recorder = () => ({ getState: () => ({ active: false }), subscribe() {}, wire() {}, refreshConfig() {} });
  const ui = () => ({ begin: (o) => { calls.push(['begin', o]); return null; }, openRecent: () => calls.push(['openRecent']), openUnfiled: () => calls.push(['openUnfiled']) });
  if (opts.preloaded) { win.NBDVisitRecorder = recorder(); win.NBDVisitRecorderUI = ui(); }
  vm.runInContext(LAUNCHER, ctx, { filename: 'visit-recorder-launcher.js' });
  if (opts.preloaded) vm.runInContext(MENU, ctx, { filename: 'visit-recorder-menu.js' });
  const fab = document.getElementById('nbd-vr-fab');
  const btn = fab && fab.querySelector('.nbd-vr-fabbtn');
  const menu = () => document.getElementById('nbd-vr-menu');
  const isOpen = () => !!(menu() && !menu().hidden);
  async function tap() { fire(btn, 'click'); await tick(); await tick(); }
  // the network: tags the launcher appended whose load has not been answered yet
  const pending = () => document.head.children.filter((n) => typeof n.onload === 'function' && !n._done);
  const menuTags = () => document.head.children.filter((n) => /visit-recorder-menu\.js/.test(n.src || ''));
  /** A file arrives: the recorder stubs appear with their files; the REAL menu file runs for its. (No tag: nothing to answer.) */
  function arrive(n) {
    if (!n) return;
    const src = n.src || n.href || '';
    if (/visit-recorder\.js/.test(src)) win.NBDVisitRecorder = recorder();
    if (/visit-recorder-ui\.js/.test(src)) win.NBDVisitRecorderUI = ui();
    if (/visit-recorder-menu\.js/.test(src)) vm.runInContext(MENU, ctx, { filename: 'visit-recorder-menu.js' });
    n._done = true; n.onload();
  }
  function fail(n) { if (!n) return; n._done = true; n.onerror(); }
  /** Answer the chain file by file (loadOne appends the next only after the previous loaded). */
  async function play(menuFails) {
    for (let i = 0; i < 12; i++) {
      await tick(); await tick();
      const n = pending()[0];
      if (!n) break;
      if (menuFails && /visit-recorder-menu\.js/.test(n.src || '')) fail(n); else arrive(n);
    }
    await tick(); await tick();
  }
  const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => c[1]);
  const begins = () => calls.filter((c) => c[0] === 'begin');
  return { win, document, fab, btn, menu, isOpen, tap, calls, pending, menuTags, arrive, fail, play, toasts, begins };
}

(async () => {
  console.log('\n1. the reviewer\'s story: the recorder loads, the menu file alone fails');
  {
    const P = boot();
    ok('control: nothing is loaded yet', !P.win.NBDVisitRecorder && !P.win.NBDVisitRecorderUI && !P.win.NBDVisitRecorderMenu);
    await P.tap();
    await P.play(true);
    ok('tap 1: the recorder files are in, the menu file is not', !!P.win.NBDVisitRecorderUI && !!P.win.NBDVisitRecorder && !P.win.NBDVisitRecorderMenu);
    ok('tap 1: the failed menu tag was removed (so it can be fetched again)', P.menuTags().length === 0);
    ok('tap 1: the launcher says so once (the existing toast)', P.toasts().length === 1 && /Could not load the recorder/.test(P.toasts()[0]), JSON.stringify(P.toasts()));
    P.calls.length = 0;
    await P.tap();
    await tick();
    ok('tap 2: the menu file is fetched AGAIN (one new tag), not given up on', P.menuTags().length === 1 && P.pending().length === 1 && P.pending()[0] === P.menuTags()[0], P.menuTags().length + ' tags, ' + P.pending().length + ' pending');
    ok('tap 2: nothing else is re-fetched (the recorder is already in)', P.document.head.children.filter((n) => n.src && !/menu/.test(n.src) && !n._done).length === 0);
    P.fail(P.menuTags()[0]);
    await tick(); await tick(); await tick();
    const b = P.begins()[0];
    ok('tap 2: still no menu, so the tap starts Record visit itself (begin, source fab, no lead)', !!b && b[1].source === 'fab' && b[1].leadId === null && b[1].appointmentId === null, JSON.stringify(P.calls));
    ok('tap 2: no "Could not load the recorder" (the recorder is fine)', !P.toasts().some((m) => /Could not load the recorder/.test(m)), JSON.stringify(P.toasts()));
    ok('tap 2: the failed retry tag was removed too', P.menuTags().length === 0);
    P.calls.length = 0;
    await P.tap();
    await tick();
    ok('tap 3: tries the menu file once more (every tap retries, not just one)', P.menuTags().length === 1 && !P.menuTags()[0]._done);
    P.arrive(P.menuTags()[0]);   // signal is back: the real menu file runs
    await tick(); await tick(); await tick();
    ok('tap 3: the menu arrived and opens (role="menu"), aria-expanded follows', P.isOpen() && P.menu().getAttribute('role') === 'menu' && P.btn.getAttribute('aria-expanded') === 'true', P.menu() ? 'hidden=' + P.menu().hidden : 'no menu');
    ok('tap 3: ...and no recording was started', P.begins().length === 0 && P.toasts().length === 0, JSON.stringify(P.calls));
    ok('tap 3: the retried menu is the whole menu: the long-press hold is wired onto the button', P.btn.getAttribute('data-nbd-hold') === '1');
    await P.tap();
    ok('tap 4: the menu is in, the button toggles it closed with no new fetch', !P.isOpen() && P.menuTags().length === 1 && P.pending().length === 0);
  }

  console.log('\n2. the idle preload failed on the menu only (bootRecorder), then the first tap');
  {
    const P = boot();
    P.win.auth = { currentUser: { uid: 'u1' } };
    P.win.NBDVisitRecorderLauncher.load().catch(() => {});   // what bootRecorder does ~4 s after sign-in
    await P.play(true);
    ok('control: the recorder is in, the menu is not, no tap yet', !!P.win.NBDVisitRecorderUI && !P.win.NBDVisitRecorderMenu && P.begins().length === 0);
    await P.tap();
    await tick();
    ok('the first tap fetches the menu file again', P.menuTags().length === 1);
    P.arrive(P.menuTags()[0]);
    await tick(); await tick(); await tick();
    ok('...and opens it when it arrives', P.isOpen(), JSON.stringify(P.calls));
  }

  console.log('\n3. controls');
  {
    const P = boot({ preloaded: true });
    await P.tap();
    ok('with the menu in from the start, a tap opens it and fetches nothing', P.isOpen() && P.pending().length === 0 && P.menuTags().length === 0);
    const Q = boot();
    await Q.tap();
    await Q.play(false);
    ok('with signal, the first tap loads everything and opens the menu (no fallback recording)', Q.isOpen() && Q.begins().length === 0 && Q.toasts().length === 0, JSON.stringify(Q.calls));
    const R = boot();
    await R.tap();
    // the recorder itself fails (signal gone on file 2): the existing toast, and no retry of the menu alone
    await tick(); await tick(); R.arrive(R.pending()[0]);
    await tick(); await tick(); R.fail(R.pending()[0]);
    await tick(); await tick(); await tick();
    ok('a failed RECORDER load still says "Could not load the recorder" and starts nothing', R.toasts().length === 1 && /Could not load the recorder/.test(R.toasts()[0]) && R.begins().length === 0 && R.menuTags().length === 0, JSON.stringify(R.calls));
  }

  console.log('\n4. the source');
  {
    ok('the launcher never reads window.NBDVisitRecorderMenu.toggle bare', !/window\.NBDVisitRecorderMenu\.toggle\(/.test(LAUNCHER));
    ok('the menu file is still the last of FILES (the retry fetches that entry)', /visit-recorder-menu\.js\?v=\d+',\s*\n\s*\];/.test(LAUNCHER));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
