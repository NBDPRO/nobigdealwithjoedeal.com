#!/usr/bin/env node
/**
 * The server channel for dated promises / Waiting items + the one parked rule +
 * the unreached-push email (2026-10-13; audit F1, F2, F5, F9a:
 * documentation/audit/NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md, section 6b).
 *
 * Every absence assertion is paired with a presence control (a harness that
 * blanks the keyed value makes !/x/ pass with the bug present). The end-to-end
 * numbers (one 08:00 push, brief line, ledger count, dead-token email) are in
 * tests/needs-you-volume-sim-2026-10-13.test.js scenarios N / O / P / G / H.
 * Run: node tests/promise-channel-2026-10-13.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.CALL_WATCH_ENABLED = 'true';
process.env.CALL_CENTER_INGEST_ENABLED = 'true';
process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'true';
delete process.env.TEXT_NOTES_ENABLED;

const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const PCL = require(path.join(ROOT, 'functions/promise-channel-logic.js'));
const PC = require(path.join(ROOT, 'functions/promise-channel.js'));
const PRs = require(path.join(ROOT, 'functions/promise-logic.js'));
const PRc = require(path.join(ROOT, 'docs/pro/js/promise-logic.js'));
const L = require(path.join(ROOT, 'functions/call-center-logic.js'));
const MB = require(path.join(ROOT, 'functions/morning-brief-logic.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const WATCH = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
const CC = require(path.join(ROOT, 'functions/call-center.js'))._test;
const AWAY = require(path.join(ROOT, 'functions/away-mode.js'))._internal;
const OWNER = CC.OWNER;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const DAY = 86400000;
const NOW = Date.parse('2026-10-07T12:00:00Z');            // Wed 08:00 ET
const TODAY = '2026-10-07', TOMORROW = '2026-10-08', YESTERDAY = '2026-10-06';
const task = (o) => Object.assign({ id: 't' + Math.random().toString(36).slice(2, 8), leadId: 'L1', kind: 'promise', promiseKind: 'callback', text: 'Call back', done: false, dueDate: TODAY, userId: OWNER }, o);
const lead = (o) => Object.assign({ firstName: 'Pat', lastName: 'Lee', userId: OWNER, companyId: OWNER, phoneDigits: '5135550101' }, o);

// ── fake Firestore (where / orderBy / limit are no-ops: callers pass what they need) ──
function mkDb(S) {
  const snap = (rows) => { const docs = rows.map((r) => ({ id: r.id, data: () => r, ref: r.__ref })); return { docs, size: docs.length, forEach: (fn) => docs.forEach(fn) }; };
  const q = (rows) => { const x = { where: () => x, orderBy: () => x, limit: () => x, get: async () => snap(rows) }; return x; };
  const pathDoc = (p) => ({
    id: p.split('/').pop(),
    async get() { return { exists: p in S.docs, id: p.split('/').pop(), data: () => S.docs[p] }; },
    async set(v, op) { S.docs[p] = op && op.merge ? Object.assign({}, S.docs[p] || {}, v) : Object.assign({}, v); },
    async update(v) { S.docs[p] = Object.assign({}, S.docs[p] || {}, v); },
  });
  return {
    collection(n) {
      if (n === 'notifications') return { add: async (v) => { S.bells.push(v); } };
      if (n === 'companies') return { doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }), doc: () => ({ get: async () => ({ exists: false }) }) }) }) };
      if (n === 'alert_outbox') return q([]);
      const rows = (S.cols[n] || []);
      return Object.assign(q(rows), { doc: (id) => pathDoc(n + '/' + id) });
    },
    doc: (p) => pathDoc(p),
    getAll: async (...r) => Promise.all(r.map((x) => x.get())),
    collectionGroup(n) {
      const f = [];
      const x = { where: (k, op, v) => { f.push([k, op, v]); (S.whereLog = S.whereLog || []).push([n, k, op, v]); return x; }, get: async () => {
        if (S.failTasks) throw new Error('simulated tasks outage');
        const docs = Object.keys(S.docs).map((p) => { const m = /^leads\/([^/]+)\/tasks\/([^/]+)$/.exec(p); return m && n === 'tasks' ? { p, leadId: m[1], id: m[2] } : null; }).filter(Boolean)
          .filter((d) => f.every(([k, op, v]) => (op === '==' ? S.docs[d.p][k] === v : true)))
          .map((d) => ({ id: d.id, data: () => S.docs[d.p], ref: { parent: { parent: { id: d.leadId } } } }));
        return { docs, size: docs.length, forEach: (fn) => docs.forEach(fn) };
      } };
      return x;
    },
  };
}
const newState = () => ({ docs: {}, cols: { phone_calls: [], phone_text_days: [], thursday_calls: [] }, bells: [] });

(async () => {
  // ═══ 1. the one parked rule ═══════════════════════════════════════════
  console.log('\n1. parkedUntil - one rule for every snooze mechanism');
  ok('a snooze dated ahead parks until that day', W.parkedUntil({ snoozeUntilYmd: '2026-10-10' }, NOW) === '2026-10-10');
  ok('a snooze that ended (date today or past) parks nothing', W.parkedUntil({ snoozeUntilYmd: TODAY }, NOW) === '' && W.parkedUntil({ snoozeUntilYmd: YESTERDAY }, NOW) === '');
  ok('garbage / empty dates park nothing', W.parkedUntil({ snoozeUntilYmd: 'tomorrow' }, NOW) === '' && W.parkedUntil({}, NOW) === '' && W.parkedUntil(null, NOW) === '');
  ok('a snoozed task (taskSnoozed + taskDueYmd) parks until the moved date', W.parkedUntil({ taskSnoozed: true, taskDueYmd: '2026-10-12' }, NOW) === '2026-10-12');
  ok('a task dated ahead but NOT snoozed parks only when the caller asks (the ladder does)', W.parkedUntil({ taskDueYmd: '2026-10-12' }, NOW) === '' && W.parkedUntil({ taskDueYmd: '2026-10-12' }, NOW, { taskDue: true }) === '2026-10-12');
  ok('a promise TASK dated ahead is parked until its date; due today is not', W.parkedUntil({ kind: 'promise', dueDate: '2026-10-09' }, NOW) === '2026-10-09' && W.parkedUntil({ kind: 'promise', dueDate: TODAY }, NOW) === '');
  ok('the latest of several dates wins', W.parkedUntil({ snoozeUntilYmd: '2026-10-09', taskSnoozed: true, taskDueYmd: '2026-10-14' }, NOW) === '2026-10-14');
  const urgent = { id: 'c1', startedAtMs: NOW - 3600e3, urgent: true, status: 'noted', direction: 'inbound' };
  ok('control: the same urgent call, unparked, needs Jo', W.callNeedsYou(urgent, NOW) === true);
  ok('callNeedsYou: a snoozed urgent call is not open until the date arrives', W.callNeedsYou(Object.assign({}, urgent, { snoozeUntilYmd: '2026-10-09' }), NOW) === false);
  ok('callNeedsYou: ...and is open again the day it ends', W.callNeedsYou(Object.assign({}, urgent, { snoozeUntilYmd: '2026-10-09' }), Date.parse('2026-10-09T14:00:00Z')) === true);
  const ridden = { id: 'c2', startedAtMs: NOW - 30 * DAY, status: 'noted', promise: { kind: 'promise', dueDate: TODAY }, followUpDate: TODAY };
  ok('control: a promise riding on an old call is open on its date', W.callNeedsYou(ridden, NOW) === true);
  ok('...and parked when snoozed (snooze beats the promise, as the ladder always did)', W.callNeedsYou(Object.assign({}, ridden, { snoozeUntilYmd: '2026-10-11' }), NOW) === false);
  ok('Home mirror agrees on every row above', [urgent, Object.assign({}, urgent, { snoozeUntilYmd: '2026-10-09' }), ridden, Object.assign({}, ridden, { snoozeUntilYmd: '2026-10-11' })]
    .every((c) => HA.callNeedsYou(c, NOW) === W.callNeedsYou(c, NOW)) && HA.parkedUntil({ snoozeUntilYmd: '2026-10-10' }, NOW) === '2026-10-10');

  // ═══ 2. the server twins of the promise readers ═══════════════════════
  console.log('\n2. server promise readers answer exactly what the client does');
  {
    const kinds = ['callback', 'estimate', 'waiting', 'bogus'];
    const dues = ['', 'x', YESTERDAY, TODAY, TOMORROW];
    let n = 0, diff = 0;
    kinds.forEach((promiseKind) => dues.forEach((dueDate) => [true, false].forEach((done) => [null, 'ts'].forEach((completedAt) => [false, true].forEach((deleted) => ['promise', 'note'].forEach((kind) => {
      const t = { kind, promiseKind, dueDate, done, completedAt, deleted, waitingSince: '2026-10-01', madeYmd: '2026-10-01' };
      n++;
      if (PRs.isPromise(t) !== PRc.isPromise(t) || PRs.isWaiting(t) !== PRc.isWaiting(t) || PRs.isOpen(t) !== PRc.isOpen(t) || PRs.isOwedNow(t, TODAY) !== PRc.isOwedNow(t, TODAY) || PRs.isRipe(t, TODAY, 3) !== PRc.isRipe(t, TODAY, 3)) diff++;
    }))))));
    ok('isPromise / isWaiting / isOpen / isOwedNow / isRipe: 0 differences over ' + n + ' tasks', diff === 0, diff);
  }

  // ═══ 3. dueItems / duePeople ═════════════════════════════════════════
  console.log('\n3. who is owed something');
  const leads = new Map([['L1', lead()], ['L2', lead({ firstName: 'Sam', lastName: 'Ray', phoneDigits: '5135550102' })], ['L3', lead({ firstName: 'Spam', lastName: 'Bot', phoneDigits: '5135550103' })],
    ['L4', lead({ firstName: 'Del', deleted: true })], ['L5', lead({ firstName: 'Foreign', userId: 'someoneElse', companyId: 'someoneElse' })],
    ['L6', lead({ firstName: 'Rep', lastName: 'Owned', userId: 'aRepUid', companyId: OWNER, phoneDigits: '5135550106' })]]);
  const people = (tasks, o) => PCL.duePeople(tasks, leads, Object.assign({ now: NOW, owner: OWNER }, o || {}));
  ok('an owed promise (due today) is a person', people([task({})]).length === 1);
  ok('overdue is owed, and the row says how long', (() => { const p = people([task({ dueDate: '2026-10-01' })]); return p.length === 1 && p[0].overdue === true && p[0].dueYmd === '2026-10-01'; })());
  ok('a date ahead is parked, not owed (control: the same task dated today is owed)', people([task({ dueDate: TOMORROW })]).length === 0 && people([task({ dueDate: TODAY })]).length === 1);
  ok('done / kept / dead tasks drop out (control: the open one is listed)', people([task({ done: true, outcome: 'kept' }), task({ done: true, outcome: 'dead' }), task({ completedAt: 'x' }), task({ deleted: true })]).length === 0 && people([task({})]).length === 1);
  ok('a task whose date moved is re-evaluated: today -> tomorrow drops, back to yesterday returns', (() => {
    const t = task({ dueDate: TODAY });
    const a = people([t]).length, b = people([Object.assign({}, t, { dueDate: TOMORROW })]).length, c = people([Object.assign({}, t, { dueDate: YESTERDAY })]).length;
    return a === 1 && b === 0 && c === 1;
  })());
  ok('Waiting: not owed before it ripens, a person once its nudge date has come', people([task({ promiseKind: 'waiting', dueDate: TOMORROW, waitingSince: YESTERDAY })]).length === 0 && people([task({ promiseKind: 'waiting', dueDate: TODAY, waitingSince: '2026-10-04' })]).length === 1);
  ok('a person owed three things is ONE row; people are counted, not rows', (() => {
    const p = people([task({ id: 'a' }), task({ id: 'b', promiseKind: 'estimate', dueDate: YESTERDAY }), task({ id: 'c', promiseKind: 'waiting', dueDate: TODAY })]);
    return p.length === 1 && p[0].items.length === 3 && p[0].dueYmd === YESTERDAY;
  })());
  ok('two people = two rows, oldest first', (() => { const p = people([task({ leadId: 'L2', dueDate: TODAY }), task({ leadId: 'L1', dueDate: YESTERDAY })]); return p.length === 2 && p[0].leadId === 'L1'; })());
  ok('a deleted customer\'s tasks are off; a foreign tenant\'s lead is never listed (control: L1 is)', people([task({ leadId: 'L4' }), task({ leadId: 'L5' }), task({ leadId: 'GONE' })]).length === 0 && people([task({})]).length === 1);
  const lbl = (kind, policy) => ({ '5135550101': { kind, policy } });
  ok('labels: a SPAM number\'s promise does not surface (control: unlabelled does)', people([task({ leadId: 'L3' })], { labels: { '5135550103': { kind: 'spam', policy: 'hide' } } }).length === 0 && people([task({ leadId: 'L3' })]).length === 1);
  ok('labels: hidden-personal and quiet numbers still surface a promise (a promise always surfaces)', people([task({})], { labels: lbl('personal', 'hide') }).length === 1 && people([task({})], { labels: lbl('sub', 'quiet') }).length === 1);
  ok('a person key equals the one a filed call gets (so calls + promises merge into one person)', people([task({})])[0].key === W.callerKey({ leadId: 'L1' }));
  ok('push text counts PEOPLE: "N promises due today"', PCL.pushText(people([task({ id: 'a' }), task({ id: 'b' }), task({ leadId: 'L2' })])).title === '2 promises due today' && PCL.pushText(people([task({})])).title === '1 promise due today');

  // ═══ 4. the ladder takes promise people with the same rungs ═══════════
  console.log('\n4. ladder: same rungs, a changed set of due tasks is new');
  {
    const p = people([task({ id: 'a' }), task({ id: 'b', dueDate: YESTERDAY })])[0];
    const x = PCL.ladderExtra(p);
    ok('one candidate per person, high-value wording', x.id === 'promise:L1' && x.key === 'lead:L1' && W.HIGH_WHY.test(x.why));
    const re = (ladder, extras) => W.ladderRetells([], [], ladder, NOW, null, extras || [x]);
    ok('told once (rung 1, long ago): re-told as rung 2', re({ 'promise:L1': { n: 1, at: NOW - 3 * 3600e3, sig: x.sig } }).map((r) => r.rung).join() === '2');
    ok('rung 3 (the last): no more re-tells (control: rung 2 still re-tells)', re({ 'promise:L1': { n: 3, at: NOW - 9 * 3600e3, sig: x.sig } }).length === 0 && re({ 'promise:L1': { n: 2, at: NOW - 3 * 3600e3, sig: x.sig } }).length === 1);
    ok('a re-tell inside the 100 min gap waits', re({ 'promise:L1': { n: 1, at: NOW - 30 * 60000, sig: x.sig } }).length === 0);
    ok('a CHANGED set of due tasks (new item / moved date) is a new tell, not a re-tell', W.ladderPrev({ 'promise:L1': { n: 3, at: NOW, sig: 'old' } }, x) === null && W.ladderPrev({ 'promise:L1': { n: 3, at: NOW, sig: x.sig } }, x) !== null);
    const next = (reached, fresh) => W.nextLadder([], [], {}, [], [], true, NOW, null, [x], { ids: new Set(fresh ? [x.id] : []), reached });
    ok('a push that REACHED a phone counts as told (rung 1, signature kept)', JSON.stringify(next(true, true)['promise:L1']) === JSON.stringify({ n: 1, at: NOW, sig: x.sig }));
    ok('a push that reached 0 devices does NOT count as told (n:0 - tried again next run)', next(false, true)['promise:L1'].n === 0);
    ok('done / moved: the person leaves the ladder map by itself', Object.keys(W.nextLadder([], [], { 'promise:L1': { n: 1, at: NOW, sig: x.sig } }, [], [], true, NOW, null, [], null)).length === 0);
  }

  // ═══ 5. F2: the email when no push reaches a phone ═══════════════════
  console.log('\n5. the unreached-push email');
  {
    const items = [
      { id: 'call:a', key: 'lead:La', who: 'Pat Lee', why: 'urgent' },
      { id: 'call:b', key: 'num:5135550177', who: 'Unknown', why: 'unknown number, no customer on file' },
      { id: 'promise:L2', key: 'lead:L2', who: 'Sam Ray', why: 'you promised something - Call back' },
    ];
    const m = W.unreachedEmail(items, NOW);
    ok('names the high-value people', !!m && m.people === 2 && /Pat Lee - urgent/.test(m.text) && /Sam Ray - you promised something/.test(m.text), m && m.text);
    ok('...and leaves out low-value noise (control: it IS in the input)', !/Unknown/.test(m.text) && items.some((i) => i.who === 'Unknown'));
    ok('nothing high-value = no email at all', W.unreachedEmail([items[1]], NOW) === null && W.unreachedEmail([], NOW) === null);
    ok('subject is the plain fact; html is escaped', /^Your phone did not get the alert: 2 people waiting on you/.test(m.subject) && !/<script/.test(W.unreachedEmail([{ id: 'x', key: 'k', who: '<script>x</script>', why: 'urgent' }], NOW).html));
  }

  // ═══ 6. the 20:00 ledger ═════════════════════════════════════════════
  console.log('\n6. ledger never reads "nothing fell through" over a due promise');
  {
    const todayCall = { id: 'c', startedAtMs: NOW, status: 'noted', handledAtMs: NOW, channel: 'call', direction: 'inbound' };
    const base = W.dailyLedger([todayCall], [], NOW, {});
    ok('control: a handled day with nothing due is clear', base.clear === true && base.open === 0);
    const withP = W.dailyLedger([todayCall], [], NOW, { promisePeople: people([task({})]) });
    ok('a due promise is an open person; the day is not clear', withP.open === 1 && withP.clear === false && /1 person still need/.test(withP.message) && /1 with a promise due/.test(withP.message), withP.message);
    ok('a person with an open call AND a due promise is counted once', (() => {
      const call = { id: 'c2', startedAtMs: NOW - 3600e3, status: 'noted', leadId: 'L1', urgent: true, channel: 'call', direction: 'inbound' };
      return W.dailyLedger([call], [], NOW, { promisePeople: people([task({})]) }).open === 1;
    })());
    const failed = W.dailyLedger([todayCall], [], NOW, { promisesFailed: true });
    ok('a failed task read is a warning, never clear', failed.clear === false && failed.anomalies.some((a) => /promise tasks/.test(a)));
  }

  // ═══ 7. F5: urgent, filed, no task ═══════════════════════════════════
  console.log('\n7. sweep / brief list an urgent call on a customer with no task');
  {
    const call = (o) => Object.assign({ id: 'cube_u1', status: 'noted', leadId: 'L1', contactName: 'Pat Lee', urgent: true, startedAtMs: NOW - 2 * 3600e3, promises: [], direction: 'inbound' }, o);
    const items = (calls, tasks) => L.collectSweepItems({ calls, tasksByCallId: tasks || new Map(), nowMs: NOW, todayYmd: TODAY });
    ok('urgent + filed + no task is listed as urgent', items([call()]).length === 1 && items([call()])[0].kind === 'urgent');
    ok('control: not urgent = not listed; urgent but 40 h old = not listed', items([call({ urgent: false })]).length === 0 && items([call({ startedAtMs: NOW - 40 * 3600e3 })]).length === 0);
    ok('handled / ticked / snoozed urgent calls stay off the list', items([call({ handledAtMs: NOW })]).length === 0 && items([call({ taskDone: true })]).length === 0 && items([call({ snoozeUntilYmd: '2026-10-09' })]).length === 0);
    ok('control: a task that exists keeps its own path (listed once, not twice)', items([call()], new Map([['cube_u1', { dueDate: TODAY, done: false }]])).length === 1);
  }

  // ═══ 8. brief + sweep email carry the promise rows ═══════════════════
  console.log('\n8. brief and sweep email');
  {
    const rows = PCL.mergeSweep([], people([task({ id: 'a' }), task({ id: 'b', promiseKind: 'estimate', text: 'Send estimate' })]));
    ok('one row per person, kind promise, both items listed', rows.length === 1 && rows[0].kind === 'promise' && rows[0].promises.length === 2);
    const host = [{ callId: 'cube_1', leadId: 'L1', kind: 'urgent', due: TODAY, promises: ['Send quote'], who: 'Pat Lee', startedAtMs: NOW - 1000, channel: 'call', summary: '' }];
    const merged = PCL.mergeSweep(host, people([task({})]));
    ok('a person who is already a row is not listed twice; the promise text joins it', merged.length === 1 && merged[0].promises.includes('Call back'), merged);
    const mail = L.buildSweepEmail({ items: rows, todayYmd: TODAY, slot: 'pm' });
    ok('the sweep email labels it "Promised" and opens the customer, not a call card', /Promised/.test(mail.html) && /customer\.html\?id=L1/.test(mail.html) && !/dashboard\.html\?open=promises&item=promise/.test(mail.html + mail.text));
    ok('a failed task read puts a NOT-an-all-clear line in the email (control: absent otherwise)', /NOT an all-clear/.test(L.buildSweepEmail({ items: rows, todayYmd: TODAY, slot: 'pm', promiseCheckFailed: true }).text) && !/NOT an all-clear/.test(mail.text));
    const sec = { promises: rows, newLeads: [], reviewAsks: [] };
    ok('brief: the promise rows ride in "You said you\'d" (control counted)', MB.sectionsHaveContent(sec) && /Promised/.test(MB.sectionsHtml(sec)) && /Pat Lee/.test(MB.sectionsText(sec)));
    ok('brief: a failed read is content (the email still goes) and says so; control: no failure, no warning', MB.sectionsHaveContent({ promiseCheckFailed: true }) && /NOT an all-clear/.test(MB.sectionsHtml({ promiseCheckFailed: true })) && !/NOT an all-clear/.test(MB.sectionsHtml(sec)) && !MB.sectionsHaveContent({ promises: [] }));
  }

  // ═══ 9. the snooze action stamps the call (F9a) ══════════════════════
  console.log('\n9. snooze stamps the call so every surface sees it');
  {
    const S = newState();
    const id = 'cube_snooze1234';
    S.docs['phone_calls/' + id] = { userId: OWNER, leadId: 'L1', status: 'noted', startedAtMs: NOW - 3600e3, urgent: true, direction: 'inbound' };
    S.docs['leads/L1/tasks/cube-' + id] = { done: false, dueDate: TODAY, userId: OWNER };
    const db = mkDb(S);
    const auth = { uid: OWNER, token: { role: 'owner' } };
    const r = await CC.callAction({ db, auth, data: { id, action: 'snooze', days: 2 }, nowMs: NOW });
    ok('snooze with a task moves the task AND stamps the call', r.on === 'task' && S.docs['leads/L1/tasks/cube-' + id].dueDate === '2026-10-09' && S.docs['phone_calls/' + id].snoozeUntilYmd === '2026-10-09', S.docs['phone_calls/' + id]);
    ok('...so the one rule parks it (and it is the SAME row Home reads)', W.callNeedsYou(Object.assign({ id }, S.docs['phone_calls/' + id]), NOW) === false && HA.callNeedsYou(Object.assign({ id }, S.docs['phone_calls/' + id]), NOW) === false);
    await CC.callAction({ db, auth, data: { id, action: 'unsnooze' }, nowMs: NOW });
    ok('unsnooze clears both (control: open again)', !S.docs['phone_calls/' + id].snoozeUntilYmd && W.callNeedsYou(Object.assign({ id }, S.docs['phone_calls/' + id]), NOW) === true);
  }

  // ═══ 10. away cover list ═════════════════════════════════════════════
  console.log('\n10. away cover list');
  {
    const S = newState();
    S.docs['leads/L1'] = lead();
    S.docs['leads/L1/tasks/promise-x'] = { kind: 'promise', promiseKind: 'callback', text: 'Call back', done: false, dueDate: TODAY, userId: OWNER, leadId: 'L1' };
    const items = await AWAY.loadOpenItems(mkDb(S), OWNER, NOW);
    ok('a due promise task is on the backup\'s list as one person', items.length === 1 && items[0].key === 'lead:L1' && /promised/.test(items[0].why), items);
    S.docs['leads/L1/tasks/promise-x'].dueDate = TOMORROW;
    ok('control: moved to tomorrow, the list is empty', (await AWAY.loadOpenItems(mkDb(S), OWNER, NOW)).length === 0);
    S.failTasks = true;
    let threw = false; try { await AWAY.loadOpenItems(mkDb(S), OWNER, NOW); } catch (_) { threw = true; }
    ok('an unreadable task list fails closed (throws), never an empty cover list', threw);
  }

  // ═══ 11. Thursday honours a parked number ════════════════════════════
  console.log('\n11. Thursday + parked');
  {
    const parkedCall = { id: 'c1', phoneDigits: '5135550101', leadId: 'L1', status: 'noted', startedAtMs: NOW - 5 * 3600e3, snoozeUntilYmd: '2026-10-10', direction: 'inbound' };
    const thu = (o) => Object.assign({ id: 't1', status: 'processed', reviewed: false, from: '5135550101', startedAt: new Date(NOW - 600e3), processedAt: new Date(NOW - 300e3) }, o);
    const told = (rows, calls) => W.newNeeds(calls || [], [], rows, NOW - 3600e3, NOW, null, new Set()).filter((n) => n.kind === 'thursday').length;
    ok('control: with no parked number the Thursday call is told', told([thu()], []) === 1);
    ok('a non-urgent Thursday call from a parked number waits', told([thu()], [parkedCall]) === 0);
    ok('an URGENT one breaks through', told([thu({ urgent: true })], [parkedCall]) === 1);
    ok('a parked row for a DIFFERENT number does not hold it', told([thu({ from: '5135550999' })], [parkedCall]) === 1);
  }

  // ═══ 12. runWatch end to end (stubbed senders) ═══════════════════════
  console.log('\n12. callWatch: one push, idempotent, dead token, failed read');
  {
    const mk = () => {
      const S = newState();
      S.docs['users/' + OWNER] = { email: 'jo@example.invalid' };
      S.docs['leads/L1'] = lead();
      S.docs['integrations/callCenter'] = { lastRunAtMs: NOW, lastTranscribeAtMs: NOW, lastRun: { failed: 0 }, lastTranscribe: { failed: 0 } };
      S.docs['leads/L1/tasks/promise-a'] = { kind: 'promise', promiseKind: 'callback', text: 'Call back - quote', done: false, dueDate: TODAY, userId: OWNER, leadId: 'L1' };
      S.docs['leads/L1/tasks/promise-b'] = { kind: 'promise', promiseKind: 'estimate', text: 'Send estimate', done: false, dueDate: YESTERDAY, userId: OWNER, leadId: 'L1' };
      return S;
    };
    const drive = async (S, t, o) => {
      const pushes = [], emails = [];
      const r = await WATCH.runWatch({ db: mkDb(S), nowMs: t, live: true,
        push: async (uid, title, body, data) => { pushes.push({ title, body, data }); return o && o.dead ? { sent: 0, failed: 1, errors: [] } : { sent: 1 }; },
        email: async (m) => { emails.push(m); } });
      return { r, pushes, emails };
    };
    {
      const S = mk();
      const a = await drive(S, NOW);
      const promisePush = a.pushes.filter((p) => p.data && p.data.type === 'promise_due');
      ok('08:00 run: ONE push "1 promise due today" for a person owed two things', promisePush.length === 1 && promisePush[0].title === '1 promise due today' && a.r.promisesDue === 1, a.pushes);
      ok('...with a bell (type promise_due) on Today', S.bells.some((b) => b.type === 'promise_due') && S.bells.filter((b) => b.type === 'promise_due').length === 1);
      const b = await drive(S, NOW + 5 * 60000);
      ok('a second run minutes later does NOT push the promise again (told, ladder entry kept)', b.pushes.filter((p) => p.data && p.data.type === 'promise_due').length === 0);
      const c = await drive(S, NOW + 2 * 3600e3);
      ok('two hours on: a re-tell (rung 2) through the normal alert, not a second "due today" push', c.pushes.filter((p) => p.data && p.data.type === 'promise_due').length === 0 && c.r.retold === 1, c.r);
      const d = await drive(S, NOW + 4 * 3600e3);
      ok('rung 3 mails Jo (the existing ladder email) and is sticky', d.emails.length === 1 && d.pushes.some((p) => p.data && p.data.requireInteraction === 'true'), d.emails.map((e) => e.subject));
      const e = await drive(S, NOW + 6 * 3600e3);
      ok('after the last rung: silence (control: the item is still open)', e.pushes.length === 0 && e.emails.length === 0 && e.r.promisesDue === 1, e.r);
      S.docs['leads/L1/tasks/promise-a'].done = true; S.docs['leads/L1/tasks/promise-b'].done = true;
      const f = await drive(S, NOW + 8 * 3600e3);
      ok('kept / done: the person drops out (promisesDue 0) and the ladder map empties', f.r.promisesDue === 0 && Object.keys(S.docs['integrations/callWatch'].ladder || {}).length === 0, f.r);
    }
    {
      const S = mk();
      const emails = [];
      const errs = [];
      for (let i = 0; i < 4; i++) {
        await WATCH.runWatch({ db: mkDb(S), nowMs: NOW + i * 2 * 3600e3, live: true, push: async () => ({ sent: 0, failed: 1, errors: [] }), email: async (m) => { emails.push(m); } })
          .catch((e) => { errs.push(String(e && e.message)); });
        if (i === 0) ok('the FIRST unreached run already mails (the promise push is what failed, no call alert exists)', emails.length === 1 && /^Your phone did not get the alert: 1 person/.test(emails[0].subject), emails.map((m) => m.subject));
      }
      ok('dead token: every run still fails loud for the heartbeat (the bell is the only thing that told him)', errs.length === 4 && errs.every((m) => /reached 0 devices/.test(m)), errs);
      const um = emails.filter((m) => /^Your phone did not get the alert/.test(m.subject));
      ok('four unreached runs over 6 h = exactly ONE "phone did not get it" email, naming the person (once per item)', um.length === 1 && /Pat Lee - you promised something/.test(um[0].text), emails.map((m) => m.subject));
      ok('...and the state remembers it (idempotent across a restart)', Object.keys(S.docs['integrations/callWatch'].unreachedEmailed || {}).length === 1);
      const live = [];
      const S4 = mk();
      for (let i = 0; i < 2; i++) await WATCH.runWatch({ db: mkDb(S4), nowMs: NOW + i * 2 * 3600e3, live: true, push: async () => ({ sent: 1 }), email: async (m) => { live.push(m); } });
      ok('control: a live token sends no "phone did not get it" email', live.filter((m) => /^Your phone did not get/.test(m.subject)).length === 0);
    }
    {
      const S = mk();
      S.failTasks = true;
      const a = await drive(S, NOW);
      ok('failed task read: no invented "promises due" push, and the run says it could not check', a.pushes.filter((p) => p.data && p.data.type === 'promise_due').length === 0 && a.r.promisesCheckFailed === true && S.docs['integrations/callWatch'].promiseCheck.failedAtMs === NOW, a.r);
      const S3 = mk();
      const g = await drive(S3, NOW);
      ok('control: the same data with a working read pushes', g.pushes.some((p) => p.data && p.data.type === 'promise_due') && g.r.promisesCheckFailed === false);
    }
  }

  // ═══ 13. vacuity-audit additions (2026-10-13) ═══════════════════════
  console.log('\n13. audit additions: wiring, once-per-set, tenants, waiting-only');
  {
    const D5 = '2026-10-02';
    // ledger at 20:00 with a failed read is a warning (the 08:00 run has no ledger)
    const S = newState();
    S.docs['users/' + OWNER] = { email: 'jo@example.invalid' };
    S.docs['integrations/callCenter'] = { lastRunAtMs: NOW, lastTranscribeAtMs: NOW, lastRun: { failed: 0 }, lastTranscribe: { failed: 0 } };
    S.failTasks = true;
    const t20 = NOW + 12 * 3600e3;
    await WATCH.runWatch({ db: mkDb(S), nowMs: t20, live: true, push: async () => ({ sent: 1 }), email: async () => {} });
    const led = S.docs['integrations/dailyLedger'];
    ok('20:00 run with a failed task read: the ledger doc carries the promise-tasks warning', !!led && (led.anomalies || []).some((a) => /promise tasks/.test(a)) && led.clear === false, led);
    const S2 = newState();
    S2.docs['users/' + OWNER] = S.docs['users/' + OWNER]; S2.docs['integrations/callCenter'] = S.docs['integrations/callCenter'];
    await WATCH.runWatch({ db: mkDb(S2), nowMs: t20, live: true, push: async () => ({ sent: 1 }), email: async () => {} });
    ok('control: same run, working read: no promise-tasks warning', !(S2.docs['integrations/dailyLedger'].anomalies || []).some((a) => /promise tasks/.test(a)));

    // sweep email carries the failure through runSweep
    const S3 = newState();
    S3.docs['users/' + OWNER] = { email: 'jo@example.invalid' };
    S3.failTasks = true;
    const sent = [];
    const rs = await CC.runSweep({ db: mkDb(S3), live: true, nowMs: NOW, slot: 'pm', absorbed: false, send: async (m) => { sent.push(m); } });
    ok('runSweep with an unreadable task list still sends, and the email says NOT an all-clear', rs.state === 'sent' && sent.length === 1 && /NOT an all-clear/.test(sent[0].text), rs);
    S3.failTasks = false;
    const sent2 = [];
    const rs2 = await CC.runSweep({ db: mkDb(S3), live: true, nowMs: NOW, slot: 'pm', absorbed: false, send: async (m) => { sent2.push(m); } });
    ok('control: working read and nothing owed = no email', rs2.state === 'nothing' && sent2.length === 0, rs2);

    // waiting-only person
    const wp = people([task({ promiseKind: 'waiting', dueDate: TODAY, waitingSince: D5 })]);
    const wx = PCL.ladderExtra(wp[0]);
    ok('a waiting-only person is high-value (HIGH_WHY) so the ladder and the unreached email take them', W.HIGH_WHY.test(wx.why) && wp[0].waitingOnly === true && W.unreachedEmail([wx], NOW) !== null && W.ladderRetells([], [], { [wx.id]: { n: 1, at: NOW - 3 * 3600e3, sig: wx.sig } }, NOW, null, [wx]).length === 1, wx.why);

    // ladderCandidates: task dated ahead, not snoozed -> not a candidate (control: due today is)
    const uc = (o) => Object.assign({ id: 'cq', startedAtMs: NOW - 3600e3, urgent: true, status: 'noted', direction: 'inbound' }, o);
    ok('ladder: an unsnoozed task dated ahead is not re-told yet (control: dated today is)', W.ladderCandidates([uc({ taskDueYmd: TOMORROW })], [], NOW, null).length === 0 && W.ladderCandidates([uc({ taskDueYmd: TODAY })], [], NOW, null).length === 1);

    // parity matrix: parkedUntil server vs Home, including kind promise
    {
      let n = 0, bad = 0;
      ['', 'x', YESTERDAY, TODAY, TOMORROW, '2026-10-20'].forEach((snooze) => ['', TOMORROW, YESTERDAY].forEach((td) => [true, false].forEach((ts) => ['promise', 'note', undefined].forEach((kind) => ['', 'x', TODAY, TOMORROW].forEach((dd) => [true, false].forEach((opt) => {
        const c = { snoozeUntilYmd: snooze, taskDueYmd: td, taskSnoozed: ts, kind, dueDate: dd };
        n++;
        if (W.parkedUntil(c, NOW, { taskDue: opt }) !== HA.parkedUntil(c, NOW, { taskDue: opt })) bad++;
      }))))));
      ok('parkedUntil: server and Home agree on ' + n + ' combinations (kind promise included)', bad === 0, bad);
    }

    // tenant: a rep-owned lead in the company is listed
    ok('tenant: a lead whose userId is a rep but companyId is the owner IS listed', people([task({ leadId: 'L6' })]).length === 1);

    // signature: same task id, different date -> different sig
    const sigOf = (t) => PCL.ladderExtra(people([t])[0]).sig;
    ok('same task id with a different due date is a different signature', sigOf(task({ id: 'z', dueDate: TODAY })) !== sigOf(task({ id: 'z', dueDate: YESTERDAY })) && sigOf(task({ id: 'z', dueDate: TODAY })) === sigOf(task({ id: 'z', dueDate: TODAY })));

    // one person under two ids = one email person
    ok('two alert ids sharing one person key = one person in the email', W.unreachedEmail([{ id: 'call:a', key: 'lead:L1', who: 'Pat', why: 'urgent' }, { id: 'promise:L1', key: 'lead:L1', who: 'Pat', why: 'you promised something' }], NOW).people === 1);

    // overdue promise at the ledger: waiting more than 3 days
    ok('ledger: a promise overdue by 5 days is "waiting more than 3 days" (oldOpen 1; control: due today 0)', W.dailyLedger([], [], NOW, { promisePeople: people([task({ dueDate: D5 })]) }).oldOpen === 1 && W.dailyLedger([], [], NOW, { promisePeople: people([task({})]) }).oldOpen === 0);

    // brief text carries the warning too
    ok('brief TEXT (not only html) carries the failure warning', /WARNING/.test(MB.sectionsText({ promiseCheckFailed: true })) && !/WARNING/.test(MB.sectionsText({ promises: [] })));

    // mergeSweep: the same text twice is listed once
    ok('mergeSweep: two tasks with the same text list it once', PCL.mergeSweep([], people([task({ id: 'a', text: 'Call back' }), task({ id: 'b', text: 'Call back' })]))[0].promises.length === 1);

    // path-derived lead id + the userId filter + foreign tenant rows
    const S4 = newState();
    S4.docs['leads/L1'] = lead();
    S4.docs['leads/L1/tasks/promise-nolead'] = { kind: 'promise', promiseKind: 'callback', text: 'Call back', done: false, dueDate: TODAY, userId: OWNER };
    S4.docs['leads/L2/tasks/promise-foreign'] = { kind: 'promise', promiseKind: 'callback', text: 'Their task', done: false, dueDate: TODAY, userId: 'otherTenant' };
    S4.docs['leads/L2'] = lead({ firstName: 'Sam' });
    const rd = await PC.readDuePromisePeople({ db: mkDb(S4), owner: OWNER, nowMs: NOW, labels: null });
    ok('a task with no leadId field is placed by its path; another user\'s task is not read', rd.ok && rd.people.length === 1 && rd.people[0].leadId === 'L1', rd);
    ok('the read filters on userId == owner (the where() args)', (S4.whereLog || []).some((w) => w[0] === 'tasks' && w[1] === 'userId' && w[2] === '==' && w[3] === OWNER));

    // runWatch: one person already told, one fresh -> the push names only the fresh one
    const S5 = newState();
    S5.docs['users/' + OWNER] = { email: 'jo@example.invalid' };
    S5.docs['integrations/callCenter'] = S.docs['integrations/callCenter'];
    S5.docs['leads/L1'] = lead(); S5.docs['leads/L2'] = lead({ firstName: 'Sam', lastName: 'Ray', phoneDigits: '5135550102' });
    S5.docs['leads/L1/tasks/promise-a'] = { kind: 'promise', promiseKind: 'callback', text: 'Call back', done: false, dueDate: TODAY, userId: OWNER, leadId: 'L1' };
    const pushed = [];
    const go = async (t) => WATCH.runWatch({ db: mkDb(S5), nowMs: t, live: true, push: async (u, title, body, data) => { pushed.push({ title, body, data }); return { sent: 1 }; }, email: async () => {} });
    await go(NOW);
    S5.docs['leads/L2/tasks/promise-b'] = { kind: 'promise', promiseKind: 'estimate', text: 'Send estimate', done: false, dueDate: TODAY, userId: OWNER, leadId: 'L2' };
    await go(NOW + 5 * 60000);
    const pp = pushed.filter((p) => p.data && p.data.type === 'promise_due');
    ok('a person already told is not in the next promise push; the new one is', pp.length === 2 && pp[1].title === '1 promise due today' && /Sam/.test(pp[1].body) && !/Pat/.test(pp[1].body), pp.map((p) => p.body));

    // a CHANGED due set mails again; an unchanged one does not
    const S6 = newState();
    S6.docs['users/' + OWNER] = { email: 'jo@example.invalid' };
    S6.docs['integrations/callCenter'] = S.docs['integrations/callCenter'];
    S6.docs['leads/L1'] = lead();
    S6.docs['leads/L1/tasks/promise-a'] = { kind: 'promise', promiseKind: 'callback', text: 'Call back', done: false, dueDate: TODAY, userId: OWNER, leadId: 'L1' };
    const mails = [];
    const dead = async (t) => WATCH.runWatch({ db: mkDb(S6), nowMs: t, live: true, push: async () => ({ sent: 0, failed: 1, errors: [] }), email: async (m) => { mails.push(m); } }).catch(() => null);
    await dead(NOW); await dead(NOW + 2 * 3600e3);
    const before = mails.length;
    S6.docs['leads/L1/tasks/promise-b'] = { kind: 'promise', promiseKind: 'estimate', text: 'Send estimate', done: false, dueDate: TODAY, userId: OWNER, leadId: 'L1' };
    await dead(NOW + 4 * 3600e3);
    ok('unreached: an unchanged set mails once; a CHANGED set of due tasks mails again', before === 1 && mails.length === 2, mails.map((m) => m.subject));

    // rung-3 ladder email and the unreached email are not both sent for one person
    const S7 = newState();
    S7.docs['users/' + OWNER] = { email: 'jo@example.invalid' };
    S7.docs['integrations/callCenter'] = S.docs['integrations/callCenter'];
    S7.cols.phone_calls.push({ id: 'cube_r3', userId: OWNER, leadId: 'L1', contactName: 'Pat Lee', phoneDigits: '5135550101', status: 'noted', urgent: true, direction: 'inbound', startedAtMs: NOW - 5 * 3600e3, createdAtMs: NOW - 5 * 3600e3, notedAtMs: NOW - 5 * 3600e3 });
    S7.docs['integrations/callWatch'] = { lastCheckAtMs: NOW - 2 * 3600e3, ladder: { 'call:cube_r3': { n: 2, at: NOW - 3 * 3600e3 } }, toldIds: ['call:cube_r3'] };
    const m7 = [];
    await WATCH.runWatch({ db: mkDb(S7), nowMs: NOW, live: true, push: async () => ({ sent: 0, failed: 1, errors: [] }), email: async (m) => { m7.push(m); } }).catch(() => null);
    ok('rung 3 + dead push: ONE email for the person (the ladder\'s), not two', m7.length === 1 && /^Still open/.test(m7[0].subject), m7.map((m) => m.subject));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
