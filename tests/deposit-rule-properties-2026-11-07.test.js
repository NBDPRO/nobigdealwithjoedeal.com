/**
 * tests/deposit-rule-properties-2026-11-07.test.js — property tests on THE
 * deposit rule (docs/pro/js/deposit-rule.js, mirrored in functions/).
 *
 * The example tests (deposit-rule.test.js, ohio-4722-deposit-cap-2026-10-11,
 * estimate-pricing-paths-2026-10-05) pin known cases. This file throws
 * thousands of generated jobs at compute() and checks the rules that must
 * hold for EVERY input, so a change that is right on the pinned examples but
 * wrong on some odd total, deductible or override still goes red.
 * (OSS deep dive 2026-11-06, top-10 item 2. The idea is fast-check's; the
 * generator is a small seeded one in this file, because CI's "Unit suites"
 * job installs functions/ packages only, never tests/ — a dev dependency
 * would not exist there.)
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
 * Fixed seed, so a run is reproducible; a failure prints the input that broke it.
 * Run: node tests/deposit-rule-properties-2026-11-07.test.js
 */
'use strict';
const path = require('path');
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

// ── a tiny seeded generator (mulberry32) ─────────────────────────
let state = SEED >>> 0;
function rnd() {
  state = (state + 0x6D2B79F5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const maybe = (gen) => (rnd() < 0.5 ? undefined : gen());

function prop(name, gen, predicate) {
  state = SEED >>> 0;   // every property sees the same reproducible stream
  for (let i = 0; i < RUNS; i++) {
    const input = gen();
    let okRun = false, err = null;
    try { okRun = predicate(input) === true; } catch (e) { err = e; }
    if (!okRun) {
      failed++;
      console.log('  ✗ ' + name + '\n      run ' + i + ' input: ' + JSON.stringify(input) + (err ? '\n      threw: ' + (err && err.message) : ''));
      return;
    }
  }
  passed++; console.log('  ✓ ' + name);
}

// ── generators ──────────────────────────────────────────────────
// Totals cluster around the rule's edges ($2,000 and $25,000) as well as the
// whole range, so the boundaries are hit every run, not by luck.
const edgeCents = (c) => int(c - 300, c + 300);
const totalCents = () => {
  const r = rnd();
  if (r < 0.4) return int(1, 6000000);
  if (r < 0.6) return edgeCents(D.CASH_NO_DEPOSIT_UNDER_CENTS);
  if (r < 0.8) return edgeCents(D.OH_CAP_MIN_CENTS);
  return int(1, 5000);
};
const dollars = (maxCents) => int(0, maxCents) / 100;
const job = () => {
  const j = {
    totalCents: totalCents(),
    mode: pick(['cash', 'insurance', 'Insurance', '']),
    deductible: maybe(() => dollars(1000000)),
    acv: maybe(() => dollars(6000000)),
    state: maybe(() => pick(['OH', 'KY', 'IN', ''])),
    overrideAmount: maybe(() => pick([() => dollars(8000000), () => '', () => -5])()),
    overridePct: maybe(() => (rnd() < 0.8 ? int(-10, 120) : '')),
    specialOrder: maybe(() => rnd() < 0.5),
    constructionLoan: maybe(() => rnd() < 0.5),
  };
  // undefined keys must be ABSENT: compute() treats a present address/zip/state key as "a location was given"
  const o = {};
  Object.keys(j).forEach((k) => { if (j[k] !== undefined) o[k] = j[k]; });
  return o;
};
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

prop('3. cash deposit never goes down as the total goes up', () => [totalCents(), int(0, 500000)], ([t, extra]) => {
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

prop('6. insurance, not Kentucky, no override: the deductible is always collected', () => [totalCents(), int(1, 1000000)], ([t, dedCents]) => {
  const p = CLIENT.compute({ totalCents: t, mode: 'insurance', deductible: dedCents / 100 });
  return p.depositCents >= Math.min(dedCents, t);
});

prop('7. a cash dollar override is used as-is, clamped to [0, total]', () => [totalCents(), int(0, 8000000)], ([t, ovCents]) => {
  const p = CLIENT.compute({ totalCents: t, mode: 'cash', overrideAmount: ovCents / 100 });
  return p.depositCents === Math.min(ovCents, t);
});

prop('8. the browser copy and the server copy give the same plan', job, (j) => {
  return JSON.stringify(CLIENT.compute(j)) === JSON.stringify(SERVER.compute(j));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
