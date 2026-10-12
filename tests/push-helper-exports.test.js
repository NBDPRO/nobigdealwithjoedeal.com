/**
 * push-helper-exports.test.js — push-functions.js exports real helpers.
 *
 * Until 2026-10-02 the module.exports map in functions/push-functions.js read
 *   sendPushNotification: exports.sendPushNotification,
 *   getUserFCMTokens: exports.getUserFCMTokens
 * but neither `exports.X` was ever assigned — both are plain module-local
 * `async function`s — so both keys exported `undefined`. Any
 * require('./push-functions').sendPushNotification(...) threw a TypeError
 * inside a caller's try/catch and the push silently never went out. Today's
 * callers dodge it via sendCustomNotification; this suite stops the next one
 * from walking into it.
 *
 * Also pins the deploy surface: index.js Object.assign()s this module, so the
 * helpers must stay plain functions (no __endpoint — Firebase deploy ignores
 * them) and must not be declared as `exports.X =`, which the smoke tripwire
 * "every index.js export appears in FUNCTIONS_INDEX" scans for.
 *
 * Pure Node (firebase-admin stubbed). Run: node tests/push-helper-exports.test.js
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

// push-functions.js calls getFirestore() / getMessaging() at module load.
function stub(request, exportsObj) {
  const resolved = require.resolve(request, { paths: [FUNCTIONS] });
  const m = new Module(resolved);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[resolved] = m;
}
stub('firebase-admin/firestore', {
  getFirestore: () => ({}),
  Timestamp: { fromDate: (d) => ({ toDate: () => d }), now: () => ({ toDate: () => new Date() }) },
  FieldValue: { serverTimestamp: () => '__ts__' },
});
stub('firebase-admin/messaging', { getMessaging: () => ({}) });

const push = require(path.join(FUNCTIONS, 'push-functions.js'));

console.log('\npush-helper-exports — helpers resolve to real functions');
for (const name of ['sendPushNotification', 'getUserFCMTokens']) {
  ok(name + ' is exported as a function', typeof push[name] === 'function',
    'got ' + typeof push[name]);
  ok(name + ' is a plain helper, not a Cloud Function (no __endpoint)',
    typeof push[name] === 'function' && !push[name].__endpoint);
}
// Every key in the map should be defined — an `undefined` value is exactly
// the shape of this bug, whatever the key is called.
const undef = Object.keys(push).filter((k) => push[k] === undefined);
ok('no export key resolves to undefined', undef.length === 0, undef.join(', '));

// Missing-argument guard runs before any Firestore/FCM call, so this proves
// the exported function is the real sender without touching the stubs.
(async () => {
  try {
    const r = await push.sendPushNotification('', '', '');
    ok('sendPushNotification runs (missing-args guard returns a result)',
      r && typeof r === 'object' && r.sent === 0, JSON.stringify(r));
  } catch (e) {
    ok('sendPushNotification runs (missing-args guard returns a result)', false, e.message);
  }

  const src = fs.readFileSync(path.join(FUNCTIONS, 'push-functions.js'), 'utf8');
  ok('helpers are not declared as exports.X (keeps the FUNCTIONS_INDEX tripwire scope)',
    !/^exports\.(sendPushNotification|getUserFCMTokens)\s*=/m.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
