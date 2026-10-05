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

  console.log('D3. "the CRM knows I called" (2026-10-03) — callWatch stays in step with Home');
  const r3 = [
    { id: 'td', leadId: 'LT', promises: [{ who: 'jo', text: 'send quote' }], taskDone: true, startedAtMs: NOW - H },
    { id: 'tu', leadId: 'LU', promises: [{ who: 'jo', text: 'send quote' }], taskDone: false, startedAtMs: NOW - H },
    { id: 'mc', leadId: 'LM', status: 'short', direction: 'inbound', startedAtMs: NOW - 3 * H },
    { id: 'mk', bucket: 'contact', phoneDigits: '5135550142', status: 'short', direction: 'inbound', startedAtMs: NOW - 3 * H },
    { id: 'mb', bucket: 'contact', phoneDigits: '5135550143', status: 'short', direction: 'inbound', startedAtMs: NOW - 3 * H },
    { id: 'cb', bucket: 'contact', phoneDigits: '5135550143', status: 'noted', direction: 'outbound', startedAtMs: NOW - 2 * H },
    { id: 'sp', bucket: 'unknown', callType: 'spam', status: 'noted', urgent: true, startedAtMs: NOW - H },
    { id: 'su', bucket: 'contact', callType: 'sub', urgent: true, status: 'noted', startedAtMs: NOW - H },
    { id: 'sp2', bucket: 'contact', callType: 'supplier', promises: [{ who: 'jo', text: 'order shingles' }], status: 'noted', startedAtMs: NOW - H },
  ];
  const ctxW = typeof W.reachIndex === 'function' ? W.reachIndex(r3) : null, ctxH = typeof HA.reachIndex === 'function' ? HA.reachIndex(r3) : null;
  const w3 = r3.filter((r) => W.callNeedsYou(r, NOW, ctxW)).map((r) => r.id).join();
  const h3 = r3.filter((r) => HA.callNeedsYou(r, NOW, ctxH)).map((r) => r.id).join();
  ok('same flags as Home: done task cleared, missed calls from a customer + contact, called-back cleared, spam + an urgent sub skipped, a supplier promise kept',
    w3 === h3 && w3 === 'tu,mc,mk,sp2', w3 + ' vs ' + h3);
  const n3 = W.newNeeds(r3, [], [], NOW - 4 * H, NOW);
  ok('newNeeds alerts the same set', n3.map((x) => x.id.replace('call:', '')).sort().join() === 'mc,mk,sp2,tu', n3.map((x) => x.id).join());
  ok('a missed call from a customer reads "missed call"', n3.find((x) => x.id === 'call:mc').why === 'missed call');
  const up = W.newNeeds([{ id: 'ux', urgent: true, urgentPushedAtMs: NOW - 30 * MIN, startedAtMs: NOW - H, notedAtMs: NOW - 30 * MIN }, { id: 'uy', urgent: true, startedAtMs: NOW - H, notedAtMs: NOW - 30 * MIN }], [], [], NOW - 2 * H, NOW);
  ok('an urgent call the immediate push already told is not alerted again', up.map((x) => x.id).join() === 'call:uy', up.map((x) => x.id).join());
  const one = W.alertFor([{ id: 'call:cube_abc', key: 'lead:L', kind: 'call', who: 'Ann', why: 'urgent' }], [], NOW);
  ok('one person → the push + bell open that call\'s card', one.clickUrl === '/pro/dashboard.html?call=cube_abc#/calls', one.clickUrl);
  ok('several people (or a Thursday call) → the Call Center list', W.alertFor(gn, [], NOW).clickUrl === '/pro/dashboard.html#/calls'
    && W.alertFor([{ id: 'thursday:t1', key: 'num:1', kind: 'thursday', who: 'X', why: 'y' }], [], NOW).clickUrl === '/pro/dashboard.html#/calls');

  // Done tasks from before onCallTaskWrite: callWatch reads the open calls'
  // tasks, mirrors taskDone, and leaves those people out of the alert.
  const reconcileTaskDone = require(path.join(ROOT, 'functions', 'call-watch.js'))._internal.reconcileTaskDone || (async () => -1);
  const store = new Map([['leads/LA/tasks/cube-ca', { done: true }], ['leads/LB/tasks/cube-cb2', { done: false }], ['leads/LA/tasks/sms-ta', { done: true }]]);
  const writes = [];
  const fdb = {
    doc: (p) => ({ p }),
    getAll: async (...refs) => refs.map((r) => ({ exists: store.has(r.p), data: () => store.get(r.p) })),
    collection: (c) => ({ doc: (id) => ({ set: async (v) => { writes.push([c, id, v]); } }) }),
  };
  const rc = [{ id: 'ca', leadId: 'LA', promises: [{ who: 'jo', text: 'x' }], startedAtMs: NOW - H }, { id: 'cb2', leadId: 'LB', promises: [{ who: 'jo', text: 'y' }], startedAtMs: NOW - H }];
  const rt = [{ id: 'ta', leadId: 'LA', channel: 'text', promises: [{ who: 'jo', text: 'z' }], startedAtMs: NOW - H }];
  const nRec = await reconcileTaskDone({ db: fdb, calls: rc, texts: rt, nowMs: NOW, live: true });
  ok('reconcile: done tasks mirrored onto the call AND the text day; an open task is not', nRec === 2 && rc[0].taskDone === true && rt[0].taskDone === true && rc[1].taskDone === undefined
    && JSON.stringify(writes) === JSON.stringify([['phone_calls', 'ca', { taskDone: true }], ['phone_text_days', 'ta', { taskDone: true }]]), JSON.stringify(writes));
  ok('…and the alert then leaves them out', W.newNeeds(rc, rt, [], NOW - 2 * H, NOW).map((x) => x.id).join() === 'call:cb2');
  writes.length = 0;
  const rc2 = [{ id: 'ca', leadId: 'LA', promises: [{ who: 'jo', text: 'x' }], startedAtMs: NOW - H }];
  await reconcileTaskDone({ db: fdb, calls: rc2, texts: [], nowMs: NOW, live: false });
  ok('dry run mirrors in memory only (no writes)', rc2[0].taskDone === true && writes.length === 0);

  console.log('E. wiring');
  const src = read('functions/call-watch.js');
  ok('every 2 hours, 8 AM-8 PM Eastern, heartbeat-wrapped', /schedule: '0 8-20\/2 \* \* \*', timeZone: 'America\/New_York'/.test(src) && /require\('\.\/integrations\/heartbeat'\)/.test(src));
  // It READS Twilio's delivery results (GET only, 2026-10-02) but never sends.
  ok('alerts only Jo: a bell notification + push; never SMS or email', /collection\('notifications'\)\.add/.test(src) && /sendCustomNotification/.test(src)
    && !/resend|sendSms|email_queue|alertJoe|messages\.create|method:\s*'POST'/i.test(src) && (src.match(/fetch\(/g) || []).length === 1 && /method: 'GET'/.test(src));

  console.log('E2. texts that did not deliver (0 of 23 arrived while the CRM said "sent")');
  const t = (status, code, ago, dir) => ({ status, error_code: code, direction: dir || 'outbound-api', date_sent: new Date(NOW - (ago || H)).toUTCString() });
  const blocked = W.smsProblems([t('undelivered', 30034), t('undelivered', 30034), t('failed', 21608)], NOW);
  ok('undelivered / failed texts raise one problem, the main reason in plain words', blocked.length === 1 && blocked[0].key === 'sms_undelivered'
    && /3 texts in the last day did not deliver \(none did\)/.test(blocked[0].text) && /not registered for business texting/.test(blocked[0].text) && /TWILIO-A2P-REGISTRATION/.test(blocked[0].text), JSON.stringify(blocked));
  ok('delivered texts, a STOP reply (21610), inbound and day-old messages raise nothing',
    W.smsProblems([t('delivered'), t('undelivered', 21610), t('undelivered', 30034, H, 'inbound'), t('undelivered', 30034, 2 * D)], NOW).length === 0);
  ok('a mixed day says how many did arrive', /1 text in the last day did not deliver \(2 did\)/.test(W.smsProblems([t('delivered'), t('delivered'), t('undelivered', 30007)], NOW)[0].text));
  ok('repeats at most once a day (not every 6 h like pipeline problems)', W.problemsToTell(blocked, { sms_undelivered: NOW - 7 * H }, NOW).length === 0
    && W.problemsToTell(blocked, { sms_undelivered: NOW - 25 * H }, NOW).length === 1);
  const sa = W.alertFor([], blocked, NOW);
  ok('the alert title says texts are not delivering, not "call updates are behind"', /texts are not delivering/.test(sa.title) && !/call updates/.test(sa.title) && sa.priority === 'high', sa.title);
  const dv = W.deliveryBySid([{ sid: 'SM1', status: 'undelivered', error_code: 30034, direction: 'outbound-api' }, { sid: 'SM2', status: 'delivered', direction: 'outbound-api' },
    { sid: 'SM3', status: 'queued', direction: 'outbound-api' }, { sid: 'SM4', status: 'delivered', direction: 'inbound' }, { sid: 'SM5', status: 'failed', error_code: 21608, direction: 'outbound-api' }]);
  ok('final delivery per message id: delivered / undelivered:<code> / failed:<code>; queued and inbound skipped',
    JSON.stringify(dv) === JSON.stringify({ SM1: 'undelivered:30034', SM2: 'delivered', SM5: 'failed:21608' }), JSON.stringify(dv));
  const la = read('functions/lead-alert.js');
  ok('lead alerts keep the Twilio message id on the outbox row', la.includes('smsSid: outcomes.smsSid || null') && la.includes('outcomes.smsSid = (msg && msg.sid) || null'));
  const hb = read('docs/pro/js/alert-health-banner.js');
  ok('the alert health banner counts an undelivered text and names A2P on 30034/21608',
    hb.includes('isFailed(d.smsStatus) || smsUndelivered(d)') && hb.includes(':30034$|:21608$') && hb.includes('not registered for business texting'));
  ok('callWatch binds the Twilio secrets it reads', /secrets: \[TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN\]/.test(src) && /texts: recentTexts/.test(src));
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
    const ranBefore = passed + failed;
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
    // The ledger said "sent"; the watcher stamps what the carrier did.
    await db.doc('alert_outbox/obx1').set({ kind: 'lead-alert', smsStatus: 'sent', smsSid: 'SMzz1', createdAt: new Date(at - H) });
    await db.doc('alert_outbox/obx2').set({ kind: 'lead-alert', smsStatus: 'sent', smsSid: 'SMzz2', createdAt: new Date(at - H) });
    const texts = async () => [
      { sid: 'SMzz1', status: 'undelivered', error_code: 30034, direction: 'outbound-api', date_sent: new Date(at - H).toUTCString() },
      { sid: 'SMzz2', status: 'delivered', direction: 'outbound-api', date_sent: new Date(at - H).toUTCString() },
    ];
    await runWatch({ db, nowMs: at + 20 * MIN, live: true, push: async () => ({ sent: 1 }), texts });
    const o1 = (await db.doc('alert_outbox/obx1').get()).data(), o2 = (await db.doc('alert_outbox/obx2').get()).data();
    ok('alert_outbox rows get the real result: undelivered:30034 / delivered', o1.smsDelivery === 'undelivered:30034' && o2.smsDelivery === 'delivered' && o1.smsStatus === 'sent', JSON.stringify([o1.smsDelivery, o2.smsDelivery]));
    // CI runs this suite in the emulator-orphan-suites job (ci.yml), which sets
    // NBD_REQUIRE_EMULATOR=1: there the section must run in full, never shrink.
    const ran = passed + failed - ranBefore;
    console.log('F. emulator section ran ' + ran + ' checks');
    if (process.env.NBD_REQUIRE_EMULATOR) ok('F. all 4 end-to-end checks ran', ran === 4, 'ran ' + ran);
  } else if (process.env.NBD_REQUIRE_EMULATOR) {
    // Fail, never skip, where CI promised an emulator (R1-10-8, 2026-10-05:
    // this section printed "skipped" in every CI run until then).
    ok('F. NBD_REQUIRE_EMULATOR is set but FIRESTORE_EMULATOR_HOST is not — the end-to-end section cannot run', false);
  } else {
    console.log('F. (skipped — no FIRESTORE_EMULATOR_HOST)');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
