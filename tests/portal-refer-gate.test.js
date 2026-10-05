/* portal-refer-gate.test.js
 *
 * Refer-a-friend must not claim work that has not happened.
 *
 * The card was gated on `customerId` alone. customerId is stamped early in
 * the lead lifecycle, so a homeowner who opened the portal the same
 * afternoon the rep knocked was handed SMS copy reading "They did a great
 * job for me" and email copy reading "the guys who did mine were great",
 * addressed to their friends. It is the one card designed to leave the
 * property, so it is the most embarrassing thing on the page if forwarded
 * before anything happened — and it poisons the referral channel it exists
 * to grow.
 *
 * The correct gate already existed for the rating card: the server sets
 * rating.canRate, re-enforced when a rating is submitted. Since 2026-10-03
 * (functions/homeowner-progress.js) that gate is PAID IN FULL. Both cards
 * assert the work is done, so both wait until it is.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const PORTAL_JS = read('docs/pro/js/portal.js');
const PORTAL_FN = read('functions/portal.js');

// Comments quote the old copy to explain the fix; assert against code.
const CODE = PORTAL_JS
  // Line-wise: a /\*...\*/ regex swallows real code in these files (they
  // contain comment-looking sequences inside regex literals and strings —
  // measured 10-48% of the file destroyed), which makes ABSENCE assertions
  // pass against a corpus that no longer holds the region they guard.
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .join('\n');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

group('The card still exists and still says what it says', () => {
  // If this copy ever softens, the gate could legitimately relax — so pin
  // the premise rather than silently guarding a card that no longer claims
  // completed work.
  assert('SMS copy still asserts completed work',
    /They did a great job for me/.test(CODE),
    'if the copy changed, re-derive the correct gate before touching this suite');
  assert('email copy still asserts completed work',
    /the guys who did mine were great/.test(CODE));
  assert('the referral card is still rendered here', /Refer a friend/.test(CODE));
});

group('It renders only when the job is paid in full', () => {
  assert('a jobComplete flag is derived from the rating card\'s own canRate',
    /const jobComplete = !!\(view\.rating && view\.rating\.canRate === true\);/.test(CODE));
  assert('the gate requires BOTH a referral code and completion',
    /if \(customerId && jobComplete\) \{/.test(CODE));
  assert('customerId alone no longer gates it',
    !/const customerId = view\.homeowner && view\.homeowner\.customerId;\s*if \(customerId\) \{/.test(CODE),
    'this is the exact shape that shipped the bug');
  assert('the retired 5-step "complete" key is not consulted',
    !/currentKey === 'complete'/.test(CODE));
});

group('canRate is the server\'s paid-in-full gate', () => {
  assert('the rating card flag is the resolver\'s paidInFull',
    /canRate: hp\.paidInFull,/.test(PORTAL_FN),
    'refer + rate should agree; if this moves, move the referral gate with it');
  const HP = require(path.join(ROOT, 'functions', 'homeowner-progress.js'));
  assert('an unpaid finished roof does not unlock it',
    HP.paidInFullFor({ stage: 'final_photos' }, [{ balanceDue: 4200 }]) === false);
  assert('a paid one does',
    HP.paidInFullFor({ stage: 'final_payment' }, [{ balanceDue: 0 }]) === true);
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
