/**
 * tasks-load-bounded-2026-11-14.test.js — the boot task load reads open tasks
 * plus the last 30 days of done ones, not every task ever.
 *
 * Wave-1 daily #10 (Joe approved 2026-11-14): today-plan.js tasksQuery read
 * every task the user could see, done ones from years back included, at every
 * boot. Now two queries on the same scope:
 *   open   where done == false, orderBy createdAt asc
 *   recent where done == true, completedAt >= now - 30 d, orderBy completedAt
 * with the old whole read as a fallback while the new indexes build
 * (failed-precondition only).
 *
 * Runs the real today-plan.js and the real _loadAllTasksGroup lifted from
 * tasks.js against a fake collection group that APPLIES the filters, so a
 * task the queries would miss is really missing.
 * TASKS_SRC / PLAN_SRC=<file> run against other copies.
 *
 * Run: node tests/tasks-load-bounded-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TASKS = fs.readFileSync(process.env.TASKS_SRC || path.join(ROOT, 'docs/pro/js/tasks.js'), 'utf8');
const PLAN_PATH = process.env.PLAN_SRC || path.join(ROOT, 'docs/pro/js/today-plan.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
function slice(text, start) {
  const i = text.indexOf(start);
  if (i < 0) return '';
  const open = text.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') { depth--; if (depth === 0) return text.slice(i, k + 1); }
  }
  return '';
}

const DAY = 86400000;
const NOW = Date.now();
const ts = (ms) => ({ toMillis: () => ms, seconds: Math.floor(ms / 1000), _ms: ms });
const ROWS = [
  { id: 'open-old', data: { userId: 'u1', done: false, createdAt: ts(NOW - 400 * DAY), text: 'open from last year' } },
  { id: 'open-new', data: { userId: 'u1', done: false, createdAt: ts(NOW - 1 * DAY), text: 'open this week' } },
  { id: 'done-recent', data: { userId: 'u1', done: true, completedAt: ts(NOW - 5 * DAY), createdAt: ts(NOW - 9 * DAY), text: 'done 5 days ago' } },
  { id: 'done-old', data: { userId: 'u1', done: true, completedAt: ts(NOW - 40 * DAY), createdAt: ts(NOW - 60 * DAY), text: 'done 40 days ago' } },
  { id: 'other-user', data: { userId: 'u2', done: false, createdAt: ts(NOW), text: 'not mine' } },
  // the old voicemail.js / tools.js shape: status 'open', NO done field
  { id: 'legacy-open', data: { userId: 'u1', status: 'open', title: 'Call back about the voicemail', createdAt: ts(NOW - 100 * DAY) } },
];

function run(opts) {
  opts = opts || {};
  const reads = [];
  const where = (f, op, v) => ({ kind: 'where', f, op, v });
  const orderBy = (f, d) => ({ kind: 'orderBy', f, d });
  const query = (cg, ...parts) => ({ parts });
  const cmp = (val, v) => { const a = val && val._ms != null ? val._ms : val; const b = v instanceof Date ? v.getTime() : v; return [a, b]; };
  const getDocs = async (q) => {
    const parts = q.parts;
    reads.push(parts.filter((p) => p.kind === 'where').map((p) => p.f + p.op + (p.v instanceof Date ? 'date' : p.v)).join('&'));
    if (opts.noIndex && parts.some((p) => p.kind === 'where' && p.f === 'status')) { const e = new Error('index'); e.code = 'failed-precondition'; throw e; }
    if (opts.noIndex && parts.some((p) => p.kind === 'where' && p.f === 'done')) { const e = new Error('index'); e.code = 'failed-precondition'; throw e; }
    const docs = ROWS.filter((r) => parts.every((p) => {
      if (p.kind !== 'where') return true;
      if (!(p.f in r.data)) return false;   // Firestore: a filter on a missing field drops the doc
      const [a, b] = cmp(r.data[p.f], p.v);
      return p.op === '==' ? a === b : p.op === '>=' ? a >= b : false;
    })).map((r) => ({ id: r.id, ref: { path: 'leads/L1/tasks/' + r.id, parent: { path: 'leads/L1/tasks' } }, data: () => Object.assign({}, r.data) }));
    return { docs, metadata: { fromCache: false } };
  };
  const plan = require(PLAN_PATH);
  const ctx = vm.createContext({
    window: { NBDTodayPlan: plan, _user: { uid: 'u1' }, _userClaims: {}, collectionGroup: () => 'cg' },
    console: { log() {}, warn() {}, error() {} }, Promise, Set, Date, Object, Array,
    db: {}, getDocs, query, where, orderBy, _FS_SDK: '',
    _overlayCallText: async (t) => t,
  });
  vm.runInContext(slice(TASKS, 'async function _loadAllTasksGroup(') + '\nthis.load = _loadAllTasksGroup;', ctx);
  return { ctx, reads };
}

(async () => {
  console.log('\ntasks-load-bounded — open tasks + 30 days of done, not every task ever\n');
  const plan = require(PLAN_PATH);
  ok('today-plan exposes the bounded queries', typeof plan.boundedTaskQueries === 'function');

  let T = run();
  const r = await T.ctx.load();
  const ids = ((r && r.by && r.by.L1) || []).map((t) => t.id);
  ok('every open task is loaded, however old', ids.includes('open-old') && ids.includes('open-new'), ids.join(','));
  ok('a task done 5 days ago is loaded', ids.includes('done-recent'), ids.join(','));
  ok('a task done 40 days ago is NOT loaded', !ids.includes('done-old'), ids.join(','));
  ok('...nor another rep\'s task', !ids.includes('other-user'));
  ok('three scoped reads: open, done since 30 days, and the legacy open shape', T.reads.length === 3 && T.reads[0] === 'userId==u1&done==false' && T.reads[1] === 'userId==u1&done==true&completedAt>=date' && T.reads[2] === 'userId==u1&status==open', JSON.stringify(T.reads));
  ok('a legacy open task with no done field is still loaded (review round)', ids.includes('legacy-open'), ids.join(','));
  ok('still oldest first', ids.join(',') === 'open-old,legacy-open,done-recent,open-new', ids.join(','));

  T = run({ noIndex: true });
  const f = await T.ctx.load();
  const fids = ((f && f.by && f.by.L1) || []).map((t) => t.id);
  ok('index not built yet: falls back to the whole read (nothing lost)', fids.length === 5 && T.reads[T.reads.length - 1] === 'userId==u1', JSON.stringify(T.reads));

  // Each query shape has its COLLECTION_GROUP index.
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8')).indexes
    .filter((i) => i.collectionGroup === 'tasks' && i.queryScope === 'COLLECTION_GROUP' && Array.isArray(i.fields))
    .map((i) => i.fields.map((x) => x.fieldPath).join(','));
  ['userId', 'companyId'].forEach((scope) => {
    ok(scope + ': open-task index declared', idx.includes(scope + ',done,createdAt'));
    ok(scope + ': recently-done index declared', idx.includes(scope + ',done,completedAt'));
    ok(scope + ': legacy open-shape index declared', idx.includes(scope + ',status,createdAt'));
  });
  const staff = plan.boundedTaskQueries && plan.boundedTaskQueries({ role: 'manager', companyId: 'co1' }, 'u1');
  ok('company staff are scoped by the tenant on both reads', !!staff && staff.every((s) => s.field === 'companyId' && s.value === 'co1'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
