/**
 * tests/storm-watch-active-subscriber-2026-09-16.test.js
 *
 * functions/storm-watch.js's stormWatch cron and functions/sms-functions.js's
 * checkStormAlerts cron both query storm_alert_subscribers and text everyone
 * they find in range of a qualifying event. active:true is server-stamped on
 * every subscriber (functions/handlers/integrations.js's serverDefaults,
 * never client-trusted) specifically so an opted-out subscriber stops
 * matching every alert query — checkStormAlerts already filters on it
 * (.where('active', '==', true), sms-functions.js:958), but stormWatch's
 * query had no such filter, so an unsubscribed homeowner kept receiving
 * stormWatch's texts (though not checkStormAlerts's) after opting out.
 *
 * Fix: stormWatch's subscriber query now carries the same
 * .where('active', '==', true) filter as its sibling.
 *
 * 2026-10-03: both crons now load subscribers through ONE paged helper,
 * functions/storm-sms-guard.js loadActiveSubscribers (stormWatch's old
 * .limit(1000) silently dropped everyone past 1000), so this file follows the
 * query there. Behaviour (paging, opt-out, one cooldown) is driven in
 * tests/storm-sms-no-double-send-2026-10-03.test.js.
 *
 * Zero deps. Run: node tests/storm-watch-active-subscriber-2026-09-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

const STORM_WATCH = read('functions/storm-watch.js');
const SMS_FUNCTIONS = read('functions/sms-functions.js');
const GUARD = read('functions/storm-sms-guard.js');
const INTEGRATIONS = read('functions/handlers/integrations.js');

console.log('storm-watch.js — subscriber query filters on active:true\n');

group('the shared subscriber query (storm-sms-guard.js) filters on active', () => {
  const idx = GUARD.indexOf('db.collection(SUBSCRIBERS)');
  ok('found the subscriber query', idx >= 0 && /const SUBSCRIBERS = 'storm_alert_subscribers'/.test(GUARD));
  const line = GUARD.slice(idx, GUARD.indexOf('\n', idx) + 1);
  ok('the query chains .where(\'active\', \'==\', true)',
    /\.where\('active', '==', true\)/.test(line), line);
});

group('both crons load subscribers through that helper, not their own query', () => {
  ok('storm-watch.js uses StormGuard.loadActiveSubscribers', /StormGuard\.loadActiveSubscribers\(db/.test(STORM_WATCH));
  ok('sms-functions.js (checkStormAlerts) uses StormGuard.loadActiveSubscribers', /StormGuard\.loadActiveSubscribers\(db/.test(SMS_FUNCTIONS));
  ok('neither queries storm_alert_subscribers directly any more',
    !/collection\('storm_alert_subscribers'\)\s*\.where/.test(STORM_WATCH + SMS_FUNCTIONS));
});

group('active:true is server-stamped, never client-trusted (confirms the field is meaningful to filter on)', () => {
  ok('integrations.js documents storm signups getting active:true server-side',
    /active:\s*true/.test(INTEGRATIONS) && /serverDefaults/.test(INTEGRATIONS));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
