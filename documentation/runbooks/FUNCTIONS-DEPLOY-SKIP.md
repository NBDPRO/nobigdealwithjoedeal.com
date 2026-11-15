# Functions deploy skip (2026-11-14)

A push to `main` used to redeploy all ~340 Cloud Functions every time (the strict step's export grep finds 339;
the strict step took 16m23s in run 43634215715), even for a one-page change. Now a push **skips the functions deploy** when nothing that can change
the deployed functions has changed since the last successful functions deploy. All functions or none: it
never deploys "only the changed functions", because shared modules (`index.js`, `ai-gate.js`, helpers) fan out.

Code: [scripts/functions-deploy-decision.js](../../scripts/functions-deploy-decision.js), called by the
`functions_plan` job in [firebase-deploy.yml](../../.github/workflows/firebase-deploy.yml). Tests:
`tests/functions-deploy-decision-2026-11-14.test.js` and the "functions skip" section of
`tests/scheduled-deploy-2026-11-09.test.js`. Related: [DEPLOY-VERIFICATION](DEPLOY-VERIFICATION.md).

## How the skip works

1. The `functions_plan` job (no secrets, read-only token) looks at this workflow's recent run history and
   finds the run whose **Deploy Cloud Functions (strict …)** step *started* most recently. That is what
   production functions last saw.
2. That run's commit is the comparison base only if the step **succeeded**, the run was **on main**, and the
   commit is an **ancestor** of the commit being deployed. It is *not* `github.event.before`: the concurrency
   group replaces pending runs, so pushes in between may never have deployed.
3. It diffs base..this commit (`git diff --no-renames`). Function inputs are:
   - everything under `functions/` (code, `package.json`, `package-lock.json`, `functions/.env.*`, data, assets)
   - `firebase.json`, except edits that only touch its `hosting` block
   - `.firebaserc`, `.github/workflows/firebase-deploy.yml`, `scripts/functions-deploy-decision.js`
4. Any function input changed → deploy everything. None changed → skip.
5. **Any doubt deploys**: no functions deploy in the last 35 days of runs (or more than 2000 runs to read), the last attempt failed / was cancelled /
   timed out, it came from a branch, the base is not an ancestor, git or the API errors, or the plan job
   itself fails (the deploy steps skip only on an explicit `false`).

Skipped on a push: *Ensure integration secrets exist*, the strict deploy and the tolerant retry.
Still run on every push: hosting, the rules test gate and all rules deploys, *Enable required Google APIs*,
the function smoke gate and the fleet/orphan check; `verify-live` still runs after every successful deploy. The weekly schedule and scope=hosting /
scope=rules dispatches still never deploy functions.

## How to force a full functions deploy

Any of these always deploys every function, whatever the marker says (each one deploys to production, so
only with Joe's OK):

```bash
gh workflow run firebase-deploy.yml --ref main -f scope=functions
```

```bash
gh workflow run firebase-deploy.yml --ref main -f scope=all
```

- `force_functions: true` adds functions to any scope (Actions tab → Firebase deploy → Run workflow).
- **Off switch**: set the repository variable `NBD_FUNCTIONS_SKIP` to `0` (Settings → Secrets and
  variables → Actions → Variables). Every push then deploys functions again, no revert needed. Unset or any
  other value = skip on.

**You must force one after:**
- **rotating a secret** — a function binds a secret version only at deploy time ([SECRET_ROTATION](SECRET_ROTATION.md));
- a **manual `firebase deploy --only functions`** from a laptop, or any console edit to a function — the
  run history cannot see those;
- upgrading the project to Identity Platform (GCIP), so `onRepSignup` can register.

## How to tell from a run whether functions deployed

- The run summary has a **Cloud Functions: skipped** or **Cloud Functions: will deploy** block from the
  *Decide whether Cloud Functions deploy* job: `functions skipped: no function inputs changed since <sha>` or
  `functions deployed: <reason>`, with the changed input paths listed.
- The *Firebase deploy complete* table shows `Cloud Functions | deployed` or `skipped: <reason>`.
- In the job log the strict step is shown as skipped. From a terminal:

```bash
gh run view <RUN_ID> --json jobs --jq '.jobs[] | select(.name=="Deploy to Firebase") | .steps[] | select(.name|startswith("Deploy Cloud Functions")) | "\(.name): \(.conclusion)"'
```

## If live functions are ever behind main

1. The plan job's summary on the latest push run names the base ("since <sha>", run id). Or run the script
   read-only yourself (it only reads the Actions API and git, writes nothing, deploys nothing):
   `EVENT_NAME=push HEAD_SHA=$(git rev-parse origin/main) RUN_ID=0 GITHUB_REPOSITORY=NBDPRO/nobigdealwithjoedeal.com node scripts/functions-deploy-decision.js`
   Then compare that commit with `main`:
   `git diff --name-only <that sha> origin/main -- functions firebase.json .firebaserc .github/workflows/firebase-deploy.yml scripts/functions-deploy-decision.js`.
2. Dispatch `scope=functions` (above) and watch the strict step go green; the fleet check runs after it.
3. For a new function, confirm it exists: `gcloud functions describe <NAME> --gen2 --region=us-central1`.
4. If the skip itself was wrong, set `NBD_FUNCTIONS_SKIP=0` first so the next pushes deploy too, then fix the
   input list in the script (with a test) before turning it back on.

## What it cannot see

Manual deploys, console edits, secret rotations, and a new `firebase-tools` release (`npx firebase-tools` is
not pinned) do not show in the git diff. Renaming the strict step or the *Deploy to Firebase* job makes the
marker unfindable, which deploys every time (safe, slow) until `STRICT_STEP_NAME` / `DEPLOY_JOB_NAME` in the
script follow; the unit test pins both names.
