/**
 * tests/month-close-2026-10-19.test.js
 *
 * The "Month close" screen (docs/pro/js/month-close-logic.js + month-close.js,
 * flag monthClose). Drives the REAL modules with SYNTHETIC names and amounts
 * (public repo): the month window (boundaries to the millisecond, DST months,
 * re-run under several time zones), collected = payments minus refunds through
 * the real NBDRevenue.paymentsOf, costs by month, the set-aside math (on profit,
 * never deposits, no rate hard-coded), the deposit gap, the reminder dates, the
 * saved doc, the summary text, and the screen in a sandbox (flag off = nothing,
 * viewer = read-only, owner saves exactly one well-formed doc).
 *
 * Run: node tests/month-close-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TZS = ['America/New_York', 'Pacific/Auckland', 'UTC', 'Pacific/Honolulu'];

// Re-run the whole file under other time zones so a month boundary that only
// breaks east or west of the server cannot hide.
if (!process.env.MC_TZ_CHILD && !process.argv.includes('--no-tz')) {
  let bad = 0;
  for (const tz of TZS) {
    const r = spawnSync(process.execPath, [__filename, '--no-tz'], { env: Object.assign({}, process.env, { TZ: tz, MC_TZ_CHILD: tz }), encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const last = out.trim().split('\n').pop();
    console.log('TZ ' + tz + ': ' + (r.status === 0 ? 'ok' : 'FAILED') + ' (' + last + ')');
    if (r.status !== 0) { bad++; console.log(out); }
  }
  // the main run below also happens in this process's own zone
  process.env.MC_TZ_CHILD = 'main';
  if (bad) { console.log('\n' + bad + ' time zone run(s) failed'); process.exit(1); }
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; if (!process.env.MC_TZ_CHILD || process.env.MC_TZ_CHILD === 'main') console.log('  ✓ ' + label); }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const stripComments = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, '')).join('\n');

const P = require(path.join(ROOT, 'docs/pro/js/month-close-logic.js'));

// the real collected-revenue ledger
const revWin = {};
vm.runInNewContext(read('docs/pro/js/collected-revenue.js'), { window: revWin, Date, Math, parseFloat, isNaN, Object, Array, Promise, console, setTimeout });
const paymentsOf = revWin.NBDRevenue.paymentsOf;

// An exact instant given with its Eastern offset, so a boundary does not depend on the device zone.
const ET = (iso) => new Date(iso);
const D = (y, m, d, h, mi, s, ms) => new Date(y, m - 1, d, h === undefined ? 12 : h, mi || 0, s || 0, ms || 0);
const inv = (leadId, pays, extra) => Object.assign({
  id: 'inv-' + Math.random().toString(36).slice(2, 8), leadId,
  total: pays.reduce((s, p) => s + p[0], 0), balanceDue: 0, payments: pays.map((p) => ({ amount: p[0], at: p[1] })),
}, extra || {});

(async () => {
  console.log('\n1. the month window (Eastern time, whatever the device zone is)');
  {
    const r = P.monthRange('2026-09');
    ok('September 2026', r.key === '2026-09' && r.label === 'September 2026' && r.year === 2026 && r.month === 9 && r.tz === 'America/New_York');
    const sep30 = ET('2026-09-30T23:59:59.999-04:00'), oct1 = ET('2026-10-01T00:00:00.000-04:00'), sep1 = ET('2026-09-01T00:00:00.000-04:00'), aug31 = ET('2026-08-31T23:59:59.999-04:00');
    ok('11:59:59.999pm on the 30th Eastern is in September; the first ms of October is out', P.inRange(sep30.getTime(), r) && !P.inRange(oct1.getTime(), r));
    ok('the first ms of September is in; the last ms of August is out', P.inRange(sep1.getTime(), r) && !P.inRange(aug31.getTime(), r));
    ok('a zero timestamp is never in a month', !P.inRange(0, r) && !P.inRange(null, r) && !P.inRange(NaN, r));
    const nov = P.monthRange('2026-11'), oct = P.monthRange('2026-10'), dec = P.monthRange('2026-12');
    ok('daylight saving ends Nov 1 2026: the last ms of October (EDT) is October, the first ms of November (EDT, 4:00Z) is November', P.inRange(ET('2026-11-01T03:59:59.999Z').getTime(), oct) && P.inRange(ET('2026-11-01T04:00:00.000Z').getTime(), nov) && !P.inRange(ET('2026-11-01T04:00:00.000Z').getTime(), oct));
    ok('the last ms of November (EST, 05:00Z next day) is November; the first ms of December is December', P.inRange(ET('2026-12-01T04:59:59.999Z').getTime(), nov) && P.inRange(ET('2026-12-01T05:00:00.000Z').getTime(), dec) && !P.inRange(ET('2026-12-01T05:00:00.000Z').getTime(), nov));
    ok('daylight saving starts Mar 8 2026: the last ms of February (EST) is February, midnight March 1 is March', P.inRange(ET('2026-03-01T04:59:59.999Z').getTime(), P.monthRange('2026-02')) && P.inRange(ET('2026-03-01T05:00:00.000Z').getTime(), P.monthRange('2026-03')));
    ok('year end: Dec 31 11:59:59.999pm EST is December, midnight Jan 1 is January', P.inRange(ET('2027-01-01T04:59:59.999Z').getTime(), dec) && P.inRange(ET('2027-01-01T05:00:00.000Z').getTime(), P.monthRange('2027-01')));
    ok('the same instant is the same month in every device zone (11pm Eastern on Sep 30 is Oct 1 in UTC)', P.monthKeyOf(sep30.getTime()) === '2026-09' && sep30.getUTCMonth() === 9 && sep30.getUTCDate() === 1);
    ok('bad keys are refused', ['2026-13', '2026-00', '26-09', '2026-9', '', null, undefined, '2026-09-01'].every((k) => P.monthRange(k) === null && !P.isMonthKey(k)));
    ok('previousMonthKey: Oct 19 -> 2026-09; just after midnight Jan 1 Eastern -> December; 11pm Eastern Dec 31 -> November', P.previousMonthKey(D(2026, 10, 19).getTime()) === '2026-09' && P.previousMonthKey(ET('2027-01-01T05:00:00.000Z').getTime()) === '2026-12' && P.previousMonthKey(ET('2027-01-01T04:59:59.999Z').getTime()) === '2026-11');
    ok('monthKeyOf of nothing is empty, not "NaN"', P.monthKeyOf(0) === '' && P.monthKeyOf(NaN) === '' && P.monthKeyOf(null) === '');
  }

  console.log('\n2. collected = payments in, refunds out, by the day each arrived');
  {
    const range = P.monthRange('2026-09');
    const invs = [
      inv('L1', [[1000, D(2026, 9, 3)], [500, ET('2026-08-31T23:59:59.999-04:00')]]),            // Aug payment is not September
      inv('L2', [[2000.5, ET('2026-09-30T23:59:59.999-04:00')]], { refunds: [{ amount: 100, at: D(2026, 9, 12) }] }),
      inv('L3', [[750, ET('2026-10-01T00:00:00.000-04:00')]]),                                           // first ms of October: out
      inv(null, [[300, D(2026, 9, 9)]]),                                                        // no job
      inv('L4', [[999, D(2026, 9, 9)]], { deleted: true }),                                     // deleted invoice
      inv('L5', [[40, D(2026, 9, 9)]], { refunds: [{ amount: 40, at: D(2026, 9, 10), status: 'failed' }] }), // failed refund returned nothing
    ];
    const c = P.collectedForMonth(invs, paymentsOf, range);
    ok('payments in the month', c.grossCents === 100000 + 200050 + 30000 + 4000, JSON.stringify(c));
    ok('refunds come off, on the day they happened', c.refundsCents === 10000);
    ok('collected = payments - refunds', c.collectedCents === 100000 + 200050 + 30000 + 4000 - 10000 && c.collectedCents === c.grossCents - c.refundsCents);
    ok('the last ms of the month counts; the first ms of the next month and August do not', c.byLead.L2 === 200050 - 10000 && c.byLead.L3 === undefined && c.byLead.L1 === 100000);
    ok('a deleted invoice and a failed refund change nothing', c.byLead.L4 === undefined && c.byLead.L5 === 4000);
    ok('a payment with no job is counted and flagged', c.unlinkedCents === 30000 && c.unlinkedCount === 1);
    ok('cents are integers (no float dust from 2000.50)', Number.isInteger(c.collectedCents) && Number.isInteger(c.grossCents));
    ok('a month with only a refund is negative collected', P.collectedForMonth([inv('L9', [[10, D(2026, 8, 1)]], { refunds: [{ amount: 25, at: D(2026, 9, 2) }] })], paymentsOf, range).collectedCents === -2500);
    ok('no invoices -> zeros, not NaN', (() => { const z = P.collectedForMonth([], paymentsOf, range); return z.collectedCents === 0 && z.paymentCount === 0; })());
  }

  console.log('\n3. costs by month');
  {
    const range = P.monthRange('2026-09');
    const ex = (o) => Object.assign({ costType: 'direct', amountCents: 10000, taxCents: 0, date: D(2026, 9, 10), leadId: 'L1' }, o || {});
    const costs = P.costsForMonth([
      ex(), ex({ amountCents: 5000, taxCents: 350 }), ex({ date: ET('2026-09-30T23:59:59.999-04:00'), amountCents: 1 }), ex({ date: ET('2026-10-01T00:00:00.000-04:00'), amountCents: 77777 }),
      ex({ deleted: true, amountCents: 88888 }), ex({ amountCents: 0 }), ex({ estimated: true, amountCents: 2000, leadId: 'L2' }), ex({ leadId: null, amountCents: 700 }),
      ex({ costType: 'overhead', amountCents: 4000, leadId: null }), ex({ costType: 'overhead', amountCents: 900, deleted: true }),
    ], range);
    ok('direct = amount + tax, dated in the month, live only', costs.directCents === 10000 + 5350 + 1 + 2000 + 700, JSON.stringify(costs));
    ok('the first ms of October and a voided row are out', costs.directCents < 77777);
    ok('estimates are counted AND tracked', costs.estimatedCents === 2000);
    ok('a cost with no job is counted and tracked', costs.noJobCents === 700 && costs.noJobCount === 1);
    ok('overhead is separate and skips voided rows', costs.loggedOverheadCents === 4000);
    ok('per job totals', costs.byLead.L1 === 10000 + 5350 + 1 && costs.byLead.L2 === 2000);
    ok('a string amount cannot sneak in as text', P.costsForMonth([ex({ amountCents: '12abc' })], range).directCents === 12);
  }

  console.log('\n4. the job profit table');
  {
    const leads = [{ id: 'L1', firstName: 'Sample', lastName: 'One' }, { id: 'L2', firstName: 'Sample', lastName: 'Two' }];
    const coll = { byLead: { L1: 1000000, L2: 500000, GONE: 1000 } };
    const costs = { byLead: { L1: 400000 } };
    const rows = P.jobTable(leads, coll, costs, { L1: true }, (l) => l.firstName + ' ' + l.lastName);
    const r1 = rows.find((r) => r.id === 'L1'), r2 = rows.find((r) => r.id === 'L2'), rg = rows.find((r) => r.id === 'GONE');
    ok('margin = (collected - costs) / collected', r1.profitCents === 600000 && r1.marginPct === 60 && r1.costsNotLogged === false);
    ok('a job with no real cost logged says so, never a 100% margin', r2.costsNotLogged === true && r2.marginPct === null && r2.profitCents === 500000);
    ok('a payment on a job we cannot find stays visible', rg && rg.name === 'Job not found');
    ok('biggest collected first', rows[0].id === 'L1' && rows[1].id === 'L2');
    ok('estimate-only costs do not count as "logged"', Object.keys(P.jobsWithRealCost([{ costType: 'direct', amountCents: 5, estimated: true, leadId: 'L1' }, { costType: 'direct', amountCents: 5, leadId: 'L2' }, { costType: 'direct', amountCents: 5, leadId: 'L3', deleted: true }])).join() === 'L2');
  }

  console.log('\n5. the tax set-aside is on PROFIT, at the owner\'s rate');
  {
    const a = P.setAside(1000000, 400000, 100000, 2500);
    ok('25% of $5,000.00 profit = $1,250.00', a.profitCents === 500000 && a.setAsideCents === 125000 && !a.loss);
    ok('profit = collected - direct - overhead (each term matters)', P.setAside(1000000, 400001, 100000, 10000).setAsideCents === 499999 && P.setAside(1000000, 400000, 100001, 10000).setAsideCents === 499999 && P.setAside(1000001, 400000, 100000, 10000).setAsideCents === 500001);
    ok('rounds half up, in whole cents', P.setAside(1002, 0, 0, 2500).setAsideCents === 251 && P.setAside(1001, 0, 0, 2500).setAsideCents === 250 && P.setAside(10, 0, 0, 5000).setAsideCents === 5);
    ok('fractional rates in basis points: 22.5% of $1,000.00 = $225.00', P.setAside(100000, 0, 0, 2250).setAsideCents === 22500);
    ok('a loss month sets aside $0 and says loss', (() => { const l = P.setAside(100000, 90000, 20000, 2500); return l.profitCents === -10000 && l.setAsideCents === 0 && l.loss === true; })());
    ok('no rate typed -> null, never a made-up number', P.setAside(100000, 0, 0, null).setAsideCents === null && P.setAside(100000, 0, 0, undefined).setAsideCents === null);
    ok('0% is a real answer, not "missing"', P.setAside(100000, 0, 0, 0).setAsideCents === 0);
    ok('an out-of-range rate sets nothing', P.setAside(100000, 0, 0, 10001).setAsideCents === null && P.setAside(100000, 0, 0, -1).setAsideCents === null);
    ok('exact in integers for a big month (no float drift)', P.setAside(123456789, 0, 0, 3333).setAsideCents === Math.floor((123456789 * 3333 + 5000) / 10000));
    // deposits must never move the set-aside
    const t1 = P.totalsOf({ collectedCents: 1000000, grossCents: 1000000, refundsCents: 0 }, { directCents: 400000 }, 100000, 5, 2500);
    const t2 = P.totalsOf({ collectedCents: 1000000, grossCents: 1000000, refundsCents: 0 }, { directCents: 400000 }, 100000, 99999999, 2500);
    ok('bank deposits never change the set-aside', t1.setAsideCents === t2.setAsideCents && t1.setAsideCents === 125000 && t1.depositsCents !== t2.depositsCents);
    ok('totalsOf stores no rate unless one was typed', P.totalsOf({ collectedCents: 1, grossCents: 1, refundsCents: 0 }, { directCents: 0 }, 0, null, null).rateBp === null);
    // parsing
    ok('parseCents: plain amounts only', P.parseCents('$1,250.50') === 125050 && P.parseCents('19.9') === 1990 && P.parseCents('0') === 0 && P.parseCents(' 7 ') === 700);
    ok('parseCents rejects text, negatives, three decimals, exponents', ['', 'abc', '-5', '12.345', '1e3', '1.2.3', '$', '12abc', null].every((x) => P.parseCents(x) === null));
    ok('parseRateBp: 25 -> 2500, 22.5 -> 2250, 100 -> 10000, 7.25 -> 725', P.parseRateBp('25') === 2500 && P.parseRateBp('22.5%') === 2250 && P.parseRateBp('100') === 10000 && P.parseRateBp('7.25') === 725);
    ok('parseRateBp rejects 100.01, negatives, text', ['100.01', '-1', 'abc', '', '1e2', '101'].every((x) => P.parseRateBp(x) === null));
    ok('fmtRate / fmtMoney', P.fmtRate(2500) === '25%' && P.fmtRate(2250) === '22.5%' && P.fmtRate(725) === '7.25%' && P.fmtMoney(-250) === '-$2.50' && P.fmtMoney(123456789) === '$1,234,567.89');
  }

  console.log('\n6. bank deposits vs collected');
  {
    ok('not entered -> no gap', P.depositGap(100000, null).gapCents === null && P.depositGap(100000, null).status === 'not_entered');
    ok('bank higher / lower / match', P.depositGap(100000, 130000).gapCents === 30000 && P.depositGap(100000, 130000).status === 'bank_higher' && P.depositGap(100000, 70000).gapCents === -30000 && P.depositGap(100000, 100000).status === 'match');
    ok('$0 deposits is entered (a gap), not missing', P.depositGap(100000, 0).gapCents === -100000);
  }

  console.log('\n7. zero-flag rows and no-job counts');
  {
    const range = P.monthRange('2026-09');
    const e = (o) => Object.assign({ costType: 'direct', amountCents: 100, date: D(2026, 9, 10), leadId: null }, o || {});
    const n = P.noJobCounts([
      e({ source: 'cash_payout' }), e({ source: 'cash_payout', leadId: 'L1' }), e({ source: 'cash_payout', deleted: true }), e({ source: 'cash_payout', date: ET('2026-10-01T00:00:00.000-04:00') }),
      e(), e({ leadId: 'L1' }), e({ reviewState: 'unsorted', leadId: null, costType: 'overhead' }), e({ costType: 'overhead' }), e({ amountCents: 0 }),
    ], range, (x) => x.reviewState === 'unsorted');
    ok('unassigned crew cash counts only live, in-month, jobless payouts', n.cashNoJob === 1, JSON.stringify(n));
    ok('receipts with no job: jobless direct costs and unsorted receipts, not crew cash or overhead', n.receiptsNoJob === 2, JSON.stringify(n));
    const rows = P.flagRows({ jobsNoCosts: 0, paymentsNoJob: 3, receiptsNoJob: null, cashNoJob: 0, auditorNoSub: null });
    const by = (id) => rows.find((r) => r.id === id);
    ok('0 = ok, >0 = open, null = not enabled', by('zero_jobs').status === 'ok' && by('zero_payments').status === 'open' && by('zero_receipts').status === 'off' && by('auditor').status === 'off' && by('cash').status === 'ok');
  }

  console.log('\n8. reminder dates (a helper to read from)');
  {
    const s = P.reminderSchedule('2027-04-15');
    ok('14, 7, 2 days before and day-of', s.map((x) => x.offset).join() === '14,7,2,0' && s.map((x) => x.ymd).join() === '2027-04-01,2027-04-08,2027-04-13,2027-04-15');
    ok('weekday names are right (2026-04-15 is a Wednesday)', P.reminderSchedule('2026-04-15').pop().weekday === 'Wednesday');
    ok('crosses a year end: Jan 15 - 14 days = Jan 1; Jan 5 - 14 = Dec 22', P.reminderSchedule('2027-01-15')[0].ymd === '2027-01-01' && P.reminderSchedule('2027-01-05')[0].ymd === '2026-12-22');
    ok('crosses a month end in a leap year: 2028-03-01 - 2 days = Feb 28; non-leap 2027-03-01 - 2 = Feb 27', P.reminderSchedule('2028-03-01')[2].ymd === '2028-02-28' && P.reminderSchedule('2027-03-01')[2].ymd === '2027-02-27');
    ok('daylight saving cannot shift a day (due Nov 2 2026, 2 days before = Oct 31)', P.reminderSchedule('2026-11-02')[2].ymd === '2026-10-31' && P.reminderSchedule('2026-03-09')[3].ymd === '2026-03-09' && P.reminderSchedule('2026-03-10')[0].ymd === '2026-02-24');
    ok('bad dates make nothing', ['2026-02-30', '2026-13-01', 'soon', '', null, '2026-4-15'].every((d) => P.reminderSchedule(d).length === 0));
    ok('custom offsets', P.reminderSchedule('2027-04-15', [1]).map((x) => x.ymd).join() === '2027-04-14');
    const sug = P.suggestedDueDates(2026);
    ok('suggested dates are a starting list: Apr 15, Jun 15, Sep 15, then Jan 15 of the next year', sug.join() === '2026-04-15,2026-06-15,2026-09-15,2027-01-15');
    const txt = P.reminderText(sug);
    ok('the text says to confirm with the CPA and flags a weekend due date', /confirm with the cpa/i.test(txt) && /Saturday|Sunday/.test(P.reminderText(['2026-11-01', '2026-11-07'])) && /weekend/.test(P.reminderText(['2026-11-07'])));
    ok('the text lists every offset for every date', (txt.match(/days before|Day of/g) || []).length === 16);
  }

  console.log('\n9. the saved close');
  {
    const totals = P.totalsOf({ collectedCents: 1840000, grossCents: 1900000, refundsCents: 60000 }, { directCents: 910000 }, 120000, 1790000, 2500);
    const base = { companyId: 'co1', uid: 'u1', monthKey: '2026-09', totals, checks: { collected: true, bogus: true }, explain: { deposits: '  fees  ', nonsense: 'x' }, notes: 'n', ts: 'TS', nowMs: 1700000000000 };
    const b = P.buildCloseDoc(base);
    ok('builds one doc with the allowed keys only', b.doc && Object.keys(b.doc).sort().join() === 'checks,companyId,createdAt,createdBy,editLog,explain,monthKey,notes,totals,updatedAt,updatedBy');
    ok('unknown checklist ids and explanation ids are dropped, text trimmed', b.doc.checks.collected === true && !('bogus' in b.doc.checks) && b.doc.explain.deposits === 'fees' && !('nonsense' in b.doc.explain));
    ok('stamps and editLog on first save', b.doc.createdBy === 'u1' && b.doc.updatedBy === 'u1' && b.doc.createdAt === 'TS' && b.doc.editLog.length === 1 && b.doc.editLog[0].what === 'saved the close');
    ok('all money is integer cents', Object.keys(b.doc.totals).every((k) => b.doc.totals[k] === null || Number.isInteger(b.doc.totals[k])));
    const again = P.buildCloseDoc(Object.assign({}, base, { existing: { createdAt: 'T0', createdBy: 'first', editLog: [{ at: 1, by: 'first', what: 'saved the close', note: '' }] }, uid: 'u2', ts: 'T2' }));
    ok('a re-save keeps who/when it was created and appends to the log', again.doc.createdAt === 'T0' && again.doc.createdBy === 'first' && again.doc.updatedBy === 'u2' && again.doc.editLog.length === 2 && again.doc.editLog[1].what === 'updated the close');
    ok('the editLog keeps the newest 25', (() => { let log = []; for (let i = 0; i < 40; i++) log = P.appendLog(log, { at: i }); return log.length === 25 && log[0].at === 15 && log[24].at === 39; })());
    ok('notes are cut at 2000, explanations at 300', P.buildCloseDoc(Object.assign({}, base, { notes: 'x'.repeat(5000), explain: { deposits: 'y'.repeat(900) } })).doc.notes.length === 2000 && P.buildCloseDoc(Object.assign({}, base, { explain: { deposits: 'y'.repeat(900) } })).doc.explain.deposits.length === 300);
    ok('refuses a missing company, user, bad month, bad totals', !!P.buildCloseDoc(Object.assign({}, base, { companyId: '' })).error && !!P.buildCloseDoc(Object.assign({}, base, { uid: null })).error && !!P.buildCloseDoc(Object.assign({}, base, { monthKey: '2026-9' })).error
      && !!P.buildCloseDoc(Object.assign({}, base, { totals: Object.assign({}, totals, { collectedCents: 1.5 }) })).error && !!P.buildCloseDoc(Object.assign({}, base, { totals: Object.assign({}, totals, { rateBp: 10001 }) })).error);
    ok('the doc id is companyId_YYYY-MM', P.closeDocId('co1', '2026-09') === 'co1_2026-09');
    ok('changedSince names the figures that moved', P.changedSince({ collectedCents: 1, directCents: 2, refundsCents: 3 }, { collectedCents: 1, directCents: 9, refundsCents: 3 }).join() === 'directCents');
    ok('roles: only owner / company_admin / solo see and edit; manager, viewer and rep neither', P.canClose({ role: 'company_admin', companyId: 'c' }, 'u') && P.canClose({}, 'u1') && P.canClose({ companyId: 'u1' }, 'u1') && !P.canClose({ role: 'manager' }, 'u') && !P.canClose({ role: 'viewer' }, 'u') && !P.canClose({ companyId: 'other' }, 'u1')
      && !P.canView({ role: 'viewer' }, 'u') && !P.canView({ role: 'manager' }, 'u') && !P.canView({ role: 'sales_rep' }, 'u') && P.canView({ role: 'company_admin', companyId: 'c' }, 'u') && P.canView({}, 'u1') && !P.canClose(null, null));
  }

  console.log('\n10. the one-page summary');
  {
    const totals = P.totalsOf({ collectedCents: 1840000, grossCents: 1900000, refundsCents: 60000 }, { directCents: 910000 }, 120000, 1790000, 2500);
    const md = P.summaryMarkdown({ monthKey: '2026-09', totals, checks: { collected: true }, explain: { deposits: 'processor fees' }, notes: 'synthetic note',
      flags: P.flagRows({ jobsNoCosts: 2, paymentsNoJob: 0, receiptsNoJob: null, cashNoJob: 0, auditorNoSub: null }),
      jobs: [{ name: 'Sample One', collectedCents: 100000, directCents: 40000, marginPct: 60, costsNotLogged: false }, { name: 'Sample Two', collectedCents: 50000, directCents: 0, marginPct: null, costsNotLogged: true }] });
    ok('names the month, the basis, and CPA caution', /# Month close: September 2026/.test(md) && /cash, collected only/.test(md) && /confirm with the cpa/i.test(md));
    ok('shows every figure', ['$18,400.00', '$9,100.00', '$1,200.00', '$8,100.00', '$17,900.00', '25%', '$2,025.00'].every((x) => md.indexOf(x) !== -1), md);
    ok('shows the gap with its direction', /gap vs collected -\$500\.00 \(bank is lower\)/.test(md));
    ok('flags: open, ok and not-enabled are all stated', /not enabled/.test(md) && /\(open\)/.test(md));
    ok('a job with no costs says "costs not logged", not a margin', /Sample Two: .*costs not logged/.test(md) && /Sample One: .*margin 60%/.test(md));
    ok('checklist boxes: auto item ticked, checked item ticked, others not', /- \[x\] Window is one calendar month/.test(md) && /- \[x\] Collected revenue/.test(md) && /- \[ \] Bank deposits typed/.test(md));
    ok('explanations and notes appear; nothing says undefined or NaN', /processor fees/.test(md) && /synthetic note/.test(md) && !/undefined|NaN|null/.test(md));
    const noRate = P.summaryMarkdown({ monthKey: '2026-09', totals: P.totalsOf({ collectedCents: 100, grossCents: 100, refundsCents: 0 }, { directCents: 0 }, 0, null, null) });
    ok('no rate, no deposits: it says so instead of inventing a figure', /no rate entered/.test(noRate) && /not entered/.test(noRate));
    ok('a loss month is called a loss', /a loss month/.test(P.summaryMarkdown({ monthKey: '2026-09', totals: P.totalsOf({ collectedCents: 100, grossCents: 100, refundsCents: 0 }, { directCents: 500 }, 0, null, 2500) })));
  }

  console.log('\n11. the screen, in a sandbox');
  {
    const SRC = read('docs/pro/js/month-close.js');
    const NOW = D(2026, 10, 19).getTime();
    function boot(opts) {
      opts = opts || {};
      const handlers = {};
      const created = [];
      const body = { children: [], appendChild(n) { n.parentNode = body; body.children.push(n); }, removeChild(n) { body.children = body.children.filter((c) => c !== n); n.parentNode = null; } };
      const document = {
        body, readyState: 'complete',
        createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, querySelector() { return null; } }; created.push(n); return n; },
        addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      };
      const writes = [], reads = { invoices: 0, getDoc: 0 }, toasts = [];
      const win = {
        document, _leads: opts.leads || [], _userClaims: opts.claims || {}, _user: { uid: 'u1' },
        NBDFlags: { enabled: (n) => !!opts.flag && n === 'monthClose' },
        NBDMonthCloseLogic: P,
        NBDRevenue: { paymentsOf, status: () => 'ok', cached: () => opts.invoices || [], loadInvoices: async () => { reads.invoices++; return opts.invoices || []; } },
        Expenses: { list: () => opts.expenses || [] },
        showToast: (m, t) => toasts.push([m, t]),
        db: {}, doc: (db, c, id) => ({ c, id }), serverTimestamp: () => 'SERVER_TS',
        getDoc: async () => { reads.getDoc++; return opts.saved ? { exists: () => true, data: () => opts.saved } : { exists: () => false, data: () => null }; },
        setDoc: async (ref, data) => { writes.push({ ref, data }); },
        navigator: {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      };
      win.window = win;
      const ctx = { window: win, document, setTimeout: (f) => 0, console, Date, Promise, Math, JSON, parseInt, String, Object, Array, isFinite, Number, Blob: function () {} };
      vm.runInNewContext(SRC, ctx, { filename: 'month-close.js' });
      const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
      const target = (attrs, extra) => { const t = Object.assign({ getAttribute: (n) => (attrs[n] === undefined ? null : attrs[n]) }, extra || {}); t.closest = () => t; return t; };
      return {
        win, created, writes, reads, toasts, overlay: () => created[0],
        act: (a) => fire('click', { target: target({ 'data-mc-act': a }), preventDefault() {} }),
        num: (k, v) => fire('input', { target: target({ 'data-mc-num': k }, { value: v }) }),
        check: (id, on) => fire('change', { target: target({ 'data-mc-check': id }, { checked: on }) }),
        notes: (v) => fire('input', { target: target({ 'data-mc-notes': '1' }, { value: v }) }),
      };
    }
    const tick = () => new Promise((r) => setImmediate(r));
    const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

    const realNow = Date.now; Date.now = () => NOW;
    try {
      const leads = [{ id: 'L1', firstName: 'Sample', lastName: 'One', stage: 'closed' }];
      const invs = [inv('L1', [[1840, D(2026, 9, 12)]]), inv(null, [[100, D(2026, 9, 14)]])];
      const exps = [{ costType: 'direct', amountCents: 91000, date: D(2026, 9, 11), leadId: 'L1' }, { costType: 'overhead', amountCents: 12000, date: D(2026, 9, 11) }];

      let e = boot({ flag: false, claims: { role: 'company_admin', companyId: 'co' }, leads, invoices: invs, expenses: exps });
      ok('flag off: panel is empty, open() refuses', e.win.NBDMonthClose.panelHtml() === '' && e.win.NBDMonthClose.open() === false);
      e.act('open'); await flush();
      ok('flag off: no element, no read, no write', e.created.length === 0 && e.reads.invoices === 0 && e.reads.getDoc === 0 && e.writes.length === 0);

      e = boot({ flag: true, claims: { role: 'sales_rep', companyId: 'co' }, leads, invoices: invs, expenses: exps });
      e.act('open'); await flush();
      ok('a sales rep gets nothing even with the flag on', e.win.NBDMonthClose.panelHtml() === '' && e.created.length === 0 && e.reads.invoices === 0);

      e = boot({ flag: true, claims: { role: 'company_admin', companyId: 'co' }, leads, invoices: invs, expenses: exps });
      ok('owner with the flag on sees the panel button', /data-mc-act="open"/.test(e.win.NBDMonthClose.panelHtml()));
      ok('no reads until it is opened', e.reads.invoices === 0 && e.reads.getDoc === 0);
      e.act('open'); await flush();
      let html = e.overlay().innerHTML;
      ok('opens on LAST month (September 2026) and shows its collected', /value="2026-09"/.test(html) && /\$1,940\.00/.test(html), html.slice(0, 300));
      ok('shows direct costs, the logged overhead and the "no job" payment flag', /\$910\.00/.test(html) && /\$120\.00/.test(html) && /Payments this month with no job/.test(html));
      ok('cash payouts and the auditor read "not enabled" when those tools are off', (html.match(/not enabled/g) || []).length >= 2);
      ok('no inline handlers, no script in the markup', !/\son[a-z]+\s*=/i.test(html) && !/<script/i.test(html));
      ok('nothing is hard-coded in the rate box', /data-mc-num="rate"[^>]*placeholder="enter your rate"/.test(html) && /data-mc-num="rate"[^>]*value=""|value=""[^>]*data-mc-num="rate"/.test(html));
      ok('the CPA caution is on the screen', /confirm with the cpa/i.test(html));
      ok('no write has happened yet', e.writes.length === 0);

      e.num('overhead', '1200'); e.num('deposits', '1790'); e.num('rate', '25');
      e.check('collected', true); e.notes('synthetic note');
      e.act('save'); await flush();
      ok('exactly one setDoc to monthCloses/co_2026-09', e.writes.length === 1 && e.writes[0].ref.c === 'monthCloses' && e.writes[0].ref.id === 'co_2026-09', JSON.stringify(e.writes.map((w) => w.ref)));
      const d = e.writes[0] && e.writes[0].data;
      ok('totals: collected 1940, direct 910, overhead 1200, profit -170 -> set-aside 0 on a loss', d && d.totals.collectedCents === 194000 && d.totals.directCents === 91000 && d.totals.overheadCents === 120000 && d.totals.profitCents === 194000 - 91000 - 120000 && d.totals.setAsideCents === 0 && d.totals.depositsCents === 179000 && d.totals.rateBp === 2500, JSON.stringify(d && d.totals));
      ok('checked items, notes, stamps and a one-entry log', d && d.checks.collected === true && d.notes === 'synthetic note' && d.updatedBy === 'u1' && d.updatedAt === 'SERVER_TS' && d.editLog.length === 1);
      ok('nothing else was written anywhere', e.writes.every((w) => w.ref.c === 'monthCloses'));

      e = boot({ flag: true, claims: { role: 'company_admin', companyId: 'co' }, leads, invoices: invs, expenses: [] });
      e.act('open'); await flush(); e.num('rate', '25abc'); e.act('save'); await flush();
      ok('a typo in the rate blocks the save and says why', e.writes.length === 0 && e.toasts.some((t) => /Rate must be/.test(t[0])));

      for (const role of ['viewer', 'manager']) {
        e = boot({ flag: true, claims: { role, companyId: 'co' }, leads, invoices: invs, expenses: exps });
        e.act('open'); await flush();
        ok(role + ' gets nothing: no panel, open() refuses, no element, no read, no write', e.win.NBDMonthClose.panelHtml() === '' && e.win.NBDMonthClose.open() === false && e.created.length === 0 && e.reads.invoices === 0 && e.reads.getDoc === 0 && e.writes.length === 0);
        e.num('rate', '25'); e.act('save'); await flush();
        ok(role + ' cannot write even by firing events', e.writes.length === 0);
      }
      ok('1000 expenses newest-first that all post-date the month are flagged incomplete; 999, or a list reaching back before it, is not', (() => {
        const mk = (n, d0) => Array.from({ length: n }, (_, i) => ({ costType: 'direct', amountCents: 1, date: new Date(d0.getTime() + i * 3600000) }));
        return P.expensesTruncated(mk(1000, ET('2026-10-02T12:00:00Z')), '2026-09') === true && P.expensesTruncated(mk(999, ET('2026-10-02T12:00:00Z')), '2026-09') === false
          && P.expensesTruncated(mk(1000, ET('2026-08-02T12:00:00Z')), '2026-09') === false && P.expensesTruncated(mk(1000, ET('2026-09-05T12:00:00Z')), '2026-09') === true && P.expensesTruncated(mk(1000, ET('2026-10-02T12:00:00Z')), '2026-12') === false;
      })());
      {
        const many = Array.from({ length: 1000 }, (_, i) => ({ costType: 'direct', amountCents: 1, date: new Date(ET('2026-10-02T12:00:00Z').getTime() + i * 3600000), leadId: 'L1' }));
        e = boot({ flag: true, claims: { role: 'company_admin', companyId: 'co' }, leads, invoices: invs, expenses: many });
        e.act('open'); await flush(); e.num('rate', '25'); e.act('save'); await flush();
        ok('a capped expense list shows the banner and blocks Save', /may reach past them/.test(e.overlay().innerHTML) && e.writes.length === 0 && e.toasts.some((x) => /incomplete/.test(x[0])));
      }

      e = boot({ flag: true, claims: { role: 'company_admin', companyId: 'co' }, leads, invoices: invs, expenses: exps,
        saved: { totals: { collectedCents: 100, directCents: 91000, refundsCents: 0, overheadCents: 5000, depositsCents: 7000, rateBp: 2250, profitCents: 0, grossCents: 100, setAsideCents: 0 }, checks: { costs: true }, explain: { deposits: 'saved text' }, notes: 'reopened', updatedAt: D(2026, 10, 2) } });
      e.act('open'); await flush();
      html = e.overlay().innerHTML;
      ok('reopening restores the saved entries', /value="50\.00"/.test(html) && /value="70\.00"/.test(html) && /value="22\.5"/.test(html) && /saved text/.test(html) && /reopened/.test(html));
      ok('and warns that collected moved since it was saved', /have changed since this close was saved/.test(html));

      e = boot({ flag: true, claims: { role: 'company_admin', companyId: 'co' }, leads, invoices: [], expenses: [] });
      e.win.NBDRevenue.cached = () => null;
      e.act('open'); await flush();
      ok('if payments could not be read it says so instead of showing $0.00 collected', /could not be read/.test(e.overlay().innerHTML) && !/Collected \(payments in/.test(e.overlay().innerHTML));
    } finally { Date.now = realNow; }
  }

  console.log('\n12. source wiring');
  {
    const logic = stripComments(read('docs/pro/js/month-close-logic.js'));
    const ui = stripComments(read('docs/pro/js/month-close.js'));
    const css = read('docs/pro/css/month-close.css');
    ok('no inline handlers or inline script in the UI source', !/\bon(click|change|input|submit)\s*=/.test(ui) && !/<script/i.test(ui));
    ok('no tax rate or due date is hard-coded in the math (only the editable suggestion list)', !/rateBp\s*[:=]\s*\d/.test(logic) && !/rate\s*[:=]\s*0?\.\d/.test(logic));
    ok('no network call and no message sender anywhere in the screen', !/fetch\(|XMLHttpRequest|sendBeacon|httpsCallable|mailto:|sms:/.test(ui + logic));
    ok('the only Firestore write is setDoc on monthCloses', (ui.match(/\b(setDoc|updateDoc|addDoc|deleteDoc)\b/g) || []).every((x) => x === 'setDoc') && /'monthCloses'/.test(ui));
    ok('script-loader ships the three files inside the expenses bundle, logic before the screen', (() => { const s = read('docs/pro/js/script-loader.js'); const a = s.indexOf('js/month-close-logic.js'), b = s.indexOf('js/month-close.js'); return a > 0 && b > a && s.indexOf('css/month-close.css') > 0; })());
    ok('the Expenses view mounts the panel', /NBDMonthClose\.panelHtml\(\)/.test(read('docs/pro/js/expenses.js')));
    ok('rules: monthCloses block exists with owner-only create/update', (() => { const r = read('firestore.rules'); return /match \/monthCloses\/\{closeId\}/.test(r) && /monthCloseOwnerOk\(request\.resource\.data\.companyId\)/.test(r) && /monthCloseOwnerOk\(resource\.data\.companyId\)/.test(r); })());
    ok('phone fit: 16px inputs and a one-column fallback', /font-size: 16px; min-height: 44px/.test(css) && /@media \(max-width: 480px\)/.test(css));
    ok('no real names or figures in the repo files (synthetic only)', !/Jonathan|Joe Deal|Chase|Chime/i.test(ui + logic + css));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
