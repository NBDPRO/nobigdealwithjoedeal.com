# NEXT_SESSION, 2026-11-06: boot CSS lane (lane note)

A lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). It picks up three items
Jo approved ("do all of the above") from the speed lane
([NEXT_SESSION-2026-11-04-site-crm-speed](NEXT_SESSION-2026-11-04-site-crm-speed.md), step 4) and the portal note
([NEXT_SESSION-2026-11-05-portal-sweep](NEXT_SESSION-2026-11-05-portal-sweep.md), "Not built").

## State at hand-off (2026-11-06 ~07:00Z)

| PR | What | State |
|---|---|---|
| [#2892](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2892) | 41 dashboard stylesheets load late (`media="print"` + `docs/pro/js/late-css.js`) | Green, in the merge queue (squash) |
| [#2895](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2895) | `portal-token-mint.js` is the only `portal_tokens` writer; the portal note's "fold estimate-send" item crossed off | Green, in the merge queue |

**First thing next session:** confirm both merged and that the `Firebase deploy` run carrying #2892 went green. If
either dropped out of the queue, merge `main` into its branch and requeue.

## The three items

1. **Live speed re-run after #2827:** already done by another session (#2870). It can't be run from a cloud sandbox
   anyway (the proxy refuses the live site).
2. **Boot CSS:** built in #2892. Full write-up: [BOOT-CSS-2026-11-06](../audit/BOOT-CSS-2026-11-06.md).
   - 80 boots (4 roles on the emulator rig + the sample account, 8 layouts, phone and desktop): 41 eager sheets style
     nothing on the first screen. They apply on first input, a non-Home `goTo()`, a `?query` link, or idle (2 s cap).
   - **Win:** cold first paint at 150 ms / 1.6 Mbps 7.96 → 6.28 s; render-blocking CSS 56 → 21.
   - **Not a win:** boot restyle CPU is unchanged, even with the sheets deleted. The 11-04 "40 % cheaper restyles"
     guess was wrong; the 11-04 note has a dated correction. What drives restyle cost is still open.
   - `rel="preload"` was tried first and dropped: under a service worker Chrome downloads each sheet twice and views
     painted unstyled for 200-350 ms.
   - Guard: `tests/late-css-2026-11-06.test.js` pins the late list and the keep-eager list. Re-measure with
     `node scripts/measure-boot-css.js` (exits 1 if a late sheet is used at boot).
3. **Portal token cleanup:** nothing to fold (#2895). `estimate-send.js` mints `report_share_tokens` and
   `deal_accept_tokens`, not portal links. Three modules still each carry a copy of the token-string generator;
   sharing it was left alone (an unrequested refactor).

## Open, for whoever picks this up

- **iPhone check** once #2892 deploys: open the CRM cold on cellular, tap into a few views (Pipeline, Expenses,
  Storm, Settings) and a dialog or two (agent inbox, triage deck). Nothing should paint unstyled.
- **One unexplained CI failure** on #2892's first run: `pro-authed.spec.js:466` got `depositAmount: 0` (expected
  1750) on all 3 attempts; the one re-run passed, and it passes locally on the branch and on `main`. The trace
  artifact could not be downloaded from the sandbox. If `depositAmount: 0` shows up on any PR, start from that run's
  `playwright-authed-traces-0` artifact. Comment on #2892 has the details.
- **Two flaky specs on `main`** (seen in the emulator rig, not fixed): `bento-board` (1 of 4 runs: three tiles
  rendered twice) and `yard-signs-edit` (2 of 6: reads `YardSigns.list()` right after the modal closes, before the
  save lands).
- `customer.html` was not measured for late sheets.

## Notes for the next session

- **GitHub access in the cloud sandbox:** `gh` GraphQL is refused. Ready-for-review and auto-merge go through the
  REST routes `POST repos/{o}/{r}/pulls/{n}/ccr/ready_for_review` and `PUT .../ccr/auto_merge -f merge_method=squash`;
  on this repo auto-merge puts the PR in the merge queue.
- **`dashboard-boot-budget` locally:** the readable-byte gate fails on `main` unless esbuild is installed. Run
  `node scripts/minify-shipped.js --install` first; CI checks the shipped (minified) sizes.
- **Emulator rig in the sandbox:** `npm install` in `tests/` (not `npm ci`: lockfile drift; don't commit it),
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium`, and scrub the proxy env for `emulators:exec`.
  `NBD_AUTHED_SPECS_FILE=<list>` runs a chosen set of specs.
- **Measuring CSS:** a `media="print"` sheet never shows used rules, so measure late sheets with the attribute
  stripped (the script does this). Service-worker fetches ignore DevTools throttling, so slow-link timings come
  from the emulator rig with service workers blocked, not from the sample account.
