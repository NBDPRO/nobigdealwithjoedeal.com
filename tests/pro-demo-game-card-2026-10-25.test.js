/**
 * tests/pro-demo-game-card-2026-10-25.test.js — the sample account's Home
 * game card (10-25 handoff lane 2).
 *
 *   The card is opt-in (userSettings/{uid}.game.enabled) and the sample seed
 *   never set it, so /pro/explore rendered the card hidden: the only CRM
 *   avatar picker a visitor could see was the Roof Rep locker. And the canned
 *   getGameCard answer was { ok: false }, which renderHome would have read as
 *   a card (c.week.xp on undefined) had the card ever been on.
 *
 *   1. the seed turns the card on for the sample owner, with an avatar the
 *      sprite normalizes without falling back
 *   2. the canned getGameCard is a whole card: the fields renderHome reads,
 *      a breakdown that sums to the week, a level consistent with the server's
 *      own XP ladder, and it says it is a sample
 *   3. game-card.js treats an answer without `week` as "not available", not a card
 *   4. the dashboard loads the bumped game-card.js
 *
 * Run: node tests/pro-demo-game-card-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
  console.log('\n1. the seed turns the card on');
  const seed = JSON.parse(read('docs/pro/demo-sdk/sample-company.json'));
  const us = seed.docs && seed.docs['userSettings/demo-owner'];
  ok('userSettings/demo-owner is seeded', !!us);
  ok('game.enabled is true', !!(us && us.game && us.game.enabled === true));
  {
    const w = {}; global.window = w;
    require(path.join(ROOT, 'docs/pro/js/game-sprite.js'));
    const a = us && us.game && us.game.avatar;
    const n = w.NBDSprite && a ? w.NBDSprite.normalize(a) : null;
    ok('the avatar normalizes to itself (every key is a real option)', !!n && Object.keys(a).every((k) => n[k] === a[k]), n && JSON.stringify({ a, n }));
    delete global.window;
  }
  ok('the seed script writes it (not a hand edit of the JSON)', /userSettings\/' \+ UID/.test(read('scripts/build-demo-seed.js')));

  console.log('\n2. the canned getGameCard is a whole card');
  const SDK = path.join(ROOT, 'docs/pro/demo-sdk');
  globalThis.fetch = async (u) => {
    if (String(u) === '/pro/demo-sdk/sample-company.json') return { ok: true, status: 200, json: async () => seed };
    throw new Error('unexpected fetch: ' + u);
  };
  const FN = await import(pathToFileURL(path.join(SDK, 'firebase-functions.js')).href);
  const res = await FN.httpsCallable(FN.getFunctions(), 'getGameCard')({});
  const c = res && res.data;
  const GL = require(path.join(ROOT, 'functions/game-logic.js'));
  ok('answers (no sample-account rejection)', !!c, JSON.stringify(res));
  ok('says it is a sample', !!(c && c.sample === true));
  ok('has every field renderHome reads', !!c && ['totalXp', 'level', 'title', 'levelFloor', 'levelNext'].every((k) => typeof c[k] === 'number' || typeof c[k] === 'string')
    && c.week && typeof c.week.xp === 'number' && c.lastWeek && typeof c.lastWeek.xp === 'number'
    && c.streak && typeof c.streak.current === 'number' && typeof c.streak.best === 'number' && Array.isArray(c.breakdown), c && Object.keys(c).join());
  ok('the breakdown sums to this week\'s XP', !!c && c.breakdown.reduce((s, b) => s + b.xp, 0) === c.week.xp, c && c.breakdown.map((b) => b.kind + ':' + b.xp).join());
  ok('every breakdown row is a real rule with its label', !!c && c.breakdown.every((b) => GL.RULES[b.kind] && GL.RULES[b.kind].label === b.label));
  if (c) {
    const lv = GL.levelFor(c.totalXp);
    ok('level, title, floor and next match the server\'s ladder for that XP', lv.level === c.level && lv.title === c.title && lv.floor === c.levelFloor && lv.next === c.levelNext, JSON.stringify({ lv, c: [c.level, c.title, c.levelFloor, c.levelNext] }));
    ok('this week is ahead of the ghost (the card has a story to tell)', c.week.xp > c.lastWeek.xp);
    ok('week starts are YYYY-MM-DD Mondays', /^\d{4}-\d{2}-\d{2}$/.test(c.week.start) && /^\d{4}-\d{2}-\d{2}$/.test(c.lastWeek.start) && new Date(c.week.start + 'T12:00:00Z').getUTCDay() === 1 && new Date(c.lastWeek.start + 'T12:00:00Z').getUTCDay() === 1, c.week.start + ' ' + c.lastWeek.start);
  }

  console.log('\n3. game-card.js guards a card without a week');
  const GC = read('docs/pro/js/game-card.js');
  const load = GC.slice(GC.indexOf('async function loadCard('), GC.indexOf('function drawSprite'));
  ok('loadCard keeps only an answer with week + lastWeek as the card', /week/.test(load) && /lastWeek/.test(load) && /st\.card = null/.test(load));
  ok('…and shows the answer\'s reason when it is not a card', /reason/.test(load));

  console.log('\n4. versions');
  ok('dashboard loads game-card.js?v=5', /js\/game-card\.js\?v=5/.test(read('docs/pro/dashboard.html')));
  ok('ci-manifest lists this file', read('tests/ci-manifest.json').indexOf('pro-demo-game-card-2026-10-25.test.js') !== -1);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('  failed: ' + fails.join('; ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
