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
