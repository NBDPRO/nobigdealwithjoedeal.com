# SESSION 2026-11-09: NBD OS P3 (Pocket, Knock block, privacy lock, wallpaper palette, Saved view and Copy my setup, Nearby)

**Lane:** CRM / NBD OS. **Branch:** `os-p3` (worktree `.claude/worktrees/os-p3`, on top of `a0beb164b`), not pushed at the time of writing.
**Design:** [NBD-OS-HOME-DESIGN-2026-11-09](NBD-OS-HOME-DESIGN-2026-11-09.md) §6 (its "What shipped in P3" notes are at the top).
**Prior phase:** [SESSION-2026-11-09-nbd-os-p2](SESSION-2026-11-09-nbd-os-p2.md).
Everything here is dark behind `osLayout` (and `osSystemLayer` for the Control Center and lock screen), for every tenant. No P3 lane adds a Firestore rule, a callable, an index or a `<script>` tag.

## 1. What shipped (six lanes, each with its own fix round, then one integration pass)

- **Pocket** (`os/pocket.js`, `pocket-logic.js`, the `ospocket` bundle). A drop-down quick note over any window: Alt+`, a Control Center tile, Spotlight, and a page-1 icon on the phone. Notes stay on this device (`nbd_os_pocket:<uid>`, 20 notes, 2,000 characters) until filed through quick-capture.js's own writer (`NBDQuickCapture.review`, the one change there).
- **Knock block** (`os/focus.js`, `focus-logic.js`, the `osfocus` bundle; widget `focus`, Tools, S/M). A 30, 60 or 90 minute canvassing block started by hand: Do Not Disturb on (and back only if the block turned it on), doors counted from the knocks index (`ds-business.js countKnocks`), a record that survives a reload (`nbd_os_focus`), and the `nbd:knocks-changed` event from the D2D tracker.
- **Privacy lock** (`os/privacy.js`, the `osprivacy` bundle). A hot corner (top right, bottom right or bottom left; never top left), Ctrl+Alt+L on both surfaces, and an opt-in double tap on empty phone home space. `system.js lock()` now covers an open modal sheet, holds through Escape and a closing sheet, and says how it locked.
- **Wallpaper palette** (`os/wallpaper-logic.js`, in the `oswp` bundle). A tenant's own My Skin picture tints the OS home surfaces (`--s`/`--s2` only, phone home and the desk's widgets, taskbar and Start), only when every text and accent pair keeps its contrast. NBD, documents, CRM windows and dialogs never change. A switch in the picker turns it off.
- **Saved view tile and Copy my setup** (`os/kpi.js`, `kpi-logic.js`, `oskpi`; `os/setup.js`, `setup-logic.js`, `ossetup`). A count of loaded leads matching one of the team's saved map views (`companyProfile.mapViews`), stored as an 8-hex view id (`cfgId`); and a text export / paste of the member's home (widgets, sizes, cells, wallpapers, modes; no leads, counts, money or URLs).
- **Nearby** (`os/nearby.js`, `nearby-logic.js`, `osnearby`; widget `nearby`, Tools, S/M/L). The member's leads nearest to one tapped position read (`getCurrentPosition`, never watched or stored), with Call and Navigate. A 20 s guard ends a read that never answers.

## 2. Integration (how the six lanes were joined)

- Cherry-picked in the order pocket, focus, privacy, pywal, kpisetup, nearby: 54 lane commits, every one kept. The conflicted ones carry an `Integration:` line in their message.
- Conflicts and how they were resolved, keeping both lanes each time:
  - `FLOORS` in `scripts/run-test-manifest.js` on nearly every lane's manifest commit: each pick adds its lane's suites to the count so far.
  - `layouts/os.js` `CONTROL_IDS` and `registerControls`: Pocket, Privacy lock and Copy my setup tiles all registered.
  - `os/home-logic.js` catalog and `ORDER`: `focus`, `kpi`, `nearby`, all in Tools. `os/home.js`: three lazy bundles, three events, three `WIDGETS` entries, the retry and tap paths for each, and a home kit that carries both `locked` (Saved view) and `announce` (Nearby).
  - The bundle-count pins in the coach and home suites move from 9 to 11 `loadBundle(` calls and name all three bundles.
- Reconciliation commits (`fix(pro): NBD OS P3 integration, …`), test first where it was a real bug:
  1. **os-home max fill.** The acts max-fill test now builds one home with every P3 field at once (Saved view ids, Knock block, Nearby, four full modes, wallpapers, `tint:false`): 6,187 chars, a theoretical bound of 9,028, under the 12,000 budget.
  2. **Pocket respects "In a home".** A kept note or a draft can name another customer. While the mode is on, Pocket shows only how many notes are kept and leaves the earlier draft unread and unwritten (a new draft stays in page memory); Keep still works. 8 assertions red before, green after.
  3. **The cross-lane suite** `tests/nbd-os-p3-integration-2026-11-09.test.js`: no shortcut collisions (Alt+`, Ctrl+Alt+L, the desk's Ctrl+Alt O / 1-4 / arrows, Ctrl+K), the lock never uses the runner's top-left corner, one registration per bundle name, the os layout's `needs` list unchanged, the Tools group, "In a home" never loading or painting Nearby, the palette never reaching NBD or documents, all three Control Center tiles at once. FLOORS 1002/74/1136 measured with `--check`.
  4. **Saved view and Knock block M on the one-column desk.** Below 1100px the desk gives each widget a 96px floor: at 1000px the Saved view M's Change view / Pick a view was cut in half and the Knock block M lost its "Do Not Disturb goes on" line. Both keep a 160px row now, as Nearby and Up Next with Peek do.

## 3. Checks against the brief

- **Layout `needs`:** unchanged (it is full). Every P3 file loads as a runtime ScriptLoader bundle: `ospocket`, `osprivacy`, `oswp` (now with `wallpaper-logic.js`), `ossetup`, `osfocus`, `oskpi`, `osnearby`. No duplicate names.
- **Keyboard:** Alt+` Pocket (not on the lock screen), Ctrl+Alt+L lock, the desk's Ctrl+Alt family, Ctrl/Cmd+K palette. No two match. The three widgets are reached by Tab (their actions are buttons).
- **Hot corners:** the runner's is top left; the lock offers only the other three and a stored `tl` reads as off.
- **Tokens:** the palette needs a known non-NBD identity, no company-enforced My Skin background and the member's switch on; its CSS rule is scoped to `[data-os-pal][data-os-wp="img"]` on the home surfaces only.
- **"In a home"** (a phone mode; the laptop's workspaces carry job phases only): Nearby is hidden and never loaded (`names: true`); the Saved view tile and the Knock block show counts only; Pocket hides kept notes (item 2 above).

## 4. Gates (final run on the integrated branch)

- `check-js-syntax`, `check-site-integrity --quiet`, `check-inline-html-scripts`, `apply-partials --check --diff`, `check-vault-index`, `run-test-manifest --check`: clean.
- `run-test-manifest --bucket node`: 1002/1002. `tests/smoke.test.js`: 4434 passed, 0 failed.
- `dashboard-boot-budget-2026-10-03`: 36 passed. Shipped bytes against `a0beb164b`: dashboard local scripts 2,626,158 → 2,626,826 (+668: quick-capture.js `review`, command-palette.js's Pocket action, maps-core.js's ready event), blocking unchanged at 87,019; customer page 1,374,197 → 1,374,794 (+597, the same shared files).
- Emulator rules suites (no P3 rule changes; run because the lanes read these blocks): company-docs 47/47, os-company-home 33, os-daily-goals 40, os-team 41, os-coach-ai 47, canvassers 44, visit-captures PASS.
- Browser suites: crm-layouts-render 49, layouts-visual-audit 95, pro-demo-zero-network 126 (includes the Nearby demo walk).
- Screenshots: phone 390 and 320, laptop 1280 and 1000. Pocket over a window, a Knock block running and done, the lock by hot corner and by double tap, a tenant's tinted home against NBD's unchanged one, Saved view tiles, Copy my setup export and import preview, Nearby found and denied, and "In a home" with Pocket open. They are in the session scratchpad, not the repo.

## 5. Open items

- **Pre-existing, not P3** (seen in the screenshots, also on `a0beb164b`): on the phone, leaving the Pipeline app by Home leaves its sticky "Rita Okafor" card name and the view's FAB over the home screen; at 320px the top bar's logo and filter icon overlap; at 1000px At a Glance M clips its last lines; the NBD identity's Google reviews fetch shows the demo's "not in the sample account" toast.
- **At 320px the Visits row labels truncate** ("Record …", "Recent …") now that Pocket shares the row. Readable and in the lane's own shots; worth a look in the real-iPhone pass.
- **Double tap at 320px:** page 1 has no free cell once the P3 widgets fill it, so the empty space is the gap in the Visits row (verified to lock) or page 2.
- **Real-iPhone pass** for Pocket, the double tap and Nearby's location prompt is still open, as in P1 and P2.
- The browser suites ran through the Playwright launch shim in this sandbox (its Chromium build differs from CI's).

## 6. Update 2026-11-09: the final review round

- **"In a home" cannot be switched off by a paste.** `home-logic.js cleanAct` took each mode's `focus` from the stored or pasted record; Copy my setup let pasted text reach it (an `inhome` entry with `focus: {}` parsed, the preview listed only names). A mode's focus is now always its preset's (`ACT_PRESETS`, by id); the P2 normalize test that pinned the pass-through is flipped.
- **Copy my setup drops garbage instead of applying defaults.** `parse` keeps only the modes the text names and only the wallpaper surfaces that hold an id; `merge` applies wallpaper by surface and modes by id; the preview lists only what changes.
- **Alt+` waits while a modal `<dialog>` is open** (the sheet would sit inert under the top layer until it closed).
- **Spotlight's focus return passes `preventScroll`** (a global change to every palette close).
- **Saved view tile: Try again** when the company profile read never lands (`_ensureCompanyProfile` on a tap; a miss says so in words). An S tile uses a short line and drops its title on the phone row.
- Left as is (not defects): the Knock block's early-End window (documented trade-off, no number invented) and a taskbar button under the privacy hot corner (fails safe).
- Gates re-run: syntax, manifest `--check`, node bucket 1002/1002, smoke 4434, boot budget 36, rules emulator os-coach-ai 47, os-team 41, os-company-home 33, os-daily-goals 40, browser suites 49 / 95 / 126. New screenshots 15 to 18 (hostile paste preview, the pasted "In a home" on, the Saved view's Try again and its miss) in the session scratchpad.
