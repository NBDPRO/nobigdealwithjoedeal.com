/**
 * tests/call-center-action-2026-10-01.test.js — callCenterAction, the Call
 * Center screen's server writes (functions/call-center.js callAction) and
 * phonePatchForLead. In-memory Firestore; names/numbers invented (555).
 *
 *   - who may act: owner, admin, same-company admin/manager — never a
 *     viewer, a sales rep, or another tenant
 *   - handled / unhandled
 *   - attach: tenant check, call filed, caller's number onto the lead
 *     (blanks only), timeline + task for a noted call, create-only task
 *
 * Run: node tests/call-center-action-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const { callAction, COLLECTION } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function fakeDb(seed) {
  const docs = new Map(Object.entries(seed));
  const mk = (p) => ({
    get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
    set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    create: async (v) => { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } docs.set(p, v); },
  });
  return { docs, doc: mk, collection: (n) => ({ doc: (id) => mk(n + '/' + id) }) };
}
const OWN = 'owner1';
const seed = () => ({
  [COLLECTION + '/cube_AAAAA1']: { userId: OWN, companyId: 'co1', phoneDigits: '5135550100', contactName: 'Example Claims', bucket: 'insurance', status: 'noted', startedAtMs: Date.parse('2026-09-29T15:00:00Z'), summary: 'Adjuster visit Tuesday.', promises: [{ who: 'jo', text: 'Send photos to the adjuster', due: '2026-10-03' }], followUpDate: '2026-10-03', urgent: false, direction: 'inbound' },
  [COLLECTION + '/cube_BBBBB2']: { userId: OWN, companyId: 'co1', phoneDigits: '5135550199', status: 'stored', bucket: 'unknown' },
  'leads/L1': { userId: OWN, companyId: 'co1', firstName: 'Pat', phone: '(513) 555-0111' },
  'leads/L2': { userId: OWN, companyId: 'co1', firstName: 'Sam', phone: '' },
  'leads/X1': { userId: 'other', companyId: 'co2', firstName: 'Not yours' },
});
const NOW = Date.parse('2026-10-01T15:00:00Z');
const run = async (db, auth, data) => { try { return { r: await callAction({ db, auth, data, nowMs: NOW }) }; } catch (e) { return { e }; } };

(async () => {
  console.log('\n1. phonePatchForLead');
  ok('empty phone → phone + phoneDigits', JSON.stringify(L.phonePatchForLead({ phone: '' }, '5135550100')) === JSON.stringify({ phone: '(513) 555-0100', phoneDigits: '5135550100' }));
  ok('phone taken → altPhone', JSON.stringify(L.phonePatchForLead({ phone: '513-555-0111' }, '5135550100')) === JSON.stringify({ altPhone: '(513) 555-0100' }));
  ok('already on the lead → null', L.phonePatchForLead({ phone: '513-555-0111', altPhone: '+1 513 555 0100' }, '5135550100') === null);
  ok('both taken → null (never overwrite)', L.phonePatchForLead({ phone: '5135550111', altPhone: '5135550122' }, '5135550100') === null);
  ok('no number → null', L.phonePatchForLead({ phone: '' }, '') === null);

  console.log('\n2. Who may act');
  let db = fakeDb(seed());
  const owner = { uid: OWN, token: {} };
  ok('signed out → unauthenticated', (await run(db, null, { id: 'cube_AAAAA1', action: 'handled' })).e.code === 'unauthenticated');
  ok('bad id → invalid-argument', (await run(db, owner, { id: '../x', action: 'handled' })).e.code === 'invalid-argument');
  ok('viewer refused', (await run(db, { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { id: 'cube_AAAAA1', action: 'handled' })).e.code === 'permission-denied');
  ok('same-company sales rep refused', (await run(db, { uid: 'r', token: { role: 'sales_rep', companyId: 'co1' } }, { id: 'cube_AAAAA1', action: 'handled' })).e.code === 'permission-denied');
  ok('other tenant manager refused', (await run(db, { uid: 'm2', token: { role: 'manager', companyId: 'co2' } }, { id: 'cube_AAAAA1', action: 'handled' })).e.code === 'permission-denied');
  ok('same-company manager allowed', !(await run(db, { uid: 'm', token: { role: 'manager', companyId: 'co1' } }, { id: 'cube_AAAAA1', action: 'handled' })).e);
  ok('unknown action refused', (await run(db, owner, { id: 'cube_AAAAA1', action: 'delete' })).e.code === 'invalid-argument');

  console.log('\n3. handled / unhandled');
  db = fakeDb(seed());
  await run(db, owner, { id: 'cube_AAAAA1', action: 'handled' });
  ok('handled stamps the time and who', db.docs.get(COLLECTION + '/cube_AAAAA1').handledAtMs === NOW && db.docs.get(COLLECTION + '/cube_AAAAA1').handledBy === OWN);
  await run(db, owner, { id: 'cube_AAAAA1', action: 'unhandled' });
  ok('unhandled clears it', db.docs.get(COLLECTION + '/cube_AAAAA1').handledAtMs === null);

  console.log('\n4. attach');
  db = fakeDb(seed());
  ok('another tenant\'s lead refused', (await run(db, owner, { id: 'cube_AAAAA1', action: 'attach', leadId: 'X1' })).e.code === 'permission-denied');
  ok('missing lead → not-found', (await run(db, owner, { id: 'cube_AAAAA1', action: 'attach', leadId: 'nope' })).e.code === 'not-found');
  const a = await run(db, owner, { id: 'cube_AAAAA1', action: 'attach', leadId: 'L1' });
  const c = db.docs.get(COLLECTION + '/cube_AAAAA1');
  ok('call filed on the customer', a.r.ok && c.leadId === 'L1' && c.bucket === 'customer');
  ok('caller number saved as altPhone (phone kept)', db.docs.get('leads/L1').altPhone === '(513) 555-0100' && db.docs.get('leads/L1').phone === '(513) 555-0111' && a.r.phoneAdded === true);
  ok('noted call → timeline entry', !!db.docs.get('leads/L1/activity/cube-cube_AAAAA1'));
  const t = db.docs.get('leads/L1/tasks/cube-cube_AAAAA1');
  ok('noted call with Jo\'s promise → follow-up task', t && /Send photos to the adjuster/.test(t.title) && t.dueDate === '2026-10-03');
  db.docs.set('leads/L1/tasks/cube-cube_AAAAA1', Object.assign({}, t, { done: true }));
  await run(db, owner, { id: 'cube_AAAAA1', action: 'attach', leadId: 'L1' });
  ok('re-attach never un-ticks the task', db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').done === true);
  await run(db, owner, { id: 'cube_BBBBB2', action: 'attach', leadId: 'L2' });
  ok('a not-yet-noted call files with no timeline or task (transcribe adds them later)', db.docs.get(COLLECTION + '/cube_BBBBB2').leadId === 'L2' && !db.docs.has('leads/L2/activity/cube-cube_BBBBB2') && !db.docs.has('leads/L2/tasks/cube-cube_BBBBB2'));
  db.docs.set(COLLECTION + '/cube_CCCCC3', { userId: OWN, companyId: 'co1', phoneDigits: '5135550177', status: 'noted', startedAtMs: Date.parse('2026-07-01T15:00:00Z'), summary: 'Old call.', promises: [{ who: 'jo', text: 'Old promise', due: '2026-07-02' }] });
  await run(db, owner, { id: 'cube_CCCCC3', action: 'attach', leadId: 'L1' });
  ok('attaching an OLD noted call files the timeline entry but no stale task', !!db.docs.get('leads/L1/activity/cube-cube_CCCCC3') && !db.docs.has('leads/L1/tasks/cube-cube_CCCCC3'));
  ok('empty phone filled with the caller\'s number', db.docs.get('leads/L2').phone === '(513) 555-0199');

  console.log('\n5. notpersonal');
  db = fakeDb(seed());
  db.docs.set(COLLECTION + '/cube_PPPPP4', { userId: OWN, companyId: 'co1', status: 'personal', storagePath: null, audioRemoved: 'personal', driveFileId: 'DRV123', fileName: 'x ↗.m4a', ymd: '2026-09-30', summary: 'Personal call.', callType: 'personal' });
  const saved = [];
  M._test.setActionDeps({ download: async (id) => Buffer.from('audio:' + id), bucket: { file: (p) => ({ save: async (b) => { saved.push([p, String(b)]); } }) } });
  ok('only a personal call can be redone', (await run(db, owner, { id: 'cube_AAAAA1', action: 'notpersonal' })).e.code === 'failed-precondition');
  ok('a viewer cannot redo it', (await run(db, { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { id: 'cube_PPPPP4', action: 'notpersonal' })).e.code === 'permission-denied');
  const np = await run(db, owner, { id: 'cube_PPPPP4', action: 'notpersonal' });
  const pd = db.docs.get(COLLECTION + '/cube_PPPPP4');
  ok('re-copied from Drive into the private calls path', np.r && np.r.requeued && saved.length === 1 && saved[0][0] === 'calls/' + OWN + '/cube-acr/2026-09-30/cube_DRV123.m4a' && saved[0][1] === 'audio:DRV123');
  ok('back in the queue, marked not-personal', pd.status === 'stored' && pd.storagePath === saved[0][0] && pd.notPersonal === true && pd.audioRemoved === null && pd.transcribeAttempts === 0);
  M._test.setActionDeps({});

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
