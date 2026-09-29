/**
 * tests/cust-id-prefix.test.js — per-tenant customer-ID minting helpers.
 *
 * Verifies window._custIdPrefix() / window._custCounterId() in company-profile.js:
 *   - NBD (brand.legalName blank or the canonical NBD name) → legacy
 *     'customerIds' counter + 'NBD' prefix (byte-identical, sequence never reset).
 *   - A configured tenant (non-NBD legalName + its own docPrefix, e.g. Oaks 'OAK')
 *     → per-tenant counter 'customerIds_<companyId>' + its own prefix.
 *   - A NON-NBD tenant with NO reserved docPrefix (skipped the seal step) →
 *     its OWN per-tenant counter + a prefix DERIVED from its legalName, and
 *     NEVER the shared NBD counter or an un-salted 'NBD-####' (gauntlet Batch 3).
 *     The gate is "is this the NBD platform tenant?" (isNbdBrand), not the old
 *     "does the resolved prefix string equal 'NBD'?".
 *
 * Zero deps. Evals the browser IIFE in a vm sandbox (same pattern as
 * tenant-brand.test.js). Run: node tests/cust-id-prefix.test.js
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
  const win = loadCompanyProfile();
  console.log('CUST-ID PREFIX — helpers exist');
  ok('_custIdPrefix is a function', typeof win._custIdPrefix === 'function');
  ok('_custCounterId is a function', typeof win._custCounterId === 'function');

  console.log('\nNBD (default) — must be byte-identical to legacy');
  ok('NBD prefix = NBD', win._custIdPrefix() === 'NBD');
  ok('NBD counter = legacy "customerIds"', win._custCounterId('1phDvAVXHSg82wDLegAbQFq14Ci1') === 'customerIds');
  ok('NBD counter ignores companyId arg', win._custCounterId('anything-here') === 'customerIds');

  console.log('\nConfigured tenant (Oaks: legalName + docPrefix OAK)');
  await win._saveCompanyProfile({ brand: { legalName: 'Oaks Roofing & Construction', docPrefix: 'OAK' } });
  ok('Oaks prefix = OAK', win._custIdPrefix() === 'OAK');
  ok('Oaks counter = customerIds_oaks', win._custCounterId('oaks') === 'customerIds_oaks');
  ok('Oaks counter lowercases the companyId', win._custCounterId('OAKS') === 'customerIds_oaks');

  console.log('\nPrefix-less non-NBD tenant (skipped the seal step) → OWN counter + DERIVED prefix, NEVER NBD');
  await win._saveCompanyProfile({ brand: { legalName: 'Some Other Roofing Co' } });
  ok('prefix-less non-NBD → prefix is DERIVED, never "NBD"', win._custIdPrefix() !== 'NBD');
  ok('prefix-less non-NBD → derived initials "SORC"', win._custIdPrefix() === 'SORC');
  ok('prefix-less non-NBD → NEVER the shared "customerIds" counter', win._custCounterId('someco') !== 'customerIds');
  ok('prefix-less non-NBD → per-tenant "customerIds_someco"', win._custCounterId('someco') === 'customerIds_someco');

  console.log('\nUnderivable legalName (no A–Z0–9) → "CUS" fallback (never "NBD", never blank), own counter');
  await win._saveCompanyProfile({ brand: { legalName: '★★★' } });
  ok('underivable non-NBD name → prefix "CUS"', win._custIdPrefix() === 'CUS');
  ok('underivable non-NBD → own counter, not shared', win._custCounterId('sym') === 'customerIds_sym');

  console.log('\nCoupled-collision guard — two prefix-less non-NBD tenants never mint the same customerId string');
  await win._saveCompanyProfile({ brand: { legalName: 'Some Other Roofing Co' } });
  const _pfxA = win._custIdPrefix();
  const idA = win._formatCustomerId(_pfxA, 1, 'someco');
  const idB = win._formatCustomerId(_pfxA, 1, 'otherco');
  ok('prefix-less A vs B mint DISTINCT IDs (salt binds companyId)', idA !== idB);
  ok('prefix-less non-NBD ID is salted (SORC-0001-XXXX, not bare)', /^SORC-0001-[0-9A-Z]{4}$/.test(idA));

  // ── Customer-ID salt (defense-in-depth against prefix collision) ──
  console.log('\nCustomer-ID salt + formatter (client)');
  ok('_custIdSalt is a function', typeof win._custIdSalt === 'function');
  ok('_formatCustomerId is a function', typeof win._formatCustomerId === 'function');
  ok('salt is 4 upper-alnum chars', /^[0-9A-Z]{4}$/.test(win._custIdSalt('oaks')));
  ok('salt is deterministic', win._custIdSalt('oaks') === win._custIdSalt('oaks'));
  ok('salt differs per companyId', win._custIdSalt('oaks') !== win._custIdSalt('acme'));

  console.log('\n_formatCustomerId — NBD stays byte-identical (legacy), non-NBD is salted');
  ok('NBD → un-salted NBD-0001', win._formatCustomerId('NBD', 1, 'anything') === 'NBD-0001');
  ok('NBD → un-salted NBD-0042', win._formatCustomerId('NBD', 42, 'anything') === 'NBD-0042');
  ok('OAK → salted OAK-0001-<salt>', win._formatCustomerId('OAK', 1, 'oaks') === 'OAK-0001-' + win._custIdSalt('oaks'));
  ok('salt binds to companyId (same seq+prefix, different company → different ID)',
    win._formatCustomerId('OAK', 1, 'oaks') !== win._formatCustomerId('OAK', 1, 'acme'));

  // ── Client ⇄ server parity — the two mint paths MUST agree byte-for-byte ──
  console.log('\nClient ⇄ server salt parity (functions/customer-id.js)');
  const srv = require('../functions/customer-id');
  ok('salt parity: oaks', win._custIdSalt('oaks') === srv.custIdSalt('oaks'));
  ok('salt parity: a long uid', win._custIdSalt('1phDvAVXHSg82wDLegAbQFq14Ci1') === srv.custIdSalt('1phDvAVXHSg82wDLegAbQFq14Ci1'));
  ok('salt parity: empty', win._custIdSalt('') === srv.custIdSalt(''));
  ok('format parity: NBD-0001', win._formatCustomerId('NBD', 1, 'x') === srv.formatCustomerId('NBD', 1, 'x'));
  ok('format parity: OAK-0007', win._formatCustomerId('OAK', 7, 'oaks') === srv.formatCustomerId('OAK', 7, 'oaks'));

  // ── Client ⇄ server mint-ROUTING parity (which prefix + counter) ──
  console.log('\nClient ⇄ server mint-routing parity (resolveCustMint / gauntlet Batch 3)');
  ok('server exports resolveCustMint', typeof srv.resolveCustMint === 'function');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok('server NBD brand → {NBD, customerIds}', eq(srv.resolveCustMint({ legalName: 'No Big Deal Home Solutions' }, 'x'), { prefix: 'NBD', counterId: 'customerIds' }));
  ok('server absent brand → NBD (byte-identical)', eq(srv.resolveCustMint(null, 'x'), { prefix: 'NBD', counterId: 'customerIds' }));
  ok('server Oaks (reserved OAK) → {OAK, customerIds_oaks}', eq(srv.resolveCustMint({ legalName: 'Oaks Roofing & Construction', docPrefix: 'OAK' }, 'oaks'), { prefix: 'OAK', counterId: 'customerIds_oaks' }));
  const _srvPfxless = srv.resolveCustMint({ legalName: 'Some Other Roofing Co' }, 'someco');
  ok('server prefix-less non-NBD → derived SORC + own counter', _srvPfxless.prefix === 'SORC' && _srvPfxless.counterId === 'customerIds_someco');
  ok('server prefix-less non-NBD NEVER shares NBD counter', _srvPfxless.counterId !== 'customerIds');
  // Client resolves the SAME prefix for a prefix-less non-NBD tenant (parity with server).
  await win._saveCompanyProfile({ brand: { legalName: 'Some Other Roofing Co' } });
  ok('client ⇄ server prefix-less prefix parity (SORC)', win._custIdPrefix() === _srvPfxless.prefix);
  ok('client ⇄ server prefix-less counter parity', win._custCounterId('someco') === _srvPfxless.counterId);

  // ── Docgen ⇄ customer-ID prefix parity — document-generator.js _docPrefix()
  // carries an inline copy of the _deriveCustPrefix derivation (it cannot call
  // the closure-private helper). This pin keeps the two copies from drifting:
  // for the same unreserved non-NBD brand, doc numbers and customer IDs MUST
  // resolve the same prefix (same contract as the _custIdSalt parity above). ──
  console.log('\nDocgen ⇄ customer-ID prefix parity (document-generator.js _docPrefix)');
  const dgSrc = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', 'document-generator.js'), 'utf8');
  function loadDocGenWith(brand) {
    const w2 = { _brand: () => brand };
    w2.window = w2;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
    const sb2 = {
      window: w2,
      document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout, Date, Math, JSON,
    };
    vm.runInNewContext(dgSrc, sb2, { filename: 'document-generator.js' });
    return w2.NBDDocGen;
  }
  await win._saveCompanyProfile({ brand: { legalName: 'Some Other Roofing Co' } });
  const dgDerived = loadDocGenWith(win._brand());
  ok('_docPrefix parity: prefix-less non-NBD (SORC)', dgDerived._docPrefix() === win._custIdPrefix());
  await win._saveCompanyProfile({ brand: { legalName: '★★★' } });
  const dgUnderivable = loadDocGenWith(win._brand());
  ok('_docPrefix parity: underivable legalName (CUS)', dgUnderivable._docPrefix() === win._custIdPrefix());
  await win._saveCompanyProfile({ brand: { legalName: 'Oaks Roofing & Construction', docPrefix: 'OAK' } });
  const dgReserved = loadDocGenWith(win._brand());
  ok('_docPrefix parity: reserved prefix wins (OAK)', dgReserved._docPrefix() === win._custIdPrefix());

  // ── Mint-site hydration gates (NBD-leak audit 2026-07-29) ──
  // The customer-ID mints in both bootstraps used to carry typeof fallbacks
  // (`: 'NBD'` / `: 'customerIds'`) that fired whenever the mint raced
  // company-profile hydration — deterministically on the customer-page
  // dashboard-handoff path — stamping a NON-NBD tenant's lead with an
  // un-salted NBD-#### ID from the shared platform counter. The fix gates
  // every mint on _companyProfileLoaded and SKIPS (never guesses) when the
  // profile or any helper is unavailable. These pins keep both properties.
  console.log('\nMint-site hydration gates (customer/dashboard bootstraps)');
  for (const rel of ['customer-bootstrap.module.js', 'dashboard-bootstrap.module.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', rel), 'utf8');
    // Mint sites route through _custIdMint( since 2026-09-29 (platform-identity
    // veto — pinned in tests/cust-id-platform-veto.test.js).
    const mintBlocks = src.split(/_custIdMint\(/).length - 1;
    ok(rel + ': every mint gates on _companyProfileLoaded',
      mintBlocks > 0
      && (src.match(/_companyProfileLoaded !== true[\s\S]{0,900}?_custIdMint\(/g) || []).length === mintBlocks);
    ok(rel + ": no 'NBD' / 'customerIds' typeof fallback at a mint site",
      !/typeof window\._custCounterId === 'function'\) \? [^:]+ : 'customerIds'/.test(src)
      && !/typeof window\._custIdPrefix === 'function'\) \? [^:]+ : 'NBD'/.test(src)
      && !/_formatCustomerId\(_pfx[^)]*\)\s*:\s*_pfx \+ '-'/.test(src));
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All cust-id-prefix tests passed');
})().catch(e => { console.error('test crashed:', e && (e.stack || e.message)); process.exit(1); });
