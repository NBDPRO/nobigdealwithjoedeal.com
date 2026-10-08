# Deploy verification — is production serving main?

*Written 2026-10-04. Code: [`scripts/verify-live-deploy.js`](../../scripts/verify-live-deploy.js),
the `verify-live` job at the end of `.github/workflows/firebase-deploy.yml`,
test `tests/deploy-verify-2026-10-04.test.js`. Companion:
[MERGE-QUEUE](MERGE-QUEUE.md).*

## What it does

1. The deploy job writes `docs/version.json` on the runner just before
   *Deploy Hosting* (never committed — gitignored):
   `{"sha":"<40-hex>","short":"…","ref":"refs/heads/main","run":"<run id>","deployedAt":"…"}`.
   It is served at `https://nobigdealwithjoedeal.com/version.json`.
2. After a **successful** deploy, `verify-live`:
   - polls `/version.json` for up to 3 minutes until it shows this run's
     commit or a newer one — proof the hosting release **landed**;
   - fetches `origin/main` and diffs `live..main` over the workflow's own
     `on.push.paths` list (`docs/**`, `functions/**`, rules, indexes,
     `firebase.json`, the workflow). An empty diff means main only moved
     under `scripts/**` / `documentation/**` — **nothing to deploy**, green;
   - on real drift: if another run of the deploy workflow is queued or
     running, that run will ship main — green. Otherwise it dispatches the
     workflow **once** with `scope=all reconcile=true`;
   - a `reconcile=true` run that still finds drift **fails red** with the
     reason, and never dispatches again.

## Why

`firebase-deploy.yml` uses `concurrency: firebase-deploy` with
`cancel-in-progress: false`: GitHub keeps one pending run and cancels older
pending ones, so a burst of merges leaves only the newest. That is fine *if*
the survivor deploys — nothing proved it. And the `paths:` filter means main's
HEAD is routinely ahead of what is live on purpose, so "HEAD != live" by
itself is noise. This check knows the difference.

## When it goes red

| Message | Meaning | Do |
|---|---|---|
| `Hosting deploy reported success but …/version.json serves X` | Hosting step exited 0 but the site does not serve the commit | `firebase hosting:channel:list`, check the release in the console; re-run the workflow |
| `Live site is behind main: … this IS the reconcile run` | A re-dispatched deploy still did not bring live up to main | Read the reconcile run's deploy job; usually a real deploy failure the first run hit too |
| `verify-live-deploy crashed` | Script error (network, git) | Re-run the job; if persistent, read the stack |

## By hand

```
curl -s https://nobigdealwithjoedeal.com/version.json
git fetch origin main && git log --oneline -1 origin/main
# deploy-relevant drift since live:
git diff --name-only <live-sha> origin/main -- docs/ functions/ firestore.rules firestore.indexes.json storage.rules firebase.json .github/workflows/firebase-deploy.yml
```

Not covered: a `workflow_dispatch` with `scope=functions` or `scope=rules`
does not restamp hosting (it did not deploy hosting), so `verify-live` there
only compares live vs main. Functions-fleet drift has its own guard
(`scripts/check-function-orphans.js`, the *Fleet must match the code* step).
