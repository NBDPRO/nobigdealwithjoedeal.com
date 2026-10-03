/**
 * tests/money-dashboard.test.js — pure P&L computation for the #/money view.
 * Loads money-dashboard.js in a vm sandbox and exercises computePnL (no DOM/FB).
 * Run: node tests/money-dashboard.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

function loadIIFE(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', file), 'utf8');
  const win = { addEventListener() {}, location: { pathname: '/pro/dashboard' } };
  win.window = win;
  // doc returned separately (not just win) so a test can swap in a fake
  // #view-money .view-scroll element AFTER load and exercise render() for
  // real — the module closes over this same `document` binding, so
  // mutating doc.querySelector post-load still reaches it.
  const doc = { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const sandbox = {
    window: win,
    document: doc,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(src, sandbox, { filename: file });
  return { win, doc };
}

const { win, doc } = loadIIFE('money-dashboard.js');
const MD = win.MoneyDashboard;

console.log('MONEY DASHBOARD — computePnL');
ok('MoneyDashboard.computePnL exported', !!(MD && MD.computePnL));

const data = {
  year: 2026,
  leads: [
    { id: 'L1', _stageKey: 'closed', jobValue: 20000 }, // won + costed
    { id: 'L2', _stageKey: 'closed', jobValue: 10000 }, // won, NOT costed (excluded from margin)
    { id: 'L3', _stageKey: 'new', jobValue: 5000 },     // not won
  ],
  expenses: [
    { category: 'materials', costType: 'direct', amountCents: 500000, leadId: 'L1', supplier: 'ABC', date: new Date(2026, 1, 1) },
    { category: 'subcontractor', costType: 'direct', amountCents: 300000, supplier: 'Crew Co, LLC', date: new Date(2026, 2, 1) }, // no leadId; name VARIANT (tests normVendor)
    { category: 'marketing', costType: 'overhead', amountCents: 100000, supplier: 'Google', date: new Date(2026, 1, 1) },
    { category: 'materials', costType: 'direct', amountCents: 999, supplier: 'Old', date: new Date(2025, 1, 1) }, // prior year — excluded
  ],
  invoices: [
    { status: 'paid', paidAt: new Date(2026, 2, 1), total: 12000 },
    { status: 'paid', paidAt: new Date(2025, 2, 1), total: 5000 }, // prior year — excluded from collected
    { status: 'sent', total: 4000, balanceDue: 4000 },             // fully outstanding
    // REAL partial-deposit shape markPaid/webhook produce: status stays 'sent'
    // (not 'partial'), paidAt is NULL (only set on full payoff), lastPaymentAt
    // carries the receipt date. The old fixture faked {status:'partial',
    // paidAt:set} — a shape the code never writes — which false-greened the
    // paidAt-gated Collected bug (deposits invisible). $600 collected, $400 due.
    { status: 'sent', total: 1000, balanceDue: 400, amountPaid: 600, lastPaymentAt: new Date(2026, 3, 1) },
  ],
  suppliers: [
    { displayName: 'Crew Co', is1099Eligible: true, w9Status: 'received' }, // YTD sub $3000 >= $2000 -> 1099 due
    { displayName: 'ABC', is1099Eligible: false, w9Status: 'verified' },    // materials supplier, not eligible
  ],
};
const m = MD.computePnL(data);

console.log('  cash:');
eq('collected 2026: $12,000 + $600 partial = $12,600', m.collectedCents, 1260000);
eq('spent 2026 only ($9,000; prior-year excluded)', m.spentCents, 900000);
eq('net cash = collected - spent', m.netCashCents, 360000);
eq('outstanding A/R: $4,000 + $400 partial balance', m.outstandingCents, 440000);
console.log('  COGS / overhead:');
eq('COGS = direct (materials+sub)', m.cogsCents, 800000);
eq('overhead', m.overheadCents, 100000);
console.log('  job profitability:');
eq('won contract value (costed jobs only)', m.wonContractCents, 2000000);
eq('won direct (by-lead, only L1)', m.wonDirectCents, 500000);
eq('gross margin 75%', m.grossMargin, 75);
eq('costed jobs', m.costedJobs, 1);
eq('won jobs total', m.wonJobs, 2);
console.log('  suppliers / 1099:');
eq('top supplier is ABC', m.topSuppliers[0].supplier, 'ABC');
eq('supplier count (this year)', m.supplierCount, 3);
eq('1099 due count', m.due1099, 1);
eq('1099 due service $ (Crew Co $3,000)', m.due1099Cents, 300000);
eq('2026 threshold is $2,000', m.thresholdCents, 200000);

// empty safety
const empty = MD.computePnL({});
eq('empty collected 0', empty.collectedCents, 0);
eq('empty gross margin null', empty.grossMargin, null);

// ── tax-included COGS + normVendor collapse (product decision 2026-07-08) ──
console.log('  tax-included spend/COGS + supplier normVendor:');
const t = MD.computePnL({
  year: 2026,
  leads: [{ id: 'J1', _stageKey: 'closed', jobValue: 10000 }],
  invoices: [], suppliers: [],
  expenses: [
    // same vendor two spellings → ONE supplier row; tax rides into spend/COGS
    { category: 'materials', costType: 'direct', amountCents: 100000, taxCents: 8000, leadId: 'J1', supplier: 'ABC Supply', date: new Date(2026, 5, 1) },
    { category: 'materials', costType: 'direct', amountCents: 50000, taxCents: 4000, leadId: 'J1', supplier: 'abc supply ', date: new Date(2026, 6, 1) },
  ],
});
eq('spent = amount + tax', t.spentCents, 162000);
eq('COGS = amount + tax', t.cogsCents, 162000);
eq('won direct (per-job) includes tax', t.wonDirectCents, 162000);
eq('two spellings collapse to ONE supplier row', t.supplierCount, 1);
eq('supplier label = first-seen raw name', t.topSuppliers[0].supplier, 'ABC Supply');
eq('supplier total includes tax', t.topSuppliers[0].cents, 162000);

// ── ET-year bucketing (#11): 2026-01-01T00:30Z is 2025-12-31 in ET ──
console.log('  ET-year boundary:');
const etData = MD.computePnL({
  year: 2026, leads: [], invoices: [], suppliers: [],
  expenses: [{ category: 'materials', costType: 'direct', amountCents: 10000, supplier: 'X', date: new Date('2026-01-01T00:30:00Z') }],
});
eq('Jan-1 00:30 UTC buckets to 2025 in ET → excluded from 2026 spend', etData.spentCents, 0);

// ── stageRole precedence (freeform-pipeline foundation) ──
// isWon() reads the denormalized _stageRole first (custom-stage-safe), and
// only falls back to the legacy WON_STAGES key list when it's absent.
console.log('  stageRole precedence:');
const roleData = MD.computePnL({
  year: 2026, invoices: [], suppliers: [], expenses: [
    { category: 'materials', costType: 'direct', amountCents: 100000, leadId: 'CU', date: new Date(2026, 5, 1) },
  ],
  leads: [
    // custom won stage (unknown key) counts as won via _stageRole
    { id: 'CU', _stageKey: 'my_custom_done', _stageRole: 'won', jobValue: 10000 },
    // legacy-won key but role says active → NOT won (tenant remapped it)
    { id: 'RM', _stageKey: 'closed', _stageRole: 'active', jobValue: 99999 },
    // no _stageRole → falls back to the legacy key list (closed = won)
    { id: 'LG', _stageKey: 'closed', jobValue: 5000 },
  ],
});
eq('custom won-role stage is counted (wonJobs incl CU + LG, not RM)', roleData.wonJobs, 2);
eq('custom won lead contributes contract value', roleData.wonContractCents >= 1000000, true);

// ── Multi-payment cash ledger (post-sprint residual of #980/#990) ──
// A deposit in year Y and a balance payoff in year Y+1 must keep the deposit
// in Y's Collected — lastPaymentAt alone moves the whole invoice's cash to Y+1.
console.log('  multi-payment cash-basis dating:');
const multi = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [
    {
      status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
      // lastPaymentAt is the LATER payoff — must NOT pull the May deposit into 2027
      lastPaymentAt: new Date(2027, 6, 1),
      paidAt: new Date(2027, 6, 1),
      payments: [
        { amount: 4000, at: new Date(2026, 4, 15) }, // May 2026 deposit
        { amount: 6000, at: new Date(2027, 6, 1) },  // July 2027 balance
      ],
    },
  ],
});
eq('2026 collected = May deposit only ($4,000), not full invoice', multi.collectedCents, 400000);

const multi27 = MD.computePnL({
  year: 2027, leads: [], expenses: [], suppliers: [],
  invoices: [
    {
      status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
      lastPaymentAt: new Date(2027, 6, 1),
      paidAt: new Date(2027, 6, 1),
      payments: [
        { amount: 4000, at: new Date(2026, 4, 15) },
        { amount: 6000, at: new Date(2027, 6, 1) },
      ],
    },
  ],
});
eq('2027 collected = July balance only ($6,000)', multi27.collectedCents, 600000);

// Legacy single-lump still works when payments[] is absent.
const legacy = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [
    { status: 'sent', total: 1000, balanceDue: 400, amountPaid: 600, lastPaymentAt: new Date(2026, 3, 1) },
  ],
});
eq('legacy partial (no payments[]) still counts $600 in 2026', legacy.collectedCents, 60000);

// ── Transition reconciliation (mixed shape: pre-ledger partial + ledger) ──
// An invoice whose deposit predates the payments[] deploy has a ledger that
// sums SHORT of total−balanceDue. The missing cash must NOT vanish — a
// synthetic remainder entry (dated at the earliest ledger entry) keeps
// totals exact.
console.log('  transition reconciliation (pre-ledger partial + ledger entry):');
const mixedInvoice = {
  status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
  lastPaymentAt: new Date(2027, 6, 1),
  paidAt: new Date(2027, 6, 1),
  // Only the post-deploy payoff made it into the ledger; the $4,000
  // pre-ledger deposit has no entry.
  payments: [{ amount: 6000, at: new Date(2027, 6, 1) }],
};
const mixed27 = MD.computePnL({
  year: 2027, leads: [], expenses: [], suppliers: [], invoices: [mixedInvoice],
});
eq('mixed shape: 2027 collected = $10,000 (ledger $6,000 + synthetic $4,000 remainder)',
  mixed27.collectedCents, 1000000);

// 3-payment variant: the remainder dates at the EARLIEST ledger entry
// (tightest upper bound for pre-ledger cash), not lastPaymentAt.
const mixed3 = {
  status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
  lastPaymentAt: new Date(2027, 6, 1),
  paidAt: new Date(2027, 6, 1),
  payments: [
    { amount: 3000, at: new Date(2026, 5, 10) }, // June 2026 progress draw
    { amount: 6000, at: new Date(2027, 6, 1) },  // July 2027 payoff
  ],
  // $1,000 pre-ledger deposit missing from the ledger.
};
const mixed3y26 = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [], invoices: [mixed3],
});
eq('mixed 3-pay: 2026 = $4,000 ($3,000 ledger + $1,000 remainder dated at earliest ledger entry)',
  mixed3y26.collectedCents, 400000);
const mixed3y27 = MD.computePnL({
  year: 2027, leads: [], expenses: [], suppliers: [], invoices: [mixed3],
});
eq('mixed 3-pay: 2027 = $6,000 payoff only (remainder did not leak into 2027)',
  mixed3y27.collectedCents, 600000);

// Complete ledger: sums exactly to total−balanceDue → NO synthetic entry.
const complete = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [{
    status: 'paid', total: 5000, balanceDue: 0, amountPaid: 5000,
    lastPaymentAt: new Date(2026, 8, 1), paidAt: new Date(2026, 8, 1),
    payments: [
      { amount: 2000, at: new Date(2026, 2, 1) },
      { amount: 3000, at: new Date(2026, 8, 1) },
    ],
  }],
});
eq('complete ledger: no synthetic double-count ($5,000 exactly)', complete.collectedCents, 500000);

// Ledger OVER total−balanceDue (write-off / overpay row): no negative
// synthetic entry — the ledger stands as-is.
const over = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [{
    status: 'paid', total: 1000, balanceDue: 0, amountPaid: 1100,
    lastPaymentAt: new Date(2026, 2, 1), paidAt: new Date(2026, 2, 1),
    payments: [{ amount: 1100, at: new Date(2026, 2, 1) }],
  }],
});
eq('ledger over collected: no negative synthetic (ledger $1,100 stands)', over.collectedCents, 110000);

// A non-empty payments[] whose entries are ALL invalid (null date / bad
// amount) must fall through to the legacy lump — a refactor returning the
// (empty) filtered ledger unconditionally would zero this invoice's cash.
const nullLedger = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [{
    status: 'sent', total: 1000, balanceDue: 400, amountPaid: 600,
    lastPaymentAt: new Date(2026, 3, 1),
    payments: [{ amount: 600, at: null }],
  }],
});
eq('all-invalid ledger entries fall back to legacy lump ($600)', nullLedger.collectedCents, 60000);
const emptyLedger = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [{
    status: 'sent', total: 1000, balanceDue: 400, amountPaid: 600,
    lastPaymentAt: new Date(2026, 3, 1), payments: [],
  }],
});
eq('empty payments[] falls back to legacy lump ($600)', emptyLedger.collectedCents, 60000);

// Firestore-Timestamp-shaped 'at' ({seconds}) — the shape the Stripe
// webhook's entries deserialize to on the client. Exercises toJSDate in
// both the earliest-entry tracking and the year bucketing.
const ts = (y, m, d) => ({ seconds: Date.UTC(y, m, d, 12) / 1000 });
const tsMixed = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [{
    status: 'paid', total: 10000, balanceDue: 0, amountPaid: 10000,
    lastPaymentAt: ts(2027, 6, 1), paidAt: ts(2027, 6, 1),
    payments: [
      { amount: 3000, at: ts(2026, 5, 10) },
      { amount: 6000, at: ts(2027, 6, 1) },
    ],
  }],
});
eq('Timestamp-shaped mixed ledger: 2026 = $3,000 ledger + $1,000 remainder', tsMixed.collectedCents, 400000);

// Threshold boundary: a remainder of exactly 1 cent still reconciles
// (guard is >= 1 cent — an off-by-one or dollar-threshold would drop it).
const cent = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [{
    status: 'paid', total: 100, balanceDue: 0,
    lastPaymentAt: new Date(2026, 2, 1),
    payments: [{ amount: 99.99, at: new Date(2026, 2, 1) }],
  }],
});
eq('remainder of exactly 1 cent still reconciles ($100.00 total)', cent.collectedCents, 10000);

// Unparseable ledger date: entry keeps its cash in the ledger sum (so the
// synthetic stays $4,000, dated via the lastPaymentAt fallback since no
// entry parsed) but the $6,000 itself has no bucket in a dated P&L.
const garbled = MD.computePnL({
  year: 2026, leads: [], expenses: [], suppliers: [],
  invoices: [{
    status: 'paid', total: 10000, balanceDue: 0,
    lastPaymentAt: new Date(2026, 2, 1), paidAt: new Date(2026, 2, 1),
    payments: [{ amount: 6000, at: 'not-a-date' }],
  }],
});
eq('unparseable ledger date: synthetic $4,000 via lastPaymentAt fallback (undated $6,000 unbucketed)',
  garbled.collectedCents, 400000);

// ── Collections queue (2026-09-15 Collections foundation) ───────────────
// Pure logic (aging buckets, sort, inCollections flag) proved by real
// computePnL() execution with a PINNED clock (data.now) — day-count math
// via daysAgo(n) in raw ms so bucket boundaries are exact regardless of
// calendar month lengths or DST, matching the repo's stated preference for
// real execution over regex-shape assertions wherever it's practical.
console.log('  collections queue (aging buckets + per-invoice drill-down):');
const NOW = new Date(2026, 8, 15, 12, 0, 0); // pinned "now" — noon avoids any DST-edge ambiguity
function daysAgo(n) { return new Date(NOW.getTime() - n * 86400000); }
const cq = MD.computePnL({
  year: 2026, now: NOW, expenses: [], suppliers: [],
  leads: [
    { id: 'LC', _stageKey: 'collections', name: 'Already In Collections' },
    { id: 'LN', _stageKey: 'contract_signed', name: 'Not Yet' },
  ],
  invoices: [
    { id: 'invA', status: 'sent', total: 1000, balanceDue: 1000, dueDate: daysAgo(10), leadId: 'LN', customerName: 'Ten Days Late' },
    { id: 'invB', status: 'sent', total: 500, balanceDue: 500, dueDate: daysAgo(45), customerName: 'No Lead Linked' },
    { id: 'invC', status: 'sent', total: 200, balanceDue: 200, dueDate: daysAgo(90), leadId: 'LC', customerName: 'Already Chasing' },
    { id: 'invD', status: 'sent', total: 300, balanceDue: 300, dueDate: daysAgo(-5), leadId: 'LN', customerName: 'Not Due Yet' },
    { id: 'invPaid', status: 'paid', total: 999, balanceDue: 0, dueDate: daysAgo(200), leadId: 'LN' },
  ],
});
eq('aging: 1-30 bucket = $1,000 (invA, 10 days late)', cq.agingCents.d1_30, 100000);
eq('aging: 31-60 bucket = $500 (invB, 45 days late)', cq.agingCents.d31_60, 50000);
eq('aging: 60+ bucket = $200 (invC, 90 days late)', cq.agingCents.d61_plus, 20000);
eq('aging: current bucket = $300 (invD, not yet due)', cq.agingCents.current, 30000);
eq('paid invoice excluded from the queue entirely', cq.collectionsQueue.length, 4);
ok('queue sorted most-overdue-first (invC, invB, invA, ...)',
  cq.collectionsQueue[0].id === 'invC' && cq.collectionsQueue[1].id === 'invB' && cq.collectionsQueue[2].id === 'invA');
const invA = cq.collectionsQueue.find(q => q.id === 'invA');
const invB = cq.collectionsQueue.find(q => q.id === 'invB');
const invC = cq.collectionsQueue.find(q => q.id === 'invC');
eq('invA days past due = 10', invA.daysPastDue, 10);
eq('invC days past due = 90', invC.daysPastDue, 90);
ok('invoice linked to a lead ALREADY on collections is flagged inCollections', invC.inCollections === true);
ok('invoice linked to a lead NOT on collections is not flagged', invA.inCollections === false);
ok('invoice with no leadId falls back to its own customerName, leadId stays null',
  invB.customerName === 'No Lead Linked' && invB.leadId === null && invB.inCollections === false);
// estimate#9 (2026-09-25): real leads carry firstName/lastName, never `name`,
// and invoices made from estimates were saved with a blank customerName — so
// the queue's lead fallback has to read the name the lead actually stores.
const cqName = MD.computePnL({
  year: 2026, now: NOW, expenses: [], suppliers: [],
  leads: [{ id: 'LR', _stageKey: 'contract_signed', firstName: 'Mark', lastName: 'Deluca' }],
  invoices: [{ id: 'invBlank', status: 'sent', total: 100, balanceDue: 100, dueDate: daysAgo(3), leadId: 'LR', customerName: '' }],
});
eq('blank-name invoice queues under its lead\'s firstName + lastName, not "Customer"',
  cqName.collectionsQueue[0].customerName, 'Mark Deluca');

console.log('  aging bucket boundaries (0/1/30/31/60/61 days past due):');
const bd = MD.computePnL({
  year: 2026, now: NOW, expenses: [], suppliers: [], leads: [],
  invoices: [0, 1, 30, 31, 60, 61].map(n => ({ id: 'b' + n, status: 'sent', total: 10, balanceDue: 10, dueDate: daysAgo(n) })),
});
function bucketOf(id) { return bd.collectionsQueue.find(q => q.id === id).bucket; }
eq('0 days past due -> current', bucketOf('b0'), 'current');
eq('1 day past due -> d1_30', bucketOf('b1'), 'd1_30');
eq('30 days past due -> d1_30 (inclusive upper bound)', bucketOf('b30'), 'd1_30');
eq('31 days past due -> d31_60', bucketOf('b31'), 'd31_60');
eq('60 days past due -> d31_60 (inclusive upper bound)', bucketOf('b60'), 'd31_60');
eq('61 days past due -> d61_plus', bucketOf('b61'), 'd61_plus');

// empty-data safety (extends the existing empty-object assertions above)
eq('empty data: aging current is 0', empty.agingCents.current, 0);
eq('empty data: collections queue is []', empty.collectionsQueue.length, 0);

// ── render(): Collections queue markup, exercised for real ──────────────
// Swap in a fake #view-money .view-scroll AFTER load (loadIIFE returns the
// same `document` object the module already closed over) and call the
// real render() — catches an actual button/badge/link regression, not
// just a string that happens to appear somewhere in the source.
console.log('  render(): collections queue markup (real execution, not regex-on-source):');
const scrollEl = { innerHTML: '' };
doc.querySelector = (sel) => (sel === '#view-money .view-scroll' ? scrollEl : null);
MD.render(cq);
const rendered = scrollEl.innerHTML;
ok('overdue + actionable invoice (invA) gets a Move to Collections button keyed by its own id',
  rendered.includes('data-action="module"') && rendered.includes('data-target="MoneyDashboard.moveToCollections"') && rendered.includes('data-arg="invA"'));
ok('invoice already on the collections stage (invC) shows the badge, not a button',
  rendered.includes('In Collections') && !rendered.includes('data-arg="invC"'));
ok('invoice with no linked lead (invB) gets no action button (nothing to move)', !rendered.includes('data-arg="invB"'));
ok('overdue customer name links to the customer page by leadId', rendered.includes('/pro/customer.html?id=LN'));
ok('not-yet-due invoice (invD) is excluded from the overdue rows, only counted in the Current tile',
  !rendered.includes('data-arg="invD"') && rendered.includes('$300'));

// ── moveToCollections() + fetchData wiring (source-text) ────────────────
// moveToCollections's own body does a dynamic import('./stage-write.js'),
// which Node's vm.runInNewContext can't execute without extra module-loader
// plumbing this sandbox doesn't have — same constraint crm-pipeline.js's
// moveCard()/customer-bootstrap's progressStage() hit. Prove the WIRING
// (correct target, correct args, correct query) via source text instead,
// same fallback the Phase 2 driven-UX tests used for this exact class of
// dynamic-import call site.
console.log('  moveToCollections()/fetchData wiring (source-text — dynamic import(), can\'t vm-execute):');
const mdSrc = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/money-dashboard.js'), 'utf8');
ok('moveToCollections is exported on window.MoneyDashboard (the data-action="module" target)',
  /moveToCollections:\s*moveToCollections/.test(mdSrc));
ok('moveToCollections commits through the shared commitStageChange, not a bare updateDoc',
  /commitStageChange\(entry\.leadId,\s*'collections',\s*oldStage/.test(mdSrc));
ok('moveToCollections snapshots the lead\'s OWN current stage first (race-safe oldStage, not assumed)',
  /oldStage = lead \? \(lead\._stageKey \|\| lead\.stage\) : null/.test(mdSrc));
ok('fetchData scopes invoices to companyId for staff (team-wide A/R — was createdBy-only, under-reported the queue)',
  /staff \? q\(col\(db, 'invoices'\), where\('companyId', '==', companyId\(\)\)\)/.test(mdSrc));
ok('fetchData keeps each invoice\'s own doc id (needed so an action can target ONE invoice)',
  /Object\.assign\(\{ id: d\.id \}, d\.data\(\)\)/.test(mdSrc));

// ── Owed rule (2026-10-03): void / draft / cancelled / deleted are not A/R ──
// functions/stripe-ledger.js voids a Stripe mirror as { status:'void',
// balanceDue:0 }. The old `parseFloat(balanceDue) || parseFloat(total)` read
// that 0 as "missing" and counted the full total as owed; drafts (never sent)
// were counted too.
console.log('  owed rule (void / draft / cancelled / deleted):');
{
  const NOWo = new Date(2026, 8, 15, 12, 0, 0);
  const past = new Date(NOWo.getTime() - 20 * 86400000);
  const ow = MD.computePnL({
    year: 2026, now: NOWo, leads: [], expenses: [], suppliers: [],
    invoices: [
      { id: 'open', status: 'sent', total: 1000, balanceDue: 1000, dueDate: past },
      { id: 'void', status: 'void', source: 'stripe', total: 5000, balanceDue: 0, dueDate: past },
      { id: 'voidStr', status: 'void', total: 700, balanceDue: '0', dueDate: past },
      { id: 'draft', status: 'draft', total: 2500, balanceDue: 2500, dueDate: past },
      { id: 'cancelled', status: 'Cancelled', total: 300, balanceDue: 300, dueDate: past },
      { id: 'deleted', status: 'sent', deleted: true, total: 400, balanceDue: 400, dueDate: past },
      { id: 'zeroBal', status: 'sent', total: 900, balanceDue: 0, dueDate: past },
      { id: 'strBal', status: 'sent', total: 800, balanceDue: '250', dueDate: past },
      { id: 'legacy', status: 'sent', total: 600, dueDate: past },
    ],
  });
  eq('outstanding = open $1,000 + string balance $250 + legacy (no balanceDue → total) $600', ow.outstandingCents, 185000);
  eq('aging 1-30 bucket = the same $1,850 (void/draft/zero not aged)', ow.agingCents.d1_30, 185000);
  eq('collections queue holds only the owed invoices',
    ow.collectionsQueue.map(q => q.id).sort().join(','), 'legacy,open,strBal');
}

// The owed rule is ONE rule: the marked block must be byte-identical in every
// file that decides "is this invoice owed?" (no shared runtime import — each
// loads standalone, like paymentsOf).
{
  const OWED_FILES = ['collected-revenue.js', 'money-dashboard.js', 'analytics-kpi.js', 'invoice-pipeline.js'];
  const blockOf = (f) => {
    const s = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', f), 'utf8').replace(/\r\n/g, '\n');
    const m = s.match(/\/\/ nbd:owed-rule:start[\s\S]*?\/\/ nbd:owed-rule:end/);
    return m ? m[0] : null;
  };
  const canon = blockOf(OWED_FILES[0]);
  ok('collected-revenue.js carries the canonical owed-rule block', !!canon && /function owedDollarsOf/.test(canon));
  OWED_FILES.slice(1).forEach(function (f) {
    ok(f + ' owed-rule block is identical to collected-revenue.js', blockOf(f) === canon);
  });
}

console.log('\n' + (failed === 0 ? '✓' : '✗') + ' money dashboard: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) { console.error('FAILED: ' + fails.join(', ')); process.exit(1); }
