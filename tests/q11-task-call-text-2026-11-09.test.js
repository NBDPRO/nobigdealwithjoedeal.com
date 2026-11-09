/**
 * tests/q11-task-call-text-2026-11-09.test.js — Call to Close Q11, Jo's
 * decision on review item 2 (2026-11-09): a viewer's task list shows no call
 * content.
 *
 * A task the server files from a call keeps a GENERIC title on the task
 * ("Follow up with Kim", "Call back Kim Nowicka", "Send estimate"), which
 * every reader of the customer reads, viewers included. What came from the
 * call (the promise the AI pulled, the issue, "You said you would", the why)
 * goes in leads/{id}/task_call_text/{taskId} (firestore.rules: no viewer; the
 * emulator proof is tests/firestore-rules.call-content-viewers.test.js), and
 * the owners' screens lay it back over the task.
 *
 *   1. functions/task-call-text.js split / apply, and the browser twin
 *   2. the builders: Call Center cube-* / Text Inbox sms-* / Thursday tasks
 *   3. callCenterAction 'promise' (promise-<callId>[-n]) and 'move'
 *   4. the server owner surface that names a promise (promise channel)
 *   5. the browser: tasks.js (dashboard) and the customer page overlay for
 *      owners and never read for a viewer
 *
 * Run: node tests/q11-task-call-text-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const tryRequire = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const NOW = Date.parse('2026-11-09T15:00:00Z');

// An in-memory Firestore with get / set / create / delete / getAll / queries.
function memDb(seed) {
  const docs = new Map(Object.entries(seed || {}));
  const mk = (p) => ({ id: p.split('/').pop(), path: p,
    get: async () => ({ exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }),
    set: async (v, o) => { if (Object.values(v).some((x) => x === undefined)) throw new Error('undefined field in ' + p); docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    create: async (v) => { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } docs.set(p, v); },
    update: async (v) => { docs.set(p, Object.assign({}, docs.get(p) || {}, v)); },
    delete: async () => { docs.delete(p); } });
  const query = (name, filters) => ({ where: (f, op, v) => query(name, filters.concat([[f, v]])), orderBy: () => query(name, filters), limit: () => query(name, filters),
    get: async () => { const depth = name.split('/').length + 1; const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === depth && filters.every(([f, val]) => v[f] === val)).map(([k, v]) => ({ id: k.split('/').pop(), ref: mk(k), exists: true, data: () => v })); return { docs: rows, size: rows.length, empty: !rows.length, forEach: (fn) => rows.forEach(fn) }; } });
  return { docs, doc: mk, collection: (n) => Object.assign(query(n, []), { doc: (id) => mk(n + '/' + id) }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    collectionGroup: (name) => ({ where: (f, op, v) => ({ get: async () => {
      const rows = [...docs.entries()].filter(([k, d]) => { const s = k.split('/'); return s.length >= 2 && s[s.length - 2] === name && d && d[f] === v; })
        .map(([k, d]) => { const s = k.split('/'); return { id: s[s.length - 1], data: () => d, ref: { parent: { parent: { id: s[s.length - 3] } } } }; });
      return { docs: rows };
    } }) }),
    batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), commit: async () => { for (const f of ops) await f(); } }; } };
}

(async () => {
  console.log('\n1. split / apply (functions/task-call-text.js) and the browser twin');
  const TCT = tryRequire('functions/task-call-text.js');
  const CT = tryRequire('docs/pro/js/task-call-text.js');
  ok('the server module exists', !!TCT && typeof TCT.split === 'function' && typeof TCT.apply === 'function');
  ok('the browser twin exists', !!CT && typeof CT.apply === 'function' && typeof CT.overlay === 'function');
  if (TCT) {
    const full = { title: 'Send the estimate (Kim)', text: 'Send the estimate (Kim)', notes: 'You said you would:\n• Send the estimate', source: 'cube-acr', done: false };
    const t = TCT.split(full, { title: 'Follow up with Kim', text: 'Follow up with Kim', notes: '' });
    ok('split: the stored task holds the generic values and callText', t.title === 'Follow up with Kim' && t.text === 'Follow up with Kim' && t.notes === '' && t.callText === true && t.done === false);
    ok('split: no call text anywhere in what a writer stores (JSON / Object.assign copy)', !/Send the estimate/.test(JSON.stringify(t)) && !/Send the estimate/.test(JSON.stringify(Object.assign({}, t))));
    ok('split: the call text rides on a non-enumerable callTextFull', !!t.callTextFull && t.callTextFull.full.title === 'Send the estimate (Kim)' && Object.keys(t).indexOf('callTextFull') === -1);
    ok('split: a copy made with Object.assign drops the call text (fails closed)', !Object.assign({}, t).callTextFull);
    const same = TCT.split(full, { title: full.title });
    ok('split: nothing to hide -> the task unchanged, no callText', same.title === full.title && !('callText' in same) && !same.callTextFull);
    const side = { full: t.callTextFull.full, generic: t.callTextFull.generic };
    const back = TCT.apply(t, side);
    ok('apply: an owner reads the full text back', back.title === full.title && back.text === full.text && back.notes === full.notes);
    const edited = TCT.apply(Object.assign({}, t, { title: 'Typed by Jo' }), side);
    ok('apply: a field edited since keeps the edit (only generic values are replaced)', edited.title === 'Typed by Jo' && edited.text === full.text);
    ok('apply: no side doc -> the task as it is', TCT.apply(t, null) === t && TCT.apply(t, {}) === t);
    ok('sidePath maps a task path, and nothing else', TCT.sidePath('leads/L1/tasks/cube-x') === 'leads/L1/task_call_text/cube-x' && TCT.sidePath('tasks/x') === null && TCT.sidePath('leads/L1/notes/x') === null);
    if (CT) {
      const cases = [[t, side], [Object.assign({}, t, { title: 'Typed by Jo' }), side], [t, null], [{ title: 'a', why: 'g' }, { full: { why: 'W' }, generic: { why: 'g' } }], [{ notes: 'x' }, { full: { notes: 'y' }, generic: { notes: 'z' } }]];
      ok('the browser apply() answers exactly as the server one', cases.every(([a, b]) => JSON.stringify(CT.apply(a, b)) === JSON.stringify(TCT.apply(a, b))));
    }
  }

  console.log('\n2. the builders');
  const L = require(path.join(ROOT, 'functions/call-center-logic.js'));
  const notes = { summary: 'SECRET SUMMARY: hail on the north slope', promises: [{ who: 'jo', text: 'PROMISESECRET send the estimate', due: '2026-11-12' }], followUpDate: null, urgent: false };
  const POINTER = 'The summary is on the customer\'s timeline.';
  const t = L.buildFollowUpTask({ call: { id: 'cube_X1', contactName: 'Kim', startedAtMs: NOW - 3600e3 }, notes, leadId: 'L1', ownerUid: 'U', todayYmd: '2026-11-09', nowMs: NOW });
  ok('Call Center task: the stored title is generic ("Follow up with Kim")', t && t.title === 'Follow up with Kim' && t.text === 'Follow up with Kim', t && t.title);
  ok('…carries no promise text or summary (what a viewer reads)', t && !/PROMISESECRET|SECRET SUMMARY|You said you would/.test(JSON.stringify(t)), t && JSON.stringify(t));
  ok('…keeps the pointer line, the date, the source and callText', t && t.notes === POINTER && t.dueDate === '2026-11-12' && t.source === 'cube-acr' && t.callText === true);
  ok('…and the call text is the full title and notes, exactly as before', t && t.callTextFull && t.callTextFull.full.title === 'PROMISESECRET send the estimate (Kim)'
    && t.callTextFull.full.notes === POINTER + '\n\nYou said you would:\n• PROMISESECRET send the estimate (by 2026-11-12)', t && t.callTextFull);
  const fu = L.buildFollowUpTask({ call: { id: 'cube_X2', contactName: 'Kim', startedAtMs: NOW - 3600e3 }, notes: { summary: '', promises: [], followUpDate: '2026-11-11' }, leadId: 'L1', ownerUid: 'U', todayYmd: '2026-11-09', nowMs: NOW });
  ok('a follow-up date and no promise: already generic, no call text, no callText flag', fu && fu.title === 'Follow up with Kim' && !fu.callText && !fu.callTextFull);
  const td = L.buildTextDayTask({ day: { id: 'day1', contactName: 'Kim', startedAtMs: NOW - 3600e3 }, notes, leadId: 'L1', ownerUid: 'U', todayYmd: '2026-11-09', nowMs: NOW });
  ok('Text Inbox task: generic too, and its call text survives the sms reshaping', td && td.source === 'sms-backup' && td.title === 'Follow up with Kim'
    && !/PROMISESECRET/.test(JSON.stringify(td)) && td.callTextFull && /PROMISESECRET/.test(td.callTextFull.full.title));
  const TL = require(path.join(ROOT, 'functions/integrations/thursday-logic.js'));
  const ex = TL.sanitizeExtraction({ caller_name: 'Kim Nowicka', callback_number: '5135550100', issue: 'ISSUESECRET leak over the kitchen',
    urgent: true, urgent_reason: 'URGENTSECRET water inside', callback_window: 'after 3pm', caller_type: 'homeowner' });
  const call = { callId: 'abc123', from: '+15135550100', summary: 'THURSDAYSECRET summary' };
  const tt = TL.buildTask({ extraction: ex, call, route: { action: 'attach' }, leadId: 'L1', ownerUid: 'U', now: NOW });
  ok('Thursday task: the stored title is "Call back <who>" with no issue', tt && tt.title === '🚨 URGENT — Call back Kim Nowicka' && tt.text === tt.title, tt && tt.title);
  ok('…carries no issue, summary or urgent reason', tt && !/ISSUESECRET|THURSDAYSECRET|URGENTSECRET/.test(JSON.stringify(tt)), tt && JSON.stringify(tt));
  ok('…keeps the best time, the number, the priority and callText', tt && /Best time: after 3pm/.test(tt.notes) && /Number: \+15135550100/.test(tt.notes) && tt.priority === 'high' && tt.callText === true);
  ok('…and the call text is today\'s full title', tt && tt.callTextFull && tt.callTextFull.full.title === '🚨 URGENT — Call back Kim Nowicka — ISSUESECRET leak over the kitchen');
  const adj = TL.buildTask({ extraction: TL.sanitizeExtraction(Object.assign({}, ex, { caller_type: 'adjuster', urgent: false })), call, route: { action: 'attach' }, leadId: 'L1', ownerUid: 'U', now: NOW });
  ok('Thursday adjuster: "Call adjuster back: <who>", issue in the call text', adj && adj.title === 'Call adjuster back: Kim Nowicka' && /ISSUESECRET/.test(adj.callTextFull.full.title));
  const sup = TL.buildTask({ extraction: TL.sanitizeExtraction(Object.assign({}, ex, { caller_type: 'supplier_sub', urgent: false })), call, route: { action: 'attach' }, leadId: 'L1', ownerUid: 'U', now: NOW });
  ok('Thursday supplier: "Call back <who> (supplier/sub)"', sup && sup.title === 'Call back Kim Nowicka (supplier/sub)' && !/ISSUESECRET/.test(JSON.stringify(sup)));
  const pm = TL.buildTask({ extraction: ex, call, route: { action: 'possible_match' }, leadId: 'L1', ownerUid: 'U', now: NOW });
  ok('Thursday possible match: already generic, no call text', pm && /^Possible match: Thursday call from Kim Nowicka/.test(pm.title) && !pm.callText);

  console.log('\n3. callCenterAction promise / move');
  const M = require(path.join(ROOT, 'functions/call-center.js'));
  const { callAction, COLLECTION } = M._test;
  const OWN = 'owner1';
  const seed = () => ({
    [COLLECTION + '/cube_AAAAA1']: { userId: OWN, companyId: 'co1', phoneDigits: '5135550111', contactName: 'Dana Test', status: 'noted', leadId: 'L1', startedAtMs: NOW, summary: 'Wants a number.', promises: [{ who: 'jo', text: 'Text the estimate' }], bucket: 'customer', attachedBy: OWN },
    'leads/L1': { userId: OWN, companyId: 'co1', firstName: 'Dana', phone: '(513) 555-0111' },
    'leads/L2': { userId: OWN, companyId: 'co1', firstName: 'Sam' },
  });
  const owner = { uid: OWN, token: {} };
  const run = async (db, data) => { try { return { r: await callAction({ db, auth: owner, data, nowMs: NOW }) }; } catch (e) { return { e }; } };
  let db = memDb(seed());
  let x = await run(db, { id: 'cube_AAAAA1', action: 'promise', kind: 'estimate', dueYmd: '2026-11-12', why: 'WHYSECRET quoted 14k' });
  const pt = db.docs.get('leads/L1/tasks/promise-cube_AAAAA1');
  const ps = db.docs.get('leads/L1/task_call_text/promise-cube_AAAAA1');
  ok('promise: the task is written (positive control)', x.r && x.r.ok && !!pt && pt.kind === 'promise' && pt.promiseKind === 'estimate' && pt.dueDate === '2026-11-12', x.e && x.e.message);
  ok('promise: the stored task reads "Send estimate", no why', pt && pt.text === 'Send estimate' && pt.title === 'Send estimate' && pt.why === '' && pt.callText === true && !/WHYSECRET/.test(JSON.stringify(pt)), pt);
  ok('promise: the call text holds the full text and why', ps && ps.full.text === 'Send estimate - WHYSECRET quoted 14k' && ps.full.title === ps.full.text && ps.full.why === 'WHYSECRET quoted 14k'
    && ps.generic.text === 'Send estimate' && ps.taskId === 'promise-cube_AAAAA1' && ps.leadId === 'L1', ps);
  x = await run(db, { id: 'cube_AAAAA1', action: 'promise', kind: 'callback', dueYmd: '2026-11-13' });
  const pt2 = db.docs.get('leads/L1/tasks/promise-cube_AAAAA1');
  ok('promise again with no why: the task is its own full text (callText off)', x.r && x.r.ok && pt2.text === 'Call back' && pt2.why === '' && pt2.callText === false, pt2);
  ok('…so an owner\'s screen does not lay the old why over it', !!CT && (await CT.overlay({ _userClaims: {}, db: {}, doc: (d, ...p) => p.join('/'), getDoc: async () => { throw new Error('must not read'); } }, [Object.assign({ id: 'promise-cube_AAAAA1', leadId: 'L1' }, pt2)]))[0].text === 'Call back');
  x = await run(db, { id: 'cube_AAAAA1', action: 'promise', kind: 'estimate', slot: 2, dueYmd: '2026-11-14', why: 'WHYSECRET two' });
  ok('a brief slot promise (promise-<id>-2): generic task, call text beside it', x.r && x.r.ok && db.docs.get('leads/L1/tasks/promise-cube_AAAAA1-2').text === 'Send estimate'
    && db.docs.get('leads/L1/task_call_text/promise-cube_AAAAA1-2').full.why === 'WHYSECRET two', x.e && x.e.message);
  // move: the cube task and the slot promise carry their call text along.
  db.docs.set('leads/L1/tasks/cube-cube_AAAAA1', { source: 'cube-acr', title: 'Follow up with Dana Test', text: 'Follow up with Dana Test', notes: 'The summary is on the customer\'s timeline.', callText: true, done: false });
  db.docs.set('leads/L1/task_call_text/cube-cube_AAAAA1', { leadId: 'L1', taskId: 'cube-cube_AAAAA1', source: 'cube-acr', full: { title: 'Text the estimate (Dana Test)' }, generic: { title: 'Follow up with Dana Test' } });
  x = await run(db, { id: 'cube_AAAAA1', action: 'move', leadId: 'L2' });
  ok('move runs (positive control)', x.r && !x.e && db.docs.has('leads/L2/tasks/cube-cube_AAAAA1'), x.e && x.e.message);
  const ms = db.docs.get('leads/L2/task_call_text/cube-cube_AAAAA1');
  ok('move: the cube task\'s call text follows it, re-pointed', ms && ms.full.title === 'Text the estimate (Dana Test)' && ms.leadId === 'L2' && !db.docs.has('leads/L1/task_call_text/cube-cube_AAAAA1'), ms);
  ok('move: the slot promise\'s call text follows it too', db.docs.has('leads/L2/task_call_text/promise-cube_AAAAA1-2') && !db.docs.has('leads/L1/task_call_text/promise-cube_AAAAA1-2'));

  console.log('\n4. the promise channel (owner pushes name the promise)');
  {
    const PC = require(path.join(ROOT, 'functions/promise-channel.js'));
    const d = memDb({
      'leads/L1': { userId: OWN, companyId: 'co1', firstName: 'Dana' },
      'leads/L1/tasks/promise-c1': { userId: OWN, leadId: 'L1', kind: 'promise', promiseKind: 'estimate', text: 'Send estimate', title: 'Send estimate', why: '', callText: true, done: false, dueDate: '2026-11-09' },
      'leads/L1/task_call_text/promise-c1': { full: { text: 'Send estimate - quoted 14k', title: 'Send estimate - quoted 14k', why: 'quoted 14k' }, generic: { text: 'Send estimate', title: 'Send estimate', why: '' } },
    });
    const r = await PC.readDuePromisePeople({ db: d, owner: OWN, nowMs: NOW, labels: {} });
    const said = JSON.stringify(r.people);
    ok('the owner\'s "promises due" carries the full promise, as before', r.ok && /quoted 14k/.test(said), said);
  }

  console.log('\n5. the browser');
  if (CT) {
    const task = { id: 'promise-c1', leadId: 'L1', title: 'Send estimate', text: 'Send estimate', why: '', callText: true };
    const plain = { id: 't2', leadId: 'L1', title: 'Typed', text: 'Typed' };
    let reads = [];
    const w = { _userClaims: {}, db: {}, doc: (db, ...p) => p.join('/'), getDoc: async (p) => { reads.push(p); return { exists: () => true, data: () => ({ full: { text: 'Send estimate - quoted', title: 'Send estimate - quoted', why: 'quoted' }, generic: { text: 'Send estimate', title: 'Send estimate', why: '' } }) }; } };
    const out = await CT.overlay(w, [task, plain]);
    ok('an owner: the call text is laid over the call task only', out[0].text === 'Send estimate - quoted' && out[0].why === 'quoted' && out[1] === plain && reads.join() === 'leads/L1/task_call_text/promise-c1', reads);
    reads = [];
    const v = await CT.overlay(Object.assign({}, w, { _userClaims: { role: 'viewer', companyId: 'co1' } }), [task]);
    ok('a viewer: nothing is read, the generic task stays', reads.length === 0 && v[0].text === 'Send estimate');
    const denied = await CT.overlay(Object.assign({}, w, { getDoc: async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); } }), [task]);
    ok('a refused read leaves the generic task (no throw)', denied[0].text === 'Send estimate');
    const done = await CT.overlay(w, [Object.assign({}, task, { done: true })], { openOnly: true });
    ok('openOnly: a done task is not read', done[0].text === 'Send estimate');
  }
  // Review 2026-11-09 item 1: the dashboard regroups and reads call text by
  // the lead in the task's PATH, never by a stored leadId field that differs.
  {
    const vm = require('vm');
    const SRC = read('docs/pro/js/tasks.js');
    const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));
    const rows = [
      { id: 'cube-c9', parent: 'leads/L1/tasks', data: { title: 'Follow up with Kim', text: 'Follow up with Kim', callText: true, done: false, leadId: 'LSTALE', companyId: 'co1', userId: 'u1' } },
      { id: 't2', parent: 'leads/L2/tasks', data: { text: 'plain', done: false, companyId: 'co1', userId: 'u1' } },
    ];
    const rig = () => {
      const log = { cg: 0, perLead: [], sideReads: [] };
      const listeners = {};
      const g = { console: { log() {}, warn() {}, error() {} }, Promise, Object, Array, Set, Map, JSON, Date, Math, String, Number, Error,
        setTimeout: () => 0, clearTimeout() {}, CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
        document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return { textContent: '', innerHTML: '' }; } },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
        db: {}, auth: { currentUser: null }, _leads: [], _leadsLoaded: false, _taskCache: {}, _user: null, _userClaims: {},
        NBDTodayPlan: TP, NBDTaskCallText: CT, renderLeads() {}, showToast() {}, serverTimestamp: () => '__TS__',
        collection: (_db, ...segs) => ({ segs }), collectionGroup: (_db, name) => ({ cg: name }), query: (base, ...cons) => ({ base, cons }),
        where: (f, op, v) => ({ where: [f, op, v] }), orderBy: (f, d) => ({ orderBy: [f, d || 'asc'] }),
        doc: (_db, ...segs) => segs.join('/'),
        getDoc: async (p) => { log.sideReads.push(p); return { exists: () => p === 'leads/L1/task_call_text/cube-c9', data: () => ({ full: { title: 'FULLTEXT the leak (Kim)', text: 'FULLTEXT the leak (Kim)' }, generic: { title: 'Follow up with Kim', text: 'Follow up with Kim' } }) }; },
        getDocs: async (q) => {
          const base = q.base || q;
          if (base.cg) { log.cg++; return { metadata: { fromCache: false }, docs: rows.map((r) => ({ id: r.id, ref: { parent: { path: r.parent } }, data: () => Object.assign({}, r.data) })) }; }
          const leadId = base.segs && base.segs[1]; log.perLead.push(leadId);
          return { metadata: { fromCache: false }, docs: rows.filter((r) => r.parent === 'leads/' + leadId + '/tasks').map((r) => ({ id: r.id, data: () => Object.assign({}, r.data) })) };
        },
        addDoc: async () => ({ id: 'n' }), updateDoc: async () => {}, deleteDoc: async () => {} };
      g.window = g; vm.createContext(g); vm.runInContext(SRC, g, { filename: 'tasks.js' });
      g._leads = [{ id: 'L1', userId: 'u1', companyId: 'co1' }, { id: 'L2', userId: 'u1', companyId: 'co1' }];
      g._user = { uid: 'u1' }; g._userClaims = { role: 'company_admin', companyId: 'co1' }; g._leadsLoaded = true;
      return { g, log };
    };
    const r = rig();
    await r.g.loadAllTasks(); for (let i = 0; i < 20; i++) await new Promise((s) => setImmediate(s));
    const c = (r.g._taskCache.L1 || []).find((x) => x.id === 'cube-c9');
    ok('dashboard: a call task whose stored leadId differs from its path stays in group mode (no per-lead fallback)', r.log.cg === 1 && r.log.perLead.length === 0, JSON.stringify(r.log));
    ok('…is filed under the lead in its path, with the call text read from that lead', !!c && c.title === 'FULLTEXT the leak (Kim)' && r.log.sideReads.join() === 'leads/L1/task_call_text/cube-c9', JSON.stringify({ c, reads: r.log.sideReads }));
    ok('…and keeps its stored leadId field as before', !!c && c.leadId === 'LSTALE' && (r.g._taskCache.L2 || []).length === 1);
    const r2 = rig();
    const one = await r2.g._loadTasks('L1');
    const c2 = (one || []).find((x) => x.id === 'cube-c9');
    ok('the per-lead read (task panel / fallback) reads the call text at the path\'s lead too', !!c2 && c2.title === 'FULLTEXT the leak (Kim)' && r2.log.sideReads.join() === 'leads/L1/task_call_text/cube-c9', JSON.stringify({ c2, reads: r2.log.sideReads }));
  }
  const tasksJs = read('docs/pro/js/tasks.js');
  const cust = read('docs/pro/js/customer-bootstrap.module.js');
  ok('tasks.js lays the call text over the one task load (lazy, never for a viewer)', /NBDTaskCallText/.test(tasksJs) && /task-call-text\.js\?v=\d+/.test(tasksJs));
  ok('the customer page lays it over both task reads (timeline + report)', (cust.match(/_overlayCallText\(/g) || []).length >= 3 && /task-call-text\.js\?v=\d+/.test(cust));
  ok('the browser file is not a boot tag (lazy only)', !/task-call-text\.js/.test(read('docs/pro/dashboard.html')) && !/task-call-text\.js/.test(read('docs/pro/customer.html')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
