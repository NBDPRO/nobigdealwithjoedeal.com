/**
 * tests/po-name-2026-10-18.test.js
 *
 * docs/pro/js/po-name.js builds the PO/Job name Jo pastes into Home Depot Pro
 * Xtra / Lowe's ("NBD-0042 Smith"). The point of the text is that the receipt
 * importer matches it EXACTLY, so the round trip is pinned: whatever poText()
 * produces must be read back by hd-import.js matchJob() as status 'code' for
 * the same lead. Synthetic leads only (public repo).
 *
 * Run: node tests/po-name-2026-10-18.test.js
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
function load(rel) {
  const win = { addEventListener() {} }; win.window = win;
  const ctx = { window: win, document: { addEventListener() {} }, console, navigator: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), ctx);
  return win;
}
const P = load('docs/pro/js/po-name.js').NBDPoName;
const H = load('docs/pro/js/hd-import.js').NBDHdImport;

ok('number first, then last name', P.poText({ customerId: 'NBD-0042', firstName: 'Pat', lastName: 'Smith' }) === 'NBD-0042 Smith');
ok('last token of a single "name" field', P.poText({ customerId: 'nbd-0042', name: 'Pat Q Smith' }) === 'NBD-0042 Smith');
ok('a business keeps its words', P.poText({ customerId: 'NBD-0007', name: 'Acme Holdings LLC' }) === 'NBD-0007 Acme Holdings LLC');
ok('no name falls back to the street, not the house number list', P.poText({ customerId: 'NBD-0009', address: '12 Elm St, Town, OH' }) === 'NBD-0009 12 Elm St');
ok('number only when nothing else is known', P.poText({ customerId: 'NBD-0010' }) === 'NBD-0010');
ok('no customer number → empty (never invent one)', P.poText({ firstName: 'Pat', lastName: 'Smith' }) === '');
ok('a malformed number is rejected', P.poText({ customerId: 'junk', lastName: 'Smith' }) === '');
ok('punctuation that breaks a register field is stripped', P.poText({ customerId: 'NBD-0042', lastName: 'O\'Brien <b>' }).indexOf('<') < 0);
ok('name is capped', P.poText({ customerId: 'NBD-0042', name: 'X'.repeat(80) }).length <= 'NBD-0042 '.length + 24);

const leads = [
  { id: 'a', customerId: 'NBD-0042', firstName: 'Pat', lastName: 'Smith', address: '1 A St' },
  { id: 'b', customerId: 'NBD-0043', firstName: 'Sam', lastName: 'Smith', address: '2 B St' },
];
const m = H.matchJob(P.poText(leads[0]), leads, {});
ok('round trip: the pasted text is matched EXACTLY by the importer', m.status === 'code' && m.leadId === 'a', JSON.stringify(m));
const m2 = H.matchJob(P.poText(leads[1]), leads, {});
ok('two customers with one last name still resolve by number', m2.status === 'code' && m2.leadId === 'b');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
