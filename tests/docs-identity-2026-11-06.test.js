/**
 * tests/docs-identity-2026-11-06.test.js — CRM audit 2026-11-06, NBD identity
 * on other contractors' customer paper.
 *
 * ED-F29 document-generator-templates.js: NBD's slogan printed on every
 *        tenant's door hanger ("No cost. No obligation. No big deal.") and
 *        thank-you letter ("… no stress, no hassle, no big deal."). NBD keeps
 *        it byte-identical.
 * ED-F24 esign.html / esign-sign.js: the e-sign page showed "No Big Deal Home
 *        Solutions" while another contractor's envelope loaded.
 * Real renders, same harness as tests/docgen-render.test.js.
 * Zero deps. Run: node tests/docs-identity-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const DG_DIR = path.join(ROOT, 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const SRC_DOCGEN = fs.readFileSync(path.join(DG_DIR, 'document-generator.js'), 'utf8');
const SRC_TEMPLATES = fs.readFileSync(path.join(DG_DIR, 'document-generator-templates.js'), 'utf8');

function loadFullDocGen(brand) {
  const plat = !brand || !brand.legalName || brand.legalName === 'No Big Deal Home Solutions';
  const win = { _brand: () => brand, _isNbdPlatformTenant: () => plat };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(SRC_DOCGEN, sandbox, { filename: 'document-generator.js' });
  vm.runInNewContext(SRC_TEMPLATES, sandbox, { filename: 'document-generator-templates.js' });
  return win.NBDDocGen;
}
function render(brand, method, data) {
  try { return loadFullDocGen(brand)[method](Object.assign({}, data)); } catch (e) { return 'RENDER_ERROR: ' + (e && e.message); }
}
const NBD = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
const OAKS = { legalName: 'Oaks Roofing & Construction', displayName: 'Oaks Roofing & Construction', colors: { primary: '#333333', accent: '#C2410C' }, contact: { phone: '(513) 555-0100' } };
const DATA = { homeownerName: 'Jane Smith', address: '123 Main St', completionDate: 'Nov 6, 2026', projectType: 'roof replacement' };

console.log('DOOR HANGER + THANK-YOU (ED-F29)');
{
  const nbdH = render(NBD, 'renderDoorHanger', DATA);
  const oakH = render(OAKS, 'renderDoorHanger', DATA);
  const nbdT = render(NBD, 'renderThankYou', DATA);
  const oakT = render(OAKS, 'renderThankYou', DATA);
  ok('all four documents render (positive control)', [nbdH, oakH, nbdT, oakT].every((h) => typeof h === 'string' && h.indexOf('RENDER_ERROR') !== 0 && h.length > 500));
  ok('NBD\'s door hanger keeps its slogan', /No cost\. No obligation\. No big deal\./.test(nbdH));
  ok('another company\'s door hanger does not carry NBD\'s slogan', !/No big deal/i.test(oakH.replace(/No Big Deal Home Solutions/g, '')) && /No cost\. No obligation\./.test(oakH));
  ok('NBD\'s thank-you letter keeps "no stress, no hassle, no big deal"', /no stress, no hassle, no big deal\./.test(nbdT));
  ok('another company\'s thank-you letter does not', !/no stress, no hassle, no big deal/.test(oakT) && /lived up to your expectations\./.test(oakT));
}

console.log('E-SIGN BRAND WHILE LOADING (ED-F24)');
{
  const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'esign.html'), 'utf8');
  const tag = (HTML.match(/<div class="es-brand" id="esBrand"[^>]*>/) || [''])[0];
  ok('the brand element is found (positive control)', !!tag);
  ok('it starts hidden, so no NBD name shows while another contractor\'s envelope loads', /visibility:hidden/.test(tag), tag);
  const JS = fs.readFileSync(path.join(DG_DIR, 'esign-sign.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('…and is shown once the envelope (and its company) has loaded',
    /envelope = r\.data;[\s\S]{0,400}el\.brand\.style\.visibility = ''/.test(JS));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
