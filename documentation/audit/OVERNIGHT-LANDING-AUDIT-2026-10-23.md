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

- No Critical findings; one High (photo purge, below). Nothing customer-facing was sent or can be sent by this batch.
- Privacy invariants hold (section "Privacy invariants").
- Four commits were not yet live when sampled: the deploy queue was still working (section "Deploy status").
- Highest-severity finding: **High** (upgraded after the lane 3 repro) — on-device progress photos are not erased on sign-out or account switch. Parent session notified.

## Deploy status

The workflow has `concurrency: firebase-deploy`, `cancel-in-progress: false`:
GitHub keeps one pending run per group and cancels older *pending* ones. The two
"cancelled" runs below have **0 jobs** (they never started) — superseded, not failed.

| Commit | Run | Result at snapshot |
|---|---|---|
| 0eafb8de, 4536ddc8 | success | deployed |
| d4384c40 | success (ran 01:57–02:39) | deployed |
| d8382bd1 | cancelled (0 jobs) | files nevertheless **live** (see anomaly) |
| 860f257f | cancelled (0 jobs) | covered: ancestor of ce97821a, whose run later **succeeded** (update 2026-10-23, see below) |
| ce97821a | success (checked again later) | deployed; Call Center files were already served live |
| 91bea9a5, a0b6008c | docs only | nothing to deploy |
| 6c208c30 | pending | **not live yet** (`ds-firebase-sync.js` still has the old pill colour) |

Anomaly: `measurements-*.js` / `photos-logic.js` are live although their own run
was cancelled and the surviving run's SHA (d4384c40) predates them. Something
deployed a tree containing d8382bd1 (likely the long-running d4384c40 run or a
later queued run starting from a newer ref). I could not explain it without run
logs, so for these files "live" rests on content, not on the ancestor rule.
Function code (860f257f) cannot be checked from outside, but the ce97821a run it is an ancestor of finished green. **6c208c30 was still queued at the last check; recheck it.**

## Per-PR table

| PR | Deployed? | Live-verified? | Findings | Jo checks by hand |
|---|---|---|---|---|
| #2661 Cockpit tile numbers (0eafb8de) | yes | `cockpit-logic.js` served, `NBDCockpit` present | Low: module is unmounted (no page loads it), so nothing user-visible; streak tile shows "best N" before "train soon" once wired | nothing yet |
| #2658 Log Book layout (4536ddc8) | yes | `layouts.css` has `logbook` rules | none new | Switch to Log Book; confirm Last / Best / Today row on a phone |
| #2663 Accent picker (d4384c40) | yes | `accent-ui.js`/`accent-logic.js` served and referenced by index | Low: a saved custom theme has no `--paper` rule, so a dark custom theme can get the light-surface text tint; legacy `--orange`/`--gold` ignore the accent | pick each accent on a dark and a light skin |
| #2662 Measurements + progress photos (d8382bd1) | content live (see anomaly) | `measurements-logic/ui`, `photos-logic`, `measurements.css` all linked from index and served | **High** photos persist after sign-out/switch (below); Low: muscle sites coloured as "bad" when they grow; Low: blob URLs not revoked on leaving the page; Low: put+prune in one try can say "could not save" after a save; delete failure silent | Take a photo (airplane mode on), sign out, sign in as someone else: photo cards must be empty; check EXIF with a GPS-tagged test photo |
| #2666 Cal.com booking alert (860f257f) | **not proven** | not observable (server function) | Low: alert skipped if the Google sync throws first; no rules test for the notification write (rules re-read: client create needs `userId == auth.uid`, so cross-tenant spam is blocked) **(re-verified)** | Save a job over a Cal.com booking; expect one bell notification, none sent to the customer |
| #2664 Call Center status filters (ce97821a) | queued; files live | filters-logic serves `unhandled`/`urgent`/`promise`/`missed` | **Medium** "Missed" can't see real missed calls — nothing writes `answered` **(re-verified: no writer in functions/)**; Low: default "Needs attention" tab + Handled chip is always empty; Low: filter module load failure hides the bar silently | Tap Missed with real calls; confirm it matches what you remember |
| #2671 Theme contrast sweep (6c208c30) | **no** (pending) | not live | Medium: `ds-firebase-sync.js` sync pill hide-timer erases "Sync failed" after 0.1–0.4 s (pre-existing, not introduced here); Medium: a failed pages push skips workout sync for that load | after deploy: walk every theme on the iPhone |
| #2668, #2669 docs (recon, Pro status) | n/a | n/a | none | n/a |

## Findings (ranked)

1. **High (confirmed by repro in lane 3) — progress photos survive sign-out / account switch.** `purgeAccountStorage()` (`docs/pro/js/nbd-auth.js:788-857`) deletes `nbd-myskin` but never `nbd_ds_photos` (`measurements-ui.js:20`); rows carry no uid. On a shared phone the next user sees the previous user's body photos. **(re-verified: grep finds no `nbd_ds_photos`/deleteDatabase in nbd-auth.js.)** The feature's copy promises "stays on this phone". Fix: `indexedDB.deleteDatabase('nbd_ds_photos')` in the purge plus a test with a positive control. Measurements (`nbd_ds_measurements`) *are* purged and are not synced, so they are lost on sign-out — confirm that is acceptable.
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

## Lane 2 — NBD Pro public demo (live, no credentials)

Entry points: `/pro/sandbox` (guided story) and `/pro/explore` (sample account). No account, no real form submitted. Highest severity: **Medium**. The dashboard itself made zero Firestore / Functions / Auth requests and no non-GET requests across 42 sidebar items, Agent inbox, Ask Joe, add-lead, Reset and Sign Out.

| # | What I did | Result | Severity | Repro / notes |
|---|---|---|---|---|
| 1 | Zero-network check across sidebar, inbox, Ask Joe, add-lead, Reset, Sign Out | PASS | - | SDK imports resolve to same-origin `/pro/demo-sdk/*`. |
| 2 | Real prod pages iframed in the sample account (Decision Engine, Understand, Project Codex, AI Usage) | FAIL | Medium | They embed real `/pro/ai-tree`, `/pro/understand`, `/pro/project-codex`, `/pro/analytics`, outside the demo worker scope; they load reCAPTCHA Enterprise and POST to the App Check exchange endpoint for project nobigdeal-pro (403) plus Google Fonts. Contradicts "nothing leaves your browser". No Firestore request seen. |
| 3 | Same four panes, visually | FAIL | Medium | Render blank navy (`frame-ancestors 'none'` blocks the frames). A visitor sees an empty screen. |
| 4 | "Daily Success" nav item | FAIL | Medium | Opens a new window on the REAL `/pro/daily-success`, leaving the sandbox; same App Check/reCAPTCHA POSTs. |
| 5 | Door-to-Door clicked ~3.5 s after load | FAIL (race) | Low | "L.markerClusterGroup is not a function", stuck on "Loading…"; works after ~8 s. |
| 6 | Agent inbox keyboard | FAIL | Low | `aria-modal=true` but focus stays on the sidebar and Tab walks the background; Escape closes. |
| 7 | Sunday Review toast | FAIL | Low | Raw dev text: "Blocked in the sample account: fetch GET to /api/google-reviews". |
| 8 | Console noise | FAIL | Low | `HEAD /pro/nosw.txt` 404 on every page; App Check "not configured"; "[ThemeOverlays] Unknown overlay type: none". |
| 9 | Google Fonts on dashboard/iframes/popup | FAIL | Low | Third-party font requests (story page is self-hosted and clean). |
| 10 | Story page tab order | FAIL | Low | First Tab hits "Open the green door"; skip link and header chips only after wrapping. Focus rings visible. |
| 11 | Sample-account strip at 360–412 and desktop | FAIL | Low | Bottom strip covers Home buttons, D2D tabs, Storm card; storm map labels overlap. |
| 12 | Greeting at 360 px | FAIL | Low | Name missing, brand truncated to "N…". |
| 13 | Tap targets on desktop | FAIL | Low | Header tools 30x30, "↻" 31x19, "Sign Out" 12 px tall. |
| 14 | Sample data dates | FAIL | Low | "Inspection Tue Oct 6" stale; Sunday Review shows $0 collected. |
| 15 | Entry discoverability | NOTE | Low | Story end screen still shows a disabled "Explore the whole sample account / Coming next" though `/pro/explore` is live; reachable only by direct URL. |
| 16 | Guided story, all 9 steps at 1280/412/390/360 | PASS | - | Keyboard completes it; end shows Start free (`/pro/register.html`) and Book a demo (cal.com). 0 console errors. |
| 17 | Sample account sweep at 4 widths | PASS | - | No page overflow, no broken images. |
| 18 | Forms / local-only behaviour | PASS | - | Add Lead validates and persists locally; "Nothing was sent" sheet; Ask Joe says no AI model is called; Reset and Sign Out work. |

Not covered in depth: estimate wizard, customer card, how-to.html, dashboard dark-mode toggle.

## Lane 3 — authed CRM + Daily Success on local emulators

Rig: Auth + Firestore emulators and a static server on 127.0.0.1 serving this worktree's `docs/` (the stock rig could not run: no `node_modules` in any checkout, port 8080 held by another app, hosting emulator 404s under a `.claude` path). Seeded users `playwright-e2e@nbd.test` and `second-e2e@nbd.test`. `PLAYWRIGHT_BASE_URL` unset, proxy env scrubbed, every non-local request aborted (only the Sentry CDN, Google Fonts and one prod function call were blocked). Functions emulator never started; no SMS/email/production traffic. Screenshots in the scratchpad, not the repo. Worktree was at 6c208c30.

| What I did | Result | Severity | Repro / notes |
|---|---|---|---|
| Photos survive sign-out / account switch | FAIL | **High** | Log in as A, add a progress photo, `NBDAuth.logout()`, log in as B, open Daily Success: B's card shows A's photo. `nbd_ds_measurements` is purged; `nbd_ds_photos` (IndexedDB) is not. Raw sign-out-without-purge path not completed (script hit a modal). |
| Photo add with fake EXIF GPS (APP1 + COM) | PASS | - | Stored blob has no APP1–APP15/COM, no GPS string; resized 1600x1200 to 1280x960. |
| Photo flow: second photo, Then and now, pose switch, two-tap delete, garbage file | PASS | - | Garbage gives "Could not save that photo"; delete needs a second tap. |
| Measurements: invalid input, comma decimal, same-day replace, trend, cm/in, Remove latest | PASS | - | Rejects empty/abc/-5/0/1/999/3500/34.5.1/1e3; "34,5" saves; trend and unit pref persist; tampered storage tolerated. |
| Measurement bounds | Info | Low | "4" (inches) accepted (min is 5 cm / 2 in); generic out-of-range toast. |
| Typed measurement text lost to a one-time post-load `renderDash` | FAIL | Low | Type in Measurements within ~1 s of load: the field clears; saving immediately gives "Enter a number…". Unit/site toggles also clear typed text. |
| Measurements + photos at 390 dark/default, 1280 dark/Warm Paper | PASS | - | No overflow; contrast >= 4.61 sampled; chips 44 px (the "in" chip is 35 px wide). |
| Appearance picker + 8 accent swatches x 10 themes, 390 and 1280 | PASS | - | Swatches 44x44; no accent/button text under 4.5; accent and NBD Light persist across reload. |
| Layout picker Classic / Log Book / Rings | PASS | - | Switch, no overflow at either width (detailed day-page visuals not inspected). |
| Layout picker Cockpit | Info | - | Disabled ("COMING", `ready:false`) as are Quest/Arcade/One Thing/Journal — not exercisable. |
| Workout coach keyboard (390) | FAIL | Medium | Enter on "START TODAY'S WORKOUT" opens `#wcOverlay` with no `role=dialog`/`aria-modal`; focus not moved inside; Tab reaches controls behind it; Escape does not close it. |
| Day page keyboard (390) | FAIL | Medium | Food inputs show no outline or shadow on focus (3%-alpha tint only); buttons are fine (3 px outline). |
| Call Center status chips on 8 seeded calls | PASS | - | Counts 6 / 2 / 1 / 1 / 2 correct. "Missed" caught a 4 s call and an `answered:false` call — so the chip works if some writer sets `answered`; the finding that nothing in `functions/` writes it still stands. |
| Call Center date + direction filters | PASS | - | Range chips, 24h/7d/30d and "You called" correct. |
| Console errors | PASS | - | None from app code; `[ThemeOverlays] Unknown overlay type: none` warnings (Low). |
| `health-shortcut-ui.js` calls `getFunctions()` without `connectEmulatorsIfLocal` | FAIL | Low-Medium | In one run the browser tried `POST https://us-central1-nobigdeal-pro.cloudfunctions.net/healthShortcutManage` (blocked by the test). In the repo's own emulator rig this is a race that could send a status call to production. |

Not exercised: Cal.com booking alert (needs the Functions emulator and sends alerts); Call Center "Said you'd do" deck (callables stubbed); detailed Rings / Log Book / Cockpit visuals; raw sign-out-then-switch; dark-theme and 1280 coach/keyboard checks; the repo's own `test:e2e:authed:emu` suite; full-page contrast audit; saved views (#2673) and appearance picker contrast (#2680) were not merged.

Side effect to know about: the lane 3 agent's process cleanup matched broadly and may have killed some unrelated `bash.exe`/`node.exe` processes.
