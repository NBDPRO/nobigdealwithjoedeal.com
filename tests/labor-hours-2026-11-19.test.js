/**
 * tests/labor-hours-2026-11-19.test.js — the pure rules behind the labor-hours
 * estimator (docs/pro/js/labor-hours-logic.js, flag laborHoursBook).
 *
 * Behaviour, not source shape. Each rule has a case that SHOULD fire and a control
 * that should not, so a rule that applies always (or never) cannot pass. Fixture
 * numbers are synthetic on purpose: nothing here is a real productivity figure.
 *
 * Run: node tests/labor-hours-2026-11-19.test.js
 */
const path = require('path');
const H = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'labor-hours-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; fails.push(name); console.log('  FAIL ' + name); }
}
const close = (a, b) => Math.abs(a - b) < 1e-9;

const BOOK = { A: { hoursPerUnit: 0.37 }, B: 1.13, Z: { hoursPerUnit: 0 } };
const RULES = { pitchFrom: 9, pitchPct: 15, layerPct: 10, storyPct: 7, cutUpPct: 12, accessModeratePct: 5, accessDifficultPct: 20 };

console.log('1. base hours from the book');
{
  const r = H.estimate({ lines: [{ laborId: 'A', quantity: 30 }, { laborId: 'B', quantity: 10 }], book: BOOK });
  ok('hours = sum of quantity x hours per unit (30 x 0.37 + 10 x 1.13 = 22.4)', close(r.baseHours, 22.4) && r.manHours === 22.4 && r.lines.length === 2);
  ok('with no factors the multiplier is exactly 1', r.multiplier === 1 && r.factors.length === 0);
  ok('control: the function form of the book reads the same', H.estimate({ lines: [{ laborId: 'A', quantity: 30 }], book: (id) => (id === 'A' ? 0.37 : null) }).baseHours === 11.1);
  ok('lines with no laborId, zero or negative quantity, or junk are ignored', H.estimate({ lines: [{ quantity: 5 }, { laborId: 'A', quantity: 0 }, { laborId: 'A', quantity: -3 }, { laborId: 'A', quantity: 'x' }, null], book: BOOK }).manHours === 0);
  ok('extra keys on a line (price, name) are ignored', H.estimate({ lines: [{ laborId: 'A', quantity: 10, rate: 99999, name: 'x' }], book: BOOK }).baseHours === 3.7);
}

console.log('2. nothing is invented');
{
  const r = H.estimate({ lines: [{ laborId: 'A', quantity: 10 }, { laborId: 'NOPE', quantity: 4 }, { laborId: 'NOPE', quantity: 6 }], book: BOOK });
  ok('an action with no hours is listed as missing, quantities summed, and adds nothing', r.missing.length === 1 && r.missing[0].laborId === 'NOPE' && r.missing[0].quantity === 10 && r.baseHours === 3.7);
  ok('an incomplete estimate says so (the screen shows "N lines have no hours yet")', r.complete === false);
  ok('control: a fully-known estimate is complete', H.estimate({ lines: [{ laborId: 'A', quantity: 1 }], book: BOOK }).complete === true);
  ok('a legit 0 hours-per-unit is a number the company entered: set, not missing', (() => { const z = H.estimate({ lines: [{ laborId: 'Z', quantity: 50 }], book: BOOK }); return z.complete === true && z.manHours === 0 && z.lines.length === 1; })());
  ok('negative, NaN, blank or text hours in the book count as missing', ['-1', 'abc', '', null, undefined, NaN].every((v) => H.estimate({ lines: [{ laborId: 'Q', quantity: 5 }], book: { Q: v } }).complete === false));
  const noRules = H.estimate({ lines: [{ laborId: 'A', quantity: 100 }], book: BOOK, measurements: { pitch: 12, tearOffLayers: 3, stories: 3, cutUpRoof: true, accessLevel: 'difficult' } });
  ok('with no factor percents set, no factor applies (a steep, tall, cut-up roof still adds 0)', noRules.factors.length === 0 && noRules.manHours === 37);
  ok('an empty book gives zero hours, nothing to book, and everything missing', (() => { const e = H.estimate({ lines: [{ laborId: 'A', quantity: 10 }], book: {} }); return e.manHours === 0 && e.daysToBook === null && e.missing.length === 1; })());
}

console.log('3. factors');
{
  const base = { lines: [{ laborId: 'A', quantity: 100 }], book: BOOK, rules: RULES };   // 37 base hours
  const f = (m) => H.estimate(Object.assign({}, base, { measurements: m }));
  ok('pitch below the threshold does not apply, at it does (>=)', f({ pitch: 8 }).factors.length === 0 && (f({ pitch: 9 }).factors[0] || {}).key === 'pitch' && f({ pitch: 12 }).multiplier === 1.15);
  ok('layers: 1 layer adds nothing, 3 layers add 2 x 10%', f({ tearOffLayers: 1 }).factors.length === 0 && close(f({ tearOffLayers: 3 }).multiplier, 1.2));
  ok('stories: 1 story adds nothing, 2 add 7%, 3 add 14%', f({ stories: 1 }).factors.length === 0 && close(f({ stories: 2 }).multiplier, 1.07) && close(f({ stories: 3 }).multiplier, 1.14));
  ok('complexity applies only for a cut-up roof', f({ cutUpRoof: false }).factors.length === 0 && close(f({ cutUpRoof: true }).multiplier, 1.12));
  ok('access: standard adds nothing, moderate 5%, difficult 20%', f({ accessLevel: 'standard' }).factors.length === 0 && close(f({ accessLevel: 'moderate' }).multiplier, 1.05) && close(f({ accessLevel: 'difficult' }).multiplier, 1.2));
  const all = f({ pitch: 10, tearOffLayers: 2, stories: 2, cutUpRoof: true, accessLevel: 'moderate' });
  ok('factors ADD, they do not compound: 15 + 10 + 7 + 12 + 5 = 49% -> x1.49', close(all.multiplier, 1.49) && all.factors.length === 5);
  ok('man-hours = base x multiplier (37 x 1.49 = 55.1)', all.baseHours === 37 && all.manHours === 55.1);
  ok('a factor with 0 or no percent is dropped, never shown as +0%', H.factorsFor({ stories: 4 }, { storyPct: 0 }).length === 0 && H.factorsFor({ stories: 4 }, {}).length === 0);
  ok('a pitch threshold of 0 or none never applies (no accidental match on every roof)', H.factorsFor({ pitch: 12 }, { pitchFrom: 0, pitchPct: 15 }).length === 0 && H.factorsFor({ pitch: 12 }, { pitchPct: 15 }).length === 0);
  ok('numbers that arrive as text (form fields) still work', close(H.estimate(Object.assign({}, base, { measurements: { stories: '2', tearOffLayers: '2' }, rules: { storyPct: '7', layerPct: '10' } })).multiplier, 1.17));
}

console.log('4. crew-days and days to book');
{
  const hrs = (h, crew) => H.estimate({ lines: [{ laborId: 'B', quantity: h }], book: { B: 1 }, crewSize: crew });
  ok('default crew of 3 working 8-hour days: 48 hours = 2.0 crew-days, book 2 days', hrs(48).crewSize === 3 && hrs(48).crewDays === 2 && hrs(48).daysToBook === 2);
  ok('a crew of 2: the same 48 hours = 3.0 crew-days', hrs(48, 2).crewDays === 3 && hrs(48, 2).daysToBook === 3);
  ok('a bad crew size (0, blank, text, negative) falls back to the default, never divides by zero', [0, '', 'x', -2, null].every((c) => hrs(48, c).crewSize === 3 && isFinite(hrs(48, c).crewDays)));
  ok('exactly one crew-day (24 hours, crew of 3) books 1 day, not 2', hrs(24).daysToBook === 1);
  ok('a hair over rounds UP to the next day (25 hours -> 2 days)', hrs(25).daysToBook === 2);
  ok('a tiny job still books at least 1 day', hrs(0.5).daysToBook === 1);
  ok('the booking is capped at the schedule\'s longest project (14 days)', hrs(5000).daysToBook === 14 && hrs(5000).crewDays > 14);
  ok('no hours means nothing to book (null, not 0 or 1)', hrs(0).daysToBook === null);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
