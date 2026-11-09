/**
 * tests/nbd-os-home-2026-11-09.test.js - NBD OS P0b step 3: the read-only home
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md, sections 3.3, 5, 7, 8).
 *
 * Three widgets, At a Glance, Up Next and Shortcuts, painted by the lazy
 * docs/pro/js/os/home.js (+ css/os/home.css) from layoutState['os-home']:
 *   - phone: INSIDE page 1 of the pager, above the icons; phonePaint keeps the
 *     widget nodes (a keyed reconcile), it never rebuilds them on a repaint
 *   - desk: the widget list replaces the hard-coded clock + two buttons, and
 *     New lead / Search survive as the Shortcuts widget
 *   - read cost 0: no Firestore call, no fetch; Up Next reads NBDToday.last()
 *     and the nbd:today-rendered event, never compute() (it mutates the
 *     handled-call state)
 *   - one widget that throws shows "Couldn't load · Retry"; the rest render
 *   - everything escaped; At a Glance never names a customer
 *   - S / M / L lay out differently (container queries), 44px targets, no
 *     text under 11px, no style="" in the new files, tokens only
 *
 * Runs the REAL os/system-logic.js, layouts/os-wm-logic.js, os/home-logic.js,
 * os/home.js and layouts/os.js in a small fake DOM (no jsdom in this repo)
 * that parses the innerHTML strings they write. Timers are held and fired by
 * hand.
 *
 * Run: node tests/nbd-os-home-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') : '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

const HOME_JS = read('docs/pro/js/os/home.js');
const LOGIC_JS = read('docs/pro/js/os/home-logic.js');
const HOME_CSS = read('docs/pro/css/os/home.css');
const OS_JS = read('docs/pro/js/layouts/os.js');
const OS_CSS = read('docs/pro/css/layouts/os.css');
const SYS = read('docs/pro/js/layout-system.js');
const WM_JS = read('docs/pro/js/layouts/os-wm-logic.js');
const SYSL_JS = read('docs/pro/js/os/system-logic.js');
const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));

// ── a small fake DOM ────────────────────────────────────────────────────────
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
    return n > 0 && len === sel.length;   // anything this matcher can't read (:not, ^=) never matches
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
      this.className = ''; this.hidden = false; this.id = ''; this.listeners = {}; this.innerHTMLWrites = 0;
      this.style = { setProperty() {}, removeProperty() {} };
      this.scrollLeft = 0; this.clientWidth = 360;
      const self = this;
      this.classList = {
        add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
        remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); return on; },
        contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
      };
    }
    get childNodes() { return this.children; }
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
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      if (c.parentNode) c.remove();
      const i = ref ? this.children.indexOf(ref) : -1;
      c.parentNode = this;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    removeChild(c) { c.remove(); return c; }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
    contains(o) { while (o) { if (o === this) return true; o = o.parentNode; } return false; }
    closest(sel) { let n = this; while (n && n.attrs) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) { const out = []; (function walk(n) { n.children.forEach((c) => { if (!c.attrs) return; if (matches(c, sel)) out.push(c); walk(c); }); })(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 800 }; }
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
/** Fire a click the way a delegated listener sees it (bubbling from target up to the document). */
function click(dom, target) {
  const ev = { type: 'click', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  for (let n = target; n && !ev.stopped; n = n.parentNode) (n.listeners && n.listeners.click || []).slice().forEach((f) => f(ev));
  if (!ev.stopped) (dom.document.listeners.click || []).slice().forEach((f) => f(ev));
  return ev;
}

// ── a window running the real OS layout over the fake DOM ───────────────────
const NOW = new Date(2026, 10, 9, 13, 5).getTime();   // Mon, Nov 9, 1:05 PM local
function plan() {
  return {
    total: 5,
    appointments: [
      { key: 'appt:1', name: 'Pat <b>Customer</b>', title: 'Inspection - Pat', leadId: 'L1', address: '12 Oak St, Cincinnati, OH', phone: '5135550101', timeLabel: '2:00 PM', sortMs: NOW + 55 * 60000, allDay: false },
    ],
    promises: [],
    calls: [{ key: 'lead:L2', name: '<img src=x onerror=alert(1)>', leadId: 'L2', phone: '(513) 555-0102', missed: true }],
    promised: [{ key: 'prom:L3', name: 'Lee "Q" Three', leadId: 'L3', overdue: true, tasks: [], promises: [] }],
    estimates: [{ key: 'est:L4', name: 'Dee Four', leadId: 'L4' }],
    money: [], stalled: [],
  };
}
function makeWin(opts) {
  const o = opts || {};
  const dom = makeDom();
  const { document } = dom;
  const timers = [];
  const winListeners = {};
  const reads = [];
  const counter = (name) => function () { reads.push(name); return Promise.resolve({ docs: [], exists: () => false, data: () => ({}) }); };
  const store = {};
  const today = { computeCalls: 0, lastCalls: 0, value: o.plan === undefined ? plan() : o.plan };
  const W = {
    document, navigator: { onLine: true },
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } },
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
    // every way the page could read: none of them may be called
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
    _userClaims: { role: o.role || 'owner', companyId: 'c1' },
    leadModal: 0, searches: 0, goTos: [],
  };
  W.openLeadModal = () => { W.leadModal++; };
  W.NBDCommand = { open: () => { W.searches++; } };
  W.goTo = (id) => { W.goTos.push(id); };
  const savedHome = o.home;
  W.LayoutEngine = {
    implement(id, impl) { W._impl = impl; },
    prefs() { return { user: { layoutState: savedHome === undefined ? {} : { 'os-home': savedHome } }, hydrated: true }; },
    saveUser(p) { (W._saves = W._saves || []).push(p); return Promise.resolve({ saved: true }); },
    surface() { return o.surface || 'phone'; },
  };
  // the page: a sidebar with a few apps, and their views
  const content = document.createElement('div'); content.className = 'content';
  const sidebar = document.createElement('nav'); sidebar.className = 'sidebar';
  ['home', 'crm', 'schedule', 'calls', 'money', 'photos'].forEach((id) => {
    const b = document.createElement('button');
    b.setAttribute('data-action', 'goTo'); b.setAttribute('data-target', id); b.setAttribute('aria-label', id.toUpperCase());
    sidebar.appendChild(b);
    const v = document.createElement('div'); v.className = 'view'; v.id = 'view-' + id; v.setAttribute('id', 'view-' + id);
    content.appendChild(v);
  });
  document.body.appendChild(sidebar);
  document.body.appendChild(content);
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  [['docs/pro/js/os/system-logic.js', SYSL_JS], ['docs/pro/js/layouts/os-wm-logic.js', WM_JS], ['docs/pro/js/os/home-logic.js', LOGIC_JS], ['docs/pro/js/os/home.js', HOME_JS], ['docs/pro/js/layouts/os.js', OS_JS]]
    .forEach(([f, src]) => { if (src) vm.runInContext(src, ctx, { filename: f }); });
  const fire = (ms) => timers.forEach((t) => { if (t.fn && t.ms === ms) { const f = t.fn; if (t.kind === 't') t.fn = null; f(); } });
  return { W: ctx, dom, document, timers, fire, reads, today, winListeners };
}
const hw = (root) => root.querySelectorAll('.os-hw');
const byKey = (root, k) => root.querySelector('[data-oshw="' + k + '"]');
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.message); } };
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. wiring: lazy files through the OS layout\'s needs');
G(() => {
  const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
  const def = R.get('os');
  ok('needs.script loads the home logic and the home after the OS logic (within the 6-path cap; P0c adds the Coach rules, P1 the board logic)',
    def && J(def.needs.script) === J(['js/os/system-logic.js', 'js/layouts/os-wm-logic.js', 'js/os/home-logic.js', 'js/os/coach-logic.js', 'js/os/home.js', 'js/layouts/board-logic.js']) && def.needs.script.length <= 6, def && J(def.needs.script));
  ok('needs.css loads css/os/home.css', def && J(def.needs.css) === J(['css/os/home.css']), def && J(def.needs.css));
  const html = read('docs/pro/dashboard.html');
  ok('no new <script> or <link> tag on the dashboard (boot budget)', !/os\/home(-logic)?\.js|os\/home\.css/.test(html));
  ok('the new files exist', !!HOME_JS && !!HOME_CSS && !!LOGIC_JS);
});

console.log('\n2. read cost 0 and the Today plan read safely (static)');
G(() => {
  const code = noComments(HOME_JS);
  ok('home.js makes no Firestore, callable or network call',
    !/\b(getDoc|getDocs|onSnapshot|getCountFromServer|collection|query|setDoc|updateDoc|addDoc|httpsCallable|_httpsCallable)\s*\(/.test(code)
    && !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(/.test(code));
  ok('home.js never calls the Today plan\'s compute()', !/\.compute\s*\(/.test(code) && /\.last\s*\(/.test(code));
  ok('Up Next listens for the existing nbd:today-rendered event', /'nbd:today-rendered'/.test(code));
  ok('counts come from NBDHomeAttention.lastCounts (never re-queried)', /NBDHomeAttention/.test(code) && /lastCounts/.test(code));
  // P1 (2026-11-09): Daily Success declares 2 (goals + doors, its lazy bundle); every other widget reads nothing
  // P2 (2026-11-09): the owner's Team widget declares 50 (the company's leaderboard rows, its lazy bundle, at most every 5 min)
  ok('every catalog widget declares reads: 0 (Daily Success: 2, Team: 50)', HL.ids().every((id) => HL.CATALOG[id].reads === (id === 'daily' ? 2 : id === 'teamboard' ? 50 : 0)));
});

console.log('\n3. pure helpers');
G(() => {
  const rows = HL.upNext(plan(), { n: 3 });
  ok('upNext: the top 3 rows in Today\'s order', rows && J(rows.map((r) => r.key)) === J(['appt:1', 'lead:L2', 'prom:L3']), rows && J(rows.map((r) => r.key)));
  ok('upNext: each row taps through as Today does (Open the record; Call for a call owed)',
    rows[0].href === '/pro/customer.html?id=L1' && rows[1].href === 'tel:+15135550102' && rows[2].href === '/pro/customer.html?id=L3');
  ok('upNext: a call with no number opens the Call Center; Stripe opens Money',
    HL.upNext({ calls: [{ key: 'c', name: 'X' }] })[0].go === 'calls' && HL.upNext({ money: [{ key: 's', kind: 'stripe', count: 2 }] })[0].go === 'money');
  ok('upNext: an invoice opens Record payment, a viewer gets the plain record',
    HL.upNext({ money: [{ key: 'i', kind: 'invoice', leadId: 'L9', invoiceId: 'inv 1' }] })[0].href === '/pro/customer.html?id=L9&pay=inv%201'
    && HL.upNext({ money: [{ key: 'i', kind: 'invoice', leadId: 'L9', invoiceId: 'inv 1' }] }, { viewer: true })[0].href === '/pro/customer.html?id=L9');
  ok('upNext: no plan yet is null (not-yet-loaded), an empty plan is []', HL.upNext(null) === null && J(HL.upNext({ total: 0 })) === '[]');
  const na = HL.nextAppointment(plan(), NOW);
  ok('nextAppointment: time and street only, never the name or title', na && na.time === '2:00 PM' && na.place === '12 Oak St' && !/Pat/.test(J(na)), J(na));
  ok('nextAppointment: one long past is skipped; none -> null', HL.nextAppointment({ appointments: [{ sortMs: NOW - 3600000, timeLabel: '9 AM' }] }, NOW) === null);
  const gc = HL.glanceCounts({ calls: 2, signs: 1 });
  ok('glanceCounts: plain lines', gc.state === 'ok' && J(gc.lines) === J(['2 people need you', '1 yard sign to pick up']), J(gc));
  ok('glanceCounts: a failed read is never an all-clear; nothing yet is unknown',
    HL.glanceCounts({ callsFailed: true }).state === 'failed' && HL.glanceCounts(null).state === 'unknown' && HL.glanceCounts({}).state === 'clear');
  ok('pageRoom: the default phone home leaves 2 icon cells on page 1', HL.pageRoom(HL.defaults().phone, 20) === 2 && HL.pageRoom([{ s: 'l' }, { s: 'l' }], 20) === 0);
});

console.log('\n4. phone: widgets inside page 1, kept across phonePaint');
G(() => {
  const T = makeWin({ surface: 'phone' });
  const W = T.W;
  ok('the OS layout implemented itself', !!W._impl);
  W._impl.mount({ surface: 'phone' });
  const phone = T.document.getElementById('osPhone');
  const pages = phone && phone.querySelectorAll('.os-p-page');
  const first = pages && pages[0];
  ok('the widgets sit INSIDE page 1 of the pager', first && hw(first).length === 3, first && hw(first).length);
  ok('page 1 holds the widgets first, then the icons', first && first.querySelector('.os-hw-list') && first.children.filter((c) => c.attrs)[0].classList.contains('os-hw-list'));
  ok('with the default home, page 1 keeps room for 2 icons; the rest go to page 2',
    first && first.querySelectorAll('.os-p-icon').length === 2 && pages.length === 2 && pages[1].querySelectorAll('.os-p-icon').length === 4,
    pages && pages.map((p) => p.querySelectorAll('.os-p-icon').length).join(','));
  ok('no widgets outside the pager (nothing above all pages)', hw(phone).length === 3);
  ok('the old hard-coded widget row is gone (it lives on as Glance + Shortcuts)', !phone.querySelector('.os-p-widgets'));
  const nodes = hw(phone);
  const bodies = nodes.map((n) => n.querySelector('.os-hw-body'));
  const writes = bodies.map((b) => b.innerHTMLWrites);
  // repaint routes: the 3 s app-list refresh, Home in the bar, and edit mode on/off
  T.fire(3000);
  const bar = T.document.getElementById('osBar');
  click(T.dom, bar.querySelector('[data-osp="home"]'));
  const after = hw(T.document.getElementById('osPhone'));
  ok('phonePaint ran again (the pager was rebuilt)', T.document.getElementById('osPhone').querySelectorAll('.os-p-page')[0] !== first);
  ok('…but every widget node is the SAME node, still on page 1', after.length === 3 && after.every((n, i) => n === nodes[i])
    && T.document.getElementById('osPhone').querySelectorAll('.os-p-page')[0].contains(nodes[0]));
  ok('…and no widget body was re-rendered when nothing changed', bodies.every((b, i) => b.innerHTMLWrites === writes[i]), J(bodies.map((b) => b.innerHTMLWrites)) + ' vs ' + J(writes));
  ok('widgets are keyed by id', J(after.map((n) => n.getAttribute('data-oshw'))) === J(['glance-1', 'upnext-1', 'shortcuts-1']));
  ok('sizes ride on a class (S / M / L)', after[0].classList.contains('is-m') && after[2].classList.contains('is-s'));
  ok('one listener set per mount (no stacking on repaint)', (T.winListeners['nbd:today-rendered'] || []).length === 1);
  W._impl.unmount();
  ok('unmount removes the home\'s window listeners', (T.winListeners['nbd:today-rendered'] || []).length === 0);
  ok('read cost 0: no Firestore call, callable or fetch while mounted and repainted', T.reads.length === 0, J(T.reads));
});

console.log('\n5. Up Next: last() + nbd:today-rendered, never compute()');
G(() => {
  const T = makeWin({ surface: 'phone', plan: null });
  T.W._impl.mount({ surface: 'phone' });
  const up = () => byKey(T.document.getElementById('osPhone'), 'upnext-1');
  ok('not loaded yet: a loading state, not an empty day', /Loading your day/.test(text(up())), text(up()));
  T.today.value = plan();
  T.W.dispatchEvent(new T.W.CustomEvent('nbd:today-rendered', { detail: { total: 5 } }));
  ok('nbd:today-rendered repaints it from last()', /Pat/.test(text(up())) && T.today.lastCalls > 0, text(up()));
  ok('the top 3 rows, as links / buttons with 44px rows', up().querySelectorAll('.os-hw-row').length === 3);
  const links = up().querySelectorAll('a.os-hw-row');
  ok('rows tap through with the Today plan\'s own action (record link, tel: for a call)',
    links[0].getAttribute('href') === '/pro/customer.html?id=L1' && links[1].getAttribute('href') === 'tel:+15135550102');
  T.today.value = { total: 0, appointments: [], promises: [], calls: [], promised: [], estimates: [], money: [], stalled: [] };
  T.W.dispatchEvent(new T.W.CustomEvent('nbd:today-rendered', { detail: { total: 0 } }));
  ok('empty state: Nothing due today', /Nothing due today/.test(text(up())), text(up()));
  ok('compute() was never called', T.today.computeCalls === 0);
  T.today.value = { total: 1, money: [{ key: 'stripe', kind: 'stripe', count: 2 }] };
  T.W.dispatchEvent(new T.W.CustomEvent('nbd:today-rendered', { detail: { total: 1 } }));
  const go = up().querySelector('[data-oshw-go]');
  ok('a row with no link is a button that routes through goTo', go && go.getAttribute('data-oshw-go') === 'money');
  click(T.dom, go);
  ok('…and tapping it calls goTo(money)', J(T.W.goTos) === J(['money']), J(T.W.goTos));
  ok('still no compute() and no reads', T.today.computeCalls === 0 && T.reads.length === 0);
});

console.log('\n6. At a Glance: clock, next appointment without a name, sync, counts');
G(() => {
  const T = makeWin({ surface: 'phone' });
  T.W._impl.mount({ surface: 'phone' });
  const g = byKey(T.document.getElementById('osPhone'), 'glance-1');
  const t = text(g);
  ok('date and clock', /1:05 PM/.test(t) && /Mon, Nov 9/.test(t), t);
  ok('the next appointment\'s time and street', /2:00 PM/.test(t) && /12 Oak St/.test(t), t);
  ok('never a customer\'s name (nor the appointment title)', !/Pat|Customer|Inspection/.test(t), t);
  ok('sync state', /Synced/.test(t), t);
  ok('counts from lastCounts', /2 people need you/.test(t) && /1 yard sign/.test(t), t);
  const T2 = makeWin({ surface: 'phone', home: { phone: [{ id: 'glance', s: 's' }], desk: [] } });
  T2.W._impl.mount({ surface: 'phone' });
  const s = text(byKey(T2.document.getElementById('osPhone'), 'glance-1'));
  ok('S: time and the next appointment time, no place and no name', /1:05 PM/.test(s) && /2:00 PM/.test(s) && !/Oak|Pat/.test(s), s);
  const T3 = makeWin({ surface: 'phone', counts: { calls: 0, callsFailed: true } });
  T3.W._impl.mount({ surface: 'phone' });
  ok('a failed read says so, never "nothing waiting"', /not an all-clear/i.test(text(byKey(T3.document.getElementById('osPhone'), 'glance-1')))
    && !/Nothing waiting/.test(text(byKey(T3.document.getElementById('osPhone'), 'glance-1'))));
});

console.log('\n7. a widget that throws is contained');
G(() => {
  const T = makeWin({ surface: 'phone', countsThrow: true });
  T.W._impl.mount({ surface: 'phone' });
  const phone = T.document.getElementById('osPhone');
  const g = byKey(phone, 'glance-1');
  ok('the throwing widget shows "Couldn\'t load · Retry"', /Couldn't load/.test(text(g)) && !!g.querySelector('[data-oshw-retry]'), text(g));
  ok('the others still render', /Pat/.test(text(byKey(phone, 'upnext-1'))) && !!byKey(phone, 'shortcuts-1').querySelector('[data-osp="newlead"]'));
  T.W.NBDHomeAttention = { lastCounts: { calls: 1 } };
  click(T.dom, g.querySelector('[data-oshw-retry]'));
  ok('Retry repaints it once the data reads', /1 person needs you/.test(text(byKey(phone, 'glance-1'))), text(byKey(phone, 'glance-1')));
  const T2 = makeWin({ surface: 'phone', lastThrows: true });
  T2.W._impl.mount({ surface: 'phone' });
  const p2 = T2.document.getElementById('osPhone');
  ok('a throwing Today plan fails Up Next alone; Shortcuts keeps working', /Couldn't load/.test(text(byKey(p2, 'upnext-1')))
    && !!byKey(p2, 'shortcuts-1').querySelector('[data-osp="search"]'));
  ok('the pager still painted its icons', p2.querySelector('.os-p-pages').querySelectorAll('.os-p-icon').length === 6);
});

console.log('\n8. desk: the column becomes the ordered widget list; New lead and Search kept');
G(() => {
  const T = makeWin({ surface: 'desktop' });
  T.W._impl.mount({ surface: 'desktop' });
  const desk = T.document.getElementById('osDesk');
  const col = desk && desk.querySelector('.os-widgets');
  ok('the desk column holds the widget list, in order', col && J(hw(col).map((n) => n.getAttribute('data-oshw'))) === J(['glance-1', 'upnext-1', 'shortcuts-1']), col && J(hw(col).map((n) => n.getAttribute('data-oshw'))));
  ok('the hard-coded clock + quick buttons are gone', !desk.querySelector('.os-clock') && !desk.querySelector('.os-quick'));
  const nl = col.querySelector('[data-osdo="newlead"]');
  const se = col.querySelector('[data-osdo="search"]');
  ok('Shortcuts keeps New lead (the one filled orange) and Search', nl && se && nl.classList.contains('btn-orange') && /New lead/.test(text(nl)) && /Search/.test(text(se)));
  click(T.dom, nl);
  click(T.dom, se);
  ok('…wired to the existing actions (openLeadModal, the command palette)', T.W.leadModal === 1 && T.W.searches === 1, T.W.leadModal + '/' + T.W.searches);
  ok('the clock lives on in At a Glance', /1:05 PM/.test(text(byKey(col, 'glance-1'))));
  const T2 = makeWin({ surface: 'desktop', home: { desk: [{ id: 'shortcuts', s: 'm', cfg: { clock: 'on' } }], phone: [] } });
  T2.W._impl.mount({ surface: 'desktop' });
  ok('Shortcuts can carry the clock (cfg clock: on)', /1:05 PM/.test(text(byKey(T2.document.getElementById('osDesk'), 'shortcuts-1'))));
  ok('desk read cost 0', T.reads.length === 0 && T2.reads.length === 0, J(T.reads));
  ok('below 1100px the column collapses to one column instead of hiding',
    !/@media \(max-width: 1100px\) \{ \.os-widgets \{ display: none; \} \}/.test(OS_CSS)
    && /@media \(max-width: 1100px\)[^{]*\{[^}]*\.os-hw-desk[^}]*grid-template-columns: 1fr/.test(HOME_CSS.replace(/\n/g, ' ')));
});

console.log('\n9. escaping');
G(() => {
  const T = makeWin({ surface: 'phone' });
  T.W._impl.mount({ surface: 'phone' });
  const up = byKey(T.document.getElementById('osPhone'), 'upnext-1');
  ok('a name with markup arrives as text, never as an element', !up.querySelector('img') && !up.querySelector('b') && /<img src=x onerror=alert\(1\)>/.test(text(up)), up.innerHTML);
  const T2 = makeWin({ surface: 'phone', plan: { total: 1, appointments: [{ key: 'a', leadId: 'L"><x', name: 'A', address: '<i>1 Elm</i>, X', timeLabel: '<u>3 PM</u>', sortMs: NOW + 60000 }] } });
  T2.W._impl.mount({ surface: 'phone' });
  const p2 = T2.document.getElementById('osPhone');
  ok('ids in links are encoded, labels escaped', !p2.querySelector('x') && !p2.querySelector('i') && !p2.querySelector('u')
    && byKey(p2, 'upnext-1').querySelector('a.os-hw-row').getAttribute('href') === '/pro/customer.html?id=L%22%3E%3Cx');
  const code = noComments(HOME_JS);
  ok('home.js builds markup only through esc() (no raw value concatenated)', /function esc\(/.test(code) && !/' \+ (?!esc\(|String\(|\(|'|\w+Html \+|\w+Html\()[a-zA-Z_.]+(?:\[[^\]]+\])? \+ '/.test(code),
    (code.match(/' \+ (?!esc\(|String\(|\(|'|\w+Html \+|\w+Html\()[a-zA-Z_.]+(?:\[[^\]]+\])? \+ '/g) || []).slice(0, 4).join(' | '));
});

console.log('\n10. sizes, targets, type floor, CSP');
G(() => {
  const css = HOME_CSS;
  ok('container queries lay the widgets out by their own width', /container-type:\s*inline-size/.test(css) && (css.match(/@container\b/g) || []).length >= 2);
  ok('S, M and L each have their own rules', /\.os-hw\.is-s\b/.test(css) && /\.os-hw\.is-m\b/.test(css) && /\.os-hw\.is-l\b/.test(css));
  ok('phone: S 2x1, M 4x2, L 4x4 cells of the page grid', /\.os-p-page \.os-hw\.is-s \{[^}]*grid-column: span 2;[^}]*grid-row: span 1;/.test(css)
    && /\.os-p-page \.os-hw\.is-m \{[^}]*grid-column: span 4;[^}]*grid-row: span 2;/.test(css) && /\.os-p-page \.os-hw\.is-l \{[^}]*grid-column: span 4;[^}]*grid-row: span 4;/.test(css));
  ok('44px tap targets on rows and buttons', /\.os-hw-row \{[^}]*min-height: 44px/.test(css) && /\.os-hw-btn \{[^}]*min-height: 44px/.test(css));
  const sizes = (css.match(/font-size:\s*[^;]+;/g) || []).map((d) => {
    const px = /(\d+(?:\.\d+)?)px/.exec(d);
    return px ? Number(px[1]) : null;
  });
  ok('no text under 11px (every px font size and fallback >= 11)', sizes.length > 0 && sizes.every((n) => n === null || n >= 11), J(sizes));
  ok('tokens only: no hex colours, no old oranges', !/#[0-9a-fA-F]{3,8}\b/.test(css));
  ok('no style="" in the new files', !/style\s*=/.test(HOME_JS) && !/style\s*=/.test(LOGIC_JS) && !/\.style\.|setProperty/.test(noComments(HOME_JS)));
  ok('no inline handlers in the new files', !/\son[a-z]+=/i.test(noComments(HOME_JS)) && !/\son[a-z]+=/i.test(LOGIC_JS));
  ok('no style="" added to os.js markup', !/style="/.test(OS_JS));
  ok('motion respects both reduce switches (no animation of its own)', !/@keyframes|animation:/.test(css));
  ok('widget chrome takes no filled orange of its own (New lead is the region\'s one)', !/background:\s*var\(--orange\)/.test(css));
});

console.log('\n11. demo mode stays zero-network');
G(() => {
  const code = noComments(HOME_JS);
  ok('home.js adds no request of its own (no fetch, import(), script or link injection)',
    !/\bfetch\s*\(|\bimport\s*\(|createElement\(\s*'(script|link|img|iframe)'/.test(code));
  // P1 (2026-11-09): the ScriptLoader uses are its own three lazy bundles of same-origin files under js/os/ and css/os/
  const files = (code.match(/var P1_FILES = \[([^\]]*)\]/) || [])[1] || '';
  const bundle = /var SD_BUNDLE = \[([^\]]*)\]/.exec(code);
  // P2 (2026-11-09): and osacts (Activities and Focus modes), osp2peek (Peek, Recap) and oscoachai
  // (css/os/coach-ai.css, js/os/coach-ai.js, the opted-in Coach's AI focus line), css/os + js/os files too
  const acts = /var ACTS_FILES = \[([^\]]*)\]/.exec(code);
  ok('…its ScriptLoader loads are oshomep1 (js/os/stack-logic.js, js/os/widgets-p1.js), osdsbiz (js/os/ds-business.js), osshutdown, osacts, osp2peek (css/os + js/os files), oscoachai, osteam, osdsgoals (js/os/ds-goals.js) and (P3) osfocus and oskpi (css/os + js/os files)',
    (code.match(/loadBundle\(/g) || []).length === 10 && /loadBundle\('osfocus'\)/.test(code) && /SL\.loadBundle\('oskpi'\)/.test(code)
      && /var KPI_BUNDLE = \[([^\]]*)\]/.exec(code)[1].split(',').every((x) => /^\s*'(js|css)\/os\/[a-z-]+\.(js|css)\?v=\d+'\s*$/.test(x))
      && /var FOCUS_BUNDLE = \[([^\]]*)\]/.exec(code)[1].split(',').every((x) => /^\s*'(js|css)\/os\/[a-z-]+\.(js|css)\?v=\d+'\s*$/.test(x)) && !!acts && acts[1].split(',').every((x) => /^\s*'(js|css)\/os\/[a-z-]+\.(js|css)\?v=\d+'\s*$/.test(x)) && /SL\.loadBundle\(ACTS_BUNDLE\)/.test(code)
      && /SL\.bundles\.oscoachai = \['css\/os\/coach-ai\.css\?v=1', 'js\/os\/coach-ai\.js\?v=1'\];/.test(code) && /loadBundle\('oscoachai'\)/.test(code) && /loadBundle\(P1_BUNDLE\)/.test(code) && /var P1_BUNDLE = 'oshomep1';/.test(code)
      && /loadBundle\('osteam'\)/.test(code)
      && /SL\.bundles\.osdsgoals = \['js\/os\/ds-goals\.js\?v=1'\];/.test(code) && /loadBundle\('osdsgoals'\)/.test(code)
      && JSON.stringify(files.split(',').map((x) => x.trim())) === JSON.stringify(["'js/os/stack-logic.js?v=1'", "'js/os/widgets-p1.js?v=1'"])
      && /var BIZ = 'osdsbiz'/.test(code) && /SL\.bundles\[BIZ\] = \['js\/os\/ds-business\.js\?v=2'\];/.test(code)
      && !!bundle && bundle[1].split(',').every((x) => /^\s*'(js|css)\/os\/[a-z-]+\.(js|css)\?v=\d+'\s*$/.test(x)) && /loadBundle\('osshutdown'\)/.test(code)
      && /loadBundle\('osp2peek'\)/.test(code) && /var PK_BUNDLE = \[([^\]]*)\]/.exec(code)[1].split(',').every((x) => /^\s*'(js|css)\/os\/[a-z-]+\.(js|css)\?v=\d+'\s*$/.test(x)), files);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
