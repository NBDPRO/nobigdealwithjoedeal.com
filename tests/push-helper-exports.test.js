/**
 * tests/push-helper-exports.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * functions/push-functions.js ended with
 *
 *     module.exports = { ...,
 *       sendPushNotification: exports.sendPushNotification,
 *       getUserFCMTokens: exports.getUserFCMTokens };
 *
 * but both are module-LOCAL `async function` declarations, never assigned to
 * `exports.*`. So those two keys exported `undefined`. functions/index.js does
 * `Object.assign(exports, require('./push-functions'))`, so the dead keys also
 * landed on the deploy entry point's export map (harmless to Firebase deploy,
 * which ignores anything without an `__endpoint`, but wrong for any caller that
 * reaches for the documented helper).
 *
 * This suite RUNS the module and calls the two helpers through the export map,
 * rather than matching source text: a regex over `sendPushNotification,` would
 * pass just as happily with `exports.sendPushNotification` still in place.
 *
 * Pure Node. Run: node tests/push-helper-exports.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── Stub firebase-admin BEFORE push-functions.js loads ──────────────────
// push-functions.js keeps getFirestore()/getMessaging() results at load time,
// so the stubs go into the require cache under the paths ITS require()
// resolves to.
const sentMessages = [];
const fakeDb = {
  collection() {
    return {
      doc() {
        return {
          get: async () => ({ exists: false, data: () => ({}) }),
          collection(sub) {
            return {
              get: async () => ({
                forEach: (cb) => (sub === 'fcmTokens'
                  ? [{ id: 'dev-1', data: () => ({ token: 'tok-1' }) }].forEach(cb)
                  : undefined),
              }),
              add: async () => ({ id: 'log-1' }),
              doc: () => ({ delete: async () => {} }),
            };
          },
        };
      },
    };
  },
};
const fakeMessaging = {
  sendEachForMulticast: async (msg) => {
    sentMessages.push(msg);
    return {
      successCount: msg.tokens.length,
      failureCount: 0,
      responses: msg.tokens.map(() => ({ success: true })),
    };
  },
};
function stub(request, exportsObj) {
  const resolved = require.resolve(request, { paths: [FUNCTIONS] });
  const m = new Module(resolved);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[resolved] = m;
}
stub('firebase-admin/firestore', {
  getFirestore: () => fakeDb,
  Timestamp: { fromDate: (d) => ({ toDate: () => d }), now: () => ({ toDate: () => new Date() }) },
  FieldValue: { serverTimestamp: () => '__ts__' },
});
stub('firebase-admin/messaging', { getMessaging: () => fakeMessaging });

// Keep the handler's "[Push] Sent: 1 Failed: 0" log line off stdout —
// scripts/run-test-manifest.js fails a suite whose output matches
// /(\d+) failed/i (see tests/push-lead-call-phone.test.js).
const fnLogger = require(require.resolve('firebase-functions/v2', { paths: [FUNCTIONS] })).logger;
for (const level of ['debug', 'log', 'info', 'warn', 'error']) fnLogger[level] = () => {};

const push = require(path.join(FUNCTIONS, 'push-functions.js'));

// The one place a dead key would be reported: every key of an export map whose
// value is not defined. Shared by the real check and its positive control.
const undefinedKeys = (map) => Object.keys(map).filter((k) => map[k] === undefined);

(async () => {
  console.log('\nPOSITIVE CONTROL');
  // The detector must be able to see the old shape, or the checks below prove
  // nothing. This is exactly what the module used to build.
  {
    const local = async function sendPushNotification() {};
    const broken = { sendPushNotification: exports.sendPushNotification, other: local };
    ok('the detector flags a key assigned from a never-assigned exports.X',
      undefinedKeys(broken).join() === 'sendPushNotification', undefinedKeys(broken).join());
    ok('the detector stays quiet for a defined export', undefinedKeys({ other: local }).length === 0);
  }

  console.log('\nEXPORT MAP');
  ok('sendPushNotification is exported as a function', typeof push.sendPushNotification === 'function',
    'got ' + typeof push.sendPushNotification);
  ok('getUserFCMTokens is exported as a function', typeof push.getUserFCMTokens === 'function',
    'got ' + typeof push.getUserFCMTokens);
  ok('no key of the module export map is undefined', undefinedKeys(push).length === 0,
    undefinedKeys(push).join(', '));

  // functions/index.js merges this module with Object.assign(exports, ...).
  const merged = Object.assign({}, push);
  ok('the merged index map carries both helpers',
    typeof merged.sendPushNotification === 'function' && typeof merged.getUserFCMTokens === 'function');
  const idx = fs.readFileSync(path.join(FUNCTIONS, 'index.js'), 'utf8');
  ok('functions/index.js still merges push-functions into its exports',
    /Object\.assign\(exports,\s*pushFunctions\)/.test(idx));

  // Helpers must not look like deployable functions: Firebase deploy picks up
  // exports carrying __endpoint, and these two must stay plain helpers.
  ok('neither helper carries an __endpoint (not a deployable function)',
    typeof push.sendPushNotification === 'function' && typeof push.getUserFCMTokens === 'function' &&
    !push.sendPushNotification.__endpoint && !push.getUserFCMTokens.__endpoint);

  console.log('\nBEHAVIOUR THROUGH THE EXPORT MAP');
  if (typeof push.getUserFCMTokens !== 'function' || typeof push.sendPushNotification !== 'function') {
    ok('helpers are callable through the export map', false, 'not functions; behaviour checks skipped');
  } else {
  {
    const res = await push.getUserFCMTokens('rep-1');
    ok('getUserFCMTokens returns the registered device token',
      res && Array.isArray(res.tokens) && res.tokens.length === 1 && res.tokens[0].token === 'tok-1',
      JSON.stringify(res));
  }
  {
    sentMessages.length = 0;
    const res = await push.sendPushNotification('rep-1', 'Title', 'Body', { type: 'newLead' });
    ok('sendPushNotification reports one delivery', res && res.sent === 1 && res.failed === 0, JSON.stringify(res));
    ok('exactly one multicast reached FCM, addressed to the device token',
      sentMessages.length === 1 && sentMessages[0].tokens.join() === 'tok-1', JSON.stringify(sentMessages));
    ok('the notification carries the title and body passed in',
      sentMessages.length === 1 && sentMessages[0].notification.title === 'Title' &&
      sentMessages[0].notification.body === 'Body');
  }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
