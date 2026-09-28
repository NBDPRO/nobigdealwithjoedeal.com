# CRM intense QA sweep — 2026-09-27 — Ranked Bug Log

Logging-only session (per Jo: another agent was actively coding elsewhere, so no fixes were applied — this is groundwork for a separate remediation pass). All `NEW-*` here are fresh, found in this campaign. Severity: **BLOCKER** > **HIGH** > **MEDIUM** > **LOW**.

See [README](README.md) for scope, method, and suggested next step.

## ⚠ Resolution update — 2026-09-27 (fix session, branch `fix/crm-sweep-2026-09-27`)

Read this first — several findings below were **not app bugs**. Root-causing showed the QA seed (`scripts/seed-emulator.js`) wrote data in shapes production never produces:

- **Invalid stage keys.** The seed wrote `stage: 'won'` / `'quoted'`; the real keys are `closed` / `estimate_submitted` (docs/pro/js/crm-stages.js `S.*`). `normalizeStage()` falls unknown values back to `new`, while Photos printed the raw field — hence every "won shows as New Lead" disagreement. **NEW-11, NEW-14, NEW-16 and the "unifying root cause" sections are seed artifacts**, not a shared app bug. NEW-14's "9" was also a misread of a small "0" ("0 of 0 won jobs costed").
- **companyId ≠ owner uid.** Production tenants key on the owner's uid (`subscriptions/{companyId}`); the seed used `'demo-co'`. That hid the seeded subscription (**NEW-02 → Free plan**, and NEW-19's Ask Joe block) and sent the admin down the invited-rep `activateInvitedRep` path, stalling Home (**NEW-01**).
- **Estimates without `raw`.** The Classic wizard re-derives squares from `raw`; the seed only wrote `sq` (**NEW-03**).
- **Sandbox dialogs.** NEW-04's "Close does nothing" was the viewer's own "Close without saving?" `confirm()` being auto-cancelled by the test browser (same class as NEW-13).
- **NEW-18** was already reworded upstream by #1817 before this session.

The seed is now production-shaped (companyId = owner uid, real stage keys, `raw` on estimates). Real app fixes shipped in the same branch, each verified in the emulator after re-seeding:

| Finding | Status | Fix |
|---|---|---|
| NEW-01 Home $0 | Fixed (+ seed) | Home widgets repaint on `nbd:data-refreshed` (leads) and render in their own try; invite-activation/claim callables bounded to 8s |
| — Home widgets vs Pipeline | Fixed (found while verifying) | Pipeline Value now counts only in-play deals (was including won/lost — $81.7k vs Pipeline's $62.5k); won/lost via `stageRole`; stage labels instead of raw keys ("estimate_submitted") |
| NEW-02 subscription | Seed artifact; related real bug fixed | `nbd-auth.js` 5s timeouts resolved `undefined` → `.exists` TypeError; now reject cleanly |
| NEW-03 estimate reopen | Seed + hardening | Unstamped estimates with `sq` but no `raw` back-derive raw (reopened at 31.00 SQ, not 0 SQ / job minimum) |
| NEW-04 V2 preview | Hardened | Doc viewer re-appended last in `<body>` before open (shared z-index with the builder); finalize rejections now toast; cached tier object copied |
| NEW-05 drawing squares | Fixed | Removed the `(sum of any lines ÷ 4)²` area guess — ridges alone read 0 sf / 0 sq |
| NEW-06 door number | Fixed | No confirm checkbox when there is no typed number to confirm; tells the rep to type it |
| NEW-07 hot-lead modal | Fixed | Removed the redundant "Convert Now?" prompt after auto-convert (its Edit First path could duplicate) |
| NEW-08 search count | Fixed | Count = what renders, plus "N hidden (prospects, snoozed, or another pipeline tab)" |
| NEW-09 font toast | Fixed | Boot-time font restore is silent; `.nbd-toast` clears the phone tab bar |
| NEW-10 mobile FAB | Fixed | Pipeline list gets 150px bottom clearance on phones |
| NEW-12 logo | Fixed | `nbd-logo-asset.js` rides the estimates bundle — Retail Quote shows the full mark |
| NEW-15 tier rates | Not dead — discoverability fixed | Per-SQ only prices Cash jobs with a roof area and a scope item; the builder now says which is missing. Tier rates stay per-device by design (2026-09-25 review lane) — product question for Jo |
| NEW-17 Job Templates bulk | Fixed | Sticky "Configure & Preview (N)" bar rides above bottom strips / the phone tab bar |
| NEW-19 double period | Fixed | Proxy error trims the server message's trailing period |
| NEW-20 nav highlight | Fixed | Maps & Pins releases focus after redirecting |
| NEW-21 Project Intel blank | Fixed (via nbd-auth) | Verified the Starter paywall renders on Free after the timeout fix |
| NEW-22 Chart.js reuse | Fixed | `mkChart` destroys any chart already on the canvas |

## Environment

Full Firebase emulator suite (auth/firestore/functions/storage/hosting via `npx firebase emulators:start`), seeded with `node scripts/seed-emulator.js` — tenant `demo-co`, 5 users across all roles (`company_admin`, `sales_rep`, `viewer`, `admin`, `demo_viewer`; password `Test123!` for all), 5 leads, 3 estimates, 1 customer, 1 knock. This is an isolated throwaway tenant, not production — nothing here touched real customer data. Logged in as `companyadmin@demo.test` ("Casey Admin") unless a finding says otherwise.

Areas covered: Home dashboard, Pipeline/CRM board, Customer detail card, Estimates (both the legacy 4-step wizard AND the newer "Estimate Builder V2 (BETA)"), the Drawing/measurement tool, Prospects/Door-to-Door knock flow, role-based access (company_admin vs viewer), and a mobile-viewport (375×812) pass on Home and Pipeline. Skipped: the Calls/Thursday AI-receptionist area and anything role/viewer-callable-related, since that's the live coding lane per the current handoff and open PR #1780.

---

## Likely unifying root cause across NEW-01 / NEW-11 / NEW-14 / NEW-16 (now also seen on Leaderboard/Analytics: "Conversion Rate 0% — 0 won / 0 decided" with the same real won deal in the tenant)

Four separate-looking findings (Home dashboard aggregates, Pipeline board/list stage buckets, Money "won jobs" count, and Reports' conversion funnel) all mishandle leads whose `stage` is `"quoted"` or `"won"` — while `"new"` and `"inspected"` render correctly everywhere. That's a strong signal this is **one shared bug**, not four independent ones: some central stage-enumeration constant or switch statement used across Home/Pipeline/Money/Reports is likely missing `"quoted"`/`"won"` as recognized values (falling back to miscounting/zeroing/mislabeling instead of erroring). Recommend the fix session search for a shared stage list/constants file first, before treating each surface as a separate repair.

## Likely unifying root cause — additional, strongest evidence

Opened Tara Boone's own **customer detail page** directly (`/pro/customer?id=...`) — not an aggregate/summary widget, the single-customer record page itself. Its header badge reads **"New Lead · 2 days in stage"**, and the AI suggestion panel above it reads *"Send portal link to Tara Boone — first-share moment... No portal link sent yet."* — treating her as a brand-new, first-touch lead. Ground truth (raw Firestore, see NEW-11): her `stage` is `"won"`, a $19,200 closed deal. This means the mislabeling isn't confined to summary/aggregate widgets (Home, Pipeline, Money, Reports) — the canonical single-record page for this customer gets it wrong too, which rules out "it's just a rollup query bug" and points more strongly at a shared stage-label/lookup helper used everywhere in the app, including per-record badges. This is the single most convincing piece of evidence for the unifying theory below and should be the fix session's starting point.

## BLOCKER

### NEW-03 — Opening a saved estimate silently recomputes the total wrong and zeroes Squares
- **Repro:** Estimates list shows 3 seeded estimates correctly (e.g. "34.00 SQ · Better", $16,320 for the Tara Boone lead). Click **Edit** on it → the estimate builder opens directly on **Step 4 (Review & Export)**.
- **Observed:** an inline banner reads *"Loaded older estimate — total recomputed from $16,320 to $2,500. Review before saving."* The **Squares** field now reads **0.00 SQ**, the RFG SYS (roofing system) line item shows **0.00 SQ × $595/SQ = $0.00**, and only PERMIT ($150), DUMP ($550), TAX ($49) survive — summing to the bogus **$2,500.00** shown as Estimate Total.
- The wizard's step-1/2/3 indicators (Measurements/Roof Type/Package, all shown checked) are **not clickable** once on Review, so there is no in-UI path back to re-enter the squares before an accidental Save would overwrite the real total.
- **Likely root cause:** clicking "+ New Estimate" offers a choice between "From Template" and "Start Blank." Start Blank opens a visibly different UI — **"Estimate Builder V2 (BETA)"** (tabs Setup/Items/Review, PER-SQ vs LINE-ITEM mode, INSURANCE vs CASH, Good/Better/Best tiers) — a completely different builder/schema from the legacy 4-step wizard that "Edit" opens on the seeded (old-schema) estimates. Opening an old-schema estimate in whatever recompute path Review uses is the likely cause of squares/total getting zeroed — a schema-migration gap, not a simple arithmetic bug.
- Did **not** click Save, so the underlying seeded estimate doc should still be intact in the emulator. Not verified: whether re-opening the same estimate a second time reproduces identically, or whether the corruption compounds.
- **NEW-03b (lower confidence):** all 3 seeded estimates show "No address" / "UNTITLED ESTIMATE" despite being linked to leads with real addresses (Tara Boone, James Nguyen, Maria Lopez) — may be a seed-script gap rather than an app bug; check against a prod-created estimate before treating as real.

---

## HIGH

### NEW-01 — Home dashboard shows $0 / 0 leads while Pipeline shows the real numbers (company_admin only)
- **Repro:** log in as `company_admin` → Home.
- **Observed:** Pipeline Value $0, "0 leads / 0 won", Hot Leads "No hot leads right now", Recent Activity "No recent activity", Win Rate 0%.
- **Contradiction:** navigating to Pipeline on the same session shows "5 customers · $81,700 pipeline" with real cards (Priya Patel $16,400, Derek Shaw $9,800, Tara Boone $19,200, James Nguyen $21,800…), and the console logged `✅ loadLeads: Processed 5 leads after filtering deleted` on the very same page load. The lead data loads successfully client-side; Home's summary widgets just don't reflect it. Reproducible on fresh login.
- **NEW-01b — role-dependent, confirmed by a second login:** signed out and back in as `viewer@demo.test` ("Val Viewer") — on that login, the *same* Home dashboard correctly showed Pipeline Value $81.7k, 6 leads, a populated Hot Leads card, and Recent Activity. So this bug is specific to something about the `company_admin` session/query path (a good guess: a query scoped to `ownerUid == currentUser.uid` rather than `companyId`, which would only break for an admin whose leads are spread across multiple reps) — not a global data problem. Strong, reproducible lead for the fix session.

### NEW-02 — Subscription doc not found; silently falls back to Free plan despite an ACTIVE professional sub being seeded
- Console: `No subscription doc — defaulting to free tier`, `NBDAuth gate passed — plan: free`. On-screen banner: "You're on the NBD Pro Free plan (10 leads/month) — Upgrade Starter $99/mo."
- The seed script explicitly writes an ACTIVE professional subscription + userSettings for this tenant, and its own verification step confirmed the write succeeded.
- Likely a path/query mismatch between where the subscription doc is written and where the client reads it (uid vs companyId keying, or a wrong collection name). Worth confirming whether this is seed-script-only or a real prod code path issue — it gates plan-based features (AI tool limits, lead caps) either way.
- **Root cause found in the third pass:** console logs on a later page load show `Subscription check failed — failing closed to free: Cannot read properties of undefined (reading 'exists')`. This is a real JS TypeError inside the subscription-check code — it's not that the query returns "no document," it's that something the code expects to be a Firestore snapshot object is `undefined` before `.exists` is even read, and the catch block silently falls back to "free." This is a concrete, fixable lead: find the subscription-check function (search for `.exists` reads near subscription/billing gating code) and check what can make its snapshot argument `undefined` — likely an awaited promise that resolves undefined under some condition (wrong collection path returning no snapshot at all, or a destructured argument that isn't always passed).

### NEW-05 — Drawing tool's Roof Calculator computes Squares with no facets/perimeter ever drawn
- **Repro:** Drawing tool → search an address (geocode/pan worked correctly) → LINES mode, line type Ridge → click 4 points on the map as two separate 2-point segments (not a closed shape) → creates "Ridge #1" and "Ridge #2," 142.6 ft each.
- **Observed:** the FACETS panel correctly says *"No facets yet. Close a perimeter to create one."* — but the ROOF CALCULATOR panel directly below it simultaneously shows Base Area (est.) 5070 sf, Pitched 6094 sf, With Waste 7150 sf, **Squares 71.30 SQ**.
- Real, reproducible contradiction: a squares figure is being derived from ridge-line length alone, with no traced perimeter to back it, while the tool's own UI says there's nothing to compute area from. If that squares number flows into a per-SQ estimate, a job could be priced with no real geometric basis — same integrity class as NEW-03.

---

## MEDIUM

### NEW-04 — Shared document-preview modal's open/close lifecycle is broken after first use (revised after re-testing — see below)
- **Original observation:** Estimates → New Estimate → Start Blank (V2 builder) → add an item → Review → Preview/Export → Retail Quote. Clicking the rendered preview's "✕ Close" button (tried by ref and by coordinate) did not dismiss it; had to hard-navigate away.
- **Re-tested rigorously in a follow-up pass** (important: my first pass hadn't ruled out a suppressed native `confirm()`/coordinate-mapping artifact — see NEW-13 below for why that caveat mattered elsewhere). Confirmed the Close button is NOT gated by a native dialog. Results across four attempts in one session:
  1. Templates → Invoice → Generate Document → preview opens → **Close works.**
  2. Templates → Invoice → Generate Document (2nd invoice, same session) → preview opens → **Close works.**
  3. Estimates → new blank estimate → Items → Review → Retail Quote (1st click) → **"Rendering estimate…" toast fires, but the preview modal never actually appears** (confirmed via screenshot + a second wait; console shows `[V2 finalize] server render failed, falling back: internal`, same message logged on every attempt including working ones, so that log line alone doesn't explain the difference).
  4. Same session, clicked Retail Quote again → toast fires again → modal **still doesn't appear.**
- So the accurate finding is: the Estimate Builder V2's export-preview path is **flaky at rendering the modal at all** (not reliably a Close-button bug specifically) — it can silently no-op after triggering its "Rendering…" toast, with no error surfaced to the user. The Templates/Invoice path (different call site, likely different code) rendered reliably 2/2 times. My original single-session observation of "Close doesn't work" on the Retail Quote preview may have been this same underlying flakiness (a stale/partial modal state from a previous attempt), rather than the Close button's own click handler — recommend the fix session reproduce directly in the V2 builder's Review → Preview/Export flow rather than assuming the Close button itself is the defect. Either way, a rep clicking "Retail Quote" and seeing nothing happen (no error, no modal) after the very first estimate they preview in a session is a real, user-facing defect worth fixing.

### NEW-06 — "I've confirmed this door number is correct" override checkbox doesn't reliably unblock Save
- **Repro:** Prospects → New Knock → type an address with no resolvable house number (auto-verify fires on typing/blur, no manual Verify click) → "No house number could be resolved" warning + checkbox appears → tick it → pick a disposition → Save.
- **First attempt:** checkbox visibly checked, but Save was rejected with "Add the door number to this address," and the modal scrolled back to top with the checkbox still shown checked.
- **Second attempt** (same knock, edited the address, then explicitly clicked **✓ Verify** before re-ticking the checkbox): Save succeeded.
- So the override only reliably works if the user explicitly clicks Verify before checking the box; if verification happened via the automatic on-type/blur check, the checkbox's "confirmed" flag isn't honored by the save validator even though it renders checked. Real trap for door-knocking reps at addresses Google can't resolve (new construction, rural routes, typos).
- Also noted: even on the successful save, a toast fired mid-sequence reading "⚠ Address not found" alongside the success toasts — non-blocking, but a warning-styled toast on a successful save is confusing.

### NEW-08 — Pipeline search: header match-count disagrees with the List view's actual results
- **Repro:** Pipeline (Board view) → search "ZZ_QA" (the lead created via NEW-06/07) → header shows "1 match," but every visible Board column (including "ALL 6") shows 0 results. Switch to List view (same search) → header still says "1 match," but the list body renders "No leads match."
- Possible cause: the freshly auto-converted lead may be missing a field the Board/List renderers filter on that the match-counter doesn't check — same shape as NEW-01's "successful load, broken summary/render" pattern. Recommend checking this lead's stage/type fields directly in Firestore during the fix session.

### NEW-10 — Mobile Pipeline list: the floating "+" action button overlaps a lead card's OPEN button
- **Repro:** Pipeline at 375×812 (mobile), card/list layout (automatic on mobile).
- The mobile card list otherwise reflows very well — swipe-to-call/next-stage hint, Call/Text/Map/Open per card — genuinely good mobile design. But the floating orange "+" quick-action button (fixed bottom-right) visually overlaps the action row of the second lead card on screen, covering its "OPEN" button down to a single visible "O." Any card that scrolls into that vertical band will have its Open button partly covered/likely partly untappable.

---

## LOW–MEDIUM

### NEW-07 — Redundant "Hot Lead Detected — Convert Now?" prompt fires after a knock is already auto-converted
- Continuing NEW-06's successful save: three toasts fired — "✓ Interested — 999 Sample Ave, Austin, TX," "⚠ Address not found," "✓ Converted to CRM Lead — visible in your pipeline" — i.e. the app says conversion already happened. Simultaneously, a separate "Hot Lead Detected" modal appeared asking to "Convert Now" / "Skip for now," which is contradictory. Not confirmed whether clicking Convert Now on top of the auto-conversion would create a duplicate lead (Pipeline went 5→6, no dupe observed in this run, but the redundant prompt itself is a real UX inconsistency).

---

## LOW

### NEW-09 — Mobile: the "✓ Font: NBD Default" toast covers the bottom nav bar's "CRM" label
- On the 375×812 viewport, a toast reading "✓ Font: NBD Default" appears bottom-center for ~5 seconds after most page loads before fading on its own (confirmed not stuck — an earlier desktop sighting across several screenshots was this same normal-duration toast catching repeated screenshots, not a real bug; retracted as a separate finding). On mobile specifically it renders on top of the bottom tab bar and fully obscures the "CRM" label for its lifetime. Doesn't block taps, but worth a z-index/position nudge.
- Related, lower-confidence: the "You're on the NBD Pro Free plan" upgrade banner renders in a fixed strip right at the bottom edge below the tab bar on this viewport — worth a real-device (notched iPhone) check for safe-area clipping per the project's phone-scale-testing standing rule; not verified here since this was emulation, not a real device.

---

## Continued sweep (same day, second pass — Photos/Templates/Products/Money/Settings/deeper customer card)

### NEW-11 — Pipeline board/list mis-buckets "quoted" and "won" leads as "New Lead" — verified against raw Firestore data (HIGH, arguably the most business-critical finding of the sweep)
- **Repro:** fresh re-seed + fresh login as `company_admin`. Pipeline board (List view) shows all 5 seeded leads' stages as: Maria Lopez "New Lead", James Nguyen "Inspected", Tara Boone "New Lead", Derek Shaw "New Lead", Priya Patel "New Lead."
- Navigate to **Photos** ("Customers without photos" list, same underlying data): Derek Shaw "NEW", James Nguyen "INSPECTED", Maria Lopez "NEW" (agree with Pipeline) — but **Priya Patel shows "QUOTED"** and **Tara Boone shows "WON"**, contradicting Pipeline's "New Lead" for those same two leads.
- **Resolved by reading the raw Firestore docs directly** (emulator UI, `leads` collection): Tara Boone's doc has `stage: "won"`; Priya Patel's has `stage: "quoted"`; Maria Lopez/Derek Shaw have `stage: "new"`; James Nguyen has `stage: "inspected"`. **Photos is correct. Pipeline (both Board and List view) is wrong** — it is silently re-labeling any lead whose real stage is `"quoted"` or `"won"` as "New Lead," while `"new"` and `"inspected"` render correctly.
- This is a serious, verified bug in the CRM's primary daily-use screen: a rep or admin looking at Pipeline has no way to tell that a deal is already quoted or already won — both read as brand-new, untouched leads. That risks re-pursuing/re-quoting closed business, missing to invoice a won job, and badly distorts the pipeline-value/win-rate math on Home (may also be a contributing factor to NEW-01, since a "won" deal being counted as "new lead" would throw off exactly the kind of aggregate figures that page shows). Likely cause: the Pipeline stage-bucket mapping only recognizes a specific enum of column keys (New Lead/Contacted/Inspected/Estimate Sent/…) and falls back to "New Lead" for any stage value it doesn't recognize, rather than surfacing "Quoted"/"Won" as their own columns. Worth checking `docs/pro/js/` for the pipeline stage→column mapping table/switch statement.

### NEW-12 — Two different generated-document renderers use two different logo/brand treatments (LOW)
- The Estimate Builder V2's "Retail Quote" export (NEW-04) renders a small stylized wordmark reading just "DEAL / Home Solutions" as the logo.
- The Templates → Invoice export (same tenant, same session) renders the full "NO BIG DEAL Home Solutions" logo with the complete tagline lockup and company contact block (phone/email/domain) in the header.
- Both are pulling from the same seeded `companyProfile`, so a customer receiving an estimate vs. an invoice from the same company sees two visually inconsistent letterheads. Likely two independent template-rendering code paths for estimates vs. Templates-library documents, each with their own hardcoded/fallback logo treatment instead of sharing one branding component.

**Positive:** Templates → Invoice → "Auto-fill from Lead" (Tara Boone) correctly pulled name/address/phone/email/total amount ($19,200) into the form, and the generated PDF preview was accurate and well-formatted.

### NEW-13 — Not a product bug: a methodology gotcha worth recording for future sessions
- Testing Expenses → deleting a logged expense appeared totally broken (click did nothing, no confirmation, row stayed). Turned out the app correctly opens a **native `confirm()` dialog** ("Delete this expense? This cannot be undone.") before deleting — and this sandboxed browser environment auto-suppresses native JS dialogs, silently returning `false` to the page. Confirmed via console: `[Claude browser] Page dialog suppressed (confirm): ... confirm() returned false to the page`.
- Overriding `window.confirm = () => true` via the JS console before clicking Delete confirmed the real flow works correctly end-to-end: the expense deletes, Firestore write goes through, spend/margin totals recalculate immediately.
- **Lesson for future QA sessions in this environment:** any destructive action gated by a native `confirm()`/`alert()`/`prompt()` will silently no-op here unless the dialog is overridden first. Don't log "the button does nothing" as a bug until you've ruled this out — check the console for a "Page dialog suppressed" warning before concluding a click handler is broken.

**Positive:** Expenses feature (log expense → job-cost/margin rollup → delete) works correctly end-to-end once the native-dialog gotcha above is accounted for. Margin math checked out ($500 direct cost against a $19,200 job value → 97% margin, correct).

### NEW-14 — Money page: "Job Profitability" claims "9 won jobs" when only 1 lead is actually "won" (MEDIUM)
- **Repro:** Money page → Job Profitability (Won Jobs) card shows: Contract Value $0, Direct Costs $0, Gross Margin "—", Overhead $0, with the caption **"0 of 9 won jobs costed."**
- Ground truth (confirmed via NEW-11's raw Firestore reads): the seeded tenant has exactly **1** lead with `stage: "won"` (Tara Boone, $19,200) — not 9. A Contract Value of $0 is at least internally consistent with "0 costed," but the "9" itself doesn't correspond to anything in this tenant's data.
- Same family as NEW-01/NEW-11: another aggregate/summary widget disagreeing with the real underlying data, this time inventing a count rather than dropping one to zero. Possibly a hardcoded placeholder number shown in the empty state, or a stale/cross-tenant count leaking in — worth checking the widget's data source directly in the fix session.

### NEW-15 — Settings → Estimates "Tier Rates" ($/SQ) appear to be a dead config — likely regression from a previously-verified working feature (HIGH)
- **Repro:** Settings → Estimates → Tier Rates → set Better Tier to $999/SQ (from default $595) → Save All Estimate Settings → confirmed "Estimate settings saved. Every linked estimate will use these rates."
- Tested three different places this rate could plausibly apply, and **none reflected the change**:
  1. Estimate Builder V2, LINE-ITEM mode: adding "GAF Timberline HDZ" still priced at its catalog rate ($180/SQ), unaffected.
  2. Estimate Builder V2, PER-SQ mode (switched the Setup toggle to "Per-SQ" *before* touching Items): the Items tab still showed the identical 278-item line-item catalog — the mode toggle appears to have **no visible effect** on which UI/pricing path is used.
  3. Job Templates → "Asphalt Reroof — Better Tier" preset (the closest thing to a package-based, tier-driven flow): GAF Timberline HDZ line priced at ~$208/SQ (with waste), not $999.
- **Why this matters:** the project's own prior QA history (`documentation/qa/exhaustive-sweep/COVERAGE-SUMMARY.md`, 2026-06-09 session) explicitly verified this exact field with this exact test ("set 999, built a Cash/retail Better estimate → GRAND TOTAL $37,950 vs $22,925 @595 — rate persists AND drives pricing") and found it working. If that's still true today, I simply didn't find the right path to trigger it in this session — but if not, this is a **regression**: a contractor's custom per-SQ pricing (locked in from what the field's own help text calls "the April 2026 price review") could be silently ignored by every estimate they build, always falling back to catalog list prices instead. Given the stakes (this ties directly into what a rep charges), recommend the fix session start by tracing exactly which code path (if any) still reads this Settings value, using `git log`/`git blame` on the relevant Settings/estimate-engine files to check whether the June-verified linkage was later removed or bypassed by the V2 builder's introduction.
- **Restored the setting to its original $595 before ending this session** (verified in a screenshot).

### NEW-16 — Reports' conversion funnel shows "Signed: 0" despite a real won deal (HIGH)
- **Repro:** Reports page, Performance Dashboard (30 days) → Conversion Funnel shows Leads 5, Inspected 1 (20%), Estimate Sent 0 (0%), Viewed 0 (0%), **Signed 0 (0%)**.
- Ground truth: Tara Boone's lead has `stage: "won"` (confirmed via raw Firestore read, see NEW-11) — a won deal should surely count as "Signed" (or whatever this funnel's terminal stage represents), not zero. Revenue also shows $0 for the same reason.
- Same family as NEW-01/NEW-11/NEW-14 — see the unifying root-cause note above.

## Third pass (Job Templates / Sales Training / Academy / Leaderboard / Success Tracker / Storm Watch / Close Board / Rep OS)

### NEW-17 — Job Templates page: multi-select checkboxes track a count but have no working action (MEDIUM)
- **Repro:** Job Templates page (standalone, sidebar → Job Templates — distinct from the in-estimate "From Template" picker). Page copy: "Pre-built quotes — select one or more, customize, and generate a retail estimate." Checked 2 template cards (5-Shingle Roof Repair, 10-Shingle Wind Damage Repair) → header stat correctly updates to "Selected: 2."
- No bulk/combined action ever appears — scrolled through the entire visible page (including to the bottom of the template list) and clicked the "Selected" stat card itself; nothing happens. The only functional buttons are each card's own individual "Use this template →", which is unrelated to the checkbox state.
- A `find` for "Selected" text turned up unrelated hidden elements from other (currently inactive) views in the same single-page app — e.g. "Pull Selected Data →" and "2 templates selected" belong to a different, unmounted component, not this page — so there's no dead-but-findable button here; the multi-select checkboxes genuinely appear to have no wired-up action on this page. Either the "select one or more ... generate" copy is aspirational for a feature that isn't built yet, or a bulk-action button exists but isn't rendering — worth a quick grep for the Job Templates page's selection-count handler.

### NEW-18 — Sales Training scenario script contains prohibited insurance-claim-handling language, and the feedback never flags it as a compliance issue (MEDIUM, content/compliance — not a software defect)
- **Repro:** Sales Training → Pitch Perfector → "The Cold Open" scenario, Step 3. One of the three multiple-choice rep responses (Option B) reads in part: *"...insurance covers storm damage. **We handle the whole claims process for you.** I just need to get up there, take photos, and we can get the ball rolling today."*
- This is close to word-for-word the language this repo's own `CLAUDE.md` explicitly prohibits for Kentucky insurance jobs (memory: `kentucky-insurance-job-law.md` — "no 'we handle/negotiate the claim'... claim-wording gate; CRM fixes in draft #1801").
- Selecting Option B correctly triggers a "Weak Choice — Here's Why" critique (+12 pts, lower than the optimal answer), **but the critique only addresses tone/pacing** ("you answered a question she didn't ask," "pushy," "let urgency come from the situation") — it never mentions that "we handle the whole claims process for you" is a legally risky phrase in at least one state this company operates in. A rep who completes this training could walk away thinking the phrase is merely a *style* misstep rather than a compliance risk, and might reuse similar language on a real KY door-knock.
- Not filing this as a code defect — it's training *content* — but flagging because it directly intersects a compliance rule this repo already treats as important enough to gate in CI and track in a dedicated PR (#1801). Worth a content pass over all "Pitch Perfector" scenario scripts for other prohibited-language patterns (AOB mentions, advance-pay offers, "we negotiate with insurance" framings) while that PR is being worked.

### NEW-19 — Ask Joe AI error message has a doubled period, and confirms NEW-02's downstream impact (LOW)
- **Repro:** Ask Joe AI → click "Best leads to close" quick-action.
- Response: *"Couldn't reach Joe right now. Claude proxy unavailable: AI features require an active paid subscription.. Direct browser calls are disabled for key safety."* — note the double period after "subscription." Cosmetic only, but an easy find-and-fix (likely string concatenation joining two sentences without trimming).
- More importantly, this **confirms NEW-02's real-world impact**: because the seeded subscription doc isn't being found (this tenant should read as an ACTIVE professional plan), Ask Joe's AI chat correctly-per-its-own-logic refuses to work, believing there's no paid subscription. This isn't a new root cause, just concrete evidence that NEW-02 blocks a real feature (AI chat), not just cosmetic banner text.
- Also worth noting: Ask Joe's "LIVE CONTEXT" banner reads "5 active leads · $81,700 pipeline" — same "won" stage counted as "active" pattern as the rest of the unifying root-cause cluster above (Tara Boone's won $19,200 deal is being counted as still-active pipeline).

### NEW-20 — "Maps & Pins" and "Door-to-Door" sidebar items both show active/highlighted at once (LOW)
- **Repro:** click "Maps & Pins" in the sidebar. It correctly redirects into the Door-to-Door page (with a clear, helpful toast: "Maps features are now part of D2D Tracker — use the layer toggles on the map" — good UX for a consolidated feature, not a bug on its own).
- But after the redirect, **both** "Door-to-Door" and "Maps & Pins" render with the active/highlighted sidebar state simultaneously, since they now point at the same route. Minor visual polish issue — the sidebar's active-item logic should treat these as one destination, or the redundant nav entry could be removed now that the merge is intentional and announced.

### NEW-21 — "Project Intel" (`#/projectcodex`) renders completely blank instead of the same Growth-plan paywall its sibling AI Tools show (MEDIUM)
- **Repro:** sidebar → AI Tools → Project Intel, while on the Free plan.
- Its siblings **Decision Engine** and **Deep Dive** both correctly show a polished "Upgrade to unlock this tool — Growth Feature" paywall screen listing what's included and an Upgrade button.
- **Project Intel instead renders a totally blank page** — no paywall, no content, no error banner, nothing. Checked the console for a page-specific crash and found none obviously tied to this route (background CORS noise from unrelated AI watchers was present regardless of page, and one unrelated Chart.js error was left over from an earlier Daily Success page visit — see NEW-22). So this looks like a missing/unwired paywall component for this one route specifically, rather than a caught JS exception. Worth checking whether `projectcodex`/Project Intel has its own gating component that was never hooked up to the same Growth-paywall renderer the other two AI Tools use.

### NEW-22 — Daily Success tool throws an uncaught Chart.js canvas-reuse error on repeated navigation (LOW)
- **Repro:** Sidebar → Success Tracker (opens standalone `/pro/daily-success` page) → navigate away and back (or reload) a couple of times.
- Console: `Uncaught Error: Canvas is already in use. Chart with ID '0' must be destroyed before the canvas with ID 'c-doors' can be reused.` at `daily-success/js/app.js:564` (`mkChart`).
- Classic Chart.js re-init bug: the chart instance bound to the `c-doors` canvas isn't destroyed (`chart.destroy()`) before the page tries to create a new one on the same canvas element. Low severity since the tool is otherwise functional (data still saved/loaded correctly per the positive check below) and the error doesn't appear to block interaction, but worth a quick fix — uncaught errors like this can cascade into a dead page if something else depends on that chart rendering.

## Positive checks (no bug found — worth recording so they aren't re-tested from scratch)

- **Cost/margin privacy holds on customer-facing exports.** The Estimate Builder V2 Review tab legitimately shows Material/Labor/OH+Profit/Margin breakdowns to the rep (expected — internal pricing tool), but the "Retail Quote" customer-facing PDF export showed ONLY the retail total ($6,925) with zero cost/margin leakage. The 270-item catalog also shows only retail per-SQ prices.
- **Viewer role write-blocking works.** The `viewer` role's Home "Quick Add Lead" form is visually present and fillable, but submitting is correctly blocked server/logic-side with "Your role is view-only — ask an owner or manager to make this change." (Minor UX nit only: the form should probably be disabled/hidden for viewers rather than blocked after the fact.)
- **Address geocoding in the Drawing tool works correctly** (pans/zooms to the real satellite location on a valid address) — the Roof Calculator contradiction in NEW-05 is a calculator-only issue, not a search issue.
- **Door-to-door knock → CRM lead auto-conversion works** for an "Interested" disposition (aside from the NEW-06/NEW-07 rough edges around it) — no duplicate lead was created in this run.
- **Real Deal Academy** works end-to-end: module accordions expand (a previously-reported bug, confirmed fixed and holding), lesson content renders, quiz scoring/feedback is correct (2/2 → "Quiz Passed!"), auto-marks the lesson Completed, and the Overview stats + Recent Activity log update immediately and accurately.
- **Sales Training scenario simulator** (Pitch Perfector) works well mechanically — branching dialogue, point scoring, skill-tag breakdowns (Empathy/Rapport/Authority/etc.), and "Weak Choice — Here's Why" critiques all functioned correctly across 2 full steps (see NEW-18 for a content-level compliance concern, not a mechanical bug).
- **Close Board** full lifecycle works correctly: create a deal room with customer info + pricing tiers → validates required tier pricing → generates a real customer-facing multi-tier preview (Standard/Preferred/Elite with financing estimates and "due at signing" math) → Close works on this preview → Delete removes it cleanly, counts update immediately (1→0 active deals).
- **Rep OS** "Generate Today's Briefing" produces a sensible daily plan (schedule blocks, mindset note, quick actions) with no errors, entirely from local heuristics — no backend dependency to fail in the emulator.
- **Daily Success** (standalone `/pro/daily-success` PWA-style tool) correctly persists localStorage state across reload — toggled a daily floor checkbox, saved, reloaded, and the checked state + score survived (aside from the unrelated chart bug in NEW-22).
- **Settings → Estimates → Weekly Digest checkbox** (a historically-reported non-round-tripping bug from a prior QA campaign) is now fixed and holds correctly across save + reload.

## Round 4 — 2026-09-28 (sales-rep role, lead lifecycle, customer page, phone) — found and fixed in the same PR

Emulator re-seeded production-shaped; functions emulator loaded (needs
`FUNCTIONS_DISCOVERY_TIMEOUT=90` — the 10 s default times out on this machine).
Logged in as `sales_rep`. Each fix was re-checked in the browser.

| # | Finding | Fix |
|---|---|---|
| R4-01 | **Home shows form-created leads by their address.** The lead form writes `firstName`/`lastName` and never `name`; Hot Leads, Recent Activity, Stale Leads and Close Board read `l.name` only (the seed writes `name`, so the emulator hid it). Same read on the Photos lead picker ("Unknown — address"), the Jobs map popup, Ask Joe alerts ("Hot lead: Unknown"), the Leaderboard feed and the **inspection report's homeowner line ("N/A")**. | First/last name first, then `name`, at every site. |
| R4-02 | **Close Board summed `estValue \|\| value`** — fields a lead doesn't have — so it always read $0 closeable. (Pipeline Value had the same bug, fixed 2026-06-21; this sibling was missed.) | `jobValue` first, legacy fallbacks after. |
| R4-03 | **Red "Address not found" after a successful save**, on every save of a lead with no map coordinates, and once per unmappable lead while the Customers/Jobs map layers geocode in the background. | `geocode(q, {quiet:true})` for background + save callers; the save shows one plain info note only when the address is new or changed. |
| R4-04 | **Customer page stage badge stayed on the old stage** after "Move to …" succeeded (button and toast had advanced). | Badge updated in place; badge + background refresh use the tenant-aware label (a custom stage no longer reads "New Lead"). |
| R4-05 | **"[object Object]" toast** when a customer-page stage move is blocked by required fields — the page's `showToast` didn't accept the object form, so the rep never saw which field was missing or the "Open full editor" button. | Object form + action button supported. |
| R4-06 | Blocked-move message listed raw keys ("insCarrier, claimNumber"). | Shared `REQUIRED_FIELD_LABELS` in `crm-stages.js` → "Carrier, Claim #". |
| R4-07 | **Retired AOB checkbox visible and tickable** in the lead editor: `<div class="mrow" hidden>` but `.mrow{display:grid}` beats the UA `[hidden]` rule. Same pattern put an **empty red ⛈ storm pill** on every phone job-detail sheet without a hail hit. | `.mrow[hidden]` / `.m-jd-storm[hidden]` → `display:none`. Scanned 19 other Pro pages for `[hidden]` elements that still render: none. |
| R4-08 | Raw stage keys ("Stage: contacted") in the Deleted-leads bin, overdue follow-up notifications and the customer timeline. | Stage labels. |
| R4-09 | Invoice dialog on a customer with no estimates was a bare "Enter estimate ID" box. | Says there are no estimates yet and to build one first. |
| R4-11 | **Pasting a Cal.com link as the username broke every booking link.** Schedule page built `cal.com/https://cal.com/joe/roof-inspection`; Settings saved `https://cal.com/joe` as `calcomUsername`, so texted/emailed links were broken and `calcomWebhook` could not match bookings to the rep. Also the Schedule page's Cal.com box was a separate localStorage-only setting (ignored Settings, wiped at sign-out), and **Copy Link said "Booking link copied!" while copying nothing** when unset; Open Full Page silently did nothing. | Both inputs reduce a pasted link to username (+ slug); the Schedule box reads/writes `users/{uid}.calcomUsername/calcomEventSlug` (verified: survives a local-storage wipe); Copy / Open say "Set up your booking link first". **Prod follow-up:** users already saved with a URL-shaped `calcomUsername` stay broken until re-saved. |
| R4-12 | **Templates → any generator: form labels invisible** — near-white app text on the form's hard-coded white panel ("Auto-fill from Lead", "Homeowner Name*" …). And the required `*` fields weren't enforced: a Warranty Certificate generated with a blank "Work Performed". Insurance section header said "6 docs" over 5. | Panel sets its own dark text; required fields outlined red + "Fill in: …" toast; header 5. (Generate → auto-save to the lead → "Save to Customer" updates that copy, no duplicate — verified.) |
| R4-13 | **Refreshing Team Manager (`#/admin`) bounced every owner to the Dashboard** with "Admin access required": the route ran before sign-in resolved. Related: the nav gate could run in the gap between `_user` and `_userClaims` and never re-run. Owners also saw a raw rules error ("Could not load inbound texts: …") for the platform-admin-only unknown-number inbox, and **their own row always said "0 leads"** (hard-coded in `listTeamMembers`). | Route waits for a signed-in, claims-loaded gate verdict; nav gate re-runs when claims land; inbox panel only for platform admins; owner lead count computed. *Seed:* now writes `companies/{id}` + `members/{email}` (roster read 1 member and analytics 0 leads without them — artifacts). |
| R4-10 | **Viewer's right-click menu offered every write** (Edit, Add task, Move, Snooze, portal links, Delete). Each was refused on click (the role gate held), but Delete opened a "Move to Deleted?" dialog with only Cancel. | Viewer menu shows View details / Call / Copy phone / Copy address / Open in Maps. Drag and Log Contact were already refused with a clear toast. |

**Not bugs (rig artifacts):** the "AOB required for Claim Filed" block was a
stale cached `crm-stages.js` (source dropped it 2026-09-27); "Couldn't copy
link: internal" on Copy Portal Link is the emulator page calling the
*production* `createPortalToken` with an emulator token.

**Worked:** Quick Add validation → prefilled full form → save; kanban drag
New → Contacted (writes stage history); tasks add / check / delete; lead
edit validation (email, 10-digit phone, `12,500` → 12500); right-click
Delete → Deleted bin → Restore (stage, value and task count intact); phone
list stage dropdown to a gated stage opens the editor instead of skipping.

## Round 5 — 2026-09-28 (after #1820 shipped): Settings, estimate list actions

| # | Finding | Fix |
|---|---|---|
| R5-01 | **Settings → Profile lost data on refresh.** Refreshing on `#/settings` ran the Profile loader before the bootstrap module had registered it (and before sign-in), so saved Phone / Google review link / Cal.com showed blank — and the next **Save wrote the blanks over the real values** (reproduced: phone wiped). | Tab retries until the loader exists; the loader waits for sign-in; the sign-in profile read also repaints the tab. Verified: every field survives a refresh. |
| R5-02 | **Company / Role / License # were never saved** (a code note called them "deferred"), while Save said "Settings saved!". | Stored on the rep's own `users/{uid}` as `profileCompany` / `jobTitle` / `licenseNumber` and loaded back (never `role`, which is claims-owned). |
| R5-03 | An invalid Google review link was silently cleared under a success toast. | Warning toast says it must start with https:// and was cleared. |
| R5-04 | Toasts read "✓ ✓ Estimate duplicated" — callers prefix a ✓ beside the type icon. | The toast drops a leading mark that repeats its icon (app-wide, one place). |
| R5-05 | **Reports → Lead Source ROI counted finished jobs as open pipeline.** Its hand-copied closed list missed Install Done / Final Photos / Collections / Warranty Claim and custom won stages. | Uses the shared stage role (verified: a lead at Install Done moves from pipeline to closed revenue). |
| R5-06 | Same drift in margin analytics (`profit-tracker.js`) and the standalone Leaderboard page: Collections and Warranty Claim jobs (ROLE won in `crm-stages.js`) were not counted as won. | Profit tracker uses the stage role (list as fallback); Leaderboard list matches ROLE won. |
| R5-07 | A non-appointment hot knock (e.g. Callback Requested) toasted **"Converted to CRM Lead — visible in your pipeline"** but is saved as a prospect, which the pipeline hides. | Toast says "Saved to Prospects — promote it when it's qualified"; appointments keep the pipeline message. Prospect → Promote to customer verified. |
| R5-08 | Photo upload button read "Upload 1 Photos". | Singular/plural by count. (Upload itself verified: stored under the tenant, shown on the customer page.) |
| R5-09 | *Seed:* invoices showed NBD's name/phone/logo for "Demo Roofing Co" because the seeded profile had no `brand.legalName` (real signups always write it — `createCompany` + onboarding); seeded estimate rows didn't sum to the subtotal. | Seed writes the tenant brand and rows that add up. Not a production bug. |
| R5-10 | **Paying an invoice in full dragged a Closed job back to Contract Signed.** `markPaid` wrote `stage: contract_signed` on every payoff, whatever the lead's stage — the job left won revenue and reappeared on the board as an active contract. | Only advances a lead that hasn't reached Contract Signed / a job / won / lost. New behavioral test `invoice-markpaid-stage.test.js` (fails 4/11 on the old code). |
| R5-11 | **Customer Project Timeline was insurance-only**: a cash / finance / warranty / custom-stage lead matched none of its milestones, so nothing showed as reached. Also labelled `estimate_submitted` "Estimate Approved". | Timeline follows the lead's own tenant-resolved track (shared `_pipelineFor`); "Estimate Sent". Verified on a cash lead at Est. Sent. |

**Worked:** estimates list Duplicate (copy is unassigned by design on this list), Rename, Assign-to-customer with search, Delete; seeded estimates now carry title/address like real saves.

## Round 6 — 2026-09-28

| # | Finding | Fix |
|---|---|---|
| R6-01 | **Every follow-up read as due a day early** in US time zones: `followUp` is stored `YYYY-MM-DD` and `new Date()` parses that as UTC midnight (the previous evening locally). Hit the pipeline "Follow-ups Due" banner, the card badge, the **"Overdue Follow-Up" bell notifications**, Analytics overdue count, Ask Joe's overdue list and lead scoring. The banner also printed "Due: 2026-09-29". | Local-day parse at all 7 sites (`window.nbdFollowUpDay`); banner says "Due today" / "Due Sep 29" / "3 days overdue". Verified: a tomorrow follow-up no longer shows, today's does. Test `followup-local-day.test.js` (runs under TZ=America/New_York, with a control proving the old parse is a day early). |
| R6-02 | **Home → Revenue This Month: setting the monthly goal didn't update the widget** (its re-render looked up `window._widgets`, which never existed), and the goal lived only in `nbd_` localStorage, which sign-out wipes. | Re-renders in place; saved to `userSettings/{uid}.monthlyGoal` too and restored from there. Verified: 0k shows immediately and survives a cache wipe. Close Board (#1820 fix) verified: "$9.8k closeable · Derek Shaw". |
| R6-03 | **Bell + Needs Attention flagged never-sent draft estimates as "Estimate awaiting reply — sent 1w ago"** (they fell back to `createdAt` when `sentAt` was missing), and the bell showed **"$0 estimate"** (read `total||amount`, not `grandTotal`). The bell also showed a live "Follow-Up Today" for a follow-up dated tomorrow — R6-01 in the wild. | Drafts with no send evidence (`sentAt`, e-sign `signatureStatus`/`signatureSentAt`, or `viewedAt`) are skipped — same draft test as the Estimates page; amount reads `grandTotal` first. Verified: 3 phantom rows gone (bell 5 → 2). |
| R6-04 | *Seed:* lead phones were 7 digits (`555-0213`), which the lead form refuses — every seeded lead failed its own edit-save. | Seed uses 10-digit numbers. **Worked:** duplicate detection (same phone → "Possible duplicate — HIGH MATCH" with Cancel / Create anyway); snooze ("Tomorrow morning" hides the card, bell/board agree); contract legal text resolves to the tenant ("Demo Roofing Co's total liability", neutral cancellation law). |

## Round 7 — 2026-09-28

| # | Finding | Fix |
|---|---|---|
| R7-01 | **Refreshing on a view painted it from empty data and never repainted.** Photos: "No customers yet" + empty property picker (6 leads existed). Dashboard (Analytics): $0 pipeline, "No lead data yet". Money: "Your books", $0 collected / $0 A/R (in-app: Team-wide, $8,160 / $8,160). These views built once on entry, before sign-in and `loadLeads()` finished. | They now repaint on `nbd:data-refreshed` (leads) when on screen. Verified each after a refresh. Estimates, Reports, Settings, Prospects already recovered. |

## Round 8 — 2026-09-28

| # | Finding | Fix |
|---|---|---|
| R8-01 | **The customer page's Edit Info form saved anything**: phone "123", email "bad", and a **negative job value** (−$500 subtracts from every pipeline total). The pipeline editor rejects the first two; neither rejected a negative value. | Customer form uses the pipeline editor's exact rules; both forms refuse a negative job value (and lead cost). Verified: each bad value refused with a clear message, a valid save still works. **Also verified:** a sales rep who opens `#/admin` directly is turned away with the nav hidden (round-4 guard change holds); Money shows a rep "Your books". |
