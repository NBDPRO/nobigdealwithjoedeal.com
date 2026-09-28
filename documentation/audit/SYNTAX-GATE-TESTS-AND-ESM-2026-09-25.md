# Syntax gate: tests/ coverage, and the module-file hole (2026-09-25)

Branch `ci/syntax-gate-e2e-specs`. Script: `scripts/check-js-syntax.js`
(the `Node syntax check` job in ci.yml, one of the 7 required checks on main).

## Why this was opened

A PR whose merge with main left `Identifier 'devices' has already been
declared` in `tests/e2e/phone-views.spec.js` passed every Node gate. Two causes:

1. `check-js-syntax.js` parsed `functions/` and `docs/` only. Nothing parsed
   `tests/**`, so only the E2E shard would have caught it, minutes into a run,
   after it had landed on main.
2. GitHub reported the PR CLEAN because branch protection on main has
   `strict: false` ("Require branches to be up to date before merging" is off;
   read from the API 2026-09-25). A PR's checks describe its merge ref as it
   was when CI ran. A newer main can combine with it into a broken tree, and
   nothing re-checks that tree.

## What recon found: the gate never parsed module files

`node --check <file>` on a `.js` with no `"type"` in scope exits 0 **without
parsing it** when the file contains `import`/`export`. Node has turned
module-syntax detection on by default since 22.7, and `--check` treats "this
looks like a module" as a pass. The script relied on that call for its
CommonJS pass, so its ES-module retry never ran for the 47 shipped files that
use top-level `import`/`export`: the `docs/pro/js/*.module.js` bootstraps,
`nbd-auth.js`, `docs/admin/js/pages/*` and others.

- Reproduced on Node 24.14 and 26.3: with `const = ;` appended to
  `docs/pro/js/nbd-auth.js`, the old script printed "527 files parsed
  cleanly" and exited 0.
- CI runs Node 22.23.2. That version was not reproduced here because no
  Node 22 is installed on this machine. It has the same detection default.

**Main was clean.** Commit 4ede37e7 was parsed with explicit grammars across
all 868 files: 821 parse as CommonJS, 47 only as ES modules, and 0 as neither.
The hole hid no real error.

## What changed

- **Explicit grammars.** Both parses go through stdin with
  `--input-type=commonjs` and then `--input-type=module`. Detection never
  applies to either. Node's `[stdin]` label is replaced with the repo-relative
  path, so a failure reads `path/file.js:LINE`. When a module file fails both
  grammars, the ES-module error is printed, because it names the real defect.
  The CommonJS error would only say "Cannot use import statement".
- **Self-test before every scan.** A CommonJS sample and an ES-module sample,
  each with a duplicate declaration, must be rejected at the right file and
  line. A clean sample of each must pass. If any of this fails, the gate exits 1
  and names the Node version.
- **`tests/**` is in scope**: 341 files covering specs, e2e fixtures, unit
  suites and helpers. `test-results`, `playwright-report` and `blob-report`
  are excluded. `EXCLUDED` now matches whole path segments. For `functions/`
  and `docs/` that selects exactly the tracked files the old substring test
  selected.
- **Every root must contribute at least one file**, so a renamed root cannot
  silently drop out of the gate.
- **`--shipped-only`** limits the scan to `functions/` and `docs/`.
  `firebase-deploy.yml` uses it in its pre-Hosting gate: a spec that doesn't
  parse must turn CI red, but it must not block a deploy of code that parses.
  ci.yml runs the full scope. `tests/smoke/functions.test.js` §E2 and §E2b pin
  both of these.

## Break-tests (each file restored byte-for-byte, checked by sha256)

| Break | Result |
|---|---|
| `const = ;` appended to `docs/pro/js/nbd-auth.js`, **old** script | "527 files parsed cleanly", exit 0 (the hole) |
| same break, new script | `docs/pro/js/nbd-auth.js:1022` Unexpected token '=', exit 1 |
| duplicate `const { devices } = require('@playwright/test');` inserted as line 41 of `tests/e2e/phone-views.spec.js` | `tests/e2e/phone-views.spec.js:41` Identifier 'devices' has already been declared, "1 of 868", exit 1. `--shipped-only`: exit 0, as designed |
| parser stubbed to always succeed | self-test reports both duplicate samples as "a clean parse", exit 1 |
| `TEST_ROOTS` pointed at a missing directory | "found no .js files under test", exit 1 |
| `--shipped-only` added to ci.yml's `run:` line | smoke fails only "CI syntax pass runs the full scope…" |
| `TEST_ROOTS` emptied | smoke fails only "the syntax checker parses tests/ unless --shipped-only" |

## Timings

- CI before: 4.8 s for 527 files (run 36203262113, Node 22.23.2).
- Locally, on a 16-core machine loaded by parallel sessions:
  - old script: 5.6–6.0 s for 527 files
  - new, full scope: 8.9–9.2 s for 868 files
  - new, `--shipped-only`: 4.8–6.2 s for 527 files
- The job's cap is 10 minutes.

## Still open

- **Recommendation, not applied:** enable "Require branches to be up to date
  before merging" (or a merge queue) on main. This is Jo's decision, because
  every PR would then need a rebase and a CI re-run whenever main moves.
  Without it, two green PRs can still combine into a spec that doesn't parse.
  After this change, main's push CI goes red on the syntax job in seconds,
  instead of minutes into an E2E shard.
- `scripts/**` is still not parsed. That is by design: CI executes those
  scripts, which covers them.
