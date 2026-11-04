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

## Update 2026-10-21: first full run of the split, and what the failures were

Main run 39532002721 (commit 1a64f75e): `@shard3` finished in 21.9 min - 174 passed, 4 failed, 6 did not run (serial specs stop after a failure). `@shard2` was still cancelled at 25 min after ~38 of 168 tests, because its failing specs burn three attempts each. So the split fixed the size problem only for `@shard3`; the remaining cost is failing specs, not volume.

The four `@shard3` failures, reproduced locally against the emulators and fixed (see [OVERNIGHT-LOG-2026-10-20](../projects/OVERNIGHT-LOG-2026-10-20.md)): the estimate funnel spec still asserted the pre-#2461 refused-without-consent behaviour and old trust-line copy; the Home nav spec looked for a strip chip the phone UX pass deliberately hides; the visit-recorder spec used a class selector that now matches two buttons (and had a comment and a tap merged onto one line); and two specs could not tap Home's last card because the fixed Record visit bar covered it - a real product bug, fixed in `visit-recorder.css`. Lesson: a spec that has never run to completion in CI should be assumed stale, not trusted.

Still open in `@shard2`: call-center-card, crew-calendar, inbox-layout, layouts, mission-control.


## Update 2026-10-22 (night): why `@shard3` was red on every run, and why `@shard2` still hits the cap

Evidence: five full runs (main 39840567839, merge-queue 39877736276 / 39829247919 / 39799947847, PR 39799137608) all had `@shard3` red on `visit-recorder.spec.js` and `@shard2` cancelled at 25 min. Neither is a flake: same specs, every run.

**`@shard3` / visit-recorder: a real product bug, not a race.** The spec's `describe` is `serial`, so when test 201 (do-not-record through the deep link) fails, Playwright re-runs the whole group, including test 105. The retries then failed in misleading ways ("recording starts with no signal", "Unfiled visits: expected 1, received 3": leftovers from the earlier attempt now listed under "Other recent visits"). The root failure was test 201: `dashboard.html?capture=1&lead=ID` also matched the dashboard's own `?lead=ID` handler (`dashboard-bootstrap.module.js`, "open the estimate builder for this lead"), and the CI screenshot shows the estimate wizard (step 2/10 Measure) sitting over the page instead of the recorder's sheet. Whichever script read the URL first won. Fixed: the bootstrap ignores `lead` when `capture=1`. Test 201 is the regression guard (it failed in all five runs; it passed in `@shard3` run 39884993040, 12.5 min). The seed now also deletes the user's leftover `visit_captures`, so a serial re-run starts clean. A first theory (the company consent setting unread, so the "Record this visit" reminder sheet blocks the start) was tried as a control and did not reproduce: dropped, and the sheet is the intended fail-closed behaviour.

**`@shard2`: still the failing specs, not volume.** `call-center-card` and `call-center-view` died with "Bucket name not specified": `initializeApp({storageBucket})` is a no-op when an earlier spec in the same worker (e.g. `bento-board`, `initializeApp({projectId})` only) already created the default app; both now name the bucket in `.bucket(...)`. `crew-calendar`, `layout-island` and `layouts` fail on their first attempt and their retries then hang on `page.evaluate` for the whole 240-300 s test timeout, three attempts each: about 8 + 10 + 10 minutes of a 25 minute cap spent on three specs. Not root-caused in this PR. Decision pending evidence from the next run; the options are fix, quarantine with a dated entry, or lower the per-test timeout for these shards.
