#!/usr/bin/env node
/**
 * Agent inbox dedupe key, end to end under the Firestore emulator (roadmap step 6,
 * 2026-11-22). The node-bucket suite tests/agent-inbox-dedupe-2026-11-22.test.js covers
 * the logic, schemas and wiring; this suite runs the real crmMcp handler: same key while
 * pending -> deduped, dismiss -> refile, per-company keys, a two-call race -> one item,
 * invalid keys, kind/lead clashes, a deleted or sent_by_owner item frees the key.
 * Emulator bucket (tests/ci-manifest.json "emulator"; ci.yml emulator-orphan-suites).
 *
 * Run: cd tests && npm run test:inboxdedupe
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));

(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('needs the Firestore emulator: cd tests && npm run test:inboxdedupe'); process.exit(1); }
  console.log('C. emulator end to end');
  const { initializeApp, getApps } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
  if (!getApps().length) initializeApp({ projectId: 'nbd-test' });
  const { getFirestore } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
  const db = getFirestore();
  const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'))._internal;
  const A = 'co-dedupe-a', B = 'co-dedupe-b';
  await db.doc('leads/ddL1').set({ companyId: A, userId: A, firstName: 'Ann', lastName: 'Ames', address: '1 Elm', stage: 'negotiating', followUp: '2020-01-01' });
  const mk = async (raw, botId, companyId) => { const id = M.sha256(raw); await db.doc('agent_keys/' + id).set({ botId, companyId, active: true }); return { id, botId, companyId }; };
  const marcusA = await mk('nbdk_test_dedupe_marcus_a_0000000', 'marcus', A);
  const cosA = await mk('nbdk_test_dedupe_cos_a_00000000000', 'cos', A);
  const cosB = await mk('nbdk_test_dedupe_cos_b_00000000000', 'cos', B);
  const danaA = await mk('nbdk_test_dedupe_dana_a_0000000000', 'dana', A);
  const call = (key, name, args) => M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key).then((r) => r.result);
  const body = (r) => { try { return JSON.parse(r.content[0].text); } catch (_) { return {}; } };
  const byKey = async (co, k) => (await db.collection('agent_inbox').where('companyId', '==', co).get()).docs.filter((d) => d.data().dedupeKey === k);
  const filedToday = async (key) => { const d = (await db.doc('agent_keys/' + key.id).get()).data() || {}; return Object.values(d.filedByDay || {}).reduce((s, n) => s + n, 0); };

  const rep = { title: 'Storm 2026-11-22', text: 'Hail near 3 customers.' };
  const r1 = await call(cosA, 'file_report', Object.assign({ dedupe_key: 'storm:2026-11-22:z1' }, rep));
  const b1 = body(r1);
  ok('first filing with a key files a new item', !r1.isError && b1.filed === true && !!b1.item_id && !b1.deduped, r1.content[0].text);
  const stored = b1.item_id ? (await db.doc('agent_inbox/' + b1.item_id).get()).data() : null;
  ok('the new item stores dedupeKey, pending, in its company', !!stored && stored.dedupeKey === 'storm:2026-11-22:z1' && stored.status === 'pending' && stored.companyId === A);
  const capBefore = await filedToday(cosA);
  const r2 = await call(cosA, 'file_report', Object.assign({ dedupe_key: 'storm:2026-11-22:z1' }, rep));
  const b2 = body(r2);
  ok('same key while pending -> deduped: true and the same item_id', !r2.isError && b2.deduped === true && b2.item_id === b1.item_id && b2.filed === false, r2.content[0].text);
  ok('still one item with that key', (await byKey(A, 'storm:2026-11-22:z1')).length === 1);
  ok('a deduped call does not use up the daily filing limit', (await filedToday(cosA)) === capBefore);
  const audits = (await db.collection('agent_audit').where('companyId', '==', A).get()).docs.map((d) => d.data());
  ok('the deduped call is in the audit trail as deduped', audits.some((a) => a.tool === 'file_report' && a.deduped === true));

  await db.doc('agent_inbox/' + b1.item_id).update({ status: 'dismissed', decidedBy: A });
  const r3 = await call(cosA, 'file_report', Object.assign({ dedupe_key: 'storm:2026-11-22:z1' }, rep));
  const b3 = body(r3);
  ok('after the owner dismissed it, the same key files a new item', !r3.isError && b3.filed === true && !b3.deduped && b3.item_id && b3.item_id !== b1.item_id, r3.content[0].text);
  ok('two items with that key now (one dismissed, one pending)', (await byKey(A, 'storm:2026-11-22:z1')).map((d) => d.data().status).sort().join() === 'dismissed,pending');
  const r3b = body(await call(cosA, 'file_report', Object.assign({ dedupe_key: 'storm:2026-11-22:z1' }, rep)));
  ok('and the new pending one is what the next call dedupes to', r3b.deduped === true && r3b.item_id === b3.item_id);

  const rB = body(await call(cosB, 'file_report', Object.assign({ dedupe_key: 'storm:2026-11-22:z1' }, rep)));
  ok('another company with the same key gets its own item', rB.filed === true && !rB.deduped && rB.item_id !== b3.item_id && (await byKey(B, 'storm:2026-11-22:z1')).length === 1);

  // Four at once (2026-11-25: two at once once failed in CI with "Transaction is invalid or
  // closed" instead of deduping; fileItemOnce now retries a contended transaction).
  for (let round = 1; round <= 3; round++) {
    const k = 'radar:quiet:estR' + round;
    const race = await Promise.all([1, 2, 3, 4].map(() => call(cosA, 'file_report', Object.assign({ dedupe_key: k }, rep))));
    const rb = race.map(body);
    ok('round ' + round + ': four calls at the same moment -> one item, no errors', (await byKey(A, k)).length === 1 && race.every((r) => !r.isError), JSON.stringify(race.map((r) => r.isError ? r.content[0].text : 'ok')));
    ok('round ' + round + ': one filed, the rest deduped to the same id', rb.filter((x) => x.filed === true).length === 1 && rb.filter((x) => x.deduped === true).length === 3 && rb.every((x) => x.item_id === rb[0].item_id));
  }

  const bad = await call(cosA, 'file_report', Object.assign({ dedupe_key: 'storm 2026/11/22' }, rep));
  ok('an invalid key is refused with an error and files nothing', bad.isError === true && /dedupe_key/.test(bad.content[0].text));
  const badNum = await call(cosA, 'file_report', Object.assign({ dedupe_key: 12 }, rep));
  ok('a numeric key is refused', badNum.isError === true);

  const n1 = body(await call(cosA, 'file_report', rep));
  const n2 = body(await call(cosA, 'file_report', rep));
  const n1d = (await db.doc('agent_inbox/' + n1.item_id).get()).data();
  ok('no key -> today\'s behaviour: two calls, two items, no dedupeKey field', n1.filed === true && n2.filed === true && n1.item_id !== n2.item_id && !('dedupeKey' in n1d) && !('deduped' in n1));

  const f1 = body(await call(marcusA, 'file_reminder', { lead_id: 'ddL1', text: 'Call Ann', due_date: '2026-11-25', dedupe_key: 'radar:followup:ddL1' }));
  const f2 = body(await call(marcusA, 'file_reminder', { lead_id: 'ddL1', text: 'Call Ann again', due_date: '2026-11-26', dedupe_key: 'radar:followup:ddL1' }));
  ok('file_reminder dedupes too', f1.filed === true && f2.deduped === true && f2.item_id === f1.item_id);
  const notes = body(await call(marcusA, 'file_note', { lead_id: 'ddL1', text: 'Same lead, other key', dedupe_key: 'lead:first:ddL1' }));
  ok('a different key in the same company is its own item', notes.filed === true && notes.item_id !== f1.item_id);
  const s1 = body(await call(danaA, 'file_social_draft', { brand: 'nbd', platform: 'facebook', caption: 'Storm season tips from No Big Deal.', reason: 'Season', dedupe_key: 'social:2026-11-22' }));
  const s2 = body(await call(danaA, 'file_social_draft', { brand: 'nbd', platform: 'facebook', caption: 'Storm season tips from No Big Deal.', reason: 'Season', dedupe_key: 'social:2026-11-22' }));
  ok('file_social_draft dedupes too', s1.filed === true && s2.deduped === true && s2.item_id === s1.item_id);

  await db.doc('leads/ddL2').set({ companyId: A, userId: A, firstName: 'Bo', lastName: 'Bell', address: '2 Elm', stage: 'negotiating', followUp: '2020-01-01' });
  const kindClash = await call(marcusA, 'file_note', { lead_id: 'ddL1', text: 'A note', dedupe_key: 'radar:followup:ddL1' });
  ok('the same key for another kind while waiting -> an error, nothing filed', kindClash.isError === true && /dedupe_key/.test(kindClash.content[0].text) && (await byKey(A, 'radar:followup:ddL1')).length === 1);
  const leadClash = await call(marcusA, 'file_reminder', { lead_id: 'ddL2', text: 'Call Bo', due_date: '2026-11-25', dedupe_key: 'radar:followup:ddL1' });
  ok('the same key for another lead while waiting -> an error, nothing filed', leadClash.isError === true && (await byKey(A, 'radar:followup:ddL1')).length === 1);
  await db.doc('agent_inbox/' + f1.item_id).delete();
  const g1 = body(await call(marcusA, 'file_reminder', { lead_id: 'ddL1', text: 'Call Ann', due_date: '2026-11-25', dedupe_key: 'radar:followup:ddL1' }));
  ok('the item behind a lock deleted -> the key files a new item and the lock follows it', g1.filed === true && g1.item_id !== f1.item_id
    && (await db.doc('agent_inbox_keys/' + L.dedupeLockId(A, 'radar:followup:ddL1')).get()).data().itemId === g1.item_id);
  await db.doc('agent_inbox/' + g1.item_id).update({ status: 'sent_by_owner' });
  const g2 = body(await call(marcusA, 'file_reminder', { lead_id: 'ddL1', text: 'Call Ann', due_date: '2026-11-25', dedupe_key: 'radar:followup:ddL1' }));
  ok('an item the owner sent (sent_by_owner) frees the key', g2.filed === true && g2.item_id !== g1.item_id);
  const nul = body(await call(cosA, 'file_report', Object.assign({ dedupe_key: null }, rep)));
  ok('dedupe_key: null files like no key', nul.filed === true && !nul.deduped);

  const lock = await db.doc('agent_inbox_keys/' + L.dedupeLockId(A, 'storm:2026-11-22:z1')).get();
  ok('the lock doc names the current item and its company', lock.exists && lock.data().itemId === b3.item_id && lock.data().companyId === A);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
