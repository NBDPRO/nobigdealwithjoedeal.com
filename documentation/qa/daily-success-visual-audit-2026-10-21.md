# Daily Success - full iPhone visual + flow audit (2026-10-21)

**Why.** Jo: the Daily Success tracker "looks wrong aesthetically", is "barely readable", and does not follow the
site's themes or rules. It is the least-used part of the site, so it has had the least manual testing. This is the
first pass of the full review: everything below was measured in a real browser at **390 x 844 (iPhone UA, touch,
2x)** against `main` at the time of writing, with the real page served locally (login stubbed, outside network
blocked, demo data in localStorage). Nothing here has been fixed yet - this is the problem list that the revamp
should be built from. Tools are throwaway scripts (screenshots, per-theme contrast counts, a tap-everything crawl);
they are not committed.

## Update 2026-10-21 (later): what was fixed, one correction, Jo's decisions

- **Correction:** the two "JavaScript errors" below (the 📖 guide button and "Reset to Quick Start Defaults") were an
  artifact of the crawl script, which deleted `#welcomeModal` and `#onboard-banner` from the page before tapping. Both
  elements always exist in the real page, so neither is a real bug. The numbers and findings below that mention them are kept
  as originally measured.
- **Fixed on main:** #2615 (default-theme colour tokens: failing text 217 -> 17 of 249), #2616 (phone layer: two-row header
  because the ten header buttons ran off a 390px screen, the `has-banner` class that theme code wiped, 12px type floor, 44px
  targets, Exercise Log / Diet / PR / habit tables that fit, one card width, stray ``` text around the goal wizard),
  #2617 (the CRM's dark card skin on the default theme + ten brand-safe themes replacing ~100 + the developer button
  removed). Final iPhone sweep: text under 11px 151 -> 0; targets under 40px 118 -> 6.
- **Queued as PRs:** #2619 (collapsible day sections with Food and Fitness open on a phone, a sticky Today bar, door-knocking
  stats hidden until used with a Door stats switch), #2618 (coach: Previous per set, rest-timer sound or vibrate setting).
  Coach workout history follows #2618.
- **Jo's answers (2026-10-21):** about 10 brand-safe themes with no trademarked names (done), remove the developer button
  (done), accordion day page (done in #2619), hide door stats unless used (done in #2619), ship each fix as it goes green.
- **Real-data run:** money planner, goal wizard, day entries across a reload, food search to the diet table, a full coach
  session, weekly review and JSON export passed 20/20 at 360, 390 and 412px with no script errors.
- **Still not covered:** a real iPhone, light themes end to end, Apple Health setup, the barcode camera.

## Headline numbers (day page, default theme)

| Check | Result |
| --- | --- |
| Text elements below 4.5:1 contrast | **217 of 249** (87%) |
| Elements with text under 11 px | 151 (24 rules at 9 px, 11 at 8 px) |
| Tap targets under 44 px | **103 of 124 controls** on the day page; 21 of 25 on the dashboard |
| Horizontal overflow | none |
| JavaScript errors on tap | 2 reported by the crawl - both were the crawler's own doing (see the update above), 0 real |

## Root cause #1 - the default theme has no colour tokens

The page boots into the legacy theme id `default` (`app.js` `nbdBoot`, which maps the CRM's `nbd-original` back to
`default`). The CSS defines the token set (`--paper`, `--ink`, `--muted`, `--tabbar`, `--stxt`, `--rule`, `--sbg`,
`--tt`, `--tb`, `--mbg`) only for `[data-theme="dark"]`, `[data-theme="nbd-original"]`, `light` and the 176
`:root[data-theme="..."]` blocks. **There is no block for `default`.** Measured on the live boot state:
`--ink`, `--paper`, `--muted`, `--tabbar`, `--stxt`, `--tt`, `--rule`, `--sbg` are all empty and `body` text computes to
`rgb(0,0,0)` on `#0A0C0F`.

What that does:

- The classic sections 01-08 (Mindset, Regiment, Diet, Fitness log, PR tracker, Log, Goals, Habits) are built as cream
  "paper" cards with dark ink (`.pc{background:var(--paper)}`). With `--paper` empty the card is transparent and the
  ink is black, so **every label, field, schedule row and table renders black on near-black**.
- Modals built on the same tokens (the 4-step "Your North Star" goal wizard, PR History) have **no visible panel**: their
  text floats over the page content and over itself.
- The header wordmark ("NBD" in "NBD PRO"), today's tab label and the Program Dashboard totals/labels are invisible.

Proof the fix is real: injecting only the missing tokens for `default` in the browser takes the day page from 217 to 185
failing elements and turns every card on. The remaining failures are muted-grey and orange text at 8-9 px on cream
paper (next section).

## Root cause #2 - two visual languages on one page

- **Legacy sections** (the Daily Success Program, 2025): paper cards, condensed caps labels at 8-9 px, serif chart
  axes, Barlow, hand-rolled spacing.
- **Newer cards** (built this month: Money, Weight, Your Data, Progress, Food search, Real maintenance, Workout
  Coach): bright cream cards with orange small-caps headers on the dark page.
- **Sheets/overlays** (Workout Coach screen, Weekly Review, Appearance): proper dark sheets with large controls -
  these are the closest to the CRM's look and the most readable.

Result: bright cream cards beside invisible sections beside dark sheets. The CRM (`/pro/dashboard`) uses one dark
card language; the tracker does not match it.

## Findings by area

**Header and tabs.** "NBD" (black), the day tab label (dark on dark), the "+" tab; the tab strip is 28 px tall (target
44). The 📖 (guide) button throws `Cannot read properties of null (reading 'style')` and does nothing; Appearance
is the only header control that works cleanly.

**Dashboard.** First-time goal wizard fires from unrelated buttons and renders without a panel. "Reset to Quick
Start Defaults" throws `Cannot read properties of null (reading 'classList')`. Streaks, Monthly Goals, Revenue Pace,
Doors/Revenue/Closes charts and Habit Compliance are dark-on-dark; the three empty line charts have serif axis labels
and no empty-state message. The product is a door-to-door sales + fitness program (Doors, Closes, Revenue), which
reads oddly beside "Money" and "Weight" cards.

**Day page - classic sections.** Unreadable on the default theme (above). Even when tokens are fixed: the Exercise
Log table and the Diet macro table are clipped at 390 px ("Exercise n...", "Breakfa", "DAILY T"), the PR tracker grid
puts values and units far apart, labels are 8 px, 56 `.hd` elements are under 44 px, and the day tab "x" and
"W0" are untappable (28-39 px).

**New cards.** Layout is fine and readable, but: the "Scan" button shows three black blocks as its icon, "Save as
favorite"/"Targets" chips are 36 px, "Find a food" and "Your real maintenance" lack the dark treatment used by the
Coach screen.

**Workout Coach screen.** Best-looking part. Open issues: set inputs are dark-on-dark with grey placeholders (fine),
"RPE" selects are native pickers (inconsistent), Avoid/Swap buttons are ~40 px.

**Appearance (themes).** About 100 themes, many named after trademarked characters and franchises (Batman, Superman,
Captain America, Wolverine, Darth Vader, Stormtrooper, Pokemon, Mario, Kirby, Zelda, Mega Man, Lego, Halo, ...), plus a
"Copy Firestore Write" developer button in the footer of the picker. A business site selling to contractors should not
ship trademark theme names or a developer tool; both are product decisions for Jo.

## Not yet covered (next pass)

Typing through the forms (add exercise, floors, habits grid, food log, weight entry), the Money planner and Weekly
Review flows end to end, export downloads, Apple Health setup, offline/PWA behaviour, 360 and 412 px widths, light
themes, and a real iPhone.

## Direction for the revamp (to discuss with Jo)

1. **Fix the tokens first** (one rule, large effect): make `default` a real theme, and set a floor for text size
   (>= 12 px, body 14-16) and contrast (>= 4.5:1) across the page.
2. **One card language** matching the CRM dashboard, applied to the classic sections and the new cards.
3. **44 px tap targets** everywhere; the 56 `.hd` elements under 44 px (section headers and similar) become proper full-width accordion rows.
4. **Tables to cards** on phones (Exercise Log, Diet macros, Habits grid).
5. **Fix the two JS errors** (guide button, Reset defaults) and give the goal wizard a real panel.
6. **Trim the theme list** to a short, brand-safe set; remove trademark names and the developer button.
7. **Regression guards**: a contrast and tap-size test over the phone page in CI so this cannot drift again.
