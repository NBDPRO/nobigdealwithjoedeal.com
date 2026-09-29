/**
 * tests/yard-signs-2026-09-29.test.js
 *
 * The yard-sign tracker (Jo, 2026-09-29): where every sign is, a photo,
 * when it went out, and a reminder when the agreed 1–2 weeks are up. This
 * pins the pure rules in docs/pro/js/yard-signs-logic.js: due dates count
 * whole days, statuses (out / due soon / due today / overdue), the morning
 * pickup list in driving order, extensions, and crediting a yard-sign QR
 * lead to the nearest sign that was out at the time.
 *
 * Run: node tests/yard-signs-2026-09-29.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'yard-signs-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const D = (y, m, d, h) => new Date(y, m - 1, d, h || 9).getTime();
const placed = D(2026, 9, 29, 16);

console.log('\n1. due dates');
ok('2 weeks from a late-afternoon placement lands on the day, 14 days on', L.dueFrom(placed, 14) === new Date(2026, 9, 13).getTime());
ok('1 week', L.dueFrom(placed, 7) === new Date(2026, 9, 6).getTime());
ok('garbage days fall back to 2 weeks', L.dueFrom(placed, 'abc') === L.dueFrom(placed, 14));
ok('Firestore Timestamp-shaped input is read', L.dueFrom({ toMillis: () => placed }, 7) === L.dueFrom(placed, 7));

console.log('\n2. status through the life of a sign');
const sign = { placedAt: placed, dueAt: L.dueFrom(placed, 14), status: 'out' };
ok('a fresh sign is out', L.statusOf(sign, D(2026, 10, 1)) === 'out');
ok('2 days before pickup is due soon', L.statusOf(sign, D(2026, 10, 11)) === 'due_soon');
ok('pickup day is due today (all day)', L.statusOf(sign, D(2026, 10, 13, 23)) === 'due_today');
ok('the day after is overdue', L.statusOf(sign, D(2026, 10, 14, 7)) === 'overdue');
ok('a picked-up sign is never overdue', L.statusOf(Object.assign({}, sign, { status: 'picked_up' }), D(2026, 12, 1)) === 'picked_up');
ok('due text: "Pickup in 3 days"', L.dueText(sign, D(2026, 10, 10)) === 'Pickup in 3 days');
ok('due text: "2 days overdue"', L.dueText(sign, D(2026, 10, 15)) === '2 days overdue');

console.log('\n3. the morning pickup list');
const home = { lat: 39.10, lng: -84.50 };
const signs = [
  { id: 'far', lat: 39.30, lng: -84.30, dueAt: D(2026, 10, 13), status: 'out' },
  { id: 'near', lat: 39.11, lng: -84.51, dueAt: D(2026, 10, 12), status: 'out' },
  { id: 'mid', lat: 39.20, lng: -84.40, dueAt: D(2026, 10, 13), status: 'out' },
  { id: 'later', lat: 39.10, lng: -84.50, dueAt: D(2026, 10, 20), status: 'out' },
  { id: 'done', lat: 39.10, lng: -84.50, dueAt: D(2026, 10, 1), status: 'picked_up' },
];
const list = L.pickupList(signs, D(2026, 10, 13), home);
ok('only overdue + due today are on it', list.map((s) => s.id).sort().join() === 'far,mid,near');
ok('ordered as a nearest-next drive from where Jo is', list.map((s) => s.id).join() === 'near,mid,far', list.map((s) => s.id).join());
ok('without a location: oldest due first', L.pickupList(signs, D(2026, 10, 13))[0].id === 'near');
const sum = L.summary(signs, D(2026, 10, 13));
ok('summary counts', sum.out === 4 && sum.overdue === 1 && sum.dueToday === 2 && sum.pickedUp === 1, JSON.stringify(sum));

console.log('\n4. extend');
ok('extend 1 week from the due date', L.extendedDue(sign, 7, D(2026, 10, 10)) === new Date(2026, 9, 20).getTime());
ok('an overdue sign extends from TODAY, not the stale due date', L.extendedDue(sign, 7, D(2026, 10, 16)) === new Date(2026, 9, 23).getTime());

console.log('\n5. crediting yard-sign QR leads to a sign');
const out = [
  { id: 's1', lat: 39.100, lng: -84.500, placedAt: D(2026, 9, 1), status: 'picked_up', pickedUpAt: D(2026, 9, 15) },
  { id: 's2', lat: 39.105, lng: -84.505, placedAt: D(2026, 9, 20), status: 'out' },
  { id: 's3', lat: 39.500, lng: -84.900, placedAt: D(2026, 9, 1), status: 'out' },
];
ok('the nearest sign that was out that day gets it', L.attributeLead({ lat: 39.106, lng: -84.506, createdAt: D(2026, 9, 25) }, out).signId === 's2');
ok('a sign already picked up weeks earlier does not', (L.attributeLead({ lat: 39.1001, lng: -84.5001, createdAt: D(2026, 9, 28) }, out) || {}).signId === 's2');
ok('a lead before any nearby sign went out gets none', L.attributeLead({ lat: 39.106, lng: -84.506, createdAt: D(2026, 8, 1) }, out) === null);
ok('too far from every sign → none', L.attributeLead({ lat: 40.5, lng: -83.0, createdAt: D(2026, 9, 25) }, out) === null);
ok('a lead with no location → none', L.attributeLead({ createdAt: D(2026, 9, 25) }, out) === null);
ok('yard-sign source is recognised from the QR tag', L.isYardSignSource({ utmSource: 'yard-sign' }) && L.isYardSignSource({ source: 'Website — Yard Sign' }) && !L.isYardSignSource({ source: 'door hanger' }));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
