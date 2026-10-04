/**
 * tests/auth-access.test.js — Phase 1 behavioral auth + access-control tests.
 *
 * Drives the REAL front door against the Auth + Firestore emulators using the
 * same client `firebase` SDK the browser ships: provisions the seeded role
 * users (admin SDK), then SIGNS IN as each role with email/password and asserts
 * (a) sign-in succeeds, (b) the ID token carries the expected role + companyId
 * custom claims, (c) Firestore rules enforce per-role access on the same paths
 * the CRM reads/writes, (d) password reset issues an OOB code, (e) logout clears
 * the session. This is end-to-end behavior, not a source grep.
 *
 * RUN (via emulator):
 *   firebase emulators:exec --only auth,firestore --project nobigdeal-pro \
 *     'node tests/auth-access.test.js'
 */
'use strict';

const assert = require('assert');
const { initializeApp: initializeAdminApp } = require('firebase-admin/app');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } = require('firebase/auth');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, collection, addDoc,
} = require('firebase/firestore');

const PROJECT = process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
const COMPANY_ID = 'demo-co';
const PASSWORD = 'Test123!';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('✗ emulator host env not set — run via `firebase emulators:exec`.');
  process.exit(1);
}

const ROLES = [
  { key: 'companyAdmin', email: 'companyadmin@demo.test', claims: { role: 'company_admin', companyId: COMPANY_ID } },
  { key: 'salesRep',     email: 'salesrep@demo.test',     claims: { role: 'sales_rep',     companyId: COMPANY_ID } },
  { key: 'viewer',       email: 'viewer@demo.test',       claims: { role: 'viewer',        companyId: COMPANY_ID } },
  { key: 'platformAdmin',email: 'admin@demo.test',        claims: { role: 'admin',         companyId: COMPANY_ID } },
];

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
async function denied(name, p) {
  try { await p; ok(name + ' (expected DENY)', false); }
  catch (e) { ok(name, e && (e.code === 'permission-denied' || /PERMISSION_DENIED|Missing or insufficient/i.test(e.message))); }
}
async function allowed(name, p) {
  try { await p; ok(name, true); }
  catch (e) { ok(name + ' — ' + (e.code || e.message), false); }
}

// ── admin-side provisioning ──────────────────────────────────
initializeAdminApp({ projectId: PROJECT });
const adb = getAdminFirestore();

async function provision() {
  const uid = {};
  for (const r of ROLES) {
    let rec;
    try { rec = await getAdminAuth().getUserByEmail(r.email); }
    catch { rec = await getAdminAuth().createUser({ email: r.email, password: PASSWORD, emailVerified: true }); }
    await getAdminAuth().setCustomUserClaims(rec.uid, r.claims);
    await adb.doc(`users/${rec.uid}`).set({ role: r.claims.role, companyId: COMPANY_ID }, { merge: true });
    uid[r.key] = rec.uid;
  }
  // One lead owned by companyAdmin, one by salesRep — both companyId-stamped.
  await adb.doc('leads/lead_admin').set({ userId: uid.companyAdmin, companyId: COMPANY_ID, name: 'Admin Lead', stage: 'new', deleted: false });
  await adb.doc('leads/lead_rep').set({ userId: uid.salesRep, companyId: COMPANY_ID, name: 'Rep Lead', stage: 'new', deleted: false });
  return uid;
}

// ── client SDK per-role driver ───────────────────────────────
function clientFor() {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'fake-emulator-key' }, 'c_' + Math.random().toString(36).slice(2));
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
  const db = getFirestore(app);
  const [h, p] = FS_HOST.split(':');
  connectFirestoreEmulator(db, h, Number(p));
  return { auth, db };
}

async function run() {
  const uid = await provision();

  console.log('\nSIGN-IN + CLAIMS (each seeded role)');
  for (const r of ROLES) {
    const { auth } = clientFor();
    const cred = await signInWithEmailAndPassword(auth, r.email, PASSWORD).catch(e => ({ err: e }));
    if (cred.err) { ok(`${r.key}: sign-in — ${cred.err.code}`, false); continue; }
    const tok = await cred.user.getIdTokenResult();
    ok(`${r.key}: sign-in succeeds`, !!cred.user.uid);
    ok(`${r.key}: claim role === ${r.claims.role}`, tok.claims.role === r.claims.role);
    ok(`${r.key}: claim companyId === ${COMPANY_ID}`, tok.claims.companyId === COMPANY_ID);
    await signOut(auth);
  }

  console.log('\nFIRESTORE RULES ENFORCEMENT (per role)');
  // company_admin: reads OWN lead AND the rep's — team pipeline visibility
  // (2026-07-06) company-scopes lead reads for company_admin/manager/viewer.
  // (This assertion was inverted before that change: reads were
  // userId-scoped and the team feature shipped invite-complete but
  // visibility-incomplete — the Stranger Test punch list item #1.)
  {
    const { auth, db } = clientFor();
    await signInWithEmailAndPassword(auth, 'companyadmin@demo.test', PASSWORD);
    await allowed('company_admin reads OWN lead', getDoc(doc(db, 'leads/lead_admin')).then(s => { if (!s.exists()) throw new Error('missing'); }));
    await allowed('company_admin reads rep-owned SAME-COMPANY lead (team visibility)',
      getDoc(doc(db, 'leads/lead_rep')).then(s => { if (!s.exists()) throw new Error('missing'); }));
    await signOut(auth);
  }
  // sales_rep: own-only reads survive team visibility (Wave 110 semantics).
  {
    const { auth, db } = clientFor();
    await signInWithEmailAndPassword(auth, 'salesrep@demo.test', PASSWORD);
    await denied('sales_rep CANNOT read the company_admin\'s lead (own-only)',
      getDoc(doc(db, 'leads/lead_admin')));
    await signOut(auth);
  }
  // platform admin: reads ANY lead (isAdmin()).
  {
    const { auth, db } = clientFor();
    await signInWithEmailAndPassword(auth, 'admin@demo.test', PASSWORD);
    await allowed('platform admin reads rep-owned lead (isAdmin)', getDoc(doc(db, 'leads/lead_rep')).then(s => { if (!s.exists()) throw new Error('missing'); }));
    await signOut(auth);
  }
  // sales_rep: create-rule companyId enforcement.
  {
    const { auth, db } = clientFor();
    const cred = await signInWithEmailAndPassword(auth, 'salesrep@demo.test', PASSWORD);
    const myUid = cred.user.uid;
    await allowed('sales_rep creates lead with own companyId',
      addDoc(collection(db, 'leads'), { userId: myUid, companyId: COMPANY_ID, name: 'New', stage: 'new', deleted: false, meter: 'manual' }));
    await denied('sales_rep CANNOT create lead with FOREIGN companyId',
      addDoc(collection(db, 'leads'), { userId: myUid, companyId: 'someone-else', name: 'X', stage: 'new', deleted: false }));
    await denied('sales_rep CANNOT create lead with NO companyId',
      addDoc(collection(db, 'leads'), { userId: myUid, name: 'X', stage: 'new', deleted: false }));
    await denied('sales_rep CANNOT create lead owned by another uid',
      addDoc(collection(db, 'leads'), { userId: 'not-me', companyId: COMPANY_ID, name: 'X', stage: 'new', deleted: false }));
    await signOut(auth);
  }
  // F-1 (fixed): the leads write rule now requires a non-viewer role. A 'viewer'
  // who owns a lead can still READ it but can NOT mutate it at the rules layer.
  {
    const { auth, db } = clientFor();
    const cred = await signInWithEmailAndPassword(auth, 'viewer@demo.test', PASSWORD);
    await adbSeedViewerLead(cred.user.uid);
    await allowed('viewer CAN still read a lead they own',
      getDoc(doc(db, 'leads/lead_viewer')).then(s => { if (!s.exists()) throw new Error('missing'); }));
    await denied('viewer CANNOT update a lead they own (F-1: role-gated writes)',
      setDoc(doc(db, 'leads/lead_viewer'), { stage: 'contacted' }, { merge: true }));
    await signOut(auth);
  }

  console.log('\nACCOUNT LIFECYCLE');
  // Password reset → Auth emulator issues an OOB code.
  {
    const { auth } = clientFor();
    await sendPasswordResetEmail(auth, 'salesrep@demo.test');
    const res = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/oobCodes`);
    const body = await res.json();
    const hasReset = (body.oobCodes || []).some(c => c.requestType === 'PASSWORD_RESET' && c.email === 'salesrep@demo.test');
    ok('password reset issues a PASSWORD_RESET OOB code', hasReset);
  }
  // Logout clears the session.
  {
    const { auth } = clientFor();
    await signInWithEmailAndPassword(auth, 'viewer@demo.test', PASSWORD);
    ok('logout: currentUser set after sign-in', !!auth.currentUser);
    await signOut(auth);
    ok('logout: currentUser null after signOut', auth.currentUser === null);
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All auth + access-control tests passed');
}

async function adbSeedViewerLead(uid) {
  await adb.doc('leads/lead_viewer').set({ userId: uid, companyId: COMPANY_ID, name: 'Viewer Lead', stage: 'new', deleted: false });
}

// Explicit exit: admin + client Firestore gRPC channels keep the event loop
// alive; without this the process hangs and emulators:exec never returns.
run().then(() => process.exit(0)).catch(e => { console.error('auth-access test crashed:', e && (e.stack || e.message)); process.exit(1); });
