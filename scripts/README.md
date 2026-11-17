# scripts/ — operational one-shots

These are NOT deployed as Cloud Functions. They run locally against the
Firebase Admin SDK using a service account key stored on your laptop.

Every script is idempotent — safe to re-run.

## Prerequisites (once)

1. Install Node 22+.
2. Firebase Console → Project Settings → Service Accounts → "Generate
   new private key". Download the JSON.
3. Store it OUTSIDE this repo, e.g. `~/.nbd/nobigdeal-pro-sa.json`.
   **NEVER commit a service account key to git.**
4. In each shell where you run a script:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
   ```
5. Install the Admin SDK. The easiest way:
   ```bash
   cd functions && npm install  # installs firebase-admin for Cloud Functions
   cd ..
   ```
   Then run the scripts from the repo root — they'll find `firebase-admin`
   under `functions/node_modules/`. Or install globally:
   ```bash
   npm install -g firebase-admin
   ```

## `scripts/grant-admin-claim.js`

Sets the Firebase Auth custom claim `role: 'admin'` on
`jd@nobigdealwithjoedeal.com`. This is the ONLY way to become admin in
the hardened app — there's no access code, no Cloud Function, no URL
param that can grant admin. Also revokes existing refresh tokens so the
new claim takes effect on next sign-in.

```bash
node scripts/grant-admin-claim.js           # dry run: claims before → after, writes nothing
node scripts/grant-admin-claim.js --apply   # sets it
```

It merges `role: 'admin'` into the existing claims (companyId, owner and plan
are kept) and fails its check if companyId changed (2026-11-17).

Run AFTER `firebase deploy --only firestore:rules` has shipped the new
rules. Joe must sign out + sign in again to pick up the new token.

## `scripts/seed-access-codes.js`

Mints random beta / demo invite codes into the `access_codes` collection
that the hardened `validateAccessCode` Cloud Function reads, deactivates the
legacy hardcoded codes, and prints the new codes once.

```bash
BETA_COUNT=10 DEMO_COUNT=3 node scripts/seed-access-codes.js           # dry run: the plan, writes nothing
BETA_COUNT=10 DEMO_COUNT=3 node scripts/seed-access-codes.js --apply   # writes + prints the codes once
```

It leaves the public `DEMO` code (the /pro login "Launch Demo Dashboard"
button) alone; that one is managed by `scripts/seed-demo-access.js`
(`--apply` to write). No code grants the admin role — admin is claims-only.

## `scripts/delete-compromised-users.js`

Deletes 4 Firebase Auth users created by the pre-audit `validateAccessCode`
with deterministic email-derived passwords. Anyone who reverse-engineered
the old function can still sign in as these users using the leaked
password formula until the accounts themselves are gone.

```bash
node scripts/delete-compromised-users.js
```

Run AFTER `scripts/seed-access-codes.js` so the hardened Cloud Function
can recreate them on demand with secure random passwords.

## `scripts/deploy.sh`

The ordered `firebase deploy` sequence. Run from the repo root after
everything else in `GO_LIVE.md` steps 1–4 is done.

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

Deploys in this order: Firestore rules → Storage rules → Cloud Functions
→ Hosting → marketing-project Firestore rules.

## `scripts/bootstrap.sh` — the one-shot go-live

Chains every local step for a first-time deploy:
1. Prompts you to confirm App Check + reCAPTCHA site key are set
2. Rotates all shared secrets (calls rotate-secrets.sh)
3. Grants admin custom claim
4. Seeds access_codes
5. Deletes compromised users
6. Runs firebase deploy
7. Runs the post-deploy smoke tests

Every step is interactive and re-runnable. You can answer "skip" to any
stage you've already done.

```bash
./scripts/bootstrap.sh
```

## `scripts/rotate-secrets.sh` — interactive secret rotation

Walks through every Firebase Cloud Functions secret the hardened code
needs (Anthropic, Stripe, Stripe webhook, Stripe prices, Twilio, Resend,
Joe notification targets). For each one: opens the relevant vendor URL
in your default browser, waits for you to paste the new value, pushes it
to Firebase with `firebase functions:secrets:set`.

Hit ENTER without typing anything to skip a secret you already rotated.

```bash
./scripts/rotate-secrets.sh
```

## `scripts/verify-deploy.sh` — post-deploy smoke tests

Runs the attack-payload curls from the security audit against the live
site. Every test should FAIL (return 4xx). If any test succeeds, the
site still has a hole — the script exits non-zero and tells you which.

Safe to run anytime, read-only probes.

```bash
./scripts/verify-deploy.sh
```

## Auto-deploy via GitHub Actions

There's a `.github/workflows/firebase-deploy.yml` workflow that runs
`firebase deploy` automatically on every push to `main`. To enable it:

1. Firebase Console → Project Settings → Service Accounts →
   "Generate new private key" → download the JSON.
2. GitHub repo → Settings → Secrets and variables → Actions →
   "New repository secret":
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: paste the ENTIRE JSON file contents
3. Delete the JSON from your laptop — it's in GitHub Secrets now.
4. Push to main (or manually trigger the workflow in the Actions tab).

Once the secret is set, you never have to run `./scripts/deploy.sh`
by hand again. Every `git push` to main triggers the deploy.

You can also trigger a deploy without a push:
GitHub → Actions → "Firebase deploy" → "Run workflow".
