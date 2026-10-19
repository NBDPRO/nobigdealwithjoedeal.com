/**
 * tests/cash-payouts-2026-10-19.test.js
 *
 * The "Cash paid out" log (docs/pro/js/cash-payouts.js). A payout is an
 * /expenses doc (subcontractor, DIRECT, source cash_payout) so every cost
 * reader counts it. Drives the REAL modules in vm sandboxes with SYNTHETIC
 * names and amounts (public repo): the doc it builds, totals / unassigned /
 * remembered payees, flag-off = nothing rendered, a linked payout reaching
 * job profit (client margin, "costs missing" check, agent job_profit), a
 * voided one not, and the source wiring (comments stripped first).
 *
 * Run: node tests/cash-payouts-2026-10-19.test.js
 */
'use strict';
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
// Line-based on purpose: a block-comment regex is fooled by "image/*" inside a
// string in expenses.js and swallows real code up to the next "*/".
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

let FLAG_ON = true;
const base = { NBDFlags: { enabled: (n) => FLAG_ON && n === 'cashPayoutsLog' }, _user: { uid: 'u1' }, _userClaims: { companyId: 'co1' } };
const win = sandbox(['docs/pro/js/cash-payouts.js'], Object.assign({}, base, {
  _leads: [{ id: 'L1', firstName: 'Sample', lastName: 'Customer', customerId: 'NBD-0001', stage: 'closed' }],
}));
const P = win.NBDCashPayouts;
const D = (y, m, d) => new Date(y, m - 1, d, 12);

console.log('\n1. the doc a payout becomes');
const b = P.buildFields({ amount: '$1,250.50', payee: '  Sample Crew  ', method: 'zelle', leadId: 'L1', date: '2026-09-03', note: 'tear-off' }, { jobIdFor: () => 'j2' });
ok('amount is integer cents', b.fields && b.fields.amountCents === 125050 && Number.isInteger(b.fields.amountCents), JSON.stringify(b));
ok('subcontractor, DIRECT, no tax', b.fields.category === 'subcontractor' && b.fields.costType === 'direct' && b.fields.taxCents === 0);
ok('payee is the supplier (trimmed), method and job kept', b.fields.supplier === 'Sample Crew' && b.fields.paymentMethod === 'zelle' && b.fields.leadId === 'L1' && b.fields.jobId === 'j2');
ok('date is local midnight of the picked day', b.fields.date.getFullYear() === 2026 && b.fields.date.getMonth() === 8 && b.fields.date.getDate() === 3 && b.fields.date.getHours() === 0);
ok('no job -> leadId and jobId null', (() => { const x = P.buildFields({ amount: '40', payee: 'A' }, { jobIdFor: () => 'zzz' }); return x.fields.leadId === null && x.fields.jobId === null; })());
ok('unknown method falls back to cash', P.buildFields({ amount: '5', payee: 'A', method: 'bitcoin' }).fields.paymentMethod === 'cash');
ok('needs a payee', !!P.buildFields({ amount: '5', payee: '  ' }).error);
['0', '', '-5', 'abc', '12.345', '1e3', '1000000000'].forEach((a) => ok('rejects amount "' + a + '"', !!P.buildFields({ amount: a, payee: 'A' }).error));
ok('parseCents: .1 + .2 style sums stay exact cents', P.parseCents('0.29') === 29 && P.parseCents('19.99') === 1999 && P.parseCents('1,000') === 100000);
ok('a bad date is refused', !!P.buildFields({ amount: '5', payee: 'A', date: 'nope' }).error);

console.log('\n2. totals, unassigned, remembered payees');
const rows = [
  { id: 'a', source: 'cash_payout', supplier: 'Sample Crew', amountCents: 100000, taxCents: 0, leadId: 'L1', date: D(2026, 9, 3) },
  { id: 'b', source: 'cash_payout', supplier: 'sample  crew', amountCents: 50000, leadId: null, date: D(2026, 9, 20) },
  { id: 'c', source: 'cash_payout', supplier: 'Other Sub', amountCents: 25000, leadId: 'L1', date: D(2026, 8, 30) },
  { id: 'd', source: 'cash_payout', supplier: 'Voided Guy', amountCents: 999900, leadId: null, date: D(2026, 9, 1), deleted: true },
  { id: 'e', source: 'manual', supplier: 'Supply House', category: 'materials', amountCents: 777700, leadId: null, date: D(2026, 9, 1) },
];
const T = P.totals(rows);
ok('count and total skip the voided row and plain expenses', T.count === 3 && T.totalCents === 175000, JSON.stringify(T));
ok('per month, newest first', T.months.length === 2 && T.months[0].key === '2026-09' && T.months[0].cents === 150000 && T.months[1].key === '2026-08' && T.months[1].cents === 25000);
ok('per job', T.jobs.length === 1 && T.jobs[0].leadId === 'L1' && T.jobs[0].cents === 125000);
ok('the no-job money is counted as unassigned, never dropped', T.unassigned.cents === 50000 && T.unassigned.count === 1);
ok('payees: de-duplicated ignoring case/spacing, most recent first, voided excluded', JSON.stringify(P.payees(rows)) === JSON.stringify(['sample  crew', 'Sample Crew'].slice(0, 1).concat(['Other Sub'])), JSON.stringify(P.payees(rows)));
ok('isPayout: ours and live only', P.isPayout(rows[0]) && !P.isPayout(rows[3]) && !P.isPayout(rows[4]));

console.log('\n3. panel: flag off renders nothing; on shows the counter');
FLAG_ON = false;
ok('flag off: no panel, no button', P.panelHtml(rows) === '' && P.buttonHtml() === '');
FLAG_ON = true;
const html = P.panelHtml(rows);
ok('flag on: unassigned counter is visible with the amount', /Unassigned crew cash: \$500\.00/.test(html), html.slice(0, 300));
ok('panel has a list newest first and an add button', /data-cp-action="add"/.test(html) && html.indexOf('Sample Crew') < html.indexOf('Other Sub'));
ok('panel lists Edit/Void only on the user\'s own rows', !/data-cp-action="void"/.test(P.panelHtml(rows)) && /data-cp-action="void" data-cp-id="a"/.test(P.panelHtml([Object.assign({}, rows[0], { userId: 'u1' })])));
ok('no unassigned money = no warning', !/Unassigned crew cash/.test(P.panelHtml([rows[0]])));
ok('a payee name is escaped', !/<img/.test(P.panelHtml([Object.assign({}, rows[0], { supplier: '<img src=x>' })])));
const viewer = sandbox(['docs/pro/js/cash-payouts.js'], Object.assign({}, base, { _userClaims: { companyId: 'co1', role: 'viewer' } }));
ok('a viewer sees the log but no add / edit / void', !/data-cp-action/.test(viewer.NBDCashPayouts.panelHtml([Object.assign({}, rows[0], { userId: 'u1' })])) && viewer.NBDCashPayouts.buttonHtml() === '');

console.log('\n4. a linked payout reaches job profit; a voided one does not');
const exp = Object.assign({}, b.fields, { id: 'x1', source: 'cash_payout', userId: 'u1' });
const pt = sandbox(['docs/pro/js/expense-config.js', 'docs/pro/js/profit-tracker.js'], { _leads: [], document: { addEventListener() {} } });
const lead = { id: 'L1', jobValue: 10000, stage: 'closed' };
const withNone = pt.ProfitTracker.computeJobPLWithExpenses(lead, []);
const withPay = pt.ProfitTracker.computeJobPLWithExpenses(lead, [exp]);
ok('client margin: payout is a direct job cost', withPay.miscCosts === 1250.5 && withPay.grossProfit < withNone.grossProfit, JSON.stringify(withPay));
const voidedPL = pt.ProfitTracker.computeJobPLWithExpenses(lead, [Object.assign({}, exp, { deleted: true })]);
ok('client margin: a voided payout costs nothing', voidedPL.miscCosts === 0 && voidedPL.grossProfit === withNone.grossProfit);
const rh = sandbox(['docs/pro/js/receipt-health.js']).NBDReceiptHealth;
ok('costs-missing check: a linked payout clears the job, a no-job one does not', rh.costsMissing([lead], [exp]).length === 0 && rh.costsMissing([lead], [Object.assign({}, exp, { leadId: null })]).length === 1 && rh.costsMissing([lead], [Object.assign({}, exp, { deleted: true })]).length === 1);
ok('a payout is never offered to the receipt sorter', !rh.isUnsorted(exp));
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
const NOW = Date.UTC(2026, 9, 19, 16);
const iso = (n) => new Date(NOW - n * 86400000).toISOString();
const jl = [{ id: 'L1', name: 'Sample Customer', stage: 'closed', completedAt: iso(5), createdAt: iso(60) }];
const inv = [{ leadId: 'L1', total: 10000, payments: [{ amount: 10000, at: iso(6) }] }];
const jp = (e) => L.jobProfit(jl, inv, e, NOW, {}).jobs[0];
ok('agent job_profit: payout lowers profit and flips costs_logged', jp([exp]).direct_costs === 1250.5 && jp([exp]).costs_logged === true && jp([]).costs_logged === false, JSON.stringify(jp([exp])));
ok('agent job_profit: voided payout is ignored', jp([Object.assign({}, exp, { deleted: true })]).costs_logged === false);

console.log('\n5. audit trail');
const log = P.appendLog([], { at: 1, what: 'edit', note: 'n' });
ok('appendLog adds an entry and keeps only the newest 25', log.length === 1 && P.appendLog(new Array(25).fill({ at: 0 }), { at: 9 }).length === 25 && P.appendLog(new Array(25).fill({ at: 0 }), { at: 9 })[24].at === 9);

console.log('\n6. wiring (comments stripped)');
const src = stripComments(read('docs/pro/js/cash-payouts.js'));
ok('reads the cashPayoutsLog flag, source and category constants', /FLAG = 'cashPayoutsLog'/.test(src) && /SOURCE = 'cash_payout'/.test(src) && /CATEGORY = 'subcontractor'/.test(src));
ok('never hard-deletes (no deleteDoc)', !/deleteDoc/.test(src));
ok('void and edit demand a note', (src.match(/Say (why|what)/g) || []).length === 2);
ok('no inline styles / handlers in the module', !/\sstyle\s*=/.test(src) && !/\son[a-z]+\s*=\s*["']/.test(src));
const exs = stripComments(read('docs/pro/js/expenses.js'));
ok('Expenses view mounts the button and the panel', /NBDCashPayouts\.buttonHtml\(\)/.test(exs) && /NBDCashPayouts\.panelHtml\(_expenses\)/.test(exs));
ok('Expenses load drops voided rows', /e\.deleted !== true/.test(exs));
const ptsrc = stripComments(read('docs/pro/js/profit-tracker.js'));
ok('profit tracker skips voided rows (margin math and cost-panel fetch)', /e\.deleted === true\) return/.test(ptsrc) && /e\.deleted !== true/.test(ptsrc));
const sl = stripComments(read('docs/pro/js/script-loader.js'));
ok('loaded with the expenses bundle, after expenses.js', sl.indexOf('js/cash-payouts.js') > sl.indexOf('js/expenses.js') && /css\/cash-payouts\.css/.test(sl));
const rules = stripComments(read('firestore.rules'));
ok('rules validate paymentMethod and bound editLog', /d\.paymentMethod in \['cash', 'zelle', 'check', 'other'\]/.test(rules) && /d\.editLog\.size\(\) <= 25/.test(rules));
const css = read('docs/pro/css/cash-payouts.css');
ok('phone targets: 48px buttons and 16px inputs', /\.cp-btn \{[^}]*min-height: 48px/.test(css) && /\.cp-in \{[^}]*font-size: 16px/.test(css));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
