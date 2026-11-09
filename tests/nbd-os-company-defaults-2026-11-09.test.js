/**
 * tests/nbd-os-company-defaults-2026-11-09.test.js - NBD OS P1 "Company home"
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md, sections 3.5 and 8 P1).
 *
 * The company's published home lives beside the Bento default board in
 * companies/{companyId}/settings/layout:
 *   defaultWidgets['os-phone'], defaultWidgets['os-desk']   arrays of { id, s, cfg? }, <= 24 each
 *   homeLocked                                             true = members see the company home
 *
 *   1. normalizeCompany / cleanDefaultWidgets (the read path): keeps both arrays,
 *      drops a malformed or oversized one, keeps Bento's opaque tiles as before,
 *      and reads homeLocked as a strict boolean
 *   2. LayoutEngine.saveCompany (the existing company-settings write path, a full
 *      replace): writes homeLocked and the two arrays, keeps what it did not patch,
 *      and omits homeLocked when it is off (the doc stays the shape it was)
 *   3. a hydrate that brings new company settings tells the open layout (one event)
 *   4. firestore.rules layoutDocOk: homeLocked in hasOnly, the two arrays bounded
 *      (the emulator suite firestore-rules.os-company-home.test.js runs them for real)
 *
 * Run: node tests/nbd-os-company-defaults-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/layout-system.js'), 'utf8').replace(/\r\n/g, '\n');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n');
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const clone = (v) => JSON.parse(J(v));

const PHONE = [{ id: 'glance', s: 'm' }, { id: 'daily', s: 'm', cfg: { show: 'business' } }, { id: 'shortcuts', s: 's' }];
const DESK = [{ id: 'upnext', s: 'l' }, { id: 'coach', s: 'm' }];
const BENTO = [{ widgetId: 'revenue', x: 0, y: 0, w: 1, h: 1 }];

console.log('\n1. the read path keeps the company home arrays and the lock');
{
  const c = R.normalizeCompany({ defaultWidgets: { 'os-phone': PHONE, 'os-desk': DESK, bento: BENTO }, homeLocked: true });
  ok('os-phone is kept as published', J(c.defaultWidgets['os-phone']) === J(PHONE), J(c.defaultWidgets));
  ok('os-desk is kept as published', J(c.defaultWidgets['os-desk']) === J(DESK));
  ok('the Bento board next to them is untouched', J(c.defaultWidgets.bento) === J(BENTO));
  ok('homeLocked true reads as true', c.homeLocked === true);
  ok('homeLocked is OFF by default (absent)', R.normalizeCompany({}).homeLocked === false);
  ok('homeLocked must be the boolean true ("yes" / 1 are off)', R.normalizeCompany({ homeLocked: 'yes' }).homeLocked === false
    && R.normalizeCompany({ homeLocked: 1 }).homeLocked === false);
  ok('the layout lock and the home lock are separate switches',
    R.normalizeCompany({ locked: true }).homeLocked === false && R.normalizeCompany({ homeLocked: true }).locked === false);
  const big = new Array(25).fill({ id: 'glance', s: 's' });
  ok('a company home over 24 items is dropped whole', !('os-phone' in R.normalizeCompany({ defaultWidgets: { 'os-phone': big } }).defaultWidgets));
  ok('24 items (the cap itself) is kept', R.normalizeCompany({ defaultWidgets: { 'os-desk': big.slice(1) } }).defaultWidgets['os-desk'].length === 24);
  ok('a company home that is not an array is dropped', !('os-desk' in R.normalizeCompany({ defaultWidgets: { 'os-desk': { id: 'glance' } } }).defaultWidgets));
  ok('an item with no widget id drops the surface', !('os-phone' in R.normalizeCompany({ defaultWidgets: { 'os-phone': [{ s: 'm' }] } }).defaultWidgets));
  ok('an item with an unknown size drops the surface', !('os-phone' in R.normalizeCompany({ defaultWidgets: { 'os-phone': [{ id: 'glance', s: 'xl' }] } }).defaultWidgets));
  ok('an item that is a string drops the surface', !('os-desk' in R.normalizeCompany({ defaultWidgets: { 'os-desk': ['glance'] } }).defaultWidgets));
  ok('a bad os-phone does not take the good os-desk with it',
    J(R.normalizeCompany({ defaultWidgets: { 'os-phone': [{ id: 1 }], 'os-desk': DESK } }).defaultWidgets) === J({ 'os-desk': DESK }));
  ok('an empty company home is a choice (kept as [])', J(R.normalizeCompany({ defaultWidgets: { 'os-phone': [] } }).defaultWidgets['os-phone']) === '[]');
  ok('Bento tiles are still opaque (no id/s shape asked of them)', J(R.normalizeCompany({ defaultWidgets: { bento: BENTO } }).defaultWidgets.bento) === J(BENTO));
}

// ── a tab running the real engine over a fake settings store ────────────────
function makeTab(docs, uid, claims) {
  const store = {};
  const writes = [];
  const events = [];
  const documentElement = { setAttribute() {}, getAttribute() { return null; }, removeAttribute() {} };
  const document = {
    readyState: 'complete', documentElement,
    head: { appendChild(el) { el.parentNode = { removeChild() {} }; if (el.tagName === 'link') setTimeout(() => (el._l.load || []).forEach((f) => f()), 0); if (el.tagName === 'script') setTimeout(() => el.onload && el.onload(), 0); } },
    body: { appendChild() {} },
    createElement(tag) { return { tagName: tag, _l: {}, setAttribute() {}, getAttribute() { return null; }, addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); } }; },
    getElementById() { return null; },
    addEventListener() {},
    dispatchEvent(ev) { events.push(ev.type); return true; },
  };
  const win = {
    document, innerWidth: 1280,
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    _user: { uid }, _userClaims: claims || { companyId: uid },
    db: {}, doc: (...a) => ({ path: a.slice(1).join('/') }),
    getDoc: (ref) => { const d = docs[ref.path]; return Promise.resolve({ exists: () => !!d, data: () => (d ? clone(d) : undefined), metadata: { fromCache: false } }); },
    setDoc: (ref, data, opt) => { writes.push({ path: ref.path, data: clone(data), opt }); docs[ref.path] = clone(data); return Promise.resolve(); },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    console: { log() {}, info() {}, warn() {}, error() {} },
    MutationObserver: undefined,
  };
  const ctx = vm.createContext(Object.assign({}, win, { navigator: {} }));
  ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: 'layout-system.js' });
  return { E: ctx.LayoutEngine, store, writes, events };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));

(async () => {
  console.log('\n2. saveCompany writes the company home and the lock through the existing path');
  {
    const docs = { 'companies/co1/settings/layout': { defaultLayout: 'os', locked: false, defaultByDevice: {}, defaultWidgets: { bento: BENTO } } };
    const T = makeTab(docs, 'co1');
    await tick(40);
    ok('the engine hydrated the company doc', T.E.prefs().hydrated && T.E.prefs().company.defaultLayout === 'os');
    const r = await T.E.saveCompany({ defaultWidgets: { bento: BENTO, 'os-phone': PHONE }, homeLocked: true });
    const w = T.writes[T.writes.length - 1];
    ok('it saved', r && r.saved === true, J(r));
    ok('one full-replace write to companies/{cid}/settings/layout (no merge)', w && w.path === 'companies/co1/settings/layout' && !w.opt, w && J(w));
    ok('the write carries homeLocked: true', w && w.data.homeLocked === true, w && J(w.data));
    ok('…and the phone home as published', w && J(w.data.defaultWidgets['os-phone']) === J(PHONE));
    ok('…with the Bento board kept', w && J(w.data.defaultWidgets.bento) === J(BENTO));
    ok('…and the layout default it did not patch', w && w.data.defaultLayout === 'os');
    ok('prefs() now say the home is locked', T.E.prefs().company.homeLocked === true);
    ok('the prefs cache holds the lock (a cached boot enforces it)', JSON.parse(T.store.nbd_layout_prefs).company.homeLocked === true);
    await T.E.saveCompany({ defaultWidgets: Object.assign({}, T.E.prefs().company.defaultWidgets, { 'os-desk': DESK }) });
    const w2 = T.writes[T.writes.length - 1];
    ok('a later save that does not patch the lock keeps it', w2 && w2.data.homeLocked === true, w2 && J(w2.data));
    ok('…and keeps the phone home while adding the desk one', w2 && J(w2.data.defaultWidgets['os-phone']) === J(PHONE) && J(w2.data.defaultWidgets['os-desk']) === J(DESK));
    await T.E.saveCompany({ homeLocked: false });
    const w3 = T.writes[T.writes.length - 1];
    ok('turning the lock off writes no homeLocked key (a full replace clears it)', w3 && !('homeLocked' in w3.data), w3 && J(w3.data));
    ok('…and the published homes stay', w3 && J(w3.data.defaultWidgets['os-desk']) === J(DESK));
    const t2 = makeTab({}, 'co2');
    await tick(40);
    await t2.E.saveCompany({ locked: true });
    const w4 = t2.writes[t2.writes.length - 1];
    ok('a save that never touched the home writes no homeLocked key (the old shape, unchanged)', w4 && w4.data.locked === true && !('homeLocked' in w4.data), w4 && J(w4.data));
  }

  console.log('\n3. a hydrate that brings company settings tells the open layout');
  {
    const docs = { 'companies/co3/settings/layout': { defaultWidgets: { 'os-phone': PHONE }, homeLocked: true } };
    const T = makeTab(docs, 'co3');
    await tick(40);
    ok('hydrate read the lock', T.E.prefs().company.homeLocked === true);
    ok('nbd:layout-prefs fired once settings were read', T.events.indexOf('nbd:layout-prefs') !== -1, J(T.events));
  }

  console.log('\n4. firestore.rules: who may publish, and the bounds');
  {
    const m = /function layoutDocOk\(\) \{([\s\S]*?)\n      \}/.exec(RULES);
    const body = m ? m[1] : '';
    ok('homeLocked is in the hasOnly list', /hasOnly\(\[[^\]]*'homeLocked'[^\]]*\]\)/.test(body), body.slice(0, 300));
    ok('homeLocked must be a bool', /'homeLocked' in d\)\s*\|\|\s*d\.homeLocked is bool/.test(body));
    ok('os-phone is a list of at most 24', /d\.defaultWidgets\['os-phone'\] is list && d\.defaultWidgets\['os-phone'\]\.size\(\) <= 24/.test(body));
    ok('os-desk is a list of at most 24', /d\.defaultWidgets\['os-desk'\] is list && d\.defaultWidgets\['os-desk'\]\.size\(\) <= 24/.test(body));
    const w = /match \/settings\/layout \{([\s\S]*?)\n      \}/.exec(RULES);
    ok('the write is still the solo owner or that company\'s company_admin only',
      w && /allow create, update: if isAuth\(\) && notViewer\(\) && layoutDocOk\(\)\s*&& \(ownsTenantByUid\(companyId\)\s*\|\| \(isCompanyAdmin\(\) && request\.auth\.token\.get\('companyId', ''\) == companyId\)\);/.test(w[1]), w && w[1]);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
