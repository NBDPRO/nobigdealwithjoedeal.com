/**
 * tests/vw-f13-2026-11-08.test.js — CRM audit 2026-11-06, VW-F13.
 *
 * Lead Source ROI (docs/pro/js/lead-source-roi.js) falls back to marketing
 * expenses for a source with no monthly spend and no per-lead cost. It read
 * them with where('userId','==',uid) alone, so in a company with teammates
 * the owner's "Spend" and "Cost / job won" left out every marketing expense a
 * teammate logged and read too low. Staff now read the tenant's rows by
 * companyId — the same rule-safe scope as expenses.js fetchExpenses() and
 * numbers-data.js loadExpenses(); everyone else keeps the userId read.
 *
 * And a failed read fell to {} — "no expenses" — so the row showed "—" (no
 * spend) when the truth was "unknown". It now shows "…".
 *
 * Loads the real numbers-logic.js + lead-source-roi.js in a vm, with a
 * getDocs stub that answers a query the way Firestore would (filters the rows
 * by the query's where()). Zero deps. Run: node tests/vw-f13-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');

// One company (co-1): the owner and a teammate each logged a Referral
// marketing expense. Another tenant's row must never be counted.
const EXPENSES = [
  { userId: 'own1', companyId: 'own1', category: 'marketing', marketingSource: 'Referral', amountCents: 10000 },
  { userId: 'rep2', companyId: 'own1', category: 'marketing', marketingSource: 'referral', amountCents: 30000 },
  { userId: 'zz9', companyId: 'other', category: 'marketing', marketingSource: 'Referral', amountCents: 99900 },
];

async function run(opts) {
  const panel = { innerHTML: '', offsetParent: {} };
  const wheres = [];
  let reads = 0;
  const win = {
    db: {}, _user: { uid: opts.uid }, _userClaims: opts.claims,
    _leads: [{ id: 'L1', source: 'Referral', stage: 'won', jobValue: 12000 }],
    collection: (d, c) => ({ c }),
    where: (f, op, v) => { const w = { f, op, v }; wheres.push(w); return w; },
    query: (col, ...ws) => ({ c: col.c, ws }),
    getDocs: async (q) => {
      if (q.c !== 'expenses') return { docs: [] };
      reads++;
      if (opts.fail) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
      const rows = EXPENSES.filter((e) => q.ws.every((w) => e[w.f] === w.v));
      return { docs: rows.map((e) => ({ data: () => e })) };
    },
    NBDNumbersData: { isOwner: () => true, loadSpend: async () => ({ months: {} }) },
  };
  win.window = win;
  const document = {
    addEventListener() {}, getElementById: (id) => (id === 'roiPanel' ? panel : null),
    querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }),
  };
  const sb = { window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout, Promise, Math, JSON, Date, Object, Number, String, Array, parseInt, isNaN };
  vm.createContext(sb);
  vm.runInContext(read('numbers-logic.js'), sb, { filename: 'numbers-logic.js' });
  vm.runInContext(read('lead-source-roi.js'), sb, { filename: 'lead-source-roi.js' });
  win.LeadSourceROI.render('roiPanel');
  await flush();
  await flush();
  // The Referral row's cells, tags stripped:
  // Source · Leads · Won % · Booked · Collected · Spend · Cost / job won · Booked per $1
  const body = (panel.innerHTML.split('<tbody>')[1] || '').split('</tbody>')[0];
  const row = body.split('</tr>').find((r) => /lsroi-source">Referral/.test(r)) || '';
  const cells = row.split('</td>').slice(0, -1).map((c) => c.replace(/<div[^>]*>.*?<\/div>/g, '').replace(/<[^>]+>/g, '').trim());
  return { wheres, reads, cells, html: panel.innerHTML };
}
const has = (ws, f, v) => ws.some((w) => w.f === f && w.op === '==' && w.v === v);

(async function main() {
  console.log('LEAD SOURCE ROI: TEAM MARKETING EXPENSES (VW-F13)');

  const solo = await run({ uid: 'own1', claims: {} });
  ok('positive control: the table renders a Referral row with the owner columns', solo.cells.length === 8, JSON.stringify(solo.cells));
  ok('a solo owner (no claims) reads their own expenses by userId', has(solo.wheres, 'userId', 'own1') && !solo.wheres.some((w) => w.f === 'companyId'), JSON.stringify(solo.wheres));
  ok('a solo owner\'s Referral spend is their own $100', solo.cells[5] === '$100', solo.cells[5]);

  const team = await run({ uid: 'own1', claims: { role: 'company_admin', companyId: 'own1' } });
  ok('a company_admin owner reads the tenant\'s expenses by companyId', has(team.wheres, 'companyId', 'own1'), JSON.stringify(team.wheres));
  ok('...and not by userId (that drops a teammate\'s rows)', !team.wheres.some((w) => w.f === 'userId'), JSON.stringify(team.wheres));
  ok('Spend counts the teammate\'s marketing expense: $100 + $300 = $400', team.cells[5] === '$400', team.cells[5]);
  ok('Cost / job won is $400 for the one won job (was $100)', team.cells[6] === '$400', team.cells[6]);
  ok('another tenant\'s expense is never counted', !/\$1,399|\$999|\$1k/.test(team.html));

  const mgr = await run({ uid: 'own1', claims: { role: 'manager', companyId: 'own1' } });
  ok('a manager reads by companyId too (isCompanyStaff in firestore.rules)', has(mgr.wheres, 'companyId', 'own1') && !mgr.wheres.some((w) => w.f === 'userId'), JSON.stringify(mgr.wheres));

  const rep = await run({ uid: 'own1', claims: { role: 'sales_rep', companyId: 'own1' } });
  ok('a sales_rep keeps the userId read (a companyId list read is permission-denied for them)', has(rep.wheres, 'userId', 'own1') && !rep.wheres.some((w) => w.f === 'companyId'), JSON.stringify(rep.wheres));

  const noCo = await run({ uid: 'own1', claims: { role: 'company_admin' } });
  ok('staff without a companyId claim keep the userId read', has(noCo.wheres, 'userId', 'own1') && !noCo.wheres.some((w) => w.f === 'companyId'), JSON.stringify(noCo.wheres));

  const fail = await run({ uid: 'own1', claims: { role: 'company_admin', companyId: 'own1' }, fail: true });
  ok('a failed expenses read shows the fallback spend as unknown ("…"), not "no spend" ("—")', fail.cells[5] === '…', JSON.stringify(fail.cells[5]));
  ok('a failed read is tried once, not re-fetched in a loop', fail.reads === 1, String(fail.reads));

  const none = await run({ uid: 'nobody', claims: {} });
  ok('control: a read that succeeds with no marketing rows still shows "—" (known: no spend)', none.cells[5] === '—', JSON.stringify(none.cells[5]));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
