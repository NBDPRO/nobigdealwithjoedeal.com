/**
 * tests/small-misc-2026-11-06.test.js — CRM audit 2026-11-06, two small fixes.
 *
 * VW-F03 prospects.js ageInDays: a lead with an ISO-string or epoch-number
 *        createdAt (CSV imports) had no age and vanished under any age filter.
 * ST-F57 ai-texting-persona.js isOwner: the team-default option was hidden
 *        from a company_admin, though the rules (cpCanWrite) allow that role.
 * Zero deps. Run: node tests/small-misc-2026-11-06.test.js
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
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');
function block(src, start) {
  const s = src.indexOf(start);
  if (s < 0) return '';
  const indent = start.match(/^\s*/)[0];
  const e = src.indexOf('\n' + indent + '}\n', s);
  return e < 0 ? '' : src.slice(s, e + indent.length + 3);
}

console.log('PROSPECT AGE (VW-F03)');
{
  const fn = block(read('prospects.js'), '  function ageInDays(lead) {');
  ok('ageInDays found (positive control)', fn.length > 100);
  const sb = { Date, isNaN };
  vm.createContext(sb);
  vm.runInContext(fn + '\nglobalThis.__age = ageInDays;', sb);
  const tenDaysAgo = Date.now() - 10 * 86400000;
  const fakeTs = { toDate: () => new Date(tenDaysAgo) };
  ok('a Firestore Timestamp still ages (positive control)', sb.__age({ createdAt: fakeTs }) === 10);
  ok('an ISO-string createdAt (CSV import) ages', sb.__age({ createdAt: new Date(tenDaysAgo).toISOString() }) === 10, String(sb.__age({ createdAt: new Date(tenDaysAgo).toISOString() })));
  ok('an epoch-ms number ages', sb.__age({ createdAt: tenDaysAgo }) === 10);
  ok('garbage or missing stays "no age"', sb.__age({ createdAt: 'not a date' }) === null && sb.__age({}) === null && sb.__age({ createdAt: '' }) === null);
}

console.log('PERSONA TEAM DEFAULT (ST-F57)');
{
  const P = read('ai-texting-persona.js');
  const code = ['  function uid() {', '  function companyId() {', '  function isOwner() {'].map((h) => block(P, h)).join('\n');
  ok('uid, companyId and isOwner found (positive control)', /function isOwner\(\)/.test(code) && /function uid\(\)/.test(code));
  const run = (claims, u) => {
    const sb = { window: { _userClaims: claims, _user: { uid: u } } };
    vm.createContext(sb);
    vm.runInContext(code + '\nglobalThis.__o = isOwner();', sb);
    return sb.__o;
  };
  ok('a company_admin can set the team default (the rules allow it)', run({ role: 'company_admin', companyId: 'OWNER' }, 'CA') === true);
  ok('the owner still can (positive control)', run({ companyId: 'OWNER' }, 'OWNER') === true);
  ok('a sales rep still cannot', run({ role: 'sales_rep', companyId: 'OWNER' }, 'REP') === false);
  ok('a viewer still cannot', run({ role: 'viewer', companyId: 'OWNER' }, 'V') === false);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
