/**
 * tests/lead-bridge.integration.test.js — Phase C H-1 bridge, END-TO-END.
 *
 * Drives the REAL onCreate bridge triggers (functions + firestore emulator):
 * writes public-form leads into the *_leads collections via the admin SDK and
 * asserts the trigger mirrors them into the CRM `leads` collection with the
 * correct tenant owner, shape, idempotency, and the skip behaviour.
 *
 * No real outbound: the emulator has no Twilio/Resend secrets, so lead-alert
 * (which also fires on these collections) fails its sends closed (try/catch).
 * All fixtures are ZZ_QA_ prefixed and ephemeral (emulator data is wiped).
 *
 * RUN:
 *   npx firebase-tools emulators:exec --only functions,firestore --project demo-nbd-pl \
 *     "node tests/lead-bridge.integration.test.js"
 */
'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'demo-nbd-pl';
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('✗ emulator env not set — run via emulators:exec --only functions,firestore');
  process.exit(1);
}
initializeApp({ projectId: PROJECT });
const db = getFirestore();

// Must match lead-bridge.js NBD_OWNER_UID default (overridable via env there).
const NBD_OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForDoc(ref, ms = 35000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await ref.get(); if (s.exists) return s; await sleep(300); }
  return null;
}
async function staysAbsent(ref, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await ref.get()).exists) return false; await sleep(400); }
  return !(await ref.get()).exists;
}

async function run() {
  console.log('LEAD-BRIDGE INTEGRATION — public submit → CRM leads');
  const RUN = 'ZZ_QA_' + Date.now();

  // ── 1) NBD untagged inspect lead → mirrored to tenant-zero owner ──
  const insRef = await db.collection('inspect_leads').add({
    name: RUN + ' Roof', phone: '8594207382', address: '1 QA Ln, Batavia OH',
    email: 'qa@example.com', story: 'hail', source: 'qr-inspect', companyId: null,
  });
  const nbdLead = await waitForDoc(db.doc('leads/inspect_leads__' + insRef.id));
  ok('NBD inspect lead mirrored into CRM leads', !!nbdLead);
  if (nbdLead) {
    const d = nbdLead.data();
    ok('NBD: userId = tenant-zero owner', d.userId === NBD_OWNER);
    ok('NBD: companyId = owner uid (solo)', d.companyId === NBD_OWNER);
    ok('NBD: stage is the canonical new key + role', d.stage === 'new' && d.stageRole === 'new');
    ok('NBD: source label', d.source === 'Website — Inspection / Storm tool');
    ok('NBD: webLead flag', d.webLead === true);
    ok('NBD: provenance id', d.publicLeadId === insRef.id);
    ok('NBD: firstName split from name', d.firstName === RUN);
  }

  // ── 2) Tenant-tagged contact lead → mirrored to that tenant's owner ──
  const TEN = RUN + '_oaks';          // slug-style companyId (needs ownerId)
  const OWNER = RUN + 'OwnerUid';
  await db.doc('companies/' + TEN).set({ name: 'ZZ QA Oaks', ownerId: OWNER });
  const conRef = await db.collection('contact_leads').add({
    firstName: 'ZZ_QA Bob', phone: '5135550100', source: 'website', companyId: TEN,
  });
  const tenLead = await waitForDoc(db.doc('leads/contact_leads__' + conRef.id));
  ok('tenant contact lead mirrored into CRM leads', !!tenLead);
  if (tenLead) {
    const d = tenLead.data();
    ok('tenant: userId = company ownerId', d.userId === OWNER);
    ok('tenant: companyId preserved', d.companyId === TEN);
    ok('tenant: source = Contact form', d.source === 'Website — Contact form');
  }

  // ── 3) Tenant slug with NO ownerId / no company doc → skip (no guess) ──
  const badRef = await db.collection('estimate_leads').add({
    address: '2 QA Ln', source: 'web', companyId: RUN + '-unknownslug',
  });
  const skipped = await staysAbsent(db.doc('leads/estimate_leads__' + badRef.id), 6000);
  ok('unresolvable owner → no CRM lead created (skip, no guess)', skipped);

  // ── 4) Idempotency: re-delivery must not duplicate or overwrite ──
  const fixed = RUN + '_fixed';
  await db.doc('inspect_leads/' + fixed).set({ name: 'ZZ_QA Idem', phone: '1', address: 'x', source: 'web', companyId: null });
  const idem1 = await waitForDoc(db.doc('leads/inspect_leads__' + fixed));
  ok('idem: first delivery creates the lead', !!idem1);
  // Mark it so we can detect an overwrite, then re-fire the trigger.
  await db.doc('leads/inspect_leads__' + fixed).update({ _idemMarker: 'keep' });
  await db.doc('inspect_leads/' + fixed).delete();
  await db.doc('inspect_leads/' + fixed).set({ name: 'ZZ_QA Idem TWO', phone: '2', address: 'y', source: 'web', companyId: null });
  await sleep(4000);
  const idem2 = await db.doc('leads/inspect_leads__' + fixed).get();
  ok('idem: re-delivery did NOT overwrite (create()-or-skip)',
    idem2.exists && idem2.data()._idemMarker === 'keep' && idem2.data().firstName === 'ZZ_QA');

  // ── 5) FULL 3b path: Oaks gateway submit (relaxed contact schema) → bridge ──
  // NOTE: submitPublicLead sanitizes companyId via .toLowerCase().replace(
  // /[^a-z0-9-]/g,'') before validating it against companies/{id}. So a tenant
  // companyId MUST be lowercase [a-z0-9-] to survive (real 'oaks' is fine). Use
  // a sanitization-safe id here — an underscore/uppercase id would be stripped
  // and silently fall back to NBD.
  const TEN2 = 'zzqaoaks' + Date.now();
  const OWNER2 = RUN + 'OwnerTwo';
  await db.doc('companies/' + TEN2).set({ name: 'ZZ QA Oaks2', ownerId: OWNER2 });
  const FN_HOST = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
  const FN_URL = `http://${FN_HOST}/${PROJECT}/us-central1/submitPublicLead`;
  const postRes = await fetch(FN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'contact', firstName: 'ZZ_QA Oaks', phone: '5135550199', source: 'website',
      lastName: 'Homeowner', email: 'oaksqa@example.com', zip: '45122',
      service: 'Roof Replacement', message: 'Need a quote on hail damage', companyId: TEN2,
    }),
  });
  let postBody = null; try { postBody = await postRes.json(); } catch (_) {}
  ok('gateway accepts Oaks contact submit (200 + id)', postRes.status === 200 && postBody && !!postBody.id);
  if (postBody && postBody.id) {
    const cl = await db.doc('contact_leads/' + postBody.id).get();
    ok('gateway stamped companyId=oaks2', cl.exists && cl.data().companyId === TEN2);
    ok('gateway persisted relaxed fields (service/message/zip)',
      cl.exists && cl.data().service === 'Roof Replacement' && /hail damage/.test(cl.data().message || '') && cl.data().zip === '45122');
    const ob = await waitForDoc(db.doc('leads/contact_leads__' + postBody.id));
    ok('Oaks gateway lead bridged → CRM, owner = Oaks owner', !!ob && ob.data().userId === OWNER2);
    ok('Oaks gateway lead: companyId preserved', !!ob && ob.data().companyId === TEN2);
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All lead-bridge integration tests passed');
}

run().then(() => process.exit(0)).catch(e => { console.error('integration test crashed:', e && (e.stack || e.message)); process.exit(1); });
