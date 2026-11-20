#!/usr/bin/env node
/**
 * tests/visit-recorder-tab-2026-11-19.test.js — the Record visit tab in the phone's
 * bottom nav (phone sweep 2026-11-19, PR B; docs/pro/js/visit-recorder-tab.js).
 *
 * The shipped file is run against a small stub DOM with held timers. Covers:
 *   A. flag off: nothing happens (and dark-features.js fetches the file only with the flag on)
 *   B. flag on, no saved bar: the tab takes Ask Joe's slot and html gets nbd-vr-tab
 *   C. flag on, a saved bar: the rep's bar is never touched
 *   D. the nav is repainted by the customizer: the tab comes back
 *   E. the unfiled badge and the recording state
 *   F. tap opens the round button's menu over the tab; hold 0.5 s records; while recording a tap
 *      brings the recording back
 *
 * Run: node tests/visit-recorder-tab-2026-11-19.test.js
 */
const K = require('./lib/src-kit');
const SRC = K.read('docs/pro/js/visit-recorder-tab.js');

let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failed++; }

// ── a stub DOM, just enough for the module ─────────────────────────────
function El(tag) {
  const e = this;
  e.tagName = tag.toUpperCase(); e.id = ''; e.style = {}; e.children = []; e.parentNode = null;
  e.attrs = {}; e.textContent = ''; e.hidden = false; e.listeners = {}; e.clicks = 0;
  let set = new Set();
  Object.defineProperty(e, 'className', { get: () => [...set].join(' '), set: (v) => { set = new Set(String(v).split(/\s+/).filter(Boolean)); } });
  e.classList = {
    add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
    toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
  };
  e.setAttribute = (k, v) => { e.attrs[k] = String(v); };
  e.getAttribute = (k) => (k in e.attrs ? e.attrs[k] : null);
  e.appendChild = (c) => { c.parentNode = e; e.children.push(c); return c; };
  e.replaceChild = (n, o) => { const i = e.children.indexOf(o); n.parentNode = e; e.children[i] = n; o.parentNode = null; return o; };
  e.querySelector = (sel) => { const m = /^\.([\w-]+)$/.exec(sel); return m ? (function find(x) { for (const c of x.children) { if (c.classList.contains(m[1])) return c; const f = find(c); if (f) return f; } return null; })(e) : null; };
  e.closest = (sel) => { for (let x = e; x; x = x.parentNode) if (sel === '#' + x.id) return x; return null; };
  e.getBoundingClientRect = () => ({ left: 220, width: 60 });
  e.click = () => { e.clicks++; };
}
function world(o) {
  o = o || {};
  const byId = {};
  const doc = {
    documentElement: new El('html'), listeners: {},
    getElementById: (id) => { const find = (x) => { if (x.id === id) return x; for (const c of x.children) { const r = find(c); if (r) return r; } return null; }; return [byId['mobile-nav'], byId['nbd-vr-fab']].map(find).find(Boolean) || null; },
    createElement: (t) => new El(t),
    addEventListener: (t, f) => { (doc.listeners[t] = doc.listeners[t] || []).push(f); },
  };
  const reg = (e, id) => { e.id = id; byId[id] = e; return e; };
  const nav = reg(new El('div'), 'mobile-nav');
  const home = reg(new El('div'), 'mni-home'), joe = reg(new El('div'), 'mni-joe');
  nav.appendChild(home); nav.appendChild(joe);
  const bar = reg(new El('div'), 'nbd-vr-fab');
  const btn = new El('button'); btn.className = 'nbd-vr-fabbtn'; bar.appendChild(btn);
  const timers = []; let now = 1000000;
  const store = Object.assign({}, o.store || {});
  const begun = [];
  const state = { active: !!o.recording };
  const subs = [];
  const win = {
    NBDFlags: o.flagsUndefined ? undefined : { enabled: (n) => n === 'recordVisitTab' && o.flag !== false },
    NBDVisitRecorderLauncher: { begin: (x) => begun.push(x) },
    NBDVisitRecorder: { getState: () => state, subscribe: (f) => subs.push(f) },
    localStorage: { getItem: (k) => (k in store ? store[k] : null) },
    addEventListener: (t, f) => { (win.listeners[t] = win.listeners[t] || []).push(f); }, listeners: {},
  };
  const observers = [];
  function MO(cb) { observers.push(cb); this.observe = () => {}; }
  const api = { doc, win, nav, bar, btn, joe, begun, state, subs, store, observers, timers };
  new Function('window', 'document', 'navigator', 'MutationObserver', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', SRC)(
    win, doc, {}, MO,
    (f, ms) => { timers.push({ f, ms, at: now + ms }); return timers.length; }, () => {}, () => 0, () => {}, { now: () => now });
  api.advance = (ms) => { now += ms; timers.filter((t) => t.at <= now && !t.done).forEach((t) => { t.done = true; t.f(); }); };
  api.fire = (type, target, extra) => (doc.listeners[type] || []).forEach((f) => f(Object.assign({ target, button: 0, clientX: 10, clientY: 10, preventDefault() {} }, extra)));
  api.tab = () => doc.getElementById('mni-record');
  return api;
}

// ── A. flag off ─────────────────────────────────────────────────────────
{
  const w = world({ flag: false });
  check('A: flag off: Ask Joe stays, no tab, no listeners, no html class', !w.tab() && w.nav.children[1] === w.joe && !w.doc.documentElement.classList.contains('nbd-vr-tab') && !Object.keys(w.doc.listeners).length);
  const dark = K.read('docs/pro/js/dark-features.js');
  check('A: dark-features.js fetches the file only for the recordVisitTab flag', /recordVisitTab:\s*'recordvisittab'/.test(dark) && /recordvisittab:\s*\['js\/visit-recorder-tab\.js/.test(dark));
}

// ── B. flag on, no saved bar ───────────────────────────────────────────
const b = world({});
check('B: the tab replaces Ask Joe in the same slot', b.tab() && b.nav.children[1] === b.tab() && !b.doc.getElementById('mni-joe') || b.nav.children[1] === b.tab());
check('B: html carries nbd-vr-tab so the round button is drawn away', b.doc.documentElement.classList.contains('nbd-vr-tab'));
check('B: the tab is a labelled menu button with a badge slot', b.tab().attrs.role === 'button' && b.tab().attrs['aria-haspopup'] === 'menu' && !!b.doc.getElementById('mni-record-badge'));

// ── C. a saved bar is never touched ────────────────────────────────────
{
  const c = world({ store: { nbd_mobile_tabs: '["dash","crm","create","joe"]' } });
  check('C: a rep with a saved bar keeps Ask Joe, gets no tab and keeps the round button', !c.tab() && c.nav.children[1] === c.joe && !c.doc.documentElement.classList.contains('nbd-vr-tab'));
}

// ── D. the customizer repaints the bar ─────────────────────────────────
{
  const d = world({});
  const fresh = new El('div'); fresh.id = 'mni-joe';
  d.nav.children = [d.nav.children[0]]; d.nav.appendChild(fresh);
  d.observers.forEach((cb) => cb());
  check('D: after the bar is repainted, the tab is put back', d.nav.children.some((c) => c.id === 'mni-record'));
}

// ── E. badge and recording state ───────────────────────────────────────
{
  const e = world({ store: { nbd_vr_unfiled: '3' } });
  const badge = e.doc.getElementById('mni-record-badge');
  check('E: the unfiled count shows on the tab', badge.textContent === 3 && badge.style.display === '' && /3 unfiled/.test(e.tab().attrs['aria-label']));
  e.state.active = true; e.subs.forEach((f) => f('state'));
  check('E: a recording turns the tab red and says so', e.tab().classList.contains('is-recording') && e.tab().attrs['aria-label'] === 'Recording a visit');
}

// ── F. tap, hold, tap while recording ──────────────────────────────────
{
  const t = world({});
  t.fire('click', t.tab());
  check('F: a tap opens the menu over the tab (the round button\'s own menu, anchored at the tab\'s centre)', t.btn.clicks === 1 && t.bar.style.left === '222px' && !t.begun.length);
  const h = world({});
  h.fire('pointerdown', h.tab()); h.advance(500);
  check('F: held 0.5 s the tab arms', h.tab().classList.contains('is-armed'));
  h.fire('pointerup', h.tab()); h.fire('click', h.tab());
  check('F: letting go records straight away (no menu), and the click that follows is swallowed', h.begun.length === 1 && h.begun[0].source === 'fab' && h.btn.clicks === 0 && !h.tab().classList.contains('is-armed'));
  const s = world({});
  s.fire('pointerdown', s.tab()); s.advance(200); s.fire('pointerup', s.tab()); s.fire('click', s.tab());
  check('F: a short press is a tap, not a recording', s.begun.length === 0 && s.btn.clicks === 1);
  const r = world({ recording: true });
  r.fire('click', r.tab());
  check('F: while a visit is recording a tap brings the recording back instead of the menu', r.begun.length === 1 && r.btn.clicks === 0);
}

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
