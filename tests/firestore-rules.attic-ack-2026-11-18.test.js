/**
 * Firestore rules, attic acknowledgment (phase 3, 2026-11-18):
 *  - leads/{leadId}/documents.atticAckResult is server-owned (the gate and the warranty read it): no client creates a row
 *    with it, plants it, rewrites it or removes it;
 *  - attic_overrides is write:false for every client (the owner/admin "proceed anyway" event is written by recordAtticOverride
 *    only), readable by the company's own readers and the person who recorded it.
 * Every deny is paired with an allow, so a rule that denies everything cannot pass.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-atticack-test \
 *     'node firestore-rules.attic-ack-2026-11-18.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-atticack-test';
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
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':').pop()) },
  });
  const { setDoc, doc, updateDoc, getDoc, deleteField } = require('firebase/firestore');
  const owner = env.authenticatedContext('owner1', {}).firestore();
  const rep = env.authenticatedContext('rep1', { companyId: 'owner1', role: 'sales_rep' }).firestore();
  const admin = env.authenticatedContext('adm1', { companyId: 'owner1', role: 'company_admin' }).firestore();
  const stranger = env.authenticatedContext('x9', { companyId: 'other', role: 'company_admin' }).firestore();
  const RES = { version: 'ATTIC_ACK_V1', complete: true, declined: false, notInspected: false, acknowledgments: [] };

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'owner1', companyId: 'owner1' });
    await setDoc(doc(db, 'leads/LR'), { userId: 'owner1', companyId: 'owner1', scope: 'reroof' });
    await setDoc(doc(db, 'leads/LP'), { userId: 'owner1', companyId: 'owner1', scope: 'repair' });
    await setDoc(doc(db, 'leads/LR2'), { userId: 'owner1', companyId: 'owner1', scope: 'reroof' });
    await setDoc(doc(db, 'leads/L1/documents/draft'), { name: 'a', type: 'attic_acknowledgment', status: 'draft', userId: 'owner1' });
    await setDoc(doc(db, 'leads/L1/documents/signed'), { name: 'a', type: 'attic_acknowledgment', status: 'signed', signedAt: new Date(), userId: 'owner1', atticAckResult: RES });
    await setDoc(doc(db, 'attic_overrides/o1'), { leadId: 'L1', companyId: 'owner1', byUid: 'owner1', byName: 'Joe', reason: 'would not sign the page', at: 1 });
  });

  const d = (id) => doc(owner, 'leads/L1/documents/' + id);
  await check('control: owner creates an ordinary attic document row', 'allow', setDoc(doc(owner, 'leads/L1/documents/new1'), { name: 'x', type: 'attic_acknowledgment', status: 'draft', userId: 'owner1' }));
  await check('owner creates a row already carrying atticAckResult', 'deny', setDoc(doc(owner, 'leads/L1/documents/new2'), { name: 'x', type: 'attic_acknowledgment', status: 'signed', userId: 'owner1', atticAckResult: RES }));
  await check('control: owner edits an ordinary field on a draft', 'allow', updateDoc(d('draft'), { name: 'renamed' }));
  await check('owner plants atticAckResult on a draft', 'deny', updateDoc(d('draft'), { atticAckResult: RES }));
  await check('owner rewrites atticAckResult on a signed row', 'deny', updateDoc(d('signed'), { atticAckResult: Object.assign({}, RES, { declined: true }) }));
  await check('owner changes one nested atticAckResult field', 'deny', updateDoc(d('signed'), { 'atticAckResult.complete': false }));
  await check('owner removes atticAckResult from a signed row', 'deny', updateDoc(d('signed'), { atticAckResult: deleteField() }));
  // Review 3 (item 5): atticGateUnverified (the in-person gate could not read the flag) is server-written like evidenceRefused.
  await check('owner creates a row carrying atticGateUnverified', 'deny', setDoc(doc(owner, 'leads/L1/documents/new3'), { name: 'x', type: 'contract', status: 'draft', userId: 'owner1', atticGateUnverified: { at: 1 } }));
  await check('owner plants atticGateUnverified on a draft', 'deny', updateDoc(d('draft'), { atticGateUnverified: { at: 1 } }));
  // Review 4: the same for a rep (each deny sits beside an allow for the same actor, so a rule that denies everything cannot pass), and for
  // rewriting or removing a mark the server already wrote.
  const rd = (id) => doc(rep, 'leads/LREP/documents/' + id);
  await env.withSecurityRulesDisabled(async (ctx) => { const adb = ctx.firestore(); await setDoc(doc(adb, 'leads/LREP'), { userId: 'rep1', companyId: 'owner1' }); await setDoc(doc(adb, 'leads/LREP/documents/draft'), { name: 'a', type: 'contract', status: 'draft', userId: 'rep1' }); await setDoc(doc(adb, 'leads/LREP/documents/unv'), { name: 'a', type: 'contract', status: 'draft', userId: 'rep1', atticGateUnverified: { reason: 'attic_flag_unreadable', at: 1 } }); await setDoc(doc(ctx.firestore(), 'leads/L1/documents/unv'), { name: 'a', type: 'contract', status: 'signed', signedAt: new Date(), userId: 'owner1', atticGateUnverified: { reason: 'attic_flag_unreadable', at: 1 } }); });
  await check('control: a rep creates an ordinary contract row', 'allow', setDoc(doc(rep, 'leads/LREP/documents/repnew1'), { name: 'x', type: 'contract', status: 'draft', userId: 'rep1' }));
  await check('control: a rep edits an ordinary field on a draft', 'allow', updateDoc(rd('draft'), { name: 'rep renamed' }));
  await check('a rep creates a row carrying atticGateUnverified', 'deny', setDoc(doc(rep, 'leads/LREP/documents/repnew2'), { name: 'x', type: 'contract', status: 'draft', userId: 'rep1', atticGateUnverified: { at: 1 } }));
  await check('a rep plants atticGateUnverified on a draft', 'deny', updateDoc(rd('draft'), { atticGateUnverified: { at: 1 } }));
  await check('a rep rewrites an existing atticGateUnverified', 'deny', updateDoc(rd('unv'), { atticGateUnverified: { at: 2 } }));
  await check('the owner removes an existing atticGateUnverified', 'deny', updateDoc(d('unv'), { atticGateUnverified: deleteField() }));
  await check('a rep removes an existing atticGateUnverified', 'deny', updateDoc(rd('unv'), { atticGateUnverified: deleteField() }));

  const ov = (db, id) => doc(db, 'attic_overrides/' + id);
  await check('owner cannot create an override event (write:false)', 'deny', setDoc(ov(owner, 'forged'), { leadId: 'L1', companyId: 'owner1', byUid: 'owner1', reason: 'forged event', at: 2 }));
  await check('a rep cannot create an override event', 'deny', setDoc(ov(rep, 'forged2'), { leadId: 'L1', companyId: 'owner1', byUid: 'rep1', reason: 'forged event', at: 2 }));
  await check('nobody edits an override event', 'deny', updateDoc(ov(owner, 'o1'), { reason: 'rewritten reason here' }));
  await check('nobody deletes an override event', 'deny', require('firebase/firestore').deleteDoc(ov(owner, 'o1')));
  await check('control: the person who recorded it can read it', 'allow', getDoc(ov(owner, 'o1')));
  await check('control: the company_admin of the same company can read it', 'allow', getDoc(ov(admin, 'o1')));
  await check('a rep who did not record it cannot read it', 'deny', getDoc(ov(rep, 'o1')));
  await check('another company\'s admin cannot read it', 'deny', getDoc(ov(stranger, 'o1')));

  // Review 2026-11-18 (finding 1): a client can raise a lead's scope, never lower it, and never writes the server's floor.
  const ld = (db, id) => doc(db, 'leads/' + id);
  await check('control: the owner raises scope from none to reroof', 'allow', updateDoc(ld(owner, 'L1'), { scope: 'reroof' }));
  await check('control: the owner raises repair to reroof', 'allow', updateDoc(ld(owner, 'LP'), { scope: 'reroof' }));
  await check('control: re-saving the same scope on a reroof lead is fine', 'allow', updateDoc(ld(owner, 'LR2'), { scope: 'reroof', notes: 'x' }));
  await check('owner lowers reroof to repair', 'deny', updateDoc(ld(owner, 'LR'), { scope: 'repair' }));
  await check('owner lowers reroof to other', 'deny', updateDoc(ld(owner, 'LR'), { scope: 'other' }));
  await check('owner removes scope from a reroof lead', 'deny', updateDoc(ld(owner, 'LR'), { scope: deleteField() }));
  await check('a rep lowers reroof to siding', 'deny', updateDoc(ld(rep, 'LR'), { scope: 'siding' }));
  await check('a company_admin lowers reroof to repair', 'deny', updateDoc(ld(admin, 'LR'), { scope: 'repair' }));
  await check('owner lowers repair to other', 'deny', updateDoc(ld(owner, 'LP'), { scope: 'other' }));
  await check('control: an ordinary edit on a reroof lead is allowed', 'allow', updateDoc(ld(owner, 'LR'), { notes: 'ordinary edit' }));
  await check('owner plants atticScopeFloor (server-owned)', 'deny', updateDoc(ld(owner, 'L1'), { atticScopeFloor: 'reroof' }));
  await check('owner creates a lead already carrying atticScopeFloor', 'deny', setDoc(ld(owner, 'NEWF'), { userId: 'owner1', companyId: 'owner1', meter: 'manual', atticScopeFloor: 'reroof' }));
  await check('control: owner creates an ordinary lead', 'allow', setDoc(ld(owner, 'NEWOK'), { userId: 'owner1', companyId: 'owner1', meter: 'manual', scope: 'reroof' }));

  // Review 2 (2026-11-18), item 6: the lowering cases above used a lead the rep does not own, so they could be denied for the wrong reason.
  // Here the lead belongs to the rep (userId == rep1): the only thing standing in the way is the scope rule. Each deny has an allow beside it.
  const { FieldPath } = require('firebase/firestore');
  const rl = (id) => doc(rep, 'leads/' + id);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const repLead = (extra) => Object.assign({ userId: 'rep1', companyId: 'owner1' }, extra);
    for (const id of ['RP1', 'RP2', 'RP3', 'RP4', 'RP5', 'RP6', 'RP7']) await setDoc(doc(db, 'leads/' + id), repLead({ scope: 'reroof' }));
    await setDoc(doc(db, 'leads/RPUP'), repLead({ scope: 'repair' }));
    await setDoc(doc(db, 'leads/RPF'), repLead({ scope: 'reroof', atticScopeFloor: 'reroof' }));
    await setDoc(doc(db, 'leads/RPF2'), repLead({ scope: 'reroof', atticScopeFloor: 'reroof' }));
    await setDoc(doc(db, 'leads/RPF3'), repLead({ scope: 'reroof', atticScopeFloor: 'reroof' }));
    await setDoc(doc(db, 'leads/OWF'), { userId: 'owner1', companyId: 'owner1', scope: 'reroof', atticScopeFloor: 'reroof' });
  });
  await check('control: a rep edits an ordinary field on the lead they own (so a deny below is the scope rule)', 'allow', updateDoc(rl('RP1'), { notes: 'rep edit' }));
  await check('control: the rep raises the scope on their own lead (repair to reroof)', 'allow', updateDoc(rl('RPUP'), { scope: 'reroof' }));
  await check('a rep who OWNS the lead lowers reroof to repair', 'deny', updateDoc(rl('RP1'), { scope: 'repair' }));
  await check('a rep who owns the lead lowers reroof to other', 'deny', updateDoc(rl('RP2'), { scope: 'other' }));
  await check('a rep who owns the lead removes scope', 'deny', updateDoc(rl('RP3'), { scope: deleteField() }));
  await check('control: the rep re-saves the same scope with another change', 'allow', updateDoc(rl('RP4'), { scope: 'reroof', notes: 'x' }));
  // dotted-path and merge writes are the same field: they cannot get around the rule
  await check('a rep lowers scope with the field/value form of updateDoc', 'deny', updateDoc(rl('RP5'), 'scope', 'repair'));
  await check('a rep lowers scope with a FieldPath', 'deny', updateDoc(rl('RP5'), new FieldPath('scope'), 'repair'));
  await check('a rep lowers scope with a merge set', 'deny', setDoc(rl('RP6'), { scope: 'repair' }, { merge: true }));
  await check('a rep lowers scope with mergeFields', 'deny', setDoc(rl('RP6'), { scope: 'repair', notes: 'y' }, { mergeFields: ['scope'] }));
  await check('a rep lowers scope together with an allowed change in one write', 'deny', updateDoc(rl('RP7'), { notes: 'z', scope: 'siding' }));
  await check('a rep replaces the whole lead without a scope (a set that drops the field)', 'deny', setDoc(rl('RP7'), { userId: 'rep1', companyId: 'owner1', notes: 'replaced' }));
  await check('control: a merge set that raises or keeps scope is fine', 'allow', setDoc(rl('RP7'), { scope: 'reroof', notes: 'kept' }, { merge: true }));
  // the server's floor cannot be deleted, changed or dotted away
  await check('owner deletes atticScopeFloor (deleteField)', 'deny', updateDoc(ld(owner, 'OWF'), { atticScopeFloor: deleteField() }));
  await check('a rep who owns the lead deletes atticScopeFloor (deleteField)', 'deny', updateDoc(rl('RPF'), { atticScopeFloor: deleteField() }));
  await check('a rep deletes atticScopeFloor with a FieldPath', 'deny', updateDoc(rl('RPF2'), new FieldPath('atticScopeFloor'), deleteField()));
  await check('a rep changes atticScopeFloor to something else', 'deny', updateDoc(rl('RPF3'), { atticScopeFloor: 'other' }));
  await check('control: the owner edits an ordinary field on a lead that carries the floor', 'allow', updateDoc(ld(owner, 'OWF'), { notes: 'ok' }));
  await check('control: the rep re-saves the floor unchanged with another change', 'allow', updateDoc(rl('RPF'), { atticScopeFloor: 'reroof', notes: 'ok' }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' — ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
