# Record button (2026-11-07)

The full-width visit-recorder pill bar over Home (`#nbd-vr-bar`: Record visit,
Recent visits, Unfiled visits (n)) covered the Today list's Attach / Keep /
Discard buttons. Joe approved a replacement on 2026-11-07 from a clickable
mockup (local: `C:\Users\jonat\nbd-mockups\record-button-2026-11-07\record-button-mockup.html`).
This note records what was built and why.

Builds on [VISIT-RECORDER-PR1-2026-10-13](VISIT-RECORDER-PR1-2026-10-13.md).

## What it is

- **Button:** a 56 px circle in `var(--orange)` with a white record dot (red
  centre). Light shadow (`--ui-elev-3`), no label. `#nbd-vr-fab` holds `.nbd-vr-fabbtn`.
- **Where:** bottom-left. On phones it sits just above the 62 px bottom nav
  plus the safe area (`bottom: calc(62px + 14px + safe-area)`). On a desktop it
  sits `left:24px; bottom:24px` over the sidebar's foot, and the sidebar gets
  96 px of bottom padding so its last item scrolls clear. Bottom-right stays
  with the field-tools dial, Add Lead and the Photos shutter.
- **Badge:** while closed, a red count of unfiled visits. No badge at zero.
- **Menu** (`docs/pro/js/visit-recorder-menu.js`, an ARIA menu button):
  slides up and to the right. From the top: "Unfiled visits (n)" (only when
  n > 0), "Recent visits", then "Record visit", the biggest pill and nearest
  the thumb. Recent and Record carry the same `data-nbd-recent-visits` /
  `data-nbd-record-visit data-source="fab"` attributes as every other entry
  point, so the launcher's one click delegate handles them. Unfiled calls
  `NBDVisitRecorderLauncher.openUnfiled()`. They open the same sheets as before.
- **Closing:** a tap on the light dim (closed on its click, not pointerdown,
  so the tap can't fall through to a Today button), a press on anything above
  the dim, Escape, the button again, or a pick. Focus goes to the first item;
  arrows, Home and End move; Escape, the button and a pick return focus to it.
  Tab closes and lets focus move on.
- **Open stacking:** open, the button + menu go to z-index 10011 and the dim
  to 10010, above the bottom nav, toasts and the sample account's strip
  (10008), which covered the Record pill at 360 px. Closed, the button is 900.
- **Hidden:** while recording (`body:has(.nbd-vr-live)`; the red live bar is
  unchanged), while a recorder sheet is up (`body:has(.nbd-vr-scrim)`), while
  the phone keyboard is up (`html.nbd-kb-open` from keyboard-viewport.js), and
  with the other FABs when `fab-stack-coordinator.js` sees a blocking modal
  (`'nbd-vr-fab'` in its `FAB_IDS`).
- **Screens:** every dashboard screen in Classic and Bento (the old bar was
  Home only). Not on the customer page, where the quick-action bar keeps
  Record visit (the button mounts only where `#view-home` exists). Not in
  Island, Field, Focus, Inbox, Mission or Crew, which have their own Record entry.
- **Later, not now:** long-press to start recording right away.

## The script budget

On main (f68682cf) the dashboard's shipped local JS sat 76 bytes under its
2856 KB ceiling (`tests/dashboard-boot-budget-2026-10-03.test.js`). The menu
therefore lives in a new lazy file, loaded with the recorder through the
launcher's `FILES` list, and the boot launcher only draws the button and
badge. Shipped local JS went **down** 342 B (headroom 76 B to 418 B). No
ceiling was raised.

## Tests

- `tests/record-button-2026-11-07.test.js` runs the real launcher and menu in
  a small fake DOM: button, badge, layouts, menu order, focus and keys, every
  way to close, and all three old actions reaching `NBDVisitRecorderUI`
  (`begin` with source `fab`, `openRecent`, `openUnfiled`), plus CSS, the
  coordinator and boot-budget wiring. Twelve mutations to the code were each
  caught.
- Updated to the new button: `crm-layouts-home-record-2026-10-15`,
  `visit-recorder-2026-10-13`, `visit-recorder-home-clearance-2026-10-21`,
  `audit-pass1-leftovers-2026-10-24`, and the E2E specs
  `e2e/visit-recorder.spec.js` (tap the button, pick from the menu) and
  `e2e/layout-island.spec.js`. The E2E specs were not run locally: they need
  the authed emulator rig.

## Checked in a browser (sample account, `/pro/explore`)

- 360 and 412 px, nbd-original and Paper (light): button 56x56, menu items
  48 px (Record 56 px), no sideways scroll on Home, CRM or Calendar.
- Real picks: Record visit reached the recorder (the browser pane blocks the
  mic, so it showed "Not recording"). Recent visits and Unfiled visits opened
  their sheets. Escape and arrow keys behaved as specified.
- Desktop 1280 px: the button sits over the sidebar foot and the last sidebar
  item clears it. Bento shows it, and Island hides it.
- Not checked: a real iPhone (keyboard, safe area), and a live recording's
  red bar on a device with a microphone.
