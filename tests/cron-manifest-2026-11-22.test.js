#!/usr/bin/env node
/**
 * tests/cron-manifest-2026-11-22.test.js — every scheduled function has a
 * functions/cron-manifest.js entry, a time zone, and (when it sends to
 * customers) the customer send window.
 *
 * Audit: documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §3.8 /
 * §4 (runAbandonRecovery shipped with no timeZone; leadFollowUpSweep mailed
 * homeowners at 00:00 and 03:00 ET). The facts the code already states
 * (schedule, timeZone, timeoutSeconds) are read from the REAL deployed
 * endpoints: functions/index.js is loaded the full way (as
 * scripts/gen-function-map.js does), never hand-copied.
 *
 *   A. the real exports: no drift at all
 *   B. the checker can fail: a new cron with no entry, a cron with no time
 *      zone, a customer-sending cron outside the window, a stale entry
 *
 * Needs functions/node_modules. Run: node tests/cron-manifest-2026-11-22.test.js
 */
'use strict';

const path = require('path');

const FN = path.join(__dirname, '..', 'functions');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
delete process.env.FUNCTION_TARGET;
const quiet = console.log;
console.log = () => {};
let idx;
try { idx = require(path.join(FN, 'index.js')); } finally { console.log = quiet; }
const MAP = require(path.join(FN, 'function-map.json'));
const CM = require(path.join(FN, 'cron-manifest.js'));
const { CRON_GATES } = require(path.join(FN, 'cron-gates.js'));
const { AUTOMATION_KEYS } = require(path.join(FN, 'messaging-controls.js'));
const opts = { cronGates: CRON_GATES, automationKeys: AUTOMATION_KEYS };

console.log('\nA. the deployed crons match the manifest');
const rows = CM.build(idx, MAP);
ok('index.js exports scheduled functions (positive control: ≥ 40 found)', rows.length >= 40, rows.length);
const problems = CM.check(idx, MAP, opts);
ok('no drift between the scheduled exports and cron-manifest.js', problems.length === 0, problems);
const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
ok('leadFollowUpSweep: sends email, uses the window, runs on Eastern time',
  byName.leadFollowUpSweep && byName.leadFollowUpSweep.sendsToCustomers === 'email' && byName.leadFollowUpSweep.usesSendWindow === true
  && byName.leadFollowUpSweep.timeZone === 'America/New_York', byName.leadFollowUpSweep);
ok('runAbandonRecovery now has a timeZone (it had none)', byName.runAbandonRecovery && byName.runAbandonRecovery.timeZone === 'America/New_York', byName.runAbandonRecovery);
ok('esignReminderSweep runs hourly so every zone reaches its window', byName.esignReminderSweep && byName.esignReminderSweep.schedule === '0 * * * *', byName.esignReminderSweep);
ok('module / timeoutSeconds are derived (function-map + endpoint)', byName.emailQueueWorker && byName.emailQueueWorker.module === MAP.emailQueueWorker
  && byName.emailQueueWorker.timeoutSeconds === idx.emailQueueWorker.__endpoint.timeoutSeconds, byName.emailQueueWorker);
const senders = rows.filter((r) => r.sendsToCustomers !== 'none').map((r) => r.name).sort();
ok('the customer-sending crons are exactly the known six', JSON.stringify(senders) === JSON.stringify(
  ['callCenterIngest', 'esignReminderSweep', 'leadFollowUpSweep', 'reviewAskAutoSweep', 'runAbandonRecovery', 'stormPoller']), senders);

console.log('\nB. the checker fails on drift');
const fakeCron = (schedule, timeZone) => {
  const f = () => {};
  f.__endpoint = { scheduleTrigger: timeZone === undefined ? { schedule } : { schedule, timeZone }, timeoutSeconds: 60 };
  return f;
};
{
  const extra = Object.assign({}, idx, { brandNewSweep: fakeCron('0 3 * * *', 'America/New_York') });
  const p = CM.check(extra, Object.assign({}, MAP, { brandNewSweep: './brand-new' }), opts);
  ok('a cron added without an entry fails', p.some((x) => x.startsWith('brandNewSweep:') && /no cron-manifest\.js entry/.test(x)), p);
}
{
  const ex = { aSweep: fakeCron('0 3 * * *') };
  const entries = { aSweep: { sendsToCustomers: 'none', usesSendWindow: false, gate: [] } };
  const p = CM.check(ex, { aSweep: './a' }, Object.assign({ entries }, opts));
  ok('a cron with no timeZone fails', p.some((x) => /aSweep: no timeZone/.test(x)), p);
  const p2 = CM.check({ aSweep: fakeCron('0 3 * * *', 'Mars/Olympus') }, { aSweep: './a' }, Object.assign({ entries }, opts));
  ok('...and so does an invalid one', p2.some((x) => /aSweep: no timeZone/.test(x)), p2);
  const p3 = CM.check({ aSweep: fakeCron('0 3 * * *', 'America/Chicago') }, { aSweep: './a' }, Object.assign({ entries }, opts));
  ok('control: the same cron with a valid zone is clean', p3.length === 0, p3);
}
{
  const ex = { mailer: fakeCron('0 */3 * * *', 'America/New_York') };
  const entries = { mailer: { sendsToCustomers: 'email', usesSendWindow: false, gate: [] } };
  const p = CM.check(ex, { mailer: './m' }, Object.assign({ entries }, opts));
  ok('a customer-sending cron without the send window fails', p.some((x) => /mailer: sends to customers but does not use/.test(x)), p);
  const p2 = CM.check(ex, { mailer: './m' }, Object.assign({ entries: { mailer: { sendsToCustomers: 'sometimes', usesSendWindow: true, gate: [] } } }, opts));
  ok('an unknown sendsToCustomers value fails', p2.some((x) => /mailer: sendsToCustomers must be/.test(x)), p2);
}
{
  const entries = Object.assign({}, CM.ENTRIES, { goneSweep: { sendsToCustomers: 'none', usesSendWindow: false, gate: [] } });
  const p = CM.check(idx, MAP, Object.assign({ entries }, opts));
  ok('an entry for a cron that no longer exists fails', p.some((x) => x.startsWith('goneSweep:')), p);
}
{
  const ex = { g: fakeCron('0 3 * * *', 'America/New_York') };
  const p = CM.check(ex, { g: './g' }, Object.assign({ entries: { g: { sendsToCustomers: 'none', usesSendWindow: false, gate: ['env:NOT_A_REAL_GATE_ENABLED', 'automation:notAKey', 'whatever'] } } }, opts));
  ok('unknown gates fail (env not in cron-gates.js, unknown automation key, no prefix)', p.length === 3, p);
}

console.log('\nC. the declarations are tied to the code (require graph, review 2026-11-25)');
{
  // usesSendWindow: true must be backed by code that reaches send-window.js
  // (not merely messaging-controls.js, which every sender loads).
  const codeOpts = Object.assign({ reach: (m) => CM.reach(FN, m) }, opts);
  ok('the real manifest is clean with the code check on', CM.check(idx, MAP, codeOpts).length === 0, CM.check(idx, MAP, codeOpts));
  const r = CM.reach(FN, './lead-followup');
  ok('reach(): lead-followup reaches send-window.js and the resend package (positive control)', r.files.has('send-window.js') && r.packages.has('resend'), [[...r.files].slice(0, 5), [...r.packages]]);
  // estimate-email.js loads messaging-controls.js (which lazily requires
  // send-window.js for guardTwilio) but never uses the window itself.
  const viaMc = CM.reach(FN, './estimate-email');
  ok('reach(): messaging-controls.js is reached but not walked through (its lazy send-window require proves nothing)',
    viaMc.files.has('messaging-controls.js') && !viaMc.files.has('send-window.js'), [...viaMc.files]);
  const ex = { aSweep: fakeCron('0 9 * * *', 'America/New_York') };
  const claimsWindow = { aSweep: { sendsToCustomers: 'email', usesSendWindow: true, gate: [] } };
  const p = CM.check(ex, { aSweep: './integrations/compliance' }, Object.assign({ entries: claimsWindow }, codeOpts));
  ok('usesSendWindow: true on a module that never reaches send-window.js fails', p.some((x) => /aSweep: .*never reaches send-window\.js/.test(x)), p);
  const p2 = CM.check(ex, { aSweep: './lead-followup' }, Object.assign({ entries: claimsWindow }, codeOpts));
  ok('...control: the same entry on lead-followup.js is clean', p2.length === 0, p2);
  const quietNone = { aSweep: { sendsToCustomers: 'none', usesSendWindow: false, gate: [] } };
  const p3 = CM.check(ex, { aSweep: './lead-followup' }, Object.assign({ entries: quietNone }, codeOpts));
  ok('a "none" cron whose code reaches resend / twilio with no why fails', p3.some((x) => /aSweep: .*reaches .*why/.test(x)), p3);
  const p4 = CM.check(ex, { aSweep: './lead-followup' }, Object.assign({ entries: { aSweep: Object.assign({ why: 'test: owner mail only' }, quietNone.aSweep) } }, codeOpts));
  ok('...control: the same entry with a why is clean', p4.length === 0, p4);
  const p5 = CM.check(ex, { aSweep: './integrations/compliance' }, Object.assign({ entries: quietNone }, codeOpts));
  ok('...and a "none" cron that reaches no sender needs no why', p5.length === 0, p5);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
