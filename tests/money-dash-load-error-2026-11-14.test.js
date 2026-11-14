/**
 * tests/money-dash-load-error-2026-11-14.test.js — a failed read on the
 * #/money dashboard must not render as $0.
 *
 * Bug (2026-11-14 review, finding 7): fetchData() swallowed each Firestore
 * read with `.catch(function () {})`, so when the invoices read failed the
 * Collected and Outstanding A/R tiles read $0 under "live snapshot" (and the
 * aging tiles $0, the queue "Nothing overdue"); a failed expenses read showed
 * Spent $0. A rep could not tell "nothing" from "couldn't load".
 *
 * Runs the real MoneyDashboard.refresh() in a vm sandbox with a fake
 * Firestore whose reads can be made to reject, and checks the rendered HTML.
 * Run: node tests/money-dash-load-error-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

// failing: set of collection names whose getDocs rejects ('userSettings' for getDoc).
function load(failing) {
  const scrollEl = { innerHTML: '' };
  const now = new Date();
  const docs = {
    invoices: [{ id: 'i1', status: 'sent', total: 900, balanceDue: 400, payments: [{ amount: 500, at: now }] }],
    expenses: [{ id: 'e1', category: 'materials', costType: 'direct', amountCents: 25000, supplier: 'ABC', date: now }],
    suppliers: [],
  };
  const snap = (name) => ({ docs: docs[name].map(d => ({ id: d.id, data: () => Object.assign({}, d) })) });
  const win = {
    addEventListener() {}, location: { pathname: '/pro/dashboard' },
    db: {}, _user: { uid: 'u1' }, _userClaims: {}, _leads: [],
    collection: (db, name) => ({ name }),
    where: () => ({}),
    query: (c) => c,
    getDocs: (qq) => failing.has(qq.name)
      ? Promise.reject(Object.assign(new Error('unavailable'), { code: 'unavailable' }))
      : Promise.resolve(snap(qq.name)),
    doc: (db, coll, id) => ({ coll, id }),
    getDoc: () => failing.has('userSettings')
      ? Promise.reject(new Error('unavailable'))
      : Promise.resolve({ data: () => ({}) }),
  };
  win.window = win;
  const doc = {
    addEventListener() {}, getElementById() { return null }, querySelectorAll() { return []; },
    querySelector: (sel) => (sel === '#view-money .view-scroll' ? scrollEl : null),
  };
  const ctx = vm.createContext({ window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Promise });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/ky-insurance-law.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/money-dashboard.js'), 'utf8'), ctx);
  return { MD: win.MoneyDashboard, scrollEl, win };
}

// The value shown on the stat-card whose label is `label` (first match).
function tileValue(html, label) {
  const i = html.indexOf('>' + label + '</div>');
  if (i < 0) return null;
  const m = html.slice(i).match(/class="stat-val"[^>]*>([^<]*)</);
  return m ? m[1] : null;
}
function tileSub(html, label) {
  const i = html.indexOf('>' + label + '</div>');
  if (i < 0) return null;
  const m = html.slice(i).match(/class="mdx-m10">([^<]*)</);
  return m ? m[1] : null;
}

(async function () {
  console.log('MONEY DASHBOARD — a failed read is not $0');

  // Baseline: everything loads.
  {
    const { MD, scrollEl } = load(new Set());
    await MD.refresh();
    const h = scrollEl.innerHTML;
    ok('all reads ok: Collected shows the real payment ($500)', tileValue(h, 'Collected') === '$500');
    ok('all reads ok: Outstanding A/R shows the real balance ($400)', tileValue(h, 'Outstanding A/R') === '$400');
    ok('all reads ok: Spent shows the real expense ($250)', tileValue(h, 'Spent') === '$250');
    ok('all reads ok: no "couldn\'t load" anywhere', !/couldn&#39;t load|couldn't load/i.test(h));
  }

  // Invoices read fails.
  {
    const { MD, scrollEl } = load(new Set(['invoices']));
    await MD.refresh();
    const h = scrollEl.innerHTML;
    ok('invoices failed: Collected is not $0', tileValue(h, 'Collected') !== '$0');
    ok('invoices failed: Collected says it couldn\'t load', /couldn/.test(tileSub(h, 'Collected') || ''));
    ok('invoices failed: Outstanding A/R is not $0', tileValue(h, 'Outstanding A/R') !== '$0');
    ok('invoices failed: Net Cash is not a number', !/\$/.test(tileValue(h, 'Net Cash') || '$'));
    ok('invoices failed: aging tiles are not $0', tileValue(h, 'Current') !== '$0' && tileValue(h, '60+ Days') !== '$0');
    ok('invoices failed: the queue does not claim "Nothing overdue"', h.indexOf('Nothing overdue') < 0);
    ok('invoices failed: Spent still shows the real expense ($250)', tileValue(h, 'Spent') === '$250');
    ok('invoices failed: a page-level notice says figures could not load', /Some figures couldn/.test(h));
    ok('invoices failed: month-close cannot be marked closed on partial data', h.indexOf('MoneyDashboard.markMonthClosed') < 0);
  }

  // Expenses read fails.
  {
    const { MD, scrollEl } = load(new Set(['expenses']));
    await MD.refresh();
    const h = scrollEl.innerHTML;
    ok('expenses failed: Spent is not $0', tileValue(h, 'Spent') !== '$0');
    ok('expenses failed: Spent says it couldn\'t load', /couldn/.test(tileSub(h, 'Spent') || ''));
    ok('expenses failed: Collected still shows the real payment ($500)', tileValue(h, 'Collected') === '$500');
    ok('expenses failed: Direct Costs / Overhead are not $0', tileValue(h, 'Direct Costs') !== '$0' && tileValue(h, 'Overhead') !== '$0');
    ok('expenses failed: Top Suppliers does not claim "No spend logged yet"', h.indexOf('No spend logged yet') < 0);
  }

  // No Firestore handle / no signed-in user yet (fetchData's early return):
  // nothing was read, so nothing may read as $0 (review round 2, 2026-11-14).
  {
    const { MD, scrollEl, win } = load(new Set());
    win.getDocs = undefined;
    await MD.refresh();
    const h = scrollEl.innerHTML;
    ok('no Firestore yet: Collected is not $0', tileValue(h, 'Collected') !== '$0', tileValue(h, 'Collected'));
    ok('no Firestore yet: Spent is not $0', tileValue(h, 'Spent') !== '$0');
    ok('no Firestore yet: the page notice shows', /Some figures couldn/.test(h));
    ok('no Firestore yet: month-close cannot be marked closed', h.indexOf('MoneyDashboard.markMonthClosed') < 0);
  }

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' money dashboard load errors: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) { console.error('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch(function (e) { console.error(e); process.exit(1); });
