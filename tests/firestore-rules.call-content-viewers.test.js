/**
 * Firestore rules — Call to Close Q11, the rest (Jo, 2026-11-09: "close all
 * four"). A user with the viewer role reads no call or text content:
 *
 *   1. thursday_calls (the Thursday receptionist's call log, call.transcript)
 *   2. phone_texts / phone_text_days (text bodies and the AI notes of a day)
 *   3. leads/{id}/activity entries that copy a call or text summary onto the
 *      customer: source 'cube-acr' (Call Center), 'sms-backup' (Text Inbox),
 *      'thursday' (carries transcriptExcerpt) and 'call-brief' (the accepted
 *      Call Brief summary). Keyed on `source`, which every such doc already
 *      carries, so no migration. Written as an allowlist: a viewer reads
 *      only source 'rep' and 'visit-capture', listed with
 *      where('source', 'in', [...]). Rules are not filters, so an
 *      unconstrained list by a viewer is refused as a whole. (A denylist
 *      with a not-in query was tried first: the emulator let ANY not-in /
 *      != constrained query through it, returning a thursday entry.)
 *
 * Every other role keeps exactly what it had (positive controls next to each
 * deny), and phone_calls (closed earlier the same day) is not touched here.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-callviewers-test \
 *     'node firestore-rules.call-content-viewers.test.js'
 * RULES_PATH=<file> runs it against another rules file (red-before evidence).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-callviewers-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) {
    throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
  }
}
// emulators:exec exports FIRESTORE_EMULATOR_HOST; default to the repo's port.
const [HOST, PORT] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');

const results = [];
async function check(label, expect, promise) {
  try {
    if (expect === 'deny') await assertFails(promise); else await assertSucceeds(promise);
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, note: expect === 'deny' ? 'WAS ALLOWED' : 'was denied: ' + String((e && e.message) || e).slice(0, 160) });
  }
}
function same(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ label, ok, note: ok ? '' : 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) });
}

const HIDDEN = ['cube-acr', 'sms-backup', 'thursday', 'call-brief'];
const VIEWER_OK = ['rep', 'visit-capture'];

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: HOST, port: Number(PORT) },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const solo = ctx('co-a', {});                                             // the tenant owner: uid == companyId, no role claim
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const vico = ctx('vico', { role: 'viewer', companyId: 'co-a' });          // a viewer who owns docs
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });    // owns lead L1
  const dave = ctx('dave', { role: 'sales_rep', companyId: 'co-a' });      // owns nothing here
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, collection, query, where, addDoc } = require('firebase/firestore');

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'thursday_calls/bland_calls__T1'), { userId: 'co-a', companyId: 'co-a', leadId: 'L1', call: { transcript: 'my roof leaks', summary: 'Leak' }, startedAt: new Date() });
    await setDoc(doc(db, 'thursday_calls/bland_calls__TV'), { userId: 'vico', companyId: 'co-a', call: { transcript: 't' }, startedAt: new Date() });
    for (const col of ['phone_texts', 'phone_text_days']) {
      await setDoc(doc(db, col + '/x_1'), { userId: 'co-a', companyId: 'co-a', leadId: 'L1', phoneDigits: '5135550100', body: 'see you Tuesday', summary: 'Tuesday visit', startedAtMs: 1, sentAtMs: 1 });
      await setDoc(doc(db, col + '/x_V'), { userId: 'vico', companyId: 'co-a', phoneDigits: '5135550101', body: 'b', summary: 's', startedAtMs: 2, sentAtMs: 2 });
    }
    await setDoc(doc(db, 'leads/L1'), { userId: 'alice', companyId: 'co-a', firstName: 'Pat' });
    await setDoc(doc(db, 'leads/L2'), { userId: 'co-a', companyId: 'co-a', firstName: 'Sam' });
    await setDoc(doc(db, 'leads/LV'), { userId: 'vico', companyId: 'co-a', firstName: 'Val' });
    const act = (lead, id, data) => setDoc(doc(db, 'leads/' + lead + '/activity/' + id), Object.assign({ userId: 'co-a', companyId: 'co-a' }, data));
    for (const lead of ['L1', 'L2', 'LV']) {
      await act(lead, 'cube-C1', { type: 'call', source: 'cube-acr', summary: 'Wants a quote', phoneCallId: 'C1' });
      await act(lead, 'sms-D1', { type: 'text', source: 'sms-backup', summary: 'Texted about Tuesday', phoneTextDayId: 'D1' });
      await act(lead, 'thursday-T1', { type: 'call', source: 'thursday', summary: 'Leak', transcriptExcerpt: 'my roof leaks' });
      await act(lead, 'callbrief-C1', { type: 'note', source: 'call-brief', summary: 'Accepted summary', text: 'Accepted summary' });
      await act(lead, 'a1', { type: 'note', source: 'rep', text: 'Dropped off samples' });
      await act(lead, 'visit-V1', { type: 'visit', source: 'visit-capture', summary: 'Walked the roof' });
      await act(lead, 'vm1', { type: 'voice_memo', transcript: 'memo words' });          // no source field
      await act(lead, 'esign-1', { type: 'signature', source: 'esign-webhook', label: 'Signed' });
    }
    await setDoc(doc(db, 'leads/L1/tasks/t1'), { userId: 'alice', companyId: 'co-a', title: 'Call back' });
  });

  const getOf = (db, p) => getDoc(doc(db, p));
  const q = (db, col, ...w) => getDocs(query(collection(db, col), ...w));

  // ── 1 + 2: thursday_calls, phone_texts, phone_text_days ────────────────
  const COLS = [['thursday_calls', 'bland_calls__T1', 'bland_calls__TV'], ['phone_texts', 'x_1', 'x_V'], ['phone_text_days', 'x_1', 'x_V']];
  for (const [col, id, vid] of COLS) {
    await check(col + ': a same-company viewer does NOT get a doc', 'deny', getOf(vic, col + '/' + id));
    await check(col + ': a viewer companyId query is refused', 'deny', q(vic, col, where('companyId', '==', 'co-a')));
    await check(col + ': a viewer does NOT get a doc filed under their own uid', 'deny', getOf(vico, col + '/' + vid));
    await check(col + ': a viewer own-uid query is refused', 'deny', q(vico, col, where('userId', '==', 'vico')));
    await check(col + ': a viewer leadId + companyId query (the customer-card shape) is refused', 'deny', q(vic, col, where('leadId', '==', 'L1'), where('companyId', '==', 'co-a')));
    // positive controls: nobody else loses anything
    await check(col + ': the owner (no role claim) gets it', 'allow', getOf(solo, col + '/' + id));
    await check(col + ': the owner userId query', 'allow', q(solo, col, where('userId', '==', 'co-a')));
    await check(col + ': a same-company company_admin gets it', 'allow', getOf(carol, col + '/' + id));
    await check(col + ': a same-company manager gets it', 'allow', getOf(eve, col + '/' + id));
    await check(col + ': a manager companyId query', 'allow', q(eve, col, where('companyId', '==', 'co-a')));
    await check(col + ': a manager leadId + companyId query', 'allow', q(eve, col, where('leadId', '==', 'L1'), where('companyId', '==', 'co-a')));
    await check(col + ': a manager gets a viewer-owned doc', 'allow', getOf(eve, col + '/' + vid));
    await check(col + ': the platform admin gets it', 'allow', getOf(joe, col + '/' + id));
    // still closed
    await check(col + ': a same-company sales_rep is still refused', 'deny', getOf(dave, col + '/' + id));
    await check(col + ': another tenant\'s company_admin is still refused', 'deny', getOf(bobCA, col + '/' + id));
    await check(col + ': another tenant\'s company_admin query is still refused', 'deny', q(bobCA, col, where('companyId', '==', 'co-a')));
    await check(col + ': signed out is still refused', 'deny', getOf(anon, col + '/' + id));
    await check(col + ': the owner still cannot write', 'deny', setDoc(doc(solo, col + '/x_new'), { userId: 'co-a', companyId: 'co-a' }));
  }

  // ── 3: call / text summaries copied onto a customer ────────────────────
  for (const id of ['cube-C1', 'sms-D1', 'thursday-T1', 'callbrief-C1']) {
    await check('activity ' + id + ': a same-company viewer does NOT get it', 'deny', getOf(vic, 'leads/L1/activity/' + id));
    await check('activity ' + id + ': a viewer who owns the lead does NOT get it', 'deny', getOf(vico, 'leads/LV/activity/' + id));
    await check('activity ' + id + ': the lead\'s sales_rep owner gets it', 'allow', getOf(alice, 'leads/L1/activity/' + id));
    await check('activity ' + id + ': a same-company manager gets it', 'allow', getOf(eve, 'leads/L1/activity/' + id));
    await check('activity ' + id + ': a same-company company_admin gets it', 'allow', getOf(carol, 'leads/L1/activity/' + id));
    await check('activity ' + id + ': the tenant owner (no role) gets it on their own lead', 'allow', getOf(solo, 'leads/L2/activity/' + id));
    await check('activity ' + id + ': the platform admin gets it', 'allow', getOf(joe, 'leads/L1/activity/' + id));
  }
  await check('activity: a viewer still gets a rep note (positive control)', 'allow', getOf(vic, 'leads/L1/activity/a1'));
  await check('activity: a viewer still gets a visit entry (not a call source)', 'allow', getOf(vic, 'leads/L1/activity/visit-V1'));
  await check('activity: a viewer does NOT get an entry with no source (voice memo transcript)', 'deny', getOf(vic, 'leads/L1/activity/vm1'));
  await check('activity: a viewer does NOT get another server source (allowlist, not denylist)', 'deny', getOf(vic, 'leads/L1/activity/esign-1'));
  await check('activity: a viewer\'s unconstrained list is refused (it could return call summaries)', 'deny', getDocs(collection(vic, 'leads/L1/activity')));
  await check('activity: a viewer\'s list of the allowed sources is allowed', 'allow', q(vic, 'leads/L1/activity', where('source', 'in', VIEWER_OK)));
  {
    let ids = null;
    try { ids = (await q(vic, 'leads/L1/activity', where('source', 'in', VIEWER_OK))).docs.map((d) => d.id).sort(); } catch (_) { ids = 'denied'; }
    same('activity: …and returns only the rep note and the visit', ids, ['a1', 'visit-V1']);
  }
  await check('activity: a viewer owner of the lead lists the allowed sources', 'allow', q(vico, 'leads/LV/activity', where('source', 'in', VIEWER_OK)));
  await check('activity: a viewer list by not-in (excluding the call sources) is refused', 'deny', q(vic, 'leads/L1/activity', where('source', 'not-in', HIDDEN)));
  await check('activity: a viewer list by != is refused', 'deny', q(vic, 'leads/L1/activity', where('source', '!=', 'cube-acr')));
  await check('activity: a viewer list naming one call source among allowed ones is refused', 'deny', q(vic, 'leads/L1/activity', where('source', 'in', ['rep', 'thursday'])));
  await check('activity: a viewer list asking for call entries is refused', 'deny', q(vic, 'leads/L1/activity', where('source', '==', 'cube-acr')));
  {
    let n = -1;
    try { n = (await getDocs(collection(eve, 'leads/L1/activity'))).size; } catch (_) { n = 'denied'; }
    same('activity: a manager\'s unconstrained list still returns every entry', n, 8);
  }
  await check('activity: the sales_rep owner\'s unconstrained list still works', 'allow', getDocs(collection(alice, 'leads/L1/activity')));
  await check('activity: another tenant\'s company_admin is still refused', 'deny', getOf(bobCA, 'leads/L1/activity/a1'));
  await check('activity: another tenant\'s list of the allowed sources is still refused', 'deny', q(bobCA, 'leads/L1/activity', where('source', 'in', VIEWER_OK)));
  await check('activity: a viewer still cannot write', 'deny', addDoc(collection(vic, 'leads/L1/activity'), { userId: 'vic', source: 'rep', type: 'note', text: 'x' }));
  await check('tasks: a viewer still reads the lead\'s tasks (unchanged; summaries no longer copied there)', 'allow', getDocs(collection(vic, 'leads/L1/tasks')));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
