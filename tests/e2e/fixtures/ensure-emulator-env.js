// @ts-check
// Write the emulator-only functions env overrides before emulators:exec.
//
// functions/.env.local is loaded by the Functions emulator for BOTH trigger
// discovery and the call-time runtime — and is IGNORED by deploys, which is
// exactly the scope we need. Process-env prefixes on the npm script are NOT
// enough: firebase-tools runs trigger discovery with the functions dir's
// dotenv files, so an env var set only on the CLI process produces a mixed
// state (trigger registered at discovery, handler missing at call time —
// signups die on a 500 from the half-registered onRepSignup blocking
// trigger).
//
// The file is gitignored (root .gitignore), so this script (re)creates it on
// every rig boot. Idempotent: an existing developer-authored .env.local is
// preserved — only the managed block between the markers is rewritten.
//
// Why NBD_DEPLOY_SKIP_LIST=onRepSignup: the deploy workflow excludes
// onRepSignup (GCIP-blocked beforeUserCreated trigger) from every prod
// deploy, so prod NEVER runs it. functions/index.js honors the same
// variable at code time so the emulator doesn't run a trigger production
// cannot ship (it would pre-empt the claimInvite path the product uses).

const fs = require('fs');
const path = require('path');

const ENV_LOCAL = path.join(__dirname, '..', '..', '..', 'functions', '.env.local');
const BEGIN = '# --- managed by tests/e2e/fixtures/ensure-emulator-env.js (do not edit block) ---';
const END = '# --- end managed block ---';
// TURNSTILE_REQUIRED=false: prod's tracked functions/.env.nobigdeal-pro sets it
// true (an unset secret fails CLOSED). The authed rig emulates --project
// nobigdeal-pro, so firebase-tools loads that file into the emulated
// functions, which have no TURNSTILE_SECRET: every tokenless public lead
// would 403 'turnstile-required'. .env.local loads LAST and only for
// emulators, so this override never reaches a deploy.
const BLOCK = `${BEGIN}
NBD_DEPLOY_SKIP_LIST=onRepSignup
TURNSTILE_REQUIRED=false
${END}`;

let existing = '';
try { existing = fs.readFileSync(ENV_LOCAL, 'utf8'); } catch (_) { /* absent — fresh rig */ }

let next;
if (existing.includes(BEGIN) && existing.includes(END)) {
  next = existing.replace(
    existing.slice(existing.indexOf(BEGIN), existing.indexOf(END) + END.length),
    BLOCK
  );
} else {
  next = existing ? existing.replace(/\n*$/, '\n\n') + BLOCK + '\n' : BLOCK + '\n';
}

if (next !== existing) {
  fs.writeFileSync(ENV_LOCAL, next);
  console.log(`[ensure-emulator-env] wrote managed block to ${ENV_LOCAL}`);
} else {
  console.log('[ensure-emulator-env] managed block already current');
}
