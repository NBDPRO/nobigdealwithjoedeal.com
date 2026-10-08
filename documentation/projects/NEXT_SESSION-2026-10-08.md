# NEXT_SESSION — 2026-10-08 (from the 10-07 evening power session)

The 10-07 evening ran from the end of the morning session (handoff:
`nbd-content/HANDOFF-2026-10-07.md`) until about 01:00 on 10-08. It ran
about 25 helper lanes, and **18 PRs merged**. Everything below describes the
state at about 00:45 on 10-08. Re-check it with `gh pr list --state open`
and `nbd-ops/logs/mq-autostart.log` before you act on it.

## §0 Read this first — what bit us tonight

- **Silent `?v=` collisions were the night's main tax.** Parallel PRs kept
  shipping the same cache-buster number for different content: a clean merge,
  and returning browsers keep the old file.
  - `nbd-ops/check-v-collisions.sh` (new) lists them across every open PR.
    Run it before every push.
  - The autopilot now picks numbers above every open PR's (gap 7) and
    resolves pure-`?v` JavaScript load-string conflicts (gap 6). Both went
    live at 00:27 and get their first real run at the 02:10 autostart.
  - Read `mq-needs-attention.log` for `ATTENTION ?v COLLISION` lines.
- **The requeue resolver can leave a worktree mid-merge** when you run it by
  hand. The coordinator did this to `nbd-wt-portal-after` at 23:53.
  - After a hand-run `requeue.sh` that exits non-zero, `git merge --abort`
    before handing the worktree to anyone.
  - `mq-overnight.sh` already aborts on its own; a hand run does not.
- **Fix PRs built on an unmerged PR's head conflict after it squash-merges.**
  That happened to #2305 on #2299. Re-merge main, and keep your additions
  against the final code.
- **The merge queue reports `UNMERGEABLE` for a PR that conflicts with the
  one ahead of it.** It is almost always `?v` lines. Wait for the one ahead
  to land, then requeue.

## §1 Merged 10-07 evening (newest first)

| PR | What |
|---|---|
| #2311 | Every dashboard counts sales (`isSale`) and jobs (job records) the same way; estimate edits keep jobValue (R6-2-7, 2-10..14) |
| #2310 | Search Console pass: town titles match "roofer &lt;town&gt;" queries; vault note `documentation/audit/GSC-PASS-2026-10-07.md` |
| #2312 | CRM iPhone audit vault note (`documentation/qa/crm-phone-audit-2026-10-07/`) |
| #2307 | Every website lead alerts by email + **push**; undelivered texts are no longer marked "sent"; 10-min missed-alert watchdog (`LEAD_ALERT_WATCHDOG_DISABLED` switch) |
| #2308 | Insurance invoices bill deductible + first (ACV) check, the rest at completion; KY hold shows "Nothing is due yet"; missing carrier numbers → "Waiting on the carrier's numbers" |
| #2294 | Pro demo phase 2, waves 1–4 together at `/pro/explore` (#2261/#2265/#2281 closed as shipped) |
| #2206 | Homepage rebuild (phone height 31.6k → 9.8k px); baselines reblessed from CI (Jo OK'd the artifact) |
| #2302 | Homeowner paperwork says **"Fully insured"** (never "Licensed"); repairs stop promising 10-yr transferable; honesty gate now covers CRM output |
| #2242 | /inspect what-happens strip + FAQ, QR kicker, `?ref=` prefill |
| #2299 | **Signed price wins** on every bill (`estimates/{id}.signedPrice`, server-only; billing reads `CER.signedView`); stale deal-room price → 409 `price_changed` + confirm |
| #2301 | Homeowner money-path audit vault note |
| #2300 | No double AI send on unknown outcome; START lifts only its own company's STOP; unknown recipients get texting hours |
| #2296 | Catch-up "Paid in full?" + later Stripe deposit no longer double-counts |
| #2298 | STOP inside a longer reply opts out (`possible_stop` flags ambiguous ones); pre-filled text links check STOP/DNC/hours |
| #2297 | Customer-page pay links no longer fail "Not authenticated" (Send balance carried no link) |
| #2295 | Invoice pre-flight "Save to estimate" refuses builder estimates (rebuild in the builder); logged estimates fixed |
| #2155 | Merge-queue guard, self-hosted Firebase SDK, lazy functions, heartbeat gates |
| #2260 | R3 security: Connect owner-only, billing portal, tenant pins (stricter-wins merge with #2220) |

Also: #2143 was closed as superseded by #2159, and the morning's #2159 and #2220 merged.

## §2 Open at handoff (all auto-merge armed unless noted)

- **#2303:** invoice email + invoice views print rows that add up, with one
  rounding rule (`footingRows`).
- **#2304:** "Paid in full?" counts approved supplements (R6-2-9).
- **#2305:** line-item estimates offer only the tiers they can rebuild. An
  accepted tier waits for "Use it", which really re-prices (R6-2-3/2-4).
  Rule: memory `signed-price-rules-2026-10-07`.
- **#2309:** portal status after signing, payments list, one signature per
  deal, and balance Pay now never the spent deposit link (R6-2-6).
  Per-payment receipts and the signed copy for deal-room signers are
  **deferred**; they wait on `invoice-pipeline.js` settling.
- **#2306:** owners/admins can lift a phone-recorded STOP, with a required
  reason. Text-reply STOPs stay START-only.
- **#2313:** compact "Areas we serve" row on the homepage (16 towns, so
  Google can reach the town pages), and the blog drops contractor wholesale
  prices (Jo: "you decide" → removed). Baseline rebless is in progress; Jo
  OK'd artifact 11527456667.
- **#2293 (draft → becoming a guard):** round-6 pins. The close-out lane
  converts each pin to a regression test once its fix merges. Three #2311
  pins (R6-2-7 logged half, R6-2-10, R6-2-13) need rewriting as behaviour
  tests.
- **Overnight lanes (launched 00:30):**
  - CRM phone quick wins + Record-payment sheet (batch B, waits for
    #2303–#2309 before touching `invoice-pipeline.js`)
  - customer-page reorder (batch A)
  - door-knock sheet (batch C)

  Reports: `nbd-content/phone-qw-shots`, `customer-order-shots` and
  `knock-sheet-shots`.

## §3 Jo's decisions recorded tonight (also in memory)

- **Signed estimates:** they stay editable, but the **signed price wins on
  bills** until the homeowner re-signs. A stale deal-room price is
  **blocked**.
- **Line-item tiers:** offer only the tiers the estimate can rebuild. No
  deposit until "Use it". (Note: the catalog prices the same at every tier,
  so most line-item estimates will show one price.)
- **Texting:** an owner can lift a STOP they recorded by phone, with a
  reason.
- **Prod check skipped:** Jo didn't use Catch-up "Paid in full" before the
  #2296 fix, so no prod double-count check was needed.
- **Manufacturer certs** (memory `gaf-certified-verified`):
  - **GAF Certified™ ID 1162011.** Verified on gaf.com. Not Master Elite.
  - **TAMKO Pro Gold.**
  - **IKO ROOFPRO Advantage:** applied 10-07; claim nothing until approved.
- **Search Console:** Claude requested indexing for 10 pages. Re-read on or
  after 10-30. The 10 pages:
  - roof-repair, siding-replacement, gutter-replacement, siding-repair
  - West Chester, Milford, Batavia, Florence, Covington
  - /estimate
- **Approved drafts:** #2206, #2242 and the Pro demo stack shipped on Jo's
  "good to go".

## §4 Jo's to-dos

1. **Send one test lead** from his phone through /inspect ("TEST" in the
   message). No website form has created a lead since 09-22. It's either
   low traffic or a broken form; the alert lane couldn't test it without
   alerting Jo for real.
2. **Allow CRM notifications on the iPhone.** Only 3 of 8 push devices have
   been active since late September, and #2307's pushes need it.
3. **iPhone check of the pre-filled text links** (#2298): Messages now opens
   after a server check. Tap "Text Booking Link" from the installed app.
4. **IKO follow-ups:**
   - Do the two ROOFPRO "fundamentals" courses (they unlock the higher
     tiers).
   - Tell Jay at QXO he's signed up.
   - Say when IKO approves, so it can be added to citations and the
     product library.
5. **Update the GAF profile phone** ((859) 810-6158 is listed) and link
   Google reviews.
6. **Repair warranty decision.** The V2/V3 builder has no "1-year repair
   warranty" checkbox, so builder-made repairs show no warranty. Claude
   recommends adding the checkbox (after #2305 lands).
7. **Carried from the morning:**
   - Call the Sherrills.
   - Office-team go-live.
   - Run `cleanup-worktrees.ps1`: **226 worktrees now**, never
     `git worktree remove`.
   - Delete the disabled anonymous user.
   - Twilio A2P is in review.

## §5 Next session — suggested order

1. Confirm the 02:10 autostart ran the new resolver cleanly (look for
   `ATTENTION` lines) and that #2303–#2313 landed. Requeue any PARKED PR.
2. Read the three overnight lane reports and ship what's green.
3. Finish #2309's deferred items (per-payment receipts, signed copy for
   deal-room signers) once `invoice-pipeline.js` is quiet.
4. Land #2293 as the round-6 regression guard.
5. Next phone-audit batches:
   - D: the estimate wizard returns to the lead and skips steps after a
     preset.
   - E: Home "people need you" up top, the More drawer, stage-move
     confirm.
6. Add the V2/V3 repair-warranty checkbox (if Jo agrees).

## Where things are

- **Reports (nbd-content):**
  - `review-r6-2026-10-07.md`
  - `ho-money-audit-2026-10-07.md` (+ screenshots)
  - `crm-phone-audit-2026-10-07.md` (+ harness)
  - `lead-alert-check-2026-10-07.md`
  - `gsc-pass-2026-10-07.md`
- **Vault notes:**
  - [homeowner money path audit](../qa/homeowner-money-path-2026-10-07/README.md)
  - [CRM phone audit](../qa/crm-phone-audit-2026-10-07/README.md)
  - [GSC pass](../audit/GSC-PASS-2026-10-07.md)
- **Autopilot:** `nbd-ops/README.md` "2026-10-07" sections. The gaps 1–7
  resolvers have their self-tests in `requeue.next.selftest.sh`, and
  backups are `*.bak-20261007` / `*.bak-20261007b`.
