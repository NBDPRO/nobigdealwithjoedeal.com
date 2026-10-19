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
const lead = (id, name, o) => Object.assign({ id, firstName: name, lastName: 'Sample', stage: 'closed', completedAt: iso(10), createdAt: iso(90), phone: '5135550100', email: 'x@example.com', address: '12 Private Lane, Hidden Town, OH 45000', trades: ['roof'] }, o);
const inv = (leadId, total) => ({ leadId, total, payments: [{ amount: total, at: iso(12) }] });
const cl = [lead('L1', 'Alpha'), lead('L2', 'Bravo'), lead('L3', 'Charlie'), lead('L4', 'Delta'), lead('L5', 'Echo'), lead('L6', 'Foxtrot', { costAudit: { complete: true, completeSig: A.signature(A.summarize(900000, [])) } }),
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
ok('no phone, email or address anywhere in the answer (and the fixtures do carry them)', cl[0].phone === '5135550100' && cl[0].address.indexOf('Private Lane') !== -1 && !/5135550100|example\.com|Private Lane|Hidden Town|45000/i.test(JSON.stringify(out)) && out.jobs.length > 0 && out.jobs.every((j) => !('phone' in j) && !('email' in j) && !('address' in j)));
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


console.log('\n3. review fixes: estimates, signatures, one unit, window, truncation, peers');
const row = (id) => out.jobs.find((j) => j.lead_id === id);
// 1. estimate-only stays visible
const estCl = cl.concat([lead('LE', 'Estimate')]);
const estInv = ci.concat([inv('LE', 10000)]);
const estRows = ce.concat([cexp('LE', { amountCents: 100000 }), cexp('LE', { category: 'subcontractor', amountCents: 500000, estimated: true })]);
const eo = L.costAudit(estCl, estInv, estRows, NOW, {});
const le = eo.jobs.find((j) => j.lead_id === 'LE');
ok('an estimate-only job is still reported, as estimated_only, with its estimate shown', le && le.estimated_only === true && le.missing_sub_labor === false && le.estimated_costs === 5000 && le.reasons.some((r) => r.code === 'estimated_only'), JSON.stringify(le));
const realRows = estRows.map((r) => (r.estimated ? Object.assign({}, r, { estimated: false }) : r));
ok('...and leaves the list once the same cost is real', !L.costAudit(estCl, estInv, realRows, NOW, {}).jobs.find((j) => j.lead_id === 'LE'));
// 4 + 8. complete and skip hold only for the numbers
ok('"Costs complete" with no or a stale fingerprint does not hide a job', (() => {
  const mkc = (audit) => cl.map((l) => (l.id === 'L1' ? Object.assign({}, l, { costAudit: audit }) : l));
  const sigNow = A.signature(A.summarize(1200000, [cexp('L1', { amountCents: 200000 })]));
  const hidden = !L.costAudit(mkc({ complete: true, completeSig: sigNow }), ci, ce, NOW, {}).jobs.find((j) => j.lead_id === 'L1');
  const noSig = !!L.costAudit(mkc({ complete: true }), ci, ce, NOW, {}).jobs.find((j) => j.lead_id === 'L1');
  const stale = !!L.costAudit(mkc({ complete: true, completeSig: 'old' }), ci, ce, NOW, {}).jobs.find((j) => j.lead_id === 'L1');
  return hidden && noSig && stale;
})());
// 7. one unit: a repeat customer's invoices and costs are one picture, and the CRM's fingerprint matches
const repeat = lead('LR', 'Repeat');
const repInv = [inv('LR', 6000), inv('LR', 6000)];
const repRows = [cexp('LR', { amountCents: 100000 }), cexp('LR', { amountCents: 100000 })];
const ro = L.costAudit([repeat], repInv, repRows, NOW, {});
ok('a customer with two jobs is ONE row with both jobs\' money and costs (as the panel sees it)', L.costAudit([repeat], repInv, repRows, NOW, {}).jobs.length === 1 && ro.jobs[0].collected === 12000 && ro.jobs[0].direct_costs === 2000, JSON.stringify(ro.jobs));
const repSig = A.signature(A.summarize(1200000, repRows));
const repAcked = Object.assign({}, repeat, { costAudit: { ack: { duplicate_costs: repSig }, asked: { sub: 'na' } } });
ok('the CRM\'s fingerprint of those same numbers quiets Frank\'s list', L.costAudit([repAcked], repInv, repRows, NOW, {}).jobs.length === 0);
ok('...and a new cost on the second job re-opens it', L.costAudit([repAcked], repInv, repRows.concat([cexp('LR', { amountCents: 5000, date: D(2026, 9, 12) })]), NOW, {}).jobs.length === 1);
// 11. window
const undated = lead('LU', 'Undated', { completedAt: undefined, createdAt: undefined });
delete undated.completedAt; delete undated.createdAt;
ok('a finished job with NO date is kept; one with a known old date is dropped by the window', L.costAudit([undated], [inv('LU', 10000)], [], NOW, { days: 30 }).jobs.length === 1 && L.costAudit([lead('LO', 'Old', { completedAt: iso(400) })], [inv('LO', 10000)], [], NOW, { days: 30 }).jobs.length === 0);
// 12. truncation
const many = []; const manyInv = [];
for (let i = 0; i < 5; i++) { many.push(lead('M' + i, 'Many' + i)); manyInv.push(inv('M' + i, 10000 + i)); }
const mo = L.costAudit(many, manyInv, [], NOW, { limit: 2 });
ok('a cut list says so, with the real total', mo.jobs.length === 2 && mo.totals.flagged === 5 && mo.totals.truncated === true && mo.totals.shown === 2 && /cut at 2 of 5/.test(mo.note) && L.costAudit(many, manyInv, [], NOW, { limit: 10 }).totals.truncated === false);
// 6. peers are settled finished jobs
const owedInv = ci.map((i) => (['L2', 'L3', 'L4'].indexOf(i.leadId) !== -1 ? Object.assign({}, i, { balanceDue: 100 }) : i));
ok('jobs that still owe money do not set the median', !!row('L1') && JSON.stringify(row('L1').reasons).indexOf('margin_above_peers') !== -1 && JSON.stringify(L.costAudit(cl, owedInv, ce, NOW, {}).jobs.find((j) => j.lead_id === 'L1').reasons).indexOf('margin_above_peers') === -1);
const hsrc = stripComments(read('functions/agent-mcp.js'));
ok('the handler no longer loads per-job records (the unit is the lead)', !/L\.costAudit\([^)]*jobsByLead/.test(hsrc));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
