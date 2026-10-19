/**
 * tests/sub-payments-2026-10-19.test.js
 *
 * The Sub payments sorter (docs/pro/js/sub-payments-logic.js + sub-payments.js).
 * Two flags, like the receipt sorter: a JOB with no sub cost, a PAYMENT with no
 * job. Drives the REAL modules with SYNTHETIC names and amounts (public repo).
 * Every check has a positive and a negative control so it can fail.
 *
 * Run: node tests/sub-payments-2026-10-19.test.js
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
// Line-based on purpose (a block-comment regex is fooled by "image/*" in a string).
const stripComments = (s) => s.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const L = require(path.join(ROOT, 'docs/pro/js/sub-payments-logic.js'));
const day = (y, m, d) => new Date(y, m - 1, d);
let seq = 0;
const pay = (o) => Object.assign({ id: 'p' + (++seq), category: 'subcontractor', costType: 'direct', source: 'cash_payout', supplier: 'CA Roofing', amountCents: 100000, taxCents: 0, paymentMethod: 'check', date: day(2026, 10, 3), leadId: null, userId: 'u1' }, o || {});

console.log('\n— payee names —');
ok('"CA Roofing" and "CA Roofing (Alex)" share a key', L.payeeKey('CA Roofing') === L.payeeKey('CA Roofing (Alex)'));
ok('dots, case, LLC and spacing do not matter', L.payeeKey('C.A.  Roofing, LLC') === L.payeeKey('ca roofing'));
ok('different companies keep different keys (negative control)', L.payeeKey('CA Roofing') !== L.payeeKey('AB Roofing'));
ok('an empty / null name has an empty key, no crash', L.payeeKey(null) === '' && L.payeeKey('   ') === '');
ok('"ca roofing" looks like "ca roofing alex"', L.similarKeys('ca roofing', 'ca roofing alex'));
ok('"roofing" does NOT look like "abc roofing" (single shared word)', !L.similarKeys('roofing', 'abc roofing'));
ok('"alex" looks like "alex smith" (first word)', L.similarKeys('alex', 'alex smith'));
ok('"alex" does NOT look like "sam alex"', !L.similarKeys('alex', 'sam alex'));
ok('identical keys are not "similar" (they are the same)', !L.similarKeys('ca roofing', 'ca roofing'));

console.log('\n— roster resolution —');
const roster = [{ id: 's1', name: 'CA Roofing', trade: 'Roofing', aliases: [] }, { id: 's2', name: 'Bright Gutters', trade: 'Gutters', aliases: ['BG Gutters'] }];
ok('subId wins', L.resolveSub('whatever', 's2', roster).id === 's2');
ok('"CA Roofing (Alex)" resolves to the roster sub', L.resolveSub('CA Roofing (Alex)', null, roster).id === 's1');
ok('an alias resolves', L.resolveSub('BG Gutters', null, roster).id === 's2');
ok('an unknown name resolves to null', L.resolveSub('Zed Siding', null, roster) === null);
ok('a SIMILAR but not exact name is NOT auto-resolved', L.resolveSub('CA Roofing Alex', null, roster) === null);
ok('group key: roster sub groups both spellings together',
  L.groupKeyFor({ supplier: 'CA Roofing', subId: null }, roster) === L.groupKeyFor({ supplier: 'CA Roofing (Alex)' }, roster));
ok('group key: unknown names group by key', L.groupKeyFor({ supplier: 'Zed Siding LLC' }, roster) === L.groupKeyFor({ supplier: 'zed siding' }, roster));

console.log('\n— merge suggestions (never a merge) —');
const rosterDup = [{ id: 'a', name: 'CA Roofing', aliases: [] }, { id: 'b', name: 'CA Roofing (Alex)', aliases: [] }, { id: 'c', name: 'Zed Siding', aliases: [] }];
const sug1 = L.mergeSuggestions(rosterDup, []);
ok('two roster subs with one key -> one roster_duplicate suggestion', sug1.length === 1 && sug1[0].type === 'roster_duplicate' && sug1[0].exact === true);
ok('different roster subs -> no suggestion (negative control)', L.mergeSuggestions(roster, []).length === 0);
const rosterBefore = JSON.stringify(roster);
const sug2 = L.mergeSuggestions(roster, [pay({ supplier: 'CA Roofing Alex' }), pay({ supplier: 'CA Roofing Alex' }), pay({ supplier: 'CA Roofing' })]);
ok('"CA Roofing Alex" payments -> alias suggestion to CA Roofing, count 2', sug2.length === 1 && sug2[0].type === 'alias' && sug2[0].subId === 's1' && sug2[0].count === 2);
ok('an exact roster match makes no suggestion (already one sub)', L.mergeSuggestions(roster, [pay({ supplier: 'CA Roofing (Alex)' })]).length === 0);
ok('suggesting never changes the roster', JSON.stringify(roster) === rosterBefore);
const sug3 = L.mergeSuggestions([], [pay({ supplier: 'Zed Siding' }), pay({ supplier: 'Zed Siding LLC' }), pay({ supplier: 'Other Co' })]);
ok('two spellings off the roster -> unrostered_group', sug3.length === 1 && sug3[0].type === 'unrostered_group' && sug3[0].names.length === 2);

console.log('\n— which payments are in play —');
ok('a cash payout with no job needs a job', L.needsJob(pay()));
ok('with a leadId it does not', !L.needsJob(pay({ leadId: 'L1' })));
ok('with only a jobId it does not', !L.needsJob(pay({ jobId: 'J1' })));
ok('voided does not', !L.needsJob(pay({ deleted: true })));
ok('answered "Not a job cost" does not (remembered)', !L.needsJob(pay({ notJobCost: true, costType: 'overhead' })));
ok('direct + notJobCost:true (hand-edited) is not queued either', !L.needsJob(pay({ notJobCost: true })));
ok('a materials expense is not a sub payment', !L.needsJob(pay({ category: 'materials' })));
ok('a $0 row is ignored', !L.needsJob(pay({ amountCents: 0 })));
ok('overhead-typed sub row without the flag is not in the queue', !L.needsJob(pay({ costType: 'overhead' })));
ok('a check entered via the sorter with no job needs a job', L.needsJob(pay({ source: 'sub_payments', paymentMethod: 'check' })));
ok('proof: none', !L.hasProof(pay()) && L.proofCount(pay()) === 0);
ok('proof: proofPaths counts', L.proofCount(pay({ proofPaths: ['receipts/u1/sub-proofs/1_a.jpg', 'receipts/u1/sub-proofs/2_b.pdf'] })) === 2);
ok('proof: an attached receipt counts', L.hasProof(pay({ receiptStoragePath: 'receipts/u1/1_r.jpg' })));
ok('proof path: ok shape', L.proofPathOk('receipts/u1/sub-proofs/1_a.jpg'));
ok('proof path: a URL / token link is refused', !L.proofPathOk('https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg?alt=media&token=abc'));
ok('proof path: traversal / other folder refused', !L.proofPathOk('receipts/u1/sub-proofs/../../x') && !L.proofPathOk('photos/u1/sub-proofs/a.jpg'));

console.log('\n— counters —');
const rows = [pay({ id: 'c1' }), pay({ id: 'c2', leadId: 'L1', proofPaths: ['receipts/u1/sub-proofs/1_a.jpg'] }), pay({ id: 'c3', deleted: true }), pay({ id: 'c4', category: 'materials' }), pay({ id: 'c5', amountCents: 5000, notJobCost: true, costType: 'overhead' })];
const C = L.counters(rows, 7);
ok('jobs with no sub cost is passed through', C.jobsNoSub === 7);
ok('payments with no job: 1 ($1,000.00)', C.paymentsNoJob === 1 && C.noJobCents === 100000);
ok('payments with no proof: c1 and c5 (a Not-a-job-cost row is still money paid)', C.paymentsNoProof === 2 && C.noProofCents === 105000);
ok('total counts live sub payments only', C.total === 3);
ok('unknown jobs count stays null (not 0)', L.counters(rows, null).jobsNoSub === null);

console.log('\n— per-sub view —');
const sp = [
  pay({ id: 'a1', supplier: 'CA Roofing', amountCents: 200000, leadId: 'L1', date: day(2026, 9, 10), proofPaths: ['receipts/u1/sub-proofs/1_a.jpg'] }),
  pay({ id: 'a2', supplier: 'CA Roofing (Alex)', amountCents: 334000, leadId: 'L2', date: day(2026, 10, 2) }),
  pay({ id: 'a3', supplier: 'CA Roofing', amountCents: 10000, date: day(2026, 10, 5) }),
  pay({ id: 'a4', supplier: 'Bright Gutters', amountCents: 50000, leadId: 'L1', date: day(2026, 10, 6), proofPaths: ['receipts/u1/sub-proofs/9_z.jpg'] }),
  pay({ id: 'a5', supplier: 'Mystery Man', amountCents: 7500 }),
];
const per = L.perSub(sp, roster);
const ca = per.find((g) => g.subId === 's1');
ok('both CA Roofing spellings are ONE sub', per.filter((g) => g.subId === 's1').length === 1 && ca.count === 3);
ok('CA Roofing total = $5,440.00', ca.totalCents === 544000);
ok('payments without proof: 2 of 3; without a job: 1', ca.noProof === 2 && ca.noJob === 1);
ok('by job splits L1 / L2', ca.byJob.L1.cents === 200000 && ca.byJob.L2.cents === 334000 && !ca.byJob.undefined);
ok('by month: Oct then Sep', ca.byMonth.length === 2 && ca.byMonth[0].key === '2026-10' && ca.byMonth[0].cents === 344000 && ca.byMonth[1].key === '2026-09');
ok('both spellings are listed', ca.spellings.length === 2);
ok('sorted by total paid, biggest first', per[0].subId === 's1');
ok('an unrostered payee still gets a row', per.some((g) => g.subId === null && g.name === 'Mystery Man' && g.totalCents === 7500));
ok('a roster sub with no payments still shows', L.perSub([], roster).length === 2);
ok('voided rows are not in the totals', L.perSub(sp.concat([pay({ supplier: 'CA Roofing', amountCents: 999900, deleted: true })]), roster).find((g) => g.subId === 's1').totalCents === 544000);

console.log('\n— queue B: search / filter / sort —');
const q1 = L.filterPayments(sp, roster, { scope: 'nojob' });
ok('no-job scope: a3 and a5 only', q1.length === 2 && q1.every((e) => !e.leadId));
ok('all scope: five rows', L.filterPayments(sp, roster, { scope: 'all' }).length === 5);
ok('search by payee, case-insensitive', L.filterPayments(sp, roster, { scope: 'all', query: 'bright' }).length === 1);
ok('search by amount', L.filterPayments(sp, roster, { scope: 'all', query: '3340.00' })[0].id === 'a2');
ok('search matches nothing -> empty', L.filterPayments(sp, roster, { scope: 'all', query: 'zzz' }).length === 0);
ok('filter: no proof', L.filterPayments(sp, roster, { scope: 'all', proof: 'none' }).length === 3);
ok('filter by sub group', L.filterPayments(sp, roster, { scope: 'all', sub: 'sub:s1' }).length === 3);
ok('filter by method', L.filterPayments(sp.concat([pay({ paymentMethod: 'zelle' })]), roster, { scope: 'all', method: 'zelle' }).length === 1);
ok('sort: newest first / biggest first', L.filterPayments(sp, roster, { scope: 'all', sort: 'newest' })[0].id === 'a4' && L.filterPayments(sp, roster, { scope: 'all', sort: 'amount' })[0].id === 'a2');

console.log('\n— suggestions: which job? (never assigns) —');
const leads = [
  { id: 'J1', firstName: 'Ann', lastName: 'Sample', scheduledDate: '2026-10-02', scheduledEndDate: '2026-10-04', address: '1 Test St' },
  { id: 'J2', firstName: 'Bob', lastName: 'Sample', scheduledDate: '2026-10-12', address: '2 Test St' },
  { id: 'J3', firstName: 'Cy', lastName: 'Sample', scheduledDate: '2026-08-01', address: '3 Test St' },
  { id: 'J4', firstName: 'Di', lastName: 'Sample', address: '4 Test St' },
  { id: 'J5', firstName: 'Ed', lastName: 'Gone', scheduledDate: '2026-10-03', deleted: true },
  { id: 'J6', firstName: 'Fy', lastName: 'Prospect', scheduledDate: '2026-10-03', isProspect: true },
];
const target = pay({ id: 't1', date: day(2026, 10, 4) });
const s1 = L.suggestJobs(target, leads, { roster, payments: [target], hasSubByLead: {} });
ok('the job whose work window holds the date is first', s1[0].leadId === 'J1' && /work window/.test(s1[0].reasons[0]));
ok('a job two weeks away is not suggested (outside nearDays)', !s1.some((s) => s.leadId === 'J3'));
ok('a job with no date and no history gives no signal -> not suggested', !s1.some((s) => s.leadId === 'J4'));
ok('deleted and prospect jobs are never suggested', !s1.some((s) => s.leadId === 'J5' || s.leadId === 'J6'));
ok('a near-miss job is suggested with a lower score', s1.some((s) => s.leadId === 'J2') && s1.find((s) => s.leadId === 'J2').score < s1[0].score);
const s2 = L.suggestJobs(target, leads, { roster, payments: [target], hasSubByLead: { J1: true } });
ok('a job that already has a sub cost scores lower than one that has none', s1[0].score - s2[0].score === 15);
const past = pay({ id: 'pp', supplier: 'CA Roofing (Alex)', leadId: 'J3', date: day(2026, 8, 3) });
const s3 = L.suggestJobs(target, leads, { roster, payments: [target, past], hasSubByLead: {} });
ok('the same sub\'s past job is suggested even far from the date', s3.some((s) => s.leadId === 'J3' && /Same sub/.test(s.reasons.join(' '))));
ok('another sub\'s past job does not count (negative control)', !L.suggestJobs(target, leads, { roster, payments: [target, pay({ supplier: 'Bright Gutters', leadId: 'J3' })], hasSubByLead: {} }).some((s) => s.leadId === 'J3'));
ok('a payment with no date still uses the sub\'s past jobs', L.suggestJobs(pay({ date: null }), leads, { roster, payments: [past], hasSubByLead: {} }).map((s) => s.leadId).join() === 'J3');
const before = JSON.stringify(target);
L.suggestJobs(target, leads, { roster, payments: [target], hasSubByLead: {} });
ok('suggesting never writes a leadId onto the payment', JSON.stringify(target) === before && !target.leadId);
ok('at most five suggestions', L.suggestJobs(target, Array.from({ length: 12 }, (_, i) => ({ id: 'X' + i, firstName: 'N' + i, scheduledDate: '2026-10-04' })), { roster, payments: [], hasSubByLead: {} }).length === 5);
ok('job search by customer / address / id', L.searchJobs(leads, 'bob', 8)[0].leadId === 'J2' && L.searchJobs(leads, '3 test', 8)[0].leadId === 'J3' && L.searchJobs(leads, '', 8).length === 0);
ok('job search skips deleted', L.searchJobs(leads, 'gone', 8).length === 0);

console.log('\n— the payment document —');
const ctx = { roster, jobIdFor: (id) => (id === 'J1' ? 'job-1' : null) };
const good = L.buildPayment({ who: 'CA Roofing (Alex)', amount: '$1,234.50', method: 'check', date: '2026-10-03', note: 'tear-off labor', leadId: 'J1', proofPaths: ['receipts/u1/sub-proofs/1_a.jpg', 'https://x/y?token=1'] }, ctx).fields;
ok('cents are an integer: $1,234.50 -> 123450', good.amountCents === 123450 && Number.isInteger(good.amountCents));
ok('category subcontractor, costType direct, auditKind sub', good.category === 'subcontractor' && good.costType === 'direct' && good.auditKind === 'sub');
ok('the roster spelling and subId are stored', good.supplier === 'CA Roofing' && good.subId === 's1');
ok('job id comes from the lead', good.leadId === 'J1' && good.jobId === 'job-1');
ok('local calendar date (no UTC shift)', good.date.getFullYear() === 2026 && good.date.getMonth() === 9 && good.date.getDate() === 3);
ok('a URL / token link is dropped from the proofs', good.proofPaths.length === 1 && good.proofPaths[0] === 'receipts/u1/sub-proofs/1_a.jpg');
ok('the note is kept', good.note === 'tear-off labor');
ok('no job is fine (waits in the queue)', L.buildPayment({ who: 'Zed', amount: '10', method: 'cash', date: '2026-10-03' }, ctx).fields.leadId === null);
ok('error: nobody paid', !!L.buildPayment({ amount: '10', method: 'cash' }, ctx).error);
ok('error: $0 / junk amount', !!L.buildPayment({ who: 'Z', amount: '0', method: 'cash' }, ctx).error && !!L.buildPayment({ who: 'Z', amount: 'abc', method: 'cash' }, ctx).error);
ok('error: amount too large', !!L.buildPayment({ who: 'Z', amount: '1000000', method: 'cash' }, ctx).error);
ok('error: no method picked', !!L.buildPayment({ who: 'Z', amount: '10' }, ctx).error);
ok('error: bad method', !!L.buildPayment({ who: 'Z', amount: '10', method: 'bitcoin' }, ctx).error);
ok('error: bad date', !!L.buildPayment({ who: 'Z', amount: '10', method: 'cash', date: '2026-13-45x' }, ctx).error);
ok('proofs are capped', L.buildPayment({ who: 'Z', amount: '10', method: 'cash', proofPaths: Array.from({ length: 9 }, (_, i) => 'receipts/u1/sub-proofs/' + i + '.jpg') }, ctx).fields.proofPaths.length === L.CONFIG.maxProofs);

console.log('\n— patches (assign / not a job cost / proof / void) —');
const row = pay({ id: 'r1', editLog: [] });
const ap = L.assignPatch(row, leads[0], 'job-1', 'u1', 111);
ok('assign: leadId, jobId, editLog entry', ap.leadId === 'J1' && ap.jobId === 'job-1' && ap.editLog.length === 1 && ap.editLog[0].what === 'assign-job' && ap.editLog[0].at === 111);
const op = L.overheadPatch(row, 'u1', 5);
ok('not a job cost: overhead + remembered flag', op.costType === 'overhead' && op.notJobCost === true && op.editLog[0].what === 'not-a-job-cost');
ok('the row then leaves the queue (remembered)', !L.needsJob(Object.assign({}, row, op)));
const up = L.undoOverheadPatch(Object.assign({}, row, op), 'u1', 6);
ok('undo puts it back in the queue', L.needsJob(Object.assign({}, row, op, up)) && up.editLog.length === 2);
const pp = L.proofPatch(row, ['receipts/u1/sub-proofs/1_a.jpg', 'http://bad'], 'u1', 7);
ok('proof: only valid paths are added', pp.proofPaths.length === 1 && pp.editLog[0].what === 'add-proof');
ok('proof: capped at the max', L.proofPatch({ proofPaths: Array.from({ length: 6 }, (_, i) => 'receipts/u1/sub-proofs/' + i + '.jpg'), editLog: [] }, ['receipts/u1/sub-proofs/new.jpg'], 'u1', 1).proofPaths.length === L.CONFIG.maxProofs);
ok('void needs a note', !!L.voidPatch(row, '  ', 'u1', 1).error && !L.voidPatch(row, '', 'u1', 1).patch);
const vp = L.voidPatch(row, 'entered twice', 'u1', 8).patch;
ok('void keeps the row: deleted:true + note in the log (no hard delete)', vp.deleted === true && vp.editLog[0].note === 'entered twice');
let log = [];
for (let i = 0; i < 40; i++) log = L.appendLog(log, { i });
ok('editLog never exceeds 25 and keeps the newest', log.length === 25 && log[24].i === 39);

console.log('\n— the UI module (flag, role, counters) —');
function sandbox(extra) {
  const win = Object.assign({ console }, extra || {});
  win.window = win;
  vm.createContext(win);
  ['docs/pro/js/sub-payments-logic.js', 'docs/pro/js/sub-payments.js'].forEach((f) => vm.runInContext(read(f), win, { filename: f }));
  return win;
}
const flags = (on) => ({ enabled: (n) => on && n === 'subPaymentsSorter' });
const expenses = [pay({ id: 'e1' }), pay({ id: 'e2', leadId: 'L1', proofPaths: ['receipts/u1/sub-proofs/1_a.jpg'] }), pay({ id: 'e3', amountCents: 5000 })];
const off = sandbox({ NBDFlags: flags(false), _user: { uid: 'u1' }, _userClaims: {} });
ok('flag off: no panel, no button', off.NBDSubPayments.panelHtml(expenses) === '' && off.NBDSubPayments.buttonHtml() === '');
const noFlags = sandbox({ _user: { uid: 'u1' }, _userClaims: {} });
ok('flags not loaded: nothing rendered', noFlags.NBDSubPayments.panelHtml(expenses) === '');
const owner = sandbox({ NBDFlags: flags(true), _user: { uid: 'u1' }, _userClaims: {} });
const ph = owner.NBDSubPayments.panelHtml(expenses);
ok('flag on: the three counters render', /jobs with no sub cost/.test(ph) && /payments with no job/.test(ph) && /payments with no proof/.test(ph));
ok('counter values: 2 with no job, 2 with no proof', />2<\/b><span>payments with no job/.test(ph) && />2<\/b><span>payments with no proof/.test(ph));
ok('jobs count is a dash until known (never a fake 0)', />-<\/b><span>jobs with no sub cost/.test(ph));
ok('owner gets the open button', owner.NBDSubPayments.buttonHtml().indexOf('data-sp-action="open"') !== -1);
const viewer = sandbox({ NBDFlags: flags(true), _user: { uid: 'u2' }, _userClaims: { role: 'viewer', companyId: 'co' } });
const vh = viewer.NBDSubPayments.panelHtml(expenses);
ok('viewer: sees the payment counters, not the jobs tile (read only)', /payments with no job/.test(vh) && !/jobs with no sub cost/.test(vh) && viewer.NBDSubPayments.canWrite() === false);
const rep = sandbox({ NBDFlags: flags(true), _user: { uid: 'u3' }, _userClaims: { role: 'sales_rep', companyId: 'co' } });
ok('sales rep: nothing rendered', rep.NBDSubPayments.panelHtml(expenses) === '' && rep.NBDSubPayments.buttonHtml() === '');
ok('a voided row is not counted in the panel', (() => { const h = owner.NBDSubPayments.panelHtml(expenses.concat([pay({ id: 'e9', deleted: true })])); return />2<\/b><span>payments with no job/.test(h); })());

console.log('\n— source wiring (comments stripped) —');
const ui = stripComments(read('docs/pro/js/sub-payments.js'));
const lg = stripComments(read('docs/pro/js/sub-payments-logic.js'));
const css = read('docs/pro/css/sub-payments.css');
ok('UI reads the subPaymentsSorter flag', /FLAG = 'subPaymentsSorter'/.test(ui));
ok('no inline handlers or inline scripts in generated markup', !/\son[a-z]+=/.test(ui) && !/<script/i.test(ui));
ok('proof photos go under receipts/{uid}/sub-proofs/ (existing receipt rules)', /'receipts\/' \+ me \+ '\/sub-proofs\/'/.test(ui));
const ppSrc = stripComments(read('docs/pro/js/proof-photos.js'));
ok('the UI uses the SHARED proof component, not its own copy', /NBDProofPhotos/.test(ui) && !/toBlob\(/.test(ui));
ok('photos are re-encoded through a canvas (EXIF dropped) in the shared component', /toBlob\(/.test(ppSrc) && /image\/jpeg/.test(ppSrc));
ok('only validated paths are ever opened (UI list + shared opener)', /proofPathOk\(p\)/.test(ui) && /async function urlFor[\s\S]*?pathOk\(path\)/.test(ppSrc));
ok('no download URL is stored on a doc', !/downloadURL\s*[:=]/i.test(ui.replace(/getDownloadURL/g, '')) && !/token=/.test(ui + lg));
ok('writes go to /expenses, no new collection', /collection\(w\.db, 'expenses'\)/.test(ui) && !/collection\(w\.db, 'subPayments/.test(ui));
ok('no hard delete anywhere', !/deleteDoc/.test(ui));
ok('void sets deleted + deletedAt and needs a note', /deletedAt: w\.serverTimestamp\(\)/.test(ui) && /Say why you are voiding it/.test(lg));
const updateBody = (ui.match(/async function updateRow\([^)]*\) \{[\s\S]*?\n  \}\n/) || [''])[0];
ok('own rows only: the shared update path refuses another writer\'s row BEFORE it writes', updateBody.length > 0 && updateBody.indexOf('row.userId !== uid()') !== -1 && updateBody.indexOf('row.userId !== uid()') < updateBody.indexOf('await w.updateDoc('));
ok('viewer cannot write (role gate)', /WRITE_ROLES = \['', 'admin', 'company_admin', 'manager'\]/.test(ui));
ok('crews are never called employees (UI, logic, CSS)', !/employee|payroll|in-house|in house|W-?2/i.test(ui + lg + css));
ok('no old brand oranges', !/E8720C|F08030/i.test(css));
ok('money is cents: no floating dollars written', /amountCents: cents/.test(lg) && !/amount:\s*parseFloat/.test(lg));
ok('auditor exposes the Direction A queue', /noSubQueue/.test(read('docs/pro/js/job-cost-audit.js')) && /'no_sub'/.test(read('docs/pro/js/job-cost-audit.js')));
ok('auditor sheet gets the one-thumb "Log a sub payment" button only when the sorter is on', /NBDSubPayments\.enabled\(\)/.test(read('docs/pro/js/job-cost-audit.js')));
ok('expenses.js mounts the button and the panel', /NBDSubPayments\.buttonHtml\(\)/.test(read('docs/pro/js/expenses.js')) && /NBDSubPayments\.panelHtml\(_expenses\)/.test(read('docs/pro/js/expenses.js')));
ok('script-loader loads css + logic + ui in the expenses bundle', /sub-payments\.css/.test(read('docs/pro/js/script-loader.js')) && /sub-payments-logic\.js/.test(read('docs/pro/js/script-loader.js')) && /js\/sub-payments\.js/.test(read('docs/pro/js/script-loader.js')));
ok('rules bound proofPaths and type notJobCost', /proofPathsOk\(d\.proofPaths\)/.test(read('firestore.rules')) && /d\.notJobCost is bool/.test(read('firestore.rules')));
ok('the flag is documented as default off (no flag write in the repo)', !/feature_flags[^\n]*subPaymentsSorter\s*:\s*true/.test(read('docs/pro/js/sub-payments.js')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
