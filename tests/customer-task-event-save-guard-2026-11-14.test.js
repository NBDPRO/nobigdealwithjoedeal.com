/**
 * customer-task-event-save-guard-2026-11-14.test.js — Save Task / Save Event: once, and offline.
 *
 * Wave-1 daily-screens #6, verified in docs/pro/js/customer-tasks-ui.js:
 * saveTask and saveEvent never disabled their button or checked an
 * in-flight flag, so a double-tap wrote the task twice; and offline the
 * addDoc await never returned (it waits for the server's ack), so the modal
 * hung open.
 *
 * Extracts the real functions and runs them with writes that never ack.
 * TASKS_SRC=<file> runs it against another copy.
 *
 * Run: node tests/customer-task-event-save-guard-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.TASKS_SRC || path.join(ROOT, 'docs/pro/js/customer-tasks-ui.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const within = (p, ms) => Promise.race([Promise.resolve(p).then(() => true), tick(ms).then(() => false)]);

function slice(start, tail) {
  const i = SRC.indexOf(start);
  if (i < 0) return '';
  const open = SRC.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(i, j + 1) + (tail || ''); }
  }
  return '';
}

function page(online, withEvents) {
  const writes = [];
  const val = (v) => ({ value: v });
  const els = {
    taskTitle: val('Order ridge cap'), taskDueDate: val('2026-11-20'), taskPriority: val('high'), taskNotes: val(''),
    eventTitle: val('Adjuster meeting'), eventWhen: val('2026-11-18T10:00'), eventNotes: val(''),
  };
  const btns = { saveTask: { disabled: false }, saveEvent: { disabled: false } };
  const rec = { toasts: [], closed: 0, timeline: 0 };
  const never = () => new Promise(() => {});
  const win = {
    _customerId: 'L1', db: {}, auth: { currentUser: { uid: 'u1', email: 'r@x.test' } },
    collection: (...a) => a.slice(1).join('/'), serverTimestamp: () => 'TS', doc: () => ({}),
    addDoc: (c, d) => { writes.push(d); return online ? Promise.resolve({ id: 't' + writes.length }) : never(); },
    getDoc: async () => ({ exists: () => true, data: () => ({}) }),
    NBDOfflineSync: { settle: (p) => (online ? Promise.resolve(p).then(() => 'synced') : Promise.resolve('queued')) },
    nbdModal: { close() { rec.closed++; } },
    showToast: (m, t) => rec.toasts.push([t, m]),
  };
  if (withEvents) win.NBDLeadEvents = { add: (id, ev) => win.addDoc('x', ev).then((r) => r && r.id) };
  const ctx = {
    window: win, console: { log() {}, warn() {}, error() {} }, Promise, Date, String,
    document: {
      getElementById: (id) => els[id],
      querySelector: (s) => { const m = /data-action="(\w+)"/.exec(s); return m ? btns[m[1]] : null; },
    },
    showToast: win.showToast, closeTaskModal: () => { rec.closed++; },
    loadTimeline: async () => { rec.timeline++; },
  };
  vm.createContext(ctx);
  const helpers = [slice('function _taskNotify('), slice('function _taskSettle('),
    SRC.includes('const _taskSaving') ? 'const _taskSaving = { task: false, event: false };' : '', slice('function _taskBusy(')].join('\n');
  vm.runInContext(helpers + '\nwindow.closeEventModal = function () { window.nbdModal.close(); };\n'
    + slice('window.saveEvent = async function', ';') + '\n' + slice('window.saveTask = async function', ';'), ctx);
  return { win, writes, btns, rec };
}

(async () => {
  console.log('\ncustomer-task-event-save-guard — one tap, one task; offline returns\n');

  let P = page(true);
  await Promise.all([P.win.saveTask(), P.win.saveTask()]);
  ok('a double-tap on Save Task writes ONE task', P.writes.length === 1, 'writes=' + P.writes.length);
  ok('...and Save Task works again afterwards', P.btns.saveTask.disabled === false);

  P = page(true, true);
  await Promise.all([P.win.saveEvent(), P.win.saveEvent()]);
  ok('a double-tap on Save Event writes ONE event', P.writes.length === 1, 'writes=' + P.writes.length);

  P = page(false);
  ok('offline: Save Task returns (the modal used to hang open)', await within(P.win.saveTask(), 1000));
  ok('...the modal closes and the rep is told it is on this phone',
    P.rec.closed >= 1 && P.rec.toasts.some(([t, m]) => t === 'success' && /on this phone/i.test(m)), JSON.stringify(P.rec.toasts));

  P = page(false, true);
  ok('offline: Save Event returns', await within(P.win.saveEvent(), 1000));
  ok('...and says it is on this phone', P.rec.toasts.some(([, m]) => /on this phone/i.test(m)), JSON.stringify(P.rec.toasts));

  P = page(true);
  await P.win.saveTask();
  ok('online positive control: saved and the timeline reloads', P.writes.length === 1 && P.rec.timeline === 1);

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
