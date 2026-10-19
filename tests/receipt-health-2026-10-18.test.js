/**
 * tests/receipt-health-2026-10-18.test.js
 *
 * docs/pro/js/receipt-health.js — the read-only "are the receipts all in?"
 * panel on Expenses: UNSORTED count + chip rule, finished jobs with NO direct
 * cost on the books, and the Copy PO name list for jobs in progress. Drives the
 * real module in a vm sandbox with SYNTHETIC leads and expenses (public repo).
 *
 * Run: node tests/receipt-health-2026-10-18.test.js
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
const win = {}; win.window = win;
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/receipt-health.js'), 'utf8'), win);
const H = win.NBDReceiptHealth;

console.log('\n1. what counts as UNSORTED');
ok('unsorted and suggested count', H.isUnsorted({ reviewState: 'unsorted' }) && H.isUnsorted({ reviewState: 'suggested' }));
ok('assigned, overhead and deleted do not', !H.isUnsorted({ reviewState: 'assigned' }) && !H.isUnsorted({ reviewState: 'overhead' }) && !H.isUnsorted({ reviewState: 'unsorted', deleted: true }));
ok('an older store import with no job and no state counts', H.isUnsorted({ source: 'import_homedepot', costType: 'direct', leadId: null }) && H.isUnsorted({ source: 'import_lowes', costType: 'direct' }));
ok('a hand-entered expense with no job does not', !H.isUnsorted({ source: 'manual', costType: 'direct', leadId: null }));
ok('an older import that has a job does not', !H.isUnsorted({ source: 'import_homedepot', costType: 'direct', leadId: 'L1' }));

console.log('\n2. finished jobs with no costs logged');
const LEADS = [
  { id: 'w1', stage: 'closed', firstName: 'Won', lastName: 'NoCost', customerId: 'NBD-0001' },
  { id: 'w2', stage: 'install_complete', firstName: 'Won', lastName: 'HasCost', customerId: 'NBD-0002' },
  { id: 'w3', stage: 'closed', firstName: 'Won', lastName: 'OverheadOnly', customerId: 'NBD-0003' },
  { id: 'w4', stage: 'closed', firstName: 'Won', lastName: 'Deleted', customerId: 'NBD-0004', deleted: true },
  { id: 'a1', stage: 'contract_signed', firstName: 'Active', lastName: 'One', customerId: 'NBD-0010' },
  { id: 'a2', stage: 'install_in_progress', firstName: 'Active', lastName: 'Two', customerId: 'NBD-0011' },
  { id: 'a3', stage: 'contract_signed', firstName: 'Active', lastName: 'NoNumber' },
  { id: 'n1', stage: 'new', firstName: 'Brand', lastName: 'New', customerId: 'NBD-0020' },
  { id: 'x1', stage: 'lost', firstName: 'Lost', lastName: 'One', customerId: 'NBD-0021' },
];
const EXP = [
  { id: 'e1', leadId: 'w2', costType: 'direct', amountCents: 5000, taxCents: 0 },
  { id: 'e2', leadId: 'w3', costType: 'overhead', amountCents: 9999, taxCents: 0 },
  { id: 'e3', leadId: 'a1', costType: 'direct', amountCents: 100, taxCents: 0 },
];
const miss = H.costsMissing(LEADS, EXP).map((l) => l.id).sort();
ok('a finished job with no direct cost is flagged', miss.indexOf('w1') !== -1);
ok('a finished job WITH a direct cost is not', miss.indexOf('w2') === -1);
ok('an overhead-only expense is not a job cost, so the job is still flagged', miss.indexOf('w3') !== -1);
ok('deleted, active, new and lost jobs are never flagged', ['w4', 'a1', 'a2', 'n1', 'x1'].every((id) => miss.indexOf(id) === -1));
ok('a deleted expense or a zero-dollar one does not count as a cost', H.costsMissing([LEADS[0]], [{ leadId: 'w1', costType: 'direct', amountCents: 0, taxCents: 0 }, { leadId: 'w1', costType: 'direct', amountCents: 500, deleted: true }]).length === 1);

console.log('\n3. jobs in progress + the panel');
const act = H.activeJobs(LEADS).map((l) => l.id).sort();
ok('in-progress jobs with a customer number are listed', act.join() === 'a1,a2', act.join());
const html = H.panelHtml([{ reviewState: 'unsorted' }].concat(EXP), LEADS);
ok('the panel shows the unsorted count, the missing-costs count and a copy button per active job',
  /UNSORTED/.test(html) && /COSTS MISSING/.test(html) && /<b>2<\/b> finished jobs/.test(html) && (html.match(/data-rh-copy=/g) || []).length === 2);
ok('everything in order shows nothing at all', H.panelHtml([{ reviewState: 'assigned' }, { leadId: 'w1', costType: 'direct', amountCents: 100 }], [LEADS[0]]) === '');
ok('names are escaped', !/<script/.test(H.panelHtml([], [{ id: 'z', stage: 'closed', firstName: '<script>', lastName: 'x' }])));
ok('no inline style attributes (the reskin ratchet)', !/style="/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
