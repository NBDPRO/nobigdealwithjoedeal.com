/**
 * tests/csv-import-stage-customerid-2026-09-28.test.js
 *
 * CRM sweep R13 (emulator, 2026-09-28) — CSV lead import (docs/pro/js/data-import.js).
 *
 * BUG 1: stage text was stored verbatim. The board normalises at read time
 * ("Install Complete" → install_complete, role won), but the server classifies
 * the raw string (functions/stage-roles.js roleFor → "active"), so an imported
 * finished job was open work to the weekly digest and dormant-lead nudge.
 * FIX: store the normalised key + stageRole; keep the original as importedStage.
 *
 * BUG 2: a Customer ID column was written as-is, even when another lead
 * already carried that ID (the public referral link then answers 409
 * "not unique"), and the mint that followed was denied by the write-once rule
 * after burning a counter number.
 * FIX: drop a taken ID (mint a fresh one); keep a unique one and skip the mint.
 *
 * Runs the REAL prepareImportedLead lifted out of the file into a vm with the
 * board's normaliser semantics. Break-test: against main the helper is absent.
 *
 * Zero deps. Run: node tests/csv-import-stage-customerid-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/data-import.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// The board's normaliser for the labels this test uses (crm-stages.js
// normalizeStage: known key → itself, legacy label → key, unknown → 'new').
const KNOWN = { 'install complete': 'install_complete', 'contacted': 'contacted', 'closed': 'closed', 'lost': 'lost', 'new': 'new' };
const ROLE = { install_complete: 'won', closed: 'won', contacted: 'active', lost: 'lost', new: 'new' };
const ctx = {
  window: {
    normalizeStage: (s) => KNOWN[String(s).trim().toLowerCase()] || (ROLE[s] ? s : 'new'),
    stageRole: (k) => ROLE[k] || 'active',
  },
};
vm.createContext(ctx);
const fnSrc = extractFn(SRC, 'prepareImportedLead');
ok('prepareImportedLead exists in data-import.js', !!fnSrc);
if (fnSrc) vm.runInContext(fnSrc + '\nglobalThis.prep = prepareImportedLead;', ctx);
const prep = ctx.prep || (() => ({}));

// runImport must route every row through it, and skip the mint for a kept ID.
ok('runImport prepares each built row', /const lead = prepareImportedLead\(built, existingLeads\)/.test(SRC));
ok('the customer-ID mint is skipped when the row kept one', /if \(!lead\.customerId\s*&& window\._companyProfileLoaded === true/.test(SRC));

console.log('CSV IMPORT — stage');
{
  const r = prep({ firstName: 'A', stage: 'Install Complete' }, []);
  ok('"Install Complete" is stored as install_complete', r.stage === 'install_complete', r.stage);
  ok('…with stageRole won (what the server trusts)', r.stageRole === 'won', r.stageRole);
  ok('…and the CSV text kept as importedStage', r.importedStage === 'Install Complete');
}
{
  const r = prep({ firstName: 'B', stage: 'contacted' }, []);
  ok('an already-canonical key is unchanged, no importedStage', r.stage === 'contacted' && r.stageRole === 'active' && !('importedStage' in r));
}
{
  const r = prep({ firstName: 'C', stage: 'Won' }, []);
  ok('an unknown label lands in New (where the board already showed it), text kept', r.stage === 'new' && r.stageRole === 'new' && r.importedStage === 'Won');
}
{
  const r = prep({ firstName: 'D' }, []);
  ok('no stage column → no stage / stageRole written', !('stage' in r) && !('stageRole' in r));
}

console.log('CSV IMPORT — customer ID');
const existing = [{ id: 'x', customerId: 'DRC-0001-9GV0' }];
{
  const r = prep({ firstName: 'E', customerId: 'DRC-0001-9GV0' }, existing);
  ok('an ID another lead already has is dropped (a fresh one is minted)', !('customerId' in r));
}
{
  const r = prep({ firstName: 'F', customerId: ' OLD-1042 ' }, existing);
  ok('a unique ID is kept', r.customerId === ' OLD-1042 ');
}
{
  const input = { firstName: 'G', stage: 'Closed', customerId: 'DRC-0001-9GV0' };
  prep(input, existing);
  ok('the input row object is not mutated', input.stage === 'Closed' && input.customerId === 'DRC-0001-9GV0');
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
