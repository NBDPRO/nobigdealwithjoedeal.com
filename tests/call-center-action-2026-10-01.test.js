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

  console.log('\n4b. A day of texts (txt_…)');
  db = fakeDb(seed());
  db.docs.set('phone_text_days/txt_5135550100_20261001', { userId: OWN, companyId: 'co1', status: 'noted', promises: [{ who: 'jo', text: 'Send the quote' }], startedAtMs: NOW });
  await run(db, owner, { id: 'txt_5135550100_20261001', action: 'handled' });
  ok('Handled works on a day of texts (phone_text_days)', db.docs.get('phone_text_days/txt_5135550100_20261001').handledAtMs === NOW);
  ok('attach is refused for texts (the text ingest matches them)', (await run(db, owner, { id: 'txt_5135550100_20261001', action: 'attach', leadId: 'L1' })).e.code === 'invalid-argument');
  ok('another tenant cannot touch a text day', (await run(db, { uid: 'm2', token: { role: 'manager', companyId: 'co2' } }, { id: 'txt_5135550100_20261001', action: 'handled' })).e.code === 'permission-denied');
  ok('a malformed txt id is refused', (await run(db, owner, { id: 'txt_../x', action: 'handled' })).e.code === 'invalid-argument');

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

  console.log('\n6. The "Said you\'d do" deck: taskDone / snooze (2026-10-03)');
  db = fakeDb(seed());
  // cube_AAAAA1 filed on L1 with an open follow-up task (due 10-03).
  db.docs.set(COLLECTION + '/cube_AAAAA1', Object.assign({}, db.docs.get(COLLECTION + '/cube_AAAAA1'), { leadId: 'L1' }));
  db.docs.set('leads/L1/tasks/cube-cube_AAAAA1', { title: 'Send photos', done: false, dueDate: '2026-10-03' });
  const done = await run(db, owner, { id: 'cube_AAAAA1', action: 'taskDone' });
  const tk = db.docs.get('leads/L1/tasks/cube-cube_AAAAA1');
  ok('taskDone ticks the follow-up task the way the customer page does', done.r && done.r.done === true && tk.done === true && !!tk.completedAt);
  await run(db, owner, { id: 'cube_AAAAA1', action: 'taskUndone' });
  ok('taskUndone un-ticks it (the deck\'s Undo)', db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').done === false && db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').completedAt === null);
  ok('taskDone on a call with no task says to mark it handled', (await run(db, owner, { id: 'cube_BBBBB2', action: 'taskDone' })).e.code === 'failed-precondition');
  const sz = await run(db, owner, { id: 'cube_AAAAA1', action: 'snooze', days: 3 });
  const st = db.docs.get('leads/L1/tasks/cube-cube_AAAAA1');
  ok('snooze moves the task\'s due date N days from today and remembers the old one', sz.r.on === 'task' && st.dueDate === '2026-10-04' && st.snoozedFromDue === '2026-10-03', JSON.stringify(st));
  await run(db, owner, { id: 'cube_AAAAA1', action: 'snooze', days: 7 });
  ok('snoozing again keeps the ORIGINAL due date for undo', db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').snoozedFromDue === '2026-10-03' && db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').dueDate === '2026-10-08');
  await run(db, owner, { id: 'cube_AAAAA1', action: 'unsnooze' });
  ok('unsnooze puts the original due date back', db.docs.get('leads/L1/tasks/cube-cube_AAAAA1').dueDate === '2026-10-03');
  db.docs.set(COLLECTION + '/cube_NOFIL5', { userId: OWN, companyId: 'co1', phoneDigits: '5135550155', status: 'noted', startedAtMs: NOW, promises: [{ who: 'jo', text: 'Email photos' }] });
  const nz = await run(db, owner, { id: 'cube_NOFIL5', action: 'snooze', days: 1 });
  ok('a call with no customer is snoozed on the call itself', nz.r.on === 'call' && db.docs.get(COLLECTION + '/cube_NOFIL5').snoozeUntilYmd === '2026-10-02');
  await run(db, owner, { id: 'cube_NOFIL5', action: 'unsnooze' });
  ok('…and unsnooze clears it', db.docs.get(COLLECTION + '/cube_NOFIL5').snoozeUntilYmd === null);
  ok('snooze days are bounded (1–30)', (await run(db, owner, { id: 'cube_NOFIL5', action: 'snooze', days: 0 })).e.code === 'invalid-argument'
    && (await run(db, owner, { id: 'cube_NOFIL5', action: 'snooze', days: 99 })).e.code === 'invalid-argument');
  ok('a viewer cannot snooze or tick', (await run(db, { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { id: 'cube_NOFIL5', action: 'snooze', days: 1 })).e.code === 'permission-denied');
  db.docs.set('phone_text_days/txt_5135550100_20261001', { userId: OWN, companyId: 'co1', status: 'noted', leadId: 'L1', startedAtMs: NOW, promises: [{ who: 'jo', text: 'Send the quote' }] });
  db.docs.set('leads/L1/tasks/sms-txt_5135550100_20261001', { done: false, dueDate: '2026-10-01' });
  await run(db, owner, { id: 'txt_5135550100_20261001', action: 'taskDone' });
  ok('a texted promise\'s task (sms-…) ticks too', db.docs.get('leads/L1/tasks/sms-txt_5135550100_20261001').done === true);

  console.log('\n7. callPromisesList — who may read the deck');
  const { promisesList, OWNER: REAL_OWNER } = M._test;
  const lr = async (auth) => { try { return { r: await promisesList({ db: { collection: () => ({ where: function () { return this; }, orderBy: function () { return this; }, limit: function () { return this; }, get: async () => ({ forEach: () => {} }) }), getAll: async () => [] }, auth, nowMs: NOW }) }; } catch (e) { return { e }; } };
  ok('signed out → unauthenticated', (await lr(null)).e.code === 'unauthenticated');
  ok('a viewer, a manager or a rep is refused (the owner\'s calls)', (await lr({ uid: 'v', token: { role: 'viewer' } })).e.code === 'permission-denied'
    && (await lr({ uid: 'm', token: { role: 'manager', companyId: 'co1' } })).e.code === 'permission-denied');
  const lo = await lr({ uid: REAL_OWNER, token: {} });
  ok('the owner gets the list (empty here) with counts', lo.r && Array.isArray(lo.r.items) && lo.r.counts.items === 0);
  ok('a platform admin gets it too', !!(await lr({ uid: 'adm', token: { role: 'admin' } })).r);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
