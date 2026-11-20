/**
 * tests/map-views-hydration.test.js — team-shared map views (Customers map
 * layer, docs/pro/js/maps-customers.js) must never be written from an
 * UNHYDRATED company profile.
 *
 * The bug (fail-open audit, 2026-09-18): save and delete are read-modify-
 * writes of the WHOLE companyProfile.mapViews array, and a merge write
 * replaces arrays wholesale. The base list came from _loadCustViews(), which
 * returns [] while window._companyProfile is still the NBD defaults (the read
 * is in flight, or failed — _companyProfileLoaded then stays unset for the
 * session). An owner saving one view on a fresh device wiped every view the
 * team had saved. A delete could also splice an index computed against a
 * pre-hydration (stale cache) list, removing a DIFFERENT view once the real
 * list arrived.
 *
 * The fix, exercised through the real panel click handler (vm-load the
 * classic script with a stub map/panel, as the other vm-loaded suites do):
 *   - _custViewsReady(): await _loadCompanyProfile() when not loaded, then
 *     REQUIRE _companyProfileLoaded === true;
 *   - both handlers re-read the list AFTER that await;
 *   - delete re-confirms the selected index still names the same view;
 *   - _saveCustViews refuses on its own as a backstop.
 *
 * Zero deps. Run: node tests/map-views-hydration.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/maps-customers.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function assert(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const unhandled = [];
process.on('unhandledRejection', (r) => { unhandled.push(r); });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const names = (list) => (list || []).map((v) => v && v.name);

const A = { name: 'Hot Hail >$25k', colorBy: 'damage', filters: { stage: null, damage: ['hail'], value: null, rep: null }, valMin: 25000, valMax: 100000 };
const B = { name: 'Won jobs', colorBy: 'stage', filters: { stage: ['won'], damage: null, value: null, rep: null }, valMin: 0, valMax: 100000 };
const C = { name: 'Wind', colorBy: 'damage', filters: { stage: null, damage: ['wind'], value: null, rep: null }, valMin: 0, valMax: 100000 };
const X = { name: 'Added by another admin', colorBy: 'rep', filters: { stage: null, damage: null, value: null, rep: null }, valMin: 0, valMax: 100000 };

function loadMaps(opts) {
  opts = opts || {};
  const toasts = [], saves = [];
  const state = { loadCalls: 0, selectValue: '' };
  const listeners = {};
  const panel = {
    className: '', innerHTML: '', style: {},
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    querySelector(sel) { return sel === '[data-cust-view]' ? { value: state.selectValue } : null; },
  };
  const win = {
    nbdPrompt: () => (opts.promptName == null ? 'New view' : opts.promptName),
    _companyProfile: opts.profile || {},
    _companyProfileLoaded: opts.loaded,
    _userClaims: { role: 'company_admin', companyId: 'co1' },
    _user: { uid: 'u1' },
    _leads: [],
    _saveCompanyProfile: async (o) => {
      saves.push(clone(o));
      win._companyProfile = Object.assign({}, win._companyProfile, clone(o));
      return win._companyProfile;
    },
  };
  if (opts.loadImpl) win._loadCompanyProfile = function () { state.loadCalls++; return opts.loadImpl(win, state.loadCalls); };
  const document = {
    getElementById() { return null; },
    createElement(tag) { return tag === 'div' ? panel : { style: {} }; },
    head: { appendChild() {} },
  };
  const sandbox = {
    window: win, document, navigator: {},
    mainMap: { getContainer: () => ({ appendChild() {} }) },
    L: {},
    showToast: (m, k) => { toasts.push({ m: String(m), k }); },
    prompt: () => (opts.promptName == null ? 'New view' : opts.promptName),
    nbdPrompt: () => (opts.promptName == null ? 'New view' : opts.promptName),
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'maps-customers.js' });
  sandbox._renderCustPanel({});
  const click = async (attr) => {
    const target = { closest: (sel) => (sel === '[' + attr + ']' ? {} : null) };
    (listeners.click || []).forEach((fn) => fn({ target }));
    await flush();
  };
  return {
    win, panel, toasts, saves, state, sandbox,
    select: (v) => { state.selectValue = String(v); },
    saveView: () => click('data-cust-saveview'),
    deleteView: () => click('data-cust-delview'),
    lastToast: () => (toasts.length ? toasts[toasts.length - 1].m : ''),
  };
}

(async () => {
  console.log('MAP VIEWS — company-profile hydration gate');

  // ── 1. unhydrated + the load FAILS: save writes nothing ──
  {
    const m = loadMaps({ loaded: undefined, profile: {}, loadImpl: async () => { throw new Error('client is offline'); }, promptName: 'Hot Hail' });
    await m.saveView();
    assert('failed load: save attempted a (re)load first', m.state.loadCalls === 1);
    assert('failed load: save writes nothing (would have replaced every team view)', m.saves.length === 0);
    assert('failed load: the user is told why', /still loading/i.test(m.lastToast()));
  }

  // ── 2. unhydrated at click, load SUCCEEDS: the write is the REAL list + the new view ──
  {
    const m = loadMaps({
      loaded: undefined, profile: {}, promptName: 'Hot Hail',
      loadImpl: async (win) => { win._companyProfile = { mapViews: clone([A, B]) }; win._companyProfileLoaded = true; },
    });
    await m.saveView();
    const mv = m.saves[0] && m.saves[0].mapViews;
    assert('late hydration: exactly one write', m.saves.length === 1);
    assert('late hydration: existing team views are preserved, new view appended',
      JSON.stringify(names(mv)) === JSON.stringify([A.name, B.name, 'Hot Hail']));
    const added = mv && mv[mv.length - 1];
    assert('late hydration: the new view carries the panel snapshot', !!added && added.name === 'Hot Hail' && added.colorBy === 'stage' && added.valMax === 100000);
  }

  // ── 3. already hydrated: no reload, normal append ──
  {
    const m = loadMaps({ loaded: true, profile: { mapViews: clone([A]) }, loadImpl: async () => {}, promptName: 'Wind' });
    await m.saveView();
    assert('hydrated: no redundant _loadCompanyProfile call', m.state.loadCalls === 0);
    assert('hydrated: append written', m.saves.length === 1 && JSON.stringify(names(m.saves[0].mapViews)) === JSON.stringify([A.name, 'Wind']));
    assert('hydrated: success toast', /View saved/.test(m.lastToast()));
  }

  // ── 4. delete, panel built from a STALE cache, hydrated list is reordered/grown ──
  {
    const m = loadMaps({
      loaded: undefined, profile: { mapViews: clone([A, B, C]) },  // stale device cache
      loadImpl: async (win) => { win._companyProfile = { mapViews: clone([X, A, B, C]) }; win._companyProfileLoaded = true; },
    });
    m.select(1);                       // the user picked "Won jobs" (B) from the cached list
    await m.deleteView();
    assert('stale index: nothing is written (index 1 is now a different view)', m.saves.length === 0);
    assert('stale index: the user is told to re-select', /changed/i.test(m.lastToast()));
  }

  // ── 5. delete, same list after hydration: the picked view is removed ──
  {
    const m = loadMaps({
      loaded: undefined, profile: { mapViews: clone([A, B, C]) },
      loadImpl: async (win) => { win._companyProfile = { mapViews: clone([A, B, C]) }; win._companyProfileLoaded = true; },
    });
    m.select(1);
    await m.deleteView();
    assert('stable index: delete awaits hydration', m.state.loadCalls === 1);
    assert('stable index: exactly the picked view is removed',
      m.saves.length === 1 && JSON.stringify(names(m.saves[0].mapViews)) === JSON.stringify([A.name, C.name]));
  }

  // ── 6. delete, load fails over a stale cache: nothing is written ──
  {
    const m = loadMaps({ loaded: undefined, profile: { mapViews: clone([A, B, C]) }, loadImpl: async () => {} });
    m.select(1);
    await m.deleteView();
    assert('failed load: delete writes nothing (would drop views added since the cache)', m.saves.length === 0);
    assert('failed load: delete explains why', /still loading/i.test(m.lastToast()));
  }

  // ── 7. no loader on the page at all: fail closed ──
  {
    const m = loadMaps({ loaded: undefined, profile: {}, promptName: 'X' });
    await m.saveView();
    assert('no _loadCompanyProfile: save writes nothing', m.saves.length === 0);
  }

  // ── 8. backstop: _saveCustViews itself refuses on an unhydrated profile ──
  {
    const m = loadMaps({ loaded: undefined, profile: {} });
    const ok = await m.sandbox._saveCustViews([{ name: 'direct' }]);
    assert('backstop: direct _saveCustViews on an unhydrated profile returns false', ok === false);
    assert('backstop: and writes nothing', m.saves.length === 0);
    const h = loadMaps({ loaded: true, profile: {} });
    const ok2 = await h.sandbox._saveCustViews([{ name: 'direct' }]);
    assert('backstop: hydrated _saveCustViews still writes', ok2 === true && h.saves.length === 1);
  }

  await flush();
  assert('no unhandled promise rejections', unhandled.length === 0);

  console.log('');
  if (failed) {
    console.log('FAIL — ' + passed + ' passed, ' + failed + ' failed:');
    fails.forEach((f) => console.log('   ✗ ' + f));
    process.exit(1);
  } else {
    console.log('PASS — ' + passed + ' assertions');
  }
})().catch((e) => { console.log('FAIL — harness error: ' + (e && e.stack || e)); process.exit(1); });
