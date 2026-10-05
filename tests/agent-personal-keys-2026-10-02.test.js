#!/usr/bin/env node
/**
 * Jo's operating system, Build 3 (2026-10-02): personal-scope bot keys.
 * The Coach and Finance Board bots read ONLY the key owner's own tracker
 * (userSettings/{uid}.dsSnapshot / dsReviews, published by the tracker) and
 * can never reach a CRM tool; CRM keys can never reach a personal tool.
 *
 * Run: node tests/agent-personal-keys-2026-10-02.test.js
 *      (section E runs against the Firestore emulator when FIRESTORE_EMULATOR_HOST is set)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
const R = require(path.join(ROOT, 'docs/pro/daily-success/js/review-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

(async () => {
  console.log('A. the wall between personal and CRM');
  const personalBots = Object.keys(L.BOTS).filter(L.isPersonalBot);
  const crmBots = Object.keys(L.BOTS).filter((b) => !L.isPersonalBot(b));
  ok('two personal bots: Coach and Finance Board', personalBots.sort().join() === 'board,coach');
  ok('personal bots list ONLY personal tools', personalBots.every((b) => L.BOTS[b].tools.length && L.BOTS[b].tools.every(L.isPersonalTool)));
  ok('no CRM bot lists a personal tool', crmBots.every((b) => !L.BOTS[b].tools.some(L.isPersonalTool)));
  ok('no personal tool files, sends or changes anything', L.PERSONAL_TOOLS.every((t) => /^my_/.test(t)) && !L.PERSONAL_TOOLS.some((t) => /file|send|verify|set|delete/.test(t)));
  ok('Nova still has no entry', !L.BOTS.nova);
  const init = L.initializeResult({}, 'coach');
  ok('a personal bot is told it reads only Jo\'s own tracker', /personal tracker/.test(init.instructions) && /nothing from the business CRM/.test(init.instructions));

  console.log('B. what a bot sees (trimmed from the published snapshot)');
  const NOW = Date.parse('2026-10-04T14:00:00Z');
  const F = [{ id: 'f1', label: 'Workout done' }, { id: 'f2', label: 'Protein hit' }];
  const week = { from: '2026-09-27', to: '2026-10-03', pct: 86, fullDays: 5, misses: 2, missTaxCents: 1000, rows: [{ label: 'Workout done', hit: 6, of: 7 }, { label: 'Protein hit', hit: 6, of: 7 }] };
  const snap = R.snapshotDoc({ floors: F, byDayToday: new Set(['f1']), todayDk: '2026-10-04', streak: { count: 9, warned: true, broken: false },
    week, trend: { latest: 238.4, avg7: 238.9, change7: -0.7 }, rule: { verdict: 'on-track', text: 'Down 0.7 lb on the week. Keep the plan.' },
    goal: { now: 238.9, goal: 220, left: 18.9 }, scorecard: 'WEEKLY SCORECARD 2026-09-27 → 2026-10-03' }, NOW - 2 * 3600000);
  ok('snapshot: today\'s floors met/open, not all met', snap.today.floors.map((f) => f.met).join() === 'true,false' && snap.today.allMet === false);
  const snap2 = R.snapshotDoc({ floors: F, byDayToday: new Set(['f1']), todayDk: '2026-10-04', streak: { count: 9, warned: true }, week, trend: { latest: 238.4, avg7: 238.9, change7: -0.7 }, rule: { verdict: 'on-track', text: 'Down 0.7 lb on the week. Keep the plan.' }, goal: { now: 238.9, goal: 220, left: 18.9 }, scorecard: 'WEEKLY SCORECARD 2026-09-27 → 2026-10-03' }, NOW);
  ok('the change signature ignores the timestamp (no re-write when nothing changed)', snap.sig === snap2.sig && snap.asOf !== snap2.asOf);
  const today = L.personalToday(snap, NOW);
  ok('my_today: floors, streak with the missed-yesterday warning, weight, age', today.floors.length === 2 && today.streak.days === 9 && today.streak.missed_yesterday === true && today.weight.latest === 238.4 && today.as_of_hours_ago === 2, JSON.stringify(today));
  const wk = L.personalWeek(snap, NOW);
  ok('my_week: floors out of 7, $ miss tax, weigh-in rule, goal, scorecard', wk.floors_pct === 86 && wk.miss_tax_dollars === 10 && wk.weigh_in.verdict === 'on-track' && wk.goal.to_go === 18.9 && /WEEKLY SCORECARD/.test(wk.scorecard), JSON.stringify(wk));
  ok('nothing published yet → says to open the tracker, no invented numbers', /has not published/.test(L.personalToday(undefined, NOW).note) && /has not published/.test(L.personalWeek({}, NOW).note));
  const evil = L.personalWeek(Object.assign({}, snap, { scorecard: 'x'.repeat(9000), week: Object.assign({}, week, { rows: [{ label: 'y'.repeat(500), hit: 1, of: 7 }] }), secret: 'leak' }), NOW);
  ok('strings are capped and unknown fields dropped', evil.scorecard.length === 2500 && evil.floors[0].floor.length === 60 && !JSON.stringify(evil).includes('leak'));
  const reviews = { weeks: { '2026-09-27': { pct: 71, missTaxCents: 2000, taxMoved: false, lastDone: false, kept: 'Lifted 5 days', bailed: 'Skipped steps', scary: 'Call the bank', scaryDue: '2026-10-03' },
    '2026-10-04': { pct: 86, missTaxCents: 1000, taxMoved: true, scary: 'Cancel 2 subscriptions', scaryDue: '2026-10-10' }, bogus: { pct: 1 } } };
  const rv = L.personalReviews(reviews, 4);
  ok('my_reviews: newest first, dollars, moved/not, last hard thing, bogus keys skipped', rv.length === 2 && rv[0].week_ending === '2026-10-04' && rv[0].moved_to_savings === true && rv[1].miss_tax_dollars === 20 && rv[1].last_hard_thing_done === false && rv[1].bailed === 'Skipped steps', JSON.stringify(rv));

  console.log('C. server wiring');
  const srv = read('functions/agent-mcp.js');
  ok('a personal bot\'s key must be a personal key with an owner (and a CRM bot\'s must not be)', /L\.isPersonalBot\(k\.botId\) !== \(k\.scope === 'personal'\) \|\| \(k\.scope === 'personal' && !k\.ownerUid\)/.test(srv));
  ok('every call from a personal key enters the personal branch (no CRM fall-through)', /if \(L\.isPersonalTool\(name\) \|\| key\.scope === 'personal'\) \{/.test(srv));
  ok('personal tools read only userSettings/{ownerUid}; a mismatch is refused (second lock)', /if \(key\.scope !== 'personal' \|\| !key\.ownerUid \|\| !L\.isPersonalTool\(name\)\) return L\.toolErr/.test(srv) && /collection\('userSettings'\)\.doc\(key\.ownerUid\)/.test(srv));
  ok('a personal key is made by the signed-in person for themselves', /if \(personal\) Object\.assign\(doc, \{ scope: 'personal', ownerUid: uid \}\)/.test(srv) && /uid = request\.auth\.uid/.test(srv));
  ok('someone else\'s personal keys are never listed or revocable', /k\.scope !== 'personal' \|\| k\.ownerUid === uid/.test(srv) && /scope === 'personal' && s\.data\(\)\.ownerUid !== uid/.test(srv));
  const sync = read('docs/pro/daily-success/ds-firebase-sync.js');
  ok('the tracker publishes its snapshot through the userSettings sync', /\{ key: 'nbd_ds_snapshot', field: 'dsSnapshot' \}/.test(sync));
  const ui = read('docs/pro/daily-success/js/review-ui.js');
  ok('the dashboard paint publishes, skipping unchanged snapshots', /paintGoalBars\(box\);\s*publish\(\);/.test(ui) && /prev\.sig === doc\.sig/.test(ui));
  // Bot keys moved from the Agent inbox to Settings → Bots & API (2026-10-04).
  const botsUi = read('docs/pro/js/agent-bots-settings.js');
  ok('the Bots & API page puts personal bots in their own section', /Personal — reads only your own Daily tracker, never the CRM/.test(botsUi) && /const personal = \(d\.bots \|\| \[\]\)\.filter\(\(b\) => b\.personal\);/.test(botsUi));

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log('E. emulator end to end');
    const ranBefore = passed + failed;
    const { initializeApp, getApps } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
    if (!getApps().length) initializeApp({ projectId: 'nbd-test' });
    const { getFirestore } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
    const db = getFirestore();
    const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'))._internal;
    const JO = 'jo-uid-personal', OTHER = 'someone-else-uid';
    await db.doc('userSettings/' + JO).set({ dsSnapshot: snap, dsReviews: reviews });
    await db.doc('userSettings/' + OTHER).set({ dsSnapshot: Object.assign({}, snap, { scorecard: 'OTHER PERSON SCORECARD' }) });
    await db.doc('leads/pL1').set({ companyId: JO, userId: JO, firstName: 'Maria', stage: 'new', followUp: '2020-01-01' });
    const coach = { id: 'k-coach', botId: 'coach', companyId: JO, scope: 'personal', ownerUid: JO };
    const call = (key, name, args) => M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }, key);
    const listed = await M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, coach);
    ok('Coach lists only my_today, my_week, my_reviews', listed.result.tools.map((t) => t.name).join() === 'my_today,my_week,my_reviews');
    const wkRes = JSON.parse((await call(coach, 'my_week')).result.content[0].text);
    ok('Coach reads ITS owner\'s week (not someone else\'s)', /WEEKLY SCORECARD/.test(wkRes.scorecard) && !/OTHER PERSON/.test(wkRes.scorecard));
    const rvRes = JSON.parse((await call(coach, 'my_reviews', { limit: 1 })).result.content[0].text);
    ok('Coach reads the latest review', rvRes.reviews.length === 1 && rvRes.reviews[0].hard_thing === 'Cancel 2 subscriptions');
    const crm = (await call(coach, 'overdue_followups')).result;
    ok('Coach calling a CRM tool is refused', crm.isError === true);
    const forged = (await M.runTool('overdue_followups', {}, coach));
    ok('even past the role check, a personal key cannot run a CRM tool', forged.isError === true && /cannot use that tool/.test(forged.content[0].text));
    const marcus = { id: 'k-m', botId: 'marcus', companyId: JO, scope: 'crm', ownerUid: null };
    const reach = (await call(marcus, 'my_week')).result;
    const reach2 = await M.runTool('my_week', {}, marcus);
    ok('a CRM key cannot read Jo\'s tracker (role check AND second lock)', reach.isError === true && reach2.isError === true);
    const noOwner = await M.runTool('my_week', {}, { id: 'x', botId: 'coach', companyId: JO, scope: 'personal', ownerUid: null });
    ok('a personal key without an owner reads nothing', noOwner.isError === true);
    // CI runs this suite in the emulator-orphan-suites job (ci.yml), which sets
    // NBD_REQUIRE_EMULATOR=1: there the section must run in full, never shrink.
    const ran = passed + failed - ranBefore;
    console.log('E. emulator section ran ' + ran + ' checks');
    if (process.env.NBD_REQUIRE_EMULATOR) ok('E. all 7 end-to-end checks ran', ran === 7, 'ran ' + ran);
  } else if (process.env.NBD_REQUIRE_EMULATOR) {
    // Fail, never skip, where CI promised an emulator (R1-10-8, 2026-10-05:
    // this section printed "skipped" in every CI run until then).
    ok('E. NBD_REQUIRE_EMULATOR is set but FIRESTORE_EMULATOR_HOST is not — the end-to-end section cannot run', false);
  } else {
    console.log('E. (skipped — no FIRESTORE_EMULATOR_HOST)');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
