# Session 2026-11-14: NBD OS polish and the 20-finding review

Four stacked draft PRs. They merge in order, one at a time, with a deploy check between each, after the CRM security merge run:
#3046 → #3047 → #3048 → #3049.

Every fix has a test that failed before the change. Every PR had `silent-failure-hunter` run on its diff, and its findings were fixed in a follow-up commit, each with a failing-first check.

## #3046: the two reported bugs, plus polish

**Loading screen showed a solid orange square.**
- The boot and lock mark painted before the company profile loaded, so the letters tile was empty.
- It is now the company's logo, else its letters, else the NBD Pro app icon.
- The platform tenant gets NBD's logo by identity. Any other company gets only its own raw `brand.logoUrl`.
- A logo that fails to load stays failed, with no flicker loop.
- Test: `tests/nbd-os-boot-mark-2026-11-14.test.js`.

**Close only re-centred the window.**
- `closeWin` left `.view.active` on the closed view.
- `release()` then changed that view's class, and the router MutationObserver read the change as a route and reopened the window at the first cascade slot.
- It only happened when no other visible window took focus.
- Test: `tests/nbd-os-close-window-2026-11-14.test.js`. It installs a MutationObserver in the harness, which had none.

**Polish** (`tests/nbd-os-window-polish-2026-11-14.test.js`):
- Start: Enter now opens an app.
- Pinning an app keeps Start open and keeps keyboard focus.
- No stale active view after minimising, switching desk or moving a window.
- Focus after close or minimise goes to the next window, else Start.

## #3047: six bugs from the review (`tests/nbd-os-review-bugs-2026-11-14.test.js`)
1. **An empty desk stays empty on reload.** The state saves `idle: true`, and the closed app's route hash is cleared. A deep link (`#/crm` or `#crm`) still opens its app, and it wins over the saved front window. The hash is read before restoring, because hydration rewrites it.
2. **Resizing a snapped window works.** It starts from the snapped rect and leaves the snap.
3. **Resizing past the right or bottom edge** now stops at the edge instead of sliding the window.
4. **The Control Center keeps keyboard focus** across its repaints.
5. **Opening an app focuses its window.**
6. **A touch device whose screen short side is 500px or less gets the phone surface.** This lives in `layout-system.js` `surfaceFor`. Reading the screen rather than the viewport means a tablet's keyboard can't trigger it.
   - The taskbar also gets a safe-area inset.
   - The rule is **not** mirrored in `shape-preboot.js` or `island-job.js`. The boot-budget gate had 20 and about 10 shipped bytes free there, so a phone on its side may paint the desktop's first frame before the engine corrects it.

## #3048: eleven rough edges (`tests/nbd-os-review-rough-edges-2026-11-14.test.js`)
- **Show desktop** puts back only the windows it hid, tracked per desk.
- **Window memory:** each app reopens at its last free size and place (`rects` in the saved state, kept through a phone visit), and new windows take a free cascade slot.
- **Size floor:** windows are drawn at least 320×240px, applied to the drawn rect, not CSS.
- **Right-click** opens a menu (Open, Pin/Unpin, Close). The pin limit warns.
- **Start:** search opens with the typed text, and arrow keys work.
- **Saving:** a pending save is flushed on `pagehide` and when the tab is hidden.
- **Touch:** sizing uses `any-pointer: coarse`.
- **Start mark:** the Start button shows the company mark.
- **Apps:** the app list is re-read when the claims land.
- **Desk menu:** `aria-expanded`, toggles closed, Escape returns focus, arrow keys work.
- **Do Not Disturb** is off after the kill switch.

## #3049: three nice-to-haves (`tests/nbd-os-review-nice-to-haves-2026-11-14.test.js`)
- **Shortcuts:** Ctrl+Alt+] and Ctrl+Alt+[ cycle windows. Ctrl+Alt+W closes the front one, ignoring key repeat and AltGr. Cmd+K has "Close all windows". Middle-click on a taskbar button closes it.
- **Router observer** watches each view's `class` attribute instead of the `.content` subtree.
- **Drag** paints once per animation frame.
- **Control Center tiles** register on `nbd:os-system-ready` instead of a 30 s poll.
- **First click:** a press in a background window raises it at once and routes after the press.

## Decisions
- Joe accepted every product choice above (2026-11-14):
  - an empty desk stays empty
  - a sideways phone gets the phone layout
  - apps reopen at their last size and place
  - the right-click menu
  - the shortcuts
- Still Joe's call: raising the boot budget by about 1 KB per page, so the pre-paint scripts can mirror the landscape-phone rule.

## For the next session
- **Harness:** `tests/lib/nbd-os-home-harness.js` has no MutationObserver and no `:not()` selector. Router-driven behaviour needs a fake observer in the test, and code under test should filter disabled items in JS.
- **Boot budget:** `shape-preboot.js` (blocking) and anything on `customer.html` sit within a few bytes of the shipped-byte ceilings in `tests/dashboard-boot-budget-2026-10-03.test.js`. Measure shipped bytes before touching them.
- **Pocket shortcut:** Pocket owns Alt+`, and `tests/nbd-os-pocket-2026-11-09.test.js` fails if `os.js` binds Backquote.
