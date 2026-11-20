/**
 * tests/sub-job-board-2026-11-19.test.js — the pure rules behind the Sub job board
 * (docs/pro/js/sub-job-board-logic.js, flag subJobBoard).
 *
 * Behaviour, not source shape: the real module runs on plain data. Each flag has a
 * case that SHOULD fire and a control that should not, so a rule that flags
 * everything (or nothing) cannot pass.
 *
 * Run: node tests/sub-job-board-2026-11-19.test.js
 */
const path = require('path');
const B = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'sub-job-board-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; fails.push(name); console.log('  FAIL ' + name); }
}

const roster = [{ id: 's1', name: 'Mike Ruiz', trade: 'Roofing' }, { id: 's2', name: 'Sam Lee', trade: 'Gutters' }];
const lead = (id, over) => Object.assign({ id, firstName: 'Cust', lastName: id, stage: 'install_in_progress' }, over || {});
const pay = (leadId, cents, over) => Object.assign({ category: 'subcontractor', leadId, amountCents: cents, supplier: 'Mike Ruiz', subId: 's1', date: '2026-10-15' }, over || {});
const flagsOf = (res, id) => { const r = res.rows.find((x) => x.leadId === id); return r ? r.flags.join(',') : ''; };

console.log('1. which jobs the board looks at');
{
  const leads = [
    lead('a', { stage: 'estimate_sent' }), lead('b', { stage: 'lost' }), lead('c', { deleted: true }),
    lead('d'), lead('e', { stage: 'install_complete' }),
  ];
  const res = B.rowsFor({ leads, roster, payments: [], subJobs: {} });
  ok('an estimate, a lost lead and a deleted job are not on the board', res.considered === 2);
  ok('committed and finished jobs are considered', flagsOf(res, 'd') === 'noSub' && flagsOf(res, 'e') === 'noSub');
  ok('control: the same job with a roster sub is no longer "no sub"', flagsOf(B.rowsFor({ leads: [lead('d', { subId: 's1' })], roster, payments: [], subJobs: {} }), 'd') === 'noAgreed');
}

console.log('2. no sub / no agreed pay');
{
  const leads = [lead('n1'), lead('n2', { subId: 's1' }), lead('n3', { subId: 's1' })];
  const subJobs = { n3: { subId: 's1', basis: 'job', agreedCents: 150000 } };
  const res = B.rowsFor({ leads, roster, payments: [pay('n3', 100000)], subJobs });
  ok('no sub at all', flagsOf(res, 'n1') === 'noSub');
  ok('a sub on the lead but no agreed pay', flagsOf(res, 'n2') === 'noAgreed');
  ok('control: sub and agreed pay, paid under it, still in progress = no flag', flagsOf(res, 'n3') === '');
  ok('a subJobs doc subId wins over the lead subId', B.rowsFor({ leads: [lead('n4', { subId: 's1' })], roster, payments: [], subJobs: { n4: { subId: 's2', agreedCents: 5000 } } }).rows.length === 0);
  const zero = B.rowsFor({ leads: [lead('z', { subId: 's1' })], roster, payments: [], subJobs: { z: { subId: 's1', agreedCents: 0 } } });
  ok('an agreed amount of 0 is NOT agreed pay', flagsOf(zero, 'z') === 'noAgreed');
  const neg = B.rowsFor({ leads: [lead('ng', { subId: 's1' })], roster, payments: [], subJobs: { ng: { subId: 's1', agreedCents: -500 } } });
  ok('a negative agreed amount is NOT agreed pay', flagsOf(neg, 'ng') === 'noAgreed');
  const win = B.rowsFor({ leads: [lead('w1', { subId: 's1' })], roster, payments: [pay('w1', 20000, { subId: 's2', supplier: 'Sam Lee' })], subJobs: { w1: { subId: 's2', agreedCents: 10000 } } });
  ok('the subJobs sub wins over the lead sub: the row names Sam Lee, not Mike Ruiz', win.rows.length === 1 && win.rows[0].subId === 's2' && win.rows[0].subName === 'Sam Lee' && win.rows[0].flags[0] === 'overpaid');
  const legacy = B.rowsFor({ leads: [lead('lg', { crew: 'Big Mike crew' })], roster, payments: [], subJobs: {} });
  ok('an old free-text crew name is listed, never auto-linked', legacy.rows[0].legacyCrew === 'Big Mike crew' && legacy.rows[0].subId === null);
}

console.log('3. "no sub needed" removes a job from every bucket');
{
  const res = B.rowsFor({ leads: [lead('x1', { stage: 'install_complete' })], roster, payments: [], subJobs: { x1: { noSubNeeded: true } } });
  ok('flagged "no sub needed": no row, counted as skipped', res.rows.length === 0 && res.skipped === 1 && res.considered === 0);
  const off = B.rowsFor({ leads: [lead('x2', { stage: 'install_complete' })], roster, payments: [], subJobs: { x2: { noSubNeeded: false } } });
  ok('control: noSubNeeded false still flags the job', off.rows.length === 1 && off.skipped === 0);
}

console.log('4. finished, no payment logged / paid over agreed');
{
  const leads = [lead('f1', { stage: 'final_payment', subId: 's1' }), lead('f2', { stage: 'final_payment', subId: 's1' }), lead('f3', { stage: 'final_payment', subId: 's1' }), lead('f4', { stage: 'install_in_progress', subId: 's1' })];
  const subJobs = { f1: { subId: 's1', agreedCents: 100000 }, f2: { subId: 's1', agreedCents: 100000 }, f3: { subId: 's1', agreedCents: 100000 }, f4: { subId: 's1', agreedCents: 100000 } };
  const payments = [
    pay('f2', 100000),                         // exactly agreed
    pay('f3', 80000), pay('f3', 30000),        // 110,000 > 100,000, two payments
    pay('f4', 90000, { deleted: true }),       // deleted: never counts
    pay('f1', 50000, { category: 'materials' }), // not a sub payment
  ];
  const res = B.rowsFor({ leads, roster, payments, subJobs });
  ok('finished with no live sub payment', flagsOf(res, 'f1') === 'noPayment');
  ok('control: paid exactly the agreed amount is clean', flagsOf(res, 'f2') === '');
  ok('paid over agreed, summed across payments', flagsOf(res, 'f3') === 'overpaid' && res.rows.find((r) => r.leadId === 'f3').paidCents === 110000);
  ok('control: the same shape while still in progress does not flag noPayment', flagsOf(res, 'f4') === '');
  const credit = B.rowsFor({ leads: [lead('c1', { stage: 'closed', subId: 's1' })], roster, payments: [pay('c1', 120000), pay('c1', 30000, { entryType: 'credit' })], subJobs: { c1: { subId: 's1', agreedCents: 100000 } } });
  ok('a credit subtracts: 1,200 - 300 = 900 paid, not over 1,000 agreed', credit.rows.length === 0);
  ok('counts add up to the flags', res.counts.noPayment === 1 && res.counts.overpaid === 1 && res.counts.noSub === 0);
}

console.log('5. metrics');
{
  const leads = [
    lead('m1', { stage: 'closed', subId: 's1', scheduledDate: '2026-10-01', scheduledEndDate: '2026-10-03', installCompletedAt: '2026-10-04T15:00:00' }),   // on time (grace 1)
    lead('m2', { stage: 'closed', subId: 's1', scheduledDate: '2026-10-10', scheduledEndDate: '2026-10-11', installCompletedAt: '2026-10-15T15:00:00' }),   // 4 days late
    lead('m3', { stage: 'closed', subId: 's1', installCompletedAt: '2026-10-30T10:00:00' }),                                                                   // finished but never scheduled: not measured
    lead('m4', { stage: 'closed', subId: 's2', scheduledDate: '2026-10-01', installCompletedAt: '2026-10-02T09:00:00' }),
    lead('m5', { stage: 'install_in_progress', subId: 's1' }),                                                                                                  // not finished: not a job done
  ];
  const subJobs = {
    m1: { subId: 's1', basis: 'sq', qty: 20, agreedCents: 170000 },
    m2: { subId: 's1', basis: 'sq', qty: 30, agreedCents: 250000 },
    m3: { subId: 's1', basis: 'job', agreedCents: 100000 },
  };
  const payments = [
    pay('m1', 170000, { date: '2026-10-05' }), pay('m2', 300000, { date: '2026-10-16' }),
    pay('m3', 90000, { date: '2025-12-20' }), pay(null, 40000, { date: '2026-11-01' }),
  ];
  const ms = B.metrics({ leads, roster, payments, subJobs });
  const m = ms.find((x) => x.subId === 's1');
  ok('jobs done counts finished jobs only', m.jobs === 3);
  ok('total paid, all time, includes a payment with no job', m.totalPaidCents === 600000);
  ok('paid by year splits on the payment date', m.paidByYear['2026'] === 510000 && m.paidByYear['2025'] === 90000);
  ok('average paid per SQ uses only SQ jobs with a quantity: (1700 + 3000) / 50 = $94.00', m.avgPaidPerSqCents === 9400 && m.sqJobs === 2);
  ok('on time: finished 1 day after the last day is inside the grace', m.measured === 2 && m.lateJobs === 1);
  ok('days late: 15th vs 11th, less 1 day grace = 3', m.lateDays === 3);
  ok('a job with no schedule is not measured (never counted late)', m.measured === 2);
  ok('paid vs agreed over jobs that have an agreed amount: 5,600 - 5,200 = +$400... then m3 90000 vs 100000', m.agreedCents === 520000 && m.paidOnAgreedCents === 560000 && m.varianceCents === 40000);
  const s2 = ms.find((x) => x.subId === 's2');
  ok('control: a sub with one on-time job and no money has no avg per SQ and no variance', s2.jobs === 1 && s2.avgPaidPerSqCents === null && s2.varianceCents === null && s2.lateJobs === 0 && s2.measured === 1);
  const none = B.metrics({ leads: [], roster, payments: [], subJobs: {} });
  ok('a roster sub with no jobs and no payments still appears, all zero', none.length === 2 && none.every((x) => x.jobs === 0 && x.totalPaidCents === 0));
  const nsn = B.metrics({ leads: [lead('q', { stage: 'closed', subId: 's1' })], roster, payments: [], subJobs: { q: { noSubNeeded: true } } });
  ok('a "no sub needed" job is not credited to the sub', nsn.find((x) => x.subId === 's1').jobs === 0);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
