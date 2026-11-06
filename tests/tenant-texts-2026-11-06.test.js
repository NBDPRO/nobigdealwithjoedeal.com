/**
 * tests/tenant-texts-2026-11-06.test.js — CRM audit 2026-11-06 (VW-F04,
 * VW-F08, VW-F09): words a rep sends or says to ANOTHER company's customers.
 *
 * - d2d-tracker-core-2026b.js _d2dCompany: D2D follow-up texts named
 *   "No Big Deal Home Solutions" whenever the tenant had no legal name set
 *   (it treated "no legal name" as "NBD").
 * - winback.js companyName: win-back drafts to past customers fell back to NBD.
 * - storm-center.js generateTalkingPoints: door scripts said "I'm with No Big
 *   Deal Home Solutions" for every company.
 * - storm-integration.js generateMarketingCampaign: defaulted to NBD's name,
 *   phone and website.
 * NBD is now decided by the platform-tenant check (companyId) when it is
 * loaded; NBD keeps its exact wording.
 *
 * Runs each real helper, extracted verbatim. Zero deps.
 * Run: node tests/tenant-texts-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function fnFrom(file, start) {
  const src = fs.readFileSync(path.join(JS, file), 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const s = src.indexOf(start);
  if (s < 0) return '';
  const indent = start.match(/^\s*/)[0];
  const e = src.indexOf(eol + indent + '}', s);
  return e < 0 ? '' : src.slice(s, e + eol.length + indent.length + 1);
}
// tenants: NBD platform / named tenant / unnamed tenant / identity unknown (old behaviour)
const CASES = {
  nbd: { platform: true, brand: { legalName: 'No Big Deal Home Solutions' } },
  named: { platform: false, brand: { legalName: 'Test Roofing LLC', displayName: 'Test Roofing', contact: { phone: '(555) 010-0100', website: 'https://test-roofing.example' } } },
  unnamed: { platform: false, brand: { legalName: '', displayName: '' } },
  unknown: { platform: undefined, brand: null },
};
function run(file, start, call, c) {
  const code = fnFrom(file, start);
  const win = { _brand: () => c.brand };
  if (c.platform !== undefined) win._isNbdPlatformTenant = () => c.platform;
  const sandbox = { window: win, console };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nglobalThis.__out = (' + call + ');', sandbox);
  return { code, out: sandbox.__out };
}

console.log('D2D FOLLOW-UP TEXTS (VW-F04)');
{
  const r = (k) => run('d2d-tracker-core-2026b.js', '  function _d2dCompany() {', '_d2dCompany()', CASES[k]);
  ok('helper found (positive control)', r('nbd').code.length > 100);
  ok('NBD keeps "No Big Deal Home Solutions"', r('nbd').out === 'No Big Deal Home Solutions');
  ok('a named tenant gets its own name', r('named').out === 'Test Roofing LLC');
  ok('a tenant with no name gets a neutral phrase, never NBD', r('unnamed').out === 'our team', r('unnamed').out);
}
console.log('WIN-BACK DRAFTS (VW-F08)');
{
  const r = (k) => run('winback.js', '  function companyName() {', 'companyName()', CASES[k]);
  ok('helper found (positive control)', r('nbd').code.length > 100);
  ok('a named tenant gets its display name', r('named').out === 'Test Roofing');
  ok('a tenant with no name gets a neutral phrase, never NBD', r('unnamed').out === 'our team', r('unnamed').out);
  ok('identity unknown keeps the old NBD fallback', r('unknown').out === 'No Big Deal Home Solutions');
}
console.log('STORM CENTER DOOR SCRIPTS (VW-F09)');
{
  const helper = fnFrom('storm-center.js', '  function _stormCompany() {');
  const tp = fnFrom('storm-center.js', '  function generateTalkingPoints(zone) {');
  const r = (k) => {
    const c = CASES[k];
    const win = { _brand: () => c.brand };
    if (c.platform !== undefined) win._isNbdPlatformTenant = () => c.platform;
    const sandbox = { window: win, console };
    vm.createContext(sandbox);
    vm.runInContext(helper + '\n' + tp + '\nglobalThis.__out = generateTalkingPoints({ hailSize: 1.5, windSpeed: 70, damageProb: 0.8 });', sandbox);
    return sandbox.__out.map((p) => p.text || '').join(' || ');
  };
  ok('talking points render (positive control)', /hail event/.test(r('nbd')));
  ok('NBD keeps "I\'m with No Big Deal Home Solutions"', /I'm with No Big Deal Home Solutions/.test(r('nbd')));
  ok('another tenant\'s reps introduce their own company', /I'm with Test Roofing LLC/.test(r('named')) && !/No Big Deal/.test(r('named')), r('named').slice(0, 120));
  ok('an unnamed tenant never says No Big Deal', !/No Big Deal/.test(r('unnamed')));
}
console.log('STORM MARKETING DEFAULT COMPANY');
{
  const fn = fnFrom('storm-integration.js', '  function generateMarketingCampaign(zone, company) {');
  ok('function found (positive control)', fn.length > 200);
  const companyOf = (k) => {
    const m = fn.match(/^([\s\S]*?const eventType)/);
    const head = (m ? m[1] : '').replace(/const eventType$/, '') + '  return company;\n}';
    const c = CASES[k];
    const win = { _brand: () => c.brand };
    if (c.platform !== undefined) win._isNbdPlatformTenant = () => c.platform;
    const sandbox = { window: win, console };
    vm.createContext(sandbox);
    vm.runInContext(head + '\nglobalThis.__out = generateMarketingCampaign({}, null);', sandbox);
    return sandbox.__out;
  };
  ok('NBD default stays NBD', companyOf('nbd').name === 'No Big Deal Home Solutions');
  const t = companyOf('named');
  ok('another tenant defaults to its own name / phone / site', t.name === 'Test Roofing LLC' && t.phone === '(555) 010-0100' && t.website === 'test-roofing.example', JSON.stringify(t));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
