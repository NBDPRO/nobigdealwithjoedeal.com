#!/usr/bin/env node
/**
 * tests/call-center-sorts-2026-11-20.test.js — the Call Center's extra sort orders (phone sweep follow-up, Jo 2026-11-20):
 * Newest / Oldest / Urgent first / Open promises first / Unhandled first / Longest waiting / Longest call / Name A to Z /
 * Most calls from one number for the list, and Smart (urgent, then promises soonest due, then longest waiting) plus the
 * same orders for the Needs attention list of PEOPLE. Pure logic (docs/pro/js/call-center-filters-logic.js).
 *
 * Run: node tests/call-center-sorts-2026-11-20.test.js
 */
const FX = require('../docs/pro/js/call-center-filters-logic.js');

let failed = 0;
function ok(name, cond, detail) { console.log((cond ? 'ok   ' : 'FAIL ') + name + (!cond && detail ? ' :: ' + detail : '')); if (!cond) failed++; }

const DAY = 86400000;
const NOW = Date.parse('2026-11-20T15:00:00Z');
const call = (id, o) => Object.assign({ id, startedAtMs: NOW - 1000, direction: 'inbound', durationSec: 60, promises: [], phoneDigits: '513555' + String(1000 + id.charCodeAt(0)) }, o);
const ids = (rows) => rows.map((c) => c.id).join('');
const nameOf = (c) => c.name || '';

const a = call('a', { startedAtMs: NOW - 1 * DAY, name: 'Zed Zane', urgent: true });
const b = call('b', { startedAtMs: NOW - 3 * DAY, name: 'amy adams', durationSec: 400, promises: [{ who: 'jo', text: 'x', due: '2026-11-25' }] });
const c = call('c', { startedAtMs: NOW - 2 * DAY, name: 'Bob Bell', handledAtMs: NOW - DAY, durationSec: 15 });
const d = call('d', { startedAtMs: NOW - 5 * DAY, name: '', durationSec: 200, promises: [{ who: 'jo', text: 'y', due: 'tomorrow' }] });
const e = call('e', { startedAtMs: NOW - 4 * DAY, name: 'Cara Cho', phoneDigits: '5135551234' });
const f = call('f', { startedAtMs: NOW - 6 * DAY, name: 'Cara Cho', phoneDigits: '5135551234' });
const g = call('g', { startedAtMs: 0, name: 'No Time' });
const rows = [a, b, c, d, e, f, g];

console.log('list orders');
ok('Newest: by start time, a call with no time last', ids(FX.sortListBy(rows, 'new', nameOf)) === 'acbedfg', ids(FX.sortListBy(rows, 'new', nameOf)));
ok('Oldest: oldest first, no-time last', ids(FX.sortListBy(rows, 'old', nameOf)) === 'fdebcag', ids(FX.sortListBy(rows, 'old', nameOf)));
ok('Urgent first: the urgent call leads, the rest newest first', ids(FX.sortListBy(rows, 'urgent', nameOf)) === 'acbedfg', ids(FX.sortListBy(rows, 'urgent', nameOf)));
ok('Open promises first: dated promises by soonest due (tomorrow before the 25th), then the rest newest first', ids(FX.sortListBy(rows, 'promise', nameOf)) === 'dbacefg', ids(FX.sortListBy(rows, 'promise', nameOf)));
ok('Unhandled first: open calls newest first, the handled call last', ids(FX.sortListBy(rows, 'unhandled', nameOf)) === 'abedfgc', ids(FX.sortListBy(rows, 'unhandled', nameOf)));
ok('Longest waiting: open calls oldest first (no-time call after them), handled last', ids(FX.sortListBy(rows, 'waiting', nameOf)) === 'fdebagc', ids(FX.sortListBy(rows, 'waiting', nameOf)));
ok('Longest call: duration, biggest first, ties newest first', ids(FX.sortListBy(rows, 'long', nameOf)) === 'bdaefgc', ids(FX.sortListBy(rows, 'long', nameOf)));
ok('Name A to Z: case-insensitive, same name newest first, the unnamed call last', ids(FX.sortListBy(rows, 'name', nameOf)) === 'bcefgad', ids(FX.sortListBy(rows, 'name', nameOf)));
ok('Name A to Z puts amy before Bob before Cara regardless of case', ids(FX.sortListBy(rows, 'name', nameOf)).slice(0, 2) === 'bc');
ok('Most calls from one number: the two calls from 513-555-1234 lead (newest of them first), the rest newest first', ids(FX.sortListBy(rows, 'repeat', nameOf)) === 'efacbdg', ids(FX.sortListBy(rows, 'repeat', nameOf)));
ok('an unknown order id falls back to Newest', ids(FX.sortListBy(rows, 'nope', nameOf)) === ids(FX.sortListBy(rows, 'new', nameOf)));
ok('sorting never mutates the list it is given', ids(rows) === 'abcdefg');
ok('a missing list is an empty list, not a throw', Array.isArray(FX.sortListBy(null, 'new')) && FX.sortListBy(null, 'new').length === 0);

console.log('people (Needs attention)');
const P = (key, calls) => ({ key, calls });
const p1 = P('p1', [call('1', { startedAtMs: NOW - 2 * DAY })]);                                           // waiting 2 days, nothing else
const p2 = P('p2', [call('2', { startedAtMs: NOW - 1 * DAY, urgent: true })]);                             // urgent
const p3 = P('p3', [call('3', { startedAtMs: NOW - 1 * DAY, promises: [{ who: 'jo', text: 'z', due: '2026-11-24' }] })]);   // promise due Nov 24
const p4 = P('p4', [call('4', { startedAtMs: NOW - 6 * DAY, promises: [{ who: 'jo', text: 'z', due: '2026-11-22' }] })]);   // promise due Nov 22
const p5 = P('p5', [call('5', { startedAtMs: NOW - 5 * DAY }), call('5b', { startedAtMs: NOW - 4 * DAY })]);   // waiting longest, two calls
const people = [p1, p2, p3, p4, p5];
const keys = (list) => list.map((x) => x.key).join(',');
ok('Smart: urgent first, then promises soonest due, then the longest waiting', keys(FX.sortPeopleBy(people, 'smart')) === 'p2,p4,p3,p5,p1', keys(FX.sortPeopleBy(people, 'smart')));
ok('Newest first: by each persons newest call (a tie keeps the given order)', keys(FX.sortPeopleBy(people, 'new')) === 'p2,p3,p1,p5,p4', keys(FX.sortPeopleBy(people, 'new')));
ok('Longest waiting: the person whose oldest open call is oldest leads', keys(FX.sortPeopleBy(people, 'waiting')) === 'p4,p5,p1,p2,p3', keys(FX.sortPeopleBy(people, 'waiting')));
ok('Most calls: the person with two open calls leads, the rest newest first', keys(FX.sortPeopleBy(people, 'repeat')) === 'p5,p2,p3,p1,p4', keys(FX.sortPeopleBy(people, 'repeat')));
ok('Name A to Z uses the name the view gives, unnamed last', keys(FX.sortPeopleBy(people, 'name', (g) => ({ p1: 'Zoe', p2: 'Abe', p3: 'Mia', p4: '', p5: 'Bo' }[g.key]))) === 'p2,p5,p3,p1,p4');
ok('an unknown people order falls back to Smart', keys(FX.sortPeopleBy(people, 'nope')) === keys(FX.sortPeopleBy(people, 'smart')));
ok('a person with no dated calls sorts last, not first, under Smart', keys(FX.sortPeopleBy([P('x', [call('x', { startedAtMs: 0 })]), p1], 'smart')) === 'p1,x', keys(FX.sortPeopleBy([P('x', [call('x', { startedAtMs: 0 })]), p1], 'smart')));

console.log('why a person is where they are');
ok('Smart says Urgent for an urgent person', FX.smartReason(p2, NOW) === 'Urgent');
ok('...Promise due <date> for a dated promise', FX.smartReason(p4, NOW) === 'Promise due Nov 22', FX.smartReason(p4, NOW));
ok('...Waiting N days when only time has passed', FX.smartReason(p1, NOW) === 'Waiting 2 days' && FX.smartReason(P('w', [call('w', { startedAtMs: NOW - DAY })]), NOW) === 'Waiting 1 day');
ok('...nothing for someone who called minutes ago', FX.smartReason(P('n', [call('n', { startedAtMs: NOW - 60000 })]), NOW) === '');
ok('promise words resolve from the call day: today, tomorrow, a weekday; free text is undated', FX.dueMs({ due: 'tomorrow' }, NOW) === NOW + DAY && FX.dueMs({ due: 'today' }, NOW) === NOW && FX.dueMs({ due: 'Fri' }, NOW) > NOW && FX.dueMs({ due: 'when the permit clears' }, NOW) === Infinity);

console.log('saved choices');
const mem = {};
const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
ok('nothing saved: Newest for the list, Smart for people', JSON.stringify(FX.loadSort(storage)) === '{"list":"new","people":"smart"}');
FX.saveSort(storage, { list: 'long', people: 'waiting' });
ok('a saved choice round-trips', JSON.stringify(FX.loadSort(storage)) === '{"list":"long","people":"waiting"}');
ok('junk or a stale id becomes the default, one half at a time', JSON.stringify(FX.normalizeSort({ list: 'bogus', people: 'urgent' })) === '{"list":"new","people":"urgent"}');
ok('corrupt saved JSON and no storage are both safe', (mem[FX.SORT_KEY] = '{oops', JSON.stringify(FX.loadSort(storage)) === '{"list":"new","people":"smart"}') && JSON.stringify(FX.loadSort(null)) === '{"list":"new","people":"smart"}');
ok('the saved FILTER record is untouched: still six keys, Newest first', JSON.stringify(FX.defaults()) === '{"range":"all","from":"","to":"","dir":"all","status":"all","sort":"new"}');
ok('the older two-option sort list is unchanged (the layout with the flag off still uses it)', FX.SORTS.length === 2 && FX.SORTS[0][0] === 'new' && FX.SORTS[1][0] === 'old');
ok('every list and people order has a label', FX.SORT_LIST.every((x) => x[1]) && FX.SORT_PEOPLE.every((x) => x[1]) && FX.SORT_LIST.length === 9 && FX.SORT_PEOPLE.length === 8);

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
