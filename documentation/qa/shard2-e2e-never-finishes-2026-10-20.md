# Authed E2E @shard2 never finishes — 2026-10-20

`Authed E2E (emulators, @shard2)` (not one of the 7 required checks) was cancelled at its
25-minute cap on every main commit back to at least 2026-10-16. Reproduced locally against
the emulators (Firestore/Auth/Storage moved to other ports because another session held 9099/9199).

## Findings

| Spec | Root cause | Kind | Fixed |
|---|---|---|---|
| `bento-board` :62 | Wait passed on the browser's own pending write (getDoc overlays it); the Admin read ran ~300 ms before the server had the doc. A later `saveCompany` could also write without `defaultWidgets` | test race | yes: wait for the server copy, then for the engine's company state |
| `bento-board`, `inbox-layout` | `_saveLead` can throw ALREADY_EXISTS for a create the SDK replayed; the spec died on it | test race (the crew spec already tolerated it) | yes: take the id from the error |
| `crew-calendar` :26 | `safeEvaluate` re-runs the whole seed when a navigation destroys the page; `addDoc` left a second Alpha/Bravo. Lanes merge same-named crews, so the drop aimed at the second id's lane found no cell ("drag did not move the job") | test non-idempotent seed | yes: fixed doc ids via `setDoc` |
| `crew-calendar` | Drop cell measured before the strips above the grid finished loading; drop cell `boundingBox()` null after a repaint | test race | yes: re-measure, re-aim before release |
| `inbox-layout` :81 / :189 | (1) seed read `_userClaims` before the claims arrived, wrote `companyId: null`; the thread (scoped by companyId for a company admin) showed no texts. (2) `.ib-thread-head` click at its centre lands on the new **Record visit** button, opening a mic modal that blocks the page: the 240 s `click` timeout in CI | test race + a UI change the spec did not follow | yes: wait for claims; click the head's corner |

Local evidence (single spec, emulators): bento 12/12 green after fixes (about 40 % red before);
crew-calendar about 39/40 (about 65 % red before); inbox-layout 8/8 (both tests; 0/6 before).

## Not fixed / not reproduced

- `call-center-view` :178 (`num:5135550177` still has 1 after Handled): green alone and after
  `call-center-card` three times, red inside a full-shard run. Not root-caused.
- A possible product bug: the inbox thread is cached per person at first load, so a thread opened
  before the calls feed arrives lacks the text-day note (seen as the spec's line-119 style miss
  while probing). Not changed.
- `crew-calendar` still misses a drag about once in 40 runs.

## Why it can never finish: the shard is too big

`@shard2` is 352 tests on 1 worker (91 spec files). Full local runs: 36.3 min (19 failed,
30 not run, 303 passed) and 42.2 min (29 failed, 38 not run, 285 passed). Even the passing tests
average about 8-9 per minute, so a clean run is ~40 min against a 25 min cap. The failures in the
two full runs were different sets each time (a "rotating victim" pattern, which ci.yml's own comment
says to answer by splitting). Proposal, not applied: move about half the specs to a new `@shard3`
tag plus a matrix entry, or raise the cap to ~45 min as a stopgap.

## Update 2026-10-20 (later): split applied, per Jo

`@shard2` was split alphabetically after `phone-draw-crosshair.spec.js`: `@shard2` keeps 168 tests
(bento … phone-draw-crosshair, including `call-center-view`), the new `@shard3` takes the other 184
(35 spec files retagged by title; matrix entry added in `ci.yml`). Estimated from the first full run's
pace (about 8.7 tests/min early, 14/min mid, 10/min late): `@shard2` roughly 16-18 min, `@shard3`
roughly 18-20 min, against the 25 min cap. These are estimates; no full per-shard run was timed.
`call-center-view` stays in `@shard2`: it is a plain test that fails at a 5 s expect, so a red
costs seconds, not a test timeout. Runner-minutes: two jobs of ~18 min plus a second install/JVM boot
(~3-4 min) versus one job that burned its full 25 min and was cancelled every time. Neither shard is in
the merge-queue ruleset; add `@shard2` and `@shard3` once both have passed on main.
