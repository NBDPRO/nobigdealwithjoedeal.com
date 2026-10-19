/**
 * tests/job-cost-audit-agent-2026-10-19.test.js
 *
 * The read-only cost_audit agent tool (functions/agent-mcp-logic.js costAudit,
 * wired in functions/agent-mcp.js) and its server copy of the audit rules.
 * SYNTHETIC names and amounts only (public repo).
 *
 * Run: node tests/job-cost-audit-agent-2026-10-19.test.js
 */
'use strict';
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n');
const stripComments = (s) => s.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

function sandbox(files, extra) {
  const win = Object.assign({ console }, extra || {});
  win.window = win;
  vm.createContext(win);
  files.forEach((f) => vm.runInContext(read(f), win, { filename: f }));
  return win;
}

const A = sandbox(['docs/pro/js/job-cost-audit-logic.js']).NBDJobCostAudit;
const D = (y, m, d) => new Date(y, m - 1, d, 12);
let n = 0;
const ex = (o) => Object.assign({ id: 'x' + (++n), costType: 'direct', category: 'materials', amountCents: 100000, taxCents: 0, date: D(2026, 9, 10), supplier: 'S' + n }, o);
const sub = (c, o) => ex(Object.assign({ category: 'subcontractor', amountCents: c }, o));
const mat = (c, o) => ex(Object.assign({ category: 'materials', amountCents: c }, o));

console.log('\n1. the server copy is the same file');
ok('functions/job-cost-audit-logic.js is byte-identical to the CRM file', norm(read('functions/job-cost-audit-logic.js')) === norm(read('docs/pro/js/job-cost-audit-logic.js')));
const SA = require(path.join(ROOT, 'functions/job-cost-audit-logic.js'));
ok('...and loads under node', typeof SA.jobCostFlags === 'function' && SA.CONFIG.minPeers === 3);

console.log('\n2. the read-only cost_audit agent tool');
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
const NOW = Date.UTC(2026, 9, 19, 16);
const iso = (d) => new Date(NOW - d * 86400000).toISOString();
const lead = (id, name, o) => Object.assign({ id, firstName: name, lastName: 'Sample', stage: 'closed', completedAt: iso(10), createdAt: iso(90), phone: '5135550100', email: 'x@example.com', trades: ['roof'] }, o);
const inv = (leadId, total) => ({ leadId, total, payments: [{ amount: total, at: iso(12) }] });
const cl = [lead('L1', 'Alpha'), lead('L2', 'Bravo'), lead('L3', 'Charlie'), lead('L4', 'Delta'), lead('L5', 'Echo'), lead('L6', 'Foxtrot', { costAudit: { complete: true } }),
  lead('L7', 'Golf', { stage: 'lost' })];
const ci = [inv('L1', 12000), inv('L2', 10000), inv('L3', 10000), inv('L4', 10000), inv('L5', 10000), inv('L6', 9000), inv('L7', 5000)];
const cexp = (leadId, e) => Object.assign({ leadId, costType: 'direct', category: 'materials', amountCents: 100000, taxCents: 0, date: D(2026, 9, 10) }, e);
const ce = [
  cexp('L1', { amountCents: 200000 }),
  cexp('L2', { category: 'subcontractor', amountCents: 400000 }), cexp('L2', { amountCents: 300000 }),
  cexp('L3', { category: 'subcontractor', amountCents: 450000 }), cexp('L3', { amountCents: 300000 }),
  cexp('L4', { category: 'subcontractor', amountCents: 500000 }), cexp('L4', { amountCents: 250000 }),
  cexp('L5', { category: 'subcontractor', amountCents: 400000, deleted: true }),
];
const out = L.costAudit(cl, ci, ce, NOW, {}, 'America/New_York', null);
const J = (id) => out.jobs.find((j) => j.lead_id === id);
ok('a finished job with no sub cost is listed with its numbers and the reason', J('L1') && J('L1').collected === 12000 && J('L1').direct_costs === 2000 && J('L1').margin_pct === 83 && J('L1').missing_sub_labor === true && J('L1').reasons.length >= 1, JSON.stringify(J('L1')));
ok('a voided sub row does not count (L5 is still missing its sub cost)', J('L5') && J('L5').missing_sub_labor === true);
ok('jobs with a sub cost, in line with their peers, are not listed', !J('L2') && !J('L3') && !J('L4'), out.jobs.map((j) => j.lead_id).join());
ok('a job marked complete, and a lost one, are left out', !J('L6') && !J('L7') && out.totals.marked_complete === 1);
ok('totals', out.totals.checked === 6 && out.totals.flagged === out.jobs.length);
ok('no phone, email or address anywhere in the answer', !/5135550100|example\.com|phone|email/i.test(JSON.stringify(out).replace(/The tool.*/, '')) && out.jobs.every((j) => !('phone' in j) && !('email' in j) && !('address' in j)));
const sigL1 = A.signature(A.summarize(1200000, [cexp('L1', { amountCents: 200000 })]));
const ackOnly = cl.map((l) => (l.id === 'L1' ? Object.assign({}, l, { costAudit: { ack: { margin_above_peers: sigL1 } } }) : l));
const naOnly = cl.map((l) => (l.id === 'L1' ? Object.assign({}, l, { costAudit: { asked: { sub: 'na' } } }) : l));
const both = cl.map((l) => (l.id === 'L1' ? Object.assign({}, l, { costAudit: { ack: { margin_above_peers: sigL1 }, asked: { sub: 'na' } } }) : l));
const listed = (rows) => !!L.costAudit(rows, ci, ce, NOW, {}, 'America/New_York', null).jobs.find((j) => j.lead_id === 'L1');
ok('"It\'s right" and "not applicable" each quiet only their own reason; together the job is left out', listed(cl) && listed(ackOnly) && listed(naOnly) && !listed(both));
ok('a stale "It\'s right" (the numbers moved) does not hide the job', (() => { const stale = cl.map((l) => (l.id === 'L1' ? Object.assign({}, l, { costAudit: { ack: { margin_above_peers: 'old' }, asked: { sub: 'na' } } }) : l)); return listed(stale); })());
ok('a negative-margin job sorts first and reads bad', (() => {
  const o2 = L.costAudit(cl.concat([lead('L8', 'Hotel')]), ci.concat([inv('L8', 3000)]), ce.concat([cexp('L8', { category: 'subcontractor', amountCents: 500000 })]), NOW, {}, 'America/New_York', null);
  return o2.jobs[0].lead_id === 'L8' && o2.jobs[0].reasons.some((r) => r.severity === 'bad');
})());
ok('days: an old finished job drops out of the window', !L.costAudit([lead('Lx', 'Old', { completedAt: iso(500) })], [inv('Lx', 10000)], [], NOW, { days: 30 }, 'America/New_York', null).jobs.length);
ok('Frank alone gets cost_audit, and it is read only', L.botAllows('frank', 'cost_audit') && Object.keys(L.BOTS).filter((b) => L.botAllows(b, 'cost_audit')).join() === 'frank' && L.annotationsFor('cost_audit').readOnlyHint === true && L.WRITES.indexOf('cost_audit') === -1);
ok('it is listed with a schema', L.toolsForBot('frank').some((t) => t.name === 'cost_audit' && t.inputSchema && t.annotations.readOnlyHint));
const handler = stripComments(read('functions/agent-mcp.js'));
const block = handler.slice(handler.indexOf("name === 'cost_audit'"), handler.indexOf("name === 'storm_near_customers'"));
ok('the handler reads company data and writes nothing', /L\.costAudit\(/.test(block) && !/\.(set|add|update|delete|create)\(/.test(block) && !/serverTimestamp|FieldValue/.test(block));
ok('the tool text says it never changes a cost', /never changes a cost/.test(L.TOOLS.cost_audit.description) && /READ ONLY/.test(L.TOOLS.cost_audit.description));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
