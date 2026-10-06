/**
 * tests/session-revocation.test.js — "Sign Out Everywhere" has to mean it.
 *
 * THE DEFECT (2026-09-08 adversarial claims audit, most severe of 14)
 * ──────────────────────────────────────────────────────────────────
 * docs/pro/dashboard.html shipped a red "Sign Out Everywhere" button, and
 * /pro/how-to told users that after a suspected password compromise they
 * should "change it and sign out of all devices". The button dispatched
 * data-action="signOut" → window._signOut(), whose entire body is a
 * localStorage sweep plus signOut(auth): a purely LOCAL sign-out that clears
 * THIS browser's persistence and nothing else. An attacker's session on
 * another device kept refreshing indefinitely, while the product told the
 * victim they had just locked it out.
 *
 * revokeRefreshTokens existed in five places, every one an admin/enforcement
 * path acting on somebody else (handlers/admin.js x3, handlers/invites.js,
 * integrations/compliance.js, lapse-enforcement.js). There was no
 * self-service path. functions/handlers/auth.js revokeMySessions is it.
 *
 * WHY THIS FILE EXECUTES INSTEAD OF GREPPING
 * ──────────────────────────────────────────
 * A /revokeRefreshTokens/ regex would have passed against the codebase on the
 * morning of the audit — the string was in five files. Shape-matching is how
 * this repo has previously shipped bugs under green tests, so the handler and
 * the client action are both LOADED AND RUN here against stubs, and the
 * assertions are about what they did, not what they contain. The two that
 * matter most cannot be expressed as a string match at all:
 *
 *   - a uid in request.data must NOT redirect the revoke (self-scoped by
 *     construction — this would be a privilege-escalation hole);
 *   - when revocation FAILS the client must NOT sign the user out, because
 *     doing so tells someone mid-breach that they are safe when they are not.
 *
 * Absence assertions run against COMMENT-STRIPPED source: both files under
 * test quote the old data-action="signOut" defect verbatim while explaining
 * the fix, so a naive absence regex fails on correct files.
 *
 * Pure Node — no emulator, no firebase-admin, no functions/ deps.
 * Run: node tests/session-revocation.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

const SERVER_SRC = read('functions/handlers/auth.js');
const CLIENT_SRC = read('docs/pro/js/session-revoke.js');
const POLICY_SRC = read('functions/rate-limit-policy.js');
const DASH_SRC   = read('docs/pro/dashboard.html');
const HOWTO_SRC  = read('docs/pro/how-to.html');

// Comment-stripped views for absence assertions.
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const DASH_NC  = stripHtmlComments(DASH_SRC);
const HOWTO_NC = stripHtmlComments(HOWTO_SRC);

const TOKENS_VALID_AFTER = 'Tue, 08 Sep 2026 12:00:00 GMT';

// ═══════════════════════════════════════════════════════════════
// Server: load functions/handlers/auth.js with every require stubbed.
//
// new Function (rather than vm) keeps one realm, so an HttpsError thrown
// inside the handler is instanceof the class this file created and its
// .code survives comparison. functions/ node_modules is absent in the
// unit-suite job, which is exactly why nothing real is required here.
// ═══════════════════════════════════════════════════════════════
function loadRevokeHandler(opts) {
  opts = opts || {};
  const calls = { revoked: [], readBack: [], guard: [], errors: [] };

  class HttpsError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; }
  }

  const authStub = {
    revokeRefreshTokens: async (uid) => {
      calls.revoked.push(uid);
      if (opts.revokeThrows) throw new Error(opts.revokeThrows);
    },
    getUser: async (uid) => {
      calls.readBack.push(uid);
      if (opts.readBackThrows) throw new Error(opts.readBackThrows);
      return { uid, tokensValidAfterTime: TOKENS_VALID_AFTER };
    },
    getUserByEmail: async () => { throw new Error('getUserByEmail must not be reached'); },
    setCustomUserClaims: async () => {},
  };

  const noopLogger = {
    info: () => {}, warn: () => {},
    error: (msg, meta) => calls.errors.push({ msg, meta }),
  };

  const stubs = {
    'firebase-functions/v2/https': {
      onCall: (options, handler) => {
        const f = async (request) => handler(request);
        f.__options = options;
        return f;
      },
      HttpsError,
    },
    'firebase-functions/v2/identity': {
      beforeUserCreated: () => ({}),
      beforeUserSignedIn: () => ({}),
    },
    'firebase-functions/v2': { logger: noopLogger },
    'firebase-admin/storage': { getStorage: () => ({}) },
    'firebase-admin/firestore': {
      getFirestore: () => ({}),
      FieldValue: { serverTimestamp: () => 'ts' },
    },
    'firebase-admin/auth': { getAuth: () => authStub },
    './_shared': {
      CORS_ORIGINS: [], E2E_TEST_USER_EMAIL: 'e2e@example.com', OWNER_EMAILS: [],
      isOwnerCaller: () => false, _generateE2EPassword: () => 'pw', INVITE_ALLOWED_ROLES: [],
    },
    '../shared': { callableRateLimit: async () => {} },
    // 2026-09-25: onRepSignup's invite lookup moved into its own module.
    // Not exercised here; present so loading auth.js resolves every require.
    './invite-lookup': {
      findPendingInvite: async () => { throw new Error('findPendingInvite is not under test here'); },
    },
    '../rate-limit-policy': {
      guardCallable: (name, handler) => { calls.guard.push(name); return handler; },
    },
    // 2026-10-06 (review R3-2): cleanupE2ETestData's path confinement. Pure,
    // firebase-free, so the real module is used.
    '../lead-artifact-paths': require('../functions/lead-artifact-paths'),
  };

  const requireStub = (id) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('unstubbed require(' + id + ')');
    return stubs[id];
  };

  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'console', SERVER_SRC)(
    mod, mod.exports, requireStub, { log: () => {}, warn: () => {}, error: () => {} });
  return { fn: mod.exports.revokeMySessions, calls, HttpsError };
}

async function callAndCatch(fn, request) {
  try { return { value: await fn(request), error: null }; }
  catch (e) { return { value: null, error: e }; }
}

(async function main() {

  // ── 1. The callable exists and is wired ────────────────────────
  console.log('\nSERVER — revokeMySessions is exported and guarded');
  {
    const { fn, calls } = loadRevokeHandler();
    ok('handlers/auth.js exports revokeMySessions', typeof fn === 'function');
    ok("wrapped in guardCallable('revokeMySessions') — a missing ROUTES name would "
       + 'silently take DEFAULT_POLICY',
       calls.guard.length === 1 && calls.guard[0] === 'revokeMySessions');
    ok('enforceAppCheck is on (matches every sibling callable in this file)',
       !!fn.__options && fn.__options.enforceAppCheck === true);
    ok('functions/index.js exports it, or it is dead code',
       /exports\.revokeMySessions\s*=\s*authHandlers\.revokeMySessions/.test(read('functions/index.js')));
    // A row in FUNCTIONS_INDEX.md is mandatory for every export here — the
    // smoke job fails the build without one. Pinned locally too so the gap
    // surfaces before CI: this suite claims to gate the whole change, and it
    // missed this on the first push.
    ok('has a FUNCTIONS_INDEX.md row (mandatory for every index.js export)',
       /^\|\s*`revokeMySessions`\s*\|/m.test(read('functions/FUNCTIONS_INDEX.md')));
  }

  // ── 2. It revokes, and it revokes the RIGHT user ───────────────
  console.log('\nSERVER — revokes the CALLER, and only the caller');
  {
    const { fn, calls } = loadRevokeHandler();
    const { value, error } = await callAndCatch(fn, { auth: { uid: 'user-me' }, data: {} });
    ok('an authenticated call succeeds', !error && !!value && value.success === true);
    ok('revokeRefreshTokens was actually called (once)', calls.revoked.length === 1);
    ok("...with the CALLER's uid from the verified token", calls.revoked[0] === 'user-me');
    ok('reports the authoritative tokensValidAfterTime read back off the record',
       !!value && value.revokedAt === TOKENS_VALID_AFTER);
  }
  {
    // THE privilege-escalation guard. A callable that revoked whatever uid
    // arrived in request.data would let any signed-in user log out any other
    // user in the platform — with none of requireTeamAdmin's checks.
    const { fn, calls } = loadRevokeHandler();
    await callAndCatch(fn, {
      auth: { uid: 'user-me' },
      data: { uid: 'victim-uid', email: 'victim@example.com', targetUid: 'victim-uid' },
    });
    ok('a uid/email/targetUid in request.data CANNOT redirect the revoke',
       calls.revoked.length === 1 && calls.revoked[0] === 'user-me');
    ok('...and no lookup-by-email path is reachable from this handler',
       calls.revoked.indexOf('victim-uid') === -1);
  }
  {
    const { fn, calls } = loadRevokeHandler();
    const { value, error } = await callAndCatch(fn, { data: {} });
    ok('an unauthenticated call is rejected', !!error && error.code === 'unauthenticated');
    ok('...and revoked nothing', calls.revoked.length === 0 && value === null);
  }

  // ── 3. Failure must not be reported as success ─────────────────
  console.log('\nSERVER — a failed revoke is an ERROR, not a quiet warning');
  {
    // The sibling admin paths swallow this with logger.warn because their
    // primary action already succeeded. Here revocation IS the action: a
    // swallowed failure tells a user mid-breach that they are safe.
    const { fn, calls } = loadRevokeHandler({ revokeThrows: 'admin sdk exploded' });
    const { value, error } = await callAndCatch(fn, { auth: { uid: 'user-me' }, data: {} });
    ok('a failed revoke THROWS rather than returning', !!error);
    ok('...and never returns { success: true }', value === null);
    ok('...with an internal error code', !!error && error.code === 'internal');
    ok('...and a message that says nothing changed, so the user retries',
       !!error && /nothing changed/i.test(error.message));
    ok('...and the failure is logged at error level, not warn',
       calls.errors.length === 1);
  }
  {
    // The read-back is cosmetic; the revoke already landed. Failing the whole
    // call there would tell the user their sessions are still live when they
    // are not — the mirror image of the bug above.
    const { fn } = loadRevokeHandler({ readBackThrows: 'getUser flaked' });
    const { value, error } = await callAndCatch(fn, { auth: { uid: 'user-me' }, data: {} });
    ok('a failed READ-BACK still reports success (the revoke already landed)',
       !error && !!value && value.success === true);
    ok('...with revokedAt null rather than a fabricated timestamp',
       !!value && value.revokedAt === null);
  }

  // ── 4. Rate-limit policy ───────────────────────────────────────
  console.log('\nPOLICY — revokeMySessions has real ceilings in ROUTES');
  {
    const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE;
    const lit = POLICY_SRC.match(/const ROUTES = \{[\s\S]*?\n\};/);
    ok('ROUTES table parsed out of rate-limit-policy.js', !!lit);
    const ROUTES = lit
      ? new Function('SECOND', 'MINUTE', 'HOUR', lit[0] + '\nreturn ROUTES;')(SECOND, MINUTE, HOUR)
      : {};
    const p = ROUTES.revokeMySessions;
    ok('revokeMySessions has an entry (without one guardCallable applies '
       + 'DEFAULT_POLICY: 300/min per uid)', !!p);
    // uidLimit 0 is not "unlimited" — guardCallable SKIPS the per-uid check
    // entirely when it is 0, which is the trap this pins.
    ok('per-uid ceiling is enforced at all (uidLimit > 0)', !!p && p.uidLimit > 0);
    ok('per-uid ceiling is tight — one click is the real burst need',
       !!p && p.uidLimit <= 10 && p.uidWindow === HOUR);
    ok('per-IP backstop is enforced (ipLimit > 0)', !!p && p.ipLimit > 0);
    ok('per-IP ceiling is looser than per-uid, so a whole office rotating '
       + 'after a breach does not wedge on one NAT', !!p && p.ipLimit > p.uidLimit);
  }

  // ── 5. Client behaviour, executed ──────────────────────────────
  console.log('\nCLIENT — the button revokes first, and only then signs out');

  function loadClient(opts) {
    opts = opts || {};
    const calls = { callables: [], payloads: [], signOuts: 0, toasts: [], confirms: [], timers: [] };
    const win = {
      // Pre-set so getCallable() takes the reuse path and never evaluates the
      // dynamic import of the Firebase SDK.
      _functions: {},
      _httpsCallable: (fns, name) => {
        calls.callables.push(name);
        return async (payload) => {
          calls.payloads.push(payload);
          if (opts.callThrows) {
            const e = new Error(opts.callThrows);
            e.code = 'functions/internal';
            throw e;
          }
          return { data: { success: true, revokedAt: TOKENS_VALID_AFTER } };
        };
      },
      _signOut: () => { calls.signOuts++; },
      showToast: (msg, kind) => calls.toasts.push({ msg: String(msg), kind }),
      nbdModal: {
        confirm: async (o) => { calls.confirms.push(o); return opts.confirm !== false; },
      },
      location: { replace: () => { calls.signOuts++; } },
    };
    new Function('window', 'console', 'setTimeout', CLIENT_SRC)(
      win, { log: () => {}, warn: () => {}, error: () => {} },
      (fn, ms) => { calls.timers.push({ fn, ms }); });
    return {
      win, calls,
      run: (el) => win.__NBD_CALL_REGISTRY._signOutEverywhere(el),
      flushTimers: () => { calls.timers.splice(0).forEach((t) => t.fn()); },
    };
  }

  {
    const c = loadClient();
    ok('registers _signOutEverywhere in __NBD_CALL_REGISTRY (no global, no '
       + 'allowlist edit needed)',
       !!c.win.__NBD_CALL_REGISTRY && typeof c.win.__NBD_CALL_REGISTRY._signOutEverywhere === 'function');
  }
  {
    // Cancelling must be inert. This button logs the user out of their own
    // phone; a mis-tap that revoked anyway would be its own incident.
    const c = loadClient({ confirm: false });
    await c.run({ disabled: false, textContent: 'Sign Out Everywhere' });
    ok('declining the confirm calls NOTHING', c.calls.callables.length === 0);
    ok('...and does not sign the user out', c.calls.signOuts === 0);
  }
  {
    const c = loadClient();
    const el = { disabled: false, textContent: 'Sign Out Everywhere' };
    await c.run(el);
    ok('a confirm is shown before anything happens', c.calls.confirms.length === 1);
    const body = String(c.calls.confirms[0].body || '');
    ok('...whose body warns that the user\'s OTHER legitimate devices go too',
       /phone/i.test(body) && /tablet/i.test(body));
    ok('...and states the real refresh window instead of promising instant',
       /within an hour|an hour at most/i.test(body));
    ok('...and is styled as destructive', c.calls.confirms[0].danger === true);
    ok('calls the revokeMySessions callable', c.calls.callables.length === 1
       && c.calls.callables[0] === 'revokeMySessions');
    ok('the button is disabled while the call is in flight', el.disabled === true);
    ok('the local sign-out has NOT fired before the server confirmed',
       c.calls.signOuts === 0 && c.calls.timers.length === 1);
    c.flushTimers();
    ok('after revocation succeeds the current tab signs out too (a dead token '
       + 'would otherwise linger here)', c.calls.signOuts === 1);
  }
  {
    // THE assertion this whole file exists for.
    const c = loadClient({ callThrows: 'revoke unavailable' });
    const el = { disabled: false, textContent: 'Sign Out Everywhere' };
    await c.run(el);
    ok('when revocation FAILS the user is NOT signed out locally',
       c.calls.signOuts === 0);
    ok('...and no deferred sign-out is left scheduled', c.calls.timers.length === 0);
    const toast = c.calls.toasts.map((t) => t.msg).join(' | ');
    ok('...and an ERROR toast is shown, not a success one',
       c.calls.toasts.length === 1 && c.calls.toasts[0].kind === 'error');
    ok('...that says the other sessions are STILL ACTIVE',
       /still active/i.test(toast));
    ok('...and the button is re-enabled so the user can retry',
       el.disabled === false && el.textContent === 'Sign Out Everywhere');
  }

  // ── 6. Markup wiring ───────────────────────────────────────────
  console.log('\nMARKUP — the everywhere button is wired apart from the local one');
  {
    const btn = DASH_NC.match(/<button[^>]*>\s*Sign Out Everywhere\s*<\/button>/);
    ok('the "Sign Out Everywhere" button exists in dashboard.html', !!btn);
    ok('...dispatches _signOutEverywhere', !!btn && /data-fn="_signOutEverywhere"/.test(btn[0]));
    ok('...passes its element so it can be disabled mid-flight',
       !!btn && /data-pass-el/.test(btn[0]));
    ok('...and NO LONGER dispatches the local-only signOut action (the bug)',
       !!btn && !/data-action="signOut"/.test(btn[0]));

    // The other direction: _signOut serves the header and Danger Zone
    // buttons, which must stay LOCAL. Teaching _signOut to revoke would log
    // the user out of their phone every time they left this browser.
    const localOnes = DASH_NC.match(/data-action="signOut"/g) || [];
    ok('the two ordinary sign-out buttons still use the local action',
       localOnes.length === 2);
    ok('window._signOut itself was not turned into a revoker',
       !/revokeMySessions/.test(stripJsComments(read('docs/pro/js/dashboard-bootstrap.module.js'))));

    ok('session-revoke.js is loaded with defer (repo CSP invariant)',
       /<script defer src="js\/session-revoke\.js\?v=\d+"><\/script>/.test(DASH_NC));
    ok('no inline handler was introduced on the button',
       !!btn && !/\son[a-z]+=/i.test(btn[0]));
    ok('session-revoke.js declares no inline-script escape hatch',
       !/<script/i.test(CLIENT_SRC));
  }

  // ── 7. The help copy can finally say it ────────────────────────
  console.log('\nCOPY — /pro/how-to describes what the button now does');
  {
    ok('how-to names the actual control', /Sign Out Everywhere/.test(HOWTO_NC));
    ok('the old bare promise is gone', !/sign out of all devices/i.test(HOWTO_NC));
    // Both claim sites — the password-reset note and the Security list — must
    // carry the refresh window. Promising instant lockout would be the same
    // class of overclaim this change removed.
    const caveats = HOWTO_NC.match(/within an hour at most/g) || [];
    ok('both claim sites carry the real refresh window', caveats.length >= 2);
    ok('the password-reset note no longer implies changing the password ends '
       + 'other sessions',
       /Changing the password does not by itself end sessions/.test(HOWTO_NC));
    ok('the copy does not promise instant lockout',
       !/signs? (?:you )?out (?:of )?(?:all|every)[^.]{0,40}(?:instantly|immediately)/i.test(HOWTO_NC));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nFATAL:', e && e.stack || e); process.exit(1); });
