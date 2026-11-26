#!/usr/bin/env node
/**
 * The Quinn gate, end to end under the Firestore emulator (roadmap step 8,
 * 2026-11-25). The node-bucket suite tests/quinn-gate-2026-11-25.test.js covers
 * the logic, the handler over an in-memory store and the inbox client; this
 * suite runs the real crmMcp handler and agentDraftAction against Firestore's
 * own transactions: a bot draft is stored unchecked, the owner's send needs
 * confirmUnverified until Quinn passes it, self-verification is refused,
 * withdraw_item works on the company's own pending items only and is audited.
 * Emulator bucket (tests/ci-manifest.json "emulator"; ci.yml emulator-orphan-suites).
 *
 * Run: cd tests && npm run test:quinngate
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('needs the Firestore emulator: cd tests && npm run test:quinngate'); process.exit(1); }
  console.log('emulator end to end');
  const { initializeApp, getApps } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
  if (!getApps().length) initializeApp({ projectId: 'nbd-test' });
  const { getFirestore } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
  const db = getFirestore();
  const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'))._internal;
  const A = 'co-quinn-a', B = 'co-quinn-b';
  await db.doc('leads/qgL1').set({ companyId: A, userId: A, firstName: 'Ann', lastName: 'Ames', address: '1 Elm', email: 'ann@example.test', stage: 'negotiating' });
  const mk = async (raw, botId, companyId) => { const id = M.sha256(raw); await db.doc('agent_keys/' + id).set({ botId, companyId, active: true }); return { id, botId, companyId }; };
  const marcusA = await mk('nbdk_test_quinngate_marcus_a_00000', 'marcus', A);
  const quinnA = await mk('nbdk_test_quinngate_quinn_a_000000', 'quinn', A);
  const tuckerA = await mk('nbdk_test_quinngate_tucker_a_00000', 'tucker', A);
  const marcusB = await mk('nbdk_test_quinngate_marcus_b_00000', 'marcus', B);
  const call = (key, name, args) => M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key).then((r) => r.result);
  const body = (r) => { try { return JSON.parse(r.content[0].text); } catch (_) { return {}; } };
  const get = async (id) => (await db.doc('agent_inbox/' + id).get()).data();
  const owner = { uid: A, token: { companyId: A } };
  const send = (data) => M.draftAction({ auth: owner, data }).then((r) => ({ r }), (e) => ({ err: e }));

  const em = body(await call(marcusA, 'draft_email', { lead_id: 'qgL1', subject: 'Your quote', body: 'Hi Ann, your quote.', reason: 'follow-up', from: 'jd' })).item_id;
  ok('a bot draft is stored quinn: unchecked', !!em && (await get(em)).quinn.state === 'unchecked');
  let r = await send({ action: 'sent', id: em, subject: 'Your quote', body: 'Hi Ann, your quote.' });
  ok('the owner\'s send without confirm is refused (failed-precondition), the draft still waits', !!r.err && r.err.code === 'failed-precondition' && /Not checked by Quinn/.test(r.err.message) && (await get(em)).status === 'pending', r.err ? r.err.message : 'sent');
  const self = await call(marcusA, 'file_report', { title: 'Mine', text: 'My own report.' });
  const selfId = body(self).item_id;
  const qself = body(await call(quinnA, 'file_report', { title: 'Quinn report', text: 'Checked the week.' })).item_id;
  const sv = await call(quinnA, 'verify_item', { item_id: qself, ok: true });
  ok('Quinn cannot verify her own filing', sv.isError === true && /own/.test(sv.content[0].text) && (await get(qself)).verified === false);
  await call(quinnA, 'verify_item', { item_id: em, ok: true, note: 'Fine.' });
  ok('Quinn passes Marcus\'s draft', (await get(em)).quinn.state === 'passed');
  r = await send({ action: 'sent', id: em, subject: 'Your quote', body: 'Hi Ann, your quote.' });
  ok('a passed draft sends with no confirm', r.r && r.r.ok === true && (await get(em)).status === 'sent_by_owner' && (await get(em)).quinnAtSend === 'passed', r.err && r.err.message);

  const em2 = body(await call(tuckerA, 'draft_email', { lead_id: 'qgL1', subject: 'Thanks', body: 'Hi Ann, thanks.', reason: 'thanks', from: 'jd' })).item_id;
  r = await send({ action: 'sent', id: em2, subject: 'Thanks', body: 'Hi Ann, thanks.', confirmUnverified: true });
  ok('an unchecked draft sends once the owner confirmed', r.r && r.r.ok === true && (await get(em2)).quinnAtSend === 'unchecked', r.err && r.err.message);

  const wB = await call(marcusB, 'withdraw_item', { item_id: selfId, reason: 'not mine' });
  ok('another company\'s bot cannot withdraw it', wB.isError === true && (await get(selfId)).status === 'pending');
  const wT = await call(tuckerA, 'withdraw_item', { item_id: selfId, reason: 'not mine' });
  ok('another bot of the same company cannot either', wT.isError === true && (await get(selfId)).status === 'pending');
  const w = await call(marcusA, 'withdraw_item', { item_id: selfId, reason: 'Wrong week.' });
  const after = await get(selfId);
  ok('the filer withdraws it: status withdrawn, reason kept', !w.isError && after.status === 'withdrawn' && after.withdrawReason === 'Wrong week.' && after.withdrawnByBotId === 'marcus', w.content[0].text);
  const audits = (await db.collection('agent_audit').where('companyId', '==', A).get()).docs.map((d) => d.data());
  ok('the withdrawal is in the audit trail with the item id', audits.some((a) => a.tool === 'withdraw_item' && a.ok === true && a.itemId === selfId));
  const again = await call(marcusA, 'withdraw_item', { item_id: selfId, reason: 'again' });
  ok('a decided item cannot be withdrawn', again.isError === true && /decided/.test(again.content[0].text));
  const sent = await call(marcusA, 'withdraw_item', { item_id: em, reason: 'too late' });
  ok('an item the owner already sent cannot be withdrawn', sent.isError === true && (await get(em)).status === 'sent_by_owner');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
