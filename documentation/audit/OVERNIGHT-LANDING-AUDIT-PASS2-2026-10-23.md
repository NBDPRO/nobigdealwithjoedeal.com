# Overnight landing audit - second pass (2026-10-23)

Follow-up to [OVERNIGHT-LANDING-AUDIT-2026-10-23](OVERNIGHT-LANDING-AUDIT-2026-10-23.md). Read-only audit of everything merged after `6c208c30` up to `6126b087`, plus a recheck of the first pass's open items. Fixes are filed as separate PRs by the owning sessions; this PR changes only docs.

## Deploy and live status

Latest successful `Firebase deploy` run on main: `6ea6266b`. Verified ancestors of that run: b3972f54 (photo purge), 5a2757f8, 1499145c, be26e388 (saved views), 56015b8e (storm outreach), c8a2eeb4 (messaging honesty), 42f97e3d (pro demo fix), 6ea6266b. The individual runs for several of these were cancelled as superseded (0 jobs), which is expected under `concurrency: firebase-deploy`; the later successful run covers them. Docs-only commits (6126b087, 5c589711) need no deploy.

Live bytes (fetched read-only, minified, compared by marker string): `nbd-auth.js` deletes `nbd_ds_photos`; `call-center-filters-logic.js` carries "Missed today" / "Unhandled this week"; `/pro/sandbox` links to `/pro/explore`. #2690 and #2689 were not checked on the live site (authed surfaces); their commits are covered by the green deploy. The 6c208c30 theme-sweep deploy finished green (first-pass open item closed).

Silent-revert check: every commit since a543f40c was checked for added lines missing from main. The only real loss was #2686 (5a2757f8, a stale squash) reverting #2676 `lead_sources` confirmedSource; #2694 restored it (verified by diff stat). Other "missing" lines were superseded by later hardening (version bumps, accent and call-center follow-ups). Lesson: a squash built from a stale base can silently undo a merged PR; the revert check is cheap and worth repeating.

## #2684 photo purge - re-test on the local emulator (main 1499145c)

| Check | Result |
|---|---|
| A adds a photo, `NBDAuth.logout()`, B logs in: B sees none, `nbd_ds_photos` gone | PASS |
| Same script on the pre-fix tree | FAIL as expected (positive control) |
| Strip guard on stored bytes (real GPS + XMP + COM JPEG) | PASS; `tests/tracker-photos-account-purge-2026-10-23.test.js` 18/18 |
| Account switch WITHOUT `NBDAuth.logout()` (plain signOut, B logs in through the login page) | **FAIL - High** |

The failing path: `docs/pro/js/dashboard-bootstrap.module.js` (~1635-1641) purges only `if (window.NBDAuth && typeof window.NBDAuth.purgeAccountStorage === 'function')` and then records the new `nbd_last_uid`. When `NBDAuth` is not assigned yet the purge is silently skipped and `nbd_last_uid` is already B's, so the second defence (`accountSwitched` in `ds-firebase-sync.js`) never fires either. It affects the whole purge (cached leads, PII), not just photos, and it predates the photo work. Observed on emulator auth with a local static server; production frequency unknown. Fix open: #2695 "shared-device purge fails closed" (not reviewed beyond its title; re-run the emulator repro after it merges).

## Reviewer results on what landed

No Critical. Findings that remain after excluding items already covered by open PRs (#2695 purge, #2698 Missed -> Short calls, #2702 /book contrast, #2707 sync pill):

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | Medium | Monday owner digest prints "Jobs on the calendar this week: none" when the jobs collection-group query fails (`jobsByLead` catches and returns null, treated as "none"). A false statement filed to the owner's inbox. | `functions/owner-weekly-digest.js` 34-40, 70-76; `owner-weekly-digest-logic.js` 116 |
| 2 | Low-Medium | Digest truncates at `MAX_TEXT` with the Jobs section last and no "+N more" marker; `deal_rooms` read by `userId == companyId` understates "awaiting signature" for team companies; `companies.limit(500)` drops tenants beyond 500. | same files |
| 3 | Low-Medium | Storm Outreach tab keeps the previous account's customers and drafts in module state across a same-tab account switch (`state.data`, `state.picked`; `load(false)` returns early when ready). The server re-checks tenancy, so this is a display/PII leak, not a cross-tenant write. | `docs/pro/js/storm-outreach-ui.js` 24, 129-134 |
| 4 | Low | Storm filing reads opt-out with `.catch(() => null)`, so a failed read lets a draft be filed (send re-checks opt-out). | `functions/agent-mcp.js` 943, 874 |
| 5 | Low | `fileStormOutreachDrafts` does not apply the 14-60 day age cutoff the list call uses; neither callable has a rate limit. | `functions/agent-mcp.js` 927-928, 968-969 |
| 6 | Low | `lead_sources` returns free-text `source`/`marketingSource` as row keys: a prompt-injection surface for the MCP bots (existing behaviour; bots can only draft). | `functions/agent-mcp-logic.js` 638, 648 |
| 7 | Low (unverified) | Lead-source fixer's in-memory patch omits `confirmedSourceAt`, which the rules require to equal request.time when the other confirmedSource fields differ. | `docs/pro/js/lead-source-fixer.js` 371 |
| 8 | Question | Company admins can read the owner digest (revenue figures) in `agent_inbox` per the rules. Confirm intended. | `firestore.rules` 2622-2625 |

Clean (read-only, by code): storm outreach callables are admin-only with App Check, tenant-scoped from the auth claim, rebuild wording server-side, and write only `status: 'pending'` drafts with `create()` (nothing sends); the UI escapes every customer string and uses delegated listeners; `confirmedSource` is whitelisted and tenant-scoped; messaging shows provider-accepted as amber "sent", green only for "delivered"; the finished-job card and end-of-day review are client-side and escaped; the admin Site-address column is admin-only and read-only. Refuted: the worry that Daily Success toasts are no-ops (`/pro/js/toast.js` is loaded on that page). The coach overlay now has `role="dialog"` (a11y PR); Escape and focus behaviour were not retested.

Limits: the reviewers had Read/Grep/Glob only, no per-PR diffs, no test runs; nothing above is test-verified.

## Fix PRs and ownership

- #2695 purge fails closed - open (High, shared-device account switch).
- #2698 Missed -> Short calls - open (Medium).
- #2702 /book contrast - open (Medium); #2706 was a duplicate and was closed.
- #2707 sync pill + workout sync isolation - open (Medium); red-first test (5 of 15 failed unfixed, 15/15 after).
- Not yet filed: finding 1 (digest false "none"), 3 (Storm tab cache), and 2, 4-7; also `docs/free-tools/index.html` carries its own inline `.tool-cta` rule with the same contrast pattern as /book (held until #2702 merges).
- Needs Jo, not code: the James Hardie Alliance and American Operator membership claims on the home page, /review and the siding guide (see the first-pass note).

## Still not verifiable by automation

Authed production behaviour; the Cal.com alert end to end (needs the Functions emulator, which can send); whether #2695 closes the purge race at production timing.

## Addendum (2026-10-23 evening): fixes verified after merge

Deploy proof (ancestor of a surviving successful `Firebase deploy` run): 809ca30d (#2707 sync pill), 3a99e6d9 (#2702 /book contrast) and 673ac154 are covered by the success run for 673ac154; 50a0d4dc (#2695 purge fails closed) is covered by the success run for debc4ada. Several of those commits' own runs were cancelled as superseded, as expected.

Live markers (read-only fetch): the Daily Success page loads `ds-firebase-sync.js?v=6` and the script carries "Sync error"; `/book` serves the new `.tool-cta` rule using `--card-accent-text` (#2702 used that variable, not `--card-text` from the closed duplicate #2706); `dashboard-bootstrap.module.js` carries the fail-closed marker `nbd_d2d_queue_last_known_size`. Contrast ratios were not re-measured on the live page; #2702's test asserts at least 4.5:1.

Account-switch repro on the local emulator at main 5205d984 (includes 50a0d4dc), reusing the first-pass scripts:

| Scenario | Result |
|---|---|
| Logout path (`NBDAuth.logout()`) | PASS: photos DB gone, B sees none |
| Switch WITHOUT logout, 3 plain runs | PASS 3/3 (before the fix, 1499145c: FAIL) |
| Same, nbd-auth.js delayed 1.5 s, also with 6x CPU throttle, and delayed 7.5 s (past the 5 s wait) | PASS 3/3: `purgeAccountStorage` ran first, then `nbd_last_uid` advanced to B |
| nbd-auth.js blocked permanently, wait on the dashboard 7.5 s | PASS: purge never ran, `nbd_last_uid` stayed on A, dashboard fail-closed clear removed the photos |
| nbd-auth.js blocked permanently, user leaves the dashboard within 5 s | **FAIL (residual, Low-Medium)**: `nbd_last_uid` stays on A, but A's photo DB survives and B sees A's photos on Daily Success |

The residual needs nbd-auth.js to fail to load at all and an account switch followed by leaving the dashboard inside the 5 s wait. The sync side pauses rather than clearing the DB. Suggested follow-up: have Daily Success clear `nbd_ds_photos` itself when the purge is unavailable. The "Sync paused" badge text was not captured in any run.

The #2707 sync-pill fix, the #2702 /book fix and the #2695 purge fix are therefore verified live; the owner-digest false "none" fix is #2714 (queued at the time of writing).

## Update 2026-10-24: where each remaining finding landed

| # | Finding | Outcome |
|---|---|---|
| 1 | Digest false "none" | Fixed in #2714 (merged 10-23). |
| 2 | Digest truncation / `deal_rooms` team undercount / `companies.limit(500)` | Truncation marker fixed in #2714. **Fixed 2026-10-25** (the rest): a deal room carries only its creator's `userId`, and the reps are the distinct `userId`s on the company's own leads, so `owner-weekly-digest.js` (`dealRoomsOf`) and `agent-mcp.js` (`companyDealRooms`, used by `estimates_status` and `closes_this_week`) read rooms for the company uid plus each rep uid; a uid that owns none of the company's leads is never read. `runDigest` pages companies by document id. Pins: `tests/owner-weekly-digest-2026-10-22.test.js` (a rep's proposal counts, a stranger's does not, 503 companies all visited) and the `agent-mcp-more-tools` source pin. |
| 3 | Storm Outreach tab keeps the previous account's state | Fixed in #2716. |
| 4 | Storm filing reads opt-out with `.catch(() => null)` | **No change needed**: `textGate` treats a null result as "the Do-Not-Text list could not be checked" and skips the lead (fails closed). #2716 pins it with a failing-read test. |
| 5 | Storm callables: no age cutoff at filing, no rate limit | Cutoff fixed in #2716. Rate limits added 2026-10-24 (`listStormOutreach` 30/min, `fileStormOutreachDrafts` 10/min via `shared.callableRateLimit`), test section G in `tests/storm-outreach-2026-10-22.test.js`. |
| 6 | `lead_sources` free-text keys as a prompt-injection surface | **Hardened 2026-10-25**: `sourceKey()` in `agent-mcp-logic.js` makes every row key one printable line of at most 80 characters (control characters and newlines collapse to a space); a lead and an expense with the same raw text still share a row. The bots still only draft. Pin: `tests/lead-sources-confirmed-2026-10-22.test.js`. |
| 7 | Lead-source fixer's in-memory patch omits `confirmedSourceAt` | **No failure path found**: the rules only check the four fields when one changes, and no client code writes a whole lead back (the only `setDoc` on `leads/` is the jobs subcollection). Left as is. |
| - | `/free-tools` `.tool-cta` contrast (same as /book) | Fixed 2026-10-24, `tests/free-tools-contrast-2026-10-24.test.js`. |
| 8 | Company admins can read the owner digest's revenue lines | Still Jo's question (rules 2622-2625). |
