/**
 * tests/game-xp-2026-10-03.test.js — the optional game card's XP
 * (functions/game-logic.js, functions/game.js getGameCard).
 *
 * XP must come only from real work already in the records, capped where it
 * could be farmed, and money only when COLLECTED (Jo's revenue rule).
 *
 * Run: node tests/game-xp-2026-10-03.test.js
 */
'use strict';

const path = require('path');
const G = require(path.join(__dirname, '..', 'functions', 'game-logic.js'));
const { paymentsOf } = require(path.join(__dirname, '..', 'functions', 'agent-mcp-logic.js'));
const { gameCard } = require(path.join(__dirname, '..', 'functions', 'game.js'))._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// Saturday 2026-10-03 10:00 ET → this week starts Mon 09-28, last week 09-21.
const NOW = Date.parse('2026-10-03T14:00:00Z');
const at = (iso) => Date.parse(iso);
const UID = 'u1';

console.log('\n1. Levels and weeks');
ok('level thresholds: 0 → L1, 100 → L2, 300 → L3, 299 → L2', G.levelFor(0).level === 1 && G.levelFor(100).level === 2 && G.levelFor(300).level === 3 && G.levelFor(299).level === 2);
ok('progress bounds for the bar', G.levelFor(150).floor === 100 && G.levelFor(150).next === 300);
ok('titles climb and stop at the last one', G.levelFor(0).title === 'Apprentice' && G.levelFor(1e9).title === 'Legend');
const wb = G.weekBounds(NOW);
ok('week starts Monday in Eastern time', wb.thisStart === '2026-09-28' && wb.lastStart === '2026-09-21' && wb.today === '2026-10-03', JSON.stringify(wb));
ok('a Monday is its own week start', G.weekBounds(Date.parse('2026-09-28T13:00:00Z')).thisStart === '2026-09-28');
ok('Sunday night ET still belongs to that week', G.weekBounds(Date.parse('2026-10-05T02:00:00Z')).thisStart === '2026-09-28');

console.log('\n2. What earns XP (real work only)');
const records = {
  uid: UID, nowMs: NOW, paymentsOf,
  tasks: [
    { id: 't1', done: true, completedAt: at('2026-09-30T15:00:00Z') },                          // this week: 10
    { id: 'cube-c1', done: true, completedAt: at('2026-10-01T15:00:00Z'), source: 'cube-acr' },  // this week: 10 + promise 5
    { id: 't3', done: false, completedAt: null },                                                // open: 0
    { id: 't4', done: true, completedAt: at('2026-09-23T15:00:00Z') },                           // last week: 10
  ],
  calls: Array.from({ length: 15 }, (_, i) => ({ handledAtMs: at('2026-10-02T16:00:00Z') + i, handledBy: UID }))   // 15 × 3 = 45 → capped 30
    .concat([{ attachedAtMs: at('2026-10-02T17:00:00Z'), attachedBy: UID }, { handledAtMs: at('2026-10-02T18:00:00Z'), handledBy: 'someone-else' }]),
  leads: [
    { createdAt: at('2026-09-29T15:00:00Z'), phone: '5135550100' },                              // 10
    { createdAt: at('2026-09-29T15:01:00Z') },                                                   // no phone/address → 0
    { createdAt: at('2026-09-29T15:02:00Z'), phone: '1', deleted: true },                        // deleted → 0
    { createdAt: at('2026-08-01T15:00:00Z'), address: '1 Elm', reviewRequested: true, reviewRequestedAt: at('2026-10-01T12:00:00Z'), stageRole: 'won', stageStartedAt: at('2026-09-30T12:00:00Z') }, // review 15 + won 50 this week
  ],
  invoices: [
    { total: 1000, balanceDue: 0, payments: [{ amount: 650, at: at('2026-09-29T15:00:00Z') }, { amount: 350, at: at('2026-09-22T15:00:00Z') }] },
    { total: 500, balanceDue: 500, payments: [] },                                               // nothing collected → 0
  ],
};
const card = G.buildCard(records);
const k = Object.fromEntries(card.breakdown.map((b) => [b.kind, b]));
ok('a ticked follow-up is 10; an open one is nothing', k.task && k.task.count === 2 && k.task.xp === 20);
ok('a ticked call/text task also counts as a promise kept (+5)', k.promise && k.promise.count === 1 && k.promise.xp === 5);
ok('marking calls handled is capped per day (15 handled → 30, not 45)', k.handled && k.handled.xp === 30, JSON.stringify(k.handled));
ok('someone else\'s handled call earns you nothing', k.handled.count === 15);
ok('filing a call on a customer is 10', k.filed && k.filed.xp === 10);
ok('a lead counts only when it has a phone or address, and not when deleted', k.lead && k.lead.count === 1 && k.lead.xp === 10);
ok('a review ask is 15, a job won is 50', k.review.xp === 15 && k.won.xp === 50);
ok('money: 1 XP per $100 COLLECTED, by payment date ($650 this week → 6)', k.collected && k.collected.xp === 6 && k.collected.count === 650, JSON.stringify(k.collected));
ok('this week totals the breakdown', card.week.xp === card.breakdown.reduce((s, b) => s + b.xp, 0) && card.week.xp === 20 + 5 + 30 + 10 + 10 + 15 + 50 + 6);
ok('last week is scored on its own (task 10 + $350 → 3)', card.lastWeek.xp === 13, String(card.lastWeek.xp));
// All time = 3 tasks 30 + promise 5 + handled 30 + filed 10 + 2 real leads
// (one from August) 20 + review 15 + won 50 + $1,000 collected 10 = 170.
ok('all-time XP counts everything to date (incl. an August lead), level from it', card.totalXp === 170 && card.level === G.levelFor(170).level && card.level === 2, String(card.totalXp));
const refund = G.buildCard(Object.assign({}, records, { tasks: [], calls: [], leads: [], invoices: [{ total: 1000, balanceDue: 0, payments: [{ amount: 1000, at: at('2026-09-29T15:00:00Z') }], refunds: [{ amount: 1000, at: at('2026-09-30T15:00:00Z') }] }] }));
ok('a refund takes the money back (net $0 → 0 XP)', refund.week.xp === 0);
ok('nothing done → a level-1 card with zeros, not an error', G.buildCard({ uid: UID, nowMs: NOW, paymentsOf }).totalXp === 0 && G.buildCard({ uid: UID, nowMs: NOW, paymentsOf }).level === 1);

console.log('\n3. getGameCard — the caller\'s own records, read-only');
function fakeDb(seed, { cgFails } = {}) {
  const q = (rows) => ({ where: (f, _o, v) => q(rows.filter((r) => r[f] === v)), limit: () => q(rows), get: async () => ({ forEach: (fn) => rows.forEach((r) => fn({ id: r.id || 'x', data: () => r })) }) });
  return {
    collectionGroup: (n) => { if (cgFails) return { where: () => ({ limit: () => ({ get: async () => { const e = new Error('FAILED_PRECONDITION: index'); e.code = 9; throw e; } }) }) }; return q(seed[n] || []); },
    collection: (n) => q(seed[n] || []),
  };
}
(async () => {
  const seed = {
    tasks: [{ id: 'a', userId: UID, done: true, completedAt: at('2026-09-30T15:00:00Z') }, { id: 'b', userId: 'other', done: true, completedAt: at('2026-09-30T15:00:00Z') }],
    phone_calls: [], phone_text_days: [], leads: [{ userId: 'other', createdAt: at('2026-09-29T15:00:00Z'), phone: '1' }], invoices: [],
  };
  let err = null;
  try { await gameCard({ db: fakeDb(seed), auth: null, nowMs: NOW }); } catch (e) { err = e; }
  ok('signed out → unauthenticated', err && err.code === 'unauthenticated');
  const c = await gameCard({ db: fakeDb(seed), auth: { uid: UID, token: {} }, nowMs: NOW });
  ok('only the caller\'s own records count', c.week.xp === 10 && c.breakdown.length === 1, JSON.stringify(c.breakdown));
  ok('a full read reports nothing partial', Array.isArray(c.partial) && c.partial.length === 0);
  const p = await gameCard({ db: fakeDb(seed, { cgFails: true }), auth: { uid: UID, token: {} }, nowMs: NOW });
  ok('task index not built yet → the card still comes back, marked partial', p.partial.includes('tasks') && p.week.xp === 0);

  console.log('\n4. The 32×32 avatar (game-sprite.js)');
  const fs = require('fs');
  global.window = global.window || {};
  require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'game-sprite.js'));
  const SP = global.window.NBDSprite;
  const css = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'css', 'game-card.css'), 'utf8');
  const missing = [];
  for (const [k, o] of Object.entries(SP.OPTIONS)) (o.colors || []).forEach((c, i) => {
    if (!new RegExp('\\.gc-sw-' + k + '-' + i + ' \\{ background: ' + c + '; \\}').test(css)) missing.push(k + '-' + i);
  });
  ok('every colour option has its swatch class in game-card.css (same colour)', missing.length === 0, missing.join(', '));
  const old = SP.normalize({ skin: 2, hat: 3, shirt: 1, tool: 'ladder' });
  ok('a first-version (16-px) save maps over: hat colour kept, hard hat on', old.hat === 'hardhat' && old.hatColor === 3 && old.skin === 2 && old.tool === 'ladder');
  const junk = SP.normalize({ skin: 99, hair: '<script>', eyes: 7, tool: 'chainsaw' });
  ok('unknown or out-of-range values fall back to defaults', junk.skin === SP.DEFAULTS.skin && junk.hair === SP.DEFAULTS.hair && junk.eyes === SP.DEFAULTS.eyes && junk.tool === SP.DEFAULTS.tool);
  let drawErr = null, combos = 0;
  const vals = (k) => SP.OPTIONS[k].values.map((v) => v[0]);
  try {
    for (const hair of vals('hair')) for (const hat of vals('hat')) for (const eyes of vals('eyes')) for (const extra of vals('extra')) {
      const G = SP._outline(SP._build(SP.normalize({ hair, hat, eyes, extra, beard: 'full', vest: 'yes', tool: 'ladder' })));
      if (G.length !== 32 || G.some((r) => r.length !== 32)) throw new Error('grid size');
      combos++;
    }
  } catch (e) { drawErr = e; }
  ok('every hair × headwear × eyes × extras combination builds a 32×32 sprite', !drawErr && combos === 6 * 4 * 4 * 4, drawErr && drawErr.message);
  const spiky = SP._build(SP.normalize({ hair: 'spiky', hat: 'cap', hairColor: 3 }));
  ok('a hat flattens spiky hair (no hair pixels above the cap)', [0, 1, 2].every((y) => !spiky[y].includes('#E0B45A')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
