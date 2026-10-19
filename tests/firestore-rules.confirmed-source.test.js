/**
 * Firestore rules - leads/{id}.confirmedSource (2026-10-19, flag leadSourceFixer).
 *
 * The owner's own answer to "where did this customer really come from". Only
 * the tenant owner may set or clear it: a platform admin, a company_admin of
 * the lead's company, or a solo operator who owns the lead. Managers, reps,
 * viewers, another tenant and anonymous cannot, although managers and reps can
 * otherwise edit leads (positive controls below). Values must be well-formed and
 * stamped with the caller and the server time. A create may not carry the fields.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-csource-test \
 *     'node firestore-rules.confirmed-source.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-csource-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) {
    throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
  }
}

const results = [];
async function check(label, expect, promise) {
  try {
    if (expect === 'deny') await assertFails(promise); else await assertSucceeds(promise);
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, note: expect === 'deny' ? 'WAS ALLOWED' : 'was denied: ' + String((e && e.message) || e).slice(0, 160) });
  }
}

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[0], port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[1]) || 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const solo = ctx('co-a', {});                                                 // solo owner: uid == companyId, no role
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const mike = ctx('mike', { role: 'manager', companyId: 'co-a' });
  const rep = ctx('rep1', { role: 'sales_rep', companyId: 'co-a' });
  const vera = ctx('vera', { role: 'viewer', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'company_admin', companyId: 'co-b' });          // another tenant's admin
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, doc, getDoc, serverTimestamp } = require('firebase/firestore');
  const lead = (db, id) => doc(db, 'leads/' + id);
  const ans = (uid, over) => Object.assign({ confirmedSource: 'yelp', confirmedSourceNote: null, confirmedSourceBy: uid, confirmedSourceAt: serverTimestamp() }, over || {});

  const base = { companyId: 'co-a', userId: 'co-a', firstName: 'ZZ_QA', lastName: 'Lead', stage: 'new', source: 'Thumbtack', notes: '' };
  const doneDoc = Object.assign({}, base, { confirmedSource: 'referral', confirmedSourceNote: null, confirmedSourceBy: 'co-a' });
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9']) await setDoc(doc(f, 'leads/' + id), base);
    await setDoc(doc(f, 'leads/L_rep'), Object.assign({}, base, { userId: 'rep1' }));
    await setDoc(doc(f, 'leads/L_done'), doneDoc);
    await setDoc(doc(f, 'leads/L_clear'), doneDoc);
  });

  // positive controls: these writers CAN edit an ordinary field of the same lead
  await check('control: solo owner can edit notes', 'allow', updateDoc(lead(solo, 'L1'), { notes: 'a' }));
  await check('control: manager can edit notes', 'allow', updateDoc(lead(mike, 'L1'), { notes: 'b' }));
  await check('control: rep can edit notes on their own lead', 'allow', updateDoc(lead(rep, 'L_rep'), { notes: 'c' }));

  // who may write the answer
  await check('solo owner CAN confirm a source', 'allow', updateDoc(lead(solo, 'L2'), ans('co-a')));
  await check('company_admin of that company CAN confirm a source', 'allow', updateDoc(lead(carol, 'L3'), ans('carol', { confirmedSource: 'thumbtack_paid', confirmedSourceNote: 'came from a lead fee' })));
  await check('platform admin CAN confirm a source', 'allow', updateDoc(lead(joe, 'L4'), ans('joe', { confirmedSource: 'door_knock' })));
  await check('manager CANNOT confirm a source', 'deny', updateDoc(lead(mike, 'L5'), ans('mike')));
  await check('sales rep CANNOT confirm a source on their own lead', 'deny', updateDoc(lead(rep, 'L_rep'), ans('rep1')));
  await check('viewer CANNOT confirm a source', 'deny', updateDoc(lead(vera, 'L5'), ans('vera')));
  await check("another tenant's company_admin CANNOT confirm a source", 'deny', updateDoc(lead(eve, 'L5'), ans('eve')));
  await check('anonymous CANNOT confirm a source', 'deny', updateDoc(lead(anon, 'L5'), ans('x')));
  await check('manager CANNOT write only the note either', 'deny', updateDoc(lead(mike, 'L5'), { confirmedSourceNote: 'x' }));
  await check('rep CANNOT stamp confirmedSourceBy alone', 'deny', updateDoc(lead(rep, 'L_rep'), { confirmedSourceBy: 'rep1' }));

  // shape
  await check('owner CANNOT use a source outside the list', 'deny', updateDoc(lead(solo, 'L6'), ans('co-a', { confirmedSource: 'tiktok' })));
  await check('owner CANNOT use a non-string source', 'deny', updateDoc(lead(solo, 'L6'), ans('co-a', { confirmedSource: 7 })));
  await check('owner CANNOT write a note over 300 chars', 'deny', updateDoc(lead(solo, 'L7'), ans('co-a', { confirmedSourceNote: 'n'.repeat(301) })));
  await check('owner CAN write a note of exactly 300 chars', 'allow', updateDoc(lead(solo, 'L7'), ans('co-a', { confirmedSourceNote: 'n'.repeat(300) })));
  await check('owner CANNOT credit the answer to someone else', 'deny', updateDoc(lead(solo, 'L8'), ans('carol')));
  await check('owner CANNOT backdate confirmedSourceAt', 'deny', updateDoc(lead(solo, 'L9'), ans('co-a', { confirmedSourceAt: new Date('2020-01-01') })));
  await check('owner CANNOT omit the stamp', 'deny', updateDoc(lead(solo, 'L9'), { confirmedSource: 'yelp' }));
  await check('owner CAN clear an answer (null) with a fresh stamp', 'allow', updateDoc(lead(solo, 'L_clear'), ans('co-a', { confirmedSource: null })));

  // an existing answer is protected from the other writers
  await check('manager CANNOT change an existing answer', 'deny', updateDoc(lead(mike, 'L_done'), ans('mike', { confirmedSource: 'yelp' })));
  await check('manager CANNOT clear an existing answer', 'deny', updateDoc(lead(mike, 'L_done'), ans('mike', { confirmedSource: null })));
  await check('manager CAN save the lead with the answer fields unchanged', 'allow', updateDoc(lead(mike, 'L_done'), { notes: 'd', confirmedSource: 'referral', confirmedSourceNote: null, confirmedSourceBy: 'co-a' }));

  // create
  const fresh = (uid) => Object.assign({}, base, { userId: uid, meter: 'manual' });   // a client-created lead is metered (leadMeterOk)
  await check('control: solo owner CAN create an ordinary lead', 'allow', setDoc(lead(solo, 'N1'), fresh('co-a')));
  await check('solo owner CANNOT create a lead that already carries a confirmedSource', 'deny', setDoc(lead(solo, 'N2'), Object.assign(fresh('co-a'), ans('co-a'))));
  await check('control: rep CAN create an ordinary lead', 'allow', setDoc(lead(rep, 'N3'), fresh('rep1')));
  await check('rep CANNOT create a lead carrying confirmedSource', 'deny', setDoc(lead(rep, 'N4'), Object.assign(fresh('rep1'), ans('rep1'))));

  // the denied writes changed nothing
  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), 'leads/L5'));
    results.push({ label: 'L5 (every write denied) still has no confirmedSource', ok: s.exists() && s.data().confirmedSource === undefined, note: JSON.stringify(s.data()) });
    const d = await getDoc(doc(c.firestore(), 'leads/L_done'));
    results.push({ label: 'L_done still has its original answer', ok: d.data().confirmedSource === 'referral', note: JSON.stringify(d.data()) });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nconfirmedSource rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
