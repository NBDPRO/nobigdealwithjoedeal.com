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
- **Later the same day:** the door stands open and lit while the homeowner is in it; the rival wears a STORM BROS tag;
  moods follow the trust meter (frown under 35 %, a grin from 70 %); Storm Run puts a different homeowner on every
  objection (talking, then cheering a best answer or slumping at a trap); the HUD face waves every 16 s and the game card
  every 14 s; the pickup, the traffic in the drive game and the yard dog are vector too.
- **Game card (CRM Home):** `game-sprite.js` draws through the chibi when it is on the page; its 32×32 builder stays as
  the fallback and for `game-xp`'s pins.
- Bitmaps size to the CSS box × devicePixelRatio (crisp on phones); loops end when a canvas leaves the page; reduced
  motion draws one still frame. Guard: `tests/chibi-2026-10-25.test.js` (35).
- **The clay-render direction, for Jo:** a trial through the Canva connector produced a usable 3D clay chibi foreman
  (hard hat, hi-vis, hammer, waving) at https://www.canva.com/M/MAHY-9Hts18 (Canva media id `MAHY-9Hts18`), but the
  connector returns only a 200 px preview; a full-size export needs a Canva design + export from Jo's account, and the
  licence call is Jo's. If approved: strip EXIF, vendor under `docs/pro/img/roof-rep/`, use it on the tutorial and Train
  cards (the foreman) and keep the vector chibi for every customisable avatar.

### Wave 2 (same day, second PR): motion quality

- **Jointed limbs.** Arms are an upper arm + forearm (elbow), legs a thigh + shin (knee), drawn as two capsules whose
  outlines go down before either fill so the joint has no seam. The knock pumps the forearm, the wave swings beside the
  head, think rests the hand at the chin, the walk bends the forward elbow and the trailing knee.
- **Cross-fades.** Every pose change blends over 220 ms (`NBDChibi.tween` keeps the state; `mixPose` interpolates
  numbers and switches shapes half way). `animate` does it for every canvas loop; the street passes a tween key per
  character (`'rep'`, `'rival'`, `'door'`) to `chibi()`. Reduced motion snaps.
- **Secondary motion.** Ponytails swing from the root, long hair sways, the front hair follows; hats lift on a cheer
  jump; the walk squashes on each footfall; talking varies the mouth like speech (three overlapping sines, a glance away).
- **Emotes.** Sparkles orbit on a cheer, a sweat drop slides down the temple when sad, thought dots fill in when thinking.
- **Grounding.** A neck shadow on the chest, a brim shadow under hard hats and caps, an upper-lid shadow and a two-tone
  iris in the eyes.
- **Three new poses, wired:** `point` (the rep points up at the roof when a homeowner says go inspect), `nod` (the Storm
  Run homeowner nods at a fair answer instead of going idle), `shrug` (the doorway homeowner shrugs when a door is lost).
- **Sheets with nobody talking** show a scene in the face box instead of a blank: the wagging dog, the closed door
  with a hanger, the pickup (`faceScene`, the street's own vector pieces at 3-4x).
- **The door swings open** over 240 ms (eased leaf, the hall light fades in) and the homeowner steps up from 70 % as it
  opens; once per door, not per line.
- **Tap to cheer:** the HUD face, the locker preview and the CRM game-card avatar cheer for 1.6 s when tapped (one
  listener per canvas, same loop).
- Versions: `chibi.js?v=2`, `roof-rep.js?v=4`, `game-sprite.js?v=3`. Guard grows to 53 checks.

### Wave 3 (same day, third PR): the crews in the mini-games

- Two poses: `hammer` (a 520 ms wind-up and strike; the tool stays in hand through the swing) and `climb` (hands on
  the rungs, legs stepping).
- `sceneLoop(cv, paint)` keeps a mini-game canvas painting while it is on the page, on the same stop hook the chibi
  loops use. The build cross-section has Big Dave on the ground pointing out the next layer and a roofer on the deck
  hammering (both cheer when the ridge cap goes on); the nailing roofer swings on every tap; the rep stands at the
  ladder's foot sizing it up, then cheers at 4 ft or slumps at 2 / 7. The ladder label drops the last pixel font.
- Versions: `chibi.js?v=3`, `roof-rep.js?v=5`. Guard grows to 57 checks.

### Wave 4 (same day, fourth PR): more people

- Three hair styles (curly, afro, bun) and a **Top** option (tee, hoodie with hood / pouch / drawstrings, polo with
  collar and placket), in the renderer, the Roof Rep locker and the CRM game-card picker. The 32×32 pixel fallback
  draws the new hair as its nearest cousin. Every saved look still reads the same (`top` defaults to tee).
- Versions: `chibi.js?v=4`, `roof-rep.js?v=6`, `game-sprite.js?v=4`. Guard grows to 59 checks.

### Wave 5 (same day, fifth PR): life everywhere, and a renderer bug

- **Crew board:** the first eight rows breathe (idle, blinking); the leader cheers every 9 s and any row cheers when
  tapped. Past eight the thumbnails stay still frames (a big team is not thirty loops on one phone). A row's loop starts
  only once its row is on the page.
- **Training Yard:** Big Dave stands in the header card, points the way every 7 s, cheers when tapped.
- **The drive:** the drawn truck eases toward where the game says it is, tilts into a sideways move, idles with a
  faint bob, puffs exhaust on every lane change and a cloud of skid dust on a bump. Nothing spawns over the lot's
  column any more (the first move up used to be an instant fender bender when a car drifted into it), and no two cars
  spawn nose to tail.
- **Homeowners leave on their own terms (the LEAVE scene):** when the speech sheet lets a homeowner go they no longer
  vanish with the door. A signed homeowner steps out to the rep's side (450 ms), cheers with them (1.4 s) and walks
  back in; a lost door shrugs; a booked or carded door waves; then the door swings shut over its last 240 ms. One
  state (`LEAVE`), created where `say()` used to drop `DOOR`, drawn in `drawWorld` on the street canvas, and
  `drawHouse` keeps the leaf open for it.
- **Renderer bug (chibi.js v5):** `animate()` defined `stop` after its first frame, so a canvas animated before it
  was in the DOM hit "stop is not a function" on that frame and the loop died silently. Found by the crew board rows;
  fixed by defining `stop` first.
- **Hidden loops paint nothing (chibi.js v6):** a loop whose canvas has no box (its tab or panel is hidden) skips
  the paint and polls twice a second until it has one. Measured on the page: 5 loops live, 30 paints/s on the Street
  tab (the HUD face), 60 on Train (HUD + Big Dave), 59 on Crew (HUD + the row); before, every loop painted behind
  every tab.
- Versions: `chibi.js?v=6`, `roof-rep.js?v=7`, `roof-rep.css?v=5`. Guard grows to 67 checks.

### Waves 6 and 7 (same day, sixth PR): the course cards, and what homeowners carry

- **Training Yard course cards (wave 6):** each card shows the player's own avatar doing the course beside its
  text: climbing a drawn ladder (`paintCourseLadder` on `sceneLoop`), swinging a hammer, reading the rule book
  (clipboard, think), pointing out a roof part, measuring with the tape, explaining the job (talk). An earned badge
  cheers every 11 s; a tap cheers. Six loops, but hidden cards paint nothing (v6), so a tab costs one tab.
  `.course-card` lays the 64×84 canvas beside the text.
- **Persona props (wave 7, chibi.js v7):** a `prop` look field drawn in the back hand (the clipboard still wins
  it): phone, coffee mug, cane to the ground, key ring, swaddled baby, paintbrush, fan of papers. `makeLook` rolls one
  from `PERSONA_PROP` on about two doors in three: busy / realtor / flipper phones, night-shift / retired-cop /
  skeptic mugs, elder and caregiver canes, the landlord's keys, the new baby, the DIY brush, three-quotes /
  claim-denied / deductible papers. Props are homeowner-only; the avatar editor does not offer them.
- **Weather on the characters (wave 8, chibi.js v8):** a `prop: 'umbrella'` raises the back arm and holds an orange
  canopy over the head (the hand frame is squared back up so the canopy sits over the head whatever the arm angle);
  the street's `wxLook()` puts one in the rep's and the rival's hand on a rain or snow day. A draw option `wind`
  (0..1) gusts the hair, lifts the hat and leans the body; `chibi()` passes 1 on a windy day for every street
  character.
- **Idle fidgets (wave 9, chibi.js v9):** in the last 1.2 s of every 9 s an idle character fidgets, a different one
  each cycle: a weight shift onto one foot, hands on the hips with a head tilt, a stretch with a yawn (eyes shut,
  mouth open). Each eases in and out. A chibi's arms cannot reach its hat, so there is no hat tip.
- Versions: `chibi.js?v=9`, `roof-rep.js?v=10`, `roof-rep.css?v=6`. Guard grows to 75 checks.

### Wave 10 (same day, seventh PR): the leaderboard page

- `/pro/leaderboard` drew a gradient circle with the rep's initials. It now loads `chibi.js` and reads the rep's own
  `userSettings/{uid}.game.avatar` (the Home game card's look; owner-only read), and the rep's row shows that avatar
  as a bust-crop chibi that waves every 14 s like the game card. A rep without a game card, or a failed read, keeps
  the initials. `leaderboard.js?v=4`; the pin rides the chibi guard (76).
- **Wave 11, the dashboard's two leaderboards:** `team-names.js` (v2) also maps uid to the Roof Rep look from
  `roofRepScores` (`loadAvatars()` / `avatarFor()`: one company read behind the companyId claim, or the viewer's own
  doc for a solo owner; readable across the company by `firestore.rules`). The Dashboard view's Leaderboard
  (`dashboard-api.js` v9) shows each rep's chibi beside the medal, initials for a rep who has never opened Roof Rep;
  the Team Leaderboard widget (`widgets.js` v19) draws one beside the name and redraws itself once the read lands.
  Guard grows to 79.

### Waves 12 and 13 (same day, eighth PR): builds, and eyes that follow you

- **Wave 12, builds.** Every character had the same body. `chibi.js` (v10) knows four builds (`BUILDS`: regular ·
  slim · stocky · tall): the body group (legs, torso, arms, and what the hands hold) is scaled from the feet by the
  build's width and height, the head is scaled on its own, and the head sits on the scaled neck (`headRise`), so a
  tall rep reads as tall (longer body, smaller head) and a stocky one as stocky (wider body, same head). Props and
  tools are counter-scaled inside the hand so a mug stays a mug. An elder look stoops: a 4% shorter body, the head
  carried 2 units lower and 3 forward. The bust crop moves the feet by the same rise, so a leaderboard face stays
  centred whatever the build. Both pickers (the locker and the Home game card, `game-sprite.js` v5) grew a **Build**
  row; the street rolls a build per homeowner (most people regular; `PERSONA_BUILD` gives the retired cop, the farmer
  and the night-shift worker a stocky one, the veteran, the realtor and the CEO a tall one, the flipper and the
  attorney a slim one), and Big Dave is stocky. `roof-rep.js?v=12`.
- **Wave 13, gaze.** A draw option `gaze { x, y }` (-1..1, screen space) turns the irises toward a point (the iris has
  more room to climb than to drop, so looking down is gentler) and tilts the head three degrees after them; facing
  -1 mirrors it. `animate()` keeps one passive `pointermove` / `pointerdown` listener for the page and, for four
  seconds after the pointer (or a finger) last moved, eases every loop's gaze toward it and back out after, so the
  locker preview, the HUD face, the game card and every leaderboard face watch the cursor. A per-frame `gaze: false`
  opts a canvas out; a per-frame gaze of its own wins; reduced motion draws none. The street draws by hand and keeps
  its own glances. Guard grows to 88 (builds, head rise, every pose per build, the pickers and the street; the gaze
  geometry, the clamps, and a frozen-clock loop with the pointer to each side).
