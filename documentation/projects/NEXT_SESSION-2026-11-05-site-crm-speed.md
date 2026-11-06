# NEXT_SESSION, 2026-11-05: site + CRM speed lane, receipt inbox, test flakes and the deploy outage (lane note)

A lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). It continues
[NEXT_SESSION-2026-11-04-site-crm-speed](NEXT_SESSION-2026-11-04-site-crm-speed.md), which covers Jo's copy decisions,
the speed audit and the CRM speed-up plan. Other sessions were working on site markup, the Schedule calendar,
storm/D2D, the customer portal and CI hygiene the same days; this lane stayed out of those.

> **Update 2026-11-06 (later the same lane).**
> - **Receipt inbox:** live for NBD. All three switches are on and were read back in the console, and Jo ran a real photo through it successfully.
> - **Speed (Phase 2):** the boot join is on and kept. Warm first paint went from 5.4 s to 2.3 s. The cold check (#2898) cleared the join.
> - **Source maps (#2920):** the joined `_concat-*.js` files now get Sentry source maps.
> - **Phase 2b lazy bundles:** switched ON in the PR after #2920. CI's minified walk joins the bundles hard. The deploy joins them behind their own off switch, the repo variable `NBD_BUNDLES=0`. Locally on the sample account, all 18 bundles loaded from 33 joined files with 0 page errors, and the 119-check zero-network walk passed. The cost is one ~7.5 KB blocking map script before `script-loader.js`. Re-measure with the same keep rule.
> - **Sentry:** 0 unresolved issues in 24 h on 11-06. Page loads report: LCP p75 0.87 s, CLS 0.054.
> - **Still Jo's:** the iPhone feel check.

## What merged

| PR | What |
|---|---|
| #2824 | Blog dates: no post dated before it existed, spread weekly |
| #2826 | Speed audit note [PERF-AUDIT-2026-11-04](../audit/PERF-AUDIT-2026-11-04.md) |
| #2827 | Site speed: GA on first interaction or 3.5 s, lazy 80 px review avatars, -400/-640 project photos. **Live.** |
| #2829 | CRM header wordmark readable in every theme. **Live.** |
| #2831, #2836 | CRM Phase 1: bundle files download in parallel; modulepreload of the boot module graph (#2836 live) |
| #2838 | CRM Phase 2 step 1: one copy each of four functions the dashboard declared twice |
| #2852 | The 11-04 lane note |
| #2855 | Real-visitor speed data: site web vitals to GA4, CRM page loads to Sentry |
| #2792, #2793 | Receipt inbox phase 1, server and screen. **Shipped dark** (see below) |
| #2865 | A lead save survives a resent write (no false "save failed", no duplicate lead) |
| #2867, #2871, #2875 | E2E seeding survives a resent write (`window.__e2eAddDoc`); crew-calendar's leads carry `e2eTestData` |

Closed as superseded by #2850 (a test merge into #2850 changed nothing): #2841, #2844.

## Still in flight (2026-11-05 ~17:00Z)

| PR | What | Notes |
|---|---|---|
| #2876 | Care-plan test time bomb (another session's fix) | Merge queue. Must land first: until it does, `Unit suites (manifest)` fails on every PR |
| #2878 | **Deploy fix**: the Firestore index step strips the rules too | Armed. Deploys still stop at "Deploy Firestore indexes" without it |
| #2850 | CRM Phase 2b: join lazy ScriptLoader bundles at deploy (carries #2841/#2844's deploy-time join) | Queue. May drop out on the care-plan test; requeue after #2876 |
| #2877 | Three more E2E seeds read the doc back (contract-cancel-forms, doc-template-library, pro-authed) | Armed |

After #2876 lands: merge main into #2850 / #2877 / #2878 and requeue whatever dropped out.

## The deploy outage (2026-11-05)

Every deploy since about 02:50Z has stopped partway. Hosting deploys first and is fine; **Firestore rules, indexes,
Storage rules and Cloud Functions are not shipping.**

1. `firestore.rules` passed the Rules API cap of 262,144 bytes (#2792 pushed it to 263,469). #2869 (another session)
   strips comment-only lines from the uploaded copy: 117,861 bytes. Write-up:
   [RULES-SIZE-CAP-DEPLOY-OUTAGE-2026-11-05](../audit/RULES-SIZE-CAP-DEPLOY-OUTAGE-2026-11-05.md).
2. The next step, `firebase deploy --only firestore:indexes`, compiles the rules too and ran on the restored full file:
   same 400. **#2878** strips there as well, with a guard test that every firestore deploy step strips and restores.

When #2878 is deployed, confirm one run goes all the way green, then that the Functions changes from this lane are live.

## Test flakes found and fixed

- **ALREADY_EXISTS on lead creates.** The CRM runs Firestore over long polling; on a slow link the SDK can resend a
  create the server already saved, and `addDoc`'s "must not exist" check rejects the resend. In the app this told reps
  a saved lead had failed (they saved again: a duplicate). Fixed in #2865 (id first, `setDoc`, read back after any
  error). The 14 specs that seeded leads directly use `window.__e2eAddDoc` (#2867).
- **PERMISSION_DENIED, the same race.** A resent `setDoc` arrives as an UPDATE, which the rules can refuse. Guards that
  matched only `ALREADY_EXISTS` let it through (phone-deposit-draft #2871; contract-cancel-forms, doc-template-library
  and pro-authed #2877). The rule now: after any error, read the doc back.
- **field-app's Now card showed crew-calendar's job.** crew-calendar saves a two-day Wed-Thu job without
  `e2eTestData`, so field-app's `emptyToday()` skipped it; on a Wednesday or Thursday it took the card. Fixed in #2871.
- **care-plan invite time bomb** (#2876, another session): the test minted an invite at a fixed 2026-10-06 and
  checkout judged expiry by the real clock, so it expired 2026-11-05 15:00Z.

## Receipt inbox: shipped dark, ready to turn on

A security review of #2792 found three real problems, all fixed before merge:
- The $10 monthly cap was per seat. It is now one meter per company: `receiptInboxMeter/{companyId}__{YYYY-MM}`.
- There was no server-side allowlist. The reader now needs `enabled: true` in the company's server-only config.
- The cap was check-then-spend. It is now a $0.25 reservation in a transaction, settled to the real cost.

Concurrency also went from 20 to 4, to protect memory during iPhone photo (HEIC) decodes. Details:
[RECEIPT-INBOX-PHASE1-2026-11-04](RECEIPT-INBOX-PHASE1-2026-11-04.md).

**To turn it on** (Jo does these, after a deploy that includes Functions):
1. Set `RECEIPT_INBOX_ENABLED=true`.
2. Add `enabled: true` to `integrations/receiptInbox/companies/{NBD companyId}`.
3. Flip the `receiptInbox` client flag.

**Small follow-ups, none blocks turning it on:**
- The server, not the client, should set `fileDeleted`.
- A teammate's identical upload comes back as "already in" with no draft of its own.
- The `decision` map has no size limit on its values.

## CRM speed: what to measure when deploys work

Baseline (Jo's Chrome, 2026-11-04): FCP 3.27 / 3.33 s, DOMContentLoaded 3.1-4.6 s, load 4.6-6.8 s. Once #2850 and #2878
are live:
- Re-measure the dashboard the same way.
- Check Sentry → Performance page loads (#2855).
- Re-run Lighthouse on the site against PERF-AUDIT-2026-11-04 (#2827 is already live).

Phase 2b's off switch is the repository variable `NBD_CONCAT=0`. The dashboard's shipped blocking-bytes ceiling was
raised 84 → 85 KB for the joined-bundle loader path and has no headroom left.

## Waiting on Jo

1. **Phase 2b:** after the speed check, keep bundling on or set `NBD_CONCAT=0`.
2. **Receipt inbox:** the three turn-on steps above. Also one choice: a document the reader calls "personal" is
   deleted by the server straight away, and text printed on a document can steer that verdict. Keep that, or mark it
   and let Jo confirm the delete?
3. **Sentry source maps:** Jo adds `SENTRY_AUTH_TOKEN` to GitHub secrets himself (never pasted in chat), plus the
   Sentry org and project slugs. Then the upload step can be wired.
4. A source for the "50-year" claims (siding-replacement, roof-replacement-florence-ky).
5. llms.txt partners (United Restore, Acorn Finance, TAMKO HailGuard): add to Credentials or remove?
6. Optional: the James Hardie Alliance member ID; tell Claude when IKO approves.
7. An iPhone check now that the site speed changes are live, and again after #2850 deploys.

## Notes for the next session

- A worktree path that already exists belongs to someone. `git worktree add` fails, but `-b` still creates the
  branch. Check `[ ! -e path ]` before adding, and never edit inside a folder you did not create
  (`nbd-wt-sweep` is the a11y session's).
- When a PR is in the merge queue its branch is locked: put follow-ups in a new PR (draft if it depends on the first).
- The E2E shards are not required checks; `Unit suites (manifest)` and the secret scan are. A secret-scan 504 while
  downloading gitleaks is GitHub, not the code: requeue.

## Update 2026-11-06 ~01:00Z (session close-out)

**Merged since the tables above:**
- #2876, the care-plan test time bomb (another session).
- #2878, the deploy fix for the index step.
- #2850, CRM Phase 2b, which carries #2841 and #2844's deploy-time join.
- #2877, the last three E2E seeds.

A deploy that includes #2878 and #2850 was running at close-out. **The first job next session: confirm a deploy ran all the way green.** Then check that Functions are live (`onInboxReceiptDropped` and `submitInboxReceipt` in the Firebase console).

**Still open:**
| PR | What | State |
|---|---|---|
| #2884 | Receipt inbox follow-ups: a "personal" verdict waits for a person; the server records the picture delete (`onInboxReceiptDropped`); teammate duplicate message; bounded decision map | Queue, set to merge |
| #2887 | **Draft, needs Jo's OK on the before/after wording in its description.** Warranty claims in the makers' words; siding = Ply Gem and Polaris (Royal out); GAF fixes (Florence, Silver Pledge, pipe boot, WindProven, Pivot); RoofiVent gasket only when worn; United Restore removed | Draft |
| #2882 | This note | Set to merge |

**Jo's decisions from the 11-05 grilling** (also in memory):
- **Phase 2b keep rule.** Re-measure the CRM dashboard, 2+ runs each, against the 11-04 baseline. Keep it if first paint and page ready are no worse and fully loaded is faster, then Jo does an iPhone feel check. Otherwise set `NBD_CONCAT=0`.
- **Receipt inbox turn-on.** Do it after #2884 is deployed: NBD only, Jo alone for the first couple of weeks, $10 company cap, "Paid from" 3537 only. Walk Jo through the three switches and read each back.
- **Sentry.** Once deploys are green, send Jo the token steps. He adds `SENTRY_AUTH_TOKEN` himself; get the org and project slugs.
- **Copy.** Siding is Ply Gem and Polaris. Warranty-length claims name the product and use the maker's wording. United Restore is dropped. Acorn Finance and HailGuard stay out of Credentials.
- **Homepage phone video.** Already shrunk by #2874; not reopened.

**Next session, in order:**
1. Confirm the deploy is green.
2. Run the CRM speed check, then Jo makes the Phase 2b call.
3. Jo approves #2887, then it merges.
4. Receipt inbox turn-on walkthrough.
5. Sentry token steps.

**Lessons from this lane** (in memory):
- A deploy fixed at one step can fail at the next for the same reason: read the next step's log.
- Read back after ANY error on a resent create. `setDoc` resends come back PERMISSION_DENIED.
- A new Cloud Function needs `node scripts/gen-function-map.js`.
- Run the CI unit runner, not a hand-picked list; on Windows it is too slow to finish locally, so CI is the check.
- A borrowed `functions/node_modules` junction can point at a pruned install: check `firebase-functions` resolves before trusting a red local run.
