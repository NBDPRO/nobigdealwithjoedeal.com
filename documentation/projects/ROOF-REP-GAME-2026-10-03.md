# Roof Rep — the NBD Pro sales game (2026-10-03)

Jo: "I officially wanna make a game. Roofing sales person simulator." Built
the same day as a claude.ai artifact, grown in four rounds at Jo's request
("let's do all 5", "double what we have"), then moved into the CRM with its
own tab.

## Where it lives

| Piece | Path |
|---|---|
| Page | `docs/pro/roof-rep.html` (noindexed; strict CSP, no inline script) |
| Game | `docs/pro/js/pages/roof-rep.js` (classic script, ~190 KB) |
| Look | `docs/pro/css/roof-rep.css` (single dark arcade look on purpose) |
| CRM link | `docs/pro/js/pages/roof-rep-net.js` (auth, saves, crew board) |
| Tab | `#nav-roofrep` (sidebar, TOOLS) + `#mm-roofrep` (phone More drawer); plain `<a>` links so the installed iPhone app stays in-app |

**Source of truth for content is the published artifact**
(claude.ai/artifact/Cgjufp5u5oj8ibbxGxFcJA). The CRM files are generated
from it by a split script that swaps the artifact's claude.ai storage for
`window.RoofRepNet`. Change the game in one place and regenerate the other;
don't let them fork.

## Data

- `roofRep/{uid}` — the career save (`{ save, at }`). Owner-only; not even a
  company admin reads it.
- `roofRepScores/{uid}` — the crew-board row. Readable by the owner and by
  the SAME company (token `companyId`); the owner writes only their own row,
  stamped with their own `companyId`, board fields only (`hasOnly`).
- Both are on `OWNER_KEYED_DOCS` (GDPR erase/export).
- localStorage `roofrep.save.v2` is a boot cache; Firestore wins when newer.
  A save from a different rep on the same device is never adopted.
- The Home game-card avatar (`userSettings/{uid}.game.avatar`) seeds a new
  career's look.

## What it teaches (and the guard)

The Kentucky rules are the core mechanic: "I'll handle your claim", covering
or waiving the deductible, padding a supplement, an assignment of benefits,
signing a check over, skipping the permit — each is offered as a WRONG
choice and loses the door or breaks the clean-day streak.
`tests/roof-rep-game-2026-10-03.test.js` fails if any trap ever becomes a
winning line (break-tested), and if game prices drift from the CRM price
book: TIER_RATES (550/660/770 per SQ), job-template retail floors (pipe boot
$350, chimney reflash $750, ridge repair $450, ice dam retrofit $900) and
seamless gutters $8.50/LF with the $1,000 K5 floor.

Supplement line-item amounts, change orders and the upgrade shop are game
values (what a carrier approves / game currency), not NBD retail.

## Content inventory

6 streets (Maple Court → Old Town, unlocking by level) each with a boss door;
24 homeowner types; seasons, weather, catastrophe storms; a storm-chaser
rival; dogs; 11 phone-call types; the full job from knock to collected
(inspect, measure, photo report, price, adjuster + test square, supplement,
crew board, build: change order / layers / nailing / city inspector / magnet
sweep / review); end-of-day CRM log; 6 training courses; 7 skills; 12
upgrades; 26 trophies; daily challenge; first-day tutorial; chiptune sound.

## Tests

- `tests/roof-rep-game-2026-10-03.test.js` (unit: traps, prices, trees, hygiene, rules, registry, nav)
- `tests/firestore-rules.test.js` (roofRep owner-only; roofRepScores same-company)
- `tests/e2e/roof-rep.spec.js` (iPhone first: More tab, tutorial, a full day,
  Firestore save, wiped-cache reload; then desktop sidebar tab + "← CRM")

## Update 2026-10-25: the revamp (Jo: "seriously revamp Roof Rep")

**The repo is the source now.** `docs/pro/js/pages/roof-rep.js` is edited directly; the claude.ai artifact above is
retired and the split script is no longer used. GameForce (gameforce.ai, Jo's original gamification inspiration) was
read again for the mechanic list: XP levels, leaderboards, achievements, daily quests, duel arena, guilds, tournaments,
token shop, boss battles, dungeon runs, streaks, "#n this week / all time". Roof Rep already had half; the rest landed
the Roof Rep way (no loot boxes, no stakes, the Kentucky rules still the core).

| Piece | What changed |
| --- | --- |
| Look | NBD palette (navy, brand orange, light orange on navy) and Montserrat / Lato replace the retro arcade skin. The street is drawn as a clean illustration at 2x (gable roofs, framed windows that glow after 4 PM, paths, bushes, pennant flags). Characters stay the pixel sprites shared with the CRM game card. `css/roof-rep.css` rewritten. |
| Phone layout | One-strip HUD, tabs as a fixed bottom bar (safe-area aware), the street edge to edge with the homeowner's speech sheet tucked under it, "Drive to" as a scroller. |
| Feel | `js/pages/roof-rep-fx.js`: floating +XP / cash text, confetti and flash on a signed job, shake and red flash on a bad call, a knock ring, walk bob, rain / snow / leaves, evening tint, staggered choice buttons, a LEVEL UP card. Reduced motion keeps particles, drops shakes and bobs. |
| Objection duel | Every pitch opens with two pushbacks from a 25-objection pool (17 in the first pass, eight more the same evening: a five-year-old roof, an adjuster who said no, rates, patching, selling, matching a quote, financing, solar panels) (`js/pages/roof-rep-rules.js` OBJECTIONS) written in NBD's voice. One best answer each (+trust, a lesson tip), an ok one, a weak one; the Kentucky-rule traps (deductible, AOB / "I'll handle your claim", cash up front, skip the permit, sign the check over, pad the scope) are dirty and lose the door. A trust meter is the HP bar. |
| Quest board | Three daily quests (seeded per day) replace the single challenge; all three in a day pays $500 + 60 XP. A weekly quest rotates with the week (sign 5, inspect 10, knock 30, 3 honest calls, 5 clean days) and pays cash + XP. |
| Storm Run | Train tab: a 60-second objection gauntlet. Best answers score, traps strike, three strikes end it; a perfect run pays a bonus. 20 minutes of the day if played mid-day. |
| Seasons | 28 days. After the day-28 summary a season card ranks the rep on the season's XP (Rookie, Door Knocker, Estimator, Closer, Roof Boss, Storm Legend) and resets. |
| Crew | "#n this week · #m all time" on the board, and **Duel** beside any crewmate: most week XP by Monday, bragging rights only (client-side from `roofRepScores`; no new writes). |
| Trophies | Objection handler (25 best answers), Storm runner (a perfect run), Season finisher. Clean-streak counter in the header. |

Tests: `tests/roof-rep-revamp-2026-10-25.test.js` (46: traps never win, one best answer each, forbidden lines only on
traps, seeded picks, scoring, seasons, crew ranks, wiring) alongside the original `roof-rep-game-2026-10-03` pins.

Not done yet (next): new homeowner personas and streets from NBD's playbook; a rooftop inspection mini-game with photo
evidence (the grid game stays); crew guild / team goals; the e2e spec (`tests/e2e/roof-rep.spec.js`) still drives the
same ids and passes the same flow.

## Update 2026-10-25, later: the characters (Jo: "make the characters, sprites and animations as high quality as we can")

The 32×32 pixel grid is retired from every screen. `docs/pro/js/chibi.js` (`window.NBDChibi`) draws one vector chibi
with Canvas 2D paths at any size: a big round head with gradient shading and a forehead highlight, big shiny eyes that
blink on a 3.6 s cycle, rosy cheeks, a small body, a clean dark outline around every part, and eight animated poses:
idle (breathing), walk (leg and arm swing, a bob), knock (a fist at the door), talk (the mouth moves), cheer (both arms
up, a jump with squash and stretch), sad, wave and think. Same parts and palette as the pixel sprite, so every saved
avatar is the same person drawn properly; spiky hair tucks under a hat.

- **Street:** the rep walks and faces its direction, knocks, cheers on a signed job / level-up / trophy / quest, slumps on
  a lost door, waves when leaving a card or booking (`pose(name, ms)` in `roof-rep.js`); the rival walks.
- **Speech sheet:** the homeowner talks for 1.8 s then idles, frowning under 35 % trust; the HUD and tutorial faces are
  head-and-shoulders crops (`crop: 'bust'`); the locker preview is full body; crew board rows are still frames.
- **Game card (CRM Home):** `game-sprite.js` draws through the chibi when it is on the page; its 32×32 builder stays as
  the fallback and for `game-xp`'s pins.
- Bitmaps size to the CSS box × devicePixelRatio (crisp on phones); loops end when a canvas leaves the page; reduced
  motion draws one still frame. Guard: `tests/chibi-2026-10-25.test.js` (35).
- **The clay-render direction, for Jo:** a trial through the Canva connector produced a usable 3D clay chibi foreman
  (hard hat, hi-vis, hammer, waving) at https://www.canva.com/M/MAHY-9Hts18 (Canva media id `MAHY-9Hts18`), but the
  connector returns only a 200 px preview; a full-size export needs a Canva design + export from Jo's account, and the
  licence call is Jo's. If approved: strip EXIF, vendor under `docs/pro/img/roof-rep/`, use it on the tutorial and Train
  cards (the foreman) and keep the vector chibi for every customisable avatar.
