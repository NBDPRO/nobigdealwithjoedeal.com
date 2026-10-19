/**
 * tests/receipt-sorter-logic-2026-10-18.test.js
 *
 * docs/pro/js/receipt-sorter-logic.js — the pure ranking behind the receipt
 * sorter. Drives the real module in a vm sandbox with SYNTHETIC leads and
 * receipts (public repo). Pins the confidence rule (only a customer number or
 * a remembered alias is HIGH), that a bare date / amount / store can never
 * propose a job, that evidence is plain language, and the fuzzy-name lane.
 *
 * Run: node tests/receipt-sorter-logic-2026-10-18.test.js
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
const win = {}; win.window = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/receipt-sorter-logic.js'), 'utf8'), win);
const L = win.NBDReceiptSorterLogic;

const LEADS = [
  { id: 'a', customerId: 'NBD-0042', firstName: 'Robert', lastName: 'Smith', address: '12 Ashgrove Ave, Town, OH', damageType: 'Roof Repair', scheduledDate: '2026-09-20', scheduledEndDate: '2026-09-21' },
  { id: 'b', customerId: 'NBD-0043', firstName: 'Sam', lastName: 'Smith', address: '40 Birch Ln, Town, OH', damageType: 'Gutters' },
  { id: 'c', customerId: 'NBD-0044', firstName: 'Lora', lastName: 'Mueller', address: '6389 Muellers Lake Ln, Milford, OH', damageType: 'Siding Repair' },
  { id: 'd', customerId: 'NBD-0045', name: 'Acme Holdings LLC', address: '4127 Lora Ave, Town, OH' },
  { id: 'e', customerId: 'NBD-0046', firstName: 'Del', lastName: 'Ray', address: 'Town, OH', deleted: true },
];
const R = (po, extra) => Object.assign({ poJobName: po, storeNumber: '3844', dateKey: '2026-09-22', items: [], category: 'materials' }, extra || {});
const rank = (po, extra, ctx) => L.rank(R(po, extra), LEADS, ctx || {});

console.log('\n1. confidence: only a number or a remembered alias is HIGH');
{
  const r = rank('NBD-0042 Smith');
  ok('a customer number is HIGH and exact', r.high && r.high.leadId === 'a' && r.high.score === 100 && /number/i.test(r.high.evidence[0]));
  ok('the number wins even when the name says another Smith', r.candidates[0].leadId === 'a');
  const al = rank('Lora', {}, { aliases: { lora: 'd' } });
  ok('a remembered alias is HIGH', al.high && al.high.leadId === 'd' && /already assigned/.test(al.high.evidence[0]));
  const nm = rank('Robert Smith');
  ok('a full-name match is only a suggestion, never HIGH', nm.high === null && nm.candidates[0].leadId === 'a' && nm.candidates[0].level === 'suggested');
}

console.log('\n2. a bare date, amount or store can never propose a job');
{
  const r = rank('', { dateKey: '2026-09-20', storeNumber: '3844' });
  ok('a blank PO with the job\'s own date proposes nothing', r.candidates.length === 0);
  ok('a nonsense PO proposes nothing', rank('32').candidates.length === 0);
  ok('deleted leads never appear', !rank('Del Ray').candidates.some((c) => c.leadId === 'e'));
}

console.log('\n3. fuzzy names');
{
  ok('nickname: "Bob Smith" finds Robert Smith', rank('Bob Smith').candidates[0].leadId === 'a');
  ok('last name only still finds them (weaker than the full name)', rank('Smith').candidates[0].score < rank('Robert Smith').candidates[0].score);
  ok('a typo in a long name still matches ("Meuller" for Mueller)', rank('Lora Meuller').candidates[0].leadId === 'c');
  ok('case and punctuation do not matter', rank('  ROBERT,  smith!! ').candidates[0].leadId === 'a');
  ok('business word match', rank('acme').candidates[0].leadId === 'd');
  const cc = rank('Smith', { dateKey: '2026-12-01' });
  ok('two Smiths is flagged as a close call, never a pick', cc.closeCall === true && cc.high === null);
}

console.log('\n4. street parsing');
{
  const full = rank('6389 Muellers Lake Ln');
  ok('house number + street is the strongest name-free signal', full.candidates[0].leadId === 'c' && full.candidates[0].score >= 50 && /House number and street/.test(full.candidates[0].evidence.join(' ')));
  ok('a street that is nobody\'s matches nothing', rank('victory ave').candidates.length === 0);
  const only = rank('ashgrove');
  ok('street name alone scores lower than number + street', only.candidates[0].leadId === 'a' && only.candidates[0].score < 50);
  ok('"us" and "rd" style words never match by themselves', rank('us 22 rd').candidates.length === 0);
}

console.log('\n5. same trip, job window, items (all need another signal first)');
{
  const sib = L.buildSiblings([{ leadId: 'c', storeNumber: '3844', dateKey: '2026-09-22', reviewState: 'assigned' }, { leadId: 'c', storeNumber: '3844', dateKey: '2026-09-22', reviewState: 'assigned' }]);
  const withTrip = rank('Mueller', {}, { siblings: sib });
  const without = rank('Mueller');
  ok('receipts from the same store and day already on this job lift it', withTrip.candidates[0].score === without.candidates[0].score + 25 && /2 other receipts/.test(withTrip.candidates[0].evidence.join(' ')));
  const sibOnly = rank('', {}, { siblings: sib });
  ok('a sibling alone is only a weak suggestion, never HIGH', sibOnly.high === null && sibOnly.candidates.length === 1 && sibOnly.candidates[0].score === 25 && sibOnly.candidates[0].level === 'suggested');
  const inWin = rank('Robert Smith', { dateKey: '2026-09-20' });
  ok('buying while the job was scheduled adds evidence', /scheduled/.test(inWin.candidates[0].evidence.join(' ')) && inWin.candidates[0].score === 57);
  const far = rank('Robert Smith', { dateKey: '2026-12-01' });
  ok('a date far from the job adds nothing and never subtracts', far.candidates[0].score === 45);
  const roof = rank('Robert Smith', { dateKey: '2026-12-01', items: [{ desc: 'GAF Timberline HDZ Shingles' }, { desc: 'Roofing Nails' }] });
  ok('roofing items on a roof job add evidence naming what matched', /roofing/.test(roof.candidates[0].evidence.join(' ')) && roof.candidates[0].score === 55);
  const wrong = rank('Robert Smith', { dateKey: '2026-12-01', items: [{ desc: '5 in. K-Style Gutter' }] });
  ok('gutter items on a roof job add nothing', wrong.candidates[0].score === 45);
}

console.log('\n6. overhead hint and the queue filter');
{
  ok('a shop word suggests overhead', rank('SHOP').overhead.hint === true);
  ok('a tool category suggests overhead', rank('', { category: 'tools_small_equipment' }).overhead.hint === true);
  ok('queue: unsorted and suggested need sorting', L.needsSorting({ reviewState: 'unsorted' }) && L.needsSorting({ reviewState: 'suggested' }));
  ok('queue: assigned, overhead and deleted do not', !L.needsSorting({ reviewState: 'assigned' }) && !L.needsSorting({ reviewState: 'overhead' }) && !L.needsSorting({ reviewState: 'unsorted', deleted: true }));
  ok('queue: an older import with no job and no state is included', L.needsSorting({ source: 'import_homedepot', costType: 'direct', leadId: null }));
  ok('queue: a hand-entered expense with no state is not', !L.needsSorting({ source: 'manual', costType: 'direct', leadId: null }));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
