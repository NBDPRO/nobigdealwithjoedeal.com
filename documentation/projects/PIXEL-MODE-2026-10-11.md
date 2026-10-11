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
| Skin + wiring | `docs/pro/js/pixel-mode.js` (`window.NBDPixelMode`) | The only boot tag. Reads `userSettings/{uid}.pixelMode`, stops if everything is off. |
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
- Boot budget: +1 deferred tag, ceiling raised by one with the reason on the
  line (`tests/dashboard-boot-budget-2026-10-03.test.js`).

**Known limits / next.**
- No pre-paint cache: the skin applies when the settings snapshot lands, so a
  reload can flash the normal UI for a moment. A `pxm_`-prefixed (non-`nbd_`)
  cache would fix it if it bothers anyone.
- The skin restyles the shared shell (panels, buttons, inputs, nav, toasts).
  Individual feature pages with heavy inline styles will only partly follow —
  the "L, every screen" part of the idea is intentionally not attempted here.
