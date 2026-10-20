/**
 * tests/payment-backfill-2026-10-19.test.js
 *
 * The Customer payment backfill (docs/pro/js/payment-backfill-logic.js +
 * payment-backfill.js + proof-photos.js) and the server safety it depends on
 * (functions/quiet-backfill.js, money-paper.js, the review-ask and doc-draft
 * eligibility rules). SYNTHETIC names, addresses and amounts only (public repo).
 * Every check has a positive and a negative control so it can fail.
 *
 * Run: node tests/payment-backfill-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); failed++; }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const B = require(path.join(ROOT, 'docs/pro/js/payment-backfill-logic.js'));
const PP = require(path.join(ROOT, 'docs/pro/js/proof-photos.js'));
const Q = require(path.join(ROOT, 'functions/quiet-backfill.js'));
const TODAY = new Date(2026, 9, 19);

console.log('\n— reading the paste —');
ok('tab-separated rows', B.splitTable('a\tb\tc\n1\t2\t3').length === 2 && B.splitTable('a\tb\tc\n1\t2\t3')[1][2] === '3');
ok('comma-separated rows', B.splitTable('a,b,c\n1,2,3')[1].join('|') === '1|2|3');
ok('a quoted comma stays in one cell', B.splitTable('"Sample, Ann",12 Oak St,5')[0][0] === 'Sample, Ann' && B.splitTable('"Sample, Ann",12 Oak St,5')[0].length === 3);
ok('a doubled quote and a quoted newline are kept', B.splitTable('"a ""b"" c","x\ny"')[0].join('|') === 'a "b" c|x\ny');
ok('blank lines are dropped, CRLF is fine', B.splitTable('a,b\r\n\r\nc,d\r\n').length === 2);
const withHeader = B.parse('Customer Name,Address,Date,Amount,Method,Check #,Memo\nAnn Sample,12 Oak St,2026-10-03,1200,Check,1042,tear-off', TODAY);
ok('a header row is recognised by its names (and not counted as a payment)', withHeader.header === true && withHeader.rows.length === 1 && withHeader.rows[0].input.ref === '1042' && withHeader.rows[0].input.payer === 'Ann Sample');
const noHeader = B.parse('Ann Sample\t12 Oak St\t513-555-0101\t10/3/2026\t$1,200.00\tzelle\t\ttear-off\tcash\tYelp', TODAY);
ok('with no header the columns are payer, address, phone, date, amount, method, check no., memo, job type, source', noHeader.header === false && noHeader.rows[0].v.cents === 120000 && noHeader.rows[0].v.method === 'zelle' && noHeader.rows[0].v.jobType === 'cash' && noHeader.rows[0].v.sourceHint === 'Yelp' && noHeader.rows[0].v.phoneDigits === '5135550101' && noHeader.rows[0].errors.length === 0, noHeader.rows[0]);
ok('an empty paste is an error, not zero rows', !!B.parse('   \n  ', TODAY).error);
ok('more than the row cap is cut and said so', (() => { const t = Array.from({ length: 305 }, (_, i) => 'N' + i + ',1 A St,2026-10-01,10,cash').join('\n'); const p = B.parse(t, TODAY); return p.rows.length === 300 && p.truncated === true; })());

console.log('\n— one row: dates, money, method, names —');
ok('date: ISO / US / short year / month name', ['2026-10-03', '10/3/2026', '10/3/26', '10-3-2026', 'Oct 3, 2026', 'October 3 2026'].every((d) => B.parseDate(d) && B.parseDate(d).ymd === '2026-10-03'));
ok('date: rejects not-a-date, month 13, Feb 30', !B.parseDate('soon') && !B.parseDate('13/1/2026') && !B.parseDate('2/30/2026'));
ok('amount: dollars with $ and commas to cents', B.parseCents('$5,340.00') === 534000 && B.parseCents('12.5') === 1250 && B.parseCents('0.07') === 7);
ok('amount: junk, negative, three decimals -> 0', B.parseCents('abc') === 0 && B.parseCents('-5') === 0 && B.parseCents('1.234') === 0);
ok('method words', B.parseMethod('Check') === 'check' && B.parseMethod('CHK') === 'check' && B.parseMethod('Zelle') === 'zelle' && B.parseMethod('cash') === 'cash' && B.parseMethod('ACH') === 'other' && B.parseMethod('???') === '');
ok('job type words', B.parseJobType('Ins') === 'insurance' && B.parseJobType('retail') === 'cash' && B.parseJobType('repair') === 'service' && B.parseJobType('') === '');
const bad = B.validate({ n: 1, input: { payer: '', address: '', phone: '55', date: '12/31/2099', amount: '0', method: 'trade', ref: '', memo: '', jobType: 'roofing', source: '' } }, TODAY);
ok('every bad field gets its own plain error', bad.errors.length === 7, bad.errors);
ok('a future date is refused', B.validate({ n: 1, input: { payer: 'A B', address: '1 A St', date: '2026-12-25', amount: '5', method: 'cash' } }, TODAY).errors.some((e) => /future/.test(e)));
ok('a clean row has no errors', B.validate({ n: 1, input: { payer: 'Ann Sample', address: '1 A St', date: '2026-10-03', amount: '5', method: 'cash' } }, TODAY).errors.length === 0);
ok('"Sample, Ann" is Ann Sample', (() => { const r = B.validate({ n: 1, input: { payer: 'Sample, Ann', address: '1 A St', date: '2026-10-03', amount: '5', method: 'cash' } }, TODAY); return r.v.first === 'Ann' && r.v.last === 'Sample'; })());

console.log('\n— names and addresses —');
ok('name order and case do not matter', B.nameScore('Sample, Ann', 'ann sample') === 1);
ok('an initial matches a name', B.nameScore('A Sample', 'Ann Sample') === 1);
ok('different people do not match', B.nameScore('Ann Sample', 'Bob Other') === 0);
ok('half a name is a loose match only', B.nameScore('Ann Sample', 'Ann Other') === 0.5);
ok('address: St = Street, case, apt, city tail', B.sameAddress('12 Oak St, Town', '12 oak street APT 2'));
ok('address: another house number is not the same', !B.sameAddress('12 Oak St', '14 Oak St'));
ok('address: another street is not the same', !B.sameAddress('12 Oak St', '12 Elm St'));
ok('address: no house number never matches', !B.sameAddress('Oak St', 'Oak St'));

console.log('\n— matching a customer (never a merge) —');
const leads = [
  { id: 'L1', firstName: 'Ann', lastName: 'Sample', address: '12 Oak Street, Town', phone: '(513) 555-0101' },
  { id: 'L2', firstName: 'Zed', lastName: 'Other', address: '99 Pine Rd', phone: '' },
  { id: 'L3', firstName: 'Ann', lastName: 'Sample', address: '5 Far Ave', deleted: true },
  { id: 'L4', firstName: 'Cy', lastName: 'Phone', address: '7 Q St', phone: '513-555-0199' },
];
const mk = (o) => B.validate({ n: 1, input: Object.assign({ payer: 'Nobody Known', address: '1 Z Way', date: '2026-10-03', amount: '100', method: 'check' }, o || {}) }, TODAY).v;
ok('same address matches', B.matchCustomers(mk({ payer: 'Someone Else', address: '12 Oak St' }), leads)[0].leadId === 'L1');
ok('same phone matches (any formatting)', B.matchCustomers(mk({ phone: '5135550199' }), leads)[0].leadId === 'L4');
ok('same name alone matches', B.matchCustomers(mk({ payer: 'Zed Other' }), leads)[0].leadId === 'L2');
ok('nobody matches an unrelated row (negative control)', B.matchCustomers(mk(), leads).length === 0);
ok('a deleted customer is never offered', !B.matchCustomers(mk({ payer: 'Ann Sample', address: '5 Far Ave' }), leads).some((m) => m.leadId === 'L3'));
ok('the best match is first and reasons are listed', (() => { const m = B.matchCustomers(mk({ payer: 'Ann Sample', address: '12 Oak St', phone: '513-555-0101' }), leads); return m[0].leadId === 'L1' && m[0].reasons.length === 3; })());
ok('a half-name alone does not match', B.matchCustomers(mk({ payer: 'Ann Nobody' }), leads).length === 0);

console.log('\n— payment key and duplicates —');
const v1 = mk({ payer: 'Ann Sample', address: '12 Oak Street', date: '10/3/2026', amount: '$5,340', ref: '#1042' });
const v2 = mk({ payer: 'sample, ann', address: '12 OAK ST, Town', date: '2026-10-03', amount: '5340.00', ref: '1042' });
ok('the same payment typed two ways has one key', B.paymentKey(v1) === B.paymentKey(v2));
ok('another amount / date / check no. changes the key', ['amount', 'date', 'ref'].every((f) => { const o = { payer: 'Ann Sample', address: '12 Oak Street', date: '10/3/2026', amount: '$5,340', ref: '#1042' }; const o2 = Object.assign({}, o, { amount: { amount: '5341' }, date: { date: '10/4/2026' }, ref: { ref: '1043' } }[f]); return B.paymentKey(mk(o2)) !== B.paymentKey(v1); }));
ok('the key is wide (about 85 bits) and has no collisions over 20000 distinct payments', (() => { const seen = new Set(); for (let i = 0; i < 20000; i++) seen.add(B.paymentKey(mk({ payer: 'Name ' + (i % 997), address: (i % 413) + ' Oak St', date: '2026-10-0' + (1 + (i % 9)), amount: String(10 + i), ref: String(i % 31) }))); return seen.size === 20000 && B.paymentKey(v1).length >= 14; })());
ok('the payment id is bf_ + key', B.paymentIdFor(v1) === 'bf_' + B.paymentKey(v1));
const inv = (o) => Object.assign({ id: 'I1', leadId: 'L1', status: 'paid', payments: [{ amount: 5340, at: new Date(2026, 9, 5, 12), method: 'check', reference: '1042', paymentId: 'x' }] }, o || {});
const idx = B.paymentsIndex([inv()], leads);
ok('the index lists each payment with cents, day, name', idx.length === 1 && idx[0].cents === 534000 && idx[0].ymd === '2026-10-05' && idx[0].name === 'Ann Sample');
ok('voided invoices are not in the index', B.paymentsIndex([inv({ deleted: true })], leads).length === 0);
ok('exact: the same payment id is "already"', B.findDuplicates(v1, [{ paymentId: B.paymentIdFor(v1), cents: 1, day: 0 }], []).level === 'already');
const matchesAnn = B.matchCustomers(v1, leads);
ok('possible: same amount, 2 days apart, same customer', B.findDuplicates(v1, idx, matchesAnn).level === 'possible');
ok('boundary: 7 days apart is possible, 8 is not', (() => {
  const mkAt = (day) => B.paymentsIndex([inv({ payments: [{ amount: 5340, at: new Date(2026, 9, day, 12), method: 'cash' }] })], leads);
  return B.findDuplicates(v1, mkAt(10), matchesAnn).level === 'possible' && B.findDuplicates(v1, mkAt(11), matchesAnn).level === 'none';
})());
ok('a different amount is never a duplicate', B.findDuplicates(v1, B.paymentsIndex([inv({ payments: [{ amount: 5339.99, at: new Date(2026, 9, 3, 12), method: 'check' }] })], leads), matchesAnn).level === 'none');
ok('same amount + date, an unrelated customer: not a duplicate', B.findDuplicates(v1, B.paymentsIndex([inv({ leadId: 'L2', payments: [{ amount: 5340, at: new Date(2026, 9, 3, 12), method: 'cash' }] })], leads), []).level === 'none');
ok('the same check number and amount is a duplicate even weeks apart', B.findDuplicates(v1, B.paymentsIndex([inv({ leadId: 'L2', payments: [{ amount: 5340, at: new Date(2026, 8, 1, 12), method: 'check', reference: '1042' }] })], leads), []).level === 'possible');

console.log('\n— review: the five statuses —');
const HDR = 'Payer\tAddress\tDate\tAmount\tMethod\tCheck #\n';
const paste = [
  'Payer\tAddress\tDate\tAmount\tMethod\tCheck #',
  'Zed Fresh\t3 New Ln\t2026-10-01\t100\tcash',            // 1 new
  'Ann Sample\t12 Oak St\t2026-10-03\t5340\tcheck\t1042',    // 2 duplicate of the invoice below
  'Ann Sample\t12 Oak St\t2026-09-01\t900\tzelle',           // 3 matches existing customer
  'Zed Fresh\t3 New Ln\t2026-10-01\t100\tcash',              // 4 same as row 1 within the paste
  'Bad\t\tx\t0\t?',                                          // 5 error
].join('\n');
const parsed = B.parse(paste, TODAY);
const parsedBefore = JSON.stringify(parsed.rows);
const rv = B.review(parsed.rows, leads, [inv()]);
ok('statuses: new, dup, match, dup(in paste), error', rv.map((r) => r.status).join() === 'new,dup,match,dup,error', rv.map((r) => r.status));
ok('the in-paste repeat says so', rv[3].dup.inPaste === true);
ok('a match carries the customer to confirm and chooses nothing', rv[2].matches[0].leadId === 'L1' && rv[2].pick === undefined && rv[2].choice === undefined);
const already = B.review(B.parse(HDR + 'Ann Sample\t12 Oak St\t2026-10-03\t5340\tcheck\t1042', TODAY).rows, leads, [inv({ id: 'I9', backfillKey: B.paymentKey(v1), payments: [{ amount: 5340, at: new Date(2026, 9, 3, 12), method: 'check', reference: '1042', paymentId: B.paymentIdFor(v1) }] })]);
ok('a re-paste of an imported payment is "already imported" (idempotent)', already[0].status === 'already');
const reviewIn = parsedBefore, leadsIn = JSON.stringify(leads), invIn = JSON.stringify([inv()]);
B.review(parsed.rows, leads, [inv()]); B.checkAgainstCrm(parsed.rows, leads, [inv()]);
ok('reviewing and checking never change their inputs', JSON.stringify(parsed.rows) === reviewIn && JSON.stringify(leads) === leadsIn && JSON.stringify([inv()]) === invIn);
const chk = B.checkAgainstCrm(parsed.rows, leads, [inv()]);
ok('Check vs CRM: row 2 is in the CRM, row 1 is not, row 5 has errors', chk[1].inCrm === true && chk[0].inCrm === false && chk[4].errors.length > 0 && chk[1].hits.length === 1);
ok('Check vs CRM: an exact earlier import reads as exact', B.checkAgainstCrm(B.parse(HDR + 'Ann Sample\t12 Oak St\t2026-10-03\t5340\tcheck\t1042', TODAY).rows, leads, [inv({ payments: [{ amount: 5340, at: new Date(2026, 9, 3, 12), method: 'check', reference: '1042', paymentId: B.paymentIdFor(v1) }] })])[0].exact === true);

console.log('\n— two genuine identical payments —');
const twinRows = B.parse(HDR + 'Ann Sample\t12 Oak St\t2026-10-03\t100\tcheck\t7\nAnn Sample\t12 Oak St\t2026-10-03\t100\tcheck\t7', TODAY).rows;
const twin = B.review(twinRows, [], []);
ok('two identical rows get DIFFERENT keys / payment ids (the 2nd ends -2): the ledger dedupe can never drop one', twin[0].key !== twin[1].key && /-2$/.test(twin[1].key) && B.paymentIdOf(twin[0]) !== B.paymentIdOf(twin[1]));
ok('the second is flagged: it needs an explicit "different payment" tap', twin[0].status === 'new' && twin[1].status === 'dup' && twin[1].dup.inPaste === true);
ok('the lead, invoice and payment use the row key', B.invoiceOverrides(twin[1]).backfillKey === twin[1].key && B.paymentDetails(twin[1], []).paymentId === 'bf_' + twin[1].key && B.buildLead(twin[1], {}).backfill.key === twin[1].key);
const twinInv = twin.map((r, i) => ({ id: 'T' + i, leadId: 'LX', backfilled: true, source: 'backfill', payments: [{ amount: 100, at: new Date(2026, 9, 3, 12), method: 'check', reference: '7', paymentId: B.paymentIdOf(r) }] }));
ok('after both are imported a re-paste says "already imported" for BOTH (not for one and a duplicate for the other)', B.review(B.parse(HDR + 'Ann Sample\t12 Oak St\t2026-10-03\t100\tcheck\t7\nAnn Sample\t12 Oak St\t2026-10-03\t100\tcheck\t7', TODAY).rows, [], twinInv).map((r) => r.status).join() === 'already,already');
const IPm = require(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'));
ok('the Record Payment proof picker refuses what the bucket would (gif, avif, Word) with a clear reason, and takes JPEG / PNG / WebP / HEIC / PDF', ['image/gif', 'image/avif', 'application/msword', 'text/plain'].every((t) => !IPm.proofFileCheck({ type: t, size: 10 }).ok && /JPEG/.test(IPm.proofFileCheck({ type: t, size: 10 }).reason)) && ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'].every((t) => IPm.proofFileCheck({ type: t, size: 10 }).ok));
ok('the invoice proof viewer uses the SDK bytes, never a download URL', (() => { const ip = stripComments(read('docs/pro/js/invoice-pipeline.js')); const v = ip.slice(ip.indexOf('async function viewProofUI'), ip.indexOf('async function viewProofUI') + 900); return /getBlob\(/.test(v) && !/getDownloadURL/.test(v); })());
ok('the screen reads the invoice back after markPaid and refuses to say "created" if the payment id is missing', /await IP\(\)\.markPaid\([\s\S]{0,400}if \(!paysNow\.some\(\(p\) => p && p\.paymentId === details\.paymentId\)\) throw new Error/.test(stripComments(read('docs/pro/js/payment-backfill.js'))));
ok('the portal rating card is gated by the shared guard (real handler tests: portal-rating-backfill-2026-10-19)', /canRate: hp\.paidInFull && !isQuietBackfill\(lead\) && !backfillBlocksRating\(lead, tenantInvoices, paidInFullFor\),/.test(stripComments(read('functions/portal.js'))));
ok('the portal Google-review link is withheld from a backfill-only customer', /googleReviewUrl: \(isQuietBackfill\(lead\) \|\| backfillBlocksRating\(/.test(stripComments(read('functions/portal.js'))));

console.log('\n— what one tap writes —');
const row1 = rv[0]; row1.jobType = 'cash';
const lead = B.buildLead(row1, { stageRole: 'won', uid: 'u1', nowMs: Date.UTC(2026, 9, 19, 15) });
ok('lead: finished + quiet: closed, won, completedBackfill.quiet, paymentBackfill, backfill history', lead.stage === 'closed' && lead.stageRole === 'won' && lead.completedBackfill.quiet === true && lead.paymentBackfill === true && lead.stageHistory.some((h) => h.to === 'install_complete' && h.backfill === true), lead);
ok('lead: the form fields: names, address, job type, notes, dollars', lead.firstName === 'Zed' && lead.lastName === 'Fresh' && lead.address === '3 New Ln' && lead.jobType === 'cash' && lead.jobValue === 100 && /Backfilled/.test(lead.notes));
ok('lead: source is Other and NEVER a guess, even when the paste says Yelp', B.buildLead({ v: mk({ payer: 'A B', source: 'Yelp' }), jobType: 'cash' }, {}).source === 'Other' && B.buildLead({ v: mk({ source: 'Thumbtack' }), jobType: 'cash' }, {}).confirmedSource === undefined);
ok('lead: nothing that can reach the customer (no email, rep, schedule, consent, referral)', ['assignedTo', 'scheduledDate', 'scheduledStart', 'tcpaConsent', 'tcpaConsentAt', 'referredBy', 'redeemReferralCode', 'webLead', 'publicLeadKind', 'activeJobId', 'confirmedSource'].every((k) => lead[k] === undefined) && lead.email === '');
ok('lead: finished date is the payment date, at noon', lead.closedAt.getDate() === 1 && lead.closedAt.getMonth() === 9 && lead.closedAt.getHours() === 12 && lead.completedAt.getTime() === lead.closedAt.getTime());
ok('lead: the backfill key is stored so a retry finds it', lead.backfill.key === B.paymentKey(row1.v));
ok('lead: phone digits kept for the inbound-call match, no phone when none', B.buildLead({ v: mk({ phone: '513-555-0101' }), jobType: 'cash' }, {}).phoneDigits === '5135550101' && lead.phoneDigits === '');
const ov = B.invoiceOverrides(Object.assign({}, rv[1], { v: Object.assign({}, rv[1].v, { memo: 'tear-off' }) }));
ok('invoice: source backfill, backfilled, key, line item "Backfilled payment: <memo>"', ov.source === 'backfill' && ov.backfilled === true && !!ov.backfillKey && ov.items[0].description === 'Backfilled payment: tear-off' && ov.items[0].total === 5340);
ok('invoice: with no memo the line is just "Backfilled payment"', B.invoiceOverrides(rv[0]).items[0].description === 'Backfilled payment');
const det = B.paymentDetails(rv[1], [{ path: 'payment-proofs/u1/i1/1_a.jpg', name: 'a.jpg' }, { path: 'payment-proofs/u1/i1/2_b.jpg', name: 'b.jpg' }]);
ok('payment: date at noon, check no., memo, payer, stable id, first proof + the rest', det.at.getHours() === 12 && det.at.getDate() === 3 && det.reference === '1042' && det.payer === 'homeowner' && det.paymentId === B.paymentIdFor(rv[1].v) && det.proofStoragePath === 'payment-proofs/u1/i1/1_a.jpg' && det.proofPaths.length === 1);
ok('payment: no proof keys when there is no photo', (() => { const d = B.paymentDetails(rv[1], []); return d.proofStoragePath === undefined && d.proofPaths === undefined; })());
ok('void needs a note and keeps the row', !!B.voidPatch({}, '  ', 'u1', 1).error && B.voidPatch({}, 'entered twice', 'u1', 1).patch.deleted === true && B.voidPatch({}, 'x', 'u1', 1).patch.editLog[0].what === 'void');
ok('void keeps at most 25 log entries', (() => { const big = { editLog: Array.from({ length: 40 }, (_, i) => ({ i })) }; return B.voidPatch(big, 'x', 'u1', 1).patch.editLog.length === 25; })());

console.log('\n— the shared proof-photo component —');
ok('photo / PDF accepted, anything else refused', PP.check({ type: 'image/jpeg', size: 10 }).ok && PP.check({ type: 'application/pdf', size: 10 }).ok && !PP.check({ type: 'text/html', size: 10 }).ok && !PP.check({ type: 'application/x-msdownload', size: 10 }).ok);
ok('25MB cap', PP.check({ type: 'image/png', size: 25 * 1024 * 1024 }).ok && !PP.check({ type: 'image/png', size: 25 * 1024 * 1024 + 1 }).ok);
ok('only the two private proof folders are ever opened', PP.pathOk('receipts/u1/sub-proofs/1_a.jpg') && PP.pathOk('payment-proofs/u1/inv1/1_a.jpg') && !PP.pathOk('photos/u1/a.jpg') && !PP.pathOk('photos/a.jpg') && !PP.pathOk('payment-proofs/a.jpg') && !PP.pathOk('receipts/u1/a.jpg') && !PP.pathOk('payment-proofs/u1/../x/a.jpg'));
ok('a URL or token link is never a path', !PP.pathOk('https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg?alt=media&token=abc') && !PP.pathOk('payment-proofs/u1/inv1/a.jpg?token=1'));
ok('file names are made safe', PP.safeBase('My Check (front).JPG') === 'My_Check__front_' && PP.safeBase('') === 'proof');

console.log('\n— server safety: a backfilled customer is quiet for good —');
ok('paymentBackfill alone makes a lead quiet', Q.isQuietBackfill({ paymentBackfill: true }) === true);
ok('… even when the history says it finished for real (the old rule would say not quiet)', Q.isQuietBackfill({ paymentBackfill: true, stageHistory: [{ to: 'install_complete', backfill: false }] }) === true);
ok('control: an ordinary finished lead is NOT quiet', Q.isQuietBackfill({ stage: 'install_complete', stageHistory: [{ to: 'install_complete' }] }) === false && Q.isQuietBackfill({ paymentBackfill: false }) === false);
ok('the lead the backfill builds is quiet by the real rule', Q.isQuietBackfill(lead) === true);
ok('a backfill invoice is recognised, an ordinary one is not', Q.isBackfillInvoice({ source: 'backfill' }) && Q.isBackfillInvoice({ backfilled: true }) && !Q.isBackfillInvoice({ source: 'record_payment' }) && !Q.isBackfillInvoice(null));
ok('the invoice overrides are recognised by the server rule', Q.isBackfillInvoice(B.invoiceOverrides(rv[0])));
let RA = null, DD = null;
try { RA = require(path.join(ROOT, 'functions/review-ask-auto-logic.js')); DD = require(path.join(ROOT, 'functions/doc-drafts-logic.js')); } catch (e) { console.log('  (review-ask / doc-drafts rules not loadable here: ' + String(e.message).split('\n')[0] + ')'); }
if (RA) {
  const nbd = RA.NBD_OWNER_UID;
  const full = Object.assign({}, lead, { companyId: nbd, userId: nbd, email: 'customer@example.invalid', phone: '513-555-0101' });
  const noMark = Object.assign({}, full); delete noMark.paymentBackfill; delete noMark.completedBackfill; noMark.stageHistory = [];
  const now = Date.UTC(2026, 9, 19), recv = Date.UTC(2026, 9, 10);
  const env = { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true' };
  ok('review ask: a backfilled customer WITH an email is never asked', RA.planEmail({ env, lead: full, jobId: null, recvMs: recv, nowMs: now }).send === false && RA.baseEligibility({ lead: full, recvMs: recv, nowMs: now }).reason === 'quiet_backfill');
  ok('review ask control: the same customer without the backfill marks WOULD be asked', RA.planEmail({ env, lead: noMark, jobId: null, recvMs: recv, nowMs: now }).send === true);
  ok('doc drafts: a backfilled customer gets no drafted paperwork', DD.shouldDraft(full, 'thank_you', {}).reason === 'quiet_backfill' && DD.shouldDraft(noMark, 'thank_you', {}).ok === true);

  // HIGH-1 (security review): "same customer" lands a backfill payment on a REAL lead. Its payment date must not open the ask window.
  const real = { companyId: nbd, userId: nbd, stage: 'closed', stageRole: 'won', email: 'customer@example.invalid', phone: '513-555-0101', stageHistory: [] };
  const bfInvoice = { id: 'b1', source: 'backfill', backfilled: true, status: 'paid', total: 500, amountPaid: 500, balanceDue: 0, payments: [{ amount: 500, at: new Date(recv), method: 'check' }] };
  const okInvoice = { id: 'r1', status: 'paid', total: 500, amountPaid: 500, balanceDue: 0, payments: [{ amount: 500, at: new Date(recv), method: 'check' }] };
  ok('receivedMs ignores a backfill invoice', RA.receivedMs([bfInvoice]) === 0);
  ok('control: receivedMs counts an ordinary invoice', RA.receivedMs([okInvoice]) === recv);
  ok('an existing paid-stage customer + a backfill payment dated 5 days ago is NOT asked for a review', RA.planEmail({ env, lead: real, jobId: null, recvMs: RA.receivedMs([bfInvoice]), nowMs: now }).send === false);
  ok('control: the same customer with an ordinary payment 5 days ago IS asked', RA.planEmail({ env, lead: real, jobId: null, recvMs: RA.receivedMs([okInvoice]), nowMs: now }).send === true);
  ok('a real payment still counts when a backfill invoice sits beside it', RA.receivedMs([bfInvoice, Object.assign({}, okInvoice, { payments: [{ amount: 1, at: new Date(recv - 86400000), method: 'cash' }] })]) === recv - 86400000);
  ok('hasBackfillInvoice: true with a live backfill invoice, false for ordinary, voided or none', Q.hasBackfillInvoice([okInvoice, bfInvoice]) && !Q.hasBackfillInvoice([okInvoice]) && !Q.hasBackfillInvoice([Object.assign({}, bfInvoice, { deleted: true })]) && !Q.hasBackfillInvoice(null));
  let RR = null;
  try { RR = require(path.join(ROOT, 'functions/referral-rewards.js')); } catch (e) { console.log('  (referral-rewards not loadable here: ' + String(e.message).split('\n')[0] + ')'); }
  if (RR && RR._internal) {
    ok('referral: a customer the backfill made earns no bonus even at stage closed', RR._internal.projectClosed(Object.assign({}, real, { paymentBackfill: true })) === false);
    ok('referral control: the same stage without the marker counts as closed', RR._internal.projectClosed(real) === true);
    ok('referral: a backfill payment alone never dates a payment received', RR._internal.paidForReferral(real, [bfInvoice]) === false);
  }
}
const paidFn = (lead, invs) => invs.length > 0 && invs.every((x) => x.status === 'paid');
const realPaid = { status: 'paid', payments: [{ amount: 5, at: new Date() }] }, bfPaid = { status: 'paid', source: 'backfill', payments: [{ amount: 5, at: new Date() }] };
ok('rating guard: a backfill-only customer is blocked; real money (even beside a backfill one) is not; no backfill = never blocked (the real handler is tested in portal-rating-backfill-2026-10-19.test.js)', Q.backfillBlocksRating({}, [bfPaid], paidFn) === true && Q.backfillBlocksRating({}, [bfPaid, realPaid], paidFn) === false && Q.backfillBlocksRating({}, [realPaid], paidFn) === false && Q.backfillBlocksRating({}, [bfPaid, { status: 'sent', payments: [] }], paidFn) === true);
ok('the portal and the rep nudge use that one guard', /backfillBlocksRating\(/.test(stripComments(read('functions/portal.js'))) && /backfillBlocksRating\(/.test(stripComments(read('functions/review-request-nudge.js'))));
const mpSrc = stripComments(read('functions/money-paper.js'));
const hStart = mpSrc.indexOf('async function handle(invoiceId, after, deps, before) {');
const guardAt = mpSrc.indexOf('isBackfillInvoice(after)', hStart);
const spineAt = mpSrc.indexOf('await spineOnInvoice(deps', hStart);
ok('money-paper: the backfill guard runs BEFORE the spine, the filing and the tasks', hStart > 0 && guardAt > hStart && spineAt > guardAt);
let MP = null;
try { MP = require(path.join(ROOT, 'functions/money-paper.js')); } catch (e) { console.log('  (money-paper not loadable here: ' + String(e.message).split('\n')[0] + '; CI runs the behavioural check)'); }
if (MP && MP._internal) {
  const calls = [];
  const trap = (name) => async () => { calls.push(name); throw new Error('must not run: ' + name); };
  const deps = { db: new Proxy({}, { get() { calls.push('db'); throw new Error('db must not be used'); } }), recordJobEvent: trap('recordJobEvent'), now: () => Date.now(), writePaymentTimeline: async () => ({ written: 1 }), FieldValue: {} };
  const after = { source: 'backfill', backfilled: true, leadId: 'L1', status: 'paid', total: 100, amountPaid: 100, balanceDue: 0, payments: [{ amount: 100, at: new Date(), method: 'check' }] };
  MP._internal.handle('inv1', after, deps, { status: 'draft', payments: [] }).then((out) => {
    ok('money-paper: a backfill invoice moves no stage, files nothing, drafts no task (only the timeline note)', out && out.skipped === 'backfill' && calls.length === 0, { out, calls });
    done();
  }).catch((e) => { ok('money-paper: a backfill invoice is skipped without error', false, String(e)); done(); });
} else done();

function proofBehaviour() {
  const mkWin = (decodes) => {
    class Img { set src(v) { setTimeout(() => (decodes ? (this.width = 4000, this.height = 3000, this.onload()) : this.onerror()), 0); } }
    const canvas = { getContext: () => ({ drawImage() {} }), toBlob(cb, type) { cb({ type, size: 5, fake: 'reencoded' }); } };
    const w = { console, Image: Img, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, setTimeout, document: { createElement: () => canvas, addEventListener() {}, body: { appendChild() {} } } };
    w.window = w; vm.createContext(w);
    vm.runInContext(read('docs/pro/js/proof-photos.js'), w, { filename: 'proof-photos.js' });
    return w.NBDProofPhotos;
  };
  const file = { type: 'image/jpeg', size: 100, name: 'check.jpg' };
  const pdf = { type: 'application/pdf', size: 100, name: 'slip.pdf' };
  return Promise.all([
    mkWin(true).prepare(file).then((r) => ok('an image is re-drawn (a NEW blob, JPEG): the original with its EXIF is not what is stored', r !== file && r.type === 'image/jpeg' && r.fake === 'reencoded'), (e) => ok('an image is re-drawn', false, String(e))),
    mkWin(false).prepare(file).then(() => ok('an image the browser cannot decode is REFUSED (never uploaded raw)', false), () => ok('an image the browser cannot decode is REFUSED (never uploaded raw)', true)),
    mkWin(true).prepare(pdf).then((r) => ok('a PDF is stored as is', r === pdf), () => ok('a PDF is stored as is', false)),
    mkWin(true).prepare({ type: 'text/html', size: 5 }).then(() => ok('a non-photo is refused', false), () => ok('a non-photo is refused', true)),
  ]);
}

function done() {
  console.log('\n— the screen: flag, role, wiring (comments stripped) —');
  const win = (extra) => { const w = Object.assign({ console }, extra || {}); w.window = w; vm.createContext(w); ['docs/pro/js/proof-photos.js', 'docs/pro/js/payment-backfill-logic.js', 'docs/pro/js/payment-backfill.js'].forEach((f) => vm.runInContext(read(f), w, { filename: f })); return w; };
  const flags = (on) => ({ enabled: (n) => on && n === 'paymentBackfill' });
  ok('flag off: no button, no panel', win({ NBDFlags: flags(false), _user: { uid: 'u1' }, _userClaims: {} }).NBDPaymentBackfill.buttonHtml() === '' && win({ NBDFlags: flags(false), _user: { uid: 'u1' }, _userClaims: {} }).NBDPaymentBackfill.panelHtml() === '');
  ok('flags not loaded yet: nothing', win({ _user: { uid: 'u1' }, _userClaims: {} }).NBDPaymentBackfill.buttonHtml() === '');
  const owner = win({ NBDFlags: flags(true), _user: { uid: 'u1' }, _userClaims: {} });
  ok('solo owner sees the button and the panel', /data-pb-action="open"/.test(owner.NBDPaymentBackfill.buttonHtml()) && /pbPanel/.test(owner.NBDPaymentBackfill.panelHtml()));
  ok('company admin and platform admin may; manager, rep, viewer may not', win({ NBDFlags: flags(true), _user: { uid: 'u2' }, _userClaims: { role: 'company_admin', companyId: 'c' } }).NBDPaymentBackfill.isOwner() === true
    && win({ NBDFlags: flags(true), _user: { uid: 'u2' }, _userClaims: { role: 'admin' } }).NBDPaymentBackfill.isOwner() === true
    && ['manager', 'sales_rep', 'viewer'].every((role) => win({ NBDFlags: flags(true), _user: { uid: 'u2' }, _userClaims: { role, companyId: 'c' } }).NBDPaymentBackfill.buttonHtml() === ''));
  ok('a team member with no role is not the owner', win({ NBDFlags: flags(true), _user: { uid: 'u3' }, _userClaims: { companyId: 'someone-else' } }).NBDPaymentBackfill.buttonHtml() === '');
  const ui = stripComments(read('docs/pro/js/payment-backfill.js'));
  const lg = stripComments(read('docs/pro/js/payment-backfill-logic.js'));
  const ppSrc = stripComments(read('docs/pro/js/proof-photos.js'));
  ok('reads the paymentBackfill flag', /FLAG = 'paymentBackfill'/.test(ui));
  ok('nothing here can message anyone (no send / callable / network call)', !/httpsCallable|sendSms|sendEmail|sendInvoice|sendReceipt|sendMessage|\bfetch\(|XMLHttpRequest|twilio|resend|mailto:|sms:/i.test(ui + lg + ppSrc));
  ok('the payment goes through the CRM\'s own paths: jobValueInvoiceDoc, then markPaid', /IP\(\)\.jobValueInvoiceDoc\(/.test(ui) && /IP\(\)\.markPaid\(/.test(ui));
  ok('the customer is made by an addDoc on leads with the Add Lead stamps (userId, companyId, meter, createdAt)', /collection\(w\.db, 'leads'\)/.test(ui) && /meter: 'import'/.test(ui) && !/meter: 'manual'/.test(ui) && /userId: me, companyId: cid/.test(ui));
  ok('no hard delete, undo is a soft void with a note', !/deleteDoc/.test(ui) && /softVoid\(/.test(ui) && /Say why you are voiding it/.test(lg));
  ok('a half-made customer is voided if the payment fails (nothing dangling)', (ui.match(/Backfill failed midway/g) || []).length === 2);
  ok('an interrupted run is resumed, not repeated (prior lead / invoice looked up by key)', /backfill\.key === r\.key/.test(ui) && /i\.backfillKey === r\.key/.test(ui));
  ok('a customer is never chosen for the owner: the pick must be tapped', /Confirm the customer first/.test(ui) && /needsConfirm && !ch\.pick/.test(ui));
  ok('a possible duplicate needs an explicit "create anyway"', /if \(r\.status === 'dup' && !ch\.override\) return rowErr/.test(ui));
  ok('the image is never read: no OCR, no pixel access, no MICR handling', !/getImageData|tesseract|ocr\b|scanReceipt|vision|micr\b/i.test(ui + ppSrc.replace(/MICR line[^\n]*/g, '')));
  ok('file names, sizes and URLs are never logged', !/console\.(log|info|warn|error)\([^)]*(\.name|\.size|file|url|path)/i.test(ui + ppSrc));
  ok('photos are shown from the signed-in SDK (getBlob), never a tokenised download URL', /getBlob\(/.test(ppSrc) && !/getDownloadURL/.test(ppSrc + ui));
  ok('no inline handlers or scripts', !/\son[a-z]+=/.test(ui + ppSrc) && !/<script/i.test(ui + ppSrc));
  ok('no old brand oranges, no employee wording', !/E8720C|F08030/i.test(read('docs/pro/css/payment-backfill.css') + read('docs/pro/css/proof-photos.css')) && !/employee|payroll|in-house|W-?2/i.test(ui + lg));
  ok('the invoice-pipeline accepts extra proof paths only from payment-proofs/', /proofPaths: details\.proofPaths/.test(read('docs/pro/js/invoice-pipeline.js')) && /\^payment-proofs/.test(read('docs/pro/js/invoice-pipeline.js')));
  ok('expenses.js mounts the button and panel; script-loader loads the files in order (proof component first)', /NBDPaymentBackfill\.buttonHtml\(\)/.test(read('docs/pro/js/expenses.js')) && /NBDPaymentBackfill\.panelHtml\(\)/.test(read('docs/pro/js/expenses.js')) &&
    (() => { const sl = read('docs/pro/js/script-loader.js'); return sl.indexOf('js/proof-photos.js') > 0 && sl.indexOf('js/proof-photos.js') < sl.indexOf('js/sub-payments.js') && sl.indexOf('js/payment-backfill-logic.js') < sl.indexOf('js/payment-backfill.js'); })());
  proofBehaviour().then(() => {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  });
}
