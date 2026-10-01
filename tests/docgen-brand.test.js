/**
 * tests/docgen-brand.test.js — Phase B-1: client doc-generator brand resolution.
 *
 * Verifies NBDDocGen._resolveCompany() (document-generator.js):
 *   - NBD (or any tenant whose brand still matches the NBD default) resolves to
 *     the UNCHANGED COMPANY literal — byte-identical (same object, same CSS).
 *   - A non-NBD tenant (Oaks) resolves to its own brand: colors, name, contact,
 *     logo remapped; neutral UI grays preserved from the base.
 *
 * Zero deps. Evals the browser file in a vm sandbox with a stubbed
 * window._brand(). Run: node tests/docgen-brand.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

function loadDocGen(brand) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js', 'document-generator.js'), 'utf8');
  const win = { _brand: () => brand };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(src, sandbox, { filename: 'document-generator.js' });
  return win.NBDDocGen;
}

console.log('DOCGEN BRAND — _resolveCompany()');

// ── NBD default brand → same VALUES as the COMPANY literal (byte-identical) ──
const NBD_BRAND = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
const dgNBD = loadDocGen(NBD_BRAND);
ok('NBDDocGen loaded', !!(dgNBD && typeof dgNBD._resolveCompany === 'function'));
const cNBD = dgNBD._resolveCompany();
// _resolveCompany now BUILDS a fresh object for every tenant, NBD included, so
// the profile is the single source of truth. Reference identity is therefore no
// longer the contract — equal VALUES are, which is the stronger guarantee and
// the one customers actually see on a document.
ok('NBD: resolves to the COMPANY base VALUES',
  ['name', 'phone', 'email', 'website', 'tagline', 'address']
    .every((k) => cNBD[k] === dgNBD.COMPANY[k]));
// Regression lock: _logoSrc used to detect NBD by object identity
// (c !== this.COMPANY). Now that NBD gets a built object, that test would have
// been true for NBD and silently stripped its logo off every document.
ok('NBD: still gets a logo (identity-check regression)', !!dgNBD._logoSrc());
ok('NBD: name unchanged', cNBD.name === 'No Big Deal Home Solutions');
ok('NBD: email unchanged (info@)', cNBD.email === 'info@nobigdealwithjoedeal.com');
// NBD DOCUMENT STANDARD, locked 2026-09-07: the palette was re-measured off the
// master logo artwork. Retired #1e3a6e / #1a1a2e / #e8720c — the last of which
// also failed WCAG AA on white at 3.07:1. Expected VALUES updated; the
// assertions themselves are unchanged in shape and still pin the NBD chrome.
ok('NBD: primary navy unchanged', cNBD.colors.primary === '#1A3057');
ok('NBD: secondary unchanged (#12223D)', cNBD.colors.secondary === '#12223D');
ok('NBD: getSharedCSS renders navy #1A3057 (byte-identical chrome)', /#1A3057/i.test(dgNBD.getSharedCSS()));
ok('NBD: getSharedCSS renders orange accent', /#BD5728/i.test(dgNBD.getSharedCSS()));

// ── Oaks brand → remapped ──
const OAKS_BRAND = {
  legalName: 'Oaks Roofing & Construction',
  docPrefix: 'OAK',
  tagline: 'Roofing, Siding, Gutters',
  logoUrl: 'https://nobigdealwithjoedeal.com/sites/oaks/logo-orange.svg',
  colors: { primary: '#333333', secondary: '#1A1A1A', accent: '#E8720C' },
  contact: { phone: '(513) 827-5297', email: 'joe@oaksrfc.com', website: 'oaksroofingandconstruction.com', address: 'Goshen, OH' }
};
const dgOAK = loadDocGen(OAKS_BRAND);
const cOAK = dgOAK._resolveCompany();
ok('Oaks: name remapped', cOAK.name === 'Oaks Roofing & Construction');
ok('Oaks: NOT the NBD base', cOAK !== dgOAK.COMPANY);
ok('Oaks: primary charcoal', cOAK.colors.primary === '#333333');
ok('Oaks: secondary near-black', cOAK.colors.secondary === '#1A1A1A');
ok('Oaks: phone remapped', cOAK.phone === '(513) 827-5297');
ok('Oaks: email remapped', cOAK.email === 'joe@oaksrfc.com');
ok('Oaks: logoUrl set', /logo-orange\.svg$/.test(cOAK.logoUrl || ''));
ok('Oaks: neutral lightGray preserved from base', cOAK.colors.lightGray === '#f5f5f5');
ok('Oaks: getSharedCSS renders Oaks charcoal #333333', /#333333/i.test(dgOAK.getSharedCSS()));
// TENANCY ISOLATION. This must track the CURRENT NBD navy — pinned against the
// retired #1e3a6e it would pass vacuously (nothing renders that colour any
// more) and would stop protecting anything. It is the assertion that proves a
// stranger tenant's document does not come out wearing NBD's brand.
ok('Oaks: getSharedCSS does NOT render NBD navy', !/#1A3057/i.test(dgOAK.getSharedCSS()));

console.log('\nDOCGEN BRAND — _logoSrc() + _docPrefix() (Phase B-2)');
// The NAVY lockup (2026-09-30): nbd-logo.png is white-on-transparent for the
// site's dark headers and "NO BIG" vanishes on a white page.
ok('NBD: logo falls back to the navy nbd-logo-light-bg.png (readable on paper)', /nbd-logo-light-bg\.png$/.test(dgNBD._logoSrc()));
ok('NBD: docPrefix = NBD (byte-identical)', dgNBD._docPrefix() === 'NBD');
ok('Oaks: logo = tenant logoUrl', dgOAK._logoSrc() === 'https://nobigdealwithjoedeal.com/sites/oaks/logo-orange.svg');
ok('Oaks: docPrefix = OAK', dgOAK._docPrefix() === 'OAK');

// ── _docPrefix derivation for a non-NBD tenant with NO reserved prefix ──
// Blank docPrefix used to return '' → orphan '-0001' doc numbers and
// '-Contract-Smith-….pdf' filenames. Now derives a seal from legalName,
// byte-identical to company-profile.js _deriveCustPrefix (word initials,
// slice 4; <2 chars → first word slice 3; ''/'NBD' → 'CUS').
console.log('\nDOCGEN BRAND — _docPrefix() derivation (unreserved non-NBD tenant)');
const dgUNRES = loadDocGen({ legalName: 'Oaks Roofing & Construction', docPrefix: '', colors: {}, contact: {} });
ok('unreserved: derives ORC from legalName initials', dgUNRES._docPrefix() === 'ORC');
ok('unreserved: never blank', dgUNRES._docPrefix() !== '');
const dgDEGEN = loadDocGen({ legalName: '——', docPrefix: '', colors: {}, contact: {} });
ok('degenerate legalName: falls back to CUS', dgDEGEN._docPrefix() === 'CUS');
const dgCOLLIDE = loadDocGen({ legalName: 'New Boston Decking', docPrefix: '', colors: {}, contact: {} });
ok('NBD-initials collision: forced to CUS (never NBD)', dgCOLLIDE._docPrefix() === 'CUS');
ok('NBD-initials collision: result is not NBD', dgCOLLIDE._docPrefix() !== 'NBD');

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
