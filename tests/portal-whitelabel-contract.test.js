/**
 * tests/portal-whitelabel-contract.test.js — full tenant brand on homeowner
 * surfaces (2026-07-19 white-label batch).
 *
 * Contract: every homeowner-reachable surface resolves the tenant brand
 * (name + https-guarded logo + hex-guarded accent) with NBD kept
 * byte-identical via the established NBD-gate pattern. Server payloads carry
 * only tenant-SET values (never NBD defaults leaking onto a stranger's page).
 *
 * Zero deps. Run: node tests/portal-whitelabel-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('PORTAL WHITE-LABEL CONTRACT');

// ── server payloads ──
{
  const s = read('functions/portal.js');
  ok('portalView company payload carries logoUrl + colors',
    /logoUrl: tenantLogoUrl \|\| null/.test(s) && /colors: tenantColors/.test(s));
  ok('portalView guards logo to https and colors to hex',
    /\/\^https:\\\/\\\//i.test(s) && /HEX = \/\^#\[0-9a-f\]\{3,8\}\$\/i/.test(s));
  ok('getEstimateForView returns a company object',
    /res\.status\(200\)\.json\(\{ estimate: safeEstimate, company \}\)/.test(s));
  ok('getEstimateForView keys tenant off the LEAD companyId (team reps)',
    /leads\/\$\{tok\.leadId\}[\s\S]{0,200}companyId\)\s*\|\|\s*tok\.ownerUid/.test(s));
}
{
  const s = read('functions/remote-signing.js');
  ok('sign token stamps companyName at mint (resolved before set)',
    /companyName: tenantName \|\| ''/.test(s)
    && s.indexOf('let tenantName') < s.indexOf("doc_sign_tokens/${token}`).set"));
  ok('getSignDocument returns companyName',
    /companyName: tok\.companyName \|\| ''/.test(s));
}

// ── portal client ──
{
  const s = read('docs/pro/js/portal.js');
  ok('portal applies tenant title/logo/footer/accent (NBD-gated)',
    /if \(!isNbdCompany\) \{/.test(s) && /portalFooterBrand/.test(s)
    && /setProperty\('--nbd-orange'/.test(s));
  ok('portal refer link carries tenant name for non-NBD',
    /&co=' \+ encodeURIComponent\(companyName\)/.test(s));
  ok('portal has no pale-mint/teal literals on the light brand surface',
    !s.includes('#a7f3d0') && !s.includes('#5eead4') && !s.includes('#fca5a5'));
  ok('portal Cal.com embed is light-themed', /embed=true&theme=light/.test(s));
  ok('DM Mono (never loaded on portal) is gone', !s.includes('DM Mono'));
  ok('portal.html footer brand span exists',
    /id="portalFooterBrand"/.test(read('docs/pro/portal.html')));
}

// ── estimate view ──
{
  const s = read('docs/pro/js/estimate-view.js');
  ok('estimate renderer is brand-gated (NBD literal preserved, tenant name/logo otherwise)',
    /renderEstimate\(est, company\)/.test(s)
    && /if \(isNbd\) \{/.test(s)
    && /<div class="ev-brand"><span>NBD<\/span> · No Big Deal<\/div>/.test(s)
    && /escHtml\(coName\)/.test(s));
  ok('estimate view logo output is escaped', /escHtml\(company\.logoUrl\)/.test(s));
}

// ── deal room (the legal surface) ──
{
  const s = read('docs/pro/js/close-board.js');
  ok('deal room resolves brand via window._brand (photo-report gate pattern)',
    /function _dealBrand\(\)/.test(s) && /window\._brand/.test(s));
  ok('legal authorization sentence uses the tenant name',
    /you authorize \$\{BRAND\.nameEsc\} to proceed/.test(s));
  ok('deal-room title/logo/footer are brand-interpolated',
    /<title>Your Roof Estimate — \$\{BRAND\.nameEsc\}<\/title>/.test(s)
    && /\$\{BRAND\.logoHtml\}/.test(s)
    // Footer insurance line is brand-driven too (2026-10-07): NBD "Fully
    // Insured", another company "Insured" — never "Licensed".
    && /\$\{BRAND\.nameEsc\} · \$\{esc\(BRAND\.insuredTitle\)\}/.test(s));
  ok('deal-room accent token is brand-driven', /:root\{--orange:\$\{BRAND\.accent\};\}/.test(s));
  ok('off-brand #4A9EFF financing accent is gone', !s.includes('#4A9EFF'));
  ok('NBD deal room keeps its literal wordmark',
    /NO BIG DEAL <span>HOME SOLUTIONS<\/span>/.test(s));
}

// ── sign page ──
ok('sign.html loads Barlow and has a brand span',
  /fonts\.googleapis\.com\/css2\?family=Barlow/.test(read('docs/pro/sign.html'))
  && /id="spBrand"/.test(read('docs/pro/sign.html')));
ok('sign-page.js applies payload companyName to chrome',
  /r\.data\.companyName/.test(read('docs/pro/js/sign-page.js')));

// ── refer page ──
{
  const h = read('docs/pro/refer.html');
  ok('refer.html is on the light brand palette + loads its fonts',
    /--bg:#faf8f5/.test(h) && /--accent:#BD5728/.test(h)
    && /fonts\.googleapis\.com\/css2\?family=Barlow/.test(h));
  ok('refer.js brands from the co param via textContent only',
    /get\('co'\)/.test(read('docs/pro/js/refer.js'))
    && /_heroP\.textContent/.test(read('docs/pro/js/refer.js')));
}

// ── invoice success (static + fetch-free per #982) ──
{
  const h = read('docs/pro/invoice-success.html');
  ok('invoice-success is on the light brand palette', /--bg:#faf8f5/.test(h));
  ok('invoice-success stays fetch-free (no fetch/XHR)',
    !/fetch\(|XMLHttpRequest/.test(h));
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
