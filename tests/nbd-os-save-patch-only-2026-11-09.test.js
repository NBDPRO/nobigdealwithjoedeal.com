/**
 * tests/nbd-os-save-patch-only-2026-11-09.test.js - NBD OS P0b step 1
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md, sections 3.5 and 8).
 *
 * LayoutEngine.saveUser used to re-send the WHOLE cached layoutState map on
 * every save (setDoc merge:true). hydrate() is a one-shot read with no
 * listener, so a tab (or a device) holding a stale cache overwrote a newer key
 * another tab had written: tab B saves os-home, tab A then saves its OS
 * windows and puts its old os-home back. Now a save sends only the
 * layoutState keys that call patched; the local cache still merges the patch
 * in, and the 12,000-char per-key budget still applies.
 *
 * Runs the REAL layout-system.js (registry + engine) twice, as two tabs, over
 * one fake userSettings doc that merges the way Firestore's setDoc merge:true
 * does (maps merge field by field, arrays and scalars replace, an empty map
 * replaces). firestore.rules userSettings/{uid} only bounds mySkin.themes, so
 * a patch-only merge write passes the same rule a whole-map write did.
 *
 * Run: node tests/nbd-os-save-patch-only-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/layout-system.js'), 'utf8').replace(/\r\n/g, '\n');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(J(v));

// ── a userSettings doc store with setDoc merge:true semantics ───────────────
function isMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function mergeInto(target, patch) {
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    if (isMap(v) && Object.keys(v).length) {
      if (!isMap(target[k])) target[k] = {};
      mergeInto(target[k], v);
    } else {
      target[k] = clone(v);   // arrays, scalars, null and an EMPTY map replace
    }
  });
}
function makeServer(initial) {
  const docs = clone(initial || {});
  const writes = [];
  return {
    docs, writes,
    get(p) { return docs[p] ? clone(docs[p]) : null; },
    set(p, data, opt) {
      writes.push({ path: p, data: clone(data), opt });
      if (opt && opt.merge && docs[p]) mergeInto(docs[p], data);
      else docs[p] = clone(data);
    },
  };
}

// ── one browser tab running the real engine ─────────────────────────────────
function makeTab(server, uid) {
  const store = {};
  const listeners = {};
  const documentElement = { setAttribute() {}, getAttribute() { return null; }, removeAttribute() {} };
  const document = {
    readyState: 'complete', documentElement,
    head: { appendChild(el) { el.parentNode = { removeChild() {} }; if (el.tagName === 'link') setTimeout(() => (el._l.load || []).forEach((f) => f()), 0); if (el.tagName === 'script') setTimeout(() => el.onload && el.onload(), 0); } },
    body: { appendChild() {} },
    createElement(tag) { return { tagName: tag, _l: {}, setAttribute() {}, getAttribute() { return null; }, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } }; },
    getElementById() { return null; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent() { return true; },
  };
  const win = {
    document, innerWidth: 1280,
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    _user: { uid }, _userClaims: { companyId: uid },
    db: {}, doc: (...a) => ({ path: a.slice(1).join('/') }),
    getDoc: (ref) => { const d = server.get(ref.path); return Promise.resolve({ exists: () => !!d, data: () => d, metadata: { fromCache: false } }); },
    setDoc: (ref, data, opt) => { server.set(ref.path, data, opt); return Promise.resolve(); },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    console: { log() {}, info() {}, warn() {}, error() {} },
    MutationObserver: undefined,
  };
  const ctx = vm.createContext(Object.assign({}, win, { navigator: {} }));
  ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: 'layout-system.js' });
  return { E: ctx.LayoutEngine, store };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));

const OS_A1 = { v: 1, wins: [{ id: 'crm', x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 1, min: false, zone: null, desk: 0 }], focus: 'crm', icons: [], dock: [], recent: [], desk: 0, pins: [] };
const OS_A2 = { v: 1, wins: [{ id: 'crm', x: 0.2, y: 0.2, w: 0.6, h: 0.6, z: 1, min: false, zone: null, desk: 1 }], focus: 'crm', icons: [], dock: [], recent: [], desk: 1, pins: ['crm'] };
const HOME_1 = { v: 1, phone: [{ id: 'glance', s: 'm' }], desk: [{ id: 'glance', s: 'm' }] };
const HOME_2 = { v: 1, phone: [{ id: 'upnext', s: 'l' }, { id: 'glance', s: 's' }], desk: [{ id: 'shortcuts', s: 's' }] };

(async () => {
  console.log('\n1. two tabs: a stale tab saving its windows keeps the other tab\'s newer os-home');
  {
    const server = makeServer({ 'userSettings/u1': { layout: { id: 'os', layoutState: { os: OS_A1, 'os-home': HOME_1, bento: [{ widgetId: 'rev' }] } } } });
    const A = makeTab(server, 'u1');
    const B = makeTab(server, 'u1');
    await tick(40);
    ok('both tabs hydrated the same settings', A.E.prefs().hydrated && B.E.prefs().hydrated
      && J(A.E.prefs().user.layoutState['os-home']) === J(HOME_1));
    await B.E.saveUser({ layoutState: { 'os-home': HOME_2 } });
    ok('tab B\'s os-home reached the doc', J(server.docs['userSettings/u1'].layout.layoutState['os-home']) === J(HOME_2));
    const before = server.writes.length;
    await A.E.saveUser({ layoutState: { os: OS_A2 } });   // tab A still caches HOME_1
    const w = server.writes[before];
    const sent = w && w.data && w.data.layout && w.data.layout.layoutState;
    ok('tab A\'s save sends only the key it changed (os), not its whole cached map',
      sent && J(Object.keys(sent)) === J(['os']), sent && J(Object.keys(sent)));
    const doc = server.docs['userSettings/u1'].layout;
    ok('tab B\'s newer os-home SURVIVES tab A\'s save', J(doc.layoutState['os-home']) === J(HOME_2), J(doc.layoutState['os-home']));
    ok('tab A\'s windows were written', J(doc.layoutState.os) === J(OS_A2));
    ok('a key neither tab touched (bento) is left as it was', J(doc.layoutState.bento) === J([{ widgetId: 'rev' }]));
    ok('the write is still a MERGE into userSettings/{uid}.layout', w && w.path === 'userSettings/u1' && w.opt && w.opt.merge === true);
    ok('tab A\'s own cache merged the patch in (its other keys kept)', J(A.E.prefs().user.layoutState.os) === J(OS_A2)
      && J(A.E.prefs().user.layoutState.bento) === J([{ widgetId: 'rev' }]));
    const cached = JSON.parse(A.store.nbd_layout_prefs);
    ok('the prefs cache holds the merged map', J(cached.user.layoutState.os) === J(OS_A2) && !!cached.user.layoutState.bento);
  }

  console.log('\n2. a save with no layoutState patch sends no layoutState at all');
  {
    const server = makeServer({ 'userSettings/u2': { layout: { id: 'os', layoutState: { os: OS_A1, 'os-home': HOME_1 } } } });
    const A = makeTab(server, 'u2');
    await tick(40);
    const before = server.writes.length;
    await A.E.saveUser({ glove: true });
    const w = server.writes[before];
    ok('a glove-only save writes the glove', w && w.data.layout.glove === true);
    ok('…and no layoutState field (an empty map would REPLACE the stored one)', w && !('layoutState' in w.data.layout), w && J(w.data.layout));
    ok('the stored layoutState is untouched', J(server.docs['userSettings/u2'].layout.layoutState['os-home']) === J(HOME_1)
      && J(server.docs['userSettings/u2'].layout.layoutState.os) === J(OS_A1));
    await A.E.saveUser({ id: null, device: 'phone' });
    const w2 = server.writes[server.writes.length - 1];
    ok('a cleared override is still written as null, not omitted', w2 && w2.data.layout.byDevice.phone === null && w2.data.layout.id === 'os');
  }

  console.log('\n3. the 12,000-char per-key budget still applies');
  {
    const server = makeServer({ 'userSettings/u3': { layout: { id: 'os', layoutState: { os: OS_A1, 'os-home': HOME_1 } } } });
    const A = makeTab(server, 'u3');
    await tick(40);
    const before = server.writes.length;
    const huge = { v: 1, phone: [{ id: 'x'.repeat(12100) }], desk: [] };
    await A.E.saveUser({ layoutState: { 'os-home': huge, os: OS_A2 } });
    const w = server.writes[before];
    const sent = w && w.data.layout.layoutState;
    ok('an over-budget key is not sent', sent && !('os-home' in sent), sent && J(Object.keys(sent)));
    ok('the in-budget key in the same call is sent', sent && J(sent.os) === J(OS_A2));
    ok('the stored copy of the over-budget key survives', J(server.docs['userSettings/u3'].layout.layoutState['os-home']) === J(HOME_1));
    ok('the cache keeps its in-budget copy too, matching the doc (the old code dropped it)',
      J(A.E.prefs().user.layoutState['os-home']) === J(HOME_1), J(A.E.prefs().user.layoutState['os-home']));
  }

  console.log('\n4. the rule a patch-only write has to satisfy');
  {
    const m = /match \/userSettings\/\{uid\} \{([\s\S]*?)\n    \}/.exec(RULES);
    const body = m ? m[1] : '';
    ok('userSettings/{uid} write rule is owner/admin + mySkinThemesBounded only (no layout shape constraint to break)',
      /allow create, update: if \(isOwner\(uid\) \|\| isAdmin\(\)\) && mySkinThemesBounded\(request\.resource\.data\);/.test(body)
      && !/layout/.test(body), body);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
