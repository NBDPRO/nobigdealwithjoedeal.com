/**
 * Firestore rules - receipt_inbox/{companyId__rcpt_<hash>} (2026-11-04, flag receiptInbox).
 *
 * A DRAFT read from an uploaded receipt, waiting for the uploader to approve it one row at a
 * time. The server (admin SDK) creates and rewrites it; a browser can only DECIDE:
 * ready/needs_look -> approved|skipped|not_business (an approval must name a real expenses row of
 * the caller carrying this draft's inboxId), skipped/not_business -> ready (undo, only when the
 * draft has a read). Read: the uploader (not a viewer) or a platform admin. SYNTHETIC ids and
 * numbers only (public repo).
 *
 * Also re-tests the existing credit rule with an inbox-created credit: relatedExpenseId pointing
 * at another company's cost is refused.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-rcptinbox-test \
 *     'node firestore-rules.receipt-inbox.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-rcptinbox-test';
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
  const rep = ctx('rep1', { role: 'sales_rep', companyId: 'co-a' });             // a member who uploads her own receipt
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });      // another member of co-a
  const vera = ctx('vera', { role: 'viewer', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'company_admin', companyId: 'co-b' });          // another tenant
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, collection, query, where, serverTimestamp } = require('firebase/firestore');
  const ref = (db, id) => doc(db, 'receipt_inbox/' + id);

  const read = () => ({ documentType: 'invoice', vendor: 'Acme Roof Supply', date: '2026-05-29', totalCents: 132098, taxCents: 8642, isCredit: false, confidence: 0.9 });
  const draft = (uid, over) => Object.assign({ companyId: uid === 'rep1' ? 'co-a' : uid, ownerUid: uid, source: 'upload', storagePath: 'receipts/' + uid + '/inbox/1_a.jpg', fileHash: 'a'.repeat(64), mime: 'image/jpeg', status: 'ready', read: read(), warnings: [], suggestedPaidFrom: '', costUsd: 0.004 }, over || {});
  const seed = (id, data) => env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'receipt_inbox/' + id), data); });
  const seedExp = (id, data) => env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'expenses/' + id), data); });

  // drafts and expenses written with rules off (the server's writes)
  await seed('co-a__rcpt_one', draft('co-a'));
  await seed('co-a__rcpt_two', draft('co-a', { fileHash: 'b'.repeat(64) }));
  await seed('co-a__rcpt_three', draft('co-a', { fileHash: 'c'.repeat(64), status: 'needs_look' }));
  await seed('co-a__rcpt_four', draft('co-a', { fileHash: 'd'.repeat(64) }));
  await seed('co-a__rcpt_five', draft('co-a', { fileHash: 'e'.repeat(64) }));
  await seed('co-a__rcpt_six', draft('co-a', { fileHash: 'f'.repeat(64) }));
  await seed('co-a__rcpt_skipped', draft('co-a', { fileHash: '1'.repeat(64), status: 'skipped' }));
  await seed('co-a__rcpt_personal', draft('co-a', { fileHash: '2'.repeat(64), status: 'not_business', read: null, storagePath: null }));
  await seed('co-a__rcpt_approved', draft('co-a', { fileHash: '3'.repeat(64), status: 'approved' }));
  await seed('co-a__rcpt_reps', draft('rep1', { fileHash: '4'.repeat(64) }));
  await seed('co-b__rcpt_theirs', draft('co-b', { fileHash: '5'.repeat(64) }));
  await seed('co-a__rcpt_viewers', draft('vera', { companyId: 'co-a', fileHash: '6'.repeat(64) }));
  await seed('co-a__rcpt_ten', draft('co-a', { fileHash: '7'.repeat(64) }));
  await seed('co-a__rcpt_seven', draft('co-a', { fileHash: '9'.repeat(64) }));
  const exp = (uid, inboxId, over) => Object.assign({ userId: uid, companyId: uid === 'rep1' ? 'co-a' : uid, createdBy: uid, amountCents: 123456, taxCents: 8642, supplier: 'Acme Roof Supply', category: 'materials', costType: 'direct', source: 'inbox', inboxId, externalRef: 'rcpt_x' }, over || {});
  await seedExp('e-one', exp('co-a', 'co-a__rcpt_one'));
  await seedExp('e-other-draft', exp('co-a', 'co-a__rcpt_zzz'));
  await seedExp('e-notmine', exp('someone-else', 'co-a__rcpt_two'));
  await seedExp('e-cob', exp('co-b', 'co-b__x', { companyId: 'co-b' }));
  await seedExp('e-coa-cost', exp('co-a', 'co-a__rcpt_cost'));
  await seedExp('e-seven', exp('co-a', 'co-a__rcpt_seven'));

  const now = () => serverTimestamp();
  const decide = (status, expenseId, uid, extra) => Object.assign({ status, decidedBy: uid, decidedAt: now(), decision: expenseId ? { expenseId, edited: false } : { note: 'skipped' } }, extra || {});

  // ── read ──
  await check('the uploader (solo owner) can read her own draft', 'allow', getDoc(ref(solo, 'co-a__rcpt_one')));
  await check('a member who uploaded it can read her own draft', 'allow', getDoc(ref(rep, 'co-a__rcpt_reps')));
  await check('a platform admin can read', 'allow', getDoc(ref(joe, 'co-a__rcpt_one')));
  await check('another member of the same company cannot read it (the picture is the uploader\'s alone)', 'deny', getDoc(ref(carol, 'co-a__rcpt_one')));
  await check('a company_admin cannot read a member\'s draft either', 'deny', getDoc(ref(carol, 'co-a__rcpt_reps')));
  await check('another tenant cannot read', 'deny', getDoc(ref(eve, 'co-a__rcpt_one')));
  await check('a viewer cannot read, even a draft stamped with her own uid', 'deny', getDoc(ref(vera, 'co-a__rcpt_viewers')));
  await check('anonymous cannot read', 'deny', getDoc(ref(anon, 'co-a__rcpt_one')));
  await check('the uploader can list her own drafts (a query constrained to ownerUid)', 'allow', getDocs(query(collection(solo, 'receipt_inbox'), where('ownerUid', '==', 'co-a'))));
  await check('a list that is not constrained to the caller is refused', 'deny', getDocs(query(collection(solo, 'receipt_inbox'), where('companyId', '==', 'co-a'))));

  // ── create / delete: server only ──
  await check('the owner cannot create a draft (a browser can never plant a read)', 'deny', setDoc(ref(solo, 'co-a__rcpt_new'), draft('co-a', { fileHash: '8'.repeat(64) })));
  await check('a member cannot create a draft', 'deny', setDoc(ref(rep, 'co-a__rcpt_new2'), draft('rep1')));
  await check('even a platform admin cannot create a draft from a browser', 'deny', setDoc(ref(joe, 'co-a__rcpt_new3'), draft('co-a')));
  await check('the owner cannot delete a draft', 'deny', deleteDoc(ref(solo, 'co-a__rcpt_one')));
  await check('a platform admin cannot delete a draft either', 'deny', deleteDoc(ref(joe, 'co-a__rcpt_one')));

  // ── update: approve ──
  await check('approve names a real expenses row of the caller that carries this draft\'s inboxId', 'allow', updateDoc(ref(solo, 'co-a__rcpt_one'), decide('approved', 'e-one', 'co-a')));
  await check('approve with no expense id is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_two'), decide('approved', '', 'co-a')));
  await check('approve naming an expense that does not exist is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_two'), decide('approved', 'e-nope', 'co-a')));
  await check('approve naming an expense that belongs to a DIFFERENT draft is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_two'), decide('approved', 'e-other-draft', 'co-a')));
  await check('approve naming an expense made by someone else is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_two'), decide('approved', 'e-notmine', 'co-a')));
  await check('approve naming another company\'s expense is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_two'), decide('approved', 'e-cob', 'co-a')));
  await check('approve without decidedBy = the caller is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_two'), Object.assign(decide('approved', 'e-one', 'co-a'), { decidedBy: 'someone-else' })));
  // the expense is the caller's and carries THIS draft's id, so only the decidedBy clause can refuse the next one
  await check('approve with decidedBy set to someone else is refused (everything else valid)', 'deny', updateDoc(ref(solo, 'co-a__rcpt_seven'), Object.assign(decide('approved', 'e-seven', 'co-a'), { decidedBy: 'someone-else' })));
  await check('approve with decidedBy missing is refused (everything else valid)', 'deny', updateDoc(ref(solo, 'co-a__rcpt_seven'), { status: 'approved', decidedAt: now(), decision: { expenseId: 'e-seven' } }));
  await check('the same approval with decidedBy = the caller is allowed', 'allow', updateDoc(ref(solo, 'co-a__rcpt_seven'), decide('approved', 'e-seven', 'co-a')));
  await check('approved is final: it cannot be skipped afterwards', 'deny', updateDoc(ref(solo, 'co-a__rcpt_approved'), decide('skipped', null, 'co-a')));
  await check('approved is final: it cannot be undone to ready', 'deny', updateDoc(ref(solo, 'co-a__rcpt_approved'), { status: 'ready' }));
  await check('a viewer cannot approve', 'deny', updateDoc(ref(vera, 'co-a__rcpt_viewers'), decide('skipped', null, 'vera')));
  await check('another member cannot decide a draft that is not theirs', 'deny', updateDoc(ref(carol, 'co-a__rcpt_three'), decide('skipped', null, 'carol')));
  await check('another tenant cannot decide', 'deny', updateDoc(ref(eve, 'co-a__rcpt_three'), decide('skipped', null, 'eve')));
  await check('a platform admin cannot decide on the owner\'s behalf', 'deny', updateDoc(ref(joe, 'co-a__rcpt_three'), decide('skipped', null, 'joe')));
  await check('a member can decide her own draft (skip)', 'allow', updateDoc(ref(rep, 'co-a__rcpt_reps'), decide('skipped', null, 'rep1')));

  // ── update: skip / not business / undo ──
  await check('skip', 'allow', updateDoc(ref(solo, 'co-a__rcpt_two'), decide('skipped', null, 'co-a')));
  await check('not a business receipt (and the file was deleted by the client)', 'allow', updateDoc(ref(solo, 'co-a__rcpt_three'), decide('not_business', null, 'co-a', { fileDeleted: true })));
  await check('undo a skip back to ready (it has a read)', 'allow', updateDoc(ref(solo, 'co-a__rcpt_skipped'), { status: 'ready' }));
  await check('undo to needs_look is also allowed', 'allow', updateDoc(ref(solo, 'co-a__rcpt_two'), { status: 'needs_look' }));
  await check('undo on a dropped personal draft (no read) is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_personal'), { status: 'ready' }));

  // ── update: the server's facts are frozen ──
  await check('the amounts the server read cannot be edited', 'deny', updateDoc(ref(solo, 'co-a__rcpt_four'), Object.assign(decide('skipped', null, 'co-a'), { read: { totalCents: 1 } })));
  await check('the storage path cannot be re-pointed', 'deny', updateDoc(ref(solo, 'co-a__rcpt_four'), Object.assign(decide('skipped', null, 'co-a'), { storagePath: 'receipts/someone-else/inbox/x.jpg' })));
  await check('the owner cannot be changed', 'deny', updateDoc(ref(solo, 'co-a__rcpt_four'), Object.assign(decide('skipped', null, 'co-a'), { ownerUid: 'someone-else' })));
  await check('the company cannot be changed', 'deny', updateDoc(ref(solo, 'co-a__rcpt_four'), Object.assign(decide('skipped', null, 'co-a'), { companyId: 'co-b' })));
  await check('the file hash cannot be changed', 'deny', updateDoc(ref(solo, 'co-a__rcpt_four'), Object.assign(decide('skipped', null, 'co-a'), { fileHash: 'z'.repeat(64) })));
  await check('an unknown extra field cannot ride along', 'deny', updateDoc(ref(solo, 'co-a__rcpt_four'), Object.assign(decide('skipped', null, 'co-a'), { jobId: 'JOB-9' })));
  await check('a status the browser may not set (failed, reading, duplicate, a made-up word) is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_five'), decide('failed', null, 'co-a')));
  await check('"duplicate" is server only', 'deny', updateDoc(ref(solo, 'co-a__rcpt_five'), decide('duplicate', null, 'co-a')));
  await check('a no-op status change (ready -> ready) is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_five'), { status: 'ready' }));
  await check('a decision that is not a map is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_six'), { status: 'skipped', decidedBy: 'co-a', decidedAt: now(), decision: 'x' }));
  const bigDecision = {}; for (let i = 0; i < 21; i++) bigDecision['k' + i] = i;
  await check('a decision with more than 20 keys is refused', 'deny', updateDoc(ref(solo, 'co-a__rcpt_ten'), { status: 'skipped', decidedBy: 'co-a', decidedAt: now(), decision: bigDecision }));

  // ── the expense an approval creates (existing rules, re-tested with an inbox-created credit) ──
  const newExp = (db, id, over) => setDoc(doc(db, 'expenses/' + id), Object.assign({ userId: 'co-a', companyId: 'co-a', createdBy: 'co-a', amountCents: 95000, taxCents: 6784, supplier: 'Acme Roof Supply', category: 'materials', costType: 'direct', source: 'inbox', inboxId: 'co-a__rcpt_cr', externalRef: 'rcpt_cr', date: new Date('2026-06-10T00:00:00Z'), createdAt: serverTimestamp(), reviewState: 'assigned', entryType: 'credit', relatedExpenseId: 'e-coa-cost', creditRef: 'CM-77' }, over || {}));
  await check('an inbox-created credit pointing at the same company\'s cost is allowed', 'allow', newExp(solo, 'e-credit-ok'));
  await check('an inbox-created credit pointing at ANOTHER company\'s cost is refused', 'deny', newExp(solo, 'e-credit-bad', { relatedExpenseId: 'e-cob' }));
  await check('an inbox-created credit with a missing related cost is refused', 'deny', newExp(solo, 'e-credit-missing', { relatedExpenseId: 'e-does-not-exist' }));
  await check('an inbox-created credit with no related cost at all is allowed (the rule permits it)', 'allow', setDoc(doc(solo, 'expenses/e-credit-none'), { userId: 'co-a', companyId: 'co-a', createdBy: 'co-a', amountCents: 5000, taxCents: 0, supplier: 'Acme', category: 'materials', costType: 'direct', source: 'inbox', entryType: 'credit' }));
  await check('a viewer cannot create the expense an approval would make', 'deny', setDoc(doc(vera, 'expenses/e-viewer'), { userId: 'vera', companyId: 'co-a', createdBy: 'vera', amountCents: 5000, taxCents: 0, supplier: 'Acme', category: 'materials', costType: 'direct', source: 'inbox' }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' - ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
