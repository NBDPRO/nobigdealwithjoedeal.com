#!/usr/bin/env node
/**
 * NBD CRM connection for the Grok Bot team (functions/agent-mcp.js +
 * agent-mcp-logic.js), 2026-10-02.
 *
 *   A. Roles: each bot sees only its tools; Nova has none; CoS cannot file
 *      customer notes; only Quinn verifies.
 *   B. Minimization: a lead never leaves with phone / email / claim numbers.
 *   C. Read tools: summary (pipeline labelled PROJECTED), overdue follow-ups,
 *      stale leads.
 *   D. Filing: validation, the Kentucky claim-wording refusal.
 *   E. MCP protocol + endpoint guards (key hash lookup, revoked keys, role
 *      check before any tool runs, kill switch, rate limit, no send tools).
 *   F. With FIRESTORE_EMULATOR_HOST set: the real handler end to end —
 *      file_note lands in agent_inbox + one bell notification, a foreign
 *      lead is refused, Quinn's verify_item marks it checked.
 *
 * Run: node tests/agent-mcp-2026-10-02.test.js
 *      (F: npx firebase emulators:exec --only firestore "node tests/agent-mcp-2026-10-02.test.js")
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
  console.log('A. roles');
  const names = (b) => L.toolsForBot(b).map((t) => t.name);
  ok('Nova gets nothing (no NBD key can even be made)', L.toolsForBot('nova').length === 0 && !L.BOTS.nova);
  ok('first wave is CoS, Marcus, Quinn', L.FIRST_WAVE.join() === 'cos,marcus,quinn');
  ok('CoS reads + files reports, but no customer notes / reminders', names('cos').indexOf('file_report') !== -1 && names('cos').indexOf('file_note') === -1 && names('cos').indexOf('file_reminder') === -1);
  ok('Marcus reads and files notes + reminders', ['list_leads', 'lead_detail', 'schedule', 'file_note', 'file_reminder'].every((t) => names('marcus').indexOf(t) !== -1));
  ok('only Quinn can verify items', Object.keys(L.BOTS).filter((b) => L.botAllows(b, 'verify_item')).join() === 'quinn');
  ok('no tool anywhere sends, edits a customer or deletes', !Object.keys(L.TOOLS).some((t) => /send|text_|email|sms|delete|update|move|charge|pay/i.test(t)));
  ok('every tool has an object input schema', Object.values(L.TOOLS).every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  console.log('B. minimization');
  const raw = { id: 'L1', firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St', phone: '8595550147', email: 'm@x.test', claimNumber: 'CLM-9', policyNumber: 'P-1', stage: 'negotiating', jobValue: 14200, followUp: '2026-09-28', updatedAt: Date.parse('2026-09-01') };
  const m = L.minimalLead(raw);
  const s = JSON.stringify(m);
  ok('name, address, stage, follow-up kept', m.name === 'Maria Lopez' && m.address === '1420 Oak St' && m.stage === 'negotiating' && m.follow_up === '2026-09-28');
  ok('never phone, email, claim or policy numbers', !/8595550147|m@x\.test|CLM-9|P-1/.test(s) && !L.FORBIDDEN_KEYS.some((k) => k in m));

  console.log('C. reads');
  const leads = [
    raw,
    { id: 'L2', firstName: 'Bob', stage: 'closed', jobValue: 9000, followUp: '2026-09-01', updatedAt: Date.parse('2026-05-01') },
    { id: 'L3', firstName: 'Ann', stage: 'contacted', jobValue: 5000, followUp: '2026-10-02', updatedAt: Date.parse('2026-04-01') },
    { id: 'L4', firstName: 'Del', stage: 'new', deleted: true },
    { id: 'L5', firstName: 'ZZ', stage: 'new', e2eTestData: true },
  ];
  const sm = L.summary(leads, '2026-10-02');
  ok('summary: deleted / test leads out, closed value out of the pipeline, labelled projected', sm.customers === 3 && sm.open_pipeline_value_projected === 19200 && sm.followups_due_today === 1 && sm.followups_overdue === 1 && /projected/i.test(sm.note), JSON.stringify(sm));
  ok('overdue follow-ups skip closed jobs', JSON.stringify(L.overdueFollowups(leads, '2026-10-02').map((x) => x.lead_id)) === '["L1"]');
  ok('stale = not updated in N days, open jobs only', JSON.stringify(L.listLeads(leads, { stale_days: 60 }, Date.parse('2026-10-02')).map((x) => x.lead_id)) === '["L3"]');
  ok('list limit is capped at 50', L.listLeads(Array.from({ length: 80 }, (_, i) => ({ id: 'x' + i, stage: 'new' })), { limit: 500 }, 0).length === 50);

  console.log('D. filing');
  ok('a reminder needs a real date', !!L.validateFiling('file_reminder', { lead_id: 'L1', text: 'x', due_date: 'Friday' }, true).error);
  ok('a note on an unknown customer is refused', !!L.validateFiling('file_note', { lead_id: 'nope', text: 'x' }, false).error);
  ok('empty / huge text is refused', !!L.validateFiling('file_note', { lead_id: 'L1', text: '  ' }, true).error && !!L.validateFiling('file_note', { lead_id: 'L1', text: 'x'.repeat(2001) }, true).error);
  ok('a good reminder becomes an inbox item', JSON.stringify(L.validateFiling('file_reminder', { lead_id: 'L1', text: 'Call about gutters', due_date: '2026-10-09' }, true).item) === '{"kind":"reminder","leadId":"L1","title":"","text":"Call about gutters","dueDate":"2026-10-09"}');
  ok('Kentucky: "we\'ll handle your insurance claim" is refused', !!L.claimWordingProblem('Tell her we will handle the insurance claim for her') && !!L.claimWordingProblem('Joe can negotiate with the adjuster on the claim'));
  ok('…while documenting damage / meeting the adjuster is fine', L.claimWordingProblem('We document the damage and meet the adjuster; the claim stays hers.') === null);

  console.log('E. protocol + guards');
  ok('initialize echoes a supported protocol version and names the bot', L.initializeResult({ protocolVersion: '2025-03-26' }, 'marcus').protocolVersion === '2025-03-26' && /Marcus/.test(L.initializeResult({}, 'marcus').instructions) && L.initializeResult({ protocolVersion: '1999' }, 'cos').protocolVersion === L.PROTOCOL_VERSIONS[0]);
  const src = read('functions/agent-mcp.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('keys: Bearer nbdk_… → SHA-256 doc lookup, must be active and for a known bot', /\^Bearer\\s\+\(nbdk_/.test(src) && /db\(\)\.collection\('agent_keys'\)\.doc\(id\)\.get\(\)/.test(src) && /if \(!k \|\| k\.active !== true\) return refuse\(\);/.test(src) && /if \(!hasOwn\(L\.BOTS, k\.botId\)\) return refuse\(\);/.test(src) && /b\.active !== true \|\| b\.companyId !== k\.companyId\) return refuse\(\);/.test(src));
  ok('the raw key is never stored — only its hash and a 9-char prefix', /const id = sha256\(raw\);/.test(src) && /prefix: raw\.slice\(0, 9\)/.test(src) && !/key: raw,[\s\S]{0,40}set\(/.test(src));
  ok('a tool outside the bot\'s role is refused before it runs', /if \(!L\.botAllows\(key\.bot, name\)\) return L\.rpcResult\(msg\.id, L\.toolErr\('This tool is not part of your role\.'\)\);\s*let out;/.test(src));
  ok('kill switch + per-key rate limit', /AGENT_MCP_DISABLED === 'true'/.test(src) && /enforceRateLimit\('agentMcp', key\.id, CALLS_PER_HOUR/.test(src));
  ok('no sending, no customer edits, no deletes in the connection', !/twilio|resend|sendSMS|sendEmail|messages\.create|\.delete\(\)|collection\('leads'\)\.doc\([^)]*\)\.(update|set)\(/.test(code));
  const rules = read('firestore.rules');
  ok('agent_keys and agent_audit are server-only', /match \/agent_keys\/\{keyId\}\s+\{ allow read, write: if false; \}/.test(rules) && /match \/agent_audit\/\{auditId\} \{ allow read, write: if false; \}/.test(rules));
  const fb = JSON.parse(read('firebase.json'));
  ok('/api/mcp rewrites to crmMcp', (fb.hosting.rewrites || []).some((r) => r.source === '/api/mcp' && r.function && r.function.functionId === 'crmMcp'));

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log('F. emulator end to end');
    const { initializeApp, getApps } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'app'));
    if (!getApps().length) initializeApp({ projectId: 'nbd-test' });
    const { getFirestore } = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
    const db = getFirestore();
    const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'))._internal;
    const CO = 'co-mcp';
    await db.doc('leads/mL1').set({ companyId: CO, userId: CO, firstName: 'Maria', lastName: 'Lopez', address: '1 Oak', phone: '8595550147', stage: 'negotiating', followUp: '2020-01-01' });
    await db.doc('leads/mX1').set({ companyId: 'someone-else', userId: 'someone-else', firstName: 'Other', stage: 'new' });
    const kId = M.sha256('nbdk_test_marcus_key_0000000000');
    await db.doc('agent_keys/' + kId).set({ botId: 'marcus', companyId: CO, active: true });
    const qId = M.sha256('nbdk_test_quinn_key_00000000000');
    await db.doc('agent_keys/' + qId).set({ botId: 'quinn', companyId: CO, active: true });
    const marcus = { id: kId, botId: 'marcus', companyId: CO }, quinn = { id: qId, botId: 'quinn', companyId: CO }, cos = { id: 'c', botId: 'cos', companyId: CO };
    const call = (key, name, args) => M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key);
    const listed = await M.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, marcus);
    ok('tools/list returns Marcus\'s tools only', listed.result.tools.map((t) => t.name).join() === L.BOTS.marcus.tools.join());
    const od = JSON.parse((await call(marcus, 'overdue_followups', {})).result.content[0].text);
    ok('overdue_followups: own company only, no phone', od.customers.length === 1 && od.customers[0].lead_id === 'mL1' && !JSON.stringify(od).includes('8595550147'));
    const filed = (await call(marcus, 'file_note', { lead_id: 'mL1', text: 'Went quiet after the June estimate.' })).result;
    const fid = JSON.parse(filed.content[0].text).item_id;
    const item = (await db.doc('agent_inbox/' + fid).get()).data();
    ok('file_note lands pending + unverified in the company inbox', item && item.status === 'pending' && item.verified === false && item.companyId === CO && item.kind === 'note' && item.bot === 'Marcus · NBD Ops');
    await call(marcus, 'file_reminder', { lead_id: 'mL1', text: 'Call Maria', due_date: '2026-10-09' });
    const notifs = (await db.collection('notifications').where('type', '==', 'agent_inbox').where('userId', '==', CO).get()).docs.map((d) => d.data());
    ok('one bell notification per bot per day, counting filings', notifs.length === 1 && notifs[0].count === 2 && /Marcus/.test(notifs[0].title), JSON.stringify(notifs.map((n) => n.title)));
    const foreign = (await call(marcus, 'file_note', { lead_id: 'mX1', text: 'x' })).result;
    ok('another company\'s customer is refused', foreign.isError === true);
    const ky = (await call(marcus, 'file_note', { lead_id: 'mL1', text: 'Tell her we will handle the insurance claim.' })).result;
    ok('the Kentucky wording guard refuses on the server', ky.isError === true && /Kentucky/.test(ky.content[0].text));
    const denied = (await call(cos, 'file_note', { lead_id: 'mL1', text: 'x' })).result;
    ok('CoS calling a tool outside its role is refused', denied.isError === true && /not part of your role/.test(denied.content[0].text));
    const v = (await call(quinn, 'verify_item', { item_id: fid, ok: true, note: 'Matches the June estimate date.' })).result;
    const after = (await db.doc('agent_inbox/' + fid).get()).data();
    ok('Quinn\'s verify_item marks it checked', !v.isError && after.verified === true && /Quinn/.test(after.verifiedBy));
  } else {
    console.log('F. (skipped — no FIRESTORE_EMULATOR_HOST)');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
