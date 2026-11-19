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

## What would move the needle

Fix 1 and 6 first: they touch every layout at once. Then the Island and Field specifics (2, 4), then the chrome trim (3, 5). Layout-specific polish beyond that has little payoff while seven layouts share one set of views.

## Reproduce

Capture script and probe live in the session scratchpad, not the repo. To rerun: seed the emulator, start it on a free Firestore port (8080 can be held by another local app; the client hard-codes 8080, so reroute `connectFirestoreEmulator` with a Playwright route), apply each layout, `goTo` each view, screenshot and probe.
