// tests/q11-call-text-backfill-2026-11-09.test.js
// scripts/backfill-q11-call-text.js: Call to Close Q11, the second backfill.
// Tasks filed before 2026-11-09 still carry the call in their title / text /
// notes / why, and leads Thursday created still carry the call in lead.notes;
// viewers read both. The script gives them the generic shape the live writers
// now write: the full text goes to leads/{id}/task_call_text/{taskId} first
// (create(), never over an existing one), then the task gets the generic
// values + callText: true (conditional on the page's updateTime); a lead's
// old notes go to the call doc's callNotes (when missing), then lead.notes
// becomes the pointer. Dry run by default. No network: a fake Firestore, and
// a fake fetch for the REST adapter's create() / get() updateTime.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'scripts', 'backfill-q11-call-text.js'));
const R = require(path.join(ROOT, 'scripts', '_firestore-rest.js'));
const TCT = require(path.join(ROOT, 'functions', 'task-call-text.js'));
const T = require(path.join(ROOT, 'functions', 'integrations', 'thursday-logic.js'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL', m); } }

const SERVER_TS = { __ts: true };
const POINTER = 'The summary is on the customer\'s timeline.';

// ── old-shape fixtures, written by hand (the strings the old writers wrote) ──
const YOU_SAID = 'You said you would:\n• Send the PROMISESECRET quote (by 2026-11-12)\n• Call the adjuster';
// What the call doc holds (call-center.js writes promises / summary /
// followUpDate on it; the task was built from the same notes).
const PROMISES = [{ who: 'jo', text: 'Send the PROMISESECRET quote', due: '2026-11-12' }, { who: 'customer', text: 'Send photos' }, { who: 'jo', text: 'Call the adjuster' }];
const PAT = { contactName: 'NAMESECRET Pat', promises: PROMISES };
const EX = T.sanitizeExtraction({ caller_name: 'NAMESECRET halina', callback_number: '5135559876', issue: 'ISSUESECRET shingles off', urgent: true, urgent_reason: 'URGENTSECRET tarp', insurance: { involved: 'yes', carrier: 'CARRIERSECRET', claim_filed: 'yes', claim_number: 'CLM-SECRET' } });
const TCALL = { callId: 'CALLIDX9', from: '+15135559876', startedAt: '2026-11-01T14:00:00.000Z', summary: 'SUMMARYSECRET storm' };
const EX2 = T.sanitizeExtraction({ caller_name: 'NAMESECRET bob', callback_number: '5135550000', issue: 'ISSUESECRET gutter', insurance: { involved: 'no' } });
const TCALL2 = { callId: 'CALLIDX8', from: '+15135550000', startedAt: '2026-11-02T14:00:00.000Z', summary: '' };
const OLD_LEAD_NOTES = '📞 Thursday call 2026-11-01: ISSUESECRET shingles off\nURGENT — URGENTSECRET tarp\nInsurance: CARRIERSECRET, claim filed (#CLM-SECRET)';
const OLD_LEAD_NOTES2 = '📞 Thursday call 2026-11-02: ISSUESECRET gutter';

function seed() {
  return {
    'leads/LEADIDX1': { companyId: 'co1', userId: 'u1' },
    'leads/LEADIDX2': { userId: 'solo1' },
    'leads/LEADIDX3': { companyId: 'co2', userId: 'u3' },
    'phone_calls/CUBEIDX1': PAT,
    'phone_calls/CUBEIDX2': Object.assign({ summary: 'SUMMARYSECRET' }, PAT),
    'phone_calls/CUBEIDX3': { promises: [{ who: 'jo', text: 'Order PROMISESECRET shingles' }] },
    'phone_calls/CUBEIDX4': PAT,
    'phone_calls/CUBEIDX5': Object.assign({ summary: 'SUMMARYSECRET' }, PAT),
    'phone_calls/CUBEIDX6': { contactName: 'NAMESECRET Pat', promises: [], followUpDate: '2026-11-20' },
    'phone_calls/CUBEIDX7': PAT,
    'phone_text_days/TXTIDX1': { contactName: 'NAMESECRET Sam', promises: [{ who: 'jo', text: 'Text the PROMISESECRET photos', due: '2026-11-03' }] },
    'thursday_calls/bland_calls__CALLIDX9': { extraction: EX, call: TCALL, route: { action: 'create_lead' }, issue: EX.issue },
    'thursday_calls/bland_calls__CALLIDX8': { extraction: EX2, call: TCALL2, route: { action: 'attach' }, issue: EX2.issue, callNotes: OLD_LEAD_NOTES2 },
    'thursday_calls/bland_calls__CALLIDX7': { extraction: EX2, call: Object.assign({}, TCALL2, { callId: 'CALLIDX7' }), route: { action: 'attach' }, issue: 'ISSUESECRET something else' },
    // cube: a promise, no pointer (summary scrubbed by the first backfill)
    'leads/LEADIDX1/tasks/cube-CUBEIDX1': { title: 'Send the PROMISESECRET quote (NAMESECRET Pat)', text: 'Send the PROMISESECRET quote (NAMESECRET Pat)', notes: YOU_SAID, source: 'cube-acr', done: false },
    // cube: pointer + promises (filed between the two changes)
    'leads/LEADIDX1/tasks/cube-CUBEIDX2': { title: 'Send the PROMISESECRET quote (NAMESECRET Pat)', text: 'Send the PROMISESECRET quote (NAMESECRET Pat)', notes: POINTER + '\n\n' + YOU_SAID, source: 'cube-acr' },
    // cube: no contactName -> the writer's 'customer'
    'leads/LEADIDX2/tasks/cube-CUBEIDX3': { title: 'Order PROMISESECRET shingles (customer)', text: 'Order PROMISESECRET shingles (customer)', notes: 'You said you would:\n• Order PROMISESECRET shingles', source: 'cube-acr' },
    // cube: edited by an owner
    'leads/LEADIDX1/tasks/cube-CUBEIDX4': { title: 'Jo typed EDITSECRET', text: 'Jo typed EDITSECRET', notes: YOU_SAID, source: 'cube-acr' },
    // cube: still a Call: paragraph (summary scrub first)
    'leads/LEADIDX1/tasks/cube-CUBEIDX5': { title: 'Send the PROMISESECRET quote (NAMESECRET Pat)', text: 'Send the PROMISESECRET quote (NAMESECRET Pat)', notes: 'Call: SUMMARYSECRET\n\n' + YOU_SAID, source: 'cube-acr' },
    // cube: a follow-up date only, already generic
    'leads/LEADIDX1/tasks/cube-CUBEIDX6': { title: 'Follow up with NAMESECRET Pat', text: 'Follow up with NAMESECRET Pat', notes: '', source: 'cube-acr' },
    // cube: already done by the live writer
    'leads/LEADIDX1/tasks/cube-CUBEIDX7': { title: 'Follow up with NAMESECRET Pat', text: 'Follow up with NAMESECRET Pat', notes: '', callText: true, source: 'cube-acr' },
    // cube: the call is gone -> who unknown
    'leads/LEADIDX1/tasks/cube-CUBEGONE': { title: 'Send it (NAMESECRET Gone)', text: 'Send it (NAMESECRET Gone)', notes: 'You said you would:\n• Send it', source: 'cube-acr' },
    // sms
    'leads/LEADIDX1/tasks/sms-TXTIDX1': { title: 'Text the PROMISESECRET photos (NAMESECRET Sam)', text: 'Text the PROMISESECRET photos (NAMESECRET Sam)', notes: 'You said you would:\n• Text the PROMISESECRET photos (by 2026-11-03)', source: 'sms-backup' },
    // thursday
    'leads/LEADIDX1/tasks/thursday-CALLIDX9': { title: '🚨 URGENT — Call back NAMESECRET halina — ISSUESECRET shingles off', text: '🚨 URGENT — Call back NAMESECRET halina — ISSUESECRET shingles off', notes: 'Number: +15135559876', source: 'thursday' },
    'leads/LEADIDX3/tasks/thursday-CALLIDX8': { title: 'Call back NAMESECRET bob — ISSUESECRET gutter', text: 'Call back NAMESECRET bob — ISSUESECRET gutter', notes: 'Number: +15135550000', source: 'thursday' },
    'leads/LEADIDX1/tasks/thursday-CALLIDX7': { title: 'Call back NAMESECRET bob — ISSUESECRET gutter', text: 'Call back NAMESECRET bob — ISSUESECRET gutter', source: 'thursday' },
    // promise
    'leads/LEADIDX1/tasks/promise-CUBEIDX1': { kind: 'promise', promiseKind: 'estimate', why: 'WHYSECRET roof', title: 'Send estimate - WHYSECRET roof', text: 'Send estimate - WHYSECRET roof', source: 'call', done: false },
    'leads/LEADIDX2/tasks/promise-CUBEIDX3-2': { kind: 'promise', promiseKind: 'waiting', waitingOn: 'adjuster', why: 'WHYSECRET claim', title: 'Waiting on the adjuster - WHYSECRET claim', text: 'Waiting on the adjuster - WHYSECRET claim', source: 'call' },
    'leads/LEADIDX1/tasks/promise-CUBEIDX4': { kind: 'promise', promiseKind: 'estimate', why: 'WHYSECRET', title: 'Send estimate - WHYSECRET', text: 'Jo EDITSECRET', source: 'call' },
    'leads/LEADIDX1/tasks/promise-CUBEIDX5': { kind: 'promise', promiseKind: 'estimate', why: '', title: 'Send estimate', text: 'Send estimate', callText: false, source: 'call' },
    // not candidates
    'leads/LEADIDX1/tasks/manual1': { title: 'NAMESECRET manual', notes: 'You said you would:\n• x' },
    'tasks/cube-TOP': { title: 'x (y)' },
    // leads Thursday created
    'leads/bland_calls__CALLIDX9': { companyId: 'co1', userId: 'u1', publicLeadCollection: 'thursday_calls', publicLeadId: 'bland_calls__CALLIDX9', notes: OLD_LEAD_NOTES, firstName: 'NAMESECRET' },
    'leads/bland_calls__CALLIDX8': { companyId: 'co2', userId: 'u3', publicLeadCollection: 'thursday_calls', publicLeadId: 'bland_calls__CALLIDX8', notes: OLD_LEAD_NOTES2 },
    'leads/bland_calls__CALLIDX7': { companyId: 'co1', userId: 'u1', publicLeadCollection: 'thursday_calls', publicLeadId: 'bland_calls__CALLIDX7', notes: OLD_LEAD_NOTES2 + '\nJo EDITSECRET' },
    'leads/LEADPLAIN': { companyId: 'co1', notes: '📞 Thursday call typed by hand' },
  };
}

// Firestore hands a map back with its keys sorted, not in the order written
// (review 2026-11-09): the fake does the same, so a comparison that leans on
// key order fails here as it would in production.
function sortKeys(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
  return o;
}

// ── a fake Firestore (admin-like) with an ordered op log ──
function fakeDb(docs) {
  const ops = [], forbidden = [], ver = {};
  let gets = 0;
  const edit = (p, fields) => { docs[p] = Object.assign({}, docs[p], fields); ver[p] = (ver[p] || 0) + 1; };
  const exists = (p) => Object.prototype.hasOwnProperty.call(docs, p);
  function ref(p) {
    return {
      path: p,
      get: async () => ({ exists: exists(p), updateTime: exists(p) ? { v: ver[p] || 0 } : undefined, data: () => sortKeys(docs[p]) }),
      create: async (data) => {
        if (exists(p)) { const e = new Error('6 ALREADY_EXISTS: Document already exists: ' + p); e.code = 6; throw e; }
        ops.push({ op: 'create', p, data }); docs[p] = data; ver[p] = 0;
      },
      update: async (...args) => {
        if (!exists(p)) throw new Error('NOT_FOUND ' + p);
        const pre = args.length % 2 ? args.pop() : null;
        if (pre && !(pre.lastUpdateTime && pre.lastUpdateTime.v === (ver[p] || 0))) throw new Error('FAILED_PRECONDITION ' + p);
        const patch = {};
        for (let i = 0; i < args.length; i += 2) patch[String(args[i])] = args[i + 1];
        ops.push({ op: 'update', p, patch, pre });
        edit(p, patch);
      },
      set: async () => { forbidden.push('set ' + p); },
      delete: async () => { forbidden.push('delete ' + p); },
    };
  }
  const inGroup = (p, g) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === g; };
  function query(group, after, lim) {
    return {
      orderBy(f) { if (f !== '__name__') throw new Error('orderBy ' + f); return this; },
      limit(n) { return query(group, after, n); },
      startAfter(snap) { return query(group, snap.ref.path, lim); },
      async get() {
        if (++gets > 200) throw new Error('pagination did not advance');
        const paths = Object.keys(docs).filter((p) => inGroup(p, group)).sort().filter((p) => after === undefined || p > after);
        const page = lim ? paths.slice(0, lim) : paths;
        const out = page.map((p) => ({ id: p.split('/').pop(), ref: ref(p), updateTime: { v: ver[p] || 0 }, data: () => sortKeys(docs[p]) }));
        return { empty: !out.length, size: out.length, docs: out };
      },
    };
  }
  return { ops, forbidden, edit, db: { doc: ref, collectionGroup: (g) => { if (g !== 'tasks' && g !== 'leads') throw new Error('group ' + g); return query(g); } } };
}

const runArgs = (f, argv, extra) => S.run(Object.assign({ db: f.db, args: S.parseArgs(argv), log: () => {}, serverTimestamp: () => SERVER_TS, pageSize: 4 }, extra || {}));
const T1 = 'leads/LEADIDX1/tasks/cube-CUBEIDX1';

(async () => {
  // ── pure planners ──
  ok(S.POINTER === POINTER, 'POINTER is the writer\'s pointer line');
  let pl = S.planFollowUp('cube', 'cube-CUBEIDX1', seed()[T1], PAT);
  ok(pl.generic && pl.generic.title === 'Follow up with NAMESECRET Pat' && pl.generic.text === pl.generic.title && pl.generic.notes === '', 'cube: Follow up with <who>, notes drop the You said block -> ' + JSON.stringify(pl));
  pl = S.planFollowUp('cube', 'cube-CUBEIDX2', seed()['leads/LEADIDX1/tasks/cube-CUBEIDX2'], seed()['phone_calls/CUBEIDX2']);
  ok(pl.generic && pl.generic.notes === POINTER, 'cube with pointer: generic notes keep the pointer');
  pl = S.planFollowUp('cube', 'cube-CUBEIDX3', seed()['leads/LEADIDX2/tasks/cube-CUBEIDX3'], seed()['phone_calls/CUBEIDX3']);
  ok(pl.generic && pl.generic.title === 'Follow up with customer', 'no contactName: the writer\'s "customer"');
  ok(S.planFollowUp('cube', 'cube-X', seed()[T1], null).skip === 'whoUnknown', 'call gone: whoUnknown');
  ok(S.planFollowUp('cube', 'cube-X', seed()[T1], Object.assign({}, PAT, { contactName: 'Someone Else' })).skip === 'edited', 'contactName changed since: title no longer the server\'s -> edited');
  ok(S.planFollowUp('cube', 'cube-X', seed()['leads/LEADIDX1/tasks/cube-CUBEIDX4'], PAT).skip === 'edited', 'edited title: edited');
  ok(S.planFollowUp('cube', 'cube-X', Object.assign({}, seed()[T1], { notes: YOU_SAID + '\n\nJo note' }), PAT).skip === 'edited', 'extra notes paragraph: edited');
  ok(S.planFollowUp('cube', 'cube-X', Object.assign({}, seed()[T1], { text: 'other' }), PAT).skip === 'edited', 'text differs from title: edited');
  ok(S.planFollowUp('cube', 'cube-X', seed()['leads/LEADIDX1/tasks/cube-CUBEIDX5'], PAT).skip === 'needsSummaryScrub', 'Call: paragraph: summary scrub first');
  ok(S.planFollowUp('cube', 'cube-X', seed()['leads/LEADIDX1/tasks/cube-CUBEIDX6'], seed()['phone_calls/CUBEIDX6']).skip === 'alreadyGeneric', 'follow-up date only: already generic');
  // An owner's edit inside the "You said you would" list (review 2026-11-09):
  // the list is rebuilt from the call doc, not from the task's own bullets.
  const t1n = (notes) => Object.assign({}, seed()[T1], { notes });
  ok(S.planFollowUp('cube', 'cube-X', t1n(YOU_SAID.replace('• Call the adjuster', '• Call the adjuster -- Jo: gate code 4411')), PAT).skip === 'edited', 'a later bullet edited by hand: edited');
  ok(S.planFollowUp('cube', 'cube-X', t1n(YOU_SAID + '\n• Jo added EDITSECRET'), PAT).skip === 'edited', 'a bullet added by hand: edited');
  ok(S.planFollowUp('cube', 'cube-X', t1n(YOU_SAID.replace('(by 2026-11-12)', '(by 2026-11-30)')), PAT).skip === 'edited', 'the first bullet\'s due date changed: edited');
  ok(S.planFollowUp('cube', 'cube-X', t1n('You said you would:\n• Send the PROMISESECRET quote (by 2026-11-12)'), PAT).skip === 'edited', 'a bullet removed: not what the server wrote, edited');
  // promise-cleanup stamps keptAtMs after filing; a day of texts files only
  // its open promises (text-inbox.js): both still match.
  const kept = { contactName: 'NAMESECRET Pat', promises: [PROMISES[0], PROMISES[1], Object.assign({ keptAtMs: 5 }, PROMISES[2])] };
  ok(S.planFollowUp('cube', 'cube-X', seed()[T1], kept).generic, 'a promise kept after filing: still the server\'s task');
  ok(S.planFollowUp('sms', 'sms-X', t1n('You said you would:\n• Send the PROMISESECRET quote (by 2026-11-12)'), kept).generic, 'a day filed without its kept promise: matches');
  const byText = { title: 'Fix it (by Friday) (P)', text: 'Fix it (by Friday) (P)', notes: 'You said you would:\n• Fix it (by Friday)' };
  ok(S.planFollowUp('sms', 'sms-X', byText, { contactName: 'P', promises: [{ who: 'jo', text: 'Fix it (by Friday)' }] }).generic, 'a promise text that itself ends "(by …)" still matches');
  ok(S.planThursday(seed()['leads/LEADIDX1/tasks/thursday-CALLIDX9'], seed()['thursday_calls/bland_calls__CALLIDX9']).generic.title === '🚨 URGENT — Call back NAMESECRET halina', 'thursday: cut at " — <issue>"');
  ok(S.planThursday(seed()['leads/LEADIDX1/tasks/thursday-CALLIDX7'], seed()['thursday_calls/bland_calls__CALLIDX7']).skip === 'issueMismatch', 'thursday: issue not the title suffix -> issueMismatch');
  ok(S.planThursday(Object.assign({}, seed()['leads/LEADIDX1/tasks/thursday-CALLIDX9'], { text: 'x' }), seed()['thursday_calls/bland_calls__CALLIDX9']).skip === 'edited', 'thursday: text edited -> edited');
  ok(S.planThursday({ title: 'Call back NAMESECRET bob', text: 'Call back NAMESECRET bob' }, seed()['thursday_calls/bland_calls__CALLIDX8']).skip === 'alreadyGeneric', 'thursday: already generic');
  ok(S.planThursday(seed()['leads/LEADIDX1/tasks/thursday-CALLIDX9'], null).skip === 'sourceMissing', 'thursday: call gone');
  pl = S.planPromise(seed()['leads/LEADIDX1/tasks/promise-CUBEIDX1']);
  ok(pl.generic && pl.generic.title === 'Send estimate' && pl.generic.text === 'Send estimate' && pl.generic.why === '', 'promise: taskText(kind, \'\', waitingOn), why \'\'');
  pl = S.planPromise(seed()['leads/LEADIDX2/tasks/promise-CUBEIDX3-2']);
  ok(pl.generic && pl.generic.title === 'Waiting on the adjuster', 'promise waiting: keeps waitingOn');
  ok(S.planPromise(seed()['leads/LEADIDX1/tasks/promise-CUBEIDX4']).skip === 'edited', 'promise edited: edited');
  ok(S.planPromise(seed()['leads/LEADIDX1/tasks/promise-CUBEIDX5']).skip === 'alreadyGeneric', 'promise no why: already generic');
  ok(T.callNotes(EX, TCALL) === OLD_LEAD_NOTES, 'fixture: the hand-written old lead notes are callNotes()');
  let lp = S.planLead(seed()['leads/bland_calls__CALLIDX9'], seed()['thursday_calls/bland_calls__CALLIDX9']);
  ok(lp.copyCallNotes === true && lp.notes === '📞 From a Thursday call on 2026-11-01. The details are on the call.', 'lead: copy to callNotes, notes become the pointer');
  lp = S.planLead(seed()['leads/bland_calls__CALLIDX8'], seed()['thursday_calls/bland_calls__CALLIDX8']);
  ok(lp.copyCallNotes === false && /^📞 From a Thursday call/.test(lp.notes), 'lead whose call already has the callNotes: lead only');
  ok(S.planLead(seed()['leads/bland_calls__CALLIDX7'], seed()['thursday_calls/bland_calls__CALLIDX7']).skip === 'edited', 'lead notes edited: edited');
  ok(S.planLead(seed()['leads/bland_calls__CALLIDX9'], Object.assign({}, seed()['thursday_calls/bland_calls__CALLIDX9'], { callNotes: 'other' })).skip === 'callNotesDiffer', 'call doc holds other callNotes: callNotesDiffer');

  // ── dry run: counts, no writes, no leaks ──
  let lines = [];
  let f = fakeDb(seed());
  let r = await runArgs(f, [], { log: (s) => lines.push(String(s)) });
  ok(f.ops.length === 0 && f.forbidden.length === 0, 'dry run writes nothing');
  const c = r.counts;
  ok(c.toChange === 8 && c.byKind.cube === 3 && c.byKind.sms === 1 && c.byKind.thursday === 2 && c.byKind.promise === 2, 'dry run: 3 cube, 1 sms, 2 thursday, 2 promise -> ' + JSON.stringify(c));
  ok(c.edited === 2 && c.whoUnknown === 1 && c.issueMismatch === 1 && c.needsSummaryScrub === 1 && c.alreadyGeneric === 2 && c.alreadyDone === 1, 'dry run: skip counts -> ' + JSON.stringify(c));
  ok(c.leadsToChange === 2 && c.leadsEdited === 1 && c.leadsNotOld === 4, 'dry run: 2 leads to point, 1 edited -> ' + JSON.stringify(c));
  ok(lines.some((l) => /DRY RUN/.test(l)) && lines.some((l) => /--apply/.test(l)), 'dry run says so and how to write');
  const leaks = (txt) => /SECRET|IDX|bland_calls|LEADPLAIN|Pat|Sam|halina/.test(txt);
  ok(!leaks(lines.join('\n')), 'dry run output: counts only, no text, names or ids');

  // ── --apply ──
  lines = [];
  const docs = seed();
  const before = JSON.parse(JSON.stringify(docs));
  f = fakeDb(docs);
  r = await runArgs(f, ['--apply'], { log: (s) => lines.push(String(s)) });
  ok(f.forbidden.length === 0, 'apply: no set, no delete');
  ok(r.counts.tasksWritten === 8 && r.counts.sidecarsWritten === 8 && r.counts.failures === 0, 'apply: 8 sidecars, 8 tasks -> ' + JSON.stringify(r.counts));
  const t1 = docs[T1], s1 = docs['leads/LEADIDX1/task_call_text/cube-CUBEIDX1'];
  ok(t1.title === 'Follow up with NAMESECRET Pat' && t1.text === t1.title && t1.notes === '' && t1.callText === true && t1.updatedAt === SERVER_TS && t1.done === false && t1.source === 'cube-acr', 'cube task: generic, callText, other fields kept');
  ok(s1 && s1.full.title === before[T1].title && s1.full.notes === YOU_SAID && s1.generic.title === t1.title && s1.generic.notes === '' && s1.leadId === 'LEADIDX1' && s1.taskId === 'cube-CUBEIDX1' && s1.source === 'cube-acr', 'cube sidecar: { full, generic } in the writer\'s shape');
  ok(JSON.stringify(TCT.apply(t1, s1)) === JSON.stringify(Object.assign({}, t1, { title: before[T1].title, text: before[T1].text, notes: YOU_SAID })), 'apply() over the backfilled task gives the owner the old full task back');
  // shape parity with the live writer's sidecar
  const live = TCT.split(Object.assign({}, before[T1]), { title: 'Follow up with NAMESECRET Pat', text: 'Follow up with NAMESECRET Pat', notes: '' });
  ok(JSON.stringify(Object.keys(s1).sort()) === JSON.stringify(['full', 'generic', 'leadId', 'source', 'taskId']) && JSON.stringify(s1.full) === JSON.stringify(live.callTextFull.full), 'sidecar keys and full match task-call-text.js');
  ok(docs['leads/LEADIDX1/tasks/cube-CUBEIDX2'].notes === POINTER, 'pointer kept on the generic notes');
  ok(docs['leads/LEADIDX2/tasks/cube-CUBEIDX3'].title === 'Follow up with customer', 'cube, no contactName: Follow up with customer');
  ok(docs['leads/LEADIDX1/tasks/sms-TXTIDX1'].title === 'Follow up with NAMESECRET Sam' && docs['leads/LEADIDX1/task_call_text/sms-TXTIDX1'].source === 'sms-backup', 'sms task generic, sidecar source sms-backup');
  const th = docs['leads/LEADIDX1/tasks/thursday-CALLIDX9'];
  ok(th.title === '🚨 URGENT — Call back NAMESECRET halina' && th.text === th.title && th.notes === 'Number: +15135559876' && th.callText === true, 'thursday: title / text cut, notes untouched');
  ok(!('notes' in docs['leads/LEADIDX1/task_call_text/thursday-CALLIDX9'].full), 'thursday sidecar: title / text only');
  const pt = docs['leads/LEADIDX1/tasks/promise-CUBEIDX1'];
  ok(pt.title === 'Send estimate' && pt.text === 'Send estimate' && pt.why === '' && pt.kind === 'promise' && pt.callText === true, 'promise: generic chip text, why cleared');
  ok(docs['leads/LEADIDX1/task_call_text/promise-CUBEIDX1'].full.why === 'WHYSECRET roof', 'promise sidecar holds the why');
  for (const p of ['leads/LEADIDX1/tasks/cube-CUBEIDX4', 'leads/LEADIDX1/tasks/cube-CUBEIDX5', 'leads/LEADIDX1/tasks/cube-CUBEIDX6', 'leads/LEADIDX1/tasks/cube-CUBEIDX7', 'leads/LEADIDX1/tasks/cube-CUBEGONE', 'leads/LEADIDX1/tasks/thursday-CALLIDX7', 'leads/LEADIDX1/tasks/promise-CUBEIDX4', 'leads/LEADIDX1/tasks/promise-CUBEIDX5', 'leads/LEADIDX1/tasks/manual1', 'tasks/cube-TOP', 'leads/bland_calls__CALLIDX7', 'leads/LEADPLAIN']) {
    ok(JSON.stringify(docs[p]) === JSON.stringify(before[p]), 'untouched: ' + p);
  }
  ok(!Object.keys(docs).some((p) => /task_call_text\/(cube-CUBEIDX[4-7]|cube-CUBEGONE|thursday-CALLIDX7|promise-CUBEIDX[45])$/.test(p)), 'no sidecar for a skipped task');
  // order: each sidecar created before its task's update
  const idx = (op, p) => f.ops.findIndex((o) => o.op === op && o.p === p);
  const taskUpdates = f.ops.filter((o) => o.op === 'update' && /\/tasks\//.test(o.p));
  ok(taskUpdates.length === 8 && taskUpdates.every((o) => { const sp = TCT.sidePath(o.p); return idx('create', sp) >= 0 && idx('create', sp) < f.ops.indexOf(o); }), 'every sidecar is created before its task is updated');
  ok(taskUpdates.every((o) => o.pre && o.pre.lastUpdateTime && o.pre.lastUpdateTime.v === 0), 'every task update is conditional on the page\'s updateTime');
  ok(taskUpdates.every((o) => o.patch.callText === true && o.patch.updatedAt === SERVER_TS && Object.keys(o.patch).every((k) => ['title', 'text', 'notes', 'why', 'callText', 'updatedAt'].includes(k))), 'task updates write generic fields + callText + updatedAt only');
  // leads
  const l9 = docs['leads/bland_calls__CALLIDX9'], c9 = docs['thursday_calls/bland_calls__CALLIDX9'];
  ok(c9.callNotes === OLD_LEAD_NOTES && c9.callNotes === T.callNotes(EX, TCALL), 'lead: old notes copied onto the call doc\'s callNotes, in callNotes() format');
  ok(l9.notes === T.leadNotesPointer(TCALL) && l9.updatedAt === SERVER_TS && l9.firstName === 'NAMESECRET', 'lead: notes = leadNotesPointer(call), other fields kept');
  ok(idx('update', 'thursday_calls/bland_calls__CALLIDX9') < idx('update', 'leads/bland_calls__CALLIDX9'), 'the call gets the text before the lead points at it');
  ok(idx('update', 'thursday_calls/bland_calls__CALLIDX8') === -1 && docs['leads/bland_calls__CALLIDX8'].notes === T.leadNotesPointer(TCALL2), 'call with callNotes already: not rewritten, lead pointed');
  const leadOps = f.ops.filter((o) => o.op === 'update' && !/\/tasks\//.test(o.p));
  ok(leadOps.length === 3 && leadOps.every((o) => o.pre && o.pre.lastUpdateTime), 'lead / call updates are conditional on updateTime');
  ok(r.counts.callNotesWritten === 1 && r.counts.leadsWritten === 2, 'apply: 1 call notes, 2 leads');
  ok(!leaks(lines.join('\n')), 'apply output: counts only');

  // ── idempotence ──
  const n0 = f.ops.length;
  lines = [];
  r = await runArgs(f, ['--apply'], { log: (s) => lines.push(String(s)) });
  ok(f.ops.length === n0 && r.counts.toChange === 0 && r.counts.leadsToChange === 0, 'second run changes nothing -> ' + JSON.stringify(r.counts));
  ok(lines.some((l) => /nothing to change/.test(l)), 'second run says nothing to change');
  ok(r.counts.alreadyDone === 9, 'second run: every backfilled task now callText -> ' + r.counts.alreadyDone);

  // ── an existing sidecar is never overwritten ──
  let d2 = seed();
  d2['leads/LEADIDX1/task_call_text/cube-CUBEIDX1'] = { full: { title: 'OTHER' }, generic: { title: 'x' } };
  f = fakeDb(d2);
  r = await runArgs(f, ['--apply']);
  ok(d2['leads/LEADIDX1/task_call_text/cube-CUBEIDX1'].full.title === 'OTHER' && d2[T1].title === seed()[T1].title && r.counts.otherSidecar === 1, 'a different sidecar: kept, the task left full -> ' + JSON.stringify(r.counts));
  // the dry run counts it too (review 2026-11-09: the numbers Jo signs off on)
  d2 = seed();
  d2['leads/LEADIDX1/task_call_text/cube-CUBEIDX1'] = { full: { title: 'OTHER' }, generic: { title: 'x' } };
  f = fakeDb(d2);
  lines = [];
  r = await runArgs(f, [], { log: (s) => lines.push(String(s)) });
  ok(f.ops.length === 0 && r.counts.otherSidecar === 1 && r.counts.toChange === 7 && r.counts.byKind.cube === 2, 'dry run: a task with a different sidecar is counted there, not as to change -> ' + JSON.stringify(r.counts));
  ok(lines.some((l) => /other sidecar already there \(skip\)\s*: 1$/.test(l)), 'dry run prints the other-sidecar count');
  // crash resume: the identical sidecar (written before a crash) lets the task go on
  d2 = seed();
  const sp = TCT.split(Object.assign({}, d2[T1]), { title: 'Follow up with NAMESECRET Pat', text: 'Follow up with NAMESECRET Pat', notes: '' });
  d2['leads/LEADIDX1/task_call_text/cube-CUBEIDX1'] = TCT.sideDoc(T1, sp);
  f = fakeDb(d2);
  r = await runArgs(f, ['--apply']);
  ok(d2[T1].callText === true && r.counts.otherSidecar === 0 && !f.ops.some((o) => o.op === 'create' && o.p.endsWith('/cube-CUBEIDX1')), 'crash resume: identical sidecar kept, the task finished');

  // ── a task the summary scrub already cleaned, its call with a summary ──
  // (review 2026-11-09): the scrub dropped "Call: …" and left no pointer; the
  // live writer would store the pointer as the generic notes and put
  // pointer + "You said you would" in the sidecar. The backfill writes the same.
  {
    const SP = 'leads/LEADIDX1/tasks/cube-CUBEIDXS';
    const call = Object.assign({ summary: 'SUMMARYSECRET' }, PAT);
    const liveTask = require(path.join(ROOT, 'functions', 'call-center-logic.js')).buildFollowUpTask({ call: Object.assign({ id: 'CUBEIDXS' }, call), notes: { summary: call.summary, promises: PROMISES, followUpDate: null, urgent: false }, leadId: 'x', ownerUid: 'x', todayYmd: 'x' });
    const mk = () => ({ 'leads/LEADIDX1': { companyId: 'co1' }, 'phone_calls/CUBEIDXS': call, [SP]: { title: seed()[T1].title, text: seed()[T1].text, notes: YOU_SAID, source: 'cube-acr' } });
    pl = S.planFollowUp('cube', 'cube-CUBEIDXS', mk()[SP], call);
    ok(pl.generic && pl.generic.notes === POINTER, 'scrubbed task, call with a summary: generic notes are the pointer -> ' + JSON.stringify(pl));
    let dd = mk();
    f = fakeDb(dd);
    r = await runArgs(f, ['--apply']);
    const sd = dd['leads/LEADIDX1/task_call_text/cube-CUBEIDXS'];
    ok(dd[SP].notes === POINTER && dd[SP].callText === true && r.counts.tasksWritten === 1, 'scrubbed task: stored notes are the pointer, as the live writer stores them');
    ok(sd && JSON.stringify(sortKeys(sd)) === JSON.stringify(sortKeys(TCT.sideDoc(SP, liveTask))), 'scrubbed task: the sidecar is the live writer\'s sidecar');
    // a sidecar the live writer already left on that old task (createTaskIfAbsent) is the same one: the task goes on
    dd = mk();
    dd['leads/LEADIDX1/task_call_text/cube-CUBEIDXS'] = TCT.sideDoc(SP, liveTask);
    f = fakeDb(dd);
    r = await runArgs(f, ['--apply']);
    ok(dd[SP].callText === true && r.counts.otherSidecar === 0, 'a live-written sidecar on the old task: the task is finished -> ' + JSON.stringify(r.counts));
  }

  // ── a task edited between the page read and the write keeps the edit ──
  d2 = seed();
  f = fakeDb(d2);
  const realDoc = f.db.doc;
  f.db.doc = (p) => {
    const x = realDoc(p);
    if (p === T1) { const u = x.update; x.update = async (...a) => { f.edit(p, { title: 'Rep typed mid-run' }); return u(...a); }; }
    return x;
  };
  r = await runArgs(f, ['--apply']);
  ok(d2[T1].title === 'Rep typed mid-run' && !d2[T1].callText && r.counts.failures === 1, 'edited mid-run: the update is refused, counted a failure');

  // ── no updateTime on a read: never written ──
  d2 = seed();
  f = fakeDb(d2);
  const realCg = f.db.collectionGroup;
  f.db.collectionGroup = (g) => {
    const wrap = (q) => ({ orderBy: (x) => wrap(q.orderBy(x)), limit: (n) => wrap(q.limit(n)), startAfter: (d) => wrap(q.startAfter(d)), get: async () => { const sn = await q.get(); sn.docs.forEach((d) => { delete d.updateTime; }); return sn; } });
    return wrap(realCg(g));
  };
  r = await runArgs(f, ['--apply']);
  ok(f.ops.length === 0 && r.counts.failures === 10, 'no updateTime: nothing written (not even a sidecar), each counted -> ' + JSON.stringify({ ops: f.ops.length, failures: r.counts.failures }));

  // ── a failed write prints nothing of its text ──
  d2 = seed();
  f = fakeDb(d2);
  const realDoc2 = f.db.doc;
  f.db.doc = (p) => { const x = realDoc2(p); if (p === T1) x.update = async () => { throw new Error('boom SECRET ' + p); }; return x; };
  lines = [];
  r = await runArgs(f, ['--apply'], { log: (s) => lines.push(String(s)) });
  ok(r.counts.failures === 1 && r.counts.tasksWritten === 7 && !leaks(lines.join('\n')), 'a failed task write: counted, the rest written, no error text');

  // ── --company scope ──
  f = fakeDb(seed());
  r = await runArgs(f, ['--company', 'co1']);
  ok(f.ops.length === 0, 'scoped dry run writes nothing');
  ok(r.counts.toChange === 5 && r.counts.byKind.cube === 2 && r.counts.byKind.thursday === 1, 'co1: only LEADIDX1 tasks counted -> ' + JSON.stringify(r.counts));
  // every count but "read" is that company's (review 2026-11-09): the other
  // companies' tasks and leads, and a task under no lead, are "other company"
  ok(r.counts.outOfScope === 4 && r.counts.notCandidate === 1 && r.counts.alreadyDone === 1, 'co1: not-a-candidate and already-done count co1 tasks only -> ' + JSON.stringify(r.counts));
  ok(r.counts.leadsToChange === 1 && r.counts.leadsOutOfScope === 3 && r.counts.leadsNotOld === 2, 'co1: lead counts are co1 leads only -> ' + JSON.stringify(r.counts));
  f = fakeDb(seed());
  r = await runArgs(f, ['--apply', '--company', 'solo1']);
  ok(f.ops.filter((o) => o.op === 'update').map((o) => o.p).sort().join() === 'leads/LEADIDX2/tasks/cube-CUBEIDX3,leads/LEADIDX2/tasks/promise-CUBEIDX3-2', 'solo owner: its two tasks only');
  f = fakeDb(seed());
  r = await runArgs(f, ['--apply', '--company', 'nobody']);
  ok(f.ops.length === 0 && r.counts.toChange === 0 && r.counts.leadsToChange === 0, 'unknown company: nothing');

  // ── REST adapter: create() and get() updateTime (token mode) ──
  const calls = [];
  const fetch409 = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (/:commit$/.test(url)) return calls.length === 1 ? { status: 200, text: async () => '{}' } : { status: 409, text: async () => JSON.stringify({ error: { message: 'Document already exists: projects/p/x' } }) };
    return { status: 200, text: async () => JSON.stringify({ fields: { a: { stringValue: 'b' } }, updateTime: '2026-11-01T00:00:00.000001Z' }) };
  };
  const rdb = R.restFirestore({ projectId: 'p', token: 'tok', fetchImpl: fetch409 });
  await rdb.doc('leads/L/task_call_text/T').create({ full: { title: 'x' }, generic: { title: 'y' } });
  const w = calls[0].body.writes[0];
  ok(w.currentDocument && w.currentDocument.exists === false && w.update.fields.full.mapValue.fields.title.stringValue === 'x' && !w.updateMask, 'REST create: precondition exists:false, whole doc, no mask');
  let err = null; try { await rdb.doc('leads/L/task_call_text/T').create({ a: 1 }); } catch (e) { err = e; }
  ok(err && err.code === 'already-exists', 'REST create on an existing doc: code already-exists');
  const wrote = await TCT.writeSideIfAbsent(rdb, 'leads/L/tasks/T', TCT.split({ title: 'a (b)' }, { title: 'g' }));
  ok(wrote === false, 'writeSideIfAbsent over REST: an existing sidecar is left, not an error');
  const gs = await rdb.doc('leads/L').get();
  ok(gs.exists && gs.updateTime === '2026-11-01T00:00:00.000001Z' && gs.data().a === 'b', 'REST get: carries updateTime');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
