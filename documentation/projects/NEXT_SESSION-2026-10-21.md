# NEXT_SESSION - 2026-10-21: the tracker night, merged and live

**Session of 2026-10-20 -> 21 (overnight).** Continues
[NEXT_SESSION-2026-10-14](NEXT_SESSION-2026-10-14.md) (its open items for Jo still stand).
Running log of the hourly cycles: [OVERNIGHT-LOG-2026-10-20](OVERNIGHT-LOG-2026-10-20.md).
Verified against `main` and the live site on 2026-10-21 - check Actions before telling Jo
anything newer is live.

## What shipped (merged to main, deployed)

| Area | PR |
| --- | --- |
| Calendar hub: Cal.com booking that lands on a job rings Jo's bell (warn only) | #2588 |
| Progress card: estimated-1RM line per lift + 12-week volume | #2589 |
| Find a food: Open Food Facts search + barcode lookup; CSP allows `world.openfoodfacts.org` on `/pro/daily-success` only | #2590 |
| Download my data (JSON + Excel-safe CSVs) | #2599 |
| The night bundle (#2608): iPhone barcode scan with a vendored ZXing decoder loaded only on Scan; adaptive "your real maintenance" calories; seven coach upgrades (avoid list, plate calculator, warm-up sets that never count as work, stall -> deload/swap, muscle balance, readiness check-in, supersets) | #2608 (carries #2596, #2600, #2598, #2601-#2607) |
| Apple Health weight via an iPhone Shortcut - **ships dark** (404 until `system/healthShortcut` exists) | #2606 |
| `follow-redirects` 1.16.1 (HIGH npm advisory) | #2594 |
| E2E shard2 spec races fixed + `@shard2` split into `@shard2` / `@shard3` | #2609 |
| Phone Home: the last card ("More on Home") was hidden under the Record visit bar - fixed, plus four stale E2E specs repaired | #2610 |
| Research note: GitHub + Grok ideas for the tracker (all ten ideas were then built) | #2597 |
| Coach: last-time line + live PR trophy; rep-range PR (volume sets earn their own trophy, e1RM trophies only up to 12 reps) | #2612, #2614 |
| Daily Success audit and revamp (Jo: "looks wrong, barely readable"): default-theme colour tokens, phone layer (two-row header, 12px type, 44px targets, tables that fit), the CRM's dark card skin, ten brand-safe themes, developer button removed | #2613, #2615, #2616, #2617 |
| Coach Previous per set + rest alert setting; collapsible day sections + sticky Today bar + door stats hidden until used; Call Center filters (date / range / Today / Last 24 h / direction / order); coach workout history | #2618, #2619, #2620, #2622 |
| Light-skin contrast fixes; Call Center review fixes (filter count wording, storage guard, oldest/newest footer) | #2623, #2624 |
| Silent-failure review fixes: a failed save keeps the workout open (no more lost workout), bodyweight live Rep PR, section-toggle storage guard | #2625 |
| Test hardening from the vacuous-test audit (logic gaps, comment-blind pins, type floor incl. rem/em/`font:`, real Call Center tab click) | #2626, #2628, #2633 |
| Phone header strip fades at the right edge (DELETE / CSV / PDF / SAVE were off-screen with no hint); tab-close x and week-strip letters follow the theme | #2630, #2632 |
| Docs: overnight log, forward roadmap ([DAILY-SUCCESS-ROADMAP-2026-10-21](DAILY-SUCCESS-ROADMAP-2026-10-21.md)) | #2627, #2629, #2631 |

Live checks done: decoder file sha256 matches the reviewed build, tracker scripts served, CSP allows
the food database only on the tracker pages (not `/`, not `/pro/dashboard`), health ingest answers 404 to
anonymous POSTs. Not done: anything on a real phone.

## Things that bit us (worth knowing)

- **The merge queue's required checks are 16, not 7** (ruleset 24456328). `@shard2`/`@shard3`, the Pro demo
  walk and the Dependency audit are NOT required. The old "7 required" list is branch protection only.
- **CI backlog stalls the queue**: stacked PRs re-run the whole stack's CI each; seven stacked coach PRs
  plus others held the queue for an hour. Land a stack through its top PR, or one bundle PR.
- **`@shard2` has never finished** (25 min cap): failing specs burn three attempts each. `@shard3` now
  mostly finishes (181 pass), but the failing specs **rotate run to run** (`visit-recorder`, `phone-quick-wins-part2`,
  `yard-signs-edit`: 5 s expect timeouts, sometimes the job cap) - an overloaded shard, not a broken test and
  not the tracker changes. Proposed: split `@shard3` in two or raise the emulator-spec expect timeout (Jo's call). See
  [shard2-e2e-never-finishes-2026-10-20](../qa/shard2-e2e-never-finishes-2026-10-20.md).
- **A spec that never ran to completion in CI is probably stale**: four of them had drifted from the
  product, and one exposed a real bug (the Record visit bar covering Home's last card).
- **Local E2E on Windows**: the Firestore emulator needs a free port 8080 (another local process may hold
  it - use a temporary uncommitted port change), and junctions to a shared `node_modules` must be removed
  with `cmd //c rmdir`, never `rm -rf`. `git reset --hard` and `sed -i` are blocked by the guard hook.
- **Never run commands after a `;` that follows `git worktree add`**: a failed add ran merge + `git add -A`
  in the main checkout once; recovered with no push (see the memory note).
- **A flaky required check**: `sms-outbox-client` failed once on main after merge (passes locally and in the
  queue run; its waits are short and real-time). Re-running the job passed.

## Needs Jo

1. **Apple Health**: create `system/healthShortcut` in the Firebase console (`enabled: true`, `allowedUids:
   [his uid]`) only if he wants it, after the forged-X-Forwarded-For limiter check from the security review;
   then create the key in the tracker card and follow its Shortcut steps (runbook:
   `documentation/runbooks/HEALTH-SHORTCUT.md`).
2. **Real-iPhone pass**: barcode scan in daylight, Download my data (Share / Save to Files), the new coach
   buttons, and that "More on Home" is tappable above the Record visit bar.
3. **Active Era weight import** is still not built: it needs a few sample rows of the app's export (or an
   Apple Health export). Design is in [DAILY-TRACKER-REVAMP-PLAN-2026-09-29](DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md).
4. **Merge-queue ruleset**: add `@shard2` and `@shard3` to the required list once both pass on main.
5. The 10-14 list (Anthropic credit, LegalShield review, IKO confirmation, Twilio resubmit) is unchanged.

## Next lanes

- Get `@shard3` fully green (`visit-recorder` first-attempt failures in CI only) and `@shard2` under its cap
  (layouts, layout-island, crew-calendar, call-center-card, bento-board retries).
- Active Era weight import, then the Hume -> Apple Health -> Shortcut path is already built (dark).
- Keep an eye on CI queue depth before opening more than one PR at a time.
- **Daily Success revamp, the rest:** a real-iPhone pass of everything in the audit note; Apple Health setup walk-through. The light-theme /
  phone sweep is done (ten skins x 360 / 390 / 412, no overflow; fixes in #2630 and #2632; the dark hero cover cannot be read by the contrast
  probe). Decisions Jo already made are in the memory note `daily-success-revamp-decisions-2026-10-21`.
- **Forward plan:** [DAILY-SUCCESS-ROADMAP-2026-10-21](DAILY-SUCCESS-ROADMAP-2026-10-21.md) - workout templates first, then set types + finish
  summary, exercise library depth, measurements/photos, Sunday weekly review.
- **Call Center:** filters are live; ask Jo what else he wants (status filters like Handled / Urgent / Has promise, a missed-call filter, saved views).
