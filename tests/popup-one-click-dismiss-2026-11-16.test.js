/**
 * tests/popup-one-click-dismiss-2026-11-16.test.js — a popup goes away on the
 * FIRST click.
 *
 * The owner's report (2026-11-16): "switch to ... mode" and other popups need
 * two clicks to dismiss; the first click only seems to move them aside. Three
 * shapes cause that, and each section below runs the real code to pin one:
 *
 *   1. dashboard-load-status-banner.js — the "Data not loaded · Retry · ? · ×"
 *      pill rebuilt its buttons (innerHTML) EVERY second. A click whose
 *      mousedown lands on one button node and mouseup on its replacement is
 *      dispatched to the common ancestor, so the × never sees it. Now one
 *      delegated listener on the pill, and the html is only written when it
 *      changes.
 *   2. ui.js closeToast — set opacity 0 + translateX(400px) and removed the toast
 *      300 ms later. .toast has no CSS transition, so nothing animated: the toast
 *      sat invisible but still in the stack (and still taking taps) for 300 ms.
 *      The storm offer ("… nearby. Switch to Storm day?") is one of these toasts.
 *      Now it is removed at once.
 *   3. layout-offer.js ("Switch to Field App?") and os/acts.js (the storm
 *      offer) remembered the answer ONLY in localStorage. When that write fails
 *      (private mode, quota) the next re-check (every 5 min / every data refresh)
 *      showed the offer again. Now the answer is also kept in memory.
 *   4. The same timer-rebuild shape elsewhere: layouts/picker.js's preview bar
 *      ("Previewing … — Ns left · Keep · Revert", every second) and
 *      setup-checklist.js's card (every 3 s for the first minute, Hide button).
 *
 * Zero deps (tests/lib fake DOM). Run: node tests/popup-one-click-dismiss-2026-11-16.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const K = require('./lib/src-kit');
const T = K.suite('POPUPS — one click dismisses; nothing rebuilds the button under the pointer');
const { ok, section } = T;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const brokenStorage = () => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} });

// ── 1. the load-status pill ───────────────────────────────────────────
section('1. load-status pill (dashboard-load-status-banner.js): built once, one delegated listener');
{
  const dom = K.makeDom();
  const clock = K.fakeClock(Date.UTC(2026, 10, 16, 15));
  const ctx = {
    document: dom.document, navigator: { onLine: true, serviceWorker: undefined }, console,
    Date: clock.Date, setTimeout: clock.setTimeout, setInterval: clock.setInterval, clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval,
    matchMedia: () => ({ matches: false }), URL, location: { href: 'https://x.test/pro/dashboard.html' }, Promise,
  };
  ctx.window = ctx;
  ctx._leadsLoaded = false;
  ctx._loadLeadsLastError = { code: 'unavailable', message: 'offline' };
  ctx.loadLeads = () => { ctx.loads = (ctx.loads || 0) + 1; return Promise.resolve(); };
  vm.createContext(ctx);
  vm.runInContext(K.read('docs/pro/js/dashboard-load-status-banner.js'), ctx);
  clock.tick(1000);
  const pill = () => dom.document.getElementById('nbd-load-status');
  const b = pill();
  ok('the pill shows for a real load error', !!b && b.style.display === 'block');
  const closeBefore = b && b.querySelector('.nbd-ls-close');
  const writes = b ? b.innerHTMLWrites : -1;
  clock.tick(5000);
  ok('five 1-second ticks with nothing changed write its html no more times', b && b.innerHTMLWrites === writes, 'innerHTML writes: ' + (b && b.innerHTMLWrites) + ' (was ' + writes + ')');
  ok('the × under the pointer is the same node a second later (the click is not lost)', !!closeBefore && b.querySelector('.nbd-ls-close') === closeBefore);
  ok('…and the pill itself is the stable node that carries the click listener', !!b && (b.listeners.click || []).length === 1, JSON.stringify(Object.keys((b && b.listeners) || {})));

  // the controls still work through the one listener
  K.click(dom, b.querySelector('.nbd-ls-details-toggle'));
  ok('? opens the details (Hard reset / Test fetch)', /Hard reset/.test(b.innerHTML));
  K.click(dom, b.querySelector('.nbd-ls-retry'));
  ok('Retry calls loadLeads once and shows "Retrying…"', ctx.loads === 1 && /Retrying/.test(b.querySelector('.nbd-ls-retry').textContent));
  clock.tick(1000);
  ok('…and the next tick gives the rep the Retry button back (as before)', /^Retry$/.test(b.querySelector('.nbd-ls-retry').textContent) && b.querySelector('.nbd-ls-retry').disabled !== true);
  K.click(dom, b.querySelector('.nbd-ls-close'));
  clock.tick(300);
  ok('one click on × removes the pill', !pill());
  clock.tick(5000);
  ok('…and it stays gone', !pill());

  const src = K.stripJsComments(K.read('docs/pro/js/dashboard-load-status-banner.js'));
  ok('no per-render addEventListener on the rebuilt buttons', !/querySelector\('\.nbd-ls-(retry|close|details-toggle)'\)[\s\S]{0,40}addEventListener/.test(src));
}

// ── 2. ui.js toasts ────────────────────────────────────────────────────
section('2. app toasts (ui.js closeToast): the × removes the toast at once');
{
  const UI = K.read('docs/pro/js/ui.js');
  const code = ['let toastIdCounter = 0;', 'const activeToasts = new Map();',
    K.sliceFn(UI, 'showToast', { unique: true }), K.sliceFn(UI, 'closeToast', { unique: true }), K.sliceFn(UI, 'toastUndo', { unique: true }),
    'this.showToast = showToast; this.closeToast = closeToast; this.toastUndo = toastUndo;'].join('\n');
  const dom = K.makeDom();
  const box = dom.document.createElement('div'); box.setAttribute('id', 'toastContainer'); dom.document.body.appendChild(box);
  const timers = [];
  const ctx = { document: dom.document, console, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const id = ctx.showToast('Hail nearby. Switch to Storm day?', 'warning');
  ok('a toast is shown', box.querySelectorAll('.toast').length === 1);
  ctx.closeToast(id);
  ok('closeToast removes it in the same tick (no 300 ms invisible-but-clickable toast)', box.querySelectorAll('.toast').length === 0 && !dom.document.getElementById(id));
  let undone = 0;
  const id2 = ctx.showToast({ message: 'Hail nearby. Switch to Storm day?', type: 'warning', undoText: 'Switch to Storm day', undoAction: () => { undone++; } });
  ctx.toastUndo(id2);
  ok('its action button runs once and the toast is gone at once', undone === 1 && !dom.document.getElementById(id2));
  ctx.closeToast(id2);
  timers.forEach((t) => t.f());
  ok('the auto-close timer firing later is a harmless no-op', undone === 1 && box.querySelectorAll('.toast').length === 0);
}

// ── 3a. layout-offer.js ────────────────────────────────────────────────
section('3a. "Switch to Field App?" (layout-offer.js): "Not now" holds even when storage is blocked');
{
  const at = (h) => new Date(2026, 10, 16, h).getTime();
  const listeners = {};
  const banner = { hidden: true, setAttribute() {}, set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; } };
  const doc = {
    hidden: false, createElement: () => banner, body: { appendChild() {} }, querySelector: () => null, getElementById: () => null,
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
  };
  const win = {
    document: doc, addEventListener: () => {},
    LayoutEngine: { current: () => ({ id: 'classic', source: 'user' }), surface: () => 'phone', prefs: () => ({ hydrated: true, company: {} }), apply: () => Promise.resolve() },
    LayoutRegistry: { get: (id) => ({ id, surfaces: ['phone', 'tablet', 'desktop'] }) },
  };
  const ctx = {
    window: win, document: doc, console, JSON, Object, Array, String, Number, Math,
    Date: class extends Date { constructor(...a) { if (!a.length) super(at(11)); else super(...a); } static now() { return at(11); } },
    localStorage: brokenStorage(), setTimeout: () => 1, setInterval: () => 1,
  };
  vm.createContext(ctx);
  vm.runInContext(K.read('docs/pro/js/layout-offer.js'), ctx);
  const click = (a) => { const t = { getAttribute: () => a }; t.closest = () => t; (listeners.click || []).forEach((f) => f({ target: t, preventDefault() {} })); };
  win.NBDLayoutOffer.check();
  ok('the offer shows', banner.hidden === false && /Switch to Field App\?/.test(banner.innerHTML));
  click('later');
  ok('one tap on "Not now" hides it', banner.hidden === true);
  win.NBDLayoutOffer.check();
  ok('the next re-check (5 min timer, theme / layout event) does NOT show it again', banner.hidden === true);
}
{
  // a fresh page on a new day, "Don't ask again", storage blocked
  const at = (h) => new Date(2026, 10, 17, h).getTime();
  let now = at(11);
  const listeners = {};
  const banner = { hidden: true, setAttribute() {}, set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; } };
  const doc = { hidden: false, createElement: () => banner, body: { appendChild() {} }, querySelector: () => null, getElementById: () => null, addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); } };
  const win = {
    document: doc, addEventListener: () => {},
    LayoutEngine: { current: () => ({ id: 'classic', source: 'user' }), surface: () => 'phone', prefs: () => ({ hydrated: true, company: {} }), apply: () => Promise.resolve() },
    LayoutRegistry: { get: (id) => ({ id, surfaces: ['phone', 'tablet', 'desktop'] }) },
  };
  const ctx = {
    window: win, document: doc, console, JSON, Object, Array, String, Number, Math,
    Date: class extends Date { constructor(...a) { if (!a.length) super(now); else super(...a); } static now() { return now; } },
    localStorage: brokenStorage(), setTimeout: () => 1, setInterval: () => 1,
  };
  vm.createContext(ctx);
  vm.runInContext(K.read('docs/pro/js/layout-offer.js'), ctx);
  const click = (a) => { const t = { getAttribute: () => a }; t.closest = () => t; (listeners.click || []).forEach((f) => f({ target: t, preventDefault() {} })); };
  win.NBDLayoutOffer.check();
  click('never');
  now = at(11) + 86400000;   // the next day-period, same page
  win.NBDLayoutOffer.check();
  ok('"Don\'t ask again" holds for the rest of the session even when storage is blocked', banner.hidden === true);
}

// ── 3b. os/acts.js storm offer ─────────────────────────────────────────
section('3b. storm offer (os/acts.js): offered once per alert even when storage is blocked');
{
  const dom = K.makeDom();
  const now = Date.UTC(2026, 10, 16, 18);
  const wl = {};
  const store = { nbd_storm_alerts_cache: JSON.stringify({ ts: now - 5 * 60000, data: [{ event: 'Hail Warning' }] }) };
  const W = {
    document: dom.document, console,
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} },
    addEventListener: (t, f) => { (wl[t] = wl[t] || []).push(f); },
    removeEventListener: (t, f) => { wl[t] = (wl[t] || []).filter((x) => x !== f); },
    toasts: [],
  };
  W.window = W;
  W.showToast = (o) => { W.toasts.push(o); };
  W.NBDOSHomeLogic = require(path.join(K.ROOT, 'docs/pro/js/os/home-logic.js'));
  vm.createContext(W);
  vm.runInContext(K.read('docs/pro/js/os/acts-logic.js'), W);
  vm.runInContext(K.read('docs/pro/js/os/acts.js'), W);
  W.NBDOSActs.attach({ surface: 'phone', act: () => null, acts: () => [{ id: 'storm', name: 'Storm day' }], switchTo() {} });
  ok('a fresh storm alert offers Storm day', W.toasts.length === 1 && /Switch to Storm day/.test(W.toasts[0].undoText || ''));
  for (let i = 0; i < 3; i++) ['nbd:data-refreshed', 'online', 'nbd:os-unlock'].forEach((t) => (wl[t] || []).slice().forEach((f) => f({ type: t })));
  ok('closing it is final: data refreshes do not offer the same alert again', W.toasts.length === 1, W.toasts.length + ' toasts');
}

// ── 4a. layouts/picker.js preview bar ──────────────────────────────────
section('4a. layout preview bar (layouts/picker.js): Keep / Revert are not rebuilt by the countdown');
{
  const P = K.read('docs/pro/js/layouts/picker.js');
  const dom = K.makeDom();
  const ctx = { document: dom.document, state: { preview: 'field', left: 30 }, R: { get: () => ({ name: 'Field App' }) }, esc };
  vm.createContext(ctx);
  vm.runInContext(K.sliceFn(P, 'barEl', { unique: true }) + '\n' + K.sliceFn(P, 'showBar', { unique: true }), ctx);
  ctx.showBar();
  const bar = dom.document.getElementById('lpPreviewBar');
  const keep = bar && bar.querySelector('[data-lp="keep"]');
  ctx.state.left = 29; ctx.showBar();
  ctx.state.left = 28; ctx.showBar();
  ok('the countdown still reads the seconds left', /28s left/.test(bar.textContent), bar && bar.textContent);
  ok('Keep is the same node a second later (a tap on it is not lost)', !!keep && bar.querySelector('[data-lp="keep"]') === keep);
  ok('the bar\'s html was written once', bar.innerHTMLWrites === 1, 'writes: ' + bar.innerHTMLWrites);
  ctx.state.preview = 'mission'; ctx.R = { get: () => ({ name: 'Mission Control' }) }; ctx.state.left = 30;
  vm.runInContext('R = this.R', ctx);
  ctx.showBar();
  ok('previewing another layout repaints the name', /Mission Control/.test(bar.textContent) && /30s left/.test(bar.textContent), bar.textContent);
}

// ── 4b. setup-checklist.js card ────────────────────────────────────────
section('4b. setup checklist (setup-checklist.js): the 3-second boot ticks do not rebuild Hide');
{
  const S = K.read('docs/pro/js/setup-checklist.js');
  const dom = K.makeDom();
  const home = dom.document.createElement('div'); home.setAttribute('id', 'view-home'); dom.document.body.appendChild(home);
  const ctx = {
    document: dom.document, esc, _companyProfileLoaded: true,
    $: (id) => dom.document.getElementById(id), eligible: () => true, prefs: () => ({}),
    steps: () => [{ id: 'logo', title: 'Add your logo', why: 'It goes on every estimate.', cta: 'Add logo', action: 'logo', done: false },
      { id: 'team', title: 'Invite your team', why: 'So they can work leads.', cta: 'Invite', action: 'team', skip: 'Just me', done: false }],
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(K.sliceFn(S, 'render', { unique: true }), ctx);
  ctx.render();
  const card = dom.document.getElementById('nbdSetupChecklist');
  const hide = card && card.querySelector('[data-sc-act="hide"]');
  ctx.render(); ctx.render();
  ok('three renders with nothing changed write the card once', !!card && card.innerHTMLWrites === 1, 'writes: ' + (card && card.innerHTMLWrites));
  ok('Hide is the same node (a tap on it is not lost)', !!hide && card.querySelector('[data-sc-act="hide"]') === hide);
  vm.runInContext('steps = function () { return [{ id: "logo", title: "Add your logo", why: "", cta: "", action: "logo", done: true }, { id: "team", title: "Invite your team", why: "w", cta: "Invite", action: "team", done: false }]; }', ctx);
  ctx.render();
  ok('a step getting done still repaints the card', /1 of 2 done/.test(card.textContent), card.textContent);
}

T.done();
