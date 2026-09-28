/**
 * tests/money-display-consumers.test.js — leaderboard + customer-tab money
 * display agree with the Money dashboard's cash basis.
 *
 * Both files are browser modules (Firebase CDN imports / window globals), so
 * these are source-contract guards per house style:
 *
 * 1. leaderboard.js — period revenue must sum payment entries by their own
 *    date (paymentsOf, incl. the transition-reconciliation synthetic), NOT
 *    gate on status==='paid' && isInPeriod(paidAt). The old gate hid every
 *    open-job deposit from the period, then dumped the FULL total into the
 *    payoff period — disagreeing with Money/Analytics Collected.
 *
 * 2. customer-tasks-ui.js loadInvoices — pipeline invoices carry `total`
 *    (never `amount`), and paid cash = total − balanceDue. The old code read
 *    inv.amount (always undefined → $0.00 rows) and counted cash only at
 *    status==='paid' (deposits invisible in Total Paid).
 *
 * Zero deps. Run: node tests/money-display-consumers.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LB = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/pages/leaderboard.js'), 'utf8');
const CT = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/customer-tasks-ui.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

console.log('MONEY DISPLAY CONSUMERS — leaderboard + customer tab');

// ── leaderboard.js ──
ok('leaderboard defines paymentsOf (ledger + legacy lump + reconciliation)',
  /function paymentsOf\(inv\)/.test(LB)
  && /remainderCents/.test(LB)
  && /synthetic: true/.test(LB));

ok('leaderboard revenue sums payments in-period (per payment date)',
  /paymentsOf\(inv\)\.forEach/.test(LB)
  && /isInPeriod\(p\.at\)/.test(LB));

ok('leaderboard revenue no longer computed from status===paid invoice totals',
  !/paidInvoices\.reduce\([^)]*inv\.total/.test(LB));

// Reversed 2026-09-28 (Jo: "Revenue is always collected only"): $0 collected
// reads $0 — never a won-jobValue stand-in labelled revenue.
ok('leaderboard has NO jobValue fallback when no invoice cash',
  !/totalRevenue > 0 \? totalRevenue : wonLeads\.reduce/.test(LB) && /const revenueFallback = totalRevenue;/.test(LB));

// ── customer-tasks-ui.js loadInvoices ──
ok('customer tab reads inv.total (amount only as legacy fallback)',
  /inv\.total != null \? inv\.total : inv\.amount/.test(CT));

ok('customer tab paid cash = total − balanceDue (not status gate)',
  /paidCash = Math\.max\(0, amount - bal\)/.test(CT)
  && /totalPaid \+= paidCash/.test(CT));

ok('customer tab old inv.amount-only read is gone',
  !/parseFloat\(inv\.amount \|\| 0\)/.test(CT));

ok('customer tab no longer gates Total Paid on status===paid',
  !/if \(isPaid\) totalPaid/.test(CT));

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
