/**
 * tests/month-close-2026-10-01.test.js — "Close last month" card on #/money.
 *
 * Jo's idea triage ("Bookkeeper agent: on the 1st, categorize receipts and
 * close the month"), built as an in-app checklist: MoneyDashboard.monthClose()
 * is pure; the card renders through esc(); the button stores the close on
 * userSettings/{uid}.monthCloses[YYYY-MM]. Nothing automatic, nothing sent.
 *
 * Pins:
 *   - previous calendar month in America/New_York (11:30pm Sep 30 ET counts
 *     for September; 12:30am Oct 1 ET does not), incl. the Jan → Dec rollover
 *   - collected = the shared paymentsOf() ledger (refunds off, failed refunds
 *     ignored, deleted invoices skipped) — cross-checked against
 *     NBDRevenue.collectedBetween over the same ET window
 *   - expenses in cents incl. tax and legacy dollar `amount`
 *   - uncategorized / untied direct / missing receipt / unpaid lists
 *   - net sign, prominence rules, esc() on render, the persisted close
 *
 * Run: node tests/month-close-2026-10-01.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

const JS = path.join(__dirname, '..', 'docs/pro/js');
function loadIIFE(file) {
  const src = fs.readFileSync(path.join(JS, file), 'utf8');
  const win = { addEventListener() {}, dispatchEvent() {}, location: { pathname: '/pro/dashboard' } };
  win.window = win;
  const doc = { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const sandbox = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
  vm.runInNewContext(src, sandbox, { filename: file });
  return { win, doc, src };
}

const { win, src } = loadIIFE('money-dashboard.js');
const MD = win.MoneyDashboard;
const REV = loadIIFE('collected-revenue.js').win.NBDRevenue;

console.log('MONTH CLOSE — monthClose()');
ok('MoneyDashboard.monthClose exported', !!(MD && typeof MD.monthClose === 'function'));
ok('MoneyDashboard.markMonthClosed exported', !!(MD && typeof MD.markMonthClosed === 'function'));

const ET = (s) => new Date(s); // ISO strings below carry the -04:00 EDT offset
const NOW = ET('2026-10-01T12:00:00-04:00');

const data = {
  invoices: [
    // 11:30pm Sep 30 ET (03:30Z Oct 1) — September
    { id: 'I1', leadId: 'L1', total: 1000, balanceDue: 0, status: 'paid', payments: [{ amount: 1000, at: ET('2026-09-30T23:30:00-04:00') }] },
    // 12:30am Oct 1 ET — October, not September
    { id: 'I2', leadId: 'L2', total: 700, balanceDue: 0, status: 'paid', payments: [{ amount: 700, at: ET('2026-10-01T00:30:00-04:00') }] },
    // 11:30pm Aug 31 ET (03:30Z Sep 1) — August
    { id: 'I3', total: 50, balanceDue: 0, status: 'paid', payments: [{ amount: 50, at: ET('2026-08-31T23:30:00-04:00') }] },
    // Sep payment with a succeeded Sep refund (-200) and a failed one (ignored)
    { id: 'I4', leadId: 'L4', total: 400, balanceDue: 0, status: 'paid', payments: [{ amount: 400, at: ET('2026-09-10T10:00:00-04:00') }],
      refunds: [{ amount: 200, at: ET('2026-09-12T10:00:00-04:00'), status: 'succeeded' }, { amount: 99, at: ET('2026-09-12T10:00:00-04:00'), status: 'failed' }] },
    // legacy lump (no payments[]) dated paidAt (Firestore {seconds} shape)
    { id: 'I5', total: 500, balanceDue: 0, status: 'paid', paidAt: { seconds: Math.floor(ET('2026-09-15T12:00:00-04:00').getTime() / 1000) } },
    // deleted invoice — skipped, as collected-revenue.js skips it
    { id: 'I6', deleted: true, total: 9999, balanceDue: 0, status: 'paid', payments: [{ amount: 9999, at: ET('2026-09-20T12:00:00-04:00') }] },
    // unpaid, sent in September — listed
    { id: 'I7', leadId: 'L7', customerName: 'Pat <b>Smith</b>', total: 300, balanceDue: 300, status: 'sent', sentAt: ET('2026-09-20T12:00:00-04:00') },
    // unpaid, no sentAt, non-draft created in September — listed (createdAt fallback)
    { id: 'I8', customerName: 'Lee', total: 120, status: 'overdue', createdAt: ET('2026-09-02T09:00:00-04:00') },
    // draft created in September — not "sent"
    { id: 'I9', customerName: 'Draft', total: 80, balanceDue: 80, status: 'draft', createdAt: ET('2026-09-05T09:00:00-04:00') },
    // unpaid but sent in August — not last month's
    { id: 'I10', customerName: 'Old', total: 60, balanceDue: 60, status: 'sent', sentAt: ET('2026-08-28T09:00:00-04:00') },
    // sent in September and cancelled — not chased
    { id: 'I11', customerName: 'Gone', total: 60, balanceDue: 60, status: 'cancelled', sentAt: ET('2026-09-28T09:00:00-04:00') },
  ],
  expenses: [
    { id: 'E1', category: 'materials', costType: 'direct', amountCents: 10000, taxCents: 600, leadId: 'L1', supplier: 'ABC Supply', receiptStoragePath: 'receipts/u/1.jpg', date: ET('2026-09-30T23:30:00-04:00') },
    // legacy dollar amount, no category, no receipt, overhead
    { id: 'E2', category: '', costType: 'overhead', amount: '25.50', supplier: 'Gas Station', date: ET('2026-09-03T08:00:00-04:00') },
    // direct with no lead (untied), receiptUrl counts as a receipt
    { id: 'E3', category: 'subcontractor', costType: 'direct', amountCents: 50000, supplier: 'Crew Co', receiptUrl: 'https://x/y', date: ET('2026-09-18T08:00:00-04:00') },
    // 'other' category = needs a category; attachments count as a receipt
    { id: 'E4', category: 'other', costType: 'overhead', amountCents: 1999, note: 'misc', attachments: [{ path: 'a' }], date: { seconds: Math.floor(ET('2026-09-09T08:00:00-04:00').getTime() / 1000) } },
    // mileage — never flagged for a missing receipt
    { id: 'E5', category: 'mileage', costType: 'overhead', amountCents: 3500, supplier: 'Mileage', date: ET('2026-09-11T08:00:00-04:00') },
    // October (12:30am Oct 1 ET) — excluded
    { id: 'E6', category: 'materials', costType: 'direct', amountCents: 77700, supplier: 'Late', date: ET('2026-10-01T00:30:00-04:00') },
    // August — excluded
    { id: 'E7', category: 'materials', costType: 'direct', amountCents: 88800, supplier: 'Early', date: ET('2026-08-31T23:30:00-04:00') },
    // direct, uncategorized, untied, no receipt — on all three lists
    { id: 'E8', category: 'uncategorized', costType: 'direct', amountCents: 1234, supplier: '<img src=x onerror=alert(1)>', date: ET('2026-09-25T08:00:00-04:00') },
  ],
};

const mc = MD.monthClose(data, NOW);
eq('previous month key', mc.monthKey, '2026-09');
eq('month label', mc.monthLabel, 'September 2026');
eq('day of month (ET)', mc.dayOfMonth, 1);

// Collected: I1 1000 + I4 (400 − 200) + I5 500 = 1700.00
eq('collected: 11:30pm Sep 30 ET in, 12:30am Oct 1 ET out, refund off, failed refund ignored, deleted skipped', mc.collectedCents, 170000);
const sepStart = ET('2026-09-01T00:00:00-04:00').getTime();
const sepEnd = ET('2026-10-01T00:00:00-04:00').getTime() - 1;
const revCents = Math.round(REV.collectedBetween(data.invoices, sepStart, sepEnd).total * 100);
eq('collected matches NBDRevenue.collectedBetween over the same ET month', mc.collectedCents, revCents);

// Expenses: E1 10600 + E2 2550 + E3 50000 + E4 1999 + E5 3500 + E8 1234 = 69883
eq('expenses in cents incl. tax and legacy dollar amount', mc.expensesCents, 69883);
eq('direct split', mc.directCents, 10600 + 50000 + 1234);
eq('overhead split', mc.overheadCents, 2550 + 1999 + 3500);
eq('net = collected − expenses', mc.netCents, 170000 - 69883);
ok('net positive here', mc.netCents > 0);

eq('category breakdown: materials, subcontractor, uncategorized, mileage', mc.categories.length, 4);
const six = MD.monthClose({ expenses: ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => ({ id: k, category: k, costType: 'overhead', amountCents: (i + 1) * 100, receiptStoragePath: 'r', date: ET('2026-09-05T08:00:00-04:00') })) }, NOW);
eq('category breakdown capped at top 5', six.categories.length, 5);
eq('top-5 sorted by spend, smallest dropped', six.categories.map((c) => c.category).join(','), 'f,e,d,c,b');
eq('top category is subcontractor', mc.categories[0].category, 'subcontractor');
const unc = mc.categories.find((c) => c.category === 'uncategorized');
ok('uncategorized bucket = blank + other + uncategorized (2550+1999+1234)', !!unc && unc.cents === 2550 + 1999 + 1234);

const ids = (l) => l.map((x) => x.id).join(',');
eq('needs a category (blank, other, uncategorized; date-sorted)', ids(mc.uncategorized), 'E2,E4,E8');
eq('direct costs not tied to a job', ids(mc.untiedDirect), 'E3,E8');
eq('missing receipts (mileage exempt; receiptUrl/attachments count)', ids(mc.missingReceipts), 'E2,E8');
eq('unpaid invoices sent last month (draft/cancelled/August excluded)', ids(mc.unpaidInvoices), 'I8,I7');
const e2 = mc.uncategorized[0];
eq('item label from supplier', e2.label, 'Gas Station');
eq('item amountCents', e2.amountCents, 2550);
eq('item date is the ET calendar date', e2.date, '2026-09-03');
eq('E1 dated 11:30pm Sep 30 ET counts as Sep 30', mc.categories.some((c) => c.category === 'materials' && c.cents === 10600), true);
const i7 = mc.unpaidInvoices.find((x) => x.id === 'I7');
eq('unpaid item carries balance in cents', i7.amountCents, 30000);
eq('unpaid item carries leadId for the customer link', i7.leadId, 'L7');
const i8 = mc.unpaidInvoices.find((x) => x.id === 'I8');
eq('unpaid with no balanceDue falls back to total', i8.amountCents, 12000);

// Net negative
const neg = MD.monthClose({ invoices: [], expenses: [{ id: 'X', category: 'materials', costType: 'direct', amountCents: 5000, leadId: 'L', receiptStoragePath: 'r', date: ET('2026-09-05T08:00:00-04:00') }] }, NOW);
eq('net negative when spend beats collected', neg.netCents, -5000);
eq('clean month has empty lists', neg.uncategorized.length + neg.untiedDirect.length + neg.missingReceipts.length + neg.unpaidInvoices.length, 0);

// Year rollover + prominence
const jan = MD.monthClose({}, ET('2027-01-05T09:00:00-05:00'));
eq('January → December of the prior year', jan.monthKey, '2026-12');
eq('December label', jan.monthLabel, 'December 2026');
// 11:30pm Oct 31 ET is still October locally — previous month is September
eq('late-evening ET date uses ET, not UTC', MD.monthClose({}, ET('2026-10-31T23:30:00-04:00')).monthKey, '2026-09');
ok('prominent on the 1st while open', mc.prominent === true && mc.closed === false);
eq('not prominent after the 10th (collapses to a small link)', MD.monthClose(data, ET('2026-10-11T09:00:00-04:00')).prominent, false);
eq('prominent on the 10th', MD.monthClose(data, ET('2026-10-10T20:00:00-04:00')).prominent, true);
const closedMc = MD.monthClose(Object.assign({}, data, { monthCloses: { '2026-09': { closedAt: new Date() } } }), NOW);
ok('a stored close marks the month closed and un-prominent', closedMc.closed === true && closedMc.prominent === false);
eq('a close for another month does not count', MD.monthClose(Object.assign({}, data, { monthCloses: { '2026-08': {} } }), NOW).closed, false);

console.log('MONTH CLOSE — render');
const html = MD.monthCloseHtml(mc);
ok('card titled "Close September 2026"', html.indexOf('Close September 2026') !== -1);
ok('supplier label escaped (no raw <img)', html.indexOf('<img') === -1 && html.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1);
ok('customer name escaped (no raw <b>)', html.indexOf('<b>Smith') === -1 && html.indexOf('Pat &lt;b&gt;Smith&lt;/b&gt;') !== -1);
ok('"collected money only" note', html.indexOf('collected money only') !== -1);
ok('counts: "3 expenses need a category"', html.indexOf('3 expenses need a category') !== -1);
ok("counts: \"2 direct costs aren't tied to a job\" (escaped apostrophe)", html.indexOf('2 direct costs aren&#39;t tied to a job') !== -1);
ok('counts: "2 missing receipts"', html.indexOf('2 missing receipts') !== -1);
ok('counts: "2 invoices from last month still unpaid"', html.indexOf('2 invoices from last month still unpaid') !== -1);
ok('tidy-up lists collapsed by default (no nested open <details>)', (html.match(/<details[^>]*\sopen/g) || []).length === 1);
ok('card open on the 1st', /<details id="nbd-month-close"[^>]*\sopen/.test(html));
ok('unpaid invoice links to its customer page', html.indexOf('/pro/customer.html?id=L7') !== -1);
ok('expenses link to the Expenses view', html.indexOf('href="#/expenses"') !== -1);
ok('close button wired via data-action="module" (no inline handler)', html.indexOf('data-target="MoneyDashboard.markMonthClosed" data-arg="2026-09"') !== -1 && !/\son[a-z]+=/i.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')));
ok('button copy', html.indexOf('Looks good — mark September closed') !== -1);
ok('net colored by sign (green here)', /Net<\/div><div style="[^"]*color:var\(--green\)/.test(html));
ok('net red when negative', /Net<\/div><div style="[^"]*color:var\(--red\)/.test(MD.monthCloseHtml(neg)));
ok('no old orange literal', !/#E8720C/i.test(html));
const closedHtml = MD.monthCloseHtml(closedMc);
ok('closed state shows "September closed ✓" and no button', closedHtml.indexOf('September closed ✓') !== -1 && closedHtml.indexOf('markMonthClosed') === -1);
ok('closed state collapsed', !/<details id="nbd-month-close"[^>]*\sopen/.test(closedHtml));

// Source pins: the card's values go through esc(); render() includes it.
const cardSrc = src.slice(src.indexOf('function closeItemHtml'), src.indexOf('function monthCloseHtml') + 6000);
ok('item label rendered via esc(it.label)', cardSrc.indexOf('esc(it.label)') !== -1);
ok('category label rendered via esc(catLabel(', cardSrc.indexOf('esc(catLabel(c.category))') !== -1);
ok('render() mounts the month-close card', src.indexOf('html += monthCloseHtml(m.monthClose);') !== -1);

console.log('MONTH CLOSE — persisting the close');
(async () => {
  const calls = [];
  win._user = { uid: 'u1' };
  win.db = { _fake: true };
  win.doc = (db, coll, id) => ({ path: coll + '/' + id });
  win.setDoc = async (ref, patch, opts) => { calls.push({ ref, patch, opts }); };
  win.serverTimestamp = () => '__ts__';
  MD._setLastData(JSON.parse(JSON.stringify({ invoices: [], expenses: [], monthCloses: {} })));
  const res = await MD.markMonthClosed('2026-09');
  eq('markMonthClosed resolves true', res, true);
  eq('one settings write', calls.length, 1);
  eq('writes userSettings/{uid}', calls[0] && calls[0].ref.path, 'userSettings/u1');
  ok('merge:true (other months/settings untouched)', !!(calls[0] && calls[0].opts && calls[0].opts.merge === true));
  ok('stores monthCloses["2026-09"] with closedAt', !!(calls[0] && calls[0].patch.monthCloses && calls[0].patch.monthCloses['2026-09'] && calls[0].patch.monthCloses['2026-09'].closedAt === '__ts__'));
  eq('only the monthCloses field is written', Object.keys(calls[0].patch).join(','), 'monthCloses');
  const bad = await MD.markMonthClosed('not-a-month');
  ok('rejects a malformed month key without writing', bad === false && calls.length === 1);
  win.setDoc = async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); };
  eq('a failed write resolves false', await MD.markMonthClosed('2026-09'), false);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
