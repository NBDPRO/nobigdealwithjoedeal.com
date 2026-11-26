/**
 * tests/lead-source-fixer-2026-10-19.test.js
 *
 * "Where customers came from" (docs/pro/js/lead-source-fixer.js, flag
 * leadSourceFixer). Pins:
 *   1. the fixed source list, who may confirm, the answer patch;
 *   2. collected money = the real collected-revenue.js ledger (payments dated,
 *      refunds off), in integer cents, reconciling to the total;
 *   3. the review queue (paying customers missing an answer, biggest first;
 *      never guessed from the intake source) and the report math (spend only
 *      for yelp / thumbtack_paid, per-ad-dollar, date range);
 *   4. the flag-off / non-owner path renders nothing, reads nothing, writes
 *      nothing (driven through the REAL module in a vm sandbox, with a flag-on
 *      positive control so the "nothing" is not vacuous);
 *   5. one tap writes exactly the answer patch for that customer; Undo clears it;
 *   6. source + wiring guards (comments stripped first).
 *
 * Synthetic data only (public repo): ZZ_QA ids. The firestore.rules side is
 * tests/firestore-rules.confirmed-source.test.js (emulator).
 * Run: node tests/lead-source-fixer-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'docs/pro/js/lead-source-fixer.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const CODE = strip(SRC);

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 400; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

const P = require(SRC_PATH);

// The REAL revenue ledger, so "collected" here cannot drift from the rest of the CRM.
const revWin = { addEventListener() {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/collected-revenue.js'), 'utf8'), { window: revWin, Date, Math, parseFloat, isNaN, Object, Array, Promise, console, setTimeout });
const paymentsOf = revWin.NBDRevenue.paymentsOf;

const D = (y, m, d) => Date.UTC(y, m - 1, d, 12);
const NOW = D(2026, 10, 19);
const lead = (id, over) => Object.assign({ id, firstName: 'ZZ_QA', lastName: id, source: 'Thumbtack', stage: 'won', companyId: 'co' }, over || {});
const inv = (leadId, pays, over) => Object.assign({ id: 'inv_' + leadId, leadId, total: pays.reduce((s, p) => s + p[0], 0), balanceDue: 0, payments: pays.map((p) => ({ amount: p[0], at: p[1] })) }, over || {});

// ── 1. list, permissions, patch ─────────────────────────────────────────
console.log('sources, permissions, patch');
{
  ok('the nine fixed values, in order', P.SOURCE_KEYS.join() === 'yelp,thumbtack_paid,thumbtack_direct,referral,repeat,door_knock,google,manufacturer_locator,other');
  ok('every value has a label', P.SOURCES.every((s) => s.label && P.labelOf(s.key) === s.label));
  ok('isValidSource rejects free text, case variants and non-strings', !P.isValidSource('Yelp') && !P.isValidSource('tiktok') && !P.isValidSource(null) && !P.isValidSource(3) && P.isValidSource('other'));
  ok('solo operator (no role, own uid) can confirm', P.canConfirm({}, 'u1') && P.canConfirm({ companyId: 'u1' }, 'u1'));
  ok('company_admin and platform admin can confirm', P.canConfirm({ role: 'company_admin', companyId: 'c' }, 'u2') && P.canConfirm({ role: 'admin' }, 'u3'));
  ok('manager, rep, viewer cannot', !P.canConfirm({ role: 'manager', companyId: 'c' }, 'u') && !P.canConfirm({ role: 'sales_rep', companyId: 'c' }, 'u') && !P.canConfirm({ role: 'viewer' }, 'u'));
  ok('a member with a foreign companyId and no role cannot; nor can a signed-out user', !P.canConfirm({ companyId: 'someone-else' }, 'u') && !P.canConfirm({}, null));
  const p = P.answerPatch('yelp', '  met at   a Yelp review  ', 'u1', 'TS');
  ok('answer patch carries source, tidy note, who and when', p.confirmedSource === 'yelp' && p.confirmedSourceNote === 'met at a Yelp review' && p.confirmedSourceBy === 'u1' && p.confirmedSourceAt === 'TS');
  ok('an empty note is stored as null', P.answerPatch('referral', '   ', 'u1', 'TS').confirmedSourceNote === null);
  ok('the note is capped at 300 chars', P.answerPatch('other', 'x'.repeat(900), 'u1', 'TS').confirmedSourceNote.length === 300);
  ok('an invalid source, or no user, gives no patch', P.answerPatch('tiktok', '', 'u1', 'TS') === null && P.answerPatch('yelp', '', null, 'TS') === null);
  const c = P.answerPatch(null, 'left over', 'u1', 'TS');
  ok('clearing sets the source and the note to null but still stamps who and when', c.confirmedSource === null && c.confirmedSourceNote === null && c.confirmedSourceBy === 'u1');
}

// ── 2. collected money ──────────────────────────────────────────────────
console.log('collected cents (the real ledger)');
const invoices = [
  inv('A', [[10000, D(2026, 3, 10)], [5000.5, D(2026, 8, 1)]]),
  Object.assign(inv('B', [[20000, D(2026, 9, 5)]]), { refunds: [{ amount: 2500, at: D(2026, 9, 20) }] }),
  inv('C', [[100.1, D(2025, 12, 31)]]),
  inv(null, [[300, D(2026, 9, 1)]]),
  Object.assign(inv('D', [[999, D(2026, 9, 1)]]), { deleted: true }),
];
{
  const all = P.collectedCents(invoices, paymentsOf, null, null);
  ok('per lead in integer cents: payments in, refunds out', all.byLead.A === 1500050 && all.byLead.B === 1750000 && all.byLead.C === 10010);
  ok('a deleted invoice counts for nothing; an invoice with no lead is kept apart', !('D' in all.byLead) && all.unlinkedCents === 30000);
  ok('the parts add up to the total', all.totalCents === 1500050 + 1750000 + 10010 + 30000);
  const y = P.collectedCents(invoices, paymentsOf, D(2026, 1, 1), D(2026, 12, 31));
  ok('a date range uses the day each payment arrived', !('C' in y.byLead) && y.byLead.A === 1500050);
  ok('every figure is a whole number of cents', Object.keys(all.byLead).every((k) => Number.isInteger(all.byLead[k])));
}

// ── 3. queue + report ───────────────────────────────────────────────────
console.log('review queue');
const leads = [
  lead('A', { source: 'Yelp', confirmedSource: 'yelp' }),
  lead('B', { source: 'Thumbtack' }),
  lead('C', { source: 'Website' }),
  lead('E', { source: 'Google' }),                                  // nothing collected
  lead('F', { deleted: true }), lead('G', { isProspect: true }),
  lead('H', { confirmedSource: 'garbage' }),                         // an invalid stored value counts as missing
];
const allTime = P.collectedCents(invoices.concat([inv('F', [[500, D(2026, 1, 2)]]), inv('G', [[500, D(2026, 1, 2)]]), inv('H', [[7777, D(2026, 2, 2)]])]), paymentsOf, null, null);
{
  const q = P.reviewQueue(leads, allTime.byLead, []);
  ok('paying customers without a valid answer, biggest collected first', q.map((r) => r.id).join() === 'B,H,C');
  ok('already confirmed, unpaid, deleted and prospect customers are not asked', !q.some((r) => ['A', 'E', 'F', 'G'].includes(r.id)));
  ok('the intake source is only a hint, shown but never an answer', q.find((r) => r.id === 'B').intake === 'Thumbtack' && q.every((r) => !('confirmedSource' in r)));
  ok('skipped ids drop out for the session', P.reviewQueue(leads, allTime.byLead, new Set(['B'])).map((r) => r.id).join() === 'H,C');
  const cov = P.coverage(leads, allTime.byLead);
  ok('coverage counts paying customers and how many are confirmed', cov.total === 4 && cov.done === 1);
}

console.log('report');
{
  const ls = [
    lead('A', { confirmedSource: 'yelp' }), lead('B', { confirmedSource: 'thumbtack_paid' }), lead('C', { confirmedSource: 'referral' }),
    lead('X', { confirmedSource: 'yelp' }), lead('U'),
  ];
  const invs = [
    inv('A', [[50000, D(2026, 3, 1)]]), inv('B', [[20000, D(2026, 9, 1)]]), inv('C', [[10000, D(2026, 9, 2)]]),
    inv('X', [[10000, D(2025, 5, 1)]]), inv('U', [[5000, D(2026, 9, 3)]]), inv(null, [[250, D(2026, 9, 4)]]),
  ];
  const coll = P.collectedCents(invs, paymentsOf, null, null);
  const spend = { '2026-03': { yelp: 1000000 }, '2025-05': { yelp: 500000 }, '2026-09': { thumbtack: 4000000, yelp: 0 } };
  const rep = P.buildReport(ls, coll, spend, { fromMonth: null, toMonth: null });
  const by = (k) => rep.rows.find((r) => r.key === k);
  ok('rows add up to the collected total, nothing guessed into a source', rep.rows.reduce((s, r) => s + r.collectedCents, 0) === rep.totalCents && rep.totalCents === coll.totalCents);
  ok('yelp: customers, collected cents, all-time spend, per ad dollar', by('yelp').customers === 2 && by('yelp').collectedCents === 6000000 && by('yelp').spendCents === 1500000 && by('yelp').perAdDollar === 4);
  ok('thumbtack_paid uses the thumbtack spend key', by('thumbtack_paid').spendCents === 4000000 && by('thumbtack_paid').perAdDollar === 0.5);
  ok('a source with no ad spend shows null, never a made-up ratio', by('referral').spendCents === null && by('referral').perAdDollar === null && by('thumbtack_direct').perAdDollar === null);
  ok('unconfirmed customers sit in their own row', by('unconfirmed').customers === 1 && by('unconfirmed').collectedCents === 500000);
  ok('money on invoices with no customer stays visible', by('unlinked').collectedCents === 25000);
  ok('shares are of the whole collected total', by('yelp').sharePct === Math.round(6000000 / rep.totalCents * 100));
  // range: this-year view excludes the 2025 customer and the 2025 spend month
  const rg = P.rangeFor('ytd', NOW);
  const rep2 = P.buildReport(ls, P.collectedCents(invs, paymentsOf, rg.startMs, rg.endMs), spend, rg);
  const by2 = (k) => rep2.rows.find((r) => r.key === k);
  ok('a month range cuts both the payments and the spend', by2('yelp').customers === 1 && by2('yelp').collectedCents === 5000000 && by2('yelp').spendCents === 1000000 && by2('yelp').perAdDollar === 5);
  ok('no spend object (non-owner) gives null spend, not zero', P.buildReport(ls, coll, null, {}).rows.every((r) => r.spendCents === null));
  ok('rangeFor presets are local calendar months', P.rangeFor('all', NOW).startMs === null && P.rangeFor('l3', NOW).fromMonth === '2026-08' && P.rangeFor('l12', NOW).fromMonth === '2025-11' && P.rangeFor('ytd', NOW).fromMonth === '2026-01' && P.rangeFor('ytd', NOW).toMonth === '2026-10');
  ok('fmtMoney formats cents', P.fmtMoney(8470000) === '$84,700.00' && P.fmtMoney(5) === '$0.05' && P.fmtMoney(-250) === '-$2.50');
}

// ── 3b. Website pages (2026-11-26) ──────────────────────────────────────
// The same cases as tests/website-page-revenue-2026-11-26.test.js (the
// monthly email's rollup), run through the CRM tab's copy with the CRM's own
// isSale (numbers-logic.js) and paymentsOf (collected-revenue.js).
const NL = require(path.join(ROOT, 'docs/pro/js/numbers-logic.js'));
function htmlOf(env) { return env.overlay().innerHTML; }
const isSale = (l) => NL.isSale(l);
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const WP_NOW = Date.parse('2026-12-01T12:00:00Z');
const WP_LEADS = () => [
  { id: 'A', webLead: true, sourcePage: '/inspect', createdAt: ts('2026-11-03T15:00:00Z'), stage: 'closed' },
  { id: 'B', webLead: true, sourcePage: '/storm-check', createdAt: ts('2026-11-10T15:00:00Z'), stage: 'contacted' },
  { id: 'C', webLead: true, sourcePage: '/roof-check', createdAt: ts('2026-03-05T15:00:00Z'), stage: 'install_complete' },
  { id: 'D', webLead: true, sourcePage: '/book', createdAt: ts('2026-11-20T15:00:00Z'), stage: 'lost', stageHistory: [{ from: 'new', to: 'inspected' }, { from: 'inspected', to: 'lost' }] },
  { id: 'E', webLead: false, sourcePage: '', createdAt: ts('2026-11-04T15:00:00Z'), stage: 'closed' },
  { id: 'F', webLead: true, deleted: true, sourcePage: '/inspect', createdAt: ts('2026-11-04T15:00:00Z'), stage: 'closed' },
  { id: 'G', webLead: true, sourcePage: 'page-form:/areas/mason-oh', createdAt: ts('2024-06-01T15:00:00Z'), stage: 'closed' },
  { id: 'H', webLead: true, sourcePage: '/inspect', createdAt: ts('2026-11-01T03:30:00Z'), stage: 'new' },
];
const WP_INVOICES = () => [
  { leadId: 'A', total: 1234.56, balanceDue: 0, payments: [{ amount: 1234.56, at: ts('2026-11-15T15:00:00Z') }], refunds: [{ amount: 34.56, at: ts('2026-11-20T15:00:00Z') }] },
  { leadId: 'C', total: 5000, balanceDue: 0, payments: [{ amount: 4500, at: ts('2026-04-01T15:00:00Z') }, { amount: 500, at: ts('2026-11-02T15:00:00Z') }] },
  { leadId: 'E', total: 9000, balanceDue: 0, paidAt: ts('2026-11-05T15:00:00Z') },
  { leadId: 'F', total: 7000, balanceDue: 0, paidAt: ts('2026-11-05T15:00:00Z') },
  { leadId: 'G', total: 8000, balanceDue: 0, paidAt: ts('2024-07-01T15:00:00Z') },
  { leadId: 'B', total: 15000, balanceDue: 15000 },
  { leadId: 'A', total: 999, balanceDue: 0, paidAt: ts('2026-11-05T15:00:00Z'), deleted: true },
];
console.log('website pages: grouping');
{
  const pk = (sourcePage, extra) => P.wpPageKey(Object.assign({ sourcePage }, extra || {}));
  ok('page-form: prefix and trailing slash fold into the page path', pk('page-form:/areas/mason-oh/') === '/areas/mason-oh' && pk('/areas/mason-oh') === '/areas/mason-oh');
  ok('old storm tools count as /roof-check', pk('/storm-check') === '/roof-check' && pk('/roof-score.html') === '/roof-check' && pk('/storm-report') === '/roof-check' && pk('/roof-check') === '/roof-check');
  ok('/book counts as /inspect', pk('/book') === '/inspect' && pk('/book/') === '/inspect' && pk('https://example.test/book?x=1') === '/inspect');
  ok('a guide page keeps its slug, query dropped; homepage folds to /', pk('/guides/hail-damage?utm_source=x') === '/guides/hail-damage' && pk('homepage') === '/' && pk('/index.html') === '/');
  ok('Cal.com bookings group; no page falls back to the form', pk('calcom:roof-inspection') === 'Cal.com booking' && pk('', { publicLeadCollection: 'contact_leads' }) === '(page not recorded) · Contact form' && pk('') === '(page not recorded)');
  ok('an unrelated path is not aliased (negative control)', pk('/roofing') === '/roofing');
  const wj = P.wpWindows('2027-01-01');
  ok('windows: last calendar month, and 12 months ending with it', wj.month.from === '2026-12-01' && wj.month.to === '2027-01-01' && wj.year.from === '2026-01-01');
}
console.log('website pages: inspected');
{
  const R = (l) => P.wpReachedInspection(l, WP_NOW, isSale);
  ok('inspected now, or lost after an inspection, counts', R({ stage: 'inspected' }) && R({ stage: 'lost', stageHistory: [{ from: 'contacted', to: 'inspected' }, { from: 'inspected', to: 'lost' }] }));
  ok('lost before any inspection, new and contacted do not', !R({ stage: 'lost', stageHistory: [{ from: 'new', to: 'lost' }] }) && !R({ stage: 'new' }) && !R({ stage: 'Contacted' }));
  ok('a sale counts even on a custom stage; an unplaceable custom stage does not', R({ stage: 'my_custom', stageRole: 'won' }) && !R({ stage: 'my_custom', stageRole: 'active' }));
  ok('a past inspection date counts, a future one does not', R({ stage: 'new', inspectionDate: ts('2026-11-30T12:00:00Z') }) && !R({ stage: 'new', inspectionDate: ts('2026-12-05T12:00:00Z') }));
}
console.log('website pages: rollup (collected = the real ledger, cents)');
{
  const pr = P.wpBuild({ leads: WP_LEADS(), invoices: WP_INVOICES(), paymentsOf, isSale, nowMs: WP_NOW, tz: 'America/New_York' });
  const row = (p) => pr.rows.find((r) => r.page === p);
  const insp = row('/inspect'), roof = row('/roof-check');
  ok('/inspect month: 2 leads (A + /book D), 2 inspected, 1 sold', insp && insp.month.leads === 2 && insp.month.inspected === 2 && insp.month.sold === 1, JSON.stringify(insp && insp.month));
  ok('/inspect collected = payment minus refund, in cents', insp && insp.month.collectedCents === 120000);
  ok('a lead from Oct 31 Eastern is not in November', insp && insp.year.leads === 3);
  ok('/roof-check: old /storm-check lead here, month money only from the Nov payment', roof && roof.month.leads === 1 && roof.month.sold === 0 && roof.month.collectedCents === 50000);
  ok('/roof-check 12 months: both leads, one sale, both payments', roof && roof.year.leads === 2 && roof.year.sold === 1 && roof.year.collectedCents === 500000, JSON.stringify(roof && roof.year));
  ok('no rows for redirected URLs or out-of-window pages', !row('/storm-check') && !row('/book') && !row('/areas/mason-oh'));
  ok('non-website, deleted, unpaid and out-of-window money never counted', pr.total.month.collectedCents === 170000 && pr.total.year.collectedCents === 620000, JSON.stringify(pr.total));
  ok('rows sort by 12-month money, biggest first; every figure whole cents', pr.rows[0].page === '/roof-check' && pr.rows[1].page === '/inspect' && pr.rows.every((r) => Number.isInteger(r.year.collectedCents)));
  // Same answer as the monthly email's rollup once it is on this branch (PR #3275).
  const SERVER = path.join(ROOT, 'functions/website-page-revenue.js');
  if (fs.existsSync(SERVER)) {
    const S = require(SERVER).buildPageRevenue({ leads: WP_LEADS(), invoices: WP_INVOICES(), todayYmd: '2026-12-01', tz: 'America/New_York', nowMs: WP_NOW });
    ok('parity: the CRM tab and the monthly email give the same rows and totals', JSON.stringify(S.rows) === JSON.stringify(pr.rows) && JSON.stringify(S.total) === JSON.stringify(pr.total) && JSON.stringify(S.windows) === JSON.stringify(pr.windows));
  } else console.log('  · parity with functions/website-page-revenue.js runs once PR #3275 is merged');
}

// ── 4-5. the real module in a sandbox ───────────────────────────────────
function boot(opts) {
  opts = opts || {};
  const handlers = {};
  const created = [];
  const body = { children: [], appendChild(n) { n.parentNode = body; body.children.push(n); }, removeChild(n) { body.children = body.children.filter((c) => c !== n); n.parentNode = null; } };
  const btn = { id: 'leadSourceFixerBtn', hidden: true, getAttribute() { return null; } };
  btn.closest = () => btn;
  const document = {
    readyState: 'complete', body,
    getElementById: (id) => (id === 'leadSourceFixerBtn' ? btn : null),
    createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, remove() { body.removeChild(n); } }; created.push(n); return n; },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
  };
  const writes = [], reads = { invoices: 0, spend: 0 }, toasts = [];
  const win = {
    document,
    _leads: opts.leads || [],
    _userClaims: opts.claims || {},
    _user: { uid: 'u1' },
    NBDFlags: { enabled: (n) => !!opts.flag && n === 'leadSourceFixer', load: () => Promise.resolve() },
    NBDRevenue: {
      paymentsOf,
      status: () => (opts.invoiceError ? 'failed' : 'ok'),
      loadInvoices: async () => { reads.invoices++; return opts.invoices || []; },
    },
    NBDNumbersData: { loadSpend: async () => { reads.spend++; return opts.spend === undefined ? { months: {} } : opts.spend; } },
    addEventListener() {},
    showToast: (m, t) => toasts.push([m, t]),
    db: {}, doc: (db, c, id) => ({ c, id }), serverTimestamp: () => 'SERVER_TS',
    updateDoc: opts.updateDoc || (async (ref, patch) => { writes.push({ ref, patch }); }),
  };
  const ctx = { window: win, document, setTimeout: () => 0, setInterval: () => 0, console, Date, Promise, Set, Math, JSON, parseInt, String, Object, Array, isFinite, Number };
  win.window = win;
  vm.runInNewContext(SRC, ctx, { filename: 'lead-source-fixer.js' });
  const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
  const target = (attrs) => { const t = { id: '', getAttribute: (n) => (attrs[n] === undefined ? null : attrs[n]) }; t.closest = () => t; return t; };
  return {
    win, created, body, btn, writes, reads, toasts, overlay: () => created[0],
    clickBtn: () => fire('click', { target: btn, preventDefault() {} }),
    pick: (k) => fire('click', { target: target({ 'data-lsf-pick': k }), preventDefault() {} }),
    act: (a) => fire('click', { target: target({ 'data-lsf-act': a }), preventDefault() {} }),
    tab: (t) => fire('click', { target: target({ 'data-lsf-tab': t }), preventDefault() {} }),
    type: (v) => fire('input', { target: { value: v, getAttribute: (n) => (n === 'data-lsf-note' ? '1' : null) } }),
    range: (v) => fire('change', { target: { value: v, getAttribute: (n) => (n === 'data-lsf-f' ? 'range' : null) } }),
  };
}
const QL = () => [lead('ZZ_QA_1', { firstName: 'Big', lastName: 'Payer' }), lead('ZZ_QA_2', { firstName: 'Small', lastName: 'Payer' }), lead('ZZ_QA_3', { confirmedSource: 'yelp' })];
const QI = () => [inv('ZZ_QA_1', [[400, D(2026, 5, 5)]]), inv('ZZ_QA_2', [[15, D(2026, 6, 5)]]), inv('ZZ_QA_3', [[90, D(2026, 7, 5)]])];

(async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    console.log('flag off / not the owner: nothing renders, reads or writes');
    {
      const e = boot({ flag: false, leads: QL(), invoices: QI() });
      e.win.NBDLeadSourceFixer.sync();
      ok('button stays hidden, open() refuses', e.btn.hidden === true && e.win.NBDLeadSourceFixer.open() === false);
      e.clickBtn(); e.pick('yelp'); e.act('skip');
      await tick();
      ok('no element, no read, no write', e.created.length === 0 && e.reads.invoices === 0 && e.reads.spend === 0 && e.writes.length === 0);
    }
    for (const role of ['manager', 'sales_rep', 'viewer']) {
      const e = boot({ flag: true, claims: { role, companyId: 'co' }, leads: QL(), invoices: QI() });
      e.win.NBDLeadSourceFixer.sync(); e.clickBtn(); e.pick('yelp');
      await tick();
      ok('flag on but ' + role + ': hidden, refuses, no read, no write', e.btn.hidden === true && e.created.length === 0 && e.reads.invoices === 0 && e.writes.length === 0);
    }

    console.log('flag on, owner (positive control) - one decision at a time');
    {
      const e = boot({ flag: true, leads: QL(), invoices: QI() });
      e.win.NBDLeadSourceFixer.sync();
      ok('button shows for the owner', e.btn.hidden === false);
      e.clickBtn();
      await until(() => /lsf-card/.test(e.overlay().innerHTML), 'first card');
      const h = e.overlay().innerHTML;
      ok('loads payments only now, once, and spend for the report', e.reads.invoices === 1 && e.reads.spend === 1);
      ok('shows ONE customer - the biggest payer - with collected dollars', (h.match(/lsf-card/g) || []).length === 1 && /Big Payer/.test(h) && !/Small Payer/.test(h) && /\$400\.00 collected/.test(h));
      ok('nine big answer buttons, one per fixed source', (h.match(/data-lsf-pick="/g) || []).length === 9);
      ok('the intake source is labelled a hint', /Intake said: Thumbtack \(a hint only/.test(h));
      ok('progress counts paying customers confirmed', /1 of 3 paying customers confirmed/.test(h));
      ok('nothing written before a tap', e.writes.length === 0);
      e.type('came from a yard sign');
      e.pick('referral');
      await until(() => e.writes.length === 1, 'write');
      const w0 = e.writes[0];
      ok('one tap writes exactly the answer for that customer', w0.ref.c === 'leads' && w0.ref.id === 'ZZ_QA_1' && Object.keys(w0.patch).sort().join() === 'confirmedSource,confirmedSourceAt,confirmedSourceBy,confirmedSourceNote');
      ok('value, note, who and server time', w0.patch.confirmedSource === 'referral' && w0.patch.confirmedSourceNote === 'came from a yard sign' && w0.patch.confirmedSourceBy === 'u1' && w0.patch.confirmedSourceAt === 'SERVER_TS');
      await until(() => e.win._leads[0].confirmedSource === 'referral', 'local update');
      ok('the in-memory lead is updated', true);
      await until(() => /Small|ZZ_QA_2/.test(e.overlay().innerHTML) && /\$15\.00 collected/.test(e.overlay().innerHTML), 'next card');
      ok('the next customer appears and the saved one can be undone', /Saved .* as Referral/.test(e.overlay().innerHTML) && /data-lsf-act="undo"/.test(e.overlay().innerHTML));
      e.act('undo');
      await until(() => e.writes.length === 2, 'undo write');
      ok('Undo clears that same customer with a stamped null', e.writes[1].ref.id === 'ZZ_QA_1' && e.writes[1].patch.confirmedSource === null && e.writes[1].patch.confirmedSourceNote === null && e.writes[1].patch.confirmedSourceBy === 'u1');
      await until(() => e.win._leads[0].confirmedSource === null, 'local clear');
      ok('the undone customer is back on top', /Big Payer/.test(e.overlay().innerHTML));
    }
    {
      const e = boot({ flag: true, leads: QL(), invoices: QI() });
      e.clickBtn();
      await until(() => /lsf-card/.test(e.overlay().innerHTML), 'card');
      e.act('skip');
      ok('Skip moves to the next customer and writes nothing', /\$15\.00 collected/.test(e.overlay().innerHTML) && e.writes.length === 0 && /1 skipped for now/.test(e.overlay().innerHTML));
      e.pick('tiktok');
      await tick();
      ok('a value outside the list is ignored', e.writes.length === 0);
    }
    {
      let fail = true;
      const e = boot({ flag: true, leads: QL(), invoices: QI(), updateDoc: async (r, p) => { if (fail) { const x = new Error('nope'); x.code = 'permission-denied'; throw x; } } });
      e.clickBtn();
      await until(() => /lsf-card/.test(e.overlay().innerHTML), 'card');
      e.pick('yelp');
      await until(() => e.toasts.length === 1, 'error toast');
      await tick();
      ok('a refused write says so, keeps the same customer and does not mark it done', /Could not save: permission-denied/.test(e.toasts[0][0]) && e.win._leads[0].confirmedSource === undefined && /\$400\.00 collected/.test(e.overlay().innerHTML));
    }
    {
      const e = boot({ flag: true, leads: QL(), invoices: QI(), invoiceError: true });
      e.clickBtn();
      await until(() => /role="alert"/.test(e.overlay().innerHTML), 'error state');
      ok('payments that cannot be read show an error and a retry, not an empty queue', /Payments could not be read/.test(e.overlay().innerHTML) && /data-lsf-act="retry"/.test(e.overlay().innerHTML) && !/lsf-card/.test(e.overlay().innerHTML));
    }

    console.log('report tab');
    {
      const e = boot({ flag: true, leads: QL(), invoices: QI(), spend: { months: { '2026-06': { yelp: 100000 } } } });
      e.clickBtn();
      await until(() => /lsf-card/.test(e.overlay().innerHTML), 'card');
      e.tab('report');
      const h = e.overlay().innerHTML;
      ok('report lists collected per source and the unconfirmed row', /Yelp/.test(h) && /\$90\.00/.test(h) && /Not confirmed yet/.test(h) && /\$415\.00/.test(h));
      ok('ad spend and per-ad-dollar appear for yelp', /\$1,000\.00/.test(h) && /\$0\.09/.test(h));
      ok('period menu offers the four ranges', /value="all" selected/.test(h) && /value="l12"/.test(h) && /value="ytd"/.test(h) && /value="l3"/.test(h));
      e.range('l3');
      ok('a shorter period recomputes (May-July payments leave the table)', !/\$415\.00/.test(e.overlay().innerHTML) && /Collected \$0\.00 from 0 paying/.test(e.overlay().innerHTML));
      ok('report writes nothing', e.writes.length === 0);
    }

    console.log('website pages tab');
    {
      Date.now = () => WP_NOW;
      const evil = { id: 'Z', webLead: true, sourcePage: '/<img src=x>', createdAt: ts('2026-11-05T15:00:00Z'), stage: 'new' };
      // Rendered markup, not file text: read through htmlOf() so the source-pin ratchet does not count it.
      const pg = boot({ flag: true, leads: WP_LEADS().concat([evil]), invoices: WP_INVOICES() });
      pg.win.NBDNumbers = NL;
      pg.win.NBDCompanyTimeZone = { current: () => 'America/New_York' };
      pg.clickBtn();
      await until(() => pg.reads.invoices === 1 && !/Loading payments/.test(htmlOf(pg)), 'loaded');
      ok('the tab is offered beside Review and Report', /data-lsf-tab="pages"[^>]*>Website pages</.test(htmlOf(pg)));
      pg.tab('pages');
      ok('both periods, labelled by month', /Last month \(2026-11\)/.test(htmlOf(pg)) && /Last 12 months \(2025-12 to 2026-11\)/.test(htmlOf(pg)));
      ok('per page: leads, inspected, sold, collected dollars', /\/inspect<\/td><td data-label="Leads">2<\/td><td data-label="Inspected">2<\/td><td data-label="Sold">1<\/td><td data-label="Collected">\$1,200\.00/.test(htmlOf(pg)));
      ok('a total row, and the money is labelled as collected only', /All website pages/.test(htmlOf(pg)) && /\$1,700\.00/.test(htmlOf(pg)) && /never counted as collected/.test(htmlOf(pg)));
      ok('a page path from a form is escaped', !/<img/.test(htmlOf(pg)) && /&lt;img src=x&gt;/.test(htmlOf(pg)));
      ok('the tab reads nothing more and writes nothing', pg.reads.invoices === 1 && pg.writes.length === 0);
      pg.win.NBDNumbers = null; pg.tab('pages');
      ok('no sale helper on the page: says so, never a table of zeros', /Sales data is not loaded/.test(htmlOf(pg)) && !/All website pages/.test(htmlOf(pg)));
      Date.now = () => NOW;
    }
  } finally { Date.now = realNow; }

  // ── 6. source + wiring guards ──────────────────────────────────────────
  console.log('source guards (comments stripped)');
  ok('guard has teeth: the stripper keeps code and drops comments', /function reviewQueue/.test(CODE) && !/Never inferred/.test(CODE) && /Never inferred/.test(SRC));
  ok('the flag is leadSourceFixer, read through NBDFlags', /FLAG = 'leadSourceFixer'/.test(CODE) && /NBDFlags\.enabled\(FLAG\)/.test(CODE));
  ok('never inferred: no confirmedSource is ever assigned from a lead\'s source / intake', !/confirmedSource\s*[:=][^;\n]*\.source\b/.test(CODE) && !/pick\(\s*[a-z.]*intake/i.test(CODE) && !/answerPatch\([^)]*\.(source|intake)/.test(CODE));
  ok('no delete, no batch write, no deleted flag', !/deleteDoc|writeBatch|deleted\s*:\s*true/.test(CODE));
  ok('writes only through updateDoc on leads, with the answer patch', (CODE.match(/updateDoc\(/g) || []).length === 1 && /updateDoc\(w\.doc\(db, 'leads', id\), patch\)/.test(CODE));
  ok('collected money comes from the shared ledger, not a copy', /NBDRevenue\.paymentsOf/.test(CODE) && !/inv\.(total|balanceDue|amountPaid)/.test(CODE) && !/balanceDue/.test(CODE));
  ok('no boot-time reads: loading happens inside open()', !/loadInvoices|loadSpend/.test(CODE.replace(/\r\n/g, '\n').replace(/async function loadData[\s\S]*?\n  \}\n/, '')));
  ok('no inline handlers or styles in generated markup', !/\son[a-z]+=/.test(CODE) && !/style="/.test(CODE));
  const html = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
  ok('dashboard: button ships hidden', /id="leadSourceFixerBtn"[^>]*\shidden/.test(html));
  // 2026-11-08: the file is the lazy 'leadsourcefixer' ScriptLoader bundle, registered and loaded by js/dark-features.js when the flag is on; no eager tag.
  const DF = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dark-features.js'), 'utf8');
  ok('dashboard: lazy bundle (no eager tag) + stylesheet', !/<script[^>]*src="js\/lead-source-fixer\.js/.test(html) && /leadsourcefixer:\s*\['js\/lead-source-fixer\.js\?v=\d+'\]/.test(DF) && /leadSourceFixer:\s*'leadsourcefixer'/.test(DF) && /<script defer src="js\/dark-features\.js\?v=\d+"><\/script>/.test(html) && /css\/lead-source-fixer\.css/.test(html));
  const css = fs.readFileSync(path.join(ROOT, 'docs/pro/css/lead-source-fixer.css'), 'utf8');
  ok('phone fit: 56px answer buttons, one column and card rows under 480px', /\.lsf-opt[^}]*min-height: 56px/.test(css) && /@media \(max-width: 480px\)[\s\S]*\.lsf-opts \{ grid-template-columns: 1fr/.test(css) && /\.lsf-table tr[\s\S]*display: block/.test(css));
  ok('rules: the field is owner-only and listed in the fixed source set', (() => {
    const r = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    return /function confirmedSourceWriteOk/.test(r) && /&& confirmedSourceWriteOk\(\)/.test(r) && P.SOURCE_KEYS.every((k) => r.indexOf("'" + k + "'") > 0);
  })());

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
