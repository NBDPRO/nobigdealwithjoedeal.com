/**
 * tests/ds-layout-arcade-2026-10-25.test.js
 *
 * The Arcade layout: Quest's data as a scoreboard (SCORE / 1UP / COMBO / TODAY, a level bar, missions, hi-scores = the best lift
 * per exercise). Pins the pure half (arcade-logic.js on the real quest-logic and xp-logic), the renderer (arcade-ui.js in a vm),
 * the Today-bar branch in app.js, the ready flag (the last layout: the whole lineup is ready), scripts and scoped CSS.
 *
 * Run: node tests/ds-layout-arcade-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const A = require(path.join(DS, 'js', 'arcade-logic.js'));
const Q = require(path.join(DS, 'js', 'quest-logic.js'));
const X = require(path.join(DS, 'js', 'xp-logic.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('js/app.js'), CSS = read('css/layouts.css'), INDEX = read('index.html'), UI = read('js/arcade-ui.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }
const TODAY = '2026-10-25';
let _n = 0;
const sess = (date, exs) => ({ id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 2, exercises: exs.map(([exId, name, sets], i) => ({ exId, name, slot: i, sets })) });
const floors = [{ id: 'sleep', label: 'Sleep 7+ hrs', met: true }, { id: 'task', label: '1 Big Task', met: false }];

console.log('\n1. hi-scores and the board');
{
  const hist = [
    sess('2026-10-20', [['bb_bench', 'Bench press', [{ weight: 135, reps: 8, done: true }, { weight: 155, reps: 5, done: true }]], ['squat', 'Back squat', [{ weight: 225, reps: 5, done: true }]]]),
    sess('2026-10-24', [['bb_bench', 'Bench press', [{ weight: 185, reps: 3, done: true }, { weight: 100, reps: 20, warm: true }]], ['curl', 'Curl', [{ weight: 30, reps: 12, done: true }]], ['row', 'Row', [{ weight: 95, reps: 10, done: false }]]]),
  ];
  const hi = A.hiScores(hist, 3);
  ok('Epley e1rm: 185x3 = 203.5 rounds to 204, 225x5 = 263', Math.abs(A.e1rm(185, 3) - 203.5) < 1e-9 && Math.round(A.e1rm(225, 5)) === 263);
  ok('reps are capped at 12 for the estimate (a 20-rep set is not a bigger max)', A.e1rm(100, 20) === A.e1rm(100, 12));
  ok('the best set per lift, highest first, top three: squat, bench, curl', hi.map((h) => h.name).join() === 'Back squat,Bench press,Curl', hi.map((h) => h.name).join());
  ok('bench\'s best is the 185x3 (its e1rm beats 155x5 and 135x8)', hi[1].weight === 185 && hi[1].reps === 3 && hi[1].e1rm === 204 && hi[1].date === '2026-10-24');
  ok('warm-up sets and undone sets never post a score (Row is absent)', !hi.some((h) => h.exId === 'row'));
  ok('no sessions: an empty list, no throw', A.hiScores([]).length === 0 && A.hiScores().length === 0 && A.hiScores(null).length === 0);
  const b = A.arcade({ floors, workout: false, sessions: hist, days: [{ date: '2026-10-24', met: 2, total: 2 }], today: TODAY, xp: X, quest: Q });
  ok('score is the Quest total XP, level and combo from xp-logic, missions are the quests', b.score === Q.questBoard({ floors, workout: false, sessions: hist, days: [{ date: '2026-10-24', met: 2, total: 2 }], today: TODAY, xp: X }).totalXp && b.level >= 1 && typeof b.combo === 'number' && b.quests.map((q) => q.id).join() === 'floor:sleep,floor:task,all-floors,workout');
  ok('without the quest module the board still has shape (score 0, level 1, no missions)', A.arcade({ sessions: hist }).score === 0 && A.arcade({ sessions: hist }).level === 1 && A.arcade({ sessions: hist }).quests.length === 0);
}

console.log('\n2. the scoreboard markup');
{
  const sandbox = { window: { NBDArcade: A, NBDQuest: Q }, document: { addEventListener() {} }, localStorage: { _s: {}, getItem(k) { return this._s[k] == null ? null : this._s[k]; }, setItem(k, v) { this._s[k] = String(v); } }, console };
  vm.createContext(sandbox);
  vm.runInContext(UI, sandbox);
  const html = (o) => sandbox.window.NBDArcadeUI.html(o);
  const hist = [sess('2026-10-24', [['bb_bench', 'Bench press', [{ weight: 185, reps: 3, done: true }]]])];
  const h = html({ floors, workout: false, sessions: hist, days: [], today: TODAY, xp: X });
  ok('four stats with zero-padded digits: SCORE 6, 1UP as LV02, COMBO 2, TODAY 3', /Score<\/span><b class="ar-v">\d{6}<\/b>/.test(h) && /1UP<\/span><b class="ar-v">LV\d{2}<\/b>/.test(h) && /Combo<\/span><b class="ar-v">\d{2}/.test(h) && /Today<\/span><b class="ar-v">\+\d{3}<\/b>/.test(h));
  ok('the level bar is a progressbar with a 5%-step width class and the "to LV" text', /role="progressbar"[^>]*aria-valuenow="\d+"><i class="ar-w(\d|[1-9]\d|100)"><\/i><span class="ar-bt">\d+\/\d+ to LV\d{2}<\/span>/.test(h));
  ok('a floor mission is a button with the toggle-floor action app.js handles; the open workout mission opens the coach', /<button type="button" class="ar-m done" data-action="toggle-floor" data-floor-id="sleep" aria-pressed="true">/.test(h) && /class="ar-m" data-arcade="workout"/.test(h) && /<div class="ar-m">/.test(h));
  ok('hi-scores list the lift and the set', /<ol class="ar-hi"><li><span class="ar-rk">1<\/span><span class="ar-hn">Bench press<\/span><span class="ar-hv">185×3<\/span><\/li><\/ol>/.test(h));
  ok('no lifts yet: a plain line instead of the list', /No lifts logged yet/.test(html({ floors, workout: false, sessions: [], days: [], today: TODAY, xp: X })));
  ok('everything done: STAGE CLEAR', /STAGE CLEAR/.test(html({ floors: floors.map((f) => Object.assign({}, f, { met: true })), workout: true, sessions: [], days: [], today: TODAY, xp: X })));
  ok('lift names and floor labels are escaped', (() => { const e = html({ floors: [{ id: 'x', label: '<b>x</b>', met: false }], workout: false, sessions: [sess('2026-10-24', [['e', '<img src=x onerror=1>', [{ weight: 10, reps: 5, done: true }]]])], days: [], today: TODAY, xp: X }); return !/<img src=x/.test(e) && !/<b>x<\/b>/.test(e) && /&lt;img/.test(e); })());
  ok('no inline style attribute', !/style="/.test(h));
  ok('the high-water mark is written', Number(sandbox.localStorage._s.nbd_ds_xp_high) > 0);
}

console.log('\n3. wiring');
{
  ok('Arcade is ready; every layout in the lineup is ready now; Classic still the default', L.byId('arcade').ready === true && L.LAYOUTS.every((l) => l.ready) && L.DEFAULT === 'classic' && L.normLayout('arcade') === 'arcade');
  ok('updateTodayBar renders the scoreboard only in the Arcade layout and toggles the class', /arcade=ui==='arcade'/.test(APP) && /bar\.classList\.toggle\('today-arcade',arcade\)/.test(APP) && /if\(arcade&&window\.NBDArcadeUI&&window\.NBDQuest\)/.test(APP));
  ok('it hands the board the same inputs as Quest', /NBDArcadeUI\.html\(\{floors:fl3\.map\(f=>\(\{id:f\.id,label:f\.label,met:pd3\['floormet-'\+f\.id\]==='1'\}\)\),workout:s\.workout,sessions:sessions,days:NBDQuest\.daysFrom\(pages,fl3\),today:todayKey\(\),xp:window\.NBDXp,coach:window\.NBDCoach\}\)/.test(APP));
  ok('arcade-logic and arcade-ui load deferred, after quest-logic', ['arcade-logic.js', 'arcade-ui.js'].every((f) => new RegExp('<script src="/pro/daily-success/js/' + f.replace('.', '\\.') + '\\?v=\\d+" defer></script>').test(INDEX)) && INDEX.indexOf('quest-logic.js') < INDEX.indexOf('arcade-ui.js'));
  const ar = CSS.slice(CSS.indexOf('Arcade:'), CSS.indexOf('Journal:'));
  const rules = ar.split('\n').flatMap((l) => l.split('} ')).filter((l) => /\{/.test(l));
  ok('every Arcade rule is scoped to [data-ui="arcade"]', rules.length >= 20 && rules.every((l) => /^\[data-ui="arcade"\]/.test(l.trim())), rules.filter((l) => !/^\[data-ui="arcade"\]/.test(l.trim())).join(' | '));
  ok('missions are 44 px, the board is static, the width classes exist', /\.ar-m \{[^}]*min-height: 44px/.test(ar) && /today-arcade \{ position: static;/.test(ar) && Array.from({ length: 21 }, (_, i) => i * 5).every((w) => new RegExp('\\.ar-w' + w + ' \\{ width: ' + w + '%; \\}').test(ar)));
  ok('no font under 11 px', !/font-size: (10|9|8)px/.test(ar));
  ok('layouts.css cache version bumped', /layouts\.css\?v=9/.test(INDEX));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
