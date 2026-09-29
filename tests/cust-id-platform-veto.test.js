/**
 * tests/cust-id-platform-veto.test.js — client customer-ID mints never stamp
 * NBD's identity on another tenant's customer.
 *
 * THE BUG (2026-09-29): _custIdPrefix()/_custCounterId() in company-profile.js
 * gate on _isNbdBrand(brand), which is true for ANY tenant that never set
 * brand.legalName — a real state (provisioning-retry.js). So a hydrated but
 * un-provisioned non-NBD tenant minted an un-salted 'NBD-####' from the shared
 * counters/customerIds sequence, and the ID never self-heals (mints only run
 * while customerId is absent).
 *
 * THE FIX: every client mint site asks window._custIdMint(companyId), which
 * applies the same platform-identity veto as the server mint
 * (functions/customer-id-mint.js resolveLeadMint) and _tenantFilePrefix: NBD
 * format only when companyId === the NBD owner UID; otherwise null → skip.
 *
 * Two layers:
 *   1. The helper itself, in a vm sandbox of company-profile.js.
 *   2. The ACTUAL mint blocks, sliced out of customer-bootstrap.module.js,
 *      dashboard-bootstrap.module.js (both _saveLead branches) and
 *      data-import.js, run against a fake Firestore. This layer is written
 *      against the stable anchors of the pre-fix code too, so on the pre-fix
 *      tree it runs and reddens on 'NBD-0001' rather than skipping.
 *
 * Zero deps. Run: node tests/cust-id-platform-veto.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs/pro/js');
const OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

function loadCompanyProfile() {
  const src = fs.readFileSync(path.join(JS, 'company-profile.js'), 'utf8');
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = { addEventListener() {}, removeEventListener() {}, localStorage };
  win.window = win;
  const sandbox = { window: win, localStorage, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
  vm.runInNewContext(src, sandbox, { filename: 'company-profile.js' });
  return win;
}

// Every slice from `start` to the end of the line holding `end` (searched
// after start). Throws when a site is missing so a refactor that moves the
// anchors fails loudly instead of silently testing nothing.
function slices(src, start, end, file) {
  const out = [];
  let from = 0;
  for (;;) {
    const s = src.indexOf(start, from);
    if (s < 0) break;
    const e = src.indexOf(end, s);
    if (e < 0) throw new Error(file + ': end anchor not found after a start anchor');
    const eol = src.indexOf('\n', e);
    out.push(src.slice(s, eol < 0 ? src.length : eol));
    from = eol < 0 ? src.length : eol;
  }
  if (!out.length) throw new Error(file + ': no mint site found');
  return out;
}

const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');
const SITES = [];
{
  const src = read('customer-bootstrap.module.js');
  slices(src, "if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {",
    'lead.customerId = newId;', 'customer-bootstrap')
    .filter((b) => /_formatCustomerId\(/.test(b))
    .forEach((body, i) => SITES.push({ name: 'customer-bootstrap lazy mint #' + (i + 1), kind: 'bootstrap', body }));
}
{
  const src = read('dashboard-bootstrap.module.js');
  slices(src, "if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {",
    "console.log('✓ Assigned customer ID:', custId);", 'dashboard-bootstrap')
    .filter((b) => /_formatCustomerId\(/.test(b))
    .forEach((body, i) => SITES.push({ name: 'dashboard _saveLead branch #' + (i + 1), kind: 'bootstrap', body }));
}
{
  const src = read('data-import.js');
  // The import mint is one `if (...) { ... }` block; slice through its close.
  slices(src, 'if (!lead.customerId\n', "await window.updateDoc(window.doc(window.db, 'leads', ref.id), { customerId: custId });", 'data-import')
    .forEach((body, i) => SITES.push({ name: 'data-import row mint #' + (i + 1), kind: 'import', body: body + '\n}' }));
}

// Run one sliced mint block as `win`'s tenant. Returns { stamped, counters }.
async function runSite(site, win, companyId) {
  const counters = {};
  const stamped = [];
  const doc = (_db, col, id) => ({ col, id });
  const runTransaction = async (_db, fn) => fn({
    get: async (ref) => ({ exists: () => ref.id in counters, data: () => counters[ref.id] }),
    set: (ref, d) => { counters[ref.id] = Object.assign({}, counters[ref.id], d); },
  });
  const updateDoc = async (ref, data) => { stamped.push(data.customerId); };
  win._companyProfileLoaded = true;
  win._loadCompanyProfile = async () => {};
  win._user = { uid: companyId };
  win._userClaims = { companyId };
  Object.assign(win, { doc, runTransaction, updateDoc, db: {} });
  const sandbox = {
    window: win, console: { log() {}, warn() {}, error() {} },
    doc, runTransaction, updateDoc, db: {},
    lead: { companyId }, id: 'lead1', leadRef: { id: 'lead1' }, fallbackRef: { id: 'lead1' },
    ref: { id: 'lead1' }, companyId,
  };
  const code = '(async () => { try {\n' + site.body + '\n} catch (_) { /* skip path */ } })()';
  await vm.runInNewContext(code, sandbox, { filename: site.name });
  return { stamped, counters };
}

(async () => {
  console.log('HELPER — window._custIdMint(companyId)');
  let win = loadCompanyProfile();
  ok('_custIdMint is a function', typeof win._custIdMint === 'function');
  const mint = (w, cid) => (typeof w._custIdMint === 'function' ? w._custIdMint(cid) : 'MISSING');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Default sandbox == hydrated, un-provisioned tenant: brand.legalName unset,
  // so _isNbdBrand() is true for whoever is signed in.
  ok('un-provisioned stranger → null (skip, not NBD)', mint(win, 'stranger-co') === null);
  ok('NBD owner → { NBD, customerIds } (byte-identical legacy)', eq(mint(win, OWNER), { prefix: 'NBD', counterId: 'customerIds' }));
  ok('empty companyId → null', mint(win, '') === null && mint(win, null) === null);
  win.__NBD_OWNER_UID = 'override-owner';
  ok('window.__NBD_OWNER_UID is honoured', eq(mint(win, 'override-owner'), { prefix: 'NBD', counterId: 'customerIds' })
    && mint(win, OWNER) === null);
  delete win.__NBD_OWNER_UID;

  await win._saveCompanyProfile({ brand: { legalName: 'Oaks Roofing & Construction', docPrefix: 'OAK' } });
  ok('configured tenant → its own prefix + counter', eq(mint(win, 'oaks'), { prefix: 'OAK', counterId: 'customerIds_oaks' }));
  await win._saveCompanyProfile({ brand: { legalName: 'Some Other Roofing Co' } });
  ok('prefix-less non-NBD tenant → derived prefix, own counter', eq(mint(win, 'someco'), { prefix: 'SORC', counterId: 'customerIds_someco' }));

  console.log('\nMINT SITES — the real blocks against a fake Firestore');
  ok('found 4 mint sites (customer page, 2× _saveLead, import)', SITES.length === 4);
  for (const site of SITES) {
    // Un-provisioned stranger: the bug stamped 'NBD-0001' from counters/customerIds.
    let r = await runSite(site, loadCompanyProfile(), 'stranger-co');
    ok(site.name + ': un-provisioned stranger → NO customerId stamped', r.stamped.length === 0);
    ok(site.name + ': un-provisioned stranger → NBD shared counter untouched', !('customerIds' in r.counters));
    ok(site.name + ': un-provisioned stranger → never an NBD- id', !r.stamped.some((x) => /^NBD-/.test(String(x))));

    r = await runSite(site, loadCompanyProfile(), OWNER);
    ok(site.name + ': NBD owner → NBD-0001 from customerIds', eq(r.stamped, ['NBD-0001']) && r.counters.customerIds && r.counters.customerIds.next === 1);

    win = loadCompanyProfile();
    await win._saveCompanyProfile({ brand: { legalName: 'Oaks Roofing & Construction', docPrefix: 'OAK' } });
    r = await runSite(site, win, 'oaks');
    ok(site.name + ': configured tenant → salted OAK-0001-XXXX from its own counter',
      r.stamped.length === 1 && r.stamped[0] === win._formatCustomerId('OAK', 1, 'oaks') && r.counters.customerIds_oaks);
  }

  console.log('\nNO BYPASS — mint files never read the raw prefix/counter helpers');
  for (const f of ['customer-bootstrap.module.js', 'dashboard-bootstrap.module.js', 'data-import.js']) {
    const src = read(f).replace(/\/\/[^\n]*/g, '');
    ok(f + ': no direct _custCounterId( call', !/_custCounterId\(/.test(src));
    ok(f + ': no direct _custIdPrefix() call', !/_custIdPrefix\(\)/.test(src));
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All cust-id-platform-veto tests passed');
})().catch((e) => { console.error('test crashed:', e && (e.stack || e.message)); process.exit(1); });
