/**
 * tests/tenant-legal.test.js — per-tenant LEGAL-text resolver window._legal().
 *
 * The companyProfile top-level legal/jurisdiction DEFAULTS are deep-merged for
 * EVERY tenant and hardcode Kentucky ("Kentucky Revised Statutes § 367.390",
 * "under Kentucky law", "Kentucky Building Code") plus the literal "NBD" as the
 * contracting party (changeOrder / insuranceAssignment / warranty / liability
 * clauses). _resolveBrand() only blanks brand.*, never these top-level fields,
 * so a stranger (non-NBD) tenant's generated contract/proposal used to cite KY
 * law and name NBD. window._legal() (gauntlet Batch 3) neutralizes the
 * jurisdiction strings and substitutes the tenant legalName for "NBD" — but
 * ONLY for a non-NBD tenant that did NOT override the field (an override wins),
 * and leaves NBD byte-identical.
 *
 * Zero deps. Evals the browser IIFE in a vm sandbox (same pattern as
 * cust-id-prefix.test.js). Run: node tests/tenant-legal.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

function loadCompanyProfile() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', 'company-profile.js'), 'utf8');
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = { addEventListener() {}, removeEventListener() {}, localStorage };
  win.window = win;
  const sandbox = { window: win, localStorage, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
  vm.runInNewContext(src, sandbox, { filename: 'company-profile.js' });
  return win;
}

(async () => {
  const D = loadCompanyProfile().NBD_COMPANY_PROFILE_DEFAULTS;

  console.log('_legal — helper exists');
  const w0 = loadCompanyProfile();
  ok('_legal is a function', typeof w0._legal === 'function');

  console.log('\nNBD (default) — legal text must be BYTE-IDENTICAL (KY + "NBD" intact)');
  const nbd = w0._legal();
  ok('NBD cancellationStatute unchanged (KY)', nbd.cancellationStatute === D.cancellationStatute && /Kentucky Revised Statutes/.test(nbd.cancellationStatute));
  ok('NBD disputeResolutionClause unchanged (Kentucky law)', nbd.disputeResolutionClause === D.disputeResolutionClause && /Kentucky law/.test(nbd.disputeResolutionClause));
  ok('NBD codeJurisdiction unchanged (KBC)', nbd.codeJurisdiction === D.codeJurisdiction);
  ok('NBD changeOrderClause keeps literal "NBD"', nbd.changeOrderClause === D.changeOrderClause && /\bNBD\b/.test(nbd.changeOrderClause));
  ok('NBD limitationOfLiability keeps literal "NBD"', nbd.limitationOfLiability === D.limitationOfLiability && /\bNBD\b/.test(nbd.limitationOfLiability));

  console.log('\nStranger tenant (legalName "Acme Roofing LLC", no legal overrides) — neutralized + party-substituted');
  const w1 = loadCompanyProfile();
  await w1._saveCompanyProfile({ brand: { legalName: 'Acme Roofing LLC' } });
  const L = w1._legal();
  const bundle = [L.cancellationStatute, L.cancellationContractClause, L.cancellationProposalShort,
    L.disputeResolutionClause, L.codeJurisdiction, L.serviceArea, L.changeOrderClause,
    L.materialsWarrantyDisclaimer, L.limitationOfLiability].join('  ');
  ok('no "Kentucky" anywhere in resolved legal text', !/Kentucky/i.test(bundle));
  ok('no "§ 367.390" statute citation', !/367\.390/.test(bundle));
  ok('no stray literal "NBD" as the contracting party', !/\bNBD\b/.test(bundle));
  ok('cancellationStatute blanked', L.cancellationStatute === '');
  ok('cancellation clause STILL grants the 3-day right (not empty)', /three \(3\) business days/.test(L.cancellationContractClause) && /applicable state law/i.test(L.cancellationContractClause));
  ok('cancellationProposalShort keeps the 3-day right, state-neutral', /3 days/.test(L.cancellationProposalShort) && !/KY|Kentucky/i.test(L.cancellationProposalShort));
  ok('disputeResolutionClause → state-neutral governing law', /state in which the work is performed/i.test(L.disputeResolutionClause));
  ok('codeJurisdiction → neutral', /applicable state and local building codes/i.test(L.codeJurisdiction));
  ok('changeOrderClause names the tenant, not NBD', /Acme Roofing LLC reserves the right/.test(L.changeOrderClause));
  // The Insurance Assignment clause was retired 2026-09-27 (every contract
  // prints ky-insurance-law.js's plain PAYMENT_CLAUSE instead).
  ok('insuranceAssignmentClause no longer ships as a default', L.insuranceAssignmentClause === undefined);
  ok('limitationOfLiability names the tenant', /Acme Roofing LLC.?s total liability/.test(L.limitationOfLiability));
  ok('materialsWarrantyDisclaimer names the tenant', /Acme Roofing LLC workmanship warranty/.test(L.materialsWarrantyDisclaimer));

  console.log('\nStranger override WINS over the neutral fallback');
  const w2 = loadCompanyProfile();
  await w2._saveCompanyProfile({
    brand: { legalName: 'Acme Roofing LLC' },
    disputeResolutionClause: 'Any dispute shall be resolved under the laws of the State of Texas.',
    cancellationStatute: 'Tex. Bus. & Com. Code § 601.201'
  });
  const O = w2._legal();
  ok('overridden disputeResolutionClause is kept verbatim', O.disputeResolutionClause === 'Any dispute shall be resolved under the laws of the State of Texas.');
  ok('overridden cancellationStatute is kept verbatim', O.cancellationStatute === 'Tex. Bus. & Com. Code § 601.201');
  ok('un-overridden codeJurisdiction still neutralized', /applicable state and local building codes/i.test(O.codeJurisdiction));

  console.log('\nNeutral clauses remain legally operative (non-empty)');
  ok('neutral cancellationContractClause is non-empty', (L.cancellationContractClause || '').length > 40);
  ok('neutral disputeResolutionClause is non-empty', (L.disputeResolutionClause || '').length > 40);

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All tenant-legal tests passed');
})().catch(e => { console.error('test crashed:', e && (e.stack || e.message)); process.exit(1); });
