#!/usr/bin/env node
/**
 * officePlanner end to end under the Firestore emulator (2026-11-25, roadmap
 * step 17 part B). The node-bucket suite tests/office-planner-2026-11-25.test.js
 * covers the plan, the caps, dark, softFail and the opt-out; this one runs the
 * real run against the real crmMcp filing path (runTool -> fileItemOnce):
 * each lane files once, the second run dedupes, a decided item is not
 * re-filed inside its window (counted from the decision), drafts land "Not checked by Quinn", every item
 * carries keyPlatform 'server' and its dedupe key, an opted-out company is
 * untouched, and no review ask is ever drafted.
 * Emulator bucket (tests/ci-manifest.json "emulator"; ci.yml emulator steps).
 *
 * Run: cd tests && npm run test:officeplanner
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));

(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('needs the Firestore emulator: cd tests && npm run test:officeplanner'); process.exit(1); }
  const { initializeApp, getApps } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
  if (!getApps().length) initializeApp({ projectId: 'nbd-test' });
  const { getFirestore } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
  const db = getFirestore();
  const P = require(path.join(ROOT, 'functions', 'office-planner.js'))._test;

  const DAY = 86400000;
  const now = Date.now();
  const TZ = 'America/New_York';
  const A = 'co-plan-a', B = 'co-plan-b';
  const ymd = (t) => L.dayInZone(t, TZ);
  // A paying tenant with its own name and zone; B never opted in.
  await db.doc('companyProfile/' + A).set({ companyName: 'Acme Roofing', timezone: TZ });
  await db.doc('subscriptions/' + A).set({ status: 'active', plan: 'pro' });
  await db.doc('agent_settings/' + A).set({ officePlanner: true });
  await db.doc('companyProfile/' + B).set({ companyName: 'Bravo Exteriors', timezone: TZ });
  await db.doc('subscriptions/' + B).set({ status: 'active', plan: 'pro' });
  await db.doc('agent_settings/' + B).set({ enabled: true });
  const seed = async (co, id, o) => db.doc('leads/' + id).set(Object.assign({ companyId: co, userId: co, firstName: 'F' + id, lastName: 'L', stage: 'negotiating', createdAt: new Date(now - 90 * DAY), phone: '5135550100', tcpaConsent: true }, o));
  for (const co of [A, B]) {
    const p = co === A ? 'a' : 'b';
    await seed(co, p + 'New', { stage: 'new', createdAt: new Date(now - 2 * 3600000) });
    await seed(co, p + 'Od', { followUp: ymd(now - 10 * DAY), jobValue: 7000 });
    await seed(co, p + 'Q', { stage: 'estimate_sent_cash' });
    await seed(co, p + 'Pj30', { stage: 'closed', firstName: 'Pat', completedAt: new Date(now - 30 * DAY) });
    await seed(co, p + 'Pj1y', { stage: 'closed', firstName: 'Yan', completedAt: new Date(now - 365 * DAY) });
    await db.doc('estimates/' + p + 'E1').set({ companyId: co, userId: co, leadId: p + 'Q', total: 12000, createdAt: new Date(now - 20 * DAY) });
    await db.doc('deal_rooms/' + p + 'D1').set({ userId: co, estimateId: p + 'E1', status: 'sent', sentAt: new Date(now - 10 * DAY), createdAt: new Date(now - 10 * DAY) });
  }
  const items = async (co) => (await db.collection('agent_inbox').where('companyId', '==', co).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));

  console.log('first run');
  const r1 = await P.runOfficePlanner({ db, nowMs: now, enabled: true });
  ok('the run reports one company and no failures', r1.companies === 1 && r1.failed === 0, JSON.stringify(r1));
  const first = await items(A);
  const byKey = {};
  first.forEach((i) => { byKey[i.dedupeKey] = i; });
  const want = { ['lead:first:aNew']: ['reminder', 'marcus'], ['radar:quiet:aE1']: ['reminder', 'marcus'], ['radar:followup:aOd']: ['reminder', 'tucker'], ['postjob:30d:aPj30']: ['draft_text', 'tucker'], ['postjob:1y:aPj1y']: ['draft_text', 'tucker'] };
  ok('each lane filed exactly one item under its dedupe key', first.length === 5 && Object.keys(want).every((k) => byKey[k]), JSON.stringify(first.map((i) => i.dedupeKey)));
  ok('the right kind, by the bot that owns the lane, pending',
    Object.keys(want).every((k) => byKey[k] && byKey[k].kind === want[k][0] && byKey[k].botId === want[k][1] && byKey[k].status === 'pending'));
  ok('every item is stamped keyPlatform "server" and the server key id', first.every((i) => i.keyPlatform === 'server' && i.keyId === P.SERVER_KEY_ID.slice(0, 12)));
  const drafts = first.filter((i) => i.kind === 'draft_text');
  ok('post-job drafts land "Not checked by Quinn" (the step-8 gate)', drafts.length === 2 && drafts.every((i) => L.quinnState(i) === 'unchecked' && L.quinnLabel(i) === 'Not checked by Quinn'));
  ok('the owner cannot send one without the extra confirm tap', drafts.every((i) => !!L.sendGateProblem(i, false) && L.sendGateProblem(i, true) === null));
  ok('drafts carry the company name and the STOP line, and are never a review ask',
    drafts.every((i) => /Acme Roofing/.test(i.text) && L.hasStopLine(i.text) && i.purpose !== 'review_ask' && !L.isReviewAskDraft(i)));
  ok('reminders are due today', first.filter((i) => i.kind === 'reminder').every((i) => i.dueDate === ymd(now)));
  ok('an opted-out company is untouched', (await items(B)).length === 0);
  const audits = (await db.collection('agent_audit').where('companyId', '==', A).get()).docs.map((d) => d.data());
  ok('each filing has an audit row on the server platform', audits.filter((a) => a.platform === 'server').length >= 5);
  const cap = (await db.doc(P.capDocFor(A)).get()).data() || {};
  ok('the daily filing count lives on the server cap doc', Object.values(cap.filedByDay || {}).reduce((s, n) => s + n, 0) === 5, JSON.stringify(cap));
  ok('no agent_keys doc was made for the server key', (await db.collection('agent_keys').where('companyId', '==', A).get()).empty);

  console.log('second run');
  await P.runOfficePlanner({ db, nowMs: now + 3600000, enabled: true });
  ok('a second run files nothing new', (await items(A)).length === 5);

  console.log('decided items');
  // The inbox stamps decidedAt on every decision (docs/pro/js/agent-inbox.js).
  await db.doc('agent_inbox/' + byKey['radar:followup:aOd'].id).update({ status: 'dismissed', decidedAt: new Date(now) });
  await db.doc('agent_inbox/' + byKey['lead:first:aNew'].id).update({ status: 'approved', decidedAt: new Date(now) });
  await P.runOfficePlanner({ db, nowMs: now + 2 * 3600000, enabled: true });
  ok('a dismissed follow-up is not re-filed inside 7 days; an approved first contact never is', (await items(A)).length === 5);
  const lock = db.doc('agent_inbox_keys/' + L.dedupeLockId(A, 'radar:followup:aOd'));
  // Filed 10 days ago, dismissed just now: the 7 days start from the decision.
  await lock.update({ updatedAt: new Date(now - 10 * DAY) });
  await P.runOfficePlanner({ db, nowMs: now + 2 * 3600000 + 60000, enabled: true });
  ok('a reminder that waited 10 days and was just dismissed is not filed again straight away', (await items(A)).length === 5);
  await lock.update({ updatedAt: new Date(now - 8 * DAY) });
  await db.doc('agent_inbox/' + byKey['radar:followup:aOd'].id).update({ decidedAt: new Date(now - 8 * DAY) });
  await db.doc('leads/aNew').update({ createdAt: new Date(now - 3600000) });
  await P.runOfficePlanner({ db, nowMs: now + 3 * 3600000, enabled: true });
  const after = await items(A);
  ok('7 days later the still-overdue follow-up is reminded again; the first contact still is not',
    after.length === 6 && after.filter((i) => i.dedupeKey === 'radar:followup:aOd').length === 2 && after.filter((i) => i.dedupeKey === 'lead:first:aNew').length === 1,
    JSON.stringify(after.map((i) => i.dedupeKey + ':' + i.status)));

  console.log('switches');
  await db.doc('agent_settings/' + A).update({ pausedPlatforms: ['server'] });
  await lock.update({ updatedAt: new Date(now - 30 * DAY) });
  await db.doc('agent_inbox/' + after.find((i) => i.dedupeKey === 'radar:followup:aOd' && i.status === 'pending').id).update({ status: 'dismissed', decidedAt: new Date(now - 30 * DAY) });
  const rp = await P.runOfficePlanner({ db, nowMs: now + 4 * 3600000, enabled: true });
  ok('pausing the server platform stops the planner', rp.paused === 1 && (await items(A)).length === 6, JSON.stringify(rp));
  await db.doc('agent_settings/' + A).update({ pausedPlatforms: [], officePlanner: false });
  const ro = await P.runOfficePlanner({ db, nowMs: now + 5 * 3600000, enabled: true });
  ok('turning the opt-in off stops it', ro.companies === 0 && (await items(A)).length === 6);
  await db.doc('agent_settings/' + A).update({ officePlanner: true });
  const rd = await P.runOfficePlanner({ db, nowMs: now + 6 * 3600000, enabled: false });
  ok('dark: nothing filed', rd.dark === true && (await items(A)).length === 6);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
