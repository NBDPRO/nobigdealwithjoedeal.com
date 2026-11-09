/**
 * Firestore rules - leads/{id}.installCompletedAt (2026-11-09).
 *
 * The first move onto Install Done now writes installCompletedAt (server time)
 * in the same patch as the stage (docs/pro/js/stage-write.js commitStageChange).
 * No rule change: this suite proves the existing /leads update rule lets every
 * writer who can move a stage write that patch (solo owner, company_admin,
 * manager, a rep on their own lead, platform admin), and that the writers who
 * cannot move a stage still cannot (viewer, a rep on a teammate's lead,
 * another tenant, anonymous). Each allow has the stage-only move beside it as
 * a control, so the extra field is what is being tested.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-installdone-test \
 *     'node firestore-rules.install-completed-at.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-installdone-test';
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
  const eve = ctx('eve', { role: 'company_admin', companyId: 'co-b' });
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, doc, getDoc, serverTimestamp, arrayUnion } = require('firebase/firestore');
  const lead = (db, id) => doc(db, 'leads/' + id);

  // The patch commitStageChange sends on a first move onto Install Done.
  const move = (uid, withDate) => Object.assign({
    stage: 'install_complete', stageRole: 'won',
    updatedAt: serverTimestamp(), stageStartedAt: serverTimestamp(),
    stageHistory: arrayUnion({ from: 'install_in_progress', to: 'install_complete', timestamp: '2026-11-09T12:00:00.000Z', user: uid, by: uid }),
  }, withDate ? { installCompletedAt: serverTimestamp() } : {});

  const base = { companyId: 'co-a', userId: 'co-a', firstName: 'ZZ_QA', lastName: 'Lead', stage: 'install_in_progress', stageRole: 'job', closedAt: new Date('2026-10-01') };
  const ids = ['S0', 'S1', 'C0', 'C1', 'M0', 'M1', 'A0', 'A1', 'V1', 'E1', 'N1', 'T1'];
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    for (const id of ids) await setDoc(doc(f, 'leads/' + id), base);
    await setDoc(doc(f, 'leads/R0'), Object.assign({}, base, { userId: 'rep1' }));
    await setDoc(doc(f, 'leads/R1'), Object.assign({}, base, { userId: 'rep1' }));
  });

  await check('control: solo owner can move to Install Done', 'allow', updateDoc(lead(solo, 'S0'), move('co-a', false)));
  await check('solo owner CAN move to Install Done with installCompletedAt', 'allow', updateDoc(lead(solo, 'S1'), move('co-a', true)));
  await check('control: company_admin can move to Install Done', 'allow', updateDoc(lead(carol, 'C0'), move('carol', false)));
  await check('company_admin CAN move with installCompletedAt', 'allow', updateDoc(lead(carol, 'C1'), move('carol', true)));
  await check('control: manager can move to Install Done', 'allow', updateDoc(lead(mike, 'M0'), move('mike', false)));
  await check('manager CAN move with installCompletedAt', 'allow', updateDoc(lead(mike, 'M1'), move('mike', true)));
  await check('control: rep can move their own lead to Install Done', 'allow', updateDoc(lead(rep, 'R0'), move('rep1', false)));
  await check('rep CAN move their own lead with installCompletedAt', 'allow', updateDoc(lead(rep, 'R1'), move('rep1', true)));
  await check('control: platform admin can move to Install Done', 'allow', updateDoc(lead(joe, 'A0'), move('joe', false)));
  await check('platform admin CAN move with installCompletedAt', 'allow', updateDoc(lead(joe, 'A1'), move('joe', true)));

  await check('viewer CANNOT move with installCompletedAt', 'deny', updateDoc(lead(vera, 'V1'), move('vera', true)));
  await check("rep CANNOT move a teammate's lead with installCompletedAt", 'deny', updateDoc(lead(rep, 'T1'), move('rep1', true)));
  await check("another tenant's company_admin CANNOT", 'deny', updateDoc(lead(eve, 'E1'), move('eve', true)));
  await check('anonymous CANNOT', 'deny', updateDoc(lead(anon, 'N1'), move('anon', true)));

  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    const s1 = (await getDoc(doc(f, 'leads/S1'))).data();
    results.push({ label: 'S1 now carries a server-time installCompletedAt', ok: s1.stage === 'install_complete' && s1.installCompletedAt && typeof s1.installCompletedAt.toMillis === 'function', note: JSON.stringify(s1) });
    for (const id of ['V1', 'T1', 'E1', 'N1']) {
      const d = (await getDoc(doc(f, 'leads/' + id))).data();
      results.push({ label: id + ' (denied) is unchanged', ok: d.stage === 'install_in_progress' && d.installCompletedAt === undefined, note: JSON.stringify(d) });
    }
  });

  // Per job (review round 2026-11-09): installCompletedAt is a JOB_FIELDS field,
  // so a non-active job's card moved onto Install Done (crm-pipeline.js
  // _moveJobCard) writes it, on the client clock, to leads/{id}/jobs/{jobId}.
  const jobMove = (uid, withDate) => Object.assign({
    stage: 'install_complete', stageRole: 'won', stageStartedAt: new Date('2026-11-09T12:00:00Z'),
    stageHistory: arrayUnion({ from: 'install_in_progress', to: 'install_complete', at: '2026-11-09T12:00:00.000Z', by: uid, drag: false }),
  }, withDate ? { installCompletedAt: new Date('2026-11-09T12:00:00Z') } : {});
  const job = (db, leadId, id) => doc(db, 'leads/' + leadId + '/jobs/' + id);
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'leads/J0'), base);
    for (const id of ['j1', 'j2', 'j3', 'j4']) {
      await setDoc(doc(f, 'leads/J0/jobs/' + id), { companyId: 'co-a', userId: 'co-a', stage: 'install_in_progress', stageRole: 'job', title: 'Job' });
    }
  });
  await check("control: the owner can move a job doc to Install Done", 'allow', updateDoc(job(solo, 'J0', 'j1'), jobMove('co-a', false)));
  await check("the owner CAN write a job's installCompletedAt with that move", 'allow', updateDoc(job(solo, 'J0', 'j2'), jobMove('co-a', true)));
  await check("company_admin CAN write a job's installCompletedAt", 'allow', updateDoc(job(carol, 'J0', 'j3'), jobMove('carol', true)));
  await check("viewer CANNOT write a job's installCompletedAt", 'deny', updateDoc(job(vera, 'J0', 'j4'), jobMove('vera', true)));
  await check("another tenant's company_admin CANNOT write a job's installCompletedAt", 'deny', updateDoc(job(eve, 'J0', 'j4'), jobMove('eve', true)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\ninstallCompletedAt rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
