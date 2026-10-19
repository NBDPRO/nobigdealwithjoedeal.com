/**
 * Firestore rules — the messaging kill switch collections + the consent fields (2026-10-19).
 *
 *   messaging_controls/{global,automations,internal}   the master customer-send switch
 *   messaging_controls_audit, messaging_controls_counters, messaging_dedupe, sms_consent_overrides
 *   leads.tcpaConsent* (server-captured evidence the text-consent basis reads)
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-msgctl-test \
 *     'node firestore-rules.messaging-controls.test.js'
 *
 * Every collection: every client (anonymous, viewer, sales_rep, an other-tenant admin, a solo owner, the
 * NBD owner's own client SDK, the platform admin) x get / list / create / update / delete = DENIED
 * (admin SDK only). The lead consent fields: a rep cannot write them on create or update (the spoof that
 * would unlock texting a cold number), with positive controls of the same writes minus the consent fields.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-msgctl-test';
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
    results.push({ label, ok: false, note: expect === 'deny' ? 'WAS ALLOWED' : 'was denied: ' + String((e && e.message) || e).slice(0, 140) });
  }
}

const NBD_OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const carolOther = ctx('carol', { role: 'company_admin', companyId: 'co-b' });   // other tenant, strongest tenant role
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const solo = ctx('solo1', {});
  const nbd = ctx(NBD_OWNER, {});                                                   // the NBD owner through the client SDK
  const nbdAdmin = ctx(NBD_OWNER, { role: 'admin' });
  const joe = ctx('joe', { role: 'admin' });                                        // platform admin
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, collection, deleteDoc, updateDoc } = require('firebase/firestore');

  const COLLS = {
    messaging_controls: 'global',
    messaging_controls_audit: 'a1',
    messaging_controls_counters: 'internal_sms_2026101915',
    messaging_dedupe: 'd1',
    sms_consent_overrides: 'o1',
  };
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    for (const [coll, id] of Object.entries(COLLS)) await setDoc(doc(db, coll + '/' + id), { customerSendsEnabled: true, smsEnabled: true, n: 1 });
    await setDoc(doc(db, 'leads/lead-a'), { userId: 'alice', companyId: 'co-a', firstName: 'Sam', phoneDigits: '5550142222' });
    await setDoc(doc(db, 'leads/lead-c'), { userId: 'alice', companyId: 'co-a', firstName: 'Cy', phoneDigits: '5550142223', tcpaConsent: true, tcpaConsentAt: 1 });
  });

  const clients = { anon, viewer: vic, sales_rep: alice, otherTenantAdmin: carolOther, solo, nbdOwnerClient: nbd, nbdOwnerAdminClaim: nbdAdmin, platformAdmin: joe };
  for (const [coll, id] of Object.entries(COLLS)) {
    for (const [who, db] of Object.entries(clients)) {
      await check(coll + ': ' + who + ' cannot get', 'deny', getDoc(doc(db, coll + '/' + id)));
      await check(coll + ': ' + who + ' cannot list', 'deny', getDocs(collection(db, coll)));
      await check(coll + ': ' + who + ' cannot create', 'deny', setDoc(doc(db, coll + '/new-' + who), { customerSendsEnabled: true, canary: false }));
      await check(coll + ': ' + who + ' cannot update', 'deny', updateDoc(doc(db, coll + '/' + id), { customerSendsEnabled: true }));
      await check(coll + ': ' + who + ' cannot delete', 'deny', deleteDoc(doc(db, coll + '/' + id)));
    }
  }

  // The consent spoof: a rep writing the evidence the server reads.
  await check('lead update: the rep CANNOT set tcpaConsent on a cold lead', 'deny', updateDoc(doc(alice, 'leads/lead-a'), { tcpaConsent: true }));
  await check('lead update: ...nor tcpaConsent + tcpaConsentAt together', 'deny', updateDoc(doc(alice, 'leads/lead-a'), { tcpaConsent: true, tcpaConsentAt: 1760000000000 }));
  await check('lead update: ...nor tcpaConsentText / Source / Ip / Version', 'deny', updateDoc(doc(alice, 'leads/lead-a'), { tcpaConsentText: 'tcpa-v3', tcpaConsentSource: '/inspect', tcpaConsentIp: '1.2.3.4', tcpaConsentVersion: 'v3' }));
  await check('lead update: ...nor flip a real consent record to something else', 'deny', updateDoc(doc(alice, 'leads/lead-c'), { tcpaConsent: false }));
  await check('lead update: control - the same rep edits an ordinary field', 'allow', updateDoc(doc(alice, 'leads/lead-a'), { firstName: 'Samuel' }));
  await check('lead update: control - re-saving the unchanged consent record is fine', 'allow', updateDoc(doc(alice, 'leads/lead-c'), { tcpaConsent: true, tcpaConsentAt: 1, firstName: 'Cyrus' }));
  await check('lead create: a rep CANNOT create a lead already carrying tcpaConsent', 'deny',
    setDoc(doc(alice, 'leads/lead-new1'), { userId: 'alice', companyId: 'co-a', meter: 'manual', firstName: 'Zed', tcpaConsent: true, tcpaConsentAt: 1760000000000 }));
  await check('lead create: control - the same lead without the consent fields', 'allow',
    setDoc(doc(alice, 'leads/lead-new2'), { userId: 'alice', companyId: 'co-a', meter: 'manual', firstName: 'Zed' }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => { if (!r.ok) console.log('  ✗ ' + r.label + '  >>> ' + r.note); });
  console.log('\nmessaging controls + consent rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
