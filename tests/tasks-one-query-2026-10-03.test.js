/**
 * tests/tasks-one-query-2026-10-03.test.js — the dashboard's ONE task load.
 *
 * docs/pro/js/tasks.js used to run one Firestore query PER LEAD (~234 at
 * boot) and to run them once, 1.8 s after page load, over whatever
 * window._leads held at that moment — a cold boot whose leads arrived later
 * painted "All caught up" and an empty bell over overdue tasks (2026-10-03
 * 7am audit). Now:
 *   - the load waits for the lead book (_leadsLoaded + the
 *     nbd:data-refreshed {source:'leads'} event the lead load fires);
 *   - it is ONE collectionGroup('tasks') query, scoped by companyId (staff)
 *     or userId, ordered by createdAt (today-plan.js tasksQuery — its index
 *     is tied in tests/today-plan-2026-10-03.test.js);
 *   - the bell / Today / task panel / card badges read the _taskCache it
 *     fills, announced once with nbd:data-refreshed {source:'tasks'};
 *   - a refused collection-group read falls back to the per-lead read;
 *   - a task the dashboard writes carries its lead's userId / companyId.
 *
 * Runs the WHOLE real tasks.js in a vm with a fake Firestore that records
 * every query. Break-test: against origin/main's tasks.js the race and
 * one-query sections go red (it never loads after the leads arrive, and it
 * reads per lead).
 *
 * Run: node tests/tasks-one-query-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/tasks.js'), 'utf8');
const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

const SERVER = [
  { id: 't1', parent: 'leads/L1/tasks', data: { text: 'call back', dueDate: '2026-10-01', done: false, companyId: 'co1', userId: 'u1' } },
  { id: 't2', parent: 'leads/L1/tasks', data: { text: 'send photos', dueDate: '2026-10-05', done: true, companyId: 'co1', userId: 'u1' } },
  { id: 't3', parent: 'leads/L3/tasks', data: { text: 'order shingles', dueDate: '', done: false, companyId: 'co1', userId: 'u1' } },
  { id: 'tTop', parent: 'tasks', data: { text: 'retired top-level copy', userId: 'u1' } },
];

function rig(opts) {
  opts = opts || {};
  const listeners = {};
  const timers = [];
  const log = { cg: [], perLead: [], adds: [], updates: [], events: [] };
  const g = {
    console: { log() {}, warn() {}, error() {} },
    Promise, Object, Array, Set, Map, JSON, Date, Math, String, Number, Error,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      createElement() { return { textContent: '', innerHTML: '' }; },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(ev) { log.events.push(ev); (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    db: { name: 'db' },
    auth: { currentUser: null },
    _leads: [], _leadsLoaded: false, _taskCache: {}, _user: null, _userClaims: {},
    NBDTodayPlan: opts.noPlan ? undefined : TP,
    renderLeads() {},
    showToast() {},
    serverTimestamp: () => '__TS__',
    collection: (_db, ...segs) => ({ segs }),
    collectionGroup: (_db, name) => ({ cg: name }),
    query: (base, ...cons) => ({ base, cons }),
    where: (f, op, v) => ({ where: [f, op, v] }),
    orderBy: (f, d) => ({ orderBy: [f, d || 'asc'] }),
    doc: (_db, ...segs) => ({ segs }),
    getDocs: async (q) => {
      const base = q.base || q;
      if (base.cg) {
        log.cg.push(q);
        if (opts.refuseGroup) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
        const fromCache = (opts.cacheFirst || 0) >= log.cg.length;
        const rows = fromCache ? [] : SERVER;
        return {
          metadata: { fromCache },
          docs: rows.map((r) => ({ id: r.id, ref: { parent: { path: r.parent } }, data: () => Object.assign({}, r.data) })),
        };
      }
      const leadId = base.segs && base.segs[1];
      log.perLead.push(leadId);
      const rows = SERVER.filter((r) => r.parent === 'leads/' + leadId + '/tasks');
      return { metadata: { fromCache: false }, docs: rows.map((r) => ({ id: r.id, data: () => Object.assign({}, r.data) })) };
    },
    addDoc: async (ref, data) => { log.adds.push({ ref, data }); return { id: 'new1' }; },
    updateDoc: async (ref, data) => { log.updates.push({ ref, data }); },
    deleteDoc: async () => {},
  };
  g.window = g;
  vm.createContext(g);
  vm.runInContext(SRC, g, { filename: 'tasks.js' });
  const fire = (type, detail) => g.dispatchEvent(new g.CustomEvent(type, { detail }));
  const runTimers = async () => { while (timers.length) { const t = timers.shift(); t.fn(); await drain(); } };
  const leadsReady = (claims, uid) => {
    g._leads = [{ id: 'L1', userId: 'u1', companyId: 'co1' }, { id: 'L2', userId: 'u1', companyId: 'co1' }, { id: 'L3', userId: 'u1', companyId: 'co1' }];
    g._user = { uid: uid || 'u1' }; g._userClaims = claims || { role: 'company_admin', companyId: 'co1' };
    g._leadsLoaded = true;
    fire('nbd:data-refreshed', { source: 'leads' });
  };
  return { g, log, timers, fire, runTimers, leadsReady };
}
const tasksEvents = (log) => log.events.filter((e) => e.type === 'nbd:data-refreshed' && e.detail && e.detail.source === 'tasks').length;

(async () => {
  console.log('\n1. The load waits for the leads (the cold-boot race)');
  {
    const r = rig();
    r.fire('load');           // page load, leads not in yet
    await r.runTimers();      // …and let any "load + 1.8 s" timer fire
    await drain();
    ok('nothing is read before the lead book is in', r.log.cg.length === 0 && r.log.perLead.length === 0, JSON.stringify({ cg: r.log.cg.length, per: r.log.perLead }));
    r.leadsReady();
    await drain(); await r.runTimers();
    ok('the moment the leads arrive, the tasks load', r.log.cg.length + r.log.perLead.length > 0);
    ok('…and the overdue task is in the cache the bell / Today / panel read', (r.g._taskCache.L1 || []).some((t) => t.id === 't1' && t.done === false));
    ok('…announced once (nbd:data-refreshed {source:"tasks"})', tasksEvents(r.log) === 1, String(tasksEvents(r.log)));
    ok('NBDTasks.loaded() turns true (Today waits for it)', r.g.NBDTasks && r.g.NBDTasks.loaded() === true);
    const before = r.log.cg.length + r.log.perLead.length;
    r.fire('nbd:data-refreshed', { source: 'leads' });
    await drain(); await r.runTimers();
    ok('a later lead refresh repaints, it does not re-read every task', r.log.cg.length + r.log.perLead.length === before);
  }

  console.log('\n2. ONE query, not one per lead');
  {
    const r = rig();
    r.leadsReady({ role: 'company_admin', companyId: 'co1' }, 'u1');
    await drain(); await r.runTimers();
    ok('exactly one query', r.log.cg.length === 1, 'cg=' + r.log.cg.length);
    ok('zero per-lead reads (was one per lead)', r.log.perLead.length === 0, JSON.stringify(r.log.perLead));
    const q = r.log.cg[0] || { base: {}, cons: [] };
    const w = (q.cons.find((c) => c.where) || {}).where || [];
    const o = (q.cons.find((c) => c.orderBy) || {}).orderBy || [];
    ok('collectionGroup("tasks") where companyId == co1, orderBy createdAt asc (company staff)', q.base.cg === 'tasks' && w.join() === 'companyId,==,co1' && o.join() === 'createdAt,asc', JSON.stringify(q));
    ok('cache by lead: L1 has its 2, L3 its 1, L2 (no tasks) is an empty list', (r.g._taskCache.L1 || []).length === 2 && (r.g._taskCache.L3 || []).length === 1 && Array.isArray(r.g._taskCache.L2) && r.g._taskCache.L2.length === 0);
    ok('the retired top-level /tasks copy is not a lead\'s task', !Object.values(r.g._taskCache).some((list) => list.some((t) => t.id === 'tTop')));
    // The account changes (sign out → another user): reload for them.
    r.g._user = { uid: 'u2' }; r.g._userClaims = { role: 'sales_rep', companyId: 'co1' };
    r.fire('nbd:data-refreshed', { source: 'leads' });
    await drain(); await r.runTimers();
    const q2 = r.log.cg[1] || { cons: [] };
    ok('another account → a fresh load, scoped to that rep\'s own userId', r.log.cg.length === 2 && ((q2.cons.find((c) => c.where) || {}).where || []).join() === 'userId,==,u2');
  }

  console.log('\n3. Fallbacks');
  {
    const r = rig({ refuseGroup: true });
    r.leadsReady();
    await drain(); await r.runTimers();
    ok('a refused collection-group read (rules / index not deployed yet) falls back to the per-lead read', r.log.perLead.sort().join(',') === 'L1,L2,L3' && (r.g._taskCache.L1 || []).length === 2, JSON.stringify(r.log.perLead));
  }
  {
    const r = rig({ cacheFirst: 1 });
    r.leadsReady();
    await drain();
    ok('a read served from the local cache (connection cycling) schedules a re-read', r.timers.length === 1 && (r.g._taskCache.L1 || []).length === 0);
    await r.runTimers();
    ok('…which fills the cache from the server, with ONE more query', r.log.cg.length === 2 && (r.g._taskCache.L1 || []).length === 2);
  }

  console.log('\n4. Writes from Today + the stamps');
  {
    const r = rig();
    r.leadsReady();
    await drain(); await r.runTimers();
    await r.g._saveTask('L3', '  measure the porch  ', '2026-10-06');
    const add = r.log.adds[0] || { data: {} };
    ok('a new task carries its lead\'s owner + tenant + id (the one query filters on them)', add.data.userId === 'u1' && add.data.companyId === 'co1' && add.data.leadId === 'L3' && add.data.text === 'measure the porch', JSON.stringify(add.data));
    const before = tasksEvents(r.log);
    const done = await r.g.NBDTasks.setDone('L1', 't1');
    const up = r.log.updates[r.log.updates.length - 1] || { data: {}, ref: { segs: [] } };
    ok('Done on Today ticks the task (done + completedAt) and updates the cache', done === true && up.data.done === true && up.ref.segs.join('/') === 'leads/L1/tasks/t1' && r.g._taskCache.L1.find((t) => t.id === 't1').done === true);
    ok('…and tells the bell', tasksEvents(r.log) === before + 1);
    await r.g.NBDTasks.setDue('L1', 't1', '2026-10-06');
    const up2 = r.log.updates[r.log.updates.length - 1] || { data: {} };
    ok('Tomorrow moves only the due date', JSON.stringify(up2.data) === '{"dueDate":"2026-10-06"}' && r.g._taskCache.L1.find((t) => t.id === 't1').dueDate === '2026-10-06');
  }

  console.log('\n5. Every OTHER writer: the server stamps new tasks + migration 007 the backlog');
  {
    const TS = require(path.join(ROOT, 'functions/tasks-stamp.js'));
    const { stampPatch, stampTask } = TS._internal;
    const lead = { userId: 'owner1', companyId: 'co1' };
    ok('a bare task gets the lead\'s owner, tenant and id', JSON.stringify(stampPatch({ text: 'x' }, lead, 'L9')) === '{"userId":"owner1","companyId":"co1","leadId":"L9"}');
    ok('a value a writer set is never overwritten', JSON.stringify(stampPatch({ userId: 'rep7', companyId: 'co1', leadId: 'L9' }, lead, 'L9')) === '{}');
    ok('a lead that is gone supplies nothing', JSON.stringify(stampPatch({ text: 'x' }, null, 'L9')) === '{"leadId":"L9"}');
    const writes = [], reads = [];
    const fakeDb = (leads) => ({ doc: (p) => ({ get: async () => { reads.push(p); const id = p.split('/')[1]; return { exists: !!leads[id], data: () => leads[id] }; }, set: async (d, o) => writes.push({ p, d, o }) }) });
    await stampTask(fakeDb({ L9: lead }), 'L9', 'cube-x', { text: 'call back', done: false });
    ok('the trigger body writes the stamps with merge', writes.length === 1 && writes[0].p === 'leads/L9/tasks/cube-x' && writes[0].d.companyId === 'co1' && writes[0].o.merge === true);
    reads.length = 0;
    await stampTask(fakeDb({ L9: lead }), 'L9', 't', { userId: 'owner1', companyId: 'co1', leadId: 'L9' });
    ok('a task that is already stamped costs no read', reads.length === 0 && writes.length === 1);
    const tsSrc = fs.readFileSync(path.join(ROOT, 'functions/tasks-stamp.js'), 'utf8');
    ok('exported on one line (the deploy workflow\'s function grep needs it), watching leads/{leadId}/tasks/{taskId} creates',
      /^exports\.tasksStampOwner = onDocumentCreated\(\{ document: 'leads\/\{leadId\}\/tasks\/\{taskId\}'/m.test(tsSrc));
    ok('index.js exports it', /exports\.tasksStampOwner = require\('\.\/tasks-stamp'\)\.tasksStampOwner;/.test(fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8')));
    const M = require(path.join(ROOT, 'functions/migrations/scripts/007-stamp-task-owner.js'));
    const batchWrites = [];
    const mkTask = (id, data) => ({ id, ref: { path: id }, data: () => data });
    const ctx = {
      log() {},
      db: { batch: () => ({ set: (ref, d, o) => batchWrites.push({ ref: ref.path, d, o }), commit: async () => {} }) },
      pages: async function* () {
        yield { docs: [
          { id: 'L1', data: () => ({ userId: 'u1', companyId: 'co1' }), ref: { collection: () => ({ get: async () => ({ docs: [mkTask('t1', { text: 'a' }), mkTask('t2', { text: 'b', userId: 'u1', companyId: 'co1', leadId: 'L1' })] }) }) } },
          { id: 'L2', data: () => ({ userId: 'u2' }), ref: { collection: () => ({ get: async () => ({ docs: [mkTask('t3', { text: 'c', leadId: 'L2' })] }) }) } },
        ] };
      },
    };
    const res = await M.up(ctx);
    ok('migration 007 stamps only what is missing, by the same rule', M.version === 7 && batchWrites.length === 2 &&
      JSON.stringify(batchWrites[0].d) === '{"userId":"u1","companyId":"co1","leadId":"L1"}' && JSON.stringify(batchWrites[1].d) === '{"userId":"u2"}' && res.docsWritten === 2, JSON.stringify(batchWrites));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})();
