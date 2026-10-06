# NEXT SESSION — 2026-08-26

Handoff from the backlog-clear/prune session
([session note](SESSION-2026-08-26-backlog-clear-and-prune.md)). Written
**mid GitHub Actions outage** (major, database-primary failover, began
~15:05Z): five locally-green PRs are parked awaiting CI, and §0 is the exact
recovery sequence. If the same session that wrote this executed the merges
before closing, §0 is done — check the PR states before redoing anything.

## §0 — THE LIVE ITEM: the merge queue (execute at Actions recovery, in order)

First: confirm main's queued post-#1273 CI run went green, and that #1273's
**Firebase deploy** ran (it bumps functions deps → full functions deploy; the
pipeline is hardened, but look at the run, don't assume).

Merge order matters — #1279 rewrites the promotion pins that #1281's conflict
resolution depends on. No required checks on main (`--auto` merges
immediately — poll checks yourself):

1. **#1279 — advisory flip** (3 commits: flip + zero pins + line-anchored
   pins). Verify its CI green, merge. Every ci.yml job now blocks.
2. **#1253 — storage-orphan rescue.** CI green → merge. Post-merge, the new
   `onLeadDeleted` trigger + `getDocumentHtml` callable deploy — verify both
   appear in the deploy run (deploy-list discovery covers Firestore triggers
   since #1210, but this is a new trigger type on this codepath: confirm).
   The prod orphan sweep (`scripts/sweep-orphan-lead-artifacts.js`, the 10
   known orphans) is a SEPARATE, Jo-authorized prod action — the PR only
   ships the tooling.
3. **#1255 — quota runbook** (docs-only). Merge.
4. **#1280 — pro auth fonts.** CI green → merge. Post-deploy: curl the live
   pages once — both should serve zero `fonts.googleapis` references.
5. **#1281 — ci-suite-runner. LAST, with two known reconciliations** (both
   proven in the session's dry-run):
   - Merge main into the branch. `ci.yml` auto-merges. The one conflict is
     `tests/gauntlet-regressions.test.js`: keep **#1279's zero-pin block**
     (comment + single line-anchored assert) AND **the lane's two-fact bucket
     assertions** (manifest classification + ci.yml runs the bucket); both
     superseded forms (count-4 pins, filename grep) drop.
   - `tests/ci-manifest.json` conflicts with #1253's addition: re-add
     `orphan-sweep-parser.test.js` into the lane's restructured **node**
     bucket (should end 123 suites, node:44).
   - Before pushing the merge: `node tests/gauntlet-regressions.test.js` ·
     `node scripts/run-test-manifest.js --check` · `--bucket smoke` ·
     `--bucket node` · `node tests/smoke.test.js` · YAML parse. All were
     green on the dry-run equivalent.
6. **#1282 — this archive** (docs-only). Last on purpose: two of its links
   (the quota runbook, the orphaned-storage audit) resolve only once #1255
   and #1253 have landed.

Then the advisory-flip aftermath: the next few main merges run with every job
blocking for the first time — watch the first one or two rather than assuming.

## Jo's queue (carried from 08-25 unless struck; nothing new is blocking)

1. **Text the Lexington caller** `/areas/lexington-ky` + both posts.
2. **GBP service area**: add Lexington, Georgetown, Nicholasville, Winchester,
   Richmond, Versailles.
3. **LFUCG call** — (859) 258-3770, the reroof-permit question
   ([runbook](../runbooks/LEXINGTON-CONTRACTOR-SETUP.md)).
4. **Cal.com finish steps**: ~~NBD Pro → Settings → Profile → username
   `nobigdeal`~~ **DONE 2026-08-28**; still yours: revoke the session API key
   if it has no expiry. (Correction 2026-08-28: these config steps were never
   the whole gap — the webhook had no code path that created a lead for a
   first-time booker, so cold bookings were silently dropped until #1288. See
   [SESSION-2026-08-28-calcom-lead-drop](SESSION-2026-08-28-calcom-lead-drop.md).)
5. **Send Scott the CURRENT Oaks zip** (7-Zip, not Compress-Archive).
6. **2 blog drafts** still need your `JO:` inputs
   ([drafts README](../drafts/README.md)).
7. ~~**Clear the address-audit gate**~~ **DONE 2026-08-27** (Jo-delegated):
   four $0 leads retired, Customer BN written fully mailable (the blocker was a
   Murdoch→Murdock road-name typo). Gate confirmed green by replicated scan
   — [CRM-ADDRESS-INTEGRITY-2026-08-18](../audit/CRM-ADDRESS-INTEGRITY-2026-08-18.md)
   §2026-08-27.
8. **Cloud Run CPU quota request** — the runbook lands with #1255
   ([CLOUD-RUN-CPU-QUOTA-REQUEST](../runbooks/CLOUD-RUN-CPU-QUOTA-REQUEST.md));
   when granted, set `NBD_DEPLOY_WAVE1_MAX` back to `"0"`.
9. Parked on your call since June: `chore/stripe-pin-harden` (branch kept,
   worktree pruned) — needs your Stripe TEST-MODE verify, or a decision to
   drop it.

## Open engineering lanes (none urgent)

- **Fonts phase 2**: ~25 more /pro pages still load Google Fonts externally
  (dashboard/customer/theme-preview long tail). Same recipe as #1280;
  requested∩used weights; page-scoped CSP tightening as pages migrate; the
  global CSP's font hosts come out only when the last page is done. Note
  #1280 already removed the known sandbox-E2E timeout cause for login/register.
- ~~**Prod orphan sweep run**~~ **EXECUTED 2026-08-26, same evening**
  (Jo-authorized): 0 orphans (the trigger landed before it was ever needed),
  and 8 window-period invoices found carrying permanent public tokens — all
  revoked (Jo-approved; verified by re-count and a 403 on a revoked URL).
  Result section appended to
  [ORPHANED-STORAGE-ARTIFACTS-2026-08-18](../audit/ORPHANED-STORAGE-ARTIFACTS-2026-08-18.md).
  Still open there: the 2 tokened d2d audio files (hand-review class).
- Carried, still gated: Central KY phase 2 (needs a Lexington job), blog
  series (needs call facts), email-ingest build (scoped 08-17, not started).

## Housekeeping state (so nobody re-derives it)

- **Worktrees: 3** — primary, `nbd-wt-ledger-recon` (main),
  `nbd-wt-enable-step` (#1255; retire after it merges — junction-check first).
  ciglob retired; the ci-suite-runner lane lives on `lane/ci-suite-runner`
  (PR #1281).
- **Local branches: 8** — main, the five PR branches, `chore/stripe-pin-harden`,
  plus this archive's own branch (prunable once merged). ~140 were deleted on
  content-level evidence (session note §4), including all six former
  stragglers. Origin branches were left alone.
- The prune's standing lessons: `git worktree remove` deletes THROUGH a
  node_modules junction (scan → read → unlink → verify → then remove, as two
  gated steps — memory updated); and a stale branch can be worse than dead
  code — the July money-ledger draft would have reintroduced the bug it fixed
  via a field-vocabulary mismatch. Content-level checks or it didn't land.

## Standing rules touched this session

- Promotion pins are twins (`gauntlet-regressions` + `smoke/functions`); any
  ci.yml gating change updates BOTH, and the pins are line-anchored to the
  YAML key so doctrine comments may name the flag.
- Verify hosting behavior on a preview channel/emulator, never `firebase
  serve` (it ignores redirects — the /sites/oaks sweep artifact), and never
  by reading config.
