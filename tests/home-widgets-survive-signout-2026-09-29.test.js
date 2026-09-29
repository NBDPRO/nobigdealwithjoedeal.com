/**
 * tests/home-widgets-survive-signout-2026-09-29.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * The Home layout (`nbd_home_widgets`) and the Task Checklist widget's items
 * (`nbd_home_tasks`, a DEFAULT widget) lived only in localStorage, and
 * NBDAuth.purgeAccountStorage() deletes every `nbd_` key on every sign-out:
 * a rep's arranged Home and checklist reset at each logout and never reached
 * their phone. widgets.js now keeps both on userSettings/{uid} (owner
 * read/write already), with localStorage as the device cache:
 *   - a fresh device (what a sign-out leaves) gets both back;
 *   - the first load with no cloud copy lifts this device's copy up once;
 *   - a failed read uploads nothing;
 *   - saving the layout or a task writes the cloud copy.
 * Same sweep, same file: the Storm Alerts widget queried area=OH for every
 * tenant and put NWS text into innerHTML unescaped; it now reads Storm
 * Center's localized cache and escapes.
 *
 * Loads the real docs/pro/js/widgets.js in a vm with a Firestore stub.
 * Run: node tests/home-widgets-survive-signout-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'widgets.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 8; i++) await tick(); }

function makeEl() {
  return { _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = String(v); }, style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, remove() {} };
}

function boot(o) {
  const cfg = o || {};
  const store = new Map(Object.entries(cfg.storage || {}));
  const docs = cfg.docs || {};
  const writes = [];
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || makeEl()), createElement: makeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: makeEl(), head: makeEl() };
  const win = {
    auth: { currentUser: { uid: 'u1' } }, db: {}, _user: { uid: 'u1' },
    doc: (db, col, id) => ({ path: col + '/' + id }),
    getDoc: async (ref) => {
      if (cfg.failRead && ref.path.indexOf('userSettings/') === 0) { const e = new Error('offline'); e.code = 'unavailable'; throw e; }
      const d = docs[ref.path];
      return { exists: () => !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) };
    },
    setDoc: async (ref, data, opt) => {
      writes.push({ path: ref.path, data: JSON.parse(JSON.stringify(data)), merge: !!(opt && opt.merge) });
      docs[ref.path] = Object.assign({}, (opt && opt.merge && docs[ref.path]) || {}, JSON.parse(JSON.stringify(data)));
    },
    showToast() {}, addEventListener() {}, matchMedia: () => ({ matches: false }),
  };
  win.window = win;
  const sandbox = Object.assign({ window: win, document, localStorage, console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Promise, Array, Object, String, Number, Set, Map, isNaN, parseFloat, parseInt,
    fetch: () => Promise.reject(new Error('no network')), navigator: { userAgent: 'node' }, location: { hash: '', pathname: '/pro/dashboard' } }, win);
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'widgets.js' });
  return { sandbox, store, docs, writes, els, W: win.NBDWidgets, H: win.NBDWidgets && win.NBDWidgets._home };
}

(async () => {
  console.log('\n1. First load with no cloud copy lifts this device\'s layout + tasks up once');
  {
    const localIds = ['hot-leads', 'task-checklist', 'win-rate'];
    const localTasks = [{ t: 'ZZ_QA call the adjuster', d: false }, { t: 'ZZ_QA order shingles', d: true }];
    const docs = {};
    const b = boot({ docs, storage: { nbd_home_widgets: JSON.stringify(localIds), nbd_home_tasks: JSON.stringify(localTasks) } });
    ok('harness: the widget functions loaded', !!b.H && typeof b.H.hydrate === 'function' && typeof b.H.saveActive === 'function');
    await b.H.hydrate();
    await flush();
    const us = docs['userSettings/u1'] || {};
    ok('the layout was uploaded to userSettings', JSON.stringify(us.homeWidgets) === JSON.stringify(localIds), JSON.stringify(us.homeWidgets));
    ok('the checklist was uploaded', JSON.stringify(us.homeTasks) === JSON.stringify(localTasks), JSON.stringify(us.homeTasks));
    ok('...as a merge write (other userSettings fields survive)', b.writes.every((w) => w.merge));
    const n = b.writes.length;
    await b.H.hydrate();
    ok('it runs once', b.writes.length === n);
  }

  console.log('\n2. A fresh device (what every sign-out leaves) gets them back');
  {
    const docs = { 'userSettings/u1': { theme: 'dark', homeWidgets: ['win-rate', 'task-checklist'], homeTasks: [{ t: 'ZZ_QA call the adjuster', d: false }] } };
    const b = boot({ docs });
    await b.H.hydrate();
    await flush();
    ok('the layout lands in the device cache', b.store.get('nbd_home_widgets') === JSON.stringify(['win-rate', 'task-checklist']));
    ok('getActiveWidgets returns the account\'s layout', JSON.stringify(b.W.getActive()) === JSON.stringify(['win-rate', 'task-checklist']));
    ok('the checklist comes back', b.H.getTasks()[0].t === 'ZZ_QA call the adjuster');
    ok('nothing was uploaded over the account\'s copy', b.writes.length === 0);
  }

  console.log('\n3. Saving writes the account copy');
  {
    const docs = { 'userSettings/u1': { homeWidgets: ['win-rate'], homeTasks: [] } };
    const b = boot({ docs });
    await b.H.hydrate();
    b.H.saveActive(['hot-leads', 'win-rate']);
    await flush();
    ok('a layout save reaches userSettings', JSON.stringify(docs['userSettings/u1'].homeWidgets) === '["hot-leads","win-rate"]');
    b.H.saveTasks([{ t: 'ZZ_QA new task', d: false }]);
    await flush();
    ok('a checklist save reaches userSettings', docs['userSettings/u1'].homeTasks[0].t === 'ZZ_QA new task');
    b.H.toggleTask(0, true);
    await flush();
    ok('ticking a task reaches userSettings', docs['userSettings/u1'].homeTasks[0].d === true);
    b.H.saveActive(['not-a-widget', 'win-rate']);
    await flush();
    ok('unknown widget ids are never written to the account', JSON.stringify(docs['userSettings/u1'].homeWidgets) === '["win-rate"]');
    b.H.saveTasks([{ t: 'x'.repeat(500), d: 'yes' }]);
    await flush();
    ok('task text is capped and done is a real boolean', docs['userSettings/u1'].homeTasks[0].t.length === 200 && docs['userSettings/u1'].homeTasks[0].d === false);
  }

  console.log('\n4. A failed read uploads nothing');
  {
    const docs = {};
    const b = boot({ docs, failRead: true, storage: { nbd_home_widgets: JSON.stringify(['win-rate']) } });
    await b.H.hydrate();
    await flush();
    ok('no write after a failed read', b.writes.length === 0 && !docs['userSettings/u1']);
    ok('...and it will try again (not marked loaded)', b.H.loaded() === false);
  }

  console.log('\n5. Storm Alerts: no Ohio default, escaped text');
  {
    ok('the widget no longer queries area=OH', !/alerts\/active\?area=OH/.test(SRC));
    const b = boot({ storage: { nbd_storm_alerts_cache: JSON.stringify({ ts: Date.now(), data: [{ event: '<img src=x onerror=alert(1)>Hail', headline: 'Severe <b>storm</b>' }] }) } });
    const w = b.W.WIDGETS.find((x) => x.id === 'storm-alerts');
    const el = makeEl();
    w.render(el);
    ok('Storm Center\'s cached alert is shown', /Hail/.test(el.innerHTML));
    ok('...escaped (no raw <img> tag)', !/<img/.test(el.innerHTML) && /&lt;img/.test(el.innerHTML));
    const b2 = boot({});
    const el2 = makeEl();
    b2.W.WIDGETS.find((x) => x.id === 'storm-alerts').render(el2);
    ok('with no cache it does not claim "no alerts in your area"', !/No active alerts/.test(el2.innerHTML) && /Open Storm Center/.test(el2.innerHTML));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
