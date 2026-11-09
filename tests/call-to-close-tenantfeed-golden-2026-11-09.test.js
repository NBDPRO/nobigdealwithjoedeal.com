/**
 * tests/call-to-close-tenantfeed-golden-2026-11-09.test.js — Call to Close P2,
 * multi-tenant call feed (design §3.3, §9 P2; Q6).
 *
 * NBD's call pipeline must stay BYTE-IDENTICAL while the feed learns other
 * tenants. This pins one full NBD pass (functions/call-center.js runIngest,
 * then runTranscribe) against a stubbed Drive, transcriber and model, and an
 * in-memory Firestore / bucket:
 *   - every Firestore write, in order, with its data (call docs, the lead's
 *     timeline entry, the follow-up task, lastContactedAt, suggestions,
 *     re-read caller facts, the urgent push's bell, the config doc)
 *   - every Drive request, every Storage save / delete
 *   - every model request: system prompt, user prompt and feature, verbatim
 *   - every push
 * The fixture (tests/fixtures/call-feed-nbd-golden-2026-11-09.json) was
 * written by this file at d1f7bfe0c, before the feed changed. Regenerate only
 * with Jo's OK: UPDATE_GOLDEN=1 node tests/call-to-close-tenantfeed-golden-2026-11-09.test.js
 *
 * Regenerated 2026-11-09 when Jo's viewer follow-ups (Q11, approved) joined P2:
 * one field moved, writes[17].data.notes, the follow-up task's first line is now
 * "The summary is on the customer's timeline." instead of "Call: <summary>", so a
 * viewer reading tasks never sees call content. Every other write, Drive request,
 * Storage call, model prompt and push is byte-identical to the d1f7bfe0c fixture.
 *
 * It runs twice: once as before (no multi-tenant env), once with
 * CALL_CENTER_MULTI_TENANT_ENABLED=true and an enabled tenant config sitting
 * in Firestore; NBD's own pass must write exactly the same either way.
 *
 * Run: node tests/call-to-close-tenantfeed-golden-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const { fakeDb, fakeBucket, fakeDrive, clone } = require('./lib/call-center-fakes');
const { runIngest, runTranscribe, setClient, setDeps, OWNER } = M._test;

const FIXTURE = path.join(__dirname, 'fixtures', 'call-feed-nbd-golden-2026-11-09.json');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const NOW = Date.parse('2026-10-01T16:00:00Z'); // noon ET, inside watch hours

function seed(extra) {
  return Object.assign({
    ['leads/lead1']: { companyId: OWNER, userId: OWNER, firstName: 'Pat', lastName: 'Example', phone: '(812) 555-0113' },
    ['leads/lead2']: { companyId: OWNER, userId: OWNER, firstName: 'Dana', lastName: 'Rivers', address: '412 Oak Hill Dr, Florence, KY 41042', phone: '(859) 555-0177' },
    ['companies/' + OWNER + '/contact_labels/5135550199']: { kind: 'personal', policy: 'hide', capture: 'off' },
    // Noted before caller facts existed: re-read (FACTS_SYSTEM) and re-scored.
    ['phone_calls/cube_old1']: { userId: OWNER, companyId: OWNER, status: 'noted', leadId: null, transcript: 'Hi this is Sam Lee on Elm Street in Erlanger, about the siding.', startedAtMs: NOW - 5 * 86400e3, direction: 'inbound', phoneDigits: '8595550150' },
  }, extra || {});
}

function drive() {
  const side = (ms) => JSON.stringify({ duration: String(ms), loc: '39.1;-84.2', addr: '1 Secret Ln' });
  return fakeDrive({
    nbdroot: {
      name: 'Cube ACR',
      days: {
        '2026-09-30': [
          { id: 'f1', name: '2026-09-30 10-00-00 (phone) Pat Example NBD Customer (+1 812-555-0113) ↗.m4a', size: '400000' },
          { id: 's1', name: '2026-09-30 10-00-00 (phone) Pat Example NBD Customer (+1 812-555-0113) ↗.json', size: '160', mimeType: 'application/json', sidecar: side(95000) },
          { id: 'f2', name: '2026-09-30 11-00-00 (phone) +1 800-555-1370 ↙.m4a', size: '3000' },
          { id: 's2', name: '2026-09-30 11-00-00 (phone) +1 800-555-1370 ↙.json', size: '150', mimeType: 'application/json', sidecar: side(8000) },
        ],
        '2026-10-01': [
          { id: 'f3', name: '2026-10-01 09-00-00 (phone) +1 513-555-0199 ↙.m4a', size: '5000' },
          { id: 'f4', name: '2026-10-01 09-30-00 (phone) +1 937-555-0142 ↙.m4a', size: '300000' },
          { id: 'f5', name: '2026-10-01 10-15-00 (phone) Mom (+1 614-555-0123) ↗.m4a', size: '200000' },
          { id: 'n1', name: 'desktop.ini', size: '10', mimeType: 'text/plain' },
        ],
      },
    },
  });
}

async function nbdPass({ multiTenant }) {
  const env = { CALL_WATCH_ENABLED: process.env.CALL_WATCH_ENABLED, CALL_CENTER_MULTI_TENANT_ENABLED: process.env.CALL_CENTER_MULTI_TENANT_ENABLED };
  process.env.CALL_WATCH_ENABLED = 'true';
  if (multiTenant) process.env.CALL_CENTER_MULTI_TENANT_ENABLED = 'true'; else delete process.env.CALL_CENTER_MULTI_TENANT_ENABLED;
  const extra = multiTenant ? {
    // Another tenant, fully enabled: NBD's pass must not see it.
    'integrations/callCenter_coAcme0000000000000001': { kind: 'callCenterTenant', companyId: 'coAcme0000000000000001', enabled: true, ownerUid: 'uAcmeOwner00000000000001', folderId: 'acmeFolder0001' },
    'companies/coAcme0000000000000001': { ownerId: 'uAcmeOwner00000000000001' },
    'companyProfile/coAcme0000000000000001': { companyName: 'Acme Exteriors', serviceArea: 'Dayton, OH' },
  } : {};
  const db = fakeDb(seed(extra));
  const bucket = fakeBucket();
  const dr = drive();
  setClient(dr);
  const model = [];
  const pushes = [];
  setDeps({
    transcribe: async (buf) => {
      const p = String(buf);
      const text = /cube_f1/.test(p) ? 'Hi Jo, water is coming through the ceiling right now. Can you come today? I will send the quote by Friday.'
        : /cube_f4/.test(p) ? 'Hi, this is Dana Rivers on Oak Hill Drive in Florence, I need a roof inspection.'
          : 'Hey honey, what time is dinner?';
      return { text, durationSec: 60, segments: [{ start: 0, end: 5, text: text.slice(0, 20), avg_logprob: -0.2 }] };
    },
    notes: async ({ system, prompt, feature, maxTokens }) => {
      model.push({ system, prompt, feature, maxTokens: maxTokens || null });
      if (feature === 'call-center-facts') return { caller_name: 'Sam Lee', street: 'Elm Street', town: 'Erlanger', service: 'siding' };
      if (/ceiling/.test(prompt)) return { call_type: 'customer', summary: 'Active leak; Jo will come today and send a quote by Friday.', promises: [{ who: 'jo', text: 'Send the quote', due: '2026-10-03' }], follow_up_date: '2026-10-02', urgent: true };
      if (/Dana Rivers/.test(prompt)) return { call_type: 'lead', summary: 'Dana wants a roof inspection.', promises: [], follow_up_date: null, urgent: false, caller_name: 'Dana Rivers', street: 'Oak Hill Drive', town: 'Florence', service: 'roof' };
      return { call_type: 'personal', summary: 'x', promises: [], follow_up_date: null, urgent: false };
    },
    push: async (uid, title, body, data) => { pushes.push({ uid, title, body, data }); return { sent: 1 }; },
  });
  const ingest = await runIngest({ db, bucket, live: true, nowMs: NOW });
  const transcribe = await runTranscribe({ db, bucket, live: true, nowMs: NOW });
  process.env.CALL_WATCH_ENABLED = env.CALL_WATCH_ENABLED; if (env.CALL_WATCH_ENABLED === undefined) delete process.env.CALL_WATCH_ENABLED;
  if (env.CALL_CENTER_MULTI_TENANT_ENABLED === undefined) delete process.env.CALL_CENTER_MULTI_TENANT_ENABLED; else process.env.CALL_CENTER_MULTI_TENANT_ENABLED = env.CALL_CENTER_MULTI_TENANT_ENABLED;
  return clone({
    ingest, transcribe,
    writes: db.log,
    storageSaved: [...bucket.saved.entries()],
    storageDeleted: bucket.deleted,
    drive: dr.requests,
    model, pushes,
  });
}

const digest = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

function firstDiff(a, b, at) {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], at + '.' + k);
      if (d) return d;
    }
  }
  return at + ': ' + JSON.stringify(a).slice(0, 300) + '  !=  ' + JSON.stringify(b).slice(0, 300);
}

(async () => {
  const plain = await nbdPass({ multiTenant: false });
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.writeFileSync(FIXTURE, JSON.stringify(plain, null, 2) + '\n');
    console.log('wrote ' + FIXTURE + ' sha256 ' + digest(plain));
    return;
  }
  const golden = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  console.log('\n1. The golden pass is a real one (the fixture is not trivially empty)');
  const paths = golden.writes.map((w) => w.path);
  ok('filed the customer call, the label-off row and the unknown call', ['phone_calls/cube_f1', 'phone_calls/cube_f3', 'phone_calls/cube_f4'].every((p) => paths.includes(p)), paths.join(' '));
  ok('timeline entry + follow-up task on the matched lead', paths.includes('leads/lead1/activity/cube-cube_f1') && paths.includes('leads/lead1/tasks/cube-cube_f1'));
  ok('the urgent call pushed to the NBD owner', golden.pushes.length === 1 && golden.pushes[0].uid === OWNER);
  ok('model saw the notes prompt (x3) and the facts prompt (x1)', golden.model.filter((m) => m.feature === 'call-center-notes').length === 3 && golden.model.filter((m) => m.feature === 'call-center-facts').length === 1, JSON.stringify(golden.model.map((m) => m.feature)));
  ok('the prompts name NBD', golden.model.every((m) => /No Big Deal Home Solutions/.test(m.system)));
  ok('the personal call\'s CRM audio copy was deleted', golden.storageDeleted.length === 1);

  console.log('\n2. NBD today == the golden fixture, byte for byte');
  ok('whole pass identical (sha256 ' + digest(golden).slice(0, 12) + ')', JSON.stringify(plain) === JSON.stringify(golden), firstDiff(plain, golden, '$'));
  ok('system prompts identical', JSON.stringify(plain.model.map((m) => m.system)) === JSON.stringify(golden.model.map((m) => m.system)));
  ok('user prompts identical', JSON.stringify(plain.model.map((m) => m.prompt)) === JSON.stringify(golden.model.map((m) => m.prompt)));

  console.log('\n3. Multi-tenant switched on with another tenant enabled: NBD\'s pass is unchanged');
  const mt = await nbdPass({ multiTenant: true });
  ok('whole NBD pass identical', JSON.stringify(mt) === JSON.stringify(golden), firstDiff(mt, golden, '$'));
  ok('nothing written for the other tenant by NBD\'s pass', !JSON.stringify(mt.writes).includes('coAcme') && !JSON.stringify(mt.writes).includes('uAcmeOwner'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
