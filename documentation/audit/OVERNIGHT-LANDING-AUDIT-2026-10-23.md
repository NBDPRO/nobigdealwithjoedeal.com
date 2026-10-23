# Overnight landing audit — 2026-10-22 evening to 2026-10-23

Read-only audit of what landed on `origin/main` overnight. Snapshot taken
2026-10-23 ~03:45 UTC at main `6c208c30`. Nothing was fixed in this PR; every
finding below is a lead for a later PR. No prod writes, no flag flips, no logins.

Method: `git log origin/main`, `gh run list` for the `Firebase deploy` workflow,
`curl` of the live hosting URLs (the deploy minifies JS, so live bytes are
compared by marker strings, not hashes), then `nbd-security-reviewer`,
`silent-failure-hunter` and `vacuous-test-auditor` on the new code and tests.
The reviewers read the working tree (no shell); the two claims I re-checked by
hand are marked **(re-verified)**.

## Verdict

- No Critical or High findings. Nothing customer-facing was sent or can be sent by this batch.
- Privacy invariants hold (section "Privacy invariants").
- Four commits were not yet live when sampled: the deploy queue was still working (section "Deploy status").
- Highest-severity finding: **Medium** — on-device progress photos are not erased on sign-out or account switch.

## Deploy status

The workflow has `concurrency: firebase-deploy`, `cancel-in-progress: false`:
GitHub keeps one pending run per group and cancels older *pending* ones. The two
"cancelled" runs below have **0 jobs** (they never started) — superseded, not failed.

| Commit | Run | Result at snapshot |
|---|---|---|
| 0eafb8de, 4536ddc8 | success | deployed |
| d4384c40 | success (ran 01:57–02:39) | deployed |
| d8382bd1 | cancelled (0 jobs) | files nevertheless **live** (see anomaly) |
| 860f257f | cancelled (0 jobs) | **functions change NOT proven deployed** |
| ce97821a | queued | Call Center files already served live |
| 91bea9a5, a0b6008c | docs only | nothing to deploy |
| 6c208c30 | pending | **not live yet** (`ds-firebase-sync.js` still has the old pill colour) |

Anomaly: `measurements-*.js` / `photos-logic.js` are live although their own run
was cancelled and the surviving run's SHA (d4384c40) predates them. Something
deployed a tree containing d8382bd1 (likely the long-running d4384c40 run or a
later queued run starting from a newer ref). I could not explain it without run
logs, so for these files "live" rests on content, not on the ancestor rule.
Function code (860f257f) cannot be checked from outside: **recheck that the
queued runs for ce97821a / 6c208c30 finish green**; they carry 860f257f.

## Per-PR table

| PR | Deployed? | Live-verified? | Findings | Jo checks by hand |
|---|---|---|---|---|
| #2661 Cockpit tile numbers (0eafb8de) | yes | `cockpit-logic.js` served, `NBDCockpit` present | Low: module is unmounted (no page loads it), so nothing user-visible; streak tile shows "best N" before "train soon" once wired | nothing yet |
| #2658 Log Book layout (4536ddc8) | yes | `layouts.css` has `logbook` rules | none new | Switch to Log Book; confirm Last / Best / Today row on a phone |
| #2663 Accent picker (d4384c40) | yes | `accent-ui.js`/`accent-logic.js` served and referenced by index | Low: a saved custom theme has no `--paper` rule, so a dark custom theme can get the light-surface text tint; legacy `--orange`/`--gold` ignore the accent | pick each accent on a dark and a light skin |
| #2662 Measurements + progress photos (d8382bd1) | content live (see anomaly) | `measurements-logic/ui`, `photos-logic`, `measurements.css` all linked from index and served | **Medium** photos persist after sign-out/switch (below); Low: muscle sites coloured as "bad" when they grow; Low: blob URLs not revoked on leaving the page; Low: put+prune in one try can say "could not save" after a save; delete failure silent | Take a photo (airplane mode on), sign out, sign in as someone else: photo cards must be empty; check EXIF with a GPS-tagged test photo |
| #2666 Cal.com booking alert (860f257f) | **not proven** | not observable (server function) | Low: alert skipped if the Google sync throws first; no rules test for the notification write (rules re-read: client create needs `userId == auth.uid`, so cross-tenant spam is blocked) **(re-verified)** | Save a job over a Cal.com booking; expect one bell notification, none sent to the customer |
| #2664 Call Center status filters (ce97821a) | queued; files live | filters-logic serves `unhandled`/`urgent`/`promise`/`missed` | **Medium** "Missed" can't see real missed calls — nothing writes `answered` **(re-verified: no writer in functions/)**; Low: default "Needs attention" tab + Handled chip is always empty; Low: filter module load failure hides the bar silently | Tap Missed with real calls; confirm it matches what you remember |
| #2671 Theme contrast sweep (6c208c30) | **no** (pending) | not live | Medium: `ds-firebase-sync.js` sync pill hide-timer erases "Sync failed" after 0.1–0.4 s (pre-existing, not introduced here); Medium: a failed pages push skips workout sync for that load | after deploy: walk every theme on the iPhone |
| #2668, #2669 docs (recon, Pro status) | n/a | n/a | none | n/a |

## Findings (ranked)

1. **Medium — progress photos survive sign-out / account switch.** `purgeAccountStorage()` (`docs/pro/js/nbd-auth.js:788-857`) deletes `nbd-myskin` but never `nbd_ds_photos` (`measurements-ui.js:20`); rows carry no uid. On a shared phone the next user sees the previous user's body photos. **(re-verified: grep finds no `nbd_ds_photos`/deleteDatabase in nbd-auth.js.)** The feature's copy promises "stays on this phone". Fix: `indexedDB.deleteDatabase('nbd_ds_photos')` in the purge plus a test with a positive control. Measurements (`nbd_ds_measurements`) *are* purged and are not synced, so they are lost on sign-out — confirm that is acceptable.
2. **Medium — Call Center "Missed" is effectively "short inbound under 15 s with a known duration".** Dead `answered === false` branch; truly unanswered calls often have no recording and never reach `phone_calls`. The PR header already says Jo hasn't confirmed this status set. Rename (e.g. "Short calls") or source real missed-call data.
3. **Medium — Daily Success sync pill (`ds-firebase-sync.js:66-72`).** Independent hide timers; "Saving…" timer hides the pill before/just after "Sync failed". Failure is nearly invisible.
4. **Medium — `ds-firebase-sync.js:289-290, 212`.** A failed pages push aborts `syncWorkouts()` for the load; unguarded `localStorage.setItem` can abort remaining workout pushes.
5. **Low** — items listed per row above, plus: cloud push failure at workout finish is not shown (self-heals next sign-in); `_uid` not cleared on sign-out; EXIF strip is unit-tested but no test feeds a real GPS JPEG through it (code reads correct: canvas re-encode plus APP1–APP15/COM removal).
6. **Info** — pre-existing, outside this batch: `docs/pro/dashboard.html` and `customer.html` still carry an "AOB" document template/boilerplate editor. Kentucky rule says no AOB; this predates the night but is worth a look.

## Privacy invariants

All checked on `origin/main` after the merges:

- No Storage `?token=` URLs under `docs/` (git grep: none).
- `node tests/catalog-cost-privacy.test.js`: 130 passed, 0 failed.
- `node scripts/check-image-privacy.js`: 789 images, 0 failures (4 benign camera-EXIF accepted).
- Overnight diff (`docs/`, `functions/`) scanned for: certificate claims, "we handle the claim", "in-house", old oranges `#E8720C`/`#F08030`, `sk-ant`, `AIza`, `token=`, phone numbers, personal email addresses, cost/margin keys — no hits.
- The only claim-wording hits repo-wide are the consumer-warning sentence about assignment of benefits in the adjuster-visit blog post and its `llms-full.txt` copy (advice to homeowners, fine).
- CSP on the live Daily Success page: `script-src` has no `unsafe-inline`, `script-src-attr 'none'`. `check-inline-html-scripts` and `check-js-syntax` pass; `node tests/smoke.test.js` printed no failures. The local node manifest bucket run is NOT evidence either way: 509/622 suites passed before the 480 s wall-clock budget ended ("a suite is hanging"), in a worktree with no `functions/node_modules`, so function-dependent suites could not run. CI is the gate.

## Test quality (vacuous-test-auditor)

About 120 mutations across 7 files (throwaway worktree, removed afterwards). Sound: cockpit-logic (11/11 red), call-center-status-filters (21/21 red), the calendar overlap *logic*, the contrast maths in the theme sweep, EXIF-segment stripping units. Survivors (mutation broke behaviour, suite stayed green):

- **tracker-measurements-photos** — the "strip before store" guard is a regex on the source; replacing `new Blob([stripped.out]` with the unstripped blob stays green, so a regression would ship GPS-bearing photos with no test failing. Same for the `if (!stripped) throw` guard, the no-network scan (`new Image().src=` and `window['fe'+'tch']` pass), the oldest-first prune (reversing it passes) and the escaping checks. Comment-suffix decoys defeat the greps.
- **ds-accent-picker** — the 80-pair accent × skin contrast matrix passes silently when a skin lacks a token (`NaN < min` is false); the swatch click handler, the MutationObserver wiring and a throwing `stored()` are not exercised.
- **ds-layout-logbook** — escaping check has no hostile fixture (disabling `esc` stays green); Best rounding is compared against itself.
- **calendar-job-booking-conflict** — trigger wiring is source-regex only: `if (false && …)` or commenting out the `alertJobOverlapsBookings` call in either Cloud Function trigger stays green, so neither trigger is proven to alert.
- **daily-success-theme-sweep** — rule pins show the rule text exists, not that it wins the cascade; a skin missing `--grn` is skipped.

Severity: Low–Medium (the shipped code reads correct; the guards just would not catch a regression). The photo-strip guard is the one to fix first because it protects a privacy promise.

## Still to merge when this audit was written

Open (not audited as landed): #2665, #2667, #2670, #2673, #2676, #2678, #2679, #2680, plus doc PRs and a draft blog post. Re-run this audit for the ones touching Call Center saved views, `lead_sources` confirmedSource, messaging honesty and storm outreach after they merge.

## What Jo must do by hand (nothing here is verifiable without logging in)

1. After the pending deploys finish: open the tracker on the iPhone, cycle all themes, confirm the sync pill and 44 px rows.
2. Progress photos: add one, sign out, sign in as another account, confirm none show (expected to FAIL until finding 1 is fixed).
3. Call Center: tap each status chip, especially Missed, against calls you know.
4. Save a job over a Cal.com booking: one bell notification, nothing sent to the customer.

## Lane 1 — live public site (read-only, hands-on)

No forms submitted, no non-GET requests (analytics POSTs aborted), no logins. 299 sitemap URLs + 9 nav/footer/body links crawled (308 internal), 355 external links, 12 sample pages x 4 widths (360/390/412/1280) x light/dark, interaction pass on 10 pages at 390 and 1280. Highest severity: **Medium**.

| What I did | Result | Severity | Notes / repro |
|---|---|---|---|
| Crawl all internal URLs | PASS | - | 308/308 return 200; no 404/5xx/chains. `/r` is an intentional 302 chain to the Google review page. |
| External links | PASS (7 blocked) | Info | 7 bot-wall 403s (yelp, jameshardie.com designer, two westlake pages, georgetownky.gov fee PDF, two KY city pages) — blocked, not broken, not followed up. |
| Mixed content, console errors, failed requests, broken images | PASS | - | 0 http requests, 0 page errors, 0 failed requests, 0 broken images on the 12 sample pages. |
| Horizontal overflow, clipped text | PASS | - | None at any width. |
| Menu, accordions, tabs (no submit) | PASS | - | Hamburger toggles `aria-expanded`; all visible `<details>` open; no tabs on these pages. |
| tel/mailto/sms links | PASS | - | Only `+18594207382` and jd@ (marketing). Two links (`/partners`, hail-season blog) use `tel:8594207382` without +1 — same number. |
| Dark mode | N/A | Info | Light and dark renders identical; pages don't react to `prefers-color-scheme` (not a defect). |
| Contrast on `/book` | FAIL | **Medium** | "Book the Adjuster Visit →" (`.tool-cta`) is `#DD875F` on white (~2.7:1); "60 min" chip ~2.45:1. `#DD875F` is the on-dark orange. Open `/book`, scroll to the adjuster card. |
| Contrast, `/book` chips | FAIL | Low | "30 min / At your home / Free" chips `#BD5728` on tint ~4.05:1 (<4.5). |
| Contrast, `#BD5728` text elsewhere | FAIL | Low | 2.8–3.5:1: "Step 1 of 5" + footer links on `/estimate`, footer column titles and "Owner & Operator" (3.04) on `/about`, stat numbers on roof-replacement (2.82 on navy), two headings in the hail-season blog. Automated check ignores gradients — confirm small ones by eye. |
| Claim wording scan, 299 pages | PASS | - | No "we handle the claim". "Assignment of benefits" only as a consumer warning and "No assignment of benefits" on `/pro`. "Master Elite" only to disclaim it. No IKO claim. Commercial copy says independent subcontractors with their own insurance. |
| Other credential claims | NEEDS JO | **Medium** | Home page says "member of the James Hardie Alliance" and "member of American Operator"; `/guides/siding-gutter-buyers-guide` and `/review` repeat Hardie Alliance; `about.html` also lists both in JSON-LD (`memberOf`) and the pattern repeats in the area pages. CLAUDE.md names only GAF Certified 1162011 and TAMKO Pro Gold as real certs. These claims look long-standing (citation kit 2026-07, SEO deep dive 2026-09-27 mention them), not from tonight — Jo should confirm they are true memberships. **I did not verify them.** |
| "Our crew" hero eyebrow | Info | Low | "OUR CREW · REAL JOB, NOT STOCK" is ambiguous next to the independent-subs wording; not "in-house". |

Environment note: no playwright module was available in the repo; the agent used a cached npx copy pointed at the installed chromium headless shell. Nothing was downloaded.
