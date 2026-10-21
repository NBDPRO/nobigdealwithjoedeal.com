# Overnight log - 2026-10-20 / 21

Running log of the hourly review-and-improve cycles Jo asked for on the night of 2026-10-20
("do any and all the research and review you want ... every hour or two, then small improvements,
fixes, changes and upgrades"). One dated section per full cycle: what was checked, found, changed,
and what was left for Jo and why. Hard limits for the night: no production writes, no flag flips, no
credentials, nothing sent to customers, no pricing / contract / claim wording, no security-rules or
auth changes without a morning look, no history rewrites.

Handoff for the morning: see the Current handoff pointer in [INDEX](../INDEX.md).

## Cycle 1 - 03:00-03:40 UTC (theme: CI health)

**State found.** Everything planned for the night had merged and deployed: Download my data (#2599), the
research note (#2597), the bundle (#2608: iPhone barcode scan, adaptive calories, seven coach upgrades),
the shard split (#2609) and the Apple Health weight endpoint (#2606, dark). Live checks passed: decoder
file hash matches, tracker scripts served, `world.openfoodfacts.org` allowed only on `/pro/daily-success`,
the health ingest endpoint answers 404 to anonymous POSTs while its flag is off.

**Finding - the split worked for `@shard3`, not for `@shard2`.** First full runs of the split shards on main
(run 39532002721): `@shard3` finished in 21.9 min with 174 passed, 4 failed, 6 did not run; `@shard2`
was still cancelled at the 25 min cap because failing specs burn three attempts each. Neither shard is a
required check, so nothing was blocked. The four `@shard3` failures were not new bugs: these specs had
never run to completion in CI (the old `@shard2` always timed out first), and three had drifted from the
product while one exposed a real UI bug.

| Spec | Cause | Fix |
|---|---|---|
| `phone-estimate-funnel` | asserted the old "Continue is refused without SMS consent" (SMS box became optional in #2461) and the old trust-line copy | runs both paths (ticked / unticked), asserts `tcpaConsent` equals the box, pins the current "Real Google reviews" line |
| `phone-home-nav` | looked for the "N people need you" strip chip, which the phone UX pass (Oct 13-14) deliberately hides while Today lists the same call | asserts the Today "Calls owed" row, the hidden duplicate chip, and a thumb-sized call-back button in the first screen |
| `phone-home-nav` + `phone-no-next-step` | **real product bug:** the fixed Record visit bar covered Home's last card ("More on Home"), so it could not be tapped | CSS fix (below) |
| `visit-recorder` | `.nbd-vr-unfiled` now matches two buttons ("Recent visits" reuses the class); a comment and a tap had been merged onto one line so the tap never ran | locator narrowed to the badge, line restored |

**The real bug.** `visit-recorder.css` reserves `padding-bottom: 74px` for Home "on top of the nav room",
but `dashboard-app.css` forces `.view-scroll { padding-bottom: calc(80px + safe-area) !important }` at
`max-width:768px`, which beat the plain rule. Home only cleared the nav; the last card sat under the bar.
The old unit test only checked the rule's text existed, so it passed while the bug was live. Fixed with a
phone-only `!important` rule (nav 80px + bar 74px), keyed on `html.nbd-vr-bar-on`; new test
`visit-recorder-home-clearance-2026-10-21` models the cascade and has a control that reproduces the bug on
the pre-fix stylesheet.

**Verification.** Each spec was run locally against the emulators (hosting + auth + firestore + storage, no
functions emulator so no alerts can fire): estimate funnel 2 passed, home-nav 4 passed, no-next-step 1
passed, visit-recorder 4 passed; the pre-fix runs failed at exactly the assertions above. Break checks turn
the new tests red.

**Left for Jo / next cycles.**
- `@shard2` is still not finishing: its failing specs (call-center-card, crew-calendar, inbox-layout,
  layouts, mission-control) are the next thing to reproduce the same way.
- Local E2E needs a free port 8080 for the Firestore emulator; another local process held it, so the runs
  used a temporary local-only port change that was not committed.
- Not done on purpose: anything that needs a phone in hand (barcode camera, downloads, the Apple Health Shortcut).
