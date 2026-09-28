# Next session — 2026-09-28 (CRM sweep + fix session)

Handoff from the 2026-09-27/28 session: a whole-CRM emulator click-through, then a
fix session. One code PR, **#1818, merged (`74d74639`) and deployed** — Firebase
deploy run 36398135780 green; all 17 changed JS/CSS files were confirmed live on
nobigdealwithjoedeal.com by content marker.

The QA log and its resolution table:
[crm-intense-sweep-2026-09-27/BUG-LOG](../qa/crm-intense-sweep-2026-09-27/BUG-LOG.md).

## §0 — Read before trusting any emulator QA finding

About a third of the sweep's findings were **seed-script artifacts**, not app bugs.
`scripts/seed-emulator.js` wrote stage `'won'`/`'quoted'` (not stage keys — they
normalize to `new`), `companyId: 'demo-co'` (production keys a tenant on its
owner's uid, so the seeded subscription was never read → "Free plan", and the admin
took the invited-rep activation path → Home stalled at $0), and estimates without
`raw`. **The seed is production-shaped since #1818.** If two surfaces disagree
about a record, read the raw doc and grep the writers for that value before
calling it an app bug.

Also: the Claude browser pane auto-cancels native `confirm()` (buttons look dead),
a same-URL `#hash` navigate does not reload JS, and the Windows hosting emulator
serves stale `?v=` scripts from the HTTP cache. Production is unaffected
(`max-age=0, must-revalidate` + network-first SW) — no `?v=` bumps needed to ship.

## §1 — What #1818 changed (all verified in the re-seeded emulator)

- **Home ≠ Pipeline**: Pipeline Value counted won/lost/signed jobs ($81.7k vs
  Pipeline's $62.5k). Widgets now use `stageRole`/`isJobStage` and stage labels; Home
  repaints on `nbd:data-refreshed` (leads) and renders outside the kanban try.
- `activateInvitedRep` / `claimInvite` awaits bounded to 8s (they gate loadLeads).
- `nbd-auth.js` 5s timeouts resolved `undefined` → `.exists` TypeError; now reject.
- **Draw**: removed the `(Σ any lines ÷ 4)²` area guess (two ridges read 5,070 sf).
  e2e B7 updated for the one intentional change.
- **D2D knock**: no confirm checkbox when there is no door number; no second
  "Convert Now?" prompt after auto-convert (its Edit First path could duplicate).
- Pipeline search count = what renders, + "N hidden (prospects/snoozed/tab)".
- Classic estimates with `sq` but no `raw` reopen at their squares, not 0 SQ →
  job minimum.
- V2 doc viewer re-appended last in `<body>` on open; finalize rejections toast.
- Per-SQ mode says why it isn't pricing (Insurance / no area / no scope item).
- Phones: Job Templates bulk bar, pipeline list, `.nbd-toast` clear the tab bar;
  boot font restore is silent. Retail Quote uses the full logo. Chart.js canvas
  reuse, `..` in the AI proxy error, Maps & Pins focus.

## §2 — Open questions for Jo

1. **Tier rates are per-device** (localStorage `nbd_est_settings_v3`) by an explicit
   2026-09-25 design decision. They work — Cash + roof area + a scope item prices
   Better at $595/SQ ($18,475 on the test job). Should they be shop-wide
   (`companyProfile.pricing.tierRates`, which the engine already reads)?
2. **Production dry run** of the fixes needs Jo signed in to the Browser pane (Claude
   cannot enter his password). Status at time of writing: see §3.

## §3 — Production dry run

Pending Jo's sign-in when this note was written. Plan: use `ZZ_QA`-prefixed
records on the real tenant, re-run the sweep's repro steps (Home vs Pipeline
totals, knock without a door number, Interested knock, pipeline search, estimate
reopen, draw ridges-only, V2 Retail Quote twice, mobile list), then delete every
`ZZ_QA` record and verify.

## §4 — Housekeeping

- Worktree `C:\Users\jonat\nbd-wt-qafix` has `functions/node_modules` and
  `tests/node_modules` **junctions** — unlink both (non-recursive) and confirm the
  main checkout's folders still have content BEFORE `git worktree remove`
  (see memory `worktree-path-length-limit`).

## Update — 2026-09-28 (later): sweep rounds 4–8, all shipped

Kept testing in the emulator (no production sign-in needed). Five more PRs,
each merged green and deployed; details and repro notes per round in
[BUG-LOG](../qa/crm-intense-sweep-2026-09-27/BUG-LOG.md) (Round 4 … Round 8).

- **#1820** — form-created leads showed by address / "Unknown" / "N/A"
  (surfaces read `lead.name`, which the form never writes); Close Board $0;
  Cal.com pasted-URL usernames broke booking links + webhook matching;
  Templates generator labels invisible + required fields unenforced; Team
  Manager bounced on refresh, raw rules error, owner "0 leads" (functions);
  customer-page stage badge stale + "[object Object]" blocked-move toast;
  retired AOB checkbox visible (`.mrow{display:grid}` beat `[hidden]`).
- **#1821** — **paying an invoice in full dragged a Closed job back to
  Contract Signed** (test `invoice-markpaid-stage.test.js`); Settings →
  Profile blanked on refresh and the next Save overwrote real values;
  Company/Role/License never saved; won-stage drift in Lead Source ROI,
  margin analytics and Leaderboard; Project Timeline was insurance-only.
- **#1822** — **every follow-up was due a day early** in US time zones
  (`YYYY-MM-DD` parsed as UTC; test `followup-local-day.test.js`); bell +
  Needs Attention flagged unsent drafts as "awaiting reply" at "$0"; monthly
  revenue goal didn't stick.
- **#1823** — Photos, Dashboard (Analytics) and Money painted empty/$0 after
  a refresh and never recovered.
- **Round 8 (#1824)** — customer-page Edit Info saved phone "123", email
  "bad" and negative job values; the homeowner portal flashed NBD's name while
  loading for other tenants; the rig now wires default functions to the
  emulator (portal links / Team Manager testable locally).
- **#1827** — **a signed e-sign agreement was unreachable from the CRM**
  (nothing read `esign_envelopes`); the customer's Documents tab now lists
  envelopes with **Open signed PDF** (blob, no download token); signer
  pre-filled; estimate view + signing page no longer show NBD while loading.
- **#1828** — Close Board deals "Unnamed" and missing claim details; photo
  report Carrier and job-sheet Carrier/Deductible blank (wrong lead field
  names: form writes `firstName`/`lastName`, `insCarrier`,
  `deductibleOrOwedByHO`).

Local rig note: functions use a **live Resend key** — keep test signer/email
addresses on `example.com`. Homeowner photo upload fails locally only (no
service-account key for `getSignedUrl`); prod IAM grant verified read-only.

**Rig lessons (also in memory `emulator-seed-shape-artifacts`):** the seed
now writes `companies/{id}` + members, the tenant `brand`, 10-digit phones,
and *no* `lead.name`/`estValue`/`value` — those extras hid two real bugs.
Start the functions emulator with `FUNCTIONS_DISCOVERY_TIMEOUT=90`.

**Still open:** production dry run (needs Jo signed in); users already saved
with a URL-shaped `calcomUsername` stay broken until they re-save Settings;
Jo's call on shop-wide tier rates; Settings → Company Profile shows NBD's
default legal text as the editable starting value for other tenants (documents
already substitute the tenant name — cosmetic).

## Update — 2026-09-28 (evening): Thursday dead air, root cause (read-only)

Full evidence in [THURSDAY-BLAND §10](../architecture/THURSDAY-BLAND-2026-09-26.md).

- **The start node waits for the caller to speak.** A silent caller gets silence
  forever, and six calls since 09-24 hung up with no words from either side.
  After the caller does speak, the opening takes another ~6–10 s (every turn runs ~6 s).
- **Tools were never bound in any compiled pathway version** (1–14):
  `emergency-connect-to-joe` failed twice on Jo's 09-27 test (`Tool Call Unmatched`),
  and `end-call` failed too. The tools are v1 records (`/v2/tools/{id}` returns 404).
- **Options, all needing Jo's OK because none can be staged:**
  (a) Bland support ticket covering the start node and tool binding;
  (b) set `first_sentence` / persona `call_config` on the live number, back it up first, and test with Jo;
  (c) re-create both tools in the v2 agent builder and re-tag them, then publish to staging
  through `thursday-agent-lookup.js`-style tooling.
- **Applied 17:31Z on Jo's OK:** option (b), a static `first_sentence` on the number
  (`scripts/thursday-bland-setup.js set-first-sentence`; rollback `--clear`).
  Verify on the next real call's `pathway_logs`.
- **Tools (option c):** both tagged tools are org-level (`agent_id: null`), not the agent's own copies.
  Re-tag them in the Bland agent builder, which needs Jo signed in. Then staging → test → promote.
  If that doesn't fix it, call Bland support.
- **18:09Z — Thursday tools LIVE** (0.6.1): the node never had a `tools` array.
  Re-created both tools inside the agent and promoted on Jo's say-so.
  Next call: confirm `Tool Call` without `Unmatched`.
- **Still open for Thursday:**
  - greet-by-name: the Initialization snippet was never saved in the builder (THURSDAY-BLAND §10);
  - ~6 s per-turn latency;
  - the Bland balance at −0.50.
- **#1831 merged:** a silent hang-up of 2 s or more → inbox "Hung up — call back?" (no alerts).

## Update — 2026-09-28 (late evening): rounds 11–12 + Thursday live fixes

- **Thursday (live on Jo's OK):**
  - static opening line on the number;
  - agent 0.6.1: tools bound (emergency transfer + hang-up), promoted;
  - agent 0.6.2: Initialization snippet saved in the builder, so greet-by-name runs; the prompt no longer re-greets.
  - A 2 s+ silent hang-up is now a missed-caller inbox row (#1831).
  - Details: [THURSDAY-BLAND §10](../architecture/THURSDAY-BLAND-2026-09-26.md).
- **Merged:** #1830 #1831 #1832 #1833 (public-log PII fix) #1834 (deal-room stale links).
- **In CI, auto-merging on green at their pinned heads:** #1835 (referral form errors), #1836 (Edit Lead stage writes), #1837 (warranty wizard white-label), #1838 (expenses row), #1839 (Reports "sent").
  - #1835, #1836 and #1839 each add a test suite. Whichever merges later must bump `FLOORS` in `scripts/run-test-manifest.js` to the new disk count, or main's manifest check goes red with "floor is stale".
- **Jo's to-do:**
  1. **Delete the old Lead-address-audit run logs.** 41 runs, 08-20 → 09-28, are public and hold customer names and addresses:
     `gh run list --workflow "Lead address audit" --limit 100 --json databaseId --jq '.[].databaseId' | xargs -n1 gh run delete`
  2. Decide what "revenue" means for Reports (signed estimates) vs Home (closed jobs) — BUG-LOG R12-07.
  3. The Bland balance read −0.50 credits.
  4. Optional Bland support ticket (latency ~2 s/turn, start node, tool binding) — drafted in the session.


## Update — 2026-09-28 (night): revenue = collected; sweep round 13

- **Revenue decided (Jo):** "Revenue is always collected only. Projected is separate." **#1841** makes every revenue figure invoice payments by payment date: Home, Analytics, Reports, rep reports, leaderboard, lead-source ROI, achievements, AI context and the weekly digest email. It also fixes Reports' off-by-one weekly chart. BUG-LOG R12-07 is closed. Memory: `revenue-is-collected-only`.
- **Round 13 (BUG-LOG R13-01 … R13-08).**
  - Merged:
    - **#1842:** a payment smaller than the deposit was invisible on the invoice and the emailed invoice.
    - **#1843:** CSV import stored raw stage text (the server called an imported finished job "active") and duplicated customer IDs; the top-bar search matched phones on stray digits; **every notification-bell lead link opened a blank Estimate Builder** (`?tab=` was never read).
  - Also merged:
    - **#1844:** a declined duplicate prompt stranded a D2D knock as "converted" forever.
    - **#1845:** overdue tasks vanished from the bell after a Firestore connection cycle (`fromCache` reads).
- **Settings deep links (R13-09):** `?settings=<tab>` (incl. Stripe Connect's return to Billing) and billing-gate's "Go to Billing" now open their tab; deep links keep the view hash. PR opened last in the session.
- **Test-count floors:** after #1844 main is node 218 / disk 312; #1845 takes 219 / 313.
- **Open for Jo:**
  - R13-08: show Insurance Claim Progress on cash jobs?
  - The §4 items above (audit run logs, Bland balance / ticket) still stand.
- **Not yet swept:** estimate builder edge cases on a phone; Settings → Team invites end to end (needs the functions emulator); the homeowner portal on a phone.
