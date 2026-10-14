/**
 * Firestore rules — stage-triggered "Docs to review" drafts (2026-10-13).
 *
 *   leads/{leadId}/doc_drafts/{draftId}
 *   functions/doc-drafts.js writes them (admin SDK); the browser reviews.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-ddrafts-test \
 *     'node firestore-rules.doc-drafts.test.js'
 *
 * Every deny about SHAPE is paired with an allow of the same write minus the
 * one defect (a positive control), so a rule that denies everything cannot
 * pass. RULES_PATH points a break-test at a mutated copy of the rules.
 *
 * 2026-10-13 (send bound to the draft): the browser can no longer say a draft
 * was sent. The server (admin SDK) writes 'sending' / 'sent' / sentAt /
 * messageId / the claim fields; a client may only edit subject+body, dismiss,
 * mark 'copied', and clear a server claim that is unconfirmed or stale.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-ddrafts-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) {
    throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
  }
}

// emulators:exec exports FIRESTORE_EMULATOR_HOST; fall back to the default.
const [EMU_HOST, EMU_PORT_S] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const EMU_PORT = parseInt(EMU_PORT_S, 10) || 8080;

const results = [];
async function check(label, expect, promise) {
  try {
    if (expect === 'deny') await assertFails(promise); else await assertSucceeds(promise);
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, note: expect === 'deny' ? 'WAS ALLOWED' : 'was denied: ' + String((e && e.message) || e).slice(0, 120) });
  }
}

function draft(over) {
  return Object.assign({
    status: 'draft', kind: 'paid_receipt', label: 'Paid-in-full receipt', emailKind: 'receipt', event: 'paid_in_full',
    channel: 'email', to: 'homeowner@example.test', subject: 'Paid in full', body: 'Hi,\n\nThanks.',
    leadId: 'lead-a', jobId: 'job1', companyId: 'co-a', userId: 'co-a',
  }, over || {});
}

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: EMU_HOST, port: EMU_PORT },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const owner = ctx('co-a', {});
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, doc, getDoc, getDocs, collection, deleteDoc } = require('firebase/firestore');
  const ref = (db, id, lead) => doc(db, 'leads/' + (lead || 'lead-a') + '/doc_drafts/' + (id || 'ddraft_lead-a_paid_receipt_job1'));
  const ids = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11', 'd12'];

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'leads/lead-a'), { userId: 'co-a', companyId: 'co-a', name: 'Sam Homeowner', stage: 'final_payment' });
    // A lead owned by a sales_rep inside co-a.
    await setDoc(doc(db, 'leads/lead-alice'), { userId: 'alice', companyId: 'co-a', name: 'Rep Lead', stage: 'final_payment' });
    await setDoc(ref(db), draft());
    await setDoc(ref(db, 'sentdraft'), draft({ status: 'sent' }));
    // server-claimed drafts: in flight (fresh), unconfirmed, stale (10 min old)
    const ago = (ms) => new Date(Date.now() - ms);
    await setDoc(ref(db, 'sendFresh'), draft({ status: 'sending', sendState: 'in_flight', sendNonce: 'n1', sendingAt: ago(10 * 1000), sendingBy: 'co-a' }));
    await setDoc(ref(db, 'sendFresh2'), draft({ status: 'sending', sendState: 'in_flight', sendNonce: 'n1', sendingAt: ago(10 * 1000), sendingBy: 'co-a' }));
    await setDoc(ref(db, 'sendCheck'), draft({ status: 'sending', sendState: 'check_provider', sendNonce: 'n2', sendingAt: ago(10 * 1000), sendingBy: 'co-a' }));
    await setDoc(ref(db, 'sendCheck2'), draft({ status: 'sending', sendState: 'check_provider', sendNonce: 'n2', sendingAt: ago(10 * 1000), sendingBy: 'co-a' }));
    await setDoc(ref(db, 'sendCheck3'), draft({ status: 'sending', sendState: 'check_provider', sendNonce: 'n2', sendingAt: ago(10 * 1000), sendingBy: 'co-a' }));
    await setDoc(ref(db, 'sendStale'), draft({ status: 'sending', sendState: 'in_flight', sendNonce: 'n3', sendingAt: ago(10 * 60 * 1000), sendingBy: 'co-a' }));
    await setDoc(ref(db, 'copiedDraft'), draft({ status: 'copied' }));
    await setDoc(ref(db, 'alicedraft', 'lead-alice'), draft({ leadId: 'lead-alice', userId: 'alice' }));
    for (const id of ids) await setDoc(ref(db, id), draft());
    for (const id of ['f1', 'f2', 'big', 'junk']) await setDoc(ref(db, id), draft({ status: id.startsWith('f') ? 'failed' : 'draft', kind: 'failed' }));
  });

  // -- reads
  await check('solo owner reads a draft', 'allow', getDoc(ref(owner)));
  await check('company_admin reads', 'allow', getDoc(ref(carol)));
  await check('manager reads', 'allow', getDoc(ref(eve)));
  await check('platform admin reads', 'allow', getDoc(ref(joe)));
  await check('owner lists the queue', 'allow', getDocs(collection(owner, 'leads/lead-a/doc_drafts')));
  await check('rep reads the queue of a lead they OWN', 'allow', getDoc(ref(alice, 'alicedraft', 'lead-alice')));
  await check('viewer does NOT read', 'deny', getDoc(ref(vic)));
  await check('viewer does NOT list', 'deny', getDocs(collection(vic, 'leads/lead-a/doc_drafts')));
  await check('sales_rep does NOT read a lead they do not own', 'deny', getDoc(ref(alice)));
  await check('other tenant company_admin does NOT read', 'deny', getDoc(ref(bobCA)));
  await check('anonymous does NOT read', 'deny', getDoc(ref(anon)));

  // -- updates: who
  await check('owner edits the body', 'allow', updateDoc(ref(owner, 'd1'), { body: 'Hi Sam,\n\nEdited.' }));
  await check('manager edits the subject', 'allow', updateDoc(ref(eve, 'd2'), { subject: 'New subject' }));
  await check('company_admin marks copied (+copiedAt)', 'allow', updateDoc(ref(carol, 'd3'), { status: 'copied', copiedAt: new Date() }));
  await check('owner dismisses (+dismissedAt)', 'allow', updateDoc(ref(owner, 'd4'), { status: 'dismissed', dismissedAt: new Date() }));
  await check('viewer CANNOT edit', 'deny', updateDoc(ref(vic, 'd5'), { body: 'x' }));
  await check('sales_rep CANNOT edit a lead they do not own', 'deny', updateDoc(ref(alice, 'd5'), { body: 'x' }));
  await check('other tenant company_admin CANNOT edit', 'deny', updateDoc(ref(bobCA, 'd5'), { body: 'x' }));
  await check('anonymous CANNOT edit', 'deny', updateDoc(ref(anon, 'd5'), { body: 'x' }));

  // -- updates: shape (each deny has its allow above or here as the control)
  await check('control: body-only edit allowed', 'allow', updateDoc(ref(owner, 'd5'), { body: 'fine' }));
  await check('CANNOT change the recipient (to)', 'deny', updateDoc(ref(owner, 'd6'), { to: 'attacker@example.test' }));
  await check('CANNOT change the email kind (transactional -> commercial, or back)', 'deny', updateDoc(ref(owner, 'd6'), { emailKind: '' }));
  await check('CANNOT change kind / leadId / companyId / userId', 'deny', updateDoc(ref(owner, 'd6'), { companyId: 'co-b' }));
  await check('CANNOT set an unknown status', 'deny', updateDoc(ref(owner, 'd6'), { status: 'approved' }));
  await check('CANNOT add a stray field with a valid edit', 'deny', updateDoc(ref(owner, 'd6'), { body: 'ok', extra: 1 }));
  await check('control: valid status change allowed', 'allow', updateDoc(ref(owner, 'd6'), { status: 'copied', copiedAt: new Date() }));
  await check('a SENT draft is final (cannot be edited)', 'deny', updateDoc(ref(owner, 'sentdraft'), { body: 'rewrite history' }));
  await check('a dismissed draft is final (cannot be revived)', 'deny', updateDoc(ref(owner, 'd4'), { status: 'draft' }));
  await check('a COPIED draft is final (cannot be edited)', 'deny', updateDoc(ref(owner, 'copiedDraft'), { body: 'rewrite' }));
  await check('a copied draft cannot be revived', 'deny', updateDoc(ref(owner, 'copiedDraft'), { status: 'draft' }));

  // -- send bound to the draft: the browser can never claim a send
  await check('owner CANNOT set status "sent" (server-only)', 'deny', updateDoc(ref(owner, 'd9'), { status: 'sent', sentAt: new Date() }));
  await check('owner CANNOT set status "sent" without sentAt either', 'deny', updateDoc(ref(owner, 'd9'), { status: 'sent' }));
  await check('owner CANNOT set status "sending" (server-only claim)', 'deny', updateDoc(ref(owner, 'd9'), { status: 'sending' }));
  await check('owner CANNOT write sentAt on a draft', 'deny', updateDoc(ref(owner, 'd9'), { sentAt: new Date() }));
  await check('owner CANNOT write messageId / sendNonce / sendState', 'deny', updateDoc(ref(owner, 'd9'), { messageId: 'x' }));
  await check('owner CANNOT forge a claim nonce', 'deny', updateDoc(ref(owner, 'd9'), { sendNonce: 'x' }));
  await check('control: the same draft takes a normal edit', 'allow', updateDoc(ref(owner, 'd9'), { body: 'normal edit' }));
  await check('control: and a copied mark (the manual path stays)', 'allow', updateDoc(ref(owner, 'd10'), { status: 'copied', copiedAt: new Date() }));
  await check('a viewer CANNOT mark copied', 'deny', updateDoc(ref(vic, 'd11'), { status: 'copied', copiedAt: new Date() }));
  await check('a CLAIMED draft (sending, in flight) cannot be edited', 'deny', updateDoc(ref(owner, 'sendFresh'), { body: 'sneaky' }));
  await check('a claimed draft in flight cannot be dismissed (a send is running)', 'deny', updateDoc(ref(owner, 'sendFresh'), { status: 'dismissed', dismissedAt: new Date() }));
  await check('a claimed draft in flight cannot be marked copied', 'deny', updateDoc(ref(owner, 'sendFresh2'), { status: 'copied', copiedAt: new Date() }));
  await check('control: an UNCONFIRMED claim (check_provider) can be marked copied', 'allow', updateDoc(ref(owner, 'sendCheck'), { status: 'copied', copiedAt: new Date() }));
  await check('control: an unconfirmed claim can be dismissed', 'allow', updateDoc(ref(owner, 'sendCheck2'), { status: 'dismissed', dismissedAt: new Date() }));
  await check('an unconfirmed claim can NEVER go back to draft (no silent retry)', 'deny', updateDoc(ref(owner, 'sendCheck3'), { status: 'draft' }));
  await check('control: a STALE claim (10 min, no answer) can be dismissed', 'allow', updateDoc(ref(owner, 'sendStale'), { status: 'dismissed', dismissedAt: new Date() }));
  await check('a failed marker cannot be revived to draft', 'deny', updateDoc(ref(owner, 'f2'), { status: 'draft' }));

  // -- failure markers + value validation (review round 1)
  await check('owner dismisses a failed-draft marker', 'allow', updateDoc(ref(owner, 'f1'), { status: 'dismissed', dismissedAt: new Date() }));
  await check('viewer CANNOT dismiss a failed marker', 'deny', updateDoc(ref(vic, 'f2'), { status: 'dismissed' }));
  await check('CANNOT write a 20 KB body', 'deny', updateDoc(ref(owner, 'big'), { body: 'x'.repeat(20000) }));
  await check('control: a normal body on the same doc', 'allow', updateDoc(ref(owner, 'big'), { body: 'x'.repeat(200) }));
  await check('CANNOT mark copied with a junk copiedAt', 'deny', updateDoc(ref(owner, 'junk'), { status: 'copied', copiedAt: 'junk' }));
  await check('control: the same status change with a real timestamp', 'allow', updateDoc(ref(owner, 'junk'), { status: 'copied', copiedAt: new Date() }));
  await check('CANNOT set a non-string subject', 'deny', updateDoc(ref(owner, 'd8'), { subject: 42 }));
  await check('other tenant MANAGER cannot edit a co-a draft', 'deny', updateDoc(ref(ctx('mgrb', { role: 'manager', companyId: 'co-b' }), 'd8'), { body: 'x' }));

  // -- create / delete: never from a client
  await check('owner CANNOT create a draft', 'deny', setDoc(ref(owner, 'forged1'), draft()));
  await check('company_admin CANNOT create a draft', 'deny', setDoc(ref(carol, 'forged2'), draft()));
  await check('platform admin CANNOT create a draft', 'deny', setDoc(ref(joe, 'forged3'), draft()));
  await check('owner CANNOT delete a draft', 'deny', deleteDoc(ref(owner, 'd7')));
  await check('company_admin CANNOT delete a draft', 'deny', deleteDoc(ref(carol, 'd7')));

  await env.cleanup();
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log('  ✓ ' + r.label);
    else { failed++; console.log('  ✗ ' + r.label + ' — ' + r.note); }
  }
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
