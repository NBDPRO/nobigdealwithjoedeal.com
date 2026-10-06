/**
 * tests/storm-briefing-tenant-scope-2026-10-05.test.js
 *
 * The Slack "Leads in storm path" briefing (functions/integrations/
 * storm-briefing.js) looked leads up by zipCode ONLY, so any company's lead
 * in that ZIP landed in the platform's Slack message — a cross-tenant leak
 * (found 2026-10-05 during the Roof Care Plan build). The lookup must be
 * scoped to one company: the alert's own companyId when it carries one,
 * else the platform tenant (NBD_OWNER_UID), whose storm-alert pipeline and
 * Slack channel these are. In-memory Firestore; synthetic data.
 *
 * Run: node tests/storm-briefing-tenant-scope-2026-10-05.test.js
 */
'use strict';
const path = require('path');
process.env.NBD_OWNER_UID = 'OWNER';
const SB = require(path.join(__dirname, '..', 'functions', 'integrations', 'storm-briefing.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

function makeDb(leads) {
  function q(filters, lim) {
    return {
      where(f, op, v) { return q(filters.concat([[f, v]]), lim); },
      limit(n) { return q(filters, n); },
      async get() {
        let docs = leads.filter((l) => filters.every(([f, v]) => l[f] === v));
        if (lim) docs = docs.slice(0, lim);
        const wrapped = docs.map((d) => ({ id: d.id, data: () => Object.assign({}, d) }));
        return { docs: wrapped, forEach: (fn) => wrapped.forEach(fn), size: wrapped.length, empty: !wrapped.length };
      },
    };
  }
  return { collection: (name) => (name === 'leads' ? q([], 0) : q([['__never__', 1]], 0)) };
}

const LEADS = [
  { id: 'nbd1', companyId: 'OWNER', zipCode: '45202', firstName: 'Ours' },
  { id: 'nbd2', companyId: 'OWNER', zipCode: '45202', firstName: 'AlsoOurs', isProspect: true },
  { id: 'oth1', companyId: 'co-other', zipCode: '45202', firstName: 'TheirCustomer' },
  { id: 'oth2', companyId: 'co-third', zipCode: '45202', firstName: 'AnotherTenant' },
  { id: 'nbd3', companyId: 'OWNER', zipCode: '45011', firstName: 'OtherZip' },
];

(async () => {
  console.log('\nstorm briefing — one company per lookup');
  ok('the lookup is exposed for testing', typeof SB._findAffectedLeads === 'function');
  if (typeof SB._findAffectedLeads !== 'function') return done();
  const db = makeDb(LEADS);
  const plat = await SB._findAffectedLeads(db, { zip: '45202' });
  ok('an alert with no companyId → only the platform tenant\'s leads in that ZIP (prospects still skipped)',
    plat.map((l) => l.id).join(',') === 'nbd1', plat.map((l) => l.id).join(','));
  ok('another company\'s lead in the same ZIP is never in the platform briefing', !plat.some((l) => l.companyId !== 'OWNER'));
  const theirs = await SB._findAffectedLeads(db, { zip: '45202', companyId: 'co-other' });
  ok('an alert that names its company → only that company\'s leads', theirs.map((l) => l.id).join(',') === 'oth1', theirs.map((l) => l.id).join(','));
  ok('no ZIP → no leads', (await SB._findAffectedLeads(db, {})).length === 0);
  done();
})().catch((e) => { console.error(e); process.exit(1); });

function done() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
}
