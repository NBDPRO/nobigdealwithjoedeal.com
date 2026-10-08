# E2E Smoke Tests (Playwright)

Fast, unauthenticated smoke tests that run against the live production site (default) or a local `firebase serve` target. Designed to catch whole-app regressions — a bad Pages deploy, a blank-page JS crash, a broken CTA — without needing test credentials.

## First-time setup

```bash
cd tests
npm install                  # adds @playwright/test
npm run test:e2e:install     # downloads chromium browser (~180MB, one time)
```

## Run

```bash
# Against live production
npm run test:e2e

# Against a local firebase serve on :5000
PLAYWRIGHT_BASE_URL=http://localhost:5000 npm run test:e2e

# Headed (watch a real browser)
npm run test:e2e:headed

# Just the pricing tests
npx playwright test --grep "pricing"
```

## Scope

**Public (no auth)** — runs in CI by default:
- `pro-public.spec.js` — /pro/login.html, /pro/pricing.html, /pro/instant-estimate.html
- `marketing.spec.js` — homepage, privacy, robots.txt

**Authed (test user)** — opt-in via env vars (BIG_ROCKS Rock 3 PR 1):
- `pro-authed.spec.js` — login → dashboard kanban renders, auth state survives reload

Run separately:
```bash
npm run test:e2e:public   # public-only, no creds needed
npm run test:e2e:authed   # authed-only, skips if creds missing
npm run test:e2e          # everything; authed suite skips cleanly w/o creds
```

## Authed suite — Path B: hermetic emulator mode (preferred)

No secrets, no prod traffic. `emulators:exec` boots the Auth + Firestore +
Hosting emulators, `e2e/fixtures/seed-emulator.js` provisions a known tenant
(user + companies/companyProfile/subscriptions docs + companyId claim,
mirroring what `createCompany` writes), and the suite runs against
`http://127.0.0.1:5000` — where `nbd-emulator-connect.js` makes every page's
client SDK talk to the emulators automatically:

```bash
cd tests
npm run test:e2e:authed:emu
```

Cleanup is skipped in this mode (state dies with the emulators). CI runs this
in the `e2e-authed-emulator` job (all five shards blocking since 2026-07-28;
see the promotion note in ci.yml).

Sandboxed environments: if the pinned Playwright browser isn't installable,
set `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium`; behind an egress proxy set
`PLAYWRIGHT_PROXY_SERVER=$HTTPS_PROXY` (never against production — it implies
ignoreHTTPSErrors). Note the pages load the Firebase SDK from
`www.gstatic.com`, so that host must be reachable.

## Authed suite — Path A test-user provisioning (live prod)

We hit live production with a dedicated test user. Path B above is the safer
default; Path A additionally exercises the real deploy + real functions.
Only read journeys land in PR 1
(login + auth-persistence). Destructive journeys (save lead, move
stage, send invoice) come in a later PR with proper cleanup.

### Joe's runbook — first-time setup

1. **Create the test user via the live registration flow:**
   - Go to <https://nobigdealwithjoedeal.com/pro/register.html>
   - Email: `playwright-e2e@nobigdealwithjoedeal.com` (or any address you control)
   - Password: a strong unique password (use a password manager)
   - Complete registration with the lowest-tier plan
2. **Tag the user in Firestore** so leaderboards/analytics can filter
   it out:
   - Firebase Console → Firestore → `users/{uid}`
   - Add field `e2eTestAccount: true`
   - (Optional) Set `companyId` to a sandbox value if you have one
3. **Set GitHub Actions secrets:**
   ```
   PLAYWRIGHT_TEST_USER_EMAIL     = playwright-e2e@nobigdealwithjoedeal.com
   PLAYWRIGHT_TEST_USER_PASSWORD  = (the password)
   ```
4. **Local run** (pull secrets into your shell first):
   ```bash
   export PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nobigdealwithjoedeal.com
   export PLAYWRIGHT_TEST_USER_PASSWORD=...
   cd tests && npm run test:e2e:authed
   ```

### Safety guarantees

- The auth fixture reads creds via env vars only — never committed
- `pro-authed.spec.js` skips silently when env vars are missing, so
  running `npm test` locally without secrets stays clean
- Destructive journeys (Rock 3 PR 4) tag every Firestore doc they
  create with `e2eTestData: true` and prefix names with `[E2E]`.
  An `afterAll` hook calls the `cleanupE2ETestData` callable, which
  deletes ONLY docs tagged `e2eTestData: true` belonging to the
  test user — guarded both by Firestore query (`where('userId',
  '==', uid)`) and a function-level check that the caller's user
  doc has `e2eTestAccount: true`. A real human running cleanup on
  themselves would delete nothing.
- The cleanup callable also walks subcollections (activity, notes,
  documents) before deleting the parent so children never orphan.

### If a destructive test crashes mid-run

The `afterAll` runs even after a failed test. Worst case (CI killed
before afterAll fires): manually invoke the callable from DevTools:

```js
const m = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
const f = m['httpsCallable'](m['getFunctions'](),'cleanupE2ETestData');
console.log((await f()).data);
```

Or filter the kanban by `[E2E]` and delete by hand — the prefix
makes them visually obvious.

### Provisioning the test user (one-shot, owner-only)

Don't manually register + edit Firestore. There's a callable for that:

```js
const m = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
const f = m['httpsCallable'](m['getFunctions'](),'provisionE2ETestUser');
const r = await f();
alert(JSON.stringify(r));   // shows email + password ONCE
```

The callable creates the auth user, sets `e2eTestAccount: true`,
and rotates the password if the user already exists. Capture the
password, set it as the GitHub Secret, done.

## The Stranger Test (`stranger.spec.js`, `@stranger` shard)

The full second-contractor lifecycle against the FULL emulator rig —
functions included. Set `NBD_EMU_FUNCTIONS=1` to add the Functions
emulator to the `test:e2e:authed:emu` `--only` list; the `@stranger` CI
shard sets it, the legacy shards deliberately do NOT (the ~140-function
runtime slows dashboard settle enough to widen the documented 301-hop
"execution context destroyed" race those shards were tuned against):

register → `createCompany` → onboarding completed for real → dashboard
unwalled on the free plan → save a lead → the tenant microsite
(`/sites/t/<uid>`) renders their brand via `getPublicSiteConfig` → a
homeowner quote-form submission routes through `submitPublicLead` +
`leadBridgeContact` into THEIR pipeline → free-plan invites are
seat-gated → an (admin-stand-in) upgraded tenant invites a rep →
the rep registers, verifies, and `claimInvite` re-points their claims
and supersedes their solo tenant → cross-tenant lead reads are denied
both directions.

Notes:

- `fixtures/ensure-emulator-env.js` runs before `emulators:exec` and writes
  a managed block to `functions/.env.local` (gitignored, emulator-only)
  setting `NBD_DEPLOY_SKIP_LIST=onRepSignup` — the GCIP-blocked blocking
  trigger prod never deploys must also no-op in the rig, or it stamps rep
  claims at signup and pre-empts the claimInvite path the product ships.
  The skip lives INSIDE the handler (functions/handlers/auth.js): trigger
  discovery runs with a scrubbed env, so export-gating half-registers the
  blocking trigger and 500s every signup.
- Enforced callables (`createCompany`, `claimInvite`, `createTeamInvite`)
  keep `enforceAppCheck: true` in the rig — the localhost-only CustomProvider
  shim in `docs/pro/js/nbd-emulator-connect.js` mints a decodable JWT that
  the emulator's always-on `skipTokenVerification` accepts. Look for
  `"verifications":{"app":"VALID","auth":"VALID"}` in the emulator log.
- Two admin-SDK nudges stand in for what a real flow gets from outside the
  browser: the rep's email verification (we can't click the link) and the
  plan upgrade (Stripe hosted checkout can't be emulated).
- Sandboxed agent containers (egress-policied) need three env escape
  hatches that are all no-ops in GitHub CI: `PLAYWRIGHT_CHROMIUM_PATH`,
  `PLAYWRIGHT_PROXY_SERVER`, and `NBD_E2E_SDK_LOCAL_DIR` (serves the
  gstatic Firebase SDK bundles from a local `firebase` npm package via
  route interception — see `fixtures/local-sdk.js`).
