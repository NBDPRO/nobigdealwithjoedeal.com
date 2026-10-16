/**
 * Firestore rules - D2D door lists (2026-10-16).
 *
 *   d2d_doorlists/{listId}   (docs/pro/js/d2d-door-import.js)
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-doorlists-test \
 *     'node firestore-rules.d2d-doorlists.test.js'
 *
 * Tenant + rep isolation: the importer, their company's owner / manager and
 * the teammate it is assigned to read it; another rep of the same company,
 * another company and a signed-out visitor do not. Only the importer writes,
 * never a viewer, and companyId / userId never move. Every shape deny is
 * paired with an allow of the same doc minus the one defect, so a rule that
 * denies everything cannot pass. A parity check fails if the client's key
 * list (d2d-door-import.js LIST_KEYS) drifts from the rules' allowlist.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-doorlists-test';
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

const RULES_PATH = process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules');
const CO = 'coDoorA', OTHER = 'coDoorB';
const OWNER = 'ownerA', MANAGER = 'mgrA', REP = 'repA', REP2 = 'repA2', VIEWER = 'viewA', STRANGER = 'ownerB';

function list(over) {
  return Object.assign({
    userId: OWNER, companyId: CO, assignedTo: REP, name: 'Mason 45040 aging roofs', source: 'CSV import', createdAt: 1760000000000, rowCount: 1,
    doors: [{ a: '1 Test St, Mason, OH 45040', la: 39.36, ln: -84.31, z: '45040', t: 'Mason', y: 1998, r: null, ag: 28, b: 'year_built', rt: 'R1', s: 1 }],
    notes: [{ town: 'Mason', note: 'Register with Mason Police first (Ch. 707).' }],
  }, over || {});
}

async function run() {
  // ── parity: the client's list keys == the rules allowlist ──────────────
  {
    const client = require('../docs/pro/js/d2d-door-import.js');
    const src = fs.readFileSync(RULES_PATH, 'utf8');
    const m = /function doorListShapeOk\(d\) \{\s*return d\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/.exec(src);
    const inRules = m ? (m[1].match(/'([A-Za-z]+)'/g) || []).map((x) => x.slice(1, -1)).sort() : [];
    const same = inRules.length > 0 && JSON.stringify(inRules) === JSON.stringify(client.LIST_KEYS.slice().sort());
    results.push({ label: 'parity: LIST_KEYS equals the rules allowlist', ok: same, note: same ? '' : 'rules=' + inRules.join(',') });
  }

  const env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8') } });
  await env.clearFirestore();
  const as = (uid, claims) => env.authenticatedContext(uid, claims || {}).firestore();
  const owner = as(OWNER, { companyId: CO, role: 'company_admin' });
  const mgr = as(MANAGER, { companyId: CO, role: 'manager' });
  const rep = as(REP, { companyId: CO, role: 'sales_rep' });
  const rep2 = as(REP2, { companyId: CO, role: 'sales_rep' });
  const viewer = as(VIEWER, { companyId: CO, role: 'viewer' });
  const stranger = as(STRANGER, { companyId: OTHER, role: 'company_admin' });
  const anon = env.unauthenticatedContext().firestore();

  // create
  await check('owner creates a list in their own company', 'allow', owner.doc('d2d_doorlists/L1').set(list()));
  await check('a rep creates their own list', 'allow', rep.doc('d2d_doorlists/R1').set(list({ userId: REP, assignedTo: null })));
  await check('deny: create for someone else (userId not mine)', 'deny', rep.doc('d2d_doorlists/X1').set(list({ userId: OWNER })));
  await check('deny: create stamped with another company', 'deny', owner.doc('d2d_doorlists/X2').set(list({ companyId: OTHER })));
  await check('deny: create with no companyId', 'deny', owner.doc('d2d_doorlists/X3').set((() => { const d = list(); delete d.companyId; return d; })()));
  await check('deny: a viewer creates', 'deny', viewer.doc('d2d_doorlists/X4').set(list({ userId: VIEWER })));
  await check('deny: signed out creates', 'deny', anon.doc('d2d_doorlists/X5').set(list()));
  await check('deny: an extra key (an owner name) on the list', 'deny', owner.doc('d2d_doorlists/X6').set(list({ ownerName: 'Jane Doe' })));
  await check('allow: same doc without the extra key (positive control)', 'allow', owner.doc('d2d_doorlists/X6').set(list()));
  await check('deny: more than 1500 doors', 'deny', owner.doc('d2d_doorlists/X7').set(list({ doors: new Array(1501).fill(list().doors[0]) })));
  await check('allow: exactly 1500 doors', 'allow', owner.doc('d2d_doorlists/X7').set(list({ doors: new Array(1500).fill(list().doors[0]), rowCount: 1500 })));
  await check('deny: an empty name', 'deny', owner.doc('d2d_doorlists/X8').set(list({ name: '' })));
  await check('deny: a solo owner (no company claim) stamping another tenant', 'deny', as('soloZ').doc('d2d_doorlists/X9').set(list({ userId: 'soloZ', companyId: OTHER })));
  await check('allow: a solo owner stamping their own uid as the company', 'allow', as('soloZ').doc('d2d_doorlists/X9').set(list({ userId: 'soloZ', companyId: 'soloZ', assignedTo: null })));

  // read
  await check('owner reads their list', 'allow', owner.doc('d2d_doorlists/L1').get());
  await check('the company manager reads it', 'allow', mgr.doc('d2d_doorlists/L1').get());
  await check('the rep it is assigned to reads it', 'allow', rep.doc('d2d_doorlists/L1').get());
  await check('deny: another rep of the same company (not assigned)', 'deny', rep2.doc('d2d_doorlists/L1').get());
  await check('deny: another company\'s owner', 'deny', stranger.doc('d2d_doorlists/L1').get());
  await check('deny: signed out', 'deny', anon.doc('d2d_doorlists/L1').get());
  await check('the owner\'s query of their own lists', 'allow', owner.collection('d2d_doorlists').where('userId', '==', OWNER).get());
  await check('the rep\'s query of lists assigned to them in their company', 'allow', rep.collection('d2d_doorlists').where('assignedTo', '==', REP).where('companyId', '==', CO).get());
  await check('deny: a rep querying every list of the company', 'deny', rep2.collection('d2d_doorlists').where('companyId', '==', CO).get());
  await check('deny: a rep reading another rep\'s own list', 'deny', rep2.doc('d2d_doorlists/R1').get());

  // update / delete
  await check('owner renames it', 'allow', owner.doc('d2d_doorlists/L1').update({ name: 'Mason route A' }));
  await check('deny: owner moves it to another company', 'deny', owner.doc('d2d_doorlists/L1').update({ companyId: OTHER }));
  await check('deny: owner hands it to another user id', 'deny', owner.doc('d2d_doorlists/L1').update({ userId: REP }));
  await check('deny: the assigned rep edits it', 'deny', rep.doc('d2d_doorlists/L1').update({ name: 'mine now' }));
  await check('deny: the manager edits the owner\'s list', 'deny', mgr.doc('d2d_doorlists/L1').update({ name: 'x' }));
  await check('deny: the assigned rep deletes it', 'deny', rep.doc('d2d_doorlists/L1').delete());
  await check('the owner deletes it', 'allow', owner.doc('d2d_doorlists/L1').delete());

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
