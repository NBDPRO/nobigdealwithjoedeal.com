/**
 * tests/job-templates-late-refresh-2026-10-06.test.js
 *
 * The one-time cloud pull (JobTemplates.hydrateFromCloud, job-templates.js)
 * finishes ~0.5-0.7 s after the estimates bundle loads. It used to call
 * JobTemplatesUI.reRender() unconditionally, which rebuilt #jtModalBody and
 * reset its scrollTop to 0, so a rep who had already tapped Use and
 * scrolled the Configure screen got thrown back to the top (diagnosed in
 * #2272, which deflaked the e2e around it).
 *
 * Contract pinned here, on the real engine + real job-templates-ui.js in a
 * fake DOM:
 *   1. a pull that changes nothing never repaints the open picker;
 *   2. a pull that DOES change a template still updates the data, but leaves
 *      an open Configure screen (body + scroll) alone;
 *   3. an open library repaints with the new data and keeps its scroll;
 *   4. a plain reRender() (a rep action) still repaints Configure as before.
 *
 * Run: node tests/job-templates-late-refresh-2026-10-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; fails.push(name); console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : '')); }
}
function section(name) { console.log('\n' + name); }

// Harness copied from tests/job-template-honest-paperwork.test.js (section 9).
const DOM_IDS = ['jtModal', 'jtModalBody', 'jtModalFoot', 'jtStepLbl', 'jtUIStyles', 'jtEditModal',
  'jtEstName', 'jtLeadSel', 'jtRunTotal', 'jtEditCard'];
function makeSandbox(extraWin) {
  const byId = {};
  const listeners = {};
  function el(tag) {
    const classes = new Set();
    const e = {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null,
      classList: {
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
    return e;
  }
  const document = {
    head: el('head'), body: el('body'),
    createElement: el,
    getElementById(id) {
      if (byId[id]) return byId[id];
      if (DOM_IDS.indexOf(id) === -1) return null;
      const e = el('div'); e.id = id; byId[id] = e; return e;
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  };
  const win = Object.assign({ localStorage, document }, extraWin || {});
  win.window = win;
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' },
  };
  vm.createContext(sandbox);
  return { win, sandbox, byId, listeners };
}
function load(env, rel) {
  vm.runInContext(read(path.join(ROOT, rel)), env.sandbox, { filename: path.basename(rel) });
}

const ENGINE_FILES = [
  'docs/pro/js/estimate-config.js',
  'docs/pro/js/product-data.js',
  'docs/pro/js/roofivent-catalog.js',
  'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js',
  'docs/pro/js/estimate-catalog-xactimate.js',
  'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js',
  'docs/pro/js/job-templates.js',
  'docs/pro/js/customer-estimate-rows.js',
];
function engineStack(book) {
  const env = makeSandbox(book ? { NBDCatalogCosts: book } : null);
  ENGINE_FILES.forEach((f) => load(env, f));
  return env;
}

(async function () {
  const env = engineStack(null);
  load(env, 'docs/pro/js/job-templates-ui.js');
  const w = env.win;
  const JT = w.JobTemplates;
  const UI = w.JobTemplatesUI;
  if (!JT || !UI || typeof JT.hydrateFromCloud !== 'function') {
    console.log('FATAL: engine/UI did not load'); process.exit(1);
  }
  const click = (action, id) => env.listeners.click.forEach((fn) => fn({
    target: { closest: () => ({ tagName: 'BUTTON', dataset: { jtAction: action, id: id } }) },
  }));
  const bodyEl = () => env.byId.jtModalBody;

  // A custom template this device already holds, and a cloud that echoes it.
  const T0 = new Date(Date.now() - 60000).toISOString();
  const custom = { id: 'jt_custom_late_a', name: 'Late A (local)', custom: true, updatedAt: T0, items: [] };
  w.localStorage.setItem(JT.STORAGE_KEY, JSON.stringify({ _v: 1, items: [custom] }));
  let cloud = [JSON.parse(JSON.stringify(custom))];
  w._db = { fake: true };
  w._user = { uid: 'test-uid' };
  w.doc = function () { return {}; };
  w.collection = function () { return {}; };
  w.getDocs = function () {
    const docs = cloud.map((t) => ({ id: t.id, data: () => JSON.parse(JSON.stringify(t)) }));
    return Promise.resolve({ forEach: (cb) => docs.forEach(cb) });
  };
  w.writeBatch = function () { return { set() {}, commit() { return Promise.resolve(); } }; };
  w.setDoc = function () { return Promise.resolve(); };

  const SCROLLED = 420;
  const openConfigure = () => {
    UI.openPicker({});
    click('quick-use', 'jt_gr_hanger_resecure');
    const b = bodyEl();
    b.innerHTML += '<!--rep-was-here-->';
    b.scrollTop = SCROLLED;
    return b;
  };

  section('1. unchanged pull: the open Configure screen is not rebuilt');
  {
    const b = openConfigure();
    ok('Configure screen rendered', /jt-topctl/.test(b.innerHTML));
    const r = await JT.hydrateFromCloud();
    ok('hydrateFromCloud ran (resolved true)', r === true);
    ok('body was not rebuilt', b.innerHTML.indexOf('<!--rep-was-here-->') !== -1);
    ok('scroll position kept', b.scrollTop === SCROLLED, 'scrollTop=' + b.scrollTop);
  }

  section('2. changed pull while on Configure: data updates, screen left alone');
  {
    const b = openConfigure();
    cloud = [Object.assign({}, custom, { name: 'Late A (from phone)', updatedAt: new Date().toISOString() })];
    const r = await JT.hydrateFromCloud();
    ok('hydrateFromCloud ran (resolved true)', r === true);
    ok('engine now holds the newer cloud template', (JT.get('jt_custom_late_a') || {}).name === 'Late A (from phone)');
    ok('body was not rebuilt', b.innerHTML.indexOf('<!--rep-was-here-->') !== -1);
    ok('scroll position kept', b.scrollTop === SCROLLED, 'scrollTop=' + b.scrollTop);
  }

  section('3. changed pull while on the library: repaints with new data, keeps scroll');
  {
    click('clear-selection'); click('close-modal');
    UI.openPicker({});
    const b = bodyEl();
    b.scrollTop = 300;
    cloud = [Object.assign({}, custom, { name: 'Late A (renamed again)', updatedAt: new Date(Date.now() + 1000).toISOString() })];
    await JT.hydrateFromCloud();
    ok('library repainted with the new name', b.innerHTML.indexOf('Late A (renamed again)') !== -1);
    ok('library scroll position kept', b.scrollTop === 300, 'scrollTop=' + b.scrollTop);
  }

  section('4. a plain reRender() (rep action) still repaints Configure');
  {
    click('clear-selection'); click('close-modal');
    const b = openConfigure();
    UI.reRender();
    ok('body rebuilt', b.innerHTML.indexOf('<!--rep-was-here-->') === -1 && /jt-topctl/.test(b.innerHTML));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
