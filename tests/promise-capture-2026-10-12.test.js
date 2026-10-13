/**
 * tests/promise-capture-2026-10-12.test.js — Promise capture + Waiting-on-them
 * (documentation/projects/PROMISE-CAPTURE-2026-10-12.md).
 *
 *   1. promise-logic.js (client, pure): chips, dates, the task shape, the only
 *      two exits, the miss count, the waiting clock, the Nudge words
 *   2. parity: functions/promise-logic.js answers exactly what the client does
 *   3. today-plan.js: the Promises section and the Waiting group
 *   4. callCenterAction 'promise' / 'promiseMove' (functions/call-center.js)
 *   5. the wiring: delegates, the customer page, the delete guard, the bundle
 *
 * In-memory Firestore; names / numbers invented (555).
 * Run: node tests/promise-capture-2026-10-12.test.js (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PL = require(path.join(ROOT, 'docs', 'pro', 'js', 'promise-logic.js'));
const SPL = require(path.join(ROOT, 'functions', 'promise-logic.js'));
const TP = require(path.join(ROOT, 'docs', 'pro', 'js', 'today-plan.js'));
const SW = require(path.join(ROOT, 'docs', 'pro', 'js', 'schedule-window.js'));
const HA = require(path.join(ROOT, 'docs', 'pro', 'js', 'home-attention.js'));
const M = require(path.join(ROOT, 'functions', 'call-center.js'));
const AM = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const PX = require(path.join(ROOT, 'functions', 'pixel-draft-logic.js'));
const { callAction, COLLECTION } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const J = (v) => JSON.stringify(v);

const NOW = new Date(2026, 9, 12, 10, 0, 0).getTime();   // Mon 2026-10-12, local
const TODAY = '2026-10-12';

(async () => {
  console.log('\n1. promise-logic (client)');
  ok('six chips, in the order Jo named them', J(PL.KIND_KEYS) === J(['callback', 'estimate', 'text', 'order', 'permit', 'waiting']));
  ok('chip labels are the words on the sheet', PL.KINDS.callback.label === 'Call back' && PL.KINDS.estimate.label === 'Send estimate' && PL.KINDS.text.label === 'Text by 5pm'
    && PL.KINDS.order.label === 'Order materials' && PL.KINDS.permit.label === 'Check on permit' && PL.KINDS.waiting.label === 'Waiting on them');
  ok('"Nothing owed" is not a task kind (no task for it)', !PL.isKind('none') && !PL.isKind('nothing'));
  ok('isKind refuses prototype keys', !PL.isKind('__proto__') && !PL.isKind('constructor') && !PL.isKind('toString'));
  ok('due chips: today / tomorrow / +3 / +1 week', J(PL.DUE_CHIPS.map((c) => PL.dueFromChip(c.id, TODAY))) === J(['2026-10-12', '2026-10-13', '2026-10-15', '2026-10-19']));
  ok('unknown due chip -> empty (never "today" by accident)', PL.dueFromChip('nope', TODAY) === '');
  ok('addDaysYmd crosses a month and a year end', PL.addDaysYmd('2026-10-30', 3) === '2026-11-02' && PL.addDaysYmd('2026-12-30', 3) === '2027-01-02');
  ok('defaults: callback today, estimate tomorrow, text today, permit +3', PL.defaultDue('callback', TODAY) === TODAY && PL.defaultDue('estimate', TODAY) === '2026-10-13'
    && PL.defaultDue('text', TODAY) === TODAY && PL.defaultDue('permit', TODAY) === '2026-10-15');
  ok('waiting default is today + the setting (3 by default, clamped 1..14)', PL.defaultDue('waiting', TODAY) === '2026-10-15' && PL.defaultDue('waiting', TODAY, 5) === '2026-10-17'
    && PL.defaultDue('waiting', TODAY, 99) === '2026-10-26' && PL.defaultDue('waiting', TODAY, 0) === '2026-10-13' && PL.defaultDue('waiting', TODAY, 'x') === '2026-10-15');
  ok('a date in the past is refused', PL.dueProblem('2026-10-11', TODAY) !== '');
  ok('not a real date is refused (2026-02-30)', PL.dueProblem('2026-02-30', TODAY) !== '' && !PL.isYmd('2026-02-30') && !PL.isYmd('') && !PL.isYmd(null));
  ok('more than 120 days out is refused; 120 exactly is fine', PL.dueProblem(PL.addDaysYmd(TODAY, 121), TODAY) !== '' && PL.dueProblem(PL.addDaysYmd(TODAY, 120), TODAY) === '');
  ok('today itself is a valid due date', PL.dueProblem(TODAY, TODAY) === '');
  ok('chipForDue maps a date back to its chip, else pick', PL.chipForDue('2026-10-13', TODAY) === 'tomorrow' && PL.chipForDue('2026-10-30', TODAY) === 'pick');

  const t0 = PL.buildTask({ kind: 'estimate', why: 'quoted the number, text it Friday', todayYmd: TODAY, uid: 'jo', source: 'today', sourceCallId: 'cube_AAAAA1' });
  ok('buildTask: a promise task with the legacy text', t0.kind === 'promise' && t0.promiseKind === 'estimate' && t0.text === 'Send estimate - quoted the number, text it Friday' && t0.done === false);
  ok('buildTask: due defaults per kind, counters start at zero', t0.dueDate === '2026-10-13' && t0.missCount === 0 && t0.rescheduleCount === 0 && t0.madeYmd === TODAY && t0.madeBy === 'jo');
  ok('buildTask: provenance kept (source, sourceCallId)', t0.source === 'today' && t0.sourceCallId === 'cube_AAAAA1');
  ok('buildTask: a waiting promise carries who / since / nudges', (() => {
    const w = PL.buildTask({ kind: 'waiting', waitingOn: 'adjuster', todayYmd: TODAY });
    return w.waitingOn === 'adjuster' && w.waitingSince === TODAY && w.nudgeCount === 0 && w.dueDate === '2026-10-15' && w.text === 'Waiting on the adjuster';
  })());
  ok('buildTask: unknown waitingOn falls back to customer, never undefined', PL.buildTask({ kind: 'waiting', waitingOn: 'wizard', todayYmd: TODAY }).waitingOn === 'customer');
  ok('buildTask: "Text by 5pm" carries dueBy 17:00', PL.buildTask({ kind: 'text', todayYmd: TODAY }).dueBy === '17:00' && PL.buildTask({ kind: 'callback', todayYmd: TODAY }).dueBy === null);
  ok('buildTask refuses a bad kind / a past date (no half task)', !!PL.buildTask({ kind: 'none', todayYmd: TODAY }).error && !!PL.buildTask({ kind: 'callback', dueYmd: '2026-10-01', todayYmd: TODAY }).error);
  ok('why: markup and control characters stripped, 140 cap', PL.cleanWhy('<b>hi</b>\n\tthere<script>') === 'hi there' && PL.cleanWhy('x'.repeat(300)).length === 140);

  ok('isOwedNow: due today and overdue yes, tomorrow no, done no, waiting no', (() => {
    const mk = (o) => Object.assign({ kind: 'promise', promiseKind: 'callback', done: false }, o);
    return PL.isOwedNow(mk({ dueDate: TODAY }), TODAY) && PL.isOwedNow(mk({ dueDate: '2026-10-01' }), TODAY)
      && !PL.isOwedNow(mk({ dueDate: '2026-10-13' }), TODAY) && !PL.isOwedNow(mk({ dueDate: TODAY, done: true }), TODAY)
      && !PL.isOwedNow(mk({ dueDate: TODAY, promiseKind: 'waiting' }), TODAY) && !PL.isOwedNow({ text: 'plain', dueDate: TODAY }, TODAY);
  })());

  const over = { kind: 'promise', promiseKind: 'callback', dueDate: '2026-10-09', missCount: 1, rescheduleCount: 1, done: false };
  ok('move: a new date is required', PL.moveProblem(over, '', TODAY) !== '' && PL.moveProblem(over, 'soon', TODAY) !== '');
  ok('move: the date it already has is refused (a future one, so only this rule can catch it)',
    PL.moveProblem({ kind: 'promise', dueDate: '2026-10-20' }, '2026-10-20', TODAY) !== '' && PL.moveProblem({ kind: 'promise', dueDate: '2026-10-20' }, '2026-10-21', TODAY) === '');
  ok('move: a past date is refused', PL.moveProblem(over, '2026-10-10', TODAY) !== '');
  ok('move: a valid date is accepted', PL.moveProblem(over, '2026-10-14', TODAY) === '');
  ok('move an OVERDUE promise -> missCount + 1, reschedule + 1', (() => { const p = PL.movePatch(over, '2026-10-14', TODAY); return p.missCount === 2 && p.rescheduleCount === 2 && p.dueDate === '2026-10-14' && p.overdueNotified === false; })());
  ok('move a promise due TODAY is a move, not a miss', (() => { const p = PL.movePatch({ kind: 'promise', promiseKind: 'callback', dueDate: TODAY, missCount: 0, rescheduleCount: 0 }, '2026-10-13', TODAY); return p.missCount === 0 && p.rescheduleCount === 1; })());
  ok('move a promise early is a move, not a miss', PL.movePatch({ kind: 'promise', promiseKind: 'callback', dueDate: '2026-10-20', missCount: 0 }, '2026-10-14', TODAY).missCount === 0);
  ok('missLabel: none / missed 1 time / missed 3 times / moved 3 times', PL.missLabel({}) === '' && PL.missLabel({ missCount: 1 }) === 'missed 1 time'
    && PL.missLabel({ missCount: 3 }) === 'missed 3 times' && PL.missLabel({ rescheduleCount: 3 }) === 'moved 3 times' && PL.missLabel({ rescheduleCount: 1 }) === '');
  ok('missIsHot from the second miss / the fourth move', !PL.missIsHot({ missCount: 1 }) && PL.missIsHot({ missCount: 2 }) && !PL.missIsHot({ rescheduleCount: 3 }) && PL.missIsHot({ rescheduleCount: 4 }));
  ok('kept / dead patches: done + a distinct outcome', J(PL.keptPatch()) === J({ done: true, outcome: 'kept' }) && J(PL.deadPatch()) === J({ done: true, outcome: 'dead' }));

  console.log('\n   waiting clock');
  const wt = (since, extra) => Object.assign({ kind: 'promise', promiseKind: 'waiting', done: false, waitingSince: since, dueDate: PL.addDaysYmd(since, 3) }, extra || {});
  ok('2 days waited, N=3: not ripe', !PL.isRipe(wt('2026-10-10'), TODAY, 3));
  ok('3 days waited, N=3: ripe', PL.isRipe(wt('2026-10-09'), TODAY, 3));
  // 2026-10-13: an item's own "Nudge me on" date wins (see the never-forget-client test); N is the clock for an item with no date.
  const wtNoDate = (since, extra) => Object.assign(wt(since, extra), { dueDate: undefined });
  ok('N is the setting for an undated item: 3 days waited, N=5 not ripe; 5 days waited ripe', !PL.isRipe(wtNoDate('2026-10-09'), TODAY, 5) && PL.isRipe(wtNoDate('2026-10-07'), TODAY, 5));
  ok('a done / dead waiting item is never ripe', !PL.isRipe(wt('2026-10-01', { done: true }), TODAY, 3));
  ok('only waiting promises ripen (a callback promise is not "waiting")', !PL.isRipe({ kind: 'promise', promiseKind: 'callback', waitingSince: '2026-10-01', done: false }, TODAY, 3));
  ok('Still waiting: clock restarts today, next nudge today + N, dated', (() => { const p = PL.stillWaitingPatch(wt('2026-10-01'), TODAY, 3); return p.waitingSince === TODAY && p.dueDate === '2026-10-15' && p.stillWaitingCount === 1; })());
  ok('Nudge patch counts only when recorded', J(PL.nudgePatch({ nudgeCount: 1 }, TODAY)) === J({ nudgeCount: 2, lastNudgedYmd: TODAY }));
  ok('moving a waiting nudge date does not restart the wait', PL.movePatch(wt('2026-10-01'), '2026-10-20', TODAY).waitingSince === '2026-10-01');

  console.log('\n   Nudge words');
  const drafts = [];
  PL.WAITING_ON_KEYS.forEach((k) => drafts.push(PL.nudgeDraft({ waitingOn: k, recipientName: 'Dana Whitfield', from: 'Jo with No Big Deal', claimNumber: 'CLM-7781' })));
  drafts.push(PL.nudgeDraft({}));
  ok('every template is a text, with the first name only', drafts.every((d) => d.channel === 'text' && !/Whitfield/.test(d.text)) && /^Hi Dana,/.test(drafts[0].text));
  ok('no template says a price, coverage, deductible, handling a claim, a guarantee (pixel-draft forbidden list)', drafts.every((d) => !PX.FORBIDDEN_IN_TEMPLATE.test(d.text.replace(/CLM-7781/, ''))),
    drafts.map((d) => d.text).filter((t) => PX.FORBIDDEN_IN_TEMPLATE.test(t.replace(/CLM-7781/, ''))).join(' | '));
  ok('no template trips the Kentucky claim-wording gate', drafts.every((d) => AM.claimWordingProblem(d.text) === null));
  ok('no template carries a dollar sign or link', drafts.every((d) => !/\$|https?:/.test(d.text)));
  ok('the adjuster nudge names only the claim number the lead carries', /CLM-7781/.test(drafts[WAITING_IDX('adjuster')].text) && !/CLM/.test(drafts[WAITING_IDX('customer')].text));
  ok('merge fields are sanitised (markup in a name or claim number)', (() => {
    const d = PL.nudgeDraft({ waitingOn: 'adjuster', recipientName: '<img src=x>Bob', from: 'Jo <b>NBD</b>', claimNumber: '12<script>' });
    return !/[<>]/.test(d.text);
  })());
  function WAITING_IDX(k) { return PL.WAITING_ON_KEYS.indexOf(k); }

  console.log('\n2. server twin parity');
  ok('same kinds, due rules and labels as the client', PL.KIND_KEYS.every((k) => SPL.KINDS[k] && SPL.KINDS[k].task === PL.KINDS[k].task && !!SPL.KINDS[k].dueBy === !!PL.KINDS[k].dueBy) && Object.keys(SPL.KINDS).length === PL.KIND_KEYS.length);
  const table = [
    { kind: 'callback', todayYmd: TODAY, uid: 'u', source: 'call', sourceCallId: 'cube_AAAAA' },
    { kind: 'estimate', why: 'quoted <b>14k</b>', todayYmd: TODAY, uid: 'u', source: 'today' },
    { kind: 'text', dueYmd: '2026-10-12', todayYmd: TODAY, uid: 'u', source: 'text', sourceCallId: 'txt_20261012' },
    { kind: 'order', dueYmd: '2026-12-01', todayYmd: TODAY },
    { kind: 'permit', todayYmd: TODAY, source: 'bogus' },
    { kind: 'waiting', waitingOn: 'supplier', waitingDays: 5, todayYmd: TODAY, uid: 'u' },
    { kind: 'waiting', waitingOn: 'bogus', todayYmd: TODAY },
    { kind: 'none', todayYmd: TODAY },
    { kind: 'callback', dueYmd: '2026-10-01', todayYmd: TODAY },
    { kind: 'callback', dueYmd: '2027-06-01', todayYmd: TODAY },
    { kind: 'callback', todayYmd: 'nope' },
  ];
  ok('buildTask: client and server agree on every row', table.every((r) => J(PL.buildTask(r)) === J(SPL.buildTask(r))), table.map((r) => J(PL.buildTask(r)) === J(SPL.buildTask(r)) ? '' : J(r)).join(''));
  const moves = [[over, '2026-10-14'], [over, '2026-10-09'], [over, '2026-10-01'], [{ kind: 'promise', promiseKind: 'waiting', dueDate: TODAY, waitingSince: '2026-10-05' }, '2026-10-20'], [{ dueDate: '2026-10-20' }, '2026-10-14']];
  ok('moveProblem / movePatch: client and server agree', moves.every(([t, to]) => PL.moveProblem(t, to, TODAY) === SPL.moveProblem(t, to, TODAY) && J(PL.movePatch(t, to, TODAY)) === J(SPL.movePatch(t, to, TODAY))));
  ok('dueProblem / defaultDue / cleanWhy agree', ['2026-10-11', '2026-10-12', '2027-06-01', 'x'].every((d) => PL.dueProblem(d, TODAY) === SPL.dueProblem(d, TODAY))
    && PL.KIND_KEYS.every((k) => PL.defaultDue(k, TODAY, 4) === SPL.defaultDue(k, TODAY, 4)) && PL.cleanWhy('<i>a</i>\nb') === SPL.cleanWhy('<i>a</i>\nb'));

  console.log('\n3. the Today plan');
  const lead = (id, o) => Object.assign({ id, firstName: id, lastName: 'Test', phone: '(513) 555-01' + String(id.length).padStart(2, '0'), stage: 'estimate_submitted' }, o || {});
  const leads = [lead('Dana', { phone: '(513) 555-0111', email: 'd@example.test' }), lead('Eli', { phone: '(513) 555-0122' }), lead('Fay', { phone: '(513) 555-0133' }), lead('Gus', { phone: '(513) 555-0144', adjusterPhone: '(513) 555-0199', adjusterName: 'Ann Adjuster', claimNumber: 'CLM-9' })];
  const prom = (leadId, id, o) => Object.assign({ id, kind: 'promise', promiseKind: 'estimate', text: 'Send estimate - why', why: 'quoted 14k', done: false, dueDate: TODAY, missCount: 0, rescheduleCount: 0 }, o || {});
  const build = (extra) => TP.buildTodayPlan(Object.assign({ now: NOW, leads, SW, PL, tasksByLead: {}, callGroups: [], waitingDays: 3 }, extra));
  let p = build({ tasksByLead: { Dana: [prom('Dana', 'p1')], Eli: [prom('Eli', 'p2', { dueDate: '2026-10-08', missCount: 2, rescheduleCount: 2 })], Fay: [prom('Fay', 'p3', { dueDate: '2026-10-14' })] } });
  ok('a due promise is its own item in promises, not in promised', p.promises.length === 2 && p.promised.length === 0);
  ok('a promise due in the future is not on Today', !p.promises.some((r) => r.leadId === 'Fay'));
  ok('overdue + chronic sorts first, with "missed 2 times"', p.promises[0].leadId === 'Eli' && p.promises[0].promiseTasks[0].missLabel === 'missed 2 times' && p.promises[0].promiseTasks[0].hot === true && p.promises[0].promiseTasks[0].overdue === true);
  ok('the row carries the why in its line', /quoted 14k/.test(p.promises[1].promiseTasks[0].text) && p.promises[1].promiseTasks[0].why === 'quoted 14k');
  ok('promises count in "N things today"', p.total === 2);
  ok('a person with a promise is not also stalled / on calls', (() => {
    const q = build({ leads: leads.map((l) => l.id === 'Dana' ? Object.assign({}, l, { followUp: '2026-10-01' }) : l), tasksByLead: { Dana: [prom('Dana', 'p1')] } });
    return q.promises.length === 1 && q.stalled.length === 0;
  })());
  ok('a snoozed lead still shows its promise (promises ignore snooze)', build({ isSnoozed: () => true, tasksByLead: { Dana: [prom('Dana', 'p1'), { id: 'plain', text: 'plain task', dueDate: TODAY, done: false }] } }).promises.length === 1);
  ok('...while a snoozed lead\'s ordinary task waits, as before', build({ isSnoozed: () => true, tasksByLead: { Dana: [{ id: 'plain', text: 'plain task', dueDate: TODAY, done: false }] } }).promised.length === 0);
  ok('a done promise is gone', build({ tasksByLead: { Dana: [prom('Dana', 'p1', { done: true, outcome: 'kept' })] } }).promises.length === 0);
  ok('a person\'s open call merges into the promise row (one row per person)', (() => {
    const call = { id: 'cube_AAAAA1', leadId: 'Dana', startedAtMs: NOW - 3600000, summary: 'asked about price', promises: [{ who: 'jo', text: 'text the number' }] };
    const q = build({ callGroups: HA.groupNeeds([call], NOW), tasksByLead: { Dana: [prom('Dana', 'p1')] } });
    return q.promises.length === 1 && q.calls.length === 0 && q.promises[0].callIds.indexOf('cube_AAAAA1') !== -1 && q.total === 1;
  })());
  ok('ordinary tasks keep their own section, unchanged', (() => {
    const q = build({ tasksByLead: { Dana: [{ id: 't1', text: 'Plain', dueDate: TODAY, done: false }] } });
    return q.promised.length === 1 && q.promises.length === 0 && q.promised[0].tasks[0].id === 't1';
  })());
  ok('a plain due task on a promise person rides on the same row', (() => {
    const q = build({ tasksByLead: { Dana: [prom('Dana', 'p1'), { id: 't1', text: 'Plain', dueDate: TODAY, done: false }] } });
    return q.promises.length === 1 && q.promises[0].tasks.length === 1 && q.promises[0].tasks[0].id === 't1';
  })());
  ok('a hidden number is TAGGED, not dropped', (() => {
    const q = build({ isHiddenNumber: (d) => d === '5135550111', tasksByLead: { Dana: [prom('Dana', 'p1')], Eli: [prom('Eli', 'p2')] } });
    const dana = q.promises.filter((r) => r.leadId === 'Dana')[0], eli = q.promises.filter((r) => r.leadId === 'Eli')[0];
    return q.promises.length === 2 && dana.hiddenNumber === true && eli.hiddenNumber === false;
  })());
  ok('without promise-logic loaded, promise tasks degrade to ordinary tasks (never vanish)', (() => {
    const q = TP.buildTodayPlan({ now: NOW, leads, SW, PL: false, tasksByLead: { Dana: [prom('Dana', 'p1')] }, callGroups: [] });
    return q.promises.length + q.promised.length === 1;
  })());
  ok('an unfiled call carrying a promise shows it on its call row', (() => {
    const call = { id: 'cube_BBBBB2', startedAtMs: NOW - 3600000, phoneDigits: '5135550177', followUpDate: TODAY, status: 'noted', bucket: 'unknown', contactName: 'Unknown',
      promise: { kind: 'promise', promiseKind: 'callback', text: 'Call back - asked for a quote', why: 'asked for a quote', dueDate: TODAY, missCount: 1, done: false } };
    const q = build({ callGroups: HA.groupNeeds([call], NOW) });
    return q.calls.length === 1 && q.calls[0].promise && q.calls[0].promise.callId === 'cube_BBBBB2' && q.calls[0].promise.missLabel === 'missed 1 time';
  })());

  console.log('\n   waiting group');
  const W = (id, since, o) => Object.assign({ id, kind: 'promise', promiseKind: 'waiting', text: 'Waiting on the adjuster', why: 'inspection date', done: false, waitingOn: 'adjuster', waitingSince: since, dueDate: PL.addDaysYmd(since, 3), nudgeCount: 0 }, o || {});
  p = build({ tasksByLead: { Gus: [W('w1', '2026-10-08'), W('w2', '2026-10-11', { waitingOn: 'supplier' })] } });
  ok('a ripe waiting item sits in the waiting group; an unripe one does not', p.waiting.length === 1 && p.waiting[0].taskId === 'w1' && p.waiting[0].days === 4);
  ok('the waiting row carries who / claim number / adjuster phone for the nudge', p.waiting[0].waitingOn === 'adjuster' && p.waiting[0].claimNumber === 'CLM-9' && p.waiting[0].adjusterPhone === '5135550199' && p.waiting[0].adjusterName === 'Ann Adjuster');
  ok('waiting is NOT owed today: not in total, not in promises or promised', p.total === 0 && p.promises.length === 0 && p.promised.length === 0);
  ok('a waiting item with its own dueDate past does not leak into Promised', build({ tasksByLead: { Gus: [W('w3', '2026-10-01')] } }).promised.length === 0);
  const WND = (id, since) => Object.assign(W(id, since), { dueDate: undefined });
  ok('the setting moves the threshold for an undated item (N=5: 4 days is not ripe; N=2: 3 days is)', build({ waitingDays: 5, tasksByLead: { Gus: [WND('w1', '2026-10-08')] } }).waiting.length === 0
    && build({ waitingDays: 2, tasksByLead: { Gus: [WND('w1', '2026-10-09')] } }).waiting.length === 1);
  ok('a dated item ignores the setting: its Nudge-me-on date is the threshold', build({ waitingDays: 5, tasksByLead: { Gus: [W('w1', '2026-10-08')] } }).waiting.length === 1);
  ok('a dead / kept waiting item leaves the group', build({ tasksByLead: { Gus: [W('w1', '2026-10-01', { done: true, outcome: 'dead' })] } }).waiting.length === 0);
  ok('"Still waiting" (since reset to today) takes it off the group', build({ tasksByLead: { Gus: [W('w1', TODAY)] } }).waiting.length === 0);
  ok('oldest wait first', (() => {
    const q = build({ tasksByLead: { Gus: [W('a', '2026-10-05'), W('b', '2026-10-01')], Dana: [W('c', '2026-10-08', { waitingOn: 'customer' })] } });
    return q.waiting.map((r) => r.taskId).join() === 'b,a,c';
  })());
  ok('handled (optimistic) hides a waiting row at once', build({ handled: new Set(['wait:Gus/w1']), tasksByLead: { Gus: [W('w1', '2026-10-01')] } }).waiting.length === 0);

  console.log('\n4. callCenterAction promise / promiseMove');
  function fakeDb(seed) {
    const docs = new Map(Object.entries(seed));
    const mk = (pth) => ({
      id: pth.split('/').pop(), path: pth,
      get: async () => ({ exists: docs.has(pth), data: () => docs.get(pth) }),
      set: async (v, o) => { docs.set(pth, o && o.merge ? Object.assign({}, docs.get(pth) || {}, v) : v); },
      create: async (v) => { if (docs.has(pth)) { const e = new Error('already exists'); e.code = 6; throw e; } docs.set(pth, v); },
      delete: async () => { docs.delete(pth); },
    });
    return { docs, doc: mk, collection: (n) => ({ doc: (id) => mk(n + '/' + id) }) };
  }
  const OWN = 'owner1';
  const seed = () => ({
    [COLLECTION + '/cube_AAAAA1']: { userId: OWN, companyId: 'co1', phoneDigits: '5135550111', contactName: 'Dana Test', status: 'noted', leadId: 'L1', startedAtMs: NOW, summary: 'Wants a number.', promises: [{ who: 'jo', text: 'Text the estimate' }] },
    [COLLECTION + '/cube_BBBBB2']: { userId: OWN, companyId: 'co1', phoneDigits: '5135550199', status: 'noted', bucket: 'unknown', startedAtMs: NOW },
    'phone_text_days/txt_2026101200': { userId: OWN, companyId: 'co1', phoneDigits: '5135550111', leadId: 'L1', status: 'noted', startedAtMs: NOW },
    'leads/L1': { userId: OWN, companyId: 'co1', firstName: 'Dana', phone: '(513) 555-0111' },
    'leads/X1': { userId: 'other', companyId: 'co2', firstName: 'Not yours' },
    'leads/L1/tasks/cube-cube_AAAAA1': { text: 'Text the estimate (Dana Test)', done: false, dueDate: '2026-10-12', source: 'cube-acr' },
  });
  const owner = { uid: OWN, token: {} };
  const callNow = Date.parse('2026-10-12T14:00:00Z');       // 10:00 ET, same day as TODAY
  const run = async (db, auth, data) => { try { return { r: await callAction({ db, auth, data, nowMs: callNow }) }; } catch (e) { return { e }; } };
  let db = fakeDb(seed());
  let x = await run(db, owner, { id: 'cube_AAAAA1', action: 'promise', kind: 'estimate', dueYmd: '2026-10-14', why: 'Quoted 14k, text it Friday' });
  const task = db.docs.get('leads/L1/tasks/promise-cube_AAAAA1');
  ok('promise on a filed call -> ok, a task on the lead', x.r && x.r.ok === true && x.r.on === 'task' && x.r.taskId === 'promise-cube_AAAAA1' && !!task);
  ok('the task is a dated, owned promise tied to the call', task.kind === 'promise' && task.promiseKind === 'estimate' && task.dueDate === '2026-10-14' && task.leadId === 'L1'
    && task.userId === OWN && task.companyId === 'co1' && task.phoneCallId === 'cube_AAAAA1' && task.done === false && task.why === 'Quoted 14k, text it Friday' && task.title === task.text);
  ok('the call is handled by the promise', !!db.docs.get(COLLECTION + '/cube_AAAAA1').handledAtMs && db.docs.get(COLLECTION + '/cube_AAAAA1').promiseTaskId === 'promise-cube_AAAAA1');
  ok('the generic follow-up task is retired as superseded (not owed twice)', db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').done === true && db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').supersededBy === 'promise-cube_AAAAA1');
  // idempotent + history kept
  db.docs.set('leads/L1/tasks/promise-cube_AAAAA1', Object.assign({}, task, { missCount: 2, rescheduleCount: 3, done: true, outcome: 'kept' }));
  x = await run(db, owner, { id: 'cube_AAAAA1', action: 'promise', kind: 'callback', dueYmd: '2026-10-15', why: 'changed my mind' });
  const again = db.docs.get('leads/L1/tasks/promise-cube_AAAAA1');
  ok('choosing again from the same call edits the same task (one id), keeps the miss history', x.r.ok && again.promiseKind === 'callback' && again.dueDate === '2026-10-15' && again.missCount === 2 && again.rescheduleCount === 3);
  ok('...and reopens it (a re-promise is not a done promise)', again.done === false && again.outcome === null);
  ok('a text day promise supersedes sms-<id>, id promise-<txt id>', await (async () => {
    const d2 = fakeDb(Object.assign(seed(), { 'leads/L1/tasks/sms-txt_2026101200': { done: false, dueDate: TODAY } }));
    const r = await run(d2, owner, { id: 'txt_2026101200', action: 'promise', kind: 'text', why: 'by 5' });
    return r.r && r.r.ok && d2.docs.get('leads/L1/tasks/promise-txt_2026101200').source === 'text' && d2.docs.get('leads/L1/tasks/promise-txt_2026101200').dueBy === '17:00'
      && d2.docs.get('leads/L1/tasks/sms-txt_2026101200').supersededBy === 'promise-txt_2026101200';
  })());
  const bad = async (d, data, auth) => (await run(d, auth || owner, Object.assign({ id: 'cube_AAAAA1', action: 'promise' }, data))).e;
  db = fakeDb(seed());
  ok('a bad kind is refused (and "none" is not a promise)', (await bad(db, { kind: 'none' })).code === 'invalid-argument' && (await bad(db, { kind: 'bogus' })).code === 'invalid-argument');
  ok('a past date is refused, nothing written', (await bad(db, { kind: 'callback', dueYmd: '2026-10-01' })).code === 'invalid-argument' && !db.docs.get('leads/L1/tasks/promise-cube_AAAAA1'));
  ok('a date 200 days out is refused', (await bad(db, { kind: 'callback', dueYmd: '2027-05-01' })).code === 'invalid-argument');
  ok('a viewer is refused', (await bad(db, { kind: 'callback' }, { uid: 'v', token: { role: 'viewer', companyId: 'co1' } })).code === 'permission-denied');
  ok('another tenant is refused', (await bad(db, { kind: 'callback' }, { uid: 'z', token: { role: 'company_admin', companyId: 'co9' } })).code === 'permission-denied');
  ok('a lead of another company is refused', await (async () => {
    const d3 = fakeDb(Object.assign(seed(), { [COLLECTION + '/cube_AAAAA1']: Object.assign({}, seed()[COLLECTION + '/cube_AAAAA1'], { leadId: 'X1' }) }));
    const e = (await run(d3, owner, { id: 'cube_AAAAA1', action: 'promise', kind: 'callback' })).e;
    return e && e.code === 'permission-denied' && !d3.docs.get('leads/X1/tasks/promise-cube_AAAAA1');
  })());
  ok('company_admin of the same company may', (await run(db, { uid: 'adm', token: { role: 'company_admin', companyId: 'co1' } }, { id: 'cube_AAAAA1', action: 'promise', kind: 'callback' })).r.ok === true);
  // unfiled
  db = fakeDb(seed());
  x = await run(db, owner, { id: 'cube_BBBBB2', action: 'promise', kind: 'callback', dueYmd: '2026-10-14', why: 'asked for a quote' });
  const uc = db.docs.get(COLLECTION + '/cube_BBBBB2');
  ok('an unfiled call keeps the promise on the call and stays OPEN', x.r.ok && x.r.on === 'call' && uc.promise.kind === 'promise' && uc.promise.promiseKind === 'callback' && !uc.handledAtMs);
  ok('...riding the follow-up date rule needs-you already reads, snoozed until then', uc.followUpDate === '2026-10-14' && uc.snoozeUntilYmd === '2026-10-14');
  ok('...and needs-you (the shared rule) says so on that date, not before', HA.callNeedsYou(Object.assign({}, uc, { startedAtMs: Date.parse('2026-10-12T14:00:00Z') }), Date.parse('2026-10-14T15:00:00Z'), { reachedAt: new Map() }) === true
    && HA.callNeedsYou(Object.assign({}, uc, { bucket: 'x', startedAtMs: Date.parse('2026-10-12T14:00:00Z') }), Date.parse('2026-10-13T15:00:00Z'), { reachedAt: new Map() }) === false);
  ok('"waiting" needs a customer: refused for an unfiled call', (await run(fakeDb(seed()), owner, { id: 'cube_BBBBB2', action: 'promise', kind: 'waiting' })).e.code === 'failed-precondition');
  ok('promise due today on an unfiled call is not snoozed', await (async () => {
    const d4 = fakeDb(seed());
    await run(d4, owner, { id: 'cube_BBBBB2', action: 'promise', kind: 'callback', dueYmd: '2026-10-12' });
    return d4.docs.get(COLLECTION + '/cube_BBBBB2').snoozeUntilYmd === null;
  })());
  // promiseMove
  const moved = await run(db, owner, { id: 'cube_BBBBB2', action: 'promiseMove', dueYmd: '2026-10-20' });
  const mc = db.docs.get(COLLECTION + '/cube_BBBBB2');
  ok('promiseMove: new date on the call, reschedule counted, snoozed to it', moved.r.ok && mc.promise.dueDate === '2026-10-20' && mc.promise.rescheduleCount === 1 && mc.followUpDate === '2026-10-20' && mc.snoozeUntilYmd === '2026-10-20');
  ok('promiseMove: same date / past date / no promise are refused', (await run(db, owner, { id: 'cube_BBBBB2', action: 'promiseMove', dueYmd: '2026-10-20' })).e.code === 'invalid-argument'
    && (await run(db, owner, { id: 'cube_BBBBB2', action: 'promiseMove', dueYmd: '2026-10-01' })).e.code === 'invalid-argument'
    && (await run(fakeDb(seed()), owner, { id: 'cube_BBBBB2', action: 'promiseMove', dueYmd: '2026-10-20' })).e.code === 'failed-precondition');
  ok('promiseMove: an overdue call promise counts a miss', await (async () => {
    const d5 = fakeDb(seed());
    const c = seed()[COLLECTION + '/cube_BBBBB2'];
    d5.docs.set(COLLECTION + '/cube_BBBBB2', Object.assign({}, c, { promise: Object.assign(PL.buildTask({ kind: 'callback', dueYmd: '2026-10-12', todayYmd: '2026-10-12' }), { dueDate: '2026-10-09' }) }));
    const r = await run(d5, owner, { id: 'cube_BBBBB2', action: 'promiseMove', dueYmd: '2026-10-14' });
    return r.r.ok && r.r.missCount === 1 && d5.docs.get(COLLECTION + '/cube_BBBBB2').promise.missCount === 1;
  })());

  console.log('\n5. wiring');
  const home = read('docs/pro/js/today-home.js'), ui = read('docs/pro/js/promise-ui.js'), loader = read('docs/pro/js/script-loader.js');
  const cust = read('docs/pro/customer.html'), tasks = read('docs/pro/js/tasks.js'), cc = read('docs/pro/js/call-center-view.js'), cb = read('functions/call-center.js');
  ok('Today: the Promises section sits above Calls owed; Waiting on them has its own group', home.indexOf("section('promises', 'Promises', pm)") !== -1 && home.indexOf("section('promises'") < home.indexOf("section('calls'") && /section\('waiting', 'Waiting on them', wt, wdays\)/.test(home));
  ok('Today: a promise row has Kept it and Move, and NO Handled / dismiss', /pbtn\('pkept'/.test(home) && /pbtn\('pmove'/.test(home) && !/pm = [\s\S]{0,1800}btn\('handled'/.test(home));
  ok('hide never swallows a promise: groups the needs-you rule dropped come back when the call carries an open promise',
    /never swallow it[\s\S]{0,900}p\.kind !== 'promise' \|\| p\.done === true\) return;[\s\S]{0,400}g\.calls\.push\(c\)/.test(home));
  ok('Today: a call promise row swaps Handled for Kept it / Move', /r\.promise \? kept :/.test(home));
  // UX walk 2026-10-13 H3: Handled is one tap with an Undo; the sheet is the
  // secondary "I promised something".
  ok('Today: "I promised something" on a call row opens the sheet', /if \(a === 'promised'\) \{ handleViaSheet\(key\)/.test(home));
  ok('Today: waiting actions are Nudge / Still waiting / Mark dead', /pbtn\('pnudge'/.test(home) && /pbtn\('pstill'/.test(home) && /pbtn\('pdead'/.test(home));
  ok('the sheet: Nothing owed only in handle mode, one close path, no inline handlers', /S\.mode === 'handle'\) h \+= chipBtn\('kind', 'none'/.test(ui) && !/\son[a-z]+=/i.test(ui.replace(/\/\/.*$/gm, '')) && !/<script/i.test(ui));
  ok('Nudge only ever hands off to the phone composer (NBDPhoneShare), never a send call', /NBDPhoneShare\.share\(opts\)/.test(ui) && !/phoneTextAction|sendSms|sendEmail|fetch\(/.test(ui));
  ok('Nudge is recorded only after "shared"', /if \(res && res\.shared\) \{[\s\S]{0,200}nudgePatch/.test(ui));
  ok('a failed write rolls the cached task back (never shown as saved)', /Object\.assign\(t, prev\);[\s\S]{0,120}changed\(\);\s*return false;/.test(ui));
  ok('the bundle: css + logic before ui, in the lazy loader (no eager boot bytes)', /bundles\.promise = \['css\/promise\.css\?v=1', 'js\/promise-logic\.js\?v=2', 'js\/promise-ui\.js\?v=4'\]/.test(home)
    && !/promise: \[/.test(loader) &&!/promise-(logic|ui)\.js/.test(read('docs/pro/dashboard.html')));
  ok('customer page: a Promise button + the sheet scripts', /data-promise-open/.test(cust) && /js\/promise-logic\.js/.test(cust) && /js\/promise-ui\.js/.test(cust) && /css\/promise\.css/.test(cust));
  ok('an open promise cannot be deleted from the task list', /_t\.kind==='promise'&&_t\.done!==true\)\{[^}]*can't be deleted/.test(tasks));
  ok('Call Center: a Promise button on single and group cards', (cc.match(/data-cc=\\?"promise\\?"/g) || []).length >= 3 && /a === 'promise'\) openPromise/.test(cc));
  ok('callCenterAction: promise + promiseMove actions exist and reuse the call pathway', /action === 'promise'/.test(cb) && /action === 'promiseMove'/.test(cb) && /require\('\.\/promise-logic'\)/.test(cb));
  const promiseBlock = cb.split("if (action === 'promise') {")[1].split("if (action === 'promiseMove')")[0];
  ok('nothing auto-deletes a promise: no delete in the promise action or the promise UI',
    promiseBlock.length > 500 && !/\.delete\(|FieldValue\.delete|deleteDoc/.test(promiseBlock) && !/deleteDoc|\.delete\(\)|FieldValue\.delete/.test(ui));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
