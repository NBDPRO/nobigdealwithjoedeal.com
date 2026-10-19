# Visual audit: every CRM layout, every size (2026-10-19)

Jo asked for an overnight visual audit of every appearance layout in NBD Pro at
every screen size and configuration, with the real defects fixed. This note is
the result: what was measured, what was found, what shipped, and what is still
open. Earlier layout audits are not repeated: see
[CRM-VISUAL-AUDIT-2026-10-05](CRM-VISUAL-AUDIT-2026-10-05.md) and the 2026-10-15
layouts audit it led to (D1 to D30, fixed in #2467, #2479, #2483, #2488, #2489,
#2490). Everything below was checked against `origin/main` as of the morning of
2026-10-19.

## What was audited

The layouts come from `docs/pro/js/layout-system.js` (the registry), not from
memory. The picker lists eight:

| Layout | Surfaces | Wallpaper | Note |
|---|---|---|---|
| Classic | phone, tablet, desktop | yes | the default dashboard |
| Bento Board | all | yes | tiles |
| Mission Control | all | no | map + route; the job map and route plan are part of it |
| Focus Mode | all | yes | one-thing-at-a-time |
| Island Dock | all | yes | floating pill and dock; the job island loads inside it |
| Triage Inbox | all | no | reply queue |
| Crew Calendar | all | yes | week / day |
| Field App | phone, tablet only | no | falls back to Classic on a desktop, by design |

Not covered in this pass: Pixel World (a separate walkable-town mode, not in the
picker), the job island and route plan as their own screens (only reached through
their layouts' home), and any screen other than Home.

## How it was measured

- Local emulators only (auth, firestore, storage, hosting). Nothing touched
  production; no function emulator, so no alert could send.
- A seeded tenant: 16 customers with long names and addresses, five of today's
  appointments, and the setup checklist hidden. An empty tenant was also run.
- Headless Chrome 155 driven by Playwright. Per page: sideways overflow with the
  offender walk stopping before `<body>`, clipped text, touch targets under 44 px
  on touch widths, controls covered by another element, fixed bars as a share of
  the viewport, console errors, layout shift on a theme switch, and text contrast.
- Contrast was measured two ways. The first (text hidden, then the pixels behind
  it sampled) over-reports on translucent glass, emoji and mid-transition frames,
  so nothing was filed from it alone. Every defect below was re-measured from
  computed colours and then proved by a render test that fails without the fix.
  A computed-colour sweep then ran 12 themes x light and dark x 8 layouts x 2 sizes
  (360 passes), plus the header and navigation chrome over all 207 themes x 2 modes
  (414 combinations).
- Screenshots and contact sheets are outside the repo (`nbd-ops`); none are committed.

## Coverage (1,496 renders)

| Pass | What varied | Renders |
|---|---|---|
| 1 | all 8 layouts x all 15 sizes x light and dark (`nbd-original`) | 240 |
| 2 | 8 layouts x 4 sizes (390x844, 844x390, 768x1024, 1440x900) x 7 themes (`nbd-original`, `paper`, `daylight`, `obsidian`, `pokemon`, `mario`, `storm-season`) x light and dark x wallpaper on and off | 832 |
| 3 | 8 layouts x 5 sizes x browser zoom 200%, Large text, Small text, Compact, Spacious, reduced motion, Glass, Glove, high-contrast (see limits) | 351 |
| 4 | empty tenant, 8 layouts x 4 sizes | 32 |
| 5 | computed-colour sweep and chrome sweep (see above) | 360 + 414 combinations |

The 15 sizes: phones 320x568, 360x640, 375x667, 390x844, 430x932; landscape
phones 844x390, 932x430; tablets 768x1024, 820x1180, landscape 1024x768; laptops
1280x720, 1440x900; desktop 1920x1080; ultrawide 2560x1080, 2560x1440.

### Clean results

- **No document-level sideways scroll in any of the 1,496 renders.** Twenty-eight renders
  had an element past the edge inside a container: 11 are the Island dock at 320 px and
  1 the Bento header at 320 px with Large text (both fixed below), and 16 are browser zoom
  200% on a 160 to 195 px wide viewport, below the 320 px reflow floor (left, see Open).
- **No console errors** outside the known emulator noise (the missing functions
  emulator, tile and font hosts).
- **Layout shift on a theme switch**: one render above 0.05 (0.125, Bento at 320
  px when the text size changed), none from a theme change.
- Empty states read well in every layout (a line of what belongs there, no blank
  card, no orphaned control).
- Field on a desktop width correctly serves Classic (26 passes, not a defect).

### Limits (say so, do not pretend)

- Pass 2 simulated wallpaper (the My Skin classes and variables with a generated
  picture); pass 7 below replaces that with real uploads. The first-pass wallpaper
  rows are kept only as a layout check.
- **iPhone safe-area insets** cannot be set in Chromium or in WebKit automation. Read
  from code: every layout with a fixed root (Crew, Field, Focus, Inbox, Island,
  Mission) uses `env(safe-area-inset-*)`; Bento and the map views use none but are not
  fixed. Needs a look on the installed iPhone app (see Needs Jo).
- Keyboard focus order, hover states and screen-reader output were not tested.

## Defects fixed (each PR has a render test that fails on `main`)

All fixes are CSS, plus two small style-string edits in `push-registration.js`.
The tests live in `tests/layouts-visual-audit-2026-10-19.test.js` (a render test
on the sample account) with one section file per fix in
`tests/layouts-visual-audit/`, so later fixes add files and never collide.

| # | Sev | Layout / area | Defect | PR |
|---|---|---|---|---|
| 1 | Medium | Mission, job map | Leaflet's white attribution strip beat the layout's override (load order), leaving muted grey on white, 1.5:1 in dark | [#2541](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2541) (merged) |
| 2 | High | Field, Island (all layouts) | The "Turn on appointment reminders" card anchored above `#mobile-nav` only, so it sat on Field's tab bar and Island's dock and swallowed their taps until dismissed | [#2542](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2542) |
| 3 | Medium | all layouts | The same card read five theme tokens no stylesheet defines: always a white card, white text on the old orange `#e8511f` (3.7:1) | [#2542](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2542) |
| 4 | High | header, all layouts | The avatar initial inherited the text colour on an accent circle: 137 of 414 theme and mode combinations under 3:1 (Paper: a black P on a black circle) | [#2543](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2543) |
| 5 | Medium | Island, 320 px | Six pill labels ran together ("PipelineSchedule") and the dock's last button sat past the bar | [#2544](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2544) |
| 6 | Medium | header, phones | Header icon buttons 40x40 and the What's New bell 41x36: under the 44 px floor; now the same invisible 44x44 hit area the Settings pill has | [#2545](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2545) |
| 7 | High | Bento, phones | Greeting squeezed to 49 px ("WE...") beside Arrange and New estimate at 390 px; at 320 px with Large text "New estimate" ran 29 px off the screen | [#2546](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2546) |
| 8 | Medium | Inbox | Green and gold reply-by timers 2.7:1 and 1.8:1 on a light row (green failed in dark too) | [#2547](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2547) |
| 9 | Medium | header and nav, all layouts | "Sign Out" 1.5:1 on the dark header in light mode; red count badges (sidebar Pipeline, bottom-nav CRM) 3.05:1 dark / 3.7:1 light | [#2548](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2548) |

## Second pass: the other screens, real wallpaper, prefers-contrast, WebKit

Jo asked for the same standard on the screens that carry real work, so a second
pass ran the same way (emulator only, Playwright, computed colours first).

| Pass | What | Captures |
|---|---|---|
| 6 | Screens beyond Home: Pipeline board (default, Compact, Rich and Photo card styles), customer detail page, Estimates, the estimate builder, Schedule, Expenses (the receipt health panel is flag-gated and was not on), Settings > Appearance (My Skin, layout picker, theme picker with its live preview), command palette, Pixel World; at 390x844, 844x390, 768x1024, 1440x900 and 2560x1080, light and dark, in `nbd-original`, `paper`, `obsidian`, `pokemon` and `storm-season` | 600 |
| 7 | **Real** My Skin wallpaper: generated pictures fed through the actual per-theme uploader into the Storage emulator (one picture, then a 3-picture slideshow) in the five themes, 6 wallpaper-capable layouts, 390 and 1440, light and dark; text contrast sampled from pixels under glass and solid cards, phone scroll, and a theme-switch flash probe | 240 + 20 probes |
| 8 | `prefers-contrast: more` truly emulated (Playwright `contrast: 'more'`) in Mission, Focus, Inbox, Crew and Field at 390 and 1440 | 20 |
| 9 | WebKit 26.5 (the iPhone engine) on the installed build: all 8 layouts at 393x852, 852x393 and 820x1180, light and dark, plus input sizes on six screens | about 50 |

### Clean results

- No sideways scroll and no clipped control on any of the 600 screen captures (the
  one "clipped" hit is Pixel World's visually hidden live region).
- **WebKit: all 8 layouts render and fit** at iPhone portrait, iPhone landscape and
  iPad; `color-mix`, `dvh` and `backdrop-filter` are all supported; no field is under
  16 px on the six working screens (iOS would otherwise zoom on focus). For anyone
  re-testing: on a first visit with no cached layout, WebKit against the emulator took
  about 8 s to read the saved layout, so Classic showed until it landed. That is the
  emulator's WebKit transport, not a product defect: a returning user is painted from
  the preboot cache.
- **Wallpaper: no theme-switch flash.** The two picture layers cross-fade and the
  summed opacity never dips below one opaque layer; going to a theme with no picture
  fades out over 0.3 s. **Phone scroll:** the layers stay fixed (position and top
  unchanged after a 500 px scroll) in every layout. The slideshow behaves like the
  single picture for contrast.

### Fixed in the second pass

| # | Sev | Area | Defect | PR |
|---|---|---|---|---|
| 10 | High | My Skin wallpaper, light mode | The frosted header and tab bar turn light but the light-mode chrome rules assume a dark bar: wordmark 1.05:1, idle tab labels 2.3:1. Bare text on the picture (page subtitle, Bento "Your board", the sync status) sat muted straight on the wallpaper (1.3 to 2.3:1): now the text colour with a soft halo | [#2553](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2553) |
| 11 | Medium | Mission, Focus, Inbox, Crew, Field (and Classic) | No `prefers-contrast: more` rule: the next-stop and closes-week card edges were 1.2:1 against the page, muted text 4 to 6:1. Under the OS setting only, the hairline and muted tokens now come from the text colour | [#2550](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2550) |
| 12 | Medium | Pipeline board | The "PIPELINE" title in brand orange was 3.2:1 on navy; "Drop leads here" was muted at opacity .6 (2.3:1) | [#2552](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2552) |

## Open (not fixed; each needs a decision or is out of scope)

| Sev | Where | Finding | Why it is open |
|---|---|---|---|
| Medium | all layouts | White text on the accent fill is under 4.5:1 in 209 of 414 theme and mode combinations (worst about 3.05:1: Tundra and Marble light, Powerpuff Girls dark). The engine flips to dark ink only when white is under 3:1 (`accentFg` in `theme-engine.js`). `nbd-original` is 4.61:1 and is not affected | **Decision: see the recommendation below** |
| Medium | header and bottom nav, dark-accent light themes | On Paper, Minimalist, Brutalist, Ink, Typewriter and a few more, the "PRO" mark and the active tab label paint in the theme accent (near black) on the always-dark bar: under 3:1 in 13 combinations, under 4.5:1 in 112 | Needs a lighter accent-on-dark token; changes the brand lockup |
| Medium | Pipeline cards (every card style) | The chips and meta on a card are 1.8 to 3.4:1 in most themes: the `kc-tag` age and "Today" chips, the phone link, "1d ago", the aging chip, the lead-stage chip. Their colours are spread over inline styles in `crm-pipeline.js` and the kanban sheets | Needs one chip palette, not a patch per chip; a design call |
| Medium | Customer page and estimate builder | Brand orange as text (panel titles "Numbers", "Production", "Jobs"; the score label; the customer ID; "Copy PO name"; the builder "Back") is 1.9 to 3.4:1 on navy. The page does not load the shared accent-text token | Same fix as the layouts audit D5; needs a sweep of that page |
| Medium | wallpaper | Quiet buttons sitting straight on the picture (Island's "Customize", the Home quick actions) have no card behind them (about 2.3:1 on a busy picture) | Needs a per-control scrim; do it once with the My Skin owner |
| Low | Pixel World | The START button and some labels are 9 px orange on navy (2.8:1) | Retro look |
| Low | Mission, 320 px | The three header rows take 26% of a 568 px screen and the tab strip cuts "Day route" mid-word (it scrolls) | Works; polish only |
| Low | all layouts | The classic dashboard (header controls, customer-card buttons) stays in the DOM under a layout's full-screen root. Whether those controls take keyboard focus was not tested | Needs a keyboard pass |
| Low | header, browser zoom 200% on a phone | Below 200 px wide the header's right cluster runs past the edge | Under the 320 px reflow floor |

## Needs Jo

1. **One yes/no on accent text.** Recommendation: change the one rule in
   `theme-engine.js` that picks `--accent-fg`: flip to dark ink when white is under
   4.5:1 (it flips under 3:1 today) and ink reads better. It is a one-line change,
   leaves `nbd-original` and every theme already at 4.5:1 byte-identical (the default
   navy and orange theme measures 4.61:1), and fixes 205 of the 209 failing
   combinations. The visible change is white text becoming near-black text on
   mid-tone accent buttons (New estimate, Record visit, Navigate, the Mission tab, the
   logo mark) in those themes. The alternative is to leave it: those buttons stay at
   about 3 to 4.4:1, which meets large-text AA but not body text.
2. An iPhone installed-app look at things automation cannot set: safe-area insets
   (Field, Focus, Inbox, Mission, the bottom bar, the Island dock; Bento has no inset
   handling), the home-bar overlap, the Dynamic Island clearance in landscape,
   pull-to-refresh against the fixed bars, and the on-screen keyboard over the
   estimate builder and the lead form.
3. After #2553 merges, glance at one real wallpaper on the phone in light mode (the
   header should now read) and decide whether quiet buttons on the picture need a
   scrim (open row 5).

Method and harness: the Playwright scripts stay outside the repo in
`nbd-ops/visual-audit-2026-10-19/`; the permanent guard is the render test above,
wired into CI next to `crm-layouts-render-2026-10-15`. The second-pass fixes add
section files only (`wallpaper-chrome`, `prefers-contrast`, `pipeline-text`).
