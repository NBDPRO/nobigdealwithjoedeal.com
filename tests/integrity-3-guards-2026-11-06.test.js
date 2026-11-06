/**
 * tests/integrity-3-guards-2026-11-06.test.js — CRM audit 2026-11-06, third
 * integrity pass. Real code in a vm for each.
 *
 * ST-F52 agent-bots-settings.js settingsCard: an UNSET timezone was pre-selected
 *        as UTC (the server reports UTC + timezoneSet:false), so the next Save
 *        wrote timezone='UTC' for good.
 * ST-F53 ai-texting-persona.js defaultName: a rep with no display name defaulted
 *        to — and saved — "Joe", for every tenant (homeowner texts signed "Joe").
 * PL-F14 dashboard-actions.js hideFollowUpAlerts / crm-pipeline.js: Dismiss on the
 *        follow-up strip hid it on that device forever.
 * PL-F12 crm-portal-bridge.js toggleCardSelection: a customer with two job cards
 *        highlighted only the first card; kanban-context-menu.js said "Delete
 *        lead" on a multi-job customer though it deletes every job.
 * Zero deps. Run: node tests/integrity-3-guards-2026-11-06.test.js
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
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
function block(src, start) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const s = src.indexOf(start);
  if (s < 0) return '';
  const indent = start.match(/^\s*/)[0];
  const e = src.indexOf(eol + indent + '}', s);
  return e < 0 ? '' : src.slice(s, e + eol.length + indent.length + 1);
}

console.log('BOTS TIMEZONE (ST-F52)');
{
  const SRC = read('agent-bots-settings.js');
  const card = block(SRC, '  function settingsCard(d) {');
  const tzs = SRC.match(/const TZS = \[[^\]]*\];/);
  ok('settingsCard found (positive control)', card.length > 200 && !!tzs);
  const sandbox = { esc: (s) => String(s), browserTz: () => 'America/New_York' };
  vm.createContext(sandbox);
  vm.runInContext((tzs ? tzs[0] : 'const TZS=[];') + '\n' + card + '\nglobalThis.__c = settingsCard;', sandbox);
  const unset = sandbox.__c({ timezone: 'UTC', timezoneSet: false, enabled: true });
  ok('unset: "Not set — pick yours" is offered', /<option value="">Not set — pick yours<\/option>/.test(unset));
  ok('unset: UTC is NOT pre-selected (so Save cannot write it)', !/value="UTC" selected/.test(unset), (unset.match(/<option[^>]*selected[^>]*>[^<]*/) || [''])[0]);
  const set = sandbox.__c({ timezone: 'America/Chicago', timezoneSet: true, enabled: true });
  ok('set: the saved timezone is selected (positive control)', /value="America\/Chicago" selected/.test(set));
}

console.log('AI PERSONA NAME (ST-F53)');
{
  const fn = block(read('ai-texting-persona.js'), '  function defaultName() {');
  ok('defaultName found (positive control)', fn.length > 50);
  const run = (user, platform) => {
    const win = { _user: user };
    if (platform !== undefined) win._isNbdPlatformTenant = () => platform;
    const sandbox = { window: win };
    vm.createContext(sandbox);
    vm.runInContext(fn + '\nglobalThis.__n = defaultName();', sandbox);
    return sandbox.__n;
  };
  ok('a rep with a display name gets their first name', run({ displayName: 'Riley Rep' }, false) === 'Riley');
  ok('another tenant\'s rep with no name stays blank (server fills it), never "Joe"', run({}, false) === '', JSON.stringify(run({}, false)));
  ok('the NBD platform tenant keeps the Joe fallback', run({}, true) === 'Joe');
}

console.log('FOLLOW-UP DISMISS (PL-F14)');
{
  const store = {};
  const sandbox = { localStorage: { setItem: (k, v) => { store[k] = String(v); }, getItem: (k) => (k in store ? store[k] : null) },
    document: { getElementById: () => ({ style: {} }) }, Date };
  vm.createContext(sandbox);
  const fn = block(read('dashboard-actions.js'), 'function hideFollowUpAlerts() {');
  vm.runInContext(fn + '\nhideFollowUpAlerts();', sandbox);
  const today = new Date().toLocaleDateString('en-CA');
  ok('Dismiss stores today\'s date, not a forever flag', store.nbd_crm_followup_hidden === today, store.nbd_crm_followup_hidden);
  const PIPE = read('crm-pipeline.js');
  ok('the strip counts as dismissed only on that day', /localStorage\.getItem\('nbd_crm_followup_hidden'\) === new Date\(\)\.toLocaleDateString\('en-CA'\)/.test(PIPE));
  ok('…so a legacy "1" no longer hides it forever', !/getItem\('nbd_crm_followup_hidden'\) === '1'/.test(PIPE));
}

console.log('MULTI-JOB CUSTOMER CARDS (PL-F12)');
{
  const BR = read('crm-portal-bridge.js');
  const eol = BR.includes('\r\n') ? '\r\n' : '\n';
  const s0 = BR.indexOf('function toggleCardSelection(leadId) {');
  const fn = s0 >= 0 ? BR.slice(s0, BR.indexOf(eol + '}' + eol, s0) + eol.length + 1) : '';
  const mk = () => ({ cls: new Set(), classList: { toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, _s: null } });
  const c1 = mk(); c1.classList._s = c1.cls; const c2 = mk(); c2.classList._s = c2.cls;
  let selected = new Set();
  const sandbox = { window: { _bulkMode: true, NBDStore: {} }, document: { querySelectorAll: () => [c1, c2], querySelector: () => c1 }, Array,
    getBulkSelected: () => selected, updateBulkSelection: (f) => { const n = new Set(selected); f(n); selected = n; }, updateBulkToolbar() {} };
  vm.createContext(sandbox);
  vm.runInContext(fn + '\ntoggleCardSelection("L1");', sandbox);
  ok('toggleCardSelection found (positive control)', fn.length > 100 && selected.has('L1'));
  ok('ticking a job card highlights EVERY card of that customer', c1.cls.has('bulk-selected') && c2.cls.has('bulk-selected'), [c1.cls.size, c2.cls.size].join(','));
  const KCM = read('kanban-context-menu.js');
  ok('"Delete lead" says "Delete customer (all N jobs)" when the customer has more than one job',
    /label: _jobCount > 1 \? 'Delete customer \(all ' \+ _jobCount \+ ' jobs\)' : 'Delete lead'/.test(KCM) && /NBDJobs\.forLead\(lead\.id\)/.test(KCM));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
