/**
 * Firestore rules - Canvasser mode (2026-10-16): tenant + rep isolation.
 *
 *   canvassers/{companyId}__{uid}   (the owner's canvasser + commission %)
 *   canvass_checks/{id}             (the rep's pre-knock checklist)
 *   plus the data a canvasser works in: leads, knocks, d2d_doorlists
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-canvass-test \
 *     'node firestore-rules.canvassers.test.js'
 *
 * The rep (Sales Rep claim) sees only their own leads, knocks and door lists
 * (plus a list assigned to them) and their own canvasser doc; they cannot set
 * their own %, read another rep's numbers, or touch another company. Only the
 * company owner writes canvassers. A checklist is the rep's own, fully
 * ticked, and never edited. Every shape deny has a positive control.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-canvass-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
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
const RULES_PATH = process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules');
const CO = 'ownerJoe', OTHER = 'ownerB';
const OWNER = CO, MANAGER = 'mgrA', REP = 'repA', REP2 = 'repB', VIEWER = 'viewA', STRANGER = OTHER;
const cv = (uid, over) => Object.assign({ companyId: CO, uid, name: 'Rep ' + uid, pct: 10, active: true, updatedBy: OWNER, updatedAt: 1760000000000 }, over || {});
const chk = (uid, over) => Object.assign({ userId: uid, companyId: CO, ymd: '2026-10-16', townId: 'mason-oh', town: 'Mason, OH', items: { permit: true, badge: true, cancelNotice: true, quietHours: true }, hours: '9 a.m. to 8 p.m.', createdAt: 1760000000000 }, over || {});

async function run() {
  // parity: the client's checklist doc has exactly the keys the rules allow
  {
    const L = require('../docs/pro/js/canvasser-logic.js');
    const d = L.checkDoc('mason-oh', { permit: true, badge: true, cancelNotice: true, quietHours: true }, { uid: REP, companyId: CO }, new Date('2026-10-16T15:00:00'));
    const src = fs.readFileSync(RULES_PATH, 'utf8');
    const m = /match \/canvass_checks\/\{checkId\} \{[\s\S]*?keys\(\)\.hasOnly\(\[([^\]]*)\]\)/.exec(src);
    const inRules = m ? (m[1].match(/'([A-Za-z]+)'/g) || []).map((x) => x.slice(1, -1)).sort() : [];
    const client = Object.keys(d).concat(['createdAt']).sort();
    results.push({ label: 'parity: checkDoc keys (+createdAt) equal the rules allowlist', ok: JSON.stringify(inRules) === JSON.stringify(client), note: inRules.join(',') + ' vs ' + client.join(',') });
  }

  const env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8') } });
  await env.clearFirestore();
  const as = (uid, claims) => env.authenticatedContext(uid, claims || {}).firestore();
  const owner = as(OWNER, { companyId: CO, role: 'company_admin' });
  const solo = as('soloS');
  const mgr = as(MANAGER, { companyId: CO, role: 'manager' });
  const rep = as(REP, { companyId: CO, role: 'sales_rep' });
  const rep2 = as(REP2, { companyId: CO, role: 'sales_rep' });
  const viewer = as(VIEWER, { companyId: CO, role: 'viewer' });
  const stranger = as(STRANGER, { companyId: OTHER, role: 'company_admin' });

  // seed rep data as the admin SDK would
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await d.doc('leads/LA').set({ userId: REP, companyId: CO, stage: 'contract_signed', firstName: 'A' });
    await d.doc('leads/LB').set({ userId: REP2, companyId: CO, stage: 'new', firstName: 'B' });
    await d.doc('knocks/KA').set({ userId: REP, companyId: CO, address: '1 A St', disposition: 'appointment' });
    await d.doc('knocks/KB').set({ userId: REP2, companyId: CO, address: '2 B St', disposition: 'not_home' });
  });

  // canvassers: only the owner writes
  await check('owner (company_admin) adds a canvasser with a %', 'allow', owner.doc(`canvassers/${CO}__${REP}`).set(cv(REP)));
  await check('owner adds a second canvasser', 'allow', owner.doc(`canvassers/${CO}__${REP2}`).set(cv(REP2, { pct: 12.5 })));
  await check('deny: the rep sets their own %', 'deny', rep.doc(`canvassers/${CO}__${REP}`).update({ pct: 50, updatedBy: REP }));
  await check('deny: the rep creates a canvasser doc for themselves', 'deny', rep.doc(`canvassers/${CO}__${REP}x`).set(cv(REP + 'x', { updatedBy: REP })));
  await check('deny: a manager writes a %', 'deny', mgr.doc(`canvassers/${CO}__${REP}`).update({ pct: 20, updatedBy: MANAGER }));
  await check('deny: another company\'s owner writes into this company', 'deny', stranger.doc(`canvassers/${CO}__${REP}`).update({ pct: 1, updatedBy: STRANGER }));
  await check('deny: a % over 50', 'deny', owner.doc(`canvassers/${CO}__${REP}`).update({ pct: 51, updatedBy: OWNER }));
  await check('allow: the same update at 50 (positive control)', 'allow', owner.doc(`canvassers/${CO}__${REP}`).update({ pct: 50, updatedBy: OWNER }));
  await check('deny: a doc id that does not match company + uid', 'deny', owner.doc(`canvassers/${CO}__someoneElse`).set(cv(REP)));
  await check('deny: an extra key (a bank account) on the doc', 'deny', owner.doc(`canvassers/${CO}__${REP}`).update({ bankAccount: '123', updatedBy: OWNER }));
  await check('deny: moving a canvasser to another rep uid', 'deny', owner.doc(`canvassers/${CO}__${REP}`).update({ uid: REP2, updatedBy: OWNER }));
  await check('deny: updatedBy someone else', 'deny', owner.doc(`canvassers/${CO}__${REP}`).update({ pct: 10, updatedBy: REP }));
  await check('a solo owner (no claims) manages their own company\'s canvassers', 'allow', solo.doc('canvassers/soloS__r1').set(cv('r1', { companyId: 'soloS', updatedBy: 'soloS' })));
  await check('deny: a solo owner writing into another company', 'deny', solo.doc(`canvassers/${CO}__r9`).set(cv('r9', { updatedBy: 'soloS' })));

  // canvassers: reads
  await check('the rep reads their own canvasser doc', 'allow', rep.doc(`canvassers/${CO}__${REP}`).get());
  await check('deny: the rep reads another rep\'s % ', 'deny', rep.doc(`canvassers/${CO}__${REP2}`).get());
  await check('deny: the rep lists every canvasser of the company', 'deny', rep.collection('canvassers').where('companyId', '==', CO).get());
  await check('the manager lists the company\'s canvassers', 'allow', mgr.collection('canvassers').where('companyId', '==', CO).get());
  await check('the owner lists them', 'allow', owner.collection('canvassers').where('companyId', '==', CO).get());
  await check('deny: another company lists them', 'deny', stranger.collection('canvassers').where('companyId', '==', CO).get());

  // the rep's own data only
  await check('the rep reads their own lead', 'allow', rep.doc('leads/LA').get());
  await check('deny: the rep reads another rep\'s lead', 'deny', rep.doc('leads/LB').get());
  await check('deny: the rep lists the company\'s leads', 'deny', rep.collection('leads').where('companyId', '==', CO).get());
  await check('the rep reads their own knock', 'allow', rep.doc('knocks/KA').get());
  await check('deny: the rep reads another rep\'s knock', 'deny', rep.doc('knocks/KB').get());
  await check('the owner reads every rep\'s knocks (company query)', 'allow', owner.collection('knocks').where('companyId', '==', CO).get());
  await check('the owner reads every rep\'s leads (company query)', 'allow', owner.collection('leads').where('companyId', '==', CO).get());
  await check('deny: another company reads this company\'s knocks', 'deny', stranger.collection('knocks').where('companyId', '==', CO).get());

  // checklists
  await check('the rep saves today\'s ticked checklist for a town', 'allow', rep.collection('canvass_checks').doc('C1').set(chk(REP)));
  await check('deny: a checklist with an unticked line', 'deny', rep.collection('canvass_checks').doc('C2').set(chk(REP, { items: { permit: false, badge: true, cancelNotice: true, quietHours: true } })));
  await check('allow: the same checklist fully ticked (positive control)', 'allow', rep.collection('canvass_checks').doc('C2').set(chk(REP)));
  await check('deny: a checklist saved for another rep', 'deny', rep.collection('canvass_checks').doc('C3').set(chk(REP2)));
  await check('deny: a checklist stamped with another company', 'deny', rep.collection('canvass_checks').doc('C4').set(chk(REP, { companyId: OTHER })));
  await check('deny: a bad date', 'deny', rep.collection('canvass_checks').doc('C5').set(chk(REP, { ymd: '10/16/2026' })));
  await check('deny: an extra key', 'deny', rep.collection('canvass_checks').doc('C6').set(chk(REP, { note: 'x' })));
  await check('deny: a viewer saves one', 'deny', viewer.collection('canvass_checks').doc('C7').set(chk(VIEWER)));
  await check('deny: editing a saved checklist', 'deny', rep.doc('canvass_checks/C1').update({ town: 'Elsewhere' }));
  await check('the rep reads their own checklist', 'allow', rep.doc('canvass_checks/C1').get());
  await check('deny: another rep reads it', 'deny', rep2.doc('canvass_checks/C1').get());
  await check('the owner lists today\'s checklists for the company', 'allow', owner.collection('canvass_checks').where('companyId', '==', CO).where('ymd', '==', '2026-10-16').get());
  await check('deny: another company lists them', 'deny', stranger.collection('canvass_checks').where('companyId', '==', CO).get());
  await check('deny: the rep deletes a checklist', 'deny', rep.doc('canvass_checks/C1').delete());
  await check('the owner can remove a checklist', 'allow', owner.doc('canvass_checks/C2').delete());

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
