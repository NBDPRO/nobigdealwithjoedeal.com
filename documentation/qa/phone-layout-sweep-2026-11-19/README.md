# Phone layout sweep (2026-11-19)

Jo asked for a UI/UX sweep of every CRM layout at emulated phone size, since the phone is the most used format.

**Method.** Authed emulator rig, real Chrome, 393x852 at 2x with touch. All 9 registered CRM layouts (`LayoutRegistry.listAll()`: classic, field, crew, focus, bento, mission, island, inbox, os) applied through `LayoutEngine.apply`, then eight dashboard views each (home, crm, schedule, est, d2d, money, photos, settings): screenshots plus a probe for sideways scroll, elements past the edge, tap targets under 40 px and text under 11 px. 72 screens, zero page errors. Seed data only (empty tenant), so list-heavy states (many leads, long names) are not covered.

**Not covered yet.** The 8 Daily Success layouts (they have their own phone-fit gate, `ds-layouts-phone-fit-2026-10-25`), the customer record page, estimate builder steps, and the installed-app `display-mode: standalone` rules. iPhone WebKit cannot run locally.

## Headline

- No layout scrolls sideways, throws, or clips an element outside a scroller.
- Only **Home** differs between seven of the nine layouts. On CRM, Schedule and the other views, classic, bento, crew, focus, inbox, mission and os are pixel-identical. Only **Field** (bottom tab bar, no top bar) and **Island** (floating top nav plus bottom action pill) change the chrome on those views.
- `bento` and `os` Home look the same as Classic on a phone in this rig. Unverified whether that is by design (OS is behind the `osLayout` flag) or a mount that did not take; check before calling it a bug.

## Findings, ranked

1. **Overlays stack on the bottom of every layout.** The "Turn on appointment reminders" prompt sits over the lowest ~120 px on every view until dismissed, hides content, partly covers Island's Record visit pill, and its Not now is a small text link. The round red Record visit button (left, bottom) overlaps page content in Classic, Bento and OS: the same overlap on the Call/Text row in Jo's own screenshot. Needs one rule for what may sit at the bottom and a reserved bottom gutter.
2. **Island spends about 170 px of 852 on fixed chrome** (floating top nav plus bottom pill). On Schedule the pill covers the calendar's day controls, and the content starts with an extra gap under the nav.
3. **Classic-chrome views spend three rows before content**: top bar, a second breadcrumb row ("Home", "Schedule"), then a "Back to CRM" row on Schedule. The breadcrumb repeats what the bottom nav already shows.
4. **Field Home header clips at the right edge**: the chip row (Lead, Search, Sun...) runs past the edge and cuts the last chip.
5. **Menu chip orphaned on its own row** in Crew, Focus, Mission and Inbox: a lone Menu (and Refresh) button wraps under the header, wasting a row and reading as a stray control.
6. **Undersized tap targets, same offenders in all 9 layouts** (every one under 40 px; Jo's own target is 44): What's New bell 41x36, the user pill 38x36 (both on every view), Home hide button 36 wide, D2D map zoom buttons 30 wide, D2D layer toggle 93x36, Photos search box 37 tall and its "only with photos" checkbox 13x13, toast close buttons 20x20, Island's active tab 34 wide.
7. **Tiny text**: about 73 text elements under 11 px per layout, near-identical across layouts, so they come from shared views, not from any layout. Worth a pass with the audit's element list (`report.json`).

## Verification update (same day): what is real, what is not

I re-checked the findings in the browser (hit-testing, element lookups, the CSS) before fixing anything. Corrections:

- **Finding 6 (tap targets) is mostly a measurement artifact.** The probe measured visual boxes. The What's New bell and the user pill carry 44 px invisible hit areas (`dashboard-app.css`, the `::after` rules near line 4420) and both hit-test correctly at their centers. The push prompt's Not now and Enable buttons are already `min-height:44px` (`push-registration.js`). Treat the 36/41 px figures as visual size only. Not confirmed as real problems: D2D zoom buttons, the Photos checkbox and search box, toast close buttons, Island's active tab. Those still deserve a look with a real finger, not a probe.
- **Finding 1 (overlays)** is partly by design: `push-registration.js` already lifts the prompt above the bottom nav. What remains is that the prompt (about 147 px) plus the round Record visit button (56 px, fixed, z-index 900) cover a lot of a 852 px screen at once on first run. Decided by Jo (2026-11-19): the prompt waits for a calm moment. It now shows only after 15 s from load, 3 s with no touch/key/scroll, the tab visible, and no dialog, onboarding tour or layout offer up; it re-checks every 1.5 s for 10 minutes and then waits for the next load (`push-registration.js` `showWhenCalm`, pinned by `tests/push-optin-waits-for-calm-2026-11-19.test.js`). The Record visit button itself is unchanged.
- **Finding 4 (Field header clip) was real and is fixed**: the header row was a non-wrapping flex row. It now wraps; `+ Lead`, `Search` and `Sun` are all visible at 393 px. Pinned by `tests/layout-field-header-wraps-2026-11-19.test.js`.
- **Finding 5 (Menu chip on its own row)** is deliberate wrapping (`flex-wrap` with `margin-left:auto` in each layout's CSS), caused by six controls sharing one row. Changing it is a design call, not a bug fix. Not changed.
- **Findings 2 and 3 (Island chrome cost, the breadcrumb row)** are design judgement calls and were not changed.

## Follow-up: Record visit tab (PR B, decided with Jo 2026-11-19)

Jo chose to move Record visit into the phone's bottom nav. Shipped dark behind the feature flag `recordVisitTab` as `docs/pro/js/visit-recorder-tab.js`, fetched by `dark-features.js` only when the flag is on (nothing downloads and nothing changes with it off). With the flag on, a rep who never saved a bottom-nav bar gets Home, CRM, +, Record, More: Record takes Ask Joe's slot (Ask Joe stays in More and the command palette). Tap opens the same menu the round button opened (Unfiled visits, Recent visits, Record visit), rising over the tab; hold 0.5 s and let go records straight away; the red unfiled-count badge and a red pulsing dot while recording move onto the tab. The round button is drawn invisible on a phone while the tab is there (its wrapper stays to anchor the menu) and Home no longer reserves its 74 px. The flag is flipped per account in `feature_flags/{uid}` and widened in `feature_flags/_default`. Pinned by `tests/visit-recorder-tab-2026-11-19.test.js`; checked live on the emulator at 393 px (flag off: unchanged; flag on: tab in place, menu fully on screen above the nav, hold reaches the recorder flow).

Where this differs from what was agreed, and why:

- **A rep with a saved bar cannot add the tab from the customizer yet.** The plan said they could add it themselves. The dashboard's script size budget has under 0.4 KB of headroom, and the customizer would need about 1 KB more in the boot path. Saved-bar reps keep their bar and their round button, unchanged. Adding the tab to the picker needs budget the conductor has to raise once; until then this is the honest limit.
- **No role gating.** The plan said viewers would not get it. The round button never had any role gating (only the "do not record" and settings controls use it), so the tab follows the button: everyone with the nav gets it, and the recorder itself refuses where it cannot record.

## What would move the needle

Fix 1 and 6 first: they touch every layout at once. Then the Island and Field specifics (2, 4), then the chrome trim (3, 5). Layout-specific polish beyond that has little payoff while seven layouts share one set of views.

## Reproduce

Capture script and probe live in the session scratchpad, not the repo. To rerun: seed the emulator, start it on a free Firestore port (8080 can be held by another local app; the client hard-codes 8080, so reroute `connectFirestoreEmulator` with a Playwright route), apply each layout, `goTo` each view, screenshot and probe.
