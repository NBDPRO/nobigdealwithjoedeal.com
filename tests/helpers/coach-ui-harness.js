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
  const mkEl = (tag) => ({
    tag, id: '', className: '', innerHTML: '', _attrs: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this._attrs[k] = v; },
    appendChild() {},
  });
  const document = {
    readyState: 'complete',
    body: { classList: { add() {}, remove() {} }, appendChild(e) { if (e.id) els[e.id] = e; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getElementById(id) { return els[id] || null; },
    createElement(tag) { return mkEl(tag); },
  };
  const toasts = [];
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
    Math, Date, JSON, Object, Array, Set, Map, String, Number, parseFloat, isFinite,
  };
  sandbox.window = sandbox;
  sandbox.todayKey = () => o.today || '2026-10-20';
  sandbox.toast = (m) => { toasts.push(String(m)); };
  sandbox.dsSettingsChanged = () => {};
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
    field(name, i, s, value) {
      fire('input', { target: { value: String(value), dataset: { coachField: name, i: String(i), s: String(s) } } });
    },
    live() { return read('nbd_ds_coach_live'); },
    saved() { return read('nbd_ds_workouts') || []; },
    settings() { return read('nbd_ds_coach'); },
    html() { return els.wcOverlay ? els.wcOverlay.innerHTML : ''; },
  };
}

module.exports = { makeHarness };
