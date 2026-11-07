# MORNING REPORT — NBD Pro CRM overnight audit (2026-11-06 → 2026-11-07)

The run started 2026-11-06 at 08:38 ET. Jo asked for an early wrap-up at about 00:00 ET on 11-07, ahead of the planned 06:30 ET stop.
Live state for the run is in this folder: [STATE](STATE.md), [LOG](LOG.md), [DECISIONS](DECISIONS.md), [NEEDS_JOE](NEEDS_JOE.md), [SCORECARD](SCORECARD.md), [PLAN](PLAN.md).

## The short version

- **Audit:** 908 rows were scored across six slices (pipeline, customer card, estimates & documents, settings/team/billing, other views, and the data map with Cloud Functions). That produced **247 findings**: P0 3, P1 11, P2 92, P3 141.
- **Fixes:** **44 PRs** were opened. **37 are merged**, **4 are held as drafts for Jo** (#2941, #2942, #2981, #2994), and **2 opened during wrap-up**:
  - [#2996](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2996): viewer guards (CU-F19).
  - [#2995](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2995): a fix to my own warranty-accent test. After #2980 merged it compared NBD against a moving main and failed locally on main.
- **Browser re-sweep, before → after** (same seed, routes and users; [SCORECARD-AFTER](SCORECARD-AFTER.md)):
  - Serious/critical accessibility nodes: 656 → 516 for owner A, 585 → 482 for owner B, 524 → 421 for the rep. Routes with any serious issue: 71 → 69.
  - Tenant B routes showing NBD text: 4 → 3.
  - Page errors stayed at 0, 390px overflow at 1 route, and blank views at 5. The after run served main minus 18 commits.
  - All 3 P0s are merged.
  - 7 of the 11 P1s are merged. Two more are in the held drafts.
  - About 117 findings are fixed on main.
- **Every PR was test-first.** Each new suite fails on the main it was cut from and passes with the fix. Each PR ran the full local gates, and every node bucket matched the 8 known Windows-only failures.
- **Nothing was force-pushed, merged by hand, deployed, or written to production.** The merge queue and the PR steward session did all merging.

## What needs Jo (most important first)

1. **Four held drafts.**
   - [#2994](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2994): the Keyboard Shortcuts "Got it" button finally closes the panel, and sign-out stops the estimates listener. It needs a **1 KB boot-budget raise**: the fixes add about 440 shipped bytes to the dashboard and main has 184 left (NEEDS_JOE #24).
   - [#2941](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2941): ice & water bills the eave band (MONEY).
   - [#2942](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2942): Settings → Estimates values survive sign-out (MONEY).
   - [#2981](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2981): stage emails stop sending NBD's warranty pledge, Acorn financing and the $100 referral bonus to other companies' homeowners. Its wording needs your read.

   The two MONEY PRs say "review line by line" for a reason: they change totals.
2. **Emails (ED-F19): you answered this tonight.** "jd@ on anything going to me directly and info on anything general on site." The next step is one PR that sorts the seven document spots that print jd@ today (estimate-finalization ×2, estimate-supplement, warranty-cert ×2, photo-report, inspection-report-engine). It will show you the per-spot sort before it merges.
3. **[NEEDS_JOE](NEEDS_JOE.md)** has 24 items. The ones that block real fixes:
   - **#1 and #23, estimate math that changes prices.** The layers select does nothing on the line-item path (ED-F01, P1). Job templates ignore Settings markup and overhead. Round-To only applies per SQ. Dumpster size goes by squares.
   - **#9, invented content in blank document templates (ED-F16).** Sample GAF materials, made-up delivery quantities and pre-checked QA boxes can reach customer paper.
   - **#20, "Limited lifetime" warranty strings (ED-F27).**
   - **#21, "Your warranty certificate is attached" with nothing attached (VW-F153).**
   - **#3, portal "Send reply" fails Unauthenticated (CU-F21, P1).** The cause is suspected server-side (App Check or the callable). It's Tier C, so it's a proposal only.
   - **#22, Settings that save but nothing reads.** The Company tab, Profile company/role/license, the notification triggers and three legal fields.
4. **Delete the stray `C:\c\` folder.** My scripts made it by passing Git Bash `/c/...` paths into Node. Those scripts now use `C:/` paths.

## Decisions taken without Jo ([DECISIONS](DECISIONS.md))

- **D-009:** proposals only, nothing built, for ST-F11 (contact fields can't be cleared), ST-F62 (stranded email signup), VW-F156 (deploy reloads open tabs) and ST-F35 (the AI usage panel copy).
- **D-010:** refer.html's default title is left alone, because changing it would also change NBD's own referral page. The better route is portal.js always sending `&co=`.
- **D-011:** unbounded reads (Agent Inbox, Thursday handled numbers, leaderboard, KPI, photo counts) were **not** capped. A cap would hide data: a handled number past the cap would show as unhandled, and counts would come up short. They need server-side counts or paging.
- **D-012:** the native confirm fallbacks (VW-F10, VW-F105, ST-F16) are the sanctioned `nbdConfirm || confirm` pattern, so they stay. Native `prompt()` callers need a shared, deferred prompt helper first, which is a design task.
- **D-013:** CU-F19 (viewer guards, customer page, not counted by the dashboard budget) ships alone. PL-F23 and PL-F27 are parked in draft #2994 for the budget call.
- **VW-F160 is blocked by the boot budget.** standalone-compat.js is parser-blocking, and the budget has about 13 bytes of headroom.

## What's left (not built)

- About **123 findings have no PR.**
  - About 35 P2 and 86 P3, roughly two in five of them Tier A (UI, a11y, brand), are open for a normal session.
  - The money/logic and Tier C items wait on Jo or on a proposal.
  - The per-finding table is in `findings-status.md` next to this report.
- **Blocked on files that the held drafts edit:** VW-F161 (email modal keyboard) and the rest of VW-F162 (email modal colours) wait on #2981.

## PRs tonight

| PR | State | Title |
|---|---|---|
| [#2938](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2938) | merged | chore(tooling): CRM audit harness + full scorecard (908 rows, 242 findings) |
| [#2939](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2939) | merged | fix(pro): Edit Lead stops erasing stored intel, parcel, knock link and server-written sour |
| [#2940](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2940) | merged | fix(pro): close four board paths that act on the wrong lead (incl. the long-press search i |
| [#2941](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2941) | draft, held for Jo | MONEY/LOGIC — review line by line: ice & water variants bill the eave band, not the whole  |
| [#2942](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2942) | draft, held for Jo | MONEY/LOGIC — review line by line: Settings → Estimates values survive sign-out (restored  |
| [#2943](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2943) | merged | fix(pro): other tenants' paper stops carrying NBD's name, the product name, retired colour |
| [#2944](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2944) | merged | fix(pro): customer card stops re-filing uploads, editing the wrong photo, and carrying a d |
| [#2945](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2945) | merged | fix(pro): CSV export neutralises formulas; refused profile saves roll back; setup wizard k |
| [#2946](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2946) | merged | feat(pro): customer card shows calls matched by number; optional Drive folder link on the  |
| [#2947](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2947) | merged | fix(pro): stale address on contracts, re-uploaded files, a lying stage select, blanked pro |
| [#2948](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2948) | merged | fix(pro): D2D texts, win-back drafts and storm scripts stop naming No Big Deal to other co |
| [#2949](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2949) | merged | fix(pro): six screens stop saying "saved" or "All clear" when they weren't |
| [#2950](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2950) | merged | fix(pro): saved reports, photo pickers and Ask Joe schedule stop querying in ways the rule |
| [#2951](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2951) | merged | perf(pro): Lead Source ROI only re-reads expenses when Reports is showing |
| [#2952](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2952) | merged | fix(pro): delete-confirm and duplicate-customer dialogs work from the keyboard |
| [#2953](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2953) | merged | fix(pro): bots timezone, persona name, follow-up dismiss, multi-job cards (CRM audit integ |
| [#2954](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2954) | merged | fix(pro): Docs view Blank buttons + Uploaded Documents, CSV import closed mid-run (CRM aud |
| [#2955](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2955) | merged | test(e2e): phone-tenant-setup types prices until they hold before saving (OR-F10) |
| [#2956](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2956) | merged | fix(pro): Team tab controls and Business Rules editing only for roles the server allows (C |
| [#2957](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2957) | merged | fix(pro): honest alert preview, GX reset, Daily focus category, appearance checkboxes (CRM |
| [#2958](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2958) | merged | fix(pro): customer page photo popup, drop zone and service-locations label work from the k |
| [#2959](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2959) | merged | chore(tooling): CRM audit gates run every node suite; harness phone-size eval |
| [#2962](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2962) | merged | fix(pro): customer page secure-link and prerequisite dialogs work from the keyboard (CU-F1 |
| [#2966](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2966) | merged | fix(pro): Pixel Mode toggles load, Ambient Sound shows its state, Settings placeholders st |
| [#2967](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2967) | merged | fix(pro): fallback drop moves a card once, long press stops eating the next tap, Team Mana |
| [#2968](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2968) | merged | fix(pro): customer page failure states (notes, signature requests, no-id link, Messages st |
| [#2970](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2970) | merged | fix(pro): NBD's slogan off other contractors' door hangers and thank-you letters; e-sign h |
| [#2971](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2971) | merged | fix(pro): imported leads get an age on Prospects; company admins can set the AI persona te |
| [#2974](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2974) | merged | fix(pro): customer photo popup escapes its photo URL; document drops are checked for type  |
| [#2975](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2975) | merged | fix(pro): platform-only tools hidden from tenant owners; pricing waits for the restored se |
| [#2977](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2977) | merged | fix(pro): Understand page reads the real /leads for its pipeline context (CRM audit DT-F18 |
| [#2978](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2978) | merged | fix(pro): generic document stops printing internal fields, drops the NBD Pro title, escape |
| [#2979](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2979) | merged | fix(pro): Call Center +1 search, referral mark-paid fails closed, Reports enrich summary a |
| [#2980](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2980) | merged | fix(pro): warranty certificate uses the tenant's accent colour, not NBD's orange (CRM audi |
| [#2981](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2981) | draft, held for Jo | fix(pro): stage emails stop sending NBD's own offer to other companies' homeowners (CRM au |
| [#2982](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2982) | merged | fix(pro): Billing tab says when the plan could not load, with a retry (ST-F37) |
| [#2983](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2983) | merged | fix(pro): Team roster shows loading/error; removing a pipeline stage that holds leads is b |
| [#2984](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2984) | merged | fix(pro): seven CRM view fixes — failures surface, keyboard import, tenant-neutral copy (V |
| [#2985](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2985) | merged | fix(pro): list money reader, persona save guard, call audio survives re-render, Docs keybo |
| [#2987](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2987) | merged | fix(pro): CRM orange buttons and banners follow the company's --orange (VW-F162, PL-F22) |

## Process notes for the next session

- **Merge queue:** CANCELLED PR-level checks are superseded runs. A queue kick-out's real failure is in the `merge_group` run. A test added by a PR *ahead* in the group can fail it, as #2969 did to #2971.
- **Shared lines:** each PR's ci-manifest and INDEX lines went at separate, distant anchors, and merge-tree was checked against main and the queued PRs. Serial conflicts in those files were the main throughput cost.
- **Inline-style ratchet (2079):** keep it flat. Reuse an existing template or add a class; never add a `style=`.
- **New top-level `window.*` / DOM calls need a `typeof` guard.** The vm test sandboxes stub only what they use (7 call-center suites broke on one `window.addEventListener`).
- **The public-surface tripwire scans code comments.** Never quote a real phone number in a comment.
- **Held PRs:** keep them as drafts. The steward suspects the app's PR binding can turn auto-merge on, so don't bind held PRs.
