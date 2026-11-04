/**
 * tests/helpers/coach-ui-harness.js — runs the REAL Workout Coach screen
 * (docs/pro/daily-success/js/workout-coach.js) on top of the REAL logic file
 * inside a vm sandbox with a tiny DOM stub, so tests can drive taps and read
 * what was saved without a browser. Not a test itself (no .test.js suffix).
 *
 *   const h = makeHarness({ storage: { nbd_ds_workouts: [...] }, today: '2026-10-20' });
 *   h.click('start');                       // data-coach-action="start"
 *   h.click('done', { i: 0, s: 1 });        // data-i / data-s
 *   h.field('weight', 0, 1, '135');         // an <input data-coach-field>
 *   h.live(); h.saved(); h.html(); h.toasts;
 *   h.key('Escape'); h.key('Tab', { shiftKey: true });   // keydown on document
 *   h.active(); h.focusables(); h.isOpen();              // focus / dialog state
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', '..', 'docs', 'pro', 'daily-success', 'js');

function makeHarness(opts) {
  const o = opts || {};
  const store = new Map();
  Object.keys(o.storage || {}).forEach((k) => store.set(k, JSON.stringify(o.storage[k])));
  const listeners = {};
  const els = {};
  let active = null;            // document.activeElement
  // Focusable stand-ins for the buttons / inputs in an element's innerHTML,
  // re-made only when that HTML changes (a re-render replaces the nodes).
  const FOCUS_RE = /<(button|input|select|textarea|a)\b([^>]*)>/g;
  const focusNodes = (owner) => {
    if (owner._fhtml !== owner.innerHTML) {
      owner._fhtml = owner.innerHTML;
      owner._fnodes = [];
      let m; FOCUS_RE.lastIndex = 0;
      while ((m = FOCUS_RE.exec(owner.innerHTML))) {
        if (/\sdisabled\b|tabindex="-1"/.test(m[2])) continue;
        const act = (/data-coach-action="([^"]*)"/.exec(m[2]) || [])[1];
        owner._fnodes.push({ tag: m[1], owner, dataset: act ? { coachAction: act } : {}, focus() { active = this; } });
      }
    }
    return owner._fnodes;
  };
  const mkEl = (tag) => {
    const cls = new Set();
    return {
      tag, id: '', className: '', innerHTML: '', _attrs: {}, tabIndex: 0,
      classList: { add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, toggle(c, on) { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      appendChild() {},
      focus() { active = this; },
      contains(n) { return n === this || (!!n && n.owner === this && focusNodes(this).includes(n)); },
      querySelectorAll() { return focusNodes(this); },
      querySelector() { return focusNodes(this)[0] || null; },
    };
  };
  const outside = [];           // focusable nodes on the page behind the overlay (h.pageButton)
  const docAttrs = {};
  const document = {
    readyState: 'complete',
    documentElement: { getAttribute: (k) => (k in docAttrs ? docAttrs[k] : null), setAttribute: (k, v) => { docAttrs[k] = String(v); } },
    body: { classList: { add() {}, remove() {}, contains: () => false }, appendChild(e) { if (e.id) els[e.id] = e; } },
    get activeElement() { return active; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return mkEl(tag); },
    contains(n) { return !!n && (outside.includes(n) && !n.gone || Object.values(els).some((e) => e.contains(n))); },
    querySelector(sel) {
      const m = /^\[data-coach-action="([^"]+)"\]$/.exec(sel);
      return m ? outside.find((n) => !n.gone && n.dataset.coachAction === m[1]) || null : null;
    },
  };
  const toasts = [];
  // opts.freeze: a fixed clock and a repeatable Math.random, so ids, seeds and the
  // rest-timer text come out identical on every run (golden comparisons).
  const NOW = 1760000000000;
  const FrozenDate = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  };
  let rnd = 12345;
  const FrozenMath = Object.create(Math);
  FrozenMath.random = () => { rnd = (Math.imul(rnd, 1103515245) + 12345) & 0x7fffffff; return rnd / 0x80000000; };
  const sandbox = {
    document,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    navigator: {},
    console,
    setInterval: () => 0, clearInterval: () => {},
    Math: o.freeze ? FrozenMath : Math, Date: o.freeze ? FrozenDate : Date, JSON, Object, Array, Set, Map, String, Number, parseFloat, isFinite,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => { (listeners['w:' + type] = listeners['w:' + type] || []).push(fn); };
  sandbox.todayKey = () => o.today || '2026-10-20';
  sandbox.toast = (m) => { toasts.push(String(m)); };
  sandbox.dsSettingsChanged = () => {};
  // The day page's Fitness section the coach card gets prepended to (opts.fitness).
  if (o.fitness) sandbox.buildFitnessSection = function () { return '<div id="fit-orig">fitness</div>'; };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'workout-coach-logic.js'), 'utf8'), sandbox, { filename: 'workout-coach-logic.js' });
  vm.runInContext(fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8'), sandbox, { filename: 'workout-coach.js' });

  const read = (k) => { const v = store.get(k); return v == null ? null : JSON.parse(v); };
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
  return {
    sandbox, toasts, store,
    click(action, data) {
      const dataset = Object.assign({ coachAction: action }, Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k === 's' ? 's' : k, String(v)])));
      fire('click', { target: { closest: () => ({ dataset }) } });
    },
    field(name, i, s, value, extra) {
      fire('input', { target: { value: String(value), dataset: Object.assign({ coachField: name, i: String(i), s: String(s) }, extra || {}) } });
    },
    // a layout switch: set data-ui on <html> and tell the page, as layout-ui.js does
    setUi(id) { docAttrs['data-ui'] = id; (listeners['w:nbd-layout'] || []).forEach((fn) => fn({})); },
    live() { return read('nbd_ds_coach_live'); },
    saved() { return read('nbd_ds_workouts') || []; },
    settings() { return read('nbd_ds_coach'); },
    html() { return els.wcOverlay ? els.wcOverlay.innerHTML : ''; },
    key(k, mods) { const ev = Object.assign({ key: k, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, mods || {}); fire('keydown', ev); return ev; },
    active: () => active,
    focusables: () => (els.wcOverlay ? focusNodes(els.wcOverlay) : []),
    isOpen: () => !!(els.wcOverlay && els.wcOverlay.classList.contains('open')),
    // A button on the page behind the overlay (the card's opener). gone() = the card was re-drawn.
    pageButton(action) { const n = { tag: 'button', dataset: { coachAction: action }, gone: false, focus() { active = this; } }; outside.push(n); return n; },
    focusOn(n) { active = n; },
    card() { return typeof sandbox.buildFitnessSection === 'function' ? sandbox.buildFitnessSection({}) : ''; },
  };
}

module.exports = { makeHarness };
