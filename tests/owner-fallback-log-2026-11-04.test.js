/**
 * tests/owner-fallback-log-2026-11-04.test.js
 *
 * isOwnerCaller() still admits an owner by the deprecated verified-email fallback. This PR only adds a log line when that fallback is
 * the reason a call passed (so removing it can be decided from data). Pins: the answer is unchanged for every case, the log fires
 * exactly when only the fallback admits, it carries the uid and never the email, and a failing logger never changes the answer.
 *
 * Run: node tests/owner-fallback-log-2026-11-04.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { isOwnerCaller } = require(path.join(ROOT, 'functions', 'handlers', '_shared.js'));
// The same module object _shared.js gets, resolved from functions/ so the test patches what the code actually calls.
const logger = require(require.resolve('firebase-functions/logger', { paths: [path.join(ROOT, 'functions')] }));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const realWarn = logger.warn;
function withLog(fn) {
  const calls = [];
  logger.warn = (...a) => { calls.push(a); };
  try { return { result: fn(), calls }; } finally { logger.warn = realWarn; }
}
const OWNER = 'jd@nobigdealwithjoedeal.com';

console.log('\n1. the answer is unchanged');
{
  ok('the owner claim admits', withLog(() => isOwnerCaller({ owner: true })).result === true);
  ok('a verified owner email admits (fallback)', withLog(() => isOwnerCaller({ email: OWNER, email_verified: true })).result === true);
  ok('the same email unverified is refused', withLog(() => isOwnerCaller({ email: OWNER, email_verified: false })).result === false && withLog(() => isOwnerCaller({ email: OWNER })).result === false);
  ok('a verified non-owner email is refused', withLog(() => isOwnerCaller({ email: 'someone@example.com', email_verified: true })).result === false);
  ok('case and spaces in the email still match', withLog(() => isOwnerCaller({ email: '  JD@NoBigDealWithJoeDeal.com ', email_verified: true })).result === true);
  ok('no token, an empty token and a non-string email are refused', withLog(() => isOwnerCaller(null)).result === false && withLog(() => isOwnerCaller({})).result === false && withLog(() => isOwnerCaller({ email: 5, email_verified: true })).result === false);
}

console.log('\n2. the log fires only when the fallback is the reason');
{
  const viaEmail = withLog(() => isOwnerCaller({ email: OWNER, email_verified: true, uid: 'u1' }));
  ok('fallback admit: exactly one owner_fallback_used warning', viaEmail.calls.length === 1 && viaEmail.calls[0][0] === 'owner_fallback_used', JSON.stringify(viaEmail.calls));
  ok('it carries the uid', viaEmail.calls[0][1].uid === 'u1');
  ok('it never carries the email or the token', !JSON.stringify(viaEmail.calls).toLowerCase().includes('nobigdeal') && !JSON.stringify(viaEmail.calls).includes('@'));
  ok('falls back to sub when there is no uid', withLog(() => isOwnerCaller({ email: OWNER, email_verified: true, sub: 's9' })).calls[0][1].uid === 's9');
  ok('the claim admitting means no log, even with an owner email on the token', withLog(() => isOwnerCaller({ owner: true, email: OWNER, email_verified: true })).calls.length === 0);
  ok('refused calls do not log', withLog(() => isOwnerCaller({ email: OWNER, email_verified: false })).calls.length === 0 && withLog(() => isOwnerCaller({ email: 'x@y.com', email_verified: true })).calls.length === 0 && withLog(() => isOwnerCaller(null)).calls.length === 0);
}

console.log('\n3. a failing logger never changes the answer');
{
  logger.warn = () => { throw new Error('logging down'); };
  let r;
  try { r = isOwnerCaller({ email: OWNER, email_verified: true }); } finally { logger.warn = realWarn; }
  ok('still admits, no throw', r === true);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
