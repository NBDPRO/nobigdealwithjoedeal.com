/**
 * tests/estimate-money-ladder.test.js — every estimate money read must handle
 * BOTH estimate shapes, and no code path may stamp a $0 job value.
 *
 * Background. Estimates exist in two shapes:
 *   V2       — name / grandTotal / rows
 *   Classic  — title / amount|total / lineItems
 * Classic is not legacy: it is what the customer page's own Log Estimate flow
 * writes, what `⎘ Copy` clones, and what the demo seed uses. A reader that
 * ladders `grandTotal` alone scores every Classic estimate 0.
 *
 * That had shipped in four places at once:
 *   - lead.jobValue stamping (3 sites in dashboard-bootstrap.module.js) — a
 *     WRITE. lead.jobValue is what the kanban column totals, the KPI tiles, the
 *     leaderboard and the customer header all read, so a 0 deletes a deal's
 *     value from every money surface simultaneously. Worse, the guard against
 *     it ("never zero a KPI off an estimate with no total") existed in exactly
 *     ONE of the four branches; the other three wrote the 0 through, and the
 *     confirm the rep clicked said "Use this estimate's $0 instead?".
 *   - createInvoiceFromEstimate — wrote a `total: 0` invoice DOC to Firestore
 *     for any Classic estimate, which Stripe then rejected, leaving an orphan
 *     $0 draft inside the AR rollups.
 *   - estimate cards + analytics — rendered $0 next to a lead showing the real
 *     figure, so one screen contradicted itself.
 *
 * Part 1 pins the shared reader contract. Part 2 is a static guard over the
 * money-bearing source files, because the defect is a *missing rung* — invisible
 * to any behavioural test that only feeds it V2 docs.
 *
 * Zero deps.  Run: node tests/estimate-money-ladder.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');
const read = (p) => fs.readFileSync(path.join(PRO_JS, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Strip line comments so prose describing the old bug never satisfies a guard.
function decomment(src) {
  return src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

console.log('ESTIMATE MONEY LADDER — two shapes, never a $0 stamp');

// ── Part 1: the canonical reader ──────────────────────────────────────
{
  const CR = require(path.join(PRO_JS, 'customer-estimate-rows.js'));
  const V = CR.estimateValue;
  ok('V2 grandTotal', V({ grandTotal: 14500 }) === 14500);
  ok('Classic total', V({ total: 14500 }) === 14500);
  ok('Classic amount', V({ amount: 14500 }) === 14500);
  ok('display-string amount ($14,500 -> 14500)', V({ amount: '$14,500' }) === 14500);
  ok('comma string', V({ total: '14,500' }) === 14500);
  ok('a genuine $0 draft stays 0 (not coerced to a later rung)',
    V({ grandTotal: 0, amount: 9000 }) === 0);
  ok('garbage -> 0, never NaN', V({ amount: 'n/a' }) === 0 && V(null) === 0);
}

// ── Part 2: no money-bearing file may ladder grandTotal alone ─────────
//
// The signature of the bug is reading `.grandTotal` without any sibling rung in
// the same expression. Assert per-file that the two-shape read is present at
// each site we fixed, rather than regex-hunting every possible spelling.
{
  const boot = decomment(read('dashboard-bootstrap.module.js'));

  ok('bootstrap defines one shared two-shape reader (_estValue)',
    /const _estValue = \(est\) =>/.test(boot) && /NBDCustomerEstimateRows/.test(boot));
  ok('bootstrap defines one shared stamping rule (_canStampJobValue)',
    /const _canStampJobValue = \(v\) =>/.test(boot) && /v > 0/.test(boot));

  // The three jobValue write sites must all go through both helpers.
  const stampSites = boot.match(/jobValue:/g) || [];
  ok('every jobValue write site is guarded (no bare Number(...grandTotal) stamp)',
    !/jobValue:\s*Number\([^)]*grandTotal/.test(boot),
    'a jobValue is being stamped straight from grandTotal');
  ok('bootstrap no longer reads grandTotal alone for a stamp',
    !/const newVal = Number\((est && )?est?\.?\w*\.?grandTotal\) \|\| 0/.test(boot));
  ok('found the expected number of jobValue writes (3 flows)',
    stampSites.length >= 3, `saw ${stampSites.length}`);
  ok('_canStampJobValue gates each write',
    (boot.match(/_canStampJobValue\(/g) || []).length >= 4,
    'each of the 4 branches (2 flows x first/reassign) must consult the rule');

  const inv = decomment(read('invoice-pipeline.js'));
  ok('invoice total is a two-shape read',
    /estimateValue\(est\)/.test(inv) && !/const savedGrand = Number\(est\.grandTotal\);/.test(inv));
  // R6-2-1 (2026-10-07): non-empty rows win, else lineItems — behaviour is
  // driven in tests/preflight-save-to-estimate-r6-2026-10-07.test.js.
  ok('invoice line items read Classic lineItems as well as V2 rows',
    /const src = useRows \? est\.rows : \(\(est && Array\.isArray\(est\.lineItems\)\) \? est\.lineItems : \[\]\);/.test(inv));
  ok('a $0 invoice can never be persisted',
    /Number\(invoiceData\.total\) > 0/.test(inv) && /throw new Error/.test(inv),
    'the backstop must sit before addDoc');
  // Ordering matters: a guard after the write is decoration.
  const guardAt = inv.indexOf('Number(invoiceData.total) > 0');
  const writeAt = inv.indexOf("addDoc(window.collection(db, 'invoices')");
  ok('the $0 backstop runs BEFORE the addDoc',
    guardAt > -1 && writeAt > -1 && guardAt < writeAt);

  const dw = decomment(read('dashboard-widgets.js'));
  ok('estimate cards use the two-shape reader',
    !/Number\(e\.grandTotal \|\| 0\)/.test(dw) && !/Number\(e\.grandTotal\|\|0\)/.test(dw),
    'dashboard-widgets still renders grandTotal alone');
  ok('dashboard-widgets defines its _estVal fallback',
    /function _estVal\(e\)/.test(dw));

  const ak = decomment(read('analytics-kpi.js'));
  ok('analytics avg-estimate-value reads all three keys',
    !/parseFloat\(e\.total\) \|\| parseFloat\(e\.grandTotal\) \|\| 0/.test(ak));

  const ea = decomment(read('estimate-analytics.js'));
  ok('estimate-analytics reads all three keys',
    !/Number\(e\.grandTotal \|\| e\.total \|\| 0\)/.test(ea));
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
