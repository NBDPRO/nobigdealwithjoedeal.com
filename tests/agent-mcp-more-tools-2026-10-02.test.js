#!/usr/bin/env node
/**
 * Bot team MCP, more read-only tools (Jo, 2026-10-02: "build it out first,
 * we'll test hard-core this week"):
 *   - estimates_status — latest estimate per customer, CUSTOMER-FACING total
 *     only (never cost / margin / rows), proposal status + views, "gone quiet".
 *   - collected_revenue — money collected (payments by date, refunds off),
 *     the same ledger as docs/pro/js/collected-revenue.js, run side by side
 *     here so the two can never drift.
 *   - Agent inbox: "✓ Add the N Quinn checked" bulk, and Quinn's flag notes
 *     shown on the item.
 *
 * Run: node tests/agent-mcp-more-tools-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n── tools and bots');
ok('both tools are defined', !!L.TOOLS.estimates_status && !!L.TOOLS.collected_revenue);
ok('every tool a bot lists exists', Object.values(L.BOTS).every((b) => b.tools.every((t) => !!L.TOOLS[t])));
ok('Frank (finance) gets collected_revenue and estimates_status', L.botAllows('frank', 'collected_revenue') && L.botAllows('frank', 'estimates_status'));
ok('Marcus gets estimates_status; Quinn can check both', L.botAllows('marcus', 'estimates_status') && L.botAllows('quinn', 'estimates_status') && L.botAllows('quinn', 'collected_revenue'));
ok('Dana, Priya, Theo do not get money tools', ['dana', 'priya', 'theo'].every((b) => !L.botAllows(b, 'collected_revenue')));
ok('Nova still has no bot entry', !L.BOTS.nova && L.toolsForBot('nova').length === 0);
ok('no new tool can send anything', !Object.keys(L.TOOLS).some((t) => /send|text_|sms|email|call_|delete|pay/.test(t)));

console.log('\n── estimates_status');
const NOW = Date.parse('2026-10-02T15:00:00Z');
const day = (n) => new Date(NOW - n * 86400000).toISOString();
const leads = [
  { id: 'L1', firstName: 'Ann', lastName: 'Lee', address: '1 A St', stage: 'estimate_sent_cash', phone: '859-555-0101', email: 'ann@x.test' },
  { id: 'L2', name: 'Bob Roe', address: '2 B St', stage: 'negotiating' },
  { id: 'L3', name: 'Cy Doe', address: '3 C St', stage: 'closed_won' },
];
const estimates = [
  { id: 'E1old', leadId: 'L1', grandTotal: 9000, createdAt: day(30), rows: [{ cost: 4000, retailTotal: 9000 }], costTotal: 4100, margin: 0.55, markup: 1.2 },
  { id: 'E1', leadId: 'L1', grandTotal: 12500.5, tier: 'better', createdAt: day(20), costTotal: 6000, marginPct: 52, rows: [{ cost: 6000 }] },
  { id: 'E2', leadId: 'L2', total: 7400, createdAt: day(3), cost: 3000 },
  { id: 'E3', leadId: 'L3', grandTotal: 15000, createdAt: day(40) },
  { id: 'Ex', leadId: 'GONE', grandTotal: 1 },
];
const deals = [
  { estimateId: 'E1', status: 'viewed', viewCount: 3, sentAt: day(19), lastViewedAt: day(15), createdAt: day(19) },
  { leadId: 'L2', status: 'sent', createdAt: day(2) },
  { estimateId: 'E3', status: 'accepted', createdAt: day(39), lastViewedAt: day(38) },
];
const rows = L.estimatesStatus(estimates, deals, leads, {}, NOW);
const r1 = rows.find((r) => r.lead_id === 'L1');
ok('one row per customer, unknown customers skipped', rows.length === 3 && !rows.some((r) => r.lead_id === 'GONE'));
ok('the LATEST estimate wins', r1 && r1.estimate_id === 'E1');
ok('customer-facing total (grandTotal, else total)', r1.total_customer_facing === 12500.5 && rows.find((r) => r.lead_id === 'L2').total_customer_facing === 7400);
const blob = JSON.stringify(rows);
ok('no cost, margin, markup or row data in the answer', !/cost|margin|markup|rows|4100|6000|0\.55|52/i.test(blob.replace(/total_customer_facing/g, '')), blob.slice(0, 200));
ok('no phone or email in the answer', !/859-555|@x\.test|phone|email/.test(blob));
ok('proposal matched by estimate id, with views', r1.proposal && r1.proposal.status === 'viewed' && r1.proposal.views === 3 && r1.proposal.last_viewed === day(15).slice(0, 10));
ok('proposal matched by lead when no estimate id', rows.find((r) => r.lead_id === 'L2').proposal.status === 'sent');
const quiet = L.estimatesStatus(estimates, deals, leads, { quiet_days: 10 }, NOW).map((r) => r.lead_id);
ok('quiet_days: viewed 15 days ago is quiet; accepted and recent are not', quiet.length === 1 && quiet[0] === 'L1', JSON.stringify(quiet));
ok('lead_id filter', L.estimatesStatus(estimates, deals, leads, { lead_id: 'L2' }, NOW).length === 1);

console.log('\n── collected_revenue: same ledger as collected-revenue.js');
const win = {};
vm.runInNewContext(read('docs/pro/js/collected-revenue.js'), { window: win, console, Date, Math, JSON, parseFloat, isNaN, Array, Object, parseInt, CustomEvent: function () {}, document: undefined });
const clientPaymentsOf = win.NBDRevenue && win.NBDRevenue.paymentsOf;
ok('the client ledger loaded for comparison', typeof clientPaymentsOf === 'function');
const ts = (iso) => ({ seconds: Math.floor(Date.parse(iso) / 1000), toMillis() { return Date.parse(iso); } });
const INV = [
  { id: 'i1', leadId: 'L1', total: 10000, balanceDue: 0, payments: [{ amount: 5000, at: '2026-09-03T15:00:00Z' }, { amount: 5000, at: ts('2026-10-01T15:00:00Z') }] },
  { id: 'i2', leadId: 'L2', total: '7400', balanceDue: '2400', payments: [{ amount: 3000, date: '2026-10-01T16:00:00Z' }] },
  { id: 'i3', leadId: 'L2', total: 2000, balanceDue: 0, paidAt: '2026-08-15T12:00:00Z' },
  { id: 'i4', leadId: 'L3', total: 15000, balanceDue: 0, payments: [{ amount: 15000, at: '2026-09-20T12:00:00Z' }], refunds: [{ amount: 500, at: '2026-09-25T12:00:00Z' }, { amount: 99, at: '2026-09-26T12:00:00Z', status: 'failed' }] },
  { id: 'i5', leadId: 'L1', total: 900, balanceDue: 900 },
  { id: 'i6', total: 300, balanceDue: 0, payments: [{ amount: 0, at: '2026-09-01' }, { amount: 'x' }], lastPaymentAt: '2026-09-02T12:00:00Z' },
  { id: 'i7', leadId: 'L1', total: 100, deleted: true, balanceDue: 0, paidAt: '2026-09-10T12:00:00Z' },
];
const norm = (list) => JSON.stringify(list.map((p) => [Math.round(p.amount * 100), !!p.synthetic, !!p.refund, L.ms(p.at)]));
INV.forEach((inv) => ok('ledger parity on ' + inv.id, norm(L.paymentsOf(inv)) === norm(clientPaymentsOf(inv)), norm(L.paymentsOf(inv)) + ' vs ' + norm(clientPaymentsOf(inv))));
const sept = L.collectedRevenue(INV, leads, '2026-09-01', '2026-09-30', 'America/New_York');
// i1 5000 (Sep 3) + i4 15000 − 500 refund + i6 300 lump (Sep 2); i3 is August; i7 deleted; failed refund ignored.
ok('September collected = 19,800 (refund off, failed refund ignored, deleted skipped)', sept.collected === 19800, JSON.stringify(sept));
ok('refunds_subtracted and payment count', sept.refunds_subtracted === 500 && sept.payments === 3, JSON.stringify([sept.refunds_subtracted, sept.payments]));
const all = L.collectedRevenue(INV, leads, '2026-08-01', '2026-10-31', 'America/New_York');
// October: i1 5000 + i2 3000 + i2's 2000 pre-ledger remainder (collected 5000, ledger 3000).
ok('by month across a range (incl. the pre-ledger remainder)', all.by_month['2026-08'] === 2000 && all.by_month['2026-09'] === 19800 && all.by_month['2026-10'] === 10000, JSON.stringify(all.by_month));
ok('top customers carry names, never phone/email', all.top_customers[0].name === 'Cy Doe' && !/phone|email|859/.test(JSON.stringify(all)));
ok('labelled as collected money, not projected', /Collected money only/.test(all.note));
const edge = L.collectedRevenue([{ total: 100, balanceDue: 0, paidAt: '2026-10-01T03:30:00Z' }], [], '2026-10-01', '2026-10-01', 'America/New_York');
ok('dates are New York days (03:30Z on Oct 1 is Sep 30 in KY)', edge.collected === 0);

console.log('\n── server wiring');
const srv = read('functions/agent-mcp.js');
ok('estimates_status reads estimates + deal_rooms for the company', /name === 'estimates_status'/.test(srv) && /companyDocs\('estimates', company/.test(srv) && /companyDocs\('deal_rooms', company/.test(srv));
ok('collected_revenue defaults to this month and validates dates', /name === 'collected_revenue'/.test(srv) && /today\.slice\(0, 8\) \+ '01'/.test(srv) && /from > to/.test(srv));
ok('invoices are read by company (companyId and createdBy)', /companyDocs\('invoices', company, \['companyId', 'createdBy'\]\)/.test(srv));

console.log('\n── Agent inbox');
const ai = read('docs/pro/js/agent-inbox.js');
const iwin = { addEventListener() {}, location: { search: '' }, history: {} };
vm.runInNewContext(ai, { window: iwin, document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; } }, setTimeout, console, Promise });
const A = iwin.NBDAgentInbox;
const items = [
  { id: 'a', kind: 'note', verified: true }, { id: 'b', kind: 'reminder', dueDate: '2026-10-03', verified: false, quinnNote: 'Wrong date' },
  { id: 'c', kind: 'report', verified: true }, { id: 'd', kind: 'reminder', dueDate: '2026-10-02', verified: true },
];
ok('bulk "checked only" takes verified notes + reminders, never reports', JSON.stringify(A.bulkIds(items, true)) === JSON.stringify(['d', 'a']), JSON.stringify(A.bulkIds(items, true)));
ok('bulk "all" still takes every note + reminder', A.bulkIds(items, false).length === 3);
ok('a Quinn flag reads as a flag, with her note', /ai-flag/.test(ai) && /⚠ flagged by/.test(ai) && /ai-qnote/.test(ai) && /it\.quinnNote/.test(ai));
ok('the checked button only shows when it differs from Add all', /checked < 1 \|\| checked === notesAndReminders/.test(ai));
const vOf = (re) => Number((read('docs/pro/dashboard.html').match(re) || [])[1]);
ok('dashboard loads the new inbox files (v3 or later)', vOf(/js\/agent-inbox\.js\?v=(\d+)/) >= 3 && vOf(/css\/agent-inbox\.css\?v=(\d+)/) >= 3);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
