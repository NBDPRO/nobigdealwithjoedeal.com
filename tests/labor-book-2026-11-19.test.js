/**
 * tests/labor-book-2026-11-19.test.js — the pure rules behind the Labor hours
 * book editor (docs/pro/js/labor-book-logic.js, flag laborHoursBook).
 *
 * Behaviour, not source shape. Each rule has a case that SHOULD fire and a control
 * that should not. Fixture numbers are synthetic: nothing here is a real
 * productivity figure.
 *
 * Run: node tests/labor-book-2026-11-19.test.js
 */
const path = require('path');
const L = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'labor-book-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; fails.push(name); console.log('  FAIL ' + name); }
}

const LIST = [
  { id: 'A1', name: 'Alpha install', unit: 'SQ', category: 'install' },
  { id: 'A2', name: 'Alpha tear-off', unit: 'SQ', category: 'tear-off' },
  { id: 'B1', name: 'Beta detail', unit: 'LF', category: 'detail' },
  { id: 'C1', name: 'Cleanup walk', unit: 'JOB', category: 'overhead' },
];
const BOOK = { A1: { hoursPerUnit: 0.37, rate: 99 }, B1: { hoursPerUnit: 0 }, C1: { rate: 5 } };
const op = (id) => BOOK[id] || null;

console.log('1. parseHours');
{
  ok('a plain number', L.parseHours('0.4').value === 0.4 && L.parseHours('12').value === 12 && L.parseHours(' 7 ').value === 7);
  ok('a leading-dot number (.5) is fine', L.parseHours('.5').value === 0.5);
  ok('a real 0 is a value, not blank', L.parseHours('0').ok === true && L.parseHours('0').value === 0 && !L.parseHours('0').blank);
  ok('blank means "leave it alone", not 0', L.parseHours('').blank === true && L.parseHours('   ').blank === true && L.parseHours(null).blank === true);
  ok('the upper bound is 1000: 1000 ok, 1000.001 and 1001 refused', L.parseHours('1000').ok === true && L.parseHours('1001').ok === false && L.parseHours('1000.001').ok === false);
  ok('more than 3 decimals is refused', L.parseHours('0.1234').ok === false && L.parseHours('0.123').ok === true);
  ok('junk is refused with a message: text, negative, comma, exponent, two dots, units', ['abc', '-1', '1,5', '1e3', '1.2.3', '4h', '$5', '--'].every((v) => { const r = L.parseHours(v); return r.ok === false && /Enter hours/.test(r.message); }));
}

console.log('2. parseCrew');
{
  ok('whole numbers 1 to 20', L.parseCrew('1').value === 1 && L.parseCrew('3').value === 3 && L.parseCrew('20').value === 20);
  ok('0, 21, decimals, text and negatives are refused', ['0', '21', '2.5', 'x', '-2', '100'].every((v) => L.parseCrew(v).ok === false));
  ok('blank leaves the crew size alone', L.parseCrew('').blank === true && L.parseCrew(undefined).blank === true);
}

console.log('3. rowsFor');
{
  const rows = L.rowsFor(LIST, op, '');
  ok('every action is listed, sorted by category then name', rows.map((r) => r.id).join() === 'B1,A1,C1,A2');
  ok('held hours show; an action with no hours shows null (an empty box, never a default)', rows.find((r) => r.id === 'A1').hours === 0.37 && rows.find((r) => r.id === 'A2').hours === null);
  ok('a real 0 held in the book shows as 0, not as empty', rows.find((r) => r.id === 'B1').hours === 0);
  ok('an entry that holds only a rate has no hours', rows.find((r) => r.id === 'C1').hours === null);
  ok('the filter matches name, id, category or unit; every word must match', L.rowsFor(LIST, op, 'alpha').length === 2 && L.rowsFor(LIST, op, 'alpha tear').length === 1 && L.rowsFor(LIST, op, 'b1').length === 1 && L.rowsFor(LIST, op, 'overhead').length === 1 && L.rowsFor(LIST, op, 'lf').length === 1);
  ok('control: a filter that matches nothing returns nothing', L.rowsFor(LIST, op, 'zzz').length === 0);
  ok('junk entries (no id) are skipped', L.rowsFor([null, {}, { name: 'x' }, ...LIST], op, '').length === 4);
}

console.log('4. plan: what actually needs writing');
{
  const p = L.plan(LIST, op, { A1: '0.37', A2: '1.25', B1: '0', C1: '2' });
  ok('an unchanged value is not written (A1 0.37 = 0.37, B1 0 = 0)', !p.writes.some((w) => w.id === 'A1' || w.id === 'B1'));
  ok('a new value on an action with none is written (A2)', p.writes.some((w) => w.id === 'A2' && w.value === 1.25));
  ok('a value on an entry that held only a rate is written (C1)', p.writes.some((w) => w.id === 'C1' && w.value === 2));
  ok('control: exactly the two real changes', p.writes.length === 2 && p.errors.length === 0 && p.blanksOverSet.length === 0);
  const z = L.plan(LIST, op, { A2: '0' });
  ok('typing 0 where nothing was held IS a change (a real 0 is a number the company entered)', z.writes.length === 1 && z.writes[0].value === 0);
  const ch = L.plan(LIST, op, { A1: '0.5' });
  ok('changing a held value is a change', ch.writes.length === 1 && ch.writes[0].id === 'A1' && ch.writes[0].value === 0.5);
  const bl = L.plan(LIST, op, { A1: '', A2: '', B1: '' });
  ok('a blank over a held value is reported, never written', bl.writes.length === 0 && bl.blanksOverSet.join() === 'A1,B1');
  ok('control: a blank over nothing is silently ignored', !bl.blanksOverSet.includes('A2'));
  const bad = L.plan(LIST, op, { A1: 'abc', A2: '2' });
  ok('an invalid box is an error naming the action, and the valid ones still plan', bad.errors.length === 1 && bad.errors[0].id === 'A1' && bad.errors[0].name === 'Alpha install' && bad.writes.length === 1);
  const bad2 = L.plan(LIST, op, { A2: '2', C1: 'abc' });
  ok('an invalid box AFTER a valid one does not erase the valid write', bad2.errors.length === 1 && bad2.errors[0].id === 'C1' && bad2.writes.length === 1 && bad2.writes[0].id === 'A2');
  ok('ids not in the list, and ids not typed, are ignored', L.plan(LIST, op, { NOPE: '5' }).writes.length === 0 && L.plan(LIST, op, {}).writes.length === 0 && L.plan(LIST, op, null).writes.length === 0);
  ok('the book\'s other fields (rate) never enter the plan', JSON.stringify(L.plan(LIST, op, { A1: '9' }).writes) === JSON.stringify([{ id: 'A1', value: 9 }]));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
