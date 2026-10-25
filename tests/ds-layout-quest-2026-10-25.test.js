/**
 * tests/ds-layout-quest-2026-10-25.test.js
 *
 * The Quest layout: the Today bar as a quest board (level + XP bar, streak, floors as tappable quests, the all-floors bonus,
 * the workout quest). Pins the pure board (quest-logic.js on the real xp-logic), the renderer (quest-ui.js in a vm), the
 * Today-bar branch in app.js, the ready flag, the scripts and the scoped CSS. Jo's rule: streaks can break, XP never drops.
 *
 * Run: node tests/ds-layout-quest-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const Q = require(path.join(DS, 'js', 'quest-logic.js'));
const X = require(path.join(DS, 'js', 'xp-logic.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('js/app.js'), CSS = read('css/layouts.css'), INDEX = read('index.html'), UI = read('js/quest-ui.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const TODAY = '2026-10-25';
let _n = 0;
const sess = (date, n) => ({ id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 2, exercises: [{ exId: 'bb_bench', name: 'Bench', slot: 0, sets: Array.from({ length: n }, () => ({ weight: 135, reps: 8, done: true })) }] });
const floors = [{ id: 'sleep', label: 'Sleep 7+ hrs', met: true }, { id: 'task', label: '1 Big Task', met: false }];

console.log('\n1. questBoard');
{
  const b = Q.questBoard({ floors, workout: false, sessions: [sess('2026-10-24', 6)], days: [{ date: '2026-10-24', met: 2, total: 2 }, { date: TODAY, met: 1, total: 2 }], today: TODAY, xp: X });
  ok('quests: one per floor, the all-floors bonus, the workout', b.quests.map((q) => q.id).join() === 'floor:sleep,floor:task,all-floors,workout');
  ok('floor quests carry their id for the tap and the xp-logic floor XP', b.quests[0].floorId === 'sleep' && b.quests[0].xp === X.FLOOR_XP && b.quests[0].done === true && b.quests[1].done === false);
  ok('the bonus pays ALL_FLOORS_XP and is not done with one floor missing', b.quests[2].xp === X.ALL_FLOORS_XP && b.quests[2].done === false);
  ok('the workout quest pays WORKOUT_XP and is open', b.quests[3].xp === X.WORKOUT_XP && b.quests[3].done === false);
  ok('counts: 1 done of 4, not all done', b.doneCount === 1 && b.allDone === false);
  ok('today XP comes from xp-logic (one floor met = 10)', b.todayXp === 10);
  ok('level and total XP come from xp-logic (yesterday: 100 + 30 sets XP + 45 floors, today 10)', b.totalXp === 185 && b.level.level === X.levelFor(185).level, String(b.totalXp));
  ok('the streak counts (yesterday active, today active)', b.streak.current === 2 && b.streak.activeToday === true);
  const high = Q.questBoard({ floors, sessions: [], days: [], today: TODAY, xp: X, highXp: 999 });
  ok('XP never drops: a higher stored total wins (highWater)', high.totalXp === 999 && high.level.level === X.levelFor(999).level);
  const all = Q.questBoard({ floors: floors.map((f) => Object.assign({}, f, { met: true })), workout: true, sessions: [], days: [], today: TODAY, xp: X });
  ok('everything done: allDone and the bonus', all.allDone === true && all.bonus === true && all.doneCount === 4);
  ok('no floors configured: just the workout quest, no bonus', Q.questBoard({ floors: [], sessions: [], days: [], today: TODAY, xp: X }).quests.map((q) => q.id).join() === 'workout');
  ok('no xp module: still a board with default XP values, level 1', (() => { const n = Q.questBoard({ floors, sessions: [], days: [] }); return n.quests.length === 4 && n.level.level === 1 && n.quests[3].xp === 100; })());
  ok('no input at all does not throw', Q.questBoard().quests.length === 1 && Q.questBoard(null).level.level === 1);
  const days = Q.daysFrom([{ dk: '2026-10-24', data: { 'floormet-sleep': '1', 'floormet-task': '1' } }, { dk: 'bad', data: {} }, { dk: TODAY, data: { 'floormet-sleep': '1' } }], floors);
  ok('daysFrom reads floormet-<id> flags per page, skips a page with no date', days.length === 2 && days[0].met === 2 && days[0].total === 2 && days[1].met === 1);
}

console.log('\n1b. the skill tree');
{
  const s = (date, ids) => ({ id: 's' + date + ids.join(''), date, split: 'push', startedAt: 1, finishedAt: 2, exercises: ids.map((exId, i) => ({ exId, name: exId.toUpperCase(), slot: i, sets: [{ weight: 100, reps: 5, done: true }] })) });
  const hist = ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-09'].map((d) => s(d, ['bench', 'squat'])).concat([s('2026-10-11', ['curl'])]);
  const tree = Q.skillTree(hist, [{ id: 'bench', name: 'Bench' }, { id: 'row', name: 'Row' }, { id: 'ohp', name: 'Press' }, { id: 'dl', name: 'Deadlift' }], 2);
  ok('five sessions master a lift, one unlocks it; most-trained first', tree.nodes.slice(0, 3).map((n) => n.exId + ':' + n.tier).join() === 'bench:mastered,squat:mastered,curl:unlocked');
  ok('library lifts never logged show as locked, capped', tree.nodes.filter((n) => n.tier === 'locked').map((n) => n.exId).join() === 'row,ohp' && tree.unlocked === 3 && tree.mastered === 2);
  ok('a session with only warm-ups or undone sets does not count', Q.skillTree([{ id: 'x', date: '2026-10-01', finishedAt: 2, exercises: [{ exId: 'bench', name: 'B', sets: [{ weight: 100, reps: 5, warm: true }, { weight: 100, reps: 5, done: false }] }] }]).nodes.length === 0);
  ok('a lift twice in one session counts once', Q.skillTree([{ id: 'x', date: '2026-10-01', finishedAt: 2, exercises: [{ exId: 'bench', name: 'B', sets: [{ weight: 100, reps: 5 }] }, { exId: 'bench', name: 'B', sets: [{ weight: 100, reps: 5 }] }] }]).nodes[0].sessions === 1);
  ok('no sessions, no library: empty tree, no throw', Q.skillTree().nodes.length === 0 && Q.skillTree(null, null).unlocked === 0);
}

console.log('\n2. the board markup');
{
  const sandbox = { window: { NBDQuest: Q }, document: { addEventListener() {} }, localStorage: { _s: {}, getItem(k) { return this._s[k] == null ? null : this._s[k]; }, setItem(k, v) { this._s[k] = String(v); } }, console };
  vm.createContext(sandbox);
  vm.runInContext(UI, sandbox);
  const html = (o) => sandbox.window.NBDQuestUI.html(o);
  const h = html({ floors, workout: false, sessions: [sess('2026-10-24', 6)], days: [{ date: '2026-10-24', met: 2, total: 2 }], today: TODAY, xp: X });
  ok('level badge, XP bar as a 5%-step class with progressbar semantics, the XP count', /class="qb-lv">Lv \d/.test(h) && /role="progressbar"[^>]*aria-valuenow="\d+"><i class="qb-w(\d|[1-9]\d|100)"><\/i>/.test(h) && /\d+ \/ \d+ XP/.test(h));
  ok('a floor quest is a button with the toggle-floor action app.js already handles', /<button type="button" class="qb-q done floor" data-action="toggle-floor" data-floor-id="sleep" aria-pressed="true">/.test(h) && /class="qb-q floor" data-action="toggle-floor" data-floor-id="task" aria-pressed="false"/.test(h));
  ok('the bonus row is not a button; the open workout quest carries data-quest="workout"', /<div class="qb-q bonus">/.test(h) && /class="qb-q workout" data-quest="workout"/.test(h));
  ok('streak and today XP lines', /🔥 1-day streak/.test(h) && /\+0 XP today/.test(h));
  ok('"3 quests left today" (one of four done)', /3 quests left today/.test(h));
  ok('the skill tree is a folded <details> under the board, naming the unlocked lift', /<details class="qb-tree"><summary>Skill tree · 1 lift unlocked<\/summary>/.test(h) && /<span class="qb-node unlocked" title="1 session">Bench<\/span>/.test(h));
  ok('no inline style attribute', !/style="/.test(h));
  ok('the high-water mark is written to storage', Number(sandbox.localStorage._s.nbd_ds_xp_high) > 0);
  const evil = html({ floors: [{ id: 'x', label: '<img src=x onerror=1>', met: false }], sessions: [], days: [], today: TODAY, xp: X });
  ok('floor labels are escaped', !/<img src=x/.test(evil) && /&lt;img/.test(evil));
  ok('all done: the cleared line', /Quest board cleared/.test(html({ floors: [{ id: 'a', label: 'A', met: true }], workout: true, sessions: [], days: [], today: TODAY, xp: X })));
}

console.log('\n3. wiring');
{
  ok('Quest is ready to pick; Classic still the default', L.byId('quest').ready === true && L.DEFAULT === 'classic' && L.normLayout('quest') === 'quest');
  ok('updateTodayBar renders the board only in the Quest layout and toggles the class', /quest=ui==='quest'/.test(APP) && /bar\.classList\.toggle\('today-quest',quest\)/.test(APP) && /if\(quest&&window\.NBDQuestUI&&window\.NBDQuest\)/.test(APP));
  ok('it hands the board the floors with their met flags, the workout, the sessions, the day rows from the pages, and the real xp / coach modules', /floors:fl\.map\(f=>\(\{id:f\.id,label:f\.label,met:pd\['floormet-'\+f\.id\]==='1'\}\)\),workout:s\.workout,sessions:sessions,days:NBDQuest\.daysFrom\(pages,fl\),today:todayKey\(\),xp:window\.NBDXp,coach:window\.NBDCoach/.test(APP));
  ok('quest-logic and quest-ui load deferred, after xp-logic', ['quest-logic.js', 'quest-ui.js'].every((f) => new RegExp('<script src="/pro/daily-success/js/' + f.replace('.', '\\.') + '\\?v=\\d+" defer></script>').test(INDEX)) && INDEX.indexOf('xp-logic.js') < INDEX.indexOf('quest-ui.js'));
  const qb = CSS.slice(CSS.indexOf('Quest:'), CSS.indexOf('Cockpit:'));
  const rules = qb.split('\n').flatMap((l) => l.split('} ')).filter((l) => /\{/.test(l));
  ok('every Quest rule is scoped to [data-ui="quest"] (Classic can never be restyled)', rules.length >= 20 && rules.every((l) => /^\[data-ui="quest"\]/.test(l.trim())), rules.filter((l) => !/^\[data-ui="quest"\]/.test(l.trim())).join(' | '));
  ok('quest rows are 44 px tall (gym thumbs), the board is static', /\.qb-q \{[^}]*min-height: 44px/.test(qb) && /today-quest \{ position: static;/.test(qb));
  ok('the 21 width classes exist (0 to 100 by 5)', Array.from({ length: 21 }, (_, i) => i * 5).every((w) => new RegExp('\\.qb-w' + w + ' \\{ width: ' + w + '%; \\}').test(qb)));
  ok('no font under 11 px', !/font-size: (10|9|8)px/.test(qb));
  ok('layouts.css cache version bumped', /layouts\.css\?v=\d+/.test(INDEX));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
