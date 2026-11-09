// tests/q11-task-summary-backfill-2026-11-09.test.js
// scripts/backfill-q11-task-summaries.js: Call to Close Q11 backfill. Follow-up
// tasks filed before 2026-11-09 still carry call content in their notes
// ("Call: <summary>" on cube-/sms- tasks, "Summary:" / "Urgent:" lines on
// thursday- tasks), and viewers read tasks. The script rewrites those notes
// through scrubTaskSummary. Dry run by default; --apply writes notes (+
// updatedAt) only. No network: a fake Firestore, and a fake fetch for the
// REST adapter's collection-group query (token mode).
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'scripts', 'backfill-q11-task-summaries.js'));
const R = require(path.join(__dirname, '..', 'scripts', '_firestore-rest.js'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL', m); } }
function throws(fn, re, m) { try { fn(); ok(false, m + ' (no throw)'); } catch (e) { ok(re.test(String(e.message)), m + ' -> ' + e.message); } }

const SERVER_TS = { __ts: true };
const OLD_CUBE = 'Call: SECRET-A said the roof leaks\n\nYou said you would:\n• Send the quote';
const CLEAN_CUBE = 'The summary is on the customer\'s timeline.\n\nYou said you would:\n• Send the quote';
const OLD_THU = 'Best time: am\nNumber: +15135550100\nUrgent: SECRET-C1 water inside\nSummary: SECRET-C2 hail damage';

function seed() {
  return {
    'leads/L1': { companyId: 'co1', userId: 'solo1' },
    'leads/L2': { userId: 'solo1' },
    'leads/L3': { companyId: 'co2', userId: 'u3' },
    'leads/L1/tasks/cube-a': { notes: OLD_CUBE, source: 'cube-acr', title: 'Send the quote' },
    'leads/L1/tasks/sms-b': { notes: 'Call: SECRET-B texts about gutters', source: 'sms-backup' },
    'leads/L1/tasks/thursday-c': { notes: OLD_THU, source: 'thursday' },
    'leads/L1/tasks/cube-clean': { notes: CLEAN_CUBE, source: 'cube-acr' },
    'leads/L1/tasks/cube-nonotes': { source: 'cube-acr' },
    'leads/L1/tasks/thursday-f': { notes: 'Call: SECRET-F typed by Jo', source: 'thursday' },
    'leads/L1/tasks/promise-x': { notes: 'Call: SECRET-P', source: 'promise' },
    'leads/L1/tasks/manual1': { notes: 'Call: SECRET-M', source: 'rep' },
    'leads/L1/tasks/xcube-y': { notes: 'Call: SECRET-Y' },
    'leads/L2/tasks/cube-d': { notes: 'Call: SECRET-D', source: 'cube-acr' },
    'leads/L3/tasks/thursday-e': { notes: 'Summary: SECRET-E\nNumber: +15135550101', source: 'thursday' },
    'tasks/cube-top': { notes: 'Call: SECRET-T' },
    'companies/co1/tasks/cube-z': { notes: 'Call: SECRET-Z' },
  };
}

// ── a fake Firestore (admin-like): collectionGroup paging, doc get/update ──
function fakeDb(docs) {
  const writes = [], forbidden = [];
  const isTaskPath = (p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === 'tasks'; };
  function ref(p) {
    return {
      path: p,
      get: async () => ({ exists: Object.prototype.hasOwnProperty.call(docs, p), data: () => docs[p] }),
      update: async (...args) => {
        if (!Object.prototype.hasOwnProperty.call(docs, p)) throw new Error('NOT_FOUND ' + p);
        const patch = {};
        for (let i = 0; i < args.length; i += 2) patch[String(args[i])] = args[i + 1];
        writes.push({ p, patch });
        docs[p] = Object.assign({}, docs[p], patch);
      },
      set: async () => { forbidden.push('set ' + p); },
      delete: async () => { forbidden.push('delete ' + p); },
    };
  }
  function query(group, after, lim) {
    return {
      orderBy(f) { if (f !== '__name__') throw new Error('orderBy ' + f); return this; },
      limit(n) { return query(group, after, n); },
      startAfter(snap) { return query(group, snap.ref.path, lim); },
      async get() {
        const paths = Object.keys(docs).filter(isTaskPath).sort().filter((p) => after === undefined || p > after);
        const page = lim ? paths.slice(0, lim) : paths;
        const out = page.map((p) => ({ id: p.split('/').pop(), ref: ref(p), data: () => docs[p] }));
        return { empty: !out.length, size: out.length, docs: out };
      },
    };
  }
  return { writes, forbidden, db: { doc: ref, collectionGroup: (g) => { if (g !== 'tasks') throw new Error('group ' + g); return query(g); } } };
}

(async () => {
  // ── parseArgs ──
  const a = S.parseArgs([]);
  ok(a.apply === false && a.company === '' && a.project === 'nobigdeal-pro', 'dry run by default, all companies, default project');
  ok(S.parseArgs(['--apply']).apply === true, '--apply');
  ok(S.parseArgs(['--company', 'co1']).company === 'co1', '--company');
  throws(() => S.parseArgs(['--company', 'a/b']), /company/, 'path-like company refused');
  throws(() => S.parseArgs(['--company']), /company/, 'empty company refused');
  throws(() => S.parseArgs(['--yes']), /unknown/, 'unknown flag refused');
  throws(() => S.parseArgs(['--write']), /unknown/, '--write is not an alias');

  // ── planTask (pure) ──
  ok(S.planTask('leads/L/tasks/cube-1', { notes: OLD_CUBE }).notes === 'You said you would:\n• Send the quote', 'cube-: drops the Call: paragraph');
  ok(S.planTask('leads/L/tasks/sms-1', { notes: 'Call: x' }).notes === '', 'sms-: Call-only notes become empty');
  ok(S.planTask('leads/L/tasks/thursday-1', { notes: OLD_THU }).notes === 'Best time: am\nNumber: +15135550100', 'thursday-: drops Summary / Urgent lines');
  ok(S.planTask('leads/L/tasks/thursday-1', { notes: 'Call: x' }) === null, 'thursday- uses the thursday scrub (Call: kept)');
  ok(S.planTask('leads/L/tasks/cube-1', { notes: 'Summary: typed' }) === null, 'cube- uses the call scrub (Summary: kept)');
  ok(S.planTask('leads/L/tasks/cube-1', { notes: CLEAN_CUBE }) === null, 'already clean: null');
  ok(S.planTask('leads/L/tasks/cube-1', {}) === null && S.planTask('leads/L/tasks/cube-1', { notes: 5 }) === null, 'non-string notes: null');
  ok(S.planTask('leads/L/tasks/promise-1', { notes: 'Call: x' }) === null, 'other prefix: null');
  ok(S.planTask('tasks/cube-1', { notes: 'Call: x' }) === null, 'top-level tasks: null');
  ok(S.planTask('companies/c/tasks/cube-1', { notes: 'Call: x' }) === null, 'non-lead tasks: null');

  // ── dry run: counts, no writes ──
  let lines = [];
  let log = (s) => lines.push(String(s));
  let f = fakeDb(seed());
  let r = await S.run({ db: f.db, args: S.parseArgs([]), log, serverTimestamp: () => SERVER_TS, pageSize: 3 });
  ok(f.writes.length === 0 && f.forbidden.length === 0, 'dry run writes nothing');
  ok(r.counts.toChange === 5 && r.counts.written === 0, 'dry run: 5 to change -> ' + JSON.stringify(r.counts));
  ok(r.counts.byPrefix.cube === 2 && r.counts.byPrefix.sms === 1 && r.counts.byPrefix.thursday === 2, 'dry run: per-prefix counts');
  ok(r.counts.alreadyClean === 3, 'already clean: cube-clean, cube-nonotes, thursday-f -> ' + r.counts.alreadyClean);
  ok(r.counts.otherPrefix === 3 && r.counts.notLeadTask === 2, 'other prefixes and non-lead tasks counted, skipped');
  ok(r.counts.scanned === 13, 'scanned every tasks doc across pages -> ' + r.counts.scanned);
  ok(lines.some((l) => /DRY RUN/.test(l)) && lines.some((l) => /--apply/.test(l)), 'dry run says so and how to write');
  ok(!lines.join('\n').includes('SECRET'), 'dry run output carries no summary text');

  // ── --apply: rewrites exactly the old-form notes ──
  lines = [];
  const docs = seed();
  const before = JSON.parse(JSON.stringify(docs));
  f = fakeDb(docs);
  r = await S.run({ db: f.db, args: S.parseArgs(['--apply']), log, serverTimestamp: () => SERVER_TS, pageSize: 4 });
  const wrote = f.writes.map((w) => w.p).sort();
  ok(JSON.stringify(wrote) === JSON.stringify(['leads/L1/tasks/cube-a', 'leads/L1/tasks/sms-b', 'leads/L1/tasks/thursday-c', 'leads/L2/tasks/cube-d', 'leads/L3/tasks/thursday-e']), 'apply: exactly the five old-form tasks -> ' + wrote.join(','));
  ok(f.writes.every((w) => Object.keys(w.patch).sort().join() === 'notes,updatedAt' && w.patch.updatedAt === SERVER_TS), 'apply: writes notes + updatedAt only');
  ok(f.forbidden.length === 0, 'apply: no set, no delete');
  ok(docs['leads/L1/tasks/cube-a'].notes === 'You said you would:\n• Send the quote' && docs['leads/L1/tasks/cube-a'].title === 'Send the quote', 'cube-a scrubbed, other fields kept');
  ok(docs['leads/L1/tasks/sms-b'].notes === '', 'sms-b scrubbed to empty, task kept');
  ok(docs['leads/L1/tasks/thursday-c'].notes === 'Best time: am\nNumber: +15135550100', 'thursday-c scrubbed');
  ok(docs['leads/L3/tasks/thursday-e'].notes === 'Number: +15135550101', 'thursday-e scrubbed');
  for (const p of ['leads/L1/tasks/cube-clean', 'leads/L1/tasks/cube-nonotes', 'leads/L1/tasks/thursday-f', 'leads/L1/tasks/promise-x', 'leads/L1/tasks/manual1', 'leads/L1/tasks/xcube-y', 'tasks/cube-top', 'companies/co1/tasks/cube-z']) {
    ok(JSON.stringify(docs[p]) === JSON.stringify(before[p]), 'untouched: ' + p);
  }
  ok(r.counts.written === 5 && r.counts.failures === 0, 'apply: 5 written, 0 failures');
  ok(!lines.join('\n').includes('SECRET'), 'apply output carries no summary text');

  // ── second run is a no-op ──
  lines = [];
  const w0 = f.writes.length;
  r = await S.run({ db: f.db, args: S.parseArgs(['--apply']), log, serverTimestamp: () => SERVER_TS, pageSize: 4 });
  ok(r.counts.toChange === 0 && f.writes.length === w0, 'second run: 0 to change, no writes');
  ok(lines.some((l) => /nothing to change/i.test(l)), 'second run says nothing to change');

  // ── company scoping ──
  f = fakeDb(seed());
  r = await S.run({ db: f.db, args: S.parseArgs(['--apply', '--company', 'co1']), log: () => {}, serverTimestamp: () => SERVER_TS });
  ok(f.writes.map((w) => w.p).sort().join() === 'leads/L1/tasks/cube-a,leads/L1/tasks/sms-b,leads/L1/tasks/thursday-c', 'co1: only L1 tasks');
  ok(r.counts.outOfScope === 2, 'co1: two old-form tasks out of scope -> ' + r.counts.outOfScope);
  f = fakeDb(seed());
  await S.run({ db: f.db, args: S.parseArgs(['--apply', '--company', 'solo1']), log: () => {}, serverTimestamp: () => SERVER_TS });
  ok(f.writes.map((w) => w.p).join() === 'leads/L2/tasks/cube-d', 'solo owner: a lead with no companyId and userId = company (a companyId wins over userId)');
  f = fakeDb(seed());
  await S.run({ db: f.db, args: S.parseArgs(['--company', 'co2']), log: () => {}, serverTimestamp: () => SERVER_TS });
  ok(f.writes.length === 0, 'scoped dry run writes nothing');
  f = fakeDb(seed());
  r = await S.run({ db: f.db, args: S.parseArgs(['--apply', '--company', 'nobody']), log: () => {}, serverTimestamp: () => SERVER_TS });
  ok(f.writes.length === 0 && r.counts.toChange === 0, 'unknown company: nothing');

  // ── a lead that is gone: out of scope when scoped, never written ──
  const orphan = seed(); delete orphan['leads/L3'];
  f = fakeDb(orphan);
  r = await S.run({ db: f.db, args: S.parseArgs(['--apply', '--company', 'co2']), log: () => {}, serverTimestamp: () => SERVER_TS });
  ok(f.writes.length === 0, 'scoped: a task whose lead is gone is not written');

  // ── a failed write is counted, the run goes on, exit is non-zero-worthy ──
  f = fakeDb(seed());
  const realDoc = f.db.doc;
  f.db.doc = (p) => { const x = realDoc(p); if (p === 'leads/L1/tasks/sms-b') x.update = async () => { throw new Error('boom SECRET-leak'); }; return x; };
  lines = [];
  r = await S.run({ db: f.db, args: S.parseArgs(['--apply']), log, serverTimestamp: () => SERVER_TS });
  ok(r.counts.failures === 1 && r.counts.written === 4, 'one failure counted, the rest written');
  ok(!lines.join('\n').includes('SECRET'), 'a failure prints no error text from the write');

  // ── REST adapter: collection-group query (token mode) ──
  const calls = [];
  const ROOT = 'projects/nobigdeal-pro/databases/(default)/documents';
  const fakeFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (/:runQuery$/.test(url)) {
      if (body.structuredQuery.startAt) return { status: 200, text: async () => JSON.stringify([{ readTime: 'x' }]) };
      return { status: 200, text: async () => JSON.stringify([
        { document: { name: ROOT + '/leads/L1/tasks/cube-a', fields: { notes: { stringValue: 'n' }, done: { booleanValue: false } } }, readTime: 'x' },
        { document: { name: ROOT + '/leads/L 1/tasks/sms-b', fields: {} }, readTime: 'x' },
      ]) };
    }
    return { status: 200, text: async () => '{}' };
  };
  const rdb = R.restFirestore({ projectId: 'nobigdeal-pro', token: 'tok', fetchImpl: fakeFetch });
  ok(typeof rdb.doc === 'function' && typeof rdb.collectionGroup === 'function', 'REST: doc() kept, collectionGroup() added');
  const s1 = await rdb.collectionGroup('tasks').orderBy('__name__').limit(2).get();
  const q1 = calls[0];
  ok(/documents:runQuery$/.test(q1.url) && q1.init.method === 'POST' && q1.init.headers.Authorization === 'Bearer tok', 'REST: POST documents:runQuery with the bearer header');
  const sq = q1.body.structuredQuery;
  ok(sq.from[0].collectionId === 'tasks' && sq.from[0].allDescendants === true, 'REST: collection group from');
  ok(sq.orderBy[0].field.fieldPath === '__name__' && sq.orderBy[0].direction === 'ASCENDING' && sq.limit === 2, 'REST: orderBy __name__, limit');
  ok(s1.size === 2 && !s1.empty && s1.docs[0].id === 'cube-a' && s1.docs[0].ref.path === 'leads/L1/tasks/cube-a' && s1.docs[0].data().notes === 'n' && s1.docs[0].data().done === false, 'REST: docs decode to {id, ref.path, data()}');
  ok(typeof s1.docs[0].ref.update === 'function' && typeof s1.docs[0].ref.get === 'function', 'REST: a result ref is a doc ref');
  const s2 = await rdb.collectionGroup('tasks').orderBy('__name__').limit(2).startAfter(s1.docs[1]).get();
  const st = calls[1].body.structuredQuery.startAt;
  ok(st && st.before === false && st.values[0].referenceValue === ROOT + '/leads/L 1/tasks/sms-b', 'REST: startAfter -> startAt {before:false, referenceValue}');
  ok(s2.empty === true && s2.size === 0 && s2.docs.length === 0, 'REST: a readTime-only reply is an empty page');
  throws(() => rdb.collectionGroup('a/b'), /collection/, 'REST: bad collection id refused');
  throws(() => rdb.collectionGroup('tasks').orderBy('dueDate'), /__name__/, 'REST: only __name__ ordering');
  const bad = R.restFirestore({ projectId: 'p', token: 't', fetchImpl: async () => ({ status: 403, text: async () => JSON.stringify({ error: { message: 'denied' } }) }) });
  let err = null; try { await bad.collectionGroup('tasks').get(); } catch (e) { err = e; }
  ok(err && /HTTP 403/.test(err.message) && !/Bearer|\bt\b/.test(err.message.replace('HTTP 403', '')), 'REST: a failed query throws with the status, no token');

  // ── the whole run over the REST adapter, against a tiny fake Firestore server ──
  const store = seed();
  const restWrites = [];
  const unq = (n) => n.slice(ROOT.length + 1);
  const serverFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const u = url.replace('https://firestore.googleapis.com/v1/', '');
    if (/:runQuery$/.test(u)) {
      const q = body.structuredQuery;
      const after = q.startAt ? unq(q.startAt.values[0].referenceValue) : null;
      const paths = Object.keys(store).filter((p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === q.from[0].collectionId; }).sort().filter((p) => after === null || p > after).slice(0, q.limit || 1e9);
      const arr = paths.map((p) => ({ document: { name: ROOT + '/' + p, fields: R.encode(store[p]).mapValue.fields }, readTime: 'x' }));
      return { status: 200, text: async () => JSON.stringify(arr.length ? arr : [{ readTime: 'x' }]) };
    }
    if (/:commit$/.test(u)) {
      for (const w of body.writes) { restWrites.push(w); const p = unq(w.update.name); store[p] = Object.assign({}, store[p], { notes: w.update.fields.notes.stringValue }); }
      return { status: 200, text: async () => '{}' };
    }
    const p = decodeURIComponent(unq(u));
    if (!store[p]) return { status: 404, text: async () => '{}' };
    return { status: 200, text: async () => JSON.stringify({ fields: R.encode(store[p]).mapValue.fields }) };
  };
  const tdb = R.restFirestore({ projectId: 'nobigdeal-pro', token: 'tok', fetchImpl: serverFetch });
  lines = [];
  r = await S.run({ db: tdb, args: S.parseArgs(['--apply', '--company', 'co1']), log, serverTimestamp: R.serverTimestamp, pageSize: 3 });
  ok(r.counts.written === 3 && restWrites.length === 3, 'token mode: three writes for co1');
  ok(restWrites.every((w) => w.updateMask.fieldPaths.join() === 'notes' && w.currentDocument.exists === true && w.updateTransforms[0].fieldPath === 'updatedAt'), 'token mode: notes mask, must-exist, updatedAt transform');
  ok(store['leads/L1/tasks/thursday-c'].notes === 'Best time: am\nNumber: +15135550100' && store['leads/L2/tasks/cube-d'].notes === 'Call: SECRET-D', 'token mode: scoped rewrite');
  ok(!lines.join('\n').includes('SECRET'), 'token mode output carries no summary text');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
