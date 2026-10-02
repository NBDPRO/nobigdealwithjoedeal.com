/**
 * tests/call-center-notes-2026-10-01.test.js — Call Center stage 2:
 * transcript → AI notes → customer timeline + one follow-up task
 * (functions/call-center-logic.js + call-center.js runTranscribe, with the
 * transcriber and the model stubbed and an in-memory Firestore / bucket).
 *
 *   - gate OFF + no test ids → nothing runs (no audio leaves)
 *   - gate OFF + transcribeOnly → only that call, then the list clears
 *   - a business call → noted, activity on the lead, ONE task (create-only)
 *   - a personal call → no transcript kept, nothing filed on the lead
 *   - model output is sanitized: bad types, dates, extra promises dropped
 *   - day audio budget and per-file size cap hold
 *
 * Run: node tests/call-center-notes-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const { runTranscribe, setDeps, OWNER, COLLECTION, CONFIG } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function fakeDb(seed) {
  const docs = new Map(Object.entries(seed || {}));
  const mk = (p) => ({
    id: p.split('/').pop(), path: p,
    async get() { return { exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }; },
    async set(v, opt) { docs.set(p, opt && opt.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    async create(v) { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } docs.set(p, v); },
  });
  const query = (name, filters, lim) => ({
    where: (f, _op, v) => query(name, filters.concat([[f, v]]), lim),
    orderBy: () => query(name, filters, lim),
    limit: (n) => query(name, filters, n),
    get: async () => {
      const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2 && filters.every(([f, val]) => v[f] === val))
        .sort((a, b) => (b[1].startedAtMs || 0) - (a[1].startedAtMs || 0)).slice(0, lim || 1e9);
      return { forEach: (fn) => rows.forEach(([k, v]) => fn({ id: k.split('/')[1], data: () => v })) };
    },
  });
  return {
    docs,
    doc: mk,
    collection: (name) => Object.assign(query(name, [], null), { doc: (id) => mk(name + '/' + id) }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
  };
}
const deleted = [];
const bucket = { file: (p) => ({ download: async () => [Buffer.from('audio')], delete: async () => { deleted.push(p); } }) };
const NOW = Date.parse('2026-10-01T16:00:00Z');
const call = (id, extra) => Object.assign({ userId: OWNER, companyId: OWNER, status: 'stored', storagePath: 'calls/' + OWNER + '/cube-acr/2026-09-30/' + id + '.m4a', sizeBytes: 400000, startedAtMs: NOW - 3600e3, direction: 'inbound', contactName: 'Pat Example' }, extra);

let calls;
function stub(notesFor) {
  calls = { transcribe: 0, notes: 0, prompts: [] };
  setDeps({
    transcribe: async () => { calls.transcribe++; return { text: 'Hi Jo, the gutter is leaking again. I will come Thursday and send the quote.', durationSec: 95 }; },
    notes: async ({ prompt }) => { calls.notes++; calls.prompts.push(prompt); return notesFor(prompt); },
  });
}
const BUSINESS = () => ({ call_type: 'customer', summary: 'Gutter leaking again; Jo will come Thursday and send a quote.', promises: [{ who: 'jo', text: 'Send the gutter repair quote', due: '2026-10-02' }, { who: 'them', text: 'Leave the gate open', due: null }], follow_up_date: '2026-10-02', urgent: false });

(async () => {
  console.log('\n1. Sanitizer');
  const s = L.sanitizeNotes({ call_type: 'boss', summary: 'x'.repeat(2000), promises: Array.from({ length: 9 }, (_, i) => ({ who: i ? 'them' : 'jo', text: 'do ' + i, due: i === 1 ? 'next Tuesday' : '2026-10-0' + (i % 9 + 1) })), follow_up_date: '2026-13-45', urgent: 'yes' });
  ok('unknown call type → other', s.callType === 'other');
  ok('summary capped', s.summary.length <= 700);
  ok('at most 6 promises', s.promises.length === 6);
  ok('a non-ISO due date is dropped, not guessed', s.promises[1].due === null);
  ok('an impossible follow-up date → null', s.followUpDate === null);
  ok('urgent only on a real true', s.urgent === false);
  const p = L.sanitizeNotes({ call_type: 'personal', summary: 'Talked about dinner with mom', promises: [{ who: 'jo', text: 'pick up milk' }], follow_up_date: '2026-10-02', urgent: true });
  ok('personal: no summary detail, no promises, no follow-up', p.summary === 'Personal call.' && !p.promises.length && p.followUpDate === null && p.urgent === false);
  ok('garbage in → safe empty notes', L.sanitizeNotes(null).callType === 'other' && L.sanitizeNotes('x').promises.length === 0);

  ok('daily audio cap is 7.5 h, under Groq\'s 8 h free tier', L.DAY_AUDIO_SEC_CAP === 27000 && L.DAY_AUDIO_SEC_CAP < 8 * 3600);

  console.log('\n2. Picking');
  const list = [call('a', { id: 'a', startedAtMs: 1 }), call('b', { id: 'b', startedAtMs: 3 }), call('c', { id: 'c', startedAtMs: 2, transcribeAttempts: 3 }), call('d', { id: 'd', status: 'noted' })];
  ok('gate off, no test ids → nothing', L.pickToTranscribe(list, { live: false, allowIds: [], maxCount: 5, secLeft: 1e6 }).length === 0);
  ok('test ids work with the gate off, and only those', L.pickToTranscribe(list, { live: false, allowIds: ['a'], maxCount: 5, secLeft: 0 }).map((c) => c.id).join() === 'a');
  ok('live: newest first, skips noted + 3-strike calls', L.pickToTranscribe(list, { live: true, allowIds: [], maxCount: 5, secLeft: 1e6 }).map((c) => c.id).join() === 'b,a');
  ok('live: the day budget holds', L.pickToTranscribe(list, { live: true, allowIds: [], maxCount: 5, secLeft: 150 }).map((c) => c.id).join() === 'b');

  console.log('\n3. Task + activity shapes');
  const n = L.sanitizeNotes(BUSINESS());
  const task = L.buildFollowUpTask({ call: { id: 'cube_x', contactName: 'Pat Example' }, notes: n, leadId: 'L1', ownerUid: 'U', todayYmd: '2026-10-01' });
  ok('task names Jo\'s promise and who', task && task.title === 'Send the gutter repair quote (Pat Example)');
  ok('task due = earliest of the promise / follow-up dates', task.dueDate === '2026-10-02');
  ok('task notes list only Jo\'s promises', /Send the gutter/.test(task.notes) && !/gate open/.test(task.notes));
  ok('no promise by Jo and no follow-up → no task', L.buildFollowUpTask({ call: { id: 'x' }, notes: L.sanitizeNotes({ call_type: 'customer', summary: 's', promises: [{ who: 'them', text: 'pay' }] }), leadId: 'L', ownerUid: 'U', todayYmd: '2026-10-01' }) === null);
  const act = L.buildCallActivity({ call: { id: 'cube_x', direction: 'outbound', contactName: 'Pat Example', durationSec: 95 }, notes: n, ownerUid: 'U' });
  ok('activity label + source', act.label === 'You called · Pat Example' && act.source === 'cube-acr' && act.type === 'call');

  console.log('\n4. runTranscribe: gate off, no test ids');
  stub(BUSINESS);
  let db = fakeDb({ [COLLECTION + '/cube_1']: call('cube_1', { leadId: 'L1' }), 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  let r = await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('does nothing; no audio sent anywhere', r.state === 'off' && calls.transcribe === 0 && calls.notes === 0);

  console.log('\n5. The one-call test (gate off, transcribeOnly)');
  db = fakeDb({
    [CONFIG]: { transcribeOnly: ['cube_1'] },
    [COLLECTION + '/cube_1']: call('cube_1', { leadId: 'L1' }),
    [COLLECTION + '/cube_2']: call('cube_2', { leadId: 'L1' }),
    'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER },
  });
  r = await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('only the test call ran', r.state === 'test' && r.noted === 1 && calls.transcribe === 1 && db.docs.get(COLLECTION + '/cube_2').status === 'stored', JSON.stringify(r));
  const doc1 = db.docs.get(COLLECTION + '/cube_1');
  ok('call doc noted with transcript + notes', doc1.status === 'noted' && /gutter/.test(doc1.transcript) && doc1.promises.length === 2 && doc1.followUpDate === '2026-10-02' && doc1.durationSec === 95);
  ok('the prompt carries the CRM name and direction', /CRM customer this number belongs to: Pat Example/.test(calls.prompts[0]) && /They called Jo/.test(calls.prompts[0]));
  ok('timeline entry on the lead', !!db.docs.get('leads/L1/activity/cube-cube_1'));
  ok('one follow-up task on the lead', db.docs.get('leads/L1/tasks/cube-cube_1') && db.docs.get('leads/L1/tasks/cube-cube_1').done === false && r.tasks === 1);
  ok('the test list clears after it runs', db.docs.get(CONFIG).transcribeOnly.length === 0);
  ok('audio seconds counted for the day', db.docs.get(CONFIG).audioSecUsed === 95 && db.docs.get(CONFIG).audioSecDay === '2026-10-01');

  console.log('\n5b. An old (backlog) call: notes + timeline, no stale task');
  stub(BUSINESS);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_old'] }, [COLLECTION + '/cube_old']: call('cube_old', { leadId: 'L1', startedAtMs: NOW - 60 * 24 * 3600e3 }), 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  r = await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('old call is noted with its timeline entry', db.docs.get(COLLECTION + '/cube_old').status === 'noted' && !!db.docs.get('leads/L1/activity/cube-cube_old'));
  ok('old call makes no follow-up task', !db.docs.has('leads/L1/tasks/cube-cube_old') && r.tasks === 0);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_1'] }, [COLLECTION + '/cube_1']: call('cube_1', { leadId: 'L1' }), 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });

  console.log('\n6. Re-run never un-ticks a done task');
  db.docs.set('leads/L1/tasks/cube-cube_1', Object.assign({}, db.docs.get('leads/L1/tasks/cube-cube_1'), { done: true }));
  db.docs.set(COLLECTION + '/cube_1', Object.assign({}, db.docs.get(COLLECTION + '/cube_1'), { status: 'stored' }));
  await db.doc(CONFIG).set({ transcribeOnly: ['cube_1'] }, { merge: true });
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('task stays done', db.docs.get('leads/L1/tasks/cube-cube_1').done === true);

  console.log('\n7. Live: personal call, unmatched call, failures');
  stub((prompt) => (/Mom/.test(prompt) ? { call_type: 'personal', summary: 'family', promises: [{ who: 'jo', text: 'x' }] } : BUSINESS()));
  db = fakeDb({
    [COLLECTION + '/cube_p']: call('cube_p', { leadId: 'L1', contactName: 'Mom', startedAtMs: NOW - 10e3 }),
    [COLLECTION + '/cube_u']: call('cube_u', { leadId: null, contactName: '', startedAtMs: NOW - 20e3 }),
    [COLLECTION + '/cube_big']: call('cube_big', { leadId: null, sizeBytes: 30 * 1024 * 1024, startedAtMs: NOW - 30e3 }),
    'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER },
  });
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  const pd = db.docs.get(COLLECTION + '/cube_p');
  ok('personal: no transcript kept, status personal', pd.status === 'personal' && pd.transcript === null && pd.summary === 'Personal call.');
  ok('personal: the CRM audio copy is deleted and the path cleared', deleted.some((p) => /cube_p\.m4a$/.test(p)) && pd.storagePath === null && pd.audioRemoved === 'personal');
  ok('business calls keep their audio', !deleted.some((p) => /cube_u\.m4a$/.test(p)) && !!db.docs.get(COLLECTION + '/cube_u').storagePath);
  ok('personal: nothing filed on the lead', !db.docs.has('leads/L1/activity/cube-cube_p') && !db.docs.has('leads/L1/tasks/cube-cube_p'));
  ok('unmatched call: noted, no lead writes', db.docs.get(COLLECTION + '/cube_u').status === 'noted');
  ok('over Groq\'s 25 MB → too_large, not sent', db.docs.get(COLLECTION + '/cube_big').status === 'too_large' && calls.transcribe === 2);
  stub(() => { throw new Error('model down'); });
  db = fakeDb({ [COLLECTION + '/cube_f']: call('cube_f', { leadId: null }) });
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  const fd = db.docs.get(COLLECTION + '/cube_f');
  ok('a failure counts an attempt and keeps the call stored for retry', r.failed === 1 && fd.status === 'stored' && fd.transcribeAttempts === 1 && /model down/.test(fd.transcribeError));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
