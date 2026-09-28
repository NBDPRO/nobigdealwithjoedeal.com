/**
 * tests/tasks-load-from-cache-retry-2026-09-28.test.js
 *
 * CRM sweep R13 (emulator, 2026-09-28) — docs/pro/js/tasks.js loadAllTasks.
 *
 * THE BUG: the dashboard loads every lead's tasks once, 1.8 s after page load.
 * If that lands while the Firestore connection is being cycled (the boot
 * pre-flight, or the visibility handler's "tab returned to foreground"
 * cycle), getDocs answers from the LOCAL cache with no error. Instrumented on
 * the emulator: all 7 leads read 0 tasks, fromCache=true, and nothing ever
 * re-read them. Two overdue tasks were missing from the bell (badge 0), the
 * Today list and the overdue notification until a full reload.
 *
 * THE FIX: a read served from cache is remembered; loadAllTasks re-reads just
 * those leads shortly after, a bounded number of times (an offline rep keeps
 * the cached tasks and the retries stop).
 *
 * Runs the REAL _loadTasks / loadAllTasks (and their state declarations)
 * lifted out of tasks.js into a vm with a fake getDocs.
 * Break-test: against main the retry cases go red.
 *
 * Zero deps. Run: node tests/tasks-load-from-cache-retry-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/tasks.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
// Module-level state the two functions share, taken from the file itself.
const decls = (SRC.match(/^(?:const|let) _(?:tasksFromCache|taskCacheRetries|TASK_CACHE_RETRY_MS)\b[^\n]*$/gm) || []).join('\n');
const code = decls + '\n' + extractFn(SRC, '_loadTasks') + '\n' + extractFn(SRC, 'loadAllTasks')
  + '\nglobalThis.loadAllTasks = loadAllTasks;';
ok('tasks.js declares the from-cache state', /_tasksFromCache/.test(decls), decls);

// serverTasks: what the server holds. cacheFirst: how many reads (per lead)
// answer from an empty local cache before the connection is back.
function rig(cacheFirst) {
  const server = { L1: [{ id: 't1', text: 'overdue', dueDate: '2026-09-27', done: false }], L2: [] };
  const reads = { L1: 0, L2: 0 };
  const timers = [];
  const win = { _leads: [{ id: 'L1' }, { id: 'L2' }], _filteredLeads: null, _taskCache: {} };
  const ctx = vm.createContext({
    window: win, console,
    CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    db: {}, orderBy: () => ({}), collection: (_db, _c, leadId) => ({ leadId }), query: (c) => c,
    getDocs: async (q) => {
      const n = ++reads[q.leadId];
      const fromCache = n <= cacheFirst;
      const docs = (fromCache ? [] : server[q.leadId]).map((t) => ({ id: t.id, data: () => Object.assign({}, t) }));
      return { docs, size: docs.length, metadata: { fromCache } };
    },
    renderTodayTasks: () => {}, renderLeads: () => {},
  });
  win.dispatchEvent = () => true;
  vm.runInContext(code, ctx);
  // The retry timer fires loadAllTasks without returning its promise, so let
  // the event loop drain after each one.
  const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res)); };
  return { ctx, win, reads, timers, runTimers: async () => { while (timers.length) { const t = timers.shift(); t.fn(); await drain(); } } };
}

(async () => {
  console.log('TASKS — reads served from cache are retried');
  {
    const r = rig(1); // first read of each lead comes from the empty cache
    await r.ctx.loadAllTasks();
    ok('first pass: L1 read 0 tasks from cache', (r.win._taskCache.L1 || []).length === 0);
    ok('…and a retry is scheduled', r.timers.length === 1, 'timers=' + r.timers.length);
    await r.runTimers();
    ok('after the retry L1 has its overdue task', (r.win._taskCache.L1 || []).length === 1);
    ok('the retry re-read only the cache-served leads (2 reads each, not more)', r.reads.L1 === 2 && r.reads.L2 === 2, JSON.stringify(r.reads));
    ok('no further retries once reads come from the server', r.timers.length === 0);
  }
  {
    const r = rig(0); // healthy connection
    await r.ctx.loadAllTasks();
    ok('server reads: no retry scheduled', r.timers.length === 0 && (r.win._taskCache.L1 || []).length === 1);
  }
  {
    const r = rig(Infinity); // genuinely offline
    await r.ctx.loadAllTasks();
    await r.runTimers();
    const total = r.reads.L1;
    ok('offline: retries are bounded (≤ 5 reads per lead)', total <= 5, 'reads=' + total);
    ok('…and stop', r.timers.length === 0);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
