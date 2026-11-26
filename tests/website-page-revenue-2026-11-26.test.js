/**
 * tests/website-page-revenue-2026-11-26.test.js
 *
 * "Website pages → money" in the monthly marketing report:
 * functions/website-page-revenue.js (pure rollup) and the marketing-report.js
 * wiring (gatherPageRevenue with a fake Firestore, the email section).
 * Synthetic ids and amounts only (public repo). The clock is an input.
 *
 * Run: node tests/website-page-revenue-2026-11-26.test.js
 */
'use strict';
const path = require('path');
const Module = require('module');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const ROOT = path.join(__dirname, '..');

// marketing-report.js needs firebase / resend at module scope; stub them so
// this runs without functions/node_modules.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './integrations/heartbeat') return { onSchedule: (_o, fn) => fn };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({ value: () => '' }) };
  if (request === 'firebase-functions/v2') return { logger: { info() {}, warn() {}, error() {} } };
  if (request === 'firebase-admin/firestore') return { getFirestore: () => null, Timestamp: { fromDate: (d) => d } };
  if (request === 'resend') return { Resend: function () {} };
  return origLoad.apply(this, arguments);
};
const W = require(path.join(ROOT, 'functions/website-page-revenue.js'));
const MR = require(path.join(ROOT, 'functions/marketing-report.js'))._test;

const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

console.log('\n— page grouping —');
const pk = (sourcePage, extra) => W.pageKey(Object.assign({ sourcePage }, extra || {}));
ok('page-form: prefix and trailing slash fold into the page path', pk('page-form:/areas/mason-oh/') === '/areas/mason-oh' && pk('/areas/mason-oh') === '/areas/mason-oh');
ok('old storm tools count as /roof-check', pk('/storm-check') === '/roof-check' && pk('/roof-score.html') === '/roof-check' && pk('/storm-report') === '/roof-check' && pk('/roof-check') === '/roof-check');
ok('/book counts as /inspect', pk('/book') === '/inspect' && pk('/book/') === '/inspect' && pk('/inspect') === '/inspect');
ok('a guide page keeps its own slug, query string dropped', pk('/guides/hail-damage?utm_source=x') === '/guides/hail-damage');
ok('homepage source and /index.html are the home page', pk('homepage') === '/' && pk('/index.html') === '/' && pk('/') === '/');
ok('Cal.com bookings group together', pk('calcom:roof-inspection') === 'Cal.com booking' && pk('calcom:adjuster-meeting') === 'Cal.com booking');
ok('no sourcePage falls back to the form it came through', pk('', { publicLeadCollection: 'contact_leads' }) === '(page not recorded) · Contact form');
ok('no sourcePage and no collection is still a row, not dropped', pk('') === '(page not recorded)');
ok('an unrelated path is not aliased (negative control)', pk('/roofing') === '/roofing');

console.log('\n— windows —');
const w = W.windowsFor('2026-12-01');
ok('last month = the calendar month before the run', w.month.from === '2026-11-01' && w.month.to === '2026-12-01');
ok('12 months end with last month', w.year.from === '2025-12-01' && w.year.to === '2026-12-01');
const wj = W.windowsFor('2027-01-01');
ok('a January run reports December of the year before', wj.month.from === '2026-12-01' && wj.year.from === '2026-01-01');

console.log('\n— inspected —');
const NOW = Date.parse('2026-12-01T12:00:00Z');
ok('a lead now at inspected counts', W.reachedInspection({ stage: 'inspected' }, NOW));
ok('a lead lost AFTER its inspection counts (stageHistory)', W.reachedInspection({ stage: 'lost', stageHistory: [{ from: 'contacted', to: 'inspected' }, { from: 'inspected', to: 'lost' }] }, NOW));
ok('a lead lost before any inspection does not', !W.reachedInspection({ stage: 'lost', stageHistory: [{ from: 'new', to: 'lost' }] }, NOW));
ok('new / contacted do not count', !W.reachedInspection({ stage: 'new' }, NOW) && !W.reachedInspection({ stage: 'Contacted' }, NOW));
ok('a sale counts even on a custom stage (stageRole won)', W.reachedInspection({ stage: 'my_custom', stageRole: 'won' }, NOW));
ok('a custom stage the server cannot place does not count', !W.reachedInspection({ stage: 'my_custom', stageRole: 'active' }, NOW));

console.log('\n— rollup —');
const leads = [
  // A: came off /inspect in Nov, sold, paid in Nov with a refund.
  { id: 'A', webLead: true, sourcePage: '/inspect', createdAt: ts('2026-11-03T15:00:00Z'), stage: 'closed' },
  // B: old /storm-check URL in Nov, only contacted.
  { id: 'B', webLead: true, sourcePage: '/storm-check', createdAt: ts('2026-11-10T15:00:00Z'), stage: 'contacted' },
  // C: /roof-check back in March, paid in Nov.
  { id: 'C', webLead: true, sourcePage: '/roof-check', createdAt: ts('2026-03-05T15:00:00Z'), stage: 'install_complete' },
  // D: /book (old URL) in Nov, inspected then lost.
  { id: 'D', webLead: true, sourcePage: '/book', createdAt: ts('2026-11-20T15:00:00Z'), stage: 'lost', stageHistory: [{ from: 'new', to: 'inspected' }, { from: 'inspected', to: 'lost' }] },
  // E: a Thumbtack lead (not the website) with money: never counted.
  { id: 'E', webLead: false, sourcePage: '', createdAt: ts('2026-11-04T15:00:00Z'), stage: 'closed' },
  // F: a deleted web lead: never counted.
  { id: 'F', webLead: true, deleted: true, sourcePage: '/inspect', createdAt: ts('2026-11-04T15:00:00Z'), stage: 'closed' },
  // G: an area page form two years ago, paid long ago (outside both windows).
  { id: 'G', webLead: true, sourcePage: 'page-form:/areas/mason-oh', createdAt: ts('2024-06-01T15:00:00Z'), stage: 'closed' },
  // H: Oct 31 23:30 Eastern = Nov 1 UTC: belongs to OCTOBER in the company's timezone.
  { id: 'H', webLead: true, sourcePage: '/inspect', createdAt: ts('2026-11-01T03:30:00Z'), stage: 'new' },
];
const invoices = [
  { leadId: 'A', total: 1234.56, balanceDue: 0, payments: [{ amount: 1234.56, at: ts('2026-11-15T15:00:00Z') }],
    refunds: [{ amount: 34.56, at: ts('2026-11-20T15:00:00Z') }] },
  { leadId: 'C', total: 5000, balanceDue: 0, payments: [{ amount: 4500, at: ts('2026-04-01T15:00:00Z') }, { amount: 500, at: ts('2026-11-02T15:00:00Z') }] },
  { leadId: 'E', total: 9000, balanceDue: 0, paidAt: ts('2026-11-05T15:00:00Z') },
  { leadId: 'F', total: 7000, balanceDue: 0, paidAt: ts('2026-11-05T15:00:00Z') },
  { leadId: 'G', total: 8000, balanceDue: 0, paidAt: ts('2024-07-01T15:00:00Z') },
  // An unpaid invoice (estimate-sized money that was never collected).
  { leadId: 'B', total: 15000, balanceDue: 15000 },
  // A deleted invoice on a website customer.
  { leadId: 'A', total: 999, balanceDue: 0, paidAt: ts('2026-11-05T15:00:00Z'), deleted: true },
];
const pr = W.buildPageRevenue({ leads, invoices, todayYmd: '2026-12-01', tz: 'America/New_York', nowMs: NOW });
const row = (p) => pr.rows.find((r) => r.page === p);
const inspect = row('/inspect'), roof = row('/roof-check');
ok('/inspect month: 2 leads (A + /book D), 2 inspected, 1 sold', inspect && inspect.month.leads === 2 && inspect.month.inspected === 2 && inspect.month.sold === 1, JSON.stringify(inspect && inspect.month));
ok('/inspect collected = payment minus refund, in cents', inspect && inspect.month.collectedCents === 120000, inspect && inspect.month.collectedCents);
ok('a lead from Oct 31 Eastern is not in November', inspect && inspect.month.leads === 2 && inspect.year.leads === 3);
ok('/roof-check month: old /storm-check lead counted here, not sold', roof && roof.month.leads === 1 && roof.month.sold === 0 && roof.month.inspected === 0);
ok('/roof-check month money: only the Nov payment of an older customer', roof && roof.month.collectedCents === 50000);
ok('/roof-check 12 months: both its leads, both payments', roof && roof.year.leads === 2 && roof.year.sold === 1 && roof.year.collectedCents === 500000, JSON.stringify(roof && roof.year));
ok('no separate rows for redirected URLs', !row('/storm-check') && !row('/book'));
ok('unpaid invoice adds no money', roof && pr.total.month.collectedCents === 170000, pr.total.month.collectedCents);
ok('non-website, deleted and out-of-window money never counted', pr.total.year.collectedCents === 620000, pr.total.year.collectedCents);
ok('an old page with nothing in either window is not listed', !row('/areas/mason-oh'));
ok('rows sort by 12-month money, biggest first', pr.rows[0].page === '/roof-check' && pr.rows[1].page === '/inspect');
ok('money formats from cents', W.money(120000) === '$1,200' && W.money(123456) === '$1,234.56' && W.money(5) === '$0.05');

console.log('\n— marketing report: one tenant only —');
function fakeDb(data, opts) {
  const o = opts || {};
  return {
    doc: (p) => ({ get: async () => { const d = data[p]; return { exists: !!d, data: () => d }; } }),
    collection: (name) => ({
      where: (f, _op, v) => ({
        limit: () => ({
          get: async () => {
            if (o.fail) throw new Error('boom');
            const docs = (data[name] || []).filter((x) => x[f] === v).map((x) => ({ id: x.id, data: () => x }));
            return { docs };
          },
        }),
      }),
    }),
  };
}
const SITE = 'tenantA', OTHER = 'tenantB';
const data = {
  'companyProfile/tenantA': { timezone: 'America/New_York' },
  leads: [
    Object.assign({}, leads[0], { companyId: SITE, userId: SITE }),
    { id: 'X', companyId: OTHER, userId: OTHER, webLead: true, sourcePage: '/other-tenant-page', createdAt: ts('2026-11-05T15:00:00Z'), stage: 'closed' },
  ],
  invoices: [
    Object.assign({}, invoices[0], { companyId: SITE, createdBy: SITE }),
    { id: 'XI', leadId: 'X', companyId: OTHER, createdBy: OTHER, total: 77777, balanceDue: 0, paidAt: ts('2026-11-06T15:00:00Z') },
  ],
};
data.leads[0].id = 'A'; data.invoices[0].id = 'AI';
(async () => {
  const got = await MR.gatherPageRevenue(fakeDb(data), SITE, NOW);
  ok('reads only the site tenant: its page shows', got && got.rows.some((r) => r.page === '/inspect') && got.total.month.collectedCents === 120000);
  ok("another tenant's page and money never appear", got && !got.rows.some((r) => r.page === '/other-tenant-page'));
  const failedRead = await MR.gatherPageRevenue(fakeDb(data, { fail: true }), SITE, NOW);
  ok('a failed read is null (unknown), not an empty $0 table', failedRead === null);

  const html = MR.reportHtml('November 2026', { totalLeads: 0, bySource: {}, byUtm: {}, acks: 0, followUps: 0, funnelStarts: 0, funnelCompletes: 0, funnelAbandons: 0, recoveries: 0, crmStages: {}, stormCount: 0, pageRevenue: got });
  ok('email shows the page section with collected dollars', /Website pages → money, last month/.test(html) && /\$1,200/.test(html) && /last 12 months/.test(html));
  ok('email labels money as collected, not estimates', /money actually received/.test(html) && /Estimates and contracts are not counted/.test(html));
  const failHtml = MR.reportHtml('November 2026', { totalLeads: 0, bySource: {}, byUtm: {}, acks: 0, followUps: 0, funnelStarts: 0, funnelCompletes: 0, funnelAbandons: 0, recoveries: 0, crmStages: {}, stormCount: 0, pageRevenue: null });
  ok('a failed read says so in the email, never $0', /read failure, not \$0/.test(failHtml) && !/Website pages → money, last month/.test(failHtml));
  const evil = W.buildPageRevenue({ leads: [{ id: 'Z', webLead: true, sourcePage: '/<img src=x onerror=1>', createdAt: ts('2026-11-05T15:00:00Z'), stage: 'new' }], invoices: [], todayYmd: '2026-12-01', tz: 'America/New_York', nowMs: NOW });
  const evilHtml = MR.pageRevenueHtml(evil);
  ok('a page path from a form is escaped in the email', !/<img/.test(evilHtml) && /&lt;img/.test(evilHtml));

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
