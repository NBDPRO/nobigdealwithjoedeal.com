/**
 * tests/nbd-os-killswitch-first-load-2026-11-08.test.js — the osSystemLayer
 * kill switch on a FIRST load (OS-KILLSWITCH-FIRST-LOAD).
 *
 * The NBD OS System layer is on unless feature_flags sets osSystemLayer to
 * exactly false. boot() paints it from the last-known per-account cache
 * without waiting for the flag read, so a tenant on a NEW device (empty cache)
 * got the tray once even with the switch off: the live false arrived after
 * the layer was up and nothing took it down. Now `nbd:flags-loaded` carrying
 * an exact false tears the layer down (NBDOS.off(): tray, boot screen, html
 * class, Spotlight entries, and no more painting) and the cache records the
 * false so the next load never paints it.
 *
 * Runs the REAL docs/pro/js/layout-system.js engine and the REAL
 * docs/pro/js/os/system-logic.js + os/system.js in a small fake DOM (no jsdom
 * in this repo): boot with an empty cache and no flags, watch the tray paint,
 * then deliver the flags.
 *
 * Run: node tests/nbd-os-killswitch-first-load-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const SYS_SRC = read('docs/pro/js/layout-system.js');
const LOGIC_SRC = read('docs/pro/js/os/system-logic.js');
const OS_SRC = read('docs/pro/js/os/system.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 5));

// ── a small fake DOM: the engine's asset tags, the layer's tray and boot screen ──
function matchOne(el, part) {
  part = part.replace(/:[\w-]+(\([^)]*\))?/g, '');
  const tag = (part.match(/^[a-z][\w-]*/i) || [''])[0];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const id = (part.match(/#([\w-]+)/) || [])[1];
  if (id && el.id !== id) return false;
  const classes = part.replace(/\[[^\]]*\]/g, '').match(/\.([\w-]+)/g) || [];
  for (const c of classes) if (!el.classList.contains(c.slice(1))) return false;
  const attrs = part.match(/\[[^\]]+\]/g) || [];
  for (const a of attrs) {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
    if (!m || !el.hasAttribute(m[1]) || (m[2] !== undefined && el.getAttribute(m[1]) !== m[2])) return false;
  }
  return true;
}
function chainOk(el, parts) {
  let i = parts.length - 2, n = el.parentNode;
  while (i >= 0 && n) { if (n.tagName && matchOne(n, parts[i])) i--; n = n.parentNode; }
  return i < 0;
}
function queryAll(rootEl, sel) {
  const out = [];
  String(sel).split(',').forEach((one) => {
    const parts = one.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    (function walk(n) {
      n.children.forEach((c) => {
        if (matchOne(c, parts[parts.length - 1]) && chainOk(c, parts) && out.indexOf(c) < 0) out.push(c);
        walk(c);
      });
    })(rootEl);
  });
  return out;
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {};
    this.className = ''; this.id = ''; this.hidden = false; this._html = ''; this._text = ''; this._l = {};
    const self = this;
    this.classList = {
      add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
    };
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.children.indexOf(ref) : -1;
    c.parentNode = this;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  contains(o) { while (o) { if (o === this) return true; o = o.parentNode; } return false; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((x) => x !== f); }
  focus() {}
}

// A CRM page as the layer sees it: <header><div class="hright">…</div></header>,
// an empty per-account flag cache unless `storage` says otherwise, flags not
// loaded yet. Scripts the engine appends for the System layer run for REAL.
function makeBrowser(opts) {
  const o = opts || {};
  const documentElement = new El('html');
  const head = new El('head'), body = new El('body');
  documentElement.appendChild(head); documentElement.appendChild(body);
  const header = new El('header'), hright = new El('div'), bell = new El('button');
  hright.className = 'hright'; bell.id = 'notifBell';
  hright.appendChild(bell); header.appendChild(hright); body.appendChild(header);

  const docListeners = {}, winListeners = {};
  const store = Object.assign({}, o.storage || {});
  const session = {};
  const commands = {};
  const appended = [], ran = [];
  let ctx = null;
  const document = {
    readyState: 'complete', documentElement, head, body, activeElement: null,
    createElement: (tag) => new El(tag),
    getElementById: (id) => queryAll(documentElement, '#' + id)[0] || null,
    querySelectorAll: (sel) => queryAll(documentElement, sel),
    querySelector: (sel) => queryAll(documentElement, sel)[0] || null,
    contains: (el) => documentElement.contains(el),
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener(t, f) { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f); },
    dispatchEvent(ev) { (docListeners[ev.type] || []).slice().forEach((f) => f(ev)); return true; },
  };
  head.appendChild = function (el) {
    El.prototype.appendChild.call(head, el);
    appended.push(el);
    if (el.tagName === 'LINK') setTimeout(() => (el._l.load || []).forEach((f) => f()), 0);
    if (el.tagName === 'SCRIPT') setTimeout(() => {
      const src = String(el.src || '');
      if (/\/os\/system-logic\.js/.test(src)) { ran.push('logic'); vm.runInContext(LOGIC_SRC, ctx, { filename: 'system-logic.js' }); }
      else if (/\/os\/system\.js/.test(src)) { ran.push('system'); vm.runInContext(OS_SRC, ctx, { filename: 'system.js' }); }
      if (typeof el.onload === 'function') el.onload();
    }, 0);
    return el;
  };
  const win = {
    document, innerWidth: 1280,
    matchMedia: () => ({ matches: false }),
    addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
    removeEventListener(t, f) { winListeners[t] = (winListeners[t] || []).filter((x) => x !== f); },
    dispatchEvent(ev) { (winListeners[ev.type] || []).slice().forEach((f) => f(ev)); return true; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: (k) => (k in session ? session[k] : null), setItem: (k, v) => { session[k] = String(v); } },
    navigator: { onLine: true },
    _user: null,
    db: {}, doc: (...a) => ({ path: a.slice(1).join('/') }),
    getDoc: () => Promise.resolve({ exists: () => false, data: () => null, metadata: { fromCache: false } }),
    setDoc: () => Promise.resolve(),
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    NBDCommand: { registerAction(a) { commands[a.id] = a; }, unregisterAction(id) { delete commands[id]; } },
    console,
  };
  ctx = vm.createContext(win);
  ctx.window = ctx;
  vm.runInContext(SYS_SRC, ctx, { filename: 'layout-system.js' });
  return { ctx, document, documentElement, store, commands, appended, ran };
}
// feature_flags arrives: the real NBDFlags shape, with the account known by then
function deliverFlags(b, flags) {
  b.ctx._user = { uid: 'u1' };
  b.ctx.NBDFlags = {
    __sentinel: 'nbd-flags-v1', load() {}, gate() {},
    get: (n) => flags[n], enabled: (n) => !!flags[n], isLoaded: () => true,
  };
  b.ctx.dispatchEvent(new b.ctx.CustomEvent('nbd:flags-loaded'));
}
const src = (el) => String(el.href || el.src || '');

(async () => {
  console.log('\n1. first load from an empty cache, then osSystemLayer:false arrives');
  {
    const b = makeBrowser({});
    await tick(40);
    ok('control: with no cache the layer loads before the flag read (css, logic, system.js)',
      b.ran.join(',') === 'logic,system' && b.appended.some((el) => /os\/system\.css/.test(src(el))), b.ran.join(',') + ' | ' + b.appended.map(src).join(', '));
    ok('control: the real layer painted the tray into header .hright and stamped html.os-system',
      !!b.document.getElementById('osTray') && b.document.getElementById('osTray').parentNode.className === 'hright'
      && b.documentElement.classList.contains('os-system'), b.documentElement.className);
    ok('control: the boot screen is up and Spotlight has the System entries',
      !!b.document.getElementById('osBoot') && Object.keys(b.commands).length >= 5, Object.keys(b.commands).join(','));

    deliverFlags(b, { osSystemLayer: false });
    await tick(120);
    ok('the cache records the false for this account (the next load never paints it)',
      (() => { const c = JSON.parse(b.store.nbd_layout_flags || 'null'); return !!c && c.uid === 'u1' && c.flags.osSystemLayer === false; })(), b.store.nbd_layout_flags);
    ok('the layer exposes a teardown (NBDOS.off)', b.ctx.NBDOS && typeof b.ctx.NBDOS.off === 'function');
    ok('the tray is gone', b.document.getElementById('osTray') === null);
    ok('the boot screen is gone', b.document.getElementById('osBoot') === null);
    ok('html.os-system is gone', !b.documentElement.classList.contains('os-system'), b.documentElement.className);
    ok('the Spotlight entries are unregistered', Object.keys(b.commands).length === 0, Object.keys(b.commands).join(','));

    // nothing paints it back: the layer's own refresh paths and the events it listens to
    if (b.ctx.NBDOS) b.ctx.NBDOS.refresh();
    b.ctx.dispatchEvent(new b.ctx.CustomEvent('nbd:notifs-updated'));
    b.document.dispatchEvent(new b.ctx.CustomEvent('layoutchange', { detail: { layout: 'classic' } }));
    b.document.dispatchEvent(new b.ctx.CustomEvent('themechange'));
    await tick(120);
    ok('refresh(), nbd:notifs-updated, layoutchange and themechange paint nothing after the teardown',
      b.document.getElementById('osTray') === null && Object.keys(b.commands).length === 0, Object.keys(b.commands).join(','));
    ok('a second flags-loaded with false is a no-op (teardown is idempotent)',
      (() => { try { deliverFlags(b, { osSystemLayer: false }); if (b.ctx.NBDOS) b.ctx.NBDOS.off(); return true; } catch (e) { return e.message; } })() === true);
    await tick(20);
    ok('still nothing painted', b.document.getElementById('osTray') === null);
  }

  console.log('\n2. control: the flags arrive ON (or unset) and the layer stays');
  {
    const b = makeBrowser({});
    await tick(40);
    deliverFlags(b, {});
    await tick(120);
    ok('unset flag: the tray and the Spotlight entries stay', !!b.document.getElementById('osTray') && Object.keys(b.commands).length >= 5);
    ok('unset flag: the cache records on', JSON.parse(b.store.nbd_layout_flags).flags.osSystemLayer === true);
    const b2 = makeBrowser({});
    await tick(40);
    deliverFlags(b2, { osSystemLayer: true, osLayout: true });
    await tick(120);
    ok('true: the tray stays and html.os-system stays', !!b2.document.getElementById('osTray') && b2.documentElement.classList.contains('os-system'));
  }

  console.log('\n3. control: a cached false never loads the layer, and a live false then has nothing to tear down');
  {
    const b = makeBrowser({ storage: { nbd_layout_flags: JSON.stringify({ uid: null, flags: { osSystemLayer: false } }) } });
    await tick(40);
    ok('nothing of the layer is loaded', b.ran.length === 0 && !b.appended.some((el) => /os\/system/.test(src(el))), b.appended.map(src).join(', '));
    let threw = null;
    try { deliverFlags(b, { osSystemLayer: false }); await tick(60); } catch (e) { threw = e; }
    ok('the live false does not throw with no layer loaded', threw === null && !b.ctx.NBDOS, threw && threw.message);
  }

  console.log('\n4. wiring (static)');
  ok('onFlagsLoaded tears the layer down when the flag is exactly false and the layer was loaded',
    /if \(flags\[SYSTEM_FLAG\]\) loadSystemLayer\(\);(\s*\n\s*\/\/[^\n]*)*\s*\n\s*else if \(systemLoading\)/.test(SYS_SRC));
  ok('the teardown is reached through the load promise and a typeof guard', /systemLoading\.then\(function \(\) \{[^}]*typeof S\.off === 'function'/.test(SYS_SRC));
  ok('system.js exports off', /\boff: off\b/.test(OS_SRC));
  ok('the engine keeps the default: on unless exactly false', /cachedFlags\(\)\[SYSTEM_FLAG\] !== false\) loadSystemLayer\(\)/.test(SYS_SRC)
    && /flags\[n\] = window\.NBDFlags\.get\(n\) !== false;/.test(SYS_SRC));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
