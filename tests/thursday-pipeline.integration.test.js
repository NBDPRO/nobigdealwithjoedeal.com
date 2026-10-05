/**
 * tests/thursday-pipeline.integration.test.js — the REAL Thursday handlers
 * (functions/integrations/thursday.js) driven in-process against the
 * Firestore emulator, with Bland + Claude stubbed at `fetch`.
 *
 * Proves end to end what the unit suite can only prove per function:
 *   1. a signed webhook queues exactly one thursday_calls doc; a bad
 *      signature is refused; a redelivery is a no-op;
 *   2. the trigger attaches a known caller (Castellano) to HER lead — never to
 *      another tenant's lead with the same phone — with a task + activity;
 *   3. a new caller becomes leads/bland_calls__{id} scoped to NBD, with the
 *      canonical source + intake;
 *   4. a Thumbtack-proxy caller (Halina) is a possible match, not a duplicate;
 *   5. reprocessing never duplicates the lead or re-opens a completed task;
 *   6. spam is logged only;
 *   7. thursdayCallAction enforces viewer / tenant / possible-match rules.
 *
 * Run (CI job "Auth/Firestore emulator suites"):
 *   firebase emulators:exec --only firestore --project demo-nbd-thursday 'node ./thursday-pipeline.integration.test.js'
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('✗ FIRESTORE_EMULATOR_HOST must be set (emulator only)');
  process.exit(1);
}
const PROJECT = process.env.THURSDAY_TEST_PROJECT_ID || process.env.GCLOUD_PROJECT || 'demo-nbd-thursday';
{
  const rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT)) {
    console.error('✗ refusing to run against the app project "' + PROJECT + '"');
    process.exit(1);
  }
}
process.env.GCLOUD_PROJECT = PROJECT;
const WEBHOOK_SECRET = 'whsec_test_' + crypto.randomBytes(6).toString('hex');
process.env.BLAND_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.BLAND_API_KEY = 'bland_test_key';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
delete process.env.RESEND_API_KEY;

const freq = createRequire(path.join(ROOT, 'functions', 'package.json'));
freq('firebase-admin/app').initializeApp({ projectId: PROJECT });
const db = freq('firebase-admin/firestore').getFirestore();

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OTHER = 'otherTenantZZ00000000000001';

// ── fetch stub: Claude answers from a per-call script; Bland has no extra data.
const EXTRACTIONS = {};
const fetchLog = [];
global.fetch = async (url, init) => {
  const u = String(url);
  fetchLog.push(u);
  if (u.startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(init.body);
    const text = body.messages[0].content;
    const key = Object.keys(EXTRACTIONS).find((k) => text.indexOf(k) !== -1);
    const out = key ? EXTRACTIONS[key] : { caller_type: 'spam' };
    return new Response(JSON.stringify({
      type: 'message', model: 'claude-opus-5', stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200 },
      content: [{ type: 'text', text: JSON.stringify(out) }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('https://api.bland.ai/')) return new Response('{"error":"not found"}', { status: 404 });
  return new Response('nope', { status: 404 });
};

const T = require(path.join(ROOT, 'functions/integrations/thursday-logic.js'));
const fns = require(path.join(ROOT, 'functions/integrations/thursday.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

const RUN = 'zzthu' + Date.now().toString(36);
function callId(tag) { return RUN + '-' + tag; }

function payload(id, over) {
  return Object.assign({
    call_id: id, from: '+15135550142', to: '+15139405589', inbound: true, call_length: 2.5,
    started_at: '2026-09-26T14:00:00Z', summary: 'Caller asked about a roof leak.',
    recording_url: 'https://api.bland.ai/v1/recordings/' + id,
    transcripts: [
      { user: 'assistant', text: 'Thanks for calling No Big Deal, this is Thursday.' },
      { user: 'user', text: 'Hi there, I am calling because I have a problem with my roof and I would like somebody to come look at it soon please.' },
    ],
  }, over || {});
}

async function postWebhook(body, sigOverride) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = sigOverride !== undefined ? sigOverride : crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const res = { code: 0, body: null, headers: {},
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    end() { return this; }, set(k, v) { this.headers[k] = v; return this; } };
  await fns.thursdayWebhook({ method: 'POST', rawBody: raw, body, headers: { 'x-webhook-signature': sig } }, res);
  return res;
}

async function runTrigger(id) {
  const snap = await db.doc('thursday_calls/' + T.callDocId(id)).get();
  await fns.thursdayCallProcess.run({ data: { before: null, after: snap }, params: { docId: snap.id } });
  return (await db.doc('thursday_calls/' + T.callDocId(id)).get()).data();
}

async function callAction(auth, data) {
  try { return { ok: await fns.thursdayCallAction.run({ auth, data }) }; } catch (e) { return { err: e.code || e.message }; }
}

async function main() {
  // Seed: Castellano (NBD), an OTHER-tenant lead holding the Castellano caller's
  // phone, Halina's Thumbtack lead (proxy phone, town only).
  await db.doc('leads/' + RUN + '-castellano').set({ userId: NBD, companyId: NBD, firstName: 'Maria', lastName: 'Castellano',
    address: '2718 Linden Ave, Covington, KY 41014', phoneDigits: '8595550101', phone: '(859) 555-0101', stage: 'Estimate Sent', source: 'Referral' });
  await db.doc('leads/' + RUN + '-other').set({ userId: OTHER, companyId: OTHER, firstName: 'Maria', lastName: 'Castellano',
    address: '2718 Linden Ave, Covington, KY 41014', phoneDigits: '5135550142', stage: 'New' });
  await db.doc('leads/' + RUN + '-halina').set({ userId: NBD, companyId: NBD, firstName: 'Halina', lastName: 'N.',
    address: 'West Chester, OH 45069', phone: '+16695550199', phoneDigits: '6695550199', source: 'Thumbtack', stage: 'New' });

  EXTRACTIONS['castellano-call'] = { caller_name: 'Maria Castellano', address: '2718 Linden Ave', town: 'Covington', state: 'KY',
    caller_type: 'existing_customer', issue: 'Leak came back over the kitchen', urgent: true, urgent_reason: 'water inside',
    insurance: { involved: 'no', carrier: '', claim_filed: 'no', claim_number: '' }, confidence: 'high' };
  EXTRACTIONS['newbie-call'] = { caller_name: 'Robert Newman', callback_number: '513-555-0888', address: '42 Maple Ave', town: 'Mason',
    state: 'OH', zip: '45040', caller_type: 'new_lead', issue: 'Wants a quote for a full roof replacement', urgent: false,
    heard_about_us: 'found you on Google', insurance: { involved: 'unknown', carrier: '', claim_filed: 'unknown', claim_number: '' }, confidence: 'high' };
  EXTRACTIONS['halina-call'] = { caller_name: 'Halina Nowicka', address: '7420 Birchwood Ct', town: 'West Chester', zip: '45069',
    caller_type: 'new_lead', issue: 'Following up on her Thumbtack request', urgent: false, heard_about_us: 'Thumbtack', confidence: 'high' };

  const castellanoPayload = (id) => payload(id, { transcripts: [
    { user: 'assistant', text: 'Thanks for calling.' },
    { user: 'user', text: 'Hi this is Maria Castellano at 2718 Linden Avenue in Covington, the leak came back again over my kitchen (castellano-call).' },
  ] });

  section('1. Webhook');
  const idS = callId('castellano');
  const bad = await postWebhook(castellanoPayload(idS), 'deadbeef');
  ok('bad signature → 401', bad.code === 401);
  ok('bad signature queued nothing', !(await db.doc('thursday_calls/' + T.callDocId(idS)).get()).exists);
  const good = await postWebhook(castellanoPayload(idS));
  ok('signed webhook → 200', good.code === 200 && good.body && good.body.ok === true, JSON.stringify(good.body));
  const queued = (await db.doc('thursday_calls/' + T.callDocId(idS)).get()).data() || {};
  ok('queued doc is pending, NBD-scoped', queued.status === 'pending' && queued.companyId === NBD && queued.userId === NBD);
  const dup = await postWebhook(castellanoPayload(idS));
  ok('redelivery → 200 duplicate', dup.code === 200 && dup.body.duplicate === true);
  const notThursday = await postWebhook(payload(callId('elsewhere'), { to: '+15135550000' }));
  ok('call to another number ignored', notThursday.code === 200 && notThursday.body.ignored === 'not-thursday');

  section('2. Known caller attaches to her own lead (not the other tenant\'s)');
  const s = await runTrigger(idS);
  ok('processed', s.status === 'processed', s.status + ' ' + (s.processError || s.extractionError || ''));
  ok('attached to the NBD Castellano lead', s.route && s.route.action === 'attach' && s.leadId === RUN + '-castellano', JSON.stringify(s.route));
  ok('urgent carried onto the call', s.urgent === true);
  const task = (await db.doc('leads/' + RUN + '-castellano/tasks/' + T.taskIdForCall(idS)).get()).data();
  ok('call-back task on her lead (reader shape, high priority)', task && task.done === false && task.priority === 'high' && /Call back/.test(task.text));
  const act = (await db.doc('leads/' + RUN + '-castellano/activity/' + T.activityIdForCall(idS)).get()).data();
  ok('activity row on her lead', act && act.type === 'call' && act.source === 'thursday');
  const otherTasks = await db.collection('leads/' + RUN + '-other/tasks').get();
  const otherActs = await db.collection('leads/' + RUN + '-other/activity').get();
  ok('other tenant lead untouched (no task, no activity)', otherTasks.empty && otherActs.empty);
  const sLead = (await db.doc('leads/' + RUN + '-castellano').get()).data();
  ok('matched lead keeps its stage + source', sLead.stage === 'Estimate Sent' && sLead.source === 'Referral');
  ok('the other phone she called from is remembered on HER lead', sLead.altPhoneDigits === '5135550142' && sLead.phoneDigits === '8595550101');
  ok('extraction called Claude with the transcript', fetchLog.some((u) => u.startsWith('https://api.anthropic.com/')));
  ok('recording failure recorded, not fatal', typeof s.recordingError === 'string');
  ok('notifications attempted and recorded (email skipped w/o key)', s.notifyState && s.notifyState.email && /skipped/.test(s.notifyState.email.status));

  section('3. New caller → new NBD lead');
  const idN = callId('newbie');
  await postWebhook(payload(idN, { from: '+15135550888', transcripts: [{ user: 'user', text: 'Hi my name is Robert Newman I live at 42 Maple Ave in Mason and want a quote for a whole new roof (newbie-call).' }] }));
  const n = await runTrigger(idN);
  ok('route create_lead', n.route && n.route.action === 'create_lead', JSON.stringify(n.route));
  const lead = (await db.doc('leads/' + T.leadDocIdForCall(idN)).get()).data();
  ok('lead scoped to NBD', lead && lead.companyId === NBD && lead.userId === NBD);
  ok('lead source Google + intake Phone — Thursday', lead && lead.source === 'Google' && lead.intake === 'Phone — Thursday');
  // Canonical key since #2150 (stage-key migration): 'new' + stageRole 'new', not the legacy 'New'.
  ok('lead stage new + stageRole new', lead && lead.stage === 'new' && lead.stageRole === 'new');
  ok('lead has phoneDigits for SMS matching', lead && lead.phoneDigits === '5135550888');

  section('4. Thumbtack proxy lead → possible match, no duplicate');
  const idD = callId('halina');
  await postWebhook(payload(idD, { from: '+15135559876', transcripts: [{ user: 'user', text: 'This is Halina from 7420 Birchwood Court in West Chester, I sent a request on Thumbtack (halina-call).' }] }));
  const d = await runTrigger(idD);
  ok('route possible_match to her Thumbtack lead', d.route && d.route.action === 'possible_match' && d.leadId === RUN + '-halina', JSON.stringify(d.route));
  ok('no duplicate lead created', !(await db.doc('leads/' + T.leadDocIdForCall(idD)).get()).exists);
  const dTask = (await db.doc('leads/' + RUN + '-halina/tasks/' + T.taskIdForCall(idD)).get()).data();
  ok('confirm task placed on the candidate lead', dTask && /Possible match/.test(dTask.text));

  section('5. Reprocess is idempotent');
  await db.doc('leads/' + T.leadDocIdForCall(idN) + '/tasks/' + T.taskIdForCall(idN)).update({ done: true });
  await db.doc('thursday_calls/' + T.callDocId(idN)).update({ status: 'reprocess' });
  const n2 = await runTrigger(idN);
  ok('reprocessed', n2.status === 'processed');
  const leadsForCall = await db.collection('leads').where('thursdayCallId', '==', idN).get();
  ok('still exactly one lead for the call', leadsForCall.size === 1, String(leadsForCall.size));
  const nTask = (await db.doc('leads/' + T.leadDocIdForCall(idN) + '/tasks/' + T.taskIdForCall(idN)).get()).data();
  ok('completed task stays completed', nTask && nTask.done === true);
  const again = await runTrigger(idN);
  ok('processed doc does not re-run', again.attempts === n2.attempts);

  section('6. Spam is logged only');
  const idX = callId('spam');
  await postWebhook(payload(idX, { from: '+18005550000', transcripts: [{ user: 'user', text: 'Hello this is Mark from Local SEO Pros, we can get your business to the top of Google maps today guaranteed.' }] }));
  const x = await runTrigger(idX);
  ok('spam → log_only, reviewed, no lead', x.route && x.route.action === 'log_only' && x.reviewed === true && !x.leadId);
  ok('spam sent no notifications', !x.notifyState);

  section('7. thursdayCallAction guards');
  const viewer = await callAction({ uid: 'viewerZ', token: { role: 'viewer', companyId: NBD } }, { callId: idD, action: 'mark_reviewed' });
  ok('viewer refused', viewer.err === 'permission-denied', JSON.stringify(viewer));
  const stranger = await callAction({ uid: 'mgrOther', token: { role: 'manager', companyId: OTHER } }, { callId: idD, action: 'mark_reviewed' });
  ok('other-tenant manager refused', stranger.err === 'permission-denied', JSON.stringify(stranger));
  const notListed = await callAction({ uid: NBD, token: {} }, { callId: idD, action: 'confirm_match', leadId: RUN + '-castellano' });
  ok('confirm_match refuses a lead that was not a possible match', notListed.err === 'invalid-argument', JSON.stringify(notListed));
  const crossAttach = await callAction({ uid: NBD, token: {} }, { callId: idD, action: 'attach_to', leadId: RUN + '-other' });
  ok('attach_to refuses another tenant\'s lead', crossAttach.err === 'permission-denied', JSON.stringify(crossAttach));
  const confirm = await callAction({ uid: NBD, token: {} }, { callId: idD, action: 'confirm_match', leadId: RUN + '-halina' });
  const dAfter = (await db.doc('thursday_calls/' + T.callDocId(idD)).get()).data();
  ok('owner confirms the possible match', confirm.ok && dAfter.route.action === 'attach' && dAfter.reviewed === true, JSON.stringify(confirm));
  const rec = await (async () => { try { await fns.getThursdayRecording.run({ auth: { uid: NBD, token: {} }, data: { callId: idD } }); return 'ok'; } catch (e) { return e.code; } })();
  ok('recording callable: not-found when nothing was saved', rec === 'not-found', rec);
  const recStranger = await (async () => { try { await fns.getThursdayRecording.run({ auth: { uid: 'x', token: { role: 'sales_rep', companyId: NBD } }, data: { callId: idD } }); return 'ok'; } catch (e) { return e.code; } })();
  ok('recording callable: same-company sales_rep refused (mirrors rules)', recStranger === 'permission-denied', recStranger);

  console.log('\n──────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
