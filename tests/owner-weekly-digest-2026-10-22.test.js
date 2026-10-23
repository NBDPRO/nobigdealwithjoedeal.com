/**
 * tests/owner-weekly-digest-2026-10-22.test.js
 *
 * The Monday owner digest: functions/owner-weekly-digest-logic.js (pure) and
 * owner-weekly-digest.js (runDigest with a fake Firestore). Synthetic names and
 * amounts only (public repo). Each check has a positive and a negative control.
 * The clock is an input (todayYmd / nowMs), never the machine's Date.
 *
 * Run: node tests/owner-weekly-digest-2026-10-22.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ROOT = path.join(__dirname, '..');

// owner-weekly-digest.js needs firebase packages at module scope; stub them so
// the test runs without functions/node_modules (same idea as other tests).
const WARNS = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './integrations/heartbeat') return { onSchedule: (_o, fn) => fn };
  if (request === 'firebase-functions/v2') return { logger: { info() {}, warn(...a) { WARNS.push(a); } } };
  if (request === 'firebase-admin/firestore') return { getFirestore: () => null, FieldValue: { serverTimestamp: () => 'TS' } };
  return origLoad.apply(this, arguments);
};
const D = require(path.join(ROOT, 'functions/owner-weekly-digest-logic.js'));
const W = require(path.join(ROOT, 'functions/owner-weekly-digest.js'));

const TODAY = '2026-10-26'; // a Monday; last week = Mon 10-19 .. Sun 10-25

console.log('\n— week math —');
ok('a Monday is its own week start', JSON.stringify(D.weekBounds('2026-10-26')) === JSON.stringify({ from: '2026-10-26', to: '2026-11-01' }));
ok('a Sunday belongs to the week that started the Monday before', D.weekBounds('2026-10-25').from === '2026-10-19');
ok('last week from a Monday is Mon..Sun before it', JSON.stringify(D.lastWeek(TODAY)) === JSON.stringify({ from: '2026-10-19', to: '2026-10-25' }));
ok('negative control: last week is not this week', D.lastWeek(TODAY).from !== D.weekBounds(TODAY).from);
ok('week math crosses a month and a year', D.lastWeek('2027-01-04').from === '2026-12-28' && D.lastWeek('2027-01-04').to === '2027-01-03');

const leads = [
  { id: 'a', firstName: 'Ann', lastName: 'Test', stage: 'new', scheduledDate: '2026-10-28' },
  { id: 'b', firstName: 'Bob', lastName: 'Test', stage: 'new', scheduledDate: '2026-11-03' },   // next week
  { id: 'c', firstName: 'Cy', lastName: 'Test', stage: 'closed' },                              // done
  { id: 'd', firstName: 'Di', lastName: 'Test', stage: 'new' },
  { id: 'e', firstName: 'Ed', lastName: 'Test', stage: 'new', deleted: true, scheduledDate: '2026-10-27' },
];
const invoices = [
  { id: 'i1', leadId: 'a', total: 1000, balanceDue: 0, payments: [{ amount: 600, at: '2026-10-21T15:00:00Z' }, { amount: 400, at: '2026-10-26T15:00:00Z' }] },
  { id: 'i2', leadId: 'c', total: 500, balanceDue: 0, payments: [{ amount: 500, at: '2026-10-20T15:00:00Z' }], refunds: [{ amount: 50, at: '2026-10-22T15:00:00Z' }] },
  { id: 'i3', leadId: 'd', total: 9999, balanceDue: 9999, payments: [] },                         // billed, nothing collected
];
const estimates = [
  { id: 'e1', leadId: 'a', grandTotal: 12000.5, createdAt: '2026-10-10T12:00:00Z' },
  { id: 'e2', leadId: 'd', grandTotal: 8000, createdAt: '2026-10-11T12:00:00Z' },
  { id: 'e3', leadId: 'c', grandTotal: 7000, createdAt: '2026-10-01T12:00:00Z' },
  { id: 'e4', leadId: 'b', grandTotal: 3000, createdAt: '2026-10-12T12:00:00Z' },
];
const deals = [
  { id: 'd1', estimateId: 'e1', leadId: 'a', status: 'viewed', sentAt: '2026-10-12T12:00:00Z', viewCount: 2 },
  { id: 'd2', estimateId: 'e2', leadId: 'd', status: 'sent', sentAt: '2026-10-13T12:00:00Z', viewCount: 0 },
  { id: 'd3', estimateId: 'e3', leadId: 'c', status: 'sent', sentAt: '2026-10-02T12:00:00Z' },        // lead already closed
  { id: 'd4', estimateId: 'e4', leadId: 'b', status: 'accepted', sentAt: '2026-10-13T12:00:00Z' },    // signed
];
const dig = D.buildDigest({ leads, jobsByLead: null, invoices, estimates, deals, callItems: [{ who: 'Pat Test', kind: 'urgent', due: TODAY }], todayYmd: TODAY });

console.log('\n— collected —');
ok('collects only the payments inside last week, net of refunds, in cents', dig.collectedCents === 60000 + 50000 - 5000, String(dig.collectedCents));
ok('negative control: the 10-26 payment (this week) is not counted', dig.collectedCents !== 60000 + 40000 + 50000 - 5000);
ok('negative control: a billed-but-unpaid invoice adds nothing', dig.collectedCents < 999900);
ok('payments counted, refund not one of them', dig.payments === 2);

console.log('\n— awaiting signature —');
ok('lists the sent and the opened proposal, biggest first', dig.awaiting.map((a) => a.leadId).join() === 'a,d', dig.awaiting.map((a) => a.leadId).join());
ok('totals in cents without float drift', dig.awaiting[0].totalCents === 1200050 && dig.awaitingCents === 1200050 + 800000);
ok('negative control: accepted proposal not listed', !dig.awaiting.some((a) => a.leadId === 'b'));
ok('negative control: a closed customer is not listed', !dig.awaiting.some((a) => a.leadId === 'c'));

console.log('\n— jobs this week —');
ok('only jobs dated Mon..Sun of this week', dig.jobs.length === 1 && dig.jobs[0].leadId === 'a');
ok('negative control: next week and deleted customers are out', !dig.jobs.some((j) => j.leadId === 'b' || j.leadId === 'e'));
const withJob = D.buildDigest({ leads, jobsByLead: { d: [{ id: 'j2', scheduledDate: '2026-10-30' }] }, invoices: [], estimates: [], deals: [], callItems: null, todayYmd: TODAY });
ok('a second job on the jobs subcollection counts', withJob.jobs.some((j) => j.leadId === 'd' && j.day === '2026-10-30'));

console.log('\n— report text —');
const r = D.render(dig);
ok('title names the week', r.title === 'Monday digest, week of 2026-10-26');
ok('collected line says money received only', /Collected 2026-10-19 to 2026-10-25: \$1,050/.test(r.text) && /Money received only/.test(r.text));
ok('awaiting is labelled PROJECTED', /PROJECTED, not collected/.test(r.text) && /\$20,000 PROJECTED/.test(r.text) === false && /\$20,001 PROJECTED/.test(r.text));
ok('calls and jobs appear', /Pat Test \(urgent\)/.test(r.text) && /2026-10-28 Ann Test/.test(r.text));
ok('no cost / margin / profit wording', !/cost|margin|profit/i.test(r.text));
ok('negative control: a company without a Call Center gets no calls section',
  !/Calls to return/.test(D.render(D.buildDigest({ leads, invoices, estimates, deals, callItems: null, todayYmd: TODAY })).text));
ok('negative control: an empty call list says none, not nothing', /Calls to return: none/.test(D.render(D.buildDigest({ leads, invoices, estimates, deals, callItems: [], todayYmd: TODAY })).text));
const many = D.buildDigest({ leads: Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, firstName: 'N' + i, stage: 'new', scheduledDate: '2026-10-27' })), todayYmd: TODAY });
ok('long lists are capped with a +N more line and stay under the inbox limit', /\+ 22 more/.test(D.render(many).text) && D.render(many).text.length <= 2000);

console.log('\n— runDigest (fake Firestore) —');
function fakeDb(seed) {
  const store = Object.assign({}, seed.docs);
  const mkQuery = (rows) => ({ where: (f, _o, v) => mkQuery(rows.filter((r) => r.data[f] === v)), limit: () => mkQuery(rows),
    get: async () => ({ docs: rows.map((r) => ({ id: r.id, data: () => r.data, ref: r.ref || { parent: { parent: { id: r.leadId } } } })) }) });
  const rowsOf = (coll) => Object.keys(store).filter((k) => k.startsWith(coll + '/') && k.split('/').length === 2).map((k) => ({ id: k.split('/')[1], data: store[k] }));
  const writes = [];
  return {
    writes, store,
    collection: (c) => mkQuery(rowsOf(c)),
    collectionGroup: () => mkQuery([]),
    doc: (p) => ({
      get: async () => ({ exists: p in store, data: () => store[p] }),
      create: async (d) => { if (p in store) { const e = new Error('already exists'); e.code = 6; throw e; } store[p] = d; writes.push(p); },
      set: async (d) => { store[p] = d; writes.push(p); },
    }),
  };
}
const seed = { docs: { 'companies/co1': { ownerId: 'own1' } } };
leads.forEach((l) => { seed.docs['leads/' + l.id] = Object.assign({ companyId: 'co1' }, l); });
invoices.forEach((i) => { seed.docs['invoices/' + i.id] = Object.assign({ companyId: 'co1' }, i); });
estimates.forEach((e) => { seed.docs['estimates/' + e.id] = Object.assign({ companyId: 'co1' }, e); });
deals.forEach((d) => { seed.docs['deal_rooms/' + d.id] = Object.assign({ userId: 'co1' }, d); });
const NOW = Date.parse('2026-10-26T11:30:00Z'); // 7:30 ET Monday

(async () => {
  const dry = fakeDb(seed);
  const rd = await W.runDigest({ db: dry, nowMs: NOW, live: false });
  ok('dry run computes but writes nothing', dry.writes.length === 0 && rd.filed === 0 && rd.companies === 1, JSON.stringify(rd));

  const live = fakeDb(seed);
  const r1 = await W.runDigest({ db: live, nowMs: NOW, live: true });
  const id = 'agent_inbox/ownerdigest_co1_2026-10-26';
  ok('live run files one report for the week', r1.filed === 1 && live.store[id] && live.store[id].kind === 'report', JSON.stringify(r1));
  ok('report is for the company, pending, not tied to a customer', live.store[id].companyId === 'co1' && live.store[id].status === 'pending' && live.store[id].leadId === null);
  ok('bell goes to the owner uid', live.store['notifications/ownerdigest_co1_2026-10-26'].userId === 'own1');
  const r2 = await W.runDigest({ db: live, nowMs: NOW, live: true });
  ok('a second run the same week files nothing new', r2.filed === 0 && r2.alreadyFiled === 1, JSON.stringify(r2));
  const r3 = await W.runDigest({ db: live, nowMs: NOW + 7 * 86400000, live: true });
  ok('negative control: the next Monday files a new report', r3.filed === 1 && ('agent_inbox/ownerdigest_co1_2026-11-02' in live.store));
  ok('nothing but agent_inbox and notifications is written', live.writes.every((p) => /^(agent_inbox|notifications)\//.test(p)));

  console.log('\n— jobs read fails (2026-10-23) —');
  // no lead carries a scheduledDate here, so a failed jobs read is the ONLY reason the calendar looks empty
  const seedNoDates = { docs: Object.assign({}, seed.docs) };
  leads.forEach((l) => { seedNoDates.docs['leads/' + l.id] = Object.assign({ companyId: 'co1' }, l, { scheduledDate: undefined }); });
  const failing = fakeDb(seedNoDates);
  failing.collectionGroup = () => ({ where() { return this; }, limit() { return this; }, get: async () => { throw new Error('jobs index missing'); } });
  WARNS.length = 0;
  const rf = await W.runDigest({ db: failing, nowMs: NOW, live: true });
  const ft = failing.store['agent_inbox/ownerdigest_co1_2026-10-26'];
  ok('a failed jobs read still files the rest of the digest', rf.filed === 1 && rf.failed === 0 && !!ft && /Collected 2026-10-19/.test(ft.text), JSON.stringify(rf));
  ok('the filed text says calendar jobs are unavailable', !!ft && /Calendar jobs unavailable this week/.test(ft.text), ft && ft.text);
  ok('the filed text never says "none" for jobs when the read failed', !!ft && !/Jobs on the calendar this week: none/.test(ft.text));
  ok('the failure is logged at warn level with the company', WARNS.some((w) => /jobs read failed/.test(w[0]) && w[1] && w[1].companyId === 'co1' && /jobs index missing/.test(w[1].msg)), JSON.stringify(WARNS));
  ok('negative control: a healthy empty calendar still says none', /Jobs on the calendar this week: none/.test(D.render(D.buildDigest({ leads: [], todayYmd: TODAY, jobsUnavailable: false })).text));
  ok('negative control: a healthy run (empty jobs read) is not flagged unavailable', !/unavailable/.test(live.store['agent_inbox/ownerdigest_co1_2026-10-26'].text));
  const partial = D.render(D.buildDigest({ leads, jobsByLead: null, jobsUnavailable: true, todayYmd: TODAY })).text;
  ok('with lead-dated jobs and a failed read, the list is kept and marked possibly incomplete', /2026-10-28 Ann Test/.test(partial) && /may be incomplete/.test(partial));

  console.log('\n— overlong digest is not cut silently —');
  const longName = 'Z'.repeat(300);
  const big = D.buildDigest({ leads: Array.from({ length: 12 }, (_, i) => ({ id: 'y' + i, firstName: longName + i, stage: 'new', scheduledDate: '2026-10-27' })), todayYmd: TODAY });
  const bigText = D.render(big).text;
  ok('an overlong digest stays within the inbox limit', bigText.length <= 2000, String(bigText.length));
  ok('an overlong digest ends with a visible cut-off marker', /Digest cut off/.test(bigText) && bigText.endsWith('not shown.]'), bigText.slice(-120));
  ok('negative control: a short digest has no cut-off marker', !/Digest cut off/.test(D.render(dig).text));

  console.log('\n— wiring —');
  const src = fs.readFileSync(path.join(ROOT, 'functions/owner-weekly-digest.js'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  ok('no send path: no Resend / Twilio / email / sms / draft', !/resend|twilio|sms|sendMail|draft/i.test(src));
  ok('gated by OWNER_WEEKLY_DIGEST_ENABLED === "true"', /OWNER_WEEKLY_DIGEST_ENABLED === 'true'/.test(src));
  ok('exported from index.js and listed in FUNCTIONS_INDEX.md', /exports\.ownerWeeklyDigest = require\('\.\/owner-weekly-digest'\)/.test(fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8')) && /`ownerWeeklyDigest`/.test(fs.readFileSync(path.join(ROOT, 'functions/FUNCTIONS_INDEX.md'), 'utf8')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
