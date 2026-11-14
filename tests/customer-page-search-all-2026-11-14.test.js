/**
 * customer-page-search-all-2026-11-14.test.js — Cmd+K on a customer page finds other customers.
 *
 * Wave-1 daily-screens #4, verified: customer.html loads command-palette.js,
 * which searched window._leads, and the customer page sets that to
 * [this customer] (customer-bootstrap.module.js:229/476/579). Any other name
 * answered "No results".
 *
 * Runs the real command-palette.js in the shared fake DOM
 * (tests/lib/nbd-os-home-harness.js) on /pro/customer.html with Firestore
 * read stubs, opens it, types another customer's name, and checks:
 *   - the rep's lead book is read once, with the dashboard's scopes
 *   - the other customer is listed
 *   - the dashboard (where window._leads is the whole book) reads nothing
 * PALETTE_SRC=<file> runs it against another copy.
 *
 * Run: node tests/customer-page-search-all-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');

const SRC = fs.readFileSync(process.env.PALETTE_SRC || path.join(H.ROOT, 'docs/pro/js/command-palette.js'), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r)); };

function page(pathname, claims) {
  const dom = H.makeDom();
  // The shared fake DOM has no element.dataset; the palette's row wiring reads
  // it. A read-only view over data-* attributes is enough here.
  const proto = Object.getPrototypeOf(dom.document.createElement('div'));
  if (!Object.getOwnPropertyDescriptor(proto, 'dataset')) {
    Object.defineProperty(proto, 'dataset', { get() {
      const o = {};
      Object.keys(this.attrs || {}).forEach((k) => { if (k.startsWith('data-')) o[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[k]; });
      return o;
    } });
  }
  const reads = [];
  const book = [
    { id: 'L1', firstName: 'Ann', lastName: 'Lee', address: '1 Oak St', userId: 'u1' },
    { id: 'L2', firstName: 'Bob', lastName: 'Marsh', address: '9 Elm Ave', userId: 'u1' },
    { id: 'L3', firstName: 'Old', lastName: 'Gone', address: '3 Pine', userId: 'u1', deleted: true },
  ];
  const W = {
    document: dom.document, console: { log() {}, info() {}, warn() {}, error() {} },
    location: { pathname, hash: '', href: '' },
    setTimeout: (f) => { f(); return 0; }, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    _leads: pathname.includes('customer') ? [book[0]] : book.slice(0, 2),
    _user: { uid: 'u1' }, auth: { currentUser: { uid: 'u1' } }, _userClaims: claims || {},
    db: {}, collection: (db, n) => n, limit: (n) => ({ limit: n }),
    where: (f, op, v) => ({ f, v }), query: (c, ...parts) => ({ c, parts }),
    getDocs: async (q) => { reads.push(q.parts[0]); return { docs: book.map((b) => ({ id: b.id, data: () => Object.assign({}, b) })) }; },
    Promise, Map, Set, Array, Object, String, Date, Math, JSON, Number, Error,
  };
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: 'command-palette.js' });
  return { dom, W: ctx, reads };
}

async function search(P, q) {
  P.W.NBDCommand.open();
  await flush();
  const input = P.dom.document.getElementById('nbd-cmd-input');
  input.value = q;
  H.fire(P.dom, input, 'input');
  await flush();
  const list = P.dom.document.getElementById('nbd-cmd-results');
  return list ? H.text(list) || list.innerHTML : '';
}

(async () => {
  console.log('\ncustomer-page-search-all — the palette on a customer page searches every customer\n');

  let P = page('/pro/customer.html');
  let out = await search(P, 'marsh');
  ok('customer page: another customer is found by name', /Bob Marsh/.test(out), out);
  ok('...the lead book was read once, scoped to the rep (userId)', P.reads.length === 1 && P.reads[0].f === 'userId' && P.reads[0].v === 'u1', JSON.stringify(P.reads));
  out = await search(P, 'gone');
  ok('...a deleted lead is not offered', !/Old Gone/.test(out), out);
  out = await search(P, 'lee');
  ok('...the customer on screen is still found', /Ann Lee/.test(out), out);
  ok('...and the book is not re-read on every open', P.reads.length === 1, 'reads=' + P.reads.length);

  P = page('/pro/customer.html', { role: 'manager', companyId: 'co1' });
  await search(P, 'bob');
  ok('team reader: tenant AND own leads, like the dashboard load', P.reads.length === 2 && P.reads[0].f === 'companyId' && P.reads[1].f === 'userId', JSON.stringify(P.reads));

  P = page('/pro/dashboard.html');
  out = await search(P, 'marsh');
  ok('dashboard: searches the loaded book and reads nothing extra', /Bob Marsh/.test(out) && P.reads.length === 0, JSON.stringify(P.reads));

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
