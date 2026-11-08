/**
 * tests/team-activity-query-2026-11-08.test.js — CRM audit 2026-11-06, ST-F39.
 *
 * admin-manager.js showActivity(): clicking a teammate's row in Team Manager
 * queried leads with where('userId','==',uid) alone. The leads rule only
 * proves a company reader's list query when it carries companyId == claim,
 * so every teammate row showed "Could not load activity: Missing or
 * insufficient permissions". A teammate row now adds the companyId filter;
 * the viewer's own row and claim-less (solo / platform admin) reads stay
 * userId-only, so legacy no-companyId leads stay visible to their owner.
 * Real code in a vm. Zero deps. Run: node tests/team-activity-query-2026-11-08.test.js
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
const SRC = fs.readFileSync(path.join(JS, 'admin-manager.js'), 'utf8').replace(/\r\n/g, '\n');
const s = SRC.indexOf('  async function showActivity(');
const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n  }\n', s) + 4) : '';

async function run(opts) {
  let captured = null;
  const feed = { innerHTML: '', textContent: '' };
  const sb = {
    window: {
      db: {},
      _user: opts.user,
      _userClaims: opts.claims,
      collection: () => 'leads',
      where: (f, op, v) => ({ f, op, v }),
      query: (c, ...fs) => { captured = fs; return 'q'; },
      getDocs: async () => ({ docs: opts.docs || [] }),
    },
    document: { getElementById: (id) => (id === 'adminActivityFeed' ? feed : { textContent: '' }) },
    escapeHTML: String,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sb);
  vm.runInContext(fn + '\nthis.showActivity = showActivity;', sb);
  await sb.showActivity(opts.email, opts.uid);
  return { captured: captured || [], feed };
}
const has = (fs, f, v) => fs.some((x) => x.f === f && x.op === '==' && x.v === v);

(async function main() {
  console.log('TEAM MANAGER ACTIVITY SCOPE (ST-F39)');
  ok('showActivity found (positive control)', /adminActivityFeed/.test(fn));

  const team = await run({ user: { uid: 'owner' }, claims: { role: 'company_admin', companyId: 'co-a' }, email: 'rep@x.test', uid: 'rep-uid' });
  ok('a teammate row scopes the query to the company claim', has(team.captured, 'companyId', 'co-a'), JSON.stringify(team.captured));
  ok('a teammate row still filters to that teammate', has(team.captured, 'userId', 'rep-uid'));
  ok('a teammate row does not show a load error', !/Could not load/.test(team.feed.innerHTML), team.feed.innerHTML);

  const self = await run({ user: { uid: 'owner' }, claims: { role: 'company_admin', companyId: 'co-a' }, email: 'me@x.test', uid: 'owner' });
  ok('your own row stays userId-only (legacy no-companyId leads stay visible)',
    self.captured.length === 1 && has(self.captured, 'userId', 'owner'), JSON.stringify(self.captured));

  const solo = await run({ user: { uid: 'solo' }, claims: {}, email: 'x@x.test', uid: 'other' });
  ok('no companyId claim keeps the userId-only read',
    solo.captured.length === 1 && has(solo.captured, 'userId', 'other'), JSON.stringify(solo.captured));

  const docs = [{ id: 'l1', data: () => ({ address: '12 Elm', createdAt: { toMillis: () => 5, toDate: () => new Date(5) } }) }];
  const shown = await run({ user: { uid: 'owner' }, claims: { role: 'manager', companyId: 'co-a' }, email: 'rep@x.test', uid: 'rep-uid', docs });
  ok('a returned lead renders into the feed (positive control)', /12 Elm/.test(shown.feed.innerHTML), shown.feed.innerHTML);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
