# Merge queue — how `main` lands changes

*Written 2026-10-04. The queue is **live**: the repo moved to the
`NBDPRO` organization the same day (merge queues need an org-owned repo) and
the coordinator enabled ruleset **"main merge queue (2026-10-04)"**
(id 24456328). Companion: [DEPLOY-VERIFICATION](DEPLOY-VERIFICATION.md),
[INDEX](../INDEX.md).*

## Why

`main`'s classic protection was `strict: false`: a PR went green against the
main it branched from, not the main it landed on. Hand-run merge chains
produced a clean text merge with a SyntaxError nobody parsed, cancelled queued
deploys, and lost E2E specs from the one-line spec list (now
`tests/e2e/authed-specs.txt`, one spec per line, so parallel PRs no longer
collide there). The queue re-tests each PR on top of main + the PRs ahead of
it, then merges in order.

## Live configuration (read 2026-10-04)

```
gh api repos/NBDPRO/nobigdealwithjoedeal.com/rulesets/24456328 \
  --jq '{name, enforcement, rules: [.rules[] | {type, parameters}]}'
```

`merge_queue`: SQUASH, ALLGREEN grouping, build/merge up to 3 entries,
1-minute wait, 60-minute check timeout. `required_status_checks`
(GitHub Actions, integration 15368), strict off — the queue itself supplies
"tested on the latest main":

```json
{
  "required_status_checks": [
    { "context": "Smoke tests" },
    { "context": "Unit suites (manifest)" },
    { "context": "Site integrity" },
    { "context": "Node syntax check" },
    { "context": "Secret scan" },
    { "context": "Firestore rules tests" },
    { "context": "Functions parse + dep install" },
    { "context": "Authed E2E (emulators, @shard1)" },
    { "context": "Authed E2E (emulators, @engines)" },
    { "context": "Authed E2E (emulators, @audit)" },
    { "context": "Authed E2E (emulators, @gauntlet)" },
    { "context": "Authed E2E (emulators, @stranger)" },
    { "context": "Public-surface E2E (hosting emulator)" },
    { "context": "Visual regression (public pro pages)" },
    { "context": "E-sign suites (Chromium)" },
    { "context": "Referral trigger tests" }
  ]
}
```

**Noted, not changed:** `Authed E2E (emulators, @shard2)` is the one matrix
shard *not* in the list, although `ci.yml` has documented all six shards as
required since 2026-07-28. If that omission was not deliberate, add it:

```
gh api repos/NBDPRO/nobigdealwithjoedeal.com/rulesets/24456328 > ruleset.json
# add { "context": "Authed E2E (emulators, @shard2)", "integration_id": 15368 } to
# rules[type=required_status_checks].parameters.required_status_checks, then:
gh api -X PUT repos/NBDPRO/nobigdealwithjoedeal.com/rulesets/24456328 --input ruleset.json
```

The classic branch protection still lists the original seven contexts; the
ruleset is a superset, so the two agree.

## What keeps the queue from wedging

A required check that never reports on `merge_group` leaves the queue waiting
until the 60-minute timeout and then ejects the PR. `ci.yml` runs on
`merge_group`, and `tests/merge-queue-ready-2026-10-04.test.js` fails CI if:

- `ci.yml` loses its `merge_group` trigger;
- any job or step gains an `if:` keyed on `github.event_name` /
  `pull_request` context (it would SKIP on `merge_group`, and a skipped
  required check is not a pass);
- a context in the JSON block above is not a check name `ci.yml` actually
  produces (a renamed job would block every merge). **When a required job is
  renamed, update the ruleset and this block in the same PR.**

## Day to day

`gh pr merge <n> --squash` adds a green PR to the queue (`--auto` waits for
its checks first). Do not hand-merge around the queue. Merges still reach
`main` as separate pushes, and `firebase-deploy.yml` keeps one pending run;
the deploy's `verify-live` job proves the surviving run shipped main
(see [DEPLOY-VERIFICATION](DEPLOY-VERIFICATION.md)).
