/**
 * tests/nbd-os-p1-followups-2026-11-09.test.js - NBD OS P2, the P1 follow-ups
 * (documentation/projects/SESSION-2026-11-09-nbd-os-p1.md section 4):
 *
 *   1. the urgency ring's missed-call branch is the member's own: a call counts
 *      when its phone_calls doc's userId is the member (NBDHomeAttention.lastRows,
 *      by the row's callIds), else when the lead it is filed on is the member's
 *      (userId, else assignedTo, the lead rule) or nobody's; a manager is not
 *      rung for a teammate's call
 *   2. a new Smart Stack holds Shutdown, so the 4 PM - 8 PM rule has its card
 *      (Shutdown takes Coach's place: STACK_MAX is 4 and Coach is only ever the
 *      evening fallback when there is no Shutdown); saved stacks are untouched
 *
 * Run: node tests/nbd-os-p1-followups-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, makeWin, NOW } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const SL = req('docs/pro/js/os/stack-logic.js');
const MIN = 60000;
const call = (over) => Object.assign({ key: 'lead:L9', leadId: 'L9', missed: true, latestMs: NOW - 8 * MIN, callIds: ['c9'] }, over || {});
const U = (o) => HL.urgency(Object.assign({ now: NOW, stamped: false, uid: 'u1' }, o));

console.log('\n1. urgency(): the missed-call branch is the member\'s own');
G(() => {
  ok('the call doc\'s userId is the member -> it rings', J(U({ plan: { calls: [call()] }, callOwners: { c9: 'u1' } })) === J({ kind: 'call', n: 1, oldestMin: 8, leadId: 'L9' }));
  ok('the call doc\'s userId is a teammate -> no ring (a manager is not rung for the company)', U({ plan: { calls: [call()] }, callOwners: { c9: 'u2' } }) === null);
  ok('a text day id (text:<id>) maps the same way', U({ plan: { calls: [call({ callIds: ['t1'] })] }, callOwners: { t1: 'u2' } }) === null
    && U({ plan: { calls: [call({ callIds: ['t1'] })] }, callOwners: { t1: 'u1' } }) !== null);
  ok('a row with several calls rings when any of them is the member\'s', U({ plan: { calls: [call({ callIds: ['a', 'b'] })] }, callOwners: { a: 'u2', b: 'u1' } }) !== null);
  ok('the call doc\'s userId wins over the lead\'s owner', U({ plan: { calls: [call()] }, callOwners: { c9: 'u1' }, leads: [{ id: 'L9', userId: 'u2' }] }) !== null
    && U({ plan: { calls: [call()] }, callOwners: { c9: 'u2' }, leads: [{ id: 'L9', userId: 'u1' }] }) === null);
  ok('no call owner on file: the lead\'s owner (userId) decides', U({ plan: { calls: [call()] }, leads: [{ id: 'L9', userId: 'u2' }] }) === null
    && U({ plan: { calls: [call()] }, leads: [{ id: 'L9', userId: 'u1' }] }) !== null);
  ok('...else the lead\'s assignedTo', U({ plan: { calls: [call()] }, leads: [{ id: 'L9', assignedTo: 'u2' }] }) === null
    && U({ plan: { calls: [call()] }, leads: [{ id: 'L9', assignedTo: 'u1' }] }) !== null);
  ok('no owner anywhere (an unfiled call, an unowned lead): it rings, like an unowned lead', U({ plan: { calls: [call({ leadId: null, callIds: ['x'] })] } }) !== null
    && U({ plan: { calls: [call()] }, leads: [{ id: 'L9' }] }) !== null);
  ok('n and the oldest count only the member\'s own calls', J(U({ plan: { calls: [call({ latestMs: NOW - 20 * MIN, callIds: ['old'] }), call({ key: 'k2', leadId: 'L8', latestMs: NOW - 3 * MIN, callIds: ['new'] })] }, callOwners: { old: 'u2', new: 'u1' } }))
    === J({ kind: 'call', n: 1, oldestMin: 3, leadId: 'L8' }));
  ok('no uid (an old caller): every fresh missed call counts, as before', HL.urgency({ now: NOW, stamped: false, plan: { calls: [call()] }, callOwners: { c9: 'u2' } }) !== null);
  ok('a junk callOwners or leads value is ignored, never thrown', U({ plan: { calls: [call()] }, callOwners: 'x', leads: 'y' }) !== null && U({ plan: { calls: [call({ callIds: 'c9' })] }, callOwners: [] }) !== null);
});

console.log('\n2. the ring on the phone reads the call owners from NBDHomeAttention.lastRows');
G(() => {
  const mk = (owner) => {
    const T = makeWin({ surface: 'phone', uid: 'u1', claims: { role: 'manager', companyId: 'c1' }, plan: Object.assign(H.plan(), { calls: [call()] }) });
    T.W.NBDHomeAttention.lastRows = [{ id: 'c9', userId: owner, startedAtMs: NOW - 8 * MIN }];
    T.W._impl.mount({ surface: 'phone' });
    return T.document.getElementById('osPhone').querySelector('.os-p-icon[data-id="calls"]');
  };
  ok('a teammate\'s missed call: the manager\'s Calls icon does not ring', !mk('rep2').classList.contains('is-urgent'));
  ok('the manager\'s own missed call: it rings', mk('u1').classList.contains('is-urgent'));
});

console.log('\n3. a new Smart Stack holds Shutdown (the evening rule\'s card); saved stacks are untouched');
G(() => {
  ok('STACK_DEFAULT: Up Next, Storm, Daily Success, Shutdown (4, the cap)', J(HL.STACK_DEFAULT) === J(['upnext', 'storm', 'daily', 'shutdown']) && HL.STACK_DEFAULT.length <= HL.STACK_MAX);
  ok('every default card is one a stack rule picks', HL.STACK_DEFAULT.every((id) => ['upnext', 'storm', 'daily', 'shutdown'].indexOf(id) !== -1));
  const added = HL.add([], 'stack');
  ok('Add widget -> Smart Stack starts with Shutdown in it', added && J(added[0].items) === J(['upnext', 'storm', 'daily', 'shutdown']), J(added));
  ok('a saved stack keeps its own cards (Coach stays, Shutdown is not added)', J(HL.normalize({ phone: [{ id: 'stack', s: 'm', items: ['upnext', 'storm', 'daily', 'coach'] }] }).phone[0].items) === J(['upnext', 'storm', 'daily', 'coach']));
  ok('a saved 2-card stack is not topped up', J(HL.normalize({ phone: [{ id: 'stack', s: 'm', items: ['upnext', 'coach'] }] }).phone[0].items) === J(['upnext', 'coach']));
  const at = (h) => new Date(2026, 10, 9, h, 30).getTime();
  const pick = (h) => SL.pick({ now: at(h), plan: { appointments: [] }, children: HL.STACK_DEFAULT.slice(), shutdown: true });
  ok('5:30 PM on a new stack: the evening rule shows Shutdown', pick(17).childId === 'shutdown' && pick(17).rule === 'evening', J(pick(17)));
  ok('the morning and work-hours rules still find their cards', pick(7).childId === 'daily' && pick(12).childId === 'upnext');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
