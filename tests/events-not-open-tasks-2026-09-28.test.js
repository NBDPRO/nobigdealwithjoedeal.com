/**
 * tests/events-not-open-tasks-2026-09-28.test.js
 *
 * CRM sweep R14 (emulator, 2026-09-28) — customer-page "Add Event" entries on
 * the dashboard.
 *
 * THE BUG: Add Event writes a doc with type:'event' + eventAt (no dueDate,
 * done:false) into the same leads/{id}/tasks subcollection as to-dos. The
 * customer page renders it as a dated 📅 milestone and leaves it out of the
 * open-task count; the dashboard did neither. Emulator: one real task + one
 * adjuster meeting → the kanban card read "☑ 0/2" (the meeting can never be
 * "done"), and the dashboard task list showed the meeting as an undated
 * checkbox — ticking it marked the meeting done.
 *
 * THE FIX: the card badge counts only real tasks; renderTaskList lists events
 * read-only with their date, after the tasks.
 *
 * Runs the REAL renderTaskList (tasks.js) in a vm; checks the badge filter.
 * Break-test: against main these go red.
 *
 * Zero deps. Run: node tests/events-not-open-tasks-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const TASKS = read('docs/pro/js/tasks.js');
const PIPE = read('docs/pro/js/crm-pipeline.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function extractFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return '';
  const open = src.indexOf('{', start + sig.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const listEl = { innerHTML: '' };
const ctx = vm.createContext({
  document: {
    getElementById: (id) => (id === 'taskList' ? listEl : null),
    // _escTask's textContent → innerHTML round trip.
    createElement: () => {
      const el = { _t: '' };
      Object.defineProperty(el, 'textContent', { set(v) { el._t = String(v == null ? '' : v); } });
      Object.defineProperty(el, 'innerHTML', { get() { return el._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } });
      return el;
    },
  },
  Date, String, isNaN,
});
const code = ['function renderTaskList(', 'function _escTask(', 'function _taskDueLabel(']
  .map((sig) => extractFn(TASKS, sig)).join('\n') + '\nglobalThis.renderTaskList = renderTaskList;';
vm.runInContext(code, ctx);

const meeting = { id: 'e1', type: 'event', title: 'Adjuster meeting', text: 'Adjuster meeting', eventAt: '2026-09-30T18:00:00.000Z', done: false };
const task = { id: 't1', text: 'Schedule Inspection', done: false };

console.log('DASHBOARD TASK LIST — events are not to-dos');
ctx.renderTaskList([task, meeting]);
const html = listEl.innerHTML;
const rows = html.split('<div class="task-item').slice(1);
const eventRow = rows.find((r) => /Adjuster meeting/.test(r)) || '';
const taskRow = rows.find((r) => /Schedule Inspection/.test(r)) || '';
ok('the real task keeps its checkbox', /type="checkbox"/.test(taskRow));
ok('the event has NO checkbox (can\'t be ticked "done")', !!eventRow && !/type="checkbox"/.test(eventRow), eventRow.slice(0, 160));
ok('…is shown with its date', /task-due/.test(eventRow) && /30/.test(eventRow), eventRow.slice(0, 200));
ok('…and is marked as an event', /task-event/.test(eventRow));
ok('tasks come before events', html.indexOf('Schedule Inspection') < html.indexOf('Adjuster meeting'));
ctx.renderTaskList([meeting]);
ok('a lead with only an event does not say "No tasks yet" over it', /Adjuster meeting/.test(listEl.innerHTML));
ctx.renderTaskList([]);
ok('no tasks, no events → the empty message', /No tasks yet/.test(listEl.innerHTML));

console.log('KANBAN CARD BADGE');
ok('the badge counts only non-event tasks',
  /const tasks = \(window\._taskCache\?\.\[l\.id\] \|\| \[\]\)\.filter\(t => t && t\.type !== 'event'\);/.test(PIPE));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
