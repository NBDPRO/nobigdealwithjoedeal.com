/**
 * tests/sms-outbox-client.test.js — the browser half of the offline SMS
 * outbox: docs/pro/js/nbd-comms.js + docs/pro/js/sms-outbox.js, and every
 * NBDComms.sendSMS consumer's handling of mode 'queued'.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Offline, NBDComms.sendSMS used to open the rep's Messages app with the text
 * filled in — which over cellular SMS sends at once, with no opt-out check
 * and nothing in sms_log. It now stores the text (IndexedDB) and replays it
 * through sendSMS with `queued: true` when the app is back online; the server
 * re-checks everything (tests/sms-outbox-server.test.js). This suite RUNS the
 * real nbd-comms.js and sms-outbox.js in a vm — against an in-memory
 * IndexedDB that models transaction lifetime, a stub fetch, and a small DOM —
 * so it asserts what the page DOES, not what the source says:
 *
 *   - offline → queued, never an sms: handoff; the live 402/429/403/5xx
 *     contract from #1667 is untouched
 *   - no IndexedDB → the pre-outbox handoff (documented fallback)
 *   - the per-user cap refuses out loud
 *   - flush: stale → held without a server call; duplicates collapse (and are
 *     recorded); per-recipient FIFO; single-flight in a tab and across tabs;
 *     each server answer lands in the right state; never a handoff
 *   - the tray: pill only when something waits; the right buttons per
 *     reason; "Send now" = overrideStale only; "Send anyway" adds
 *     overrideActivity
 *   - purge on sign-out (nbd-auth.js purgeSmsOutbox, dashboard _signOut) and
 *     on account switch
 *   - every consumer treats 'queued' as NOT sent
 *
 * Zero deps. Run: node tests/sms-outbox-client.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
// Working-tree files are CRLF on Windows checkouts and LF in CI; normalise so
// the lifted-source markers below match either way.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const COMMS_SRC = read('docs/pro/js/nbd-comms.js');
const OUTBOX_SRC = read('docs/pro/js/sms-outbox.js');
const AUTH_SRC = read('docs/pro/js/nbd-auth.js');
const BOOT_SRC = read('docs/pro/js/dashboard-bootstrap.module.js');
const INV_SRC = read('docs/pro/js/invoice-pipeline.js');
const CB_SRC = read('docs/pro/js/close-board.js');
const PLH_SRC = read('docs/pro/js/portal-link-helpers.js');
const SF_SRC = read('docs/pro/js/smart-followup.js');
const PANEL_SRC = read('docs/pro/js/customer-smart-followup-panel.js');
const D2D_SRC = read('docs/pro/js/d2d-tracker-core-2026b.js');

const QUIET = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

// A promise that never settles lets Node drain its event loop and exit 0
// halfway through the suite. Finishing is part of passing.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.log('\n✗ suite exited before finishing (a promise never settled)');
    process.exitCode = 1;
  }
});
const MIN = 60 * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) { if (await cond()) return true; await wait(2); }
  return !!(await cond());
}

// ── In-memory IndexedDB with transaction lifetime ───────────────────────
// A transaction auto-commits once its request queue drains; a failing request
// aborts it and rolls back its writes. `disk` outlives any one page, so two
// "tabs" (two vm contexts) share it the way two real tabs share an origin.
// Transactions on one store run ONE AT A TIME, in creation order, across
// every connection — real IndexedDB never lets two readwrite transactions
// with overlapping scope interleave, and that is exactly the guarantee the
// outbox's queued→sending compare-and-set relies on across tabs.
const _tails = new WeakMap();
// setImmediate, not setTimeout(0): same async-macrotask semantics, without
// the ~1-15ms Windows timer floor on every simulated IndexedDB hop.
const later = (fn) => setImmediate(fn);
function makeIDB(disk) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function makeTx(table, mode) {
    const tx = { mode, error: null, oncomplete: null, onabort: null, _pending: 0, _settled: false, _undo: [], _abort: null };
    const ready = _tails.get(table) || Promise.resolve();
    let release;
    _tails.set(table, new Promise((r) => { release = r; }));
    const finish = () => {
      if (tx._settled) return;
      tx._settled = true;
      if (tx._abort) {
        tx._undo.reverse().forEach((u) => u());
        tx.error = { name: tx._abort };
        if (tx.onabort) tx.onabort({ target: tx });
      } else if (tx.oncomplete) tx.oncomplete({ target: tx });
      release();
    };
    const drain = () => { if (tx._pending === 0) later(finish); };
    ready.then(() => later(drain));
    function request(apply) {
      if (tx._settled) { const e = new Error('inactive'); e.name = 'TransactionInactiveError'; throw e; }
      if (mode === 'readonly' && apply.write) { const e = new Error('readonly'); e.name = 'ReadOnlyError'; throw e; }
      const req = { onsuccess: null, onerror: null, result: undefined, error: null };
      tx._pending++;
      ready.then(() => later(() => {
        if (tx._settled) { tx._pending--; return; }
        try {
          if (apply.write && disk.failWrites) { const e = new Error('w'); e.name = disk.failWrites; throw e; }
          req.result = apply();
        } catch (e) {
          req.error = { name: e.name || 'Error' };
          if (req.onerror) req.onerror({ target: req });
          tx._abort = tx._abort || req.error.name;
          tx._pending--;
          later(finish);
          return;
        }
        if (req.onsuccess) req.onsuccess({ target: req });
        tx._pending--;
        drain();
      }));
      return req;
    }
    const w = (fn) => { fn.write = true; return fn; };
    const store = {
      get: (k) => request(() => clone(table.get(k))),
      getAll: () => request(() => [...table.values()].map(clone)),
      put: (v) => request(w(() => {
        const prev = table.get(v.id); table.set(v.id, clone(v));
        tx._undo.push(() => (prev === undefined ? table.delete(v.id) : table.set(v.id, prev)));
        return v.id;
      })),
      add: (v) => request(w(() => {
        if (table.has(v.id)) { const e = new Error('exists'); e.name = 'ConstraintError'; throw e; }
        table.set(v.id, clone(v)); tx._undo.push(() => table.delete(v.id));
        return v.id;
      })),
      delete: (k) => request(w(() => {
        const prev = table.get(k); table.delete(k);
        tx._undo.push(() => { if (prev !== undefined) table.set(k, prev); });
      })),
      clear: () => request(w(() => {
        const prev = new Map(table); table.clear();
        tx._undo.push(() => { for (const [k, v] of prev) table.set(k, v); });
      })),
    };
    tx.objectStore = () => store;
    tx.abort = () => { tx._abort = tx._abort || 'AbortError'; later(finish); };
    return tx;
  }
  return {
    open(name) {
      if (disk.throwOnOpen) { const e = new Error('open threw'); e.name = 'InvalidStateError'; throw e; }
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
      later(() => {
        if (disk.failOpen) { req.error = { name: 'UnknownError' }; if (req.onerror) req.onerror({ target: req }); return; }
        const isNew = !disk.dbs[name];
        if (isNew) disk.dbs[name] = { stores: {} };
        const rec = disk.dbs[name];
        req.result = {
          objectStoreNames: { contains: (s) => !!rec.stores[s] },
          createObjectStore: (s, o) => { rec.stores[s] = new Map(); rec.keyPath = o && o.keyPath; return {}; },
          transaction: (s, mode) => {
            if (!disk.dbs[name] || !rec.stores[s]) { const e = new Error('gone'); e.name = 'InvalidStateError'; throw e; }
            return makeTx(rec.stores[s], mode || 'readonly');
          },
          close() {}, onclose: null, onversionchange: null,
        };
        if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    deleteDatabase(name) {
      const req = { onsuccess: null, onerror: null, onblocked: null };
      later(() => { delete disk.dbs[name]; disk.deleted.push(name); if (req.onsuccess) req.onsuccess({ target: req }); });
      return req;
    },
  };
}
const newDisk = () => ({ dbs: {}, deleted: [] });
const rowsOn = (disk) => {
  const db = disk.dbs['nbd-sms-outbox-db'];
  return db && db.stores.outbox ? [...db.stores.outbox.values()] : [];
};

// ── A small DOM ─────────────────────────────────────────────────────────
function makeDocument() {
  const doc = { _listeners: {}, _clicks: [] };
  function matchesOne(el, sel) {
    sel = sel.trim();
    const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const v = el.getAttribute(attr[1]);
      return attr[2] === undefined ? v !== null : v === attr[2];
    }
    if (sel[0] === '#') return el.id === sel.slice(1);
    if (sel[0] === '.') return sel.slice(1).split('.').every((c) => el.classList.contains(c));
    return el.tagName === sel.toUpperCase();
  }
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this._attrs = {}; this._text = '';
      this.className = ''; this.disabled = false; this.value = ''; this.type = '';
      const style = {}; style.setProperty = (k, v) => { style[k] = v; }; style.cssText = '';
      this.style = style;
    }
    get id() { return this._attrs.id || ''; }
    set id(v) { this._attrs.id = String(v); }
    get classList() {
      const el = this;
      const list = () => el.className.split(/\s+/).filter(Boolean);
      return {
        add: (c) => { const s = new Set(list()); s.add(c); el.className = [...s].join(' '); },
        remove: (c) => { el.className = list().filter((x) => x !== c).join(' '); },
        contains: (c) => list().includes(c),
        toggle: (c, f) => { const on = f === undefined ? !list().includes(c) : f; if (on) el.classList.add(c); else el.classList.remove(c); },
      };
    }
    setAttribute(k, v) { if (k === 'class') this.className = String(v); else this._attrs[k] = String(v); }
    getAttribute(k) { if (k === 'class') return this.className; return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    matches(sel) { return sel.split(',').some((s) => matchesOne(this, s)); }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); });
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { let n = this; while (n && n.matches) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    getClientRects() { return []; }
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
    focus() {}
    click() { doc._clicks.push(this); }
  }
  doc.createElement = (t) => new El(t);
  doc.documentElement = new El('html');
  doc.head = new El('head');
  doc.body = new El('body');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.documentElement.querySelector('#' + id);
  doc.querySelector = (s) => doc.documentElement.querySelector(s);
  doc.querySelectorAll = (s) => doc.documentElement.querySelectorAll(s);
  doc.addEventListener = (type, fn) => { (doc._listeners[type] = doc._listeners[type] || []).push(fn); };
  doc.removeEventListener = () => {};
  doc.contains = (n) => doc.documentElement.contains(n);
  doc.visibilityState = 'visible';
  doc.readyState = 'complete';
  doc.clickOn = (el) => (doc._listeners.click || []).forEach((fn) => fn({ target: el }));
  return doc;
}

// ── A page: nbd-comms.js (+ sms-outbox.js) in one vm context ────────────
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const OK200 = () => jsonRes(200, { success: true, sid: 'SM1' });

function loadPage(opts) {
  opts = opts || {};
  const toasts = [];
  const posts = [];
  const events = [];
  const winListeners = {};
  const document = makeDocument();
  const LS = opts.localStorage || {};
  const navigator = Object.assign({ onLine: opts.online !== false }, opts.navigator || {});
  const longTimers = [];
  const disk = opts.disk || newDisk();
  const window = {
    console: QUIET, document, navigator,
    location: { hostname: 'nobigdealwithjoedeal.com', href: 'https://nobigdealwithjoedeal.com/pro/dashboard.html' },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null),
      setItem: (k, v) => { LS[k] = String(v); },
      removeItem: (k) => { delete LS[k]; },
    },
    crypto: { randomUUID: () => nodeCrypto.randomUUID(), getRandomValues: (a) => nodeCrypto.randomFillSync(a) },
    showToast: (msg, type) => toasts.push({ msg: String(msg), type }),
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (e) => { events.push(e); (winListeners[e.type] || []).forEach((fn) => fn(e)); return true; },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      const respond = opts.respond || OK200;
      const r = await respond(body, posts.length, url);
      if (r instanceof Error) throw r;
      return r;
    },
    AbortController,
    // A shared bus lets two "tabs" (two contexts) talk like BroadcastChannel.
    BroadcastChannel: opts.bus || undefined,
    setTimeout: (fn, ms) => {
      // Long timers (the 25s fetch abort, the 60s retry) never fire here;
      // they are recorded so a test can assert one was scheduled.
      if (ms >= 1000) { const id = { fake: true, ms, fn }; longTimers.push(id); return id; }
      return setTimeout(fn, ms);
    },
    clearTimeout: (id) => { if (id && id.fake) { const i = longTimers.indexOf(id); if (i >= 0) longTimers.splice(i, 1); } else clearTimeout(id); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref && t.unref(); return t; },
    clearInterval,
    Promise, Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Map, Set,
    Uint8Array, encodeURIComponent, decodeURIComponent, isFinite, isNaN, parseInt, URL,
    nbdModal: {
      open: (el) => { el.classList.add('open'); return el; },
      close: (el) => { el.classList.remove('open'); },
    },
    _user: opts.user === null ? null : (opts.user || { uid: 'rep-1', getIdToken: async () => 'id-token' }),
  };
  if (!opts.noIndexedDB) window.indexedDB = makeIDB(disk);
  window.window = window;
  window.self = window;
  if (opts.leads) window._leads = opts.leads;
  if (opts.before) opts.before(window);
  const ctx = vm.createContext(window);
  vm.runInContext(COMMS_SRC, ctx, { filename: 'nbd-comms.js' });
  // Scripts that load BEFORE sms-outbox.js on the real page (dashboard.html
  // loads portal-link-helpers.js earlier).
  (opts.preOutbox || []).forEach(([src, filename]) => vm.runInContext(src, ctx, { filename }));
  if (!opts.noOutbox) vm.runInContext(OUTBOX_SRC, ctx, { filename: 'sms-outbox.js' });
  const smsLinks = () => document._clicks.map((a) => String(a.href || '')).filter((h) => /^sms:/.test(h));
  return {
    window, document, toasts, posts, events, disk, LS, longTimers, smsLinks,
    ob: window.NBDSmsOutbox, comms: window.NBDComms,
    fire: (type) => (winListeners[type] || []).forEach((fn) => fn({ type })),
    rows: () => rowsOn(disk),
  };
}

// BroadcastChannel stand-in shared by every page built with the same bus.
function makeBus() {
  const chans = [];
  return function FakeBroadcastChannel(name) {
    const self = this;
    self.name = name;
    self.onmessage = null;
    self.postMessage = (m) => chans
      .filter((c) => c !== self && c.name === name)
      .forEach((c) => setImmediate(() => { if (c.onmessage) c.onmessage({ data: m }); }));
    self.close = () => {};
    chans.push(self);
  };
}

async function booted(h) {
  // Boot: wait for the user, purge other accounts, first flush.
  await wait(15);
  if (h.ob) await h.ob.flush('test-settle');
  await wait(5);
}

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced ' + name);
}
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced block ' + marker);
}

const SMS = { to: '(859) 555-0134', message: 'Running 10 min late', leadId: 'lead-1' };

(async () => {
  // ═══ 1. offline → queued, never a handoff ══════════════════════════════
  console.log('1. OFFLINE — queued in the outbox, never an sms: handoff');
  {
    const h = loadPage({ online: false, leads: [{ id: 'lead-1', stage: 'inspection' }] });
    await booted(h);
    const r = await h.comms.sendSMS(Object.assign({ source: 'test', sourceRef: 'ref-1' }, SMS));
    ok('navigator offline: result { success: true, mode: "queued", id }',
      r.success === true && r.mode === 'queued' && typeof r.id === 'string' && r.id.length >= 16, JSON.stringify(r));
    ok('navigator offline: NO fetch attempted', h.posts.length === 0);
    ok('navigator offline: NO sms: link opened', h.smsLinks().length === 0, JSON.stringify(h.smsLinks()));
    ok('toast: "Queued — will send when you\'re back online"',
      h.toasts.some((t) => /Queued — will send when you're back online/.test(t.msg)), JSON.stringify(h.toasts));
    const rec = h.rows()[0] || {};
    ok('the stored record carries uid, to as entered, toDigits, body, leadId, source, sourceRef',
      rec.uid === 'rep-1' && rec.to === '(859) 555-0134' && rec.toDigits === '8595550134'
      && rec.body === 'Running 10 min late' && rec.leadId === 'lead-1' && rec.source === 'test' && rec.sourceRef === 'ref-1',
      JSON.stringify(rec));
    ok('…status "queued", attempts 0, createdAt a timestamp, id === the returned id',
      rec.status === 'queued' && rec.attempts === 0 && typeof rec.createdAt === 'number' && rec.id === r.id);
    ok('…and the lead\'s stage at queue time, looked up from window._leads', rec.leadStageAtQueue === 'inspection', rec.leadStageAtQueue);
  }
  {
    // The request takes 60ms to fail — long enough to tell "stamped before
    // the attempt" from "stamped after it failed".
    const h = loadPage({ respond: async () => { await wait(60); return new TypeError('Failed to fetch'); } });
    await booted(h);
    const before = Date.now();
    const r = await h.comms.sendSMS(SMS);
    const createdAt = (h.rows()[0] || {}).createdAt;
    ok('online but fetch rejects (status 0): queued, not handed off',
      r.mode === 'queued' && h.smsLinks().length === 0 && h.rows().length === 1, JSON.stringify(r));
    ok('createdAt is the attempt START (before the request), so the server sees a send that raced it',
      createdAt >= before - 5 && createdAt < before + 30, (createdAt - before) + 'ms after the call');
    ok('a retry flush is scheduled (no "online" event will come while the browser says online)',
      h.longTimers.some((t) => t.ms === 60000));
    const live = (h.posts[0] || { body: {} }).body;
    const rec = h.rows()[0] || {};
    ok('the live attempt carried a clientMsgId, and the queued text keeps THAT id (the server may hold a claim on it)',
      typeof live.clientMsgId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(live.clientMsgId) && rec.id === live.clientMsgId && r.id === live.clientMsgId,
      JSON.stringify({ live: live.clientMsgId, rec: rec.id }));
    ok('…and is marked uncertain (the request left; it may have been sent)', rec.uncertain === true);
    ok('…the live attempt itself was NOT marked queued (live sends keep the live path)', live.queued === undefined);
  }
  {
    // The replay of that text reaches the server with the live attempt's id.
    const answers = [new TypeError('Failed to fetch'), jsonRes(200, { success: true, duplicate: true, sid: 'SM-live' })];
    const h = loadPage({ respond: (b, n) => answers[n - 1] || OK200() });
    await booted(h);
    const r = await h.comms.sendSMS(SMS);
    await h.ob.flush('t');
    ok('the replay reuses the live clientMsgId; a "duplicate" answer (the live send got through) removes it — no second text',
      h.posts.length === 2 && h.posts[1].body.clientMsgId === h.posts[0].body.clientMsgId && h.posts[1].body.clientMsgId === r.id
      && h.posts[1].body.queued === true && h.rows().length === 0, JSON.stringify(h.posts.map((p) => p.body.clientMsgId)));
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    await h.comms.sendSMS(SMS);
    ok('queued by the navigator.onLine pre-check (no request left): NOT uncertain', (h.rows()[0] || {}).uncertain === false);
  }
  {
    // A page without the outbox sends no id: the live path exactly as before.
    const h = loadPage({ noOutbox: true });
    await h.comms.sendSMS(SMS);
    ok('no outbox on the page → the live POST carries no clientMsgId', h.posts.length === 1 && !('clientMsgId' in h.posts[0].body));
  }
  {
    // A live 409 'held' can only mean an outbox replay already claimed this
    // attempt's id: in flight or sent. A handoff would be a second text.
    const h = loadPage({ respond: () => jsonRes(409, { code: 'held', reason: 'in_flight', error: 'Held' }) });
    await booted(h);
    const r = await h.comms.sendSMS(SMS);
    ok('a live 409 held is a REFUSAL — no sms: handoff, nothing queued',
      r.success === false && r.mode === 'platform' && h.smsLinks().length === 0 && h.rows().length === 0, JSON.stringify(r));
  }
  {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const h = loadPage({ respond: () => abort });
    await booted(h);
    const r = await h.comms.sendSMS(SMS);
    ok('the 25s abort (status 0) is queued too, not handed off', r.mode === 'queued' && h.smsLinks().length === 0);
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    const r = await h.comms.sendSMS('(859) 555-0134', 'Hi from D2D', 'knock-9', { source: 'd2d-followup-sms' });
    const rec = h.rows()[0] || {};
    ok('positional signature (D2D) queues with knockId and the 4th-arg source',
      r.mode === 'queued' && rec.knockId === 'knock-9' && rec.source === 'd2d-followup-sms' && rec.leadId === null, JSON.stringify(rec));
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    const r = await h.comms.sendSMS(Object.assign({ forceHandoff: true }, SMS));
    ok('forceHandoff is untouched: opens Messages, stores nothing', r.mode === 'sms' && h.smsLinks().length === 1 && h.rows().length === 0);
  }
  console.log('1b. LIVE answers keep the #1667 contract');
  for (const [label, res, expect] of [
    ['402 still hands off', jsonRes(402, { error: 'paid' }), 'sms'],
    ['429 still hands off', jsonRes(429, { error: 'limit' }), 'sms'],
    ['502 provider_error still hands off', jsonRes(502, { error: 'x', code: 'provider_error' }), 'sms'],
    ['403 opted_out refuses', jsonRes(403, { error: 'STOP', code: 'opted_out' }), 'refuse'],
    ['503 optout_unverified refuses', jsonRes(503, { error: 'x', code: 'optout_unverified' }), 'refuse'],
    ['200 is a platform send', OK200(), 'platform'],
  ]) {
    const h = loadPage({ respond: () => res });
    await booted(h);
    const r = await h.comms.sendSMS(SMS);
    const got = r.mode === 'platform' && r.success === false ? 'refuse' : r.mode;
    ok(label + ' — and nothing is queued', got === expect && h.rows().length === 0, JSON.stringify(r));
  }

  // ═══ 2. no IndexedDB → the pre-outbox behaviour ═══════════════════════
  console.log('2. NO INDEXEDDB — falls back to the pre-outbox handoff (documented)');
  {
    const h = loadPage({ online: false, noIndexedDB: true });
    await booted(h);
    const r = await h.comms.sendSMS(SMS);
    ok('no window.indexedDB: offline send hands off to Messages (old behaviour), nothing queued',
      r.mode === 'sms' && r.success === true && h.smsLinks().length === 1, JSON.stringify(r));
  }
  {
    const disk = newDisk(); disk.throwOnOpen = true;
    const h = loadPage({ online: false, disk });
    await booted(h);
    const r = await h.comms.sendSMS(SMS);
    ok('indexedDB.open throws (private-mode Safari): same fallback', r.mode === 'sms' && h.smsLinks().length === 1);
  }
  {
    const h = loadPage({ online: false, noOutbox: true, respond: () => new TypeError('Failed to fetch') });
    const r = await h.comms.sendSMS(SMS);
    ok('a page that did not load sms-outbox.js keeps the old offline handoff', r.mode === 'sms' && h.smsLinks().length === 1);
  }
  {
    const disk = newDisk();
    const h = loadPage({ online: false, disk });
    await booted(h);
    disk.failWrites = 'QuotaExceededError';
    const r = await h.comms.sendSMS(SMS);
    ok('a write that aborts (quota) is never reported as queued — falls back instead',
      r.mode === 'sms' && h.rows().length === 0, JSON.stringify(r));
  }

  // ═══ 3. the cap ═══════════════════════════════════════════════════════
  console.log('3. CAP — 50 waiting texts per user, the 51st refused out loud');
  {
    const h = loadPage({ online: false });
    await booted(h);
    for (let i = 0; i < 50; i++) {
      await h.ob.enqueue({ uid: 'rep-1', to: '555-010' + (i % 10) + ' ext', body: 'msg ' + i });
    }
    // Another user's rows (before an account-switch purge) never count.
    let otherQueued = true;
    try { await h.ob.enqueue({ uid: 'rep-2', to: '5550100199', body: 'theirs' }); } catch (_) { otherQueued = false; }
    ok('the cap is per user: another account\'s 1st text is accepted next to rep-1\'s 50', otherQueued);
    const r = await h.comms.sendSMS(SMS);
    ok('51st: success:false, mode "platform" (a refusal consumers must not re-handle), error "outbox-full"',
      r.success === false && r.mode === 'platform' && r.error === 'outbox-full', JSON.stringify(r));
    ok('51st: nothing stored, nothing handed off', h.rows().filter((x) => x.uid === 'rep-1').length === 50 && h.smsLinks().length === 0);
    ok('51st: the rep is told why', h.toasts.some((t) => t.type === 'error' && /already waiting/.test(t.msg)));
    let threw = null;
    try { await h.ob.enqueue({ uid: 'rep-1', to: '5550100000', body: 'x' }); } catch (e) { threw = e; }
    ok('enqueue itself rejects with reason "queue-full" (never drops silently)', threw && threw.reason === 'queue-full');
  }

  // ═══ 4. flush ═════════════════════════════════════════════════════════
  console.log('4. FLUSH — replay through sendSMS with the queued fields');
  {
    const h = loadPage({ online: false, leads: [{ id: 'lead-1', stage: 'estimate' }] });
    await booted(h);
    const q = await h.comms.sendSMS(Object.assign({ source: 'invoice-sms', sourceRef: 'inv-7' }, SMS));
    h.window.navigator.onLine = true;
    h.fire('online');
    await h.ob.flush('join');      // single-flight: joins the run 'online' started
    const p = h.posts[0] || { body: {} };
    ok('"online" flushes it: one POST — to sendQueuedSMS, the outbox\'s own endpoint (never sendSMS)',
      h.posts.length === 1 && /\/sendQueuedSMS$/.test(p.url), h.posts.length + ' ' + p.url);
    ok('…with queued:true, clientMsgId = record id, queuedAt = createdAt, leadStageAtQueue',
      p.body.queued === true && p.body.clientMsgId === q.id && typeof p.body.queuedAt === 'number'
      && p.body.leadStageAtQueue === 'estimate' && p.body.to === SMS.to && p.body.body === SMS.message, JSON.stringify(p.body));
    ok('…and queuedAgeMs = this device\'s now − createdAt (the server places the moment on its own clock)',
      typeof p.body.queuedAgeMs === 'number' && p.body.queuedAgeMs >= 0 && p.body.queuedAgeMs < 5000, String(p.body.queuedAgeMs));
    ok('…and no override flags (or supersedes) on an automatic flush of an unedited text',
      !('overrideStale' in p.body) && !('overrideActivity' in p.body) && !('supersedes' in p.body));
    const left = h.rows();
    ok('sent → the phone number and the message are gone from the store; only a receipt for its source is left',
      left.length === 1 && left[0].status === 'sent' && left[0].to === '' && left[0].toDigits === '' && left[0].body === ''
      && left[0].source === 'invoice-sms' && left[0].sourceRef === 'inv-7', JSON.stringify(left));
    const ev = h.events.find((e) => e.type === 'nbd:sms-outbox-sent');
    ok('fires nbd:sms-outbox-sent with source/sourceRef for the caller\'s listener',
      !!ev && ev.detail.id === q.id && ev.detail.source === 'invoice-sms' && ev.detail.sourceRef === 'inv-7' && ev.detail.leadId === 'lead-1');
    ok('toast: "Queued text sent"', h.toasts.some((t) => t.type === 'success' && /Queued text sent/.test(t.msg)));
    ok('no sms: link at any point', h.smsLinks().length === 0);
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'old one', createdAt: Date.now() - 16 * MIN });
    h.window.navigator.onLine = true;
    const s = await h.ob.flush('test');
    const rec = h.rows()[0] || {};
    ok('≥15 min old → held "stale" WITHOUT a server call', rec.status === 'held' && rec.heldReason === 'stale' && h.posts.length === 0, JSON.stringify(rec));
    ok('…and the rep is told it needs their OK', h.toasts.some((t) => /needs your OK/.test(t.msg)) && s.held === 1);
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: '(859) 555-0134', body: 'Same words', createdAt: Date.now() - 3 * MIN });
    await h.ob.enqueue({ uid: 'rep-1', to: '+1 859-555-0134', body: 'Same words', createdAt: Date.now() - 2 * MIN });
    await h.ob.enqueue({ uid: 'rep-1', to: '859.555.0134', body: 'Different words', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    const s = await h.ob.flush('test');
    const left = h.rows();
    ok('duplicates collapse: identical number (any formatting) + identical text → sent ONCE',
      h.posts.filter((p) => p.body.body === 'Same words').length === 1, h.posts.map((p) => p.body.body).join(' | '));
    ok('the newer copy is kept as "discarded" with reason "duplicate" (recorded, not silently deleted)',
      left.length === 1 && left[0].status === 'discarded' && left[0].heldReason === 'duplicate' && s.duplicates === 1, JSON.stringify(left));
    ok('the OLDEST copy is the one that went', h.posts[0].body.queuedAt < left[0].createdAt);
    ok('a different text to the same number still goes', h.posts.some((p) => p.body.body === 'Different words'));
  }
  {
    // Per-recipient FIFO: A1, B1, A2 (A = one number, B = another).
    const h = loadPage({ online: false });
    await booted(h);
    const now = Date.now();
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550001', body: 'A1', createdAt: now - 5 * MIN });
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550002', body: 'B1', createdAt: now - 4 * MIN });
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550001', body: 'A2', createdAt: now - 3 * MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('test');
    ok('per-recipient FIFO: oldest recipient first, its texts in order, one recipient at a time → A1, A2, B1',
      h.posts.map((p) => p.body.body).join(',') === 'A1,A2,B1', h.posts.map((p) => p.body.body).join(','));
  }
  {
    // A held text holds back every later text to the SAME number, not others.
    const h = loadPage({
      online: false,
      respond: (b) => (b.body === 'A1' ? jsonRes(409, { code: 'held', reason: 'recent_inbound', error: 'Held: …' }) : OK200()),
    });
    await booted(h);
    const now = Date.now();
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550001', body: 'A1', createdAt: now - 5 * MIN });
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550002', body: 'B1', createdAt: now - 4 * MIN });
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550001', body: 'A2', createdAt: now - 3 * MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('test');
    const byBody = {}; h.rows().forEach((r) => { byBody[r.body] = r; });
    ok('A1 held (server said recent_inbound) → A2 is NOT sent ahead of it; B1 still goes',
      h.posts.map((p) => p.body.body).join(',') === 'A1,B1', h.posts.map((p) => p.body.body).join(','));
    ok('A1 is "held" with the server\'s reason, A2 stays "queued" behind it',
      byBody.A1 && byBody.A1.status === 'held' && byBody.A1.heldReason === 'recent_inbound'
      && byBody.A2 && byBody.A2.status === 'queued' && !byBody.B1, JSON.stringify(h.rows().map((r) => [r.body, r.status])));
    // A second flush still does not send A2 past the held A1.
    await h.ob.flush('again');
    ok('…and a later flush still does not send A2 past it', h.posts.length === 2);
  }

  console.log('4a. FLUSH — a text that may already have gone is asked about, not held locally');
  {
    // The reviewer's sequence: an attempt whose answer was lost (the server
    // sent it), then the next flush 15+ minutes later.
    const answers = [new TypeError('Failed to fetch'), jsonRes(200, { success: true, duplicate: true, sid: 'SM-lost' })];
    const h = loadPage({ online: false, respond: (b, n) => answers[n - 1] || OK200() });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'lost answer', createdAt: Date.now() - 20 * MIN, source: 'invoice-sms', sourceRef: 'inv-9' });
    // First attempt at 20 min would be held locally (never attempted); make it
    // look like the answer was lost on an earlier, fresh attempt instead.
    const table = h.disk.dbs['nbd-sms-outbox-db'].stores.outbox;
    table.set(rec.id, Object.assign({}, table.get(rec.id), { createdAt: Date.now() - 2 * MIN }));
    h.window.navigator.onLine = true;
    await h.ob.flush('first');
    const mid = h.rows()[0] || {};
    ok('an attempt whose answer was lost goes back to "queued", attempts 1, marked uncertain',
      mid.status === 'queued' && mid.attempts === 1 && mid.uncertain === true, JSON.stringify(mid));
    table.set(rec.id, Object.assign({}, table.get(rec.id), { createdAt: Date.now() - 20 * MIN }));
    await h.ob.flush('later');
    ok('15+ min later it is NOT held "stale" locally: the server is asked (no overrides) and says "duplicate"',
      h.posts.length === 2 && h.posts[1].body.clientMsgId === rec.id && !('overrideStale' in h.posts[1].body), JSON.stringify(h.posts.map((p) => p.body)));
    const after = h.rows();
    ok('…so it is recorded as SENT (a receipt for the invoice), not shown as unsent in the tray',
      after.length === 1 && after[0].status === 'sent' && after[0].sourceRef === 'inv-9' && (await h.ob.list()).length === 0, JSON.stringify(after));
  }
  {
    const h = loadPage({ online: false, respond: () => jsonRes(409, { code: 'held', reason: 'stale', error: 'Held' }) });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'uncertain', createdAt: Date.now() - 30 * MIN, uncertain: true });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    const rec = h.rows()[0] || {};
    ok('an uncertain stale text that did NOT go: the server holds it "stale" (one POST, no override)',
      h.posts.length === 1 && !('overrideStale' in h.posts[0].body) && rec.status === 'held' && rec.heldReason === 'stale' && rec.uncertain === false,
      JSON.stringify(rec));
  }
  {
    // Edit carries the ids it replaces; an edit of an edit carries both.
    const h = loadPage({ online: false, respond: () => jsonRes(409, { code: 'held', reason: 'recent_outbound', error: 'Held' }) });
    await booted(h);
    const orig = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'v1', createdAt: Date.now() - 20 * MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');                                  // held stale locally, no POST
    await h.ob.editAndSend(orig.id, 'v2');
    const p1 = (h.posts[0] || { body: {} }).body;
    ok('Edit → the edit names the original in supersedes (the server checks its claim)',
      JSON.stringify(p1.supersedes) === JSON.stringify([orig.id]) && p1.clientMsgId !== orig.id && p1.queuedAt === orig.createdAt, JSON.stringify(p1));
    const e1 = h.rows()[0];
    await h.ob.editAndSend(e1.id, 'v3');
    const p2 = (h.posts[1] || { body: {} }).body;
    ok('…and an edit of the edit names both',
      JSON.stringify(p2.supersedes) === JSON.stringify([orig.id, e1.id]), JSON.stringify(p2.supersedes));
  }

  console.log('4c-dup. DUPLICATES — a queued copy is never swallowed by a held one');
  {
    // Reviewer's case: A held "stale", then an identical fresh B is queued.
    const h = loadPage({ online: false });
    await booted(h);
    const a = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'Same words', createdAt: Date.now() - 20 * MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t1');                                  // A → held stale, no POST
    ok('(setup) A is held stale without a POST', (h.rows()[0] || {}).heldReason === 'stale' && h.posts.length === 0);
    const b = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'Same words', createdAt: Date.now() - MIN });
    const s = await h.ob.flush('t2');
    const byId = {}; h.rows().forEach((r) => { byId[r.id] = r; });
    ok('an identical fresh queued B is SENT (one POST, B\'s id), not discarded as a duplicate of the held A',
      h.posts.length === 1 && h.posts[0].body.clientMsgId === b.id, JSON.stringify(h.posts.map((p) => p.body.clientMsgId)));
    ok('…and the held A is the one retired: "discarded", reason "duplicate", duplicateOf B (recorded)',
      byId[a.id] && byId[a.id].status === 'discarded' && byId[a.id].heldReason === 'duplicate' && byId[a.id].duplicateOf === b.id && s.duplicates === 1,
      JSON.stringify(byId[a.id]));
  }
  for (const [label, patch] of [
    ['held in_flight (may be on their phone)', { status: 'held', heldReason: 'in_flight' }],
    ['held after an attempt with no answer (uncertain)', { status: 'held', heldReason: 'quiet_hours', uncertain: true }],
  ]) {
    // (the flush PEEKS at the older copy — it may have gone — and the server
    // still cannot tell: in_flight)
    const h = loadPage({ online: false, respond: (b) => (b.peek ? jsonRes(409, { code: 'held', reason: 'in_flight', error: 'x' }) : OK200()) });
    await booted(h);
    const a = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'Same words', createdAt: Date.now() - 5 * MIN });
    const table = h.disk.dbs['nbd-sms-outbox-db'].stores.outbox;
    table.set(a.id, Object.assign({}, table.get(a.id), patch));
    const b = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'Same words', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    const byId = {}; h.rows().forEach((r) => { byId[r.id] = r; });
    ok('older copy ' + label + ' → the NEWER queued copy is discarded, nothing sent (only a peek at the older one)',
      h.posts.every((p) => p.body.peek === true && !('body' in p.body)) && byId[b.id] && byId[b.id].status === 'discarded' && byId[b.id].duplicateOf === a.id
      && byId[a.id] && byId[a.id].status === 'held', JSON.stringify(h.rows().map((r) => [r.id === a.id ? 'A' : 'B', r.status, r.heldReason])));
  }

  console.log('4b. FLUSH — each server answer lands in the right state; never a handoff');
  const answer = async (res) => {
    const h = loadPage({ online: false, respond: () => res });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'hello', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    const s = await h.ob.flush('test');
    return { h, s, rec: h.rows()[0] || null };
  };
  {
    const { h, rec } = await answer(jsonRes(409, { code: 'held', reason: 'quiet_hours', error: 'Held: outside 8am–9pm' }));
    ok('409 held → "held" with the server reason', rec && rec.status === 'held' && rec.heldReason === 'quiet_hours' && h.smsLinks().length === 0);
  }
  {
    const { h, rec } = await answer(jsonRes(403, { code: 'opted_out', error: 'opted out' }));
    ok('403 opted_out → "discarded", reason "opted_out"', rec && rec.status === 'discarded' && rec.heldReason === 'opted_out', JSON.stringify(rec));
    ok('…with a clear toast', h.toasts.some((t) => t.type === 'error' && /opted out/.test(t.msg) && /NOT sent/.test(t.msg)));
    ok('…and no handoff', h.smsLinks().length === 0);
  }
  for (const [label, res, reason] of [
    ['402', jsonRes(402, { error: 'paid' }), 'plan_required'],
    ['429', jsonRes(429, { error: 'limit' }), 'rate_limited'],
    ['502 provider_error', jsonRes(502, { error: 'x', code: 'provider_error' }), 'provider_error'],
  ]) {
    const { h, rec } = await answer(res);
    ok(label + ' on a replay → "held" (' + reason + '), NEVER an sms: handoff from the flush',
      rec && rec.status === 'held' && rec.heldReason === reason && h.smsLinks().length === 0, JSON.stringify(rec));
  }
  {
    const { h, s, rec } = await answer(new TypeError('Failed to fetch'));
    ok('network failure again → stays "queued", flush stops, retry scheduled',
      rec && rec.status === 'queued' && s.stoppedBy === 'network' && h.longTimers.some((t) => t.ms === 60000), JSON.stringify(s));
  }
  {
    const { rec, s } = await answer(jsonRes(503, { code: 'outbox_unverified', error: 'x' }));
    ok('503 (a server check could not run) → stays "queued" for a later try', rec && rec.status === 'queued' && s.stoppedBy === 'retry');
  }
  {
    const { h, rec } = await answer(jsonRes(200, { success: true, duplicate: true, sid: 'SM9' }));
    ok('200 duplicate (it went on an earlier attempt) → removed, counted as sent', rec === null && h.events.some((e) => e.type === 'nbd:sms-outbox-sent'));
  }
  {
    // A page that died mid-send leaves a 'sending' row; it is replayed with
    // the SAME clientMsgId (the server's claim makes that safe).
    const h = loadPage({ online: false });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'orphan', createdAt: Date.now() - 2 * MIN });
    const table = h.disk.dbs['nbd-sms-outbox-db'].stores.outbox;
    table.set(rec.id, Object.assign({}, table.get(rec.id), { status: 'sending', sendingAt: Date.now() - 3 * MIN }));
    h.window.navigator.onLine = true;
    await h.ob.flush('test');
    ok('an orphaned "sending" row is replayed with its original clientMsgId',
      h.posts.length === 1 && h.posts[0].body.clientMsgId === rec.id && h.rows().length === 0);
  }

  console.log('4c. SINGLE-FLIGHT — one flush per tab, one per origin');
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = loadPage({ online: false, respond: async () => { await gate; return OK200(); } });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'once', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    const a = h.ob.flush('a');
    const b = h.ob.flush('b');
    h.fire('online');
    ok('concurrent flush() calls in one tab share one run', a === b);
    release();
    await a;
    ok('…and the text is POSTed exactly once', h.posts.length === 1, String(h.posts.length));
  }
  {
    // A text stored while a run is already under way (the run read the queue
    // before it existed) still goes: joining a run schedules ONE trailing run.
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = loadPage({ online: false, respond: async (b) => { if (b.body === 'first') await gate; return OK200(); } });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550001', body: 'first', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    const run = h.ob.flush('a');
    await wait(10);
    await h.ob.enqueue({ uid: 'rep-1', to: '5135550002', body: 'late', createdAt: Date.now() });
    h.ob.flush('b');                 // joins the run in progress
    release();
    await run;
    await until(() => h.posts.length === 2 && h.rows().length === 0);
    ok('a text stored mid-run is sent by the trailing run, not left for the next "online"',
      h.posts.map((p) => p.body.body).join(',') === 'first,late' && h.rows().length === 0, h.posts.map((p) => p.body.body).join(','));
  }
  {
    // Two tabs, same origin: shared IndexedDB and localStorage, no Web Locks.
    const disk = newDisk();
    const LS = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const respond = async () => { await gate; return OK200(); };
    const t1 = loadPage({ online: false, disk, localStorage: LS, respond });
    const t2 = loadPage({ online: false, disk, localStorage: LS, respond });
    await booted(t1); await booted(t2);
    await t1.ob.enqueue({ uid: 'rep-1', to: '5135550001', body: 'one', createdAt: Date.now() - MIN });
    await t1.ob.enqueue({ uid: 'rep-1', to: '5135550002', body: 'two', createdAt: Date.now() - MIN });
    t1.window.navigator.onLine = true; t2.window.navigator.onLine = true;
    const f1 = t1.ob.flush('tab1');
    await wait(10);
    // Raced against a timer: a second tab that does NOT stand down would sit
    // on the gated fetch forever — that must fail this assertion, not hang.
    const f2 = await Promise.race([t2.ob.flush('tab2'), wait(300).then(() => ({ skipped: 'no — it flushed too' }))]);
    release();
    await f1;
    ok('two tabs (localStorage lease): the second tab stands down while the first flushes', f2.skipped === 'busy', JSON.stringify(f2));
    ok('…each text POSTed exactly once across both tabs', t1.posts.length + t2.posts.length === 2, (t1.posts.length + t2.posts.length) + '');
  }
  {
    // Two tabs, both racing past a lock (no lease, no locks): the IndexedDB
    // queued→sending compare-and-set still lets only one take each text.
    const disk = newDisk();
    let release;
    const gate = new Promise((r) => { release = r; });
    const respond = async () => { await gate; return OK200(); };
    const noLS = (w) => { w.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} }; };
    const t1 = loadPage({ online: false, disk, respond, before: noLS });
    const t2 = loadPage({ online: false, disk, respond, before: noLS });
    await booted(t1); await booted(t2);
    await t1.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'contested', createdAt: Date.now() - MIN });
    t1.window.navigator.onLine = true; t2.window.navigator.onLine = true;
    const f = [t1.ob.flush('x'), t2.ob.flush('y')];
    await wait(20);
    release();
    await Promise.all(f);
    ok('no lease available: the per-record compare-and-set still sends a text once', t1.posts.length + t2.posts.length === 1,
      (t1.posts.length + t2.posts.length) + '');
  }
  {
    // Web Locks path: ifAvailable → a second holder gets null and stands down.
    let held = false;
    const locks = {
      request: async (name, o, cb) => {
        if (held) return cb(null);
        held = true;
        try { return await cb({ name }); } finally { held = false; }
      },
    };
    const disk = newDisk();
    let release;
    const gate = new Promise((r) => { release = r; });
    const respond = async () => { await gate; return OK200(); };
    const t1 = loadPage({ online: false, disk, navigator: { locks }, respond });
    const t2 = loadPage({ online: false, disk, navigator: { locks }, respond });
    await booted(t1); await booted(t2);
    await t1.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'locked', createdAt: Date.now() - MIN });
    t1.window.navigator.onLine = true; t2.window.navigator.onLine = true;
    const f1 = t1.ob.flush('a');
    await wait(10);
    const f2 = await Promise.race([t2.ob.flush('b'), wait(300).then(() => ({ skipped: 'no — it flushed too' }))]);
    release(); await f1;
    ok('navigator.locks (ifAvailable): the second tab stands down', f2.skipped === 'busy' && t1.posts.length + t2.posts.length === 1, JSON.stringify(f2));
  }

  // ═══ 5. tray ══════════════════════════════════════════════════════════
  console.log('5. TRAY — pill, reasons, buttons, explicit consent');
  {
    const h = loadPage({ online: false });
    await booted(h);
    ok('no pill while nothing waits', !h.document.getElementById('nbd-sms-outbox-pill')
      || !h.document.getElementById('nbd-sms-outbox-pill').classList.contains('is-visible'));
    await h.comms.sendSMS(SMS);
    const pillEl = () => h.document.getElementById('nbd-sms-outbox-pill');
    await until(() => pillEl() && pillEl().classList.contains('is-visible'));
    const pill = pillEl() || h.document.createElement('button');
    ok('a queued text shows the "Pending texts (1)" pill',
      pill.classList.contains('is-visible') && pill.textContent === 'Pending texts (1)', pill.textContent);
    ok('the pill is a button driven by the delegated listener (no inline handler)',
      pill.tagName === 'BUTTON' && pill.getAttribute('data-sms-outbox-action') === 'open' && !pill.getAttribute('onclick'));
    h.document.clickOn(pill);
    await until(() => h.document.querySelector('[data-sms-outbox-row]'));
    const modal = h.document.getElementById('nbd-sms-outbox-modal') || h.document.createElement('div');
    ok('tapping it opens the tray through nbdModal (.modal-bg + .open)',
      !!modal && modal.classList.contains('modal-bg') && modal.classList.contains('open'));
    const card = modal.querySelector('[role]');
    ok('the card carries BOTH card contracts: .modal (dashboard-app.css) and .modal-content (customer.html)',
      !!card && card.getAttribute('role') === 'dialog' && card.classList.contains('modal') && card.classList.contains('modal-content'),
      card && card.className);
    const row = modal.querySelector('[data-sms-outbox-row]');
    const txt = row ? row.textContent : '';
    ok('the row masks the number except the last 4', /\(•••\) •••-0134/.test(txt) && !/859/.test(txt), txt || ('modal: ' + modal.textContent));
    ok('…shows the text, and "Waiting for a connection"', /Running 10 min late/.test(txt) && /Waiting for a connection/.test(txt), txt);
  }
  {
    const I = loadPage({ online: false }).ob._internals;
    const reason = (heldReason, status) => I.reasonText({ status: status || 'held', heldReason });
    ok('plain-English reasons', reason('stale') === 'Waiting — sent more than 15 min ago'
      && reason('quiet_hours') === 'Quiet hours — can send after 8am'
      && reason('recent_inbound') === 'Homeowner texted you since'
      && reason('recent_outbound') === 'Someone already texted this number'
      && reason('lead_changed') === 'Lead changed'
      && reason('opted_out', 'discarded') === 'Opted out');
    const acts = (heldReason, status) => I.actionsFor({ status: status || 'held', heldReason }).map((a) => a[1]).join(',');
    ok('recent_outbound / recent_inbound / lead_changed offer Send anyway, Edit, Discard',
      ['recent_outbound', 'recent_inbound', 'lead_changed'].every((r) => acts(r) === 'send-anyway,edit,discard'));
    ok('stale / quiet hours offer Send now (no activity override), Edit, Discard',
      acts('stale') === 'send,edit,discard' && acts('quiet_hours') === 'send,edit,discard');
    ok('lead_gone offers only Discard', acts('lead_gone') === 'discard');
    ok('in_flight offers "Check again" (a PEEK at the same id) and Discard — never Send now or Edit',
      acts('in_flight') === 'check,discard'
      && I.actionsFor({ status: 'held', heldReason: 'in_flight' })[0][0] === 'Check again');
    ok('"Open in Messages" only after a 402 / 429 / provider_error',
      acts('plan_required').includes('handoff') && acts('rate_limited').includes('handoff') && acts('provider_error').includes('handoff')
      && !['stale', 'quiet_hours', 'recent_inbound', 'recent_outbound', 'lead_changed', 'lead_gone', 'in_flight'].some((r) => acts(r).includes('handoff')));
    ok('an opted-out (discarded) text can only be dismissed', acts('opted_out', 'discarded') === 'discard');
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'old', createdAt: Date.now() - 40 * MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    const rec = h.rows()[0];
    await h.ob.sendNow(rec.id);
    const p = h.posts[0] || { body: {} };
    ok('"Send now" on a stale text re-sends queued:true with overrideStale:true and NOT overrideActivity',
      p.body.queued === true && p.body.overrideStale === true && !('overrideActivity' in p.body) && p.body.clientMsgId === rec.id, JSON.stringify(p.body));
    ok('…sent → removed', h.rows().length === 0);
  }
  {
    const h = loadPage({ online: false, respond: (b, n) => (n === 1 ? jsonRes(409, { code: 'held', reason: 'recent_inbound', error: 'x' }) : OK200()) });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'reply?', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    const rec = h.rows()[0];
    ok('held recent_inbound after the flush', rec.status === 'held' && rec.heldReason === 'recent_inbound');
    h.ob.openTray();
    await until(() => h.document.querySelector('[data-sms-outbox-action="send-anyway"]'));
    const btn = h.document.querySelector('[data-sms-outbox-action="send-anyway"]') || h.document.createElement('button');
    ok('the tray renders a "Send anyway" button for it', btn.textContent === 'Send anyway' && btn.getAttribute('data-sms-outbox-id') === rec.id);
    const reasonEl = h.document.querySelector('.nbd-sms-ob-reason');
    ok('…under the plain-English reason "Homeowner texted you since"', !!reasonEl && reasonEl.textContent === 'Homeowner texted you since');
    h.document.clickOn(btn);
    await until(() => h.posts.length === 2 && h.rows().length === 0);
    const p = h.posts[1] || { body: {} };
    ok('"Send anyway" sends overrideActivity:true (with overrideStale — an explicit tap)',
      p.body.overrideActivity === true && p.body.overrideStale === true && p.body.queued === true, JSON.stringify(p.body));
    ok('…sent → removed', h.rows().length === 0);
  }
  {
    // Consent is per tap. "Send anyway" answered THAT hold; if its answer
    // never came back, the text may have gone ("Check again" first), and once
    // the server says it did not, a later plain "Send now" must not inherit
    // the earlier activity consent.
    const answers = [
      jsonRes(409, { code: 'held', reason: 'recent_inbound', error: 'x' }),
      new TypeError('Failed to fetch'),
      jsonRes(409, { code: 'not_claimed', error: 'x' }),
      jsonRes(409, { code: 'held', reason: 'recent_inbound', error: 'x' }),
    ];
    const h = loadPage({ online: false, respond: (b, n) => answers[n - 1] || OK200() });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'consent', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    await h.ob.sendNow(rec.id, { activity: true });
    const mid = h.rows()[0] || {};
    ok('a "Send anyway" whose answer never came back leaves the text held, marked may-have-gone',
      mid.status === 'held' && mid.heldReason === 'recent_inbound' && mid.uncertain === true && h.posts[1].body.overrideActivity === true, JSON.stringify(mid));
    await h.ob.checkAgain(rec.id);
    const back = h.rows()[0] || {};
    ok('…"Check again" peeks; not_claimed puts it back to the hold it answered (no longer uncertain)',
      h.posts[2].body.peek === true && back.heldReason === 'recent_inbound' && back.uncertain === false, JSON.stringify(back));
    await h.ob.sendNow(rec.id);
    const p = h.posts[3] || { body: {} };
    ok('…and a later plain "Send now" carries overrideStale only — not the earlier activity consent',
      p.body.overrideStale === true && !('overrideActivity' in p.body), JSON.stringify(p.body));
    ok('…so the server can still hold it for the new activity', (h.rows()[0] || {}).heldReason === 'recent_inbound');
  }
  {
    const answers = [new TypeError('Failed to fetch'), OK200()];
    const h = loadPage({ online: false, respond: (b, n) => answers[n - 1] || OK200() });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'tap then flush', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.sendNow(rec.id);          // explicit tap on a QUEUED text; network drops
    ok('an explicit tap that never reached the server puts a queued text back to "queued"',
      (h.rows()[0] || {}).status === 'queued' && h.posts[0].body.overrideStale === true);
    await h.ob.flush('auto');
    const p = h.posts[1] || { body: {} };
    ok('…and the next AUTOMATIC flush sends it with no override at all',
      p.body.queued === true && !('overrideStale' in p.body) && !('overrideActivity' in p.body), JSON.stringify(p.body));
  }
  {
    const h = loadPage({ online: false, respond: () => jsonRes(402, { error: 'paid' }) });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'plan', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    const rec = h.rows()[0];
    ok('a 402 on the replay leaves it held (plan_required) and opens nothing', rec.heldReason === 'plan_required' && h.smsLinks().length === 0);
    const postsBefore = h.posts.length;
    let linksAtPost = -1;
    const realFetch = h.window.fetch;
    h.window.fetch = async (u, init) => { linksAtPost = h.smsLinks().length; return realFetch(u, init); };
    await h.ob.openInMessages(rec.id);
    const fresh = (h.posts[postsBefore] || { body: {} }).body;
    ok('"Open in Messages" first re-asks the server (queued, the tap\'s overrideStale, NEVER overrideActivity), before any handoff',
      h.posts.length === postsBefore + 1 && fresh.queued === true && fresh.clientMsgId === rec.id
      && fresh.overrideStale === true && !('overrideActivity' in fresh) && linksAtPost === 0, JSON.stringify(fresh));
    ok('…and on a FRESH 402 hands THAT text off and removes it',
      h.smsLinks().length === 1 && /body=plan$/.test(h.smsLinks()[0]) && h.rows().length === 0, JSON.stringify(h.smsLinks()));
  }
  // The stored verdict is never enough: the tray row may be days old.
  const agedHandoff = async (fresh) => {
    const answers = [jsonRes(402, { error: 'paid' })];
    const h = loadPage({ online: false, respond: (b, n) => answers[n - 1] || fresh });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'aged', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');                                    // → held plan_required
    const table = h.disk.dbs['nbd-sms-outbox-db'].stores.outbox;
    const DAY = 24 * 60 * MIN;
    table.set(rec.id, Object.assign({}, table.get(rec.id), { heldAt: Date.now() - 3 * DAY, createdAt: Date.now() - 3 * DAY }));
    const opened = await h.ob.openInMessages(rec.id);
    return { h, rec, opened, after: h.rows()[0] || null };
  };
  {
    const { h, opened, after } = await agedHandoff(jsonRes(403, { code: 'opted_out', error: 'STOP' }));
    ok('3-day-old 402 hold, homeowner replied STOP since: the tap opens NOTHING and the text is discarded opted_out',
      opened === false && h.smsLinks().length === 0 && after && after.status === 'discarded' && after.heldReason === 'opted_out', JSON.stringify(after));
  }
  {
    const { h, opened, after } = await agedHandoff(jsonRes(409, { code: 'held', reason: 'quiet_hours', error: 'Held' }));
    ok('tap at 21:30 ET (server: quiet_hours): opens NOTHING, held quiet_hours',
      opened === false && h.smsLinks().length === 0 && after && after.heldReason === 'quiet_hours', JSON.stringify(after));
    ok('…and the rep is told why', h.toasts.some((t) => /Not sent — Quiet hours/.test(t.msg)));
  }
  {
    const { h, opened, after } = await agedHandoff(jsonRes(409, { code: 'held', reason: 'recent_inbound', error: 'Held' }));
    ok('homeowner texted since (server: recent_inbound): opens NOTHING, held recent_inbound',
      opened === false && h.smsLinks().length === 0 && after && after.heldReason === 'recent_inbound');
  }
  {
    const { h, opened, after } = await agedHandoff(jsonRes(503, { code: 'optout_unverified', error: 'x' }));
    ok('server could not check (503): opens NOTHING, stays held',
      opened === false && h.smsLinks().length === 0 && after && after.status === 'held');
  }
  {
    const { h, opened, after } = await agedHandoff(OK200());
    ok('plan fixed since (server sends it): no handoff, the text went through the platform',
      opened === false && h.smsLinks().length === 0 && after === null && h.toasts.some((t) => t.msg === 'Text sent'));
  }
  {
    const { h, opened } = await agedHandoff(jsonRes(429, { error: 'limit' }));
    ok('a FRESH 429 answer → hands off (the server ran every hold in that request)', opened === true && h.smsLinks().length === 1);
  }
  {
    const h = loadPage({ online: false, respond: () => jsonRes(402, { error: 'paid' }) });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'x', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    h.window.navigator.onLine = false;
    const n = h.posts.length;
    ok('offline tap: no request, no handoff', (await h.ob.openInMessages(rec.id)) === false && h.posts.length === n && h.smsLinks().length === 0);
  }
  {
    const h = loadPage({ online: false, respond: () => jsonRes(409, { code: 'held', reason: 'recent_outbound', error: 'x' }) });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'x', createdAt: Date.now() - MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    ok('"Open in Messages" is refused for an activity hold', (await h.ob.openInMessages(rec.id)) === false && h.smsLinks().length === 0);
    await h.ob.discard(rec.id);
    ok('Discard removes it, sends nothing', h.rows().length === 0 && h.posts.length === 1);
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    const rec = await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'typo hre', createdAt: Date.now() - 20 * MIN });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    await h.ob.editAndSend(rec.id, 'typo here');
    const p = h.posts[0] || { body: {} };
    ok('Edit → sends the edited text under a NEW clientMsgId but the ORIGINAL queuedAt',
      p.body.body === 'typo here' && p.body.clientMsgId !== rec.id && p.body.queuedAt === rec.createdAt && p.body.overrideStale === true, JSON.stringify(p.body));
  }

  // ═══ 6. purge ═════════════════════════════════════════════════════════
  console.log('6. PURGE — sign-out and account switch');
  {
    const h = loadPage({ online: false });
    await booted(h);
    await h.comms.sendSMS(SMS);
    await h.ob.enqueue({ uid: 'rep-2', to: '5135550009', body: 'someone else' });
    ok('purgeAll() deletes every record for every user', (await h.ob.purgeAll()) === true && h.rows().length === 0);
  }
  {
    // nbd-auth.js purgeSmsOutbox, run for real (it is an object method on an
    // ES module that imports from gstatic, so the method is lifted out).
    const body = extractBlock(AUTH_SRC, 'purgeSmsOutbox() {');
    // Its 2s bound is shortened to 20ms here (the bound's EXISTENCE is what is
    // under test, not its length).
    const fastTimeout = (fn, ms) => setTimeout(fn, ms >= 1000 ? 20 : ms);
    const make = (win) => new Function('window', 'setTimeout', 'return ({ ' + body + ' });')(win, fastTimeout);
    const h = loadPage({ online: false });
    await booted(h);
    await h.comms.sendSMS(SMS);
    const ok1 = await make(h.window).purgeSmsOutbox();
    ok('NBDAuth.purgeSmsOutbox uses the loaded outbox and empties it', ok1 === true && h.rows().length === 0);
    const disk = newDisk();
    const h2 = loadPage({ online: false, disk });
    await booted(h2);
    await h2.comms.sendSMS(SMS);
    // …plus the receipt of an invoice text that already went (ids only).
    const receipt = { id: 'rcpt-1', uid: 'rep-1', status: 'sent', source: 'invoice-sms', sourceRef: 'inv-9', to: '', toDigits: '', body: '', createdAt: Date.now() };
    disk.dbs['nbd-sms-outbox-db'].stores.outbox.set(receipt.id, receipt);
    const bare = { indexedDB: makeIDB(disk) };      // a page that never loaded sms-outbox.js
    const ok2 = await make(bare).purgeSmsOutbox();
    const left = rowsOn(disk);
    ok('…on a page without the outbox module it opens the database and deletes every text (number + message)',
      ok2 === true && !left.some((r) => r.to || r.body), JSON.stringify(left));
    ok('…but keeps the receipt of a text that already went (ids only) for the same rep\'s next sign-in',
      left.length === 1 && left[0].id === 'rcpt-1', JSON.stringify(left));
    const empty = newDisk();
    const ok2b = await make({ indexedDB: makeIDB(empty) }).purgeSmsOutbox();
    ok('…and on a device with no outbox database it succeeds without creating a store', ok2b === true && rowsOn(empty).length === 0);
    const hang = { NBDSmsOutbox: { purgeAll: () => new Promise(() => {}) } };
    // Watchdog: an unbounded purge must FAIL this assertion, not park the
    // suite on a promise that never settles.
    const ok3 = await Promise.race([make(hang).purgeSmsOutbox(), wait(1000).then(() => 'hung')]);
    ok('…and gives up after its bound instead of stalling sign-out', ok3 === false, String(ok3));
  }
  {
    // purgeAccountStorage + logout, lifted out of the ES module and RUN.
    const order = [];
    const LSK = { nbd_leads_cache: '1', 'nbd-theme': 'dark' };
    const lsStub = {
      get length() { return Object.keys(LSK).length; },
      key: (i) => Object.keys(LSK)[i],
      removeItem: (k) => { delete LSK[k]; },
    };
    let finishPurge;
    const NBDAuthStub = {
      purgeSmsOutbox: () => { order.push('sms-purge-start'); return new Promise((r) => { finishPurge = () => { order.push('sms-purge-done'); r(true); }; }); },
    };
    const purgeSrc = extractBlock(AUTH_SRC, 'purgeAccountStorage() {');
    const logoutSrc = extractBlock(AUTH_SRC, "async logout(redirect = '/pro/login.html') {");
    const win = { location: { replace: (u) => order.push('redirect:' + u) } };
    const auth = new Function('NBDAuth', 'localStorage', 'signOut', '_auth', 'window',
      'return ({ ' + purgeSrc + ',\n' + logoutSrc + ' });')(
      NBDAuthStub, lsStub, async () => { order.push('signOut'); }, {}, win);
    const p = auth.logout();
    await wait(5);
    ok('purgeAccountStorage (logout + account switch) purges the SMS outbox too',
      order[0] === 'sms-purge-start' && !('nbd_leads_cache' in LSK) && LSK['nbd-theme'] === 'dark', order.join(','));
    ok('logout() does not sign out while the outbox purge is still running', order.join(',') === 'sms-purge-start', order.join(','));
    finishPurge();
    await p;
    ok('…then signs out and redirects', order.join(',') === 'sms-purge-start,sms-purge-done,signOut,redirect:/pro/login.html', order.join(','));
  }
  {
    // dashboard _signOut: the purge must COMPLETE before signOut() runs.
    const block = extractBlock(BOOT_SRC, 'window._signOut = () => {');
    const order = [];
    let finishPurge;
    const win = {
      NBDAuth: { purgeSmsOutbox: () => { order.push('purge-start'); return new Promise((r) => { finishPurge = () => { order.push('purge-done'); r(true); }; }); } },
      localStorage: { length: 0, key: () => null, removeItem() {} },
      location: { replace: (u) => order.push('redirect:' + u) },
    };
    const signOut = async () => { order.push('signOut'); };
    new Function('window', 'signOut', 'auth', 'localStorage', block)(win, signOut, {}, win.localStorage);
    const p = win._signOut();
    await wait(5);
    ok('dashboard _signOut starts the purge and does NOT sign out before it finishes',
      order.join(',') === 'purge-start', order.join(','));
    finishPurge();
    await p;
    ok('…then signs out and redirects', order.join(',') === 'purge-start,purge-done,signOut,redirect:/pro/login.html', order.join(','));
  }
  {
    // Backstop: the page's Firebase Auth reports no user after a signed-in
    // one (any sign-out path, or sign-out in another tab) → purge.
    let listener = null;
    const auth = { onAuthStateChanged: (cb) => { listener = cb; return () => {}; } };
    const h = loadPage({ online: false, before: (w) => { w.auth = auth; } });
    await booted(h);
    await h.comms.sendSMS(SMS);
    ok('(setup) a queued text and a registered auth listener', h.rows().length === 1 && typeof listener === 'function');
    listener({ uid: 'rep-1' });
    await wait(10);
    ok('auth reporting the signed-in user purges nothing', h.rows().length === 1);
    listener(null);
    await until(() => h.rows().length === 0);
    ok('auth dropping to NO user after a signed-in one purges the outbox (every sign-out path)', h.rows().length === 0);
  }
  {
    let listener = null;
    const auth = { onAuthStateChanged: (cb) => { listener = cb; return () => {}; } };
    const disk = newDisk();
    const seed = loadPage({ online: false, disk });
    await booted(seed);
    await seed.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'left behind' });
    // A page whose user never resolved (still booting / signed out from the start).
    const h = loadPage({ online: false, disk, user: null, before: (w) => { w.auth = auth; } });
    await wait(15);
    if (listener) listener(null);
    await wait(15);
    ok('a page that never had a user does not purge on an initial "no user"', rowsOn(disk).length === 1 && !!h.ob);
  }
  {
    // command-palette.js "Sign Out" on customer.html: no _signOut, no
    // nbd-auth.js — the SDK fallback. It must purge the outbox BEFORE signOut.
    const CP_SRC = read('docs/pro/js/command-palette.js');
    const start = CP_SRC.indexOf('} else if (window.auth) {');
    const block = extractBlock(CP_SRC.slice(start + 2), 'else if (window.auth) {');
    const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'))
      .replace("import('/assets/vendor/firebase/10.12.2/firebase-auth.js')", '__import()');
    ok('command-palette fallback: the lifted block still imports the SDK signOut (the stub replaced it)', /__import\(\)/.test(body));
    const run = async (purgeAll) => {
      const order = [];
      const win = {
        auth: {}, location: { href: '' }, showToast: () => {},
        NBDSmsOutbox: purgeAll ? { purgeAll: () => purgeAll(order) } : undefined,
      };
      const fastTimeout = (fn, ms) => setTimeout(fn, ms >= 1000 ? 20 : ms);
      const __import = async () => ({ signOut: async () => { order.push('signOut'); } });
      new Function('window', '__import', 'setTimeout', 'console', body)(win, __import, fastTimeout, QUIET);
      await wait(80);
      return { order, win };
    };
    const a = await run((order) => { order.push('purge-start'); return wait(10).then(() => { order.push('purge-done'); return true; }); });
    ok('customer.html palette sign-out purges the SMS outbox, and only THEN signs out',
      a.order.join(',') === 'purge-start,purge-done,signOut' && a.win.location.href === '/pro/login.html', a.order.join(','));
    const b = await run((order) => { order.push('purge-start'); return new Promise(() => {}); });
    ok('…a purge that never settles cannot keep the rep signed in (bounded)', b.order.join(',') === 'purge-start,signOut', b.order.join(','));
    const c = await run(null);
    ok('…and a page without the outbox signs out as before', c.order.join(',') === 'signOut');
  }
  {
    // Account switch: rep-1 leaves texts; rep-2 opens the page on the same device.
    const disk = newDisk();
    const a = loadPage({ online: false, disk });
    await booted(a);
    await a.comms.sendSMS(SMS);
    ok('rep-1 has a queued text', rowsOn(disk).length === 1);
    const b = loadPage({ online: true, disk, user: { uid: 'rep-2', getIdToken: async () => 't' } });
    await booted(b);
    ok('rep-2 signing in on the same device: rep-1\'s text is deleted, never shown, never sent',
      rowsOn(disk).length === 0 && b.posts.length === 0, JSON.stringify(rowsOn(disk)));
    const pill = b.document.getElementById('nbd-sms-outbox-pill');
    ok('…and rep-2 sees no pill', !pill || !pill.classList.contains('is-visible'));
  }
  {
    const disk = newDisk();
    const a = loadPage({ online: false, disk });
    await booted(a);
    const other = await a.ob.enqueue({ uid: 'rep-2', to: '5135550009', body: 'not mine', createdAt: Date.now() - MIN });
    a.window.navigator.onLine = true;
    await a.ob.flush('t');
    ok('a flush never sends another user\'s record', a.posts.length === 0);
    ok('list() never returns another user\'s record', (await a.ob.list('rep-1')).length === 0);
    await a.ob.discard(other.id);
    await a.ob.sendNow(other.id);
    await a.ob.editAndSend(other.id, 'rewritten by someone else');
    ok('discard() / sendNow() / editAndSend() by id cannot touch another user\'s record',
      rowsOn(disk).some((r) => r.id === other.id && r.status === 'queued' && r.body === 'not mine')
      && rowsOn(disk).filter((r) => r.uid === 'rep-2').length === 1 && a.posts.length === 0,
      JSON.stringify(rowsOn(disk).map((r) => [r.uid, r.body])));
    // Another account's leftover with the SAME number and words, older than
    // this rep's: it must neither swallow this rep's text as a "duplicate"
    // nor hold it back in the per-recipient queue.
    await a.ob.enqueue({ uid: 'rep-2', to: '5135550009', body: 'same words', createdAt: Date.now() - 3 * MIN });
    await a.ob.enqueue({ uid: 'rep-1', to: '5135550009', body: 'same words', createdAt: Date.now() - 2 * MIN });
    await a.ob.flush('t2');
    ok('another account\'s identical older text never collapses or blocks this rep\'s',
      a.posts.length === 1 && a.posts[0].body.body === 'same words' && !rowsOn(disk).some((r) => r.uid === 'rep-1'),
      JSON.stringify(rowsOn(disk).map((r) => [r.uid, r.status, r.heldReason])));
  }

  // ═══ 7. consumers ═════════════════════════════════════════════════════
  console.log('7. CONSUMERS — mode "queued" is NOT sent');
  const QUEUED = { success: true, mode: 'queued', id: 'q-1' };
  {
    // invoice-pipeline.js — runs for real; Firestore is a stub. It loads
    // BEFORE the outbox here (lazy on customer.html, any order on the
    // dashboard), so it registers through the 'nbd:sms-outbox-ready' event.
    const writes = [];
    let status = 'draft';
    const listeners = {};
    const handlers = {};
    const win = {
      console: QUIET,
      _db: { name: 'db' },
      doc: (db, col, id) => ({ path: col + '/' + id }),
      collection: () => ({}),
      getDoc: async (ref) => ({ exists: () => true, data: () => ({ status, customerPhone: '(859) 555-0134', leadId: 'lead-1' }) }),
      updateDoc: async (ref, data) => { writes.push({ path: ref.path, data }); if (data.status) status = data.status; },
      showToast: () => {},
      NBDComms: { sendSMS: async (o) => { win._smsArgs = o; return QUEUED; } },
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    };
    win.window = win;
    const ctx = vm.createContext(Object.assign(win, { Date, JSON, Math, Promise, Object, Array, String, Number, Error, isNaN, parseFloat, setTimeout, clearTimeout }));
    vm.runInContext(INV_SRC, ctx, { filename: 'invoice-pipeline.js' });
    const r = await win.InvoicePipeline.sendInvoice('inv-1', 'sms');
    await wait(5);
    ok('invoice SMS queued: sendInvoice returns { queued: true }', r && r.queued === true, JSON.stringify(r));
    ok('invoice SMS queued: the invoice is NEVER written "sent"', !writes.some((w) => w.data.status === 'sent'), JSON.stringify(writes));
    ok('…its send lock is released back to "draft"', writes.some((w) => w.data.status === 'draft') && status === 'draft');
    ok('…and the text carries source "invoice-sms" + the invoice id', win._smsArgs.source === 'invoice-sms' && win._smsArgs.sourceRef === 'inv-1');
    ok('invoice-pipeline no longer stamps from the in-tab window event', !(listeners['nbd:sms-outbox-sent'] || []).length);
    win.NBDSmsOutbox = { onSent: (src, fn) => { handlers[src] = fn; return true; } };
    (listeners['nbd:sms-outbox-ready'] || []).forEach((fn) => fn({ type: 'nbd:sms-outbox-ready' }));
    ok('loaded before the outbox: it registers an "invoice-sms" receipt handler when the outbox announces itself',
      typeof handlers['invoice-sms'] === 'function');
    const apply = handlers['invoice-sms'] || (async () => false);
    await apply({ source: 'invoice-sms', sourceRef: 'inv-1' });
    ok('applying the receipt (the outbox actually sent it) marks the invoice "sent" then', status === 'sent');
    status = 'paid';
    const n = writes.length;
    await apply({ source: 'invoice-sms', sourceRef: 'inv-1' });
    ok('…but never over a paid/void/already-sent invoice', writes.length === n && status === 'paid');
    // Firestore not up yet: the handler must THROW so the receipt is kept.
    const saved = win._db; win._db = null;
    let threw = false;
    try { await apply({ source: 'invoice-sms', sourceRef: 'inv-1' }); } catch (_) { threw = true; }
    win._db = saved;
    ok('…and throws (receipt kept for the next drain) while Firestore is not up', threw);
  }

  {
    // ── OFFLINE: the lock-acquire write must not park the whole send ──────
    // This app runs Firestore with NO local persistence (nbd-auth.js's
    // initializeFirestore has no localCache), so offline an updateDoc does not
    // reject — it never settles. sendInvoice awaited that write BEFORE calling
    // NBDComms.sendSMS, so the queued branch was unreachable in exactly the
    // state it exists for. The rep saw "Sending invoice via sms…", that toast
    // self-removed at 2600ms, and then silence.
    //
    // The stub above resolves updateDoc immediately, which is precisely why the
    // bug shipped green. Here updateDoc NEVER settles, the way it behaves on a
    // roof with no signal.
    const writes = [];
    const listeners = {};
    const win = {
      console: QUIET,
      _db: { name: 'db' },
      __nbdInvoiceLockTimeoutMs: 10,   // keep the abandon path fast; see below
      doc: (db, col, id) => ({ path: col + '/' + id }),
      collection: () => ({}),
      // getDoc still resolves: Firestore serves it from the in-memory cache.
      getDoc: async (ref) => ({ exists: () => true, data: () => ({ status: 'draft', customerPhone: '(859) 555-0134', leadId: 'lead-1' }) }),
      updateDoc: (ref, data) => { writes.push({ path: ref.path, data }); return new Promise(() => {}); },
      showToast: () => {},
      NBDComms: { sendSMS: async (o) => { win._smsArgs = o; return QUEUED; } },
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    };
    win.window = win;
    const ctx = vm.createContext(Object.assign(win, { Date, JSON, Math, Promise, Object, Array, String, Number, Error, isNaN, parseFloat, setTimeout, clearTimeout }));
    vm.runInContext(INV_SRC, ctx, { filename: 'invoice-pipeline.js' });

    const settled = await Promise.race([
      win.InvoicePipeline.sendInvoice('inv-9', 'sms'),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 3000)),
    ]);
    ok('offline (updateDoc never settles): sendInvoice still returns instead of hanging',
      settled !== 'HUNG',
      'the lock-acquire await parked the function before NBDComms.sendSMS was ever called');
    ok('…it returns { queued: true }', settled && settled.queued === true, JSON.stringify(settled));
    ok('…and the text actually reached the outbox', win._smsArgs && win._smsArgs.sourceRef === 'inv-9');
    ok('…the lock write was still ATTEMPTED (latency compensation keeps the double-tap guard honest)',
      writes.some((w) => w.data && w.data.status === 'sending'));
  }

  {
    // ── OFFLINE + PAID: the send lock must be RELEASED, not left on ────────
    // The round-3 review's blocker. _releaseSendLock prefers window.runTransaction,
    // and BOTH CRM pages define it — but a Firestore transaction cannot run
    // offline, and the queued path only ever executes BECAUSE we are offline.
    // So the restore was routed through the one primitive guaranteed not to
    // work there, and a PAID invoice whose queued text was later discarded sat
    // at status:'sending' forever. money-dashboard.js skips only
    // status === 'paid', so its full face value re-entered Outstanding A/R and
    // the Collections queue, and the detail view re-offered "Mark Paid".
    //
    // This asserts the OUTCOME (the invoice ends up 'paid' again), not the
    // mechanism, so it stays honest if the implementation changes.
    const writes = [];
    let status = 'paid';
    const listeners = {};
    const win = {
      console: QUIET,
      _db: { name: 'db' },
      __nbdInvoiceLockTimeoutMs: 10,
      doc: (db, col, id) => ({ path: col + '/' + id }),
      collection: () => ({}),
      getDoc: async (ref) => ({ exists: () => true, data: () => ({ status, sendingPriorStatus: status === 'sending' ? 'paid' : null, customerPhone: '(859) 555-0134', leadId: 'lead-1', total: 12000, balanceDue: 0 }) }),
      updateDoc: async (ref, data) => { writes.push({ path: ref.path, data }); if (data.status) status = data.status; },
      // A transaction is what the real page exposes — and offline it never
      // settles. Before the fix the release went through here and stalled.
      runTransaction: () => new Promise(() => {}),
      showToast: () => {},
      NBDComms: { sendSMS: async (o) => { win._smsArgs = o; return QUEUED; } },
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    };
    win.window = win;
    const ctx = vm.createContext(Object.assign(win, { Date, JSON, Math, Promise, Object, Array, String, Number, Error, isNaN, parseFloat, setTimeout, clearTimeout }));
    vm.runInContext(INV_SRC, ctx, { filename: 'invoice-pipeline.js' });

    const r = await win.InvoicePipeline.sendInvoice('inv-paid', 'sms');
    await wait(40);
    ok('offline PAID invoice: the text still queues', r && r.queued === true, JSON.stringify(r));
    ok('THE FIX: the send lock is released even though runTransaction cannot run offline',
      status !== 'sending',
      `invoice left at status='${status}' — a paid invoice stuck 'sending' re-enters Outstanding A/R and Collections`);
    ok('…and it is restored to PAID, never "draft"', status === 'paid',
      `got '${status}'`);
    ok('…the restore went through the non-transactional arm (an updateDoc actually happened)',
      writes.some((w) => w.data && w.data.status === 'paid'));
  }
  {
    // invoice-pipeline.js sendInvoiceUI — the method-picker click the rep
    // actually taps. A queued text must not toast "Invoice sent successfully".
    const toastsUI = [];
    const methodBtns = ['email', 'sms', 'portal'].map((m) => ({ dataset: { method: m }, onclick: null }));
    const cancel = { onclick: null };
    const mkEl = () => ({
      id: '', className: '', style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {}, removeEventListener() {}, remove() {},
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
      querySelector: (s) => (s === '#nbd-send-cancel' ? cancel : null),
      querySelectorAll: (s) => (s === '.nbd-send-method' ? methodBtns : []),
    });
    const makeInvoiceWin = (smsResult) => {
      let status = 'draft';
      const win = {
        console: QUIET,
        _db: { name: 'db' },
        doc: (db, col, id) => ({ path: col + '/' + id }),
        collection: () => ({}),
        getDoc: async () => ({ exists: () => true, data: () => ({ status, customerPhone: '(859) 555-0134', leadId: 'lead-1' }) }),
        updateDoc: async (ref, data) => { if (data.status) status = data.status; },
        showToast: (msg, type) => toastsUI.push({ msg: String(msg), type }),
        NBDComms: { sendSMS: async () => smsResult },
        addEventListener() {},
        document: {
          createElement: () => mkEl(), getElementById: () => null, body: { appendChild() {} },
          addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [],
        },
      };
      win.window = win;
      const ctx = vm.createContext(Object.assign(win, { Date, JSON, Math, Promise, Object, Array, String, Number, Error, isNaN, parseFloat, setTimeout, clearTimeout }));
      vm.runInContext(INV_SRC, ctx, { filename: 'invoice-pipeline.js' });
      return win;
    };
    const w1 = makeInvoiceWin(QUEUED);
    w1.InvoicePipeline.sendInvoiceUI('inv-1');
    await methodBtns[1].onclick();
    ok('sendInvoiceUI → "Send via SMS" while offline: the queued toast, NOT "Invoice sent successfully"',
      toastsUI.some((t) => /queued/.test(t.msg) && /stays unsent/.test(t.msg)) && !toastsUI.some((t) => /Invoice sent successfully/.test(t.msg)),
      JSON.stringify(toastsUI));
    toastsUI.length = 0;
    const w2 = makeInvoiceWin({ success: true, mode: 'platform', sid: 'SM1' });
    w2.InvoicePipeline.sendInvoiceUI('inv-1');
    await methodBtns[1].onclick();
    ok('…and a real platform send still says "Invoice sent successfully" (the harness tells them apart)',
      toastsUI.some((t) => /Invoice sent successfully/.test(t.msg)) && !toastsUI.some((t) => /queued/.test(t.msg)), JSON.stringify(toastsUI));
  }
  {
    // close-board.js sendViaSMS + its receipt handler, lifted out with their deps.
    const applySrc = extractFunction(CB_SRC, '_applyDealSmsReceipt');
    const regSrc = extractFunction(CB_SRC, '_registerDealSmsReceipts');
    const sendSrc = extractFunction(CB_SRC, 'sendViaSMS');
    ok('close-board: no in-tab window-event stamp left', !/addEventListener\('nbd:sms-outbox-sent'/.test(CB_SRC));
    const updates = [];
    const handlers = {};
    const calls = [];
    const deal = { id: 'd1', customerPhone: '(859) 555-0134', customerName: 'Sam', leadId: 'lead-1', status: 'draft' };
    const stored = [deal];
    let dealRooms = [];                            // before init(): nothing loaded yet
    const win = {
      NBDComms: { sendSMS: async (o) => { win._args = o; return QUEUED; } },
      NBDSmsOutbox: { onSent: (src, fn) => { handlers[src] = fn; return true; } },
      showToast: () => {},
      open: () => { win._opened = true; },
    };
    const updateDeal = (id, u) => { updates.push({ id, u }); Object.assign(dealRooms.find((d) => d.id === id), u); };
    // _findDeal / _dealRoomsForCurrentUser arrived with the Close Board
    // per-account cache (#1690): sendViaSMS no longer indexes `dealRooms`
    // directly, it goes through the account-scoped accessor. This lift has to
    // supply it or the composed function throws ReferenceError — which is what
    // happened the moment this branch was rebased onto that merge. Kept as a
    // named collaborator rather than inlined so the next refactor over there
    // fails loudly here instead of silently testing a stale shape.
    const factory = new Function('window', 'getDealAcceptLink', '_dealBrand', 'DEAL_STATUS', 'updateDeal', 'loadDealRooms', 'render', 'getRooms', 'setRooms', '_findDeal',
      "const DEAL_SMS_SOURCE = 'deal-sms'; let currentTab = 'active';\n"
      // 2026-10-03: sendViaSMS routes through Jo's phone unless the server
      // number is A2P-approved (estimate-send-track test §D). This lift
      // exercises the A2P-approved platform send, the one the outbox queues.
      + "let _serverSmsOk = true; const _phonePending = Object.create(null);\n"
      + "const _shareDealFromPhone = async () => { throw new Error('phone path not expected with A2P approved'); };\n"
      + 'let dealRooms = getRooms();\n'
      + applySrc.replace('loadDealRooms();', 'loadDealRooms(); dealRooms = getRooms();') + '\n' + regSrc + '\nasync ' + sendSrc
      + '\n_registerDealSmsReceipts();\nreturn { sendViaSMS, sync: () => { dealRooms = getRooms(); } };');
    const api = factory(win, async () => 'https://nobigdealwithjoedeal.com/deal/tok', () => ({ name: 'NBD' }),
      { DRAFT: 'draft', SENT: 'sent' }, updateDeal,
      () => { calls.push('load'); dealRooms = stored; }, () => calls.push('render'),
      () => dealRooms, (v) => { dealRooms = v; },
      (id) => dealRooms.find((d) => d.id === id));
    ok('close-board registers a "deal-sms" receipt handler with the outbox at load', typeof handlers['deal-sms'] === 'function');
    // A receipt drained before the board's init(): the deal is still only in localStorage.
    const applied = await handlers['deal-sms']({ source: 'deal-sms', sourceRef: 'd1' });
    ok('close-board: a receipt applied before init() loads the deals first and stamps SENT',
      calls[0] === 'load' && deal.status === 'sent' && updates.length === 1 && applied === true, JSON.stringify({ calls, updates }));
    ok('…and repaints the board', calls.includes('render'));
    deal.status = 'draft'; updates.length = 0; api.sync();
    await api.sendViaSMS('d1');
    ok('close-board: a queued deal text does NOT stamp the deal SENT', updates.length === 0 && deal.status === 'draft', JSON.stringify(updates));
    ok('…and passes source "deal-sms" + the deal id', win._args.source === 'deal-sms' && win._args.sourceRef === 'd1');
    deal.status = 'accepted';
    await handlers['deal-sms']({ source: 'deal-sms', sourceRef: 'd1' });
    ok('…but a receipt never rewinds a deal that moved on', deal.status === 'accepted' && updates.length === 0);
  }
  {
    // portal-link-helpers.js smsForLead — runs for real.
    const writes = [];
    const handlers = {};
    const leads = [{ id: 'lead-1', phone: '(859) 555-0134', firstName: 'Sam', stage: 'estimate' }];
    const win = {
      console: QUIET,
      _leads: leads,
      _mintPortalUrl: async () => 'https://nobigdealwithjoedeal.com/pro/portal.html?token=abc',
      NBDComms: { sendSMS: async (o) => { win._args = o; return QUEUED; } },
      NBDSmsOutbox: { onSent: (src, fn) => { handlers[src] = fn; return true; } },
      showToast: () => {},
      db: {}, doc: (db, c, id) => ({ path: c + '/' + id }),
      updateDoc: async (ref, d) => { writes.push({ path: ref.path, d }); },
      addEventListener: () => {},
      dispatchEvent: () => true,
      CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
      location: { href: '' },
      document: { getElementById: () => null, querySelector: () => null, addEventListener() {}, createElement: () => ({ style: {} }) },
      navigator: {},
    };
    win.window = win;
    const ctx = vm.createContext(Object.assign(win, { URL, Date, JSON, Math, Promise, Object, Array, String, Set, Map, Error, encodeURIComponent, setTimeout }));
    vm.runInContext(PLH_SRC, ctx, { filename: 'portal-link-helpers.js' });
    await win.PortalLinkHelpers.smsForLead(leads[0]);
    ok('portal link: a queued text is NOT recorded as a share (no lastSharedAt)',
      writes.length === 0 && !leads[0].lastSharedAt && !win._leads[0].lastSharedAt, JSON.stringify(writes));
    ok('…and passes leadStage + source for the outbox', win._args.leadStage === 'estimate' && win._args.source === 'portal-share-sms' && win._args.sourceRef === 'lead-1');
    ok('…and registers a "portal-share-sms" receipt handler', typeof handlers['portal-share-sms'] === 'function');
    const saved = win.db; win.db = null;
    let threw = false;
    try { await handlers['portal-share-sms']({ source: 'portal-share-sms', sourceRef: 'lead-1' }); } catch (_) { threw = true; }
    win.db = saved;
    ok('…whose handler throws (keeps the receipt) while Firestore is not up, instead of silently skipping the write',
      threw && writes.length === 0);
    await handlers['portal-share-sms']({ source: 'portal-share-sms', sourceRef: 'lead-1' });
    ok('…it becomes a share when the receipt is applied', writes.length === 1 && writes[0].d.lastSharedVia === 'sms');
  }
  {
    // smart-followup.js executeSuggestion — lifted with its helpers.
    const recorded = [];
    const factory = new Function('window', 'computeSuggestion', 'recordOutcome', 'leadName',
      'async ' + extractFunction(SF_SRC, 'executeSuggestion') + '\nreturn executeSuggestion;');
    const win = { NBDComms: { sendSMS: async (o) => { win._args = o; return QUEUED; } } };
    const exec = factory(win, () => null, (id, o) => recorded.push(o), () => 'Sam');
    const r = await exec({ id: 'lead-1', phone: '(859) 555-0134', stage: 'follow_up' }, { action: 'text', channel: 'sms', draft: 'Hi Sam' });
    ok('smart-followup: returns mode "queued" to its caller unchanged', r.mode === 'queued' && r.success === true);
    ok('…and passes the lead stage for the outbox', win._args.leadStage === 'follow_up' && win._args.source === 'smart-followup-sms');
  }
  {
    // customer-smart-followup-panel.js — a queued result is final: no fallback re-send.
    const factory = new Function('window', '_dismissedThisSession', 'update',
      extractFunction(PANEL_SRC, 'wireActions') + '\nreturn wireActions;');
    const calls = [];
    let handler = null;
    const btn = { getAttribute: () => 'sms', addEventListener: (ev, fn) => { handler = fn; }, disabled: false };
    const host = { querySelectorAll: (s) => (s === '[data-csf-action]' ? [btn] : []), querySelector: () => ({ textContent: 'Hi' }) };
    const win = {
      SmartFollowup: { computeSuggestion: () => ({ draft: 'x' }), executeSuggestion: async () => QUEUED, recordOutcome: () => {} },
      PortalLinkHelpers: { smsForLead: () => calls.push('smsForLead'), emailForLead: () => calls.push('emailForLead') },
    };
    factory(win, new Set(), () => {})(host, { id: 'lead-1' });
    await handler({ stopPropagation() {} });
    ok('customer panel: a queued text does NOT fall back to smsForLead (no second message)', calls.length === 0, calls.join());
  }
  {
    // d2d-tracker-core-2026b.js sendFollowUpSMS.
    const factory = new Function('window', 'state', 'SMS_TEMPLATES', '_fillTemplate', 'formatDate',
      extractFunction(D2D_SRC, 'sendFollowUpSMS') + '\nreturn sendFollowUpSMS;');
    const opened = []; const toasts = []; let args = null;
    const win = {
      NBDComms: { sendSMS: async (...a) => { args = a; return QUEUED; } },
      open: (u) => opened.push(u), showToast: (m, t) => toasts.push(m), _user: { displayName: 'Joe' },
    };
    factory(win, { currentRep: { name: 'Joe' } }, { follow_up: { body: 'Hi {name}' } }, (b) => b, () => 'soon')(
      { id: 'knock-1', phone: '(859) 555-0134', homeowner: 'Sam', disposition: 'follow_up' }, 'follow_up');
    await wait(5);
    ok('D2D: a queued follow-up shows no "Text sent" toast and opens nothing',
      !toasts.some((m) => /Text sent/.test(m)) && opened.length === 0, JSON.stringify(toasts));
    ok('D2D: still the positional call (phone, body, knockId) plus the source option',
      args && args[0] === '(859) 555-0134' && args[2] === 'knock-1' && args[3] && args[3].source === 'd2d-followup-sms');
    ok('D2D: no sourceRef (no knock stamper exists, so no receipt would ever be applied)', args && args[3] && !('sourceRef' in args[3]));
  }

  // ═══ 7b. receipts ═════════════════════════════════════════════════════
  console.log('7b. RECEIPTS — "it went out" survives other tabs, page loads and late-loading stampers');
  const queueInvoiceText = async (h, ref) => {
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'Your invoice', createdAt: Date.now() - MIN, source: 'invoice-sms', sourceRef: ref });
  };
  {
    // Tab A flushes with NO invoice handler loaded (customer.html before the
    // invoice panel opened); tab B loads invoice-pipeline later.
    const disk = newDisk(); const LS = {};
    const a = loadPage({ online: false, disk, localStorage: LS });
    await booted(a);
    await queueInvoiceText(a, 'inv-A');
    a.window.navigator.onLine = true;
    await a.ob.flush('t');
    const r = rowsOn(disk);
    ok('sent in a tab with no stamper: a receipt stays (no phone, no message)',
      r.length === 1 && r[0].status === 'sent' && r[0].sourceRef === 'inv-A' && !r[0].to && !r[0].body, JSON.stringify(r));
    const b = loadPage({ online: true, disk, localStorage: LS });
    await booted(b);
    const got = [];
    b.ob.onSent('invoice-sms', (d) => { got.push(d.sourceRef); });
    await until(() => got.length === 1 && rowsOn(disk).length === 0);
    ok('…a page that registers the handler later (another tab, a relaunch) applies it and deletes the receipt',
      got.join() === 'inv-A' && rowsOn(disk).length === 0, JSON.stringify({ got, rows: rowsOn(disk) }));
  }
  {
    // Tab B already has the handler; tab A sends. BroadcastChannel tells B.
    const disk = newDisk(); const LS = {}; const bus = makeBus();
    const a = loadPage({ online: false, disk, localStorage: LS, bus });
    const b = loadPage({ online: true, disk, localStorage: LS, bus });
    await booted(a); await booted(b);
    const got = [];
    b.ob.onSent('invoice-sms', (d) => { got.push(d.sourceRef); });
    await queueInvoiceText(a, 'inv-B');
    a.window.navigator.onLine = true;
    await a.ob.flush('t');
    await until(() => got.length === 1 && rowsOn(disk).length === 0);
    ok('the handler in ANOTHER open tab applies a receipt the flushing tab left', got.join() === 'inv-B' && rowsOn(disk).length === 0, JSON.stringify(got));
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    let fail = true; const got = [];
    h.ob.onSent('invoice-sms', (d) => { if (fail) throw new Error('Firestore not ready'); got.push(d.sourceRef); });
    await queueInvoiceText(h, 'inv-C');
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    await wait(20);
    const kept = h.rows();
    ok('a handler that throws leaves the receipt ("sent", not lost, not stuck "acking")',
      kept.length === 1 && kept[0].status === 'sent' && got.length === 0, JSON.stringify(kept));
    fail = false;
    await h.ob.flush('again');
    await until(() => got.length === 1 && h.rows().length === 0);
    ok('…and the next drain applies it', got.join() === 'inv-C' && h.rows().length === 0);
  }
  {
    // Two tabs with the handler, one receipt: applied ONCE.
    const disk = newDisk(); const LS = {}; const bus = makeBus();
    const a = loadPage({ online: false, disk, localStorage: LS, bus });
    const b = loadPage({ online: false, disk, localStorage: LS, bus });
    await booted(a); await booted(b);
    await queueInvoiceText(a, 'inv-D');
    a.window.navigator.onLine = true;
    await a.ob.flush('t');                        // no handlers yet → receipt waits
    const got = [];
    const slow = (d) => wait(15).then(() => { got.push(d.sourceRef); });
    a.ob.onSent('invoice-sms', slow);
    b.ob.onSent('invoice-sms', slow);
    await wait(80);
    ok('two tabs with the same handler: the receipt is applied exactly once', got.join() === 'inv-D' && rowsOn(disk).length === 0, JSON.stringify(got));
  }
  {
    // A page that died mid-handler left the receipt 'acking': offered again.
    const h = loadPage({ online: false });
    await booted(h);
    await queueInvoiceText(h, 'inv-E');
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    const table = h.disk.dbs['nbd-sms-outbox-db'].stores.outbox;
    const rec = [...table.values()][0];
    table.set(rec.id, Object.assign({}, rec, { status: 'acking', ackingAt: Date.now() - 3 * MIN }));
    const got = [];
    h.ob.onSent('invoice-sms', (d) => { got.push(d.sourceRef); });
    await wait(10);
    ok('(an "acking" receipt is not re-applied while its page may still be at it)', got.length === 0);
    await h.ob.flush('later');
    await until(() => got.length === 1);
    ok('an orphaned "acking" receipt (2+ min) goes back to "sent" and is applied', got.join() === 'inv-E' && h.rows().length === 0);
  }
  {
    const h = loadPage({ online: false });
    await booted(h);
    await queueInvoiceText(h, 'inv-F');
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    const table = h.disk.dbs['nbd-sms-outbox-db'].stores.outbox;
    const rec = [...table.values()][0];
    table.set(rec.id, Object.assign({}, rec, { sentAt: Date.now() - 8 * 24 * 60 * MIN }));
    await h.ob.flush('prune');
    ok('a receipt nothing claimed in a week is pruned', h.rows().length === 0);
  }
  {
    // portal-link-helpers.js loads BEFORE sms-outbox.js on dashboard.html:
    // it must still get its receipts (via 'nbd:sms-outbox-ready').
    const writes = [];
    const h = loadPage({
      online: false,
      preOutbox: [[PLH_SRC, 'portal-link-helpers.js']],
      before: (w) => {
        w.db = {}; w.doc = (db, c, id) => ({ path: c + '/' + id });
        w.updateDoc = async (ref, d) => { writes.push({ path: ref.path, d }); };
        w._leads = [{ id: 'lead-1', phone: SMS.to, stage: 'estimate' }];
      },
    });
    await booted(h);
    await h.ob.enqueue({ uid: 'rep-1', to: SMS.to, body: 'portal link', createdAt: Date.now() - MIN, source: 'portal-share-sms', sourceRef: 'lead-1' });
    h.window.navigator.onLine = true;
    await h.ob.flush('t');
    await until(() => writes.length === 1 && h.rows().length === 0);
    ok('portal-link-helpers.js loaded BEFORE the outbox still records the share when the queued text goes',
      writes.length === 1 && writes[0].path === 'leads/lead-1' && writes[0].d.lastSharedVia === 'sms' && h.rows().length === 0,
      JSON.stringify(writes));
  }

  // ═══ 8. wiring ════════════════════════════════════════════════════════
  console.log('8. WIRING');
  {
    for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
      const html = read(page);
      // Any ?v= of nbd-comms.js (bumped with each change to it).
      const m = /<script defer src="js\/nbd-comms\.js\?v=\d+"><\/script>/.exec(html);
      const i = m ? m.index : -1;
      const j = html.indexOf('<script defer src="js/sms-outbox.js?v=1"></script>');
      ok(page + ' loads sms-outbox.js (defer) right after nbd-comms.js', i >= 0 && j > i && html.slice(i, j).split('<script').length === 2);
    }
    ok('sms-outbox.js has its OWN IndexedDB (not offline-manager\'s nbd-offline-db, which sw.js replays)',
      /const DB_NAME = 'nbd-sms-outbox-db'/.test(OUTBOX_SRC) && !/nbd-offline-db|pending-writes/.test(OUTBOX_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    ok('no localStorage copy of phone numbers or message text (only the flush lease key)',
      (OUTBOX_SRC.match(/localStorage\.setItem\(/g) || []).length === 1 && /localStorage\.setItem\(LEASE_KEY/.test(OUTBOX_SRC));
    ok('no inline handlers in the tray (CSP)', !/\.on(click|change|input)\s*=|innerHTML/.test(OUTBOX_SRC));
  }

  finished = true;
  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('suite crashed:', (e && e.stack) || e);
  process.exit(1);
});
