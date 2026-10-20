/**
 * Firestore rules - monthCloses/{companyId_YYYY-MM} (2026-10-19, flag monthClose).
 *
 * One saved close per company per month: totals in integer cents, checked
 * items, notes, a bounded editLog. Only the OWNER writes it: a platform admin, a
 * company_admin of the company, or a solo operator (no role claim) who owns the
 * tenant. Managers, reps and viewers cannot write; company readers (company_admin,
 * manager, viewer) and the solo owner can read; another tenant and anonymous
 * cannot do either. SYNTHETIC ids and numbers only (public repo).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-mclose-test \
 *     'node firestore-rules.month-close.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-mclose-test';
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
  const solo = ctx('co-a', {});                                                  // solo owner: uid == companyId, no role
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const mike = ctx('mike', { role: 'manager', companyId: 'co-a' });
  const rep = ctx('rep1', { role: 'sales_rep', companyId: 'co-a' });
  const vera = ctx('vera', { role: 'viewer', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'company_admin', companyId: 'co-b' });           // another tenant's admin
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, deleteDoc, doc, getDoc, serverTimestamp } = require('firebase/firestore');
  const ref = (db, id) => doc(db, 'monthCloses/' + id);

  const totals = () => ({ collectedCents: 1840000, grossCents: 1900000, refundsCents: 60000, directCents: 910000, overheadCents: 120000, profitCents: 810000, depositsCents: 1790000, rateBp: 2500, setAsideCents: 202500 });
  const mk = (uid, companyId, monthKey, over) => Object.assign({
    companyId, monthKey, totals: totals(), checks: { collected: true }, explain: { deposits: 'processor fees' }, notes: 'synthetic',
    editLog: [{ at: 1700000000000, by: uid, what: 'saved the close', note: '' }],
    createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid,
  }, over || {});

  // a saved close to update / read, written with rules off
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    const t = new Date('2026-09-05T12:00:00Z');
    await setDoc(doc(f, 'monthCloses/co-a_2026-08'), {
      companyId: 'co-a', monthKey: '2026-08', totals: totals(), checks: {}, explain: {}, notes: '',
      editLog: [{ at: 1, by: 'co-a', what: 'saved the close', note: '' }], createdAt: t, createdBy: 'co-a', updatedAt: t, updatedBy: 'co-a',
    });
  });

  // ── create ──
  await check('solo owner can create a close', 'allow', setDoc(ref(solo, 'co-a_2026-09'), mk('co-a', 'co-a', '2026-09')));
  await check('company_admin can create a close', 'allow', setDoc(ref(carol, 'co-a_2026-10'), mk('carol', 'co-a', '2026-10')));
  await check('platform admin can create a close', 'allow', setDoc(ref(joe, 'co-a_2026-07'), mk('joe', 'co-a', '2026-07')));
  await check('manager cannot create', 'deny', setDoc(ref(mike, 'co-a_2025-08'), mk('mike', 'co-a', '2025-08')));
  await check('sales rep cannot create', 'deny', setDoc(ref(rep, 'co-a_2025-09'), mk('rep1', 'co-a', '2025-09')));
  await check('viewer cannot create', 'deny', setDoc(ref(vera, 'co-a_2025-10'), mk('vera', 'co-a', '2025-10')));
  await check('another tenant\'s admin cannot create in this company', 'deny', setDoc(ref(eve, 'co-a_2025-11'), mk('eve', 'co-a', '2025-11')));
  await check('another tenant\'s admin can create in their own company (control)', 'allow', setDoc(ref(eve, 'co-b_2026-06'), mk('eve', 'co-b', '2026-06')));
  await check('anonymous cannot create', 'deny', setDoc(ref(anon, 'co-a_2025-12'), mk('x', 'co-a', '2025-12')));
  await check('a doc id that is not companyId_monthKey is refused', 'deny', setDoc(ref(solo, 'anything'), mk('co-a', 'co-a', '2026-05')));
  await check('an id for a different month than the doc says is refused', 'deny', setDoc(ref(solo, 'co-a_2026-04'), mk('co-a', 'co-a', '2026-05')));
  await check('a bad month key is refused', 'deny', setDoc(ref(solo, 'co-a_2026-13'), mk('co-a', 'co-a', '2026-13')));
  await check('an extra field is refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { extra: 'x' })));
  await check('totals with an extra key are refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { totals: Object.assign(totals(), { ssn: '1' }) })));
  await check('dollars as a float (not integer cents) are refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { totals: Object.assign(totals(), { collectedCents: 18400.5 }) })));
  await check('a string amount is refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { totals: Object.assign(totals(), { directCents: '910000' }) })));
  await check('a negative direct cost is refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { totals: Object.assign(totals(), { directCents: -1 }) })));
  await check('a rate over 100 percent is refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { totals: Object.assign(totals(), { rateBp: 10001 }) })));
  await check('a loss month (negative profit, no set-aside, no deposits, no rate) is allowed', 'allow',
    setDoc(ref(solo, 'co-a_2026-02'), mk('co-a', 'co-a', '2026-02', { totals: Object.assign(totals(), { profitCents: -50000, setAsideCents: 0, depositsCents: null, rateBp: null }) })));
  await check('notes over 2000 characters are refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { notes: 'x'.repeat(2001) })));
  await check('an editLog over 25 entries is refused', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { editLog: Array.from({ length: 26 }, (_, i) => ({ at: i, by: 'co-a', what: 'x', note: '' })) })));
  await check('an empty editLog is refused (every save leaves a trail)', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { editLog: [] })));
  await check('updatedBy must be the caller', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { updatedBy: 'someone-else' })));
  await check('updatedAt must be server time (no backdating)', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { updatedAt: new Date('2020-01-01T00:00:00Z') })));
  await check('createdBy must be the caller', 'deny', setDoc(ref(solo, 'co-a_2026-03'), mk('co-a', 'co-a', '2026-03', { createdBy: 'someone-else' })));

  // ── update ──
  const upd = (uid, over) => ({ notes: 'edited', editLog: [{ at: 1, by: 'co-a', what: 'saved the close', note: '' }, { at: 2, by: uid, what: 'updated the close', note: '' }], updatedAt: serverTimestamp(), updatedBy: uid, ...(over || {}) });
  await check('solo owner can update', 'allow', updateDoc(ref(solo, 'co-a_2026-08'), upd('co-a')));
  await check('company_admin can update', 'allow', updateDoc(ref(carol, 'co-a_2026-08'), upd('carol')));
  await check('manager cannot update', 'deny', updateDoc(ref(mike, 'co-a_2026-08'), upd('mike')));
  await check('viewer cannot update', 'deny', updateDoc(ref(vera, 'co-a_2026-08'), upd('vera')));
  await check('sales rep cannot update', 'deny', updateDoc(ref(rep, 'co-a_2026-08'), upd('rep1')));
  await check('another tenant\'s admin cannot update', 'deny', updateDoc(ref(eve, 'co-a_2026-08'), upd('eve')));
  await check('the month key cannot change', 'deny', updateDoc(ref(solo, 'co-a_2026-08'), upd('co-a', { monthKey: '2026-07' })));
  await check('the company cannot change', 'deny', updateDoc(ref(solo, 'co-a_2026-08'), upd('co-a', { companyId: 'co-b' })));
  await check('createdBy cannot be rewritten', 'deny', updateDoc(ref(solo, 'co-a_2026-08'), upd('co-a', { createdBy: 'mallory' })));
  await check('createdAt cannot be rewritten', 'deny', updateDoc(ref(solo, 'co-a_2026-08'), upd('co-a', { createdAt: serverTimestamp() })));

  // ── read ──
  await check('solo owner can read', 'allow', getDoc(ref(solo, 'co-a_2026-08')));
  await check('company_admin can read', 'allow', getDoc(ref(carol, 'co-a_2026-08')));
  await check('manager can read', 'allow', getDoc(ref(mike, 'co-a_2026-08')));
  await check('viewer can read (read-only)', 'allow', getDoc(ref(vera, 'co-a_2026-08')));
  await check('platform admin can read', 'allow', getDoc(ref(joe, 'co-a_2026-08')));
  await check('sales rep cannot read', 'deny', getDoc(ref(rep, 'co-a_2026-08')));
  await check('another tenant\'s admin cannot read', 'deny', getDoc(ref(eve, 'co-a_2026-08')));
  await check('anonymous cannot read', 'deny', getDoc(ref(anon, 'co-a_2026-08')));

  // ── delete ──
  await check('solo owner cannot hard-delete', 'deny', deleteDoc(ref(solo, 'co-a_2026-08')));
  await check('company_admin cannot hard-delete', 'deny', deleteDoc(ref(carol, 'co-a_2026-08')));
  await check('platform admin can delete', 'allow', deleteDoc(ref(joe, 'co-a_2026-07')));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' - ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
