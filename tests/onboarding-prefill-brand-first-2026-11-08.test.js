/**
 * tests/onboarding-prefill-brand-first-2026-11-08.test.js — a setup-wizard
 * re-run keeps a company name changed in Settings (CRM audit ST-F61).
 *
 * prefill() filled the business name from users/{uid}.company BEFORE the brand
 * (companyProfile.brand.legalName), and setIfEmpty keeps the first value, so a
 * rename made in Settings (which never updates users.company) was undone on
 * Finish. The brand is read first now; users.company is the first-run
 * fallback and the login display name the last.
 *
 * Runs the real setIfEmpty + prefill in a vm (the hygiene-guards harness).
 * Run: node tests/onboarding-prefill-brand-first-2026-11-08.test.js
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
const OB = fs.readFileSync(path.join(ROOT, 'docs/pro/js/pages/onboarding.js'), 'utf8').replace(/\r\n/g, '\n');
function slice(src, start, end) { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i); return j < 0 ? '' : src.slice(i, j + end.length); }
const fns = slice(OB, 'function setIfEmpty(id, value) {', '\n}') + '\n' + slice(OB, 'async function prefill() {', '\n}');
ok('control: prefill is found', fns.length > 400, fns.length);

async function run(opts) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { value: '' });
  const state = { user: { uid: 'u1', email: 'login@example.test', displayName: opts.displayName || '' }, claims: { companyId: 'c1' } };
  const docs = { 'users/u1': opts.user, 'companyProfile/c1': opts.profile };
  const reads = [];
  const sandbox = { state, $: el, val: (id) => el(id).value, db: {}, doc: (db, c, id) => c + '/' + id, deriveSeal: () => 'TR', String, console,
    getDoc: async (ref) => { reads.push(ref); const d = docs[ref]; return d ? { exists: () => true, data: () => d } : { exists: () => false }; } };
  vm.createContext(sandbox);
  vm.runInContext(fns + '\nglobalThis.__p = prefill;', sandbox);
  await sandbox.__p();
  return { els, reads, state };
}

(async () => {
  console.log('\nWIZARD PREFILL: the brand wins');
  {
    const r = await run({ user: { company: 'Old Name Roofing' }, profile: { brand: { legalName: 'New Name Exteriors LLC' } } });
    ok('a company renamed in Settings keeps the new name on a re-run', r.els.obName.value === 'New Name Exteriors LLC', r.els.obName.value);
    ok('the brand is read before the users doc', r.reads[0] === 'companyProfile/c1' && r.reads.indexOf('users/u1') > 0, r.reads.join(','));
  }
  {
    const r = await run({ user: { company: 'Old Name Roofing' }, profile: { businessName: 'Legacy Business Name' } });
    ok('an older profile with only businessName still beats users.company', r.els.obName.value === 'Legacy Business Name', r.els.obName.value);
  }
  {
    const r = await run({ user: { company: 'First Run Co' }, profile: null });
    ok('a first run (no profile yet) still prefills from users.company', r.els.obName.value === 'First Run Co', r.els.obName.value);
  }
  {
    const r = await run({ user: null, profile: null, displayName: 'Jo Example' });
    ok('nothing stored: the login display name is the last fallback', r.els.obName.value === 'Jo Example', r.els.obName.value);
  }
  {
    const r = await run({ user: { company: 'Old' }, profile: { brand: { legalName: 'New', contact: { email: 'office@example.test', alertEmail: 'alerts@example.test' } } } });
    ok('the ST-F60 rule still holds: a separate alert inbox is flagged to keep', r.state.keepAlertEmail === true && r.els.obEmail.value === 'office@example.test');
  }
  ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"onboarding-prefill-brand-first-2026-11-08.test.js"') >= 0);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
