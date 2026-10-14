/**
 * tests/call-center-provider-outage-2026-10-13.test.js — an AI provider outage
 * (Anthropic "credit balance is too low", a revoked key, 5xx) is never a
 * strike against a call.
 *
 * Found 2026-10-13: 14 phone_calls dropped for good (transcribeAttempts 3)
 * because the Anthropic account ran out of credit; topping up would not have
 * brought them back. Replays the pipeline with the transcriber and the model
 * stubbed and an in-memory Firestore:
 *
 *   1. classifier: credit / auth / rate limit / overloaded are outages; a
 *      call's own failure is not (positive AND negative controls)
 *   2. credit outage run  -> 0 strikes, transcript kept, ONE bell + ONE push
 *   3. same-day rerun     -> still no strike, no second alert, no second Groq
 *   4. recovery run       -> the same calls noted, outage cleared, Groq paid once
 *   5. mixed (bad call + outage) -> only the bad call gets a strike
 *   6. the 14 already-stuck calls (attempts 3 + credit error) are picked again
 *   7. facts re-read: an outage is not a factsAttempts strike
 *   8. health rows + dead-man carry it; the reopen script is dry-run / counts
 *
 * Run: node tests/call-center-provider-outage-2026-10-13.test.js
 */
'use strict';

const path = require('path');
const cp = require('child_process');
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const H = require(path.join(__dirname, '..', 'functions', 'pipeline-health.js'))._internal;
const DM = require(path.join(__dirname, '..', 'functions', 'pipeline-deadman.js'));
const R = require(path.join(__dirname, '..', 'scripts', 'reopen-provider-outage-calls.js'));
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
    async update(v) { docs.set(p, Object.assign({}, docs.get(p) || {}, v)); },
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
    docs, doc: mk,
    collection: (name) => Object.assign(query(name, [], null), { doc: (id) => mk(name + '/' + id), add: async (v) => { const id = 'auto' + docs.size; docs.set(name + '/' + id, v); return { id }; } }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    batch: () => { const ops = []; return { update: (ref, v) => ops.push([ref, v]), commit: async () => { for (const [r, v] of ops) await r.update(v); } }; },
  };
}
// The bytes ARE the path, so a stub can record WHICH call's audio was sent.
const bucket = { file: (p) => ({ download: async () => [Buffer.from(String(p))], delete: async () => {} }) };
const NOW = Date.parse('2026-10-01T16:00:00Z'); // noon ET: inside watch hours
const call = (id, extra) => Object.assign({ userId: OWNER, companyId: OWNER, status: 'stored', storagePath: 'calls/' + OWNER + '/cube-acr/2026-09-30/' + id + '.m4a', sizeBytes: 400000, startedAtMs: NOW - 3600e3, direction: 'inbound', contactName: 'Pat Example' }, extra);
const CREDIT = 'anthropic 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const creditErr = () => { const e = new Error(CREDIT); e.status = 400; e.provider = 'anthropic'; return e; };
const GOOD = () => ({ call_type: 'customer', summary: 'Gutter leaking; Jo will come Thursday.', promises: [], follow_up_date: null, urgent: false });

let counts, pushes;
function stub(notesFn) {
  counts = { transcribe: 0, notes: 0, audio: [] }; pushes = [];
  setDeps({
    transcribe: async (buf) => { counts.transcribe++; counts.audio.push(String(buf)); return { text: 'Hi Jo, the gutter is leaking again. Come Thursday please.', durationSec: 95 }; },
    notes: async (a) => { counts.notes++; return notesFn(a); },
    push: async (uid, title, body, data) => { pushes.push({ uid, title, body, data }); return { sent: 1 }; },
  });
}
const bells = (db) => [...db.docs.entries()].filter(([k, v]) => k.startsWith('notifications/') && v.type === 'ai_outage');
const cc = (db) => db.docs.get(CONFIG) || {};
const doc = (db, id) => db.docs.get(COLLECTION + '/' + id);

(async () => {
  console.log('\n1. Classifier');
  const C = L.classifyProviderError;
  ok('credit 400 string → anthropic credit, needs action', (() => { const c = C(CREDIT); return c && c.provider === 'anthropic' && c.kind === 'credit' && c.needsAction === true; })());
  ok('credit Error object (status 400)', C(creditErr()).kind === 'credit');
  ok('402 is credit', C('anthropic 402: payment required').kind === 'credit');
  const K = (x) => (C(x) || {}).kind; // a miss fails by assertion, not a TypeError
  const P = (x) => (C(x) || {}).provider;
  const RS = (x) => (C(x) || {}).reason || '';
  ok('401 / 403 / invalid key are auth', K('anthropic 401: invalid x-api-key') === 'auth' && K('anthropic 403: forbidden') === 'auth' && K('Groq rejected: Invalid API Key') === 'auth');
  ok('auth: provider + reason name who and the key', P('anthropic 401: invalid x-api-key') === 'anthropic' && /Anthropic/.test(RS('anthropic 401: invalid x-api-key')) && /API key/.test(RS('anthropic 401: invalid x-api-key')) && P('Groq rejected: Invalid API Key') === 'groq' && /Groq/.test(RS('Groq rejected: Invalid API Key')) && (C('anthropic 401: x') || {}).needsAction === true);
  ok('key not configured is auth', K(new Error('anthropic-not-configured')) === 'auth' && P(new Error('GROQ_API_KEY secret is unset. groq-not-configured')) === 'groq');
  ok('429 and Groq rate limit are rate_limit, no action needed', K('anthropic 429: rate_limit_error') === 'rate_limit' && K('Groq rejected: Rate limit reached for model x') === 'rate_limit' && (C('Groq rejected: Rate limit reached for model x') || {}).needsAction === false && P('Groq rejected: Rate limit reached for model x') === 'groq');
  ok('529 overloaded / 503 are overloaded, no action needed, reason says so', K('anthropic 529: Overloaded') === 'overloaded' && K('anthropic 503: unavailable') === 'overloaded' && (C('anthropic 529: Overloaded') || {}).needsAction === false && /overloaded or down/.test(RS('anthropic 529: Overloaded')));
  ok('credit reason names the fix', /out of credit/.test(RS(CREDIT)) && /console\.anthropic\.com/.test(RS(CREDIT)));
  ok('NEG: the call\'s own failures are not outages',
    C('notes: no JSON') === null && C('anthropic 400: messages: text content blocks must be non-empty') === null
      && C('The operation was aborted due to timeout') === null && C('Groq rejected: could not process file') === null && C(null) === null && C('') === null);
  ok('isProviderOutage mirrors it', L.isProviderOutage(CREDIT) === true && L.isProviderOutage('notes: no JSON') === false);
  ok('isRateLimited unchanged (existing contract)', L.isRateLimited('Groq rejected: Rate limit') && !L.isRateLimited(CREDIT));

  console.log('\n2. Picking: attempts no longer decide when the error is an outage');
  const mk = (id, extra) => Object.assign({ id }, call(id, extra));
  const picked = L.pickToTranscribe([
    mk('stuck', { transcribeAttempts: 3, transcribeError: CREDIT }),
    mk('own-fault', { transcribeAttempts: 3, transcribeError: 'notes: no JSON' }),
    mk('fresh', {}),
  ], { live: true, allowIds: [], maxCount: 10, secLeft: 1e6 }).map((c) => c.id).sort();
  ok('3 strikes + credit error is picked again; 3 strikes + own fault is not', picked.join() === 'fresh,stuck', picked.join());
  const budget = L.pickToTranscribe([mk('saved', { transcriptSaved: true, transcript: 'hello there', sizeBytes: 4e6 })], { live: true, allowIds: [], maxCount: 5, secLeft: 5 });
  ok('a saved-transcript call costs no audio budget', budget.length === 1);

  console.log('\n3. Credit outage run: 0 strikes, transcript kept, ONE alert');
  let db = fakeDb({
    [CONFIG]: {},
    [COLLECTION + '/c1']: call('c1', { startedAtMs: NOW - 1000 }),
    [COLLECTION + '/c2']: call('c2', { startedAtMs: NOW - 2000 }),
    [COLLECTION + '/c3']: call('c3', { startedAtMs: NOW - 3000 }),
  });
  stub(() => { throw creditErr(); });
  let r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('run is marked provider_outage with the reason', r.state === 'provider_outage' && r.providerOutage && r.providerOutage.kind === 'credit' && /credit/i.test(r.providerOutage.reason), JSON.stringify(r));
  ok('no strike on any call', ['c1', 'c2', 'c3'].every((id) => !(Number(doc(db, id).transcribeAttempts) > 0)), JSON.stringify(['c1', 'c2', 'c3'].map((id) => doc(db, id).transcribeAttempts)));
  ok('no failed count; the run stopped after the first call (no wasted Groq)', r.failed === 0 && counts.transcribe === 1 && counts.notes === 1, JSON.stringify(counts));
  ok('transcript kept on the call, status still stored (still listed + eligible)', doc(db, 'c1').transcriptSaved === true && /gutter/.test(doc(db, 'c1').transcript) && doc(db, 'c1').status === 'stored');
  ok('exactly one bell, in plain words', bells(db).length === 1 && /top up at console\.anthropic\.com/.test(bells(db)[0][1].message) && /still recorded and listed/.test(bells(db)[0][1].message));
  ok('exactly one push to Jo, no one else', pushes.length === 1 && pushes[0].uid === OWNER && /AI call notes are paused/.test(pushes[0].title));
  ok('outage recorded on integrations/callCenter', cc(db).providerOutage && cc(db).providerOutage.kind === 'credit' && cc(db).providerOutage.needsAction === true && cc(db).providerOutage.alertedYmd);

  console.log('\n4. Same-day rerun: still no strike, no second alert, no second Groq');
  const before = counts.transcribe;
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 30 * 60000 });
  ok('still 0 strikes', ['c1', 'c2', 'c3'].every((id) => !(Number(doc(db, id).transcribeAttempts) > 0)));
  ok('still one bell, one push (daily dedupe)', bells(db).length === 1 && pushes.length === 1, bells(db).length + '/' + pushes.length);
  ok('the saved transcript was reused: Groq NOT paid again for c1', counts.transcribe === before, counts.transcribe + ' vs ' + before);
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 24 * 3600e3 });
  ok('next day: a fresh daily bell + push (it is still broken)', bells(db).length === 2 && pushes.length === 2);

  console.log('\n5. Recovery run: the same calls are noted, outage clears');
  stub(() => GOOD());
  const priorTranscribes = counts.transcribe;
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW + 25 * 3600e3 });
  ok('all three calls noted', ['c1', 'c2', 'c3'].every((id) => doc(db, id).status === 'noted'), JSON.stringify(['c1', 'c2', 'c3'].map((id) => doc(db, id).status)));
  ok('c1 reused its saved transcript: its audio never went to the transcriber again', counts.audio.length > 0 && !counts.audio.some((a) => /\/c1\.m4a$/.test(a)) && counts.audio.some((a) => /\/c2\.m4a$/.test(a)) && doc(db, 'c1').transcript && /gutter/.test(doc(db, 'c1').transcript), JSON.stringify(counts.audio));
  ok('outage flag cleared on the status doc', cc(db).providerOutage === null && r.outageCleared === true);
  ok('stale transcribeError cleared on noted calls', doc(db, 'c1').transcribeError === null && doc(db, 'c1').transcriptSaved === false);
  ok('recovery sent no new alert (stub() reset the push log)', bells(db).length === 2 && pushes.length === 0);
  void priorTranscribes;

  console.log('\n6. Mixed: one bad call + an outage -> only the bad call gets a strike');
  db = fakeDb({
    [CONFIG]: {},
    [COLLECTION + '/bad']: call('bad', { startedAtMs: NOW - 1000 }),
    [COLLECTION + '/good']: call('good', { startedAtMs: NOW - 2000 }),
    [COLLECTION + '/later']: call('later', { startedAtMs: NOW - 3000 }),
  });
  stub(({ prompt }) => { if (/Pat Example/.test(prompt) && counts.notes === 1) throw new Error('notes: no JSON'); throw creditErr(); });
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('the bad call got exactly one strike', Number(doc(db, 'bad').transcribeAttempts) === 1 && doc(db, 'bad').transcribeError === 'notes: no JSON', JSON.stringify(doc(db, 'bad')));
  ok('the call that hit the outage got none; the one behind it was not touched', !(Number(doc(db, 'good').transcribeAttempts) > 0) && !(Number(doc(db, 'later').transcribeAttempts) > 0));
  ok('failed counts only the bad call; run still reports the outage', r.failed === 1 && r.providerOutage && r.providerOutage.kind === 'credit', JSON.stringify(r));
  ok('the bad call kept its transcript too (a retry will not re-pay Groq)', doc(db, 'bad').transcriptSaved === true);

  console.log('\n7. The 14 already-stuck calls (attempts 3 + credit error)');
  db = fakeDb({
    [CONFIG]: {},
    [COLLECTION + '/s1']: call('s1', { transcribeAttempts: 3, transcribeError: CREDIT }),
    [COLLECTION + '/s2']: call('s2', { transcribeAttempts: 3, transcribeError: 'notes: no JSON', startedAtMs: NOW - 5000 }),
  });
  stub(() => GOOD());
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('after the fix + a top-up the stuck call is noted without any script', doc(db, 's1').status === 'noted');
  ok('NEG: a call that failed for its own reason stays dropped', doc(db, 's2').status === 'stored' && Number(doc(db, 's2').transcribeAttempts) === 3);

  console.log('\n7b. One poisoned file can not hold the line forever (5xx)');
  db = fakeDb({ [CONFIG]: {}, [COLLECTION + '/p1']: call('p1', { startedAtMs: NOW - 1000 }) });
  stub(() => { const e = new Error('anthropic 500: internal'); e.status = 500; e.provider = 'anthropic'; throw e; });
  for (let i = 0; i < 5; i++) await runTranscribe({ db, bucket, live: true, nowMs: NOW + i * 1800e3 });
  ok('five 5xx in a row: still no strike, counted separately', !(Number(doc(db, 'p1').transcribeAttempts) > 0) && doc(db, 'p1').transientFails === 5, JSON.stringify(doc(db, 'p1')));
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 6 * 1800e3 });
  ok('the sixth makes it the call\'s fault: one strike, line moves on', Number(doc(db, 'p1').transcribeAttempts) === 1);
  db = fakeDb({ [CONFIG]: {}, [COLLECTION + '/q1']: call('q1', { startedAtMs: NOW - 1000, transientFails: 5 }) });
  stub(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('NEG: credit outages never use the 5xx budget', !(Number(doc(db, 'q1').transcribeAttempts) > 0));

  console.log('\n7c. Review fixes');
  ok('stored Groq status string classifies', C('Groq rejected: HTTP 503').kind === 'overloaded' && C('Groq rejected: HTTP 401').kind === 'auth');
  db = fakeDb({ [CONFIG]: {}, [COLLECTION + '/st']: call('st', {}) });
  stub(() => GOOD());
  const badBucket = { file: () => ({ download: async () => { const e = new Error('Storage forbidden'); e.status = 403; throw e; }, delete: async () => {} }) };
  r = await runTranscribe({ db, bucket: badBucket, live: true, nowMs: NOW });
  ok('a Storage 403 is the call\'s failure: strike, no outage, no "top up Anthropic" bell', Number(doc(db, 'st').transcribeAttempts) === 1 && !r.providerOutage && bells(db).length === 0, JSON.stringify(r));
  db = fakeDb({ [CONFIG]: {}, [COLLECTION + '/k1']: call('k1', {}) });
  stub(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  stub(() => { const e = new Error('anthropic 401: invalid x-api-key'); e.status = 401; e.provider = 'anthropic'; throw e; });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 1800e3 });
  ok('credit -> key flip the same day: still ONE bell, no second push, bell not re-armed', bells(db).length === 1 && pushes.length === 0 && cc(db).providerOutage.kind === 'auth');

  console.log('\n8. Facts re-read: an outage is not a strike');
  db = fakeDb({
    [CONFIG]: {},
    [COLLECTION + '/n1']: call('n1', { status: 'noted', leadId: null, transcript: 'Hi Jo this is Dana on Oak Hill Dr', factsV: 0 }),
  });
  stub(() => { throw creditErr(); });
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('no factsAttempts, no factsError on the call', !(Number(doc(db, 'n1').factsAttempts) > 0) && !doc(db, 'n1').factsError, JSON.stringify(doc(db, 'n1')));
  ok('the outage is still reported + alerted', r.state === 'provider_outage' && bells(db).length === 1);
  ok('the failed attempt did not burn the day\'s model-call budget', cc(db).factsUsed === 0, String(cc(db).factsUsed));
  stub(() => { const e = new Error('notes: no JSON'); return Promise.reject(e); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 1000 });
  ok('POSITIVE CONTROL: a real facts failure still counts a strike', Number(doc(db, 'n1').factsAttempts) === 1);

  console.log('\n9. Health surfaces');
  const gates = { ingest: true, transcribe: true, watch: true };
  const rows = H.healthRows({ now: NOW, gates, cc: { lastTranscribeAtMs: NOW - 60000, providerOutage: { kind: 'credit', provider: 'anthropic', needsAction: true, reason: 'Anthropic account is out of credit', sinceMs: NOW - 3600e3 } } });
  const row = rows.rows.find((x) => x.key === 'ai_notes');
  ok('Call Center health strip has an AI-notes row, bad, naming the reason', row && row.status === 'bad' && /out of credit/.test(row.detail) && rows.overall === 'bad');
  ok('NEG: no outage -> no AI-notes row', !H.healthRows({ now: NOW, gates, cc: { lastTranscribeAtMs: NOW - 60000 } }).rows.some((x) => x.key === 'ai_notes'));
  const probs = DM.deadManProblems({ watch: { lastCheckAtMs: NOW }, cc: { lastTranscribeAtMs: NOW, lastRunAtMs: NOW, providerOutage: { kind: 'auth', needsAction: true, reason: 'Anthropic rejected the API key' } }, now: NOW, gates, newestCallMs: NOW });
  ok('dead-man records it on pipelineHealth, quietly (no second push)', probs.some((p) => p.key === 'ai_provider_outage' && p.quiet === true));
  ok('NEG: a transient rate limit is not a dead-man problem', !DM.deadManProblems({ watch: { lastCheckAtMs: NOW }, cc: { lastTranscribeAtMs: NOW, lastRunAtMs: NOW, providerOutage: { kind: 'rate_limit', needsAction: false } }, now: NOW, gates, newestCallMs: NOW }).some((p) => p.key === 'ai_provider_outage'));

  console.log('\n10. Reopen script');
  const plan = R.planReopen([
    { id: 'a', data: { status: 'stored', transcribeAttempts: 3, transcribeError: CREDIT } },
    { id: 'b', data: { status: 'stored', transcribeAttempts: 3, transcribeError: 'notes: no JSON' } },
    { id: 'c', data: { status: 'noted', transcribeError: CREDIT } },
    { id: 'd', data: { status: 'stored', transcribeAttempts: 3, transcribeError: 'anthropic 401: invalid x-api-key' } },
  ]);
  ok('matches only stored + outage-class errors', plan.matched.join() === 'a,d' && plan.skipped === 2);
  db = fakeDb({
    [COLLECTION + '/a']: { status: 'stored', transcribeAttempts: 3, transcribeError: CREDIT, summary: 'keep' },
    [COLLECTION + '/b']: { status: 'stored', transcribeAttempts: 3, transcribeError: 'notes: no JSON' },
  });
  const lines = [];
  await R.run({ db, apply: false, log: (s) => lines.push(s) });
  ok('dry-run writes nothing', doc(db, 'a').transcribeAttempts === 3 && doc(db, 'a').transcribeError === CREDIT);
  ok('output is counts only (no ids / error text)', !/credit balance/.test(lines.join('\n')) && !lines.some((l) => /call-id-secret|skip-id-secret/.test(l)));
  const idDb = fakeDb({
    [COLLECTION + '/call-id-secret']: { status: 'stored', transcribeAttempts: 3, transcribeError: CREDIT },
    [COLLECTION + '/skip-id-secret']: { status: 'stored', transcribeAttempts: 3, transcribeError: 'notes: no JSON' },
  });
  const idLines = [];
  const dry = await R.run({ db: idDb, apply: false, log: (s) => idLines.push(s) });
  ok('POSITIVE CONTROL: matched and skipped ids exist but never reach the output', dry.matched === 1 && dry.scanned === 2 && idLines.length > 0 && !idLines.join('\n').includes('secret'));
  await R.run({ db, apply: true, log: () => {} });
  ok('--apply resets only the matched call and nothing else', doc(db, 'a').transcribeAttempts === 0 && doc(db, 'a').transcribeError === null && doc(db, 'a').status === 'stored' && doc(db, 'a').summary === 'keep' && doc(db, 'b').transcribeAttempts === 3);
  const noProj = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'reopen-provider-outage-calls.js'), '--apply'], { encoding: 'utf8' });
  ok('refuses without --project (exit 2, even with --apply)', noProj.status === 2 && /--project/.test(noProj.stderr), String(noProj.status));

  console.log('\n11. Alert gating, persistence, clearing (mutation gaps)');
  const YMD = '2026-10-01';
  const seedOne = (extra) => fakeDb(Object.assign({ [CONFIG]: {}, [COLLECTION + '/g1']: call('g1', { startedAtMs: NOW - 1000 }) }, extra || {}));
  const stubWith = (notesFn, pushFn) => {
    counts = { transcribe: 0, notes: 0, audio: [] }; pushes = [];
    setDeps({
      transcribe: async (buf) => { counts.transcribe++; counts.audio.push(String(buf)); return { text: 'Hello Jo, a quick gutter question.', durationSec: 60 }; },
      notes: async (a) => { counts.notes++; return notesFn(a); },
      push: async (uid, title, body, data) => { pushes.push({ uid, title, body, data }); return pushFn ? pushFn(pushes.length) : { sent: 1 }; },
    });
  };
  const http = (status, msg) => () => { const e = new Error(msg); e.status = status; e.provider = 'anthropic'; throw e; };

  // (1) bell not rewritten the same day
  db = seedOne(); stubWith(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  const bellKey = bells(db)[0][0];
  db.docs.get(bellKey).read = true;
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 30 * 60000 });
  ok('(1) same-day rerun does not rewrite the bell (Jo\'s read mark survives)', db.docs.get(bellKey).read === true && bells(db).length === 1);

  // (2) no push outside watch hours; bell still written; push retried in hours
  const NIGHT = Date.parse('2026-10-01T07:00:00Z'); // 03:00 ET
  db = seedOne({ [COLLECTION + '/g1']: call('g1', { startedAtMs: NIGHT - 1000 }) }); stubWith(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NIGHT });
  ok('(2) 03:00 ET: bell yes, push NO, pushedYmd not claimed', bells(db).length === 1 && pushes.length === 0 && !cc(db).providerOutage.pushedYmd && cc(db).providerOutage.alertedYmd === YMD);
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('(2) the first in-hours run sends the push the night skipped', pushes.length === 1 && cc(db).providerOutage.pushedYmd === YMD);

  // (3) {sent:0} is not "told"
  db = seedOne(); stubWith(() => { throw creditErr(); }, () => ({ sent: 0, failed: 1 }));
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('(3) push reached nobody: pushedYmd unset', pushes.length === 1 && !cc(db).providerOutage.pushedYmd && cc(db).providerOutage.alertedYmd === YMD);
  stubWith(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 30 * 60000 });
  ok('(3) next run retries the push and then marks it told', pushes.length === 1 && cc(db).providerOutage.pushedYmd === YMD);
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 60 * 60000 });
  ok('(3) NEG: once told, no further push that day', pushes.length === 1);

  // (4) + (10) transient outages: no alert, flags a rate-limit consumer reads
  db = seedOne(); stubWith(http(429, 'anthropic 429: rate_limit_error'));
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('(4) 429: no bell, no push, no strike', bells(db).length === 0 && pushes.length === 0 && !(Number(doc(db, 'g1').transcribeAttempts) > 0));
  ok('(10) 429 sets out.rateLimited and the call\'s rateLimitedAtMs (call-watch reads rateLimited > 0)', r.rateLimited === true && doc(db, 'g1').rateLimitedAtMs === NOW && cc(db).lastTranscribe.rateLimited === true && cc(db).providerOutage.needsAction === false);
  db = seedOne(); stubWith(http(503, 'anthropic 503: unavailable'));
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('(4) 503: recorded as an outage, but no bell, no push', r.state === 'provider_outage' && cc(db).providerOutage.kind === 'overloaded' && bells(db).length === 0 && pushes.length === 0 && !doc(db, 'g1').rateLimitedAtMs);

  // (5) gate off: nothing runs; test mode (transcribeOnly) is a real run that alerts
  db = seedOne(); stubWith(() => { throw creditErr(); });
  r = await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('(5) live:false with no transcribeOnly: off, nothing sent, nothing alerted', r.state === 'off' && counts.transcribe === 0 && bells(db).length === 0 && pushes.length === 0 && !cc(db).providerOutage);
  db = seedOne({ [CONFIG]: { transcribeOnly: ['g1'] } }); stubWith(() => { throw creditErr(); });
  r = await runTranscribe({ db, bucket, live: false, nowMs: NOW });
  ok('(5) POSITIVE CONTROL: live:false + transcribeOnly is a real run and does alert', r.state === 'provider_outage' && bells(db).length === 1);

  // (6) + (7) persistence across a no-alert rerun
  db = seedOne(); stubWith(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW + 30 * 60000 });
  const po = cc(db).providerOutage;
  ok('(6) sinceMs is the first run, lastAtMs the latest', po.sinceMs === NOW && po.lastAtMs === NOW + 30 * 60000, JSON.stringify(po));
  ok('(7) alertedYmd + pushedYmd survive the rerun that sent nothing', po.alertedYmd === YMD && po.pushedYmd === YMD && pushes.length === 1);

  // (8) no evidence, no clearing
  const prior = { provider: 'anthropic', kind: 'credit', reason: 'x', needsAction: true, sinceMs: NOW - 3600e3, lastAtMs: NOW - 1800e3, alertedYmd: YMD, pushedYmd: YMD };
  db = fakeDb({ [CONFIG]: { providerOutage: prior } }); stubWith(() => GOOD());
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('(8) a run with no calls and no AI success leaves the outage flag set', cc(db).providerOutage && cc(db).providerOutage.kind === 'credit' && !r.outageCleared);
  db = fakeDb({ [CONFIG]: { providerOutage: prior }, [COLLECTION + '/ok1']: call('ok1', {}) }); stubWith(() => GOOD());
  r = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('(8) POSITIVE CONTROL: the same seed with one call that notes fine clears it', cc(db).providerOutage === null && r.outageCleared === true);

  // (9) no facts re-read after the outage was hit this run
  db = fakeDb({
    [CONFIG]: {},
    [COLLECTION + '/g1']: call('g1', { startedAtMs: NOW - 1000 }),
    [COLLECTION + '/nf']: call('nf', { status: 'noted', leadId: null, transcript: 'Dana on Oak Hill Dr', factsV: 0, startedAtMs: NOW - 9000 }),
  });
  stubWith(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  ok('(9) the facts re-read does not run once the outage is hit (one model call total)', counts.notes === 1 && !(Number(doc(db, 'nf').factsAttempts) > 0), String(counts.notes));

  // end to end: what runTranscribe wrote -> health row + dead-man problem
  db = seedOne(); stubWith(() => { throw creditErr(); });
  await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  const written = cc(db);
  const e2eGates = { ingest: true, transcribe: true, watch: true };
  const hr = H.healthRows({ now: NOW + 60000, gates: e2eGates, cc: written }).rows.find((x) => x.key === 'ai_notes');
  const dp = DM.deadManProblems({ watch: { lastCheckAtMs: NOW }, cc: written, now: NOW + 60000, gates: e2eGates, newestCallMs: NOW });
  ok('e2e: the stored outage doc becomes a bad health row naming the reason', hr && hr.status === 'bad' && /out of credit/.test(hr.detail));
  ok('e2e: ...and a quiet dead-man problem', dp.some((p) => p.key === 'ai_provider_outage' && p.quiet === true && /out of credit/.test(p.text)));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
