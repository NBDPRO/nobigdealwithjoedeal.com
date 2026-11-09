/**
 * tests/nbd-os-focus-2026-11-09.test.js - NBD OS P3 knock-block focus session,
 * the pure half (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #10).
 *
 * docs/pro/js/os/focus-logic.js:
 *   - a block is 30, 60 or 90 minutes, started by hand (begin needs a uid and a length)
 *   - Do Not Disturb: the block turns it on only when it was off ('mine'), leaves it
 *     when it was on ('kept'), and at the end turns it off only if it turned it on,
 *     it is still on, and nothing else holds it ("In a home")
 *   - the record survives a reload (device-only, with the end time): parse takes
 *     only this account's whole record and drops one that ended over 12 h ago
 *   - every number on screen comes from the record's counted doors; no count,
 *     no number (never a 0 made up for a failed count)
 *   - the doors floor is the company's doorsPerDay, Mon-Sat only
 *
 * Run: node tests/nbd-os-focus-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
let F = null;
try { F = require(path.join(ROOT, 'docs/pro/js/os/focus-logic.js')); } catch (e) { F = null; }
const MIN = 60000;
// Tuesday 2026-11-10 14:00 local
const NOW = new Date(2026, 10, 10, 14, 0, 0).getTime();
const SUN = new Date(2026, 10, 15, 14, 0, 0).getTime();

console.log('\n1. starting a block: by hand, 30 / 60 / 90 only');
ok('the module loads in Node', !!F && typeof F.begin === 'function');
if (!F) { console.log('\n' + passed + ' passed, ' + (failed) + ' failed'); process.exit(1); }
ok('lengths are exactly 30, 60, 90', J(F.LENGTHS) === J([30, 60, 90]));
const r60 = F.begin({ uid: 'u1', now: NOW, mins: 60, dndOn: false, dndAvail: true });
ok('a 60-minute block ends 60 minutes after it starts', r60 && r60.start === NOW && r60.end === NOW + 60 * MIN && r60.mins === 60, J(r60));
ok('DND off before: the block turns it on (dnd mine)', r60 && r60.dnd === 'mine');
ok('DND already on: the block leaves it (dnd kept)', F.begin({ uid: 'u1', now: NOW, mins: 30, dndOn: true, dndAvail: true }).dnd === 'kept');
ok('no DND switch on this device: dnd none', F.begin({ uid: 'u1', now: NOW, mins: 90, dndOn: false, dndAvail: false }).dnd === 'none');
ok('45 minutes, 0, a string, no uid, no clock: no block', [
  { uid: 'u1', now: NOW, mins: 45 }, { uid: 'u1', now: NOW, mins: 0 }, { uid: 'u1', now: NOW, mins: '60' },
  { uid: '', now: NOW, mins: 60 }, { uid: 'u1', now: NaN, mins: 60 }, { uid: 'u1', mins: 60 }, null, undefined,
].every((e) => F.begin(e) === null));
ok('a new record holds no doors and no floor (nothing counted yet)', !('doors' in r60) && !('floor' in r60));

console.log('\n2. phases and the calm countdown');
ok('running right after the start', F.phase(r60, NOW) === 'running' && F.phase(r60, NOW + 59 * MIN) === 'running');
ok('over at the end', F.phase(r60, NOW + 60 * MIN) === 'over');
ok('no record: none', F.phase(null, NOW) === 'none');
ok('minutes left round up, never 0 while running', F.minsLeft(r60, NOW) === 60 && F.minsLeft(r60, NOW + 30 * MIN + 1) === 30
  && F.minsLeft(r60, NOW + 60 * MIN - 1) === 1 && F.minsLeft(r60, NOW + 60 * MIN) === 0);
const v0 = F.view(r60, NOW + 18 * MIN);
ok('the view counts minutes, never seconds', v0.left === '42 min left' && !/sec|:\d\d/.test(v0.left), v0.left);
ok('time used: a whole percent', v0.pct === 30, v0.pct);

console.log('\n3. ending: time up or End early');
const up = F.finish(r60, NOW + 75 * MIN);
ok('time up: ends at the planned end, not when it was noticed', up.endedAt === NOW + 60 * MIN && F.phase(up, NOW + 75 * MIN) === 'over');
const early = F.finish(r60, NOW + 38 * MIN);
ok('End early: ends now', early.endedAt === NOW + 38 * MIN && F.phase(early, NOW + 38 * MIN) === 'over');
ok('finish is idempotent', F.finish(early, NOW + 50 * MIN).endedAt === NOW + 38 * MIN);
ok('finish leaves the start record untouched', r60.endedAt === undefined);
ok('the count window: start .. planned end while it runs', J(F.span(r60)) === J({ from: NOW, to: NOW + 60 * MIN }));
ok('...start .. the early end once ended', J(F.span(early)) === J({ from: NOW, to: NOW + 38 * MIN }));

console.log('\n4. Do Not Disturb is put back the way it was');
ok('the block turned it on, it is still on: off', F.restore(r60, true, false) === 'off');
ok('the rep turned it off meanwhile: nothing to do', F.restore(r60, false, false) === 'keep');
ok('"In a home" holds it now: keep', F.restore(r60, true, true) === 'keep');
ok('it was on before the block: keep', F.restore(F.begin({ uid: 'u1', now: NOW, mins: 30, dndOn: true, dndAvail: true }), true, false) === 'keep');
ok('no switch, or restored already: keep', F.restore(Object.assign({}, r60, { dnd: 'none' }), true, false) === 'keep'
  && F.restore(Object.assign({}, r60, { dnd: 'done' }), true, false) === 'keep');
ok('no record: keep', F.restore(null, true, false) === 'keep');

console.log('\n5. reload: the device-only record resumes, this account only');
const raw = J(r60);
ok('the key is an nbd_ key (sign-out wipes it)', F.KEY === 'nbd_os_focus');
ok('a reload mid-block resumes the same block', J(F.parse(raw, 'u1', NOW + 20 * MIN)) === raw);
ok('...and its countdown carries on from the stored end', F.minsLeft(F.parse(raw, 'u1', NOW + 20 * MIN), NOW + 20 * MIN) === 40);
ok('a reload after the end: over (the summary is still due)', F.phase(F.parse(raw, 'u1', NOW + 3 * 60 * MIN), NOW + 3 * 60 * MIN) === 'over');
ok('another account: null', F.parse(raw, 'u2', NOW) === null);
ok('ended over 12 h ago: dropped', F.parse(raw, 'u1', NOW + 60 * MIN + F.KEEP_MS) === null && F.parse(raw, 'u1', NOW + 60 * MIN + F.KEEP_MS - 1) !== null);
ok('an early end 12 h ago: dropped too', F.parse(J(early), 'u1', early.endedAt + F.KEEP_MS) === null);
const bad = [
  'x', '', null, '[]', '{}', J(Object.assign({}, r60, { v: 2 })), J(Object.assign({}, r60, { mins: 45, end: NOW + 45 * MIN })),
  J(Object.assign({}, r60, { end: NOW + 61 * MIN })), J(Object.assign({}, r60, { dnd: 'yes' })),
  J(Object.assign({}, r60, { endedAt: NOW - 1 })), J(Object.assign({}, r60, { endedAt: NOW + 61 * MIN })),
  J(Object.assign({}, r60, { doors: -1 })), J(Object.assign({}, r60, { doors: 2.5 })), J(Object.assign({}, r60, { doors: '7' })),
  J(Object.assign({}, r60, { floor: 0 })), J(Object.assign({}, r60, { floor: 501 })),
];
ok('a broken record is null, never a guess', bad.every((b) => F.parse(b, 'u1', NOW + MIN) === null), bad.filter((b) => F.parse(b, 'u1', NOW + MIN) !== null));
ok('a start far in the future (a broken clock): null', F.parse(raw, 'u1', NOW - 10 * MIN) === null);
ok('unknown keys are not carried', !('note' in F.parse(J(Object.assign({}, r60, { note: '<b>' })), 'u1', NOW + MIN)));

console.log('\n6. counts only from data; nothing when unknown');
const vRun = F.view(r60, NOW + 5 * MIN);
ok('not counted yet: no doors line, no number anywhere', vRun.doors === '' && !/\d/.test(vRun.doors + vRun.floor + vRun.done));
const c7 = F.withCount(r60, 7);
ok('a counted 7 shows as 7 this block', F.view(c7, NOW + 5 * MIN).doors === '7 doors this block');
ok('one door: singular', F.view(F.withCount(r60, 1), NOW + 5 * MIN).doors === '1 door this block');
ok('a counted 0 says none yet (a real count, not a default)', F.view(F.withCount(r60, 0), NOW + 5 * MIN).doors === 'No doors yet this block');
ok('a failed count (undefined, null, NaN, -1, 2.5, "7") keeps the last count', [undefined, null, NaN, -1, 2.5, '7'].every((n) => F.withCount(c7, n).doors === 7));
ok('...and from none, still none', [undefined, null, NaN].every((n) => !('doors' in F.withCount(r60, n))));
const ended = F.finish(c7, NOW + 60 * MIN);
ok('the summary: doors in this block and how long it ran', F.view(ended, NOW + 61 * MIN).done === 'Block done: 7 doors in 60 min');
ok('ended early: the minutes it really ran', F.view(F.finish(c7, NOW + 38 * MIN), NOW + 39 * MIN).done === 'Block done: 7 doors in 38 min');
ok('the small widget\'s short forms carry the same counted numbers', J(F.view(c7, NOW + 5 * MIN).s) === J({ left: '55 min', doors: '7 doors', ran: '' })
  && J(F.view(ended, NOW + 61 * MIN).s) === J({ left: '', doors: '7 doors', ran: 'in 60 min' }) && F.view(r60, NOW + 5 * MIN).s.doors === ''
  && F.view(F.finish(r60, NOW + 60 * MIN), NOW + 61 * MIN).s.doors === 'Block done');
ok('no count at the end: no number of doors', F.view(F.finish(r60, NOW + 60 * MIN), NOW + 61 * MIN).done === 'Block done after 60 min');

console.log('\n7. the doors floor: the company goal, Mon-Sat');
ok('doorsPerDay on a Tuesday', F.floorOn({ doorsPerDay: 40 }, NOW) === 40);
ok('Sunday has no floor', F.floorOn({ doorsPerDay: 40 }, SUN) === null);
ok('no goal, 0, 501, a string: no floor', [null, {}, { doorsPerDay: 0 }, { doorsPerDay: 501 }, { doorsPerDay: '40' }, { callsPerDay: 10 }].every((g) => F.floorOn(g, NOW) === null));
const fl = F.withFloor(c7, 40);
ok('running: toward today\'s floor', F.view(fl, NOW + MIN).floor === 'Toward today\'s floor of 40 doors');
ok('summary: today\'s floor', F.view(F.finish(fl, NOW + 60 * MIN), NOW + 61 * MIN).floor === 'Today\'s floor is 40 doors');
ok('no floor: no floor line', F.view(c7, NOW + MIN).floor === '' && !('floor' in F.withFloor(fl, null)));

console.log('\n8. the block count reuses Daily Success\'s doors path (os/ds-business.js countKnocks)');
const vm = require('vm');
async function countCase() {
  const log = { count: [] };
  class TS { constructor(ms) { this.ms = ms; } static fromDate(d) { return new TS(d.getTime()); } }
  const W = { Date, Promise, JSON, Math, console, db: { db: 1 },
    collection: (db, name) => ({ coll: name }), where: (f, op, v) => ({ f, op, v: v instanceof TS ? v.ms : v }), query: (c, ...w) => ({ c, w }),
    CustomEvent: function (t) { this.type = t; }, dispatchEvent: () => true };
  W.window = W;
  vm.createContext(W);
  vm.runInContext(read('docs/pro/js/os/ds-business.js'), W, { filename: 'ds-business.js' });
  const B = W.NBDOSDsBiz;
  if (!B || typeof B.countKnocks !== 'function') return { B: null };
  let answer = 7;
  B.fsImport = () => Promise.resolve({ Timestamp: TS, getCountFromServer: (q) => { log.count.push(q);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ data: () => ({ count: answer }) }); } });
  const n = await B.countKnocks('u1', NOW, NOW + 60 * MIN);
  answer = new Error('offline');
  const fail = await B.countKnocks('u1', NOW, NOW + 60 * MIN);
  answer = 2.5;
  const junk = await B.countKnocks('u1', NOW, NOW + 60 * MIN);
  const none = await B.countKnocks('', NOW, NOW + MIN);
  return { B, log, n, fail, junk, none };
}

(async () => {
  const c = await countCase();
  ok('ds-business exports countKnocks', !!c.B);
  if (c.B) {
    ok('one count: the rep\'s own knocks in the block window', J(c.log.count[0]) === J({ c: { coll: 'knocks' }, w: [
      { f: 'userId', op: '==', v: 'u1' }, { f: 'createdAt', op: '>=', v: NOW }, { f: 'createdAt', op: '<', v: NOW + 60 * MIN }] }), J(c.log.count[0]));
    ok('a whole count comes back', c.n === 7);
    ok('a failed or junk count is undefined (not counted), never 0', c.fail === undefined && c.junk === undefined);
    ok('no uid: no query at all', c.none === undefined && c.log.count.length === 3);
  }
  const d2d = read('docs/pro/js/d2d-tracker-core-2026b.js');
  ok('the D2D tracker says when a knock was saved or removed (nbd:knocks-changed), no other write', (d2d.match(/dispatchEvent\(new CustomEvent\('nbd:knocks-changed'\)\)/g) || []).length === 3,
    (d2d.match(/nbd:knocks-changed/g) || []).length);

  console.log('\n9. the source: pure');
const SRC = read('docs/pro/js/os/focus-logic.js');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok('no DOM, storage, network or clock of its own', !/document|localStorage|fetch\(|getDoc|getCount|Date\.now|setTimeout|setInterval/.test(code));
ok('dashboard.html has no focus script tag', !/os\/focus/.test(read('docs/pro/dashboard.html')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ threw: ' + (e && e.stack)); process.exit(1); });
