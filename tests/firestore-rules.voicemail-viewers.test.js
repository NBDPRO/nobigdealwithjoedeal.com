/**
 * Firestore rules — Call to Close Q11 item 4 (Jo, 2026-11-09): a viewer does
 * not read voicemail transcripts.
 *
 * voicemail.js files its timeline row under leads/{id}/activity with the full
 * transcript and an AI summary. It used source 'rep', which is on the viewer
 * read allowlist (rep, visit-capture). Now the row carries source 'voicemail'
 * (outside the allowlist) and the create rule ties type 'voicemail' to
 * source 'voicemail' both ways. The viewer read rule and the viewer timeline
 * query, where('source', 'in', ['rep', 'visit-capture']), are unchanged.
 *
 * Proves: a viewer is denied a voicemail row (same company, and on a lead the
 * viewer owns), and their allowlisted list does not return it; a viewer still
 * reads rep / visit-capture rows; the lead's sales_rep owner, the tenant owner
 * (no role claim), a same-company manager and company_admin, and the platform
 * admin read every row, voicemail included, by get and by a whole-collection
 * list. A row saved before this change (source 'rep', type 'voicemail') is
 * still viewer-readable until scripts/retag-voicemail-activity.js retags it;
 * pinned below so the backfill's reason stays visible.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-vmviewers-test \
 *     'node firestore-rules.voicemail-viewers.test.js'
 * RULES_PATH=<file> runs it against another rules file (red-before evidence).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-vmviewers-test';
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

const VIEWER_OK = ['rep', 'visit-capture'];
const VM = (uid, extra) => Object.assign({
  userId: uid, companyId: 'co-a', type: 'voicemail', source: 'voicemail', mediaSource: 'uploaded',
  label: 'Voicemail upload', transcript: 'please call me back about the leak', confidence: 0.9,
  summary: { overview: 'Leak call-back', actionItems: [], people: [], addresses: [], amounts: [], dates: [], category: 'other' },
}, extra || {});

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
  const vico = ctx('vico', { role: 'viewer', companyId: 'co-a' });          // a viewer who owns lead LV
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });    // owns lead L1
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const joe = ctx('joe', { role: 'admin' });
  const { setDoc, doc, getDoc, getDocs, collection, query, where } = require('firebase/firestore');

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'alice', companyId: 'co-a', firstName: 'Pat' });
    await setDoc(doc(db, 'leads/L2'), { userId: 'co-a', companyId: 'co-a', firstName: 'Sam' });
    await setDoc(doc(db, 'leads/LV'), { userId: 'vico', companyId: 'co-a', firstName: 'Val' });
    const act = (lead, id, data) => setDoc(doc(db, 'leads/' + lead + '/activity/' + id), Object.assign({ userId: 'co-a', companyId: 'co-a' }, data));
    for (const lead of ['L1', 'L2', 'LV']) {
      await act(lead, 'vm-new', VM('co-a'));
      await act(lead, 'vm-old', VM('co-a', { source: 'rep' }));                  // saved before 2026-11-09
      await act(lead, 'a1', { type: 'note', source: 'rep', text: 'Dropped off samples' });
      await act(lead, 'visit-V1', { type: 'visit', source: 'visit-capture', summary: 'Walked the roof' });
    }
  });

  const getOf = (db, p) => getDoc(doc(db, p));
  const q = (db, col, ...w) => getDocs(query(collection(db, col), ...w));
  const ids = async (p) => { try { return (await p).docs.map((d) => d.id).sort(); } catch (_) { return 'denied'; } };

  // ── reads: a viewer ─────────────────────────────────────────────────────
  await check('a same-company viewer is denied a voicemail row', 'deny', getOf(vic, 'leads/L1/activity/vm-new'));
  await check('a viewer who owns the lead is denied its voicemail row', 'deny', getOf(vico, 'leads/LV/activity/vm-new'));
  await check('a viewer list asking for voicemail rows is refused', 'deny', q(vic, 'leads/L1/activity', where('source', '==', 'voicemail')));
  await check('a viewer list naming voicemail among the allowed sources is refused', 'deny', q(vic, 'leads/L1/activity', where('source', 'in', ['rep', 'visit-capture', 'voicemail'])));
  await check('a viewer list by type voicemail is refused (it could return a voicemail row)', 'deny', q(vic, 'leads/L1/activity', where('type', '==', 'voicemail')));
  await check('a viewer\'s unconstrained list is still refused', 'deny', getDocs(collection(vic, 'leads/L1/activity')));
  await check('a viewer still gets a rep note', 'allow', getOf(vic, 'leads/L1/activity/a1'));
  await check('a viewer still gets a visit-capture row', 'allow', getOf(vic, 'leads/L1/activity/visit-V1'));
  await check('a viewer\'s timeline query (source in rep, visit-capture) is allowed', 'allow', q(vic, 'leads/L1/activity', where('source', 'in', VIEWER_OK)));
  same('…and returns no new voicemail row (vm-old is a pre-retag row, see the backfill)',
    await ids(q(vic, 'leads/L1/activity', where('source', 'in', VIEWER_OK))), ['a1', 'visit-V1', 'vm-old']);
  same('…the viewer who owns the lead gets the same set',
    await ids(q(vico, 'leads/LV/activity', where('source', 'in', VIEWER_OK))), ['a1', 'visit-V1', 'vm-old']);
  await check('a pre-retag row (source rep, type voicemail) is still viewer-readable until the backfill', 'allow', getOf(vic, 'leads/L1/activity/vm-old'));

  // ── reads: everyone else keeps every row ────────────────────────────────
  const ALL = ['a1', 'visit-V1', 'vm-new', 'vm-old'];
  for (const [who, db, lead] of [['the lead\'s sales_rep owner', alice, 'L1'], ['the tenant owner (no role)', solo, 'L2'],
    ['a same-company manager', eve, 'L1'], ['a same-company company_admin', carol, 'L1'], ['the platform admin', joe, 'L1']]) {
    await check(who + ' gets the voicemail row', 'allow', getOf(db, 'leads/' + lead + '/activity/vm-new'));
    same(who + '\'s whole-collection list returns every row', await ids(getDocs(collection(db, 'leads/' + lead + '/activity'))), ALL);
  }
  await check('a manager gets the voicemail row on a viewer-owned lead', 'allow', getOf(eve, 'leads/LV/activity/vm-new'));
  await check('a manager list by source voicemail is allowed', 'allow', q(eve, 'leads/L1/activity', where('source', '==', 'voicemail')));
  await check('another tenant\'s company_admin is still refused', 'deny', getOf(bobCA, 'leads/L1/activity/vm-new'));

  // ── creates: voicemail.js writeActivityEntry ────────────────────────────
  const add = (db, lead, id, data) => setDoc(doc(db, 'leads/' + lead + '/activity/' + id), data);
  await check('the lead\'s rep files a voicemail row (source voicemail, type voicemail)', 'allow', add(alice, 'L1', 'c-vm', VM('alice')));
  await check('a same-company manager files one on a teammate\'s lead', 'allow', add(eve, 'L1', 'c-vm-mgr', VM('eve')));
  await check('the tenant owner files one on their own lead', 'allow', add(solo, 'L2', 'c-vm-own', VM('co-a')));
  await check('an old client\'s voicemail as source rep is refused (would be viewer-readable)', 'deny', add(alice, 'L1', 'c-vm-rep', VM('alice', { source: 'rep' })));
  await check('source voicemail with another type is refused', 'deny', add(alice, 'L1', 'c-vm-note', VM('alice', { type: 'note' })));
  await check('source voicemail with type call is refused', 'deny', add(alice, 'L1', 'c-vm-call', VM('alice', { type: 'call' })));
  await check('a voicemail row with a webhook / payment key is refused', 'deny', add(alice, 'L1', 'c-vm-stripe', VM('alice', { stripeInvoiceId: 'in_1' })));
  await check('a voicemail row filed under another uid is refused', 'deny', add(alice, 'L1', 'c-vm-uid', VM('bob')));
  await check('a viewer cannot file a voicemail row', 'deny', add(vic, 'L1', 'c-vm-vic', VM('vic')));
  await check('a viewer cannot file one on a lead they own', 'deny', add(vico, 'LV', 'c-vm-vico', VM('vico')));
  await check('another tenant\'s company_admin cannot file one', 'deny', add(bobCA, 'L1', 'c-vm-b', VM('bobca')));
  await check('a rep note still files as source rep', 'allow', add(alice, 'L1', 'c-note', { userId: 'alice', source: 'rep', type: 'note', text: 'x' }));
  await check('the rest of the rep type allowlist still files as source rep', 'allow', add(alice, 'L1', 'c-supp', { userId: 'alice', source: 'rep', type: 'supplement_created', label: 'S1' }));
  await check('a filed voicemail row cannot be edited back to source rep (retag is admin-SDK only)', 'deny', setDoc(doc(alice, 'leads/L1/activity/vm-new'), VM('co-a', { source: 'rep' })));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
