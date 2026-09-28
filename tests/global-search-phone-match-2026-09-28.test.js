/**
 * tests/global-search-phone-match-2026-09-28.test.js
 *
 * CRM sweep R13 (emulator, 2026-09-28) — the top-bar search
 * (docs/pro/js/global-search.js searchLeads, also used by Job Templates'
 * lead picker and entity-resolver.js).
 *
 * THE BUG: the phone test stripped every non-digit from ANY query, so
 * "zzqa-imp1" (an email) became "1" and "12 oak" became "12": every lead with
 * that digit anywhere in its phone matched at phone strength (70) and
 * outranked the lead whose email / address actually matched (40 / 50). On the
 * emulator an exact email search listed the right lead LAST of four.
 *
 * THE FIX: only a phone-shaped query (digits, spaces, ( ) . + -) with 3+
 * digits searches phones — the Cmd+K palette's floor.
 *
 * Loads the REAL file into a vm and calls window.NbdGlobalSearch.searchLeads.
 * Break-test: against main the email / address cases go red.
 *
 * Zero deps. Run: node tests/global-search-phone-match-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/global-search.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const noop = () => {};
const doc = {
  readyState: 'loading', // init() waits for DOMContentLoaded — never fired here
  addEventListener: noop, removeEventListener: noop,
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop }),
  body: { appendChild: noop },
};
const win = { document: doc, addEventListener: noop, removeEventListener: noop, console };
win.window = win;
const ctx = vm.createContext(win);
vm.runInContext(SRC, ctx, { filename: 'global-search.js' });
const GS = win.NbdGlobalSearch;
ok('global-search.js exposes NbdGlobalSearch.searchLeads', !!(GS && typeof GS.searchLeads === 'function'));

win._leads = [
  { id: 'L1', firstName: 'ZZ_QA', lastName: 'Import One', phone: '513-555-0301', email: 'zzqa-imp1@example.com', address: '12 Oak St' },
  { id: 'L2', firstName: 'ZZ_QA', lastName: 'Import Two', phone: '513-555-0302', email: 'zzqa-imp2@example.com', address: '400 Elm Ave' },
  { id: 'L3', firstName: 'ZZ_QA', lastName: 'Import Four', phone: '513-555-0312', address: '9 Birch Rd' },
];
const ids = (q) => (GS ? GS.searchLeads(q) : []).map((r) => r.lead.id);

console.log('GLOBAL SEARCH — phone matching');
{
  const r = ids('zzqa-imp1');
  ok('an email query finds only its lead (no digit-1 phone matches)', r.length === 1 && r[0] === 'L1', JSON.stringify(r));
}
{
  const r = ids('12 oak');
  ok('an address with a number finds only that address', r.length === 1 && r[0] === 'L1', JSON.stringify(r));
}
{
  const r = ids('555-0302');
  ok('a phone-shaped query still finds by phone', r.length === 1 && r[0] === 'L2', JSON.stringify(r));
}
{
  const r = ids('(513) 555');
  ok('a formatted partial phone matches all three', r.length === 3, JSON.stringify(r));
}
{
  const r = ids('03');
  ok('fewer than 3 digits does not search phones', r.length === 0, JSON.stringify(r));
}
{
  const r = ids('import');
  ok('name search unchanged', r.length === 3);
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
