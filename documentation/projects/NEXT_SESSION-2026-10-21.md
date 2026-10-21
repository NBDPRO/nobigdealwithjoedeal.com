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

Live checks done: decoder file sha256 matches the reviewed build, tracker scripts served, CSP allows
the food database only on the tracker pages (not `/`, not `/pro/dashboard`), health ingest answers 404 to
anonymous POSTs. Not done: anything on a real phone.

## Things that bit us (worth knowing)

- **The merge queue's required checks are 16, not 7** (ruleset 24456328). `@shard2`/`@shard3`, the Pro demo
  walk and the Dependency audit are NOT required. The old "7 required" list is branch protection only.
- **CI backlog stalls the queue**: stacked PRs re-run the whole stack's CI each; seven stacked coach PRs
  plus others held the queue for an hour. Land a stack through its top PR, or one bundle PR.
- **`@shard2` has never finished** (25 min cap): failing specs burn three attempts each. `@shard3` now
  mostly finishes (181 pass; the remaining failures are in `visit-recorder`). See
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
