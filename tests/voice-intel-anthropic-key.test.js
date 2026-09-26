/**
 * tests/voice-intel-anthropic-key.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Found 2026-09-26 (Thursday/Bland recon): Voice Intel's callClaudeJson gated
 * on hasSecret('ANTHROPIC_API_KEY') from integrations/_shared.js. hasSecret()
 * returns false for any name that is not in that module's SECRETS registry,
 * and ANTHROPIC_API_KEY has never been registered there — so with the key
 * bound to onAudioUploaded and set, every recording would have been
 * transcribed (Groq, paid) and then marked
 *   status:'failed', statusError:'[anthropic-not-configured] …'
 * and voice-consumer.js, which only fires on status:'complete', never ran.
 * It never bit a customer only because no recording had ever been made
 * (prod: 0 docs in collectionGroup('recordings') on 2026-09-26).
 *
 * The fix reads the bare param the module binds, through secretValue().
 * This suite runs processRecording() for real against an in-memory
 * Firestore/Storage and a stubbed fetch, so it checks the outcome (status,
 * the header Anthropic actually receives, which vendors were called) rather
 * than the shape of the source. It also pins the two spend gates that sit in
 * front of the now-working Claude call: the voiceIntelDisabled kill switch
 * and the per-company daily budget.
 *
 * TENANCY. Making the pipeline work also made a known hole live
 * (STABILITY-AUDIT-2026-09-04, "cross-tenant-write"): the lead id comes from a
 * Storage path the uploader chooses. While every run died at analysis, a
 * planted recording never completed. Once it can, voiceConsumer writes tasks
 * and insurance fields onto whatever lead the path names. So the same change
 * refuses a lead outside the uploader's tenant before any write or vendor
 * call, and the last section pins that.
 *
 * Break-tests (2026-09-26), 35 checks:
 *   - callClaudeJson restored to hasSecret/getSecret → 13 red: every case
 *     that expects a run to complete, with the prod symptom verbatim
 *     ("failed / [anthropic-not-configured] ANTHROPIC_API_KEY secret is unset";
 *     verbal mode: "quarantined_consent"). The binding checks, the unset-key
 *     cases, the kill-switch / over-budget stops and the refusals stay green,
 *     as they should, because none of them reaches Claude.
 *   - uploaderMayRecordOn() → `return true` → 9 red, all in TENANCY: the
 *     foreign lead gets a completed recording, Groq + Anthropic are called,
 *     and the kill-switch / over-budget branches plant their "failed" doc there.
 *
 * Run: node tests/voice-intel-anthropic-key.test.js  (needs functions/node_modules
 * for the firebase-functions require, same as the unit-suite job installs)
 */
'use strict';

const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── In-memory Firestore + Storage, swapped in for firebase-admin ──────────
const store = new Map();
const INC = Symbol('inc');
const FieldValue = {
  serverTimestamp: () => ({ __ts: true }),
  increment: (n) => ({ [INC]: n })
};
function applyMerge(prev, patch) {
  const out = Object.assign({}, prev);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && INC in v) ? (Number(prev[k]) || 0) + v[INC] : v;
  }
  return out;
}
const fakeDb = {
  doc(p) {
    return {
      path: p,
      async get() { const d = store.get(p); return { exists: !!d, data: () => d }; },
      async set(data, opts) {
        const prev = (opts && opts.merge && store.get(p)) || {};
        store.set(p, applyMerge(prev, data));
      },
      async update(data) { store.set(p, applyMerge(store.get(p) || {}, data)); },
      async delete() { store.delete(p); }
    };
  },
  collection() { throw new Error('collection() not expected in this suite'); },
  collectionGroup() { throw new Error('collectionGroup() not expected in this suite'); }
};
const Timestamp = { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) };
const fakeBucket = {
  file: () => ({
    exists: async () => [true],
    getMetadata: async () => [{ size: 2048 }],
    download: async () => [Buffer.from('not really audio')]
  })
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => fakeDb, FieldValue, Timestamp };
  if (request === 'firebase-admin/storage') return { getStorage: () => ({ bucket: () => fakeBucket }) };
  return realLoad.apply(this, arguments);
};

// ── Stubbed vendors ──────────────────────────────────────────────────────
let calls = [];
global.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, headers: (init && init.headers) || {} });
  if (u.startsWith('https://api.groq.com/')) {
    return { ok: true, status: 200, json: async () => ({ text: 'Yes you can record. The hail hit the north slope.', duration: 42, segments: [{ start: 0, end: 3, text: 'Yes you can record.' }] }) };
  }
  if (u.startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(init.body);
    const isConsent = body.max_tokens <= 200;
    const payload = isConsent
      ? { consented: true, evidence: 'Yes you can record.' }
      : { speakers: [{ label: 'A', role: 'homeowner', confidence: 0.9 }],
          summary: { overview: 'Hail on the north slope.', nextActions: ['Book inspection'], damageNoted: [], objections: [], commitments: [], redFlags: [] } };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], usage: { input_tokens: 100, output_tokens: 20 } }) };
  }
  throw new Error('unexpected fetch ' + u);
};
const anthropicCalls = () => calls.filter(c => c.url.startsWith('https://api.anthropic.com/'));
const groqCalls = () => calls.filter(c => c.url.startsWith('https://api.groq.com/'));

process.env.GROQ_API_KEY = 'gsk-test';
const vi = require(path.join(ROOT, 'functions/integrations/voice-intelligence.js'));
const killswitch = require(path.join(ROOT, 'functions/integrations/killswitch.js'));
const { SECRETS } = require(path.join(ROOT, 'functions/integrations/_shared.js'));
// Quiet the pipeline's own logging: its "voice: pipeline failed" ERROR lines
// are expected in the key-hygiene cases and would read as suite failures.
{
  const { logger } = Module.createRequire(path.join(ROOT, 'functions/index.js'))('firebase-functions/v2');
  for (const m of ['debug', 'info', 'log', 'warn', 'error']) logger[m] = () => {};
}

const UID = 'u1', LEAD = 'leadA';
let n = 0;
function reset({ key, consentMode, flags, usedSec, lead } = {}) {
  store.clear(); calls = []; killswitch._resetCache();
  if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key;
  store.set('users/' + UID, { companyId: 'co1' });
  store.set('subscriptions/' + UID, { plan: 'foundation' });
  store.set('companies/co1', consentMode ? { recordingConsentMode: consentMode } : {});
  if (lead !== null) store.set('leads/' + LEAD, lead || { userId: UID, companyId: 'co1', firstName: 'Pat', lastName: 'Lee' });
  if (flags) store.set('feature_flags/global', flags);
  if (usedSec) store.set('api_usage_daily/' + new Date().toISOString().slice(0, 10) + '__co__co1', { voice_audioSec: usedSec });
  const recordingId = 'rec' + (++n);
  return { recordingId, docPath: 'leads/' + LEAD + '/recordings/' + recordingId };
}
function run(recordingId) {
  return vi._processRecording({
    uid: UID, leadId: LEAD, recordingId,
    path: 'audio/' + UID + '/' + LEAD + '/' + recordingId + '.webm',
    contentType: 'audio/webm', size: 2048, forceReanalyze: false
  });
}

(async () => {
  console.log('\nBINDING — onAudioUploaded is deployed with the key it reads');
  {
    const bound = (vi.onAudioUploaded.__endpoint.secretEnvironmentVariables || []).map(s => s.key);
    ok('onAudioUploaded binds ANTHROPIC_API_KEY', bound.includes('ANTHROPIC_API_KEY'), JSON.stringify(bound));
    ok('the param it reads is named ANTHROPIC_API_KEY', vi._constants.ANTHROPIC_API_KEY_FOR_VOICE.name === 'ANTHROPIC_API_KEY');
    ok('ANTHROPIC_API_KEY is still NOT in the shared registry (the fix must not widen hasSecret/integrationStatus)',
      !Object.prototype.hasOwnProperty.call(SECRETS, 'ANTHROPIC_API_KEY'));
  }

  console.log('\nHEALTHY KEY — a recording reaches status:complete (the bug made this [anthropic-not-configured])');
  {
    const { recordingId, docPath } = reset({ key: 'sk-ant-test' });
    const res = await run(recordingId);
    const doc = store.get(docPath) || {};
    ok('processRecording returns ok', res && res.ok === true, JSON.stringify(res));
    ok('recording status is complete', doc.status === 'complete', doc.status + ' / ' + doc.statusError);
    ok('no statusError', doc.statusError === null, String(doc.statusError));
    ok('Anthropic was called exactly once (analysis)', anthropicCalls().length === 1, String(anthropicCalls().length));
    ok('Anthropic received the bound key in x-api-key',
      anthropicCalls()[0] && anthropicCalls()[0].headers['x-api-key'] === 'sk-ant-test');
    ok('the summary landed — the shape voice-consumer.js fires on', doc.summary && doc.summary.overview === 'Hail on the north slope.');
    const usage = store.get('api_usage_daily/' + new Date().toISOString().slice(0, 10) + '__co__co1') || {};
    ok('the company voice budget counter accrued the audio seconds', usage.voice_audioSec === 42, JSON.stringify(usage));
  }

  console.log('\nKEY HYGIENE — trimmed, and the deploy stub is "unset"');
  {
    const { recordingId } = reset({ key: 'sk-ant-test\r\n' });
    await run(recordingId);
    ok('a pasted trailing CRLF is trimmed off the header',
      anthropicCalls()[0] && anthropicCalls()[0].headers['x-api-key'] === 'sk-ant-test');

    for (const [label, key] of [['the __unset__ deploy stub', '__unset__'], ['an unset env var', undefined], ['whitespace only', '  ']]) {
      const r = reset({ key });
      await run(r.recordingId);
      const doc = store.get(r.docPath) || {};
      ok(label + ' → failed [anthropic-not-configured], and nothing is sent to Anthropic',
        doc.status === 'failed' && /^\[anthropic-not-configured\]/.test(doc.statusError || '') && anthropicCalls().length === 0,
        doc.status + ' / ' + doc.statusError + ' / anthropic calls ' + anthropicCalls().length);
    }
  }

  console.log('\nCONSENT CHECK — two_party_verbal also reaches Claude with the key');
  {
    const { recordingId, docPath } = reset({ key: 'sk-ant-test', consentMode: 'two_party_verbal' });
    await run(recordingId);
    const doc = store.get(docPath) || {};
    ok('not quarantined on a false "consent check failed" (the bug quarantined every verbal-mode recording)',
      doc.status === 'complete', doc.status + ' / ' + doc.statusError);
    ok('two Anthropic calls (consent + analysis), both keyed',
      anthropicCalls().length === 2 && anthropicCalls().every(c => c.headers['x-api-key'] === 'sk-ant-test'));
  }

  console.log('\nSPEND GATES — still in front of the (now live) Claude call');
  {
    let r = reset({ key: 'sk-ant-test', flags: { voiceIntelDisabled: true } });
    let res = await run(r.recordingId);
    let doc = store.get(r.docPath) || {};
    ok('kill switch: skipped as voice_disabled', res && res.skipped === 'voice_disabled', JSON.stringify(res));
    ok('kill switch: no Groq and no Anthropic call', calls.length === 0, calls.map(c => c.url).join(', '));
    ok('kill switch: the doc says failed (the UI does not spin)', doc.status === 'failed');

    r = reset({ key: 'sk-ant-test', flags: { aiDisabled: true } });
    await run(r.recordingId);
    ok('aiDisabled alone does NOT stop voice (its own flag, by design in killswitch.js)',
      (store.get(r.docPath) || {}).status === 'complete');

    r = reset({ key: 'sk-ant-test', usedSec: 72000 }); // foundation cap = 72000
    res = await run(r.recordingId);
    doc = store.get(r.docPath) || {};
    ok('over budget: skipped as over_budget', res && res.skipped === 'over_budget', JSON.stringify(res));
    ok('over budget: no Groq and no Anthropic call', calls.length === 0, calls.map(c => c.url).join(', '));
    ok('over budget: statusError names the cap', /budget exhausted/.test(doc.statusError || ''));

    r = reset({ key: 'sk-ant-test', usedSec: 71999 });
    await run(r.recordingId);
    ok('one second under the cap still runs (the gate is a pre-check, not a reservation)',
      (store.get(r.docPath) || {}).status === 'complete' && groqCalls().length === 1);
  }

  console.log('\nTENANCY — the lead id in the Storage path is client-chosen');
  {
    const docsUnderLead = () => [...store.keys()].filter(k => k.startsWith('leads/' + LEAD + '/'));
    const usageDocs = () => [...store.keys()].filter(k => k.startsWith('api_usage_daily/'));

    let r = reset({ key: 'sk-ant-test', lead: { userId: 'u-other', companyId: 'co-other', firstName: 'Victim' } });
    let res = await run(r.recordingId);
    ok('another tenant\'s lead: skipped as lead_not_accessible', res && res.skipped === 'lead_not_accessible', JSON.stringify(res));
    ok('another tenant\'s lead: nothing written under that lead', docsUnderLead().length === 0, docsUnderLead().join(', '));
    ok('another tenant\'s lead: no Groq and no Anthropic call', calls.length === 0, calls.map(c => c.url).join(', '));
    ok('another tenant\'s lead: no usage counter touched', usageDocs().length === 0);

    r = reset({ key: 'sk-ant-test', flags: { voiceIntelDisabled: true }, lead: { userId: 'u-other', companyId: 'co-other' } });
    await run(r.recordingId);
    ok('kill switch on + another tenant\'s lead: the "disabled" doc is NOT planted there either',
      docsUnderLead().length === 0, docsUnderLead().join(', '));

    r = reset({ key: 'sk-ant-test', usedSec: 72000, lead: { userId: 'u-other', companyId: 'co-other' } });
    await run(r.recordingId);
    ok('over budget + another tenant\'s lead: the "budget exhausted" doc is NOT planted there either',
      docsUnderLead().length === 0, docsUnderLead().join(', '));

    r = reset({ key: 'sk-ant-test', lead: null });
    res = await run(r.recordingId);
    ok('no such lead: skipped, nothing written', res && res.skipped === 'lead_not_accessible' && docsUnderLead().length === 0);

    r = reset({ key: 'sk-ant-test', lead: { userId: 'u-teammate', companyId: 'co1', firstName: 'Sam' } });
    await run(r.recordingId);
    ok('a teammate\'s lead in the uploader\'s company still records to complete',
      (store.get(r.docPath) || {}).status === 'complete', JSON.stringify(store.get(r.docPath) || {}).slice(0, 120));

    const may = vi._uploaderMayRecordOn;
    ok('helper: own legacy lead with no companyId → yes', may({ userId: 'u1' }, 'u1', 'co1') === true);
    ok('helper: companyId null on both sides never matches', may({ userId: 'x', companyId: null }, 'u1', null) === false);
    ok('helper: solo operator (companyId = own uid) vs a lead in another company → no', may({ userId: 'x', companyId: 'coX' }, 'u1', 'u1') === false);
  }

  Module._load = realLoad;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
