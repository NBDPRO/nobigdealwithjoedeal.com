/**
 * Firestore rules - leads/{id}.projectConsent (2026-11-09, content plan §2 step 1).
 *
 * The consent tick: { on: true|false, by: <uid>, at: <Timestamp> }. on === true
 * is the only way a job can become a public project page (it maps to
 * projects.json consentOnFile: true, scripts/draft-project-page.mjs). Jo
 * confirms each job himself, so only the owner side may set or clear it: a
 * platform admin, a company_admin of the lead's company, or a solo operator
 * (no role claim, own tenant) who owns the lead. Managers, reps and viewers
 * cannot, though managers and reps can otherwise edit the lead. Shape: exactly
 * the three keys, on a bool, by == the caller, at == request.time. A lead is
 * never CREATED with the tick on it.
 *
 * Each deny has a control beside it (the same writer editing an ordinary
 * field of the same lead), so the consent field is what is being tested.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-pconsent-test \
 *     'node firestore-rules.project-consent.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-pconsent-test';
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
  const hostPort = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: hostPort.split(':')[0], port: Number(hostPort.split(':')[1]) || 8080 },
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
  const { setDoc, updateDoc, doc, getDoc, serverTimestamp, deleteField } = require('firebase/firestore');
  const lead = (db, id) => doc(db, 'leads/' + id);
  const tick = (uid, on, over) => ({ projectConsent: Object.assign({ on, by: uid, at: serverTimestamp() }, over || {}) });

  const base = { companyId: 'co-a', userId: 'co-a', firstName: 'ZZ_QA', lastName: 'Lead', stage: 'install_complete', notes: '' };
  const ticked = Object.assign({}, base, { projectConsent: { on: true, by: 'co-a', at: new Date('2026-11-01T12:00:00Z') } });
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11']) await setDoc(doc(f, 'leads/' + id), base);
    await setDoc(doc(f, 'leads/R1'), Object.assign({}, base, { userId: 'rep1' }));
    for (const id of ['T1', 'T2', 'T3', 'T4']) await setDoc(doc(f, 'leads/' + id), ticked);
  });

  // Controls: these writers CAN edit an ordinary field of the same leads.
  await check('control: solo owner can edit notes', 'allow', updateDoc(lead(solo, 'L1'), { notes: 'a' }));
  await check('control: manager can edit notes', 'allow', updateDoc(lead(mike, 'L1'), { notes: 'b' }));
  await check('control: rep can edit notes on their own lead', 'allow', updateDoc(lead(rep, 'R1'), { notes: 'c' }));
  await check('control: an ordinary save of a ticked lead by a manager is unaffected', 'allow', updateDoc(lead(mike, 'T4'), { notes: 'd' }));

  // The owner side may set and clear it.
  await check('solo owner CAN tick consent on', 'allow', updateDoc(lead(solo, 'L2'), tick('co-a', true)));
  await check('company_admin of that company CAN tick consent on', 'allow', updateDoc(lead(carol, 'L3'), tick('carol', true)));
  await check('platform admin CAN tick consent on', 'allow', updateDoc(lead(joe, 'L4'), tick('joe', true)));
  await check('solo owner CAN clear it (on: false, fresh stamp)', 'allow', updateDoc(lead(solo, 'T1'), tick('co-a', false)));
  await check('company_admin CAN clear it', 'allow', updateDoc(lead(carol, 'T2'), tick('carol', false)));

  // Everyone else cannot, either way.
  await check('manager CANNOT tick consent on', 'deny', updateDoc(lead(mike, 'L5'), tick('mike', true)));
  await check('manager CANNOT clear consent', 'deny', updateDoc(lead(mike, 'T3'), tick('mike', false)));
  await check('manager CANNOT delete the field', 'deny', updateDoc(lead(mike, 'T3'), { projectConsent: deleteField() }));
  await check('rep CANNOT tick consent on their own lead', 'deny', updateDoc(lead(rep, 'R1'), tick('rep1', true)));
  await check('viewer CANNOT tick consent on', 'deny', updateDoc(lead(vera, 'L5'), tick('vera', true)));
  await check("another tenant's company_admin CANNOT", 'deny', updateDoc(lead(eve, 'L5'), tick('eve', true)));
  await check('anonymous CANNOT', 'deny', updateDoc(lead(anon, 'L5'), tick('anon', true)));

  // Shape: exactly { on: bool, by: caller, at: request.time }.
  await check('owner CANNOT stamp someone else as by', 'deny', updateDoc(lead(solo, 'L6'), tick('carol', true)));
  await check('owner CANNOT backdate at', 'deny', updateDoc(lead(solo, 'L7'), tick('co-a', true, { at: new Date('2026-01-01T00:00:00Z') })));
  await check('owner CANNOT omit at', 'deny', updateDoc(lead(solo, 'L8'), { projectConsent: { on: true, by: 'co-a' } }));
  await check('owner CANNOT use a non-bool on ("yes")', 'deny', updateDoc(lead(solo, 'L9'), tick('co-a', 'yes')));
  await check('owner CANNOT add extra keys', 'deny', updateDoc(lead(solo, 'L10'), tick('co-a', true, { note: 'x' })));
  await check('owner CANNOT write a bare true', 'deny', updateDoc(lead(solo, 'L11'), { projectConsent: true }));

  // Create: a lead is never born with the tick on it.
  await check('control: solo owner can create a lead', 'allow', setDoc(lead(solo, 'N1'), Object.assign({}, base, { meter: 'manual' })));
  await check('solo owner CANNOT create a lead already carrying projectConsent', 'deny',
    setDoc(lead(solo, 'N2'), Object.assign({}, base, { meter: 'manual' }, tick('co-a', true))));

  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    const l2 = (await getDoc(doc(f, 'leads/L2'))).data();
    results.push({ label: 'L2 carries { on: true, by: co-a, at: server time }', ok: !!(l2.projectConsent && l2.projectConsent.on === true && l2.projectConsent.by === 'co-a' && typeof l2.projectConsent.at.toMillis === 'function'), note: JSON.stringify(l2) });
    const t3 = (await getDoc(doc(f, 'leads/T3'))).data();
    results.push({ label: 'T3 (manager denied) still carries on: true', ok: !!(t3.projectConsent && t3.projectConsent.on === true), note: JSON.stringify(t3) });
    const l5 = (await getDoc(doc(f, 'leads/L5'))).data();
    results.push({ label: 'L5 (all denied) has no projectConsent', ok: l5.projectConsent === undefined, note: JSON.stringify(l5) });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nprojectConsent rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
