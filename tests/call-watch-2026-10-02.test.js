#!/usr/bin/env node
/**
 * callWatch (Jo, 2026-10-02: "a scheduled check on calls every few hours so
 * nothing gets missed throughout the day or slow updates") —
 * functions/call-watch.js + call-watch-logic.js.
 *
 * Run: node tests/call-watch-2026-10-02.test.js  (section E needs FIRESTORE_EMULATOR_HOST)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

(async () => {
  // Friday 2026-10-02, 2:00 PM Eastern.
  const NOW = Date.parse('2026-10-02T18:00:00Z');
  const MIN = 60000, H = 3600000, D = 86400000;

  console.log('A. the "needs you" rule is the Calls screen\'s rule');
  const rows = [
    { id: 'u', urgent: true, startedAtMs: NOW - H },
    { id: 'p', promises: [{ who: 'jo', text: 'send the quote' }], startedAtMs: NOW - H, leadId: 'L1' },
    { id: 'pt', promises: [{ who: 'them', text: 'will call back' }], startedAtMs: NOW - H, leadId: 'L1' },
    { id: 'f', followUpDate: '2026-10-02', startedAtMs: NOW - D, leadId: 'L1' },
    { id: 'ff', followUpDate: '2026-10-09', startedAtMs: NOW - D, leadId: 'L1' },
    { id: 'i', bucket: 'insurance', startedAtMs: NOW - H },
    { id: 'm', bucket: 'unknown', status: 'short', direction: 'inbound', startedAtMs: NOW - H },
    { id: 'mo', bucket: 'unknown', status: 'short', direction: 'outbound', startedAtMs: NOW - H },
    { id: 'h', urgent: true, handledAtMs: NOW - MIN, startedAtMs: NOW - H },
    { id: 'pe', urgent: true, status: 'personal', startedAtMs: NOW - H },
    { id: 'old', urgent: true, startedAtMs: NOW - 15 * D },
    { id: 'c', bucket: 'customer', leadId: 'L2', startedAtMs: NOW - H },
  ];
  const mine = rows.filter((r) => W.callNeedsYou(r, NOW)).map((r) => r.id).join();
  const screen = rows.filter((r) => HA.callNeedsYou(r, NOW)).map((r) => r.id).join();
  ok('same calls flagged as the Calls screen\'s "Needs attention"', mine === screen && mine === 'u,p,f,i,m', mine + ' vs ' + screen);

  console.log('B. nothing missed — only NEW items since the last check');
  const calls = [
    Object.assign({ contactName: 'Maria Lopez', createdAtMs: NOW - 30 * MIN }, rows[0]),
    Object.assign({ contactName: 'Bob', createdAtMs: NOW - 5 * H, notedAtMs: NOW - 20 * MIN }, rows[1]),   // noted after the last check → new
    Object.assign({ phoneDigits: '8595550147', createdAtMs: NOW - 3 * H }, rows[6]),                    // before the last check → old
  ];
  const texts = [{ id: 't1', promises: [{ who: 'jo', text: 'text the photos' }], startedAtMs: NOW - H, notedAtMs: NOW - 10 * MIN, contactName: 'Kim' }];
  const thursday = [
    { id: 'th1', status: 'processed', reviewed: false, urgent: true, from: '+1 859 555 0199', processedAt: new Date(NOW - 15 * MIN), startedAt: new Date(NOW - 20 * MIN) },
    { id: 'th2', status: 'processed', reviewed: true, processedAt: new Date(NOW - 15 * MIN) },
    { id: 'th3', status: 'processing', reviewed: false, startedAt: new Date(NOW - 15 * MIN) },
  ];
  const since = NOW - 2 * H;
  const needs = W.newNeeds(calls, texts, thursday, since, NOW);
  ok('new since the last check: the urgent call, a promise noted after it, a text promise, an unreviewed Thursday call',
    needs.map((n) => n.id).sort().join() === ['call:u', 'call:p', 'text:t1', 'thursday:th1'].sort().join(), needs.map((n) => n.id).join());
  ok('each says who and why', needs.find((n) => n.id === 'call:p').why === 'you promised something' && needs.find((n) => n.id === 'thursday:th1').why.includes('urgent') && needs.find((n) => n.id === 'call:u').who === 'Maria Lopez');
  ok('missed inbound call reads "missed call"', W.reasonFor(rows[6], NOW) === 'missed call');

  console.log('C. no slow updates — the pipeline is keeping up');
  const gatesOn = { ingest: true, transcribe: true, textNotes: false };
  const healthy = { lastRunAtMs: NOW - 20 * MIN, lastRun: { failed: 0 }, lastTranscribeAtMs: NOW - 25 * MIN, lastTranscribe: { failed: 0 } };
  ok('a healthy pipeline raises nothing', W.pipelineProblems(healthy, null, [], [], NOW, gatesOn).length === 0);
  const stale = W.pipelineProblems({ lastRunAtMs: NOW - 2 * H, lastTranscribeAtMs: NOW - 3 * H }, null, [], [], NOW, gatesOn).map((p) => p.key);
  ok('copy + transcripts not run in 75+ min → stale', stale.join() === 'ingest_stale,transcribe_stale', stale.join());
  const fail = W.pipelineProblems({ lastRunAtMs: NOW - 10 * MIN, lastRun: { failed: 2 }, lastTranscribeAtMs: NOW - 10 * MIN, lastTranscribe: { failed: 1 } }, null, [], [], NOW, gatesOn).map((p) => p.key);
  ok('failures in the last run are reported', fail.join() === 'ingest_failed,transcribe_failed', fail.join());
  const behind = W.pipelineProblems(Object.assign({}, healthy, { lastTranscribe: { failed: 0, rateLimited: true } }), null, [{ startedAtMs: NOW - 8 * H, createdAtMs: NOW - 7 * H }, { startedAtMs: NOW - H }], [], NOW, gatesOn);
  ok('calls waiting 6+ h for a transcript, with the cap / rate limit named', behind.length === 1 && behind[0].key === 'transcripts_behind' && /2 call/.test(behind[0].text) && /rate limit/.test(behind[0].text), JSON.stringify(behind));
  ok('a paused or switched-off job is not "stale"', W.pipelineProblems({ paused: true }, null, [], [], NOW, gatesOn).length === 0 && W.pipelineProblems({}, null, [], [], NOW, { ingest: false, transcribe: false }).length === 0);
  const thuP = W.pipelineProblems(healthy, null, [], [{ status: 'processing', processingStartedAt: new Date(NOW - 45 * MIN) }, { status: 'failed', processedAt: new Date(NOW - H) }, { status: 'failed', processedAt: new Date(NOW - 3 * D) }], NOW, gatesOn).map((p) => p.key);
  ok('Thursday: stuck 30+ min and failed today are reported; an old failure is not', thuP.join() === 'thursday_stuck,thursday_failed', thuP.join());
  ok('texts: checked only once text notes are on', W.pipelineProblems(healthy, { lastRunAtMs: NOW - 5 * H }, [], [], NOW, gatesOn).length === 0
    && W.pipelineProblems(healthy, { lastRunAtMs: NOW - 5 * H }, [], [], NOW, Object.assign({}, gatesOn, { textNotes: true }))[0].key === 'texts_stale');

  console.log('D. one alert, only when something is new');
  ok('nothing new → no alert', W.alertFor([], [], NOW) === null);
  const al = W.alertFor(needs, [], NOW);
  ok('alert: title counts people, lines say who + why, urgent → high', /4 people need you/.test(al.title) && /Maria Lopez — urgent/.test(al.message) && al.priority === 'high', JSON.stringify(al));

  console.log('D2. grouped by person (Jo, 2026-10-02: "group them by customer")');
  const g = [
    { id: 'g1', leadId: 'LX', contactName: 'Ann', promises: [{ who: 'jo', text: 'stop by' }], startedAtMs: NOW - 3 * D },
    { id: 'g2', leadId: 'LX', contactName: 'Ann', promises: [{ who: 'jo', text: 'text quote' }], startedAtMs: NOW - D },
    { id: 'g3', leadId: 'LX', contactName: 'Ann', urgent: true, startedAtMs: NOW - H },
    { id: 'g4', bucket: 'unknown', status: 'noted', phoneDigits: '+1 (513) 555-0101', startedAtMs: NOW - 2 * H },
    { id: 'g5', bucket: 'unknown', status: 'noted', phoneDigits: '5135550101', startedAtMs: NOW - 5 * H },
    { id: 'g6', leadId: 'LY', promises: [{ who: 'jo', text: 'call back' }], startedAtMs: NOW - 4 * H },
  ];
  const groups = HA.groupNeeds(g, NOW);
  ok('six open calls are three people', HA.callersNeedingYou(g, NOW) === 3 && HA.callsNeedingYou(g, NOW) === 6);
  ok('a person = their customer, else the last 10 digits of the number', groups.map((x) => x.key).join() === 'lead:LX,num:5135550101,lead:LY', groups.map((x) => x.key).join());
  ok('newest person first; their calls newest first', groups[0].calls.map((c) => c.id).join() === 'g3,g2,g1');
  ok('callWatch keys people exactly as Home does', g.every((c) => W.callerKey(c) === HA.callerKey(c)));
  ok('Home banner says people', /3 people need you/.test(HA.stripHtml({ calls: 3 })) && /1 person needs you/.test(HA.stripHtml({ calls: 1 })));
  const gn = W.newNeeds(g, [], [], NOW - 4 * D, NOW);
  const ga = W.alertFor(gn, [], NOW);
  ok('the alert names each person once; extra calls ride along', /3 people need you/.test(ga.title) && (ga.message.match(/• /g) || []).length === 3 && /Ann — urgent \(\+2 more calls\)/.test(ga.message), ga.message);
  const probs = [{ key: 'ingest_stale', text: 'x' }];
  ok('a standing problem repeats at most every 6 h', W.problemsToTell(probs, { ingest_stale: NOW - 2 * H }, NOW).length === 0 && W.problemsToTell(probs, { ingest_stale: NOW - 7 * H }, NOW).length === 1 && W.problemsToTell(probs, {}, NOW).length === 1);
  ok('watch hours 8 AM-8 PM Eastern only', W.inWatchHours(NOW) && !W.inWatchHours(Date.parse('2026-10-03T02:00:00Z')) && W.inWatchHours(Date.parse('2026-10-03T00:00:00Z')));

  console.log('E. wiring');
  const src = read('functions/call-watch.js');
  ok('every 2 hours, 8 AM-8 PM Eastern, heartbeat-wrapped', /schedule: '0 8-20\/2 \* \* \*', timeZone: 'America\/New_York'/.test(src) && /require\('\.\/integrations\/heartbeat'\)/.test(src));
  ok('alerts only Jo: a bell notification + push; never SMS or email', /collection\('notifications'\)\.add/.test(src) && /sendCustomNotification/.test(src) && !/twilio|resend|sendSms|email_queue|alertJoe/i.test(src));
  ok('a failure throws so the heartbeat reports /fail', /throw e; \/\/ let the heartbeat report \/fail/.test(src));
  ok('gated: CALL_WATCH_ENABLED (registered, on in prod)', /process\.env\.CALL_WATCH_ENABLED === 'true'/.test(src) && /CALL_WATCH_ENABLED/.test(read('functions/cron-gates.js')) && /^CALL_WATCH_ENABLED=true$/m.test(read('functions/.env.nobigdeal-pro')));
  ok('exported from index.js', /exports\.callWatch = require\('\.\/call-watch'\)\.callWatch;/.test(read('functions/index.js')));
  // The emulator never enforces indexes; prod 500'd the first run (FAILED_PRECONDITION)
  // on an unordered userId + startedAtMs range. Every range query must name its
  // order and match a composite index in firestore.indexes.json.
  const idx = JSON.parse(read('firestore.indexes.json')).indexes;
  const ranges = [...src.matchAll(/collection\('(\w+)'\)\.where\('(\w+)', '==', \w+\)\.where\('(\w+)', '>=', \w+\)([^\n]*)/g)];
  ok('found the two 14-day range queries', ranges.length === 2, ranges.length);
  for (const [, coll, eq, rng, rest] of ranges) {
    const m = rest.match(/\.orderBy\('(\w+)', '(asc|desc)'\)/);
    const dir = m && m[1] === rng ? (m[2] === 'desc' ? 'DESCENDING' : 'ASCENDING') : 'ASCENDING';
    const has = idx.some((i) => i.collectionGroup === coll && i.fields.length === 2 &&
      i.fields[0].fieldPath === eq && i.fields[1].fieldPath === rng && i.fields[1].order === dir);
    ok(`${coll}: ${eq} == + ${rng} range (${dir}) has a deployed index`, has);
  }
  const bell = read('docs/pro/js/notif-bell.js');
  ok('the bell shows 📞 and opens the Call Center', /call_watch: '📞'/.test(bell) && /n\.type === 'call_watch' \? '\/pro\/dashboard\.html#\/calls'/.test(bell));

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log('F. emulator end to end');
    const { initializeApp, getApps } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
    if (!getApps().length) initializeApp({ projectId: 'nbd-test' });
    const { getFirestore } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
    const db = getFirestore();
    process.env.CALL_CENTER_INGEST_ENABLED = 'true'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'true';
    const { runWatch } = require(path.join(ROOT, 'functions', 'call-watch.js'))._internal;
    const OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';
    const now = Date.now();
    // Pin to a watch hour so the run doesn't skip as "off hours".
    const at = (() => { const d = new Date(now); const et = Number(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })); return now + ((14 - et) * H); })();
    await db.doc('integrations/callCenter').set({ lastRunAtMs: at - 3 * H, lastRun: { failed: 0 }, lastTranscribeAtMs: at - 10 * MIN, lastTranscribe: { failed: 0 } });
    await db.doc('phone_calls/cw1').set({ userId: OWNER, companyId: OWNER, urgent: true, contactName: 'Maria', startedAtMs: at - 20 * MIN, createdAtMs: at - 15 * MIN, status: 'noted' });
    await db.doc('phone_calls/cw2').set({ userId: 'someone-else', companyId: 'someone-else', urgent: true, startedAtMs: at - 20 * MIN, createdAtMs: at - 15 * MIN });
    await db.doc('integrations/callWatch').set({ lastCheckAtMs: at - 2 * H });
    const pushes = [];
    const r1 = await runWatch({ db, nowMs: at, live: true, push: async (...a) => { pushes.push(a); return { sent: 1 }; } });
    const bells = (await db.collection('notifications').where('type', '==', 'call_watch').get()).docs.map((d) => d.data());
    ok('run 1: alerts Maria (own calls only) + the stale copy; one bell, one push', r1.state === 'alerted' && r1.needs === 1 && bells.length === 1 && /Maria — urgent/.test(bells[0].message) && /haven't been copied/.test(bells[0].message) && pushes.length === 1 && !/someone/.test(bells[0].message), JSON.stringify(r1) + ' ' + JSON.stringify(bells.map((b) => b.message)));
    const r2 = await runWatch({ db, nowMs: at + 5 * MIN, live: true, push: async (...a) => { pushes.push(a); return { sent: 1 }; } });
    const bells2 = (await db.collection('notifications').where('type', '==', 'call_watch').get()).size;
    ok('run 2 right after: nothing new, the standing problem not repeated → quiet', r2.state === 'quiet' && bells2 === 1 && pushes.length === 1, JSON.stringify(r2));
    const dry = await runWatch({ db, nowMs: at + 10 * MIN, live: false, push: async () => { throw new Error('must not push'); } });
    ok('gate off → computes and logs only', dry.state === 'dry_run');
  } else {
    console.log('F. (skipped — no FIRESTORE_EMULATOR_HOST)');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
