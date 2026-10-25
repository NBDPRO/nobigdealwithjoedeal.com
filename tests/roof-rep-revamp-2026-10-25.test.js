/**
 * tests/roof-rep-revamp-2026-10-25.test.js
 *
 * Jo (2026-10-25): "seriously revamp Roof Rep." This pins the gameplay layer and the NBD-playbook content added that day:
 * the objection duel at every pitch (traps are the Kentucky rules and always lose), the quest board (three daily, one
 * weekly), the Storm Run gauntlet scoring, 28-day seasons with ranks, crew ranks and duels, and the wiring in the page.
 * Pure rules live in docs/pro/js/pages/roof-rep-rules.js.
 *
 * Run: node tests/roof-rep-revamp-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'docs', 'pro', 'js', 'pages', 'roof-rep-rules.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'pages', 'roof-rep.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'roof-rep.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'css', 'roof-rep.css'), 'utf8');
const FXS = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'pages', 'roof-rep-fx.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

console.log('\n1. the objections: one best answer each, traps are dirty and lose the door, never a winning trap');
{
  ok('a real pool (15+)', R.OBJECTIONS.length >= 15, String(R.OBJECTIONS.length));
  ok('keys are unique', new Set(R.OBJECTIONS.map((o) => o.k)).size === R.OBJECTIONS.length);
  ok('exactly one best answer per objection', R.OBJECTIONS.every((o) => o.answers.filter((a) => a.kind === 'best').length === 1));
  ok('every best answer builds trust (+10 or more) and carries a lesson tip', R.OBJECTIONS.every((o) => o.answers.filter((a) => a.kind === 'best').every((a) => a.trust >= 10 && a.tip && a.tip.good)));
  const traps = R.OBJECTIONS.flatMap((o) => o.answers.filter((a) => a.kind === 'trap'));
  ok('the Kentucky-rule traps exist (deductible, AOB/handle the claim, cash up front, permit, check sign-over, scope padding)', traps.length >= 6, String(traps.length));
  ok('every trap is dirty, loses the door and costs trust', traps.every((a) => a.dirty && a.lose && a.trust <= -25));
  ok('every trap explains itself with a bad tip', traps.every((a) => a.tip && a.tip.bad && a.tip.text.length > 30));
  ok('no trap line reads like a best answer (break test: mark one as best and the one-best rule fails)', (() => { const o = JSON.parse(JSON.stringify(R.OBJECTIONS[2])); o.answers.find((a) => a.kind === 'trap').kind = 'best'; return o.answers.filter((a) => a.kind === 'best').length !== 1; })());
  const bad = /handle your (insurance )?claim|cover(ing)? your deductible|eat (the|your) deductible|sign it over|skip (it|the permit)|pad the scope|cash and you jump/i;
  ok('the forbidden lines only ever appear on a trap or weak answer, never best or ok', R.OBJECTIONS.every((o) => o.answers.every((a) => !bad.test(a.say) || a.kind === 'trap' || a.kind === 'weak')));
  ok('weak answers cost trust but are not fraud (no dirty flag)', R.OBJECTIONS.flatMap((o) => o.answers.filter((a) => a.kind === 'weak')).every((a) => a.trust < 0 && !a.dirty && !a.lose));
  ok('every answer kind is one of best / ok / weak / trap', R.OBJECTIONS.every((o) => o.answers.every((a) => ['best', 'ok', 'weak', 'trap'].includes(a.kind))));
  const p1 = R.pickObjections(2, 42, []), p2 = R.pickObjections(2, 42, []);
  ok('a door asks the same two objections on a reload (seeded)', p1.map((o) => o.k).join() === p2.map((o) => o.k).join() && p1[0].k !== p1[1].k);
  ok('objections already asked at that door are excluded', R.pickObjections(5, 1, R.OBJECTIONS.slice(0, 14).map((o) => o.k)).every((o) => R.OBJECTIONS.slice(14).some((x) => x.k === o.k)));
  const sh = R.answersShuffled(R.OBJECTIONS[0], 3);
  ok('answers are shuffled, not always best-first', sh.length === 3 && R.OBJECTIONS.some((o, i) => R.answersShuffled(o, i + 1)[0].kind !== 'best'));
}

console.log('\n2. quests');
{
  const pool = [{ k: 'a', need: 1, text: 'A' }, { k: 'b', need: 2, text: 'B' }, { k: 'c', need: 3, text: 'C' }, { k: 'd', need: 4, text: 'D' }];
  const q = R.pickQuests(pool, 3, 99);
  ok('three distinct quests, fresh done flags', q.length === 3 && new Set(q.map((x) => x.k)).size === 3 && q.every((x) => x.done === false));
  ok('the same day picks the same three', JSON.stringify(R.pickQuests(pool, 3, 99)) === JSON.stringify(q));
  ok('another day can differ', [1, 2, 3, 4, 5, 6].some((s) => JSON.stringify(R.pickQuests(pool, 3, s)) !== JSON.stringify(q)));
  ok('a pool smaller than three still works', R.pickQuests(pool.slice(0, 2), 3, 1).length === 2);
  ok('weeks are 7 days: day 7 is week 1, day 8 week 2', R.weekFor(7) === 1 && R.weekFor(8) === 2 && R.weekFor(1) === 1);
  const w = R.pickWeekly(9, 0);
  ok('the weekly quest carries week, need, cash and xp', w.week === 2 && w.need > 0 && w.cash > 0 && w.xp > 0 && w.done === false);
  ok('weekly quests rotate by week', R.pickWeekly(1, 0).k !== R.pickWeekly(8, 0).k);
}

console.log('\n3. Storm Run scoring');
{
  ok('a perfect run (8+ best, nothing else) pays the bonus', R.runScore({ best: 8, ok: 0, weak: 0, trap: 0 }).grade === 'Perfect run' && R.runScore({ best: 8, ok: 0, weak: 0, trap: 0 }).xp === 8 * R.RUN.perBest + R.RUN.perfectBonus);
  ok('one trap spoils perfect', R.runScore({ best: 9, ok: 0, weak: 0, trap: 1 }).grade !== 'Perfect run');
  ok('three strikes is struck out, whatever else happened', R.runScore({ best: 9, ok: 2, weak: 0, trap: 3 }).grade === 'Struck out');
  ok('a rough run still returns a number, never NaN', Number.isFinite(R.runScore({ best: 0, ok: 0, weak: 0, trap: 0 }).xp));
}

console.log('\n4. seasons and the crew');
{
  ok('a season is 28 days; day 28 ends season 1, day 29 opens season 2', R.SEASON_LEN === 28 && R.seasonEndsOn(28) && !R.seasonEndsOn(27) && R.seasonOf(28) === 1 && R.seasonOf(29) === 2);
  ok('ranks climb with season XP', R.seasonRank(0) === 'Rookie' && R.seasonRank(1200) === 'Closer' && R.seasonRank(5000) === 'Storm Legend');
  const rows = [{ id: 'a', xp: 900, weekXp: 50, weekKey: 'w' }, { id: 'me', xp: 400, weekXp: 120, weekKey: 'w' }, { id: 'c', xp: 2000, weekXp: 300, weekKey: 'old' }];
  const rk = R.crewRanks(rows, 'me', 'w');
  ok('crew ranks: #1 this week (old-week XP does not count), #3 all time', rk.week === 1 && rk.all === 3 && rk.of === 3, JSON.stringify(rk));
  const d = R.duelState(rows, 'me', 'a', 'w');
  ok('a duel compares week XP and names the leader', d.me === 120 && d.them === 50 && d.lead === 'me' && !d.gone);
  ok('a duel against a rep who left the board says so', R.duelState(rows, 'me', 'zzz', 'w').gone === true);
}

console.log('\n5. wiring');
{
  ok('rules and fx load before the game, in the page', HTML.indexOf('roof-rep-rules.js') < HTML.indexOf('roof-rep-fx.js') && HTML.indexOf('roof-rep-fx.js') < HTML.indexOf('js/pages/roof-rep.js'));
  ok('the pitch runs the duel first (once per door)', /function pitchTiers\(h, sid, mTip\) \{\n  if \(!h\.dueled && h\.persona !== 'empty'\) return duel\(h, sid/.test(SRC));
  ok('a trap in the duel marks the day dirty and loses the door', /if \(a\.dirty\) DAY\.clean = false;/.test(SRC) && /if \(a\.lose\) \{ setStatus\(h, 'lost'\)/.test(SRC));
  ok('the trust meter is drawn with width classes, never an inline style', /mi\.className = 'rr-w' \+ Math\.round/.test(SRC) && !/\bstyle\s*=\s*\\?["'`]/.test(SRC));
  ok('three daily quests come from the rules module and the weekly resets with the week', /DAY\.quests = RR\.pickQuests\(chs, 3,/.test(SRC) && /SAVE\.weekly\.week !== RR\.weekFor\(SAVE\.day\)/.test(SRC));
  ok('clearing the board pays $500 and the weekly pays its cash', /SAVE\.bank \+= 500; gain\(60/.test(SRC) && /SAVE\.bank \+= w\.cash; gainAny\(w\.xp/.test(SRC));
  ok('Storm Run is on the Train tab and costs 20 minutes during a day', /id="runBtn"/.test(SRC) && /function stormRun\(\)/.test(SRC) && /if \(DAY\) spend\(20\);\n    if \(sc\.xp\) gainAny/.test(SRC));
  ok('the season card follows the day-28 summary and resets the season XP', /if \(seasonOver\) return seasonCard\(\)/.test(SRC) && /SAVE\.seasonXp = 0;/.test(SRC));
  ok('the crew board shows my week and all-time rank and offers a duel', /RR\.crewRanks\(rows, myId, wk\)/.test(SRC) && /this week · #' \+ rk\.all \+ ' all time/.test(SRC) && /SAVE\.duel = \{ id: r\.id/.test(SRC));
  ok('three new trophies: objection handler, storm runner, season finisher', /k: 'duelist'/.test(SRC) && /k: 'runner'/.test(SRC) && /k: 'season'/.test(SRC));
  ok('the HUD shows the clean-day streak', /clean streak/.test(SRC));
  ok('the look: NBD palette, no old oranges, Montserrat / Lato', /--clay: #bd5728/.test(CSS) && /--gold: #dd875f/.test(CSS) && !/#E8720C|#F08030/i.test(CSS) && /Montserrat/.test(CSS) && !/Press Start/.test(CSS));
  ok('phones: the tabs are a fixed bottom bar with safe-area padding, the stage runs edge to edge', /\.tabs \{ position: fixed; left: 0; right: 0; bottom: 0;/.test(CSS) && /env\(safe-area-inset-bottom/.test(CSS) && /\.stage \{ margin-inline: -12px;/.test(CSS));
  ok('the fx module honours reduced motion for shakes and bobs', /prefers-reduced-motion: reduce/.test(FXS) && /if \(!el \|\| reduce\) return;/.test(FXS) && /!reduce && walking/.test(FXS));
  ok('the game draws at 2x: 640x400 canvas, 320x200 logic', /width="640" height="400"/.test(HTML) && /g\.setTransform\(W\.width \/ 320, 0, 0, W\.height \/ 200, 0, 0\)/.test(SRC));
  ok('the source-of-truth note moved to the repo', /Source of truth: THIS FILE/.test(SRC) && !/generated from it/.test(SRC));
}

console.log('\n6. four homeowners from the playbook');
{
  const who = ['claimDenied', 'retiredCop', 'flipper', 'newBaby'];
  ok('each has a persona entry and a talk tree with a start node', who.every((p) => new RegExp(p + ': \\{ want:').test(SRC) && new RegExp('^  ' + p + ': \\{\\n    start: \\{', 'm').test(SRC)));
  ok('each is in at least one street pool', who.every((p) => new RegExp("pool: \\[[^\\]]*'" + p + "'").test(SRC)));
  const tree = (p) => { const at = SRC.indexOf('\n  ' + p + ': {\n    start:'); return SRC.slice(at, SRC.indexOf('\n  },', at)); };
  const dirtyLines = (p) => (tree(p).match(/\{ say: "[^"]+", end: 'lose', dirty: true/g) || []).length;
  ok('the denied-claim door: "push it through" and "make the numbers work" are dirty and lose', dirtyLines('claimDenied') === 2 && /push(ed)? (it )?through/.test(tree('claimDenied')));
  ok('the retired cop: the assignment-of-benefits line is dirty and loses; showing ID is the best line', dirtyLines('retiredCop') === 1 && /trust: 20/.test(tree('retiredCop')));
  ok('the flipper: skipping the permit and cash at the door are dirty and lose; the overlay is only weak', dirtyLines('flipper') === 2 && /overlay/i.test(tree('flipper')));
  ok('the new parent: no trap, just read the room', dirtyLines('newBaby') === 0 && /whispering/.test(tree('newBaby')));
  ok('every tree ends at the inspection', who.every((p) => /end: 'inspect'/.test(tree(p))));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
