/* tests/tier-pricing-premium-claim-2026-09-16.test.js
 *
 * The public marketing site claimed Preferred is "+15% over Standard" and
 * Elite is "+30% over Standard" (docs/services/the-nbd-guarantee/index.html
 * ×6, docs/services/the-nbd-build/index.html ×1) — live since 2026-04-21,
 * flagged the same day by documentation/audit/GBB-TIER-SOURCE-OF-TRUTH-
 * 2026-09-09.md, and left deliberately open by that session ("PR 4 ...
 * deliberately still open"). Jo had already asked, days earlier, that
 * "when we give warranties, receipts, they need to match their estimates
 * / docs / etc... make sure it all ties properly."
 *
 * The real numbers, computed from the actual pricing engine
 * (docs/pro/js/estimate-config.js TIER_RATES, good/better/best =
 * 545/595/660 $/SQ, unchanged since the 2026-04-10 locked spec):
 *   better/good - 1 = 595/545 - 1 = 9.174% -> "roughly 9%"
 *   best/good   - 1 = 660/545 - 1 = 21.101% -> "roughly 21%"
 *
 * This suite does NOT hardcode "9%"/"21%" as the thing to protect —  it
 * computes the expected percentage from TIER_RATES directly and asserts
 * the marketing copy matches THAT, rounded the same way a human writing
 * "roughly N%" copy would round it. If TIER_RATES ever changes, this
 * suite reddens and forces a deliberate copy update instead of silently
 * drifting the way the original 15%/30% claim did for five months.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── pull the real TIER_RATES out of the pricing engine ── */
const CONFIG_SRC = read('docs/pro/js/estimate-config.js');
const ratesBlock = CONFIG_SRC.slice(
  CONFIG_SRC.indexOf('TIER_RATES: Object.freeze({'),
  CONFIG_SRC.indexOf('}),', CONFIG_SRC.indexOf('TIER_RATES: Object.freeze({'))
);
group('TIER_RATES is present and liftable', () => {
  assert('found TIER_RATES in docs/pro/js/estimate-config.js', ratesBlock.length > 0,
    'if this moved, update the extractor — do NOT delete the suite');
});
const good = Number((ratesBlock.match(/good:\s*(\d+)/) || [])[1]);
const better = Number((ratesBlock.match(/better:\s*(\d+)/) || [])[1]);
const best = Number((ratesBlock.match(/best:\s*(\d+)/) || [])[1]);
group('The three tier rates parsed as real numbers', () => {
  assert('good is a positive number', good > 0, String(good));
  assert('better is a positive number', better > 0, String(better));
  assert('best is a positive number', best > 0, String(best));
});
if (!(good > 0 && better > 0 && best > 0)) {
  console.log('\ncannot continue'); console.log(passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1);
}

// Same rounding a human writing "roughly N%" marketing copy would do —
// round to the nearest whole percent, not truncate.
const preferredPct = Math.round((better / good - 1) * 100);
const elitePct = Math.round((best / good - 1) * 100);

group('The computed premiums are what this suite expects to find in copy (sanity, not the assertion itself)', () => {
  assert('Preferred premium computes to 9% at current rates', preferredPct === 9,
    'got ' + preferredPct + '% from ' + better + '/' + good);
  assert('Elite premium computes to 21% at current rates', elitePct === 21,
    'got ' + elitePct + '% from ' + best + '/' + good);
});

/* ── check every marketing-copy location against the COMPUTED value ── */
const GUARANTEE = read('docs/services/the-nbd-guarantee/index.html');
const BUILD = read('docs/services/the-nbd-build/index.html');

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

group('docs/services/the-nbd-guarantee/index.html matches the real pricing engine', () => {
  assert('no stale "+15%" claim anywhere', !/\+15%/.test(GUARANTEE), 'a stale claim survived the fix');
  assert('no stale "+30%" claim anywhere', !/\+30%/.test(GUARANTEE), 'a stale claim survived the fix');
  assert('no stale "roughly 15%" claim anywhere', !/roughly 15%/.test(GUARANTEE));
  assert('no stale "roughly 30%" claim anywhere', !/roughly 30%/.test(GUARANTEE));
  assert(`the correct "+${preferredPct}%" (Preferred) appears at least twice (tier card + comparison table)`,
    countOccurrences(GUARANTEE, `+${preferredPct}%`) >= 2,
    'found ' + countOccurrences(GUARANTEE, `+${preferredPct}%`));
  assert(`the correct "+${elitePct}%" (Elite) appears at least twice (tier card + comparison table)`,
    countOccurrences(GUARANTEE, `+${elitePct}%`) >= 2,
    'found ' + countOccurrences(GUARANTEE, `+${elitePct}%`));
  assert(`the correct "roughly ${preferredPct}%" appears in the FAQ copy (both the JSON-LD and the visible FAQ answer)`,
    countOccurrences(GUARANTEE, `roughly ${preferredPct}%`) >= 2,
    'found ' + countOccurrences(GUARANTEE, `roughly ${preferredPct}%`));
  assert(`the correct "roughly ${elitePct}%" appears in the FAQ copy (both the JSON-LD and the visible FAQ answer)`,
    countOccurrences(GUARANTEE, `roughly ${elitePct}%`) >= 2,
    'found ' + countOccurrences(GUARANTEE, `roughly ${elitePct}%`));
});

group('docs/services/the-nbd-build/index.html matches the real pricing engine', () => {
  assert('no stale "+15%" claim', !/\+15%/.test(BUILD));
  assert(`the correct "+${preferredPct}%" appears`, BUILD.includes(`+${preferredPct}%`));
});

/* 2026-09-27 price-validation lane: two more copies of the old 15%/30%
 * premiums had survived — the llms.txt "Promise" prose (what AI answer
 * engines quote) and the LumaNail FAQ, whose visible answer and FAQPage
 * JSON-LD answer must stay identical. Elite-over-Preferred is computed the
 * same way: best/better - 1 = 660/595 - 1 = 10.9% -> "~11%". */
const elitePreferredPct = Math.round((best / better - 1) * 100);
const LLMS = read('docs/llms.txt');
const LUMA = read('docs/services/lumanail/index.html');

group('docs/llms.txt matches the real pricing engine', () => {
  assert('no stale "≈+15%" / "≈+30%" tier premium', !/≈\s*\+\s*(15|30)%/.test(LLMS));
  assert(`Preferred is "≈+${preferredPct}%" and Elite "≈+${elitePct}%"`,
    LLMS.includes(`≈+${preferredPct}%`) && LLMS.includes(`≈+${elitePct}%`));
});

group('docs/services/lumanail/index.html FAQ matches the real pricing engine', () => {
  const answer = `Roughly ${elitePct}% more than Standard, ~${elitePreferredPct}% more than Preferred.`;
  assert('no stale "30% more than Standard" / "~13% more than Preferred"',
    !/30% more than Standard/.test(LUMA) && !/13% more than Preferred/.test(LUMA));
  assert(`the answer "${answer}" appears in BOTH the visible FAQ and the FAQPage JSON-LD`,
    countOccurrences(LUMA, answer) === 2, 'found ' + countOccurrences(LUMA, answer));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
