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
  frowning idle sighs and shakes its head, a happy one rocks. Guard `tests/chibi-2026-10-25.test.js` (112).
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

## Next lanes (engineering, no Jo needed)

1. Watch #2731 to merge; push wave 4 + this handoff as the next PR.
2. ~~The game card in the sample account~~ (done 10-25, above).
3. `@shard2` runtime after the retry fix: if it still cannot finish, profile the CI log the way the 10-25 session did
   (per-spec wall time from the line reporter's timestamps) rather than splitting blind. The MCP log tool returns the
   last 5000 lines only and the Actions blob host is off the proxy allow-list, so the head of a 25-minute log is out
   of reach from a cloud session; the per-spec `(retries)` markers in the tail still tell you which specs failed once.
4. ~~Characters: the Train tab cards and the crew board still use still frames; the drive game's truck and traffic are
   vector but static~~ (done 10-25, wave 5: Big Dave in the Training Yard, breathing crew rows, an eased truck with
   exhaust and skid dust; plus the `animate()` stop-ordering bug in chibi.js). Also the LEAVE scene: a signed homeowner steps out to the rep and cheers,
   a lost one shrugs, the rest wave, then the door swings shut. ~~Left: the Train course cards themselves carry no character.~~ (done, waves 6 and 7 in the same PR as the strip fix: the rep demonstrates each course on its card, and homeowners carry persona props.)
