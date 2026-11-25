#!/usr/bin/env node
/**
 * Agent inbox dedupe key (roadmap step 6, 2026-11-22; Joe: "server owns, bots
 * read"). The same topic was filed into the Agent inbox several times (storms
 * up to 3x, quiet proposals 2x, overdue follow-ups 3x) because no filing tool
 * deduped. Every crmMcp tool that creates an agent_inbox item now takes an
 * optional dedupe_key:
 *
 *   - same company + same key while the earlier item is still pending (the
 *     owner has not decided it) -> no new item; the answer is the earlier
 *     item_id with deduped: true
 *   - the earlier item decided (approved / dismissed / sent_by_owner) -> a new
 *     item may be filed
 *   - keys are per company: another company's key never collides or reveals
 *   - race-safe: a lock doc agent_inbox_keys/dk_{sha256(company, key)} is read
 *     and written in the same transaction as the item create (server-only in rules)
 *   - a key held by a waiting item of another kind or lead -> an error, never a
 *     silent drop onto that item; a lock whose item is gone files a new item
 *   - no key -> today's behaviour, unchanged
 *
 *   A. logic: key validation, lock id, what counts as still open
 *   B. tool schemas + descriptions, rules, the server wiring
 *   C. with FIRESTORE_EMULATOR_HOST: the real handler end to end
 *
 * Run: node tests/agent-inbox-dedupe-2026-11-22.test.js
 *      (C: npx firebase emulators:exec --only firestore "node tests/agent-inbox-dedupe-2026-11-22.test.js")
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));

(async () => {
  console.log('A. logic');
  const fn = (n) => typeof L[n] === 'function';
  ok('dedupeKeyOf, dedupeLockId and dedupeOpen exist', fn('dedupeKeyOf') && fn('dedupeLockId') && fn('dedupeOpen'));
  if (fn('dedupeKeyOf')) {
    const K = L.dedupeKeyOf;
    ok('no dedupe_key -> no key, no error', K({}).key === null && !K({}).error && K({ dedupe_key: undefined }).key === null);
    ok('valid shapes pass through unchanged', ['radar:followup:abc123', 'radar:quiet:est_9', 'storm:2026-11-22:zone-3', 'lead:first:L1', 'a', 'x.y|z'].every((k) => K({ dedupe_key: k }).key === k));
    ok('120 chars is the most', K({ dedupe_key: 'a'.repeat(120) }).key === 'a'.repeat(120) && !!K({ dedupe_key: 'a'.repeat(121) }).error);
    ok('empty, spaces, slashes, quotes and unicode are refused', ['', ' ', 'a b', 'a/b', "a'b", 'storm:é', 'a\nb', 'a#b'].every((k) => !!K({ dedupe_key: k }).error));
    ok('a non-string (number, object, array, boolean) is refused', [5, { a: 1 }, ['a'], true].every((k) => !!K({ dedupe_key: k }).error));
    ok('null is the same as no key (clients that send unused optionals as null file as before)', K({ dedupe_key: null }).key === null && !K({ dedupe_key: null }).error);
    ok('the error names the field and the allowed shape', /dedupe_key/.test(K({ dedupe_key: 'a b' }).error) && /120/.test(K({ dedupe_key: 'a b' }).error));
  }
  if (fn('dedupeLockId')) {
    const a = L.dedupeLockId('coA', 'storm:2026-11-22:z1');
    ok('lock id is deterministic', a === L.dedupeLockId('coA', 'storm:2026-11-22:z1'));
    ok('lock id differs per company for the same key', a !== L.dedupeLockId('coB', 'storm:2026-11-22:z1'));
    ok('lock id differs per key in one company', a !== L.dedupeLockId('coA', 'storm:2026-11-22:z2'));
    ok('lock id is a safe doc id that never carries the raw key', /^[A-Za-z0-9_-]+$/.test(a) && a.indexOf('storm') === -1 && a.length <= 200);
    ok('a company id with odd characters cannot steer the id into another company\'s', L.dedupeLockId('co_A', 'k') !== L.dedupeLockId('coA', 'k') && L.dedupeLockId('a__b', 'c') !== L.dedupeLockId('a', 'b__c'));
  }
  if (fn('dedupeOpen')) {
    const O = L.dedupeOpen;
    const base = { companyId: 'coA', dedupeKey: 'k1', status: 'pending' };
    ok('pending, same company, same key -> open', O(base, 'coA', 'k1') === true);
    ok('approved / dismissed / sent_by_owner -> decided, not open', ['approved', 'dismissed', 'sent_by_owner'].every((s) => O(Object.assign({}, base, { status: s }), 'coA', 'k1') === false));
    ok('another company\'s item never counts', O(base, 'coB', 'k1') === false);
    ok('a different key never counts', O(base, 'coA', 'k2') === false);
    ok('a missing item is not open', O(null, 'coA', 'k1') === false && O(undefined, 'coA', 'k1') === false);
  }
  ok('dedupeDecision exists', fn('dedupeDecision'));
  if (fn('dedupeDecision')) {
    // The step inside fileItemOnce's transaction: (lock's itemId, that item or null, company, key, new item).
    const D = L.dedupeDecision;
    const rep = { kind: 'report', leadId: null };
    const note = { kind: 'note', leadId: 'L1' };
    const open = (o) => Object.assign({ companyId: 'coA', dedupeKey: 'k1', status: 'pending' }, o);
    ok('no lock -> file a new item', D('', null, 'coA', 'k1', rep).file === true);
    ok('a lock whose item is gone (deleted, reseeded) -> file a new item, never blocked forever', D('it1', null, 'coA', 'k1', rep).file === true);
    ok('a lock whose item the owner sent (sent_by_owner) -> file a new item', D('it1', open({ kind: 'draft_text', leadId: 'L1', status: 'sent_by_owner' }), 'coA', 'k1', { kind: 'draft_text', leadId: 'L1' }).file === true);
    ok('a lock whose item was approved / dismissed -> file a new item', ['approved', 'dismissed'].every((st) => D('it1', open(Object.assign({ status: st }, rep)), 'coA', 'k1', rep).file === true));
    const dup = D('it1', open(rep), 'coA', 'k1', rep);
    ok('a pending item of the same kind (and lead) -> deduped to it', dup.dupId === 'it1' && dup.kind === 'report' && !dup.file && !dup.error);
    ok('same kind, same lead -> deduped', D('it1', open(note), 'coA', 'k1', note).dupId === 'it1');
    const k = D('it1', open(rep), 'coA', 'k1', { kind: 'draft_text', leadId: 'L2' });
    ok('a pending item of ANOTHER kind -> an error, never a silent drop onto it', !!k.error && !k.dupId && !k.file && /dedupe_key/.test(k.error));
    const l = D('it1', open(note), 'coA', 'k1', { kind: 'note', leadId: 'L2' });
    ok('the same kind for ANOTHER lead -> an error, never a silent drop onto it', !!l.error && !l.dupId && !l.file);
    ok('a lead-less item vs a lead item -> an error', !!D('it1', open({ kind: 'note', leadId: null }), 'coA', 'k1', note).error);
    ok('an item of another company never dedupes or blocks', D('it1', open(Object.assign({ companyId: 'coB' }, rep)), 'coA', 'k1', rep).file === true);
  }

  console.log('B. schemas, rules, wiring');
  const FILERS = ['file_note', 'file_reminder', 'file_report', 'draft_text', 'draft_email', 'file_social_draft'];
  ok('the filing tools are exactly the writes minus verify_item', JSON.stringify((L.FILING_TOOLS || []).slice().sort()) === JSON.stringify(FILERS.slice().sort()), JSON.stringify(L.FILING_TOOLS));
  FILERS.forEach((t) => {
    const s = L.TOOLS[t] && L.TOOLS[t].inputSchema;
    const p = s && s.properties && s.properties.dedupe_key;
    ok(t + ': takes an optional dedupe_key string (1..120, safe characters)', !!p && p.type === 'string' && p.maxLength === 120 && p.minLength === 1 && typeof p.pattern === 'string' && (s.required || []).indexOf('dedupe_key') === -1 && s.additionalProperties === false);
    ok(t + ': the description says what it does and suggests shapes', /dedupe_key/.test(L.TOOLS[t].description) && /radar:followup:<leadId>/.test(L.TOOLS[t].description) && /storm:<YYYY-MM-DD>:<zone>/.test(L.TOOLS[t].description));
  });
  ok('no read-only tool takes a dedupe_key', Object.keys(L.TOOLS).filter((t) => FILERS.indexOf(t) === -1).every((t) => !((L.TOOLS[t].inputSchema || {}).properties || {}).dedupe_key));
  const src = read('functions/agent-mcp.js');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('every MCP filing tool reaches the inbox through fileItem with the key', (code.match(/return fileItem\(key, today, [^;]+, dk\.key\);/g) || []).length === 3, String((code.match(/return fileItem\([^;]+;/g) || []).length));
  // The one-transaction lock is proven by behaviour in section C (emulator: Promise.all of two
  // same-key filings -> one item), not by pinning source text (source-pin ratchet cap).
  ok('the transaction decides through L.dedupeDecision (the unit-tested step)', /L\.dedupeDecision\(prevId, prev\.exists \? prev\.data\(\) : null, company, dedupeKey, item\)/.test(code));
  ok('the key is validated before any tool runs', /L\.FILING_TOOLS\.indexOf\(name\) !== -1 \? L\.dedupeKeyOf\(args\)/.test(code));
  const rules = read('firestore.rules');
  ok('agent_inbox_keys is server-only in the rules', /match \/agent_inbox_keys\/\{lockId\}\s+\{ allow read, write: if false; \}/.test(rules));

  if (process.env.FIRESTORE_EMULATOR_HOST) {
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

    const race = await Promise.all([
      call(cosA, 'file_report', Object.assign({ dedupe_key: 'radar:quiet:estR' }, rep)),
      call(cosA, 'file_report', Object.assign({ dedupe_key: 'radar:quiet:estR' }, rep)),
    ]);
    const rb = race.map(body);
    ok('two calls at the same moment -> one item', (await byKey(A, 'radar:quiet:estR')).length === 1, JSON.stringify(rb));
    ok('one filed, the other deduped to the same id', rb.filter((x) => x.filed === true).length === 1 && rb.filter((x) => x.deduped === true).length === 1 && rb[0].item_id === rb[1].item_id);

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
  } else {
    console.log('C. (skipped — no FIRESTORE_EMULATOR_HOST)');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
