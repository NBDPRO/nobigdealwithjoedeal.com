/**
 * tests/call-center-sweep-2026-10-01.test.js — Call Center stage 3, the
 * twice-daily "you said you'd…" sweep (functions/call-center-logic.js
 * collectSweepItems + buildSweepEmail, call-center.js runSweep against an
 * in-memory Firestore). Names and numbers invented (555).
 *
 * Run: node tests/call-center-sweep-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const { runSweep, OWNER, COLLECTION } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const NOW = Date.parse('2026-10-05T11:15:00Z'); // 07:15 ET
const TODAY = '2026-10-05';
const H = 3600e3;
const call = (id, extra) => Object.assign({ id, userId: OWNER, status: 'noted', startedAtMs: NOW - 48 * H, contactName: 'Pat Example', summary: 'Talked gutters.', promises: [], urgent: false }, extra);

console.log('\n1. collectSweepItems');
const calls = [
  call('a', { leadId: 'L1', promises: [{ who: 'jo', text: 'Send the quote', due: '2026-10-03' }] }),       // task open, overdue → due
  call('b', { leadId: 'L2', promises: [{ who: 'jo', text: 'Call back', due: '2026-10-09' }] }),            // task open, future → nothing
  call('c', { leadId: 'L3', promises: [{ who: 'jo', text: 'Order shingles' }] }),                           // task done → nothing
  call('d', { leadId: null, contactName: 'Example Claims', promises: [{ who: 'jo', text: 'Email the photos', due: null }] }), // no file → nofile
  call('e', { leadId: null, contactName: '', phoneDigits: '5135550100', promises: [], followUpDate: '2026-10-04' }), // no file, follow-up came → nofile
  call('f', { leadId: null, promises: [{ who: 'them', text: 'They will call back' }] }),                     // only their promise → nothing
  call('g', { leadId: 'L4', urgent: true, startedAtMs: NOW - 5 * H, promises: [{ who: 'jo', text: 'Tarp the roof', due: '2026-10-06' }] }), // urgent, recent
  call('h', { leadId: 'L5', handledAtMs: NOW - H, promises: [{ who: 'jo', text: 'x', due: '2026-10-01' }] }), // handled → nothing
  call('i', { leadId: null, startedAtMs: NOW - 40 * 24 * H, promises: [{ who: 'jo', text: 'old' }] }),       // > 30 days → nothing
  call('j', { status: 'personal', leadId: null, promises: [{ who: 'jo', text: 'personal' }] }),               // personal → nothing
];
const tasks = new Map([
  ['a', { done: false, dueDate: '2026-10-03' }],
  ['b', { done: false, dueDate: '2026-10-09' }],
  ['c', { done: true, dueDate: '2026-10-01' }],
  ['g', { done: false, dueDate: '2026-10-06' }],
  ['h', { done: false, dueDate: '2026-10-01' }],
]);
const items = L.collectSweepItems({ calls, tasksByCallId: tasks, nowMs: NOW, todayYmd: TODAY });
const ids = items.map((i) => i.callId + ':' + i.kind).join(',');
ok('exactly the owed items, urgent first then by due date', ids === 'g:urgent,a:due,e:nofile,d:nofile', ids);
ok('a ticked task never shows', !items.some((i) => i.callId === 'c'));
ok('a future task waits', !items.some((i) => i.callId === 'b'));
ok('handled, personal and >30-day calls never show', !items.some((i) => ['h', 'i', 'j'].includes(i.callId)));
ok('only Jo\'s own promises are listed', items.find((i) => i.callId === 'a').promises.join() === 'Send the quote');
ok('a bare number reads as a phone number', items.find((i) => i.callId === 'e').who === '(513) 555-0100');
ok('capped', L.collectSweepItems({ calls: Array.from({ length: 50 }, (_, k) => call('n' + k, { leadId: null, promises: [{ who: 'jo', text: 't' }] })), tasksByCallId: new Map(), nowMs: NOW, todayYmd: TODAY }).length === L.SWEEP_MAX_ITEMS);

console.log('\n2. buildSweepEmail');
const mail = L.buildSweepEmail({ items, todayYmd: TODAY, slot: 'am' });
ok('subject counts and flags urgent', mail.subject === '🚨 Calls: 4 things you said you\'d do');
ok('links go to the customer, or the Call Center for no-file calls', /customer\.html\?id=L4/.test(mail.html) && /dashboard\.html#calls/.test(mail.html));
const evil = L.buildSweepEmail({ items: [{ kind: 'nofile', who: '<img src=x onerror=alert(1)>', promises: ['"><script>x</script>'], summary: '<b>', due: TODAY, callId: 'z', leadId: null }], todayYmd: TODAY, slot: 'pm' });
ok('every value escaped (contact names and AI text are untrusted)', !/<img|<script|<b>/.test(evil.html) && /&lt;img/.test(evil.html));
ok('afternoon subject says so', /afternoon check/.test(evil.subject));
ok('plain-text part lists each item', mail.text.split('\n- [').length === 5);

console.log('\n3. runSweep');
function fakeDb(seed) {
  const docs = new Map(Object.entries(seed));
  const mk = (p) => ({ id: p.split('/').pop(), get: async () => ({ exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }) });
  const query = (name, filters, lim) => ({
    where: (f, _o, v) => query(name, filters.concat([[f, v]]), lim),
    orderBy: () => query(name, filters, lim),
    limit: (n) => query(name, filters, n),
    get: async () => {
      const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2 && filters.every(([f, val]) => v[f] === val)).slice(0, lim || 1e9);
      return { forEach: (fn) => rows.forEach(([k, v]) => fn({ id: k.split('/')[1], data: () => v })) };
    },
  });
  return { doc: mk, collection: (n) => Object.assign(query(n, [], null), { doc: (id) => mk(n + '/' + id) }), getAll: async (...r) => Promise.all(r.map((x) => x.get())) };
}
(async () => {
  const seed = { ['users/' + OWNER]: { email: 'owner@nbd.test' } };
  for (const c of calls) seed[COLLECTION + '/' + c.id] = Object.assign({}, c, { id: undefined });
  for (const [id, t] of tasks) { const c = calls.find((x) => x.id === id); seed['leads/' + c.leadId + '/tasks/cube-' + id] = t; }
  const sent = [];
  const send = async (m) => { sent.push(m); };
  let r = await runSweep({ db: fakeDb(seed), live: false, nowMs: NOW, send, slot: 'am' });
  ok('dry run: counts, sends nothing', r.state === 'dry_run' && r.items === 4 && r.urgent === 1 && sent.length === 0, JSON.stringify(r));
  r = await runSweep({ db: fakeDb(seed), live: true, nowMs: NOW, send, slot: 'am' });
  ok('live: one email to the owner', r.state === 'sent' && sent.length === 1 && sent[0].to === 'owner@nbd.test' && /4 things/.test(sent[0].subject));
  const quiet = { ['users/' + OWNER]: { email: 'owner@nbd.test' }, [COLLECTION + '/x']: Object.assign(call('x', { leadId: 'L9' })) };
  sent.length = 0;
  r = await runSweep({ db: fakeDb(quiet), live: true, nowMs: NOW, send, slot: 'pm' });
  ok('nothing owed → no email', r.state === 'nothing' && sent.length === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
