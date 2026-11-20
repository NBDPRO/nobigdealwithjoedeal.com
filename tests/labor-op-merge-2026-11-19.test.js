/**
 * tests/labor-op-merge-2026-11-19.test.js — writing ONE field of a labor-book
 * entry must not erase the others.
 *
 * catalogCosts/{companyId}.laborOps[laborId] holds { rate, hoursPerUnit, crewSize }.
 * recordLaborOp() used to write exactly the fields it was handed with an
 * updateDoc dotted path (laborOps.<id>), and a dotted-path update REPLACES the
 * whole value at that path. So NBD_LABOR.updateRate(id, rate), which passes only
 * { rate }, silently erased the hoursPerUnit and crewSize the company had entered
 * for that action, and the labor-hours book (flag laborHoursBook) would have
 * lost its numbers every time a rate was edited. The fix merges the entry with
 * what the book already holds.
 *
 * The real catalog-costs.js runs in a vm against a fake Firestore whose
 * updateDoc REPLACES the value at a dotted path, exactly like the real one.
 * Every number is FAKE (public repo).
 *
 * Run: node tests/labor-op-merge-2026-11-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'catalog-costs.js'), 'utf8');
const TENANT = 'co_test';

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; fails.push(name); console.log('  FAIL ' + name); }
}

function makeFirestore(docs, state) {
  const guard = () => { if (state.deny) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; } };
  return {
    doc: (db, col, id) => ({ __path: col + '/' + id }),
    getDoc: async (ref) => { const d = docs[ref.__path]; return { exists: () => !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : null) }; },
    setDoc: async (ref, data) => { guard(); docs[ref.__path] = Object.assign({}, docs[ref.__path] || {}, JSON.parse(JSON.stringify(data))); },
    updateDoc: async (ref, paths) => {
      guard();
      const prev = docs[ref.__path];
      if (!prev) { const e = new Error('No document to update'); e.code = 'not-found'; throw e; }
      const next = JSON.parse(JSON.stringify(prev));
      Object.keys(paths).forEach((p) => {
        const parts = p.split('.'); let cur = next;
        for (let i = 0; i < parts.length - 1; i++) { if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
        cur[parts[parts.length - 1]] = JSON.parse(JSON.stringify(paths[p]));   // REPLACE, like the real SDK
      });
      state.lastPaths = JSON.parse(JSON.stringify(paths));
      docs[ref.__path] = next;
    },
  };
}

async function boot(laborOps, o) {
  const docs = {};
  if (laborOps) docs['catalogCosts/' + TENANT] = { version: 1, laborOps: laborOps };
  const state = Object.assign({ deny: false, lastPaths: null }, o || {});
  const win = {}; win.window = win;
  const sandbox = {
    window: win, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} } },
    console: { log() {}, warn() {}, error() {}, info() {} }, Date, Math, JSON, Set, Map, Object, isFinite, setTimeout, navigator: {},
  };
  vm.createContext(sandbox);
  win._userClaims = { companyId: TENANT };
  win.db = {};
  win.__NBD_FS__ = makeFirestore(docs, state);
  vm.runInContext(SRC, sandbox, { filename: 'catalog-costs.js' });
  await win.NBDCatalogCosts.hydrate();
  return { cc: win.NBDCatalogCosts, docs, state, entry: (id) => (docs['catalogCosts/' + TENANT] || {}).laborOps && docs['catalogCosts/' + TENANT].laborOps[id] };
}

(async () => {
  console.log('1. one field at a time');
  {
    const e = await boot({ op1: { rate: 7, hoursPerUnit: 1.5, crewSize: 2 } });
    ok('setup: the book was hydrated with the entry', e.cc.laborOp('op1') && e.cc.laborOp('op1').hoursPerUnit === 1.5);
    const r = await e.cc.recordLaborOp('op1', { rate: 9 });
    ok('writing only the rate (what NBD_LABOR.updateRate does) saves', r === true);
    ok('the new rate is stored', e.entry('op1').rate === 9);
    ok('the hours per unit survive a rate edit', e.entry('op1').hoursPerUnit === 1.5);
    ok('the crew size survives a rate edit', e.entry('op1').crewSize === 2);
    ok('the local view agrees with what was written', JSON.stringify(e.cc.laborOp('op1')) === JSON.stringify({ rate: 9, hoursPerUnit: 1.5, crewSize: 2 }));

    await e.cc.recordLaborOp('op1', { hoursPerUnit: 2.25 });
    ok('writing only the hours keeps the rate and crew size', e.entry('op1').rate === 9 && e.entry('op1').hoursPerUnit === 2.25 && e.entry('op1').crewSize === 2);

    await e.cc.recordLaborOp('op1', { hoursPerUnit: 0 });
    ok('a real 0 hours is saved (not skipped, not ignored)', e.entry('op1').hoursPerUnit === 0 && e.entry('op1').rate === 9);
  }

  console.log('2. entries that do not exist yet, and other entries');
  {
    const e = await boot({ op1: { rate: 7, hoursPerUnit: 1.5, crewSize: 2 }, op2: { rate: 4 } });
    await e.cc.recordLaborOp('op3', { hoursPerUnit: 0.5 });
    ok('a brand-new entry holds just what it was given', JSON.stringify(e.entry('op3')) === JSON.stringify({ hoursPerUnit: 0.5 }));
    ok('only that entry\'s path is written', Object.keys(e.state.lastPaths).join() === 'laborOps.op3');
    ok('control: other entries are untouched', JSON.stringify(e.entry('op1')) === JSON.stringify({ rate: 7, hoursPerUnit: 1.5, crewSize: 2 }) && JSON.stringify(e.entry('op2')) === JSON.stringify({ rate: 4 }));
    ok('junk fields are still refused (negative, text, NaN)', (await e.cc.recordLaborOp('op2', { hoursPerUnit: -1 })) === false && (await e.cc.recordLaborOp('op2', { hoursPerUnit: 'x' })) === false && e.entry('op2').hoursPerUnit === undefined);
  }

  console.log('3. a rep (no write permission)');
  {
    const e = await boot({ op1: { rate: 7, hoursPerUnit: 1.5 } }, { deny: true });
    const r = await e.cc.recordLaborOp('op1', { rate: 9 });
    ok('a refused write resolves false and does not throw', r === false);
    ok('and the book is unchanged', e.entry('op1').rate === 7 && e.entry('op1').hoursPerUnit === 1.5);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
