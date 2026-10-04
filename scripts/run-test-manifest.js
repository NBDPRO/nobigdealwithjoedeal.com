#!/usr/bin/env node
/*
 * run-test-manifest.js — manifest-driven suite runner + orphan tripwire.
 *
 * Why: ci.yml hand-listed suites, and 35 of them — including every money/
 * pricing suite BIG_ROCKS calls "the canonical reference" for Rock 2 — were
 * never listed, so they existed without ever gating a merge (found in the
 * 2026-08-07 stability audit). Hand-listing reproduces the failure mode this
 * fixes, so the manifest is the single registry:
 *
 *   tests/ci-manifest.json buckets:
 *     node                — RUNNABLE. unit-suite-manifest job.
 *     smoke               — RUNNABLE. smoke-tests job. Object-valued:
 *                           each suite carries its step documentation.
 *     emulator            — run as individual emulators:exec steps in ci.yml
 *     wired-individually  — suites a workflow runs by name (unchanged)
 *     quarantined         — known-red, skipped, dated reason required
 *   Current sizes are not repeated here — they rot (this header said 44
 *   node suites while the bucket held 96). FLOORS below is the one copy,
 *   and --check prints the live counts.
 *
 * COMPLETENESS: every tests/*.test.js on disk must appear in exactly one
 * bucket, else exit 1. Adding a test file without classifying it fails CI —
 * a new suite can never be silently orphaned again.
 *
 * 2026-08-23: the smoke-tests job's 65 hand-written `node tests/X.test.js`
 * steps collapsed into one `--bucket smoke` invocation, because a red step
 * aborted the job and hid the other 64 results. Two consequences drove most
 * of the hardening below:
 *   - One aggregated step is now the single point where 65 suites can be
 *     de-gated by a one-line JSON edit, so the workflow-presence check had to
 *     stop being "the suite name appears somewhere in YAML" (satisfiable by a
 *     COMMENT) and become "the step that runs the bucket exists, is not
 *     neutered, and the bucket has not shrunk" — see checkRunnableWiring().
 *   - Aggregating means a suite can now fail without the job stopping, so the
 *     runner must not be able to report green while running fewer suites than
 *     it classified. Hence the ran/queued reconciliation and the output scan.
 *
 * Run: node scripts/run-test-manifest.js                  (completeness + node bucket)
 *      node scripts/run-test-manifest.js --bucket smoke   (completeness + smoke bucket)
 *      node scripts/run-test-manifest.js --check          (completeness only, fast)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const manifest = JSON.parse(fs.readFileSync(path.join(TESTS, 'ci-manifest.json'), 'utf8'));

// Buckets this script executes. Anything else is a classification-only bucket.
const RUNNABLE = ['node', 'smoke'];

// Ratchet. A bucket may grow but never silently shrink: these floors are the
// measured sizes at the last deliberate raise. They live in the script rather
// than the manifest on purpose — a one-line JSON edit must not be able to
// lower the bar it is being measured against.
//
// SET these to the counts --check prints, in the same commit that adds a
// suite. SET, not increment: a +1 for the suite you personally added is the
// exact bug this line has already shipped three times. The slack between a
// floor and the real count IS the number of suites that can be deleted (file
// plus manifest entry) with this check still green, so a floor is worth only
// what the last person to touch it actually measured.
//   2026-09-03  e0eb64b6, the last commit where the floors equalled reality
//               (51/65/130).
//   2026-09-03..06  three edits raised them to 52, then 53, then 54 — one per
//               suite the author happened to be adding — while the real node
//               count was already 66, then 73, then 75. Maintenance-shaped,
//               and it bought nothing.
//   2026-09-07  31 suite-adding commits after e0eb64b6, the floors still read
//               54/65/133 against a real 96/65/179: 42 node and 46 disk of
//               slack, a quarter of the node bucket deletable while green.
//               Measured, not assumed — deleting a node suite outright still
//               exited 0. Raised to the true counts at 5a43d2c4, and each
//               floor break-tested by removing a suite and watching THAT
//               bucket's line go red.
//               The n > floor branch below landed in the same change.
//
// Why these stay literal instead of being derived from the manifest: a floor
// computed from the live manifest always equals the count it is compared
// against, so "n < floor" could never be true and the ratchet would be
// structurally incapable of failing — the silently-green gate this file
// exists to prevent. The number has to be committed by a human to be a bar at
// all. The staleness that costs is handled from the other side instead: the
// ratchet below fails when n > floor too, so adding a suite reddens this
// check until the floor moves with it in the same commit. That is the point,
// not a nuisance — the error prints the exact literal to paste, and this
// 2026-09-07 entry should be the last of its kind.

//   2026-09-08  four portal branches each raised these; this is the value
//               MEASURED after all of them landed, not any one branch's
//               delta added to another's.
//   2026-09-08  the nav branch (tests/nav-contract.test.js) then collided with
//               those portal branches TWICE in one afternoon, exactly the way
//               this ledger warns about: both sides had raised the literal and
//               git could not reconcile them. Resolved both times by
//               re-measuring the MERGED tree. Note the second collision landed
//               both sides on the SAME literal by coincidence — which is the
//               strongest argument for measuring rather than reasoning, since
//               a matching number is not evidence the count is right.
//   2026-09-08  +2 from the photo-report lane (#1483). MEASURED on the merged
//               tree, not 101+2 by arithmetic — same rule as above.
//   2026-09-08  nav + photo-report merged. FOURTH collision on this line in
//               one afternoon; every one was two branches raising it
//               independently. MEASURED on the merged tree via --check, which
//               prints the literal to paste — the only reliable way to set it
//               when `main` moves this often.
//   2026-09-08  104/65/187 after portal-completion-truth landed on top of the
//               photo-report suites. SET from what --check printed against the
//               CURRENT main — an earlier measurement on a stale base said 102
//               and would have left slack the moment this rebased.
//   2026-09-08  FIFTH collision, and the one that proves the rule: both sides
//               of this rebase carried the SAME literal (104/65/187), so the
//               numbers did not conflict and only the comments did. Merging
//               them anyway would have shipped a stale floor — the merged
//               tree measures 105/188. A matching number is not evidence.
//   2026-09-08  SIXTH collision, session-revocation lane. Same story: both
//               sides had raised it. Re-measured on the merged tree rather
//               than adding this branch's +1 to main's figure.
//   2026-09-08  SEVENTH collision, renderPdf lane (+2 smoke suites), landing
//               on top of the session-revocation raise above. Both sides had
//               moved the literal again. MEASURED on the merged tree via
//               --check; neither side's number was adjusted by hand.
//   2026-09-08  107/67/192 after portal-scheduled-date landed. MEASURED from
//               --check on this branch's merged base, not 106+1.
//   2026-09-08  NINTH collision, pdf-renders retention lane
//               (tests/pdf-render-retention.test.js). This branch rebased
//               FOUR times in one evening and hit this line every time; the
//               entries it wrote called themselves SEVENTH and then EIGHTH
//               before other lanes took those slots while it sat unmerged, so
//               the ordinal here is the only part that was ever guesswork.
//               MEASURED on the merged tree each time. Twice the danger was
//               not the node count but SMOKE: this lane adds no smoke suite,
//               and a +1 on its own figure would have carried a stale 65 back
//               over main's 67. If you take one thing from nine entries: this
//               line is a serialisation point for every lane that adds a test
//               file, so re-measure after the rebase and merge promptly.
//   2026-09-13  109/67/194, Cal.com phone lane
//               (tests/calcom-webhook-payload.test.js). MEASURED via --check
//               on a branch cut from origin/main at 9496f859. PR #1534
//               (favicons) raises this line to the SAME literal from the same
//               base — a matching number is not agreement: whichever merges
//               second must re-measure (expect 110/67/195 with both).
//   2026-09-13  109/67/194, favicon lane (tests/favicon-contract.test.js).
//               MEASURED via --check on a branch cut from origin/main at
//               9496f859. Open PRs #1518 and #1499 also add node suites; if
//               either merges first, re-measure the merged tree.
//   2026-09-13  MERGED TREE (favicon branch + #1535): both sides carried the
//               SAME literal 109/67/194, so git merged the number without a
//               conflict and only these comments collided — the exact case the
//               entries above warn about. Set from --check on the merged tree.
//   2026-09-13  110/67/195, Cal.com lead-alert lane
//               (tests/lead-alert-calcom.test.js). MEASURED via --check on a
//               branch cut from origin/main at 954e7331 — main already held
//               109/67/194. The same literal as #1534's expected pair-total is
//               a coincidence of +1s, not a merge of the two: #1534 and #1539
//               both move this line too, so whichever lands after this one
//               re-measures.
//   2026-09-13  MERGED TREE again (favicon branch + #1537 + #1540): both sides
//               carried 110/67/195 — the same literal a second time in one day.
//               Set from --check on this merged tree, not from either side.
//   2026-09-13  110/67/195, lead-form phone lane
//               (tests/lead-form-phone-contract.test.js). MEASURED via --check
//               on a branch cut from origin/main at 954e7331 (#1535). PR #1534
//               also lands at 110/67/195 from a different base — the same
//               literal again, so whichever merges second re-measures (111/67/196).
//   2026-09-13  MERGED TREE (lead-form branch + #1534): main held 111/67/196,
//               this branch 110/67/195; the literal below is what --check
//               printed on the merged tree.
//   2026-09-13  push Call-phone lane (tests/push-lead-call-phone.test.js).
//               Rebased THREE times: onto 5ec2021b (#1540), e9555d35 (#1534),
//               then f02d6111 (#1539). Every time main had independently raised
//               this line to the exact literal the branch carried — 110/67/195,
//               111/67/196, 112/67/197 — so only the comments conflicted.
//               RE-MEASURED via --check on the final rebased tree each time;
//               the last one printed 113/67/198.
//   2026-09-13  113/67/199, appointments-cleanup lane
//               (tests/lead-artifact-cleanup.integration.test.js). node/smoke
//               unchanged — this is a 'wired-individually' emulator suite, so
//               only disk moves. MEASURED via --check on a branch cut from
//               origin/main at d7506665 (#1543).
//   2026-09-13  google-reviews lane (tests/google-reviews-not-configured.test.js),
//               rebased onto main at d7506665 after sitting unmerged since
//               09-08 — every intervening lane above had already raised this
//               line without this branch. RE-MEASURED via --check on the
//               final rebased tree rather than adding this lane's +1 to
//               113/67/198; smoke stays 67, this lane adds no smoke suite.
//   2026-09-13  MERGED TREE (appointments-cleanup lane + google-reviews lane):
//               both cut from d7506665 and both raised this line independently
//               — appointments-cleanup added a disk-only 'wired-individually'
//               suite, google-reviews added a 'node' suite. Neither side's
//               number was carried forward by arithmetic; re-measured via
//               --check on the rebased tree.
//   2026-09-15  main gained one 'node' suite since the last bump (found by
//               `--check` failing red on an unrelated PR — this fix carries
//               no product change, just re-measures the tripwire on main's
//               current tree, same class of drift as the entry above).
//   2026-09-15  128/67/214 → 129/67/215, tests/render-pdf-brand-mark-square.test.js
//               (the render-pdf logo-crop hotfix — a live bug where every
//               server-rendered PDF's brand mark was illegible since #1570).
//   2026-09-15  EIGHTH collision, same story as the ones above: the
//               paperwork-filing lane independently raised 128/67/214 to the
//               SAME 129/67/215 literal as the render-pdf hotfix above (both
//               added exactly one node suite from the same base) — a
//               matching number that is, per the 2026-09-08 entry's own
//               warning, not evidence it's still correct once REBASED onto
//               the other side's commit. Re-measured on the merged tree via
//               --check: 130/67/216.
//   2026-09-15  NINTH collision: the Kanban filter unification lane
//               (tests/kanban-filter-unification.test.js) independently
//               raised the SAME 129/67/215 base to 130/67/216 as the
//               EIGHTH entry above — again a matching literal that is not
//               evidence, since this rebase stacks BOTH lanes' new suites
//               onto the same merged tree. Re-measured via --check:
//               131/67/217.
//   2026-09-15  131/67/217 → 132/67/218, tests/warranty-claim.test.js (the
//               Warranty Claim lane — the third and final piece of the
//               original three-lane CRM streamlining ask, after Collections
//               and Paperwork Filing).
//   2026-09-15  132/67/218 → 133/67/219, tests/customer-audit-integrity.test.js
//               (the forgeable customerAuditEvents resourceId fix + the
//               document_view coverage gap in the customer audit trail).

//   2026-09-15  TENTH collision: the photo-report-sharing lane (#1499,
//               unmerged since 2026-09-08) rebased onto this tree adds one
//               more node suite (tests/photo-report-sharing.test.js) on top
//               of 132/67/218. Re-measured via --check on the merged tree
//               rather than adding this lane's own stale +1 by hand.
//   2026-09-15  ELEVENTH collision: the health-digest usage-signals fix
//               rebased on top of the photo-report-sharing lane adds one
//               smoke suite (tests/health-digest-usage-signals.test.js).
//               Neither side's literal alone was right for the merged tree
//               (133/67/219 missed the new smoke suite; 132/68/219 missed
//               the new node suite) — re-measured via --check on the
//               rebased tree per this ledger's own rule.
//   2026-09-15  TWELFTH collision: the customer-audit-integrity lane
//               (forgeable resourceId fix + document_view coverage) adds
//               one node suite on top of 133/68/220. Re-measured via
//               --check on the merged tree.
//   2026-09-15  THIRTEENTH collision: the createCompany admin-claim-guard
//               lane independently adds one node suite from the SAME
//               133/68/220 base as the customer-audit lane above — both
//               landed on the literal 134/68/221 by coincidence, which is
//               not evidence either alone was right for a tree carrying
//               both. Re-measured via --check on the merged tree: both
//               suites present pushes this to 135/68/222. Both now merged.
//   2026-09-15  FOURTEENTH collision: the funnel-recovery hardening lane
//               (double-send stamp-before-send, per-email throttle,
//               unsubscribe link, heartbeat fix) independently adds one
//               node suite from the original 133/68/220 base. Re-measured
//               via --check on this tree (both lanes above already merged
//               into main + this lane's own suite): 136/68/223. Merged.
//   2026-09-15  FIFTEENTH collision: the adjuster-board cross-tenant
//               cache-leak lane (tests/analytics-card-cache-account-switch.
//               test.js + tests/adjuster-board-handler-tenancy.test.js, both
//               pure-Node) independently adds two node suites from the
//               original 133/68/220 base. Re-measured via --check on this
//               tree (three lanes above already merged + these two new
//               suites): 138/68/225. Merged.
//   2026-09-15  SIXTEENTH collision: the anniversary-touch stage-roles lane
//               independently adds one node suite from the SAME original
//               133/68/220 base as the adjuster-board lane above. Re-
//               measured via --check on this tree (four lanes above
//               already merged + this one); landed on 154/68/242 by the
//               same base the esign lane below also started from — see
//               SEVENTEENTH for why that coincidence wasn't trusted.
//   2026-09-17  SEVENTEENTH collision: the esign rotation/optional-fields/
//               revoked-message lane (tests/esign-envelope-guards.test.js,
//               new; tests/esign-setup-placement.test.js, modified) was
//               merged and re-measured against main BEFORE anniversary-touch
//               (SIXTEENTH) landed, and both independently produced the
//               literal 154/68/242 from the same 153/68/241 base — a
//               matching number that is not evidence, per this ledger's own
//               rule. Re-measured via --check on the tree with BOTH lanes
//               merged (this esign lane's own suite + anniversary-touch's):
//   2026-09-18  fail-open FO-1 comms lane adds two node suites
//               (tests/d2d-followup-sms-optout.test.js,
//               tests/portal-share-no-double-send.test.js) on a 157/68/246
//               origin/main base. SET from --check on this tree; parallel
//               fail-open lanes branch from the same base, so re-measure on
//               the merged tree rather than trusting this literal.
//   2026-09-18  157/68/246 → 158/68/247, tests/unloaded-cache-gates.test.js
//               (fail-open FO-4: sample data / CSV import / seat picker acting
//               on an unloaded cache). MEASURED via --check on a branch cut
//               from origin/main; sibling fail-open lanes cut the same day
//               also move this line — whichever merges second re-measures.
//   2026-09-18  FO-2 destructive-false-success lane adds one node suite
//               (tests/failopen-destructive-false-success-2026-09-18.test.js)
//               on a 157/68/246 main. MEASURED via --check on this tree; if
//               a sibling fail-open lane lands first, re-measure the merged
//               tree rather than adding +1 to its literal.
//   2026-09-18  157/68/246 → 160/68/249, fail-open FO-3 lane (unhydrated
//               companyProfile writes): tests/pipeline-builder-hydration,
//               map-views-hydration, lead-trades-unknown. MEASURED via --check
//               on a branch cut from origin/main at 4007bbbd. Sibling FO lanes
//               cut from the same base will collide here — whichever merges
//               second re-measures the merged tree, per the entries above.
//   2026-09-18  157/68/246 → 158/68/247, SMS opt-out send-order lane
//               (tests/sms-send-optout-order.test.js, node). MEASURED via
//               --check on a branch cut from origin/main; other fail-open
//               lanes are open in parallel, so whichever merges second
//               re-measures the merged tree rather than adding +1.
//   2026-09-18  157/68/246 → 158/68/247, tests/strip-redundant-inline-css.test.js
//               (inline-CSS dedup slice 3a). MEASURED via --check on a branch
//               cut from origin/main at 4007bbbd. Other slice-3 CSS lanes are
//               open in parallel; whichever merges second re-measures.
//   2026-09-18  166/68/255 → 167/68/256, tests/leads-loaded-account-switch.test.js
//               (_leadsLoaded reset on a same-tab account switch; follow-up to
//               #1661/#1665). RE-MEASURED via --check on 2026-09-20 after
//               rebasing onto origin/main at 91705d78 (main alone: 166/68/255;
//               with this suite: 167/68/256), so these are the merged-tree
//               numbers, not a +1 carried over from the original cut.
//   2026-09-20  167/68/256 -> 168/68/257, tests/xactimate-human-readable.test.js
//               (Xactimate was JSON-LD-only on index.html and absent from
//               storm-damage.html). MEASURED via --check on a branch cut from
//               origin/main at 2d9deef5. PRs #1684 and #1685 each add one node
//               suite from the same base -- whichever merges last re-measures.
//   2026-09-20  168/68/257 → 169/68/258, tests/google-reviews-static-hooks.test.js
//               (homepage #reviews summary row hydrates from the live payload
//               instead of hardcoding 5.0/★★★★★). NINTH collision on this line
//               — and the THIRD where both sides carried the IDENTICAL literal
//               so only the comments conflicted, which is exactly why this
//               ledger says a matching number is not evidence. This branch and
//               #1686 both read 168/68/257 against different bases; #1686
//               landed first, so taking either side verbatim would have
//               shipped a floor one short. RE-MEASURED via --check after
//               rebasing onto origin/main at 7ec3e34b (main alone: 168/68/257;
//               with this suite: 169/68/258). #1685 still adds one more node
//               suite and will have to re-measure again on top of this.
//   2026-09-20  169/68/258 → 170/68/259, tests/homeowner-wall-links.test.js
//               (homepage photo wall links each card to its project page).
//               TENTH collision on this line, and the third in a single
//               session: #1686, #1684 and this branch were all cut from
//               2d9deef5 and all three independently read 168/68/257. Each
//               merge moved main, so the only correct number was the one
//               measured AFTER the previous merge — which is the whole point
//               of the ledger above. RE-MEASURED via --check after rebasing
//               onto origin/main at bb8d79b7 (main alone: 169/68/258; with
//               this suite: 170/68/259).
//   2026-09-20  170/68/259 -> 171/68/260, tests/careers-posting-parked.test.js
//               (the roofing-helper job posting was taken down; this pins that
//               the page stays reachable but advertises no employment terms).
//               MEASURED via --check on a branch cut from origin/main at
//               1b3a1398, with no sibling lane open on this line.
//   2026-09-21  171/68/260 -> 173/68/262, the Close Board lane: its own
//               per-uid storage suite (rebased from an older base) plus
//               tests/close-board-deferred-auth-repaint.test.js. TWELFTH
//               collision on this line; the branch carried a stale literal
//               from before this session, so main's ledger was kept and the
//               merged tree RE-MEASURED via --check after rebasing onto
//               origin/main at dd978b84. PRs #1688 and #1689 are open and
//               each read their own figure from a different base -- whoever
//               merges last re-measures rather than adding a delta.
//   2026-09-21  173/68/262 -> 174/68/263, tests/subcontracting-honesty.test.js.
//               THIRTEENTH collision. RE-MEASURED via --check after rebasing
//               onto origin/main once #1690 landed.
//   2026-09-21  FIFTEENTH collision on this line, and the fifth in one
//               session. RE-MEASURED after #1688 landed: 175/68/264.
//   2026-09-21  SIXTEENTH collision. The SMS outbox lane adds two node suites
//               (sms-outbox-client, sms-outbox-server). RE-MEASURED after the
//               nine PRs that landed ahead of it today: 177/68/266.
//   2026-09-25  182/68/271 -> 183/68/272, tests/upgrade-pricing.test.js
//               (Upgrades & Add-ons pricing core). MEASURED via --check on a
//               branch cut from origin/main at df8bca1f. Sibling upgrade lanes
//               are open the same day — whoever merges last re-measures.
//   2026-09-25  183/68/272 -> 184/68/273, tests/job-template-honest-paperwork.test.js
//               (Upgrades slice 0), the sibling that merged second.
//               RE-MEASURED via --check after rebasing onto #1756.
//   2026-09-25  184/68/273 -> 185/68/274, tests/estimate-gutter-source.test.js
//               (one gutter footage per job, Draw-tool decision 2), merged
//               third. RE-MEASURED via --check after rebasing onto #1758.
//   2026-09-25  185/68/274 -> 186/68/275, tests/draw-geom.test.js (draw lane
//               L1, the Drawing Tool's pure geometry module), merged fourth.
//               RE-MEASURED via --check after rebasing onto #1760.
//   2026-09-25  186/68/275 -> 187/68/276, tests/upgrade-price-settings.test.js
//               (Upgrades stage 2, lane "prices": Settings → Upgrade prices).
//               First cut from 66b2724a; RE-MEASURED via --check after
//               rebasing onto 99b84861 (#1761, which followed #1760). The
//               stage-2 card lane is open the same day — whoever merges last
//               re-measures rather than adding a delta.
//   2026-09-25  187/68/276 -> 188/68/277, tests/upgrades-builder-card.test.js
//               (Upgrades stage 2, lane "card"). RE-MEASURED via --check after
//               rebasing onto 7933ce35 (#1762, lane "prices", merged first).
//   2026-09-25  188/68/277 -> 189/68/278, tests/deposit-rule.test.js (the one
//               deposit rule, every surface). MEASURED via --check on a branch
//               cut from origin/main at 918af3d8 (#1763); RE-MEASURED on
//               9d4c82bc (#1764) with the review fixes — unchanged; whoever
//               merges last re-measures.
//   2026-09-25  189/68/278 -> 190/68/279, tests/draw-reticle-css-scope.test.js
//               (the Draw crosshair's stylesheet stays inert with its beta
//               switch off, #1766). MEASURED via --check after rebasing onto
//               322ccbc7 (#1773); whoever merges last re-measures.
//   2026-09-25  190/68/279 -> 191/68/280, tests/role-gate.test.js (the
//               viewer role is read-only client-side, #1776). MEASURED via
//               --check after rebasing onto 4ede37e7 (#1766); whoever
//               merges last re-measures.
//   2026-09-25  191/68/280 -> 192/68/282, tests/collection-group-paths.test.js
//               (node) + tests/invite-claim-path.integration.test.js
//               (emulator; disk only). MEASURED via --check on dda2597c
//               (#1776); whoever merges last re-measures.
//   2026-09-26  192/68/282 -> 193/68/284, tests/thursday-logic.test.js
//               (node; Thursday / Bland call pipeline) + tests/thursday-
//               pipeline.integration.test.js (emulator; disk only). MEASURED
//               via --check on a0515d8e (#1781); whoever merges last re-measures.
//   2026-09-26  193/68/284 -> 194/68/285, tests/thursday-ui-wiring.test.js
//               (node; Calls section, source selects, CSP media-src, widget gate).
//   2026-09-27  200/69/292 -> 202/69/294, tests/google-reviews-momentum.test.js
//               + tests/google-reviews-momentum-widget.test.js (node; "N new
//               reviews this month" from Google's count history). Stacked on
//               #1814's 200/69/292; MEASURED via --check; whoever merges last
//               re-measures.
//   2026-09-27  202/69/294 -> 204/69/296, tests/ky-insurance-contracts.test.js
//               + tests/ky-claims-wording-scan.test.js (node; Kentucky
//               insurance-job contracts, #1801). MEASURED via --check.
//   2026-09-27  204/69/296 -> 205/69/297, tests/lead-alert-thumbtack.test.js
//               (node; Thumbtack leads page Joe, #1784). MEASURED via --check.
//   2026-09-27  205/69/297 -> 206/69/298, tests/voice-intel-anthropic-key.test.js
//               (node; Voice Intel read an unregistered secret name, #1786).
//               MEASURED via --check.
//   2026-09-27  206/69/298 -> 207/69/299, tests/lead-task-writer-shape.test.js
//               (node; voicemail + Quick Add task shape, #1785). MEASURED via --check.
//   2026-09-27  207/69/299 -> 208/69/300, tests/viewer-callables.test.js
//               (Cloud Functions refuse a viewer's writes / sends / mints,
//               and every exported callable carries a verdict, #1780).
//               MEASURED via --check.
//   2026-09-27  208/69/300 -> 209/69/301, tests/check-js-syntax.test.js
//               (node; syntax gate page scan + per-file grammar, #1782).
//               MEASURED via --check.
//   2026-09-28  209/69/301 -> 209/70/302, tests/invoice-markpaid-stage.test.js
//               (smoke; full payment never moves a lead backward). MEASURED via --check.
//   2026-09-28  209/70/302 -> 209/71/303, tests/followup-local-day.test.js
//               (smoke; follow-up dates are local days). MEASURED via --check.
const FLOORS = { node: 344, smoke: 71, disk: 438 };

// ── Argument parsing ───────────────────────────────────────────────
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
let bucketArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--bucket') bucketArg = argv[i + 1] || '';
  else if (argv[i].startsWith('--bucket=')) bucketArg = argv[i].slice('--bucket='.length);
}
const die = (msg) => { console.error(msg); process.exit(1); };

// A workflow passing both flags would silently run nothing: --check exits
// before the run loop. Make the combination an error, not a no-op.
if (CHECK_ONLY && bucketArg !== null) {
  die('ARG ERROR: --check and --bucket are mutually exclusive (--check would exit before running the bucket).');
}
// A typo'd bucket would resolve to [] and exit 0 — green over zero suites.
if (bucketArg !== null && !RUNNABLE.includes(bucketArg)) {
  die('ARG ERROR: --bucket ' + JSON.stringify(bucketArg) + ' is not runnable. Runnable buckets: ' + RUNNABLE.join(', '));
}
const RUN_BUCKET = bucketArg === null ? 'node' : bucketArg;

// ── Bucket normalisation ───────────────────────────────────────────
// node + wired-individually are arrays; smoke, emulator and quarantined are
// objects (a suite's value carries its docs / npm script / quarantine reason).
const namesOf = (v) => (Array.isArray(v) ? v : Object.keys(v || {}));
const buckets = {
  node: namesOf(manifest.node),
  smoke: namesOf(manifest.smoke),
  emulator: namesOf(manifest.emulator),
  'wired-individually': namesOf(manifest['wired-individually']),
  quarantined: namesOf(manifest.quarantined),
};

// ── Completeness tripwire ──────────────────────────────────────────
const disk = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.js')).sort();
const seen = new Map();
for (const [bucket, files] of Object.entries(buckets)) {
  for (const f of files) {
    if (seen.has(f)) die('MANIFEST ERROR: ' + f + ' appears in both "' + seen.get(f) + '" and "' + bucket + '"');
    seen.set(f, bucket);
    if (!disk.includes(f)) die('MANIFEST ERROR: ' + f + ' is listed under "' + bucket + '" but does not exist on disk');
  }
}
const unlisted = disk.filter((f) => !seen.has(f));
if (unlisted.length) {
  console.error('MANIFEST ERROR: test file(s) not classified in tests/ci-manifest.json:');
  for (const f of unlisted) console.error('  - ' + f);
  console.error('Add each to a bucket (node / smoke / emulator / wired-individually / quarantined).');
  process.exit(1);
}

// ── Subdirectory + workflow coverage (2026-08-10 audit) ────────────
// The scan above is top-level *.test.js only, and the buckets are
// self-attesting — both gaps re-open the exact orphaning class this file
// exists to close. Five extra checks:
//
//   (a) every tests/smoke/*.test.js must be required by tests/smoke.test.js;
//   (b) every tests/e2e/*.spec.js must be named in tests/package.json or a
//       workflow file, or carry a dated entry in UNWIRED_SPECS below;
//   (c) every spec in the authed-emu file list must carry at least one @tag
//       that some ci.yml PLAYWRIGHT_GREP selects;
//   (d) every 'wired-individually' / 'emulator' suite name must appear on an
//       EXECUTABLE (non-comment) workflow line, and every runnable bucket must
//       have a live, un-neutered step invoking it;
//   (e) every suite in the smoke bucket must carry non-empty documentation.
const UNWIRED_SPECS = {
  'screenshot-demo.spec.js': 'manual demo-capture tool — deliberately unwired (2026-08-07 audit)',
  // A DIFFERENTIAL harness, not an assertion suite: it records typeof
  // window[name] + a source-hash for a name list and writes a JSON file. It
  // proves nothing on its own — the signal is diffing a run from BEFORE a
  // globals refactor against one from AFTER, which no single CI job can do
  // (one job, one tree). Wiring it into a shard would just produce a snapshot
  // nobody compares. Run it by hand around a globals change; the invocation is
  // in its header and in the T3-A slice-1 session note (2026-08-31).
  'globals-surface-snapshot.spec.js': 'manual before/after differential harness for globals refactors — a single unattended run has nothing to compare against (2026-08-31, Tranche 3 T3-A slice 1)',
};
const problems = [];
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const smokeAgg = readIf(path.join(TESTS, 'smoke.test.js'));
for (const f of fs.readdirSync(path.join(TESTS, 'smoke')).filter((f) => f.endsWith('.test.js')).sort()) {
  if (!smokeAgg.includes('smoke/' + f)) problems.push('tests/smoke/' + f + ' is not required by tests/smoke.test.js — it runs nowhere');
}
const wfDir = path.join(ROOT, '.github', 'workflows');
const wfFiles = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
const wfText = wfFiles.map((f) => readIf(path.join(wfDir, f))).join('\n');
// (d) haystack: executable lines only. A YAML COMMENT mentioning a suite name
// must not satisfy "this suite is wired" — measured 2026-08-23, exactly that
// would have kept catalog-cost-privacy.test.js green over a step that no
// longer ran it.
const wfExec = wfText.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const pkgJson = readIf(path.join(TESTS, 'package.json'));
// (c) source of truth for the shard tags. ci.yml sets
//   PLAYWRIGHT_GREP: ${{ matrix.shard }}
// — an unquoted expression, not a literal — so until 2026-10-03 the only
// extractor here (quoted PLAYWRIGHT_GREP literals) found NOTHING, and the
// `&& shardTags.length` guard below turned (c) into a silent skip. Two specs
// (boot-weight, tenant-filename-prefix) sat in the authed-emu list with no
// shard tag, never run by any CI shard, while this check printed "clean".
// So: read every `shard:` matrix list (flow `[...]` or block `- x` form,
// comments ignored), keep the quoted-literal path for any future step that
// greps a literal, and FAIL — never skip — when nothing is found.
function shardTagsFrom(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const stripComment = (s) => s.replace(/\s+#.*$/, '');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#/.test(lines[i])) continue;
    const m = lines[i].match(/^(\s*)shard:\s*(.*)$/);
    if (!m) continue;
    let body = stripComment(m[2]);
    if (body.trim().startsWith('[')) {
      while (!body.includes(']') && i + 1 < lines.length) body += ' ' + stripComment(lines[++i]);
    } else if (body.trim() === '') {
      const indent = m[1].length;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (/^\s*(#.*)?$/.test(next)) { i++; continue; }
        const item = next.match(/^(\s*)-\s+(.*)$/);
        if (!item || item[1].length < indent) break;
        body += ' ' + stripComment(item[2]);
        i++;
      }
    }
    out.push(...(body.match(/@[a-z0-9_-]+/gi) || []));
  }
  return out;
}
const greps = [...wfText.matchAll(/PLAYWRIGHT_GREP[^'"\n]*['"]([^'"]+)['"]/g)].map((m) => m[1]);
const shardTags = [...new Set([
  ...shardTagsFrom(wfText),
  ...greps.flatMap((g) => g.match(/@[a-z0-9_-]+/gi) || []),
])];
const hasTag = (src, t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9_-])', 'i').test(src);
// Parse, don't regex: the script value contains escaped quotes (\"node
// ./e2e/fixtures/seed-emulator.js && …\"), and the old /"([^"]+)"/ capture
// stopped at the first one — 165 chars, zero spec names — so (c) matched no
// spec at all even with tags in hand (found 2026-10-03, same audit).
let authedScript = '';
try { authedScript = (JSON.parse(pkgJson).scripts || {})['test:e2e:authed:emu'] || ''; } catch (_) { authedScript = ''; }
const authedSpecs = new Set(authedScript.match(/[\w.-]+\.spec\.js/g) || []);
const authedList = { includes: (f) => authedSpecs.has(f) };
if (!shardTags.length) {
  problems.push('no CI shard tags found — no `shard:` matrix list and no quoted PLAYWRIGHT_GREP literal in .github/workflows/. Check (c) cannot run; fix the extractor in scripts/run-test-manifest.js rather than letting it skip');
}
if (!authedSpecs.size) {
  problems.push('could not read any spec from the "test:e2e:authed:emu" script in tests/package.json — check (c) cannot run; fix the extractor in scripts/run-test-manifest.js');
}
for (const f of authedSpecs) {
  if (!fs.existsSync(path.join(TESTS, 'e2e', f))) problems.push('tests/package.json test:e2e:authed:emu names ' + f + ' but tests/e2e/' + f + ' does not exist');
}
for (const f of fs.readdirSync(path.join(TESTS, 'e2e')).filter((f) => f.endsWith('.spec.js')).sort()) {
  if (UNWIRED_SPECS[f]) continue;
  if (!pkgJson.includes(f) && !wfText.includes(f)) {
    problems.push('tests/e2e/' + f + ' appears in no tests/package.json script and no workflow — it runs nowhere (or add it to UNWIRED_SPECS with a dated reason)');
    continue;
  }
  if (authedList.includes(f)) {
    const src = readIf(path.join(TESTS, 'e2e', f));
    if (!shardTags.some((t) => hasTag(src, t))) {
      problems.push('tests/e2e/' + f + ' is in the authed-emu file list but carries none of the CI shard tags (' + shardTags.join(' ') + ') — no shard\'s grep ever selects it');
    }
  }
}
for (const f of [...buckets['wired-individually'], ...buckets.emulator]) {
  if (!wfExec.includes(f)) problems.push(f + ' is classified "' + seen.get(f) + '" but appears on no executable workflow line — the classification is self-attesting and the suite gates nothing');
}

// (d) continued — a runnable bucket is wired by ONE step, so that step is now
// load-bearing for every suite in it. Assert it exists and still fails the job.
function checkRunnableWiring(bucket) {
  const needle = new RegExp('run-test-manifest\\.js[^\\r\\n]*--bucket[= ]' + bucket + '\\b');
  for (const file of wfFiles) {
    const lines = readIf(path.join(wfDir, file)).split(/\r?\n/);
    const idx = lines.findIndex((l) => !/^\s*#/.test(l) && needle.test(l));
    if (idx === -1) continue;
    // Walk back to the owning "- name:" and forward to the next step at the
    // same indent, then assert nothing in the block neuters the exit code.
    let s = idx;
    while (s > 0 && !/^\s*-\s+name:/.test(lines[s])) s--;
    const indent = (lines[s].match(/^(\s*)-\s+name:/) || ['', ''])[1];
    let e = s + 1;
    while (e < lines.length
           && !new RegExp('^' + indent + '-\\s+name:').test(lines[e])
           && !new RegExp('^' + indent.slice(0, -2) + '\\S').test(lines[e])) e++;
    const block = lines.slice(s, e).filter((l) => !/^\s*#/.test(l)).join('\n');
    const n = buckets[bucket].length;
    if (/^\s*if:/m.test(block)) problems.push('the --bucket ' + bucket + ' step in ' + file + ' carries an "if:" — ' + n + ' suites would stop gating whenever it evaluates false');
    if (/continue-on-error:\s*true/.test(block)) problems.push('the --bucket ' + bucket + ' step in ' + file + ' is continue-on-error: true — ' + n + ' suites would stop gating merges');
    if (/\|\|\s*true/.test(block)) problems.push('the --bucket ' + bucket + ' step in ' + file + ' swallows its exit code with "|| true" — ' + n + ' suites would stop gating merges');
    return;
  }
  problems.push('no workflow has an executable step running "run-test-manifest.js --bucket ' + bucket + '" — all ' + buckets[bucket].length + ' suites in that bucket gate nothing');
}
for (const b of RUNNABLE) checkRunnableWiring(b);

// (e) documentation is a gated asset. The 23 KB of rationale that used to sit
// above each ci.yml step is the reason a reader can tell what a red suite
// protects; migrating it into the manifest only helps if it cannot rot away.
for (const [f, doc] of Object.entries(manifest.smoke || {})) {
  const lines = Array.isArray(doc) ? doc.filter((l) => String(l).trim()) : [];
  if (!lines.length) problems.push(f + ' is in the smoke bucket with no documentation — record why it gates merges (migrated verbatim from its former ci.yml comment)');
}

// Ratchet, both directions. UNDER the floor means suites were deleted. OVER
// it means the floor is stale — and the gap is exactly how many suites gate
// nothing, so it has to fail on the PR that opens it rather than sit quiet
// for 31 commits the way it did up to 2026-09-07.
const drifted = [];
for (const [b, floor] of Object.entries(FLOORS)) {
  const n = b === 'disk' ? disk.length : buckets[b].length;
  if (n < floor) problems.push(b + ' holds ' + n + ' suites but the gating floor is ' + floor + ' — suites were removed. Raise the floor deliberately in scripts/run-test-manifest.js if this is intended.');
  else if (n > floor) {
    drifted.push(b);
    problems.push(b + ' holds ' + n + ' suites but the floor is still ' + floor
      + ' — the floor is stale by ' + (n - floor) + '. That many suites gate nothing: they could be'
      + ' deleted, file and manifest entry both, with this check green. SET the floor to ' + n + '.');
  }
}
if (drifted.length) {
  // Print the whole literal, not a delta: "+1 for the suite I added" is the
  // mistake that produced floors of 52/53/54 against real counts of 66/73/75.
  problems.push('fix: replace the FLOORS line in scripts/run-test-manifest.js with  const FLOORS = { '
    + Object.keys(FLOORS).map((b) => b + ': ' + (b === 'disk' ? disk.length : buckets[b].length)).join(', ')
    + ' };');
}

if (problems.length) {
  console.error('MANIFEST ERROR: coverage tripwire(s):');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log('manifest: ' + disk.length + ' suites classified — node:' + buckets.node.length
  + ' smoke:' + buckets.smoke.length + ' emulator:' + buckets.emulator.length
  + ' wired-individually:' + buckets['wired-individually'].length
  + ' quarantined:' + buckets.quarantined.length + '; smoke/e2e/workflow coverage clean');
for (const [f, reason] of Object.entries(manifest.quarantined || {})) {
  console.log('  QUARANTINED ' + f + ' — ' + reason);
}
if (CHECK_ONLY) process.exit(0);

// ── Run the requested bucket ───────────────────────────────────────
const queue = buckets[RUN_BUCKET];
// Green over zero suites is the failure mode this whole file exists to stop.
if (!queue.length) die('RUNNER ERROR: bucket "' + RUN_BUCKET + '" is empty — refusing to report success over zero suites.');

const PER_SUITE_TIMEOUT_MS = 60000;    // slowest measured suite is 18.7s
const BUCKET_BUDGET_MS = 8 * 60000;    // job cap is 10 min; fail with a report, not a kill
const MAX_BUFFER = 32 * 1024 * 1024;   // default 1 MiB turns a chatty PASS into ENOBUFS

const gh = !!process.env.GITHUB_ACTIONS;
const results = [];
const started = Date.now();
let budgetExhausted = false;

// A suite that prints failures but exits 0 would be invisible. Cheap belt to
// the exit-code braces: scan captured output for a failure summary.
function outputLooksFailed(out) {
  const m = /\b(\d+)\s+fail(?:ed|ures?)\b/i.exec(out);
  if (m && Number(m[1]) > 0) return 'output reports "' + m[0] + '"';
  const line = /^[ \t]*(FAIL\b|not ok\b|AssertionError\b|✗)/m.exec(out);
  if (line) return 'output contains a failure marker (' + line[1] + ')';
  return null;
}

for (const f of queue) {
  if (Date.now() - started > BUCKET_BUDGET_MS) { budgetExhausted = true; break; }
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(TESTS, f)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PER_SUITE_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
  });
  const secs = (Date.now() - t0) / 1000;
  const out = String(res.stdout || '') + String(res.stderr || '');
  let why = null;
  if (res.status !== 0) {
    // ETIMEDOUT and ENOBUFS both arrive as status=null; naming them turns an
    // unreadable empty-output red into a diagnosis.
    why = res.error
      ? (res.error.code || res.error.message) + (res.signal ? ' (signal ' + res.signal + ')' : '')
      : 'exit ' + res.status + (res.signal ? ' (signal ' + res.signal + ')' : '');
  } else {
    why = outputLooksFailed(out);
  }
  results.push({ f: f, ok: !why, why: why, secs: secs, out: out });
  if (gh) {
    console.log('::group::' + (why ? '✗' : '✓') + ' tests/' + f + ' (' + secs.toFixed(1) + 's)' + (why ? ' — ' + why : ''));
    if (out) console.log(out.trimEnd());
    console.log('::endgroup::');
  } else {
    console.log((why ? '  ✗' : '  ✓') + ' ' + f + ' (' + secs.toFixed(1) + 's)' + (why ? ' — ' + why : ''));
    if (why) console.error(out.split('\n').slice(-25).join('\n'));
  }
}

const failures = results.filter((r) => !r.ok);

// Reconciliation: the runner must never report on fewer suites than it queued.
if (!budgetExhausted && results.length !== queue.length) {
  die('RUNNER ERROR: queued ' + queue.length + ' suites but produced ' + results.length + ' results — refusing to report a partial run as complete.');
}

if (gh) {
  for (const r of failures) {
    const first = (r.out.split('\n').find((l) => /FAIL|not ok|AssertionError|✗|Error/.test(l)) || r.why || 'failed').trim().slice(0, 300);
    console.log('::error file=tests/' + r.f + '::' + first.replace(/\r/g, ''));
  }
  const sum = process.env.GITHUB_STEP_SUMMARY;
  if (sum) {
    const rows = results.map((r) => '| `' + r.f + '` | ' + (r.ok ? '✅ pass' : '❌ **fail**') + ' | ' + r.secs.toFixed(1) + ' |').join('\n');
    fs.appendFileSync(sum,
      '\n### Bucket `' + RUN_BUCKET + '` — ' + (results.length - failures.length) + '/' + results.length + ' passed\n\n'
      + '| suite | verdict | secs |\n|---|---|---|\n' + rows + '\n'
      + (failures.length ? '\n**Failed:** ' + failures.map((r) => '`' + r.f + '`').join(', ') + '\n' : '')
      + (budgetExhausted ? '\n> ⚠️ wall-clock budget exhausted after ' + results.length + '/' + queue.length + ' suites\n' : ''), 'utf8');
  }
}

console.log('\n' + (results.length - failures.length) + '/' + results.length + ' ' + RUN_BUCKET
  + ' suites passed (' + ((Date.now() - started) / 1000).toFixed(1) + 's)');
if (budgetExhausted) die('RUNNER ERROR: wall-clock budget (' + (BUCKET_BUDGET_MS / 1000) + 's) exhausted after ' + results.length + '/' + queue.length + ' suites — a suite is hanging.');
if (failures.length) die('FAILED: ' + failures.map((r) => r.f).join(', '));
