/* tests/portal-timeline-docs-balance-2026-09-16.test.js
 *
 * Covers the three server-side additions from the homeowner-portal deep
 * dive (2026-09-16): dated stage-history milestones, the documents shelf's
 * visibility gate, and the balance-due card never rendering a dead button.
 *
 * Same house style as portal-scheduled-date.test.js: lift the pure
 * functions out of functions/portal.js and docs/pro/js/portal.js with vm
 * rather than importing the file (portal.js pulls in firebase-admin at
 * module scope, which this suite has no emulator for), and assert wiring
 * shape against the raw source text for the parts that aren't standalone
 * functions.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PORTAL_FN = read('functions/portal.js');
const PORTAL = read('docs/pro/js/portal.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

function liftBetween(src, startMarker, endMarker, fromIndex) {
  const start = src.indexOf(startMarker, fromIndex || 0);
  if (start < 0) return null;
  const end = src.indexOf(endMarker, start);
  return end < 0 ? null : src.slice(start, end + endMarker.length);
}

/* ── milestoneDatesFor lives in functions/homeowner-progress.js since the
   2026-10-03 9-step rebuild (a pure module — required, not lifted);
   _isDocVisibleToHomeowner is still lifted from functions/portal.js ── */
const { milestoneDatesFor } = require(path.join(ROOT, 'functions', 'homeowner-progress.js'));
const visibleDocSrc = liftBetween(PORTAL_FN, 'function _isDocVisibleToHomeowner(d) {', '\n}');

group('Both helpers are present', () => {
  assert('milestoneDatesFor is exported by homeowner-progress.js', typeof milestoneDatesFor === 'function');
  assert('portal.js uses it for the view', /milestoneDates: milestoneDatesFor\(lead\)/.test(PORTAL_FN));
  assert('found _isDocVisibleToHomeowner', !!visibleDocSrc,
    'if it moved, update the extractor — do NOT delete the suite');
});
if (!visibleDocSrc) {
  console.log('\ncannot continue'); console.log(passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
}

const ctx = { Array, String };
vm.createContext(ctx);
vm.runInContext(visibleDocSrc + '\nthis.__v = _isDocVisibleToHomeowner;', ctx);
const isDocVisible = ctx.__v;

/* ══════════════════════════════════════════════════════════════════
   1. milestoneDatesFor — first entry wins on a bounce-back
   ══════════════════════════════════════════════════════════════════ */
group('milestoneDatesFor: first-reached date, not last', () => {
  // A lead that reached "Build" (install_in_progress), got bounced back to
  // "Signed" (job_created — a stage that ALSO maps to signed) for a
  // re-schedule, then re-advanced. The date the homeowner sees for each step
  // must be the FIRST time they reached it, not overwritten by the bounce.
  const lead = {
    stageHistory: [
      { from: 'new', to: 'inspected', timestamp: '2026-09-01T12:00:00.000Z' },
      { from: 'inspected', to: 'contract_signed', timestamp: '2026-09-05T12:00:00.000Z' },
      { from: 'contract_signed', to: 'install_in_progress', timestamp: '2026-09-10T12:00:00.000Z' },
      // Bounce back to a stage that ALSO maps to signed — must NOT push the
      // signed date forward to this later time.
      { from: 'install_in_progress', to: 'job_created', timestamp: '2026-09-12T12:00:00.000Z' },
      { from: 'job_created', to: 'install_in_progress', timestamp: '2026-09-14T12:00:00.000Z' },
    ]
  };
  const dates = milestoneDatesFor(lead);
  assert('inspection keeps its one date', dates.inspection === '2026-09-01T12:00:00.000Z', JSON.stringify(dates));
  assert('signed keeps the FIRST time it was reached (Sept 5), not the Sept 12 bounce-back',
    dates.signed === '2026-09-05T12:00:00.000Z', JSON.stringify(dates));
  assert('build keeps the first time it was reached (Sept 10), not the Sept 14 re-entry',
    dates.build === '2026-09-10T12:00:00.000Z', JSON.stringify(dates));
  assert('review was never reached — no date at all (not null, not undefined-as-a-key)',
    !('review' in dates), JSON.stringify(dates));
});

group('milestoneDatesFor: defensive on malformed/absent history', () => {
  assert('no stageHistory at all → {}', JSON.stringify(milestoneDatesFor({})) === '{}');
  assert('stageHistory not an array → {}', JSON.stringify(milestoneDatesFor({ stageHistory: 'nope' })) === '{}');
  assert('a custom tenant stage not in STAGE_TO_STEP is skipped, not crashing',
    JSON.stringify(milestoneDatesFor({ stageHistory: [{ to: 'tenant_custom_stage_xyz', timestamp: '2026-09-01T00:00:00.000Z' }] })) === '{}');
  assert('a Firestore-Timestamp-shaped entry (not a plain string) is skipped — timestamp is always new Date().toISOString() per stage-write.js',
    JSON.stringify(milestoneDatesFor({ stageHistory: [{ to: 'inspected', timestamp: { seconds: 123, nanoseconds: 0 } }] })) === '{}');
  assert('an entry missing `to` is skipped',
    JSON.stringify(milestoneDatesFor({ stageHistory: [{ timestamp: '2026-09-01T00:00:00.000Z' }] })) === '{}');
});

/* ══════════════════════════════════════════════════════════════════
   2. _isDocVisibleToHomeowner — defaults closed for uploads
   ══════════════════════════════════════════════════════════════════ */
group('_isDocVisibleToHomeowner: generated docs are always visible', () => {
  assert('generated:true, no sharedWithHomeowner field at all → visible',
    isDocVisible({ generated: true }) === true);
  assert('generated:true, sharedWithHomeowner explicitly false → STILL visible (generated wins)',
    isDocVisible({ generated: true, sharedWithHomeowner: false }) === true);
});

group('_isDocVisibleToHomeowner: uploads default CLOSED', () => {
  assert('not generated, no sharedWithHomeowner field → NOT visible (the opt-in default)',
    isDocVisible({}) === false);
  assert('not generated, sharedWithHomeowner explicitly false → NOT visible',
    isDocVisible({ generated: false, sharedWithHomeowner: false }) === false);
  assert('not generated, sharedWithHomeowner true → visible (the rep opted it in)',
    isDocVisible({ generated: false, sharedWithHomeowner: true }) === true);
  // Truthy-but-not-boolean-true must NOT satisfy a strict === true gate —
  // this is exactly the kind of loose-equality drift that let a legacy
  // string stage slip through progressKeyFor's own gate (see that
  // function's 2026-09-08 comment in this same file).
  assert('sharedWithHomeowner as the STRING "true" does not count — strict boolean only',
    isDocVisible({ sharedWithHomeowner: 'true' }) === false);
});

group('_isDocVisibleToHomeowner: soft-delete overrides everything', () => {
  assert('deleted:true hides an otherwise-generated row',
    isDocVisible({ generated: true, deleted: true }) === false);
  assert('deleted:true hides an otherwise-shared row',
    isDocVisible({ sharedWithHomeowner: true, deleted: true }) === false);
  assert('null/undefined input does not throw and is not visible',
    isDocVisible(null) === false && isDocVisible(undefined) === false);
});

/* ══════════════════════════════════════════════════════════════════
   3. ONE gate, not two — the exact drift progressKeyFor's own history warns about
   ══════════════════════════════════════════════════════════════════ */
group('The visibility gate is defined once and reused, not re-implemented', () => {
  const defCount = (PORTAL_FN.match(/function _isDocVisibleToHomeowner/g) || []).length;
  assert('_isDocVisibleToHomeowner is defined exactly once', defCount === 1, 'found ' + defCount);
  const useCount = (PORTAL_FN.match(/_isDocVisibleToHomeowner(?!\s*\()/g) || []).length
    + (PORTAL_FN.match(/\.filter\(_isDocVisibleToHomeowner\)/g) || []).length;
  assert('used by both the shelf-list build and getPortalDocumentHtml\'s re-check',
    /\.filter\(_isDocVisibleToHomeowner\)/.test(PORTAL_FN) && /if \(!_isDocVisibleToHomeowner\(meta\)\)/.test(PORTAL_FN));
});

/* ══════════════════════════════════════════════════════════════════
   4. _milestoneDateLabel (client) — short dates, defensive on bad input
   ══════════════════════════════════════════════════════════════════ */
const labelSrc = liftBetween(PORTAL, 'function _milestoneDateLabel(iso) {', '\n  }');
group('_milestoneDateLabel is present and liftable', () => {
  assert('found _milestoneDateLabel in docs/pro/js/portal.js', !!labelSrc);
});
if (labelSrc) {
  const ctx2 = { Date, String, isNaN };
  vm.createContext(ctx2);
  vm.runInContext(labelSrc + '\nthis.__l = _milestoneDateLabel;', ctx2);
  const label = ctx2.__l;

  group('_milestoneDateLabel: formats and defends', () => {
    assert('a same-year ISO date formats without a year',
      typeof label('2026-09-03T12:00:00.000Z') === 'string'
      && !/2026/.test(label('2026-09-03T12:00:00.000Z')),
      label('2026-09-03T12:00:00.000Z'));
    assert('non-string input returns null, not a thrown error', label(undefined) === null && label(123) === null);
    assert('an unparseable string returns null, never "Invalid Date"',
      label('not a date') === null, String(label('not a date')));
  });
}

/* ══════════════════════════════════════════════════════════════════
   5. The balance card never renders a dead "Pay Now" button
   ══════════════════════════════════════════════════════════════════ */
group('Balance card: no button at all without a real link', () => {
  const block = liftBetween(PORTAL, "if (view.balance) {", "\n    }\n");
  assert('found the balance-card render block', !!block);
  if (block) {
    assert('the Pay Now action is gated on view.balance.stripePaymentLink specifically',
      /view\.balance\.stripePaymentLink\s*\?/.test(block), block);
    assert('the false branch is a message, not a button — no <a> or <button> in the fallback text',
      /:\s*'<p /.test(block), block);
    assert('the true branch actually renders an anchor to the link, target=_blank',
      /<a class="btn"[\s\S]*?href="'\s*\+\s*esc\(safeUrl\(view\.balance\.stripePaymentLink\)\)[\s\S]*?target="_blank"/.test(block), block);
  }
});

group('Balance card: server never mints a payment link, only reads one', () => {
  const buildBlock = liftBetween(PORTAL_FN, '// Balance due / pay (2026-09-16)', 'const view = {');
  assert('found the server-side balance build', !!buildBlock);
  if (buildBlock) {
    assert('no Stripe API call anywhere in the balance build (read-only, per the approved plan)',
      !/stripe\.paymentLinks\.create|getStripe\(\)/.test(buildBlock), buildBlock);
    // 2026-10-03: the link comes from ky-insurance-law.js payUrlUnlessHeld
    // (stripePaymentLink OR stripeHostedUrl, '' under the Kentucky hold) and
    // is still only accepted when it is an https URL. Behaviour is tested in
    // tests/money-getting-paid-2026-10-03.test.js.
    assert('the pay link is only accepted when it is already an https URL',
      // 2026-10-06 (R2-2-6): the https test lives in invoice-charge.js
      // portalBalanceCard, which the card is built from.
      /InvoiceCharge\.portalBalanceCard\(_unpaidInvoice, _payUrl, _kyHold\)/.test(buildBlock)
      && /\/\^https:\\\/\\\/\/i\.test\(String\(payUrl/.test(fs.readFileSync(path.join(__dirname, '..', 'functions', 'invoice-charge.js'), 'utf8'))
      && /KyLaw\.payUrlUnlessHeld\(lead, _unpaidInvoice,/.test(buildBlock), buildBlock);
  }
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
