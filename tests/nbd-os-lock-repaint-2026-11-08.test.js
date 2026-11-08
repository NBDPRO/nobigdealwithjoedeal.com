/**
 * tests/nbd-os-lock-repaint-2026-11-08.test.js — NBD OS review finding
 * OS-LOCK-REPAINT (P3): the lock screen and the boot screen repaint.
 *
 *   Lock screen   checkIdle() runs every 15 s while locked and repainted the
 *                 whole cover through innerHTML, so the Unlock button was a new
 *                 node each time and keyboard focus fell to <body>. Now only the
 *                 text that changes (time, counts) is repainted and the button
 *                 node survives, focus with it.
 *   Boot screen   role="status" aria-live="polite", and every 250 ms tick
 *                 rebuilt its whole subtree, so a screen reader heard the same
 *                 status over and over. Now the steps are marked done IN PLACE
 *                 (class + tick glyph) and the list nodes never change.
 *
 * Runs the REAL docs/pro/js/os/system-logic.js + docs/pro/js/os/system.js in a
 * small fake DOM (no jsdom in this repo) that parses the innerHTML strings the
 * layer writes and, like a browser, drops focus to <body> when the focused node
 * leaves the tree. Timers are held and fired by hand; the clock is fixed.
 *
 * Run: node tests/nbd-os-lock-repaint-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

// ── a fixed clock the layer reads through Date / Date.now ────────────────────
let NOW = new Date(2026, 10, 8, 14, 5).getTime();   // Sun, Nov 8, 2:05 PM local
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}

// ── a small fake DOM: elements, text nodes, innerHTML parsing, focus ─────────
function makeDom() {
  const docListeners = { true: {}, false: {} };
  const document = { readyState: 'complete', activeElement: null };
  const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  function matchesSimple(el, sel) {
    let m;
    if ((m = /^\.([\w-]+)$/.exec(sel))) return el.classList.contains(m[1]);
    if ((m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel))) return el.getAttribute(m[1]) === m[2];
    if ((m = /^\[([\w-]+)\]$/.exec(sel))) return el.hasAttribute(m[1]);
    if ((m = /^#([\w-]+)$/.exec(sel))) return el.id === m[1];
    if (/^[a-z][a-z0-9]*$/.test(sel)) return el.tagName === sel.toUpperCase();
    return false;   // anything fancier: no match (the layer looks for a header tray host this page does not have)
  }
  /** Simple selectors and descendant chains ("#osLock button", ".os-boot-steps li"). */
  function matches(el, sel) {
    if (!el || !el.attrs) return false;
    const parts = sel.trim().split(/\s+/);
    if (!matchesSimple(el, parts[parts.length - 1])) return false;
    let n = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (n && n.attrs && !matchesSimple(n, parts[i])) n = n.parentNode;
      if (!n || !n.attrs) return false;
      n = n.parentNode;
    }
    return true;
  }
  /** Like a browser: a focused node that leaves the tree hands focus to <body>. */
  function dropFocusIn(node, includeSelf) {
    const a = document.activeElement;
    if (a && (includeSelf || a !== node) && node.contains(a)) document.activeElement = document.body;
  }
  class Txt {
    constructor(s) { this.nodeType = 3; this.textContent = String(s); this.parentNode = null; }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  }
  class El {
    constructor(tag) {
      this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
      this.className = ''; this.hidden = false; this.id = ''; this.listeners = {}; this.type = ''; this.innerHTMLWrites = 0;
      const self = this;
      this.classList = {
        add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
        remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); return on; },
        contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
      };
    }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._clear(); this.children.push(Object.assign(new Txt(v), { parentNode: this })); }
    get firstChild() { return this.children[0] || null; }
    get innerHTML() {
      return this.children.map((c) => c.attrs
        ? '<' + c.tagName.toLowerCase() + Object.keys(c.attrs).map((k) => ' ' + k + '="' + (k === 'class' ? c.className : c.attrs[k]) + '"').join('') + '>' + c.innerHTML + '</' + c.tagName.toLowerCase() + '>'
        : c.textContent).join('');
    }
    /** Parse the layer's markup: tags with quoted attributes, escaped text, no void tags (it emits none). */
    set innerHTML(html) {
      this.innerHTMLWrites++;
      this._clear();
      const stack = [this];
      const re = /<\/([a-z][a-z0-9]*)>|<([a-z][a-z0-9]*)((?:\s+[a-z][\w-]*(?:="[^"]*")?)*)\s*>|([^<]+)/gi;
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
          stack.push(el);
        } else if (m[4]) top.appendChild(new Txt(unesc(m[4])));
      }
    }
    _clear() { dropFocusIn(this, false); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); if (k === 'type') this.type = String(v); }
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
    removeChild(c) { c.remove(); return c; }
    remove() { dropFocusIn(this, true); if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
    contains(o) { while (o) { if (o === this) return true; o = o.parentNode; } return false; }
    closest(sel) { let n = this; while (n && n.attrs) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) { const out = []; (function walk(n) { n.children.forEach((c) => { if (!c.attrs) return; if (matches(c, sel)) out.push(c); walk(c); }); })(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    focus() { document.activeElement = this; }
  }
  document.createElement = (t) => new El(t);
  document.body = new El('body');
  document.head = new El('head');
  document.documentElement = new El('html');
  document.activeElement = document.body;
  document.addEventListener = (t, fn, opt) => { const cap = !!(opt === true || (opt && opt.capture)); (docListeners[cap][t] = docListeners[cap][t] || []).push(fn); };
  document.removeEventListener = (t, fn, opt) => { const cap = !!(opt === true || (opt && opt.capture)); docListeners[cap][t] = (docListeners[cap][t] || []).filter((f) => f !== fn); };
  document.getElementById = (id) => document.body.querySelectorAll('#' + id)[0] || null;
  document.querySelector = (sel) => document.body.querySelector(sel) || document.head.querySelector(sel);
  document.querySelectorAll = (sel) => document.body.querySelectorAll(sel).concat(document.head.querySelectorAll(sel));
  document.contains = (n) => n === document.body || document.body.contains(n);
  /** Dispatch like a browser: document capture, then target and its ancestors, then document bubble. */
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
  return { document, El, fire };
}

/** Boot the real System layer in a fake dashboard. Timers are held; the test fires them. */
function bootSystem(opts) {
  opts = opts || {};
  const { document, fire } = makeDom();
  const other = document.createElement('button'); other.id = 'other'; other.textContent = 'Elsewhere';
  document.body.appendChild(other);
  const timers = [];
  const hold = (kind) => (fn, ms) => { timers.push({ fn, ms, kind }); return timers.length; };
  const drop = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  const store = {}, session = {};
  const win = {
    document, console, Date: FakeDate,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: (k) => (k in session ? session[k] : null), setItem: (k, v) => { session[k] = String(v); } },
    matchMedia: () => ({ matches: false }),
    navigator: { onLine: true },
    addEventListener() {},
    setInterval: hold('interval'), clearInterval: drop, setTimeout: hold('timeout'), clearTimeout: drop,
    _companyProfile: { businessName: 'Test Co' },
    _user: opts.user || null,
  };
  if (opts.leads !== undefined) win._leads = opts.leads;
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(read('docs/pro/js/os/system-logic.js'), ctx, { filename: 'system-logic.js' });
  vm.runInContext(read('docs/pro/js/os/system.js'), ctx, { filename: 'system.js' });
  /** Run every live interval with this period once (15000 = checkIdle, 250 = the boot tick). */
  const tick = (ms) => timers.filter((t) => t.kind === 'interval' && t.ms === ms && t.fn).forEach((t) => t.fn());
  const runTimeouts = (ms) => timers.filter((t) => t.kind === 'timeout' && t.ms === ms && t.fn).forEach((t) => { const fn = t.fn; t.fn = null; fn(); });
  const intervals = () => timers.filter((t) => t.kind === 'interval' && t.fn).map((t) => t.ms);
  return { win, document, fire, other, tick, runTimeouts, intervals };
}

console.log('\n1. lock screen: the 15 s repaint keeps the Unlock button, and focus on it');
{
  const P = bootSystem({ leads: [] });   // data already in: no boot screen
  const text = (sel) => { const e = P.document.querySelector(sel); return e ? e.textContent : null; };
  const lines = () => P.document.querySelectorAll('.os-lock-lines li').map((l) => l.textContent).join('|');
  ok('the layer is up, with the idle check on a 15 s interval', P.win.NBDOS && P.intervals().indexOf(15000) >= 0, P.intervals().join(','));
  ok('no boot screen once the data is in', !P.document.getElementById('osBoot'));
  P.other.focus();
  P.win.NBDOS.lock();
  const lockEl = P.document.getElementById('osLock');
  const btn = lockEl && lockEl.querySelector('[data-os="unlock"]');
  ok('lock() paints the cover: one dialog, one Unlock button, focused', !!btn && lockEl.getAttribute('role') === 'dialog' && lockEl.querySelectorAll('button').length === 1 && P.document.activeElement === btn);
  ok('time and date are on it', text('.os-lock-time') === '2:05 PM' && text('.os-lock-date') === 'Sun, Nov 8', text('.os-lock-time') + ' / ' + text('.os-lock-date'));
  ok('a calm lock screen', lines() === 'No new notifications', lines());
  // a minute passes, two notifications land, the connection drops with three changes queued; the idle check runs
  NOW += 60000;
  P.win.NotifBell = { getCount: () => 2 };
  P.win.NBDOfflineSync = { pending: () => 3 };
  P.win.navigator.onLine = false;
  P.tick(15000);
  ok('the repaint updates the time', text('.os-lock-time') === '2:06 PM', text('.os-lock-time'));
  ok('...and the counts (still counts only)', lines() === '2 notifications waiting|Offline · 3 changes saved here', lines());
  ok('the Unlock button is the SAME node after the repaint (not rebuilt through innerHTML)', lockEl.querySelector('[data-os="unlock"]') === btn);
  ok('keyboard focus stays on it, not dropped to <body>', P.document.activeElement === btn, P.document.activeElement && (P.document.activeElement.tagName + '#' + P.document.activeElement.id));
  ok('still one button on the cover', lockEl.querySelectorAll('button').length === 1, lockEl.innerHTML);
  P.tick(15000); P.tick(15000); P.tick(15000);
  ok('three more ticks: same button, same focus', lockEl.querySelector('[data-os="unlock"]') === btn && P.document.activeElement === btn);
  P.fire(btn, 'click');
  ok('a tap on the surviving button unlocks', !P.win.NBDOS.isLocked() && !P.document.getElementById('osLock'));
  ok('focus goes back where it was before the lock', P.document.activeElement === P.other);
  P.win.NBDOS.lock();
  P.tick(15000);
  P.fire(P.document.activeElement, 'keydown', { key: 'Escape' });
  ok('Escape after a repaint still unlocks', !P.win.NBDOS.isLocked());
}

console.log('\n2. boot screen: progress is marked in place, the live region is not rebuilt every 250 ms');
{
  const P = bootSystem({});   // not signed in, no data yet: the boot screen shows
  const el = P.document.getElementById('osBoot');
  ok('the boot screen is up: role=status, aria-live=polite, ticking every 250 ms', !!el && el.getAttribute('role') === 'status' && el.getAttribute('aria-live') === 'polite' && P.intervals().indexOf(250) >= 0);
  const ol = el.querySelector('.os-boot-steps');
  const li = ol ? ol.querySelectorAll('li') : [];
  const label = (l) => l.textContent.replace(/✓/g, '');
  const tickOf = (l) => l.querySelector('.os-boot-tick').textContent;
  const labelNode = li[1] && li[1].children[1];
  ok('three steps, none done yet', li.length === 3 && li.every((x) => !x.classList.contains('is-done') && tickOf(x) === ''), ol && ol.innerHTML);
  ok('it names the company', /Starting Test Co/.test(el.textContent), el.textContent);
  P.tick(250);
  ok('a tick with nothing new leaves the step list alone (same <ol>, same <li> nodes)', el.querySelector('.os-boot-steps') === ol && ol.querySelectorAll('li')[0] === li[0]);
  P.win._user = { uid: 'u1' };
  P.tick(250);
  ok('signed in: the first step is marked done IN PLACE (same <li>, is-done, a tick glyph)', ol.querySelectorAll('li')[0] === li[0] && li[0].classList.contains('is-done') && tickOf(li[0]) === '✓', ol.innerHTML);
  ok('the other two are still pending', !li[1].classList.contains('is-done') && !li[2].classList.contains('is-done') && tickOf(li[1]) === '' && tickOf(li[2]) === '');
  ok('the labels never changed, and a label text node is the very same object (nothing new to announce)',
    li.map(label).join('|') === 'Signing you in|Loading your jobs and leads|Ready' && li[1].children[1] === labelNode, li.map(label).join('|'));
  P.tick(250); P.tick(250);
  ok('more ticks, still the same nodes', el.querySelector('.os-boot-steps') === ol && ol.querySelectorAll('li')[2] === li[2]);
  ok('the live region was written once (the build), never on a tick', el.innerHTMLWrites === 1, el.innerHTMLWrites);
  P.win._leads = [];
  P.tick(250);
  ok('data in: every step done, same nodes', li.every((x) => x.classList.contains('is-done') && tickOf(x) === '✓') && el.querySelector('.os-boot-steps') === ol, ol.innerHTML);
  ok('...and the boot screen starts leaving, its interval cleared', el.classList.contains('is-leaving') && P.intervals().indexOf(250) < 0);
  P.runTimeouts(220);
  ok('gone 220 ms later', !P.document.getElementById('osBoot'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
