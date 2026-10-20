/**
 * Firestore rules - review_log/{leadId} (2026-10-19, flag reputationLoop).
 *
 * The owner's own log of a posted review: { companyId, leadId, reviewSeen,
 * platform, rating, responded, updatedAt, updatedBy }. Owner-only for read AND
 * write: a platform admin, a company_admin of the company, or a solo operator
 * who owns the tenant by uid. Managers, reps, viewers, another tenant and
 * anonymous get nothing, although managers and reps can read and edit leads
 * (positive controls below). The doc id is the lead id, the lead must belong to
 * the same company, the doc is exactly the eight keys, well-formed, stamped with
 * the caller and the server time. No delete.
 *
 * It lives in its own collection because the lead update rule has no spare
 * expression budget: the first version put a `reputation` map on the lead and
 * denied writes began to hit "maximum of 1000 expressions" (see the last block,
 * which pins that a plain lead edit still works and the lead rule is untouched).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-reputation-test \
 *     'node firestore-rules.reputation.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const RULES_OVERRIDE = process.env.RULES_PATH || '';
if (RULES_OVERRIDE) {
  if (process.env.CI) throw new Error('RULES_PATH is a local mutation-testing override and must not be set in CI');
  console.warn('!!! RULES_PATH override in use: testing ' + RULES_OVERRIDE + ' instead of firestore.rules !!!');
}
const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-reputation-test';
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
    firestore: { rules: fs.readFileSync(RULES_OVERRIDE || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[0], port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[1]) || 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const solo = ctx('co-a', {});                                                 // solo owner: uid == companyId, no role
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const mike = ctx('mike', { role: 'manager', companyId: 'co-a' });
  const rep = ctx('rep1', { role: 'sales_rep', companyId: 'co-a' });
  const vera = ctx('vera', { role: 'viewer', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'company_admin', companyId: 'co-b' });          // another tenant's admin
  const bob = ctx('co-b', {});                                                  // another tenant's solo owner
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, query, where, collection, serverTimestamp } = require('firebase/firestore');
  const log = (db, id) => doc(db, 'review_log/' + id);
  const entry = (uid, id, over) => Object.assign({ companyId: 'co-a', leadId: id, reviewSeen: true, platform: 'google', rating: 2, responded: false, updatedAt: serverTimestamp(), updatedBy: uid }, over || {});

  const base = { companyId: 'co-a', userId: 'co-a', firstName: 'ZZ_QA', lastName: 'Lead', stage: 'won', source: 'Yelp', notes: '' };
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    for (let i = 1; i <= 24; i++) await setDoc(doc(f, 'leads/L' + i), base);
    await setDoc(doc(f, 'leads/L_other'), Object.assign({}, base, { companyId: 'co-b', userId: 'co-b' }));
    await setDoc(doc(f, 'leads/L_rep'), Object.assign({}, base, { userId: 'rep1' }));
    await setDoc(doc(f, 'review_log/L_done'), { companyId: 'co-a', leadId: 'L_done', reviewSeen: true, platform: 'yelp', rating: 1, responded: false, updatedAt: new Date('2026-10-01'), updatedBy: 'co-a' });
    await setDoc(doc(f, 'review_log/L_b'), { companyId: 'co-b', leadId: 'L_b', reviewSeen: true, platform: 'google', rating: 5, responded: false, updatedAt: new Date('2026-10-01'), updatedBy: 'co-b' });
    await setDoc(doc(f, 'leads/L_done'), base);
    await setDoc(doc(f, 'leads/L_x'), base);                                      // a co-a lead whose log (below) is filed under co-b
    await setDoc(doc(f, 'review_log/L_x'), { companyId: 'co-b', leadId: 'L_x', reviewSeen: true, platform: 'google', rating: 5, responded: false, updatedAt: new Date('2026-10-01'), updatedBy: 'co-b' });
    await setDoc(doc(f, 'leads/L_b'), Object.assign({}, base, { companyId: 'co-b', userId: 'co-b' }));
  });

  // positive controls: the same writers CAN work on leads
  await check('control: manager can edit a lead', 'allow', updateDoc(doc(mike, 'leads/L1'), { notes: 'a' }));
  await check('control: rep can edit their own lead', 'allow', updateDoc(doc(rep, 'leads/L_rep'), { notes: 'b' }));
  await check('control: solo owner can edit a lead', 'allow', updateDoc(doc(solo, 'leads/L1'), { notes: 'c' }));

  // who may write
  await check('solo owner CAN log a review', 'allow', setDoc(log(solo, 'L2'), entry('co-a', 'L2')));
  await check('company_admin of that company CAN log a review', 'allow', setDoc(log(carol, 'L3'), entry('carol', 'L3', { platform: 'yelp', rating: 5 })));
  await check('platform admin CAN log a review for a company lead', 'allow', setDoc(log(joe, 'L4'), entry('joe', 'L4', { platform: 'thumbtack', rating: 3 })));
  await check('manager CANNOT log a review', 'deny', setDoc(log(mike, 'L5'), entry('mike', 'L5')));
  await check('sales rep CANNOT log a review', 'deny', setDoc(log(rep, 'L5'), entry('rep1', 'L5')));
  await check('viewer CANNOT log a review', 'deny', setDoc(log(vera, 'L5'), entry('vera', 'L5')));
  await check("another tenant's company_admin CANNOT log a review for this company", 'deny', setDoc(log(eve, 'L5'), entry('eve', 'L5')));
  await check("another tenant's solo owner CANNOT log a review for this company", 'deny', setDoc(log(bob, 'L5'), entry('co-b', 'L5')));
  await check('anonymous CANNOT log a review', 'deny', setDoc(log(anon, 'L5'), entry('x', 'L5')));
  await check("owner CANNOT log against another company's lead", 'deny', setDoc(log(solo, 'L_other'), entry('co-a', 'L_other')));
  await check("owner CANNOT claim another company's id on the doc", 'deny', setDoc(log(solo, 'L6'), entry('co-a', 'L6', { companyId: 'co-b' })));
  await check('owner CANNOT log a lead that does not exist', 'deny', setDoc(log(solo, 'NOPE'), entry('co-a', 'NOPE')));
  await check('owner CANNOT point the doc at a different leadId', 'deny', setDoc(log(solo, 'L6'), entry('co-a', 'L7')));

  // shape
  await check('owner CAN log every platform', 'allow', Promise.all(['google', 'yelp', 'thumbtack', 'other'].map((p, i) => setDoc(log(solo, 'L' + (8 + i)), entry('co-a', 'L' + (8 + i), { platform: p })))));
  await check('owner CAN log every star count', 'allow', Promise.all([1, 2, 3, 4, 5].map((n, i) => setDoc(log(solo, 'L' + (12 + i)), entry('co-a', 'L' + (12 + i), { rating: n })))));
  await check('owner CANNOT use a platform outside the list', 'deny', setDoc(log(solo, 'L17'), entry('co-a', 'L17', { platform: 'facebook' })));
  await check('owner CANNOT use a rating of 0', 'deny', setDoc(log(solo, 'L17'), entry('co-a', 'L17', { rating: 0 })));
  await check('owner CANNOT use a rating of 6', 'deny', setDoc(log(solo, 'L17'), entry('co-a', 'L17', { rating: 6 })));
  await check('owner CANNOT use a half star', 'deny', setDoc(log(solo, 'L17'), entry('co-a', 'L17', { rating: 4.5 })));
  await check('owner CANNOT use a text rating', 'deny', setDoc(log(solo, 'L17'), entry('co-a', 'L17', { rating: '5' })));
  await check('owner CANNOT log "seen" without a platform and rating', 'deny', setDoc(log(solo, 'L18'), entry('co-a', 'L18', { platform: null, rating: null })));
  await check('owner CANNOT add a key (no review text, no reviewer name)', 'deny', setDoc(log(solo, 'L18'), entry('co-a', 'L18', { reviewText: 'x' })));
  const noResp = entry('co-a', 'L18'); delete noResp.responded;
  await check('owner CANNOT leave a key out (no responded)', 'deny', setDoc(log(solo, 'L18'), noResp));
  await check('owner CANNOT credit the log to someone else', 'deny', setDoc(log(solo, 'L19'), entry('carol', 'L19')));
  await check('owner CANNOT backdate updatedAt', 'deny', setDoc(log(solo, 'L19'), entry('co-a', 'L19', { updatedAt: new Date('2020-01-01') })));
  await check('owner CANNOT write a non-boolean responded', 'deny', setDoc(log(solo, 'L19'), entry('co-a', 'L19', { responded: 'yes' })));
  await check('owner CANNOT write "not seen" that still carries a rating', 'deny', setDoc(log(solo, 'L20'), entry('co-a', 'L20', { reviewSeen: false, platform: null, rating: 3, responded: false })));
  await check('owner CANNOT mark replied on a review that is not seen', 'deny', setDoc(log(solo, 'L20'), entry('co-a', 'L20', { reviewSeen: false, platform: null, rating: null, responded: true })));

  // update / undo / delete
  await check('owner CAN mark replied', 'allow', setDoc(log(solo, 'L_done'), entry('co-a', 'L_done', { platform: 'yelp', rating: 1, responded: true })));
  await check('owner CAN undo a log (not seen, nulls, stamped)', 'allow', setDoc(log(solo, 'L_done'), entry('co-a', 'L_done', { reviewSeen: false, platform: null, rating: null, responded: false })));
  await check('company_admin of that company CAN update an existing log', 'allow', setDoc(log(carol, 'L_done'), entry('carol', 'L_done', { platform: 'google', rating: 4 })));
  await check("another tenant's company_admin CANNOT update this company's existing log", 'deny', setDoc(log(eve, 'L_done'), entry('eve', 'L_done', { platform: 'google', rating: 5 })));
  await check("another tenant's solo owner CANNOT update this company's existing log", 'deny', setDoc(log(bob, 'L_done'), entry('co-b', 'L_done', { platform: 'google', rating: 5 })));
  await check("another tenant's company_admin CANNOT create a log for this company's lead under their own companyId", 'deny', setDoc(log(eve, 'L23'), entry('eve', 'L23', { companyId: 'co-b' })));
  await check('control: the other tenant solo owner CAN update their own log', 'allow', setDoc(log(bob, 'L_b'), entry('co-b', 'L_b', { companyId: 'co-b', rating: 4 })));
  await check('isolates the companyId-unchanged clause: the lead IS co-a, the caller owns the co-b doc, only the company change is wrong', 'deny', setDoc(log(bob, 'L_x'), entry('co-b', 'L_x', { companyId: 'co-a' })));
  await check('a solo owner CANNOT hand their own log to another company (ownership transfer)', 'deny', setDoc(log(bob, 'L_b'), entry('co-b', 'L_b', { companyId: 'co-a' })));
  await check('manager CANNOT change an existing log', 'deny', setDoc(log(mike, 'L_done'), entry('mike', 'L_done', { rating: 5 })));
  await check('owner CANNOT move an existing log to another company', 'deny', setDoc(log(solo, 'L_b'), entry('co-a', 'L_b')));
  await check('owner CANNOT delete a log', 'deny', deleteDoc(log(solo, 'L_done')));
  await check('platform admin CANNOT delete a log either', 'deny', deleteDoc(log(joe, 'L_done')));

  // read
  const mine = (db) => getDocs(query(collection(db, 'review_log'), where('companyId', '==', 'co-a')));
  await check('solo owner CAN read the company log', 'allow', mine(solo));
  await check('company_admin CAN read the company log', 'allow', mine(carol));
  await check('manager CANNOT read the log', 'deny', mine(mike));
  await check('sales rep CANNOT read the log', 'deny', mine(rep));
  await check('viewer CANNOT read the log', 'deny', mine(vera));
  await check("another tenant's admin CANNOT read this company's log", 'deny', mine(eve));
  await check('anonymous CANNOT read the log', 'deny', mine(anon));
  await check('a customer-side reader (no auth) CANNOT read one doc', 'deny', getDoc(log(anon, 'L_done')));
  await check("owner CANNOT read another company's doc", 'deny', getDoc(log(solo, 'L_b')));

  // the lead rule is untouched: a plain lead edit with every field a manager normally sends still works
  await check('control: a lead carrying a (plain) extra field is still saved by a manager exactly as before', 'allow', updateDoc(doc(mike, 'leads/L21'), { notes: 'd', reviewRequested: true }));

  // the denied writes changed nothing
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    const s = await getDoc(doc(f, 'review_log/L5'));
    results.push({ label: 'L5 (every write denied) has no log', ok: !s.exists(), note: JSON.stringify(s.data()) });
    const d = await getDoc(doc(f, 'review_log/L17'));
    results.push({ label: 'L17 (every shape violation denied) has no log', ok: !d.exists(), note: JSON.stringify(d.data()) });
    const o = await getDoc(doc(f, 'review_log/L_other'));
    results.push({ label: "the other company's lead has no log from this owner", ok: !o.exists(), note: JSON.stringify(o.data()) });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nreview_log rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
