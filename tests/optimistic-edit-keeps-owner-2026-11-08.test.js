/**
 * tests/optimistic-edit-keeps-owner-2026-11-08.test.js
 *
 * CRM audit 2026-11-06 — PL-F09 (pipeline, cached lead after an edit).
 *
 * _optimisticInsertLead() (docs/pro/js/dashboard-bootstrap.module.js) put the
 * just-saved lead into window._leads by REPLACING the cached record with
 * { id, ...formPayload, userId: <current user> }. The Edit Lead payload
 * (crm-leads.js _leadPayload) never carries userId, companyId, activeJobId,
 * stageHistory or customerId, so after a manager edited a rep's lead offline
 * (a queued write skips the follow-up loadLeads) the card showed the manager
 * as owner, the second-job link and customer number vanished, and
 * NBDJobs.records() counted the active job twice in the money tiles.
 * Fix: an edit merges onto the cached lead, as Firestore's updateDoc does.
 *
 * Lifts the REAL function into a vm sandbox and runs the REAL jobs-store.js.
 * Break-test: against the unfixed source the owner/company/job/history/
 * customer-number and the records-count asserts go red; the controls stay green.
 *
 * Zero deps. Run: node tests/optimistic-edit-keeps-owner-2026-11-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BOOT_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
const JOBS_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/jobs-store.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Brace-matched lift (same helper as tests/leads-loaded-account-switch.test.js).
function lift(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = src.indexOf('{', start + marker.length - 1);
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return i < src.length ? src.slice(start, i + 1) : null;
}

console.log('extraction');
const OPTIMISTIC = lift(BOOT_SRC, 'function _optimisticInsertLead(leadId, data)');
ok('_optimisticInsertLead() lifted', !!OPTIMISTIC && OPTIMISTIC.includes('window._leads.unshift(merged)'));
if (!OPTIMISTIC) { console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); }

function boot() {
  const created = new Date(2026, 0, 1);
  const win = {
    _user: { uid: 'mgr-1' },
    _userClaims: { role: 'manager', companyId: 'co-1' },
    _leads: [{
      id: 'L1', userId: 'rep-1', companyId: 'co-1', activeJobId: 'job-2',
      stageHistory: [{ to: 'new' }], customerId: 'NBD-0007', stage: 'Estimate Sent',
      createdAt: created, firstName: 'Old', phone: '111'
    }],
    stageRole: () => 'active'
  };
  let renders = 0;
  const ctx = vm.createContext({
    window: win,
    normalizeStage: (s) => s,
    stageRole: () => 'active',
    renderLeads: () => { renders++; }
  });
  const fn = vm.runInContext('(function(){ let _leadsCacheUid = \'mgr-1\';\n'
    + 'function _resetLeadsCache(){ window._leads = []; window._leadsLoaded = false; _leadsCacheUid = null; }\n'
    + OPTIMISTIC + '\nreturn _optimisticInsertLead; })()', ctx);
  return { win, fn, created, renders: () => renders };
}

console.log('\nedit of a teammate\'s lead (the Edit Lead payload shape)');
const a = boot();
a.fn('L1', { firstName: 'New', phone: '222', stage: 'Estimate Sent' });
const m = a.win._leads[0] || {};
ok('still one cached lead', a.win._leads.length === 1);
ok('owner stays the rep, not the editing manager', m.userId === 'rep-1', 'got ' + m.userId);
ok('companyId kept', m.companyId === 'co-1', 'got ' + m.companyId);
ok('activeJobId kept', m.activeJobId === 'job-2', 'got ' + m.activeJobId);
ok('stageHistory kept', Array.isArray(m.stageHistory) && m.stageHistory.length === 1);
ok('customerId kept', m.customerId === 'NBD-0007', 'got ' + m.customerId);
ok('createdAt is the same Date', m.createdAt === a.created);
ok('edited fields applied', m.firstName === 'New' && m.phone === '222');
ok('_stageKey / _stageRole stamped', m._stageKey === 'Estimate Sent' && m._stageRole === 'active');
ok('rendered once', a.renders() === 1);

console.log('\nmoney records: the active job is counted once');
const jctx = vm.createContext({ window: {} });
vm.runInContext(JOBS_SRC, jctx);
const NBDJobs = jctx.window.NBDJobs;
const jobs = [
  { id: 'job-2', stage: 'Estimate Sent', createdAt: 1 },
  { id: 'job-3', stage: 'new', createdAt: 2 }
];
const recs = NBDJobs.records([m], () => jobs);
ok('records() yields 2 (lead for job-2 + job-3)', recs.length === 2, 'got ' + recs.length);

console.log('\ncontrols');
const b = boot();
b.fn('NEW1', { firstName: 'Lu', stage: 'new' });
ok('new lead is prepended', b.win._leads.length === 2 && b.win._leads[0].id === 'NEW1');
ok('new lead is owned by the current user', b.win._leads[0].userId === 'mgr-1');
ok('new lead gets a fresh createdAt', Object.prototype.toString.call(b.win._leads[0].createdAt) === '[object Date]');
const c = boot();
c.fn('L1', { firstName: 'X', userId: 'rep-9' });
ok('a payload userId wins over the cached one', c.win._leads[0].userId === 'rep-9');
ok('an omitted stage keeps the stored one', c.win._leads[0].stage === 'Estimate Sent');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
