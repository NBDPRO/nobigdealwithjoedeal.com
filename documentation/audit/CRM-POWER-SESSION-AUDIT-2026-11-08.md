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
