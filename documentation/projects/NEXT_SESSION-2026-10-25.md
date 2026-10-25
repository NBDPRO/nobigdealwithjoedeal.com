# NEXT_SESSION - 2026-10-25: the sweep, the characters, the E2E lanes

**Session of 2026-10-25 (overnight into the morning, Jo away then back).** Continues
[NEXT_SESSION-2026-10-24](NEXT_SESSION-2026-10-24.md); its Needs Jo list still stands except where marked below.
Verified against `main` `43e213a` (#2730) on 2026-10-25 08:20 UTC.

## Where things stand

- **Merged today, through the queue:** #2727 (UI sweep passes 1-6 + reviews on every homeowner page + Daily Success
  notebook and layouts + Roof Rep revamp + the vector characters), #2728 (characters wave 2), #2729 (E2E lanes 5 + 2,
  the 360 px wordmark, the committed `tests/node_modules` symlink removed), #2730 (characters wave 3). Each squash on
  `main` deploys; check the `Firebase deploy` runs before calling the last one live.
- **Open:** #2731 (the Island hero repaints when the jobs store loads; the spec carries its own second job). After it:
  characters wave 4 (curly / afro / bun hair, tee / hoodie / polo tops in every picker; the street's homeowners wear
  them too) and this handoff, already committed on the branch behind it.
- **The characters** ([ROOF-REP-GAME](ROOF-REP-GAME-2026-10-03.md), updates 10-25): one vector chibi draws every
  avatar on Roof Rep and the CRM game card. Wave 2: jointed limbs, 220 ms cross-fades, hair/hat motion, emotes, point /
  nod / shrug, scenes in the empty speech box, tap-to-cheer, the door swing. Wave 3: hammer / climb, crews working in
  the build, nailing and ladder mini-games. Wave 4: the looks above. Guard `tests/chibi-2026-10-25.test.js` (60).
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
  `tests/layout-mission-2026-10-12.test.js`). Guard: `tests/e2e-retry-hygiene-2026-10-25.test.js`. The
  first failures of that run (1–4) are not in the readable tail of the log; read the next `@shard2` run on a PR.
- **The zero-network walk's AI Usage click** missed twice today and passed four times since; the step now records what
  the parent dashboard has at the click point, so the next miss names the cover.
- **The sample account's Home game card** renders hidden/empty on `/pro/explore` (its `init()` waits on `getDoc`/`db`
  and the card is opt-in): not a regression, but the only avatar picker a visitor could see is the Roof Rep locker.
  Worth a look if the sample account should show the card.

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
2. The game card in the sample account (above).
3. `@shard2` runtime after the retry fix: if it still cannot finish, profile the CI log the way the 10-25 session did
   (per-spec wall time from the line reporter's timestamps) rather than splitting blind. The MCP log tool returns the
   last 5000 lines only and the Actions blob host is off the proxy allow-list, so the head of a 25-minute log is out
   of reach from a cloud session; the per-spec `(retries)` markers in the tail still tell you which specs failed once.
4. Characters, if Jo wants more: the Train tab cards and the crew board still use still frames; the drive game's truck
   and traffic are vector but static.
