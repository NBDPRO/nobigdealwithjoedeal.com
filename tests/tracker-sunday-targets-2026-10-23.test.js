/**
 * tests/tracker-sunday-targets-2026-10-23.test.js
 *
 * Daily Success: the Sunday review that acts (weekly-targets-logic.js, plus the
 * Accept wiring in review-ui.js and the weekly goal in workout-coach.js).
 * Proposals come from the week's real numbers and are applied ONLY by an
 * explicit Accept tap. Synthetic data; no clock involved (windows are passed in).
 *
 * Run: node tests/tracker-sunday-targets-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const W = require(path.join(DS, 'js', 'weekly-targets-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; }
}
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\s*\/\/.*$/gm, '');
const adjust = { verdict: 'adjust', change: 0.1, newCalories: 1800 };
const find = (r, id) => r.items.find((i) => i.id === id);

console.log('\n1. the week\'s numbers');
{
  const ses = [
    { date: '2026-10-19', finishedAt: 1 }, { date: '2026-10-21', finishedAt: 2 }, { date: '2026-10-24', finishedAt: 3 },
    { date: '2026-10-22' /* never finished */ }, { date: '2026-10-12', finishedAt: 4 }, { date: '2026-10-25', finishedAt: 5 },
  ];
  ok('counts finished workouts inside the window only', W.countWorkouts(ses, '2026-10-18', '2026-10-24') === 3);
  ok('unfinished and out-of-window sessions are not counted (negative control)', W.countWorkouts(ses, '2026-10-22', '2026-10-22') === 0);
  ok('bad window or junk input counts 0', W.countWorkouts(ses, 'x', '2026-10-24') === 0 && W.countWorkouts(null, '2026-10-18', '2026-10-24') === 0);
  const cw = W.calorieWeek([{ dk: '2026-10-18', cal: 2000 }, { dk: '2026-10-19', cal: 2200 }, { dk: '2026-10-20', cal: 0 }, { dk: '2026-10-10', cal: 9000 }], '2026-10-18', '2026-10-24');
  ok('calorie average uses logged in-window days only', cw.days === 2 && cw.avg === 2100);
  ok('no logged days gives null, not 0', W.calorieWeek([], '2026-10-18', '2026-10-24').avg === null);
  ok('weekly target is a whole number 1-7, else null', W.normWeekly(4) === 4 && W.normWeekly('3') === 3 && W.normWeekly(0) === null && W.normWeekly(8) === null
    && W.normWeekly('') === null && W.normWeekly(null) === null && W.normWeekly(true) === null && W.normWeekly('abc') === null);
}

console.log('\n2. workout proposals');
{
  ok('no target yet: the week\'s own count becomes the proposal', find(W.propose({ workouts: 3 }), 'workouts').to === 3 && find(W.propose({ workouts: 3 }), 'workouts').from === null);
  ok('no target and no workouts: nothing invented (negative control)', W.propose({ workouts: 0 }).items.length === 0);
  ok('a single workout proposes the floor of 2, never 1', find(W.propose({ workouts: 1 }), 'workouts').to === 2);
  ok('a huge week is capped at 6', find(W.propose({ workouts: 9 }), 'workouts').to === 6);
  const hit = find(W.propose({ workouts: 3, workoutTarget: 3, floorsPct: 90 }), 'workouts');
  ok('hit the target with floors fine: one more', hit && hit.from === 3 && hit.to === 4);
  ok('hit the target but floors weak: no increase (negative control)', !find(W.propose({ workouts: 3, workoutTarget: 3, floorsPct: 50 }), 'workouts'));
  ok('floors unknown does not block a step up', !!find(W.propose({ workouts: 3, workoutTarget: 3, floorsPct: null }), 'workouts'));
  ok('target 6 never goes to 7', !find(W.propose({ workouts: 6, workoutTarget: 6, floorsPct: 100 }), 'workouts'));
  const miss = find(W.propose({ workouts: 1, workoutTarget: 4, floorsPct: 80 }), 'workouts');
  ok('missed by 2+: step back one', miss && miss.from === 4 && miss.to === 3);
  ok('missed by 1: target stays, with a note (negative control)', !find(W.propose({ workouts: 3, workoutTarget: 4 }), 'workouts') && W.propose({ workouts: 3, workoutTarget: 4 }).notes.some((n) => /target stays/.test(n)));
  ok('never steps back below 2', !find(W.propose({ workouts: 0, workoutTarget: 2 }), 'workouts'));
}

console.log('\n3. calorie proposals');
{
  const p = W.propose({ workouts: 0, calTarget: 2000, calDays: 6, calAvg: 2050, weightRule: adjust });
  ok('weigh-in rule says cut and the target was followed: propose the rule\'s number', find(p, 'calories') && find(p, 'calories').from === 2000 && find(p, 'calories').to === 1800);
  const over = W.propose({ calTarget: 2000, calDays: 6, calAvg: 2600, weightRule: adjust });
  ok('ate well over the target: no cut, a note says hit it first (negative control)', !find(over, 'calories') && over.notes.some((n) => /Hit the target first/.test(n)));
  const thin = W.propose({ calTarget: 2000, calDays: 2, calAvg: 1900, weightRule: adjust });
  ok('fewer than 4 logged days: no calorie change, a note says so', !find(thin, 'calories') && thin.notes.some((n) => /4\+ days/.test(n)));
  ok('weight on track: no calorie proposal', !find(W.propose({ calTarget: 2000, calDays: 6, calAvg: 2000, weightRule: { verdict: 'on-track' } }), 'calories'));
  ok('no target set: nothing to change', !find(W.propose({ calDays: 6, calAvg: 2000, weightRule: adjust }), 'calories'));
  const low = W.propose({ calTarget: 1300, calDays: 6, calAvg: 1300, weightRule: { verdict: 'adjust', newCalories: 1100 } });
  ok('never proposes below 1200', !find(low, 'calories') && low.notes.some((n) => /1200/.test(n)));
}

console.log('\n4. floors are advice only');
{
  const r = W.propose({ floorsPct: 40 });
  ok('weak floors add a note and no item', r.items.length === 0 && r.notes.some((n) => /Floors hit 40%/.test(n)));
  ok('good floors add no note', !W.propose({ floorsPct: 85 }).notes.some((n) => /Floors/.test(n)));
}

console.log('\n5. applying changes only what was accepted');
{
  const coach = { rotation: 'ppl', avoid: ['x'], warmups: false };
  const next = W.applyWorkouts(coach, 4);
  ok('workouts per week is written and every other coach setting is kept', next.workoutsPerWeek === 4 && next.rotation === 'ppl' && next.avoid[0] === 'x' && next.warmups === false);
  ok('apply does not mutate the old settings', coach.workoutsPerWeek === undefined);
  ok('a bad workout number changes nothing (negative control)', W.applyWorkouts(coach, 12).workoutsPerWeek === undefined && W.applyWorkouts(coach, 'x').workoutsPerWeek === undefined);
  const food = { favorites: [{ n: 'a' }], targets: { protein: 180, calories: 2000 } };
  const f2 = W.applyCalories(food, 1800);
  ok('calorie target is written; protein and favorites are kept', f2.targets.calories === 1800 && f2.targets.protein === 180 && f2.favorites.length === 1 && food.targets.calories === 2000);
  ok('a bad calorie number changes nothing (negative control)', W.applyCalories(food, 500).targets.calories === 2000 && W.applyCalories(food, 'x').targets.calories === 2000);
}

console.log('\n6. wiring: proposals are shown, never auto-applied');
{
  const vm = require('vm');
  ['review-ui.js', 'workout-coach.js', 'weekly-targets-logic.js'].forEach((f) => {
    let err = '';
    try { new vm.Script(read('js', f), { filename: f }); } catch (e) { err = e.message; }
    ok(f + ' compiles (an unescaped apostrophe in a string would break the whole review screen)', err === '', err);
  });
  const ui = stripComments(read('js', 'review-ui.js'));
  const coach = stripComments(read('js', 'workout-coach.js'));
  const lg = stripComments(read('js', 'weekly-targets-logic.js'));
  const body = (name) => { const i = ui.indexOf('function ' + name + '('); return ui.slice(i, ui.indexOf('\n  function ', i + 10)); };
  const idx = read('index.html');
  ok('the logic never touches storage or the DOM', !/localStorage|document\.|window\.dsSettingsChanged|fetch\(/.test(lg));
  ok('review-ui writes the proposed settings only inside doAccept', (ui.match(/localStorage\.setItem\(key, JSON\.stringify\(next\)\)/g) || []).length === 1 && /localStorage\.setItem\(key, JSON\.stringify\(next\)\)/.test(body('doAccept')));
  ok('actsFor is called when the sheet opens, not on save, paint or publish', /_acts = actsFor\(_x\)/.test(body('open')) && !/actsFor\(/.test(body('doSave')) && !/actsFor\(/.test(body('publish')) && !/actsFor\(/.test(body('cardHtml')));
  ok('Accept is an explicit button handled by the delegated listener', /data-rv-action="accept"/.test(ui) && /a === 'accept'\) doAccept/.test(ui));
  ok('an accepted proposal cannot be applied twice', /_accepted\[id\]\) return/.test(ui));
  ok('every proposal text is escaped before innerHTML', /esc\(it\.reason\)/.test(ui) && /esc\(it\.label\)/.test(ui) && /esc\(n\) \+ '<\/div>'/.test(ui));
  ok('doAccept is reachable only from the Accept click (defined once, called once)', (ui.match(/doAccept\(/g) || []).length === 2 && /a === 'accept'\) doAccept\(t\.dataset\.id\)/.test(ui));
  ok('coach settings() keeps the weekly goal so saving another setting cannot drop it', /\n\s+workoutsPerWeek: window\.NBDWeeklyTargets/.test(coach.slice(coach.indexOf('function settings()'), coach.indexOf('function saveSettings'))));
  ok('the logic loads before the review and the coach', idx.indexOf('weekly-targets-logic.js') > -1 && idx.indexOf('weekly-targets-logic.js') < idx.indexOf('review-logic.js?v=') && idx.indexOf('weekly-targets-logic.js') < idx.indexOf('workout-coach.js?v='));
  ok('no inline handlers in the new code', !/\son[a-z]+=/i.test(lg));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
