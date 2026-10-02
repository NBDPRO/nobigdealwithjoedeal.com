/**
 * tests/text-notes-2026-10-01.test.js — AI notes for texts, a
 * conversation-day at a time (functions/text-inbox-logic.js groupTextDays /
 * buildTextNotesPrompt, functions/text-inbox.js runTextNotes) and texted
 * promises in the "you said you'd…" sweep (call-center.js runSweep).
 * The model is stubbed; Firestore is in-memory. Names/numbers invented (555).
 *
 * Run: node tests/text-notes-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const T = require(path.join(__dirname, '..', 'functions', 'text-inbox-logic.js'));
const TI = require(path.join(__dirname, '..', 'functions', 'text-inbox.js'));
const CCF = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const { runTextNotes, setNotes, OWNER, DAYS, COLLECTION } = TI._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const NOW = Date.parse('2026-10-05T18:00:00Z'); // 14:00 ET
const H = 3600e3;
const txt = (id, digits, hoursAgo, dir, body, extra) => Object.assign({ id, userId: OWNER, companyId: OWNER, phoneDigits: digits, sentAtMs: NOW - hoursAgo * H, direction: dir, body, contactName: 'Pat Example', leadId: 'L1', group: false }, extra);

console.log('\n1. groupTextDays');
const rows = [
  txt('a1', '5135550100', 6, 'inbound', 'Can you come Thursday?'),
  txt('a2', '5135550100', 5.5, 'outbound', 'Yes, I will be there at 9 and bring the shingle samples.'),
  txt('b1', '5135550142', 1, 'inbound', 'still typing'),                    // < 2 h ago → not settled
  txt('c1', '5135550177', 30, 'inbound', 'yesterday', { leadId: null, contactName: '' }),
  txt('g1', '5135550188', 8, 'outbound', 'group hi', { group: true }),     // group → skipped
];
const days = T.groupTextDays(rows, { nowMs: NOW });
ok('settled conversation-days only; group texts skipped', days.map((d) => d.phoneDigits).join() === '5135550100,5135550177', days.map((d) => d.id).join());
const d1 = days[0];
ok('day id = txt_<digits>_<ymd>', d1.id === 'txt_5135550100_20261005');
ok('messages in time order, lead + name carried', d1.messages.map((m) => m.id).join() === 'a1,a2' && d1.leadId === 'L1' && d1.contactName === 'Pat Example');
const d1b = T.groupTextDays(rows.concat([txt('a3', '5135550100', 3, 'inbound', 'Great thanks')]), { nowMs: NOW })[0];
ok('a new text that day changes the signature', d1b.id === d1.id && d1b.sig !== d1.sig);
const prompt = T.buildTextNotesPrompt({ day: d1, leadName: 'Pat Example' });
ok('prompt labels Jo vs Them, carries the CRM name', /\] Them: Can you come Thursday\?/.test(prompt) && /\] Jo: Yes, I will be there/.test(prompt) && /CRM customer this number belongs to: Pat Example/.test(prompt));

console.log('\n2. runTextNotes');
function fakeDb(seed) {
  const docs = new Map(Object.entries(seed || {}));
  const mk = (p) => ({
    id: p.split('/').pop(), _p: p,
    get: async () => ({ exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }),
    set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    create: async (v) => { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } docs.set(p, v); },
  });
  const query = (name, filters, lim) => ({
    where: (f, op, v) => query(name, filters.concat([[f, op, v]]), lim),
    orderBy: () => query(name, filters, lim),
    limit: (n) => query(name, filters, n),
    get: async () => {
      const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2 &&
        filters.every(([f, op, val]) => (op === '>=' ? v[f] >= val : v[f] === val)))
        .sort((a, b) => (b[1].sentAtMs || b[1].startedAtMs || 0) - (a[1].sentAtMs || a[1].startedAtMs || 0)).slice(0, lim || 1e9);
      return { forEach: (fn) => rows.forEach(([k, v]) => fn({ id: k.split('/')[1], data: () => v })) };
    },
  });
  return { docs, doc: mk, collection: (n) => Object.assign(query(n, [], null), { doc: (id) => mk(n + '/' + id) }), getAll: async (...r) => Promise.all(r.map((x) => x.get())) };
}
const seed = () => {
  const s = { 'leads/L1': { firstName: 'Pat', lastName: 'Example', userId: OWNER }, ['users/' + OWNER]: { email: 'owner@nbd.test' } };
  for (const r of rows) s[COLLECTION + '/' + r.id] = Object.assign({}, r);
  return s;
};
let modelCalls = 0;
const BUSINESS = { call_type: 'customer', summary: 'Pat asked for Thursday; Jo will come at 9 with samples.', promises: [{ who: 'jo', text: 'Bring shingle samples Thursday 9am', due: '2026-10-09' }], follow_up_date: null, urgent: false };

(async () => {
  setNotes(async ({ prompt }) => { modelCalls++; return /Them: yesterday/.test(prompt) ? { call_type: 'personal', summary: 'family', promises: [{ who: 'jo', text: 'x' }] } : BUSINESS; });
  let db = fakeDb(seed());
  let r = await runTextNotes({ db, live: false, nowMs: NOW });
  ok('dry run: counts pending days, calls no model, writes nothing', r.state === 'dry_run' && r.pending === 2 && modelCalls === 0 && ![...db.docs.keys()].some((k) => k.startsWith(DAYS + '/')), JSON.stringify(r));

  r = await runTextNotes({ db, live: true, nowMs: NOW });
  const day = db.docs.get(DAYS + '/txt_5135550100_20261005');
  ok('business day noted with promises + signature', day && day.status === 'noted' && day.promises.length === 1 && day.sig === d1.sig && day.channel === 'text' && day.messageCount === 2);
  ok('timeline entry on the customer', /Texts · Pat Example \(2\)/.test((db.docs.get('leads/L1/activity/sms-txt_5135550100_20261005') || {}).label || ''));
  const task = db.docs.get('leads/L1/tasks/sms-txt_5135550100_20261005');
  ok('one follow-up task for Jo\'s texted promise', task && /Bring shingle samples/.test(task.title) && task.source === 'sms-backup' && task.done === false && !('phoneCallId' in task));
  const pd = db.docs.get(DAYS + '/txt_5135550177_20261004');
  ok('personal day: no detail, no promises, nothing on a lead', pd.status === 'personal' && pd.summary === 'Personal texts.' && pd.promises.length === 0);

  const before = modelCalls;
  r = await runTextNotes({ db, live: true, nowMs: NOW + H });
  // An hour later the third conversation (last text 1 h before NOW) has
  // settled too: it is the ONLY new note — the two noted days are not redone.
  ok('unchanged days are not re-noted; a newly settled day is', modelCalls === before + 1 && r.pending === 1 && !!db.docs.get(DAYS + '/txt_5135550142_20261005'), JSON.stringify(r));

  // An old day (20 days back) gets notes but no task (14-day window).
  db = fakeDb(Object.assign(seed(), { [COLLECTION + '/o1']: txt('o1', '5135550199', 20 * 24 + 1, 'outbound', 'I will send the invoice') }));
  setNotes(async () => BUSINESS);
  await runTextNotes({ db, live: true, nowMs: NOW });
  ok('days older than 3 days are not read at all', ![...db.docs.keys()].some((k) => /txt_5135550199/.test(k)));

  console.log('\n3. Texted promises in the sweep');
  db = fakeDb(seed());
  setNotes(async () => BUSINESS);
  await runTextNotes({ db, live: true, nowMs: NOW });
  // Make the task due today so the sweep lists it.
  db.docs.set('leads/L1/tasks/sms-txt_5135550100_20261005', Object.assign({}, db.docs.get('leads/L1/tasks/sms-txt_5135550100_20261005'), { dueDate: '2026-10-05' }));
  const sent = [];
  const sr = await CCF._test.runSweep({ db, live: true, nowMs: NOW, slot: 'pm', send: async (m) => { sent.push(m); } });
  ok('the sweep lists the texted promise', sr.state === 'sent' && sr.due === 1 && /Bring shingle samples/.test(sent[0].html), JSON.stringify(sr));
  ok('and marks it as texts', /texts · /.test(sent[0].html));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
