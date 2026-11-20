/**
 * tests/job-hours-2026-11-20.test.js — a job's man-hours from the company's own
 * BOOK TIME per job type (docs/pro/js/job-hours-logic.js, flag laborHoursBook).
 *
 * Behaviour, not source shape. Each rule has a case that SHOULD fire and a control that
 * should not. Fixture numbers are synthetic: nothing here is a real productivity figure.
 *
 * Run: node tests/job-hours-2026-11-20.test.js
 */
const path = require('path');
const J = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'job-hours-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; fails.push(name); console.log('  FAIL ' + name); }
}
const close = (a, b) => Math.abs(a - b) < 1e-9;

const BOOK = { 'BOOK:replacement': { hoursPerUnit: 1.25 }, 'BOOK:repair': { hoursPerUnit: 6 } };
const RULES = { pitchFrom: 9, pitchPct: 15, layerPct: 10, storyPct: 7, cutUpPct: 12, accessModeratePct: 5, accessDifficultPct: 20 };
const est = (over) => Object.assign({ workKind: 'replacement', sq: 30, pl: 6, stories: 1, tearOffLayers: 1, cutUpRoof: false, accessLevel: 'standard' }, over || {});

console.log('1. which job type');
{
  ok('a replacement', J.jobTypeOf(est()).type === 'replacement');
  ok('a repair', J.jobTypeOf(est({ workKind: 'repair' })).type === 'repair');
  ok('an estimate that does not say gets a reason, not a guess', J.jobTypeOf(est({ workKind: null })).type === null && /repair or a replacement/.test(J.jobTypeOf(est({ workKind: null })).reason));
  ok('an unknown work kind is not guessed either', J.jobTypeOf(est({ workKind: 'roofing' })).type === null && J.jobTypeOf(est({ workKind: '' })).type === null);
  ok('no estimate at all says so', J.jobTypeOf(null).type === null && /no estimate/.test(J.jobTypeOf(undefined).reason) && J.jobTypeOf('x').type === null);
}

console.log('2. quantity');
{
  const r = J.forEstimate({ estimate: est({ sq: 30 }), book: BOOK });
  ok('a replacement multiplies the book time by the squares: 30 x 1.25 = 37.5', r.ok && r.quantity === 30 && r.unit === 'SQ' && r.result.manHours === 37.5);
  ok('a repair is one job: 6 hours, whatever the squares', (() => { const x = J.forEstimate({ estimate: est({ workKind: 'repair', sq: 400 }), book: BOOK }); return x.ok && x.quantity === 1 && x.unit === 'job' && x.result.manHours === 6; })());
  ok('a fractional square count is used as is (32.5 x 1.25 = 40.6)', J.forEstimate({ estimate: est({ sq: 32.5 }), book: BOOK }).result.manHours === 40.6);
  ok('a replacement with 0, negative, blank or text squares gets a reason, never a number', [0, -3, '', null, undefined, 'x'].every((v) => { const x = J.forEstimate({ estimate: est({ sq: v }), book: BOOK }); return x.ok === false && /no squares/.test(x.reason); }));
  ok('squares that arrive as text still work', J.forEstimate({ estimate: est({ sq: '30' }), book: BOOK }).result.manHours === 37.5);
  ok('control: a repair with no squares is fine', J.forEstimate({ estimate: est({ workKind: 'repair', sq: 0 }), book: BOOK }).ok === true);
}

console.log('3. nothing is invented');
{
  const none = J.forEstimate({ estimate: est(), book: {} });
  ok('no book time for the job type: ok, zero hours, flagged', none.ok && none.noBookTime === true && none.result.manHours === 0 && none.result.complete === false && none.result.daysToBook === null);
  ok('the missing key is the replacement book key', none.result.missing[0].laborId === 'BOOK:replacement');
  ok('only the other job type\'s book time is NOT used (a repair book time does not price a replacement)', J.forEstimate({ estimate: est(), book: { 'BOOK:repair': { hoursPerUnit: 6 } } }).noBookTime === true);
  const zero = J.forEstimate({ estimate: est(), book: { 'BOOK:replacement': { hoursPerUnit: 0 } } });
  ok('a real 0 book time is set: zero hours, not flagged', zero.ok && zero.noBookTime === false && zero.result.manHours === 0 && zero.result.complete === true);
  ok('junk book time (negative, text, blank) counts as not set', ['-1', 'abc', '', null].every((v) => J.forEstimate({ estimate: est(), book: { 'BOOK:replacement': v } }).noBookTime === true));
  ok('the function form of the book works too', J.forEstimate({ estimate: est(), book: (id) => (id === 'BOOK:replacement' ? 2 : null) }).result.manHours === 60);
  ok('control: a roof with every factor condition and NO rules set still applies none', J.forEstimate({ estimate: est({ pl: 12, stories: 3, tearOffLayers: 3, cutUpRoof: true, accessLevel: 'difficult' }), book: BOOK }).result.factors.length === 0);
}

console.log('4. factors and crew-days');
{
  const r = J.forEstimate({ estimate: est({ pl: 10, tearOffLayers: 2, stories: 2, cutUpRoof: true, accessLevel: 'moderate' }), book: BOOK, rules: RULES });
  ok('the estimate\'s own fields feed the factors: pitch, layers, stories, cut-up, access', r.result.factors.map((f) => f.key).sort().join() === 'access,complexity,layers,pitch,stories');
  ok('15 + 10 + 7 + 12 + 5 = 49% on 37.5 hours = 55.9', close(r.result.multiplier, 1.49) && r.result.manHours === 55.9);
  ok('the older cutUp field name is read when cutUpRoof is absent', J.forEstimate({ estimate: { workKind: 'replacement', sq: 30, cutUp: true }, book: BOOK, rules: RULES }).result.factors.some((f) => f.key === 'complexity'));
  ok('the pitch field `pitch` is read when `pl` is absent', J.forEstimate({ estimate: { workKind: 'replacement', sq: 30, pitch: 12 }, book: BOOK, rules: RULES }).result.factors.some((f) => f.key === 'pitch'));
  const c3 = J.forEstimate({ estimate: est(), book: BOOK });
  ok('default crew of 3: 37.5 hours = 1.6 crew-days, book 2 days', c3.result.crewSize === 3 && c3.result.crewDays === 1.6 && c3.result.daysToBook === 2);
  const c5 = J.forEstimate({ estimate: est(), book: BOOK, crewSize: 5 });
  ok('a crew of 5: 0.9 crew-days, book 1 day', c5.result.crewSize === 5 && c5.result.crewDays === 0.9 && c5.result.daysToBook === 1);
  ok('the inputs are not modified', (() => { const e = est(); const b = JSON.parse(JSON.stringify(BOOK)); const eCopy = JSON.stringify(e); J.forEstimate({ estimate: e, book: b, rules: RULES }); return JSON.stringify(e) === eCopy && JSON.stringify(b) === JSON.stringify(BOOK); })());
  ok('PRIVACY: nothing priced leaks into the output (no price, total, rate or margin keys)', !/price|total|rate|margin|cost/i.test(JSON.stringify(J.forEstimate({ estimate: est({ grandTotal: 99999, tierPrices: { good: 1 } }), book: BOOK }))));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
