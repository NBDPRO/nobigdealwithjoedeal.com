/**
 * customer-open-tasks-2026-11-14.test.js — tasks on a customer page can be done, moved and deleted.
 *
 * Wave-1 daily-screens #8, verified: docs/pro/js/customer-tasks-ui.js only
 * added and ticked tasks (no delete, edit or reschedule), and open tasks sat
 * in the timeline by CREATION date with a raw "2026-11-20", so old ones got
 * buried.
 *
 * Runs the real NBDOpenTasks block from customer-tasks-ui.js in the shared
 * fake DOM (tests/lib/nbd-os-home-harness.js) with Firestore write stubs:
 *   - open tasks + upcoming events, due soonest first; done tasks and past
 *     events left out; friendly due labels (Overdue / today / tomorrow)
 *   - Reschedule writes the new dueDate (task) / eventAt (event)
 *   - Delete needs two taps; Done writes done:true
 *   - offline (settle 'queued'): the rep is told it is on this phone
 *   - customer.html has the slot and loadTimeline feeds it
 * TASKS_SRC=<file> runs against another copy.
 *
 * Run: node tests/customer-open-tasks-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');

const SRC = fs.readFileSync(process.env.TASKS_SRC || path.join(H.ROOT, 'docs/pro/js/customer-tasks-ui.js'), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
const flush = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r)); };
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

function block() {
  const start = SRC.indexOf('// ── Open tasks block (wave-1 daily #8');
  const end = SRC.indexOf('// Toggle task completion');
  return start >= 0 && end > start ? SRC.slice(start, end) : '';
}

function page(online) {
  const dom = H.makeDom();
  const host = dom.document.createElement('div');
  host.setAttribute('id', 'openTasksBlock');
  host.hidden = true;
  dom.document.body.appendChild(host);
  const writes = [];
  const toasts = [];
  const W = {
    document: dom.document, console: { log() {}, warn() {}, error() {} }, Date, Promise, Object, Array, String,
    db: {}, doc: (db, ...p) => p.join('/'), serverTimestamp: () => 'TS',
    updateDoc: (ref, data) => { writes.push(['update', ref, data]); return online ? Promise.resolve() : new Promise(() => {}); },
    deleteDoc: (ref) => { writes.push(['delete', ref]); return online ? Promise.resolve() : new Promise(() => {}); },
    getDoc: async () => ({ exists: () => false }),
    NBDOfflineSync: { settle: (p) => (online ? Promise.resolve(p).then(() => 'synced') : Promise.resolve('queued')) },
    showToast: (m, t) => toasts.push([t, m]),
  };
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  vm.runInContext(block(), ctx, { filename: 'customer-tasks-ui.js#open-tasks' });
  return { dom, W: ctx, host, writes, toasts };
}
const rowsOf = (P) => P.host.querySelectorAll('.ot-row');
const btn = (row, act) => row.querySelector('[data-ot-action="' + act + '"]');

(async () => {
  console.log('\ncustomer-open-tasks — done, reschedule and delete on the customer page\n');
  ok('the open-tasks block exists in customer-tasks-ui.js', !!block());
  const P = page(true);
  ok('it publishes NBDOpenTasks.render', !!(P.W.NBDOpenTasks && typeof P.W.NBDOpenTasks.render === 'function'));
  if (!(P.W.NBDOpenTasks && P.W.NBDOpenTasks.render)) { console.log('\n' + passed + ' passed, ' + failed + ' failed\n'); process.exit(1); }

  const tasks = [
    { id: 'late', title: 'Order ridge cap', dueDate: ymd(day(-3)), done: false },
    { id: 'none', title: 'Call about gutters', dueDate: '', done: false },
    { id: 'done', title: 'Already done', dueDate: ymd(day(-9)), done: true },
    { id: 'tmrw', title: 'Send estimate', dueDate: ymd(day(1)), done: false },
    { id: 'evFuture', type: 'event', title: 'Adjuster meeting', eventAt: day(2).toISOString(), done: false },
    { id: 'evPast', type: 'event', title: 'Old meeting', eventAt: day(-5).toISOString(), done: false },
  ];
  P.W.NBDOpenTasks.render('L1', tasks);
  const ids = rowsOf(P).map((r) => r.getAttribute('data-ot-id'));
  ok('open tasks and upcoming events, due soonest first, undated last', ids.join(',') === 'late,tmrw,evFuture,none', ids.join(','));
  const txt = H.text(P.host);
  ok('overdue and tomorrow are said in words, not a raw date', /Overdue · /.test(txt) && /Due tomorrow/.test(txt) && /No due date/.test(txt), txt);
  ok('the block shows only when there is something open', P.host.hidden === false);

  // Reschedule a task.
  H.click(P.dom, btn(rowsOf(P)[0], 'move'));
  const input = rowsOf(P)[0].querySelector('.ot-move');
  ok('Reschedule opens a date picker', !!input && input.type === 'date');
  input.value = ymd(day(4));
  H.fire(P.dom, input, 'change');
  await flush();
  const mv = P.writes.find((w) => w[0] === 'update' && /tasks\/late$/.test(w[1]));
  ok('...and writes the new due date to that task', !!mv && mv[2].dueDate === ymd(day(4)), JSON.stringify(P.writes));

  // Reschedule an event.
  const evRow = rowsOf(P).find((r) => r.getAttribute('data-ot-id') === 'evFuture');
  H.click(P.dom, btn(evRow, 'move'));
  const evIn = evRow.querySelector('.ot-move');
  ok('an event reschedules with a date AND time', !!evIn && evIn.type === 'datetime-local');
  evIn.value = '2026-12-01T09:30';
  H.fire(P.dom, evIn, 'change');
  await flush();
  ok('...written as eventAt', P.writes.some((w) => /tasks\/evFuture$/.test(w[1]) && w[2] && w[2].eventAt === new Date('2026-12-01T09:30').toISOString()));

  // Delete: two taps.
  const delRow = () => rowsOf(P).find((r) => r.getAttribute('data-ot-id') === 'none');
  H.click(P.dom, btn(delRow(), 'delete'));
  await flush();
  ok('one tap on Delete deletes nothing', !P.writes.some((w) => w[0] === 'delete'));
  H.click(P.dom, btn(delRow(), 'delete'));
  await flush();
  ok('the second tap deletes the task', P.writes.some((w) => w[0] === 'delete' && /tasks\/none$/.test(w[1])) && !delRow());

  // Done.
  const tm = rowsOf(P).find((r) => r.getAttribute('data-ot-id') === 'tmrw');
  H.click(P.dom, btn(tm, 'done'));
  await flush();
  ok('Done marks the task done and it leaves the block', P.writes.some((w) => /tasks\/tmrw$/.test(w[1]) && w[2] && w[2].done === true)
    && !rowsOf(P).some((r) => r.getAttribute('data-ot-id') === 'tmrw'));

  // Offline.
  const O = page(false);
  O.W.NBDOpenTasks.render('L1', [{ id: 'x', title: 'X', dueDate: ymd(day(0)), done: false }]);
  H.click(O.dom, btn(rowsOf(O)[0], 'done'));
  await flush();
  ok('offline: the rep is told it is on this phone', O.toasts.some(([t, m]) => t === 'success' && /on this phone/.test(m)), JSON.stringify(O.toasts));

  // Wiring.
  const html = fs.readFileSync(path.join(H.ROOT, 'docs/pro/customer.html'), 'utf8');
  const boot = fs.readFileSync(path.join(H.ROOT, 'docs/pro/js/customer-bootstrap.module.js'), 'utf8');
  ok('customer.html has the block above the timeline', /id="openTasksBlock"[\s\S]{0,200}id="tlFilters"/.test(html));
  ok('loadTimeline hands the lead\'s tasks to it', /window\.NBDOpenTasks\.render\(leadId, taskSnap\.docs\.map\(/.test(boot));

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
