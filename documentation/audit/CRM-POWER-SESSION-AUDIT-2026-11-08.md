# CRM power session: a multilayer audit and what it changed (2026-11-08)

Jo asked for one surface, the site or the CRM, audited in layers, with a view
to cleaning up code, improving the site and upgrading the CRM. This note is
the pick, the measurements, and what shipped from them. Branch
`claude/funny-hawking-t9zyzm`, one draft PR with one commit per lane.

## The pick: the CRM

The week before this session (50 commits, 2026-11-01 to 11-07) was almost all
CRM work. The public site had a twelve-pass sweep on 11-07 that found one
contrast fix and nothing else ([TWELVE-PASS-SWEEP-2026-11-07](TWELVE-PASS-SWEEP-2026-11-07.md)).
The CRM, on the same day, had:

- 121 findings from the overnight audit with no PR
  ([findings-status](../../overnight/crm/findings-status.md): 35 P2, 86 P3);
- about 2,600 lines of brand-new feature code merged after that audit ran and
  turned on for every tenant the same day: NBD OS (#2989), Mission Control
  road-time ordering (#3013), the round record button (#3009, #3011);
- a dashboard boot budget with no room left: 215 local script tags against a
  215 ceiling, 85 KB blocking against 85 KB, and about 184 shipped bytes under
  the 2856 KB local ceiling, with two fix PRs (#2994, #3008) held as drafts
  because they could not fit.

So the CRM is where cleanup, upgrade and risk all sat. Main was green
(deploy run 2599) and all 887 node suites passed locally before any change.

## Layer 1: boot weight (code cleanup)

**What the dashboard ships.** `docs/pro/dashboard.html` carries 215 local
script tags: 20 blocking (74 KB minified), 4 modules (141 KB), 9 inside
`<template>` (62 KB), and 182 classic `defer` scripts (2,165 KB). Everything
measured with the boot-budget gate's own tokenizer and esbuild (minify,
keepNames, es2020); the gate's own figure for the same tree is 2,858 KB
because `scripts/minify-shipped.js` uses slightly different options. The top
20 deferred files are 913 KB; the top 100 are 2,031 KB. Earlier lanes already
cut requests (deploy-time join, Phase 2b bundles) and render-blocking CSS
([BOOT-CSS-2026-11-06](BOOT-CSS-2026-11-06.md)); the bytes parsed and run at
boot had not moved.

**Who reads what.** A script that no boot-path code references can leave the
boot path. For each deferred script I took its globals (`window.X =`,
`root.X =`, top-level declarations) and looked for readers in the other
dashboard tags, in lazy-bundle files and in other pages. Of 182 deferred
scripts, 20 (213 KB) have no reader among the other tags, and 27 more (about
240 KB) have exactly one. That list is the map for the next passes:

| Shipped | File | Why it is still eager | Candidate |
|---|---|---|---|
| 50 KB + 22 KB | my-skin.js, my-skin-logic.js | paints a chosen background at boot; also customer.html | a user without a skin should not load it: check the boot read first |
| 34 KB | chibi.js | the Home game card draws it synchronously (deliberate, 2026-10-25) | no |
| 33 + 15 + 15 + 5 KB | production.js, production-logic.js, schedule-planner.js, -logic.js | the job card's production strip | only if the strip is view-only; needs a read |
| 27 KB | ky-insurance-law.js | NBDJurisdiction, read by document code only | yes, into the docgen bundle (also customer.html) |
| 24 KB | deposit-rule.js | kept eager 2026-10-11 for builder/invoice/deal-room wiring | re-check: today only a lazy file reads it |
| 19 + 14 + 14 + 13 + 10 + 17 KB | reputation, stale-leads-cleanup, lead-source-fixer, speed-to-lead, follow-up-board (+logic, opp-approval), estimate-follow-board | flag-gated features, each polling its flag every 60 s | **done this session** |
| 17 KB | numbers-logic.js | Reports / Sunday review; also customer.html and leaderboard.html | yes, with reports |
| 15 KB | pipeline-rich-cards.js | read synchronously by crm-pipeline.js when the board is in the rich density | no (deliberate, 2026-10-11) |

**Boot timers.** 20 dashboard scripts start a `setInterval` at boot. Six of
them were the flag-gated features above, each polling its flag every minute
whether or not the flag was on; others are the Home widgets (5 min), the bell,
the activity feed and the filters (60 s), the connection button (10 s) and the
load-status banner (1 s). Not changed beyond the six.

**Dead files.** Of 471 files under `docs/pro/js`, one is referenced by nothing
(`demo-reveal.js`, 0.3 KB) and one only from tests and docs
(`doc-link-view.js`, 3 KB). Left alone (rule: mention, don't delete).

**Duplicated helpers, by design.** `esc` is defined in 141 files, `uid` in
63, `money` in 36, `escapeHtml` in 24, `fmtMoney` in 16, each inside its own
IIFE. That is the page-scoped-helper rule, not drift; sharing them was
declined before as an unrequested refactor (11-06 portal note). Not a cleanup
target.

**Shipped (commit 1, `perf(pro): six flag-gated toolbar features…`).** The
six features are ScriptLoader bundles, registered at runtime by the new
`js/dark-features.js` (1.1 KB, deferred) so the blocking `script-loader.js`
does not grow, and fetched the first time NBDFlags reports a flag on
(`nbd:flags-loaded` fires on every flags read, so a flag turned on later still
loads without a reload). Measured: local tags 215 → 207; shipped bytes
2,858 → 2,741 KB; six boot timers gone. The ceilings were lowered to 207 and
2,748 KB (about 7 KB of headroom, enough for #2994 and #3008 and ordinary
work). Proved in Chromium against the real files: nothing fetched before the
flags, the enabled flags' files fetched when they arrived, the five-file board
bundle in order, no duplicate fetch, no page error. The eight suites that
pinned the eager tags now pin the bundle. New suite:
`tests/dark-features-lazy-2026-11-08.test.js` (40 checks, four mutations each
caught).

## Layer 2: the fresh code (quality)

An independent review (a subagent that had not seen this session's work) read
NBD OS, the Mission Control road-time change and the record button in full,
against the house rules. Clean: CSP (no `style=`, no inline handlers,
delegated listeners), escaping of every tenant string, `nbd_`-prefixed
storage, `typeof` guards, teardown on layout switch, state bounds, and the
`routeDrive` server (auth, App Check, 2 to 25 stops, bbox, 60/min/uid, 12 s
OSRM timeout, coordinates never logged). Eleven findings; the three confirmed
P2s shipped in commit 2:

1. **DND and the object form of showToast.** `ui.js` takes both
   `showToast('msg', 'type')` and `showToast({ message, type, undoAction })`;
   the DND wrapper read only the first. An object toast had no type (held as
   info), lost its undo and showed as "[object Object]" in the history. With
   DND on, "Moved 12 leads · Undo" never appeared. Now both shapes are read and
   a toast that carries an undo is never held.
2. **Phones showed no DND.** The phone tray is the clock alone, and its dots
   covered warn/alert tones only; DND (quiet) persists across sessions, so
   toasts were held with nothing in the header saying why. The clock now
   carries a quiet dot and names DND in its label.
3. **Phone bar long-press also tapped Record.** The release's click reached
   the Record visit button first and bubbled to the recorder's document
   delegate, so a recording started under the open switcher; a long-press on
   bar padding left the swallow flag set and ate the next tap. The swallow now
   runs first, stops propagation and clears itself when no click follows.

P3s left for a normal session (file:line in the review): `route-drive.js`
returns `not_supported` on any 404 without a log line, and the client
memoises it for 10 minutes; `mission.js` caches a failed matrix for the whole
mount; the `osSystemLayer:false` kill switch is not honoured on a first load
from an empty cache; the boot and lock screens fall back to the hard-coded
"NBD" logo mark for a tenant with no business name, and the layout is named
"NBD OS" for every tenant; `os-locked` is a dead class and `checkIdle`
repaints the lock every 15 s dropping focus; `visit-recorder-launcher.js:246`
reads `NBDVisitRecorderMenu.toggle` without a guard; `S.routing` in `os.js`
is dead; a third copy of the `nbd_vr_unfiled` read.

## Layer 3: the open findings (upgrade)

Of the 35 open P2s, these were already fixed by merged PRs and should be
marked so in `findings-status.md`: VW-F100 (#2977 reads the flat `/leads`),
ED-F28 (#2954 injects the Blank buttons), ST-F54 (#2985's `loadFailed`
guard). Money and logic items (ED-F02, ED-F04, ST-F03, OR-F07's behaviour)
stay with NEEDS_JOE; D-009's proposal-only items (ST-F11, ST-F35, ST-F62,
VW-F156) stay proposals; ST-F04/F07/F08 are NEEDS_JOE #22.

Shipped in commit 3, none touching money or a held draft's files:

- **PL-F10** filed dates re-stamped on every save → kept (`data-filed-at`).
- **ST-F61** wizard re-run undid a Settings rename → the brand is read first.
- **ST-F63** native `confirm()` on the public pricing page → straight to register.
- **ST-F24** sign-out wiped nine device UI prefs the purge's header promised
  to keep → on the KEEP list (hotkey toggles by prefix).

Ready for the next session, in order: ST-F39 (Team Manager activity query
needs `companyId`, `orderBy`, `limit(15)` and a three-field index), PL-F15
(Quick Add's `jobValue: ''` and missing jobType), ST-F10 (three dead legal
fields; paper hard-codes "valid for 30 days"; NBD must stay byte-identical, so
default 30 when unset), PL-F11 (a stage chip closes the Edit modal and
discards typed edits; needs a save-first rule).

## Gotchas learned

- `script-loader.js` is a blocking script at its 85 KB ceiling with about 13
  bytes to spare: register new bundles at runtime from a deferred file
  (`ScriptLoader.bundles.x = [...]`, as `today-home.js` and `home-attention.js`
  do), never by editing the map.
- A test file on disk without a manifest line turns `authed-spec-list` red
  for every suite running at that moment: add the manifest line in the same
  edit as the file.
- The boot-budget gate skips the shipped checks without esbuild; run
  `node scripts/minify-shipped.js --install` first (also in the 11-06 note).
- Playwright resolves from the repo directory (global install under
  `/opt/node22/lib/node_modules`); a harness page for `/pro/js` bundles must
  itself be served under `/pro/`, because bundle paths are relative.

## Ultracode phase (same day, afternoon): what ran, what it cost, what survived

Jo turned ultracode on after the first lanes were pushed, so the rest of the session ran as three
background workflows: a boot-weight understand pass (48 candidate scripts, one reader each, two refuters per
lazy verdict), an open-findings triage (96 findings, one agent each, one refuter per fix-now), and an
implement-and-review pass for the seven P3s from the fresh-code review (one worktree each). They ran two agents
at a time per workflow on a four-core box.

**They hit the account's weekly usage limit after about 50 minutes and 8.2 million subagent tokens.** The
reset was 17:00 UTC. What came back before the limit:

- **All seven P3 fixes were implemented and committed** in their worktrees (two of them also reviewed by an
  independent agent, approve-with-nits; the other five reviewed by hand from the diffs). All seven were
  cherry-picked onto the branch, one commit each; the only conflicts were the shared export line in
  `os/system-logic.js` and a manifest anchor, both kept-both. On the integrated tree: every new and related
  suite green, boot budget 2,742 of 2,748 KB, smoke 4432/0.
- **16 of 48 boot-weight reads**: 8 keep-eager (chibi, my-skin-logic, layout-system, home-attention,
  no-next-step, pipeline-rich-cards, visit-recorder-launcher, production-logic) and 8 lazy-with-work
  (my-skin 50 KB, maps-customers 25 KB, schedule-planner 15 KB, icons 13 KB, ask-joe-actions 12 KB,
  kanban-context-menu 12 KB, onboarding-tour 11 KB, sort-customers 11 KB). No refuter ran, so none of the
  eight is confirmed; each row below carries the reader's plan and evidence for a next session to check by hand.
- **16 of 96 findings triaged**: 7 fix-now (ED-F11, OR-F07, PL-F09, PL-F15, ST-F39, VW-F02, VW-F102; none
  refuted, because no refuter ran), 5 needs-jo (ED-F04, ED-F09, ED-F25, PL-F11, VW-F154), 4 proposal-only
  (ST-F11, ST-F35, ST-F62, VW-F156). Every one is still present on this tree.

**Lesson, for the standing rules:** a fan-out that reads a 7,000-line file per agent is where the budget goes.
On this account, use agents for narrow, high-value checks (an adversarial review of a finished diff, one
reader for one hard question) and do the sweeps with scripts and a single pair of eyes. The understand pass
could have been a 200-line Node script plus one agent per *surviving* candidate.

## Boot-weight reads (16 of 48 before the limit)

| File | KB | Verdict | Bundle / trigger | Key evidence |
|---|---|---|---|---|
| chibi.js | | keep-eager (high) |  / boot: the existing deferred tag at docs/pro/dashboard.html:7387, which must stay ahead of js/game-sp | docs/pro/dashboard.html:7387 `<script defer src="js/chibi.js?v=12">`, :7388 game-sprite.js?v=6, :7389 game-card.js?v=6 — the deliberate order; docs/pro/js/game-sprite.js:210-214 — `if (window.NBDChibi) { ... window.NBDCh |
| my-skin.js | | lazy-with-work (high) | myskin (new, registered at runtime from a ~2 KB deferred kicker: ['js/my-skin-lo / Boot, gated on the boot read: the kicker polls the same ready() condition my-skin.js uses (window._u | docs/pro/js/my-skin.js:33 `if (window.NBDMySkin) return;` and :1695-1717 — the only global is window.NBDMySkin, booted at DOMContentLoaded; grep docs/pro (js+html) for NBDMySkin: outside the my-skin* files the only hits  |
| maps-customers.js | | lazy-with-work (high) | mapcustomers / goTo('map') — register a new runtime bundle `mapcustomers` = ['js/maps-customers.js?v=12'] from maps | docs/pro/dashboard.html:7444-7447 — eager chain: maps-core.js?v=9, maps-overlays.js?v=9, maps-customers.js?v=12, maps.js?v=12 (all defer); :7431-7443 the Step 4d comment says maps-routing.js left this chain for the drawt |
| my-skin-logic.js | | keep-eager (high) |  / boot: dashboard.html:7409-7410 defer pair -> my-skin.js:1717 DOMContentLoaded -> boot() (my-skin.js: | docs/pro/js/my-skin-logic.js:20-881 — pure IIFE; the only load-time effects are module.exports (879) and root.NBDMySkinLogic = api (880) with root = window|self (881).; docs/pro/dashboard.html:7409-7410 — `<script defer  |
| layout-system.js | | keep-eager (high) |  / DOMContentLoaded (already its trigger: the deferred tag at docs/pro/dashboard.html:7411 defines the  | docs/pro/dashboard.html:7411 <script defer src="js/layout-system.js?v=7"> - the 135th of 213 script tags, between my-skin.js (7410) and pixel-mode.js (7412); dashboard.html:19 loads js/shape-preboot.js blocking in <head> |
| home-attention.js | | keep-eager (high) |  / Boot (DOMContentLoaded + 1500 ms, docs/pro/js/home-attention.js:614-615); it is the data source for  | docs/pro/dashboard.html:7381 <script defer src="js/home-attention.js?v=25"> (before today-home.js at 7406 and review-deck.js at 7488); 213 script tags total.; docs/pro/dashboard.html:939 #homeAttention inside <template i |
| no-next-step.js | | keep-eager (high) |  / none — Home, the boot view, reads window.NBDNoNextStep.compute() on its first Today-list paint (toda | docs/pro/dashboard.html:7360 — `<script defer src="js/no-next-step.js?v=3"></script>`, two tags after lead-filter-registry.js (:7355) and needs-attention-filter.js (:7356); comment at :7358-7359 names both the Home card  |
| pipeline-rich-cards.js | | keep-eager (high) |  / boot (deferred tag, unchanged): the first renderLeads/buildCard paint of the Pipeline board reads it | docs/pro/js/pipeline-rich-cards.js:554-578 — the only load-time code: three listeners, one localStorage read, one <html data-rich-style> attribute write, one data-density snapshot; no DOM nodes created at load; docs/pro/ |
| schedule-planner.js | | lazy-with-work (high) | schedule / goTo('schedule') via ScriptLoader.preloadForView('schedule') (dashboard-actions.js:463-465), after r | docs/pro/js/schedule-planner.js:42 sentinel; :353-425 delegated listeners only; :437-449 maybeRender gated on /schedule/ hash + #schedPlanPanel; :451 global assigned; no top-level Firestore or DOM writes; docs/pro/dashbo |
| visit-recorder-launcher.js | | keep-eager (high) |  / boot (deferred tag; init() on DOMContentLoaded, dashboard.html:7589 and customer.html:3262). It is a | docs/pro/js/visit-recorder-launcher.js:2-6 header: 'the ~boot-time half of the visit recorder... Small on purpose: it owns the ENTRY POINTS and nothing heavy. The recorder... are fetched on the first tap, or when the pho |
| production-logic.js | | keep-eager (high) |  / n/a as a solo move (keep-eager). It is only movable as a PAIR with js/production.js in one runtime-r | docs/pro/js/production-logic.js:22-23, 25, 545-547 — IIFE; lazy W(); only load-time effect is window.NBDProductionLogic = api.; docs/pro/dashboard.html:7458-7459 — <script defer src="js/production-logic.js?v=1"> immediat |
| icons.js | | lazy-with-work (high) | none — drop the <script> tag (no reader exists on either page); fallback only if / No trigger exists: nothing in docs/pro (JS, HTML, CSS), functions/, scripts/ or site-src/ calls nbdI | docs/pro/js/icons.js:7-74 — `const NBD_ICONS = { … }` (57 SVG strings); :84-91 — `function nbdIcon(...)`; :93-94 — closing comment, no window.X= line; no other top-level statements. Raw size 14,537 bytes (wc -c); task re |
| ask-joe-actions.js | | lazy-with-work (high) | askjoe / goTo('joe') — the Ask Joe view. Register ScriptLoader.bundles.askjoe = ['js/ask-joe-actions.js?v=2'] | docs/pro/js/ask-joe-actions.js:17-19 — IIFE opens with 'use strict' and `if (typeof window === 'undefined') return;`; no listeners/timers/DOM/Firestore in the body.; docs/pro/js/ask-joe-actions.js:310-317 — sole load-tim |
| onboarding-tour.js | | lazy-with-work (high) | tour / Two triggers, both outside script-loader.js. (1) Boot-time conditional: from dashboard-actions.js (e | docs/pro/js/onboarding-tour.js:478-482 — window.OnboardingTour = { start, stop: complete, forceRestart } is the only global.; docs/pro/js/onboarding-tour.js:442-448 — maybeAutoStart returns immediately when 'nbd-onboardi |
| kanban-context-menu.js | | lazy-with-work (high) | kanbanctx / The existing `nbd:view-entered` event with detail.name === 'crm' (dispatched in goTo after tpl-view- | docs/pro/js/kanban-context-menu.js:34-37 — IIFE + sentinel guard; :561-567 init() registers contextmenu + 4 passive touch listeners on document; :581-599 window.KanbanContextMenu export; :601-605 init runs immediately wh |
| sort-customers.js | | lazy-with-work (high) | sortcustomers / Entering the Pipeline view: the first renderLeads() that runs after the CRM <template> is hydrated ( | docs/pro/dashboard.html:7330 `<script defer src="js/sort-customers.js?v=3"></script>` — the eager tag; neighbours :7328 triage-deck.js, :7329 followup-deck.js, :7331 crm.js; docs/pro/dashboard.html:900 `<div class="view  |

## Findings triage (16 of 96 before the limit)

| Id | Status | Fixability | Files | Proposed fix | Why not now |
|---|---|---|---|---|---|
| ED-F09 | still-present | needs-jo | docs/pro/js/dashboard-widgets.js, docs/pro/js/estimates.js, tests/estimates-render-guard-2026-11-07.test.js, tests/smoke | If Jo picks read-only-now (the smaller fix, no money change): in dashboard-widgets.js viewEstimate (line 482), after the logged-estimate guard (~:500) and before 'Show builder, hide list', add a branch for non-V2 docs: when window.EstimatePreview exists, open  | Both candidate fixes need Jo. (A) Routing classic through EstimateBuilderV2.calculatePerSq is MONEY: it changes NBD's own classic reopen totals, not just tenant |
| ED-F04 | still-present | needs-jo | docs/pro/js/estimate-logic-engine.js, tests/estimate-qty-fallthrough-2026-11-08.test.js, tests/ci-manifest.json, tests/e | Per-code entries only, in QTY_BY_CODE (estimate-logic-engine.js:675-792), never a new QTY_BY_SUB / category rule: the gutter-source fixture at tests/estimate-gutter-source.test.js:~392-410 pins a synthetic 'accessories'/'gutters' EA item at 120 via the categor | MONEY: every candidate change alters a line quantity and so the customer total (GTR EC 120 -> ~2, INT DW-L 2340 SF -> manual, RFG BRD 234 LF -> manual, LAB VLY- |
| ED-F11 | still-present | fix-now | functions/portal.js, docs/pro/js/estimate-view.js, docs/pro/estimate-view.html, tests/tenant-branding-by-company-2026-10 | Server (functions/portal.js:2821): decide NBD by the tenant key, not the brand name, before the profile lookup — the same rule as portalView's `_portalIsNbd` (745-746). Replace the NBD-seeded `let company` with: `const _evTenantKey = (tokLead && tokLead.compan | n/a — fix-now. Tier C only nominally: the Cloud Functions edit is ~4 lines using symbols already in scope (`PORTAL_NBD_OWNER_UID` portal.js:107, `tokLead` porta |
| ED-F25 | still-present | needs-jo | firestore.rules, docs/pro/js/estimate-supplement.js, docs/pro/js/invoice-pipeline.js, tests/firestore-rules.test.js, tes | If Jo wants company staff to see team supplements (the same visibility /estimates :1305-1308 and /invoices :3698-3702 already grant): (1) firestore.rules /supplements read becomes `isOwner(resource.data.userId) // isAdmin() // (isCompanyReader() && resource.da | The only live bug left in this record is the supplement scope, and it cannot be fixed client-side: the /supplements read rule is `isOwner(resource.data.userId)  |
| OR-F07 | still-present | fix-now | docs/pro/js/estimate-logic-engine.js, tests/estimate-pricing-paths-2026-10-05.test.js | Replace the single comment line at docs/pro/js/estimate-logic-engine.js:737 ("// Tear-off labor lines (scale by layers)") with a comment that states the real contract, e.g.: "// Tear-off labor: QTY is sq for every code. The LAYER COUNT is priced by WHICH code  | fix-now applies ONLY to the Tier A comment half (one line, zero runtime change). The behaviour half — what the Layers select should do on the line-item path (wa |
| PL-F09 | still-present | fix-now | docs/pro/js/dashboard-bootstrap.module.js, tests/optimistic-edit-keeps-owner-2026-11-08.test.js, tests/ci-manifest.json | In `_optimisticInsertLead` (docs/pro/js/dashboard-bootstrap.module.js:3702), build `merged` on top of the cached lead when this is an edit. Replace :3717-3726 with: `const _prev = idx >= 0 ? window._leads[idx] : null; const merged = { ..._prev, id: leadId, ... | n/a (fix-now). No money, no copy, no product decision: the code's own stated intent (comment at dashboard-bootstrap.module.js:4100-4102, "reflect the edit on th |
| PL-F15 | still-present | fix-now | docs/pro/dashboard.html, docs/pro/js/tools.js, tests/quick-add-lead-shape-2026-11-08.test.js, tests/ci-manifest.json | (1) dashboard.html: inside #quickAddModal (between the Damage Type and Source blocks, docs/pro/dashboard.html:5620-5648) add a `<select class="ui-input" id="qaJobType">` with exactly the #lJobType option list from dashboard.html:5818-5825 (`""` "Pick a type…", | n/a (fix-now). One assumption to write into the PR body: the new Job Type pick on Quick Add is OPTIONAL (pre-filled from the board the rep is on, blank otherwis |
| PL-F11 | still-present | needs-jo | docs/pro/js/dashboard-bootstrap.module.js, docs/pro/js/crm-leads.js, tests/lead-chip-keeps-edits-2026-11-08.test.js, tes | Recommended (route b, ask only when really dirty). 1) crm-leads.js: in openLeadModal (crm-leads.js:82-96), when isEdit, snapshot the trimmed values of _LEAD_TYPED_FIELDS plus the selects editLead fills (lStage, lJobType, lSubType, lSource, lDamageType, lClaimS | A product decision, not a failure: the finding's own fix is "save first (or ask)" and the two routes behave differently for a rep. (a) Save-then-move silently c |
| ST-F35 | still-present | proposal-only | docs/pro/dashboard.html, docs/pro/js/dashboard-bootstrap.module.js, docs/pro/js/claude-proxy.js, functions/handlers/ai.j | Two tiers for Jo to pick from. Tier A (copy only, one line, one test): replace dashboard.html:4880 with a true sentence, e.g. "AI runs on NBD Pro's own key and counts against your plan's monthly AI-call allowance; the tiles below are this browser's tally since | Three reasons. (1) Decision already taken: overnight/crm/DECISIONS.md:70 (D-009) and the task rules list ST-F35 as proposal-only; documentation/audit/CRM-POWER- |
| ST-F11 | still-present | proposal-only | docs/pro/js/dashboard-bootstrap.module.js, docs/pro/js/company-profile.js, docs/pro/dashboard.html, tests/brand-contact- | Smallest complete fix (client-only, two files plus the UI control D-009 asked for). (1) docs/pro/js/dashboard-bootstrap.module.js `_cpReadFormToProfile`, after the FIX 2 block (6250-6307): read `const prior = ((typeof window._brandOverride === 'function' && wi | Decision already taken: overnight/crm/DECISIONS.md D-009 lists ST-F11 as proposal-only because making blanks clear writes deletes into companyProfile (a data-sh |
| ST-F39 | still-present | fix-now | docs/pro/js/admin-manager.js, tests/settings-3-2026-11-06.test.js | In showActivity (docs/pro/js/admin-manager.js:260-263) replace the single-filter query with a scoped one: `const claims = window._userClaims // {}; const self = !!(window._user && window._user.uid === uid); const filters = [window.where('userId', '==', uid)];  | Fix-now applies to the companyId scoping half (no money, no copy, no deploy, admin-manager.js is not a held file). The orderBy/limit(15) half named in the sugge |
| ST-F62 | still-present | proposal-only | docs/pro/js/pages/register.js, tests/google-signin-popup.test.js | Two halves, both in docs/pro/js/pages/register.js only. Half A (same-session resume, ~8 lines): in the free path replace :231 with the :279-281 shape — `let cred; if (auth.currentUser && auth.currentUser.email === email) { cred = { user: auth.currentUser }; }  | D-009 (overnight/crm/DECISIONS.md:68) records ST-F62 as an auth-flow change (Tier C), proposal only, and the task rules say to respect it. The complete fix per  |
| VW-F02 | still-present | fix-now | docs/pro/js/prospects.js, tests/small-misc-2026-11-06.test.js, documentation/audit/CRM-SMALL-MISC-2026-11-06.md | In docs/pro/js/prospects.js replace isFollowUpDue (lines 148-151) with a local-day rule mirroring the pipeline card chip (crm-pipeline.js:1019) and followup-deck.js:27-33: add `function followUpDaysLate(lead)` that returns null for a blank/invalid followUp, el | fix-now covers two of the finding's three parts: (1) the due rule (strictly-after-day vs the repo's stated ONE rule 'today or earlier', today-plan.js:39-45 / cr |
| VW-F102 | still-present | fix-now | functions/portal.js, docs/pro/js/estimate-view.js, docs/pro/estimate-view.html, tests/tenant-branding-by-company-2026-10 | Server (functions/portal.js:2821-2846, inside exports.getEstimateForView): after `const tenantKey = (leadSnap.exists && ...companyId) // tok.ownerUid;` (line 2824) compute `const isNbd = !tenantKey // String(tenantKey) === PORTAL_NBD_OWNER_UID;` (the exact rul | n/a (fix-now). Tier C caveat answered: the server edit is ~4 lines inside getEstimateForView's tenant-resolve block, self-contained, no new index/rule/App Check |
| VW-F156 | still-present | proposal-only | docs/pro/js/dashboard-sw-bootstrap.js, tests/sw-update-deferral-<date>.test.js, tests/dashboard-boot-budget-2026-10-03.t | Smallest complete shape, sw.js untouched (keeps every sw.js pin intact): in docs/pro/js/dashboard-sw-bootstrap.js route both reload triggers (line 44, the 500 ms reload on SW_UPDATE_AVAILABLE; line 57, the 0 ms reload on controllerchange) through one single-sh | Three independent reasons, any one of which is enough. (1) Decision already taken: overnight/crm/DECISIONS.md:69 (D-009) files VW-F156 as "service-worker update |
| VW-F154 | still-present | needs-jo | docs/pro/js/email_system.js, tests/stage-email-claim-wording-2026-11-08.test.js, docs/pro/customer.html:2913, documentat | For Jo/attorney to approve the words; the sanctioned vocabulary already exists in the repo (claim-wording-filter.js comment: "I document the damage and write the estimate; you file, and I can meet the adjuster"; tests/claim-wording.test.js:240 and :252 positiv | Three reasons, none of them a failure. (1) The fix is new copy on customer paper: a homeowner-facing email body, and the finding itself says the rewording needs |


## Second Opus batch (after the 17:00 UTC reset)

The five confirmed fix-now findings from the triage table above were implemented on Opus agents (one worktree each,
one Opus reviewer each): 1.3 M tokens and 13 minutes for ten agents, against 2.0 M for the seven-item Fable batch.
All five approved (one approve, four approve-with-nits, no blocking issues) and cherry-picked. The two Opus-authored
commits that carry an Opus co-author trailer are named truthfully. ST-F39 took the smallest query the rules accept
(companyId + userId equality, no orderBy, so no new index); the orderBy + limit version with a three-field index is
the follow-up the triage described. OR-F07 is deferred until #2941 lands.

## Third Opus round (evening): 25 P3 fixes, seven boot moves, one loader bug

**Batch 5, the P3 fixes.** The triage's fix-now P3s ran as eleven file-groups (one worktree and one Opus reviewer
each, 21 agents, 3.6 M tokens). All 23 commits were approved, closing 25 finding ids:
ST-F49, DT-F12, VW-F05, VW-F06, PL-F21, ST-F40, ST-F46, ST-F48, CU-F13, CU-F14, CU-F20, ST-F28, DT-F04, ST-F14, ST-F31,
ST-F27, ST-F34, ST-F32, ST-F64, ST-F71, ST-F70, ST-F68, ST-F72, VW-F13 and ED-F08. ST-F44 and ST-F30 were done by hand
afterwards (their files were in batch 3). ST-F18 was already fixed by #2946, ST-F58 by #2984 and VW-F55 by #2978.
One integrator change: PL-F21's bulk "Move to stage" list offered every visible stage (33 for NBD, up from 9). It now
offers the current board's columns, the stages the selected cards actually sit on.

**Batch 3, the dashboard boot moves.** Seven eager scripts left the boot path, each registered as a ScriptLoader bundle
at runtime from a deferred file, with its own trigger:

| Script | Loads when |
|---|---|
| my-skin-logic.js + my-skin.js (also customer.html) | the device painted a skin last time, the account or company has one, or Settings opens |
| maps-customers.js | the 'map' view opens. That view is retired (goTo renames it to d2d), so in practice it never loads: dead weight, deleting it is Jo's call |
| schedule-planner.js | the first Schedule visit |
| ask-joe-actions.js | the Ask Joe view; a send or a saved transcript waits for it |
| onboarding-tour.js | first run, how-to's Restart Tour, or Start Tour |
| kanban-context-menu.js | entering the Pipeline, or the first card ⋮ / chip tap (a load-then-run stand-in) |
| sort-customers.js | the first Pipeline render that finds its banner mount |

TM-ACTIVITY-PAGED (the ST-F39 follow-up) also landed: Team Manager's activity pane reads `orderBy('createdAt','desc')`
plus `limit(15)`, with a new leads index (companyId, userId, createdAt desc) and a one-time unbounded fallback while
that index builds. Leads with no `createdAt` no longer show on the ordered path; every current writer stamps one.

**The loader bug the reviews found.** ScriptLoader left a failed `<script>` in `<head>`. The next load found it in its
eager-tag scan and marked the file loaded without fetching, so one dropped request turned a lazy feature off until a
reload, for every bundle (estimates, photos, docgen, and the seven moves above). Two Opus reviewers reproduced it in
Chromium. The batch's tests had pinned a retry that never happened, because their fake `<head>` listed no tags. The fix
is one line in `onerror` (`el.remove?.()`), paid for by a three-byte shorter warning: shipped blocking bytes went
87,027 → 87,038 of 87,040, and ST-F30's demo-mode change brought them back to 87,019. The Ask Joe, Plan Jobs and kanban
suites now use a `<head>` that keeps and lists its tags, as a browser does. Their retry checks are red on the old
loader.

**Lesson for the next lazy move.** A fake DOM whose `querySelectorAll('script[src]')` returns `[]` cannot see what
ScriptLoader sees. Use one that lists what was appended (tests/script-loader-retry-after-failure-2026-11-08.test.js).

| Boot measure (dashboard.html) | Morning | After batch 3 |
|---|---|---|
| Local script tags | 215 | 200 |
| Shipped local bytes | 2,858 KB | 2,563 KB |
| Shipped blocking bytes | 87,027 B | 87,019 B |
