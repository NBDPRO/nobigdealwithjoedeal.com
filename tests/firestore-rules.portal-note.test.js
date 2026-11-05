/**
 * Firestore rules — the rep's homeowner-portal note (2026-11-04, portal Phase 2).
 *
 *   leads/{leadId}.portalNote = { text: string 1..160, atMs: number } | null
 *   docs/pro/js/customer-gallery-share.js editPortalNote (the only writer)
 *   functions/portal-today.js noteFor (the only reader; re-checks wording)
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-pnote-test \
 *     'node firestore-rules.portal-note.test.js'
 *
 * Every shape deny is paired with an allow of the same write minus the one
 * defect (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-pnote-test';
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
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });     // owns the lead
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const { doc, updateDoc } = require('firebase/firestore');

  await env.withSecurityRulesDisabled(async (c) => {
    const { setDoc } = require('firebase/firestore');
    await setDoc(doc(c.firestore(), 'leads/L1'), { userId: 'alice', companyId: 'co-a', firstName: 'Sample', stage: 'install_scheduled' });
  });
  const lead = (db) => doc(db, 'leads/L1');
  const NOW = Date.UTC(2026, 10, 4, 17);

  // -- shape (each deny paired with the control right above it)
  await check('control: {text, atMs} saves', 'allow', updateDoc(lead(alice), { portalNote: { text: 'Crew arrives 7:30.', atMs: NOW } }));
  await check('a smuggled third key is denied', 'deny', updateDoc(lead(alice), { portalNote: { text: 'Crew arrives 7:30.', atMs: NOW, from: 'Joe' } }));
  await check('control: 160 characters save', 'allow', updateDoc(lead(alice), { portalNote: { text: 'a'.repeat(160), atMs: NOW } }));
  await check('161 characters are denied', 'deny', updateDoc(lead(alice), { portalNote: { text: 'a'.repeat(161), atMs: NOW } }));
  await check('empty text is denied (clear with null instead)', 'deny', updateDoc(lead(alice), { portalNote: { text: '', atMs: NOW } }));
  await check('a string atMs is denied', 'deny', updateDoc(lead(alice), { portalNote: { text: 'hi', atMs: 'now' } }));
  await check('missing atMs is denied', 'deny', updateDoc(lead(alice), { portalNote: { text: 'hi' } }));
  await check('a bare string note is denied', 'deny', updateDoc(lead(alice), { portalNote: 'hi' }));
  await check('control: null clears it', 'allow', updateDoc(lead(alice), { portalNote: null }));
  await check('control: an unrelated edit on a lead with no note still saves', 'allow', updateDoc(lead(alice), { firstName: 'Sam' }));

  // -- who
  await check('a viewer CANNOT set a note', 'deny', updateDoc(lead(vic), { portalNote: { text: 'hi', atMs: NOW } }));
  await check('another tenant CANNOT set a note', 'deny', updateDoc(lead(bobCA), { portalNote: { text: 'hi', atMs: NOW } }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nportalNote rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
