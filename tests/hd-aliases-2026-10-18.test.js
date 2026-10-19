/**
 * tests/hd-aliases-2026-10-18.test.js
 *
 * Receipt sorter piece 2: the job-name memory (PO text → lead) moves from the
 * importing USER to the COMPANY, behind the `receiptSorterAliases` flag.
 * Drives the real hd-import.js load/save against a fake Firestore. Pins:
 *   - flag OFF: exactly the old behaviour (reads and writes userSettings only);
 *   - flag ON: reads the company doc, falls back to the user's legacy map, the
 *     company's own entries win, and the next save writes the MERGED map to
 *     companyAliases/{companyId} (the one-time migration);
 *   - a malformed entry never reaches the company doc.
 * Synthetic ids only (public repo).
 *
 * Run: node tests/hd-aliases-2026-10-18.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

function boot(flagOn, seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  const win = {
    addEventListener() {}, db: {}, _user: { uid: 'u1' }, _userClaims: { companyId: 'co1' },
    doc: (_db, col, id) => col + '/' + id,
    getDoc: async (ref) => ({ exists: () => ref in store, data: () => store[ref] }),
    setDoc: async (ref, data) => { writes.push({ ref, data }); store[ref] = Object.assign({}, store[ref] || {}, data); },
    serverTimestamp: () => 'TS',
    NBDFlags: { enabled: (n) => !!flagOn && n === 'receiptSorterAliases' },
  };
  win.window = win;
  const ctx = { window: win, document: { addEventListener() {} }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/hd-import.js'), 'utf8'), ctx);
  return { H: win.NBDHdImport, writes, store };
}

const SEED = {
  'userSettings/u1': { hdJobAliases: { lora: 'leadOld', larry: 'leadL' } },
  'companyAliases/co1': { aliases: { lora: 'leadNew', victory: 'leadV' } },
};

async function main() {
console.log('\n1. flag off = the old per-user behaviour');
{
  const { H, writes } = boot(false, SEED);
  const a = await (H.loadAliases());
  ok('flag off reads only the user map', JSON.stringify(a) === JSON.stringify({ lora: 'leadOld', larry: 'leadL' }), JSON.stringify(a));
  await (H.saveAliases({ lora: 'leadOld' }));
  ok('flag off writes userSettings and never the company doc', writes.length === 1 && writes[0].ref === 'userSettings/u1' && !writes.some((w) => /companyAliases/.test(w.ref)));
}

console.log('\n2. flag on = company memory with a legacy fallback');
{
  const { H, writes } = boot(true, SEED);
  const a = await (H.loadAliases());
  ok('company entries win over the legacy ones', a.lora === 'leadNew');
  ok('legacy entries the company lacks are still found (migration fallback)', a.larry === 'leadL' && a.victory === 'leadV');
  await (H.saveAliases(a));
  const w = writes.find((x) => x.ref === 'companyAliases/co1');
  ok('the next save writes the MERGED map to the company doc', !!w && w.data.aliases.larry === 'leadL' && w.data.aliases.lora === 'leadNew');
  ok('the write is stamped with who and when', w && w.data.updatedBy === 'u1' && w.data.updatedAt === 'TS');
  ok('and does not touch the user settings', !writes.some((x) => x.ref === 'userSettings/u1'));
}

console.log('\n3. hygiene');
{
  const { H } = boot(true, {});
  const c = H.cleanAliases({ ok: 'leadA', bad1: 7, bad2: 'has space', bad3: '', ['k'.repeat(200)]: 'leadB', bad4: null });
  ok('only string lead ids with safe characters survive', JSON.stringify(c) === JSON.stringify({ ok: 'leadA' }), JSON.stringify(c));
  ok('merge of nothing is empty, not a crash', Object.keys(H.mergeAliases(null, undefined)).length === 0);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
}
main();

