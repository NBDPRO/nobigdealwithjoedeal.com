# NEXT_SESSION - 2026-10-25: the sweep, the characters, the E2E lanes

**Session of 2026-10-25 (overnight into the morning, Jo away then back).** Continues
[NEXT_SESSION-2026-10-24](NEXT_SESSION-2026-10-24.md); its Needs Jo list still stands except where marked below.
Verified against `main` `43e213a` (#2730) on 2026-10-25 08:20 UTC.

## Where things stand

- **Merged today, through the queue:** #2727 (UI sweep passes 1-6 + reviews on every homeowner page + Daily Success
  notebook and layouts + Roof Rep revamp + the vector characters), #2728 (characters wave 2), #2729 (E2E lanes 5 + 2,
  the 360 px wordmark, the committed `tests/node_modules` symlink removed), #2730 (characters wave 3). Each squash on
  `main` deploys; check the `Firebase deploy` runs before calling the last one live.
- **Merged later the same day:** #2731 (Island repaint), #2732 (characters wave 4 + the dedup-modal retry fix +
  the turf fallback), #2733 (the sample account's game card, wave 5, the LEAVE scene, the toast style leak and the
  Tools drawer).
- **Merged 12:42 UTC:** #2734 (the Pipeline strip one row on a phone, the @shard2 layout-leak reset in five specs,
  chibi v9 with the hidden-canvas throttle, persona props, weather and idle fidgets, character waves 6 to 9, the
  @shard1 estimate-parity race, the hero-video test's `vendor_id` allow, the digest + MCP team deal-room count and
  company paging, the `lead_sources` key hardening). **Its @shard2 leg ran in 13.6 min: 165 passed, 1 flaky
  (focus-mode), 2 order-dependent misses** (crew-calendar test 1, compact-header test 4; both pass alone and in a
  pair locally). The error blocks were out of reach: the hosting emulator's access log (~1.6 MB) pushed them past the
  5000-line tail the API serves, so the next PR filters that log out of the authed legs and both specs print their
  page state on failure.
- **Open next:** the CI log filter + spec dumps, and the Roof Rep trophy / career copy counts (badges out of six
  courses, Boss slayer three of six boss doors).
- **The characters** ([ROOF-REP-GAME](ROOF-REP-GAME-2026-10-03.md), updates 10-25): one vector chibi draws every
  avatar on Roof Rep and the CRM game card. Wave 2: jointed limbs, 220 ms cross-fades, hair/hat motion, emotes, point /
  nod / shrug, scenes in the empty speech box, tap-to-cheer, the door swing. Wave 3: hammer / climb, crews working in
  the build, nailing and ladder mini-games. Wave 4: the looks above. Waves 6–9: course-card demos, homeowner props,
  weather, idle fidgets. Waves 10–11: the chibi on the leaderboard page and the dashboard leaderboards. Waves 12–13:
  builds (regular / slim / stocky / tall, an elder stoop) and eyes that follow the pointer. Wave 14: a pop-in on
  arrival, a wave back when tapped, the double blink. Wave 15: cold breath and winter / summer dress on the street.
  Wave 16: eye colour in both pickers. Wave 17: thumbs-up and cringe poses on the street's outcomes. Wave 18: folded arms and a nod in
  the speech sheet as trust moves, a walk that fits the build, the rival's smirk. Wave 19: the leaderboard faces arrive one after another; the sheet's dog
  barks. Wave 20: speech varies the mouth and brows; the HUD face mirrors the street rep. Wave 21: a
  frowning idle sighs and shakes its head, a happy one rocks. Wave 22: the sample account's leaderboards show the
  owner's face (seed v8). Wave 23: the game card cheers for XP earned since the last look. Wave 24: the face turns
  with the look (a three-quarter head), the walk looks ahead with a loose cap, the cheer squashes and stretches, hoodie
  strings swing, and a facing change turns over 180 ms (the head stays round) instead of mirroring in a frame. Wave
  25: dust puffs on a cheer's landing, the shadow spreads under a squash, and loops scrolled out of the viewport rest
  (and pop in when they scroll into view). Guard `tests/chibi-2026-10-25.test.js` (125).
- **The character style bar (Jo, 15:10 UTC):** two reference images (a cel-shaded hooded robe as pixel art and as
  clean vector; a hooded lantern-carrier from eight angles) and two sentences: "this level of detail and style or
  above" and "super clean and no overlapping of items, accessories, outfit etc." Now CLAUDE.md rule g, with the
  references and what they mean for the renderer in
  [CHARACTER-STYLE-BAR-2026-10-25](CHARACTER-STYLE-BAR-2026-10-25.md); `scripts/chibi-sheet.js` renders a grid from
  a JSON spec so a change can be looked at. Two workflows ran the same evening: the clean-up audit (twelve finders by
  dimension, two sceptics per finding, a fixer per part, a critic over the full matrix) and a prototype panel for the
  painted style (six attempts, three judges, a plan and a contact sheet). Jo's open decisions: proportions (chibi
  painted to the bar, or the references' three-and-a-half-head figures), true side and back views, which personas
  and pickers get hoods, robes, belts, satchels and lanterns. **How the evening went (22:00 UTC):** the finders,
  the six prototypes and the art and product judges finished; then every agent died on the account's session limit
  ("resets 8pm UTC"), so the audit's verify/fix/critic, the panel's engineering judge and synthesis, and the dog's
  integration were resumed from their cached runs at 22:03 UTC (the audit on a restructured script: one sceptic per
  body part instead of two per finding). Their outcomes are item 0 under "Next lanes" below and in the
  [style bar note](CHARACTER-STYLE-BAR-2026-10-25.md)'s status section.
- **Jo's sprite packs (16:00 UTC):** the Mana Seed Character Base demo 2.0, the Mana Seed Farmer free sample and
  Craftpix's tiny heroes, "free models and designs we can use and base off of … might be easier and cleaner". Measured,
  not blurbed: 64-px cells, a 14×29 px figure, four drawn directions; the free demo covers 2 of our 16 poses (stand,
  walk) and the paid Farmer system 9 (four of them front-only); option parity would be ~30 new layers × 32–64 cells
  each (416–1,920 cells, 6–27 artist days) and loses eye colour, builds, moods, gaze, the turn, speech shapes and
  cross-fades (waves 12–25). The mapping (poses, options, fit per surface, licence text, three routes with days) is in
  the session scratchpad (`render/sprites/MAPPING.md`, contact sheet `keymap/sheet-3x.png`); the recommendation given to
  Jo: **R3**, keep the procedural renderer and redraw it pixel-crisp at Mana Seed proportions (head ≈ 35–38 %, 3–4 tone
  ramps, 1-px ink, 135 ms walk), plus the one free win: **the Mana Seed demo into Pixel World as-is** (16-px tiles, a
  two-tile-tall figure, walk in four directions is the whole need, the demo's licence allows commercial use). Jo has not
  picked a route; the Pixel World swap runs as a lane under any route (Next lanes, item 0).
- **American Operator's official kit (16:00 UTC, "you can decide"):** PR #2740 (draft): the dark "Locally Owned &
  Operated / Certified by American Operator" banner replaces the shield-and-text tile in every footer cert bar (287
  pages: four partials restamped plus 13 hand-edited pages), the orange banner under the About page's credential chips.
  Verified by an independent agent; blocked only by the two landing visual baselines (mobile, tablet) that the sandbox
  cannot bless (Needs Jo, item 5).
- **`@shard2`** ([the 10-24 lanes](NEXT_SESSION-2026-10-24.md), lane 5): every spec passes alone on the emulators. The
  leg hit its cap twice today. First `layout-island.spec.js` burned 3 × 300 s on a real product gap (#2731). On #2731's
  own run the burner moved to `mission-control.spec.js` (3 × 240 s, spec 45 of 168 at the cap), and the log named the
  mechanism: a CI **retry** of any spec that saves a lead through `_saveLead` finds the previous attempt's lead, because
  `LeadDedup.normName` strips digits (`InPath1761…` twice on "1 Storm Row" is "the same name on the same street"), and
  `_saveLead` then awaits the possible-duplicate modal forever. So one ordinary failure turned every retry into a full
  timeout. The login fixture now answers that modal on the emulators ("Create anyway", from an init script), and
  mission-control resets its saved Mission state on each pick (a previous attempt's Leads toggle came back ON through
  `layoutState`: the day-route `aria-pressed` failure). Running the spec three times on one emulator also surfaced a
  product bug: four leads geocoded to one pin collapsed `splitTurfs`' quantile cuts and the rep got 2 turfs under a
  "3 turfs" stepper; `mission-logic.js` now falls back to equal-width cuts when a cut is lost (pin in
  `tests/layout-mission-2026-10-12.test.js`). Guard: `tests/e2e-retry-hygiene-2026-10-25.test.js`.
  **On #2732 the leg finished for the first time** (23 min: 136 passed, 8 failed, 24 did not run). Both legible
  failures are `phone-draw-crosshair.spec.js`, both reproduce alone on the emulators, both are product bugs from the
  10-24 UI sweep (#2727): (a) `theme-achievements.js` injected bare `.toast-content` / `.toast-icon` rules (32px padding,
  a 48px pulsing icon) that dressed every ui.js toast on the dashboard; at 360x640 the Draw screen's toast wrapped one
  word per line into a 160px block over the magnifier. Scoped to the banner (`theme-achievements.js?v=3`); guard
  `tests/toast-style-leak-2026-10-25.test.js`. (b) the 44px tap targets grew the Tools drawer's Gutters stack to 373px
  inside a 340px drawer, so "✓ Finish run" opened half under the bottom nav at 393x852 and 412x860; the phone drawer
  is 380px now (`dashboard-app.css?v=26`); guard `tests/draw-tools-drawer-2026-10-25.test.js`. Why the leg ran 23
  min: the spec's four `describe.serial` groups re-run whole on every retry (tests 130-239 of a 168-test shard were
  this one file). With both fixed, read the next run's wall time before deciding on the required set.
  **On #2733 the leg finished again (20 min)** and the five remaining failures were run together on one emulator, the
  way the shard runs them (`NBD_AUTHED_SPECS_FILE` with the five specs). Four were the shard sharing ONE rep: a Crew
  layout pick from `crew-calendar.spec.js` outlived its spec (`LayoutEngine.saveUser` writes `prefs().user`), so
  `#nbdCrewRoot` sat over Today, the header and the Call Center for every later spec (19.6 min of timeouts for five
  specs; 4.4 min once reset). `ensureClassicLayout(page)` in `fixtures/auth.js` clears a saved pick, and the five
  specs call it after login. Also found: `my-skin.spec.js` checked a stale radio (`#myskinPerTheme` is checked after
  `#myskinStyleWallpaper`); `call-center-view.spec.js` flagged chips inside a horizontal scroll rail as overflow (the
  fit check now names the widest element and skips rails); `never-forget-client.spec.js` tapped Handled expecting the
  promise sheet, but Handled is one tap with an Undo since #2668 and the sheet opens from "I promised something".
  One product bug: the phone tap-target floor from #2727 (`.view :is(button, …) { min-height: 44px }`) beat the Pipeline
  strip's 32px chips, so the strip was 56px and, with a wide fallback font, wrapped to two rows (100px). The floor now
  skips `.kr-stat` / `.kr-cycle` (their `::after` hit area is the 44px target; `dashboard-app.css?v=27`), and the chips
  lost 2px of padding and a 9px key so the row holds even without Barlow (`pipeline-rich-cards.css?v=3`); guard
  `tests/crm-strip-one-row-2026-10-25.test.js`. Local note: this sandbox's proxy blocks fonts.googleapis, so the
  dashboard renders in a wider fallback font; `loginAs` on the emulators now serves the self-hosted Barlow sheet
  (`nbd-fonts-pro.css`) in its place, so local widths match CI's.
- **Merged today after #2735:** #2736 (character waves 12–15 + the ANSI-tolerant CI filter, 14:12 UTC). Waves 16–21
  follow in the next PR on the same branch.
- **@shard2 on #2735 (the first run with the hosting-log filter): 167 passed, 1 failed, 13.0 min.** Only
  compact-header test 4 ("the first card starts in the top half") missed; crew-calendar passed. The filter itself
  missed: on the runner firebase-tools colours its prefix, so ANSI codes sit between "hosting:" and the address and
  the fixed string never matched (4851 of the API's 5000-line tail were still GETs, so test 4's new block dump was out
  of reach again). The pattern now allows up to 20 characters there (this PR); the next @shard2 run is the first whose
  tail will hold the dump. The traces artifact (playwright-authed-traces-1, 9 MB) is on the run for a reader with
  blob access.
- **@shard2 on #2737 (the first run whose tail held the dumps): 165 passed, 2 failed, 1 flaky, 11.5 min.** Zero hosting
  lines in the tail, so both misses were read from their dumps and fixed in the same evening:
  - compact-header test 4: the first card sat at 548px (65%) and the dump named two data-driven blocks the shared rep's
    earlier specs leave behind, the follow-up alerts (124px) and the sort-customers banner (60px). Neither is the
    header's doing, so the test now subtracts their heights (`#followUpAlertsWrap`, `#sortCustomersWrap`) before the
    52% rule and logs them. Alone: 424px with 60px of data blocks.
  - crew-calendar's drag test: a strict-mode violation on `.cw-lane` with `hasText: 'ZZCW Alpha'`, because a retry's
    first attempt had left its own crew behind and two lanes matched. The lanes are now matched by this attempt's
    stamp (`'ZZCW Alpha ' + s`), the drag starts on the Week view (the pill is clicked if not pressed, the placed job
    re-asserted, 600 ms for the re-render) and the dump adds the pill's state and the cell count.
  - The flaky one (call-center-view) passed on retry; its layout-leak reset landed in #2734.
  Both specs together on the emulators after the fix: 7 passed in 36.0 s.
- **#2738 merged 15:11 UTC, and its run was the first with every job green: @shard2 passed in 13.9 min and @shard3 in
  13.9 min.** The two fixes above held on the runner, so the leg has gone from two order-dependent misses to clean;
  lane 2 (the required set) is now Jo's call alone.
- **The zero-network walk's AI Usage click** missed twice today and passed four times since; the step now records what
  the parent dashboard has at the click point, so the next miss names the cover.
- **The sample account's Home game card** was hidden on `/pro/explore`: the card is opt-in (`userSettings.game`) and
  the seed never set it, so the only avatar picker a visitor could see was the Roof Rep locker. Done the same day: the
  seed (v7) turns it on for the sample owner with an avatar (curly hair, ball cap, hoodie), the canned `getGameCard`
  answers a whole sample week on the server's own XP ladder, and `game-card.js` (v5) no longer treats an answer
  without the two weeks as a card (the old `{ ok: false }` stub would have thrown on `c.week.xp`). Guard:
  `tests/pro-demo-game-card-2026-10-25.test.js` (16); the zero-network walk 119/0 with the card on.

## Needs Jo

0. **Visual decisions** (unchanged from 10-24 item 0): card radius 12-14 px vs DESIGN.md's 8; nav CTA 6 vs 8 (19
   stragglers aligned to 6); the two primary-button tiers.
1. **Baselines to bless:** `/pro/pricing` (pass 2) and `/pro/register` (pass 6) a11y fixes move committed pixel
   baselines; the rules are written in the sweep note, the bless is yours.
2. **`@shard2` / `@shard3` in the required set** once `@shard2` finishes on `main` after #2731.
3. **Clay mascot** (Canva media `MAHY-9Hts18`): export + licence call; the vector chibi stays for every customisable avatar.
4. Everything else on the 10-24 list (flags to flip, claims to confirm, the real-iPhone pass, contracts, data, CI policy).
5. **#2740's landing baselines** (`landing-mobile` and `landing-tablet` in `tests/e2e/visual-regression.spec.js-snapshots/`):
   the footer banner moves every pixel below the fold, so the two full-page baselines have to be re-blessed from CI's
   renderer (local renders differ on 9 of 12 baselines). Either allow `*.blob.core.windows.net` in the environment's
   network settings so the sandbox can pull the `visual-regression-output` artifact, or drop the two `-actual.png`
   files from that artifact into the snapshots folder on the PR branch.
6. **The sprite route** (R1 Mana Seed everywhere with the paid Farmer system and a commissioned artist, R2 Mana Seed
   on the street and in Pixel World only, R3 keep the renderer and redraw it pixel-crisp): the recommendation is R3;
   the Pixel World swap ships under any of them. If R1, two licence questions first (may the paid sheets ship as plain
   PNG files on a public site; what terms govern our own layers).
7. **The painted style's proportions and views** once the contact sheet (`render/proto/CONTACT.png`) and PLAN.md are in
   hand: chibi painted to the bar (the judges' pick) or the references' taller figures; whether to add true side and
   back views; which personas get the new outfit pieces.

## Next lanes (engineering, no Jo needed)

Refreshed 2026-10-25 (late): lanes 1, 2 and 4 of the morning list are done (#2731–#2737 merged or open; the
characters ran to wave 23). What is left, and what is new:

0. **The four character workflows resumed at 22:03 UTC** (each on its own worktree and local branch, cherry-picked onto
   the work branch when its gates pass; none widens #2740): the clean-up audit's fixes on `wave24-local`
   (`scratchpad/audit`), the street dog drawn to the bar on `dog-local` (`scratchpad/dog`; winner `animation-first`
   with grafts from the other two attempts), the painted panel's PLAN.md + CONTACT.png (for Jo, Needs Jo item 7), and
   the Pixel World sprite swap on `pw-local` (`scratchpad/pw`): the Mana Seed demo body, outfit, hair and hat sheets
   under `docs/pro/img/mana-seed/` with a CREDIT.txt, colour-mapped at runtime from `userSettings.game.avatar` for the
   player and from the lead id for townsfolk, string patterns kept as the fallback, a new guard
   `tests/pixel-world-sprites-2026-10-25.test.js`. Whatever finished is listed in the style bar note's status section.

1. **`@shard2` went green on #2738's run** (both misses on #2737's run were read from their dumps and fixed: compact-header
   test 4 discounts the shared rep's data blocks, crew-calendar's lanes are matched by this attempt's stamp). Watch the
   next two full runs; if a miss comes back, its dump names the cover (the traces artifact holds the screenshot for a
   reader with blob access). Lane 2 is the only thing between the leg and the required set.
2. **`@shard2` / `@shard3` in the required set** waits on Jo (Needs Jo, item 2): the leg runs in about 13 minutes now.
3. **Characters, left on the table:** the leaderboard page (`/pro/leaderboard`) is a single-rep board, so only your own
   face shows there (wave 10); if it ever lists teammates, `team-names.js` `loadAvatars()` is the read to reuse. A kid
   build, night tint on the street's characters and seasonal dress for the rep's own look were considered and not
   built. The shipped-bytes ceiling has about 9 KB of slack (2807 of 2816 KB); the next renderer wave that needs more
   raises it with a dated note, as waves 12–17 did.
4. **The sample account** carries the owner's Roof Rep row (seed v8) so its leaderboards show a face; a second sample
   rep (a real team on `/pro/explore`) would make the Team Leaderboard widget and the staggered arrival visible to a
   prospect. Seed v9 if wanted: a member doc, a few leads under the second uid, a `roofRepScores` row.
