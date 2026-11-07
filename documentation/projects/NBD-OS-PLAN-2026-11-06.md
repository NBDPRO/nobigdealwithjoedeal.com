# NBD OS: make the CRM feel like a full operating system (plan, 2026-11-06)

Jo's ask: "make the CRM seem even more like a full OS than just a program".

Jo's answers on 2026-11-06:
- **All four feels**, "and more": desktop and windows, a phone home screen, an OS system layer, and boot/polish.
- **Both devices equally.**
- **For every tenant**: "how the entire system works as a whole".
- **A layout, never forced:** "we have so many styles and layouts, to force one would be a fallback in design".

Jo then asked for all phases to be written out first and worked through
without check-ins until done.

## Update, 2026-11-07: on for everyone, nothing dark

Joe: "i want to completely turn it on live nothing dark", for every tenant.
The flag sections below are history; what is true now:

- **Both flags are on by default.** `layout-system.js` reads `osLayout` and
  `osSystemLayer` as on unless `feature_flags` sets them to exactly `false`
  (live, and from the per-account cache before the flags load). With nothing
  written anywhere, every tenant gets the system layer (tray, Control Center,
  Notification Center, Spotlight, boot and lock screens) over whatever layout
  they use, and NBD OS is in every layout picker. It is still a layout, picked
  like any other, never forced.
- **Kill switch, no deploy:** write `osSystemLayer: false` and/or
  `osLayout: false` in `feature_flags/_default` (everyone) or one uid's doc.
- **Record visit lives in the OS** (Joe's pick): a Record visit button on the
  taskbar and a Visits group at the top of the Start menu on a laptop; Record
  in the bar after Home and a Visits row on the home screen on a phone. The
  unfiled count rides on Record as a badge. The floating round record button
  (PR #3009) stays Classic/Bento only: in NBD OS its corner is the Start
  button. Tests: `tests/nbd-os-visits-2026-11-07.test.js`.
- Checked in the sample account at 1280 px and 360 px, nbd-original and Paper
  light: all three visit apps open the right sheet, none opens a window.
  Still not tried on a real iPhone.
- The boot-size ceiling raise (2864 KB) that this PR carries is approved with
  it; measured 2859 KB.

## Status, 2026-11-06 (end of the build session): all six phases built, dark

Every phase below (0 to 5) is built and committed on `feat/nbd-os-plan`, one
commit per phase. Nothing is on for anyone until Jo flips a flag.

**To try it** (Firestore console, `feature_flags/{your uid}` first, then `_default`):
1. `osSystemLayer: true` turns on:
   - the tray in the header
   - Control Center and Notification Center
   - Spotlight entries
   - the boot screen and lock screen

   This applies over whatever layout you use.
2. `osLayout: true` puts **NBD OS** in Settings, then Appearance, then Layouts. Pick it there:
   - on a laptop: the desktop, windows, Overview, desks and shelf
   - on the iPhone: the home screen, dock bar and app switcher

**What was verified, and how:**
- **Node tests.** Four new suites:
  - `nbd-os-flags` (20)
  - `nbd-os-system` (65)
  - `nbd-os-layout` (87)
  - `ci-manifest` entries for all three

  Each escaping and guard check was break-tested: mutate the code, watch it fail, restore.
- **Existing suites still green:** layout system and layouts, theme contract and contrast, boot budget (unchanged: the system layer is a lazy ScriptLoader load, not a `<script>` tag), inline-style ratchet, UI foundation and font consistency.
- **Browser harness** (scratchpad, not committed). It runs the REAL `layout-system.js` engine with stubbed Firebase. Checked:
  - at 1024 px, 375 px and 360 px
  - in nbd-original (dark) and paper (light)
  - opening, snapping (drag and keyboard), minimising and closing windows
  - reload restore, and going back to Classic (every view returns to `.content` in its original order)
  - phone apps, the switcher and edit mode
  - crossing the phone breakpoint
  - lock and auto-lock, the boot screen, desks, Overview, pins, all three button styles
  - no sideways scroll and no tap target under 44 px on the phone
- **Not verified:**
  - Against the live dashboard with real auth and data (the harness stubs both).
  - On a real iPhone: long-press timing, swipe-up on the bar, the safe area.
  - The Playwright suites (`ds-layouts-phone-fit`, visual) don't run in this checkout because Playwright isn't installed here.

  Jo's daylight iPhone check is the next step, before turning the flags on for anyone else.

**Things a reviewer should know:**
- A window holds the real `#view-<id>` node. Views that assume they're the only visible one can show stale data in a background window until it's focused: focusing a window calls `goTo(id)`, which re-runs the view's own refresh.
- The layout follows the CRM's router. It watches which `.view` gets `active` and reacts only to a view's class changing, so `goTo()` stays the one router. That filter fixed a real bug found in testing: the layout's own desk changes were being "routed" back.
- Auto-lock is a privacy cover, not security. It's off by default, and sign-out is unchanged.
- The lock screen shows counts only.
- System sounds are off by default.
- Per-member state (windows, desks, pins, icons, dock, recents) goes in `userSettings/{uid}.layout.layoutState.os`. It's normalised and well under the registry's 12 KB cap. DND, auto-lock, sounds and button style are this device's own (localStorage).

## Shape of the solution

Two things, deliberately separate:

1. **The System layer**: OS plumbing that sits over *every* layout (Classic, Field App, Mission Control, the other six, and NBD OS). This is the "deeper and more complex all around" part. Nobody's arrangement changes.
2. **The NBD OS layout** (`os`): a tenth layout in the picker.
   - On a laptop: a desktop with windows.
   - On a phone: a home screen with an app switcher.
   - It's chosen like any other layout, so the precedence rule (company lock > user > company default > Classic) is unchanged.

Both ship **dark behind feature flags**. Claude can't write prod flags, so Jo
flips them in the console:

| Flag (`feature_flags/_default` or per-uid) | Turns on |
|---|---|
| `osSystemLayer` | The tray, Control Center, Notification Center and Spotlight actions, over every layout |
| `osLayout` | NBD OS appears in the layout picker and can be resolved |

With both flags off, the dashboard is byte-for-byte today's: nothing loads.
The system layer is a **lazy ScriptLoader bundle**, not a `<script>` tag, so
`tests/dashboard-boot-budget-2026-10-03.test.js` doesn't move.

### Ground rules every phase follows

- **CSP:**
  - External files only: `docs/pro/js/os/*.js`, `docs/pro/css/os/*.css`, `docs/pro/js/layouts/os*.js`, `docs/pro/css/layouts/os.css`.
  - No inline `<script>`, `on*=` or `style=""` attributes; delegated listeners only.
- **Theme tokens only** (`--bg --s --s2 --s3 --br --t --m --orange`, `--ui-*`):
  - no hex literals
  - durations from `--ui-dur-*`, so reduced motion turns all of it off
  - radii from `--ui-radius-*`
  - elevation from `--ui-elev-*`
- **Phone floor:** 44px tap targets, no text under 11px, no sideways scroll at 360/412px.
- **Multi-tenant:**
  - App icons come from the live sidebar (`#nav-<id>`), so role-hidden views stay hidden.
  - The brand mark is the tenant's own (company profile logo, else initials). Nothing NBD-specific is hard-coded.
  - Per-user state lives in `userSettings/{uid}.layout.layoutState.os`, which the registry already bounds to 12 KB.
- **Read-only shell:** the OS sends nothing and writes no CRM data. Every action calls an existing function (`goTo`, `openLeadModal`, `NBDCommand`, the away-mode toggle…).
- **Pure logic is require()-able** and unit-tested in Node (`*-logic.js`); the DOM half stays thin.
- **Escape everything** that reaches `innerHTML` (lead names come from public forms).

## Phase 0: flag-gated layouts (registry)

- **Change:** `LayoutRegistry.register()` accepts `flag: '<name>'`. A flagged layout is left out of `forSurface()` / `list()` for the picker, and fails `resolve()`'s `usable()`, unless `NBDFlags.enabled(flag)`.
  - The registry stays pure: the engine passes an `isFlagOn(name)` predicate, and the registry gets `listVisible(surface, isFlagOn)`.
- **Verify:**
  - New tests: a flagged layout is hidden or resolvable by flag.
  - A user whose saved choice is a now-unflagged layout falls back by the normal rule.
  - Existing `layout-system` tests stay green.

## Phase 1: the System layer (over every layout)

Files:
- `js/os/system-logic.js` (pure)
- `js/os/system.js` (DOM)
- `css/os/system.css`

Loaded by the layout engine through ScriptLoader once auth and the flags have
loaded, only if `osSystemLayer` is on.

1. **Status tray**: a compact cluster at the right end of the header (desktop) and a slim status strip on phones. It shows:
   - **sync**: online / offline / "N photos waiting", from `NBDOfflineSync`
   - **notifications**: the unread count, from `NotifBell.getCount()`
   - **storm watch**: when an active hail or wind alert is cached
   - **away mode**
   - **the current layout**
   - **the clock**
   - Each item is a button that opens the panel it belongs to.
2. **Control Center**: one sheet (a bottom sheet on phones) of quick switches wired to what already exists:
   - away mode
   - layout (opens the existing picker)
   - light/dark theme flip (ThemeEngine)
   - glove mode / tap size
   - reduce motion (`data-motion`)
   - Pixel Mode
   - Do Not Disturb (holds non-error toasts in the Notification Center instead of popping them; error toasts always show)
   - sunlight mode, where the layout supports it
3. **Notification Center**: a side sheet with today's notifications grouped by source (leads, estimates, tasks, portal, system). It also keeps:
   - a **history** of toasts from this session, so a missed toast can be read later
   - "Mark all read" and "Clear", reusing `markAllNotificationsRead` / `clearAllNotifications`
   - `notif-bell.js` gains a read-only `NotifBell.items()` export
4. **Spotlight actions**: system actions registered into the existing Cmd+K palette (`NBDCommand.registerAction`):
   - open any app (view) by name
   - "Open Control Center", "Notification Center"
   - "Switch layout to …"
   - "Toggle away mode", "Do Not Disturb"
   - "Lock screen" (Phase 4)
   - Spotlight stays the one search; we don't add a second palette.
- **Verify:**
  - Node tests for the tray state, DND queue and action list.
  - A browser check of the panels at 1280 and 375 px in `nbd-original` plus one light theme.
  - Boot-budget test unchanged.

## Phase 2: NBD OS on laptop and tablet (desktop and windows)

Files:
- `js/layouts/os.js`
- `js/layouts/os-wm-logic.js` (pure window manager)
- `css/layouts/os.css`

1. **Desktop**: wallpaper (the theme's overlay or `--bg` glow), app icons in a grid, arrangeable and saved. A desktop widget column holds Today and the clock.
2. **Windows**: every app (view) opens in a window with a title bar, minimise, maximise and close.
   - Windows can be dragged (pointer events) and resized (bottom-right handle plus edges).
   - They snap to left/right halves and quarters by dragging to an edge, and double-clicking the title bar maximises.
   - z-order follows focus. Several windows are visible at once; a window shows the real `#view-<id>` element, moved into the frame and restored on unmount.
   - Focusing a window calls `goTo(id)` so the view's own refresh logic runs, while windowed views stay visible.
3. **Taskbar**:
   - a Start button: the app list plus search, which hands off to Spotlight
   - running apps, with the focused one marked
   - the system tray from Phase 1, when it's on
   - "show desktop"
4. **Keyboard**:
   - every window control is a real `<button>`
   - Esc closes the Start menu
   - Ctrl+Alt+arrows snap the focused window (the combo is checked against the existing hotkeys so it eats no keystrokes in inputs)
5. **Persistence**: window rectangles, open apps and the icon order go in `layoutState.os`, clamped to the screen on restore. Bounded so it never exceeds the registry's 12 KB.
- **Verify:**
  - Node tests for snap geometry, clamping, z-order and the state size bound.
  - A browser check that two windows can sit side by side, survive a reload, and that unmount puts every view back where it was.

## Phase 3: NBD OS on phone (home screen and app switcher)

Same `os` layout; the phone surface gets its own shape in the same files.

1. **Home screen**: pages of app icons (CSS scroll-snap, swipe between pages, page dots).
   - Page one starts with a widget row: today's count, the next appointment, sync.
   - The dock holds four apps: by default the user's mobile-nav tabs, falling back to Home / Pipeline / Schedule / Messages.
2. **Open an app**: it fills the screen (the real view), with a thin "home bar" at the bottom.
   - Swipe up on the home bar, or tap it, to go home.
   - Long-press it for the **app switcher**: recent apps as a horizontal card stack. Tap to switch; swipe a card up to close it.
3. **Edit mode**: long-press an icon to move icons and dock slots. Saved to `layoutState.os.phone`.
4. One-thumb reach: the dock and home bar sit at the bottom; the icon grid is 4 columns with 64px tiles at 360px.
- **Verify:**
  - Node tests for paging, the recent-apps list and the dock defaults.
  - Browser checks at 360 and 412 px: no sideways scroll, every tap ≥ 44px.

## Phase 4: session, lock screen, Settings app and polish

1. **Boot sequence**: the first dashboard load of a session shows the tenant mark, "Starting {Company}…" and real progress (auth → data → ready), then fades out.
   - It is never longer than the real load, and it's skipped on reduced motion.
   - It reuses the existing loader (`dashboard-loader-fadeout.js`) rather than adding a second one.
2. **Lock screen** (privacy screen, not security): after N idle minutes (off by default, set in Control Center) or "Lock screen" in Spotlight, a full-screen cover hides the CRM. It shows:
   - the time and date
   - the tenant mark
   - counts only: "3 appointments today · 2 unread"
   - **no customer names**
   - A tap or a key unlocks it. A real sign-out stays the existing sign-out.
3. **Settings app**: in NBD OS, a "Settings" app whose sidebar lists every settings tab the dashboard already has, as one place. Each entry opens the real tab (`goTo('settings', { id })`). Nothing is duplicated.
4. **Polish**: opt-in system sounds through the existing theme sounds (off by default), window open/close motion on `--ui-dur-*` tokens, and wallpaper from the theme overlay engine.
- **Verify:**
  - Node tests for the idle timer, the lock-screen text (no PII) and the settings index.
  - A browser check of the boot and lock screens on phone and desktop.

## Phase 5: the best of Linux, ChromeOS and macOS (added 2026-11-06)

Jo, mid-build: "take inspiration from all 3: Linux, ChromeOS, macOS". This
phase covers the features the three systems share, in our tokens:

1. **Overview**: one view of every open window as a tile, the same idea as macOS Mission Control, ChromeOS Overview and the GNOME Activities overview. Click a tile to focus it; Esc leaves. Entry points: a taskbar button, Spotlight, and Ctrl+Alt+Up when no window is focused.
2. **Virtual desks** (Linux workspaces, ChromeOS desks, macOS Spaces): up to 4 desks, each with its own windows.
   - Switch from the taskbar, from Overview, or with Ctrl+Alt+1-4.
   - Move a window to another desk from its title-bar menu.
   - A view lives on one desk at a time.
3. **Pinned apps**: the ChromeOS shelf and macOS Dock. Pin apps to the taskbar; a pinned app shows with or without a window, and running apps get a dot.
4. **Window-button style**, a Control Center choice:
   - **macOS**: round red, yellow and green buttons, top-left
   - **ChromeOS / Windows**: right-hand buttons (the default)
   - **Linux (GNOME)**: close only, top-right; double-click maximises
- **Verify:**
  - Node tests for desk assignment, pin order and the state bound.
  - A browser check of overview tiles, desk switching and each button style.

## Delivery

- **One branch, `feat/nbd-os-plan`**, with one commit per phase, each green on the cheap gates:
  - `check-js-syntax`
  - `check-inline-html-scripts`
  - the boot budget
  - the layout tests
  - the new OS tests
  - `smoke`
- **One PR** for all of it (CI is backlogged, so fewer pushes is better).
- It ships dark: Jo reviews it and flips `osSystemLayer`, then `osLayout`, per-uid first.
- This note is updated at the end with what was built, what was verified and what is left.
