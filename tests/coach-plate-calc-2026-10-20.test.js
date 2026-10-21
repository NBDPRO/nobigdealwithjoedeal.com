/**
 * tests/coach-plate-calc-2026-10-20.test.js
 *
 * Workout Coach plate calculator (tracker ideas #4): "45 / 25 / 10 per side"
 * beside the target weight, from a bar weight + plate inventory set once in
 * the coach settings. Pure arithmetic in workout-coach-logic.js.
 *
 * Run: node tests/coach-plate-calc-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n1. defaults + normalising');
{
  const d = C.normPlates();
  ok('default bar is 45 lb', d.bar === 45);
  ok('default plates are 45/35/25/10/5/2.5', same(d.plates, [45, 35, 25, 10, 5, 2.5]));
  const n = C.normPlates({ bar: 35, plates: [10, 45, 10, 'x', 7, 25] });
  ok('keeps a valid bar, sorts big-first, drops dupes + unknown sizes', n.bar === 35 && same(n.plates, [45, 25, 10]));
  ok('junk bar falls back to 45', C.normPlates({ bar: 'abc' }).bar === 45 && C.normPlates({ bar: 500 }).bar === 45);
  ok('empty plate list falls back to the default set', same(C.normPlates({ plates: [] }).plates, [45, 35, 25, 10, 5, 2.5]));
}

console.log('\n2. the math (positive controls)');
{
  const r = (w, cfg) => C.platesPerSide(w, cfg);
  ok('135 = one 45 a side', same(r(135).perSide, [45]) && r(135).remainder === 0);
  ok('185 = 45 + 25', same(r(185).perSide, [45, 25]));
  ok('225 = two 45s', same(r(225).perSide, [45, 45]));
  ok('155 = 45 + 10', same(r(155).perSide, [45, 10]));
  ok('the bar alone says "Just the bar"', r(45).text === 'Just the bar' && r(45).perSide.length === 0);
  ok('text reads "45 / 25 / 10 per side"', r(205, { plates: [45, 25, 10] }).text === '45 / 25 / 10 per side');
  ok('50 = the bar + a 2.5 a side', same(r(50).perSide, [2.5]) && r(50).remainder === 0);
  ok('a 35 lb bar changes the math', same(r(135, { bar: 35 }).perSide, [45, 5]));
  ok('a short rack: only 25s and 10s -> 135 = 25 + 10 + 10', same(r(135, { plates: [25, 10] }).perSide, [25, 10, 10]));
  const sum = (w, cfg) => { const p = r(w, cfg); return p.perSide.reduce((a, b) => a + b, 0) * 2 + p.bar; };
  let bad = 0;
  for (let w = 45; w <= 405; w += 5) if (sum(w) !== w) bad++;
  ok('every 5 lb step from 45 to 405 loads exactly (no float drift)', bad === 0, bad + ' off');
}

console.log('\n3. remainder is reported, never silently rounded (negative controls)');
{
  const p = C.platesPerSide(46);
  ok('46 lb cannot be made: loads the bar and says 1 lb short', p.perSide.length === 0 && p.remainder === 1 && p.achieved === 45);
  ok('the text shows both numbers', /plates make 45/.test(p.text) && /1 lb short/.test(p.text));
  const q = C.platesPerSide(150, { plates: [45] });
  ok('45s only: 150 loads one a side, 15 lb short', same(q.perSide, [45]) && q.remainder === 15 && q.achieved === 135);
  const exact = C.platesPerSide(135);
  ok('control: an exact weight has no remainder text', exact.remainder === 0 && !/short/.test(exact.text));
  const lite = C.platesPerSide(30);
  ok('under the bar is called out, nothing is loaded', lite.underBar === true && lite.perSide.length === 0 && /bar/.test(lite.text));
  ok('no weight -> null (bodyweight / new lift)', C.platesPerSide(0) === null && C.platesPerSide('') === null && C.platesPerSide(null) === null);
}

console.log('\n4. the screen wires it through');
{
  ok('settings() normalises plates', /plates:\s*C\(\)\.normPlates\(s\.plates\)/.test(UI));
  ok('shown only for barbell lifts with a target weight', /ex\.equip !== 'barbell'[\s\S]{0,80}target\.weight/.test(UI));
  ok('rendered under the target line', /wc-target[\s\S]{0,120}platesHtml\(x, ex\)/.test(UI));
  ok('text is escaped', /esc\(p\.text\)/.test(UI));
  ok('bar + plate chips save through saveSettings', /set-bar[\s\S]{0,150}saveSettings\(s\)/.test(UI) && /toggle-plate[\s\S]{0,400}saveSettings\(s\)/.test(UI));
  ok('cannot turn every plate off', /Keep at least one plate size/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
