/**
 * tests/tracker-food-log-2026-09-29.test.js
 *
 * Tracker revamp Phase 2 (docs/pro/daily-success/js/food-log-logic.js +
 * food-log.js): favorites summed into a meal row, "same as yesterday" filling
 * EMPTY rows only, protein / calorie targets, and the wiring (settings sync,
 * script order, CSP). Synthetic data only.
 *
 * Run: node tests/tracker-food-log-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DS = path.join(ROOT, 'docs', 'pro', 'daily-success');
const F = require(path.join(DS, 'js', 'food-log-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const row = (name, p, c, f, cal) => ({ name, p, c, f, cal });
const data = (...rows) => {
  const d = {};
  rows.forEach((r, i) => { if (!r) return; d['diet-m' + i + '-name'] = r.name; ['p', 'c', 'f', 'cal'].forEach((k) => { d['diet-m' + i + '-' + k] = r[k]; }); });
  return d;
};

console.log('\n1. adding a favorite into a meal row');
{
  const eggs = row('Eggs + toast', 30, 25, 18, 390);
  const empty = F.mealOf({}, 0);
  const a = F.addToMeal(empty, eggs);
  ok('into an empty row: the favorite\'s values', a.name === 'Eggs + toast' && a.p === '30' && a.cal === '390');
  const b = F.addToMeal(a, row('Protein shake', 50, 5, 2, 250));
  ok('into a typed row: names join with " + ", macros sum', b.name === 'Eggs + toast + Protein shake' && b.p === '80' && b.cal === '640', JSON.stringify(b));
  const c = F.addToMeal(F.mealOf(data(row('Oats', '12.5', '', '', '')), 0), row('Whey', 24.4, 0, 0, 0));
  ok('decimals kept to 0.1; a field neither had stays blank', c.p === '36.9' && c.c === '' && c.cal === '');
  ok('adding the same favorite twice does not repeat the name', F.addToMeal(a, eggs).name === 'Eggs + toast' && F.addToMeal(a, eggs).p === '60');
  ok('a favorite with no numbers adds nothing', F.addToMeal(empty, row('Water', '', '', '', '')) === null);
}

console.log('\n2. same as yesterday');
{
  const prev = data(row('Oats', 20, 60, 8, 400), row('Chicken bowl', 50, 70, 15, 620), null, row('Shake', 40, 5, 2, 200));
  const today = data(null, row('Burger', 35, 40, 30, 600));
  const patch = F.copyDay(prev, today);
  ok('fills empty rows only (breakfast + snacks), never overwrites lunch', Object.keys(patch).join() === '0,3' && patch[0].name === 'Oats' && patch[3].cal === '200', JSON.stringify(Object.keys(patch)));
  ok('an empty day before → nothing to copy', Object.keys(F.copyDay({}, {})).length === 0);
  const pages = [{ dk: '2026-09-27' }, { dk: '2026-09-29' }, { dk: '2026-09-28' }, { dk: 'bad' }, { dk: '2026-09-30' }];
  ok('the day before is the latest EARLIER date, whatever the page order', F.previousDay(pages, '2026-09-29').dk === '2026-09-28' && F.previousDay(pages, '2026-09-27') === null);
}

console.log('\n3. totals, targets, progress');
{
  const t = F.totals(data(row('A', '30', '10', '', '300'), row('B', '25.5', '', '', 'x')));
  ok('totals sum typed numbers (junk counts as 0)', t.p === 55.5 && t.c === 10 && t.cal === 300 && t.any === true);
  ok('empty day → nothing typed', F.totals({}).any === false);
  ok('protein defaults to 1 g per lb of weight', F.targetsFor(212.4, {}).protein === 212 && F.targetsFor(212.4, {}).proteinFrom === 'weight');
  ok('a target Jo sets wins; calories only when set', F.targetsFor(212, { protein: 180, calories: 2400 }).protein === 180 && F.targetsFor(212, {}).calories === null && F.targetsFor(212, { calories: 2400 }).calories === 2400);
  ok('no weight and no target → no protein bar (never a made-up number)', F.targetsFor(null, {}).protein === null && F.targetsFor(5000, {}).protein === null);
  const pr = F.progress(150, 200);
  ok('progress: fraction + amount left', pr.pct === 0.75 && pr.left === 50 && pr.over === false);
  ok('over the target: capped bar, flagged, left = 0', F.progress(250, 200).pct === 1 && F.progress(250, 200).over && F.progress(250, 200).left === 0);
  ok('meal by the clock', F.mealForHour(7) === 0 && F.mealForHour(12) === 1 && F.mealForHour(18) === 2 && F.mealForHour(22) === 3);
}

console.log('\n4. favorites list');
{
  let list = [];
  list = F.upsertFav(list, row('Shake', 40, 5, 2, 200));
  list = F.upsertFav(list, row('Oats', 12, 50, 6, 300));
  list = F.upsertFav(list, row('shake', 50, 5, 2, 250));
  ok('same name (any case) replaces, newest first', list.length === 2 && list[0].name === 'shake' && list[0].p === 50 && list[1].name === 'Oats');
  ok('remove by name', F.removeFav(list, 'OATS').length === 1);
  for (let i = 0; i < 60; i++) list = F.upsertFav(list, row('F' + i, 1, 0, 0, 0));
  ok('capped at ' + F.MAX_FAVS, list.length === F.MAX_FAVS);
  ok('names are trimmed and bounded', F.normalizeFav(row('  a   b  ', 1)).name === 'a b' && F.normalizeFav(row('x'.repeat(200), 1)).name.length === 80);
}

console.log('\n5. wiring');
{
  const html = fs.readFileSync(path.join(DS, 'index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  ok('logic then UI, after app.js and tracker-history (the target reads the weight trend)',
    at('js/app.js') > 0 && at('js/tracker-history-logic.js') > at('js/app.js') && at('js/food-log-logic.js') > at('js/tracker-history-logic.js') && at('js/food-log.js?') > at('js/food-log-logic.js'));
  const sync = fs.readFileSync(path.join(DS, 'ds-firebase-sync.js'), 'utf8');
  ok('favorites + targets ride the userSettings sync (survive sign-out)', /key: 'nbd_ds_food',\s+field: 'dsFood'/.test(sync));
  const ui = strip(fs.readFileSync(path.join(DS, 'js', 'food-log.js'), 'utf8'));
  ok('every change is stamped for the settings sync', /dsSettingsChanged\(KEY\)/.test(ui) && /localStorage\.setItem\(KEY/.test(ui));
  ok('meals are saved through the tracker\'s own save (collectPage)', /window\.collectPage\(false\)/.test(ui));
  ok('favorite names are escaped before innerHTML', /esc\(f\.name\)/.test(ui) && !/\+ f\.name \+/.test(ui));
  ok('no inline handlers (CSP)', !/\son[a-z]+=/.test(ui));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
