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
    collection: (name) => Object.assign(query(name, [], null), { doc: (id) => mk(name + '/' + id), add: async (v) => { const id = 'auto' + docs.size; docs.set(name + '/' + id, v); return { id }; } }),
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

  ok('the cap is a setting: unset / junk → 7.5 h; 20 → 20 h; bounded to 1–48 h',
    L.dayAudioCapSec(undefined) === 27000 && L.dayAudioCapSec(null) === 27000 && L.dayAudioCapSec('') === 27000 && L.dayAudioCapSec('abc') === 27000
      && L.dayAudioCapSec(0) === 27000 && L.dayAudioCapSec(-5) === 27000 && L.dayAudioCapSec(20) === 72000 && L.dayAudioCapSec('12') === 43200
      && L.dayAudioCapSec(0.5) === 3600 && L.dayAudioCapSec(500) === 48 * 3600);
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

  console.log('\n5a. The daily audio cap is a setting (catch-up after a Groq upgrade)');
  stub(BUSINESS);
  const capDb = (extra) => fakeDb({
    [CONFIG]: Object.assign({ audioSecDay: '2026-10-01', audioSecUsed: 27000 }, extra),
    [COLLECTION + '/cube_cap']: call('cube_cap', { leadId: 'L1' }),
    'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER },
  });
  db = capDb({});
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('at the default 7.5 h, a spent day transcribes nothing more', r.picked === 0 && db.docs.get(COLLECTION + '/cube_cap').status === 'stored', JSON.stringify(r));
  db = capDb({ dayAudioCapHours: 20 });
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('with dayAudioCapHours 20, the same day keeps going', r.picked === 1 && db.docs.get(COLLECTION + '/cube_cap').status === 'noted', JSON.stringify(r));

  console.log('\n5b. An old (backlog) call: notes + timeline, no stale task');
  stub(BUSINESS);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_old'] }, [COLLECTION + '/cube_old']: call('cube_old', { leadId: 'L1', startedAtMs: NOW - 60 * 24 * 3600e3 }), 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  r = await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('old call is noted with its timeline entry', db.docs.get(COLLECTION + '/cube_old').status === 'noted' && !!db.docs.get('leads/L1/activity/cube-cube_old'));
  ok('old call makes no follow-up task', !db.docs.has('leads/L1/tasks/cube-cube_old') && r.tasks === 0);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_1'] }, [COLLECTION + '/cube_1']: call('cube_1', { leadId: 'L1' }), 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });

  console.log('\n5c. A call Jo marked not-personal stays business');
  stub(() => ({ call_type: 'personal', summary: 'family', promises: [] }));
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_np'] }, [COLLECTION + '/cube_np']: call('cube_np', { leadId: null, notPersonal: true }) });
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('the model\'s personal verdict is overridden: noted, transcript kept, audio kept', db.docs.get(COLLECTION + '/cube_np').status === 'noted' && !!db.docs.get(COLLECTION + '/cube_np').transcript && !deleted.some((p) => /cube_np/.test(p)));
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_1'] }, [COLLECTION + '/cube_1']: call('cube_1', { leadId: 'L1' }), 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  stub(BUSINESS);
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

  console.log('\n8. Groq rate limit (2026-10-02: six calls dropped for good by a busy hour)');
  // The real error shape from voice-intelligence.js transcribeGroqBuffer.
  const rateErr = () => { const e = new Error('Groq rejected: Rate limit reached for model `whisper-large-v3-turbo` in organization `org_x` service tier `on_demand` on seconds of audio per hour (ASH)'); e.status = 429; return e; };
  calls = { transcribe: 0, notes: 0, prompts: [] };
  setDeps({ transcribe: async () => { calls.transcribe++; throw rateErr(); }, notes: async () => BUSINESS() });
  db = fakeDb({
    [COLLECTION + '/cube_r1']: call('cube_r1', { leadId: null, startedAtMs: NOW - 10e3, transcribeAttempts: 2 }),
    [COLLECTION + '/cube_r2']: call('cube_r2', { leadId: null, startedAtMs: NOW - 20e3 }),
    [COLLECTION + '/cube_r3']: call('cube_r3', { leadId: null, startedAtMs: NOW - 30e3 }),
  });
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  const r1 = db.docs.get(COLLECTION + '/cube_r1');
  ok('a rate limit is no strike: attempts unchanged, still stored, error kept', r1.status === 'stored' && r1.transcribeAttempts === 2 && /Rate limit/.test(r1.transcribeError), JSON.stringify(r1));
  ok('...and the run stops at once (the next calls would be refused too)', calls.transcribe === 1 && r.rateLimited === true && r.failed === 0, JSON.stringify(r));
  ok('...the untried calls are untouched for the next run', !db.docs.get(COLLECTION + '/cube_r2').transcribeError && !db.docs.get(COLLECTION + '/cube_r3').transcribeError);
  ok('isRateLimited: 429 status, the stored message, and a real failure',
    L.isRateLimited(rateErr()) && L.isRateLimited('Groq rejected: Rate limit reached for model x') && !L.isRateLimited(new Error('model down')) && !L.isRateLimited('The operation was aborted due to timeout') && !L.isRateLimited(null));
  // A call already at 3 strikes whose last error was a rate limit is picked
  // again (recovers the ones dropped before this fix); a real 3rd failure is not.
  const pickList = [
    { id: 'victim', status: 'stored', storagePath: 'p', sizeBytes: 4000, startedAtMs: 3, transcribeAttempts: 3, transcribeError: 'Groq rejected: Rate limit reached for model `whisper-large-v3-turbo`' },
    { id: 'broken', status: 'stored', storagePath: 'p', sizeBytes: 4000, startedAtMs: 2, transcribeAttempts: 3, transcribeError: 'model down' },
  ];
  ok('a 3-strike call whose last error was a rate limit is picked again; a real 3-strike failure is not',
    L.pickToTranscribe(pickList, { live: true, allowIds: [], maxCount: 5, secLeft: 1e6 }).map((c) => c.id).join() === 'victim');

  console.log('\n9. "The CRM knows I called" — the lead itself is updated (2026-10-03)');
  const tsOf = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v);
  stub(BUSINESS);
  // BUSINESS: follow_up_date 2026-10-02; NOW is 2026-10-01 (ET); call 1 h ago.
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_lc'] }, [COLLECTION + '/cube_lc']: call('cube_lc', { leadId: 'L9' }), 'leads/L9': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  r = await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  let l9 = db.docs.get('leads/L9');
  ok('a noted call sets lastContactedAt (the CALL time, a Timestamp) + lastContactType "call"', tsOf(l9.lastContactedAt) === NOW - 3600e3 && typeof l9.lastContactedAt.toMillis === 'function' && l9.lastContactType === 'call' && r.leadsUpdated === 1, JSON.stringify(l9));
  ok('a lead with no follow-up gets the AI follow-up date, as YYYY-MM-DD (the kanban Due chip\'s format)', l9.followUp === '2026-10-02');
  ok('the timeline entry carries when the call happened', db.docs.get('leads/L9/activity/cube-cube_lc').startedAtMs === NOW - 3600e3);
  const runLead = async (lead, extra) => {
    stub(BUSINESS);
    const d2 = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_lx'] }, [COLLECTION + '/cube_lx']: call('cube_lx', Object.assign({ leadId: 'LX' }, extra)), 'leads/LX': Object.assign({ firstName: 'Pat', userId: OWNER }, lead) });
    await runTranscribe({ db: d2, bucket, live: false, nowMs: NOW });
    return d2.docs.get('leads/LX');
  };
  let lx = await runLead({ followUp: '2026-10-20' });
  ok('a FUTURE follow-up Jo set is never overwritten', lx.followUp === '2026-10-20');
  lx = await runLead({ followUp: '2026-10-01' });
  ok('a follow-up due TODAY is still Jo\'s (not in the past) — kept', lx.followUp === '2026-10-01');
  lx = await runLead({ followUp: '2026-09-20' });
  ok('a follow-up already in the past is replaced by the call\'s', lx.followUp === '2026-10-02');
  lx = await runLead({ followUp: 'call after the storm' });
  ok('a follow-up Jo typed as words is left alone', lx.followUp === 'call after the storm');
  lx = await runLead({ lastContactedAt: new Date(NOW - 600e3) });
  ok('lastContactedAt is never rolled back by an older call', tsOf(lx.lastContactedAt) === NOW - 600e3 || (lx.lastContactedAt instanceof Date && lx.lastContactedAt.getTime() === NOW - 600e3), JSON.stringify(lx.lastContactedAt));
  ok('…while the follow-up is still filled', lx.followUp === '2026-10-02');
  lx = await runLead({}, { startedAtMs: NOW - 40 * 24 * 3600e3 });
  ok('a backlog call (older than the 14-day task window) sets lastContactedAt but no follow-up', tsOf(lx.lastContactedAt) === NOW - 40 * 24 * 3600e3 && lx.followUp === undefined);
  stub(() => Object.assign(BUSINESS(), { follow_up_date: null }));
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_nf'] }, [COLLECTION + '/cube_nf']: call('cube_nf', { leadId: 'LN' }), 'leads/LN': { firstName: 'Pat', userId: OWNER, followUp: '2026-09-01' } });
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('no AI follow-up date → the lead\'s follow-up is untouched', db.docs.get('leads/LN').followUp === '2026-09-01' && db.docs.get('leads/LN').lastContactType === 'call');
  ok('leadContactPatch: nothing new → null', typeof L.leadContactPatch === 'function' && L.leadContactPatch({ lead: { lastContactedAt: NOW, followUp: '2026-12-01' }, call: { startedAtMs: NOW - 1 }, notes: { followUpDate: '2026-10-02' }, todayYmd: '2026-10-01', nowMs: NOW }) === null);

  console.log('\n10. Urgent calls tell Jo NOW — one internal push per call (2026-10-03)');
  const URGENT = () => Object.assign(BUSINESS(), { urgent: true, summary: 'Water coming through the ceiling right now.' });
  const pushes = [];
  const stubPush = (notesFn, pushFn) => {
    calls = { transcribe: 0, notes: 0, prompts: [] };
    setDeps({ transcribe: async () => ({ text: 'leak', durationSec: 30 }), notes: async () => notesFn(), push: pushFn || (async (...a) => { pushes.push(a); return { sent: 1 }; }) });
  };
  const DAYTIME = Date.parse('2026-10-01T16:00:00Z'); // 12 PM ET
  const prevGate = process.env.CALL_WATCH_ENABLED;
  process.env.CALL_WATCH_ENABLED = 'true';
  stubPush(URGENT);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_ug'] }, [COLLECTION + '/cube_ug']: call('cube_ug', { leadId: 'LU', contactName: 'Maria Example' }), 'leads/LU': { firstName: 'Maria', userId: OWNER } });
  r = await runTranscribe({ db, bucket, live: false, nowMs: DAYTIME });
  ok('an urgent call pushes to Jo (the owner) at once', pushes.length === 1 && pushes[0][0] === OWNER && /Urgent call — Maria Example/.test(pushes[0][1]) && /ceiling/.test(pushes[0][2]) && r.urgentPushed === 1, JSON.stringify(pushes));
  ok('the push opens that call\'s card in the Call Center', pushes[0][3].clickUrl === '/pro/dashboard.html?call=cube_ug#/calls' && pushes[0][3].type === 'call_watch' && pushes[0][3].notificationId === 'call-urgent-cube_ug');
  ok('stamped on the call (so callWatch won\'t repeat it) + a bell entry', db.docs.get(COLLECTION + '/cube_ug').urgentPushedAtMs === DAYTIME
    && [...db.docs.entries()].some(([k, v]) => k.startsWith('notifications/') && v.type === 'call_watch' && v.userId === OWNER && v.clickUrl === '/pro/dashboard.html?call=cube_ug#/calls'));
  db.docs.set(COLLECTION + '/cube_ug', Object.assign({}, db.docs.get(COLLECTION + '/cube_ug'), { status: 'stored' }));
  await db.doc(CONFIG).set({ transcribeOnly: ['cube_ug'] }, { merge: true });
  await runTranscribe({ db, bucket, live: false, nowMs: DAYTIME + 60e3 });
  ok('re-transcribing the same call never pushes twice', pushes.length === 1);
  stubPush(BUSINESS);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_nu'] }, [COLLECTION + '/cube_nu']: call('cube_nu', { leadId: 'LU' }), 'leads/LU': { firstName: 'Maria', userId: OWNER } });
  await runTranscribe({ db, bucket, live: false, nowMs: DAYTIME });
  ok('a call that is not urgent → no push', pushes.length === 1);
  stubPush(URGENT);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_nt'] }, [COLLECTION + '/cube_nt']: call('cube_nt', { leadId: null }) });
  await runTranscribe({ db, bucket, live: false, nowMs: Date.parse('2026-10-02T07:00:00Z') }); // 3 AM ET
  ok('at night → no push and no stamp (the 8 AM callWatch tells Jo instead)', pushes.length === 1 && !db.docs.get(COLLECTION + '/cube_nt').urgentPushedAtMs);
  stubPush(URGENT, async () => { throw new Error('fcm down'); });
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_pf'] }, [COLLECTION + '/cube_pf']: call('cube_pf', { leadId: null }) });
  await runTranscribe({ db, bucket, live: false, nowMs: DAYTIME });
  ok('a failed push is not stamped (callWatch picks it up) and the call is still noted', !db.docs.get(COLLECTION + '/cube_pf').urgentPushedAtMs && db.docs.get(COLLECTION + '/cube_pf').status === 'noted');
  process.env.CALL_WATCH_ENABLED = 'false';
  stubPush(URGENT);
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_go'] }, [COLLECTION + '/cube_go']: call('cube_go', { leadId: null }) });
  await runTranscribe({ db, bucket, live: false, nowMs: DAYTIME });
  ok('gated with callWatch: CALL_WATCH_ENABLED off → no push', pushes.length === 1);
  if (prevGate === undefined) delete process.env.CALL_WATCH_ENABLED; else process.env.CALL_WATCH_ENABLED = prevGate;
  const ccSrc = require('fs').readFileSync(path.join(__dirname, '..', 'functions', 'call-center.js'), 'utf8');
  const pushFn = ccSrc.slice(ccSrc.indexOf('async function pushUrgent'), ccSrc.indexOf('/** One transcription pass'));
  ok('the urgent push is internal only: no SMS, no email, no customer address', pushFn.length > 200 && !/sendSms|twilio|resend|email|messages\.create|lead\.phone/i.test(pushFn) && /d\.push\(OWNER,/.test(pushFn));

  console.log('\n11. "Looks like X" is stored when the notes are written (2026-10-03)');
  stub(() => ({ call_type: 'customer', summary: 'Dana Rivers asked when the crew starts.', promises: [{ who: 'jo', text: 'Call Dana back', due: null }], follow_up_date: null, urgent: false }));
  const leadsSeed = {
    'leads/L9': { firstName: 'Dana', lastName: 'Rivers', address: '412 Oak Hill Dr, Mason OH', userId: OWNER, companyId: OWNER },
    'leads/L10': { firstName: 'Sam', lastName: 'Ortiz', address: '9 Elm St', userId: OWNER, companyId: OWNER },
  };
  db = fakeDb(Object.assign({
    [COLLECTION + '/cube_s1']: call('cube_s1', { leadId: null, contactName: '', startedAtMs: NOW - 10e3 }),
    // Noted before suggestions existed: the run backfills these.
    [COLLECTION + '/cube_old1']: call('cube_old1', { leadId: null, status: 'noted', contactName: 'Sam Ortiz Roof', summary: 'x', startedAtMs: NOW - 5 * 86400e3 }),
    [COLLECTION + '/cube_old2']: call('cube_old2', { leadId: null, status: 'noted', contactName: 'Nobody Known', summary: 'x', startedAtMs: NOW - 6 * 86400e3 }),
    [COLLECTION + '/cube_old3']: call('cube_old3', { leadId: null, status: 'noted', contactName: 'Sam Ortiz', summary: 'x', suggestCheckedAtMs: 1, suggestedLeadId: null, suggestRulesV: L.SUGGEST_RULES_VERSION }),
    // Checked under the first rules (no Thumbtack rules yet): re-checked now.
    [COLLECTION + '/cube_old4']: call('cube_old4', { leadId: null, status: 'noted', contactName: 'Jamie K', summary: 'Found us on Thumbtack, wants gutters.', suggestCheckedAtMs: 1, suggestedLeadId: null }),
    'leads/LT1': { firstName: 'Jamie', lastName: 'Kowalski', address: 'Mason, OH 45040', source: 'Thumbtack', phone: '(555) 010-0001', userId: OWNER, companyId: OWNER },
  }, leadsSeed));
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  const s1 = db.docs.get(COLLECTION + '/cube_s1');
  ok('a newly noted call on no customer stores its one likely customer', s1.suggestedLeadId === 'L9' && s1.suggestedLeadName === 'Dana Rivers' && /name said on the call/.test(s1.suggestedWhy) && s1.suggestCheckedAtMs === NOW, JSON.stringify(s1));
  ok('…as a suggestion only: never filed on it', s1.leadId === null && !db.docs.has('leads/L9/activity/cube-cube_s1') && !db.docs.has('leads/L9/tasks/cube-cube_s1'));
  ok('older noted calls get theirs on the next run (backfill)', db.docs.get(COLLECTION + '/cube_old1').suggestedLeadId === 'L10' && db.docs.get(COLLECTION + '/cube_old1').suggestCheckedAtMs === NOW);
  ok('no match → checked, nothing suggested', db.docs.get(COLLECTION + '/cube_old2').suggestedLeadId === null && db.docs.get(COLLECTION + '/cube_old2').suggestCheckedAtMs === NOW);
  ok('a call checked under the current rules is not re-read', db.docs.get(COLLECTION + '/cube_old3').suggestCheckedAtMs === 1 && r.suggested === 3, JSON.stringify(r));
  const o4 = db.docs.get(COLLECTION + '/cube_old4');
  ok('a call checked under OLDER rules is re-checked: Thumbtack lead suggested by name', o4.suggestedLeadId === 'LT1' && /Thumbtack/.test(o4.suggestedWhy) && o4.suggestRulesV === L.SUGGEST_RULES_VERSION && o4.leadId === null, JSON.stringify(o4));
  // A call ON a customer gets no suggestion fields at all.
  db = fakeDb(Object.assign({ [CONFIG]: { transcribeOnly: ['cube_m'] }, [COLLECTION + '/cube_m']: call('cube_m', { leadId: 'L9' }) }, leadsSeed));
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('a call already on a customer gets no suggestion', db.docs.get(COLLECTION + '/cube_m').suggestedLeadId === undefined);

  console.log('\n12. Caller facts: name / street / town / service (2026-10-03)');
  ok('the notes prompt asks for the four optional facts, null unless said', /"caller_name"/.test(L.NOTES_SYSTEM) && /"street"/.test(L.NOTES_SYSTEM) && /"town"/.test(L.NOTES_SYSTEM) && /"service"/.test(L.NOTES_SYSTEM) && /never guess/i.test(L.NOTES_SYSTEM));
  let cf = L.sanitizeNotes(Object.assign(BUSINESS(), { caller_name: '  Dana   Rivers ', street: '412 Oak Hill Dr.', town: 'Florence', service: 'Gutters' })).callerFacts;
  ok('clean facts kept (trimmed, service lower-cased)', cf.name === 'Dana Rivers' && cf.street === '412 Oak Hill Dr' && cf.town === 'Florence' && cf.service === 'gutters', JSON.stringify(cf));
  const old = L.sanitizeNotes(BUSINESS());
  ok('a reply WITHOUT the new fields (prompt drift) → every old field intact, facts all null',
    old.callType === 'customer' && old.promises.length === 2 && old.followUpDate === '2026-10-02' && old.callerFacts.name === null && old.callerFacts.street === null && old.callerFacts.town === null && old.callerFacts.service === null);
  cf = L.sanitizeNotes(Object.assign(BUSINESS(), { caller_name: 'x'.repeat(61), street: { a: 1 }, town: 'Florence 41042', service: 'plumbing' })).callerFacts;
  ok('over-long, non-string, digit-town and unknown-service values → null', cf.name === null && cf.street === null && cf.town === null && cf.service === null, JSON.stringify(cf));
  cf = L.sanitizeNotes(Object.assign(BUSINESS(), { caller_name: 'unknown', street: 'N/A', town: 'null', service: null })).callerFacts;
  ok('"unknown" / "N/A" / "null" placeholders → null, not a name', cf.name === null && cf.street === null && cf.town === null);
  cf = L.sanitizeNotes(Object.assign(BUSINESS(), { caller_name: '<img src=x onerror=alert(1)>Dana "Rivers"', town: '41042' })).callerFacts;
  ok('markup and quotes are stripped; a ZIP is a valid town', cf.name === 'Dana Rivers' && cf.town === '41042', JSON.stringify(cf));
  cf = L.sanitizeNotes({ call_type: 'personal', summary: 'mom', caller_name: 'Mom Example', town: 'Florence' }).callerFacts;
  ok('a personal call keeps no facts', cf.name === null && cf.town === null);
  ok('the facts are a separate key: the text inbox (which picks fields) is unaffected', !('caller_name' in old) && typeof old.callerFacts === 'object');

  // A new call: facts stored with it, and they drive the suggestion.
  stub(() => Object.assign(BUSINESS(), { summary: 'Wants the gutters cleaned.', caller_name: 'Jamie Kowalski', town: 'Florence', service: 'gutters' }));
  const factLeads = {
    'leads/LF1': { firstName: 'Jamie', lastName: 'Kowalski', address: '412 Oak Hill Dr, Florence, KY 41042', source: 'Thumbtack', userId: OWNER, companyId: OWNER },
    'leads/LF2': { firstName: 'Jamie', lastName: 'Kowalski', address: '88 Elm St, Mason, OH 45040', userId: OWNER, companyId: OWNER },
  };
  db = fakeDb(Object.assign({ [CONFIG]: { transcribeOnly: ['cube_fx'] }, [COLLECTION + '/cube_fx']: call('cube_fx', { leadId: null, contactName: '' }) }, factLeads));
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  const fxd = db.docs.get(COLLECTION + '/cube_fx');
  ok('a new call stores its caller facts + factsV', fxd.callerFacts && fxd.callerFacts.name === 'Jamie Kowalski' && fxd.callerFacts.town === 'Florence' && fxd.factsV === L.FACTS_VERSION, JSON.stringify(fxd.callerFacts));
  ok('…and "Looks like" names the lead in that town, why "name + Florence" — never filed', fxd.suggestedLeadId === 'LF1' && fxd.suggestedWhy === 'name + Florence' && fxd.leadId === null && !db.docs.has('leads/LF1/activity/cube-cube_fx'), JSON.stringify(fxd));

  console.log('\n13. Older calls: bounded facts re-read from the STORED transcript');
  const { FACTS_PER_RUN, FACTS_DAY_CAP } = M._test;
  ok('the bounds are small: ≤ 25 a run, ≤ 200 a day', FACTS_PER_RUN > 0 && FACTS_PER_RUN <= 25 && FACTS_DAY_CAP >= FACTS_PER_RUN && FACTS_DAY_CAP <= 200);
  const factsStub = (fn) => {
    calls = { transcribe: 0, notes: 0, prompts: [], systems: [] };
    setDeps({
      transcribe: async () => { calls.transcribe++; return { text: 'x', durationSec: 1 }; },
      notes: async ({ system, prompt }) => { calls.notes++; calls.prompts.push(prompt); calls.systems.push(system); return fn(prompt); },
    });
  };
  const oldNoted = (i, extra) => call('cube_on' + i, Object.assign({ leadId: null, status: 'noted', summary: 'Wants a roof quote.', transcript: 'TRANSCRIPT-' + i + ' this is Jamie Kowalski up in Florence', startedAtMs: NOW - (i + 1) * 3600e3, suggestRulesV: 2 }, extra));
  const seedOld = (n, cfgExtra, extra) => {
    const s = Object.assign({ [CONFIG]: Object.assign({}, cfgExtra) }, factLeads);
    for (let i = 0; i < n; i++) s[COLLECTION + '/cube_on' + i] = oldNoted(i, extra);
    return fakeDb(s);
  };
  factsStub(() => ({ caller_name: 'Jamie Kowalski', street: null, town: 'Florence', service: 'roof' }));
  db = seedOld(FACTS_PER_RUN + 5);
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('one run re-reads at most FACTS_PER_RUN calls', calls.notes === FACTS_PER_RUN && r.factsReextracted === FACTS_PER_RUN, JSON.stringify(r));
  ok('…from the stored transcript with the facts-only prompt — no audio re-transcribed', calls.transcribe === 0 && /TRANSCRIPT-0/.test(calls.prompts[0]) && calls.systems[0] === L.FACTS_SYSTEM);
  const on0 = db.docs.get(COLLECTION + '/cube_on0');
  ok('…newest first; each is marked (factsV) and re-scored at once', on0.factsV === L.FACTS_VERSION && on0.callerFacts.town === 'Florence' && on0.suggestedLeadId === 'LF1' && on0.suggestedWhy === 'name + Florence' && on0.suggestRulesV === L.SUGGEST_RULES_VERSION);
  ok('…the summary / promises are left alone', on0.summary === 'Wants a roof quote.');
  ok('…the day count is kept on the config', db.docs.get(CONFIG).factsDay === '2026-10-01' && db.docs.get(CONFIG).factsUsed === FACTS_PER_RUN);
  const leftOver = db.docs.get(COLLECTION + '/cube_on' + (FACTS_PER_RUN + 4));
  ok('…the rest wait (still re-scored by the ordinary backfill, no facts yet)', !leftOver.factsV && leftOver.suggestRulesV === L.SUGGEST_RULES_VERSION);
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 1800e3 });
  ok('the next run picks up only the rest — a marked call is never re-read', calls.notes === FACTS_PER_RUN + 5 && db.docs.get(CONFIG).factsUsed === FACTS_PER_RUN + 5);
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 3600e3 });
  ok('…and then nothing more (idempotent)', calls.notes === FACTS_PER_RUN + 5);
  factsStub(() => ({ caller_name: 'Jamie Kowalski', town: 'Florence' }));
  db = seedOld(10, { factsDay: '2026-10-01', factsUsed: FACTS_DAY_CAP - 3 });
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('the daily cap holds: 3 left today → 3 model calls', calls.notes === 3 && db.docs.get(CONFIG).factsUsed === FACTS_DAY_CAP);
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 1800e3 });
  ok('…a spent day makes none', calls.notes === 3);
  await runTranscribe({ db, bucket, live: true, nowMs: Date.parse('2026-10-02T16:00:00Z') });
  ok('…a new day starts a fresh count', calls.notes === 3 + 7 && db.docs.get(CONFIG).factsDay === '2026-10-02' && db.docs.get(CONFIG).factsUsed === 7);
  factsStub(() => { throw new Error('anthropic 529: overloaded'); });
  db = seedOld(5);
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('a model failure stops the re-read for this run (one attempt counted)', calls.notes === 1 && r.factsFailed === 1 && db.docs.get(COLLECTION + '/cube_on0').factsAttempts === 1 && !db.docs.get(COLLECTION + '/cube_on0').factsV);
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 1800e3 });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 3600e3 });
  ok('a call that fails twice is left alone after that', db.docs.get(COLLECTION + '/cube_on0').factsAttempts === 2 && db.docs.get(COLLECTION + '/cube_on1').factsAttempts === 1, JSON.stringify([db.docs.get(COLLECTION + '/cube_on0').factsAttempts, db.docs.get(COLLECTION + '/cube_on1').factsAttempts]));
  factsStub(() => ({ caller_name: 'Jamie Kowalski', town: 'Florence' }));
  db = seedOld(3, {}, { transcript: null });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('a call with no stored transcript is marked done without a model call', calls.notes === 0 && db.docs.get(COLLECTION + '/cube_on0').factsV === L.FACTS_VERSION);
  db = seedOld(3);
  await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('gate off (not live) → no re-read at all', calls.notes === 0 && !db.docs.get(COLLECTION + '/cube_on0').factsV);
  db = seedOld(3, { paused: true });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('paused → no re-read', calls.notes === 0);

  // ── Reading the recording never leaves a stream open (2026-10-04) ──
  // file.download() fans 11 'error'/'close' listeners onto one internal
  // PassThrough per file (MaxListenersExceededWarning, ~500/week). The run now
  // reads through the storage client's buffered request, or reads the stream
  // itself and destroys it. download() must not be reached in either case.
  console.log('\n13. Recording reads: no download(), the per-file stream is always ended');
  const { Readable } = require('stream');
  const { readStoredAudio } = M._test;
  function streamBucket(opts) {
    const made = [];
    return {
      made,
      name: 'b',
      file: (p) => ({
        createReadStream: () => {
          let sent = 0;
          const s = new Readable({ read() {
            if (opts && opts.failAfter != null && sent === opts.failAfter) { this.destroy(new Error('socket hang up')); return; }
            if (sent < 3) { sent++; this.push(Buffer.from('ab')); } else this.push(null);
          } });
          made.push(s);
          return s;
        },
        download: async () => { throw new Error('download() used — its stream fan-out is the leak'); },
        delete: async () => { deleted.push(p); },
      }),
    };
  }
  stub(BUSINESS);
  let sb = streamBucket();
  db = fakeDb({ [CONFIG]: { transcribeOnly: ['cube_r1', 'cube_r2'] }, [COLLECTION + '/cube_r1']: call('cube_r1', { leadId: 'L1' }), [COLLECTION + '/cube_r2']: call('cube_r2', { leadId: 'L1' }), 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER } });
  r = await runTranscribe({ db, bucket: sb, live: false, nowMs: NOW });
  ok('both calls transcribed from the stream (download() never called)', r.noted === 2 && r.failed === 0 && calls.transcribe === 2, JSON.stringify(r));
  ok('one stream per file, each ended AND destroyed after the read', sb.made.length === 2 && sb.made.every((s) => s.destroyed && s.readableEnded), sb.made.map((s) => s.destroyed + '/' + s.readableEnded).join());
  sb = streamBucket({ failAfter: 1 });
  let threw = null;
  try { await readStoredAudio(sb, 'calls/x.m4a'); } catch (e) { threw = e; }
  ok('a read that dies half way rejects AND its stream is destroyed', threw && /hang up/.test(threw.message) && sb.made.length === 1 && sb.made[0].destroyed);
  const reqs = [];
  const prodBucket = {
    name: 'nobigdeal-pro.appspot.com',
    file: () => ({
      storage: { apiEndpoint: 'https://storage.googleapis.com', customEndpoint: false, authClient: { request: async (o) => { reqs.push(o); return { data: new Uint8Array([1, 2, 3]).buffer }; } } },
      createReadStream: () => { throw new Error('streamed in prod'); },
      download: async () => { throw new Error('download() used in prod'); },
    }),
  };
  const got = await readStoredAudio(prodBucket, 'calls/' + OWNER + '/cube-acr/2026-09-30/a b.m4a');
  ok('prod: ONE buffered GET of the media URL through the storage auth client, no stream', reqs.length === 1 && reqs[0].responseType === 'arraybuffer'
    && reqs[0].url === 'https://storage.googleapis.com/storage/v1/b/nobigdeal-pro.appspot.com/o/' + encodeURIComponent('calls/' + OWNER + '/cube-acr/2026-09-30/a b.m4a') + '?alt=media'
    && Buffer.isBuffer(got) && got.length === 3, JSON.stringify(reqs));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
