/**
 * tests/ai-gate-entry-points-2026-11-25.test.js
 *
 * Roadmap step 12: every server AI entry point calls the one gate
 * (functions/ai-gate.js aiGate) before it spends. Each entry point below runs
 * for real over an in-memory Firestore and a fetch spy: a free plan, a
 * company over its daily cap, the platform over its cap, or the stop-all
 * switch is refused BEFORE any model call; a paying company under its cap
 * still gets through (the positive control), and its spend lands on its own
 * per-company counter.
 *
 *   1. handlers/ai.js: claudeProxy, adminAI, publicVisualizerAI, publicFunnelAI
 *   2. dictate (the assertAiEntitled path every other callable shares)
 *   3. leadBrief / callBrief (lead-brief aiAllowed) and coachLine
 *   4. unattended: the call-center feed, Thursday's extraction, the morning
 *      brief's lines, the AI-suggested SMS draft
 *
 * Run: node tests/ai-gate-entry-points-2026-11-25.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');
const { fakeDb } = require('./lib/call-center-fakes');

const ROOT = path.join(__dirname, '..');
const FN = (p) => path.join(ROOT, 'functions', p);

let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); failed++; fails.push(label); }
}
async function tryRun(name, fn) {
  try { await fn(); } catch (e) { ok(name + ' (threw)', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)); }
}

// ── stubs: Firestore is whatever `db` is now; vendors are a fetch spy ──
let db = fakeDb({});
const seen = { fetch: [], rate: 0, globalCap: 0, transcribe: 0, notes: 0 };
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const FV = { increment: (n) => n, serverTimestamp: () => 'ts', delete: () => null, arrayUnion: (...a) => a };
const STUBS = {
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'test-key' }) },
  'firebase-functions/v2': { logger: silent },
  'firebase-admin/firestore': { getFirestore: () => db, FieldValue: FV, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } },
  '../integrations/upstash-ratelimit': {
    httpRateLimit: async () => true,
    enforceRateLimit: async () => { seen.globalCap++; },
  },
  './integrations/upstash-ratelimit': { enforceRateLimit: async () => { seen.rate++; } },
  '../rate-limit-policy': { guardHttp: (name, h) => h },
  '../shared': { requireAuth: async (req) => (req.__decoded ? { decoded: req.__decoded } : { error: { status: 401, body: { error: 'no' } } }) },
  './integrations/_shared': { SECRETS: { GROQ_API_KEY: { name: 'GROQ_API_KEY' } }, hasSecret: () => true, secretValue: () => 'k', getSecret: () => 'k' },
  './integrations/voice-intelligence': { transcribeGroqBuffer: async (a) => { seen.transcribe++; seen.transcribeArgs = a; return { text: 'hello there' }; } },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
global.fetch = async (url, init) => {
  seen.fetch.push(String(url));
  return { ok: true, status: 200, json: async () => ({ model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), text: async () => '' };
};

const G = require(FN('ai-gate.js'));
const K = require(FN('integrations/killswitch.js'));
const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const NBD = G.PLATFORM_UID;
const SUBS = {
  'subscriptions/paidCo': { plan: 'growth', status: 'active' },
  'subscriptions/starterCo': { plan: 'starter', status: 'active' },
  'subscriptions/freeCo': { plan: 'free', status: 'none' },
};
// A world: plans + today's spend + the limits doc. Every case starts cold.
function world(o) {
  const day = etYmd(Date.now());
  const seed = Object.assign({}, SUBS, (o && o.seed) || {});
  if (o && o.platformMicros) seed['ai_spend_daily/' + day] = { usdMicros: o.platformMicros };
  for (const [co, m] of Object.entries((o && o.company) || {})) seed['ai_spend_daily_co/' + day + '__' + co] = { usdMicros: m };
  if (o && o.limits) seed['feature_flags/global'] = { aiSpendLimits: o.limits };
  db = fakeDb(seed);
  K._resetCache(); G._resetBreakerCache();
  seen.fetch = []; seen.rate = 0; seen.globalCap = 0; seen.transcribe = 0; seen.notes = 0;
  return db;
}
const OVER_PLATFORM = { platformMicros: 2000000 };      // > $1.38
const STARTER_OVER = { company: { starterCo: 500000 } }; // > Starter's $0.46 share
const tok = (co, extra) => Object.assign({ uid: 'u_' + co, companyId: co, email_verified: true, role: 'company_admin' }, extra || {});

(async () => {
  console.log('\n1. handlers/ai.js');
  await tryRun('ai.js', async () => {
    const AI = require(FN('handlers/ai.js'));
    const post = async (name, body, decoded) => {
      const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      await AI[name].__handler({ method: 'POST', body, headers: {}, ip: '203.0.113.9', __decoded: decoded }, res);
      return res;
    };
    const ask = { messages: [{ role: 'user', content: 'hi' }], model: 'claude-haiku-4-5-20251001', max_tokens: 50, feature: 'smart-followup' };

    world();
    let r = await post('claudeProxy', ask, tok('paidCo'));
    ok('claudeProxy: a paying company under its cap → the model is called (positive control)', r.code === 200 && seen.fetch.length === 1, { code: r.code, body: r.body });
    ok('claudeProxy: …and its spend lands on its own per-company counter', db.docs.has('ai_spend_daily_co/' + etYmd(Date.now()) + '__paidCo'));
    world();
    r = await post('claudeProxy', ask, tok('freeCo'));
    ok('claudeProxy: a free plan → 403, no model call', r.code === 403 && seen.fetch.length === 0, r.body);
    world(STARTER_OVER);
    r = await post('claudeProxy', ask, tok('starterCo'));
    ok('claudeProxy: a company over its daily cap → 429 "AI paused until tomorrow (daily limit).", no model call',
      r.code === 429 && r.body && r.body.error === 'AI paused until tomorrow (daily limit).' && seen.fetch.length === 0, r.body);
    r = await post('claudeProxy', ask, tok('paidCo'));
    ok('claudeProxy: …the same day another company still gets through', r.code === 200 && seen.fetch.length === 1, r.body);
    world({ limits: { stopAll: true } });
    r = await post('claudeProxy', ask, tok('paidCo'));
    ok('claudeProxy: stopAll → 503, no model call', r.code === 503 && seen.fetch.length === 0, r.body);

    world();
    r = await post('adminAI', { prompt: 'summarize' }, tok('freeCo'));
    ok('adminAI: a free company_admin → 403, no model call', r.code === 403 && seen.fetch.length === 0, r.body);
    world(OVER_PLATFORM);
    r = await post('adminAI', { prompt: 'summarize' }, tok('paidCo'));
    ok('adminAI: the platform over its cap → 429, no model call', r.code === 429 && seen.fetch.length === 0, r.body);
    world();
    r = await post('adminAI', { prompt: 'summarize' }, tok('paidCo'));
    ok('adminAI: paying, under the cap → the model is called', r.code === 200 && seen.fetch.length === 1, r.body);

    const FUNNEL = { kind: 'note', firstName: 'Pat', address: '1 Elm St, Cincinnati, OH 45202', service: 'roof-repair' };
    const VIS = { imageBase64: 'A'.repeat(2000), mediaType: 'image/jpeg', selectionsText: 'architectural asphalt shingles' };
    for (const [name, body] of [['publicVisualizerAI', VIS], ['publicFunnelAI', FUNNEL]]) {
      world();
      r = await post(name, body);
      ok(name + ': under the platform cap → the model is called (positive control)', seen.fetch.length === 1, { code: r.code, body: r.body });
      world(OVER_PLATFORM);
      r = await post(name, body);
      ok(name + ': the platform over its cap → 429, no model call, the shared daily cap not counted', r.code === 429 && seen.fetch.length === 0 && seen.globalCap === 0, { code: r.code, body: r.body, globalCap: seen.globalCap });
    }
  });

  console.log('\n2. dictate (assertAiEntitled, shared by every callable)');
  await tryRun('dictate', async () => {
    const dictate = require(FN('dictate.js')).dictate.__handler;
    const call = async (token) => {
      try { await dictate({ auth: { uid: token.uid, token }, data: { audioBase64: 'QUJD'.repeat(400), mimeType: 'audio/webm', mode: 'clean' } }); return { code: 'ok' }; }
      catch (e) { return { code: e.code, msg: e.message }; }
    };
    world(STARTER_OVER);
    let r = await call(tok('starterCo'));
    ok('dictate: over the company cap → resource-exhausted, before the rate limit and any Groq / Anthropic call',
      r.code === 'resource-exhausted' && /AI paused until tomorrow/.test(r.msg) && seen.rate === 0 && seen.transcribe === 0 && seen.fetch.length === 0, Object.assign({ seen }, r));
    world();
    r = await call(tok('starterCo'));
    ok('dictate: the same company under its cap → past the gate (rate limit counted)', seen.rate === 1 && r.code !== 'resource-exhausted', Object.assign({ seen }, r));
    ok('dictate: its Groq transcription is billed to the caller\'s company', !!seen.transcribeArgs && seen.transcribeArgs.companyId === 'starterCo', seen.transcribeArgs && seen.transcribeArgs.companyId);
  });

  console.log('\n3. leadBrief / callBrief and coachLine');
  await tryRun('briefs', async () => {
    const LB = require(FN('lead-brief.js'));
    const CO = require(FN('coach-line.js'));
    const auth = (co) => ({ uid: 'u_' + co, token: tok(co) });
    for (const [label, allowed] of [['lead-brief aiAllowed (leadBrief, callBrief)', LB.aiAllowed], ['coach-line aiAllowed', CO._test.aiAllowed]]) {
      world(STARTER_OVER);
      ok(label + ': over the company cap → no AI', (await allowed(db, auth('starterCo'))) === false);
      ok(label + ': …another paying company → AI', (await allowed(db, auth('paidCo'))) === true);
      ok(label + ': a free plan → no AI', (await allowed(db, auth('freeCo'))) === false);
      world({ seed: {} });
      db.doc = ((base) => (p) => (/^subscriptions\//.test(p) ? { get: async () => { throw new Error('down'); } } : base(p)))(db.doc);
      ok(label + ': a failed plan read → no AI (fails closed)', (await allowed(db, auth('paidCo'))) === false);
    }
  });

  console.log('\n4. unattended pipelines');
  await tryRun('call-center', async () => {
    const CC = require(FN('call-center.js'))._test;
    CC.setDeps({
      transcribe: async () => { seen.transcribe++; return { text: 'x', durationSec: 1, segments: [] }; },
      notes: async () => { seen.notes++; return {}; },
      push: async () => ({ sent: 0 }),
    });
    const feed = (co) => ({ nbd: false, owner: 'u_' + co, companyId: co, configPath: 'integrations/callCenter_' + co, folderId: 'f', tenant: null });
    const seedFor = (co) => ({ ['integrations/callCenter_' + co]: { enabled: true }, 'integrations/callCenter': {} });
    world(Object.assign({ seed: seedFor('starterCo') }, STARTER_OVER));
    let r = await CC.runTranscribe({ db, bucket: {}, live: true, nowMs: Date.now(), feed: feed('starterCo') });
    ok('call-center feed: a tenant over its cap → gated before any transcription or notes', r.state === 'gated' && r.reason === 'company_cap' && seen.transcribe === 0 && seen.notes === 0, r);
    const runRec = db.docs.get('integrations/callCenter_starterCo') || {};
    ok('call-center feed: a gated pass still writes its run record (lastTranscribeAtMs, state gated), so the deadman sees a pause, not a stalled job',
      Number(runRec.lastTranscribeAtMs) > 0 && !!runRec.lastTranscribe && runRec.lastTranscribe.state === 'gated' && runRec.lastTranscribe.reason === 'company_cap', runRec);
    world({ seed: seedFor('freeCo') });
    r = await CC.runTranscribe({ db, bucket: {}, live: true, nowMs: Date.now(), feed: feed('freeCo') });
    ok('call-center feed: a free tenant → gated (its own plan)', r.state === 'gated' && r.reason === 'plan', r);
    world({ seed: seedFor('paidCo') });
    r = await CC.runTranscribe({ db, bucket: {}, live: true, nowMs: Date.now(), feed: feed('paidCo') });
    ok('call-center feed: a paying tenant under its cap runs (positive control)', r.state !== 'gated', r);
  });
  await tryRun('thursday', async () => {
    const TH = require(FN('integrations/thursday.js'))._test;
    const call = { callId: 'c1', transcript: Array(60).fill('word').join(' ') };
    world(OVER_PLATFORM);
    let err = null;
    try { await TH.extract(call); } catch (e) { err = e; }
    ok('Thursday extraction: the platform over its cap → the failed-extraction path, no model call', !!err && /ai-gate-platform_cap/.test(String(err.code || err.message)) && seen.fetch.length === 0, err && (err.code || err.message));
    world();
    err = null;
    try { await TH.extract(call); } catch (e) { err = e; }
    ok('Thursday extraction: under the cap → the model is called (positive control)', seen.fetch.length === 1, err && (err.code || err.message));
  });
  await tryRun('morning-brief', async () => {
    const MB = require(FN('morning-brief.js'))._test;
    const leadsById = new Map([['L1', { companyId: NBD, firstName: 'Pat' }]]);
    world(OVER_PLATFORM);
    await MB.gatherBriefLines({ db, leadIds: ['L1'], leadsById, nowMs: Date.now(), log: silent, owner: NBD });
    ok('morning brief lines: the platform over its cap → the plain line, no model call', seen.fetch.length === 0, seen.fetch);
  });
  await tryRun('ai-texting', async () => {
    const AT = require(FN('handlers/ai-texting.js'));
    const getUser = async (uid) => ({ emailVerified: true, customClaims: { companyId: uid.replace(/^u_/, '') } });
    const realGate = G.aiGate;
    // The draft path reads the lead owner's Auth record: the same users as above.
    G.aiGate = (d, o) => realGate(d, Object.assign({}, o, { deps: Object.assign({}, o.deps, { getUser }) }));
    try {
      const lead = { userId: 'u_starterCo', companyId: 'starterCo', firstName: 'Pat', phone: '+15135550100' };
      // Positive control in the same world shape: under its cap, the same
      // lead gets a draft from exactly one model call, so the refusal below
      // is the gate's doing and not some other early return.
      world();
      const yes = await AT.generateAIDraft({ db, leadId: 'L1', lead, incomingBody: 'Is Tuesday ok?', triggerType: 'inbound_sms' });
      ok('AI-suggested SMS draft: the same company under its cap → a draft from one model call (positive control)', !!yes && seen.fetch.length === 1, { yes, fetch: seen.fetch.length });
      world(STARTER_OVER);
      const out = await AT.generateAIDraft({ db, leadId: 'L1', lead, incomingBody: 'Is Tuesday ok?', triggerType: 'inbound_sms' });
      ok('AI-suggested SMS draft: the lead owner\'s company over its cap → no draft, no model call', out === null && seen.fetch.length === 0, out);
    } finally { G.aiGate = realGate; }
  });

  await tryRun('text-inbox', async () => {
    const TI = require(FN('text-inbox.js'))._test;
    const now = Date.now();
    world(Object.assign({ seed: { ['phone_texts/t1']: { userId: TI.OWNER, sentAtMs: now - 6 * 3600e3, phoneDigits: '5135550100', direction: 'in', body: 'Is Tuesday ok?' } } }, OVER_PLATFORM));
    TI.setNotes(async () => { seen.notes++; return {}; });
    // The fake answers == filters only; the texts query has a range filter.
    const texts = [{ id: 't1', data: () => db.docs.get('phone_texts/t1') }];
    const baseColl = db.collection;
    db.collection = (n) => (n === TI.COLLECTION ? { where() { return this; }, orderBy() { return this; }, limit() { return this; }, get: async () => ({ forEach: (fn) => texts.forEach(fn) }) } : baseColl(n));
    const r = await TI.runTextNotes({ db, live: true, nowMs: now });
    const rec = db.docs.get(TI.CONFIG) || {};
    ok('text notes: the platform over its cap → gated, no model call', r.state === 'gated' && seen.notes === 0, r);
    ok('text notes: …and the gated run is recorded (lastNotesAtMs, state gated), not only logged',
      Number(rec.lastNotesAtMs) === now && !!rec.lastNotes && rec.lastNotes.state === 'gated' && rec.lastNotes.reason === 'platform_cap', rec);
  });

  console.log('\n5. every spending feature records its company (the per-company cap sees it)');
  const coDoc = (co) => db.docs.get('ai_spend_daily_co/' + etYmd(Date.now()) + '__' + co);
  await tryRun('voice-intel', async () => {
    const VI = require(FN('integrations/voice-intelligence.js'));
    world();
    await VI._analyzeTranscript({ transcript: 'hello', segments: [], leadName: 'Pat', callType: 'other', companyId: 'paidCo' }).catch(() => null);
    ok('voice intel analysis: its Claude call lands on the company\'s daily counter', seen.fetch.length === 1 && !!coDoc('paidCo'), { fetch: seen.fetch.length, doc: coDoc('paidCo') });
    world();
    await VI._checkVerbalConsent({ transcript: 'yes that is fine', segments: [], companyId: 'paidCo' }).catch(() => null);
    ok('voice intel consent check: its Claude call lands on the company\'s daily counter', seen.fetch.length === 1 && !!coDoc('paidCo'), { fetch: seen.fetch.length, doc: coDoc('paidCo') });
    world();
    const savedKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk_' + 'test_dummy';
    const realFetch = global.fetch;
    global.fetch = async (url) => { seen.fetch.push(String(url)); return { ok: true, status: 200, json: async () => ({ text: 'hi', duration: 12, segments: [] }) }; };
    try {
      const bucket = { file: () => ({ exists: async () => [true], getMetadata: async () => [{ size: 10 }], download: async () => [Buffer.from('audio')] }) };
      await VI._transcribeAudio({ bucket, path: 'audio/u/L1/r1.webm', mimeType: 'audio/webm', companyId: 'paidCo' });
    } finally { global.fetch = realFetch; if (savedKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedKey; }
    ok('voice intel transcription (Groq): lands on the company\'s daily counter', seen.fetch.length === 1 && !!coDoc('paidCo'), { fetch: seen.fetch.length, doc: coDoc('paidCo') });
  });
  await tryRun('reel-studio', async () => {
    process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-reel', storageBucket: 'demo-reel.appspot.com' });
    const RS = require(FN('reel-studio.js'))._test;
    world();
    const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'text', text: '{"frames":[{"i":0,"flags":[]}]}' }] }) });
    const vr = await RS.callVision([{ t: 0.5, b64: 'AAAA' }], { apiKey: 'k', fetchFn, companyId: 'paidCo' });
    ok('reel vision: its Claude call is recorded as AI spend, on the company\'s daily counter', vr.ran === true && !!coDoc('paidCo') && !!db.docs.get('ai_spend_daily/' + etYmd(Date.now())), { vr, doc: coDoc('paidCo') });
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
