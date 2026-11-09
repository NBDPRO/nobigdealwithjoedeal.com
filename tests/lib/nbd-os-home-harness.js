/**
 * tests/lib/nbd-os-home-harness.js - a small fake DOM and a window that runs
 * the REAL NBD OS layout (os/system-logic.js, layouts/os-wm-logic.js,
 * os/home-logic.js, os/coach-logic.js, os/home.js, layouts/os.js) over it, for
 * the NBD OS home suites (no jsdom in this repo). It parses the innerHTML
 * strings the code writes. Timers are held and fired by hand; every Firestore,
 * callable and network entry point is a counter that must stay at zero.
 *
 * Grown from the fake DOM in tests/nbd-os-home-2026-11-09.test.js (P0b), with
 * what the P0c suites need: keyboard and pointer events, focus, <dialog>,
 * localStorage seeds, _leads, the tenant stageRole, the layout engine's
 * read-only Daily Success accessor and the system layer's registerControl.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') : '');

const VOID = { input: 1, br: 1, img: 1, hr: 1, meta: 1, link: 1, source: 1 };
function makeDom() {
  const document = { readyState: 'complete', activeElement: null, hidden: false, listeners: {} };
  const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  function compound(el, sel) {
    const re = /([a-z][a-z0-9]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gi;
    let m, n = 0, len = 0;
    while ((m = re.exec(sel))) {
      len += m[0].length; n++;
      if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
      if (m[2] && !el.classList.contains(m[2])) return false;
      if (m[3] && el.id !== m[3]) return false;
      if (m[4] && (m[5] === undefined ? !el.hasAttribute(m[4]) : el.getAttribute(m[4]) !== m[5])) return false;
    }
    return n > 0 && len === sel.length;
  }
  function matches(el, sel) {
    if (!el || !el.attrs) return false;
    return sel.split(',').some((one) => {
      const parts = one.trim().split(/\s+/);
      if (!compound(el, parts[parts.length - 1])) return false;
      let p = el.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (p && p.attrs && !compound(p, parts[i])) p = p.parentNode;
        if (!p || !p.attrs) return false;
        p = p.parentNode;
      }
      return true;
    });
  }
  class Txt {
    constructor(s) { this.nodeType = 3; this.nodeValue = String(s); this.parentNode = null; }
    get textContent() { return this.nodeValue; }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  }
  class El {
    constructor(tag) {
      this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
      this.className = ''; this.hidden = false; this.id = ''; this.listeners = {}; this.capture = {}; this.innerHTMLWrites = 0;
      this.style = { setProperty() {}, removeProperty() {} };
      this.scrollLeft = 0; this.clientWidth = 360; this.open = false;
      const self = this;
      this.classList = {
        add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
        remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); return on; },
        contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
      };
    }
    get childNodes() { return this.children; }
    get firstElementChild() { return this.children.filter((c) => c.attrs)[0] || null; }
    get childElementCount() { return this.children.filter((c) => c.attrs).length; }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._clear(); this.appendChild(new Txt(v)); }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document.documentElement; }
    get innerHTML() {
      return this.children.map((c) => (c.attrs
        ? '<' + c.tagName.toLowerCase() + Object.keys(c.attrs).map((k) => ' ' + k + '="' + (k === 'class' ? c.className : c.attrs[k]) + '"').join('') + '>' + c.innerHTML + '</' + c.tagName.toLowerCase() + '>'
        : c.nodeValue.replace(/&/g, '&amp;').replace(/</g, '&lt;'))).join('');
    }
    set innerHTML(html) {
      this.innerHTMLWrites++;
      this._clear();
      const stack = [this];
      const re = /<\/([a-z][a-z0-9]*)>|<([a-z][a-z0-9]*)((?:\s+[a-z][\w-]*(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
      let m;
      while ((m = re.exec(String(html)))) {
        const top = stack[stack.length - 1];
        if (m[1]) { if (stack.length > 1) stack.pop(); }
        else if (m[2]) {
          const el = new El(m[2]);
          const attrRe = /([a-z][\w-]*)(?:="([^"]*)")?/gi;
          let a;
          while ((a = attrRe.exec(m[3] || ''))) el.setAttribute(a[1], a[2] === undefined ? '' : unesc(a[2]));
          top.appendChild(el);
          if (!VOID[m[2].toLowerCase()]) stack.push(el);
        } else if (m[4]) top.appendChild(new Txt(unesc(m[4])));
      }
    }
    _clear() { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { if (k === 'class') return this.className; return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs || (k === 'class' && !!this.className); }
    removeAttribute(k) { delete this.attrs[k]; }
    toggleAttribute(k, on) { if (on === undefined) on = !this.hasAttribute(k); if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      const i = ref ? this.children.indexOf(ref) : -1;
      c.parentNode = this;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    removeChild(c) { c.remove(); return c; }
    remove() {
      if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; }
      if (document.activeElement && this.contains(document.activeElement)) document.activeElement = null;
    }
    contains(o) { while (o) { if (o === this) return true; o = o.parentNode; } return false; }
    closest(sel) { let n = this; while (n && n.attrs) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
    matches(sel) { return matches(this, sel); }
    querySelectorAll(sel) { const out = []; (function walk(n) { n.children.forEach((c) => { if (!c.attrs) return; if (matches(c, sel)) out.push(c); walk(c); }); })(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn, opt) { const cap = opt === true || (opt && opt.capture); const bag = cap ? this.capture : this.listeners; (bag[t] = bag[t] || []).push(fn); }
    removeEventListener(t, fn, opt) { const cap = opt === true || (opt && opt.capture); const bag = cap ? this.capture : this.listeners; bag[t] = (bag[t] || []).filter((f) => f !== fn); }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    showModal() { this.open = true; this.setAttribute('open', ''); this.modal = true; }
    close() { this.open = false; this.removeAttribute('open'); (this.listeners.close || []).slice().forEach((f) => f({ type: 'close', target: this })); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 800 }; }
    scrollIntoView() {}
  }
  document.documentElement = new El('html');
  document.head = new El('head');
  document.body = new El('body');
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  document.createElement = (t) => new El(t);
  document.getElementById = (id) => document.documentElement.querySelectorAll('#' + id)[0] || null;
  document.querySelector = (s) => document.documentElement.querySelector(s);
  document.querySelectorAll = (s) => document.documentElement.querySelectorAll(s);
  document.contains = (n) => document.documentElement.contains(n);
  document.addEventListener = (t, f) => { (document.listeners[t] = document.listeners[t] || []).push(f); };
  document.removeEventListener = (t, f) => { document.listeners[t] = (document.listeners[t] || []).filter((x) => x !== f); };
  return { document, El };
}

/** Dispatch an event the way delegated listeners see it: capture down from <html>, then bubble up to the document. */
function fire(dom, target, type, extra) {
  const ev = Object.assign({
    type, target, defaultPrevented: false, button: 0, pointerId: 1, clientX: 10, clientY: 10,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; },
  }, extra || {});
  const chain = [];
  for (let n = target; n && n.attrs; n = n.parentNode) chain.push(n);
  for (let i = chain.length - 1; i >= 0 && !ev.stopped; i--) (chain[i].capture[type] || []).slice().forEach((f) => { if (!ev.stopped) f(ev); });
  for (let i = 0; i < chain.length && !ev.stopped; i++) (chain[i].listeners[type] || []).slice().forEach((f) => { if (!ev.stopped) f(ev); });
  if (!ev.stopped) (dom.document.listeners[type] || []).slice().forEach((f) => f(ev));
  return ev;
}
const click = (dom, target) => fire(dom, target, 'click');
const key = (dom, target, k, mods) => fire(dom, target, 'keydown', Object.assign({ key: k }, mods || {}));

const NOW = new Date(2026, 10, 9, 13, 5).getTime();   // Mon, Nov 9 2026, 1:05 PM local
const DK = '2026-11-09';
function plan() {
  return {
    total: 5,
    appointments: [
      { key: 'appt:1', name: 'Pat <b>Customer</b>', title: 'Inspection - Pat', leadId: 'L1', address: '12 Oak St, Cincinnati, OH', phone: '5135550101', timeLabel: '2:00 PM', sortMs: NOW + 55 * 60000, allDay: false },
    ],
    promises: [],
    calls: [{ key: 'lead:L2', name: '<img src=x onerror=alert(1)>', leadId: 'L2', phone: '(513) 555-0102', missed: true, latestMs: NOW - 2 * 3600000 }],
    promised: [{ key: 'prom:L3', name: 'Lee "Q" Three', leadId: 'L3', overdue: true, tasks: [], promises: [] }],
    estimates: [{ key: 'est:L4', name: 'Dee Four', leadId: 'L4', bucket: 'd2', daysOut: 3 }],
    money: [], stalled: [],
  };
}

const FILES = [
  'docs/pro/js/os/system-logic.js', 'docs/pro/js/layouts/os-wm-logic.js', 'docs/pro/js/os/home-logic.js',
  'docs/pro/js/os/coach-logic.js', 'docs/pro/js/os/home.js', 'docs/pro/js/layouts/board-logic.js', 'docs/pro/js/layouts/os.js',
];
/**
 * opts: surface, plan (null = none yet), counts, role, home (the saved os-home key), leads, leadsLoaded,
 * store (localStorage seed), stageRole, ds (LayoutEngine.ds() answer), system (true = an NBDOS stub with
 * registerControl), uid, lastThrows, countsThrow, skip (files not to load), and for the company
 * home (P1): company (settings/layout as prefs().company has it; saveCompany merges into it and
 * records W._coSaves), claims (W._userClaims), coSaveFails (saveCompany answers saved:false).
 * W.toasts records showToast.
 * P1 (2026-11-09): nav (more sidebar views, e.g. ['storm']), loader (true = a ScriptLoader stub whose
 * loadBundle runs a bundle's docs/pro files in this window, synchronously, and records the call).
 */
function makeWin(opts) {
  const o = opts || {};
  const dom = makeDom();
  const { document } = dom;
  const timers = [];
  const winListeners = {};
  const reads = [];
  const counter = (name) => function () { reads.push(name); return Promise.resolve({ docs: [], exists: () => false, data: () => ({}) }); };
  const store = Object.assign({}, o.store || {});
  const today = { computeCalls: 0, lastCalls: 0, value: o.plan === undefined ? plan() : o.plan };
  const W = {
    document, navigator: { onLine: true },
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(o.now || NOW); } static now() { return o.now || NOW; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, kind: 't' }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval: (fn, ms) => { timers.push({ fn, ms, kind: 'i' }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
    removeEventListener: (t, f) => { winListeners[t] = (winListeners[t] || []).filter((x) => x !== f); },
    dispatchEvent: (ev) => { (winListeners[ev.type] || []).slice().forEach((f) => f(ev)); return true; },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    console: { log() {}, info() {}, warn() {}, error() {} },
    getComputedStyle: () => ({ display: 'block' }),
    matchMedia: () => ({ matches: false }),
    getDoc: counter('getDoc'), getDocs: counter('getDocs'), onSnapshot: counter('onSnapshot'), getCountFromServer: counter('getCountFromServer'),
    collection: counter('collection'), query: counter('query'), doc: counter('doc'), setDoc: counter('setDoc'), updateDoc: counter('updateDoc'),
    fetch: counter('fetch'), _httpsCallable: counter('httpsCallable'), db: {},
    NBDToday: {
      compute() { today.computeCalls++; return today.value; },
      last() { today.lastCalls++; if (o.lastThrows) throw new Error('boom'); return today.value; },
      appointmentsFailed() { return false; },
    },
    NBDHomeAttention: o.countsThrow ? Object.defineProperty({}, 'lastCounts', { get() { throw new Error('counts boom'); } })
      : { lastCounts: o.counts === undefined ? { calls: 2, signs: 1, stripe: 0, reviews: 0 } : o.counts },
    NBDOfflineSync: { pending: () => 0 },
    _userClaims: o.claims || { role: o.role || 'owner', companyId: 'c1' },
    _user: { uid: o.uid || 'u1' },
    _leads: o.leads || [],
    _leadsLoaded: o.leadsLoaded === undefined ? true : o.leadsLoaded,
    leadModal: 0, searches: 0, goTos: [], settingsTabs: [], skinLoads: 0,
  };
  if (o.stageRole) W.stageRole = o.stageRole;
  W.openLeadModal = () => { W.leadModal++; };
  W.NBDCommand = { open: () => { W.searches++; } };
  W.goTo = (id, arg) => { W.goTos.push(id); };
  W.switchSettingsTab = (t) => { W.settingsTabs.push(t); };
  W.NBDMySkinBoot = { load: () => { W.skinLoads++; } };
  if (o.system) {
    W.controls = [];
    W.NBDOS = {
      registerControl(def) { W.controls = W.controls.filter((c) => c.id !== def.id).concat([def]); },
      unregisterControl(id) { W.controls = W.controls.filter((c) => c.id !== id); },
      settingsTab(tab, anchor) { W.settingsTabs.push(tab + '#' + anchor); },
    };
  }
  let saved = o.home;
  let company = o.company ? JSON.parse(JSON.stringify(o.company)) : {};
  W.toasts = [];
  W.showToast = (msg, kind) => { W.toasts.push({ msg: String(msg), kind }); };
  W.LayoutEngine = {
    implement(id, impl) { W._impl = impl; },
    prefs() { return { user: { layoutState: saved === undefined ? {} : { 'os-home': saved } }, company, hydrated: true }; },
    saveCompany(p) {
      (W._coSaves = W._coSaves || []).push(JSON.parse(JSON.stringify(p)));
      if (o.coSaveFails) return Promise.resolve({ saved: false });
      company = Object.assign({}, company, JSON.parse(JSON.stringify(p)));
      return Promise.resolve({ saved: true });
    },
    saveUser(p) {
      (W._saves = W._saves || []).push(JSON.parse(JSON.stringify(p)));
      if (p && p.layoutState && p.layoutState['os-home']) saved = p.layoutState['os-home'];
      return Promise.resolve({ saved: true });
    },
    surface() { return o.surface || 'phone'; },
    ds() { return o.ds === undefined ? null : o.ds; },
  };
  const content = document.createElement('div'); content.className = 'content';
  const sidebar = document.createElement('nav'); sidebar.className = 'sidebar';
  ['home', 'crm', 'schedule', 'calls', 'money', 'photos', 'settings'].concat(o.nav || []).forEach((id) => {
    const b = document.createElement('button');
    b.setAttribute('data-action', 'goTo'); b.setAttribute('data-target', id); b.setAttribute('aria-label', id.toUpperCase());
    sidebar.appendChild(b);
    const v = document.createElement('div'); v.className = 'view'; v.id = 'view-' + id; v.setAttribute('id', 'view-' + id);
    content.appendChild(v);
  });
  const panel = document.createElement('div'); panel.setAttribute('id', 'myskinPanel');
  document.body.appendChild(sidebar);
  document.body.appendChild(content);
  document.body.appendChild(panel);
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  const skip = o.skip || [];
  if (o.loader) {
    ctx.ScriptLoader = {
      bundles: {}, calls: [],
      loadBundle(name) {
        this.calls.push(name);
        (this.bundles[name] || []).forEach((src) => {
          const f = 'docs/pro/' + String(src).replace(/\?.*$/, '');
          const code = read(f);
          if (code) vm.runInContext(code, ctx, { filename: f });
        });
        return Promise.resolve();
      },
    };
  }
  FILES.forEach((f) => { const src = read(f); if (src && skip.indexOf(f) === -1) vm.runInContext(src, ctx, { filename: f }); });
  const fireT = (ms) => timers.forEach((t) => { if (t.fn && t.ms === ms) { const f = t.fn; if (t.kind === 't') t.fn = null; f(); } });
  return { W: ctx, dom, document, timers, fire: fireT, reads, today, winListeners, store, saved: () => saved };
}
const hw = (root) => root.querySelectorAll('.os-hw');
const byKey = (root, k) => root.querySelector('[data-oshw="' + k + '"]');
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

module.exports = { ROOT, read, makeDom, fire, click, key, makeWin, plan, NOW, DK, hw, byKey, text, noComments };
