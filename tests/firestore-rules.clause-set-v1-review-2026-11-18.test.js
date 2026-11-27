/**
 * Firestore rules, clause set v1 review (2026-11-18):
 *  - companyProfile/{id}.paymentTerms (item 3): an in-range write is allowed; negative, NaN, string, boolean,
 *    array, out-of-range and unknown-key writes are denied (owner of a solo tenant, create and update).
 *  - deal_accept_tokens (item 8): the rep (or anyone) cannot read, create or update a token, so the clause
 *    block (clauseSetV1) the token carries cannot be rewritten from a client.
 * Every deny is paired with an allow, so a rule that denies everything cannot pass.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-clausev1-test \
 *     'node firestore-rules.clause-set-v1-review-2026-11-18.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-clausev1-test';
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

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '').split(':')[1]) || 8080 },
  });
  const { setDoc, doc, updateDoc, getDoc, deleteDoc } = require('firebase/firestore');
  const owner = env.authenticatedContext('owner1', {}).firestore();
  const other = env.authenticatedContext('stranger', {}).firestore();

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'companyProfile/owner1'), { brand: { legalName: 'Oak Roofing LLC' }, paymentTerms: { lateGraceDays: 15 } });
    await setDoc(doc(db, 'deal_accept_tokens/tok1'), { dealId: 'D1', ownerUid: 'owner1', clauseSetV1: { version: 'CS-X', refs: ['PAY-4_V1'], html: '<div>x</div>' }, status: 'pending' });
  });

  const cp = () => doc(owner, 'companyProfile/owner1');
  const pt = (o) => updateDoc(cp(), { paymentTerms: o });
  const OK = { lateGraceDays: 21, lateInterestPct: 8, disputeDays: 10, finalPaymentDays: 7, punchListDays: 3, pauseNoticeDays: 5, restockPct: 15, cardFeePct: 0, deckingPerSheetCents: 12550, deckingSheetsBeforeChangeOrder: 10, atticFreeCheckDays: 3, claimNoticeDays: 30 };

  await check('control: an in-range paymentTerms write is allowed', 'allow', pt(OK));
  await check('control: a fractional percent and a null (unset) field are allowed', 'allow', pt({ lateInterestPct: 7.5, deckingPerSheetCents: null }));
  await check('control: a profile write with no paymentTerms is allowed', 'allow', updateDoc(cp(), { tagline: 'x' }));
  await check('control: a single dotted field in range is allowed', 'allow', updateDoc(cp(), { 'paymentTerms.disputeDays': 12 }));
  await check('control: create of a new profile with in-range terms is allowed', 'allow', setDoc(doc(env.authenticatedContext('owner2', {}).firestore(), 'companyProfile/owner2'), { paymentTerms: OK }));

  await check('negative number denied', 'deny', pt({ disputeDays: -1 }));
  await check('NaN denied', 'deny', pt({ lateInterestPct: NaN }));
  await check('string " " denied', 'deny', pt({ disputeDays: ' ' }));
  await check('string "0x10" denied', 'deny', pt({ disputeDays: '0x10' }));
  await check('string "1e3" denied', 'deny', pt({ lateInterestPct: '1e3' }));
  await check('string "15" denied', 'deny', pt({ lateGraceDays: '15' }));
  await check('boolean denied', 'deny', pt({ lateGraceDays: true }));
  await check('array denied', 'deny', pt({ lateGraceDays: [15] }));
  await check('1e9 denied', 'deny', pt({ deckingPerSheetCents: 1e9 }));
  await check('interest over 100 denied', 'deny', pt({ lateInterestPct: 100.5 }));
  await check('card fee over 10 denied', 'deny', pt({ cardFeePct: 11 }));
  await check('days over 365 denied', 'deny', pt({ claimNoticeDays: 366 }));
  await check('fractional days denied', 'deny', pt({ claimNoticeDays: 1.5 }));
  await check('decking sheets 0 denied', 'deny', pt({ deckingSheetsBeforeChangeOrder: 0 }));
  await check('decking sheets 201 denied', 'deny', pt({ deckingSheetsBeforeChangeOrder: 201 }));
  await check('decking cents over 100000 denied', 'deny', pt({ deckingPerSheetCents: 100001 }));
  await check('unknown key denied', 'deny', pt({ lateGraceDays: 15, surprise: 1 }));
  await check('atticFreeCheckDays 0 denied (the form would print "at least 0 days"; review 2026-11-18 item 7)', 'deny', pt({ atticFreeCheckDays: 0 }));
  await check('control: atticFreeCheckDays 1 allowed', 'allow', pt({ atticFreeCheckDays: 1 }));
  await check('paymentTerms as a string denied', 'deny', updateDoc(cp(), { paymentTerms: 'free' }));
  await check('a dotted out-of-range field denied', 'deny', updateDoc(cp(), { 'paymentTerms.restockPct': 500 }));
  await check('create with an out-of-range term denied', 'deny', setDoc(doc(env.authenticatedContext('owner3', {}).firestore(), 'companyProfile/owner3'), { paymentTerms: { restockPct: 500 } }));

  // item 8: the token (and the clause block it carries) is never client-writable.
  const tok = doc(owner, 'deal_accept_tokens/tok1');
  await check('rep cannot read the deal token', 'deny', getDoc(tok));
  await check('rep cannot rewrite the token clauseSetV1', 'deny', updateDoc(tok, { clauseSetV1: { version: 'CS-FORGED', refs: ['PAY-4_V1'], html: '<div>forged</div>' } }));
  await check('rep cannot change one nested clauseSetV1 field', 'deny', updateDoc(tok, { 'clauseSetV1.html': '<div>forged</div>' }));
  await check('rep cannot create a token', 'deny', setDoc(doc(owner, 'deal_accept_tokens/tok2'), { dealId: 'D1', ownerUid: 'owner1', clauseSetV1: { refs: [] } }));
  await check('rep cannot delete the token', 'deny', deleteDoc(tok));
  await check('a stranger cannot update the token either', 'deny', updateDoc(doc(other, 'deal_accept_tokens/tok1'), { clauseSetV1: null }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' — ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
