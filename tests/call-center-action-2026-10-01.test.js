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

// Equality queries (Firestore semantics: == null never matches a missing
// field), batches and deletes, enough for attach's re-file, move and the
// tagged-contacts match.
function fakeDb(seed) {
  const docs = new Map(Object.entries(seed));
  const mk = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
    set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    create: async (v) => { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } docs.set(p, v); },
    delete: async () => { docs.delete(p); },
  });
  const query = (name, filters, lim) => ({
    where: (f, op, v) => query(name, filters.concat([[f, op, v]]), lim),
    orderBy: () => query(name, filters, lim),
    limit: (n) => query(name, filters, n),
    get: async () => {
      const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2
        && filters.every(([f, op, val]) => op === '==' && Object.prototype.hasOwnProperty.call(v, f) && v[f] === val)).slice(0, lim || 1e9)
        .map(([k, v]) => ({ id: k.split('/')[1], ref: mk(k), exists: true, data: () => v }));
      return { docs: rows, size: rows.length, forEach: (fn) => rows.forEach(fn) };
    },
  });
  return {
    docs, doc: mk,
    collection: (n) => Object.assign(query(n, [], null), { doc: (id) => mk(n + '/' + id) }),
    batch: () => { const ops = []; return { set: (ref, v, o) => ops.push(() => ref.set(v, o)), commit: async () => { for (const f of ops) await f(); } }; },
  };
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

  console.log('\n8. attach re-files every unfiled call + text from that number (2026-10-03)');
  const NUM = '5135550100';
  const rseed = () => Object.assign(seed(), {
    // Earlier calls from the same number, filed on nobody at ingest.
    [COLLECTION + '/cube_SIB001']: { userId: OWN, companyId: 'co1', phoneDigits: NUM, leadId: null, status: 'noted', startedAtMs: NOW - 86400e3, direction: 'outbound', contactName: 'Example Claims', summary: 'Left a voicemail.', promises: [{ who: 'jo', text: 'Call the adjuster back', due: '2026-10-02' }], followUpDate: null, urgent: false },
    [COLLECTION + '/cube_SIB002']: { userId: OWN, companyId: 'co1', phoneDigits: NUM, leadId: null, status: 'stored' },
    // Same number, already on ANOTHER customer: never moved.
    [COLLECTION + '/cube_SIB003']: { userId: OWN, companyId: 'co1', phoneDigits: NUM, leadId: 'L2', status: 'noted', startedAtMs: NOW - 2 * 86400e3, summary: 'x', promises: [] },
    // Same number, another tenant: never touched.
    [COLLECTION + '/cube_SIB004']: { userId: 'other', companyId: 'co2', phoneDigits: NUM, leadId: null, status: 'noted', startedAtMs: NOW, summary: 'x', promises: [] },
    // A different number: never touched.
    [COLLECTION + '/cube_SIB005']: { userId: OWN, companyId: 'co1', phoneDigits: '5135550142', leadId: null, status: 'noted', startedAtMs: NOW, summary: 'x', promises: [] },
    'phone_text_days/txt_5135550100_20260930': { userId: OWN, companyId: 'co1', channel: 'text', phoneDigits: NUM, leadId: null, status: 'noted', startedAtMs: NOW - 3600e3, messageCount: 3, contactName: 'Example Claims', summary: 'Texted the claim number.', promises: [{ who: 'jo', text: 'Text the photos', due: null }], followUpDate: '2026-10-01', urgent: false },
    'phone_texts/sms_T1': { userId: OWN, companyId: 'co1', phoneDigits: NUM, leadId: null, body: 'claim # is 123' },
    'phone_texts/sms_T2': { userId: OWN, companyId: 'co1', phoneDigits: NUM, leadId: null, body: 'thanks' },
    'phone_texts/sms_T3': { userId: OWN, companyId: 'co1', phoneDigits: '5135550142', leadId: null, body: 'not them' },
    'phone_texts/sms_T4': { userId: 'other', companyId: 'co2', phoneDigits: NUM, leadId: null, body: 'other tenant' },
  });
  db = fakeDb(rseed());
  const ra = await run(db, owner, { id: 'cube_AAAAA1', action: 'attach', leadId: 'L1' });
  const sib = (k) => db.docs.get(COLLECTION + '/' + k);
  ok('the attached call itself is filed', sib('cube_AAAAA1').leadId === 'L1');
  ok('an earlier noted call from the number is re-filed on the lead', sib('cube_SIB001').leadId === 'L1' && sib('cube_SIB001').bucket === 'customer' && sib('cube_SIB001').refiledFrom === 'cube_AAAAA1', JSON.stringify(sib('cube_SIB001')));
  ok('…with the same timeline entry the notes pass writes', JSON.stringify(Object.assign({}, db.docs.get('leads/L1/activity/cube-cube_SIB001'), { createdAt: 0 }))
    === JSON.stringify(Object.assign(L.buildCallActivity({ call: Object.assign({}, sib('cube_SIB001'), { id: 'cube_SIB001' }), notes: { summary: 'Left a voicemail.', promises: [{ who: 'jo', text: 'Call the adjuster back', due: '2026-10-02' }], followUpDate: null, urgent: false }, ownerUid: OWN }), { createdAt: 0 })));
  ok('…and the same follow-up task', db.docs.get('leads/L1/tasks/cube-cube_SIB001') && /Call the adjuster back/.test(db.docs.get('leads/L1/tasks/cube-cube_SIB001').title) && db.docs.get('leads/L1/tasks/cube-cube_SIB001').leadId === 'L1');
  ok('a not-yet-noted call is filed (the notes pass adds its entry later)', sib('cube_SIB002').leadId === 'L1' && !db.docs.has('leads/L1/activity/cube-cube_SIB002'));
  ok('a call already on another customer stays there', sib('cube_SIB003').leadId === 'L2' && !db.docs.has('leads/L1/activity/cube-cube_SIB003'));
  ok('another tenant\'s call from the same number is untouched', sib('cube_SIB004').leadId === null);
  ok('a different number is untouched', sib('cube_SIB005').leadId === null);
  const tday = db.docs.get('phone_text_days/txt_5135550100_20260930');
  ok('the number\'s unfiled day of texts is re-filed', tday.leadId === 'L1');
  ok('…with the text timeline entry + task text notes write', !!db.docs.get('leads/L1/activity/sms-txt_5135550100_20260930') && db.docs.get('leads/L1/activity/sms-txt_5135550100_20260930').label === 'Texts · Example Claims (3)'
    && db.docs.get('leads/L1/tasks/sms-txt_5135550100_20260930') && db.docs.get('leads/L1/tasks/sms-txt_5135550100_20260930').source === 'sms-backup');
  ok('the texts themselves move onto the lead (customer page thread)', db.docs.get('phone_texts/sms_T1').leadId === 'L1' && db.docs.get('phone_texts/sms_T2').leadId === 'L1');
  ok('…not another number\'s or another tenant\'s', db.docs.get('phone_texts/sms_T3').leadId === null && db.docs.get('phone_texts/sms_T4').leadId === null);
  ok('the result counts what was re-filed', ra.r && JSON.stringify(ra.r.refiled) === JSON.stringify({ calls: 2, textDays: 1, texts: 2 }), JSON.stringify(ra.r && ra.r.refiled));
  // Idempotent: Jo ticks the re-filed task, then attaches again.
  db.docs.set('leads/L1/tasks/cube-cube_SIB001', Object.assign({}, db.docs.get('leads/L1/tasks/cube-cube_SIB001'), { done: true }));
  const before8 = db.docs.size;
  const rb = await run(db, owner, { id: 'cube_AAAAA1', action: 'attach', leadId: 'L1' });
  ok('a second attach re-files nothing and creates nothing', JSON.stringify(rb.r.refiled) === JSON.stringify({ calls: 0, textDays: 0, texts: 0 }) && db.docs.size === before8);
  ok('…and never un-ticks a re-filed task', db.docs.get('leads/L1/tasks/cube-cube_SIB001').done === true);

  console.log('\n9. move — "Wrong customer → move to…" (2026-10-03)');
  const mseed = () => Object.assign(seed(), {
    [COLLECTION + '/cube_MOVE01']: { userId: OWN, companyId: 'co1', phoneDigits: '5135550166', leadId: 'L1', bucket: 'customer', status: 'noted', startedAtMs: NOW - 3600e3, direction: 'inbound', contactName: 'Sam', summary: 'Asked for a siding quote.', promises: [{ who: 'jo', text: 'Send the siding quote', due: '2026-10-02' }] },
    'leads/L1/activity/cube-cube_MOVE01': { type: 'call', phoneCallId: 'cube_MOVE01', summary: 'Asked for a siding quote.', userId: OWN, companyId: OWN },
    'leads/L1/tasks/cube-cube_MOVE01': { leadId: 'L1', title: 'Send the siding quote (Sam)', done: false, dueDate: '2026-10-02', phoneCallId: 'cube_MOVE01' },
    'leads/L1/activity/other-entry': { type: 'note', text: 'unrelated' },
    'leads/Y1': { userId: OWN, companyId: 'co1', firstName: 'Deleted', deleted: true },
  });
  db = fakeDb(mseed());
  const snap9 = () => JSON.stringify([...db.docs.entries()].sort());
  let s9 = snap9();
  ok('a viewer cannot move', (await run(db, { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { id: 'cube_MOVE01', action: 'move', leadId: 'L2' })).e.code === 'permission-denied' && snap9() === s9);
  ok('another company\'s lead is refused, nothing written', (await run(db, owner, { id: 'cube_MOVE01', action: 'move', leadId: 'X1' })).e.code === 'permission-denied' && snap9() === s9);
  ok('a deleted lead is refused', (await run(db, owner, { id: 'cube_MOVE01', action: 'move', leadId: 'Y1' })).e.code === 'not-found' && snap9() === s9);
  ok('a bad lead id is refused', (await run(db, owner, { id: 'cube_MOVE01', action: 'move', leadId: 'a/b' })).e.code === 'invalid-argument');
  ok('a call on no customer is attached, not moved', (await run(db, owner, { id: 'cube_BBBBB2', action: 'move', leadId: 'L2' })).e.code === 'failed-precondition');
  const mv = await run(db, owner, { id: 'cube_MOVE01', action: 'move', leadId: 'L2' });
  const mc = db.docs.get(COLLECTION + '/cube_MOVE01');
  ok('the call now names the chosen customer', mv.r && mv.r.moved === true && mc.leadId === 'L2' && mc.movedFromLeadId === 'L1' && mc.movedBy === OWN, JSON.stringify(mc));
  ok('its timeline entry moved (gone from the wrong customer)', !db.docs.has('leads/L1/activity/cube-cube_MOVE01') && db.docs.get('leads/L2/activity/cube-cube_MOVE01').summary === 'Asked for a siding quote.');
  ok('its open task moved and points at the new lead', !db.docs.has('leads/L1/tasks/cube-cube_MOVE01') && db.docs.get('leads/L2/tasks/cube-cube_MOVE01').leadId === 'L2' && db.docs.get('leads/L2/tasks/cube-cube_MOVE01').done === false);
  ok('the wrong customer\'s other timeline entries are untouched', !!db.docs.get('leads/L1/activity/other-entry'));
  ok('the caller\'s number goes onto the new lead (blank phone)', db.docs.get('leads/L2').phone === '(513) 555-0166' && mv.r.phoneAdded === true);
  s9 = snap9();
  ok('moving to where it already is changes nothing', (await run(db, owner, { id: 'cube_MOVE01', action: 'move', leadId: 'L2' })).r.moved === false && snap9() === s9);
  // A call filed on another company's lead (bad data) can't be moved out by this tenant.
  db.docs.set(COLLECTION + '/cube_MOVE02', { userId: OWN, companyId: 'co1', phoneDigits: '5135550167', leadId: 'X1', status: 'stored' });
  ok('a call whose current lead is in another company is refused', (await run(db, owner, { id: 'cube_MOVE02', action: 'move', leadId: 'L2' })).e.code === 'permission-denied');
  // Retry after a half-finished move (entry + task already copied, call not yet re-pointed).
  db = fakeDb(mseed());
  db.docs.set('leads/L2/tasks/cube-cube_MOVE01', { leadId: 'L2', title: 'Send the siding quote (Sam)', done: true });
  await run(db, owner, { id: 'cube_MOVE01', action: 'move', leadId: 'L2' });
  ok('a retried move finishes and never un-ticks the task already on the new lead', db.docs.get(COLLECTION + '/cube_MOVE01').leadId === 'L2' && db.docs.get('leads/L2/tasks/cube-cube_MOVE01').done === true && !db.docs.has('leads/L1/tasks/cube-cube_MOVE01'));

  console.log('\n10. "Match my tagged contacts" — preview, then write only what Jo confirms');
  const { taggedMatch } = M._test;
  const tm = async (d, auth, data) => { try { return { r: await taggedMatch({ db: d, auth, data, nowMs: NOW }) }; } catch (e) { return { e }; } };
  const O = REAL_OWNER;
  const tcall = (extra) => Object.assign({ userId: O, companyId: O, leadId: null, bucket: 'contact', savedContact: true, tags: ['customer'], status: 'noted', startedAtMs: NOW - 3600e3, summary: 's', promises: [] }, extra);
  const tseed = () => ({
    'leads/TL1': { userId: O, companyId: O, firstName: 'Dana', lastName: 'Rivers', phone: '(513) 555-0301' },
    'leads/TL2': { userId: O, companyId: O, firstName: 'Lee', lastName: 'Okafor', phone: '' },
    'leads/TL3': { userId: O, companyId: O, firstName: 'Old', lastName: 'Gone', phone: '5135550309', deleted: true },
    [COLLECTION + '/cube_TAG001']: tcall({ phoneDigits: '5135550301', contactName: 'Dana R', startedAtMs: NOW - 1000 }),
    [COLLECTION + '/cube_TAG002']: tcall({ phoneDigits: '5135550301', contactName: 'Dana R', startedAtMs: NOW - 2000 }),
    [COLLECTION + '/cube_TAG003']: tcall({ phoneDigits: '5135550302', contactName: 'Lee Okafor' }),
    [COLLECTION + '/cube_TAG004']: tcall({ phoneDigits: '5135550303', contactName: 'Morgan New' }),
    [COLLECTION + '/cube_TAG005']: tcall({ phoneDigits: '5135550304', contactName: 'Untagged Friend', tags: [] }),
    [COLLECTION + '/cube_TAG006']: tcall({ phoneDigits: '5135550309', contactName: 'Was A Lead' }),
  });
  db = fakeDb(tseed());
  ok('a manager is refused (the owner\'s phone)', (await tm(db, { uid: 'm', token: { role: 'manager', companyId: O } }, {})).e.code === 'permission-denied');
  ok('signed out is refused', (await tm(db, null, {})).e.code === 'unauthenticated');
  const s10 = JSON.stringify([...db.docs.entries()].sort());
  const pv = (await tm(db, { uid: O, token: {} }, {})).r;
  ok('preview writes nothing', JSON.stringify([...db.docs.entries()].sort()) === s10);
  const byK = (rows, k) => rows.find((x) => x.key === k);
  ok('a tagged number on a lead matches it (2 calls, one row)', byK(pv.matches, 'num:5135550301') && byK(pv.matches, 'num:5135550301').leadId === 'TL1' && byK(pv.matches, 'num:5135550301').callIds.length === 2, JSON.stringify(pv));
  ok('a tagged contact named like one lead matches by name', byK(pv.matches, 'num:5135550302') && byK(pv.matches, 'num:5135550302').leadId === 'TL2' && /name/.test(byK(pv.matches, 'num:5135550302').why));
  ok('a tagged contact on no lead is "not in the CRM yet"', !!byK(pv.notInCrm, 'num:5135550303') && pv.notInCrm.length === 2);
  ok('a deleted lead is never a match', !byK(pv.matches, 'num:5135550309') && !!byK(pv.notInCrm, 'num:5135550309'));
  ok('an untagged contact is left out', !byK(pv.matches, 'num:5135550304') && !byK(pv.notInCrm, 'num:5135550304'));
  // Confirm one row; a row whose lead doesn't match the fresh plan is skipped.
  const cf = (await tm(db, { uid: O, token: {} }, { confirm: [{ key: 'num:5135550301', leadId: 'TL1' }, { key: 'num:5135550302', leadId: 'TL1' }, { key: 'num:5135550303', leadId: 'TL1' }] })).r;
  ok('only the confirmed, still-matching row is filed', cf.filed === 1 && cf.skipped === 2 && cf.calls === 2, JSON.stringify(cf));
  ok('both of that number\'s calls are on the lead', sib('cube_TAG001').leadId === 'TL1' && sib('cube_TAG002').leadId === 'TL1');
  ok('the skipped rows are untouched', sib('cube_TAG003').leadId === null && sib('cube_TAG004').leadId === null);
  const cf2 = (await tm(db, { uid: O, token: {} }, { confirm: [{ key: 'num:5135550301', leadId: 'TL1' }] })).r;
  ok('confirming again files nothing (already filed)', cf2.filed === 0 && cf2.skipped === 1);
  ok('L.taggedContactPlan: a number on two leads is never guessed', L.taggedContactPlan({ calls: [tcall({ id: 'c1', phoneDigits: '5135550400', contactName: 'X' })], leads: [{ id: 'a', phone: '5135550400' }, { id: 'b', altPhone: '5135550400' }] }).notInCrm[0].ambiguous === true);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
