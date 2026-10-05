/**
 * tests/voice-memo-groq-2026-10-04.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * transcribeVoiceMemo (the card-detail "Voice Memo" button) transcribed only
 * through Deepgram, and DEEPGRAM_API_KEY has only ever held the deploy's
 * `__unset__` stub. So in prod every memo answered "Voice transcription not
 * configured". The callable now uses Groq Whisper through the same shared
 * helper and key that `dictate` already uses (voice-intelligence.js
 * transcribeGroqBuffer + transcription-logic.js), behind the same AI kill
 * switch and per-uid rate limit.
 *
 * This runs the REAL handler (firebase-functions' own onCall, `.run()`), with
 * only Firestore, the kill switch and the rate limiter stubbed and global
 * fetch replaced by a fake Groq. No network call is ever made. On the old
 * Deepgram code the happy path fails (failed-precondition: Groq set, Deepgram
 * stub) — that is the break-test.
 *
 * Also pins call-timeline.js: the voice_memo activity the callable writes now
 * shows on the customer timeline (before, nothing rendered it).
 *
 * Needs functions/node_modules. Run: node tests/voice-memo-groq-2026-10-04.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── World: what the stubs read and record ───────────────────────────────
let W;
function reset(over) {
  W = Object.assign({
    docs: { 'leads/L1': { userId: 'U1' }, 'leads/L2': { userId: 'OTHER' } },
    adds: [], fetches: [], limiterCalls: 0,
    aiDisabled: false, rateLimited: false,
    groq: { status: 200, body: { text: '  Check the ridge vent on the north side.  ', duration: 7.4, segments: [] } },
  }, over || {});
}

const FieldValue = { serverTimestamp: () => ({ __fv: 'ts' }) };
const fakeDb = {
  doc: (p) => ({ get: async () => ({ exists: W.docs[p] != null, data: () => W.docs[p] }) }),
  collection: (p) => ({ add: async (v) => { W.adds.push({ path: p, v }); return { id: 'a' + W.adds.length }; } }),
};
const STUBS = {
  'firebase-admin/firestore': { getFirestore: () => fakeDb, FieldValue, Timestamp: { now: () => ({}) } },
  [path.join(FUNCTIONS, 'integrations', 'killswitch.js')]: {
    isAiDisabled: async () => W.aiDisabled, isVoiceIntelDisabled: async () => false,
    getFlags: async () => ({}), isWebLeadMeasureDisabled: async () => false, isAiDraftDisabled: async () => false,
  },
  [path.join(FUNCTIONS, 'integrations', 'upstash-ratelimit.js')]: {
    enforceRateLimit: async () => {
      W.limiterCalls++;
      if (W.rateLimited) { const e = new Error('limited'); e.rateLimited = true; throw e; }
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (STUBS[request]) return STUBS[request];
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* fall through */ }
  if (resolved && STUBS[resolved]) return STUBS[resolved];
  return origLoad.apply(this, arguments);
};

// Fake vendor network: records every call, never leaves the process.
global.fetch = async (url, init) => {
  const rec = { url: String(url), auth: init && init.headers && (init.headers.Authorization || init.headers.authorization), filename: null, model: null };
  if (init && init.body && typeof init.body.get === 'function') {
    const f = init.body.get('file');
    rec.filename = f && f.name;
    rec.model = init.body.get('model');
  }
  W.fetches.push(rec);
  if (/deepgram/.test(rec.url)) {
    return { ok: true, status: 200, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'from deepgram', confidence: 0.9 }] }] } }), text: async () => '' };
  }
  const g = W.groq;
  return { ok: g.status >= 200 && g.status < 300, status: g.status, json: async () => g.body, text: async () => JSON.stringify(g.body) };
};

process.env.GROQ_API_KEY = 'gsk_test_dummy';
process.env.DEEPGRAM_API_KEY = '__unset__';

const mod = require(path.join(FUNCTIONS, 'integrations', 'voice-memo.js'));
const fn = mod.transcribeVoiceMemo;

const AUDIO = Buffer.alloc(4000, 7).toString('base64');
const req = (data, token) => ({ auth: { uid: 'U1', token: token || { role: 'sales_rep' } }, data });
async function call(data, token) {
  try { return { res: await fn.run(req(data, token)) }; }
  catch (e) { return { err: e }; }
}
const groqCalls = () => W.fetches.filter((f) => /api\.groq\.com\/openai\/v1\/audio\/transcriptions/.test(f.url));
const deepgramCalls = () => W.fetches.filter((f) => /deepgram/.test(f.url));

(async () => {
  console.log('\n1. secret binding');
  {
    const secrets = ((fn.__endpoint && fn.__endpoint.secretEnvironmentVariables) || []).map((s) => s.key);
    ok('transcribeVoiceMemo binds GROQ_API_KEY', secrets.includes('GROQ_API_KEY'), JSON.stringify(secrets));
    ok('…and no longer binds DEEPGRAM_API_KEY', !secrets.includes('DEEPGRAM_API_KEY'), JSON.stringify(secrets));
  }

  console.log('\n2. happy path — memo on a lead (Chrome/Android webm)');
  {
    reset();
    const { res, err } = await call({ audioBase64: AUDIO, mimeType: 'audio/webm;codecs=opus', leadId: 'L1' });
    ok('returns the trimmed transcript', !err && res && res.success === true && res.transcript === 'Check the ridge vent on the north side.', err ? err.code + ' ' + err.message : JSON.stringify(res));
    ok('confidence is null (Groq gives none — not invented)', res && res.confidence === null);
    ok('word count from the transcript', res && res.words === 8, res && res.words);
    ok('exactly one Groq call, zero Deepgram calls', groqCalls().length === 1 && deepgramCalls().length === 0, JSON.stringify(W.fetches.map((f) => f.url)));
    const g = groqCalls()[0] || {};
    ok('Groq call uses the shared key as a Bearer token', g.auth === 'Bearer gsk_test_dummy', g.auth);
    ok('Groq call uses whisper-large-v3-turbo (the shared helper)', g.model === 'whisper-large-v3-turbo', g.model);
    ok('upload is named .webm for a webm clip', g.filename === 'memo.webm', g.filename);
    ok('one voice_memo activity written on the lead', W.adds.length === 1 && W.adds[0].path === 'leads/L1/activity' && W.adds[0].v.type === 'voice_memo', JSON.stringify(W.adds));
    const v = (W.adds[0] || {}).v || {};
    ok('activity carries transcript, uid, provider groq, Groq duration', v.transcript === 'Check the ridge vent on the north side.' && v.userId === 'U1' && v.provider === 'groq' && v.durationSec === 7 && v.label === 'Voice memo', JSON.stringify(v));
    ok('rate limiter consulted once', W.limiterCalls === 1);
  }

  console.log('\n3. iOS Safari mp4 clip');
  {
    reset();
    await call({ audioBase64: AUDIO, mimeType: 'audio/mp4', leadId: 'L1' });
    ok('upload is named .m4a so Groq detects the container', (groqCalls()[0] || {}).filename === 'memo.m4a', (groqCalls()[0] || {}).filename);
  }

  console.log('\n4. no lead (nbd-whisper dictate fallback) — transcript only');
  {
    reset();
    const { res, err } = await call({ audioBase64: AUDIO, mimeType: 'audio/webm' });
    ok('transcript returned', !err && res.transcript === 'Check the ridge vent on the north side.');
    ok('nothing written', W.adds.length === 0);
    reset();
    const v = await call({ audioBase64: AUDIO, mimeType: 'audio/webm' }, { role: 'viewer' });
    ok('a viewer may still transcribe without a lead (unchanged)', !v.err && v.res.transcript.length > 0);
    reset();
    const v2 = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L1' }, { role: 'viewer' });
    ok('a viewer WITH a lead is refused before any spend', v2.err && v2.err.code === 'permission-denied' && W.fetches.length === 0 && W.limiterCalls === 0);
  }

  console.log('\n5. guards dictate also has');
  {
    reset({ aiDisabled: true });
    const r = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L1' });
    ok('kill switch on → unavailable', r.err && r.err.code === 'unavailable', r.err && r.err.code);
    ok('…before the limiter and before Groq', W.limiterCalls === 0 && W.fetches.length === 0);

    reset({ rateLimited: true });
    const r2 = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L1' });
    ok('rate limited → resource-exhausted, no Groq call', r2.err && r2.err.code === 'resource-exhausted' && W.fetches.length === 0);

    reset();
    process.env.GROQ_API_KEY = '__unset__';
    process.env.DEEPGRAM_API_KEY = 'dg_real_looking_key';
    const r3 = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L1' });
    ok('Groq key is the deploy stub → failed-precondition "not configured"', r3.err && r3.err.code === 'failed-precondition' && /not configured/.test(r3.err.message), r3.err && r3.err.message);
    ok('…and a Deepgram key does NOT bring Deepgram back', deepgramCalls().length === 0 && W.fetches.length === 0);
    process.env.GROQ_API_KEY = 'gsk_test_dummy';
    process.env.DEEPGRAM_API_KEY = '__unset__';

    reset();
    const r4 = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L2' });
    ok("someone else's lead → permission-denied, no Groq call", r4.err && r4.err.code === 'permission-denied' && W.fetches.length === 0);
    reset();
    const r5 = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'NOPE' });
    ok('missing lead → not-found, no Groq call', r5.err && r5.err.code === 'not-found' && W.fetches.length === 0);
    reset();
    const r6 = await call({ audioBase64: 'abc', mimeType: 'audio/webm' });
    ok('missing audio → invalid-argument, no Groq call', r6.err && r6.err.code === 'invalid-argument' && W.fetches.length === 0);
  }

  console.log('\n6. Groq failures');
  {
    reset({ groq: { status: 429, body: { error: { message: 'Rate limit reached for model whisper on tier free' } } } });
    const r = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L1' });
    ok('Groq 429 → resource-exhausted (try again shortly)', r.err && r.err.code === 'resource-exhausted' && /minute/.test(r.err.message), r.err && r.err.code + ' ' + r.err.message);
    ok('…nothing written', W.adds.length === 0);

    reset({ groq: { status: 500, body: { error: { message: 'secret internal provider detail' } } } });
    const r2 = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L1' });
    ok('Groq 500 → internal "Transcription failed"', r2.err && r2.err.code === 'internal' && r2.err.message === 'Transcription failed', r2.err && r2.err.message);
    ok('…provider detail never reaches the client', r2.err && !/secret internal/.test(r2.err.message));
    ok('…nothing written', W.adds.length === 0);

    reset({ groq: { status: 200, body: { text: '   ', duration: 2 } } });
    const r3 = await call({ audioBase64: AUDIO, mimeType: 'audio/webm', leadId: 'L1' });
    ok('silence → empty transcript returned, no activity written', !r3.err && r3.res.transcript === '' && r3.res.words === 0 && W.adds.length === 0);
  }

  console.log('\n7. the memo shows on the customer timeline (call-timeline.js)');
  {
    const CT = require(path.join(ROOT, 'docs', 'pro', 'js', 'call-timeline.js'));
    const at = Date.parse('2026-10-04T15:00:00Z');
    const row = CT.fromActivity('a1', { type: 'voice_memo', label: 'Voice memo', transcript: 'Check the ridge vent.', durationSec: 75, provider: 'groq', createdAt: { toDate: () => new Date(at) } });
    ok('a voice_memo activity → a Notes row with the transcript', !!row && row.type === 'note' && row.kind === 'memo' && row.desc === 'Check the ridge vent.' && row.title === 'Voice memo · 1m 15s', JSON.stringify(row));
    ok('…dated when it was filed', !!row && row.time.getTime() === at);
    const evil = CT.fromActivity('a2', { type: 'voice_memo', transcript: '<img src=x onerror=alert(1)>' });
    ok('transcript stays a plain string (the renderer escapes it)', !!evil && evil.desc.includes('<img') && typeof evil.desc === 'string');
    ok('other rep-written activity is still NOT read here', CT.fromActivity('a3', { type: 'note', source: 'rep' }) === null);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    console.log('\nFAILED:');
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
