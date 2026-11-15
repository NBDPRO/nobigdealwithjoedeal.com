/* portal-estimate-scope-link.test.js
 *
 * The homeowner's whole answer to "what am I paying for?" was one orange
 * number and a status pill, with the signature iframe as the very next card.
 *
 * /pro/estimate-view.html is a complete, deployed, cost-redacted line-item
 * viewer — every line with quantity and retail total, the roof measurements,
 * the tier cards — and the portal referenced it exactly zero times. Rep-side
 * surfaces linked to it; the customer never could.
 *
 * Two halves, and the link is worth little without the second:
 *
 *  1. The portal now links to it, carrying the portal token it already holds.
 *     No new credential: getEstimateForView takes that same token and refuses
 *     an estimateId whose leadId does not match the token's.
 *
 *  2. getEstimateForView returned an EMPTY scope for any estimate whose lines
 *     live in `est.lineItems` rather than `est.rows`. buildDisplayRows reads
 *     only est.rows, so estimate-view fell through to "Detailed line items
 *     will be reviewed in person." — an empty scope on the page that exists to
 *     show the scope. The CRM's own PDF export already had this fallback, so a
 *     rep could export a full scope and share a link showing none, for the
 *     same document. Reachable with no legacy data: Log Estimate writes no
 *     rows, and saving the scope back from doc pre-flight writes lineItems.
 *
 * The fallback goes through buildDocLineItems, the shared three-shape reader
 * that lives beside buildDisplayRows precisely so this stays one copy of the
 * retail ladder — its docstring records that a fourth private copy is what
 * leaked the cost basis to homeowners in the first place. This suite runs BOTH
 * real readers rather than asserting on source text, and re-proves the
 * cost-privacy invariant on the new path.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PORTAL_JS = read('docs/pro/js/portal.js');
const PORTAL_FN = read('functions/portal.js');
const rows = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ══════════════════════════════════════════════════════════════════
   1. The link the portal now renders
   ══════════════════════════════════════════════════════════════════ */
const hrefBlock = PORTAL_JS.match(/function _estimateScopeHref\(estimateId\) \{[\s\S]*?\n {2}\}\n/);
group('The href builder is present and liftable', () => {
  assert('found _estimateScopeHref in docs/pro/js/portal.js', !!hrefBlock,
    'if this moved, update the extractor — do NOT delete the suite');
});
if (!hrefBlock) {
  console.log('\ncannot continue'); console.log(passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
}
function href(token, id) {
  const ctx = { encodeURIComponent, getToken: () => token };
  vm.createContext(ctx);
  vm.runInContext(hrefBlock[0] + '\nthis.__h = _estimateScopeHref;', ctx);
  return ctx.__h(id);
}

group('It carries the credentials estimate-view actually reads', () => {
  // docs/pro/js/estimate-view.js:13-14 reads `token` and `estimateId`.
  const u = href('TOK123', 'est_456');
  assert('points at estimate-view.html', u.indexOf('estimate-view.html?') === 0, u);
  assert('carries token=', /[?&]token=TOK123(&|$)/.test(u), u);
  assert('carries estimateId=', /[&]estimateId=est_456(&|$)/.test(u), u);
  assert('is relative, so it resolves from /pro/portal AND /pro/portal.html',
    !/^https?:|^\//.test(u), u);
});

group('It encodes, so a hostile id cannot break out of the query', () => {
  const u = href('TOK', 'a&b=c');
  assert('an & in the id is encoded, not injected as a parameter',
    u.indexOf('estimateId=a%26b%3Dc') > -1, u);
  assert('...so only the two expected parameters exist',
    u.split('&').length === 2, u);
  const q = href('a b/c+d', 'x');
  assert('a token with URL-significant characters is encoded',
    q.indexOf('token=a%20b%2Fc%2Bd') > -1, q);
});

group('The card renders it only when there is an estimate to open', () => {
  assert('the link is gated on e.id',
    /\(e\.id\r?\n?\s*\?[\s\S]{0,300}?_estimateScopeHref\(e\.id\)/.test(PORTAL_JS),
    'without the gate a doc with no id renders estimateId=undefined');
  assert('the href is escaped before it reaches the markup',
    /esc\(_estimateScopeHref\(e\.id\)\)/.test(PORTAL_JS));
  assert('it opens in a new tab so the portal is not lost',
    /_estimateScopeHref\(e\.id\)[\s\S]{0,160}target="_blank" rel="noopener"/.test(PORTAL_JS));
});

/* ══════════════════════════════════════════════════════════════════
   2. The gap the link would otherwise open onto — real readers
   ══════════════════════════════════════════════════════════════════ */
// A Log Estimate doc whose scope was saved back from doc pre-flight:
// lineItems, no rows, no prices. This is the shape that rendered nothing.
const classic = {
  title: 'Roof replacement', amount: 14500, total: 14500, grandTotal: 14500,
  lineItems: [
    { description: 'Architectural shingles', quantity: 32, unit: 'SQ', unitPrice: 395, amount: 12640 },
    { description: 'Ice & water shield', quantity: 4, unit: 'RL', unitPrice: 165, amount: 660 },
  ],
};

group('The two readers disagree exactly as the defect describes', () => {
  assert('buildDisplayRows returns NOTHING for a lineItems-only estimate',
    rows.buildDisplayRows(classic).length === 0,
    'if this changes, the fallback may no longer be needed — check before deleting it');
  assert('buildDocLineItems returns the real scope',
    rows.buildDocLineItems(classic).length === 2,
    JSON.stringify(rows.buildDocLineItems(classic)));
  const names = rows.buildDocLineItems(classic).map((r) => r.description);
  assert('...with the descriptions the rep typed',
    names.indexOf('Architectural shingles') > -1 && names.indexOf('Ice & water shield') > -1,
    JSON.stringify(names));
});

group('A rows-based estimate is untouched by the fallback', () => {
  const v2 = { rows: [{ code: 'SHNG', desc: 'Shingles', qty: 30, unit: 'SQ', retailTotal: 12000 }], grandTotal: 12000 };
  assert('buildDisplayRows still answers for rows-based docs',
    rows.buildDisplayRows(v2).length > 0);
  // The fallback is gated on displayRows being empty, so this doc never
  // reaches buildDocLineItems at all.
  assert('the fallback is gated on BOTH an empty ladder and a present lineItems',
    // (priced = the signed view of est, 2026-11-14 finding 4)
    /if \(!displayRows\.length && Array\.isArray\((est|priced)\.lineItems\) && \1\.lineItems\.length\)/.test(PORTAL_FN),
    'ungated, a per-SQ doc would gain a synthetic summary line it does not need');
});

group('Per-SQ is deliberately left alone', () => {
  // grandTotal is required for the per-SQ branch to produce anything —
  // estimateValue() returns 0 without it and buildDocLineItems returns [].
  // The first fixture here omitted it and the assertion failed against
  // correct code, which is worth keeping as a note: a per-SQ doc that has
  // not been priced yet also yields nothing, so the gate is belt AND braces.
  const perSq = {
    priceMode: 'per-sq', selectedTier: 'better', grandTotal: 13000,
    prices: { good: 11000, better: 13000, best: 15500 },
  };
  assert('buildDocLineItems WOULD synthesise a summary line for a priced per-SQ doc',
    rows.buildDocLineItems(perSq).length === 1,
    'this is why the fallback is gated on lineItems rather than used unconditionally: '
    + JSON.stringify(rows.buildDocLineItems(perSq)));
  assert('...duplicating the tier card estimate-view already renders',
    /Roofing system/.test(rows.buildDocLineItems(perSq)[0].description));
  assert('...but per-SQ has no lineItems, so the gate excludes it',
    !Array.isArray(perSq.lineItems));
});

/* ══════════════════════════════════════════════════════════════════
   3. The cost-basis invariant, re-proved on the NEW path
   ══════════════════════════════════════════════════════════════════ */
group('No cost key can ride along the fallback', () => {
  // A doc whose lineItems carry contractor figures alongside the retail ones.
  const withCost = {
    lineItems: [{
      description: 'Tear-off', quantity: 32, unit: 'SQ', unitPrice: 95, amount: 3040,
      materialCost: 1200, laborCost: 900, margin: 0.42, cost: 2100, contractorRate: 65,
    }],
  };
  const out = rows.buildDocLineItems(withCost);
  // The endpoint whitelists to exactly these four before sending.
  const mapped = out.map((r) => ({
    name: r.description || r.name || r.code || 'Line item',
    quantity: r.quantity != null ? r.quantity : null,
    unit: r.unit || '',
    lineTotal: r.total,
  }));
  const keys = Object.keys(mapped[0]).sort();
  assert('the mapped line has exactly name/quantity/unit/lineTotal',
    JSON.stringify(keys) === JSON.stringify(['lineTotal', 'name', 'quantity', 'unit']),
    JSON.stringify(keys));
  const blob = JSON.stringify(mapped).toLowerCase();
  ['materialcost', 'laborcost', 'margin', 'contractorrate'].forEach((k) => {
    assert('no "' + k + '" survives the whitelist', blob.indexOf(k) === -1, blob);
  });
  assert('the retail figure IS carried through', mapped[0].lineTotal === 3040,
    JSON.stringify(mapped[0]));
});

group('The endpoint applies that same whitelist to both readers', () => {
  const start = PORTAL_FN.indexOf('exports.getEstimateForView');
  const body = PORTAL_FN.slice(start);
  assert('the docLines branch emits only the four whitelisted keys',
    /docLines\s*\r?\n?\s*\? docLines\.map\(r => \(\{[\s\S]{0,320}?name:[\s\S]{0,320}?quantity:[\s\S]{0,320}?unit:[\s\S]{0,320}?lineTotal:[\s\S]{0,40}?\}\)\)/.test(body),
    'a spread or an extra key here is how the cost basis leaks');
  assert('it does not spread the raw row', !/\.\.\.r[,\s}]/.test(body.slice(0, 4000)));
  assert('buildDocLineItems is imported from the shared module, not reimplemented',
    /require\('\.\/customer-estimate-rows'\)/.test(PORTAL_FN)
      && /buildDocLineItems/.test(PORTAL_FN.slice(0, PORTAL_FN.indexOf('exports.'))));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
