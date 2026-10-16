/**
 * Ohio ORC 4722 threshold: "over $25,000", never "$25,000 or more"
 * (legal cross-check, 2026-10-16).
 *
 * Primary source (codes.ohio.gov, read 2026-10-16):
 *   4722.01(C) "Home construction service contract" means a contract between
 *   an owner and a supplier to perform home construction services ... "for an
 *   amount exceeding twenty-five thousand dollars."
 *   4722.04 caps the down payment at "not more than ten per cent of the
 *   contract price" before performance begins (in force since 2012-08-31,
 *   HB 383 — not a 2026 rule).
 *
 * This suite fails if:
 *   - a $25,000.00 Ohio contract is capped again (the old ">= $25,000" rule);
 *   - a $25,000.01 Ohio contract is NOT capped;
 *   - any CRM surface that states the rule says "$25,000 or more" /
 *     "at or above $25,000" for Ohio again.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const OH = '4410 Socialville Foster Rd, Mason, OH 45040';
for (const copy of ['docs/pro/js/deposit-rule.js', 'functions/deposit-rule.js']) {
  console.log('\n' + copy);
  delete require.cache[require.resolve(path.join(ROOT, copy))];
  const R = require(path.join(ROOT, copy));
  const at = R.compute({ total: 25000.00, address: OH });
  ok('$25,000.00 Ohio cash is not a 4722 contract: 50% ($12,500) at signing, no Ohio block', at.depositCents === 1250000 && !at.ohio, at.depositCents);
  const over = R.compute({ total: 25000.01, address: OH });
  ok('$25,000.01 Ohio cash is capped: $2,500 at signing', over.depositCents === 250000 && over.ohio && over.ohio.applies === true, over.depositCents);
  const ins = R.compute({ mode: 'insurance', total: 25000, deductible: 5000, address: OH });
  ok('$25,000.00 Ohio insurance: the deductible is not cut to 10%', ins.depositCents === 500000, ins.depositCents);
  const ky = R.compute({ total: 25000.01, address: '1 Main St, Covington, KY 41011' });
  ok('Kentucky cash $25,000.01: no Ohio cap', !ky.ohio, JSON.stringify(ky.ohio));
  const pol = R.policyText();
  ok('policyText: "Ohio jobs over $25,000"', /Ohio jobs over \$25,000:/.test(pol), pol);
}

console.log('\nNo surface states the Ohio rule as "$25,000 or more" / "at or above $25,000"');
const SURFACES = [
  'docs/pro/js/deposit-rule.js', 'functions/deposit-rule.js', 'docs/pro/js/estimate-config.js',
  'docs/pro/js/ask-joe-rules.js', 'docs/pro/js/company-profile.js', 'docs/pro/js/estimate-v2-ui.js',
  'docs/pro/js/doc-preflight.js', 'docs/pro/index.html', 'site-src/guides/kentucky-ohio-storm-claim-guide.md',
  'docs/guides/kentucky-ohio-storm-claim-guide.html', 'functions/agent-mcp-logic.js'
];
const BAD = /(\$25,000(\.00)?|\$25k)\s*(or more|and up|\+|or above)|(at or above|equals or exceeds|or more than)\s*\$25,000/i;
for (const f of SURFACES) {
  const src = read(f);
  const lines = src.split(/\r?\n/).filter((l) => BAD.test(l) && !/4722\.02\(A\)/.test(l));
  ok(f + ': no "or more" Ohio threshold', lines.length === 0, lines[0] && lines[0].trim().slice(0, 160));
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' -- ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
