/**
 * scripts/grant-admin-claim.js
 *
 * Grants the Firebase Auth custom claim `role: 'admin'` to Joe.
 *
 * This is the ONLY way to become admin in the hardened app. There is no
 * access code, no URL param, no Cloud Function that can grant the admin
 * role — the hardened validateAccessCode explicitly refuses to issue it.
 * So you must run this script once, locally, using an admin SDK
 * service-account credential.
 *
 * SETUP (once):
 *   1. Firebase Console → Project Settings → Service Accounts →
 *      "Generate new private key" → download the JSON.
 *   2. Store it OUTSIDE this repo, e.g. ~/.nbd/nobigdeal-pro-sa.json.
 *   3. NEVER commit the service account JSON.
 *   4. export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *
 * RUN (dry run by default since 2026-11-17, CLAUDE.md rule f):
 *   node scripts/grant-admin-claim.js           # shows the claims before → after, writes nothing
 *   node scripts/grant-admin-claim.js --apply   # sets them
 *
 * MERGES role:'admin' into the existing claims (repo sweep 2026-11-17, L14).
 * It used to REPLACE the whole set with { role:'admin' }, dropping companyId,
 * owner and plan. The verification now also checks companyId survived.
 *
 * The script also revokes existing refresh tokens so the new claim takes
 * effect on the next sign-in. If you were signed in before running this,
 * sign out and sign in again.
 */

// firebase-admin resolution + the modular API live in scripts/_admin.js
// (scripts/ and the repo root both have no node_modules).
const { initAdmin, getAuth } = require('./_admin');

const JOE_EMAIL = 'jd@nobigdealwithjoedeal.com';

function init() {
  // initAdmin is idempotent (ADC credential by default), so the old
  // "already exists" message-matching catch is no longer needed.
  initAdmin();
}

async function main() {
  init();

  const user = await getAuth().getUserByEmail(JOE_EMAIL);
  console.log('Found user:', user.uid, user.email);

  // Read-merge-write (functions/handlers/auth.js's rule): keep every other claim.
  const before = user.customClaims || {};
  const next = Object.assign({}, before, { role: 'admin' });
  console.log('Claims:', JSON.stringify(before), '→', JSON.stringify(next));
  if (!process.argv.includes('--apply')) {
    console.log('DRY RUN: nothing written, no sessions revoked. Re-run with --apply to set it.');
    process.exit(0);
  }
  await getAuth().setCustomUserClaims(user.uid, next);
  console.log('✓ admin claim set on uid=' + user.uid);

  // Revoke existing refresh tokens so Joe's next sign-in carries the
  // updated claim. Without this, an already-signed-in tab would keep
  // the old token (no admin) until it naturally expires in ~1 hour.
  await getAuth().revokeRefreshTokens(user.uid);
  console.log('✓ existing sessions revoked — Joe must sign out + sign in again');

  // Verify by reading back the claim.
  const refreshed = await getAuth().getUser(user.uid);
  const claims = refreshed.customClaims || {};
  if (claims.role !== 'admin') {
    console.error('✗ verification FAILED — custom claim not set. Aborting.');
    process.exit(1);
  }
  if ((before.companyId || null) !== (claims.companyId || null)) {
    console.error('✗ verification FAILED — companyId changed (' + before.companyId + ' → ' + claims.companyId + '). Restore it before signing in.');
    process.exit(1);
  }
  console.log('✓ verified claims =', JSON.stringify(claims));
  console.log('\nDone. Open /admin/vault.html after signing in.');
  process.exit(0);
}

main().catch(e => {
  console.error('FAILED:', e.message || e);
  console.error(e.stack);
  process.exit(1);
});
