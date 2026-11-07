/**
 * tests/deposit-rule-properties-2026-11-07.test.js — property tests on THE
 * deposit rule (docs/pro/js/deposit-rule.js, mirrored in functions/).
 *
 * The example tests (deposit-rule.test.js, ohio-4722-deposit-cap-2026-10-11,
 * estimate-pricing-paths-2026-10-05) pin known cases. This file throws
 * thousands of generated jobs at compute() and checks the rules that must
 * hold for EVERY input, so a change that is right on the pinned examples but
 * wrong on some odd total, deductible or override still goes red.
 * (OSS deep dive 2026-11-06, top-10 item 2: fast-check, MIT, dev dependency.)
 *
 *   1. money is integer cents; 0 <= deposit <= total; deposit + balance === total
 *   2. cash, no location: under $2,000 -> no deposit; $2,000 and up -> 50%,
 *      rounded to the $25 step, so within $12.50 of half
 *   3. cash deposit never goes DOWN as the total goes up
 *   4. Kentucky insurance job: $0 at signing, whatever the rep override says
 *   5. Ohio property over $25,000 (no special order, no construction loan):
 *      never more than 10% at signing
 *   6. insurance, not Kentucky, no override: the deductible is always
 *      collected (deposit >= the deductible, or the whole total if smaller)
 *   7. a cash dollar override is used as-is, clamped to [0, total]
 *   8. the browser copy and the server copy give the same plan
 *
 * Fixed seed, so a run is reproducible; a failure prints the shrunk input.
 * Run: node tests/deposit-rule-properties-2026-11-07.test.js
 */
'use strict';
const path = require('path');
const fc = require('fast-check');
const ROOT = path.join(__dirname, '..');
const CLIENT = require(path.join(ROOT, 'docs/pro/js/deposit-rule.js'));
const SERVER = require(path.join(ROOT, 'functions/deposit-rule.js'));
// The DECIDED rule, written here on purpose rather than read from the module:
// a test that reads DEFAULTS moves with a wrong number (break-tested: an Ohio
// cap typo of 11% and a $2,500 threshold both passed that way). Joe's rule
// (2026-09-25) and ORC 4722.04; changing one is a deliberate edit in both places.
const D = {
  CASH_NO_DEPOSIT_UNDER_CENTS: 200000,   // cash under $2,000.00: no deposit
  CASH_DEPOSIT_PCT: 50,                  // cash $2,000.00 and up: 50%
  CASH_DEPOSIT_ROUND_TO_CENTS: 2500,     // rounded to the nearest $25
  OH_CAP_MIN_CENTS: 2500000,             // Ohio: a contract OVER $25,000.00 is covered
  OH_CAP_PCT: 10,                        // at most 10% before work begins
};

const SEED = 20261107;
const RUNS = 600;
let passed = 0, failed = 0;
function prop(name, arb, predicate) {
  try {
    fc.assert(fc.property(arb, predicate), { seed: SEED, numRuns: RUNS });
    passed++; console.log('  ✓ ' + name);
  } catch (e) {
    failed++; console.log('  ✗ ' + name + '\n      ' + String(e && e.message || e).split('\n').slice(0, 6).join('\n      '));
  }
}

// ── generators ──────────────────────────────────────────────────
// Totals cluster around the rule's edges ($2,000 and $25,000) as well as the
// whole range, so the boundaries are hit every run, not by luck.
const edgeCents = (c) => fc.integer({ min: c - 300, max: c + 300 });
const totalCents = fc.oneof(
  fc.integer({ min: 1, max: 6000000 }),
  edgeCents(D.CASH_NO_DEPOSIT_UNDER_CENTS),
  edgeCents(D.OH_CAP_MIN_CENTS),
  fc.integer({ min: 1, max: 5000 })
);
const dollars = (maxCents) => fc.integer({ min: 0, max: maxCents }).map((c) => c / 100);
const job = fc.record({
  totalCents: totalCents,
  mode: fc.constantFrom('cash', 'insurance', 'Insurance', ''),
  deductible: fc.option(dollars(1000000), { nil: undefined }),
  acv: fc.option(dollars(6000000), { nil: undefined }),
  state: fc.option(fc.constantFrom('OH', 'KY', 'IN', ''), { nil: undefined }),
  overrideAmount: fc.option(fc.oneof(dollars(8000000), fc.constant(''), fc.constant(-5)), { nil: undefined }),
  overridePct: fc.option(fc.oneof(fc.integer({ min: -10, max: 120 }), fc.constant('')), { nil: undefined }),
  specialOrder: fc.option(fc.boolean(), { nil: undefined }),
  constructionLoan: fc.option(fc.boolean(), { nil: undefined }),
}).map((j) => {
  // undefined keys must be ABSENT: compute() treats a present address/zip/state key as "a location was given"
  const o = {};
  Object.keys(j).forEach((k) => { if (j[k] !== undefined) o[k] = j[k]; });
  return o;
});
const isInt = (n) => Number.isInteger(n);

console.log('deposit rule: properties over generated jobs (seed ' + SEED + ', ' + RUNS + ' runs each)');

prop('1. integer cents; 0 <= deposit <= total; deposit + balance === total', job, (j) => {
  const p = CLIENT.compute(j);
  return isInt(p.totalCents) && isInt(p.depositCents) && isInt(p.balanceCents) &&
    p.depositCents >= 0 && p.depositCents <= p.totalCents && p.depositCents + p.balanceCents === p.totalCents &&
    p.totalCents === j.totalCents;
});

prop('2. cash, no location: none under $2,000; 50% (to the $25 step) from $2,000', totalCents, (t) => {
  const p = CLIENT.compute({ totalCents: t, mode: 'cash' });
  if (t < D.CASH_NO_DEPOSIT_UNDER_CENTS) return p.depositCents === 0;
  return Math.abs(p.depositCents - t / 2) <= D.CASH_DEPOSIT_ROUND_TO_CENTS / 2 && p.depositCents % D.CASH_DEPOSIT_ROUND_TO_CENTS === 0 || p.depositCents === t;
});

prop('3. cash deposit never goes down as the total goes up', fc.tuple(totalCents, fc.integer({ min: 0, max: 500000 })), ([t, extra]) => {
  const a = CLIENT.compute({ totalCents: t, mode: 'cash' }).depositCents;
  const b = CLIENT.compute({ totalCents: t + extra, mode: 'cash' }).depositCents;
  return b >= a;
});

prop('4. Kentucky insurance job: $0 at signing, even with a rep override', job, (j) => {
  const p = CLIENT.compute(Object.assign({}, j, { mode: 'insurance', state: 'KY' }));
  return p.depositCents === 0 && p.kyHold === true && p.balanceCents === j.totalCents;
});

prop('5. Ohio over $25,000, no special order or construction loan: at most 10% at signing', job, (j) => {
  const input = Object.assign({}, j, { state: 'OH', specialOrder: false, constructionLoan: false });
  delete input.specialOrderCents;
  if (!(j.totalCents > D.OH_CAP_MIN_CENTS)) return true;
  if (input.mode === 'insurance' || input.mode === 'Insurance') return true;   // the cap's insurance route is pinned by its own suite
  const p = CLIENT.compute(input);
  return p.depositCents <= Math.floor(j.totalCents * D.OH_CAP_PCT / 100);
});

prop('6. insurance, not Kentucky, no override: the deductible is always collected', fc.tuple(totalCents, fc.integer({ min: 1, max: 1000000 })), ([t, dedCents]) => {
  const p = CLIENT.compute({ totalCents: t, mode: 'insurance', deductible: dedCents / 100 });
  return p.depositCents >= Math.min(dedCents, t);
});

prop('7. a cash dollar override is used as-is, clamped to [0, total]', fc.tuple(totalCents, fc.integer({ min: 0, max: 8000000 })), ([t, ovCents]) => {
  const p = CLIENT.compute({ totalCents: t, mode: 'cash', overrideAmount: ovCents / 100 });
  return p.depositCents === Math.min(ovCents, t);
});

prop('8. the browser copy and the server copy give the same plan', job, (j) => {
  return JSON.stringify(CLIENT.compute(j)) === JSON.stringify(SERVER.compute(j));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
