/**
 * tests/nbd-os-tenant-mark-2026-11-08.test.js — the NBD OS boot and lock
 * screens' mark belongs to the signed-in COMPANY (finding OS-TENANT-MARK).
 *
 * markText() in os/system.js took two initials from the letterhead business
 * name and otherwise fell back to the header's .logo-mark, which is the
 * platform's hard-coded "NBD" in dashboard.html. A tenant whose profile had
 * no businessName booted to "NBD" and locked to "NBD".
 *
 *   1. os/system-logic.js (pure): brandMark(rawBrand) — the seal a company
 *      reserved, else initials of its display name, else of its legal name,
 *      else '' (no mark, never another company's letters).
 *   2. the REAL markText() lifted out of os/system.js into a vm sandbox: a
 *      tenant with no business name gets its own brand's mark or nothing;
 *      the header's letters are read only for the platform tenant, by
 *      identity (window._isNbdPlatformTenant), and the brand comes from the
 *      RAW override (window._brandOverride), never the merged profile whose
 *      blanks the platform's defaults fill.
 *   3. wiring (static): both screens draw markText(); system.js never reads
 *      _companyProfile.brand.
 *
 * Run: node tests/nbd-os-tenant-mark-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const L = require(path.join(ROOT, 'docs/pro/js/os/system-logic.js'));
const DOM = read('docs/pro/js/os/system.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}

console.log('brandMark (pure)');
const bm = typeof L.brandMark === 'function' ? L.brandMark : () => undefined;
ok('exported from system-logic.js', typeof L.brandMark === 'function');
ok('nothing set -> no mark', bm(null) === '' && bm(undefined) === '' && bm({}) === '' && bm('Oaks') === '');
ok('the reserved seal wins', bm({ seal: 'OAK', displayName: 'Oaks', legalName: 'Oaks Roofing LLC' }) === 'OAK', bm({ seal: 'OAK', displayName: 'Oaks', legalName: 'Oaks Roofing LLC' }));
ok('a blank seal falls through to the display name', bm({ seal: '  ', displayName: 'Summit Ridge Roofing' }) === 'SR');
ok('display name before legal name', bm({ displayName: 'Summit Ridge Roofing', legalName: 'Blue Hill Exteriors LLC' }) === 'SR');
ok('legal name alone', bm({ legalName: 'Blue Hill Exteriors LLC' }) === 'BH');
ok('a long seal is capped at 4', bm({ seal: 'ROOFERS' }) === 'ROOF');
ok('a non-string seal is ignored', bm({ seal: 42, legalName: 'Acme' }) === 'AC');

console.log('markText (the real function, lifted)');
const i0 = DOM.indexOf('  function companyName() {');
const i1 = DOM.indexOf('  function motionReducedNow() {', i0);
const body = i0 >= 0 && i1 > i0 ? DOM.slice(i0, i1) : '';
ok('control: found companyName + markText in system.js', /function markText\(\)/.test(body), body.slice(0, 120));

/**
 * opts: businessName (letterhead), platform (true/false; undefined = company-
 * profile.js not loaded), override (the raw brand; undefined = no function),
 * mergedBrand (what _companyProfile.brand carries), header (the .logo-mark text).
 */
function mark(opts) {
  opts = opts || {};
  const w = { _companyProfile: { businessName: opts.businessName || '', brand: opts.mergedBrand || {} } };
  if (opts.platform !== undefined) w._isNbdPlatformTenant = () => opts.platform;
  if (opts.override !== undefined) w._brandOverride = () => opts.override;
  const headerReads = [];
  const doc = { querySelector: (sel) => { headerReads.push(sel); return sel === 'header .logo-mark' ? { textContent: opts.header === undefined ? 'NBD' : opts.header } : null; } };
  const ctx = { w, doc, L, call: (fn) => { try { return fn(); } catch (e) { return undefined; } }, __markText: null };
  vm.runInNewContext(body + '\n__markText = markText;', ctx);
  const text = ctx.__markText();
  return { text, headerReads };
}

// The finding: a tenant with no business name saw the platform's letters.
let r = mark({ platform: false, override: null });
ok('a tenant with no business name and no brand gets NO mark, not "NBD"', r.text === '', JSON.stringify(r.text));
ok('…and the header\'s letters are never read for it', r.headerReads.indexOf('header .logo-mark') === -1, r.headerReads.join(','));
r = mark({ platform: false, override: { seal: 'OAK', legalName: 'Oaks Roofing LLC' } });
ok('a tenant with no business name shows its own reserved seal', r.text === 'OAK', r.text);
r = mark({ platform: false, override: { legalName: 'Oaks Roofing LLC' } });
ok('…or its legal name\'s initials', r.text === 'OR', r.text);
r = mark({ platform: false, override: { displayName: 'Summit Ridge Roofing', legalName: 'Blue Hill Exteriors LLC' } });
ok('…its display name first', r.text === 'SR', r.text);
r = mark({ platform: false, businessName: 'Blue Hill Exteriors', override: { seal: 'OAK' } });
ok('the letterhead business name still comes first (unchanged)', r.text === 'BH', r.text);
// The merged profile fills a tenant's blanks with the platform's brand; the mark must read the RAW override.
r = mark({ platform: false, override: null, mergedBrand: { seal: 'NBD', displayName: 'No Big Deal', legalName: 'No Big Deal Home Solutions' } });
ok('the merged profile\'s platform defaults never become a tenant\'s mark', r.text === '', JSON.stringify(r.text));
// Identity unknown (pre-auth) or company-profile.js absent: nothing, never the platform's letters.
r = mark({ platform: false, override: undefined });
ok('no raw-override function -> no mark', r.text === '', JSON.stringify(r.text));
r = mark({ platform: undefined, override: undefined });
ok('company-profile.js not loaded -> no mark (typeof guards)', r.text === '', JSON.stringify(r.text));
// The platform tenant keeps the header's mark.
r = mark({ platform: true, override: null });
ok('the platform tenant keeps "NBD" (the header\'s mark)', r.text === 'NBD', r.text);
r = mark({ platform: true, override: null, header: '  NBDX5 ' });
ok('…trimmed to 4 characters as before', r.text === 'NBDX', r.text);
r = mark({ platform: true, businessName: 'No Big Deal Home Solutions' });
ok('a platform letterhead name still gives its initials (unchanged)', r.text === 'NB', r.text);
r = mark({ platform: false, override: { seal: '<b>' } });
ok('the mark is plain text (escaped by the caller, so the seal passes through as typed)', r.text === '<b>', r.text);

console.log('wiring');
ok('the boot screen draws markText()', /os-boot-mark" aria-hidden="true">' \+ esc\(markText\(\)\)/.test(DOM));
ok('the lock screen draws markText()', /os-lock-mark" aria-hidden="true">' \+ esc\(markText\(\)\)/.test(DOM));
ok('the header\'s letters are read only behind the platform-identity gate',
  body.indexOf('_isNbdPlatformTenant') >= 0 && body.indexOf('_isNbdPlatformTenant') < body.indexOf("header .logo-mark"));
ok('the tenant mark goes through the pure rule on the raw brand override', /L\.brandMark\(/.test(body) && /_brandOverride/.test(body));
ok('system.js never reads the merged _companyProfile.brand', !/_companyProfile\.brand/.test(DOM));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
