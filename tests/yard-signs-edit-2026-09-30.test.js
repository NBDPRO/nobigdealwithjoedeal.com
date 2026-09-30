/**
 * tests/yard-signs-edit-2026-09-30.test.js
 *
 * Jo's live-CRM handoff (2026-09-30) #6, the pure-rules half. The sheet
 * itself (edit, GPS only on a tap, the save/redraw split, remove) is
 * exercised in a real browser by tests/e2e/yard-signs-edit.spec.js.
 *
 *  - A sign logged for a FUTURE day is 'scheduled' (derived from placedAt;
 *    status stays 'out' so the rules and the server pickup push are untouched)
 *    and becomes an ordinary 'out' sign on the morning it goes in the yard.
 *  - A removed sign (deleted: true) is skipped by the summary, the pickup
 *    route and lead crediting.
 *
 * Run: node tests/yard-signs-edit-2026-09-30.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const L = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'yard-signs-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const D = (y, m, d, h) => new Date(y, m - 1, d, h || 9).getTime();

console.log('\n1. a sign logged ahead of time (Emily & Caesar: out Fri Oct 2)');
const goesOut = D(2026, 10, 2, 9);
const sched = { placedAt: goesOut, dueAt: L.dueFrom(goesOut, 14), status: 'out' };
ok('the day before, it is scheduled', L.statusOf(sched, D(2026, 10, 1, 18)) === 'scheduled');
ok('…and says when it goes out', L.dueText(sched, D(2026, 10, 1, 18)) === 'Goes out tomorrow', L.dueText(sched, D(2026, 10, 1, 18)));
ok('two days before: "Goes out in 2 days"', L.dueText(sched, D(2026, 9, 30, 12)) === 'Goes out in 2 days', L.dueText(sched, D(2026, 9, 30, 12)));
ok('on the morning it goes out (even before 9 am) it is an ordinary sign', L.statusOf(sched, D(2026, 10, 2, 6)) === 'out');
ok('a scheduled sign is never overdue or on the pickup route', L.pickupList([sched], D(2026, 10, 1)).length === 0);
ok('it has its own colour and label', L.COLOR.scheduled && L.LABEL.scheduled === 'Scheduled');
ok('a sign placed today is not scheduled', L.statusOf({ placedAt: D(2026, 9, 30, 16), dueAt: L.dueFrom(D(2026, 9, 30), 14), status: 'out' }, D(2026, 9, 30, 8)) === 'out');
ok('a sign with no placedAt keeps the old behaviour', L.statusOf({ dueAt: D(2026, 10, 20), status: 'out' }, D(2026, 10, 1)) === 'out');
ok('picked up / missing still win over a future placedAt', L.statusOf(Object.assign({}, sched, { status: 'picked_up' }), D(2026, 9, 30)) === 'picked_up');

console.log('\n2. summary');
const now = D(2026, 10, 1, 12);
const outSign = { placedAt: D(2026, 9, 20), dueAt: D(2026, 10, 4), status: 'out' };
const dueToday = { placedAt: D(2026, 9, 17), dueAt: D(2026, 10, 1), status: 'out' };
const removed = { placedAt: D(2026, 9, 17), dueAt: D(2026, 9, 25), status: 'out', deleted: true };
const sum = L.summary([sched, outSign, dueToday, removed], now);
ok('scheduled counted on its own, not as "out"', sum.scheduled === 1 && sum.out === 2, JSON.stringify(sum));
ok('a removed sign counts nowhere (it would have been overdue)', sum.overdue === 0 && sum.out === 2, JSON.stringify(sum));

console.log('\n3. pickup route and lead credit skip removed signs');
ok('a removed overdue sign is not on the route', L.pickupList([removed, dueToday], now).length === 1);
const signs = [
  { id: 'gone', lat: 39.105, lng: -84.505, placedAt: D(2026, 9, 20), status: 'out', deleted: true },
  { id: 'real', lat: 39.2, lng: -84.6, placedAt: D(2026, 9, 20), status: 'out' },
];
const lead = { lat: 39.106, lng: -84.506, createdAt: D(2026, 9, 25) };
ok('the nearest REMOVED sign gets no credit', L.attributeLead(lead, signs, 20).signId === 'real');
ok('a future-dated sign gets no credit for a lead that came before it went out',
  L.attributeLead({ lat: 39.1, lng: -84.5, createdAt: D(2026, 10, 1) }, [{ id: 'f', lat: 39.1, lng: -84.5, placedAt: goesOut, status: 'out' }]) === null);

console.log('\n3b. a real map pin (Jo, 2026-09-30: no markers on the map)');
ok('a sign saved with lat/lng null has NO pin (isFinite(null) is true — the bug)', L.hasPin({ lat: null, lng: null }) === false && isFinite(null) === true);
ok('a real pin is a pin', L.hasPin({ lat: 39.19, lng: -84.57 }) === true);
ok('strings, NaN and a half pin are not pins', !L.hasPin({ lat: '39', lng: '-84' }) && !L.hasPin({ lat: NaN, lng: 1 }) && !L.hasPin({ lat: 39 }) && !L.hasPin(null));
ok('distance to a no-pin sign is Infinity, not a trip to 0,0', L.haversineMi({ lat: 39, lng: -84 }, { lat: null, lng: null }) === Infinity);
ok('the pickup route ignores a no-pin start', Array.isArray(L.pickupList([], Date.now(), { lat: null, lng: null })));

console.log('\n4. every reader skips a removed sign (source wiring)');
const js = (f) => fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', f), 'utf8');
ok('the Yard Signs view loads without removed signs', /if \(!x\.deleted\) _signs\.push/.test(js('yard-signs.js')));
ok('the Home "needs you" count skips them', /s\.deleted \|\| s\.status === 'picked_up'/.test(js('home-attention.js')));
ok('the customer-page chip skips them', /!s\.deleted && lg\.statusOf/.test(js('customer-yard-sign-chip.js')));
ok('the Home widget skips removed AND not-yet-out signs', /if \(v\.deleted \|\| msOf\(v\.placedAt\) > now\) return;/.test(js('widgets.js')));
const push = fs.readFileSync(path.join(__dirname, '..', 'functions', 'push-functions.js'), 'utf8');
ok('the server pickup push already skips them and keys on status out + dueAt (no server change needed)',
  /where\('status', '==', 'out'\)/.test(push) && /if \(s\.deleted\) return;/.test(push));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
