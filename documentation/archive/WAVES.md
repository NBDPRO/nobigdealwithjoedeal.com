# NBD Pro — First 30 Waves

A wave is a single small, ship-shaped improvement: one PR, one merge,
one thing the rep notices the next time they log in. The first 30
waves landed across roughly two days of focused work in early May
2026. This file groups them by what they affected so you can scan
the work without reading 30 separate PR descriptions.

---

## iOS / PWA reliability

The biggest source of "the app is broken" reports in the field was
iOS Safari quirks — the SW update story didn't actually deliver new
code, the customer detail page silently hung, and PWA installs were
undiscoverable. These waves close those loops.

| Wave | What | PR |
|---|---|---|
| **(bundled in PR #137)** | Made the "Update available — tap to refresh" toast actually tappable; rewrote the SW reload guard to use a per-page-load in-memory flag (was a sessionStorage flag keyed by an SW version string that rarely changed, so reps got pinned to old code forever after one reload); added 8s slow-load watchdog overlay on customer.html so iOS Safari connection hangs surface a "Refresh now" button instead of a blank screen | [#137](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/137) |
| **11** | Customer detail handoff — dashboard stashes the lead in sessionStorage on click, customer.html renders instantly from it, skipping the cold Firestore round-trip that hung on iOS | [#138](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/138) |
| **14** | Background revalidate after Wave 11 handoff — fires 1.5s after instant paint, swaps in fresh data + shows a "↻ Refreshed" pill if the server doc is newer; silent noop if the network's flaky | [#141](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/141) |
| **20** | PWA install nudge — bottom banner from session 3 onward with platform-aware action ("How?" with Share-button walkthrough on iOS, native install dialog on Android Chrome with `beforeinstallprompt`, fallback instructions otherwise), snooze + dismiss controls | [#147](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/147) |

---

## Multi-tenant security

A focused security audit found two real cross-tenant gaps in the
email Cloud Functions.

| Wave | What | PR |
|---|---|---|
| **9** | `sendEstimateEmail` was a cross-tenant relay (any authed user could supply any leadId and email that customer with NBD-branded templates) — now requires owner-or-same-company-manager. `sendTeamInviteEmail` had no role check, no `companyId` stamp, and allowed role escalation (a rep could mint admin invites) — now requires admin/manager/owner with companyId stamping + escalation guard | [#137](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/137) |

---

## Photo & AI

| Wave | What | PR |
|---|---|---|
| **10** | AI roof damage analysis MVP — new `analyzeRoofPhoto` Cloud Function (Claude Sonnet vision, server-owned system prompt, structured JSON output, ownership check, SSRF guard, 100/day per-uid cap), client `photo-ai.js` with severity-coded analysis card injected in the photo lightbox | [#137](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/137) |
| **12** | Bulk AI photo analysis — "Analyze All with AI" button in the gallery toolbar with live progress + severity summary banner; AI assessments now render as captions in inspection report PDFs | [#139](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/139) |
| **30** | Drag-drop file upload on customer detail page — drop photos/PDFs anywhere on the page, images go through `PhotoEngine.uploadFromFile` and docs go to the signed-document path; multi-file with per-file toast + summary | [#157](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/157) |

---

## Dashboard home — the "command center"

The dashboard home went from passive stat cards to a live command
center that answers four questions at a glance.

| Question | Surface | Wave |
|---|---|---|
| Where do I start? | 🔥 Hot Leads | **29** |
| Where am I stuck? | Pipeline Bottlenecks | **19** |
| What needs follow-up? | Needs Attention filter | **25** |
| What just happened? | Notification bell + Activity feed | **13**, **24** |

| Wave | What | PR |
|---|---|---|
| **13** | Notification bell — wired the dead-UI dropdown that had been shipped unfunctional; aggregates overdue tasks + tasks due today + stale estimates + cold leads from already-loaded caches; severity-sorted, dismissible, per-item read state in localStorage | [#140](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/140) |
| **19** | Pipeline Bottleneck widget — per-stage avg/median/max days-in-stage with the slowest 1-2 stages flagged red as bottlenecks; click row to jump into kanban filtered to that stage | [#146](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/146) |
| **24** | Recent Activity timeline — last 20 events from leads/estimates/tasks (created, stage moved, sent, viewed, signed, completed); click row navigates via Wave 11 handoff | [#151](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/151) |
| **29** | Hot Leads widget — top 5 highest-scoring leads in prospecting stages that haven't been touched in 3 days, click to open instantly via handoff | [#156](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/156) |

---

## Kanban UX

| Wave | What | PR |
|---|---|---|
| **17** | Kanban stage-aging cues — yellow/orange/red left border on cards based on `stageStartedAt`; 14+ days gets a 4px border with 2.4s pulse; pill badge "Nd in stage" on each card | [#144](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/144) |
| **22** | Keyboard shortcuts cheat sheet — wired the unwired `#shortcutsPanel` (`?` toggles); also wired the missing keybindings the panel was advertising: C/N (new lead), E (new estimate), 1-7 (scroll to kanban column with orange flash) | [#149](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/149) |
| **25** | Needs Attention filter — single header button with red count badge that filters the kanban to leads with stale-stage / overdue task / stale estimate; composes Waves 13/17/19 into one click | [#152](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/152) |
| **26** | Right-click + long-press context menu — eight actions (View / Edit / Add task / Call / Copy phone / Copy address / Maps / Delete), viewport-clamped, dismissible four ways; light haptic on long-press for mobile | [#153](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/153) |

---

## Search + data ergonomics

| Wave | What | PR |
|---|---|---|
| **15** | Lead deduplication on create — modal with confidence-tagged matches before save, "open existing" / "create anyway" / "cancel"; `duplicateOf` audit stamping on the proceeding doc | [#142](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/142) |
| **18** | Cmd+K / "/" global search — searches leads (name/address/phone/customerId/email) + estimates (number/lead/total) with substring highlighting, keyboard nav, instant render via Wave 11 handoff | [#145](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/145) |
| **21** | CSV export for leads + estimates from Settings — RFC-4180 quoting, Excel-safe BOM, ISO timestamps, honors Show Prospects toggle | [#148](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/148) |
| **23** | CSV lead import — three-step modal (drop / mapping with smart aliases / progress), RFC-4180 parser, per-row dedup via Wave 15, server-stamped userId+companyId+stageStartedAt | [#150](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/150) |

---

## Scheduled emails

Two cadences now run dry-run behind env vars (`WEEKLY_DIGEST_ENABLED`,
`DORMANT_NUDGE_ENABLED`); flip on the Cloud Run revision after one
or two cycles of observation.

| Wave | What | PR |
|---|---|---|
| **6** | Stripe webhook auto-advances kanban stage to `final_payment` when an invoice is paid — protects already-final stages, stamps `autoAdvancedFromInvoiceId` for audit | [#135](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/135) |
| **16** | Weekly digest cron — Monday 7am ET. New leads + won deals + revenue + active pipeline + top 5 new leads per rep. Skips zero-activity users | [#143](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/143) |
| **27** | Dormant-lead Wednesday cron — finds leads stuck >30 days at non-terminal stages, emails the rep a focused list with click-through links; 8am ET to give two business days to act before the weekend | [#154](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/154) |
| **28** | Settings UI opt-out for the dormant nudge (mirrors the Wave 16 weekly digest toggle) — separate fields because the two emails serve different intents | [#155](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/155) |

---

## Customer-facing polish

| Wave | What | PR |
|---|---|---|
| **7** | Homeowner portal project progress timeline — five friendly milestones (Inspection / Estimate / Contract / Installation / Complete) mapped from 28 internal stage keys; visual track with checkmarks + "Next up" callout | [#136](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/136) |
| **8** | Mobile responsive fixes — ROI table column-prune at <600px, card detail info-grid stacks at <540px | [#137](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/137) |

---

## Onboarding + earlier waves

These shipped before the formal wave numbering kicked in (Waves 1-5)
across PRs #133, #134, but they're part of the same push.

| Wave | What | PRs |
|---|---|---|
| **1, 2, 3** | Theme persistence (unlock state synced to Firestore + localStorage), photo-editor unsaved-annotation confirmation, Lead Source ROI panel, Pipeline Forecast panel | [#133](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/133) |
| **4, 5** | 5-step DOM-based onboarding tour (Welcome → Pipeline → Add Lead → D2D → Settings), empty-state CTAs across views | [#134](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/134) |

---

## Architecture notes

A few patterns that recur:

- **Dead-UI wiring** — the v5 dashboard refactor left several modals
  (cmd palette, notification bell, shortcuts panel) sitting in the
  HTML with `onclick` handlers that referenced functions that
  didn't exist. Waves 13, 18, 22, 28 wired each one up. New work
  should never ship UI without checking that its handlers exist.

- **In-memory cache as source of truth** — `window._leads`,
  `window._estimates`, `window._taskCache`, `window._photoCache`
  are loaded once by the dashboard's loaders and reused by
  every widget. Widgets re-render on a custom `nbd:data-refreshed`
  event that the loaders emit, plus a 60s/5min interval as backstop.
  Avoids per-widget Firestore reads.

- **Per-page-load reload guards over sessionStorage version flags**
  — sessionStorage tied to a slowly-changing version string is a
  trap (Wave reload bug). Use in-memory `let _flag = false` for
  "once per page load" semantics.

- **Default-ON opt-outs** — opt-out flags use `=== false` checks
  (e.g. `weeklyDigestEnabled !== false`) so users without the
  field set get the feature; only an explicit `false` skips.
  Settings UIs prime checkboxes with this same semantic.

- **Cron functions ship DRY-RUN** — `WEEKLY_DIGEST_ENABLED` /
  `DORMANT_NUDGE_ENABLED` env vars gate live sends. Logs eligible
  recipients in dry-run mode so we can observe a cycle before
  flipping on. Same shape for both the Wave 16 and Wave 27 crons.

- **Wave 11 handoff** is reused by Waves 18, 24, 29 — anywhere a
  rep clicks a lead, they get the customer page rendered
  instantly from sessionStorage + a background revalidate for
  fresh data.

---

# Second push — Waves 31-50

The first 30 waves built the foundation: the dashboard home command
center, multi-tenant security, AI photo analysis, scheduled emails,
kanban UX, search and ergonomics. The second 20 went deeper — three
focused initiatives plus a handful of daily-friction polish ships.

The big arcs:

1. **The share trio** (W40-W43) — Copy / Text / Email portal link
   helpers, all built on a shared `PortalLinkHelpers` module.
2. **The snooze system** (W35-W37, W39) — defer leads to a date,
   filter everywhere, bulk-snooze via toolbar, snooze-aware feed.
3. **The "see + act" pattern** (W46-W49) — inline reshare buttons
   on every priority surface so the rep can glance + tap from the
   four dashboard-home widgets without ever leaving the page.

---

## The share trio (Copy / Text / Email portal link)

| Wave | What | PR |
|---|---|---|
| **40** | One-click copy portal link from customer detail. Three-tier clipboard fallback (modern API → execCommand → share-panel fallback) so reps never hit a dead end | [#167](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/167) |
| **41** | One-tap SMS portal link — `sms:<phone>?body=...` with friendly prefilled greeting | [#168](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/168) |
| **42** | Extracted `PortalLinkHelpers` shared module + added Copy/Text items to the kanban context menu | [#169](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/169) |
| **43** | Email portal link variant — `mailto:` with subject + multi-line body. Completes the trio | [#170](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/170) |
| **44** | Tracks `lastSharedAt` + `lastSharedVia` on every share. Kanban cards show "📤 SMS 3d ago" pill | [#171](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/171) |

---

## The snooze system

| Wave | What | PR |
|---|---|---|
| **35** | Snooze a lead to a future date (preset modal: tomorrow / next Monday / 1w / 2w / 1mo + custom). Filter integration across kanban, Hot Leads, Needs Attention, bell. Per-page reload guard via `nbd_crm_show_snoozed` localStorage flag | [#162](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/162) |
| **36** | Snoozed-lead banner on customer detail with one-tap wake/reschedule | [#163](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/163) |
| **37** | Bulk-snooze via the existing bulk action toolbar — chunked writeBatch | [#164](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/164) |
| **39** | Snooze-aware activity feed — suppresses rep-side events on snoozed leads, keeps customer-side ones (estimate viewed, signed) | [#166](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/166) |

---

## "See + act" pattern — inline reshare buttons

After Wave 45 introduced Almost There as the fourth dashboard-home
priority widget, the next four waves locked in the inline-action
pattern across every priority surface. Same color palette, same
`stopPropagation` handling, same `PortalLinkHelpers` delegation —
the rep doesn't have to learn three different patterns.

| Wave | Surface | PR |
|---|---|---|
| **45** | New "Almost There" widget — viewed-but-uncommitted leads (W44 lastSharedAt + estimate.viewedAt without respondedAt) | [#172](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/172) |
| **46** | Inline 📞/💬/📧 buttons on Almost There rows | [#173](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/173) |
| **47** | Same buttons on Hot Leads (W29) | [#174](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/174) |
| **48** | Same buttons on bell rows (W13) | [#175](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/175) |
| **49** | Same buttons on activity-feed rows (W24) | [#176](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/176) |

The dashboard home now answers four questions, each with one-tap
follow-up:

| Question | Surface | Action |
|---|---|---|
| Where do I start? | Hot Leads | 📞 💬 📧 |
| Who almost said yes? | Almost There | 📞 💬 📧 |
| What's urgent? | Bell | 📞 💬 📧 |
| What just happened? | Activity feed | 📞 💬 📧 |

---

## Polish + cross-device

| Wave | What | PR |
|---|---|---|
| **31** | First milestone changelog (this file's first 30-wave bookend) | [#158](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/158) |
| **32** | Bulk-edit lead source + jobType via existing toolbar — common post-import cleanup ops | [#159](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/159) |
| **33** | Lead notes inline quick-add — replaces the modal flow with a textarea + Send button on customer detail. Optimistic prepend, Cmd/Ctrl+Enter shortcut | [#160](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/160) |
| **34** | Mobile quick-action bar on customer detail (≤640px) — sticky bottom Call/Text/Email/Task with iOS safe-area handling | [#161](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/161) |
| **38** | Cross-device prefs sync — kanban view, Show Prospects, Show Snoozed mirror to `users/{uid}.uiPrefs`. 10s polling diff, debounced writes, conflict resolution favors local | [#165](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/165) |

---

## Architecture notes for the second push

A few patterns that recurred:

- **Shared helper modules over duplication** — `PortalLinkHelpers`
  (W42) is the cleanest example. Three customer-detail buttons
  (W40/W41/W43), four dashboard-widget action sets (W46/W47/W48/W49),
  and the kanban context-menu items (W42) all delegate to the same
  `resolveUrl` / `copyForLead` / `smsForLead` / `emailForLead`
  surface. Single source of truth for clipboard fallbacks, SMS
  body template, mailto: encoding, and the W44 share-tracking
  side effect.

- **`stopPropagation` discipline on inline action buttons** — every
  dashboard-home row has a primary click (open the lead/customer)
  and one or more secondary actions (call/text/email). Without
  `stopPropagation`, a button click would fire BOTH the action AND
  the row navigation. The four widgets all follow the same
  pattern: `addEventListener('click', (ev) => { ev.stopPropagation();
  ... })` for SMS/Email; native `<a href="tel:...">` for Call so
  the browser's tel: handoff is the default.

- **Filter-on-read for snooze** (W35) — no cron, no scheduler.
  `snoozedUntil < now` means every filter (Hot Leads, Almost
  There, Needs Attention, bell, kanban, activity feed) just passes
  the lead through. Auto-unsnooze is implicit; the only writes are
  the user-initiated snooze/unsnooze actions.

- **Default-ON opt-outs continue** — W28's `dormantNudgeEnabled`
  check pattern (`=== false` to skip) extended to W38's
  `uiPrefs` reads where missing fields fall through to local
  defaults, not zeros.

- **Per-page-load reload guards over sessionStorage version flags**
  — pattern from the first push held up. Show-snoozed toggle (W35),
  prefs-sync (W38), and the snooze banner (W36) all use in-memory
  flags or live data instead of versioned sessionStorage.

- **Path-gated modules** — customer-page-only behaviors
  (snooze banner W36, mobile quick-action bar W34, drag-drop
  upload W30) check `window.location.pathname` and bail out
  silently on unrelated pages. Lets the same script tags ship
  everywhere without affecting non-customer surfaces.

- **W44 share tracking is a side effect** — not a separate API.
  Every share path through `PortalLinkHelpers` calls `_recordShare`
  on success, which patches `window._leads` + `window._currentLead`
  in memory and fires a fire-and-forget Firestore `updateDoc`. No
  caller has to remember to track; it just happens.

---

# Third push — Waves 51-60

The first 30 waves built the foundation. The second 20 went deeper
through three arcs (share trio, snooze system, see-+-act pattern).
The third 10 finished what the second push started + opened a new
front on customer engagement signals.

The big arcs:

1. **Share-trio universality completion** (W51, W53) — every
   priority-ish surface in the app now offers inline 📞/💬/📧.
2. **Recovery sibling for Almost There** (W54, W55) — Stale
   Shares as both a kanban filter and a dashboard widget,
   covering the no-engagement-yet recovery posture.
3. **Engagement signal pattern** (W56-W59) — portal preview
   iframe, fresh-share + fresh-view pulses, viewed-chip mirroring
   on both kanban + customer page.

---

## Share-trio universality completion

After Waves 46-49 introduced inline reshare buttons on the four
dashboard-home priority surfaces (Hot Leads, Almost There, Bell,
Activity feed), two more priority-ish surfaces remained without
the share trio. This push closed both gaps. The 📞/💬/📧
vocabulary is now everywhere a rep encounters a lead in the app.

| Wave | Surface | PR |
|---|---|---|
| **51** | Cmd+K search results — fifth and final priority surface | [#178](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/178) |
| **53** | Recent-customers dropdown (header 🕒 button) — last priority-ish surface | [#180](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/180) |

The full surface map after W53:

| Surface | Wave introduced |
|---|---|
| Customer detail buttons | W40, W41, W43 |
| Kanban context menu | W42, W43, W56 |
| Hot Leads widget | W47 |
| Almost There widget | W46 |
| Notification bell | W48 |
| Activity feed | W49 |
| Cmd+K search | W51 |
| Recent dropdown | W53 |
| Stale Shares widget | W55 |

---

## Recovery sibling for Almost There

The dashboard home now has matching recovery widgets covering
both ends of the customer-engagement spectrum:

| Surface | Wave | Signal | Posture |
|---|---|---|---|
| Almost There | W45 | Customer VIEWED, didn't respond | Close-call |
| **Stale Shares** | **W54-W55** | Customer SENT 5+ days ago, never responded | Re-nudge |

Same `compute()` logic backs both the kanban filter and the home
widget so they stay in lockstep on match criteria.

| Wave | What | PR |
|---|---|---|
| **54** | Stale Shares kanban filter button — header toggle with count badge, mirrors W25 Needs Attention pattern | [#181](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/181) |
| **55** | Stale Shares dashboard widget — mirrors W45 Almost There shape, top 5 oldest stale shares with inline reshare buttons | [#182](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/182) |

---

## Engagement signal pattern

The W44 share badge says "I sent it." This push added the
matching customer-side signal — "they OPENED it" — across both
kanban + customer page, plus a 4th shape to PortalLinkHelpers
(preview) and pulse animations for fresh activity in the last
24 hours.

| Wave | What | PR |
|---|---|---|
| **56** | Portal preview iframe modal — 4th `PortalLinkHelpers` shape (copy / sms / email / preview), surfaceable from customer page + kanban context menu | [#183](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/183) |
| **57** | Kanban fresh-share pulse animation — purple `box-shadow` halo on share badges <24h old, respects `prefers-reduced-motion` | [#184](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/184) |
| **58** | Kanban "👁 viewed today" indicator — green pill on cards when any non-responded estimate has `viewedAt`, with matching fresh-view pulse | [#185](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/185) |
| **59** | Viewed chip on customer detail header — mirrors W58 → customer page, completes the visual symmetry W52 set up for shares | [#186](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/186) |

Visual symmetry across both surfaces:

| Signal | Kanban card | Customer header |
|---|---|---|
| Share | W44 (purple) | W52 (purple) |
| View | W58 (green) | W59 (green) |

The kanban now tells a complete activity story per lead at a
glance:

| Combo | Meaning |
|---|---|
| No badges | Stagnant |
| 📤 share only | Waiting on customer |
| 📤 + 👁 | Engaged, closeable |
| 📤 old + 👁 fresh | Customer came back |

---

## Architecture notes for the third push

- **Mirroring as a feature design pattern** — kanban surfaces and
  customer-detail surfaces should show the same signals with the
  same colors and the same time bucketing. W52 + W59 are the
  customer-detail counterparts to W44 + W58. Reps switching
  between surfaces never see different shapes for the same data.

- **Same `compute()` powering multiple surfaces** — W54 + W55
  share `StaleShares.compute()` so the kanban filter and the
  dashboard widget can never drift on match criteria. Future
  recovery filters should follow this pattern rather than
  re-implementing the predicate per surface.

- **Pulse animations as fading signals, pills as lasting records**
  — W57 + W58 introduced 24h pulse animations. The pulse decays
  on its own as time passes; the underlying pill persists. Pulses
  surface fresh activity passively without requiring the rep to
  scan timestamps.

- **`prefers-reduced-motion` respected on every animation** —
  every pulse keyframe in the W57/W58 batch has a corresponding
  `@media (prefers-reduced-motion: reduce) { animation: none }`
  override. Animation is signal but never essential.

- **Iframe preview at phone-width (500px max-width)** — W56's
  modal is intentionally narrow. Most homeowners view the portal
  on mobile, so the preview should match the actual customer
  view. Reps catch missing photos / wrong status more reliably
  in the same proportions the customer sees them.

- **Dashboard-home visual rhythm holds** — six dashboard-home
  panels (Hot Leads, Almost There, Stale Shares, Bottlenecks,
  Activity feed, Today's Tasks) each follow the same 3-column
  row pattern + same panel header style. Adding new widgets
  (W55) doesn't break the visual cadence.

- **All four `PortalLinkHelpers` shapes share `resolveUrl`** —
  copy / sms / email / preview each call the same Firestore-
  first / generate-on-demand resolution path. A change to URL
  resolution semantics propagates to all four with no separate
  patches per shape.

---

# Fourth push — Waves 61-70

The third push shipped the W56 portal preview iframe + W35 lead
snooze, but only on a couple of surfaces each. The fourth push
made both **universal**: every list-of-leads or alert surface in
the rep workflow now exposes the same five-button action row.

The big arcs:

1. **Direct actions in cmd+K + recent dropdown** (W61-W63, W67)
   — power-user keyboard surfaces get inline snooze + preview so
   a rep can search, peek, snooze, or send a portal link in two
   keystrokes without ever leaving the palette.
2. **Home widget trifecta** (W64-W66) — Hot Leads, Almost There,
   and Stale Shares all reach feature parity with cmd+K. The
   home dashboard reads as one consistent triage surface.
3. **Alert surfaces** (W68-W69) — Notification Bell + Activity
   Feed gain 🔍 + state-aware 💤/⏰. The rep can preview before
   responding to a customer-side event and snooze rep-side
   noise without leaving the alert list.

The unifying outcome: **9 surfaces × 5 buttons** in the same
order with the same colors and the same modal behaviors.

---

## Universal action row

After Waves 46-49 + 51 + 53 made the share trio (📞 💬 📧)
universal, the third push (W56) added portal preview but only
on customer.html + kanban context menu. The W35 snooze system
similarly covered only the kanban context menu + customer
detail page. Wave 61-69 finished both at once.

The rule: **every place a rep encounters a lead, the action row
reads `📞 💬 📧 🔍 💤/⏰`.** Same colors, same positions, same
modal stacking. Muscle memory transfers across all 9 surfaces.

| Wave | Surface | What landed | PR |
|---|---|---|---|
| **61** | Cmd+K palette | State-aware 💤/⏰ snooze button | [#188](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/188) |
| **62** | Recent-customers dropdown | Mirrors W61 — same snooze button | [#189](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/189) |
| **63** | Cmd+K palette | 🔍 preview button — chain previews while keeping search context | [#190](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/190) |
| **64** | Hot Leads widget | 🔍 + 💤 added to W47 share trio — first home widget at parity | [#191](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/191) |
| **65** | Almost There widget | 🔍 + 💤 — direct mirror of W64 | [#192](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/192) |
| **66** | Stale Shares widget | 🔍 + 💤 — completes the home dashboard trifecta | [#193](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/193) |
| **67** | Recent-customers dropdown | 🔍 preview to mirror W63 like W62 mirrored W61 | [#194](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/194) |
| **68** | Notification Bell | 🔍 + state-aware 💤/⏰ on W48 share rows | [#195](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/195) |
| **69** | Activity Feed | 🔍 + state-aware 💤/⏰ on W49 share rows | [#196](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/196) |
| **70** | (this milestone bookend) | WAVES.md update documenting the W61-70 arc | this PR |

Final cross-surface action-row coverage:

| Surface | Action row |
|---|---|
| Customer detail buttons | 📞 💬 📧 🔍 (full action bar) |
| Kanban context menu | 📞 💬 📧 🔍 💤/⏰ |
| Cmd+K palette | 📞 💬 📧 🔍 💤/⏰ |
| Recent-customers dropdown | 📞 💬 📧 🔍 💤/⏰ |
| Hot Leads widget | 📞 💬 📧 🔍 💤 |
| Almost There widget | 📞 💬 📧 🔍 💤 |
| Stale Shares widget | 📞 💬 📧 🔍 💤 |
| Notification Bell | 📞 💬 📧 🔍 💤/⏰ |
| Activity Feed | 📞 💬 📧 🔍 💤/⏰ |

---

## State-aware vs render-only snooze

The fourth push used two different snooze button policies
depending on the surface's filtering behavior:

| Surface | Snooze policy | Why |
|---|---|---|
| Cmd+K, recent dropdown, kanban context, customer detail | **State-aware** (💤 fresh, ⏰ snoozed) | Always shows lead regardless of snooze state |
| Hot Leads, Almost There, Stale Shares | **Render-only** (💤 only) | `compute()` filters snoozed leads — the lead never appears in the widget if snoozed |
| Notification Bell, Activity Feed | **State-aware** | Customer-side alerts/events fire even on snoozed leads (rep-side noise gets suppressed by W39, but customer-side stays) |

This split keeps the policy honest: state-aware where the
surface might genuinely show a snoozed lead, render-only where
the snooze itself causes the lead to drop off.

---

## Surface coverage scoreboard at W70

The first ten waves of the fourth push produced these
counts. Each entry below is a unique surface where the
corresponding action is reachable inline (button or menu item).

| Action | Surface count | Surfaces |
|---|---|---|
| 📞 Call | 9 | All except customer detail (which uses the action bar) |
| 💬 SMS portal link | 9 | All same as Call |
| 📧 Email portal link | 9 | All same as Call |
| 🔍 Portal preview | 9 | customer.html · kanban context · cmd+K · hot-leads · almost-there · stale-shares · recent-dropdown · notif-bell · activity-feed |
| 💤/⏰ Snooze | 9 | kanban-context · customer-detail · cmd+K · recent-dropdown · hot-leads · almost-there · stale-shares · notif-bell · activity-feed |

---

## Architecture notes for the fourth push

- **Mirroring continues to scale** — W62 mirrored W61 and W67
  mirrored W63 the way W52 mirrored W44 and W59 mirrored W58.
  The "every cmd+K change should also land on the recent
  dropdown" rule held cleanly. Future cmd+K-shaped surfaces
  should plan for the recent dropdown to follow.

- **Inline onclick vs delegated `addEventListener`** — the
  fourth push used both depending on what the existing surface
  already did. Bell rows (W68) used inline `onclick` calling
  `window.NotifBell._actionPreview('${id}')` because the
  surrounding W48 code was already inline. Cmd+K (W63) used
  delegated handlers because W51 already delegated. The lesson:
  match the surrounding pattern rather than imposing a uniform
  one — consistency *within* a file is more readable than
  consistency *across* files.

- **Modal z-index stacking holds at 99997 vs 9999/10000** — the
  W56 preview modal at z-index 99997 cleanly overlays every
  surface (cmd+K palette at 10000, dropdowns at 9999, kanban
  itself at base). The pattern: any new modal sits above 99996;
  any new dropdown sits at 9999. Don't introduce a third tier.

- **`closeDropdown` flag pattern** — the recent-customers
  dropdown click handler (W62, W67) added a `closeDropdown`
  flag that defaults to true but flips to false for snooze /
  unsnooze / preview. Share actions still close the dropdown
  (rep wants the SMS composer unobstructed); modal-opening
  actions keep it open (rep wants context underneath). New
  inline-action surfaces should adopt this pattern.

- **`render()` after unsnooze for in-place flip** — every
  state-aware snooze surface (W61, W62, W68, W69) calls a
  surface-local `render()` (or `renderRecentCustomers()`) after
  `LeadSnooze.promptUnsnooze()` resolves so the ⏰ → 💤 button
  flip happens immediately. Waiting for `nbd:data-refreshed`
  works but feels laggy on touch.

- **Color register held across all surfaces** — share trio uses
  green/blue/violet (#10b981 / #3b82f6 / #8b5cf6); preview uses
  amber (#f59e0b); snooze uses purple (#a890e8 fresh, #cab8ff
  active). These five colors map 1:1 to the five action verbs
  everywhere they appear. New action verbs should claim a sixth
  color rather than reusing one of the five.

- **Snooze policy stayed deliberate** — the "state-aware vs
  render-only" split (table above) made the policy explicit per
  surface rather than uniform. Future widgets that filter
  snoozed leads in `compute()` should render the 💤 variant
  only; future surfaces that always show all leads should go
  state-aware.

---

# Fifth push — Waves 71-80

The fourth push made snooze + preview universal across 9 list-of-
leads and alert surfaces. The fifth push went deeper into
**snoozed-lead lifecycle management**: surface the snooze
backlog, categorize each one, detect indecision, alert on
return, filter, and customize the rep's default preset. The
snooze system that started as a tiny "snoozedUntil" field in
W35 became a full lifecycle workflow.

The big arcs:

1. **Surface coverage** (W71-W72) — cmd+K now shows the snooze
   backlog when query is empty, customer page surfaces a
   "Snooze N other leads" chip for siblings on the same
   customer.
2. **Categorization + tracking** (W73-W76) — optional reasons
   tag (Insurance / Materials / etc.), `snoozeCount` field
   tracks indecision, kanban cards display reason + stale
   pills, bell fires "lead came back from snooze" alerts.
3. **Polish** (W77-W79) — reason filter chip row in cmd+K
   Snoozed section, ⭐ pin a preset as the rep's default.

The unifying outcome: a snoozed lead now has rich metadata
(when it returns, why it's deferred, how many times it's been
bumped) and the rep has dedicated tools for triaging the
backlog (cmd+K filter, ⭐ pin, expiry alerts).

---

## Surface coverage

The first two waves of the fifth push extended the snooze
backlog into surfaces that previously had no view of it.

| Wave | Surface | What landed | PR |
|---|---|---|---|
| **71** | Cmd+K palette | "Snoozed (N)" section when query is empty, sorted by returning-soonest first, top 10 | [#198](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/198) |
| **72** | Customer detail header | "💤 Snooze N other leads" chip when current customer has multiple open leads — uses W35 LeadSnooze.bulkPrompt | [#199](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/199) |

Together they close the "where's my snooze backlog?" question
from two angles: cmd+K when the rep is searching anyway, and
the customer page when the rep is mid-customer triage.

---

## Categorization + tracking

The next four waves added metadata to each snooze and surfaced
it across the existing snooze view surfaces.

| Wave | What | PR |
|---|---|---|
| **73** | Optional reason tag (Insurance / Not ready / Out of town / Materials / Other) — chip row in both modals, persists as `snoozedReason` field, surfaces in W36 banner + W71 cmd+K + W74 toast | [#200](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/200) |
| **74** | `snoozeCount` field bumped on each snooze (cumulative — not reset on unsnooze). When ≥3, surface as amber `⚠️ Snoozed 3×` indicator. New API `LeadSnooze.isStaleSnooze(lead)` | [#201](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/201) |
| **75** | Kanban card snoozed pills — purple "💤 Sep 9 · Insurance" + amber "⚠️ Snoozed 3×" pills in the kc-tags row when show-snoozed toggle is on | [#202](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/202) |
| **76** | Snooze-expired alert in notification bell. Fires when `snoozedUntil` is in the past, within 3-day SNOOZE_EXPIRY_WINDOW. Subtitle shows reason: "Was: Insurance · 2d ago" | [#203](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/203) |

Three-surface coverage of snooze metadata after W75:

| Surface | Snooze pill | Stale pill |
|---|---|---|
| Customer-snooze-banner (W36) | Title row | Title row |
| Cmd+K Snoozed section (W71) | Subtitle | Subtitle prefix |
| Kanban card (W75) | Tag row | Tag row |

W76 closes the lifecycle loop — the snooze system is now
proactive end-to-end: snooze → park → expiry alert → rep
acts (or re-snoozes, which W74 counts toward indecision).

---

## Polish

The last three waves of the fifth push focused on power-user
controls.

| Wave | What | PR |
|---|---|---|
| **77** | Reason filter chip row in W71 cmd+K Snoozed section. "All / ⚠️ Stale / Insurance / Materials / etc." Per-session state (clears on palette close), counts reflect full backlog (built before top-10 slice) | [#204](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/204) |
| **78** | ⭐ pin a default preset in the per-lead snooze modal. Pinned preset reorders to top + gets purple-tinted border. localStorage-backed | [#205](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/205) |
| **79** | ⭐ pin in bulk snooze modal — coverage parity with W78. Shared `DEFAULT_PRESET_KEY` so pinning in either modal reflects in the other | [#206](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/206) |
| **80** | (this milestone bookend) | this PR |

---

## Architecture notes for the fifth push

- **localStorage for per-device preferences, Firestore for
  per-lead state** — W37's show-snoozed toggle, W77's per-session
  reason filter, and W78/W79's pinned preset are all per-device
  preferences that don't need to sync across devices. They live
  in localStorage. By contrast `snoozedReason`, `snoozeCount`,
  and `snoozedUntil` are per-lead state that everyone touching
  the lead needs to see → Firestore. The split kept the schema
  changes minimal and the latency low.

- **Cumulative counts that resist gaming** — W74's `snoozeCount`
  does NOT reset on unsnooze. Resetting would let a rep "wash"
  the indecision signal by toggling the snooze. Keeping it
  cumulative made the signal honest.

- **Read-modify-write vs Firestore `increment` sentinel** —
  W74's snooze() bumps `snoozeCount` from the in-memory cache
  (`(existing.snoozeCount || 0) + 1`) rather than importing
  Firestore's `increment` sentinel. Reps don't snooze
  concurrently from multiple devices on the same lead, so
  non-atomic is safe. Avoiding the sentinel kept the import
  surface unchanged.

- **Self-clearing alerts** — W76's snooze-expired signal has a
  3-day window after which it self-clears. Without that, the
  bell would accumulate every expired snooze the rep hadn't
  acted on, drowning the actually-fresh alerts. After the
  window, the existing W48 stale-lead signal takes over.

- **Modal-reopen as the simplest re-render** — W78's pin click
  closes + reopens the modal rather than partial-DOM patching.
  Three reasons: (1) the modal HTML is the single source of
  truth so re-rendering removes the chance of state drift, (2)
  the implementation is shorter, (3) the visual flicker is
  imperceptible because both close + open run synchronously.
  The same pattern landed in W79.

- **Filter state local to a session, not persisted** — W77's
  reason filter clears on palette close. The reason filter is
  a triage tool for one-time backlog cleanup, not a saved
  preference. Persisting it would mean the rep opens cmd+K
  next morning and sees only "Insurance" with no obvious why.

- **Coverage waves carry the polish theme** — W79 shipped right
  after W78 to keep the "⭐ default pin" feature consistent
  across both modals. Single-modal features that ship
  partially erode trust ("does this work everywhere?"). When
  a feature lands in one modal, the polish wave to extend it
  to the other should follow within 1-2 waves.

- **Stale-snooze threshold = 3** — W74's `STALE_SNOOZE_THRESHOLD`
  is intentionally lenient. Two snoozes is "I deferred and
  re-deferred" — could be legitimate. Three is the inflection:
  the rep keeps not acting. Raising the threshold to 5 would
  make the signal too rare; lowering to 2 would fire on
  legitimate two-step deferrals. 3 feels right for this domain.

---

# Sixth push — Waves 81-90

The first five pushes were feature-driven: build the share trio,
build the snooze system, make actions universal, etc. The sixth
push pivoted to **quality**. Two parallel code reviews surfaced
real bugs hiding in the codebase — including a CRITICAL XSS in
the homeowner-facing portal generator and a HIGH regression
that had silently broken every notification bell action button
since W48.

The trigger: a single message from the user — "do anything and
everything necessary to get everything working as well as
possible across every access platform and system." The waves
that followed weren't feature work, they were the kind of fixes
real users notice but no one had filed because the failure
modes were silent.

The big arcs:

1. **Mobile + a11y polish** (W81, W84, W85) — touch targets,
   escapeHtml consistency, ARIA + Esc + initial focus on snooze
   modals.
2. **HIGH/CRITICAL bug fixes from internal review** (W82, W83) —
   bell action buttons restored after silent regression,
   snooze-system edge cases (unsnooze guard, Sunday off-by-one
   in nextMonday, lowercase terminal-stage matching).
3. **Portal hardening** (W86, W87, W88, W89) — CRITICAL XSS in
   buildPortalHTML, CORS lockdown, BoldSign URL validation,
   iframe sandbox, photo lightbox rebuild for mobile, user-
   scoped notes/tasks queries.

The unifying outcome: the system that already worked on paper
now works **for real**, on mobile, behind iOS notches, with
screen readers, with hostile data, and across every customer-
facing surface.

---

## Mobile + a11y polish

Quality work that compounds the W61-W70 universal-action-row arc.

| Wave | What | PR |
|---|---|---|
| **81** | Touch target audit — bumps W46-W79 inline action buttons (📞 💬 📧 🔍 💤 ⏰) to 36×36 minimum on touch devices via `@media (hover: none)` override. Desktop sizing unchanged. CSS-only — no JS source edits across 7+ surfaces | [#208](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/208) |
| **84** | Preserve `selectedReason` across W78/W79 ⭐ pin-click reopens — UX friction fix from review. + defensive `escapeHtml(String(c.count))` on the W77 filter chip count for consistency | [#211](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/211) |
| **85** | ARIA + Esc + initial focus on the W35/W37/W73/W78/W79 snooze modals. `role="dialog"`, `aria-modal`, `aria-labelledby`, `aria-pressed` on pin buttons, `aria-hidden` on decorative emoji, Esc closes, first preset auto-focuses | [#212](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/212) |

---

## HIGH + CRITICAL bug fixes from internal review

A code-reviewer agent run on the W71-W79 snooze-lifecycle
changes surfaced 3 HIGH issues plus a CRITICAL regression in
the notification bell.

| Wave | What | PR |
|---|---|---|
| **82** | 🚨 CRITICAL: bell action buttons (W48 share trio + W68 preview/snooze + W76 expiry) had been silently invisible since W48. `renderItem` gated the action row on `n.leadId`, but `buildNotifications` never set leadId on any push. Every rep had been seeing bell rows without inline action affordances since W48 shipped | [#209](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/209) |
| **83** | HIGH bundle: (1) `unsnooze()` dead Firestore guard would TypeError instead of throwing a clean message, (2) `_nextMonday()` returned tomorrow on Sundays — Sunday-working reps lost a week of intended deferral on every "Next Monday" click, (3) `customer-sibling-snooze` TERMINAL set missed lowercase `complete` so done deals could appear in the sibling-snooze count | [#210](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/210) |

The bell regression is the kind of bug that would never show
up in smoke tests — the buttons just don't appear. There's no
error, no warning, no broken state. Reps and managers had been
seeing partial-functionality bell rows for dozens of waves and
no one knew. This is exactly why structured code review on data
flow shape (not just style) matters.

---

## Portal hardening

A second code-reviewer pass on the customer-facing portal
flows surfaced TWO CRITICAL XSS vulnerabilities plus a stack
of HIGH issues. The portal is what end customers (homeowners)
see — every bug there is a real customer experience bug.

| Wave | What | PR |
|---|---|---|
| **86** | 🚨 CRITICAL: XSS in `buildPortalHTML`. Every interpolated rep-controlled lead field (name, address, damageType, insCarrier, scheduledDate, crew, photo URLs/names, task titles) was unescaped. Sister function `generatePhotoPortal` correctly used `esc()` — `buildPortalHTML` was the asymmetric oversight. A malicious or compromised rep, or injection from data-import / OCR / direct Firestore write, could ship arbitrary `<script>`/`<img onerror=...>` to homeowners. Fixed by lifting `esc()` to the top of `buildPortalHTML` and wrapping every interpolation site | [#213](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/213) |
| **87** | Portal hardening: (1) `getHomeownerPortalView` CORS lockdown — was `cors: true`, now uses the same allowlist as rep endpoints, (2) BoldSign `signEmbedUrl` regex-validated to start with `https://app.boldsign.com/` before iframe embed, (3) preview iframe sandbox attribute prevents `window.parent` access from the embedded portal HTML | [#214](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/214) |
| **88** | Photo lightbox rebuild. Old lightbox used per-img inline-style toggles — three real mobile bugs: no dismiss without re-tapping (homeowners got stuck), image clipped under iOS notch, state drift across multiple photos. New shared overlay with × close button + safe-area padding + Esc + backdrop dismiss | [#215](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/215) |
| **89** | `generatePortal` notes/tasks subcollection queries now scope to current user via `where('userId', '==', window._user.uid)` — matches the pattern already used for photos + estimates. Defense-in-depth: in a multi-rep company a single lead can have notes/tasks from manager handoffs / adjuster strategy / cross-rep collaboration. Tasks already render to homeowners; narrow the fetch | [#216](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/216) |
| **90** | (this milestone bookend) | this PR |

---

## Architecture notes for the sixth push

- **Code review on data flow shape catches what tests don't** —
  the W82 bell regression had been live for ~30 waves without
  detection. Smoke tests verify per-function behavior; the bug
  was at the integration shape (push without leadId → render
  gate fails). A code-reviewer pass focused on "does the data
  reach the renderer in the form the renderer expects?" found
  it in 30 seconds.

- **Asymmetric escape is the most common XSS pattern** — W86's
  `buildPortalHTML` had a sister function (`generatePhotoPortal`)
  that DID escape correctly. The bug wasn't "didn't know to
  escape" — it was "missed the escape on this branch but not
  the other." Patterns that exist in only one of two parallel
  surfaces are the highest-risk audit targets.

- **Mobile-first means safe-area-inset-first** — W88's lightbox
  rebuild explicitly used `env(safe-area-inset-*)` for the
  close-button position and overlay padding. iOS notches and
  home indicators silently break "just works on a phone"
  layouts unless the CSS opts in. The pattern: any
  `position:fixed` overlay should use safe-area padding by
  default.

- **Defense-in-depth queries even when rules cover you** —
  W89's `userId` scope on notes/tasks doesn't add security
  beyond what Firestore subcollection rules already enforce,
  but it does reduce the fetched data to only what the current
  rep wrote. If a future render path surfaces aggregated notes,
  the data has already been narrowed at the fetch layer.

- **Modal a11y is a first-class concern, not a polish item** —
  W85 added ARIA + Esc + initial focus to the snooze modals
  AFTER they shipped (W35, W73, W78). New modals from now on
  should land with `role="dialog"`, `aria-modal`, `aria-labelledby`,
  Esc handler, and initial focus from day one. The deferred
  add was the easy path; baseline a11y on first ship is the
  right path.

- **CSS overrides via `@media (hover: none)` scale to all
  surfaces at once** — W81 fixed touch targets across 7+ JS
  source files without editing any of them. The override
  approach + class-attribute selectors meant one change,
  zero risk of regressions in desktop sizing. New action-row
  classes added in future waves automatically inherit the
  touch-target floor as long as they match the established
  selector pattern.

- **`cors: true` is almost never the right default** — W87's
  CORS lockdown was a one-character fix (`cors: true` →
  `cors: CORS_ORIGINS`) that closed an information-disclosure
  vector. The "intentionally open — homeowner-facing" comment
  in the original code was the rationalization, not the
  requirement. Audit every Cloud Function with `cors: true`
  and ask whether the actual call site needs the openness.

- **External URLs in iframes need allowlist validation** —
  W87's `signEmbedUrl` validation prevents a future BoldSign
  API change from accidentally giving us an attacker-controlled
  iframe origin. Pattern: any URL that comes back from a
  third-party API and gets embedded in an iframe should be
  regex-validated against the expected domain before it
  reaches the client.

---

# Seventh push — Waves 91-100

The sixth push was quality-driven: bug fixes and security
hardening triggered by code-reviewer audits. The seventh push
returned to feature work but kept the rigor — small, focused
waves with strong cross-surface coverage, single sources of
truth, and graceful upgrade paths from the existing UX.

Two parallel arcs:

1. **Engagement scoring** (W91-W96) — productize the existing
   W44/W57/W58 share + view + respondedAt signals into a single
   tier (✅ → 🔥 → 👀 → 📨 → 🌱) and surface it on every
   list-of-leads + alert + filter surface.
2. **Message templates library** (W97-W99) — saved canned
   SMS / email messages with placeholder tokens, picker flow
   in the send path, and ⭐ default-pin to skip the picker for
   power users.

Both arcs share a single-source pattern: one compute function
(`CustomerEngagementScore.computeTier`, `TemplatesLibrary.apply`)
backs every consumer surface. The waves themselves are mostly
about wiring — the hard work is making the data flow deterministic
across N surfaces, not the per-surface UX.

---

## Engagement scoring

The CRM already collected three signals (W44 share, W57/W58
freshness, W58 viewed, respondedAt) but didn't aggregate them.
Reps had to mentally combine three separate badges. This arc
reduces that to a single tier the rep glances at to know whether
to call THIS lead right now.

The tier ladder (highest signal wins):

| Tier | Label | Trigger | Color |
|---|---|---|---|
| 4 | ✅ Responded | Any estimate has `respondedAt` | Gold |
| 3 | 🔥 Hot | Viewed + (fresh share <24h OR multi-view) | Orange |
| 2 | 👀 Viewed | Any estimate viewed | Green |
| 1 | 📨 Sent | Share sent, not yet viewed | Violet |
| 0 | 🌱 New | No signals | (hidden) |

| Wave | Surface | What landed | PR |
|---|---|---|---|
| **91** | Customer detail header | `CustomerEngagementScore.computeTier()` + chip in meta-row next to W52/W59 chips | [#218](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/218) |
| **92** | Kanban card | Tier badge as kc-tag pill alongside W44 share + W58 viewed pills | [#219](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/219) |
| **93** | Kanban header | "🔥 Hot first" sort toggle. Each column reorders descending by tier; stable secondary sort by original index | [#220](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/220) |
| **94** | Dashboard home | Cohort widget — five horizontal bars proportional to tier counts. Excludes terminal stages | [#221](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/221) |
| **95** | Notification bell | Fresh-view alert (6h window) when a customer opens an estimate. Self-clearing, severity high | [#222](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/222) |
| **96** | Needs Attention filter | "hot-but-cold" reason — tier ≥ 3 + no rep activity 24h+. Highest-priority signal | [#223](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/223) |

Final cross-surface coverage at W96:

| Surface | What the rep sees |
|---|---|
| Customer page | 🔥 Hot chip in header meta-row |
| Kanban card | 🔥 Hot pill in tag row |
| Kanban (sort on) | Hot leads at top of every column |
| Dashboard cohort | Tier distribution at a glance |
| Notification bell | "🔥 Customer viewing your estimate" within 6h |
| Needs Attention | Hot-but-cold leads counted in the badge |

---

## Message templates library

Reps were retyping the same follow-up text dozens of times per
week. The W41/W43 PortalLinkHelpers prefilled bodies were
fixed strings — no per-rep customization, no variants for
different stages, no follow-up text patterns. This arc adds
a per-device template library with a picker flow.

| Wave | What | PR |
|---|---|---|
| **97** | `TemplatesLibrary` data layer + management modal — list/get/save/remove/apply/openManager. Seeds 3 defaults (mirrors W41/W43 bodies) so reps get a no-change baseline. Token substitution: `{firstName}`, `{portalUrl}`, `{repName}`, etc. | [#224](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/224) |
| **98** | `pickAndRender(channel, ctx)` picker integrated into `smsForLead` + `emailForLead`. 0 templates → fallback. 1 template → apply directly (zero friction). 2+ → picker. Cancel aborts send, "Use default" falls through to W41/W43 | [#225](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/225) |
| **99** | ⭐ default-template pin per channel. Pinned templates skip the picker even with 2+ saved. Single-default-per-channel invariant enforced by `setDefault`. Mirrors the W78 snooze preset pin shape | [#226](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/226) |
| **100** | (this milestone bookend) | this PR |

The seeded templates reproduce the W41/W43 prefilled bodies
exactly. Reps with the seeds-only baseline see no behavioral
change — same text, same composer. Reps who add 2+ templates
trigger the picker; reps who pin a default skip the picker
again. **The UX scales with rep usage**: zero waves of
breaking change for non-adopters, three levels of
sophistication for power users.

---

## Architecture notes for the seventh push

- **Single compute function = single source of truth across N
  surfaces** — `CustomerEngagementScore.computeTier` is called
  from 6 surfaces in the W91-W96 arc and `TemplatesLibrary.apply`
  is called from 2 entry points in W97-W99. When tier-scoring
  rules change (e.g., the Hot threshold becomes "viewed within
  48h" instead of 24h), one edit propagates to every surface.
  Avoid duplicating compute logic at the consumer layer.

- **Path-gated UI render, ungated compute** — `customer-engagement-score.js`
  uses `IS_CUSTOMER_PAGE` to gate the chip rendering, but the
  `computeTier` function is exported regardless of path so other
  surfaces (kanban, cohort widget, bell, Needs Attention) can
  call it. Pattern: gate the side effects (DOM render, event
  listeners) at module init, not the pure functions.

- **Stable secondary sort by original index** — W93's "Hot first"
  toggle uses decorate-sort-undecorate where the secondary sort
  key is the lead's pre-sort index. Same-tier leads preserve
  their input order. The result reads as "Hot leads bubble up;
  everything else stays put" — much less jarring than a full
  re-shuffle that disturbs same-tier ordering.

- **Self-clearing time-windowed alerts** — W76 (snooze-expired)
  and W95 (fresh-view) both use a fixed-duration window (3 days
  / 6 hours) after which the signal disappears even if the rep
  doesn't dismiss it. Without the window, the bell would
  accumulate every alert in history. After the window, longer-
  lived signals (stale-lead, stale-share) take over so the rep
  still sees the lead — just at lower priority.

- **Highest-priority "needs attention" reason wins** — W96's
  `hot-but-cold` check runs BEFORE the existing stale-stage /
  overdue-task / stale-estimate reasons. A hot-but-cold lead
  would eventually fire stale-stage too, but the more actionable
  reason ("this customer just engaged") supersedes the symptomatic
  one ("this stage is dragging"). Pattern: when a filter has
  multiple match reasons, name the root cause, not the downstream
  symptom.

- **Seed defaults that match existing behavior preserve trust** —
  W97's three seeded templates reproduce the W41/W43 prefilled
  bodies exactly. Reps who never touch the management UI see
  zero behavioral change — same SMS body, same email subject.
  The library is opt-in for variety. New features that add a
  layer between the user and a familiar flow should default to
  "no observable difference" until the user explicitly invests.

- **Picker friction scales with collection size** — W98 picks
  the right behavior based on count: 0 → fallback, 1 → direct,
  2+ → picker. W99 adds a fourth axis: pinned default → direct
  even with 2+. Reps with 1 template per channel never see the
  picker; reps with 5 templates see the picker every time
  unless they pin a default. The friction grows linearly with
  the rep's investment in the feature.

- **Single-invariant CRUD methods** — `TemplatesLibrary.setDefault`
  enforces the single-default-per-channel rule by clearing the
  flag on every other template of the same channel during the
  same write. Callers can't accidentally end up with two
  defaults. Pattern: invariants belong in the API method that
  could violate them, not in the UI that calls the method.

- **Seven milestones, one consistent shape** — W30, W50, W60,
  W70, W80, W90, W100. Each milestone has a 3-arc summary, per-
  wave PR-linked tables, and ~6-8 architecture notes. The shape
  is now the codebase's standard documentation rhythm — every
  10 waves of focused work get the same treatment. Repeatable
  format makes it easier to write and easier to scan later.

---

# Eighth push — Waves 101-117 (appearance + audit + AI copilot)

The seventh push closed at W100 with the engagement scoring + templates
arcs. The eighth push went broad: appearance customization expansion,
a third deep code review on previously-unaudited surfaces, and a full
AI sales-copilot arc that turned NBD Pro from a CRM into a
**sales-augmenting copilot**.

Three threads ran in parallel:

1. **Appearance & comfort** (W101, W105, W106-107) — the user asked
   for more theme diversity + size/density/motion controls closer to
   surface. Comfort tab in the 🎨 picker now has 6 toggles. Theme
   catalog grew 148 → 153 with the first WCAG-AAA accessibility theme.
   Color-blind-safe palette + time-of-day auto-switching shipped as
   part of the same picker.

2. **Quality + audit closeout** (W102-W104, W108-W110) — a third
   code-reviewer pass surfaced another CRITICAL XSS (widgets.js,
   same shape as the W86 portal XSS) plus 4 HIGH bugs (drag race,
   bulkMoveStage atomicity, Cincinnati-vs-Central timezone error,
   appointment duplicate sends). Closed every MEDIUM and LOW finding
   from the three review passes (snooze, portal, kanban). Audit
   ended at zero open findings.

3. **AI sales-copilot arc** (W111-W117) — the biggest leverage move
   of the session. Reads each lead's full context and proposes the
   next-best-action (when, what to say, which channel) with a
   confidence score. Heuristic foundation + Claude AI enrichment +
   pattern learning from rep behavior. Surfaces on three places —
   kanban pill, customer panel, dashboard briefing.

The unifying outcome: **the system now thinks alongside the rep.**
Engagement signals already collected (W44 share / W58 view /
respondedAt) become a single actionable score. The AI lifts where
it matters; the heuristic stays the floor. Reps' own behavior
(act vs dismiss) feeds back into future suggestions.

---

## Appearance + comfort

| Wave | What | PR |
|---|---|---|
| **101** | Comfort tab in 🎨 picker — density / text size / reduce motion / pro mode toggles surfaced from deep Settings | [#228](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/228) |
| **105** | 5 new pro themes — high-contrast (WCAG AAA), sage, amber, plum, mono. Catalog 148 → 153 | [#232](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/232) |
| **106** | Color-blind-safe palette toggle. Single CSS rule overrides --green/--red/--gold/--blue/--purple to IBM accessible colors. Propagates to every status-color surface | [#233](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/233) |
| **107** | Time-of-day auto-theme. 7AM-7PM → light, rest → dark. Per-side preference learning when rep manually picks | [#233](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/233) |

Comfort tab final: 📐 Density · 🔠 Text size · ⚙️ Reduce motion ·
⚙️ Pro mode · ⚙️ Color-blind safe · ⚙️ Auto theme by time.

---

## Quality + audit closeout

The third code-reviewer pass on kanban core + scheduled functions
+ widgets surface caught one more CRITICAL XSS plus 4 HIGH bugs.

| Wave | Severity | What | PR |
|---|---|---|---|
| **102** | 🚨 HIGH XSS | Widgets.js — every lead-name / address / stage interpolated unescaped into innerHTML. Same shape as W86 portal XSS but on rep dashboard. Persistent stored XSS scoped to the company | [#229](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/229) |
| **103** | HIGH bundle | bulkMoveStage stale Set + non-atomic loop · drag-drop race via module-global _dragId · moveCard double renderLeads · notification setInterval leak on sign-out | [#230](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/230) |
| **104** | HIGH | Cincinnati timezone wrong (Central → Eastern) · appointment reminder duplicate sends · unbounded leads collection scans | [#231](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/231) |
| **108** | MEDIUM | Bell buildNotifications cached (5s TTL) · activity feed leadById Map (O(N+M) replaces O(N×M)) | [#234](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/234) |
| **109** | MEDIUM | setInterval teardown on customer-* path-gated modules · portal photo Safari pointer-events fix | [#235](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/235) |
| **110** | MEDIUM + LOW | Sanitize notification doc fields at write-time · sales_rep cache scoped at hydration so DevTools can't reveal teammates' leads | [#236](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/236) |

Audit closeout at W110:

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | all fixed |
| MEDIUM | 0 | all fixed |
| LOW | 0 | all fixed |

---

## AI sales-copilot arc

| Wave | What | PR |
|---|---|---|
| **111** | SmartFollowup compute foundation. Heuristic decision tree maps 7 signal patterns → priority + action + channel + draft + confidence. Pure helper, no UI. Compounds W17/W26/W35/W44/W54/W58/W74/W92/W97 | [#237](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/237) |
| **112** | Kanban suggestion pill. Compact priority chip (⚡/💡/👁) in card tag row. Tooltip carries the why. Renders FIRST in tag row as the recommended next step | [#238](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/238) |
| **113** | Customer-page suggestion panel. Full UI: priority + headline + reasoning + draft preview + 4-button action row (📞/💬/📧/✕). Auto-injected above quick-actions bar | [#239](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/239) |
| **114** | Claude AI enrichment via render-once-then-enrich. Heuristic instant; AI refines headline + reasoning + draft in background. ✨ AI badge. 10-min per-leadId cache | [#240](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/240) |
| **115** | Dashboard briefing widget — top 5 next-best-actions. Heuristic compute across pipeline, AI-enriches top 5 only (bounded API spend). Inline action row + click-to-customer-page | [#241](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/241) |
| **116** | Pattern learning. Track act/dismiss outcomes per signal-set. Personal confidence adjustment ±15 based on the rep's own track record. localStorage-backed, ≥5 occurrence threshold | [#242](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/242) |
| **117** | (this milestone bookend) | this PR |

Arc surface coverage:

| Surface | Heuristic | AI | Tracking |
|---|---|---|---|
| Kanban pill (W112) | ✅ | ❌ (would burn budget) | ❌ (glance signal) |
| Customer panel (W113-114) | ✅ | ✅ | ✅ |
| Dashboard briefing (W115) | ✅ | ✅ (top 5 only) | ✅ |

---

## Architecture notes for the eighth push

- **Heuristic floor + AI lift** — W111's deterministic compute is
  the floor: instant, sync, sufficient for kanban pills (N cards
  shouldn't pay N API calls). W114 layers Claude on top via the
  enrichSuggestionAI helper — same interface, richer brain. W116
  adds personal pattern adjustment on top of both. Each layer is
  optional, fails gracefully, and shares one signal vocabulary.

- **Render-once-then-enrich** — W113 customer panel + W115 briefing
  paint the heuristic suggestion instantly, then re-render in
  place when the AI returns. No spinner, no jank, no error toast on
  failure. The heuristic is good enough that AI feels like polish,
  not a dependency.

- **Bounded API spend pattern** — W115 briefing only enriches the
  top 5 suggestions, not every active lead. Pattern: when AI is
  expensive, rank with a cheap heuristic first, enrich the top
  K only. Caps cost without sacrificing perceived quality.

- **Stable signal vocabulary across waves** — the same tags
  (`fresh-view`, `rep-cold`, `multi-view`, `stale-share`) drive
  W112 pill colors, W113 panel reasoning, W116 pattern-learning
  keys. Adding a new signal is one place; every consumer
  benefits.

- **Cross-surface color register** — priority colors are
  identical on W112 kanban pill + W113 customer panel + W115
  briefing rows. Urgent = red, today = orange, this-week = blue.
  Reps' eyes track urgency the same way regardless of surface.

- **Personal adjustment is conservative** — W116 ±15 cap and ≥5
  occurrences threshold mean a single bad week or sample-size-of-1
  bias can't permanently bury a signal. We nudge, never silence.

- **Asymmetric escape was the recurring vulnerability** — W82
  bell regression (data shape), W86 portal XSS, W102 widgets XSS
  all had the same root cause: a sister surface that DID the right
  thing while the audited surface didn't. Code review on data
  flow + per-template comparison catches these where smoke tests
  miss them. Three reviews in this push, three CRITICAL/HIGH
  caught. The pattern works.

- **localStorage as the per-device preference layer** — W37 show-
  snoozed toggle, W77 reason filter, W78 default preset, W101
  Comfort tab, W107 auto-theme, W116 rep stats. Same pattern:
  instant write, no Firestore round-trip, per-device intentional.
  When something needs cross-device sync (rare), promote to
  Firestore explicitly.

- **Audit closeout matters** — finishing the MEDIUM/LOW pile
  after the CRITICAL/HIGH was tempting to skip ("nothing's broken,
  ship features"). The cleanup waves (W108 perf cache, W109
  setInterval teardown, W110 sanitize-at-write) each took a
  small fraction of session time but removed entire classes of
  future regression. Closing the audit is the discipline that
  makes the next round of reviews shorter + sharper.


# Ninth push — Waves 118-126 (portal v2 + reliability P0s)

This push had two threads running in parallel: building out the
homeowner-portal into a real two-way conversation surface (was a
read-only progress page with a sign button before), and chasing
down the "everything feels stuck on loading" reliability bug the
user reported mid-arc. Three P0 fixes shipped — each one was a
silent blocker that almost certainly drove a chunk of the "the
system feels broken" friction users had been living with.

## Portal v2 — homeowner becomes an active participant

- **W118 — Customer photo upload** (PR #244). The portal's biggest
  close-the-loop opportunity: homeowner can snap a storm-damage
  photo, mid-job concern, or finished-work shot directly from
  their phone via the portal link. 30-second tap-and-send
  collapses the rep-side workflow that used to require a
  scheduled inspection visit. Client-side resize to 1600px max
  edge / JPEG q=0.85 keeps payloads under 1-2MB on cellular.
  8MB hard cap, 10/day per-token quota, JPEG/PNG/WebP whitelist.
  Lands in the same `photos` collection the customer page
  gallery already reads, so no rep-side wiring change.

- **W119 — Request a callback button** (PR #245). Companion to
  the call-now button: instead of phone tag, the homeowner picks
  a time-slot chip ("today" / "tomorrow morning" / "this
  weekend" / "anytime this week") with an optional note, and
  the request lands as a real task on the lead with a concrete
  Eastern-time `dueDate`. Surfaces in the rep's bell via the
  existing `task-today` / `overdue-task` branches in
  notif-bell.js. No new bell wiring needed — the data model
  shape is the same as a manually-created task. 3/day per-token
  quota anti-spam.

- **W121 — Customer rating after job complete** (PR #247). The
  post-completion feedback loop with smart funnel routing:
  4-5★ raters get nudged to a Google review (if `rep.googleReviewUrl`
  is set), 1-3★ raters get an amber recovery message ("we'll
  reach out within 24 hours") AND a high-priority "RECOVERY
  CALL" task lands on the lead with `dueDate=today` so the rep
  sees it immediately. Write-once on `lead.customerRating`.
  This converts unhappy customers into recovery sales BEFORE
  they post a public 1-star somewhere — the single biggest
  growth lever for D2D + insurance roofing.

- **W123 — Async messaging, homeowner side** (PR #249). The
  free-form back-channel that doesn't fit into a slot. New
  `leads/{id}/portal_messages` subcollection (admin-SDK only
  writes), `sendPortalMessage` + `getPortalMessages` Cloud
  Functions, portal thread-bubble UI with 30s polling that
  pauses on `document.hidden` + resumes on focus. Activity log
  + notification + lead.unreadHomeownerMessages counter on the
  rep side.

- **W125 — Async messaging, rep side** (PR #251). Closes the
  two-way thread. New "Messages" tab on customer.html with an
  unread badge in the tab label, live updates via onSnapshot
  (no polling on the rep side — they get instant push as the
  homeowner sends), reply textarea + `replyToPortalMessage`
  callable. Sending a reply implicitly marks all unread
  homeowner messages as read-by-recipient (rep is acknowledging
  by responding) and resets the unread counter to zero.

## Reliability P0 fixes (the "nothing loads" bug)

- **W120 P0 — Page-load race conditions** (PR #246). Four real
  bugs killed in one commit:
  1. Outer `renderLeads` retry was gated on `window._leads?.length`,
     meaning new users with zero leads (or sales_reps filtered to
     empty) NEVER escaped the kanban skeleton. Replaced with a
     30s polling loop that succeeds the moment renderLeads is
     defined, regardless of lead count. After 30s we show a
     "Couldn't finish loading — Reload" fallback instead of an
     infinite skeleton.
  2. Inner `loadLeads` renderLeads retry was a one-shot 500ms
     setTimeout. If crm.js was still loading, the retry never
     fired again. Removed; outer 30s poll is the single source.
  3. `setTimeout(loadLeads)` cold-start retry was untracked, so
     a stale retry could fire during a fresh load and call
     `renderLeads([])` mid-fetch. Now we track the timer handle
     and clearTimeout it at the top of every loadLeads() call.
  4. `_initPromise` in nbd-auth.js had no `.catch()`. The first
     line of dashboard.html sets `visibility:hidden`, and
     `_showPage()` is the only path that un-hides it. Without
     a catch, any unhandled rejection inside the auth callback
     left the page invisible forever — the user reads it as
     "stuck loading" but it's actually invisible-with-an-error.

- **W122 P0 — Voice Intel "Missing or insufficient permissions"**
  (PR #248). Every customer page that hadn't recorded a call yet
  showed the alarming permission error in the Voice Intel panel.
  Root cause: `firestore.rules:142-150` evaluates
  `isOwner(resource.data.userId)` per-doc; for LIST queries,
  Firestore requires a `where()` filter constraining the query
  to docs the rule can prove are readable. The client query had
  no `where('userId','==', uid)` filter, so even an empty
  collection was rejected. Added the filter, required uid as a
  parameter to `subscribeToRecordings()`, friendlier
  permission-denied messaging.

- **W124 P0 — Service worker stale-cache** (PR #250). The
  actual root cause of the "Ctrl+R doesn't fix it, only
  Shift+Ctrl+R does" symptom the user described AFTER W120
  deployed. The SW's `handleAssetRequest` used
  stale-while-revalidate for ALL same-origin JS/CSS — every
  Ctrl+R served the OLD cached crm.js / nbd-auth.js / etc.
  while the HTML was fresh. New HTML calling new functions =
  silent failure = stuck. Switched to network-first for
  same-origin JS/CSS (cache only as offline fallback), bumped
  cache versions v16 → v17 to nuke existing stale caches.
  Existing controllerchange auto-reload handles the deploy
  transition without user action. CDN libraries unchanged
  (version-pinned in URL, cache-first remains correct).

## Architecture notes for the ninth push

- **Same close-the-loop pattern, three different surfaces** —
  W118 photos, W119 callbacks, W123 messaging all follow the
  same shape: a portal token-authed Cloud Function takes a
  homeowner action, drops a real artifact (photo / task /
  message) into the lead, mirrors to the activity log,
  optionally creates a notification. The rep sees the same
  artifact through their existing surfaces (kanban, bell,
  customer page) — no new rep-side wiring needed. Each new
  homeowner-action wave is just "what's the data shape that
  lands on the lead, and how does it surface in the existing
  funnel?"

- **Smart funnel routing on rating** — W121's tiered response
  (4-5★ → Google nudge, 1-3★ → recovery task) is the most
  ROI-positive feature of the arc. The cost is one IF branch on
  the server; the win is the difference between growing
  reputation and bleeding reputation. Important pattern: the
  rating UI itself is identical for both outcomes — the routing
  happens server-side based on the score, so a rep can't game
  it and a homeowner doesn't see the funnel logic.

- **Stale-while-revalidate is the wrong default for SPA assets**
  — W124's lesson. SWR is right for content (images, articles,
  static data) but wrong for code where the HTML and JS files
  must be in lockstep across deploys. Network-first with
  cache-as-fallback is the reliable choice; the perceived
  performance cost is small with HTTP/2 multiplexing. CDN
  libraries can stay cache-first because their URLs are
  version-pinned — the cache key IS the version, so different
  versions = different cache entries by construction.

- **Three P0s in one push, all silent blockers** — W120
  (skeleton-stuck), W122 (permission-error spam), W124 (SW
  stale-cache) were all "the page doesn't work" bugs that
  users were learning to live with via reload-spam. None
  surfaced an error message that pointed at the root cause.
  Pattern lesson: a silent failure that "almost works" is
  worse than a hard failure with a stack trace, because
  users lose hours/days/weeks of productivity rather than
  filing a single bug. The fix-arc here was directly driven
  by user feedback in real time — W120 fixed the in-app race
  conditions I could find via static analysis, the user came
  back with "still broken on Ctrl+R" which pointed straight
  at the SW (W124), the screenshot they sent of the Voice
  Intel panel pointed at W122. Listening + targeted fixes
  beat speculative refactors.

- **Wave-numbering integrity through pivots** — when the user
  flagged the P0 mid-stream, I bumped the planned wave numbers
  forward (W120 was originally going to be customer rating,
  became page-load reliability; rating became W121). Keeping
  the wave numbers strictly chronological in commit/PR titles
  preserves a clean audit trail in `git log` — every PR is
  numbered in the order it actually shipped, not the order it
  was originally planned.

- **Auto-deploy bridge via SW controllerchange** — the existing
  controllerchange listener in dashboard.html means W124's SW
  fix takes effect on the next reload after deploy without the
  user doing anything. The new sw.js installs in background,
  activates with `skipWaiting + clients.claim`, fires
  controllerchange, the dashboard auto-reloads, and the user
  sees fresh code on the very next view. That bridge meant the
  P0 fix didn't require a "please hard-refresh" announcement —
  the system self-heals on first contact with the patch.


# Tenth push — Waves 127-132 (Whisper arc + final cache P0)

This push closed out one more reliability P0 (W127 — the actual
root cause of the user's "every other reload stuck" toggle bug)
then built the entire NBD Whisper arc requested earlier in the
session. By the end of the push, NBD Pro has the full Whispr Flow
+ Granola voice toolkit: dictate-into-input via hold-to-talk,
plus a Quick Capture scratchpad with smart routing, plus a
searchable inbox of past captures.

## W127 P0 — the real reason "every other refresh" was stuck

The W124 P0 in the ninth push fixed the Service Worker's
stale-while-revalidate bug — but the user came back with "still
every other one or so." Investigation surfaced two compounding
bugs in `firebase.json` that defeated the W124 fix:

1. The rule `"source": "/sw.js"` was supposed to set
   `Cache-Control: no-cache` on the Service Worker, but the
   actual SW lives at `/pro/sw.js` (registered with scope
   `/pro/`). The literal `/sw.js` rule never matched. Firebase
   Hosting fell through to the catch-all `"source": "**"` rule
   with `max-age=300`. Result: the SW itself was cached at edge
   + browser for 5 minutes per request — meaning every SW deploy
   (including W124's network-first switch) took 5+ minutes per
   CDN edge to start propagating, and during that window users
   kept hitting the OLD SW with stale-while-revalidate behavior.

2. All JS/CSS files had `Cache-Control: max-age=300`. Even with
   W124's network-first SW, the browser's HTTP cache layer is
   independent — the SW's `fetch(request)` call is subject to
   browser HTTP cache rules, so an unexpired cache entry would
   short-circuit the network call. "Network-first" became
   effectively cache-first within the 5-minute window, defeating
   W124's intent.

Why "every other" specifically: stale-while-revalidate AND
HTTP-cache-with-TTL both work the same way — each load's
background refresh updates the cache for the next load. Toggling
pattern emerges from the gap between when stale gets served and
when its background refresh completes.

Fixes shipped together:
- `/pro/sw.js` rule with `no-cache, must-revalidate` so the SW
  is never cached at edge
- All JS/CSS changed from `max-age=300` to `max-age=0,
  must-revalidate` — ETag-based revalidation on every request,
  browser uses cache only when content is verified unchanged
- SW `fetch(request, { cache: 'reload' })` so the SW's own
  fetches always bypass the browser HTTP cache layer
- SW cache versions bumped v17 → v18 to nuke any straggler
  caches on first activate

## NBD Whisper arc — the full Whispr-Flow analog

Five waves that took the existing voice infrastructure (Deepgram
Nova-3 + Claude Haiku via the AI arc) and turned it into a
dictate-anywhere + scratchpad surface.

- **W128 — Dictate-anywhere core.** Floating 🎤 mic button
  (bottom-right), tap-to-toggle, MediaRecorder lifecycle with
  live waveform + 0:00 timer overlay during recording. Pipeline:
  audio → `transcribeVoiceMemo` callable → `callClaude` with a
  cleanup prompt → cleaned text inserted at cursor position of
  focused input (or copyable floating tooltip if nothing focused).
  Module: `docs/pro/js/nbd-whisper.js`.

- **W129 — Unified `dictate` Cloud Function.** Replaced W128's
  chained client-side path with a single Cloud Function that
  combines transcribe + AI-process server-side. Three modes:
  `clean` (cleanup only), `summarize` (overview + actionItems +
  entities + category), `extract-tasks` (structured tasks ready
  to commit). One round-trip instead of two. Cleanup prompt is
  versioned with the function — server-side iteration without
  client redeploys. Module: `functions/dictate.js`.

- **W130 — Quick Capture scratchpad.** Different surface from
  W128's dictate-into-input FAB. Floating 🎙 button (above the
  W128 mic), tap → full-screen modal with big record button,
  5-min cap, live waveform. After processing, structured summary
  lands with overview + action items + entity chips + category
  badge. Four routing options: save capture / save & link to
  lead / make N tasks on a lead / discard. Lead picker reads
  the in-memory `window._leads` cache. Module:
  `docs/pro/js/quick-capture.js`.

- **W131 — Hold-to-talk hotkey.** The Whispr-Flow ergonomic
  default. Hold F2 (configurable) → recording starts after a
  200ms grip threshold (so accidental quick taps don't fire empty
  50ms recordings). Release → stops + processes + inserts. Auto-
  repeat events ignored, modifier-pressed F2 passes through to
  browser/OS, window blur safely cancels mid-hold. Comfort tab
  toggle + key picker (F2/F3/F4/F8/F9/F10/ScrollLock/Pause).

- **W132 — Quick Capture inbox.** Closes out the arc. Tiny 📋
  button above the QC FAB → modal with searchable list of past
  captures. Per-item: re-link to a different lead, archive,
  expand for full transcript + action items. Reads
  `users/{uid}/captures/` (already covered by the existing
  owner-only subcol rule). Module:
  `docs/pro/js/quick-capture-inbox.js`.

## Architecture notes for the tenth push

- **One pipeline, two mental models** — W128 (dictate INTO an
  input) and W130 (talk freely + route OUT) share the same
  Deepgram + Claude pipeline (W129's `dictate` callable) but
  feel completely different to the user. Different floating
  buttons, different modal styles (W128 is a tooltip, W130 is
  full-screen), different default modes (clean vs summarize),
  different success surfaces (text-in-input vs structured
  summary card). Same engine, two surfaces — the rep doesn't
  need to learn that they're the same thing under the hood.

- **Versioned server-side prompts** — W128 had the cleanup
  prompt inline in the client module. Iterating the prompt
  required redeploying every page that includes the script and
  invalidating SW cache. W129 moved it server-side; now a single
  Cloud Functions deploy updates the prompt instantly for every
  connected client. Pattern: any prompt that we'd want to
  iterate weekly belongs server-side from day one.

- **Reusing in-memory caches as a feature surface** — W130's
  lead picker and W132's lead-name resolution both read
  `window._leads` directly. No new query, no new state, no new
  cache to invalidate — the kanban already populates it on
  every dashboard load (and on `nbd:data-refreshed` events).
  Modules that need lead context just read it. When the cache
  is empty (e.g. a fresh tab before kanban hydrates), the
  picker falls back to a search-by-name input fed by Firestore.

- **The 200ms hold threshold pattern** — small UX details like
  this make the difference between a tool people use daily and
  a tool people abandon after one frustrating tap. Without the
  threshold, every accidental F2 (Windows muscle memory for
  rename) toasts "Clip too short." With it, only deliberate
  holds fire. The threshold is also load-bearing for the
  MediaRecorder + getUserMedia handshake (~80–150ms cold
  permission) — without it, fast taps would always lose audio.

- **FAB stack pattern for related-but-distinct actions** —
  W128 (filled mic, low) + W130 (outline mic, mid) + W132
  (icon outline, high) compose into a small vertical stack in
  the bottom-right corner. Visual hierarchy mirrors action
  hierarchy: most-frequent action lowest (closest thumb on
  mobile), least-frequent highest. Each action is one tap from
  any page on dashboard.html or customer.html.

- **Network-first wasn't enough — HTTP cache layer was the
  remaining lie** — the W124 P0 was correct in intent (network-
  first SW) but didn't account for the browser's HTTP cache
  intercepting the SW's `fetch()` call. W127 closed that gap
  with both a `cache: 'reload'` flag in the SW (force-bypass)
  and a `must-revalidate` Cache-Control on the assets (force-
  ETag-check). Belt-and-suspenders: either layer alone fixes
  the symptom, but both together prevent any single mistake
  in either layer from re-introducing it.

- **The user's report was the diagnosis** — "every other one or
  so" was a precise enough description that I could rule out
  random races and zero in on cache alternation patterns.
  Generic "page won't load" reports take a code-explorer agent
  + grep marathon to diagnose. Specific frequency descriptions
  (every-other, only-after-X-seconds, only-on-bfcache-restore)
  point straight at the underlying state machine. Train users
  to describe the pattern and the bug usually identifies itself.


# Eleventh push — Waves 133-141 (Cmd+K, post-review polish, Lead Intelligence arc, address fix)

This push opened with the Cmd+K keyboard-first navigation surface
(W133 — completing the voice + keyboard ergonomic story alongside
the Whisper arc) and a parallel-agent code review pass that
surfaced 3 CRITICAL + 4 HIGH issues from the W118-W133 stretch
(W134). The bulk of the work was the Lead Intelligence arc
(W135-W140) — a unified 0-100 priority engine that combines every
signal NBD already collects into ONE score, surfaced consistently
across kanban, customer page, bell, command palette, briefing,
and a new threshold-crossing alert. A user-reported address
autofill bug also got fixed mid-arc (W141).

## Cmd+K command palette

- **W133 — Cmd+K palette.** The keyboard-first sequel to Whisper.
  Hit ⌘K (Mac) / Ctrl+K (Windows/Linux) — or `/` when no input is
  focused — to open a fuzzy-search overlay. Three sources: recent
  items (last 8 from localStorage), 22 built-in actions
  (navigation + voice + actions like New Lead / Sign Out), and
  fuzzy-matched leads from the in-memory cache. Two keystrokes
  from anywhere on the page to anywhere in the app. Module:
  `docs/pro/js/command-palette.js` (~430 lines).

## Post-review polish

- **W134 — 3 CRITICAL + 4 HIGH from agent review.** Parallel
  `security-reviewer` + `code-reviewer` agents against the
  W118-W133 stretch surfaced:
  1. TOCTOU race on per-token daily quotas across 3 portal
     endpoints (uploadHomeownerPhoto, requestCallback,
     sendPortalMessage). Burst of 10+ concurrent requests bypassed
     daily caps. Fix: wrap counter check + increment in
     `db.runTransaction`.
  2. submitCustomerRating write-once not atomic. Fix:
     transaction-scoped read + verify + write.
  3. `googleReviewUrl` could carry `javascript:` scheme — esc()
     in the portal HTML escapes characters but doesn't strip
     schemes. XSS pivot. Fix: enforce `^https?://` regex
     server-side + defense-in-depth client check.
  4. Base64 regex ReDoS risk on multi-MB input. Fix: pre-check
     `;base64,` substring before regex.
  5. `todayLocal` direct concat into Claude system prompt
     (prompt injection vector). Fix: strict
     `/^\d{4}-\d{2}-\d{2}$/` regex match.
  6. Signed URL expiry of `03-09-2491` made photo URLs
     practically permanent. Fix: 7-day TTL.
  7. `_renderRetryHandle` setInterval untracked → second
     loadLeads could double-run. Fix: hoist to window, clear
     alongside `_loadLeadsRetryTimer`.
  8. Quick Capture ESC lockout — modal couldn't be escaped if
     `_stopRecorder()` threw. Fix: ESC always closes.
  9. Quick Capture keydown listener leak on navigation. Fix:
     `pagehide → close` with `{once: true}` backstop.

## Lead Intelligence arc

The strategic feature of the push. Combines every signal NBD
already collects into ONE 0-100 score per lead, surfaced
consistently across every place the rep makes "what to do next"
decisions.

- **W135 — Engine.** Module: `docs/pro/js/lead-score.js`. Six
  weighted signal sources:
    Engagement   (0-30) — W92 customer-engagement-score tier
    Stage        (0-25) — gravity map: estimate-sent + signed peak
    Recency      (0-20) — exp decay, half-life ~2.8 days
    Hot signals  (0-15) — unread message (W123), recent upload
                            (W118), callback request (W119), low
                            rating (W121)
    Smart-followup (0-15) — W111 priority × confidence
    Pattern boost (0-5)  — W116 personal-adjustment delta
  Total clamps to 0-100. Tier ladder: 🔥 80+ / 🌡 60+ / 💧 40+
  / 💤 20+ / 🪦 0+. Also returns a `topReason` field with the
  single most-motivating signal — the rep sees the WHY at a glance.

- **W136 — Kanban card score badge + trend arrow.** Tiny pill in
  the top-meta row: tier-color dot, 0-100 score, ↑/↓ trend
  arrow vs. last seen for this lead (±2 deadband to prevent
  flicker, persisted to localStorage with a 1.5s debounce).
  Tooltip shows the topReason. Clickable in W137.

- **W137 — Customer-page score chip + breakdown panel.**
  `lead-score-panel.js`. Score chip in the customer header
  (matching tier color), clicks to expand a breakdown panel
  showing each signal's contribution as a horizontal bar +
  active signal tags + smart-followup AI suggestion. Auto-
  refreshes on every `nbd:data-refreshed` event.

- **W138 — Cross-surface sort consistency.** Bell, Cmd+K palette,
  and morning briefing all now sort by W135 score:
    - Bell: items inherit their lead's score; sorted within
      severity tier so a 'medium' bell row tied to a 🔥 Hot lead
      bubbles up above a 'medium' on a cold lead
    - Briefing: Top 5 sorted by unified score (was W111
      SmartFollowup score)
    - Cmd+K: empty query → top leads by score; text query →
      fuzzy match + small additive score boost

- **W139 — Threshold-crossing alert.** `lead-score-alert.js`.
  One-shot toast when a lead's score crosses INTO Hot (≥80)
  since last seen. Listens on `nbd:data-refreshed` events,
  reuses W136's localStorage cache for the comparison. 6h
  cooldown per lead so a bouncing score doesn't spam the rep.
  Toast click → opens that lead's customer page.

- **W140 — Arc bookend** (this entry).

## P0 mid-arc

- **W141 — Address autofill USPS mailing format.** User-reported
  daily friction: address autocomplete returned
  `456, Example Road, Goshen` instead of
  `456 Example Rd, Goshen, OH 45122`. Wrong on every count:
  comma after house number, full road name, missing ZIP, state
  spelled out, county included. Root cause: `selectAcItem` was
  splitting Nominatim's `display_name` on commas instead of
  using the structured `addressdetails` response. Fix:
  `formatMailingAddress()` helper that uses the structured
  fields with USPS Pub 28 suffix abbreviations (~80 mappings)
  + state-name → 2-letter code (50 states + DC + territories).
  Exported as `window.formatMailingAddress` so estimates,
  contracts, BoldSign envelopes can use the same formatter for
  consistency.

## Architecture notes for the eleventh push

- **One signal vocabulary, every surface.** The Lead Intelligence
  arc deliberately reused signal IDs across W136 kanban, W137
  customer page, W138 bell/Cmd+K/briefing, W139 alert. The rep
  sees the same `🔥 87 ↑` pattern, the same colors, the same
  tier names everywhere. When something is hot in the kanban
  it's hot in the bell, hot in the briefing, hot in the palette
  results. No surface-specific scoring tweaks — the engine is
  the single source of truth and consumers render it.

- **Stateless engine, stateful caches at the consumer layer.**
  `NBDLeadScore` itself is pure — no caching, no Firestore writes,
  no background scheduler. Each consumer that needs trend
  detection or threshold-crossing logic (W136 trend arrow, W139
  alert) keeps its own localStorage cache of last-seen scores.
  Both consumers share the same key (`nbd_lead_score_last_v1`)
  so the storage doesn't duplicate, but neither owns the engine.
  Lets us iterate the scoring math without breaking trend logic.

- **Defense-in-depth on URL handling.** W134's `googleReviewUrl`
  fix landed both server-side (regex enforcement in two places)
  AND client-side (defense-in-depth check before injecting into
  `<a href>`). Either layer alone closes the XSS pivot, but both
  together prevent a future server bug or direct-invocation
  pivot from re-introducing it. Same belt-and-suspenders pattern
  W127 used for the SW cache (`cache: 'reload'` flag + Hosting
  `must-revalidate` headers — either alone bypasses HTTP cache,
  but both together prevent any single mistake in either layer).

- **TOCTOU pattern: reservation transaction + post-write I/O.**
  W134's quota fix uses Firestore transactions to atomically
  reserve a quota slot, then does the slow I/O (Storage upload,
  message create) outside the transaction. If the I/O fails after
  reservation, the user is short one slot for the day —
  acceptable trade-off for actual quota enforcement under burst
  load. The alternative (reserve-rollback if I/O fails) is more
  complex and rarely worth it for daily quotas where being
  short one slot is invisible to the user.

- **Code review as a separate session phase.** The W134 polish
  wave was driven entirely by parallel agent passes
  (security-reviewer + code-reviewer) against a tight scope (just
  the W118-W133 diffs, not the whole codebase). 3 CRITICAL + 4
  HIGH issues caught — at least the CRITICAL TOCTOU + URL
  injection ones I would NOT have hand-scanned for after writing
  the code. Pattern: ship a feature stretch, then do a focused
  agent review, then a polish wave. Cheaper than a generic
  "code-review-everything" sweep and finds more real bugs because
  the scope is narrow enough for the agent to actually read the
  code carefully.

- **Backwards-compat fallbacks for engine availability.** Every
  consumer of `NBDLeadScore` (W136 badge, W137 panel, W138 sorts,
  W139 alert) checks `if (window.NBDLeadScore && ...)` before
  using it. The kanban badge falls back to no badge; the bell
  falls back to severity-only sort; the briefing falls back to
  W111's score; the alert silently doesn't fire. This means a
  half-deployed state where lead-score.js hasn't reached a user's
  cache yet doesn't break any of the surfaces — they just lose
  the score-based features until the engine arrives. Same pattern
  W129 used for the chained-fallback in nbd-whisper.js. Critical
  for SaaS where deploys aren't atomic across all clients.

- **The user-report → fix loop happened twice in this push.**
  Once for "every other reload stuck" (W127, deferred from the
  previous push) and once for "address autofill weird" (W141).
  Both fixes shipped within minutes of the report and addressed
  daily friction the user had been living with. Lead intelligence
  arc waves shipped between the bug reports without losing
  track. Pattern: bug reports during feature work get treated as
  P0 wave-inserts, get their own wave number, ship immediately,
  then we resume the arc. The wave-numbering integrity (every PR
  numbered chronologically in commit/PR titles) makes the audit
  trail clean even when arcs interleave.


# Twelfth push — Waves 142-148 (Estimate v2 finish arc + address autofill)

This push closed the Estimate v2 finish arc — the sequel to the
August "Rock 2" config-unification work. An agent audit of the V2
modal surfaced four major gaps blocking the rep workflow: dead
customer/claim inputs, hardcoded tier + county, dormant supplement
engine with no UI, and Classic still defaulted as the primary
builder despite V2 having near-feature-parity. The arc closes all
of them and adds the customer-engagement loop the BoldSign-only
viewedAt path was missing.

## Estimate v2 finish — six waves

- **W142 — Customer/Claim/Tier/County inputs** (PR #268). The
  unblock wave. The V2 builder's `state.customer.{name, email,
  phone, address}` could only be populated via prefillFromLead;
  `syncCustomerInputs()` referenced DOM IDs that didn't exist in
  the modal HTML — the function was a no-op. "Send for Signature"
  gated on customer.name + .email being non-empty, so signing
  failed for every standalone estimate. `state.tier` was hardcoded
  to 'better' with no UI control; `state.county` was hardcoded to
  'hamilton-oh' with wrong permit cost + tax for any non-Hamilton
  job. W142 added the four input groups (Tier button row, County
  dropdown, Customer section, Insurance Claim section) plus the
  `set-tier` action handler and `data-customer` / `data-claim` /
  `data-state` branches in the existing input delegator. From this
  wave on, every standalone estimate produces a valid PDF and
  Send-for-Signature works.

- **W143 — Per-SQ mode add-on controls** (PR #269). Surfaces 4 fields
  the per-SQ engine has supported all along but the UI never exposed:
  Chimney Flashing (+$425), Skylight Flashing (+$350), Valley Metal
  LF ($8.50/LF), Gutters LF ($8.50/LF). Without this wave, a rep
  building a per-SQ retail quote couldn't enable chimney flashing at
  all. New 'Add-Ons' section in the left pane with two checkboxes +
  two number inputs. `updateMeasurement` now treats hasChimneyFlash
  + hasSkylightFlash as bool fields. perSqInput in finalize() passes
  all four fields through to calculateAllTiers so retail-quote tier
  comparison includes them.

- **W144 — Supplement UI entry point** (PR #270). The dormant-engine
  unlock. estimate-supplement.js was a 632-line Firestore-ready
  module: createSupplement, addItem, addFromCatalog,
  modifyItemQuantity, attachPhoto, calculateDelta,
  formatSupplementLetter, saveToFirestore, loadForEstimate. With one
  gap: no UI button anywhere called any of it. supplement-ui.js
  ships the missing wrapper — auto-attaches a "+ Supplement" button
  to every customer-page estimate row via MutationObserver, opens a
  full-screen modal with reason input + catalog search + live delta
  + Preview Letter (NBDDocViewer) + Save. New /supplements/{id}
  Firestore rule (admin-SDK-only writes) was missing — every prior
  saveToFirestore call had silently 403'd. Added 'supplements' to
  FLAT_USER_COLLECTIONS in functions/integrations/user-owned.js so
  the registry-coverage smoke test passes.

- **W145 — V2 → primary, Classic demoted, BETA badge dropped**
  (PR #271). Closes the parallel-engine drift risk documented in
  the April 2026 estimate-engines audit. dashboard.html estimates
  view now renders ONE primary "+ New Estimate" button (orange)
  calling openEstimateV2Builder, plus a small ghost "Classic" link
  for the rare rep who specifically wants the legacy 4-step path.
  startNewEstimate() in estimates.js now calls
  window.openEstimateV2Builder() directly instead of
  showEstimateTypeSelector. All four "+ New Estimate" buttons
  elsewhere in dashboard.html (home view, empty-state, etc) inherit
  this routing automatically. V2 reads from estimate-config.js, so
  every new estimate now flows through the consolidated config —
  drift surface is gone for the default path.

- **W146 — Customer engagement: viewedAt write + view-link**
  (PR #272). The missing engagement loop. Wave 91 shipped the
  engagement-tier signal that reads viewedAt from estimates;
  W57+W58 shipped the almost-there-widget that ranks leads by
  viewedAt freshness. But the V2 builder had NO way to write
  viewedAt — only the BoldSign signature flow set it. Reps shipping
  V2 estimates without BoldSign saw the engagement signal stay
  silent forever. W146 closes the loop with a lightweight preview
  path: new getEstimateForView Cloud Function (token-authed via
  existing portal_tokens, cross-tenant guarded) stamps viewedAt /
  lastViewedAt / viewCount and drops a 'estimate_viewed' activity
  log entry on the lead; new docs/pro/estimate-view.html standalone
  viewer renders the redacted estimate; new "🔗 Share view link"
  button on customer-page estimate rows mints (or reuses) a portal
  token + copies the URL via Web Share API → clipboard → prompt
  fallback. Combined with W135 lead intel + W139 hot-lead alert,
  a homeowner viewing an estimate now bumps the lead score and
  fires the threshold-crossing toast if the cumulative signal pushes
  the lead over 80.

- **W147 — Estimate analytics summary band** (PR #273). Reads the
  data already in Firestore (tier, status, grandTotal, sentAt,
  viewedAt, signedAt) and renders a compact stat band at the top
  of the Estimates view: total + status breakdown, close rate, avg
  ticket per signed estimate, view→sign conversion, median time-
  to-sign, signed tier mix (proportional bar), and top-3 signed
  leaderboard. No schema changes. Module:
  docs/pro/js/estimate-analytics.js. Auto-refreshes on every
  nbd:data-refreshed event so a fresh loadEstimates or W146 view
  bump reflects without reload.

- **W148 — Estimate v2 finish arc bookend** (this entry).

## P0 mid-arc

- **W141 — Address autofill USPS mailing format** (PR #264, shipped
  during the eleventh push but logically belongs here). User flagged
  that addresses came back as "456, Example Road, Goshen" instead
  of "456 Example Rd, Goshen, OH 45122". Root cause: selectAcItem
  was splitting Nominatim's display_name on commas instead of using
  the structured addressdetails response. Fix: formatMailingAddress()
  helper using house_number + suffix-abbreviated road + city +
  ISO3166-2-lvl4 state code + postcode. Exported as
  window.formatMailingAddress so estimates, contracts, BoldSign
  envelopes can use the same formatter.

## Architecture notes for the twelfth push

- **The audit-then-ship pattern.** Before opening the Estimate v2
  arc I dispatched a code-explorer agent against the existing V2
  modal + supplement engine + estimate-finalization to produce a
  punch list. The agent surfaced the dead syncCustomerInputs IDs
  and the dormant supplement engine — both subtle issues a generic
  "build estimate v2" plan would have missed. Pattern: when picking
  up an arc that has prior work, spend one agent call mapping
  what's actually built first. Cheaper than discovering the gaps
  one wave at a time.

- **Engine-first → UI-second pays off here.** estimate-supplement.js
  was a complete engine with no UI for months. W144 was a single
  UI wave that turned it from dead code into a real feature. Same
  pattern applied to W146: the viewedAt FIELD existed in Firestore
  and the read paths (W91 tier, W57 widget, W135 lead score) all
  knew how to consume it. The write path was the only gap. One
  Cloud Function + one HTML page + one button activated the entire
  read pipeline retroactively. Pattern: when the data model is
  already shaped right, the wave that connects the missing edge
  unlocks features across the system at once.

- **TOCTOU-safe reservation → I/O pattern, applied four times in
  the arc.** W134 introduced the pattern (db.runTransaction
  reserves a quota slot inside the transaction, slow I/O happens
  outside). W144's saveToFirestore used the same pattern via the
  existing saveToFirestore helper. W146's getEstimateForView
  doesn't have a daily quota but does have the cross-tenant guard
  (estimate.leadId === token.leadId) inside the read path. Pattern:
  every endpoint that touches multiple docs gets the reservation-
  then-side-effect shape so racy concurrent calls can't violate
  invariants.

- **Defense-in-depth fallbacks for engine availability** — applied
  again in W145's startNewEstimate. If openEstimateV2Builder isn't
  loaded yet (mid-deploy SW cache miss), fall back to the
  showEstimateTypeSelector picker so reps aren't blocked. Same
  pattern as W129's chained-fallback in nbd-whisper.js, W136's
  defensive guard around NBDLeadScore, W138's sort fallback when
  the score engine isn't present. Critical for SaaS where deploys
  aren't atomic across all clients.

- **Read-the-data analytics is cheaper than write-new-data
  analytics.** W147's stat band reads from window._estimates +
  the existing schema fields. No new Firestore writes, no new
  collection, no migration. Total wave cost: ~190 lines of
  client-side compute + render. The data was always there;
  we just hadn't surfaced it. Pattern for future analytics waves:
  check what's already in the docs before designing a metrics
  pipeline.

- **The customer-engagement loop is the highest-leverage feature
  of the arc.** W146 (viewedAt write) is logically small but it
  flips W91 + W57 + W58 + W135 + W139 from "silent for V2 estimates"
  to "fully functional." Five surfaces became more useful from one
  edge fix. The compounding effect of feeding existing pipelines is
  often higher ROI than building new ones.

- **The +Supplement, 🔗 Share, +Tasks pattern.** Three buttons on
  every customer-page estimate row — supplements (W144), share
  view link (W146), warranty cert (existing). Each is a one-tap
  jump into a focused workflow. The customer page is becoming the
  hub for everything that happens to a lead, with the rep
  navigating outward to specific tools rather than back-and-forth
  through global menus. Aligns with the W128/W130/W132 voice FAB
  stack pattern: most-frequent-action lowest, less-frequent
  outward — one tap from any context.


# Thirteenth push — Waves 149-152 (Mobile polish + PWA install)

This push tightened the mobile experience after a daily-driver
field rep would actually use it. Three concrete waves of fixes
plus the PWA install prompt the manifest had been ready for since
day one but no client UI had ever surfaced.

- **W149 — FAB stack mobile polish** (PR #275). Three FAB-stack
  fixes: inbox FAB bumped 36→44px (was below iOS HIG 44px touch-
  target minimum); all 3 FABs now use
  `calc(Npx + env(safe-area-inset-bottom, 0px))` so they clear the
  iPhone X+ home indicator + Android gesture bar; new
  fab-stack-coordinator.js MutationObserver hides the entire stack
  (opacity=0 + pointerEvents=none + aria-hidden) when any of 6
  known full-screen modals is open (W130 Quick Capture record,
  W132 inbox modal, W133 Cmd+K, W144 supplement, V2 estimate
  builder, picker modal). Lead-alert toast stack (W139)
  intentionally NOT in the blocking list — it's non-modal and
  sits next to the FABs. Auto-checks on keydown + focus + 1500ms
  safety interval.

- **W150 — PWA install prompt** (PR #276). The manifest +
  service worker have been PWA-eligible for a year but no UI
  surfaced the install path. New pwa-install.js handles two
  routes: Android/Edge/Samsung Internet captures
  `beforeinstallprompt`, defers it, surfaces a centered bottom
  banner after 2s ("Install NBD Pro" + "Add to your home screen
  for full-screen mode, push alerts, and faster launches");
  click triggers `deferredPrompt.prompt()`. iOS Safari (no
  beforeinstallprompt event) gets a manual instruction card
  detecting iOS UA + non-standalone display mode — "Tap the
  Share button below, then Add to Home Screen". Both paths
  honor a 7-day dismiss flag in localStorage and auto-hide on
  `appinstalled` event. `window.NBDPwaInstall.forceShow()` is
  exposed for a future Settings reset button.

- **W151 — Consolidated polish sweep** (PR #277). One wave for
  what was originally three:
  * **mobile-polish.css** — global rules under
    @media (max-width:Npx) AND @media (pointer:coarse) gates so
    they only apply to actual touch devices on small viewports.
    Touch-target floors (36→40-44px) on the dense kanban +
    customer-page action chips. Customer-page .content-grid
    stacks vertically under 860px with proper 16px gap. The
    jump-nav becomes sticky on phones. :hover branches
    suppressed on (pointer:coarse) so the "did I tap that?"
    stuck-hover state on touch devices disappears. Form inputs
    bumped to font-size:16px on phones to prevent iOS zoom-on-
    focus. body padding-bottom = 80px when standalone so the
    last list row clears the FAB stack + home indicator.
  * **offline-banner.js** — yellow strip across the top when
    navigator.onLine === false. Reads still served from cache
    (W124+W127 SW), writes queue via offline-manager.js. Gives
    the rep confidence that "save failed" toasts are network-
    related, not data-related. Auto-hides on reconnection.

- **W152 — Mobile arc bookend** (this entry).

## Architecture notes for the thirteenth push

- **Pointer-coarse + viewport queries together.** Every mobile
  rule in mobile-polish.css is double-gated:
  `@media (max-width:Npx) and (pointer:coarse)`. The viewport
  query ensures desktop-narrow windows don't trigger touch-
  optimized rules; the pointer query ensures iPad-Mini-sized
  touch devices DO. Either alone misclassifies enough cases
  (Surface tablets, foldables, large iPads in landscape) that
  combining them is the only reliable mobile filter.

- **safe-area-inset on every fixed-positioned element.** W149's
  FABs, W150's install banner, W151's offline banner, the W139
  hot-lead toast stack, the W127 SW notification — all of them
  now use `calc(Npx + env(safe-area-inset-bottom, 0px))`. iPhone
  X+ home indicator, Android gesture bar, Dynamic Island, foldable
  hinges — all silently clipping fixed UI without insets. Pattern:
  any fixed element near a screen edge MUST use insets. Going
  forward this is the default, not an enhancement.

- **MutationObserver as the modal-coordinator pattern.** W149's
  FAB hider can't depend on every modal in the codebase calling
  a registration helper — there are too many of them, written by
  too many waves over the past year. MutationObserver watches the
  body element for direct child additions and class/style
  changes; the coordinator's BLOCKING_MODAL_IDS list is the
  single source of truth and modals stay decoupled from it. Same
  pattern would apply if we ever needed e.g. a global "darken
  background while a modal is open" effect.

- **Mobile polish is mostly CSS, not JS.** Three of the four
  W151 fixes (touch targets, stacking, sticky nav, hover
  suppression, iOS zoom prevention) are pure CSS via media
  queries. Only the offline banner needed JS because it has to
  react to a JavaScript event (online/offline). Lesson: when
  picking up a mobile arc, audit the CSS first — most "mobile
  feels broken" issues turn out to be missing media queries
  rather than missing logic.

- **The PWA install path is two events, not one.** Wave 150
  needed both the beforeinstallprompt branch AND the iOS Safari
  manual-instruction branch because Safari's PWA story is
  intentionally different from Chromium's. Pattern: every cross-
  platform UX decision needs to budget for 2-3 implementation
  paths even if the user-facing experience converges. The
  manifest is shared infrastructure; the install UI needs to
  fork by platform-feature-detection.

- **Arc-tightening when the original plan over-shards.** Original
  C-arc plan was 6 waves (W149-W154). After shipping W149+W150
  the remaining work fit cleanly into a single W151 polish sweep
  + W152 bookend — half the planned waves. Pattern: when an arc
  starts feeling artificially padded, bundle the leftover work
  into one focused wave rather than ship a string of micro-PRs.
  The wave-number gap (W153 unused, jumped to W152 bookend) is
  cleaner than ceremony for its own sake. Future arcs: assume
  the plan over-counts by 30% and look for collapse points.


# Fourteenth push — Waves 153-155 (Analytics dashboard rebuild)

This push rebuilt the Reports view from "Generate visual report
templates" into an at-a-glance performance dashboard the rep can
read in 5 seconds before any meeting. Two waves of new panels +
the bookend.

- **W153 — Performance dashboard: KPI tiles + period comparison +
  conversion funnel** (PR #279). New top panel on the Reports
  view: Revenue / Avg ticket / Leads added / Close rate, each
  with a delta badge vs the previous period. Period selector
  (7d / 30d / 90d / YTD, persisted to localStorage). 5-stage
  conversion funnel (Leads → Inspected → Estimate Sent → Viewed
  → Signed) with proportional bars + per-stage conversion %.
  Pure compute on window._leads + window._estimates — no extra
  Firestore reads. The funnel's Viewed step is powered by the
  W146 `viewedAt` write path, closing the engagement-loop signal
  loop introduced in the twelfth push.

- **W154 — Revenue trend sparkline + top performers**
  (PR #280). Two more sections: a 12-week revenue sparkline (SVG,
  no chart library, latest week dot highlighted, WoW delta badge
  on ±1%) plus three side-by-side leaderboards — Top Customers
  by lifetime signed revenue, Top Sources by signed revenue ×
  lead.source field, Most Engaged Leads (30d) by composite score
  (W92 engagement + W146 viewCount + W123 unread messages +
  recent uploads). Same in-memory compute as W153.

- **W155 — Analytics arc bookend** (this entry).

## Architecture notes for the fourteenth push

- **Compute on what's already in memory.** Both W153 + W154 are
  pure derivations off window._leads + window._estimates +
  window._photos. The Reports view doesn't initiate a single new
  Firestore query — every panel reads from the same snapshot the
  rest of the app already loaded. Pattern for analytics: the data
  pipeline you need to build is usually shorter than you think,
  because the read path is already in place for other features.

- **The W146 viewedAt loop pays off across surfaces.** W146
  fixed the missing write of viewedAt for V2 estimates not sent
  via BoldSign. That ONE wave now drives:
    - W57 almost-there-widget (existing)
    - W92 engagement-tier signal (existing)
    - W135 Lead Intelligence score's recency + hot signals
    - W139 hot-lead threshold-crossing alert
    - W153 funnel "Viewed" stage (new)
    - W154 most-engaged leaderboard (new)
  Six surfaces from one edge fix. Pattern: the cheapest waves are
  the ones that complete an existing pipeline rather than build a
  new one — the multiplier on downstream value is enormous.

- **Sparklines are SVG, not a chart library.** W154's 12-week
  trend is ~25 lines of inline SVG with computed path strings.
  No Chart.js, no Recharts, no D3. Total weight: zero new bytes
  of dependency. Pattern for visualization in NBD Pro: any chart
  you can describe with `<path d="...">` is cheaper to write than
  to import. Reserve charting libraries for crosstabs / cohort
  heatmaps / anything genuinely interactive.

- **Period selector via localStorage** is a 4-line pattern.
  `_readPeriod()` / `_writePeriod(key)` + a `data-period` click
  handler on the chip row + re-render. Same shape would work for
  any view's "default to last X days" preference. The reps tend
  to look at the same time window over and over (Joe spot-checks
  30d, weekly meetings show 7d, end-of-month does YTD) — the
  preference persists invisibly so they never have to re-pick.

- **Tightening D arc to 3 waves.** Original plan was 4 waves
  (W153-W156). After shipping W153+W154 the remaining work was
  just the bookend — no need for a separate wave for the
  cohort/leaderboard split that the original plan over-counted.
  Same pattern as the C arc tightening — assume the original
  plan over-shards by 30% and look for collapse points before
  shipping micro-PRs.


# Fifteenth push — Waves 156-158 (D2D polish + Onboarding/Discoverability)

This push closed both Direction E (D2D tracker polish) and
Direction F (onboarding) into combined waves. E was already a
mature 6900-line module across two parallel implementations, so
the win was a single targeted fix rather than a full refactor; F
was originally scoped as a multi-step interactive walkthrough but
collapsed to a one-wave discoverability bell once the actual gap
became clear.

- **W156 — D2D USPS address formatting** (PR #282). Routes the
  D2D module's reverseGeocode + address-autocomplete through
  window.formatMailingAddress (W141) instead of inline assembly.
  Same fix as W141 but in d2d-tracker.js's own code path. Result:
  a knock at "456 Example Rd" now matches the lead at the same
  address byte-for-byte, so the existing per-address attempt
  counter (getAttemptCount) actually works across the knock-to-
  lead conversion. Defense-in-depth fallback to the old inline
  assembly preserved if W141 isn't loaded yet (mid-deploy SW
  cache miss). Same fix applied to d2d-tracker-2026b.js (the
  parallel Rock 4 implementation).

  W128 Whisper hold-to-talk dictation already works on the D2D
  knock notes textarea by virtue of being a global feature on
  dashboard.html — no new wiring needed.

- **W157 — What's New discoverability bell** (PR #283). Most
  tools shipped in the last six months are silently available —
  hold F2 for Whisper, Cmd+K for the palette, the score badge
  on every kanban card, +Supplement on every estimate row, share-
  view links. A day-1 user has zero way to discover them. The
  bell + panel surface fills that gap.
  - 🎁 bell next to the user avatar pulses when there are unread
    features
  - Click → panel listing the 8 recently-shipped tools with one-
    line bodies, wave numbers, emoji icons, and "Try it" buttons
    that actually invoke each feature
  - Per-item seen flag in localStorage; items rotate off
    automatically after 30 days
  - 4-second auto-mark-seen timer once the panel is open so the
    bell stops pulsing without forcing the rep to click each item

- **W158 — E+F arc bookend** (this entry). Combined because
  E was a single targeted wave and F was a single discoverability
  wave; separate bookends would be ceremonial overhead.

## Architecture notes for the fifteenth push

- **Polish vs refactor on mature modules.** D2D is 6900 lines
  across two implementations (d2d-tracker.js classic + the Rock
  4 d2d-tracker-2026b.js). Refactoring isn't warranted — the
  module works. Polish is. The W156 wave is a 5-line per-file
  surgical fix that improves a daily-use input without touching
  the engine. Pattern: when arcs touch big mature modules, look
  for the single highest-impact narrow change first, ship it,
  then assess whether more is warranted. Often the narrow change
  is enough.

- **F collapsed because the actual gap was discoverability,
  not onboarding.** Original F-arc plan was 3 waves: first-run
  wizard, tooltip walkthrough, coachmark overlays. All three
  assumed the user is brand-new and needs a guided tour. But the
  actual user is the founder using his own product daily — he
  doesn't need teaching, he needs visibility into the new stuff
  shipped weekly. One wave with a bell + panel + curated rotating
  list answers that. The original 3-wave plan would have
  delivered the wrong thing.

- **The What's New ITEMS list as a deploy artifact.** Future
  waves that ship a user-visible feature just append to ITEMS in
  whats-new.js. The bell + pulse + panel render automatically.
  No extra ceremony, no separate "release notes" surface to
  maintain. The list rotates 30-day-old items off automatically
  so it stays scannable. Pattern: turn the discoverability surface
  into a side effect of the wave-ship process rather than a
  separate task.

- **Try-it handlers as inline action.** Each item in the panel
  has an optional tryHandler that invokes the feature directly:
  NBDWhisper.start(), NBDCommand.open(), goTo('reports'). The rep
  doesn't have to navigate to find the feature — they tap "Try
  it" and the feature runs. Pattern for any future "show me how"
  UX: don't describe the feature, run it.

- **Bell-anchor with floating fallback.** The bell tries to
  attach inline next to #userAvatar / #userName for visual
  hierarchy alignment with the existing topbar. Fallback: a
  floating top-right pill if the anchors aren't found. 60-tick
  probe (300ms × 60 = 18s) before falling back. Same probe
  pattern used by W137 lead-score-panel and the Voice Intel
  customer-page mount. Pattern: any module that needs to attach
  to the dashboard chrome should probe + fall back, never assume
  the chrome is loaded synchronously.

## Final session state

The 12-week stretch shipped 40 PRs across 15 milestone-bookended
pushes. The full arc list:

  W118-W126: Portal v2
  W120 + W122 + W124 + W127: Reliability P0s (4 waves)
  W128-W132: NBD Whisper voice toolkit
  W133:      Cmd+K palette
  W134:      Code review polish
  W135-W140: Lead Intelligence
  W141:      Address autofill USPS
  W142-W148: Estimate v2 finish
  W149-W152: Mobile + PWA
  W153-W155: Reports dashboard rebuild
  W156:      D2D USPS address formatting
  W157:      Discoverability bell
  W158:      E+F bookend

The session opened with portal v2 + Whisper as the strategic
arcs, hit three reliability P0s mid-stream (the user-reported
"every other reload stuck" was a particularly satisfying find —
two compounding cache-layer bugs that defeated my W124 fix until
W127 closed the path), and closed with five directional arcs
(C/D/E/F + Estimate finish) covering ~25% of the codebase. Every
arc bookended in WAVES.md. Every PR numbered chronologically.
