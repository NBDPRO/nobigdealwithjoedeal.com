# Pixel Mode + Pixel World — build log (2026-10-11)

Track E of the CRM style integration roadmap (roadmap note: PR #2322, not yet
on main when this was written). Jo approved building Pixel World in the same
effort as the rest of the style work. This note is the running log for both
slices; each slice appends a dated section.

## E1 — Pixel Mode skin + dialog-box notifications (shipped with this note)

**What it is.** A skin, not a theme: `body.skin-pixel` layered over whichever
theme is active. It sets no colours of its own (every colour is a theme token),
so all 195 themes re-colour it. It changes frames (stepped pixel borders via
four hard box-shadows, no radius), type (Press Start 2P headings, VT323 body)
and adds a ▶ cursor on nav rows, optional static scanlines, a Home **Party**
and a **Trainer Card**.

| Piece | Where | Notes |
| --- | --- | --- |
| Pure rules | `docs/pro/js/pixel-logic.js` (`window.NBDPixelLogic`) | HP, overdue, open lead, party order, trainer card, box-shadow sprite, typewriter. Shared with Pixel World (E2). |
| Boot loader | `docs/pro/js/pixel-mode.js` | The only boot tag (~3 KB). One settings read; fetches the core only when skin/dialog is on or the Settings card scrolls into view. Leaves a `__stub` on `window.NBDPixelMode`. |
| Skin + wiring | `docs/pro/js/pixel-mode-core.js` (`window.NBDPixelMode`) | Lazy. Skin classes, Party/Trainer Card, dialog toasts, settings panel, `userSettings` read/write. |
| Stylesheet | `docs/pro/css/pixel-mode.css` | Lazy: injected only when something is on. Tokens only, every selector under `body.skin-pixel` / `.px-*` / `.toast.px-dialog`. |
| Settings card | `dashboard.html` `#pixelModePanel` | Settings > Appearance, under My Skin. Three switches: skin, scanlines, dialog notifications. |
| Home host | `dashboard.html` `#homePixelParty` | Hidden unless the skin is on. |
| Tests | `tests/pixel-mode-2026-10-11.test.js` | Logic (with boundaries), contracts, CSS gating. Break-tested. |

**Game word → CRM fact.** Nothing is invented:

- **HP** = `1 - daysSinceLastTouch / 14`, floored at 0. "Last touch" is the same
  max of `updatedAt` / `stageStartedAt` / `lastContactedAt` / `createdAt` that
  the No-next-step card uses. A lead with no timestamp shows HP unknown, never
  a made-up number. `COLD_DAYS` (14) is one constant in `pixel-logic.js`.
- **Overdue "!"** = the lead's own `followUp` date (local `YYYY-MM-DD`) is
  before today. Today itself is not overdue.
- **Party** = open leads (not deleted, not won/lost/job role) sorted closest to
  cold first, then by `jobValue`.
- **Trainer Card** level = `1 + floor(sqrt(signed this month))`; "signed this
  month" = won-role leads whose `stageStartedAt` (else `updatedAt`) is in this
  calendar month. Pipeline is labelled **projected** (sum of `jobValue` of open
  leads) — it is never presented as collected revenue.
- **Badges** are computed from real data (Clean Slate, Full HP, Closer,
  Rainmaker) plus any locked theme the user has actually earned via
  `ThemeEngine.isUnlocked` (Gold Rush, Road Warrior, …). Unearned themes are
  not shown as badges.

**Dialog-box notifications** are a standalone *Notification style* (any theme,
skin not required). `pixel-mode.js` watches `#toastContainer`, adds
`.px-dialog` to new `.toast` nodes and types the message out (55 chars/s). The
full text is kept in a visually hidden span, so a screen reader reads the
message once, not letter by letter. Reduce Motion (OS setting **or** the app's
`html[data-motion="reduce"]`) shows the text instantly and stops the ▼ blink.
`ui.js` is untouched. A manually created lead (`nbd:lead-created`) also opens
"A wild LEAD appeared!" with BOOK IT (opens the customer page) / TEXT LATER
(dismisses). It sends nothing.

**Privacy / invariants kept.**
- Setting lives on `userSettings/{uid}`, never `nbd_` localStorage (wiped at
  sign-out). `firestore.rules` already allows the owner to write that doc.
- No `innerHTML` anywhere in the new code; lead names go through `textContent`.
- All art is original (box-shadow house sprite); no image files, no third-party
  sprites, names or music.
- Fonts come from the already-allowed `fonts.googleapis.com` / `fonts.gstatic.com`
  (CSP `style-src` / `font-src`), requested only when something is on.
- Boot budget: +1 deferred tag (the ~3 KB loader), ceiling raised by one with
  the reason on the line (`tests/dashboard-boot-budget-2026-10-03.test.js`). The
  first version shipped the whole 18 KB as the boot tag and CI's byte ceiling
  (4.4 MB of LF bytes; `main` sat 9 KB under it) went red - hence the loader/core
  split. Note the test measures LF bytes on Linux; on a Windows CRLF checkout it
  reads ~4% higher and fails locally even on `main`.

**Known limits / next.**
- No pre-paint cache: the skin applies when the settings snapshot lands, so a
  reload can flash the normal UI for a moment. A `pxm_`-prefixed (non-`nbd_`)
  cache would fix it if it bothers anyone.
- The skin restyles the shared shell (panels, buttons, inputs, nav, toasts).
  Individual feature pages with heavy inline styles will only partly follow —
  the "L, every screen" part of the idea is intentionally not attempted here.

## E2 — Pixel World v1 (read-only town)

Playable v1 is built from scratch against the roadmap's L07 spec and Jo's
two Drive prototypes (`07-pixel-world.html` v1/v2: layout, area names and the
"no game assets" rule were taken from the concept; none of its code or art was
copied — the town's art is drawn here from small string patterns).

| Piece | Where | Notes |
| --- | --- | --- |
| Rules | `docs/pro/js/pixel-world-logic.js` (`NBDPixelWorldLogic`) | Map, collision, camera, deterministic placement, wander limits, hail flags, day/night tint, Lead Dex, gates, on/off switch. Pure, tested. |
| Game | `docs/pro/js/pixel-world.js` (`NBDPixelWorldGame.start(env)`) | Canvas renderer + HTML frame. Read-only: no Firestore write API, no network. |
| Frame | `docs/pro/css/pixel-world.css` | HUD chips, dialog, panels, touch D-pad. Theme tokens only. |
| Launcher | `pixel-mode-core.js` (`NBDPixelMode.open/close/world`) + the `pixel-mode.js` boot loader | Switch check, lazy assets, company flag read; the loader owns the layout-registry seam. |
| Tests | `tests/pixel-world-2026-10-11.test.js` | 82 checks incl. map connectivity, collision, placement, contracts. Break-tested. |

**Switch (default OFF).** On when the person opted in
(`userSettings/{uid}.pixelWorld.enabled === true`) **or** the company turned it
on (`companyProfile/{companyId}.pixelWorld.enabled === true`; `companyId` is the
`companyId` claim, or the uid for a solo owner). The company switch is writable
by the owner and `company_admin` only (that is the existing `companyProfile`
rule: owner + company_admin write, tenant members read); the Settings row is
hidden for everyone else. Nothing is downloaded until the switch is on AND the
person opens it.

**Entry points.** Settings > Appearance > Pixel Mode > "Open Pixel World", the
"ENTER TOWN" button on the Home Party card (skin on), and
`NBDPixelMode.open()`. The layout registry (lane "layouts") had not merged when
this was built, so there is a **seam**, not a hard registration: the
`pixel-mode.js` boot loader calls `window.LayoutRegistry.register({ id: 'pixel',
name, version, surfaces, tier, flag, enabled, load, mount, unmount })` if that
object exists at boot or when `nbd:layout-registry-ready` fires (inside a
try/catch, so a different `register` shape just leaves the Settings entry
point). The entry is thin: `load/mount/unmount` fetch the core on demand.
When the registry lands, confirm its `register` shape and the id/flag names.

**What the town shows (all real, all read-only).**
- Townspeople = the user's open leads, most-at-risk first (cap 40 on the map,
  the Leads Hall list shows up to 60). Red "!" = the lead's own `followUp` is
  before today; the bar over a head is HP (days before cold, 14).
- Leads Hall: the list. Estimate Workshop: estimate-stage leads + stage counts.
  Storm Watch Tower: leads whose coordinates fall in today's SPC hail-risk
  polygons (`StormOutlook.summarizeAt`; loaded lazily; "roof not verified").
  Bank: **projected** pipeline + signed this month (never called revenue).
  Trophy Hall: trainer card + the nine achievement themes with live
  `ThemeEngine.isUnlocked`. Office: overdue / about-to-go-cold.
- Achievement gates plug into `ThemeEngine.isUnlocked`: **Gold Vault**
  (Bank, needs Gold Rush) and **Summit Radar** (Tower, needs Road Warrior).
  Gates fail closed. `ThemeEngine.unlock` is not called by the game.
- Lead Dex numbers every lead oldest-first: SIGNED (won stage), MET (talked to),
  ??? (unmet, name hidden). "Met" is the only state the game stores
  (`userSettings/{uid}.pixelWorld.seen`, newest 400).
- Day/night tint from the real local clock; hail rain overlay only while an
  outlook polygon actually covers a lead.
- Talk dialog: facts, then CALL (a `tel:` link the person taps), OPEN LEAD.
  **DRAFT TEXT and MOVE STAGE are visible but disabled in v1.**

**Reduce Motion** (OS or `html[data-motion=reduce]`): townspeople stand still,
no "!" bob, no water shimmer, no hail particles, no typewriter. Walking (the
player's own input) is unchanged.

**Controls.** Arrow keys / WASD, Space / Enter / A, Esc / B, M. Touch D-pad +
A/B on `(pointer: coarse)` or width <= 760px. The Leads Hall panel is the
keyboard/screen-reader route to every lead (the canvas itself is `aria-hidden`;
dialog text goes to a polite live region).

**Bug found and fixed while verifying on a phone-sized touch device.**
`dashboard-app.css` has `@media (hover: none) { *:hover:not([style*="transform"]) { transform: none !important } }`,
which strips `transform` from every ancestor of a tapped element. A dialog
centred with `translateX(-50%)` jumped 183px sideways between `pointerup` and
`click`, so the tap landed on the canvas and nothing happened. Overlays in
`pixel-world.css` and `pixel-mode.css` now centre with `left/right:0; margin:auto`
(a test forbids `translate(-50%` in both files). Worth knowing for any future
overlay on `dashboard.html`.

**Not in v1 (next).** Write actions through existing modules (stage move with
the existing no-confirm rules, drafts into the drafts inbox — drafts only,
never auto-send), crew members on real routes, follow-ups as quests, XP from
closed jobs, per-region maps, seasonal events.

**Pre-existing red noticed, not touched.** `pro-demo-zero-network` fails on
`main` ("Money view labels revenue as collected money only"); reproduced on a
clean `origin/main` worktree, so it is not this work.

## E2b - Move stage from the town (drafts blocked, see below)

- **MOVE STAGE** in the talk dialog is live for non-viewers when the
  pipeline's `moveCard` exists. It offers the kanban arrows' two moves only:
  NEXT (the next stage that is not Lost) and BACK (the previous one). Losing a
  lead stays its own action on the lead card.
- It goes through the CRM's own `window.moveCard` (via `env.moveStage` in
  `pixel-mode-core.js`), so every existing gate still applies: role, the Lost
  reason sheet, required-field gate, the cancellation-window warning.
  `pixel-world.js` never calls `moveCard` or any Firestore write itself (test).
- The game asks YES / NO inside its own dialog (never `window.confirm`, which
  the installed PWA auto-answers), then judges the result from the lead's
  stage afterwards, because `moveCard` returns nothing reliable on refusal.
  A refusal says what usually blocks it and offers OPEN LEAD. A success offers
  UNDO (moves back through the same path). HP refreshes, since a stage change
  restarts the lead's clock.
- Pure rules: `adjacentStages` / `moveOutcome` in `pixel-world-logic.js`
  (tested, break-tested).
- **DRAFT TEXT stayed disabled in E2b, deliberately** (built in E2c below). `agent_inbox` has
  `allow create: if false` in `firestore.rules`; drafts are written only by
  the server (`crmMcp` / `agent-mcp.js`). A client "draft into the inbox"
  needs a new callable that runs the same consent / quiet-hours / STOP / claim
  wording checks, plus rules and emulator tests. That is a functions change,
  not a client slice, and nothing here may auto-send. Left for its own PR.

## E2c - DRAFT TEXT through a server callable (2026-10-11)

The blocker above is closed by a new callable, `fileLeadTextDraft`
(`functions/pixel-draft.js`, pure half `functions/pixel-draft-logic.js`). It
follows the shape of Storm Mode's `fileStormDrafts` (same inbox item,
same `buildTextDraft` / `textGate` / `claimWordingProblem` helpers from
`agent-mcp-logic.js`), with a per-lead role check instead of owner-only.

**Guarantees (all proved in `tests/pixel-draft-2026-10-11.test.js`):**

- **Never sends.** It files one `draft_text` (status pending, bot "Pixel
  World") into the caller's company `agent_inbox` and writes no `sms_log`.
  The owner sends from the Agent inbox; `agentDraftAction` `sent` re-checks
  STOP / Do Not Text / consent / texting switch / texting hours (8am-9pm,
  homeowner time) exactly as for bot and Storm Mode drafts.
- **No client words.** Input is `{ leadId, template }`; `template` must be one
  of `followup`, `estimate_check_in`, `appointment_reminder`,
  `thanks_after_job` (own-property check, so `__proto__` fails). The body is
  the template line plus first name and company name, then the STOP line.
  Extra fields (body, phone, companyId) are ignored.
- **Claim wording.** No template line can contain claim / insurance / adjuster
  / coverage / deductible / advance / deposit / waive / rebate / assignment /
  price words (a tested filter with positive controls), and every finished body
  passes `claimWordingProblem`. This holds for every lead, not only Kentucky
  insurance jobs, so there is no per-lead branch that could be missed.
- **Who.** Signed-in company member. Refused: signed out, anonymous, viewer,
  access-code member. A sales_rep only for a lead they own; owner,
  company_admin, manager (and platform admin) for any lead of the company.
  Only the owner and company_admin can see the Agent inbox, so the answer
  tells a manager or rep the draft waits there for the owner or an admin.
- **Tenancy.** The lead must be the caller's company's (companyId or userId),
  not deleted, not test data. Anything else answers one `not_on_board`, so
  another company's lead id reveals nothing.
- **Skips (answered, never filed):** no textable phone, declined texting on
  the form, STOP register, company Do Not Text list, register unreadable
  (fails closed), company has no name on its profile, lead unreadable
  (`unavailable`).
- **Idempotent.** Item id `pxd_<template>_<lead>_<company-local day>` via
  `create()`: a double click, second tab or teammate files once and the repeat
  answers `already_filed`. 60 drafts an hour per uid (`resource-exhausted`).
- **No PII** in the item beyond what every draft carries (lead id), in the
  answer, or in logs (template key and outcome only).

**Game side.** `pixel-world.js` shows DRAFT TEXT enabled for non-viewers with a
phone; picking it opens a menu of the four templates (labels in
`pixel-world-logic.js` `DRAFT_TEMPLATES`, parity-tested against the server's
keys), calls `env.fileDraft(leadId, key)` (`pixel-mode-core.js` `callFn`, the
same lazy Functions SDK plumbing as `agent-inbox.js`), and shows
DRAFT FILED / ALREADY FILED / NOT ALLOWED + the server's reason / COULD NOT
FILE. Every outcome says "Nothing was texted"; none says sent. The game still
has no Firestore write, no network and no innerHTML (existing contract tests).

**Deploy.** Functions need a deploy for the callable to exist; until then DRAFT
TEXT answers COULD NOT FILE (the client fails soft). No rules change.
`viewer-callables.test.js` classifies it `role-gated`.
