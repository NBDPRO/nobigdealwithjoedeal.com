/**
 * tests/client-dead-calls-2026-10-03.test.js — CRM controls that called a
 * global which never existed, so a `typeof x === 'function'` guard quietly
 * turned every tap into the fallback.
 *
 *  1. command-palette "New Lead" called window.openNewLeadModal (defined
 *     nowhere; the real one is window.openLeadModal, crm.js) — so it only
 *     ever navigated to the board, and the rep had to find "+ Lead" by hand.
 *  2. Settings → Appearance font grid: two pickers fought over one grid.
 *     ui.js wiped the 28-font grid (key 'nbd_font', the one the CSS reads)
 *     and redrew maps.js's 8 pairings (key 'nbd-font') with a ✓ read from
 *     window._nbd_activeFont — a maps.js `let`, never on window, so no ✓.
 *     And on reload maps.js re-applied a stale 'nbd-font' over the user's
 *     Settings pick.
 *  3. lead-score-alert + buying-intent-strike called window.openCardDetail
 *     (never existed; the real global is openCardDetailModal), so every tap
 *     was a full page load of customer.html.
 *  4. push-actions snooze checked window.snoozeLead (never existed), so a
 *     push "Snooze 1h" took a bare fallback write with no snoozeCount /
 *     snoozedReason / cache patch. It now uses LeadSnooze.snooze, waiting for
 *     lead-snooze.js, which loads AFTER push-actions.js on dashboard.html.
 *
 * Behaviour, not regex: each module (or the exact function under test) runs
 * in a vm with a minimal window/document stub and the test asserts which
 * function got called.
 *
 * Zero deps. Run: node tests/client-dead-calls-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── A tiny DOM: enough for createElement/appendChild/click listeners ──────
function makeDom() {
  const byId = new Map();
  const created = [];
  function el(tag) {
    const e = {
      tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [], parentNode: null,
      _listeners: {}, _id: '', textContent: '', innerHTML: '', type: '',
      get id() { return this._id; },
      set id(v) { this._id = v; byId.set(v, this); },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this[k] = v; },
      click() { (this._listeners.click || []).forEach((fn) => fn({ target: this })); },
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    created.push(e);
    return e;
  }
  const document = {
    readyState: 'complete', hidden: false,
    body: el('body'), head: el('head'), documentElement: { style: { setProperty() {} } },
    createElement: el,
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return { document, created, byId, el };
}
function makeStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
// ── 1. Command palette "New Lead" ─────────────────────────────────────────
console.log('COMMAND PALETTE — New Lead opens the lead modal');
{
  const src = read('command-palette.js');
  // The action list is module-private; expose it for the test only. The
  // positive control below fails if this hook stops matching.
  const HOOK = 'window.NBDCommand = {';
  const hooked = src.replace(HOOK, HOOK + ' __testActions: () => _allActions(),');
  ok('test hook attached to the palette module (positive control)', hooked !== src);

  function load(win) {
    const { document } = makeDom();
    const ctx = { window: win, document, localStorage: makeStorage(), console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0 };
    vm.createContext(ctx);
    vm.runInContext(hooked, ctx, { filename: 'command-palette.js' });
    return win.NBDCommand.__testActions().find((a) => a.id === 'action-new-lead');
  }

  const calls = [];
  const win = {
    openLeadModal: () => calls.push('openLeadModal'),
    goTo: (v) => calls.push('goTo:' + v),
    location: { href: '' },
  };
  const action = load(win);
  ok('"New Lead" action exists', !!action);
  if (action) action.run();
  ok('"New Lead" opens window.openLeadModal (crm.js)', calls.join(',') === 'openLeadModal', JSON.stringify(calls));

  // Control: off-dashboard (no lead modal), it still lands on the board.
  const calls2 = [];
  const action2 = load({ goTo: (v) => calls2.push('goTo:' + v), location: { href: '' } });
  if (action2) action2.run();
  ok('without the modal it falls back to the CRM board', calls2.join(',') === 'goTo:crm', JSON.stringify(calls2));
}

// ── 3a. Hot-lead alert card ───────────────────────────────────────────────
console.log('\nLEAD-SCORE ALERT — tap opens the card modal, not a page load');
{
  function run(withModal) {
    const dom = makeDom();
    const timers = [];
    const winListeners = {};
    const opened = [];
    const win = {
      __NBD_LOADED: {},
      _leads: [{ id: 'L1', firstName: 'Sarah', lastName: 'Jones' }],
      NBDLeadScore: { score: () => 90, breakdown: () => ({ score: 90, topReason: 'viewed estimate' }) },
      location: { href: '/pro/dashboard.html' },
      addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    };
    if (withModal) win.openCardDetailModal = (id) => opened.push(id);
    const ctx = {
      window: win, document: dom.document,
      localStorage: makeStorage({ nbd_lead_score_last_v1: JSON.stringify({ L1: 70 }) }),
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      Date, JSON, Set, Array, console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(ctx);
    vm.runInContext(read('lead-score-alert.js'), ctx, { filename: 'lead-score-alert.js' });
    // Run the initial delayed check (and anything it schedules, once).
    timers.splice(0).forEach((fn) => fn());
    const card = dom.created.find((e) => e.tagName === 'BUTTON' && (e._listeners.click || []).length);
    if (card) card.click();
    return { card, opened, href: win.location.href };
  }
  const r = run(true);
  ok('a lead crossing into Hot renders a tappable card', !!r.card);
  ok('tapping it opens window.openCardDetailModal with the lead id', r.opened.join(',') === 'L1', JSON.stringify(r.opened));
  ok('…and does NOT do a full page load of customer.html', r.href === '/pro/dashboard.html', r.href);
  const r2 = run(false);
  ok('control: with no modal function it still deep-links to customer.html',
    r2.href === '/pro/customer.html?id=L1', r2.href);
}

// ── 3b. Buying-intent strike "View" ───────────────────────────────────────
console.log('\nBUYING-INTENT STRIKE — View opens the card modal, not a page load');
{
  function run(withModal) {
    const dom = makeDom();
    const opened = [];
    const win = {
      _leads: [{ id: 'L1', firstName: 'Sarah', lastName: 'Jones', phone: '5135550100', stage: 'inspected' }],
      _estimates: [{ id: 'E1', leadId: 'L1', total: 18000, viewedAt: new Date(Date.now() - 60000).toISOString() }],
      location: { href: '/pro/dashboard.html' },
      addEventListener() {},
    };
    if (withModal) win.openCardDetailModal = (id) => opened.push(id);
    const ctx = {
      window: win, document: dom.document,
      sessionStorage: makeStorage(),
      setTimeout: () => 0, clearTimeout() {},
      console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(ctx);
    // The module's IIFE takes `window` as root when it is defined.
    vm.runInContext(read('buying-intent-strike.js'), ctx, { filename: 'buying-intent-strike.js' });
    win.BuyingIntentStrike.scan();
    const view = dom.created.find((e) => e.tagName === 'BUTTON' && e.textContent === 'View');
    if (view) view.click();
    return { view, opened, href: win.location.href };
  }
  const r = run(true);
  ok('a fresh estimate view renders the strike card with a View button', !!r.view);
  ok('View opens window.openCardDetailModal with the lead id', r.opened.join(',') === 'L1', JSON.stringify(r.opened));
  ok('…and does NOT do a full page load of customer.html', r.href === '/pro/dashboard.html', r.href);
  const r2 = run(false);
  ok('control: with no modal function it still deep-links to customer.html',
    r2.href === '/pro/customer.html?id=L1', r2.href);
}

// ── 4. Push "Snooze 1h" ───────────────────────────────────────────────────
console.log('\nPUSH ACTIONS — snooze goes through LeadSnooze.snooze');
{
  function load(win, search) {
    const timers = [];
    const swListeners = {};
    Object.assign(win, {
      location: { origin: 'https://x', pathname: '/pro/dashboard.html', search: search || '', hash: '', assign() {} },
      history: { replaceState() {} },
      addEventListener() {},
      showToast() {},
    });
    const ctx = {
      window: win,
      navigator: { serviceWorker: { addEventListener: (ev, fn) => { swListeners[ev] = fn; } } },
      URL, URLSearchParams, Date, Promise,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(ctx);
    vm.runInContext(read('push-actions.js'), ctx, { filename: 'push-actions.js' });
    return { swListeners, timers };
  }

  const snoozes = [];
  const writes = [];
  const win = {
    db: {},
    LeadSnooze: { snooze: async (id, until) => { snoozes.push({ id, until }); } },
    // The fallback path — must NOT be used when LeadSnooze is there.
    _db: {}, doc: () => ({}), updateDoc: async (ref, data) => { writes.push(data); },
  };
  const { swListeners } = load(win);
  const before = Date.now();
  swListeners.message({ data: { type: 'NBD_PUSH_ACTION', action: 'snooze', leadId: 'L7' } });
  await tick(); await tick();
  ok('a worker "snooze" calls LeadSnooze.snooze for that lead', snoozes.length === 1 && snoozes[0].id === 'L7', JSON.stringify(snoozes));
  const until = snoozes[0] && snoozes[0].until;
  ok('…with a Date one hour out (LeadSnooze.snooze requires a Date)',
    Object.prototype.toString.call(until) === '[object Date]' && Math.abs(until.getTime() - before - 3600000) < 5000,
    String(until));
  ok('…and skips the bare fallback write (no snoozeCount / cache patch there)', writes.length === 0, JSON.stringify(writes));

  // The ?pushAction=snooze URL is consumed when push-actions.js loads, which
  // is BEFORE lead-snooze.js on dashboard.html. It must wait, not fall back.
  const late = { _db: {}, doc: () => ({}), updateDoc: async (ref, data) => { late._writes.push(data); }, _writes: [] };
  const lateSnoozes = [];
  const t = load(late, '?leadId=L9&pushAction=snooze');
  await tick();
  ok('URL-carried snooze waits while lead-snooze.js has not loaded yet', late._writes.length === 0 && lateSnoozes.length === 0);
  // lead-snooze.js + the Firestore bootstrap arrive.
  late.db = {};
  late.LeadSnooze = { snooze: async (id, u) => { lateSnoozes.push(id); } };
  t.timers.splice(0).forEach((fn) => fn());
  await tick(); await tick();
  ok('…then snoozes through LeadSnooze once it arrives', lateSnoozes.join(',') === 'L9', JSON.stringify(lateSnoozes));
  ok('…without the fallback write', late._writes.length === 0, JSON.stringify(late._writes));
}

// ── 2. One font system ────────────────────────────────────────────────────
console.log('\nFONTS — one grid, one key, a correct ✓');
{
  // The Settings grid functions, exactly as shipped: the slice of
  // dashboard-ui-prefs-boot.js from the font list to the boot apply.
  const prefs = read('dashboard-ui-prefs-boot.js');
  const a = prefs.indexOf('var _NBD_LEGACY_FONTS');
  const b = prefs.indexOf('window.nbdRenderFontGrid = nbdRenderFontGrid;');
  ok('located the Settings font-grid functions (positive control)', a > 0 && b > a);
  const fontSrc = prefs.slice(a, b) + '\nwindow.nbdRenderFontGrid = nbdRenderFontGrid; window.nbdApplyLegacyFont = nbdApplyLegacyFont;';

  function fontCtx(store) {
    const dom = makeDom();
    const grid = dom.el('div'); grid.id = 'settings-font-grid';
    const win = {};
    const ctx = { window: win, document: dom.document, localStorage: store, showToast() {} };
    vm.createContext(ctx);
    vm.runInContext(fontSrc, ctx, { filename: 'dashboard-ui-prefs-boot.js' });
    return { win, grid };
  }
  const checked = (html) => Array.from(html.matchAll(/>([^<>]+) ✓</g), (m) => m[1]);

  {
    const { win, grid } = fontCtx(makeStorage({ nbd_font: 'poppins' }));
    win.nbdRenderFontGrid();
    ok('the saved Settings font carries the ✓', checked(grid.innerHTML).join(',') === 'Poppins', JSON.stringify(checked(grid.innerHTML)));
  }
  {
    const { win, grid } = fontCtx(makeStorage({}));
    win.nbdRenderFontGrid();
    ok('nothing saved → the default (Barlow) carries the ✓', checked(grid.innerHTML).join(',') === 'Barlow');
  }
  {
    const { win, grid } = fontCtx(makeStorage({ 'nbd-font': 'operator' }));
    win.nbdRenderFontGrid();
    ok('a user still on a retired maps pairing is not told they are on Barlow', checked(grid.innerHTML).length === 0, JSON.stringify(checked(grid.innerHTML)));
  }
  {
    const store = makeStorage({ nbd_font: 'barlow', 'nbd-font': 'operator' });
    const { win, grid } = fontCtx(store);
    win.nbdRenderFontGrid();
    win.nbdApplyLegacyFont('inter');
    ok('picking a font moves the ✓ to it (and only it)', checked(grid.innerHTML).join(',') === 'Inter', JSON.stringify(checked(grid.innerHTML)));
    ok('the pick is saved under nbd_font', store.getItem('nbd_font') === 'inter');
    ok('the pick retires the old maps key so it cannot override on reload', store.getItem('nbd-font') === null);
  }

  // ui.js: the Appearance tab draws the grid ONCE, via nbdRenderFontGrid,
  // and nothing redraws it with maps.js's pairings afterwards.
  {
    const ui = read('ui.js');
    const s = ui.indexOf('function switchSettingsTab(tab) {');
    const e = ui.indexOf('\n}', s);
    ok('located switchSettingsTab (positive control)', s > 0 && e > s);
    const dom = makeDom();
    const grid = dom.el('div'); grid.id = 'settings-font-grid';
    const panel = dom.el('div'); panel.id = 'stab-panel-appearance';
    let renders = 0;
    const win = { nbdRenderFontGrid: () => { renders++; grid.innerHTML = 'LEGACY-28'; } };
    const ctx = {
      window: win, document: dom.document,
      // What the old code consulted: maps.js's global const, visible to ui.js.
      NBD_FONTS: [{ id: 'nbd-default', name: 'NBD Default', css: { fd: 'x', fb: 'y' }, preview: { b: 'z' } }],
      nbdApplyFont() {},
    };
    vm.createContext(ctx);
    vm.runInContext(ui.slice(s, e + 2), ctx, { filename: 'ui.js' });
    ctx.switchSettingsTab('appearance');
    ok('Appearance draws the font grid exactly once', renders === 1, 'renders=' + renders);
    ok('…and the 28-font grid is what stays on screen (no maps.js redraw)',
      grid.innerHTML === 'LEGACY-28' && grid.children.length === 0,
      'innerHTML=' + JSON.stringify(grid.innerHTML) + ' children=' + grid.children.length);
  }

  // maps.js boot: a set nbd_font wins; 'nbd-font' is only a fallback.
  {
    const maps = read('maps.js');
    const s = maps.indexOf("var mapsFont = localStorage.getItem('nbd-font');");
    const open = maps.lastIndexOf('(function(){', s);
    const close = maps.indexOf('})();', s);
    ok('located the maps.js font boot (positive control)', s > 0 && open > 0 && close > s);
    const boot = maps.slice(open, close + 5);
    function bootWith(init) {
      const applied = [];
      const ctx = { localStorage: makeStorage(init), nbdApplyFont: (id) => applied.push(id) };
      vm.createContext(ctx);
      vm.runInContext(boot, ctx, { filename: 'maps.js' });
      return applied.join(',');
    }
    ok('a Settings pick (nbd_font) is never overridden by a stale nbd-font',
      bootWith({ nbd_font: 'poppins', 'nbd-font': 'operator' }) === '', bootWith({ nbd_font: 'poppins', 'nbd-font': 'operator' }));
    ok('…including an explicit Barlow pick', bootWith({ nbd_font: 'barlow', 'nbd-font': 'operator' }) === '');
    ok('control: a user who never used the Settings grid keeps their pairing', bootWith({ 'nbd-font': 'operator' }) === 'operator');
    ok('control: nothing saved → the default pairing', bootWith({}) === 'nbd-default');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
