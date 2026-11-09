/**
 * tests/st-f64-2026-11-08.test.js — a service-area change made in Settings
 * reaches the tenant's public microsite (CRM audit ST-F64, 2026-11-08).
 *
 * buildPublicConfig (functions/handlers/public-site.js) read
 * brand.serviceArea BEFORE the top-level companyProfile.serviceArea. But
 * brand.serviceArea is written once, by createCompany at provisioning, and
 * never again: the setup wizard and Settings → Company Profile both save the
 * top-level field, and the document generators read it. So a tenant who
 * changed their service area kept the old one on /sites/t/ forever. The
 * top-level field wins now; a tenant with only brand.serviceArea still falls
 * back to it.
 *
 * Runs the real buildPublicConfig + sitePublishReadiness lifted into a vm
 * (no firebase deps, the microsite-publication-gate harness).
 * Run: node tests/st-f64-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const SRC = fs.readFileSync(path.join(ROOT, 'functions/handlers/public-site.js'), 'utf8').replace(/\r\n/g, '\n');
function slice(src, start, end) { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i); return j < 0 ? '' : src.slice(i, j + end.length); }
const fns = [
  slice(SRC, 'function s(v, max) {', '\n}'),
  slice(SRC, 'function hex(v) {', '\n}'),
  slice(SRC, 'function sitePublishReadiness(companyId, companyDoc, profileDoc) {', '\n}'),
  slice(SRC, 'function buildPublicConfig(companyId, companyDoc, profileDoc) {', '\n}'),
];
ok('control: the helpers and both functions are found', fns.every((f) => f.length > 20), fns.map((f) => f.length).join(','));
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fns.join('\n') + '\nglobalThis.__b = buildPublicConfig; globalThis.__r = sitePublishReadiness;', sandbox);
const build = sandbox.__b;
const ready = sandbox.__r;
const co = { name: 'Summit Roofing', status: 'active' };

console.log('\nMICROSITE SERVICE AREA: the field Settings edits wins');
{
  const cfg = build('c1', co, { serviceArea: 'Dayton, OH', brand: { serviceArea: 'Cincinnati' } });
  ok('the top-level serviceArea (Settings, wizard) beats the provisioning-time brand copy', cfg.serviceArea === 'Dayton, OH', cfg.serviceArea);
}
{
  const cfg = build('c1', co, { brand: { serviceArea: 'Cincinnati' } });
  ok('a tenant with only brand.serviceArea still shows it', cfg.serviceArea === 'Cincinnati', cfg.serviceArea);
}
{
  const cfg = build('c1', co, { serviceArea: '   ', brand: { serviceArea: 'Cincinnati' } });
  ok('a blank top-level value falls back to the brand copy', cfg.serviceArea === 'Cincinnati', cfg.serviceArea);
}
{
  const cfg = build('c1', co, { serviceArea: 'x'.repeat(200) });
  ok('the 120-char cap still applies', cfg.serviceArea.length === 120, cfg.serviceArea.length);
}
{
  const cfg = build('c1', co, {});
  ok('nothing set: no service area in the payload', cfg.serviceArea === '', cfg.serviceArea);
}

console.log('\nPUBLISH READINESS reads the same value');
{
  const p = { serviceArea: 'Dayton, OH', brand: { displayName: 'Summit', contact: { phone: '(513) 555-0199' } } };
  const r = ready('c1', co, p);
  ok('only the top-level service area set: not listed as missing', r.ready === true && r.missing.indexOf('service area') < 0, JSON.stringify(r));
  const r2 = ready('c1', co, { brand: { displayName: 'Summit', contact: { phone: '(513) 555-0199' } } });
  ok('no service area anywhere: listed as missing', r2.missing.indexOf('service area') >= 0, JSON.stringify(r2));
}

ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"st-f64-2026-11-08.test.js"') >= 0);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
